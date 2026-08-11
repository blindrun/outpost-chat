import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../plugins/db.js";
import { PERMISSIONS, canAccessChannel, hasPermission } from "../util/permissions.js";
import { allOnlineUserIds, sendToUsers } from "../gateway/rooms.js";

// Fixed categories rather than free text alone, so the queue can be triaged
// at a glance and so a reporter doesn't have to articulate what's wrong to
// file a report at all. `detail` stays optional for the rest.
const REPORT_REASONS = [
  "spam",
  "harassment",
  "hate_speech",
  "sexual_content",
  "violence_or_threats",
  "self_harm",
  "other",
] as const;

const createSchema = z
  .object({
    messageId: z.string().optional(),
    targetUserId: z.string().optional(),
    reason: z.enum(REPORT_REASONS),
    detail: z.string().max(1000).optional(),
    // Only read for an encrypted DM message — see Report.contentFromReporter.
    messageContent: z.string().max(4000).optional(),
  })
  .refine((b) => b.messageId || b.targetUserId, {
    message: "a report needs either a messageId or a targetUserId",
  });

const listQuerySchema = z.object({
  status: z.enum(["OPEN", "RESOLVED", "DISMISSED", "ALL"]).default("OPEN"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

async function requireModerator(userId: string) {
  return hasPermission(userId, PERMISSIONS.MODERATE_MEMBERS);
}

// A report is worthless if nobody sees it in time, and moderators have no
// reason to sit on the settings modal refreshing a queue. Same shape as
// broadcastToChannel's per-recipient permission check: resolved live rather
// than cached, since roles change.
async function notifyModerators(payload: unknown) {
  const online = allOnlineUserIds();
  const mods: string[] = [];
  for (const uid of online) {
    if (await requireModerator(uid)) mods.push(uid);
  }
  if (mods.length > 0) sendToUsers(mods, payload);
}

export async function reportRoutes(app: FastifyInstance) {
  // Rate-limited like the auth routes rather than left open: filing a report
  // is a write any member can perform against any other member, which is
  // exactly the shape of thing that gets used to flood a moderator queue.
  app.post(
    "/reports",
    { onRequest: [app.authenticate], config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    async (req, reply) => {
      const { sub: reporterId } = req.user as { sub: string };
      const body = createSchema.parse(req.body);

      let targetUserId = body.targetUserId ?? null;
      let channelId: string | null = null;
      let messageContent: string | null = null;
      let contentFromReporter = false;

      if (body.messageId) {
        const message = await prisma.message.findUnique({
          where: { id: body.messageId },
          include: { channel: true },
        });
        if (!message) return reply.status(404).send({ error: "message not found" });

        // Reporting is not a way to read a channel you can't otherwise see:
        // the same access checks the history endpoint applies, applied here
        // before anything about the message is echoed back or stored.
        if (message.channel.type === "DM") {
          const participant = await prisma.dMParticipant.findUnique({
            where: { channelId_userId: { channelId: message.channelId, userId: reporterId } },
          });
          if (!participant) return reply.status(404).send({ error: "message not found" });
        } else if (!(await canAccessChannel(reporterId, message.channel))) {
          return reply.status(404).send({ error: "message not found" });
        }

        if (!message.authorId) {
          return reply
            .status(400)
            .send({ error: "this message wasn't sent by a member — report the member who set up the webhook or bot instead" });
        }

        targetUserId = message.authorId;
        channelId = message.channelId;
        if (message.encryptedPayload) {
          // The server has no plaintext to snapshot here and never will.
          messageContent = body.messageContent ?? null;
          contentFromReporter = messageContent !== null;
        } else {
          messageContent = message.content;
        }
      }

      if (!targetUserId) return reply.status(400).send({ error: "a report needs either a messageId or a targetUserId" });
      if (targetUserId === reporterId) return reply.status(400).send({ error: "you can't report yourself" });

      const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, username: true } });
      if (!target) return reply.status(404).send({ error: "user not found" });

      // Filing the same report twice (double-tap, or reporting one message
      // repeatedly) returns the existing open one instead of stacking
      // duplicates in the queue. Scoped to this reporter, so two different
      // people reporting the same message still produce two reports — that
      // count is signal a moderator wants.
      const duplicate = await prisma.report.findFirst({
        where: {
          reporterId,
          status: "OPEN",
          ...(body.messageId ? { messageId: body.messageId } : { targetUserId, messageId: null }),
        },
      });
      if (duplicate) return reply.status(200).send({ id: duplicate.id, alreadyReported: true });

      const report = await prisma.report.create({
        data: {
          reporterId,
          targetUserId,
          messageId: body.messageId ?? null,
          channelId,
          messageContent,
          contentFromReporter,
          reason: body.reason,
          detail: body.detail,
        },
      });

      const reporter = await prisma.user.findUnique({ where: { id: reporterId }, select: { username: true } });
      await notifyModerators({
        type: "REPORT_CREATE",
        report: {
          id: report.id,
          reason: report.reason,
          reporterUsername: reporter?.username ?? "unknown user",
          targetUsername: target.username,
          createdAt: report.createdAt,
        },
      });

      return reply.status(201).send({ id: report.id, alreadyReported: false });
    },
  );

  // The moderator queue. Gated on MODERATE_MEMBERS like the rest of
  // routes/moderation.ts, and hydrated with usernames the same way the audit
  // log is, so the client needs one call rather than a cross-reference.
  app.get("/reports", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    if (!(await requireModerator(userId))) {
      return reply.status(403).send({ error: "missing MODERATE_MEMBERS permission" });
    }
    const query = listQuerySchema.parse(req.query);

    const reports = await prisma.report.findMany({
      where: query.status === "ALL" ? {} : { status: query.status },
      orderBy: { createdAt: "desc" },
      take: query.limit,
    });

    const userIds = [
      ...new Set(reports.flatMap((r) => [r.reporterId, r.targetUserId, ...(r.handledById ? [r.handledById] : [])])),
    ];
    const [users, channels] = await Promise.all([
      prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true, banned: true } }),
      prisma.channel.findMany({
        where: { id: { in: [...new Set(reports.flatMap((r) => (r.channelId ? [r.channelId] : [])))] } },
        select: { id: true, name: true, type: true },
      }),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const channelById = new Map(channels.map((c) => [c.id, c]));

    // Counted across the whole table, not just this page, so a moderator
    // sees "3 open" even while looking at the resolved list.
    const openCount = await prisma.report.count({ where: { status: "OPEN" } });

    return {
      openCount,
      reports: reports.map((r) => {
        const channel = r.channelId ? channelById.get(r.channelId) : undefined;
        return {
          id: r.id,
          reason: r.reason,
          detail: r.detail,
          status: r.status,
          createdAt: r.createdAt,
          handledAt: r.handledAt,
          handledByUsername: r.handledById ? userById.get(r.handledById)?.username ?? "unknown user" : null,
          reporterId: r.reporterId,
          reporterUsername: userById.get(r.reporterId)?.username ?? "unknown user",
          targetUserId: r.targetUserId,
          targetUsername: userById.get(r.targetUserId)?.username ?? "unknown user",
          targetBanned: userById.get(r.targetUserId)?.banned ?? false,
          messageId: r.messageId,
          // A DM's generated name is `dm-<uuid>-<uuid>` (see routes/dms.ts),
          // which tells a moderator nothing — say what it actually was.
          channelName: channel ? (channel.type === "DM" ? "a direct message" : channel.name) : null,
          messageContent: r.messageContent,
          contentFromReporter: r.contentFromReporter,
        };
      }),
    };
  });

  // Resolve = acted on it, dismiss = no action needed. Both close the report
  // and both leave an audit-log entry, because "which moderator decided this
  // report was nothing" is exactly the kind of thing the audit log exists
  // for. The moderator action itself (warn/mute/ban) is taken separately
  // through the existing profile card, so it lands in the log on its own.
  for (const [action, status] of [
    ["resolve", "RESOLVED"],
    ["dismiss", "DISMISSED"],
  ] as const) {
    app.post(`/reports/:reportId/${action}`, { onRequest: [app.authenticate] }, async (req, reply) => {
      const { sub: userId } = req.user as { sub: string };
      if (!(await requireModerator(userId))) {
        return reply.status(403).send({ error: "missing MODERATE_MEMBERS permission" });
      }
      const { reportId } = req.params as { reportId: string };
      const report = await prisma.report.findUnique({ where: { id: reportId } });
      if (!report) return reply.status(404).send({ error: "report not found" });
      if (report.status !== "OPEN") return reply.status(400).send({ error: "this report has already been handled" });

      await prisma.report.update({
        where: { id: reportId },
        data: { status, handledById: userId, handledAt: new Date() },
      });
      await prisma.moderationLogEntry.create({
        data: {
          action: `report_${action}d`,
          actorId: userId,
          targetId: report.targetUserId,
          detail: report.reason,
        },
      });
      return reply.status(204).send();
    });
  }
}
