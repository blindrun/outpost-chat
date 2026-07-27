import { useEffect, useState } from "react";
import {
  Member,
  Permission,
  Role,
  Server,
  assignRole,
  createRole,
  listMembers,
  listRoles,
  updateServerSettings,
} from "./api";
import { Modal } from "./Modal";
import { InvitePanel } from "./InvitePanel";

const ALL_PERMISSIONS: Permission[] = ["MANAGE_CHANNELS", "MANAGE_ROLES", "SEND_MESSAGES"];

type Tab = "general" | "roles" | "members" | "invites";

function GeneralTab({
  token,
  server,
  onUpdated,
}: {
  token: string;
  server: Server;
  onUpdated: (server: Server) => void;
}) {
  const [name, setName] = useState(server.name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const updated = await updateServerSettings(token, server.id, { name });
      onUpdated(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="settings-section" onSubmit={handleSave}>
      <label>
        Server Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button type="submit" className="btn" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function RolesTab({ token, serverId }: { token: string; serverId: string }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<Set<Permission>>(new Set());
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    listRoles(token, serverId).then(setRoles).catch((err) => setError(err.message));
  }

  useEffect(refresh, [token, serverId]);

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
      await createRole(token, serverId, name.trim(), [...permissions]);
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

function MembersTab({ token, serverId }: { token: string; serverId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [selectedRole, setSelectedRole] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    listMembers(token, serverId).then(setMembers).catch((err) => setError(err.message));
    listRoles(token, serverId).then(setRoles).catch((err) => setError(err.message));
  }

  useEffect(refresh, [token, serverId]);

  async function handleAssign(userId: string) {
    const roleId = selectedRole[userId];
    if (!roleId) return;
    setError(null);
    try {
      await assignRole(token, serverId, userId, roleId);
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

export function ServerSettingsModal({
  token,
  server,
  onClose,
  onUpdated,
}: {
  token: string;
  server: Server;
  onClose: () => void;
  onUpdated: (server: Server) => void;
}) {
  const [tab, setTab] = useState<Tab>("general");

  return (
    <Modal onClose={onClose}>
      <h2>Server Settings — {server.name}</h2>
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
      </div>

      {tab === "general" && <GeneralTab token={token} server={server} onUpdated={onUpdated} />}
      {tab === "roles" && <RolesTab token={token} serverId={server.id} />}
      {tab === "members" && <MembersTab token={token} serverId={server.id} />}
      {tab === "invites" && <InvitePanel token={token} serverId={server.id} />}

      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
