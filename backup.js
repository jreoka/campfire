// Scheduled off-site backups to a Cloudflare R2 bucket.
//
// WHAT A SNAPSHOT IS
//   snapshots/<stamp>/manifest.json        inventory + checksums (written LAST)
//   snapshots/<stamp>/db/campfire.dump     pg_dump -Fc of the whole database
//   snapshots/<stamp>/secrets/secrets.json the app's environment (which on
//                                          Compose IS the host .env) plus every
//                                          k8s Secret when running in-cluster
//
// WHAT A SNAPSHOT IS NOT: THE MEDIA
//   The media bucket is deliberately NOT copied here any more. It used to be,
//   deduplicated under blobs/<key> -- which doubled what the account stored, in
//   the SAME Cloudflare account that held the media it copied. So it could not
//   survive losing that account, and it bought nothing but the bill. A snapshot
//   now carries a media INVENTORY (key + size, a few bytes per object) and never
//   the bytes.
//
//   Stated plainly, because it is a real downgrade in what a restore can do:
//   the media bucket is the ONLY copy of the media. Database + Secrets are the
//   doomsday copy; the inventory is what lets a restore name the media that is
//   unaccounted for instead of guessing at it. A media byte cannot be recovered
//   from this bucket by any code path. scripts/purge-backup-blobs.js removes the
//   mirror the old design left behind.
//
//   Known limitation: a key is recorded, not pinned to immutable bytes, and media
//   keys are rewritten in place (media-compress) or reaped (view-once). The
//   inventory is a point-in-time record of what existed, nothing more.
//
//   The dump is written first and the manifest LAST, so a snapshot directory
//   that has a manifest is a snapshot that completed.
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
// The media mirror the old design wrote here. Nothing writes or reads it any
// more; prune() reaps whatever is left (see the note there).
const LEGACY_BLOB_PREFIX = 'blobs/';
const MANIFEST_NAME = 'manifest.json';
// The inventory is a few dozen bytes per media object, so it is cheap next to a
// media copy -- but it is still JSON in a manifest, and an unbounded list in a
// 12-hourly job is how a snapshot grows without anybody watching. Past this many
// objects the snapshot records the counts and says the list was omitted.
const MAX_INVENTORY = 100000;
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

// ---- secrets ---------------------------------------------------------------
// A restore that has the database but not JWT_SECRET logs every user out, and
// without the tunnel token there is no way back in from outside. There are two
// places those live, and a snapshot carries BOTH:
//
//   the pod's environment   every deployment. Docker Compose passes the host's
//                           .env to this container with `env_file`, so the
//                           environment IS the host's .env -- JWT_SECRET,
//                           POSTGRES_PASSWORD, TUNNEL_TOKEN, TURN_*, KLIPY_KEY,
//                           S3_*/R2_* -- with no bind mount of the host's file.
//                           On Kubernetes the same vars arrive from Secrets.
//   the k8s Secret objects  only in-cluster, read from the API server with the
//                           pod's own ServiceAccount (get/list in this
//                           namespace only; see campfire.yaml). Those keep
//                           things that are never mounted as env vars.
//
// Both are stored VERBATIM, i.e. plaintext-equivalent. The R2 bucket is
// therefore as sensitive as the host or cluster -- it holds the backup keys
// themselves.
const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

// Not configuration: the image's own runtime noise. A restore that sets PATH
// from a backup is how you get a broken container, and a container id is not
// state. Everything else in the environment is captured, including the plain
// config (STUN_URL, MAX_FILE_MB, UNFURL...): rebuilding the app means getting
// its settings back too, not only the passwords.
const ENV_NOISE = new Set([
  'PATH', 'HOME', 'PWD', 'OLDPWD', 'SHLVL', '_', 'TERM', 'LANG', 'LC_ALL',
  'HOSTNAME', 'NODE_VERSION', 'YARN_VERSION', 'POD_ID',
]);

