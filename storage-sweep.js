// Orphaned-upload sweep: deletes stored files nothing references anymore.
//
// Files become orphaned whenever a row pointing at them disappears without
// removing the bytes (message/channel/server deletes sweep their known
// files on the request path, but crashes, older versions, and uploads that
// never got attached to a message still strand bytes). This worker walks the
// bucket (minus `backups/`) and the local upload dir independently, and
// deletes files that are (a) unreferenced by any DB row, (b) older than
// ORPHAN_GRACE_H (uploads need time to get attached + scanned), and (c)
// not awaiting a virus scan.
//
// Safety posture is fail-CLOSED: any failure collecting the referenced set
// aborts the run before deleting anything. `backups/` objects are skipped
// before victim selection, so database dumps can never be touched.
//
// Env:
//   ORPHAN_SWEEP=0     disable entirely (default: enabled)
//   ORPHAN_GRACE_H     minimum file age before deletion (default 48, hours)
//
// `runSweepOnce({ dry: true })` reports the victims without deleting anything
// (admin: POST /api/admin/sweep/run?dry=1).
'use strict';

const fs = require('fs');
const path = require('path');

const db = require('./db');
const storage = require('./storage');

const now = () => Date.now();
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads');
const ENABLED = process.env.ORPHAN_SWEEP !== '0';
const _graceH = Number(process.env.ORPHAN_GRACE_H);
const GRACE_MS = (Number.isFinite(_graceH) && _graceH >= 0 ? _graceH : 48) * 3600 * 1000;
const FIRST_RUN_MS = 5 * 60 * 1000;
const EVERY_MS = 24 * 3600 * 1000;

const log = (...a) => console.log('[sweep]', ...a);
const warn = (...a) => console.warn('[sweep]', ...a);

let started = false;
let running = false;
let timer = null;
const stats = { lastRunAt: 0, lastResult: null, lastError: null, runs: 0 };

// Every DB reference to an uploaded object, in one pass. Two consumers:
//   - the orphan sweep needs `keys`: anything in here must never be deleted;
//   - media-compress's bucket scan needs `refs` — the rows and columns that can
//     be repointed when the bytes move to a new key — plus `textKeys`, the keys
//     that appear in message text (a pasted /uploads/ link). Those are kept (the
//     object must stay fetchable) but never rewritten: nothing gets to edit what
//     someone typed.
// Every table here has a TEXT `id` primary key, so a ref is addressable.
async function collectReferenceIndex() {
  const keys = new Set();
  const textKeys = new Set();
  const refs = new Map(); // key -> [{ table, col, id }]
  const addUrl = (key, ref) => {
    keys.add(key);
    if (!ref) return;
    const list = refs.get(key);
    if (list) list.push(ref);
    else refs.set(key, [ref]);
  };
  const scanCols = async (table, cols) => {
    const rows = await db.prepare(`SELECT id, ${cols.join(', ')} FROM ${table}`).all();
    for (const r of rows) {
      for (const c of cols) {
        if (!r[c]) continue;
        const key = storage.s3KeyFromUrl(String(r[c]).split('?')[0]);
        if (key) addUrl(key, { table, col: c, id: r.id });
      }
    }
  };
  await scanCols('attachments', ['url']);
  await scanCols('dm_attachments', ['url']);
  await scanCols('stories', ['url']);
  await scanCols('users', ['avatar_url', 'banner_url', 'sidebar_banner_url']);
  await scanCols('servers', ['icon_url', 'banner_url']);
  await scanCols('custom_emoji', ['url']);
  await scanCols('webhooks', ['avatar_url']);
  await scanCols('media_history', ['url']);
  // Pasted /uploads/ links inside message text (rare, but deleting the
  // file out from under a pasted link would break it).
  const scanText = async (sql) => {
    for (const r of await db.prepare(sql).all()) {
      if (!r.content || r.content.indexOf('/uploads/') < 0) continue;
      const re = /\/uploads\/[A-Za-z0-9._\/-]+/g;
      let m;
      while ((m = re.exec(r.content)) !== null) {
        const key = storage.s3KeyFromUrl(m[0].split('?')[0]);
        if (key) { keys.add(key); textKeys.add(key); }
      }
    }
  };
  await scanText("SELECT content FROM messages WHERE content LIKE '%/uploads/%'");
  await scanText("SELECT content FROM dm_messages WHERE content LIKE '%/uploads/%'");
  return { keys, textKeys, refs };
}

async function collectReferenced() {
  return (await collectReferenceIndex()).keys;
}


async function pendingScanKeys() {
  const set = new Set();
  try {
    for (const r of await db.prepare("SELECT key FROM file_scans WHERE status = 'pending'").all()) set.add(r.key);
  } catch {}
  return set;
}

