# Campfire on a single OVHcloud VPS

Production since 2026-09-13 (on Hetzner), moved to OVHcloud on 2026-09-14.

| | |
|---|---|
| Host | OVHcloud VPS `vps-74850aa1`, **2 vCPU / 4 GB / 38 GB** |
| Address | `40.160.90.108` (IPv6 `2604:2dc0:101:200::49bd`) |
| OS | Ubuntu 26.04, Docker 29.1.3 + Compose 2.40.3 |
| Ingress | Cloudflare Tunnel only - **no inbound 80/443**, so no certs to renew |
| Media | OVH object storage, bucket `campfire` (see §Media storage) |
| Cost | cheaper than the Hetzner CX33 it replaced - that was the reason for the move |

## Why we moved, twice

**Off the old single-vCPU node (onto Hetzner).** That node had **`cpu=890m`,
`mem=1193460Ki` (~1165 MiB) allocatable**, and the resident scanner then in use
needed about a gigabyte - 996 MiB measured on production - so it ran
`VIRUS_SCAN=0`. That was an accepted trade-off, not an oversight: AV scanning was
the one feature that node could not afford. The CX33 had 8 GB, so **scanning came
back on**, and the app got 4 cores instead of 1 - which was the other long-standing
complaint (two niced ffmpeg encodes made the app feel sluggish on one vCPU).

**Off Hetzner to here (2026-09-14), for cost.** The honest trade: this box is
*smaller* - 2 vCPU / 4 GB against the CX33's 4 vCPU / 8 GB - and the stack's own
limits are `1.5g` (app) + `1g` (db) + `1.5g` (clamav) plus cloudflared and coturn,
so the headroom is thinner than it was, not fatter. It idles around 700 MB used
with ~3 GB available and no OOM events so far, but the two concurrent niced
ffmpeg encodes are the thing to watch on this host. Nothing about the app itself
changed in the move: it was a database dump-and-restore plus a tunnel connector
swap, and the media moved separately to OVH object storage in the same session.

Scanning is **ClamAV in its own container** and it is the largest single consumer
on the box: a loaded `clamd` holds ~1.0 GiB of signatures resident (measured, see
"Uploads, scanning and compression"). That is the price of signature-based
detection and it is why the app's own limit came down from `2g` to `1.5g` when
the scanner arrived - the three limits now add up to what the host actually has.

## Layout on the host

```
/opt/campfire/app        git clone of this repo, on origin/main
/opt/campfire/app/.env   ALL secrets, mode 600, gitignored
/opt/campfire/app/data   local uploads dir (S3 mode ignores it; it exists so a
                         deploy with broken S3_* fails loudly instead of
                         writing uploads into the image layer)
```

Nothing is hand-edited except `.env`. No manifest, no kustomize, no `kubectl`
patches - a deploy is a `git pull` and a `compose up`.

## Services

`docker-compose.yml` (unchanged from the repo) plus
`deploy/ovh/docker-compose.ovh.yml`, which adds the two services the app
needs beside the app and database:

| service | why | memory limit |
|---|---|---|
| `campfire` | the app | 1.5g |
| `clamav` | the malware scanner (`clamav/clamav:latest`, named volume `clamdb`) | 1.5g |
| `db` | Postgres 18, named volume `pgdata` | 1g |
| `cloudflared` | the only ingress; outbound-only | - |
| `coturn` | TURN relay, `network_mode: host` so it binds the public IP | - |

The scanner is part of the app's function, so it lives in the BASE compose file
(not this overlay) and every self-hosting shape gets it. It is never published to
the host: the app dials it by service name on the compose network
(`CLAMAV_HOST=clamav`) and streams each upload to it with `INSTREAM`, so the two
containers share no volume. Its image is a floating `latest`, which the
`campfire-images.timer` systemd job pulls forward on this host — see
§Keeping the scanner current.

The limits are deliberate: with no orchestrator to arbitrate, one runaway encode
or a burst of uploads must not be able to starve Postgres. Limits are ceilings,
not reservations, so nothing is held back at idle.

There is **no Caddy**. TLS terminates at Cloudflare, and
`docker-compose.prod.yml` (the direct-TLS VPS shape) is unused here.

## Provisioning a fresh host

```bash
scp deploy/ovh/provision.sh root@<ip>:/root/provision.sh
ssh root@<ip> bash /root/provision.sh
```

