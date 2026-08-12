# Compatibility

From v0.6.1 onward, a client and the server it talks to are not assumed to be
the same version.

Before this, they always were. The client is built into the same Docker image
as the server, so a self-hoster ran one version of both and nothing could drift.
That is no longer the only shape:

- A hosted web client can talk to any instance, and it updates on its own
  schedule rather than the instance's.
- The desktop app auto-updates. It will regularly be newer than a server
  someone has not upgraded yet.
- People run older builds for a long time. That is a normal thing to do with
  self-hosted software, not a mistake to design around.

This has already caused one real outage-shaped bug. A just-updated desktop
client sent a permission the production backend did not have yet, and the
result was a confusing 500 rather than a clear "this server is older".

## What the server promises

- **Fields are added, never removed or renamed.** If a REST response or a
  gateway event includes a field today, it keeps including it.
- **Endpoints and gateway ops are not removed.** A route that exists keeps
  existing and keeps accepting the shape it accepts today.
- **New request fields are optional.** A request that was valid before stays
  valid. Anything new gets a safe default on the server.
- **New behaviour is announced, not implied.** If a feature can be absent, it
  gets a flag in `GET /instance-info` alongside `gifSearchEnabled`,
  `turnstileSiteKey` and `levelingEnabled`.

## What the client promises

- **Feature-detect on the flag, not the version.** `/instance-info` returns
  `version`, but do not branch on it. Version comparisons break against forks,
  against pre-release builds, and against anyone who has patched their own
  instance. A missing capability flag means the feature is not there.
- **Unknown fields and unknown events are ignored, not fatal.** A newer server
  will send things an older client has never heard of. Drop them quietly.
- **A missing capability hides its UI.** It does not show a control that
  errors when pressed.

## What is not covered

- The database schema and Prisma migrations. Those are internal.
- The contents of the Docker image.
- Anything explicitly documented as experimental at the time it ships.

## Removing something anyway

Sometimes a field really does have to go. The sequence is: mark it deprecated
in this file with the version, keep serving it for at least three releases,
and only then remove it. A deprecation that has not been written down here has
not started.

No deprecations are outstanding.
