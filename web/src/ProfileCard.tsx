import { useEffect, useState } from "react";
import {
  FriendStatus,
  Member,
  Role,
  acceptFriendRequest,
  assignRole,
  banMember,
  declineFriendRequest,
  getFriendStatus,
  getMemberProfile,
  kickMember,
  muteMember,
  removeFriend,
  sendFriendRequest,
  unassignRole,
  unbanMember,
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
  onMessage,
  onMemberChanged,
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
  // Opens (or creates) a DM with this user and switches to it — only ever
  // called once friendStatus is "friends", same gate the backend enforces.
  onMessage: (userId: string) => void;
  // Tells the parent's member list sidebar to refetch — it only loads once
  // on mount otherwise, so without this a ban/role change made from here
  // wouldn't show up there until a full reload.
  onMemberChanged: () => void;
}) {
  const [profile, setProfile] = useState<Member | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modNotice, setModNotice] = useState<string | null>(null);
  const [warnReason, setWarnReason] = useState("");
  const [friendStatus, setFriendStatus] = useState<FriendStatus | null>(null);
  const [friendBusy, setFriendBusy] = useState(false);

  function refresh() {
    getMemberProfile(baseUrl, token, userId)
      .then(setProfile)
      .catch((err) => setError(err.message));
  }

  function refreshFriendStatus() {
    if (userId === currentUserId) return;
    getFriendStatus(baseUrl, token, userId)
      .then((r) => setFriendStatus(r.status))
      .catch(() => {});
  }

  useEffect(refresh, [baseUrl, token, userId]);
  useEffect(refreshFriendStatus, [baseUrl, token, userId, currentUserId]);

  const isSelf = userId === currentUserId;

  async function handleSendFriendRequest() {
    if (!profile) return;
    setError(null);
    setFriendBusy(true);
    try {
      await sendFriendRequest(baseUrl, token, profile.username);
      refreshFriendStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setFriendBusy(false);
    }
  }

  async function handleAcceptFriendRequest() {
    setError(null);
    setFriendBusy(true);
    try {
      await acceptFriendRequest(baseUrl, token, userId);
      refreshFriendStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setFriendBusy(false);
    }
  }

  async function handleDeclineFriendRequest() {
    setError(null);
    setFriendBusy(true);
    try {
      await declineFriendRequest(baseUrl, token, userId);
      refreshFriendStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setFriendBusy(false);
    }
  }

  async function handleRemoveFriend() {
    setError(null);
    setFriendBusy(true);
    try {
      await removeFriend(baseUrl, token, userId);
      refreshFriendStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setFriendBusy(false);
    }
  }

  async function toggleRole(roleId: string, has: boolean) {
    setError(null);
    try {
      if (has) await unassignRole(baseUrl, token, userId, roleId);
      else await assignRole(baseUrl, token, userId, roleId);
      refresh();
      onMemberChanged();
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

  // A momentary disruption (forces their live connection closed, account
  // stays valid) — no confirmation needed, matching this app's existing
  // pattern for reversible-ish moderator actions.
  async function handleKick() {
    setError(null);
    try {
      await kickMember(baseUrl, token, userId);
      setModNotice("Kicked — disconnected, but can log back in immediately.");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleBan() {
    setError(null);
    try {
      await banMember(baseUrl, token, userId);
      setModNotice("Banned — account disabled and disconnected.");
      refresh();
      onMemberChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleUnban() {
    setError(null);
    try {
      await unbanMember(baseUrl, token, userId);
      setModNotice("Unbanned.");
      refresh();
      onMemberChanged();
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
                {friendStatus === "friends" && (
                  <div className="mod-actions-row">
                    <button type="button" className="btn" onClick={() => onMessage(userId)}>
                      Message
                    </button>
                    <button type="button" className="btn secondary" onClick={handleRemoveFriend} disabled={friendBusy}>
                      Remove Friend
                    </button>
                  </div>
                )}
                {friendStatus === "none" && (
                  <button type="button" className="btn secondary" onClick={handleSendFriendRequest} disabled={friendBusy}>
                    {friendBusy ? "…" : "Add Friend"}
                  </button>
                )}
                {friendStatus === "pending_outgoing" && (
                  <button type="button" className="btn secondary" disabled>
                    Friend Request Sent
                  </button>
                )}
                {friendStatus === "pending_incoming" && (
                  <div className="mod-actions-row">
                    <button type="button" className="btn" onClick={handleAcceptFriendRequest} disabled={friendBusy}>
                      Accept Friend Request
                    </button>
                    <button type="button" className="btn secondary" onClick={handleDeclineFriendRequest} disabled={friendBusy}>
                      Decline
                    </button>
                  </div>
                )}

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
                    {profile.banned && <p className="error">Banned</p>}
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
                    <div className="mod-actions-row">
                      <button type="button" className="btn secondary" onClick={handleKick}>
                        Kick
                      </button>
                      {profile.banned ? (
                        <button type="button" className="btn secondary" onClick={handleUnban}>
                          Unban
                        </button>
                      ) : (
                        <button type="button" className="btn secondary danger" onClick={handleBan}>
                          Ban
                        </button>
                      )}
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
