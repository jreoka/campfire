// Background media compressor: shrinks chat uploads (images, GIFs, video,
// audio) in place so storage + bandwidth stay small without anyone noticing.
//
// Design notes:
// - Single-container friendly: runs in-process (see startMediaCompress),
//   never on the request path, so uploads stay instant.
// - Continuous while work exists: the worker chains ticks back-to-back with
//   a short breather (MEDIA_COMPRESS_ACTIVE_MS, default 2s) whenever the
//   queue still has pending files, and falls back to a slow idle poll
//   (MEDIA_COMPRESS_EVERY_MS, default 30s) once the queue drains. New
//   uploads also wake it via kickMediaCompress, so files typically compress
//   within seconds instead of waiting for the next idle poll.
// - Low CPU by construction: ONE file at a time (process-wide lock across the
//   sweeper and the scan pipeline), `nice -n 19`
//   on POSIX, ffmpeg `-threads 1`, small per-tick batch, short breather
//   between hot ticks, and a load-average check that defers ticks when
//   the box is busy.
// - Visually transparent settings only (see PIPELINES): quality levels where
//   artifacts are essentially invisible in chat embeds, plus downscale caps
//   (2048px stills / 1280px GIFs / 1080p video) that only bite oversized
//   sources. Files that would shrink <8% keep their original bytes.
// - Idempotent + resumable: attachments/dm_attachments carry a `compressed`
//   flag (0 = pending, 1 = done). Every upload is queued automatically via
//   the column default; the backlog of pre-existing media drains gradually.
// - Single pass with the scanner: virus-scan.js calls processUpload() after a
//   clean verdict, scans the candidate output too, and only then publishes
//   the file. Clients see ONE pending -> final transition, so a player that
//   just appeared is never swapped out from under itself. This sweeper stays
//   as the fallback for anything the pipeline missed (scanning off or
//   unavailable, the pre-existing backlog, a failed candidate scan).
// - ... and the same slot runs WITHOUT a scanner: with VIRUS_SCAN=0 the
//   worker still claims every upload, compresses it before anything is
//   published, and only then lets it be served (virus-scan.js processRow). So
//   the one-transition promise holds on a box that cannot afford clamd.
// - Anything the sweeper touches is ALREADY visible, so it always publishes
//   under a fresh key and leaves the old bytes for the orphan sweep: bytes
//   behind a live URL are never rewritten under a reader.
// - Same URL shape always (/uploads/<sub>/<file>?v=<cachekey>). Before
//   publication a same-format result overwrites in place with a fresh ?v
//   cache-buster; format changes (wav/flac -> mp3, mov/webm video -> mp4) mint a
//   new random filename and the DB row (url/mime/size) is updated to match.
//   The sweeper's path always mints a new filename (see above). Display
//   filenames are never touched.
// - Needs ffmpeg on PATH (Docker image installs it via apk). Without ffmpeg
//   the worker logs once and stays idle — the app runs fine uncompressed.
//
// Env:
//   MEDIA_COMPRESS=0          disable entirely (default: enabled)
//   MEDIA_COMPRESS_EVERY_MS   ms between ticks once the queue is empty
//                             (idle poll; default 30000, min 5000)
//   MEDIA_COMPRESS_ACTIVE_MS  ms between ticks while files remain queued
//                             (default 2000, min 250)
//   MEDIA_COMPRESS_BATCH      files compressed per tick (default 1, max 5)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');

const db = require('./db');
const storage = require('./storage');

const uid = () => crypto.randomUUID();
const now = () => Date.now();

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads');
const ENABLED = process.env.MEDIA_COMPRESS !== '0';
const EVERY_MS = Math.max(5000, parseInt(process.env.MEDIA_COMPRESS_EVERY_MS || '30000', 10) || 30000);
const ACTIVE_MS = Math.max(250, parseInt(process.env.MEDIA_COMPRESS_ACTIVE_MS || '2000', 10) || 2000);
const DEFER_MS = Math.max(ACTIVE_MS, 5000); // retry delay when the box is hot
const KICK_MS = 500; // wake-up delay after a new upload lands
const BATCH = Math.min(5, Math.max(1, parseInt(process.env.MEDIA_COMPRESS_BATCH || '1', 10) || 1));
const JOB_TIMEOUT_MS = 15 * 60 * 1000; // pathological inputs can't wedge the queue
const MIN_SAVING = 0.08; // replace only when the output is >=8% smaller

// Skip files below these sizes (CPU would buy almost nothing).
const MIN_BYTES = { image: 400 * 1024, gif: 800 * 1024, video: 2 * 1024 * 1024, audio: 1024 * 1024 };

// Bucket reconciliation. The queue above is flag-driven, which covers the chat
// tables and stories — but a flag only exists for a table someone remembered to
// give one, and an object whose row was written before a table had a flag (or by
// a path that never queued it at all) would sit at full size forever. So a
// scheduled pass lists the bucket itself, and anything referenced, above the
// size floor, and not already accounted for in the key ledger gets compressed.
// See reconcileBucket().
const SWEEP_ENABLED = process.env.MEDIA_BUCKET_SWEEP !== '0';
const SWEEP_EVERY_MS = Math.max(10 * 60 * 1000, parseInt(process.env.MEDIA_SWEEP_EVERY_MS || String(6 * 3600 * 1000), 10) || 6 * 3600 * 1000);
const SWEEP_FIRST_MS = Math.max(30 * 1000, parseInt(process.env.MEDIA_SWEEP_FIRST_MS || String(10 * 60 * 1000), 10) || 10 * 60 * 1000);
const SWEEP_BUSY_MS = Math.max(30 * 1000, parseInt(process.env.MEDIA_SWEEP_BUSY_MS || String(2 * 60 * 1000), 10) || 2 * 60 * 1000);
const SWEEP_MAX_JOBS = Math.max(1, parseInt(process.env.MEDIA_SWEEP_MAX_JOBS || '100', 10) || 100); // per pass
const SWEEP_MAX_MS = Math.max(30 * 1000, parseInt(process.env.MEDIA_SWEEP_MAX_MS || String(20 * 60 * 1000), 10) || 20 * 60 * 1000);

const log = (...a) => console.log('[media]', ...a);
const warn = (...a) => console.warn('[media]', ...a);

let started = false;
let ready = false; // migrations + ffmpeg probe done, loop may run
let busy = false;
let timer = null; // pending loop timeout (null when running/unscheduled)
let ffmpegOK = null; // null = unprobed
let encCache = null; // {x264, mp3, opus, webp}
let niceOK = null;
let loggedIdle = false;
// In-memory worker stats (this boot; lifetime totals live in media_compress_log).
const stats = {
  startedAt: 0, ticks: 0, processed: 0, skipped: 0, errors: 0,
  savedBytes: 0, lastTickAt: 0, lastJob: null, lastError: null,
};
const LOG_KEEP = 300; // recent job rows kept for the admin panel
// Bucket-scan state (see reconcileBucket). `pendingKeys` holds profile uploads
// that asked to be settled now — they belong to no flag table, so the queue's
// candidate query can never surface them.
let sweeping = false;
let sweepTimer = null;
const pendingKeys = [];
const sweepStats = { startedAt: 0, runs: 0, lastRunAt: 0, lastResult: null, lastError: null, checks: 0, lastCheckAt: 0, lastCheckResult: null };

// ---------- intake ----------

