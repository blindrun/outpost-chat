import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../plugins/db.js";

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().optional(),
});

export async function messageRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  app.get("/channels/:channelId/messages", async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    const { sub: userId } = req.user as { sub: string };
    const query = historyQuerySchema.parse(req.query);

    const channel = await prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) return reply.status(404).send({ error: "channel not found" });

    const membership = await prisma.membership.findUnique({
      where: { userId_serverId: { userId, serverId: channel.serverId } },
    });
    if (!membership) return reply.status(403).send({ error: "not a member of this server" });

    let beforeDate: Date | undefined;
    if (query.before) {
      const cursor = await prisma.message.findUnique({ where: { id: query.before } });
      beforeDate = cursor?.createdAt;
    }

    const messages = await prisma.message.findMany({
      where: {
        channelId,
        ...(beforeDate ? { createdAt: { lt: beforeDate } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: query.limit,
      include: { reactions: true },
    });

    return messages.reverse();
  });
}
