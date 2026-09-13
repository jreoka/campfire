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
  // The churn that made delivery a coin flip: connect() cancels the live socket,
  // OkHttp reports a cancelled call as onFailure, and an unguarded listener
  // schedules another connect() three seconds later — forever. Every connection
  // must carry the generation it was opened with, and a stale callback must not
  // be able to reconnect.
  check(/private var generation = 0/.test(service) && /val gen = \+\+generation/.test(service)
    && /client\.newWebSocket\([^\n]*listener\(gen\)\)/.test(service),
    'a replaced socket is not mistaken for a failed one (generation-guarded listener)');
  check(/private fun stale\(\): Boolean = stopped \|\| gen != generation/.test(service)
    && /override fun onFailure[\s\S]{0,220}if \(stale\(\)\) return/.test(service),
    'a stale listener cannot schedule a reconnect (the cancel-loop stays fixed)');
  check(/generation\+\+/.test(service.slice(service.indexOf('private fun closeSocket()'), service.indexOf('private fun listener('))),
    'a deliberate teardown cannot schedule a reconnect either');
  const bridge = fs.readFileSync(path.join(ROOT, 'app/src-tauri/gen/android/app/src/main/java/moe/dill/campfire/PushBridge.kt'), 'utf8');
  check(/if \(enabled\) PushService\.requestPermission\(activity\)/.test(bridge),
    'a fresh install is asked for the Android 13 permission when it enables');
  const final = fs.readFileSync(path.join(ROOT, 'public/js/final.js'), 'utf8');
  check(/function syncNativePush/.test(final) && /b\.configure\(store\.token/.test(final), 'the session is handed to the service');
  check(/window\.__cfDeepLink/.test(final), 'a tapped notification routes to its conversation');
}

// ---------- [C] the page side, offline ----------
// Settings -> Notifications and the session handoff are the only places that
// know which shell is asking, so the REAL functions run here against a minimal
// DOM: the Android bridge, the desktop shell, and a plain browser.
function makeDom() {
  const byId = new Map();
  const el = (tag) => {
    const e = {
      tagName: String(tag || 'div').toUpperCase(),
      className: '', textContent: '', value: '', style: {}, children: [], dataset: {}, onclick: null, onchange: null,
      appendChild(c) { e.children.push(c); return c; },
      get innerHTML() { return ''; },
      set innerHTML(v) { e.children.length = 0; },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      setAttribute() {}, getAttribute() { return null; },
      addEventListener() {}, removeEventListener() {},
    };
    return e;
  };
  const box = el('div');
  byId.set('#set-notifs', box);
  return {
    box,
    el,
    document: { createElement: el, querySelector: (s) => byId.get(s) || null, addEventListener() {}, removeEventListener() {} },
    text: () => {
      const out = [];
      const walk = (n) => { if (n.textContent) out.push(n.textContent); for (const c of n.children || []) walk(c); };
      walk(box);
      return out.join(' | ');
    },
    labels: () => (box.children || []).filter((c) => c.tagName === 'BUTTON').map((b) => b.textContent),
    press: (label) => {
      const b = (box.children || []).find((c) => c.tagName === 'BUTTON' && c.textContent === label);
      if (!b) throw new Error('no button "' + label + '" in [' + (box.children || []).map((c) => c.textContent).join(', ') + ']');
      return b.onclick();
    },
  };
}

