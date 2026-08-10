import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

export interface User {
  id: string;
  username: string;
  email: string;
  avatarUrl?: string | null;
  bio?: string | null;
  isOwner: boolean;
  // Base64 SPKI of this account's DM encryption public key; null until they
  // opt in. See crypto/keys.ts.
  publicKey?: string | null;
}

export interface WebauthnCredentialInfo {
  id: string;
  nickname: string;
  createdAt?: string;
}

// Returned by POST /auth/login instead of a real session the moment the
// account has any MFA method configured — see login() below.
export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
  totpEnabled: boolean;
  webauthnCredentials: WebauthnCredentialInfo[];
}

export interface MfaStatus {
  totpEnabled: boolean;
  backupCodesRemaining: number;
  webauthnCredentials: WebauthnCredentialInfo[];
}

export interface Channel {
  id: string;
  name: string;
  // THREAD channels are never present in the READY channel list or the
  // sidebar's text/voice filters — they're added to local state directly
  // when a thread is created/opened, purely so selectedChannelId-based
  // lookups (name, message history) work the same as any other channel.
  // DM channels are similarly excluded from the shared list (they're
  // per-user, not instance-wide) and merged in from READY's separate
  // `dmChannels` field / a DM_CHANNEL_CREATE event instead.
  type: "TEXT" | "VOICE" | "THREAD" | "DM";
  position: number;
  // Empty (or absent, for a THREAD/DM which never carry this field in
  // practice) = visible to everyone. Non-empty = hidden from anyone without
  // at least one of these roles — see the server's Channel.restrictedToRoleIds.
  restrictedToRoleIds?: string[];
}

export interface ThreadInfo {
  id: string;
  name: string;
  messageCount: number;
}

export type ThreadChannel = Channel & {
  type: "THREAD";
  parentChannelId: string | null;
  parentMessageId: string | null;
  createdAt: string;
};

// A DM channel's `name` is set to the other participant's username, so
// generic channel-name UI (composer placeholder, thread back-button label)
// works unmodified — otherUserId/otherUsername/otherAvatarUrl are the
// DM-specific fields components branch on.
export type DMChannel = Channel & {
  type: "DM";
  otherUserId: string;
  otherUsername: string;
  otherAvatarUrl: string | null;
};

export interface FriendUser {
  userId: string;
  username: string;
  avatarUrl: string | null;
  online: boolean;
}

export interface FriendsList {
  friends: FriendUser[];
  incoming: FriendUser[];
  outgoing: FriendUser[];
  blocked: FriendUser[];
}

export type Theme = "business" | "cyberpunk" | "hacker" | "esports";

export interface InstanceInfo {
  name: string;
  description: string | null;
  iconUrl: string | null;
  theme: Theme;
  requireInviteToRegister: boolean;
  hasOwner: boolean;
  gifSearchEnabled: boolean;
  turnstileSiteKey: string | null;
  defaultChannelId: string | null;
  levelingEnabled: boolean;
  passwordResetEnabled: boolean;
  afkChannelId: string | null;
  afkTimeoutMinutes: number | null;
  version: string;
}

// Owner-only, from GET/PATCH /instance/settings — a superset of
// InstanceInfo with the Mail-tab fields; smtpPassword itself never appears
// here, only whether one is currently set.
export interface FullInstanceSettings extends Omit<InstanceInfo, "hasOwner" | "gifSearchEnabled" | "turnstileSiteKey" | "levelingEnabled" | "passwordResetEnabled" | "version"> {
  smtpEnabled: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUsername: string | null;
  smtpPasswordSet: boolean;
  smtpFromAddress: string | null;
}

export interface Gif {
  id: string;
  title: string;
  previewUrl: string;
  url: string;
}

