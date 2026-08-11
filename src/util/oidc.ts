// OpenID Connect single sign-on, for instances fronted by Authentik,
// Authelia, Keycloak, Zitadel, Okta, Entra or anything else that speaks
// standard OIDC discovery.
//
// Authorization Code flow with PKCE. Configured entirely from the
// environment rather than the database: the client secret is a deployment
// credential like DATABASE_URL or LIVEKIT_API_SECRET, and putting it in a
// settings table would mean an instance-settings read is enough to walk off
// with it. It also means SSO is configured the same way as everything else
// a self-hoster already sets up in their compose file.
//
// Deliberately no new dependency. ID token signatures are verified with
// node:crypto against the provider's published JWKS -- adding `jose` for
// this would be a backend dependency change, and one of those has already
// taken this app down once by resolving to something the image's Node
// couldn't run.
import { createHash, createPublicKey, createVerify, randomBytes, timingSafeEqual } from "node:crypto";
// node:crypto's JsonWebKey, not the DOM lib's -- they are structurally
// different types with the same name, and createPublicKey only accepts this one.
import type { JsonWebKey } from "node:crypto";
import { request } from "undici";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  displayName: string;
  scopes: string;
  allowSignup: boolean;
}

interface ProviderMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

export interface OidcClaims {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  preferredUsername: string | null;
  name: string | null;
}

export function oidcConfig(): OidcConfig | null {
  const issuer = process.env.OIDC_ISSUER?.trim();
  const clientId = process.env.OIDC_CLIENT_ID?.trim();
  const clientSecret = process.env.OIDC_CLIENT_SECRET?.trim();
  if (!issuer || !clientId || !clientSecret) return null;
  return {
    // Trailing slashes are the single most common copy-paste difference
    // between what's in a compose file and what the provider actually puts
    // in the `iss` claim, and a mismatch there rejects every login with a
    // message that sounds like a signature problem.
    issuer: issuer.replace(/\/+$/, ""),
    clientId,
    clientSecret,
    displayName: process.env.OIDC_DISPLAY_NAME?.trim() || "SSO",
    scopes: process.env.OIDC_SCOPES?.trim() || "openid profile email",
    // Default on: the point of pointing an instance at an identity provider
    // is that the provider decides who gets in. A self-hoster who wants the
    // IdP for existing members only sets this to false.
    allowSignup: process.env.OIDC_ALLOW_SIGNUP !== "false",
  };
}

// http is refused outright rather than warned about. Every leg of this flow
// carries either a client secret or an authorization code, and the ID token
// signature check assumes the JWKS came from the real provider -- none of
// which survives a plaintext hop. localhost is the exception, because that
// is how anyone testing against a local IdP will run it.
export function issuerIsSecure(issuer: string): boolean {
  try {
    const url = new URL(issuer);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

let cachedMetadata: { issuer: string; fetchedAt: number; value: ProviderMetadata } | null = null;
let cachedJwks: { uri: string; fetchedAt: number; keys: JsonWebKey[] } | null = null;
const METADATA_TTL_MS = 60 * 60 * 1000;
// Keys are refetched far more eagerly than metadata: providers rotate
// signing keys on their own schedule, and a stale JWKS means every login
// fails until the cache happens to expire.
const JWKS_TTL_MS = 10 * 60 * 1000;

async function getJson(url: string): Promise<unknown> {
  const res = await request(url, { method: "GET", headers: { accept: "application/json" } });
  if (res.statusCode >= 400) {
    throw new Error(`${url} responded ${res.statusCode}`);
  }
  return res.body.json();
}

export async function providerMetadata(config: OidcConfig): Promise<ProviderMetadata> {
  const now = Date.now();
  if (cachedMetadata && cachedMetadata.issuer === config.issuer && now - cachedMetadata.fetchedAt < METADATA_TTL_MS) {
    return cachedMetadata.value;
  }
  const doc = (await getJson(`${config.issuer}/.well-known/openid-configuration`)) as ProviderMetadata;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error("provider discovery document is missing required endpoints");
  }
  // The discovery document states its own issuer, and it must match the one
  // configured here -- otherwise a compromised or misconfigured discovery
  // URL could point token exchange at somebody else's provider while every
  // later `iss` check still passed against whatever it claimed to be.
  if (doc.issuer.replace(/\/+$/, "") !== config.issuer) {
    throw new Error(`provider issuer ${doc.issuer} does not match configured OIDC_ISSUER`);
  }
  cachedMetadata = { issuer: config.issuer, fetchedAt: now, value: doc };
  return doc;
}

async function signingKeys(jwksUri: string, forceRefresh = false): Promise<JsonWebKey[]> {
  const now = Date.now();
  if (!forceRefresh && cachedJwks && cachedJwks.uri === jwksUri && now - cachedJwks.fetchedAt < JWKS_TTL_MS) {
    return cachedJwks.keys;
  }
  const doc = (await getJson(jwksUri)) as { keys?: JsonWebKey[] };
  const keys = doc.keys ?? [];
  cachedJwks = { uri: jwksUri, fetchedAt: now, keys };
  return keys;
}

export function newPkcePair() {
  // 32 random bytes, base64url -- comfortably inside RFC 7636's 43..128
  // character range for a verifier.
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function authorizeUrl(
  metadata: ProviderMetadata,
  config: OidcConfig,
  args: { redirectUri: string; state: string; nonce: string; codeChallenge: string },
): string {
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("state", args.state);
  url.searchParams.set("nonce", args.nonce);
  url.searchParams.set("code_challenge", args.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeCode(
  metadata: ProviderMetadata,
  config: OidcConfig,
  args: { code: string; redirectUri: string; codeVerifier: string },
): Promise<{ idToken: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    code_verifier: args.codeVerifier,
    client_id: config.clientId,
  });
  const res = await request(metadata.token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      // client_secret_basic. Sent in the header rather than the body
      // because it's the method providers are required to support, and
      // several (Keycloak's default client config among them) reject
      // client_secret_post outright.
      authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
    },
    body: body.toString(),
  });
  const payload = (await res.body.json()) as { id_token?: string; error?: string; error_description?: string };
  if (res.statusCode >= 400 || !payload.id_token) {
    throw new Error(payload.error_description || payload.error || `token endpoint responded ${res.statusCode}`);
  }
  return { idToken: payload.id_token };
}

