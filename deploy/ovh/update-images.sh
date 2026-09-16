#!/usr/bin/env bash
# deploy/ovh/update-images.sh
#
# Keep the floating image tags this stack runs at whatever the tag points at
# now, and recreate ONLY the services whose image actually moved. Run by
# campfire-images.timer (see deploy/ovh/systemd/), so the scanner tracks upstream
# ClamAV releases without anyone logging in.
#
#   bash deploy/ovh/update-images.sh                 # the scanner
#   bash deploy/ovh/update-images.sh clamav coturn   # any compose service
#
# Why a script and a timer instead of a watcher container: the thing that gets
# restarted is the malware scanner, and the only checks that mean anything about
# a new engine are the app's own. A watcher cannot run them, and it exists only
# by holding the Docker socket — which is root on this host, where the scanner is
# deliberately not published and the app binds loopback. This needs neither: it
# is the same compose file the deploy uses, and it gates on the acceptance check
# the runbook already names.
#
# An update is accepted only if, in order:
#   1. the new container reports healthy — clamd's own PING healthcheck (a clamd
#      that loaded no database does not get that far at all: the image's
#      entrypoint refuses to start without one);
#   2. `scripts/verify-clamav.js` passes INSIDE the app container. This is the
#      one that matters: a daemon whose database failed to load answers OK to
#      everything, which is worse than no scanner because it is believed, and no
#      healthcheck can tell the difference;
#   3. the app is restarted. Its engine generation is cached in the process
#      (virus-scan.js's `engineIdentity` — what every verdict is recorded
#      against, and what bucket-scan.js compares stored rows to), so a scanner
#      swapped in underneath a RUNNING app keeps stamping the old generation and
#      suppresses the re-sweep a new engine is supposed to trigger. The restart
#      re-probes it, and the new line is logged here.
# If any step fails the previous image is retagged back into place, the container
# is recreated from it, and the refused digest is held in
# /var/lib/campfire/hold/<service> so the timer does not retry the same broken
# image every 30 minutes. Clear that file (`rm`) to try it again.
#
# Nothing here touches Postgres, the volumes or the media bucket: an image swap
# is a container recreate, and `clamdb` (signatures) is a named volume that
# outlives it.
set -euo pipefail

APP_DIR="${CAMPFIRE_DIR:-/opt/campfire/app}"
COMPOSE_FILES=(-f docker-compose.yml -f deploy/ovh/docker-compose.ovh.yml)
HOLD_DIR="${CAMPFIRE_UPDATE_HOLD_DIR:-/var/lib/campfire/hold}"
HEALTH_TIMEOUT="${CAMPFIRE_UPDATE_HEALTH_TIMEOUT:-600}"   # a new engine may reload the database
VERIFY_TIMEOUT="${CAMPFIRE_UPDATE_VERIFY_TIMEOUT:-300}"

SERVICES=("$@")
[ "${#SERVICES[@]}" -gt 0 ] || SERVICES=(clamav)

cd "$APP_DIR" || { printf '[images] %s is not there\n' "$APP_DIR" >&2; exit 1; }
# Fail loudly rather than degrading into "no image for that service, skipped":
# without these two files every run would be a silent no-op that still exits 0.
for f in docker-compose.yml deploy/ovh/docker-compose.ovh.yml; do
  [ -f "$f" ] || { printf '[images] %s/%s is missing — is this the checkout? (CAMPFIRE_DIR overrides)\n' "$APP_DIR" "$f" >&2; exit 1; }
done

compose() { docker compose "${COMPOSE_FILES[@]}" "$@"; }
log() { printf '[images] %s\n' "$*"; }

# The services this compose project defines, so a typo'd name is a loud failure
# rather than a silent skip.
service_exists() { compose config --services 2>/dev/null | grep -qx "$1"; }

# The image a service names, read out of the MERGED config so a `CLAMAV_TAG` pin
# is honoured here rather than second-guessed. Deliberately NOT
# `compose config --images <service>`: for a service that only has a `build:`
# key that flag ignores the filter and prints the first image in the whole file
# (measured on this stack: `--images campfire` answers `postgres:18-alpine`),
# which is how this script once pulled and compared against the wrong image.
# Empty output means there is nothing to pull, which is what a service built
# from this checkout should say.
image_of() {
  compose config 2>/dev/null | awk -v svc="$1" '
    $0 == "  " svc ":"  { inblk = 1; next }
    inblk && /^  [^ ]/   { exit }
    inblk && /^    image:/ { sub(/^    image:[ ]*/, ""); print; exit }
  '
}
image_id()      { docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || true; }
container_of()  { compose ps -q "$1" 2>/dev/null || true; }
# The image the CONTAINER was created from — the only honest answer to "what is
# running", and directly comparable to `docker image inspect .Id` (both are the
# image's own digest; verified on this host). Comparing the local TAG before and
# after a pull instead would be wrong in exactly the case that matters: if the
# tag already moved without the container being recreated (a pull that was
# interrupted, or someone pulling by hand), that comparison reports "up to date"
# and the container never converges.
container_image() {
  local cid
  cid="$(container_of "$1")"
  [ -n "$cid" ] || return 0
  docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true
}
# A container that EXISTS but is not running was stopped on purpose — an operator
# freeing the scanner's ~1 GB, or a host deliberately running without it. A timer
# that resurrected it every 30 minutes would be fighting them, so it is left
# exactly as found. `compose ps -q` lists only RUNNING containers (that is the
# difference that matters here), so the "does one exist at all" question needs
# -a.
stopped_container() {
  [ -n "$(compose ps -aq "$1" 2>/dev/null || true)" ] \
    && [ -z "$(container_of "$1")" ]
}
health_of() {
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$1" 2>/dev/null || echo gone
}

