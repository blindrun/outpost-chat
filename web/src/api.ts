export interface User {
  id: string;
  username: string;
  email: string;
  avatarUrl?: string | null;
  isOwner: boolean;
}

export interface Channel {
  id: string;
  name: string;
  type: "TEXT" | "VOICE";
  position: number;
}

export type Theme = "business" | "cyberpunk" | "hacker" | "esports";

export interface InstanceInfo {
  name: string;
  description: string | null;
  theme: Theme;
  requireInviteToRegister: boolean;
  hasOwner: boolean;
}

export interface Invite {
  id: string;
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

export function toWsUrl(baseUrl: string): string {
  return baseUrl.replace(/^http/, "ws");
}

async function request<T>(baseUrl: string, path: string, token: string | null, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
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

export function getInstanceInfo(baseUrl: string) {
  return request<InstanceInfo>(baseUrl, "/instance-info", null);
}

export function register(baseUrl: string, username: string, email: string, password: string, inviteCode?: string) {
  return request<{ token: string; user: User }>(baseUrl, "/auth/register", null, {
    method: "POST",
    body: JSON.stringify({ username, email, password, ...(inviteCode ? { inviteCode } : {}) }),
  });
}

export function login(baseUrl: string, email: string, password: string) {
  return request<{ token: string; user: User }>(baseUrl, "/auth/login", null, {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function listInvites(baseUrl: string, token: string) {
  return request<Invite[]>(baseUrl, "/invites", token);
}

export function createInvite(baseUrl: string, token: string, opts: { maxUses?: number; expiresInSeconds?: number }) {
  return request<Invite>(baseUrl, "/invites", token, {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

export function revokeInvite(baseUrl: string, token: string, inviteId: string) {
  return request<void>(baseUrl, `/invites/${inviteId}`, token, { method: "DELETE" });
}

export function createChannel(baseUrl: string, token: string, name: string, type: "TEXT" | "VOICE") {
  return request<Channel>(baseUrl, "/channels", token, {
    method: "POST",
    body: JSON.stringify({ name, type }),
  });
}

export function listMessages(baseUrl: string, token: string, channelId: string) {
  return request<Message[]>(baseUrl, `/channels/${channelId}/messages`, token);
}

export function getVoiceToken(baseUrl: string, token: string, channelId: string) {
  return request<{ token: string; url: string }>(baseUrl, `/channels/${channelId}/voice-token`, token, {
    method: "POST",
  });
}

export async function uploadFile(baseUrl: string, token: string, file: File): Promise<{ url: string }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${baseUrl}/uploads`, {
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

export function setAvatar(baseUrl: string, token: string, avatarUrl: string) {
  return request<User>(baseUrl, "/auth/me/avatar", token, { method: "PATCH", body: JSON.stringify({ avatarUrl }) });
}

export function updateProfile(baseUrl: string, token: string, updates: { username?: string; email?: string }) {
  return request<{ token: string; user: User }>(baseUrl, "/auth/me", token, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export function updatePassword(baseUrl: string, token: string, currentPassword: string, newPassword: string) {
  return request<void>(baseUrl, "/auth/me/password", token, {
    method: "PATCH",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export function updateInstanceSettings(
  baseUrl: string,
  token: string,
  updates: { name?: string; description?: string; theme?: Theme; requireInviteToRegister?: boolean },
) {
  return request<InstanceInfo>(baseUrl, "/instance/settings", token, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export function listMembers(baseUrl: string, token: string) {
  return request<Member[]>(baseUrl, "/members", token);
}

export function listRoles(baseUrl: string, token: string) {
  return request<Role[]>(baseUrl, "/roles", token);
}

export function createRole(baseUrl: string, token: string, name: string, permissions: Permission[]) {
  return request<Role>(baseUrl, "/roles", token, {
    method: "POST",
    body: JSON.stringify({ name, permissions }),
  });
}

export function assignRole(baseUrl: string, token: string, userId: string, roleId: string) {
  return request<void>(baseUrl, `/members/${userId}/roles`, token, {
    method: "POST",
    body: JSON.stringify({ roleId }),
  });
}

type GatewayEvent =
  | { type: "READY"; channels: Channel[]; onlineUserIds: string[] }
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

  constructor(baseUrl: string, token: string) {
    this.ws = new WebSocket(`${toWsUrl(baseUrl)}/gateway?token=${token}`);
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
