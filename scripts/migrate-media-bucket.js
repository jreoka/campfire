#!/usr/bin/env node
// scripts/migrate-media-bucket.js
//
// Copy every object from one S3-compatible bucket into another, key for key,
// and verify it landed. The two sides are just SRC_* / DST_* environment, so it
// works for any pair (Civo -> R2 here).
//
// This script NEVER deletes anything: not a source object, not a bucket, not a
// version. Deleting the old bucket is a separate, deliberate, human step taken
// only after the new one has served production traffic for a full billing cycle.
//
// Why the keys are copied verbatim: storage.js's URL contract is
//   /uploads/<sub>/<file>?v=<cachekey>
// so the bucket layout IS the URL layout (files/, avatars/, banners/, emoji/,
// icons/, sidebar/, viewonce/, thumbs/, ...). Copy the key byte-for-byte and no
// row in the database and no cached URL changes — the switch is S3_* in the
// environment, with no schema change. The compressor's media_compress_keys
// ledger is keyed by storage key as well, so it stays valid across the move.
//
// THE DESTINATION IS LISTED ONCE, not HEADed key by key. That is both cheaper
// (one paginated pass instead of N round trips) and more robust: a HEAD for an
// absent key is the one request some stores answer inconsistently — Hetzner
// Object Storage returned a bare 403 for ~19% of them, which is what made an
// earlier version of this script print "0 present, 226 to copy" for a
// 262-object bucket.
//
// ADDRESSING STYLE IS PER-SIDE (verify with scripts/s3-smoke.js):
//   Civo     path-style only      ..._FORCE_PATH_STYLE=1 (default)
//   R2       path-style fine      ..._FORCE_PATH_STYLE=1 (default)
//   Hetzner  virtual-host only    ..._FORCE_PATH_STYLE=0   [store rejected]
//
// Usage:
//   node scripts/migrate-media-bucket.js                    # dry run (default)
//   node scripts/migrate-media-bucket.js --inventory        # size the source only
//   node scripts/migrate-media-bucket.js --copy --limit 20  # pilot: 20 objects
//   node scripts/migrate-media-bucket.js --verify --limit 20
//   node scripts/migrate-media-bucket.js --copy             # full copy
//   node scripts/migrate-media-bucket.js --verify           # metadata check
//   node scripts/migrate-media-bucket.js --verify --deep    # re-download and MD5
//
//   --prefix <p>        only keys under this prefix (repeatable)
//   --concurrency <n>   parallel transfers (default 4)
//   --limit <n>         stop after n objects (for a pilot)
//   --deep              verify by downloading every object and hashing it
//
// --copy is idempotent and therefore resumable: an object already in the
// destination with the same size — and, where both sides report a plain MD5
// ETag, the same ETag — is skipped. An interrupted run is resumed by re-running.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand,
} = require('@aws-sdk/client-s3');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env.migrate');
const SELF = 'scripts/migrate-media-bucket.js';

// ---------- args ----------
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f, dflt) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const MODE = has('--copy') ? 'copy' : has('--verify') ? 'verify' : has('--inventory') ? 'inventory' : 'dry';
const CONCURRENCY = Math.max(1, Math.min(16, parseInt(valOf('--concurrency', '4'), 10) || 4));
const LIMIT = parseInt(valOf('--limit', '0'), 10) || 0;
const DEEP = has('--deep');
const PREFIXES = argv.reduce((acc, a, i) => (a === '--prefix' && argv[i + 1] ? acc.concat(argv[i + 1]) : acc), []);

// ---------- env ----------
function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnvFile(ENV_FILE);

const need = (name) => {
  const v = process.env[name];
  if (!v || /^<.*>$/.test(v)) throw new Error(`missing ${name} (set it in .env.migrate — see .env.migrate.example)`);
  return v;
};

const pathStyleFor = (prefix) => process.env[`${prefix}_FORCE_PATH_STYLE`] !== '0';

function clientFor(prefix) {
  return new S3Client({
    region: need(`${prefix}_REGION`),
    endpoint: need(`${prefix}_ENDPOINT`),
    forcePathStyle: pathStyleFor(prefix),
    credentials: { accessKeyId: need(`${prefix}_ACCESS_KEY`), secretAccessKey: need(`${prefix}_SECRET_KEY`) },
    maxAttempts: 3,
    // Bulk transfer, not a request a browser is waiting on: the 30s bound
    // storage.js uses for a single upload answer is too tight here.
    requestHandler: { connectionTimeout: 10000, requestTimeout: 120000, throwOnRequestTimeout: true },
  });
}

const SRC = { client: null, bucket: '' };
const DST = { client: null, bucket: '' };
let DST_INDEX = null; // key -> { key, size, etag }, from ONE listing of the destination

