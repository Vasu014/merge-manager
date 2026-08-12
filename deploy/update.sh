#!/usr/bin/env bash
set -euo pipefail

exec 9>/tmp/merge-manager-update.lock
flock -n 9 || exit 0

deployment_dir=/opt/merge-manager
repository=Vasu014/merge-manager
api_url="https://api.github.com/repos/${repository}/commits/main"
sha=$(curl --fail --silent --show-error --location \
  --header 'Accept: application/vnd.github+json' \
  --header 'User-Agent: merge-manager-hetzner-updater' \
  "$api_url" | jq --exit-status --raw-output '.sha | select(test("^[0-9a-f]{40}$"))')
image="ghcr.io/vasu014/merge-manager:${sha}"

current_image=$(awk -F= '$1 == "IMAGE" { print substr($0, index($0, "=") + 1); exit }' "$deployment_dir/.env")
if [[ "$current_image" == "$image" ]]; then
  exit 0
fi

temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
raw_base="https://raw.githubusercontent.com/${repository}/${sha}/deploy"
curl --fail --silent --show-error --location "$raw_base/compose.yaml" --output "$temporary/compose.yaml"
curl --fail --silent --show-error --location "$raw_base/deploy.sh" --output "$temporary/deploy.sh"
chmod 0755 "$temporary/deploy.sh"
bash -n "$temporary/deploy.sh"

cp --archive "$deployment_dir/compose.yaml" "$temporary/compose.previous.yaml" 2>/dev/null || true
cp --archive "$deployment_dir/deploy.sh" "$temporary/deploy.previous.sh" 2>/dev/null || true
install -m 0644 "$temporary/compose.yaml" "$deployment_dir/compose.yaml"
install -m 0755 "$temporary/deploy.sh" "$deployment_dir/deploy.sh"

if ! "$deployment_dir/deploy.sh" "$image"; then
  [[ -f "$temporary/compose.previous.yaml" ]] && install -m 0644 "$temporary/compose.previous.yaml" "$deployment_dir/compose.yaml"
  [[ -f "$temporary/deploy.previous.sh" ]] && install -m 0755 "$temporary/deploy.previous.sh" "$deployment_dir/deploy.sh"
  exit 1
fi
