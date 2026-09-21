// URL paths (see AGENTS.md verification conventions).
//
// The complaint: every page of the app said campfire.dill.moe in the address
// bar. A channel, Home, the sign-in form, a DM — one URL for all of them, so
// nothing could be pasted, bookmarked or reopened, and a notification link had
// to ride a query string (?dm=ID) that reads like an API call.
//
// Now every place has a path — /login, /signup, /home, /stories, /dm/<thread>,
// /c/<server>[/<channel>] — written from the one hook every navigation already
// funnels through (rememberView -> router.js cfSyncUrl) and READ at boot before
// the local last-view memory, so a pasted link opens what it names on any
// device.
//
// Two halves:
//
//   [0]-[4] are offline and always run: the real router.js is executed in a vm
//   against a fake location/history/sessionStorage, and the static wiring is
//   read out of index.html / service-worker.js / server.js / native.js. These
//   are the assertions that must hold with no browser and no database.
//
//   [5]-[9] drive the REAL page in headless Chrome against a throwaway database:
//   a signed-out visitor landing on /login and /signup, a deep path booting
//   straight into the conversation it names, a signed-out deep link landing
//   there after sign-in, navigation writing the path, a junk path healing
//   itself, and — the reason this file must not pushState — the phone's back
//   sentinel surviving a navigation with its history state intact.
//
// Skips (exit 0) when Postgres or Chrome is unavailable.
//
// Usage: node scripts/test-url-routes.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_url_routes_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3437', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9354', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

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
    for (const line of read('.env').split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}

/* =================== the real router, offline ===================
 * router.js is a classic script that only touches location/history/
 * sessionStorage/S, so it runs whole inside a vm with those faked. Nothing here
 * boots the app: every function is called directly. */
function loadRouter() {
  const calls = { replace: [], push: [] };
  const stash = new Map();
  const sandbox = {
    console,
    S: { me: { id: 'u1' }, view: 'server', homePanel: 'friends', serverId: null, channelId: null, dmThreadId: null },
    location: { pathname: '/', search: '', hash: '', href: 'https://campfire.test/' },
    history: {
      state: null,
      // Faithful in the one way that matters here: it MOVES the address bar, so
      // a second write of the same path is recognizable as a no-op.
      replaceState(s, t, u) {
        calls.replace.push(u);
        this.state = s;
        const m = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(String(u));
        sandbox.location.pathname = m[1];
        sandbox.location.search = m[2] || '';
        sandbox.location.hash = m[3] || '';
      },
      pushState(s, t, u) { calls.push.push(u); this.state = s; },
    },
    sessionStorage: {
      getItem: (k) => (stash.has(k) ? stash.get(k) : null),
      setItem: (k, v) => stash.set(k, String(v)),
      removeItem: (k) => stash.delete(k),
    },
    modes: [],
    setMode(m) { sandbox.modes.push(m); },
  };
  vm.createContext(sandbox);
  const src = read('public/js/router.js')
    + '\n;globalThis.__cf = { cfRouteFromPath, cfPathForState, cfSetPath, cfSyncUrl, cfArmUrl,'
    + ' cfAuthScreenEnter, cfStashPendingRoute, cfTakePendingRoute, cfForgetPendingRoute, cfBootRoute };\n';
  vm.runInContext(src, sandbox);
  return { cf: sandbox.__cf, sandbox, calls, stash };
}

