import { useEffect, useState } from "react";
import {
  Member,
  Role,
  assignRole,
  getMemberProfile,
  muteMember,
  unassignRole,
  unmuteMember,
  warnMember,
} from "./api";

export function ProfileCard({
  baseUrl,
  token,
  userId,
  currentUserId,
  isOnline,
  canManageRoles,
  canModerate,
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
  canModerate: boolean;
  roles: Role[];
  onClose: () => void;
  onEditProfile: () => void;
}) {
  const [profile, setProfile] = useState<Member | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modNotice, setModNotice] = useState<string | null>(null);
  const [warnReason, setWarnReason] = useState("");

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

  async function handleWarn() {
    if (!warnReason.trim()) return;
    setError(null);
    try {
      const result = await warnMember(baseUrl, token, userId, warnReason.trim());
      setWarnReason("");
      setModNotice(
        result.muted
          ? `Warned (${result.count}/${result.threshold}) — auto-muted for repeated violations.`
          : `Warned (${result.count}/${result.threshold}).`,
      );
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleMute(minutes: number) {
    setError(null);
    try {
      await muteMember(baseUrl, token, userId, minutes);
      setModNotice(`Muted for ${minutes} minutes.`);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleUnmute() {
    setError(null);
    try {
      await unmuteMember(baseUrl, token, userId);
      setModNotice("Unmuted.");
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
              <>
                {canManageRoles && (
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
                )}
                {canModerate && (
                  <>
                    <h4>Moderation</h4>
                    {profile.mutedUntil && new Date(profile.mutedUntil) > new Date() && (
                      <p className="invite-meta">Muted until {new Date(profile.mutedUntil).toLocaleString()}</p>
                    )}
                    {modNotice && <p className="invite-meta">{modNotice}</p>}
                    <div className="mod-warn-row">
                      <input
                        value={warnReason}
                        onChange={(e) => setWarnReason(e.target.value)}
                        placeholder="Warning reason"
                      />
                      <button type="button" className="btn secondary" onClick={handleWarn} disabled={!warnReason.trim()}>
                        Warn
                      </button>
                    </div>
                    <div className="mod-actions-row">
                      <button type="button" className="btn secondary" onClick={() => handleMute(10)}>
                        Mute 10m
                      </button>
                      <button type="button" className="btn secondary" onClick={() => handleMute(60)}>
                        Mute 1h
                      </button>
                      <button type="button" className="btn secondary" onClick={handleUnmute}>
                        Unmute
                      </button>
                    </div>
                  </>
                )}
              </>
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
