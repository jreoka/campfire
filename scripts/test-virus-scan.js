#!/usr/bin/env node
// scripts/test-virus-scan.js
//
// Offline unit tests for the malware-scan engine module: no server, no
// database, no network. Three units carry real logic and each is exercised the
// way the app drives it:
//
//   1. `materialize` — turning a stored object into a PATH, which is all the
//      engine takes. The S3 branch is the one production runs (media lives in
//      R2) and the one a local test server never reaches, so it is stubbed
//      here rather than left to a deploy to discover.
//   2. `verdictFrom` — the report line and exit code into a verdict. Harbin's
//      contract has one trap: only a NUMERIC exit status is a verdict, and
//      `Number(null)` is 0, so a killed process must never read as "clean".
//   3. `probeEngine` — that the engine runs AND carries a model. A build with
//      no embedded model answers CLEAN to everything, which is worse than no
//      scanner because it is believed.
//
// Usage: node scripts/test-virus-scan.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-vscan-test-'));
const UPLOADS = path.join(TMP, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });
process.env.UPLOAD_DIR = UPLOADS;
process.env.HARBIN_TMP_DIR = path.join(TMP, 'staging');
process.env.HARBIN_BIN = path.join(__dirname, 'fake-harbin.js');

const storage = require(path.join(ROOT, 'storage'));
// Stub the object store BEFORE the module reads its flags. virus-scan holds the
// module object and calls these at call time, so replacing them here is enough.
let s3Mode = false;
let objects = new Map();
storage.s3Enabled = () => s3Mode;
storage.s3Head = async (key) => {
  if (!objects.has(key)) { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; }
  return { ContentLength: objects.get(key).length };
};
storage.s3Get = async (key) => {
  if (!objects.has(key)) { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; }
  return { Body: Readable.from([objects.get(key)]) };
};
storage.s3DeleteNow = async () => {};

