# Self-hosting Harmony

This is the "one-click" way to run your own Harmony instance. It brings up
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
  host networking (see the compose file comments for why)

## Quick install

```bash
git clone https://github.com/blindrun/harmony-chat.git
cd harmony-chat/deploy
./install.sh
```

It'll ask for your server's public hostname/IP and a GitHub owner (to pull
the pre-built image from `ghcr.io`), generate every secret, and start
everything with `docker compose up -d`.

The first account anyone registers on a fresh instance becomes the owner.

## Manual install

If you'd rather not run the script:

```bash
cp .env.example .env
# edit .env: fill in JWT_SECRET, POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD,
# LIVEKIT_API_KEY, LIVEKIT_API_SECRET (random strings — `openssl rand -hex 32`
# works well), and set LIVEKIT_URL / MINIO_PUBLIC_URL to your real
# public host.

sed -e "s|__LIVEKIT_API_KEY__|<the key you just picked>|" \
    -e "s|__LIVEKIT_API_SECRET__|<the secret you just picked>|" \
    livekit.yaml.template > livekit.yaml

docker compose up -d
```

## Building the image yourself instead of pulling it

If you don't want to depend on a pre-built `ghcr.io` image (or are testing an
unreleased change):

```bash
docker build -t harmony-chat:local -f ../Dockerfile ..
APP_IMAGE=harmony-chat:local docker compose up -d
```

## Updating

```bash
docker compose pull
docker compose up -d
```

Database migrations run automatically on container start.

## Backing up

Everything that matters lives in two named volumes: `harmony-pgdata`
(Postgres — accounts, messages, channels, roles) and `harmony-minio`
(uploaded avatars/attachments). Back up both.

## Known limitation

Uploaded files (avatars, attachments) are stored in a **public-read** MinIO
bucket — anyone with the URL can view them, there's no per-file access
control. Fine for avatars/casual attachments; don't rely on this for
anything sensitive.
