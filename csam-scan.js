// CSAM detection for uploads — hash matching, entirely on this server.
//
// WHAT THIS IS
//   Known-CSAM detection by hash comparison. Every upload is fingerprinted
//   (SHA-256 exact hash + PDQ perceptual hash) and compared against a local
//   blocklist of hashes of material that has already been confirmed illegal
//   by a recognised body. Nothing is ever sent anywhere: matching happens
//   against a hash list on this box, so no image, video or hash of a user's
//   private content leaves the deployment.
//
// WHAT THIS IS NOT
//   It cannot find *new* material — no classifier here guesses whether an
//   image is illegal. Only material already identified and hashed by an
//   authority can be caught. It is a backstop, not a moderation strategy.
//
// YOU NEED A HASH LIST
//   Detection is inert until hashes are loaded (Admin → Safety → Hash list).
//   Known-CSAM hash databases are distributed only to vetted organisations:
//     * NCMEC Hash Sharing      https://report.cybertip.org/hashsharing
//     * Project Arachnid (Shield API + hash list)  https://projectarachnid.ca
//     * IWF (membership)        https://www.iwf.org.uk
//   Apply, then import the list here. Both PDQ and SHA-256/MD5 lists work.
//   Hash *values* are not illegal material, but the lists are confidential —
//   treat them as sensitive and keep them out of the web root (they are:
//   Admin → Safety → Hash list imports into Postgres, never into ./data).
//
// HOW A MATCH IS HANDLED (fail-closed for the account, fail-open for uploads)
//   1. Bytes are MOVED to a quarantine directory that is never served over
//      HTTP. They are preserved, not deleted — US ESPs are required to retain
//      reported material (18 U.S.C. § 2258A(h)); retention is bounded by
//      CSAM_RETENTION_DAYS (default 90).
//   2. The uploader's account is locked pending human review.
//   3. A review row appears in Admin → Safety. An admin can clear it (false
//      positive -> account unlocked, file restored, hash allowlisted so the
//      same image never re-triggers) or confirm it (stays locked).
//   4. Admins are exempt from the automatic lock, so a false positive can
//      never lock every operator out of the instance.
//
// PRIVACY OF THE REVIEW UI
//   Suspected material is never rendered. The review shows the match
//   distance, uploader and context — enough to judge a false positive —
//   and deliberately no preview. Viewing suspected CSAM is itself an offence
//   in most jurisdictions. Set CSAM_REVIEW_PREVIEW=blur only if you
//   understand and accept that exposure.
//
// Env:
//   CSAM_SCAN=0             disable detection entirely (rows record 'clean')
//   CSAM_MATCH_DISTANCE     PDQ Hamming threshold (default 31, PDQ's own
//                           recommendation; lower = fewer false positives)
//   CSAM_QUALITY_FLOOR      discard PDQ hashes below this quality (default 49)
//   CSAM_ACTION             lock     auto-lock uploader pending review (default)
//                           flag     quarantine + review, but do not lock
//   CSAM_ADMIN_EXEMPT=0     allow admins to be auto-locked too (default: exempt)
//   CSAM_QUARANTINE_DIR     where preserved bytes live (default <data>/quarantine)
//   CSAM_RETENTION_DAYS     auto-purge quarantined bytes after N days (default 90, 0=keep)
//   CSAM_VIDEO_FRAMES       video frames sampled per file (default 12, 0=off)
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const db = require('./db');
const storage = require('./storage');
const pdq = require('./pdq');

const now = () => Date.now();
const uid = () => crypto.randomUUID();

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads');
const ENABLED = process.env.CSAM_SCAN !== '0';
const ACTION = (process.env.CSAM_ACTION || 'lock').toLowerCase() === 'flag' ? 'flag' : 'lock';
const ADMIN_EXEMPT = process.env.CSAM_ADMIN_EXEMPT !== '0';
const _dist = parseInt(process.env.CSAM_MATCH_DISTANCE || '', 10);
const MATCH_DISTANCE = Number.isFinite(_dist) ? Math.min(256, Math.max(1, _dist)) : pdq.MATCH_DISTANCE;
const _q = parseInt(process.env.CSAM_QUALITY_FLOOR || '', 10);
const QUALITY_FLOOR = Number.isFinite(_q) ? Math.min(100, Math.max(0, _q)) : pdq.QUALITY_FLOOR;
const _days = parseInt(process.env.CSAM_RETENTION_DAYS || '', 10);
const RETENTION_DAYS = Number.isFinite(_days) ? Math.max(0, _days) : 90;
const _frames = parseInt(process.env.CSAM_VIDEO_FRAMES || '', 10);
const VIDEO_FRAMES = Number.isFinite(_frames) ? Math.min(60, Math.max(0, _frames)) : 12;
const PREVIEW = (process.env.CSAM_REVIEW_PREVIEW || 'off').toLowerCase(); // 'off' | 'blur'

// Decoding guardrails. PDQ wants the image at native resolution (its Jarosz
// pyramid does the downsampling), but a 100MP decode is ~300MB of RGB and
// seconds of JS. Beyond this we let ffmpeg resample first; measured cost of
// doing so is a couple of Hamming bits, far inside the match threshold.
const MAX_DECODE_PIXELS = 16 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 60000;
const JOB_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const IDLE_MS = 10000;
const KICK_MS = 500;
const SLOT_TIMEOUT_MS = 10 * 60 * 1000;
const _conc = parseInt(process.env.CSAM_CONCURRENCY || '2', 10);
const CONCURRENCY = Math.min(4, Math.max(1, Number.isFinite(_conc) ? _conc : 2));

const QUARANTINE_DIR = process.env.CSAM_QUARANTINE_DIR || path.join(path.dirname(UPLOAD_DIR), 'quarantine');

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp|tiff?)$/i;
const VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|mpg|mpeg|3gp)$/i;

const log = (...a) => console.log('[csam]', ...a);
const warn = (...a) => console.warn('[csam]', ...a);

let started = false;
let ready = false;
let active = 0;
let timer = null;
let lastStuckWarn = 0;
let ffmpegMissing = false;
let loggedNoEngine = false;
const claimed = new Set();
const claimAt = new Map();
const hooks = { onMatch: null, onReviewChange: null };
const stats = {
  startedAt: 0, scanned: 0, clean: 0, matched: 0, errors: 0, skipped: 0,
  lastScan: null, lastError: null, lastMatch: null,
};

// ---------------------------------------------------------------- blocklist
// Held in memory for the lifetime of the process: exact hashes in a Set,
// PDQ hashes as flat Uint32Array words so the distance loop stays tight.

const block = {
  sha256: new Set(),
  md5: new Set(),
  pdq: new Uint32Array(0), // 8 words per hash
  // Per-hash metadata as PARALLEL arrays rather than objects: a real hash list
  // is millions of entries, and one object per entry costs hundreds of MB.
  // Values are interned so a homogeneous list shares a couple of strings.
  pdqSource: [],
  pdqLabel: [],
  pdqHex: [], // reference hashes, for reporting which entry matched
  loadedAt: 0,
  counts: { sha256: 0, md5: 0, pdq: 0 },
};
const allow = { sha256: new Set(), md5: new Set(), pdq: new Set(), pdqWords: new Uint32Array(0), counts: { sha256: 0, md5: 0, pdq: 0 } };

