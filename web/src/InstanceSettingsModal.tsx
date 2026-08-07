import { useEffect, useState } from "react";
import {
  Channel,
  CustomEmoji,
  FullInstanceSettings,
  InstanceInfo,
  Member,
  ModerationLogEntry,
  Permission,
  Role,
  assignRole,
  authedMediaUrl,
  createRole,
  getInstanceSettings,
  getModerationAuditLog,
  listMembers,
  listRoles,
  resetMemberPassword,
  unbanMember,
  updateInstanceSettings,
  updateRole,
  uploadFile,
} from "./api";
import { Modal } from "./Modal";
import { InvitePanel } from "./InvitePanel";
import { WebhooksPanel } from "./WebhooksPanel";
import { BotSettingsPanel } from "./BotSettingsPanel";
import { ChannelsPanel } from "./ChannelsPanel";
import { EmojiSettingsPanel } from "./EmojiSettingsPanel";
import { ApiBotsPanel } from "./ApiBotsPanel";
import { ImportPanel } from "./ImportPanel";
import { ThemePicker } from "./ThemePicker";

const ALL_PERMISSIONS: Permission[] = [
  "MANAGE_CHANNELS",
  "MANAGE_ROLES",
  "SEND_MESSAGES",
  "MODERATE_MEMBERS",
  "UPLOAD_DOCUMENTS",
  "UPLOAD_ARCHIVES",
  "UPLOAD_CODE",
  "UPLOAD_VIDEOS",
];

type Tab = "general" | "mail" | "roles" | "members" | "channels" | "invites" | "webhooks" | "bot" | "emoji" | "apiBots" | "auditLog" | "import";

