import { useState } from "react";
import { Message } from "./api";
import { EmojiPicker } from "./EmojiPicker";
import { attachmentFilename, isImageAttachment } from "./uploadCategories";

const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🎉"];
const MENTION_OR_INLINE_CODE_PATTERN = /@([a-zA-Z0-9_]+)|`([^`\n]+)`/g;
// ```lang\n...\n``` — lang is optional, kept only for the header label.
const CODE_BLOCK_PATTERN = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;

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
// otherwise. Also handles `inline code` spans within the same pass.
function renderInline(text: string, memberUsernames: Set<string>, keyPrefix: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  MENTION_OR_INLINE_CODE_PATTERN.lastIndex = 0;
  while ((match = MENTION_OR_INLINE_CODE_PATTERN.exec(text))) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const username = match[1];
    const inlineCode = match[2];
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
// whitespace preserved verbatim, no mention/inline-code parsing inside),
// then runs mention/inline-code highlighting over everything in between.
function renderContent(content: string, memberUsernames: Set<string>): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  CODE_BLOCK_PATTERN.lastIndex = 0;
  while ((match = CODE_BLOCK_PATTERN.exec(content))) {
    if (match.index > lastIndex) {
      parts.push(...renderInline(content.slice(lastIndex, match.index), memberUsernames, `pre${key}`));
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
    parts.push(...renderInline(content.slice(lastIndex), memberUsernames, `post${key}`));
  }
  return parts;
}

export function MessageItem({
  message,
  grouped,
  isOnline,
  currentUserId,
  canModerate,
  memberUsernames,
  usernameByUserId,
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [fullPickerOpen, setFullPickerOpen] = useState(false);
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

  function toggleReaction(emoji: string) {
    const mine = reactionCounts.get(emoji)?.reactedByMe;
    if (mine) onUnreact(message.id, emoji);
    else onReact(message.id, emoji);
    setPickerOpen(false);
    setFullPickerOpen(false);
  }

  const isRealUser = !message.isWebhook && !message.isSystemBot && !!message.authorId;

  return (
    <div className={`message ${grouped ? "message-grouped" : ""}`}>
      {grouped ? (
        <span className="message-hover-timestamp">{formatShortTime(message.createdAt)}</span>
      ) : isRealUser ? (
        <button type="button" className="avatar-btn" onClick={() => onViewProfile(message.authorId)}>
          {message.authorAvatarUrl ? (
            <img className="avatar" src={message.authorAvatarUrl} alt="" />
          ) : (
            <span className="avatar avatar-placeholder">{initials(authorName)}</span>
          )}
        </button>
      ) : message.authorAvatarUrl ? (
        <img className="avatar" src={message.authorAvatarUrl} alt="" />
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
              {renderContent(message.content, memberUsernames)}
              {message.editedAt && <span className="edited-tag"> (edited)</span>}
            </div>
          )
        )}

        {message.attachmentUrl && (
          isImageAttachment(message.attachmentUrl) ? (
            <img className="message-attachment" src={message.attachmentUrl} alt="attachment" />
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

        {pickerOpen && (
          <div className="emoji-picker">
            {QUICK_EMOJIS.map((emoji) => (
              <button key={emoji} onClick={() => toggleReaction(emoji)}>
                {emoji}
              </button>
            ))}
            <button
              title="More emoji"
              onClick={() => {
                setPickerOpen(false);
                setFullPickerOpen(true);
              }}
            >
              ➕
            </button>
          </div>
        )}

        {fullPickerOpen && (
          <div className="picker-popover reaction-full-picker">
            <EmojiPicker onSelect={toggleReaction} />
          </div>
        )}

        {reactionCounts.size > 0 && (
          <div className="reactions">
            {[...reactionCounts.entries()].map(([emoji, { count, reactedByMe, reactorNames }]) => (
              <button
                key={emoji}
                className={`reaction-pill ${reactedByMe ? "mine" : ""}`}
                onClick={() => toggleReaction(emoji)}
                title={reactorNames.join(", ")}
              >
                {emoji} {count}
              </button>
            ))}
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
