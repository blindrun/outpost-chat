import { useEffect, useMemo, useRef, useState } from "react";
import {
  Gateway,
  Message,
  Server,
  User,
  createChannel,
  createServer,
  joinByInvite,
  listMessages,
  listServers,
  login,
  register,
} from "./api";
import { VoicePanel } from "./VoicePanel";
import { MessageItem } from "./MessageItem";

interface Session {
  token: string;
  user: User;
}

function loadSession(): Session | null {
  const raw = localStorage.getItem("session");
  return raw ? JSON.parse(raw) : null;
}

function AuthForm({ onAuthed }: { onAuthed: (session: Session) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const result = mode === "login" ? await login(email, password) : await register(username, email, password);
      localStorage.setItem("session", JSON.stringify(result));
      onAuthed(result);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="auth-form">
      <h1>Discord Clone (dev)</h1>
      <form onSubmit={submit}>
        {mode === "register" && (
          <input placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        )}
        <input placeholder="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input
          placeholder="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit">{mode === "login" ? "Log in" : "Register"}</button>
      </form>
      {error && <p className="error">{error}</p>}
      <button className="link" onClick={() => setMode(mode === "login" ? "register" : "login")}>
        {mode === "login" ? "Need an account? Register" : "Have an account? Log in"}
      </button>
    </div>
  );
}

