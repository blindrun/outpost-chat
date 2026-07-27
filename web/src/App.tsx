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
  uploadFile,
} from "./api";
import { VoicePanel } from "./VoicePanel";
import { MessageItem } from "./MessageItem";
import { Modal } from "./Modal";
import { UserSettingsModal } from "./UserSettingsModal";
import { ServerSettingsModal } from "./ServerSettingsModal";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

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
    <div className="auth-screen">
      <div className="auth-form">
        <h1>{mode === "login" ? "Welcome back!" : "Create an account"}</h1>
        <p className="subtitle">
          {mode === "login" ? "We're so excited to see you again!" : "Discord Clone (dev)"}
        </p>
        <form onSubmit={submit}>
          {mode === "register" && (
            <label>
              Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
          )}
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit">{mode === "login" ? "Log In" : "Register"}</button>
        </form>
        <button className="link" onClick={() => setMode(mode === "login" ? "register" : "login")}>
          {mode === "login" ? "Need an account? Register" : "Have an account? Log in"}
        </button>
      </div>
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
  const [pendingAttachment, setPendingAttachment] = useState<{ url: string; name: string } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [serverModalOpen, setServerModalOpen] = useState(false);
  const [serverModalTab, setServerModalTab] = useState<"create" | "join">("create");
  const [userSettingsOpen, setUserSettingsOpen] = useState(false);
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false);
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
    setServerModalOpen(false);
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
      setServerModalOpen(false);
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
    if ((!draft.trim() && !pendingAttachment) || !selectedChannelId || !gatewayRef.current) return;
    gatewayRef.current.sendMessage(selectedChannelId, draft.trim(), pendingAttachment?.url);
    setDraft("");
    setPendingAttachment(null);
  }

  function handleTyping() {
    if (selectedChannelId) gatewayRef.current?.sendTyping(selectedChannelId);
  }

  async function handleAttachmentSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !session) return;
    setUploadError(null);
    setUploadingAttachment(true);
    try {
      const { url } = await uploadFile(session.token, file);
      setPendingAttachment({ url, name: file.name });
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setUploadingAttachment(false);
    }
  }

  function handleSessionUpdate(update: { token?: string; user: User }) {
    if (!session) return;
    const updatedSession = { token: update.token ?? session.token, user: update.user };
    setSession(updatedSession);
    localStorage.setItem("session", JSON.stringify(updatedSession));
    // A new token (e.g. after a username change) means the gateway needs to
    // reconnect — it only reads `username` from the JWT at connect time.
    if (update.token) setGatewayGeneration((g) => g + 1);
  }

  const channelMessages = selectedChannelId ? messages[selectedChannelId] ?? [] : [];
  const typingLabel = selectedChannelId ? typingByChannel[selectedChannelId] : null;

  const textChannels = selectedServer?.channels.filter((c) => c.type === "TEXT") ?? [];
  const voiceChannels = selectedServer?.channels.filter((c) => c.type === "VOICE") ?? [];

  return (
    <div className="app">
      <nav className="server-rail">
        {servers.map((server) => (
          <div key={server.id} className={`server-icon-wrapper ${server.id === selectedServerId ? "active" : ""}`}>
            <div className="server-icon-pill" />
            <button
              className={`server-icon ${server.id === selectedServerId ? "active" : ""}`}
              title={server.name}
              onClick={() => setSelectedServerId(server.id)}
            >
              {initials(server.name)}
            </button>
          </div>
        ))}
        <div className="rail-divider" />
        <button
          className="server-icon action"
          title="Add a server"
          onClick={() => {
            setServerModalTab("create");
            setServerModalOpen(true);
          }}
        >
          +
        </button>
      </nav>

      {serverModalOpen && (
        <Modal onClose={() => setServerModalOpen(false)}>
          <div className="modal-tabs">
            <button className={serverModalTab === "create" ? "active" : ""} onClick={() => setServerModalTab("create")}>
              Create a Server
            </button>
            <button className={serverModalTab === "join" ? "active" : ""} onClick={() => setServerModalTab("join")}>
              Join a Server
            </button>
          </div>
          {serverModalTab === "create" ? (
            <form onSubmit={handleCreateServer}>
              <h2>Create your server</h2>
              <input
                placeholder="Server name"
                value={newServerName}
                onChange={(e) => setNewServerName(e.target.value)}
                autoFocus
              />
              <div className="modal-actions">
                <button type="button" className="btn secondary" onClick={() => setServerModalOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn">
                  Create
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleJoinInvite}>
              <h2>Join a server</h2>
              <input
                placeholder="Invite code"
                value={inviteInput}
                onChange={(e) => setInviteInput(e.target.value)}
                autoFocus
              />
              {joinError && <p className="error">{joinError}</p>}
              <div className="modal-actions">
                <button type="button" className="btn secondary" onClick={() => setServerModalOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn">
                  Join
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}

      <aside className="sidebar">
        {selectedServer ? (
          <>
            <div className="sidebar-header">
              <span>{selectedServer.name}</span>
              {selectedServer.ownerId === session.user.id && (
                <button className="gear-btn" title="Server Settings" onClick={() => setServerSettingsOpen(true)}>
                  ⚙️
                </button>
              )}
            </div>
            <div className="sidebar-scroll">
              <div className="invite-code-display">
                Invite: <code>{selectedServer.inviteCode ?? "none active"}</code>
              </div>

              {textChannels.length > 0 && <div className="channel-category">Text Channels</div>}
              {textChannels.map((channel) => (
                <div className="channel-row" key={channel.id}>
                  <button
                    className={`channel-btn ${channel.id === selectedChannelId ? "active" : ""}`}
                    onClick={() => setSelectedChannelId(channel.id)}
                  >
                    <span className="channel-icon">#</span>
                    <span>{channel.name}</span>
                  </button>
                </div>
              ))}

              {voiceChannels.length > 0 && <div className="channel-category">Voice Channels</div>}
              {voiceChannels.map((channel) => (
                <div className="channel-row" key={channel.id}>
                  <button
                    className={`channel-btn ${channel.id === selectedChannelId ? "active" : ""}`}
                    onClick={() => setSelectedChannelId(channel.id)}
                  >
                    <span className="channel-icon">🔊</span>
                    <span>{channel.name}</span>
                  </button>
                </div>
              ))}

              <div className="channel-category">New Channel</div>
              <form onSubmit={handleCreateChannel} className="new-channel-form">
                <input
                  placeholder="channel name"
                  value={newChannelName}
                  onChange={(e) => setNewChannelName(e.target.value)}
                />
                <select value={newChannelType} onChange={(e) => setNewChannelType(e.target.value as "TEXT" | "VOICE")}>
                  <option value="TEXT">Text</option>
                  <option value="VOICE">Voice</option>
                </select>
                <button type="submit" className="add-channel-btn">
                  +
                </button>
              </form>
              {channelError && <p className="error">{channelError}</p>}
            </div>
          </>
        ) : (
          <div className="sidebar-empty">Select or create a server to get started</div>
        )}

        <div className="user-panel">
          {session.user.avatarUrl ? (
            <img className="avatar" src={session.user.avatarUrl} alt="" />
          ) : (
            <span className="avatar avatar-placeholder">{session.user.username[0]?.toUpperCase()}</span>
          )}
          <div className="user-panel-info">
            <span className="user-panel-name">{session.user.username}</span>
          </div>
          <button className="gear-btn" title="User Settings" onClick={() => setUserSettingsOpen(true)}>
            ⚙️
          </button>
        </div>
      </aside>

      {userSettingsOpen && (
        <UserSettingsModal
          token={session.token}
          user={session.user}
          onClose={() => setUserSettingsOpen(false)}
          onSessionUpdate={handleSessionUpdate}
        />
      )}
      {serverSettingsOpen && selectedServer && (
        <ServerSettingsModal
          token={session.token}
          server={selectedServer}
          onClose={() => setServerSettingsOpen(false)}
          onUpdated={(updated) => setServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))}
        />
      )}

      <main className="chat-pane">
        {selectedChannel && selectedChannel.type === "VOICE" ? (
          <VoicePanel token={session.token} channel={selectedChannel} />
        ) : selectedChannel ? (
          <>
            <div className="chat-header">
              <span className="channel-icon">#</span>
              {selectedChannel.name}
            </div>
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
            <p className="typing">{typingLabel && `${typingLabel} is typing…`}</p>
            <div className="composer-area">
              {pendingAttachment && (
                <div className="attachment-preview">
                  📎 {pendingAttachment.name}
                  <button type="button" onClick={() => setPendingAttachment(null)}>
                    ✕
                  </button>
                </div>
              )}
              {uploadError && <p className="error">{uploadError}</p>}
              <form onSubmit={handleSend} className="send-form">
                <label className="attach-label">
                  {uploadingAttachment ? "…" : "📎"}
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={handleAttachmentSelect}
                    disabled={uploadingAttachment}
                  />
                </label>
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
            </div>
          </>
        ) : (
          <div className="chat-placeholder">Select a channel</div>
        )}
      </main>
    </div>
  );
}

export default App;
