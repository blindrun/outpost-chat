import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../plugins/db.js";
import {
  PERMISSIONS,
  hasPermission,
} from "../util/permissions.js";
import { createUniqueInviteCode, isInviteValid } from "../util/invites.js";

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
});

const createChannelSchema = z.object({
  name: z.string().min(2).max(64),
  type: z.enum(["TEXT", "VOICE"]).default("TEXT"),
});

const createRoleSchema = z.object({
  name: z.string().min(1).max(32),
  permissions: z.array(z.enum(["MANAGE_CHANNELS", "MANAGE_ROLES", "SEND_MESSAGES"])).default([]),
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
    const [settings, hasOwner] = await Promise.all([
      getOrCreateSettings(),
      prisma.user.count().then((c) => c > 0),
    ]);
    return {
      name: settings.name,
      description: settings.description,
      iconUrl: settings.iconUrl,
      theme: settings.theme,
      requireInviteToRegister: settings.requireInviteToRegister,
      hasOwner,
      gifSearchEnabled: !!process.env.GIPHY_API_KEY,
      defaultChannelId: settings.defaultChannelId,
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
      },
      update: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.iconUrl !== undefined ? { iconUrl: body.iconUrl } : {}),
        ...(body.theme !== undefined ? { theme: body.theme } : {}),
        ...(body.requireInviteToRegister !== undefined ? { requireInviteToRegister: body.requireInviteToRegister } : {}),
        ...(body.defaultChannelId !== undefined ? { defaultChannelId: body.defaultChannelId } : {}),
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
      joinedAt: u.createdAt,
      roles: u.memberRoles.map((mr) => ({ id: mr.role.id, name: mr.role.name })),
    }));
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
