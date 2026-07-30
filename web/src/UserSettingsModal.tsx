import { useEffect, useRef, useState } from "react";
import { User, updatePassword, updateProfile, uploadFile, setAvatar } from "./api";
import { Modal } from "./Modal";
import { AudioSettings, loadAudioSettings, saveAudioSettings } from "./audioSettings";

type Tab = "profile" | "password" | "voice";

function ProfileTab({
  baseUrl,
  token,
  user,
  onSessionUpdate,
}: {
  baseUrl: string;
  token: string;
  user: User;
  onSessionUpdate: (update: { token?: string; user: User }) => void;
}) {
  const [username, setUsername] = useState(user.username);
  const [email, setEmail] = useState(user.email);
  const [bio, setBio] = useState(user.bio ?? "");
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setProfileError(null);
    setProfileSaving(true);
    try {
      const updates: { username?: string; email?: string; bio?: string | null } = {};
      if (username !== user.username) updates.username = username;
      if (email !== user.email) updates.email = email;
      if (bio !== (user.bio ?? "")) updates.bio = bio.trim() || null;
      if (Object.keys(updates).length === 0) return;
      const result = await updateProfile(baseUrl, token, updates);
      onSessionUpdate({ token: result.token, user: result.user });
    } catch (err) {
      setProfileError((err as Error).message);
    } finally {
      setProfileSaving(false);
    }
  }

  async function handleAvatarSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setAvatarError(null);
    setAvatarUploading(true);
    try {
      const { url } = await uploadFile(baseUrl, token, file);
      const updatedUser = await setAvatar(baseUrl, token, url);
      onSessionUpdate({ user: updatedUser });
    } catch (err) {
      setAvatarError((err as Error).message);
    } finally {
      setAvatarUploading(false);
    }
  }

  return (
    <>
      <div className="settings-section">
        <div className="settings-avatar-row">
          {user.avatarUrl ? (
            <img className="avatar avatar-lg" src={user.avatarUrl} alt="" />
          ) : (
            <span className="avatar avatar-lg avatar-placeholder">{user.username[0]?.toUpperCase()}</span>
          )}
          <label className="btn secondary">
            {avatarUploading ? "Uploading…" : "Change Avatar"}
            <input type="file" accept="image/*" hidden onChange={handleAvatarSelect} disabled={avatarUploading} />
          </label>
        </div>
        {avatarError && <p className="error">{avatarError}</p>}
      </div>

      <form className="settings-section" onSubmit={handleSaveProfile}>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Bio
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value.slice(0, 240))}
            rows={3}
            placeholder="Tell people a little about yourself"
            maxLength={240}
          />
        </label>
        <span className="char-counter">{bio.length}/240</span>
        {profileError && <p className="error">{profileError}</p>}
        <div className="modal-actions">
          <button type="submit" className="btn" disabled={profileSaving}>
            {profileSaving ? "Saving…" : "Save Profile"}
          </button>
        </div>
      </form>
    </>
  );
}

function PasswordTab({ baseUrl, token }: { baseUrl: string; token: string }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(false);
    setPasswordSaving(true);
    try {
      await updatePassword(baseUrl, token, currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setPasswordSuccess(true);
    } catch (err) {
      setPasswordError((err as Error).message);
    } finally {
      setPasswordSaving(false);
    }
  }

  return (
    <form className="settings-section" onSubmit={handleChangePassword}>
      <label>
        Current Password
        <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
      </label>
      <label>
        New Password
        <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
      </label>
      {passwordError && <p className="error">{passwordError}</p>}
      {passwordSuccess && <p className="success">Password updated.</p>}
      <div className="modal-actions">
        <button type="submit" className="btn" disabled={passwordSaving || !currentPassword || newPassword.length < 8}>
          {passwordSaving ? "Saving…" : "Change Password"}
        </button>
      </div>
    </form>
  );
}

