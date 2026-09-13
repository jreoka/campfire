// Whole-bucket malware scan: adopt every stored object Harbin has never judged.
//
// Why this exists. `file_scans` only ever holds what the upload path queued, and
// the serving gate treats an unknown key as clean. So anything stored while
// scanning was off, anything from before the feature existed, and anything an
// earlier engine judged has no HARBIN verdict at all — and nothing would ever
// give it one. This worker closes that hole on a schedule: it lists the stored
// tree, queues the keys with no Harbin verdict behind them, and stops there.
//
// The work itself is virus-scan.js's, deliberately: the queue, the engine call,
// the deletion of an infected object and the live re-broadcast all already
// exist, so the verdict policy stays in exactly one place and this module is
// only a reconciler.
//
// Three properties make it safe to point at a live bucket:
//   - A key Harbin has already judged is never re-queued. The row IS the
//     ledger (`engine` is set exactly when a Harbin verdict was recorded), so
//     a pass is bounded by what is genuinely unjudged, and a file is never
//     re-scanned — and so never re-judged — just because a day went by.
//   - An adopted key is queued UNGATED. A file a reader can already fetch is
//     served while its background verdict is pending (see effectiveStatus in
//     virus-scan.js), so a scan can only ever remove malware; it can never
//     briefly take a working file away, or blink a chat card back to
//     "Processing". An upload is still gated, because that promise is about
//     bytes nobody has been handed yet.
//   - An object already flagged is left alone. Its bytes are gone and its row
//     is the record of the removal that the chat card reads.
//
// `backups/` (database dumps) and `thumbs/` (derived previews of a scanned
// source) are never listed — listStored in storage-sweep.js excludes both.
//
// Env:
//   BUCKET_SCAN=0          disable entirely (default: enabled)
//   BUCKET_SCAN_EVERY_MS   period between passes (default 24h, min 10min)
//   BUCKET_SCAN_FIRST_MS   delay before the first pass (default 10min, min 30s)
//   BUCKET_SCAN_MAX_JOBS   keys queued per pass (default 200, max 5000)
//   BUCKET_SCAN_MAX_PAGES  bucket listing pages per pass (default 100)
//
// `runOnce({ dry: true })` reports what a pass would adopt and queues nothing
// (admin: POST /api/admin/scan/run?dry=1) — the way to size a first pass against
// a real bucket before letting it loose.
'use strict';

const db = require('./db');

