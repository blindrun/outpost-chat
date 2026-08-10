import "dotenv/config";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Fastify from "fastify";
import fastifyJwt from "@fastify/jwt";
import fastifyWebsocket from "@fastify/websocket";
import fastifyCors from "@fastify/cors";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fastifyRateLimit from "@fastify/rate-limit";
import { prisma } from "./plugins/db.js";
import { authRoutes } from "./routes/auth.js";
import { instanceRoutes } from "./routes/instance.js";
import { messageRoutes } from "./routes/messages.js";
import { voiceRoutes } from "./routes/voice.js";
import { uploadRoutes } from "./routes/uploads.js";
import { gifRoutes } from "./routes/gifs.js";
import { linkPreviewRoutes } from "./routes/linkPreview.js";
import { apiBotRoutes } from "./routes/apiBots.js";
import { fileServingRoutes } from "./routes/fileServing.js";
import { customEmojiRoutes } from "./routes/customEmoji.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { botRoutes } from "./routes/bot.js";
import { moderationRoutes } from "./routes/moderation.js";
import { threadRoutes } from "./routes/threads.js";
import { friendRoutes } from "./routes/friends.js";
import { dmRoutes } from "./routes/dms.js";
import { mfaRoutes } from "./routes/mfa.js";
import { adminImportRoutes } from "./routes/adminImport.js";
import { gatewayRoutes } from "./gateway/index.js";
import { ensureBucket } from "./plugins/storage.js";
import { ensureClaimCode } from "./util/claim.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
  }
}

// Needed for WebAuthn's rpID/origin derivation (see util/mfa.ts) to see the
// real client-facing protocol via X-Forwarded-Proto when this app sits
// behind the documented Caddy reverse proxy — without it req.protocol
// always reports "http" even over a real HTTPS deployment. Also fixes
// req.ip (used by Turnstile's remoteip check) reporting the proxy's own
// address instead of the real visitor's for every production request.
const app = Fastify({ logger: true, trustProxy: true });

// @fastify/cors defaults `methods` to "GET,HEAD,POST" only — PATCH/DELETE/PUT
// need to be listed explicitly or the browser's preflight silently blocks them.
//
// Origin is permissive by default: auth here is a bearer JWT, not a cookie,
// so origin isn't a CSRF boundary the way it would be for cookie auth. This
// instance is meant to be reachable from its own web client, other web
// clients on different hosts, and the Electron desktop app (whose origin is
// file:// or a custom scheme, not a fixed domain) — all legitimate callers
// that a fixed single-origin allowlist would otherwise block. Set
// CORS_ORIGIN to a specific origin (or comma-separated list) to restrict it.
const corsOrigin = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : true;
app.register(fastifyCors, {
  origin: corsOrigin,
  methods: ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"],
});
app.register(fastifyJwt, { secret: process.env.JWT_SECRET ?? "insecure-dev-secret" });
await app.register(fastifyWebsocket);
await app.register(fastifyMultipart);
// global: false — this only throttles the specific brute-force-relevant
// auth routes that opt in via their own `config.rateLimit` (login,
// register, MFA code verification), not the API as a whole. A blanket
// global limit would risk throttling normal chat usage (message sends,
// gateway reconnects) for no real security benefit, since those aren't
// guessable-secret endpoints.
await app.register(fastifyRateLimit, { global: false });

await ensureBucket();
await ensureClaimCode(app.log);

app.decorate("authenticate", async (req, reply) => {
  try {
    await req.jwtVerify();
    // Every special-purpose short-lived token this app issues (the
    // MFA-pending token from POST /auth/login, the WebAuthn
    // registration-challenge token from POST /mfa/webauthn/register/options
    // — see util/mfa.ts) carries a `purpose` claim; a real session token
    // never does. Rejecting on presence rather than a specific value means
    // any future purpose-tagged token is automatically excluded here too,
    // not just the ones this check happens to know about today.
    const { sub, purpose } = req.user as { sub: string; purpose?: string };
    if (purpose) {
      reply.status(401).send({ error: "unauthorized" });
      return;
    }
    // Tokens never expire, so a ban has to be checked live on every
    // request rather than only at login — otherwise a banned user's
    // already-issued JWT would keep working indefinitely.
    const user = await prisma.user.findUnique({ where: { id: sub }, select: { banned: true } });
    // The account is gone — self-deleted (DELETE /auth/me) or an API bot the
    // owner removed — while a never-expiring token for it is still in the
    // wild. Without this, that token stayed "valid" here and only blew up
    // further in, where handlers assume their own user row exists (GET
    // /auth/me's findUniqueOrThrow turned it into a 500 instead of a 401,
    // which reads to the client as a server fault rather than a dead
    // session).
    if (!user) {
      reply.status(401).send({ error: "unauthorized" });
      return;
    }
    if (user.banned) {
      reply.status(403).send({ error: "banned" });
      return;
    }
  } catch {
    reply.status(401).send({ error: "unauthorized" });
  }
});

app.get("/health", async () => ({ ok: true }));

app.register(authRoutes);
app.register(instanceRoutes);
app.register(messageRoutes);
app.register(voiceRoutes);
app.register(uploadRoutes);
app.register(gifRoutes);
app.register(linkPreviewRoutes);
app.register(apiBotRoutes);
app.register(fileServingRoutes);
app.register(customEmojiRoutes);
app.register(webhookRoutes);
app.register(botRoutes);
app.register(moderationRoutes);
app.register(threadRoutes);
app.register(friendRoutes);
app.register(dmRoutes);
app.register(mfaRoutes);
app.register(adminImportRoutes);
app.register(gatewayRoutes);

// Serves the built web client (single-container deployment: this backend is
// the whole "app" service). Only present in the production Docker image —
// in local dev the web client runs separately via `vite`, so this directory
// won't exist and the block is skipped entirely.
const webDist = path.join(path.dirname(fileURLToPath(import.meta.url)), "../web-dist");
if (existsSync(webDist)) {
  app.register(fastifyStatic, { root: webDist });
}

const port = Number(process.env.PORT ?? 8080);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
