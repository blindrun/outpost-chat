import { useState } from "react";
import { Channel } from "./api";
import { VoiceSession } from "./useVoiceSession";

export function VoicePanel({ channel, session }: { channel: Channel; session: VoiceSession }) {
  const isThisChannel = session.activeChannel?.id === channel.id;
  // Local, not lifted to App — this popover remounts fresh each time it's
  // reopened (see voiceDetailsOpen in App.tsx), so starting expanded every
  // time is the right default rather than persisting a minimized state
  // across opens.
  const [minimized, setMinimized] = useState(false);

  const micStatusEmoji = session.deafened
    ? "🔇"
    : session.muted
      ? "🔇"
      : session.mode === "ptt"
        ? session.pttActive
          ? "🎙️"
          : "🔈"
        : session.micEnabled
          ? "🎙️"
          : "🔈";

  return (
    <div className={`voice-panel ${minimized ? "minimized" : ""}`}>
      <div className="voice-panel-header">
        <h3>
          {minimized && `${micStatusEmoji} `}🔊 {channel.name}
        </h3>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setMinimized((m) => !m)}
          title={minimized ? "Expand" : "Minimize"}
        >
          {minimized ? "▢" : "─"}
        </button>
      </div>

      {minimized ? null : (
        <>
          {isThisChannel && session.participants.length > 0 && (
            <ul className="voice-participants">
              {session.participants.map((p) => (
                <li key={p.identity} className="voice-participant">
                  <span className="avatar avatar-placeholder">{p.name.slice(0, 2).toUpperCase()}</span>
                  <span className="voice-participant-name">
                    {p.name}
                    {p.isLocal && " (you)"}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {isThisChannel && (
            <p className="voice-mic-status">
              {session.deafened
                ? "🔇 Deafened"
                : session.muted
                  ? "🔇 Muted"
                  : session.mode === "ptt"
                    ? session.pttActive
                      ? "🎙️ Transmitting (push to talk)"
                      : "🔈 Hold key to talk"
                    : session.micEnabled
                      ? "🎙️ Transmitting (voice activity)"
                      : "🔈 Listening…"}
            </p>
          )}
          {isThisChannel && session.mode === "vad" && !session.muted && !session.deafened && (
            <div className="mic-meter voice-vad-meter">
              <div className="mic-meter-fill" style={{ width: `${session.vadLevel}%` }} />
            </div>
          )}
          {isThisChannel && session.mode === "ptt" && !session.muted && !session.deafened && (
            // Same gate the keyboard PTT binding drives (useVoiceSession's
            // triggerPtt) — there's no keyboard to bind on a touch-only client.
            // Works alongside a keyboard binding too, not a replacement for it.
            <button
              type="button"
              className={`btn ptt-hold-btn ${session.pttActive ? "active" : ""}`}
              onMouseDown={() => session.triggerPtt(true)}
              onMouseUp={() => session.triggerPtt(false)}
              onMouseLeave={() => session.pttActive && session.triggerPtt(false)}
              onTouchStart={(e) => {
                e.preventDefault();
                session.triggerPtt(true);
              }}
              onTouchEnd={() => session.triggerPtt(false)}
            >
              {session.pttActive ? "🎙️ Talking…" : "Hold to Talk"}
            </button>
          )}

          {!isThisChannel && session.activeChannel && (
            <p className="voice-status-note">Connected to 🔊 {session.activeChannel.name} elsewhere</p>
          )}

          <div className="voice-controls">
            {!isThisChannel ? (
              <button className="btn" onClick={() => session.join(channel)} disabled={session.connecting}>
                {session.connecting ? "Joining…" : "Join Voice"}
              </button>
            ) : (
              <>
                <button className="btn secondary" onClick={session.leave}>
                  Leave Voice
                </button>
                <button className="btn" onClick={session.toggleMute}>
                  {session.muted ? "Unmute" : "Mute"}
                </button>
                <button className="btn" onClick={session.toggleDeafen}>
                  {session.deafened ? "Undeafen" : "Deafen"}
                </button>
                {session.cameraSupported && (
                  <button className="btn secondary" onClick={session.toggleCamera}>
                    {session.cameraOn ? "Stop Video" : "Start Video"}
                  </button>
                )}
                {session.screenShareSupported && (
                  <button className="btn secondary" onClick={session.toggleScreenShare}>
                    {session.screenSharing ? "Stop Sharing" : "Share Screen"}
                  </button>
                )}
              </>
            )}
          </div>
          {session.error && <p className="error">{session.error}</p>}
        </>
      )}
    </div>
  );
}
