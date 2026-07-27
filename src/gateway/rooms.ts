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
