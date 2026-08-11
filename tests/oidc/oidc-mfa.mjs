// Signing in through an identity provider must NOT skip a second factor the
// user configured inside Outpost. Sets TOTP up on a fresh SSO account, then
// signs in again and checks the exchange hands back a challenge instead of
// a session -- and that the session only appears after a real TOTP code.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { requireServices, assertNotRateLimited } from "./preflight.mjs";

// Resolved from this file rather than hardcoded, so the suite runs from any
// checkout and any working directory.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Dynamic import: a static one needs a literal specifier, and this path is
// only known at runtime.
const { generate } = await import(pathToFileURL(join(repoRoot, "node_modules/otplib/dist/index.js")).href);

// Same library the server verifies with, so a passing code here is a code a
// real authenticator app would have produced.
const totp = async (secret) => await generate({ secret });

const APP = "http://127.0.0.1:8099";
const ISSUER = process.env.IDP_ISSUER || "http://127.0.0.1:39190";
const results = [];
const check = (name, ok, note = "") => results.push([name, ok, note]);

await requireServices(APP, ISSUER);

async function signInGetCode() {
  const start = assertNotRateLimited(
    await fetch(`${APP}/auth/oidc/start`, { redirect: "manual" }),
  );
  const idp = await fetch(start.headers.get("location"), { redirect: "manual" });
  const callback = await fetch(idp.headers.get("location"), { redirect: "manual" });
  const final = new URL(callback.headers.get("location"));
  if (final.searchParams.get("oidc_error")) throw new Error(final.searchParams.get("oidc_error"));
  return final.searchParams.get("oidc");
}

async function exchange(code) {
  const res = await fetch(`${APP}/auth/oidc/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  return res.json();
}

// 1. Plain SSO sign-in, no second factor yet.
const first = await exchange(await signInGetCode());
check("signs in without MFA to begin with", !!first.token, JSON.stringify(first).slice(0, 160));
const token = first.token;

// 2. Turn on TOTP for this SSO account.
const setup = await fetch(`${APP}/mfa/totp/setup`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: "{}",
}).then((r) => r.json());
check("an SSO account can set up TOTP", !!setup.secret, JSON.stringify(setup).slice(0, 160));

const confirm = await fetch(`${APP}/mfa/totp/confirm`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ code: await totp(setup.secret) }),
});
check("TOTP confirms", confirm.status === 200, `status ${confirm.status}`);

// 3. Sign in through the provider again -- must now be challenged.
const challenged = await exchange(await signInGetCode());
check(
  "provider sign-in is challenged for the second factor",
  challenged.mfaRequired === true && !challenged.token,
  JSON.stringify(challenged).slice(0, 200),
);
check("no session token is leaked alongside the challenge", !challenged.token);

// 4. A wrong code must not get in.
const wrong = await fetch(`${APP}/auth/mfa/verify-code`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ mfaToken: challenged.mfaToken, code: "000000" }),
});
check("a wrong TOTP code is rejected", wrong.status >= 400, `status ${wrong.status}`);

// 5. The right one does.
const verified = await fetch(`${APP}/auth/mfa/verify-code`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ mfaToken: challenged.mfaToken, code: await totp(setup.secret) }),
}).then((r) => r.json());
check("the right TOTP code completes the sign-in", !!verified.token, JSON.stringify(verified).slice(0, 160));

// 6. And an SSO account can still turn it off, despite having no password
//    to re-prove with (see reprovedIdentity in routes/mfa.ts).
const disable = await fetch(`${APP}/mfa/totp/disable`, {
  method: "POST",
  headers: { authorization: `Bearer ${verified.token}`, "content-type": "application/json" },
  body: JSON.stringify({ password: "" }),
});
check("an SSO account isn't locked out of disabling TOTP", disable.status === 204, `status ${disable.status}`);

let failed = 0;
for (const [name, ok, note] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note && !ok ? `  — ${note}` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
