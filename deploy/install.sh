#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then
  echo ".env already exists — leaving it alone. Delete it first if you want a fresh install."
  echo "Run 'docker compose up -d' to (re)start with the existing config."
  exit 0
fi

echo "Setting up Outpost..."
echo

read -rp "Public hostname or IP for this server (what clients will connect to): " PUBLIC_HOST
if [ -z "$PUBLIC_HOST" ]; then
  echo "A public hostname/IP is required — voice chat won't work without it (NAT traversal)." >&2
  exit 1
fi

read -rp "GitHub owner of the image to pull [blindrun, i.e. the official image — override only if you forked/built your own]: " IMAGE_OWNER
IMAGE_OWNER="${IMAGE_OWNER:-blindrun}"

rand() { openssl rand -hex 32; }

JWT_SECRET="$(rand)"
POSTGRES_PASSWORD="$(rand)"
MINIO_ROOT_PASSWORD="$(rand)"
LIVEKIT_API_KEY="APIkey$(openssl rand -hex 8)"
LIVEKIT_API_SECRET="$(rand)"

cp .env.example .env
# Portable in-place sed (macOS/BSD sed needs a backup-suffix arg; GNU sed's -i '' also works with one).
sedi() { sed -i.bak "$1" .env && rm -f .env.bak; }

sedi "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|"
sedi "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|"
sedi "s|^MINIO_ROOT_PASSWORD=.*|MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}|"
sedi "s|^LIVEKIT_API_KEY=.*|LIVEKIT_API_KEY=${LIVEKIT_API_KEY}|"
sedi "s|^LIVEKIT_API_SECRET=.*|LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET}|"
sedi "s|^LIVEKIT_URL=.*|LIVEKIT_URL=ws://${PUBLIC_HOST}:7880|"
sedi "s|^MINIO_PUBLIC_URL=.*|MINIO_PUBLIC_URL=http://${PUBLIC_HOST}:9000/outpost-uploads|"
sedi "s|^APP_IMAGE=.*|APP_IMAGE=ghcr.io/${IMAGE_OWNER}/outpost-chat:latest|"

sed -e "s|__LIVEKIT_API_KEY__|${LIVEKIT_API_KEY}|" -e "s|__LIVEKIT_API_SECRET__|${LIVEKIT_API_SECRET}|" \
  livekit.yaml.template > livekit.yaml

echo
echo "Generated .env and livekit.yaml."
echo "Starting Outpost..."
docker compose up -d

echo
echo "Outpost is starting up. Once ready:"
echo "  Web:      http://${PUBLIC_HOST}:${APP_PORT:-8080}"
echo "  Desktop:  install the Outpost desktop app, then add this address as a server:"
echo "            ${PUBLIC_HOST}:${APP_PORT:-8080}"
echo
echo "The first account you register becomes the instance owner."
