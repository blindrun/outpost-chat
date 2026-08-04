import { Capacitor } from "@capacitor/core";
import { NativeLiveKitEngine } from "./NativeLiveKitEngine";
import { VoiceEngine } from "./VoiceEngine";
import { WebLiveKitEngine } from "./WebLiveKitEngine";

// The only place that picks between transports -- Android, browser,
// Electron, and Docker all get WebLiveKitEngine exactly as before (this
// branch is additive and inert for every existing build target, since
// Capacitor.getPlatform() only ever returns "ios" inside the actual iOS
// native shell). See the iOS voice plan's Architecture section.
export function createVoiceEngine(
  audioContainer: HTMLDivElement,
  videoContainer: HTMLDivElement,
  outputDeviceId: string | undefined,
): VoiceEngine {
  if (Capacitor.getPlatform() === "ios") {
    return new NativeLiveKitEngine();
  }
  return new WebLiveKitEngine(audioContainer, videoContainer, outputDeviceId);
}
