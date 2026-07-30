import { useEffect, useState } from "react";
import { Member, Role, assignRole, listMembers, listRoles, unassignRole } from "./api";

export function MemberList({
  baseUrl,
  token,
  onlineUserIds,
}: {
  baseUrl: string;
  token: string;
  onlineUserIds: Set<string>;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    Promise.all([listMembers(baseUrl, token), listRoles(baseUrl, token)])
      .then(([m, r]) => {
        setMembers(m);
        setRoles(r);
      })
      .catch((err) => setError(err.message));
  }

  useEffect(refresh, [baseUrl, token]);

  async function toggleRole(userId: string, roleId: string, has: boolean) {
    setError(null);
    try {
      if (has) await unassignRole(baseUrl, token, userId, roleId);
      else await assignRole(baseUrl, token, userId, roleId);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const online = members.filter((m) => onlineUserIds.has(m.userId));
  const offline = members.filter((m) => !onlineUserIds.has(m.userId));
  const editingMember = members.find((m) => m.userId === editingUserId);

  function renderGroup(title: string, list: Member[]) {
    if (list.length === 0) return null;
    return (
      <div className="member-group">
        <h4>
          {title} — {list.length}
        </h4>
        {list.map((m) => (
          <button key={m.userId} type="button" className="member-list-entry" onClick={() => setEditingUserId(m.userId)}>
            {m.avatarUrl ? (
              <img className="avatar" src={m.avatarUrl} alt="" />
            ) : (
              <span className="avatar avatar-placeholder">{m.username[0]?.toUpperCase()}</span>
            )}
            <span className="member-list-info">
              <span className="member-list-name">{m.username}</span>
              {m.roles.length > 0 && <span className="member-list-roles">{m.roles.map((r) => r.name).join(", ")}</span>}
            </span>
            <span className={`presence-dot ${onlineUserIds.has(m.userId) ? "online" : "offline"}`} />
          </button>
        ))}
      </div>
    );
  }

  return (
    <aside className="member-sidebar">
      {error && <p className="error">{error}</p>}
      {renderGroup("Online", online)}
      {renderGroup("Offline", offline)}
      {editingMember && (
        <div className="role-popover-backdrop" onClick={() => setEditingUserId(null)}>
          <div className="role-popover" onClick={(e) => e.stopPropagation()}>
            <h4>{editingMember.username}&rsquo;s roles</h4>
            {roles.map((r) => {
              const has = editingMember.roles.some((mr) => mr.id === r.id);
              return (
                <label key={r.id} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={has}
                    onChange={() => toggleRole(editingMember.userId, r.id, has)}
                  />
                  {r.name}
                </label>
              );
            })}
            {roles.length === 0 && <p className="picker-empty">No roles created yet.</p>}
            <button type="button" className="btn secondary" onClick={() => setEditingUserId(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
