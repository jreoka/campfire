#!/usr/bin/env node
// scripts/fake-harbin.js
//
// A stand-in for the real Harbin engine: same one-argument contract, same exit
// codes, same report shape, and the same `HARBIN_VERBOSE` model line. It exists
// so the upload pipeline can be exercised end to end on any machine — no Rust
// toolchain, no compiled binary, and no dependence on what a particular model
// happens to score.
//
// Point the app at it with HARBIN_BIN. A `.js` path is run with the current
// Node binary rather than executed directly (virus-scan.js harbinCommand), so
// this works identically on Windows, macOS and Linux:
//
//   HARBIN_BIN="$PWD/scripts/fake-harbin.js" node server.js
//
// What it decides, in order:
//   1. the bytes contain the malware marker  -> MALWARE   (see MARKER below)
//   2. the bytes contain the EICAR marker    -> MALWARE
//   3. the bytes contain the suspect marker  -> SUSPECT
//   4. FAKE_HARBIN_VERDICT forces a verdict
//   5. otherwise                             -> CLEAN
//
// The markers are content, never a file name: the whole point of the upload
// pipeline is that a renamed extension buys an attacker nothing, and a stand-in
// that keyed on the name would quietly stop testing that.
//
// Env:
//   FAKE_HARBIN_DELAY_MS  sleep before answering (default 0). A real Harbin scan
//                         is milliseconds, too fast to observe the `pending`
//                         state; a test sets this to make it deterministic.
//   FAKE_HARBIN_VERDICT   clean | suspect | malware — force it, ignore content
//   FAKE_HARBIN_MODEL     =none reports a model-less build, and =silent prints
//                         no model diagnostics at all; the probe must refuse
//                         BOTH (a scanner that answers CLEAN to everything is
//                         worse than none, and one that cannot say what model
//                         it loaded has not proved it has one)
//   FAKE_HARBIN_LOG       append one JSON line per answered scan
//                         ({"tag","size","path"}) — how a test asserts WHICH
//                         bytes were put in front of the engine, and how many
//                         times, without guessing from timing
//
// Exit codes match Harbin: 0 nothing found, 1 a threat, 2 could not run.

'use strict';

const fs = require('fs');

const MARKER = 'FAKE-HARBIN-MALWARE-MARKER';
const SUSPECT_MARKER = 'FAKE-HARBIN-SUSPECT-MARKER';
// Assembled from fragments, never one literal: this repo should not contain a
// contiguous EICAR signature that a checkout-time AV scan would quarantine.
const EICAR = [
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$',
  'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!',
  '$H+H*',
].join('');

const args = process.argv.slice(2);

const target = args.find((a) => !a.startsWith('--'));
if (!target) {
  console.error('Harbin - machine-learning static malware scanner');
  console.error('');
  console.error('usage: harbin <file-or-directory>');
  process.exit(2);
}

// The model diagnostics a REAL shipped Harbin build writes to stderr when
// HARBIN_VERBOSE is set. Its `--model-info` flag is compiled out of the release
// binary (upstream's `devtools` feature), so a line like this, printed during a
// real scan, is the only way left to prove the engine came up carrying a model —
// which is what virus-scan.js's probeEngine reads it for. Order matters: the
// real engine reports the model before it reports the file.
const FAKE_MODEL = String(process.env.FAKE_HARBIN_MODEL || '').toLowerCase();
if (process.env.HARBIN_VERBOSE) {
  if (FAKE_MODEL === 'none') {
    console.error('harbin: running without a detection model');
  } else if (FAKE_MODEL !== 'silent') {
    console.error('harbin: model 258 trees / 17042 nodes / 15448 leaves / 4117 features / max depth 12');
  }
  // 'silent' is the shape of a build that says nothing at all about its model.
}

const delay = Math.max(0, parseInt(process.env.FAKE_HARBIN_DELAY_MS || '0', 10) || 0);
const LOG = process.env.FAKE_HARBIN_LOG || '';

function note(tag, size) {
  if (!LOG) return;
  try { fs.appendFileSync(LOG, JSON.stringify({ tag, size, path: target }) + '\n'); } catch {}
}

function report(tag, path, score, size, evidence) {
  note(tag, size);
  console.log(`[${tag}] ${path}  score ${score.toFixed(4)}  (${size} B)`);
  if (evidence) console.log('        evidence: ' + evidence);
  console.log('');
  console.log(`1 file(s) scanned in 0.00s (${size} B)`);
  if (tag === 'MALWARE') {
    console.log('  malicious 1   suspicious 0   clean 0   unreadable 0');
    console.log('verdict: 1 malicious, 0 suspicious');
  } else if (tag === 'SUSPECT') {
    console.log('  malicious 0   suspicious 1   clean 0   unreadable 0');
    console.log('verdict: 0 malicious, 1 suspicious');
  } else {
    console.log('  malicious 0   suspicious 0   clean 1   unreadable 0');
    console.log('verdict: no threats detected');
  }
}

(async () => {
  let buf = null;
  try {
    buf = fs.readFileSync(target);
  } catch (e) {
    // Shaped exactly like the real thing's unreadable-input answer: the engine
    // ran, it just could not judge the bytes.
    note('ERROR', 0);
    console.log(`[ERROR] ${target}  score 0.0000  (0 B)`);
    console.log('        cannot read: ' + String((e && e.message) || e).slice(0, 140));
    console.log('');
    console.log('1 file(s) scanned in 0.00s (0 B)');
    console.log('  malicious 0   suspicious 0   clean 0   unreadable 1');
    console.log('verdict: no threats detected');
    process.exit(2);
  }

  if (delay) await new Promise((r) => setTimeout(r, delay));

  const text = buf.toString('latin1');
  const forced = String(process.env.FAKE_HARBIN_VERDICT || '').toLowerCase();
  const has = (needle) => text.includes(needle);

  if (forced === 'malware' || (!forced && (has(MARKER) || has('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')))) {
    const eicar = !forced && has('EICAR-STANDARD-ANTIVIRUS-TEST-FILE');
    report('MALWARE', target, eicar ? 1.0 : 0.9987, buf.length,
      eicar ? 'EICAR test file' : 'process-injection API cluster');
    process.exit(1);
  }
  if (forced === 'suspect' || (!forced && has(SUSPECT_MARKER))) {
    report('SUSPECT', target, 0.71, buf.length, 'sparse import table (9 symbols)');
    process.exit(0);
  }
  report('CLEAN', target, 0.0021, buf.length, '');
  process.exit(0);
})();
