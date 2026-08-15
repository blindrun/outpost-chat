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
// Everything here is keyed by *account on a server*, not by instance id.
//
// It used to be keyed by instance id, and that lost people's keys two ways.
// An instance is a local bookmark whose id is `crypto.randomUUID()` at the
// moment you add the server, so Leave Server followed by re-adding produced a
// new id and stranded the identity under the old one — still in the database,
// just under a key nothing looks up again. Worse, the id says nothing about
// *who* is signed in, so signing in as a second account on the same bookmark
// and enabling encryption overwrote the first account's private key in place,
// silently and unrecoverably.
//
// Server origin plus user id is stable across both. Re-adding a bookmark
// resolves to the same scope, and two accounts on one server can never
// collide. The same person on two servers still gets two unrelated keypairs,
// which was always the intent.

const DB_NAME = "outpost-e2ee";
const DB_VERSION = 1;
const IDENTITY_STORE = "identities";
const PEER_STORE = "peers";

/** Which account, on which server, an identity belongs to. */
export interface IdentityScope {
  baseUrl: string;
  userId: string;
}

/**
 * Origin rather than the raw string, so a trailing slash or a different case
 * in the host cannot produce a second scope for the same server. Falls back to
 * the trimmed input if it will not parse, because an unusable key here is
 * better than a thrown error that loses access to a working identity.
 */
function normalizeBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin.toLowerCase();
  } catch {
    return baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  }
}

/**
 * `|` is the separator because it cannot appear in an origin or in a uuid, so
 * a scoped key can never be mistaken for a legacy instance-id key. That
 * distinction is what makes the migration below safe to run repeatedly.
 */
export function identityScopeKey(scope: IdentityScope): string {
  return `${normalizeBaseUrl(scope.baseUrl)}|${scope.userId}`;
}

function isLegacyKey(key: IDBValidKey): key is string {
  return typeof key === "string" && !key.includes("|");
}

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

/**
 * Anything that changes the local identity has to be observable.
 *
 * The DM crypto state is resolved in an effect keyed on channels/members, and
 * enabling encryption changes neither — it just writes a key to IndexedDB,
 * which React cannot see. So the open conversation went on claiming "you
 * haven't turned encryption on" until the app was restarted, on every platform.
 * Notifying from the store rather than from the settings modal means enable,
 * restore and clear all fix it, and so does anything added later.
 */
type IdentityListener = (scopeKey: string) => void;
const identityListeners = new Set<IdentityListener>();

export function onIdentityChange(fn: IdentityListener): () => void {
  identityListeners.add(fn);
  return () => {
    identityListeners.delete(fn);
  };
}

function notifyIdentityChanged(scopeKey: string) {
  for (const fn of [...identityListeners]) fn(scopeKey);
}

export async function saveIdentity(scope: IdentityScope, identity: StoredIdentity): Promise<void> {
  const key = identityScopeKey(scope);
  await run<void>(IDENTITY_STORE, "readwrite", (store) => store.put(identity, key));
  notifyIdentityChanged(key);
}

export function loadIdentity(scope: IdentityScope): Promise<StoredIdentity | undefined> {
  return run<StoredIdentity | undefined>(IDENTITY_STORE, "readonly", (store) => store.get(identityScopeKey(scope)));
}

/**
 * Forgets the local identity. Deliberately separate from "stop encrypting new
 * messages" — this is the action that makes existing encrypted history
 * permanently unreadable on this device, and it should never be a side effect
 * of merely turning the feature off.
 */
export function clearIdentity(scope: IdentityScope): Promise<void> {
  return run<void>(IDENTITY_STORE, "readwrite", (store) => store.delete(identityScopeKey(scope)));
}

/**
 * Picks which legacy, instance-id-keyed record belongs to this account.
 *
 * The only safe evidence is the public half: adopt a record when its
 * `publicKey` is exactly what the server publishes for the signed-in account.
 * Anything weaker would risk handing one account another's private key, which
 * is the very failure this migration exists to clean up. Records left behind
 * are other accounts' keys and must stay where they are.
 *
 * Pure and separate from IndexedDB so it can be tested without a browser.
 */
export function pickLegacyIdentity<T extends { publicKey: string }>(
  entries: { key: IDBValidKey; value: T }[],
  accountPublicKey: string,
): { key: string; value: T } | undefined {
  if (!accountPublicKey) return undefined;
  for (const entry of entries) {
    if (isLegacyKey(entry.key) && entry.value?.publicKey === accountPublicKey) {
      return { key: entry.key, value: entry.value };
    }
  }
  return undefined;
}

