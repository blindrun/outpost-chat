import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../plugins/db.js";
import { sendToUsers, isOnline } from "../gateway/rooms.js";
import { findFriendship } from "../util/friends.js";

const requestSchema = z.object({
  username: z.string().min(1).max(32),
});

function publicUser(u: { id: string; username: string; avatarUrl: string | null }) {
  return { userId: u.id, username: u.username, avatarUrl: u.avatarUrl, online: isOnline(u.id) };
}

export async function friendRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  app.get("/friends", async (req) => {
    const { sub: userId } = req.user as { sub: string };
    const rows = await prisma.friendship.findMany({
      where: { OR: [{ requesterId: userId }, { addresseeId: userId }] },
      include: {
        requester: { select: { id: true, username: true, avatarUrl: true } },
        addressee: { select: { id: true, username: true, avatarUrl: true } },
      },
    });

    const friends: ReturnType<typeof publicUser>[] = [];
    const incoming: ReturnType<typeof publicUser>[] = [];
    const outgoing: ReturnType<typeof publicUser>[] = [];
    const blocked: ReturnType<typeof publicUser>[] = [];

    for (const row of rows) {
      const isRequester = row.requesterId === userId;
      const other = isRequester ? row.addressee : row.requester;
      if (row.status === "ACCEPTED") {
        friends.push(publicUser(other));
      } else if (row.status === "PENDING") {
        (isRequester ? outgoing : incoming).push(publicUser(other));
      } else if (row.status === "BLOCKED" && row.blockedById === userId) {
        blocked.push(publicUser(other));
      }
    }

    return { friends, incoming, outgoing, blocked };
  });

  // The relationship between the caller and one other user — lets a
  // profile card show the right single action (Add Friend / Accept /
  // Message / nothing) without fetching the whole friends list just to
  // find one entry.
  app.get("/friends/:userId/status", async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const { userId: otherId } = req.params as { userId: string };
    if (otherId === userId) return reply.send({ status: "self" });

    const row = await findFriendship(userId, otherId);
    if (!row) return { status: "none" };
    if (row.status === "ACCEPTED") return { status: "friends" };
    if (row.status === "PENDING") {
      return { status: row.requesterId === userId ? "pending_outgoing" : "pending_incoming" };
    }
    return { status: row.blockedById === userId ? "blocked_by_me" : "blocked_by_them" };
  });

  // Sends a request by username. If the other user already sent one to us,
  // this auto-accepts instead of erroring — mirrors Discord's own UX for
  // "add someone who already asked you."
  app.post("/friends/request", async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const body = requestSchema.parse(req.body);

    const target = await prisma.user.findUnique({ where: { username: body.username } });
    if (!target) return reply.status(404).send({ error: "no user with that username" });
    if (target.id === userId) return reply.status(400).send({ error: "cannot friend yourself" });

    const existing = await findFriendship(userId, target.id);
    if (existing) {
      if (existing.status === "BLOCKED") {
        return reply.status(403).send({ error: "cannot send a friend request to this user" });
      }
      if (existing.status === "ACCEPTED") {
        return reply.status(400).send({ error: "already friends" });
      }
      // PENDING
      if (existing.requesterId === userId) {
        return reply.status(400).send({ error: "friend request already sent" });
      }
      const updated = await prisma.friendship.update({
        where: { id: existing.id },
        data: { status: "ACCEPTED", respondedAt: new Date() },
      });
      const [me] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, avatarUrl: true } }),
      ]);
      if (me) sendToUsers([target.id], { type: "FRIEND_REQUEST_ACCEPTED", user: publicUser(me) });
      return reply.status(200).send(updated);
    }

    const created = await prisma.friendship.create({
      data: { requesterId: userId, addresseeId: target.id, status: "PENDING" },
    });
    const me = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, avatarUrl: true } });
    if (me) sendToUsers([target.id], { type: "FRIEND_REQUEST_RECEIVED", user: publicUser(me) });
    return reply.status(201).send(created);
  });

  app.post("/friends/:userId/accept", async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const { userId: otherId } = req.params as { userId: string };

    const existing = await prisma.friendship.findFirst({
      where: { requesterId: otherId, addresseeId: userId, status: "PENDING" },
    });
    if (!existing) return reply.status(404).send({ error: "no pending request from that user" });

    const updated = await prisma.friendship.update({
      where: { id: existing.id },
      data: { status: "ACCEPTED", respondedAt: new Date() },
    });
    const me = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, avatarUrl: true } });
    if (me) sendToUsers([otherId], { type: "FRIEND_REQUEST_ACCEPTED", user: publicUser(me) });
    return updated;
  });

  app.post("/friends/:userId/decline", async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const { userId: otherId } = req.params as { userId: string };

    const existing = await prisma.friendship.findFirst({
      where: { requesterId: otherId, addresseeId: userId, status: "PENDING" },
    });
    if (!existing) return reply.status(404).send({ error: "no pending request from that user" });

    await prisma.friendship.delete({ where: { id: existing.id } });
    return reply.status(204).send();
  });

  // Removes an accepted friendship, or cancels an outgoing request either
  // party sent. Does not touch a BLOCKED row — use /unblock for that.
  app.delete("/friends/:userId", async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const { userId: otherId } = req.params as { userId: string };

    const existing = await findFriendship(userId, otherId);
    if (!existing || existing.status === "BLOCKED") {
      return reply.status(404).send({ error: "not friends with that user" });
    }

    await prisma.friendship.delete({ where: { id: existing.id } });
    if (existing.status === "ACCEPTED") {
      sendToUsers([otherId], { type: "FRIEND_REMOVED", userId });
    }
    return reply.status(204).send();
  });

  // Blocking replaces whatever the pairing's status was (pending request,
  // existing friendship) — it's a hard stop on the relationship, not
  // layered on top of it.
  app.post("/friends/:userId/block", async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const { userId: otherId } = req.params as { userId: string };
    if (otherId === userId) return reply.status(400).send({ error: "cannot block yourself" });

    const target = await prisma.user.findUnique({ where: { id: otherId } });
    if (!target) return reply.status(404).send({ error: "user not found" });

    const existing = await findFriendship(userId, otherId);
    const wasFriends = existing?.status === "ACCEPTED";
    if (existing) {
      await prisma.friendship.update({
        where: { id: existing.id },
        data: { status: "BLOCKED", blockedById: userId },
      });
    } else {
      await prisma.friendship.create({
        data: { requesterId: userId, addresseeId: otherId, status: "BLOCKED", blockedById: userId },
      });
    }
    if (wasFriends) sendToUsers([otherId], { type: "FRIEND_REMOVED", userId });
    return reply.status(204).send();
  });

  // Deletes the row entirely (not just unsets BLOCKED) — a clean slate,
  // same as if they'd never interacted. Either side has to send a fresh
  // request to become friends again.
  app.post("/friends/:userId/unblock", async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const { userId: otherId } = req.params as { userId: string };

    const existing = await prisma.friendship.findFirst({
      where: {
        status: "BLOCKED",
        blockedById: userId,
        OR: [
          { requesterId: userId, addresseeId: otherId },
          { requesterId: otherId, addresseeId: userId },
        ],
      },
    });
    if (!existing) return reply.status(404).send({ error: "not blocked" });

    await prisma.friendship.delete({ where: { id: existing.id } });
    return reply.status(204).send();
  });
}
