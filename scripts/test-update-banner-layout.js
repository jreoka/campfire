// The deploy banner's LAYOUT, measured in a real browser.
//
// `scripts/test-update-banner.js` pins the behaviour (nothing reloads itself).
// This pins the integration: the strip is a fixed bar at the top of the shell, so
// the one thing it must never do is cover a header. It pays for its own height —
// `body.ub-open` sets `--ub-h` and every full-height surface below moves its
// safe-area padding down by exactly that — so the whole design rests on one
// number being right at every width. If the strip's real height ever drifts from
// --ub-h (a bigger button, different padding, a wrapped sub-line) the app's top
// row would be clipped by exactly the difference, and that is what this measures.
//
// The REAL markup out of index.html is laid out by the REAL stylesheet, offline
// (a file:// page with a small harness). Skips without Chrome/Edge.
//
//   node scripts/test-update-banner-layout.js
//   node scripts/test-update-banner-layout.js --shot out.png   # eyeball it too
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SHOT = (() => {
  const i = process.argv.indexOf('--shot');
  return i >= 0 ? process.argv[i + 1] : null;
})();
// Screenshot shaping, for eyeballing a specific case: --w 390 --h 844 --call
function argNum(flag, dflt) {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

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

const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

// The real banner markup, verbatim. It holds no nested <div>, so its own closing
// tag is the first one after it.
function bannerBlock() {
  const at = index.indexOf('id="update-banner"');
  if (at < 0) return null;
  const start = index.lastIndexOf('<div', at);
  const end = index.indexOf('</div>', at);
  return start < 0 || end < 0 ? null : index.slice(start, end + 6);
}
const banner = bannerBlock();

// ---------- offline checks ----------
console.log('\n[1] the strip owns its height, in one place');
check(/#update-banner\{[^}]*position:fixed;top:0;left:0;right:0/.test(css),
  'the banner is pinned across the very top of the viewport');
check(/body\.ub-open\{--ub-h:3rem\}/.test(css), '--ub-h is 3rem (the strip\'s height below the inset)');
check(/#update-banner\{[^}]*height:calc\(3rem \+ var\(--safe-t\)\)/.test(css),
  'the strip DECLARES that height (plus the inset) instead of deriving it from its content');
check(/#update-banner\{[^}]*padding:var\(--safe-t\) /.test(css),
  'so it carries the top safe-area inset itself — a notch is paid once, not twice');
check(/#update-banner \.ub-text\{[^}]*overflow:hidden/.test(css),
  'and anything that could outgrow the strip is clipped inside it rather than growing it');
check(/body\.ub-open #app\b/.test(css) === false, '#app is not the thing that moves (its fixed children would not follow)');
for (const sel of ['#view-main', '#view-auth', '#left', '#members', '#vo-view', '#story-view', '#story-compose', '#sc-pick']) {
  check(css.includes('body.ub-open ' + sel), `body.ub-open moves ${sel} out of the way`);
}
check(/@media \(max-width:820px\),\(max-height:560px\) and \(pointer:coarse\)\{[\s\S]{0,400}body\.ub-open #settings-backdrop/.test(css),
  'and the phone full-height backdrops pay for it in the phone layout only');
check(/#update-banner\{[^}]*animation:cf-drop \.24s var\(--ease-native\)/.test(css),
  'the strip slides down on the app\'s native decelerating curve');
check(/@keyframes cf-drop\{from\{opacity:0;transform:translateY\(-100%\)\}to\{opacity:1;transform:none\}\}/.test(css),
  'from above, settling at rest — a drop, not a fade-in-place');
check(/#update-banner,?[^}]*animation:none/.test(css.replace(/\n/g, ' ')) || /#toast,#jump-present,#update-banner/.test(css),
  'and it is in the reduced-motion list (no animation when motion is off)');

// ---------- headless Chrome, over CDP ----------
// NOT `--window-size` + `--dump-dom`: Windows will not make a window narrower
// than ~490 CSS px, so a "390px" probe silently laid out at 490 and the phone
// assertions were measuring a width no phone has. Device metrics override makes
// the emulated viewport real, and every case now asserts innerWidth matches what
// was asked for.
const CDP_PORT = 9400 + Math.floor(Math.random() * 500);
let chrome = null, ws = null, msgId = 0;
const pending = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pageHtml() {
  // A realistic slice of the shell: the rail/sidebar/chat three-pane layout plus
  // the auth view, both of which the banner has to coexist with.
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>
  /* Stand-ins for the real panes so the top of each is measurable. */
  #left{display:flex;height:100%}#rail{width:80px}#sidebar{width:268px}
  #view-main{display:flex;height:100%}#chat{flex:1;display:flex;flex-direction:column;min-width:0}
  #banner-probe{position:absolute;left:-9999px;top:0;height:var(--ub-h);width:10px}
</style></head><body>
<div id="app">
  ${banner}
  <div id="banner-probe"></div>
  <section id="view-auth" class="hidden"></section>
  <section id="view-main">
    <div id="left"><nav id="rail"></nav><aside id="sidebar"><div id="server-header"><strong>Campfire</strong></div></aside></div>
    <main id="chat"><header id="chat-header"><strong>#general</strong></header><div id="messages"></div><div id="composer"></div></main>
  </section>
</div>
<script>
window.__errs = [];
window.addEventListener('error', (e) => window.__errs.push(String((e && e.message) || e)));
// What paintUpdateBanner() does when a release is ready.
if (new URLSearchParams(location.search).get('on') !== '0') {
  document.getElementById('update-banner').classList.remove('hidden');
  document.body.classList.add('ub-open');
  document.getElementById('ub-sub').textContent =
    new URLSearchParams(location.search).get('call') === '1'
      ? 'Updating will end your call.'
      : 'A new version of Campfire has rolled out.';
  if (new URLSearchParams(location.search).get('call') === '1') document.getElementById('ub-go').textContent = 'Leave & update';
  // Pin the strip to its SETTLED state: cf-drop slides it in from above, and a
  // headless dump under a virtual clock catches it mid-animation (measured
  // top:-51px, i.e. off-screen). Same reason the sidebar test pins the nav's
  // transform — this is a harness concern, not a layout one. The animation
  // itself is asserted statically in the offline half.
  document.getElementById('update-banner').style.animation = 'none';
}
const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
  return { l:+b.left.toFixed(2), t:+b.top.toFixed(2), r:+b.right.toFixed(2), b:+b.bottom.toFixed(2), w:+b.width.toFixed(2), h:+b.height.toFixed(2) }; };
const hits = (x, y, sel) => { const el = document.elementFromPoint(x, y); return !!(el && el.closest && el.closest(sel)); };
window.__report = function () {
  const els = {
    banner: document.getElementById('update-banner'), probe: document.getElementById('banner-probe'),
    view: document.getElementById('view-main'), header: document.getElementById('chat-header'),
    rail: document.getElementById('rail'), sidebar: document.getElementById('sidebar'),
    left: document.getElementById('left'), go: document.getElementById('ub-go'), x: document.getElementById('ub-x'),
    text: document.querySelector('#update-banner .ub-text'), sub: document.getElementById('ub-sub'),
  };
  const missing = Object.keys(els).filter((k) => !els[k]);
  if (missing.length) return { fatal: 'missing elements: ' + missing.join(',') };
  const b = box(els.banner), probe = box(els.probe);
  if (!b || !probe) return { fatal: 'banner did not lay out' };
  const cx = (box(els.go).l + box(els.go).r) / 2, cy = (box(els.go).t + box(els.go).b) / 2;
  const xx = (box(els.x).l + box(els.x).r) / 2, xy = (box(els.x).t + box(els.x).b) / 2;
  return {
    vw: innerWidth, vh: innerHeight,
    banner: b, ubh: probe.h,
    view: box(els.view), viewPadTop: parseFloat(getComputedStyle(els.view).paddingTop),
    header: box(els.header), rail: box(els.rail), sidebar: box(els.sidebar), left: box(els.left),
    go: box(els.go), x: box(els.x), text: box(els.text), sub: box(els.sub),
    subScrolls: els.sub.scrollWidth - els.sub.clientWidth,
    subWraps: box(els.sub).h > parseFloat(getComputedStyle(els.sub).fontSize) * 1.6,
    zIndex: getComputedStyle(els.banner).zIndex,
    // Everything in the shell must start at or below the strip's bottom edge.
    headerClear: box(els.header).t >= b.b - 0.5,
    leftClear: box(els.left).t >= b.b - 0.5,
    railClear: box(els.rail).t >= b.b - 0.5,
    sidebarClear: box(els.sidebar).t >= b.b - 0.5,
    goHit: hits(cx, cy, '#ub-go'), xHit: hits(xx, xy, '#ub-x'),
    goInside: box(els.go).r <= b.r + 0.5 && box(els.go).l >= b.l - 0.5,
    textInside: box(els.text).r <= box(els.go).l + 0.5,
    errs: window.__errs.slice(),
  };
};
setTimeout(() => {
  try { document.title = JSON.stringify(window.__report()); }
  catch (e) { document.title = JSON.stringify({ fatal: (e && e.message) || String(e) }); }
}, 400);
</script>
</body></html>`;
}

// The report is computed in-page by the harness script above; this just asks for
// it once the page has settled.
function readReport(evaluate) {
  return evaluate('JSON.stringify(window.__report())').then((s) => JSON.parse(s));
}

async function startChrome() {
  const { spawn } = require('child_process');
  const os = require('os');
  const crypto = require('node:crypto');
  const WebSocket = require('ws');
  const profile = path.join(os.tmpdir(), 'cf-ub-cdp-' + crypto.randomBytes(4).toString('hex'));
  chrome = spawn(findChrome(), [
    '--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
    '--hide-scrollbars', '--window-size=1400,1000', 'about:blank',
  ], { stdio: 'ignore' });
  let ver = null;
  for (let i = 0; i < 80 && !ver; i++) {
    try { ver = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); } catch {}
    if (!ver) await sleep(250);
  }
  if (!ver) throw new Error('Chrome did not expose the DevTools port');
  const target = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
    }
  });
  await send('Page.enable');
  await send('Runtime.enable');
  return { profile, WebSocket };
}

function send(method, params = {}) {
  return new Promise((res, rej) => {
    const i = ++msgId;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function probe(html, { width, height, dpr = 2, mobile = false, on = true, call = false, shot }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-ub-'));
  const file = path.join(dir, 'page.html');
  fs.writeFileSync(file, html);
  const url = 'file:///' + file.replace(/\\/g, '/') + '?on=' + (on ? '1' : '0') + '&call=' + (call ? '1' : '0');
  try {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
    if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Page.navigate', { url });
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      try { if (await evaluate('!!window.__report && document.readyState === "complete"')) break; } catch {}
    }
    const report = await readReport(evaluate);
    report.requestedW = width;
    report.requestedH = height;
    if (shot) {
      const png = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(shot, Buffer.from(png.data, 'base64'));
      console.log(`  .... screenshot written to ${shot}`);
    }
    return report;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function stopChrome() {
  try { ws && ws.close(); } catch {}
  try { chrome && chrome.kill(); } catch {}
}

function chromeHalf() {
  if (!findChrome()) return skip('no Chrome/Edge found (set CHROME_PATH)');
  if (!banner) return skip('could not extract #update-banner from index.html');
  const html = pageHtml();
  const main = async () => {
    await startChrome();

    if (SHOT) {
      await probe(html, {
        width: argNum('--w', 1100), height: argNum('--h', 700), dpr: argNum('--dpr', 2),
        mobile: process.argv.includes('--mobile'), call: process.argv.includes('--call'), shot: SHOT,
      });
      console.log('\nall ' + passed + ' checks passed (offline half + a screenshot)');
      return;
    }

    console.log('\n[2] desktop (1100x700): the strip is exactly as tall as the shell gives up');
    const desk = await probe(html, { width: 1100, height: 700, dpr: 2 });
    if (desk.fatal) throw new Error('page reported: ' + desk.fatal);
    check(desk.vw === 1100, 'the probe really runs at 1100px', { vw: desk.vw });
    check(desk.errs.length === 0, 'the page threw nothing', desk.errs.slice(0, 2));
    check(Math.abs(desk.banner.h - desk.ubh) <= 0.5,
      'the strip\'s real height equals --ub-h (the whole layout rests on this)',
      { height: desk.banner.h, ubh: desk.ubh });
    check(Math.abs(desk.banner.h - 48) <= 1, 'which is the 48px the comment claims', { h: desk.banner.h });
    check(desk.banner.t === 0 && desk.banner.h > 0 && desk.banner.l === 0 && desk.banner.r >= desk.vw - 1 && desk.banner.r <= desk.vw + 1,
      'and it spans the viewport from the very top', { banner: desk.banner, vw: desk.vw });
    check(desk.headerClear, 'the chat header starts BELOW the strip, not under it', { header: desk.header, banner: desk.banner });
    check(desk.railClear && desk.sidebarClear, 'so do the rail and the sidebar',
      { rail: desk.rail, sidebar: desk.sidebar, banner: desk.banner });
    check(Math.abs(desk.viewPadTop - desk.banner.h) <= 0.5,
      'because #view-main pays exactly that much padding', { padTop: desk.viewPadTop, banner: desk.banner.h });
    check(desk.zIndex === '600', 'the strip sits above the app chrome', { z: desk.zIndex });
    check(desk.goHit && desk.xHit, 'the Update button and the ✕ are both hittable at their centres',
      { go: desk.goHit, x: desk.xHit });
    check(desk.goInside && desk.textInside, 'nothing overflows the strip: the button is inside and the text stops short of it',
      { go: desk.go, text: desk.text, banner: desk.banner });
    check(desk.subScrolls <= 1 && !desk.subWraps, 'the sub-line stays on one line at desktop width', { over: desk.subScrolls, h: desk.sub.h });
    check(desk.go.h >= 30 && desk.x.w >= 28, 'the controls keep a real size', { go: desk.go.h, x: desk.x.w });

    console.log('\n[3] phone portrait (390x844): one line, nothing pushed off screen');
    const phone = await probe(html, { width: 390, height: 844, dpr: 3, mobile: true });
    if (phone.fatal) throw new Error('page reported: ' + phone.fatal);
    check(phone.vw === 390, 'the probe really runs at 390px (not the ~490 a Windows window allows)', { vw: phone.vw });
    check(Math.abs(phone.banner.h - phone.ubh) <= 0.5,
      'the height still matches --ub-h in the phone layout (no wrap)', { height: phone.banner.h, ubh: phone.ubh });
    check(phone.headerClear && phone.leftClear, 'the header and the nav page both clear it',
      { header: phone.header, left: phone.left, banner: phone.banner });
    check(phone.goInside, 'the button fits inside the strip', { go: phone.go, banner: phone.banner, vw: phone.vw });
    check(phone.x.r <= phone.vw + 0.5 && phone.x.l >= phone.go.r - 0.5, 'and so does the ✕, to its right',
      { x: phone.x, go: phone.go, vw: phone.vw });
    check(phone.goHit && phone.xHit, 'both controls are thumb-hittable', { go: phone.goHit, x: phone.xHit });
    check(phone.subScrolls <= 1 && !phone.subWraps, 'the copy is a single ellipsised line, never a wrapped one',
      { over: phone.subScrolls, h: phone.sub.h });
    check(phone.go.h >= 30 && phone.x.w >= 26, 'and the controls keep a real size on a phone', { go: phone.go.h, x: phone.x.w });

    console.log('\n[4] phone landscape (844x390, a short touch viewport): still one line');
    const land = await probe(html, { width: 844, height: 390, dpr: 2, mobile: true });
    if (land.fatal) throw new Error('page reported: ' + land.fatal);
    check(land.vw === 844, 'the probe runs at the requested landscape width', { vw: land.vw });
    check(Math.abs(land.banner.h - land.ubh) <= 0.5, 'height matches there too', { height: land.banner.h, ubh: land.ubh });
    check(land.headerClear && land.leftClear, 'and the shell clears it', { header: land.header, left: land.left, banner: land.banner });

    console.log('\n[5] in a call (390x844): the longer label still fits');
    const call = await probe(html, { width: 390, height: 844, dpr: 3, mobile: true, call: true });
    if (call.fatal) throw new Error('page reported: ' + call.fatal);
    check(Math.abs(call.banner.h - call.ubh) <= 0.5,
      '"Leave & update" does not grow the strip', { height: call.banner.h, ubh: call.ubh });
    check(call.goInside && call.text.r <= call.go.l + 0.5, 'and the warning line still stops short of the button',
      { go: call.go, text: call.text, banner: call.banner });
    check(call.goHit && call.xHit, 'both controls are still hittable', { go: call.goHit, x: call.xHit });
    check(call.subScrolls <= 1 && !call.subWraps,
      'and the whole warning is READABLE — not ellipsised away, which is the one line where truncation would matter',
      { over: call.subScrolls, h: call.sub.h, w: call.sub.w });
    check(call.headerClear, 'the header is still clear of it', { header: call.header, banner: call.banner });

    console.log('\n[6] a narrow phone (320x568): still inside the strip');
    const tiny = await probe(html, { width: 320, height: 568, dpr: 2, mobile: true, call: true });
    if (tiny.fatal) throw new Error('page reported: ' + tiny.fatal);
    check(tiny.vw === 320, 'the probe really runs at 320px', { vw: tiny.vw });
    check(Math.abs(tiny.banner.h - tiny.ubh) <= 0.5, 'height still matches', { height: tiny.banner.h, ubh: tiny.ubh });
    check(tiny.goInside && tiny.x.r <= tiny.vw + 0.5 && tiny.goHit && tiny.xHit,
      'both controls stay inside and hittable at 320px', { go: tiny.go, x: tiny.x, banner: tiny.banner, vw: tiny.vw });
    check(tiny.headerClear, 'and nothing is clipped behind it', { header: tiny.header, banner: tiny.banner });
  };

  return main().finally(stopChrome);
}

const done = chromeHalf();
Promise.resolve(done).then(() => {
  console.log('\n' + (failures.length ? failures.length + ' FAILED, ' + passed + ' passed' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
  process.exit(0);
}).catch((e) => {
  stopChrome();
  console.error('\n[test] ERROR: ' + ((e && e.message) || e));
  process.exit(1);
});
