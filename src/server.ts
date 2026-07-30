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
import { authRoutes } from "./routes/auth.js";
import { instanceRoutes } from "./routes/instance.js";
import { messageRoutes } from "./routes/messages.js";
import { voiceRoutes } from "./routes/voice.js";
import { uploadRoutes } from "./routes/uploads.js";
import { gifRoutes } from "./routes/gifs.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { botRoutes } from "./routes/bot.js";
import { moderationRoutes } from "./routes/moderation.js";
import { gatewayRoutes } from "./gateway/index.js";
import { ensureBucket } from "./plugins/storage.js";
import { ensureClaimCode } from "./util/claim.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
  }
}

const app = Fastify({ logger: true });

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

await ensureBucket();
await ensureClaimCode(app.log);

app.decorate("authenticate", async (req, reply) => {
  try {
    await req.jwtVerify();
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
app.register(webhookRoutes);
app.register(botRoutes);
app.register(moderationRoutes);
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