// Guarded migration: IF NOT EXISTS is native Postgres, safe on every boot.
async function ensureColumns() {
  await db.exec('ALTER TABLE attachments ADD COLUMN IF NOT EXISTS compressed BIGINT NOT NULL DEFAULT 0');
  await db.exec('ALTER TABLE dm_attachments ADD COLUMN IF NOT EXISTS compressed BIGINT NOT NULL DEFAULT 0');
  // Stories are media too: they carry their own flag (the queue is flag-driven)
  // and their own size, because a story row is the only place that records how
  // big its upload was.
  await db.exec('ALTER TABLE stories ADD COLUMN IF NOT EXISTS compressed BIGINT NOT NULL DEFAULT 0');
  await db.exec('ALTER TABLE stories ADD COLUMN IF NOT EXISTS size BIGINT NOT NULL DEFAULT 0');
  await db.exec(`CREATE TABLE IF NOT EXISTS media_compress_log (
  id TEXT PRIMARY KEY,
  tbl TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  filename TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  pipeline TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',
  orig_size BIGINT NOT NULL DEFAULT 0,
  new_size BIGINT NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
)`);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_media_compress_log_created ON media_compress_log(created_at DESC)');
  // One row per storage key the compressor has ever reached a verdict on.
  // `media_compress_log` cannot serve this purpose: it is a rolling 300-row
  // panel feed, so "have I already handled these bytes?" would be answered
  // "no" for everything older — and re-encoding an already-compressed photo
  // costs quality, not just CPU. The ledger is what lets the bucket scan skip
  // what is done without asking the (flag-less) tables it came from.
  await db.exec(`CREATE TABLE IF NOT EXISTS media_compress_keys (
  key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT '',
  orig_size BIGINT NOT NULL DEFAULT 0,
  new_size BIGINT NOT NULL DEFAULT 0,
  at BIGINT NOT NULL
)`);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_media_compress_keys_at ON media_compress_keys(at DESC)');
  // Seed from the flags that predate the ledger, so the first bucket scan does
  // not re-encode files this pipeline already handled. Rows left at
  // compressed = 1 without real savings (too small, no win) are deliberately
  // seeded too: those exact bytes were examined and declined.
  try {
    await db.exec(`INSERT INTO media_compress_keys (key,status,mode,orig_size,new_size,at)
      SELECT regexp_replace(split_part(url,'?',1), '^/uploads/', ''), 'compressed', 'legacy', size, size, ${now()}
        FROM attachments WHERE compressed = 1 AND url LIKE '/uploads/files/%'
      ON CONFLICT (key) DO NOTHING`);
    await db.exec(`INSERT INTO media_compress_keys (key,status,mode,orig_size,new_size,at)
      SELECT regexp_replace(split_part(url,'?',1), '^/uploads/', ''), 'compressed', 'legacy', size, size, ${now()}
        FROM dm_attachments WHERE compressed = 1 AND url LIKE '/uploads/files/%'
      ON CONFLICT (key) DO NOTHING`);
  } catch (e) { warn('ledger seed skipped:', String((e && e.message) || e).slice(0, 120)); }
}

// ---------- the key ledger ----------

// Record a verdict for a storage key. Only terminal ones are worth recording:
// committed, or examined-and-declined (too small, no pipeline, no saving). A
// transient failure is deliberately NOT recorded, so a later pass — the queue
// or the bucket scan — can still pick the object up.
async function recordKey(key, status, mode, origSize, newSize) {
  if (!key) return;
  try {
    await db.prepare(`INSERT INTO media_compress_keys (key,status,mode,orig_size,new_size,at) VALUES (?,?,?,?,?,?)
      ON CONFLICT (key) DO UPDATE SET status = excluded.status, mode = excluded.mode,
        orig_size = excluded.orig_size, new_size = excluded.new_size, at = excluded.at`)
      .run(key, String(status || '').slice(0, 24), String(mode || '').slice(0, 40),
        Math.max(0, Math.floor(Number(origSize) || 0)), Math.max(0, Math.floor(Number(newSize) || 0)), now());
  } catch (e) { warn('ledger write failed for ' + key + ': ' + String((e && e.message) || e).slice(0, 100)); }
}

// Every key the ledger knows about, as a Set — one query, then a lookup per
// object while walking a bucket listing.
async function recordedKeys() {
  const out = new Set();
  try {
    for (const r of await db.prepare('SELECT key FROM media_compress_keys').all()) out.add(r.key);
  } catch {}
  return out;
}

async function ledgerStats() {
  const out = { keys: 0, compressed: 0, bytes: 0 };
  try {
    const r = await db.prepare("SELECT COUNT(*) n, COALESCE(SUM(GREATEST(orig_size - new_size, 0)),0) saved FROM media_compress_keys").get();
    out.keys = Number(r && r.n) || 0;
    out.bytes = Number(r && r.saved) || 0;
    const c = await db.prepare("SELECT COUNT(*) n FROM media_compress_keys WHERE status = 'compressed'").get();
    out.compressed = Number(c && c.n) || 0;
  } catch {}
  return out;
}

// One row per finished file (compressed or failed). Skips are too noisy to
// log — they are visible as aggregate counters instead.
async function logJob({ tbl, url, filename, kind, pipeline, result, origSize, newSize, error }) {
  try {
    await db.prepare('INSERT INTO media_compress_log (id,tbl,url,filename,kind,pipeline,result,orig_size,new_size,error,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(uid(), tbl || '', String(url || '').slice(0, 300), String(filename || 'file').slice(0, 120),
        kind || '', pipeline || '', result || '', Math.max(0, Math.floor(Number(origSize) || 0)), Math.max(0, Math.floor(Number(newSize) || 0)),
        String(error || '').slice(0, 200), now());
    await db.prepare(`DELETE FROM media_compress_log WHERE id NOT IN
      (SELECT id FROM media_compress_log ORDER BY created_at DESC LIMIT ?)`).run(LOG_KEEP);
  } catch {}
}

function checkFfmpeg() {
  if (ffmpegOK !== null) return ffmpegOK;
  try {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 10000 });
    ffmpegOK = !!(r && r.status === 0);
  } catch { ffmpegOK = false; }
  return ffmpegOK;
}

function probeEncoders() {
  if (encCache) return encCache;
  let out = '';
  try {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 15000 });
    out = String((r && r.stdout) || '');
  } catch { out = ''; }
  encCache = {
    x264: out.includes('libx264'),
    mp3: out.includes('libmp3lame'),
    opus: out.includes('libopus'),
    webp: out.includes('libwebp'),
  };
  return encCache;
}

function checkNice() {
  if (niceOK !== null) return niceOK;
  if (process.platform === 'win32') { niceOK = false; return false; }
  try {
    const r = spawnSync('nice', ['-n', '19', 'true'], { stdio: 'ignore', timeout: 5000 });
    niceOK = !!(r && r.status === 0);
  } catch { niceOK = false; }
  return niceOK;
}

// '/uploads/files/abc.mp4?v=k9' -> 'files/abc.mp4' (null unless a chat upload)
function cleanKey(url) {
  if (!url || typeof url !== 'string') return null;
  const clean = url.split('?')[0];
  if (!clean.startsWith('/uploads/files/')) return null;
  const key = clean.slice('/uploads/'.length);
  if (!key || key.includes('..') || /[\0]/.test(key)) return null;
  if (!/^[A-Za-z0-9._\/-]+$/.test(key)) return null;
  return key;
}

function extOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

