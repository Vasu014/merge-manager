#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
  echo "Run this initial bootstrap as root." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl dbus-user-session jq uidmap

if ! command -v docker >/dev/null || ! command -v dockerd-rootless-setuptool.sh >/dev/null; then
  echo "Install Docker Engine and docker-ce-rootless-extras before running this script." >&2
  exit 1
fi

if ! id deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash deploy
fi
install -d -o deploy -g deploy -m 0750 /opt/merge-manager

deploy_uid=$(id -u deploy)
loginctl enable-linger deploy
systemctl start "user@${deploy_uid}.service"
if [[ ! -f /home/deploy/.config/systemd/user/docker.service ]]; then
  runuser -u deploy -- env HOME=/home/deploy XDG_RUNTIME_DIR="/run/user/${deploy_uid}" \
    dockerd-rootless-setuptool.sh install
fi
runuser -u deploy -- env HOME=/home/deploy XDG_RUNTIME_DIR="/run/user/${deploy_uid}" \
  systemctl --user enable --now docker

echo "Rootless Docker and /opt/merge-manager are ready for the deploy user."
