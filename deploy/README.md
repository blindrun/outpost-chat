# Self-hosting Outpost

This is the "one-click" way to run your own Outpost instance. It brings up
four containers: the app (API + web client), Postgres, LiveKit (voice/video),
and MinIO (file storage).

## Requirements

- Docker + the Docker Compose plugin (`docker compose version` should work)
- A server with a public IP or domain — voice chat needs this even for a
  LAN-only deployment behind NAT, since LiveKit advertises it to clients for
  connectivity
- Open/forwarded ports: `8080` (app, configurable via `APP_PORT`), `7880` +
  `7881` TCP (LiveKit signaling), `50000-60000` UDP (LiveKit media) — the
  LiveKit ports are fixed, not configurable, since LiveKit runs with Docker
  host networking (see the compose file comments for why). Add `80` + `443`
  too if you're setting up HTTPS (see below) — recommended, required for
  voice chat.

## Quick install

```bash
git clone https://github.com/blindrun/outpost-chat.git
cd outpost-chat/deploy
./install.sh
```

It'll ask for your server's public hostname/IP, a GitHub owner (to pull the
pre-built image from `ghcr.io`), and whether to set up HTTPS — say yes unless
this is purely LAN/local testing (see [TLS](#tls--reverse-proxy-required-for-voice)
below for why). It generates every secret and starts everything with
`docker compose up -d`.

A fresh instance prints a one-time claim code to its own log at startup
(`docker compose logs app` — `install.sh` also waits for and prints it
directly). The client shows a "Claim This Server" prompt until someone
enters that code, which is what actually creates the owner account —
nobody can register at all before that, so there's no race to be the
first (real) user.

## TLS / reverse proxy (required for voice)

Browsers only allow microphone access (`getUserMedia`) on a secure (HTTPS)
page, so voice chat needs this instance behind HTTPS. That has a
non-obvious consequence: voice signaling (served by LiveKit) needs to be
reachable from the **same** HTTPS origin as the app — pointing it at a
bare `ws://host:7880` instead breaks silently, since browsers flatly
refuse to even attempt an insecure WebSocket from a secure page (voice
never connects, `DOMException: The operation is insecure` in the
console). Avatars/attachments/emoji are served by the app itself (not
MinIO directly — see [private uploads](#uploads-are-private) below), so
they don't have this problem.

If you said yes to the HTTPS prompt, `install.sh` already generated a
ready-to-use `Caddyfile` in this directory that proxies `/rtc/*` (LiveKit
signaling) through the same site as the app, and set `LIVEKIT_URL` in
`.env` to the matching `wss://` address. To actually put it in effect:

```bash
# Install Caddy if it isn't already: https://caddyserver.com/docs/install
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Make sure your domain's DNS already points at this server before reloading
— Caddy fetches a real Let's Encrypt certificate automatically on first
request, no manual cert setup needed. Using a different reverse proxy
(nginx, Traefik, etc.) instead of Caddy is fine too — just replicate the
same two routes (`/rtc/*` → LiveKit, everything else → the app) under one
HTTPS site.

If you're testing on a LAN with no domain/TLS, you can skip this — voice
chat just won't work until you add it later (re-run `install.sh` after
deleting `.env` to add TLS to an existing install).

## Uploads are private

Avatars, message attachments, and custom emoji are stored in MinIO, but
the bucket itself is private — MinIO's own port isn't reachable from
outside this host at all (see `docker-compose.yml`, bound to
`127.0.0.1`). The app serves them itself through an authenticated route
(`GET /outpost-uploads/*`), so a leaked or guessed file URL doesn't work
on its own; it has to come with a live, non-banned session token (the web
and desktop clients handle this automatically). Need to browse the bucket
directly for some reason? Tunnel in rather than opening the port:
`ssh -L 9001:localhost:9001 <this-host>`, then open
`http://localhost:9001` for the MinIO console.

## Single sign-on (optional)

Outpost can hand login off to any provider that speaks standard OpenID
Connect discovery — Authentik, Authelia, Keycloak, Zitadel, Okta, Entra.
It's off unless configured; leave these unset and nothing changes.

In your provider, create an OAuth2/OIDC application:

- **Redirect URI:** `https://chat.example.com/auth/oidc/callback` (your own
  host). It has to match exactly, trailing slash and all.
- **Grant type:** authorization code. Outpost uses PKCE and a client secret
  together, so a *confidential* client is the right kind.
- **Scopes:** `openid profile email`. The email claim is required — Outpost
  uses it to create the account, and won't create one without it.

Then in `.env`:

```bash
OIDC_ISSUER=https://auth.example.com/application/o/outpost
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...
OIDC_DISPLAY_NAME=Authentik      # button reads "Continue with Authentik"
# OIDC_SCOPES=openid profile email
# OIDC_ALLOW_SIGNUP=false        # existing members only; default is true
# OIDC_REDIRECT_URI=https://...  # only if this server sees a different
                                 # host than the browser does
```

`OIDC_ISSUER` is the base URL whose `/.well-known/openid-configuration`
your provider serves — paste that URL into a browser to check you have the
right one. It must be `https` (or localhost, for testing).

Worth knowing before you switch it on:

- **The first account can't be created this way.** Claim the instance with
  the claim code from its console first, then link or add SSO accounts.
- **Existing accounts are matched by email**, and only if your provider
  says the address is verified. After that the link is by the provider's
  own user ID, so changing someone's email at the provider doesn't strand
  their account.
- **SSO accounts have no password**, so they can't use the password form or
  "forgot password" — that's the point. They can still delete their own
  account, and 2FA configured *here* is still enforced on top of whatever
  the provider does.
- **`OIDC_ALLOW_SIGNUP` defaults to true**, so anyone your provider will
  authenticate gets an account, invite-only setting included. Set it to
  `false` if your provider is broader than your chat instance should be.
- **The desktop app signs in through your own browser.** It opens the
  provider there — so if you already have a session with it, this is
  usually one click — and the result comes back to the app through an
  `outpost://` link that the installer registers. Nothing extra to
  configure, but it does mean the desktop app has to be installed rather
  than run from an unpacked directory for the handover to work.
- **The mobile apps don't do SSO yet**; they show a note pointing at your
  instance's web address, which works normally in a phone browser.

## Encryption, and where your client comes from

Encrypted direct messages are encrypted and decrypted in the browser or app
you are using. The keys are generated on your device and never sent to the
server. That means the code doing the encrypting matters as much as the
server does: whoever serves your client could, in principle, serve a build
that keeps a copy of the plaintext.

When you self-host, your client is served by your own instance. You are the
only one in that position, which is the point.

If you connect through a client someone else hosts, you are trusting them not
to do that. That is a reasonable trade for convenience, and it is the same
trade every hosted web client asks you to make. But if end-to-end encryption
is why you are here, use the client your own server serves, or the desktop
app, which is signed and runs locally.

Keys live in IndexedDB and are non-extractable by design, which also means
they cannot follow you between origins. Opening the same account through a
different client origin is a new device as far as encryption is concerned:
you will need your recovery code.

## Connecting over plain HTTP

A client served over HTTPS cannot talk to a backend over plain `http://`.
Browsers block it as mixed content, and there is nothing the app can do about
that.

This only bites if you run Outpost on a LAN address with no certificate and
try to reach it from a client hosted somewhere else. Your own instance serving
its own client over HTTP to itself is fine. If you want both, put a
certificate on it -- Caddy with an internal CA, or a real one via DNS-01, both
work on a LAN with no public exposure.

## Manual install

If you'd rather not run the script:

```bash
cp .env.example .env
# edit .env: fill in JWT_SECRET, POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD,
# LIVEKIT_API_KEY, LIVEKIT_API_SECRET (random strings — `openssl rand -hex 32`
# works well), and set LIVEKIT_URL / MINIO_PUBLIC_URL to your real public
# host — see the TLS section below for which scheme/URL shape to use.

sed -e "s|__LIVEKIT_API_KEY__|<the key you just picked>|" \
    -e "s|__LIVEKIT_API_SECRET__|<the secret you just picked>|" \
    livekit.yaml.template > livekit.yaml

docker compose up -d
```

## Building the image yourself instead of pulling it

If you don't want to depend on a pre-built `ghcr.io` image (or are testing an
unreleased change):

```bash
docker build -t outpost-chat:local -f ../Dockerfile ..
APP_IMAGE=outpost-chat:local docker compose up -d
```

## Updating

```bash
docker compose pull
docker compose up -d
```

Database migrations run automatically on container start.

## Backing up

Everything that matters lives in two named volumes: `outpost-pgdata`
(Postgres — accounts, messages, channels, roles) and `outpost-minio`
(uploaded avatars/attachments). Back up both.

## Known limitation

Uploaded files (avatars, attachments) are stored in a **public-read** MinIO
bucket — anyone with the URL can view them, there's no per-file access
control. Fine for avatars/casual attachments; don't rely on this for
anything sensitive.
