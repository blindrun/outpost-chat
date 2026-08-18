import { useEffect, useState } from "react";
import {
  FriendsList,
  FriendUser,
  authedMediaUrl,
  listFriends,
  sendFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
  removeFriend,
  blockUser,
  unblockUser,
} from "./api";
import { Modal } from "./Modal";

function FriendRow({
  baseUrl,
  token,
  user,
  unread,
  children,
}: {
  baseUrl: string;
  token: string;
  user: FriendUser;
  unread?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="member-row">
      {user.avatarUrl ? (
        <img className="avatar" src={authedMediaUrl(user.avatarUrl, baseUrl, token)} alt="" />
      ) : (
        <span className="avatar avatar-placeholder">{user.username[0]?.toUpperCase()}</span>
      )}
      <span className="member-username">{user.username}</span>
      {unread && <span className="presence-dot online" title="Unread messages" />}
      <span className={`presence-dot ${user.online ? "online" : ""}`} title={user.online ? "Online" : "Offline"} />
      {children}
    </li>
  );
}

// refreshKey bumps whenever a live gateway friend event lands (see App.tsx)
// so the panel re-fetches instead of going stale while open.
export function FriendsPanel({
  baseUrl,
  token,
  refreshKey,
  onListLoaded,
  unreadFriendUserIds,
  onMessage,
  onClose,
}: {
  baseUrl: string;
  token: string;
  refreshKey: number;
  // Lets the button outside this panel drop its dot the instant a request is
  // accepted or declined. The gateway event for those goes to the *other*
  // party, so waiting on one would leave a stale dot on this client.
  onListLoaded: (list: FriendsList) => void;
  unreadFriendUserIds: Set<string>;
  onMessage: (userId: string) => void;
  onClose: () => void;
}) {
  const [list, setList] = useState<FriendsList | null>(null);
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function refresh() {
    listFriends(baseUrl, token)
      .then((l) => {
        setList(l);
        onListLoaded(l);
      })
      .catch((err) => setError(err.message));
  }

  useEffect(refresh, [baseUrl, token, refreshKey]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleAddFriend(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim()) return;
    setError(null);
    setNotice(null);
    try {
      await sendFriendRequest(baseUrl, token, username.trim());
      setNotice(`Friend request sent to ${username.trim()}.`);
      setUsername("");
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2>Friends</h2>

      <form onSubmit={handleAddFriend} className="new-channel-form friends-add-form">
        <input
          placeholder="Add a friend by username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <button type="submit" className="btn">
          Send Request
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {notice && <p className="picker-empty">{notice}</p>}

      {!list && <p className="picker-empty">Loading…</p>}

      {list && list.incoming.length > 0 && (
        <>
          <h3>Friend Requests</h3>
          <ul className="member-list">
            {list.incoming.map((u) => (
              <FriendRow key={u.userId} baseUrl={baseUrl} token={token} user={u}>
                <button className="text-btn" onClick={() => run(() => acceptFriendRequest(baseUrl, token, u.userId))}>
                  accept
                </button>
                <button className="text-btn" onClick={() => run(() => declineFriendRequest(baseUrl, token, u.userId))}>
                  decline
                </button>
              </FriendRow>
            ))}
          </ul>
        </>
      )}

      {list && list.outgoing.length > 0 && (
        <>
          <h3>Sent Requests</h3>
          <ul className="member-list">
            {list.outgoing.map((u) => (
              <FriendRow key={u.userId} baseUrl={baseUrl} token={token} user={u}>
                <button className="text-btn" onClick={() => run(() => removeFriend(baseUrl, token, u.userId))}>
                  cancel
                </button>
              </FriendRow>
            ))}
          </ul>
        </>
      )}

      {list && (
        <>
          <h3>Friends{list.friends.length > 0 ? ` — ${list.friends.length}` : ""}</h3>
          {list.friends.length === 0 ? (
            <p className="picker-empty">No friends yet — add one above.</p>
          ) : (
            <ul className="member-list">
              {list.friends.map((u) => (
                <FriendRow key={u.userId} baseUrl={baseUrl} token={token} user={u} unread={unreadFriendUserIds.has(u.userId)}>
                  <button className="text-btn" onClick={() => onMessage(u.userId)}>
                    message
                  </button>
                  <button className="text-btn" onClick={() => run(() => removeFriend(baseUrl, token, u.userId))}>
                    remove
                  </button>
                  <button className="text-btn danger" onClick={() => run(() => blockUser(baseUrl, token, u.userId))}>
                    block
                  </button>
                </FriendRow>
              ))}
            </ul>
          )}
        </>
      )}

      {list && list.blocked.length > 0 && (
        <>
          <h3>Blocked</h3>
          <ul className="member-list">
            {list.blocked.map((u) => (
              <li key={u.userId} className="member-row banned">
                {u.avatarUrl ? (
                  <img className="avatar" src={authedMediaUrl(u.avatarUrl, baseUrl, token)} alt="" />
                ) : (
                  <span className="avatar avatar-placeholder">{u.username[0]?.toUpperCase()}</span>
                )}
                <span className="member-username">{u.username}</span>
                <button className="text-btn" onClick={() => run(() => unblockUser(baseUrl, token, u.userId))}>
                  unblock
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}