Idempotent. It installs Docker from Ubuntu's own archive (Docker's apt repo may
not have published for the release's codename yet), creates a 2 GiB swap file as
OOM insurance at `swappiness=10`, enables fail2ban and unattended-upgrades, arms
the image-update timer (from the repo, so it exists only after the clone — see
§Keeping the scanner current), bounds Docker's json-file logs, and opens **only
ssh and coturn** in ufw:

```
22/tcp, 3478/udp, 3478/tcp, 3479/tcp, 49160:49200/udp
```

Then:

```bash
mkdir -p /opt/campfire && git clone https://github.com/jreoka/campfire /opt/campfire/app
# write /opt/campfire/app/.env  (see "Secrets" below)
cd /opt/campfire/app
docker compose -f docker-compose.yml -f deploy/ovh/docker-compose.ovh.yml up -d --build
# arm the scanner's image updater — provision.sh installs it too, but the clone
# is what puts the unit files on disk, so on a fresh host it runs here:
install -m 644 deploy/ovh/systemd/campfire-images.service \
                deploy/ovh/systemd/campfire-images.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now campfire-images.timer
systemctl list-timers campfire-images.timer
```

## Keeping the scanner current

The scanner runs `clamav/clamav:latest` — the current stable ClamAV release — and
a systemd timer keeps it there. Fresh signatures are only half of a signature
engine; the engine itself has to move too, and this is what moves it.

| | |
|---|---|
| units | `campfire-images.service` (oneshot) + `campfire-images.timer` (every 30 min, 5 min jitter) |
| files | `deploy/ovh/systemd/`, installed to `/etc/systemd/system/` |
| script | `deploy/ovh/update-images.sh` (defaults to the `clamav` service) |
| log | `journalctl -u campfire-images` |
| state | `/var/lib/campfire/hold/clamav` — an image that failed here and is held back |

Every 30 minutes it resolves the image the compose file actually names (so a
`CLAMAV_TAG` pin is respected, never second-guessed), pulls it, and **recreates
only when the image the container is running differs from the one the tag now
points at** — a run that finds nothing new costs one registry check and does not
touch the running daemon. (Comparing the local tag before and after the pull
instead would be wrong in exactly the case that matters: a pull that landed
without a recreate, or one done by hand, would read as "up to date" and the
container would never converge.) When the image did move, the update is kept only
if all three of these hold:

1. **The new container reports healthy.** That is clamd's own `PING`
   healthcheck, and a clamd that loaded no database never gets that far: the
   image's entrypoint refuses to start without one.
2. **`scripts/verify-clamav.js` passes**, run inside the app container. This is
   the check that matters — a daemon whose database failed to load answers OK to
   everything, and no healthcheck can tell that from a working engine. Its whole
   report goes to the journal, so what was verified is recorded with the update
   that was kept.
