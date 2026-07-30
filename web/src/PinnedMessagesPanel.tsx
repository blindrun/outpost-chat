import { useEffect, useState } from "react";
import { Message, listPinnedMessages } from "./api";
import { Modal } from "./Modal";

function formatTimestamp(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function PinnedMessagesPanel({
  baseUrl,
  token,
  channelId,
  channelName,
  onClose,
}: {
  baseUrl: string;
  token: string;
  channelId: string;
  channelName: string;
  onClose: () => void;
}) {
  const [pins, setPins] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listPinnedMessages(baseUrl, token, channelId)
      .then(setPins)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [baseUrl, token, channelId]);

  return (
    <Modal onClose={onClose}>
      <h2>Pinned Messages — #{channelName}</h2>
      <div className="search-results">
        {loading && <p className="picker-empty">Loading…</p>}
        {!loading && error && <p className="error">{error}</p>}
        {!loading && !error && pins.length === 0 && <p className="picker-empty">No pinned messages yet</p>}
        {!loading &&
          !error &&
          pins.map((m) => (
            <div key={m.id} className="search-result search-result-static">
              <div className="search-result-meta">
                <span className="search-result-author">{m.authorUsername ?? "unknown"}</span>
                <span className="search-result-time">{formatTimestamp(m.createdAt)}</span>
              </div>
              <div className="search-result-content">{m.content || "(attachment)"}</div>
            </div>
          ))}
      </div>
    </Modal>
  );
}
