import type { WebSocket } from "ws";

interface ConnMeta {
  userId: string;
  username: string;
  serverIds: Set<string>;
}

// serverId -> set of live sockets whose user is a member of that server
const serverRooms = new Map<string, Set<WebSocket>>();
// socket -> connection metadata, for cleanup on close
const connections = new Map<WebSocket, ConnMeta>();
// userId -> count of live sockets (supports multiple tabs/devices per user)
const onlineCounts = new Map<string, number>();

export function registerConnection(socket: WebSocket, userId: string, username: string, serverIds: string[]) {
  connections.set(socket, { userId, username, serverIds: new Set(serverIds) });
  for (const serverId of serverIds) {
    if (!serverRooms.has(serverId)) serverRooms.set(serverId, new Set());
    serverRooms.get(serverId)!.add(socket);
  }
  const wasOffline = (onlineCounts.get(userId) ?? 0) === 0;
  onlineCounts.set(userId, (onlineCounts.get(userId) ?? 0) + 1);
  return wasOffline;
}

export function unregisterConnection(socket: WebSocket) {
  const meta = connections.get(socket);
  if (!meta) return null;
  connections.delete(socket);
  for (const serverId of meta.serverIds) {
    serverRooms.get(serverId)?.delete(socket);
  }
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

export function broadcastToServer(serverId: string, payload: unknown, exclude?: WebSocket) {
  const sockets = serverRooms.get(serverId);
  if (!sockets) return;
  const data = JSON.stringify(payload);
  for (const socket of sockets) {
    if (socket === exclude) continue;
    if (socket.readyState === socket.OPEN) socket.send(data);
  }
}

export function serverIdsForSocket(socket: WebSocket): string[] {
  return [...(connections.get(socket)?.serverIds ?? [])];
}
