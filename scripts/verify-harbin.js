#!/usr/bin/env node
// scripts/verify-harbin.js
//
// Prove the Harbin engine really scans, using the SAME code path the app uses
// (virus-scan.js's runner and report parser). Run it wherever the engine
// resolves — inside the app container, or on a host with a built binary:
//
//   node scripts/verify-harbin.js
//   HARBIN_BIN=./harbin node scripts/verify-harbin.js
//
// Six checks, in order of how much it would hurt to get them wrong:
//
//   1. the engine runs AND has a model - a build with no embedded model answers
//      CLEAN to everything, which is worse than no scanner because it is
//      believed. The probe runs a real scan with HARBIN_VERBOSE=1 and reads the
//      model's shape off that (see probeEngine in virus-scan.js): the shipped
//      binary exposes no diagnostic flags at all, by upstream design, so asking
//      is a scan rather than a flag.
//   2. a synthetic all-writable-and-executable PE is detected. This is a
//      deterministic precision anchor, so it is a positive control that does
//      not require writing a virus signature anywhere.
//   3. the EICAR test string is detected - the industry's harmless acceptance
//      file. It is assembled from fragments below so this repo never contains
//      the literal signature, and it is written to a temp file only for the
//      duration of the check, because Harbin takes a path and not a stream.
//      A host-side antivirus will quarantine that file on some dev machines
//      (Windows Defender does, reliably); that is reported as SKIPPED rather
//      than a failure, with the reason, because it says nothing about Harbin.
//   4. a harmless body is cleared, so (2) and (3) are not an always-guilty
//      engine.
//   5. a full-size body (MAX_FILE_MB, 50 by default) is scanned and cleared.
//      Nothing about the pipeline may refuse the largest upload the app allows.
//   6. the same anchor from (2) is detected *inside a wrapper* - as a PDF's
//      `/EmbeddedFile`, in a document with no xref table. This is the one check
//      that proves the container stage does its job: if a payload can be hidden
//      inside a document and served, everything above it is decoration.
//
// Exit code 0 only if every check that ran held.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const vs = require(path.join(ROOT, 'virus-scan'));
const { rwxPe } = require('./rwx-pe');

const LARGE_MB = Math.max(1, parseInt(process.env.VERIFY_LARGE_MB || '50', 10) || 50);

// Assembled, never a single literal.
const EICAR = [
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$',
  'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!',
  '$H+H*',
].join('');

// The same synthetic PE the check above uses, carried as a PDF's `/EmbeddedFile`.
//
// This document has **no xref table at all**, on purpose. A PDF's index is
// optional and is routinely wrong in exactly the documents worth reading, so the
// engine has to recover the object graph by scanning for objects. That makes this
// the acceptance test for the container stage's whole reason to exist: the
// wrapper's own bytes are inert, and the only way to flag this file is to look
// inside it. A clean verdict here means someone could hide an executable in a
// document and have it served.
function pdfWithEmbeddedPe(pe) {
  const stream = zlib.deflateSync(pe);
  const head = Buffer.from(
    '%PDF-1.7\n'
    + '1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles '
    + '<< /Names [ (payload.exe) 4 0 R ] >> >> >>\nendobj\n'
    + '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n'
    + '4 0 obj\n<< /Type /Filespec /F (payload.exe) /UF (payload.exe) '
    + '/EF << /F 5 0 R >> >>\nendobj\n'
    + '5 0 obj\n<< /Type /EmbeddedFile /Length ' + stream.length
    + ' /Filter /FlateDecode >>\nstream\n',
    'latin1',
  );
  const tail = Buffer.from(
    '\nendstream\nendobj\ntrailer\n<< /Root 1 0 R /Size 6 >>\n%%EOF\n', 'latin1');
  return Buffer.concat([head, stream, tail]);
}

const results = [];
function check(name, ok, detail, skipped) {
  results.push({ name, ok, skipped: !!skipped });
  const mark = skipped ? 'SKIP' : ok ? 'OK  ' : 'FAIL';
  console.log(`  ${mark}  ${name.padEnd(36)} ${detail}`);
}

// One engine run over an in-memory body, exactly the way the worker does it:
// bytes to a path, path to the engine, report line to the parser.
async function scanBuffer(dir, label, buf, timeoutMs) {
  const p = path.join(dir, label);
  fs.writeFileSync(p, buf);
  const run = await vs._runHarbinRaw(p, timeoutMs || 120000);
  let verdict = null;
  let error = null;
  try { verdict = vs._verdictFrom(run); } catch (e) { error = String((e && e.message) || e); }
  return { run, verdict, error, size: buf.length };
}

