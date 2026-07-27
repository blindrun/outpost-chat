import "dotenv/config";
import Fastify from "fastify";
import fastifyJwt from "@fastify/jwt";
import { authRoutes } from "./routes/auth.js";
import { serverRoutes } from "./routes/servers.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
  }
}

const app = Fastify({ logger: true });

app.register(fastifyJwt, { secret: process.env.JWT_SECRET ?? "insecure-dev-secret" });

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

const port = Number(process.env.PORT ?? 8080);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
