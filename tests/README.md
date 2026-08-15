# Tests

Plain `node` scripts, no test runner. There isn't one in this project yet,
and adding a framework as a side effect of a feature seemed like the wrong
trade — these run with the Node that's already here.

Each script prints `PASS`/`FAIL` per check and exits non-zero if any failed.

A note on what they're for: the negative cases are the point. A suite that
only proves the happy path still passes when a security check has been
removed entirely, which is exactly the failure this project has already hit
once — a block-filter test that passed against an empty fixture while the
real bug would have dropped every webhook and bot message.

## No setup needed

```bash
node tests/voice/audio-capture-merge.mjs   # LiveKit capture-option merging
node tests/oidc/oidc-verify-check.mjs      # ID token signature verification
node tests/oidc/electron-url-check.mjs     # outpost:// hand-off URL parsing

node --experimental-strip-types tests/dm/decrypt-plan.mjs     # when to decrypt a DM
node --experimental-strip-types tests/dm/identity-scope.mjs  # where a DM key is filed
```

`identity-scope.mjs` covers which stranded, pre-scope key a migration is
allowed to adopt. Identities used to be filed under the instance id, a
per-bookmark uuid, so leaving a server and re-adding it stranded the key, and
signing in as a second account on the same bookmark overwrote the first
account's private key in place. Both silent, both unrecoverable.

Its negative cases carry the weight: adopting too eagerly would hand one
account another account's private key, which is worse than the bug being
fixed. Deleting the public-key match in `pickLegacyIdentity` fails two checks,
which was verified by actually doing it rather than assumed.

`decrypt-plan.mjs` needs the type-stripping flag because it imports
`web/src/crypto/pending.ts` directly rather than a copy — the decision it
checks is the one the app actually makes. Node 22.6+.

It covers a class of bug that a typechecker cannot see, because nothing about
it is a type error: *when* the decision runs. Two pieces of state have to agree
first — which conversation is open, and which one the key state was resolved
against — and both ways of getting that wrong are silent. Treating "no key" as
a settled answer too eagerly writes a permanent failure onto a conversation
whose peer key simply hadn't loaded yet; treating it as pending forever leaves
a fresh install spinning on "Decrypting…" with no way out. The suite asserts
both edges, and the sequences either side of them.

`oidc-verify-check.mjs` needs the backend built first (`npm run build`) — it
imports the compiled `dist/util/oidc.js` rather than a copy of the logic.

It generates its own keys and serves its own JWKS, then checks that a
tampered payload, a key that isn't in the JWKS, `alg: none`, an HS256
algorithm-confusion forgery, a wrong audience, a wrong issuer, an expired
token and a replayed nonce are all rejected.

`electron-url-check.mjs` pulls `parseSsoUrl` straight out of
`electron/main.js` and runs it — Electron itself can't be launched headless,
but that function sees every argv entry the OS hands the app, so a false
positive gets acted on and a false negative silently drops a finished
sign-in.

## Needs a running server

These drive the real server against a real database, with a fake — but
honest — identity provider: real discovery document, real PKCE verification,
real RS256 ID tokens signed with a key it publishes over JWKS.

```bash
# 1. a database, and the backend built
docker compose up -d postgres
npm run build && npx prisma migrate deploy

# 2. the fake provider
node tests/oidc/fake-idp.mjs &

# 3. the server, pointed at it
OIDC_ISSUER=http://127.0.0.1:39190 \
OIDC_CLIENT_ID=outpost \
OIDC_CLIENT_SECRET=outpost-secret \
OIDC_DISPLAY_NAME=FakeIdP \
PORT=8099 node dist/server.js &

# 4. the suites, in this order
node tests/oidc/oidc-e2e.mjs        # the whole sign-in, plus replay attempts
node tests/oidc/oidc-native.mjs     # the desktop outpost:// hand-off
node tests/oidc/oidc-mfa.mjs        # 2FA is still enforced on an SSO login
node tests/oidc/oidc-linking.mjs <existing-email> <existing-username>   # last
```

**Order matters.** `oidc-linking.mjs` runs the provider itself — restarting
it between cases so it can assert different claims each time — and stops it
when it finishes. Run it last, or the others lose their provider mid-suite.

**If you start the provider with non-default claims**, pass the same
`IDP_EMAIL` / `IDP_USERNAME` to `oidc-e2e.mjs`, which checks the account it
created matches what the provider asserted.

The instance must already have an owner, or sign-in is refused by design —
the first account can't be created through an identity provider.

**`/auth/oidc/start` is rate limited to 20 requests per 10 minutes**, and
these suites spend several each. Running them repeatedly will hit it; the
scripts detect the 429 and say so rather than failing obscurely. Restarting
the server resets the counter.

`oidc-linking.mjs` takes an existing local account to link against, and
restarts the fake provider between cases so it can assert different claims
each time. It checks the rules where a mistake means account takeover rather
than a broken login: an unverified email matching an existing account is
refused, a verified one links without renaming anything, and the identity
stays the provider's subject even after the email changes.

**Kill a previous `fake-idp.mjs` before starting a new one.** A stale copy
keeps the port, the new one fails to bind silently, and the suite then
asserts against the wrong provider's claims — which looks exactly like a
real regression.
