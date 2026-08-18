import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { minioClient, BUCKET, PUBLIC_URL, isOwnUploadUrl } from "../plugins/storage.js";
import { prisma } from "../plugins/db.js";
import { toPublicUser } from "./auth.js";
import { categoryForFilename, permissionForCategory } from "../util/uploadCategories.js";
import { hasPermission } from "../util/permissions.js";

// 8MB was fine for avatars/chat images alone, but is barely a couple of
// seconds of real video at any watchable resolution/bitrate — raised to
// 25MB (in the same ballpark as Discord's own free-tier attachment limit)
// now that video is an upload category. Applies to every attachment type
// uniformly rather than a differential per-category cap, for simplicity.
const MAX_SIZE_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME_PREFIXES = ["image/"];

export async function uploadRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  // Generic upload: returns a public URL. Callers (avatar set, message
  // attachment) decide what to do with it — this endpoint doesn't know or
  // care which. Images are always allowed to everyone; anything else must
  // match a curated category (see uploadCategories.ts) AND the uploader
  // needs that category's permission via one of their roles — checked by
  // extension, not mimetype, since browsers report inconsistent mimetypes
  // for non-image files. Extensions matching no category (all native
  // executables) are rejected outright, no permission grants those.
  app.post("/uploads", async (req, reply) => {
    const file = await req.file({ limits: { fileSize: MAX_SIZE_BYTES } });
    if (!file) return reply.status(400).send({ error: "no file provided" });

    const isImage = ALLOWED_MIME_PREFIXES.some((prefix) => file.mimetype.startsWith(prefix));
    if (!isImage) {
      const { sub: userId } = req.user as { sub: string };
      const category = categoryForFilename(file.filename);
      if (!category || !(await hasPermission(userId, permissionForCategory(category)))) {
        return reply.status(403).send({ error: "you don't have permission to upload this file type" });
      }
    }

    const buffer = await file.toBuffer();
    if (buffer.length > MAX_SIZE_BYTES) {
      return reply.status(400).send({ error: `file too large (max ${MAX_SIZE_BYTES / 1024 / 1024}MB)` });
    }

    const { sub: userId } = req.user as { sub: string };
    const key = `${userId}/${randomUUID()}-${file.filename}`;
    await minioClient.putObject(BUCKET, key, buffer, buffer.length, { "Content-Type": file.mimetype });

    return { url: `${PUBLIC_URL}/${key}` };
  });

  app.patch("/auth/me/avatar", async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const { avatarUrl } = req.body as { avatarUrl?: string };
    if (!avatarUrl || !isOwnUploadUrl(avatarUrl)) {
      return reply.status(400).send({ error: "avatarUrl must be a URL returned from /uploads" });
    }
    const user = await prisma.user.update({ where: { id: userId }, data: { avatarUrl } });
    return toPublicUser(user);
  });
}
