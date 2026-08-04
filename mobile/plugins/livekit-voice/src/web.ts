import { WebPlugin } from "@capacitor/core";

import type { LiveKitVoicePlugin } from "./definitions";

// Never actually invoked in practice -- NativeLiveKitEngine (web/src/voice/)
// only instantiates this plugin when Capacitor.getPlatform() === "ios",
// which never returns "web". This fallback exists only because
// registerPlugin() requires one.
export class LiveKitVoiceWeb extends WebPlugin implements LiveKitVoicePlugin {
  async connect(): Promise<void> {
    throw this.unimplemented("LiveKitVoice is only available on iOS.");
  }

  async disconnect(): Promise<void> {
    throw this.unimplemented("LiveKitVoice is only available on iOS.");
  }

  async setMicrophoneEnabled(): Promise<void> {
    throw this.unimplemented("LiveKitVoice is only available on iOS.");
  }

  async setRemoteAudioMuted(): Promise<void> {
    throw this.unimplemented("LiveKitVoice is only available on iOS.");
  }

  async localIdentity(): Promise<{ identity: string }> {
    throw this.unimplemented("LiveKitVoice is only available on iOS.");
  }
}