// Keys that matched and were quarantined. Kept in memory so the /uploads
// serving gate is an O(1) Set lookup with no DB round-trip per request —
// this gate runs for every avatar, banner, emoji and attachment fetch.
const matchedKeys = new Set();
const isMatched = (key) => matchedKeys.has(key);

async function loadMatchedKeys() {
  try {
    const rows = await db.prepare("SELECT key FROM csam_scans WHERE status = 'match'").all();
    matchedKeys.clear();
    for (const r of rows) if (r.key) matchedKeys.add(r.key);
    if (matchedKeys.size) warn(`${matchedKeys.size} quarantined upload(s) are blocked from serving`);
  } catch (e) {
    warn('matched-key load failed: ' + String((e && e.message) || e).slice(0, 120));
  }
}

// 16-bit popcount table (256 KiB) keeps the Hamming loop branch-light.
const POP16 = new Uint8Array(1 << 16);
for (let i = 0; i < (1 << 16); i++) POP16[i] = (i & 1) + POP16[i >> 1];

// 32 bytes big-endian -> 8 uint32 words (word order matches the hex layout).
function toWords(bytes, out, off) {
  for (let i = 0; i < 8; i++) {
    const b = i * 4;
    out[off + i] = ((bytes[b] << 24) | (bytes[b + 1] << 16) | (bytes[b + 2] << 8) | bytes[b + 3]) >>> 0;
  }
  return out;
}
function wordsOf(bytes) { return toWords(bytes, new Uint32Array(8), 0); }

// Hamming distance with early exit once the running total exceeds `limit`.
// Returns `limit + 1` to mean "further than we care about".
function hammingWordsEarly(q, qOff, b, bOff, limit) {
  let d = 0;
  for (let i = 0; i < 8; i++) {
    const x = q[qOff + i] ^ b[bOff + i];
    d += POP16[x >>> 16] + POP16[x & 0xffff];
    if (d > limit) return limit + 1;
  }
  return d;
}
function hammingWords(q, qOff, b, bOff) {
  let d = 0;
  for (let i = 0; i < 8; i++) {
    const x = q[qOff + i] ^ b[bOff + i];
    d += POP16[x >>> 16] + POP16[x & 0xffff];
  }
  return d;
}

// ---------------------------------------------------------------- tables

let tablesReady = false;
async function ensureTables() {
  if (tablesReady) return;
  // One round-trip, once per process. This sits on the upload hot path
  // (every profile image and every attachment), so re-running seven DDL
  // statements per upload would be pure overhead.
  await db.exec(`
CREATE TABLE IF NOT EXISTS csam_hashlist (
  hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  added_at BIGINT NOT NULL,
  PRIMARY KEY (hash, kind)
);
CREATE INDEX IF NOT EXISTS idx_csam_hashlist_kind ON csam_hashlist(kind);
CREATE TABLE IF NOT EXISTS csam_allowlist (
  hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  added_by TEXT,
  added_at BIGINT NOT NULL,
  PRIMARY KEY (hash, kind)
);
CREATE TABLE IF NOT EXISTS csam_scans (
  key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts BIGINT NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  sha256 TEXT,
  pdq TEXT,
  quality BIGINT,
  match_kind TEXT,
  match_hash TEXT,
  match_distance BIGINT,
  owner_id TEXT,
  context TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  scanned_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_csam_scans_status ON csam_scans(status, created_at);
CREATE TABLE IF NOT EXISTS csam_reviews (
  id TEXT PRIMARY KEY,
  scan_key TEXT,
  user_id TEXT,
  context TEXT NOT NULL DEFAULT '',
  match_kind TEXT NOT NULL DEFAULT '',
  match_hash TEXT NOT NULL DEFAULT '',
  match_distance BIGINT,
  match_label TEXT NOT NULL DEFAULT '',
  match_source TEXT NOT NULL DEFAULT '',
  quality BIGINT,
  sha256 TEXT,
  pdq TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at BIGINT NOT NULL,
  reviewed_at BIGINT,
  reviewed_by TEXT,
  reviewed_by_name TEXT,
  notes TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_csam_reviews_status ON csam_reviews(status, created_at)
`);
  tablesReady = true;
  ready = true;
}

async function loadBlocklist() {
  try {
    await ensureTables();
    const sha = new Set(), md5 = new Set(), allowSha = new Set(), allowMd5 = new Set();
    const pdqRows = [], allowPdqRows = [];
    const pdqSource = [], pdqLabel = [];
    // Intern metadata strings: real lists are homogeneous, so this collapses
    // millions of references onto a handful of actual strings.
    const internPool = new Map();
    const intern = (s) => {
      const t = String(s || '');
      if (!t) return '';
      let v = internPool.get(t);
      if (v === undefined) { v = t; internPool.set(t, v); }
      return v;
    };
    for (const r of await db.prepare('SELECT hash, kind, source, label FROM csam_hashlist').all()) {
      const h = String(r.hash || '').toLowerCase();
      if (r.kind === 'sha256' && /^[0-9a-f]{64}$/.test(h)) sha.add(h);
      else if (r.kind === 'md5' && /^[0-9a-f]{32}$/.test(h)) md5.add(h);
      else if (r.kind === 'pdq' && /^[0-9a-f]{64}$/.test(h)) {
        pdqRows.push(h);
        pdqSource.push(intern(r.source));
        pdqLabel.push(intern(r.label));
      }
    }
    for (const r of await db.prepare('SELECT hash, kind FROM csam_allowlist').all()) {
      const h = String(r.hash || '').toLowerCase();
      if (r.kind === 'sha256' && /^[0-9a-f]{64}$/.test(h)) allowSha.add(h);
      else if (r.kind === 'md5' && /^[0-9a-f]{32}$/.test(h)) allowMd5.add(h);
      else if (r.kind === 'pdq' && /^[0-9a-f]{64}$/.test(h)) allowPdqRows.push(h);
    }

    const words = new Uint32Array(pdqRows.length * 8);
    for (let i = 0; i < pdqRows.length; i++) toWords(pdq.fromHex(pdqRows[i]), words, i * 8);
    const allowWords = new Uint32Array(allowPdqRows.length * 8);
    for (let i = 0; i < allowPdqRows.length; i++) toWords(pdq.fromHex(allowPdqRows[i]), allowWords, i * 8);
    const pdqHex = pdqRows; // kept for reporting the matched reference hash

    block.sha256 = sha;
    block.md5 = md5;
    block.pdq = words;
    block.pdqHex = pdqHex;
    block.pdqSource = pdqSource;
    block.pdqLabel = pdqLabel;
    allow.sha256 = allowSha;
    allow.md5 = allowMd5;
    allow.pdq = new Set(allowPdqRows);
    allow.pdqWords = allowWords;
    block.loadedAt = now();
    block.counts = { sha256: sha.size, md5: md5.size, pdq: pdqRows.length };
    allow.counts = { sha256: allowSha.size, md5: allowMd5.size, pdq: allowPdqRows.length };
    const total = sha.size + md5.size + pdqRows.length;
    if (total) log(`hash list loaded: ${sha.size} sha256, ${md5.size} md5, ${pdqRows.length} pdq (${allow.counts.pdq + allow.counts.sha256} allowlisted)`);
    else warn('no CSAM hash list loaded — detection is INACTIVE (Admin → Safety → Hash list)');
    await loadMatchedKeys();
    return block.counts;
  } catch (e) {
    warn('blocklist load failed: ' + String((e && e.message) || e).slice(0, 160));
    return block.counts;
  }
}

