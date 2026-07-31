import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../plugins/db.js";
import { PERMISSIONS, hasPermission } from "../util/permissions.js";
import { recordWarning } from "../util/bot.js";
import { disconnectUser } from "../gateway/rooms.js";

const warnSchema = z.object({
  reason: z.string().min(1).max(500),
});

const muteSchema = z.object({
  minutes: z.number().int().min(1).max(60 * 24 * 7),
  reason: z.string().min(1).max(500).optional(),
});

async function requireModerator(userId: string) {
  return hasPermission(userId, PERMISSIONS.MODERATE_MEMBERS);
}

// Manual moderator actions — the same warning/mute machinery automod uses
// under the hood (recordWarning), so a manual warn counts toward the same
// rolling-window auto-mute threshold as an automod one.
export async function moderationRoutes(app: FastifyInstance) {
  app.get("/moderation/warnings/:userId", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: requesterId } = req.user as { sub: string };
    if (!(await requireModerator(requesterId))) {
      return reply.status(403).send({ error: "missing MODERATE_MEMBERS permission" });
    }
    const { userId } = req.params as { userId: string };
    const warnings = await prisma.warning.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return warnings;
  });

  app.post("/moderation/:userId/warn", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: requesterId } = req.user as { sub: string };
    if (!(await requireModerator(requesterId))) {
      return reply.status(403).send({ error: "missing MODERATE_MEMBERS permission" });
    }
    const { userId } = req.params as { userId: string };
    const target = await prisma.user.findUnique({ where: { id: userId } });
    if (!target) return reply.status(404).send({ error: "member not found" });

    const body = warnSchema.parse(req.body);
    const result = await recordWarning(userId, body.reason, "manual", requesterId);
    return result;
  });

  app.post("/moderation/:userId/mute", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: requesterId } = req.user as { sub: string };
    if (!(await requireModerator(requesterId))) {
      return reply.status(403).send({ error: "missing MODERATE_MEMBERS permission" });
    }
    const { userId } = req.params as { userId: string };
    const target = await prisma.user.findUnique({ where: { id: userId } });
    if (!target) return reply.status(404).send({ error: "member not found" });

    const body = muteSchema.parse(req.body);
    const mutedUntil = new Date(Date.now() + body.minutes * 60_000);
    await prisma.user.update({ where: { id: userId }, data: { mutedUntil } });
    if (body.reason) {
      await prisma.warning.create({
        data: { userId, reason: body.reason, source: "manual", moderatorId: requesterId },
      });
    }
    return { mutedUntil };
  });

  app.post("/moderation/:userId/unmute", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: requesterId } = req.user as { sub: string };
    if (!(await requireModerator(requesterId))) {
      return reply.status(403).send({ error: "missing MODERATE_MEMBERS permission" });
    }
    const { userId } = req.params as { userId: string };
    await prisma.user.update({ where: { id: userId }, data: { mutedUntil: null } }).catch(() => null);
    return reply.status(204).send();
  });

  // A momentary disruption, not a lockout — forces their live gateway
  // connection(s) closed, but their account and JWT stay valid, so
  // reconnecting works immediately. The lighter of the two actions.
  app.post("/moderation/:userId/kick", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: requesterId } = req.user as { sub: string };
    if (!(await requireModerator(requesterId))) {
      return reply.status(403).send({ error: "missing MODERATE_MEMBERS permission" });
    }
    const { userId } = req.params as { userId: string };
    const target = await prisma.user.findUnique({ where: { id: userId } });
    if (!target) return reply.status(404).send({ error: "member not found" });
    if (target.isOwner) return reply.status(400).send({ error: "cannot kick the instance owner" });

    disconnectUser(userId, "kicked");
    return reply.status(204).send();
  });

  app.post("/moderation/:userId/ban", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: requesterId } = req.user as { sub: string };
    if (!(await requireModerator(requesterId))) {
      return reply.status(403).send({ error: "missing MODERATE_MEMBERS permission" });
    }
    const { userId } = req.params as { userId: string };
    const target = await prisma.user.findUnique({ where: { id: userId } });
    if (!target) return reply.status(404).send({ error: "member not found" });
    if (target.isOwner) return reply.status(400).send({ error: "cannot ban the instance owner" });

    await prisma.user.update({ where: { id: userId }, data: { banned: true } });
    disconnectUser(userId, "banned");
    return reply.status(204).send();
  });

  app.post("/moderation/:userId/unban", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: requesterId } = req.user as { sub: string };
    if (!(await requireModerator(requesterId))) {
      return reply.status(403).send({ error: "missing MODERATE_MEMBERS permission" });
    }
    const { userId } = req.params as { userId: string };
    await prisma.user.update({ where: { id: userId }, data: { banned: false } }).catch(() => null);
    return reply.status(204).send();
  });
}
