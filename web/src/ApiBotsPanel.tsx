import { useEffect, useState } from "react";
import { ApiBot, createApiBot, deleteApiBot, listApiBots, setApiBotRevoked } from "./api";

export function ApiBotsPanel({ baseUrl, token }: { baseUrl: string; token: string }) {
  const [bots, setBots] = useState<ApiBot[]>([]);
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The freshly-minted token for a just-created bot — shown once, never
  // refetchable afterward (JWTs aren't stored, see apiBots.ts), so this is
  // the only place it will ever be visible in the UI.
  const [revealedToken, setRevealedToken] = useState<{ botId: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

  function refresh() {
    listApiBots(baseUrl, token).then(setBots).catch((err) => setError(err.message));
  }

  useEffect(refresh, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim()) return;
    setError(null);
    try {
      const { bot, token: newToken } = await createApiBot(baseUrl, token, username.trim());
      setUsername("");
      setRevealedToken({ botId: bot.id, token: newToken });
      setCopied(false);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleToggleRevoke(bot: ApiBot) {
    try {
      await setApiBotRevoked(baseUrl, token, bot.id, !bot.revoked);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete(bot: ApiBot) {
    try {
      await deleteApiBot(baseUrl, token, bot.id);
      if (revealedToken?.botId === bot.id) setRevealedToken(null);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleCopyToken() {
    if (!revealedToken) return;
    try {
      await navigator.clipboard.writeText(revealedToken.token);
      setCopied(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="settings-section">
      <p className="subtitle">
        Bot accounts are real members with real roles and permissions, authenticated with a token instead of a
        password — the same REST API (and, if a script wants live events, the same gateway) any human client uses.
        Grant a bot a role to control what it can do, same as any other member.
      </p>
      {error && <p className="error">{error}</p>}
      <form onSubmit={handleCreate} className="invite-new-form">
        <input placeholder="bot username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <button type="submit" className="btn">
          New
        </button>
      </form>

      {revealedToken && (
        <div className="settings-section" style={{ background: "var(--bg-floating)", borderRadius: 6, padding: "0.6rem" }}>
          <p className="subtitle">
            This token won't be shown again — copy it now. Treat it like a password: anyone with it can act as this
            bot.
          </p>
          <div className="invite-row">
            <code className="inline-code" style={{ wordBreak: "break-all" }}>
              {revealedToken.token}
            </code>
            <button type="button" className="text-btn" onClick={handleCopyToken}>
              {copied ? "copied!" : "copy token"}
            </button>
          </div>
        </div>
      )}

      <ul className="invite-list">
        {bots.map((bot) => (
          <li key={bot.id}>
            <div className="invite-row">
              <strong>{bot.username}</strong>
              {bot.revoked && <span className="pinned-badge" title="Revoked">revoked</span>}
            </div>
            <button className="text-btn" onClick={() => handleToggleRevoke(bot)}>
              {bot.revoked ? "unrevoke" : "revoke"}
            </button>
            <button className="text-btn" onClick={() => handleDelete(bot)}>
              delete
            </button>
          </li>
        ))}
        {bots.length === 0 && <p className="picker-empty">No bot accounts yet.</p>}
      </ul>
    </div>
  );
}
