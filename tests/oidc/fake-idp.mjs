// A minimal but honest OIDC provider: real discovery document, real PKCE
// verification at the token endpoint, real RS256 ID tokens signed with a key
// it publishes over JWKS. Exists so the whole Outpost flow can be driven
// end to end without an Authentik install.
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.IDP_PORT || 39190);
const ISSUER = `http://127.0.0.1:${PORT}`;
const CLIENT_ID = process.env.IDP_CLIENT_ID || "outpost";
const CLIENT_SECRET = process.env.IDP_CLIENT_SECRET || "outpost-secret";
const SUBJECT = process.env.IDP_SUBJECT || "user-abc-123";
const EMAIL = process.env.IDP_EMAIL || "sso.person@example.com";
const EMAIL_VERIFIED = process.env.IDP_EMAIL_VERIFIED !== "false";
const PREFERRED_USERNAME = process.env.IDP_USERNAME || "sso.person";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "fake-idp-1";
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: KID, use: "sig", alg: "RS256" }] };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const pending = new Map();

function idToken(nonce) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = b64({
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: SUBJECT,
    exp: now + 300,
    iat: now,
    nonce,
    email: EMAIL,
    email_verified: EMAIL_VERIFIED,
    preferred_username: PREFERRED_USERNAME,
    name: "SSO Person",
  });
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, ISSUER);
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/.well-known/openid-configuration") {
    return json(200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
    });
  }

  if (url.pathname === "/jwks") return json(200, jwks);

  if (url.pathname === "/authorize") {
    // A real provider would authenticate the user here. This one assumes
    // that already happened and bounces straight back with a code.
    const code = `code-${Math.random().toString(36).slice(2)}`;
    pending.set(code, {
      nonce: url.searchParams.get("nonce"),
      codeChallenge: url.searchParams.get("code_challenge"),
      redirectUri: url.searchParams.get("redirect_uri"),
    });
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }

  if (url.pathname === "/token" && req.method === "POST") {
    const auth = req.headers.authorization || "";
    const [id, secret] = Buffer.from(auth.replace(/^Basic /, ""), "base64").toString().split(":");
    if (id !== CLIENT_ID || secret !== CLIENT_SECRET) {
      return json(401, { error: "invalid_client" });
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    const record = pending.get(form.get("code"));
    if (!record) return json(400, { error: "invalid_grant", error_description: "unknown code" });
    pending.delete(form.get("code"));
    // Real PKCE check — a client that sent the wrong verifier fails here,
    // which is the whole reason PKCE is in the flow.
    const verifier = form.get("code_verifier") || "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (challenge !== record.codeChallenge) {
      return json(400, { error: "invalid_grant", error_description: "PKCE verifier mismatch" });
    }
    if (form.get("redirect_uri") !== record.redirectUri) {
      return json(400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
    }
    return json(200, {
      access_token: "fake-access-token",
      token_type: "Bearer",
      expires_in: 300,
      id_token: idToken(record.nonce),
    });
  }

  json(404, { error: "not_found" });
});

server.listen(PORT, "127.0.0.1", () => console.log(`fake IdP on ${ISSUER}`));
