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
// Seven checks, in order of how much it would hurt to get them wrong:
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
//   7. a Quantum-compressed cabinet is READ, not merely named. Quantum was the
//      one cabinet scheme the engine could name and not decode - it reported the
//      folder's level and memory code and scored nothing inside - and the way it
//      fails is silent: the folder is skipped, so the wrapper is served as if it
//      were empty. The cabinet below is built here byte by byte, because what
//      makes this check possible is a detail the file does not contain: the
//      format's driver appends a 0xFF after every compressed block so the
//      decoder's 32 KiB frame realignment can find the end of a frame, and the
//      blocks themselves carry none. A raw concatenation of the same blocks
//      decodes to nothing, so this is also the check that would catch that byte
//      being dropped upstream.
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

// The compressed bytes of a real Quantum cabinet's folder, as the format's driver
// hands them to the decoder: sixteen blocks, each followed by the `0xFF` the
// driver synthesises. The `0xFF` bytes are NOT in the cabinet - see the note on
// check 7 - so the odd bytes at every 15th-ish position below are the whole reason
// a correct decoder works and a naive one decodes nothing.
const QTM_FOLDER = Buffer.from([
  0xFF, 0x6D, 0xDA, 0x34, 0x62, 0x1A, 0x9B, 0xA9, 0x92, 0x04, 0xD2, 0x80, 0x00, 0x20, 0xFF, 0x69,
  0x33, 0x90, 0x00, 0x06, 0x00, 0xFF, 0x62, 0x63, 0x00, 0x00, 0x60, 0xFF, 0x5D, 0x88, 0x00, 0x00,
  0xC0, 0xFF, 0x69, 0x54, 0x00, 0x01, 0x80, 0xFF, 0x63, 0x96, 0x00, 0x00, 0xC0, 0xFF, 0x6A, 0x28,
  0x00, 0x01, 0x80, 0xFF, 0x64, 0xF0, 0x00, 0x01, 0x80, 0xFF, 0x6B, 0x14, 0x00, 0x01, 0x80, 0xFF,
  0x94, 0x46, 0x00, 0x00, 0xC0, 0xFF, 0xF9, 0x30, 0x00, 0x03, 0x00, 0xFF, 0xF9, 0x8B, 0x80, 0x00,
  0x30, 0xFF, 0xF3, 0x48, 0x00, 0x01, 0x80, 0xFF, 0xF8, 0xE1, 0x00, 0x00, 0x30, 0xFF, 0xF2, 0xFA,
  0x00, 0x00, 0x60, 0xFF, 0xFA, 0xCE, 0x00, 0x00, 0xC0, 0xFF,
]);

