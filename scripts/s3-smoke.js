#!/usr/bin/env node
// scripts/s3-smoke.js
//
// Prove an S3 endpoint works with this app's exact client configuration BEFORE
// any data is moved through it. Every migration assumption that has bitten this
// project before is a question this answers in one run:
//
//   * does the credential authenticate at all?
//   * path-style or virtual-host addressing?  (Civo needs path-style; some
//     S3-compatible stores only answer virtual-host)
//   * which signing region does it accept?
//   * can it PutObject -> HeadObject -> GetObject -> DeleteObject a real body?
//
//   node scripts/s3-smoke.js SRC     # the Civo bucket we are leaving
//   node scripts/s3-smoke.js DST     # the Hetzner bucket we are moving to
//
// It writes exactly one throwaway object under _smoke/ and deletes it again.
// It never prints a secret.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command,
} = require('@aws-sdk/client-s3');

const ROOT = path.join(__dirname, '..');

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
loadEnvFile(path.join(ROOT, '.env.migrate'));

const side = (process.argv[2] || '').toUpperCase();
if (side !== 'SRC' && side !== 'DST') {
  console.error('usage: node scripts/s3-smoke.js SRC|DST [--head <key>]');
  process.exit(2);
}
const argv = process.argv.slice(3);

const need = (n) => {
  const v = process.env[`${side}_${n}`];
  if (!v) { console.error(`missing ${side}_${n} in .env.migrate`); process.exit(2); }
  return v;
};

const ENDPOINT = need('ENDPOINT');
const BUCKET = need('BUCKET');
const REGION = need('REGION');
const KEY = `${need('ACCESS_KEY')}`;
const SECRET = `${need('SECRET_KEY')}`;

const KEY_NAME = `_smoke/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.bin`;
const BODY = crypto.randomBytes(64 * 1024); // 64 KiB: big enough to be real, small enough to be free

function clientFor(forcePathStyle, region) {
  return new S3Client({
    region,
    endpoint: ENDPOINT,
    forcePathStyle,
    credentials: { accessKeyId: KEY, secretAccessKey: SECRET },
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 10000, requestTimeout: 30000, throwOnRequestTimeout: true },
  });
}

const short = (e) => {
  const name = (e && (e.name || e.Code)) || 'Error';
  const msg = String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 160);
  const status = (e && e.$metadata && e.$metadata.httpStatusCode) || '';
  return `${name}${status ? ' HTTP ' + status : ''}: ${msg}`;
};

async function attempt(forcePathStyle, region) {
  const label = `${forcePathStyle ? 'path-style' : 'virtual-host'} + region ${region}`;
  const client = clientFor(forcePathStyle, region);
  try {
    await client.send(new PutObjectCommand({
      Bucket: BUCKET, Key: KEY_NAME, Body: BODY, ContentLength: BODY.length,
      ContentType: 'application/octet-stream',
    }));
  } catch (e) {
    return { label, ok: false, stage: 'PutObject', err: short(e) };
  }
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: KEY_NAME }));
    if (Number(head.ContentLength) !== BODY.length) {
      return { label, ok: false, stage: 'HeadObject', err: `size ${head.ContentLength} != ${BODY.length}` };
    }
    const got = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: KEY_NAME }));
    const back = Buffer.from(await got.Body.transformToByteArray());
    if (!back.equals(BODY)) {
      return { label, ok: false, stage: 'GetObject', err: 'bytes differ from what was uploaded' };
    }
  } catch (e) {
    return { label, ok: false, stage: 'round-trip', err: short(e) };
  } finally {
    // Always clean up, even on failure: a stray object is litter the bucket
    // reconciler would have to reason about.
    try { await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: KEY_NAME })); } catch { /* best effort */ }
  }
  return { label, ok: true };
}