function captureEnv() {
  const out = {};
  for (const k of Object.keys(process.env).sort()) {
    // Case-insensitively: Windows spells them Path/Home/ComSpec, and the noise
    // list is about meaning, not spelling.
    if (ENV_NOISE.has(k.toUpperCase()) || k.startsWith('npm_') || k.startsWith('KUBERNETES_')) continue;
    const v = process.env[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

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

async function collectK8sSecrets() {
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
    return { ok: true, namespace: ns, secrets: out };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

async function collectSecrets() {
  const env = captureEnv();
  const k8s = k8sAvailable()
    ? await collectK8sSecrets()
    : { ok: false, reason: 'not running in-cluster' };
  return { env, k8s };
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

    // 2. secrets: the running environment (every deployment) and, in-cluster,
    //    the Secret objects behind it.
    let secretsRef = null;
    const sec = await collectSecrets();
    const envNames = Object.keys(sec.env);
    const k8sCount = sec.k8s.ok ? Object.keys(sec.k8s.secrets).length : 0;
    if (envNames.length || k8sCount) {
      const key = SNAPSHOT_PREFIX + s + '/secrets/secrets.json';
      const buf = Buffer.from(JSON.stringify({
        capturedAt: new Date().toISOString(),
        source: k8sCount && envNames.length ? 'kubernetes+env' : (k8sCount ? 'kubernetes' : 'env'),
        note: 'plaintext-equivalent: env values are verbatim and every deployment passes the host .env ' +
          'to the app, so this file is the configuration a rebuild needs. The R2 bucket is as sensitive as the host.',
        kubernetes: sec.k8s.ok
          ? { namespace: sec.k8s.namespace, objects: sec.k8s.secrets }
          : { ok: false, reason: sec.k8s.reason || 'unavailable' },
        env: sec.env,
      }, null, 2));
      await r2.put(key, buf, 'application/json');
      started.push(key);
      secretsRef = { key, count: envNames.length + k8sCount, env: envNames.length, kubernetes: k8sCount, source: k8sCount && envNames.length ? 'kubernetes+env' : (k8sCount ? 'kubernetes' : 'env') };
      // Names only, never values: the log line is for "did JWT_SECRET go in?",
      // and a value in `docker compose logs` is a value leaked to everyone who
      // can read the logs.
      console.log(`[backup] ${s} secrets: ${envNames.length} env var(s)` +
        (k8sCount ? ` + ${k8sCount} k8s object(s)` : '') +
        ` [${envNames.join(' ').slice(0, 300)}${envNames.join(' ').length > 300 ? ' …' : ''}]`);
    } else {
      // Loud, and recorded in the manifest: a snapshot without secrets is not
      // the fully self-contained rebuild we advertise.
      console.warn(`[backup] ${s} SECRETS NOT BACKED UP: nothing in the environment` +
        (sec.k8s.reason ? ` and ${sec.k8s.reason}` : ''));
    }

    // 3. the media bucket -- an inventory, never the bytes (see the header).
    //    No download, no upload: the only thing this costs is the listing call
    //    the backup already needed, and it is what a restore reads to say which
    //    media the snapshot knew about.
    const src = await storage.s3List('');
    const inventory = [];
    let mediaBytes = 0;
    for (const o of src) {
      // The media bucket's own backups/ prefix is not media: it is the legacy
      // pile from before the doomsday copy moved to R2, and it is nothing a
      // reader could ever fetch. Leaving it out keeps the inventory honest.
      if (o.key === 'backups' || o.key.startsWith(storage.BACKUP_PREFIX)) continue;
      inventory.push({ key: o.key, size: o.size });
      mediaBytes += o.size;
    }
    const listed = inventory.length > MAX_INVENTORY ? null : inventory;
    console.log(`[backup] ${s} media inventory ${inventory.length} object(s), ${mb(mediaBytes)} ` +
      `${listed ? '' : '(list omitted: over ' + MAX_INVENTORY + ') '}-- bytes stay in the media bucket`);

    // 4. the manifest, last
    const manifest = {
      version: 2,
      stamp: s,
      created: new Date().toISOString(),
      reason,
      pod: process.env.POD_ID || null,
      source: { bucket: storage.S3_BUCKET || null, objects: inventory.length, bytes: mediaBytes },
      database: { key: dumpKey, size: dump.length, sha256: sha256(dump) },
      secrets: secretsRef,
      warnings: secretsRef ? [] : ['secrets not backed up: nothing in the environment'],
      media: {
        // The load-bearing flag: a snapshot with this false has no media bytes
        // in it and nothing in this bucket can conjure any.
        included: false,
        note: 'inventory only -- media bytes live in the media bucket and are not copied here',
        objects: inventory.length,
        bytes: mediaBytes,
        inventory: listed,
        inventoryOmitted: listed ? null : `${inventory.length} objects (over the ${MAX_INVENTORY} entry cap)`,
      },
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

  // The legacy media mirror, reaped. Nothing writes blobs/ any more and nothing
  // reads it -- a snapshot names keys, not blobs -- so whatever is still there
  // is a second copy of the media bucket kept purely to pay for it twice. A
  // first pass is a big delete, which is why scripts/purge-backup-blobs.js
  // exists to do it deliberately, dry-run first; this is the backstop that
  // makes it stay gone (an older deployment writing blobs again, a purge that
  // was interrupted). Deleting a blob can never break a retained snapshot,
  // because no code path reads one to restore anything.
  let blobs = [];
  try {
    blobs = await r2.list(LEGACY_BLOB_PREFIX);
  } catch (e) {
    console.warn('[backup] could not list legacy blobs/:', (e && e.message) || e);
  }
  if (blobs.length) {
    const bytes = blobs.reduce((n, b) => n + (b.size || 0), 0);
    try {
      const n = await r2.delMany(blobs.map((b) => b.key));
      console.log(`[backup] reaped ${n} legacy blob(s) (${mb(bytes)}): snapshots store no media bytes`);
    } catch (e) {
      console.warn('[backup] legacy blob reap failed:', (e && e.message) || e);
    }
  }
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
