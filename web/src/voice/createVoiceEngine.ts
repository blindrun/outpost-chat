import { Capacitor } from "@capacitor/core";
import { AudioProcessing } from "../audioSettings";
import { NATIVE_ENGINE_CAPABILITIES, NativeLiveKitEngine } from "./NativeLiveKitEngine";
import { VoiceEngine } from "./VoiceEngine";
import { WEB_ENGINE_CAPABILITIES, WebLiveKitEngine } from "./WebLiveKitEngine";

// What the transport this platform will use supports, answerable before
// anyone joins a channel -- the voice settings screen needs it to decide
// which controls are real here, and it has no engine to ask.
export function voiceCapabilities(): VoiceEngine["capabilities"] {
  return Capacitor.getPlatform() === "ios" ? NATIVE_ENGINE_CAPABILITIES : WEB_ENGINE_CAPABILITIES;
}

// The only place that picks between transports -- Android, browser,
// Electron, and Docker all get WebLiveKitEngine exactly as before (this
// branch is additive and inert for every existing build target, since
// Capacitor.getPlatform() only ever returns "ios" inside the actual iOS
// native shell). See the iOS voice plan's Architecture section.
export function createVoiceEngine(
  audioContainer: HTMLDivElement,
  videoContainer: HTMLDivElement,
  outputDeviceId: string | undefined,
  audioProcessing: AudioProcessing,
): VoiceEngine {
  if (Capacitor.getPlatform() === "ios") {
    return new NativeLiveKitEngine();
  }
  return new WebLiveKitEngine(audioContainer, videoContainer, outputDeviceId, audioProcessing);
}
