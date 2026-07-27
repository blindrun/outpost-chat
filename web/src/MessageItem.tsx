import { useState } from "react";
import { Message } from "./api";

const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🎉"];

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
      <div className="message-line">
        <span className={`presence-dot ${isOnline ? "online" : "offline"}`} />
        <strong>{message.authorUsername ?? message.authorId}</strong>:{" "}
        {editing ? (
          <form onSubmit={submitEdit} className="edit-form">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
            <button type="submit">Save</button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <>
            {message.content}
            {message.editedAt && <span className="edited-tag"> (edited)</span>}
          </>
        )}
        <span className="message-actions">
          <button className="icon-btn" onClick={() => setPickerOpen((v) => !v)}>
            react
          </button>
          {isOwn && !editing && (
            <>
              <button className="icon-btn" onClick={() => setEditing(true)}>
                edit
              </button>
              <button className="icon-btn" onClick={() => onDelete(message.id)}>
                delete
              </button>
            </>
          )}
        </span>
      </div>
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
  );
}