// ---------------------------------------------------------------- hashing

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    // encoding MUST default to 'buffer'. child_process.execFile defaults to
    // 'utf8', which silently UTF-8-decodes stdout: raw RGB frames are not
    // valid UTF-8, so invalid sequences collapse into U+FFFD and the pixel
    // buffer comes back short and corrupt (measured: 686180 "chars" instead of
    // 786432 bytes). Callers that want text (ffprobe) pass encoding:'utf8'.
    execFile(cmd, args, { maxBuffer: 1 << 28, timeout: FFMPEG_TIMEOUT_MS, encoding: 'buffer', ...opts }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr: String(stderr || '').slice(0, 300) }));
      resolve(stdout);
    });
  });
}

async function probe(pathname) {
  const out = String(await execFileP('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', pathname], { encoding: 'utf8' })).trim();
  const [w, h] = out.split('x').map((n) => parseInt(n, 10));
  return { w, h };
}

async function probeDuration(pathname) {
  try {
    const out = String(await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'csv=p=0', pathname], { encoding: 'utf8' })).trim();
    const d = parseFloat(out);
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch { return 0; }
}

// Decode one image and return its PDQ hash plus the 7 dihedral variants.
// Frames are decoded at native resolution (capped) because PDQ's own Jarosz
// pyramid expects to do the downsampling — resampling first costs accuracy.
async function pdqFromImage(pathname) {
  const { w, h } = await probe(pathname);
  if (!w || !h) throw new Error('no_video_dimensions');
  let tw = w, th = h;
  if (w * h > MAX_DECODE_PIXELS) {
    const s = Math.sqrt(MAX_DECODE_PIXELS / (w * h));
    tw = Math.max(2, Math.round((w * s) / 2) * 2);
    th = Math.max(2, Math.round((h * s) / 2) * 2);
  }
  const args = ['-v', 'error', '-i', pathname, '-frames:v', '1'];
  if (tw !== w || th !== h) args.push('-vf', `scale=${tw}:${th}:flags=area`);
  args.push('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
  const rgb = await execFileP('ffmpeg', args);
  if (rgb.length !== tw * th * 3) throw new Error(`decode_size_mismatch ${rgb.length} != ${tw * th * 3}`);
  const r = pdq.hashRgbDihedral(rgb, th, tw);
  return { hash: r.hash, dihedral: r.dihedral, quality: r.quality, w: tw, h: th };
}

// Sample evenly-spaced frames from a video. Seek-based so we decode a handful
// of frames rather than the whole file.
async function pdqFromVideo(pathname) {
  if (!VIDEO_FRAMES) return [];
  const duration = await probeDuration(pathname);
  const dims = await probe(pathname);
  if (!dims.w || !dims.h) return [];
  let w = dims.w, h = dims.h;
  let scale = null;
  if (w * h > MAX_DECODE_PIXELS) {
    const s = Math.sqrt(MAX_DECODE_PIXELS / (w * h));
    w = Math.max(2, Math.round((w * s) / 2) * 2);
    h = Math.max(2, Math.round((h * s) / 2) * 2);
    scale = `scale=${w}:${h}:flags=area`;
  }
  const out = [];
  for (let i = 0; i < VIDEO_FRAMES; i++) {
    const t = duration ? (duration * (i + 0.5)) / VIDEO_FRAMES : 0;
    const args = ['-v', 'error'];
    if (t) args.push('-ss', t.toFixed(3));
    args.push('-i', pathname, '-frames:v', '1');
    if (scale) args.push('-vf', scale);
    args.push('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
    try {
      const rgb = await execFileP('ffmpeg', args);
      if (rgb.length !== w * h * 3) continue;
      const r = pdq.hashRgbDihedral(rgb, h, w);
      if (r.quality >= QUALITY_FLOOR) out.push({ hash: r.hash, dihedral: r.dihedral, quality: r.quality, at: t });
    } catch (e) {
      if (!out.length && i === 0) throw e; // first frame failing means the file is unreadable
      // later frames may legitimately fail (seek past a truncated stream)
    }
  }
  return out;
}

// ---------------------------------------------------------------- matching

// Exact hashes: a hit is certain — SHA-256 collisions are not a practical
// concern, so a match here is never a false positive. Cleared (allowlisted)
// hashes never re-trigger.
function exactMatch(sha256hex, md5hex) {
  if (sha256hex && block.sha256.has(sha256hex) && !allow.sha256.has(sha256hex)) {
    return { kind: 'sha256', hash: sha256hex, distance: 0, label: '', source: '' };
  }
  if (md5hex && block.md5.has(md5hex) && !allow.md5.has(md5hex)) {
    return { kind: 'md5', hash: md5hex, distance: 0, label: '', source: '' };
  }
  return null;
}

// Perceptual match. Any of the 8 dihedral variants of the upload may match.
// The threshold is the honest knob: PDQ's own recommended value (31/256) is
// tuned to catch re-encodes and resizes, which necessarily means near misses
// are possible — hence the human review step.
//
// Returns the matched REFERENCE hash (what the upload matched) and distance.
function perceptualMatch(variants) {
  const n = block.counts.pdq;
  if (!n || !variants.length) return null;
  const words = block.pdq;
  // Allowlisted hashes are pre-expanded into their own array; a query within
  // threshold of one is treated as already cleared.
  const allowN = allow.counts.pdq;
  let best = null;
  for (const v of variants) {
    const q = wordsOf(v);
    for (let i = 0; i < n; i++) {
      const d = hammingWordsEarly(q, 0, words, i * 8, best ? best.distance - 1 : MATCH_DISTANCE);
      if (!best || d < best.distance) {
        if (d > MATCH_DISTANCE) continue;
        let cleared = false;
        for (let a = 0; a < allowN; a++) {
          if (hammingWords(q, 0, allow.pdqWords, a * 8) <= MATCH_DISTANCE) { cleared = true; break; }
        }
        if (cleared) continue;
        best = {
          kind: 'pdq',
          hash: block.pdqHex ? block.pdqHex[i] : pdq.toHex(v),
          queryHash: pdq.toHex(v),
          distance: d,
          label: block.pdqLabel[i] || '',
          source: block.pdqSource[i] || '',
        };
        if (d === 0) return best;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------- audit

// Full fingerprint of a file on disk. Returns everything we persist about it.
async function fingerprintFile(pathname, opts = {}) {
  // One pass over the bytes yields both digests.
  const { sha256, md5 } = await new Promise((resolve, reject) => {
    const hs = crypto.createHash('sha256');
    const hm = crypto.createHash('md5');
    const s = fs.createReadStream(pathname);
    s.on('error', reject);
    s.on('data', (c) => { hs.update(c); hm.update(c); });
    s.on('end', () => resolve({ sha256: hs.digest('hex'), md5: hm.digest('hex') }));
  });

  const out = { sha256, md5, quality: null, variants: [], frames: [] };
  if (ffmpegMissing) return out;

  const ext = path.extname(pathname);
  const asImage = IMAGE_RE.test(ext) || opts.forceImage;
  const asVideo = VIDEO_RE.test(ext) || opts.forceVideo;
  if (asVideo) {
    out.frames = await pdqFromVideo(pathname);
    if (out.frames.length) {
      out.quality = out.frames[0].quality;
      out.variants = [...new Set(out.frames.flatMap((f) => [f.hash, ...f.dihedral]).map(pdq.toHex))];
    }
  } else if (asImage) {
    const r = await pdqFromImage(pathname);
    out.quality = r.quality;
    out.variants = [r.hash, ...r.dihedral].map(pdq.toHex);
  }
  return out;
}

// Decide from a fingerprint. Quality gate: PDQ hashes of flat/featureless
// images are meaningless, so a low-quality image is never matched (this is
// the reference implementation's own guidance).
function classify(fp) {
  const exact = exactMatch(fp.sha256, fp.md5);
  if (exact) return { ...exact, quality: fp.quality };
  const lowQuality = fp.quality === null || fp.quality < QUALITY_FLOOR;
  if (lowQuality || !fp.variants.length) return null;
  const perc = perceptualMatch(fp.variants.map(pdq.fromHex));
  return perc ? { ...perc, quality: fp.quality } : null;
}

// ---------------------------------------------------------------- quarantine

function quarantinePathFor(key) {
  const p = path.join(QUARANTINE_DIR, key);
  // Paranoia: a crafted key must never escape the quarantine root.
  if (!path.resolve(p).startsWith(path.resolve(QUARANTINE_DIR) + path.sep)) return null;
  return p;
}

// The quarantine root must NOT live inside the served upload tree. If it did,
// preserved material would sit under a URL prefix that express.static serves,
// and the only thing stopping it would be the keyed serving gate. Refuse the
// configuration instead. (The gate still blocks serving either way, so this is
// defence in depth, not the sole control.)
let warnedQuarantineConfig = false;
function quarantineDirIsSafe() {
  const q = path.resolve(QUARANTINE_DIR);
  const u = path.resolve(UPLOAD_DIR);
  if (q === u || q.startsWith(u + path.sep)) {
    if (!warnedQuarantineConfig) {
      warnedQuarantineConfig = true;
      warn(`CSAM_QUARANTINE_DIR (${QUARANTINE_DIR}) is inside UPLOAD_DIR (${UPLOAD_DIR}) — refusing to move material there. `
        + 'Matches are still blocked from serving and the account is still locked; set CSAM_QUARANTINE_DIR outside the upload tree.');
    }
    return false;
  }
  return true;
}

async function ensureQuarantineDir() {
  if (!quarantineDirIsSafe()) return false;
  try {
    await fs.promises.mkdir(QUARANTINE_DIR, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(QUARANTINE_DIR, 0o700).catch(() => {});
    return true;
  } catch { return false; }
}

// Move bytes out of the served upload area into quarantine. Preserved for law
// enforcement, never served. Returns the quarantine location or null.
async function quarantineBytes(key) {
  if (!(await ensureQuarantineDir())) return null;
  const dest = quarantinePathFor(key);
  if (!dest) return null;
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });

  if (storage.s3Enabled()) {
    try {
      const data = await storage.s3Get(key);
      const chunks = [];
      for await (const c of data.Body) chunks.push(c);
      const buf = Buffer.concat(chunks);
      await storage.s3Put('quarantine/' + key, buf, 'application/octet-stream');
      await storage.s3DeleteNow(key).catch(() => {});
      await fs.promises.writeFile(dest, buf, { mode: 0o600 }).catch(() => {});
      return { where: 's3:quarantine/' + key, local: true };
    } catch (e) {
      warn('s3 quarantine failed for ' + key + ': ' + String((e && e.message) || e).slice(0, 120));
      return null;
    }
  }
  const src = path.join(UPLOAD_DIR, key);
  if (!path.resolve(src).startsWith(path.resolve(UPLOAD_DIR) + path.sep)) return null;
  try {
    await fs.promises.rename(src, dest); // same volume: atomic, no window
  } catch (e) {
    if (e && e.code === 'ENOENT') return null; // already gone
    try {
      await fs.promises.copyFile(src, dest);
      await fs.promises.unlink(src);
    } catch (e2) {
      warn('quarantine failed for ' + key + ': ' + String((e2 && e2.message) || e2).slice(0, 120));
      return null;
    }
  }
  await fs.promises.chmod(dest, 0o600).catch(() => {});
  return { where: 'disk:' + dest, local: true };
}

// Put bytes back (used when an admin clears a false positive).
async function restoreBytes(key) {
  const src = quarantinePathFor(key);
  if (!src) return false;
  let exists = false;
  try { await fs.promises.access(src); exists = true; } catch {}
  if (!exists) return false;
  if (storage.s3Enabled()) {
    try {
      const buf = await fs.promises.readFile(src);
      await storage.s3Put(key, buf, storage.mimeForFilename(key));
      await fs.promises.unlink(src).catch(() => {});
      return true;
    } catch { return false; }
  }
  const dest = path.join(UPLOAD_DIR, key);
  if (!path.resolve(dest).startsWith(path.resolve(UPLOAD_DIR) + path.sep)) return false;
  try {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.rename(src, dest);
    return true;
  } catch { try { await fs.promises.copyFile(src, dest); await fs.promises.unlink(src); return true; } catch { return false; } }
}

async function purgeQuarantined(key) {
  const p = quarantinePathFor(key);
  if (p) await fs.promises.unlink(p).catch(() => {});
  if (storage.s3Enabled()) await storage.s3DeleteNow('quarantine/' + key).catch(() => {});
}

// ---------------------------------------------------------------- account lock

async function lockAccount(userId, reason) {
  if (!userId) return false;
  try {
    const u = await db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(userId);
    if (!u) return false;
    if (ADMIN_EXEMPT && u.is_admin) {
      log(`not locking admin ${userId} (CSAM_ADMIN_EXEMPT) — review raised instead`);
      return false;
    }
    await db.prepare('UPDATE users SET locked_at = ?, lock_reason = ? WHERE id = ?')
      .run(now(), String(reason || 'pending_review').slice(0, 200), userId);
    return true;
  } catch (e) {
    warn('lock failed for ' + userId + ': ' + String((e && e.message) || e).slice(0, 120));
    return false;
  }
}

async function unlockAccount(userId) {
  if (!userId) return;
  try { await db.prepare('UPDATE users SET locked_at = NULL, lock_reason = NULL WHERE id = ?').run(userId); } catch {}
}

// ---------------------------------------------------------------- intake

// Record an upload for scanning. Mirrors virus-scan.queueFileScan: a DB hiccup
// must never wedge the upload, so failures fail open with a loud log.
async function queueHashScan(key, meta = {}) {
  if (!key || !ENABLED) return 'clean';
  try { await ensureTables(); } catch {}
  try {
    await db.prepare(`INSERT INTO csam_scans (key,status,attempts,error,created_at,owner_id,context)
      VALUES (?,'pending',0,'',?,?,?) ON CONFLICT(key) DO UPDATE SET
      status = CASE WHEN csam_scans.status = 'match' THEN 'match' ELSE 'pending' END,
      attempts = 0, error = '', scanned_at = NULL,
      owner_id = COALESCE(excluded.owner_id, csam_scans.owner_id),
      context = CASE WHEN excluded.context <> '' THEN excluded.context ELSE csam_scans.context END`)
      .run(key, now(), meta.userId || null, String(meta.context || '').slice(0, 80));
  } catch (e) {
    warn('queue failed for ' + key + ': ' + String((e && e.message) || e).slice(0, 120));
    return 'clean';
  }
  kickCsamScan();
  return 'pending';
}

// Synchronous scan used by profile/banner/emoji/icon uploads, where the URL
// goes live immediately. Chat attachments use the async queue + serving gate
// instead, because they can be 100MB of video.
async function scanUploadedNow(key, meta = {}) {
  if (!key || !ENABLED) return { status: 'clean' };
  try { await ensureTables(); } catch {}
  const tmp = await materialise(key);
  if (!tmp) return { status: 'clean' };
  try {
    const fp = await fingerprintFile(tmp.path, tmp.opts);
    const hit = classify(fp);
    await recordScan(key, fp, hit, meta);
    if (hit) await handleMatch(key, hit, meta, fp);
    return hit ? { status: 'match', match: publicMatch(hit) } : { status: 'clean' };
  } catch (e) {
    warn('inline scan failed for ' + key + ': ' + String((e && e.message) || e).slice(0, 160));
    return { status: 'clean' }; // fail open: never block uploads on scanner bugs
  } finally {
    await tmp.cleanup();
  }
}

function publicMatch(hit) {
  return { kind: hit.kind, distance: hit.distance, label: hit.label || '', source: hit.source || '' };
}

// Bring bytes to a local path for hashing (ffmpeg needs a seekable file).
async function materialise(key) {
  const cleanup = [];
  // Prefer the on-disk copy — it's free.
  const direct = path.join(UPLOAD_DIR, key);
  if (path.resolve(direct).startsWith(path.resolve(UPLOAD_DIR) + path.sep)) {
    try {
      const st = await fs.promises.stat(direct);
      if (st.isFile()) return { path: direct, opts: {}, cleanup: async () => {} };
    } catch {}
  }
  if (!storage.s3Enabled()) return null;
  let data;
  try { data = await storage.s3Get(key); } catch { return null; }
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'csam-'));
  const tmp = path.join(dir, 'blob' + path.extname(key).toLowerCase());
  const out = fs.createWriteStream(tmp);
  await new Promise((resolve, reject) => {
    data.Body.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    data.Body.pipe(out);
  });
  cleanup.push(() => fs.promises.rm(dir, { recursive: true, force: true }));
  return { path: tmp, opts: {}, cleanup: async () => { for (const c of cleanup) await c().catch(() => {}); } };
}

async function recordScan(key, fp, hit, meta) {
  try {
    await db.prepare(`UPDATE csam_scans SET status = ?, attempts = attempts + 1, error = '',
      sha256 = ?, pdq = ?, quality = ?, match_kind = ?, match_hash = ?, match_distance = ?,
      scanned_at = ?, owner_id = COALESCE(?, owner_id), context = CASE WHEN ? <> '' THEN ? ELSE context END
      WHERE key = ?`)
      .run(hit ? 'match' : 'clean', fp.sha256, JSON.stringify(fp.variants.slice(0, 40)), fp.quality,
        hit ? hit.kind : null, hit ? hit.hash : null, hit ? hit.distance : null, now(),
        meta.userId || null, String(meta.context || ''), String(meta.context || ''), key);
  } catch (e) {
    warn('recordScan failed for ' + key + ': ' + String((e && e.message) || e).slice(0, 120));
  }
}

// The whole consequence chain for a positive match.
async function handleMatch(key, hit, meta, fp) {
  const userId = meta.userId || null;
  const context = String(meta.context || '').slice(0, 80);
  const quarantined = await quarantineBytes(key);
  matchedKeys.add(key);

  let reviewId = null;
  try {
    // One open review per (user, matched hash): a user re-uploading the same
    // file must not spawn a pile of duplicate rows.
    const existing = await db.prepare(
      "SELECT id FROM csam_reviews WHERE status = 'open' AND match_hash = ? AND match_kind = ? AND COALESCE(user_id,'') = COALESCE(?,'') LIMIT 1"
    ).get(hit.hash, hit.kind, userId);
    if (existing) {
      reviewId = existing.id;
    } else {
      reviewId = uid();
      await db.prepare(`INSERT INTO csam_reviews
        (id,scan_key,user_id,context,match_kind,match_hash,match_distance,match_label,match_source,
         quality,sha256,pdq,status,created_at,notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'open',?,'')`)
        .run(reviewId, key, userId, context, hit.kind, hit.hash, hit.distance,
          String(hit.label || '').slice(0, 120), String(hit.source || '').slice(0, 120),
          fp.quality, fp.sha256, JSON.stringify(fp.variants.slice(0, 40)), now());
    }
  } catch (e) {
    warn('review insert failed: ' + String((e && e.message) || e).slice(0, 160));
  }

  let locked = false;
  if (ACTION === 'lock') locked = await lockAccount(userId, `csam_review:${reviewId || 'unknown'}`);

  stats.matched++;
  stats.lastMatch = { key, kind: hit.kind, distance: hit.distance, userId, at: now() };
  warn(`MATCH kind=${hit.kind} distance=${hit.distance} key=${key} user=${userId || '?'} ` +
    `quarantined=${quarantined ? 'yes' : 'no'} locked=${locked ? 'yes' : 'no'} review=${reviewId || '?'}`);

  if (hooks.onMatch) {
    try { await hooks.onMatch({ key, hit: publicMatch(hit), userId, context, reviewId, locked, quarantined: !!quarantined }); }
    catch (e) { warn('onMatch hook failed: ' + String((e && e.message) || e).slice(0, 160)); }
  }
}

// ---------------------------------------------------------------- worker

async function markAttempt(key, error) {
  try { await db.prepare('UPDATE csam_scans SET attempts = attempts + 1, error = ? WHERE key = ?').run(String(error || '').slice(0, 200), key); } catch {}
}

async function processRow(row) {
  try {
    if (!block.counts.sha256 && !block.counts.md5 && !block.counts.pdq) {
      // No list loaded: nothing can match. Record clean so the serving gate
      // doesn't hold every upload hostage while the operator is onboarding.
      await db.prepare("UPDATE csam_scans SET status='clean', attempts=attempts+1, scanned_at=? WHERE key=?").run(now(), row.key);
      stats.skipped++;
      return 'done';
    }
    const tmp = await materialise(row.key);
    if (!tmp) {
      try { await db.prepare('DELETE FROM csam_scans WHERE key = ?').run(row.key); } catch {}
      return 'done';
    }
    try {
      const fp = await fingerprintFile(tmp.path, tmp.opts);
      const hit = classify(fp);
      stats.scanned++;
      if (hit) {
        await recordScan(row.key, fp, hit, { userId: row.owner_id, context: row.context });
        await handleMatch(row.key, hit, { userId: row.owner_id, context: row.context }, fp);
      } else {
        await recordScan(row.key, fp, null, { userId: row.owner_id, context: row.context });
        stats.clean++;
        stats.lastScan = { key: row.key, result: 'clean', quality: fp.quality, at: now() };
      }
      return 'done';
    } finally {
      await tmp.cleanup();
    }
  } catch (e) {
    const err = String((e && e.message) || e).slice(0, 160);
    stats.errors++;
    stats.lastError = { key: row.key, error: err, at: now() };
    warn('scan failed for ' + row.key + ': ' + err);
    if ((Number(row.attempts) || 0) + 1 >= MAX_ATTEMPTS) {
      try { await db.prepare("UPDATE csam_scans SET status='error', attempts=attempts+1, error=?, scanned_at=? WHERE key=?").run(err, now(), row.key); } catch {}
      if (hooks.onReviewChange) { try { await hooks.onReviewChange(); } catch {} }
    } else {
      await markAttempt(row.key, err);
    }
    return 'done';
  } finally {
    claimed.delete(row.key);
    claimAt.delete(row.key);
  }
}

async function claimRow() {
  let rows = [];
  try {
    rows = await db.prepare("SELECT key, attempts, owner_id, context FROM csam_scans WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?")
      .all(CONCURRENCY + active + 1);
  } catch (e) {
    warn('queue read failed: ' + String((e && e.message) || e).slice(0, 160));
    return null;
  }
  for (const r of rows) {
    if (r && r.key && !claimed.has(r.key)) { claimed.add(r.key); claimAt.set(r.key, now()); return r; }
  }
  return null;
}

async function tick() {
  if (!ENABLED || !ready) return 'deferred';
  if (active >= CONCURRENCY) return 'busy';
  const row = await claimRow();
  if (!row) return 'idle';
  active++;
  processRow(row).then(
    () => schedule(300),
    (e) => { warn('slot failed: ' + String((e && e.message) || e).slice(0, 160)); schedule(1000); }
  ).finally(() => { active--; });
  return 'more';
}

async function reapStuckClaims() {
  const cutoff = now() - SLOT_TIMEOUT_MS;
  for (const [key, at] of claimAt) {
    if (at > cutoff) continue;
    claimAt.delete(key);
    claimed.delete(key);
    warn('slot watchdog: released stuck claim on ' + key);
    await markAttempt(key, 'stuck');
  }
}

function schedule(ms) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(loop, ms);
  try { timer.unref(); } catch {}
}

async function loop() {
  timer = null;
  let st = 'idle';
  try {
    await reapStuckClaims().catch(() => {});
    for (let i = 0; i < CONCURRENCY; i++) {
      st = await tick();
      if (st !== 'more') break;
    }
    if (st !== 'more' && active === 0 && now() - lastStuckWarn > 60000) {
      const r = await db.prepare("SELECT COUNT(*) c FROM csam_scans WHERE status='pending'").get().catch(() => null);
      if (r && Number(r.c) > 0) {
        lastStuckWarn = now();
        warn(`stalled? pending=${r.c} ready=${ready} active=${active} claimed=${claimed.size}`);
      }
    }
  } catch (e) {
    warn('tick failed: ' + String((e && e.message) || e).slice(0, 200));
    st = 'idle';
  }
  schedule(st === 'more' ? 300 : st === 'busy' || st === 'deferred' ? 5000 : IDLE_MS);
}

function kickCsamScan() {
  if (!started || !ENABLED || !ready) return;
  schedule(KICK_MS);
}

// Retention: quarantined material is preserved for a bounded window, then
// purged. Keeps the deployment from accumulating illegal material forever.
async function purgeExpiredQuarantine() {
  if (!RETENTION_DAYS) return 0;
  const cutoff = now() - RETENTION_DAYS * 86400000;
  let purged = 0;
  try {
    const rows = await db.prepare(
      "SELECT scan_key FROM csam_reviews WHERE status <> 'cleared' AND created_at < ? AND scan_key IS NOT NULL"
    ).all(cutoff);
    for (const r of rows) { await purgeQuarantined(r.scan_key); purged++; }
    if (purged) log(`retention: purged ${purged} quarantined file(s) older than ${RETENTION_DAYS}d`);
  } catch (e) {
    warn('retention sweep failed: ' + String((e && e.message) || e).slice(0, 160));
  }
  return purged;
}

// ---------------------------------------------------------------- review API helpers

async function clearReview(id, adminId, adminName, notes) {
  const r = await db.prepare('SELECT * FROM csam_reviews WHERE id = ?').get(id);
  if (!r) return null;
  // Allowlist the UPLOAD's own fingerprints, not the reference it hit. The
  // admin cleared one specific image; a different image that merely resembles
  // the same reference should still be reviewed. For PDQ that means every
  // dihedral variant, so re-uploading the same picture rotated also passes.
  const allowRows = [];
  if (r.match_kind === 'pdq') {
    let variants = [];
    try { variants = JSON.parse(r.pdq || '[]'); } catch {}
    for (const v of variants) if (/^[0-9a-f]{64}$/.test(v)) allowRows.push({ hash: v, kind: 'pdq' });
  } else if (r.sha256) {
    allowRows.push({ hash: r.sha256, kind: 'sha256' });
  }
  if (!allowRows.length && r.match_hash) allowRows.push({ hash: r.match_hash, kind: r.match_kind });
  const reason = String(notes || 'cleared as false positive').slice(0, 200);
  for (const a of allowRows) {
    try {
      await db.prepare('INSERT INTO csam_allowlist (hash,kind,reason,added_by,added_at) VALUES (?,?,?,?,?) ON CONFLICT (hash,kind) DO NOTHING')
        .run(a.hash, a.kind, reason, adminId, now());
    } catch (e) { warn('allowlist insert failed: ' + String((e && e.message) || e).slice(0, 120)); }
  }
  await restoreBytes(r.scan_key);
  matchedKeys.delete(r.scan_key);
  try { await db.prepare("UPDATE csam_scans SET status='clean' WHERE key = ?").run(r.scan_key); } catch {}
  await unlockAccount(r.user_id);
  await db.prepare(`UPDATE csam_reviews SET status='cleared', reviewed_at=?, reviewed_by=?, reviewed_by_name=?, notes=? WHERE id=?`)
    .run(now(), adminId, adminName || '', String(notes || '').slice(0, 1000), id);
  await loadBlocklist();
  if (hooks.onReviewChange) { try { await hooks.onReviewChange(); } catch {} }
  return { ...r, status: 'cleared' };
}

async function confirmReview(id, adminId, adminName, notes, ban) {
  const r = await db.prepare('SELECT * FROM csam_reviews WHERE id = ?').get(id);
  if (!r) return null;
  await db.prepare(`UPDATE csam_reviews SET status='confirmed', reviewed_at=?, reviewed_by=?, reviewed_by_name=?, notes=? WHERE id=?`)
    .run(now(), adminId, adminName || '', String(notes || '').slice(0, 1000), id);
  // Bytes stay quarantined (evidence). The account stays locked; a confirmed
  // review with `ban` additionally disables it outright.
  if (r.user_id) {
    if (ban) {
      try { await db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(r.user_id); } catch {}
      try { await db.prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ?').run(r.user_id); } catch {}
    }
    await lockAccount(r.user_id, `csam_confirmed:${id}`);
  }
  if (hooks.onReviewChange) { try { await hooks.onReviewChange(); } catch {} }
  return { ...r, status: 'confirmed' };
}

async function reopenReview(id, adminId, adminName) {
  const r = await db.prepare('SELECT * FROM csam_reviews WHERE id = ?').get(id);
  if (!r) return null;
  await db.prepare(`UPDATE csam_reviews SET status='open', reviewed_at=?, reviewed_by=?, reviewed_by_name=? WHERE id=?`)
    .run(now(), adminId, adminName || '', id);
  return { ...r, status: 'open' };
}

// ---------------------------------------------------------------- import / status

// Parse an arbitrary hash-list file into {kind, hash} rows.
//
// Deliberately permissive, because hash lists arrive in several shapes and an
// operator importing a confidential list should not have to hand-convert it:
//   * CSV/TSV with a header — `hashType,hashValue` (NCMEC), `kind,hash`, or a
//     column literally named pdq/sha256/md5
//   * CSV/TSV without a header — any column that looks like a hash
//   * one hash per line, hex or base64
//   * `kind:hash` / `kind=hash` tagged lines
//   * `#` comments and blank lines
//
// Supported kinds: pdq, sha256, md5. SHA-1 and PhotoDNA are recognised so we
// can skip them loudly rather than silently mis-tagging them as something else.
const KIND_ALIASES = {
  md5: 'md5', md5hash: 'md5',
  sha256: 'sha256', sha256hash: 'sha256',
  pdq: 'pdq', pdqhash: 'pdq',
  sha1: null, sha1hash: null, photodna: null, // recognised but unsupported
};
const KIND_COL_NAMES = new Set(['kind', 'type', 'hashtype', 'hashtypeid', 'algorithm', 'algo']);
const HASH_COL_NAMES = new Set(['hash', 'value', 'hashvalue', 'indicator', 'indicatorvalue', 'hashvalueid']);

function normCol(c) {
  return String(c || '').trim().toLowerCase().replace(/[\s_-]/g, '');
}

// 32 bytes -> 64 hex chars; accepts hex or base64 (Shield/Arachnid style).
function asHash256(cell) {
  const s = String(cell || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  if (/^[A-Za-z0-9+/]{43}=?$/.test(s)) {
    try {
      const b = Buffer.from(s, 'base64');
      if (b.length === 32) return b.toString('hex');
    } catch {}
  }
  return null;
}

function asMd5(cell) {
  const s = String(cell || '').trim();
  return /^[0-9a-fA-F]{32}$/.test(s) ? s.toLowerCase() : null;
}

// A cell that is unambiguously hash data (used to tell headers from rows).
function looksLikeHash(cell) {
  return Boolean(asMd5(cell) || asHash256(cell));
}

function parseHashList(text, defaultKind) {
  const out = [];
  const seen = new Set();
  const skippedKinds = new Set();

  const push = (kindToken, cell, colKind) => {
    // Resolve the intended type: explicit column kind, then the kind cell, then
    // the caller's default. `undefined`/`null` kindToken means "no type stated".
    let kind = colKind || null;
    if (!kind && kindToken !== null && kindToken !== undefined) {
      const t = normCol(kindToken);
      if (!t) { /* empty cell: fall through to the default */ }
      else if (t in KIND_ALIASES) {
        if (KIND_ALIASES[t] === null) { skippedKinds.add(t); return; } // sha1/photodna
        kind = KIND_ALIASES[t];
      } else return; // unrecognised type label: never guess
    }

    const md5 = asMd5(cell);
    if (md5) {
      // 32 hex chars can only be MD5.
      if (kind && kind !== 'md5') return;
      const key = 'md5:' + md5;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ kind: 'md5', hash: md5 });
      return;
    }

    const h = asHash256(cell);
    if (!h) return;
    // 64 hex chars are ambiguous between PDQ and SHA-256, so a kind is
    // required — guessing would silently compare the wrong algorithm.
    kind = kind || defaultKind || null;
    if (kind !== 'sha256' && kind !== 'pdq') return;
    const key = kind + ':' + h;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, hash: h });
  };

  const lines = String(text || '').split(/\r?\n/);
  let spec = null; // header -> per-column instruction

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.includes(',') || line.includes('\t')) {
      const cols = line.split(/\t|,/).map((c) => c.trim().replace(/^"|"$/g, ''));
      // Header detection: recognised column names and NO cell that is hash data.
      if (!spec) {
        const names = cols.map(normCol);
        const recognised = names.filter((n) => KIND_COL_NAMES.has(n) || HASH_COL_NAMES.has(n) || (n in KIND_ALIASES)).length;
        if (recognised > 0 && !cols.some(looksLikeHash)) {
          spec = cols.map((_, i) => {
            const n = names[i];
            if (n in KIND_ALIASES) return { colKind: KIND_ALIASES[n], readsKind: false };
            if (KIND_COL_NAMES.has(n)) return { colKind: null, readsKind: true };
            if (HASH_COL_NAMES.has(n)) return { colKind: null, readsKind: false, generic: true };
            return null;
          });
          continue;
        }
      }
      if (spec) {
        // Find the kind column (if any) so it can inform the hash column.
        let kindToken;
        for (let i = 0; i < spec.length; i++) {
          if (spec[i] && spec[i].readsKind) { kindToken = cols[i]; break; }
        }
        for (let i = 0; i < spec.length; i++) {
          const s = spec[i];
          if (!s || s.readsKind) continue;
          push(kindToken, cols[i], s.colKind);
        }
        continue;
      }
      // No header: take any column that looks like a hash.
      for (const c of cols) push(null, c, null);
      continue;
    }

    // `pdq:deadbeef…` / `sha256=deadbeef…` or a bare hash.
    const tagged = line.match(/^([A-Za-z0-9_-]+)\s*[:=]\s*(\S+)$/);
    if (tagged && normCol(tagged[1]) in KIND_ALIASES) push(tagged[1], tagged[2], null);
    else push(null, line, null);
  }

  if (skippedKinds.size) {
    warn(`hash list contained unsupported types (${[...skippedKinds].join(', ')}) — those entries were skipped`);
  }
  return out;
}