interface JwtHeader {
  alg: string;
  kid?: string;
}

interface IdTokenPayload {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  iat?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  preferred_username?: string;
  name?: string;
}

function decodeSegment<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
}

// Maps a JWS algorithm to what node:crypto needs to verify it. Only the
// asymmetric families are here on purpose: HS256 would mean the client
// secret doubles as the signing key, so anyone holding it (including this
// server) could mint an ID token for any user, and providers offering it
// are configured wrong for this flow.
const ALGORITHMS: Record<string, { hash: string; keyType: string; dsaEncoding?: "ieee-p1363" }> = {
  RS256: { hash: "sha256", keyType: "RSA" },
  RS384: { hash: "sha384", keyType: "RSA" },
  RS512: { hash: "sha512", keyType: "RSA" },
  PS256: { hash: "sha256", keyType: "RSA" },
  ES256: { hash: "sha256", keyType: "EC", dsaEncoding: "ieee-p1363" },
  ES384: { hash: "sha384", keyType: "EC", dsaEncoding: "ieee-p1363" },
};

function verifySignature(token: string, header: JwtHeader, keys: JsonWebKey[]): boolean {
  const spec = ALGORITHMS[header.alg];
  if (!spec) return false;
  const [headerB64, payloadB64, signatureB64] = token.split(".");
  const signature = Buffer.from(signatureB64, "base64url");
  const signedContent = `${headerB64}.${payloadB64}`;

  // A `kid` narrows it to one key; without one, every key of the right type
  // is tried, which is what a provider publishing an unkeyed JWKS expects.
  const candidates = keys.filter((key) => {
    if (key.kty !== spec.keyType) return false;
    if (header.kid && (key as { kid?: string }).kid) return (key as { kid?: string }).kid === header.kid;
    return true;
  });

  for (const jwk of candidates) {
    try {
      const publicKey = createPublicKey({ key: jwk, format: "jwk" });
      const verifier = createVerify(spec.hash);
      verifier.update(signedContent);
      verifier.end();
      const options: Parameters<typeof verifier.verify>[0] = spec.dsaEncoding
        ? { key: publicKey, dsaEncoding: spec.dsaEncoding }
        : header.alg.startsWith("PS")
          ? { key: publicKey, padding: 1 << 6 /* RSA_PKCS1_PSS_PADDING */ }
          : publicKey;
      if (verifier.verify(options, signature)) return true;
    } catch {
      // A key this token wasn't signed with -- keep trying the rest.
    }
  }
  return false;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// Full validation per OIDC Core 3.1.3.7: signature, issuer, audience,
// expiry and the nonce that binds this token to the authorization request
// this server started. A token that fails any of these is not a login.
export async function verifyIdToken(
  idToken: string,
  config: OidcConfig,
  metadata: ProviderMetadata,
  expectedNonce: string,
): Promise<OidcClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed ID token");
  const header = decodeSegment<JwtHeader>(parts[0]);
  const payload = decodeSegment<IdTokenPayload>(parts[1]);

  let keys = await signingKeys(metadata.jwks_uri);
  if (!verifySignature(idToken, header, keys)) {
    // One forced refetch before giving up: a provider that has just rotated
    // its signing key would otherwise fail every login until the cache TTL
    // expired on its own.
    keys = await signingKeys(metadata.jwks_uri, true);
    if (!verifySignature(idToken, header, keys)) {
      throw new Error("ID token signature could not be verified");
    }
  }

  if ((payload.iss ?? "").replace(/\/+$/, "") !== config.issuer) {
    throw new Error("ID token issuer mismatch");
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!audiences.includes(config.clientId)) {
    throw new Error("ID token audience mismatch");
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) {
    throw new Error("ID token has expired");
  }
  if (!payload.nonce || !constantTimeEquals(payload.nonce, expectedNonce)) {
    throw new Error("ID token nonce mismatch");
  }
  if (!payload.sub) {
    throw new Error("ID token has no subject");
  }

  return {
    subject: payload.sub,
    email: payload.email ?? null,
    // Some providers send this as the string "true" rather than a boolean.
    // Anything else -- including absent -- counts as unverified, because
    // this flag is what decides whether an existing local account can be
    // claimed by matching email.
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
    preferredUsername: payload.preferred_username ?? null,
    name: payload.name ?? null,
  };
}

// Turns whatever the provider calls someone into something this app's own
// username rules accept (3-32 chars, and unique). Falls back through
// preferred_username -> email local part -> name -> "user", then appends a
// counter until it doesn't collide.
export async function deriveUsername(
  claims: OidcClaims,
  isTaken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const raw = claims.preferredUsername || claims.email?.split("@")[0] || claims.name || "user";
  const cleaned = raw
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 32);
  const base = cleaned.length >= 3 ? cleaned : `user${cleaned}`.slice(0, 32);

  if (!(await isTaken(base))) return base;
  for (let suffix = 2; suffix < 1000; suffix++) {
    // Truncate the base, not the suffix -- a name trimmed to fit still has
    // to leave room for what makes it unique.
    const candidate = `${base.slice(0, 32 - String(suffix).length)}${suffix}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error("could not derive an available username");
}

export function hashExchangeCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}
