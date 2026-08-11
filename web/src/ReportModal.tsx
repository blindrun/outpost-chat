import { useState } from "react";
import { Modal } from "./Modal";
import { REPORT_REASONS, ReportReason, createReport } from "./api";

// Reporting a specific message or a member generally — the same dialog for
// both, since the only difference is what the server derives the target from.
// A reported message carries its text along only when it's an encrypted DM,
// where the server has no plaintext of its own to store (see routes/reports.ts).
export function ReportModal({
  baseUrl,
  token,
  targetUsername,
  messageId,
  targetUserId,
  encryptedMessageContent,
  onClose,
}: {
  baseUrl: string;
  token: string;
  targetUsername: string;
  messageId?: string;
  targetUserId?: string;
  encryptedMessageContent?: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<ReportReason>("harassment");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"new" | "duplicate" | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await createReport(baseUrl, token, {
        messageId,
        targetUserId,
        reason,
        detail: detail.trim() || undefined,
        messageContent: encryptedMessageContent,
      });
      setDone(result.alreadyReported ? "duplicate" : "new");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Modal onClose={onClose}>
        <h3>Thanks — report sent</h3>
        <p className="invite-meta">
          {done === "duplicate"
            ? "You'd already reported this, so it's still in the moderators' queue rather than filed twice."
            : "A moderator will review it. You won't be told the outcome, but you can block this person in the meantime so you stop seeing their messages."}
        </p>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose}>
      <h3>Report {messageId ? "message" : "member"}</h3>
      <p className="invite-meta">
        This goes to this server's moderators, not to Outpost. {targetUsername} isn't told who reported them.
      </p>
      <form onSubmit={submit}>
        <label>
          What's wrong?
          <select value={reason} onChange={(e) => setReason(e.target.value as ReportReason)}>
            {REPORT_REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Anything else? (optional)
          <textarea
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            maxLength={1000}
            rows={3}
            placeholder="Context that would help a moderator"
          />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="mod-actions-row">
          <button type="submit" className="btn" disabled={busy}>
            {busy ? "Sending…" : "Send report"}
          </button>
          <button type="button" className="btn secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
