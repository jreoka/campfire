#!/usr/bin/env bash
# deploy/ovh/restore-db.sh
#
# Restore a pg_dump produced by `restore-from-r2.js --fetch` into the local
# Postgres container. Run from /opt/campfire/app.
#
#   docker compose run --rm --no-deps campfire \
#     node scripts/restore-from-r2.js --fetch --out /data/restore
#   bash deploy/ovh/restore-db.sh [dump-path-on-host]
#
# The R2 script deliberately does not run pg_restore for you (--clean drops and
# recreates tables in a live database), so this is the deliberate step. It is
# safe to re-run: --clean --if-exists makes it idempotent.
set -euo pipefail

DUMP="${1:-data/restore/campfire.dump}"
if [ ! -f "$DUMP" ]; then
  echo "no dump at $DUMP — fetch one first:" >&2
  echo "  docker compose run --rm --no-deps campfire node scripts/restore-from-r2.js --fetch --out /data/restore" >&2
  exit 1
fi

# Read just the two names we need rather than sourcing .env — a shell would
# choke on (or worse, interpret) the base64 secrets living in that file.
DB="$(grep -m1 '^POSTGRES_DB=' .env 2>/dev/null | cut -d= -f2- || true)"
USR="$(grep -m1 '^POSTGRES_USER=' .env 2>/dev/null | cut -d= -f2- || true)"
DB="${DB:-campfire}"
USR="${USR:-campfire}"

echo "restoring $DUMP into database '$DB' as '$USR'"
docker compose cp "$DUMP" db:/tmp/restore.dump

# --no-owner: the restoring role owns everything afterwards, which is what a
# single-role deployment wants and avoids failing on a role that exists only in
# the old cluster.
docker compose exec -T db pg_restore -U "$USR" -d "$DB" --clean --if-exists --no-owner /tmp/restore.dump 2>&1 | tail -n 8 || true
docker compose exec -T db rm -f /tmp/restore.dump

# Live state from the OLD cluster must not come along. Replica heartbeats, the
# event bus, voice rosters, rate-limit counters and in-flight WebAuthn
# challenges all describe a cluster this is not; the first boot should build its
# own rather than inherit stale rows that make presence and the bus lie.
echo "clearing runtime tables from the old cluster"
docker compose exec -T db psql -U "$USR" -d "$DB" -c \
  "TRUNCATE bus_replicas, bus_events, live_sessions, voice_occupants, rate_limits, webauthn_challenges;" || true

echo "--- row counts ---"
# No string literals in the SQL: it travels through a shell on both ends, and
# quote-mangling a verification query is a silly way to lose confidence in it.
docker compose exec -T db psql -U "$USR" -d "$DB" -tAc \
  "select (select count(*) from users) as users,
          (select count(*) from servers) as servers,
          (select count(*) from channels) as channels,
          (select count(*) from messages) as messages,
          (select count(*) from attachments) as attachments,
          (select count(*) from dm_messages) as dm_messages,
          (select count(*) from stories) as stories,
          (select count(*) from file_scans) as file_scans;"
