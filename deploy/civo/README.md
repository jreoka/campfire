# Campfire on Civo — deploy + operations runbook

One **Civo Small** node (1 vCPU / 2 GiB, `$10.86/mo`) runs the app, Postgres,
coturn and a Cloudflare Tunnel. `campfire.yaml` holds every resource.
**Secrets are not in it** — create them imperatively (below) so nothing
sensitive reaches git.

**The migration is done and verified.** `campfire.dill.moe` is served from this
cluster. Sections 0–2 and 10 are the standing reference; §5 records how the
data got here; §6 is what to re-run after any change.

---

## 0. Decisions taken

**Object storage — Civo Object Store.** Civo bills object stores in 500 GB
increments (~EUR 5.50/mo) and the data is ~105 MB, so this is roughly half the
node bill again for 0.02% of the capacity. Cloudflare R2 would be free at this
size (10 GB free tier, zero egress) and `dill.moe` is already on Cloudflare —
**R2 remains the cheaper option if this bill ever matters.** Civo's store was
chosen anyway (one vendor). Only `S3_ENDPOINT`/`S3_BUCKET`/`S3_REGION`/
`S3_ACCESS_KEY`/`S3_SECRET_KEY` change, so the manifests do not care.

Civo's store needs **`forcePathStyle`** — `<bucket>.<endpoint>` virtual-host
addressing does not resolve there.

**Registry — GHCR.** `.github/workflows/container.yml` builds and pushes
`ghcr.io/jreoka/campfire:sha-<short>` (plus `:latest`) on any push to `main`
that touches app files, using `GITHUB_TOKEN` with `permissions: packages:
write`. The package is private, so the pod pulls through the
`campfire-registry` imagePullSecret.

**Hostname — repointed directly.** There is no temporary `civo.dill.moe` route.
The owner's call was to bring the migration up on the real name; the tunnel
route for `campfire.dill.moe` was switched to the cluster in one step, with the
VPS left intact underneath until the migration was verified. That VPS has since
been decommissioned — see §8.

---

## 1. Cluster prerequisites

```bash
kubectl get storageclass          # civo-volume (default, csi.civo.com)
kubectl get nodes -o wide
kubectl describe node <node> | grep -A6 'Allocatable'
```

The Civo Small node reports **`cpu=890m`, `mem=1193460Ki` (~1165 Mi)**
allocatable. Budget against that, not the 2 GiB on the price list.

> **`civo-volume` has `RECLAIMPOLICY Delete`.** Deleting the `pgdata` PVC
> destroys the Postgres volume with it. There is no undo. The same applies to
> deleting the namespace.

**kubeconfig gotcha (cost hours).** Civo's kubeconfig puts the client leaf
certificate *and* `k3s-client-ca` into `client-certificate-data`. k3s v1.36
rejects a CA in the client chain, and every kubectl version fails with
`remote error: tls: error decoding message`. **Keep only the leaf** in that
field:

```bash
kubectl config view --raw -o jsonpath='{.users[0].user.client-certificate-data}' \
  | base64 -d | openssl x509 -text -noout   # must be ONE cert
```

**Cluster firewall** — open these for coturn. Without them TURN relays silently
and voice fails for users behind strict NAT. Everything else the app needs is
outbound-only via the tunnel.

| Port | Proto | Why |
|---|---|---|
| 3478 | UDP | TURN |
| 3478 | TCP | TURN over TCP |
| 3479 | TCP | TURN alt-listening-port |
| 49160-49200 | UDP | TURN relay range (already narrow on the source) |

No inbound 80/443 is required — the Cloudflare Tunnel is outbound.

---

## 2. Secrets

