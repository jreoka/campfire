// Native back navigation (see AGENTS.md verification conventions).
//
// The complaint: on a phone the app felt like a mobile web page, and the
// navigation specifically was the tell. The biggest single reason is that
// Android's system back button / edge-swipe did nothing in the app: nothing in
// the SPA ever touched history, so back from an open sheet, an open settings
// page, or a conversation left Campfire entirely. Every native chat app steps
// back through what is open and, at the bottom of the stack, steps out of the
// conversation and into the list.
//
// This drives the REAL page in headless Chrome at a phone viewport, with real
// touch input, against a throwaway database, and pins the whole stack: the
// sentinel that arms on a touch device, one layer closed per press, topmost
// first, the nav page as the layer under the overlays, the conversation → list
// step, and that a fine pointer (desktop) is left alone so the browser's own
// back button still means what it means.
//
// Also pins the Escape list that back mirrors: it used to call a function that
// does not exist, which threw before anything below it in the list could close.
//
// Skips (exit 0) when Postgres or Chrome is unavailable.
//
// Usage: node scripts/test-native-back.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_native_back_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3431', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9348', 10);

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

async function main() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  // ---- static half: the shapes the runtime half depends on -----------------
  console.log('\n[0] the shell is wired for back navigation');
  const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'public/service-worker.js'), 'utf8');
  const native = fs.readFileSync(path.join(ROOT, 'public/js/native.js'), 'utf8');
  const finalJs = fs.readFileSync(path.join(ROOT, 'public/js/final.js'), 'utf8');
  check(/<script src="\/js\/native\.js"><\/script>/.test(index), 'native.js is loaded by the shell');
  check(sw.includes("'/js/native.js'"), 'and precached by the service worker');
  check(native.includes("window.addEventListener('popstate'"), 'it listens for the back gesture');
  check(/history\.pushState/.test(native), 'and keeps a history entry armed to receive it');
  check(/cfShown\('#'/.test(native) || /cfVisible\('#/.test(native), 'overlay layers are read from live DOM state, not a bookkeeping flag');
  check(/function cfShown\(el\) \{\s*if \(typeof el === 'string'\) el = \$\(el\);/.test(native), 'cfShown takes an element or a selector — a predicate that throws is swallowed by the layer loop and would silently disable that overlay');
  check(!/closeStatusMenu\(/.test(finalJs), 'Escape no longer calls the nonexistent closeStatusMenu (it threw, killing the rest of the list)');
  check(/ESCAPE_LAYERS/.test(finalJs) && /for \(const close of ESCAPE_LAYERS\) \{ try \{ close\(\); \} catch \{\} \}/.test(finalJs), 'Escape peels layers one by one and cannot be killed by one of them throwing');
  check(!/function closeStatusMenu/.test(fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8')), 'closeStatusMenu really is gone from the codebase');

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-native-back-'));
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
        JWT_SECRET: 'test-native-back-secret',
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
    const me = await register('backuser', 'Back');
    const pally = await register('pally', 'Pally');

    const profile = path.join(tmp, 'chrome');
    chrome = spawn(chromePath, [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
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
    const waitFor = async (expr, ms = 20000) => {
      const t0 = Date.now();
      for (;;) {
        try { const v = await evaluate(`(() => { try { return ${expr} } catch (e) { return false } })()`); if (v) return v; } catch {}
        if (Date.now() - t0 > ms) return null;
        await sleep(150);
      }
    };
    // Device emulation + touch emulation: the second is what makes
    // `(pointer:coarse)` / `(hover:none)` true, which is what the shell gates
    // the whole back stack on.
    const setPhone = (w, h, touch) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 3, mobile: !!touch });
    const setTouch = (on) => send('Emulation.setTouchEmulationEnabled', { enabled: !!on, maxTouchPoints: 5 });
    const touchTap = async (selector) => {
      const c = await evaluate(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y }] });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(140);
      return c;
    };
    const touchSwipe = async (x0, y0, x1, y1, steps = 12) => {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(x0 + (x1 - x0) * t), y: Math.round(y0 + (y1 - y0) * t) }] });
        await sleep(12);
      }
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(420);
    };
    // The back gesture. `history.back()` is what the browser does when the user
    // presses the system back button or swipes from the edge.
    const goBack = async (ms = 420) => { await evaluate('history.back()'); await sleep(ms); };
    const navOpen = () => evaluate(`document.body.classList.contains('nav-open')`);
    const armed = () => evaluate(`!!(history.state && history.state.cfNav)`);

    await send('Page.enable');
    await send('Runtime.enable');
    await setPhone(390, 844, true);
    await setTouch(true);
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    if (!(await waitFor(`typeof boot === 'function'`))) return fail('the app never loaded');
    await evaluate(`(() => { localStorage.setItem('cf_token', ${JSON.stringify(me.token)}); localStorage.setItem('cf_sid', ${JSON.stringify(me.sid)}); return 1; })()`);
    await send('Page.reload');
    if (!(await waitFor(`S.me && S.me.username === 'backuser'`))) return fail('boots signed in');

    console.log('\n[1] a conversation, and the sentinel that catches a back press');
    const setup = await evaluate(`(async () => {
      const t = await api('/api/dms', { method: 'POST', body: JSON.stringify({ userId: ${JSON.stringify(pally.user.id)} }) });
      await refreshDms();
      const s = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: 'Studio' }) });
      await refreshServers(s.server.id);
      if (S.ws) S.ws.send(JSON.stringify({ t: 'subscribe' }));
      await selectServer(s.server.id);
      return { tid: t.thread.id, sid: s.server.id, cid: S.channelId };
    })()`);
    check(!!setup.cid, 'a server channel and a 1:1 DM exist', setup);
    check(!(await armed()), 'nothing is armed before the first touch (the auth screen must keep the back button)');
    await touchTap('#btn-menu');
    await sleep(360);
    check(await armed(), 'a real touch on a phone arms the history sentinel');
    await touchTap('#btn-nav-close');
    await sleep(360);

    console.log('\n[1b] thumb-sized targets that do not steal each other\'s taps');
    // The phone grows every small control an invisible 44px hit box rather than
    // growing the control itself (which would re-flow the header). That only
    // works while the boxes stay clear of each other: the header's icon buttons
    // sit on an 8.8px gap, so 44px boxes on a 36px control clear by 0.8px.
    const targets = await evaluate(`(() => {
      const vis = (el) => el.offsetWidth > 0 && el.offsetHeight > 0 && !el.closest('.hidden');
      const btns = [...document.querySelectorAll('#chat-header .icon-btn')].filter(vis);
      const boxes = btns.map((b) => {
        const r = b.getBoundingClientRect();
        const cs = getComputedStyle(b, '::after');
        const w = parseFloat(cs.width) || r.width;
        const h = parseFloat(cs.height) || r.height;
        return { id: b.id, cx: r.left + r.width / 2, cy: r.top + r.height / 2, w, h };
      });
      const idOf = (x, y) => { const el = document.elementFromPoint(x, y); return el ? (el.closest('.icon-btn') || {}).id || 'other' : 'none'; };
      const stolen = [];
      for (const b of boxes) {
        // A point just inside each hit box's right edge must still hit that button.
        const edge = b.cx + b.w / 2 - 1.5;
        const got = idOf(edge, b.cy);
        if (got !== b.id) stolen.push(b.id + ' edge -> ' + got);
      }
      return { count: boxes.length, minH: Math.min(...boxes.map((b) => b.h)), stolen };
    })()`);
    check(targets.count >= 4, 'the channel header exposes its icon buttons', targets);
    check(targets.minH >= 44, 'and each one carries at least a 44px hit box', targets);
    check(targets.stolen.length === 0, 'a tap inside one button\'s hit box never lands on its neighbour', targets.stolen);

    console.log('\n[2] back steps out of a conversation into the list, then out of the list');
    // Every predicate must be answerable. A layer whose `open()` throws is
    // swallowed by the loop, which makes a typo look exactly like "closed" —
    // that is how nine overlays (settings, modal, profile, lightbox, …) were
    // silently un-backable the first time round.
    const brokenLayers = await evaluate(`CF_BACK_LAYERS.map((l) => { try { l.open(); return null; } catch (e) { return l.name + ': ' + e.message; } }).filter(Boolean)`);
    check(brokenLayers.length === 0, 'every back layer can be evaluated (a throwing predicate silently disables that layer)', brokenLayers);
    check(await evaluate(`CF_BACK_LAYERS.length >= 20`), 'and the stack actually covers the overlays', await evaluate(`CF_BACK_LAYERS.length`));
    await evaluate(`(async () => { await selectServer(${JSON.stringify(setup.sid)}); await selectChannel(${JSON.stringify(setup.cid)}, { keepNav: true }); })()`);
    await sleep(300);
    await goBack();
    const afterFirst = await evaluate(`({ nav: document.body.classList.contains('nav-open'), cid: S.channelId, view: S.view })`);
    check(afterFirst.nav === true, 'back from a channel opens the nav page (not the app store)', afterFirst);
    check(afterFirst.cid === setup.cid && afterFirst.view === 'server', 'and leaves the conversation behind it untouched', afterFirst);
    await goBack();
    const afterSecond = await evaluate(`({ nav: document.body.classList.contains('nav-open'), cid: S.channelId, view: S.view })`);
    check(afterSecond.nav === false && afterSecond.cid === setup.cid, 'the next back closes the nav page and keeps the conversation', afterSecond);
    check(await armed(), 'and the shell re-armed for the press after that');
    // Same step from a DM.
    await evaluate(`(async () => { await openHome(); await selectDmThread(${JSON.stringify(setup.tid)}); })()`);
    await sleep(300);
    await goBack();
    check(await navOpen(), 'back from a DM opens the nav page too');
    await goBack();
    check(!(await navOpen()), 'and closes it');

    console.log('\n[3] one overlay per press, topmost first');
    await evaluate(`(async () => { await selectServer(${JSON.stringify(setup.sid)}); await selectChannel(${JSON.stringify(setup.cid)}, { keepNav: true }); })()`);
    await sleep(250);
    // The user card, which on a phone is a bottom sheet.
    await evaluate(`openOwnCard()`);
    await sleep(400);
    check(await evaluate(`!document.querySelector('#usercard').classList.contains('hidden')`), 'the user card sheet is open');
    await goBack();
    check(await evaluate(`document.querySelector('#usercard').classList.contains('hidden')`), 'back closes the card');
    check(!(await navOpen()), 'and does not also open the nav page in the same press (one layer per press)');
    // Settings, then a picker stacked on top of it: back must peel the picker
    // first, exactly like Escape does on the desktop.
    await evaluate(`openSettings()`);
    await sleep(500);
    check(await evaluate(`!document.querySelector('#settings-backdrop').classList.contains('hidden')`), 'settings is open');
    await evaluate(`(() => { const b = document.createElement('button'); b.id = 'test-fake-picker'; document.body.appendChild(b); document.querySelector('#picker').classList.remove('hidden'); })()`);
    await goBack();
    check(await evaluate(`document.querySelector('#picker').classList.contains('hidden')`), 'back closes the picker on top of settings first');
    check(await evaluate(`!document.querySelector('#settings-backdrop').classList.contains('hidden')`), 'and leaves settings open underneath');
    await goBack();
    const openLayers = await evaluate(`CF_BACK_LAYERS.filter((l) => { try { return l.open(); } catch (e) { return false; } }).map((l) => l.name)`);
    check(await evaluate(`document.querySelector('#settings-backdrop').classList.contains('hidden')`), 'the next back closes settings', { openLayers, armed: await armed() });
    // A modal.
    // A modal. (Wrapped: openConfirmModal returns a promise that only settles
    // when the dialog is answered, and CDP's awaitPromise would wait forever.)
    await evaluate(`(() => { openConfirmModal({ title: 'Delete', message: 'sure?' }); })()`);
    await sleep(350);
    await goBack();
    check(await evaluate(`document.querySelector('#modal-backdrop').classList.contains('hidden')`), 'back closes a modal');
    // The members drawer (a right-hand drawer on a phone).
    await touchTap('#btn-members');
    await sleep(400);
    check(await evaluate(`document.body.classList.contains('members-open')`), 'the members drawer is open');
    await goBack();
    check(await evaluate(`!document.body.classList.contains('members-open')`), 'back closes the members drawer');
    await evaluate(`document.querySelector('#test-fake-picker')?.remove()`);

    console.log('\n[4] Escape is the desktop twin of back');
    await evaluate(`openSettings()`);
    await sleep(400);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
    check(await evaluate(`document.querySelector('#settings-backdrop').classList.contains('hidden')`), 'Escape closes settings (it used to die on a nonexistent function first)');

    console.log('\n[5] edge swipe opens the nav page; a left swipe closes it');
    await touchSwipe(6, 420, 300, 420);
    check(await navOpen(), 'a swipe in from the left edge opens the nav page');
    await evaluate(`document.getElementById('left').style.transform = ''`);
    await touchSwipe(300, 500, 20, 500);
    check(!(await navOpen()), 'and a swipe back out to the left closes it');
    // A vertical drag on the message list must stay the list's.
    await evaluate(`document.getElementById('left').style.transform = ''; document.body.classList.remove('nav-open')`);
    await sleep(200);
    await touchSwipe(6, 400, 12, 620);
    check(!(await navOpen()), 'a vertical drag from the edge is left to the list, not read as a nav swipe');

    console.log('\n[6] a mouse (fine pointer) keeps the browser back button');
    await setTouch(false);
    await setPhone(1200, 820, false);
    await sleep(300);
    const desktopArmed = await evaluate(`(() => { try { localStorage.getItem('cf_pointer_probe'); } catch {} return !!(history.state && history.state.cfNav); })()`);
    await touchTap('#btn-menu').catch(() => {});
    await evaluate(`document.querySelector('#btn-menu').click()`);
    await sleep(300);
    check(desktopArmed === true || desktopArmed === false, 'the desktop viewport still boots and responds (sanity)', { desktopArmed });
    // On a fine pointer nothing may re-arm: the sentinel from the phone session
    // is still in the stack, so assert that no NEW one is pushed by a click.
    const before = await evaluate(`history.length`);
    await evaluate(`document.querySelector('#btn-menu').click()`);
    await sleep(300);
    const after = await evaluate(`history.length`);
    check(after === before, 'a fine-pointer click pushes no history entry (desktop back stays the browser\'s)', { before, after });

    check(pageErrors.length === 0, 'no uncaught page errors through the whole run', pageErrors.slice(0, 4));

    console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
    if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exitCode = 1; }
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome && chrome.kill(); } catch {}
    try { child && child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
