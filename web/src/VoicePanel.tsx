import { useEffect, useRef, useState } from "react";
import {
  ConnectionState,
  LocalParticipant,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
} from "livekit-client";
import { Channel, getVoiceToken } from "./api";
import { AudioSettings, loadAudioSettings } from "./audioSettings";

// Hangover keeps the mic briefly open after level drops below threshold so
// VAD doesn't clip the tail end of words.
const VAD_HANGOVER_MS = 300;
const VAD_POLL_MS = 50;

interface ParticipantInfo {
  identity: string;
  name: string;
  isLocal: boolean;
}

function toInfo(p: Participant): ParticipantInfo {
  return { identity: p.identity, name: p.name || p.identity, isLocal: p instanceof LocalParticipant };
}

// Gates transmission on the bound key while connected; leaves the published
// track alone otherwise (mic starts disabled, matching "hold to talk").
function setupPushToTalk(
  room: Room,
  settings: AudioSettings,
  isCurrent: () => boolean,
  forceMutedRef: { current: boolean },
  setMicEnabled: (v: boolean) => void,
  setPttActive: (v: boolean) => void,
): () => void {
  if (!settings.pttKey) return () => {};
  const pttKey = settings.pttKey;

  function applyGate(active: boolean) {
    setPttActive(active);
    if (forceMutedRef.current) return;
    room.localParticipant
      .setMicrophoneEnabled(active)
      .then(() => isCurrent() && setMicEnabled(active))
      .catch((err) => console.warn("PTT mic toggle failed:", err));
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.code !== pttKey || e.repeat || !isCurrent()) return;
    applyGate(true);
  }
  function onKeyUp(e: KeyboardEvent) {
    if (e.code !== pttKey || !isCurrent()) return;
    applyGate(false);
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  };
}

// Monitors mic level via a clone of the already-published track (independent
// enabled/lifecycle from the original, so gating the original via LiveKit's
// mute doesn't blind the analyser) and gates transmission by threshold.
function setupVoiceActivity(
  room: Room,
  settings: AudioSettings,
  isCurrent: () => boolean,
  forceMutedRef: { current: boolean },
  setMicEnabled: (v: boolean) => void,
  setVadLevel: (v: number) => void,
): () => void {
  const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  const liveTrack = pub?.audioTrack?.mediaStreamTrack;
  if (!liveTrack) return () => {};

  const monitorTrack = liveTrack.clone();
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(new MediaStream([monitorTrack]));
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  let gateOpen = false;
  let hangoverTimer: ReturnType<typeof setTimeout> | null = null;

  function setGate(open: boolean) {
    if (open === gateOpen) return;
    gateOpen = open;
    if (!isCurrent() || forceMutedRef.current) return;
    room.localParticipant
      .setMicrophoneEnabled(open)
      .then(() => isCurrent() && setMicEnabled(open))
      .catch((err) => console.warn("VAD mic toggle failed:", err));
  }

  // Start gated closed until the level first crosses the threshold.
  room.localParticipant
    .setMicrophoneEnabled(false)
    .then(() => isCurrent() && setMicEnabled(false))
    .catch(() => {});

  const interval = setInterval(() => {
    analyser.getByteTimeDomainData(data);
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sumSquares += v * v;
    }
    const level = Math.min(100, Math.sqrt(sumSquares / data.length) * 300);
    if (isCurrent()) setVadLevel(level);

    if (level >= settings.vadThreshold) {
      if (hangoverTimer) {
        clearTimeout(hangoverTimer);
        hangoverTimer = null;
      }
      setGate(true);
    } else if (gateOpen && !hangoverTimer) {
      hangoverTimer = setTimeout(() => {
        hangoverTimer = null;
        setGate(false);
      }, VAD_HANGOVER_MS);
    }
  }, VAD_POLL_MS);

  return () => {
    clearInterval(interval);
    if (hangoverTimer) clearTimeout(hangoverTimer);
    monitorTrack.stop();
    audioCtx.close();
  };
}

