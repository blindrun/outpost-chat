import type { WebSocket } from "ws";
import { prisma } from "../plugins/db.js";
import { canAccessChannel, filterVisibleChannels } from "../util/permissions.js";
import { allOnlineUserIds, broadcastAll, sendToUsers } from "./rooms.js";

// Same shape as broadcastAll, but scoped to a channel — for an unrestricted
// channel (the common case) this is just broadcastAll, so it's safe to use
// everywhere broadcastAll used to be for a non-DM channel event. For a
// restricted channel it only reaches the online users who can actually see
// it, checked fresh on every call rather than cached, since role
// assignments and a channel's restriction can both change between events.
export async function broadcastToChannel(channelId: string, payload: unknown, exclude?: WebSocket) {
  const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { restrictedToRoleIds: true } });
  if (!channel || channel.restrictedToRoleIds.length === 0) {
    broadcastAll(payload, exclude);
    return;
  }

  const onlineIds = allOnlineUserIds();
  const allowed: string[] = [];
  for (const uid of onlineIds) {
    if (await canAccessChannel(uid, channel)) allowed.push(uid);
  }
  sendToUsers(allowed, payload, exclude);
}

// Sends each online user their own filtered CHANNELS_UPDATE — unlike
// broadcastToChannel above, this isn't scoped to one channel's viewers, it's
// a per-recipient view of the *whole* list, since two users can legitimately
// see different subsets once any channel is restricted. Used after any
// change that could add/remove/re-scope a channel (create, reorder, permission
// update) so every connected sidebar stays in sync live.
export async function broadcastChannelsUpdate() {
  const channels = await prisma.channel.findMany({
    where: { type: { notIn: ["THREAD", "DM"] } },
    orderBy: { position: "asc" },
  });

  for (const uid of allOnlineUserIds()) {
    const visible = await filterVisibleChannels(uid, channels);
    sendToUsers([uid], { type: "CHANNELS_UPDATE", channels: visible });
  }
}
