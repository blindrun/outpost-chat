import { MutableRefObject, useCallback, useRef, useState } from "react";
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
import { Channel, Gateway, getVoiceToken } from "./api";
import { AudioSettings, loadAudioSettings } from "./audioSettings";

// Hangover keeps the mic briefly open after level drops below threshold so
// VAD doesn't clip the tail end of words.
const VAD_HANGOVER_MS = 300;
const VAD_POLL_MS = 50;

export interface ParticipantInfo {
  identity: string;
  name: string;
  isLocal: boolean;
}

function toInfo(p: Participant): ParticipantInfo {
  return { identity: p.identity, name: p.name || p.identity, isLocal: p instanceof LocalParticipant };
}

// Gates transmission on the bound key while connected; leaves the published
// track alone otherwise (mic starts disabled, matching "hold to talk").
// `gateRef` is also handed the same gate function so a touch-only client
// (no keyboard to bind) can drive it from an on-screen hold button instead —
// see `triggerPtt` in the hook below.
function setupPushToTalk(
  room: Room,
  settings: AudioSettings,
  isCurrent: () => boolean,
  mutedRef: { current: boolean },
  setMicEnabled: (v: boolean) => void,
  setPttActive: (v: boolean) => void,
  gateRef: MutableRefObject<((active: boolean) => void) | null>,
): () => void {
  function applyGate(active: boolean) {
    setPttActive(active);
    if (mutedRef.current) return;
    room.localParticipant
      .setMicrophoneEnabled(active)
      .then(() => isCurrent() && setMicEnabled(active))
      .catch((err) => console.warn("PTT mic toggle failed:", err));
  }

  gateRef.current = applyGate;

  if (!settings.pttKey) {
    return () => {
      gateRef.current = null;
    };
  }
  const pttKey = settings.pttKey;

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
    gateRef.current = null;
  };
}

