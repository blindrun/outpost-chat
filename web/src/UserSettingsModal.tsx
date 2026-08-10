import { useEffect, useRef, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import {
  MfaStatus,
  User,
  authedMediaUrl,
  confirmTotp,
  deleteAccount,
  deleteWebauthnCredential,
  disableTotp,
  getCurrentUser,
  getMfaStatus,
  publishPublicKey,
  regenerateBackupCodes,
  setupTotp,
  updatePassword,
  updateProfile,
  uploadFile,
  setAvatar,
  webauthnRegisterOptions,
  webauthnRegisterVerify,
} from "./api";
import { Modal } from "./Modal";
import { AudioSettings, VoiceMode, loadAudioSettings, saveAudioSettings } from "./audioSettings";
import { createAdaptiveGate } from "./vadAuto";
import { deriveConversationKey, generateIdentity, importPrivateKey, importPublicKey } from "./crypto/keys";
import { StoredIdentity, loadIdentity, saveIdentity } from "./crypto/store";

type Tab = "profile" | "password" | "security" | "voice";

function ProfileTab({
  baseUrl,
  token,
  user,
  onSessionUpdate,
  onClose,
  onAccountDeleted,
}: {
  baseUrl: string;
  token: string;
  user: User;
  onSessionUpdate: (update: { token?: string; user: User }) => void;
  onClose: () => void;
  onAccountDeleted: () => void;
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
            <img className="avatar avatar-lg" src={authedMediaUrl(user.avatarUrl, baseUrl, token)} alt="" />
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
          <button type="button" className="btn secondary" onClick={onClose}>
            Close
          </button>
          <button type="submit" className="btn" disabled={profileSaving}>
            {profileSaving ? "Saving…" : "Save Profile"}
          </button>
        </div>
      </form>

      <DangerZone baseUrl={baseUrl} token={token} user={user} onAccountDeleted={onAccountDeleted} />
    </>
  );
}

// Deliberately collapsed behind a button, and behind a typed-username
// confirmation once expanded — this is the only action in the app a user
// can take that nothing can undo, including the instance owner (their
// messages survive, but the account and its identity don't). The instance
// owner sees an explanation instead of a form: the server refuses their
// deletion outright (no ownership transfer exists), so offering the form
// would just be a guaranteed error.
function DangerZone({
  baseUrl,
  token,
  user,
  onAccountDeleted,
}: {
  baseUrl: string;
  token: string;
  user: User;
  onAccountDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmUsername, setConfirmUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Fetched only once the section is expanded, not on every Profile-tab
  // render — the code field has to be shown for a 2FA account and hidden
  // otherwise, and this is the one thing the client can't already tell from
  // the session user.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getMfaStatus(baseUrl, token)
      .then((status) => {
        if (!cancelled) setMfaEnabled(status.totpEnabled);
      })
      .catch(() => {
        // Non-fatal: leaving the field hidden just means the server asks
        // for the code by rejecting once, which the error line surfaces.
      });
    return () => {
      cancelled = true;
    };
  }, [open, baseUrl, token]);

  async function handleDelete(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await deleteAccount(baseUrl, token, password, confirmUsername, code || undefined);
      onAccountDeleted();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (user.isOwner) {
    return (
      <div className="settings-section danger-zone">
        <h3>Delete Account</h3>
        <p className="settings-hint">
          You own this instance, so your account can't be deleted — an instance with no owner can't be
          administered by anyone. To shut it down, take the server itself offline.
        </p>
      </div>
    );
  }

  return (
    <div className="settings-section danger-zone">
      <h3>Delete Account</h3>
      <p className="settings-hint">
        Permanently deletes your account, profile and friends. Messages you've already sent stay in their
        channels, shown as “Deleted User”. This can't be undone.
      </p>
      {!open ? (
        <button type="button" className="btn danger" onClick={() => setOpen(true)}>
          Delete Account
        </button>
      ) : (
        <form onSubmit={handleDelete}>
          <label>
            Type your username (<strong>{user.username}</strong>) to confirm
            <input value={confirmUsername} onChange={(e) => setConfirmUsername(e.target.value)} autoComplete="off" />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {mfaEnabled && (
            <label>
              Two-factor code
              <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />
            </label>
          )}
          {error && <p className="error">{error}</p>}
          <div className="modal-actions">
            <button
              type="button"
              className="btn secondary"
              onClick={() => {
                setOpen(false);
                setConfirmUsername("");
                setPassword("");
                setCode("");
                setError(null);
              }}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn danger"
              disabled={busy || confirmUsername !== user.username || !password || (mfaEnabled && !code)}
            >
              {busy ? "Deleting…" : "Permanently Delete"}
            </button>
          </div>
        </form>
      )}
    </div>
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

// A backup-codes list is only ever readable right after it's generated
// (POST /mfa/totp/confirm or /mfa/backup-codes/regenerate) — shown once
// here with an explicit acknowledgement before it's dismissed for good.
function BackupCodesReveal({ codes, onDismiss }: { codes: string[]; onDismiss: () => void }) {
  return (
    <div className="backup-codes-reveal">
      <p>
        <strong>Save these backup codes somewhere safe.</strong> Each one can be used once, instead of your
        authenticator app, if you ever lose access to it. They won't be shown again.
      </p>
      <div className="backup-codes-grid">
        {codes.map((code) => (
          <code key={code}>{code}</code>
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onDismiss}>
          I've saved these codes
        </button>
      </div>
    </div>
  );
}

// Opt-in, deliberately. Turning this on is the only action in the app whose
// consequence a password reset cannot undo: resetting a password restores
// account access but not encrypted history, because the key is not derived
// from the password and no amount of server-side help can change that. Making
// it a choice means nobody loses history they never chose to encrypt, and the
// warning lands at the moment of choosing rather than months later.
function EncryptedDmsSection({
  baseUrl,
  token,
  instanceId,
}: {
  baseUrl: string;
  token: string;
  instanceId: string;
}) {
  const [identity, setIdentity] = useState<StoredIdentity | null | undefined>(undefined);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreCode, setRestoreCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadIdentity(instanceId)
      .then((found) => !cancelled && setIdentity(found ?? null))
      .catch(() => !cancelled && setIdentity(null));
    return () => {
      cancelled = true;
    };
  }, [instanceId]);

  async function handleEnable() {
    setError(null);
    setBusy(true);
    try {
      const generated = await generateIdentity();
      // Published before it's stored locally on purpose: if publishing fails
      // there is nothing to clean up, whereas a key saved locally but never
      // published would leave contacts unable to encrypt to you while the UI
      // insisted encryption was on.
      await publishPublicKey(baseUrl, token, generated.publicKey);
      const stored: StoredIdentity = {
        privateKey: generated.privateKey,
        publicKey: generated.publicKey,
        createdAt: Date.now(),
      };
      await saveIdentity(instanceId, stored);
      setIdentity(stored);
      setRecoveryCode(generated.recoveryCode);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const privateKey = await importPrivateKey(restoreCode.trim());
      // The public half isn't in the recovery code, so it's taken from the
      // account's published key. If that doesn't actually match this private
      // key, every decryption would fail later with no explanation — so prove
      // the pair agrees now, while there's still something useful to say.
      const me = await getCurrentUser(baseUrl, token);
      if (!me.publicKey) throw new Error("this account has no published encryption key to restore against");
      const check = await deriveConversationKey(privateKey, await importPublicKey(me.publicKey));
      if (!check) throw new Error("recovery code did not produce a usable key");
      const stored: StoredIdentity = { privateKey, publicKey: me.publicKey, createdAt: Date.now() };
      await saveIdentity(instanceId, stored);
      setIdentity(stored);
      setRestoreOpen(false);
      setRestoreCode("");
    } catch {
      setError("That recovery code doesn't match this account's encryption key.");
    } finally {
      setBusy(false);
    }
  }

  if (identity === undefined) return null;

  if (recoveryCode) {
    return (
      <div className="settings-section danger-zone">
        <h3>Save your recovery code</h3>
        <p className="settings-hint">
          This is shown <strong>once</strong>. It's the only way to read your encrypted messages on another
          device, or on this one after clearing site data. <strong>Resetting your password will not recover
          it</strong> — nobody, including this server's owner, can retrieve it for you.
        </p>
        <textarea className="recovery-code" readOnly rows={4} value={recoveryCode} onFocus={(e) => e.target.select()} />
        <label className="checkbox-label">
          <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
          I've saved this somewhere safe
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" disabled={!acknowledged} onClick={() => setRecoveryCode(null)}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <h3>Encrypted Direct Messages</h3>
      {identity ? (
        <>
          <p className="settings-hint">
            <strong>On.</strong> New direct messages are encrypted on your device whenever the other person has
            also turned this on — you'll see which conversations are covered. Messages in servers' channels are
            not encrypted, and never have been.
          </p>
          <p className="settings-hint">
            Lost your recovery code? Turn this off and on again to start over with a new one. You'll keep being
            able to read messages on this device, but not on any new one.
          </p>
        </>
      ) : (
        <>
          <p className="settings-hint">
            Off. Direct messages are stored on the server in plain text, so whoever runs it can read them.
            Turning this on encrypts new DMs so that only you and the person you're talking to can — including
            against the server itself.
          </p>
          <p className="settings-hint">
            <strong>The catch, up front:</strong> you get a recovery code shown once. Without it you can't read
            your encrypted messages on a new device, and <strong>a password reset won't bring them back</strong>.
          </p>
          {error && <p className="error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn secondary" onClick={() => setRestoreOpen((v) => !v)} disabled={busy}>
              I have a recovery code
            </button>
            <button type="button" className="btn" onClick={handleEnable} disabled={busy}>
              {busy ? "Setting up…" : "Turn On"}
            </button>
          </div>
          {restoreOpen && (
            <form onSubmit={handleRestore}>
              <label>
                Recovery code
                <textarea rows={4} value={restoreCode} onChange={(e) => setRestoreCode(e.target.value)} />
              </label>
              <div className="modal-actions">
                <button type="submit" className="btn" disabled={busy || !restoreCode.trim()}>
                  {busy ? "Checking…" : "Restore"}
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}

function SecurityTab({
  baseUrl,
  token,
  instanceId,
}: {
  baseUrl: string;
  token: string;
  instanceId: string;
}) {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [setupData, setSetupData] = useState<{ secret: string; qrCodeDataUrl: string } | null>(null);
  const [setupCode, setSetupCode] = useState("");
  const [setupBusy, setSetupBusy] = useState(false);
  const [revealCodes, setRevealCodes] = useState<string[] | null>(null);

  const [disableOpen, setDisableOpen] = useState(false);
  const [disablePassword, setDisablePassword] = useState("");
  const [disableBusy, setDisableBusy] = useState(false);

  const [regenOpen, setRegenOpen] = useState(false);
  const [regenPassword, setRegenPassword] = useState("");
  const [regenBusy, setRegenBusy] = useState(false);

  const [addingKey, setAddingKey] = useState(false);
  const [keyNickname, setKeyNickname] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);

  const [removeTargetId, setRemoveTargetId] = useState<string | null>(null);
  const [removePassword, setRemovePassword] = useState("");
  const [removeBusy, setRemoveBusy] = useState(false);

  function refresh() {
    getMfaStatus(baseUrl, token)
      .then(setStatus)
      .catch((err) => setError(err.message));
  }

  useEffect(refresh, [baseUrl, token]);

  async function handleStartTotpSetup() {
    setError(null);
    setSetupBusy(true);
    try {
      setSetupData(await setupTotp(baseUrl, token));
      setSetupCode("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSetupBusy(false);
    }
  }

  async function handleConfirmTotp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSetupBusy(true);
    try {
      const { backupCodes } = await confirmTotp(baseUrl, token, setupCode.trim());
      setSetupData(null);
      setRevealCodes(backupCodes);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSetupBusy(false);
    }
  }

  async function handleDisableTotp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDisableBusy(true);
    try {
      await disableTotp(baseUrl, token, disablePassword);
      setDisableOpen(false);
      setDisablePassword("");
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDisableBusy(false);
    }
  }

  async function handleRegenerateBackupCodes(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setRegenBusy(true);
    try {
      const { backupCodes } = await regenerateBackupCodes(baseUrl, token, regenPassword);
      setRegenOpen(false);
      setRegenPassword("");
      setRevealCodes(backupCodes);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRegenBusy(false);
    }
  }

  async function handleAddKey(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setKeyBusy(true);
    try {
      const { options, challengeToken } = await webauthnRegisterOptions(baseUrl, token);
      const response = await startRegistration({ optionsJSON: options });
      await webauthnRegisterVerify(baseUrl, token, challengeToken, response, keyNickname.trim() || "Security Key");
      setAddingKey(false);
      setKeyNickname("");
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setKeyBusy(false);
    }
  }

  async function handleRemoveKey(e: React.FormEvent) {
    e.preventDefault();
    if (!removeTargetId) return;
    setError(null);
    setRemoveBusy(true);
    try {
      await deleteWebauthnCredential(baseUrl, token, removeTargetId, removePassword);
      setRemoveTargetId(null);
      setRemovePassword("");
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRemoveBusy(false);
    }
  }

  if (revealCodes) {
    return (
      <div className="settings-section">
        <BackupCodesReveal codes={revealCodes} onDismiss={() => setRevealCodes(null)} />
      </div>
    );
  }

  return (
    <div className="settings-section">
      {error && <p className="error">{error}</p>}

      <EncryptedDmsSection baseUrl={baseUrl} token={token} instanceId={instanceId} />

      <h3>Authenticator App</h3>
      {!status ? (
        <p className="picker-empty">Loading…</p>
      ) : !status.totpEnabled ? (
        setupData ? (
          <form onSubmit={handleConfirmTotp} className="totp-setup">
            <p className="subtitle">Scan this with Google Authenticator, Authy, or any TOTP app, then enter the 6-digit code it shows.</p>
            <img className="totp-qr" src={setupData.qrCodeDataUrl} alt="TOTP QR code" />
            <p className="totp-secret">
              Can't scan it? Enter this key manually: <code>{setupData.secret}</code>
            </p>
            <label>
              Code
              <input autoFocus value={setupCode} onChange={(e) => setSetupCode(e.target.value)} placeholder="123456" />
            </label>
            <div className="modal-actions">
              <button type="button" className="btn secondary" onClick={() => setSetupData(null)}>
                Cancel
              </button>
              <button type="submit" className="btn" disabled={setupBusy || setupCode.trim().length !== 6}>
                {setupBusy ? "…" : "Confirm"}
              </button>
            </div>
          </form>
        ) : (
          <>
            <p className="subtitle">Not enabled. Add a second factor with an authenticator app like Google Authenticator or Authy.</p>
            <button type="button" className="btn secondary" onClick={handleStartTotpSetup} disabled={setupBusy}>
              {setupBusy ? "…" : "Enable Authenticator App"}
            </button>
          </>
        )
      ) : (
        <>
          <p className="subtitle">
            Enabled — {status.backupCodesRemaining} backup code{status.backupCodesRemaining === 1 ? "" : "s"} remaining.
          </p>
          {!regenOpen ? (
            <button type="button" className="btn secondary" onClick={() => setRegenOpen(true)}>
              Regenerate Backup Codes
            </button>
          ) : (
            <form onSubmit={handleRegenerateBackupCodes} className="password-confirm-form">
              <label>
                Confirm password
                <input
                  type="password"
                  autoFocus
                  value={regenPassword}
                  onChange={(e) => setRegenPassword(e.target.value)}
                />
              </label>
              <div className="modal-actions">
                <button type="button" className="btn secondary" onClick={() => setRegenOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn" disabled={regenBusy || !regenPassword}>
                  {regenBusy ? "…" : "Regenerate"}
                </button>
              </div>
            </form>
          )}
          {!disableOpen ? (
            <button type="button" className="btn secondary danger" onClick={() => setDisableOpen(true)}>
              Disable Authenticator App
            </button>
          ) : (
            <form onSubmit={handleDisableTotp} className="password-confirm-form">
              <label>
                Confirm password
                <input
                  type="password"
                  autoFocus
                  value={disablePassword}
                  onChange={(e) => setDisablePassword(e.target.value)}
                />
              </label>
              <div className="modal-actions">
                <button type="button" className="btn secondary" onClick={() => setDisableOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn secondary danger" disabled={disableBusy || !disablePassword}>
                  {disableBusy ? "…" : "Disable"}
                </button>
              </div>
            </form>
          )}
        </>
      )}

      <h3>Security Keys</h3>
      <p className="subtitle">Hardware keys (YubiKey) or platform authenticators (Touch ID, Windows Hello).</p>
      {status && status.webauthnCredentials.length > 0 && (
        <ul className="member-list">
          {status.webauthnCredentials.map((cred) => (
            <li key={cred.id} className="member-row">
              <span className="member-username">{cred.nickname}</span>
              {removeTargetId === cred.id ? (
                <form onSubmit={handleRemoveKey} className="password-confirm-form inline">
                  <input
                    type="password"
                    autoFocus
                    placeholder="password"
                    value={removePassword}
                    onChange={(e) => setRemovePassword(e.target.value)}
                  />
                  <button type="submit" className="text-btn danger" disabled={removeBusy || !removePassword}>
                    confirm
                  </button>
                  <button type="button" className="text-btn" onClick={() => setRemoveTargetId(null)}>
                    cancel
                  </button>
                </form>
              ) : (
                <button type="button" className="text-btn danger" onClick={() => setRemoveTargetId(cred.id)}>
                  remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {addingKey ? (
        <form onSubmit={handleAddKey} className="new-channel-form">
          <input
            autoFocus
            placeholder="Nickname, e.g. YubiKey 5C"
            value={keyNickname}
            onChange={(e) => setKeyNickname(e.target.value)}
          />
          <button type="submit" className="btn" disabled={keyBusy}>
            {keyBusy ? "…" : "Register"}
          </button>
          <button type="button" className="btn secondary" onClick={() => setAddingKey(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" className="btn secondary" onClick={() => setAddingKey(true)}>
          Add a Security Key
        </button>
      )}
    </div>
  );
}

function VoiceTab() {
  const [settings, setSettings] = useState<AudioSettings>(() => loadAudioSettings());
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [capturingKey, setCapturingKey] = useState(false);
  const [meterLevel, setMeterLevel] = useState(0);
  // Live readout of the adaptive gate, so "Automatic" is something you can
  // watch working rather than a black box you have to trust.
  const [autoThreshold, setAutoThreshold] = useState(0);
  const [autoOpen, setAutoOpen] = useState(false);
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

        // Its own instance, not the voice session's — this meter runs whether
        // or not you're connected to a channel. Same algorithm, so what the
        // marker shows here is what the gate will actually do.
        const adaptive = createAdaptiveGate();

        function tick() {
          analyser!.getByteTimeDomainData(data);
          let sumSquares = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sumSquares += v * v;
          }
          const rms = Math.sqrt(sumSquares / data.length);
          const level = Math.min(100, Math.round(rms * 300));
          setMeterLevel(level);
          setAutoOpen(adaptive.update(level));
          setAutoThreshold(adaptive.threshold);
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

      <label>
        Input Mode
        <select value={settings.mode} onChange={(e) => update({ mode: e.target.value as VoiceMode })}>
          <option value="vad">Voice Activity (automatic)</option>
          <option value="ptt">Push to Talk</option>
        </select>
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
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.vadAuto}
              onChange={(e) => update({ vadAuto: e.target.checked })}
            />
            Adjust sensitivity automatically
          </label>
          {settings.vadAuto ? (
            <p className="settings-hint">
              Outpost listens to your room's background noise and moves the threshold to sit just above it,
              adjusting as things change. The marker below shows where it currently sits — talk normally and
              watch it settle. Turn this off if you'd rather set it by hand.
            </p>
          ) : (
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
          )}
          <div className={`mic-meter ${settings.vadAuto && autoOpen ? "transmitting" : ""}`}>
            <div className="mic-meter-fill" style={{ width: `${meterLevel}%` }} />
            <div
              className="mic-meter-threshold"
              style={{ left: `${settings.vadAuto ? autoThreshold : settings.vadThreshold}%` }}
            />
          </div>
        </>
      )}
    </div>
  );
}

export function UserSettingsModal({
  baseUrl,
  token,
  instanceId,
  user,
  onClose,
  onSessionUpdate,
  onAccountDeleted,
}: {
  baseUrl: string;
  token: string;
  instanceId: string;
  user: User;
  onClose: () => void;
  onSessionUpdate: (update: { token?: string; user: User }) => void;
  onAccountDeleted: () => void;
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
        <button className={tab === "security" ? "active" : ""} onClick={() => setTab("security")}>
          Security
        </button>
        <button className={tab === "voice" ? "active" : ""} onClick={() => setTab("voice")}>
          Voice
        </button>
      </div>

      {tab === "profile" && (
        <ProfileTab
          baseUrl={baseUrl}
          token={token}
          user={user}
          onSessionUpdate={onSessionUpdate}
          onClose={onClose}
          onAccountDeleted={onAccountDeleted}
        />
      )}
      {tab === "password" && <PasswordTab baseUrl={baseUrl} token={token} />}
      {tab === "security" && <SecurityTab baseUrl={baseUrl} token={token} instanceId={instanceId} />}
      {tab === "voice" && <VoiceTab />}

      {tab !== "profile" && (
        <div className="modal-actions">
          <button className="btn secondary" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </Modal>
  );
}
