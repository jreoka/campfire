#!/usr/bin/env node
// scripts/verify-clamd.js
//
// Prove a clamd really scans, using the SAME protocol path the app uses. Run it
// wherever CLAM_HOST resolves (inside the app container, or on the host against
// a published port).
//
//   CLAM_HOST=clamd CLAM_PORT=3310 node scripts/verify-clamd.js
//
// It checks four things, in order of how much they would hurt to get wrong:
//
//   1. PING            - is the daemon there and answering?
//   2. the EICAR string- does detection actually work? A scanner that says OK to
//                        everything is worse than no scanner, because it is
//                        believed. EICAR is the industry's harmless test file;
//                        it is assembled from fragments below so this repo never
//                        contains the literal signature (some AV products
//                        quarantine it on sight, including on checkout).
//   3. a 50 MB body    - MAX_FILE_MB is 50, and clamd refuses anything over
//                        StreamMaxLength. If that default were the 25M an older
//                        clamd.conf sample shows, every large upload would fail
//                        the scan and be rejected. This measures it instead of
//                        trusting the config comment.
//   4. a clean body    - a plain buffer must come back OK, so (2) is not just an
//                        always-guilty engine.
//
// Exit code 0 only if every expectation held.

'use strict';

const net = require('net');

const HOST = process.env.CLAM_HOST || '127.0.0.1';
const PORT = Math.max(1, parseInt(process.env.CLAM_PORT || '3310', 10) || 3310);
const LARGE_MB = parseInt(process.env.VERIFY_LARGE_MB || '50', 10);

// Assembled, never a single literal.
const EICAR = [
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$',
  'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!',
  '$H+H*',
].join('');

function ping(timeoutMs = 5000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const sock = net.createConnection({ host: HOST, port: PORT });
    const t = setTimeout(() => { try { sock.destroy(); } catch {} finish(false); }, timeoutMs);
    sock.on('connect', () => sock.write('PING\n'));
    sock.on('data', (d) => {
      if (d.toString('utf8').includes('PONG')) { clearTimeout(t); try { sock.destroy(); } catch {} finish(true); }
    });
    sock.on('error', () => { clearTimeout(t); finish(false); });
    sock.on('close', () => { clearTimeout(t); finish(false); });
  });
}

// Minimal INSTREAM client - the same shape as virus-scan.js's, deliberately:
// streaming, so a 50 MB body never has to be held by the daemon.
function scanBuffer(buf, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    let done = false;
    let resp = '';
    const sock = net.createConnection({ host: HOST, port: PORT });
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(t); try { sock.destroy(); } catch {} fn(arg); };
    const t = setTimeout(() => finish(reject, new Error('timeout')), timeoutMs);
    sock.on('connect', () => {
      sock.write(Buffer.concat([Buffer.from('zINSTREAM'), Buffer.from([0])]));
      const CHUNK = 1 << 20;
      for (let off = 0; off < buf.length; off += CHUNK) {
        const slice = buf.subarray(off, Math.min(off + CHUNK, buf.length));
        const head = Buffer.alloc(4);
        head.writeUInt32BE(slice.length, 0);
        sock.write(Buffer.concat([head, slice]));
      }
      sock.write(Buffer.from([0, 0, 0, 0])); // zero-length chunk terminates
    });
    sock.on('data', (d) => {
      resp += d.toString('utf8');
      // z-commands answer with a NUL terminator, not a newline.
      if (resp.includes('\0') || resp.includes('\n')) finish(resolve, resp.replace(/\0/g, '').trim());
    });
    sock.on('error', (e) => finish(reject, e));
    sock.on('close', () => { if (!done) finish(reject, new Error('closed without a verdict: ' + resp.slice(0, 120))); });
  });
}

(async () => {
  console.log(`verify-clamd -> ${HOST}:${PORT}`);
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name.padEnd(34)} ${detail}`); };

  if (!(await ping())) {
    check('PING', false, 'no PONG - is clamd up, and does CLAM_HOST resolve from here?');
    console.log('\nclamd did not answer. Nothing else can be checked.');
    process.exit(1);
  }
  check('PING', true, 'PONG');

  try {
    const v = await scanBuffer(Buffer.from(EICAR, 'utf8'));
    const detected = /FOUND/i.test(v) && /Eicar/i.test(v);
    check('detects the EICAR test string', detected, detected ? v : `expected FOUND Eicar..., got: ${v}`);
  } catch (e) {
    check('detects the EICAR test string', false, String(e.message || e));
  }

  try {
    const large = Buffer.alloc(LARGE_MB * 1024 * 1024, 0x41); // 'A' x N, compresses, cheap to build
    const t0 = Date.now();
    const v = await scanBuffer(large);
    const ok = /OK/i.test(v) && !/FOUND/i.test(v);
    check(`scans a ${LARGE_MB} MB body`, ok, ok ? `${v} in ${((Date.now() - t0) / 1000).toFixed(1)}s` : `got: ${v}`);
  } catch (e) {
    check(`scans a ${LARGE_MB} MB body`, false, `${String(e.message || e)} (a size-limit rejection here means StreamMaxLength is below MAX_FILE_MB)`);
  }

  try {
    const v = await scanBuffer(Buffer.from('campfire verify-clamd: unambiguously harmless content\n'.repeat(20), 'utf8'));
    const ok = /OK/i.test(v) && !/FOUND/i.test(v);
    check('clears a harmless body', ok, ok ? v : `got: ${v}`);
  } catch (e) {
    check('clears a harmless body', false, String(e.message || e));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `\n${failed.length} check(s) FAILED` : '\nall checks passed - this scanner detects, clears, and accepts a full-size upload');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(`verify-clamd: ${(e && e.message) || e}`);
  process.exit(2);
});