/**
 * Adopts a pre-scope identity for this account, if one is stranded.
 *
 * Runs on load and is a no-op once there is nothing to adopt, so it is safe to
 * call every time. Copies before deleting: an interruption halfway leaves the
 * old record intact rather than destroying the only copy of a private key.
 *
 * Returns whether anything was adopted, so the caller can re-read.
 */
export async function migrateLegacyIdentity(scope: IdentityScope, accountPublicKey: string): Promise<boolean> {
  if (!accountPublicKey) return false;
  if (await loadIdentity(scope)) return false;

  const db = await openDb();
  const entries = await new Promise<{ key: IDBValidKey; value: StoredIdentity }[]>((resolve, reject) => {
    const store = db.transaction(IDENTITY_STORE, "readonly").objectStore(IDENTITY_STORE);
    const keysReq = store.getAllKeys();
    const valsReq = store.getAll();
    keysReq.onerror = () => reject(keysReq.error);
    valsReq.onerror = () => reject(valsReq.error);
    valsReq.onsuccess = () =>
      resolve((keysReq.result as IDBValidKey[]).map((key, i) => ({ key, value: valsReq.result[i] as StoredIdentity })));
  });
  db.close();

  const found = pickLegacyIdentity(entries, accountPublicKey);
  if (!found) return false;

  await saveIdentity(scope, found.value);
  await migrateLegacyPeers(found.key, scope);
  await run<void>(IDENTITY_STORE, "readwrite", (store) => store.delete(found.key));
  return true;
}

/**
 * Carries pinned peer keys across with the identity. Without this the
 * migration would silently reset every conversation to trust-on-first-use,
 * which would re-accept a substituted key without ever showing the warning
 * that pinning exists to produce.
 */
async function migrateLegacyPeers(legacyInstanceId: string, scope: IdentityScope): Promise<void> {
  const db = await openDb();
  const entries = await new Promise<{ key: IDBValidKey; value: PinnedPeer }[]>((resolve, reject) => {
    const store = db.transaction(PEER_STORE, "readonly").objectStore(PEER_STORE);
    const keysReq = store.getAllKeys();
    const valsReq = store.getAll();
    keysReq.onerror = () => reject(keysReq.error);
    valsReq.onerror = () => reject(valsReq.error);
    valsReq.onsuccess = () =>
      resolve((keysReq.result as IDBValidKey[]).map((key, i) => ({ key, value: valsReq.result[i] as PinnedPeer })));
  });
  db.close();

  const prefix = `${legacyInstanceId}:`;
  for (const entry of entries) {
    if (typeof entry.key !== "string" || !entry.key.startsWith(prefix)) continue;
    const peerUserId = entry.key.slice(prefix.length);
    await run<void>(PEER_STORE, "readwrite", (store) => store.put(entry.value, peerKey(scope, peerUserId)));
    await run<void>(PEER_STORE, "readwrite", (store) => store.delete(entry.key));
  }
}

export interface PinnedPeer {
  publicKey: string;
  pinnedAt: number;
}

// Scoped the same way as identities, and for the same reason: a pin records
// "the key *I* first saw for this person", so it belongs to my account, not to
// a bookmark. Sharing pins between two accounts on one server would let one
// account's trust decision silence the other's key-change warning.
function peerKey(scope: IdentityScope, peerUserId: string) {
  return `${identityScopeKey(scope)}:${peerUserId}`;
}

/**
 * Trust-on-first-use. The server publishes public keys, so the one attack it
 * can actually mount is handing out its own key instead of your contact's.
 * Pinning what was seen first turns a silent substitution into a visible
 * change, which is the whole point — the fingerprint in keys.ts covers the
 * case where the very first key was already wrong.
 */
export function pinPeerKey(scope: IdentityScope, peerUserId: string, publicKey: string): Promise<void> {
  return run<void>(PEER_STORE, "readwrite", (store) =>
    store.put({ publicKey, pinnedAt: Date.now() } satisfies PinnedPeer, peerKey(scope, peerUserId)),
  );
}

export function loadPinnedPeer(scope: IdentityScope, peerUserId: string): Promise<PinnedPeer | undefined> {
  return run<PinnedPeer | undefined>(PEER_STORE, "readonly", (store) => store.get(peerKey(scope, peerUserId)));
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
export async function checkPeerKey(scope: IdentityScope, peerUserId: string, publicKey: string): Promise<PeerTrust> {
  const pinned = await loadPinnedPeer(scope, peerUserId);
  if (!pinned) {
    await pinPeerKey(scope, peerUserId, publicKey);
    return "first-use";
  }
  return pinned.publicKey === publicKey ? "unchanged" : "changed";
}

/** Accepts a rotated key after the user has been shown the warning. */
export function acceptPeerKeyChange(scope: IdentityScope, peerUserId: string, publicKey: string): Promise<void> {
  return pinPeerKey(scope, peerUserId, publicKey);
}
