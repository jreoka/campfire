// Active threads is a SERVER control, and it is scoped to the server you are in.
//
// Threads live in server text channels only — a DM has no thread column at all
// (dm_messages carries reply_to_id, never thread_root_id) — but the header's
// Threads button lived in the SHARED chat header, so it was painted on Home's
// blank feed and over an open DM/group too, and the panel it opened listed
// threads from EVERY server you are in. ui.js's ⋯ sheet even documented the
// intended behaviour ("a `.hidden` class means the app switched that control
// off … threads in a DM") while nothing ever set that class.
//
// The fix has two halves that have to agree, and this pins both:
//   [1] the button is visible exactly when a server is on screen —
//       paintThreadsBtn() is the only writer, and every view transition calls it
//       (select a server, open a channel, open a DM, Home's feed), each at the
//       point where the state it reads is complete;
//   [2] the panel it opens asks for THAT server's threads
//       (`/api/threads/active?serverId=…`), and the route narrows the query —
//       with the placeholder order and the argument list still in step, which
//       is the one thing about this change that fails silently and wrongly
//       (a mis-ordered `$n` answers another server's threads, or none).
//
// [1] is checked statically and then for real in headless Chrome: the REAL
// markup, the REAL stylesheet, and paintThreadsBtn() sliced verbatim out of
// pickers.js, driven through the real state transitions. [2] is checked
// statically AND by evaluating the route's own SQL template with each branch
// taken, so a `?` without an argument (or an argument without a `?`) fails here
// rather than against a database this test does not need.
//
// Skips (exit 0) when Chrome is unavailable.
//
// Usage: node scripts/test-threads-scope.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DESKTOP = { w: 1280, h: 900 };
const PHONE = { w: 390, h: 844 };
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9361', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const srv = read('server.js');
const pickers = read('public/js/pickers.js');
const home = read('public/js/home.js');
const servers = read('public/js/servers.js');
const pins = read('public/js/pins.js');
const ui = read('public/js/ui.js');
const index = read('public/index.html');
const css = read('public/styles.css');

// The app's scripts, in load order, as one blob: the sweep for "nothing else
// touches the button" has to cover every module, not just the one that owns it.
const MODULES = ['core', 'auth', 'noise', 'servers', 'messages', 'socket', 'ui', 'voice', 'actions',
  'rail', 'home', 'pins', 'share', 'compose', 'story-edit', 'stories', 'viewonce', 'pickers',
  'settings', 'admin', 'security', 'final', 'native'];
const allJs = MODULES.map((m) => read('public/js', m + '.js')).join('\n');

// The REAL paintThreadsBtn(), sliced out of pickers.js — not a paraphrase, so a
// change to the rule fails here instead of passing on a copy of itself.
function painterSource() {
  const m = pickers.match(/function paintThreadsBtn\(\) \{[\s\S]*?\n\}/);
  if (!m) {
    console.error('[test] could not find paintThreadsBtn() in public/js/pickers.js');
    process.exit(1);
  }
  return m[0];
}
// ...and the REAL SQL template out of the route, so both branches of its two
// conditionals can be taken for real (see [2]). Sliced out of the route's own
// block, because `rows = await db.prepare(` alone matches a dozen other queries.
function routeSqlTemplate() {
  const route = srv.indexOf("app.get('/api/threads/active'");
  const end = route >= 0 ? srv.indexOf('res.json({ threads: out });', route) : -1;
  if (route < 0 || end < 0) {
    console.error('[test] could not find the /api/threads/active route in server.js');
    process.exit(1);
  }
  const body = srv.slice(route, end);
  const a = body.indexOf('db.prepare(`');
  const b = body.indexOf('`).all(...args);');
  if (a < 0 || b < 0 || b <= a) {
    console.error('[test] could not find the threads query in the route');
    process.exit(1);
  }
  return body.slice(a + 'db.prepare(`'.length, b);
}

