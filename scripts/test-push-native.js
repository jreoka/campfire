// Native push sockets (`/ws/push`) — the Android app's notification path.
//
// The bug this covers: the Android APK got no notifications at all, for
// messages or DMs. Android WebView implements neither `PushManager` nor
// `Notification`, and the shell pauses the WebView whenever the app is
// backgrounded, so the browser web-push path this app grew up on can never fire
// there — the settings tab even said "Push is not supported in this browser".
// The shell's native foreground service now holds a socket of its own and posts
// the notification locally from the same payload web push would have carried
// (server.js `pushToUser` -> `notifyPushSockets`).
//
// What this asserts, over a real server and a real socket:
//   [1] a DM pushes to the device socket, with the payload web push would send
//   [2] the payload never rides a chat socket (no double notification)
//   [3] the socket is not a session: no live_sessions row, no presence
//   [4] the socket's OWN visibility is the only suppression (that device)
//   [5] another device's visible page does NOT silence the phone (per-device,
//       unlike the account-wide web-push gate)
//   [6] mute rules are the server's, unchanged (muted scope = no push at all)
//   [7] the settings test push arrives while the app is on screen, and only
//       then does it carry `test` (so the button cannot look broken)
//   [8] a bad token is refused
//
// Skips (exit 0) when Postgres is down. Usage: node scripts/test-push-native.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_push_native_test';
const PORT = parseInt(process.env.TEST_PORT || '3441', 10);

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

// The source-level half: the wiring that makes a payload reach the socket at all,
// and the one thing that must NOT change (web push still respects the
// account-wide page-visible gate).
function sourceChecks() {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  console.log('\n[A1] every push payload reaches the device sockets');
  check(/function notifyPushSockets\(userId, payload\)/.test(server), 'a native push fan-out exists');
  check(/async function pushToUser\(uid, payload, opts\) \{\s*\n\s*notifyPushSockets\(uid, payload\);/.test(server),
    'pushToUser fans out to the native sockets before any gate');
  check(/bus\.subscribe\('push', \(p\) => \{ if \(p && p\.userId\) notifyPushSocketsLocal\(p\.userId, p\.payload\); \}\)/.test(server),
    'a replica delivers a peer replica\'s native push');
  console.log('\n[A2] web push keeps the account-wide gate');
  const dmPush = server.slice(server.indexOf('async function notifyDmMessage'), server.indexOf('// reactions ----------'));
  check(/webPush: !\(await userVisible\(uid\)\)/.test(dmPush), 'a visible page still suppresses the browser push');
  check(!/if \(await userVisible\(uid\)\) continue;/.test(dmPush), 'the old early-continue is gone (it would skip the phone too)');
  console.log('\n[A3] the Android shell is wired to it');
  const manifest = fs.readFileSync(path.join(ROOT, 'app/src-tauri/gen/android/app/src/main/AndroidManifest.xml'), 'utf8');
  const service = fs.readFileSync(path.join(ROOT, 'app/src-tauri/gen/android/app/src/main/java/moe/dill/campfire/PushService.kt'), 'utf8');
  check(/android:stopWithTask="false"/.test(manifest), 'the service survives the app being swiped away');
  check(/FOREGROUND_SERVICE_SPECIAL_USE/.test(manifest), 'the foreground-service type is declared');
  check(/POST_NOTIFICATIONS/.test(manifest), 'Android 13+ notification permission is declared');
  check(/\/ws\/push\?token=/.test(service), 'the service connects to the native push socket');
  check(/sendVisibility/.test(service) && /appVisible/.test(service), 'the device reports its own foreground state');
  check(/areNotificationsEnabled\(\)/.test(service), 'it respects the OS notification switch');
  const main = fs.readFileSync(path.join(ROOT, 'app/src-tauri/gen/android/app/src/main/java/moe/dill/campfire/MainActivity.kt'), 'utf8');
  check(/addJavascriptInterface\(PushBridge\(this\), "CampfireNative"\)/.test(main), 'the page gets the bridge');
  const final = fs.readFileSync(path.join(ROOT, 'public/js/final.js'), 'utf8');
  check(/function syncNativePush/.test(final) && /b\.configure\(store\.token/.test(final), 'the session is handed to the service');
  check(/window\.__cfDeepLink/.test(final), 'a tapped notification routes to its conversation');
}

function apiFactory(tokenRef) {
  return async function api(method, p, opts = {}) {
    const headers = {};
    const tk = opts.token || tokenRef.token;
    if (tk) headers.Authorization = 'Bearer ' + tk;
    let payload;
    if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(opts.body); }
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers, body: payload });
    let data = null;
    try { data = await r.json(); } catch {}
    return { status: r.status, data };
  };
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

