import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  Channel,
  DMChannel,
  ApiError,
  CustomEmoji,
  Gateway,
  Gif,
  InstanceInfo,
  Member,
  Message,
  Permission,
  Role,
  User,
  authedMediaUrl,
  createChannel,
  createThread,
  getCurrentUser,
  getInstanceInfo,
  getThread,
  kickFromVoice,
  listCustomEmoji,
  listMembers,
  listMessages,
  listRoles,
  markChannelRead,
  openDM,
  reorderChannels,
  uploadFile,
} from "./api";
import { VoicePanel } from "./VoicePanel";
import { clearCachedIcon, loadCachedIcon, refreshInstanceIcon } from "./instanceIcons";
import { DmCryptoState, decryptForDm, encryptForDm, resolveDmCrypto } from "./crypto/dm";
import { useVoiceSession } from "./useVoiceSession";
import { playVoiceJoinSound, playVoiceLeaveSound } from "./voiceSounds";
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
import { ReportModal } from "./ReportModal";
import { buildAcceptAttribute, UPLOAD_CATEGORIES, UPLOAD_CATEGORY_KEYS } from "./uploadCategories";

// Matches a trailing "@partial" token in the text up to the cursor — used to
// drive the mention-autocomplete popover. Must be at the start of the text
// or preceded by whitespace, so email-like "user@host" text never triggers it.
function getMentionQuery(text: string, cursor: number): string | null {
  const upToCursor = text.slice(0, cursor);
  const match = upToCursor.match(/(?:^|\s)@([a-zA-Z0-9_]*)$/);
  return match ? match[1] : null;
}

// Same trailing-token approach as getMentionQuery, for a "#partial" channel
// token instead of "@partial".
function getChannelMentionQuery(text: string, cursor: number): string | null {
  const upToCursor = text.slice(0, cursor);
  const match = upToCursor.match(/(?:^|\s)#([a-zA-Z0-9_-]*)$/);
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

// A password-reset email link (`https://<instance>/?reset=TOKEN`) is
// same-origin, just like an invite link above, so it's handled the same
// way: read once, strip from the URL, no need for the recipient to know or
// type the instance's address.
function getResetTokenFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("reset");
}

// Where an identity provider drops the user after a successful sign-in
// (`?oidc=CODE`) or a failed one (`?oidc_error=MESSAGE`). Same-origin like
// the two above, because the instance's own server is what redirected here.
function getOidcCodeFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("oidc");
}

function getOidcErrorFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("oidc_error");
}

// The official public instance, run by the Outpost project itself — offered
// as the default "Add a Server" address on a fresh install (no servers
// configured yet, no invite link) so a first-time user has something real
// to connect to instead of a blank address field. Purely a client-side
// default; nothing stops someone from typing a different address instead,
// and it's just as leave-able as any other added server.
const PRIMARY_SERVER_URL = "https://outpost.sonofatech.com";

// Long enough to read a name without turning a busy channel into a wall of
// notices — several people arriving at once each get their own, stacked.
const VOICE_TOAST_MS = 4000;

// Longer than a voice toast: this one is asking a moderator to go and do
// something, not narrating what just happened in a channel they're watching.
const REPORT_TOAST_MS = 8000;

