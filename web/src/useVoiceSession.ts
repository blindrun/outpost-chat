import { MutableRefObject, useCallback, useRef, useState } from "react";
import { Channel, Gateway, getVoiceToken } from "./api";
import { AudioSettings, audioProcessingOf, loadAudioSettings } from "./audioSettings";
import { createAdaptiveGate } from "./vadAuto";
import { createVoiceEngine } from "./voice/createVoiceEngine";
import { ParticipantInfo, VoiceEngine } from "./voice/VoiceEngine";
import { playVoiceJoinSound, playVoiceLeaveSound } from "./voiceSounds";

// Hangover keeps the mic briefly open after level drops below threshold so
// VAD doesn't clip the tail end of words.
const VAD_HANGOVER_MS = 300;
const VAD_POLL_MS = 50;

// The same idea for push-to-talk, which had none: the mic cut the instant the
// key came up, so releasing on the last syllable clipped it, and anyone who
// let go a shade early got chopped off mid-word. Holding the gate open a
// beat after release fixes both. Longer than VAD's hangover because a key
// release is a deliberate "I'm done" rather than a lull the speaker may be
// about to fill, so there's no risk of it latching open on background noise —
// the only cost is transmitting a little room tone.
const PTT_RELEASE_HANGOVER_MS = 400;

export type { ParticipantInfo };

// Gates transmission on the bound key while connected; leaves the published
// track alone otherwise (mic starts disabled, matching "hold to talk").
// `gateRef` is also handed the same gate function so a touch-only client
// (no keyboard to bind) can drive it from an on-screen hold button instead —
// see `triggerPtt` in the hook below.
function setupPushToTalk(
  engine: VoiceEngine,
  settings: AudioSettings,
  isCurrent: () => boolean,
  mutedRef: { current: boolean },
  setMicEnabled: (v: boolean) => void,
  setPttActive: (v: boolean) => void,
  gateRef: MutableRefObject<((active: boolean) => void) | null>,
): () => void {
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;

  function applyGate(active: boolean) {
    setPttActive(active);
    if (mutedRef.current) return;
    engine
      .setMicrophoneEnabled(active)
      .then(() => isCurrent() && setMicEnabled(active))
      .catch((err) => console.warn("PTT mic toggle failed:", err));
  }

  // Press opens immediately; release closes after the hangover. Re-pressing
  // inside that window cancels the pending close instead of stacking a second
  // one, so rapid tapping (or a key repeat quirk) can't leave a timer running
  // that closes the mic mid-sentence a moment later.
  function gate(active: boolean) {
    if (releaseTimer) {
      clearTimeout(releaseTimer);
      releaseTimer = null;
    }
    if (active) {
      applyGate(true);
      return;
    }
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      applyGate(false);
    }, PTT_RELEASE_HANGOVER_MS);
  }

  gateRef.current = gate;

  // Start gated closed — join() enables the mic before this runs (so a
  // permission prompt/track exists to gate at all), but "hold to talk"
  // means silent until the key is actually held, same as VAD starts closed
  // until the level first crosses the threshold.
  applyGate(false);

  if (!settings.pttKey) {
    return () => {
      if (releaseTimer) clearTimeout(releaseTimer);
      gateRef.current = null;
    };
  }
  const pttKey = settings.pttKey;

  function onKeyDown(e: KeyboardEvent) {
    if (e.code !== pttKey || e.repeat || !isCurrent()) return;
    gate(true);
  }
  function onKeyUp(e: KeyboardEvent) {
    if (e.code !== pttKey || !isCurrent()) return;
    gate(false);
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    // Without this, leaving a voice channel mid-hangover fires applyGate on a
    // torn-down engine a few hundred ms later.
    if (releaseTimer) clearTimeout(releaseTimer);
    gateRef.current = null;
  };
}

