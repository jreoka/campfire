// GET /api/dms/messages/:mid — reading ONE DM message back by its id.
//
// The DM twin of GET /api/messages/:mid, which the pin/reaction surfaces use for
// channels (see pickers.js). Its only in-app caller used to be the client's
// "still saying Processing" resync — the pass a reconnect or a foregrounded tab
// ran to repair a message whose verdict push it had missed. That whole path is
// gone with the scanning card: an upload is served as it lands and a verdict is a
// background judgement (see virus-scan.js), so the client can no longer be left
// holding a state the server has moved on from, and there is nothing to resync.
// The route stays as the twin of the channel one, and this pins its contract:
// a member re-reads a message on its own thread, a stranger cannot use it to
// probe ids (404, like its neighbours), and it needs a session.
//
// Needs Postgres (docker compose up -d db); skips (exit 0) without it.
//
// Usage: node scripts/test-dm-message-route.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_dm_route';
const PORT = parseInt(process.env.TEST_PORT || '3417', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }

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
async function api(method, p, body, token) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await res.json(); } catch {}
  return { status: res.status, data: j };
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
    const WebSocket = require('ws');
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
    let v = null;
    try { v = await fn(); } catch {}
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(150);
  }
}
async function waitForHttp(p, ms) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); if (r.ok) return true; } catch {}
    if (Date.now() - t0 > ms) return false;
    await sleep(250);
  }
}

async function main() {
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-dmroute-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  const note = path.join(tmp, 'note.txt');
  fs.writeFileSync(note, 'a file on a DM, and the message that carries it\n');

  let child = null, db = null;
  let serverLog = '';
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();

    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        PGHOST: pg.host, PGPORT: String(pg.port), PGUSER: pg.user, PGPASSWORD: pg.password, PGDATABASE: TEST_DB,
        JWT_SECRET: 'test-dm-message-route-secret',
        UPLOAD_DIR: uploads,
        // No scanner: nothing here is about a verdict, and this test then needs no
        // stand-in daemon at all.
        VIRUS_SCAN: '0',
        MEDIA_COMPRESS: '0',
        UNFURL: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    const fail = (msg) => { throw new Error(msg + '\n--- server log ---\n' + serverLog.slice(-3000)); };
    if (!(await waitForHttp('/api/config', 30000))) return fail('server did not come up');

    const reg = async (username) => (await api('POST', '/api/register', { username, password: 'test1234', displayName: username })).data;
    const a = await reg('dmroutea');
    const b = await reg('dmrouteb');
    const stranger = await reg('dmroutec');
    const dm = (await api('POST', '/api/dms', { userId: b.user.id }, a.token)).data.thread;
    db = new Client({ ...pg, database: TEST_DB });
    await db.connect();

    console.log('\nGET /api/dms/messages/:mid — the DM twin of the channel route');
    const conn = await connectWs(a.token);
    await waitFor(() => conn.events.some((e) => e.t === 'hello'), 5000);
    const up = await uploadFile(note, 'note.txt', 'text/plain', a.token);
    conn.send({ t: 'dm', threadId: dm.id, content: '', attachments: [{ url: up.url, name: up.name, mime: up.mime, size: up.size, kind: up.kind }], replyTo: null });
    const created = await waitFor(() => conn.events.find((e) => e.t === 'dm-new'), 8000);
    conn.close();
    check(!!created, 'a DM message with an attachment exists', created && created.message && created.message.id);
    const mid = created && created.message.id;

    let r = await api('GET', `/api/dms/messages/${mid}`, undefined, a.token);
    check(r.status === 200 && r.data && r.data.message && r.data.message.id === mid, 'a member re-reads it by id', { status: r.status });
    check(!!r.data && r.data.message.threadId === dm.id, 'and it comes back on its thread', r.data && r.data.message.threadId);
    const atts = (r.data && r.data.message && r.data.message.attachments) || [];
    check(atts.length === 1 && atts[0].scan === 'clean', "carrying the attachment's scan state", atts.map((x) => x.scan));
    check(atts[0] && atts[0].id === (created.message.attachments[0] || {}).id,
      'with the attachment id a renderer patches by', atts[0] && atts[0].id);

    r = await api('GET', `/api/dms/messages/${mid}`, undefined, stranger.token);
    check(r.status === 404, 'a stranger gets 404 — the route cannot be used to probe ids', r.status);
    r = await api('GET', '/api/dms/messages/does-not-exist', undefined, a.token);
    check(r.status === 404, 'an unknown id is a 404 too', r.status);
    r = await api('GET', `/api/dms/messages/${mid}`);
    check(r.status === 401, 'and it needs a session', r.status);

    await db.end();
  } catch (e) {
    console.log('--- server log tail ---\n' + serverLog.split('\n').slice(-30).join('\n'));
    throw e;
  } finally {
    try { if (db) await db.end(); } catch {}
    try { if (child) child.kill(); } catch {}
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
    console.log('--- server log tail ---\n' + serverLog.split('\n').slice(-30).join('\n'));
    process.exit(1);
  }
  console.log('DM message route: OK');
}

main().catch((e) => { console.error('[test] FAILED:', (e && e.stack) || e); process.exit(1); });
