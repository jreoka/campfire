// DM unread badges (see AGENTS.md verification conventions).
//
// The bug this covers: the campfire rail's unread DM avatars (`#dm-rail`, the
// row of senders under the Home button) were built only from live `dm-new`
// pushes held in an in-memory Map. Every reload wiped them — and a deploy
// guarantees one, because a new image changes the `/api/version` fingerprint
// and the auto-updater reloads the tab seconds later. So "someone DMs me, then
// a rollout happens" silently dismissed the notification.
//
// Unread now lives in the database (`dm_members.last_read_at`, stamped by
// `POST /api/dms/:tid/read`) and `/api/dms` reports it per thread, so a reload
// repaints the badges from the same numbers. A member's start line is
// `joined_at`, so being added to an old group chat doesn't flag its history.
//
// Boots a real server against a throwaway database for the API half (the count
// the client reloads into, mark-read + its cross-device push, own/system
// messages, membership and auth) and slices the real client functions out of
// `public/js/home.js` for the merge half. Skips (exit 0) when Postgres is down.
//
// Usage: node scripts/test-dm-unread.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_dm_unread_test';
const PORT = parseInt(process.env.TEST_PORT || '3423', 10);

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
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}

// ---------- [A] the client merge, offline ----------
// refreshDms() is the whole reload story: it takes the server's per-thread
// count and repaints the rows + the rail. Run the real function against fakes.
function clientChecks() {
  console.log('\n[A1] a reload repaints the badges from the server');
  const home = fs.readFileSync(path.join(ROOT, 'public/js/home.js'), 'utf8');
  const socket = fs.readFileSync(path.join(ROOT, 'public/js/socket.js'), 'utf8');
  const pins = fs.readFileSync(path.join(ROOT, 'public/js/pins.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const db = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');

  const code = slice(home, 'async function refreshDms()', '// Red count on the campfire home button');
  const MS = { me: { id: 'me' }, view: 'home', dmThreadId: null, dmUnread: new Map(), dms: [] };
  const calls = [];
  let listed = 0, painted = 0;
  let payload = [];
  const fakeApi = (p, opts) => {
    calls.push({ path: p, method: (opts && opts.method) || 'GET' });
    return Promise.resolve(p === '/api/dms' ? { threads: payload } : {});
  };
  // Built with new Function (not a bare eval) so the fakes cannot be shadowed by
  // this file's own module-level `api(...)` HTTP helper, which a direct eval in
  // strict mode would resolve first — the slice's try/catch would swallow the
  // resulting TypeError and every check would look like "nothing happened".
  const build = new Function('api', 'renderDmLists', 'paintHomeBadge', 'S', code + '\nreturn { refreshDms, markDmRead };');
  const { refreshDms, markDmRead } = build(fakeApi, () => { listed++; }, () => { painted++; }, MS);

  return (async () => {
    payload = [{ id: 't1', unread: 3 }, { id: 't2', unread: 0 }];
    MS.dmUnread = new Map([['t3', 2]]);
    await refreshDms();
    check(MS.dmUnread.get('t1') === 3, 'an unread DM comes back as its server count', [...MS.dmUnread]);
    check(!MS.dmUnread.has('t2'), 'a read thread gets no badge');
    check(!MS.dmUnread.has('t3'), 'a thread that is gone (left/closed) drops its count');
    check(listed > 0, 'the DM list is repainted (which also repaints the rail)');

    MS.dmThreadId = 't1';
    payload = [{ id: 't1', unread: 5 }, { id: 't2', unread: 1 }];
    await refreshDms();
    check(!MS.dmUnread.has('t1'), 'the chat you are looking at never keeps a badge');
    check(MS.dmUnread.get('t2') === 1, 'while the others still paint');
    MS.dmThreadId = null;
    MS.view = 'server';
    payload = [{ id: 't1', unread: 5 }];
    await refreshDms();
    check(MS.dmUnread.get('t1') === 5, 'off Home, the open-thread exception does not apply', [...MS.dmUnread]);
    MS.view = 'home';

    console.log('\n[A2] reading a thread is reported, not just cleared locally');
    MS.dmUnread = new Map([['t9', 4]]);
    calls.length = 0;
    markDmRead('t9', 0);
    check(!MS.dmUnread.has('t9'), 'the badge clears on the spot');
    check(painted > 0, 'and repaints immediately');
    await sleep(40);
    const post = calls.find((c) => c.path === '/api/dms/t9/read');
    check(!!post && post.method === 'POST', 'the read is sent to the server', calls);

    MS.dmUnread = new Map([['t8', 2]]);
    calls.length = 0;
    markDmRead('t8', 40);
    markDmRead('t8', 40);
    markDmRead('t8', 40);
    await sleep(100);
    check(calls.filter((c) => c.path === '/api/dms/t8/read').length === 1,
      'a burst in the open chat is one write', calls);

    console.log('\n[A3] the wiring');
    check(/case 'dm-new': \{[\s\S]*?markDmRead\(msg\.threadId\);/.test(socket), 'a message in the open chat stamps it read (socket dm-new)');
    check(/case 'dm-read': \{[\s\S]*?S\.dmUnread\.delete\(m\.threadId\)/.test(socket), 'the dm-read push clears the badge on this account\'s other devices');
    check(/markDmRead\(id, 0\)/.test(pins), 'opening a DM stamps it immediately (selectDmThread)');
    check(/v\.unread = unread\.get\(id\) \|\| 0;/.test(server), '/api/dms carries the per-thread count');
    check(/app\.post\('\/api\/dms\/:tid\/read', authRequired/.test(server), 'the read route exists and requires auth');
    check(/UPDATE dm_members SET last_read_at = \? WHERE thread_id = \? AND user_id = \?/.test(server), 'reading stamps only your own membership row');
    check(/notifyUser\(req\.user\.id, \{ t: 'dm-read', threadId: t\.id \}\)/.test(server), 'and is pushed back to the account (no per-tab memory)');
    check(/m\.created_at > COALESCE\(mem\.last_read_at, mem\.joined_at\)/.test(server), 'a never-read row starts at joined_at, not at the dawn of time');
    check(/m\.user_id IS NOT NULL AND m\.user_id != \?/.test(server), 'your own messages never count');
    check(/\(m\.sys IS NULL OR m\.sys = ''\)/.test(server), 'system lines never count');
    check(/if \(!\(await columnExists\('dm_members', 'last_read_at'\)\)\)/.test(db), 'the column is a guarded migration');
    check(/await db\.transaction\(async \(\) => \{\s*await db\.exec\('ALTER TABLE dm_members ADD COLUMN last_read_at BIGINT'\);\s*await db\.prepare\('UPDATE dm_members SET last_read_at = \? WHERE last_read_at IS NULL'\)\.run\(Date\.now\(\)\);\s*\}\)/.test(db),
      'and ALTER + backfill are ONE transaction (a crash between them cannot strand legacy rows)');
    check(/dmUnread: new Map\(\)/.test(fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8')), 'the store lives on S');
  })();
}

// ---------- [B] the API, against a real server ----------
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
async function waitFor(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch {}
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(100);
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
  await clientChecks();

  const envFile = readEnvFile();
  const pg = {
    host: process.env.PGHOST || envFile.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || envFile.POSTGRES_USER || 'campfire',
    password: process.env.PGPASSWORD || envFile.POSTGRES_PASSWORD || '',
  };
  const admin = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
  try { await admin.connect(); }
  catch (e) {
    console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
    if (failures.length) process.exit(1);
    return skip('Postgres unreachable (' + ((e && e.message) || e) + ') — the API half was skipped');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-dmu-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });

  let child = null;
  const conns = [];
  let serverLog = '';
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();

    const env = {
      ...process.env,
      PORT: String(PORT),
      PGHOST: pg.host, PGPORT: String(pg.port), PGUSER: pg.user, PGPASSWORD: pg.password, PGDATABASE: TEST_DB,
      JWT_SECRET: 'test-dm-unread-secret',
      UPLOAD_DIR: uploads,
      UNFURL: '0',
    };
    const fail = (msg) => { throw new Error(msg + '\n--- server log ---\n' + serverLog.slice(-4000)); };
    const boot = async () => {
      child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (d) => { serverLog += d; });
      child.stderr.on('data', (d) => { serverLog += d; });
      if (!(await waitForHttp('/api/config', 30000))) fail('server did not come up');
      return child;
    };
    const stop = async () => {
      try { child && child.kill(); } catch {}
      child = null;
      const t0 = Date.now(); // wait for the port to actually go quiet, or the next boot's health check hits the dying process
      for (;;) {
        try { await fetch(`http://127.0.0.1:${PORT}/api/config`); } catch { return; }
        if (Date.now() - t0 > 8000) return;
        await sleep(150);
      }
    };
    await boot();

    const reg = async (n) => {
      const r = await api('POST', '/api/register', { body: { username: n, displayName: n.toUpperCase(), password: 'passw0rd!x' } });
      if (!(r.status === 200 && r.data.token)) throw new Error('register ' + n + ' failed: ' + JSON.stringify(r.data));
      return r.data;
    };
    const meId = async (t) => (await api('GET', '/api/me', { token: t })).data.user.id;
    const connect = (token) => new Promise((resolve, reject) => {
      const events = [];
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
      ws.on('error', reject);
      ws.on('message', (raw) => { try { events.push(JSON.parse(raw.toString())); } catch {} });
      ws.on('open', () => { ws.send(JSON.stringify({ t: 'subscribe' })); resolve({ events, send: (o) => ws.send(JSON.stringify(o)), close: () => { try { ws.close(); } catch {} } }); });
    });
    const unreadOf = async (token, tid) => {
      const r = await api('GET', '/api/dms', { token });
      const t = (r.data.threads || []).find((x) => x.id === tid);
      return t ? t.unread : null;
    };

    console.log('\n[B1] the number a reload repaints from');
    const A = await reg('dmua'), B = await reg('dmub'), C = await reg('dmuc');
    const idA = await meId(A.token), idB = await meId(B.token), idC = await meId(C.token);
    for (const n of ['dmub', 'dmuc']) await api('POST', '/api/friends', { token: A.token, body: { username: n } });
    await api('POST', `/api/friends/${idA}/accept`, { token: B.token });
    await api('POST', `/api/friends/${idA}/accept`, { token: C.token });

    let r = await api('POST', '/api/dms', { token: A.token, body: { userId: idB } });
    const t1 = r.data.thread && r.data.thread.id;
    check(!!t1, 'A and B share a 1:1', r.data);
    check(await unreadOf(B.token, t1) === 0, 'nothing said yet, nothing unread');

    const asock = await connect(A.token), bsock = await connect(B.token);
    conns.push(asock, bsock);
    await sleep(300);
    asock.send({ t: 'dm', threadId: t1, content: 'first' });
    await waitFor(() => bsock.events.some((e) => e.t === 'dm-new'), 5000);
    check(await unreadOf(B.token, t1) === 1, 'the receiver\'s fetch reports the unread DM (this is the reload path)');
    check(await unreadOf(A.token, t1) === 0, 'the sender never has their own message unread');

    asock.send({ t: 'dm', threadId: t1, content: 'second' });
    await waitFor(() => bsock.events.filter((e) => e.t === 'dm-new').length >= 2, 5000);
    check(await unreadOf(B.token, t1) === 2, 'it counts up per message');

    console.log('\n[B2] reading it is durable, and shared across devices');
    r = await api('POST', `/api/dms/${t1}/read`, { token: B.token });
    check(r.status === 200, 'B marks the thread read', r.data);
    check(await unreadOf(B.token, t1) === 0, 'and a fresh fetch agrees (a reload keeps it cleared)');
    check(bsock.events.some((e) => e.t === 'dm-read' && e.threadId === t1),
      'the read is pushed to the account, so the phone clears the desktop', bsock.events.map((e) => e.t));

    asock.send({ t: 'dm', threadId: t1, content: 'third' });
    await waitFor(() => bsock.events.filter((e) => e.t === 'dm-new').length >= 3, 5000);
    check(await unreadOf(B.token, t1) === 1, 'a message after the read is unread again');

    console.log('\n[B3] auth and membership');
    r = await api('POST', `/api/dms/${t1}/read`, {});
    check(r.status === 401, 'marking read needs auth', r.status);
    r = await api('POST', `/api/dms/${t1}/read`, { token: C.token });
    check(r.status === 404 && r.data.error === 'no_thread', 'a stranger cannot mark someone else\'s thread read', r.data);
    r = await api('GET', '/api/dms', { token: C.token });
    check(!(r.data.threads || []).some((t) => t.id === t1), 'and it is not in their list');

    console.log('\n[B4] joining an old group chat does not inherit its history');
    r = await api('POST', '/api/dms/group', { token: A.token, body: { name: 'Old talk', userIds: [idB] } });
    const gid = r.data.thread && r.data.thread.id;
    check(!!gid, 'A and B have a group', r.data);
    const bOnGroup = bsock.events.filter((e) => e.t === 'dm-new' && e.message && e.message.threadId === gid).length;
    for (const c of ['one', 'two', 'three']) asock.send({ t: 'dm', threadId: gid, content: c });
    await waitFor(() => bsock.events.filter((e) => e.t === 'dm-new' && e.message && e.message.threadId === gid).length >= bOnGroup + 3, 5000);
    check(await unreadOf(A.token, gid) === 0, 'the sender has nothing unread in their own group');

    r = await api('POST', `/api/dms/${gid}/members`, { token: A.token, body: { userId: idC } });
    check(r.status === 200, 'C is added to the group', r.data);
    check(await unreadOf(C.token, gid) === 0, 'C joins caught up, not with the history they missed');
    asock.send({ t: 'dm', threadId: gid, content: 'after you joined' });
    await waitFor(async () => (await unreadOf(C.token, gid)) === 1, 5000);
    check(await unreadOf(C.token, gid) === 1, 'and the next message is unread for them');
    r = await api('POST', `/api/dms/${gid}/read`, { token: C.token });
    check(r.status === 200 && await unreadOf(C.token, gid) === 0, 'they can read it back to zero');

    console.log('\n[B5] system lines never count');
    r = await api('POST', `/api/dms/${gid}/members/${idB}/remove`, { token: A.token });
    check(r.status === 200, 'A removes B (which posts a system line)', r.data);
    check(await unreadOf(C.token, gid) === 0, 'the system line alone is not an unread message');
    asock.send({ t: 'dm', threadId: gid, content: 'still here' });
    await waitFor(async () => (await unreadOf(C.token, gid)) === 1, 5000);
    check(await unreadOf(C.token, gid) === 1, 'a real message after it still counts');

    console.log('\n[B6] the migration, on a database that predates the column');
    // Leave something unread so a bad migration has something to get wrong.
    const beforeSend = await unreadOf(B.token, t1);
    asock.send({ t: 'dm', threadId: t1, content: 'unread before the migration' });
    await waitFor(async () => (await unreadOf(B.token, t1)) === beforeSend + 1, 5000);
    check(await unreadOf(B.token, t1) === beforeSend + 1, 'B has an unread DM going into the restart', { beforeSend, now: await unreadOf(B.token, t1) });

    // Put the schema back the way it was before this change — every deployment
    // that exists today — then boot: initDb has to add the column AND mark the
    // memberships it finds "caught up" rather than counting them from joined_at.
    await stop();
    const sqldb = new Client({ ...pg, database: TEST_DB, connectionTimeoutMillis: 4000 });
    await sqldb.connect();
    await sqldb.query("SET statement_timeout = '10000'");
    const tracked = await sqldb.query('SELECT COUNT(last_read_at)::int AS stamped, COUNT(*)::int AS total FROM dm_members');
    check(tracked.rows[0].stamped > 0, 'reads were tracked before the drop', tracked.rows[0]);
    await sqldb.query('ALTER TABLE dm_members DROP COLUMN last_read_at');
    await boot();
    const after = await sqldb.query('SELECT COUNT(last_read_at)::int AS stamped, COUNT(*)::int AS total FROM dm_members');
    check(after.rows[0].total > 0 && after.rows[0].stamped === after.rows[0].total,
      'the column came back and every pre-existing membership was backfilled', after.rows[0]);
    check(await unreadOf(B.token, t1) === 0, 'so an old unread DM is not resurrected by the migration');

    // ...and the backfill has to stay one-shot: only reading may clear a message
    // that arrived after it, or every rollout would silently dismiss the DMs
    // that came in while the pod was running.
    const a2 = await connect(A.token);
    conns.push(a2);
    await sleep(300);
    a2.send({ t: 'dm', threadId: t1, content: 'unread after the migration' });
    await waitFor(async () => (await unreadOf(B.token, t1)) === 1, 5000);
    check(await unreadOf(B.token, t1) === 1, 'a message after the migration is unread');
    await stop();
    await boot();
    check(await unreadOf(B.token, t1) === 1, 'and a plain restart does not mark it read');
    await sqldb.end();
  } catch (e) {
    console.error('[test] ' + (e && e.stack || e));
    process.exit(1);
  } finally {
    for (const c of conns) { try { c.close(); } catch {} }
    try { child && child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}
main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
