import { useEffect, useRef, useState } from "react";
import { SearchResult, searchMessages } from "./api";
import { Modal } from "./Modal";

function formatTimestamp(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function SearchPanel({
  baseUrl,
  token,
  currentChannelId,
  currentChannelName,
  onJump,
  onClose,
}: {
  baseUrl: string;
  token: string;
  currentChannelId: string | null;
  currentChannelName: string | null;
  onJump: (channelId: string) => void;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<"channel" | "all">(currentChannelId ? "channel" : "all");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }
    debounceRef.current = setTimeout(() => {
      setLoading(true);
      setError(null);
      searchMessages(baseUrl, token, query.trim(), scope === "channel" ? currentChannelId ?? undefined : undefined)
        .then((r) => {
          setResults(r);
          setSearched(true);
        })
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false));
    }, 350);
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, scope, currentChannelId]);

  return (
    <Modal onClose={onClose}>
      <h2>Search Messages</h2>
      <input
        className="picker-search"
        placeholder="Search message content…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      <div className="modal-tabs settings-tabs">
        <button className={scope === "channel" ? "active" : ""} onClick={() => setScope("channel")} disabled={!currentChannelId}>
          This Channel{currentChannelName ? ` (#${currentChannelName})` : ""}
        </button>
        <button className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>
          All Channels
        </button>
      </div>
      <div className="search-results">
        {loading && <p className="picker-empty">Searching…</p>}
        {!loading && error && <p className="error">{error}</p>}
        {!loading && !error && searched && results.length === 0 && <p className="picker-empty">No messages found</p>}
        {!loading &&
          !error &&
          results.map((r) => (
            <button
              key={r.id}
              type="button"
              className="search-result"
              onClick={() => {
                onJump(r.channelId);
                onClose();
              }}
            >
              <div className="search-result-meta">
                <span className="search-result-channel">#{r.channelName}</span>
                <span className="search-result-author">{r.authorUsername ?? "unknown"}</span>
                <span className="search-result-time">{formatTimestamp(r.createdAt)}</span>
              </div>
              <div className="search-result-content">{r.content}</div>
            </button>
          ))}
      </div>
    </Modal>
  );
}
