import { useEffect, useState } from "react";
import { Channel, Webhook, createWebhook, deleteWebhook, listWebhooks } from "./api";

export function WebhooksPanel({ baseUrl, token, channels }: { baseUrl: string; token: string; channels: Channel[] }) {
  const textChannels = channels.filter((c) => c.type === "TEXT");
  const [channelId, setChannelId] = useState(textChannels[0]?.id ?? "");
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  function refresh() {
    if (!channelId) return;
    listWebhooks(baseUrl, token, channelId).then(setWebhooks).catch((err) => setError(err.message));
  }

  useEffect(refresh, [channelId]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !channelId) return;
    setError(null);
    try {
      await createWebhook(baseUrl, token, channelId, name.trim());
      setName("");
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteWebhook(baseUrl, token, id);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleCopy(webhook: Webhook) {
    const url = `${baseUrl}/webhooks/${webhook.id}/${webhook.token}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(webhook.id);
      setTimeout(() => setCopiedId((id) => (id === webhook.id ? null : id)), 1500);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="settings-section">
      <p className="subtitle">
        Webhooks let external services or bots post messages into a channel with a plain HTTP POST — no bot process
        or login required. Anyone with the URL can post as this webhook, so treat it like a password.
      </p>
      <label>
        Channel
        <select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
          {textChannels.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="error">{error}</p>}
      <form onSubmit={handleCreate} className="invite-new-form">
        <input placeholder="webhook name" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn">
          New
        </button>
      </form>
      <ul className="invite-list">
        {webhooks.map((w) => (
          <li key={w.id}>
            <div className="invite-row">
              <strong>{w.name}</strong>
              <button type="button" className="text-btn" onClick={() => handleCopy(w)}>
                {copiedId === w.id ? "copied!" : "copy POST URL"}
              </button>
            </div>
            <button className="text-btn" onClick={() => handleDelete(w.id)}>
              revoke
            </button>
          </li>
        ))}
        {textChannels.length === 0 && <p className="picker-empty">No text channels to attach a webhook to.</p>}
      </ul>
    </div>
  );
}
