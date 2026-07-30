import { useEffect, useRef, useState } from "react";
import {
  Channel,
  Gateway,
  Gif,
  InstanceInfo,
  Member,
  Message,
  Role,
  User,
  createChannel,
  getCurrentUser,
  getInstanceInfo,
  listMembers,
  listMessages,
  listRoles,
  uploadFile,
} from "./api";
import { VoicePanel } from "./VoicePanel";
import { useVoiceSession } from "./useVoiceSession";
import { MessageItem } from "./MessageItem";
import { Modal } from "./Modal";
import { AddServerModal } from "./AddServerModal";
import { UserSettingsModal } from "./UserSettingsModal";
import { InstanceSettingsModal } from "./InstanceSettingsModal";
import { EmojiPicker } from "./EmojiPicker";
import { GifPicker } from "./GifPicker";
import { MemberList } from "./MemberList";
import { SearchPanel } from "./SearchPanel";
import { PinnedMessagesPanel } from "./PinnedMessagesPanel";

// Matches a trailing "@partial" token in the text up to the cursor — used to
// drive the mention-autocomplete popover. Must be at the start of the text
// or preceded by whitespace, so email-like "user@host" text never triggers it.
function getMentionQuery(text: string, cursor: number): string | null {
  const upToCursor = text.slice(0, cursor);
  const match = upToCursor.match(/(?:^|\s)@([a-zA-Z0-9_]*)$/);
  return match ? match[1] : null;
}

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

function getInviteCodeFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("invite");
}