// Monitors mic level via a clone of the already-published track (independent
// enabled/lifecycle from the original, so gating the original via LiveKit's
// mute doesn't blind the analyser) and gates transmission by threshold.
function setupVoiceActivity(
  room: Room,
  settings: AudioSettings,
  isCurrent: () => boolean,
  mutedRef: { current: boolean },
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
    if (!isCurrent() || mutedRef.current) return;
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

// Owns the LiveKit room for the whole app (not per-channel-view), so voice
// stays connected while browsing other channels — mirroring Discord's
// persistent bottom voice bar. VoicePanel and the user-panel mute/deafen
// buttons both read from this single instance.
export function useVoiceSession(baseUrl: string, token: string, gatewayRef: MutableRefObject<Gateway | null>) {
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [participants, setParticipants] = useState<ParticipantInfo[]>([]);
  // Only ever populated for the room this client is actually connected to —
  // LiveKit only reports speaking activity for a room you've joined, so
  // there's no way to know this for voice channels the user isn't in.
  const [speakingUserIds, setSpeakingUserIds] = useState<Set<string>>(new Set());
  const [micEnabled, setMicEnabled] = useState(false);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [pttActive, setPttActive] = useState(false);
  const [vadLevel, setVadLevel] = useState(0);
  const [mode, setMode] = useState<AudioSettings["mode"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [screenSharing, setScreenSharing] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const audioContainerRef = useRef<HTMLDivElement | null>(null);
  // Visible, unlike audioContainerRef — screen share video tiles render
  // here directly (both remote shares and the local preview), one <video>
  // element per active share, labeled via a data attribute set on attach.
  const videoContainerRef = useRef<HTMLDivElement | null>(null);
  const automationCleanupRef = useRef<(() => void) | null>(null);
  // Set only while mode === "ptt" and connected — see setupPushToTalk. Lets
  // an on-screen hold button (no physical keyboard on mobile) drive the
  // same gate the keyboard binding does.
  const pttGateRef = useRef<((active: boolean) => void) | null>(null);
  const mutedRef = useRef(false);
  const deafenedRef = useRef(false);
  const mutedBeforeDeafenRef = useRef(false);
  const screenSharingRef = useRef(false);

  function refreshParticipants(room: Room) {
    setParticipants([toInfo(room.localParticipant), ...Array.from(room.remoteParticipants.values()).map(toInfo)]);
  }

  function applyDeafenToElements(deaf: boolean) {
    audioContainerRef.current?.querySelectorAll("audio").forEach((el) => {
      (el as HTMLAudioElement).muted = deaf;
    });
  }

  const join = useCallback(
    async (channel: Channel) => {
      setError(null);
      setConnecting(true);
      try {
        const { token: voiceToken, url } = await getVoiceToken(baseUrl, token, channel.id);

        automationCleanupRef.current?.();
        automationCleanupRef.current = null;
        roomRef.current?.disconnect();

        const room = new Room();
        roomRef.current = room;
        setActiveChannel(channel);

        // Every listener guards against `roomRef.current !== room` — if this
        // room has since been superseded (a new join, or a leave that raced
        // with an in-flight event from this one), its late-arriving events
        // must not touch state that now belongs to a different room/no room.
        const isCurrent = () => roomRef.current === room;
        const settings = loadAudioSettings();

        room.on(RoomEvent.ParticipantConnected, () => isCurrent() && refreshParticipants(room));
        room.on(RoomEvent.ParticipantDisconnected, () => isCurrent() && refreshParticipants(room));
        room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
          if (!isCurrent()) return;
          setSpeakingUserIds(new Set(speakers.map((s) => s.identity)));
        });
        room.on(RoomEvent.ConnectionStateChanged, (state) => {
          if (!isCurrent()) return;
          if (state === ConnectionState.Disconnected) {
            automationCleanupRef.current?.();
            automationCleanupRef.current = null;
            gatewayRef.current?.sendVoiceLeave();
            setActiveChannel(null);
            setConnecting(false);
            setParticipants([]);
            setSpeakingUserIds(new Set());
            setMode(null);
            setPttActive(false);
            setVadLevel(0);
            screenSharingRef.current = false;
            setScreenSharing(false);
          }
        });
        room.on(
          RoomEvent.TrackSubscribed,
          (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
            if (!isCurrent()) return;
            if (track.kind === Track.Kind.Audio && audioContainerRef.current) {
              const el = track.attach();
              el.dataset.participant = participant.identity;
              el.muted = deafenedRef.current;
              if (settings.outputDeviceId && "setSinkId" in el) {
                el.setSinkId(settings.outputDeviceId).catch((err) => console.warn("setSinkId failed:", err));
              }
              audioContainerRef.current.appendChild(el);
            } else if (track.source === Track.Source.ScreenShare && videoContainerRef.current) {
              const el = track.attach();
              el.dataset.participant = participant.identity;
              el.className = "screen-share-video";
              const wrapper = document.createElement("div");
              wrapper.className = "screen-share-tile";
              wrapper.dataset.participant = participant.identity;
              const label = document.createElement("span");
              label.className = "screen-share-label";
              label.textContent = `${participant.name || participant.identity}'s screen`;
              wrapper.appendChild(el);
              wrapper.appendChild(label);
              videoContainerRef.current.appendChild(wrapper);
            }
          },
        );
        room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
          if (!isCurrent()) return;
          track.detach().forEach((el) => el.remove());
          if (track.source === Track.Source.ScreenShare) {
            videoContainerRef.current?.querySelectorAll(".screen-share-tile").forEach((wrapper) => {
              if (!wrapper.querySelector("video, audio")) wrapper.remove();
            });
          }
        });
        room.on(RoomEvent.LocalTrackPublished, (pub) => {
          if (!isCurrent() || pub.source !== Track.Source.ScreenShare || !pub.track || !videoContainerRef.current) return;
          const el = pub.track.attach();
          el.muted = true;
          el.dataset.participant = room.localParticipant.identity;
          el.className = "screen-share-video";
          const wrapper = document.createElement("div");
          wrapper.className = "screen-share-tile";
          wrapper.dataset.participant = room.localParticipant.identity;
          const label = document.createElement("span");
          label.className = "screen-share-label";
          label.textContent = "Your screen";
          wrapper.appendChild(el);
          wrapper.appendChild(label);
          videoContainerRef.current.appendChild(wrapper);
          screenSharingRef.current = true;
          setScreenSharing(true);
        });
        room.on(RoomEvent.LocalTrackUnpublished, (pub) => {
          if (!isCurrent() || pub.source !== Track.Source.ScreenShare) return;
          pub.track?.detach().forEach((el) => el.remove());
          videoContainerRef.current
            ?.querySelectorAll(`.screen-share-tile[data-participant="${room.localParticipant.identity}"]`)
            .forEach((wrapper) => {
              if (!wrapper.querySelector("video, audio")) wrapper.remove();
            });
          screenSharingRef.current = false;
          setScreenSharing(false);
        });

        await room.connect(url, voiceToken);
        if (!isCurrent()) return; // superseded (e.g. leave clicked) while connecting
        gatewayRef.current?.sendVoiceJoin(channel.id);
        refreshParticipants(room);
        setConnecting(false);
        setMode(settings.mode);
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
              ? setupPushToTalk(room, settings, isCurrent, mutedRef, setMicEnabled, setPttActive, pttGateRef)
              : setupVoiceActivity(room, settings, isCurrent, mutedRef, setMicEnabled, setVadLevel);

          // A standing mute from the user bar (set before this join, or
          // carried over from a previous session) should still apply.
          if (mutedRef.current) {
            room.localParticipant
              .setMicrophoneEnabled(false)
              .then(() => isCurrent() && setMicEnabled(false))
              .catch(() => {});
          }
        } catch (micErr) {
          console.warn("Could not enable microphone:", micErr);
          if (isCurrent()) setMicEnabled(false);
        }
      } catch (err) {
        setError((err as Error).message);
        setConnecting(false);
      }
    },
    [baseUrl, token, gatewayRef],
  );

  const leave = useCallback(() => {
    automationCleanupRef.current?.();
    automationCleanupRef.current = null;
    roomRef.current?.disconnect();
    roomRef.current = null;
    gatewayRef.current?.sendVoiceLeave();
    setActiveChannel(null);
    setConnecting(false);
    setParticipants([]);
    setSpeakingUserIds(new Set());
    setMicEnabled(false);
    setPttActive(false);
    setVadLevel(0);
    setMode(null);
    screenSharingRef.current = false;
    setScreenSharing(false);
  }, [gatewayRef]);

  // getDisplayMedia rejects if the user cancels the browser's share picker
  // — that's not a real error, just leave screenSharing false and move on.
  const toggleScreenShare = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.localParticipant.setScreenShareEnabled(!screenSharingRef.current);
    } catch (err) {
      if ((err as Error).name !== "NotAllowedError") setError((err as Error).message);
    }
  }, []);

  const toggleMute = useCallback(async () => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    const room = roomRef.current;
    if (room && next) {
      try {
        await room.localParticipant.setMicrophoneEnabled(false);
        setMicEnabled(false);
      } catch (err) {
        setError((err as Error).message);
      }
    }
    // Unmuting doesn't force the mic back on — PTT/VAD automation re-gates
    // it on the next key press / voice-activity trigger, same as before.
  }, []);

  // Drives PTT from an on-screen hold button instead of the keyboard —
  // there's no keyboard on mobile. No-op if not currently in PTT mode
  // (pttGateRef is only set up by setupPushToTalk while mode === "ptt").
  const triggerPtt = useCallback((active: boolean) => {
    pttGateRef.current?.(active);
  }, []);

  const toggleDeafen = useCallback(async () => {
    const next = !deafenedRef.current;
    deafenedRef.current = next;
    setDeafened(next);
    applyDeafenToElements(next);

    if (next) {
      mutedBeforeDeafenRef.current = mutedRef.current;
      if (!mutedRef.current) await toggleMute();
    } else if (!mutedBeforeDeafenRef.current && mutedRef.current) {
      await toggleMute();
    }
  }, [toggleMute]);

  return {
    activeChannel,
    connected: activeChannel !== null,
    connecting,
    participants,
    speakingUserIds,
    micEnabled,
    muted,
    deafened,
    pttActive,
    triggerPtt,
    vadLevel,
    mode,
    error,
    screenSharing,
    audioContainerRef,
    videoContainerRef,
    join,
    leave,
    toggleMute,
    toggleDeafen,
    toggleScreenShare,
  };
}

export type VoiceSession = ReturnType<typeof useVoiceSession>;