// Decide the pipeline for a row. Returns null when the type is out of scope
// (non-media, exotic image formats, ...) — caller marks those done.
function planFor(mime, filename) {
  const mt = String(mime || '');
  const ext = extOf(filename);
  const enc = probeEncoders();
  // GIFs (animated or still — the palette pipeline handles both).
  if (mt === 'image/gif' || ext === '.gif') return { pipeline: 'gif', outExt: '.gif', group: 'gif' };
  // Stills. SVG/AVIF/BMP/ICO are left alone (vector, slow to encode, or rare).
  if (mt === 'image/jpeg' || ext === '.jpg' || ext === '.jpeg') return { pipeline: 'jpeg', outExt: '.jpg', group: 'image' };
  if (mt === 'image/png' || ext === '.png') return { pipeline: 'png', outExt: '.png', group: 'image' };
  if ((mt === 'image/webp' || ext === '.webp') && enc.webp) return { pipeline: 'webp', outExt: '.webp', group: 'image' };
  if (mt.startsWith('image/')) return null;
  // Video -> H264 MP4 (transparent at CRF 24 for chat-sized embeds).
  if (mt.startsWith('video/')) {
    if (!enc.x264) return null;
    return { pipeline: 'mp4', outExt: '.mp4', group: 'video' };
  }
  // Audio.
  if (mt === 'audio/mpeg' || ext === '.mp3') {
    if (!enc.mp3) return null;
    return { pipeline: 'mp3', outExt: '.mp3', group: 'audio' };
  }
  if (mt === 'audio/mp4' || mt === 'audio/aac' || mt === 'audio/x-m4a' || ext === '.m4a') {
    return { pipeline: 'm4a', outExt: '.m4a', group: 'audio' };
  }
  if (mt === 'audio/ogg' || mt === 'audio/opus' || ext === '.ogg' || ext === '.oga' || ext === '.opus') {
    if (!enc.opus) return null;
    return { pipeline: 'ogg', outExt: extOf(filename) === '.oga' ? '.oga' : '.ogg', group: 'audio' };
  }
  if (mt === 'audio/webm' || (ext === '.webm' && mt.startsWith('audio/'))) {
    if (!enc.opus) return null;
    return { pipeline: 'webaudio', outExt: '.webm', group: 'audio' };
  }
  // Lossless monsters -> universal MP3 (renames the stored file, DB follows).
  if (mt === 'audio/wav' || mt === 'audio/x-wav' || mt === 'audio/flac' || mt === 'audio/x-flac' || ext === '.wav' || ext === '.flac') {
    if (!enc.mp3) return null;
    return { pipeline: 'wav2mp3', outExt: '.mp3', group: 'audio' };
  }
  if (mt.startsWith('audio/')) return null;
  return null;
}

function compressionEnabled() { return ENABLED; }

// Would this upload be re-encoded? The upload route asks (see /api/upload): with
// no scanner the gate holds a file back until the compressor has settled it, and
// a file the compressor will never touch must not pay that wait — it is served
// the moment it lands, exactly as it is with compression off.
function isCandidate(mime, key, size) {
  if (!ENABLED || !key) return false;
  const plan = planFor(mime, key);
  if (!plan) return false;
  return (Number(size) || 0) >= (MIN_BYTES[plan.group] || MIN_BYTES.image);
}

const SCALE_IMG = 'scale=2048:2048:force_original_aspect_ratio=decrease';
const SCALE_GIF = 'fps=20,scale=1280:1280:force_original_aspect_ratio=decrease:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5';
const SCALE_VID = 'scale=1920:1080:force_original_aspect_ratio=decrease';

// Quality rationale (chat embeds, not archival):
// - jpeg q:v 3 (~quality 85): artifacts invisible at embed sizes.
// - png: lossless (level 9 + metadata strip + downscale only).
// - webp quality 82: Google's transparent-for-photos band.
// - gif: 20fps cap (most chat GIFs ship <=20fps already), 1280px cap,
//   full 256-color palette with bayer dither.
// - video: x264 veryfast CRF 24 — the standard "looks like the source"
//   setting; 1080p cap; AAC 128k stereo.
// - audio: MP3 160k / AAC 128k / Opus 128k — transparent on phone/laptop
//   speakers; lossless WAV/FLAC become 192k MP3 (still ~10x smaller).
function buildArgs(pipelineName, inPath, outPath) {
  const head = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inPath, '-threads', '1', '-map_metadata', '-1'];
  switch (pipelineName) {
    case 'jpeg':
      return [...head, '-vf', SCALE_IMG, '-q:v', '3', outPath];
    case 'png':
      // Lossless: downscale + metadata strip only (the png encoder has no
      // quality knob on all builds, so no extra flags — keeps it portable).
      return [...head, '-vf', SCALE_IMG, outPath];
    case 'webp':
      return [...head, '-vf', SCALE_IMG, '-c:v', 'libwebp', '-quality', '82', outPath];
    case 'gif':
      return [...head, '-filter_complex', SCALE_GIF, outPath];
    case 'mp4':
      return [...head, '-map', '0:v:0', '-map', '0:a?', '-vf', SCALE_VID,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', outPath];
    case 'mp3':
      return [...head, '-map', '0:a', '-c:a', 'libmp3lame', '-b:a', '160k', outPath];
    case 'm4a':
      return [...head, '-map', '0:a', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', outPath];
    case 'ogg':
      return [...head, '-map', '0:a', '-c:a', 'libopus', '-b:a', '128k', outPath];
    case 'webaudio':
      return [...head, '-map', '0:a', '-c:a', 'libopus', '-b:a', '128k', outPath];
    case 'wav2mp3':
      return [...head, '-map', '0:a', '-c:a', 'libmp3lame', '-b:a', '192k', outPath];
    default:
      throw new Error('unknown_pipeline:' + pipelineName);
  }
}

function runFfmpeg(args) {
  return new Promise((resolve) => {
    const useNice = checkNice();
    const cmd = useNice ? 'nice' : 'ffmpeg';
    const cmdArgs = useNice ? ['-n', '19', 'ffmpeg', ...args] : args;
    let child;
    try {
      child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'ignore', 'pipe'], timeout: JOB_TIMEOUT_MS });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
      return;
    }
    let stderr = '';
    try {
      child.stderr.on('data', (d) => {
        stderr += String(d);
        if (stderr.length > 4096) stderr = stderr.slice(-4096);
      });
    } catch {}
    const done = (ok, error) => resolve({ ok, error: error || stderr.trim().slice(-500) });
    child.on('error', (e) => done(false, String((e && e.message) || e)));
    child.on('close', (code) => done(code === 0, code === 0 ? '' : `ffmpeg_exit_${code}: ${stderr.trim().slice(-300)}`));
  });
}

// ---------- file access (local disk or S3, same URL shape) ----------

async function downloadToTemp(key, tmpPath) {
  if (!storage.s3Enabled()) {
    await fs.promises.copyFile(path.join(UPLOAD_DIR, key), tmpPath);
    return;
  }
  const data = await storage.s3Get(key);
  if (!data || !data.Body) throw new Error('storage_read_failed');
  await pipeline(data.Body, fs.createWriteStream(tmpPath));
}

async function replaceBytes(key, srcPath, mime) {
  if (!storage.s3Enabled()) {
    const dest = path.join(UPLOAD_DIR, key);
    if (!path.resolve(dest).startsWith(path.resolve(UPLOAD_DIR) + path.sep)) throw new Error('bad_key');
    // Swap ATOMICALLY (write beside, then rename). copyFile() would expose a
    // torn file to anything reading this path concurrently — and two things
    // do: clamd and HTTP serving. A half-written file read by the scanner is a
    // false verdict, which is exactly the failure mode we cannot afford.
    // rename() is atomic, so readers see either the whole old file or the
    // whole new one.
    const tmp = dest + '.tmp-' + crypto.randomBytes(6).toString('hex');
    try {
      await fs.promises.copyFile(srcPath, tmp);
      await fs.promises.rename(tmp, dest);
    } catch (e) {
      try { await fs.promises.unlink(tmp); } catch {}
      throw e;
    }
    return;
  }
  const buf = await fs.promises.readFile(srcPath);
  await storage.s3Put(key, buf, mime || storage.mimeForFilename(key));
}

