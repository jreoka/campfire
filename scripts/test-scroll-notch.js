// One notch of the wheel must scroll up — and STAY there.
//
// The complaint: sitting at the bottom of a conversation whose newest message is
// an image, one notch of the wheel flicks the view straight back down to the
// bottom. It never moves.
//
// The cause was the pin ("the reader is on the live bottom", dataset.atBottom)
// being sticky in the wrong direction. A reader's own upward movement only
// demoted the pin once they were more than 200px from the bottom — and one
// wheel notch is ~100–120px — so after a notch they were still "pinned". The
// next thing that resized anything they were watching (a lazy picture landing
// above, the stick ResizeObserver on the scrollport or on any attachment) then
// followed the tail by putting them back at the bottom. They could never get
// more than a notch away, so they could never leave: exactly the reported
// "flicks me back down". A repaint could do the same, because the render paths
// let the same 200px band overrule an explicit demotion.
//
// This drives the REAL code out of public/js/messages.js in a REAL browser: the
// slices are extracted verbatim and evaluated against the real stylesheet and a
// hand-built chat DOM, and the wheel is a real wheel (Input.dispatchMouseEvent
// over the DevTools protocol — a synthetic `new WheelEvent` scrolls nothing).
// Every setScrollTop the code makes is logged with its caller, so a re-pin
// names its own culprit.
//
// Offline: no server, no database. Only Chrome is required (skips without it).
//
// Usage: node scripts/test-scroll-notch.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.env.TEST_PORT || '3431', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9351', 10);
const BOX_H = 620;          // the scrollport's height
const NOTCH = 120;          // one wheel notch, in px (Chrome's default is 100-120)

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

// ---------- the real code, sliced out of messages.js ----------
const messagesSrc = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
function slice(start, end) {
  const a = messagesSrc.indexOf(start), b = messagesSrc.indexOf(end);
  if (a < 0 || b < 0 || b <= a) throw new Error('cannot slice messages.js: ' + start);
  return messagesSrc.slice(a, b);
}
// stick state + the bottom-state flag + watcher + stick ResizeObserver
const WATCHER = slice('let stickRO = null;', 'function reactionNameFor(uid) {');
// the bottom hold (anchorBottom)
const HOLD = slice('function anchorBottom(box) {', '// Anchor-based scroll preservation for full list rebuilds.');

// ---------- the page under test ----------
const HARNESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>scroll harness</title>
<link rel="stylesheet" href="/styles.css">
<style>
  :root{--strip-h:20px;--composer-h:60px;--safe-b:0px;--safe-t:0px}
  html,body{height:100%;margin:0}
  #chat{height:${BOX_H}px;display:flex;flex-direction:column}
  #messages{flex:1;min-height:0}
  #composer{flex:0 0 auto;height:70px}
</style></head>
<body>
<main id="chat">
  <header id="chat-header"><strong>#scroll-test</strong></header>
  <div id="messages"></div>
  <button id="jump-present" class="hidden"><span id="jp-text"></span><span class="jp-go">&darr;</span></button>
  <div id="composer"><div id="composer-box"><textarea id="in-message"></textarea></div></div>