const unquote = (etag) => String(etag || '').replace(/"/g, '');
const isPlainMd5 = (etag) => /^[a-f0-9]{32}$/i.test(unquote(etag));
const bothMd5 = (a, b) => isPlainMd5(a) && isPlainMd5(b);
const PASS = new Set(['ok', 'ok_size_only', 'deep_ok', 'deep_ok_size_only']);
const fmt = (n) => {
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0; let v = Number(n) || 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const topPrefix = (key) => {
  const i = key.indexOf('/');
  return i === -1 ? '(root)' : `${key.slice(0, i)}/`;
};

// ---------- list ----------
async function listAll(client, bucket, prefixes) {
  const out = [];
  const targets = prefixes.length ? prefixes : [''];
  for (const prefix of targets) {
    let token;
    do {
      const page = await client.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token,
      }));
      for (const o of page.Contents || []) {
        if (!o.Key || o.Key.endsWith('/')) continue; // skip folder placeholders
        out.push({ key: o.Key, size: Number(o.Size) || 0, etag: unquote(o.ETag), mtime: o.LastModified });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

async function buildDestIndex() {
  const list = await listAll(DST.client, DST.bucket, []);
  DST_INDEX = new Map(list.map((o) => [o.key, o]));
  return DST_INDEX;
}

// ---------- transfer ----------
async function copyOne(obj) {
  const existing = DST_INDEX.get(obj.key);
  if (existing && existing.size === obj.size) {
    // Only trust an ETag match when both sides are plain MD5s; a multipart or
    // provider-specific ETag is not comparable and size is the honest test.
    if (!bothMd5(obj.etag, existing.etag) || existing.etag === obj.etag) return { status: 'skipped' };
  }
  if (obj.size > 512 * 1024 * 1024) {
    return { status: 'too_big', note: 'single PUT only; multipart not implemented (uploads are capped at MAX_FILE_MB)' };
  }
  const got = await SRC.client.send(new GetObjectCommand({ Bucket: SRC.bucket, Key: obj.key }));
  const bytes = Buffer.from(await got.Body.transformToByteArray());
  if (bytes.length !== obj.size) {
    return { status: 'size_drift', note: `read ${bytes.length}, listed ${obj.size}` };
  }
  await DST.client.send(new PutObjectCommand({
    Bucket: DST.bucket,
    Key: obj.key,
    Body: bytes,
    ContentLength: bytes.length,
    ContentType: got.ContentType || 'application/octet-stream',
  }));
  DST_INDEX.set(obj.key, { key: obj.key, size: bytes.length, etag: '' });
  return { status: 'copied' };
}

// Metadata check: what the destination's own listing says about the object.
function verifyOne(obj) {
  const dst = DST_INDEX.get(obj.key);
  if (!dst) return { status: 'missing' };
  if (dst.size !== obj.size) return { status: 'size_mismatch', note: `${dst.size} != ${obj.size}` };
  if (bothMd5(obj.etag, dst.etag) && dst.etag !== obj.etag) {
    return { status: 'etag_mismatch', note: `${dst.etag} != ${obj.etag}` };
  }
  return { status: bothMd5(obj.etag, dst.etag) ? 'ok' : 'ok_size_only' };
}

// Ground truth: download it again and hash the bytes. Only affordable because
// the media set is small — 246 MiB re-downloads in seconds.
async function verifyOneDeep(obj) {
  const meta = verifyOne(obj);
  if (!PASS.has(meta.status)) return meta;
  const got = await DST.client.send(new GetObjectCommand({ Bucket: DST.bucket, Key: obj.key }));
  const bytes = Buffer.from(await got.Body.transformToByteArray());
  if (bytes.length !== obj.size) {
    return { status: 'deep_size_mismatch', note: `${bytes.length} != ${obj.size}` };
  }
  if (isPlainMd5(obj.etag)) {
    const md5 = crypto.createHash('md5').update(bytes).digest('hex');
    if (md5 !== obj.etag) return { status: 'deep_md5_mismatch', note: `${md5} != ${obj.etag}` };
    return { status: 'deep_ok' };
  }
  return { status: 'deep_ok_size_only' };
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        const status = (e && e.$metadata && e.$metadata.httpStatusCode) || 0;
        const name = (e && (e.name || e.Code)) || 'Error';
        results[i] = { status: 'error', note: `${name}${status ? ' HTTP ' + status : ''}: ${String((e && e.message) || e).slice(0, 120)}` };
      }
      done++;
      if (done % 100 === 0 || done === items.length) {
        process.stdout.write(`\r  ${done}/${items.length} …${' '.repeat(20)}`);
      }
    }
  });
  await Promise.all(workers);
  process.stdout.write('\r' + ' '.repeat(60) + '\r');
  return results;
}

const style = (prefix) => (pathStyleFor(prefix) ? 'path-style' : 'virtual-host');
const tallyOf = (results) => results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});