function VoiceTab() {
  const [settings, setSettings] = useState<AudioSettings>(() => loadAudioSettings());
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [capturingKey, setCapturingKey] = useState(false);
  const [meterLevel, setMeterLevel] = useState(0);
  const meterStreamRef = useRef<MediaStream | null>(null);

  function update(partial: Partial<AudioSettings>) {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      saveAudioSettings(next);
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    async function refreshDevices() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        // Populate with whatever enumerateDevices() gives us first — even
        // generically-labeled entries are still selectable. Only attempt the
        // label-unlock as a best-effort enhancement afterward, since a denied
        // permission prompt here shouldn't wipe out the list we already have.
        setInputs(devices.filter((d) => d.kind === "audioinput"));
        setOutputs(devices.filter((d) => d.kind === "audiooutput"));

        const needsLabels = devices.some((d) => d.kind === "audioinput" && !d.label);
        if (needsLabels) {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach((t) => t.stop());
            const relabeled = await navigator.mediaDevices.enumerateDevices();
            if (cancelled) return;
            setInputs(relabeled.filter((d) => d.kind === "audioinput"));
            setOutputs(relabeled.filter((d) => d.kind === "audiooutput"));
          } catch (permErr) {
            if (!cancelled) setDevicesError((permErr as Error).message);
          }
        }
      } catch (err) {
        if (!cancelled) setDevicesError((err as Error).message);
      }
    }
    refreshDevices();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live mic-level meter preview (VAD mode only) — this settings screen has
  // no active LiveKit room to piggyback on, so it opens its own short-lived
  // getUserMedia stream just for the meter, closed on cleanup.
  useEffect(() => {
    if (settings.mode !== "vad") {
      setMeterLevel(0);
      return;
    }

    let cancelled = false;
    let audioCtx: AudioContext | null = null;
    let raf = 0;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: settings.inputDeviceId ? { deviceId: { exact: settings.inputDeviceId } } : true,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        meterStreamRef.current = stream;
        audioCtx = new AudioContext();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        function tick() {
          analyser!.getByteTimeDomainData(data);
          let sumSquares = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sumSquares += v * v;
          }
          const rms = Math.sqrt(sumSquares / data.length);
          setMeterLevel(Math.min(100, Math.round(rms * 300)));
          raf = requestAnimationFrame(tick);
        }
        tick();
      } catch (err) {
        if (!cancelled) setDevicesError((err as Error).message);
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      meterStreamRef.current?.getTracks().forEach((t) => t.stop());
      meterStreamRef.current = null;
      audioCtx?.close();
      setMeterLevel(0);
    };
  }, [settings.mode, settings.inputDeviceId]);

  useEffect(() => {
    if (!capturingKey) return;
    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      if (e.code !== "Escape") {
        update({ pttKey: e.code });
      }
      setCapturingKey(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [capturingKey]);

  return (
    <div className="settings-section">
      <label>
        Input Device (Microphone)
        <select
          value={settings.inputDeviceId ?? ""}
          onChange={(e) => update({ inputDeviceId: e.target.value || null })}
        >
          <option value="">System Default</option>
          {inputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Microphone ${d.deviceId.slice(0, 6)}`}
            </option>
          ))}
        </select>
      </label>
      <label>
        Output Device (Speaker)
        <select
          value={settings.outputDeviceId ?? ""}
          onChange={(e) => update({ outputDeviceId: e.target.value || null })}
        >
          <option value="">System Default</option>
          {outputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Speaker ${d.deviceId.slice(0, 6)}`}
            </option>
          ))}
        </select>
      </label>
      {devicesError && <p className="error">{devicesError}</p>}

      <h3>Input Mode</h3>
      <label className="checkbox-label">
        <input
          type="radio"
          name="voice-mode"
          checked={settings.mode === "vad"}
          onChange={() => update({ mode: "vad" })}
        />
        Voice Activity (automatic)
      </label>
      <label className="checkbox-label">
        <input
          type="radio"
          name="voice-mode"
          checked={settings.mode === "ptt"}
          onChange={() => update({ mode: "ptt" })}
        />
        Push to Talk
      </label>

      {settings.mode === "ptt" && (
        <div className="ptt-bind-row">
          <span>
            Push-to-talk key: <strong>{settings.pttKey ?? "not set"}</strong>
          </span>
          <button
            type="button"
            className="btn secondary"
            onClick={() => setCapturingKey(true)}
            disabled={capturingKey}
          >
            {capturingKey ? "Press a key…" : "Click to bind"}
          </button>
        </div>
      )}

      {settings.mode === "vad" && (
        <>
          <label>
            Sensitivity Threshold ({settings.vadThreshold})
            <input
              type="range"
              min={0}
              max={100}
              value={settings.vadThreshold}
              onChange={(e) => update({ vadThreshold: Number(e.target.value) })}
            />
          </label>
          <div className="mic-meter">
            <div className="mic-meter-fill" style={{ width: `${meterLevel}%` }} />
            <div className="mic-meter-threshold" style={{ left: `${settings.vadThreshold}%` }} />
          </div>
        </>
      )}
    </div>
  );
}

export function UserSettingsModal({
  baseUrl,
  token,
  user,
  onClose,
  onSessionUpdate,
}: {
  baseUrl: string;
  token: string;
  user: User;
  onClose: () => void;
  onSessionUpdate: (update: { token?: string; user: User }) => void;
}) {
  const [tab, setTab] = useState<Tab>("profile");

  return (
    <Modal onClose={onClose}>
      <h2>User Settings</h2>
      <div className="modal-tabs settings-tabs">
        <button className={tab === "profile" ? "active" : ""} onClick={() => setTab("profile")}>
          Profile
        </button>
        <button className={tab === "password" ? "active" : ""} onClick={() => setTab("password")}>
          Password
        </button>
        <button className={tab === "voice" ? "active" : ""} onClick={() => setTab("voice")}>
          Voice
        </button>
      </div>

      {tab === "profile" && (
        <ProfileTab baseUrl={baseUrl} token={token} user={user} onSessionUpdate={onSessionUpdate} />
      )}
      {tab === "password" && <PasswordTab baseUrl={baseUrl} token={token} />}
      {tab === "voice" && <VoiceTab />}

      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
