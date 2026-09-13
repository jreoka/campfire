# Campfire on a single Hetzner VPS

Production since 2026-09-13. This replaces the Civo Kubernetes deployment, which
is still in the namespace but **scaled to zero** as the rollback path.

| | |
|---|---|
| Host | Hetzner Cloud `campfire` (#165647738), **CX33** - 4 vCPU / 8 GB / 80 GB NVMe |
| Location | Nuremberg, **`nbg1-dc3`** |
| Address | `46.225.214.40` (IPv6 `2a01:4f8:1c19:6888::/64`) |
| OS | Ubuntu 26.04.1, Docker 29.1.3 + Compose 2.40.3 |
| Ingress | Cloudflare Tunnel only - **no inbound 80/443**, so no certs to renew |
| Cost | ~$10.4/mo |

## Why we moved

The old cluster ran on a Civo Small node with **`cpu=890m`, `mem=1193460Ki`
(~1165 MiB) allocatable**. clamd needed about a gigabyte - 996 MiB measured on
production - so the cluster ran `VIRUS_SCAN=0`. That was an accepted trade-off
(`../civo/README.md` §9), not an oversight: AV scanning was the one feature the
node could not afford. This host has 8 GB, so **scanning is back on**, the box is
cheaper than the Civo node plus its object store, and the app got 4 cores
instead of 1 - which was the other long-standing complaint (two niced ffmpeg
encodes made the app feel sluggish on one vCPU).

Scanning has since moved from clamd to **Harbin**, which is one self-contained
binary rather than a resident daemon; that removed the clamd container and its
~500 MB signature volume outright, and freed roughly 3 GB on this host. See
"Uploads, scanning and compression" below.

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
`deploy/hetzner/docker-compose.hetzner.yml`, which supplies the two things the
cluster used to provide:

| service | why | memory limit |
|---|---|---|
| `campfire` | the app, malware scanner included | 2g |
| `db` | Postgres 18, named volume `pgdata` | 1g |
| `cloudflared` | the only ingress; outbound-only | - |
| `coturn` | TURN relay, `network_mode: host` so it binds the public IP | - |

There is no scanner service. Harbin is a binary inside the app image (built by
the Dockerfile's `harbin` stage) rather than a sibling container: it needs no
daemon, no signature volume, no healthcheck and no compose network hop.

The limits are deliberate: a single host has no kubelet to arbitrate, so one
runaway encode or a burst of uploads must not be able to starve Postgres.
Limits are ceilings, not reservations, so nothing is held back at idle.

There is **no Caddy**. TLS terminates at Cloudflare, and
`docker-compose.prod.yml` (the direct-TLS VPS shape) is unused here.

## Provisioning a fresh host

```bash
scp deploy/hetzner/provision.sh root@<ip>:/root/provision.sh
ssh root@<ip> bash /root/provision.sh
```

Idempotent. It installs Docker from Ubuntu's own archive (Docker's apt repo may
not have published for the release's codename yet), creates a 2 GiB swap file as
OOM insurance at `swappiness=10`, enables fail2ban and unattended-upgrades,
bounds Docker's json-file logs, and opens **only ssh and coturn** in ufw:

```
22/tcp, 3478/udp, 3478/tcp, 3479/tcp, 49160:49200/udp
```

Then:

```bash
mkdir -p /opt/campfire && git clone https://github.com/jreoka/campfire /opt/campfire/app
# write /opt/campfire/app/.env  (see "Secrets" below)
cd /opt/campfire/app
docker compose -f docker-compose.yml -f deploy/hetzner/docker-compose.hetzner.yml up -d --build
```

## Deploying a change

```bash
cd /opt/campfire/app
git pull
docker compose -f docker-compose.yml -f deploy/hetzner/docker-compose.hetzner.yml up -d --build
```

There is one replica, so this is a few seconds of 502 rather than a rolling
update - the same gap the cluster had with `maxSurge: 0` on a single node. The
code is still replica-safe (the Postgres bus and `db.LOCKS`), so scaling out
later means adding a host and a load balancer, not a rewrite.

Env-only changes need no rebuild: edit `.env`, then `up -d --force-recreate campfire`.

## Secrets

`.env` holds everything, including the four credential sets. It was rebuilt from
the cluster's Secrets during the migration - the mapping was:

```
POSTGRES_DB|POSTGRES_USER|POSTGRES_PASSWORD  <- secret campfire-db
JWT_SECRET, DOMAIN, ORIGIN, KLIPY_KEY,
TURNSTILE_SECRET, TURNSTILE_SITEKEY,
TURN_URL, TURN_USER, TURN_PASS               <- secret campfire-secrets
S3_*                                          <- secret campfire-s3 (media)
R2_*                                          <- secret campfire-r2 (backups)
TUNNEL_TOKEN                                  <- secret campfire-tunnel
```

`JWT_SECRET` **must** match the old deployment or every session is invalidated -
that is why users stayed logged in across the cutover.

## Media storage: Cloudflare R2, not Hetzner Object Storage

Media lives in the R2 bucket **`campfire-media`**, served through the app at the
same `/uploads/<sub>/<file>` paths as before. `storage.js`'s URL contract is
backend-agnostic, so the move changed no database row and no cached URL.

### Why not Hetzner Object Storage

It was the obvious choice - same region as the VPS, ~1 ms, no cross-cloud hop -
and it does not work. Measured with `scripts/s3-smoke.js` against a real bucket
in `nbg1`:

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
endpoint.** Civo answers only path-style (its virtual-host form does not resolve
in DNS); Hetzner answers only virtual-host (path-style 403s); R2 accepts both.
`storage.js` reads `S3_FORCE_PATH_STYLE` for this, defaulting to path-style.

### Credentials

`S3_*` is an R2 API token scoped to **`campfire-media` alone** (permission
`Workers R2 Storage Bucket Item Write`), so the credential the app holds cannot
reach the backup bucket. The access key id is the token's id and the secret is
the SHA-256 of the token's value.

Note the bucket's R2 location is **ENAM** (US east) while the VPS is in `nbg1` -
R2 no longer honours `locationHint` on creation, and this is permanent. It costs
roughly 90 ms per media fetch over the in-region alternative. Acceptable, not
ideal.

## Uploads, scanning and compression

`VIRUS_SCAN=1`. The engine is **Harbin** (https://github.com/jreoka/harbin) — a
static, machine-learned malware detector that is one binary with one argument, an
embedded model and no runtime, no network and no signature updates. The
Dockerfile builds it from a pinned commit and copies it into the app image, so
there is no scanner container, no signature volume and no healthcheck to watch.
The pipeline is **scan -> compress -> scan**, and only the last clean verdict is
published, so clients still see exactly one `pending -> final` transition.

Two consequences worth knowing:

* **The engine reads a path, not a stream.** In S3 mode the object is written to
  a temp file (`HARBIN_TMP_DIR`) before the scan and unlinked when the verdict
  lands; on local disk the stored file is scanned in place. A startup pass clears
  any `cf-scan-*` left behind by a crash, so the temp dir cannot grow across
  restarts.
* **Harbin's `suspicious` band is served, not blocked.** Its shipped operating
  point is the malicious threshold (0.95), where recall measured 1.00000 with 4
  false positives across 70,300 benign files; the 0.60 band is counted, logged
  and shown in the admin panel instead. `HARBIN_BLOCK_SUSPICIOUS=1` refuses it
  too, at a real false-positive cost on installer stubs and self-extracting
  archives.

Verify the scanner for real, from inside the app container:

```bash
docker compose -f docker-compose.yml -f deploy/hetzner/docker-compose.hetzner.yml \
  exec -T campfire node scripts/verify-harbin.js
```

It checks that the engine runs **with a detection model embedded** (a build with
no model answers CLEAN to everything, which is worse than no scanner), that a
synthetic all-writable+executable PE is detected, that the EICAR test string is
detected, that a harmless body is cleared (so it is not an always-guilty engine),
and that a **50 MB** body is accepted - the largest thing an upload can hand it.

EICAR is written to a temp file for the duration of that check, because Harbin
takes a path. On a dev machine with endpoint antivirus the file is quarantined
before Harbin can read it and the check reports SKIPPED with that reason; on this
host nothing else is watching the temp dir, so it runs for real.

**The whole bucket is swept daily** (`bucket-scan.js`): the upload path only ever
judges what it just received, so anything stored while the cluster ran
`VIRUS_SCAN=0` — or before Harbin existed — has no verdict at all, and the
`/uploads` gate serves an unknown key. The sweep lists the stored tree and queues
the keys no Harbin verdict covers. A key it has already judged is never
re-queued (the row is the ledger, so the first pass is the big one and later ones
only pick up what is genuinely new), `backups/` and `thumbs/` are never listed,
and an adopted key is queued **ungated** — it stays servable while its background
verdict is pending, so the sweep can only ever remove malware, never briefly take
a working file away from a reader. Size a first pass from the admin console's
Media tab ("Check scan coverage" is a dry run, "Scan bucket now" runs it) before
trusting it, and read the `Malware sweep:` line for what the last pass did.

## Voice / TURN

`coturn` runs on the host network and binds the public IP directly, so no
`external-ip` is needed. `turn.dill.moe` is a **DNS-only** A record to
`46.225.214.40`; Cloudflare's proxy cannot carry UDP, so it must never be
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
snapshot of the pg_dump, the Secrets it can reach and a **media inventory**
(key + size per object). `R2_BACKUP_KEEP=2`.

**Secrets are NOT in these snapshots on this host.** `collectSecrets()` reads
them from the Kubernetes API with the pod's ServiceAccount — the mechanism the
Civo deploy had and this one does not, so every snapshot here carries
`WARNING secrets not backed up: not running in-cluster` and `--show` says
`secrets NOT INCLUDED`. `/opt/campfire/app/.env` (mode 600) is therefore **not
covered by the backup**: keep your own copy of it, because a rebuild without
`JWT_SECRET` logs every user out and without `TURN_*`/`R2_*` the site comes back
half-configured. Making the snapshot self-contained means teaching `backup.js`
to capture the Compose env (a mounted env file, or the secret-shaped subset of
`process.env`) — worth doing, not done.

**The media bytes are not in there either, on purpose.** They used to be,
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
bash deploy/hetzner/restore-db.sh data/restore/campfire.dump
```

Take a snapshot now instead of waiting for the slot (same lock and retention as
the scheduler, so it cannot race one):

```bash
docker compose ... exec -T campfire node scripts/run-backup.js manual
```

`restore-db.sh` runs `pg_restore --clean --if-exists` and then TRUNCATEs the
runtime tables (`bus_*`, `live_sessions`, `voice_occupants`, `rate_limits`,
`webauthn_challenges`) - those describe a cluster this is not, and inheriting
them makes presence and the bus lie.

## Open items

1. **Biggest risk: media and backups share one Cloudflare account, and the media
   has no second copy at all.** The whole point of the old split was that losing
   the media vendor must not cost the backups (see `../civo/README.md` §8). Now
   one account holds live media *and* the only copies of everything else — and
   since snapshots stopped mirroring the media (see §Backups), a lost
   `campfire-media` bucket loses the media outright. Two fixes, in order: move
   **backups** to a third vendor (Backblaze B2 has a 10 GB free tier, so at
   ~250 MiB of media it stays free), which restores the separation `r2.js` was
   built for; and give the media its own out-of-account copy (`rclone sync` to
   B2/Storj on a schedule, or a second provider's bucket) if that media is worth
   more than the storage it costs to duplicate.
2. The old Civo cluster is **scaled to zero, not deleted**. It is the rollback:
   `kubectl -n campfire scale deploy/campfire deploy/cloudflared --replicas=1`.
   Rolling back loses everything written since the cutover, so decide soon.
   Its cron-like workers are off while it is scaled down, which matters: a
   second `backup.js` writing to the same R2 bucket would fight over retention.
3. No HA. One host, one Postgres, one of everything. A reboot is downtime.
4. The Civo object store is untouched (`campfire`, 262 objects) and still billed
   until deleted. Delete it only after a full billing cycle has served from R2 -
   `scripts/migrate-media-bucket.js` will not do it for you, on purpose.
5. Rotate every credential that was pasted into a chat during this migration:
   the Civo API key, the Cloudflare Global API Key, and the Hetzner API token.
   The R2 media token and the R2 backup keys are live and should stay, but the
   **Cloudflare Global API Key is not needed by anything running here** - it was
   only used to create the bucket and the scoped token.

## The cutover, for reference

The whole move took one ~85-second outage (04:01:00Z -> 04:02:25Z):

1. Media copied Civo -> R2 and verified (262 objects, 246 MiB, every one
   re-downloaded and MD5-matched).
2. Tunnel ingress repointed from `http://campfire.campfire.svc.cluster.local:3000`
   to **`http://campfire:3000`** - a name that resolves in the k8s namespace *and*
   on the compose network, so the change was verifiable as non-breaking (12/12
   HTTP 200) before the switch.
3. Old cluster scaled to 0 (`cloudflared` then `campfire`), which stops all
   writes - including its backup worker, which would otherwise keep writing
   snapshots of a database that is no longer production.
4. Fresh `pg_dump` of the now-quiesced database, transferred, restored, and
   compared: row counts matched the live cluster exactly.
5. `cloudflared` started on the VPS.

**Do not repeat the mistake made during preparation:** starting `cloudflared` on
the new host *while the old cluster's connector was still up* puts both in the
same tunnel, and Cloudflare load-balances across connectors. Because the ingress
still named a k8s-internal hostname, roughly one live request in five failed for
about 90 seconds. On one tunnel it is stop-then-start, never both.
