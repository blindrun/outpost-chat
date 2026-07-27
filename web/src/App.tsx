import { useEffect, useRef, useState } from "react";
import { Channel, Gateway, InstanceInfo, Message, User, createChannel, getInstanceInfo, listMessages, uploadFile } from "./api";
import { VoicePanel } from "./VoicePanel";
import { MessageItem } from "./MessageItem";
import { Modal } from "./Modal";
import { AddServerModal } from "./AddServerModal";
import { UserSettingsModal } from "./UserSettingsModal";
import { InstanceSettingsModal } from "./InstanceSettingsModal";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export interface Instance {
  id: string;
  label: string;
  baseUrl: string;
}

export interface Session {
  token: string;
  user: User;
}

function loadInstances(): Instance[] {
  const raw = localStorage.getItem("instances");
  return raw ? JSON.parse(raw) : [];
}

function saveInstances(instances: Instance[]) {
  localStorage.setItem("instances", JSON.stringify(instances));
}

function loadSession(instanceId: string): Session | null {
  const raw = localStorage.getItem(`session:${instanceId}`);
  return raw ? JSON.parse(raw) : null;
}

function saveSession(instanceId: string, session: Session) {
  localStorage.setItem(`session:${instanceId}`, JSON.stringify(session));
}

function App() {
  const [instances, setInstances] = useState<Instance[]>(loadInstances);
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>(
    () => localStorage.getItem("activeInstanceId"),
  );
  const [session, setSession] = useState<Session | null>(null);
  const [instanceInfo, setInstanceInfo] = useState<InstanceInfo | null>(null);
  const [addServerOpen, setAddServerOpen] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  const [typingByChannel, setTypingByChannel] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelType, setNewChannelType] = useState<"TEXT" | "VOICE">("TEXT");
  const [channelError, setChannelError] = useState<string | null>(null);
  const [gatewayGeneration, setGatewayGeneration] = useState(0);
  const [pendingAttachment, setPendingAttachment] = useState<{ url: string; name: string } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [userSettingsOpen, setUserSettingsOpen] = useState(false);
  const [instanceSettingsOpen, setInstanceSettingsOpen] = useState(false);
  const gatewayRef = useRef<Gateway | null>(null);
  const typingTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const activeInstance = instances.find((i) => i.id === activeInstanceId) ?? null;

  // Load the active instance's stored session whenever it changes.
  useEffect(() => {
    if (!activeInstanceId) {
      setSession(null);
      return;
    }
    setSession(loadSession(activeInstanceId));
  }, [activeInstanceId]);

  // Apply the active instance's theme to the whole document — this runs even
  // before login (from the unauthenticated /instance-info probe) so the
  // login/register screen itself reflects the instance's chosen identity.
  useEffect(() => {
    if (!activeInstance) {
      document.documentElement.removeAttribute("data-theme");
      setInstanceInfo(null);
      return;
    }
    getInstanceInfo(activeInstance.baseUrl)
      .then((info) => {
        setInstanceInfo(info);
        document.documentElement.dataset.theme = info.theme;
      })
      .catch(console.error);
  }, [activeInstance?.baseUrl]);

  // Connect to the gateway once authenticated against the active instance.
  useEffect(() => {
    if (!session || !activeInstance) return;

    const gateway = new Gateway(activeInstance.baseUrl, session.token);
    gatewayRef.current = gateway;

    const unsubscribe = gateway.on((event) => {
      if (event.type === "READY") {
        setChannels(event.channels);
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
    // gatewayGeneration is bumped after switching active instance or a token
    // reissue, forcing a reconnect — the backend computes a socket's identity
    // once at connect time, so a mid-session change needs a fresh connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, activeInstance?.baseUrl, gatewayGeneration]);

  // Load message history whenever the selected channel changes.
  useEffect(() => {
    if (!session || !activeInstance || !selectedChannelId) return;
    listMessages(activeInstance.baseUrl, session.token, selectedChannelId)
      .then((history) => setMessages((prev) => ({ ...prev, [selectedChannelId]: history })))
      .catch(console.error);
  }, [session, activeInstance?.baseUrl, selectedChannelId]);

  function handleConnected(instance: Instance, newSession: Session) {
    setInstances((prev) => {
      const existing = prev.find((i) => i.baseUrl === instance.baseUrl);
      const resolvedId = existing?.id ?? instance.id;
      const next = existing ? prev : [...prev, instance];
      if (!existing) saveInstances(next);
      saveSession(resolvedId, newSession);
      localStorage.setItem("activeInstanceId", resolvedId);
      setActiveInstanceId(resolvedId);
      return next;
    });
    setSession(newSession);
    setAddServerOpen(false);
    setGatewayGeneration((g) => g + 1);
  }

  function switchInstance(id: string) {
    localStorage.setItem("activeInstanceId", id);
    setActiveInstanceId(id);
    setSelectedChannelId(null);
    setChannels([]);
    setMessages({});
    setGatewayGeneration((g) => g + 1);
  }

  if (instances.length === 0 || !activeInstance) {
    return (
      <div className="auth-screen">
        <div className="auth-form">
          <AddServerModal embedded onConnected={handleConnected} />
        </div>
      </div>
    );
  }

  if (!session) {
    // Bookmarked instance but no stored session (shouldn't normally happen —
    // a bookmark is only created after a successful login/register).
    return (
      <div className="auth-screen">
        <div className="auth-form">
          <AddServerModal embedded initialBaseUrl={activeInstance.baseUrl} onConnected={handleConnected} />
        </div>
      </div>
    );
  }

  async function handleCreateChannel(e: React.FormEvent) {
    e.preventDefault();
    if (!newChannelName.trim() || !session || !activeInstance) return;
    setChannelError(null);
    try {
      const channel = await createChannel(activeInstance.baseUrl, session.token, newChannelName.trim(), newChannelType);
      setChannels((prev) => [...prev, channel]);
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
    if (!file || !session || !activeInstance) return;
    setUploadError(null);
    setUploadingAttachment(true);
    try {
      const { url } = await uploadFile(activeInstance.baseUrl, session.token, file);
      setPendingAttachment({ url, name: file.name });
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setUploadingAttachment(false);
    }
  }

  function handleSessionUpdate(update: { token?: string; user: User }) {
    if (!session || !activeInstanceId) return;
    const updatedSession = { token: update.token ?? session.token, user: update.user };
    setSession(updatedSession);
    saveSession(activeInstanceId, updatedSession);
    // A new token (e.g. after a username change) means the gateway needs to
    // reconnect — it only reads `username` from the JWT at connect time.
    if (update.token) setGatewayGeneration((g) => g + 1);
  }

  const selectedChannel = channels.find((c) => c.id === selectedChannelId) ?? null;
  const channelMessages = selectedChannelId ? messages[selectedChannelId] ?? [] : [];
  const typingLabel = selectedChannelId ? typingByChannel[selectedChannelId] : null;

  const textChannels = channels.filter((c) => c.type === "TEXT");
  const voiceChannels = channels.filter((c) => c.type === "VOICE");

  return (
    <div className="app">
      <nav className="server-rail">
        {instances.map((instance) => (
          <div key={instance.id} className={`server-icon-wrapper ${instance.id === activeInstanceId ? "active" : ""}`}>
            <div className="server-icon-pill" />
            <button
              className={`server-icon ${instance.id === activeInstanceId ? "active" : ""}`}
              title={instance.label}
              onClick={() => switchInstance(instance.id)}
            >
              {initials(instance.label)}
            </button>
          </div>
        ))}
        <div className="rail-divider" />
        <button className="server-icon action" title="Add a Server" onClick={() => setAddServerOpen(true)}>
          +
        </button>
      </nav>

      {addServerOpen && (
        <Modal onClose={() => setAddServerOpen(false)}>
          <AddServerModal onConnected={handleConnected} />
          <div className="modal-actions">
            <button className="btn secondary" onClick={() => setAddServerOpen(false)}>
              Close
            </button>
          </div>
        </Modal>
      )}

      <aside className="sidebar">
        <div className="sidebar-header">
          <span>{instanceInfo?.name ?? activeInstance.label}</span>
          {session.user.isOwner && (
            <button className="gear-btn" title="Instance Settings" onClick={() => setInstanceSettingsOpen(true)}>
              ⚙️
            </button>
          )}
        </div>
        <div className="sidebar-scroll">
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
            <input placeholder="channel name" value={newChannelName} onChange={(e) => setNewChannelName(e.target.value)} />
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
          baseUrl={activeInstance.baseUrl}
          token={session.token}
          user={session.user}
          onClose={() => setUserSettingsOpen(false)}
          onSessionUpdate={handleSessionUpdate}
        />
      )}
      {instanceSettingsOpen && instanceInfo && (
        <InstanceSettingsModal
          baseUrl={activeInstance.baseUrl}
          token={session.token}
          instanceInfo={instanceInfo}
          onClose={() => setInstanceSettingsOpen(false)}
          onUpdated={(updated) => {
            setInstanceInfo(updated);
            document.documentElement.dataset.theme = updated.theme;
          }}
        />
      )}

      <main className="chat-pane">
        {selectedChannel && selectedChannel.type === "VOICE" ? (
          <VoicePanel baseUrl={activeInstance.baseUrl} token={session.token} channel={selectedChannel} />
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
