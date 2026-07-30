import { useEffect, useState } from "react";
import {
  BotConfig,
  Channel,
  CustomCommand,
  ReactionRoleEntry,
  Role,
  createCustomCommand,
  createReactionRole,
  deleteCustomCommand,
  deleteReactionRole,
  getBotConfig,
  listRoles,
  updateBotSettings,
  uploadFile,
} from "./api";

function CustomCommandsList({
  baseUrl,
  token,
  commands,
  onChange,
}: {
  baseUrl: string;
  token: string;
  commands: CustomCommand[];
  onChange: () => void;
}) {
  const [trigger, setTrigger] = useState("");
  const [response, setResponse] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!trigger.trim() || !response.trim()) return;
    setError(null);
    try {
      await createCustomCommand(baseUrl, token, trigger.trim(), response.trim());
      setTrigger("");
      setResponse("");
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await deleteCustomCommand(baseUrl, token, id);
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="settings-section">
      <h3>Custom Commands</h3>
      <p className="subtitle">Members type "!trigger" in any text channel and the bot replies with the response.</p>
      {error && <p className="error">{error}</p>}
      <ul className="invite-list">
        {commands.map((c) => (
          <li key={c.id}>
            <div className="invite-row">
              <strong>!{c.trigger}</strong>
              <span className="invite-meta">{c.response}</span>
            </div>
            <button type="button" className="text-btn" onClick={() => handleDelete(c.id)}>
              delete
            </button>
          </li>
        ))}
        {commands.length === 0 && <p className="picker-empty">No custom commands yet.</p>}
      </ul>
      <form onSubmit={handleCreate} className="invite-new-form">
        <input placeholder="trigger (no !)" value={trigger} onChange={(e) => setTrigger(e.target.value)} />
        <input placeholder="response text" value={response} onChange={(e) => setResponse(e.target.value)} />
        <button type="submit" className="btn">
          Add
        </button>
      </form>
    </div>
  );
}

function ReactionRolesList({
  baseUrl,
  token,
  roles,
  entries,
  onChange,
}: {
  baseUrl: string;
  token: string;
  roles: Role[];
  entries: ReactionRoleEntry[];
  onChange: () => void;
}) {
  const [emoji, setEmoji] = useState("");
  const [roleId, setRoleId] = useState(roles[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!emoji.trim() || !roleId) return;
    setError(null);
    try {
      await createReactionRole(baseUrl, token, emoji.trim(), roleId);
      setEmoji("");
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await deleteReactionRole(baseUrl, token, id);
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="settings-section">
      <h3>Reaction Roles</h3>
      <p className="subtitle">
        The bot posts (and keeps edited in place) one standing message listing these — members react to it to get the role.
      </p>
      {error && <p className="error">{error}</p>}
      <ul className="invite-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <div className="invite-row">
              <strong>{entry.emoji}</strong>
              <span className="invite-meta">→ {entry.roleName}</span>
            </div>
            <button type="button" className="text-btn" onClick={() => handleDelete(entry.id)}>
              delete
            </button>
          </li>
        ))}
        {entries.length === 0 && <p className="picker-empty">No reaction roles yet.</p>}
      </ul>
      <form onSubmit={handleCreate} className="invite-new-form">
        <input className="bot-emoji-input" placeholder="emoji" value={emoji} onChange={(e) => setEmoji(e.target.value)} />
        <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <button type="submit" className="btn" disabled={roles.length === 0}>
          Add
        </button>
      </form>
    </div>
  );
}

