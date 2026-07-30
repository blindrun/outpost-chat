import { useEffect, useState } from "react";
import { Invite, createInvite, listInvites, revokeInvite } from "./api";

function isExpired(invite: Invite) {
  return !!invite.expiresAt && new Date(invite.expiresAt).getTime() <= Date.now();
}

function isSpent(invite: Invite) {
  return invite.maxUses !== null && invite.uses >= invite.maxUses;
}

function inviteLink(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/?invite=${code}`;
}

export function InvitePanel({ baseUrl, token }: { baseUrl: string; token: string }) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [maxUses, setMaxUses] = useState("");
  const [expiresMinutes, setExpiresMinutes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function handleCopy(inv: Invite) {
    try {
      await navigator.clipboard.writeText(inviteLink(baseUrl, inv.code));
      setCopiedId(inv.id);
      setTimeout(() => setCopiedId((id) => (id === inv.id ? null : id)), 1500);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function refresh() {
    listInvites(baseUrl, token).then(setInvites).catch((err) => setError(err.message));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createInvite(baseUrl, token, {
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
      await revokeInvite(baseUrl, token, inviteId);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="invite-panel">
      <p className="subtitle">Invite codes let new people register an account on this instance.</p>
      <form onSubmit={handleCreate} className="invite-new-form">
        <input
          placeholder="max uses"
          type="number"
          min={1}
          value={maxUses}
          onChange={(e) => setMaxUses(e.target.value)}
        />
        <input
          placeholder="expires (min)"
          type="number"
          min={1}
          value={expiresMinutes}
          onChange={(e) => setExpiresMinutes(e.target.value)}
        />
        <button type="submit" className="btn">
          New
        </button>
      </form>
      <p className="invite-hint">Leave either field blank for unlimited uses / no expiration.</p>
      {error && <p className="error">{error}</p>}
      <ul className="invite-list">
        {invites.map((inv) => {
          const expired = isExpired(inv);
          const spent = isSpent(inv);
          const dead = inv.revoked || expired || spent;
          return (
            <li key={inv.id} className={dead ? "invite-dead" : ""}>
              <div className="invite-row">
                <code className="invite-link">{inviteLink(baseUrl, inv.code)}</code>
                {!dead && (
                  <button type="button" className="text-btn" onClick={() => handleCopy(inv)}>
                    {copiedId === inv.id ? "copied!" : "copy link"}
                  </button>
                )}
              </div>
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
