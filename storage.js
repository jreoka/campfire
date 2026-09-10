// Media storage abstraction: local disk (default) or S3-compatible object
// storage (e.g. Cloudflare R2) when S3_* env vars are set.
//
// URL contract (both backends): uploads are addressed as
//   /uploads/<sub>/<file>?v=<cachekey>
// so switching backends needs no DB or frontend changes — only where the
// bytes live and how /uploads/* is served (see server.js).
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

const BUCKET = process.env.S3_BUCKET || '';
const ENDPOINT = process.env.S3_ENDPOINT || '';
const REGION = process.env.S3_REGION || 'auto';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads');
// Top-level prefix holding database dumps (see backup.js). Never served, never
// swept, and excluded from the media usage numbers the admin panel shows.
const BACKUP_PREFIX = 'backups/';

function s3Enabled() {
  return Boolean(ENDPOINT && BUCKET && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY);
}

let _client = null;
function s3() {
  if (!_client) {
    _client = new S3Client({
      region: REGION,
      endpoint: ENDPOINT,
      forcePathStyle: true, // R2 jurisdiction endpoints are path-style
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY || '',
        secretAccessKey: process.env.S3_SECRET_KEY || '',
      },
    });
  }
  return _client;
}

// '/uploads/avatars/abc123.jpg?v=k9' -> 'avatars/abc123.jpg' (null if invalid)
function s3KeyFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const clean = url.split('?')[0];
  if (!clean.startsWith('/uploads/')) return null;
  const key = clean.slice('/uploads/'.length);
  if (!key || key.includes('..') || key.startsWith('/') || /[\0]/.test(key)) return null;
  if (!/^[A-Za-z0-9._\/-]+$/.test(key)) return null;
  // Internal prefixes are never servable over HTTP (no guessing URLs).
  if (key === 'backups' || key.startsWith('backups/')) return null;
  return key;
}

async function s3Put(key, buffer, contentType) {
  await s3().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  }));
}

async function s3Get(key, range) {
  const cmd = { Bucket: BUCKET, Key: key };
  if (range) cmd.Range = range;
  return s3().send(new GetObjectCommand(cmd));
}

function s3Delete(key) {
  // Fire-and-forget: callers (deleteUploaded) must stay synchronous.
  s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {});
}

async function s3Head(key) {
  return s3().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
}

// List every object under a prefix (paginated). Used by the DB backup
// rotation in backup.js and the orphan sweep in storage-sweep.js. opts.maxPages
// bounds opportunistic listings (the admin panel); omitting it lists everything.
async function s3List(prefix, opts) {
  const maxPages = Math.max(0, Number(opts && opts.maxPages) || 0);
  const out = [];
  let token = undefined;
  let pages = 0;
  do {
    const r = await s3().send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents || []) out.push({ key: o.Key, size: o.Size || 0, modified: o.LastModified || null });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
    pages++;
  } while (token && (!maxPages || pages < maxPages));
  return out;
}

// Awaited single-key delete (s3Delete above stays fire-and-forget for
// request-path callers that must stay synchronous).
async function s3DeleteNow(key) {
  await s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.zip': 'application/zip',
};
function mimeForFilename(name) {
  const ext = String(name || '').toLowerCase().replace(/.*(\.[a-z0-9]+)$/, '$1');
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// ---------- usage stats (admin panel) ----------
// One listing pass aggregated per top-level prefix. Database dumps (backups/)
// are counted separately and never included in the media totals — they are
// infrastructure, and mixing them in makes the storage number meaningless.
// The result is cached briefly: a listing costs a round trip per 1000 objects
// and the panel is opened repeatedly.
const STATS_TTL_MS = 10 * 60 * 1000;
const STATS_MAX_PAGES = 100; // 100k objects: stop and say so rather than hang a request
let statsCache = null;

function emptyAgg() { return { bytes: 0, objects: 0 }; }

async function localTreeUsage(dir) {
  // Same shape as the S3 aggregation so both modes render identically.
  const byPrefix = new Map();
  const all = emptyAgg();
  const backups = emptyAgg();
  const walk = async (d, prefix) => {
    let entries = [];
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { await walk(p, prefix + e.name + '/'); continue; }
      if (!e.isFile()) continue;
      let size = 0;
      try { size = (await fs.promises.stat(p)).size; } catch { continue; }
      if (prefix === BACKUP_PREFIX) { backups.bytes += size; backups.objects++; continue; }
      all.bytes += size; all.objects++;
      let a = byPrefix.get(prefix);
      if (!a) byPrefix.set(prefix, (a = { prefix, bytes: 0, objects: 0 }));
      a.bytes += size; a.objects++;
    }
  };
  await walk(dir, '');
  return { byPrefix, all, backups };
}

async function storageStats(opts) {
  const now = Date.now();
  const refresh = !!(opts && opts.refresh);
  if (!refresh && statsCache && now - statsCache.at < STATS_TTL_MS) {
    return { ...statsCache.data, cached: true, ageMs: now - statsCache.at };
  }
  const t0 = now;
  const s3agg = { total: emptyAgg(), backups: emptyAgg(), byPrefix: new Map(), listed: 0, truncated: false };
  if (s3Enabled()) {
    const objs = await s3List('', { maxPages: STATS_MAX_PAGES });
    s3agg.listed = objs.length;
    s3agg.truncated = objs.length >= STATS_MAX_PAGES * 1000;
    for (const o of objs) {
      const key = String(o.key || '');
      if (!key || key.endsWith('/')) continue;
      const size = Math.max(0, Number(o.size) || 0);
      const i = key.indexOf('/');
      const prefix = i < 0 ? key : key.slice(0, i + 1);
      if (prefix === BACKUP_PREFIX) { s3agg.backups.bytes += size; s3agg.backups.objects++; continue; }
      s3agg.total.bytes += size; s3agg.total.objects++;
      let a = s3agg.byPrefix.get(prefix);
      if (!a) s3agg.byPrefix.set(prefix, (a = { prefix, bytes: 0, objects: 0 }));
      a.bytes += size; a.objects++;
    }
  }
  const local = await localTreeUsage(UPLOAD_DIR);
  const mode = s3Enabled() ? 's3' : 'local';
  const s3Mode = mode === 's3';
  const data = {
    mode,
    // Media only: in S3 mode everything in the bucket except backups/; on
    // local disk everything in the upload dir except a local backups/ tree.
    total: s3Mode ? s3agg.total : local.all,
    prefixes: [...(s3Mode ? s3agg.byPrefix : local.byPrefix).values()].sort((a, b) => b.bytes - a.bytes),
    backups: s3Mode ? s3agg.backups : local.backups,
    // Bytes still sitting on the local volume: the whole media tree in local
    // mode, leftovers from before an S3 migration in S3 mode.
    local: local.all,
    listing: s3Mode ? { objects: s3agg.listed, truncated: s3agg.truncated, ms: Date.now() - t0 } : null,
    computedAt: now,
  };
  statsCache = { at: now, data };
  return { ...data, cached: false, ageMs: 0 };
}

module.exports = { s3Enabled, s3KeyFromUrl, s3Put, s3Get, s3Delete, s3DeleteNow, s3Head, s3List, storageStats, mimeForFilename, BACKUP_PREFIX, UPLOAD_DIR, S3_BUCKET: BUCKET };
