import { useCallback, useEffect, useState } from "react";
import { REPORT_REASONS, Report, dismissReport, listReports, resolveReport } from "./api";

const REASON_LABELS: Record<string, string> = Object.fromEntries(REPORT_REASONS.map((r) => [r.value, r.label]));

// The moderator side of member reporting: a queue of what's been flagged,
// with the reported text captured at report time so it survives the author
// deleting it. Acting on a report (warn/mute/ban) happens through the
// member's profile card as it always has — this panel is about triage, so
// it deliberately only closes reports rather than duplicating every
// moderation action.
export function ReportsPanel({
  baseUrl,
  token,
  onViewProfile,
}: {
  baseUrl: string;
  token: string;
  onViewProfile: (userId: string) => void;
}) {
  const [status, setStatus] = useState<"OPEN" | "ALL">("OPEN");
  const [reports, setReports] = useState<Report[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    listReports(baseUrl, token, status)
      .then((r) => {
        setReports(r.reports);
        setOpenCount(r.openCount);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [baseUrl, token, status]);

  useEffect(refresh, [refresh]);

  async function handle(reportId: string, action: "resolve" | "dismiss") {
    setBusyId(reportId);
    setError(null);
    try {
      if (action === "resolve") await resolveReport(baseUrl, token, reportId);
      else await dismissReport(baseUrl, token, reportId);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="settings-section">
      <p className="subtitle">
        Messages and members flagged by other people on this server, newest first. Resolve once you've acted on one,
        dismiss if there was nothing to do — either way it's recorded in the audit log.
      </p>
      <div className="mod-actions-row">
        <button className={status === "OPEN" ? "btn" : "btn secondary"} onClick={() => setStatus("OPEN")}>
          Open ({openCount})
        </button>
        <button className={status === "ALL" ? "btn" : "btn secondary"} onClick={() => setStatus("ALL")}>
          All
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {loading && <p className="picker-empty">Loading…</p>}
      {!loading && reports.length === 0 && (
        <p className="picker-empty">{status === "OPEN" ? "Nothing reported right now." : "No reports yet."}</p>
      )}
      <ul className="member-list">
        {reports.map((r) => (
          <li key={r.id} className="member-row report-row">
            <div>
              <span className="member-username">
                <strong>{r.reporterUsername}</strong> reported <strong>{r.targetUsername}</strong>
                {r.targetBanned ? " (banned)" : ""} — {REASON_LABELS[r.reason] ?? r.reason}
              </span>
              <span className="invite-meta">
                {new Date(r.createdAt).toLocaleString()}
                {r.channelName ? ` · in ${r.channelName}` : ""}
                {r.status !== "OPEN" ? ` · ${r.status.toLowerCase()} by ${r.handledByUsername ?? "unknown user"}` : ""}
              </span>
              {r.detail && <p className="report-detail">“{r.detail}”</p>}
              {r.messageContent !== null && (
                <blockquote className="report-quote">
                  {r.messageContent || <em>(no text — an attachment or embed only)</em>}
                  {r.contentFromReporter && (
                    <span className="invite-meta">
                      {" "}
                      — supplied by the reporter, not verified: this was an encrypted direct message the server can't
                      read.
                    </span>
                  )}
                </blockquote>
              )}
            </div>
            <div className="mod-actions-row">
              <button className="btn secondary" onClick={() => onViewProfile(r.targetUserId)}>
                View member
              </button>
              {r.status === "OPEN" && (
                <>
                  <button className="btn secondary" disabled={busyId === r.id} onClick={() => handle(r.id, "resolve")}>
                    Resolve
                  </button>
                  <button className="btn secondary" disabled={busyId === r.id} onClick={() => handle(r.id, "dismiss")}>
                    Dismiss
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
