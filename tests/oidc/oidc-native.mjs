// The desktop hand-off: same flow, but the finished sign-in has to come
// back as an outpost:// URL for the OS to route, not as a redirect to a web
// origin the desktop app can't receive.
import { requireServices, assertNotRateLimited } from "./preflight.mjs";

const APP = "http://127.0.0.1:8099";
const ISSUER = process.env.IDP_ISSUER || "http://127.0.0.1:39190";
const results = [];
const check = (name, ok, note = "") => results.push([name, ok, note]);

await requireServices(APP, ISSUER);

async function run(targetQuery) {
  const start = assertNotRateLimited(
    await fetch(`${APP}/auth/oidc/start${targetQuery}`, { redirect: "manual" }),
  );
  const idp = await fetch(start.headers.get("location"), { redirect: "manual" });
  const callback = await fetch(idp.headers.get("location"), { redirect: "manual" });
  return callback;
}

// --- native ---
{
  const res = await run("?target=native");
  const body = res.status === 200 ? await res.text() : "";
  check("native callback returns a page, not a redirect", res.status === 200, `status ${res.status}`);
  check("page is HTML", (res.headers.get("content-type") || "").includes("text/html"));
  const match = body.match(/outpost:\/\/auth\?oidc=([A-Za-z0-9_-]+)/);
  check("hands the code to the outpost:// scheme", !!match, body.slice(0, 200));
  check("tells the user they can close the tab", /close this tab/i.test(body));
  check("offers a manual link if auto-launch is blocked", /<a class="btn"/.test(body));

  // The code from the native page must still be redeemable the same way.
  if (match) {
    const exchange = await fetch(`${APP}/auth/oidc/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: decodeURIComponent(match[1]) }),
    });
    const session = await exchange.json();
    check("the native code exchanges for a session", !!session.token, JSON.stringify(session).slice(0, 160));
  }
}

// --- a hostile target value must not become an open redirect ---
{
  const evil = encodeURIComponent("https://evil.example.com/steal");
  const res = await run(`?target=${evil}`);
  check(
    "an unrecognised target falls back to the web path",
    res.status === 302,
    `status ${res.status}`,
  );
  const location = res.headers.get("location") || "";
  check(
    "never redirects anywhere but this instance",
    location.startsWith(APP),
    location.slice(0, 120),
  );
}

// --- and the web path is unaffected by the new parameter ---
{
  const res = await run("");
  check("no target at all still redirects to the web client", res.status === 302);
  check("still carries a code", (res.headers.get("location") || "").includes("?oidc="));
}

let failed = 0;
for (const [name, ok, note] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note && !ok ? `  — ${note}` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
