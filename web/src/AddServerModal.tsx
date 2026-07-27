import { useState } from "react";
import type { Instance, Session } from "./App";
import { InstanceInfo, Theme, getInstanceInfo, login, register, updateInstanceSettings } from "./api";
import { ThemePicker } from "./ThemePicker";

type Step = "address" | "auth" | "theme";

function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (/^https?:\/\//.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

export function AddServerModal({
  initialBaseUrl,
  onConnected,
}: {
  embedded?: boolean;
  initialBaseUrl?: string;
  onConnected: (instance: Instance, session: Session) => void;
}) {
  const [step, setStep] = useState<Step>("address");
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
  const [inviteCode, setInviteCode] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authing, setAuthing] = useState(false);

  const [pendingSession, setPendingSession] = useState<Session | null>(null);
  const [pendingInstance, setPendingInstance] = useState<Instance | null>(null);
  const [theme, setTheme] = useState<Theme>("business");

  async function handleProbe(e: React.FormEvent) {
    e.preventDefault();
    setProbeError(null);
    setProbing(true);
    try {
      const normalized = normalizeBaseUrl(address);
      const instanceInfo = await getInstanceInfo(normalized);
      setBaseUrl(normalized);
      setInfo(instanceInfo);
      setAuthMode(instanceInfo.hasOwner ? "login" : "register");
      setStep("auth");
    } catch (err) {
      setProbeError("Couldn't reach that address — check it's correct and the instance is running.");
      console.error(err);
    } finally {
      setProbing(false);
    }
  }

  async function handleAuth(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    setAuthing(true);
    try {
      const result =
        authMode === "login"
          ? await login(baseUrl, email, password)
          : await register(baseUrl, username, email, password, inviteCode || undefined);

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
    onConnected(pendingInstance, pendingSession);
  }

  if (step === "address") {
    return (
      <form onSubmit={handleProbe} className="add-server-form">
        <h2>Add a Server</h2>
        <p className="subtitle">Connect to a self-hosted Harmony instance by address.</p>
        <label>
          Server Address
          <input
            placeholder="e.g. harmony.example.com or 192.168.1.50:8080"
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
    return (
      <div className="add-server-form">
        <h2>{info?.name}</h2>
        {info?.description && <p className="subtitle">{info.description}</p>}
        {!info?.hasOwner ? (
          <p className="subtitle">You'll be the first user here — set up an account and you'll become the owner.</p>
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
          {authError && <p className="error">{authError}</p>}
          <div className="modal-actions">
            <button type="button" className="btn secondary" onClick={() => setStep("address")}>
              Back
            </button>
            <button type="submit" className="btn" disabled={authing}>
              {authing ? "…" : info?.hasOwner ? (authMode === "login" ? "Log In" : "Register") : "Set Up Instance"}
            </button>
          </div>
        </form>
      </div>
    );
  }

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
