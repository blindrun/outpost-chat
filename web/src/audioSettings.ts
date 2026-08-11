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
  // Browser-side capture processing. All three default to on, which is
  // exactly what the app already got implicitly -- livekit-client's own
  // audioDefaults enable noise suppression, echo cancellation, auto gain
  // and voice isolation, and nothing here ever overrode them. So these
  // toggles change nothing until someone turns one off; they exist because
  // the defaults are wrong for a real minority: noise suppression mangles
  // anyone playing an instrument or sharing music, and auto gain rides a
  // quiet room's noise floor up between sentences.
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  // The camera to publish from. Lives here with the mic and speaker
  // because this store is "which hardware does voice use on this machine",
  // even though the type is still named for the audio it started as.
  videoDeviceId: string | null;
}

const STORAGE_KEY = "outpost-audio-settings";

const DEFAULT_SETTINGS: AudioSettings = {
  inputDeviceId: null,
  outputDeviceId: null,
  mode: "vad",
  pttKey: null,
  vadThreshold: 15,
  vadAuto: true,
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  videoDeviceId: null,
};

// The subset the capture layer actually consumes, so engines and the
// settings meter can take one argument instead of the whole settings blob.
export type AudioProcessing = Pick<
  AudioSettings,
  "noiseSuppression" | "echoCancellation" | "autoGainControl"
>;

export function audioProcessingOf(settings: AudioSettings): AudioProcessing {
  return {
    noiseSuppression: settings.noiseSuppression,
    echoCancellation: settings.echoCancellation,
    autoGainControl: settings.autoGainControl,
  };
}

// Its own type rather than MediaTrackConstraints because voiceIsolation
// isn't in TypeScript's DOM lib yet; it is a real constraint browsers
// honour, and it's in LiveKit's AudioCaptureOptions, which this satisfies
// structurally.
export interface CaptureConstraints {
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  voiceIsolation: boolean;
}

// Constraints for a getUserMedia/LiveKit audio capture.
//
// voiceIsolation follows the noise-suppression toggle rather than getting a
// control of its own: it's a stronger, platform-provided version of the same
// idea (the browser hands off to the OS's own voice processing), so leaving
// it on while "Noise Suppression" is off would keep aggressively filtering
// the audio of someone who just asked for it not to be. LiveKit sets it by
// default, so it has to be named explicitly here to be turned off at all.
export function toCaptureConstraints(p: AudioProcessing): CaptureConstraints {
  return {
    noiseSuppression: p.noiseSuppression,
    echoCancellation: p.echoCancellation,
    autoGainControl: p.autoGainControl,
    voiceIsolation: p.noiseSuppression,
  };
}

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