// ---------- main ----------
async function main() {
  SRC.bucket = need('SRC_BUCKET');
  SRC.client = clientFor('SRC');
  if (MODE !== 'inventory') {
    DST.bucket = need('DST_BUCKET');
    if (SRC.bucket === DST.bucket && process.env.SRC_ENDPOINT === process.env.DST_ENDPOINT) {
      throw new Error('source and destination are the same bucket/endpoint — nothing to do');
    }
    DST.client = clientFor('DST');
  }

  console.log(`mode       ${MODE}${MODE === 'dry' ? '  (default; nothing is written)' : ''}${DEEP && MODE === 'verify' ? ' (deep: re-download + MD5)' : ''}`);
  console.log(`source     ${SRC.bucket} @ ${process.env.SRC_ENDPOINT}  [${style('SRC')}]`);
  if (DST.client) console.log(`dest       ${DST.bucket} @ ${process.env.DST_ENDPOINT}  [${style('DST')}]`);
  if (PREFIXES.length) console.log(`prefixes   ${PREFIXES.join(', ')}`);
  if (LIMIT) console.log(`limit      ${LIMIT} object(s)`);
  console.log('');

  let objects = await listAll(SRC.client, SRC.bucket, PREFIXES);
  if (LIMIT) objects = objects.slice(0, LIMIT);
  const totalBytes = objects.reduce((a, o) => a + o.size, 0);

  const byPrefix = new Map();
  for (const o of objects) {
    const p = topPrefix(o.key);
    const cur = byPrefix.get(p) || { n: 0, bytes: 0 };
    cur.n++; cur.bytes += o.size;
    byPrefix.set(p, cur);
  }
  console.log(`source objects  ${objects.length}   total ${fmt(totalBytes)}`);
  for (const [p, v] of [...byPrefix.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
    const note = p === 'backups/' ? '   (never served; included for completeness)' : '';
    console.log(`  ${p.padEnd(12)} ${String(v.n).padStart(7)}  ${fmt(v.bytes).padStart(10)}${note}`);
  }
  console.log('');

  if (MODE === 'inventory') {
    console.log('inventory only — the destination was not contacted and nothing was written.');
    return 0;
  }

  const index = await buildDestIndex();
  console.log(`dest index      ${index.size} object(s) already present (one listing, not ${objects.length} HEADs)`);
  console.log('');

  if (MODE === 'dry') {
    let present = 0; let presentBytes = 0; let differ = 0; let missing = 0; let missingBytes = 0;
    for (const o of objects) {
      const d = index.get(o.key);
      if (!d) { missing++; missingBytes += o.size; continue; }
      present++; presentBytes += d.size;
      if (d.size !== o.size) differ++;
    }
    console.log(`destination holds         ${present} objects  ${fmt(presentBytes)}`);
    console.log(`  of those, wrong byte size   ${differ}`);
    console.log(`still to copy             ${missing} objects  ${fmt(missingBytes)}`);
    // Every object is in the map or it is not, so this can only fail if the
    // listing was truncated — which is worth shouting about either way.
    if (present + missing !== objects.length) {
      console.log(`\n!! ${present} present + ${missing} missing != ${objects.length} listed — do not trust these counts`);
      return 1;
    }
    console.log('\nNothing was written. Next: a pilot copy —');
    console.log(`  node ${SELF} --copy --limit 20`);
    console.log(`then: node ${SELF} --verify --limit 20 --deep`);
    console.log('then the full copy without --limit.');
    return 0;
  }

  if (MODE === 'copy') {
    const results = await pool(objects, CONCURRENCY, copyOne);
    const tally = tallyOf(results);
    console.log('copy results');
    for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(14)} ${v}`);
    const bad = results.filter((r) => r.status !== 'copied' && r.status !== 'skipped');
    for (const [i, r] of results.entries()) {
      if (r.status === 'copied' || r.status === 'skipped') continue;
      console.log(`  ! ${objects[i].key}: ${r.status}${r.note ? ' — ' + r.note : ''}`);
    }
    console.log('\nNow verify WITHOUT trusting the copy result:');
    console.log(`  node ${SELF} --verify${DEEP ? ' --deep' : ''}`);
    return bad.length ? 1 : 0;
  }

  // verify
  const results = await pool(objects, CONCURRENCY, DEEP ? verifyOneDeep : verifyOne);
  const tally = tallyOf(results);
  console.log(DEEP ? 'verify results (deep: bytes re-downloaded and hashed)' : 'verify results (metadata from the destination listing)');
  for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(18)} ${v}`);
  const bad = results.filter((r) => !PASS.has(r.status));
  for (const [i, r] of results.entries()) {
    if (PASS.has(r.status)) continue;
    console.log(`  ! ${objects[i].key}: ${r.status}${r.note ? ' — ' + r.note : ''}`);
  }
  if (bad.length) {
    console.log(`\n${bad.length} object(s) did NOT verify. Do not point the app at the new bucket yet.`);
    return 1;
  }
  const hashed = (tally.ok || 0) + (tally.deep_ok || 0);
  console.log(`\nEvery source object is present in the destination with a matching size`
    + (hashed ? `, and ${hashed} matched by MD5${DEEP ? ' after re-downloading the bytes' : ''}.` : ' (no MD5 comparison was possible).'));
  console.log('Reminder: this proves the copy is complete, not that the app works. Next —');
  console.log('  1. point S3_* at the new bucket on the host and restart the app');
  console.log('  2. exercise real media (an avatar, an attachment, a story) in the running app');
  console.log('  3. leave the OLD bucket alone for a full billing cycle, then delete it by hand.');
  console.log('   This script will not delete it for you, on purpose.');
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`\nmigrate: ${(e && e.message) || e}`);
  process.exit(2);
});
