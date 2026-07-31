import type { FastifyInstance } from "fastify";
import { prisma } from "../plugins/db.js";
import { areFriends } from "../util/friends.js";
import { sendToUsers } from "../gateway/rooms.js";

function shapeDmChannel(channelId: string, other: { id: string; username: string; avatarUrl: string | null }) {
  return {
    id: channelId,
    name: other.username,
    type: "DM" as const,
    position: 0,
    otherUserId: other.id,
    otherUsername: other.username,
    otherAvatarUrl: other.avatarUrl,
  };
}

export async function dmRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  // Get-or-create the DM channel with another user — gated on an accepted,
  // unblocked friendship, same as sending a message in one (see the
  // gateway's MESSAGE_SEND handler), so a DM channel can't be created as a
  // side channel around the friends-only restriction.
  app.post("/dms/:userId", async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const { userId: otherId } = req.params as { userId: string };
    if (otherId === userId) return reply.status(400).send({ error: "cannot DM yourself" });

    const other = await prisma.user.findUnique({ where: { id: otherId }, select: { id: true, username: true, avatarUrl: true } });
    if (!other) return reply.status(404).send({ error: "user not found" });

    if (!(await areFriends(userId, otherId))) {
      return reply.status(403).send({ error: "you must be friends with this user to message them" });
    }

    const existing = await prisma.dMParticipant.findFirst({
      where: { userId, channel: { type: "DM", dmParticipants: { some: { userId: otherId } } } },
      select: { channelId: true },
    });
    if (existing) {
      return shapeDmChannel(existing.channelId, other);
    }

    const channel = await prisma.channel.create({
      data: {
        name: `dm-${userId}-${otherId}`,
        type: "DM",
        dmParticipants: { create: [{ userId }, { userId: otherId }] },
      },
    });

    const me = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, avatarUrl: true } });
    if (me) {
      sendToUsers([otherId], { type: "DM_CHANNEL_CREATE", channel: shapeDmChannel(channel.id, me) });
    }
    return reply.status(201).send(shapeDmChannel(channel.id, other));
  });
}
