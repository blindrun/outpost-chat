import { prisma } from "../plugins/db.js";

// Blocking lives on the Friendship row (status BLOCKED + blockedById), so
// both directions are one query against the same table — see the model
// comment in schema.prisma for why there's only ever one row per pair.
//
// Until now blocking only cut off DMs and friend requests (both enforced in
// routes/dms.ts and the gateway's MESSAGE_SEND handler): a blocked user's
// messages in ordinary channels still showed up in the blocker's client,
// which is neither what "block" means to a user nor enough for App Store
// Guideline 1.2. These two helpers are what the message paths filter on.

// Users this user has blocked — their messages are hidden from this user's
// history, pins and search results.
export async function getBlockedByUser(userId: string): Promise<string[]> {
  const rows = await prisma.friendship.findMany({
    where: { status: "BLOCKED", blockedById: userId },
    select: { requesterId: true, addresseeId: true },
  });
  return rows.map((r) => (r.requesterId === userId ? r.addresseeId : r.requesterId));
}

// Users who have blocked this user — the recipients to leave out when
// broadcasting a message this user just sent. Deliberately one-directional:
// being blocked doesn't hide the blocker's own messages from you, matching
// how blocking works everywhere else (the person who blocked is the one who
// stops seeing things).
export async function getBlockersOf(userId: string): Promise<string[]> {
  const rows = await prisma.friendship.findMany({
    where: {
      status: "BLOCKED",
      blockedById: { not: userId },
      OR: [{ requesterId: userId }, { addresseeId: userId }],
    },
    select: { blockedById: true },
  });
  return rows.flatMap((r) => (r.blockedById ? [r.blockedById] : []));
}

// Prisma's `notIn` compiles to a plain SQL `NOT IN`, and `NULL NOT IN (...)`
// is NULL, not true — so filtering authors with `authorId: { notIn: ids }`
// would silently drop every webhook and system-bot message (both have a null
// authorId) along with the blocked ones. Spelling the null case out
// explicitly is the fix, and returning undefined for an empty block list
// keeps the common case a no-op rather than an always-true OR.
export function excludeBlockedAuthors(blockedIds: string[]) {
  if (blockedIds.length === 0) return undefined;
  return { OR: [{ authorId: null }, { authorId: { notIn: blockedIds } }] };
}

// Hiding a blocked user's messages isn't enough on its own: someone replying
// to them quotes their text inline (see hydrateReplyPreviews), which would
// put it straight back in front of the person who blocked them. Dropping the
// quote leaves the reply itself intact, which is the right trade — the reply
// is from someone they haven't blocked.
export function stripBlockedReplyTargets<T extends { replyTo: { authorId: string | null } | null }>(
  messages: T[],
  blockedIds: string[],
): T[] {
  if (blockedIds.length === 0) return messages;
  const blocked = new Set(blockedIds);
  return messages.map((m) =>
    m.replyTo?.authorId && blocked.has(m.replyTo.authorId) ? { ...m, replyTo: null } : m,
  );
}