(async () => {
  const engine = process.env.HARBIN_BIN || 'harbin';
  console.log(`verify-harbin -> ${engine}`);

  // ---- 1. the engine, and a model inside it ----
  const probe = await vs._probeEngine();
  if (!probe.ok) {
    check('engine runs with a detection model', false,
      probe.why === 'harbin_binary_not_found'
        ? `"${engine}" not found - is it on PATH, or set HARBIN_BIN?`
        : `engine answered "${probe.why}"`);
    console.log('\nThe engine did not come up. Nothing else can be checked.');
    process.exit(1);
  }
  const m = probe.model;
  check('engine runs with a detection model', true,
    `${m.trees} trees, ${m.nodes} nodes, ${m.features} features, max depth ${m.depth}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-verify-harbin-'));
  try {
    // ---- 2. a precision anchor, with no virus signature involved ----
    const pe = await scanBuffer(dir, 'rwx-test.exe', rwxPe(), 60000);
    check('detects an all-writable+executable PE', !!pe.verdict && pe.verdict.clean === false,
      pe.error ? pe.error : (pe.verdict && pe.verdict.virus) || 'no verdict');

    // ---- 3. EICAR ----
    const eicar = await scanBuffer(dir, 'eicar-test.com', Buffer.from(EICAR, 'utf8'), 60000);
    if (eicar.error && /unreadable/i.test(eicar.error)) {
      // The file was removed between the write and the read: a host-side
      // antivirus got it first. Meaningful only on a dev machine.
      check('detects the EICAR test string', false,
        'SKIPPED - a host-side antivirus quarantined the file before Harbin could read it; '
        + 'run this check on the server, where nothing else is watching the temp dir', true);
    } else {
      const hit = !!eicar.verdict && eicar.verdict.clean === false;
      check('detects the EICAR test string', hit,
        eicar.error ? eicar.error : hit ? eicar.verdict.virus : 'the engine cleared EICAR');
    }

    // ---- 4. a harmless body ----
    const clean = await scanBuffer(dir, 'harmless.txt',
      Buffer.from('campfire verify-harbin: unambiguously harmless content\n'.repeat(20), 'utf8'), 60000);
    const cleared = !!clean.verdict && clean.verdict.clean === true;
    check('clears a harmless body', cleared,
      clean.error ? clean.error : cleared ? 'clean' : 'flagged harmless text - the engine is always-guilty');

    // ---- 5. the largest thing an upload can hand it ----
    const large = Buffer.alloc(LARGE_MB * 1024 * 1024, 0x41); // 'A' x N: cheap to build, no structure
    const t0 = Date.now();
    const big = await scanBuffer(dir, `large-${LARGE_MB}mb.bin`, large, 600000);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const okBig = !!big.verdict && big.verdict.clean === true;
    check(`scans a ${LARGE_MB} MB body`, okBig,
      big.error ? `${big.error} (a refusal here means the largest allowed upload could never be scanned)`
        : okBig ? `clean in ${secs}s` : 'flagged a body of repeated bytes');

    // ---- 6. a payload hidden inside a wrapper ----
    // The whole point of the container stage: a detector that scores the wrapper
    // is defeated by wrapping. This carries the check-2 anchor as a PDF's
    // `/EmbeddedFile` in a document with no xref table, so recovering the object
    // graph is the only way to see it.
    const pdfRun = await scanBuffer(dir, 'embedded-payload.pdf', pdfWithEmbeddedPe(rwxPe()), 60000);
    const pdfHit = !!pdfRun.verdict && pdfRun.verdict.clean === false;
    check('detects a PE embedded in a PDF', pdfHit,
      pdfRun.error ? pdfRun.error
        : pdfHit ? pdfRun.verdict.virus
          : 'cleared a document carrying the anchor as an /EmbeddedFile: a wrapper is hiding a payload');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  const failed = results.filter((r) => !r.ok && !r.skipped);
  const skipped = results.filter((r) => r.skipped).length;
  if (failed.length) {
    console.log(`\n${failed.length} check(s) FAILED${skipped ? ` (${skipped} skipped)` : ''}`);
    process.exit(1);
  }
  console.log(`\nall checks passed${skipped ? ` (${skipped} skipped)` : ''} - this engine detects, clears, sees inside a wrapper, and accepts a full-size upload`);
  process.exit(0);
})().catch((e) => {
  console.error(`verify-harbin: ${(e && e.stack) || e}`);
  process.exit(2);
});