function pageHtml(painter) {
  const cut = index.indexOf('<script src="/embeds.js">');
  const head = index.slice(0, cut);
  return head + `
<style>*{transition:none!important;animation:none!important}</style>
<script>
document.getElementById('view-auth').classList.add('hidden');
document.getElementById('boot-splash').style.display = 'none';
document.getElementById('view-main').classList.remove('hidden');
</script>
<script>
// ---- the app globals the sliced block touches ----
const $ = (s) => document.querySelector(s);
const S = { view: 'home', serverId: null };
</script>
<script>
${painter}
</script>
<script>
window.__probe = () => {
  const b = $('#btn-threads');
  return {
    vw: innerWidth,
    // The CLASS is what ui.js's ⋯ sheet reads (it skips any control carrying
    // .hidden), so it is reported next to what the stylesheet actually did.
    hiddenClass: b.classList.contains('hidden'),
    display: getComputedStyle(b).display,
    visible: b.offsetParent !== null,
    title: b.title,
  };
};
// The four transitions, in the same shape the shipping callers leave behind.
window.__view = (view, serverId, dmOpen) => {
  S.view = view; S.serverId = serverId;
  document.body.classList.toggle('view-home', view === 'home');
  document.body.classList.toggle('dm-open', !!dmOpen);
  paintThreadsBtn();
  return __probe();
};
</script>
</body></html>`;
}

function connectWs(url) {
  const WS = globalThis.WebSocket || require('ws');
  const sock = new WS(url, { perMessageDeflate: false });
  const on = (ev, fn) => (typeof sock.addEventListener === 'function' ? sock.addEventListener(ev, fn) : sock.on(ev, fn));
  return { sock, on, send: (s) => sock.send(s), close: () => sock.close() };
}

