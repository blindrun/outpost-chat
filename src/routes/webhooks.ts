import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "../plugins/db.js";
import { PERMISSIONS, hasPermission } from "../util/permissions.js";
import { broadcastAll } from "../gateway/rooms.js";

const createWebhookSchema = z.object({
  name: z.string().min(1).max(64),
  avatarUrl: z.string().url().optional(),
});

const executeWebhookSchema = z.object({
  content: z.string().min(1).max(4000).optional(),
  attachmentUrl: z.string().url().optional(),
  // Per-message overrides, matching the Discord/Slack webhook convention —
  // useful for a bot that posts as different "personas" without needing a
  // separate webhook for each.
  username: z.string().min(1).max(64).optional(),
  avatarUrl: z.string().url().optional(),
});

function publicWebhook(webhook: { id: string; channelId: string; name: string; avatarUrl: string | null; token: string; createdAt: Date }) {
  return {
    id: webhook.id,
    channelId: webhook.channelId,
    name: webhook.name,
    avatarUrl: webhook.avatarUrl,
    token: webhook.token,
    createdAt: webhook.createdAt,
  };
}

export async function webhookRoutes(app: FastifyInstance) {
  // Management endpoints — same MANAGE_CHANNELS gate as creating/renaming
  // channels, since a webhook is scoped to (and can only post into) one.
  app.post("/channels/:channelId/webhooks", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    if (!(await hasPermission(userId, PERMISSIONS.MANAGE_CHANNELS))) {
      return reply.status(403).send({ error: "missing MANAGE_CHANNELS permission" });
    }
    const { channelId } = req.params as { channelId: string };
    const channel = await prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) return reply.status(404).send({ error: "channel not found" });
    // Webhook execution broadcasts to every connected user (see below) —
    // pointing one at a DM channel would leak that private conversation
    // instance-wide the moment it fires.
    if (channel.type === "DM") return reply.status(400).send({ error: "cannot create a webhook in a direct message" });

    const body = createWebhookSchema.parse(req.body);
    const webhook = await prisma.webhook.create({
      data: {
        channelId,
        name: body.name,
        avatarUrl: body.avatarUrl,
        token: randomBytes(32).toString("hex"),
        createdBy: userId,
      },
    });
    return publicWebhook(webhook);
  });

  app.get("/channels/:channelId/webhooks", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    if (!(await hasPermission(userId, PERMISSIONS.MANAGE_CHANNELS))) {
      return reply.status(403).send({ error: "missing MANAGE_CHANNELS permission" });
    }
    const { channelId } = req.params as { channelId: string };
    const webhooks = await prisma.webhook.findMany({ where: { channelId }, orderBy: { createdAt: "asc" } });
    return webhooks.map(publicWebhook);
  });

  app.delete("/webhooks/:id", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    if (!(await hasPermission(userId, PERMISSIONS.MANAGE_CHANNELS))) {
      return reply.status(403).send({ error: "missing MANAGE_CHANNELS permission" });
    }
    const { id } = req.params as { id: string };
    await prisma.webhook.delete({ where: { id } }).catch(() => null);
    return reply.status(204).send();
  });

  // Execute — deliberately NOT behind app.authenticate. The token in the URL
  // *is* the credential, same as Discord/Slack incoming webhooks; anything
  // holding it is trusted to post as this webhook into its one channel.
  app.post("/webhooks/:id/:token", async (req, reply) => {
    const { id, token } = req.params as { id: string; token: string };
    const webhook = await prisma.webhook.findUnique({ where: { id } });
    if (!webhook || webhook.token !== token) {
      return reply.status(404).send({ error: "webhook not found" });
    }

    const body = executeWebhookSchema.parse(req.body);
    if (!body.content?.trim() && !body.attachmentUrl) {
      return reply.status(400).send({ error: "message must have content or an attachment" });
    }

    const message = await prisma.message.create({
      data: {
        channelId: webhook.channelId,
        webhookId: webhook.id,
        content: body.content ?? "",
        attachmentUrl: body.attachmentUrl,
      },
    });

    broadcastAll({
      type: "MESSAGE_CREATE",
      message: {
        ...message,
        authorUsername: body.username ?? webhook.name,
        authorAvatarUrl: body.avatarUrl ?? webhook.avatarUrl,
        isWebhook: true,
      },
    });

    return reply.status(204).send();
  });
}
