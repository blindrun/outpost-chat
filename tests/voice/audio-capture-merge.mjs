// Pulls the REAL mergeDefaultOptions/mergeObjectWithoutOverwriting out of the
// installed livekit-client bundle (they aren't exported) and runs them, so
// this checks the library's actual merge semantics rather than my reading of
// them. Throwaway -- not a committed test.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Resolved from this file rather than hardcoded, so the suite runs from any
// checkout and any working directory.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

import { readFileSync } from "node:fs";

const src = readFileSync(
  join(repoRoot, "web/node_modules/livekit-client/dist/livekit-client.esm.mjs"),
  "utf8",
);

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found`);
  // Walk braces from the first { after the signature.
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const harness = [
  // Dependency of extractProcessorsFromOptions; structuredClone is an exact
  // stand-in for what the bundle's own deep clone does to plain objects.
  "const cloneDeep = (o) => structuredClone(o);",
  extract("mergeObjectWithoutOverwriting"),
  extract("extractProcessorsFromOptions"),
  extract("mergeDefaultOptions"),
  "return mergeDefaultOptions;",
].join("\n");

const mergeDefaultOptions = eval(`(() => { ${harness} })()`);

// What WebLiveKitEngine now passes as Room's audioCaptureDefaults with
// "noise suppression" switched OFF by the user.
const captureDefaults = {
  noiseSuppression: false,
  echoCancellation: true,
  autoGainControl: true,
  voiceIsolation: false,
};

// What setMicrophoneEnabled(true, deviceId) passes per-call at join time.
const perCall = { audio: { deviceId: "mic-abc" } };

const merged = mergeDefaultOptions(perCall, captureDefaults, undefined);
console.log("merged audio constraints:", merged.audio);

const checks = [
  ["user's OFF survives the merge", merged.audio.noiseSuppression === false],
  ["voiceIsolation follows it OFF", merged.audio.voiceIsolation === false],
  ["untouched default stays ON", merged.audio.echoCancellation === true],
  ["per-call deviceId preserved", merged.audio.deviceId === "mic-abc"],
];

// And the default case: nothing should change vs today's implicit behavior.
const allOn = { noiseSuppression: true, echoCancellation: true, autoGainControl: true, voiceIsolation: true };
const defaultMerged = mergeDefaultOptions({ audio: {} }, allOn, undefined);
checks.push([
  "defaults reproduce livekit's own audioDefaults",
  defaultMerged.audio.noiseSuppression === true &&
    defaultMerged.audio.echoCancellation === true &&
    defaultMerged.audio.autoGainControl === true &&
    defaultMerged.audio.voiceIsolation === true &&
    JSON.stringify(defaultMerged.audio.deviceId) === JSON.stringify({ ideal: "default" }),
]);

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
