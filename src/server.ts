import "dotenv/config";
import Fastify from "fastify";
import fastifyJwt from "@fastify/jwt";
import fastifyWebsocket from "@fastify/websocket";
import fastifyCors from "@fastify/cors";
import { authRoutes } from "./routes/auth.js";
import { serverRoutes } from "./routes/servers.js";
import { messageRoutes } from "./routes/messages.js";
import { voiceRoutes } from "./routes/voice.js";
import { gatewayRoutes } from "./gateway/index.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
  }
}

const app = Fastify({ logger: true });

app.register(fastifyCors, { origin: process.env.CORS_ORIGIN ?? "http://localhost:5173" });
app.register(fastifyJwt, { secret: process.env.JWT_SECRET ?? "insecure-dev-secret" });
await app.register(fastifyWebsocket);

app.decorate("authenticate", async (req, reply) => {
  try {
    await req.jwtVerify();
  } catch {
    reply.status(401).send({ error: "unauthorized" });
  }
});

app.get("/health", async () => ({ ok: true }));

app.register(authRoutes);
app.register(serverRoutes);
app.register(messageRoutes);
app.register(voiceRoutes);
app.register(gatewayRoutes);

const port = Number(process.env.PORT ?? 8080);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
