// Abstracts "the thing that actually talks to LiveKit" behind one interface,
// so useVoiceSession.ts's shared logic (PTT/VAD gating, mute/deafen
// bookkeeping, the isCurrent() staleness guard) works identically regardless
// of whether voice is routed through the browser's WebRTC (WebLiveKitEngine,
// used by web/Android/desktop/Docker) or a native plugin bridging to
// LiveKit's Swift SDK (NativeLiveKitEngine, iOS only -- see the iOS voice
// plan). Only one implementation exists as of this file's introduction
// (WebLiveKitEngine, extracted from the previously-monolithic
// useVoiceSession.ts with no behavior change); NativeLiveKitEngine is added
// in a follow-up change.

export interface ParticipantInfo {
  identity: string;
  name: string;
  isLocal: boolean;
}

// Only ScreenShare tracks are reported through trackSubscribed/Unsubscribed
// today -- remote audio tracks are handled by the engine internally (it
// attaches/detaches its own <audio> elements), since nothing outside the
// engine needs to touch them directly (confirmed: VoicePanel.tsx and App.tsx
// never read audioContainerRef's contents, only render it as a mount point).
export interface RemoteVideoTrackDetail {
  participantIdentity: string;
  participantName: string;
  element: HTMLVideoElement;
}

export interface VoiceEngineEvents {
  participantsChanged: (participants: ParticipantInfo[]) => void;
  speakingChanged: (identities: Set<string>) => void;
  // Fires when the engine itself decides the room is gone (kicked, banned,
  // server closed the room, network failure after retries exhausted) --
  // distinct from the caller-initiated disconnect() below.
  disconnected: () => void;
  screenShareTrackSubscribed: (detail: RemoteVideoTrackDetail) => void;
  screenShareTrackUnsubscribed: (participantIdentity: string) => void;
  localScreenShareStarted: (element: HTMLVideoElement) => void;
  localScreenShareStopped: () => void;
  // Camera equivalents. Driven by LiveKit's own publish/unpublish events
  // rather than set optimistically when the button is clicked, so the
  // button reflects what is actually being sent -- a camera that's
  // unplugged mid-call ends the track without anyone clicking anything.
  localCameraStarted: () => void;
  localCameraStopped: () => void;
}

export interface VoiceEngine {
  readonly capabilities: {
    // Screen share needs ReplayKit + a Broadcast Upload Extension on iOS --
    // a distinct, much larger feature, explicitly out of scope for the
    // native engine's first version. false on iOS, true everywhere else.
    screenShare: boolean;
    // Voice-activity detection needs raw MediaStreamTrack + Web Audio
    // AnalyserNode access, meaningless once the mic no longer flows through
    // a WebView. false on iOS (forces push-to-talk), true everywhere else.
    vad: boolean;
    // Whether the user's noise-suppression/echo-cancellation/auto-gain
    // choices reach the capture at all. They're getUserMedia constraints,
    // so they mean nothing on iOS, where the mic is opened by the native
    // Swift SDK and never touches the WebView -- the settings screen hides
    // the controls rather than showing three switches that do nothing.
    audioProcessing: boolean;
    // Camera publishing. Nothing platform-level blocks video on iOS the way
    // ReplayKit does screen share -- but the native plugin's bridge is
    // audio-only, so it can't publish a camera track until that plugin
    // grows one. false there, true everywhere else.
    camera: boolean;
  };

  connect(url: string, token: string): Promise<void>;
  disconnect(): void;

  setMicrophoneEnabled(enabled: boolean, deviceId?: string): Promise<void>;
  setCameraEnabled(enabled: boolean, deviceId?: string): Promise<void>;
  // Deafening has no 1:1 native audio-pipeline equivalent (the web engine
  // mutes each attached <audio> element directly) -- each implementation
  // handles this however makes sense for its own transport.
  setRemoteAudioMuted(muted: boolean): void;
  setScreenShareEnabled(enabled: boolean): Promise<void>;

  localIdentity(): string;

  // Only meaningful when capabilities.vad is true -- returns the local
  // microphone's raw MediaStreamTrack for the caller to run VAD analysis
  // against. Returns null (never called) when capabilities.vad is false.
  getMicrophoneTrackForVad(): MediaStreamTrack | null;

  on<K extends keyof VoiceEngineEvents>(event: K, cb: VoiceEngineEvents[K]): void;
  off<K extends keyof VoiceEngineEvents>(event: K, cb: VoiceEngineEvents[K]): void;
}
