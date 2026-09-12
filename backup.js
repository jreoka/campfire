// Scheduled off-site backups to a Cloudflare R2 bucket.
//
// WHAT A SNAPSHOT IS
//   snapshots/<stamp>/manifest.json        inventory + checksums (written LAST)
//   snapshots/<stamp>/db/campfire.dump     pg_dump -Fc of the whole database
//   snapshots/<stamp>/secrets/secrets.json every k8s Secret in the namespace
//   blobs/<source key>                     the media bucket, deduplicated
//
// The media bucket is no longer a backup destination at all -- the database
// dump and the media live in R2, which is a different vendor from the store the
// app serves from. That is the point: a Civo account or bucket problem must not
// be able to take out the backups too.
//
// WHY BLOBS ARE SHARED AND NOT COPIED PER SNAPSHOT
//   Media is stored once under blobs/<its own key>; a snapshot only references
//   it from its manifest. "Keep a couple of snapshots" therefore costs a couple
//   of manifests plus whatever media is genuinely new, instead of a full copy
//   of the bucket every 12 hours.
//
//   Known limitation: a snapshot points at a key, not at immutable bytes. If a
//   key's content is rewritten in place (media-compress can do this; it is off
//   in production) an older snapshot will restore the newer bytes for that key.
//   Everything else about the snapshot stays point-in-time.
//
//   The manifest is written last, so a snapshot directory that exists is a
//   snapshot that completed.
//
// RUNS ONCE PER CLUSTER
//   Every replica runs this scheduler, so the work is behind the same advisory
//   lock the pg_dump always used (db.LOCKS.backups).

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('node:child_process');
const { pgEnv } = require('./db');
const db = require('./db');
const storage = require('./storage');
const r2 = require('./r2');

const SNAPSHOT_PREFIX = 'snapshots/';
const BLOB_PREFIX = 'blobs/';
const MANIFEST_NAME = 'manifest.json';
// "only a couple retained" -- 2 snapshots at a 12h cadence is 24h of history.
const KEEP = Math.max(1, parseInt(process.env.R2_BACKUP_KEEP || '2', 10) || 2);
// Catch up on boot when the newest snapshot is older than this: a bit under the
// 12h slot spacing, so a restart just before a slot still backfills.
const STALE_AFTER_MS = 11 * 3600 * 1000;

let running = false;

// UTC, filename-safe, lexicographically sortable: 20260912T054401Z
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function mb(n) {
  return (n / 1048576).toFixed(1) + 'MB';
}

