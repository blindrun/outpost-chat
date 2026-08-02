import { useRef, useState } from "react";
import { authedMediaUrl, CustomEmoji, Message } from "./api";
import { EmojiPicker } from "./EmojiPicker";
import { LinkPreview } from "./LinkPreview";
import { attachmentFilename, isImageAttachment, isVideoAttachment } from "./uploadCategories";

// Matches a reaction value that's a custom-emoji shortcode rather than a
// raw unicode emoji — same shape as the one MessageItem's own renderInline
// looks for in message text, kept in sync manually since one's a plain
// string match and the other's baked into a shared regex constant.
const CUSTOM_EMOJI_REACTION_PATTERN = /^:([a-zA-Z0-9_]+):$/;

const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🎉"];
// Group 3 (custom emoji shortcode) must match the NAME_PATTERN the backend
// validates against in customEmoji.ts, minus the length bound (client-side
// rendering doesn't need to enforce that, only the create endpoint does).
// Group 4 is a bare URL — greedy, so it can swallow trailing sentence
// punctuation (a period ending the sentence, a closing paren); trimmed back
// off in renderInline/extractFirstLinkPreviewUrl rather than tightened here,
// since a stricter pattern risks truncating real URLs that legitimately end
// in punctuation-like path segments.
const MENTION_OR_INLINE_CODE_PATTERN = /@([a-zA-Z0-9_]+)|`([^`\n]+)`|:([a-zA-Z0-9_]+):|(https?:\/\/[^\s<]+)/g;
// ```lang\n...\n``` — lang is optional, kept only for the header label.
const CODE_BLOCK_PATTERN = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;
const TRAILING_PUNCTUATION_PATTERN = /[.,!?;:'")\]]+$/;

// Used to find the one URL (if any) a link-preview card gets rendered for —
// Discord-style "just the first link", not one card per URL in the message.
// Code blocks/inline code are stripped first so a URL mentioned as code
// (e.g. an example in backticks) never triggers an unwanted preview fetch.
function extractFirstLinkPreviewUrl(content: string): string | null {
  const stripped = content.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]+`/g, " ");
  const match = stripped.match(/https?:\/\/[^\s<]+/);
  if (!match) return null;
  return match[0].replace(TRAILING_PUNCTUATION_PATTERN, "");
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return isToday ? `Today at ${time}` : `${date.toLocaleDateString()} ${time}`;
}

function formatShortTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Which "identity" posted a message, for consecutive-message grouping —
// real users by authorId, webhooks/the built-in bot by display name (the
// only identity the client has for those, since webhookId isn't exposed
// to the frontend).
export function messageIdentityKey(m: Message): string {
  if (m.isSystemBot) return "bot:system";
  if (m.isWebhook) return `bot:${m.authorUsername ?? "webhook"}`;
  return `user:${m.authorId}`;
}

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

