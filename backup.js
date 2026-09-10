// Scheduled SQLite backups to S3 (top-level `backups/` prefix).
//
// - Runs twice a day at 00:00 and 12:00 server-local time, plus a catch-up
//   run ~1 minute after boot when the newest backup is older than 11h
//   (covers downtime/a missed slot across restarts and deploys).
// - Online snapshot via `VACUUM INTO`: consistent copy, no restart, no
//   downtime, readers/writers keep going. The snapshot is gzipped and
//   uploaded as `backups/campfire-YYYYMMDDTHHMMSSZ.db.gz` (UTC stamp, so
//   key order == chronological order).
// - Keeps the newest BACKUP_KEEP dumps (default 10), pruning older ones.
// - The `backups/` prefix is deliberately unservable: storage.s3KeyFromUrl
//   refuses it, so no /uploads/* URL (guessed or otherwise) can ever reach
//   a backup. Nothing here generates public URLs either.
// - No-ops (with a log line) when S3_* env is not configured.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const db = require('./db');
const storage = require('./storage');

const PREFIX = 'backups/';
const KEEP = Math.max(1, parseInt(process.env.BACKUP_KEEP || '10', 10) || 10);
// Catch up on boot when the newest backup is older than this (a bit under
// the 12h slot spacing, so a restart just before a slot still backfills).
const STALE_AFTER_MS = 11 * 3600 * 1000;

let running = false;

// UTC, filename-safe, lexicographically sortable: 20260910T003000Z
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function stampMs(key) {
  const m = String(key || '').match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.db\.gz$/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function isDumpKey(key) {
  return typeof key === 'string' && key.startsWith(PREFIX) && key.endsWith('.db.gz');
}

async function runBackup(reason) {
  if (!storage.s3Enabled()) {
    console.log('[backup] skipped (S3 not configured)');
    return;
  }
  if (running) {
    console.log('[backup] already in progress, skipping');
    return;
  }
  running = true;
  const tmp = path.join(path.dirname(db.DB_PATH), `.backup-${process.pid}-${Date.now()}.db`);
  try {
    // Consistent online snapshot; path is embedded as a literal (VACUUM
    // takes no bound parameters), so single-quotes are doubled.
    db.prepare(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`).run();
    const raw = fs.readFileSync(tmp);
    const gz = zlib.gzipSync(raw, { level: 9 });
    const key = `${PREFIX}campfire-${stamp()}.db.gz`;
    await storage.s3Put(key, gz, 'application/gzip');
    console.log(`[backup] uploaded ${key} (${raw.length} -> ${gz.length} bytes) [${reason}]`);
    // Retain the newest KEEP dumps (including the one just uploaded).
    const all = (await storage.s3List(PREFIX)).map((o) => o.key).filter((k) => k !== key && isDumpKey(k)).sort();
    const stale = all.slice(0, Math.max(0, all.length + 1 - KEEP));
    for (const k of stale) {
      try {
        await storage.s3DeleteNow(k);
        console.log(`[backup] pruned ${k}`);
      } catch {
        console.warn(`[backup] prune failed for ${k}`);
      }
    }
  } catch (e) {
    console.error('[backup] failed:', (e && e.message) || e);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
    running = false;
  }
}

function msUntilNextSlot() {
  const t = new Date();
  for (const h of [0, 12]) {
    const d = new Date(t);
    d.setHours(h, 0, 0, 0);
    // Fire only when the slot is more than a minute out, so a restart
    // seconds before a slot doesn't double-run it (catch-up covers gaps).
    if (d.getTime() > t.getTime() + 60e3) return d.getTime() - t.getTime();
  }
  const d = new Date(t);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime() - t.getTime();
}

function scheduleNext() {
  const ms = msUntilNextSlot();
  console.log(`[backup] next run at ${new Date(Date.now() + ms).toString()} (00:00 / 12:00 server-local, keeps ${KEEP})`);
  const t = setTimeout(() => runBackup('scheduled').finally(scheduleNext), ms);
  try { t.unref(); } catch {}
}

async function maybeCatchUp() {
  try {
    const keys = (await storage.s3List(PREFIX)).map((o) => o.key).filter(isDumpKey).sort();
    let age = Infinity;
    if (keys.length) {
      const ts = stampMs(keys[keys.length - 1]);
      if (ts !== null) age = Date.now() - ts;
    }
    if (age > STALE_AFTER_MS) {
      console.log('[backup] newest backup is stale/missing — catch-up run in 60s');
      const t = setTimeout(() => runBackup('catch-up'), 60e3);
      try { t.unref(); } catch {}
    }
  } catch (e) {
    console.warn('[backup] catch-up check failed:', (e && e.message) || e);
  }
}

function startBackups() {
  if (!storage.s3Enabled()) {
    console.log('[backup] disabled (S3_* env not configured)');
    return;
  }
  scheduleNext();
  maybeCatchUp();
}

module.exports = { startBackups, runBackup };
