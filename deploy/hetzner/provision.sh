#!/usr/bin/env bash
# deploy/hetzner/provision.sh
#
# One-shot provisioning for a fresh Ubuntu Hetzner Cloud VPS that will run
# Campfire. Idempotent — safe to re-run.
#
#   scp deploy/hetzner/provision.sh root@<ip>:/root/provision.sh
#   ssh root@<ip> bash /root/provision.sh
#
# Deliberate choices:
#   * NO inbound 80/443. The site is served through a Cloudflare Tunnel, which is
#     outbound-only: cloudflared dials out and Cloudflare terminates TLS. The only
#     inbound ports are ssh and the coturn relay.
#   * swap is OOM insurance, not a working set. 8 GB holds the app, Postgres and
#     clamd (~1 GB) with room to spare; swappiness=10 keeps the kernel out of it
#     unless something is genuinely about to die — and an OOM killer picking
#     Postgres is the failure this prevents.
#   * Docker comes from Ubuntu's own archive rather than Docker's apt repo, which
#     may not have published packages for this Ubuntu release's codename yet.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

log() { printf '\n=== %s\n' "$*"; }

log "apt update + upgrade"
apt-get update -qq
apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade

log "base packages"
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git jq ufw fail2ban unattended-upgrades \
  docker.io docker-compose-v2

log "docker"
systemctl enable --now docker
docker --version
if docker compose version >/dev/null 2>&1; then
  docker compose version
else
  echo "FATAL: the 'docker compose' plugin is missing (docker-compose-v2)" >&2
  exit 1
fi

log "docker daemon: bounded json-file logs"
# Without this a long-lived host fills its disk with container logs.
mkdir -p /etc/docker
if [ ! -f /etc/docker/daemon.json ] || ! grep -q max-size /etc/docker/daemon.json; then
  cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
  systemctl restart docker
fi

log "swap (2 GiB OOM insurance)"
if ! swapon --show | grep -q '/swapfile'; then
  if ! fallocate -l 2G /swapfile 2>/dev/null; then
    dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  fi
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=10 >/dev/null
# Ubuntu 26.04 no longer ships /etc/sysctl.conf; drop-in files are the right place.
if ! grep -rqs '^vm.swappiness' /etc/sysctl.d/ /etc/sysctl.conf 2>/dev/null; then
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-campfire.conf
fi

log "firewall (ssh + coturn only)"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    comment 'ssh'
ufw allow 3478/udp  comment 'coturn'
ufw allow 3478/tcp  comment 'coturn'
ufw allow 3479/tcp  comment 'coturn turns'
ufw allow 49160:49200/udp comment 'coturn relay range'
ufw --force enable
ufw status verbose

log "fail2ban + unattended security upgrades"
# unattended-upgrades is a oneshot service: `enable --now` can report failure
# even when it is enabled and the timer is armed, which under `set -e` would
# abort a provisioning run that actually succeeded. Judge by the timer instead.
systemctl enable --now fail2ban
systemctl enable unattended-upgrades || true
systemctl start unattended-upgrades || true
systemctl is-enabled unattended-upgrades
systemctl list-timers 'apt-daily*' --no-pager | head -3 || true

log "campfire directory"
mkdir -p /opt/campfire/data
chmod 700 /opt/campfire

log "summary"
echo "docker : $(docker --version)"
echo "compose: $(docker compose version --short 2>/dev/null || echo '?')"
echo "swap   : $(swapon --show=size --noheadings | tr -d ' ' || echo none)"
echo "ufw    : $(ufw status | head -1)"
echo "kernel : $(uname -r)"
echo
echo "If apt upgraded the kernel, reboot at a convenient moment."
