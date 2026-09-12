// Multi-replica fan-out — the acceptance test for running Campfire behind more
// than one pod (see the goal / AGENTS.md verification conventions).
//
// Two REAL server processes ("replicas") share one throwaway Postgres. Each
// replica has its own WebSocket client, and every assertion is cross-replica:
// a message injected on replica A must arrive on a socket attached to replica
// B, and vice versa. There is no way for that to pass without the bus, so a
// green run proves the cross-replica fan-out is actually wired (both replicas
// deliver locally; the bus carries the rest).
//
// It also pins the two properties that keep a single replica unchanged:
//   - the publisher does NOT receive its own event back (no duplicate)
//   - each remote event is delivered exactly once
//
// Requirements: Postgres reachable (docker compose up -d db).
// Skips (exit 0) when it isn't.
//
// Usage: node scripts/test-multi-replica.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_multi_replica_test';
const PORT_A = parseInt(process.env.TEST_PORT_A || '3425', 10);
const PORT_B = parseInt(process.env.TEST_PORT_B || '3426', 10);

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

async function api(port, method, p, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: payload });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

let nextStart = 0;
async function connectWs(port, token) {
  const wait = nextStart - Date.now();
  if (wait > 0) await sleep(wait);
  nextStart = Date.now() + 250;
  return new Promise((resolve, reject) => {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    ws.on('error', reject);
    ws.on('message', (raw) => { try { events.push(JSON.parse(raw.toString())); } catch {} });
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'subscribe' })); // what the real client does
      resolve({
        port, events,
        send: (o) => { try { ws.send(JSON.stringify(o)); } catch {} },
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
async function waitForHttp(port, p, ms) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`http://127.0.0.1:${port}${p}`); if (r.ok) return true; } catch {}
    if (Date.now() - t0 > ms) return false;
    await sleep(250);
  }
}

