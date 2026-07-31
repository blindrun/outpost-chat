import { prisma } from "../plugins/db.js";

export const PERMISSIONS = {
  MANAGE_CHANNELS: "MANAGE_CHANNELS",
  MANAGE_ROLES: "MANAGE_ROLES",
  SEND_MESSAGES: "SEND_MESSAGES",
  MODERATE_MEMBERS: "MODERATE_MEMBERS",
  // Gate which curated non-image attachment categories a role's members can
  // upload — see util/uploadCategories.ts for what each one allows. Images
  // are never gated; there's no permission for those.
  UPLOAD_DOCUMENTS: "UPLOAD_DOCUMENTS",
  UPLOAD_ARCHIVES: "UPLOAD_ARCHIVES",
  UPLOAD_CODE: "UPLOAD_CODE",
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
