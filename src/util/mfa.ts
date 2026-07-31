import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import QRCode from "qrcode";
import { generateSecret, generateURI, verify as verifyOtp } from "otplib";
import type { FastifyInstance, FastifyRequest } from "fastify";

const ISSUER = "Outpost";

export function generateTotpSecret(): string {
  return generateSecret();
}

export async function totpQrCodeDataUrl(username: string, secret: string): Promise<string> {
  const uri = generateURI({ issuer: ISSUER, label: username, secret });
  return QRCode.toDataURL(uri);
}

// otplib's verify() throws (rather than returning { valid: false }) for
// input that isn't shaped like a TOTP code at all — e.g. an 11-character
// backup code passed straight through by a caller that tries TOTP first
// and falls back to backup codes. Every caller here does exactly that, so
// this treats "doesn't even look like a code" the same as "wrong code"
// rather than letting it crash the request.
export async function verifyTotpCode(secret: string, token: string): Promise<boolean> {
  try {
    const result = await verifyOtp({ secret, token });
    return result.valid;
  } catch {
    return false;
  }
}

const BACKUP_CODE_COUNT = 10;

// Plaintext codes are returned once (shown to the user right after
// generation) and never stored — only their bcrypt hashes persist, same as
// a password. Format is deliberately typeable (no ambiguous 0/O/1/I) since
// these are meant to be written down or printed.
const BACKUP_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function generateOneBackupCode(): string {
  const bytes = randomBytes(10);
  let code = "";
  for (let i = 0; i < 10; i++) {
    code += BACKUP_CODE_ALPHABET[bytes[i] % BACKUP_CODE_ALPHABET.length];
    if (i === 4) code += "-";
  }
  return code;
}

export async function generateBackupCodes(): Promise<{ plaintext: string[]; hashed: string[] }> {
  const plaintext = Array.from({ length: BACKUP_CODE_COUNT }, generateOneBackupCode);
  const hashed = await Promise.all(plaintext.map((code) => bcrypt.hash(code, 10)));
  return { plaintext, hashed };
}

// Checks a candidate code against every stored hash (there are at most
// BACKUP_CODE_COUNT of them, so this is cheap) and returns the index of the
// one that matched so the caller can remove just that one — a used backup
// code is single-use.
export async function findMatchingBackupCode(hashedCodes: string[], candidate: string): Promise<number> {
  for (let i = 0; i < hashedCodes.length; i++) {
    if (await bcrypt.compare(candidate.trim().toUpperCase(), hashedCodes[i])) return i;
  }
  return -1;
}

const MFA_PENDING_EXPIRY = "5m";

// Issued by POST /auth/login in place of a real session token when the
// account has MFA configured — carries no more authority than "this
// specific user recently proved their password," and is explicitly
// rejected by the normal `authenticate` decorator (see server.ts) so it can
// never be used to hit a protected endpoint on its own. webauthnChallenge
// is added by the webauthn/options step and echoed back by webauthn/verify
// instead of keeping any server-side challenge store.
export function signMfaPendingToken(app: FastifyInstance, userId: string, webauthnChallenge?: string): string {
  return app.jwt.sign({ sub: userId, purpose: "mfa_pending", webauthnChallenge }, { expiresIn: MFA_PENDING_EXPIRY });
}

export function verifyMfaPendingToken(app: FastifyInstance, token: string): { userId: string; webauthnChallenge?: string } {
  const decoded = app.jwt.verify<{ sub: string; purpose: string; webauthnChallenge?: string }>(token);
  if (decoded.purpose !== "mfa_pending") throw new Error("not an mfa-pending token");
  return { userId: decoded.sub, webauthnChallenge: decoded.webauthnChallenge };
}

// Same shape as the login-time mfa-pending token, but for the *management*
// flow (POST /mfa/webauthn/register/options → .../verify) — the user is
// already fully authenticated there, this only carries the registration
// ceremony's challenge across the two requests.
export function signWebauthnRegChallenge(app: FastifyInstance, userId: string, challenge: string): string {
  return app.jwt.sign({ sub: userId, purpose: "webauthn_reg_pending", challenge }, { expiresIn: MFA_PENDING_EXPIRY });
}

export function verifyWebauthnRegChallenge(app: FastifyInstance, token: string): { userId: string; challenge: string } {
  const decoded = app.jwt.verify<{ sub: string; purpose: string; challenge: string }>(token);
  if (decoded.purpose !== "webauthn_reg_pending") throw new Error("not a webauthn-registration token");
  return { userId: decoded.sub, challenge: decoded.challenge };
}

// The RP ID/origin WebAuthn ceremonies are bound to has to be this
// instance's own real public domain — there's no config for it (every
// other public-URL setting, LIVEKIT_URL/MINIO_PUBLIC_URL, is scoped to its
// own service, not "the app's own address"). Derived from the browser's own
// Origin header instead: Caddy forwards it unmodified end-to-end in the
// documented reverse-proxy deployment, it's not attacker-forgeable (browsers
// set it authoritatively, and a forged one still can't produce a valid
// authenticator signature over it), and it works unmodified in local dev
// where the web client and API are on different ports/origins.
export function getRpConfig(req: FastifyRequest): { rpID: string; origin: string } {
  const originHeader = req.headers.origin;
  if (typeof originHeader === "string") {
    try {
      const url = new URL(originHeader);
      return { rpID: url.hostname, origin: url.origin };
    } catch {
      // fall through to the Host-header fallback below
    }
  }
  const host = req.headers.host ?? "localhost";
  return { rpID: host.split(":")[0], origin: `${req.protocol}://${host}` };
}