function spawnReplica(port, podName, pg, dbName, uploads, log) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      POD_NAME: podName,
      PGHOST: pg.host, PGPORT: String(pg.port), PGUSER: pg.user, PGPASSWORD: pg.password, PGDATABASE: dbName,
      JWT_SECRET: 'test-multi-replica-secret',
      UPLOAD_DIR: uploads,
      UNFURL: '0',
      // Keep the drain short so teardown is quick; the drain path itself is
      // exercised by the Docker SIGTERM check, not here.
      DRAIN_WAIT_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { log.value += d; });
  child.stderr.on('data', (d) => { log.value += d; });
  return child;
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-mr-'));
  const uploadsA = path.join(tmp, 'uploads-a'); fs.mkdirSync(uploadsA, { recursive: true });
  const uploadsB = path.join(tmp, 'uploads-b'); fs.mkdirSync(uploadsB, { recursive: true });

  const logA = { value: '' }, logB = { value: '' };
  let a = null, b = null;
  const conns = [];
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();

    console.log('\n[1] two real replicas against one database');
    a = spawnReplica(PORT_A, 'rep-a', pg, TEST_DB, uploadsA, logA);
    b = spawnReplica(PORT_B, 'rep-b', pg, TEST_DB, uploadsB, logB);
    const fail = (m) => { throw new Error(m + '\n--- A ---\n' + logA.value.slice(-2500) + '\n--- B ---\n' + logB.value.slice(-2500)); };
    if (!(await waitForHttp(PORT_A, '/api/config', 30000))) return fail('replica A did not come up');
    if (!(await waitForHttp(PORT_B, '/api/config', 30000))) return fail('replica B did not come up');
    check(true, 'both replicas booted');

    const rzA = (await api(PORT_A, 'GET', '/readyz')).data || {};
    const rzB = (await api(PORT_B, 'GET', '/readyz')).data || {};
    check(!!rzA.pod && !!rzB.pod && rzA.pod !== rzB.pod, 'replicas have distinct identities', { a: rzA.pod, b: rzB.pod });
    check(!!(rzA.bus && rzA.bus.started) && !!(rzB.bus && rzB.bus.started), 'bus is started on both');
    check(!!(rzB.bus && (rzB.bus.peers || []).includes(rzA.pod)), 'replica B sees replica A in the registry', rzB.bus && rzB.bus.peers);

    console.log('\n[2] accounts, a shared server + text channel');
    const reg = async (n) => {
      const r = await api(PORT_A, 'POST', '/api/register', { body: { username: n, displayName: n.toUpperCase(), password: 'passw0rd!x' } });
      if (!(r.status === 200 && r.data.token)) throw new Error('register ' + n + ' failed: ' + JSON.stringify(r.data));
      return r.data;
    };
    const A = await reg('mra'), B = await reg('mrb');
    const idA = (await api(PORT_A, 'GET', '/api/me', { token: A.token })).data.user.id;
    const idB = (await api(PORT_B, 'GET', '/api/me', { token: B.token })).data.user.id;
    check(!!idA && !!idB, 'both accounts registered', { idA, idB });

    let r = await api(PORT_A, 'POST', '/api/servers', { token: A.token, body: { name: 'Replica Test' } });
    const srv = r.data.server;
    r = await api(PORT_A, 'POST', `/api/servers/${srv.id}/channels`, { token: A.token, body: { name: 'general', type: 'text' } });
    const ch = r.data.channel;
    check(!!srv && !!ch, 'server + text channel created', { srv: srv && srv.id, ch: ch && ch.id });
    const inv = await api(PORT_A, 'POST', `/api/servers/${srv.id}/invites`, { token: A.token, body: {} });
    check((await api(PORT_B, 'POST', '/api/servers/join', { token: B.token, body: { inviteCode: inv.data.invite.code } })).status === 200, 'B joins via replica B');

    console.log('\n[3] sockets pinned to different replicas');
    const wsA = await connectWs(PORT_A, A.token); conns.push(wsA); // A's socket -> replica A
    const wsB = await connectWs(PORT_B, B.token); conns.push(wsB); // B's socket -> replica B
    check(true, 'A is on replica A, B is on replica B');

    console.log('\n[4] A speaks on replica A -> B hears it on replica B');
    wsA.send({ t: 'message', serverId: srv.id, channelId: ch.id, content: 'cross-pod-from-a' });
    const heardB = await waitFor(() => wsB.events.find((e) => JSON.stringify(e).includes('cross-pod-from-a')), 8000);
    check(!!heardB, 'B received A\'s message across replicas', heardB && heardB.t);
    check((wsB.events.filter((e) => JSON.stringify(e).includes('cross-pod-from-a')).length) === 1,
      'B received it exactly once');

    console.log('\n[5] B speaks on replica B -> A hears it on replica A (reverse direction)');
    wsB.send({ t: 'message', serverId: srv.id, channelId: ch.id, content: 'cross-pod-from-b' });
    const heardA = await waitFor(() => wsA.events.find((e) => JSON.stringify(e).includes('cross-pod-from-b')), 8000);
    check(!!heardA, 'A received B\'s message across replicas', heardA && heardA.t);
    check((wsA.events.filter((e) => JSON.stringify(e).includes('cross-pod-from-b')).length) === 1,
      'A received it exactly once');

    console.log('\n[6] the origin delivers once and the bus adds nothing (origin-skip works)');
    // server.js broadcasts a new message with no `except`, so the sender's own
    // socket IS echoed locally by design (the client dedupes on message id).
    // So exactly one copy on the origin is the correct result — a SECOND copy
    // would mean the bus re-delivered this replica's own event through
    // broadcastToServerLocal, i.e. that origin-skip is broken.
    const ownA = wsA.events.filter((e) => JSON.stringify(e).includes('cross-pod-from-a')).length;
    const ownB = wsB.events.filter((e) => JSON.stringify(e).includes('cross-pod-from-b')).length;
    check(ownA === 1, 'A sees its own message exactly once (no bus duplicate)', { copies: ownA });
    check(ownB === 1, 'B sees its own message exactly once (no bus duplicate)', { copies: ownB });
    // And the peer must not have received it twice either (checked in [4]/[5]),
    // which together proves each event is delivered exactly once per replica.
    check((wsB.events.filter((e) => JSON.stringify(e).includes('cross-pod-from-a')).length) === 1 &&
      (wsA.events.filter((e) => JSON.stringify(e).includes('cross-pod-from-b')).length) === 1,
      'no duplicate delivery anywhere across both replicas');

    console.log('\n[7] one-user fan-out (notifyUser) crosses replicas too');
    // Friends + a DM: dmNotify fans out through notifyUser, a different choke
    // point from the server broadcast above.
    await api(PORT_A, 'POST', '/api/friends', { token: A.token, body: { username: 'mrb' } });
    await api(PORT_B, 'POST', `/api/friends/${idA}/accept`, { token: B.token });
    r = await api(PORT_A, 'POST', '/api/dms', { token: A.token, body: { userId: idB } });
    const tid = r.data && r.data.thread && r.data.thread.id;
    check(!!tid, 'DM thread created', r.data);
    if (tid) {
      wsB.send({ t: 'dm', threadId: tid, content: 'cross-pod-dm' });
      const gotDm = await waitFor(() => wsA.events.find((e) => JSON.stringify(e).includes('cross-pod-dm')), 8000);
      check(!!gotDm, 'A received B\'s DM across replicas (notifyUser path)', gotDm && gotDm.t);
    }

    console.log('\n[8] voice rosters + WebRTC signalling cross replicas');
    r = await api(PORT_A, 'POST', `/api/servers/${srv.id}/channels`, { token: A.token, body: { name: 'Voice', type: 'voice' } });
    const vch = r.data.channel;
    check(!!vch && vch.type === 'voice', 'voice channel created', vch);
    wsA.send({ t: 'voice-join', serverId: srv.id, channelId: vch.id });
    check(await waitFor(() => wsA.events.some((e) => e.t === 'voice-peers'), 6000), 'A got its first peers frame');
    wsB.send({ t: 'voice-join', serverId: srv.id, channelId: vch.id });
    // A is on replica A and B on replica B, so neither can see the other in its
    // own voiceRooms — the roster can only come from the shared registry.
    const aSeesB = await waitFor(() => {
      const e = [...wsA.events].reverse().find((x) => x.t === 'voice-peers' && x.channelId === vch.id);
      return e && (e.peers || []).some((p) => p.id === idB) ? e : null;
    }, 8000);
    check(!!aSeesB, 'A (replica A) sees B, who is connected to replica B', aSeesB && aSeesB.peers.map((p) => p.id));
    const bSeesA = await waitFor(() => {
      const e = [...wsB.events].reverse().find((x) => x.t === 'voice-peers' && x.channelId === vch.id);
      return e && (e.peers || []).some((p) => p.id === idA) ? e : null;
    }, 8000);
    check(!!bSeesA, 'B (replica B) sees A', bSeesA && bSeesA.peers.map((p) => p.id));

    // THE HARD BREAK: signalling used to resolve its target from the LOCAL
    // voiceRooms, so two people in one room on different replicas could never
    // exchange SDP/ICE and calls silently failed to connect.
    wsB.send({ t: 'voice-signal', to: idA, data: { sdp: 'cross-pod-offer' } });
    const sig = await waitFor(() => wsA.events.find((e) => e.t === 'voice-signal' && e.data && e.data.sdp === 'cross-pod-offer'), 8000);
    check(!!sig, "B's WebRTC signal reached A on the other replica", sig && sig.from);

    wsB.send({ t: 'voice-leave' });
    check(await waitFor(() => wsA.events.some((e) => e.t === 'voice-peer-left' && e.userId === idB), 8000),
      'leaving propagates to the other replica');
    wsA.send({ t: 'voice-leave' });

    console.log('\n[9] presence is cluster-wide');
    // A and B share a server but sit on different replicas, so a roster that
    // read only this process's sockets could not contain the other at all.
    wsA.send({ t: 'subscribe' });
    const presA = await waitFor(() => {
      const e = [...wsA.events].reverse().find((x) => x.t === 'presence' && x.serverId === srv.id);
      return e && e.online && e.online[idB] ? e : null;
    }, 8000);
    check(!!presA, 'A sees B online, though B is connected to replica B', presA && presA.online);

    // Status flips on replica B must be visible to a roster read on replica A.
    await api(PORT_B, 'PATCH', '/api/me', { token: B.token, body: { status: 'invisible' } });
    wsA.send({ t: 'subscribe' });
    const presA2 = await waitFor(() => {
      const e = [...wsA.events].reverse().find((x) => x.t === 'presence' && x.serverId === srv.id);
      return e && e.online && !e.online[idB] ? e : null;
    }, 8000);
    check(!!presA2, 'B going invisible on replica B drops it from A\'s roster on replica A');

    // The instance owner becomes a site admin; its Online count must include
    // sessions registered by the OTHER replica.
    const adm = await reg('jreoka');
    const wsAdm = await connectWs(PORT_A, adm.token); conns.push(wsAdm);
    const ap = await waitFor(() => {
      const e = [...wsAdm.events].reverse().find((x) => x.t === 'admin-presence');
      return e && e.online >= 2 ? e : null;
    }, 8000);
    check(!!ap, 'admin Online count includes sessions on the other replica', ap && { online: ap.online, sessions: ap.sessions });

    await api(PORT_B, 'PATCH', '/api/me', { token: B.token, body: { status: 'online' } });
    wsAdm.close();

    console.log('\n[10] rate limits are shared, not multiplied by the replica count');
    // /api/username-available allows 60 requests/minute per IP, and both
    // replicas see the same client IP. Alternating between them proves the
    // counter is shared: with a per-process limiter each replica would grant its
    // own 60 (120 total) before rejecting anything, which is exactly the
    // multiply-by-N bug this replaced.
    let allowed = 0, limited = 0;
    for (let i = 0; i < 66; i++) {
      const res = await api(i % 2 === 0 ? PORT_A : PORT_B, 'GET', `/api/username-available?u=rlprobe${i}`);
      if (res.status === 429) limited++; else allowed++;
    }
    check(allowed <= 60, `at most 60 of 66 alternating requests passed (got ${allowed})`, { allowed, limited });
    check(limited >= 6, `the remainder were rejected with 429 (got ${limited})`, { allowed, limited });

    console.log('\n[11] both replicas stayed healthy');
    const rzA2 = (await api(PORT_A, 'GET', '/readyz')).data || {};
    const rzB2 = (await api(PORT_B, 'GET', '/readyz')).data || {};
    check(rzA2.ok === true && rzB2.ok === true, 'both replicas remain ready');
    const errs = (logA.value + logB.value).split('\n').filter((l) => /\[bus\] (handler|drain|publish) failed/.test(l));
    check(errs.length === 0, 'no bus handler/drain/publish errors', errs.slice(0, 3));

    for (const c of conns) c.close();
    a.kill('SIGKILL'); b.kill('SIGKILL');
    a = b = null;

    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) { for (const f of failures) console.log('  FAILED: ' + f); process.exit(1); }
    process.exit(0);
  } catch (e) {
    console.log('\n[test] ERROR: ' + ((e && e.message) || e));
    console.log('--- A log ---\n' + logA.value.slice(-3000));
    console.log('--- B log ---\n' + logB.value.slice(-3000));
    process.exit(1);
  } finally {
    for (const c of conns) { try { c.close(); } catch {} }
    for (const child of [a, b]) { if (child) { try { child.kill('SIGKILL'); } catch {} } }
  }
}

main();
