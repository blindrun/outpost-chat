import { prisma } from "../plugins/db.js";
import { generateInviteCode } from "./invite-code.js";

export async function createUniqueInviteCode(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode();
    const existing = await prisma.invite.findUnique({ where: { code } });
    if (!existing) return code;
  }
  throw new Error("failed to generate a unique invite code after 5 attempts");
}

export interface InviteLike {
  code: string;
  revoked: boolean;
  expiresAt: Date | null;
  maxUses: number | null;
  uses: number;
}

export function isInviteValid(invite: InviteLike) {
  if (invite.revoked) return false;
  if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) return false;
  if (invite.maxUses !== null && invite.uses >= invite.maxUses) return false;
  return true;
}
