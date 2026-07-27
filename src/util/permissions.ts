import { prisma } from "../plugins/db.js";

export const PERMISSIONS = {
  MANAGE_CHANNELS: "MANAGE_CHANNELS",
  MANAGE_ROLES: "MANAGE_ROLES",
  SEND_MESSAGES: "SEND_MESSAGES",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const EVERYONE_ROLE_NAME = "@everyone";
export const DEFAULT_EVERYONE_PERMISSIONS: Permission[] = [PERMISSIONS.SEND_MESSAGES];

// Server owners implicitly have every permission. Everyone else's permissions
// are the union of their assigned roles' permission lists.
export async function hasPermission(userId: string, serverId: string, permission: Permission): Promise<boolean> {
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) return false;
  if (server.ownerId === userId) return true;

  const membership = await prisma.membership.findUnique({
    where: { userId_serverId: { userId, serverId } },
    include: { roles: { include: { role: true } } },
  });
  if (!membership) return false;

  return membership.roles.some((mr) => mr.role.permissions.includes(permission));
}
