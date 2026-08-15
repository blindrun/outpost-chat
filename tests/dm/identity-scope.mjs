// How DM identities are filed, and which stranded records may be adopted.
//
// Run: node --experimental-strip-types tests/dm/identity-scope.mjs
//
// This exists because the old scheme filed identities under the instance id,
// a per-bookmark uuid. Leaving a server and re-adding it stranded the key, and
// signing in as a second account on the same bookmark overwrote the first
// account's private key in place. Both were silent and unrecoverable.
//
// The negative cases below are the important ones. A migration that adopts too
// eagerly hands one account another account's private key, which is worse than
// the bug it replaces.

import { identityScopeKey, pickLegacyIdentity } from "../../web/src/crypto/store.ts";

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

const ALICE = "user-alice";
const BOB = "user-bob";
const SERVER = "https://outpost.sonofatech.com";

// --- scope keys -------------------------------------------------------------

check(
  "a trailing slash is the same scope",
  identityScopeKey({ baseUrl: SERVER + "/", userId: ALICE }),
  identityScopeKey({ baseUrl: SERVER, userId: ALICE }),
);

check(
  "host case is the same scope",
  identityScopeKey({ baseUrl: "https://OUTPOST.sonofatech.com", userId: ALICE }),
  identityScopeKey({ baseUrl: SERVER, userId: ALICE }),
);

check(
  "a path does not create a second scope",
  identityScopeKey({ baseUrl: SERVER + "/api", userId: ALICE }),
  identityScopeKey({ baseUrl: SERVER, userId: ALICE }),
);

// The whole point: two accounts on one server must never share a slot.
check(
  "two accounts on one server are different scopes",
  identityScopeKey({ baseUrl: SERVER, userId: ALICE }) === identityScopeKey({ baseUrl: SERVER, userId: BOB }),
  false,
);

check(
  "one account on two servers are different scopes",
  identityScopeKey({ baseUrl: SERVER, userId: ALICE }) ===
    identityScopeKey({ baseUrl: "https://outpost-staging.sonofatech.com", userId: ALICE }),
  false,
);

// --- adopting stranded records ---------------------------------------------

const legacyKey = "7fd00db0-53d6-48c1-b535-8d180b00fe20";
const mine = { publicKey: "MINE" };
const theirs = { publicKey: "THEIRS" };

check(
  "adopts a stranded record whose public key is this account's",
  pickLegacyIdentity([{ key: legacyKey, value: mine }], "MINE"),
  { key: legacyKey, value: mine },
);

// The live failure this was written for: a machine holding another account's
// key under a stale bookmark id. Adopting it would hand Alice Bob's identity.
check(
  "refuses a stranded record belonging to another account",
  pickLegacyIdentity([{ key: legacyKey, value: theirs }], "MINE"),
  undefined,
);

check(
  "picks only the matching record when several are stranded",
  pickLegacyIdentity(
    [
      { key: "aaaaaaaa-0000-0000-0000-000000000000", value: theirs },
      { key: legacyKey, value: mine },
    ],
    "MINE",
  ),
  { key: legacyKey, value: mine },
);

// Already-migrated records contain "|" and must be invisible here, or the
// migration would keep re-adopting its own output and deleting the result.
check(
  "ignores records that are already scoped",
  pickLegacyIdentity([{ key: `${SERVER}|${ALICE}`, value: mine }], "MINE"),
  undefined,
);

// No published key means no evidence, so there is nothing safe to adopt.
check("adopts nothing when the account publishes no key", pickLegacyIdentity([{ key: legacyKey, value: mine }], ""), undefined);

check("adopts nothing from an empty database", pickLegacyIdentity([], "MINE"), undefined);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
