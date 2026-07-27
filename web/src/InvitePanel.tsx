import { useEffect, useState } from "react";
import { Invite, createInvite, listInvites, revokeInvite } from "./api";

function isExpired(invite: Invite) {
  return !!invite.expiresAt && new Date(invite.expiresAt).getTime() <= Date.now();
}

function isSpent(invite: Invite) {
  return invite.maxUses !== null && invite.uses >= invite.maxUses;
}

export function InvitePanel({ token, serverId }: { token: string; serverId: string }) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [maxUses, setMaxUses] = useState("");
  const [expiresMinutes, setExpiresMinutes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  function refresh() {
    listInvites(token, serverId).then(setInvites).catch((err) => setError(err.message));
  }

  useEffect(() => {
    if (open) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, serverId]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createInvite(token, serverId, {
        maxUses: maxUses ? Number(maxUses) : undefined,
        expiresInSeconds: expiresMinutes ? Number(expiresMinutes) * 60 : undefined,
      });
      setMaxUses("");
      setExpiresMinutes("");
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleRevoke(inviteId: string) {
    try {
      await revokeInvite(token, serverId, inviteId);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!open) {
    return (
      <button className="text-btn" onClick={() => setOpen(true)}>
        Manage Invites
      </button>
    );
  }

  return (
    <div className="invite-panel">
      <button className="text-btn" onClick={() => setOpen(false)}>
        Hide Invites
      </button>
      <form onSubmit={handleCreate} className="invite-new-form">
        <input
          placeholder="max uses (blank = ∞)"
          type="number"
          min={1}
          value={maxUses}
          onChange={(e) => setMaxUses(e.target.value)}
        />
        <input
          placeholder="expires in minutes"
          type="number"
          min={1}
          value={expiresMinutes}
          onChange={(e) => setExpiresMinutes(e.target.value)}
        />
        <button type="submit">New</button>
      </form>
      {error && <p className="error">{error}</p>}
      <ul className="invite-list">
        {invites.map((inv) => {
          const expired = isExpired(inv);
          const spent = isSpent(inv);
          const dead = inv.revoked || expired || spent;
          return (
            <li key={inv.id} className={dead ? "invite-dead" : ""}>
              <code>{inv.code}</code>
              <span className="invite-meta">
                {inv.uses}
                {inv.maxUses !== null ? `/${inv.maxUses}` : ""} uses
                {inv.expiresAt ? ` · expires ${new Date(inv.expiresAt).toLocaleString()}` : ""}
                {inv.revoked ? " · revoked" : expired ? " · expired" : spent ? " · spent" : ""}
              </span>
              {!dead && (
                <button className="text-btn" onClick={() => handleRevoke(inv.id)}>
                  revoke
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
