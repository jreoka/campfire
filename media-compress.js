// Background media compressor: shrinks chat uploads (images, GIFs, video,
// audio) so storage + bandwidth stay small without anyone noticing.
//
// It is deliberately NOT part of the upload path. An upload is served the moment
// it lands (see virus-scan.js): nothing about it waits for an encode, and no
// client is ever shown a "Processing file" card on its account. Everything here
// runs out of band, behind the reader.
//
// Design notes:
// - Single-container friendly: runs in-process (see startMediaCompress),
//   never on the request path, so uploads stay instant.
// - Two triggers, deliberately split by WHAT the encode is for:
//   - the COMPATIBILITY QUEUE, for bytes a reader's platform cannot open at
//     all: Opus/Vorbis audio (a voice message recorded on Android is WebM/Opus,
//     which no Apple product can put in an <audio> element before iOS 17.4 and
//     never in Ogg) -> AAC/MP4, every video container Safari cannot demux ->
//     MP4, and HEIC/HEIF stills (no Windows browser can display one) -> JPEG.
//     Those are not "make it smaller" jobs — the file is unusable on that
//     platform until they run — so they are settled promptly, seconds after
//     the upload lands. Continuous while work exists, with a short breather
//     (MEDIA_COMPRESS_ACTIVE_MS) between hot ticks and a slower idle poll
//     (MEDIA_COMPRESS_EVERY_MS) once the queue drains; a new upload wakes it.
//   - the SCHEDULED BUCKET SWEEP (reconcileBucket) for everything else: the
//     ordinary shrinking of media every reader can already open. It lists the
//     bucket on a timer (MEDIA_SWEEP_EVERY_MS, default 6h) so a file the reader
//     was just handed is never rewritten underneath them, and it is the one
//     path that sees profile media and anything a flag table never carried.
// - Low CPU by construction: at most MEDIA_COMPRESS_CONCURRENCY files at a
//   time (process-wide lock), `nice -n 19` on POSIX, ffmpeg `-threads 1` per
//   file, small per-tick batch, short breather between hot ticks, and a
//   load-average check that defers ticks when the box is busy.
// - Visually transparent settings only (see PIPELINES): quality levels where
//   artifacts are essentially invisible in chat embeds, plus downscale caps
//   (2048px stills / 1280px GIFs / 1080p video) that only bite oversized
//   sources. Files that would shrink <8% keep their original bytes — which is
//   what makes attempting a tiny file cheap rather than reckless.
// - Every size, every type the box can decode: there is NO size floor (a 40 KB
//   screenshot is still worth a look — set MEDIA_COMPRESS_MIN_KB for one), and
//   planFor() routes any image (BMP/TIFF/AVIF/JXL/HEIC/ICO/…, alpha-aware),
//   any video container to MP4, and any audio codec to MP3 or AAC/MP4. Only
//   non-media (PDF, zip, source code) and SVG — vector, which a raster
//   re-encode would degrade rather than shrink — are left alone.
// - Playability outranks size for the formats Apple cannot open. Safari has no
//   Ogg support at all, learned WebM/Opus (in <audio>) only in 17.4 — March
//   2024 — and cannot demux WebM/Matroska/AVI video either, and Web Audio's
//   decodeAudioData still refuses both. A voice message recorded on Android or
//   desktop Chrome is exactly WebM/Opus, so it reached an iPhone as a player
//   that did nothing. Those inputs are converted to AAC in MP4 and the plan is
//   marked `normalize`: published even when the result is LARGER, because a
//   re-encode of an efficient Opus stream to AAC is usually bigger. The channel
//   layout comes from the source (probeAudio/resolvePlan): a voice message — one
//   channel, or no longer than the composer's own 5-minute cap — is encoded mono
//   at 96k, which lands UNDER the Opus original instead of ~25% over it, while
//   longer/stereo audio (music) keeps stereo 128k. Note a MediaRecorder voice
//   note is NOT reliably one channel (measured: Chrome wrote the owner's as
//   dual-mono), and "are the channels the same signal" is not a usable test
//   either — Opus leaves the difference channel only ~25 dB down on a dual-mono
//   source, which a quiet genuine stereo mix also reaches. Duration and channel
//   count are facts; those are what the rule uses. The same normalize rule covers
//   non-Apple video containers (WebM/Matroska/AVI/WMV/…). These are exactly the
//   jobs the compatibility queue runs promptly (see above) — a voice note an
//   iPhone cannot play for six hours is not a compression policy, it is a bug.
// - HEIC/HEIF is the other `normalize` case: the container's ffmpeg
//   has no HEIF demuxer at all (Alpine builds it without libheif), and no
//   browser on Windows can decode those bytes either, so leaving the original
//   means a download nobody can look at. libheif's own `heif-convert` decodes
//   it to a JPEG first (encodeCandidate), and the plan is marked `normalize`:
//   the conversion is published even when it is bigger, because being viewable
//   is the point. See checkHeifConvert + the 'heic-viewable' policy.
// - Idempotent + resumable: attachments/dm_attachments carry a `compressed`
//   flag (0 = not settled yet, 1 = done). It is also what the admin panel counts
//   as "queued", and the compatibility queue's candidate query reads it — the
//   bucket sweep deliberately ignores it (`any`), because it found the object by
//   listing the bucket and a row that claims to be done can still point at
//   oversized bytes.
// - Anything here touches bytes that are ALREADY visible, so it always publishes
//   under a fresh key and leaves the old object for the orphan sweep: bytes
//   behind a live URL are never rewritten under a reader, and a player reading
//   ranges out of one is the worst case that rule exists to prevent.
// - Same URL shape always (/uploads/<sub>/<file>?v=<cachekey>). The bytes move
//   to a new random filename and the DB row (url/mime/size/filename) is updated
//   to match, so a download is never named after a format its bytes are not in.
//   Display filenames are otherwise never touched.
// - Needs ffmpeg on PATH (Docker image installs it via apk). Without ffmpeg
//   the worker logs once and stays idle — the app runs fine uncompressed.
//
// Env:
//   MEDIA_COMPRESS=0          disable entirely (default: enabled)
//   MEDIA_COMPRESS_EVERY_MS   ms between ticks once the queue is empty
//                             (idle poll; default 30000, min 5000)
//   MEDIA_COMPRESS_ACTIVE_MS  ms between ticks while files remain queued
//                             (default 2000, min 250)
//   MEDIA_COMPRESS_BATCH      files fed to one tick (default 1, max 16)
//   MEDIA_COMPRESS_CONCURRENCY  encodes running at once, process-wide
//                             (default 1 = the low-CPU promise, max 4)
//   MEDIA_COMPRESS_SLOT_MB    free memory each extra encode must find before it
//                             starts (default 192; 0 disables the guard)
//   MEDIA_COMPRESS_MIN_KB     flat size floor in KB — media below it is never
//                             attempted (default 0 = no floor at all)
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
const BATCH = Math.min(16, Math.max(1, parseInt(process.env.MEDIA_COMPRESS_BATCH || '1', 10) || 1));
// How many files may be ENCODED at once, process-wide. 1 is the original
// single-ffmpeg promise — the safest setting on a small box, and the default.
// More drains a burst in parallel, at a cost in CPU and RAM: every encode holds
// its own decoder buffers while the same box serves the app, so the useful
// range is small. 4 is the ceiling.
const CONCURRENCY = Math.min(4, Math.max(1, parseInt(process.env.MEDIA_COMPRESS_CONCURRENCY || '1', 10) || 1));
// Memory each encode beyond the first has to find free before it starts (MB).
// The cgroup limit is where the kernel kills something — and it picks the
// biggest process, which is not always ffmpeg — so a burst of large videos
// drops to fewer concurrent encodes instead of taking the app down. The first
// encode is never held back (a queue that will not start cannot drain).
const SLOT_MB = Math.max(32, parseInt(process.env.MEDIA_COMPRESS_SLOT_MB || '192', 10) || 192);
const JOB_TIMEOUT_MS = 15 * 60 * 1000; // pathological inputs can't wedge the queue
const MIN_SAVING = 0.08; // replace only when the output is >=8% smaller

// HEIC/HEIF: the one family the box physically cannot decode on its own. Alpine
// packages ffmpeg without libheif, so there is no HEIF demuxer in the image —
// `ffmpeg -i photo.heic` is "Invalid data found when processing input". The
// bytes are still perfectly readable by libheif itself, which ships as
// `heif-convert` (the Dockerfile installs libheif-tools), so the pipeline
// decodes through that tool and then runs the normal still encode on the
// result. Without the tool a HEIC upload is left exactly as it is (nobody can
// preview it, but nothing is lost) and the startup log says so.
const HEIF_CONVERT = process.env.HEIF_CONVERT || 'heif-convert';
const HEIF_EXTS = new Set(['.heic', '.heif']);
// What a HEIC is decoded to before the still pipeline gets it. 90 is libheif's
// own near-transparent band; the ffmpeg pass that follows re-encodes at the
// chat quality (q:v 3, capped at 2048px), so this generation is only ever a
// carrier — and it costs one small JPEG in /tmp on the way.
const HEIF_QUALITY = '90';

