import { useEffect, useRef, useState } from "react";
import type { Instance, Session } from "./App";
import { InstanceInfo, Theme, getInstanceInfo, login, register, updateInstanceSettings } from "./api";
import { ThemePicker } from "./ThemePicker";
import { TurnstileWidget } from "./TurnstileWidget";

type Step = "address" | "connecting" | "auth" | "theme" | "intro";

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

export function AddServerModal({
  initialBaseUrl,
  initialInviteCode,
  onConnected,
}: {
  embedded?: boolean;
  initialBaseUrl?: string;
  initialInviteCode?: string;
  onConnected: (instance: Instance, session: Session) => void;
}) {
  const [step, setStep] = useState<Step>(initialBaseUrl && initialInviteCode ? "connecting" : "address");
  const [address, setAddress] = useState(initialBaseUrl ?? "");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [info, setInfo] = useState<InstanceInfo | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

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

  async function probeAddress(rawAddress: string) {
    setProbeError(null);
    setProbing(true);
    let lastErr: unknown;
    for (const candidate of candidateBaseUrls(rawAddress)) {
      try {
        const instanceInfo = await getInstanceInfo(candidate);
        setBaseUrl(candidate);
        setInfo(instanceInfo);
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

  function handleProbe(e: React.FormEvent) {
    e.preventDefault();
    probeAddress(address);
  }

  // Invite links (`?invite=CODE`) arrive with both the address and the code
  // already known — skip the manual "Connect" click and go straight to the
  // auth step so the recipient doesn't have to figure out where to type
  // anything.
  const autoProbedRef = useRef(false);
  useEffect(() => {
    if (autoProbedRef.current) return;
    if (initialBaseUrl && initialInviteCode) {
      autoProbedRef.current = true;
      probeAddress(initialBaseUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

      const instance: Instance = { id: crypto.randomUUID(), label: label.trim() || info?.name || address, baseUrl };

      if (!info?.hasOwner) {
        // First user on a fresh instance — one extra step to pick a theme
        // before entering the app.
        setPendingSession(result);
        setPendingInstance(instance);
        setStep("theme");
        return;
      }

      onConnected(instance, result);
    } catch (err) {
      setAuthError((err as Error).message);
    } finally {
      setAuthing(false);
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
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
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
            <TurnstileWidget siteKey={info.turnstileSiteKey} onVerify={setTurnstileToken} />
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
