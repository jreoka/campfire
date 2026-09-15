#!/usr/bin/env node
// scripts/verify-clamav.js
//
// Acceptance check against a REAL ClamAV daemon — not the stand-in the test
// suite uses. Run it wherever the engine is supposed to be answering:
//
//   docker compose exec campfire node scripts/verify-clamav.js
//
// It asks the questions that decide whether scanning is worth anything, in the
// order that makes a failure diagnosable, and it asks them by USING the daemon
// (never by trusting a flag or a file on disk):
//
//   1. the daemon answers at all (PING/VERSION) and WHICH ClamAV it is;
//   2. its signature database is loaded, and how old it is (a daemon running a
//      stale database is a real and silent failure mode, so a database older
//      than STALE_DAYS is reported as a WARNING with the command to fix it);
//   3. it DETECTS: the EICAR test string comes back as a detection. A ClamAV
//      whose database failed to load answers OK to everything — worse than no
//      scanner, because it is believed — and this is the check that catches it;
//   4. it does NOT condemn: a harmless body comes back clean, so an engine that
//      answers FOUND to everything is caught too;
//   5. a full-size body (50 MB, the app's own MAX_FILE_MB) is accepted through
//      INSTREAM rather than refused for exceeding a stream limit;
//   6. the app's own path agrees: virus-scan.js scans a file and returns the
//      verdict the app would store, marked with the engine generation.
//
// Usage: node scripts/verify-clamav.js
// Env:   CLAMAV_HOST / CLAMAV_PORT (defaults `clamav` / 3310, see clamav.js)
//        VERIFY_STALE_DAYS  signature age that counts as stale (default 7)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const ROOT = path.join(__dirname, '..');
const clamav = require(path.join(ROOT, 'clamav'));
const STALE_DAYS = Math.max(1, parseInt(process.env.VERIFY_STALE_DAYS || '7', 10) || 7);
const BIG_BYTES = 50 * 1024 * 1024;

let failed = 0;
let warned = 0;
function ok(name, detail) { console.log('  ok    ' + name + (detail ? '  [' + detail + ']' : '')); }
function bad(name, detail) { failed++; console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
function warn(name, detail) { warned++; console.log('  warn  ' + name + (detail ? '  [' + detail + ']' : '')); }

const stream = (buf) => Readable.from([buf]);

async function main() {
  console.log('\nClamAV acceptance check — ' + clamav.host() + ':' + clamav.port());
  console.log('(the engine this app is actually configured to use)\n');

  // 1. Is anything there, and what is it?
  let ver = null;
  try { ver = await clamav.version(); }
  catch (e) { bad('the daemon answers', String((e && e.message) || e)); }
  if (ver) ok('the daemon answers VERSION', ver);
  if (!ver) {
    console.log('\nFAILED: nothing is listening on ' + clamav.host() + ':' + clamav.port()
      + '\n  the app fails OPEN in this state: uploads are served unscanned.'
      + '\n  bring the scanner up with: docker compose up -d clamav\n');
    process.exit(1);
  }
  const info = clamav.parseVersion(ver);
  if (info) ok('and it parses as ClamAV', info.engine + ' / signatures ' + info.db);
  else bad('the VERSION line parses', ver);

  // 2. Are the signatures loaded, and are they current?
  if (info) {
    ok('a signature database is loaded', info.db);
    const when = Date.parse(info.dbDate);
    // The database DATE is what freshclam stamped, which is the honest age.
    if (Number.isFinite(when)) {
      const days = (Date.now() - when) / 86400000;
      if (days > STALE_DAYS) {
        warn('the signature database is ' + days.toFixed(1) + ' days old',
          'is freshclam running? docker compose logs clamav | tail -50');
      } else {
        ok('the signature database is current', days < 1 ? 'today' : days.toFixed(1) + ' days old');
      }
    } else {
      warn('the database date could not be parsed', info.dbDate);
    }
  }

  // 3. Does it actually DETECT? The EICAR string, written to a temp file (never
  // a literal in this repository, which a checkout-time AV scan would quarantine)
  // and streamed to the daemon the same way an upload is.
  const eicar = Buffer.from(clamav.EICAR + '\n');
  try {
    const v = await clamav.scanStream(stream(eicar), { size: eicar.length, label: 'eicar' });
    if (v.clean) bad('the EICAR test string is DETECTED', 'the daemon answered OK — its database is not loaded or not matching');
    else ok('the EICAR test string is DETECTED', v.signature);
  } catch (e) { bad('the EICAR test string is DETECTED', String((e && e.message) || e)); }

  // 4. ...without condemning everything.
  const harmless = Buffer.from('campfire acceptance probe: harmless text\n');
  try {
    const v = await clamav.scanStream(stream(harmless), { size: harmless.length, label: 'harmless' });
    if (v.clean) ok('a harmless body is CLEAN', String(v.bytes) + ' bytes');
    else bad('a harmless body is CLEAN', 'flagged as ' + v.signature);
  } catch (e) { bad('a harmless body is CLEAN', String((e && e.message) || e)); }

  // 5. The app's whole upload cap fits through INSTREAM. A daemon left on its
  // default StreamMaxLength refuses big uploads instead of judging them, and a
  // refusal is an error — not a clean verdict — so uploads would stall in
  // `pending` and then fail open, which is exactly what this catches.
  const big = Buffer.alloc(BIG_BYTES, 0x61);
  const t0 = Date.now();
  try {
    const v = await clamav.scanStream(stream(big), { size: big.length, label: 'full-size' });
    if (v.clean) ok('a 50 MB body is accepted and scanned', Math.round((Date.now() - t0) / 100) / 10 + 's');
    else bad('a 50 MB body is accepted and scanned', 'flagged as ' + v.signature);
  } catch (e) { bad('a 50 MB body is accepted and scanned', String((e && e.message) || e) + ' — raise CLAMD_CONF_StreamMaxLength/CLAMD_CONF_MaxScanSize'); }

  // 6. The app's own path, end to end, over a real temp file: this is what an
  // upload goes through, including the engine mark every verdict is stored with.
  const tmp = path.join(os.tmpdir(), 'cf-verify-clamav-' + process.pid + '.bin');
  try {
    fs.writeFileSync(tmp, eicar);
    const v = await clamav.scanFile(tmp, { label: 'verify-file' });
    if (v && v.clean === false) ok('the app\'s file path returns the same detection', v.signature);
    else bad('the app\'s file path returns the same detection', JSON.stringify(v));
  } catch (e) { bad('the app\'s file path returns the same detection', String((e && e.message) || e)); }
  finally { try { fs.unlinkSync(tmp); } catch {} }

  // The generation is what the app records on every verdict; a daemon that
  // cannot say which ClamAV it is cannot be recorded against, so the probe in
  // virus-scan.js refuses it. Check that refusal is not triggered here.
  const probe = await clamav.probe();
  if (probe.ok) ok('the app\'s own engine probe accepts this daemon', (probe.engine || '') + (clamav.eicarVerification() ? ' · EICAR verified' : ''));
  else bad('the app\'s own engine probe accepts this daemon', probe.why);

  console.log('');
  if (failed) {
    console.log('FAILED: ' + failed + ' check(s)' + (warned ? ', ' + warned + ' warning(s)' : ''));
    process.exit(1);
  }
  console.log('ClamAV acceptance check: OK' + (warned ? ' (' + warned + ' warning(s) above)' : ''));
}

main().catch((e) => { console.error('[verify] FAILED:', (e && e.stack) || e); process.exit(1); });
