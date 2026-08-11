// Electron itself can't run on this headless box, but parseSsoUrl is pure
// logic pulled straight out of main.js — and it's the piece that decides
// whether a hand-off is recognised at all. Everything Windows and Linux put
// in argv passes through here, so a false positive would be acted on and a
// false negative would silently drop a completed sign-in.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Resolved from this file rather than hardcoded, so the suite runs from any
// checkout and any working directory.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

import { readFileSync } from "node:fs";

const src = readFileSync(join(repoRoot, "electron/main.js"), "utf8");
const start = src.indexOf("function parseSsoUrl(");
let i = src.indexOf("{", start);
let depth = 0;
let end = i;
for (; i < src.length; i++) {
  if (src[i] === "{") depth++;
  else if (src[i] === "}" && --depth === 0) {
    end = i + 1;
    break;
  }
}
const parseSsoUrl = eval(`(() => { const PROTOCOL = "outpost"; ${src.slice(start, end)} return parseSsoUrl; })()`);

const cases = [
  ["a real success hand-off", "outpost://auth?oidc=AbC-123_xyz", (r) => r?.code === "AbC-123_xyz" && !r.error],
  [
    "a real failure hand-off",
    `outpost://auth?oidc_error=${encodeURIComponent("this sign-in attempt expired")}`,
    (r) => r?.error === "this sign-in attempt expired" && !r.code,
  ],
  ["the executable path in argv", "/usr/lib/outpost/outpost", (r) => r === null],
  ["a chromium switch in argv", "--enable-features=SomeFeature", (r) => r === null],
  ["a Windows-style path", "C:\\Program Files\\Outpost\\Outpost.exe", (r) => r === null],
  ["some other app's protocol", "discord://auth?oidc=nope", (r) => r === null],
  ["our scheme with nothing useful", "outpost://auth", (r) => r === null],
  ["our scheme, unrelated params", "outpost://auth?something=else", (r) => r === null],
  ["a malformed URL on our scheme", "outpost://:::::", (r) => r === null],
  ["a non-string argv entry", undefined, (r) => r === null],
  [
    "a code containing URL-escaped characters",
    `outpost://auth?oidc=${encodeURIComponent("a+b/c=")}`,
    (r) => r?.code === "a+b/c=",
  ],
];

let failed = 0;
for (const [name, input, check] of cases) {
  let ok = false;
  let note = "";
  try {
    const result = parseSsoUrl(input);
    ok = check(result);
    if (!ok) note = JSON.stringify(result);
  } catch (err) {
    note = `threw: ${err.message}`;
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note && !ok ? `  — ${note}` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
