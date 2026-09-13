# Campfire on a single Hetzner VPS

Production since 2026-09-13.

| | |
|---|---|
| Host | Hetzner Cloud `campfire` (#165647738), **CX33** - 4 vCPU / 8 GB / 80 GB NVMe |
| Location | Nuremberg, **`nbg1-dc3`** |
| Address | `46.225.214.40` (IPv6 `2a01:4f8:1c19:6888::/64`) |
| OS | Ubuntu 26.04.1, Docker 29.1.3 + Compose 2.40.3 |
| Ingress | Cloudflare Tunnel only - **no inbound 80/443**, so no certs to renew |
| Cost | ~$10.4/mo |

## Why we moved

The old deployment ran on a single-vCPU node with **`cpu=890m`,
`mem=1193460Ki` (~1165 MiB) allocatable**. The resident scanner then in use
needed about a gigabyte - 996 MiB measured on production - so it ran
`VIRUS_SCAN=0`. That was an accepted trade-off, not an oversight: AV scanning was
the one feature that node could not afford. This host has 8 GB, so **scanning is
back on**, the box is cheaper than that node plus its object store, and the app
got 4 cores instead of 1 - which was the other long-standing complaint (two
niced ffmpeg encodes made the app feel sluggish on one vCPU).

Scanning is **Harbin** now, one self-contained binary rather than a resident
daemon, so there is no scanner container and no signature volume at all - and
roughly 3 GB that the old daemon and its database held is back. See "Uploads,
scanning and compression" below.

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
`deploy/hetzner/docker-compose.hetzner.yml`, which adds the two services the app
needs beside the app and database:

| service | why | memory limit |
|---|---|---|
| `campfire` | the app, malware scanner included | 2g |
| `db` | Postgres 18, named volume `pgdata` | 1g |
| `cloudflared` | the only ingress; outbound-only | - |
| `coturn` | TURN relay, `network_mode: host` so it binds the public IP | - |

There is no scanner service. Harbin is a binary inside the app image (built by
the Dockerfile's `harbin` stage) rather than a sibling container: it needs no
daemon, no signature volume, no healthcheck and no compose network hop.

The limits are deliberate: with no orchestrator to arbitrate, one runaway encode
or a burst of uploads must not be able to starve Postgres. Limits are ceilings,
not reservations, so nothing is held back at idle.

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
update. The code is still replica-safe (the Postgres bus and `db.LOCKS`), so
scaling out later means adding a host and a load balancer, not a rewrite.

Env-only changes need no rebuild: edit `.env`, then `up -d --force-recreate campfire`.

## Secrets

`.env` holds everything, including the four credential sets. It is passed
straight into the app container by compose's `env_file`, which is also how a
snapshot captures it (see §Backups). The sets:

```
POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD
JWT_SECRET, DOMAIN, ORIGIN, KLIPY_KEY,
TURNSTILE_SECRET, TURNSTILE_SITEKEY,
TURN_URL, TURN_USER, TURN_PASS
S3_*                                          the media bucket
R2_*                                          the backup bucket
TUNNEL_TOKEN                                  the Cloudflare tunnel
```

`JWT_SECRET` **must** keep its value or every session is invalidated - that is
why users stayed logged in across the move.

## Media storage: Cloudflare R2, not Hetzner Object Storage

Media lives in the R2 bucket **`campfire-media`**, served through the app at the
same `/uploads/<sub>/<file>` paths as before. `storage.js`'s URL contract is
backend-agnostic, so the move changed no database row and no cached URL.

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
R2, which is what the app uses, accepts both. `storage.js` reads
`S3_FORCE_PATH_STYLE` for this, defaulting to path-style.

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
judges what it just received, so anything stored while scanning was
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
bash deploy/hetzner/restore-db.sh data/restore/campfire.dump
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

1. **Biggest risk: media and backups share one Cloudflare account, and the media
   has no second copy at all.** They used to sit with two different vendors, which
   is what kept a lost media store from costing the backups too. Now one account
   holds live media *and* the only copies of everything else — and since
   snapshots stopped mirroring the media (see §Backups), a lost `campfire-media`
   bucket loses the media outright. Two fixes, in order: move **backups** to a
   third vendor (Backblaze B2 has a 10 GB free tier, so at ~250 MiB of media it
   stays free), which restores the separation `r2.js` was built for; and give the
   media its own out-of-account copy (`rclone sync` to B2/Storj on a schedule, or
   a second provider's bucket) if that media is worth more than the storage it
   costs to duplicate.
2. **Retired infrastructure is still provisioned and still billing**: the old
   Kubernetes cluster is scaled to zero (not deleted) and its object store is
   untouched. Nothing here uses either, and the object store holds a pre-R2 copy
   of the media — so delete both from the provider's dashboard once you are
   satisfied that R2 is serving everything, and delete that provider's API key
   with them.
3. No HA. One host, one Postgres, one of everything. A reboot is downtime.
4. Rotate the credentials that were pasted into a chat during the migration: the
   Cloudflare Global API Key and the Hetzner API token. The R2 media token and the
   R2 backup keys are live and should stay, but the **Cloudflare Global API Key is
   not needed by anything running here** - it was only used to create the bucket
   and the scoped token.

## One thing to remember about the tunnel

Starting `cloudflared` on a new host *while another connector for the same tunnel
is still up* puts both in one tunnel, and Cloudflare load-balances across
connectors - so a half-migrated routing change makes a fraction of live requests
fail with no obvious cause. On one tunnel it is stop-then-start, never both.