// Every stored file: the whole bucket except `backups/` (keys are top-level:
// files/, avatars/, banners/, emoji/, icons/, sidebar/ — never a shared
// 'uploads/' prefix; listing that used to match nothing) + recursive local
// walk (covers pre-S3-migration leftovers in S3 mode).
// `opts.maxPages` bounds the bucket listing for callers that would rather report
// a partial pass than hang (media-compress's reconciliation does).
async function listStored(opts) {
  const out = []; // {key, mtime, size, where:'s3'|'local'}
  if (storage.s3Enabled()) {
    const objs = await storage.s3List('', { maxPages: (opts && opts.maxPages) || undefined });
    for (const o of objs) {
      if (!o.key || o.key.endsWith('/')) continue;
      // Database dumps live under backups/ and are never listed as sweepable.
      if (o.key === storage.BACKUP_PREFIX.slice(0, -1) || o.key.startsWith(storage.BACKUP_PREFIX)) continue;
      out.push({ key: o.key, mtime: o.modified ? new Date(o.modified).getTime() : 0, size: o.size || 0, where: 's3' });
    }
  }
  const walk = async (dir) => {
    let entries = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        try {
          const st = await fs.promises.stat(p);
          out.push({ key: path.relative(UPLOAD_DIR, p).split(path.sep).join('/'), mtime: st.mtimeMs, size: st.size, where: 'local' });
        } catch {}
      }
    }
  };
  await walk(UPLOAD_DIR);
  return out;
}

async function deleteStored(f) {
  if (f.where === 's3') {
    await storage.s3DeleteNow(f.key);
    return;
  }
  const p = path.join(UPLOAD_DIR, f.key);
  if (!path.resolve(p).startsWith(path.resolve(UPLOAD_DIR))) throw new Error('path_escape:' + f.key);
  await fs.promises.unlink(p);
}

// Prune scan rows for keys that exist nowhere (file gone, unreferenced).
// Pending rows are never pruned — the scanner owns those.
async function pruneScanRows(storedKeys, referenced) {
  let pruned = 0;
  let rows = [];
  try { rows = await db.prepare("SELECT key FROM file_scans WHERE status != 'pending'").all(); } catch { return 0; }
  for (const r of rows) {
    if (!r.key || storedKeys.has(r.key) || referenced.has(r.key)) continue;
    try { await db.prepare('DELETE FROM file_scans WHERE key = ?').run(r.key); pruned++; } catch {}
  }
  return pruned;
}

async function runOnce(opts) {
  if (!ENABLED || running) return null;
  const dry = !!(opts && opts.dry);
  running = true;
  const t0 = Date.now();
  const result = { scanned: 0, referenced: 0, deleted: 0, bytes: 0, prunedScans: 0, ms: 0 };
  try {
    // Fail closed: the referenced set must be complete before anything
    // is deleted. Any throw below aborts the run with zero deletes.
    const [index, pending, stored] = await Promise.all([collectReferenceIndex(), pendingScanKeys(), listStored()]);
    const referenced = index.keys;
    result.scanned = stored.length;
    result.referenced = referenced.size;
    const storedKeys = new Set(stored.map((f) => f.key));
    const cutoff = now() - GRACE_MS;
    // Same key on both backends (pre-migration leftovers): delete each
    // copy independently — stored[] carries its own `where`.
    const victims = stored.filter((f) =>
      !referenced.has(f.key) && !pending.has(f.key) && (f.mtime || 0) < cutoff);
    // Dry run: report exactly what would go, delete nothing (used to sanity
    // check a backend/prefix change against a real bucket before trusting it).
    if (dry) {
      result.dry = true;
      result.victimsTotal = victims.length;
      result.victims = victims.slice(0, 200).map((f) => ({ key: f.key, where: f.where, size: f.size || 0, mtime: f.mtime || 0 }));
      result.ms = Date.now() - t0;
      log(`sweep (dry): ${stored.length} stored, ${referenced.size} referenced, would delete ${victims.length} (${Math.round(victims.reduce((a, f) => a + (f.size || 0), 0) / 1024)}KB)`);
      return result;
    }
    for (const f of victims) {
      try {
        await deleteStored(f);
        result.deleted++;
        result.bytes += f.size || 0;
      } catch (e) {
        warn('delete failed for ' + f.key + ': ' + String((e && e.message) || e).slice(0, 120));
      }
    }
    result.prunedScans = await pruneScanRows(storedKeys, referenced);
    result.ms = Date.now() - t0;
    stats.lastRunAt = now();
    stats.lastResult = result;
    stats.lastError = null;
    stats.runs++;
    log(`sweep: ${stored.length} stored, ${referenced.size} referenced, ${result.deleted} deleted (${Math.round(result.bytes / 1024)}KB), ${result.prunedScans} scan rows pruned`);
    return result;
  } catch (e) {
    const err = String((e && e.message) || e).slice(0, 200);
    stats.lastError = { error: err, at: now() };
    warn('run aborted (no deletes): ' + err);
    return null;
  } finally {
    running = false;
  }
}

function schedule(ms) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    try {
      // Leader-only: two replicas sweeping at once would list the same orphans
      // and race to delete them, so the loser logs a stream of no-such-key
      // errors for work that was already done.
      await db.withLock(db.LOCKS.storageSweep, () => runOnce());
    } catch (e) { warn('run failed: ' + String((e && e.message) || e).slice(0, 200)); }
    schedule(EVERY_MS);
  }, ms);
  try { timer.unref(); } catch {}
}

function getSweepStats() {
  return { enabled: ENABLED, graceH: GRACE_MS / 3600 / 1000, runs: stats.runs, lastRunAt: stats.lastRunAt, lastResult: stats.lastResult, lastError: stats.lastError };
}

function startStorageSweep() {
  if (started) return;
  started = true;
  if (!ENABLED) { log('disabled (ORPHAN_SWEEP=0)'); return; }
  log(`worker on: every 24h, grace ${GRACE_MS / 3600 / 1000}h (backups/ never listed)`);
  schedule(FIRST_RUN_MS);
}

module.exports = { startStorageSweep, runSweepOnce: runOnce, getSweepStats, collectReferenceIndex, listStored };
