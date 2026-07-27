import { useState } from "react";
import { User, updatePassword, updateProfile, uploadFile, setAvatar } from "./api";
import { Modal } from "./Modal";

export function UserSettingsModal({
  token,
  user,
  onClose,
  onSessionUpdate,
}: {
  token: string;
  user: User;
  onClose: () => void;
  onSessionUpdate: (update: { token?: string; user: User }) => void;
}) {
  const [username, setUsername] = useState(user.username);
  const [email, setEmail] = useState(user.email);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);

  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setProfileError(null);
    setProfileSaving(true);
    try {
      const updates: { username?: string; email?: string } = {};
      if (username !== user.username) updates.username = username;
      if (email !== user.email) updates.email = email;
      if (Object.keys(updates).length === 0) return;
      const result = await updateProfile(token, updates);
      onSessionUpdate({ token: result.token, user: result.user });
    } catch (err) {
      setProfileError((err as Error).message);
    } finally {
      setProfileSaving(false);
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(false);
    setPasswordSaving(true);
    try {
      await updatePassword(token, currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setPasswordSuccess(true);
    } catch (err) {
      setPasswordError((err as Error).message);
    } finally {
      setPasswordSaving(false);
    }
  }

  async function handleAvatarSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setAvatarError(null);
    setAvatarUploading(true);
    try {
      const { url } = await uploadFile(token, file);
      const updatedUser = await setAvatar(token, url);
      onSessionUpdate({ user: updatedUser });
    } catch (err) {
      setAvatarError((err as Error).message);
    } finally {
      setAvatarUploading(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2>User Settings</h2>

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
        {profileError && <p className="error">{profileError}</p>}
        <div className="modal-actions">
          <button type="submit" className="btn" disabled={profileSaving}>
            {profileSaving ? "Saving…" : "Save Profile"}
          </button>
        </div>
      </form>

      <form className="settings-section" onSubmit={handleChangePassword}>
        <h3>Change Password</h3>
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

      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
