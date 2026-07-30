import { useMemo, useState } from "react";
import { EMOJI_CATEGORIES, EMOJI_LIST } from "./emojiData";

export function EmojiPicker({ onSelect }: { onSelect: (emoji: string) => void }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState(EMOJI_CATEGORIES[0]);

  const results = useMemo(() => {
    if (!search.trim()) return EMOJI_LIST.filter((e) => e.category === category);
    const q = search.trim().toLowerCase();
    return EMOJI_LIST.filter((e) => e.name.includes(q));
  }, [search, category]);

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
          {EMOJI_CATEGORIES.map((c) => (
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
        {results.map((e) => (
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
        {results.length === 0 && <p className="picker-empty">No matches</p>}
      </div>
    </div>
  );
}