async function importHashes(rows, source, replaceKinds) {
  await ensureTables();
  const kinds = [...new Set(rows.map((r) => r.kind))];
  if (replaceKinds && kinds.length) {
    for (const k of kinds) await db.prepare('DELETE FROM csam_hashlist WHERE kind = ?').run(k);
  }
  let added = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const values = [], params = [];
    for (const r of slice) {
      values.push('(?,?,?,?,?)');
      params.push(r.hash, r.kind, source || '', r.label || '', now());
    }
    try {
      await db.prepare(`INSERT INTO csam_hashlist (hash,kind,source,label,added_at) VALUES ${values.join(',')} ON CONFLICT (hash,kind) DO NOTHING`)
        .run(...params);
      added += slice.length;
    } catch (e) {
      warn('import chunk failed: ' + String((e && e.message) || e).slice(0, 160));
    }
  }
  await loadBlocklist();
  return { added, counts: block.counts };
}

async function getSafetyStats() {
  const counts = { pending: 0, clean: 0, match: 0, error: 0 };
  let reviews = { open: 0, cleared: 0, confirmed: 0 };
  let lockedUsers = 0;
  try {
    for (const r of await db.prepare('SELECT status, COUNT(*) c FROM csam_scans GROUP BY status').all()) {
      if (counts[r.status] !== undefined) counts[r.status] = Number(r.c) || 0;
    }
    for (const r of await db.prepare('SELECT status, COUNT(*) c FROM csam_reviews GROUP BY status').all()) {
      if (reviews[r.status] !== undefined) reviews[r.status] = Number(r.c) || 0;
    }
    const lu = await db.prepare('SELECT COUNT(*) c FROM users WHERE locked_at IS NOT NULL').get();
    lockedUsers = Number(lu && lu.c) || 0;
  } catch {}
  let quarantineFiles = 0;
  try {
    const walk = async (dir) => {
      let n = 0;
      const ents = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of ents) {
        if (e.isDirectory()) n += await walk(path.join(dir, e.name));
        else n++;
      }
      return n;
    };
    quarantineFiles = await walk(QUARANTINE_DIR);
  } catch {}
  return {
    enabled: ENABLED,
    action: ACTION,
    adminExempt: ADMIN_EXEMPT,
    matchDistance: MATCH_DISTANCE,
    qualityFloor: QUALITY_FLOOR,
    retentionDays: RETENTION_DAYS,
    preview: PREVIEW,
    ffmpeg: !ffmpegMissing,
    hasList: Boolean(block.counts.sha256 || block.counts.md5 || block.counts.pdq),
    listCounts: block.counts,
    allowCounts: allow.counts,
    loadedAt: block.loadedAt,
    counts, reviews, lockedUsers, quarantineFiles,
    concurrency: CONCURRENCY, active, queued: claimed.size,
    startedAt: stats.startedAt, scanned: stats.scanned, clean: stats.clean,
    matched: stats.matched, errors: stats.errors, skipped: stats.skipped,
    lastScan: stats.lastScan, lastMatch: stats.lastMatch, lastError: stats.lastError,
  };
}