const now = () => Date.now();
const ENABLED = process.env.BUCKET_SCAN !== '0';
const num = (v, dflt, min, max) => {
  const n = parseInt(v || '', 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};
const EVERY_MS = num(process.env.BUCKET_SCAN_EVERY_MS, 24 * 3600 * 1000, 10 * 60 * 1000, 30 * 24 * 3600 * 1000);
const FIRST_MS = num(process.env.BUCKET_SCAN_FIRST_MS, 10 * 60 * 1000, 30 * 1000, 24 * 3600 * 1000);
const MAX_JOBS = num(process.env.BUCKET_SCAN_MAX_JOBS, 200, 1, 5000);
const MAX_PAGES = num(process.env.BUCKET_SCAN_MAX_PAGES, 100, 1, 1000);

const log = (...a) => console.log('[scansweep]', ...a);
const warn = (...a) => console.warn('[scansweep]', ...a);

let started = false;
let running = false;
let timer = null;
let kickTimer = null;
const stats = { lastRunAt: 0, lastResult: null, lastError: null, runs: 0 };

// Which stored keys are already settled, and which are candidates. One read of
// the table (a few columns, no joins) rather than a query per object.
function classify(rows, engineReady) {
  const skip = new Set();
  let judged = 0;
  let errored = 0;
  for (const r of rows) {
    if (!r.key) continue;
    if (r.status === 'infected') { skip.add(r.key); continue; }   // bytes are gone; the row is the record
    if (r.status === 'pending') { skip.add(r.key); continue; }    // already in flight
    if (r.status === 'clean' && r.engine) { skip.add(r.key); judged++; continue; }
    // A row with no engine is a file NO HARBIN VERDICT ever covered: an upload
    // from the era when the scanner was off, or one an earlier engine judged.
    // A row in `error` is the same hole with a failed attempt recorded — retried
    // only while the engine is actually answering, so a broken engine cannot
    // turn every pass into the same pile of failures.
    if (r.status === 'error') {
      errored++;
      if (!engineReady) skip.add(r.key);
    }
  }
  return { skip, judged, errored };
}

async function runOnce(opts) {
  if (!ENABLED || running) return null;
  const vs = require('./virus-scan');
  if (!vs.scanningEnabled()) return { skipped: 'scanning_off' };
  const dry = !!(opts && opts.dry);
  running = true;
  const t0 = Date.now();
  const result = { dry: false, listed: 0, judged: 0, candidates: 0, queued: 0, capped: false, ms: 0 };
  try {
    let engineReady = false;
    try { const st = await vs.getScanStats(); engineReady = !!(st && st.engine === 'ready'); } catch {}

    const stored = await require('./storage-sweep').listStored({ maxPages: MAX_PAGES });
    // The same key can appear twice across backends (pre-migration leftovers);
    // it is one object as far as a verdict is concerned.
    const byKey = new Map();
    for (const f of stored) if (f.key && !byKey.has(f.key)) byKey.set(f.key, f);
    result.listed = byKey.size;

    const rows = await db.prepare('SELECT key, status, engine FROM file_scans').all();
    const { skip, judged, errored } = classify(rows, engineReady);
    result.judged = judged;
    result.errored = errored;

    const candidates = [];
    for (const f of byKey.values()) if (!skip.has(f.key)) candidates.push(f);
    // Oldest first: a key with no verdict is most likely one that has been
    // unjudged longest (the era the scanner was off), and a pass is capped, so
    // the backlog drains in the order it accumulated.
    candidates.sort((a, b) => (a.mtime || 0) - (b.mtime || 0));
    result.candidates = candidates.length;
    result.capped = candidates.length > MAX_JOBS;

    if (dry) {
      result.dry = true;
      result.would = candidates.slice(0, 200).map((f) => ({ key: f.key, where: f.where, size: f.size || 0, mtime: f.mtime || 0 }));
      result.ms = Date.now() - t0;
      log(`scan sweep (dry): ${result.listed} stored, ${judged} already judged by Harbin, would adopt ${candidates.length}`);
      return result;
    }

    for (const f of candidates.slice(0, MAX_JOBS)) {
      try {
        // `retro` is what keeps the reader's file: the row is queued ungated, so
        // the gate keeps serving it until a verdict actually changes something.
        if ((await vs.queueFileScan(f.key, { retro: true })) === 'pending') result.queued++;
      } catch (e) {
        warn('queue failed for ' + f.key + ': ' + String((e && e.message) || e).slice(0, 140));
      }
    }
    result.ms = Date.now() - t0;
    stats.lastRunAt = now();
    stats.lastResult = result;
    stats.lastError = null;
    stats.runs++;
    log(`scan sweep: ${result.listed} stored, ${judged} already judged, ${result.queued} queued`
      + (result.capped ? ` (capped at ${MAX_JOBS}, rest next pass)` : ''));
    return result;
  } catch (e) {
    const err = String((e && e.message) || e).slice(0, 200);
    stats.lastError = { error: err, at: now() };
    warn('run failed: ' + err);
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
      // Leader-only: every replica listing the same bucket and queueing the same
      // keys is wasted work, and the queue's own atomic claim would then have
      // each replica racing the others for rows none of them needed to create.
      await db.withLock(db.LOCKS.bucketScan, () => runOnce());
    } catch (e) { warn('run failed: ' + String((e && e.message) || e).slice(0, 200)); }
    schedule(EVERY_MS);
  }, ms);
  try { timer.unref(); } catch {}
}

// The admin panel's "Scan the bucket now": the pass can take minutes, so it runs
// behind the response and the panel polls /api/admin/media for the result.
// Deliberately NOT unref'd — this is work an operator just asked for, so an
// otherwise-idle event loop must not be able to drop it (the periodic timer
// above IS unref'd, because that one must never hold the process open).
function kickBucketScan() {
  if (!ENABLED || kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    db.withLock(db.LOCKS.bucketScan, () => runOnce())
      .catch((e) => warn('kicked run failed: ' + String((e && e.message) || e).slice(0, 200)));
  }, 50);
}

function getBucketScanStats() {
  return {
    enabled: ENABLED, everyH: EVERY_MS / 3600 / 1000, everyMs: EVERY_MS, maxJobs: MAX_JOBS, maxPages: MAX_PAGES,
    runs: stats.runs, lastRunAt: stats.lastRunAt, lastResult: stats.lastResult, lastError: stats.lastError,
  };
}

function startBucketScan() {
  if (started) return;
  started = true;
  if (!ENABLED) { log('disabled (BUCKET_SCAN=0)'); return; }
  const span = (ms) => (ms < 3600000 ? Math.round(ms / 60000) + 'min' : Math.round(ms / 3600000) + 'h');
  log(`worker on: every ${span(EVERY_MS)}, first in ${span(FIRST_MS)}, `
    + `up to ${MAX_JOBS} object(s) per pass (backups/ and thumbs/ never listed)`);
  schedule(FIRST_MS);
}

module.exports = { startBucketScan, runBucketScanOnce: runOnce, kickBucketScan, getBucketScanStats, _classify: classify };
