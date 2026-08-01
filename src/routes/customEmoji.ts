import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../plugins/db.js";
import { PERMISSIONS, hasPermission } from "../util/permissions.js";
import { PUBLIC_URL } from "../plugins/storage.js";

// Shortcode rules match the :name: pattern MessageItem.tsx's renderInline
// looks for — keep these in sync if either side changes.
const NAME_PATTERN = /^[a-zA-Z0-9_]{2,32}$/;

const createEmojiSchema = z.object({
  name: z.string().regex(NAME_PATTERN, "name must be 2-32 letters, numbers, or underscores"),
  imageUrl: z.string().min(1),
});

export async function customEmojiRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  // Any authenticated user needs the full list to render :name: shortcodes
  // in messages and to search the picker — not just members who manage it.
  app.get("/custom-emoji", async () => {
    return prisma.customEmoji.findMany({ orderBy: { name: "asc" } });
  });

  // Same gate as creating/renaming channels and webhooks — server
  // customization, not a separate granular permission for a feature this
  // small.
  app.post("/custom-emoji", async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    if (!(await hasPermission(userId, PERMISSIONS.MANAGE_CHANNELS))) {
      return reply.status(403).send({ error: "missing MANAGE_CHANNELS permission" });
    }
    const body = createEmojiSchema.parse(req.body);
    if (!body.imageUrl.startsWith(PUBLIC_URL)) {
      return reply.status(400).send({ error: "imageUrl must be a URL returned from /uploads" });
    }

    const name = body.name.toLowerCase();
    const existing = await prisma.customEmoji.findUnique({ where: { name } });
    if (existing) return reply.status(409).send({ error: `:${name}: already exists` });

    const emoji = await prisma.customEmoji.create({
      data: { name, imageUrl: body.imageUrl, createdBy: userId },
    });
    return reply.status(201).send(emoji);
  });

  app.delete("/custom-emoji/:id", async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    if (!(await hasPermission(userId, PERMISSIONS.MANAGE_CHANNELS))) {
      return reply.status(403).send({ error: "missing MANAGE_CHANNELS permission" });
    }
    const { id } = req.params as { id: string };
    await prisma.customEmoji.delete({ where: { id } }).catch(() => null);
    return reply.status(204).send();
  });
}