async function listReviews(status, limit, offset) {
  // NOTE: `status` must be qualified — users also has a `status` column
  // (presence) and the join makes a bare reference ambiguous.
  const cond = status && status !== 'all' ? 'WHERE r.status = ?' : '';
  const params = status && status !== 'all' ? [status] : [];
  const rows = await db.prepare(
    `SELECT r.*, u.username, u.display_name, u.avatar_color, u.is_admin
     FROM csam_reviews r LEFT JOIN users u ON u.id = r.user_id
     ${cond} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, Math.min(100, Math.max(1, limit || 25)), Math.max(0, offset || 0));
  return rows.map((r) => ({
    id: r.id,
    scanKey: r.scan_key,
    userId: r.user_id,
    username: r.username || null,
    displayName: r.display_name || null,
    avatarColor: r.avatar_color || null,
    isAdmin: !!r.is_admin,
    context: r.context,
    matchKind: r.match_kind,
    matchHash: r.match_hash,
    matchDistance: r.match_distance === null || r.match_distance === undefined ? null : Number(r.match_distance),
    matchLabel: r.match_label,
    matchSource: r.match_source,
    quality: r.quality === null || r.quality === undefined ? null : Number(r.quality),
    sha256: r.sha256,
    status: r.status,
    createdAt: Number(r.created_at),
    reviewedAt: r.reviewed_at ? Number(r.reviewed_at) : null,
    reviewedByName: r.reviewed_by_name || null,
    notes: r.notes,
  }));
}

async function reviewCounts() {
  const out = { open: 0, cleared: 0, confirmed: 0 };
  try {
    for (const r of await db.prepare('SELECT status, COUNT(*) c FROM csam_reviews GROUP BY status').all()) {
      if (out[r.status] !== undefined) out[r.status] = Number(r.c) || 0;
    }
  } catch {}
  return out;
}

// ---------------------------------------------------------------- lifecycle

function startCsamScan() {
  if (started) return;
  started = true;
  if (!ENABLED) { log('disabled (CSAM_SCAN=0) — uploads recorded clean'); return; }
  ensureTables().then(async () => {
    stats.startedAt = now();
    // ffmpeg is required for perceptual hashing; without it only exact
    // SHA-256/MD5 matching works, which is still useful.
    try { await execFileP('ffmpeg', ['-version']); }
    catch { ffmpegMissing = true; }
    if (ffmpegMissing && !loggedNoEngine) {
      loggedNoEngine = true;
      warn('ffmpeg not found — perceptual (PDQ) matching DISABLED; exact SHA-256/MD5 matching still active');
    }
    await loadBlocklist();
    schedule(2000);
    const t = setInterval(() => { purgeExpiredQuarantine().catch(() => {}); }, 6 * 3600 * 1000);
    try { t.unref(); } catch {}
    purgeExpiredQuarantine().catch(() => {});
  }).catch((e) => warn('startup failed: ' + String((e && e.message) || e).slice(0, 200)));
}

module.exports = {
  startCsamScan, kickCsamScan, queueHashScan, scanUploadedNow,
  loadBlocklist, importHashes, parseHashList,
  getSafetyStats, listReviews, reviewCounts,
  clearReview, confirmReview, reopenReview,
  purgeQuarantined, restoreBytes, unlockAccount, lockAccount,
  isMatched,
  get matchedCount() { return matchedKeys.size; },
  setCsamHooks: (h) => {
    if (h && typeof h.onMatch === 'function') hooks.onMatch = h.onMatch;
    if (h && typeof h.onReviewChange === 'function') hooks.onReviewChange = h.onReviewChange;
  },
  quarantinePathFor, _fingerprintFile: fingerprintFile, _classify: classify,
  _block: block, _config: { ENABLED, ACTION, ADMIN_EXEMPT, MATCH_DISTANCE, QUALITY_FLOOR, VIDEO_FRAMES, QUARANTINE_DIR, RETENTION_DAYS, PREVIEW },
};
