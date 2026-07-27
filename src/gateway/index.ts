import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../plugins/db.js";
import {
  registerConnection,
  unregisterConnection,
  broadcastToServer,
  isOnline,
} from "./rooms.js";

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
]);

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

    socket.on("message", async (raw: Buffer) => {
      let parsed;
      try {
        parsed = clientMessageSchema.parse(JSON.parse(raw.toString()));
      } catch {
        socket.send(JSON.stringify({ type: "ERROR", error: "invalid message" }));
        return;
      }

      const channel = await prisma.channel.findUnique({ where: { id: parsed.channelId } });
      if (!channel || !serverIds.includes(channel.serverId)) {
        socket.send(JSON.stringify({ type: "ERROR", error: "not a member of this channel's server" }));
        return;
      }

      if (parsed.type === "MESSAGE_SEND") {
        if (channel.type !== "TEXT") {
          socket.send(JSON.stringify({ type: "ERROR", error: "cannot send messages in a voice channel" }));
          return;
        }
        const message = await prisma.message.create({
          data: { channelId: parsed.channelId, authorId: userId, content: parsed.content },
        });
        broadcastToServer(channel.serverId, {
          type: "MESSAGE_CREATE",
          message: { ...message, authorUsername: username },
        });
      } else if (parsed.type === "TYPING_START") {
        broadcastToServer(
          channel.serverId,
          { type: "TYPING_START", channelId: parsed.channelId, userId, username },
          socket,
        );
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
