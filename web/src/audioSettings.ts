export type VoiceMode = "ptt" | "vad";

export interface AudioSettings {
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  mode: VoiceMode;
  pttKey: string | null;
  vadThreshold: number;
}

const STORAGE_KEY = "outpost-audio-settings";

const DEFAULT_SETTINGS: AudioSettings = {
  inputDeviceId: null,
  outputDeviceId: null,
  mode: "vad",
  pttKey: null,
  vadThreshold: 15,
};

// Deliberately not per-instance — this is a hardware preference tied to the
// user's machine, not any particular self-hosted community.
export function loadAudioSettings(): AudioSettings {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveAudioSettings(settings: AudioSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