export interface LinkPreviewData {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

export interface ApiBot {
  id: string;
  username: string;
  avatarUrl?: string | null;
  revoked: boolean;
  createdAt: string;
}

export interface Webhook {
  id: string;
  channelId: string;
  name: string;
  avatarUrl: string | null;
  token: string;
  createdAt: string;
}

export interface CustomEmoji {
  id: string;
  name: string;
  imageUrl: string;
  createdBy: string;
  createdAt: string;
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

export interface ReplyPreview {
  id: string;
  content: string;
  authorUsername?: string;
  isWebhook: boolean;
  isSystemBot?: boolean;
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
  isWebhook?: boolean;
  isSystemBot?: boolean;
  // Set by the server when authorId no longer resolves to an account (the
  // user deleted it, or the owner removed an API bot). The message stays;
  // its author is rendered as a non-clickable "Deleted User".
  authorDeleted?: boolean;
  pinned?: boolean;
  replyToId?: string | null;
  replyTo?: ReplyPreview | null;
  thread?: ThreadInfo | null;
}

export interface SearchResult extends Message {
  channelName: string;
}

export type Permission =
  | "MANAGE_CHANNELS"
  | "MANAGE_ROLES"
  | "MANAGE_SERVER"
  | "SEND_MESSAGES"
  | "MODERATE_MEMBERS"
  | "UPLOAD_DOCUMENTS"
  | "UPLOAD_ARCHIVES"
  | "UPLOAD_CODE"
  | "UPLOAD_VIDEOS";

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
  bio: string | null;
  joinedAt: string;
  mutedUntil: string | null;
  banned: boolean;
  isOwner: boolean;
  isBot: boolean;
  // Null means this member hasn't turned on encrypted DMs, so a conversation
  // with them stays plaintext.
  publicKey?: string | null;
  roles: { id: string; name: string }[];
}

export interface ModerationLogEntry {
  id: string;
  action: string;
  actorId: string;
  actorUsername: string;
  targetId: string;
  targetUsername: string;
  detail: string | null;
  createdAt: string;
}

export interface BotSettings {
  name: string;
  avatarUrl: string | null;
  welcomeEnabled: boolean;
  welcomeChannelId: string | null;
  welcomeMessage: string;
  autoRoleEnabled: boolean;
  autoRoleId: string | null;
  customCommandsEnabled: boolean;
  reactionRolesEnabled: boolean;
  levelingEnabled: boolean;
  levelUpAnnounce: boolean;
  levelUpMessage: string;
  automodEnabled: boolean;
  automodBannedWords: string[];
  automodWarnThreshold: number;
  automodMuteMinutes: number;
}

export interface CustomCommand {
  id: string;
  trigger: string;
  response: string;
}

export interface ReactionRoleEntry {
  id: string;
  channelId: string;
  channelName: string;
  emoji: string;
  roleId: string;
  roleName: string;
}

export interface BotConfig {
  settings: BotSettings;
  customCommands: CustomCommand[];
  reactionRoles: ReactionRoleEntry[];
}

export function toWsUrl(baseUrl: string): string {
  return baseUrl.replace(/^http/, "ws");
}

// Uploaded avatars/attachments/emoji are served from a private bucket
// through an authenticated backend route now (see routes/fileServing.ts on
// the server) — a plain <img>/<video> tag can't send an Authorization
// header, so the session token is appended as a query param instead, same
// tradeoff already accepted for this app's gateway WebSocket connection.
// Only ever applied to our own same-origin uploads: an external URL (a GIF
// picker result, a link-preview image) must never get the session token
// appended to it, so this is a no-op for anything not under `baseUrl`.
export function authedMediaUrl(url: string | null | undefined, baseUrl: string, token: string): string {
  if (!url) return "";
  if (!url.startsWith(baseUrl)) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${token}`;
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

export function getCurrentUser(baseUrl: string, token: string) {
  return request<User>(baseUrl, "/auth/me", token);
}

export function register(
  baseUrl: string,
  username: string,
  email: string,
  password: string,
  inviteCode?: string,
  claimCode?: string,
  turnstileToken?: string,
) {
  return request<{ token: string; user: User }>(baseUrl, "/auth/register", null, {
    method: "POST",
    body: JSON.stringify({
      username,
      email,
      password,
      ...(inviteCode ? { inviteCode } : {}),
      ...(claimCode ? { claimCode } : {}),
      ...(turnstileToken ? { turnstileToken } : {}),
    }),
  });
}

export function login(baseUrl: string, login: string, password: string) {
  return request<{ token: string; user: User } | MfaChallenge>(baseUrl, "/auth/login", null, {
    method: "POST",
    body: JSON.stringify({ login, password }),
  });
}

export function mfaVerifyCode(baseUrl: string, mfaToken: string, code: string) {
  return request<{ token: string; user: User }>(baseUrl, "/auth/mfa/verify-code", null, {
    method: "POST",
    body: JSON.stringify({ mfaToken, code }),
  });
}

export function mfaWebauthnLoginOptions(baseUrl: string, mfaToken: string) {
  return request<{ options: PublicKeyCredentialRequestOptionsJSON; mfaToken: string }>(
    baseUrl,
    "/auth/mfa/webauthn/options",
    null,
    { method: "POST", body: JSON.stringify({ mfaToken }) },
  );
}

export function mfaWebauthnLoginVerify(baseUrl: string, mfaToken: string, response: AuthenticationResponseJSON) {
  return request<{ token: string; user: User }>(baseUrl, "/auth/mfa/webauthn/verify", null, {
    method: "POST",
    body: JSON.stringify({ mfaToken, response }),
  });
}

export function getMfaStatus(baseUrl: string, token: string) {
  return request<MfaStatus>(baseUrl, "/mfa/status", token);
}

export function setupTotp(baseUrl: string, token: string) {
  return request<{ secret: string; qrCodeDataUrl: string }>(baseUrl, "/mfa/totp/setup", token, { method: "POST" });
}

export function confirmTotp(baseUrl: string, token: string, code: string) {
  return request<{ backupCodes: string[] }>(baseUrl, "/mfa/totp/confirm", token, {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

export function disableTotp(baseUrl: string, token: string, password: string) {
  return request<void>(baseUrl, "/mfa/totp/disable", token, {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export function regenerateBackupCodes(baseUrl: string, token: string, password: string) {
  return request<{ backupCodes: string[] }>(baseUrl, "/mfa/backup-codes/regenerate", token, {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export function webauthnRegisterOptions(baseUrl: string, token: string) {
  return request<{ options: PublicKeyCredentialCreationOptionsJSON; challengeToken: string }>(
    baseUrl,
    "/mfa/webauthn/register/options",
    token,
    { method: "POST" },
  );
}

export function webauthnRegisterVerify(
  baseUrl: string,
  token: string,
  challengeToken: string,
  response: RegistrationResponseJSON,
  nickname: string,
) {
  return request<WebauthnCredentialInfo>(baseUrl, "/mfa/webauthn/register/verify", token, {
    method: "POST",
    body: JSON.stringify({ challengeToken, response, nickname }),
  });
}

export function deleteWebauthnCredential(baseUrl: string, token: string, credentialId: string, password: string) {
  return request<void>(baseUrl, `/mfa/webauthn/${credentialId}`, token, {
    method: "DELETE",
    body: JSON.stringify({ password }),
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

export function updateChannelPermissions(baseUrl: string, token: string, channelId: string, restrictedToRoleIds: string[]) {
  return request<Channel>(baseUrl, `/channels/${channelId}/permissions`, token, {
    method: "PATCH",
    body: JSON.stringify({ restrictedToRoleIds }),
  });
}

export function reorderChannels(baseUrl: string, token: string, type: "TEXT" | "VOICE", channelIds: string[]) {
  return request<void>(baseUrl, "/channels/reorder", token, {
    method: "POST",
    body: JSON.stringify({ type, channelIds }),
  });
}

export function listMessages(baseUrl: string, token: string, channelId: string) {
  return request<Message[]>(baseUrl, `/channels/${channelId}/messages`, token);
}

export function markChannelRead(baseUrl: string, token: string, channelId: string) {
  return request<{ ok: true }>(baseUrl, `/channels/${channelId}/read`, token, { method: "POST" });
}

export function searchMessages(baseUrl: string, token: string, q: string, channelId?: string) {
  const params = new URLSearchParams({ q });
  if (channelId) params.set("channelId", channelId);
  return request<SearchResult[]>(baseUrl, `/messages/search?${params.toString()}`, token);
}

export function listPinnedMessages(baseUrl: string, token: string, channelId: string) {
  return request<Message[]>(baseUrl, `/channels/${channelId}/pins`, token);
}

export function createThread(baseUrl: string, token: string, messageId: string, name?: string) {
  return request<ThreadChannel>(baseUrl, `/messages/${messageId}/thread`, token, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function getThread(baseUrl: string, token: string, messageId: string) {
  return request<ThreadChannel>(baseUrl, `/messages/${messageId}/thread`, token);
}

export function getVoiceToken(baseUrl: string, token: string, channelId: string) {
  return request<{ token: string; url: string }>(baseUrl, `/channels/${channelId}/voice-token`, token, {
    method: "POST",
  });
}

export function searchGifs(baseUrl: string, token: string, query: string) {
  return request<Gif[]>(baseUrl, `/gifs/search?q=${encodeURIComponent(query)}`, token);
}

export function trendingGifs(baseUrl: string, token: string) {
  return request<Gif[]>(baseUrl, "/gifs/trending", token);
}

// Best-effort: the backend returns 204 (no metadata found) as `undefined`
// via request()'s existing handling; a hard failure (network error, 4xx/5xx)
// is swallowed here too rather than surfaced, since a missing link preview
// is never worth showing an error state for.
export async function getLinkPreview(baseUrl: string, token: string, url: string): Promise<LinkPreviewData | undefined> {
  try {
    return await request<LinkPreviewData>(baseUrl, `/link-preview?url=${encodeURIComponent(url)}`, token);
  } catch {
    return undefined;
  }
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

export function updateProfile(
  baseUrl: string,
  token: string,
  updates: { username?: string; email?: string; bio?: string | null },
) {
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

// Publishes this device's DM encryption public key. The private half never
// leaves the browser — see crypto/keys.ts.
export function publishPublicKey(baseUrl: string, token: string, publicKey: string) {
  return request<void>(baseUrl, "/auth/me/public-key", token, {
    method: "PUT",
    body: JSON.stringify({ publicKey }),
  });
}

// Irreversible. `username` is the typed-confirmation field (verified
// server-side, not just in the form); `code` is required only when the
// account has two-factor enabled.
export function deleteAccount(baseUrl: string, token: string, password: string, username: string, code?: string) {
  return request<void>(baseUrl, "/auth/me", token, {
    method: "DELETE",
    body: JSON.stringify({ password, username, ...(code ? { code } : {}) }),
  });
}

export function updateInstanceSettings(
  baseUrl: string,
  token: string,
  updates: {
    name?: string;
    description?: string;
    iconUrl?: string | null;
    theme?: Theme;
    requireInviteToRegister?: boolean;
    defaultChannelId?: string | null;
    smtpEnabled?: boolean;
    smtpHost?: string | null;
    smtpPort?: number | null;
    smtpUsername?: string | null;
    smtpPassword?: string | null;
    smtpFromAddress?: string | null;
    afkChannelId?: string | null;
    afkTimeoutMinutes?: number | null;
  },
) {
  return request<FullInstanceSettings>(baseUrl, "/instance/settings", token, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export function getInstanceSettings(baseUrl: string, token: string) {
  return request<FullInstanceSettings>(baseUrl, "/instance/settings", token);
}

export function forgotPassword(baseUrl: string, email: string) {
  return request<{ ok: true }>(baseUrl, "/auth/forgot-password", null, {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export function resetPassword(baseUrl: string, token: string, newPassword: string) {
  return request<{ ok: true }>(baseUrl, "/auth/reset-password", null, {
    method: "POST",
    body: JSON.stringify({ token, newPassword }),
  });
}

export function listMembers(baseUrl: string, token: string) {
  return request<Member[]>(baseUrl, "/members", token);
}

export function getMemberProfile(baseUrl: string, token: string, userId: string) {
  return request<Member>(baseUrl, `/members/${userId}`, token);
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

export function updateRole(
  baseUrl: string,
  token: string,
  roleId: string,
  updates: { name?: string; permissions?: Permission[] },
) {
  return request<Role>(baseUrl, `/roles/${roleId}`, token, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export function assignRole(baseUrl: string, token: string, userId: string, roleId: string) {
  return request<void>(baseUrl, `/members/${userId}/roles`, token, {
    method: "POST",
    body: JSON.stringify({ roleId }),
  });
}

export function unassignRole(baseUrl: string, token: string, userId: string, roleId: string) {
  return request<void>(baseUrl, `/members/${userId}/roles/${roleId}`, token, { method: "DELETE" });
}

export function listCustomEmoji(baseUrl: string, token: string) {
  return request<CustomEmoji[]>(baseUrl, "/custom-emoji", token);
}

export function createCustomEmoji(baseUrl: string, token: string, name: string, imageUrl: string) {
  return request<CustomEmoji>(baseUrl, "/custom-emoji", token, {
    method: "POST",
    body: JSON.stringify({ name, imageUrl }),
  });
}

export function deleteCustomEmoji(baseUrl: string, token: string, id: string) {
  return request<void>(baseUrl, `/custom-emoji/${id}`, token, { method: "DELETE" });
}

export function listWebhooks(baseUrl: string, token: string, channelId: string) {
  return request<Webhook[]>(baseUrl, `/channels/${channelId}/webhooks`, token);
}

export function createWebhook(baseUrl: string, token: string, channelId: string, name: string) {
  return request<Webhook>(baseUrl, `/channels/${channelId}/webhooks`, token, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function deleteWebhook(baseUrl: string, token: string, webhookId: string) {
  return request<void>(baseUrl, `/webhooks/${webhookId}`, token, { method: "DELETE" });
}

export function listApiBots(baseUrl: string, token: string) {
  return request<ApiBot[]>(baseUrl, "/api-bots", token);
}

export function createApiBot(baseUrl: string, token: string, username: string) {
  return request<{ bot: ApiBot; token: string }>(baseUrl, "/api-bots", token, {
    method: "POST",
    body: JSON.stringify({ username }),
  });
}

export function setApiBotRevoked(baseUrl: string, token: string, botId: string, revoked: boolean) {
  return request<ApiBot>(baseUrl, `/api-bots/${botId}`, token, {
    method: "PATCH",
    body: JSON.stringify({ revoked }),
  });
}

export function deleteApiBot(baseUrl: string, token: string, botId: string) {
  return request<void>(baseUrl, `/api-bots/${botId}`, token, { method: "DELETE" });
}

export function getBotConfig(baseUrl: string, token: string) {
  return request<BotConfig>(baseUrl, "/bot/settings", token);
}

export function updateBotSettings(baseUrl: string, token: string, updates: Partial<BotSettings>) {
  return request<BotSettings>(baseUrl, "/bot/settings", token, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export function createCustomCommand(baseUrl: string, token: string, trigger: string, response: string) {
  return request<CustomCommand>(baseUrl, "/bot/commands", token, {
    method: "POST",
    body: JSON.stringify({ trigger, response }),
  });
}

export function deleteCustomCommand(baseUrl: string, token: string, id: string) {
  return request<void>(baseUrl, `/bot/commands/${id}`, token, { method: "DELETE" });
}

export function createReactionRole(baseUrl: string, token: string, channelId: string, emoji: string, roleId: string) {
  return request<ReactionRoleEntry>(baseUrl, "/bot/reaction-roles", token, {
    method: "POST",
    body: JSON.stringify({ channelId, emoji, roleId }),
  });
}

export function deleteReactionRole(baseUrl: string, token: string, id: string) {
  return request<void>(baseUrl, `/bot/reaction-roles/${id}`, token, { method: "DELETE" });
}

export interface LeaderboardEntry {
  userId: string;
  username: string;
  avatarUrl: string | null;
  level: number;
  xp: number;
  messageCount: number;
}

export function getLeaderboard(baseUrl: string, token: string) {
  return request<LeaderboardEntry[]>(baseUrl, "/bot/leaderboard", token);
}

export interface Warning {
  id: string;
  userId: string;
  reason: string;
  source: "automod" | "manual";
  moderatorId: string | null;
  createdAt: string;
}

export function getWarnings(baseUrl: string, token: string, userId: string) {
  return request<Warning[]>(baseUrl, `/moderation/warnings/${userId}`, token);
}

export function warnMember(baseUrl: string, token: string, userId: string, reason: string) {
  return request<{ count: number; threshold: number; muted: boolean; mutedUntil: string | null }>(
    baseUrl,
    `/moderation/${userId}/warn`,
    token,
    { method: "POST", body: JSON.stringify({ reason }) },
  );
}

export function muteMember(baseUrl: string, token: string, userId: string, minutes: number, reason?: string) {
  return request<{ mutedUntil: string }>(baseUrl, `/moderation/${userId}/mute`, token, {
    method: "POST",
    body: JSON.stringify({ minutes, reason }),
  });
}

export function unmuteMember(baseUrl: string, token: string, userId: string) {
  return request<void>(baseUrl, `/moderation/${userId}/unmute`, token, { method: "POST" });
}

export function kickMember(baseUrl: string, token: string, userId: string) {
  return request<void>(baseUrl, `/moderation/${userId}/kick`, token, { method: "POST" });
}

export function kickFromVoice(baseUrl: string, token: string, userId: string) {
  return request<void>(baseUrl, `/moderation/${userId}/voice-kick`, token, { method: "POST" });
}

export function banMember(baseUrl: string, token: string, userId: string) {
  return request<void>(baseUrl, `/moderation/${userId}/ban`, token, { method: "POST" });
}

export function unbanMember(baseUrl: string, token: string, userId: string) {
  return request<void>(baseUrl, `/moderation/${userId}/unban`, token, { method: "POST" });
}

// Owner-only — returns the new temp password once (never stored/re-fetchable,
// same "shown once" precedent as a bot account's token). See moderation.ts.
export function resetMemberPassword(baseUrl: string, token: string, userId: string) {
  return request<{ tempPassword: string }>(baseUrl, `/moderation/${userId}/reset-password`, token, { method: "POST" });
}

export function getModerationAuditLog(baseUrl: string, token: string) {
  return request<ModerationLogEntry[]>(baseUrl, "/moderation/audit-log", token);
}

export function listFriends(baseUrl: string, token: string) {
  return request<FriendsList>(baseUrl, "/friends", token);
}

export type FriendStatus = "self" | "none" | "friends" | "pending_outgoing" | "pending_incoming" | "blocked_by_me" | "blocked_by_them";

export function getFriendStatus(baseUrl: string, token: string, userId: string) {
  return request<{ status: FriendStatus }>(baseUrl, `/friends/${userId}/status`, token);
}

export function sendFriendRequest(baseUrl: string, token: string, username: string) {
  return request<void>(baseUrl, "/friends/request", token, {
    method: "POST",
    body: JSON.stringify({ username }),
  });
}

export function acceptFriendRequest(baseUrl: string, token: string, userId: string) {
  return request<void>(baseUrl, `/friends/${userId}/accept`, token, { method: "POST" });
}

export function declineFriendRequest(baseUrl: string, token: string, userId: string) {
  return request<void>(baseUrl, `/friends/${userId}/decline`, token, { method: "POST" });
}

export function removeFriend(baseUrl: string, token: string, userId: string) {
  return request<void>(baseUrl, `/friends/${userId}`, token, { method: "DELETE" });
}

export function blockUser(baseUrl: string, token: string, userId: string) {
  return request<void>(baseUrl, `/friends/${userId}/block`, token, { method: "POST" });
}

export function unblockUser(baseUrl: string, token: string, userId: string) {
  return request<void>(baseUrl, `/friends/${userId}/unblock`, token, { method: "POST" });
}

// Get-or-create — safe to call every time "Message" is clicked, not just
// the first time.
export function openDM(baseUrl: string, token: string, userId: string) {
  return request<DMChannel>(baseUrl, `/dms/${userId}`, token, { method: "POST" });
}

type GatewayEvent =
  | {
      type: "READY";
      channels: Channel[];
      dmChannels: DMChannel[];
      onlineUserIds: string[];
      voiceState: Record<string, string[]>;
      unreadChannelIds: string[];
    }
  | { type: "MESSAGE_CREATE"; message: Message }
  | { type: "MESSAGE_UPDATE"; message: Message }
  | { type: "MESSAGE_DELETE"; messageId: string; channelId: string }
  | { type: "REACTION_ADD"; messageId: string; channelId: string; userId: string; username: string; emoji: string }
  | { type: "REACTION_REMOVE"; messageId: string; channelId: string; userId: string; emoji: string }
  | { type: "PRESENCE_UPDATE"; userId: string; status: "online" | "offline" }
  | { type: "TYPING_START"; channelId: string; userId: string; username: string }
  | { type: "VOICE_STATE_UPDATE"; channelId: string; userIds: string[] }
  | { type: "THREAD_CREATE"; parentMessageId: string; thread: ThreadChannel }
  | { type: "FORCE_DISCONNECT"; reason: "kicked" | "banned" | "account_deleted" }
  | { type: "VOICE_KICKED"; channelId: string }
  | { type: "CHANNELS_UPDATE"; channels: Channel[] }
  | { type: "DM_CHANNEL_CREATE"; channel: DMChannel }
  | { type: "FRIEND_REQUEST_RECEIVED"; user: FriendUser }
  | { type: "FRIEND_REQUEST_ACCEPTED"; user: FriendUser }
  | { type: "FRIEND_REMOVED"; userId: string }
  // Synthesized locally by the Gateway class itself, not sent by the
  // server — "reconnecting" fires on any drop worth retrying (a deploy,
  // a network blip); "disconnected" only for a rejection retrying can't
  // fix (invalid token, banned), matching FORCE_DISCONNECT's own handling.
  | { type: "CONNECTION_STATE"; state: "connected" | "reconnecting" | "disconnected" }
  | { type: "ERROR"; error: string };

// WebSocket close codes the gateway uses for a rejection retrying won't
// fix (see src/gateway/index.ts) — anything else (a deploy recreating the
// container, a network blip, a laptop sleep/wake) is worth reconnecting
// from automatically instead of leaving the tab silently dead.
const NON_RETRYABLE_CLOSE_CODES = new Set([4001, 4003]);

export interface DiscordImportScope {
  importChannels: boolean;
  importRoles: boolean;
  importEmoji: boolean;
  importMessages: boolean;
}

export interface DiscordImportStatus {
  phase: "channels" | "roles" | "emoji" | "messages" | "done";
  counts: { channels: number; roles: number; emoji: number; messages: number };
  skipped: string[];
  failed: string[];
  done: boolean;
  error: string | null;
}

export function startDiscordImport(
  baseUrl: string,
  token: string,
  opts: { botToken: string; guildId: string } & DiscordImportScope,
) {
  return request<{ jobId: string }>(baseUrl, "/admin/import/discord", token, {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

export function getDiscordImportStatus(baseUrl: string, token: string, jobId: string) {
  return request<DiscordImportStatus>(baseUrl, `/admin/import/discord/${jobId}`, token);
}

export class Gateway {
  private ws: WebSocket;
  private baseUrl: string;
  private token: string;
  private listeners = new Set<(event: GatewayEvent) => void>();
  private closedByCaller = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.ws = this.connect();
  }

  private connect(): WebSocket {
    const ws = new WebSocket(`${toWsUrl(this.baseUrl)}/gateway?token=${this.token}`);
    ws.onmessage = (raw) => {
      const event = JSON.parse(raw.data) as GatewayEvent;
      for (const listener of this.listeners) listener(event);
    };
    ws.onopen = () => {
      this.reconnectAttempt = 0;
      for (const listener of this.listeners) listener({ type: "CONNECTION_STATE", state: "connected" });
    };
    ws.onclose = (event) => {
      if (this.closedByCaller) return;
      if (NON_RETRYABLE_CLOSE_CODES.has(event.code)) {
        for (const listener of this.listeners) listener({ type: "CONNECTION_STATE", state: "disconnected" });
        return;
      }
      for (const listener of this.listeners) listener({ type: "CONNECTION_STATE", state: "reconnecting" });
      // Exponential backoff up to 30s, uncapped attempt count — the tab
      // keeps trying for as long as it's open, same expectation any
      // real-time app (Slack, Discord itself) sets.
      const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30_000);
      this.reconnectAttempt++;
      this.reconnectTimer = setTimeout(() => {
        this.ws = this.connect();
      }, delay);
    };
    return ws;
  }

  on(listener: (event: GatewayEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sendMessage(channelId: string, content: string, attachmentUrl?: string, replyToId?: string) {
    this.ws.send(JSON.stringify({ type: "MESSAGE_SEND", channelId, content, attachmentUrl, replyToId }));
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

  pinMessage(messageId: string) {
    this.ws.send(JSON.stringify({ type: "MESSAGE_PIN", messageId }));
  }

  unpinMessage(messageId: string) {
    this.ws.send(JSON.stringify({ type: "MESSAGE_UNPIN", messageId }));
  }

  sendVoiceJoin(channelId: string) {
    this.ws.send(JSON.stringify({ type: "VOICE_JOIN", channelId }));
  }

  sendVoiceLeave() {
    this.ws.send(JSON.stringify({ type: "VOICE_LEAVE" }));
  }

  close() {
    this.closedByCaller = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws.close();
  }
}
