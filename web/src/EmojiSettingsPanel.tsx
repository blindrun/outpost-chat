import { useState } from "react";
import { CustomEmoji, createCustomEmoji, deleteCustomEmoji, uploadFile } from "./api";

export function EmojiSettingsPanel({
  baseUrl,
  token,
  customEmoji,
  onChanged,
}: {
  baseUrl: string;
  token: string;
  customEmoji: CustomEmoji[];
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !name.trim()) {
      setError("pick a name before choosing an image");
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const { url } = await uploadFile(baseUrl, token, file);
      await createCustomEmoji(baseUrl, token, name.trim(), url);
      setName("");
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteCustomEmoji(baseUrl, token, id);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="settings-section">
      <p className="subtitle">
        Custom server emoji, usable in message text as <code>:name:</code> — not usable as a message reaction
        yet, only in the text itself.
      </p>
      <label>
        Name
        <input
          placeholder="e.g. partyparrot"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={32}
        />
      </label>
      <div className="modal-actions">
        <label className="btn">
          {uploading ? "Uploading…" : "Choose Image"}
          <input type="file" accept="image/*" onChange={handleUpload} disabled={uploading} style={{ display: "none" }} />
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      <ul className="role-list">
        {customEmoji.map((e) => (
          <li key={e.id} className="role-row">
            <img src={e.imageUrl} alt={e.name} className="custom-emoji-preview" />
            <strong>:{e.name}:</strong>
            <button className="text-btn" onClick={() => handleDelete(e.id)}>
              delete
            </button>
          </li>
        ))}
        {customEmoji.length === 0 && <p className="picker-empty">No custom emoji yet.</p>}
      </ul>
    </div>
  );
}
