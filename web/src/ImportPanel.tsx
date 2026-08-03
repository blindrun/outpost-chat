import { useEffect, useRef, useState } from "react";
import { DiscordImportStatus, getDiscordImportStatus, startDiscordImport } from "./api";

export function ImportPanel({ baseUrl, token }: { baseUrl: string; token: string }) {
  const [botToken, setBotToken] = useState("");
  const [guildId, setGuildId] = useState("");
  const [importChannels, setImportChannels] = useState(true);
  const [importRoles, setImportRoles] = useState(true);
  const [importEmoji, setImportEmoji] = useState(true);
  const [importMessages, setImportMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<DiscordImportStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    if (!botToken.trim() || !guildId.trim()) return;
    setError(null);
    setStatus(null);
    try {
      const { jobId } = await startDiscordImport(baseUrl, token, {
        botToken: botToken.trim(),
        guildId: guildId.trim(),
        importChannels,
        importRoles,
        importEmoji,
        importMessages,
      });
      pollRef.current = setInterval(async () => {
        try {
          const s = await getDiscordImportStatus(baseUrl, token, jobId);
          setStatus(s);
          if (s.done && pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        } catch (err) {
          setError((err as Error).message);
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        }
      }, 2000);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const running = status !== null && !status.done;

  return (
    <div className="settings-section">
      <p className="subtitle">
        Point this at an existing Discord server to recreate its channels, roles, and emoji here — and optionally
        backfill its message history, attributed to a per-author webhook identity (not real accounts). This is
        meant to be run once, early, before real content accumulates here — re-running against a server that
        already has content will create duplicates, not merge.
      </p>
      <p className="subtitle">
        You'll need a Discord bot application (create one at discord.com/developers/applications), invited to the
        server with <strong>View Channels</strong> and <strong>Read Message History</strong> permissions. Enable
        the <strong>Message Content Intent</strong> under the bot's settings if you're importing message history.
      </p>

      {error && <p className="error">{error}</p>}

      <form onSubmit={handleStart}>
        <label>
          Bot Token
          <input
            type="password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder="Bot token"
            disabled={running}
          />
        </label>
        <label>
          Guild ID
          <input
            value={guildId}
            onChange={(e) => setGuildId(e.target.value)}
            placeholder="Discord server ID"
            disabled={running}
          />
        </label>

        <label className="checkbox-label">
          <input type="checkbox" checked={importChannels} onChange={(e) => setImportChannels(e.target.checked)} disabled={running} />
          Channels
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={importRoles} onChange={(e) => setImportRoles(e.target.checked)} disabled={running} />
          Roles
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={importEmoji} onChange={(e) => setImportEmoji(e.target.checked)} disabled={running} />
          Custom Emoji
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={importMessages} onChange={(e) => setImportMessages(e.target.checked)} disabled={running} />
          Message History
        </label>
        {importMessages && (
          <p className="subtitle">Can take a while for a large server, and is rate-limited by Discord's own API.</p>
        )}

        <button type="submit" className="btn" disabled={running}>
          {running ? "Importing…" : "Start Import"}
        </button>
      </form>

      {status && (
        <div className="settings-section" style={{ background: "var(--bg-floating)", borderRadius: 6, padding: "0.6rem" }}>
          <p>
            <strong>{status.done ? (status.error ? "Failed" : "Done") : `Importing: ${status.phase}…`}</strong>
          </p>
          {status.error && <p className="error">{status.error}</p>}
          <ul>
            <li>Channels: {status.counts.channels}</li>
            <li>Roles: {status.counts.roles}</li>
            <li>Emoji: {status.counts.emoji}</li>
            <li>Messages: {status.counts.messages}</li>
          </ul>
          {status.done && (status.skipped.length > 0 || status.failed.length > 0) && (
            <>
              {status.skipped.length > 0 && (
                <details>
                  <summary>{status.skipped.length} skipped</summary>
                  <ul>
                    {status.skipped.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </details>
              )}
              {status.failed.length > 0 && (
                <details>
                  <summary>{status.failed.length} failed</summary>
                  <ul>
                    {status.failed.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
