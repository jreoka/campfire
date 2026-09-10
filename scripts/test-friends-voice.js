// Friends' voice presence — the Active Now "IN VOICE" rail (see AGENTS.md
// verification conventions).
//
// Active Now knew about games and Go Live but nothing about voice: a friend
// sitting in a server voice room (or a DM call) was invisible from Home, and a
// friend in a server you are not in leaked nothing either way. This boots a
// real server against a throwaway database and asserts the friend-scoped
// 'friends-voice' push end-to-end:
//   - friends get voice activity live, with no page refresh,
//   - joinable rooms (shared server / shared DM call) carry server + channel,
//   - rooms the viewer cannot reach stay nameless (no server enumeration),
//   - invisible friends are hidden exactly like the rest of presence,
//   - non-friends see nothing, and a late-joining socket gets the full map,
//   - the map follows join / leave / mod-disconnect / channel-delete / eviction.
//
// Requirements: Postgres reachable (docker compose up -d db).
// Skips (exit 0) with a message when it isn't.
//
// Usage: node scripts/test-friends-voice.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_friends_voice_test';
const PORT = parseInt(process.env.TEST_PORT || '3415', 10);

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
      ws.send(JSON.stringify({ t: 'subscribe' })); // what the real client does
      resolve({
        events,
        send: (o) => { try { ws.send(JSON.stringify(o)); } catch {} },
        // Latest full-map replace, the way the client reads it.
        voice: () => { const e = [...events].reverse().find((x) => x.t === 'friends-voice'); return e ? (e.voice || {}) : null; },
        close: () => { try { ws.close(); } catch {} },
      });
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-fv-'));
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
        JWT_SECRET: 'test-friends-voice-secret',
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

    console.log('\n[1] accounts, friendships, one shared server');
    const reg = async (n) => {
      const r = await api('POST', '/api/register', { body: { username: n, displayName: n.toUpperCase(), password: 'passw0rd!x' } });
      if (!(r.status === 200 && r.data.token)) throw new Error('register ' + n + ' failed: ' + JSON.stringify(r.data));
      return r.data;
    };
    const A = await reg('fva'), B = await reg('fvb'), C = await reg('fvc'), D = await reg('fvd');
    const meId = async (t) => (await api('GET', '/api/me', { token: t })).data.user.id;
    const idA = await meId(A.token), idB = await meId(B.token), idC = await meId(C.token);
    check(!!idA && !!idB && !!idC, 'accounts have ids', { idA, idB, idC });
    // A ↔ B, A ↔ C, B ↔ C. D stays a stranger (but joins the same server).
    // :oid is the *requester* — the accepting side names who asked.
    const befriend = async (rqId, rqToken, targetUsername, targetToken) => {
      const r1 = await api('POST', '/api/friends', { token: rqToken, body: { username: targetUsername } });
      const r2 = await api('POST', `/api/friends/${rqId}/accept`, { token: targetToken });
      check(r1.status === 200 && r2.status === 200, `friendship ${targetUsername}`, { req: r1.data, accept: r2.data });
    };
    await befriend(idA, A.token, 'fvb', B.token);
    await befriend(idA, A.token, 'fvc', C.token);
    await befriend(idB, B.token, 'fvc', C.token);
    const fr = await api('GET', '/api/friends', { token: A.token });
    check(fr.data.friends.length === 2, 'A has two friends (B, C)', fr.data.friends.map((f) => f.username));

    let r = await api('POST', '/api/servers', { token: A.token, body: { name: 'Voice Test' } });
    const srv = r.data.server;
    r = await api('POST', `/api/servers/${srv.id}/channels`, { token: A.token, body: { name: 'Lobby', type: 'voice' } });
    const vc = r.data.channel;
    check(!!vc && vc.type === 'voice', 'server + voice channel created', vc);
    const inv = await api('POST', `/api/servers/${srv.id}/invites`, { token: A.token, body: {} });
    const code = inv.data.invite.code;
    // B is in the server, C is only A's friend (no shared server), D is a
    // stranger who shares the server.
    check((await api('POST', '/api/servers/join', { token: B.token, body: { inviteCode: code } })).status === 200, 'B joins the server');
    check((await api('POST', '/api/servers/join', { token: D.token, body: { inviteCode: code } })).status === 200, 'D (stranger) joins the server');

    console.log('\n[2] sockets up (viewer A, outsider-friend C, stranger D)');
    const a = await connectWs(A.token); conns.push(a);
    const c = await connectWs(C.token); conns.push(c);
    const d = await connectWs(D.token); conns.push(d);
    const b = await connectWs(B.token); conns.push(b);
    check(await waitFor(() => a.events.some((e) => e.t === 'friends-voice'), 5000), 'a friends-voice frame lands on connect+subscribe');
    check(JSON.stringify(a.voice()) === '{}', 'nobody is in voice yet', a.voice());

    console.log('\n[3] B joins the voice channel');
    b.send({ t: 'voice-join', serverId: srv.id, channelId: vc.id });
    const aSees = await waitFor(() => (a.voice() || {})[idB], 5000);
    check(!!aSees, 'A (friend + same server) is pushed B\'s room', a.voice());
    check(aSees && aSees.kind === 'server' && aSees.serverId === srv.id && aSees.channelId === vc.id, 'with the real room ids', aSees);
    check(aSees && aSees.joinable === true && aSees.serverName === 'Voice Test' && aSees.channelName === 'Lobby', 'and joinable with names for a member', aSees);
    check(aSees && aSees.count === 1, 'occupancy count rides along', aSees);

    const cSees = await waitFor(() => (c.voice() || {})[idB], 5000);
    check(!!cSees, 'C (friend, no shared server) still learns B is in voice', c.voice());
    check(!!cSees && cSees.joinable === false, 'but cannot join it', cSees);
    check(!!cSees && !('serverId' in cSees) && !('channelId' in cSees) && !('serverName' in cSees) && !('channelName' in cSees), 'no server/channel names leak to a non-member', cSees);
    check(!(d.voice() || {})[idB], 'D (stranger, same server) is told nothing', d.voice());

    console.log('\n[4] a socket that connects later gets the full map');
    const a2 = await connectWs(A.token); conns.push(a2);
    const late = await waitFor(() => (a2.voice() || {})[idB], 5000);
    check(!!late && late.channelId === vc.id, 'late socket receives B\'s room on subscribe', a2.voice());

    console.log('\n[5] invisible hides the room, coming back restores it');
    r = await api('PATCH', '/api/me', { token: B.token, body: { status: 'invisible' } });
    check(r.status === 200, 'B goes invisible', r.data);
    check(await waitFor(() => !(a.voice() || {})[idB], 5000), 'A\'s map drops B while invisible', a.voice());
    check(await waitFor(() => !(c.voice() || {})[idB], 5000), 'so does C\'s', c.voice());
    r = await api('PATCH', '/api/me', { token: B.token, body: { status: 'online' } });
    check(await waitFor(() => (a.voice() || {})[idB], 5000), 'back online → the room returns', a.voice());

    console.log('\n[6] DM calls are private to the thread');
    r = await api('POST', '/api/dms', { token: A.token, body: { userId: idB } });
    const threadId = r.data.thread.id;
    b.send({ t: 'voice-join', threadId }); // leaving the server room for the call
    const dmCall = await waitFor(() => { const v = (a.voice() || {})[idB]; return v && v.kind === 'dm' ? v : null; }, 5000);
    check(!!dmCall && dmCall.threadId === threadId, 'A sees B\'s DM call (A is in the thread)', a.voice());
    check(!!dmCall && dmCall.joinable === true, 'and it is joinable', dmCall);
    check(await waitFor(() => !(c.voice() || {})[idB], 5000), 'C (friend, not in the thread) never sees a 1:1 call', c.voice());
    b.send({ t: 'voice-leave' });
    check(await waitFor(() => !(a.voice() || {})[idB], 5000), 'hangup clears it', a.voice());

    console.log('\n[7] rejoin, then admin disconnect (voice-mod)');
    b.send({ t: 'voice-join', serverId: srv.id, channelId: vc.id });
    check(await waitFor(() => (a.voice() || {})[idB], 5000), 'B is back in the room', a.voice());
    a.send({ t: 'voice-mod', serverId: srv.id, channelId: vc.id, action: 'disconnect', targetId: idB });
    check(await waitFor(() => !(a.voice() || {})[idB], 5000), 'disconnect clears the row', a.voice());
    check(await waitFor(() => !(c.voice() || {})[idB], 5000), 'for the other friend too', c.voice());

    console.log('\n[8] deleting the channel empties the row against every friend');
    b.send({ t: 'voice-join', serverId: srv.id, channelId: vc.id });
    check(await waitFor(() => (a.voice() || {})[idB], 5000), 'B is in voice again', a.voice());
    r = await api('DELETE', `/api/servers/${srv.id}/channels/${vc.id}`, { token: A.token });
    check(r.status === 200, 'A deletes the voice channel', r.data);
    check(await waitFor(() => !(a.voice() || {})[idB], 5000), 'A\'s row clears', a.voice());
    check(await waitFor(() => !(c.voice() || {})[idB], 5000), 'C\'s row clears', c.voice());

    console.log('\n[9] leaving the server pulls the socket out of its voice rooms');
    r = await api('POST', `/api/servers/${srv.id}/channels`, { token: A.token, body: { name: 'Lobby 2', type: 'voice' } });
    const vc2 = r.data.channel;
    b.send({ t: 'voice-join', serverId: srv.id, channelId: vc2.id });
    check(await waitFor(() => (a.voice() || {})[idB], 5000), 'B in voice once more', a.voice());
    r = await api('POST', `/api/servers/${srv.id}/leave`, { token: B.token });
    check(r.status === 200, 'B leaves the server', r.data);
    check(await waitFor(() => !(a.voice() || {})[idB], 5000), 'eviction clears the row (server-side voice state, not just the client)', a.voice());
    // The affected socket must not think it is still in the (now gone) room:
    // after rejoining (and the subscribe the real client sends on join) voice
    // has to work again without a reload.
    const nFrames = b.events.filter((e) => e.t === 'friends-voice').length;
    r = await api('POST', '/api/servers/join', { token: B.token, body: { inviteCode: (await api('POST', `/api/servers/${srv.id}/invites`, { token: A.token, body: {} })).data.invite.code } });
    check(r.status === 200, 'B rejoins', r.data.error || r.data.ok);
    b.send({ t: 'subscribe' });
    check(await waitFor(() => b.events.filter((e) => e.t === 'friends-voice').length > nFrames, 5000), 'the socket picks the membership back up');
    b.send({ t: 'voice-join', serverId: srv.id, channelId: vc2.id });
    check(await waitFor(() => (a.voice() || {})[idB], 5000), 'and can join voice again — a stale eviction left them stuck before', a.voice());
    b.send({ t: 'voice-leave' });

    console.log('\n[10] nothing lingers after everyone hangs up');
    check(await waitFor(() => JSON.stringify(a.voice()) === '{}', 5000), 'A\'s map is empty again', a.voice());
  } finally {
    for (const conn of conns) { try { conn.close(); } catch {} }
    if (child) { try { child.kill(); } catch {} }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => '  - ' + f).join('\n')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('[test] crashed:', (e && e.message) || e); process.exit(1); });