```bash
# Database
kubectl -n campfire create secret generic campfire-db \
  --from-literal=POSTGRES_USER=campfire \
  --from-literal=POSTGRES_PASSWORD='<alnum password>' \
  --from-literal=POSTGRES_DB=campfire

# Object storage (see decision 0)
kubectl -n campfire create secret generic campfire-s3 \
  --from-literal=S3_ENDPOINT='https://objectstore.nyc1.civo.com' \
  --from-literal=S3_BUCKET='campfire' \
  --from-literal=S3_REGION='nyc1' \
  --from-literal=S3_ACCESS_KEY='<key>' \
  --from-literal=S3_SECRET_KEY='<secret>'

# App secrets — the live values came from /opt/campfire/.env on the VPS, which
# has been decommissioned. Do NOT recreate this Secret from scratch: read the
# existing values out of the cluster instead, or you invalidate every session.
#   kubectl -n campfire get secret campfire-secrets \
#     -o jsonpath='{.data.JWT_SECRET}' | base64 -d
kubectl -n campfire create secret generic campfire-secrets \
  --from-literal=JWT_SECRET='<same as production>' \
  --from-literal=DOMAIN='campfire.dill.moe' \
  --from-literal=ORIGIN='https://campfire.dill.moe' \
  --from-literal=KLIPY_KEY='<...>' \
  --from-literal=TURNSTILE_SECRET='<...>' \
  --from-literal=TURNSTILE_SITEKEY='<...>' \
  --from-literal=TURN_URL='turn:turn.dill.moe:3478' \
  --from-literal=TURN_USER='campfire' \
  --from-literal=TURN_PASS='<same as production>'

# Cloudflare Tunnel token
kubectl -n campfire create secret generic campfire-tunnel \
  --from-literal=TUNNEL_TOKEN='<tunnel token>'

# Off-site backup destination (Cloudflare R2). An R2 API token scoped to the
# backup bucket: the Access Key ID is the token's `id` and the Secret Access Key
# is sha256(token value) -- both shown once, at creation.
#   endpoint: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
kubectl -n campfire create secret generic campfire-r2 \
  --from-literal=R2_ENDPOINT='https://<ACCOUNT_ID>.r2.cloudflarestorage.com' \
  --from-literal=R2_BUCKET='campfire-backup' \
  --from-literal=R2_REGION='auto' \
  --from-literal=R2_ACCESS_KEY='<access key id>' \
  --from-literal=R2_SECRET_KEY='<sha256 of the token value>'
```

`JWT_SECRET` **must match production**, or every existing session is
invalidated and everyone has to log in again.

> **An S3 credential's UUID is not its access key.** Civo's UI shows both; using
> the credential id (`d8ab63f9-…`) as `S3_ACCESS_KEY` produces
> `InvalidAccessKeyId` from every request, including the backup catch-up check.
> The access key is the short alphanumeric string.

The app also needs read access to this namespace's Secrets, so the snapshot can
be self-contained. `campfire.yaml` creates a `campfire` ServiceAccount with a
namespace-scoped read-only Role on Secrets and binds it; the Deployment runs
under it. If the backup logs `SECRETS NOT BACKED UP`, that binding is the first
thing to check:

```bash
kubectl -n campfire auth can-i list secrets \
  --as=system:serviceaccount:campfire:campfire -n campfire
```

---

## 3. Deploy

Routine redeploy after a commit — env-only changes need **no rebuild**:

```bash
kubectl -n campfire set image deploy/campfire campfire=ghcr.io/jreoka/campfire:sha-<short>
# or: kubectl apply -f deploy/civo/campfire.yaml
kubectl -n campfire rollout status deploy/campfire

# env-only (e.g. BACKUP_KEEP) — patch, then:
kubectl -n campfire rollout restart deploy/campfire
```

First-time/full apply:

```bash
kubectl apply -f deploy/civo/campfire.yaml
kubectl -n campfire get pods -w
```

Expect `campfire`, `cloudflared`, `coturn`, `db-0`. A `civo-volume` PVC stays
`Pending` until a pod consumes it (`WaitForFirstConsumer`) — that is normal.

Since the bucket holds the only copy of the media, media is not on the node at
all: `UPLOAD_DIR` is an `emptyDir`, which is what lets replicas scale without a
shared filesystem.

---

## 4. Where the data is, and backups

- **Postgres** — `pgdata` PVC, 5 Gi, `civo-volume`.
- **Media** — the Civo bucket (`files/`, `avatars/`, `banners/`, `emoji/`,
  `icons/`, `sidebar/`, `viewonce/`). Keys are top-level; there is no shared
  `uploads/` prefix. **There is no `backups/` prefix any more** — it was
  emptied when backups moved to R2, and nothing writes there.
- **Backups** — a **Cloudflare R2** bucket, a different vendor from the store
  the app serves from. 12-hourly snapshots (00:00 / 12:00 server-local), newest
  **`R2_BACKUP_KEEP` = 2** retained.

Each snapshot is:

