// The campfire Home button comes back to the tab you were last on (see
// AGENTS.md verification conventions).
//
// The complaint: Home is a place you leave — open a server, take a call, read
// someone's story — and coming back always dropped you on the empty Friends
// feed. The DM or group you were in, or the Stories tab you were reading, was
// thrown away, and you had to find it again in the sidebar.
//
// Now the campfire button reopens that tab (public/js/stories.js… no: core.js's
// readHomeTab/rememberHomeTab + home.js's openHomeTab), and a reload agrees
// with it. The restore belongs to the button alone: every internal "jump into
// Home" path (a notification, a DM row, a share target) still calls openHome()
// with nothing and lands blank, picking its own conversation right after.
//
// Offline: the two real memory helpers, sliced out of core.js and driven with a
// fake localStorage + stub S (defaults, round trip, per-account isolation,
// junk), plus the wiring — which paths remember the tab, which paths clear it,
// and the Home button being the only entry that restores.
// Then headless Chrome drives the REAL app against a throwaway database at a
// desktop viewport (skips without Postgres or Chrome): DM → server → Home,
// group DM → server → Home, the Stories tab → server → Home, the Friends row →
// server → Home, a closed DM never coming back, a reload landing in the same
// place, and the whole thing with no page exceptions.
//
// Usage: node scripts/test-home-tab-return.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_home_tab_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3431', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9348', 10);

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
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
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}

const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const home = fs.readFileSync(path.join(ROOT, 'public/js/home.js'), 'utf8');
const pins = fs.readFileSync(path.join(ROOT, 'public/js/pins.js'), 'utf8');
const stories = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');
const socket = fs.readFileSync(path.join(ROOT, 'public/js/socket.js'), 'utf8');
const auth = fs.readFileSync(path.join(ROOT, 'public/js/auth.js'), 'utf8');
const settings = fs.readFileSync(path.join(ROOT, 'public/js/settings.js'), 'utf8');

// ---------- the real memory helpers, offline ----------
const memCode = slice(core, 'function readHomeTab() {', '/* ---------- composer drafts');
global.S = { me: { id: 'u1' }, homePanel: 'friends', dmThreadId: null };
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
// eslint-disable-next-line no-eval
const { readHomeTab, rememberHomeTab } = eval(memCode + '\n;({ readHomeTab, rememberHomeTab })');

console.log('\n[1] the memory itself');
check(JSON.stringify(readHomeTab()) === '{"panel":"friends","dm":null}', 'a fresh account has nothing remembered', readHomeTab());
global.S.homePanel = 'stories'; global.S.dmThreadId = 't1';
rememberHomeTab();
check(JSON.stringify(readHomeTab()) === '{"panel":"stories","dm":"t1"}', 'a round trip keeps the panel and the conversation', readHomeTab());
check(store.has('cf_home_tab_u1'), 'stored per account (nothing global)', [...store.keys()]);
global.S.homePanel = 'friends'; global.S.dmThreadId = null;
rememberHomeTab();
check(JSON.stringify(readHomeTab()) === '{"panel":"friends","dm":null}', 'the Friends row overwrites it with no conversation', readHomeTab());
global.S.dmThreadId = 42;
rememberHomeTab();
check(readHomeTab().dm === '42', 'a numeric thread id is stored as a string (localStorage JSON)', readHomeTab());
check(readHomeTab().panel === 'friends', 'and a panel it does not know coerces to friends');
// Another account on the same browser must not inherit this one's tab.
global.S.me = { id: 'u2' };
check(JSON.stringify(readHomeTab()) === '{"panel":"friends","dm":null}', 'a second account starts blank', readHomeTab());
global.S.me = { id: 'u1' };
check(readHomeTab().dm === '42', 'and the first account still has its own', readHomeTab());
store.set('cf_home_tab_u1', '{not json');
check(JSON.stringify(readHomeTab()) === '{"panel":"friends","dm":null}', 'junk in the store falls back to Friends, not a crash', readHomeTab());
global.S.me = null;
check(JSON.stringify(readHomeTab()) === '{"panel":"friends","dm":null}', 'signed out reads as blank', readHomeTab());
check((() => { try { rememberHomeTab(); return true; } catch { return false; } })(), 'and writing while signed out is a no-op');

