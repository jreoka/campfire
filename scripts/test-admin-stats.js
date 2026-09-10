// Site-admin Overview stats (see AGENTS.md verification conventions).
//
// The card reads "Online" and the owner saw 1 while two people were connected.
// Two things were wrong/needed:
//   - the number was raw sockets (clients.size) — two tabs counted twice,
//   - it only refreshed when the tab was opened, so any change after that
//     (a friend connecting) never showed up without a manual refresh.
// This boots a real server against a throwaway database and asserts the
// distinct-user count (sessions still reported separately) plus the live
// 'admin-presence' push that keeps the panel current.
//
// Requirements: Postgres reachable (docker compose up -d db).
// Skips (exit 0) with a message when it isn't.
//
// Usage: node scripts/test-admin-stats.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_admin_test';
const PORT = parseInt(process.env.TEST_PORT || '3413', 10);

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
  // Sockets are opened one at a time so each push can be attributed to the
  // action that caused it.
  const wait = nextStart - Date.now();
  if (wait > 0) await sleep(wait);
  nextStart = Date.now() + 300;
  return new Promise((resolve, reject) => {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
    ws.on('error', reject);
    ws.on('message', (raw) => { try { events.push(JSON.parse(raw.toString())); } catch {} });
    ws.on('open', () => resolve({
      events,
      presence: () => events.filter((e) => e.t === 'admin-presence'),
      lastPresence: () => [...events].reverse().find((e) => e.t === 'admin-presence') || null,
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-admin-'));
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
        JWT_SECRET: 'test-admin-stats-secret',
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

    console.log('\n[1] accounts');
    // username 'jreoka' is the site owner → auto-admin, so the throwaway DB
    // needs no seeding (same rule the real instance relies on).
    const adm = await api('POST', '/api/register', { body: { username: 'jreoka', displayName: 'Admin', password: 'passw0rd!x' } });
    check(!!(adm.status === 200 && adm.data.token), 'register admin (owner username auto-admins)', adm.data);
    const a = await api('POST', '/api/register', { body: { username: 'adma', displayName: 'A', password: 'passw0rd!x' } });
    const b = await api('POST', '/api/register', { body: { username: 'admb', displayName: 'B', password: 'passw0rd!x' } });
    check(a.status === 200 && b.status === 200, 'register two more users');
    const tAdmin = adm.data.token, tA = a.data.token, tB = b.data.token;

    let stats = await api('GET', '/api/admin/stats', { token: tA });
    check(stats.status === 403, 'non-admins cannot read the stats', stats.status);

    console.log('\n[2] three users online → 3, not 4 (two tabs are one person)');
    const cAdmin = await connectWs(tAdmin); conns.push(cAdmin);
    await waitFor(() => cAdmin.events.some((e) => e.t === 'hello'), 5000);
    const cA1 = await connectWs(tA); conns.push(cA1);
    await waitFor(() => cA1.events.some((e) => e.t === 'hello'), 5000);
    const cB = await connectWs(tB); conns.push(cB);
    await waitFor(() => cB.events.some((e) => e.t === 'hello'), 5000);
    const cA2 = await connectWs(tA); conns.push(cA2);
    await waitFor(() => cA2.events.some((e) => e.t === 'hello'), 5000);

    stats = await api('GET', '/api/admin/stats', { token: tAdmin });
    check(stats.data.online === 3, 'online counts distinct users', { online: stats.data.online });
    check(stats.data.sessions === 4, 'sessions counts sockets', { sessions: stats.data.sessions });

    const p3 = await waitFor(() => cAdmin.lastPresence(), 5000);
    check(!!p3 && p3.online === 3 && p3.sessions === 4, 'admin was pushed the live counts on connect', p3);
    check(cA1.presence().length === 0, 'non-admins never receive admin-presence', cA1.presence().length);

    console.log('\n[3] going invisible drops out of the count');
    let r = await api('PATCH', '/api/me', { token: tB, body: { status: 'invisible' } });
    check(r.status === 200, 'B switches to invisible', r.data);
    const pInv = await waitFor(() => cAdmin.lastPresence() && cAdmin.lastPresence().online === 2 ? cAdmin.lastPresence() : null, 5000);
    check(!!pInv && pInv.sessions === 4, 'push: online 2, sessions 4', pInv);
    stats = await api('GET', '/api/admin/stats', { token: tAdmin });
    check(stats.data.online === 2, 'endpoint agrees (2)', { online: stats.data.online });

    r = await api('PATCH', '/api/me', { token: tB, body: { status: 'online' } });
    const pBack = await waitFor(() => cAdmin.lastPresence() && cAdmin.lastPresence().online === 3 ? cAdmin.lastPresence() : null, 5000);
    check(r.status === 200 && !!pBack, 'back online → pushed 3 again', pBack);

    console.log('\n[4] disconnects push the new number');
    cA2.close();
    const pDrop = await waitFor(() => cAdmin.lastPresence() && cAdmin.lastPresence().sessions === 3 ? cAdmin.lastPresence() : null, 5000);
    check(!!pDrop && pDrop.online === 3, 'one tab closed: 3 online, 3 sessions', pDrop);

    cB.close();
    const pB = await waitFor(() => cAdmin.lastPresence() && cAdmin.lastPresence().online === 2 ? cAdmin.lastPresence() : null, 5000);
    check(!!pB && pB.sessions === 2, 'B left: online 2, sessions 2', pB);

    console.log('\n[5] the endpoint and the push agree');
    stats = await api('GET', '/api/admin/stats', { token: tAdmin });
    check(stats.data.online === 2 && stats.data.sessions === 2, 'stats = push', { online: stats.data.online, sessions: stats.data.sessions });
    check(typeof stats.data.users === 'number' && typeof stats.data.messages === 'number', 'the other cards still come from the same payload', stats.data);
  } finally {
    for (const c of conns) { try { c.close(); } catch {} }
    if (child) { try { child.kill(); } catch {} }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => '  - ' + f).join('\n')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('[test] crashed:', (e && e.message) || e); process.exit(1); });
