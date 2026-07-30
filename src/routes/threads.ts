import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../plugins/db.js";
import { broadcastAll } from "../gateway/rooms.js";

const createThreadSchema = z.object({
  name: z.string().min(1).max(64).optional(),
});

function serializeThread(channel: {
  id: string;
  name: string;
  parentChannelId: string | null;
  parentMessageId: string | null;
  createdAt: Date;
}) {
  return {
    id: channel.id,
    name: channel.name,
    type: "THREAD" as const,
    position: 0,
    parentChannelId: channel.parentChannelId,
    parentMessageId: channel.parentMessageId,
    createdAt: channel.createdAt,
  };
}

// Threads are just Channel rows with type THREAD and a parentMessageId —
// reuses every existing message code path (history, search, pins,
// reactions, automod, bot hooks) with no extra branching, at the cost of
// READY's channel list needing to exclude THREAD channels (see
// gateway/index.ts) since they aren't meant to show up as top-level
// sidebar entries.
export async function threadRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  app.post("/messages/:messageId/thread", async (req, reply) => {
    const { messageId } = req.params as { messageId: string };
    const body = createThreadSchema.parse(req.body ?? {});

    const message = await prisma.message.findUnique({ where: { id: messageId }, include: { channel: true, thread: true } });
    if (!message) return reply.status(404).send({ error: "message not found" });
    if (message.channel.type !== "TEXT") {
      return reply.status(400).send({ error: "threads can only be started from a text channel message" });
    }
    if (message.thread) return reply.status(409).send({ error: "this message already has a thread" });

    const name = body.name?.trim() || `Thread: ${message.content.slice(0, 40) || "attachment"}`;
    const thread = await prisma.channel.create({
      data: { name, type: "THREAD", parentChannelId: message.channelId, parentMessageId: message.id },
    });

    broadcastAll({ type: "THREAD_CREATE", parentMessageId: message.id, thread: serializeThread(thread) });
    return reply.status(201).send(serializeThread(thread));
  });

  app.get("/messages/:messageId/thread", async (req, reply) => {
    const { messageId } = req.params as { messageId: string };
    const thread = await prisma.channel.findUnique({ where: { parentMessageId: messageId } });
    if (!thread) return reply.status(404).send({ error: "no thread on this message" });
    return serializeThread(thread);
  });
}
