import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "../plugins/db.js";
import { getGuild, DiscordAuthError, DiscordAccessError, DiscordNotFoundError } from "../util/discordApi.js";
import { createImportJob, getImportJob, runDiscordImport } from "../util/discordImport.js";

const startImportSchema = z.object({
  botToken: z.string().min(1),
  guildId: z.string().min(1),
  importChannels: z.boolean(),
  importRoles: z.boolean(),
  importEmoji: z.boolean(),
  importMessages: z.boolean(),
});

// A one-time structural operation like /instance/settings, not a granular
// day-to-day capability -- owner-only rather than a Permission flag.
export async function adminImportRoutes(app: FastifyInstance) {
  app.post("/admin/import/discord", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.isOwner) return reply.status(403).send({ error: "only the instance owner can run a Discord import" });

    const body = startImportSchema.parse(req.body);

    // Cheap validation ping before starting a real (potentially long-
    // running) job, so a bad token/guild id/missing bot comes back as a
    // clear 400 instead of a job that immediately errors out.
    try {
      await getGuild(body.botToken, body.guildId);
    } catch (err) {
      if (err instanceof DiscordAuthError || err instanceof DiscordAccessError || err instanceof DiscordNotFoundError) {
        return reply.status(400).send({ error: err.message });
      }
      throw err;
    }

    const jobId = randomUUID();
    createImportJob(jobId);
    // Fire-and-forget -- the job updates its own status in the in-memory
    // map as it progresses; the route returns immediately so the client can
    // start polling. The bot token is used only for the duration of this
    // call and the job below -- never written to the database or logs.
    runDiscordImport(jobId, body.botToken, body.guildId, body, userId).catch((err) => {
      const job = getImportJob(jobId);
      if (job) {
        job.error = (err as Error).message;
        job.done = true;
      }
    });

    return reply.status(202).send({ jobId });
  });

  app.get("/admin/import/discord/:jobId", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.isOwner) return reply.status(403).send({ error: "only the instance owner can view an import's status" });

    const { jobId } = req.params as { jobId: string };
    const job = getImportJob(jobId);
    if (!job) return reply.status(404).send({ error: "no import job with that id" });
    return job;
  });
}
