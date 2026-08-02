import { useEffect, useState } from "react";
import { Member, authedMediaUrl, listMembers } from "./api";

export function MemberList({
  baseUrl,
  token,
  onlineUserIds,
  onSelectMember,
  refreshKey,
  onClose,
}: {
  baseUrl: string;
  token: string;
  onlineUserIds: Set<string>;
  onSelectMember: (userId: string) => void;
  // Bumped by the parent whenever a moderation action (ban/unban, role
  // change) happens elsewhere — this list otherwise only loads once on
  // mount, so a ban made from a profile card wouldn't show up here until a
  // full page reload.
  refreshKey: number;
  // Only rendered as a real button on a mobile-width viewport (see
  // .mobile-only-btn in index.css) — desktop shows this pane alongside
  // the chat pane, with the header's own 👥 toggle already covering close.
  onClose?: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => ({
    Online: localStorage.getItem("memberListCollapsed:Online") === "true",
    Offline: localStorage.getItem("memberListCollapsed:Offline") === "true",
  }));

  function toggleCollapsed(title: string) {
    setCollapsed((prev) => {
      const next = !prev[title];
      localStorage.setItem(`memberListCollapsed:${title}`, String(next));
      return { ...prev, [title]: next };
    });
  }

  useEffect(() => {
    listMembers(baseUrl, token)
      .then(setMembers)
      .catch((err) => setError(err.message));
  }, [baseUrl, token, refreshKey]);

  // Banned members are deliberately excluded here — that's not
  // information every regular member needs to see. An owner manages bans
  // from Instance Settings > Members instead (see InstanceSettingsModal).
  const active = members.filter((m) => !m.banned);
  const filtered = query.trim()
    ? active.filter((m) => m.username.toLowerCase().includes(query.trim().toLowerCase()))
    : active;
  const online = filtered.filter((m) => onlineUserIds.has(m.userId));
  const offline = filtered.filter((m) => !onlineUserIds.has(m.userId));

  function renderGroup(title: string, list: Member[]) {
    if (list.length === 0) return null;
    const isCollapsed = collapsed[title];
    return (
      <div className="member-group">
        <button type="button" className="member-group-toggle" onClick={() => toggleCollapsed(title)}>
          <span className={`category-chevron ${isCollapsed ? "collapsed" : ""}`}>▾</span>
          <h4>
            {title} — {list.length}
          </h4>
        </button>
        {!isCollapsed &&
          list.map((m) => (
            <button key={m.userId} type="button" className="member-list-entry" onClick={() => onSelectMember(m.userId)}>
              {m.avatarUrl ? (
                <img className="avatar" src={authedMediaUrl(m.avatarUrl, baseUrl, token)} alt="" />
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
      <div className="member-sidebar-header">
        {onClose && (
          <button type="button" className="chat-header-icon-btn mobile-only-btn" title="Back" onClick={onClose}>
            ⬅️
          </button>
        )}
        <button
          type="button"
          className={`chat-header-icon-btn ${searchOpen ? "active" : ""}`}
          title="Search Members"
          onClick={() => {
            setSearchOpen((v) => !v);
            if (searchOpen) setQuery("");
          }}
        >
          🔍
        </button>
      </div>
      {searchOpen && (
        <input
          autoFocus
          className="member-sidebar-search"
          placeholder="Search members…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {error && <p className="error">{error}</p>}
      {renderGroup("Online", online)}
      {renderGroup("Offline", offline)}
      {searchOpen && query.trim() && online.length === 0 && offline.length === 0 && (
        <p className="picker-empty">No members match "{query.trim()}".</p>
      )}
    </aside>
  );
}
