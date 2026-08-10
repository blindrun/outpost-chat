// Pure crypto for encrypted DMs. No storage, no DOM, no network — everything
// here is a function of its arguments, so it can be exercised outside a
// browser. Storage lives in ./store.ts and the two are kept apart on purpose:
// key handling is the part that has to be right, and it should be testable
// without standing up IndexedDB.
//
// Choice of primitives, and why not the more fashionable ones:
//
//   ECDH P-256 via WebCrypto, not X25519 via a JS library. X25519 is the
//   better modern curve, but WebCrypto's support for it is recent and uneven,
//   and the mobile apps run this exact code inside Android's WebView and iOS's
//   WKWebView (capacitor.config.ts bundles the web client) — the last place to
//   discover a missing primitive. P-256 ECDH has been in WebCrypto everywhere
//   for years.
//
//   More importantly, a JS-library key is raw bytes sitting in a variable that
//   any XSS can read. A WebCrypto key can be marked NON-EXTRACTABLE: the
//   browser will happily derive with it and flatly refuse to export it, so the
//   private key survives script injection that would trivially steal a
//   Uint8Array. That property is worth more here than the curve choice, and it
//   is the reason this doesn't add a crypto dependency at all — which also
//   avoids repeating the v0.2.14 incident, where a new backend dependency
//   turned out to be incompatible with the production runtime.

const ECDH_PARAMS: EcKeyGenParams = { name: "ECDH", namedCurve: "P-256" };

export interface GeneratedIdentity {
  /** Base64 SPKI, published to the server. */
  publicKey: string;
  /** Base64 PKCS8. Shown to the user once, then never obtainable again. */
  recoveryCode: string;
  /** Non-extractable — safe to persist, cannot be read back out. */
  privateKey: CryptoKey;
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Generates a fresh identity. The private key is created extractable purely so
 * the recovery code can be produced, then immediately re-imported
 * non-extractable; only the non-extractable handle is returned, so the caller
 * has no way to leak it even by accident. The recovery code is the single path
 * to this identity on another device — and, deliberately, resetting an account
 * password does not and cannot substitute for it.
 */
export async function generateIdentity(): Promise<GeneratedIdentity> {
  const pair = await crypto.subtle.generateKey(ECDH_PARAMS, true, ["deriveBits"]);
  const publicKey = toBase64(await crypto.subtle.exportKey("spki", pair.publicKey));
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const privateKey = await importPrivateKey(toBase64(pkcs8));
  return { publicKey, recoveryCode: toBase64(pkcs8), privateKey };
}

/** Re-imports a private key from a recovery code, non-extractable. */
export function importPrivateKey(recoveryCode: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", fromBase64(recoveryCode), ECDH_PARAMS, false, ["deriveBits"]);
}

export function importPublicKey(spkiBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", fromBase64(spkiBase64), ECDH_PARAMS, false, []);
}

/**
 * Derives the AES-GCM key for a conversation from your private key and the
 * peer's public key. Both sides compute the identical key from opposite
 * halves, so there is nothing to transmit and nothing for the server to hold.
 *
 * The raw ECDH output is run through HKDF rather than used directly — a shared
 * secret is not uniformly random, and binding the context string in means a
 * key derived for DMs can never collide with one derived for some other
 * purpose added later.
 */
export async function deriveConversationKey(privateKey: CryptoKey, peerPublicKey: CryptoKey): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peerPublicKey }, privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      // No salt: both sides must derive the same key with no extra state to
      // exchange, and the ECDH secret is already unique to the pair.
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("outpost-dm-v1"),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface Envelope {
  v: 1;
  /** Base64 12-byte GCM nonce. */
  iv: string;
  /** Base64 ciphertext. */
  ct: string;
}

/**
 * A fresh random IV per message — reusing one under the same key is the
 * classic way to break GCM outright. The version field exists so a future
 * scheme (a ratchet, a different cipher) can be introduced without having to
 * guess how to read what's already stored.
 */
export async function encryptMessage(key: CryptoKey, plaintext: string): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return { v: 1, iv: toBase64(iv.buffer), ct: toBase64(ct) };
}

export async function decryptMessage(key: CryptoKey, envelope: Envelope): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(fromBase64(envelope.iv)) },
    key,
    fromBase64(envelope.ct),
  );
  return new TextDecoder().decode(plain);
}

/**
 * A short human-comparable digest of both public keys, for reading aloud to
 * check nobody is in the middle. Sorted before hashing so both participants
 * see the same value regardless of who is looking.
 *
 * This is the only defence against the one attack the server can actually
 * mount: it publishes public keys, so it could hand out its own. Pinning
 * catches a key that *changes*; this catches one that was wrong from the
 * start.
 */
export async function conversationFingerprint(publicKeyA: string, publicKeyB: string): Promise<string> {
  const [first, second] = [publicKeyA, publicKeyB].sort();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${first}|${second}`));
  const bytes = new Uint8Array(digest).slice(0, 15);
  const digits = Array.from(bytes, (b) => b.toString().padStart(3, "0")).join("");
  return (digits.match(/.{1,5}/g) ?? []).join(" ");
}
