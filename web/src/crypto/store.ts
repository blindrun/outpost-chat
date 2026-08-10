// Local storage for DM encryption material. Kept apart from keys.ts so the
// crypto itself stays testable without a browser.
//
// IndexedDB rather than localStorage for one specific reason: IndexedDB can
// store a live `CryptoKey` object via structured clone, so the *non-extractable*
// private key persists across reloads while never existing as bytes that script
// can read. localStorage only holds strings, which would mean keeping the raw
// key material around and giving up the property that made WebCrypto worth
// choosing in the first place.
//
// Everything here is keyed by instance id. Accounts in this app are per
// instance (see the single-community-per-instance model), so identities are
// too — the same person on two servers has two unrelated keypairs, and mixing
// them would be both wrong and confusing.

const DB_NAME = "outpost-e2ee";
const DB_VERSION = 1;
const IDENTITY_STORE = "identities";
const PEER_STORE = "peers";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDENTITY_STORE)) db.createObjectStore(IDENTITY_STORE);
      if (!db.objectStoreNames.contains(PEER_STORE)) db.createObjectStore(PEER_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run<T>(storeName: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const request = fn(tx.objectStore(storeName));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
      }),
  );
}

export interface StoredIdentity {
  /** Non-extractable — persisted as a live CryptoKey, never as bytes. */
  privateKey: CryptoKey;
  /** Base64 SPKI, kept alongside so the fingerprint can be shown offline. */
  publicKey: string;
  createdAt: number;
}

export function saveIdentity(instanceId: string, identity: StoredIdentity): Promise<void> {
  return run<void>(IDENTITY_STORE, "readwrite", (store) => store.put(identity, instanceId));
}

export function loadIdentity(instanceId: string): Promise<StoredIdentity | undefined> {
  return run<StoredIdentity | undefined>(IDENTITY_STORE, "readonly", (store) => store.get(instanceId));
}

/**
 * Forgets the local identity. Deliberately separate from "stop encrypting new
 * messages" — this is the action that makes existing encrypted history
 * permanently unreadable on this device, and it should never be a side effect
 * of merely turning the feature off.
 */
export function clearIdentity(instanceId: string): Promise<void> {
  return run<void>(IDENTITY_STORE, "readwrite", (store) => store.delete(instanceId));
}

export interface PinnedPeer {
  publicKey: string;
  pinnedAt: number;
}

function peerKey(instanceId: string, userId: string) {
  return `${instanceId}:${userId}`;
}

/**
 * Trust-on-first-use. The server publishes public keys, so the one attack it
 * can actually mount is handing out its own key instead of your contact's.
 * Pinning what was seen first turns a silent substitution into a visible
 * change, which is the whole point — the fingerprint in keys.ts covers the
 * case where the very first key was already wrong.
 */
export function pinPeerKey(instanceId: string, userId: string, publicKey: string): Promise<void> {
  return run<void>(PEER_STORE, "readwrite", (store) =>
    store.put({ publicKey, pinnedAt: Date.now() } satisfies PinnedPeer, peerKey(instanceId, userId)),
  );
}

export function loadPinnedPeer(instanceId: string, userId: string): Promise<PinnedPeer | undefined> {
  return run<PinnedPeer | undefined>(PEER_STORE, "readonly", (store) => store.get(peerKey(instanceId, userId)));
}

export type PeerTrust = "first-use" | "unchanged" | "changed";

/**
 * Compares a freshly-fetched public key against what was pinned. Returns
 * "changed" rather than throwing or auto-updating: whether to keep talking to
 * someone whose key rotated is a decision for the person, not for this
 * function. A legitimate rotation (lost recovery code, set up again) and an
 * active attack look identical from here — which is exactly why it has to be
 * surfaced instead of resolved silently.
 */
export async function checkPeerKey(instanceId: string, userId: string, publicKey: string): Promise<PeerTrust> {
  const pinned = await loadPinnedPeer(instanceId, userId);
  if (!pinned) {
    await pinPeerKey(instanceId, userId, publicKey);
    return "first-use";
  }
  return pinned.publicKey === publicKey ? "unchanged" : "changed";
}

/** Accepts a rotated key after the user has been shown the warning. */
export function acceptPeerKeyChange(instanceId: string, userId: string, publicKey: string): Promise<void> {
  return pinPeerKey(instanceId, userId, publicKey);
}