const vs = require(path.join(ROOT, 'virus-scan'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const run = (over) => Object.assign({ code: 0, stdout: '', stderr: '', error: null }, over);
const verdict = (over) => { try { return vs._verdictFrom(run(over)); } catch (e) { return { threw: e.message }; } };

(async () => {
  console.log('\n[1] materialize: local disk scans the stored file in place');
  const localKey = 'files/local-object.bin';
  fs.mkdirSync(path.dirname(path.join(UPLOADS, localKey)), { recursive: true });
  fs.writeFileSync(path.join(UPLOADS, localKey), 'on-disk bytes');
  const local = await vs._materialize(localKey);
  check('a disk object resolves to its own path', !!local && local.path === path.join(UPLOADS, localKey), local && local.path);
  check('...and is never marked temporary, so nothing deletes the upload',
    !!local && local.temp === false && fs.existsSync(local.path));
  check('...with the real size', !!local && local.size === 'on-disk bytes'.length, local && local.size);
  check('a key that escapes the upload dir is refused', (await vs._materialize('../../etc/passwd')) === null);
  check('a key that is not there is null, not a throw', (await vs._materialize('files/absent.bin')) === null);

  console.log('\n[2] materialize: S3 objects are staged to a temp path (production)');
  s3Mode = true;
  const body = Buffer.from('staged object bytes, arbitrary content');
  objects.set('files/s3-object.jpg', body);
  const staged = await vs._materialize('files/s3-object.jpg');
  check('an S3 object resolves to a staged path', !!staged && staged.path.startsWith(path.join(TMP, 'staging')), staged && staged.path);
  check('...flagged temporary so the slot unlinks it', !!staged && staged.temp === true);
  check('...carrying the object byte for byte',
    !!staged && fs.readFileSync(staged.path).equals(body), staged && fs.readFileSync(staged.path).length + ' vs ' + body.length);
  check('...with the size from the bytes', !!staged && staged.size === body.length, staged && staged.size);
  check('the staged name carries the engine\'s own prefix',
    !!staged && path.basename(staged.path).startsWith(vs.TEMP_PREFIX), staged && path.basename(staged.path));
  check('a missing S3 object is null (the row is dropped, nothing is gated)',
    (await vs._materialize('files/gone.jpg')) === null);
  // A staged file is the engine's input, never something anyone else may be
  // reading, so the extension is decoration — but it must not be able to escape
  // the staging dir.
  const weird = await vs._materialize('files/../../etc/passwd');
  check('a traversal key still lands inside the staging dir',
    weird === null || path.resolve(weird.path).startsWith(path.resolve(path.join(TMP, 'staging'))), weird && weird.path);
  s3Mode = false;

  console.log('\n[3] verdictFrom: the report line and the exit code');
  check('a clean report is clean',
    verdict({ stdout: '[CLEAN] /tmp/x  score 0.0021  (12 B)\n' }).clean === true);
  const mal = verdict({ code: 1, stdout: '[MALWARE] /tmp/x  score 0.9987  (12 B)\n        evidence: process-injection API cluster\n' });
  check('a malicious report is not clean', mal.clean === false);
  check('...and its label names the engine and the evidence',
    /^Harbin: process-injection API cluster \(0\.9987\)$/.test(mal.virus || ''), mal.virus);
  const sus = verdict({ stdout: '[SUSPECT] /tmp/x  score 0.7100  (12 B)\n        evidence: sparse import table (9 symbols)\n' });
  check('a suspicious report is served, not blocked', sus.clean === true && !!sus.suspicious, JSON.stringify(sus));
  check('...and carries its own label',
    /^Harbin: sparse import table .*\(0\.7100\)$/.test(sus.suspicious || ''), sus.suspicious);
  check('an unreadable report throws (the row retries, it is not a verdict)',
    /harbin_unreadable/.test(verdict({ code: 2, stdout: '[ERROR] /tmp/x  score 0.0000  (0 B)\n        cannot read: Permission denied\n' }).threw || ''));
  check('exit 2 with no report line throws', /harbin_could_not_run/.test(verdict({ code: 2 }).threw || ''));
  check('a timeout with no exit status throws — never "clean"',
    /harbin_timeout/.test(verdict({ error: 'harbin_timeout' }).threw || ''));
  check('a missing binary throws — never "clean"',
    /harbin_binary_not_found/.test(verdict({ error: 'harbin_binary_not_found' }).threw || ''));
  check('exit 1 with no report line is still a threat',
    verdict({ code: 1 }).clean === false);
  check('a clean exit with nothing printed is clean', verdict({}).clean === true);
  check('the label is capped for the DB column', (mal.virus || '').length <= 120, String((mal.virus || '').length));

  console.log('\n[4] probeEngine: the engine must run AND carry a model');
  const ok = await vs._probeEngine();
  check('the stand-in engine probes ready', ok.ok === true, JSON.stringify(ok));
  check('...and reports the loaded model', !!ok.model && ok.model.trees === 258, JSON.stringify(ok.model));

  process.env.FAKE_HARBIN_MODEL = 'none';
  const none = await vs._probeEngine();
  check('a model-less build is REFUSED (it would answer clean to everything)',
    none.ok === false && none.why === 'no_detection_model', JSON.stringify(none));
  delete process.env.FAKE_HARBIN_MODEL;

  const savedBin = process.env.HARBIN_BIN;
  process.env.HARBIN_BIN = 'definitely-not-a-real-binary-xyz';
  delete require.cache[require.resolve(path.join(ROOT, 'virus-scan'))];
  const vs2 = require(path.join(ROOT, 'virus-scan'));
  const missing = await vs2._probeEngine();
  check('a missing binary reports itself as missing (fail-open, loudly)',
    missing.ok === false && missing.why === 'harbin_binary_not_found', JSON.stringify(missing));
  process.env.HARBIN_BIN = savedBin;

  console.log('\n[5] the staged path is a real file the engine can read');
  s3Mode = true;
  objects.set('files/scan-me.bin', Buffer.from('harmless staged bytes\n'));
  const target = await vs._materialize('files/scan-me.bin');
  const scanRun = await vs._runHarbinRaw(target.path, 30000);
  const scanVerdict = vs._verdictFrom(scanRun);
  check('the engine answers a staged object', scanVerdict.clean === true, JSON.stringify(scanVerdict));
  s3Mode = false;

  // The bucket sweep's classification decides which stored objects get
  // re-judged, so it is the one piece of it that must never be wrong: queueing a
  // key that was already judged re-scans it, and queueing an infected one would
  // drop the row that tells the chat a file was removed.
  console.log('\n[6] the bucket sweep only adopts keys no Harbin verdict covers');
  const bs = require(path.join(ROOT, 'bucket-scan'));
  const rows = [
    { key: 'files/clean-harbin.jpg', status: 'clean', engine: 'Harbin · 258 trees / 4117 features' },
    { key: 'files/clean-old-engine.jpg', status: 'clean', engine: '' },   // judged before Harbin existed
    { key: 'files/infected.exe', status: 'infected', engine: 'Harbin · 258 trees / 4117 features' },
    { key: 'files/inflight.jpg', status: 'pending', engine: '' },
    { key: 'files/broken.bin', status: 'error', engine: '' },
    { key: 'files/gone.bin', status: null, engine: '' },
  ];
  const c1 = bs._classify(rows, true);
  check('a key Harbin already judged is never re-queued', c1.skip.has('files/clean-harbin.jpg'));
  check('a key an earlier engine judged IS adopted (it has no Harbin verdict)',
    !c1.skip.has('files/clean-old-engine.jpg'));
  check('an infected key is never touched — its row is the record of the removal',
    c1.skip.has('files/infected.exe'));
  check('a key already in flight is left to the queue', c1.skip.has('files/inflight.jpg'));
  check('a row that never got a verdict is retried while the engine answers',
    !c1.skip.has('files/broken.bin') && c1.errored === 1);
  check('...and is left alone when the engine is not answering',
    bs._classify(rows, false).skip.has('files/broken.bin'));
  check('the judged count is reported for the panel', c1.judged === 1, String(c1.judged));

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('virus-scan unit tests: OK');
})().catch((e) => { console.error('[test] FAILED:', (e && e.stack) || e); process.exit(1); });