// Size floor. There is none by default: the compressor attempts media of ANY
// size and lets the 8% rule (MIN_SAVING) decide whether a rewrite is worth
// keeping, which is the real guard against a pointless re-encode. The old
// per-type floors (image 400 KB / gif 800 KB / video 2 MB / audio 1 MB) are
// still available as one flat knob for an operator who would rather not spend
// the CPU on small files — MEDIA_COMPRESS_MIN_KB, default 0.
const MIN_KB = Math.max(0, Number(process.env.MEDIA_COMPRESS_MIN_KB) || 0);
const MIN_BYTES = { image: MIN_KB * 1024, gif: MIN_KB * 1024, video: MIN_KB * 1024, audio: MIN_KB * 1024 };

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
let heifOK = null; // null = unprobed (heif-convert, the HEIC decoder)
let encCache = null; // {x264, mp3, opus, webp}
let niceOK = null;
let loggedIdle = false;
// In-memory worker stats (this boot; lifetime totals live in media_compress_log).
const stats = {
  startedAt: 0, ticks: 0, processed: 0, skipped: 0, errors: 0,
  savedBytes: 0, lastTickAt: 0, lastJob: null, lastError: null,
};
const LOG_KEEP = 600; // recent job rows kept for the admin panel (kept rows count too)
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
  // `media_compress_log` cannot serve this purpose: it is a rolling panel feed
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
  // One-time policy changes need a memory of their own: the ledger's verdicts
  // are only final for the policy that produced them, and a policy that widens
  // what the compressor will do has to hand back exactly the files it would now
  // treat differently — once, or every boot would queue the bucket again.
  await db.exec(`CREATE TABLE IF NOT EXISTS media_compress_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  at BIGINT NOT NULL
)`);
  await oncePolicy('png-lossy', async () => (await db.prepare(
    "DELETE FROM media_compress_keys WHERE status = 'kept' AND mode = 'no_saving' AND lower(key) LIKE '%.png'"
  ).run()).changes);
  // A verdict recorded under a policy that no longer exists is not a verdict:
  // `below_floor` means "skipped because there was a size floor", and there is
  // none any more. Dropping just those rows lets the bucket scan reconsider the
  // files the old rule never looked at — the objects themselves are untouched
  // (the scan either republishes one under a new key or leaves it byte for
  // byte). Every other verdict stands.
  try {
    await db.exec("DELETE FROM media_compress_keys WHERE mode = 'below_floor'");
  } catch (e) { warn('ledger floor cleanup skipped:', String((e && e.message) || e).slice(0, 120)); }
  // HEIC/HEIF now has a pipeline where it had none (libheif's heif-convert —
  // see planFor). Everything stored before that is sitting at compressed = 1
  // with a "kept/encode_failed" verdict in the ledger, which is exactly the
  // "policy that widens what the compressor will do" the memory above exists
  // for: hand those files back so the queue re-examines them once and the
  // reader finally gets a picture instead of an unopenable .heic. Guarded on
  // the decoder being present so a box without it does not spend its one shot
  // handing files to a pipeline that still cannot run (the memory is only
  // written when the work was actually possible).
  if (checkHeifConvert()) {
    await oncePolicy('heic-viewable', async () => {
      let handed = 0;
      try { handed += Number((await db.prepare("DELETE FROM media_compress_keys WHERE lower(key) LIKE '%.heic' OR lower(key) LIKE '%.heif'").run()).changes) || 0; } catch {}
      for (const table of ['attachments', 'dm_attachments', 'stories']) {
        try {
          // `kind` rides along: a HEIC that arrived as application/octet-stream
          // was filed as a 'file', and the queue only feeds image/video/audio
          // rows — without this the repaired file would still be a download card.
          handed += Number((await db.prepare(`UPDATE ${table} SET compressed = 0,
            kind = CASE WHEN kind = 'file' THEN 'image' ELSE kind END
            WHERE lower(split_part(url, '?', 1)) LIKE '%.heic' OR lower(split_part(url, '?', 1)) LIKE '%.heif'`).run()).changes) || 0;
        } catch (e) { warn('heic hand-back skipped for ' + table + ':', String((e && e.message) || e).slice(0, 120)); }
      }
      return handed;
    });
  } else {
    warn(`HEIC decoding unavailable (${HEIF_CONVERT} not on PATH) — .heic/.heif uploads stay as they are and cannot be previewed (install libheif-tools)`);
  }
  // Apple-playability, once. Opus/Vorbis audio (WebM/Ogg) and the video
  // containers Safari cannot demux used to be re-encoded into the SAME format,
  // and the 8% rule then kept whatever did not shrink — which is how a voice
  // message recorded on Android stayed silent on every iPhone and iPad. The
  // plans for those inputs now carry `normalize` (see planFor), so the files
  // that predate that rule are handed back once: their rows re-queued
  // (compressed = 0, which the compatibility queue picks up — these are exactly
  // its types, see COMPATIBILITY_EXTS) and their ledger verdicts dropped, so the
  // bucket sweep rejudges the objects the queue can never see. `media_compress_meta`
  // is the memory, so this runs once per database; the objects themselves are
  // only replaced when one of those paths republishes them under a new key.
  // Guarded on ffmpeg like the HEIC policy: with no encoder the one shot must
  // not be spent on work that cannot run.
  if (checkFfmpeg()) {
    await oncePolicy('apple-playable', async () => {
      // The exact set planFor now converts for compatibility: every audio
      // format Safari cannot play, plus every video container that is not
      // MP4/M4V/QuickTime. Matched on the stored extension alone — that is what
      // planFor falls back to as well, and it is all a row (or a ledger key)
      // is guaranteed to carry.
      const CONVERTS = String.raw`\.(webm|weba|ogg|oga|opus|wma|amr|ac3|mp2|mka|au|wv|ape|dts|ra|3ga|mkv|avi|wmv|flv|3gp|3g2|mpe?g|m2ts|mts|ogv|vob|rm|rmvb|asf|f4v)$`;
      let handed = 0;
      for (const table of ['attachments', 'dm_attachments']) {
        try {
          handed += Number((await db.prepare(`UPDATE ${table} SET compressed = 0
            WHERE lower(split_part(url,'?',1)) ~ ?`).run(CONVERTS)).changes) || 0;
        } catch (e) { warn('apple hand-back skipped for ' + table + ':', String((e && e.message) || e).slice(0, 120)); }
      }
      try {
        // The ledger is keyed on the storage key, so the same test finds the
        // verdicts this policy replaces. A key already converted (its row now
        // points at the .mp4/.m4a successor) is referenced by nothing, so the
        // bucket scan leaves it to the orphan sweep.
        handed += Number((await db.prepare('DELETE FROM media_compress_keys WHERE lower(key) ~ ?').run(CONVERTS)).changes) || 0;
      } catch (e) { warn('apple ledger hand-back skipped:', String((e && e.message) || e).slice(0, 120)); }
      return handed;
    });
  }
}

