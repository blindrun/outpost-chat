import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../plugins/db.js";
import { getBotSettings, refreshReactionRoleMenu } from "../util/bot.js";

const updateBotSettingsSchema = z.object({
  name: z.string().min(1).max(32).optional(),
  avatarUrl: z.string().url().nullable().optional(),
  welcomeEnabled: z.boolean().optional(),
  welcomeChannelId: z.string().nullable().optional(),
  welcomeMessage: z.string().min(1).max(500).optional(),
  autoRoleEnabled: z.boolean().optional(),
  autoRoleId: z.string().nullable().optional(),
  customCommandsEnabled: z.boolean().optional(),
  reactionRolesEnabled: z.boolean().optional(),
  levelingEnabled: z.boolean().optional(),
  levelUpAnnounce: z.boolean().optional(),
  levelUpMessage: z.string().min(1).max(500).optional(),
  automodEnabled: z.boolean().optional(),
  automodBannedWords: z.array(z.string().min(1).max(64)).max(200).optional(),
  automodWarnThreshold: z.number().int().min(1).max(20).optional(),
  automodMuteMinutes: z.number().int().min(1).max(10080).optional(),
});

const createCommandSchema = z.object({
  trigger: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-zA-Z0-9_-]+$/, "trigger can only contain letters, numbers, - and _")
    .transform((t) => t.toLowerCase()),
  response: z.string().min(1).max(2000),
});

const createReactionRoleSchema = z.object({
  channelId: z.string(),
  emoji: z.string().min(1).max(8),
  roleId: z.string(),
});

async function requireOwner(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  return !!user?.isOwner;
}

export async function botRoutes(app: FastifyInstance) {
  app.get("/bot/settings", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    if (!(await requireOwner(userId))) {
      return reply.status(403).send({ error: "only the instance owner can view bot settings" });
    }

    const [settings, customCommands, reactionRoles] = await Promise.all([
      getBotSettings(),
      prisma.customCommand.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.reactionRole.findMany({ include: { role: true, channel: true }, orderBy: { createdAt: "asc" } }),
    ]);

    return {
      settings,
      customCommands,
      reactionRoles: reactionRoles.map((r) => ({
        id: r.id,
        channelId: r.channelId,
        channelName: r.channel.name,
        emoji: r.emoji,
        roleId: r.roleId,
        roleName: r.role.name,
      })),
    };
  });

  app.patch("/bot/settings", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    if (!(await requireOwner(userId))) {
      return reply.status(403).send({ error: "only the instance owner can change bot settings" });
    }
    const body = updateBotSettingsSchema.parse(req.body ?? {});

    if (body.welcomeChannelId) {
      const channel = await prisma.channel.findUnique({ where: { id: body.welcomeChannelId } });
      if (!channel || channel.type !== "TEXT") {
        return reply.status(400).send({ error: "welcomeChannelId must be an existing text channel" });
      }
    }
    if (body.autoRoleId) {
      const role = await prisma.role.findUnique({ where: { id: body.autoRoleId } });
      if (!role) return reply.status(400).send({ error: "autoRoleId must be an existing role" });
    }

    await getBotSettings();
    const updated = await prisma.botSettings.update({ where: { id: "singleton" }, data: body });

    // Turning the master switch on (re)posts every channel's existing menu
    // — entries created while it was off still exist in the DB, they just
    // never had a message to render into.
    if (body.reactionRolesEnabled === true) {
      const channelIds = await prisma.reactionRole.findMany({
        distinct: ["channelId"],
        select: { channelId: true },
      });
      for (const { channelId } of channelIds) {
        await refreshReactionRoleMenu(channelId);
      }
    }

    return updated;
  });

  app.post("/bot/commands", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    if (!(await requireOwner(userId))) {
      return reply.status(403).send({ error: "only the instance owner can manage custom commands" });
    }
    const body = createCommandSchema.parse(req.body);

    const existing = await prisma.customCommand.findUnique({ where: { trigger: body.trigger } });
    if (existing) return reply.status(409).send({ error: `a command "!${body.trigger}" already exists` });

    const command = await prisma.customCommand.create({ data: body });
    return reply.status(201).send(command);
  });

  app.delete("/bot/commands/:id", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    if (!(await requireOwner(userId))) {
      return reply.status(403).send({ error: "only the instance owner can manage custom commands" });
    }
    const { id } = req.params as { id: string };
    await prisma.customCommand.delete({ where: { id } }).catch(() => null);
    return reply.status(204).send();
  });

  app.post("/bot/reaction-roles", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    if (!(await requireOwner(userId))) {
      return reply.status(403).send({ error: "only the instance owner can manage reaction roles" });
    }
    const body = createReactionRoleSchema.parse(req.body);

    const [role, channel] = await Promise.all([
      prisma.role.findUnique({ where: { id: body.roleId } }),
      prisma.channel.findUnique({ where: { id: body.channelId } }),
    ]);
    if (!role) return reply.status(404).send({ error: "role not found" });
    if (!channel || channel.type !== "TEXT") return reply.status(400).send({ error: "channelId must be an existing text channel" });

    const existing = await prisma.reactionRole.findUnique({
      where: { channelId_emoji: { channelId: body.channelId, emoji: body.emoji } },
    });
    if (existing) return reply.status(409).send({ error: `${body.emoji} is already mapped to a role in #${channel.name}` });

    const created = await prisma.reactionRole.create({ data: body });
    await refreshReactionRoleMenu(body.channelId);
    return reply.status(201).send({
      id: created.id,
      channelId: created.channelId,
      channelName: channel.name,
      emoji: created.emoji,
      roleId: created.roleId,
      roleName: role.name,
    });
  });

  app.delete("/bot/reaction-roles/:id", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    if (!(await requireOwner(userId))) {
      return reply.status(403).send({ error: "only the instance owner can manage reaction roles" });
    }
    const { id } = req.params as { id: string };
    const existing = await prisma.reactionRole.findUnique({ where: { id } });
    await prisma.reactionRole.delete({ where: { id } }).catch(() => null);
    if (existing) await refreshReactionRoleMenu(existing.channelId);
    return reply.status(204).send();
  });

  // Leaderboard — any authenticated member can view it (same reasoning as
  // the !leaderboard chat command it mirrors: leveling is a whole-instance
  // feature, not an admin-only view). Real UI equivalent of that text
  // command, not owner-gated like the rest of this file.
  app.get("/bot/leaderboard", { onRequest: [app.authenticate] }, async () => {
    const top = await prisma.userLevel.findMany({ orderBy: { xp: "desc" }, take: 50 });
    const users = await prisma.user.findMany({
      where: { id: { in: top.map((t) => t.userId) } },
      select: { id: true, username: true, avatarUrl: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));
    return top.map((t) => ({
      userId: t.userId,
      username: userById.get(t.userId)?.username ?? "unknown",
      avatarUrl: userById.get(t.userId)?.avatarUrl ?? null,
      level: t.level,
      xp: t.xp,
      messageCount: t.messageCount,
    }));
  });
}
