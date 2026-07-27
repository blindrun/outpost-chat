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

// Attaches a convenience `inviteCode` (the first currently-valid invite) to a
// server object so client code that just wants "a" code to share doesn't need
// to know about the full invite-management model — and strips the raw
// `invites` list back off, since that can include limited-use codes not meant
// for every member to see. The full list is only ever exposed via the
// dedicated owner-only /servers/:id/invites endpoints.
export function withDefaultInviteCode<T extends { invites: InviteLike[] }>(server: T) {
  const { invites, ...rest } = server;
  const valid = invites.find((inv) => isInviteValid(inv));
  return { ...rest, inviteCode: valid?.code ?? null };
}
