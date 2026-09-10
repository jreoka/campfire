// End-to-end check of the single-pass upload pipeline
// (server.js upload -> virus-scan.js slot -> media-compress.js processUpload).
//
// The point of the single pass: a client must see ONE transition per upload
// (pending -> final file). Before this test existed, an uploaded song appeared
// as a clean file, the sweeper compressed it a few seconds later, and the
// follow-up verdict re-broadcast the message with a new URL — which reset
// playback under anyone listening. Here we boot a real server against a
// throwaway Postgres database with a fake (slow) clamd on loopback and assert:
//   - the message shows the file as pending first,
//   - exactly ONE message-updated follows, already pointing at compressed
//     bytes that the scanner approved,
//   - the old bytes are gone (format change) and file_scans followed the file.
//
// Requirements: ffmpeg on PATH and Postgres reachable (docker compose up -d db).
// Skips (exit 0) with a message when either is missing.
//
// Usage: node scripts/test-upload-pipeline.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_test';
const PORT = parseInt(process.env.TEST_PORT || '3411', 10);
const CLAM_PORT = parseInt(process.env.TEST_CLAM_PORT || '3412', 10);
const SCAN_DELAY_MS = 1500; // slow fake clamd keeps the upload pending long enough to observe

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

// ---------- fake clamd (INSTREAM + PING, delayed verdicts) ----------

