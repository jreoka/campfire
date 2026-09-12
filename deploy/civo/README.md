# Campfire on Civo — deploy + migration runbook

Target: one **Civo Small** node (1 vCPU / 2 GiB / 40 GB, `$10.86/mo`) running the
app, Postgres, coturn and a Cloudflare Tunnel.

`campfire.yaml` holds every resource. **Secrets are not in it** — create them
imperatively (below) so nothing sensitive reaches git.

---

## 0. Before anything: two decisions

### Object storage — Civo Object Store has a 500 GB minimum

[Civo object stores are sized in 500 GB increments](https://www.civo.com/docs/object-stores/create-an-object-store).
The data being migrated is **105 MB**. At Civo's listed per-GB rate a 500 GB
store is roughly **EUR 5.50/mo** — about half the node bill again, for 0.02% of
the capacity.

**Cloudflare R2 is free at this size** (10 GB free tier, zero egress), and
`dill.moe` is already on Cloudflare. `scripts/migrate-uploads-to-r2.js` exists
for exactly this. R2 is the better home unless you want one vendor.

Either way the app only needs `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` /
`S3_ACCESS_KEY` / `S3_SECRET_KEY`, so this decision does not change the manifests.

### Container registry — the image has to be pullable from Civo

`campfire.yaml` references `ghcr.io/jreoka/campfire:455515f` as a placeholder.
The repo has no image-publishing workflow yet (`.github/workflows/app-release.yml`
builds the *Tauri* app, not this container), so one of these has to happen:

- push to **GHCR** — free for a public repo, and public images need no pull
  secret. Needs a GitHub token with `write:packages` to push.
- push to **Civo's registry** or Docker Hub.
- build on the VPS and push from there.

Building the image itself is the same everywhere: `docker build -t <ref> .` from
the repo root, built at the commit you want to deploy.

---

## 1. Cluster prerequisites

```bash
# Confirm the default storage class civo-volume exists
kubectl get storageclass

# The node must have room for the pod
kubectl get nodes -o wide
kubectl describe node <node> | grep -A6 'Allocatable'
# A Civo Small reports ~1336Mi allocatable. If it is much less, stop and check.
```

**Civo cluster firewall** — open these for coturn. Without them TURN relays
silently and voice fails for users behind strict NAT. Everything else the app
needs is outbound-only via the tunnel.

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
  --from-literal=S3_ENDPOINT='<endpoint>' \
  --from-literal=S3_BUCKET='<bucket>' \
  --from-literal=S3_REGION='<region>' \
  --from-literal=S3_ACCESS_KEY='<key>' \
  --from-literal=S3_SECRET_KEY='<secret>'

# App secrets — copy the values from /opt/campfire/.env on the VPS
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

`JWT_SECRET` **must match production**, or every existing session is invalidated
on cutover and everyone has to log in again.

---

## 3. Deploy

```bash
kubectl apply -f deploy/civo/campfire.yaml
kubectl -n campfire get pods -w
```

Expect `db`, `campfire`, `coturn`, `cloudflared`. A `civo-volume` PVC stays
`Pending` until a pod consumes it (`WaitForFirstConsumer`) — that is normal.

---

## 4. Migrate the database (12 MB)

Take the dump on the VPS, move it, restore it. **The source is only ever read.**

```bash
# on the VPS
docker exec campfire-db pg_dump -U campfire -Fc campfire > /root/campfire-predeploy/cutover.dump

# locally
scp root@campfire.dill.moe:/root/campfire-predeploy/cutover.dump .
# COPY THE DUMP INTO THE CLUSTER, do not stream it through kubectl from the VPS
kubectl -n campfire cp cutover.dump db-0:/tmp/cutover.dump
kubectl -n campfire exec -it db-0 -- pg_restore -U campfire -d campfire --clean --if-exists /tmp/cutover.dump
kubectl -n campfire exec -it db-0 -- rm -f /tmp/cutover.dump
```

`--clean --if-exists` matters: the app creates its schema on boot, so the target
already has empty tables. Restoring over them keeps the migrations idempotent.

Then clear the restored **runtime** tables so the first boot behaves exactly like
a fresh single-replica start:

```bash
kubectl -n campfire exec db-0 -- psql -U campfire -d campfire -c \
  "TRUNCATE bus_replicas, bus_events, live_sessions, voice_occupants, rate_limits, webauthn_challenges;"
```

Why: the dump carries production's `bus_replicas` heartbeat rows, so the new pod
sees the **old OVH replica as a live peer** for up to 30 seconds and skips its
one-shot boot clears — the crash-gap documented in `server.js`. Truncating makes
the first boot unambiguous. These six are all runtime/ephemeral tables; no user
data lives in them.

Then verify counts against the source before moving on:

```bash
for t in users messages dm_messages attachments servers channels stories; do
  kubectl -n campfire exec db-0 -- psql -U campfire -d campfire -Atc "select '$t='||count(*) from $t"
done
# expected from production: users=2 messages=109 dm_messages=135 attachments=54 servers=2 channels=4 stories=1
```

Bounce the app so it reconnects and re-runs its guarded migrations:

```bash
kubectl -n campfire rollout restart deploy/campfire
kubectl -n campfire logs deploy/campfire | tail -20
# look for: [bus] listening ... and NO 'peer replica(s) live' line
```

---

## 5. Migrate object storage (115 objects / 105 MB)

`scripts/migrate-s3.js` copies and never deletes. It defaults to dry-run.

```bash
export SRC_S3_ENDPOINT=https://s3.us-east-va.io.cloud.ovh.us
export SRC_S3_BUCKET=campfire
export SRC_S3_REGION=us-east-va
export SRC_S3_ACCESS_KEY=... SRC_S3_SECRET_KEY=...      # from /opt/campfire/.env
export DST_S3_ENDPOINT=... DST_S3_BUCKET=...
export DST_S3_REGION=...  DST_S3_ACCESS_KEY=... DST_S3_SECRET_KEY=...
[ -n "$DST_S3_PATH_STYLE" ] || true

node scripts/migrate-s3.js --dry      # inventory + plan, writes nothing
node scripts/migrate-s3.js --write    # copy
node scripts/migrate-s3.js --verify   # compare key sets and sizes
```

Expected: `source: 115 object(s), 104.9 MiB` split
`files/ 96 · banners/ 3 · avatars/ 2 · backups/ 9 · sidebar/ 1 · emoji/ 1 · viewonce/ 1 · icons/ 2`,
then `verify: present in both 115, missing 0, size mismatch 0`.

This was rehearsed against the real bucket with a throwaway MinIO as the
destination and passed 115/115 with zero drift, so a mismatch now means a
credential or endpoint problem, not a tool problem.

---

## 6. Temporary hostname first

Do **not** repoint `campfire.dill.moe` yet. Add a second tunnel route
(`civo.dill.moe`) in the Cloudflare dashboard, then verify end to end:

- [ ] `https://civo.dill.moe/` loads and the app boots to the auth screen
- [ ] Log in (proves `JWT_SECRET` matched and the DB restore worked)
- [ ] Existing message history renders, including older attachments
- [ ] **An image/attachment loads from the new bucket** (proves S3 creds + keys)
- [ ] Upload a new file; it appears and is servable
- [ ] Voice: two clients connect a call through `turn:turn.dill.moe:3478`
- [ ] `kubectl -n campfire top pods` — total well under 1336 Mi
- [ ] `kubectl -n campfire get pods` shows 0 restarts after ~15 minutes
- [ ] `/healthz` and `/readyz` both 200

TURN reachability from outside, before touching DNS:

```bash
# from your machine
turnutils_uclient -v -u campfire -w '<TURN_PASS>' -p 3478 <node-public-ip>
# or point a browser WebRTC test at turn:<node-ip>:3478
```

---

## 7. Cut over

1. Put the VPS app in maintenance or accept a short window (the DB is 12 MB, so
   the window is seconds).
2. Re-run steps 4 and 5 to catch anything written since the first pass.
3. Repoint the `campfire` route to the cluster in Cloudflare.
4. Set `TURN_URL=turn:turn.dill.moe:3478` (a **separate** name from the app, so
   a future app DNS change can never break voice again) and create that record
   pointing at the Civo node IP.

   That record must be **DNS-only (grey cloud)**. Cloudflare's HTTP proxy does
   not carry UDP, so TURN cannot go through the tunnel — it has to be a plain A
   record to the node's public IP, with the firewall rules from step 1 open.
   The tunnel is for the app only.
5. Re-verify the checklist in step 6 against `campfire.dill.moe`.

## 8. Rollback (kept until you say otherwise)

Nothing has been deleted anywhere. The VPS, its `campfire_pgdata` volume and the
OVH bucket are untouched. To roll back: repoint the Cloudflare route at the VPS
and `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d` if
it was stopped. The pre-cutover dump is at
`/root/campfire-predeploy/cutover.dump`.

## 9. Known trade-off of VIRUS_SCAN=0

With scanning off, `startVirusScan()` returns before its loop
(`virus-scan.js:728`), so the single-pass path never runs. Uploads are recorded
`clean` immediately and served ungated. That is the accepted cost of fitting a
1336 MiB node — clamd alone measured **996 MiB** on production.

`MEDIA_COMPRESS=0` is set alongside it deliberately: otherwise compression falls
to the sweeper, which republishes the file *after* it is already visible and can
swap the bytes under someone playing it.

To get scanning back later, run clamd somewhere and point `CLAM_HOST` at it —
that is a config change, not a code change, and it is the one thing that would
let this fit on a small node with real AV.
