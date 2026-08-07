import { prisma } from "../plugins/db.js";

export const PERMISSIONS = {
  MANAGE_CHANNELS: "MANAGE_CHANNELS",
  MANAGE_ROLES: "MANAGE_ROLES",
  // General + Mail tabs of Instance Settings (name/icon/theme/default
  // channel/AFK channel, outbound SMTP config) — previously hardcoded to
  // isOwner with no grantable escape hatch, so a role with every other
  // permission checked still couldn't actually save a change there. Kept
  // separate from MANAGE_CHANNELS/MANAGE_ROLES since it's a materially
  // different blast radius (whole-instance identity and mail credentials,
  // not one channel or role at a time).
  MANAGE_SERVER: "MANAGE_SERVER",
  SEND_MESSAGES: "SEND_MESSAGES",
  MODERATE_MEMBERS: "MODERATE_MEMBERS",
  // Gate which curated non-image attachment categories a role's members can
  // upload — see util/uploadCategories.ts for what each one allows. Images
  // are never gated; there's no permission for those.
  UPLOAD_DOCUMENTS: "UPLOAD_DOCUMENTS",
  UPLOAD_ARCHIVES: "UPLOAD_ARCHIVES",
  UPLOAD_CODE: "UPLOAD_CODE",
  UPLOAD_VIDEOS: "UPLOAD_VIDEOS",
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

// Channel-level visibility, separate from the instance-wide Permission
// system above — a channel with an empty restrictedToRoleIds is visible to
// everyone (today's default for every channel); a non-empty one is visible
// only to the owner or a member holding at least one of the listed roles.
// Filters a whole list at once so callers building a channel list (READY,
// CHANNELS_UPDATE, /messages/search's instance-wide case) only need one
// user/role lookup instead of one per channel.
export async function filterVisibleChannels<T extends { restrictedToRoleIds: string[] }>(
  userId: string,
  channels: T[],
): Promise<T[]> {
  if (channels.every((c) => c.restrictedToRoleIds.length === 0)) return channels;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (user?.isOwner) return channels;

  const userRoles = await prisma.userRole.findMany({ where: { userId }, select: { roleId: true } });
  const roleIdSet = new Set(userRoles.map((ur) => ur.roleId));

  return channels.filter(
    (c) => c.restrictedToRoleIds.length === 0 || c.restrictedToRoleIds.some((id) => roleIdSet.has(id)),
  );
}

export async function canAccessChannel(userId: string, channel: { restrictedToRoleIds: string[] }): Promise<boolean> {
  if (channel.restrictedToRoleIds.length === 0) return true;
  const [visible] = await filterVisibleChannels(userId, [channel]);
  return !!visible;
}