function pgDumpToFile(tmp) {
  const e = pgEnv();
  return new Promise((resolve, reject) => {
    execFile('pg_dump', ['-Fc', '-f', tmp], {
      env: {
        ...process.env,
        PGHOST: e.PGHOST, PGPORT: e.PGPORT, PGDATABASE: e.PGDATABASE,
        PGUSER: e.PGUSER, PGPASSWORD: e.PGPASSWORD,
      },
      timeout: 10 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`pg_dump failed: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve();
    });
  });
}

// ---- cluster secrets -------------------------------------------------------
// A restore that has the database and the media but not JWT_SECRET logs every
// user out, and without the tunnel token there is no way back in from outside.
// Secrets are read from the API server with the pod's own ServiceAccount, which
// is granted get/list on secrets in this namespace only (see campfire.yaml).
//
// These are stored base64-decoded-able, i.e. plaintext-equivalent. The R2
// bucket is therefore as sensitive as the cluster itself.

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

function k8sAvailable() {
  return Boolean(process.env.KUBERNETES_SERVICE_HOST) && fs.existsSync(path.join(SA_DIR, 'token'));
}

function k8sGetJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: process.env.KUBERNETES_SERVICE_HOST,
      port: Number(process.env.KUBERNETES_SERVICE_PORT || 443),
      path: pathname,
      method: 'GET',
      ca: fs.readFileSync(path.join(SA_DIR, 'ca.crt')),
      headers: {
        Authorization: 'Bearer ' + fs.readFileSync(path.join(SA_DIR, 'token'), 'utf8').trim(),
        Accept: 'application/json',
      },
      timeout: 20000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad json from apiserver')); }
        } else {
          reject(new Error('apiserver ' + res.statusCode + ': ' + body.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('apiserver timeout')));
    req.end();
  });
}

async function collectSecrets() {
  if (!k8sAvailable()) return { ok: false, reason: 'not running in-cluster' };
  const nsFile = path.join(SA_DIR, 'namespace');
  const ns = fs.existsSync(nsFile) ? fs.readFileSync(nsFile, 'utf8').trim() : 'default';
  try {
    const r = await k8sGetJson('/api/v1/namespaces/' + encodeURIComponent(ns) + '/secrets');
    const out = {};
    for (const s of r.items || []) {
      const name = s.metadata && s.metadata.name;
      if (!name) continue;
      // ServiceAccount token secrets are minted per-pod and rotate; they are
      // not restorable state and backing them up is just noise.
      if ((s.type || '') === 'kubernetes.io/service-account-token') continue;
      out[name] = { type: s.type || 'Opaque', data: s.data || {} };
    }
    return { ok: true, namespace: ns, count: Object.keys(out).length, secrets: out };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

// ---- snapshot inventory ----------------------------------------------------

// Group snapshot objects into per-stamp directories, and split complete
// snapshots (they have a manifest) from orphans left by a failed run.
async function readSnapshotDirs() {
  const objs = await r2.list(SNAPSHOT_PREFIX);
  const dirs = new Map();
  for (const o of objs) {
    const rest = o.key.slice(SNAPSHOT_PREFIX.length);
    const s = rest.split('/')[0];
    if (!s) continue;
    if (!dirs.has(s)) dirs.set(s, []);
    dirs.get(s).push(o);
  }
  const complete = [];
  const orphans = [];
  for (const [s, list] of dirs) {
    if (list.some((o) => o.key === SNAPSHOT_PREFIX + s + '/' + MANIFEST_NAME)) complete.push(s);
    else orphans.push(s);
  }
  complete.sort();
  return { dirs, complete, orphans };
}

// Hashes from the newest existing manifest, so a reused blob keeps the hash it
// was first recorded with instead of being re-downloaded just to re-hash it.
async function previousHashes(complete) {
  const map = new Map();
  if (!complete.length) return map;
  const newest = complete[complete.length - 1];
  try {
    const buf = await r2.getBuffer(SNAPSHOT_PREFIX + newest + '/' + MANIFEST_NAME);
    const m = JSON.parse(buf.toString('utf8'));
    for (const o of m.objects || []) if (o && o.key && o.sha256) map.set(o.key, o.sha256);
  } catch (e) {
    console.warn('[backup] could not read previous manifest for hashes:', (e && e.message) || e);
  }
  return map;
}

// ---- the run ---------------------------------------------------------------

async function runBackup(reason) {
  if (!r2.r2Enabled()) {
    console.log('[backup] off-site backup skipped (R2_* env not configured)');
    return;
  }
  const r = await db.withLock(db.LOCKS.backups, () => runBackupLocked(reason));
  if (!r.ran) console.log('[backup] another replica holds the backup lock, skipping');
}

async function runBackupLocked(reason) {
  if (running) {
    console.log('[backup] already in progress, skipping');
    return;
  }
  running = true;
  const s = stamp();
  const dumpTmp = path.join(os.tmpdir(), `.campfire-dump-${process.pid}-${Date.now()}`);
  const started = [];
  const t0 = Date.now();
  try {
    // 1. the database
    await pgDumpToFile(dumpTmp);
    const dump = fs.readFileSync(dumpTmp);
    const dumpKey = SNAPSHOT_PREFIX + s + '/db/campfire.dump';
    await r2.put(dumpKey, dump, 'application/octet-stream');
    started.push(dumpKey);
    console.log(`[backup] ${s} database ${mb(dump.length)} (sha256 ${sha256(dump).slice(0, 12)}…) [${reason}]`);

    // 2. cluster secrets
    let secretsRef = null;
    const sec = await collectSecrets();
    if (sec.ok) {
      const key = SNAPSHOT_PREFIX + s + '/secrets/secrets.json';
      const buf = Buffer.from(JSON.stringify({
        capturedAt: new Date().toISOString(),
        namespace: sec.namespace,
        note: 'k8s Secret objects verbatim; data values are base64, i.e. plaintext-equivalent.',
        secrets: sec.secrets,
      }, null, 2));
      await r2.put(key, buf, 'application/json');
      started.push(key);
      secretsRef = { key, count: sec.count };
      console.log(`[backup] ${s} secrets ${sec.count} object(s)`);
    } else {
      // Loud, and recorded in the manifest: a snapshot without secrets is not
      // the fully self-contained rebuild we advertise.
      console.warn(`[backup] ${s} SECRETS NOT BACKED UP: ${sec.reason}`);
    }

    // 3. the media bucket, deduplicated
    const src = await storage.s3List('');
    const existing = new Map((await r2.list(BLOB_PREFIX)).map((o) => [o.key.slice(BLOB_PREFIX.length), o.size]));
    const dirsNow = await readSnapshotDirs();
    const prev = await previousHashes(dirsNow.complete);

    const objects = [];
    let uploaded = 0, reused = 0, bytes = 0;
    for (const o of src) {
      bytes += o.size;
      if (existing.get(o.key) === o.size) {
        reused++;
        objects.push({ key: o.key, size: o.size, sha256: prev.get(o.key) || null, reused: true });
        continue;
      }
      // Sequential on purpose: objects are capped at MAX_FILE_MB (50) and this
      // pod has a 640Mi limit, so downloading the bucket in parallel is how you
      // OOM a backup job.
      const got = await storage.s3Get(o.key);
      const buf = Buffer.from(await got.Body.transformToByteArray());
      await r2.put(BLOB_PREFIX + o.key, buf, got.ContentType || 'application/octet-stream');
      uploaded++;
      objects.push({ key: o.key, size: buf.length, sha256: sha256(buf), reused: false });
    }
    console.log(`[backup] ${s} media ${src.length} object(s), ${mb(bytes)}: ${uploaded} uploaded, ${reused} already stored`);

    // 4. the manifest, last
    const manifest = {
      version: 1,
      stamp: s,
      created: new Date().toISOString(),
      reason,
      pod: process.env.POD_ID || null,
      source: { bucket: storage.S3_BUCKET || null, objects: src.length, bytes },
      database: { key: dumpKey, size: dump.length, sha256: sha256(dump) },
      secrets: secretsRef,
      warnings: sec.ok ? [] : ['secrets not backed up: ' + sec.reason],
      media: { uploaded, reused, keep: KEEP },
      objects,
    };
    const manifestKey = SNAPSHOT_PREFIX + s + '/' + MANIFEST_NAME;
    await r2.put(manifestKey, Buffer.from(JSON.stringify(manifest, null, 2)), 'application/json');
    started.push(manifestKey);
    console.log(`[backup] ${s} snapshot complete in ${Math.round((Date.now() - t0) / 1000)}s`);

    await prune();
  } catch (e) {
    console.error('[backup] failed:', (e && e.message) || e);
    // Never leave a half-written snapshot behind: an orphan directory would
    // otherwise occupy one of the KEEP slots and evict a real snapshot.
    for (const k of started) {
      try { await r2.del(k); } catch {}
    }
    if (started.length) console.warn(`[backup] rolled back ${started.length} partial snapshot object(s)`);
  } finally {
    try { fs.unlinkSync(dumpTmp); } catch {}
    running = false;
  }
}

// ---- retention -------------------------------------------------------------

async function prune() {
  const { dirs, complete, orphans } = await readSnapshotDirs();

  // An empty snapshot list is never a reason to delete anything.
  if (!complete.length) {
    console.warn('[backup] prune skipped: no complete snapshot found');
    return;
  }

  const doomed = new Set(complete.slice(0, Math.max(0, complete.length - KEEP)));
  for (const o of orphans) doomed.add(o);

  let deleted = 0;
  for (const s of doomed) {
    for (const o of dirs.get(s) || []) {
      try { await r2.del(o.key); deleted++; } catch { console.warn('[backup] could not delete', o.key); }
    }
    if (orphans.includes(s)) console.log(`[backup] pruned incomplete snapshot ${s}`);
    else console.log(`[backup] pruned snapshot ${s}`);
  }

  const keep = complete.slice(-KEEP);
  console.log(`[backup] retention: keeping ${keep.length} snapshot(s) [${keep.join(', ')}], removed ${deleted} object(s)`);

  // Blob pruning is the dangerous half. Only delete a blob once EVERY retained
  // manifest has been read successfully and none of them references it; if any
  // manifest cannot be read, skip blob pruning entirely this run. A blob that a
  // retained snapshot still needs is a silently corrupt backup.
  const referenced = new Set();
  for (const s of keep) {
    let m;
    try {
      const buf = await r2.getBuffer(SNAPSHOT_PREFIX + s + '/' + MANIFEST_NAME);
      m = JSON.parse(buf.toString('utf8'));
    } catch (e) {
      console.warn(`[backup] blob prune SKIPPED: cannot read manifest for ${s} (${(e && e.message) || e})`);
      return;
    }
    if (!Array.isArray(m.objects)) {
      console.warn(`[backup] blob prune SKIPPED: manifest for ${s} has no object list`);
      return;
    }
    for (const o of m.objects) if (o && o.key) referenced.add(o.key);
  }

  const blobs = await r2.list(BLOB_PREFIX);
  let dropped = 0;
  for (const b of blobs) {
    const key = b.key.slice(BLOB_PREFIX.length);
    if (referenced.has(key)) continue;
    try { await r2.del(b.key); dropped++; } catch {}
  }
  if (dropped) console.log(`[backup] pruned ${dropped} blob(s) no retained snapshot references`);
}

// ---- schedule --------------------------------------------------------------

function msUntilNextSlot() {
  const t = new Date();
  for (const h of [0, 12]) {
    const d = new Date(t);
    d.setHours(h, 0, 0, 0);
    // Fire only when the slot is more than a minute out, so a restart seconds
    // before a slot does not double-run it (catch-up covers real gaps).
    if (d.getTime() > t.getTime() + 60e3) return d.getTime() - t.getTime();
  }
  const d = new Date(t);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime() - t.getTime();
}

function scheduleNext() {
  const ms = msUntilNextSlot();
  console.log(`[backup] next off-site snapshot ${new Date(Date.now() + ms).toString()} (00:00 / 12:00 server-local, keeps ${KEEP})`);
  const t = setTimeout(() => runBackup('scheduled').finally(scheduleNext), ms);
  try { t.unref(); } catch {}
}

// Snapshot age comes from the manifest's own stamp, not from LastModified, so a
// half-uploaded orphan can never look like a fresh backup.
async function maybeCatchUp() {
  try {
    const { complete } = await readSnapshotDirs();
    let age = Infinity;
    if (complete.length) {
      const last = complete[complete.length - 1];
      const m = last.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
      if (m) age = Date.now() - Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    }
    if (age > STALE_AFTER_MS) {
      console.log('[backup] newest snapshot is stale/missing -- catch-up run in 60s');
      const t = setTimeout(() => runBackup('catch-up'), 60e3);
      try { t.unref(); } catch {}
    }
  } catch (e) {
    console.warn('[backup] catch-up check failed:', (e && e.message) || e);
  }
}

function startBackups() {
  if (!r2.r2Enabled()) {
    console.log('[backup] off-site backups disabled (R2_* env not configured)');
    return;
  }
  scheduleNext();
  maybeCatchUp();
}

module.exports = { startBackups, runBackup };
