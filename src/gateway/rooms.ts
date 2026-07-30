import type { WebSocket } from "ws";

interface ConnMeta {
  userId: string;
  username: string;
}

// Every connected socket — there's only one community per deployment, so
// there's only one room.
const allConnections = new Set<WebSocket>();
// socket -> connection metadata, for cleanup on close
const connections = new Map<WebSocket, ConnMeta>();
// userId -> count of live sockets (supports multiple tabs/devices per user)
const onlineCounts = new Map<string, number>();

export function registerConnection(socket: WebSocket, userId: string, username: string) {
  connections.set(socket, { userId, username });
  allConnections.add(socket);
  const wasOffline = (onlineCounts.get(userId) ?? 0) === 0;
  onlineCounts.set(userId, (onlineCounts.get(userId) ?? 0) + 1);
  return wasOffline;
}

export function unregisterConnection(socket: WebSocket) {
  const meta = connections.get(socket);
  if (!meta) return null;
  connections.delete(socket);
  allConnections.delete(socket);
  const remaining = (onlineCounts.get(meta.userId) ?? 1) - 1;
  if (remaining <= 0) {
    onlineCounts.delete(meta.userId);
  } else {
    onlineCounts.set(meta.userId, remaining);
  }
  return { meta, isNowOffline: remaining <= 0 };
}

export function isOnline(userId: string) {
  return (onlineCounts.get(userId) ?? 0) > 0;
}

export function getConnMeta(socket: WebSocket) {
  return connections.get(socket);
}

export function allOnlineUserIds(): string[] {
  return [...onlineCounts.keys()];
}

export function broadcastAll(payload: unknown, exclude?: WebSocket) {
  const data = JSON.stringify(payload);
  for (const socket of allConnections) {
    if (socket === exclude) continue;
    if (socket.readyState === socket.OPEN) socket.send(data);
  }
}

// Separate from the LiveKit room itself — this is "who's connected to which
// voice channel" at the app level, so the sidebar can show it for *every*
// voice channel, not just the one the current client happens to be in
// (LiveKit's own client SDK only knows about rooms you've actually joined).
const voiceMembers = new Map<string, Set<string>>(); // channelId -> userIds
const userVoiceChannel = new Map<string, string>(); // userId -> channelId

export function joinVoiceChannel(userId: string, channelId: string) {
  const prevChannelId = userVoiceChannel.get(userId) ?? null;
  if (prevChannelId === channelId) return { prevChannelId, changed: false };
  if (prevChannelId) voiceMembers.get(prevChannelId)?.delete(userId);
  if (!voiceMembers.has(channelId)) voiceMembers.set(channelId, new Set());
  voiceMembers.get(channelId)!.add(userId);
  userVoiceChannel.set(userId, channelId);
  return { prevChannelId, changed: true };
}

export function leaveVoiceChannel(userId: string): string | null {
  const prevChannelId = userVoiceChannel.get(userId);
  if (!prevChannelId) return null;
  voiceMembers.get(prevChannelId)?.delete(userId);
  userVoiceChannel.delete(userId);
  return prevChannelId;
}

export function voiceChannelMembers(channelId: string): string[] {
  return [...(voiceMembers.get(channelId) ?? [])];
}

export function allVoiceState(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [channelId, members] of voiceMembers) {
    if (members.size > 0) result[channelId] = [...members];
  }
  return result;
}