// Only highlights @tokens that match a real member username — a plain "@"
// followed by text that isn't anyone here stays as ordinary text, since
// there's no backend concept of a real mention/ping to back up styling it
// otherwise. Also handles `inline code` spans and :name: custom-emoji
// shortcodes within the same pass — an unmatched :name: (no custom emoji
// by that name) stays as ordinary text too, same as an unmatched @mention.
function renderInline(
  text: string,
  memberUsernames: Set<string>,
  customEmojiByName: Map<string, string>,
  keyPrefix: string,
  baseUrl: string,
  token: string,
): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  MENTION_OR_INLINE_CODE_PATTERN.lastIndex = 0;
  while ((match = MENTION_OR_INLINE_CODE_PATTERN.exec(text))) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const username = match[1];
    const inlineCode = match[2];
    const emojiName = match[3];
    const rawUrl = match[4];
    if (username !== undefined) {
      if (memberUsernames.has(username)) {
        parts.push(
          <span key={`${keyPrefix}-${key++}`} className="mention">
            @{username}
          </span>,
        );
      } else {
        parts.push(match[0]);
      }
    } else if (emojiName !== undefined) {
      const imageUrl = customEmojiByName.get(emojiName);
      if (imageUrl) {
        parts.push(
          <img
            key={`${keyPrefix}-${key++}`}
            src={authedMediaUrl(imageUrl, baseUrl, token)}
            alt={`:${emojiName}:`}
            title={`:${emojiName}:`}
            className="custom-emoji-inline"
          />,
        );
      } else {
        parts.push(match[0]);
      }
    } else if (rawUrl !== undefined) {
      const trimmedUrl = rawUrl.replace(TRAILING_PUNCTUATION_PATTERN, "");
      const trailing = rawUrl.slice(trimmedUrl.length);
      parts.push(
        <a key={`${keyPrefix}-${key++}`} href={trimmedUrl} target="_blank" rel="noopener noreferrer" className="message-link">
          {trimmedUrl}
        </a>,
      );
      if (trailing) parts.push(trailing);
    } else {
      parts.push(
        <code key={`${keyPrefix}-${key++}`} className="inline-code">
          {inlineCode}
        </code>,
      );
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

// Splits out ```fenced``` code blocks first (rendered as <pre><code>,
// whitespace preserved verbatim, no mention/inline-code/emoji parsing
// inside), then runs mention/inline-code/emoji highlighting over everything
// in between.
function renderContent(
  content: string,
  memberUsernames: Set<string>,
  customEmojiByName: Map<string, string>,
  baseUrl: string,
  token: string,
): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  CODE_BLOCK_PATTERN.lastIndex = 0;
  while ((match = CODE_BLOCK_PATTERN.exec(content))) {
    if (match.index > lastIndex) {
      parts.push(...renderInline(content.slice(lastIndex, match.index), memberUsernames, customEmojiByName, `pre${key}`, baseUrl, token));
    }
    const lang = match[1];
    const code = match[2].replace(/\n$/, "");
    parts.push(
      <pre key={`code${key++}`} className="code-block">
        {lang && <div className="code-block-lang">{lang}</div>}
        <code>{code}</code>
      </pre>,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    parts.push(...renderInline(content.slice(lastIndex), memberUsernames, customEmojiByName, `post${key}`, baseUrl, token));
  }
  return parts;
}

export function MessageItem({
  baseUrl,
  token,
  message,
  grouped,
  isOnline,
  currentUserId,
  canModerate,
  memberUsernames,
  usernameByUserId,
  customEmojiByName,
  customEmoji,
  onEdit,
  onDelete,
  onReact,
  onUnreact,
  onReply,
  onPin,
  onUnpin,
  onViewProfile,
  onThreadClick,
}: {
  baseUrl: string;
  token: string;
  message: Message;
  // True when this message is a same-author, same-minute-ish continuation
  // of the one right above it — collapses the repeated avatar/name/
  // timestamp header, Discord-style.
  grouped: boolean;
  isOnline: boolean;
  currentUserId: string;
  canModerate: boolean;
  memberUsernames: Set<string>;
  // userId -> username, for the "who reacted" tooltip on each reaction
  // pill — reactions only carry userId (see prisma schema), same reasoning
  // as authorUsername needing a separate hydration step for messages.
  usernameByUserId: Map<string, string>;
  // name (no colons) -> image URL, for rendering :name: shortcodes inline
  // (message text) and as a reaction (reaction pills).
  customEmojiByName: Map<string, string>;
  // Same data as customEmojiByName, un-derived — the reaction picker's
  // EmojiPicker needs the raw list (id/name/imageUrl per tile), not a map.
  customEmoji: CustomEmoji[];
  onEdit: (messageId: string, content: string) => void;
  onDelete: (messageId: string) => void;
  onReact: (messageId: string, emoji: string) => void;
  onUnreact: (messageId: string, emoji: string) => void;
  onReply: (message: Message) => void;
  onPin: (messageId: string) => void;
  onUnpin: (messageId: string) => void;
  onViewProfile: (userId: string) => void;
  // Creates a thread on this message if it doesn't have one yet, then
  // opens it either way — same handler covers "start a thread" and
  // "open the existing thread" since the caller (App.tsx) knows which.
  onThreadClick: (message: Message) => void;
}) {
  // Desktop reveals the toolbar on :hover (index.css); there's no hover on
  // a touchscreen, so tapping the message body toggles this instead — see
  // the `.message.toolbar-active` rule in the mobile media query.
  const [toolbarActive, setToolbarActive] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [fullPickerOpen, setFullPickerOpen] = useState(false);
  // Which way the full emoji picker opens — normally upward (anchored to
  // the message's bottom edge, matching the composer's own picker), but
  // for a message near the top of the scrolled channel that pushes the
  // ~400px-tall panel off the top of the viewport entirely. Measured at
  // open-time against the message's own position, not assumed once.
  const [pickerOpensBelow, setPickerOpensBelow] = useState(false);
  const messageRef = useRef<HTMLDivElement>(null);
  const isOwn = message.authorId === currentUserId;
  const authorName = message.authorUsername ?? message.authorId;

  const reactionCounts = new Map<string, { count: number; reactedByMe: boolean; reactorNames: string[] }>();
  for (const r of message.reactions ?? []) {
    const entry = reactionCounts.get(r.emoji) ?? { count: 0, reactedByMe: false, reactorNames: [] };
    entry.count += 1;
    if (r.userId === currentUserId) entry.reactedByMe = true;
    entry.reactorNames.push(r.userId === currentUserId ? "You" : usernameByUserId.get(r.userId) ?? "unknown user");
    reactionCounts.set(r.emoji, entry);
  }

  function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (draft.trim()) onEdit(message.id, draft.trim());
    setEditing(false);
  }

  // Trimmed because EmojiPicker's custom-emoji tiles pass ":name: " (with a
  // trailing space, meant for continuing to type in the composer) — the
  // reaction value itself has to be the exact ":name:" with nothing extra,
  // not "insert-into-text" formatting.
  function toggleReaction(rawEmoji: string) {
    const emoji = rawEmoji.trim();
    const mine = reactionCounts.get(emoji)?.reactedByMe;
    if (mine) onUnreact(message.id, emoji);
    else onReact(message.id, emoji);
    setPickerOpen(false);
    setFullPickerOpen(false);
  }

  // ~400px covers .picker-panel's 360px max-height plus its padding/margin
  // — an estimate rather than a live measurement, since the panel isn't in
  // the DOM yet at the moment this decision has to be made.
  const FULL_PICKER_ESTIMATED_HEIGHT = 400;
  function openFullPicker() {
    const rect = messageRef.current?.getBoundingClientRect();
    setPickerOpensBelow(!!rect && rect.top < FULL_PICKER_ESTIMATED_HEIGHT);
    setPickerOpen(false);
    setFullPickerOpen(true);
  }

  const isRealUser = !message.isWebhook && !message.isSystemBot && !!message.authorId;
  const linkPreviewUrl = message.content ? extractFirstLinkPreviewUrl(message.content) : null;

  return (
    <div
      ref={messageRef}
      className={`message ${grouped ? "message-grouped" : ""} ${toolbarActive ? "toolbar-active" : ""}`}
      onClick={(e) => {
        // Only toggle for taps on plain message content — clicking an
        // actual interactive element (avatar, reaction, link, attachment)
        // should do that element's own thing, not also flip the toolbar.
        const target = e.target as HTMLElement;
        if (target.closest("button, a, input, textarea")) return;
        setToolbarActive((v) => !v);
      }}
    >
      {grouped ? (
        <span className="message-hover-timestamp">{formatShortTime(message.createdAt)}</span>
      ) : isRealUser ? (
        <button type="button" className="avatar-btn" onClick={() => onViewProfile(message.authorId)}>
          {message.authorAvatarUrl ? (
            <img className="avatar" src={authedMediaUrl(message.authorAvatarUrl, baseUrl, token)} alt="" />
          ) : (
            <span className="avatar avatar-placeholder">{initials(authorName)}</span>
          )}
        </button>
      ) : message.authorAvatarUrl ? (
        <img className="avatar" src={authedMediaUrl(message.authorAvatarUrl, baseUrl, token)} alt="" />
      ) : (
        <span className="avatar avatar-placeholder">{initials(authorName)}</span>
      )}
      <div className="message-body">
        {grouped ? (
          message.pinned && (
            <span className="pinned-badge pinned-badge-grouped" title="Pinned message">
              📌
            </span>
          )
        ) : (
          <div className="message-header">
            {message.isWebhook || message.isSystemBot ? (
              <span className="bot-badge">BOT</span>
            ) : (
              <span className={`presence-dot ${isOnline ? "online" : "offline"}`} />
            )}
            {isRealUser ? (
              <button type="button" className="message-author-btn" onClick={() => onViewProfile(message.authorId)}>
                {authorName}
              </button>
            ) : (
              <span className="message-author">{authorName}</span>
            )}
            <span className="message-timestamp">{formatTimestamp(message.createdAt)}</span>
            {message.pinned && (
              <span className="pinned-badge" title="Pinned message">
                📌
              </span>
            )}
          </div>
        )}

        {message.replyTo && (
          <div className="reply-preview">
            <span className="reply-arrow">↩</span>
            <span className="reply-author">{message.replyTo.authorUsername ?? "unknown"}</span>
            <span className="reply-snippet">{message.replyTo.content || "(attachment)"}</span>
          </div>
        )}

        {editing ? (
          <form onSubmit={submitEdit} className="edit-form">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
            <button type="submit">Save</button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        ) : (
          message.content && (
            <div className="message-content">
              {renderContent(message.content, memberUsernames, customEmojiByName, baseUrl, token)}
              {message.editedAt && <span className="edited-tag"> (edited)</span>}
            </div>
          )
        )}

        {message.attachmentUrl && (
          isImageAttachment(message.attachmentUrl) ? (
            <img className="message-attachment" src={authedMediaUrl(message.attachmentUrl, baseUrl, token)} alt="attachment" />
          ) : isVideoAttachment(message.attachmentUrl) ? (
            <video className="message-video" src={authedMediaUrl(message.attachmentUrl, baseUrl, token)} controls preload="metadata" />
          ) : (
            <a
              className="message-file-attachment"
              href={message.attachmentUrl}
              target="_blank"
              rel="noopener noreferrer"
              download
            >
              📎 {attachmentFilename(message.attachmentUrl)}
            </a>
          )
        )}

        {linkPreviewUrl && <LinkPreview baseUrl={baseUrl} token={token} url={linkPreviewUrl} />}

        {pickerOpen && (
          <div className="emoji-picker">
            {QUICK_EMOJIS.map((emoji) => (
              <button key={emoji} onClick={() => toggleReaction(emoji)}>
                {emoji}
              </button>
            ))}
            <button
              title="More emoji"
              onClick={openFullPicker}
            >
              ➕
            </button>
          </div>
        )}

        {fullPickerOpen && (
          <div className={`picker-popover reaction-full-picker ${pickerOpensBelow ? "picker-popover-below" : ""}`}>
            <EmojiPicker baseUrl={baseUrl} token={token} onSelect={toggleReaction} customEmoji={customEmoji} />
          </div>
        )}

        {reactionCounts.size > 0 && (
          <div className="reactions">
            {[...reactionCounts.entries()].map(([emoji, { count, reactedByMe, reactorNames }]) => {
              const customName = emoji.match(CUSTOM_EMOJI_REACTION_PATTERN)?.[1];
              const customUrl = customName ? customEmojiByName.get(customName) : undefined;
              return (
                <button
                  key={emoji}
                  className={`reaction-pill ${reactedByMe ? "mine" : ""}`}
                  onClick={() => toggleReaction(emoji)}
                  title={reactorNames.join(", ")}
                >
                  {customUrl ? <img src={authedMediaUrl(customUrl, baseUrl, token)} alt={emoji} className="reaction-emoji-img" /> : emoji} {count}
                </button>
              );
            })}
          </div>
        )}

        {message.thread && (
          <button type="button" className="thread-badge" onClick={() => onThreadClick(message)}>
            🧵 {message.thread.name} · {message.thread.messageCount} {message.thread.messageCount === 1 ? "message" : "messages"}
          </button>
        )}
      </div>

      <div className="message-toolbar">
        <button className="toolbar-btn" title="Reply" onClick={() => onReply(message)}>
          ↩️
        </button>
        <button className="toolbar-btn" title="React" onClick={() => setPickerOpen((v) => !v)}>
          😀
        </button>
        {!message.thread && (
          <button className="toolbar-btn" title="Reply in Thread" onClick={() => onThreadClick(message)}>
            🧵
          </button>
        )}
        {canModerate && (
          <button
            className="toolbar-btn"
            title={message.pinned ? "Unpin" : "Pin"}
            onClick={() => (message.pinned ? onUnpin(message.id) : onPin(message.id))}
          >
            📌
          </button>
        )}
        {isOwn && !editing && (
          <>
            <button className="toolbar-btn" title="Edit" onClick={() => setEditing(true)}>
              ✏️
            </button>
            <button className="toolbar-btn" title="Delete" onClick={() => onDelete(message.id)}>
              🗑️
            </button>
          </>
        )}
      </div>
    </div>
  );
}