function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const [servers, setServers] = useState<Server[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  const [typingByChannel, setTypingByChannel] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [inviteInput, setInviteInput] = useState("");
  const [newServerName, setNewServerName] = useState("");
  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelType, setNewChannelType] = useState<"TEXT" | "VOICE">("TEXT");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [gatewayGeneration, setGatewayGeneration] = useState(0);
  const gatewayRef = useRef<Gateway | null>(null);
  const typingTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const selectedServer = useMemo(() => servers.find((s) => s.id === selectedServerId) ?? null, [servers, selectedServerId]);
  const selectedChannel = useMemo(
    () => selectedServer?.channels.find((c) => c.id === selectedChannelId) ?? null,
    [selectedServer, selectedChannelId],
  );

  // Connect to the gateway once authenticated.
  useEffect(() => {
    if (!session) return;
    listServers(session.token).then(setServers).catch(console.error);

    const gateway = new Gateway(session.token);
    gatewayRef.current = gateway;

    const unsubscribe = gateway.on((event) => {
      if (event.type === "READY") {
        setServers(event.servers);
        setOnlineUserIds(new Set(event.onlineUserIds));
      } else if (event.type === "MESSAGE_CREATE") {
        setMessages((prev) => ({
          ...prev,
          [event.message.channelId]: [...(prev[event.message.channelId] ?? []), event.message],
        }));
      } else if (event.type === "MESSAGE_UPDATE") {
        setMessages((prev) => ({
          ...prev,
          [event.message.channelId]: (prev[event.message.channelId] ?? []).map((m) =>
            m.id === event.message.id ? event.message : m,
          ),
        }));
      } else if (event.type === "MESSAGE_DELETE") {
        setMessages((prev) => ({
          ...prev,
          [event.channelId]: (prev[event.channelId] ?? []).filter((m) => m.id !== event.messageId),
        }));
      } else if (event.type === "REACTION_ADD") {
        setMessages((prev) => ({
          ...prev,
          [event.channelId]: (prev[event.channelId] ?? []).map((m) =>
            m.id === event.messageId
              ? {
                  ...m,
                  reactions: [
                    ...(m.reactions ?? []),
                    { id: `${event.messageId}-${event.userId}-${event.emoji}`, messageId: event.messageId, userId: event.userId, emoji: event.emoji, createdAt: new Date().toISOString() },
                  ],
                }
              : m,
          ),
        }));
      } else if (event.type === "REACTION_REMOVE") {
        setMessages((prev) => ({
          ...prev,
          [event.channelId]: (prev[event.channelId] ?? []).map((m) =>
            m.id === event.messageId
              ? { ...m, reactions: (m.reactions ?? []).filter((r) => !(r.userId === event.userId && r.emoji === event.emoji)) }
              : m,
          ),
        }));
      } else if (event.type === "PRESENCE_UPDATE") {
        setOnlineUserIds((prev) => {
          const next = new Set(prev);
          if (event.status === "online") next.add(event.userId);
          else next.delete(event.userId);
          return next;
        });
      } else if (event.type === "TYPING_START") {
        setTypingByChannel((prev) => ({ ...prev, [event.channelId]: event.username }));
        clearTimeout(typingTimeouts.current[event.channelId]);
        typingTimeouts.current[event.channelId] = setTimeout(() => {
          setTypingByChannel((prev) => {
            const next = { ...prev };
            delete next[event.channelId];
            return next;
          });
        }, 3000);
      }
    });

    return () => {
      unsubscribe();
      gateway.close();
    };
    // gatewayGeneration is bumped after creating/joining a server, forcing a
    // reconnect — the backend computes a socket's room membership once at
    // connect time, so a mid-session membership change needs a fresh connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, gatewayGeneration]);

  // Load message history whenever the selected channel changes.
  useEffect(() => {
    if (!session || !selectedChannelId) return;
    listMessages(session.token, selectedChannelId)
      .then((history) => setMessages((prev) => ({ ...prev, [selectedChannelId]: history })))
      .catch(console.error);
  }, [session, selectedChannelId]);

  if (!session) {
    return <AuthForm onAuthed={setSession} />;
  }

  async function handleCreateServer(e: React.FormEvent) {
    e.preventDefault();
    if (!newServerName.trim() || !session) return;
    const server = await createServer(session.token, newServerName.trim());
    setServers((prev) => [...prev, server]);
    setNewServerName("");
    setGatewayGeneration((g) => g + 1);
  }

  async function handleJoinInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteInput || !session) return;
    setJoinError(null);
    try {
      await joinByInvite(session.token, inviteInput.trim());
      const updated = await listServers(session.token);
      setServers(updated);
      setInviteInput("");
      setGatewayGeneration((g) => g + 1);
    } catch (err) {
      setJoinError((err as Error).message);
    }
  }

  async function handleCreateChannel(e: React.FormEvent) {
    e.preventDefault();
    if (!newChannelName.trim() || !selectedServerId || !session) return;
    setChannelError(null);
    try {
      const channel = await createChannel(session.token, selectedServerId, newChannelName.trim(), newChannelType);
      setServers((prev) =>
        prev.map((s) => (s.id === selectedServerId ? { ...s, channels: [...s.channels, channel] } : s)),
      );
      setNewChannelName("");
    } catch (err) {
      setChannelError((err as Error).message);
    }
  }

  function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || !selectedChannelId || !gatewayRef.current) return;
    gatewayRef.current.sendMessage(selectedChannelId, draft.trim());
    setDraft("");
  }

  function handleTyping() {
    if (selectedChannelId) gatewayRef.current?.sendTyping(selectedChannelId);
  }

  const channelMessages = selectedChannelId ? messages[selectedChannelId] ?? [] : [];
  const typingLabel = selectedChannelId ? typingByChannel[selectedChannelId] : null;

  return (
    <div className="app">
      <aside className="server-list">
        <h2>Servers</h2>
        <ul>
          {servers.map((server) => (
            <li key={server.id}>
              <button className={server.id === selectedServerId ? "active" : ""} onClick={() => setSelectedServerId(server.id)}>
                {server.name}
              </button>
            </li>
          ))}
        </ul>
        <form onSubmit={handleCreateServer} className="join-form">
          <input
            placeholder="new server name"
            value={newServerName}
            onChange={(e) => setNewServerName(e.target.value)}
          />
          <button type="submit">Create</button>
        </form>
        <form onSubmit={handleJoinInvite} className="join-form">
          <input placeholder="invite code" value={inviteInput} onChange={(e) => setInviteInput(e.target.value)} />
          <button type="submit">Join</button>
        </form>
        {joinError && <p className="error">{joinError}</p>}
        <p className="me">
          Signed in as <strong>{session.user.username}</strong>
        </p>
      </aside>

      {selectedServer && (
        <aside className="channel-list">
          <h3>{selectedServer.name}</h3>
          <p className="invite-code">Invite code: {selectedServer.inviteCode}</p>
          <ul>
            {selectedServer.channels.map((channel) => (
              <li key={channel.id}>
                <button
                  className={channel.id === selectedChannelId ? "active" : ""}
                  onClick={() => setSelectedChannelId(channel.id)}
                >
                  {channel.type === "VOICE" ? "🔊" : "#"} {channel.name}
                </button>
              </li>
            ))}
          </ul>
          <form onSubmit={handleCreateChannel} className="join-form">
            <input
              placeholder="new channel"
              value={newChannelName}
              onChange={(e) => setNewChannelName(e.target.value)}
            />
            <select value={newChannelType} onChange={(e) => setNewChannelType(e.target.value as "TEXT" | "VOICE")}>
              <option value="TEXT">Text</option>
              <option value="VOICE">Voice</option>
            </select>
            <button type="submit">+</button>
          </form>
          {channelError && <p className="error">{channelError}</p>}
        </aside>
      )}

      <main className="chat-pane">
        {selectedChannel && selectedChannel.type === "VOICE" ? (
          <VoicePanel token={session.token} channel={selectedChannel} />
        ) : selectedChannel ? (
          <>
            <h3>#{selectedChannel.name}</h3>
            <div className="messages">
              {channelMessages.map((m) => (
                <MessageItem
                  key={m.id}
                  message={m}
                  isOnline={onlineUserIds.has(m.authorId)}
                  currentUserId={session.user.id}
                  onEdit={(id, content) => gatewayRef.current?.editMessage(id, content)}
                  onDelete={(id) => gatewayRef.current?.deleteMessage(id)}
                  onReact={(id, emoji) => gatewayRef.current?.addReaction(id, emoji)}
                  onUnreact={(id, emoji) => gatewayRef.current?.removeReaction(id, emoji)}
                />
              ))}
            </div>
            {typingLabel && <p className="typing">{typingLabel} is typing…</p>}
            <form onSubmit={handleSend} className="send-form">
              <input
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  handleTyping();
                }}
                placeholder={`Message #${selectedChannel.name}`}
              />
              <button type="submit">Send</button>
            </form>
          </>
        ) : (
          <p>Select a channel</p>
        )}
      </main>
    </div>
  );
}

export default App;
