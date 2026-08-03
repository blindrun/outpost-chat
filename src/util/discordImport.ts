// One-time "import from Discord" job engine. Runs as an in-process async
// job (fire-and-forget from the route handler) -- no queue library exists
// in this app and none is needed for a single-admin, single-run operation.
// A module-level map holds live status so the route's GET endpoint can be
// polled; nothing here is persisted, which is fine since a page reload
// mid-import just means re-checking a jobId you already have, not losing
// the import itself (it keeps running server-side either way).

import { randomUUID, randomBytes } from "node:crypto";
import { prisma } from "../plugins/db.js";
import { minioClient, BUCKET, PUBLIC_URL } from "../plugins/storage.js";
import { broadcastChannelsUpdate } from "../gateway/channelBroadcast.js";
import { PERMISSIONS, type Permission } from "./permissions.js";
import {
  getGuildChannels,
  getGuildRoles,
  getGuildEmojis,
  getChannelMessages,
  emojiCdnUrl,
  authorAvatarUrl,
  type DiscordChannel,
  type DiscordEmoji,
} from "./discordApi.js";

export interface DiscordImportScope {
  importChannels: boolean;
  importRoles: boolean;
  importEmoji: boolean;
  importMessages: boolean;
}

export interface ImportJobStatus {
  phase: "channels" | "roles" | "emoji" | "messages" | "done";
  counts: { channels: number; roles: number; emoji: number; messages: number };
  skipped: string[];
  failed: string[];
  done: boolean;
  error: string | null;
}

const jobs = new Map<string, ImportJobStatus>();

export function getImportJob(jobId: string): ImportJobStatus | undefined {
  return jobs.get(jobId);
}

export function createImportJob(jobId: string) {
  jobs.set(jobId, {
    phase: "channels",
    counts: { channels: 0, roles: 0, emoji: 0, messages: 0 },
    skipped: [],
    failed: [],
    done: false,
    error: null,
  });
}

const DISCORD_CHANNEL_TYPE = { GUILD_TEXT: 0, GUILD_VOICE: 2, GUILD_CATEGORY: 4 } as const;

// Discord's permission bitfield -- only the bits this app has a matching
// Permission for. Everything else is intentionally dropped (a role with no
// matching bits still imports, just with no permissions -- name/color/
// position alone is still useful).
const DISCORD_PERM = {
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  MANAGE_MESSAGES: 1n << 13n,
  MANAGE_ROLES: 1n << 28n,
  MODERATE_MEMBERS: 1n << 40n,
};

function mapDiscordPermissions(bitfieldStr: string): Permission[] {
  const bits = BigInt(bitfieldStr);
  const permissions: Permission[] = [];
  const has = (bit: bigint) => (bits & bit) !== 0n;

  if (has(DISCORD_PERM.ADMINISTRATOR) || has(DISCORD_PERM.MANAGE_GUILD) || has(DISCORD_PERM.MANAGE_CHANNELS)) {
    permissions.push(PERMISSIONS.MANAGE_CHANNELS);
  }
  if (has(DISCORD_PERM.MANAGE_ROLES)) permissions.push(PERMISSIONS.MANAGE_ROLES);
  if (
    has(DISCORD_PERM.KICK_MEMBERS) ||
    has(DISCORD_PERM.BAN_MEMBERS) ||
    has(DISCORD_PERM.MANAGE_MESSAGES) ||
    has(DISCORD_PERM.MODERATE_MEMBERS)
  ) {
    permissions.push(PERMISSIONS.MODERATE_MEMBERS);
  }
  return permissions;
}

// category-id -> name map, so a text/voice channel's imported name can be
// prefixed with its category (Outpost has no category concept -- see the
// plan's "known limitations": this flattening is by design, not a bug).
function buildCategoryNameMap(channels: DiscordChannel[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of channels) {
    if (c.type === DISCORD_CHANNEL_TYPE.GUILD_CATEGORY) map.set(c.id, c.name);
  }
  return map;
}

function sanitizeChannelName(categoryName: string | undefined, channelName: string): string {
  const combined = categoryName ? `${categoryName}-${channelName}` : channelName;
  const cleaned = combined.replace(/\s+/g, "-").slice(0, 64);
  // Outpost's own createChannelSchema requires min(2) -- pad the rare
  // single-character Discord channel name rather than let channel
  // creation fail outright for it.
  return cleaned.length >= 2 ? cleaned : cleaned.padEnd(2, "-");
}

