import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../plugins/db.js";
import { generateInviteCode } from "../util/invite-code.js";
import {
  DEFAULT_EVERYONE_PERMISSIONS,
  EVERYONE_ROLE_NAME,
  PERMISSIONS,
  hasPermission,
} from "../util/permissions.js";

const createServerSchema = z.object({
  name: z.string().min(2).max(64),
});

async function createUniqueInviteCode(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode();
    const existing = await prisma.server.findUnique({ where: { inviteCode: code } });
    if (!existing) return code;
  }
  throw new Error("failed to generate a unique invite code after 5 attempts");
}

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
  // a default "@everyone" role (base permissions every member gets), and a shareable
  // invite code (no separate invite-management system yet — one permanent code per server).
  app.post("/servers", async (req, reply) => {
    const body = createServerSchema.parse(req.body);
    const { sub: userId } = req.user as { sub: string };
    const inviteCode = await createUniqueInviteCode();

    const server = await prisma.$transaction(async (tx) => {
      const created = await tx.server.create({
        data: {
          name: body.name,
          ownerId: userId,
          inviteCode,
          channels: { create: { name: "general", type: "TEXT" } },
          roles: { create: { name: EVERYONE_ROLE_NAME, permissions: DEFAULT_EVERYONE_PERMISSIONS } },
        },
        include: { channels: true, roles: true },
      });
      const everyoneRole = created.roles.find((r) => r.name === EVERYONE_ROLE_NAME)!;
      await tx.membership.create({
        data: { userId, serverId: created.id, roles: { create: { roleId: everyoneRole.id } } },
      });
      return created;
    });

    return reply.status(201).send(server);
  });

  // List servers the current user belongs to.
  app.get("/servers", async (req) => {
    const { sub: userId } = req.user as { sub: string };
    const memberships = await prisma.membership.findMany({
      where: { userId },
      include: { server: { include: { channels: true } } },
    });
    return memberships.map((m) => m.server);
  });

  // Join a server via its shareable invite code — the only join mechanism;
  // no separate raw-server-id join, since a non-member has no other way to
  // discover the server id in the first place. New joins get the @everyone
  // role automatically; rejoining an existing membership is a no-op.
  app.post("/invites/:code/join", async (req, reply) => {
    const { code } = req.params as { code: string };
    const { sub: userId } = req.user as { sub: string };

    const server = await prisma.server.findUnique({ where: { inviteCode: code } });
    if (!server) return reply.status(404).send({ error: "invalid invite code" });

    const existing = await prisma.membership.findUnique({
      where: { userId_serverId: { userId, serverId: server.id } },
    });
    if (existing) return existing;

    const everyoneRole = await prisma.role.findFirst({
      where: { serverId: server.id, name: EVERYONE_ROLE_NAME },
    });

    const membership = await prisma.membership.create({
      data: {
        userId,
        serverId: server.id,
        ...(everyoneRole ? { roles: { create: { roleId: everyoneRole.id } } } : {}),
      },
      include: { server: { include: { channels: true } } },
    });
    return membership;
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
