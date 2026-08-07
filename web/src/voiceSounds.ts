// Short synthesized blips for "someone joined/left the voice channel I'm
// in" — a plain WebAudio oscillator rather than a bundled audio asset, so
// this doesn't add a binary file (and its licensing) to the repo for two
// ~150ms tones. One AudioContext is created lazily and reused across calls
// (creating a fresh one per play is the classic mobile-Safari trap where
// rapid-fire contexts silently stop producing sound).
let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined" || !("AudioContext" in window || "webkitAudioContext" in window)) return null;
  if (!ctx) {
    const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AudioContextCtor();
  }
  return ctx;
}

function playTone(startFreq: number, endFreq: number) {
  const audioCtx = getContext();
  if (!audioCtx) return;
  const oscillator = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(startFreq, audioCtx.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(endFreq, audioCtx.currentTime + 0.15);
  gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
  oscillator.connect(gain);
  gain.connect(audioCtx.destination);
  oscillator.start();
  oscillator.stop(audioCtx.currentTime + 0.15);
}

// Rising pitch for a join, falling for a leave — same up/down convention
// Discord's own default sounds use.
export function playVoiceJoinSound() {
  playTone(440, 660);
}

export function playVoiceLeaveSound() {
  playTone(660, 440);
}