function App() {
  const [instances, setInstances] = useState<Instance[]>(loadInstances);
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>(
    () => localStorage.getItem("activeInstanceId"),
  );
  const [session, setSession] = useState<Session | null>(null);
  const [instanceInfo, setInstanceInfo] = useState<InstanceInfo | null>(null);
  // instanceId -> cached icon data URL, seeded synchronously from
  // localStorage so the rail paints every server's real icon on first frame
  // rather than flashing initials while a fetch resolves.
  const [instanceIcons, setInstanceIcons] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const instance of loadInstances()) {
      const cached = loadCachedIcon(instance.id);
      if (cached) seed[instance.id] = cached;
    }
    return seed;
  });
  // A shared invite link (`https://<instance>/?invite=CODE`) always points
  // back at the instance that issued it, so the address is just this page's
  // own origin — the recipient never has to know or type it. Must be read
  // via lazy useState initializers (not a useEffect) so it's already correct
  // on AddServerModal's very first mount — an effect runs one render too
  // late, after the child has already locked in its initial "address" step.
  const [addServerOpen, setAddServerOpen] = useState(
    () => !!getInviteCodeFromUrl() || !!getResetTokenFromUrl() || !!getOidcCodeFromUrl() || !!getOidcErrorFromUrl(),
  );
  const [contextMenuInstanceId, setContextMenuInstanceId] = useState<string | null>(null);
  // Captured at click time and rendered via `position: fixed` — the server
  // rail has `overflow-y: auto`, which per the CSS spec implicitly clips the
  // x-axis too, so a menu positioned `absolute` relative to the icon (inside
  // the rail) gets silently clipped away instead of showing next to it.
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [deepLinkInvite, setDeepLinkInvite] = useState<string | null>(getInviteCodeFromUrl);
  const [deepLinkReset, setDeepLinkReset] = useState<string | null>(getResetTokenFromUrl);
  const [deepLinkOidc, setDeepLinkOidc] = useState<string | null>(getOidcCodeFromUrl);
  const [deepLinkOidcError, setDeepLinkOidcError] = useState<string | null>(getOidcErrorFromUrl);

  // Strip the query param once mounted so reloading/bookmarking afterward
  // doesn't re-trigger the same flow. It matters most for the SSO code:
  // that one is a credential, and leaving it in the address bar leaves it
  // in history and in anything the user pastes the URL into.
  useEffect(() => {
    if (deepLinkInvite || deepLinkReset || deepLinkOidc || deepLinkOidcError) {
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
  // Transient "X joined/left the voice channel" notices, for the channel this
  // client is actually connected to. Only ever for *other* people — your own
  // join/leave already has direct UI feedback.
  const [voiceToasts, setVoiceToasts] = useState<{ id: number; userId: string; kind: "joined" | "left" }[]>([]);
  const voiceToastSeqRef = useRef(0);
  // The message the report dialog is open for, if any. Reporting a member
  // without a specific message goes through their profile card instead,
  // which owns its own dialog.
  const [reportTarget, setReportTarget] = useState<Message | null>(null);
  // Moderators only: a report just came in. Same transient-notice treatment
  // as the voice toasts above, since the queue itself lives behind two
  // clicks in Instance Settings and would otherwise go unnoticed.
  const [reportToasts, setReportToasts] = useState<{ id: number; text: string }[]>([]);
  // Encryption state for the currently open DM, and the plaintext of every
  // encrypted message decrypted so far (null = we hold no key that can read
  // it, which is a permanent state rather than a transient failure).
  const [dmCrypto, setDmCrypto] = useState<DmCryptoState>({ active: false });
  const [decrypted, setDecrypted] = useState<Record<string, string | null>>({});
  const [roles, setRoles] = useState<Role[]>([]);
  const [customEmoji, setCustomEmoji] = useState<CustomEmoji[]>([]);
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
  const [forceDisconnectReason, setForceDisconnectReason] = useState<"kicked" | "banned" | "account_deleted" | "session_expired" | null>(
    null,
  );
  const [connectionState, setConnectionState] = useState<"connected" | "reconnecting" | "disconnected">("connected");
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [openPicker, setOpenPicker] = useState<"emoji" | "gif" | null>(null);
  const [voiceDetailsOpen, setVoiceDetailsOpen] = useState(false);
  // Whether the call is what's on screen. Clicking the voice channel opens
  // it; clicking any text channel leaves it and gives chat the whole pane.
  // Leaving the view never touches the connection -- voice, video and screen
  // share keep running, and coming back shows them still going.
  const [callViewOpen, setCallViewOpen] = useState(false);
  // Mirrors the browser's own fullscreen state rather than tracking our own
  // boolean: the user can leave fullscreen with Escape or the browser's
  // chrome without touching our button, and a local flag would then be
  // wrong with no event to correct it.
  const [videoFullscreen, setVideoFullscreen] = useState(false);
  const [memberListOpen, setMemberListOpen] = useState(() => localStorage.getItem("memberListOpen") === "true");
  // Which full-screen pane is showing on a mobile-width viewport (desktop
  // shows all of these as grid columns at once, so this is a no-op there —
  // see the mobile media query in index.css). Not persisted: always start
  // on the nav pane, since there's no selected channel yet on first load
  // (one auto-selects shortly after channels fetch, at which point
  // selectChannel flips this to "chat").
  const [mobileActivePane, setMobileActivePane] = useState<"nav" | "chat" | "members">("nav");
  const longPressTimerRef = useRef<number | null>(null);
  // Shared by every place a channel/DM gets selected (sidebar click, DM
  // click, search-result jump) so picking one on mobile always returns to
  // the chat pane — setting mobileActivePane is a harmless no-op on
  // desktop widths, so no viewport check is needed here.
  function selectChannel(channelId: string) {
    setSelectedChannelId(channelId);
    setMobileActivePane("chat");
    // Picking something to read means you want to read it, so the call view
    // gets out of the way and chat takes the whole pane. The call itself is
    // untouched -- still connected, still sending video -- and clicking the
    // voice channel brings the view straight back.
    setCallViewOpen(false);
  }
  const [textChannelsCollapsed, setTextChannelsCollapsed] = useState(
    () => localStorage.getItem("textChannelsCollapsed") === "true",
  );
  const [voiceChannelsCollapsed, setVoiceChannelsCollapsed] = useState(
    () => localStorage.getItem("voiceChannelsCollapsed") === "true",
  );
  const [dmChannelsCollapsed, setDmChannelsCollapsed] = useState(
    () => localStorage.getItem("dmChannelsCollapsed") === "true",
  );

  function toggleTextChannelsCollapsed() {
    setTextChannelsCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("textChannelsCollapsed", String(next));
      return next;
    });
  }

  function toggleVoiceChannelsCollapsed() {
    setVoiceChannelsCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("voiceChannelsCollapsed", String(next));
      return next;
    });
  }

  function toggleDmChannelsCollapsed() {
    setDmChannelsCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("dmChannelsCollapsed", String(next));
      return next;
    });
  }

  // Session-only "has a message arrived here since I last had it open" set —
  // not persisted (a fresh page load starts clean), and not based on a
  // server-tracked read cursor at all; it just flips on for a channel/DM the
  // moment a MESSAGE_CREATE lands anywhere but the currently open one, and
  // clears the moment that channel/DM is selected. Deliberately reuses the
  // same green presence-dot styling, just re-keyed off "unread" instead of
  // "online" (see the sidebar rows below).
  const [unreadChannelIds, setUnreadChannelIds] = useState<Set<string>>(new Set());
  // The gateway's connect effect only re-runs on [session, activeInstance,
  // gatewayGeneration] (see below) — it does NOT re-run when
  // selectedChannelId changes, so its MESSAGE_CREATE handler would otherwise
  // close over a stale, connect-time value of selectedChannelId forever.
  // Mirrored into a ref so the handler always reads the current selection.
  const selectedChannelIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedChannelIdRef.current = selectedChannelId;
  }, [selectedChannelId]);
  // Same staleness problem as selectedChannelIdRef above, for the voice
  // channel this client is currently connected to — mirrored into a ref so
  // the gateway effect's VOICE_STATE_UPDATE handler (set up once, not
  // re-run on every join/leave) always reads the live value instead of
  // whatever it was at connect time.
  const activeVoiceChannelIdRef = useRef<string | null>(null);
  // Mirrors voiceState purely so the join/leave-sound diff below has a
  // side-effect-free read of "who was in this channel before" — doing that
  // read inside the setVoiceState updater itself would run the diff (and
  // the sounds it triggers) twice under StrictMode's dev-only double-invoke.
  const voiceStateRef = useRef<Record<string, string[]>>({});
  useEffect(() => {
    voiceStateRef.current = voiceState;
  }, [voiceState]);
  useEffect(() => {
    localStorage.setItem("memberListOpen", String(memberListOpen));
  }, [memberListOpen]);
  const draftInputRef = useRef<HTMLTextAreaElement | null>(null);
  // Grows the composer with its content — reset to "auto" first so it can
  // shrink back down too (e.g. after sending), not just grow. CSS max-height
  // + overflow-y:auto caps how tall this can get regardless of scrollHeight.
  useEffect(() => {
    const el = draftInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
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
  const [channelMentionQuery, setChannelMentionQuery] = useState<string | null>(null);
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

  // A message with an image/GIF attachment lands in the DOM before its
  // <img> has actually loaded, so scrollHeight above is measured before
  // the attachment has any real height — the scroll-to-bottom math runs
  // too early and nothing re-checks once the image finishes loading and
  // pushes the container taller. `load` doesn't bubble, but it does fire
  // during the capture phase at ancestors, so a single capture-phase
  // listener on the container catches every attachment's load without
  // needing MessageItem to know anything about scrolling.
  //
  // Re-attaches on every selectedChannelId change (not just once on
  // mount) because .messages only exists in the DOM once a channel is
  // actually selected — on first load selectedChannel is null, so
  // messagesContainerRef.current is still null the one time an
  // empty-deps effect would have run, and it would never have gotten
  // another chance to attach the listener at all.
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    function handleContentLoad() {
      if (stickToBottomRef.current) el!.scrollTop = el!.scrollHeight;
    }
    el.addEventListener("load", handleContentLoad, true);
    return () => el.removeEventListener("load", handleContentLoad, true);
  }, [selectedChannelId]);

  const activeInstance = instances.find((i) => i.id === activeInstanceId) ?? null;

  // Owns the LiveKit room for the whole app (not per-channel-view) so voice
  // stays connected while browsing other channels, and so the user-panel's
  // quick mute/deafen buttons have something to act on regardless of which
  // channel is currently selected.
  const voice = useVoiceSession(activeInstance?.baseUrl ?? "", session?.token ?? "", gatewayRef);
  useEffect(() => {
    activeVoiceChannelIdRef.current = voice.activeChannel?.id ?? null;
  }, [voice.activeChannel?.id]);

  // Discord-style AFK move — client-driven rather than a server timer,
  // since only this client actually knows its own speaking history
  // (LiveKit audio activity isn't visible server-side at all; see
  // afkChannelId's comment in schema.prisma). isLocalUserSpeaking is
  // deliberately a boolean, not the raw speakingUserIds Set, so this only
  // resets the timer when *this* user's own speaking state flips — someone
  // else talking in the same channel shouldn't keep this client out of AFK.
  const isLocalUserSpeaking = !!session && voice.speakingUserIds.has(session.user.id);
  useEffect(() => {
    if (!instanceInfo?.afkChannelId || !instanceInfo.afkTimeoutMinutes) return;
    if (!voice.activeChannel || voice.activeChannel.id === instanceInfo.afkChannelId) return;
    if (isLocalUserSpeaking) return;

    const timer = setTimeout(() => {
      const afkChannel = channels.find((c) => c.id === instanceInfo.afkChannelId && c.type === "VOICE");
      if (afkChannel) voice.join(afkChannel);
    }, instanceInfo.afkTimeoutMinutes * 60_000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLocalUserSpeaking, voice.activeChannel?.id, instanceInfo?.afkChannelId, instanceInfo?.afkTimeoutMinutes, channels]);

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
      .catch((err) => {
        // A 401 here means the stored token is no longer good for this
        // instance — the account was deleted, the server's JWT_SECRET was
        // rotated, or the database was restored from before the account
        // existed. Keeping the session was the old behaviour, on the theory
        // that "the next authenticated request will surface the real
        // error". Nothing ever did: every later request failed the same
        // silent way, leaving the app half-loaded with panels spinning
        // forever and no route back except clearing site data by hand.
        //
        // Only on 401. A network failure throws without a status, and being
        // offline for a moment must not sign anyone out.
        if (err instanceof ApiError && err.status === 401) {
          localStorage.removeItem(`session:${activeInstanceId}`);
          setSession(null);
          setForceDisconnectReason("session_expired");
        }
      });
  }, [activeInstanceId, activeInstance?.baseUrl]);

  // Nothing to look at once the call ends, and leaving the view open would
  // strand the user on an empty pane with the sidebar as the only way out.
  useEffect(() => {
    if (!voice.connected && callViewOpen) setCallViewOpen(false);
  }, [voice.connected, callViewOpen]);

  useEffect(() => {
    const onChange = () => setVideoFullscreen(document.fullscreenElement === voice.videoContainerRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [voice.videoContainerRef]);

  // The last feed ending while fullscreen would leave the user staring at a
  // black screen with no obvious way back, so drop out of it for them.
  useEffect(() => {
    if (voice.videoFeedCount === 0 && document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }, [voice.videoFeedCount]);

  const toggleVideoFullscreen = useCallback(() => {
    const el = voice.videoContainerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    el.requestFullscreen().catch((err) => console.warn("fullscreen refused:", err));
  }, [voice.videoContainerRef]);

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

  // Resolve whether the open DM is encrypted. Derived from `channels` rather
  // than the `selectedChannel` const, which is computed further down — after
  // this component's early returns, so anything depending on it can't live in
  // a hook.
  useEffect(() => {
    const channel = channels.find((c) => c.id === selectedChannelId);
    const peerId = channel?.type === "DM" ? (channel as DMChannel).otherUserId : null;
    if (!peerId || !activeInstanceId) {
      setDmCrypto({ active: false });
      return;
    }
    let cancelled = false;
    const peer = members.find((m) => m.userId === peerId);
    resolveDmCrypto(activeInstanceId, peerId, peer?.publicKey)
      .then((state) => !cancelled && setDmCrypto(state))
      .catch(() => !cancelled && setDmCrypto({ active: false }));
    return () => {
      cancelled = true;
    };
  }, [channels, selectedChannelId, activeInstanceId, members]);

  // Decrypt anything encrypted that hasn't been decrypted yet, including the
  // bodies of quoted reply targets. Keyed by message id and kept across
  // channel switches so scrolling back doesn't redo the work.
  useEffect(() => {
    if (!dmCrypto.key || !selectedChannelId) return;
    const pending = (messages[selectedChannelId] ?? []).flatMap((m) => {
      const items: { id: string; payload: string }[] = [];
      if (m.encryptedPayload && decrypted[m.id] === undefined) items.push({ id: m.id, payload: m.encryptedPayload });
      if (m.replyTo?.encryptedPayload && decrypted[m.replyTo.id] === undefined) {
        items.push({ id: m.replyTo.id, payload: m.replyTo.encryptedPayload });
      }
      return items;
    });
    if (pending.length === 0) return;

    let cancelled = false;
    Promise.all(
      pending.map(async (item) => [item.id, await decryptForDm(dmCrypto.key, item.payload)] as const),
    ).then((results) => {
      if (cancelled) return;
      setDecrypted((prev) => {
        const next = { ...prev };
        for (const [id, text] of results) next[id] = text;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [messages, selectedChannelId, dmCrypto.key, decrypted]);

  // Keep every bookmarked server's cached icon fresh, not just the active
  // one's — the whole point is that the rail can draw a server you aren't
  // currently signed in to. Runs on mount and whenever the bookmark list
  // changes; each server is refreshed with its own stored token, since that's
  // the only credential its private upload route will accept. Failures are
  // silent by design (see instanceIcons.ts) — a server being down must not
  // blank an icon that's already cached.
  useEffect(() => {
    let cancelled = false;
    for (const instance of instances) {
      const stored = loadSession(instance.id);
      if (!stored) continue;
      refreshInstanceIcon(instance.id, instance.baseUrl, stored.token)
        .then((dataUrl) => {
          if (cancelled || !dataUrl) return;
          setInstanceIcons((prev) => ({ ...prev, [instance.id]: dataUrl }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [instances]);

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
    listCustomEmoji(activeInstance.baseUrl, session.token).then(setCustomEmoji).catch(() => {});

    const unsubscribe = gateway.on((event) => {
      if (event.type === "READY") {
        setChannels([...event.channels, ...event.dmChannels]);
        setOnlineUserIds(new Set(event.onlineUserIds));
        setVoiceState(event.voiceState);
        // READY fires on every reconnect, not just the initial connect (the
        // Gateway instance reconnects internally on its own backoff timer).
        // Presence/channels/voice all get a fresh snapshot above, but the
        // already-loaded message list for the open channel doesn't — so a
        // MESSAGE_DELETE/MESSAGE_UPDATE that happened during the disconnect
        // window (mobile app backgrounded, laptop slept, brief WiFi drop)
        // was silently missed forever. Refetch it here to close that gap.
        const currentChannelId = selectedChannelIdRef.current;
        // unreadChannelIds is real, persisted state now (see
        // ChannelReadState) — seeded fresh on every READY instead of
        // resetting to empty on reload like it used to. The one exception
        // is whatever channel is currently open: the user is looking right
        // at it, so it's never shown unread, and re-marking it read keeps
        // the server's copy fresh too (covers the reconnect-while-viewing
        // case, where time passed without the channel-select effect below
        // re-firing).
        setUnreadChannelIds(new Set(event.unreadChannelIds.filter((id) => id !== currentChannelId)));
        if (currentChannelId) {
          listMessages(activeInstance.baseUrl, session.token, currentChannelId)
            .then((history) => setMessages((prev) => ({ ...prev, [currentChannelId]: history })))
            .catch(console.error);
          markChannelRead(activeInstance.baseUrl, session.token, currentChannelId).catch(console.error);
        }
      } else if (event.type === "VOICE_STATE_UPDATE") {
        // A sound only makes sense for the voice channel this client is
        // actually in — a join/leave in some other voice channel isn't
        // something you'd hear in a real room. Diffed against
        // voiceStateRef (this event always carries the full current list,
        // not a delta) rather than inside the setVoiceState updater below,
        // so the diff — and the sounds it triggers — can't run twice under
        // StrictMode's dev-only double-invoke of updater functions. Never
        // sounded for the local user's own join/leave, which already has
        // its own UI feedback.
        if (event.channelId === activeVoiceChannelIdRef.current) {
          const previousIds = voiceStateRef.current[event.channelId] ?? [];
          const joined = event.userIds.filter((id) => id !== session.user.id && !previousIds.includes(id));
          const left = previousIds.filter((id) => id !== session.user.id && !event.userIds.includes(id));
          if (joined.length > 0) playVoiceJoinSound();
          if (left.length > 0) playVoiceLeaveSound();

          // The sound alone tells you *something* happened but not who, and
          // it's easy to miss entirely if your volume is low. Stores the user
          // id rather than a rendered string so the name is resolved at paint
          // time — the member list may not have loaded yet when this fires,
          // and resolving here would freeze in whatever the closure saw.
          const arrivals = [
            ...joined.map((userId) => ({ userId, kind: "joined" as const })),
            ...left.map((userId) => ({ userId, kind: "left" as const })),
          ];
          if (arrivals.length > 0) {
            const entries = arrivals.map((a) => ({ ...a, id: ++voiceToastSeqRef.current }));
            setVoiceToasts((prev) => [...prev, ...entries]);
            for (const entry of entries) {
              setTimeout(() => {
                setVoiceToasts((prev) => prev.filter((t) => t.id !== entry.id));
              }, VOICE_TOAST_MS);
            }
          }
        }
        setVoiceState((prev) => ({ ...prev, [event.channelId]: event.userIds }));
      } else if (event.type === "MESSAGE_CREATE") {
        setMessages((prev) => ({
          ...prev,
          [event.message.channelId]: [...(prev[event.message.channelId] ?? []), event.message],
        }));
        if (
          event.message.channelId !== selectedChannelIdRef.current &&
          event.message.authorId !== session.user.id
        ) {
          setUnreadChannelIds((prev) =>
            prev.has(event.message.channelId) ? prev : new Set(prev).add(event.message.channelId),
          );
        }
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
      } else if (event.type === "REPORT_CREATE") {
        // The server only sends this to moderators, so there's no permission
        // check to repeat here. Deliberately says who was reported and why
        // but not what was said — the content lives in the queue, behind the
        // same permission, rather than on screen wherever this lands.
        const id = ++voiceToastSeqRef.current;
        const text = `${event.report.reporterUsername} reported ${event.report.targetUsername}`;
        setReportToasts((prev) => [...prev, { id, text }]);
        setTimeout(() => setReportToasts((prev) => prev.filter((t) => t.id !== id)), REPORT_TOAST_MS);
      } else if (event.type === "FORCE_DISCONNECT") {
        // Kick or ban landed on this exact client — drop the stored session
        // for this instance (not the whole bookmark, unlike Leave Server)
        // and fall back to its login screen with a reason banner. A kick
        // leaves the account itself untouched, so logging back in works
        // immediately; a ban's account-level block kicks in server-side on
        // the next login attempt regardless of what happens here.
        //
        // Account deletion is the exception: it arrives on this user's
        // *other* tabs/devices (the one that initiated it already tore
        // itself down), and there's no account left to log back into, so it
        // drops the bookmark outright the same way Leave Server does.
        if (event.reason === "account_deleted") {
          setForceDisconnectReason("account_deleted");
          if (activeInstanceId) leaveInstance(activeInstanceId);
          return;
        }
        if (activeInstanceId) localStorage.removeItem(`session:${activeInstanceId}`);
        setSession(null);
        setForceDisconnectReason(event.reason);
      } else if (event.type === "VOICE_KICKED") {
        // A moderator removed this client from just the voice channel it
        // was in — the server already updated presence bookkeeping and
        // broadcast VOICE_STATE_UPDATE to everyone else; voice.leave() is
        // what actually tears down this client's own LiveKit connection,
        // since nothing else would (the leave wasn't self-initiated).
        voice.leave();
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

  // Opening a channel/DM is what "reads" it — clears its unread flag
  // regardless of which of the several places in this file set
  // selectedChannelId (a sidebar click, the default-channel landing effect,
  // a mention/reply jump, ...) rather than needing every call site to
  // remember to do this itself.
  useEffect(() => {
    if (!selectedChannelId) return;
    setUnreadChannelIds((prev) => {
      if (!prev.has(selectedChannelId)) return prev;
      const next = new Set(prev);
      next.delete(selectedChannelId);
      return next;
    });
    // Persists the same "read" moment server-side (see ChannelReadState) so
    // it survives a reload/new session instead of resetting to empty every
    // time, which is what happened before this existed.
    if (session && activeInstance) {
      markChannelRead(activeInstance.baseUrl, session.token, selectedChannelId).catch(console.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChannelId]);

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
    clearCachedIcon(id);
    setInstanceIcons((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
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
          {/* Deleting your account drops its bookmark, which lands most
              people here (one bookmarked server is the common case) rather
              than on the per-instance login screen below — so the notice has
              to exist on both, or the last bookmark would just silently
              vanish. */}
          {forceDisconnectReason === "account_deleted" && (
            <p className="error force-disconnect-notice">Your account on that server has been deleted.</p>
          )}
          <AddServerModal
            embedded
            initialBaseUrl={
              deepLinkInvite || deepLinkReset || deepLinkOidc || deepLinkOidcError
                ? window.location.origin
                : PRIMARY_SERVER_URL
            }
            initialInviteCode={deepLinkInvite ?? undefined}
            initialResetToken={deepLinkReset ?? undefined}
            initialOidcCode={deepLinkOidc ?? undefined}
            initialOidcError={deepLinkOidcError ?? undefined}
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
                : forceDisconnectReason === "account_deleted"
                  ? "Your account on this server has been deleted."
                  : forceDisconnectReason === "session_expired"
                    ? "This server no longer recognises your sign-in — please log in again."
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

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if ((!draft.trim() && !pendingAttachment) || !selectedChannelId || !gatewayRef.current) return;
    setComposerNotice(null);

    const text = draft.trim();
    // Cleared before the await so a slow encrypt can't leave the composer
    // holding text the user already "sent", or let a second Enter send twice.
    setDraft("");
    setPendingAttachment(null);
    setOpenPicker(null);
    setReplyTarget(null);

    let encryptedPayload: string | undefined;
    if (dmCrypto.active && dmCrypto.key && text) {
      try {
        encryptedPayload = await encryptForDm(dmCrypto.key, text);
      } catch {
        // Never silently downgrade to plaintext: someone who turned this on
        // would have no way to know the message went out in the clear.
        setComposerNotice("Couldn't encrypt that message, so it wasn't sent.");
        setDraft(text);
        return;
      }
    }

    gatewayRef.current.sendMessage(
      selectedChannelId,
      encryptedPayload ? "" : text,
      pendingAttachment?.url,
      replyTarget?.id,
      encryptedPayload,
    );
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
      selectChannel(dm.id);
      setFriendsOpen(false);
    } catch (err) {
      setChannelError((err as Error).message);
    }
  }

  function handleTyping() {
    if (selectedChannelId) gatewayRef.current?.sendTyping(selectedChannelId);
  }

  function handleDraftChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setDraft(value);
    handleTyping();
    const cursor = e.target.selectionStart ?? value.length;
    setMentionQuery(getMentionQuery(value, cursor));
    setChannelMentionQuery(getChannelMentionQuery(value, cursor));
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

  // Same replace-the-trailing-token approach as handleMentionSelect, for a
  // "#channel-name" token instead of "@username".
  function handleChannelMentionSelect(channelName: string) {
    const input = draftInputRef.current;
    const cursor = input?.selectionStart ?? draft.length;
    const upToCursor = draft.slice(0, cursor);
    const match = upToCursor.match(/(?:^|\s)#([a-zA-Z0-9_-]*)$/);
    if (!match) return;
    const hashIndex = upToCursor.length - match[1].length - 1;
    const before = draft.slice(0, hashIndex);
    const after = draft.slice(cursor);
    const next = `${before}#${channelName} ${after}`;
    setDraft(next);
    setChannelMentionQuery(null);
    const newCursor = before.length + channelName.length + 2;
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
  const rawChannelMessages = selectedChannelId ? messages[selectedChannelId] ?? [] : [];
  // MessageItem renders `content` and knows nothing about encryption; the
  // substitution happens here so there's exactly one place where ciphertext
  // becomes text, and every downstream feature (grouping, search highlight,
  // reply quotes) keeps working unchanged.
  const channelMessages = rawChannelMessages.map((m) => {
    if (!m.encryptedPayload && !m.replyTo?.encryptedPayload) return m;
    const resolve = (id: string, payload: string | null | undefined, fallback: string) => {
      if (!payload) return fallback;
      const text = decrypted[id];
      if (text === undefined) return "Decrypting…";
      // Undecryptable is permanent, not transient: it means this device holds
      // no key that can read it — they rotated, or this identity was restored
      // from a different recovery code. Saying so beats an empty message.
      return text ?? "🔒 Can't decrypt this message on this device";
    };
    return {
      ...m,
      content: resolve(m.id, m.encryptedPayload, m.content),
      ...(m.replyTo
        ? { replyTo: { ...m.replyTo, content: resolve(m.replyTo.id, m.replyTo.encryptedPayload, m.replyTo.content) } }
        : {}),
    };
  });
  const typingLabel = selectedChannelId ? typingByChannel[selectedChannelId] : null;

  function handleMessagesScroll() {
    const el = messagesContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 100;
  }
  const memberUsernames = new Set(members.map((m) => m.username));
  const usernameByUserId = new Map(members.map((m) => [m.userId, m.username]));
  const customEmojiByName = new Map(customEmoji.map((e) => [e.name, e.imageUrl]));

  function refreshCustomEmoji() {
    if (!activeInstance || !session) return;
    listCustomEmoji(activeInstance.baseUrl, session.token).then(setCustomEmoji).catch(() => {});
  }
  const currentMember = members.find((m) => m.userId === session.user.id);
  const isOwner = session.user.isOwner;
  const hasPerm = (permission: Permission): boolean =>
    isOwner ||
    (currentMember?.roles.some((r) => roles.find((role) => role.id === r.id)?.permissions.includes(permission)) ?? false);
  const canManageChannels = hasPerm("MANAGE_CHANNELS");
  const canManageRoles = hasPerm("MANAGE_ROLES");
  const canManageServer = hasPerm("MANAGE_SERVER");
  const canModerate = hasPerm("MODERATE_MEMBERS");
  const myUploadCategories = UPLOAD_CATEGORY_KEYS.filter((cat) => hasPerm(UPLOAD_CATEGORIES[cat].permission));
  const mentionMatches =
    mentionQuery !== null
      ? members.filter((m) => m.username.toLowerCase().startsWith(mentionQuery.toLowerCase())).slice(0, 8)
      : [];

  const textChannels = channels.filter((c) => c.type === "TEXT");
  // Scoped to TEXT channels only — a #channel-mention is a "jump here" link,
  // and a voice channel isn't a place text navigation lands the same way.
  const channelIdByName = new Map(textChannels.map((c) => [c.name, c.id]));
  const channelMentionMatches =
    channelMentionQuery !== null
      ? textChannels.filter((c) => c.name.toLowerCase().startsWith(channelMentionQuery.toLowerCase())).slice(0, 8)
      : [];
  const voiceChannels = channels.filter((c) => c.type === "VOICE");
  const dmChannels = channels.filter((c): c is Channel & { type: "DM"; otherUserId: string } => c.type === "DM") as (Channel & {
    otherUserId: string;
    otherUsername: string;
    otherAvatarUrl: string | null;
  })[];
  // Same unreadChannelIds set the DM sidebar rows already key off of,
  // re-mapped from channel id to the other participant's user id so the
  // Friends list can show the same "unread" dot next to a friend, not just
  // in the sidebar.
  const unreadFriendUserIds = new Set(
    dmChannels.filter((dm) => unreadChannelIds.has(dm.id)).map((dm) => dm.otherUserId),
  );

  return (
    <div className={`app mobile-pane-${mobileActivePane} ${memberListOpen ? "" : "member-list-collapsed"}${callViewOpen && voice.connected ? " call-view" : ""}`}>
      {connectionState === "reconnecting" && (
        <div className="connection-banner">Reconnecting…</div>
      )}
      {/* Rendered here, as a direct child of .app, rather than inside the
          sidebar next to the voice panel — .sidebar is position:absolute with
          z-index:1 on mobile, which makes it a stacking context that would
          bury these under the server rail exactly like the voice popover was
          (see the mobile .voice-details-popover rules). */}
      {(voiceToasts.length > 0 || reportToasts.length > 0) && (
        <div className="voice-toasts">
          {voiceToasts.map((toast) => (
            <div key={toast.id} className={`voice-toast ${toast.kind}`}>
              <strong>{usernameByUserId.get(toast.userId) ?? "Someone"}</strong>
              {toast.kind === "joined" ? " joined the voice channel" : " left the voice channel"}
            </div>
          ))}
          {reportToasts.map((toast) => (
            <button
              key={`report-${toast.id}`}
              className="voice-toast report-toast"
              onClick={() => {
                setReportToasts((prev) => prev.filter((t) => t.id !== toast.id));
                setInstanceSettingsOpen(true);
              }}
            >
              🚩 {toast.text} — open Reports
            </button>
          ))}
        </div>
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
              onTouchStart={(e) => {
                // Touch has no right-click — long-press opens the same menu.
                const rect = e.currentTarget.getBoundingClientRect();
                longPressTimerRef.current = window.setTimeout(() => {
                  setContextMenuPos({ x: rect.right + 8, y: rect.top });
                  setContextMenuInstanceId(instance.id);
                }, 500);
              }}
              onTouchEnd={() => {
                if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
              }}
              onTouchMove={() => {
                if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
              }}
            >
              {instance.id === activeInstanceId && instanceInfo?.iconUrl ? (
                <img src={authedMediaUrl(instanceInfo.iconUrl, activeInstance.baseUrl, session.token)} alt="" />
              ) : instanceIcons[instance.id] ? (
                // Every server other than the active one draws from the local
                // cache — its icon lives behind that server's own auth, which
                // this page can't present at paint time. See instanceIcons.ts.
                <img src={instanceIcons[instance.id]} alt="" />
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
            setDeepLinkReset(null);
            setDeepLinkOidc(null);
            setDeepLinkOidcError(null);
          }}
        >
          <AddServerModal
            initialBaseUrl={
              deepLinkInvite || deepLinkReset || deepLinkOidc || deepLinkOidcError
                ? window.location.origin
                : undefined
            }
            initialInviteCode={deepLinkInvite ?? undefined}
            initialResetToken={deepLinkReset ?? undefined}
            initialOidcCode={deepLinkOidc ?? undefined}
            initialOidcError={deepLinkOidcError ?? undefined}
            onConnected={handleConnected}
          />
          <div className="modal-actions">
            <button
              className="btn secondary"
              onClick={() => {
                setAddServerOpen(false);
                setDeepLinkInvite(null);
                setDeepLinkReset(null);
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
          {/* Was isOwner-only — silently locked out any non-owner holding
              MANAGE_CHANNELS/MANAGE_ROLES/MODERATE_MEMBERS/MANAGE_SERVER
              too, since there was no way to even open the modal to reach
              the tab their permission already worked for. Each tab still
              gates its own content/actions server-side regardless. */}
          {(isOwner || canManageChannels || canManageRoles || canModerate || canManageServer) && (
            <button className="gear-btn" title="Instance Settings" onClick={() => setInstanceSettingsOpen(true)}>
              ⚙️
            </button>
          )}
        </div>
        <div className="sidebar-scroll">
          {dmChannels.length > 0 && (
            <div className="channel-section dm-section">
              <div className="channel-category-row">
                <button type="button" className="channel-category-toggle" onClick={toggleDmChannelsCollapsed}>
                  <span className={`category-chevron ${dmChannelsCollapsed ? "collapsed" : ""}`}>▾</span>
                  <span className="channel-category">Direct Messages</span>
                </button>
              </div>
              {!dmChannelsCollapsed && (
                <div className="channel-section-list">
                  {dmChannels.map((dm) => (
                    <div className="channel-row" key={dm.id}>
                      <button
                        className={`channel-btn ${dm.id === selectedChannelId ? "active" : ""}`}
                        onClick={() => selectChannel(dm.id)}
                      >
                        {dm.otherAvatarUrl ? (
                          <img className="avatar dm-avatar" src={authedMediaUrl(dm.otherAvatarUrl, activeInstance.baseUrl, session.token)} alt="" />
                        ) : (
                          <span className="avatar avatar-placeholder dm-avatar">{dm.otherUsername[0]?.toUpperCase()}</span>
                        )}
                        <span>{dm.otherUsername}</span>
                        {unreadChannelIds.has(dm.id) && <span className="presence-dot online" title="Unread messages" />}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="channel-section text-channel-section">
            <div className="channel-category-row">
              <button type="button" className="channel-category-toggle" onClick={toggleTextChannelsCollapsed}>
                <span className={`category-chevron ${textChannelsCollapsed ? "collapsed" : ""}`}>▾</span>
                <span className="channel-category">Text Channels</span>
              </button>
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
            {!textChannelsCollapsed && (
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
                    onClick={() => selectChannel(channel.id)}
                  >
                    <span className="channel-icon">#</span>
                    <span>{channel.name}</span>
                    {unreadChannelIds.has(channel.id) && <span className="presence-dot online" title="Unread messages" />}
                  </button>
                </div>
              ))}
            </div>
            )}
          </div>

          <div className="channel-section voice-channel-section">
          <div className="channel-category-row">
            <button type="button" className="channel-category-toggle" onClick={toggleVoiceChannelsCollapsed}>
              <span className={`category-chevron ${voiceChannelsCollapsed ? "collapsed" : ""}`}>▾</span>
              <span className="channel-category">Voice Channels</span>
            </button>
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
          {!voiceChannelsCollapsed && (
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
                    // this yanked the main pane over to VoicePanel). The
                    // details popover (mic/speaker controls etc.) opens
                    // automatically on join rather than needing a second,
                    // undiscoverable click on the now-active channel —
                    // real user feedback: it wasn't obvious a second click
                    // was needed at all.
                    // Opens the call view either way: joining shows the
                    // call, and clicking the channel you're already in is
                    // how you get back to it after reading a text channel.
                    if (!isMyChannel) {
                      voice.join(channel);
                      setVoiceDetailsOpen(true);
                    }
                    setCallViewOpen(true);
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
                              <img src={authedMediaUrl(member.avatarUrl, activeInstance.baseUrl, session.token)} alt="" />
                            ) : (
                              <span className="avatar-placeholder">{(member?.username ?? "?")[0]?.toUpperCase()}</span>
                            )}
                          </span>
                          <span className="voice-member-name">{member?.username ?? userId}</span>
                          {canModerate && userId !== session.user.id && (
                            <button
                              type="button"
                              className="voice-member-kick"
                              title="Disconnect from voice channel"
                              onClick={(e) => {
                                e.stopPropagation();
                                kickFromVoice(activeInstance.baseUrl, session.token, userId).catch(console.error);
                              }}
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          </div>
          )}
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
            <img className="avatar" src={authedMediaUrl(session.user.avatarUrl, activeInstance.baseUrl, session.token)} alt="" />
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
          <button className="icon-btn" title="Friends" onClick={() => setFriendsOpen(true)}>
            👤
          </button>
          <button className="gear-btn" title="User Settings" onClick={() => setUserSettingsOpen(true)}>
            ⚙️
          </button>
        </div>
        <div ref={voice.audioContainerRef} style={{ display: "none" }} />
      </aside>
      {/* One container, two presentations — never two containers. The video
          elements are appended imperatively by the voice engine, so moving
          this div in the React tree would unmount it and take the live
          streams with it. Only its class changes.

          Any live feed — a screen share or a camera, mine or anyone
          else's — takes the channel pane, and the tiles grid to fit however
          many there are.

          This used to key off `selectedChannelId === voice.activeChannel.id`,
          which in practice was never true: clicking a voice channel joins it
          without selecting it (see the sidebar's handler, which says so
          deliberately), so there is no way to have a voice channel "open".
          The stage was unreachable and every share stayed a corner tile.

          Minimising drops it back to that floating tile, which is what makes
          a share watchable while you read another channel. */}
      {/* Always mounted, shown only in the call view. Hiding it with CSS
          rather than unmounting is what keeps a call running while you read
          a text channel: the tracks stay subscribed and the <video>
          elements keep receiving, they just aren't drawn. Unmounting this
          would take every live stream with it. */}
      <div
        ref={voice.videoContainerRef}
        className="screen-share-overlay"
        onDoubleClick={voice.videoFeedCount > 0 ? toggleVideoFullscreen : undefined}
      />
      {callViewOpen && voice.connected && voice.videoFeedCount === 0 && (
        <div className="call-empty">
          <p>
            You're in 🔊 {voice.activeChannel?.name}. Turn on your camera or share your screen below — anything
            anyone sends appears here.
          </p>
        </div>
      )}
      {/* Voice controls live here, in the window, rather than only inside
          the sidebar popover you had to open by clicking the channel again.
          Being connected is a state you're in while doing something else, so
          the controls follow you: browsing text channels never interrupts
          voice, video or a screen share, and you can mute or stop sharing
          without hunting for the channel you joined from.

          Hidden while fullscreen, where it isn't a child of the fullscreen
          element and so can't render anyway — Escape or a double-click on
          the video gets you back. */}
      {callViewOpen && voice.connected && !videoFullscreen && (
        <div className="voice-bar">
          <span className="voice-bar-channel" title={voice.activeChannel?.name}>
            🔊 {voice.activeChannel?.name}
          </span>
          <button type="button" onClick={voice.toggleMute} title={voice.muted ? "Unmute" : "Mute"}>
            {voice.muted ? "🔇" : "🎤"}
          </button>
          <button type="button" onClick={voice.toggleDeafen} title={voice.deafened ? "Undeafen" : "Deafen"}>
            {voice.deafened ? "🔕" : "🎧"}
          </button>
          {voice.cameraSupported && (
            <button type="button" onClick={voice.toggleCamera}>
              {voice.cameraOn ? "Stop Video" : "Start Video"}
            </button>
          )}
          {voice.screenShareSupported && (
            <button type="button" onClick={voice.toggleScreenShare}>
              {voice.screenSharing ? "Stop Sharing" : "Share Screen"}
            </button>
          )}
          {voice.videoFeedCount > 0 && (
            <button type="button" onClick={toggleVideoFullscreen} title="Fullscreen (or double-click the video)">
              ⛶
            </button>
          )}
          <button type="button" className="voice-bar-leave" onClick={voice.leave} title="Disconnect">
            Leave
          </button>
        </div>
      )}

      {userSettingsOpen && (
        <UserSettingsModal
          baseUrl={activeInstance.baseUrl}
          token={session.token}
          instanceId={activeInstance.id}
          user={session.user}
          onClose={() => setUserSettingsOpen(false)}
          onSessionUpdate={handleSessionUpdate}
          onAccountDeleted={() => {
            // The account is gone server-side, so unlike a kick this drops
            // the whole bookmark, not just the stored session — leaving it
            // would put a server on the rail that this client can never log
            // back into. Same teardown as Leave Server, which already
            // handles falling back to another instance or the "Add a
            // Server" screen.
            setUserSettingsOpen(false);
            setForceDisconnectReason("account_deleted");
            if (activeInstanceId) leaveInstance(activeInstanceId);
          }}
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
          isOwner={session.user.isOwner}
          canModerate={canModerate}
          canManageServer={canManageServer}
          instanceInfo={instanceInfo}
          channels={channels}
          onClose={() => setInstanceSettingsOpen(false)}
          onUpdated={(updated) => {
            // The PATCH response (FullInstanceSettings) only covers the
            // owner-editable fields — merge onto the existing InstanceInfo
            // rather than replacing it outright, so derived/public-only
            // fields (hasOwner, gifSearchEnabled, turnstileSiteKey,
            // levelingEnabled, passwordResetEnabled, version) survive a
            // settings save instead of silently disappearing from state.
            setInstanceInfo((prev) => (prev ? { ...prev, ...updated } : prev));
            document.documentElement.dataset.theme = updated.theme;
          }}
          onChannelUpdated={(channel) => setChannels((prev) => prev.map((c) => (c.id === channel.id ? channel : c)))}
          customEmoji={customEmoji}
          onCustomEmojiChanged={refreshCustomEmoji}
          onViewProfile={(userId) => {
            setInstanceSettingsOpen(false);
            setViewingProfileUserId(userId);
          }}
        />
      )}
      {reportTarget && (
        <ReportModal
          baseUrl={activeInstance.baseUrl}
          token={session.token}
          messageId={reportTarget.id}
          targetUsername={reportTarget.authorUsername ?? "this member"}
          // Only for an encrypted DM, and only once this device has actually
          // decrypted it — the server has no plaintext of its own to store,
          // and sending the "can't decrypt" placeholder as evidence would be
          // worse than sending nothing.
          encryptedMessageContent={
            reportTarget.encryptedPayload && typeof decrypted[reportTarget.id] === "string"
              ? (decrypted[reportTarget.id] as string)
              : undefined
          }
          onClose={() => setReportTarget(null)}
        />
      )}
      {searchOpen && (
        <SearchPanel
          baseUrl={activeInstance.baseUrl}
          token={session.token}
          currentChannelId={selectedChannelId}
          currentChannelName={selectedChannel?.name ?? null}
          onJump={(channelId) => selectChannel(channelId)}
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
          unreadFriendUserIds={unreadFriendUserIds}
          onMessage={handleOpenDM}
          onClose={() => setFriendsOpen(false)}
        />
      )}

      <main className="chat-pane">
        {selectedChannel ? (
          <>
            <div className="chat-header">
              <button
                type="button"
                className="chat-header-icon-btn mobile-only-btn"
                title="Channels"
                onClick={() => setMobileActivePane("nav")}
              >
                ☰
              </button>
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
                    onClick={() => {
                      setMemberListOpen((v) => {
                        const next = !v;
                        setMobileActivePane(next ? "members" : "chat");
                        return next;
                      });
                    }}
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
                // Where a DM crossed between plaintext and encrypted. Without
                // this, old readable messages and new unreadable-to-the-server
                // ones look identical in the same scrollback, and there's no
                // way to tell which of your messages the server can still
                // read. The status line above the composer only describes the
                // conversation's state *now*.
                //
                // Both directions are marked, and the downgrade deliberately
                // reads as a warning: going back to plaintext is the one that
                // changes what's exposed, and it can happen without any action
                // by the person reading this (the other party turning
                // encryption off is enough).
                const cryptoBoundary =
                  selectedChannel?.type === "DM" && prev && !!prev.encryptedPayload !== !!m.encryptedPayload
                    ? m.encryptedPayload
                      ? "encrypted"
                      : "plaintext"
                    : null;
                return (
                <Fragment key={`wrap-${m.id}`}>
                {cryptoBoundary && (
                  <div className={`crypto-divider ${cryptoBoundary}`}>
                    <span>
                      {cryptoBoundary === "encrypted"
                        ? "🔒 Messages below here are encrypted end-to-end"
                        : "⚠️ Messages below here are not encrypted — the server can read them"}
                    </span>
                  </div>
                )}
                <MessageItem
                  key={m.id}
                  baseUrl={activeInstance.baseUrl}
                  token={session.token}
                  message={m}
                  grouped={grouped}
                  isOnline={onlineUserIds.has(m.authorId)}
                  currentUserId={session.user.id}
                  canModerate={canManageChannels}
                  memberUsernames={memberUsernames}
                  usernameByUserId={usernameByUserId}
                  customEmojiByName={customEmojiByName}
                  channelIdByName={channelIdByName}
                  onChannelClick={selectChannel}
                  customEmoji={customEmoji}
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
                  onReport={setReportTarget}
                />
                </Fragment>
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
              {/* Only ever shown in a DM. Says which of the three states this
                  conversation is in, because "encrypted" that quietly isn't is
                  worse than no indicator at all. */}
              {selectedChannel?.type === "DM" && (
                <p className={`dm-crypto-status ${dmCrypto.active ? "on" : ""}`}>
                  {dmCrypto.active ? (
                    dmCrypto.trust === "changed" ? (
                      <>⚠️ This person's security key changed. If that wasn't them setting up a new device, stop and check.</>
                    ) : (
                      <>🔒 Encrypted end-to-end — the server can't read these messages.</>
                    )
                  ) : dmCrypto.reason === "self" ? (
                    <>Not encrypted. Turn on encrypted DMs in User Settings → Security.</>
                  ) : (
                    <>Not encrypted — {selectedChannel.name} hasn't turned on encrypted DMs.</>
                  )}
                </p>
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
                    <EmojiPicker baseUrl={activeInstance.baseUrl} token={session.token} onSelect={handleEmojiSelect} customEmoji={customEmoji} />
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
              {channelMentionQuery !== null && channelMentionMatches.length > 0 && (
                <div className="mention-popover">
                  {channelMentionMatches.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="mention-option"
                      onClick={() => handleChannelMentionSelect(c.name)}
                    >
                      #{c.name}
                    </button>
                  ))}
                </div>
              )}
              <form onSubmit={handleSend} className="send-form">
                <label className="attach-label">
                  {uploadingAttachment ? "…" : "📎"}
                  <input
                    type="file"
                    accept={buildAcceptAttribute(myUploadCategories)}
                    hidden
                    onChange={handleAttachmentSelect}
                    disabled={uploadingAttachment}
                  />
                </label>
                <textarea
                  ref={draftInputRef}
                  rows={1}
                  value={draft}
                  onChange={handleDraftChange}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && mentionQuery !== null) setMentionQuery(null);
                    if (e.key === "Escape" && channelMentionQuery !== null) setChannelMentionQuery(null);
                    // Enter sends, Shift+Enter inserts a real newline —
                    // needed for multi-line messages/code blocks, which a
                    // plain single-line <input> could never support (Enter
                    // always submitted, and pasted newlines got stripped).
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={selectedChannel.type === "DM" ? `Message @${selectedChannel.name}` : `Message #${selectedChannel.name}`}
                  // Explicit rather than relying on the browser/WebView
                  // default, which isn't consistent across platforms (the
                  // Android/iOS wrappers' WebViews don't all default these
                  // the same way a desktop browser does).
                  spellCheck
                  autoCapitalize="sentences"
                  autoCorrect="on"
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
          <div className="chat-placeholder">
            <button
              type="button"
              className="chat-header-icon-btn mobile-only-btn"
              title="Channels"
              onClick={() => setMobileActivePane("nav")}
            >
              ☰
            </button>
            Select a channel
          </div>
        )}
      </main>
      {memberListOpen && selectedChannel?.type !== "DM" && (
        <MemberList
          baseUrl={activeInstance.baseUrl}
          token={session.token}
          onlineUserIds={onlineUserIds}
          onSelectMember={setViewingProfileUserId}
          refreshKey={memberListRefreshKey}
          onClose={() => {
            setMemberListOpen(false);
            setMobileActivePane("chat");
          }}
        />
      )}
    </div>
  );
}

export default App;