async function downloadToBuffer(url: string): Promise<{ buffer: Buffer; contentType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

async function rehostImage(importingUserId: string, url: string, filenameHint: string): Promise<string> {
  const { buffer, contentType } = await downloadToBuffer(url);
  const key = `${importingUserId}/${randomUUID()}-${filenameHint}`;
  await minioClient.putObject(BUCKET, key, buffer, buffer.length, { "Content-Type": contentType });
  return `${PUBLIC_URL}/${key}`;
}

export async function runDiscordImport(
  jobId: string,
  token: string,
  guildId: string,
  scope: DiscordImportScope,
  importingUserId: string,
) {
  const job = jobs.get(jobId);
  if (!job) return;

  // channelId -> imported Outpost channel id, needed so the message-import
  // phase knows where to insert (only TEXT channels get messages).
  const channelIdMap = new Map<string, string>();
  // Discord custom-emoji name -> imported, so message content can translate
  // <:name:id> into Outpost's :name: shortcode when it was actually
  // imported this run (left as literal text otherwise, per the plan).
  const importedEmojiNames = new Set<string>();

  try {
    let discordChannels: DiscordChannel[] = [];
    if (scope.importChannels || scope.importMessages) {
      discordChannels = await getGuildChannels(token, guildId);
    }

    if (scope.importChannels) {
      job.phase = "channels";
      const categoryNames = buildCategoryNameMap(discordChannels);
      for (const dc of discordChannels) {
        if (dc.type !== DISCORD_CHANNEL_TYPE.GUILD_TEXT && dc.type !== DISCORD_CHANNEL_TYPE.GUILD_VOICE) continue;
        try {
          const name = sanitizeChannelName(dc.parent_id ? categoryNames.get(dc.parent_id) : undefined, dc.name);
          const created = await prisma.channel.create({
            data: { name, type: dc.type === DISCORD_CHANNEL_TYPE.GUILD_VOICE ? "VOICE" : "TEXT" },
          });
          channelIdMap.set(dc.id, created.id);
          job.counts.channels++;
        } catch (err) {
          job.failed.push(`channel "${dc.name}": ${(err as Error).message}`);
        }
      }
      await broadcastChannelsUpdate().catch(() => {});
    }

    if (scope.importRoles) {
      job.phase = "roles";
      const discordRoles = await getGuildRoles(token, guildId);
      for (const dr of discordRoles) {
        // Discord's own @everyone role has the same id as the guild --
        // Outpost already auto-creates its own @everyone at first-user
        // registration, so skip rather than create a duplicate.
        if (dr.id === guildId) continue;
        try {
          await prisma.role.create({
            data: { name: dr.name, permissions: mapDiscordPermissions(dr.permissions) },
          });
          job.counts.roles++;
        } catch (err) {
          job.failed.push(`role "${dr.name}": ${(err as Error).message}`);
        }
      }
    }

    if (scope.importEmoji) {
      job.phase = "emoji";
      const discordEmoji = await getGuildEmojis(token, guildId);
      for (const de of discordEmoji) {
        try {
          await importOneEmoji(de, importingUserId);
          importedEmojiNames.add(de.name);
          job.counts.emoji++;
        } catch (err) {
          job.skipped.push(`emoji :${de.name}:: ${(err as Error).message}`);
        }
      }
    }

    if (scope.importMessages) {
      job.phase = "messages";
      for (const dc of discordChannels) {
        if (dc.type !== DISCORD_CHANNEL_TYPE.GUILD_TEXT) continue;
        const targetChannelId = channelIdMap.get(dc.id);
        if (!targetChannelId) continue; // channel import was off or that channel failed above

        const webhookByAuthorId = new Map<string, string>();
        const pages: Awaited<ReturnType<typeof getChannelMessages>>[] = [];
        let before: string | undefined;
        for (;;) {
          const page = await getChannelMessages(token, dc.id, before);
          if (page.length === 0) break;
          pages.push(page);
          before = page[page.length - 1].id;
          if (page.length < 100) break;
        }

        // Discord returns newest-first per page; replay oldest-first overall
        // so imported history sorts correctly alongside anything posted
        // natively afterward.
        const messagesOldestFirst = pages.flat().reverse();
        for (const dm of messagesOldestFirst) {
          if (!dm.content && dm.attachments.length === 0) continue;
          try {
            let webhookId = webhookByAuthorId.get(dm.author.id);
            if (!webhookId) {
              const displayName = dm.author.global_name ?? dm.author.username;
              const webhook = await prisma.webhook.create({
                data: {
                  channelId: targetChannelId,
                  name: `${displayName} (Discord Import)`,
                  avatarUrl: authorAvatarUrl(dm.author),
                  token: randomBytes(32).toString("hex"),
                  createdBy: importingUserId,
                },
              });
              webhookId = webhook.id;
              webhookByAuthorId.set(dm.author.id, webhookId);
            }

            let attachmentUrl: string | undefined;
            if (dm.attachments[0]) {
              // Discord attachment URLs are signed/expiring -- must be
              // re-hosted, unlike the author-avatar CDN links above.
              attachmentUrl = await rehostImage(importingUserId, dm.attachments[0].url, dm.attachments[0].filename);
            }

            const content = translateEmojiShortcodes(dm.content, importedEmojiNames);

            await prisma.message.create({
              data: {
                channelId: targetChannelId,
                webhookId,
                content: content || "(attachment)",
                attachmentUrl,
                createdAt: new Date(dm.timestamp),
              },
            });
            job.counts.messages++;
          } catch (err) {
            job.failed.push(`message in #${dc.name}: ${(err as Error).message}`);
          }
        }
      }
    }

    job.phase = "done";
    job.done = true;
  } catch (err) {
    job.error = (err as Error).message;
    job.done = true;
  }
}

async function importOneEmoji(de: DiscordEmoji, importingUserId: string) {
  const name = de.name.toLowerCase();
  if (!/^[a-z0-9_]{2,32}$/.test(name)) throw new Error("name doesn't fit Outpost's :name: pattern");
  const existing = await prisma.customEmoji.findUnique({ where: { name } });
  if (existing) throw new Error("name already exists on this instance");

  const imageUrl = await rehostImage(importingUserId, emojiCdnUrl(de), `${name}.${de.animated ? "gif" : "png"}`);
  await prisma.customEmoji.create({ data: { name, imageUrl, createdBy: importingUserId } });
}

// <:name:id> -> :name: only for emoji actually imported this run; anything
// else (an emoji import that was skipped, or importEmoji was off entirely)
// is left as literal text, per the plan's documented limitation.
function translateEmojiShortcodes(content: string, importedEmojiNames: Set<string>): string {
  return content.replace(/<a?:(\w+):(\d+)>/g, (match, name) => (importedEmojiNames.has(name) ? `:${name}:` : match));
}
