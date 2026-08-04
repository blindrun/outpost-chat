import type { PluginListenerHandle } from "@capacitor/core";

export interface VoiceParticipantData {
  identity: string;
  name: string;
  isLocal: boolean;
}

// iOS-only native bridge to LiveKit's Swift SDK, used in place of routing
// voice through WKWebView's WebRTC -- see the iOS voice plan's Context
// section for why (WKWebView suspends audio ~27s after backgrounding/screen
// lock, an OS-level limitation this plugin exists specifically to avoid).
// web/src/voice/NativeLiveKitEngine.ts adapts this to the same VoiceEngine
// interface web/src/voice/WebLiveKitEngine.ts implements, so
// useVoiceSession.ts's shared logic never needs to know which is active.
export interface LiveKitVoicePlugin {
  connect(options: { url: string; token: string }): Promise<void>;
  disconnect(): Promise<void>;
  setMicrophoneEnabled(options: { enabled: boolean }): Promise<void>;
  // No confirmed 1:1 native audio-pipeline equivalent for "keep receiving
  // but silence local playback" -- see LiveKitVoice.swift's implementation
  // note and the iOS plan's open question #2.
  setRemoteAudioMuted(options: { muted: boolean }): Promise<void>;
  localIdentity(): Promise<{ identity: string }>;

  addListener(
    eventName: "participantsChanged",
    listenerFunc: (data: { participants: VoiceParticipantData[] }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "speakingChanged",
    listenerFunc: (data: { identities: string[] }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(eventName: "disconnected", listenerFunc: () => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
