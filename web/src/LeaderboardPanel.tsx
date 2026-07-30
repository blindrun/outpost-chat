import { useEffect, useState } from "react";
import { LeaderboardEntry, getLeaderboard } from "./api";
import { Modal } from "./Modal";

export function LeaderboardPanel({
  baseUrl,
  token,
  onClose,
}: {
  baseUrl: string;
  token: string;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getLeaderboard(baseUrl, token)
      .then(setEntries)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [baseUrl, token]);

  return (
    <Modal onClose={onClose}>
      <h2>🏆 Leaderboard</h2>
      <div className="search-results">
        {loading && <p className="picker-empty">Loading…</p>}
        {!loading && error && <p className="error">{error}</p>}
        {!loading && !error && entries.length === 0 && <p className="picker-empty">No one has earned any XP yet.</p>}
        {!loading &&
          !error &&
          entries.map((e, i) => (
            <div key={e.userId} className="leaderboard-row">
              <span className="leaderboard-rank">#{i + 1}</span>
              {e.avatarUrl ? (
                <img className="avatar" src={e.avatarUrl} alt="" />
              ) : (
                <span className="avatar avatar-placeholder">{e.username[0]?.toUpperCase()}</span>
              )}
              <span className="leaderboard-name">{e.username}</span>
              <span className="leaderboard-stats">
                Level {e.level} · {e.xp} XP · {e.messageCount} messages
              </span>
            </div>
          ))}
      </div>
    </Modal>
  );
}