function staticChecks() {
  console.log('\n[1] the wiring: one painter, four transitions, one shipped-hidden button');

  // --- the button's visibility, decided in exactly one place ---
  check(/function paintThreadsBtn\(\) \{\s*\n\s*const b = \$\('#btn-threads'\);\s*\n\s*if \(!b\) return;\s*\n\s*b\.classList\.toggle\('hidden', !\(S\.view === 'server' && !!S\.serverId\)\);/.test(pickers),
    'paintThreadsBtn() is the single decision: a server on screen (pickers.js)');
  check(!/\$\('#btn-threads'\)\.classList\.remove\('hidden'\)/.test(allJs),
    'and nothing anywhere reveals the button unconditionally — the class is the only switch');
  check((pickers.match(/btn-threads/g) || []).length === 2,
    'pickers.js is the only module that names it: one painter, one click handler');

  const calls = (src) => (src.match(/paintThreadsBtn\(\);/g) || []).length;
  // ORDER is the substance here: selectServer() calls openServerView() BEFORE it
  // sets S.serverId, so a painter there reads the OUTGOING server — and a server
  // with no text channel never reaches selectChannel at all, so that is not a
  // safe home for it either. It belongs where the state is complete.
  check(/S\.serverId = id;\s*\n\s*S\.channelId = null;[\s\S]{0,600}?paintThreadsBtn\(\);/.test(servers),
    'selectServer paints it once its own id is set (servers.js)');
  check(!/paintThreadsBtn\(\);/.test(home),
    'openServerView does NOT — it runs before S.serverId, so it would see the outgoing server');
  check(calls(servers) === 2 && /paintHeaderGroupEdit\(false\);[\s\S]{0,140}paintThreadsBtn\(\);/.test(servers),
    'selectChannel paints it for the channel being opened as well (idempotent)');
  check(calls(pins) === 2,
    'selectDmThread and renderDmBlank both paint it away under Home (pins.js)');
  check(calls(servers) + calls(pins) === 4,
    'every view transition is wired — no path leaves a stale button behind');
  check(/id="btn-threads" class="icon-btn threads-btn hidden"/.test(index),
    'the button SHIPS hidden, so no view can show it before a server has been painted (index.html)');
  check(/if \(!b \|\| b\.classList\.contains\('hidden'\)\) continue;/.test(ui),
    'the phone ⋯ sheet still skips a hidden control, so the row leaves the sheet with the button (ui.js)');

  // --- the panel it opens is scoped to that server ---
  check(/async function openActiveThreads\(\) \{[\s\S]{0,400}?if \(!\(S\.view === 'server' && S\.serverId\)\) return;/.test(pickers),
    'openActiveThreads() refuses to open with no server to scope it to (pickers.js)');
  check(/data-server-id="\$\{esc\(serverId\)\}"/.test(pickers),
    'the open panel carries the server it is scoped to');
  check(/const serverId = list\.dataset\.serverId \|\| '';/.test(pickers),
    'and the fetch reads that scope off the PANEL, never a module-level variable');
  check(/if \(serverId\) params\.push\('serverId=' \+ encodeURIComponent\(serverId\)\);/.test(pickers),
    'the request sends it to the route');
  check(/const where = serverId\s*\n\s*\? `<span class="t-hash">#<\/span>\$\{esc\(t\.channelName \|\| ''\)\}`/.test(pickers),
    'a scoped row leads with the channel, not the same server name 50 times');
  check(/threadsEmptyHTML\(qv, !!serverId\)/.test(pickers) && /threadsEmptyHTML\(q, !!serverId\)/.test(pickers),
    'and both empty states know whether they are speaking for one server');

  // --- the route narrows the query ---
  check(/const serverId = String\(req\.query\.serverId \|\| ''\)\.trim\(\);/.test(srv),
    'the route reads ?serverId= (server.js)');
  check(/if \(serverId && !\(await isMember\(serverId, me\)\)\) return res\.json\(\{ threads: \[\] \}\);/.test(srv),
    'a server the caller is not in answers nothing rather than leaking a list');
  check(/\$\{serverId \? 'AND r\.server_id = \?' : ''\}/.test(srv),
    'and the query is narrowed to that server');
  check(/const args = \[me\];\s*\n\s*if \(serverId\) args\.push\(serverId\);\s*\n\s*args\.push\(me, me, me\);\s*\n\s*if \(q\) args\.push\(pat, pat, pat, pat\);\s*\n\s*args\.push\(cutoff\);/.test(srv),
    'the argument list is built left-to-right in the SQL\'s own order');
}

// The failure this catches is silent and wrong, not loud: db.js rewrites `?` to
// $n in order, so one argument out of place points a clause at the wrong value
// (or shifts every later one) and the endpoint still answers 200.
function placeholderChecks() {
  console.log('\n[2] the SQL template and its arguments agree, in both branches');
  const tpl = routeSqlTemplate();
  let build = null;
  try {
    build = new Function('serverId', 'q', 'return `' + tpl + '`;');
  } catch (e) {
    check(false, 'the route\'s SQL template can be evaluated', String(e && e.message));
    return;
  }
  const cases = [
    { serverId: '', q: '', label: 'every server you are in (the original shape)' },
    { serverId: 'srv_1', q: '', label: 'one server' },
    { serverId: '', q: 'hello', label: 'every server + a search' },
    { serverId: 'srv_1', q: 'hello', label: 'one server + a search' },
  ];
  for (const c of cases) {
    const sql = build(c.serverId, c.q);
    const holes = (sql.match(/\?/g) || []).length;
    const args = 1 + (c.serverId ? 1 : 0) + 3 + (c.q ? 4 : 0) + 1; // join user, scope, participation ×3, search ×4, cutoff
    check(holes === args, `${c.label}: ${holes} placeholder(s), ${args} argument(s)`, { holes, args });
  }
  const scoped = build('srv_1', '');
  check(/AND r\.server_id = \?/.test(scoped), 'the scoped branch really narrows on the server column');
  check(!/AND r\.server_id = \?/.test(build('', '')), 'and the unscoped branch is left exactly as it was');
}

async function main() {
  staticChecks();
  placeholderChecks();

  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found — set CHROME_PATH');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-thrscope-'));
  const html = pageHtml(painterSource());
  const srvHttp = http.createServer((req, res) => {
    if (req.url.startsWith('/styles.css')) {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end(css);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((res) => srvHttp.listen(0, '127.0.0.1', res));
  const port = srvHttp.address().port;

  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(dir, 'prof')}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-dev-shm-usage', `--window-size=${DESKTOP.w},${DESKTOP.h}`, 'about:blank'],
    { stdio: 'ignore' });

  let close = () => {};
  try {
    let info = null;
    for (let i = 0; i < 80 && !info; i++) {
      try { info = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch {}
      if (!info) await sleep(250);
    }
    if (!info) return skip('Chrome did not expose the DevTools port');
    const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const { on, send, close: closeWs } = connectWs(target.webSocketDebuggerUrl);
    close = closeWs;
    await new Promise((res, rej) => { on('open', res); on('error', rej); });
    let msgId = 0;
    const pending = new Map();
    on('message', (evt) => {
      const m = JSON.parse(String(evt.data !== undefined ? evt.data : evt));
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
      }
    });
    const rpc = (method, params = {}) => new Promise((res, rej) => {
      const i = ++msgId;
      pending.set(i, { res, rej });
      send(JSON.stringify({ id: i, method, params }));
    });
    const ev = async (expression) => {
      const r = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const load = async () => { await rpc('Page.navigate', { url: `http://127.0.0.1:${port}/` }); await sleep(700); };
    const device = async (w, h, { touch = false } = {}) => {
      await rpc('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
      await rpc('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: touch ? 2 : 1, mobile: touch });
      await sleep(320);
    };
    await rpc('Page.enable');
    await rpc('Runtime.enable');

    console.log('\n[3] the real markup + real stylesheet + the real painter, driven through the transitions');
    await device(DESKTOP.w, DESKTOP.h, { touch: false });
    await load();

    const shipped = await ev('__probe()');
    check(shipped.hiddenClass === true && shipped.display === 'none',
      'as shipped — before any view is painted — the button is not on screen', shipped);
    check(shipped.title === 'Active threads in this server',
      'and it says which server it speaks for', shipped.title);

    const onServer = await ev("__view('server','srv_1',false)");
    check(onServer.hiddenClass === false,
      'entering a server clears .hidden (the class the ⋯ sheet reads)', onServer);
    check(onServer.display !== 'none' && onServer.visible === true,
      'that is a real box in the real layout — the button is actually on the header', onServer);

    const homeFeed = await ev("__view('home',null,false)");
    check(homeFeed.hiddenClass === true && homeFeed.display === 'none' && homeFeed.visible === false,
      'Home\'s blank feed hides it', homeFeed);
    check(homeFeed.display !== onServer.display,
      'and the class ALONE is what removes it — .hidden beats the button\'s own display rule', { laidOut: onServer.display, hidden: homeFeed.display });

    const dm = await ev("__view('home',null,true)");
    check(dm.hiddenClass === true && dm.visible === false,
      'and an open DM/group hides it too', dm);

    const staleServer = await ev("__view('home','srv_1',true)");
    check(staleServer.hiddenClass === true,
      'a DM carrying a stale serverId cannot resurrect it — the view decides, not the id', staleServer);

    const noServerId = await ev("__view('server',null,false)");
    check(noServerId.hiddenClass === true,
      'and a server view with no server selected has nothing to scope to', noServerId);

    const backOnServer = await ev("__view('server','srv_2',false)");
    check(backOnServer.hiddenClass === false && backOnServer.visible === true,
      'coming back to a server brings it back (the panel would be scopable again)', backOnServer);

    // At phone width the header hands its rails to the ⋯ sheet, so the button is
    // invisible there whatever the class says — which is exactly why the sheet
    // reads the CLASS and not the computed display.
    await device(PHONE.w, PHONE.h, { touch: true });
    const phoneServer = await ev("__view('server','srv_2',false)");
    check(phoneServer.display === 'none' && phoneServer.hiddenClass === false,
      'at phone width the sheet is the route to it, so the class stays honest (unchanged phone rule)', phoneServer);
    const phoneHome = await ev("__view('home',null,true)");
    check(phoneHome.hiddenClass === true,
      'and the sheet drops the row there, because the class is what it skips', phoneHome);
  } finally {
    try { close(); } catch {}
    try { chrome.kill(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    try { srvHttp.close(); } catch {}
  }

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
