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
VPS intact underneath as the fallback.

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

# App secrets — these were created ON the VPS from /opt/campfire/.env so the
# values never left the server; see the note below before recreating them.
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
```

`JWT_SECRET` **must match production**, or every existing session is
invalidated and everyone has to log in again.

> **An S3 credential's UUID is not its access key.** Civo's UI shows both; using
> the credential id (`d8ab63f9-…`) as `S3_ACCESS_KEY` produces
> `InvalidAccessKeyId` from every request, including the backup catch-up check.
> The access key is the short alphanumeric string.

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
  `uploads/` prefix.
- **Backups** — `backup.js` dumps at 00:00 and 12:00 server-local into the
  bucket's `backups/` prefix and keeps the newest **`BACKUP_KEEP` = 3**.

> The prune and the catch-up check both filter on `isDumpKey` (`*.dump`
> **only**), and `storage-sweep.js` skips `backups/` entirely. So an object
> under `backups/` that is not a `.dump` is invisible to retention *and* immune
> to the sweeper — it sits there until deleted by hand. Nothing may be parked
> there.

```bash
# what's in there now
kubectl -n campfire exec deploy/campfire -- node -e \
  "require('/app/storage').s3List('backups/').then(r=>r.forEach(o=>console.log(o.key,o.size)))"
```

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

## 8. Rollback

**The rollback is database-only now.** The OVH bucket is deleted, so the media
for any pre-cutover state exists only in the Civo bucket.

- The VPS at `148.113.179.123` is still running with its `campfire_pgdata`
  volume intact. Repointing the Cloudflare route at it restores the *app and its
  database* — but its uploads would 404, because the bucket they pointed at no
  longer exists.
- The pre-cutover dump is at `/root/campfire-predeploy/cutover.dump` on the VPS.
- Because `campfire.dill.moe` now resolves to the tunnel, SSH by that name no
  longer reaches the VPS. Use the IP:
  `ssh -o StrictHostKeyChecking=accept-new root@148.113.179.123`.

The honest recovery path for media is the Civo bucket itself plus `backups/`:
`pg_restore` a dump and point `S3_*` at the Civo store. Cancelling the VPS ends
the DB-only fallback, so decide that deliberately.

---

## 9. Known trade-off of `VIRUS_SCAN=0`

With scanning off, `startVirusScan()` returns before its loop, so the
single-pass path never runs. Uploads are recorded `clean` immediately and served
ungated. That is the accepted cost of fitting a 1165 Mi node — clamd alone
measured **996 MiB** on production.

`MEDIA_COMPRESS=0` is set alongside it deliberately: otherwise compression falls
to the sweeper, which republishes the file *after* it is already visible and can
swap the bytes under someone playing it.

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
