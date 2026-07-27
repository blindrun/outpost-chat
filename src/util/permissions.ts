import { prisma } from "../plugins/db.js";

export const PERMISSIONS = {
  MANAGE_CHANNELS: "MANAGE_CHANNELS",
  MANAGE_ROLES: "MANAGE_ROLES",
  SEND_MESSAGES: "SEND_MESSAGES",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const EVERYONE_ROLE_NAME = "@everyone";
export const DEFAULT_EVERYONE_PERMISSIONS: Permission[] = [PERMISSIONS.SEND_MESSAGES];

// The instance owner implicitly has every permission. Everyone else's
// permissions are the union of their assigned roles' permission lists.
export async function hasPermission(userId: string, permission: Permission): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return false;
  if (user.isOwner) return true;

  const userRoles = await prisma.userRole.findMany({
    where: { userId },
    include: { role: true },
  });

  return userRoles.some((ur) => ur.role.permissions.includes(permission));
}