async function removeKey(key) {
  if (storage.s3Enabled()) {
    try { await storage.s3DeleteNow(key); } catch {}
  }
  const p = path.join(UPLOAD_DIR, key);
  if (path.resolve(p).startsWith(path.resolve(UPLOAD_DIR))) {
    try { await fs.promises.unlink(p); } catch {}
  }
}

async function keyExists(key) {
  if (storage.s3Enabled()) {
    try { await storage.s3Head(key); return true; }
    catch {
      // Fall through to the local check: covers files still on disk from
      // before an S3 migration.
    }
  }
  try {
    const st = await fs.promises.stat(path.join(UPLOAD_DIR, key));
    return st.isFile();
  } catch { return false; }
}

// How big is the stored object? The bucket scan reads this from the listing, but
// a key with no row behind it (profile media) has no size in the database.
async function keySize(key) {
  if (storage.s3Enabled()) {
    try {
      const head = await storage.s3Head(key);
      return Number(head && head.ContentLength) || 0;
    } catch {}
  }
  try {
    const st = await fs.promises.stat(path.join(UPLOAD_DIR, key));
    return st.isFile() ? st.size : 0;
  } catch { return 0; }
}

const cacheBust = (cleanUrl) => `${cleanUrl}?v=${Date.now().toString(36)}`;
const MIME_BY_OUT = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.webm': 'audio/webm' };

// ---------- job ----------

// One ffmpeg at a time, process-wide: this sweeper and the single-pass
// virus-scan pipeline (processUpload below) both compress, and the low-CPU
// promise is "one file at a time" no matter which path got there first.
let lockTail = Promise.resolve();
function withCompressLock(fn) {
  const run = lockTail.then(fn, fn);
  lockTail = run.then(() => {}, () => {});
  return run;
}

// Keys with a compression pass in flight (either path). Stops a scan slot and
// the sweeper from chewing through the same upload at the same time — and the
// scan watchdog (virus-scan.js) from reaping a slot parked in a long encode.
const inflight = new Set();
function isCompressing(key) { return inflight.has(key); }

const TABLE_BY_TBL = { att: 'attachments', dm: 'dm_attachments', story: 'stories' };
const tableFor = (tbl) => TABLE_BY_TBL[tbl] || 'attachments';

async function markDone(tbl, id) {
  await db.prepare(`UPDATE ${tableFor(tbl)} SET compressed = 1 WHERE id = ?`).run(id);
}

async function markRowsDone(rows) {
  for (const r of rows) await markDone(r.tbl, r.id);
}

// Every row still awaiting compression that points at this key (the same upload
// can be attached to more than one message, and story media lives in its own
// table). `opts.any` ignores the flag: the bucket scan found the bytes by
// listing the bucket, so a row that claims to be done but still points at an
// oversized object has to be repointed too.
async function pendingRowsForKey(key, opts) {
  const url = '/uploads/' + key;
  const any = !!(opts && opts.any);
  const out = [];
  for (const [tbl, table] of [['att', 'attachments'], ['dm', 'dm_attachments'], ['story', 'stories']]) {
    let rows = [];
    try {
      rows = await db.prepare(`SELECT id, url, ${table === 'stories' ? "'' AS filename" : 'filename'}, mime, size, kind, '${tbl}' AS tbl FROM ${table}
        WHERE ${any ? '' : 'compressed = 0 AND '}kind IN ('image','video','audio') AND split_part(url, '?', 1) = ?`).all(url);
    } catch { continue; }
    for (const r of rows) out.push(r);
  }
  return out;
}

// Single-pass media processing, shared by every caller:
//   - virus-scan.js (the pre-publication slot): hand each candidate output to
//     `inspect({path,size})` and only commit when the scanner approves it, so
//     the verdict that reaches clients describes the bytes they will actually
//     play. Nothing can be serving this file yet, so it is committed in place
//     (same key) whenever the format does not change.
//   - this sweeper's queue, and the bucket scan: `opts.visible` — the bytes are
//     already being served. An image is still committed in place (see below);
//     video/audio moves to a NEW key, so a player reading ranges out of it can
//     never see the bytes change underneath it.
//   - `opts.any` ignores the `compressed` flag when looking up the rows that
//     point at this key (the bucket scan found the object by listing the bucket,
//     so a row that claims to be done but still points at oversized bytes has to
//     be repointed too).
// Returns null when there is nothing to do (rows are marked done), else
// { key, url, size, origSize, mime, group, pipeline, renamed }.
async function processUpload(key, inspect, opts) {
  if (!ENABLED || !key || inflight.has(key)) return null;
  inflight.add(key);
  try {
    // Two guards, and both are needed:
    //   withCompressLock  — one ffmpeg per POD, the low-CPU promise.
    //   withKeyLock       — one ffmpeg per FILE across all pods. Without it a
    //     scan slot on one replica and the sweeper on another could compress the
    //     same upload simultaneously: double the CPU, two different candidate
    //     byte streams, and a race to publish them (which is exactly the
    //     "one pending->final transition per file" rule this pipeline keeps).
    const r = await db.withKeyLock('media:' + key, () => withCompressLock(() => compressLocked(key, inspect, opts)));
    return r.ran ? r.value : null;
  } finally { inflight.delete(key); }
}

