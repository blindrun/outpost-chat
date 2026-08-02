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

# Voice chat needs a secure context (browsers block microphone access
# otherwise), which means this instance needs to sit behind HTTPS. Whichever
# way you answer, avatars/attachments and voice signaling both need to be
# served from the *same* origin as the app — a bare MinIO/LiveKit port has no
# TLS of its own, and browsers silently break (images) or flatly refuse
# (the voice websocket) mixed http-content on an https page. Answering yes
# here generates a ready-to-use Caddyfile that proxies both through the same
# HTTPS site instead of exposing those raw ports directly.
read -rp "Will this run behind an HTTPS reverse proxy, e.g. Caddy? (strongly recommended — required for voice chat) [Y/n]: " USE_TLS
USE_TLS="${USE_TLS:-Y}"

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
APP_PORT="${APP_PORT:-8080}"

if [[ "$USE_TLS" =~ ^[Yy] ]]; then
  sedi "s|^LIVEKIT_URL=.*|LIVEKIT_URL=wss://${PUBLIC_HOST}|"
  sedi "s|^MINIO_PUBLIC_URL=.*|MINIO_PUBLIC_URL=https://${PUBLIC_HOST}/outpost-uploads|"
else
  sedi "s|^LIVEKIT_URL=.*|LIVEKIT_URL=ws://${PUBLIC_HOST}:7880|"
  sedi "s|^MINIO_PUBLIC_URL=.*|MINIO_PUBLIC_URL=http://${PUBLIC_HOST}:${APP_PORT}/outpost-uploads|"
fi
sedi "s|^APP_IMAGE=.*|APP_IMAGE=ghcr.io/${IMAGE_OWNER}/outpost-chat:latest|"

sed -e "s|__LIVEKIT_API_KEY__|${LIVEKIT_API_KEY}|" -e "s|__LIVEKIT_API_SECRET__|${LIVEKIT_API_SECRET}|" \
  livekit.yaml.template > livekit.yaml

if [[ "$USE_TLS" =~ ^[Yy] ]]; then
  sed -e "s|__PUBLIC_HOST__|${PUBLIC_HOST}|" -e "s|__APP_PORT__|${APP_PORT}|" \
    Caddyfile.template > Caddyfile
fi

echo
echo "Generated .env and livekit.yaml."
echo "Starting Outpost..."
docker compose up -d

echo
echo "Waiting for the claim code (a fresh instance needs this to register its"
echo "owner account, printed once at startup)..."
CLAIM_CODE=""
for _ in $(seq 1 30); do
  CLAIM_CODE=$(docker compose logs app 2>/dev/null | grep -oE '[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}' | tail -1 || true)
  [[ -n "$CLAIM_CODE" ]] && break
  sleep 1
done
if [[ -n "$CLAIM_CODE" ]]; then
  echo "Claim code: ${CLAIM_CODE}"
  echo "(also printed anytime in 'docker compose logs app' until it's used)"
else
  echo "Didn't see it yet — check 'docker compose logs app' once the app"
  echo "container is up."
fi

echo
if [[ "$USE_TLS" =~ ^[Yy] ]]; then
  echo "Generated ./Caddyfile — install Caddy (https://caddyserver.com/docs/install)"
  echo "on this host if it isn't already, then:"
  echo "  sudo cp Caddyfile /etc/caddy/Caddyfile"
  echo "  sudo systemctl reload caddy"
  echo "Caddy will fetch a real Let's Encrypt cert automatically — make sure"
  echo "${PUBLIC_HOST} already resolves to this server first."
  echo
  echo "Outpost is starting up. Once Caddy is reloaded:"
  echo "  Web:      https://${PUBLIC_HOST}"
  echo "  Desktop:  install the Outpost desktop app, then add this address as a server:"
  echo "            ${PUBLIC_HOST}"
else
  echo "Skipped TLS setup — voice chat will NOT work (browsers require HTTPS for"
  echo "microphone access) until this instance is behind a reverse proxy. Re-run"
  echo "install.sh after deleting .env if you want to add that now."
  echo
  echo "Outpost is starting up. Once ready:"
  echo "  Web:      http://${PUBLIC_HOST}:${APP_PORT}"
  echo "  Desktop:  install the Outpost desktop app, then add this address as a server:"
  echo "            ${PUBLIC_HOST}:${APP_PORT}"
fi
echo
echo "The client shows a \"Claim This Server\" prompt for a fresh instance —"
echo "enter the claim code above there to register the owner account."
