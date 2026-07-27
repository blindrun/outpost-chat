import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../plugins/db.js";

const registerSchema = z.object({
  username: z.string().min(3).max(32),
  email: z.string().email(),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const updateProfileSchema = z.object({
  username: z.string().min(3).max(32).optional(),
  email: z.string().email().optional(),
});

const updatePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8),
});

function toPublicUser(user: { id: string; username: string; email: string; avatarUrl: string | null }) {
  return { id: user.id, username: user.username, email: user.email, avatarUrl: user.avatarUrl };
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/register", async (req, reply) => {
    const body = registerSchema.parse(req.body);

    const existing = await prisma.user.findFirst({
      where: { OR: [{ email: body.email }, { username: body.username }] },
    });
    if (existing) {
      return reply.status(409).send({ error: "username or email already taken" });
    }

    const passwordHash = await bcrypt.hash(body.password, 12);
    const user = await prisma.user.create({
      data: { username: body.username, email: body.email, passwordHash },
    });

    const token = app.jwt.sign({ sub: user.id, username: user.username });
    return reply.status(201).send({ token, user: toPublicUser(user) });
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

  // Update username/email. Re-issues a JWT when the username changes, since
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
      data: { ...(body.username ? { username: body.username } : {}), ...(body.email ? { email: body.email } : {}) },
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