async function compressLocked(key, inspect, opts) {
  const visible = !!(opts && opts.visible);
  const mode = visible ? 'sweep' : 'slot';
  const rows = await pendingRowsForKey(key, opts);
  if (!rows.length) return null; // no chat/story row points here (profile media, an abandoned upload, …)
  // Verdicts are recorded for keys we actually examined: the bucket scan uses
  // the ledger to skip them, and a missing row here (the file was uploaded but
  // nothing references it yet) is deliberately left unrecorded so a later pass
  // can still adopt the object.
  const done = async (why, origSize) => {
    await recordKey(key, 'kept', why || '', Number(origSize) || 0, 0);
    await markRowsDone(rows);
    return null;
  };
  const row = rows[0];
  const plan = planFor(row.mime, key);
  if (!plan) return done('no_pipeline');
  const minSize = MIN_BYTES[plan.group] || MIN_BYTES.image;
  let dbSize = 0;
  for (const r of rows) dbSize = Math.max(dbSize, Number(r.size) || 0);
  if (dbSize < minSize) return done('below_floor', dbSize);
  if (!(await keyExists(key))) return done('gone', dbSize);

  const rand = crypto.randomBytes(8).toString('hex');
  const tmpIn = path.join(os.tmpdir(), `cfc-in-${rand}${extOf(key) || '.bin'}`);
  const outExt = plan.outExt;
  const tmpOut = path.join(os.tmpdir(), `cfc-out-${rand}${outExt}`);
  let inScan = !!inspect;
  try {
    await downloadToTemp(key, tmpIn);
    const inStat = await fs.promises.stat(tmpIn).catch(() => null);
    if (!inStat || !inStat.size) return done('empty_input', dbSize);

    const r = await runFfmpeg(buildArgs(plan.pipeline, tmpIn, tmpOut));
    if (!r.ok) {
      const err = String(r.error || 'encode_failed').slice(0, 160);
      stats.errors++;
      stats.lastError = { key, error: err, at: now() };
      warn('encode failed, keeping original:', key, err);
      await logJob({ tbl: row.tbl, url: row.url, filename: row.filename, kind: plan.group, pipeline: plan.pipeline, result: 'error', origSize: inStat.size, newSize: 0, error: err });
      return done('encode_failed', inStat.size);
    }
    const outStat = await fs.promises.stat(tmpOut).catch(() => null);
    if (!outStat || !outStat.size) return done('no_output', inStat.size);
    if (outStat.size >= inStat.size * (1 - MIN_SAVING)) return done('no_saving', inStat.size);

    // Nothing is published until the caller's scanner approves the candidate.
    // A rejected one leaves the original (already verified) file alone and
    // marks the row done so the sweep doesn't re-encode it forever.
    if (inspect) {
      const publish = await inspect({ path: tmpOut, size: outStat.size });
      inScan = false;
      if (!publish) {
        await logJob({ tbl: row.tbl, url: row.url, filename: row.filename, kind: plan.group, pipeline: plan.pipeline, result: 'error', origSize: inStat.size, newSize: 0, error: 'candidate_output_flagged' });
        return done('candidate_flagged', inStat.size);
      }
    }

    const sameFormat = extOf(key) === outExt;
    const newMime = sameFormat ? String(row.mime) : (MIME_BY_OUT[outExt] || String(row.mime));
    // A file that is already being served moves to a NEW key: rewriting bytes
    // behind a live URL is what swaps a file out from under a reader (a player
    // reading ranges is only the worst case). The row — and, for stories, the
    // story row — gets the new URL plus a fresh cache-buster, and the old object
    // stays until the orphan sweep's grace period is up. Only the slot, which
    // compresses before anything can fetch the bytes, keeps the key.
    const freshKey = !sameFormat || visible;
    let newKey = key;
    if (freshKey) {
      // Format change (wav->mp3, mov/webm video->mp4), or a post-publication
      // rewrite of bytes something could be streaming: mint a fresh name.
      const dir = key.slice(0, key.lastIndexOf('/') + 1);
      newKey = dir + crypto.randomBytes(16).toString('hex') + outExt;
    }
    await replaceBytes(newKey, tmpOut, newMime);
    const newUrl = cacheBust('/uploads/' + newKey);
    for (const rr of rows) {
      const table = tableFor(rr.tbl);
      try {
        if (sameFormat) await db.prepare('UPDATE ' + table + ' SET size = ?, url = ?, compressed = 1 WHERE id = ?').run(outStat.size, newUrl, rr.id);
        else await db.prepare('UPDATE ' + table + ' SET size = ?, url = ?, mime = ?, compressed = 1 WHERE id = ?').run(outStat.size, newUrl, newMime, rr.id);
      } catch (e) { warn('row update failed:', String((e && e.message) || e).slice(0, 120)); }
    }
    if (newKey !== key && !visible) {
      // Only the not-yet-visible copy is dropped. A published one is left in
      // place: something may still be streaming it, and the orphan sweep knows
      // how to reap it once nothing references it any more.
      await removeKey(key);
      try { require('./virus-scan').dropScan(key); } catch {}
    }
    // Terminal verdicts, both keys: the old one is settled (its bytes are gone
    // or superseded) and the new one must never be re-encoded by the bucket scan.
    await recordKey(key, 'compressed', `${mode}:${plan.pipeline}`, inStat.size, outStat.size);
    if (newKey !== key) await recordKey(newKey, 'compressed', `${mode}:${plan.pipeline}`, outStat.size, outStat.size);
    stats.processed++;
    stats.savedBytes += inStat.size - outStat.size;
    stats.lastJob = { key, group: plan.group, pipeline: plan.pipeline, origSize: inStat.size, newSize: outStat.size, at: now() };
    await logJob({ tbl: row.tbl, url: newUrl, filename: row.filename, kind: plan.group, pipeline: plan.pipeline, result: 'compressed', origSize: inStat.size, newSize: outStat.size });
    const pct = Math.round((1 - outStat.size / inStat.size) * 100);
    log(`${plan.group} ${key}: ${Math.round(inStat.size / 1024)}KB -> ${Math.round(outStat.size / 1024)}KB (-${pct}%)`);
    return { key: newKey, url: newUrl, size: outStat.size, origSize: inStat.size, mime: newMime, group: plan.group, pipeline: plan.pipeline, renamed: newKey !== key };
  } catch (e) {
    // A scanner failure on the candidate is NOT a reason to give up on the
    // file: keep the original bytes in place, stay queued (compressed = 0) so
    // the sweeper can retry, and let the caller publish the original verdict.
    if (inScan) {
      stats.errors++;
      stats.lastError = { key, error: String((e && e.message) || e).slice(0, 160), at: now() };
      warn('candidate scan failed, keeping original:', key, String((e && e.message) || e).slice(0, 160));
      throw e;
    }
    const err = String((e && e.message) || e).slice(0, 160);
    stats.errors++;
    stats.lastError = { key, error: err, at: now() };
    warn('job failed, keeping original:', key, err);
    try { await logJob({ tbl: row.tbl, url: row.url, filename: row.filename, kind: (plan && plan.group) || '', pipeline: (plan && plan.pipeline) || '', result: 'error', origSize: row.size || 0, newSize: 0, error: err }); } catch {}
    try { await markRowsDone(rows); } catch {}
    return null;
  } finally {
    for (const f of [tmpIn, tmpOut]) { try { await fs.promises.unlink(f); } catch {} }
  }
}

// Sweeper path: returns 'compressed' | 'skipped' (both mean: never look at
// this row again). The scan-integrated path is the primary one; this is
// the safety net for files it missed — the backlog from before the single-pass
// change, a file that was published before its encode finished (the slot and
// the message insert can race), a story whose row landed after the slot ran.
// Everything it touches is already visible (`visible: true`), and a story row
// is queued exactly like an attachment.
async function processRow(row) {
  const key = cleanKey(row.url);
  if (!key) { stats.skipped++; await markDone(row.tbl, row.id); return 'skipped'; } // remote GIF URL etc.
  const out = await processUpload(key, null, { visible: true });
  if (!out) { stats.skipped++; return 'skipped'; }
  try {
    const vs = require('./virus-scan');
    // Where a scanner exists the rewritten bytes need a fresh verdict, and that
    // verdict is what re-broadcasts the message showing them. With scanning off
    // there is no verdict to earn (an unknown key is served) and queueing one
    // would only gate the file this sweep just published — but the clients
    // still have to learn its new URL, so the change is emitted directly.
    if (vs.scanningEnabled()) vs.queueFileScan(out.key);
    else await vs.emitScanChange(out.key, 'clean');
  } catch {}
  return 'compressed';
}

async function fetchCandidates(limit) {
  // Oldest first so the pre-existing backlog drains in upload order.
  // Candidates are rows the compressor has not already handled; the scan key a
  // virus verdict hangs off is derived from the URL, never the row id. Stories
  // are media too: they live in their own table with their own flag.
  return await db.prepare(`
    SELECT a.id, a.url, a.filename, a.mime, a.size, a.kind, a.created_at, 'att' AS tbl FROM attachments a
    WHERE a.compressed = 0 AND a.kind IN ('image','video','audio')
    UNION ALL
    SELECT d.id, d.url, d.filename, d.mime, d.size, d.kind, d.created_at, 'dm' AS tbl FROM dm_attachments d
    WHERE d.compressed = 0 AND d.kind IN ('image','video','audio')
    UNION ALL
    SELECT s.id, s.url, '' AS filename, s.mime, s.size, s.kind, s.created_at, 'story' AS tbl FROM stories s
    WHERE s.compressed = 0 AND s.kind IN ('image','video')
    ORDER BY created_at ASC LIMIT ?`).all(limit);
}

