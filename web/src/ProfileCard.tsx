import { useEffect, useState } from "react";
import { Member, Role, assignRole, getMemberProfile, unassignRole } from "./api";

export function ProfileCard({
  baseUrl,
  token,
  userId,
  currentUserId,
  isOnline,
  canManageRoles,
  roles,
  onClose,
  onEditProfile,
}: {
  baseUrl: string;
  token: string;
  userId: string;
  currentUserId: string;
  isOnline: boolean;
  canManageRoles: boolean;
  roles: Role[];
  onClose: () => void;
  onEditProfile: () => void;
}) {
  const [profile, setProfile] = useState<Member | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    getMemberProfile(baseUrl, token, userId)
      .then(setProfile)
      .catch((err) => setError(err.message));
  }

  useEffect(refresh, [baseUrl, token, userId]);

  const isSelf = userId === currentUserId;

  async function toggleRole(roleId: string, has: boolean) {
    setError(null);
    try {
      if (has) await unassignRole(baseUrl, token, userId, roleId);
      else await assignRole(baseUrl, token, userId, roleId);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="role-popover-backdrop" onClick={onClose}>
      <div className="role-popover profile-card" onClick={(e) => e.stopPropagation()}>
        {error && <p className="error">{error}</p>}
        {!profile ? (
          <p className="picker-empty">Loading…</p>
        ) : (
          <>
            <div className="profile-card-header">
              {profile.avatarUrl ? (
                <img className="avatar avatar-lg" src={profile.avatarUrl} alt="" />
              ) : (
                <span className="avatar avatar-lg avatar-placeholder">{profile.username[0]?.toUpperCase()}</span>
              )}
              <div>
                <h4>{profile.username}</h4>
                <span className={`presence-dot ${isOnline ? "online" : "offline"}`} /> {isOnline ? "Online" : "Offline"}
              </div>
            </div>
            <p className="profile-card-bio">{profile.bio || "No bio yet."}</p>
            {profile.roles.length > 0 && (
              <p className="invite-meta">{profile.roles.map((r) => r.name).join(", ")}</p>
            )}

            {isSelf ? (
              <button type="button" className="btn secondary" onClick={onEditProfile}>
                Edit Profile
              </button>
            ) : (
              canManageRoles && (
                <>
                  <h4>Roles</h4>
                  {roles.map((r) => {
                    const has = profile.roles.some((mr) => mr.id === r.id);
                    return (
                      <label key={r.id} className="checkbox-label">
                        <input type="checkbox" checked={has} onChange={() => toggleRole(r.id, has)} />
                        {r.name}
                      </label>
                    );
                  })}
                  {roles.length === 0 && <p className="picker-empty">No roles created yet.</p>}
                </>
              )
            )}
            <button type="button" className="btn secondary" onClick={onClose}>
              Close
            </button>
          </>
        )}
      </div>
    </div>
  );
}
