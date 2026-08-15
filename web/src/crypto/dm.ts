// The layer between "we have keys" (crypto/keys.ts, crypto/store.ts) and "this
// DM channel is encrypted" (App.tsx). Owns two things the UI shouldn't have to
// reason about: whether a given conversation *can* be encrypted right now, and
// caching the derived key so every message doesn't repeat an ECDH.

import { Envelope, decryptMessage, deriveConversationKey, encryptMessage, importPublicKey } from "./keys";
import { IdentityScope, PeerTrust, checkPeerKey, identityScopeKey, loadIdentity } from "./store";

export interface DmCryptoState {
  /** Encrypt outgoing messages in this conversation. */
  active: boolean;
  /**
   * Why it isn't active, for a UI that has to explain itself rather than
   * silently sending in the clear:
   *   "self"  — you haven't turned encryption on
   *   "peer"  — they haven't
   */
  reason?: "self" | "peer";
  trust?: PeerTrust;
  key?: CryptoKey;
}

// Derived keys, per (account-scope, peer). An ECDH derivation is cheap but
// not free, and a busy conversation would otherwise redo it per message — plus
// re-deriving on every render would make the key identity unstable for
// anything memoising on it.
//
// Scoped by account rather than by bookmark so that signing in as someone else
// cannot serve a cached key derived from the previous account's identity.
const keyCache = new Map<string, CryptoKey>();

function cacheKey(scopeKey: string, peerUserId: string, peerPublicKey: string) {
  // The peer's key is part of the identity: if they rotate, the old derived
  // key must not be reused just because the user id matches.
  return `${scopeKey}:${peerUserId}:${peerPublicKey}`;
}

/**
 * Works out whether a DM with this peer is encrypted, deriving (and caching)
 * the conversation key when it is.
 *
 * Deliberately returns a reason instead of throwing when it can't encrypt:
 * one-sided setup is a completely normal state — most people won't have turned
 * this on — and the correct behaviour is to send in the clear *and say so*,
 * not to refuse. Failing closed would mean the first person to enable
 * encryption could no longer message anyone.
 */
export async function resolveDmCrypto(
  scope: IdentityScope,
  peerUserId: string,
  peerPublicKey: string | null | undefined,
): Promise<DmCryptoState> {
  const identity = await loadIdentity(scope);
  if (!identity) return { active: false, reason: "self" };
  if (!peerPublicKey) return { active: false, reason: "peer" };

  const trust = await checkPeerKey(scope, peerUserId, peerPublicKey);

  const id = cacheKey(identityScopeKey(scope), peerUserId, peerPublicKey);
  let key = keyCache.get(id);
  if (!key) {
    key = await deriveConversationKey(identity.privateKey, await importPublicKey(peerPublicKey));
    keyCache.set(id, key);
  }
  return { active: true, trust, key };
}

export async function encryptForDm(key: CryptoKey, plaintext: string): Promise<string> {
  return JSON.stringify(await encryptMessage(key, plaintext));
}

/**
 * Decrypts a stored envelope. Returns null rather than throwing on anything
 * malformed or undecryptable — a message encrypted to a key you no longer hold
 * (they rotated, you restored a different identity) is a permanent, expected
 * state, not an error to crash a render over. The caller shows a placeholder.
 */
export async function decryptForDm(key: CryptoKey | undefined, payload: string): Promise<string | null> {
  if (!key) return null;
  try {
    const envelope = JSON.parse(payload) as Envelope;
    if (envelope.v !== 1) return null;
    return await decryptMessage(key, envelope);
  } catch {
    return null;
  }
}

/** Drops cached keys for one account — used when an identity is replaced. */
export function forgetDerivedKeys(scopeKey: string) {
  for (const id of keyCache.keys()) {
    if (id.startsWith(`${scopeKey}:`)) keyCache.delete(id);
  }
}
