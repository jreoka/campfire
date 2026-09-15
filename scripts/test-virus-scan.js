#!/usr/bin/env node
// scripts/test-virus-scan.js
//
// Offline unit tests for the malware-scan engine module: no server, no
// database, no real ClamAV. Four units carry real logic and each is exercised
// the way the app drives it:
//
//   1. `openBytes` — turning a stored object into a STREAM the daemon can be fed.
//      The S3 branch is the one production runs (media lives in OVH object
//      storage) and the one a local test server never reaches, so it is stubbed
//      here rather than left to a deploy to discover.
//   2. `parseScanReply` / `parseVersion` — the daemon's own words into a verdict
//      and an engine identity. ClamAV's contract has one trap: two outcomes only
//      (`stream: OK` and `stream: <Signature> FOUND`), so ANY other reply is not
//      a verdict and must throw rather than read as clean.
//   3. `probe` — that the daemon is up, WHICH ClamAV and signature database it
//      is, and (with CLAMAV_VERIFY_EICAR=1) that it actually detects the EICAR
//      test string. A daemon whose database failed to load answers OK to
//      everything, which is worse than no scanner because it is believed.
//   4. the bucket sweep's classification, against the engine GENERATION each row
//      was judged by (`clamav/1.4.6`) — including the rows a previous engine
//      left behind, which are the whole reason a pass exists.
//
// The daemon is the stand-in (scripts/fake-clamd.js), which speaks the real wire
// protocol in-process, so this needs no container.
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
// The daemon's address has to be in the environment BEFORE virus-scan.js (and
// therefore clamav.js) is required, because the client resolves it at load — as
// does the EICAR switch, which is what the probe's "does it actually detect?"
// check is gated on.
process.env.CLAMAV_VERIFY_EICAR = '1';
const fake = require(path.join(__dirname, 'fake-clamd'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// The modules hold no connection between calls, so moving CLAMAV_PORT is enough
// to point them at a different stand-in daemon.
function pointAt(port) { process.env.CLAMAV_HOST = '127.0.0.1'; process.env.CLAMAV_PORT = String(port); }
function reloadModules() {
  for (const m of ['clamav', 'virus-scan']) delete require.cache[require.resolve(path.join(ROOT, m))];
  return { clamav: require(path.join(ROOT, 'clamav')), vs: require(path.join(ROOT, 'virus-scan')) };
}

(async () => {
  const daemon = await fake.start();
  pointAt(daemon.port);
  const { clamav, vs } = reloadModules();

  console.log('\n[1] openBytes: a stored object becomes a stream the daemon can read');
  const localKey = 'files/local-object.bin';
  fs.mkdirSync(path.dirname(path.join(UPLOADS, localKey)), { recursive: true });
  fs.writeFileSync(path.join(UPLOADS, localKey), 'on-disk bytes');
  const local = await vs._openBytes(localKey);
  check('a disk object opens as a stream', !!local && typeof local.stream.pipe === 'function', local && typeof local.stream);
  check('...carrying the real size', !!local && local.size === 'on-disk bytes'.length, local && local.size);
  check('...and is never staged anywhere', !!local && local.where === 'disk');
  const chunks = [];
  for await (const c of local.stream) chunks.push(c);
  check('...and its bytes are intact', Buffer.concat(chunks).toString() === 'on-disk bytes');
  check('a key that escapes the upload dir is refused', (await vs._openBytes('../../etc/passwd')) === null);
  check('a key that is not there is null, not a throw', (await vs._openBytes('files/absent.bin')) === null);

  console.log('\n[2] openBytes: S3 objects stream straight from the object store (production)');
  const storage = require(path.join(ROOT, 'storage'));
  let s3Mode = false;
  const objects = new Map();
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
  s3Mode = true;
  const body = Buffer.from('staged object bytes, arbitrary content');
  objects.set('files/s3-object.jpg', body);
  const remote = await vs._openBytes('files/s3-object.jpg');
  check('an S3 object opens as a stream', !!remote && typeof remote.stream.pipe === 'function');
  check('...with the size from the object store', !!remote && remote.size === body.length, remote && remote.size);
  check('...flagged as coming from the store', !!remote && remote.where === 's3');
  const got = [];
  for await (const c of remote.stream) got.push(c);
  check('...and its bytes are intact', Buffer.concat(got).equals(body));
  check('a missing S3 object is null (the row is dropped, nothing is gated)',
    (await vs._openBytes('files/gone.jpg')) === null);
  s3Mode = false;

  console.log('\n[3] parseVersion: the engine identity every verdict is recorded against');
  const v = clamav.parseVersion('ClamAV 1.4.6/28122/Sun Sep 13 06:26:25 2026');
  check('a real VERSION line parses', !!v && v.engine === '1.4.6' && v.db === '28122', JSON.stringify(v));
  check('...and keeps the database date', !!v && /Sep 13/.test(v.dbDate), v && v.dbDate);
  check('the engine generation is clamav/<version>', vs._identityFor(v) === 'clamav/1.4.6', vs._identityFor(v));
  check('a line that is not a VERSION is refused', clamav.parseVersion('not a clamav version line') === null);
  check('an empty VERSION is refused', clamav.parseVersion('') === null);

  console.log('\n[4] parseScanReply: the daemon answers a verdict, or it does not');
  const okReply = clamav.parseScanReply('stream: OK');
  check('a clean stream is clean', okReply.clean === true && !okReply.signature, JSON.stringify(okReply));
  const found = clamav.parseScanReply('stream: Eicar-Signature FOUND');
  check('a detection names the signature that matched', found.clean === false && found.signature === 'Eicar-Signature', JSON.stringify(found));
  const multi = clamav.parseScanReply('stream: Win.Trojan.Agent-1234-0 FOUND');
  check('a signature with punctuation survives intact', multi.signature === 'Win.Trojan.Agent-1234-0', multi.signature);
  const threw = (reply) => { try { clamav.parseScanReply(reply); return null; } catch (e) { return e.message; } };
  check('an ERROR reply throws — it is not a verdict, it is a refusal',
    /clamav_unreadable/.test(threw('INSTREAM size limit exceeded. ERROR') || ''), threw('INSTREAM size limit exceeded. ERROR'));
  check('UNKNOWN COMMAND throws too', /clamav_unreadable/.test(threw('UNKNOWN COMMAND') || ''));
  check('an empty reply throws rather than reading as clean', /clamav_unreadable/.test(threw('') || ''));

  console.log('\n[5] probe: the daemon runs, and WITH CLAMAV_VERIFY_EICAR it must detect');
  const probe = await clamav.probe();
  check('the stand-in daemon probes ready', probe.ok === true, JSON.stringify(probe));
  check('...and reports the ClamAV version', probe.engine === '1.4.6', probe.engine);
  check('...and the signature database revision', probe.db === '28122', probe.db);

  // A daemon whose database did not load answers OK to everything. Asking it to
  // detect EICAR is the only way to tell that from a working scanner.
  const lying = await fake.start();
  process.env.FAKE_CLAMAV_VERDICT = 'clean'; // answers OK even to EICAR
  pointAt(lying.port);
  const refused = await reloadModules().clamav.probe();
  check('a daemon that does not detect EICAR is REFUSED',
    refused.ok === false && refused.why === 'eicar_not_detected', JSON.stringify(refused));
  delete process.env.FAKE_CLAMAV_VERDICT;
  await lying.close();

  const mute = await fake.start();
  process.env.FAKE_CLAMAV_NO_VERSION = '1';
  pointAt(mute.port);
  const noVersion = await reloadModules().clamav.probe();
  check('a daemon that cannot say which ClamAV it is is REFUSED too',
    noVersion.ok === false && noVersion.why === 'no_version_reported', JSON.stringify(noVersion));
  delete process.env.FAKE_CLAMAV_NO_VERSION;
  await mute.close();

  // Nothing listening: the failure mode that must never read as "clean".
  pointAt(3399);
  const dead = await reloadModules().clamav.probe();
  check('a daemon that is not there reports itself unreachable (fail-open, loudly)',
    dead.ok === false && dead.why === 'clamav_unreachable', JSON.stringify(dead));
  pointAt(daemon.port);

  console.log('\n[6] scanStream: real bytes, verdict labels, and the engine mark');
  const mods = reloadModules();
  // The engine state a successful probe leaves behind; the probe itself is
  // covered in [5], and this keeps the verdict path free of the database.
  mods.vs._setEngineForTest({ engine: '1.4.6', db: '28122', dbDate: 'Sun Sep 13 06:26:25 2026' });
  const cleanSrc = { stream: Readable.from([Buffer.from('harmless staged bytes\n')]), size: 23, where: 's3', close: () => {} };
  const cleanVerdict = await mods.vs._scanStream(cleanSrc, { label: 'test' });
  check('a clean stream verdicts clean', cleanVerdict.clean === true, JSON.stringify(cleanVerdict));
  const cleanDetail = mods.vs._detailFor(cleanVerdict);
  check('...marked with the engine generation that judged it',
    cleanDetail.engine === 'clamav/1.4.6', cleanDetail.engine);
  check('...and with the signature revision it used', /signatures: 28122/.test(cleanDetail.evidence), cleanDetail.evidence);

  const badSrc = { stream: Readable.from([Buffer.from('holiday photo\n' + fake.MARKER + '\n')]), size: 40, where: 's3', close: () => {} };
  const badVerdict = await mods.vs._scanStream(badSrc, { label: 'test' });
  check('a detection is not clean and carries its signature',
    badVerdict.clean === false && badVerdict.signature === 'Fake-ClamAV-Test-Signature', JSON.stringify(badVerdict));
  check('...and its label names the engine', /^ClamAV: Fake-ClamAV-Test-Signature$/.test(mods.vs._virusLabel(badVerdict.signature)),
    mods.vs._virusLabel(badVerdict.signature));
  check('...and the evidence lists the signature it matched',
    /signature: Fake-ClamAV-Test-Signature/.test(mods.vs._detailFor(badVerdict).evidence), mods.vs._detailFor(badVerdict).evidence);
  check('a label is capped for the DB column', mods.vs._virusLabel('x'.repeat(400)).length <= 120);

  // An engine that answers something unreadable must NOT produce a verdict: the
  // row has to retry, not be published as clean. Two shapes, because they are
  // reached by different code paths: a daemon that cannot even be probed (the
  // engine is not ready, so the scan never runs) and one that is up but refuses
  // the bytes it is handed.
  const errDaemon = await fake.start();
  process.env.FAKE_CLAMAV_VERDICT = 'error';
  pointAt(errDaemon.port);
  const mods2 = reloadModules();
  let errMsg = null;
  try {
    await mods2.vs._scanStream({ stream: Readable.from([Buffer.from('anything')]), size: 8, where: 's3', close: () => {} }, { label: 'test' });
  } catch (e) { errMsg = e.message; }
  check('a daemon that cannot answer a scan produces NO verdict (the row retries)',
    /clamav_unreadable|clamav_unavailable/.test(errMsg || ''), String(errMsg));

  // Now the same refusal from an engine that HAS probed ready: the scan itself
  // answers ERROR, which must throw rather than settle the row clean. The engine
  // state is set directly (the probe path is covered above) so this exercises
  // ONLY the verdict path — and needs no database, which startVirusScan owns.
  const good = await fake.start();
  pointAt(good.port);
  const mods2b = reloadModules();
  mods2b.vs._setEngineForTest({ engine: '1.4.6', db: '28122', dbDate: 'Sun Sep 13 06:26:25 2026' });
  process.env.FAKE_CLAMAV_VERDICT = 'error';
  let errMsg2 = null;
  try {
    await mods2b.vs._scanStream({ stream: Readable.from([Buffer.from('anything')]), size: 8, where: 's3', close: () => {} }, { label: 'test' });
  } catch (e) { errMsg2 = e.message; }
  check('a REFUSAL from a ready engine throws too — never a silent clean',
    /clamav_unreadable/.test(errMsg2 || ''), String(errMsg2));
  delete process.env.FAKE_CLAMAV_VERDICT;
  await errDaemon.close();
  await good.close();
  pointAt(daemon.port);

  // The bucket sweep's classification decides which stored objects get
  // re-judged, so it is the one piece of it that must never be wrong: queueing a
  // key the current engine already judged re-scans it, and queueing an infected
  // one would drop the row that tells the chat a file was removed.
  console.log('\n[7] the bucket sweep only adopts keys THIS engine has not judged');
  const bs = require(path.join(ROOT, 'bucket-scan'));
  const rows = [
    { key: 'files/clean-now.jpg', status: 'clean', engine: 'clamav/1.4.6' },
    { key: 'files/clean-old-harbin.jpg', status: 'clean', engine: 'Harbin' },
    { key: 'files/clean-no-engine.jpg', status: 'clean', engine: '' },
    { key: 'files/clean-older-clamav.jpg', status: 'clean', engine: 'clamav/1.3.0' },
    { key: 'files/infected.exe', status: 'infected', engine: 'Harbin' },
    { key: 'files/inflight.jpg', status: 'pending', engine: '' },
    { key: 'files/broken.bin', status: 'error', engine: '' },
    { key: 'files/gone.bin', status: null, engine: '' },
  ];
  const c1 = bs._classify(rows, true, 'clamav/1.4.6');
  check('a key this engine already judged is never re-queued', c1.skip.has('files/clean-now.jpg'));
  check('a key a PREVIOUS engine judged is adopted (that is the point of a pass)',
    !c1.skip.has('files/clean-old-harbin.jpg'));
  check('a key from before any engine is adopted', !c1.skip.has('files/clean-no-engine.jpg'));
  check('a key an older ClamAV cleared is adopted (a new engine re-verifies the tree)',
    !c1.skip.has('files/clean-older-clamav.jpg'));
  check('an infected key is never touched — its row is the record of the removal',
    c1.skip.has('files/infected.exe'));
  check('a key already in flight is left to the queue', c1.skip.has('files/inflight.jpg'));
  check('a row that never got a verdict is retried while the engine answers',
    !c1.skip.has('files/broken.bin') && c1.errored === 1);
  check('...and is left alone when the engine is not answering',
    bs._classify(rows, false, '').skip.has('files/broken.bin'));
  check('the judged count is reported for the panel', c1.judged === 1, String(c1.judged));

  console.log('\n[8] the daemon only ever saw the bytes it was sent');
  const logPath = path.join(TMP, 'daemon.log');
  fs.writeFileSync(logPath, '');
  process.env.FAKE_CLAMAV_LOG = logPath;
  pointAt(daemon.port);
  const mods3 = reloadModules();
  mods3.vs._setEngineForTest({ engine: '1.4.6', db: '28122', dbDate: 'Sun Sep 13 06:26:25 2026' });
  const payload = Buffer.from('logged bytes, exactly 26\n');
  const src = { stream: Readable.from([payload]), size: payload.length, where: 's3', close: () => {} };
  await mods3.vs._scanStream(src, { label: 'test' });
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // The probe scans EICAR through this same daemon, which is a scan the engine
  // performed too — so the assertion is about the FILE's own bytes, not about
  // "only one INSTREAM ever happened".
  const mine = lines.filter((l) => Number(l.size) === payload.length);
  check('exactly one INSTREAM carried this file', mine.length === 1, JSON.stringify(lines));
  check('...and it was an INSTREAM', mine[0] && mine[0].command === 'INSTREAM', JSON.stringify(mine[0]));
  delete process.env.FAKE_CLAMAV_LOG;

  await fake.closeAll();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('virus-scan unit tests: OK');
})().catch((e) => { console.error('[test] FAILED:', (e && e.stack) || e); process.exit(1); });
