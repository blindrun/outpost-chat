// Both dependencies these suites need, checked up front. Without this the
// first failure is a bare `TypeError: fetch failed` from deep inside undici,
// which reads like a broken test rather than "you didn't start the server".
export async function requireServices(app, issuer) {
  const checks = [
    [`${app}/auth/oidc/config`, `the Outpost server on ${app}`, "see tests/README.md for the env it needs"],
    [
      `${issuer}/.well-known/openid-configuration`,
      `the fake identity provider on ${issuer}`,
      "start it with: node tests/oidc/fake-idp.mjs &",
    ],
  ];

  for (const [url, what, hint] of checks) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`responded ${res.status}`);
    } catch (err) {
      console.error(`Can't reach ${what} — ${err.message}\n  ${hint}`);
      process.exit(2);
    }
  }

  // A configured server that reports SSO disabled means the OIDC_* variables
  // never reached it, which otherwise shows up as every sign-in redirecting
  // to an error page for no visible reason.
  const config = await fetch(`${app}/auth/oidc/config`).then((r) => r.json());
  if (!config.enabled) {
    console.error("The server is running but has no OIDC configuration — see tests/README.md.");
    process.exit(2);
  }
}

// /auth/oidc/start is rate limited to 20 requests per 10 minutes, and each
// of these suites spends several. Running them back to back exhausts it,
// and a 429 has no Location header — which surfaced as an unreadable
// "Failed to parse URL from null" from inside fetch. This is the limiter
// working correctly, so the suite says so and stops rather than reporting
// a pile of failures that look like the feature is broken.
export function assertNotRateLimited(res) {
  if (res.status !== 429) return res;
  console.error(
    "Rate limited by /auth/oidc/start (20 per 10 minutes).\n" +
      "  Wait for the window to pass, or restart the server to reset the counter.",
  );
  process.exit(2);
}
