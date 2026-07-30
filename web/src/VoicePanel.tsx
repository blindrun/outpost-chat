import { Channel } from "./api";
import { VoiceSession } from "./useVoiceSession";

export function VoicePanel({ channel, session }: { channel: Channel; session: VoiceSession }) {
  const isThisChannel = session.activeChannel?.id === channel.id;

  return (
    <div className="voice-panel">
      <h3>🔊 {channel.name}</h3>

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
            <button className="btn secondary" onClick={session.toggleScreenShare}>
              {session.screenSharing ? "Stop Sharing" : "Share Screen"}
            </button>
          </>
        )}
      </div>
      {session.error && <p className="error">{session.error}</p>}
    </div>
  );
}
