// Pin "seen" memory sync — the pin button badge across devices (see AGENTS.md
// verification conventions).
//
// The badge is a per-account memory: pins this account has already looked at.
// It used to live in localStorage only, so clearing it on the phone left the
// badge lit on the desktop. It is mirrored in the pin_seen table now, and the
// server pushes pin-seen to the account's other sockets. This boots a real
// server against a throwaway database and asserts the whole route:
//   - a write is readable by the same account (a fresh device can pull it),
//   - the account's OTHER sockets get the live push (two tabs / two devices),
//   - the row is dropped when a conversation's list empties,
//   - the memory never leaks to another account,
//   - bad contexts / no token are refused,
//   - ids are deduped, capped, and the table stays bounded per account.
//
// Requirements: Postgres reachable (docker compose up -d db).
// Skips (exit 0) with a message when it isn't.
//
// Usage: node scripts/test-pin-seen-sync.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_pin_seen_test';
const PORT = parseInt(process.env.TEST_PORT || '3419', 10);

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

async function api(method, p, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers, body: payload });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

let nextStart = 0;
async function connectWs(token) {
  const wait = nextStart - Date.now();
  if (wait > 0) await sleep(wait);
  nextStart = Date.now() + 250;
  return new Promise((resolve, reject) => {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
    ws.on('error', reject);
    ws.on('message', (raw) => { try { events.push(JSON.parse(raw.toString())); } catch {} });
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'subscribe' }));
      resolve({ events, close: () => { try { ws.close(); } catch {} } });
    });
  });
}

async function waitFor(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = fn(); } catch {}
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(120);
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-ps-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });

  let child = null;
  const conns = [];
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
        JWT_SECRET: 'test-pin-seen-secret',
        UPLOAD_DIR: uploads,
        UNFURL: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    const fail = (msg) => { throw new Error(msg + '\n--- server log ---\n' + serverLog.slice(-4000)); };
    if (!(await waitForHttp('/api/config', 30000))) return fail('server did not come up');

    console.log('\n[1] accounts + two sockets for the same account');
    const reg = async (n) => {
      const r = await api('POST', '/api/register', { body: { username: n, displayName: n.toUpperCase(), password: 'passw0rd!x' } });
      if (!(r.status === 200 && r.data.token)) throw new Error('register ' + n + ' failed: ' + JSON.stringify(r.data));
      return r.data.token;
    };
    const tokA = await reg('psa'), tokB = await reg('psb');
    const A1 = await connectWs(tokA); conns.push(A1);   // "phone"
    const A2 = await connectWs(tokA); conns.push(A2);   // "desktop"
    const B1 = await connectWs(tokB); conns.push(B1);   // another account
    check(await waitFor(() => A1.events.some((e) => e.t === 'hello'), 5000), 'sockets are up');

    console.log('\n[2] a read on one device is shared');
    const ctx = 's:srv1:chan1';
    let r = await api('POST', '/api/pins/seen', { token: tokA, body: { ctx, ids: ['p1', 'p2'] } });
    check(r.status === 200 && r.data.ctx === ctx && r.data.ids.length === 2, 'write accepted', r.data);
    r = await api('GET', '/api/pins/seen', { token: tokA });
    check(r.status === 200 && r.data.seen[ctx] && r.data.seen[ctx].ids.join(',') === 'p1,p2', 'the same account can read it back (a fresh device pulls this)', r.data);
    const push = await waitFor(() => A2.events.find((e) => e.t === 'pin-seen'), 5000);
    check(!!push, 'the account\'s OTHER socket is pushed the same memory');
    check(push && push.ctx === ctx && push.ids.join(',') === 'p1,p2', 'with the conversation + ids', push);
    check(!B1.events.some((e) => e.t === 'pin-seen'), 'nobody else hears about it');
    const bSeen = await api('GET', '/api/pins/seen', { token: tokB });
    check(bSeen.data.seen && Object.keys(bSeen.data.seen).length === 0, 'another account has its own (empty) memory', bSeen.data);

    console.log('\n[3] the memory is replaced, and dropped when it empties');
    r = await api('POST', '/api/pins/seen', { token: tokA, body: { ctx, ids: ['p9'] } });
    check(r.status === 200, 'a second write replaces the list');
    r = await api('GET', '/api/pins/seen', { token: tokA });
    check(r.data.seen[ctx].ids.join(',') === 'p9', 'only the new list is stored (no pile-up)', r.data.seen[ctx]);
    const before = A2.events.length;
    await api('POST', '/api/pins/seen', { token: tokA, body: { ctx, ids: [] } });
    r = await api('GET', '/api/pins/seen', { token: tokA });
    check(!r.data.seen[ctx], 'an empty list drops the row (nothing to re-read later)', r.data);
    check(await waitFor(() => A2.events.length > before && A2.events[A2.events.length - 1].t === 'pin-seen', 5000), 'other devices are told to clear it too');

    console.log('\n[4] ids are clean, contexts are validated');
    r = await api('POST', '/api/pins/seen', { token: tokA, body: { ctx: 'd:thread1', ids: ['a', 'a', 'b', '', null, 'x'.repeat(200)] } });
    check(r.status === 200 && r.data.ids.join(',') === 'a,b', 'deduped, blanks and oversize ids dropped', r.data.ids);
    r = await api('POST', '/api/pins/seen', { token: tokA, body: { ctx: 'nope', ids: ['a'] } });
    check(r.status === 400 && r.data.error === 'bad_pin_ctx', 'a context that is not a conversation key is refused', r.data);
    r = await api('POST', '/api/pins/seen', { token: tokA, body: { ctx: 's:srv1:chan1:extra', ids: ['a'] } });
    check(r.status === 400, 'too many ctx segments are refused', r.data);
    r = await api('GET', '/api/pins/seen');
    check(r.status === 401, 'no token → 401', r.status);
    r = await api('POST', '/api/pins/seen', { body: { ctx, ids: ['a'] } });
    check(r.status === 401, 'no token on write → 401', r.status);

    console.log('\n[5] the table stays bounded per account');
    for (let i = 0; i < 210; i++) await api('POST', '/api/pins/seen', { token: tokA, body: { ctx: 'd:bulk' + i, ids: ['b' + i] } });
    r = await api('GET', '/api/pins/seen', { token: tokA });
    const keys = Object.keys(r.data.seen || {});
    check(keys.length === 200, 'only the newest 200 conversations are kept', keys.length);
    check(!keys.includes('d:bulk0'), 'the oldest row was pruned');
    check(keys.includes('d:bulk209'), 'the newest row survived');
    r = await api('GET', '/api/pins/seen', { token: tokB });
    check(Object.keys(r.data.seen || {}).length === 0, 'the other account is unaffected by the pruning', r.data);

    console.log('\n' + (failures.length ? failures.length + ' FAILED, ' + passed + ' passed' : 'all ' + passed + ' checks passed'));
    for (const c of conns) c.close();
    try { child.kill(); } catch {}
    await dropTestDb(pg);
    process.exit(failures.length ? 1 : 0);
  } catch (err) {
    console.error('\n[test] ERROR: ' + ((err && err.message) || err));
    for (const c of conns) c.close();
    try { child && child.kill(); } catch {}
    await dropTestDb(pg);
    process.exit(1);
  }
}

async function dropTestDb(pg) {
  try {
    const c = new Client({ ...pg, database: 'postgres' });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await c.end();
  } catch {}
}

main();
