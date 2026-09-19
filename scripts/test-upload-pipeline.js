// End-to-end check of the upload path: stored, SCANNED IN THE BACKGROUND, and
// SERVED IMMEDIATELY — with compression entirely out of band.
//
// What this replaced: an upload used to run through a scan -> compress -> scan
// slot that held the bytes back (423, "Processing file") until an ffmpeg pass
// and a second verdict had both finished. That stage is gone (owner request:
// "remove the processing file stage for uploads entirely and just clamav scan
// the files, and let the bucket compression sweep compress the files"). So:
//
//   - POST /api/upload answers `clean` and the bytes are fetchable at once; chat
//     renders the real file, never a scanning card. The scanner still judges
//     every byte — asserted by waiting for the row to settle and by reading what
//     the daemon was actually sent;
//   - a detection is still real: the bytes are deleted, the gate answers 410 and
//     the message is re-broadcast as blocked;
//   - the compatibility queue still repairs what a platform cannot open: a
//     WebM/Opus voice message (what Chrome's MediaRecorder produces, and what no
//     Apple product could play in an <audio> element before iOS 17.4) comes out
//     as AAC/MP4 in ONE channel with moov before mdat, published even though it
//     is the BIGGER file, and served in a 206 to a range request;
//   - ORDINARY media is left alone by the upload path AND by that queue: a fresh
//     JPEG stays byte-identical until the scheduled bucket sweep runs, which
//     republishes the smaller bytes under a NEW key and leaves the old object for
//     the orphan sweep (a byte swap behind a live URL is what that rule stops);
//   - stories and profile media are covered by the same sweep;
//   - with VIRUS_SCAN=0 nothing is judged at all and uploads still serve.
//
// Requirements: ffmpeg on PATH and Postgres reachable (docker compose up -d db).
// Skips (exit 0) with a message when either is missing.
//
// Usage: node scripts/test-upload-pipeline.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_test';
const PORT = parseInt(process.env.TEST_PORT || '3411', 10);
const DAEMON_PORT = parseInt(process.env.TEST_CLAMAV_PORT || '3412', 10);
const SCAN_DELAY_MS = 1500; // a slow stand-in leaves a window to prove the bytes are served during it
const fake = require(path.join(__dirname, 'fake-clamd'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[test]', ...a);

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

function readEnvFile() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}

// ---------- the stand-in daemon's log ----------
// The daemon answers over a socket, so what it was ASKED is only visible through
// what it wrote down: fake-clamd.js appends one JSON line per answered scan when
// FAKE_CLAMAV_LOG is set ({"command","size","reply"}). That is how the
// assertions below stay honest about *which bytes* reached the scanner — the
// size is the tell.
let engineLog = '';
function readEngineLog() {
  try {
    return fs.readFileSync(engineLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

// ---------- helpers ----------

async function api(method, p, body, token) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(j)}`);
  return j;
}

async function uploadFile(filePath, name, mime, token) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(filePath)], { type: mime }), name);
  const res = await fetch(`http://127.0.0.1:${PORT}/api/upload`, {
    method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('upload -> ' + res.status + ' ' + JSON.stringify(j));
  return j;
}

function connectWs(token) {
  return new Promise((resolve, reject) => {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
    ws.on('error', reject);
    ws.on('message', (raw) => { try { events.push(JSON.parse(raw.toString())); } catch {} });
    ws.on('open', () => resolve({
      events,
      send: (o) => ws.send(JSON.stringify(o)),
      close: () => { try { ws.close(); } catch {} },
    }));
  });
}

async function waitFor(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(150);
  }
}

// Same, for a predicate that has to hit the database or the network.
async function waitForAsync(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch {}
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(250);
  }
}

const sha256Of = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

async function waitForHttp(p, ms) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
      if (r.ok) return true;
    } catch {}
    if (Date.now() - t0 > ms) return false;
    await sleep(250);
  }
}

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', args, { stdio: 'ignore' });
  return r && r.status === 0;
}

// Every message-updated for this message that points somewhere OTHER than where
// the upload landed: the compressor republishing under a new key.
const republished = (events, mid, upUrl) => events.filter((e) => e.t === 'message-updated'
  && e.message && e.message.id === mid
  && (e.message.attachments || [])[0]
  && String(e.message.attachments[0].url).split('?')[0] !== String(upUrl).split('?')[0]);

// ---------- main ----------

