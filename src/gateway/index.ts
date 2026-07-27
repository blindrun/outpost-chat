import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../plugins/db.js";
import {
  registerConnection,
  unregisterConnection,
  broadcastToServer,
  isOnline,
} from "./rooms.js";
import { PERMISSIONS, hasPermission } from "../util/permissions.js";

async function onlineMemberIdsFor(serverIds: string[]): Promise<string[]> {
  if (serverIds.length === 0) return [];
  const memberships = await prisma.membership.findMany({
    where: { serverId: { in: serverIds } },
    select: { userId: true },
    distinct: ["userId"],
  });
  return memberships.map((m) => m.userId).filter((id) => isOnline(id));
}

const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("MESSAGE_SEND"), channelId: z.string(), content: z.string().min(1).max(4000) }),
  z.object({ type: z.literal("TYPING_START"), channelId: z.string() }),
  z.object({ type: z.literal("MESSAGE_EDIT"), messageId: z.string(), content: z.string().min(1).max(4000) }),
  z.object({ type: z.literal("MESSAGE_DELETE"), messageId: z.string() }),
  z.object({ type: z.literal("REACTION_ADD"), messageId: z.string(), emoji: z.string().min(1).max(8) }),
  z.object({ type: z.literal("REACTION_REMOVE"), messageId: z.string(), emoji: z.string().min(1).max(8) }),
]);

type ClientMessage = z.infer<typeof clientMessageSchema>;

export async function gatewayRoutes(app: FastifyInstance) {
  app.get("/gateway", { websocket: true }, async (socket, req) => {
    const token = (req.query as { token?: string }).token;
    if (!token) {
      socket.close(4001, "missing token");
      return;
    }

    let userId: string;
    let username: string;
    try {
      const decoded = app.jwt.verify<{ sub: string; username: string }>(token);
      userId = decoded.sub;
      username = decoded.username;
    } catch {
      socket.close(4001, "invalid token");
      return;
    }

    const memberships = await prisma.membership.findMany({
      where: { userId },
      include: { server: { include: { channels: true } } },
    });
    const serverIds = memberships.map((m) => m.serverId);

    const wasOffline = registerConnection(socket, userId, username, serverIds);

    socket.send(
      JSON.stringify({
        type: "READY",
        servers: memberships.map((m) => m.server),
        onlineUserIds: await onlineMemberIdsFor(serverIds),
      }),
    );

    if (wasOffline) {
      for (const serverId of serverIds) {
        broadcastToServer(serverId, { type: "PRESENCE_UPDATE", userId, status: "online" }, socket);
      }
    }

    function sendError(error: string) {
      socket.send(JSON.stringify({ type: "ERROR", error }));
    }

    socket.on("message", async (raw: Buffer) => {
      let parsed: ClientMessage;
      try {
        parsed = clientMessageSchema.parse(JSON.parse(raw.toString()));
      } catch {
        sendError("invalid message");
        return;
      }

      if (parsed.type === "MESSAGE_SEND" || parsed.type === "TYPING_START") {
        const channel = await prisma.channel.findUnique({ where: { id: parsed.channelId } });
        if (!channel || !serverIds.includes(channel.serverId)) {
          sendError("not a member of this channel's server");
          return;
        }

        if (parsed.type === "MESSAGE_SEND") {
          if (channel.type !== "TEXT") {
            sendError("cannot send messages in a voice channel");
            return;
          }
          const message = await prisma.message.create({
            data: { channelId: parsed.channelId, authorId: userId, content: parsed.content },
          });
          broadcastToServer(channel.serverId, {
            type: "MESSAGE_CREATE",
            message: { ...message, authorUsername: username },
          });
        } else {
          broadcastToServer(
            channel.serverId,
            { type: "TYPING_START", channelId: parsed.channelId, userId, username },
            socket,
          );
        }
        return;
      }

      if (parsed.type === "MESSAGE_EDIT" || parsed.type === "MESSAGE_DELETE") {
        const message = await prisma.message.findUnique({
          where: { id: parsed.messageId },
          include: { channel: true },
        });
        if (!message || !serverIds.includes(message.channel.serverId)) {
          sendError("message not found");
          return;
        }

        if (parsed.type === "MESSAGE_EDIT") {
          if (message.authorId !== userId) {
            sendError("only the author can edit this message");
            return;
          }
          const updated = await prisma.message.update({
            where: { id: message.id },
            data: { content: parsed.content, editedAt: new Date() },
          });
          broadcastToServer(message.channel.serverId, {
            type: "MESSAGE_UPDATE",
            message: { ...updated, authorUsername: username },
          });
        } else {
          const canModerate = await hasPermission(userId, message.channel.serverId, PERMISSIONS.MANAGE_CHANNELS);
          if (message.authorId !== userId && !canModerate) {
            sendError("only the author or a moderator can delete this message");
            return;
          }
          await prisma.message.delete({ where: { id: message.id } });
          broadcastToServer(message.channel.serverId, {
            type: "MESSAGE_DELETE",
            messageId: message.id,
            channelId: message.channelId,
          });
        }
        return;
      }

      if (parsed.type === "REACTION_ADD" || parsed.type === "REACTION_REMOVE") {
        const message = await prisma.message.findUnique({
          where: { id: parsed.messageId },
          include: { channel: true },
        });
        if (!message || !serverIds.includes(message.channel.serverId)) {
          sendError("message not found");
          return;
        }

        if (parsed.type === "REACTION_ADD") {
          await prisma.reaction.upsert({
            where: { messageId_userId_emoji: { messageId: message.id, userId, emoji: parsed.emoji } },
            create: { messageId: message.id, userId, emoji: parsed.emoji },
            update: {},
          });
          broadcastToServer(message.channel.serverId, {
            type: "REACTION_ADD",
            messageId: message.id,
            channelId: message.channelId,
            userId,
            username,
            emoji: parsed.emoji,
          });
        } else {
          await prisma.reaction.deleteMany({
            where: { messageId: message.id, userId, emoji: parsed.emoji },
          });
          broadcastToServer(message.channel.serverId, {
            type: "REACTION_REMOVE",
            messageId: message.id,
            channelId: message.channelId,
            userId,
            emoji: parsed.emoji,
          });
        }
      }
    });

    socket.on("close", () => {
      const result = unregisterConnection(socket);
      if (result?.isNowOffline) {
        for (const serverId of result.meta.serverIds) {
          broadcastToServer(serverId, { type: "PRESENCE_UPDATE", userId: result.meta.userId, status: "offline" });
        }
      }
    });
  });

  // REST fallback for checking a single user's presence (used by the client on first load).
  app.get("/users/:userId/presence", { onRequest: [app.authenticate] }, async (req) => {
    const { userId } = req.params as { userId: string };
    return { userId, online: isOnline(userId) };
  });
}
