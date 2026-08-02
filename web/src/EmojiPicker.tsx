import { useMemo, useState } from "react";
import { EMOJI_CATEGORIES, EMOJI_LIST } from "./emojiData";
import { authedMediaUrl, CustomEmoji } from "./api";

const SERVER_CATEGORY = "Server";

// customEmoji is optional and defaults empty — the reaction picker in
// MessageItem.tsx deliberately doesn't pass it, since a reaction's emoji
// value is a short raw string rendered as plain text, not an image (see
// the CustomEmoji Prisma model's comment for why that's a separate,
// bigger change). Only the message composer passes a real list.
export function EmojiPicker({
  baseUrl,
  token,
  onSelect,
  customEmoji = [],
}: {
  baseUrl: string;
  token: string;
  onSelect: (value: string) => void;
  customEmoji?: CustomEmoji[];
}) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>(EMOJI_CATEGORIES[0]);
  const categories = customEmoji.length > 0 ? [SERVER_CATEGORY, ...EMOJI_CATEGORIES] : EMOJI_CATEGORIES;

  const builtInResults = useMemo(() => {
    if (!search.trim()) return EMOJI_LIST.filter((e) => e.category === category);
    const q = search.trim().toLowerCase();
    return EMOJI_LIST.filter((e) => e.name.includes(q));
  }, [search, category]);

  const customResults = useMemo(() => {
    if (!search.trim()) return category === SERVER_CATEGORY ? customEmoji : [];
    const q = search.trim().toLowerCase();
    return customEmoji.filter((e) => e.name.includes(q));
  }, [search, category, customEmoji]);

  return (
    <div className="picker-panel">
      <input
        className="picker-search"
        placeholder="Search emoji"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        autoFocus
      />
      {!search.trim() && (
        <div className="picker-tabs">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              className={c === category ? "active" : ""}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>
      )}
      <div className="picker-grid">
        {customResults.map((e) => (
          <button
            key={`custom-${e.id}`}
            type="button"
            title={`:${e.name}:`}
            className="picker-emoji picker-emoji-custom"
            onClick={() => onSelect(`:${e.name}: `)}
          >
            <img src={authedMediaUrl(e.imageUrl, baseUrl, token)} alt={e.name} />
          </button>
        ))}
        {builtInResults.map((e) => (
          <button
            key={e.emoji + e.name}
            type="button"
            title={e.name}
            className="picker-emoji"
            onClick={() => onSelect(e.emoji)}
          >
            {e.emoji}
          </button>
        ))}
        {builtInResults.length === 0 && customResults.length === 0 && <p className="picker-empty">No matches</p>}
      </div>
    </div>
  );
}