```
snapshots/<stamp>/manifest.json         inventory + checksums, written LAST
snapshots/<stamp>/db/campfire.dump      pg_dump -Fc of the whole database
snapshots/<stamp>/secrets/secrets.json  every Secret in the namespace, verbatim
blobs/<source key>                      the media bucket, stored once and shared
```

Media is **not** copied per snapshot: each object is stored once under
`blobs/<its key>` and a snapshot only references it from its manifest, so a
second snapshot of an unchanged bucket costs two manifests and no media at all.
Measured: the first snapshot moved 109 objects / 104.3 MB in 31s, the next was
**2 seconds and 0 bytes uploaded**. R2's free tier is 10 GB, so this sits at
about 1% of it.

**Why R2 and not the media bucket.** The dump used to live in the same Civo
bucket the app serves from, under the same credentials. That survives a bad
migration but not losing the bucket, the account, or a mistaken `S3_*` change —
and it only ever covered the database, never the media.

> **The R2 bucket is as sensitive as the cluster.** `secrets.json` holds
> `JWT_SECRET`, the Postgres password, the tunnel token and the TURN credentials
> (base64, i.e. plaintext-equivalent), and it includes the R2 credentials
> themselves. Treat read access to that bucket as root on this deployment.

Retention details worth knowing:

- The manifest is written **last**, so a snapshot directory that exists is one
  that completed. A failed run deletes its own partial objects.
- Blob pruning only runs when **every** retained manifest was read successfully
  and none of them references the blob. If a manifest cannot be read it skips
  entirely, because deleting a blob a snapshot still needs would silently
  corrupt a backup. It fails towards keeping bytes.
- If a key's content is rewritten in place, an older snapshot references that
  key and so restores the newer bytes for it. `media-compress` is the only
  writer that does this, and only for a same-format re-encode **before** the
  file is published (the cache-busted URL moves with it); everything it does to
  an already-visible file lands on a fresh key instead. So a restore still gets
  exactly the bytes the app is serving for that key.
- The old `.dump`-only gotcha is gone: nothing is pruned by filename pattern any
  more, and no object can sit in a backup location invisible to retention.

```bash
R2=/app/scripts/restore-from-r2.js
kubectl -n campfire exec deploy/campfire -- node $R2 --list
kubectl -n campfire exec deploy/campfire -- node $R2 --show
```

Use `--list` / `--show` from inside the pod (it already has both sets of
credentials), or run it locally with `R2_*` and `S3_*` set in the environment.
It uses the same `R2_*` / `S3_*` variable names as the app, so the environment
is the only difference between the two.

---

## 5. How the data got here (migration record)

Both halves were verified against the source before anything was deleted.

**Database.** Dumped on the VPS, copied into the cluster, restored, then the
six runtime tables truncated so the first boot was unambiguous:

```bash
# on the VPS
docker exec campfire-db pg_dump -U campfire -Fc campfire > /root/campfire-predeploy/cutover.dump
# locally — COPY the dump in, do not stream it through kubectl from the VPS
scp root@<vps-ip>:/root/campfire-predeploy/cutover.dump .
kubectl -n campfire cp cutover.dump db-0:/tmp/cutover.dump
kubectl -n campfire exec -it db-0 -- pg_restore -U campfire -d campfire --clean --if-exists /tmp/cutover.dump
kubectl -n campfire exec -it db-0 -- rm -f /tmp/cutover.dump
```

`--clean --if-exists` matters: the app creates its schema on boot, so the
target already has empty tables.

```bash
# the dump carries production's bus_replicas heartbeats, so the new pod would
# see the OLD OVH replica as a live peer for up to 30s and skip its one-shot
# boot clears. These six are runtime/ephemeral; no user data lives in them.
kubectl -n campfire exec db-0 -- psql -U campfire -d campfire -c \
  "TRUNCATE bus_replicas, bus_events, live_sessions, voice_occupants, rate_limits, webauthn_challenges;"
```

Verified: `users=2 messages=109 dm_messages=135 attachments=54 servers=2
channels=4 stories=1 notifications=15 file_scans=88` — all nine tables matched.

**Object storage.** `scripts/migrate-s3.js` copies and never deletes; dry-run by
default.

