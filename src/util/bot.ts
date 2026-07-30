import { prisma } from "../plugins/db.js";
import { broadcastAll } from "../gateway/rooms.js";

export async function getBotSettings() {
  return prisma.botSettings.upsert({ where: { id: "singleton" }, create: {}, update: {} });
}

// Posts a message as the built-in bot (isSystemBot: true, no authorId/
// webhookId) and broadcasts it live — the one path every bot feature
// (welcome, custom commands, level-ups, the reaction-role menu) posts
// through, so they all show up with the same configurable name/avatar.
export async function postSystemMessage(channelId: string, content: string) {
  const [message, settings] = await Promise.all([
    prisma.message.create({ data: { channelId, content, isSystemBot: true } }),
    getBotSettings(),
  ]);
  broadcastAll({
    type: "MESSAGE_CREATE",
    message: { ...message, authorUsername: settings.name, authorAvatarUrl: settings.avatarUrl, isSystemBot: true },
  });
  return message;
}

async function editSystemMessage(messageId: string, content: string) {
  const [message, settings] = await Promise.all([
    prisma.message.update({ where: { id: messageId }, data: { content, editedAt: new Date() } }),
    getBotSettings(),
  ]);
  broadcastAll({
    type: "MESSAGE_UPDATE",
    message: { ...message, authorUsername: settings.name, authorAvatarUrl: settings.avatarUrl, isSystemBot: true },
  });
  return message;
}

async function renderReactionRoleMenu(channelId: string): Promise<string> {
  const entries = await prisma.reactionRole.findMany({
    where: { channelId },
    include: { role: true },
    orderBy: { createdAt: "asc" },
  });
  if (entries.length === 0) {
    return "React to a role below to get it! (no roles configured yet)";
  }
  const lines = entries.map((e) => `${e.emoji}  →  ${e.role.name}`);
  return `React with an emoji below to get that role:\n\n${lines.join("\n")}`;
}

// Called any time a reaction-role entry is added/removed for a channel.
// Edits that channel's one standing menu message in place rather than
// reposting, so the channel doesn't fill up with a fresh message every
// time an admin tweaks the list. Each channel gets its own independent
// menu (ReactionRoleMenu is keyed by channelId) rather than one
// instance-wide menu.
export async function refreshReactionRoleMenu(channelId: string) {
  const settings = await getBotSettings();
  if (!settings.reactionRolesEnabled) return;

  const content = await renderReactionRoleMenu(channelId);
  const existingMenu = await prisma.reactionRoleMenu.findUnique({ where: { channelId } });
  const existing = existingMenu ? await prisma.message.findUnique({ where: { id: existingMenu.messageId } }) : null;

  if (existing) {
    await editSystemMessage(existing.id, content);
    return;
  }

  const message = await postSystemMessage(channelId, content);
  await prisma.reactionRoleMenu.upsert({
    where: { channelId },
    create: { channelId, messageId: message.id },
    update: { messageId: message.id },
  });
}

// Automod pre-check — run before a message is persisted at all, so a
// blocked message never actually lands in the channel. Plain case-
// insensitive substring match, deliberately simple (no regex/word-boundary
// tuning) for a v1 word filter.
export async function isAutomodBlocked(content: string): Promise<boolean> {
  const settings = await getBotSettings();
  if (!settings.automodEnabled || settings.automodBannedWords.length === 0) return false;
  const lower = content.toLowerCase();
  return settings.automodBannedWords.some((word) => lower.includes(word.toLowerCase()));
}

const RANK_PATTERN = /^!rank$/i;
const LEADERBOARD_PATTERN = /^!leaderboard$/i;
const COMMAND_PATTERN = /^!([a-zA-Z0-9_-]+)$/;

