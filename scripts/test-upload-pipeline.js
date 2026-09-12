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
    small: path.join(tmp, 'thumb.png'), // below MIN_BYTES.image: never a candidate
  };
  if (!ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20,volume=0.4', '-ac', '1', '-c:a', 'pcm_s16le', media.wav])
    || !ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'nullsrc=s=2048x2048,geq=random(1)*255:128:128', '-frames:v', '1', '-q:v', '1', media.jpg])
    || !ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x334155:s=64x64', '-frames:v', '1', media.small])) {
    return skip('ffmpeg could not generate test media');
  }

  let child = null, fake = null, db = null;
  let serverLog = '';
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();

    fake = await startFakeClamd(CLAM_PORT);

    const baseEnv = {
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
      ORPHAN_SWEEP: '1', // exercised below (dry run + real sweep on a planted orphan)
      UNFURL: '0',
      DRAIN_WAIT_MS: '0', // the compression-only phase restarts the server
      PATH: bindir + path.delimiter + (process.env.PATH || ''),
    };
    // Boot/stop helpers: the second phase runs the SAME database with no clamd
    // at all, which is the shape the production cluster uses.
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
    // The sweeper only ever sees files clients can already fetch, so it publishes
    // the compressed bytes under a NEW key and leaves the old object alone: a
    // byte swap behind a live URL is what this rule exists to prevent. The old
    // key stops being referenced, and the orphan sweep reaps it after its grace.
    check('original bytes are left for the orphan sweep (never swapped in place)', fs.existsSync(path.join(uploads, sweptKey)));
    const sweptOldRows = await db.query("SELECT COUNT(*) c FROM attachments WHERE split_part(url,'?',1) = $1", ['/uploads/' + sweptKey]);
    check('nothing references the old key any more', Number(sweptOldRows.rows[0].c) === 0, 'rows=' + sweptOldRows.rows[0].c);
    if (sweptAtt) {
      const newKey = sweptAtt.url.split('?')[0].replace('/uploads/', '');
      check('new key exists on disk', fs.existsSync(path.join(uploads, newKey)));
      check('rescan verdict clean', (await scanRow(newKey) || {}).status === 'clean');
      const sweptRow = (await db.query("SELECT compressed FROM attachments WHERE split_part(url,'?',1) = $1", ['/uploads/' + newKey])).rows[0];
      check('attachment row marked compressed', !!sweptRow && Number(sweptRow.compressed) === 1);
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
    await db.query('UPDATE users SET is_admin = 1 WHERE id = $1', [reg.user.id]);
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
    await db.query('UPDATE users SET is_admin = 0 WHERE id = $1', [reg.user.id]);

    // ---------- compression-only slot (no clamd) ----------
    // What the production cluster runs: a 1 vCPU / ~1.14GiB node cannot afford
    // clamd's ~1GB, so VIRUS_SCAN=0. The slot must still settle every upload's
    // bytes BEFORE they are served, or a client gets the uncompressed file and
    // then a swap. And what the sweeper does touch is already visible, so it
    // must publish under a NEW key instead of rewriting the bytes behind a URL
    // someone may be streaming.
    console.log('\n-- compression-only slot: VIRUS_SCAN=0, MEDIA_COMPRESS=1 --');
    const scansBefore = fake.state.scans;
    await stopServer();
    // The bucket scan is driven explicitly below (POST /api/admin/media/scan), so
    // the scheduled pass is parked well beyond this run — but the age floor is
    // zeroed, because a test plants its fixtures now and expects them adopted.
    child = startServer({
      VIRUS_SCAN: '0',
      MEDIA_SWEEP_FIRST_MS: '900000', MEDIA_SWEEP_EVERY_MS: '900000', MEDIA_SWEEP_MIN_AGE_MS: '0',
    });
    if (!(await waitForHttp('/api/config', 30000))) return fail('server did not come back up without a scanner');

    await db.query('UPDATE users SET is_admin = 1 WHERE id = $1', [reg.user.id]);
    const noScanAdmin = await api('GET', '/api/admin/media', undefined, token);
    check('the admin panel is told the slot runs with no scanner',
      !!noScanAdmin.scan && noScanAdmin.scan.mode === 'compress' && noScanAdmin.scan.scanning === false && noScanAdmin.scan.compressing === true,
      JSON.stringify(noScanAdmin.scan && { mode: noScanAdmin.scan.mode, engine: noScanAdmin.scan.engine }));
    await db.query('UPDATE users SET is_admin = 0 WHERE id = $1', [reg.user.id]);

    const pUp = await uploadFile(media.wav, 'plain-tone.wav', 'audio/wav', token);
    check('a candidate upload is gated while its encode is pending', pUp.scan === 'pending', 'scan=' + pUp.scan);
    const gatedRes = await fetch(`http://127.0.0.1:${PORT}${pUp.url}`);
    check('the gate refuses the bytes until the slot publishes', gatedRes.status === 423, 'status=' + gatedRes.status);

    const smallUp = await uploadFile(media.small, 'thumb.png', 'image/png', token);
    check('a file no compressor would touch is NOT gated', smallUp.scan === 'clean', 'scan=' + smallUp.scan);
    check('...and is servable immediately', (await fetch(`http://127.0.0.1:${PORT}${smallUp.url}`)).status === 200);

    const pConn = await connectWs(token);
    await waitFor(() => pConn.events.some((e) => e.t === 'hello'), 5000);
    pConn.send({
      t: 'message', serverId: srv.server.id, channelId, content: '',
      attachments: [{ url: pUp.url, name: pUp.name, mime: pUp.mime, size: pUp.size, kind: pUp.kind }],
    });
    const pNew = await waitFor(() => pConn.events.find((e) => e.t === 'message-new'), 8000);
    if (!pNew) fail('message-new never arrived in compression-only mode');
    check('message first rendered as pending', pNew.message.attachments[0].scan === 'pending');
    const pMid = pNew.message.id;
    const pDone = await waitFor(() => pConn.events.find((e) => e.t === 'message-updated' && e.message.id === pMid && e.message.attachments[0].scan === 'clean'), 30000);
    await sleep(1500);
    pConn.close();
    const pUpdates = pConn.events.filter((e) => e.t === 'message-updated' && e.message.id === pMid);
    check('exactly ONE transition, no clamd involved', pUpdates.length === 1 && !!pDone, 'updates=' + pUpdates.length);
    const pAtt = pDone && pDone.message.attachments[0];
    check('final bytes are compressed + clean', !!pAtt && pAtt.mime === 'audio/mpeg' && pAtt.size < pUp.size, pAtt && (pAtt.mime + ' ' + pAtt.size + ' < ' + pUp.size));
    check('no clamd was asked anything at all', fake.state.scans === scansBefore, 'scans=' + (fake.state.scans - scansBefore));
    const pServed = await fetch(`http://127.0.0.1:${PORT}${pAtt ? pAtt.url : ''}`);
    check('the published file is servable through the gate', pServed.status === 200, 'status=' + pServed.status);
    check('old scan row dropped, new key carries the verdict', (await scanRow(pUp.url.split('?')[0].replace('/uploads/', ''))) === null && !!(await scanRow(pAtt && pAtt.url.split('?')[0].replace('/uploads/', ''))));

    console.log('\n-- sweeper: an already-visible file is republished on a NEW key --');
    // Bytes + a clean verdict + compressed = 0: exactly the state of a file
    // uploaded while the compressor was off. Only the sweeper can pick it up,
    // and it may not rewrite the bytes the URL already points at.
    const oldKey = 'files/' + crypto.randomBytes(16).toString('hex') + '.jpg';
    const oldPath = path.join(uploads, oldKey);
    fs.copyFileSync(media.jpg, oldPath);
    const oldSize = fs.statSync(oldPath).size;
    const oldHash = crypto.createHash('sha256').update(fs.readFileSync(oldPath)).digest('hex');
    await db.query("INSERT INTO file_scans (key,status,attempts,error,created_at,scanned_at) VALUES ($1,'clean',1,'',$2,$2)", [oldKey, Date.now()]);
    const swConn = await connectWs(token);
    await waitFor(() => swConn.events.some((e) => e.t === 'hello'), 5000);
    swConn.send({
      t: 'message', serverId: srv.server.id, channelId, content: '',
      attachments: [{ url: '/uploads/' + oldKey + '?v=' + Date.now().toString(36), name: 'old-photo.jpg', mime: 'image/jpeg', size: oldSize, kind: 'image' }],
    });
    const swNew = await waitFor(() => swConn.events.find((e) => e.t === 'message-new'), 8000);
    if (!swNew) fail('sweeper fixture message never arrived');
    const swMid = swNew.message.id;
    const swDone = await waitFor(() => swConn.events.find((e) => e.t === 'message-updated' && e.message.id === swMid
      && e.message.attachments[0].url.split('?')[0] !== '/uploads/' + oldKey), 40000);
    swConn.close();
    const swAtt = swDone && swDone.message.attachments[0];
    const newKey = swAtt && swAtt.url.split('?')[0].replace('/uploads/', '');
    check('the sweeper compressed the already-visible file', !!swAtt && swAtt.size > 0 && swAtt.size < oldSize, swAtt && (swAtt.size + ' < ' + oldSize));
    check('compressed bytes landed on a NEW key', !!newKey && newKey !== oldKey, newKey);
    check('the published URL was never rewritten in place', fs.existsSync(oldPath)
      && crypto.createHash('sha256').update(fs.readFileSync(oldPath)).digest('hex') === oldHash);
    const oldRows = await rowFor(oldKey);
    const newRows = await rowFor(newKey);
    check('the row follows the new key (the old one is left for the orphan sweep)',
      oldRows.length === 0 && newRows.length === 1 && Number(newRows[0].compressed) === 1,
      JSON.stringify({ old: oldRows.length, now: newRows.length }));
    const newServed = await fetch(`http://127.0.0.1:${PORT}${swAtt ? swAtt.url : ''}`);
    check('the re-published file is servable', newServed.status === 200, 'status=' + newServed.status);

    // ---------- stories ----------
    // Story media is uploaded through the same /api/upload path as chat, but its
    // only "row" is the story itself — so without stories in the queue a story
    // photo or video sits at full size forever.
    console.log('\n-- stories: story media is compression media too --');
    const stUp = await uploadFile(media.jpg, 'story-photo.jpg', 'image/jpeg', token);
    const stRes = await api('POST', '/api/stories', {
      url: stUp.url, mime: stUp.mime, kind: 'image', caption: 'pipeline test', audience: 'friends', durationMs: 5000,
    }, token);
    const storyId = stRes.story && stRes.story.id;
    check('story posted', !!storyId, JSON.stringify(stRes).slice(0, 200));
    const stRow = await waitForAsync(async () => {
      if (!storyId) return null;
      const r = await db.query('SELECT compressed, size, url, mime FROM stories WHERE id = $1', [storyId]);
      const row = r.rows[0];
      return row && Number(row.compressed) === 1 ? row : null;
    }, 40000);
    check('story media compressed without anyone posting a message', !!stRow, 'the story row never settled');
    if (stRow) {
      const oldKey = stUp.url.split('?')[0].replace('/uploads/', '');
      const storyKey = stRow.url.split('?')[0].replace('/uploads/', '');
      // Either path is correct: the slot may have compressed it before the story
      // row existed (same key, nothing was servable yet), or the queue picked the
      // new row up seconds later (a fresh key, the old bytes left for the sweep).
      check('the story points at the compressed bytes', fs.existsSync(path.join(uploads, storyKey))
        && fs.statSync(path.join(uploads, storyKey)).size === Number(stRow.size)
        && Number(stRow.size) < fs.statSync(media.jpg).size, storyKey + ' ' + stRow.size + ' vs ' + fs.statSync(media.jpg).size);
      check('the story url carries a fresh cache key', /\?v=/.test(stRow.url), stRow.url);
      check('the story key is in the ledger', ((await db.query("SELECT status FROM media_compress_keys WHERE key = $1", [storyKey])).rows[0] || {}).status === 'compressed');
      if (storyKey !== oldKey) check('the superseded upload is left for the orphan sweep', fs.existsSync(path.join(uploads, oldKey)));
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
    const legacyRow = await waitForAsync(async () => {
      const r = await db.query('SELECT compressed, size, url FROM stories WHERE id = $1', [legacyId]);
      const row = r.rows[0];
      return row && Number(row.compressed) === 1 ? row : null;
    }, 40000);
    check('a story with no size was still compressed', !!legacyRow, 'the queue skipped it as below the floor');
    if (legacyRow) {
      const legacyNew = legacyRow.url.split('?')[0].replace('/uploads/', '');
      check('...and the object size is now recorded on the row', Number(legacyRow.size) > 0, 'size=' + legacyRow.size);
      check('...on a fresh key, with the old bytes left alone', legacyNew !== legacyKey && fs.existsSync(path.join(uploads, legacyKey)) && fs.existsSync(path.join(uploads, legacyNew)));
    }

    // ---------- the scheduled bucket reconciliation ----------
    // The queue is flag-driven, so a flagless table (profile media), an object
    // only a pasted link mentions, and anything an older build left behind are
    // all invisible to it. The bucket scan is the answer to those, and the key
    // ledger is what keeps it from re-encoding what it already handled.
    console.log('\n-- bucket scan: profile media, the ledger, and what it must not touch --');
    await db.query('UPDATE users SET is_admin = 1 WHERE id = $1', [reg.user.id]);
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

    const dry1 = await api('POST', '/api/admin/media/scan?dry=1', undefined, token);
    check('a dry pass reports the avatar as a candidate', (dry1.result.candidates || 0) >= 1, JSON.stringify(dry1.result));
    check('...and nothing was compressed by it', fs.statSync(avPath).size === fs.statSync(media.jpg).size);
    check('the unreferenced object is reported, not queued', (dry1.result.skippedOrphan || 0) >= 1, 'skippedOrphan=' + dry1.result.skippedOrphan);
    check('the pasted-link object is reported separately', (dry1.result.skippedText || 0) >= 1, 'skippedText=' + dry1.result.skippedText);

    await api('POST', '/api/admin/media/scan', undefined, token);
    const avNew = await waitForAsync(async () => {
      const r = await db.query('SELECT avatar_url FROM users WHERE id = $1', [reg.user.id]);
      const url = r.rows[0] && r.rows[0].avatar_url;
      return url && url !== avOld ? url : null;
    }, 90000);
    check('the scan repointed the avatar to a new key', !!avNew && avNew.split('?')[0] !== '/uploads/' + avKey, avNew);
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

    const dry2 = await api('POST', '/api/admin/media/scan?dry=1', undefined, token);
    check('the ledger stops a second pass re-encoding anything', (dry2.result.candidates || 0) === 0,
      JSON.stringify({ candidates: dry2.result.candidates, ledger: dry2.result.ledger, objects: dry2.result.objects }));
    const adm = await api('GET', '/api/admin/media', undefined, token);
    check('the admin payload carries the bucket-scan state',
      !!(adm.bucketScan && adm.bucketScan.enabled && adm.bucketScan.lastResult && Number(adm.bucketScan.lastResult.compressed) >= 1),
      JSON.stringify(adm.bucketScan && { enabled: adm.bucketScan.enabled, last: adm.bucketScan.lastResult }));
    await db.query('UPDATE users SET is_admin = 0 WHERE id = $1', [reg.user.id]);

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