console.log('\n[2] the wiring: who remembers, who clears, who restores');
check(/\$\('#btn-home'\)\.onclick = openHomeTab;/.test(settings), 'the campfire button is the one entry that restores');
check(/async function openHomeTab\(\) \{\r?\n  const tab = readHomeTab\(\);\r?\n  await openHome\(\{ panel: tab\.panel, dm: tab\.dm \}\);/.test(home),
  'it hands openHome the remembered panel and conversation');
check(/async function openHome\(opts = \{\}\) \{/.test(home)
  && /S\.homePanel = opts\.panel === 'stories' \? 'stories' : 'friends';/.test(home),
  'openHome defaults to the Friends feed and only the caller can ask for another tab');
check(/const back = opts\.dm && \(S\.dms \|\| \[\]\)\.some\(\(t\) => t\.id === opts\.dm\) \? opts\.dm : null;/.test(home),
  'a remembered thread that is gone (closed, left, deleted) restores nothing');
check(/if \(back\) selectDmThread\(back, \{ keepNav: true \}\);/.test(home),
  'the restore happens before the roster round-trips (synchronously in the click)');
check(/if \(!opts\.keepNav\) document\.body\.classList\.remove\('nav-open'\);/.test(pins),
  'and it does not close the phone nav page Home deliberately keeps up');
check(/S\.dmThreadId = id;\r?\n  rememberView\(\);\r?\n  rememberHomeTab\(\);/.test(pins),
  'opening a DM or group remembers it as the tab to come back to');
check(/function showFriendsPanel\(\) \{[\s\S]{0,400}?rememberHomeTab\(\);/.test(home), 'the Friends row remembers itself');
check(/S\.homePanel = 'stories';[\s\S]{0,120}?rememberView\(\);\r?\n  rememberHomeTab\(\);/.test(stories), 'and so does the Stories row');
for (const [name, re] of [
  ['closing a DM', /async function closeDm\(tid\) \{[\s\S]{0,300}?rememberHomeTab\(\);/],
  ['leaving a group', /label: 'Leave chat'[\s\S]{0,400}?rememberHomeTab\(\);/],
]) check(re.test(home), name + ' stops it from coming back');
check(/if \(S\.dmThreadId && !S\.dms\.some\(\(t\) => t\.id === S\.dmThreadId\)\) \{ S\.dmThreadId = null; renderDmBlank\(\); rememberView\(\); rememberHomeTab\(\); \}/.test(socket),
  'a thread that vanished on another device is forgotten too');
check(/case 'removed-from-dm':\r?\n\s*if \(S\.dmThreadId === m\.threadId\) \{ S\.dmThreadId = null; renderDmBlank\(\); rememberView\(\); rememberHomeTab\(\); \}/.test(socket),
  'being removed from a group clears it as well');
check(/if \(mem && mem\.view === 'home'\) \{[\s\S]{0,400}?await openHome\(\{ panel: readHomeTab\(\)\.panel, dm: null \}\);/.test(auth),
  'a reload taken on the Stories tab comes back to Stories (the panel memory is read at boot)');

// ---------- the real app, desktop viewport ----------
async function main() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');
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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-home-tab-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });

  let child = null, chrome = null, ws = null;
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
        JWT_SECRET: 'test-home-tab-secret',
        UPLOAD_DIR: uploads,
        UNFURL: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    const fail = (msg) => { throw new Error(msg + '\n--- server log ---\n' + serverLog.slice(-3000)); };
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${PORT}/api/config`)).ok; } catch {}
      if (!up) await sleep(250);
    }
    if (!up) return fail('server did not come up');

    const register = async (username, displayName) => {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, displayName, password: 'passw0rd!x' }),
      });
      const d = await r.json();
      if (!d.token) throw new Error('register failed: ' + JSON.stringify(d));
      return d;
    };
    const me = await register('mainuser', 'Main');
    const pally = await register('pally', 'Pally');
    const bee = await register('bee', 'Bee');
    // Groups need friendship (the route answers add_friend_first); 1:1 DMs don't.
    const befriend = async (a, b) => {
      const h = (t) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
      const r1 = await fetch(`http://127.0.0.1:${PORT}/api/friends`, { method: 'POST', headers: h(a.token), body: JSON.stringify({ username: b.user.username }) });
      const r2 = await fetch(`http://127.0.0.1:${PORT}/api/friends/${a.user.id}/accept`, { method: 'POST', headers: h(b.token) });
      if (r1.status !== 200 || r2.status !== 200) throw new Error('could not befriend ' + b.user.username + ': ' + r1.status + ' ' + (await r1.text()) + ' / ' + r2.status + ' ' + (await r2.text()));
    };
    await befriend(me, pally);
    await befriend(me, bee);

    const profile = path.join(tmp, 'chrome');
    chrome = spawn(chromePath, [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
      '--window-size=1280,860', 'about:blank',
    ], { stdio: 'ignore' });
    let ver = null;
    for (let i = 0; i < 80 && !ver; i++) {
      try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch {}
      if (!ver) await sleep(250);
    }
    if (!ver) return fail('Chrome did not expose the DevTools port');

    const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

    let msgId = 0;
    const pending = new Map();
    const pageErrors = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
      }
    });
    const send = (method, params = {}) => new Promise((res, rej) => {
      const i = ++msgId;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const waitFor = async (expr, ms = 20000) => {
      const t0 = Date.now();
      for (;;) {
        try { const v = await evaluate(`(() => { try { return ${expr} } catch (e) { return false } })()`); if (v) return v; } catch {}
        if (Date.now() - t0 > ms) return null;
        await sleep(200);
      }
    };
    // What the reader sees: which pane is up, what the header says, which
    // sidebar row reads as current (1:1 rows live in #dm-list, groups in
    // #group-list — ask the shared parent).
    const view = () => evaluate(`(() => {
      const row = [...document.querySelectorAll('#home-ui .dmrow')].find((b) => b.classList.contains('active'));
      return {
        view: S.view, panel: S.homePanel, dm: S.dmThreadId,
        name: document.getElementById('chan-name').textContent,
        messages: !document.getElementById('messages').classList.contains('hidden'),
        friends: !document.getElementById('friends-page').classList.contains('hidden'),
        stories: !document.getElementById('stories-page').classList.contains('hidden'),
        activeRow: row ? (row.querySelector('.dmname') || {}).textContent : null,
        friendsActive: document.getElementById('btn-friends').classList.contains('active'),
        storiesActive: document.getElementById('btn-stories').classList.contains('active'),
      };
    })()`);

    await send('Page.enable');
    await send('Runtime.enable');
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    if (!(await waitFor(`typeof boot === 'function'`))) return fail('the app never loaded');
    await evaluate(`(() => { localStorage.setItem('cf_token', ${JSON.stringify(me.token)}); localStorage.setItem('cf_sid', ${JSON.stringify(me.sid)}); return 1; })()`);
    await send('Page.reload');
    if (!(await waitFor(`S.me && S.me.username === 'mainuser'`))) return fail('boots signed in');

    console.log('\n[3] a DM, a group and a server to move between');
    const setup = await evaluate(`(async () => {
      const dm = await api('/api/dms', { method: 'POST', body: JSON.stringify({ userId: ${JSON.stringify(pally.user.id)} }) });
      const grp = await api('/api/dms/group', { method: 'POST', body: JSON.stringify({ name: 'Weekend squad', userIds: [${JSON.stringify(pally.user.id)}, ${JSON.stringify(bee.user.id)}] }) });
      const srv = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: 'Studio' }) });
      await refreshServers(srv.server.id);
      await refreshDms();
      if (S.ws) S.ws.send(JSON.stringify({ t: 'subscribe' }));
      await openHome();
      await selectDmThread(dm.thread.id);
      return { tid: dm.thread.id, gid: grp.thread.id, sid: srv.server.id };
    })()`);
    check(!!setup.tid && !!setup.gid && !!setup.sid, 'a 1:1 DM, a group chat and a server exist', setup);

    console.log('\n[4] a DM survives leaving Home for a server');
    await evaluate(`(async () => { await selectServer(${JSON.stringify(setup.sid)}); })()`);
    await sleep(250);
    let at = await view();
    check(at.view === 'server' && at.messages === true, 'clicking a server leaves the DM behind', at);
    await evaluate(`document.getElementById('btn-home').click()`);
    await sleep(400);
    at = await view();
    check(at.view === 'home' && at.dm === setup.tid, 'the campfire button reopens the DM you were in', at);
    check(at.name === 'Pally' && at.messages && at.activeRow === 'Pally', 'the header and the sidebar row come with it', at);
    check(!at.friends && !at.stories, 'and no panel is painted over it', at);

    console.log('\n[5] a group chat survives it too');
    await evaluate(`(async () => { await selectDmThread(${JSON.stringify(setup.gid)}); await selectServer(${JSON.stringify(setup.sid)}); })()`);
    await sleep(250);
    await evaluate(`document.getElementById('btn-home').click()`);
    await sleep(400);
    at = await view();
    check(at.dm === setup.gid && at.name === 'Weekend squad', 'the group chat comes back, name and all', at);
    check(at.activeRow === 'Weekend squad', 'and its row reads as current', at);

    console.log('\n[6] the Stories tab and the Friends tab come back as themselves');
    await evaluate(`document.getElementById('btn-stories').click()`);
    await waitFor(`!document.getElementById('stories-page').classList.contains('hidden')`);
    await evaluate(`(async () => { await selectServer(${JSON.stringify(setup.sid)}); })()`);
    await sleep(250);
    await evaluate(`document.getElementById('btn-home').click()`);
    await sleep(400);
    at = await view();
    check(at.panel === 'stories' && at.stories && !at.friends && at.dm === null, 'Home returns to the Stories page', at);
    check(at.name === 'Stories' && at.storiesActive && !at.friendsActive, 'with its header and highlight', at);
    await evaluate(`document.getElementById('btn-friends').click()`);
    await sleep(120);
    await evaluate(`(async () => { await selectServer(${JSON.stringify(setup.sid)}); })()`);
    await sleep(250);
    await evaluate(`document.getElementById('btn-home').click()`);
    await sleep(400);
    at = await view();
    check(at.panel === 'friends' && at.friends && !at.stories && at.dm === null, 'and to the Friends feed', at);
    check(at.name === 'Friends' && at.friendsActive, 'with its header and highlight', at);

    console.log('\n[7] a conversation you closed never comes back');
    await evaluate(`(async () => { await selectDmThread(${JSON.stringify(setup.tid)}); await closeDm(${JSON.stringify(setup.tid)}); })()`);
    await sleep(300);
    await evaluate(`(async () => { await selectServer(${JSON.stringify(setup.sid)}); })()`);
    await sleep(250);
    await evaluate(`document.getElementById('btn-home').click()`);
    await sleep(400);
    at = await view();
    check(at.dm === null && !at.messages, 'Home lands on the panel, not the dismissed DM', at);
    check(at.friends && at.name === 'Friends', 'which is the Friends feed it was left on', at);
    const rows = await evaluate(`[...document.querySelectorAll('#home-ui .dmrow')].map((b) => (b.querySelector('.dmname') || {}).textContent)`);
    check(!rows.includes('Pally') && rows.includes('Weekend squad'), 'and the closed DM is gone from the sidebar (the group is still there)', rows);

    console.log('\n[8] a reload lands where Home would');
    await evaluate(`(async () => { await selectDmThread(${JSON.stringify(setup.gid)}); })()`);
    await sleep(200);
    await send('Page.reload');
    if (!(await waitFor(`S.me && S.me.username === 'mainuser' && typeof boot === 'function'`))) return fail('reload did not boot');
    await waitFor(`S.view === 'home' && S.dmThreadId === ${JSON.stringify(setup.gid)}`);
    await evaluate(`(async () => { await selectServer(${JSON.stringify(setup.sid)}); })()`);
    await sleep(250);
    await evaluate(`document.getElementById('btn-home').click()`);
    await sleep(400);
    at = await view();
    check(at.dm === setup.gid, 'the memory survives a reload, so Home still comes back to it', at);

    console.log('\n[9] another account has its own tab, not this one\'s');
    await evaluate(`(() => { localStorage.setItem('cf_token', ${JSON.stringify(bee.token)}); localStorage.setItem('cf_sid', ${JSON.stringify(bee.sid)}); return 1; })()`);
    await send('Page.reload');
    if (!(await waitFor(`S.me && S.me.username === 'bee'`))) return fail('the second account did not boot');
    await sleep(300);
    await evaluate(`document.getElementById('btn-home').click()`);
    await sleep(400);
    at = await view();
    check(at.dm === null && at.friends && !at.stories,
      'the new account starts on the Friends feed — the other account\'s group is not inherited', at);

    const realErrors = pageErrors.filter((e) => e && !/favicon|Failed to load resource/i.test(e));
    check(realErrors.length === 0, 'no page exceptions', realErrors.slice(0, 3));
  } finally {
    try { if (ws) ws.close(); } catch {}
    try { if (chrome) chrome.kill(); } catch {}
    try { if (child) child.kill(); } catch {}
    try { const c = new Client({ ...pg, database: 'postgres' }); await c.connect(); await c.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`); await c.end(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

main()
  .then(() => {
    console.log('\n' + (failures.length ? failures.length + ' FAILED, ' + passed + ' passed' : 'all ' + passed + ' checks passed'));
    process.exit(failures.length ? 1 : 0);
  })
  .catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
