const BASE_URL = "http://localhost:8080";

export interface User {
  id: string;
  username: string;
  email: string;
  avatarUrl?: string | null;
}

export interface Channel {
  id: string;
  serverId: string;
  name: string;
  type: "TEXT" | "VOICE";
  position: number;
}

export interface Server {
  id: string;
  name: string;
  ownerId: string;
  inviteCode: string | null;
  channels: Channel[];
}

export interface Invite {
  id: string;
  serverId: string;
  code: string;
  createdBy: string;
  maxUses: number | null;
  uses: number;
  expiresAt: string | null;
  revoked: boolean;
  createdAt: string;
}

export interface Reaction {
  id: string;
  messageId: string;
  userId: string;
  emoji: string;
  createdAt: string;
}

export interface Message {
  id: string;
  channelId: string;
  authorId: string;
  authorUsername?: string;
  authorAvatarUrl?: string | null;
  content: string;
  attachmentUrl?: string | null;
  createdAt: string;
  editedAt?: string | null;
  reactions?: Reaction[];
}

export type Permission = "MANAGE_CHANNELS" | "MANAGE_ROLES" | "SEND_MESSAGES";

export interface Role {
  id: string;
  serverId: string;
  name: string;
  permissions: Permission[];
  position: number;
}

export interface Member {
  userId: string;
  username: string;
  avatarUrl: string | null;
  joinedAt: string;
  roles: { id: string; name: string }[];
}

async function request<T>(path: string, token: string | null, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export function register(username: string, email: string, password: string) {
  return request<{ token: string; user: User }>("/auth/register", null, {
    method: "POST",
    body: JSON.stringify({ username, email, password }),
  });
}

export function login(email: string, password: string) {
  return request<{ token: string; user: User }>("/auth/login", null, {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function listServers(token: string) {
  return request<Server[]>("/servers", token);
}

export function createServer(token: string, name: string) {
  return request<Server>("/servers", token, { method: "POST", body: JSON.stringify({ name }) });
}

export function joinByInvite(token: string, code: string) {
  return request<{ server: Server }>(`/invites/${code}/join`, token, { method: "POST" });
}

export function listInvites(token: string, serverId: string) {
  return request<Invite[]>(`/servers/${serverId}/invites`, token);
}

export function createInvite(token: string, serverId: string, opts: { maxUses?: number; expiresInSeconds?: number }) {
  return request<Invite>(`/servers/${serverId}/invites`, token, {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

export function revokeInvite(token: string, serverId: string, inviteId: string) {
  return request<void>(`/servers/${serverId}/invites/${inviteId}`, token, { method: "DELETE" });
}

export function createChannel(token: string, serverId: string, name: string, type: "TEXT" | "VOICE") {
  return request<Channel>(`/servers/${serverId}/channels`, token, {
    method: "POST",
    body: JSON.stringify({ name, type }),
  });
}

export function listMessages(token: string, channelId: string) {
  return request<Message[]>(`/channels/${channelId}/messages`, token);
}

export function getVoiceToken(token: string, channelId: string) {
  return request<{ token: string; url: string }>(`/channels/${channelId}/voice-token`, token, {
    method: "POST",
  });
}

export async function uploadFile(token: string, file: File): Promise<{ url: string }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE_URL}/uploads`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `upload failed: ${res.status}`);
  }
  return res.json();
}

export function setAvatar(token: string, avatarUrl: string) {
  return request<User>("/auth/me/avatar", token, { method: "PATCH", body: JSON.stringify({ avatarUrl }) });
}

export function updateProfile(token: string, updates: { username?: string; email?: string }) {
  return request<{ token: string; user: User }>("/auth/me", token, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export function updatePassword(token: string, currentPassword: string, newPassword: string) {
  return request<void>("/auth/me/password", token, {
    method: "PATCH",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export function updateServerSettings(token: string, serverId: string, updates: { name?: string }) {
  return request<Server>(`/servers/${serverId}/settings`, token, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export function listMembers(token: string, serverId: string) {
  return request<Member[]>(`/servers/${serverId}/members`, token);
}

export function listRoles(token: string, serverId: string) {
  return request<Role[]>(`/servers/${serverId}/roles`, token);
}

export function createRole(token: string, serverId: string, name: string, permissions: Permission[]) {
  return request<Role>(`/servers/${serverId}/roles`, token, {
    method: "POST",
    body: JSON.stringify({ name, permissions }),
  });
}

export function assignRole(token: string, serverId: string, userId: string, roleId: string) {
  return request<void>(`/servers/${serverId}/members/${userId}/roles`, token, {
    method: "POST",
    body: JSON.stringify({ roleId }),
  });
}

type GatewayEvent =
  | { type: "READY"; servers: Server[]; onlineUserIds: string[] }
  | { type: "MESSAGE_CREATE"; message: Message }
  | { type: "MESSAGE_UPDATE"; message: Message }
  | { type: "MESSAGE_DELETE"; messageId: string; channelId: string }
  | { type: "REACTION_ADD"; messageId: string; channelId: string; userId: string; username: string; emoji: string }
  | { type: "REACTION_REMOVE"; messageId: string; channelId: string; userId: string; emoji: string }
  | { type: "PRESENCE_UPDATE"; userId: string; status: "online" | "offline" }
  | { type: "TYPING_START"; channelId: string; userId: string; username: string }
  | { type: "ERROR"; error: string };

export class Gateway {
  private ws: WebSocket;
  private listeners = new Set<(event: GatewayEvent) => void>();

  constructor(token: string) {
    this.ws = new WebSocket(`ws://localhost:8080/gateway?token=${token}`);
    this.ws.onmessage = (raw) => {
      const event = JSON.parse(raw.data) as GatewayEvent;
      for (const listener of this.listeners) listener(event);
    };
  }

  on(listener: (event: GatewayEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sendMessage(channelId: string, content: string, attachmentUrl?: string) {
    this.ws.send(JSON.stringify({ type: "MESSAGE_SEND", channelId, content, attachmentUrl }));
  }

  sendTyping(channelId: string) {
    this.ws.send(JSON.stringify({ type: "TYPING_START", channelId }));
  }

  editMessage(messageId: string, content: string) {
    this.ws.send(JSON.stringify({ type: "MESSAGE_EDIT", messageId, content }));
  }

  deleteMessage(messageId: string) {
    this.ws.send(JSON.stringify({ type: "MESSAGE_DELETE", messageId }));
  }

  addReaction(messageId: string, emoji: string) {
    this.ws.send(JSON.stringify({ type: "REACTION_ADD", messageId, emoji }));
  }

  removeReaction(messageId: string, emoji: string) {
    this.ws.send(JSON.stringify({ type: "REACTION_REMOVE", messageId, emoji }));
  }

  close() {
    this.ws.close();
  }
}