wait_healthy() {
  local cid="$1" waited=0 status
  while :; do
    status="$(health_of "$cid")"
    case "$status" in
      healthy) log "healthy after ${waited}s"; return 0 ;;
      none)    log "no healthcheck on this service — nothing to gate on"; return 0 ;;
      gone)    log "the container disappeared while waiting for it"; return 1 ;;
    esac
    [ "$waited" -lt "$HEALTH_TIMEOUT" ] || return 1
    sleep 10
    waited=$((waited + 10))
  done
}

# The acceptance check, run where CLAMAV_HOST and the client actually live. Its
# output goes to the journal on purpose: that report is the record of what was
# verified before the update was kept. Non-zero exit = not accepted.
verify_scanner() {
  if [ -z "$(container_of campfire)" ]; then
    log "campfire is not running — skipping the acceptance check"
    log "  verify by hand: docker compose ${COMPOSE_FILES[*]} exec -T campfire node scripts/verify-clamav.js"
    return 0
  fi
  timeout "$VERIFY_TIMEOUT" docker compose "${COMPOSE_FILES[@]}" \
    exec -T campfire node scripts/verify-clamav.js
}

# Put the tag back on the image that was serving, and recreate from it. The old
# image is still on disk — the pull moved the TAG, it did not delete anything.
roll_back() {
  local svc="$1" image="$2" previous="$3" refused="$4"
  if [ -z "$previous" ]; then
    log "$svc: nothing to roll back to (no previous image on this host)"
    return 0
  fi
  log "$svc: rolling back to ${previous#sha256:}"
  if ! docker tag "$previous" "$image"; then
    log "$svc: could not retag ${previous#sha256:} — roll back by hand (see the README)"
    return 0
  fi
  if ! compose up -d --no-deps "$svc" >/dev/null; then
    log "$svc: recreating from the previous image FAILED — this needs hands on it"
    return 0
  fi
  mkdir -p "$HOLD_DIR"
  printf '%s\n' "$refused" > "$HOLD_DIR/$svc"
  log "$svc: held ${refused#sha256:} back — rm $HOLD_DIR/$svc to try that image again"
  return 0
}

restart_app_and_confirm() {
  local cid started waited=0 line
  cid="$(container_of campfire)"
  [ -n "$cid" ] || { log "campfire is not running — nothing to re-probe"; return 0; }
  log "restarting campfire so its engine generation re-probes"
  compose restart campfire >/dev/null
  cid="$(container_of campfire)"
  started="$(docker inspect --format '{{.State.StartedAt}}' "$cid" 2>/dev/null || true)"
  case "$started" in *.*) started="${started%%.*}Z" ;; esac
  while [ "$waited" -lt 120 ]; do
    line="$(compose logs --no-log-prefix --since "$started" campfire 2>/dev/null \
      | grep -m1 'ClamAV engine ready' || true)"
    if [ -n "$line" ]; then log "app: $line"; return 0; fi
    sleep 5
    waited=$((waited + 5))
  done
  log "note: no 'ClamAV engine ready' line within 120s — the scanner itself verified, but read the app log"
  return 0
}

failed=0

for svc in "${SERVICES[@]}"; do
  if ! service_exists "$svc"; then
    log "$svc: no such service in this compose file"
    failed=1
    continue
  fi
  image="$(image_of "$svc")"
  if [ -z "$image" ]; then
    log "$svc: built from a Dockerfile, not an image — nothing to pull"
    continue
  fi
  if stopped_container "$svc"; then
    log "$svc: a container exists but is not running — left stopped (start it and this resumes)"
    continue
  fi
  # What the container is running now, versus what the tag points at after the
  # pull. `before` is also the rollback target: the image that was serving.
  before="$(container_image "$svc")"

  log "$svc: $image — pulling"
  if ! compose pull --quiet "$svc"; then
    log "$svc: pull FAILED — leaving ${before:-nothing} running"
    failed=1
    continue
  fi

  after="$(image_id "$image")"
  if [ -z "$after" ]; then
    log "$svc: no local image after the pull"
    failed=1
    continue
  fi
  if [ -n "$before" ] && [ "$before" = "$after" ]; then
    log "$svc: up to date (${after#sha256:})"
    continue
  fi
  if [ -f "$HOLD_DIR/$svc" ] && [ "$(cat "$HOLD_DIR/$svc")" = "$after" ]; then
    log "$svc: ${after#sha256:} is held back (it failed here before) — rm $HOLD_DIR/$svc to retry"
    continue
  fi

  log "$svc: recreating (${before:-no container} -> ${after#sha256:})"
  compose up -d --no-deps "$svc" >/dev/null
  cid="$(container_of "$svc")"
  if [ -z "$cid" ] || ! wait_healthy "$cid"; then
    log "$svc: FAILED — not healthy within ${HEALTH_TIMEOUT}s"
    roll_back "$svc" "$image" "$before" "$after"
    failed=1
    continue
  fi

  if [ "$svc" = "clamav" ]; then
    if ! verify_scanner; then
      log "$svc: FAILED the acceptance check (scripts/verify-clamav.js)"
      roll_back "$svc" "$image" "$before" "$after"
      failed=1
      continue
    fi
    rm -f "$HOLD_DIR/$svc"
    restart_app_and_confirm
  fi

  log "$svc: updated to ${after#sha256:}"
done

exit "$failed"
