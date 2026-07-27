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

interface ParticipantInfo {
  identity: string;
  name: string;
  isLocal: boolean;
}

function toInfo(p: Participant): ParticipantInfo {
  return { identity: p.identity, name: p.name || p.identity, isLocal: p instanceof LocalParticipant };
}

export function VoicePanel({ token, channel }: { token: string; channel: Channel }) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);
  const [participants, setParticipants] = useState<ParticipantInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const roomRef = useRef<Room | null>(null);
  const audioContainerRef = useRef<HTMLDivElement | null>(null);

  // Leaving the channel view (switching channels/unmounting) should always
  // disconnect — otherwise the LiveKit connection and mic stream leak.
  useEffect(() => {
    return () => {
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
      const { token: voiceToken, url } = await getVoiceToken(token, channel.id);
      const room = new Room();
      roomRef.current = room;

      // Every listener guards against `roomRef.current !== room` — if this
      // room has since been superseded (a new join, or a leave that raced
      // with an in-flight event from this one), its late-arriving events
      // must not touch state that now belongs to a different room/no room.
      const isCurrent = () => roomRef.current === room;

      room.on(RoomEvent.ParticipantConnected, () => isCurrent() && refreshParticipants(room));
      room.on(RoomEvent.ParticipantDisconnected, () => isCurrent() && refreshParticipants(room));
      room.on(RoomEvent.ConnectionStateChanged, (state) => {
        if (!isCurrent()) return;
        if (state === ConnectionState.Disconnected) {
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

      // Mic may not be available (e.g. no input device in a test/CI browser) —
      // that shouldn't block joining the voice channel to see who else is in it.
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
        if (isCurrent()) setMicEnabled(true);
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
    roomRef.current?.disconnect();
    roomRef.current = null;
    setConnected(false);
    setConnecting(false);
    setParticipants([]);
    setMicEnabled(false);
  }

  async function toggleMic() {
    const room = roomRef.current;
    if (!room) return;
    const next = !micEnabled;
    try {
      await room.localParticipant.setMicrophoneEnabled(next);
      setMicEnabled(next);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="voice-panel">
      <h3>🔊 {channel.name}</h3>
      {!connected ? (
        <button onClick={handleJoin} disabled={connecting}>
          {connecting ? "Joining…" : "Join Voice"}
        </button>
      ) : (
        <>
          <button onClick={handleLeave}>Leave Voice</button>
          <button onClick={toggleMic}>{micEnabled ? "Mute" : "Unmute"}</button>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <ul className="voice-participants">
        {participants.map((p) => (
          <li key={p.identity}>
            {p.name} {p.isLocal && "(you)"}
          </li>
        ))}
      </ul>
      <div ref={audioContainerRef} style={{ display: "none" }} />
    </div>
  );
}
