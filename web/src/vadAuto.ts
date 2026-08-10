// Adaptive voice-activity gate — the automatic replacement for the manual
// "sensitivity threshold" slider.
//
// The problem with a fixed threshold is that the correct value isn't a
// property of the user, it's a property of the room: a quiet office, a desk
// fan, a mechanical keyboard, a different headset, or someone's kids in the
// background all move it, and none of them announce themselves. Set it too
// low and you transmit every keystroke; too high and you're the person nobody
// can hear. Either way the failure is invisible to the person who has to fix
// it, because you can't hear your own gate.
//
// So instead of asking, this tracks the room's noise floor continuously and
// puts the gate a proportional distance above it. Two properties do most of
// the work:
//
//   - The floor falls fast and rises slowly. Speech is loud and brief; room
//     noise is quiet and constant. A fast fall means walking into a quieter
//     room re-tunes almost immediately, while a slow rise means a burst of
//     speech barely moves the floor even if it lands while the gate is shut.
//   - While the gate is OPEN the floor only rises if the input is *steady*.
//     This is the part that isn't obvious, and a simulation caught it: the
//     floor starts at zero, so in a room with any real background noise the
//     gate opens on the very first sample — and if the floor could only ever
//     rise while closed, it would never learn the room and would sit open
//     forever, transmitting the fan. Letting it rise unconditionally instead
//     fails the opposite way, ratcheting the threshold up underneath a long
//     monologue until it cuts the speaker off mid-sentence.
//
// Steadiness is what separates those two cases, because level alone can't:
// constant noise barely moves sample to sample, while speech swings hard
// between syllables and pauses. So the floor is allowed to climb through a
// stuck-open gate only when the recent window is flat enough to be noise.
//
// Plus hysteresis: it takes more level to open the gate than to hold it open,
// so someone speaking near the threshold doesn't stutter on and off.
//
// Behaviour these constants were tuned against, by simulating level traces at
// the real 50ms poll rate. Re-check these if you touch them:
//   - quiet room, speech bursts: opens for all of the speech, closes cleanly
//   - steady fan at 18: settles closed, and speech over it still opens
//   - speaking from the very first sample: never gated out
//   - 45s unbroken monologue: never closes underneath the speaker
//   - moving somewhere quieter: threshold drops back within a second
//   - speech fading slowly through the threshold: one clean close, no chatter
//
// The one visible cost is at join time: because the floor starts at zero the
// gate is briefly open, so a noisy room transmits its own background for a
// few seconds before settling (measured: ~0.1s in a quiet room, ~5.5s on a
// light hum, ~7-8s in a genuinely loud one). That's the deliberate direction
// to fail in — starting closed instead would mean the first thing you say
// after joining gets eaten, which is far harder to notice and diagnose.

// Level units match the meter elsewhere: RMS scaled to roughly 0-100.
const FALL_COEFFICIENT = 0.4; // toward a quieter floor — fast
const RISE_COEFFICIENT = 0.02; // toward a louder floor, gate closed — slow
// Slower still when climbing through an open gate, since that only happens
// when we've decided the input is steady noise and we're escaping a
// stuck-open state. Roughly a 6-second climb, so a genuinely noisy room
// settles within a few seconds of joining rather than a minute.
const RISE_COEFFICIENT_OPEN = 0.008;
// Peak-to-trough spread over the recent window, below which the input is
// treated as steady noise rather than speech. Normal speech swings far wider
// than this between syllables and pauses; a fan or a hiss barely moves.
const STEADY_SPREAD = 7;
const STEADY_WINDOW_SAMPLES = 40; // ~2s at the 50ms poll interval
// ~5dB above the noise floor. Ratio rather than a fixed margin because the
// units are linear RMS, so the useful headroom scales with the floor.
const OPEN_RATIO = 1.8;
const OPEN_OFFSET = 4;
// Below the open threshold, so speech trailing off doesn't chatter the gate.
const CLOSE_RATIO = 1.4;
const CLOSE_OFFSET = 2;
// A floor this low means a genuinely silent input (or a muted/dead mic).
// Without a minimum, the threshold would collapse toward zero and the gate
// would open on nothing at all.
const MIN_OPEN_THRESHOLD = 4;

export interface AdaptiveGate {
  /** Feed the current level; returns whether the gate should be open. */
  update(level: number): boolean;
  /** Where the open threshold currently sits, for the meter marker. */
  readonly threshold: number;
}

export function createAdaptiveGate(): AdaptiveGate {
  // Starting at zero deliberately biases the first moments toward
  // transmitting: the threshold begins at its floor and tightens as the room
  // is learned. If this seeded from the first sample instead, joining a call
  // and immediately saying "hi" would teach it that speech is the noise floor
  // and gate the speaker out. Erring toward "open" is the recoverable
  // failure; erring toward "closed" is the one nobody can diagnose.
  let noiseFloor = 0;
  let open = false;
  // Ring buffer of recent levels, for the steadiness test above.
  const recent: number[] = [];

  function isSteady(): boolean {
    if (recent.length < STEADY_WINDOW_SAMPLES) return false;
    let min = Infinity;
    let max = -Infinity;
    for (const v of recent) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return max - min < STEADY_SPREAD;
  }

  return {
    get threshold() {
      return Math.max(MIN_OPEN_THRESHOLD, noiseFloor * OPEN_RATIO + OPEN_OFFSET);
    },
    update(level: number) {
      recent.push(level);
      if (recent.length > STEADY_WINDOW_SAMPLES) recent.shift();

      if (level < noiseFloor) {
        noiseFloor += (level - noiseFloor) * FALL_COEFFICIENT;
      } else if (!open) {
        noiseFloor += (level - noiseFloor) * RISE_COEFFICIENT;
      } else if (isSteady()) {
        noiseFloor += (level - noiseFloor) * RISE_COEFFICIENT_OPEN;
      }

      const openThreshold = Math.max(MIN_OPEN_THRESHOLD, noiseFloor * OPEN_RATIO + OPEN_OFFSET);
      const closeThreshold = Math.min(
        openThreshold,
        Math.max(MIN_OPEN_THRESHOLD * 0.75, noiseFloor * CLOSE_RATIO + CLOSE_OFFSET),
      );

      open = open ? level >= closeThreshold : level >= openThreshold;
      return open;
    },
  };
}
