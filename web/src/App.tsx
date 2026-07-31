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
  createThread,
  getCurrentUser,
  getInstanceInfo,
  getThread,
  listMembers,
  listMessages,
  listRoles,
  openDM,
  reorderChannels,
  uploadFile,
} from "./api";
import { VoicePanel } from "./VoicePanel";
import { useVoiceSession } from "./useVoiceSession";
import { MessageItem, messageIdentityKey } from "./MessageItem";
import { Modal } from "./Modal";
import { AddServerModal } from "./AddServerModal";
import { UserSettingsModal } from "./UserSettingsModal";
import { InstanceSettingsModal } from "./InstanceSettingsModal";
import { EmojiPicker } from "./EmojiPicker";
import { GifPicker } from "./GifPicker";
import { MemberList } from "./MemberList";
import { ProfileCard } from "./ProfileCard";
import { SearchPanel } from "./SearchPanel";
import { PinnedMessagesPanel } from "./PinnedMessagesPanel";
import { LeaderboardPanel } from "./LeaderboardPanel";
import { FriendsPanel } from "./FriendsPanel";

// Matches a trailing "@partial" token in the text up to the cursor — used to
// drive the mention-autocomplete popover. Must be at the start of the text
// or preceded by whitespace, so email-like "user@host" text never triggers it.
function getMentionQuery(text: string, cursor: number): string | null {
  const upToCursor = text.slice(0, cursor);
  const match = upToCursor.match(/(?:^|\s)@([a-zA-Z0-9_]*)$/);
  return match ? match[1] : null;
}

// Consecutive messages from the same author within this window collapse
// into one visual group (Discord-style) — same threshold Discord itself
// uses.
const MESSAGE_GROUP_WINDOW_MS = 7 * 60 * 1000;

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

