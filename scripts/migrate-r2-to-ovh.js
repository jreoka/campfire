// Campfire media migration: Cloudflare R2 (source, untouched) -> OVH object
// storage (destination).
//
// Runs inside the app container. Credentials come from the environment:
//   source: S3_*         (the app's own media credentials)
//   dest:   S3_OVH_*     (destination bucket)
//
// Safety rules baked in, because the media bucket is the ONLY copy of the media:
//   1. The source bucket is only ever READ from. Nothing here deletes from it.
//   2. A destination key that already exists is skipped, never overwritten.
//   3. --apply is required to write anything at all; the default is a dry run.
//   4. Copy reports a failure count, and a byte-level spot check re-downloads
//      objects from BOTH stores and compares SHA-256.
//
//   node scripts/migrate-r2-to-ovh.js            dry run: list + inventory only
//   node scripts/migrate-r2-to-ovh.js --apply    copy missing objects
//   node scripts/migrate-r2-to-ovh.js --verify   metadata + sample byte compare
//   node scripts/migrate-r2-to-ovh.js --apply --verify
const crypto = require('crypto');
const {
  S3Client, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand, PutObjectCommand,
} = require('@aws-sdk/client-s3');

const APPLY = process.argv.includes('--apply');
const VERIFY = process.argv.includes('--verify');
const SAMPLE = Math.max(1, Number(process.env.MIGRATE_SAMPLE || 12));
const CONCURRENCY = Math.max(1, Number(process.env.MIGRATE_CONCURRENCY || 4));

const SRC = {
  bucket: process.env.S3_BUCKET,
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || 'auto',
  key: process.env.S3_ACCESS_KEY,
  secret: process.env.S3_SECRET_KEY,
  pathStyle: process.env.S3_FORCE_PATH_STYLE !== '0',
};
const DST = {
  bucket: process.env.S3_OVH_BUCKET,
  endpoint: process.env.S3_OVH_ENDPOINT,
  region: process.env.S3_OVH_REGION || 'us-east-va',
  key: process.env.S3_OVH_ACCESS_KEY,
  secret: process.env.S3_OVH_SECRET_KEY,
  pathStyle: process.env.S3_OVH_FORCE_PATH_STYLE !== '0',
};

function client(cfg) {
  return new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.pathStyle,
    credentials: { accessKeyId: cfg.key, secretAccessKey: cfg.secret },
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 8000, requestTimeout: 60000, throwOnRequestTimeout: true },
  });
}

function need(name, v) {
  if (!v) { console.error(`missing env ${name}`); process.exit(2); }
  return v;
}

function human(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

// The app infers ContentType from the filename on upload (storage.js
// mimeForFilename). media-compress and the scanners rewrite objects through the
// same path, so the extension is the authority for what the store should say.
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.wav': 'audio/wav',
  '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.md': 'text/markdown', '.zip': 'application/zip',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};
function mimeFor(key) {
  const m = String(key).toLowerCase().match(/(\.[a-z0-9]+)$/);
  return MIME[m ? m[1] : ''] || null;
}

async function listAll(s3, bucket, label) {
  const out = [];
  let token;
  let pages = 0;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token, MaxKeys: 1000 }));
    for (const o of r.Contents || []) out.push({ key: o.Key, size: Number(o.Size) || 0 });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
    pages++;
    process.stdout.write(`\r  ${label}: listed ${out.length} objects (${pages} page(s))      `);
  } while (token);
  process.stdout.write('\n');
  return out;
}

async function sha256Of(stream) {
  const h = crypto.createHash('sha256');
  for await (const chunk of stream) h.update(chunk);
  return h.digest('hex');
}

async function getBytes(s3, bucket, key) {
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return sha256Of(r.Body);
}

async function pool(items, limit, fn) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

