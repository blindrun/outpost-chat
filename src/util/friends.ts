import { prisma } from "../plugins/db.js";

// The one Friendship row (if any) between two users, regardless of
// direction — shared by the friends routes, DM routes, and the gateway's
// DM message-send check.
export async function findFriendship(userId: string, otherId: string) {
  return prisma.friendship.findFirst({
    where: {
      OR: [
        { requesterId: userId, addresseeId: otherId },
        { requesterId: otherId, addresseeId: userId },
      ],
    },
  });
}

export async function areFriends(userId: string, otherId: string): Promise<boolean> {
  const row = await findFriendship(userId, otherId);
  return row?.status === "ACCEPTED";
}
