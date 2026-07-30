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
  reactionRoleChannelId: z.string().nullable().optional(),
  levelingEnabled: z.boolean().optional(),
  levelUpAnnounce: z.boolean().optional(),
  levelUpMessage: z.string().min(1).max(500).optional(),
  automodEnabled: z.boolean().optional(),
  automodBannedWords: z.array(z.string().min(1).max(64)).max(200).optional(),
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
      prisma.reactionRole.findMany({ include: { role: true }, orderBy: { createdAt: "asc" } }),
    ]);

    return {
      settings,
      customCommands,
      reactionRoles: reactionRoles.map((r) => ({ id: r.id, emoji: r.emoji, roleId: r.roleId, roleName: r.role.name })),
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
    if (body.reactionRoleChannelId) {
      const channel = await prisma.channel.findUnique({ where: { id: body.reactionRoleChannelId } });
      if (!channel || channel.type !== "TEXT") {
        return reply.status(400).send({ error: "reactionRoleChannelId must be an existing text channel" });
      }
    }
    if (body.autoRoleId) {
      const role = await prisma.role.findUnique({ where: { id: body.autoRoleId } });
      if (!role) return reply.status(400).send({ error: "autoRoleId must be an existing role" });
    }

    await getBotSettings();
    const updated = await prisma.botSettings.update({ where: { id: "singleton" }, data: body });

    // The reaction-role channel or the enabled flag may have just changed —
    // (re)post the menu into wherever it now belongs.
    if (body.reactionRolesEnabled !== undefined || body.reactionRoleChannelId !== undefined) {
      await refreshReactionRoleMenu();
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

    const role = await prisma.role.findUnique({ where: { id: body.roleId } });
    if (!role) return reply.status(404).send({ error: "role not found" });

    const existing = await prisma.reactionRole.findUnique({ where: { emoji: body.emoji } });
    if (existing) return reply.status(409).send({ error: `${body.emoji} is already mapped to a role` });

    const created = await prisma.reactionRole.create({ data: body });
    await refreshReactionRoleMenu();
    return reply.status(201).send({ id: created.id, emoji: created.emoji, roleId: created.roleId, roleName: role.name });
  });

  app.delete("/bot/reaction-roles/:id", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    if (!(await requireOwner(userId))) {
      return reply.status(403).send({ error: "only the instance owner can manage reaction roles" });
    }
    const { id } = req.params as { id: string };
    await prisma.reactionRole.delete({ where: { id } }).catch(() => null);
    await refreshReactionRoleMenu();
    return reply.status(204).send();
  });
}
