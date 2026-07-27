const BASE_URL = "http://localhost:8080";

export interface User {
  id: string;
  username: string;
  email: string;
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
  inviteCode: string;
  channels: Channel[];
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
  content: string;
  createdAt: string;
  editedAt?: string | null;
  reactions?: Reaction[];
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

  sendMessage(channelId: string, content: string) {
    this.ws.send(JSON.stringify({ type: "MESSAGE_SEND", channelId, content }));
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