export function BotSettingsPanel({ baseUrl, token, channels }: { baseUrl: string; token: string; channels: Channel[] }) {
  const textChannels = channels.filter((c) => c.type === "TEXT");
  const [config, setConfig] = useState<BotConfig | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);

  const [name, setName] = useState("");
  const [welcomeEnabled, setWelcomeEnabled] = useState(false);
  const [welcomeChannelId, setWelcomeChannelId] = useState("");
  const [welcomeMessage, setWelcomeMessage] = useState("");
  const [autoRoleEnabled, setAutoRoleEnabled] = useState(false);
  const [autoRoleId, setAutoRoleId] = useState("");
  const [customCommandsEnabled, setCustomCommandsEnabled] = useState(false);
  const [reactionRolesEnabled, setReactionRolesEnabled] = useState(false);
  const [reactionRoleChannelId, setReactionRoleChannelId] = useState("");
  const [levelingEnabled, setLevelingEnabled] = useState(false);
  const [levelUpAnnounce, setLevelUpAnnounce] = useState(true);
  const [levelUpMessage, setLevelUpMessage] = useState("");
  const [automodEnabled, setAutomodEnabled] = useState(false);
  const [automodWords, setAutomodWords] = useState("");

  function refresh() {
    Promise.all([getBotConfig(baseUrl, token), listRoles(baseUrl, token)])
      .then(([c, r]) => {
        setConfig(c);
        setRoles(r);
        setName(c.settings.name);
        setWelcomeEnabled(c.settings.welcomeEnabled);
        setWelcomeChannelId(c.settings.welcomeChannelId ?? "");
        setWelcomeMessage(c.settings.welcomeMessage);
        setAutoRoleEnabled(c.settings.autoRoleEnabled);
        setAutoRoleId(c.settings.autoRoleId ?? "");
        setCustomCommandsEnabled(c.settings.customCommandsEnabled);
        setReactionRolesEnabled(c.settings.reactionRolesEnabled);
        setReactionRoleChannelId(c.settings.reactionRoleChannelId ?? "");
        setLevelingEnabled(c.settings.levelingEnabled);
        setLevelUpAnnounce(c.settings.levelUpAnnounce);
        setLevelUpMessage(c.settings.levelUpMessage);
        setAutomodEnabled(c.settings.automodEnabled);
        setAutomodWords(c.settings.automodBannedWords.join(", "));
      })
      .catch((err) => setError(err.message));
  }

  useEffect(refresh, [baseUrl, token]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await updateBotSettings(baseUrl, token, {
        name,
        welcomeEnabled,
        welcomeChannelId: welcomeChannelId || null,
        welcomeMessage,
        autoRoleEnabled,
        autoRoleId: autoRoleId || null,
        customCommandsEnabled,
        reactionRolesEnabled,
        reactionRoleChannelId: reactionRoleChannelId || null,
        levelingEnabled,
        levelUpAnnounce,
        levelUpMessage,
        automodEnabled,
        automodBannedWords: automodWords
          .split(",")
          .map((w) => w.trim())
          .filter(Boolean),
      });
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleAvatarSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setAvatarUploading(true);
    try {
      const { url } = await uploadFile(baseUrl, token, file);
      await updateBotSettings(baseUrl, token, { avatarUrl: url });
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAvatarUploading(false);
    }
  }

  if (!config) {
    return <div className="settings-section">{error ? <p className="error">{error}</p> : <p className="picker-empty">Loading…</p>}</div>;
  }

  return (
    <div>
      <form className="settings-section" onSubmit={handleSave}>
        <div className="settings-avatar-row">
          {config.settings.avatarUrl ? (
            <img className="avatar avatar-lg" src={config.settings.avatarUrl} alt="" />
          ) : (
            <span className="avatar avatar-lg avatar-placeholder">{(name || "B")[0]?.toUpperCase()}</span>
          )}
          <label className="btn secondary">
            {avatarUploading ? "Uploading…" : "Change Bot Avatar"}
            <input type="file" accept="image/*" hidden onChange={handleAvatarSelect} disabled={avatarUploading} />
          </label>
        </div>
        <label>
          Bot Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
        </label>

        <h3>Welcome Messages</h3>
        <label className="checkbox-label">
          <input type="checkbox" checked={welcomeEnabled} onChange={(e) => setWelcomeEnabled(e.target.checked)} />
          Post a welcome message when someone new registers
        </label>
        {welcomeEnabled && (
          <>
            <label>
              Channel
              <select value={welcomeChannelId} onChange={(e) => setWelcomeChannelId(e.target.value)}>
                <option value="">select a channel…</option>
                {textChannels.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Message ({"{user}"} inserts their username)
              <textarea value={welcomeMessage} onChange={(e) => setWelcomeMessage(e.target.value)} rows={2} />
            </label>
          </>
        )}

        <h3>Auto-Role</h3>
        <label className="checkbox-label">
          <input type="checkbox" checked={autoRoleEnabled} onChange={(e) => setAutoRoleEnabled(e.target.checked)} />
          Automatically assign a role to new members
        </label>
        {autoRoleEnabled && (
          <label>
            Role
            <select value={autoRoleId} onChange={(e) => setAutoRoleId(e.target.value)}>
              <option value="">select a role…</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <h3>Custom Commands</h3>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={customCommandsEnabled}
            onChange={(e) => setCustomCommandsEnabled(e.target.checked)}
          />
          Enable "!trigger" commands (managed below)
        </label>

        <h3>Reaction Roles</h3>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={reactionRolesEnabled}
            onChange={(e) => setReactionRolesEnabled(e.target.checked)}
          />
          Post a reaction-role menu (managed below)
        </label>
        {reactionRolesEnabled && (
          <label>
            Channel
            <select value={reactionRoleChannelId} onChange={(e) => setReactionRoleChannelId(e.target.value)}>
              <option value="">select a channel…</option>
              {textChannels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <h3>Leveling / XP</h3>
        <label className="checkbox-label">
          <input type="checkbox" checked={levelingEnabled} onChange={(e) => setLevelingEnabled(e.target.checked)} />
          Track message activity and level members up — try !rank and !leaderboard
        </label>
        {levelingEnabled && (
          <>
            <label className="checkbox-label">
              <input type="checkbox" checked={levelUpAnnounce} onChange={(e) => setLevelUpAnnounce(e.target.checked)} />
              Announce level-ups in the channel
            </label>
            <label>
              Level-up message ({"{user}"}, {"{level}"})
              <input value={levelUpMessage} onChange={(e) => setLevelUpMessage(e.target.value)} />
            </label>
          </>
        )}

        <h3>Auto-Moderation</h3>
        <label className="checkbox-label">
          <input type="checkbox" checked={automodEnabled} onChange={(e) => setAutomodEnabled(e.target.checked)} />
          Block messages containing banned words
        </label>
        {automodEnabled && (
          <label>
            Banned words (comma-separated)
            <input value={automodWords} onChange={(e) => setAutomodWords(e.target.value)} placeholder="word1, word2, word3" />
          </label>
        )}

        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button type="submit" className="btn" disabled={saving}>
            {saving ? "Saving…" : "Save Bot Settings"}
          </button>
        </div>
      </form>

      <CustomCommandsList baseUrl={baseUrl} token={token} commands={config.customCommands} onChange={refresh} />
      <ReactionRolesList baseUrl={baseUrl} token={token} roles={roles} entries={config.reactionRoles} onChange={refresh} />
    </div>
  );
}
