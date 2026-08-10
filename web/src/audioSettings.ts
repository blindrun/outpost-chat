export type VoiceMode = "ptt" | "vad";

export interface AudioSettings {
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  mode: VoiceMode;
  pttKey: string | null;
  vadThreshold: number;
  // When true (the default), vadThreshold is ignored and the gate tracks the
  // room's own noise floor live — see setupVoiceActivity. The manual slider
  // was the single most confusing control in the app: it's shown as a bare
  // number with no correct value, a mic that's too quiet for it looks broken
  // ("nobody can hear me") and one that's too loud transmits every keystroke,
  // and the right setting changes with the room, the headset and the time of
  // day. Automatic is what most people should never have to think about;
  // the slider stays for anyone who wants to pin it.
  vadAuto: boolean;
}

const STORAGE_KEY = "outpost-audio-settings";

const DEFAULT_SETTINGS: AudioSettings = {
  inputDeviceId: null,
  outputDeviceId: null,
  mode: "vad",
  pttKey: null,
  vadThreshold: 15,
  vadAuto: true,
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