function startFakeClamd(port) {
  const state = { scans: 0, sizes: [], pings: 0 };
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let mode = null;
    let curSize = 0;
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!mode) {
        const i0 = buf.indexOf(0), inl = buf.indexOf(10);
        let end = -1;
        if (i0 >= 0 && (inl < 0 || i0 < inl)) end = i0;
        else if (inl >= 0) end = inl;
        if (end < 0) return;
        const cmd = buf.slice(0, end).toString('latin1').trim().toUpperCase();
        buf = buf.slice(end + 1);
        if (cmd.includes('PING')) { mode = 'ping'; state.pings++; sock.write('PONG\0'); return; }
        if (cmd.includes('INSTREAM')) { mode = 'instream'; return; }
        sock.destroy();
        return;
      }
      if (mode !== 'instream') return;
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          buf = buf.slice(4);
          state.scans++;
          state.sizes.push(curSize);
          setTimeout(() => { try { sock.end('stream: OK\0'); } catch {} }, SCAN_DELAY_MS);
          return;
        }
        if (buf.length < 4 + len) return;
        curSize += len;
        buf = buf.slice(4 + len);
      }
    });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ srv, state })));
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
  const clamdb = path.join(tmp, 'clamav');
  const bindir = path.join(tmp, 'bin');
  for (const d of [uploads, clamdb, bindir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(clamdb, 'test.cvd'), 'placeholder'); // hasDbFiles() only looks at the extension

  // Fake engine binaries so the scanner supervises "clamd" normally; our fake
  // TCP server answers PING/INSTREAM (the shim process itself exits at once).
  const trueBin = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/true.exe' : '/bin/true';
  const shim = (n) => path.join(bindir, process.platform === 'win32' ? n + '.exe' : n);
  try { fs.copyFileSync(trueBin, shim('clamd')); fs.copyFileSync(trueBin, shim('freshclam')); }
  catch { return skip('cannot create engine shims'); }

  const media = {
    wav: path.join(tmp, 'tone.wav'),
    jpg: path.join(tmp, 'noise.jpg'),
  };
  if (!ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20,volume=0.4', '-ac', '1', '-c:a', 'pcm_s16le', media.wav])
    || !ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'nullsrc=s=2048x2048,geq=random(1)*255:128:128', '-frames:v', '1', '-q:v', '1', media.jpg])) {
    return skip('ffmpeg could not generate test media');
  }

  let child = null, fake = null, db = null;
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();

    fake = await startFakeClamd(CLAM_PORT);

    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        PGHOST: pg.host, PGPORT: String(pg.port), PGUSER: pg.user, PGPASSWORD: pg.password, PGDATABASE: TEST_DB,
        JWT_SECRET: 'test-single-pass-secret',
        UPLOAD_DIR: uploads,
        VIRUS_SCAN: '1',
        CLAM_PORT: String(CLAM_PORT),
        CLAM_DB_DIR: clamdb,
        MEDIA_COMPRESS_ACTIVE_MS: '250',
        MEDIA_COMPRESS_EVERY_MS: '5000',
        ORPHAN_SWEEP: '0',
        UNFURL: '0',
        PATH: bindir + path.delimiter + (process.env.PATH || ''),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    const fail = (msg) => { throw new Error(msg + '\n--- server log ---\n' + serverLog.slice(-4000)); };

    if (!(await waitForHttp('/api/config', 30000))) return fail('server did not come up');

    // The composer's own cap comes from here (public/js/messages.js) so client
    // and server can't disagree about MAX_FILE_MB.
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
    const scanRow = async (key) => (await db.query('SELECT status, attempts FROM file_scans WHERE key = $1', [key])).rows[0] || null;

    // Runs one upload through the live pipeline and returns what clients saw.
    async function roundTrip(filePath, name, mime) {
      const conn = await connectWs(token);
      await waitFor(() => conn.events.some((e) => e.t === 'hello'), 5000);
      const up = await uploadFile(filePath, name, mime, token);
      conn.send({ t: 'message', serverId: srv.server.id, channelId, content: '', attachments: [{ url: up.url, name: up.name, mime: up.mime, size: up.size, kind: up.kind }] });
      const created = await waitFor(() => conn.events.find((e) => e.t === 'message-new'), 8000);
      if (!created) fail('message-new never arrived for ' + name);
      const mid = created.message.id;
      const upd = await waitFor(() => conn.events.find((e) => e.t === 'message-updated' && e.message.id === mid && e.message.attachments[0].scan === 'clean'), 30000);
      await sleep(1500); // a second (splitting) update would land in this window
      conn.close();
      return {
        up, mid,
        created,
        updates: conn.events.filter((e) => e.t === 'message-updated' && e.message.id === mid),
        final: upd || null,
      };
    }

    console.log('\n-- audio: wav upload -> inline compression (format change) --');
    const a = await roundTrip(media.wav, 'tone.wav', 'audio/wav');
    check('upload answered as scanned/pending', a.up.scan === 'pending', 'scan=' + a.up.scan);
    check('message first rendered as pending', a.created.message.attachments[0].scan === 'pending');
    check('exactly ONE message update (no swap under a player)', a.updates.length === 1, 'updates=' + a.updates.length);
    const aAtt = a.final && a.final.message.attachments[0];
    check('final attachment is clean + compressed', !!aAtt && aAtt.scan === 'clean' && aAtt.mime === 'audio/mpeg', aAtt && (aAtt.mime + ' ' + aAtt.scan));
    check('final url is a fresh mp3 key', !!aAtt && aAtt.url.split('?')[0].endsWith('.mp3') && aAtt.url.split('?')[0] !== a.up.url.split('?')[0], aAtt && aAtt.url);
    const aKey = aAtt && aAtt.url.split('?')[0].replace('/uploads/', '');
    const aOldKey = a.up.url.split('?')[0].replace('/uploads/', '');
    check('final bytes are smaller', !!aAtt && aAtt.size > 0 && aAtt.size < a.up.size, aAtt && (aAtt.size + ' < ' + a.up.size));
    check('old bytes deleted', !fs.existsSync(path.join(uploads, aOldKey)));
    check('old scan row dropped', (await scanRow(aOldKey)) === null);
    check('scan verdict follows the new key', !!aKey && (await scanRow(aKey) || {}).status === 'clean');
    const aRows = await rowFor(aKey);
    check('attachment row points at the new key + compressed=1', aRows.length === 1 && Number(aRows[0].compressed) === 1);
    const served = await fetch(`http://127.0.0.1:${PORT}${aAtt ? aAtt.url : ''}`);
    const servedBytes = Buffer.from(await served.arrayBuffer());
    check('compressed file is served through the scan gate', served.status === 200 && servedBytes.length === aAtt.size, 'status=' + served.status + ' bytes=' + servedBytes.length);
    check('candidate output was scanned too (sizes seen by clamd)', fake.state.sizes.includes(aAtt.size), 'scans=' + fake.state.sizes.join(','));

    console.log('\n-- image: jpeg upload -> inline compression (same key) --');
    const b = await roundTrip(media.jpg, 'noise.jpg', 'image/jpeg');
    check('message first rendered as pending', b.created.message.attachments[0].scan === 'pending');
    check('exactly ONE message update', b.updates.length === 1, 'updates=' + b.updates.length);
    const bAtt = b.final && b.final.message.attachments[0];
    check('final attachment is clean + same key', !!bAtt && bAtt.scan === 'clean' && bAtt.url.split('?')[0] === b.up.url.split('?')[0], bAtt && bAtt.url);
    check('cache-buster rotated', !!bAtt && bAtt.url !== b.up.url);
    check('final bytes are smaller', !!bAtt && bAtt.size < b.up.size, bAtt && (bAtt.size + ' < ' + b.up.size));
    check('rewritten bytes scanned before publishing', fake.state.sizes.includes(bAtt.size), 'scans=' + fake.state.sizes.join(','));
    const bKey = bAtt.url.split('?')[0].replace('/uploads/', '');
    check('scan verdict clean for the key', (await scanRow(bKey) || {}).status === 'clean');
    const bOnDisk = fs.statSync(path.join(uploads, bKey)).size;
    check('served/on-disk bytes match the published size', bOnDisk === bAtt.size, bOnDisk + ' vs ' + bAtt.size);

    console.log('\n-- DM attachment: same single pass --');
    const reg2 = await api('POST', '/api/register', { username: 'pipetest2', password: 'test1234', displayName: 'Pipe Two' });
    const dm = await api('POST', '/api/dms', { userId: reg2.user.id }, token);
    const dmConn = await connectWs(token);
    await waitFor(() => dmConn.events.some((e) => e.t === 'hello'), 5000);
    const dmUp = await uploadFile(media.wav, 'dm-tone.wav', 'audio/wav', token);
    dmConn.send({ t: 'dm', threadId: dm.thread.id, content: '', attachments: [{ url: dmUp.url, name: dmUp.name, mime: dmUp.mime, size: dmUp.size, kind: dmUp.kind }] });
    const dmNew = await waitFor(() => dmConn.events.find((e) => e.t === 'dm-new'), 8000);
    if (!dmNew) fail('dm-new never arrived');
    const dmUpdates = () => dmConn.events.filter((e) => e.t === 'dm-updated' && e.message.id === dmNew.message.id);
    const dmFinal = await waitFor(() => dmUpdates().find((e) => e.message.attachments[0].scan === 'clean' && e.message.attachments[0].url.split('?')[0].endsWith('.mp3')), 30000);
    await sleep(1200);
    dmConn.close();
    check('dm message first rendered as pending', dmNew.message.attachments[0].scan === 'pending');
    check('exactly ONE dm update', dmUpdates().length === 1, 'updates=' + dmUpdates().length);
    const dmAtt = dmFinal && dmFinal.message.attachments[0];
    check('dm attachment compressed + verified', !!dmAtt && dmAtt.scan === 'clean' && dmAtt.mime === 'audio/mpeg', dmAtt && dmAtt.mime);
    if (dmAtt) {
      const dmKey = dmAtt.url.split('?')[0].replace('/uploads/', '');
      const dmRow = (await db.query("SELECT compressed FROM dm_attachments WHERE split_part(url,'?',1) = $1", ['/uploads/' + dmKey])).rows[0];
      check('dm attachment row marked compressed', !!dmRow && Number(dmRow.compressed) === 1);
      check('dm original bytes deleted', !fs.existsSync(path.join(uploads, dmUp.url.split('?')[0].replace('/uploads/', ''))));
    }

    console.log('\n-- sweeper fallback: a file the pipeline never saw --');
    // Bytes + a clean verdict but compressed = 0: exactly the state a
    // pre-existing upload (or one from a scanner-less period) is in. Only the
    // media sweeper can pick this up now, and it still must.
    const sweptKey = 'files/' + crypto.randomBytes(16).toString('hex') + '.wav';
    fs.copyFileSync(media.wav, path.join(uploads, sweptKey));
    await db.query("INSERT INTO file_scans (key,status,attempts,error,created_at,scanned_at) VALUES ($1,'clean',1,'',$2,$2)", [sweptKey, Date.now()]);
    const swept = await connectWs(token);
    await waitFor(() => swept.events.some((e) => e.t === 'hello'), 5000);
    swept.send({
      t: 'message', serverId: srv.server.id, channelId, content: '', attachments: [{
        url: '/uploads/' + sweptKey + '?v=' + Date.now().toString(36),
        name: 'old-tone.wav', mime: 'audio/wav', size: fs.statSync(media.wav).size, kind: 'audio',
      }],
    });
    const sweptCreated = await waitFor(() => swept.events.find((e) => e.t === 'message-new'), 8000);
    if (!sweptCreated) fail('sweeper fixture message never arrived');
    const sweptMid = sweptCreated.message.id;
    const sweptDone = await waitFor(() => swept.events.find((e) => e.t === 'message-updated' && e.message.id === sweptMid && e.message.attachments[0].scan === 'clean' && e.message.attachments[0].url.split('?')[0].endsWith('.mp3')), 30000);
    swept.close();
    const sweptAtt = sweptDone && sweptDone.message.attachments[0];
    if (!sweptAtt) {
      console.log('[test] sweeper events: ' + JSON.stringify(swept.events.map((e) => ({ t: e.t, err: e.error, att: e.message && e.message.attachments && e.message.attachments[0] && { scan: e.message.attachments[0].scan, url: e.message.attachments[0].url, size: e.message.attachments[0].size } }))));
      console.log('[test] server log tail: ' + serverLog.split('\n').slice(-12).join('\n'));
    }
    check('sweeper compressed + re-verified the missed file', !!sweptAtt, sweptDone ? '' : 'no compressed update within 30s');
    check('original bytes gone', !fs.existsSync(path.join(uploads, sweptKey)));
    if (sweptAtt) {
      const newKey = sweptAtt.url.split('?')[0].replace('/uploads/', '');
      check('new key exists on disk', fs.existsSync(path.join(uploads, newKey)));
      check('rescan verdict clean', (await scanRow(newKey) || {}).status === 'clean');
      const sweptRow = (await db.query("SELECT compressed FROM attachments WHERE split_part(url,'?',1) = $1", ['/uploads/' + newKey])).rows[0];
      check('attachment row marked compressed', !!sweptRow && Number(sweptRow.compressed) === 1);
    }

    await db.end();
  } finally {
    try { if (db) await db.end(); } catch {}
    try { if (child) child.kill(); } catch {}
    try { if (fake) fake.srv.close(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    try {
      const drop = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
      await drop.connect();
      await drop.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      await drop.end();
    } catch {}
  }

  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('upload pipeline: OK');
}

function skip(why) {
  console.log('[test] SKIP: ' + why);
  process.exit(0);
}

main().catch((e) => { console.error('[test] FAILED:', (e && e.stack) || e); process.exit(1); });
