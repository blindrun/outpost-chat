import { useState } from "react";
import { Message } from "./api";

const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🎉"];

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return isToday ? `Today at ${time}` : `${date.toLocaleDateString()} ${time}`;
}

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

export function MessageItem({
  message,
  isOnline,
  currentUserId,
  onEdit,
  onDelete,
  onReact,
  onUnreact,
}: {
  message: Message;
  isOnline: boolean;
  currentUserId: string;
  onEdit: (messageId: string, content: string) => void;
  onDelete: (messageId: string) => void;
  onReact: (messageId: string, emoji: string) => void;
  onUnreact: (messageId: string, emoji: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [pickerOpen, setPickerOpen] = useState(false);
  const isOwn = message.authorId === currentUserId;
  const authorName = message.authorUsername ?? message.authorId;

  const reactionCounts = new Map<string, { count: number; reactedByMe: boolean }>();
  for (const r of message.reactions ?? []) {
    const entry = reactionCounts.get(r.emoji) ?? { count: 0, reactedByMe: false };
    entry.count += 1;
    if (r.userId === currentUserId) entry.reactedByMe = true;
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
  }

  return (
    <div className="message">
      {message.authorAvatarUrl ? (
        <img className="avatar" src={message.authorAvatarUrl} alt="" />
      ) : (
        <span className="avatar avatar-placeholder">{initials(authorName)}</span>
      )}
      <div className="message-body">
        <div className="message-header">
          <span className={`presence-dot ${isOnline ? "online" : "offline"}`} />
          <span className="message-author">{authorName}</span>
          <span className="message-timestamp">{formatTimestamp(message.createdAt)}</span>
        </div>

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
              {message.content}
              {message.editedAt && <span className="edited-tag"> (edited)</span>}
            </div>
          )
        )}

        {message.attachmentUrl && (
          <img className="message-attachment" src={message.attachmentUrl} alt="attachment" />
        )}

        {pickerOpen && (
          <div className="emoji-picker">
            {QUICK_EMOJIS.map((emoji) => (
              <button key={emoji} onClick={() => toggleReaction(emoji)}>
                {emoji}
              </button>
            ))}
          </div>
        )}

        {reactionCounts.size > 0 && (
          <div className="reactions">
            {[...reactionCounts.entries()].map(([emoji, { count, reactedByMe }]) => (
              <button
                key={emoji}
                className={`reaction-pill ${reactedByMe ? "mine" : ""}`}
                onClick={() => toggleReaction(emoji)}
              >
                {emoji} {count}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="message-toolbar">
        <button className="toolbar-btn" title="React" onClick={() => setPickerOpen((v) => !v)}>
          😀
        </button>
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
