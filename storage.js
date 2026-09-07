// Media storage abstraction: local disk (default) or S3-compatible object
// storage (e.g. Cloudflare R2) when S3_* env vars are set.
//
// URL contract (both backends): uploads are addressed as
//   /uploads/<sub>/<file>?v=<cachekey>
// so switching backends needs no DB or frontend changes — only where the
// bytes live and how /uploads/* is served (see server.js).
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

const BUCKET = process.env.S3_BUCKET || '';
const ENDPOINT = process.env.S3_ENDPOINT || '';
const REGION = process.env.S3_REGION || 'auto';

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

module.exports = { s3Enabled, s3KeyFromUrl, s3Put, s3Get, s3Delete, s3Head, mimeForFilename, S3_BUCKET: BUCKET };