// ---------- everything else: profile media + the bucket scan ----------
//
// The queue above is flag-driven, so it only ever sees tables that carry a
// `compressed` column (chat attachments, DMs, stories). Profile media —
// avatars, banners, sidebar banners, server icons, custom emoji, webhook
// avatars, the profile-media picker's history — has no flag and is served
// ungated the moment it is uploaded, so it is handled from the other end:
// find the object, find every row that points at it, compress, republish under
// a new key, and repoint those rows. Two triggers:
//   - a profile upload kicks its own key (kickProfileMedia), so a new avatar is
//     settled within a second or two;
//   - a scheduled pass lists the bucket and adopts everything else that is
//     referenced, above the size floor, and absent from the key ledger
//     (reconcileBucket) — the backlog, and anything a future code path forgets
//     to queue.

const FLAG_TABLES = new Set(['attachments', 'dm_attachments', 'stories']);
const SWEEP_MIN_AGE_MS = Math.max(0, parseInt(process.env.MEDIA_SWEEP_MIN_AGE_MS || String(10 * 60 * 1000), 10) || 0);
const SWEEP_MAX_PAGES = Math.max(1, parseInt(process.env.MEDIA_SWEEP_MAX_PAGES || '100', 10) || 100);

// Rows in any table that point at this key, looked up directly rather than by
// walking every reference in the database (what a single upload needs).
async function refsForKey(key) {
  const like = '/uploads/' + key + '%';
  const exact = '/uploads/' + key;
  const out = [];
  const scan = async (table, cols) => {
    let rows = [];
    try {
      rows = await db.prepare(`SELECT id, ${cols.join(', ')} FROM ${table} WHERE ${cols.map((c) => c + ' LIKE ?').join(' OR ')}`)
        .all(...cols.map(() => like));
    } catch { return; }
    for (const r of rows) {
      for (const c of cols) {
        if (r[c] && String(r[c]).split('?')[0] === exact) out.push({ table, col: c, id: r.id });
      }
    }
  };
  await scan('attachments', ['url']);
  await scan('dm_attachments', ['url']);
  await scan('stories', ['url']);
  await scan('users', ['avatar_url', 'banner_url', 'sidebar_banner_url']);
  await scan('servers', ['icon_url', 'banner_url']);
  await scan('custom_emoji', ['url']);
  await scan('webhooks', ['avatar_url']);
  await scan('media_history', ['url']);
  return out;
}

// Compress an object the queue can never see. Its bytes are already being
// served, so the result is published under a NEW key and every row that can be
// rewritten is repointed; the old object stays for the orphan sweep's grace
// period, so anything still holding the old URL keeps working.
async function compressStandalone(key, refs, opts) {
  if (!ENABLED || !key || !refs || !refs.length || inflight.has(key)) return null;
  inflight.add(key);
  try {
    const r = await db.withKeyLock('media:' + key, () => withCompressLock(() => commitStandaloneLocked(key, refs, opts || {})));
    return r.ran ? r.value : null;
  } finally { inflight.delete(key); }
}

async function commitStandaloneLocked(key, refs, opts) {
  const done = async (why, origSize) => { await recordKey(key, 'kept', why || '', Number(origSize) || 0, 0); return null; };
  const plan = planFor(storage.mimeForFilename(key), key);
  if (!plan) return done('no_pipeline');
  const origSize = Number(opts.size) || (await keySize(key));
  if (!origSize) return done('gone');
  const minSize = MIN_BYTES[plan.group] || MIN_BYTES.image;
  if (origSize < minSize) return done('below_floor', origSize);

  const rand = crypto.randomBytes(8).toString('hex');
  const tmpIn = path.join(os.tmpdir(), `cfs-in-${rand}${extOf(key) || '.bin'}`);
  const tmpOut = path.join(os.tmpdir(), `cfs-out-${rand}${plan.outExt}`);
  try {
    await downloadToTemp(key, tmpIn);
    const inStat = await fs.promises.stat(tmpIn).catch(() => null);
    if (!inStat || !inStat.size) return done('empty_input', origSize);
    const r = await runFfmpeg(buildArgs(plan.pipeline, tmpIn, tmpOut));
    if (!r.ok) {
      const err = String(r.error || 'encode_failed').slice(0, 160);
      stats.errors++;
      stats.lastError = { key, error: err, at: now() };
      warn('encode failed, keeping original:', key, err);
      return null; // no ledger entry: a later pass may succeed
    }
    const outStat = await fs.promises.stat(tmpOut).catch(() => null);
    if (!outStat || !outStat.size) return done('no_output', inStat.size);
    if (outStat.size >= inStat.size * (1 - MIN_SAVING)) return done('no_saving', inStat.size);

    const dir = key.slice(0, key.lastIndexOf('/') + 1);
    const newKey = dir + crypto.randomBytes(16).toString('hex') + plan.outExt;
    const newMime = MIME_BY_OUT[plan.outExt] || storage.mimeForFilename(newKey);
    await replaceBytes(newKey, tmpOut, newMime);
    const newUrl = cacheBust('/uploads/' + newKey);
    for (const r2 of refs) {
      // table/col come from this module's own list, never from a request.
      const setFlag = FLAG_TABLES.has(r2.table) ? ', compressed = 1' : '';
      try { await db.prepare(`UPDATE ${r2.table} SET ${r2.col} = ?${setFlag} WHERE id = ?`).run(newUrl, r2.id); }
      catch (e) { warn('repoint failed (' + r2.table + '.' + r2.col + '):', String((e && e.message) || e).slice(0, 120)); }
    }
    await recordKey(key, 'compressed', 'scan:' + plan.pipeline, inStat.size, outStat.size);
    await recordKey(newKey, 'compressed', 'scan:' + plan.pipeline, outStat.size, outStat.size);
    stats.processed++;
    stats.savedBytes += inStat.size - outStat.size;
    stats.lastJob = { key, group: plan.group, pipeline: plan.pipeline, origSize: inStat.size, newSize: outStat.size, at: now() };
    await logJob({ tbl: '', url: newUrl, filename: key.split('/').pop(), kind: plan.group, pipeline: plan.pipeline, result: 'compressed', origSize: inStat.size, newSize: outStat.size });
    const pct = Math.round((1 - outStat.size / inStat.size) * 100);
    log(`${plan.group} ${key}: ${Math.round(inStat.size / 1024)}KB -> ${Math.round(outStat.size / 1024)}KB (-${pct}%)${refs.length ? ' [' + refs.length + ' ref' + (refs.length === 1 ? '' : 's') + ']' : ''}`);
    return { key: newKey, url: newUrl, size: outStat.size, origSize: inStat.size, group: plan.group, pipeline: plan.pipeline };
  } catch (e) {
    stats.errors++;
    stats.lastError = { key, error: String((e && e.message) || e).slice(0, 160), at: now() };
    warn('standalone job failed, keeping original:', key, String((e && e.message) || e).slice(0, 160));
    return null;
  } finally {
    for (const f of [tmpIn, tmpOut]) { try { await fs.promises.unlink(f); } catch {} }
  }
}

