import { useEffect, useState } from "react";
import {
  Channel,
  CustomEmoji,
  InstanceInfo,
  Member,
  Permission,
  Role,
  assignRole,
  createRole,
  listMembers,
  listRoles,
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
import { ThemePicker } from "./ThemePicker";

const ALL_PERMISSIONS: Permission[] = [
  "MANAGE_CHANNELS",
  "MANAGE_ROLES",
  "SEND_MESSAGES",
  "MODERATE_MEMBERS",
  "UPLOAD_DOCUMENTS",
  "UPLOAD_ARCHIVES",
  "UPLOAD_CODE",
];

type Tab = "general" | "roles" | "members" | "channels" | "invites" | "webhooks" | "bot" | "emoji";

function GeneralTab({
  baseUrl,
  token,
  instanceInfo,
  channels,
  onUpdated,
}: {
  baseUrl: string;
  token: string;
  instanceInfo: InstanceInfo;
  channels: Channel[];
  onUpdated: (info: InstanceInfo) => void;
}) {
  const [name, setName] = useState(instanceInfo.name);
  const [description, setDescription] = useState(instanceInfo.description ?? "");
  const [theme, setTheme] = useState(instanceInfo.theme);
  const [requireInvite, setRequireInvite] = useState(instanceInfo.requireInviteToRegister);
  const [defaultChannelId, setDefaultChannelId] = useState(instanceInfo.defaultChannelId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [iconUploading, setIconUploading] = useState(false);
  const [iconError, setIconError] = useState<string | null>(null);

  const textChannels = channels.filter((c) => c.type === "TEXT");

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
          <img className="avatar avatar-lg" src={instanceInfo.iconUrl} alt="" />
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
      <h3>Theme</h3>
      <ThemePicker value={theme} onChange={setTheme} />
      {error && <p className="error">{error}</p>}
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

function MembersTab({ baseUrl, token }: { baseUrl: string; token: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [selectedRole, setSelectedRole] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

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

  const activeMembers = members.filter((m) => !m.banned);
  const bannedMembers = members.filter((m) => m.banned);

  return (
    <div className="settings-section">
      {error && <p className="error">{error}</p>}
      <ul className="member-list">
        {activeMembers.map((m) => (
          <li key={m.userId} className="member-row">
            {m.avatarUrl ? (
              <img className="avatar" src={m.avatarUrl} alt="" />
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
          </li>
        ))}
      </ul>

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
                  <img className="avatar" src={m.avatarUrl} alt="" />
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

export function InstanceSettingsModal({
  baseUrl,
  token,
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
  instanceInfo: InstanceInfo;
  channels: Channel[];
  onClose: () => void;
  onUpdated: (info: InstanceInfo) => void;
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
      </div>

      {tab === "general" && (
        <GeneralTab baseUrl={baseUrl} token={token} instanceInfo={instanceInfo} channels={channels} onUpdated={onUpdated} />
      )}
      {tab === "roles" && <RolesTab baseUrl={baseUrl} token={token} />}
      {tab === "members" && <MembersTab baseUrl={baseUrl} token={token} />}
      {tab === "channels" && (
        <ChannelsPanel baseUrl={baseUrl} token={token} channels={channels} onChannelUpdated={onChannelUpdated} />
      )}
      {tab === "invites" && <InvitePanel baseUrl={baseUrl} token={token} />}
      {tab === "webhooks" && <WebhooksPanel baseUrl={baseUrl} token={token} channels={channels} />}
      {tab === "bot" && <BotSettingsPanel baseUrl={baseUrl} token={token} channels={channels} />}
      {tab === "emoji" && (
        <EmojiSettingsPanel baseUrl={baseUrl} token={token} customEmoji={customEmoji} onChanged={onCustomEmojiChanged} />
      )}

      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
