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
// - Low CPU by construction: ONE file at a time (busy guard), `nice -n 19`
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
// - Same URL shape always (/uploads/<sub>/<file>?v=<cachekey>). Same-format
//   results overwrite in place with a fresh ?v cache-buster; format changes
//   (wav/flac -> mp3, mov/webm video -> mp4) mint a new random filename and
//   the DB row (url/mime/size) is updated to match. Display filenames are
//   never touched.
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

// ---------- intake ----------

// Guarded migration: IF NOT EXISTS is native Postgres, safe on every boot.
async function ensureColumns() {
  await db.exec('ALTER TABLE attachments ADD COLUMN IF NOT EXISTS compressed BIGINT NOT NULL DEFAULT 0');
  await db.exec('ALTER TABLE dm_attachments ADD COLUMN IF NOT EXISTS compressed BIGINT NOT NULL DEFAULT 0');
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

const cacheBust = (cleanUrl) => `${cleanUrl}?v=${Date.now().toString(36)}`;
const MIME_BY_OUT = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.webm': 'audio/webm' };

// ---------- job ----------

async function markDone(table, id) {
  await db.prepare(`UPDATE ${table} SET compressed = 1 WHERE id = ?`).run(id);
}

// Returns 'compressed' | 'skipped' (both mean: never look at this row again).
async function processRow(row) {
  const table = row.tbl === 'dm' ? 'dm_attachments' : 'attachments';
  const done = async () => { stats.skipped++; await markDone(table, row.id); return 'skipped'; };
  const key = cleanKey(row.url);
  if (!key) return done(); // remote GIF URL etc.
  const plan = planFor(row.mime, key);
  if (!plan) return done();
  const minSize = MIN_BYTES[plan.group] || MIN_BYTES.image;
  if ((row.size || 0) < minSize) return done();
  if (!(await keyExists(key))) return done();

  const rand = crypto.randomBytes(8).toString('hex');
  const tmpIn = path.join(os.tmpdir(), `cfc-in-${rand}${extOf(key) || '.bin'}`);
  const outExt = plan.outExt;
  const tmpOut = path.join(os.tmpdir(), `cfc-out-${rand}${outExt}`);
  try {
    await downloadToTemp(key, tmpIn);
    const inStat = await fs.promises.stat(tmpIn).catch(() => null);
    if (!inStat || !inStat.size) return done();

    const r = await runFfmpeg(buildArgs(plan.pipeline, tmpIn, tmpOut));
    if (!r.ok) {
      const err = String(r.error || 'encode_failed').slice(0, 160);
      stats.errors++;
      stats.lastError = { key, error: err, at: now() };
      warn('encode failed, keeping original:', key, err);
      await logJob({ tbl: row.tbl, url: row.url, filename: row.filename, kind: plan.group, pipeline: plan.pipeline, result: 'error', origSize: inStat.size, newSize: 0, error: err });
      await markDone(table, row.id);
      return 'skipped';
    }
    const outStat = await fs.promises.stat(tmpOut).catch(() => null);
    if (!outStat || !outStat.size) return done();
    if (outStat.size >= inStat.size * (1 - MIN_SAVING)) return done();

    const sameFormat = extOf(key) === outExt;
    const newMime = sameFormat ? String(row.mime) : (MIME_BY_OUT[outExt] || String(row.mime));
    let newUrl;
    let resultKey = key;
    if (sameFormat) {
      await replaceBytes(key, tmpOut, newMime);
      newUrl = cacheBust('/uploads/' + key);
      await db.prepare('UPDATE ' + table + ' SET size = ?, url = ?, compressed = 1 WHERE id = ?')
        .run(outStat.size, newUrl, row.id);
    } else {
      // Format change (wav->mp3, mov/webm video->mp4): mint a fresh name.
      const dir = key.slice(0, key.lastIndexOf('/') + 1);
      const newKey = dir + crypto.randomBytes(16).toString('hex') + outExt;
      await replaceBytes(newKey, tmpOut, newMime);
      newUrl = cacheBust('/uploads/' + newKey);
      await db.prepare('UPDATE ' + table + ' SET size = ?, url = ?, mime = ?, compressed = 1 WHERE id = ?')
        .run(outStat.size, newUrl, newMime, row.id);
      await removeKey(key);
      try { require('./virus-scan').dropScan(key); } catch {}
      resultKey = newKey;
    }
    // Rewritten bytes need a fresh virus verdict: the scan gate holds the file
    // as pending until the rescan lands.
    try { require('./virus-scan').queueFileScan(resultKey); } catch {}
    stats.processed++;
    stats.savedBytes += inStat.size - outStat.size;
    stats.lastJob = { key, group: plan.group, pipeline: plan.pipeline, origSize: inStat.size, newSize: outStat.size, at: now() };
    await logJob({ tbl: row.tbl, url: newUrl, filename: row.filename, kind: plan.group, pipeline: plan.pipeline, result: 'compressed', origSize: inStat.size, newSize: outStat.size });
    const pct = Math.round((1 - outStat.size / inStat.size) * 100);
    log(`${plan.group} ${key}: ${Math.round(inStat.size / 1024)}KB -> ${Math.round(outStat.size / 1024)}KB (-${pct}%)`);
    return 'compressed';
  } catch (e) {
    const err = String((e && e.message) || e).slice(0, 160);
    stats.errors++;
    stats.lastError = { key, error: err, at: now() };
    warn('job failed, keeping original:', key, err);
    try { await logJob({ tbl: row.tbl, url: row.url, filename: row.filename, kind: (plan && plan.group) || '', pipeline: (plan && plan.pipeline) || '', result: 'error', origSize: row.size || 0, newSize: 0, error: err }); } catch {}
    try { await markDone(table, row.id); } catch {}
    return 'skipped';
  } finally {
    for (const f of [tmpIn, tmpOut]) { try { await fs.promises.unlink(f); } catch {} }
  }
}

async function fetchCandidates(limit) {
  // Oldest first so the pre-existing backlog drains in upload order.
  // Candidates are rows the compressor has not already handled; the scan key a
  // virus verdict hangs off is derived from the URL, never the row id.
  return await db.prepare(`
    SELECT a.id, a.url, a.filename, a.mime, a.size, a.kind, a.created_at, 'att' AS tbl FROM attachments a
    WHERE a.compressed = 0 AND a.kind IN ('image','video','audio')
    UNION ALL
    SELECT d.id, d.url, d.filename, d.mime, d.size, d.kind, d.created_at, 'dm' AS tbl FROM dm_attachments d
    WHERE d.compressed = 0 AND d.kind IN ('image','video','audio')
    ORDER BY created_at ASC LIMIT ?`).all(limit);
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
    // Skips (tiny/foreign/missing files) are cheap: burn through a few per
    // tick looking for real work, but cap compressions at BATCH.
    const rows = await fetchCandidates(BATCH + 25);
    if (!rows.length) return 'idle';
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
      if (scanMap) {
        const k = cleanKey(row.url);
        if (k && (scanMap.get(k) || 'clean') !== 'clean') continue;
      }
      let r;
      try { r = await processRow(row); }
      catch (e) { warn('row failed:', String((e && e.message) || e).slice(0, 160)); continue; }
      if (r === 'compressed') done++;
    }
    // Anything left? A cheap 1-row probe decides hot-loop vs idle poll.
    try {
      const rest = await fetchCandidates(1);
      return rest.length ? 'more' : 'idle';
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

// Pending vs finished files (both attachment tables), with byte totals.
// COUNT/SUM come back as numeric strings from Postgres — coerce them.
async function mediaQueueCounts() {
  const out = { pending: {}, done: {} };
  for (const table of ['attachments', 'dm_attachments']) {
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
    ready = true;
    log(`worker on: continuous while queued (every ~${Math.round(ACTIVE_MS / 100) / 10}s), idle poll every ${Math.round(EVERY_MS / 1000)}s, ${BATCH}/tick, 1 thread${checkNice() ? ', nice 19' : ''}` +
      (missing.length ? ` (encoders missing, related types skipped: ${missing.join(', ')})` : ' (all encoders present)'));
    if (!timer) schedule(10000); // first pass after boot settles; kicks pull it forward
  }).catch((e) => warn('migration failed:', String((e && e.message) || e).slice(0, 200)));
}

module.exports = { startMediaCompress, tickMediaCompress: tick, kickMediaCompress, ensureColumns, planFor, buildArgs, cleanKey, MIN_BYTES, getMediaStats, mediaQueueCounts, mediaTotals, mediaRecentJobs };