```bash
export SRC_S3_ENDPOINT=https://s3.us-east-va.io.cloud.ovh.us SRC_S3_BUCKET=campfire SRC_S3_REGION=us-east-va
export SRC_S3_ACCESS_KEY=... SRC_S3_SECRET_KEY=...
export DST_S3_ENDPOINT=https://objectstore.nyc1.civo.com DST_S3_BUCKET=campfire DST_S3_REGION=nyc1
export DST_S3_PATH_STYLE=1 DST_S3_ACCESS_KEY=... DST_S3_SECRET_KEY=...

node scripts/migrate-s3.js --dry      # inventory + plan, writes nothing
node scripts/migrate-s3.js --write    # copy
node scripts/migrate-s3.js --verify   # compare key sets and sizes
```

Result: `source: 115 object(s), 104.9 MiB`, then `present in both 115, missing
0, size mismatch 0`.

> **It failed 115/115 the first time.** aws-sdk v3 sends a streaming `Body` as a
> chunked PUT with a checksum trailer (`STREAMING-UNSIGNED-PAYLOAD-TRAILER`),
> which Civo's store rejects with `non-retryable streaming request` — MinIO
> accepts it, so a local rehearsal passes and only the real destination fails.
> `copyOne` now buffers the body into a `Buffer` and sends that with an explicit
> `ContentLength`. Keep it that way.

**The source bucket is gone.** The OVH bucket was verified to be fully contained
in the Civo bucket first (115/115, zero drift, zero mismatch), then its objects
and the bucket itself were deleted, and `scripts/retire-bucket.js` did it. OVH
object-storage billing has stopped.

The bucket now holds **109 objects** (96 `files/`, 3 `backups/`, 3 `banners/`,
2 `avatars/`, 2 `icons/`, 1 each `emoji/`, `sidebar/`, `viewonce/`) — the drop
from 115 is the 7 old dumps retention pruned, 1 new dump, and 1 legacy SQLite
relic deleted. One `viewonce/` object has been created since.

---

## 6. Verify after a deploy or a cutover

- [ ] `https://campfire.dill.moe/` loads and boots to the auth screen
- [ ] Log in — proves `JWT_SECRET` and the DB are intact
- [ ] Existing message history renders, including older attachments
- [ ] An image/attachment loads — proves the S3 credentials and keys
- [ ] Upload a new file; it appears and is servable
- [ ] Voice: two clients connect a call through `turn:turn.dill.moe:3478`
- [ ] `kubectl -n campfire get pods` — all `1/1 Running`, 0 restarts after ~15 min
- [ ] `/healthz` (liveness, touches nothing external) and `/readyz` (readiness)
      both 200
- [ ] `curl https://campfire.dill.moe/api/version` — fingerprint changed

`kubectl top` is **not available** on this cluster (no metrics-server), so use
the `/readyz` endpoint and the pod list rather than a `top` check.

TURN reachability from outside, without touching DNS:

```bash
turnutils_uclient -v -u campfire -w '<TURN_PASS>' -p 3478 212.2.241.134
```

---

## 7. TURN / voice

coturn runs in-cluster with `hostNetwork` (3478/udp+tcp, 3479/tcp, relay
49160-49200/udp). `turn.dill.moe` is a **DNS-only A record** to the node's
public IP (`212.2.241.134`).

It must stay DNS-only (grey cloud): Cloudflare's HTTP proxy does not carry UDP,
so TURN can never go through the tunnel. Keep TURN on a **separate name** from
the app so a future app DNS change cannot break voice again. The tunnel is for
the app only.

Note `TURN_URL` is a DNS name, not an IP: the app hands it to clients as an ICE
server, so it has to resolve publicly.

---

## 8. Recovery

**There is no fallback host.** The OVH VPS has been decommissioned and its
bucket is deleted, so the live cluster plus the R2 backups are all there is.

What exists, and only this:

- **Postgres** — the `pgdata` PVC on the node, plus the dumps in R2.
  `R2_BACKUP_KEEP=2` at a 00:00/12:00 cadence is roughly **24 hours of history
  with up to 12 hours of loss**.
- **Media** — the Civo bucket, and a full copy in R2 under `blobs/`. This is the
  one thing that got strictly better: the media used to have no copy at all.
- **Secrets** — in R2. Without them a restore still works but logs every user
  out, and the tunnel would have to be recreated.
- The pre-cutover dump at `/root/campfire-predeploy/cutover.dump` went with the
  VPS.

The whole recovery, in order:

