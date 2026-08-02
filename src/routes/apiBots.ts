import type { FastifyInstance } from "fastify";
import { randomUUID, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../plugins/db.js";
import { hasPermission, PERMISSIONS, EVERYONE_ROLE_NAME } from "../util/permissions.js";

const createApiBotSchema = z.object({
  username: z.string().min(3).max(32),
});

function publicApiBot(bot: { id: string; username: string; avatarUrl: string | null; banned: boolean; createdAt: Date }) {
  return { id: bot.id, username: bot.username, avatarUrl: bot.avatarUrl, revoked: bot.banned, createdAt: bot.createdAt };
}

// Developer/bot accounts: a real User row (isBot: true) with real
// roles/permissions, whose credential is a normal never-expiring JWT
// issued once at creation time — the same token format and REST API a
// human session uses, not a new auth scheme. This is deliberately the
// "at minimum a bot account type + token auth + a subset of the REST API
// usable programmatically" half of bot support that webhooks (one-way,
// no login) don't cover. A bot can also open a real gateway connection
// with its token exactly like any client, if a script wants live events
// rather than just REST polling.
export async function apiBotRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  async function requireManageChannels(req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) {
    const { sub: userId } = req.user as { sub: string };
    if (!(await hasPermission(userId, PERMISSIONS.MANAGE_CHANNELS))) {
      reply.status(403).send({ error: "missing MANAGE_CHANNELS permission" });
      return false;
    }
    return true;
  }

  app.get("/api-bots", async (req, reply) => {
    if (!(await requireManageChannels(req, reply))) return;
    const bots = await prisma.user.findMany({ where: { isBot: true }, orderBy: { createdAt: "asc" } });
    return bots.map(publicApiBot);
  });

  app.post("/api-bots", async (req, reply) => {
    if (!(await requireManageChannels(req, reply))) return;
    const { username } = createApiBotSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) {
      return reply.status(409).send({ error: "that username is already taken" });
    }

    // Never-usable credentials — a bot account only ever authenticates via
    // its issued JWT, never a login form. A random, never-stored password
    // makes the normal login path fail naturally; isBot is also checked
    // explicitly in POST /auth/login as a defensive second layer.
    const passwordHash = await bcrypt.hash(randomBytes(32).toString("hex"), 12);
    const email = `bot-${randomUUID()}@outpost.invalid`;

    const bot = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({ data: { username, email, passwordHash, isBot: true } });
      const everyoneRole = await tx.role.findFirst({ where: { name: EVERYONE_ROLE_NAME } });
      if (everyoneRole) {
        await tx.userRole.create({ data: { userId: created.id, roleId: everyoneRole.id } });
      }
      return created;
    });

    // Shown exactly once — JWTs aren't stored anywhere (they're stateless),
    // so there is no way to redisplay this later, same limitation a human
    // session token already has. Losing it means creating a new bot.
    const token = app.jwt.sign({ sub: bot.id, username: bot.username });
    return reply.status(201).send({ bot: publicApiBot(bot), token });
  });

  app.patch("/api-bots/:id", async (req, reply) => {
    if (!(await requireManageChannels(req, reply))) return;
    const { id } = req.params as { id: string };
    const { revoked } = z.object({ revoked: z.boolean() }).parse(req.body);

    const bot = await prisma.user.findUnique({ where: { id } });
    if (!bot || !bot.isBot) {
      return reply.status(404).send({ error: "bot not found" });
    }

    const updated = await prisma.user.update({ where: { id }, data: { banned: revoked } });
    return publicApiBot(updated);
  });

  app.delete("/api-bots/:id", async (req, reply) => {
    if (!(await requireManageChannels(req, reply))) return;
    const { id } = req.params as { id: string };

    const bot = await prisma.user.findUnique({ where: { id } });
    if (!bot || !bot.isBot) {
      return reply.status(404).send({ error: "bot not found" });
    }

    // No FK relation from Message.authorId to User (see messages.ts), so
    // this doesn't cascade-delete the bot's message history — they stay,
    // same graceful "unknown user" degradation already used elsewhere for
    // an authorId that no longer resolves to a real account.
    await prisma.user.delete({ where: { id } });
    return reply.status(204).send();
  });
}
