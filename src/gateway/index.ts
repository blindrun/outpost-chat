import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../plugins/db.js";
import {
  registerConnection,
  unregisterConnection,
  broadcastAll,
  isOnline,
  allOnlineUserIds,
} from "./rooms.js";
import { PERMISSIONS, hasPermission } from "../util/permissions.js";

const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("MESSAGE_SEND"),
    channelId: z.string(),
    content: z.string().max(4000),
    attachmentUrl: z.string().url().optional(),
  }),
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

    const wasOffline = registerConnection(socket, userId, username);

    socket.send(
      JSON.stringify({
        type: "READY",
        channels: await prisma.channel.findMany({ orderBy: { position: "asc" } }),
        onlineUserIds: allOnlineUserIds(),
      }),
    );

    if (wasOffline) {
      broadcastAll({ type: "PRESENCE_UPDATE", userId, status: "online" }, socket);
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
        if (!channel) {
          sendError("channel not found");
          return;
        }

        if (parsed.type === "MESSAGE_SEND") {
          if (channel.type !== "TEXT") {
            sendError("cannot send messages in a voice channel");
            return;
          }
          if (!parsed.content.trim() && !parsed.attachmentUrl) {
            sendError("message must have content or an attachment");
            return;
          }
          const [message, author] = await Promise.all([
            prisma.message.create({
              data: {
                channelId: parsed.channelId,
                authorId: userId,
                content: parsed.content,
                attachmentUrl: parsed.attachmentUrl,
              },
            }),
            prisma.user.findUnique({ where: { id: userId }, select: { avatarUrl: true } }),
          ]);
          broadcastAll({
            type: "MESSAGE_CREATE",
            message: { ...message, authorUsername: username, authorAvatarUrl: author?.avatarUrl ?? null },
          });
        } else {
          broadcastAll(
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
        if (!message) {
          sendError("message not found");
          return;
        }

        if (parsed.type === "MESSAGE_EDIT") {
          if (message.authorId !== userId) {
            sendError("only the author can edit this message");
            return;
          }
          const [updated, author] = await Promise.all([
            prisma.message.update({
              where: { id: message.id },
              data: { content: parsed.content, editedAt: new Date() },
            }),
            prisma.user.findUnique({ where: { id: userId }, select: { avatarUrl: true } }),
          ]);
          broadcastAll({
            type: "MESSAGE_UPDATE",
            message: { ...updated, authorUsername: username, authorAvatarUrl: author?.avatarUrl ?? null },
          });
        } else {
          const canModerate = await hasPermission(userId, PERMISSIONS.MANAGE_CHANNELS);
          if (message.authorId !== userId && !canModerate) {
            sendError("only the author or a moderator can delete this message");
            return;
          }
          await prisma.message.delete({ where: { id: message.id } });
          broadcastAll({
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
        if (!message) {
          sendError("message not found");
          return;
        }

        if (parsed.type === "REACTION_ADD") {
          await prisma.reaction.upsert({
            where: { messageId_userId_emoji: { messageId: message.id, userId, emoji: parsed.emoji } },
            create: { messageId: message.id, userId, emoji: parsed.emoji },
            update: {},
          });
          broadcastAll({
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
          broadcastAll({
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
        broadcastAll({ type: "PRESENCE_UPDATE", userId: result.meta.userId, status: "offline" });
      }
    });
  });

  // REST fallback for checking a single user's presence (used by the client on first load).
  app.get("/users/:userId/presence", { onRequest: [app.authenticate] }, async (req) => {
    const { userId } = req.params as { userId: string };
    return { userId, online: isOnline(userId) };
  });
}