</main>
<script>
// The globals the sliced code touches. updatePill mirrors pins.js's own (the
// real one only toggles the pill, so the geometry is what matters).
window.S = { view: 'server', channelId: 'c1', dmThreadId: null, histNew: 0, histMode: null };
window.updatePill = function () {
  const pill = document.getElementById('jump-present'), box = document.getElementById('messages');
  if (!pill || !box) return;
  const dist = box.scrollHeight - box.scrollTop - box.clientHeight;
  pill.classList.toggle('hidden', !(dist > 400));
};
</script>
<script src="/watcher.js"></script>
<script src="/hold.js"></script>
<script src="/driver.js"></script>
</body></html>`;

const DRIVER_JS = `(() => {
  const BOX = document.getElementById('messages');
  window.__log = [];      // every setScrollTop the app code makes
  window.__samples = [];  // { t, top, at } per frame
  const origSet = setScrollTop;
  setScrollTop = function (box, v, intent) {
    let stack = '';
    try { stack = (new Error().stack || '').split('\\n').slice(2, 4).map(s => s.trim()).join(' <- '); } catch {}
    window.__log.push({ t: Math.round(performance.now()), v: v, intent: intent, at: box.dataset.atBottom, top: box.scrollTop, stack: stack });
    return origSet(box, v, intent);
  };

  // Pictures land when the harness says so: a src that never resolves until
  // __landImage swaps it in reproduces "late media grew above the reader".
  function msg(i, withImg, opts) {
    const d = document.createElement('div');
    d.className = 'msg';
    d.dataset.mid = 'm' + i;
    let h = '<div class="msg-body"><div class="msg-head"><b>someone</b><span class="msg-time">12:0' + (i % 10) + '</span></div>';
    h += '<div class="text">message number ' + i + ' ' + 'lorem ipsum dolor sit amet '.repeat(2) + '</div>';
    if (withImg) {
      h += '<div class="msg-atts"><span class="att-wrap' + (opts.dims ? ' ar' : ' no-ar') + '"'
        + (opts.dims ? ' style="--att-ar:1.3333;width:min(400px,100%,420px,calc(var(--att-max-h,320px) * 1.3333))"' : '')
        + '><span class="att-ph" aria-hidden="true"><span class="att-spin"></span></span>'
        + '<img class="att-img" id="img' + i + '" src="' + opts.src + '" alt="pic" loading="lazy" decoding="async"'
        + (opts.dims ? ' width="400" height="300"' : '') + ' /></span></div>';
    }
    h += '</div>';
    d.innerHTML = h;
    BOX.appendChild(d);
    return d;
  }
  window.__build = function (opts) {
    BOX.innerHTML = '';
    for (let i = 1; i <= opts.count; i++) msg(i, opts.images && i % opts.every === 0, opts);
    // Real rendering wires every attachment picture through observeStick.
    BOX.querySelectorAll('img.att-img').forEach((img) => observeStick(img));
    return BOX.querySelectorAll('.msg').length;
  };
  // The steady state of a live conversation: at the bottom, watcher armed.
  window.__arm = function () {
    setScrollTop(BOX, BOX.scrollHeight, '1');
    watchBottomState(BOX);
    return BOX.dataset.atBottom;
  };
  window.__armHold = function () { anchorBottom(BOX); return BOX.dataset.atBottom; };
  window.__reset = function () { window.__log = []; window.__samples = []; };
  window.__geom = function () {
    return { top: Math.round(BOX.scrollTop * 10) / 10, sh: BOX.scrollHeight, ch: BOX.clientHeight,
             at: BOX.dataset.atBottom, max: BOX.scrollHeight - BOX.clientHeight };
  };
  window.__near = function () { try { return nearLiveBottom(BOX, true); } catch (e) { return null; } };
  window.__sample = function (ms) {
    return new Promise((res) => {
      const t0 = performance.now();
      const tick = () => {
        window.__samples.push({ t: Math.round(performance.now() - t0), top: Math.round(BOX.scrollTop), at: BOX.dataset.atBottom,
                                dist: Math.round(BOX.scrollHeight - BOX.scrollTop - BOX.clientHeight) });
        if (performance.now() - t0 < ms) requestAnimationFrame(tick); else res(window.__samples);
      };
      requestAnimationFrame(tick);
    });
  };
  window.__landImage = function (id) {
    const img = document.getElementById(id);
    if (!img) return false;
    img.src = '/pic.svg';
    return true;
  };  window.__strayScrollUp = function (px) { BOX.scrollTop = Math.max(0, BOX.scrollTop - px); };
  window.__ready = true;
})();`;

const IMG = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#334"/></svg>';

function serve() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (type, body) => { try { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); } catch {} };
    if (u.pathname === '/harness.html') return send('text/html', HARNESS_HTML);
    if (u.pathname === '/watcher.js') return send('application/javascript', WATCHER);
    if (u.pathname === '/hold.js') return send('application/javascript', HOLD);
    if (u.pathname === '/driver.js') return send('application/javascript', DRIVER_JS);
    if (u.pathname === '/styles.css') return send('text/css', fs.readFileSync(path.join(ROOT, 'public/styles.css')));
    if (u.pathname === '/pic.svg') {
      // `?d=` holds the bytes back: a picture that is in the DOM but has not
      // landed yet. __landImage swaps the src to the plain URL to land it.
      const delay = parseInt(u.searchParams.get('d') || '0', 10);
      if (!delay) return send('image/svg+xml', IMG);
      return setTimeout(() => send('image/svg+xml', IMG), delay);
    }
    res.writeHead(404); res.end('nope');
  });
  server.closeAllConnections = server.closeAllConnections || (() => {});
  return new Promise((res) => server.listen(PORT, '127.0.0.1', () => res(server)));
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  const server = await serve();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-notch-'));
  let chrome = null, ws = null;
  try {
    chrome = spawn(chromePath, [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(tmp, 'chrome')}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
      '--window-size=900,900', 'about:blank',
    ], { stdio: 'ignore' });
    let ver = null;
    for (let i = 0; i < 80 && !ver; i++) {
      try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch {}
      if (!ver) await sleep(250);
    }
    if (!ver) throw new Error('Chrome did not expose the DevTools port');

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
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        pageErrors.push((m.params.args || []).map((a) => a.value || a.description).join(' '));
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
    const waitFor = async (expr, ms = 15000) => {
      const t0 = Date.now();
      for (;;) {
        try { const v = await evaluate(`(() => { try { return ${expr} } catch (e) { return false } })()`); if (v) return v; } catch {}
        if (Date.now() - t0 > ms) return null;
        await sleep(100);
      }
    };
    // One real wheel notch over the middle of the scrollport.
    const wheel = async (deltaY) => {
      const r = await evaluate(`(() => { const b = document.getElementById('messages').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'none', buttons: 0 });
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: r.x, y: r.y, deltaX: 0, deltaY: deltaY, button: 'none', buttons: 0 });
    };
    const wheelUp = () => wheel(-NOTCH);
    const wheelDown = () => wheel(NOTCH);
    // The shallower the reader ever got to the bottom, the more of a yank a
    // re-pin was: a flick shows up as a sample sitting on dist 0.
    const closest = (arr) => arr.reduce((m, p) => Math.min(m, p.dist), Infinity);

    await send('Page.enable');
    await send('Runtime.enable');
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/harness.html'`);
    check(!!(await waitFor('window.__ready === true')), 'the harness page loads the real scroll code');

    // ---------------------------------------------------------------------
    console.log('\n[1] a plain list: one notch up is left alone');
    await evaluate(`__build({ count: 40, images: false })`);
    await evaluate(`__arm()`);
    await evaluate(`__reset()`);
    await wheelUp();
    await evaluate(`__sample(700)`);
    let s = await evaluate(`__samples`);
    let g = await evaluate(`__geom()`);
    check(g.max - g.top > 50, 'one notch up moved the view up', { top: g.top, max: g.max });
    check(g.at === '0', 'the pin was demoted by the reader\'s own upward move', { at: g.at });
    check(closest(s) > 50, 'and the view was never returned to the bottom', { closest: closest(s) });

    // ---------------------------------------------------------------------
    console.log('\n[2] the newest message is a picture');
    await evaluate(`__build({ count: 40, images: true, every: 8, dims: true, src: '/pic.svg' })`);
    await waitFor(`[...document.querySelectorAll('img.att-img')].every((i) => i.complete)`, 8000);
    await sleep(120);
    await evaluate(`__arm()`);
    await evaluate(`__reset()`);
    await wheelUp();
    await evaluate(`__sample(700)`);
    s = await evaluate(`__samples`);
    g = await evaluate(`__geom()`);
    check(g.max - g.top > 50, 'one notch up moved the view up with pictures on screen', { top: g.top, max: g.max });
    check(closest(s) > 50, 'nothing dragged it back to the bottom', { closest: closest(s) });

    // ---------------------------------------------------------------------
    console.log('\n[3] a picture lands while the reader is one notch up (the report)');
    await evaluate(`__build({ count: 40, images: true, every: 8, dims: false, src: '/pic.svg?d=600000' })`);
    await evaluate(`__arm()`);
    await evaluate(`__reset()`);
    await wheelUp();
    await sleep(150);
    await evaluate(`__landImage('img24')`);   // well above the reader
    s = await evaluate(`__sample(900)`);
    g = await evaluate(`__geom()`);
    const log3 = await evaluate(`__log`);
    check(g.max - g.top > 50, 'the reader is still where they scrolled to', { top: g.top, max: g.max, at: g.at });
    check(closest(s) > 50, 'the landing picture did not drag them back to the bottom',
      { closest: closest(s), at: g.at, path: s.map((p) => p.t + ':' + p.dist + '/' + p.at).slice(0, 10),
        log: log3.map((l) => l.t + ' v=' + l.v + ' from=' + l.top + ' at=' + l.at + ' ' + l.stack.split(' <- ')[0]) });

    // ---------------------------------------------------------------------
    console.log('\n[4] …even when the picture lands in the same frame as the wheel');
    await evaluate(`__build({ count: 40, images: true, every: 8, dims: false, src: '/pic.svg?d=600000' })`);
    await evaluate(`__arm()`);
    await evaluate(`__reset()`);
    await wheelUp();
    await evaluate(`__landImage('img24')`);   // no await between: same task
    s = await evaluate(`__sample(900)`);
    g = await evaluate(`__geom()`);
    check(g.max - g.top > 50 && closest(s) > 50, 'the wheel still won the frame',
      { top: g.top, max: g.max, closest: closest(s), at: g.at,
        path: s.map((p) => p.t + ':' + p.dist + '/' + p.at).slice(0, 12),
        log: (await evaluate(`__log`)).map((l) => l.t + ' v=' + l.v + ' from=' + l.top + ' at=' + l.at + ' ' + l.stack.split(' <- ')[0]) });

    // ---------------------------------------------------------------------
    console.log('\n[5] a reader who scrolled back down follows the tail again');
    await wheelDown();
    await evaluate(`__sample(500)`);
    g = await evaluate(`__geom()`);
    check(g.at === '1', 'reaching the bottom re-pins', { top: g.top, max: g.max, at: g.at });
    const near = await evaluate(`__near()`);
    check(near === true, 'the render paths see them as on the live bottom again');
    await evaluate(`__reset()`);
    await evaluate(`__landImage('img16')`);
    await evaluate(`__sample(600)`);
    g = await evaluate(`__geom()`);
    check(Math.abs(g.max - g.top) < 2, 'and a picture landing above keeps them pinned to it',
      { top: g.top, max: g.max, at: g.at });

    // ---------------------------------------------------------------------
    console.log('\n[6] a stray (browser-made) scroll while pinned still holds the bottom');
    // The 05dba94 guarantee: browsers scroll the list for their own reasons, and
    // none of them may strand a pinned reader part way up the history.
    await evaluate(`__build({ count: 40, images: false })`);
    await evaluate(`__arm()`);
    await evaluate(`__reset()`);
    await evaluate(`__strayScrollUp(400)`);   // no input: reload restore / clamp
    await evaluate(`__sample(400)`);
    g = await evaluate(`__geom()`);
    check(Math.abs(g.max - g.top) < 2, 'a pinned reader is pulled back to the bottom', { top: g.top, max: g.max, at: g.at });

    // ---------------------------------------------------------------------
    console.log('\n[7] the bottom hold follows late growth, and the wheel ends it');
    await evaluate(`__build({ count: 40, images: true, every: 8, dims: false, src: '/pic.svg?d=600000' })`);
    await evaluate(`__armHold()`);
    await evaluate(`__reset()`);
    await evaluate(`__landImage('img32')`);
    await evaluate(`__sample(700)`);
    g = await evaluate(`__geom()`);
    check(Math.abs(g.max - g.top) < 2, 'growth inside the hold window keeps the bottom', { top: g.top, max: g.max });
    await evaluate(`__reset()`);
    await wheelUp();
    await sleep(120);
    await evaluate(`__landImage('img24')`);
    s = await evaluate(`__sample(900)`);
    g = await evaluate(`__geom()`);
    check(g.max - g.top > 50 && closest(s) > 50, 'and one notch up ends it for good',
      { top: g.top, max: g.max, closest: closest(s), log: (await evaluate(`__log`)).map((l) => l.v + '@' + l.intent) });

    check(pageErrors.length === 0, 'no uncaught page errors', pageErrors.slice(0, 3));
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome && chrome.kill(); } catch {}
    try { server.closeAllConnections(); server.close(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => '  - ' + f).join('\n')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('[test] crashed:', (e && e.message) || e); process.exit(1); });
