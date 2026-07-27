import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../plugins/db.js";
import {
  DEFAULT_EVERYONE_PERMISSIONS,
  EVERYONE_ROLE_NAME,
  PERMISSIONS,
  hasPermission,
} from "../util/permissions.js";
import { createUniqueInviteCode, isInviteValid, withDefaultInviteCode } from "../util/invites.js";

const createServerSchema = z.object({
  name: z.string().min(2).max(64),
});

const createInviteSchema = z.object({
  maxUses: z.number().int().min(1).max(1000).optional(),
  expiresInSeconds: z.number().int().min(60).max(60 * 60 * 24 * 30).optional(),
});

const updateServerSettingsSchema = z.object({
  name: z.string().min(2).max(64).optional(),
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

export async function serverRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  // Create a server. Owner is auto-joined and gets a default "general" text channel,
  // a default "@everyone" role (base permissions every member gets), and one
  // default unlimited/non-expiring invite (see the Invite model + endpoints
  // below for real invite management: multiple codes, max uses, expiry, revoke).
  app.post("/servers", async (req, reply) => {
    const body = createServerSchema.parse(req.body);
    const { sub: userId } = req.user as { sub: string };
    const inviteCode = await createUniqueInviteCode();

    const server = await prisma.$transaction(async (tx) => {
      const created = await tx.server.create({
        data: {
          name: body.name,
          ownerId: userId,
          channels: { create: { name: "general", type: "TEXT" } },
          roles: { create: { name: EVERYONE_ROLE_NAME, permissions: DEFAULT_EVERYONE_PERMISSIONS } },
          invites: { create: { code: inviteCode, createdBy: userId } },
        },
        include: { channels: true, roles: true, invites: true },
      });
      const everyoneRole = created.roles.find((r) => r.name === EVERYONE_ROLE_NAME)!;
      await tx.membership.create({
        data: { userId, serverId: created.id, roles: { create: { roleId: everyoneRole.id } } },
      });
      return created;
    });

    return reply.status(201).send(withDefaultInviteCode(server));
  });

  // List servers the current user belongs to.
  app.get("/servers", async (req) => {
    const { sub: userId } = req.user as { sub: string };
    const memberships = await prisma.membership.findMany({
      where: { userId },
      include: { server: { include: { channels: true, invites: true } } },
    });
    return memberships.map((m) => withDefaultInviteCode(m.server));
  });

  // Join a server via a shareable invite code — the only join mechanism; no
  // separate raw-server-id join, since a non-member has no other way to
  // discover the server id in the first place. Enforces expiry/max-uses/
  // revocation. New joins get the @everyone role automatically; rejoining an
  // existing membership is a no-op (doesn't consume a use).
  app.post("/invites/:code/join", async (req, reply) => {
    const { code } = req.params as { code: string };
    const { sub: userId } = req.user as { sub: string };

    const invite = await prisma.invite.findUnique({ where: { code } });
    if (!invite || !isInviteValid(invite)) {
      return reply.status(404).send({ error: "invalid or expired invite code" });
    }

    const existing = await prisma.membership.findUnique({
      where: { userId_serverId: { userId, serverId: invite.serverId } },
    });
    if (existing) return existing;

    const everyoneRole = await prisma.role.findFirst({
      where: { serverId: invite.serverId, name: EVERYONE_ROLE_NAME },
    });

    const [membership] = await prisma.$transaction([
      prisma.membership.create({
        data: {
          userId,
          serverId: invite.serverId,
          ...(everyoneRole ? { roles: { create: { roleId: everyoneRole.id } } } : {}),
        },
        include: { server: { include: { channels: true } } },
      }),
      prisma.invite.update({ where: { id: invite.id }, data: { uses: { increment: 1 } } }),
    ]);
    return membership;
  });

  // Server settings — owner-only. Currently just rename; a natural place to
  // add more server-level settings later.
  app.patch("/servers/:serverId/settings", async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const { sub: userId } = req.user as { sub: string };
    const body = updateServerSettingsSchema.parse(req.body ?? {});

    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) return reply.status(404).send({ error: "server not found" });
    if (server.ownerId !== userId) return reply.status(403).send({ error: "only the server owner can change settings" });

    const updated = await prisma.server.update({
      where: { id: serverId },
      data: { ...(body.name ? { name: body.name } : {}) },
      include: { invites: true },
    });
    return withDefaultInviteCode(updated);
  });

  // Member list — any member can see who else is here, and what roles they
  // hold (needed for the role-assignment UI; assigning is still gated behind
  // MANAGE_ROLES on the endpoint below).
  app.get("/servers/:serverId/members", async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const { sub: userId } = req.user as { sub: string };

    const membership = await prisma.membership.findUnique({
      where: { userId_serverId: { userId, serverId } },
    });
    if (!membership) return reply.status(403).send({ error: "not a member of this server" });

    const members = await prisma.membership.findMany({
      where: { serverId },
      include: { user: { select: { id: true, username: true, avatarUrl: true } }, roles: { include: { role: true } } },
      orderBy: { joinedAt: "asc" },
    });
    return members.map((m) => ({
      userId: m.user.id,
      username: m.user.username,
      avatarUrl: m.user.avatarUrl,
      joinedAt: m.joinedAt,
      roles: m.roles.map((r) => ({ id: r.role.id, name: r.role.name })),
    }));
  });

  // Invite management — owner-only, since these are server-settings-level
  // operations rather than anything covered by the granular role/permission
  // system. Create additional invites with an optional max-use count and/or
  // expiry, list all of a server's invites (including spent/expired/revoked
  // ones, so the owner can see history), and revoke one.
  app.post("/servers/:serverId/invites", async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const { sub: userId } = req.user as { sub: string };
    const body = createInviteSchema.parse(req.body ?? {});

    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) return reply.status(404).send({ error: "server not found" });
    if (server.ownerId !== userId) return reply.status(403).send({ error: "only the server owner can manage invites" });

    const code = await createUniqueInviteCode();
    const invite = await prisma.invite.create({
      data: {
        serverId,
        code,
        createdBy: userId,
        maxUses: body.maxUses,
        expiresAt: body.expiresInSeconds ? new Date(Date.now() + body.expiresInSeconds * 1000) : null,
      },
    });
    return reply.status(201).send(invite);
  });

  app.get("/servers/:serverId/invites", async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const { sub: userId } = req.user as { sub: string };

    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) return reply.status(404).send({ error: "server not found" });
    if (server.ownerId !== userId) return reply.status(403).send({ error: "only the server owner can view invites" });

    return prisma.invite.findMany({ where: { serverId }, orderBy: { createdAt: "desc" } });
  });

  app.delete("/servers/:serverId/invites/:inviteId", async (req, reply) => {
    const { serverId, inviteId } = req.params as { serverId: string; inviteId: string };
    const { sub: userId } = req.user as { sub: string };

    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) return reply.status(404).send({ error: "server not found" });
    if (server.ownerId !== userId) return reply.status(403).send({ error: "only the server owner can revoke invites" });

    const invite = await prisma.invite.findUnique({ where: { id: inviteId } });
    if (!invite || invite.serverId !== serverId) return reply.status(404).send({ error: "invite not found" });

    await prisma.invite.update({ where: { id: inviteId }, data: { revoked: true } });
    return reply.status(204).send();
  });

  // Create a channel — requires MANAGE_CHANNELS (owner always has it; @everyone
  // does not by default, so plain members can't create channels out of the box).
  app.post("/servers/:serverId/channels", async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const { sub: userId } = req.user as { sub: string };
    const body = createChannelSchema.parse(req.body);

    if (!(await hasPermission(userId, serverId, PERMISSIONS.MANAGE_CHANNELS))) {
      return reply.status(403).send({ error: "missing MANAGE_CHANNELS permission" });
    }

    const channel = await prisma.channel.create({
      data: { serverId, name: body.name, type: body.type },
    });
    return reply.status(201).send(channel);
  });

  // Create a role — requires MANAGE_ROLES (owner always has it).
  app.post("/servers/:serverId/roles", async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const { sub: userId } = req.user as { sub: string };
    const body = createRoleSchema.parse(req.body);

    if (!(await hasPermission(userId, serverId, PERMISSIONS.MANAGE_ROLES))) {
      return reply.status(403).send({ error: "missing MANAGE_ROLES permission" });
    }

    const role = await prisma.role.create({
      data: { serverId, name: body.name, permissions: body.permissions },
    });
    return reply.status(201).send(role);
  });

  // List a server's roles — any member can see what roles exist.
  app.get("/servers/:serverId/roles", async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const { sub: userId } = req.user as { sub: string };

    const membership = await prisma.membership.findUnique({
      where: { userId_serverId: { userId, serverId } },
    });
    if (!membership) return reply.status(403).send({ error: "not a member of this server" });

    return prisma.role.findMany({ where: { serverId } });
  });

  // Assign an existing role to a member — requires MANAGE_ROLES.
  app.post("/servers/:serverId/members/:userId/roles", async (req, reply) => {
    const { serverId, userId: targetUserId } = req.params as { serverId: string; userId: string };
    const { sub: requesterId } = req.user as { sub: string };
    const body = assignRoleSchema.parse(req.body);

    if (!(await hasPermission(requesterId, serverId, PERMISSIONS.MANAGE_ROLES))) {
      return reply.status(403).send({ error: "missing MANAGE_ROLES permission" });
    }

    const [role, membership] = await Promise.all([
      prisma.role.findUnique({ where: { id: body.roleId } }),
      prisma.membership.findUnique({ where: { userId_serverId: { userId: targetUserId, serverId } } }),
    ]);
    if (!role || role.serverId !== serverId) return reply.status(404).send({ error: "role not found" });
    if (!membership) return reply.status(404).send({ error: "target user is not a member of this server" });

    const memberRole = await prisma.memberRole.upsert({
      where: { membershipId_roleId: { membershipId: membership.id, roleId: role.id } },
      create: { membershipId: membership.id, roleId: role.id },
      update: {},
    });
    return reply.status(201).send(memberRole);
  });
}
