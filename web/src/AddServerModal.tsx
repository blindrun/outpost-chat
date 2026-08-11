import { useEffect, useRef, useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import type { Instance, Session } from "./App";
import {
  InstanceInfo,
  MfaChallenge,
  Theme,
  forgotPassword,
  getInstanceInfo,
  getOidcConfig,
  login,
  mfaVerifyCode,
  mfaWebauthnLoginOptions,
  mfaWebauthnLoginVerify,
  oidcExchange,
  oidcStartUrl,
  register,
  resetPassword,
  updateInstanceSettings,
} from "./api";
import { desktopBridge } from "./desktop";
import { ThemePicker } from "./ThemePicker";
import { TurnstileWidget } from "./TurnstileWidget";

type Step =
  | "address"
  | "connecting"
  | "auth"
  | "mfa"
  | "theme"
  | "intro"
  | "memberIntro"
  | "forgotPassword"
  | "resetPassword";

// A short admin-only walkthrough shown once, right after the very first
// owner finishes setup — points at real, already-built Instance Settings
// tabs rather than teasing anything that doesn't exist yet.
const INTRO_CARDS: { title: string; body: string }[] = [
  {
    title: "You're the owner",
    body: "Everything here lives under the gear icon (⚙) next to your instance name — Instance Settings. This is a quick tour of what's there; skip it anytime and come back later.",
  },
  {
    title: "Invites & Roles",
    body: "Invites tab: generate shareable join links, optionally require a code to register at all. Roles tab: create roles with specific permissions (manage channels, manage roles, send messages) and assign them from the member list sidebar.",
  },
  {
    title: "Your built-in bot",
    body: "Bot tab: give it a name and avatar, then turn on only what you want — welcome messages for new members, an auto-assigned role, custom \"!\" text commands, reaction roles, a leveling/XP system with !rank and !leaderboard, and a banned-word auto-moderation filter.",
  },
  {
    title: "Webhooks, and that's it",
    body: "Webhooks tab: let an external tool (CI, a script, anything that can POST) post messages into a channel without a real account. That covers everything — Instance Settings is always one click away via the gear icon.",
  },
];

// Shown once, right after a brand-new member's first registration on an
// already-claimed instance — the owner's INTRO_CARDS above cover admin
// surfaces this person has no reason to see. Points at things that are
// easy to genuinely miss on first use rather than self-evident ones like
// "type in the box to send a message."
const MEMBER_INTRO_CARDS: { title: string; body: string }[] = [
  {
    title: "Welcome!",
    body: "A quick tour of a few things that aren't obvious at a glance. Skip anytime — nothing here is required reading.",
  },
  {
    title: "Voice channels",
    body: "Push-to-talk is on by default — hold the bind key to talk. Prefer it to just stay open while you're speaking? Switch to voice-activity mode, and pick your mic/speaker, in User Settings → Voice.",
  },
  {
    title: "Messages",
    body: "Type @ to mention someone, or :name: for a custom emoji if this server has any. Hover a message (or tap it on mobile) to reply, edit, delete, or start a thread from it.",
  },
  {
    title: "Friends & DMs",
    body: "The Friends button lives in the user bar at the bottom-left, next to your avatar — add friends by username and message them directly, outside of any server channel.",
  },
];

// A bare address (no scheme) needs a guess. HTTPS is the right default —
// any real self-hosted instance behind a reverse proxy needs it (voice
// requires a secure context), and a page loaded over HTTPS can't even
// attempt a plain http:// fetch at all (mixed content is blocked outright,
// not just redirected) — so guessing http first would break the common
// case with a confusing "couldn't reach that address" instead of a fast,
// automatic fallback. If an explicit scheme is given, that's respected
// exactly as typed.
function candidateBaseUrls(input: string): string[] {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (/^https?:\/\//.test(trimmed)) return [trimmed];
  return [`https://${trimmed}`, `http://${trimmed}`];
}

// Single sign-on leaves this page entirely, so it can only finish somewhere
// that can receive the result back.
//
// In a browser that means the instance's own origin, because that's where
// the provider returns to -- which rules out adding instance B from a web
// client served by instance A, and rules out the mobile shells, whose
// origin is capacitor:// or a localhost of their own.
//
// The desktop app is the exception: it can't receive a redirect at all
// (it's loaded from file://), but it registers the outpost:// scheme, so
// the OS hands the result back to it after the sign-in happens in the
// user's real browser.
function ssoCanCompleteHere(baseUrl: string): boolean {
  if (desktopBridge()) return true;
  try {
    return window.location.origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

export function AddServerModal({
  initialBaseUrl,
  initialInviteCode,
  initialResetToken,
  initialOidcCode,
  initialOidcError,
  onConnected,
}: {
  embedded?: boolean;
  initialBaseUrl?: string;
  initialInviteCode?: string;
  initialResetToken?: string;
  initialOidcCode?: string;
  initialOidcError?: string;
  onConnected: (instance: Instance, session: Session) => void;
}) {
  const [step, setStep] = useState<Step>(
    initialBaseUrl && (initialInviteCode || initialResetToken || initialOidcCode || initialOidcError)
      ? "connecting"
      : "address",
  );
  const [resetToken] = useState(initialResetToken);
  const [resetPasswordValue, setResetPasswordValue] = useState("");
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetSubmitting, setResetSubmitting] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotError, setForgotError] = useState<string | null>(null);
  const [forgotSubmitting, setForgotSubmitting] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [address, setAddress] = useState(initialBaseUrl ?? "");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [info, setInfo] = useState<InstanceInfo | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  // Null until the instance has been probed and asked. A server older than
  // SSO support answers with a 404, which reads the same as "not enabled".
  const [oidc, setOidc] = useState<{ enabled: boolean; displayName?: string } | null>(null);
  // Desktop only: the sign-in is happening in the user's browser, and this
  // window is waiting for the OS to hand the result back. Worth showing,
  // because otherwise clicking the button appears to do nothing at all.
  const [ssoWaiting, setSsoWaiting] = useState(false);

  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState(initialInviteCode ?? "");
  const [claimCode, setClaimCode] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  // A fresh (no-owner) instance shows a "Claim This Server" banner first —
  // the actual account-creation form only appears once that's clicked, so
  // nobody stumbles into becoming the owner without realizing a claim code
  // was needed.
  const [claiming, setClaiming] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authing, setAuthing] = useState(false);

  const [pendingSession, setPendingSession] = useState<Session | null>(null);
  const [pendingInstance, setPendingInstance] = useState<Instance | null>(null);
  const [theme, setTheme] = useState<Theme>("business");
  const [introIndex, setIntroIndex] = useState(0);
  const [memberIntroIndex, setMemberIntroIndex] = useState(0);

  // Second-factor step, entered when POST /auth/login comes back with
  // mfaRequired instead of a session. mfaChallenge holds the short-lived
  // mfaToken (and its re-signed successor once a WebAuthn challenge is
  // fetched) plus which methods the account has configured.
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallenge | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaBusy, setMfaBusy] = useState(false);

  async function probeAddress(rawAddress: string) {
    setProbeError(null);
    setProbing(true);
    let lastErr: unknown;
    for (const candidate of candidateBaseUrls(rawAddress)) {
      try {
        const instanceInfo = await getInstanceInfo(candidate);
        setBaseUrl(candidate);
        setInfo(instanceInfo);
        // Never allowed to fail the connection: an instance without SSO
        // configured, or one running a build that predates it, should still
        // reach the normal login form.
        const oidcInfo = await getOidcConfig(candidate).catch(() => ({ enabled: false }));
        setOidc(oidcInfo);
        if (resetToken) {
          setStep("resetPassword");
          setProbing(false);
          return;
        }
        // Returning from the identity provider. The code is single-use and
        // already in hand, so this goes straight to a session rather than
        // showing a login form the user has just finished with.
        if (initialOidcCode) {
          setProbing(false);
          await redeemOidcCode(candidate, initialOidcCode, instanceInfo);
          return;
        }
        if (initialOidcError) {
          setAuthError(initialOidcError);
          setAuthMode("login");
          setStep("auth");
          setProbing(false);
          return;
        }
        // An invite link always means "join via invite" — even though a
        // pre-existing instance normally defaults to the Log In tab.
        setAuthMode(instanceInfo.hasOwner && !initialInviteCode ? "login" : "register");
        setStep("auth");
        setProbing(false);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    // Fall back to the manual address form so there's always a way
    // forward, even if the auto-connect (invite link) attempt failed.
    setStep("address");
    setProbeError("Couldn't reach that address — check it's correct and the instance is running.");
    console.error(lastErr);
    setProbing(false);
  }

  // Deliberately takes the address rather than reading `baseUrl` state:
  // this runs inside the same tick that probeAddress called setBaseUrl, so
  // the state value is still the previous render's. The same reasoning is
  // why it builds the Instance itself instead of going through finishLogin,
  // which reads `info` — also not updated yet at this point.
  async function redeemOidcCode(candidateBaseUrl: string, code: string, instanceInfo: InstanceInfo) {
    setAuthError(null);
    setAuthing(true);
    try {
      const result = await oidcExchange(candidateBaseUrl, code);
      if ("mfaRequired" in result) {
        setMfaChallenge(result);
        setMfaError(null);
        setMfaCode("");
        setStep("mfa");
        return;
      }
      onConnected(
        {
          id: crypto.randomUUID(),
          label: label.trim() || instanceInfo.name || address,
          baseUrl: candidateBaseUrl,
        },
        result,
      );
    } catch (err) {
      setAuthError((err as Error).message);
      setAuthMode("login");
      setStep("auth");
    } finally {
      setAuthing(false);
    }
  }

  // Desktop only. The browser half of the sign-in finishes out of process
  // and the OS delivers the result through the outpost:// handler, which
  // can land at any moment — including before this component mounted, which
  // is why the bridge replays a buffered result on subscribe.
  //
  // Deliberately keyed on baseUrl rather than mounted once: the code is
  // only redeemable against the instance that issued it, and re-subscribing
  // when the target instance changes is what keeps those in step.
  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge || !baseUrl || !info) return;
    return bridge.onSsoResult(({ code, error }) => {
      setSsoWaiting(false);
      if (error) {
        setAuthError(error);
        return;
      }
      if (code) void redeemOidcCode(baseUrl, code, info);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, info]);

  function handleProbe(e: React.FormEvent) {
    e.preventDefault();
    probeAddress(address);
  }

  // Invite links (`?invite=CODE`) and password-reset links (`?reset=TOKEN`)
  // both arrive with the address already known (the link's own origin) —
  // skip the manual "Connect" click and go straight to the auth/reset step
  // so the recipient doesn't have to figure out where to type anything.
  const autoProbedRef = useRef(false);
  useEffect(() => {
    if (autoProbedRef.current) return;
    if (initialBaseUrl && (initialInviteCode || resetToken || initialOidcCode || initialOidcError)) {
      autoProbedRef.current = true;
      probeAddress(initialBaseUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Shared by both a direct login/register success and the MFA challenge's
  // eventual success — same "first user on a fresh instance gets a theme
  // step" branch either way (though in practice MFA can only be configured
  // by an existing user, so info.hasOwner is always already true by the
  // time this runs from the MFA path).
  function finishLogin(result: Session) {
    const instance: Instance = { id: crypto.randomUUID(), label: label.trim() || info?.name || address, baseUrl };
    if (!info?.hasOwner) {
      setPendingSession(result);
      setPendingInstance(instance);
      setStep("theme");
      return;
    }
    // A brand-new member registering on an already-claimed instance —
    // distinct from the owner-claim path above, and (unlike that one)
    // never reachable from the MFA path, since a fresh registration can't
    // already have 2FA configured. Every subsequent login skips straight
    // to onConnected below, same as always.
    if (authMode === "register") {
      setPendingSession(result);
      setPendingInstance(instance);
      setMemberIntroIndex(0);
      setStep("memberIntro");
      return;
    }
    onConnected(instance, result);
  }

  async function handleAuth(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    setAuthing(true);
    try {
      const result =
        authMode === "login"
          ? await login(baseUrl, email, password)
          : await register(
              baseUrl,
              username,
              email,
              password,
              inviteCode || undefined,
              !info?.hasOwner ? claimCode || undefined : undefined,
              turnstileToken || undefined,
            );

      if ("mfaRequired" in result) {
        setMfaChallenge(result);
        setMfaError(null);
        setMfaCode("");
        setStep("mfa");
        return;
      }

      finishLogin(result);
    } catch (err) {
      setAuthError((err as Error).message);
    } finally {
      setAuthing(false);
    }
  }

  async function handleForgotPasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setForgotError(null);
    setForgotSubmitting(true);
    try {
      await forgotPassword(baseUrl, forgotEmail);
      setForgotSent(true);
    } catch (err) {
      setForgotError((err as Error).message);
    } finally {
      setForgotSubmitting(false);
    }
  }

  async function handleResetPasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!resetToken) return;
    setResetError(null);
    setResetSubmitting(true);
    try {
      await resetPassword(baseUrl, resetToken, resetPasswordValue);
      setResetDone(true);
    } catch (err) {
      setResetError((err as Error).message);
    } finally {
      setResetSubmitting(false);
    }
  }

  async function handleMfaCodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!mfaChallenge) return;
    setMfaError(null);
    setMfaBusy(true);
    try {
      const result = await mfaVerifyCode(baseUrl, mfaChallenge.mfaToken, mfaCode.trim());
      finishLogin(result);
    } catch (err) {
      setMfaError((err as Error).message);
    } finally {
      setMfaBusy(false);
    }
  }

  async function handleMfaWebauthn() {
    if (!mfaChallenge) return;
    setMfaError(null);
    setMfaBusy(true);
    try {
      const { options, mfaToken } = await mfaWebauthnLoginOptions(baseUrl, mfaChallenge.mfaToken);
      const response = await startAuthentication({ optionsJSON: options });
      const result = await mfaWebauthnLoginVerify(baseUrl, mfaToken, response);
      finishLogin(result);
    } catch (err) {
      setMfaError((err as Error).message);
    } finally {
      setMfaBusy(false);
    }
  }

  async function handleThemeConfirm() {
    if (!pendingSession || !pendingInstance) return;
    try {
      await updateInstanceSettings(pendingInstance.baseUrl, pendingSession.token, { theme });
    } catch (err) {
      console.error(err);
    }
    setIntroIndex(0);
    setStep("intro");
  }

  function finishIntro() {
    if (!pendingSession || !pendingInstance) return;
    onConnected(pendingInstance, pendingSession);
  }

  function finishMemberIntro() {
    if (!pendingSession || !pendingInstance) return;
    onConnected(pendingInstance, pendingSession);
  }

  if (step === "connecting") {
    return (
      <div className="add-server-form">
        <h2>Joining…</h2>
        <p className="subtitle">Connecting to your invite.</p>
      </div>
    );
  }

  if (step === "address") {
    return (
      <form onSubmit={handleProbe} className="add-server-form">
        <h2>Add a Server</h2>
        <p className="subtitle">Connect to a self-hosted Outpost instance by address.</p>
        <label>
          Server Address
          <input
            placeholder="e.g. outpost.example.com or 192.168.1.50:8080"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            autoFocus
          />
        </label>
        <label>
          Label (optional)
          <input placeholder="e.g. Alex's place" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        {probeError && <p className="error">{probeError}</p>}
        <div className="modal-actions">
          <button type="submit" className="btn" disabled={!address.trim() || probing}>
            {probing ? "Connecting…" : "Connect"}
          </button>
        </div>
      </form>
    );
  }

  if (step === "auth") {
    if (!info?.hasOwner && !claiming) {
      return (
        <div className="add-server-form">
          <h2>{info?.name}</h2>
          {info?.description && <p className="subtitle">{info.description}</p>}
          <div className="claim-banner">
            <p>
              <strong>This server hasn't been claimed yet.</strong>
            </p>
            <p className="subtitle">
              The admin who installed it can find a claim code printed in the server's console output.
            </p>
            <button type="button" className="btn" onClick={() => setClaiming(true)}>
              Claim This Server
            </button>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn secondary" onClick={() => setStep("address")}>
              Back
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="add-server-form">
        <h2>{info?.name}</h2>
        {info?.description && <p className="subtitle">{info.description}</p>}
        {!info?.hasOwner ? (
          <p className="subtitle">Enter the claim code from the server console to set up this instance and become its owner.</p>
        ) : (
          <div className="modal-tabs">
            <button className={authMode === "login" ? "active" : ""} onClick={() => setAuthMode("login")}>
              Log In
            </button>
            <button className={authMode === "register" ? "active" : ""} onClick={() => setAuthMode("register")}>
              Register
            </button>
          </div>
        )}
        {/* Only on an instance that already has an owner: the very first
            account is deliberately not creatable through an identity
            provider (see resolveUser in routes/oidc.ts), so offering the
            button during the claim step would only lead to a refusal.
            A full-page link, not a fetch — the provider renders its own
            login page and won't be framed. */}
        {oidc?.enabled &&
          info?.hasOwner &&
          (ssoCanCompleteHere(baseUrl) ? (
            <div className="sso-block">
              {/* In the desktop app this opens the user's own browser
                  rather than navigating this window — they're most likely
                  already signed in to their provider there, and an
                  embedded window would neither carry that session nor
                  reach their password manager. The result comes back
                  through the outpost:// handler. */}
              {desktopBridge() ? (
                <button
                  type="button"
                  className="btn sso-btn"
                  onClick={() => {
                    setAuthError(null);
                    setSsoWaiting(true);
                    desktopBridge()?.openExternal(`${oidcStartUrl(baseUrl)}?target=native`);
                  }}
                >
                  {ssoWaiting ? `Waiting for ${oidc.displayName}…` : `Continue with ${oidc.displayName}`}
                </button>
              ) : (
                <a className="btn sso-btn" href={oidcStartUrl(baseUrl)}>
                  Continue with {oidc.displayName}
                </a>
              )}
              {ssoWaiting && (
                <p className="settings-hint">
                  Finish signing in with {oidc.displayName} in your browser — this window will pick it up
                  automatically.
                </p>
              )}
              <div className="sso-divider">
                <span>or</span>
              </div>
            </div>
          ) : (
            <p className="settings-hint">
              This server supports signing in with {oidc.displayName}, but that has to be done in a browser at
              its own address — open {baseUrl} to use it.
            </p>
          ))}
        <form onSubmit={handleAuth}>
          {!info?.hasOwner && (
            <label>
              Claim Code
              <input
                value={claimCode}
                onChange={(e) => setClaimCode(e.target.value)}
                placeholder="e.g. K3F9-7QXZ-M2PL"
                autoFocus
              />
            </label>
          )}
          {(authMode === "register" || !info?.hasOwner) && (
            <label>
              Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
          )}
          <label>
            {authMode === "login" ? "Username or Email" : "Email"}
            {authMode === "login" ? (
              // Deliberately type="text", not type="email" — the backend
              // now accepts either a username or an email for login (see
              // POST /auth/login), but an email-typed input's built-in HTML5
              // validation would silently block submitting a bare username
              // before this handler even runs.
              <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
            ) : (
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            )}
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {authMode === "login" && info?.passwordResetEnabled && (
            <button
              type="button"
              className="link"
              onClick={() => {
                setForgotEmail(email.includes("@") ? email : "");
                setForgotError(null);
                setForgotSent(false);
                setStep("forgotPassword");
              }}
            >
              Forgot password?
            </button>
          )}
          {(authMode === "register" || !info?.hasOwner) && info?.requireInviteToRegister && (
            <label>
              Invite Code
              <input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} />
            </label>
          )}
          {/* Only real public registration needs this — the very first
              (owner-bootstrap) account is exempt server-side too, since a
              bot can't reach a claim code printed on the self-hoster's own
              console. */}
          {authMode === "register" && info?.hasOwner && info.turnstileSiteKey && (
            <TurnstileWidget baseUrl={baseUrl} onVerify={setTurnstileToken} />
          )}
          {authError && <p className="error">{authError}</p>}
          <div className="modal-actions">
            <button
              type="button"
              className="btn secondary"
              onClick={() => (!info?.hasOwner ? setClaiming(false) : setStep("address"))}
            >
              Back
            </button>
            <button
              type="submit"
              className="btn"
              disabled={authing || (authMode === "register" && !!info?.turnstileSiteKey && !turnstileToken)}
            >
              {authing ? "…" : info?.hasOwner ? (authMode === "login" ? "Log In" : "Register") : "Claim Server"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  if (step === "forgotPassword") {
    return (
      <div className="add-server-form">
        <h2>Reset Password</h2>
        {forgotSent ? (
          <>
            <p className="subtitle">
              If an account matches that email, a reset link is on its way — it expires in 1 hour.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setStep("auth")}>
                Back to Log In
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={handleForgotPasswordSubmit}>
            <p className="subtitle">Enter your account's email and we'll send you a reset link.</p>
            <label>
              Email
              <input
                type="email"
                value={forgotEmail}
                onChange={(e) => setForgotEmail(e.target.value)}
                autoFocus
              />
            </label>
            {forgotError && <p className="error">{forgotError}</p>}
            <div className="modal-actions">
              <button type="button" className="btn secondary" onClick={() => setStep("auth")}>
                Back
              </button>
              <button type="submit" className="btn" disabled={forgotSubmitting || !forgotEmail.trim()}>
                {forgotSubmitting ? "…" : "Send Reset Link"}
              </button>
            </div>
          </form>
        )}
      </div>
    );
  }

  if (step === "resetPassword") {
    return (
      <div className="add-server-form">
        <h2>{info?.name ?? "Reset Password"}</h2>
        {resetDone ? (
          <>
            <p className="subtitle">Your password has been reset — log in with your new password.</p>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setStep("auth")}>
                Back to Log In
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={handleResetPasswordSubmit}>
            <p className="subtitle">Choose a new password for your account.</p>
            <label>
              New Password
              <input
                type="password"
                value={resetPasswordValue}
                onChange={(e) => setResetPasswordValue(e.target.value)}
                autoFocus
              />
            </label>
            {resetError && <p className="error">{resetError}</p>}
            <div className="modal-actions">
              <button type="submit" className="btn" disabled={resetSubmitting || resetPasswordValue.length < 8}>
                {resetSubmitting ? "…" : "Reset Password"}
              </button>
            </div>
          </form>
        )}
      </div>
    );
  }

  if (step === "mfa" && mfaChallenge) {
    return (
      <div className="add-server-form">
        <h2>Two-Factor Verification</h2>
        <p className="subtitle">
          {mfaChallenge.totpEnabled
            ? "Enter the 6-digit code from your authenticator app, or one of your backup codes."
            : "Use one of your registered security keys to finish logging in."}
        </p>
        {mfaChallenge.totpEnabled && (
          <form onSubmit={handleMfaCodeSubmit}>
            <label>
              Code
              <input
                autoFocus
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                placeholder="123456 or XXXXX-XXXXX"
              />
            </label>
            {mfaError && <p className="error">{mfaError}</p>}
            <div className="modal-actions">
              <button type="button" className="btn secondary" onClick={() => setStep("auth")}>
                Back
              </button>
              <button type="submit" className="btn" disabled={mfaBusy || !mfaCode.trim()}>
                {mfaBusy ? "…" : "Verify"}
              </button>
            </div>
          </form>
        )}
        {mfaChallenge.webauthnCredentials.length > 0 && (
          <>
            {!mfaChallenge.totpEnabled && mfaError && <p className="error">{mfaError}</p>}
            <div className="modal-actions">
              {!mfaChallenge.totpEnabled && (
                <button type="button" className="btn secondary" onClick={() => setStep("auth")}>
                  Back
                </button>
              )}
              <button type="button" className="btn secondary" disabled={mfaBusy} onClick={handleMfaWebauthn}>
                {mfaBusy ? "…" : "Use a Security Key"}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  if (step === "theme") {
    return (
      <div className="add-server-form">
        <h2>Choose a Theme</h2>
        <p className="subtitle">You can change this later in Instance Settings.</p>
        <ThemePicker value={theme} onChange={setTheme} />
        <div className="modal-actions">
          <button className="btn" onClick={handleThemeConfirm}>
            Continue
          </button>
        </div>
      </div>
    );
  }

  if (step === "memberIntro") {
    const isLastCard = memberIntroIndex === MEMBER_INTRO_CARDS.length - 1;
    const card = MEMBER_INTRO_CARDS[memberIntroIndex];
    return (
      <div className="add-server-form">
        <h2>{card.title}</h2>
        <p className="subtitle">{card.body}</p>
        <div className="intro-dots">
          {MEMBER_INTRO_CARDS.map((_, i) => (
            <span key={i} className={i === memberIntroIndex ? "active" : ""} />
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn secondary" onClick={finishMemberIntro}>
            Skip
          </button>
          {memberIntroIndex > 0 && (
            <button type="button" className="btn secondary" onClick={() => setMemberIntroIndex((i) => i - 1)}>
              Back
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => (isLastCard ? finishMemberIntro() : setMemberIntroIndex((i) => i + 1))}
          >
            {isLastCard ? "Get Started" : "Next"}
          </button>
        </div>
      </div>
    );
  }

  const isLastIntroCard = introIndex === INTRO_CARDS.length - 1;
  const card = INTRO_CARDS[introIndex];
  return (
    <div className="add-server-form">
      <h2>{card.title}</h2>
      <p className="subtitle">{card.body}</p>
      <div className="intro-dots">
        {INTRO_CARDS.map((_, i) => (
          <span key={i} className={i === introIndex ? "active" : ""} />
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn secondary" onClick={finishIntro}>
          Skip
        </button>
        {introIndex > 0 && (
          <button type="button" className="btn secondary" onClick={() => setIntroIndex((i) => i - 1)}>
            Back
          </button>
        )}
        <button
          type="button"
          className="btn"
          onClick={() => (isLastIntroCard ? finishIntro() : setIntroIndex((i) => i + 1))}
        >
          {isLastIntroCard ? "Get Started" : "Next"}
        </button>
      </div>
    </div>
  );
}
