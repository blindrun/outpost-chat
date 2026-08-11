// Exercises the real compiled verifyIdToken against a real JWKS served over
// a real socket, with real RSA/EC signatures. The point is the NEGATIVE
// cases: a check that only proves a good token passes would still pass if
// signature verification were skipped entirely.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Resolved from this file rather than hardcoded, so the suite runs from any
// checkout and any working directory.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

import { createSign, generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";
import { createServer } from "node:http";

const { verifyIdToken } = await import(join(repoRoot, "dist/util/oidc.js"));

const ISSUER_PORT = 39181;
const CLIENT_ID = "outpost-test-client";
const NONCE = "nonce-from-the-auth-request";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });

function jwkOf(publicKey, kid) {
  return { ...publicKey.export({ format: "jwk" }), kid, use: "sig" };
}

const jwks = { keys: [jwkOf(rsa.publicKey, "rsa-1"), jwkOf(ec.publicKey, "ec-1")] };

// An attacker-controlled key that is NOT in the JWKS.
const rogue = generateKeyPairSync("rsa", { modulusLength: 2048 });

const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(jwks));
});
await new Promise((r) => server.listen(ISSUER_PORT, "127.0.0.1", r));

const issuer = `http://127.0.0.1:${ISSUER_PORT}`;
const config = { issuer, clientId: CLIENT_ID };
const metadata = { jwks_uri: `${issuer}/jwks` };

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

function sign(header, payload, key, alg = "RSA-SHA256") {
  const content = `${b64(header)}.${b64(payload)}`;
  const signer = createSign(alg);
  signer.update(content);
  signer.end();
  const sig = signer.sign(key).toString("base64url");
  return `${content}.${sig}`;
}

function basePayload(overrides = {}) {
  return {
    iss: issuer,
    aud: CLIENT_ID,
    sub: "idp-subject-123",
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
    nonce: NONCE,
    email: "person@example.com",
    email_verified: true,
    preferred_username: "person",
    ...overrides,
  };
}

const results = [];
async function expectPass(name, token, check) {
  try {
    const claims = await verifyIdToken(token, config, metadata, NONCE);
    const ok = check ? check(claims) : true;
    results.push([name, ok, ok ? "" : `claims wrong: ${JSON.stringify(claims)}`]);
  } catch (err) {
    results.push([name, false, `threw: ${err.message}`]);
  }
}
async function expectReject(name, token, nonce = NONCE) {
  try {
    await verifyIdToken(token, config, metadata, nonce);
    results.push([name, false, "ACCEPTED a token it must reject"]);
  } catch (err) {
    results.push([name, true, `rejected: ${err.message}`]);
  }
}

// --- must pass ---
await expectPass(
  "valid RS256 token",
  sign({ alg: "RS256", kid: "rsa-1", typ: "JWT" }, basePayload(), rsa.privateKey),
  (c) => c.subject === "idp-subject-123" && c.email === "person@example.com" && c.emailVerified === true,
);
await expectPass(
  "valid ES256 token",
  sign({ alg: "ES256", kid: "ec-1", typ: "JWT" }, basePayload(), { key: ec.privateKey, dsaEncoding: "ieee-p1363" }, "SHA256"),
  (c) => c.subject === "idp-subject-123",
);
await expectPass(
  'email_verified as the string "true"',
  sign({ alg: "RS256", kid: "rsa-1" }, basePayload({ email_verified: "true" }), rsa.privateKey),
  (c) => c.emailVerified === true,
);
await expectPass(
  "aud as an array containing the client id",
  sign({ alg: "RS256", kid: "rsa-1" }, basePayload({ aud: ["other-client", CLIENT_ID] }), rsa.privateKey),
  (c) => c.subject === "idp-subject-123",
);
await expectPass(
  "trailing slash on iss",
  sign({ alg: "RS256", kid: "rsa-1" }, basePayload({ iss: `${issuer}/` }), rsa.privateKey),
  (c) => c.subject === "idp-subject-123",
);

// --- must be rejected ---
{
  // Tampered payload: signed correctly, then the subject swapped.
  const good = sign({ alg: "RS256", kid: "rsa-1" }, basePayload(), rsa.privateKey);
  const [h, , s] = good.split(".");
  await expectReject("tampered payload (sub swapped)", `${h}.${b64(basePayload({ sub: "attacker" }))}.${s}`);
}
await expectReject(
  "signed by a key not in the JWKS",
  sign({ alg: "RS256", kid: "rsa-1" }, basePayload(), rogue.privateKey),
);
await expectReject(
  "alg: none, empty signature",
  `${b64({ alg: "none" })}.${b64(basePayload())}.`,
);
{
  // HS256 forgery using the JWKS public key as the HMAC secret -- the
  // classic algorithm-confusion attack.
  const { createHmac } = await import("node:crypto");
  const header = b64({ alg: "HS256", kid: "rsa-1" });
  const payload = b64(basePayload());
  const secret = rsa.publicKey.export({ type: "spki", format: "pem" });
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  await expectReject("HS256 algorithm confusion", `${header}.${payload}.${sig}`);
}
await expectReject(
  "wrong audience",
  sign({ alg: "RS256", kid: "rsa-1" }, basePayload({ aud: "some-other-client" }), rsa.privateKey),
);
await expectReject(
  "wrong issuer",
  sign({ alg: "RS256", kid: "rsa-1" }, basePayload({ iss: "https://evil.example.com" }), rsa.privateKey),
);
await expectReject(
  "expired",
  sign({ alg: "RS256", kid: "rsa-1" }, basePayload({ exp: Math.floor(Date.now() / 1000) - 10 }), rsa.privateKey),
);
await expectReject(
  "nonce mismatch (replayed into a different auth request)",
  sign({ alg: "RS256", kid: "rsa-1" }, basePayload(), rsa.privateKey),
  "a-different-nonce",
);
await expectReject(
  "no nonce at all",
  sign({ alg: "RS256", kid: "rsa-1" }, basePayload({ nonce: undefined }), rsa.privateKey),
);
await expectReject(
  "no subject",
  sign({ alg: "RS256", kid: "rsa-1" }, basePayload({ sub: undefined }), rsa.privateKey),
);

server.close();

let failed = 0;
for (const [name, ok, note] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