function GeneralTab({
  baseUrl,
  token,
  instanceInfo,
  channels,
  onUpdated,
  onClose,
}: {
  baseUrl: string;
  token: string;
  instanceInfo: InstanceInfo;
  channels: Channel[];
  onUpdated: (info: FullInstanceSettings) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(instanceInfo.name);
  const [description, setDescription] = useState(instanceInfo.description ?? "");
  const [theme, setTheme] = useState(instanceInfo.theme);
  const [requireInvite, setRequireInvite] = useState(instanceInfo.requireInviteToRegister);
  const [defaultChannelId, setDefaultChannelId] = useState(instanceInfo.defaultChannelId ?? "");
  const [afkChannelId, setAfkChannelId] = useState(instanceInfo.afkChannelId ?? "");
  const [afkTimeoutMinutes, setAfkTimeoutMinutes] = useState(instanceInfo.afkTimeoutMinutes ?? 5);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [iconUploading, setIconUploading] = useState(false);
  const [iconError, setIconError] = useState<string | null>(null);

  const textChannels = channels.filter((c) => c.type === "TEXT");
  const voiceChannels = channels.filter((c) => c.type === "VOICE");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const updated = await updateInstanceSettings(baseUrl, token, {
        name,
        description,
        theme,
        requireInviteToRegister: requireInvite,
        defaultChannelId: defaultChannelId || null,
        afkChannelId: afkChannelId || null,
        // No AFK channel selected means the timeout is meaningless — clear
        // it too rather than leaving a stale value that'd resurface if a
        // channel gets picked again later without also being retyped.
        afkTimeoutMinutes: afkChannelId ? afkTimeoutMinutes : null,
      });
      onUpdated(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleIconSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setIconError(null);
    setIconUploading(true);
    try {
      const { url } = await uploadFile(baseUrl, token, file);
      const updated = await updateInstanceSettings(baseUrl, token, { iconUrl: url });
      onUpdated(updated);
    } catch (err) {
      setIconError((err as Error).message);
    } finally {
      setIconUploading(false);
    }
  }

  return (
    <form className="settings-section" onSubmit={handleSave}>
      <div className="settings-avatar-row">
        {instanceInfo.iconUrl ? (
          <img className="avatar avatar-lg" src={authedMediaUrl(instanceInfo.iconUrl, baseUrl, token)} alt="" />
        ) : (
          <span className="avatar avatar-lg avatar-placeholder">{instanceInfo.name[0]?.toUpperCase()}</span>
        )}
        <label className="btn secondary">
          {iconUploading ? "Uploading…" : "Change Instance Icon"}
          <input type="file" accept="image/*" hidden onChange={handleIconSelect} disabled={iconUploading} />
        </label>
      </div>
      {iconError && <p className="error">{iconError}</p>}
      <label>
        Instance Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Description
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
      </label>
      <label className="checkbox-label">
        <input type="checkbox" checked={requireInvite} onChange={(e) => setRequireInvite(e.target.checked)} />
        Require an invite code to register
      </label>
      <label>
        Default Channel
        <select value={defaultChannelId} onChange={(e) => setDefaultChannelId(e.target.value)}>
          <option value="">No default — members choose a channel themselves</option>
          {textChannels.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        AFK Voice Channel
        <select value={afkChannelId} onChange={(e) => setAfkChannelId(e.target.value)}>
          <option value="">None — members stay in voice indefinitely while idle</option>
          {voiceChannels.map((c) => (
            <option key={c.id} value={c.id}>
              🔊 {c.name}
            </option>
          ))}
        </select>
      </label>
      {afkChannelId && (
        <label>
          AFK Timeout
          <select value={afkTimeoutMinutes} onChange={(e) => setAfkTimeoutMinutes(Number(e.target.value))}>
            <option value={1}>1 minute</option>
            <option value={5}>5 minutes</option>
            <option value={15}>15 minutes</option>
            <option value={30}>30 minutes</option>
            <option value={60}>1 hour</option>
          </select>
        </label>
      )}
      <h3>Theme</h3>
      <ThemePicker value={theme} onChange={setTheme} />
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn secondary" onClick={onClose}>
          Close
        </button>
        <button type="submit" className="btn" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

// Self-hoster-configured outbound SMTP for the self-service "forgot
// password" email flow (see POST /auth/forgot-password) — off by default.
// Fetches its own copy of the full settings on mount rather than trusting
// instanceInfo (the public GET /instance-info payload never includes
// smtp*), same pattern as SecurityTab's getMfaStatus in UserSettingsModal.
function MailTab({ baseUrl, token, onUpdated }: { baseUrl: string; token: string; onUpdated: (info: FullInstanceSettings) => void }) {
  const [settings, setSettings] = useState<FullInstanceSettings | null>(null);
  const [smtpEnabled, setSmtpEnabled] = useState(false);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("");
  const [smtpUsername, setSmtpUsername] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [smtpFromAddress, setSmtpFromAddress] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getInstanceSettings(baseUrl, token)
      .then((s) => {
        setSettings(s);
        setSmtpEnabled(s.smtpEnabled);
        setSmtpHost(s.smtpHost ?? "");
        setSmtpPort(s.smtpPort ? String(s.smtpPort) : "");
        setSmtpUsername(s.smtpUsername ?? "");
        setSmtpFromAddress(s.smtpFromAddress ?? "");
      })
      .catch((err) => setLoadError((err as Error).message));
  }, [baseUrl, token]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const updated = await updateInstanceSettings(baseUrl, token, {
        smtpEnabled,
        smtpHost: smtpHost.trim() || null,
        smtpPort: smtpPort.trim() ? Number(smtpPort) : null,
        smtpUsername: smtpUsername.trim() || null,
        smtpFromAddress: smtpFromAddress.trim() || null,
        // Empty = leave whatever's already stored alone (so re-saving the
        // rest of this tab doesn't force retyping it); the password field
        // is otherwise never pre-filled with the real value.
        ...(smtpPassword.trim() ? { smtpPassword: smtpPassword.trim() } : {}),
      });
      setSettings(updated);
      setSmtpPassword("");
      setSaved(true);
      onUpdated(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <p className="error">{loadError}</p>;
  if (!settings) return <p className="subtitle">Loading…</p>;

  return (
    <form className="settings-section" onSubmit={handleSave}>
      <p className="subtitle">
        Configure an outbound mail server so members can reset a forgotten password themselves. Leave this off and
        the instance owner can still reset a member's password directly from the Members tab.
      </p>
      <label className="checkbox-label">
        <input type="checkbox" checked={smtpEnabled} onChange={(e) => setSmtpEnabled(e.target.checked)} />
        Enable self-service password reset by email
      </label>
      <label>
        SMTP Host
        <input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.example.com" />
      </label>
      <label>
        SMTP Port
        <input
          type="number"
          value={smtpPort}
          onChange={(e) => setSmtpPort(e.target.value)}
          placeholder="587"
          min={1}
          max={65535}
        />
      </label>
      <label>
        SMTP Username
        <input value={smtpUsername} onChange={(e) => setSmtpUsername(e.target.value)} />
      </label>
      <label>
        SMTP Password
        <input
          type="password"
          value={smtpPassword}
          onChange={(e) => setSmtpPassword(e.target.value)}
          placeholder={settings.smtpPasswordSet ? "•••••••• (unchanged)" : ""}
        />
      </label>
      <label>
        From Address
        <input
          type="email"
          value={smtpFromAddress}
          onChange={(e) => setSmtpFromAddress(e.target.value)}
          placeholder="no-reply@example.com"
        />
      </label>
      {error && <p className="error">{error}</p>}
      {saved && !error && <p className="subtitle">Saved.</p>}
      <div className="modal-actions">
        <button type="submit" className="btn" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function PermissionCheckboxes({
  selected,
  onToggle,
}: {
  selected: Set<Permission>;
  onToggle: (perm: Permission) => void;
}) {
  return (
    <div className="permission-checkboxes">
      {ALL_PERMISSIONS.map((perm) => (
        <label key={perm} className="checkbox-label">
          <input type="checkbox" checked={selected.has(perm)} onChange={() => onToggle(perm)} />
          {perm}
        </label>
      ))}
    </div>
  );
}

function EditRoleRow({
  baseUrl,
  token,
  role,
  onDone,
}: {
  baseUrl: string;
  token: string;
  role: Role;
  onDone: () => void;
}) {
  const [name, setName] = useState(role.name);
  const [permissions, setPermissions] = useState<Set<Permission>>(new Set(role.permissions));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function togglePermission(perm: Permission) {
    setPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(perm)) next.delete(perm);
      else next.add(perm);
      return next;
    });
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    setSaving(true);
    try {
      await updateRole(baseUrl, token, role.id, { name: name.trim(), permissions: [...permissions] });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSave} className="settings-section role-edit-form">
      <input value={name} onChange={(e) => setName(e.target.value)} />
      <PermissionCheckboxes selected={permissions} onToggle={togglePermission} />
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn secondary" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function RolesTab({ baseUrl, token }: { baseUrl: string; token: string }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<Set<Permission>>(new Set());
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    listRoles(baseUrl, token).then(setRoles).catch((err) => setError(err.message));
  }

  useEffect(refresh, [baseUrl, token]);

  function togglePermission(perm: Permission) {
    setPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(perm)) next.delete(perm);
      else next.add(perm);
      return next;
    });
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    try {
      await createRole(baseUrl, token, name.trim(), [...permissions]);
      setName("");
      setPermissions(new Set());
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="settings-section">
      <ul className="role-list">
        {roles.map((role) =>
          editingRoleId === role.id ? (
            <li key={role.id}>
              <EditRoleRow
                baseUrl={baseUrl}
                token={token}
                role={role}
                onDone={() => {
                  setEditingRoleId(null);
                  refresh();
                }}
              />
            </li>
          ) : (
            <li key={role.id} className="role-row">
              <strong>{role.name}</strong>
              <span className="invite-meta">{role.permissions.join(", ") || "no permissions"}</span>
              <button className="text-btn" onClick={() => setEditingRoleId(role.id)}>
                edit
              </button>
            </li>
          ),
        )}
      </ul>
      <form onSubmit={handleCreate} className="settings-section">
        <h3>New Role</h3>
        <input placeholder="role name" value={name} onChange={(e) => setName(e.target.value)} />
        <PermissionCheckboxes selected={permissions} onToggle={togglePermission} />
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button type="submit" className="btn">
            Create Role
          </button>
        </div>
      </form>
    </div>
  );
}

function MembersTab({ baseUrl, token, isOwner }: { baseUrl: string; token: string; isOwner: boolean }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [selectedRole, setSelectedRole] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  // The freshly-generated temp password for whichever member was just
  // reset — shown once, never refetchable (see moderation.ts), so this is
  // the only place it's ever visible.
  const [revealedReset, setRevealedReset] = useState<{ userId: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  function refresh() {
    listMembers(baseUrl, token).then(setMembers).catch((err) => setError(err.message));
    listRoles(baseUrl, token).then(setRoles).catch((err) => setError(err.message));
  }

  useEffect(refresh, [baseUrl, token]);

  async function handleAssign(userId: string) {
    const roleId = selectedRole[userId];
    if (!roleId) return;
    setError(null);
    try {
      await assignRole(baseUrl, token, userId, roleId);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleUnban(userId: string) {
    setError(null);
    try {
      await unbanMember(baseUrl, token, userId);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleResetPassword(userId: string) {
    setError(null);
    try {
      const { tempPassword } = await resetMemberPassword(baseUrl, token, userId);
      setRevealedReset({ userId, password: tempPassword });
      setCopied(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleCopyTempPassword() {
    if (!revealedReset) return;
    try {
      await navigator.clipboard.writeText(revealedReset.password);
      setCopied(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const activeMembers = members.filter((m) => !m.banned);
  const bannedMembers = members.filter((m) => m.banned);

  return (
    <div className="settings-section">
      {error && <p className="error">{error}</p>}
      <ul className="member-list">
        {activeMembers.map((m) => (
          <li key={m.userId} className="member-row">
            {m.avatarUrl ? (
              <img className="avatar" src={authedMediaUrl(m.avatarUrl, baseUrl, token)} alt="" />
            ) : (
              <span className="avatar avatar-placeholder">{m.username[0]?.toUpperCase()}</span>
            )}
            <span className="member-username">{m.username}</span>
            <span className="invite-meta">{m.roles.map((r) => r.name).join(", ")}</span>
            <select
              value={selectedRole[m.userId] ?? ""}
              onChange={(e) => setSelectedRole((prev) => ({ ...prev, [m.userId]: e.target.value }))}
            >
              <option value="">assign role…</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <button className="text-btn" onClick={() => handleAssign(m.userId)}>
              assign
            </button>
            {isOwner && !m.isOwner && !m.isBot && (
              <button className="text-btn" onClick={() => handleResetPassword(m.userId)}>
                reset password
              </button>
            )}
          </li>
        ))}
      </ul>

      {revealedReset && (
        <div className="settings-section" style={{ background: "var(--bg-floating)", borderRadius: 6, padding: "0.6rem" }}>
          <p className="subtitle">
            New temp password for <strong>{members.find((m) => m.userId === revealedReset.userId)?.username}</strong> — won't
            be shown again, relay it to them directly (DM, voice call — not this channel).
          </p>
          <div className="invite-row">
            <code className="inline-code">{revealedReset.password}</code>
            <button type="button" className="text-btn" onClick={handleCopyTempPassword}>
              {copied ? "copied!" : "copy"}
            </button>
          </div>
        </div>
      )}

      {/* Banned members are hidden from the regular member list sidebar
          everyone sees — this is the one place their status is visible,
          and the only place they can be unbanned from besides a profile
          card (which most members can't open the Moderation section of
          anyway). */}
      {bannedMembers.length > 0 && (
        <>
          <h3>Banned</h3>
          <ul className="member-list">
            {bannedMembers.map((m) => (
              <li key={m.userId} className="member-row banned">
                {m.avatarUrl ? (
                  <img className="avatar" src={authedMediaUrl(m.avatarUrl, baseUrl, token)} alt="" />
                ) : (
                  <span className="avatar avatar-placeholder">{m.username[0]?.toUpperCase()}</span>
                )}
                <span className="member-username">{m.username}</span>
                <span className="banned-tag">Banned</span>
                <button className="text-btn" onClick={() => handleUnban(m.userId)}>
                  unban
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

const ACTION_LABELS: Record<string, string> = {
  ban: "banned",
  unban: "unbanned",
  kick: "kicked",
  mute: "muted",
  unmute: "unmuted",
  reset_password: "reset the password of",
};

function AuditLogTab({ baseUrl, token }: { baseUrl: string; token: string }) {
  const [entries, setEntries] = useState<ModerationLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getModerationAuditLog(baseUrl, token)
      .then(setEntries)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [baseUrl, token]);

  return (
    <div className="settings-section">
      <p className="subtitle">
        Every ban, kick, mute, and password reset performed by a moderator or the owner, newest first. Visible to
        anyone with MODERATE_MEMBERS — the same permission that lets someone perform these actions in the first
        place.
      </p>
      {error && <p className="error">{error}</p>}
      {loading && <p className="picker-empty">Loading…</p>}
      {!loading && entries.length === 0 && <p className="picker-empty">No moderation actions yet.</p>}
      <ul className="member-list">
        {entries.map((e) => (
          <li key={e.id} className="member-row">
            <span className="member-username">
              <strong>{e.actorUsername}</strong> {ACTION_LABELS[e.action] ?? e.action} <strong>{e.targetUsername}</strong>
              {e.detail ? ` (${e.detail})` : ""}
            </span>
            <span className="invite-meta">{new Date(e.createdAt).toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function InstanceSettingsModal({
  baseUrl,
  token,
  isOwner,
  canModerate,
  instanceInfo,
  channels,
  onClose,
  onUpdated,
  onChannelUpdated,
  customEmoji,
  onCustomEmojiChanged,
}: {
  baseUrl: string;
  token: string;
  isOwner: boolean;
  canModerate: boolean;
  instanceInfo: InstanceInfo;
  channels: Channel[];
  onClose: () => void;
  onUpdated: (info: FullInstanceSettings) => void;
  onChannelUpdated: (channel: Channel) => void;
  customEmoji: CustomEmoji[];
  onCustomEmojiChanged: () => void;
}) {
  const [tab, setTab] = useState<Tab>("general");

  return (
    <Modal onClose={onClose}>
      <h2>Instance Settings — {instanceInfo.name}</h2>
      <div className="modal-tabs settings-tabs">
        <button className={tab === "general" ? "active" : ""} onClick={() => setTab("general")}>
          General
        </button>
        {isOwner && (
          <button className={tab === "mail" ? "active" : ""} onClick={() => setTab("mail")}>
            Mail
          </button>
        )}
        <button className={tab === "roles" ? "active" : ""} onClick={() => setTab("roles")}>
          Roles
        </button>
        <button className={tab === "members" ? "active" : ""} onClick={() => setTab("members")}>
          Members
        </button>
        <button className={tab === "channels" ? "active" : ""} onClick={() => setTab("channels")}>
          Channels
        </button>
        <button className={tab === "invites" ? "active" : ""} onClick={() => setTab("invites")}>
          Invites
        </button>
        <button className={tab === "webhooks" ? "active" : ""} onClick={() => setTab("webhooks")}>
          Webhooks
        </button>
        <button className={tab === "bot" ? "active" : ""} onClick={() => setTab("bot")}>
          Bot
        </button>
        <button className={tab === "emoji" ? "active" : ""} onClick={() => setTab("emoji")}>
          Emoji
        </button>
        <button className={tab === "apiBots" ? "active" : ""} onClick={() => setTab("apiBots")}>
          API Bots
        </button>
        {canModerate && (
          <button className={tab === "auditLog" ? "active" : ""} onClick={() => setTab("auditLog")}>
            Audit Log
          </button>
        )}
        {isOwner && (
          <button className={tab === "import" ? "active" : ""} onClick={() => setTab("import")}>
            Import
          </button>
        )}
      </div>

      {tab === "general" && (
        <GeneralTab
          baseUrl={baseUrl}
          token={token}
          instanceInfo={instanceInfo}
          channels={channels}
          onUpdated={onUpdated}
          onClose={onClose}
        />
      )}
      {tab === "mail" && isOwner && <MailTab baseUrl={baseUrl} token={token} onUpdated={onUpdated} />}
      {tab === "roles" && <RolesTab baseUrl={baseUrl} token={token} />}
      {tab === "members" && <MembersTab baseUrl={baseUrl} token={token} isOwner={isOwner} />}
      {tab === "channels" && (
        <ChannelsPanel baseUrl={baseUrl} token={token} channels={channels} onChannelUpdated={onChannelUpdated} />
      )}
      {tab === "invites" && <InvitePanel baseUrl={baseUrl} token={token} />}
      {tab === "webhooks" && <WebhooksPanel baseUrl={baseUrl} token={token} channels={channels} />}
      {tab === "bot" && <BotSettingsPanel baseUrl={baseUrl} token={token} channels={channels} />}
      {tab === "emoji" && (
        <EmojiSettingsPanel baseUrl={baseUrl} token={token} customEmoji={customEmoji} onChanged={onCustomEmojiChanged} />
      )}
      {tab === "apiBots" && <ApiBotsPanel baseUrl={baseUrl} token={token} />}
      {tab === "auditLog" && canModerate && <AuditLogTab baseUrl={baseUrl} token={token} />}
      {tab === "import" && isOwner && <ImportPanel baseUrl={baseUrl} token={token} />}

      <p className="instance-version">Outpost v{instanceInfo.version}</p>
      {tab !== "general" && (
        <div className="modal-actions">
          <button className="btn secondary" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </Modal>
  );
}
