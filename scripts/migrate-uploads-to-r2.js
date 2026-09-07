// Moves local uploads (/uploads/** on disk) into S3-compatible object storage
// (e.g. Cloudflare R2) under identical keys, so existing /uploads/* URLs keep
// working with zero DB or frontend changes.
//
// Usage (production container has deps + /data mounted):
//   docker compose exec campfire node scripts/migrate-uploads-to-r2.js
//   docker compose exec campfire node scripts/migrate-uploads-to-r2.js --delete
//
// Default run only uploads + HEAD-verifies (byte size) and reports. With
// --delete, files that verified OK are unlinked from local disk afterwards.
// Anything unverified is never deleted; exit code is non-zero on failure.
// Requires S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY in env.
const fs = require('fs');
const path = require('path');
const storage = require('../storage');

const DB_PATH = process.env.DB_PATH || '/data/campfire.db';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(DB_PATH), 'uploads');
const DELETE = process.argv.includes('--delete');

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}
function pruneEmpty(dir, stopAt) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) pruneEmpty(path.join(dir, e.name), stopAt);
  }
  if (path.resolve(dir) !== path.resolve(stopAt) && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
  }
}

(async () => {
  if (!storage.s3Enabled()) {
    console.error('S3 is not configured (need S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY).');
    process.exit(1);
  }
  if (!fs.existsSync(UPLOAD_DIR)) {
    console.log('Nothing to migrate: ' + UPLOAD_DIR + ' does not exist.');
    return;
  }
  const files = walk(UPLOAD_DIR, UPLOAD_DIR, []);
  console.log(`Found ${files.length} local file(s) under ${UPLOAD_DIR}.`);
  let ok = 0, failed = 0, bytes = 0, deleted = 0;
  const failures = [];
  for (const key of files) {
    const full = path.join(UPLOAD_DIR, ...key.split('/'));
    try {
      const buf = fs.readFileSync(full);
      await storage.s3Put(key, buf, storage.mimeForFilename(key));
      const head = await storage.s3Head(key);
      if (Number(head.ContentLength) !== buf.length) throw new Error(`size mismatch (local ${buf.length}, remote ${head.ContentLength})`);
      ok++; bytes += buf.length;
      console.log(`  ok  ${key} (${buf.length} B)`);
      if (DELETE) {
        fs.unlinkSync(full);
        deleted++;
      }
    } catch (err) {
      failed++;
      failures.push(`${key}: ${err && err.message ? err.message : err}`);
      console.log(`  FAIL ${key}: ${err && err.message ? err.message : err}`);
    }
  }
  if (DELETE && failed === 0) {
    try { pruneEmpty(UPLOAD_DIR, UPLOAD_DIR); } catch {}
  }
  console.log(`\nDone: ${ok} uploaded+verified (${(bytes / 1048576).toFixed(1)} MB), ${failed} failed${DELETE ? `, ${deleted} local deleted` : ''}.`);
  if (failed) {
    console.log('Failures:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
})().catch((err) => { console.error('Migration aborted:', err && err.message ? err.message : err); process.exit(1); });
