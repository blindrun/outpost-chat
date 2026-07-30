import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../plugins/db.js";
import { EVERYONE_ROLE_NAME, DEFAULT_EVERYONE_PERMISSIONS } from "../util/permissions.js";
import { isInviteValid } from "../util/invites.js";
import { postSystemMessage } from "../util/bot.js";
import { consumeClaimCode } from "../util/claim.js";

const registerSchema = z.object({
  username: z.string().min(3).max(32),
  email: z.string().email(),
  password: z.string().min(8),
  inviteCode: z.string().optional(),
  claimCode: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const updateProfileSchema = z.object({
  username: z.string().min(3).max(32).optional(),
  email: z.string().email().optional(),
  bio: z.string().max(240).nullable().optional(),
});

const updatePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8),
});

export function toPublicUser(user: {
  id: string;
  username: string;
  email: string;
  avatarUrl: string | null;
  bio: string | null;
  isOwner: boolean;
}) {
  return { id: user.id, username: user.username, email: user.email, avatarUrl: user.avatarUrl, bio: user.bio, isOwner: user.isOwner };
}

export async function authRoutes(app: FastifyInstance) {
  // Registration. The very first user on a fresh instance becomes its owner
  // and never needs an invite code — that same moment is also when we
  // bootstrap the instance itself (InstanceSettings singleton row, a default
  // "general" channel, the @everyone role). Every subsequent registrant is
  // gated by InstanceSettings.requireInviteToRegister, same as any other
  // self-hosted app's "invite-only" toggle.
  app.post("/auth/register", async (req, reply) => {
    const body = registerSchema.parse(req.body);

    const existing = await prisma.user.findFirst({
      where: { OR: [{ email: body.email }, { username: body.username }] },
    });
    if (existing) {
      return reply.status(409).send({ error: "username or email already taken" });
    }

    try {
      const { user, botSettings } = await prisma.$transaction(async (tx) => {
        const userCount = await tx.user.count();
        const passwordHash = await bcrypt.hash(body.password, 12);

        if (userCount === 0) {
          if (!(await consumeClaimCode(body.claimCode, tx))) {
            throw new Error("CLAIM_CODE_INVALID");
          }
          const created = await tx.user.create({
            data: { username: body.username, email: body.email, passwordHash, isOwner: true },
          });
          await tx.instanceSettings.upsert({
            where: { id: "singleton" },
            create: {},
            update: {},
          });
          await tx.botSettings.upsert({
            where: { id: "singleton" },
            create: {},
            update: {},
          });
          await tx.channel.create({ data: { name: "general", type: "TEXT" } });
          const everyoneRole = await tx.role.create({
            data: { name: EVERYONE_ROLE_NAME, permissions: DEFAULT_EVERYONE_PERMISSIONS },
          });
          await tx.userRole.create({ data: { userId: created.id, roleId: everyoneRole.id } });
          return { user: created, botSettings: null };
        }

        const settings = await tx.instanceSettings.upsert({
          where: { id: "singleton" },
          create: {},
          update: {},
        });
        if (settings.requireInviteToRegister) {
          if (!body.inviteCode) {
            throw new Error("INVITE_REQUIRED");
          }
          const invite = await tx.invite.findUnique({ where: { code: body.inviteCode } });
          if (!invite || !isInviteValid(invite)) {
            throw new Error("INVITE_INVALID");
          }
          await tx.invite.update({ where: { id: invite.id }, data: { uses: { increment: 1 } } });
        }

        const created = await tx.user.create({
          data: { username: body.username, email: body.email, passwordHash },
        });
        const everyoneRole = await tx.role.findFirst({ where: { name: EVERYONE_ROLE_NAME } });
        if (everyoneRole) {
          await tx.userRole.create({ data: { userId: created.id, roleId: everyoneRole.id } });
        }

        const bot = await tx.botSettings.upsert({ where: { id: "singleton" }, create: {}, update: {} });
        if (bot.autoRoleEnabled && bot.autoRoleId && bot.autoRoleId !== everyoneRole?.id) {
          const autoRole = await tx.role.findUnique({ where: { id: bot.autoRoleId } });
          if (autoRole) {
            await tx.userRole.create({ data: { userId: created.id, roleId: autoRole.id } });
          }
        }

        return { user: created, botSettings: bot };
      });

      // Deliberately outside the transaction — posting the welcome message
      // broadcasts over the live gateway, which isn't transactional and
      // shouldn't block/rollback registration if it fails.
      if (botSettings?.welcomeEnabled && botSettings.welcomeChannelId) {
        await postSystemMessage(
          botSettings.welcomeChannelId,
          botSettings.welcomeMessage.replaceAll("{user}", user.username),
        );
      }

      const token = app.jwt.sign({ sub: user.id, username: user.username });
      return reply.status(201).send({ token, user: toPublicUser(user) });
    } catch (err) {
      if (err instanceof Error && (err.message === "INVITE_REQUIRED" || err.message === "INVITE_INVALID")) {
        return reply.status(403).send({ error: "a valid invite code is required to register on this instance" });
      }
      if (err instanceof Error && err.message === "CLAIM_CODE_INVALID") {
        return reply
          .status(403)
          .send({ error: "invalid or missing claim code — check the server console output for this instance" });
      }
      throw err;
    }
  });

  app.post("/auth/login", async (req, reply) => {
    const body = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user) {
      return reply.status(401).send({ error: "invalid credentials" });
    }

    const valid = await bcrypt.compare(body.password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({ error: "invalid credentials" });
    }

    const token = app.jwt.sign({ sub: user.id, username: user.username });
    return reply.send({ token, user: toPublicUser(user) });
  });

  app.get("/auth/me", { onRequest: [app.authenticate] }, async (req) => {
    const { sub } = req.user as { sub: string };
    const user = await prisma.user.findUniqueOrThrow({ where: { id: sub } });
    return toPublicUser(user);
  });

  // Update username/email/bio. Re-issues a JWT when the username changes, since
  // the gateway reads `username` from the token at connect time (not a live
  // DB lookup) — the client is expected to swap in the new token and
  // reconnect so live broadcasts show the new name immediately.
  app.patch("/auth/me", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const body = updateProfileSchema.parse(req.body ?? {});

    if (body.username || body.email) {
      const existing = await prisma.user.findFirst({
        where: {
          id: { not: userId },
          OR: [...(body.username ? [{ username: body.username }] : []), ...(body.email ? [{ email: body.email }] : [])],
        },
      });
      if (existing) return reply.status(409).send({ error: "username or email already taken" });
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(body.username ? { username: body.username } : {}),
        ...(body.email ? { email: body.email } : {}),
        ...(body.bio !== undefined ? { bio: body.bio } : {}),
      },
    });

    const token = app.jwt.sign({ sub: user.id, username: user.username });
    return reply.send({ token, user: toPublicUser(user) });
  });

  app.patch("/auth/me/password", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const body = updatePasswordSchema.parse(req.body);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const valid = await bcrypt.compare(body.currentPassword, user.passwordHash);
    if (!valid) return reply.status(401).send({ error: "current password is incorrect" });

    const passwordHash = await bcrypt.hash(body.newPassword, 12);
    await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    return reply.status(204).send();
  });
}