3. **The app is restarted.** The app caches the engine generation it stamps on
   every verdict (`virus-scan.js`'s `engineIdentity`) and `bucket-scan.js`
   compares stored rows against that same cached value, so a scanner swapped in
   underneath a *running* app would keep stamping the **old** generation and
   would suppress the re-sweep a new engine is supposed to trigger. The restart
   re-probes it, and the updater logs the new
   `ClamAV engine ready (… 1.5.4 …)` line to prove it landed. Expect a few
   seconds of 502, exactly like a deploy.

If any step fails, the previous image is retagged back into place and the
container is recreated from it — a pull moves the *tag* and deletes nothing, so
the image that was serving is still on the host — and the refused digest is
written to `/var/lib/campfire/hold/clamav` so the timer does not retry a broken
release every 30 minutes. Remove that file to try it again; `systemctl --failed`
and `journalctl -u campfire-images` are where a failed run shows up.

Run it by hand — the same path the timer takes:

```bash
systemctl start campfire-images.service                  # then: journalctl -u campfire-images -f
bash deploy/ovh/update-images.sh                         # the scanner, directly
bash deploy/ovh/update-images.sh clamav coturn            # any compose service
```

**What auto-updating a scanner costs, stated plainly.** An upstream ClamAV
release now lands here without anyone reviewing it. The gate above is what makes
that acceptable — a release that does not detect EICAR, or whose database does not
load, is rolled back automatically instead of quietly failing open — but an engine
can still change behaviour (a new signature that flags a file this instance
already holds), and **a new ClamAV version is a full re-verification of the stored
tree**: the engine *generation* changes, so the next `bucket-scan.js` pass adopts
every key the generation now running has not judged. Nothing is gated while that
happens — adopted keys are queued ungated, so a pass can only ever remove malware,
never briefly take a working file from a reader. A signature update alone is
deliberately *not* a generation change, so freshclam's hourly runs do not rescan
anything.

To freeze the engine instead, set `CLAMAV_TAG` in `.env` and recreate the service
(`up -d --force-recreate clamav`): the updater reads the tag out of the compose
file, so the pin holds. `CLAMAV_TAG=1.5` stays on the 1.5 series while still
taking its patch releases, `CLAMAV_TAG=1.5.4` freezes that exact version, and
`CLAMAV_TAG=1.4` is the rollback — it puts the previous engine back, and it stays
there. Freezing also stops the re-sweep that a new generation would have
triggered, because the generation stops changing.

## Deploying a change

```bash
cd /opt/campfire/app
git pull
docker compose -f docker-compose.yml -f deploy/ovh/docker-compose.ovh.yml up -d --build
```

There is one replica, so this is a few seconds of 502 rather than a rolling
update. The code is still replica-safe (the Postgres bus and `db.LOCKS`), so
scaling out later means adding a host and a load balancer, not a rewrite.

Env-only changes need no rebuild: edit `.env`, then `up -d --force-recreate campfire`.

**The first deploy that brings the scanner up has one long step and one backlog.**
The `clamav` container downloads ~300 MB of signatures into the `clamdb` volume
before `clamd` can answer, so `docker compose ps` shows it unhealthy for a few
minutes while the app runs normally (scanning fails open, and the log says so).
After it answers, the daily bucket sweep re-judges every stored file, because they
all carry the PREVIOUS engine's generation — expect `Malware sweep:` to report a
full pass over the bucket (capped at `BUCKET_SCAN_MAX_JOBS` per pass) and the
`Virus scan:` line's pending count to work through it. Nothing is gated while that
happens: an adopted key is served while its verdict is pending.

## Secrets

`.env` holds everything, including the four credential sets. It is passed
straight into the app container by compose's `env_file`, which is also how a
snapshot captures it (see §Backups). The sets:

```
POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD
JWT_SECRET, DOMAIN, ORIGIN, KLIPY_KEY,
TURNSTILE_SECRET, TURNSTILE_SITEKEY,
TURN_URL, TURN_USER, TURN_PASS
S3_*                                          the media bucket (OVH, bucket `campfire`)
R2_*                                          the backup bucket
TUNNEL_TOKEN                                  the Cloudflare tunnel
```

`JWT_SECRET` **must** keep its value or every session is invalidated - that is
why users stayed logged in across the move.

## Media storage: OVHcloud object storage (was Cloudflare R2)

Media lives in the OVH bucket **`campfire`**, served through the app at the
same `/uploads/<sub>/<file>` paths as always. `storage.js`'s URL contract is
key-based and backend-agnostic, so moving the bytes changed no database row and
no cached URL.

| | |
|---|---|
| Endpoint | `https://s3.us-east-va.io.cloud.ovh.us` |
| Region | `us-east-va` |
| Bucket | `campfire` |
| Addressing | path-style (`S3_FORCE_PATH_STYLE=1`) - path-style and virtual-host were both tested and both work |

**How it was moved** (`scripts/migrate-r2-to-ovh.js`, free of charge and with the
site live the whole time): list the source, list the destination, read each
missing key from R2 and PUT it to OVH, then verify. The tool refuses to delete
from the source at all, never overwrites a key that already exists, and does
nothing without `--apply`. The run that mattered: **360 objects / 265.8 MiB**,
0 failures, destination count and byte total both matching, and 32 objects
re-downloaded from *both* stores and compared by SHA-256 - all identical. The
run is restartable: already-present keys are skipped, so a partial copy is
resumed rather than redone.

    node scripts/migrate-r2-to-ovh.js              # dry run: inventory both stores
    node scripts/migrate-r2-to-ovh.js --apply      # copy what is missing
    node scripts/migrate-r2-to-ovh.js --apply --verify

Inside the running container - the script has to be in the image, and
`docker compose run` builds from the image, not the host tree:

    docker cp scripts/migrate-r2-to-ovh.js campfire:/app/scripts/
    docker exec campfire node scripts/migrate-r2-to-ovh.js --apply --verify

**Prove the backend works, not just that it is configured**: `scripts/storage-selftest.js`
drives the app's OWN `storage.js` (PUT, HEAD, GET, DELETE, list, and a byte
round-trip comparison) so it exercises the real code path and the real
credentials rather than a hand-rolled client:

    docker cp scripts/storage-selftest.js campfire:/app/scripts/
    docker exec campfire node scripts/storage-selftest.js

