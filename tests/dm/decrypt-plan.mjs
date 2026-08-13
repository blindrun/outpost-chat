// Imports the REAL planDecrypt out of web/src/crypto/pending.ts and runs it,
// rather than a copy of the logic — the whole point is to check the decision
// the app actually makes.
//
// Needs Node's type stripping (22.6+), because the module is TypeScript:
//
//   node --experimental-strip-types tests/dm/decrypt-plan.mjs
//
// What it is guarding, both found 2026-08-13:
//
//   1. A device holding no key left every encrypted message on "Decrypting…"
//      forever. The effect returned before recording anything, so the honest
//      "can't decrypt this message on this device" string was unreachable in
//      the one case it was written for — a fresh install.
//
//   2. Key resolution is async, so for a moment after switching conversations
//      the state still describes the previous one. Acting then decrypts with
//      the wrong key, and a failed decrypt is cached as permanent, so a single
//      mistimed pass brands a whole conversation unreadable until reload.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { planDecrypt } = await import(join(repoRoot, "web/src/crypto/pending.ts"));

let failed = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}\n        expected ${e}\n        actual   ${a}`);
  }
}

const ENC = (id, payload = `cipher-${id}`) => ({ id, encryptedPayload: payload });
const PLAIN = (id) => ({ id, encryptedPayload: null });

// ---------------------------------------------------------------- bug 1

check(
  "no identity on this device is settled, not pending — the reported bug",
  planDecrypt({
    selectedChannelId: "dm1",
    forChannelId: "dm1",
    hasKey: false,
    reason: "self",
    messages: [ENC("m1"), ENC("m2")],
    decrypted: {},
  }),
  { kind: "unreadable", pending: [{ id: "m1", payload: "cipher-m1" }, { id: "m2", payload: "cipher-m2" }] },
);

check(
  "a recorded failure is not retried, so the plan settles instead of looping",
  planDecrypt({
    selectedChannelId: "dm1",
    forChannelId: "dm1",
    hasKey: false,
    reason: "self",
    messages: [ENC("m1")],
    decrypted: { m1: null },
  }),
  { kind: "idle" },
);

// The member list is fetched async and starts empty, so a peer whose public
// key hasn't arrived yet is indistinguishable from one who has none. Writing
// these off would make opening a DM early brand it unreadable for good — a
// worse bug than the spinner, and one the fix above could easily have caused.
check(
  "an absent peer key waits — it is equally 'the member list hasn't loaded'",
  planDecrypt({
    selectedChannelId: "dm1",
    forChannelId: "dm1",
    hasKey: false,
    reason: "peer",
    messages: [ENC("m1")],
    decrypted: {},
  }),
  { kind: "wait" },
);

check(
  "no reason at all waits — an unexplained missing key is not a settled one",
  planDecrypt({
    selectedChannelId: "dm1",
    forChannelId: "dm1",
    hasKey: false,
    messages: [ENC("m1")],
    decrypted: {},
  }),
  { kind: "wait" },
);

// The peer's key arriving after an early open must still work. This is the
// sequence the guard above exists to keep intact.
{
  const messages = [ENC("m1")];
  const early = planDecrypt({
    selectedChannelId: "dm1", forChannelId: "dm1", hasKey: false, reason: "peer", messages, decrypted: {},
  });
  const decrypted = {};
  if (early.kind === "unreadable") for (const p of early.pending) decrypted[p.id] = null;
  const afterLoad = planDecrypt({
    selectedChannelId: "dm1", forChannelId: "dm1", hasKey: true, messages, decrypted,
  });
  check("a peer key arriving late still decrypts", [early.kind, afterLoad.kind], ["wait", "decrypt"]);
}

// ---------------------------------------------------------------- bug 2

check(
  "stale resolution WITH a key waits — decrypting here uses the previous DM's key",
  planDecrypt({
    selectedChannelId: "dm2",
    forChannelId: "dm1",
    hasKey: true,
    messages: [ENC("m3")],
    decrypted: {},
  }),
  { kind: "wait" },
);

check(
  "stale resolution WITHOUT a key waits — it must not record a failure it hasn't checked",
  planDecrypt({
    selectedChannelId: "dm2",
    forChannelId: "dm1",
    hasKey: false,
    reason: "self",
    messages: [ENC("m3")],
    decrypted: {},
  }),
  { kind: "wait" },
);

check(
  "nothing resolved yet waits",
  planDecrypt({
    selectedChannelId: "dm1",
    forChannelId: null,
    hasKey: false,
    messages: [ENC("m1")],
    decrypted: {},
  }),
  { kind: "wait" },
);

check(
  "no channel open waits",
  planDecrypt({
    selectedChannelId: null,
    forChannelId: null,
    hasKey: true,
    messages: [ENC("m1")],
    decrypted: {},
  }),
  { kind: "wait" },
);

// ---------------------------------------------------------------- happy path

check(
  "key resolved for this channel decrypts",
  planDecrypt({
    selectedChannelId: "dm1",
    forChannelId: "dm1",
    hasKey: true,
    messages: [ENC("m1")],
    decrypted: {},
  }),
  { kind: "decrypt", pending: [{ id: "m1", payload: "cipher-m1" }] },
);

check(
  "already-decrypted messages are idle",
  planDecrypt({
    selectedChannelId: "dm1",
    forChannelId: "dm1",
    hasKey: true,
    messages: [ENC("m1")],
    decrypted: { m1: "hello" },
  }),
  { kind: "idle" },
);

// A plain text channel resolves with no key. It must not be reported
// unreadable — there is nothing encrypted in it to fail at.
check(
  "a plain channel with no key is idle, not unreadable",
  planDecrypt({
    selectedChannelId: "general",
    forChannelId: "general",
    hasKey: false,
    reason: "self",
    messages: [PLAIN("m1"), PLAIN("m2")],
    decrypted: {},
  }),
  { kind: "idle" },
);

// ---------------------------------------------------------------- reply quotes

check(
  "a quoted encrypted body is pending too — a quote renders the original",
  planDecrypt({
    selectedChannelId: "dm1",
    forChannelId: "dm1",
    hasKey: true,
    messages: [{ id: "m2", encryptedPayload: "cipher-m2", replyTo: { id: "m1", encryptedPayload: "cipher-m1" } }],
    decrypted: {},
  }),
  { kind: "decrypt", pending: [{ id: "m2", payload: "cipher-m2" }, { id: "m1", payload: "cipher-m1" }] },
);

check(
  "a quote whose original is already decrypted is not re-queued",
  planDecrypt({
    selectedChannelId: "dm1",
    forChannelId: "dm1",
    hasKey: true,
    messages: [{ id: "m2", encryptedPayload: "cipher-m2", replyTo: { id: "m1", encryptedPayload: "cipher-m1" } }],
    decrypted: { m1: "hello" },
  }),
  { kind: "decrypt", pending: [{ id: "m2", payload: "cipher-m2" }] },
);

check(
  "a plain quote on an encrypted message adds nothing",
  planDecrypt({
    selectedChannelId: "dm1",
    forChannelId: "dm1",
    hasKey: true,
    messages: [{ id: "m2", encryptedPayload: "cipher-m2", replyTo: { id: "m1", encryptedPayload: null } }],
    decrypted: {},
  }),
  { kind: "decrypt", pending: [{ id: "m2", payload: "cipher-m2" }] },
);

// ---------------------------------------------------------------- sequences

// What a fresh install actually walks through: it must reach a settled answer,
// not oscillate. Each step feeds the previous step's recorded results back in.
{
  const messages = [ENC("m1"), ENC("m2")];
  let decrypted = {};
  const kinds = [];
  for (const forChannelId of [null, "dm1", "dm1"]) {
    const plan = planDecrypt({ selectedChannelId: "dm1", forChannelId, hasKey: false, reason: "self", messages, decrypted });
    kinds.push(plan.kind);
    if (plan.kind === "unreadable") for (const p of plan.pending) decrypted[p.id] = null;
  }
  check("fresh install converges: wait, then unreadable, then idle", kinds, ["wait", "unreadable", "idle"]);
}

// Restoring a recovery code clears `decrypted` (App.tsx does this on identity
// change). Without that clear, the recorded failures above would survive and
// the restored key would never be used.
{
  const messages = [ENC("m1")];
  const beforeRestore = { m1: null };
  check(
    "a restored key with the cache still populated would do nothing",
    planDecrypt({ selectedChannelId: "dm1", forChannelId: "dm1", hasKey: true, messages, decrypted: beforeRestore }),
    { kind: "idle" },
  );
  check(
    "a restored key with the cache cleared decrypts",
    planDecrypt({ selectedChannelId: "dm1", forChannelId: "dm1", hasKey: true, messages, decrypted: {} }),
    { kind: "decrypt", pending: [{ id: "m1", payload: "cipher-m1" }] },
  );
}

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
