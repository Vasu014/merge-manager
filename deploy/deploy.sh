#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^ghcr\.io/vasu014/merge-manager:[0-9a-f]{40}$ ]]; then
  echo "usage: $0 ghcr.io/vasu014/merge-manager:<40-character-git-sha>" >&2
  exit 2
fi

cd "$(dirname "${BASH_SOURCE[0]}")"
test -f .env || { echo "missing $(pwd)/.env" >&2; exit 1; }
export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
export COMPOSE_PROJECT_NAME=merge-manager

next_image=$1
previous_image=$(awk -F= '$1 == "IMAGE" { print substr($0, index($0, "=") + 1); exit }' .env)
test -n "$previous_image" || { echo "IMAGE is missing from .env" >&2; exit 1; }

set_image() {
  local image=$1
  local temporary
  temporary=$(mktemp)
  awk -v image="$image" 'BEGIN { changed=0 } $1 ~ /^IMAGE=/ { print "IMAGE=" image; changed=1; next } { print } END { if (!changed) print "IMAGE=" image }' .env > "$temporary"
  chmod --reference=.env "$temporary"
  mv "$temporary" .env
}

rollback() {
  echo "Deployment failed; restoring $previous_image" >&2
  set_image "$previous_image"
  docker compose pull merge-manager || true
  docker compose up -d --wait || true
}
trap rollback ERR

set_image "$next_image"
docker compose pull merge-manager
docker compose up -d --wait
docker compose exec -T merge-manager node -e \
  "fetch('http://127.0.0.1:3000/health').then(async r => { if (!r.ok) throw new Error(await r.text()) })"

trap - ERR
docker image prune -f --filter 'until=168h' >/dev/null
echo "Deployed $next_image"
