#!/usr/bin/env bash
# One-time setup of a fresh OCI Ubuntu 24.04 VM for the workflow app.
# Run from the cloned repo as the default "ubuntu" user:
#
#   sudo deploy/oci/setup-vm.sh
#
# Safe to run again. It:
#   1. opens ports 80 and 443 in the VM's own firewall (OCI's Ubuntu images
#      ship iptables rules that reject everything but SSH, on top of the
#      VCN security list),
#   2. installs Docker Engine and the compose plugin from Docker's apt repo,
#   3. creates the data folders the containers mount,
#   4. installs the daily jobs (work generation, backup) in /etc/cron.d.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo $0" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_USER="${SUDO_USER:-ubuntu}"
DATA_ROOT="${DATA_ROOT:-/srv/workflow}"

echo "==> Firewall: allowing 80/tcp, 443/tcp, 443/udp"
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent ca-certificates curl git
allow() { # proto port
  if ! iptables -C INPUT -p "$1" --dport "$2" -m state --state NEW -j ACCEPT 2>/dev/null; then
    # Insert above the image's catch-all REJECT, or append if there isn't one.
    local reject
    reject="$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')"
    if [[ -n "$reject" ]]; then
      iptables -I INPUT "$reject" -p "$1" --dport "$2" -m state --state NEW -j ACCEPT
    else
      iptables -A INPUT -p "$1" --dport "$2" -m state --state NEW -j ACCEPT
    fi
  fi
}
allow tcp 80
allow tcp 443
allow udp 443
netfilter-persistent save

echo "==> Docker"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
usermod -aG docker "$APP_USER"

echo "==> Data folders under $DATA_ROOT"
# The app runs as the image's "node" user (uid 1000).
install -d -m 0750 -o 1000 -g 1000 "$DATA_ROOT/data" "$DATA_ROOT/storage"
install -d -m 0755 -o "$APP_USER" -g "$APP_USER" "$DATA_ROOT/logs"

echo "==> Daily jobs (/etc/cron.d/workflow)"
cat > /etc/cron.d/workflow <<EOF
# Installed by deploy/oci/setup-vm.sh. Times are the VM's clock (UTC by default).
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Open new accounting periods and generate their work.
0 6 * * * $APP_USER $REPO_DIR/deploy/oci/ops.sh generate-periods >> $DATA_ROOT/logs/cron.log 2>&1
# Encrypted backup of the database and uploaded files, keeping the last 14.
30 2 * * * $APP_USER $REPO_DIR/deploy/oci/ops.sh backup >> $DATA_ROOT/logs/cron.log 2>&1
EOF
chmod 0644 /etc/cron.d/workflow

echo
echo "Done. Log out and back in so '$APP_USER' can use docker without sudo."
echo "Next: create deploy/oci/.env (README.md step 8), then run deploy/oci/deploy.sh."