// Run a one-time migration exactly once per database (media_compress_meta is
// the memory). `fn` returns how many rows it affected, for the log.
async function oncePolicy(name, fn) {
  try {
    const seen = await db.prepare('SELECT value FROM media_compress_meta WHERE key = ?').get(name);
    if (seen) return;
    const n = Number((await fn()) || 0);
    await db.prepare('INSERT INTO media_compress_meta (key,value,at) VALUES (?,?,?) ON CONFLICT (key) DO NOTHING')
      .run(name, String(n), now());
    if (n > 0) log(`policy ${name}: ${n} earlier verdict(s) handed back for another look`);
  } catch (e) { warn('policy ' + name + ' skipped:', String((e && e.message) || e).slice(0, 120)); }
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

// One row per finished file: compressed, kept as it was, or failed. Kept rows
// are logged on purpose — now that the compressor attempts every size and every
// type it can decode, "examined and left alone" is the COMMON outcome, and
// without it an owner who uploads a photo sees an empty panel and cannot tell
// "nothing to gain" from "never looked at". The feed is capped (LOG_KEEP).
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

// Is libheif's decoder on PATH? The binary existing is the whole question —
// `--help` prints the usage and exits 0, and a missing tool surfaces as
// spawnSync's own `error` (ENOENT), so neither needs the exit code. Cached for
// the process, like checkFfmpeg: the answer cannot change without a rebuild.
function checkHeifConvert() {
  if (heifOK !== null) return heifOK;
  try {
    const r = spawnSync(HEIF_CONVERT, ['--help'], { stdio: 'ignore', timeout: 10000 });
    heifOK = !!(r && !r.error);
  } catch { heifOK = false; }
  return heifOK;
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

// The row's family follows the BYTES it ends up pointing at, for the same reason
// the URL does. A HEIC that arrived as application/octet-stream was filed as a
// 'file' (a plain download card, no preview); the JPEG it becomes is a picture
// and has to render as one, or the reader is still handed a card. Anything the
// new MIME says nothing about keeps what it had.
function kindForMime(mime, fallback) {
  const mt = String(mime || '');
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('video/')) return 'video';
  if (mt.startsWith('audio/')) return 'audio';
  return fallback || 'file';
}

// The DISPLAY name follows the bytes too, extension only (the stem the sender
// chose is theirs). "X.heic" that downloads as JPEG bytes is a file Windows
// still cannot open, because the extension is what picks the handler — and a
// saved "song.wav" that is really MP3 is the same small lie. A name with no
// extension is left exactly as it is.
function nameWithExt(name, outExt) {
  const s = String(name || '');
  if (!s || !outExt) return s;
  const cur = path.extname(s);
  if (!cur || cur.toLowerCase() === String(outExt).toLowerCase()) return s;
  return s.slice(0, -cur.length) + outExt;
}

// Media extensions, for the two cases a MIME cannot cover: the bucket scan only
// has the object's name (storage.mimeForFilename falls back to
// application/octet-stream), and a chat upload keeps whatever the client called
// it. `.ts` is deliberately NOT here — MPEG-TS in a video player, TypeScript in
// a chat; video/mp2t still matches the MIME rule, and guessing "video" for every
// shared .ts file is the wrong way round.
const IMAGE_EXTS = new Set(['.bmp', '.tif', '.tiff', '.avif', '.jxl', '.ico', '.heic', '.heif', '.jfif', '.jpe', '.apng', '.psd', '.tga', '.dds', '.pcx', '.qoi', '.wbmp', '.jp2', '.j2k', '.exr', '.hdr', '.xbm', '.xpm']);
const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.wmv', '.flv', '.3gp', '.3g2', '.mpg', '.mpeg', '.m2ts', '.mts', '.ogv', '.vob', '.rm', '.rmvb', '.asf', '.f4v']);
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.m4b', '.aac', '.ogg', '.oga', '.opus', '.wav', '.flac', '.aif', '.aiff', '.aifc', '.wma', '.amr', '.ac3', '.mp2', '.caf', '.au', '.wv', '.ape', '.mka', '.weba', '.ra', '.dts', '.3ga']);

// The audio formats EVERY reader plays — Safari/iOS/macOS (the strict ones),
// Chrome, Edge, Firefox, Android. An input in one of these keeps the ordinary
// 8% rule; anything else is being converted for compatibility, so its plan is
// marked `normalize` and the result publishes whatever it weighs. (AAC/MP4 and
// MP3 are the two the Apple stack has always played; WAV and FLAC are older
// than that stack and universal today.)
const EVERYWHERE_AUDIO = new Set(['.mp3', '.m4a', '.m4b', '.aac', '.wav', '.flac']);

// ---------- the compatibility set ----------
// planFor's `normalize` cases, expressed as something the compatibility queue's
// candidate query can filter on: the containers and codecs a reader's platform
// cannot open AT ALL, so the encode is a repair rather than an optimization.
//   - Opus/Vorbis audio (WebM, Ogg) and every video container that is not
//     MP4/M4V/QuickTime: no Apple product can play them (see the header). This
//     is an owner requirement — "audio messages must be heard on
//     Mac/iPhone/iPad" — not a size policy, so it is worth doing immediately
//     rather than at the next bucket sweep, hours later.
//   - HEIC/HEIF stills: no Windows browser can display one, and the image's own
//     ffmpeg cannot demux it (libheif's heif-convert does).
// The extension list is DERIVED from the same Sets planFor reads, so a container
// added there flows here; what is hand-written is only which of those families
// counts as a repair. Everything else — JPEG, PNG, GIF, MP4, MOV, MP3, WAV — is
// ordinary shrinking, and that belongs to the scheduled bucket sweep
// (reconcileBucket), which is why a freshly posted photo is never re-encoded
// seconds after the reader received it.
const APPLE_VIDEO_EXTS = new Set(['.mp4', '.m4v', '.mov']);
const COMPATIBILITY_EXTS = new Set([
  ...HEIF_EXTS,
  ...[...VIDEO_EXTS].filter((e) => !APPLE_VIDEO_EXTS.has(e)),
  '.ogg', '.oga', '.opus', '.weba', '.webm',
  ...[...AUDIO_EXTS].filter((e) => !EVERYWHERE_AUDIO.has(e)),
]);
const COMPATIBILITY_RE = '\\.(' + [...COMPATIBILITY_EXTS].map((e) => e.slice(1)).join('|') + ')$';
// The MIME half of the same rule. An upload keeps its original extension, so the
// stored name normally says it; this is the second chance for a name that does
// not (and for rows written by paths that filed the family differently).
const COMPATIBILITY_MIMES = ['image/heic', 'image/heif', 'audio/ogg', 'audio/opus', 'audio/webm', 'audio/x-opus+ogg', 'video/webm'];
const COMPATIBILITY_MIME_SQL = COMPATIBILITY_MIMES.map((m) => `'${m}'`).join(',');
// `~` is the POSIX regex match in Postgres; the pattern is this module's own
// constant, never anything a request supplied.
function compatWhere(alias) {
  return `(lower(split_part(${alias}.url, '?', 1)) ~ '${COMPATIBILITY_RE}'`
    + ` OR lower(${alias}.mime) IN (${COMPATIBILITY_MIME_SQL}))`;
}
// Is this stored key a compatibility job? The same test the SQL makes, for the
// callers that only have a key (a profile upload's own kick), so the two cannot
// disagree about whether a file is "broken for a platform".
function needsCompatibility(key) {
  return COMPATIBILITY_EXTS.has(extOf(key))
    || /^audio\/(ogg|opus|webm|x-opus\+ogg)$/.test(storage.mimeForFilename(key) || '')
    || storage.mimeForFilename(key) === 'image/heic' || storage.mimeForFilename(key) === 'image/heif'
    || storage.mimeForFilename(key) === 'video/webm';
}

// A MIME that names no family at all — only then is the extension the best
// available evidence. A file that calls itself text/plain or application/zip is
// taken at its word: source code and archives must never reach ffmpeg.
function opaqueMime(mt) { return !mt || mt === 'application/octet-stream' || mt === 'binary/octet-stream'; }

// Decide the pipeline for a row. Returns null when the type is out of scope —
// the caller marks those done and they are never looked at again.
//
// Coverage is deliberately broad: ANY image the box can decode (BMP, TIFF,
// AVIF, JXL, ICO, PSD, …), ANY video container (-> MP4), ANY audio codec
// (-> MP3 or AAC/MP4 — the two formats every Apple product plays, see the
// header note), plus HEIC/HEIF through libheif (-> JPEG). What stays out
// is anything that is not media (PDF, zip, source code, executables) and SVG on
// purpose — vector art has no fixed resolution, so rasterizing it would be a
// downgrade, not a compression.
//
// `pipeline: 'still'` is a DEFERRED decision: the encoder (JPEG vs PNG) depends
// on the alpha channel, which only the bytes know. See resolvePlan().
function planFor(mime, filename) {
  const mt = String(mime || '');
  const ext = extOf(filename);
  const enc = probeEncoders();
  // HEIC/HEIF first, by name or by MIME (image/heic, image/heif, and the
  // -sequence variants). These bytes have no pipeline of their own on this box:
  // ffmpeg cannot open them, so they are decoded by heif-convert and the result
  // is encoded as a JPEG. `normalize` is what says "publish this even if it is
  // not smaller" — the original cannot be displayed by any Windows browser or
  // viewer, so a slightly larger JPEG is the only usable copy. With no decoder
  // installed there is nothing to do at all and the file is left alone
  // (null plan = terminal 'no_pipeline', logged once at startup).
  if (HEIF_EXTS.has(ext) || /^image\/hei[cf]/.test(mt)) {
    if (!checkHeifConvert()) return null;
    return { pipeline: 'heif', outExt: '.jpg', group: 'image', normalize: true };
  }
  // GIFs (animated or still — the palette pipeline handles both).
  if (mt === 'image/gif' || ext === '.gif') return { pipeline: 'gif', outExt: '.gif', group: 'gif' };
  if (mt === 'image/svg+xml' || ext === '.svg') return null;
  if (mt === 'image/jpeg' || ext === '.jpg' || ext === '.jpeg') return { pipeline: 'jpeg', outExt: '.jpg', group: 'image' };
  // PNG and WebP keep their own encoder (`prefer`) and are still probed: both
  // containers can hold an ANIMATION (APNG, animated WebP), and one frame is all
  // a still re-encode would leave of it.
  // A PNG goes to WebP by owner decision — lossless PNG cannot win anything on
  // a web-sized photo (a re-encode lands within a few percent, which the 8% rule
  // then keeps), while WebP q82 takes 40-60% off it and still carries alpha.
  // Screenshots soften slightly, which is the trade that was chosen. Without
  // libwebp the old lossless behaviour stands.
  if (mt === 'image/png' || ext === '.png') {
    return enc.webp
      ? { pipeline: 'still', prefer: 'webp', outExt: '.webp', group: 'image' }
      : { pipeline: 'still', prefer: 'png', outExt: '.png', group: 'image' };
  }
  if ((mt === 'image/webp' || ext === '.webp') && enc.webp) return { pipeline: 'still', prefer: 'webp', outExt: '.webp', group: 'image' };
  // Any other image (BMP, TIFF, AVIF, JXL, ICO, PSD, …): the bytes decide
  // between JPEG and PNG, and whether they are safe to touch at all.
  if (mt.startsWith('image/') || (opaqueMime(mt) && IMAGE_EXTS.has(ext))) return { pipeline: 'still', outExt: '.jpg', group: 'image' };
  // Video -> H264 MP4 (transparent at CRF 24 for chat-sized embeds). The
  // containers Safari can open are exactly MP4/M4V/QuickTime; for everything
  // else (WebM, Matroska, AVI, WMV, MPEG-TS, …) the plan is `normalize`, for
  // the same reason as the Opus rule below: an iPhone cannot play the original
  // at all, so "smaller" is the wrong bar — a playable MP4 that happens to be
  // larger is what the reader needs.
  if (mt.startsWith('video/') || (opaqueMime(mt) && VIDEO_EXTS.has(ext))) {
    if (!enc.x264) return null;
    const apple = mt === 'video/mp4' || mt === 'video/quicktime' || ext === '.mp4' || ext === '.m4v' || ext === '.mov';
    return apple ? { pipeline: 'mp4', outExt: '.mp4', group: 'video' }
      : { pipeline: 'mp4', outExt: '.mp4', group: 'video', normalize: true };
  }
  // Audio.
  if (mt === 'audio/mpeg' || ext === '.mp3') {
    if (!enc.mp3) return null;
    return { pipeline: 'mp3', outExt: '.mp3', group: 'audio' };
  }
  if (mt === 'audio/mp4' || mt === 'audio/aac' || mt === 'audio/x-m4a' || ext === '.m4a') {
    return { pipeline: 'm4a', outExt: '.m4a', group: 'audio' };
  }
  // Opus and Vorbis — WebM and Ogg — are the ONE audio family this is not a
  // size question about. Safari could not put either container in an <audio>
  // element until 17.4 (2024-03) and has never played Ogg at all, and Web
  // Audio's decodeAudioData still cannot decode them, so a voice message
  // recorded on Android or desktop Chrome arrived at an iPhone as a player that
  // did nothing (see the Apple note in the header). -> AAC in MP4, and marked
  // `normalize` so the conversion is published even when it is BIGGER: being
  // audible is the point, exactly as with the HEIC rule below. It usually is
  // bigger, because re-encoding an efficient Opus stream to AAC at 128k costs
  // bytes — that is the accepted price of one format every reader can play.
  // `probeAudio` lets the bytes pick the layout: a voice message (one channel,
  // or a clip no longer than the composer's own 5-minute cap) is encoded mono at
  // 96k instead of being written out as duplicated stereo 128k.
  if (mt === 'audio/ogg' || mt === 'audio/opus' || mt === 'audio/webm' || mt === 'audio/x-opus+ogg'
      || ext === '.ogg' || ext === '.oga' || ext === '.opus'
      || (ext === '.webm' && mt.startsWith('audio/')) || (opaqueMime(mt) && ext === '.weba')) {
    return { pipeline: 'm4a', outExt: '.m4a', group: 'audio', normalize: true, probeAudio: true };
  }
  // Lossless monsters -> universal MP3 (renames the stored file, DB follows).
  if (mt === 'audio/wav' || mt === 'audio/x-wav' || mt === 'audio/flac' || mt === 'audio/x-flac' || ext === '.wav' || ext === '.flac') {
    if (!enc.mp3) return null;
    return { pipeline: 'wav2mp3', outExt: '.mp3', group: 'audio' };
  }
  // Anything else that is audio (AIFF, WMA, AMR, AC3, MP2, MKA, CAF, …) -> MP3
  // too: a codec this box reads but not every browser plays inside a chat is
  // exactly the case worth normalising. For those the conversion has to publish
  // whatever it produces (see EVERYWHERE_AUDIO) — keeping a .wma because the MP3
  // came out larger would leave the file silent on an iPhone.
  if (mt.startsWith('audio/') || (opaqueMime(mt) && AUDIO_EXTS.has(ext))) {
    if (!enc.mp3) return null;
    return { pipeline: 'wav2mp3', outExt: '.mp3', group: 'audio', normalize: !EVERYWHERE_AUDIO.has(ext) };
  }
  return null;
}

// Alpha channel? A pix_fmt always starts with its base name — 'rgba64le',
// 'yuva420p', 'gbrap16be', 'ya8' and 'pal8' carry alpha; 'yuv420p', 'rgb24' and
// 'gray' do not.
const ALPHA_PIX = /^(rgba|bgra|argb|abgr|yuva|gbrap|ya8|ya16|pal8)/;

// ffprobe, async like runFfmpeg: -count_frames on a large animation can take
// seconds, and spawnSync would block every request on the box for that long.
function runFfprobe(args, timeoutMs) {
  return new Promise((resolve) => {
    const useNice = checkNice();
    const cmd = useNice ? 'nice' : 'ffprobe';
    const cmdArgs = useNice ? ['-n', '19', 'ffprobe', ...args] : args;
    let child;
    try {
      child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { resolve(''); return; }
    let out = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    try {
      child.stdout.on('data', (d) => { out += String(d); if (out.length > 4096) out = out.slice(0, 4096); });
    } catch {}
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

// How many frames, and is there an alpha channel? -count_frames rather than the
// container's nb_frames on purpose: an animated AVIF/JXL routinely declares
// nothing, and mistaking an animation for a still is data loss, not a
// compression (frame one is all that would survive).
async function probeStill(inPath) {
  const out = await runFfprobe(['-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=pix_fmt,nb_read_frames', '-of', 'csv=p=0', inPath], 30000);
  const line = String(out || '').trim().split(/\r?\n/)[0] || '';
  if (!line) return null;
  const [pix, frames] = line.split(',');
  return { pix: String(pix || '').toLowerCase(), frames: Number(frames) || 0 };
}

// The longest a voice message can be: the composer's own recording cap
// (REC_MAX_MS in public/js/compose.js, 5 minutes). A clip no longer than this is
// treated as a voice message when the channel layout is chosen (see
// resolvePlan) — which is what makes "a voice note ends up smaller than the
// WebM/Opus it arrived as" true instead of ~25% bigger.
const VOICE_MAX_S = 5 * 60;

// What the audio bytes are: how many channels, and how long. One header read,
// asked only for the plans that re-encode Opus/Vorbis into AAC (see
// resolvePlan). Null when the probe cannot answer (no audio stream, an
// unreadable header), which keeps the stereo plan.
async function probeAudio(inPath) {
  const out = await runFfprobe(['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=channels', '-show_entries', 'format=duration', '-of', 'json', inPath], 15000);
  try {
    const j = JSON.parse(String(out || '{}'));
    const st = (j.streams || [])[0] || {};
    return {
      channels: Number(st.channels) || 0,
      duration: Number((j.format || {}).duration) || 0,
    };
  } catch { return null; }
}

// Settle a deferred 'still' plan against the actual bytes, once they are local.
// Returns a concrete plan, or null to leave the file exactly as it is. A probe
// that cannot answer keeps the safe choice — the encoder is the next judge, and
// a file it rejects is simply kept with its original bytes.
async function resolvePlan(plan, inPath) {
  if (!plan) return plan;
  if (plan.probeAudio) {
    // Voice message, or not? Both answers are facts, not thresholds: a single
    // channel is a single channel whatever it is, and a clip inside the
    // recorder's own 5-minute cap is a voice message rather than music. (The
    // tempting third test — "are the two channels the same signal" — does NOT
    // separate cleanly: Opus leaves the difference channel only ~25 dB down on a
    // dual-mono source, while a genuinely stereo mix 30 dB quieter sits at the
    // same relative level. See the note in the header.)
    const info = await probeAudio(inPath);
    const voice = !!info && (info.channels === 1 || (info.duration > 0 && info.duration <= VOICE_MAX_S));
    // One channel at 96k. The m4a plan used to force `-ac 2` on a voice message,
    // duplicating its channel and making the AAC 20-30% BIGGER than the Opus note
    // it replaced; 96k mono is transparent for speech and lands under it. Longer
    // (or unknown) audio keeps the full stereo 128k treatment.
    return voice ? { ...plan, pipeline: 'm4a-mono', mono: true } : { ...plan, pipeline: 'm4a' };
  }
  if (plan.pipeline !== 'still') return plan;
  const info = await probeStill(inPath);
  if (info && info.frames > 1) return null; // an animation: not ours to flatten
  const alpha = !!(info && ALPHA_PIX.test(info.pix));
  // `prefer` is a promise the file's own format made — a PNG stays a PNG
  // (lossless), a WebP stays a WebP. Only an image with no format of its own
  // gets the alpha-driven choice, where JPEG would flatten transparency to
  // black and PNG would balloon a photograph.
  const pipeline = plan.prefer || (alpha ? 'png' : 'jpeg');
  const outExt = plan.prefer ? plan.outExt : (alpha ? '.png' : '.jpg');
  return { ...plan, pipeline, outExt };
}

// Would this upload ever be re-encoded by the compressor? A predicate kept for
// the coverage contract (`scripts/test-compress-types.js`) rather than for the
// request path: with no size floor it is "is this media at all", and the two
// real triggers — the compatibility queue and the bucket sweep — pick their own
// work (see COMPATIBILITY_EXTS and reconcileBucket).
function isCandidate(mime, key, size) {
  if (!ENABLED || !key) return false;
  const plan = planFor(mime, key);
  if (!plan) return false;
  return (Number(size) || 0) >= (MIN_BYTES[plan.group] || MIN_BYTES.image);
}

// The still box is a CAP, never a target: min(2048,iw) leaves a smaller picture
// at its own size. `scale=2048:2048:...:decrease` alone would blow a 512px
// photo or a 16px emoji up to 2048px — which is not "compression" in any
// direction, it is the same picture four hundred times bigger, and it is
// exactly what the HEIC path (a 512px iPhone HEIC, say) must never do. The 8%
// rule used to hide this for ordinary images by rejecting the upscaled result;
// it costs the encode either way, so the cap is honest now.
const SCALE_IMG = "scale='min(2048,iw)':'min(2048,ih)':force_original_aspect_ratio=decrease";
const SCALE_GIF = 'fps=20,scale=1280:1280:force_original_aspect_ratio=decrease:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5';
const SCALE_VID = 'scale=1920:1080:force_original_aspect_ratio=decrease';

// Quality rationale (chat embeds, not archival):
// - jpeg q:v 3 (~quality 85): artifacts invisible at embed sizes.
// - png: lossless (metadata strip + downscale only) — now the FALLBACK for a
//   PNG, because a PNG becomes WebP instead unless libwebp is missing (see
//   planFor: lossless PNG cannot improve an already-encoded photo, and the
//   owner chose the size over the pixel-exactness of screenshots).
// - webp quality 82: Google's transparent-for-photos band (alpha rides along).
// - gif: 20fps cap (most chat GIFs ship <=20fps already), 1280px cap,
//   full 256-color palette with bayer dither.
// - video: x264 veryfast CRF 24 — the standard "looks like the source"
//   setting; 1080p cap; AAC 128k stereo.
// - audio: MP3 160k / AAC 128k stereo, or AAC 96k mono for a voice message (one
//   channel, or a clip inside the 5-minute recording cap — see resolvePlan) —
//   the two formats every Apple product plays, which is why nothing here
//   produces Opus any more (a WebM/Ogg voice note becomes AAC/MP4, see planFor);
//   lossless WAV/FLAC become 192k MP3 (still ~10x smaller).
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
    // AAC-LC in MP4, moov atom first: what Safari/iOS/macOS play natively, and
    // the target for every stereo input (+faststart matters most on iOS, where
    // a progressive read has to find the index before it will start).
    case 'm4a':
      return [...head, '-map', '0:a', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', outPath];
    // ...and the same for a MONO source (see resolvePlan: a voice message), one
    // channel back at 96k. Encoding a single channel twice bought nothing and
    // was the reason the AAC came out bigger than the WebM/Opus it replaced;
    // 96k mono is transparent for speech and lands under the Opus original.
    case 'm4a-mono':
      return [...head, '-map', '0:a', '-c:a', 'aac', '-b:a', '96k', '-ac', '1', '-movflags', '+faststart', outPath];
    case 'wav2mp3':
      return [...head, '-map', '0:a', '-c:a', 'libmp3lame', '-b:a', '192k', outPath];
    default:
      throw new Error('unknown_pipeline:' + pipelineName);
  }
}

// A tool that stands in for ffmpeg's own input handling (heif-convert). Same
// contract as runFfmpeg: { ok, error }, niced, killed at the job timeout — plus
// `killed`, because a process we killed is not a verdict on the bytes and the
// caller that records terminal verdicts has to be able to tell the difference
// (a memory kill or the job timeout must stay retryable).
function runTool(cmd, args) {
  return new Promise((resolve) => {
    const useNice = checkNice();
    const bin = useNice ? 'nice' : cmd;
    const argv = useNice ? ['-n', '19', cmd, ...args] : args;
    let child;
    try {
      child = spawn(bin, argv, { stdio: ['ignore', 'ignore', 'pipe'], timeout: JOB_TIMEOUT_MS });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
      return;
    }
    let stderr = '';
    try {
      child.stderr.on('data', (d) => { stderr += String(d); if (stderr.length > 4096) stderr = stderr.slice(-4096); });
    } catch {}
    const done = (ok, error, killed) => resolve({ ok, error: error || stderr.trim().slice(-500), killed: !!killed });
    child.on('error', (e) => done(false, String((e && e.message) || e)));
    child.on('close', (code, signal) => {
      const killed = code === null || !!signal;
      done(code === 0, code === 0 ? '' : `${cmd}_exit_${code}${signal ? '/' + signal : ''}: ${stderr.trim().slice(-300)}`, killed);
    });
  });
}

// Produce the candidate bytes for a plan. Everything but HEIC is a single
// ffmpeg call; a HEIC has to be decoded by libheif first, because the ffmpeg in
// this image cannot open the container at all (no HEIF demuxer). The decode
// lands in a throwaway JPEG that the ordinary still pipeline then downsizes and
// re-encodes at chat quality — so the reader gets the same 2048px/q3 picture an
// equivalent JPEG upload would have produced, and the intermediate is one small
// file in /tmp that never touches the bucket.
async function encodeCandidate(plan, inPath, outPath, tag) {
  if (!plan) return { ok: false, error: 'no_plan' };
  if (plan.pipeline !== 'heif') return runFfmpeg(buildArgs(plan.pipeline, inPath, outPath));
  const mid = path.join(os.tmpdir(), `cfc-heif-${tag || crypto.randomBytes(6).toString('hex')}.jpg`);
  try {
    const d = await runTool(HEIF_CONVERT, ['-q', HEIF_QUALITY, inPath, mid]);
    if (!d.ok) return { ok: false, error: 'heif_decode: ' + String(d.error || 'failed').slice(0, 300), killed: !!d.killed };
    const st = await fs.promises.stat(mid).catch(() => null);
    if (!st || !st.size) return { ok: false, error: 'heif_decode: empty output' };
    return await runFfmpeg(buildArgs('jpeg', mid, outPath));
  } finally {
    try { await fs.promises.unlink(mid); } catch {}
  }
}

// Is the candidate worth publishing? Normally the answer is "only if it is at
// least 8% smaller" — the original bytes are just as good, so a re-encode that
// does not pay for itself is dropped. A normalized conversion (see planFor: the
// HEIC path) is the exception, and the reason is the whole point of it: the
// ORIGINAL cannot be displayed by any Windows browser or viewer, so "smaller"
// is not the bar — a usable JPEG that happens to be larger is what the reader
// needs, and leaving the HEIC in place would keep the file unopenable.
function shouldPublish(plan, inSize, outSize) {
  const a = Math.max(0, Number(inSize) || 0);
  const b = Math.max(0, Number(outSize) || 0);
  if (!b) return false;
  if (plan && plan.normalize) return true;
  return b < a * (1 - MIN_SAVING);
}

// ffmpeg errors that mean "these bytes will never decode": a wrong type, a
// truncated file, a codec this build does not carry. Distinct from a killed
// process or a full disk, which a later attempt may get past. libheif's own
// refusals ('heif_decode: …') belong here for the same reason — a decoder that
// will not read the file is the same verdict whichever decoder it was — while
// a KILLED one never reaches this test (see encodeCandidate's `killed`).
const UNDECODABLE = /invalid data|not found|unsupported|unknown decoder|no decoder|could not find codec|moov atom|end of file|decoder .* not|heif_decode/i;

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
    // do: the malware scanner and HTTP serving. A half-written file read by the
    // scanner is a false verdict, which is exactly the failure mode we cannot
    // afford. rename() is atomic, so readers see either the whole old file or
    // the whole new one.
    const tmp = dest + '.tmp-' + crypto.randomBytes(6).toString('hex');
    try {
      // A first write to a new sub-directory (thumbs/files/) has to make it:
      // the local backend is a plain tree. Harmless when it already exists.
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
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

// ---------- derived chat-image previews ----------
// A channel's backlog is mostly pictures, and one full-size photo is 10–30x its
// own 640px WebP preview — so opening a channel on a slow link is dominated by
// image bytes nobody ever zooms into. Every /uploads/files/ image gets a derived
// preview at /uploads/thumbs/files/<name>.<ext>.webp, minted on first request
// (and backfilled by the bucket scan, so a fresh deploy fills history instead of
// making the first reader of every old channel pay) and served like any other
// upload. The reader's <img> asks for the preview and falls back to the original
// ONCE when it cannot be minted, so a cold cache — or a box without libwebp —
// never shows a broken picture, only a slower-loading one.
//
// Two rules keep this from becoming a second media pipeline:
//   - it encodes through withCompressLock like everything else on the box (the
//     one-encode accounting is what keeps a 1-vCPU pod answering requests);
//   - a request never WAITS for an encode. ensureThumb() waits at most
//     opts.waitMs and then answers "not ready" (see server.js, which 404s so the
//     client falls back); the encode finishes behind the response.
const THUMB_DIR = 'thumbs/';
const THUMB_EXT = '.webp';
const THUMB_PX = 640;  // long side: the chat wrap is 420px wide, phones are 2–3x
const THUMB_Q = 76;
const THUMB_WAIT = Symbol('thumb_wait');
const THUMB_ENABLED = process.env.MEDIA_THUMBS !== '0';
// Previews minted by the scheduled bucket scan per pass (0 disables the
// backfill — the on-request path still works). Bounded like every other sweep
// budget: this box has one core and the pass already holds the encode lock.
const THUMB_BACKFILL_MAX = Math.max(0, parseInt(process.env.MEDIA_THUMB_BACKFILL_MAX || '60', 10) || 60);
const THUMB_RETRY_MS = 10 * 60 * 1000; // how long a refusal is remembered
// Types worth previewing. SVG stays out (a raster preview of vector art is a
// downgrade, same rule as compression) and so does everything a thumbnail of a
// 640px box could not improve on.
const THUMB_EXTS = new Set(['.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.apng', '.webp', '.gif', '.bmp', '.avif', '.jxl', '.heic', '.heif', '.tif', '.tiff', '.ico', '.psd', '.tga', '.jp2', '.qoi']);

const thumbHave = new Set();      // srcKey -> preview verified this process
const thumbTried = new Map();     // srcKey -> when a mint was refused (short-lived)
const thumbJobs = new Map();      // srcKey -> in-flight Promise<thumbKey|null>
// Queued by the bucket scan, drained a couple per worker tick (see tick). The
// pass must not sit on 60 encodes: it is the same worker either way, and this
// way the pass finishes, the admin panel sees its result, and the backlog
// drains in the background exactly like the compression queue does.
const thumbBacklog = [];

// 'files/abc.jpg' -> 'thumbs/files/abc.jpg.webp'. Null for anything that is not
// a chat/DM upload (viewonce/ previews would be a way around its ticket gate) or
// not a still image.
function thumbKeyFor(srcKey) {
  const key = String(srcKey || '');
  if (!key.startsWith('files/')) return null;
  if (key.includes('..') || /[\0]/.test(key)) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(key)) return null;
  if (!THUMB_EXTS.has(extOf(key))) return null;
  return THUMB_DIR + key + THUMB_EXT;
}

// The inverse, with a round-trip check so a hand-made thumbs/ key can never name
// a source the forward direction would not have produced.
function thumbSourceKey(thumbKey) {
  const key = String(thumbKey || '');
  if (!key.startsWith(THUMB_DIR) || !key.endsWith(THUMB_EXT)) return null;
  const src = key.slice(THUMB_DIR.length, -THUMB_EXT.length);
  return thumbKeyFor(src) === key ? src : null;
}

function thumbsPossible() {
  return THUMB_ENABLED && checkFfmpeg() && probeEncoders().webp;
}

// Is a preview available for this source right now? `opts.waitMs` bounds how
// long the caller is willing to be parked (0 = wait for the whole encode, which
// only the backfill does). Returns the thumb key, or null.
async function ensureThumb(srcKey, opts) {
  const tkey = thumbKeyFor(srcKey);
  if (!tkey || !thumbsPossible()) return null;
  if (thumbHave.has(srcKey)) return tkey;
  const triedAt = thumbTried.get(srcKey);
  if (triedAt && now() - triedAt < THUMB_RETRY_MS) return null;
  let job = thumbJobs.get(srcKey);
  if (!job) {
    job = mintThumb(srcKey, tkey).finally(() => thumbJobs.delete(srcKey));
    thumbJobs.set(srcKey, job);
  }
  const waitMs = Math.max(0, Number(opts && opts.waitMs) || 0);
  if (!waitMs) return job;
  // An encode already running (or queued) owns the box: the preview cannot land
  // inside any sane wait, so answer immediately and let the mint finish behind
  // the response rather than stalling the reader for the full budget.
  const load = compressLoad();
  if (load.active >= load.concurrency || load.queued > 0) return null;
  const raced = await Promise.race([
    job,
    new Promise((resolve) => { const t = setTimeout(() => resolve(THUMB_WAIT), waitMs); try { t.unref(); } catch {} }),
  ]);
  return raced === THUMB_WAIT ? null : raced;
}

async function mintThumb(srcKey, tkey) {
  try {
    // A preview from an earlier boot (or another replica) is the common case on
    // a busy instance: one HEAD beats decoding the original again.
    if (!(await keyExists(tkey))) {
      const ok = await withCompressLock(() => encodeThumb(srcKey, tkey));
      if (!ok) { thumbTried.set(srcKey, now()); return null; }
    }
    thumbHave.add(srcKey);
    thumbTried.delete(srcKey);
    return tkey;
  } catch (e) {
    warn('thumbnail failed for ' + srcKey + ': ' + String((e && e.message) || e).slice(0, 140));
    thumbTried.set(srcKey, now());
    return null;
  }
}

async function encodeThumb(srcKey, tkey) {
  const rand = crypto.randomBytes(8).toString('hex');
  const tmpIn = path.join(os.tmpdir(), `cf-thumb-in-${rand}${extOf(srcKey) || '.bin'}`);
  const tmpOut = path.join(os.tmpdir(), `cf-thumb-out-${rand}${THUMB_EXT}`);
  try {
    await downloadToTemp(srcKey, tmpIn);
    const inStat = await fs.promises.stat(tmpIn).catch(() => null);
    if (!inStat || !inStat.size) return false;
    // One frame (an animation previews as its first frame), no audio, metadata
    // stripped, and the box shrinks to the source for anything already smaller
    // than it — min() rather than force_original_aspect_ratio alone, which would
    // happily upscale a 200px image to 640. The expressions are quoted because
    // a bare comma is a filtergraph separator ("No option name near ...").
    // The single frame is deliberate for an ANIMATED source too: a preview is
    // what a list TILE wants (an inbox bookmark's thumbnails, security.js), and
    // the CHAT never paints this still for one — an animated attachment renders
    // its own bytes instead (attIsAnimated, public/js/messages.js), because a
    // GIF painted from here stopped moving, which is the whole file.
    const box = `scale='min(${THUMB_PX},iw)':'min(${THUMB_PX},ih)':force_original_aspect_ratio=decrease`;
    const r = await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y', '-i', tmpIn, '-threads', '1', '-map_metadata', '-1', '-an',
      '-vf', box,
      '-c:v', 'libwebp', '-quality', String(THUMB_Q), '-frames:v', '1', tmpOut,
    ]);
    if (!r.ok) {
      const err = String(r.error || 'encode_failed').slice(0, 160);
      stats.errors++;
      stats.lastError = { key: srcKey, error: 'thumb: ' + err.slice(0, 120), at: now() };
      warn('thumbnail encode failed, keeping original:', srcKey, err);
      return false;
    }
    const outStat = await fs.promises.stat(tmpOut).catch(() => null);
    if (!outStat || !outStat.size) return false;
    await replaceBytes(tkey, tmpOut, 'image/webp');
    return true;
  } finally {
    try { await fs.promises.unlink(tmpIn); } catch {}
    try { await fs.promises.unlink(tmpOut); } catch {}
  }
}

const cacheBust = (cleanUrl) => `${cleanUrl}?v=${Date.now().toString(36)}`;
// How the job line reports the size move. A normalized conversion (see planFor:
// the HEIC rule and the Apple-playability rule) is EXPECTED to grow — Opus in,
// AAC out — so the log has to say `+24%` rather than the `--24%` a bare
// `-${pct}` produced when the percentage itself was negative.
function pctMove(inSize, outSize) {
  const p = Math.round((1 - (Number(outSize) || 0) / (Number(inSize) || 1)) * 100);
  return (p >= 0 ? '-' + p : '+' + -p) + '%';
}
const MIME_BY_OUT = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4' };

// ---------- job ----------

// Up to CONCURRENCY ffmpeg processes at a time, process-wide. This sweeper, the
// single-pass virus-scan pipeline and the bucket scan all compress, and this is
// the one place that decides how many may run at once however they arrived — so
// a concurrency of 4 means four encodes for the whole POD, not four per queue.
// The low-CPU promise is concurrency 1, which is also the default.
let active = 0;
let peak = 0;
const slots = []; // FIFO of starters waiting for a free slot

// How much memory the pod is using / allowed, from the cgroup (v2). Null when
// there is no cgroup to read (a dev shell, or an unlimited one) — the guard is
// then simply off.
let memMaxCache;
function cgroupMem() {
  try {
    if (memMaxCache === undefined) {
      const raw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
      const n = Number(raw);
      memMaxCache = Number.isFinite(n) && n > 0 ? n : 0; // "max" (unlimited) -> 0
    }
    if (!memMaxCache) return null;
    const cur = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
    return { max: memMaxCache, cur: Number.isFinite(cur) && cur > 0 ? cur : 0 };
  } catch { return null; }
}

// Room for one more encode? Always yes when nothing is running: the first one
// has to start or the queue could never drain (and this runs again from the
// finishing job, so a deferred batch resumes as soon as the memory is back).
function roomForAnother() {
  if (active === 0) return true;
  const m = cgroupMem();
  if (!m) return true;
  return m.cur + SLOT_MB * 1024 * 1024 <= m.max;
}

function pump() {
  while (slots.length && active < CONCURRENCY && roomForAnother()) slots.shift()();
}

// How loaded the encoder is right now: a caller that would only be waiting on a
// slot can decide not to wait at all (see ensureThumb's thumbnail budget).
function compressLoad() { return { active, queued: slots.length, concurrency: CONCURRENCY }; }

function withCompressLock(fn) {
  return new Promise((resolve, reject) => {
    slots.push(() => {
      active++;
      if (active > peak) peak = active;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => { active--; pump(); });
    });
    pump();
  });
}

// Keys with a compression pass in flight. Stops two callers from chewing
// through the same object at the same time — the compatibility queue on one
// replica and the bucket sweep on another, say — which would double the CPU and
// race two candidate byte streams to publication.
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

// One media object, rewritten in the background. Every caller is the same kind
// of caller now — the bytes are already being served, so a successful encode is
// always published under a FRESH KEY (never over the URL a reader may be
// streaming) and the rows that point at it are repointed:
//   - the compatibility queue (processRow) after it picked the row up, and
//   - the scheduled bucket sweep (reconcileBucket), which is the only path that
//     sees profile media and anything the flag tables never carried.
//   - `opts.any` ignores the `compressed` flag when looking up the rows that
//     point at this key (the bucket sweep found the object by listing the
//     bucket, so a row that claims to be done but still points at oversized
//     bytes has to be repointed too).
// Returns null when there is nothing to do (rows are marked done), else
// { key, url, size, origSize, mime, group, pipeline, renamed }.
async function processUpload(key, opts) {
  if (!ENABLED || !key || inflight.has(key)) return null;
  inflight.add(key);
  try {
    // Two guards, and both are needed:
    //   withCompressLock  — at most MEDIA_COMPRESS_CONCURRENCY ffmpeg per POD,
    //     the low-CPU promise.
    //   withKeyLock       — one ffmpeg per FILE across all pods. Without it the
    //     compatibility queue on one replica and the bucket sweep on another
    //     could compress the same object simultaneously: double the CPU, two
    //     different candidate byte streams, and a race to publish them.
    const r = await db.withKeyLock('media:' + key, () => withCompressLock(() => compressLocked(key, opts)));
    return r.ran ? r.value : null;
  } finally { inflight.delete(key); }
}

async function compressLocked(key, opts) {
  const mode = 'sweep';
  const rows = await pendingRowsForKey(key, opts);
  if (!rows.length) return null; // no chat/story row points here (profile media, an abandoned upload, …)
  // Verdicts are recorded for keys we actually examined: the bucket scan uses
  // the ledger to skip them, and a missing row here (the file was uploaded but
  // nothing references it yet) is deliberately left unrecorded so a later pass
  // can still adopt the object.
  const done = async (why, origSize) => {
    await recordKey(key, 'kept', why || '', Number(origSize) || 0, 0);
    // A row that carried no size (story media from before the size column
    // existed) learns it here, so the panel's queue totals stay honest and no
    // later pass has to ask the object again.
    const size = Number(origSize) || rows.reduce((m, r) => Math.max(m, Number(r.size) || 0), 0);
    if (Number(origSize) > 0) {
      for (const r of rows) {
        if (Number(r.size)) continue;
        try { await db.prepare(`UPDATE ${tableFor(r.tbl)} SET size = ? WHERE id = ?`).run(Math.floor(Number(origSize)), r.id); } catch {}
      }
    }
    try {
      await logJob({ tbl: row.tbl, url: row.url, filename: row.filename, kind: (plan && plan.group) || row.kind || '', pipeline: (plan && plan.pipeline) || '', result: 'kept', origSize: size, newSize: 0, error: why || '' });
    } catch {}
    await markRowsDone(rows);
    return null;
  };
  const row = rows[0];
  let plan = planFor(row.mime, key);
  if (!plan) return done('no_pipeline');
  const minSize = MIN_BYTES[plan.group] || MIN_BYTES.image;
  let dbSize = 0;
  for (const r of rows) dbSize = Math.max(dbSize, Number(r.size) || 0);
  // A row can carry no size at all — every story posted before the size column
  // existed, and any future table that forgets one. Ask the object itself:
  // treating "unknown" as "tiny" skips exactly the big files this is for (a
  // 20 MB story video was marked done on the first production pass that way).
  if (!dbSize) {
    dbSize = await keySize(key);
    if (!dbSize) return done('gone', 0);
  }
  if (dbSize < minSize) return done('below_floor', dbSize);
  if (!(await keyExists(key))) return done('gone', dbSize);

  const rand = crypto.randomBytes(8).toString('hex');
  const tmpIn = path.join(os.tmpdir(), `cfc-in-${rand}${extOf(key) || '.bin'}`);
  // tmpOut is minted once the plan is concrete: a deferred 'still' plan has no
  // output extension of its own until the bytes have been read.
  let tmpOut = null;
  try {
    await downloadToTemp(key, tmpIn);
    const inStat = await fs.promises.stat(tmpIn).catch(() => null);
    if (!inStat || !inStat.size) return done('empty_input', dbSize);

    plan = await resolvePlan(plan, tmpIn);
    if (!plan) return done('animated', inStat.size);
    tmpOut = path.join(os.tmpdir(), `cfc-out-${rand}${plan.outExt}`);

    const r = await encodeCandidate(plan, tmpIn, tmpOut, rand);
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
    if (!shouldPublish(plan, inStat.size, outStat.size)) return done('no_saving', inStat.size);

    const sameFormat = extOf(key) === plan.outExt;
    const newMime = sameFormat ? String(row.mime) : (MIME_BY_OUT[plan.outExt] || String(row.mime));
    // Every object this pipeline touches is already being served (see the
    // header), so the result ALWAYS lands on a fresh name: rewriting bytes behind
    // a live URL is what swaps a file out from under a reader, and a player
    // reading ranges out of one is only the worst case. The row — and, for
    // stories, the story row — gets the new URL plus a fresh cache-buster, and
    // the old object stays until the orphan sweep's grace period is up.
    const dir = key.slice(0, key.lastIndexOf('/') + 1);
    const newKey = dir + crypto.randomBytes(16).toString('hex') + plan.outExt;
    await replaceBytes(newKey, tmpOut, newMime);
    const newUrl = cacheBust('/uploads/' + newKey);
    for (const rr of rows) {
      const table = tableFor(rr.tbl);
      // A format change carries the rest of the row with it: the MIME, the
      // family (a HEIC filed as a 'file' becomes an 'image' — otherwise the
      // reader still gets a download card for a picture the browser can now
      // show), and the display extension, so a download is not named after a
      // format its bytes are not in. Stories have neither column (filename is
      // read as '' for them), and a same-format rewrite touches none of this.
      const sets = ['size = ?', 'url = ?'];
      const args = [outStat.size, newUrl];
      if (!sameFormat) {
        sets.push('mime = ?'); args.push(newMime);
        const newKind = kindForMime(newMime, rr.kind);
        if (newKind !== rr.kind) { sets.push('kind = ?'); args.push(newKind); }
        const newName = nameWithExt(rr.filename, plan.outExt);
        if (rr.filename && newName !== rr.filename) { sets.push('filename = ?'); args.push(newName); }
      }
      sets.push('compressed = 1');
      try {
        await db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...args, rr.id);
      } catch (e) { warn('row update failed:', String((e && e.message) || e).slice(0, 120)); }
    }
    // Terminal verdicts, both keys: the old one is settled (its bytes are
    // superseded, and the object is left to the orphan sweep) and the new one
    // must never be re-encoded by the sweep.
    await recordKey(key, 'compressed', `${mode}:${plan.pipeline}`, inStat.size, outStat.size);
    await recordKey(newKey, 'compressed', `${mode}:${plan.pipeline}`, outStat.size, outStat.size);
    stats.processed++;
    stats.savedBytes += inStat.size - outStat.size;
    stats.lastJob = { key, group: plan.group, pipeline: plan.pipeline, origSize: inStat.size, newSize: outStat.size, at: now() };
    await logJob({ tbl: row.tbl, url: newUrl, filename: row.filename, kind: plan.group, pipeline: plan.pipeline, result: 'compressed', origSize: inStat.size, newSize: outStat.size });
    log(`${plan.group} ${key}: ${Math.round(inStat.size / 1024)}KB -> ${Math.round(outStat.size / 1024)}KB (${pctMove(inStat.size, outStat.size)})`);
    return { key: newKey, url: newUrl, size: outStat.size, origSize: inStat.size, mime: newMime, group: plan.group, pipeline: plan.pipeline, renamed: newKey !== key };
  } catch (e) {
    const err = String((e && e.message) || e).slice(0, 160);
    stats.errors++;
    stats.lastError = { key, error: err, at: now() };
    warn('job failed, keeping original:', key, err);
    try { await logJob({ tbl: row.tbl, url: row.url, filename: row.filename, kind: (plan && plan.group) || '', pipeline: (plan && plan.pipeline) || '', result: 'error', origSize: row.size || 0, newSize: 0, error: err }); } catch {}
    try { await markRowsDone(rows); } catch {}
    return null;
  } finally {
    for (const f of [tmpIn, tmpOut]) { if (!f) continue; try { await fs.promises.unlink(f); } catch {} }
  }
}

