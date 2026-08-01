import { useEffect, useState } from "react";
import { Channel, Role, listRoles, updateChannelPermissions } from "./api";

function ChannelPermissionRow({
  baseUrl,
  token,
  channel,
  roles,
  onUpdated,
}: {
  baseUrl: string;
  token: string;
  channel: Channel;
  roles: Role[];
  onUpdated: (channel: Channel) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(channel.restrictedToRoleIds ?? []));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty =
    selected.size !== (channel.restrictedToRoleIds ?? []).length ||
    [...selected].some((id) => !(channel.restrictedToRoleIds ?? []).includes(id));

  function toggleRole(roleId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  }

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const updated = await updateChannelPermissions(baseUrl, token, channel.id, [...selected]);
      onUpdated(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="role-row channel-permission-row">
      <strong>
        {channel.type === "TEXT" ? "#" : "🔊"} {channel.name}
      </strong>
      <div className="permission-checkboxes">
        {roles.map((role) => (
          <label key={role.id} className="checkbox-label">
            <input type="checkbox" checked={selected.has(role.id)} onChange={() => toggleRole(role.id)} />
            {role.name}
          </label>
        ))}
      </div>
      <span className="invite-meta">
        {selected.size === 0 ? "Visible to everyone" : "Visible only to the roles checked above"}
      </span>
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" disabled={!dirty || saving} onClick={handleSave}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </li>
  );
}

export function ChannelsPanel({
  baseUrl,
  token,
  channels,
  onChannelUpdated,
}: {
  baseUrl: string;
  token: string;
  channels: Channel[];
  onChannelUpdated: (channel: Channel) => void;
}) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRoles(baseUrl, token).then(setRoles).catch((err) => setError(err.message));
  }, [baseUrl, token]);

  const visibilityChannels = channels.filter((c) => c.type === "TEXT" || c.type === "VOICE");
  // @everyone always exists and restricting a channel to it alone is the
  // same as not restricting it at all, so it's excluded from the picker —
  // leaving no role checked already means "everyone".
  const restrictableRoles = roles.filter((r) => r.name !== "@everyone");

  return (
    <div className="settings-section">
      <p className="subtitle">
        Restrict a channel to specific roles — checked members can see and use it, everyone else can't see it at
        all (it won't appear in their sidebar, and direct API/gateway access is blocked too). Leave every role
        unchecked to keep a channel open to everyone, today's default.
      </p>
      {error && <p className="error">{error}</p>}
      {restrictableRoles.length === 0 ? (
        <p className="picker-empty">Create a role first (Roles tab) before restricting a channel to it.</p>
      ) : (
        <ul className="role-list">
          {visibilityChannels.map((channel) => (
            <ChannelPermissionRow
              key={channel.id}
              baseUrl={baseUrl}
              token={token}
              channel={channel}
              roles={restrictableRoles}
              onUpdated={onChannelUpdated}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