async function main() {
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (!probe || probe.status !== 0) return skip('ffmpeg not found on PATH');

  const envFile = readEnvFile();
  const pg = {
    host: process.env.PGHOST || envFile.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || envFile.POSTGRES_USER || 'campfire',
    password: process.env.PGPASSWORD || envFile.POSTGRES_PASSWORD || '',
  };

  const admin = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
  try { await admin.connect(); }
  catch (e) { return skip('Postgres unreachable (' + ((e && e.message) || e) + ') — docker compose up -d db'); }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-pipe-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  engineLog = path.join(tmp, 'engine.jsonl');
  fs.writeFileSync(engineLog, '');

  const media = {
    wav: path.join(tmp, 'tone.wav'),
    voice: path.join(tmp, 'voice-note.webm'), // exactly what Chrome's MediaRecorder gives a voice message
    jpg: path.join(tmp, 'noise.jpg'),
    txt: path.join(tmp, 'notes.txt'), // not media at all — nothing may touch it
    bad: path.join(tmp, 'payload.txt'), // what the stand-in daemon refuses (see fake-clamd.js)
  };
  fs.writeFileSync(media.txt, 'not media, just a text file\n');
  // Content, never a file name — and a deliberately innocent name, so the check
  // proves the pipeline blocks on what the bytes ARE, not what they are called.
  fs.writeFileSync(media.bad, 'holiday photo attachment\n' + fake.MARKER + '\nmore harmless-looking text\n');
  if (!ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20,volume=0.4', '-ac', '1', '-c:a', 'pcm_s16le', media.wav])
    || !ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', '-ac', '1', '-c:a', 'libopus', '-b:a', '24k', media.voice])
    || !ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'nullsrc=s=2048x2048,geq=random(1)*255:128:128', '-frames:v', '1', '-q:v', '1', media.jpg])) {
    return skip('ffmpeg could not generate test media');
  }
  // Opus-in-WebM is the fixture that matters most here (a voice message recorded
  // on Android/desktop Chrome). Without libopus on this box the case cannot be
  // built, and the assertion set below is skipped with a note rather than passed
  // vacuously.
  const voiceOk = fs.existsSync(media.voice) && fs.statSync(media.voice).size > 0;
  if (!voiceOk) console.log('[test] note  this ffmpeg has no libopus encoder — the voice-note case is skipped');

  let child = null, db = null, daemon = null;
  let serverLog = '';
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();

    process.env.FAKE_CLAMAV_DELAY_MS = String(SCAN_DELAY_MS);
    process.env.FAKE_CLAMAV_LOG = engineLog;
    daemon = await fake.start({ port: DAEMON_PORT });
    const baseEnv = {
      ...process.env,
      PORT: String(PORT),
      PGHOST: pg.host, PGPORT: String(pg.port), PGUSER: pg.user, PGPASSWORD: pg.password, PGDATABASE: TEST_DB,
      JWT_SECRET: 'test-no-processing-stage-secret',
      UPLOAD_DIR: uploads,
      VIRUS_SCAN: '1',
      CLAMAV_HOST: '127.0.0.1',
      CLAMAV_PORT: String(daemon.port),
      MEDIA_COMPRESS_ACTIVE_MS: '250',
      MEDIA_COMPRESS_EVERY_MS: '5000',
      // The scheduled sweep is parked far beyond this run — the passes below are
      // driven explicitly through the admin route — and its age floor is zeroed,
      // because the test plants fixtures now and expects them adopted.
      MEDIA_SWEEP_FIRST_MS: '900000',
      MEDIA_SWEEP_EVERY_MS: '900000',
      MEDIA_SWEEP_MIN_AGE_MS: '0',
      ORPHAN_SWEEP: '1',
      UNFURL: '0',
      DRAIN_WAIT_MS: '0',
    };
    function startServer(extra) {
      serverLog = '';
      const c = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        cwd: ROOT, env: { ...baseEnv, ...(extra || {}) }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      c.stdout.on('data', (d) => { serverLog += d; });
      c.stderr.on('data', (d) => { serverLog += d; });
      return c;
    }
    function stopServer() {
      return new Promise((resolve) => {
        const c = child;
        if (!c) return resolve();
        child = null;
        c.once('exit', () => resolve());
        try { c.kill(); } catch { resolve(); }
        setTimeout(resolve, 15000); // never hang the suite on a stubborn exit
      });
    }
    child = startServer();
    const fail = (msg) => { throw new Error(msg + '\n--- server log ---\n' + serverLog.slice(-4000)); };

    if (!(await waitForHttp('/api/config', 30000))) return fail('server did not come up');

    const bootCfg = await api('GET', '/api/config');
    check('server advertises the upload cap', bootCfg.maxUploadMb === (parseInt(process.env.MAX_FILE_MB || '200', 10) || 200), 'maxUploadMb=' + bootCfg.maxUploadMb);

    const reg = await api('POST', '/api/register', { username: 'pipetest', password: 'test1234', displayName: 'Pipe Test' });
    const token = reg.token;
    const srv = await api('POST', '/api/servers', { name: 'Pipeline' }, token);
    const channelId = srv.server.channels.find((c) => c.type === 'text').id;

    db = new Client({ ...pg, database: TEST_DB });
    db.on('error', (e) => console.log('[test] db client error:', (e && e.message) || e));
    await db.connect();
    const rowFor = async (key) => (await db.query('SELECT url, mime, size, kind, compressed FROM attachments WHERE split_part(url,\'?\',1) = $1', ['/uploads/' + key])).rows;
    const scanRow = async (key) => (await db.query('SELECT status, attempts, error, engine FROM file_scans WHERE key = $1', [key])).rows[0] || null;
    const asAdmin = async () => { await db.query('UPDATE users SET is_admin = 1 WHERE id = $1', [reg.user.id]); };
    const asUser = async () => { await db.query('UPDATE users SET is_admin = 0 WHERE id = $1', [reg.user.id]); };

    // Upload + post + hand back what the socket saw. `settle` is how long the
    // caller wants to watch for a republish it does NOT expect.
    async function roundTrip(filePath, name, mime, settleMs) {
      const conn = await connectWs(token);
      await waitFor(() => conn.events.some((e) => e.t === 'hello'), 5000);
      const up = await uploadFile(filePath, name, mime, token);
      conn.send({ t: 'message', serverId: srv.server.id, channelId, content: '', attachments: [{ url: up.url, name: up.name, mime: up.mime, size: up.size, kind: up.kind }] });
      const created = await waitFor(() => conn.events.find((e) => e.t === 'message-new'), 8000);
      if (!created) fail('message-new never arrived for ' + name);
      const mid = created.message.id;
      if (settleMs) await sleep(settleMs);
      return { up, mid, created, events: conn.events, conn };
    }

    // ================= the scan posture =================
    console.log('\n-- an upload is scanned in the background and served immediately --');
    const a = await roundTrip(media.wav, 'tone.wav', 'audio/wav', 0);
    const aKey = a.up.url.split('?')[0].replace('/uploads/', '');
    check('the upload answers clean (there is no card to wait behind)', a.up.scan === 'clean', 'scan=' + a.up.scan);
    check('the message renders the real file, not a scanning card', a.created.message.attachments[0].scan === 'clean', a.created.message.attachments[0].scan);
    const aNow = await fetch(`http://127.0.0.1:${PORT}${a.up.url}`);
    check('and its bytes are fetchable while the verdict is still in flight', aNow.status === 200, 'status=' + aNow.status);
    const aPending = await scanRow(aKey);
    check('...which the scanner is genuinely still working on', !!aPending && aPending.status === 'pending', JSON.stringify(aPending));
    const aSettled = await waitForAsync(async () => {
      const r = await scanRow(aKey);
      return r && r.status === 'clean' ? r : null;
    }, 30000);
    check('the verdict lands behind the reader', !!aSettled, JSON.stringify(await scanRow(aKey)));
    check('...marked with the engine generation that judged it',
      !!aSettled && /^clamav\//.test(aSettled.engine || ''), aSettled && aSettled.engine);
    check('the daemon was handed this file\'s own bytes', readEngineLog().some((s) => Number(s.size) === a.up.size),
      'daemon saw sizes ' + readEngineLog().map((s) => s.size).join(','));

    // A wav is not a compatibility type (WAV is playable everywhere), so the
    // upload path AND the queue both leave it exactly as it is: only the
    // scheduled sweep may rewrite it (proved in the next phase).
    await sleep(3000);
    check('ordinary media is not rewritten seconds after it was posted', republished(a.events, a.mid, a.up.url).length === 0,
      JSON.stringify(republished(a.events, a.mid, a.up.url).map((e) => e.message.attachments[0].url)));
    const aRows = await rowFor(aKey);
    check('...and its row still points at the bytes that were uploaded', aRows.length === 1 && Number(aRows[0].compressed) === 0,
      JSON.stringify(aRows[0]));
    a.conn.close();

    // ================= the verdict is still a verdict =================
    console.log('\n-- a flagged upload is deleted, refused and re-broadcast --');
    const badConn = await connectWs(token);
    await waitFor(() => badConn.events.some((e) => e.t === 'hello'), 5000);
    const badUp = await uploadFile(media.bad, 'holiday-photo-2019.txt', 'text/plain', token);
    check('the flagged upload is served like any other (the verdict is what removes it)', badUp.scan === 'clean', 'scan=' + badUp.scan);
    const badKey = badUp.url.split('?')[0].replace('/uploads/', '');
    const badServedEarly = await fetch(`http://127.0.0.1:${PORT}${badUp.url}`);
    const badSettling = await scanRow(badKey);
    check('and its bytes really are there while the engine is still judging',
      badServedEarly.status === 200 && !!badSettling && badSettling.status === 'pending',
      JSON.stringify({ http: badServedEarly.status, row: badSettling && badSettling.status }));
    badConn.send({
      t: 'message', serverId: srv.server.id, channelId, content: '',
      attachments: [{ url: badUp.url, name: badUp.name, mime: badUp.mime, size: badUp.size, kind: badUp.kind }],
    });
    const badNew = await waitFor(() => badConn.events.find((e) => e.t === 'message-new'), 8000);
    if (!badNew) fail('the detection fixture message never arrived');
    const badMid = badNew.message.id;
    const badDone = await waitFor(() => badConn.events.find((e) => e.t === 'message-updated' && e.message.id === badMid
      && e.message.attachments[0].scan === 'infected'), 30000);
    badConn.close();
    check('the message is re-broadcast as blocked', !!badDone, badDone ? '' : 'no infected update within 30s');
    const badRow = await scanRow(badKey);
    check('the verdict names the engine and the signature that matched',
      !!badRow && /^ClamAV: .+/.test(badRow.error || ''), badRow && badRow.error);
    check('the infected bytes were deleted', !fs.existsSync(path.join(uploads, badKey)));
    check('the scan row is kept so the chat can still explain itself', !!badRow && badRow.status === 'infected');
    const badServed = await fetch(`http://127.0.0.1:${PORT}${badUp.url}`);
    check('the gate refuses the deleted bytes (410)', badServed.status === 410, 'status=' + badServed.status);

    // ================= the compatibility queue =================
    // The one thing that still runs promptly, because a voice note an iPhone
    // cannot play for six hours is not a compression policy, it is a bug.
    if (voiceOk) {
      console.log('\n-- a voice message: WebM/Opus -> AAC/MP4 (the only format every Apple product plays) --');
      const vsz = fs.statSync(media.voice).size;
      const v = await roundTrip(media.voice, 'voice-message.webm', 'audio/webm', 0);
      check('upload answered clean and filed as audio', v.up.scan === 'clean' && v.up.kind === 'audio', v.up.scan + '/' + v.up.kind);
      check('the message first shows the bytes that were uploaded (served at once)', v.created.message.attachments[0].scan === 'clean');
      const vDone = await waitFor(() => republished(v.events, v.mid, v.up.url).pop(), 30000);
      const vAtt = vDone && vDone.message.attachments[0];
      check('the compatibility queue republishes it under a new key', !!vAtt, 'no republish within 30s');
      check('...as audio/mp4', !!vAtt && vAtt.mime === 'audio/mp4', vAtt && vAtt.mime);
      check('...with a .m4a key', !!vAtt && vAtt.url.split('?')[0].endsWith('.m4a'), vAtt && vAtt.url);
      check('...and the download name follows the bytes (voice-message.m4a)',
        !!vAtt && vAtt.name === 'voice-message.m4a', vAtt && vAtt.name);
      check('...published even though AAC is BIGGER than the Opus original', !!vAtt && vAtt.size > vsz, vAtt && (vAtt.size + ' > ' + vsz));
      const vKey = vAtt && vAtt.url.split('?')[0].replace('/uploads/', '');
      const vOldKey = v.up.url.split('?')[0].replace('/uploads/', '');
      check('the WebM original is left for the orphan sweep (never swapped in place)',
        fs.existsSync(path.join(uploads, vOldKey)));
      check('nothing references the old key any more', (await rowFor(vOldKey)).length === 0);
      const vRows = await rowFor(vKey);
      check('the row follows the new key + compressed=1', vRows.length === 1 && Number(vRows[0].compressed) === 1, JSON.stringify(vRows[0]));
      const vServed = await fetch(`http://127.0.0.1:${PORT}${vAtt ? vAtt.url : ''}`);
      const vServedBytes = Buffer.from(await vServed.arrayBuffer());
      check('the m4a is served', vServed.status === 200 && vServedBytes.length === vAtt.size, 'status=' + vServed.status + ' bytes=' + vServedBytes.length);
      // What the reader actually receives, judged by ffprobe rather than by the
      // row: AAC in an MP4, with the index (moov) before the audio data.
      const vFile = path.join(tmp, 'served.m4a');
      fs.writeFileSync(vFile, vServedBytes);
      const vProbe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,channels', '-show_entries', 'format=format_name', '-of', 'json', vFile], { encoding: 'utf8' });
      let vInfo = {};
      try { vInfo = JSON.parse(String(vProbe.stdout || '{}')); } catch {}
      const vStream = (vInfo.streams || [])[0] || {};
      check('the served bytes really are AAC in MP4', vStream.codec_name === 'aac' && /mp4|mov/.test(String((vInfo.format || {}).format_name || '')),
        JSON.stringify({ codec: vStream.codec_name, format: (vInfo.format || {}).format_name }));
      // The fixture is mono (as every MediaRecorder voice message is), so the
      // conversion must be mono too: the m4a plan used to force `-ac 2` on it,
      // which duplicated the channel and made the file ~25% bigger than the Opus.
      check('...in ONE channel (the mono voice note is not written out as stereo)',
        Number(vStream.channels) === 1, JSON.stringify({ channels: vStream.channels }));
      const vHead = vServedBytes.subarray(0, 8192).toString('latin1');
      check('...with moov before mdat (+faststart — iOS will not start a progressive read without it)',
        vHead.includes('moov') && (!vHead.includes('mdat') || vHead.indexOf('moov') < vHead.indexOf('mdat')),
        JSON.stringify({ moov: vHead.indexOf('moov'), mdat: vHead.indexOf('mdat') }));
      check('the conversion was judged by the scanner too', readEngineLog().some((s) => Number(s.size) === vAtt.size));
      // Range requests: the one transport detail separate from the codec. Safari
      // plays audio by reading ranges out of it, so a 206 has to come back.
      const ranged = await fetch(`http://127.0.0.1:${PORT}${vAtt.url}`, { headers: { Range: 'bytes=0-1' } });
      check('a bytes=0-1 range is answered 206 with the right length (how Safari reads audio)',
        ranged.status === 206 && (await ranged.arrayBuffer()).byteLength === 2, 'status=' + ranged.status);
      v.conn.close();
    }

    // ================= the bucket sweep owns ordinary media =================
    console.log('\n-- an ordinary upload is left alone until the bucket sweep runs --');
    const b = await roundTrip(media.jpg, 'noise.jpg', 'image/jpeg', 3000);
    const bKey = b.up.url.split('?')[0].replace('/uploads/', '');
    const bPath = path.join(uploads, bKey);
    const bHash = sha256Of(bPath);
    check('a fresh JPEG is served immediately', (await fetch(`http://127.0.0.1:${PORT}${b.up.url}`)).status === 200);
    check('the compatibility queue never touches it (it is playable everywhere)',
      republished(b.events, b.mid, b.up.url).length === 0
      && Number((await rowFor(bKey))[0].compressed) === 0,
      JSON.stringify(republished(b.events, b.mid, b.up.url).map((e) => e.message.attachments[0].url)));

    await asAdmin();
    const dry1 = await api('POST', '/api/admin/media/scan?dry=1', undefined, token);
    check('a dry sweep reports it as a candidate without touching it',
      (dry1.result.candidates || 0) >= 1 && sha256Of(bPath) === bHash, JSON.stringify(dry1.result));
    await api('POST', '/api/admin/media/scan', undefined, token);
    const bDone = await waitFor(() => republished(b.events, b.mid, b.up.url).pop(), 90000);
    const bAtt = bDone && bDone.message.attachments[0];
    check('the sweep republishes it smaller under a NEW key', !!bAtt && bAtt.size > 0 && bAtt.size < b.up.size, bAtt && (bAtt.size + ' < ' + b.up.size));
    check('the original object is left for the orphan sweep (never swapped in place)',
      fs.existsSync(bPath) && sha256Of(bPath) === bHash);
    if (bAtt) {
      const bNewKey = bAtt.url.split('?')[0].replace('/uploads/', '');
      check('the new object exists', fs.existsSync(path.join(uploads, bNewKey)));
      check('the row follows the new key + compressed=1',
        (await rowFor(bKey)).length === 0 && Number((await rowFor(bNewKey))[0].compressed) === 1);
      const led = await db.query('SELECT COUNT(*) c FROM media_compress_keys WHERE key = ANY($1)', [[bKey, bNewKey]]);
      check('both keys are settled in the ledger', Number(led.rows[0].c) === 2, 'ledger rows=' + led.rows[0].c);
      check('the re-published file is servable', (await fetch(`http://127.0.0.1:${PORT}${bAtt.url}`)).status === 200);
      const bRescan = await scanRow(bNewKey);
      check('the new bytes carry a verdict of their own', !!bRescan && bRescan.status === 'clean', JSON.stringify(bRescan));
    }
    b.conn.close();

    // ================= DM attachments =================
    console.log('\n-- DM attachments: same posture, same sweep --');
    const reg2 = await api('POST', '/api/register', { username: 'pipetest2', password: 'test1234', displayName: 'Pipe Two' });
    const dm = await api('POST', '/api/dms', { userId: reg2.user.id }, token);
    const dmConn = await connectWs(token);
    await waitFor(() => dmConn.events.some((e) => e.t === 'hello'), 5000);
    const dmUp = await uploadFile(media.wav, 'dm-tone.wav', 'audio/wav', token);
    check('a DM upload is served immediately too', dmUp.scan === 'clean'
      && (await fetch(`http://127.0.0.1:${PORT}${dmUp.url}`)).status === 200, 'scan=' + dmUp.scan);
    dmConn.send({ t: 'dm', threadId: dm.thread.id, content: '', attachments: [{ url: dmUp.url, name: dmUp.name, mime: dmUp.mime, size: dmUp.size, kind: dmUp.kind }] });
    const dmNew = await waitFor(() => dmConn.events.find((e) => e.t === 'dm-new'), 8000);
    if (!dmNew) fail('dm-new never arrived');
    check('the DM message shows the real file', dmNew.message.attachments[0].scan === 'clean');
    await api('POST', '/api/admin/media/scan', undefined, token);
    const dmDone = await waitFor(() => dmConn.events.filter((e) => e.t === 'dm-updated' && e.message.id === dmNew.message.id)
      .find((e) => e.message.attachments[0].url.split('?')[0] !== dmUp.url.split('?')[0]), 90000);
    dmConn.close();
    const dmAtt = dmDone && dmDone.message.attachments[0];
    check('the sweep compressed the DM attachment and the DM message was told', !!dmAtt, 'no dm-updated within 90s');
    if (dmAtt) {
      const dmKey = dmAtt.url.split('?')[0].replace('/uploads/', '');
      const dmRow = (await db.query("SELECT compressed FROM dm_attachments WHERE split_part(url,'?',1) = $1", ['/uploads/' + dmKey])).rows[0];
      check('the DM row follows the new key + compressed=1', !!dmRow && Number(dmRow.compressed) === 1, JSON.stringify(dmRow));
      check('no DM row points at the superseded upload any more',
        (await db.query("SELECT COUNT(*) c FROM dm_attachments WHERE split_part(url,'?',1) = $1", [dmUp.url.split('?')[0]])).rows[0].c === '0');
    }

    // ================= stories =================
    console.log('\n-- stories: story media is compression media too --');
    const stUp = await uploadFile(media.jpg, 'story-photo.jpg', 'image/jpeg', token);
    const stRes = await api('POST', '/api/stories', {
      url: stUp.url, mime: stUp.mime, kind: 'image', caption: 'pipeline test', audience: 'friends', durationMs: 5000,
    }, token);
    const storyId = stRes.story && stRes.story.id;
    check('story posted', !!storyId, JSON.stringify(stRes).slice(0, 200));
    await api('POST', '/api/admin/media/scan', undefined, token);
    const stRow = await waitForAsync(async () => {
      if (!storyId) return null;
      const r = await db.query('SELECT compressed, size, url, mime FROM stories WHERE id = $1', [storyId]);
      const row = r.rows[0];
      return row && Number(row.compressed) === 1 ? row : null;
    }, 90000);
    check('story media compressed without anyone posting a message', !!stRow, 'the story row never settled');
    if (stRow) {
      const storyKey = stRow.url.split('?')[0].replace('/uploads/', '');
      check('the story points at bytes under a new key, and they are smaller',
        storyKey !== stUp.url.split('?')[0].replace('/uploads/', '')
        && fs.existsSync(path.join(uploads, storyKey))
        && Number(stRow.size) > 0 && Number(stRow.size) < fs.statSync(media.jpg).size,
        storyKey + ' ' + stRow.size + ' vs ' + fs.statSync(media.jpg).size);
      check('the story url carries a fresh cache key', /\?v=/.test(stRow.url), stRow.url);
      check('the story key is in the ledger', ((await db.query("SELECT status FROM media_compress_keys WHERE key = $1", [storyKey])).rows[0] || {}).status === 'compressed');
      check('the compressed story bytes are what is served', (await fetch(`http://127.0.0.1:${PORT}${stRow.url}`)).status === 200);
    }

    // A story posted before the size column existed carries size = 0. Reading
    // that as "a tiny file" skipped exactly the big ones, so the unknown size has
    // to be resolved from the object itself.
    console.log('\n-- a story row with no recorded size is not mistaken for a small file --');
    const legacyKey = 'files/' + crypto.randomBytes(16).toString('hex') + '.jpg';
    const legacyId = 'story-legacy-' + crypto.randomBytes(4).toString('hex');
    fs.copyFileSync(media.jpg, path.join(uploads, legacyKey));
    await db.query("INSERT INTO stories (id,user_id,audience,url,mime,kind,caption,duration_ms,created_at,expires_at,overlays,size,compressed) VALUES ($1,$2,'friends',$3,'image/jpeg','image','legacy',5000,$4,$5,'[]',0,0)",
      [legacyId, reg.user.id, '/uploads/' + legacyKey, Date.now(), Date.now() + 3600000]);
    await api('POST', '/api/admin/media/scan', undefined, token);
    const legacyRow = await waitForAsync(async () => {
      const r = await db.query('SELECT compressed, size, url FROM stories WHERE id = $1', [legacyId]);
      const row = r.rows[0];
      return row && Number(row.compressed) === 1 ? row : null;
    }, 90000);
    check('a story with no size was still compressed', !!legacyRow, 'the sweep skipped it as below the floor');
    if (legacyRow) {
      const legacyNew = legacyRow.url.split('?')[0].replace('/uploads/', '');
      check('...and the object size is now recorded on the row', Number(legacyRow.size) > 0, 'size=' + legacyRow.size);
      check('...on a fresh key, with the old bytes left alone', legacyNew !== legacyKey && fs.existsSync(path.join(uploads, legacyKey)) && fs.existsSync(path.join(uploads, legacyNew)));
    }

    // ================= profile media + the ledger =================
    console.log('\n-- the sweep adopts profile media, and never re-encodes what it settled --');
    const avKey = 'avatars/' + crypto.randomBytes(16).toString('hex') + '.jpg';
    const avPath = path.join(uploads, avKey);
    fs.mkdirSync(path.dirname(avPath), { recursive: true }); // disk mode creates this on a real avatar upload
    fs.copyFileSync(media.jpg, avPath);
    const avOld = '/uploads/' + avKey + '?v=old';
    await db.query('UPDATE users SET avatar_url = $1 WHERE id = $2', [avOld, reg.user.id]);
    // (a) an object nothing references: the orphan sweep owns those bytes
    const orphan2 = 'files/' + crypto.randomBytes(16).toString('hex') + '.jpg';
    fs.copyFileSync(media.jpg, path.join(uploads, orphan2));
    const orphan2Hash = sha256Of(path.join(uploads, orphan2));
    // (b) an object only message TEXT mentions: a pasted link must keep working,
    //     so it is never repointed (and never compressed into a new key)
    const textKey = 'files/' + crypto.randomBytes(16).toString('hex') + '.jpg';
    fs.copyFileSync(media.jpg, path.join(uploads, textKey));
    const textHash = sha256Of(path.join(uploads, textKey));
    await db.query('INSERT INTO messages (id,server_id,channel_id,user_id,content,created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      ['msg-' + crypto.randomBytes(8).toString('hex'), srv.server.id, channelId, reg.user.id, 'pasted /uploads/' + textKey, Date.now()]);

    const dry2 = await api('POST', '/api/admin/media/scan?dry=1', undefined, token);
    check('a dry pass reports the avatar as a candidate', (dry2.result.candidates || 0) >= 1, JSON.stringify(dry2.result));
    check('...and nothing was compressed by it', fs.statSync(avPath).size === fs.statSync(media.jpg).size);
    check('the unreferenced object is reported, not queued', (dry2.result.skippedOrphan || 0) >= 1, 'skippedOrphan=' + dry2.result.skippedOrphan);
    check('the pasted-link object is reported separately', (dry2.result.skippedText || 0) >= 1, 'skippedText=' + dry2.result.skippedText);

    await api('POST', '/api/admin/media/scan', undefined, token);
    const avNew = await waitForAsync(async () => {
      const r = await db.query('SELECT avatar_url FROM users WHERE id = $1', [reg.user.id]);
      const url = r.rows[0] && r.rows[0].avatar_url;
      return url && url !== avOld ? url : null;
    }, 90000);
    check('the sweep repointed the avatar to a new key', !!avNew && avNew.split('?')[0] !== '/uploads/' + avKey, avNew);
    if (avNew) {
      const avNewKey = avNew.split('?')[0].replace('/uploads/', '');
      check('the new avatar object exists and is smaller', fs.existsSync(path.join(uploads, avNewKey)) && fs.statSync(path.join(uploads, avNewKey)).size < fs.statSync(media.jpg).size);
      check('the old avatar object is left for the orphan sweep', fs.existsSync(avPath));
      check('the avatar is servable at its new key', (await fetch(`http://127.0.0.1:${PORT}${avNew}`)).status === 200);
      const led = await db.query('SELECT COUNT(*) c FROM media_compress_keys WHERE key = ANY($1)', [[avKey, avNewKey]]);
      check('both avatar keys are in the ledger', Number(led.rows[0].c) === 2, 'ledger rows=' + led.rows[0].c);
    }
    check('the unreferenced object was left exactly as it was', sha256Of(path.join(uploads, orphan2)) === orphan2Hash);
    check('the pasted-link object was left exactly as it was', sha256Of(path.join(uploads, textKey)) === textHash);

    const dry3 = await api('POST', '/api/admin/media/scan?dry=1', undefined, token);
    const dry3res = (dry3 && dry3.result) || {};
    check('the ledger stops a second pass re-encoding anything', (dry3res.candidates || 0) === 0,
      JSON.stringify({ candidates: dry3res.candidates, ledger: dry3res.ledger, objects: dry3res.objects }));
    const adm = await api('GET', '/api/admin/media', undefined, token);
    check('the admin payload carries the bucket-sweep state',
      !!(adm.bucketScan && adm.bucketScan.enabled && adm.bucketScan.lastResult && Number(adm.bucketScan.lastResult.compressed) >= 1),
      JSON.stringify(adm.bucketScan && { enabled: adm.bucketScan.enabled, last: adm.bucketScan.lastResult }));
    check('...and the scanner reports itself as a background judge',
      !!adm.scan && adm.scan.scanning === true && adm.scan.mode === undefined, JSON.stringify(adm.scan && { scanning: adm.scan.scanning, mode: adm.scan.mode }));
    await asUser();

    // ================= without a scanner =================
    // VIRUS_SCAN=0 is a different posture, not a different pipeline: nothing is
    // judged at all (no row, no verdict), the bytes serve at once, and the
    // compatibility queue still repairs what a platform cannot open.
    console.log('\n-- VIRUS_SCAN=0: nothing is judged, uploads still serve --');
    await stopServer();
    child = startServer({ VIRUS_SCAN: '0' });
    if (!(await waitForHttp('/api/config', 30000))) return fail('server did not come back up without a scanner');
    const scansBefore = readEngineLog().length; // the file is shared across both servers

    const txtUp = await uploadFile(media.txt, 'notes.txt', 'text/plain', token);
    check('a non-media upload is clean and servable immediately',
      txtUp.scan === 'clean' && (await fetch(`http://127.0.0.1:${PORT}${txtUp.url}`)).status === 200, 'scan=' + txtUp.scan);
    const txtKey = txtUp.url.split('?')[0].replace('/uploads/', '');
    check('and no scan row was created for it at all', (await scanRow(txtKey)) === null);

    if (voiceOk) {
      const v2 = await roundTrip(media.voice, 'voice-two.webm', 'audio/webm', 0);
      check('the upload is served immediately with no scanner', v2.up.scan === 'clean'
        && (await fetch(`http://127.0.0.1:${PORT}${v2.up.url}`)).status === 200);
      const v2Done = await waitFor(() => republished(v2.events, v2.mid, v2.up.url).pop(), 30000);
      const v2Att = v2Done && v2Done.message.attachments[0];
      check('the compatibility queue still repairs the Opus voice note', !!v2Att && v2Att.mime === 'audio/mp4', v2Att && v2Att.mime);
      check('...and the engine was not asked anything in this phase',
        readEngineLog().length === scansBefore, 'extra scans=' + (readEngineLog().length - scansBefore));
      v2.conn.close();
    }

    console.log('');
    console.log('-- signup username availability --');
    const avail = await api('GET', '/api/username-available?u=PipeTest');
    check('existing username reports taken (and normalized)', avail.username === 'pipetest' && avail.available === false, JSON.stringify(avail));
    const freshName = 'zzq' + Date.now().toString(36);
    const free = await api('GET', '/api/username-available?u=' + freshName);
    check('fresh username reports available', free.username === freshName && free.available === true, JSON.stringify(free));
    const short = await api('GET', '/api/username-available?u=a');
    check('too-short username rejected', short.available === false && short.reason === 'too_short', JSON.stringify(short));

    console.log('-- admin storage stats + orphan sweep --');
    await asAdmin();
    const st = await api('GET', '/api/admin/media/storage', undefined, token);
    check('storage stats: local mode, backup-aware shape', !!st.usage && st.usage.mode === 'local' && typeof st.usage.backups.bytes === 'number', JSON.stringify(st.usage && st.usage.total));
    check('prefixes aggregate the upload tree', (st.usage.prefixes || []).some((p) => p.prefix === 'files/'), JSON.stringify((st.usage.prefixes || []).map((p) => p.prefix)));
    check('total excludes a local backups/ tree', st.usage.total.bytes >= 0 && st.usage.local.bytes === st.usage.total.bytes, JSON.stringify(st.usage.local));
    check('tracked chat attachment bytes are reported', !!st.tracked && st.tracked.chat.bytes > 0, JSON.stringify(st.tracked && st.tracked.chat));
    const cached = await api('GET', '/api/admin/media/storage', undefined, token);
    check('second call is served from the cache', cached.usage.cached === true);

    // Plant an old, unreferenced file: the dry run must list it and delete
    // nothing; the real run must remove exactly it.
    const orphanKey = 'files/' + crypto.randomBytes(16).toString('hex') + '.bin';
    const orphanPath = path.join(uploads, orphanKey);
    fs.writeFileSync(orphanPath, Buffer.alloc(4096));
    const old3d = new Date(Date.now() - 72 * 3600 * 1000);
    fs.utimesSync(orphanPath, old3d, old3d);
    const dry = await api('POST', '/api/admin/sweep/run?dry=1', undefined, token);
    check('sweep dry-run lists the orphan and deletes nothing', !!dry.result && dry.result.dry === true && (dry.result.victims || []).some((v) => v.key === orphanKey) && fs.existsSync(orphanPath), JSON.stringify(dry.result && dry.result.victims));
    const real = await api('POST', '/api/admin/sweep/run', undefined, token);
    check('real sweep deletes it', !!real.result && !fs.existsSync(orphanPath), JSON.stringify(real.result && { deleted: real.result.deleted, scanned: real.result.scanned }));
    await asUser();

    await db.end();
  } catch (e) {
    // A crash used to hide the server's own log (which is where the reason
    // usually is), so print it before the error propagates.
    console.log('--- server log tail ---\n' + serverLog.split('\n').slice(-40).join('\n'));
    throw e;
  } finally {
    try { if (db) await db.end(); } catch {}
    try { if (child) child.kill(); } catch {}
    try { if (daemon) await daemon.close(); } catch {}
    try { await fake.closeAll(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    try {
      const drop = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
      await drop.connect();
      await drop.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      await drop.end();
    } catch {}
  }

  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log('  - ' + f);
    console.log('--- server log tail ---\n' + serverLog.split('\n').slice(-40).join('\n'));
    process.exit(1);
  }
  console.log('upload pipeline: OK');
}

function skip(why) {
  console.log('[test] SKIP: ' + why);
  process.exit(0);
}

main().catch((e) => { console.error('[test] FAILED:', (e && e.stack) || e); process.exit(1); });
