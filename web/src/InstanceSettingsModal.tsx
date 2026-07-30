import { useEffect, useState } from "react";
import {
  Channel,
  InstanceInfo,
  Member,
  Permission,
  Role,
  assignRole,
  createRole,
  listMembers,
  listRoles,
  updateInstanceSettings,
  uploadFile,
} from "./api";
import { Modal } from "./Modal";
import { InvitePanel } from "./InvitePanel";
import { WebhooksPanel } from "./WebhooksPanel";
import { BotSettingsPanel } from "./BotSettingsPanel";
import { ThemePicker } from "./ThemePicker";

const ALL_PERMISSIONS: Permission[] = ["MANAGE_CHANNELS", "MANAGE_ROLES", "SEND_MESSAGES", "MODERATE_MEMBERS"];

type Tab = "general" | "roles" | "members" | "invites" | "webhooks" | "bot";

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

function RolesTab({ baseUrl, token }: { baseUrl: string; token: string }) {
  const [roles, setRoles] = useState<Role[]>([]);
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
        {roles.map((role) => (
          <li key={role.id}>
            <strong>{role.name}</strong>
            <span className="invite-meta">{role.permissions.join(", ") || "no permissions"}</span>
          </li>
        ))}
      </ul>
      <form onSubmit={handleCreate} className="settings-section">
        <h3>New Role</h3>
        <input placeholder="role name" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="permission-checkboxes">
          {ALL_PERMISSIONS.map((perm) => (
            <label key={perm} className="checkbox-label">
              <input type="checkbox" checked={permissions.has(perm)} onChange={() => togglePermission(perm)} />
              {perm}
            </label>
          ))}
        </div>
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

  return (
    <div className="settings-section">
      {error && <p className="error">{error}</p>}
      <ul className="member-list">
        {members.map((m) => (
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
}: {
  baseUrl: string;
  token: string;
  instanceInfo: InstanceInfo;
  channels: Channel[];
  onClose: () => void;
  onUpdated: (info: InstanceInfo) => void;
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
        <button className={tab === "invites" ? "active" : ""} onClick={() => setTab("invites")}>
          Invites
        </button>
        <button className={tab === "webhooks" ? "active" : ""} onClick={() => setTab("webhooks")}>
          Webhooks
        </button>
        <button className={tab === "bot" ? "active" : ""} onClick={() => setTab("bot")}>
          Bot
        </button>
      </div>

      {tab === "general" && (
        <GeneralTab baseUrl={baseUrl} token={token} instanceInfo={instanceInfo} channels={channels} onUpdated={onUpdated} />
      )}
      {tab === "roles" && <RolesTab baseUrl={baseUrl} token={token} />}
      {tab === "members" && <MembersTab baseUrl={baseUrl} token={token} />}
      {tab === "invites" && <InvitePanel baseUrl={baseUrl} token={token} />}
      {tab === "webhooks" && <WebhooksPanel baseUrl={baseUrl} token={token} channels={channels} />}
      {tab === "bot" && <BotSettingsPanel baseUrl={baseUrl} token={token} channels={channels} />}

      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