// The official public instance, run by the Outpost project itself — offered
// as the default "Add a Server" address on a fresh install (no servers
// configured yet, no invite link) so a first-time user has something real
// to connect to instead of a blank address field. Purely a client-side
// default; nothing stops someone from typing a different address instead,
// and it's just as leave-able as any other added server.
const PRIMARY_SERVER_URL = "https://outpost.sonofatech.com";

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
  const [contextMenuInstanceId, setContextMenuInstanceId] = useState<string | null>(null);
  // Captured at click time and rendered via `position: fixed` — the server
  // rail has `overflow-y: auto`, which per the CSS spec implicitly clips the
  // x-axis too, so a menu positioned `absolute` relative to the icon (inside
  // the rail) gets silently clipped away instead of showing next to it.
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);
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
  // Set while selectedChannelId points at a THREAD channel — lets the
  // header show a "back to #parent" breadcrumb without needing a whole
  // separate view, since a thread is just rendered through the same
  // selectedChannelId-driven message list/composer as any other channel.
  const [threadParentId, setThreadParentId] = useState<string | null>(null);
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
  const [draggedChannelId, setDraggedChannelId] = useState<string | null>(null);
  const [memberListRefreshKey, setMemberListRefreshKey] = useState(0);
  const [dragOverChannelId, setDragOverChannelId] = useState<string | null>(null);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [gatewayGeneration, setGatewayGeneration] = useState(0);
  const [pendingAttachment, setPendingAttachment] = useState<{ url: string; name: string } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  const [forceDisconnectReason, setForceDisconnectReason] = useState<"kicked" | "banned" | null>(null);
  const [connectionState, setConnectionState] = useState<"connected" | "reconnecting" | "disconnected">("connected");
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [openPicker, setOpenPicker] = useState<"emoji" | "gif" | null>(null);
  const [voiceDetailsOpen, setVoiceDetailsOpen] = useState(false);
  const [memberListOpen, setMemberListOpen] = useState(() => localStorage.getItem("memberListOpen") === "true");
  useEffect(() => {
    localStorage.setItem("memberListOpen", String(memberListOpen));
  }, [memberListOpen]);
  const draftInputRef = useRef<HTMLInputElement | null>(null);
  const [userSettingsOpen, setUserSettingsOpen] = useState(false);
  const [viewingProfileUserId, setViewingProfileUserId] = useState<string | null>(null);
  const [instanceSettingsOpen, setInstanceSettingsOpen] = useState(false);
  const [friendsOpen, setFriendsOpen] = useState(false);
  const [friendsRefreshKey, setFriendsRefreshKey] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const [replyTarget, setReplyTarget] = useState<Message | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const gatewayRef = useRef<Gateway | null>(null);
  const typingTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const micPromptedRef = useRef(false);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // Whether the view should auto-scroll to the newest message — true unless
  // the user has scrolled up to read history, matching the usual chat-app
  // convention of not yanking someone back down mid-read. Reset to true on
  // every channel switch. A ref (not state) since it's only ever read
  // inside the scroll-follow effect, not rendered.
  const stickToBottomRef = useRef(true);
  const prevChannelIdRef = useRef<string | null>(null);

  // Follows new messages to the bottom, but only when the user was already
  // there — switching channels always jumps to the bottom of that
  // channel's most recent history regardless of where the previous
  // channel's scroll position was left. Every hook in this component has
  // to run unconditionally on every render (React's own rule), so this
  // lives up here before either of the early `return`s below rather than
  // next to the `channelMessages` it's conceptually paired with — hooks
  // called after a conditional return cause a real "rendered more/fewer
  // hooks than previous render" crash the moment that condition flips.
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const currentMessages = selectedChannelId ? messages[selectedChannelId] ?? [] : [];
    const channelChanged = prevChannelIdRef.current !== selectedChannelId;
    prevChannelIdRef.current = selectedChannelId;
    if (channelChanged) stickToBottomRef.current = true;
    if (channelChanged || stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    // currentMessages is read for its length/identity to know a new
    // message arrived — referencing it here (rather than only in the
    // dependency array) keeps eslint's exhaustive-deps reasoning honest.
    void currentMessages;
  }, [selectedChannelId, messages]);

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

  // Prompt for mic access right after login instead of waiting for the
  // first voice-channel join — asking cold mid-join was a rougher first
  // experience (click Join Voice, get interrupted by a permission popup,
  // audio briefly not working until it's granted). Fire-and-forget: the
  // stream is only requested to trigger the OS/browser permission prompt
  // and unlock device labels for enumerateDevices() (see
  // UserSettingsModal's Voice tab), then immediately released — actual
  // voice join still creates its own stream via LiveKit. Guarded by a ref
  // so it only ever fires once per app load, not on every reconnect.
  useEffect(() => {
    if (!session || micPromptedRef.current) return;
    micPromptedRef.current = true;
    navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((stream) => stream.getTracks().forEach((t) => t.stop()))
      .catch(() => {
        // Denied or no mic present — same fallback as the existing Voice
        // settings flow, nothing further to do here.
      });
  }, [session]);

  // Connect to the gateway once authenticated against the active instance.
  useEffect(() => {
    if (!session || !activeInstance) return;

    const gateway = new Gateway(activeInstance.baseUrl, session.token);
    gatewayRef.current = gateway;
    setConnectionState("connected");

    listMembers(activeInstance.baseUrl, session.token).then(setMembers).catch(() => {});
    listRoles(activeInstance.baseUrl, session.token).then(setRoles).catch(() => {});

    const unsubscribe = gateway.on((event) => {
      if (event.type === "READY") {
        setChannels([...event.channels, ...event.dmChannels]);
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
      } else if (event.type === "THREAD_CREATE") {
        setChannels((prev) => (prev.some((c) => c.id === event.thread.id) ? prev : [...prev, event.thread]));
        setMessages((prev) => ({
          ...prev,
          [event.thread.parentChannelId ?? ""]: (prev[event.thread.parentChannelId ?? ""] ?? []).map((m) =>
            m.id === event.parentMessageId
              ? { ...m, thread: { id: event.thread.id, name: event.thread.name, messageCount: 0 } }
              : m,
          ),
        }));
      } else if (event.type === "CHANNELS_UPDATE") {
        // The server only returns TEXT/VOICE channels here (THREAD and DM
        // channels are deliberately excluded, same as READY) — keep
        // whichever thread/DM channels this client already knows about
        // locally rather than dropping them.
        setChannels((prev) => [...event.channels, ...prev.filter((c) => c.type === "THREAD" || c.type === "DM")]);
      } else if (event.type === "DM_CHANNEL_CREATE") {
        setChannels((prev) => (prev.some((c) => c.id === event.channel.id) ? prev : [...prev, event.channel]));
      } else if (
        event.type === "FRIEND_REQUEST_RECEIVED" ||
        event.type === "FRIEND_REQUEST_ACCEPTED" ||
        event.type === "FRIEND_REMOVED"
      ) {
        // The panel (if open) re-fetches GET /friends off this bump rather
        // than each event hand-patching local state — request/accept/block
        // all have side effects on more than one list at once, so a full
        // refetch is simpler and this fires rarely enough that it's cheap.
        setFriendsRefreshKey((k) => k + 1);
      } else if (event.type === "FORCE_DISCONNECT") {
        // Kick or ban landed on this exact client — drop the stored session
        // for this instance (not the whole bookmark, unlike Leave Server)
        // and fall back to its login screen with a reason banner. A kick
        // leaves the account itself untouched, so logging back in works
        // immediately; a ban's account-level block kicks in server-side on
        // the next login attempt regardless of what happens here.
        if (activeInstanceId) localStorage.removeItem(`session:${activeInstanceId}`);
        setSession(null);
        setForceDisconnectReason(event.reason);
      } else if (event.type === "CONNECTION_STATE") {
        setConnectionState(event.state);
      } else if (event.type === "ERROR") {
        // Surfaces gateway-level rejections a user needs to see, chiefly
        // automod's own "banned word (warning N/M)" / mute messages — these
        // otherwise fail silently since the composer just doesn't get a new
        // message back.
        setComposerNotice(event.error);
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

  // Only removes this client's local record of the server (its bookmark +
  // stored session) — nothing server-side changes, so it's just as
  // reversible as adding it again via the same address. If it was the
  // active instance, falls back to whichever server is left, or back to
  // the "Add a Server" screen if none are.
  function leaveInstance(id: string) {
    localStorage.removeItem(`session:${id}`);
    setInstances((prev) => {
      const next = prev.filter((i) => i.id !== id);
      saveInstances(next);
      if (id === activeInstanceId) {
        const fallback = next[0]?.id ?? null;
        if (fallback) localStorage.setItem("activeInstanceId", fallback);
        else localStorage.removeItem("activeInstanceId");
        voice.leave();
        setActiveInstanceId(fallback);
        setSession(null);
        setSelectedChannelId(null);
        setChannels([]);
        setMessages({});
        setGatewayGeneration((g) => g + 1);
      }
      return next;
    });
    setContextMenuInstanceId(null);
  }

  if (instances.length === 0 || !activeInstance) {
    return (
      <div className="auth-screen">
        <div className="auth-form">
          <AddServerModal
            embedded
            initialBaseUrl={deepLinkInvite ? window.location.origin : PRIMARY_SERVER_URL}
            initialInviteCode={deepLinkInvite ?? undefined}
            onConnected={handleConnected}
          />
        </div>
      </div>
    );
  }

  if (!session) {
    // Bookmarked instance but no stored session — either it shouldn't
    // normally happen (a bookmark is only created after a successful
    // login/register), or a moderator just kicked/banned this exact client
    // (see the FORCE_DISCONNECT gateway handler above), in which case
    // forceDisconnectReason explains why they landed back here.
    return (
      <div className="auth-screen">
        <div className="auth-form">
          {forceDisconnectReason && (
            <p className="error force-disconnect-notice">
              {forceDisconnectReason === "banned"
                ? "You've been banned from this server."
                : "You've been disconnected by a moderator. You can log back in."}
            </p>
          )}
          <AddServerModal
            embedded
            initialBaseUrl={activeInstance.baseUrl}
            onConnected={(instance, newSession) => {
              setForceDisconnectReason(null);
              handleConnected(instance, newSession);
            }}
          />
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

  // Drops draggedId right before targetId within its own type's list —
  // text and voice channels reorder independently, matching how the
  // sidebar renders them as two separate sections. Updates local state
  // immediately (the drag needs to feel instant) and persists via the
  // reorder endpoint; other connected clients pick up the real order from
  // its CHANNELS_UPDATE broadcast rather than this optimistic update.
  async function handleChannelDrop(type: "TEXT" | "VOICE", draggedId: string, targetId: string) {
    setDraggedChannelId(null);
    setDragOverChannelId(null);
    if (draggedId === targetId || !activeInstance || !session) return;

    const sameType = channels.filter((c) => c.type === type);
    const otherTypes = channels.filter((c) => c.type !== type);
    const withoutDragged = sameType.filter((c) => c.id !== draggedId);
    const targetIndex = withoutDragged.findIndex((c) => c.id === targetId);
    const dragged = sameType.find((c) => c.id === draggedId);
    if (!dragged || targetIndex === -1) return;

    const reordered = [...withoutDragged.slice(0, targetIndex), dragged, ...withoutDragged.slice(targetIndex)];
    setChannels([...otherTypes, ...reordered]);

    try {
      await reorderChannels(activeInstance.baseUrl, session.token, type, reordered.map((c) => c.id));
    } catch (err) {
      setChannelError((err as Error).message);
    }
  }

  function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if ((!draft.trim() && !pendingAttachment) || !selectedChannelId || !gatewayRef.current) return;
    setComposerNotice(null);
    gatewayRef.current.sendMessage(selectedChannelId, draft.trim(), pendingAttachment?.url, replyTarget?.id);
    setDraft("");
    setPendingAttachment(null);
    setOpenPicker(null);
    setReplyTarget(null);
  }

  // Opens a message's existing thread, or creates one first if it doesn't
  // have one yet — either way ends by pointing selectedChannelId at the
  // thread channel, reusing the normal message list/composer for it.
  async function handleThreadClick(message: Message) {
    if (!activeInstance || !session) return;
    try {
      const thread = message.thread
        ? await getThread(activeInstance.baseUrl, session.token, message.id)
        : await createThread(activeInstance.baseUrl, session.token, message.id);
      setChannels((prev) => (prev.some((c) => c.id === thread.id) ? prev : [...prev, thread]));
      setThreadParentId(message.channelId);
      setSelectedChannelId(thread.id);
    } catch (err) {
      setChannelError((err as Error).message);
    }
  }

  async function handleOpenDM(userId: string) {
    if (!activeInstance || !session) return;
    try {
      const dm = await openDM(activeInstance.baseUrl, session.token, userId);
      setChannels((prev) => (prev.some((c) => c.id === dm.id) ? prev : [...prev, dm]));
      setSelectedChannelId(dm.id);
      setFriendsOpen(false);
    } catch (err) {
      setChannelError((err as Error).message);
    }
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

  function handleMessagesScroll() {
    const el = messagesContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 100;
  }
  const memberUsernames = new Set(members.map((m) => m.username));
  const currentMember = members.find((m) => m.userId === session.user.id);
  const canManageChannels =
    session.user.isOwner ||
    (currentMember?.roles.some((r) => roles.find((role) => role.id === r.id)?.permissions.includes("MANAGE_CHANNELS")) ?? false);
  const canManageRoles =
    session.user.isOwner ||
    (currentMember?.roles.some((r) => roles.find((role) => role.id === r.id)?.permissions.includes("MANAGE_ROLES")) ?? false);
  const canModerate =
    session.user.isOwner ||
    (currentMember?.roles.some((r) => roles.find((role) => role.id === r.id)?.permissions.includes("MODERATE_MEMBERS")) ?? false);
  const mentionMatches =
    mentionQuery !== null
      ? members.filter((m) => m.username.toLowerCase().startsWith(mentionQuery.toLowerCase())).slice(0, 8)
      : [];

  const textChannels = channels.filter((c) => c.type === "TEXT");
  const voiceChannels = channels.filter((c) => c.type === "VOICE");
  const dmChannels = channels.filter((c): c is Channel & { type: "DM"; otherUserId: string } => c.type === "DM") as (Channel & {
    otherUserId: string;
    otherUsername: string;
    otherAvatarUrl: string | null;
  })[];

  return (
    <div className={`app ${memberListOpen ? "" : "member-list-collapsed"}`}>
      {connectionState === "reconnecting" && (
        <div className="connection-banner">Reconnecting…</div>
      )}
      <nav className="server-rail">
        {instances.map((instance) => (
          <div key={instance.id} className={`server-icon-wrapper ${instance.id === activeInstanceId ? "active" : ""}`}>
            <div className="server-icon-pill" />
            <button
              className={`server-icon ${instance.id === activeInstanceId ? "active" : ""}`}
              title={instance.label}
              onClick={() => switchInstance(instance.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                setContextMenuPos({ x: rect.right + 8, y: rect.top });
                setContextMenuInstanceId(instance.id);
              }}
            >
              {instance.id === activeInstanceId && instanceInfo?.iconUrl ? (
                <img src={instanceInfo.iconUrl} alt="" />
              ) : (
                initials(instance.label)
              )}
            </button>
            {contextMenuInstanceId === instance.id && contextMenuPos && (
              <>
                <div className="server-context-backdrop" onClick={() => setContextMenuInstanceId(null)} />
                <div className="server-context-menu" style={{ left: contextMenuPos.x, top: contextMenuPos.y }}>
                  <div className="server-context-label">{instance.label}</div>
                  <button type="button" className="server-context-item danger" onClick={() => leaveInstance(instance.id)}>
                    Leave Server
                  </button>
                </div>
              </>
            )}
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
          {dmChannels.length > 0 && (
            <div className="channel-section dm-section">
              <div className="channel-category-row">
                <span className="channel-category">Direct Messages</span>
              </div>
              <div className="channel-section-list">
                {dmChannels.map((dm) => (
                  <div className="channel-row" key={dm.id}>
                    <button
                      className={`channel-btn ${dm.id === selectedChannelId ? "active" : ""}`}
                      onClick={() => setSelectedChannelId(dm.id)}
                    >
                      {dm.otherAvatarUrl ? (
                        <img className="avatar dm-avatar" src={dm.otherAvatarUrl} alt="" />
                      ) : (
                        <span className="avatar avatar-placeholder dm-avatar">{dm.otherUsername[0]?.toUpperCase()}</span>
                      )}
                      <span>{dm.otherUsername}</span>
                      <span className={`presence-dot ${onlineUserIds.has(dm.otherUserId) ? "online" : ""}`} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="channel-section text-channel-section">
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
            <div className="channel-section-list">
              {textChannels.map((channel) => (
                <div
                  className={`channel-row ${dragOverChannelId === channel.id ? "drag-over" : ""}`}
                  key={channel.id}
                  draggable={canManageChannels}
                  onDragStart={() => setDraggedChannelId(channel.id)}
                  onDragOver={(e) => {
                    if (!canManageChannels || !draggedChannelId) return;
                    e.preventDefault();
                    setDragOverChannelId(channel.id);
                  }}
                  onDragLeave={() => setDragOverChannelId((id) => (id === channel.id ? null : id))}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (draggedChannelId) handleChannelDrop("TEXT", draggedChannelId, channel.id);
                  }}
                  onDragEnd={() => {
                    setDraggedChannelId(null);
                    setDragOverChannelId(null);
                  }}
                >
                  <button
                    className={`channel-btn ${channel.id === selectedChannelId ? "active" : ""}`}
                    onClick={() => setSelectedChannelId(channel.id)}
                  >
                    <span className="channel-icon">#</span>
                    <span>{channel.name}</span>
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="channel-section voice-channel-section">
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
          <div className="channel-section-list">
          {voiceChannels.map((channel) => {
            const connectedUserIds = voiceState[channel.id] ?? [];
            const isMyChannel = voice.activeChannel?.id === channel.id;
            return (
              <div
                className={`channel-row ${dragOverChannelId === channel.id ? "drag-over" : ""}`}
                key={channel.id}
                draggable={canManageChannels}
                onDragStart={() => setDraggedChannelId(channel.id)}
                onDragOver={(e) => {
                  if (!canManageChannels || !draggedChannelId) return;
                  e.preventDefault();
                  setDragOverChannelId(channel.id);
                }}
                onDragLeave={() => setDragOverChannelId((id) => (id === channel.id ? null : id))}
                onDrop={(e) => {
                  e.preventDefault();
                  if (draggedChannelId) handleChannelDrop("VOICE", draggedChannelId, channel.id);
                }}
                onDragEnd={() => {
                  setDraggedChannelId(null);
                  setDragOverChannelId(null);
                }}
              >
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
          </div>
          </div>

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
      <div ref={voice.videoContainerRef} className="screen-share-overlay" />

      {userSettingsOpen && (
        <UserSettingsModal
          baseUrl={activeInstance.baseUrl}
          token={session.token}
          user={session.user}
          onClose={() => setUserSettingsOpen(false)}
          onSessionUpdate={handleSessionUpdate}
        />
      )}
      {viewingProfileUserId && (
        <ProfileCard
          baseUrl={activeInstance.baseUrl}
          token={session.token}
          userId={viewingProfileUserId}
          currentUserId={session.user.id}
          isOnline={onlineUserIds.has(viewingProfileUserId)}
          canManageRoles={canManageRoles}
          canModerate={canModerate}
          roles={roles}
          onClose={() => setViewingProfileUserId(null)}
          onEditProfile={() => {
            setViewingProfileUserId(null);
            setUserSettingsOpen(true);
          }}
          onMessage={(id) => {
            setViewingProfileUserId(null);
            handleOpenDM(id);
          }}
          onMemberChanged={() => setMemberListRefreshKey((k) => k + 1)}
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
      {leaderboardOpen && (
        <LeaderboardPanel baseUrl={activeInstance.baseUrl} token={session.token} onClose={() => setLeaderboardOpen(false)} />
      )}
      {friendsOpen && (
        <FriendsPanel
          baseUrl={activeInstance.baseUrl}
          token={session.token}
          refreshKey={friendsRefreshKey}
          onMessage={handleOpenDM}
          onClose={() => setFriendsOpen(false)}
        />
      )}

      <main className="chat-pane">
        {selectedChannel ? (
          <>
            <div className="chat-header">
              {selectedChannel.type === "THREAD" && threadParentId ? (
                <>
                  <button
                    type="button"
                    className="thread-back-btn"
                    title="Back to channel"
                    onClick={() => {
                      setSelectedChannelId(threadParentId);
                      setThreadParentId(null);
                    }}
                  >
                    ← {channels.find((c) => c.id === threadParentId)?.name ?? "channel"}
                  </button>
                  <span className="channel-icon">🧵</span>
                </>
              ) : (
                <span className="channel-icon">{selectedChannel.type === "DM" ? "💬" : "#"}</span>
              )}
              {selectedChannel.name}
              {selectedChannel.type !== "DM" && (
                <>
                  <button type="button" className="chat-header-icon-btn" title="Pinned Messages" onClick={() => setPinsOpen(true)}>
                    📌
                  </button>
                  <button type="button" className="chat-header-icon-btn" title="Search" onClick={() => setSearchOpen(true)}>
                    🔍
                  </button>
                  {instanceInfo?.levelingEnabled && (
                    <button type="button" className="chat-header-icon-btn" title="Leaderboard" onClick={() => setLeaderboardOpen(true)}>
                      🏆
                    </button>
                  )}
                  <button
                    type="button"
                    className={`chat-header-icon-btn ${memberListOpen ? "active" : ""}`}
                    title={memberListOpen ? "Hide Member List" : "Show Member List"}
                    onClick={() => setMemberListOpen((v) => !v)}
                  >
                    👥
                  </button>
                </>
              )}
            </div>
            <div className="messages" ref={messagesContainerRef} onScroll={handleMessagesScroll}>
              {channelMessages.map((m, i) => {
                const prev = channelMessages[i - 1];
                const grouped =
                  !!prev &&
                  !m.replyTo &&
                  messageIdentityKey(prev) === messageIdentityKey(m) &&
                  new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < MESSAGE_GROUP_WINDOW_MS;
                return (
                <MessageItem
                  key={m.id}
                  message={m}
                  grouped={grouped}
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
                  onViewProfile={setViewingProfileUserId}
                  onThreadClick={handleThreadClick}
                />
                );
              })}
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
              {composerNotice && (
                <p className="error composer-notice">
                  {composerNotice}
                  <button type="button" onClick={() => setComposerNotice(null)}>
                    ✕
                  </button>
                </p>
              )}
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
                  placeholder={selectedChannel.type === "DM" ? `Message @${selectedChannel.name}` : `Message #${selectedChannel.name}`}
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
      {memberListOpen && selectedChannel?.type !== "DM" && (
        <MemberList
          baseUrl={activeInstance.baseUrl}
          token={session.token}
          onlineUserIds={onlineUserIds}
          onSelectMember={setViewingProfileUserId}
          onOpenFriends={() => setFriendsOpen(true)}
          refreshKey={memberListRefreshKey}
        />
      )}
    </div>
  );
}

export default App;
