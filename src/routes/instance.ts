import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../plugins/db.js";
import {
  PERMISSIONS,
  hasPermission,
} from "../util/permissions.js";
import { createUniqueInviteCode, isInviteValid } from "../util/invites.js";
import { broadcastAll } from "../gateway/rooms.js";
import { UPLOAD_CATEGORY_KEYS } from "../util/uploadCategories.js";

const createInviteSchema = z.object({
  maxUses: z.number().int().min(1).max(1000).optional(),
  expiresInSeconds: z.number().int().min(60).max(60 * 60 * 24 * 30).optional(),
});

const updateInstanceSettingsSchema = z.object({
  name: z.string().min(2).max(64).optional(),
  description: z.string().max(1000).optional(),
  iconUrl: z.string().url().nullable().optional(),
  theme: z.enum(["business", "cyberpunk", "hacker", "esports"]).optional(),
  requireInviteToRegister: z.boolean().optional(),
  defaultChannelId: z.string().nullable().optional(),
  enabledUploadCategories: z.array(z.enum(UPLOAD_CATEGORY_KEYS as [string, ...string[]])).optional(),
});

const createChannelSchema = z.object({
  name: z.string().min(2).max(64),
  type: z.enum(["TEXT", "VOICE"]).default("TEXT"),
});

const reorderChannelsSchema = z.object({
  type: z.enum(["TEXT", "VOICE"]),
  channelIds: z.array(z.string()).min(1),
});

const createRoleSchema = z.object({
  name: z.string().min(1).max(32),
  permissions: z.array(z.enum(["MANAGE_CHANNELS", "MANAGE_ROLES", "SEND_MESSAGES", "MODERATE_MEMBERS"])).default([]),
});

const assignRoleSchema = z.object({
  roleId: z.string(),
});

async function getOrCreateSettings() {
  return prisma.instanceSettings.upsert({
    where: { id: "singleton" },
    create: {},
    update: {},
  });
}