// Compatibility queue: returns 'compressed' | 'skipped' (both mean: never look
// at this row again). It picks up ONLY the types a reader's platform cannot open
// (see COMPATIBILITY_EXTS) — a repair, worth doing seconds after the upload
// lands. Ordinary shrinking of playable media is the scheduled bucket sweep's
// job, so a file the reader was just handed is not rewritten underneath them.
async function processRow(row) {
  const key = cleanKey(row.url);
  if (!key) { stats.skipped++; await markDone(row.tbl, row.id); return 'skipped'; } // remote GIF URL etc.
  const out = await processUpload(key);
  if (!out) { stats.skipped++; return 'skipped'; }
  try {
    const vs = require('./virus-scan');
    // Where a scanner exists the rewritten bytes get a verdict of their own —
    // and that verdict is what re-broadcasts the message now showing them, so
    // the reader learns the new URL. With scanning off there is no verdict to
    // earn (nothing is refused) but the clients still have to learn the new
    // URL, so the change is emitted directly.
    if (vs.scanningEnabled()) vs.queueFileScan(out.key);
    else await vs.emitScanChange(out.key, 'clean');
  } catch {}
  return 'compressed';
}

async function fetchCandidates(limit) {
  // Oldest first so a backlog drains in upload order.
  // Candidates are rows the compressor has not settled; the scan key a virus
  // verdict hangs off is derived from the URL, never the row id. Stories are
  // media too: they live in their own table with their own flag.
  //
  // The compatibility test is the whole point of this queue (see the header):
  // a row is offered here only when planFor would mark it `normalize` — bytes no
  // Apple product can play, or a HEIC no Windows browser can display — because
  // those are broken for a reader rather than merely large. Everything else is
  // left to the scheduled bucket sweep.
  const compat = (alias) => `(${compatWhere(alias)})`;
  return await db.prepare(`
    SELECT a.id, a.url, a.filename, a.mime, a.size, a.kind, a.created_at, 'att' AS tbl FROM attachments a
    WHERE a.compressed = 0 AND a.kind IN ('image','video','audio') AND ${compat('a')}
    UNION ALL
    SELECT d.id, d.url, d.filename, d.mime, d.size, d.kind, d.created_at, 'dm' AS tbl FROM dm_attachments d
    WHERE d.compressed = 0 AND d.kind IN ('image','video','audio') AND ${compat('d')}
    UNION ALL
    SELECT s.id, s.url, '' AS filename, s.mime, s.size, s.kind, s.created_at, 'story' AS tbl FROM stories s
    WHERE s.compressed = 0 AND s.kind IN ('image','video') AND ${compat('s')}
    ORDER BY created_at ASC LIMIT ?`).all(limit);
}