**The switch itself** is only `.env`: repoint `S3_ENDPOINT`, `S3_REGION`,
`S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_FORCE_PATH_STYLE` at OVH and
recreate the app (`storage.js` builds its client once at module load, so a
restart is required). No rebuild needed.

**The old R2 bucket is still there, complete** - 360 objects, 265.8 MiB - and is
the rollback target. Its settings are archived at
`/root/r2-media-settings.before-ovh.env` on the host, so a rollback is a `.env`
edit and a recreate. **Do not delete `campfire-media` until you are satisfied
OVH is serving everything**: it is currently the second copy of media that
otherwise exists in exactly one place. Note the one-off pre-migration pg_dump is
**not** part of this picture - it lived on the Hetzner VPS, which has since been
deleted, so there is no host to roll back to. That dump was redundant (the
database was fully migrated and every 12-hourly snapshot still holds one), but it
is gone, which is worth knowing before anyone goes looking for it.

### Credentials

`S3_*` is now an OVH S3 user (access key + secret, both 32 hex chars) scoped to
the `campfire` bucket. It cannot reach the backup bucket, which is a different
vendor entirely (`R2_*`, Cloudflare). That separation is deliberate and is worth
keeping.

### Why not Hetzner Object Storage

It was the obvious choice - same region as the VPS, ~1 ms, no cross-cloud hop -
and it does not work. Measured against a real bucket in `nbg1` (with the
endpoint smoke-test script this repo has since dropped):

| test | result |
|---|---|
| absent-key HEAD, 80 requests @ concurrency 8 (44 req/s) | **15 x HTTP 403** |
| absent-key HEAD, 80 requests @ concurrency 1 (6 req/s) | **15 x HTTP 403** |
| real PUT/HEAD/GET/DELETE round-trips, 40 objects | 4 PUTs 403'd, plus HEAD/GET/DELETE |
| the same test 10 minutes later | **7 of 30 PUTs 403'd** - no improvement |
| `ListObjectsV2` | 403 (the list call itself failed) |

Roughly **one request in five** fails with a bare `403 UnknownError` on *real
objects*, at any request rate, persistently. Identical failure counts at 44 req/s
and 6 req/s rule out a rate limit; no improvement over time rules out credential
propagation across gateways. That is 1 in 5 uploads failing and 1 in 5 media
reads 403ing, so the store is unusable for this app. Two public reports describe
the same symptom.

The other thing the exercise proved: **addressing style belongs to the
endpoint.** Hetzner Object Storage answers only virtual-host (path-style 403s);
R2 and OVH answer both. `storage.js` reads `S3_FORCE_PATH_STYLE` for this,
defaulting to path-style.

## Uploads, scanning and compression

`VIRUS_SCAN=1`. The engine is **ClamAV**, in the `clamav` container — a signature
engine needs a signature database on disk, a downloader on a schedule (freshclam,
which the image runs) and a daemon holding that database in RAM, so none of it
belongs in the app's image or process. The image is `clamav/clamav:latest` (the
current stable release, kept current by §Keeping the scanner current). The app
streams every upload to `clamd`
over TCP (`INSTREAM`), one connection per file, so **no volume is shared** between
the two containers and the daemon never needs to see a path in the app's. The
pipeline is **scan -> compress -> scan**, and only the last clean verdict is
published, so clients still see exactly one `pending -> final` transition.

Things worth knowing about this shape:

* **Memory is the constraint, and it is measured, not guessed.** A loaded `clamd`
  on this database holds **~1.0 GiB resident** (951 MiB–1.02 GiB observed; the
  files on disk are only ~170 MB — the rest is the parsed matcher), and it stays
  there: a 50 MB stream scan takes ~3.6 s and moves the number by ~10 MB. The
  container is capped at `1.5g` and the app's own limit came down from `2g` to
  `1.5g` when the scanner arrived, because 1g + 1.5g + 1.5g is what the host has.
  Watch it with `docker stats` after a signature update lands; if `clamd` is ever
  OOM-killed repeatedly, lower `CLAMD_CONF_MaxThreads` first.
