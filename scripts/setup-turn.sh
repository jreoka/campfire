#!/usr/bin/env bash
# Campfire TURN setup — run as root on the production VPS:
#   ssh root@campfire.dill.moe bash -s < scripts/setup-turn.sh
# Installs coturn (TURN relay for WebRTC voice behind strict NAT / CGNAT),
# stores the password in /opt/campfire/.env (never in git).
# Idempotent: safe to re-run (keeps the existing TURN_PASS).
set -euo pipefail

DOMAIN="${DOMAIN:-campfire.dill.moe}"
TURN_USER="${TURN_USER:-campfire}"
APP_DIR="${APP_DIR:-/opt/campfire}"
ENV_FILE="$APP_DIR/.env"

# Public IP: prefer the DNS A record for DOMAIN, fall back to first local addr.
PUBIP="$(getent hosts "$DOMAIN" | awk '{ print $1 }' | head -n 1)"
if [ -z "$PUBIP" ]; then
  PUBIP="$(hostname -I | awk '{ print $1 }')"
fi
echo "[turn] public ip: $PUBIP"

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq coturn openssl curl

touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
if ! grep -q '^TURN_PASS=' "$ENV_FILE"; then
  PASS="$(openssl rand -base64 24 | tr -d '\n')"
  printf 'TURN_PASS=%s\n' "$PASS" >> "$ENV_FILE"
  echo '[turn] generated TURN_PASS in .env'
fi
if ! grep -q '^TURN_USER=' "$ENV_FILE"; then
  printf 'TURN_USER=%s\n' "$TURN_USER" >> "$ENV_FILE"
fi
if ! grep -q '^TURN_URL=' "$ENV_FILE"; then
  printf 'TURN_URL=turn:%s:3478\n' "$DOMAIN" >> "$ENV_FILE"
fi
TURN_PASS="$(sed -n 's/^TURN_PASS=//p' "$ENV_FILE" | tail -n 1)"

cat > /etc/turnserver.conf <<EOF
# managed by campfire scripts/setup-turn.sh — do not hand-edit, re-run the script
realm=$DOMAIN
server-name=$DOMAIN
listening-port=3478
alt-listening-port=3479
listening-ip=0.0.0.0
external-ip=$PUBIP
min-port=49160
max-port=49200
fingerprint
lt-cred-mech
user=$TURN_USER:$TURN_PASS
# abuse guardrails: Opus audio needs ~64 kbit/s per stream
total-quota=100
bps-cap=262144
stale-nonce=600
# internet clients never need relaying to private ranges
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
simple-log
log-file=/var/log/turnserver.log
no-stdout-log
EOF
chmod 600 /etc/turnserver.conf

if grep -q 'TURNSERVER_ENABLED=' /etc/default/coturn 2>/dev/null; then
  sed -i 's/^#*TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
else
  printf 'TURNSERVER_ENABLED=1\n' >> /etc/default/coturn
fi

# Open the firewall only if ufw is active (currently inactive on this host).
if ufw status 2>/dev/null | grep -q active; then
  ufw allow 3478/udp
  ufw allow 3478/tcp
  ufw allow 3479/tcp
  ufw allow 49160:49200/udp
fi

systemctl enable --now coturn >/dev/null
systemctl restart coturn
sleep 2
systemctl is-active --quiet coturn
ss -lntu | grep 3478
echo '[turn] OK — coturn active'
