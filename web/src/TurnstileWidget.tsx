import { useEffect, useRef } from "react";

// Rendered as an iframe pointed at this instance's own /turnstile.html
// (served by the backend, same origin as the sitekey's Cloudflare-configured
// allowed domain) rather than injecting Cloudflare's script directly into
// this page. Turnstile sitekeys are domain-locked, and this component can
// run from origins that never match that allowlist — notably the desktop
// app's `file://` origin — where a directly-embedded widget silently fails
// (or produces a token that fails server-side verification). The iframe
// approach keeps the challenge running same-origin with the real backend
// regardless of what's hosting this component, and the token comes back via
// postMessage.
export function TurnstileWidget({
  baseUrl,
  onVerify,
}: {
  baseUrl: string;
  onVerify: (token: string) => void;
}) {
  const onVerifyRef = useRef(onVerify);
  onVerifyRef.current = onVerify;

  const frameOrigin = new URL(baseUrl).origin;

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== frameOrigin) return;
      if (event.data?.type !== "outpost-turnstile-token") return;
      onVerifyRef.current(event.data.token);
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [frameOrigin]);

  return (
    <iframe
      className="turnstile-widget"
      src={`${baseUrl}/turnstile.html`}
      title="Captcha"
      style={{ border: 0, width: 300, height: 65 }}
    />
  );
}