async function main() {
  /* ---------- [0] the offline router table ---------- */
  console.log('\n[0] the real router parses paths');
  {
    const { cf } = loadRouter();
    const kinds = (p) => { const r = cf.cfRouteFromPath(p); return r ? r.kind : null; };
    check(kinds('/login') === 'login', '/login is the sign-in page');
    check(kinds('/signup') === 'signup' && kinds('/register') === 'signup' && kinds('/signup/') === 'signup',
      '/signup, its /register alias and a trailing slash all name the sign-up page');
    check(kinds('/home') === 'home' && kinds('/friends') === 'home', '/home — and /friends — is Home');
    check(kinds('/stories') === 'stories', '/stories is the story center');
    const tid = '3f1a2b3c-0000-4444-8888-abcdefabcdef';
    const dm = cf.cfRouteFromPath('/dm/' + tid);
    check(dm && dm.kind === 'dm' && dm.id === tid, '/dm/<thread> names a thread', dm);
    const srv = cf.cfRouteFromPath('/c/s1');
    check(srv && srv.kind === 'server' && srv.serverId === 's1' && srv.channelId === null, '/c/<server> names a server', srv);
    const ch = cf.cfRouteFromPath('/c/s1/c2');
    check(ch && ch.kind === 'server' && ch.serverId === 's1' && ch.channelId === 'c2', '/c/<server>/<channel> names a channel', ch);
    const alias = cf.cfRouteFromPath('/channels/s1/c2');
    check(alias && alias.kind === 'server' && alias.channelId === 'c2', '/channels/… is accepted as the same route', alias);
    // The id shape is checked on the RAW segment, before any decoding: an
    // escaped or otherwise odd segment is not an id this app ever writes.
    check(cf.cfRouteFromPath('/c/s1/c%202') === null, 'a segment that is not id-shaped is refused', cf.cfRouteFromPath('/c/s1/c%202'));
    check(cf.cfRouteFromPath('/c/s1/<script>') === null, 'and so is one carrying punctuation', cf.cfRouteFromPath('/c/s1/<script>'));
    // Paths this file must NOT claim: the server routes /invite/:code with the
    // server's own OpenGraph preview, and both of those are rewritten by the
    // module that reads them, so touching them here would eat the payload.
    for (const p of ['/invite/abc123', '/share', '/nope', '/', '/c', '/dm', '/c/s1/c2/c3', '/c/s1//c2', '/c//c2']) {
      check(cf.cfRouteFromPath(p) === null, 'left alone: ' + p, cf.cfRouteFromPath(p));
    }
  }

  console.log('\n[1] the path is DERIVED from the view on screen');
  {
    const { cf, sandbox, calls } = loadRouter();
    const url = (mut) => {
      Object.assign(sandbox.S, { view: 'server', homePanel: 'friends', serverId: null, channelId: null, dmThreadId: null, me: { id: 'u1' } }, mut || {});
      return cf.cfPathForState();
    };
    check(url({ view: 'server', serverId: 's1', channelId: 'c2' }) === '/c/s1/c2', 'a text channel is /c/<server>/<channel>');
    check(url({ view: 'server', serverId: 's1' }) === '/c/s1', 'a server with no channel chosen is /c/<server>');
    check(url({ view: 'home' }) === '/home', 'Home is /home');
    check(url({ view: 'home', homePanel: 'stories' }) === '/stories', 'the story center is /stories');
    check(url({ view: 'home', dmThreadId: 't9' }) === '/dm/t9', 'an open thread is /dm/<thread>');
    check(url({ view: 'home', homePanel: 'stories', dmThreadId: 't9' }) === '/dm/t9',
      'and a thread wins over the panel behind it (the panel is where a closed thread leaves you)');
    check(url({ me: null }) === null, 'a signed-out shell has no app path at all');
    check(url({ view: 'server', serverId: null, channelId: null }) === null, 'and neither has an empty server view');
    // A navigation REPLACES the URL — native.js owns the one history entry the
    // back button needs — and it must hand the existing history STATE straight
    // back, or the back sentinel's { cfNav: 1 } dies on the first view change.
    sandbox.history.state = { cfNav: 1 };
    sandbox.location.pathname = '/login'; sandbox.location.search = '?story=1'; sandbox.location.hash = '';
    Object.assign(sandbox.S, { me: { id: 'u1' }, view: 'server', serverId: 's1', channelId: 'c2' });
    calls.replace.length = 0;
    check(cf.cfSyncUrl() === true && calls.replace.length === 1, 'cfSyncUrl writes the path through history');
    check(calls.replace[0] === '/c/s1/c2?story=1', 'and keeps the query boot still has to read', calls.replace[0]);
    check(sandbox.history.state && sandbox.history.state.cfNav === 1, 'while the sentinel state survives the write', sandbox.history.state);
    calls.replace.length = 0;
    cf.cfSetPath('/c/s1/c2');
    cf.cfSetPath('/c/s1/c2');
    check(calls.replace.length === 0, 'writing the path the bar is already on touches history not at all');
    const arm = cf.cfArmUrl();
    check(arm === '/c/s1/c2?story=1', 'and the back sentinel is pushed at that same canonical URL', arm);
    // The invite landing and the share action are read from the pathname at the
    // end of boot, so a navigation must leave their paths alone.
    sandbox.location.pathname = '/invite/abc123';
    calls.replace.length = 0;
    Object.assign(sandbox.S, { me: { id: 'u1' }, view: 'server', serverId: 's1', channelId: 'c2' });
    check(cf.cfSyncUrl() === false && calls.replace.length === 0,
      'a navigation never renames /invite/:code (consumeInvite still has to read it)', calls.replace.slice());
    sandbox.location.pathname = '/share';
    check(cf.cfSyncUrl() === false && calls.replace.length === 0, 'nor /share (consumeShare)', calls.replace.slice());
    sandbox.location.pathname = '/nope';
    sandbox.location.search = '';
    check(cf.cfSyncUrl() === true && calls.replace[0] === '/c/s1/c2', 'while junk still heals to the real path', calls.replace.slice());
  }

  console.log('\n[2] the signed-out side: name the screen, keep the target');
  {
    const { cf, sandbox, calls, stash } = loadRouter();
    const enter = (pathname, search, owned) => {
      sandbox.location.pathname = pathname;
      sandbox.location.search = search || '';
      calls.replace.length = 0;
      sandbox.modes.length = 0;
      stash.clear();
      if (owned) stash.set('cf_url', JSON.stringify(owned));
      cf.cfAuthScreenEnter();
      return { url: calls.replace[calls.replace.length - 1], count: calls.replace.length, modes: sandbox.modes.slice() };
    };
    let r = enter('/');
    check(r.url === '/login' && r.count === 1, 'the bare root is named /login', r);
    r = enter('/login');
    check(r.count === 0 || r.url === '/login', '/login stays /login', r);
    check(!stash.has('cf_route'), 'and nothing is stashed for later');
    r = enter('/signup');
    check((r.count === 0 || r.url === '/signup') && r.modes.includes('register'),
      '/signup names the sign-up tab and selects it', r);
    r = enter('/c/s1/c2', '?utm=x');
    check(r.url === '/login?utm=x' && stash.get('cf_route') === '/c/s1/c2',
      'a place is stashed and the bar says /login (the query rides along)', { url: r.url, stash: [...stash] });
    stash.set('cf_route', '/dm/t9');
    const taken = cf.cfTakePendingRoute();
    check(taken && taken.kind === 'dm' && taken.id === 't9', 'the stash comes back as a route', taken);
    check(!stash.has('cf_route'), 'and is consumed exactly once');
    stash.set('cf_route', '/c/s1/c2');
    cf.cfForgetPendingRoute();
    check(cf.cfTakePendingRoute() === null, 'signing out forgets it (cfForgetPendingRoute)');
    // Paths something else still has to read are left alone, byte for byte.
    for (const p of ['/invite/abc123', '/share', '/nope']) {
      const out = enter(p, '?text=hi');
      check(out.count === 0 && !stash.has('cf_route'), 'untouched, and nothing stashed: ' + p, out);
    }
    // A conversation another account left in the bar is not a place this visitor
    // asked for, so it is not carried across sign-in either.
    const other = enter('/c/s1/c2', '', { p: '/c/s1/c2', u: 'someone-else' });
    check(other.url === '/login' && !stash.has('cf_route'),
      'a path the PREVIOUS account left behind is not stashed for the next one', other);
  }

  console.log('\n[3] boot prefers the path');
  {
    const { cf, sandbox, stash } = loadRouter();
    const route = (pathname) => { sandbox.location.pathname = pathname; return cf.cfBootRoute(); };
    const dm = route('/dm/t1');
    check(dm && dm.kind === 'dm' && dm.id === 't1', 'a DM path outranks the last-view memory', dm);
    const s = route('/c/s1/c2');
    check(s && s.kind === 'server' && s.serverId === 's1' && s.channelId === 'c2', 'and so does a channel path', s);
    const h = route('/home');
    check(h && h.kind === 'home', 'and /home');
    check(route('/login') === null, 'the auth paths name no place, so a signed-in load of /login falls through to the memory');
    stash.set('cf_route', '/c/s1/c2');
    const back = route('/login');
    check(back && back.kind === 'server' && back.channelId === 'c2', 'the stashed target is the fallback for exactly that case', back);
    check(!stash.has('cf_route'), 'and it is consumed there');
    stash.set('cf_route', '/dm/t1');
    const live = route('/c/s1/c2');
    check(live && live.kind === 'server' && stash.get('cf_route') === '/dm/t1', 'a real path never picks up a stale stashed target');
    // …and a path another account left in the tab belongs to THAT account: the
    // per-account last-view memory is the authority for this one.
    stash.clear();
    sandbox.location.pathname = '/dm/t1';
    stash.set('cf_url', JSON.stringify({ p: '/dm/t1', u: 'someone-else' }));
    check(route('/dm/t1') === null, 'a path left behind by another account is ignored (signing in must not surface it)');
    stash.set('cf_url', JSON.stringify({ p: '/dm/t1', u: 'u1' }));
    const mine = route('/dm/t1');
    check(mine && mine.kind === 'dm' && mine.id === 't1', 'while the same account keeps its own');
    stash.set('cf_url', JSON.stringify({ p: '/c/s1/c2', u: 'someone-else' }));
    const pasted = route('/dm/t1');
    check(pasted && pasted.kind === 'dm', 'and a path this tab did NOT write is the reader\'s own entry (a pasted link)', pasted);
  }

  console.log('\n[4] the wiring the runtime half depends on');
  {
    const index = read('public/index.html');
    const sw = read('public/service-worker.js');
    const core = read('public/js/core.js');
    const auth = read('public/js/auth.js');
    const native = read('public/js/native.js');
    const server = read('server.js');
    check(/<script src="\/js\/router\.js"><\/script>/.test(index), 'router.js is loaded by the shell');
    check(index.indexOf('/js/router.js') < index.indexOf('/js/auth.js'), 'and before auth.js, whose boot() resolves the path');
    check(sw.includes("'/js/router.js'"), 'and precached by the service worker');
    check(/const CACHE = 'campfire-v(\d+)'/.test(sw) && !/'campfire-v602'/.test(sw), 'the shell cache was bumped for this release');
    // ONE writer: rememberView is the funnel every navigation in the app goes
    // through, so painting the URL anywhere else would drift from the last-view
    // memory written right beside it.
    check(/function rememberView\(\)/.test(core) && /try \{ cfSyncUrl\(\); \} catch \{\}/.test(core),
      'rememberView() paints the URL (the one hook every navigation uses)');
    check(/const route = cfBootRoute\(\);/.test(auth) && /if \(route\) await cfOpenRoute\(route\);/.test(auth),
      'boot() resolves the path and opens it');
    check(auth.indexOf('cfBootRoute();') < auth.indexOf('const mem = readMemView();'),
      'reading it before the last-view memory, so the memory is the fallback');
    check(/try \{ cfAuthScreenEnter\(\); \} catch \{\}/.test(auth), 'showAuth() names the auth screen in the bar');
    check(/cfSetPath\(m === 'register' \? '\/signup' : '\/login'\)/.test(auth), 'and the two auth tabs are two paths');
    check(/try \{ cfForgetPendingRoute\(\); \} catch \{\}/.test(auth), 'signing out forgets where the last session was');
    const router = read('public/js/router.js');
    check(!/history\.pushState/.test(router), 'the router never pushes a history entry (native.js owns the back sentinel)');
    check(/history\.replaceState\(history\.state \|\| null, '', url\)/.test(router),
      'and hands the existing history state back, so { cfNav: 1 } survives a navigation');
    check(/const url = \(typeof cfArmUrl === 'function'\) \? cfArmUrl\(\) : location\.href;/.test(native),
      'the back sentinel is pushed at the current view\'s path, never at a stale location.href');
    check(/try \{ cfSyncUrl\(\); \} catch \{\}/.test(native),
      'and a back press that lands on an older entry puts the bar back on the view on screen');
    // A deep path is the same shell, so it has to go out through sendShell or it
    // would ship without the per-deploy asset pins ("/" pinned, "/c/x/y" stale).
    check(/app\.get\('\*', \(req, res, next\) => \{[\s\S]{0,240}?sendShell\(res, next, null\);/.test(server),
      'the SPA fallback serves deep paths through sendShell (asset pins included)');
    check(/app\.use\('\/uploads', \(req, res\) => res\.status\(404\)/.test(server),
      'and /uploads still 404s rather than falling through to the shell');
    check(server.indexOf("app.use('/uploads', (req, res) => res.status(404)") < server.indexOf("app.get('*'"),
      'because that 404 handler is registered before the fallback');
  }

  const chromePath = findChrome();
  if (!chromePath) { console.log('\n[5-9] headless Chrome half: SKIP (no Chrome/Edge found — set CHROME_PATH)'); return finish(); }
  const envFile = readEnvFile();
  const pg = {
    host: process.env.PGHOST || envFile.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || envFile.POSTGRES_USER || 'campfire',
    password: process.env.PGPASSWORD || envFile.POSTGRES_PASSWORD || '',
  };
  const admin = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
  try { await admin.connect(); }
  catch { console.log('\n[5-9] headless Chrome half: SKIP (Postgres unreachable — docker compose up -d db)'); return finish(); }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-url-routes-'));
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
        JWT_SECRET: 'test-url-routes-secret',
        UPLOAD_DIR: uploads,
        UNFURL: '0', VIRUS_SCAN: '0', MEDIA_COMPRESS: '0', BUCKET_SCAN: '0', ORPHAN_SWEEP: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    const fail = (msg) => { throw new Error(msg + '\n--- server log ---\n' + serverLog.slice(-3000)); };
    const BASE = `http://127.0.0.1:${PORT}`;
    let up = false;
    for (let i = 0; i < 160 && !up; i++) {
      try { up = (await fetch(`${BASE}/api/config`)).ok; } catch {}
      if (!up) await sleep(250);
    }
    if (!up) return fail('server did not come up');

    const register = async (username, displayName) => {
      const r = await fetch(`${BASE}/api/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, displayName, password: 'passw0rd!x' }),
      });
      const d = await r.json();
      if (!d.token) throw new Error('register failed: ' + JSON.stringify(d));
      return d;
    };
    const me = await register('routeuser', 'Router');
    const pally = await register('pally', 'Pally');
    const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + me.token };
    const post = async (p, body) => (await fetch(BASE + p, { method: 'POST', headers: auth, body: JSON.stringify(body) })).json();
    const srv = (await post('/api/servers', { name: 'Studio' })).server;
    const chan2 = (await post(`/api/servers/${srv.id}/channels`, { name: 'offtopic', type: 'text' })).channel;
    const detail = await (await fetch(`${BASE}/api/servers/${srv.id}`, { headers: auth })).json();
    const chan1 = detail.server.channels.find((c) => c.type === 'text');
    const dm = (await post('/api/dms', { userId: pally.user.id })).thread;
    const invite = (await post(`/api/servers/${srv.id}/invites`, { label: 'route test' })).invite;
    if (!chan1 || !chan2 || !dm || !invite) return fail('fixtures were not created: ' + JSON.stringify({ chan1, chan2, dm, invite }));

    /* ---------- [5] the shell is served on a deep path ---------- */
    console.log('\n[5] the server answers a deep path with the pinned shell');
    {
      const res = await fetch(`${BASE}/c/${srv.id}/${chan2.id}`);
      const html = await res.text();
      check(res.ok && /text\/html/.test(res.headers.get('content-type') || ''), 'GET /c/<server>/<channel> is 200 text/html');
      check(/src="\/js\/router\.js\?v=[0-9a-f]{6,}"/.test(html), 'and carries the per-deploy asset pins (never a bare index.html off disk)');
      check(!/og:title/.test(html), 'and no OpenGraph tags — a private channel has no preview to give');
      const miss = await fetch(`${BASE}/uploads/nope.png`);
      check(miss.status === 404, 'a missing upload still 404s rather than being served the shell', miss.status);
      check(/og:title/.test(await (await fetch(`${BASE}/`)).text()), 'while the app root keeps its own preview');
    }

    chrome = spawn(chromePath, [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(tmp, 'chrome')}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
      '--window-size=420,900', 'about:blank',
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
    const waitFor = async (expr, ms = 25000) => {
      const t0 = Date.now();
      for (;;) {
        try { const v = await evaluate(`(() => { try { return ${expr} } catch (e) { return false } })()`); if (v) return v; } catch {}
        if (Date.now() - t0 > ms) return null;
        await sleep(150);
      }
    };
    const setTouch = (on) => send('Emulation.setTouchEmulationEnabled', { enabled: !!on, maxTouchPoints: 5 });
    const touchTap = async (selector) => {
      const c = await evaluate(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y }] });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(180);
      return c;
    };
    // Load a URL the way a pasted link does: a REAL navigation, so boot() runs
    // against that path from scratch. The token goes into localStorage first
    // (storage belongs to the origin, not the document), and the wait keys on a
    // marker planted in the outgoing document — a fresh window cannot have it,
    // so "the new page is up" is never confused with "the old one still is".
    const go = async (p, opts = {}) => {
      const token = opts.token;
      await evaluate(`(() => { ${token
        ? `localStorage.setItem('cf_token', ${JSON.stringify(me.token)}); localStorage.setItem('cf_sid', ${JSON.stringify(me.sid)});`
        : `localStorage.removeItem('cf_token'); localStorage.removeItem('cf_sid');`} return 1; })()`);
      await evaluate('window.__cfPrev = 1');
      await send('Page.navigate', { url: BASE + p });
      const ready = opts.until || (token
        ? `typeof S !== 'undefined' && S.me && document.querySelector('#view-auth').classList.contains('hidden')`
        : `typeof boot === 'function' && !document.querySelector('#view-auth').classList.contains('hidden')`);
      const ok = await waitFor(`typeof window.__cfPrev === 'undefined' && (${ready})`);
      if (!ok) {
        let dump = '';
        try {
          dump = await evaluate(`JSON.stringify({ href: location.href, hasS: typeof S !== 'undefined', me: (typeof S !== 'undefined' && S.me) ? S.me.username : null, view: (typeof S !== 'undefined' ? S.view : null), cid: (typeof S !== 'undefined' ? S.channelId : null), auth: !document.querySelector('#view-auth').classList.contains('hidden'), mark: typeof window.__cfPrev })`);
        } catch (e) { dump = 'no page: ' + e.message; }
        throw new Error('page never became ready for ' + p + ' (until: ' + ready + ') — ' + dump + '\n--- server log ---\n' + serverLog.slice(-2000));
      }
      await sleep(150);
      return evaluate('location.pathname + location.search');
    };
    const state = () => evaluate(`({ path: location.pathname, view: S.view, sid: S.serverId, cid: S.channelId, dm: S.dmThreadId, panel: S.homePanel, auth: !document.querySelector('#view-auth').classList.contains('hidden') })`);
    const pathNow = () => evaluate('location.pathname');

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await setTouch(true);
    // First navigation: from about:blank (no origin yet) to the app, so that
    // every later go() can touch localStorage before it navigates.
    await evaluate(`location.href = '${BASE}/'`);
    if (!(await waitFor(`typeof boot === 'function'`))) return fail('the app never loaded');

    console.log('\n[6] a signed-out visitor gets /login and /signup');
    {
      let p = await go('/', { token: '' });
      check(p === '/login', 'the app root lands on /login', p);
      check((await state()).auth === true, 'with the auth screen up');
      await touchTap('#tab-register');
      p = await pathNow();
      check(p === '/signup', 'the Create-account tab is /signup', p);
      check(await evaluate(`document.querySelector('#tab-register').classList.contains('active')`), 'and the tab really switched');
      await touchTap('#tab-login');
      check((await pathNow()) === '/login', 'and back to /login');
      // A deep link while signed out: the bar names the auth page (the visitor is
      // not in the app yet) and the target is kept for after sign-in.
      p = await go(`/c/${srv.id}/${chan2.id}`, { token: '' });
      check(p === '/login' && (await state()).auth === true, 'a channel link signed out lands on /login, not on a blank app', p);
      p = await go(`/invite/${invite.code}`, { token: '', until: `!document.querySelector('#invite-view').classList.contains('hidden')` });
      check(await waitFor(`!document.querySelector('#invite-view').classList.contains('hidden')`), 'the invite landing is up');
      check(p === '/' && !/invite/.test(p),
        'and the invite landing keeps its own path handling (consumeInvite rewrites it — this work leaves that alone)', p);
    }

    console.log('\n[7] a pasted path boots into the thing it names');
    {
      let p = await go(`/c/${srv.id}/${chan2.id}`, { token: me.token, until: `S.channelId === ${JSON.stringify(chan2.id)}` });
      let st = await state();
      check(st.view === 'server' && st.cid === chan2.id, 'a channel path opens THAT channel', st);
      check(p === `/c/${srv.id}/${chan2.id}`, 'and the bar says so', p);
      p = await go(`/c/${srv.id}/${chan1.id}`, { token: me.token, until: `S.channelId === ${JSON.stringify(chan1.id)}` });
      check((await state()).cid === chan1.id, 'the same server\'s other channel opens too');
      p = await go('/home', { token: me.token, until: `S.view === 'home' && !S.dmThreadId` });
      check(p === '/home', '/home opens Home', p);
      p = await go('/stories', { token: me.token, until: `S.view === 'home' && S.homePanel === 'stories'` });
      check(p === '/stories', '/stories opens the story center', p);
      p = await go(`/dm/${dm.id}`, { token: me.token, until: `S.dmThreadId === ${JSON.stringify(dm.id)}` });
      st = await state();
      check(st.view === 'home' && st.dm === dm.id && p === `/dm/${dm.id}`, '/dm/<thread> opens that DM', { p, st });
      p = await go(`/channels/${srv.id}/${chan1.id}`, { token: me.token, until: `S.channelId === ${JSON.stringify(chan1.id)}` });
      check((await state()).cid === chan1.id, 'the /channels alias works');
      check(p === `/c/${srv.id}/${chan1.id}`, 'and is canonicalized to /c/… in the bar', p);
      // A path nothing can satisfy degrades to a real place rather than an error.
      await go('/nope/nope/deeper', { token: me.token, until: `typeof S !== 'undefined' && S.me && (S.view === 'home' || !!S.channelId)` });
      p = await pathNow();
      check(p !== '/nope/nope/deeper' && (await evaluate('cfRouteFromPath(location.pathname) !== null')),
        'junk heals itself into a path the router knows', p);
    }

    console.log('\n[8] signing in lands on the target the link named');
    {
      // Stashed by the signed-out load, in THIS tab: the promise is real
      // sessionStorage, not a mock.
      let p = await go(`/dm/${dm.id}`, { token: '' });
      check(p === '/login', 'a signed-out DM link waits on /login', p);
      await evaluate(`(() => { localStorage.setItem('cf_token', ${JSON.stringify(me.token)}); localStorage.setItem('cf_sid', ${JSON.stringify(me.sid)}); return 1; })()`);
      await evaluate('boot()');
      const landed = await waitFor(`S.dmThreadId === ${JSON.stringify(dm.id)}`);
      p = await pathNow();
      check(landed && p === `/dm/${dm.id}`, 'and signing in lands on the DM it named', { p, landed });
      // Spent, not sticky: a later load of /login falls back to the memory.
      await go('/home', { token: me.token, until: `S.view === 'home' && !S.dmThreadId` });
      p = await go('/login', { token: me.token, until: `S.view === 'home'` });
      check(p === '/home', 'a later /login load restores the last view, never the spent target', p);
    }

    console.log('\n[9] navigation writes the path, and the phone\'s back sentinel survives it');
    {
      await go(`/c/${srv.id}/${chan1.id}`, { token: me.token, until: `S.channelId === ${JSON.stringify(chan1.id)}` });
      // A real navigation through the app's own function — the funnel
      // rememberView() hangs off.
      await evaluate(`selectChannel(${JSON.stringify(chan2.id)})`);
      await waitFor(`S.channelId === ${JSON.stringify(chan2.id)}`);
      check((await pathNow()) === `/c/${srv.id}/${chan2.id}`, 'switching channel rewrites the path');
      await evaluate(`openHome({ panel: 'friends', dm: null })`);
      await waitFor(`S.view === 'home' && !S.dmThreadId`);
      check((await pathNow()) === '/home', 'opening Home rewrites it again');
      await evaluate(`selectDmThread(${JSON.stringify(dm.id)})`);
      await waitFor(`S.dmThreadId === ${JSON.stringify(dm.id)}`);
      check((await pathNow()) === `/dm/${dm.id}`, 'and a DM does too');
      // Back: armed by a touch, and ONE press must still close one thing. The
      // navigation above ran while the sentinel was on top of the stack, so this
      // is also the check that a navigation cannot erase { cfNav: 1 }.
      await go(`/c/${srv.id}/${chan1.id}`, { token: me.token, until: `S.channelId === ${JSON.stringify(chan1.id)}` });
      check(!(await evaluate(`!!(history.state && history.state.cfNav)`)), 'nothing is armed before the first touch');
      await touchTap('#btn-menu');
      await sleep(420);
      check(await evaluate(`!!(history.state && history.state.cfNav)`), 'a touch arms the back sentinel');
      check((await pathNow()) === `/c/${srv.id}/${chan1.id}`, 'and arming it keeps the bar on the conversation', await pathNow());
      const before = await evaluate('history.length');
      await evaluate(`selectChannel(${JSON.stringify(chan2.id)})`);
      await waitFor(`S.channelId === ${JSON.stringify(chan2.id)}`);
      check(await evaluate(`!!(history.state && history.state.cfNav)`),
        'a navigation while it is armed leaves the sentinel state alone (replaceState, never a fresh entry)');
      check((await evaluate('history.length')) === before, 'and pushes no history entry at all',
        { before, after: await evaluate('history.length') });
      await evaluate('history.back()');
      await sleep(600);
      const after = await state();
      check(after.view === 'server' && after.cid === chan2.id,
        'back still steps out of the conversation into the list (one press, one thing)', after);
      check(await evaluate(`document.body.classList.contains('nav-open')`), 'the nav page is what it opened');
      check((await pathNow()) === `/c/${srv.id}/${chan2.id}`,
        'and the bar is put back on the view on screen, not on the entry underneath', await pathNow());
    }

    check(pageErrors.length === 0, 'no uncaught page errors through the whole run', pageErrors.slice(0, 4));
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome && chrome.kill(); } catch {}
    try { child && child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  return finish();
}

function finish() {
  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
