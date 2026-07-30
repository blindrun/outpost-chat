import { useEffect, useState } from "react";
import { Member, listMembers } from "./api";

export function MemberList({
  baseUrl,
  token,
  onlineUserIds,
  onSelectMember,
}: {
  baseUrl: string;
  token: string;
  onlineUserIds: Set<string>;
  onSelectMember: (userId: string) => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listMembers(baseUrl, token)
      .then(setMembers)
      .catch((err) => setError(err.message));
  }, [baseUrl, token]);

  const online = members.filter((m) => onlineUserIds.has(m.userId));
  const offline = members.filter((m) => !onlineUserIds.has(m.userId));

  function renderGroup(title: string, list: Member[]) {
    if (list.length === 0) return null;
    return (
      <div className="member-group">
        <h4>
          {title} — {list.length}
        </h4>
        {list.map((m) => (
          <button key={m.userId} type="button" className="member-list-entry" onClick={() => onSelectMember(m.userId)}>
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
    </aside>
  );
}
