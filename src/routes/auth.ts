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
    return reply.status(201).send({
      token,
      user: { id: user.id, username: user.username, email: user.email },
    });
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
    return reply.send({
      token,
      user: { id: user.id, username: user.username, email: user.email },
    });
  });

  app.get("/auth/me", { onRequest: [app.authenticate] }, async (req) => {
    const { sub } = req.user as { sub: string };
    const user = await prisma.user.findUniqueOrThrow({ where: { id: sub } });
    return { id: user.id, username: user.username, email: user.email };
  });
}
