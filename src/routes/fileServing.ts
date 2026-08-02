import type { FastifyInstance } from "fastify";
import { minioClient, BUCKET } from "../plugins/storage.js";
import { prisma } from "../plugins/db.js";

const RANGE_PATTERN = /^bytes=(\d+)-(\d*)$/;

// Serves uploaded avatars/attachments/emoji from what is now a *private*
// MinIO bucket (see storage.ts) — replaces the old "just fetch the object
// straight from MinIO, no auth" public-read setup. A leaked/guessed object
// key no longer works forever; every request has to carry a live, non-
// banned session.
//
// Registered as its own plugin, deliberately NOT using the shared
// `app.authenticate` onRequest hook the rest of the API uses — a plain
// <img>/<video> tag can't send an Authorization header, so the token is
// read from a query param instead, the same accepted tradeoff this app's
// gateway WebSocket connection already relies on for the identical reason
// (see gateway/index.ts). The URL *shape* stored in the database is
// unchanged (still `${PUBLIC_URL}/${key}`) — only how it's served changed,
// so no data migration was needed; the client appends `?token=` at render
// time instead (see web/src/api.ts's `authedMediaUrl`).
export async function fileServingRoutes(app: FastifyInstance) {
  app.get(`/${BUCKET}/*`, async (req, reply) => {
    const token = (req.query as { token?: string }).token;
    if (!token) return reply.status(401).send({ error: "unauthorized" });

    let userId: string;
    try {
      const decoded = app.jwt.verify<{ sub: string; purpose?: string }>(token);
      if (decoded.purpose) throw new Error("not a session token");
      userId = decoded.sub;
    } catch {
      return reply.status(401).send({ error: "unauthorized" });
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { banned: true } });
    if (user?.banned) return reply.status(403).send({ error: "banned" });

    const key = (req.params as { "*": string })["*"];

    let stat;
    try {
      stat = await minioClient.statObject(BUCKET, key);
    } catch {
      return reply.status(404).send({ error: "not found" });
    }
    const contentType = stat.metaData["content-type"] ?? "application/octet-stream";

    // Range support matters for real playback of the video attachments
    // added this session — without it, seeking in the <video> player would
    // silently re-download from byte 0 every time instead of jumping.
    const range = req.headers.range;
    const match = typeof range === "string" ? range.match(RANGE_PATTERN) : null;
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
      const stream = await minioClient.getPartialObject(BUCKET, key, start, end - start + 1);
      reply.status(206);
      reply.header("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      reply.header("Accept-Ranges", "bytes");
      reply.header("Content-Length", end - start + 1);
      reply.header("Content-Type", contentType);
      reply.header("Cache-Control", "private, max-age=3600");
      return reply.send(stream);
    }

    const stream = await minioClient.getObject(BUCKET, key);
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Length", stat.size);
    reply.header("Content-Type", contentType);
    reply.header("Cache-Control", "private, max-age=3600");
    return reply.send(stream);
  });
}
