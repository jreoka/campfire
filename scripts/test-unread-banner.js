// The unread bar ("N new messages since 6:07 PM · Mark as read") (see AGENTS.md
// verification conventions).
//
// The thing this covers: opening a conversation with unread messages used to
// silently clear the badge — the dots vanished and the reader lost the answer to
// "what was new, and since when?" without ever seeing it. The bar is that
// answer, modelled on Discord's (owner request): it quotes how many messages
// arrived and since when, over the top of the conversation the moment it opens.
//
// Two contracts make the numbers honest:
//   1. `POST /api/channels/:cid/read` and `POST /api/dms/:tid/read` answer with
//      the PRE-stamp unread snapshot (`{ count, since }`, chanUnreadSnapshot /
//      dmUnreadSnapshot) — computed before the watermark moves, so the count can
//      never race the stamp it describes. `since` is the same COALESCE the
//      unread rules age against (last_read_at, falling back to joined_at).
//   2. Only a conversation OPEN arms the bar (markChannelRead / markDmRead's
//      onSnap, set by selectChannel / selectDmThread). Every other stamp — a
//      message landing in the one already open, a foregrounded tab — passes no
//      onSnap and leaves the bar alone.
// The bar is a pointer, not a gate: the watermark is already stamped when it
// paints, so Mark as read dismisses (and re-stamps, idempotently).
//
// Offline half: the real helpers sliced out of `public/js/messages.js`,
// `public/js/servers.js` and `public/js/home.js`, run against fake DOM / api.
// API half: a real server on a throwaway database — the pre-stamp snapshot on
// both surfaces (count, `since` as the watermark, own/sys/thread-reply
// exclusions). Skips (exit 0) when Postgres is down.
//
// Usage: node scripts/test-unread-banner.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_unread_bar_test';
const PORT = parseInt(process.env.TEST_PORT || '3425', 10);

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
function fakeEl() {
  return {
    textContent: '',
    listeners: {},
    classList: {
      _s: new Set(['hidden']),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    addEventListener(t, fn) { this.listeners[t] = fn; },
  };
}

// ---------- [A] the bar, offline ----------
function clientChecks() {
  const messages = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
  const servers = fs.readFileSync(path.join(ROOT, 'public/js/servers.js'), 'utf8');
  const home = fs.readFileSync(path.join(ROOT, 'public/js/home.js'), 'utf8');
  const pins = fs.readFileSync(path.join(ROOT, 'public/js/pins.js'), 'utf8');
  const socket = fs.readFileSync(path.join(ROOT, 'public/js/socket.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

  console.log('\n[A1] the bar quotes the pre-stamp snapshot, and only for the open chat');
  const els = new Map();
  for (const id of ['#unread-bar', '#urb-text', '#urb-mark']) els.set(id, fakeEl());
  const $ = (sel) => els.get(sel) || null;
  const MS = { me: { id: 'me' }, view: 'server', serverId: 's1', channelId: 'c1', dmThreadId: null, dmUnread: new Map() };
  // The whole bar module: the helpers plus the Mark-as-read wiring at its end.
  const build = new Function('$', 'S', 'markChannelRead', 'markDmRead',
    messages.slice(messages.indexOf('let unreadBarCtx = null;')) +
    '\nreturn { unreadBarShow, unreadBarHide };');
  const stamped = [];
  const { unreadBarShow, unreadBarHide } = build($, MS,
    (sid, cid, d) => stamped.push(['server', sid, cid, d]),
    (tid, d) => stamped.push(['dm', tid, d]));

  const bar = els.get('#unread-bar'), text = els.get('#urb-text'), mark = els.get('#urb-mark');
  const since = 1700000000000; // what the server's watermark looks like on the wire (ms)
  const sinceStr = new Date(since).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  unreadBarShow('server', 'c1', { count: 2, since });
  check(!bar.classList.contains('hidden'), 'two unread messages paint the bar', bar.classList._s);
  check(text.textContent === '2 new messages since ' + sinceStr,
    'and it says exactly what Discord\'s says: N new messages since H:MM', text.textContent);
  unreadBarShow('server', 'c1', { count: 1, since });
  check(text.textContent === '1 new message since ' + sinceStr, 'singular for one', text.textContent);
  unreadBarShow('server', 'c1', { count: 1, since: null });
  check(text.textContent === '1 new message', 'a watermark-less row (legacy data) drops the clause', text.textContent);

  unreadBarHide();
  check(bar.classList.contains('hidden'), 'it hides when told to');

  unreadBarShow('server', 'c2', { count: 5, since }); // stale: the reader moved on
  check(bar.classList.contains('hidden') && text.textContent === '1 new message',
    'a stale answer never paints over another conversation', text.textContent);
  MS.view = 'home'; MS.dmThreadId = 't1';
  unreadBarShow('dm', 't2', { count: 3, since });
  check(bar.classList.contains('hidden'), 'same for a DM the reader is not in');
  unreadBarShow('dm', 't1', { count: 0, since });
  check(bar.classList.contains('hidden'), 'and nothing unread means no bar (the count is the point)');
  unreadBarShow('dm', 't1', { count: 2, since });
  check(!bar.classList.contains('hidden') && /^2 new messages since /.test(text.textContent),
    'the open DM paints', text.textContent);

  console.log('\n[A2] Mark as read dismisses it and stamps through the right writer');
  mark.listeners.click();
  check(bar.classList.contains('hidden'), 'the bar leaves');
  check(stamped.length === 1 && stamped[0][0] === 'dm' && stamped[0][1] === 't1',
    'and the thread is stamped read again (idempotent, and honest if the open stamp failed)', stamped);
  MS.view = 'server'; MS.channelId = 'c1';
  unreadBarShow('server', 'c1', { count: 2, since });
  stamped.length = 0;
  mark.listeners.click();
  check(stamped.length === 1 && stamped[0][0] === 'server' && stamped[0][1] === 's1' && stamped[0][2] === 'c1',
    'the channel variant stamps its channel', stamped);

  console.log('\n[A3] the stamp helpers hand the /read answer to onSnap');
  const apiCalls = [];
  const unreadAnswer = { ok: true, unread: { count: 2, since: 55 } };
  const fakeApi = (p, o) => {
    apiCalls.push({ path: p, method: (o && o.method) || 'GET' });
    return Promise.resolve(unreadAnswer);
  };
  const chanBuild = new Function('api', 'clearChanUnread', 'S',
    slice(servers, 'const chanReadTimers = new Map();', 'function markServerReadRemote') +
    '\nreturn { markChannelRead };');
  const { markChannelRead } = chanBuild(fakeApi, () => {}, MS);
  const dmBuild = new Function('api', 'paintHomeBadge', 'S',
    slice(home, 'const dmReadTimers = new Map();', '// Red count on the campfire home button') +
    '\nreturn { markDmRead };');
  const dmApiCalls = [];
  const dmApi = (p, o) => { dmApiCalls.push(p); return Promise.resolve(unreadAnswer); };
  const { markDmRead } = dmBuild(dmApi, () => {}, MS);

  return (async () => {
    let got = null;
    markChannelRead('s1', 'c7', 0, { onSnap: (u) => { got = u; } });
    await sleep(30);
    check(apiCalls.some((c) => c.path === '/api/channels/c7/read' && c.method === 'POST'),
      'opening stamps the channel read', apiCalls);
    check(got === unreadAnswer.unread, 'and the pre-stamp snapshot reaches the bar', got);

    got = null;
    markDmRead('t1', 0, { onSnap: (u) => { got = u; } });
    await sleep(30);
    check(got === unreadAnswer.unread, 'same for the DM variant', got);

    apiCalls.length = 0;
    let snaps = 0;
    markChannelRead('s1', 'c8', 30, { onSnap: () => { snaps++; } });
    markChannelRead('s1', 'c8', 30); // a message landing mid-burst: no onSnap
    markChannelRead('s1', 'c8', 30);
    await sleep(80);
    check(apiCalls.filter((c) => c.path === '/api/channels/c8/read').length === 1,
      'a burst is still one write', apiCalls);
    check(snaps === 1, 'and the burst keeps the call that armed the bar (the opener)', snaps);

    apiCalls.length = 0;
    markChannelRead('s1', 'c9', 0); // the plain stamp every other path uses
    await sleep(30);
    check(apiCalls.length === 1, 'a stamp without onSnap still stamps', apiCalls);

    console.log('\n[A4] only an OPEN arms the bar');
    check(/unreadBarHide\(\);\s*markChannelRead\(S\.serverId, id, 0, \{ onSnap: \(u\) => unreadBarShow\('server', id, u\) \}\)/.test(servers),
      'selectChannel hides the old bar and arms the new one (servers.js)');
    check(/unreadBarHide\(\);\s*markDmRead\(id, 0, \{ onSnap: \(u\) => unreadBarShow\('dm', id, u\) \}\)/.test(pins),
      'selectDmThread does the same (pins.js)');
    check(/markChannelRead\(m\.serverId, m\.channelId\);/.test(socket),
      'a message landing in the open chat stamps WITHOUT arming (no bar on every message)', 'socket.js');
    check(/markDmRead\(msg\.threadId\);/.test(socket),
      'same on the DM socket path');
    check(/markChannelRead\(serverId, channelId, delay = 600, opts = \{\}\)/.test(servers)
      && /markDmRead\(tid, delay = 500, opts = \{\}\)/.test(home),
      'and every old 3-arg call site still works (opts is optional)');

    console.log('\n[A5] the server answers with the PRE-stamp snapshot');
    check(/async function chanUnreadSnapshot\(userId, ch\)/.test(server) && /async function dmUnreadSnapshot\(userId, threadId\)/.test(server),
      'both surfaces have a snapshot helper');
    check((server.match(/res\.json\(\{ ok: true, unread \}\);/g) || []).length === 2,
      'both /read routes answer { ok, unread }');
    const chSnapAt = server.indexOf('const unread = await chanUnreadSnapshot(req.user.id, ch);');
    check(chSnapAt > 0 && chSnapAt < server.indexOf('INSERT INTO channel_reads'),
      'the channel snapshot is taken BEFORE the stamp (the count cannot race it)');
    const dmRoute = server.slice(server.indexOf("app.post('/api/dms/:tid/read'"));
    const dmSnapAt = dmRoute.indexOf('const unread = await dmUnreadSnapshot(req.user.id, t.id);');
    check(dmSnapAt > 0 && dmSnapAt < dmRoute.indexOf('UPDATE dm_members SET last_read_at'),
      'and so is the DM one');
    check(/AND \(m\.user_id IS NULL OR m\.user_id <> \?\)/.test(server)
      && /AND COALESCE\(m\.sys, ''\) = ''/.test(server)
      && /AND \(m\.thread_root_id IS NULL OR m\.thread_root_id = ''\)/.test(server)
      && /AND m\.created_at > COALESCE\(r\.last_read_at, sm\.joined_at\)/.test(server),
      'the channel count follows channelUnreadFor exactly (someone else, not sys, not a thread reply)');
    check(/AND m\.user_id IS NOT NULL AND m\.user_id <> \?/.test(server)
      && /AND \(m\.sys IS NULL OR m\.sys = ''\)/.test(server)
      && /AND m\.created_at > COALESCE\(mem\.last_read_at, mem\.joined_at\)/.test(server),
      'and the DM count follows dmUnreadCounts exactly');

    console.log('\n[A6] the markup and the style contract');
    const headAt = index.indexOf('id="chat-header"'), barAt = index.indexOf('id="unread-bar"'), msgsAt = index.indexOf('id="messages"');
    check(headAt > 0 && headAt < barAt && barAt < msgsAt,
      'the bar sits between the chat header and #messages (its zero-height wrapper starts exactly below the header)');
    check(/#unread-bar\{position:relative;height:0/.test(css) && /\.urb-pill\{position:absolute/.test(css),
      'and the pill is absolutely positioned in a zero-height wrapper — it overlays the messages, never pushes them');
    check(/#unread-bar \.urb-pill\{[^}]*background:var\(--accent\);color:var\(--on-accent\)/.test(css),
      'accent surface with the on-accent ink (the flat dark-navy language)');
    check(/#unread-bar #urb-mark\{[^}]*border-radius:999px/.test(css)
      && /#unread-bar #urb-mark\{[^}]*background:var\(--on-accent\);color:var\(--accent\)/.test(css),
      'Mark as read is the inverse pill on it');
    check(/#urb-mark:active/.test(css) && /,#urb-mark\{position:relative\}/.test(css) && /,#urb-mark::after\{/.test(css),
      'the button is in the press-state and tap-target lists (it must feel native)');
    const barMarkup = index.slice(index.indexOf('id="unread-bar"'), index.indexOf('id="messages"'));
    check(!/[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(barMarkup),
      'and the bar carries no emoji (the UI-chrome rule)', barMarkup);
    check(/Mark as read<\/button>/.test(index), 'the button says "Mark as read"');
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-urb-'));
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
      JWT_SECRET: 'test-unread-bar-secret',
      UPLOAD_DIR: uploads,
      UNFURL: '0',
    };
    const fail = (msg) => { throw new Error(msg + '\n--- server log ---\n' + serverLog.slice(-4000)); };
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    if (!(await waitForHttp('/api/config', 30000))) fail('server did not come up');

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
    const chanRead = (token, cid) => api('POST', `/api/channels/${cid}/read`, { token });
    const dmRead = (token, tid) => api('POST', `/api/dms/${tid}/read`, { token });
    const has = (u) => (u && typeof u.count === 'number') ? u.count : null;

    console.log('\n[B1] a channel read answers with what it is about to clear');
    const A = await reg('urba'), B = await reg('urbb');
    const idB = await meId(B.token);
    const srv = (await api('POST', '/api/servers', { token: A.token, body: { name: 'Alpha' } })).data.server;
    const chat = (await api('POST', `/api/servers/${srv.id}/channels`, { token: A.token, body: { name: 'chat', type: 'text' } })).data.channel;
    const invite = (await api('POST', `/api/servers/${srv.id}/invites`, { token: A.token, body: {} })).data.invite;
    check((await api('POST', '/api/servers/join', { token: B.token, body: { code: invite.code } })).status === 200,
      'B joins the server');

    const asock = await connect(A.token), bsock = await connect(B.token);
    conns.push(asock, bsock);
    await sleep(300);
    asock.send({ t: 'message', serverId: srv.id, channelId: chat.id, content: 'one' });
    asock.send({ t: 'message', serverId: srv.id, channelId: chat.id, content: 'two' });
    await waitFor(() => bsock.events.filter((e) => e.t === 'message-new').length >= 2, 5000);

    let r = await chanRead(B.token, chat.id);
    check(r.status === 200 && r.data.ok === true, 'B marks the channel read', r.data);
    check(has(r.data.unread) === 2, 'the answer says what it cleared: 2 new messages', r.data);
    check(typeof r.data.unread.since === 'number' && r.data.unread.since > 0,
      'and since when (the watermark, here the join time)', r.data.unread);
    const since1 = r.data.unread.since;
    r = await chanRead(B.token, chat.id);
    check(has(r.data.unread) === 0, 'a second stamp has nothing to report (the snapshot is pre-stamp)');

    asock.send({ t: 'message', serverId: srv.id, channelId: chat.id, content: 'three' });
    await waitFor(() => bsock.events.filter((e) => e.t === 'message-new').length >= 3, 5000);
    r = await chanRead(B.token, chat.id);
    check(has(r.data.unread) === 1, 'one new message since the last read');
    check(r.data.unread.since >= since1, 'and the watermark (since) advanced with the read', { since1, now: r.data.unread.since });

    console.log('\n[B2] own messages and thread replies never count');
    bsock.send({ t: 'message', serverId: srv.id, channelId: chat.id, content: 'mine' });
    await waitFor(() => bsock.events.some((e) => e.t === 'message-new' && e.message && e.message.content === 'mine'), 5000);
    r = await chanRead(B.token, chat.id);
    check(has(r.data.unread) === 0, 'your own message is not unread to you');

    asock.send({ t: 'message', serverId: srv.id, channelId: chat.id, content: 'root' });
    await waitFor(() => bsock.events.filter((e) => e.t === 'message-new').length >= 5, 5000);
    const hist = await api('GET', `/api/servers/${srv.id}/channels/${chat.id}/messages`, { token: B.token });
    const rootId = ((hist.data.messages || []).find((m) => m.content === 'root') || {}).id;
    check(!!rootId, 'the thread root is in the history', hist.data && Object.keys(hist.data));
    asock.send({ t: 'message', serverId: srv.id, channelId: chat.id, content: 'a reply', threadRoot: rootId });
    asock.send({ t: 'message', serverId: srv.id, channelId: chat.id, content: 'a real message' });
    await waitFor(() => bsock.events.filter((e) => e.t === 'message-new').length >= 7, 5000);
    r = await chanRead(B.token, chat.id);
    check(has(r.data.unread) === 2, 'a thread reply is not a channel message (root + real = 2)', r.data);

    console.log('\n[B3] the DM twin, and the auth wall');
    for (const n of ['urbb']) await api('POST', '/api/friends', { token: A.token, body: { username: n } });
    await api('POST', `/api/friends/${await meId(A.token)}/accept`, { token: B.token });
    const t1 = (await api('POST', '/api/dms', { token: A.token, body: { userId: idB } })).data.thread.id;
    asock.send({ t: 'dm', threadId: t1, content: 'hi' });
    asock.send({ t: 'dm', threadId: t1, content: 'there' });
    await waitFor(() => bsock.events.filter((e) => e.t === 'dm-new').length >= 2, 5000);
    r = await dmRead(B.token, t1);
    check(r.status === 200 && has(r.data.unread) === 2, 'the DM read answers with its own snapshot', r.data);
    check(typeof r.data.unread.since === 'number' && r.data.unread.since > 0, 'with the same watermark', r.data.unread);
    r = await dmRead(B.token, t1);
    check(has(r.data.unread) === 0, 'and clears to zero');

    r = await chanRead(B.token, chat.id);
    check(has(r.data.unread) === 0, 'the channel stays cleared meanwhile');
    r = await api('POST', `/api/channels/${chat.id}/read`, {});
    check(r.status === 401, 'no token, no read (and no snapshot either)', r.status);
  } finally {
    for (const c of conns) { try { c.close(); } catch {} }
    try { child && child.kill(); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ' of ' + (passed + failures.length) + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) {
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