// Compress one key right now (an upload that has no flag table behind it).
async function processKeyNow(key) {
  if (!ENABLED || !key) return null;
  let refs = [];
  try { refs = await refsForKey(key); } catch { return null; }
  if (!refs.length) return null;
  return compressStandalone(key, refs, {});
}

// The scheduled reconciliation pass: list the bucket, and compress what the
// flags never saw. Anything unreferenced is left alone (the orphan sweep owns
// those bytes), anything whose only reference is a pasted link is reported
// rather than rewritten — the link must keep resolving, and rewriting what
// somebody typed is not ours to do.
async function reconcileBucket(opts) {
  if (!ENABLED || !SWEEP_ENABLED || sweeping || !ready) return null;
  const dry = !!(opts && opts.dry);
  sweeping = true;
  const t0 = now();
  const result = {
    startedAt: t0, dry, objects: 0, referenced: 0, ledger: 0, candidates: 0,
    compressed: 0, savedBytes: 0, jobs: 0, skippedOrphan: 0, skippedText: 0,
    skippedFloor: 0, skippedFresh: 0, deferred: 0, errors: 0, ms: 0,
  };
  try {
    const [stored, index, ledger] = await Promise.all([
      require('./storage-sweep').listStored({ maxPages: SWEEP_MAX_PAGES }),
      require('./storage-sweep').collectReferenceIndex(),
      recordedKeys(),
    ]);
    result.objects = stored.length;
    result.referenced = index.keys.size;
    result.ledger = ledger.size;
    const cutoff = now() - SWEEP_MIN_AGE_MS;
    const jobs = [];
    for (const o of stored) {
      if (!o.key) continue;
      if (!index.keys.has(o.key)) { result.skippedOrphan++; continue; }
      if (ledger.has(o.key)) continue;
      const plan = planFor(storage.mimeForFilename(o.key), o.key);
      if (!plan) continue;
      if ((o.size || 0) < (MIN_BYTES[plan.group] || MIN_BYTES.image)) { result.skippedFloor++; continue; }
      if (o.mtime && o.mtime > cutoff) { result.skippedFresh++; continue; } // let the upload's own path settle it first
      const refs = index.refs.get(o.key) || [];
      if (!refs.length) { result.skippedText++; continue; } // a pasted link and nothing else
      if (jobs.length >= SWEEP_MAX_JOBS) { result.deferred++; continue; }
      jobs.push({ key: o.key, size: o.size || 0, refs, where: o.where });
    }
    result.candidates = jobs.length;
    if (dry) { result.ms = now() - t0; return result; }
    for (const j of jobs) {
      if (now() - t0 > SWEEP_MAX_MS) { result.deferred++; continue; }
      try {
        // A key the flag tables point at goes through the row path: it repoints
        // them and re-broadcasts the affected messages. Everything else (profile
        // media) is committed standalone.
        const out = j.refs.some((r) => FLAG_TABLES.has(r.table))
          ? await processUpload(j.key, null, { visible: true, any: true })
          : await compressStandalone(j.key, j.refs, { size: j.size });
        if (out) {
          result.compressed++;
          result.jobs++;
          result.savedBytes += Math.max(0, (Number(out.origSize) || 0) - (Number(out.size) || 0));
        }
      } catch (e) {
        result.errors++;
        warn('scan failed for ' + j.key + ': ' + String((e && e.message) || e).slice(0, 140));
      }
    }
    result.ms = now() - t0;
    log(`bucket scan: ${result.objects} objects, ${result.candidates} candidates, ${result.compressed} compressed (${Math.round(result.savedBytes / 1024)}KB), ${result.deferred} deferred, ${result.errors} errors in ${Math.round(result.ms / 1000)}s`);
    return result;
  } catch (e) {
    result.errors++;
    result.ms = now() - t0;
    const err = String((e && e.message) || e).slice(0, 200);
    warn('bucket scan aborted: ' + err);
    sweepStats.lastError = { error: err, at: now() };
    return result;
  } finally {
    sweeping = false;
    // A dry check is bookkeeping, not a pass: it must not overwrite what the
    // last real pass did (the panel reads that number).
    if (dry) { sweepStats.checks++; sweepStats.lastCheckAt = now(); sweepStats.lastCheckResult = result; }
    else { sweepStats.runs++; sweepStats.lastRunAt = now(); sweepStats.lastResult = result; }
  }
}

function scheduleSweep(ms) {
  if (!SWEEP_ENABLED || !started) return;
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = setTimeout(async () => {
    sweepTimer = null;
    let next = SWEEP_EVERY_MS;
    try {
      // Leader-only: two replicas listing the same bucket and compressing the
      // same objects is wasted work and double the ffmpeg.
      const r = await db.withLock(db.LOCKS.mediaBucketScan, () => reconcileBucket());
      if (r && (r.deferred > 0 || r.errors > 0)) next = SWEEP_BUSY_MS;
    } catch (e) { warn('bucket scan failed: ' + String((e && e.message) || e).slice(0, 200)); }
    scheduleSweep(next);
  }, ms);
  try { sweepTimer.unref(); } catch {}
}

// Called after a profile-media upload: settle that key within the second,
// rather than waiting for the next scheduled pass.
function kickProfileMedia(key) {
  if (!started || !ENABLED || !ready || !key) return;
  if (!pendingKeys.includes(key)) pendingKeys.push(key);
  schedule(KICK_MS);
}

// Ask for a reconciliation pass soon (admin button, or a caller that knows the
// bucket changed).
function kickBucketScan() {
  if (!started || !SWEEP_ENABLED || !ready) return;
  scheduleSweep(1500);
}

async function getBucketScanStats() {
  return {
    enabled: SWEEP_ENABLED && ENABLED, everyMs: SWEEP_EVERY_MS, firstMs: SWEEP_FIRST_MS,
    minAgeMs: SWEEP_MIN_AGE_MS, jobsPerPass: SWEEP_MAX_JOBS, maxMs: SWEEP_MAX_MS,
    maxPages: SWEEP_MAX_PAGES, pendingKeys: pendingKeys.length, running: sweeping,
    ledger: await ledgerStats(),
    ...sweepStats,
  };
}

