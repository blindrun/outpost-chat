import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../plugins/db.js";
import {
  registerConnection,
  unregisterConnection,
  broadcastAll,
  isOnline,
  allOnlineUserIds,
  joinVoiceChannel,
  leaveVoiceChannel,
  voiceChannelMembers,
  allVoiceState,
} from "./rooms.js";
import { PERMISSIONS, hasPermission } from "../util/permissions.js";
import { hydrateAuthors, hydrateReplyPreviews } from "../routes/messages.js";
import {
  isAutomodBlocked,
  handlePostMessageBotHooks,
  handleReactionRoleToggle,
  isUserMuted,
  recordWarning,
} from "../util/bot.js";

const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("MESSAGE_SEND"),
    channelId: z.string(),
    content: z.string().max(4000),
    attachmentUrl: z.string().url().optional(),
    replyToId: z.string().optional(),
  }),
  z.object({ type: z.literal("TYPING_START"), channelId: z.string() }),
  z.object({ type: z.literal("MESSAGE_EDIT"), messageId: z.string(), content: z.string().min(1).max(4000) }),
  z.object({ type: z.literal("MESSAGE_DELETE"), messageId: z.string() }),
  z.object({ type: z.literal("MESSAGE_PIN"), messageId: z.string() }),
  z.object({ type: z.literal("MESSAGE_UNPIN"), messageId: z.string() }),
  z.object({ type: z.literal("REACTION_ADD"), messageId: z.string(), emoji: z.string().min(1).max(8) }),
  z.object({ type: z.literal("REACTION_REMOVE"), messageId: z.string(), emoji: z.string().min(1).max(8) }),
  z.object({ type: z.literal("VOICE_JOIN"), channelId: z.string() }),
  z.object({ type: z.literal("VOICE_LEAVE") }),
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
        voiceState: allVoiceState(),
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

          if (await isUserMuted(userId)) {
            sendError("you are muted and cannot send messages right now");
            return;
          }

          if (parsed.content.trim() && (await isAutomodBlocked(parsed.content))) {
            const result = await recordWarning(userId, "message blocked by automod (banned word)", "automod");
            sendError(
              result.muted
                ? `message blocked: contains a banned word. You've been muted for repeated violations (warning ${result.count}/${result.threshold}).`
                : `message blocked: contains a banned word (warning ${result.count}/${result.threshold}).`,
            );
            return;
          }

          let replyToId: string | undefined;
          if (parsed.replyToId) {
            const target = await prisma.message.findUnique({ where: { id: parsed.replyToId } });
            if (!target || target.channelId !== parsed.channelId) {
              sendError("reply target not found in this channel");
              return;
            }
            replyToId = target.id;
          }

          const [message, author] = await Promise.all([
            prisma.message.create({
              data: {
                channelId: parsed.channelId,
                authorId: userId,
                content: parsed.content,
                attachmentUrl: parsed.attachmentUrl,
                replyToId,
              },
              include: { replyTo: true },
            }),
            prisma.user.findUnique({ where: { id: userId }, select: { avatarUrl: true } }),
          ]);
          const [hydrated] = await hydrateReplyPreviews([message]);
          broadcastAll({
            type: "MESSAGE_CREATE",
            message: { ...hydrated, authorUsername: username, authorAvatarUrl: author?.avatarUrl ?? null },
          });

          // Fire-and-forget on purpose — commands/leveling/level-up
          // announcements are follow-up bot activity, not part of the
          // user's own send succeeding or failing.
          if (parsed.content.trim()) {
            handlePostMessageBotHooks(parsed.channelId, userId, username, parsed.content).catch((err) =>
              app.log.error(err, "bot hook failed"),
            );
          }
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
              include: { replyTo: true },
            }),
            prisma.user.findUnique({ where: { id: userId }, select: { avatarUrl: true } }),
          ]);
          const [hydrated] = await hydrateReplyPreviews([updated]);
          broadcastAll({
            type: "MESSAGE_UPDATE",
            message: { ...hydrated, authorUsername: username, authorAvatarUrl: author?.avatarUrl ?? null },
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

      if (parsed.type === "MESSAGE_PIN" || parsed.type === "MESSAGE_UNPIN") {
        const canModerate = await hasPermission(userId, PERMISSIONS.MANAGE_CHANNELS);
        if (!canModerate) {
          sendError("missing MANAGE_CHANNELS permission");
          return;
        }
        const message = await prisma.message.findUnique({ where: { id: parsed.messageId } });
        if (!message) {
          sendError("message not found");
          return;
        }
        const [updated, hydratedAuthor] = await Promise.all([
          prisma.message.update({
            where: { id: message.id },
            data: { pinned: parsed.type === "MESSAGE_PIN" },
            include: { replyTo: true },
          }),
          hydrateAuthors([message]),
        ]);
        const [hydrated] = await hydrateReplyPreviews([updated]);
        broadcastAll({
          type: "MESSAGE_UPDATE",
          message: { ...hydrated, authorUsername: hydratedAuthor[0]?.authorUsername, authorAvatarUrl: hydratedAuthor[0]?.authorAvatarUrl },
        });
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
          handleReactionRoleToggle(userId, message.id, parsed.emoji, true).catch((err) =>
            app.log.error(err, "reaction-role toggle failed"),
          );
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
          handleReactionRoleToggle(userId, message.id, parsed.emoji, false).catch((err) =>
            app.log.error(err, "reaction-role toggle failed"),
          );
        }
        return;
      }

      if (parsed.type === "VOICE_JOIN") {
        const { prevChannelId, changed } = joinVoiceChannel(userId, parsed.channelId);
        if (!changed) return;
        if (prevChannelId) {
          broadcastAll({
            type: "VOICE_STATE_UPDATE",
            channelId: prevChannelId,
            userIds: voiceChannelMembers(prevChannelId),
          });
        }
        broadcastAll({
          type: "VOICE_STATE_UPDATE",
          channelId: parsed.channelId,
          userIds: voiceChannelMembers(parsed.channelId),
        });
        return;
      }

      if (parsed.type === "VOICE_LEAVE") {
        const leftChannelId = leaveVoiceChannel(userId);
        if (leftChannelId) {
          broadcastAll({
            type: "VOICE_STATE_UPDATE",
            channelId: leftChannelId,
            userIds: voiceChannelMembers(leftChannelId),
          });
        }
        return;
      }
    });

    socket.on("close", () => {
      const result = unregisterConnection(socket);
      if (result?.isNowOffline) {
        broadcastAll({ type: "PRESENCE_UPDATE", userId: result.meta.userId, status: "offline" });
        const leftChannelId = leaveVoiceChannel(result.meta.userId);
        if (leftChannelId) {
          broadcastAll({
            type: "VOICE_STATE_UPDATE",
            channelId: leftChannelId,
            userIds: voiceChannelMembers(leftChannelId),
          });
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