export async function instanceRoutes(app: FastifyInstance) {
  // Unauthenticated — used by the client's "Add a Server" flow to probe an
  // address before showing login/register/first-owner-setup, and to render
  // this instance's name/description/theme even for a not-yet-logged-in user.
  app.get("/instance-info", async () => {
    const [settings, hasOwner, botSettings] = await Promise.all([
      getOrCreateSettings(),
      prisma.user.count().then((c) => c > 0),
      prisma.botSettings.findUnique({ where: { id: "singleton" } }),
    ]);
    return {
      name: settings.name,
      description: settings.description,
      iconUrl: settings.iconUrl,
      theme: settings.theme,
      requireInviteToRegister: settings.requireInviteToRegister,
      hasOwner,
      gifSearchEnabled: !!process.env.GIPHY_API_KEY,
      // The site key (unlike TURNSTILE_SECRET_KEY) is meant to be public —
      // it's embedded in every page load that shows the widget. Opt-in
      // per instance, same pattern as gifSearchEnabled: only set when the
      // self-hoster has actually configured Cloudflare Turnstile.
      // Docker Compose's ${VAR:-} substitution passes through an actual
      // empty string when the var is absent from .env, not an unset env
      // var — `|| null` (not `??`) normalizes that back to "not
      // configured" the same as if it were never set at all.
      turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null,
      defaultChannelId: settings.defaultChannelId,
      levelingEnabled: botSettings?.levelingEnabled ?? false,
      enabledUploadCategories: settings.enabledUploadCategories,
    };
  });

  // Instance settings — owner-only.
  app.patch("/instance/settings", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const body = updateInstanceSettingsSchema.parse(req.body ?? {});

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.isOwner) return reply.status(403).send({ error: "only the instance owner can change settings" });

    if (body.defaultChannelId) {
      const channel = await prisma.channel.findUnique({ where: { id: body.defaultChannelId } });
      if (!channel || channel.type !== "TEXT") {
        return reply.status(400).send({ error: "defaultChannelId must be an existing text channel" });
      }
    }

    const updated = await prisma.instanceSettings.upsert({
      where: { id: "singleton" },
      create: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.iconUrl !== undefined ? { iconUrl: body.iconUrl } : {}),
        ...(body.theme !== undefined ? { theme: body.theme } : {}),
        ...(body.requireInviteToRegister !== undefined ? { requireInviteToRegister: body.requireInviteToRegister } : {}),
        ...(body.defaultChannelId !== undefined ? { defaultChannelId: body.defaultChannelId } : {}),
        ...(body.enabledUploadCategories !== undefined ? { enabledUploadCategories: body.enabledUploadCategories } : {}),
      },
      update: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.iconUrl !== undefined ? { iconUrl: body.iconUrl } : {}),
        ...(body.theme !== undefined ? { theme: body.theme } : {}),
        ...(body.requireInviteToRegister !== undefined ? { requireInviteToRegister: body.requireInviteToRegister } : {}),
        ...(body.defaultChannelId !== undefined ? { defaultChannelId: body.defaultChannelId } : {}),
        ...(body.enabledUploadCategories !== undefined ? { enabledUploadCategories: body.enabledUploadCategories } : {}),
      },
    });
    return updated;
  });

  // Member list — every registered user on this instance is implicitly a
  // member, so any authenticated user can see who else is here (needed for
  // the role-assignment UI; assigning is still gated behind MANAGE_ROLES).
  app.get("/members", { onRequest: [app.authenticate] }, async () => {
    const users = await prisma.user.findMany({
      include: { memberRoles: { include: { role: true } } },
      orderBy: { createdAt: "asc" },
    });
    return users.map((u) => ({
      userId: u.id,
      username: u.username,
      avatarUrl: u.avatarUrl,
      bio: u.bio,
      joinedAt: u.createdAt,
      mutedUntil: u.mutedUntil,
      banned: u.banned,
      roles: u.memberRoles.map((mr) => ({ id: mr.role.id, name: mr.role.name })),
    }));
  });

  // A single member's public profile — same shape as one entry from
  // GET /members, but avoids fetching every member just to open one
  // profile card (message avatars/usernames trigger this a lot).
  app.get("/members/:userId", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { memberRoles: { include: { role: true } } },
    });
    if (!user) return reply.status(404).send({ error: "member not found" });

    return {
      userId: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl,
      bio: user.bio,
      joinedAt: user.createdAt,
      mutedUntil: user.mutedUntil,
      banned: user.banned,
      roles: user.memberRoles.map((mr) => ({ id: mr.role.id, name: mr.role.name })),
    };
  });

  // Invite management — owner-only. These gate REGISTRATION on this instance
  // (see POST /auth/register), not "joining a server" — there's only one
  // community here. Create with an optional max-use count and/or expiry,
  // list all invites (including spent/expired/revoked, for history), revoke.
  app.post("/invites", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const body = createInviteSchema.parse(req.body ?? {});

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.isOwner) return reply.status(403).send({ error: "only the instance owner can manage invites" });

    const code = await createUniqueInviteCode();
    const invite = await prisma.invite.create({
      data: {
        code,
        createdBy: userId,
        maxUses: body.maxUses,
        expiresAt: body.expiresInSeconds ? new Date(Date.now() + body.expiresInSeconds * 1000) : null,
      },
    });
    return reply.status(201).send(invite);
  });

  app.get("/invites", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.isOwner) return reply.status(403).send({ error: "only the instance owner can view invites" });

    return prisma.invite.findMany({ orderBy: { createdAt: "desc" } });
  });

  app.delete("/invites/:inviteId", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { inviteId } = req.params as { inviteId: string };
    const { sub: userId } = req.user as { sub: string };

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.isOwner) return reply.status(403).send({ error: "only the instance owner can revoke invites" });

    const invite = await prisma.invite.findUnique({ where: { id: inviteId } });
    if (!invite) return reply.status(404).send({ error: "invite not found" });

    await prisma.invite.update({ where: { id: inviteId }, data: { revoked: true } });
    return reply.status(204).send();
  });

  // Create a channel — requires MANAGE_CHANNELS (owner always has it; @everyone
  // does not by default, so plain members can't create channels out of the box).
  app.post("/channels", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const body = createChannelSchema.parse(req.body);

    if (!(await hasPermission(userId, PERMISSIONS.MANAGE_CHANNELS))) {
      return reply.status(403).send({ error: "missing MANAGE_CHANNELS permission" });
    }

    const channel = await prisma.channel.create({
      data: { name: body.name, type: body.type },
    });
    return reply.status(201).send(channel);
  });

  // Reorders one channel-type list (text or voice) at a time, matching how
  // the sidebar renders them as two separate sections — takes the full
  // ordered list of that type's channel ids and assigns sequential
  // positions, rather than a single move+insert-between-neighbors call, to
  // avoid needing fractional positions or renumbering logic. Broadcasts the
  // fresh full channel list so every connected client's sidebar reorders
  // live, not just the admin who dragged it.
  app.post("/channels/reorder", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    if (!(await hasPermission(userId, PERMISSIONS.MANAGE_CHANNELS))) {
      return reply.status(403).send({ error: "missing MANAGE_CHANNELS permission" });
    }
    const body = reorderChannelsSchema.parse(req.body);

    const existing = await prisma.channel.findMany({ where: { id: { in: body.channelIds }, type: body.type } });
    if (existing.length !== body.channelIds.length) {
      return reply.status(400).send({ error: "channelIds must all exist and match the given type" });
    }

    await prisma.$transaction(
      body.channelIds.map((id, position) => prisma.channel.update({ where: { id }, data: { position } })),
    );

    const channels = await prisma.channel.findMany({ where: { type: { not: "THREAD" } }, orderBy: { position: "asc" } });
    broadcastAll({ type: "CHANNELS_UPDATE", channels });
    return reply.status(204).send();
  });

  // Create a role — requires MANAGE_ROLES (owner always has it).
  app.post("/roles", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const body = createRoleSchema.parse(req.body);

    if (!(await hasPermission(userId, PERMISSIONS.MANAGE_ROLES))) {
      return reply.status(403).send({ error: "missing MANAGE_ROLES permission" });
    }

    const role = await prisma.role.create({
      data: { name: body.name, permissions: body.permissions },
    });
    return reply.status(201).send(role);
  });

  // List roles — any authenticated user can see what roles exist.
  app.get("/roles", { onRequest: [app.authenticate] }, async () => {
    return prisma.role.findMany();
  });

  // Assign an existing role to a member — requires MANAGE_ROLES.
  app.post("/members/:userId/roles", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { userId: targetUserId } = req.params as { userId: string };
    const { sub: requesterId } = req.user as { sub: string };
    const body = assignRoleSchema.parse(req.body);

    if (!(await hasPermission(requesterId, PERMISSIONS.MANAGE_ROLES))) {
      return reply.status(403).send({ error: "missing MANAGE_ROLES permission" });
    }

    const [role, targetUser] = await Promise.all([
      prisma.role.findUnique({ where: { id: body.roleId } }),
      prisma.user.findUnique({ where: { id: targetUserId } }),
    ]);
    if (!role) return reply.status(404).send({ error: "role not found" });
    if (!targetUser) return reply.status(404).send({ error: "target user not found" });

    const userRole = await prisma.userRole.upsert({
      where: { userId_roleId: { userId: targetUserId, roleId: role.id } },
      create: { userId: targetUserId, roleId: role.id },
      update: {},
    });
    return reply.status(201).send(userRole);
  });

  // Remove a role from a member — same MANAGE_ROLES gate as assigning one.
  app.delete("/members/:userId/roles/:roleId", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { userId: targetUserId, roleId } = req.params as { userId: string; roleId: string };
    const { sub: requesterId } = req.user as { sub: string };

    if (!(await hasPermission(requesterId, PERMISSIONS.MANAGE_ROLES))) {
      return reply.status(403).send({ error: "missing MANAGE_ROLES permission" });
    }

    await prisma.userRole.delete({ where: { userId_roleId: { userId: targetUserId, roleId } } }).catch(() => null);
    return reply.status(204).send();
  });
}