async function clientChecks() {
  const settings = fs.readFileSync(path.join(ROOT, 'public/js/settings.js'), 'utf8');
  const final = fs.readFileSync(path.join(ROOT, 'public/js/final.js'), 'utf8');
  const tabSrc = settings.slice(settings.indexOf('async function renderNotifsTab()'), settings.indexOf('function urlB64ToU8'));
  const setupSrc = settings.slice(settings.indexOf('async function pushSetup()'), settings.indexOf('function setSettingsTab('));
  const helpers = final.slice(final.indexOf('function isAndroidShell()'), final.indexOf('function takeNativeDeepLink()'));
  const apiCalls = [];
  const toasts = [];

  const build = (windowObj, nav) => {
    const dom = makeDom();
    const api = (p, opts) => {
      apiCalls.push({ path: p, method: (opts && opts.method) || 'GET' });
      return Promise.resolve(p === '/api/notifs/prefs' ? { prefs: {} } : { ok: true });
    };
    const fn = new Function(
      'window', 'document', 'navigator', 'localStorage', 'location', 'api', 'toast', 'store', 'S', 'notifPrefsCache', '$', 'NOTIF_OPTS', 'notifSelect',
      helpers + '\n' + tabSrc + '\n' + setupSrc + '\nreturn { renderNotifsTab, pushSetup, pushTeardown, nativePushState };'
    );
    const lib = fn(
      windowObj, dom.document, nav || {}, { getItem: () => null, setItem() {}, removeItem() {} },
      { origin: 'https://campfire.dill.moe' },
      api, (m) => toasts.push(m), { token: 'TOK' }, { me: { id: 'u1' } }, {}, (s) => dom.document.querySelector(s),
      [['all', 'All messages']], () => dom.el('select')
    );
    return { dom, lib };
  };

  console.log('\n[C1] the Android shell drives the native service');
  const bridgeCalls = [];
  let status = { enabled: false, running: false, permission: true };
  const bridge = {
    configure: (t, o, e) => { bridgeCalls.push(['configure', t, o, e]); return true; },
    status: () => JSON.stringify(status),
    requestPermission: () => { bridgeCalls.push(['requestPermission']); return true; },
    takeUrl: () => '',
  };
  const android = build({ CampfireNative: bridge }, { userAgent: 'Linux; Android 14' });
  await android.lib.renderNotifsTab();
  check(/Background notifications are off/.test(android.dom.text()), 'off by default, and it says so', android.dom.text());
  check(android.dom.labels().includes('Enable notifications'), 'an enable button is offered', android.dom.labels());
  await android.dom.press('Enable notifications');
  check(bridgeCalls.some((c) => c[0] === 'requestPermission'), 'enabling asks Android for the notification permission', bridgeCalls);
  check(bridgeCalls.some((c) => c[0] === 'configure' && c[1] === 'TOK' && c[3] === true),
    'and hands the signed-in session to the service', bridgeCalls);
  status = { enabled: true, running: true, permission: true };
  await android.lib.renderNotifsTab();
  check(/Background notifications are on/.test(android.dom.text()), 'the enabled state reads back', android.dom.text());
  apiCalls.length = 0;
  await android.dom.press('Send test notification');
  check(apiCalls.some((c) => c.path === '/api/push/test' && c.method === 'POST'), 'the test button posts the server test push', apiCalls);
  bridgeCalls.length = 0;
  await android.dom.press('Turn off on this device');
  check(bridgeCalls.some((c) => c[0] === 'configure' && c[3] === false), 'turning it off stops the service', bridgeCalls);

  console.log('\n[C2] boot hands the session over instead of subscribing');
  bridgeCalls.length = 0;
  await android.lib.pushSetup();
  check(bridgeCalls.some((c) => c[0] === 'configure' && c[1] === 'TOK' && c[3] === true),
    'pushSetup configures the native service', bridgeCalls);
  bridgeCalls.length = 0;
  await android.lib.pushTeardown();
  check(bridgeCalls.some((c) => c[0] === 'configure' && c[1] === 'TOK' && c[3] === false),
    'signing out tears it down with the token gone... ', bridgeCalls);
  check(bridgeCalls.every((c) => c[0] !== 'subscribe'), '...and never tries a browser push subscription');

  console.log('\n[C3] the desktop shell explains itself and tests natively');
  const invoked = [];
  const desktop = build({ __TAURI__: { core: { invoke: (cmd, args) => { invoked.push([cmd, args]); return Promise.resolve(); } } } }, { userAgent: 'Mozilla/5.0 (Windows NT 10.0)' });
  await desktop.lib.renderNotifsTab();
  check(/notifications whenever its window is not in front/.test(desktop.dom.text()), 'it says the app handles them', desktop.dom.text());
  await desktop.dom.press('Send test notification');
  check(invoked.some((c) => c[0] === 'notify'), 'the test button calls the native notify command', invoked);

  console.log('\n[C4] a browser keeps the web push path');
  const browser = build({}, { userAgent: 'Mozilla/5.0 (Macintosh)' });
  await browser.lib.renderNotifsTab();
  check(/Push is not supported in this browser\./.test(browser.dom.text()),
    'without PushManager it says so (this is what Android used to show)', browser.dom.text());
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
function connectPush(token, opts) {
  return new Promise((resolve, reject) => {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/push?token=${encodeURIComponent(token)}`);
    ws.on('error', reject);
    ws.on('message', (raw) => { try { events.push(JSON.parse(raw.toString())); } catch {} });
    ws.on('close', (code) => { events.push({ t: '__close', code }); });
    ws.on('open', () => {
      // The shell reports its window state the moment the socket opens, which is
      // before the server's auth queries have finished.
      if (opts && opts.visibleAtOnce) ws.send(JSON.stringify({ t: 'visibility', visible: true }));
      resolve({
        events,
        ready: () => waitFor(() => events.some((e) => e.t === 'push-ready'), 5000),
        send: (o) => ws.send(JSON.stringify(o)),
        close: () => { try { ws.close(); } catch {} },
      });
    });
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
      // Short enough that [B10] can watch a visibility lease lapse; the cluster
      // runs the 75s default.
      PUSH_VISIBILITY_TTL_MS: '2500',
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
    // A socket that reports "on screen" in the same tick it opens: the auth
    // queries run after that frame arrives, so they must not reset the flag.
    const early = await connectPush(B.token, { visibleAtOnce: true });
    conns.push(early);
    await early.ready();
    asock.send({ t: 'dm', threadId: tid, content: 'front from the first frame' });
    await sleep(1000);
    check(!pushes(early).some((p) => p.payload && p.payload.body === 'front from the first frame'),
      'a visibility report sent as the socket opens survives auth (no reset after it)', early.events);
    early.close();
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

    console.log('\n[B10] a lost "hidden" cannot silence a device forever');
    // The shell re-asserts its window state every ~25s and the server treats a
    // "visible" report as a lease of TTL; this run shortens the TTL so the lapse
    // is observable. A device whose last word was "on screen" and which then
    // stops reporting (frame lost, radio asleep, app killed in front) must start
    // ringing again instead of being skipped for the rest of its life.
    const lease = await connectPush(B.token, { visibleAtOnce: true });
    conns.push(lease);
    await lease.ready();
    asock.send({ t: 'dm', threadId: tid, content: 'while the lease holds' });
    await sleep(900);
    check(!pushes(lease).some((p) => p.payload && p.payload.body === 'while the lease holds'),
      'a device that reports itself on screen is skipped while the lease holds', lease.events);
    await sleep(2600); // past PUSH_VISIBILITY_TTL_MS, with nothing re-asserting it
    asock.send({ t: 'dm', threadId: tid, content: 'after the lease lapsed' });
    check(await waitFor(() => pushes(lease).some((p) => p.payload && p.payload.body === 'after the lease lapsed'), 6000),
      'the lease lapses, so a stale "visible" delays a push instead of swallowing it', lease.events);
    lease.close();

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