// How many of those bytes belong to each block. Every block but the last is a
// full 32 KiB frame; the last is short, which is why the folder is 524,159 bytes
// and not a multiple of 32 KiB.
const QTM_BLOCK_SIZES = [14, 6, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
const QTM_MEMBER = 'zeroes';

// A whole cabinet around that folder, built here so no binary fixture is
// committed. The layout is the format's: a 36-byte header, an 8-byte folder
// record, a 16-byte file record, the NUL-terminated name, then one 8-byte
// `CFDATA` record per block - a 4-byte per-block checksum this cabinet leaves
// unset, the compressed size, and the uncompressed size the block declares.
function quantumCabinet() {
  const blocks = [];
  let at = 0;
  for (let i = 0; i < QTM_BLOCK_SIZES.length; i++) {
    const n = QTM_BLOCK_SIZES[i];
    blocks.push({
      data: QTM_FOLDER.subarray(at, at + n),
      declared: i === QTM_BLOCK_SIZES.length - 1 ? 32639 : 32768,
    });
    at += n + 1; // the block, then the trailer the driver synthesises
  }
  if (at !== QTM_FOLDER.length) {
    throw new Error('the Quantum fixture\'s block sizes do not account for its bytes');
  }
  const total = blocks.reduce((sum, b) => sum + b.declared, 0);

  const header = Buffer.alloc(36);
  header.write('MSCF', 0, 'latin1');
  header.writeUInt32LE(0, 4);
  header.writeUInt32LE(0, 8);          // cbCabinet, patched once the size is known
  header.writeUInt32LE(0, 12);
  header.writeUInt32LE(44, 16);        // coffFiles: right after the folder record
  header.writeUInt32LE(0, 20);
  header.writeUInt8(3, 24);            // version 1.3
  header.writeUInt8(1, 25);
  header.writeUInt16LE(1, 26);         // one folder
  header.writeUInt16LE(1, 28);         // one file
  header.writeUInt16LE(0, 30);         // flags: no per-record reserve sizes
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);

  const name = Buffer.from(QTM_MEMBER + '\0', 'latin1');
  const folder = Buffer.alloc(8);
  folder.writeUInt32LE(44 + 16 + name.length, 0); // where the first CFDATA starts
  folder.writeUInt16LE(blocks.length, 4);
  // Scheme 2 (Quantum) in the low nibble, level 2 and memory code 18 in the high
  // bits. The memory code is the window: 18 means 256 KiB, and it is load-bearing
  // - a decoder handed the wrong one produces plausible bytes rather than failing.
  folder.writeUInt16LE(0x1222, 6);

  const file = Buffer.alloc(16);
  file.writeUInt32LE(total, 0);
  file.writeUInt32LE(0, 4);
  file.writeUInt16LE(0, 8);            // iFolder: this folder
  file.writeUInt16LE(0x4CF2, 10);
  file.writeUInt16LE(0x7406, 12);
  file.writeUInt16LE(0x20, 14);        // FILE_ATTRIBUTE_ARCHIVE

  const parts = [header, folder, file, name];
  for (const b of blocks) {
    const record = Buffer.alloc(8);
    record.writeUInt32LE(0, 0);        // checksum unset: nothing to verify against
    record.writeUInt16LE(b.data.length, 4);
    record.writeUInt16LE(b.declared, 6);
    parts.push(record, b.data);
  }
  const cab = Buffer.concat(parts);
  cab.writeUInt32LE(cab.length, 8);
  return cab;
}

const results = [];function check(name, ok, detail, skipped) {
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

    // ---- 7. a scheme the engine used to only name ----
    // The member here is a run of zero bytes, so the verdict is CLEAN either way -
    // what is being checked is the evidence, which is the only place a skipped
    // folder shows up. A folder that was decoded reports its member; a folder that
    // was not names itself and says the cabinet held no recoverable members, which
    // is why this asserts on both the member and the absence of that refusal.
    const qtm = await scanBuffer(dir, 'quantum.cab', quantumCabinet(), 60000);
    // `verdictFrom` keeps what the engine actually said under `detail`, which is
    // where the evidence lines are - a clean verdict is not the absence of output.
    const qf = (qtm.verdict && qtm.verdict.detail && qtm.verdict.detail.findings) || [];
    const refusal = qf.find((f) => /not decoded|no recoverable members|outside the format/i.test(f));
    const read = qf.some((f) => /CAB container: \d+ member\(s\) inspected/.test(f)
      && f.includes(`'${QTM_MEMBER}'`));
    check('reads a Quantum-compressed cabinet', !!qtm.verdict && !refusal && read,
      qtm.error ? qtm.error
        : refusal ? `the Quantum folder was named rather than read - ${refusal}`
          : read ? 'decoded, and its member inspected'
            : `no member was inspected: ${qf.join(' | ') || String(qtm.run.stdout || '').replace(/\s+/g, ' ').trim()}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  const failed = results.filter((r) => !r.ok && !r.skipped);
  const skipped = results.filter((r) => r.skipped).length;
  if (failed.length) {
    console.log(`\n${failed.length} check(s) FAILED${skipped ? ` (${skipped} skipped)` : ''}`);
    process.exit(1);
  }
  console.log(`\nall checks passed${skipped ? ` (${skipped} skipped)` : ''} - this engine detects, clears, sees inside a wrapper and a Quantum cabinet, and accepts a full-size upload`);
  process.exit(0);
})().catch((e) => {
  console.error(`verify-harbin: ${(e && e.stack) || e}`);
  process.exit(2);
});