(async () => {
  // --head <key>: dump exactly what the endpoint says about one key. The
  // interesting case is a MISSING object — providers disagree about how to
  // report it (Hetzner says 'UnknownError', Civo says 'NotFound'), and this is
  // how that difference was diagnosed rather than guessed at.
  if (argv[0] === '--head' && argv[1]) {
    const key = argv[1];
    console.log(`s3-smoke ${side} --head ${key}`);
    console.log(`  endpoint ${ENDPOINT}  bucket ${BUCKET}`);
    for (const ps of [true, false]) {
      const label = ps ? 'path-style  ' : 'virtual-host';
      try {
        const r = await clientFor(ps, REGION).send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
        console.log(`  ${label}: FOUND size=${r.ContentLength} etag=${r.ETag}`);
      } catch (e) {
        const md = (e && e.$metadata) || {};
        const hdrs = (e && e.$response && e.$response.headers) || {};
        const interesting = {};
        for (const [k, v] of Object.entries(hdrs)) {
          if (/^(x-amz-|x-ratelimit|retry-after|date|server|x-request)/i.test(k)) interesting[k] = v;
        }
        console.log(`  ${label}: name=${e.name} Code=${e.Code || '-'} status=${md.httpStatusCode || '-'} attempts=${md.attempts || '-'}`);
        console.log(`      ${String(e.message || e).slice(0, 300)}`);
        if (Object.keys(interesting).length) console.log(`      headers: ${JSON.stringify(interesting)}`);
      }
    }
    process.exit(0);
  }

  // --ls [prefix]: what is actually in the bucket. The migration scripts list
  // the source; this is how you check the destination independently.
  if (argv[0] === '--ls') {
    const prefix = argv[1] || '';
    const c = clientFor(false, REGION);
    let token; let n = 0; let bytes = 0; const sample = [];
    do {
      const page = await c.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token }));
      for (const o of page.Contents || []) {
        if (!o.Key || o.Key.endsWith('/')) continue;
        n++; bytes += Number(o.Size) || 0;
        if (sample.length < 15) sample.push(`${o.Key} (${o.Size} B)`);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    console.log(`s3-smoke ${side} --ls ${prefix || '(all)'}`);
    console.log(`  ${n} object(s), ${bytes} bytes`);
    for (const s of sample) console.log(`    ${s}`);
    if (n > sample.length) console.log(`    ... and ${n - sample.length} more`);
    process.exit(0);
  }

  // --burst <n> [concurrency]: hammer one key and histogram the statuses. This
  // exists because Hetzner Object Storage intermittently answered HEAD with a
  // bare 403 'UnknownError' during the first dry runs, non-deterministically —
  // a different set of keys each time. Before trusting a store with production
  // media you need to know whether that is a rate limit (it is not, as it turns
  // out) or a per-request flake that retries absorb.
  if (argv[0] === '--burst') {
    const n = parseInt(argv[1] || '60', 10);
    const conc = Math.max(1, parseInt(argv[2] || '4', 10));
    const key = `_smoke/absent-${Date.now()}.bin`;
    const client = clientFor(false, REGION); // one client, as the app uses
    const tally = {};
    let next = 0;
    const t0 = Date.now();
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= n) return;
        try {
          await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
          tally.FOUND = (tally.FOUND || 0) + 1;
        } catch (e) {
          const s = (e && e.$metadata && e.$metadata.httpStatusCode) || 0;
          const k = s ? `HTTP ${s}` : ((e && (e.name || e.Code)) || 'Error');
          tally[k] = (tally[k] || 0) + 1;
        }
      }
    };
    await Promise.all(Array.from({ length: conc }, worker));
    const ms = Date.now() - t0;
    console.log(`s3-smoke ${side} --burst n=${n} concurrency=${conc} on an absent key`);
    console.log(`  ${(n / (ms / 1000)).toFixed(1)} req/s sustained over ${ms} ms`);
    for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${String(v).padStart(6)}  ${k}`);
    process.exit(0);
  }

  // --rt <n> [concurrency]: n real round-trips (Put -> Head -> Get -> compare ->
  // Delete) on distinct keys. This is the test that matters for the app: media
  // writes and reads always touch objects that exist, whereas --burst probes the
  // absent-key path, which this store answers with a 403 a fraction of the time.
  if (argv[0] === '--rt') {
    const n = parseInt(argv[1] || '20', 10);
    const conc = Math.max(1, parseInt(argv[2] || '1', 10));
    const tally = {};
    const bump = (k) => { tally[k] = (tally[k] || 0) + 1; };
    const statusOf = (e) => ((e && e.$metadata && e.$metadata.httpStatusCode) || (e && e.name) || 'Error');
    let next = 0;
    const client = clientFor(false, REGION);
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= n) return;
        const key = `_smoke/rt-${Date.now()}-${i}-${crypto.randomBytes(3).toString('hex')}.bin`;
        const body = crypto.randomBytes(2048);
        try {
          await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentLength: body.length }));
          bump('put_ok');
        } catch (e) { bump(`put_${statusOf(e)}`); continue; }
        try {
          const h = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
          bump(Number(h.ContentLength) === body.length ? 'head_ok' : 'head_size_mismatch');
        } catch (e) { bump(`head_${statusOf(e)}`); }
        try {
          const g = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
          const back = Buffer.from(await g.Body.transformToByteArray());
          bump(back.equals(body) ? 'get_bytes_ok' : 'get_bytes_differ');
        } catch (e) { bump(`get_${statusOf(e)}`); }
        try {
          await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
          bump('delete_ok');
        } catch (e) { bump(`delete_${statusOf(e)}`); }
      }
    };
    await Promise.all(Array.from({ length: conc }, worker));
    console.log(`s3-smoke ${side} --rt n=${n} concurrency=${conc} (real objects, put/head/get/delete)`);
    for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${String(v).padStart(6)}  ${k}`);
    const bad = Object.entries(tally).filter(([k]) => !k.endsWith('_ok'));
    console.log(bad.length ? '\n  !! failures present' : '\n  every stage clean on every object');
    process.exit(bad.length ? 1 : 0);
  }

  // --rm <prefix>: delete everything under an explicit prefix. The prefix is
  // REQUIRED and must be non-empty, so this can never wipe a whole bucket by
  // accident. Used to clean up the test objects the probes leave behind when a
  // delete request itself fails.
  if (argv[0] === '--rm') {
    const prefix = argv[1];
    if (!prefix || prefix.length < 3) {
      console.error('--rm requires a prefix of at least 3 characters (refusing to wipe a bucket)');
      process.exit(2);
    }
    const c = clientFor(false, REGION);
    let token; const keys = [];
    do {
      const page = await c.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token }));
      for (const o of page.Contents || []) if (o.Key && !o.Key.endsWith('/')) keys.push(o.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    let ok = 0; let fail = 0;
    for (const k of keys) {
      try { await c.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: k })); ok++; } catch { fail++; }
    }
    console.log(`s3-smoke ${side} --rm ${prefix}: ${keys.length} found, ${ok} deleted, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }

  console.log(`s3-smoke ${side}`);
  console.log(`  endpoint ${ENDPOINT}`);
  console.log(`  bucket   ${BUCKET}`);
  console.log(`  region   ${REGION} (as configured)`);
  console.log('');

  const variants = [
    [true, REGION],
    [false, REGION],
    [true, 'us-east-1'],
    [false, 'us-east-1'],
  ];
  // Dedupe when the configured region already is us-east-1.
  const seen = new Set();
  let winner = null;
  for (const [ps, rg] of variants) {
    const id = `${ps}|${rg}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const r = await attempt(ps, rg);
    console.log(`  ${r.ok ? 'OK  ' : 'FAIL'}  ${r.label.padEnd(38)} ${r.ok ? 'put/head/get/delete round-trip clean' : r.stage + ' -> ' + r.err}`);
    if (r.ok && !winner) winner = { forcePathStyle: ps, region: rg };
  }

  console.log('');
  if (!winner) {
    console.log('No configuration worked. The credential, the bucket name, or the endpoint is wrong.');
    process.exit(1);
  }
  console.log(`WINNER: forcePathStyle=${winner.forcePathStyle} region=${winner.region}`);
  console.log(`  -> ${side}_REGION=${winner.region}`);
  if (winner.forcePathStyle !== true) {
    console.log(`  -> this endpoint needs VIRTUAL-HOST addressing; set ${side}_FORCE_PATH_STYLE=0`);
  }
  process.exit(0);
})();