(async () => {
  need('S3_BUCKET', SRC.bucket);
  need('S3_ENDPOINT', SRC.endpoint);
  need('S3_ACCESS_KEY', SRC.key);
  need('S3_SECRET_KEY', SRC.secret);
  need('S3_OVH_BUCKET', DST.bucket);
  need('S3_OVH_ENDPOINT', DST.endpoint);
  need('S3_OVH_ACCESS_KEY', DST.key);
  need('S3_OVH_SECRET_KEY', DST.secret);

  console.log('source     :', SRC.endpoint, '/', SRC.bucket, `(pathStyle=${SRC.pathStyle})`);
  console.log('destination:', DST.endpoint, '/', DST.bucket, `(pathStyle=${DST.pathStyle})`);
  console.log('mode       :', APPLY ? 'APPLY (will write)' : 'DRY RUN (no writes)');
  console.log('');

  const src = client(SRC);
  const dst = client(DST);

  console.log('== listing source ==');
  const srcObjs = await listAll(src, SRC.bucket, 'source');
  console.log('== listing destination ==');
  const dstObjs = await listAll(dst, DST.bucket, 'destination');

  const srcBytes = srcObjs.reduce((a, o) => a + o.size, 0);
  const dstMap = new Map(dstObjs.map((o) => [o.key, o.size]));

  const byPrefix = new Map();
  for (const o of srcObjs) {
    const i = o.key.indexOf('/');
    const p = i < 0 ? '(root)' : o.key.slice(0, i + 1);
    const a = byPrefix.get(p) || { n: 0, b: 0 };
    a.n++; a.b += o.size;
    byPrefix.set(p, a);
  }
  console.log('');
  console.log(`source: ${srcObjs.length} objects, ${human(srcBytes)}`);
  for (const [p, a] of [...byPrefix].sort((x, y) => y[1].b - x[1].b)) {
    console.log(`   ${p.padEnd(14)} ${String(a.n).padStart(5)} objects  ${human(a.b).padStart(10)}`);
  }
  console.log(`destination already holds: ${dstObjs.length} objects`);

  const missing = srcObjs.filter((o) => !dstMap.has(o.key));
  const wrongSize = srcObjs.filter((o) => dstMap.has(o.key) && dstMap.get(o.key) !== o.size);
  const extra = dstObjs.filter((o) => !srcObjs.some((s) => s.key === o.key));
  console.log('');
  console.log(`to copy      : ${missing.length} objects (${human(missing.reduce((a, o) => a + o.size, 0))})`);
  console.log(`already there: ${srcObjs.length - missing.length}`);
  console.log(`size mismatch: ${wrongSize.length}`);
  console.log(`dest-only    : ${extra.length}${extra.length ? ' -> ' + extra.slice(0, 5).map((o) => o.key).join(', ') : ''}`);

  if (wrongSize.length) {
    console.log('');
    console.log('!! size mismatches on existing destination keys (NOT overwritten, inspect these):');
    for (const o of wrongSize.slice(0, 20)) {
      console.log(`   ${o.key}: source ${o.size} vs dest ${dstMap.get(o.key)}`);
    }
  }

  if (!APPLY) {
    console.log('');
    console.log('dry run complete - nothing written. Re-run with --apply to copy.');
    return;
  }

  if (missing.length) {
    console.log('');
    console.log(`== copying ${missing.length} objects, concurrency ${CONCURRENCY} ==`);
    let done = 0;
    let failed = 0;
    let copiedBytes = 0;
    const failures = [];
    await pool(missing, CONCURRENCY, async (o) => {
      try {
        const r = await src.send(new GetObjectCommand({ Bucket: SRC.bucket, Key: o.key }));
        const ctype = r.ContentType && r.ContentType !== 'application/octet-stream'
          ? r.ContentType
          : (mimeFor(o.key) || r.ContentType || 'application/octet-stream');
        // AWS SDK v3 requires a buffer/stream Body with a known length for
        // stores that reject chunked PUTs (storage.js does the same).
        const chunks = [];
        for await (const c of r.Body) chunks.push(c);
        const body = Buffer.concat(chunks);
        if (body.length !== o.size) {
          throw new Error(`short read: expected ${o.size}, got ${body.length}`);
        }
        await dst.send(new PutObjectCommand({
          Bucket: DST.bucket, Key: o.key, Body: body, ContentType: ctype,
        }));
        copiedBytes += body.length;
        done++;
      } catch (e) {
        failed++;
        failures.push({ key: o.key, error: String(e.message || e).slice(0, 160) });
      }
      if ((done + failed) % 25 === 0 || done + failed === missing.length) {
        process.stdout.write(`\r  copied ${done}/${missing.length}  failed ${failed}  ${human(copiedBytes)}   `);
      }
    });
    process.stdout.write('\n');
    console.log(`copy finished: ${done} copied, ${failed} failed`);
    if (failures.length) {
      console.log('failures:');
      for (const f of failures.slice(0, 30)) console.log(`   ${f.key}: ${f.error}`);
      console.log('(re-run --apply to retry; already-present keys are skipped)');
    }
  } else {
    console.log('');
    console.log('nothing to copy.');
  }

  if (!VERIFY) {
    console.log('');
    console.log('run again with --verify to compare metadata and re-hash a sample.');
    return;
  }

  console.log('');
  console.log('== verification ==');
  const src2 = await listAll(src, SRC.bucket, 'source');
  const dst2 = await listAll(dst, DST.bucket, 'destination');
  const d2 = new Map(dst2.map((o) => [o.key, o.size]));
  const missingNow = src2.filter((o) => !d2.has(o.key));
  const sizeBad = src2.filter((o) => d2.has(o.key) && d2.get(o.key) !== o.size);
  const srcB = src2.reduce((a, o) => a + o.size, 0);
  const dstB = dst2.reduce((a, o) => a + o.size, 0);

  console.log(`source      : ${src2.length} objects, ${human(srcB)}`);
  console.log(`destination : ${dst2.length} objects, ${human(dstB)}`);
  console.log(`missing at destination : ${missingNow.length}`);
  console.log(`size mismatches        : ${sizeBad.length}`);
  console.log(`count match  : ${src2.length === dst2.length ? 'YES' : 'NO'}`);
  console.log(`bytes match  : ${srcB === dstB ? 'YES' : 'NO'}`);

  // Sample across prefixes so every kind of object is represented, not just
  // whichever prefix happens to sort first.
  const byPrefixList = new Map();
  for (const o of src2) {
    const i = o.key.indexOf('/');
    const p = i < 0 ? '(root)' : o.key.slice(0, i + 1);
    if (!byPrefixList.has(p)) byPrefixList.set(p, []);
    byPrefixList.get(p).push(o);
  }
  const picked = new Set();
  const sample = [];
  for (const [, arr] of byPrefixList) {
    for (let i = 0; i < Math.min(3, arr.length); i++) {
      sample.push(arr[i]);
      picked.add(arr[i].key);
    }
  }
  const rest = src2
    .filter((o) => !picked.has(o.key))
    .sort(() => Math.random() - 0.5)
    .slice(0, Math.max(0, SAMPLE));
  const finalSample = [...sample, ...rest];

  console.log('');
  console.log(`== byte-for-byte spot check on ${finalSample.length} objects ==`);
  let same = 0;
  let diff = 0;
  await pool(finalSample, 3, async (o) => {
    try {
      const [a, b] = await Promise.all([
        getBytes(src, SRC.bucket, o.key),
        getBytes(dst, DST.bucket, o.key),
      ]);
      if (a === b) { same++; console.log(`   OK   ${o.key} (${human(o.size)})`); }
      else { diff++; console.log(`   DIFF ${o.key}  source=${a.slice(0, 12)} dest=${b.slice(0, 12)}`); }
    } catch (e) {
      diff++;
      console.log(`   ERR  ${o.key}: ${String(e.message || e).slice(0, 120)}`);
    }
  });
  console.log(`spot check: ${same} identical, ${diff} different/unreadable`);

  // ContentType sanity: a wrong type here is how video and images break.
  console.log('');
  console.log('== contentType spot check ==');
  await pool(finalSample.slice(0, 8), 3, async (o) => {
    try {
      const h = await dst.send(new HeadObjectCommand({ Bucket: DST.bucket, Key: o.key }));
      const want = mimeFor(o.key);
      const flag = !want || h.ContentType === want ? ' ' : '?';
      console.log(`  ${flag} ${o.key}: dest type=${h.ContentType}${want && h.ContentType !== want ? ` (extension suggests ${want})` : ''}`);
    } catch (e) {
      console.log(`   ! ${o.key}: head failed ${String(e.message || e).slice(0, 80)}`);
    }
  });

  const ok = missingNow.length === 0 && sizeBad.length === 0 && src2.length === dst2.length && srcB === dstB && diff === 0;
  console.log('');
  console.log(ok ? 'VERIFICATION PASSED' : 'VERIFICATION FAILED - do not switch over');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('migration crashed:', e && e.message ? e.message : e);
  process.exit(1);
});