// A device socket: what PushService holds. Records its frames, and stays open
// unless a test closes it.
function connectPush(token) {
  return new Promise((resolve, reject) => {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/push?token=${encodeURIComponent(token)}`);
    ws.on('error', reject);
    ws.on('message', (raw) => { try { events.push(JSON.parse(raw.toString())); } catch {} });
    ws.on('close', (code) => { events.push({ t: '__close', code }); });
    ws.on('open', () => resolve({
      events,
      ready: () => waitFor(() => events.some((e) => e.t === 'push-ready'), 5000),
      send: (o) => ws.send(JSON.stringify(o)),
      close: () => { try { ws.close(); } catch {} },
    }));
  });
}
function connectChat(token) {
  return new Promise((resolve, reject) => {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
    ws.on('error', reject);
    ws.on('message', (raw) => { try { events.push(JSON.parse(raw.toString())); } catch {} });
    ws.on('open', () => { ws.send(JSON.stringify({ t: 'subscribe' })); resolve({ events, send: (o) => ws.send(JSON.stringify(o)), close: () => { try { ws.close(); } catch {} } }); });
  });
}

async function main() {
  sourceChecks();

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
    return skip('Postgres unreachable (' + ((e && e.message) || e) + ') — the socket half was skipped');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-push-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });

  let child = null;
  let dbc = null;
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
      JWT_SECRET: 'test-push-native-secret',
      UPLOAD_DIR: uploads,
      UNFURL: '0',
      BUS: '0',
    };
    const fail = (msg) => { throw new Error(msg + '\n--- server log ---\n' + serverLog.slice(-4000)); };
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    if (!(await waitForHttp('/api/config', 30000))) fail('server did not come up');

    const tokenRef = { token: '' };
    const api = apiFactory(tokenRef);
    const reg = async (n) => {
      const r = await api('POST', '/api/register', { body: { username: n, displayName: n.toUpperCase(), password: 'passw0rd!x' } });
      if (!(r.status === 200 && r.data.token)) throw new Error('register ' + n + ' failed: ' + JSON.stringify(r.data));
      return r.data;
    };
    const meId = async (t) => (await api('GET', '/api/me', { token: t })).data.user.id;
    const pushes = (sock) => sock.events.filter((e) => e.t === 'push');
    const lastPush = (sock) => pushes(sock)[pushes(sock).length - 1];

    // Same DB the server booted: the presence claim is checked against the real
    // registry, not against an assumption about it.
    dbc = new Client({ ...pg, database: TEST_DB });
    await dbc.connect();

    console.log('\n[B1] a DM reaches the device socket');
    const A = await reg('pusha'), B = await reg('pushb');
    const idA = await meId(A.token), idB = await meId(B.token);
    await api('POST', '/api/friends', { token: A.token, body: { username: 'pushb' } });
    await api('POST', `/api/friends/${idA}/accept`, { token: B.token });
    const dr = await api('POST', '/api/dms', { token: A.token, body: { userId: idB } });
    const tid = dr.data.thread && dr.data.thread.id;
    check(!!tid, 'A and B share a 1:1', dr.data);

    const device = await connectPush(B.token);
    conns.push(device);
    check(await device.ready(), 'the device socket is accepted and greeted (push-ready)');
    // It is created hidden — a cold service has no window at all.
    const asock = await connectChat(A.token);
    conns.push(asock);
    await sleep(250);
    asock.send({ t: 'dm', threadId: tid, content: 'ping from the phone test' });
    check(await waitFor(() => pushes(device).length >= 1, 6000), 'the DM pushed to the device socket', device.events);
    const p1 = lastPush(device);
    check(p1 && p1.payload && p1.payload.title === 'A (DM)' || (p1 && /\(DM\)$/.test(p1.payload.title)), 'the payload is the OS-push payload web push would carry', p1 && p1.payload);
    check(p1 && p1.payload.body === 'ping from the phone test', 'the body is the message', p1 && p1.payload);
    check(p1 && p1.payload.tag === `dm:${tid}`, 'the tag groups by conversation', p1 && p1.payload);
    check(p1 && p1.payload.url === `/?dm=${tid}`, 'the url is the conversation to open', p1 && p1.payload);
    check(p1 && !p1.payload.test, 'a real message is not marked as a test');

    console.log('\n[B2] it never rides a chat socket');
    const bchat = await connectChat(B.token);
    conns.push(bchat);
    await sleep(250);
    asock.send({ t: 'dm', threadId: tid, content: 'second' });
    await waitFor(() => bchat.events.some((e) => e.t === 'dm-new'), 5000);
    check(bchat.events.some((e) => e.t === 'dm-new'), 'the chat socket got the message event');
    check(!bchat.events.some((e) => e.t === 'push'), '...and no push event (a page must not double-notify)');

    console.log('\n[B3] the device socket is not a session');
    const sess = await dbc.query('SELECT COUNT(*)::int AS c FROM live_sessions WHERE user_id = $1', [await meId(B.token)]);
    check(sess.rows[0].c === 1, 'only the chat socket is registered in live_sessions (the push socket is not)', sess.rows);
    // The chat socket we opened is the only session, and it is visible by
    // default, so B still looks online to a friend — i.e. the device socket
    // neither adds a session nor a presence row.
    bchat.close();
    await waitFor(async () => {
      const r = await dbc.query('SELECT COUNT(*)::int AS c FROM live_sessions WHERE user_id = $1', [await meId(B.token)]);
      return r.rows[0].c === 0;
    }, 5000);
    const sess2 = await dbc.query('SELECT COUNT(*)::int AS c FROM live_sessions WHERE user_id = $1', [await meId(B.token)]);
    check(sess2.rows[0].c === 0, 'with the chat socket closed, the phone is offline while the device socket stays up', sess2.rows);

    console.log('\n[B4] the device decides, not the account');
    device.send({ t: 'visibility', visible: true });
    await sleep(300);
    asock.send({ t: 'dm', threadId: tid, content: 'while on screen' });
    await sleep(900);
    check(!pushes(device).some((p) => p.payload && p.payload.body === 'while on screen'),
      'the app being on screen suppresses its own notification');
    device.send({ t: 'visibility', visible: false });
    await sleep(300);
    asock.send({ t: 'dm', threadId: tid, content: 'in the pocket' });
    check(await waitFor(() => pushes(device).some((p) => p.payload && p.payload.body === 'in the pocket'), 6000),
      'hiding it lets the next one through');

    console.log('\n[B5] a desk with the page open does not silence the phone');
    const bpage = await connectChat(B.token);
    conns.push(bpage);
    await sleep(250);
    bpage.send({ t: 'visibility', visible: true }); // the account IS visible somewhere
    await sleep(300);
    asock.send({ t: 'dm', threadId: tid, content: 'desk is watching' });
    check(await waitFor(() => pushes(device).some((p) => p.payload && p.payload.body === 'desk is watching'), 6000),
      'the phone still rings (per-device delivery, unlike the browser push)', device.events);
    bpage.close();

    console.log('\n[B6] the server\'s mute rules still decide');
    let pr = await api('PUT', '/api/notifs/prefs', { token: B.token, body: { scope: `dm:${tid}`, mode: 'muted' } });
    check(pr.status === 200, 'B mutes the thread', pr.data);
    const before = pushes(device).length;
    asock.send({ t: 'dm', threadId: tid, content: 'muted message' });
    await sleep(1200);
    check(pushes(device).length === before, 'a muted conversation pushes nothing at all');
    await api('PUT', '/api/notifs/prefs', { token: B.token, body: { scope: `dm:${tid}`, mode: 'all' } });
    asock.send({ t: 'dm', threadId: tid, content: 'unmuted message' });
    check(await waitFor(() => pushes(device).some((p) => p.payload && p.payload.body === 'unmuted message'), 6000),
      'unmuting restores it');

    console.log('\n[B7] the settings test push');
    device.send({ t: 'visibility', visible: true }); // the app is on screen, as it is when the button is tapped
    await sleep(250);
    pr = await api('POST', '/api/push/test', { token: B.token });
    check(pr.status === 200, 'POST /api/push/test is accepted', pr.data);
    check(await waitFor(() => pushes(device).some((p) => p.payload && p.payload.test === true), 6000),
      'a test push is delivered even with the app in front', device.events);
    const tp = pushes(device).filter((p) => p.payload && p.payload.test === true).pop();
    check(tp && /Test push/.test(tp.payload.body), 'and it says what it is', tp && tp.payload);
    device.send({ t: 'visibility', visible: false });

    console.log('\n[B8] auth');
    const bad = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/push?token=nonsense`);
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {});
      setTimeout(() => resolve(-1), 4000);
    });
    check(bad === 4401, 'a bad token is closed with 4401, like the chat socket', bad);

    console.log('\n[B9] it stays up');
    await sleep(400);
    check(!device.events.some((e) => e.t === '__close'), 'the device socket is still open after the whole run', device.events);
  } catch (e) {
    failures.push('threw: ' + ((e && e.message) || e));
    console.log('  FAIL threw: ' + ((e && e.stack) || e));
  } finally {
    for (const c of conns) { try { c.close(); } catch {} }
    try { dbc && await dbc.end(); } catch {}
    try { child && child.kill(); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')\n  - ' + failures.join('\n  - ') : 'all ' + passed + ' checks passed'));
  process.exit(failures.length ? 1 : 0);
}

main();
