// Copy every object from the OVH production bucket to the Civo bucket.
//
// SAFETY RULES (this script is deliberately incapable of losing data):
//   - COPY ONLY. It never issues a delete, on either side, ever.
//   - It never overwrites a destination object that already exists at the same
//     size, so a re-run is cheap and idempotent.
//   - It defaults to DRY RUN. Writing requires an explicit --write.
//   - --verify only reads: it compares key sets and sizes and reports drift.
//
// ALL prefixes are copied, including `backups/` (nightly pg_dump snapshots).
// Note that AGENTS.md requires anything SERVING or SWEEPING the bucket to skip
// `backups/` — that rule is about serving, not migration: the snapshots are part
// of the data being moved.
//
// Usage:
//   node scripts/migrate-s3.js --dry       # inventory + plan (default)
//   node scripts/migrate-s3.js --write     # perform the copy
//   node scripts/migrate-s3.js --verify    # compare source and destination
//
// Source env (OVH, as found in /opt/campfire/.env):
//   SRC_S3_ENDPOINT SRC_S3_BUCKET SRC_S3_REGION SRC_S3_ACCESS_KEY SRC_S3_SECRET_KEY
// Destination env (Civo object store):
//   DST_S3_ENDPOINT DST_S3_BUCKET DST_S3_REGION DST_S3_ACCESS_KEY DST_S3_SECRET_KEY
// Optional:
//   SRC_S3_PATH_STYLE=1 / DST_S3_PATH_STYLE=1   force path-style addressing
//   S3_MIGRATE_CONCURRENCY                       parallel transfers (default 4)
'use strict';

const {
  S3Client, ListObjectsV2Command, HeadObjectCommand, GetObjectCommand, PutObjectCommand,
} = require('@aws-sdk/client-s3');

const DRY = process.argv.includes('--dry') || !process.argv.includes('--write');
const VERIFY = process.argv.includes('--verify');
const CONCURRENCY = Math.max(1, parseInt(process.env.S3_MIGRATE_CONCURRENCY || '4', 10) || 4);

function side(prefix) {
  const endpoint = process.env[prefix + '_S3_ENDPOINT'];
  const bucket = process.env[prefix + '_S3_BUCKET'];
  const region = process.env[prefix + '_S3_REGION'] || 'auto';
  const accessKeyId = process.env[prefix + '_S3_ACCESS_KEY'];
  const secretAccessKey = process.env[prefix + '_S3_SECRET_KEY'];
  const missing = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY']
    .filter((n) => !process.env[prefix + '_' + n]);
  if (missing.length) throw new Error(`${prefix}_${missing.join(', ' + prefix + '_')} not set`);
  return {
    bucket, endpoint,
    s3: new S3Client({
      region, endpoint,
      forcePathStyle: !!process.env[prefix + '_S3_PATH_STYLE'],
      credentials: { accessKeyId, secretAccessKey },
    }),
  };
}

