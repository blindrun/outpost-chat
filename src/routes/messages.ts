import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../plugins/db.js";

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().optional(),
});

const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  channelId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

// Message has no FK relation to User (authorId is a plain string), so author
// display info (username, avatar) is joined manually here rather than via
// Prisma's `include`. Without this, history-loaded messages showed the raw
// author UUID instead of a username — only live MESSAGE_CREATE broadcasts
// carried it, from the sender's own JWT. Webhook-authored messages
// (authorId null, webhookId set) are joined the same way, from Webhook
// instead of User; built-in-bot messages (isSystemBot true, both null) pull
// the configurable name/avatar from the BotSettings singleton. Shared
// between the history, search, and pins endpoints, and the gateway (for
// reply previews).
export async function hydrateAuthors<T extends { authorId: string | null; webhookId: string | null; isSystemBot?: boolean }>(
  messages: T[],
): Promise<(T & { authorUsername?: string; authorAvatarUrl?: string | null; isWebhook: boolean; isSystemBot: boolean })[]> {
  const authorIds = [...new Set(messages.filter((m) => m.authorId).map((m) => m.authorId as string))];
  const webhookIds = [...new Set(messages.filter((m) => m.webhookId).map((m) => m.webhookId as string))];
  const needsBotSettings = messages.some((m) => m.isSystemBot);
  const [authors, webhooks, botSettings] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, username: true, avatarUrl: true } }),
    prisma.webhook.findMany({ where: { id: { in: webhookIds } }, select: { id: true, name: true, avatarUrl: true } }),
    needsBotSettings ? prisma.botSettings.findUnique({ where: { id: "singleton" } }) : Promise.resolve(null),
  ]);
  const authorById = new Map(authors.map((a) => [a.id, a]));
  const webhookById = new Map(webhooks.map((w) => [w.id, w]));

  return messages.map((m) => {
    if (m.isSystemBot) {
      return {
        ...m,
        authorUsername: botSettings?.name ?? "Bot",
        authorAvatarUrl: botSettings?.avatarUrl ?? null,
        isWebhook: false,
        isSystemBot: true,
      };
    }
    const webhook = m.webhookId ? webhookById.get(m.webhookId) : undefined;
    return {
      ...m,
      authorUsername: webhook?.name ?? authorById.get(m.authorId ?? "")?.username,
      authorAvatarUrl: webhook?.avatarUrl ?? authorById.get(m.authorId ?? "")?.avatarUrl,
      isWebhook: !!webhook,
      isSystemBot: false,
    };
  });
}

const REPLY_PREVIEW_LENGTH = 200;

// Reply targets are fetched via the real `replyTo` Prisma relation (unlike
// author/webhook), but still need their own author hydrated and their
// content trimmed down to a short quote — shared between history and
// search so both show full reply context, not just a dangling replyToId.
export async function hydrateReplyPreviews<
  T extends {
    replyTo: { id: string; content: string; authorId: string | null; webhookId: string | null; isSystemBot?: boolean } | null;
  },
>(
  messages: T[],
): Promise<
  (Omit<T, "replyTo"> & {
    replyTo: { id: string; content: string; authorUsername?: string; isWebhook: boolean; isSystemBot: boolean } | null;
  })[]
> {
  const targets = messages.filter((m): m is T & { replyTo: NonNullable<T["replyTo"]> } => !!m.replyTo).map((m) => m.replyTo);
  const hydratedTargets = await hydrateAuthors(targets);
  const byId = new Map(hydratedTargets.map((t) => [t.id, t]));

  return messages.map((m) => {
    const target = m.replyTo ? byId.get(m.replyTo.id) : undefined;
    return {
      ...m,
      replyTo: target
        ? {
            id: target.id,
            content: target.content.length > REPLY_PREVIEW_LENGTH ? `${target.content.slice(0, REPLY_PREVIEW_LENGTH)}…` : target.content,
            authorUsername: target.authorUsername,
            isWebhook: target.isWebhook,
            isSystemBot: target.isSystemBot,
          }
        : null,
    };
  });
}

export async function messageRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  // Simple case-insensitive substring search across this instance's whole
  // message history, not just whatever's currently loaded in the client —
  // every channel is readable by any authenticated user here (no private
  // channels), so no extra access check is needed beyond authentication.
  app.get("/messages/search", async (req, reply) => {
    const query = searchQuerySchema.parse(req.query);
    if (query.channelId) {
      const channel = await prisma.channel.findUnique({ where: { id: query.channelId } });
      if (!channel) return reply.status(404).send({ error: "channel not found" });
    }

    const messages = await prisma.message.findMany({
      where: {
        content: { contains: query.q, mode: "insensitive" },
        ...(query.channelId ? { channelId: query.channelId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: query.limit,
      include: { channel: { select: { name: true } }, replyTo: true },
    });

    const hydrated = await hydrateAuthors(messages);
    const withReplies = await hydrateReplyPreviews(hydrated);
    return withReplies.map(({ channel, ...m }) => ({ ...m, channelName: channel.name }));
  });

  app.get("/channels/:channelId/messages", async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    const query = historyQuerySchema.parse(req.query);

    const channel = await prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) return reply.status(404).send({ error: "channel not found" });

    let beforeDate: Date | undefined;
    if (query.before) {
      const cursor = await prisma.message.findUnique({ where: { id: query.before } });
      beforeDate = cursor?.createdAt;
    }

    const messages = await prisma.message.findMany({
      where: {
        channelId,
        ...(beforeDate ? { createdAt: { lt: beforeDate } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: query.limit,
      include: {
        reactions: true,
        replyTo: true,
        thread: { include: { _count: { select: { messages: true } } } },
      },
    });

    const hydrated = await hydrateAuthors(messages);
    const withReplies = await hydrateReplyPreviews(hydrated);
    return withReplies
      .map(({ thread, ...m }) => ({
        ...m,
        thread: thread ? { id: thread.id, name: thread.name, messageCount: thread._count.messages } : null,
      }))
      .reverse();
  });

  // Pinned messages for a channel — any authenticated user can view them
  // (same "no private channels" reasoning as search); pinning/unpinning
  // itself is moderator-gated over the gateway, not here.
  app.get("/channels/:channelId/pins", async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    const channel = await prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) return reply.status(404).send({ error: "channel not found" });

    const messages = await prisma.message.findMany({
      where: { channelId, pinned: true },
      orderBy: { createdAt: "desc" },
      include: { reactions: true, replyTo: true },
    });

    const hydrated = await hydrateAuthors(messages);
    return hydrateReplyPreviews(hydrated);
  });
}