function App() {
  const [instances, setInstances] = useState<Instance[]>(loadInstances);
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>(
    () => localStorage.getItem("activeInstanceId"),
  );
  const [session, setSession] = useState<Session | null>(null);
  const [instanceInfo, setInstanceInfo] = useState<InstanceInfo | null>(null);
  // A shared invite link (`https://<instance>/?invite=CODE`) always points
  // back at the instance that issued it, so the address is just this page's
  // own origin — the recipient never has to know or type it. Must be read
  // via lazy useState initializers (not a useEffect) so it's already correct
  // on AddServerModal's very first mount — an effect runs one render too
  // late, after the child has already locked in its initial "address" step.
  const [addServerOpen, setAddServerOpen] = useState(() => !!getInviteCodeFromUrl());
  const [deepLinkInvite, setDeepLinkInvite] = useState<string | null>(getInviteCodeFromUrl);

  // Strip the query param once mounted so reloading/bookmarking afterward
  // doesn't re-trigger the same flow.
  useEffect(() => {
    if (deepLinkInvite) {
      window.history.replaceState({}, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  // channelId -> userIds currently connected to that voice channel. Tracked
  // app-side (not read from LiveKit) so the sidebar can show it for every
  // voice channel, not just the one this client happens to be in.
  const [voiceState, setVoiceState] = useState<Record<string, string[]>>({});
  // A lightweight, separate fetch from MemberList's own — small scale here,
  // not worth threading a shared cache through for just the sidebar's
  // voice-channel avatars.
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [typingByChannel, setTypingByChannel] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [newChannelName, setNewChannelName] = useState("");
  const [creatingChannelType, setCreatingChannelType] = useState<"TEXT" | "VOICE" | null>(null);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [gatewayGeneration, setGatewayGeneration] = useState(0);
  const [pendingAttachment, setPendingAttachment] = useState<{ url: string; name: string } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [openPicker, setOpenPicker] = useState<"emoji" | "gif" | null>(null);
  const [voiceDetailsOpen, setVoiceDetailsOpen] = useState(false);
  const draftInputRef = useRef<HTMLInputElement | null>(null);
  const [userSettingsOpen, setUserSettingsOpen] = useState(false);
  const [instanceSettingsOpen, setInstanceSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [replyTarget, setReplyTarget] = useState<Message | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const gatewayRef = useRef<Gateway | null>(null);
  const typingTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const activeInstance = instances.find((i) => i.id === activeInstanceId) ?? null;

  // Owns the LiveKit room for the whole app (not per-channel-view) so voice
  // stays connected while browsing other channels, and so the user-panel's
  // quick mute/deafen buttons have something to act on regardless of which
  // channel is currently selected.
  const voice = useVoiceSession(activeInstance?.baseUrl ?? "", session?.token ?? "", gatewayRef);

  // Load the active instance's stored session whenever it changes, then
  // refresh the cached user object from the server — a stale/incomplete
  // user object (e.g. from an endpoint that once forgot to return a field
  // like isOwner) shouldn't stay wrong until the next full login.
  useEffect(() => {
    if (!activeInstanceId) {
      setSession(null);
      return;
    }
    const stored = loadSession(activeInstanceId);
    setSession(stored);
    if (!stored || !activeInstance) return;
    getCurrentUser(activeInstance.baseUrl, stored.token)
      .then((user) => {
        const refreshed = { ...stored, user };
        setSession(refreshed);
        saveSession(activeInstanceId, refreshed);
      })
      .catch(() => {
        // Stale/expired token — leave the cached session as-is; the next
        // authenticated request will surface the real error.
      });
  }, [activeInstanceId, activeInstance?.baseUrl]);

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

    listMembers(activeInstance.baseUrl, session.token).then(setMembers).catch(() => {});
    listRoles(activeInstance.baseUrl, session.token).then(setRoles).catch(() => {});

    const unsubscribe = gateway.on((event) => {
      if (event.type === "READY") {
        setChannels(event.channels);
        setOnlineUserIds(new Set(event.onlineUserIds));
        setVoiceState(event.voiceState);
      } else if (event.type === "VOICE_STATE_UPDATE") {
        setVoiceState((prev) => ({ ...prev, [event.channelId]: event.userIds }));
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

  // Land new/returning users on the admin-configured default channel instead
  // of the bare "Select a channel" placeholder — fires once channels and
  // instance info have both loaded (order between the two isn't guaranteed),
  // and only while nothing is selected yet, so it never overrides a user's
  // own navigation.
  useEffect(() => {
    if (selectedChannelId || channels.length === 0 || !instanceInfo?.defaultChannelId) return;
    const exists = channels.some((c) => c.id === instanceInfo.defaultChannelId && c.type === "TEXT");
    if (exists) setSelectedChannelId(instanceInfo.defaultChannelId);
  }, [channels, instanceInfo, selectedChannelId]);

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
    voice.leave();
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
          <AddServerModal
            embedded
            initialBaseUrl={deepLinkInvite ? window.location.origin : undefined}
            initialInviteCode={deepLinkInvite ?? undefined}
            onConnected={handleConnected}
          />
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
    if (!newChannelName.trim() || !creatingChannelType || !session || !activeInstance) return;
    setChannelError(null);
    try {
      const channel = await createChannel(activeInstance.baseUrl, session.token, newChannelName.trim(), creatingChannelType);
      setChannels((prev) => [...prev, channel]);
      setNewChannelName("");
      setCreatingChannelType(null);
    } catch (err) {
      setChannelError((err as Error).message);
    }
  }

  function toggleCreatingChannel(type: "TEXT" | "VOICE") {
    setChannelError(null);
    setNewChannelName("");
    setCreatingChannelType((prev) => (prev === type ? null : type));
  }

  function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if ((!draft.trim() && !pendingAttachment) || !selectedChannelId || !gatewayRef.current) return;
    gatewayRef.current.sendMessage(selectedChannelId, draft.trim(), pendingAttachment?.url, replyTarget?.id);
    setDraft("");
    setPendingAttachment(null);
    setOpenPicker(null);
    setReplyTarget(null);
  }

  function handleTyping() {
    if (selectedChannelId) gatewayRef.current?.sendTyping(selectedChannelId);
  }

  function handleDraftChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setDraft(value);
    handleTyping();
    setMentionQuery(getMentionQuery(value, e.target.selectionStart ?? value.length));
  }

  // Replaces the "@partial" token the popover was opened for with the full
  // "@username " — recomputed from the live cursor position rather than a
  // stored index, since the draft may have changed since the popover opened.
  function handleMentionSelect(username: string) {
    const input = draftInputRef.current;
    const cursor = input?.selectionStart ?? draft.length;
    const upToCursor = draft.slice(0, cursor);
    const match = upToCursor.match(/(?:^|\s)@([a-zA-Z0-9_]*)$/);
    if (!match) return;
    const atIndex = upToCursor.length - match[1].length - 1;
    const before = draft.slice(0, atIndex);
    const after = draft.slice(cursor);
    const next = `${before}@${username} ${after}`;
    setDraft(next);
    setMentionQuery(null);
    const newCursor = before.length + username.length + 2;
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(newCursor, newCursor);
    });
  }

  // Inserts at the cursor position rather than just appending, so picking an
  // emoji mid-sentence doesn't jump the rest of the draft to the end.
  function handleEmojiSelect(emoji: string) {
    const input = draftInputRef.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + emoji + draft.slice(end);
    setDraft(next);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  }

  // Reuses the existing image-attachment plumbing — a GIF is just a URL
  // attachment as far as message sending is concerned.
  function handleGifSelect(gif: Gif) {
    setPendingAttachment({ url: gif.url, name: gif.title || "GIF" });
    setOpenPicker(null);
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
  const memberUsernames = new Set(members.map((m) => m.username));
  const currentMember = members.find((m) => m.userId === session.user.id);
  const canManageChannels =
    session.user.isOwner ||
    (currentMember?.roles.some((r) => roles.find((role) => role.id === r.id)?.permissions.includes("MANAGE_CHANNELS")) ?? false);
  const mentionMatches =
    mentionQuery !== null
      ? members.filter((m) => m.username.toLowerCase().startsWith(mentionQuery.toLowerCase())).slice(0, 8)
      : [];

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
              {instance.id === activeInstanceId && instanceInfo?.iconUrl ? (
                <img src={instanceInfo.iconUrl} alt="" />
              ) : (
                initials(instance.label)
              )}
            </button>
          </div>
        ))}
        <div className="rail-divider" />
        <button className="server-icon action" title="Add a Server" onClick={() => setAddServerOpen(true)}>
          +
        </button>
      </nav>

      {addServerOpen && (
        <Modal
          onClose={() => {
            setAddServerOpen(false);
            setDeepLinkInvite(null);
          }}
        >
          <AddServerModal
            initialBaseUrl={deepLinkInvite ? window.location.origin : undefined}
            initialInviteCode={deepLinkInvite ?? undefined}
            onConnected={handleConnected}
          />
          <div className="modal-actions">
            <button
              className="btn secondary"
              onClick={() => {
                setAddServerOpen(false);
                setDeepLinkInvite(null);
              }}
            >
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
          <div className="channel-category-row">
            <span className="channel-category">Text Channels</span>
            <button className="add-channel-btn" title="Add a text channel" onClick={() => toggleCreatingChannel("TEXT")}>
              +
            </button>
          </div>
          {creatingChannelType === "TEXT" && (
            <form onSubmit={handleCreateChannel} className="new-channel-form">
              <input
                autoFocus
                placeholder="channel name"
                value={newChannelName}
                onChange={(e) => setNewChannelName(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setCreatingChannelType(null)}
              />
            </form>
          )}
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

          <div className="channel-category-row">
            <span className="channel-category">Voice Channels</span>
            <button className="add-channel-btn" title="Add a voice channel" onClick={() => toggleCreatingChannel("VOICE")}>
              +
            </button>
          </div>
          {creatingChannelType === "VOICE" && (
            <form onSubmit={handleCreateChannel} className="new-channel-form">
              <input
                autoFocus
                placeholder="channel name"
                value={newChannelName}
                onChange={(e) => setNewChannelName(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setCreatingChannelType(null)}
              />
            </form>
          )}
          {voiceChannels.map((channel) => {
            const connectedUserIds = voiceState[channel.id] ?? [];
            const isMyChannel = voice.activeChannel?.id === channel.id;
            return (
              <div className="channel-row" key={channel.id}>
                <button
                  className={`channel-btn ${isMyChannel ? "active" : ""}`}
                  onClick={() => {
                    // Joining voice is a side effect, not "viewing" — it
                    // deliberately does NOT touch selectedChannelId, so
                    // whatever text channel is open stays open (previously
                    // this yanked the main pane over to VoicePanel).
                    if (!isMyChannel) voice.join(channel);
                    else setVoiceDetailsOpen((v) => !v);
                  }}
                >
                  <span className="channel-icon">🔊</span>
                  <span>{channel.name}</span>
                </button>
                {connectedUserIds.length > 0 && (
                  <div className="voice-channel-members">
                    {connectedUserIds.map((userId) => {
                      const member = members.find((m) => m.userId === userId);
                      const speaking = isMyChannel && voice.speakingUserIds.has(userId);
                      return (
                        <div key={userId} className="voice-member-row">
                          <span className={`voice-member-avatar ${speaking ? "speaking" : ""}`}>
                            {member?.avatarUrl ? (
                              <img src={member.avatarUrl} alt="" />
                            ) : (
                              <span className="avatar-placeholder">{(member?.username ?? "?")[0]?.toUpperCase()}</span>
                            )}
                          </span>
                          <span className="voice-member-name">{member?.username ?? userId}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {channelError && <p className="error">{channelError}</p>}
        </div>

        {voice.connected && (
          <div className="voice-status-bar-wrap">
            <div className="voice-status-bar" onClick={() => setVoiceDetailsOpen((v) => !v)}>
              <span>🔊 {voice.activeChannel?.name}</span>
              <button
                type="button"
                className="text-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  voice.leave();
                }}
              >
                Disconnect
              </button>
            </div>
            {voiceDetailsOpen && voice.activeChannel && (
              <div className="voice-details-popover">
                <VoicePanel channel={voice.activeChannel} session={voice} />
              </div>
            )}
          </div>
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
          <button
            className={`icon-btn ${voice.muted ? "active" : ""}`}
            title={voice.muted ? "Unmute" : "Mute"}
            onClick={voice.toggleMute}
          >
            {voice.muted ? "🔇" : "🎤"}
          </button>
          <button
            className={`icon-btn ${voice.deafened ? "active" : ""}`}
            title={voice.deafened ? "Undeafen" : "Deafen"}
            onClick={voice.toggleDeafen}
          >
            {voice.deafened ? "🔕" : "🎧"}
          </button>
          <button className="gear-btn" title="User Settings" onClick={() => setUserSettingsOpen(true)}>
            ⚙️
          </button>
        </div>
        <div ref={voice.audioContainerRef} style={{ display: "none" }} />
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
          channels={channels}
          onClose={() => setInstanceSettingsOpen(false)}
          onUpdated={(updated) => {
            setInstanceInfo(updated);
            document.documentElement.dataset.theme = updated.theme;
          }}
        />
      )}
      {searchOpen && (
        <SearchPanel
          baseUrl={activeInstance.baseUrl}
          token={session.token}
          currentChannelId={selectedChannelId}
          currentChannelName={selectedChannel?.name ?? null}
          onJump={(channelId) => setSelectedChannelId(channelId)}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {pinsOpen && selectedChannel && (
        <PinnedMessagesPanel
          baseUrl={activeInstance.baseUrl}
          token={session.token}
          channelId={selectedChannel.id}
          channelName={selectedChannel.name}
          onClose={() => setPinsOpen(false)}
        />
      )}

      <main className="chat-pane">
        {selectedChannel ? (
          <>
            <div className="chat-header">
              <span className="channel-icon">#</span>
              {selectedChannel.name}
              <button type="button" className="chat-header-icon-btn" title="Pinned Messages" onClick={() => setPinsOpen(true)}>
                📌
              </button>
              <button type="button" className="chat-header-icon-btn" title="Search" onClick={() => setSearchOpen(true)}>
                🔍
              </button>
            </div>
            <div className="messages">
              {channelMessages.map((m) => (
                <MessageItem
                  key={m.id}
                  message={m}
                  isOnline={onlineUserIds.has(m.authorId)}
                  currentUserId={session.user.id}
                  canModerate={canManageChannels}
                  memberUsernames={memberUsernames}
                  onEdit={(id, content) => gatewayRef.current?.editMessage(id, content)}
                  onDelete={(id) => gatewayRef.current?.deleteMessage(id)}
                  onReact={(id, emoji) => gatewayRef.current?.addReaction(id, emoji)}
                  onUnreact={(id, emoji) => gatewayRef.current?.removeReaction(id, emoji)}
                  onReply={(msg) => {
                    setReplyTarget(msg);
                    draftInputRef.current?.focus();
                  }}
                  onPin={(id) => gatewayRef.current?.pinMessage(id)}
                  onUnpin={(id) => gatewayRef.current?.unpinMessage(id)}
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
              {replyTarget && (
                <div className="reply-bar">
                  <span className="reply-arrow">↩</span>
                  <span className="reply-bar-target">
                    Replying to <span className="reply-bar-author">{replyTarget.authorUsername ?? "unknown"}</span> —{" "}
                    {replyTarget.content || "(attachment)"}
                  </span>
                  <button type="button" onClick={() => setReplyTarget(null)}>
                    ✕
                  </button>
                </div>
              )}
              {uploadError && <p className="error">{uploadError}</p>}
              {openPicker && (
                <div className="picker-popover">
                  {openPicker === "emoji" ? (
                    <EmojiPicker onSelect={handleEmojiSelect} />
                  ) : (
                    <GifPicker baseUrl={activeInstance.baseUrl} token={session.token} onSelect={handleGifSelect} />
                  )}
                </div>
              )}
              {mentionQuery !== null && mentionMatches.length > 0 && (
                <div className="mention-popover">
                  {mentionMatches.map((m) => (
                    <button
                      key={m.userId}
                      type="button"
                      className="mention-option"
                      onClick={() => handleMentionSelect(m.username)}
                    >
                      {m.username}
                    </button>
                  ))}
                </div>
              )}
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
                  ref={draftInputRef}
                  value={draft}
                  onChange={handleDraftChange}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && mentionQuery !== null) setMentionQuery(null);
                  }}
                  placeholder={`Message #${selectedChannel.name}`}
                />
                <button
                  type="button"
                  className="composer-icon-btn"
                  title="Emoji"
                  onClick={() => setOpenPicker((p) => (p === "emoji" ? null : "emoji"))}
                >
                  😀
                </button>
                {instanceInfo?.gifSearchEnabled && (
                  <button
                    type="button"
                    className="composer-icon-btn"
                    title="GIF"
                    onClick={() => setOpenPicker((p) => (p === "gif" ? null : "gif"))}
                  >
                    GIF
                  </button>
                )}
                <button type="submit">Send</button>
              </form>
            </div>
          </>
        ) : (
          <div className="chat-placeholder">Select a channel</div>
        )}
      </main>
      <MemberList baseUrl={activeInstance.baseUrl} token={session.token} onlineUserIds={onlineUserIds} />
    </div>
  );
}

export default App;
