// iOS-only voice transport: bridges to LiveKit's Swift SDK via a Capacitor
// custom plugin (mobile/plugins/livekit-voice/ios), instead of routing
// through WKWebView's WebRTC -- see the iOS voice plan's Context section
// for why (WKWebView suspends audio ~27s after backgrounding/screen lock,
// an OS-level limitation this plugin exists specifically to avoid).
//
// The plugin registration and its TS contract live here, not in a
// separately-built npm package -- mobile/plugins/livekit-voice has no
// JS/TS side at all (see that package's README for why: it would give
// every platform that builds web/src, not just iOS, a build-time
// dependency on this package's compiled output). `registerPlugin` just
// needs the string "LiveKitVoice" to match `jsName` in
// LiveKitVoicePlugin.swift -- where it's called from doesn't matter to
// Capacitor's native bridge.
//
// Screen share and VAD are unsupported here (see VoiceEngine.ts's
// capabilities doc comments) -- useVoiceSession.ts already gates both on
// capabilities before ever calling into this engine for them.
import { registerPlugin } from "@capacitor/core";
import { ParticipantInfo, VoiceEngine, VoiceEngineEvents } from "./VoiceEngine";

interface VoiceParticipantData {
  identity: string;
  name: string;
  isLocal: boolean;
}

interface LiveKitVoicePlugin {
  connect(options: { url: string; token: string }): Promise<void>;
  disconnect(): Promise<void>;
  setMicrophoneEnabled(options: { enabled: boolean }): Promise<void>;
  setRemoteAudioMuted(options: { muted: boolean }): Promise<void>;
  localIdentity(): Promise<{ identity: string }>;
  addListener(
    eventName: "participantsChanged",
    listenerFunc: (data: { participants: VoiceParticipantData[] }) => void,
  ): Promise<{ remove(): Promise<void> }>;
  addListener(
    eventName: "speakingChanged",
    listenerFunc: (data: { identities: string[] }) => void,
  ): Promise<{ remove(): Promise<void> }>;
  addListener(eventName: "disconnected", listenerFunc: () => void): Promise<{ remove(): Promise<void> }>;
}

const LiveKitVoice = registerPlugin<LiveKitVoicePlugin>("LiveKitVoice");

function toInfo(p: VoiceParticipantData): ParticipantInfo {
  return { identity: p.identity, name: p.name, isLocal: p.isLocal };
}

type Listener<K extends keyof VoiceEngineEvents> = VoiceEngineEvents[K];

export class NativeLiveKitEngine implements VoiceEngine {
  readonly capabilities = { screenShare: false, vad: false };

  // Internally untyped for the same reason as WebLiveKitEngine's listeners
  // map -- see that file's comment.
  private listeners: Record<string, Set<(...args: never[]) => void>> = {};
  private pluginListenerHandles: { remove(): Promise<void> }[] = [];

  constructor() {
    LiveKitVoice.addListener("participantsChanged", ({ participants }) => {
      this.emit("participantsChanged", participants.map(toInfo));
    }).then((handle) => this.pluginListenerHandles.push(handle));

    LiveKitVoice.addListener("speakingChanged", ({ identities }) => {
      this.emit("speakingChanged", new Set(identities));
    }).then((handle) => this.pluginListenerHandles.push(handle));

    LiveKitVoice.addListener("disconnected", () => {
      this.emit("disconnected");
    }).then((handle) => this.pluginListenerHandles.push(handle));
  }

  on<K extends keyof VoiceEngineEvents>(event: K, cb: Listener<K>) {
    (this.listeners[event] ??= new Set()).add(cb as (...args: never[]) => void);
  }

  off<K extends keyof VoiceEngineEvents>(event: K, cb: Listener<K>) {
    this.listeners[event]?.delete(cb as (...args: never[]) => void);
  }

  private emit<K extends keyof VoiceEngineEvents>(event: K, ...args: Parameters<Listener<K>>) {
    this.listeners[event]?.forEach((cb) => cb(...(args as never[])));
  }

  async connect(url: string, token: string): Promise<void> {
    await LiveKitVoice.connect({ url, token });
  }

  disconnect() {
    LiveKitVoice.disconnect().catch((err) => console.warn("LiveKitVoice.disconnect failed:", err));
    this.pluginListenerHandles.forEach((h) => h.remove());
    this.pluginListenerHandles = [];
  }

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    // deviceId is intentionally ignored -- input device selection isn't
    // exposed by the native plugin (there's no equivalent User Settings ->
    // Voice input-device picker concept on iOS's single built-in mic /
    // whatever's connected via the system's own audio route).
    await LiveKitVoice.setMicrophoneEnabled({ enabled });
  }

  setRemoteAudioMuted(muted: boolean) {
    LiveKitVoice.setRemoteAudioMuted({ muted }).catch((err) =>
      console.warn("LiveKitVoice.setRemoteAudioMuted failed:", err),
    );
  }

  async setScreenShareEnabled(): Promise<void> {
    throw new Error("Screen share is not supported on iOS yet.");
  }

  localIdentity(): string {
    // Synchronous by interface contract (matches WebLiveKitEngine, which
    // reads this off an already-connected Room instance) -- the native
    // plugin's localIdentity() is async, so this can't proxy it directly.
    // Not currently read anywhere that needs it before participantsChanged
    // has already fired at least once (which carries the local identity
    // via ParticipantInfo.isLocal), so an empty fallback is safe today: no
    // call site depends on this returning correctly before that point.
    return "";
  }

  getMicrophoneTrackForVad(): MediaStreamTrack | null {
    return null;
  }
}
