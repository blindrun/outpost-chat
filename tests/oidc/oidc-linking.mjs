// The account-linking rules, which are the part of this feature where a
// mistake means account takeover rather than a broken login.
//
// Restarts the fake IdP between cases so it asserts different claims each
// time, and drives the real server against the real database.
import { spawn } from "node:child_process";
import { assertNotRateLimited } from "./preflight.mjs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// The fake provider lives beside this file.
const here = dirname(fileURLToPath(import.meta.url));

const APP = "http://127.0.0.1:8099";
const IDP_PORT = 39190;
const EXISTING_EMAIL = process.argv[2];
const EXISTING_USERNAME = process.argv[3];

// Unique per run. Provider subjects are permanent once linked, so reusing
// a fixed string made the second run of this suite assert against the
// account the first run had already linked -- which reads as a failure of
// the app rather than of the fixture.
const RUN = `${process.pid}-${Date.now().toString(36)}`;

const results = [];
const check = (name, ok, note = "") => results.push([name, ok, note]);

async function restartIdp(env) {
  await fetch(`http://127.0.0.1:${IDP_PORT}/__nope`).catch(() => {});
  spawn("pkill", ["-f", "fake-idp.mjs"]).unref();
  await new Promise((r) => setTimeout(r, 400));
  const child = spawn("node", ["fake-idp.mjs"], {
    cwd: here,
    env: { ...process.env, IDP_PORT: String(IDP_PORT), ...env },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://127.0.0.1:${IDP_PORT}/.well-known/openid-configuration`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error("fake IdP did not come up");
}

// Signs in and returns whatever the app ended up at: either a handoff code
// or the error it refused with.
async function attemptSignIn() {
  const start = assertNotRateLimited(
    await fetch(`${APP}/auth/oidc/start`, { redirect: "manual" }),
  );
  const idp = await fetch(start.headers.get("location"), { redirect: "manual" });
  const callback = await fetch(idp.headers.get("location"), { redirect: "manual" });
  const final = new URL(callback.headers.get("location"));
  return { code: final.searchParams.get("oidc"), error: final.searchParams.get("oidc_error") };
}

async function exchange(code) {
  const res = await fetch(`${APP}/auth/oidc/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  return res.json();
}

// --- Case 1: same email as an existing local account, NOT verified ---
// Must be refused: the provider is only repeating what somebody typed into
// it, and honouring it would hand over an account that already exists.
await restartIdp({
  IDP_SUBJECT: `attacker-${RUN}`,
  IDP_EMAIL: EXISTING_EMAIL,
  IDP_EMAIL_VERIFIED: "false",
  IDP_USERNAME: "attacker",
});
{
  const { code, error } = await attemptSignIn();
  check(
    "unverified email matching an existing account is refused",
    !code && /verified/i.test(error || ""),
    error || "it issued a code instead",
  );
}

// --- Case 2: same email, verified ---
// Must link to the existing account rather than creating a second one.
await restartIdp({
  IDP_SUBJECT: `legit-${RUN}`,
  IDP_EMAIL: EXISTING_EMAIL,
  IDP_EMAIL_VERIFIED: "true",
  IDP_USERNAME: "should-not-be-used",
});
{
  const { code, error } = await attemptSignIn();
  if (!code) {
    check("verified email links to the existing account", false, error || "no code issued");
  } else {
    const session = await exchange(code);
    check(
      "verified email links to the existing account",
      session.user?.username === EXISTING_USERNAME,
      `signed in as ${session.user?.username}, expected ${EXISTING_USERNAME}`,
    );
    check(
      "linking does not rename the existing account",
      session.user?.email === EXISTING_EMAIL,
      JSON.stringify(session.user),
    );
  }
}

// --- Case 3: the now-linked account, with the email changed at the IdP ---
// Identity is (issuer, subject), so the same subject must still land on the
// same account even though the email no longer matches anything local.
await restartIdp({
  IDP_SUBJECT: `legit-${RUN}`,
  IDP_EMAIL: "changed-address@example.test",
  IDP_EMAIL_VERIFIED: "true",
  IDP_USERNAME: "still-not-used",
});
{
  const { code, error } = await attemptSignIn();
  if (!code) {
    check("subject, not email, is the identity", false, error || "no code issued");
  } else {
    const session = await exchange(code);
    check(
      "subject, not email, is the identity",
      session.user?.username === EXISTING_USERNAME,
      `signed in as ${session.user?.username}`,
    );
  }
}

spawn("pkill", ["-f", "fake-idp.mjs"]).unref();

let failed = 0;
for (const [name, ok, note] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note && !ok ? `  — ${note}` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