// 'more' = queue still has pending files (keep running hot),
// 'idle' = queue drained (fall back to the slow idle poll),
// 'busy' = a tick is already running, 'deferred' = box hot / not ready yet.
async function tick() {
  if (!ENABLED || !ready) return 'deferred';
  if (busy) return 'busy';
  if (!checkFfmpeg()) {
    if (!loggedIdle) { loggedIdle = true; warn('ffmpeg not found on PATH — media compression idle (uploads work, just uncompressed)'); }
    return 'idle';
  }
  // Don't pile onto an already-hot box: defer this tick.
  try {
    const cpus = (os.cpus() || []).length || 1;
    if (os.loadavg()[0] > cpus) return 'deferred';
  } catch {}
  busy = true;
  stats.ticks++;
  stats.lastTickAt = now();
  try {
    // Profile uploads asked to be settled now (kickProfileMedia): no flag table
    // points at those bytes, so the candidate query can never surface them.
    // A couple per tick, before the queue — an avatar is small and the user is
    // looking at it.
    let kicked = 0;
    while (pendingKeys.length && kicked < 3) {
      const key = pendingKeys.shift();
      kicked++;
      try { await processKeyNow(key); }
      catch (e) { warn('profile key failed (' + key + '): ' + String((e && e.message) || e).slice(0, 140)); }
    }
    // Skips (tiny/foreign/missing files) are cheap: burn through a few per
    // tick looking for real work, but cap compressions at BATCH.
    const rows = await fetchCandidates(BATCH + 25);
    if (!rows.length) return pendingKeys.length ? 'more' : 'idle';
    // Virus-scan gate: only compress scan-clean files. Anything else stays
    // queued (compressed = 0); the scan worker's clean verdict kicks us
    // back, and rewritten bytes get rescanned anyway (see processRow).
    // Lookup failures fail open — a rescan after rewrite keeps it correct.
    let scanMap = null;
    try {
      scanMap = await require('./virus-scan').scanStatusMap(rows.map((r) => cleanKey(r.url)).filter(Boolean));
    } catch { scanMap = null; }
    let done = 0;
    for (const row of rows) {
      if (done >= BATCH) break;
      const k = cleanKey(row.url);
      if (k && isCompressing(k)) continue; // the scan pipeline is already on it
      if (scanMap && k && (scanMap.get(k) || 'clean') !== 'clean') continue;
      let r;
      try { r = await processRow(row); }
      catch (e) { warn('row failed:', String((e && e.message) || e).slice(0, 160)); continue; }
      if (r === 'compressed') done++;
    }
    // Anything left? A cheap 1-row probe decides hot-loop vs idle poll.
    try {
      const rest = await fetchCandidates(1);
      return (rest.length || pendingKeys.length) ? 'more' : 'idle';
    } catch { return 'more'; }
  } catch (e) {
    warn('tick failed:', String((e && e.message) || e).slice(0, 200));
    return 'idle';
  } finally {
    busy = false;
  }
}

// Self-scheduling loop: hot while the queue has work, slow poll when idle.
function schedule(ms) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(loop, ms);
  try { timer.unref(); } catch {}
}

async function loop() {
  timer = null;
  let st = 'idle';
  try { st = await tick(); }
  catch (e) { warn('tick failed:', String((e && e.message) || e).slice(0, 200)); st = 'idle'; }
  schedule(st === 'more' ? ACTIVE_MS : (st === 'busy' || st === 'deferred') ? DEFER_MS : EVERY_MS);
}

// Wake the worker soon (called on the message-send path after attachment
// rows are inserted). Cheap + debounced by nature: it just pulls the next
// tick forward, and no-ops while a tick is already running.
function kickMediaCompress() {
  if (!started || !ENABLED || !ready || busy) return;
  schedule(KICK_MS);
}

// ---------- admin introspection ----------
// Snapshot of worker config + this boot's counters (lifetime totals come
// from media_compress_log via mediaTotals below).
function getMediaStats() {
  let load = null, cpus = 1;
  try { cpus = (os.cpus() || []).length || 1; load = os.loadavg()[0]; } catch {}
  return {
    enabled: ENABLED, everyMs: EVERY_MS, activeMs: ACTIVE_MS, batch: BATCH,
    ffmpeg: checkFfmpeg(), encoders: { ...probeEncoders() },
    busy, s3: storage.s3Enabled(), cpus, load,
    startedAt: stats.startedAt, ticks: stats.ticks,
    processed: stats.processed, skipped: stats.skipped, errors: stats.errors,
    savedBytes: stats.savedBytes, lastTickAt: stats.lastTickAt,
    lastJob: stats.lastJob, lastError: stats.lastError,
  };
}

// Pending vs finished files (attachment tables + stories), with byte totals.
// COUNT/SUM come back as numeric strings from Postgres — coerce them.
async function mediaQueueCounts() {
  const out = { pending: {}, done: {} };
  for (const table of ['attachments', 'dm_attachments', 'stories']) {
    let rows = [];
    try {
      rows = await db.prepare(`SELECT kind, compressed, COUNT(*) c, COALESCE(SUM(size),0) bytes FROM ${table} WHERE kind IN ('image','video','audio') GROUP BY kind, compressed`).all();
    } catch { continue; }
    for (const r of rows) {
      const bucket = r.compressed ? out.done : out.pending;
      const k = bucket[r.kind] || (bucket[r.kind] = { n: 0, bytes: 0 });
      k.n += Number(r.c) || 0;
      k.bytes += Number(r.bytes) || 0;
    }
  }
  return out;
}

// Lifetime totals from the job log (survives restarts).
async function mediaTotals() {
  const out = { compressed: 0, errors: 0, savedBytes: 0 };
  let rows = [];
  try {
    rows = await db.prepare('SELECT result, COUNT(*) c, COALESCE(SUM(orig_size),0) orig, COALESCE(SUM(new_size),0) cur FROM media_compress_log GROUP BY result').all();
  } catch { return out; }
  for (const r of rows) {
    if (r.result === 'compressed') {
      out.compressed = Number(r.c) || 0;
      out.savedBytes = Math.max(0, (Number(r.orig) || 0) - (Number(r.cur) || 0));
    } else if (r.result === 'error') {
      out.errors = Number(r.c) || 0;
    }
  }
  return out;
}

async function mediaRecentJobs(limit) {
  const n = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  try {
    return await db.prepare('SELECT tbl,url,filename,kind,pipeline,result,orig_size,new_size,error,created_at FROM media_compress_log ORDER BY created_at DESC LIMIT ?').all(n);
  } catch { return []; }
}

function startMediaCompress() {
  if (started) return;
  started = true;
  if (!ENABLED) { log('disabled (MEDIA_COMPRESS=0)'); return; }
  ensureColumns().then(() => {
    if (!checkFfmpeg()) {
      warn('ffmpeg not found on PATH — media compression idle (uploads work, just uncompressed)');
      loggedIdle = true;
      return;
    }
    const enc = probeEncoders();
    const missing = Object.entries(enc).filter(([, v]) => !v).map(([k]) => k);
    stats.startedAt = now();
    sweepStats.startedAt = now();
    ready = true;
    log(`worker on: continuous while queued (every ~${Math.round(ACTIVE_MS / 100) / 10}s), idle poll every ${Math.round(EVERY_MS / 1000)}s, ${BATCH}/tick, 1 thread${checkNice() ? ', nice 19' : ''}` +
      (missing.length ? ` (encoders missing, related types skipped: ${missing.join(', ')})` : ' (all encoders present)'));
    if (SWEEP_ENABLED) {
      const every = SWEEP_EVERY_MS < 3600000 ? `${Math.round(SWEEP_EVERY_MS / 60000)}min` : `${Math.round(SWEEP_EVERY_MS / 3600000)}h`;
      log(`bucket scan on: every ${every} (first in ${Math.round(SWEEP_FIRST_MS / 60000)}min), up to ${SWEEP_MAX_JOBS} files/pass, skips anything under ${Math.round(SWEEP_MIN_AGE_MS / 60000)}min old`);
      scheduleSweep(SWEEP_FIRST_MS);
    } else {
      log('bucket scan off (MEDIA_BUCKET_SWEEP=0)');
    }
    if (!timer) schedule(10000); // first pass after boot settles; kicks pull it forward
  }).catch((e) => warn('migration failed:', String((e && e.message) || e).slice(0, 200)));
}

module.exports = {
  startMediaCompress, tickMediaCompress: tick, kickMediaCompress, ensureColumns, planFor, buildArgs, cleanKey,
  MIN_BYTES, getMediaStats, mediaQueueCounts, mediaTotals, mediaRecentJobs, processUpload, isCompressing,
  isCandidate, compressionEnabled,
  // profile media + the scheduled bucket reconciliation
  kickProfileMedia, kickBucketScan, reconcileBucket, getBucketScanStats, refsForKey, compressStandalone, keySize,
};