```bash
# 0. what is there, and is it usable
kubectl -n campfire exec deploy/campfire -- node /app/scripts/restore-from-r2.js --list
kubectl -n campfire exec deploy/campfire -- node /app/scripts/restore-from-r2.js --show

# 1. database -- fetch writes the dump out and prints the exact commands
node scripts/restore-from-r2.js --fetch --out ./restore
#    then follow the printed kubectl cp / pg_restore / TRUNCATE steps

# 2. media -- copies blobs back into the media bucket, never deletes, dry-run first
node scripts/restore-from-r2.js --restore-media --write

# 3. secrets -- compare against the cluster before applying
#    (replacing JWT_SECRET logs everyone out)
```

`--fetch` deliberately does not touch the database itself: `pg_restore --clean`
drops and recreates tables in a live database, so the last step stays a command
you run on purpose with the output in front of you.

Because R2 is a different vendor from the media store, losing the Civo account
no longer costs the media — restore it into any S3-compatible bucket and point
`S3_*` at it. Losing R2 costs the backups, which is why the credentials for the
two are kept separate.

---

## 9. Known trade-off of `VIRUS_SCAN=0`

There is **no virus scanning here**, and that is the accepted cost of fitting a
1165 Mi node — clamd alone measured **996 MiB** on production. Uploads are not
inspected for malware; the gate below exists for compression, not for AV.

Compression is NOT disabled with it. The `virus-scan` worker runs whenever
scanning **or** compression is on, so with `VIRUS_SCAN=0` it becomes a
compress-and-publish slot: it takes each upload the compressor would rewrite,
encodes it before anything can fetch it, and only then lifts the 423 the
`/uploads` gate is holding it behind. That keeps the property the pipeline was
built for — one `pending -> final` transition per upload, never a byte swap
under a player — without a scanner to ask. Anything the compressor would never
touch (a zip, a PDF, a 100 KB screenshot) is marked `clean` at upload time and
served immediately, so only real candidates wait.

What the *sweeper* compresses is different: those files are already visible, so
it publishes the smaller bytes under a NEW key and leaves the old object for the
orphan sweep. The attachment's url moves and the client repaints from the
`message-updated` push; nothing is ever rewritten behind a URL someone may be
streaming.

`VIRUS_SCAN_CONCURRENCY=1` on this node: S3 mode buffers each download in RAM
(up to `MAX_FILE_MB`) and compressions are serialized process-wide anyway, so
parallel slots would only hold more copies of a large file inside the 640 Mi
limit.

To get scanning back later, run clamd somewhere and point `CLAM_HOST` at it —
a config change, not a code change, and the one thing that would let this fit on
a small node with real AV.

`MAX_FILE_MB=50`, not the 200 default: S3 mode buffers every upload in RAM
(`multer.memoryStorage`), so this is also a per-upload memory budget on a 1165 Mi
box.

---

## 10. Bugs already hit — do not re-hit these

| Symptom | Cause | Fix |
|---|---|---|
| Postgres pod refuses to start | Postgres 18 images reject a mount at `/var/lib/postgresql/data` | Mount `/var/lib/postgresql` and set no `PGDATA` |
| StatefulSet rejected: `volumeMounts[0].name: Not found: "pgdata"` | A standalone PVC still needs an explicit `volumes:` entry | Add it to the StatefulSet's pod spec |
| `campfire` pod: `boot failed: getaddrinfo ENOTFOUND db` | The `db` Service had no backing StatefulSet | Apply the StatefulSet, not just the PVC |
| Every kubectl: `tls: error decoding message` | Leaf + `k3s-client-ca` both in `client-certificate-data` | Keep only the leaf (§1) |
| CCM crash-loops; node stuck `uninitialized:NoSchedule`; CoreDNS + CSI `Pending` | The cluster's `civo-api-access` secret had a 0-byte `api-key` | Patch it with the Civo API key, then `rollout restart deploy/civo-ccm` |
| S3 `InvalidAccessKeyId` everywhere | Used the credential's UUID instead of the access key | Use the short access key (§2) |
| All S3 copies fail `non-retryable streaming request` | aws-sdk v3 streaming PUT + checksum trailer vs Civo's store | Buffer the body (§5) |
| `[backup] catch-up check failed: UnknownError` | Same streaming PUT / credential problem, surfacing in the backup path | §2 + §5 |