// Monitors mic level via a clone of the already-published track (independent
// enabled/lifecycle from the original, so gating the original via LiveKit's
// mute doesn't blind the analyser) and gates transmission by threshold. Only
// ever invoked when engine.capabilities.vad is true (web engine only — see
// VoiceEngine.ts), since VAD is meaningless once the mic no longer flows
// through a WebView.
function setupVoiceActivity(
  engine: VoiceEngine,
  settings: AudioSettings,
  isCurrent: () => boolean,
  mutedRef: { current: boolean },
  setMicEnabled: (v: boolean) => void,
  setVadLevel: (v: number) => void,
): () => void {
  const liveTrack = engine.getMicrophoneTrackForVad();
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
    engine
      .setMicrophoneEnabled(open)
      .then(() => isCurrent() && setMicEnabled(open))
      .catch((err) => console.warn("VAD mic toggle failed:", err));
  }

  // Start gated closed until the level first crosses the threshold.
  engine
    .setMicrophoneEnabled(false)
    .then(() => isCurrent() && setMicEnabled(false))
    .catch(() => {});

  // Auto mode tracks the room's noise floor instead of using the stored
  // threshold; see vadAuto.ts for why that's the default now.
  const adaptive = settings.vadAuto ? createAdaptiveGate() : null;

  const interval = setInterval(() => {
    analyser.getByteTimeDomainData(data);
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sumSquares += v * v;
    }
    const level = Math.min(100, Math.sqrt(sumSquares / data.length) * 300);
    if (isCurrent()) setVadLevel(level);

    // The hangover below is still worth having in auto mode: hysteresis stops
    // the gate chattering around the threshold, but only a time-based tail
    // keeps a natural pause mid-sentence from cutting the next word off.
    const speaking = adaptive ? adaptive.update(level) : level >= settings.vadThreshold;

    if (speaking) {
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

// Owns the voice engine for the whole app (not per-channel-view), so voice
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
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraSupported, setCameraSupported] = useState(true);
  // Total video tiles on screen -- cameras and screen shares, mine and
  // everyone else's. Drives whether the app shows a video stage at all, so
  // it has to count every kind of feed rather than just my own.
  const [videoFeedCount, setVideoFeedCount] = useState(0);
  // false only for engines that can't do it (the native iOS engine, once it
  // exists) — VoicePanel hides the Share Screen button when this is false
  // rather than showing a control that can never work.
  const [screenShareSupported, setScreenShareSupported] = useState(true);

  const engineRef = useRef<VoiceEngine | null>(null);
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
  const cameraOnRef = useRef(false);
  // Read by toggleCamera, which has no access to join()'s local `settings`
  // and must not re-read localStorage on every click — the device in use is
  // whatever was selected when this session started.
  const videoDeviceIdRef = useRef<string | undefined>(undefined);

  const join = useCallback(
    async (channel: Channel) => {
      setError(null);
      setConnecting(true);
      try {
        const { token: voiceToken, url } = await getVoiceToken(baseUrl, token, channel.id);

        automationCleanupRef.current?.();
        automationCleanupRef.current = null;
        engineRef.current?.disconnect();

        const settings = loadAudioSettings();
        const engine = createVoiceEngine(
          audioContainerRef.current!,
          videoContainerRef.current!,
          settings.outputDeviceId ?? undefined,
          audioProcessingOf(settings),
        );
        engineRef.current = engine;
        setActiveChannel(channel);
        setScreenShareSupported(engine.capabilities.screenShare);
        setCameraSupported(engine.capabilities.camera);
        videoDeviceIdRef.current = settings.videoDeviceId ?? undefined;
        // Video never carries across a join. Discord doesn't either, and
        // the alternative — a camera that switches itself back on when you
        // enter a channel — is the kind of surprise nobody forgives.
        cameraOnRef.current = false;
        setCameraOn(false);
        // Every join path funnels through here — a manual sidebar click,
        // an AFK auto-move, a moderator's voice-kick landing on a
        // different channel (not this app yet) — so this is the one place
        // that needs to play it, rather than duplicating the call at each
        // trigger site. Real user feedback: joining/leaving voice produced
        // no sound at all for the person doing it (only the "someone else
        // joined/left the channel you're in" ambient notification did).
        playVoiceJoinSound();

        // Seed the engine with whatever deafen state already persisted
        // across a previous leave/join — TrackSubscribed on a fresh engine
        // otherwise starts every newly attached remote audio element
        // un-muted regardless of a standing deafen from before this join.
        engine.setRemoteAudioMuted(deafenedRef.current);

        // Every listener guards against `engineRef.current !== engine` — if
        // this engine has since been superseded (a new join, or a leave
        // that raced with an in-flight event from this one), its
        // late-arriving events must not touch state that now belongs to a
        // different engine/no engine.
        const isCurrent = () => engineRef.current === engine;

        engine.on("participantsChanged", (list) => {
          if (isCurrent()) setParticipants(list);
        });
        engine.on("speakingChanged", (ids) => {
          if (isCurrent()) setSpeakingUserIds(ids);
        });
        engine.on("disconnected", () => {
          if (!isCurrent()) return;
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
          cameraOnRef.current = false;
          setCameraOn(false);
          setVideoFeedCount(0);
        });
        engine.on("localScreenShareStarted", () => {
          if (!isCurrent()) return;
          screenSharingRef.current = true;
          setScreenSharing(true);
        });
        engine.on("localScreenShareStopped", () => {
          if (!isCurrent()) return;
          screenSharingRef.current = false;
          setScreenSharing(false);
        });
        engine.on("videoFeedsChanged", (count) => {
          if (isCurrent()) setVideoFeedCount(count);
        });
        engine.on("localCameraStarted", () => {
          if (!isCurrent()) return;
          cameraOnRef.current = true;
          setCameraOn(true);
        });
        engine.on("localCameraStopped", () => {
          if (!isCurrent()) return;
          cameraOnRef.current = false;
          setCameraOn(false);
        });

        await engine.connect(url, voiceToken);
        if (!isCurrent()) return; // superseded (e.g. leave clicked) while connecting
        gatewayRef.current?.sendVoiceJoin(channel.id);
        setConnecting(false);
        // VAD is meaningless on an engine that can't expose a raw mic track
        // (the native iOS engine, once it exists) — force push-to-talk
        // regardless of the user's stored preference in that case.
        const effectiveMode = engine.capabilities.vad ? settings.mode : "ptt";
        setMode(effectiveMode);
        setPttActive(false);
        setVadLevel(0);

        // Mic may not be available (e.g. no input device in a test/CI browser) —
        // that shouldn't block joining the voice channel to see who else is in it.
        try {
          await engine.setMicrophoneEnabled(true, settings.inputDeviceId ?? undefined);
          if (!isCurrent()) return;
          setMicEnabled(true);

          automationCleanupRef.current =
            effectiveMode === "ptt"
              ? setupPushToTalk(engine, settings, isCurrent, mutedRef, setMicEnabled, setPttActive, pttGateRef)
              : setupVoiceActivity(engine, settings, isCurrent, mutedRef, setMicEnabled, setVadLevel);

          // A standing mute from the user bar (set before this join, or
          // carried over from a previous session) should still apply.
          if (mutedRef.current) {
            engine
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
    engineRef.current?.disconnect();
    engineRef.current = null;
    gatewayRef.current?.sendVoiceLeave();
    // Only fires here, not from join()'s own internal disconnect-then-
    // reconnect when switching channels directly — that's a single join,
    // not a leave-then-join, so it should only ever sound like one action.
    if (activeChannel) playVoiceLeaveSound();
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
    cameraOnRef.current = false;
    setCameraOn(false);
    setVideoFeedCount(0);
  }, [gatewayRef, activeChannel]);

  const toggleScreenShare = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      await engine.setScreenShareEnabled(!screenSharingRef.current);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  // cameraOn is set by the engine's publish/unpublish events, not here, so
  // the button follows the track rather than the click — the two diverge
  // when the camera is refused or yanked out mid-call.
  const toggleCamera = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    setError(null);
    try {
      await engine.setCameraEnabled(!cameraOnRef.current, videoDeviceIdRef.current);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const toggleMute = useCallback(async () => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    const engine = engineRef.current;
    if (engine && next) {
      try {
        await engine.setMicrophoneEnabled(false);
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
    engineRef.current?.setRemoteAudioMuted(next);

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
    screenShareSupported,
    cameraOn,
    cameraSupported,
    videoFeedCount,
    audioContainerRef,
    videoContainerRef,
    join,
    leave,
    toggleMute,
    toggleDeafen,
    toggleScreenShare,
    toggleCamera,
  };
}

export type VoiceSession = ReturnType<typeof useVoiceSession>;