// ---------- everything else: profile media + the bucket sweep ----------
//
// The queue above is flag-driven, so it only ever sees tables that carry a
// `compressed` column (chat attachments, DMs, stories). Profile media —
// avatars, banners, sidebar banners, server icons, custom emoji, webhook
// avatars, the profile-media picker's history — has no flag and is served the
// moment it is uploaded, so it is handled from the other end: find the object,
// find every row that points at it, compress, republish under a new key, and
// repoint those rows. Two triggers:
//   - a profile upload of a COMPATIBILITY type kicks its own key
//     (kickProfileMedia) so a HEIC avatar becomes a picture Windows can show
//     within a second or two — the same repair the queue does for chat, applied
//     to the one upload path that has no row to queue. An ordinary avatar is
//     left to the scheduled pass like any other ordinary media;
//   - a scheduled pass lists the bucket and adopts everything else that is
//     referenced, above the size floor, and absent from the key ledger
//     (reconcileBucket) — the backlog, the ordinary shrinking, and anything a
//     future code path forgets to queue.

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
  const done = async (why, origSize) => {
    const size = Number(origSize) || 0;
    await recordKey(key, 'kept', why || '', size, 0);
    // Visible in the panel like any other terminal verdict (see logJob).
    try {
      await logJob({ tbl: '', url: '/uploads/' + key, filename: key.split('/').pop(), kind: (plan0 && plan0.group) || '', pipeline: (plan0 && plan0.pipeline) || '', result: 'kept', origSize: size, newSize: 0, error: why || '' });
    } catch {}
    return null;
  };
  const plan0 = planFor(storage.mimeForFilename(key), key);
  if (!plan0) return done('no_pipeline');
  let plan = plan0;
  const origSize = Number(opts.size) || (await keySize(key));
  if (!origSize) return done('gone');
  const minSize = MIN_BYTES[plan.group] || MIN_BYTES.image;
  if (origSize < minSize) return done('below_floor', origSize);

  const rand = crypto.randomBytes(8).toString('hex');
  const tmpIn = path.join(os.tmpdir(), `cfs-in-${rand}${extOf(key) || '.bin'}`);
  let tmpOut = null; // minted once a deferred 'still' plan is concrete
  try {
    await downloadToTemp(key, tmpIn);
    const inStat = await fs.promises.stat(tmpIn).catch(() => null);
    if (!inStat || !inStat.size) return done('empty_input', origSize);
    plan = await resolvePlan(plan, tmpIn);
    if (!plan) return done('animated', inStat.size);
    tmpOut = path.join(os.tmpdir(), `cfs-out-${rand}${plan.outExt}`);
    const r = await encodeCandidate(plan, tmpIn, tmpOut, rand);
    if (!r.ok) {
      const err = String(r.error || 'encode_failed').slice(0, 160);
      stats.errors++;
      stats.lastError = { key, error: err, at: now() };
      warn('encode failed, keeping original:', key, err);
      // Deterministic decode/format failure: these bytes will not decode on the
      // next pass either, so record the verdict or the bucket scan re-runs the
      // same doomed encode every single pass (the scan now attempts every media
      // type and every size, so an undecodable object is no longer rare).
      // Everything else — killed for memory, a full disk, a timeout — stays
      // unrecorded on purpose, because a later pass may well succeed.
      return (!r.killed && UNDECODABLE.test(err)) ? done('undecodable', inStat.size) : null;
    }
    const outStat = await fs.promises.stat(tmpOut).catch(() => null);
    if (!outStat || !outStat.size) return done('no_output', inStat.size);
    if (!shouldPublish(plan, inStat.size, outStat.size)) return done('no_saving', inStat.size);

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
    log(`${plan.group} ${key}: ${Math.round(inStat.size / 1024)}KB -> ${Math.round(outStat.size / 1024)}KB (${pctMove(inStat.size, outStat.size)})${refs.length ? ' [' + refs.length + ' ref' + (refs.length === 1 ? '' : 's') + ']' : ''}`);
    return { key: newKey, url: newUrl, size: outStat.size, origSize: inStat.size, group: plan.group, pipeline: plan.pipeline };
  } catch (e) {
    stats.errors++;
    stats.lastError = { key, error: String((e && e.message) || e).slice(0, 160), at: now() };
    warn('standalone job failed, keeping original:', key, String((e && e.message) || e).slice(0, 160));
    return null;
  } finally {
    for (const f of [tmpIn, tmpOut]) { if (!f) continue; try { await fs.promises.unlink(f); } catch {} }
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
    skippedFloor: 0, skippedFresh: 0, deferred: 0, errors: 0, thumbsQueued: 0, ms: 0,
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
        // them (MIME, family and display name included) and re-broadcasts the
        // affected messages. Everything else (profile media) is committed
        // standalone.
        const out = j.refs.some((r) => FLAG_TABLES.has(r.table))
          ? await processUpload(j.key, { any: true })
          : await compressStandalone(j.key, j.refs, { size: j.size });
        if (out) {
          result.compressed++;
          result.jobs++;
          result.savedBytes += Math.max(0, (Number(out.origSize) || 0) - (Number(out.size) || 0));
          // Tell the clients, exactly as the compatibility queue's own path
          // does: the bytes moved to a new URL and the readers still holding the
          // old one must learn it (the old object stays, so nothing breaks in
          // the meantime). Where a scanner exists the new bytes also get a
          // verdict of their own — which is what carries the re-broadcast.
          try {
            const vs = require('./virus-scan');
            if (vs.scanningEnabled()) vs.queueFileScan(out.key);
            else await vs.emitScanChange(out.key, 'clean');
          } catch (e) { warn('re-broadcast failed for ' + out.key + ': ' + String((e && e.message) || e).slice(0, 140)); }
        }
      } catch (e) {
        result.errors++;
        warn('scan failed for ' + j.key + ': ' + String((e && e.message) || e).slice(0, 140));
      }
    }
    result.ms = now() - t0;
    // Preview backlog: QUEUE (never await) the chat images this listing says have
    // no preview yet, so a deploy fills the existing history in without the pass
    // itself parking on dozens of encodes. The worker drains a couple per tick.
    if (THUMB_BACKFILL_MAX && thumbsPossible()) {
      let queued = 0;
      for (const o of stored) {
        if (queued >= THUMB_BACKFILL_MAX) break;
        if (!o.key || !thumbKeyFor(o.key) || !index.keys.has(o.key)) continue;
        if (o.mtime && o.mtime > cutoff) continue; // the on-request path will settle it
        if (thumbHave.has(o.key) || thumbTried.has(o.key) || thumbBacklog.includes(o.key)) continue;
        thumbBacklog.push(o.key);
        queued++;
      }
      result.thumbsQueued = queued;
      if (queued) log(`previews: queued ${queued} chat image(s) for a thumbnail`);
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

// Called after a profile-media upload: settle that key within the second IF it
// is one a reader's platform cannot open (a HEIC from an iPhone, an Opus clip
// used as a profile banner). An ordinary avatar or icon is left to the
// scheduled bucket sweep, like every other ordinary file — nothing rewrites a
// picture the user just uploaded and is looking at.
function kickProfileMedia(key) {
  if (!started || !ENABLED || !ready || !key) return;
  if (!needsCompatibility(key)) return;
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
    thumbQueue: thumbBacklog.length,
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
    // Profile uploads of a type a platform cannot open asked to be settled now
    // (kickProfileMedia): no flag table points at those bytes, so the candidate
    // query can never surface them, and a HEIC avatar has to become a picture
    // Windows can show rather than waiting for the next sweep.
    let kicked = 0;
    while (pendingKeys.length && kicked < 3) {
      const key = pendingKeys.shift();
      kicked++;
      try { await processKeyNow(key); }
      catch (e) { warn('profile key failed (' + key + '): ' + String((e && e.message) || e).slice(0, 140)); }
    }
    // Preview backlog the bucket scan queued (see reconcileBucket): a couple per
    // tick, like a profile key — small, cheap, and the reader is looking at it.
    let minted = 0;
    while (thumbBacklog.length && minted < 2) {
      const key = thumbBacklog.shift();
      minted++;
      try { await ensureThumb(key); }
      catch (e) { warn('preview failed (' + key + '): ' + String((e && e.message) || e).slice(0, 140)); }
    }
    // Skips (tiny/foreign/missing files) are cheap: burn through a few per
    // tick looking for real work, but cap compressions at BATCH.
    const rows = await fetchCandidates(BATCH + 25);
    if (!rows.length) return (pendingKeys.length || thumbBacklog.length) ? 'more' : 'idle';
    // Don't spend an encode on a file the scanner has already condemned: an
    // `infected` row's bytes are deleted, and an `error` row is one the engine
    // could not judge. A `pending` verdict reads as clean (see effectiveStatus
    // in virus-scan.js) — a scan never holds a file back, so it never holds a
    // compression back either. Lookup failures fail open, like everything else
    // on this path.
    let scanMap = null;
    try {
      scanMap = await require('./virus-scan').scanStatusMap(rows.map((r) => cleanKey(r.url)).filter(Boolean));
    } catch { scanMap = null; }
    // Feed up to BATCH rows into this tick, in parallel: the compress semaphore
    // is what limits how many actually encode at once
    // (MEDIA_COMPRESS_CONCURRENCY), so a batch wider than that still settles
    // several files per breather instead of one per tick. Rows that are already
    // in flight are skipped without costing a slot.
    const picked = [];
    for (const row of rows) {
      if (picked.length >= BATCH) break;
      const k = cleanKey(row.url);
      if (k && isCompressing(k)) continue; // already being encoded (another tick, or the bucket sweep)
      if (scanMap && k && (scanMap.get(k) || 'clean') !== 'clean') continue;
      picked.push(row);
    }
    await Promise.all(picked.map(async (row) => {
      try { await processRow(row); }
      catch (e) { warn('row failed:', String((e && e.message) || e).slice(0, 160)); }
    }));
    // Anything left? A cheap 1-row probe decides hot-loop vs idle poll.
    try {
      const rest = await fetchCandidates(1);
      return (rest.length || pendingKeys.length || thumbBacklog.length) ? 'more' : 'idle';
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

// Wake the worker soon (called after an upload lands, and on a clean scan
// verdict). Cheap + debounced by nature: it just pulls the next tick forward,
// and no-ops while a tick is already running. It only ever has the
// compatibility queue to work on — ordinary shrinking waits for the sweep.
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
    concurrency: CONCURRENCY, active, peak, slotMb: SLOT_MB, mem: cgroupMem(),
    ffmpeg: checkFfmpeg(), encoders: { ...probeEncoders() }, minKb: MIN_KB,
    heifConvert: checkHeifConvert(), heifTool: HEIF_CONVERT,
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
  const out = { compressed: 0, errors: 0, kept: 0, savedBytes: 0 };
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
    } else if (r.result === 'kept') {
      // Examined and left exactly as it was (no gain, an animation, a type
      // with no pipeline): the owner's photos are usually here, so it is a
      // headline number rather than a footnote.
      out.kept = Number(r.c) || 0;
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
    log(`worker on: compatibility queue (every ~${Math.round(ACTIVE_MS / 100) / 10}s while it has work, idle poll ${Math.round(EVERY_MS / 1000)}s), ${BATCH}/tick, ${CONCURRENCY} at once (1 thread each)${checkNice() ? ', nice 19' : ''}` +
      (missing.length ? ` (encoders missing, related types skipped: ${missing.join(', ')})` : ' (all encoders present)'));
    log(checkHeifConvert()
      ? `HEIC decoder on: ${HEIF_CONVERT} (libheif) — .heic/.heif uploads are converted to viewable JPEGs`
      : `HEIC decoder OFF: ${HEIF_CONVERT} not on PATH — .heic/.heif uploads cannot be previewed (install libheif-tools)`);
    if (SWEEP_ENABLED) {
      const every = SWEEP_EVERY_MS < 3600000 ? `${Math.round(SWEEP_EVERY_MS / 60000)}min` : `${Math.round(SWEEP_EVERY_MS / 3600000)}h`;
      log(`bucket sweep on: every ${every} (first in ${Math.round(SWEEP_FIRST_MS / 60000)}min), up to ${SWEEP_MAX_JOBS} files/pass, skips anything under ${Math.round(SWEEP_MIN_AGE_MS / 60000)}min old — this is what shrinks ordinary media`);
      scheduleSweep(SWEEP_FIRST_MS);
    } else {
      log('bucket sweep off (MEDIA_BUCKET_SWEEP=0) — only the compatibility queue runs');
    }
    if (!timer) schedule(10000); // first pass after boot settles; kicks pull it forward
  }).catch((e) => warn('migration failed:', String((e && e.message) || e).slice(0, 200)));
}

module.exports = {
  startMediaCompress, tickMediaCompress: tick, kickMediaCompress, ensureColumns, planFor, resolvePlan, probeEncoders, buildArgs, cleanKey,
  MIN_BYTES, MIN_KB, getMediaStats, mediaQueueCounts, mediaTotals, mediaRecentJobs, processUpload,
  isCandidate, COMPATIBILITY_EXTS, needsCompatibility,
  // the one pipeline whose input ffmpeg cannot read (HEIC/HEIF -> JPEG): the
  // decoder probe, the two-step encode, and the "publish even when bigger" rule
  checkHeifConvert, encodeCandidate, shouldPublish, HEIF_EXTS,
  // profile media + the scheduled bucket reconciliation
  kickProfileMedia, kickBucketScan, reconcileBucket, getBucketScanStats, refsForKey, compressStandalone, keySize,
  // derived chat-image previews (thumbs/)
  thumbKeyFor, thumbSourceKey, ensureThumb,
};
