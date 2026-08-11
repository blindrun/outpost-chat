// Drives the whole sign-in the way a browser would: follow every redirect
// by hand so each hop can be asserted on, rather than letting fetch hide
// them. Nothing here is mocked on the Outpost side -- this is the real
// server, the real database and the real ID token verification.
import { requireServices, assertNotRateLimited } from "./preflight.mjs";

const APP = "http://127.0.0.1:8099";
const ISSUER = process.env.IDP_ISSUER || "http://127.0.0.1:39190";

// Must match whatever the fake IdP alongside this was started with; the
// defaults are that script's own defaults.
const EXPECT_EMAIL = process.env.IDP_EMAIL || "sso.person@example.com";
const EXPECT_USERNAME = process.env.IDP_USERNAME || "sso.person";

const results = [];
const check = (name, ok, note = "") => {
  results.push([name, ok, note]);
  return ok;
};

await requireServices(APP, ISSUER);

async function noRedirect(url, init = {}) {
  return fetch(url, { ...init, redirect: "manual" });
}

async function signIn() {
  // 1. Start: must 302 to the provider with PKCE + state + nonce.
  const start = assertNotRateLimited(await noRedirect(`${APP}/auth/oidc/start`));
  const authorizeUrl = start.headers.get("location");
  check("start redirects to the provider", start.status === 302 && !!authorizeUrl, `status ${start.status}`);
  const authorize = new URL(authorizeUrl);
  check("uses authorization code flow", authorize.searchParams.get("response_type") === "code");
  check("sends PKCE S256", authorize.searchParams.get("code_challenge_method") === "S256");
  check("sends a code_challenge", (authorize.searchParams.get("code_challenge") || "").length > 20);
  check("sends state", (authorize.searchParams.get("state") || "").length > 20);
  check("sends nonce", (authorize.searchParams.get("nonce") || "").length > 20);

  // 2. Provider bounces back to the callback.
  const idp = await noRedirect(authorizeUrl);
  const callbackUrl = idp.headers.get("location");
  check("provider redirects back to the callback", idp.status === 302 && !!callbackUrl);

  // 3. Callback: exchanges the code server-side, then hands the browser a
  //    one-time code -- and must NOT hand it a session token.
  const callback = await noRedirect(callbackUrl);
  const finalUrl = callback.headers.get("location");
  check("callback redirects to the app", callback.status === 302 && !!finalUrl, finalUrl || "");
  const final = new URL(finalUrl);
  const handoff = final.searchParams.get("oidc");
  check("no error on the way back", !final.searchParams.get("oidc_error"), final.searchParams.get("oidc_error") || "");
  check("hands back a single-use code", !!handoff && handoff.length > 20);
  check(
    "session token is never put in the URL",
    !finalUrl.includes("eyJ"),
    "a JWT in the redirect URL would land in browser history",
  );
  return { handoff, callbackUrl };
}

const { handoff, callbackUrl } = await signIn();

// 4. Exchange the handoff code for a real session.
const exchange = await fetch(`${APP}/auth/oidc/exchange`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code: handoff }),
});
const session = await exchange.json();
check("exchange returns a session", exchange.status === 200 && !!session.token, JSON.stringify(session).slice(0, 200));
check("account was created from the ID token claims", session.user?.email === EXPECT_EMAIL, JSON.stringify(session.user));
check("username derived from preferred_username", !!session.user?.username?.startsWith(EXPECT_USERNAME), session.user?.username);

// 5. The session must actually work.
const me = await fetch(`${APP}/auth/me`, { headers: { authorization: `Bearer ${session.token}` } });
const meBody = await me.json();
check("the issued token authenticates", me.status === 200 && meBody.id === session.user.id, JSON.stringify(meBody).slice(0, 160));

// 6. The handoff code is single use.
const replay = await fetch(`${APP}/auth/oidc/exchange`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code: handoff }),
});
check("handoff code cannot be replayed", replay.status === 400, `status ${replay.status}`);

// 7. The provider callback itself cannot be replayed (state is consumed).
const callbackReplay = await noRedirect(callbackUrl);
const replayTarget = new URL(callbackReplay.headers.get("location"));
check(
  "callback cannot be replayed",
  !!replayTarget.searchParams.get("oidc_error") && !replayTarget.searchParams.get("oidc"),
  replayTarget.searchParams.get("oidc_error") || "no error returned",
);

// 8. A forged callback with an unknown state is refused.
const forged = await noRedirect(`${APP}/auth/oidc/callback?code=whatever&state=made-up-state`);
const forgedTarget = new URL(forged.headers.get("location"));
check(
  "unknown state is refused",
  !!forgedTarget.searchParams.get("oidc_error") && !forgedTarget.searchParams.get("oidc"),
  forgedTarget.searchParams.get("oidc_error") || "no error returned",
);

// 9. Signing in again must reuse the same account, not make a second one.
const second = await signIn();
const secondExchange = await fetch(`${APP}/auth/oidc/exchange`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code: second.handoff }),
});
const secondSession = await secondExchange.json();
check(
  "second sign-in returns the same account",
  secondSession.user?.id === session.user?.id,
  `${session.user?.id} vs ${secondSession.user?.id}`,
);

// 10. That account has no password, so the password form must refuse it
//     rather than reporting a wrong password.
const passwordAttempt = await fetch(`${APP}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ login: session.user.email, password: "anything-at-all" }),
});
const passwordBody = await passwordAttempt.json();
check(
  "password login refused with an honest message",
  passwordAttempt.status === 401 && /single sign-on/i.test(passwordBody.error || ""),
  JSON.stringify(passwordBody),
);

let failed = 0;
for (const [name, ok, note] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note && !ok ? `  — ${note}` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
console.log(`created user: ${session.user?.username} <${session.user?.email}>`);
process.exit(failed ? 1 : 0);