* **The signature volume is disposable.** `clamdb` holds the database; losing it
  costs a re-download (~300 MB) on the next start, never data. The first boot with
  an empty volume downloads before `clamd` can answer, which is why the app's
  `depends_on` for it is `service_started` and not `service_healthy`: the site
  comes up meanwhile and scanning fails OPEN until the daemon answers.
* **The daemon is never published to the host.** No `ports:` on the service — the
  app reaches `clamav:3310` on the compose network, and `clamd` over TCP is
  unauthenticated, so exposing it would hand anyone on the host a free scanner and
  a way to make it chew memory.
* **A failed database load is caught at startup, not discovered later.** The app's
  probe scans the EICAR test string against the running daemon
  (`CLAMAV_VERIFY_EICAR=1`) and refuses an engine that does not detect it — a
  ClamAV whose database did not load answers OK to everything, which is worse than
  no scanner because it is believed.

Verify the scanner for real, from inside the app container:

```bash
docker compose -f docker-compose.yml -f deploy/ovh/docker-compose.ovh.yml \
  exec -T campfire node scripts/verify-clamav.js
```

It checks that the daemon answers and says which ClamAV and which signature
revision it is, how old the database is (a stale database is a real, silent
failure mode), that the **EICAR test string is detected**, that a harmless body is
cleared (so it is not an always-guilty engine), that a **50 MB** body is accepted
through `INSTREAM` rather than refused for exceeding a stream limit (the largest
thing an upload can hand it — `CLAMD_CONF_StreamMaxLength` must stay above
`MAX_FILE_MB`), and that the app's own file path returns the same detection.

**The whole bucket is swept daily** (`bucket-scan.js`): the upload path only ever
judges what it just received, so anything stored while scanning was
`VIRUS_SCAN=0` — or judged by an **earlier engine** (the machine-learned detector
this app used before ClamAV) — has no verdict from the engine running now, and the
`/uploads` gate serves an unknown key. The sweep lists the stored tree and queues
the keys the current engine **generation** has not judged, so the ClamAV swap
itself is what re-verifies the stored tree: the first pass after this deploy
re-judges every existing file, with no migration to run. A key already judged by
this generation is never re-queued (the row is the ledger), `backups/` and
`thumbs/` are never listed, and an adopted key is queued **ungated** — it stays
servable while its background verdict is pending, so the sweep can only ever
remove malware, never briefly take a working file away from a reader. Size a first
pass from the admin console's Media tab ("Check scan coverage" is a dry run,
"Scan bucket now" runs it) before trusting it, and read the `Malware sweep:` line
for what the last pass did. A **signature** update deliberately does not trigger a
re-scan (only a new ClamAV version does), or every freshclam run would re-scan the
whole bucket for no security gain — new uploads are judged by the current database
anyway.

## Voice / TURN

`coturn` runs on the host network and binds the public IP directly, so no
`external-ip` is needed. `turn.dill.moe` is a **DNS-only** A record to
`40.160.90.108`; Cloudflare's proxy cannot carry UDP, so it must never be
orange-clouded. ufw opens 3478/tcp+udp, 3479/tcp and the relay range
49160-49200/udp.

