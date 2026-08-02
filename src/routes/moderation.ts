import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import bcrypt from "bcryptjs";
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

function logModerationAction(action: string, actorId: string, targetId: string, detail?: string) {
  return prisma.moderationLogEntry.create({ data: { action, actorId, targetId, detail } });
}

// Excludes visually ambiguous characters (0/O, 1/I/L), same alphabet as the
// instance claim code (see util/claim.ts) — this gets read off screen and
// relayed to the member out-of-band (DM, voice call), so it has to be easy
// to transcribe correctly.
const TEMP_PASSWORD_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateTempPassword(): string {
  const bytes = randomBytes(16);
  let out = "";
  for (const b of bytes) out += TEMP_PASSWORD_ALPHABET[b % TEMP_PASSWORD_ALPHABET.length];
  return out;
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
    await logModerationAction("mute", requesterId, userId, `${body.minutes}m${body.reason ? `: ${body.reason}` : ""}`);
    return { mutedUntil };
  });

  app.post("/moderation/:userId/unmute", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: requesterId } = req.user as { sub: string };
    if (!(await requireModerator(requesterId))) {
      return reply.status(403).send({ error: "missing MODERATE_MEMBERS permission" });
    }
    const { userId } = req.params as { userId: string };
    await prisma.user.update({ where: { id: userId }, data: { mutedUntil: null } }).catch(() => null);
    await logModerationAction("unmute", requesterId, userId);
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
    await logModerationAction("kick", requesterId, userId);
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
    await logModerationAction("ban", requesterId, userId);
    return reply.status(204).send();
  });

  app.post("/moderation/:userId/unban", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: requesterId } = req.user as { sub: string };
    if (!(await requireModerator(requesterId))) {
      return reply.status(403).send({ error: "missing MODERATE_MEMBERS permission" });
    }
    const { userId } = req.params as { userId: string };
    await prisma.user.update({ where: { id: userId }, data: { banned: false } }).catch(() => null);
    await logModerationAction("unban", requesterId, userId);
    return reply.status(204).send();
  });

  // Before this, a member who forgot their password had no recovery path
  // at all — PATCH /auth/me/password requires knowing the *current*
  // password, and this app has no email infrastructure to build a real
  // self-service "forgot password" flow against (no SMTP anywhere in
  // deploy/). Deliberately gated to the instance owner specifically, not
  // just MODERATE_MEMBERS like the rest of this file — resetting someone's
  // password is effectively full account takeover (their DMs, their
  // identity), a materially bigger blast radius than a kick/mute/ban, so
  // it gets the instance's highest trust level, not a grantable role
  // permission. Returns the new temp password once (never stored,
  // matching the bot-token/webhook-URL "shown once" precedent elsewhere in
  // this app) — the owner relays it to the member out-of-band. Doesn't
  // force a change on next login (no such mechanism exists in this app for
  // anything, including the owner's own account) or invalidate the
  // member's already-issued JWTs (this app's tokens never expire and
  // aren't tied to the password hash at all — same limitation the
  // member's own self-service password change already has).
  app.post("/moderation/:userId/reset-password", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: requesterId } = req.user as { sub: string };
    const requester = await prisma.user.findUnique({ where: { id: requesterId }, select: { isOwner: true } });
    if (!requester?.isOwner) {
      return reply.status(403).send({ error: "only the instance owner can reset a member's password" });
    }
    const { userId } = req.params as { userId: string };
    const target = await prisma.user.findUnique({ where: { id: userId } });
    if (!target) return reply.status(404).send({ error: "member not found" });
    if (target.isOwner) return reply.status(400).send({ error: "use your own account settings to change your password" });
    if (target.isBot) return reply.status(400).send({ error: "bot accounts don't have passwords — see API Bots" });

    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    await logModerationAction("reset_password", requesterId, userId);
    return { tempPassword };
  });

  // Visible to anyone with MODERATE_MEMBERS (same gate as performing these
  // actions) — a real audit log that only some moderators can see isn't
  // much of an accountability mechanism. usernameById is included so the
  // client doesn't have to cross-reference GET /members separately, and
  // still degrades gracefully ("unknown user") for an actor/target account
  // that's since been deleted, matching this app's existing pattern for a
  // dangling authorId on an old message.
  app.get("/moderation/audit-log", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: requesterId } = req.user as { sub: string };
    if (!(await requireModerator(requesterId))) {
      return reply.status(403).send({ error: "missing MODERATE_MEMBERS permission" });
    }
    const entries = await prisma.moderationLogEntry.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const userIds = [...new Set(entries.flatMap((e) => [e.actorId, e.targetId]))];
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } });
    const usernameById = Object.fromEntries(users.map((u) => [u.id, u.username]));
    return entries.map((e) => ({
      id: e.id,
      action: e.action,
      actorId: e.actorId,
      actorUsername: usernameById[e.actorId] ?? "unknown user",
      targetId: e.targetId,
      targetUsername: usernameById[e.targetId] ?? "unknown user",
      detail: e.detail,
      createdAt: e.createdAt,
    }));
  });
}
