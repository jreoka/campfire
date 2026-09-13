// Measure the images that predate their own shape record.
//
// `attachments.w/h` (see db.js) is what lets a reader reserve a picture's box
// before its bytes arrive, so the conversation doesn't collapse to nothing and
// then shove itself as the picture pops in. New uploads carry their size with
// them; everything already posted does not, and there is no way to ask a
// browser for the size of a picture it has not downloaded.
//
// So this worker reads the head of each unmeasured image out of the object store
// and parses its dimensions from the file's own header (image-size.js — no
// ffmpeg, no decode, ~64 KB a look). It works newest-first, so the pictures
// people are actually scrolling past are the ones that heal first, in small
// bounded batches that never compete with serving.
//
// The record is deliberately three-valued:
//   NULL — never looked at (what this worker selects on)
//   0/0  — looked at, nothing to reserve (a video, a file, a remote GIF, or a
//          format no header parse understands) — never re-read
//   w/h  — the real thing
// which is why one pass is enough and the partial index in db.js shrinks to
// nothing instead of re-scanning forever.
//
// Env:
//   ATT_DIMS=0        disable entirely (default: enabled)
//   ATT_DIMS_BATCH    objects measured per run (default 80)
'use strict';

const fs = require('fs');
const path = require('path');

const db = require('./db');
const storage = require('./storage');
const { dimsFromBuffer, dimsFromFile, HEAD_BYTES } = require('./image-size');

const now = () => Date.now();
const UPLOAD_DIR = storage.UPLOAD_DIR;
const ENABLED = process.env.ATT_DIMS !== '0';
const _batch = parseInt(process.env.ATT_DIMS_BATCH || '80', 10);
const BATCH = Number.isFinite(_batch) && _batch > 0 ? Math.min(_batch, 500) : 80;
const FIRST_RUN_MS = 45 * 1000;
const EVERY_MS = 5 * 60 * 1000;
// One object at a time, with a breath between them: this is background tidying,
// and it must never look like load to the bucket or the box.
const PACE_MS = 40;

const log = (...a) => console.log('[dims]', ...a);
const warn = (...a) => console.warn('[dims]', ...a);

let started = false;
let running = false;
let timer = null;
const stats = { lastRunAt: 0, lastResult: null, lastError: null, runs: 0, measured: 0 };

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); try { t.unref(); } catch {} });

// The intrinsic size of one stored object, or null when it cannot be read or
// nothing recognises its header. A ranged GET keeps this to one small request
// per picture even for a 50 MB video that turned out to be mislabeled.
async function measureKey(key) {
  if (!storage.s3Enabled()) {
    const p = path.join(UPLOAD_DIR, key);
    if (!path.resolve(p).startsWith(path.resolve(UPLOAD_DIR) + path.sep)) return null;
    return dimsFromFile(fs, p, HEAD_BYTES);
  }
  const r = await storage.s3Get(key, 'bytes=0-' + (HEAD_BYTES - 1));
  if (!r || !r.Body) return null;
  const chunks = [];
  let n = 0;
  for await (const c of r.Body) {
    chunks.push(c);
    n += c.length;
    if (n >= HEAD_BYTES) break;
  }
  return dimsFromBuffer(Buffer.concat(chunks).subarray(0, HEAD_BYTES));
}

async function mark(table, id, dims) {
  await db.prepare(`UPDATE ${table} SET w = ?, h = ? WHERE id = ?`)
    .run(dims ? dims.w : 0, dims ? dims.h : 0, id);
}

// Measure up to `limit` rows of one table. Returns how many were answered.
async function measureTable(table, limit) {
  if (limit < 1) return 0;
  // Newest first: the media most likely to be rendered again heals first.
  const rows = await db.prepare(`SELECT id, url, kind FROM ${table} WHERE w IS NULL ORDER BY created_at DESC LIMIT ?`).all(limit);
  let done = 0;
  for (const row of rows) {
    try {
      if (row.kind !== 'image') { await mark(table, row.id, null); done++; continue; }
      // A remote picture (the GIF picker) has no object of ours to read, and is
      // never fetched from here — SSRF discipline is the unfurl path's job.
      const key = storage.s3KeyFromUrl(String(row.url || '').split('?')[0]);
      if (!key) { await mark(table, row.id, null); done++; continue; }
      const dims = await measureKey(key);
      await mark(table, row.id, dims);
      done++;
    } catch (e) {
      // One unreadable object (deleted bytes, a storage hiccup) must not stop
      // the run: leave it NULL and try again next time.
      warn('could not measure ' + table + ' ' + row.id + ': ' + String((e && e.message) || e).slice(0, 120));
    }
    await sleep(PACE_MS);
  }
  return done;
}

async function runOnce(opts = {}) {
  if (running) return null;
  running = true;
  const t0 = now();
  const limit = Math.max(1, Number(opts.limit) || BATCH);
  try {
    const result = { measured: 0, ranAt: t0, ms: 0 };
    // Split the budget: a channel backlog and a DM backlog heal together rather
    // than one table starving the other.
    result.measured += await measureTable('attachments', Math.ceil(limit / 2));
    result.measured += await measureTable('dm_attachments', Math.floor(limit / 2));
    result.ms = now() - t0;
    stats.lastRunAt = now();
    stats.lastResult = result;
    stats.lastError = null;
    stats.runs++;
    stats.measured += result.measured;
    if (result.measured) log(`measured ${result.measured} image(s) in ${result.ms}ms`);
    return result;
  } catch (e) {
    const err = String((e && e.message) || e).slice(0, 200);
    stats.lastError = { error: err, at: now() };
    warn('run aborted: ' + err);
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
      // Leader-only: the work is idempotent but the reads are not free, and two
      // replicas would measure the same rows.
      await db.withLock(db.LOCKS.attDims, () => runOnce());
    } catch (e) { warn('run failed: ' + String((e && e.message) || e).slice(0, 200)); }
    schedule(EVERY_MS);
  }, ms);
  try { timer.unref(); } catch {}
}

function getDimsStats() {
  return { enabled: ENABLED, batch: BATCH, runs: stats.runs, measured: stats.measured, lastRunAt: stats.lastRunAt, lastResult: stats.lastResult, lastError: stats.lastError };
}

function startAttDims() {
  if (started) return;
  started = true;
  if (!ENABLED) { log('disabled (ATT_DIMS=0)'); return; }
  log(`worker on: ${BATCH} image(s) every ${EVERY_MS / 60000}min, newest first`);
  schedule(FIRST_RUN_MS);
}

module.exports = { startAttDims, runOnce, getDimsStats };
