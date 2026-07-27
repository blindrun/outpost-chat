import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../plugins/db.js";

const createServerSchema = z.object({
  name: z.string().min(2).max(64),
});

const createChannelSchema = z.object({
  name: z.string().min(2).max(64),
  type: z.enum(["TEXT", "VOICE"]).default("TEXT"),
});

export async function serverRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  // Create a server. Owner is auto-joined and gets a default "general" text channel.
  app.post("/servers", async (req, reply) => {
    const body = createServerSchema.parse(req.body);
    const { sub: userId } = req.user as { sub: string };

    const server = await prisma.server.create({
      data: {
        name: body.name,
        ownerId: userId,
        memberships: { create: { userId } },
        channels: { create: { name: "general", type: "TEXT" } },
      },
      include: { channels: true },
    });

    return reply.status(201).send(server);
  });

  // List servers the current user belongs to.
  app.get("/servers", async (req) => {
    const { sub: userId } = req.user as { sub: string };
    const memberships = await prisma.membership.findMany({
      where: { userId },
      include: { server: { include: { channels: true } } },
    });
    return memberships.map((m) => m.server);
  });

  // Join an existing server by id (no invite-code system yet).
  app.post("/servers/:serverId/join", async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const { sub: userId } = req.user as { sub: string };

    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) return reply.status(404).send({ error: "server not found" });

    const membership = await prisma.membership.upsert({
      where: { userId_serverId: { userId, serverId } },
      create: { userId, serverId },
      update: {},
    });
    return membership;
  });

  // Create a channel in a server the user belongs to.
  app.post("/servers/:serverId/channels", async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const { sub: userId } = req.user as { sub: string };
    const body = createChannelSchema.parse(req.body);

    const membership = await prisma.membership.findUnique({
      where: { userId_serverId: { userId, serverId } },
    });
    if (!membership) return reply.status(403).send({ error: "not a member of this server" });

    const channel = await prisma.channel.create({
      data: { serverId, name: body.name, type: body.type },
    });
    return reply.status(201).send(channel);
  });
}