async function listAll({ s3, bucket }, label) {
  const out = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token, MaxKeys: 1000 }));
    for (const o of r.Contents || []) out.push({ key: o.Key, size: Number(o.Size) || 0, etag: String(o.ETag || '').replace(/"/g, '') });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  console.log(`  ${label}: ${out.length} object(s), ${(out.reduce((a, o) => a + o.size, 0) / 1048576).toFixed(1)} MiB`);
  return out;
}

// Group by top-level prefix — the bucket has no shared `uploads/` prefix, the
// keys are top-level (files/, avatars/, banners/, emoji/, icons/, sidebar/,
// viewonce/, backups/).
function byPrefix(objs) {
  const m = new Map();
  for (const o of objs) {
    const p = o.key.includes('/') ? o.key.slice(0, o.key.indexOf('/') + 1) : '(root)';
    const e = m.get(p) || { objects: 0, bytes: 0 };
    e.objects++; e.bytes += o.size;
    m.set(p, e);
  }
  return [...m.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
}

async function existsSameSize(dst, key, size) {
  try {
    const h = await dst.s3.send(new HeadObjectCommand({ Bucket: dst.bucket, Key: key }));
    return Number(h.ContentLength) === size;
  } catch { return false; }
}

async function copyOne(src, dst, obj) {
  const got = await src.s3.send(new GetObjectCommand({ Bucket: src.bucket, Key: obj.key }));
  // Read the object fully into memory and send it as a BUFFER, not a stream.
  // A streaming Body makes aws-sdk v3 issue a chunked PUT with a checksum
  // trailer (STREAMING-UNSIGNED-PAYLOAD-TRAILER), which several S3-compatible
  // stores reject with "non-retryable streaming request". MinIO accepted it, so
  // this only shows up against the real destination. Uploads here are at most a
  // few MB and concurrency is bounded, so buffering is cheap.
  const bytes = Buffer.from(await got.Body.transformToByteArray());
  // Preserve the source Content-Type: served uploads must keep the type the app
  // set, or browsers will download instead of render them.
  const contentType = got.ContentType || undefined;
  await dst.s3.send(new PutObjectCommand({
    Bucket: dst.bucket,
    Key: obj.key,
    Body: bytes,
    ContentLength: bytes.length,
    ...(contentType ? { ContentType: contentType } : {}),
    ...(got.CacheControl ? { CacheControl: got.CacheControl } : {}),
  }));
  return bytes.length;
}

async function main() {
  const src = side('SRC');
  const dst = side('DST');
  console.log(`[migrate] mode=${VERIFY ? 'verify' : DRY ? 'dry-run' : 'WRITE'}`);
  console.log(`[migrate] source ${src.endpoint} / ${src.bucket}`);
  console.log(`[migrate] destination ${dst.endpoint} / ${dst.bucket}`);
  if (src.endpoint === dst.endpoint && src.bucket === dst.bucket) {
    console.log('[migrate] REFUSING: source and destination are the same bucket.');
    process.exit(1);
  }

  console.log('\n[inventory]');
  const srcObjs = await listAll(src, 'source');
  const dstObjs = await listAll(dst, 'destination');

  console.log('\n[source by prefix]');
  for (const [p, e] of byPrefix(srcObjs)) console.log(`  ${p.padEnd(12)} ${String(e.objects).padStart(4)} objects  ${(e.bytes / 1048576).toFixed(2)} MiB`);

  const dstByKey = new Map(dstObjs.map((o) => [o.key, o]));
  const missing = srcObjs.filter((o) => !dstByKey.has(o.key));
  const mismatched = srcObjs.filter((o) => dstByKey.has(o.key) && dstByKey.get(o.key).size !== o.size);
  const extra = dstObjs.filter((o) => !srcObjs.some((s) => s.key === o.key));

  if (VERIFY) {
    console.log('\n[verify]');
    console.log(`  present in both      : ${srcObjs.length - missing.length - mismatched.length}`);
    console.log(`  missing at dest      : ${missing.length}`);
    console.log(`  size mismatch        : ${mismatched.length}`);
    console.log(`  extra at dest        : ${extra.length}`);
    for (const o of missing.slice(0, 20)) console.log(`    MISSING  ${o.key} (${o.size}b)`);
    for (const o of mismatched.slice(0, 20)) console.log(`    SIZE     ${o.key} src=${o.size}b dst=${dstByKey.get(o.key).size}b`);
    for (const o of extra.slice(0, 20)) console.log(`    EXTRA    ${o.key} (${o.size}b)`);
    const ok = !missing.length && !mismatched.length;
    console.log(ok ? '\n[verify] OK — destination matches source' : '\n[verify] DRIFT — see above (nothing was modified)');
    process.exit(ok ? 0 : 1);
  }

  const todo = missing.concat(mismatched);
  console.log(`\n[plan] ${todo.length} object(s) to copy, ${(todo.reduce((a, o) => a + o.size, 0) / 1048576).toFixed(1)} MiB`);
  if (extra.length) console.log(`[plan] ${extra.length} object(s) exist only at the destination — left alone (this script never deletes)`);
  if (!todo.length) { console.log('[plan] nothing to do'); process.exit(0); }
  if (DRY) { console.log('[dry-run] no changes made. Re-run with --write to copy.'); process.exit(0); }

  let done = 0, bytes = 0, failed = 0;
  const queue = todo.slice();
  async function worker() {
    for (;;) {
      const o = queue.shift();
      if (!o) return;
      try {
        await copyOne(src, dst, o);
        done++; bytes += o.size;
        if (done % 10 === 0 || done === todo.length) {
          console.log(`  copied ${done}/${todo.length} (${(bytes / 1048576).toFixed(1)} MiB)`);
        }
      } catch (e) {
        failed++;
        console.error(`  FAILED ${o.key}: ${(e && e.message) || e}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\n[result] copied ${done}, failed ${failed}, bytes ${(bytes / 1048576).toFixed(1)} MiB`);
  if (failed) { console.log('[result] re-run to retry the failures (already-copied objects are skipped)'); process.exit(1); }
  console.log('[result] now run: node scripts/migrate-s3.js --verify');
}

main().catch((e) => { console.error('[migrate] ERROR:', (e && e.stack) || e); process.exit(1); });