export function VoicePanel({ baseUrl, token, channel }: { baseUrl: string; token: string; channel: Channel }) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);
  const [forceMuted, setForceMuted] = useState(false);
  const [pttActive, setPttActive] = useState(false);
  const [vadLevel, setVadLevel] = useState(0);
  const [mode, setMode] = useState<AudioSettings["mode"] | null>(null);
  const [participants, setParticipants] = useState<ParticipantInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const roomRef = useRef<Room | null>(null);
  const audioContainerRef = useRef<HTMLDivElement | null>(null);
  const automationCleanupRef = useRef<(() => void) | null>(null);
  const forceMutedRef = useRef(false);

  useEffect(() => {
    forceMutedRef.current = forceMuted;
  }, [forceMuted]);

  // Leaving the channel view (switching channels/unmounting) should always
  // disconnect — otherwise the LiveKit connection and mic stream leak.
  useEffect(() => {
    return () => {
      automationCleanupRef.current?.();
      automationCleanupRef.current = null;
      roomRef.current?.disconnect();
      roomRef.current = null;
    };
  }, [channel.id]);

  function refreshParticipants(room: Room) {
    setParticipants([toInfo(room.localParticipant), ...Array.from(room.remoteParticipants.values()).map(toInfo)]);
  }

  async function handleJoin() {
    setError(null);
    setConnecting(true);
    try {
      const { token: voiceToken, url } = await getVoiceToken(baseUrl, token, channel.id);
      const room = new Room();
      roomRef.current = room;

      // Every listener guards against `roomRef.current !== room` — if this
      // room has since been superseded (a new join, or a leave that raced
      // with an in-flight event from this one), its late-arriving events
      // must not touch state that now belongs to a different room/no room.
      const isCurrent = () => roomRef.current === room;
      const settings = loadAudioSettings();

      room.on(RoomEvent.ParticipantConnected, () => isCurrent() && refreshParticipants(room));
      room.on(RoomEvent.ParticipantDisconnected, () => isCurrent() && refreshParticipants(room));
      room.on(RoomEvent.ConnectionStateChanged, (state) => {
        if (!isCurrent()) return;
        if (state === ConnectionState.Disconnected) {
          automationCleanupRef.current?.();
          automationCleanupRef.current = null;
          setConnected(false);
          setConnecting(false);
          setParticipants([]);
        }
      });
      room.on(
        RoomEvent.TrackSubscribed,
        (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
          if (!isCurrent()) return;
          if (track.kind === Track.Kind.Audio && audioContainerRef.current) {
            const el = track.attach();
            el.dataset.participant = participant.identity;
            if (settings.outputDeviceId && "setSinkId" in el) {
              el.setSinkId(settings.outputDeviceId).catch((err) => console.warn("setSinkId failed:", err));
            }
            audioContainerRef.current.appendChild(el);
          }
        },
      );
      room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        if (!isCurrent()) return;
        track.detach().forEach((el) => el.remove());
      });

      await room.connect(url, voiceToken);
      if (!isCurrent()) return; // superseded (e.g. leave clicked) while connecting
      refreshParticipants(room);
      setConnected(true);
      setMode(settings.mode);
      setForceMuted(false);
      setPttActive(false);
      setVadLevel(0);

      // Mic may not be available (e.g. no input device in a test/CI browser) —
      // that shouldn't block joining the voice channel to see who else is in it.
      try {
        await room.localParticipant.setMicrophoneEnabled(
          true,
          settings.inputDeviceId ? { deviceId: settings.inputDeviceId } : undefined,
        );
        if (!isCurrent()) return;
        setMicEnabled(true);

        automationCleanupRef.current =
          settings.mode === "ptt"
            ? setupPushToTalk(room, settings, isCurrent, forceMutedRef, setMicEnabled, setPttActive)
            : setupVoiceActivity(room, settings, isCurrent, forceMutedRef, setMicEnabled, setVadLevel);
      } catch (micErr) {
        console.warn("Could not enable microphone:", micErr);
        if (isCurrent()) setMicEnabled(false);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConnecting(false);
    }
  }

  function handleLeave() {
    automationCleanupRef.current?.();
    automationCleanupRef.current = null;
    roomRef.current?.disconnect();
    roomRef.current = null;
    setConnected(false);
    setConnecting(false);
    setParticipants([]);
    setMicEnabled(false);
    setForceMuted(false);
    setPttActive(false);
    setMode(null);
  }

  async function toggleForceMute() {
    const room = roomRef.current;
    if (!room) return;
    const next = !forceMuted;
    setForceMuted(next);
    if (next) {
      try {
        await room.localParticipant.setMicrophoneEnabled(false);
        setMicEnabled(false);
      } catch (err) {
        setError((err as Error).message);
      }
    }
    // Un-force-muting doesn't immediately re-open the mic — PTT/VAD automation
    // re-gates it on the next key press / voice-activity trigger.
  }

  return (
    <div className="voice-panel">
      <h3>🔊 {channel.name}</h3>

      {participants.length > 0 && (
        <ul className="voice-participants">
          {participants.map((p) => (
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

      {connected && (
        <p className="voice-mic-status">
          {forceMuted
            ? "🔇 Force muted"
            : mode === "ptt"
              ? pttActive
                ? "🎙️ Transmitting (push to talk)"
                : "🔈 Hold key to talk"
              : micEnabled
                ? "🎙️ Transmitting (voice activity)"
                : "🔈 Listening…"}
        </p>
      )}
      {connected && mode === "vad" && !forceMuted && (
        <div className="mic-meter voice-vad-meter">
          <div className="mic-meter-fill" style={{ width: `${vadLevel}%` }} />
        </div>
      )}

      <div className="voice-controls">
        {!connected ? (
          <button className="btn" onClick={handleJoin} disabled={connecting}>
            {connecting ? "Joining…" : "Join Voice"}
          </button>
        ) : (
          <>
            <button className="btn secondary" onClick={handleLeave}>
              Leave Voice
            </button>
            <button className="btn" onClick={toggleForceMute}>
              {forceMuted ? "Unmute" : "Mute"}
            </button>
          </>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      <div ref={audioContainerRef} style={{ display: "none" }} />
    </div>
  );
}
