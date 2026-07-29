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

The first account anyone registers on a fresh instance becomes the owner.

## TLS / reverse proxy (required for voice)

Browsers only allow microphone access (`getUserMedia`) on a secure (HTTPS)
page, so voice chat needs this instance behind HTTPS. That has a
non-obvious consequence: avatars/attachments (served by MinIO) and voice
signaling (served by LiveKit) both need to be reachable from the **same**
HTTPS origin as the app — pointing them at a bare `http://host:9000` or
`ws://host:7880` instead breaks silently. Browsers auto-upgrade insecure
`<img>` requests to HTTPS and just fail if nothing's listening there
(broken avatar/icon images, no visible error); they flatly refuse to even
attempt an insecure WebSocket from a secure page (voice never connects,
`DOMException: The operation is insecure` in the console).

If you said yes to the HTTPS prompt, `install.sh` already generated a
ready-to-use `Caddyfile` in this directory that proxies both
`/outpost-uploads/*` (MinIO) and `/rtc/*` (LiveKit signaling) through the
same site as the app, and set `LIVEKIT_URL`/`MINIO_PUBLIC_URL` in `.env` to
the matching `wss://`/`https://` addresses. To actually put it in effect:

```bash
# Install Caddy if it isn't already: https://caddyserver.com/docs/install
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Make sure your domain's DNS already points at this server before reloading
— Caddy fetches a real Let's Encrypt certificate automatically on first
request, no manual cert setup needed. Using a different reverse proxy
(nginx, Traefik, etc.) instead of Caddy is fine too — just replicate the
same three routes (app, `/outpost-uploads/*` → MinIO, `/rtc/*` → LiveKit)
under one HTTPS site.

If you're testing on a LAN with no domain/TLS, you can skip this — voice
chat just won't work until you add it later (re-run `install.sh` after
deleting `.env` to add TLS to an existing install).

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