// Runs everything that reacts to an already-persisted, already-broadcast
// user message: built-in !rank/!leaderboard, admin-defined custom commands,
// and leveling XP + level-up announcements. Called fire-and-forget by the
// gateway after its own MESSAGE_CREATE broadcast, so none of this can delay
// or fail the user's own message being sent.
export async function handlePostMessageBotHooks(channelId: string, userId: string, username: string, content: string) {
  const settings = await getBotSettings();
  const trimmed = content.trim();

  if (settings.levelingEnabled && RANK_PATTERN.test(trimmed)) {
    const level = await prisma.userLevel.findUnique({ where: { userId } });
    await postSystemMessage(
      channelId,
      level
        ? `${username} is level ${level.level} (${level.xp} XP, ${level.messageCount} messages).`
        : `${username} hasn't earned any XP yet — send a few messages!`,
    );
  } else if (settings.levelingEnabled && LEADERBOARD_PATTERN.test(trimmed)) {
    const top = await prisma.userLevel.findMany({ orderBy: { xp: "desc" }, take: 10 });
    if (top.length === 0) {
      await postSystemMessage(channelId, "No one has earned any XP yet.");
    } else {
      const users = await prisma.user.findMany({ where: { id: { in: top.map((t) => t.userId) } }, select: { id: true, username: true } });
      const nameById = new Map(users.map((u) => [u.id, u.username]));
      const lines = top.map((t, i) => `${i + 1}. ${nameById.get(t.userId) ?? "unknown"} — level ${t.level} (${t.xp} XP)`);
      await postSystemMessage(channelId, `**Leaderboard**\n${lines.join("\n")}`);
    }
  } else if (settings.customCommandsEnabled) {
    const match = COMMAND_PATTERN.exec(trimmed);
    if (match) {
      const command = await prisma.customCommand.findUnique({ where: { trigger: match[1].toLowerCase() } });
      if (command) await postSystemMessage(channelId, command.response);
    }
  }

  if (settings.levelingEnabled) {
    const leveledUp = await awardMessageXp(userId);
    if (leveledUp && settings.levelUpAnnounce) {
      await postSystemMessage(
        channelId,
        settings.levelUpMessage.replaceAll("{user}", username).replaceAll("{level}", String(leveledUp.level)),
      );
    }
  }
}

// Reactions only grant/revoke a role when they land on one of the bot's own
// standing reaction-role menu messages — reacting to any other message with
// the same emoji does nothing, same as Carl-bot scoping roles to one
// specific message rather than globally by emoji. Each channel has its own
// menu (and its own emoji namespace), so which menu this message belongs to
// determines which channel's ReactionRole entries apply.
export async function handleReactionRoleToggle(userId: string, messageId: string, emoji: string, add: boolean) {
  const settings = await getBotSettings();
  if (!settings.reactionRolesEnabled) return;

  const menu = await prisma.reactionRoleMenu.findFirst({ where: { messageId } });
  if (!menu) return;

  const reactionRole = await prisma.reactionRole.findUnique({
    where: { channelId_emoji: { channelId: menu.channelId, emoji } },
  });
  if (!reactionRole) return;

  if (add) {
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId, roleId: reactionRole.roleId } },
      create: { userId, roleId: reactionRole.roleId },
      update: {},
    });
  } else {
    await prisma.userRole.delete({ where: { userId_roleId: { userId, roleId: reactionRole.roleId } } }).catch(() => null);
  }
}

const XP_MIN = 15;
const XP_MAX = 25;
const XP_COOLDOWN_MS = 60_000;

function levelForXp(xp: number): number {
  return Math.floor(0.1 * Math.sqrt(xp));
}

// Awards XP for one message, subject to a 60s-per-user cooldown (so rapid
// back-to-back messages don't farm levels). Returns the new level if the
// user just leveled up this call, otherwise null.
export async function awardMessageXp(userId: string): Promise<{ level: number } | null> {
  const now = new Date();
  const existing = await prisma.userLevel.findUnique({ where: { userId } });

  if (existing?.lastXpAt && now.getTime() - existing.lastXpAt.getTime() < XP_COOLDOWN_MS) {
    await prisma.userLevel.update({ where: { userId }, data: { messageCount: { increment: 1 } } });
    return null;
  }

  const gain = XP_MIN + Math.floor(Math.random() * (XP_MAX - XP_MIN + 1));
  const newXp = (existing?.xp ?? 0) + gain;
  const newLevel = levelForXp(newXp);
  const leveledUp = newLevel > (existing?.level ?? 0);

  await prisma.userLevel.upsert({
    where: { userId },
    create: { userId, xp: newXp, level: newLevel, messageCount: 1, lastXpAt: now },
    update: { xp: newXp, level: newLevel, messageCount: { increment: 1 }, lastXpAt: now },
  });

  return leveledUp ? { level: newLevel } : null;
}