Self-test (uses the container's own env, so no secret lands in a shell history):

```bash
docker compose ... exec -T coturn sh -c \
  'turnutils_uclient -y -n 4 -u $TURN_USER -w $TURN_PASS -p 3478 46.225.214.40'
```

Expect allocation, 16/16 messages relayed, 0% packet loss.

## Backups (the doomsday copy)

Still **Cloudflare R2**, bucket `campfire-backup`, by `backup.js`: a 12-hourly
snapshot of the pg_dump, the settings/secrets the app runs with and a **media
inventory** (key + size per object). `R2_BACKUP_KEEP=2`.

**Secrets ride in as the app's own environment.** Compose passes this host's
`.env` to the container with `env_file`, so `secrets.json` inside a snapshot
holds every variable the app runs with — `JWT_SECRET`, `POSTGRES_PASSWORD`,
`TUNNEL_TOKEN`, `TURN_*`, `KLIPY_KEY`, `S3_*`/`R2_*` — verbatim, plus the plain
config (`MAX_FILE_MB`, `UNFURL`, `STUN_URL`…), minus the image's runtime noise
(`PATH`, `HOSTNAME`). That is what makes a rebuild here possible without
retyping keys from memory; running in Kubernetes, the same file also carried the
namespace's Secret objects, read through the ServiceAccount.

`--fetch` writes both forms: `secrets.json` (everything, plus counts) and
`restored.env`, a `KEY=value` file you can diff against
`/opt/campfire/app/.env`. **Compare before applying** — replacing `JWT_SECRET`
logs every user out. The snapshot log line prints variable *names* only, never
values, so `docker compose logs` is not a place secrets leak.

**The media bytes are not in there, on purpose.** They used to be,
mirrored under `blobs/` and deduplicated across snapshots — which doubled what
the Cloudflare account stored, in the same account that held the media it copied,
so it could not survive losing that account and bought nothing but the bill.
Version-2 manifests say `media.included: false`. The trade, stated plainly: the
media bucket is now the **only** copy of the media, and a restore can name the
media it is missing but cannot bring a byte back. The one-time cleanup:

```bash
# dry run first: counts what it would free, lists blobs the media bucket no longer has
docker compose ... exec -T campfire node scripts/purge-backup-blobs.js
docker compose ... exec -T campfire node scripts/purge-backup-blobs.js --write
```

A blob whose key is still in the media bucket is a copy and is deleted; one the
media bucket no longer has is the only copy of bytes the app already removed
(reaped view-once media, a file the scanner deleted, an original media-compress
replaced) and is kept unless `--orphans` is passed. `prune()` in `backup.js` now
reaps any blobs/ residue on every snapshot run as the backstop.

```bash
docker compose ... exec -T campfire node scripts/restore-from-r2.js --list
docker compose ... run --rm --no-deps campfire \
  node scripts/restore-from-r2.js --fetch --out /data/restore
# /data/restore now holds campfire.dump, manifest.json, secrets.json and restored.env
bash deploy/ovh/restore-db.sh data/restore/campfire.dump
```

Take a snapshot now instead of waiting for the slot (same lock and retention as
the scheduler, so it cannot race one):

```bash
docker compose ... exec -T campfire node scripts/run-backup.js manual
```

`restore-db.sh` runs `pg_restore --clean --if-exists` and then TRUNCATEs the
runtime tables (`bus_*`, `live_sessions`, `voice_occupants`, `rate_limits`,
`webauthn_challenges`) - those describe a multi-replica cluster, which this is
not, and inheriting them makes presence and the bus lie.

## Open items

1. **Partly fixed by the OVH move; the rest is still open.** Media now lives in
   **OVHcloud** object storage and backups in **Cloudflare R2**, so the two are
   with different vendors again - losing either account no longer takes the
   other with it, which is the separation `r2.js` was built for. What is *not*
   fixed: **the media still has exactly one live copy** (snapshots record an
   inventory, never the bytes - see §Backups). The R2 bucket `campfire-media`
   still holds a complete second copy, which is why deleting it is the last step
   of the migration and not the first. To keep a genuine second copy after
   that, mirror the OVH bucket off-site (`rclone sync` to B2/Storj on a
   schedule, or a second provider's bucket) if the media is worth more than the
   storage it costs to duplicate.
2. **Retired infrastructure**: the old Kubernetes cluster is scaled to zero (not
   deleted) and its object store is untouched. The **Hetzner VPS has been deleted
   entirely** (2026-09-14, once the move was verified) - so it is no longer a
   tunnel hazard, and also no longer a rollback host. See §Media storage for what
   that means for the one-off pre-migration dump that lived on it. Still to
   decommission from the providers' dashboards: the scaled-to-zero cluster, its
   object store, and the API keys that go with them - but read item 1 first: the
   R2 bucket is still the rollback copy of the media.
3. No HA. One host, one Postgres, one of everything. A reboot is downtime.
4. Rotate the credentials that were pasted into a chat during the migrations: the
   Cloudflare Global API Key, the Hetzner API token, and - if the OVH media
   access key was shared the same way - the OVH S3 user's keys, which are now
   live in `.env`. The **Cloudflare Global API Key is not needed by anything
   running here**; it was only used to create the bucket and the scoped token.
   The R2 *backup* keys are live and should stay.

## One thing to remember about the tunnel

Starting `cloudflared` on a new host *while another connector for the same tunnel
is still up* puts both in one tunnel, and Cloudflare load-balances across
connectors - so a half-migrated routing change makes a fraction of live requests
fail with no obvious cause. On one tunnel it is stop-then-start, never both.
