// Thin Discord REST v10 wrapper for the one-time import tool
// (discordImport.ts). No new dependency — matches the existing pattern in
// routes/gifs.ts of calling an external API with native fetch rather than
// pulling in discord.js/undici/node-fetch for what's ultimately a handful
// of GET requests.

const DISCORD_API_BASE = "https://discord.com/api/v10";

export class DiscordAuthError extends Error {
  constructor() {
    super("Discord rejected the bot token — check it's correct and hasn't been regenerated.");
  }
}

export class DiscordAccessError extends Error {
  constructor() {
    super("The bot isn't in that server, or is missing permissions (needs View Channels + Read Message History).");
  }
}

export class DiscordNotFoundError extends Error {
  constructor() {
    super("That guild ID doesn't exist, or the bot can't see it.");
  }
}

interface DiscordChannel {
  id: string;
  type: number;
  name: string;
  parent_id: string | null;
  position: number;
}

interface DiscordRole {
  id: string;
  name: string;
  permissions: string;
  color: number;
  position: number;
}

interface DiscordEmoji {
  id: string;
  name: string;
  animated?: boolean;
}

interface DiscordMessage {
  id: string;
  content: string;
  timestamp: string;
  author: { id: string; username: string; global_name: string | null; avatar: string | null };
  attachments: { url: string; filename: string }[];
}

// Discord's own rate limit is generous enough for a one-time import
// (50 req/s global) that a simple sequential-with-retry loop is enough --
// no token-bucket scheduler needed for a job that only ever runs one guild
// at a time, once.
async function discordFetch<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${DISCORD_API_BASE}${path}`, {
    headers: { Authorization: `Bot ${token}` },
  });

  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
    const retryAfterMs = Math.ceil((body.retry_after ?? 1) * 1000);
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    return discordFetch<T>(token, path);
  }
  if (res.status === 401) throw new DiscordAuthError();
  if (res.status === 403) throw new DiscordAccessError();
  if (res.status === 404) throw new DiscordNotFoundError();
  if (!res.ok) throw new Error(`Discord API request failed: ${res.status}`);

  return res.json();
}

// Cheap validation ping before starting a real import — lets the route
// return a clear 400 on a bad token/guild instead of failing partway
// through channel creation.
export function getGuild(token: string, guildId: string) {
  return discordFetch<{ id: string; name: string }>(token, `/guilds/${guildId}`);
}

export function getGuildChannels(token: string, guildId: string) {
  return discordFetch<DiscordChannel[]>(token, `/guilds/${guildId}/channels`);
}

export function getGuildRoles(token: string, guildId: string) {
  return discordFetch<DiscordRole[]>(token, `/guilds/${guildId}/roles`);
}

export function getGuildEmojis(token: string, guildId: string) {
  return discordFetch<DiscordEmoji[]>(token, `/guilds/${guildId}/emojis`);
}

// Paginated, walking backward from the most recent message via `before`.
// Discord returns newest-first; the caller is responsible for reversing
// pages if oldest-first insertion order matters (it does here, so imported
// history sorts correctly).
export async function getChannelMessages(token: string, channelId: string, before?: string) {
  const query = before ? `?limit=100&before=${before}` : "?limit=100";
  return discordFetch<DiscordMessage[]>(token, `/channels/${channelId}/messages${query}`);
}

export function emojiCdnUrl(emoji: DiscordEmoji) {
  const ext = emoji.animated ? "gif" : "png";
  return `https://cdn.discordapp.com/emojis/${emoji.id}.${ext}`;
}

export function authorAvatarUrl(author: DiscordMessage["author"]) {
  if (!author.avatar) return null;
  const ext = author.avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.${ext}`;
}

export type { DiscordChannel, DiscordRole, DiscordEmoji, DiscordMessage };
