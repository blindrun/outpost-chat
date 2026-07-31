// Optional per-instance bot protection on registration, via Cloudflare
// Turnstile — self-hosters who never set TURNSTILE_SECRET_KEY get no
// verification at all (register works exactly as before), matching the
// same opt-in pattern as GIPHY_API_KEY. Applied only to real public
// registration, not the very first (owner-bootstrap) account — see
// POST /auth/register.
export async function verifyTurnstileToken(token: string | undefined, remoteIp: string | undefined): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (!token) return false;

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);

  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = (await res.json()) as { success: boolean };
    return data.success === true;
  } catch {
    // A Cloudflare-side outage shouldn't lock everyone out of registering
    // — fail open, same tradeoff self-hosting without Turnstile already
    // accepts.
    return true;
  }
}
