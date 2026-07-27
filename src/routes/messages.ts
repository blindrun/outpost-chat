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
    const query = historyQuerySchema.parse(req.query);

    const channel = await prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) return reply.status(404).send({ error: "channel not found" });

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

    // Message has no FK relation to User (authorId is a plain string), so
    // author display info (username, avatar) is joined manually here rather
    // than via Prisma's `include`. Without this, history-loaded messages
    // showed the raw author UUID instead of a username — only live
    // MESSAGE_CREATE broadcasts carried it, from the sender's own JWT.
    const authorIds = [...new Set(messages.map((m) => m.authorId))];
    const authors = await prisma.user.findMany({
      where: { id: { in: authorIds } },
      select: { id: true, username: true, avatarUrl: true },
    });
    const authorById = new Map(authors.map((a) => [a.id, a]));

    return messages.reverse().map((m) => ({
      ...m,
      authorUsername: authorById.get(m.authorId)?.username,
      authorAvatarUrl: authorById.get(m.authorId)?.avatarUrl,
    }));
  });
}
