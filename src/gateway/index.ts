import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../plugins/db.js";
import {
  registerConnection,
  unregisterConnection,
  broadcastAll,
  sendToUsers,
  isOnline,
  allOnlineUserIds,
  joinVoiceChannel,
  leaveVoiceChannel,
  voiceChannelMembers,
  allVoiceState,
} from "./rooms.js";
import { PERMISSIONS, hasPermission } from "../util/permissions.js";
import { hydrateAuthors, hydrateReplyPreviews } from "../routes/messages.js";
import { areFriends } from "../util/friends.js";
import {
  isAutomodBlocked,
  handlePostMessageBotHooks,
  handleReactionRoleToggle,
  isUserMuted,
  recordWarning,
} from "../util/bot.js";

// A DM channel's two participant ids — null if the channel isn't a DM at
// all. Looked up fresh each time rather than cached, since membership never
// changes for a DM's lifetime but the caller usually already has no other
// context to key a cache on.
async function dmParticipantIds(channelId: string): Promise<string[] | null> {
  const rows = await prisma.dMParticipant.findMany({ where: { channelId }, select: { userId: true } });
  return rows.length > 0 ? rows.map((r) => r.userId) : null;
}

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
      const decoded = app.jwt.verify<{ sub: string; username: string; purpose?: string }>(token);
      // Same rejection as the REST `authenticate` decorator (see
      // server.ts) — any purpose-tagged token is a special-use, short-lived
      // token (MFA-pending, WebAuthn challenge, ...), never a real session,
      // and must never grant a live gateway connection.
      if (decoded.purpose) {
        socket.close(4001, "invalid token");
        return;
      }
      userId = decoded.sub;
      username = decoded.username;
    } catch {
      socket.close(4001, "invalid token");
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { banned: true } });
    if (user?.banned) {
      socket.close(4003, "banned");
      return;
    }

    const wasOffline = registerConnection(socket, userId, username);

    // DM channels are scoped per-user (unlike TEXT/VOICE, which every
    // authenticated user can see) so they're excluded from the shared
    // `channels` list and sent separately, shaped with the other
    // participant's info the same way POST /dms/:userId returns them.
    const dmRows = await prisma.channel.findMany({
      where: { type: "DM", dmParticipants: { some: { userId } } },
      include: { dmParticipants: { include: { user: { select: { id: true, username: true, avatarUrl: true } } } } },
    });
    const dmChannels = dmRows.map((c) => {
      const other = c.dmParticipants.find((p) => p.userId !== userId)?.user;
      return {
        id: c.id,
        name: other?.username ?? "unknown",
        type: "DM" as const,
        position: 0,
        otherUserId: other?.id ?? null,
        otherUsername: other?.username ?? "unknown",
        otherAvatarUrl: other?.avatarUrl ?? null,
      };
    });

    socket.send(
      JSON.stringify({
        type: "READY",
        // THREAD channels are intentionally excluded — they aren't
        // top-level sidebar entries, the client only learns about one when
        // it's created/opened (via THREAD_CREATE or fetching a message's
        // thread directly).
        channels: await prisma.channel.findMany({ where: { type: { notIn: ["THREAD", "DM"] } }, orderBy: { position: "asc" } }),
        dmChannels,
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

        // DMs aren't in the shared broadcastAll room — every reply/typing
        // event below has to go through sendToUsers instead, scoped to
        // just the two participants, and only proceeds at all if the
        // sender is one of them and the friendship backing the DM is still
        // ACCEPTED (removing a friend or blocking cuts off an existing DM
        // channel rather than deleting it, so this is checked live on
        // every send, not just at channel-creation time).
        let dmMembers: string[] | null = null;
        if (channel.type === "DM") {
          dmMembers = await dmParticipantIds(channel.id);
          if (!dmMembers || !dmMembers.includes(userId)) {
            sendError("channel not found");
            return;
          }
          const otherId = dmMembers.find((id) => id !== userId)!;
          if (!(await areFriends(userId, otherId))) {
            sendError("you can no longer message this user");
            return;
          }
        }

        if (parsed.type === "MESSAGE_SEND") {
          if (channel.type === "VOICE") {
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
          const outgoing = {
            type: "MESSAGE_CREATE" as const,
            message: { ...hydrated, authorUsername: username, authorAvatarUrl: author?.avatarUrl ?? null },
          };
          if (dmMembers) {
            sendToUsers(dmMembers, outgoing);
          } else {
            broadcastAll(outgoing);
          }

          // Fire-and-forget on purpose — commands/leveling/level-up
          // announcements are follow-up bot activity, not part of the
          // user's own send succeeding or failing. Bot hooks (welcome,
          // auto-role, reaction roles, leveling) are all server-wide
          // features tied to real channels, not applicable to a DM.
          if (parsed.content.trim() && !dmMembers) {
            handlePostMessageBotHooks(parsed.channelId, userId, username, parsed.content).catch((err) =>
              app.log.error(err, "bot hook failed"),
            );
          }
        } else {
          const outgoing = { type: "TYPING_START" as const, channelId: parsed.channelId, userId, username };
          if (dmMembers) {
            sendToUsers(dmMembers, outgoing, socket);
          } else {
            broadcastAll(outgoing, socket);
          }
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

        let dmMembers: string[] | null = null;
        if (message.channel.type === "DM") {
          dmMembers = await dmParticipantIds(message.channelId);
          if (!dmMembers || !dmMembers.includes(userId)) {
            sendError("message not found");
            return;
          }
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
          const outgoing = {
            type: "MESSAGE_UPDATE" as const,
            message: { ...hydrated, authorUsername: username, authorAvatarUrl: author?.avatarUrl ?? null },
          };
          if (dmMembers) sendToUsers(dmMembers, outgoing);
          else broadcastAll(outgoing);
        } else {
          // DMs have no moderator override — a server moderator has no
          // standing power over a private 1:1 conversation, so only the
          // author can delete their own DM message, full stop.
          const canModerate = !dmMembers && (await hasPermission(userId, PERMISSIONS.MANAGE_CHANNELS));
          if (message.authorId !== userId && !canModerate) {
            sendError("only the author or a moderator can delete this message");
            return;
          }
          await prisma.message.delete({ where: { id: message.id } });
          const outgoing = {
            type: "MESSAGE_DELETE" as const,
            messageId: message.id,
            channelId: message.channelId,
          };
          if (dmMembers) sendToUsers(dmMembers, outgoing);
          else broadcastAll(outgoing);
        }
        return;
      }

      if (parsed.type === "MESSAGE_PIN" || parsed.type === "MESSAGE_UNPIN") {
        const message = await prisma.message.findUnique({ where: { id: parsed.messageId }, include: { channel: true } });
        if (!message) {
          sendError("message not found");
          return;
        }

        let dmMembers: string[] | null = null;
        if (message.channel.type === "DM") {
          dmMembers = await dmParticipantIds(message.channelId);
          if (!dmMembers || !dmMembers.includes(userId)) {
            sendError("message not found");
            return;
          }
        } else if (!(await hasPermission(userId, PERMISSIONS.MANAGE_CHANNELS))) {
          sendError("missing MANAGE_CHANNELS permission");
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
        const outgoing = {
          type: "MESSAGE_UPDATE" as const,
          message: { ...hydrated, authorUsername: hydratedAuthor[0]?.authorUsername, authorAvatarUrl: hydratedAuthor[0]?.authorAvatarUrl },
        };
        if (dmMembers) sendToUsers(dmMembers, outgoing);
        else broadcastAll(outgoing);
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

        let dmMembers: string[] | null = null;
        if (message.channel.type === "DM") {
          dmMembers = await dmParticipantIds(message.channelId);
          if (!dmMembers || !dmMembers.includes(userId)) {
            sendError("message not found");
            return;
          }
        }

        if (parsed.type === "REACTION_ADD") {
          await prisma.reaction.upsert({
            where: { messageId_userId_emoji: { messageId: message.id, userId, emoji: parsed.emoji } },
            create: { messageId: message.id, userId, emoji: parsed.emoji },
            update: {},
          });
          const outgoing = {
            type: "REACTION_ADD" as const,
            messageId: message.id,
            channelId: message.channelId,
            userId,
            username,
            emoji: parsed.emoji,
          };
          if (dmMembers) sendToUsers(dmMembers, outgoing);
          else broadcastAll(outgoing);
          // Reaction roles are a server-wide feature tied to real
          // channels/roles — not applicable inside a DM.
          if (!dmMembers) {
            handleReactionRoleToggle(userId, message.id, parsed.emoji, true).catch((err) =>
              app.log.error(err, "reaction-role toggle failed"),
            );
          }
        } else {
          await prisma.reaction.deleteMany({
            where: { messageId: message.id, userId, emoji: parsed.emoji },
          });
          const outgoing = {
            type: "REACTION_REMOVE" as const,
            messageId: message.id,
            channelId: message.channelId,
            userId,
            emoji: parsed.emoji,
          };
          if (dmMembers) sendToUsers(dmMembers, outgoing);
          else broadcastAll(outgoing);
          if (!dmMembers) {
            handleReactionRoleToggle(userId, message.id, parsed.emoji, false).catch((err) =>
              app.log.error(err, "reaction-role toggle failed"),
            );
          }
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
