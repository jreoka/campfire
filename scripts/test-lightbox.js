// Lightbox: reachable controls, zoom, swipe-down dismissal.
//
// The complaint: on a phone the photo viewer's Download/Close controls sat at
// the very top of a tall photo and could end up off-screen ("way up past the
// top"), and there was no way to zoom or to swipe it away.
//
// This test runs the REAL lightbox block pulled out of public/js/pickers.js
// against the REAL #lightbox markup and styles.css in headless Chrome (skips
// without Chrome), and pins:
//   - the bar is a fixed safe-area row, so both controls stay fully inside the
//     viewport (and hit-testable) for tall, wide and square photos, on phone
//     portrait, phone landscape and desktop;
//   - the photo itself never overflows the stage;
//   - double-tap zooms in and back out, pinch zooms, and panning a zoomed photo
//     moves it without closing;
//   - a downward drag dismisses the viewer; a short drag springs back;
//   - a tap on the backdrop (and the Close button) closes, a tap on the photo
//     does not, and tapping Download does not;
//   - closing and reopening resets the zoom.
//
// Usage: node scripts/test-lightbox.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');

// Pull the real lightbox implementation out of pickers.js.
const lbStart = pickers.indexOf('// ---------- lightbox ----------');
const lbEnd = pickers.indexOf('// ---------- user card action tabs ----------');
if (lbStart < 0 || lbEnd < 0 || lbEnd <= lbStart) { console.error('could not locate the lightbox block in pickers.js'); process.exit(1); }
const lbBlock = pickers.slice(lbStart, lbEnd);
if (!/function openLightbox/.test(lbBlock) || !/lbSlideOut/.test(lbBlock)) { console.error('the extracted lightbox block is incomplete'); process.exit(1); }

function connectWs(url) {
  const WS = globalThis.WebSocket || require('ws');
  const sock = new WS(url, { perMessageDeflate: false });
  const on = (ev, fn) => (typeof sock.addEventListener === 'function' ? sock.addEventListener(ev, fn) : sock.on(ev, fn));
  return { sock, on, send: (s) => sock.send(s), close: () => sock.close() };
}

// The REAL index.html <head> (so styles.css + the lightbox markup are the ones
// under test), the extracted lightbox script, and a small pointer-event shim.
function pageHtml() {
  const head = index.slice(0, index.indexOf('<script src="/embeds.js">'))
    .replace('<link rel="stylesheet" href="/styles.css" />', `<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">`);
  return head + `
<script>
const $ = (s) => document.querySelector(s);
function toast() {}
${lbBlock}
window.__open = openLightbox;
window.__close = closeLightbox;
window.__state = () => ({
  hidden: document.getElementById('lightbox').classList.contains('hidden'),
  scale: lb.scale, tx: lb.tx, ty: lb.ty,
  img: document.getElementById('lightbox-img').getAttribute('src') || '',
});
const pev = (type, id, x, y, target, pointerType) => {
  const el = target || document.elementFromPoint(x, y) || document.body;
  el.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType: pointerType || 'touch', isPrimary: true }));
};
window.__tap = (x, y) => { pev('pointerdown', 1, x, y); pev('pointerup', 1, x, y); };
// A real mouse click: pointerType 'mouse' so the lightbox takes the single-click
// zoom path instead of touch's double-tap one.
window.__mclick = (x, y) => { pev('pointerdown', 1, x, y, null, 'mouse'); pev('pointerup', 1, x, y, null, 'mouse'); };
window.__swipe = (x, y, dy) => {
  pev('pointerdown', 1, x, y);
  for (let i = 1; i <= 6; i++) pev('pointermove', 1, x, y + dy * i / 6);
  pev('pointerup', 1, x, y + dy);
};
window.__pinch = (x1, y1, x2, y2, spread) => {
  pev('pointerdown', 1, x1, y1); pev('pointerdown', 2, x2, y2);
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  const a = { x: cx - spread, y: cy }, b = { x: cx + spread, y: cy };
  pev('pointermove', 1, a.x, a.y); pev('pointermove', 2, b.x, b.y);
  pev('pointerup', 1, a.x, a.y); pev('pointerup', 2, b.x, b.y);
};
window.__box = (sel) => { const el = $(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { l:+r.left.toFixed(1), t:+r.top.toFixed(1), r:+r.right.toFixed(1), b:+r.bottom.toFixed(1), w:+r.width.toFixed(1), h:+r.height.toFixed(1) }; };
window.__imgSrc = (w, h) => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><rect width="100%" height="100%" fill="#33507a"/></svg>';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
};
window.__geo = () => {
  const l = $( '#lightbox' ), img = $('#lightbox-img'), stage = $('#lb-stage');
  const rimg = img.getBoundingClientRect();
  return {
    vw: innerWidth, vh: innerHeight,
    bar: __box('#lb-bar'), dl: __box('#lightbox-dl'), close: __box('#lightbox-close'), stage: __box('#lb-stage'),
    img: { l:+rimg.left.toFixed(1), t:+rimg.top.toFixed(1), r:+rimg.right.toFixed(1), b:+rimg.bottom.toFixed(1) },
    lbTouch: getComputedStyle(l).touchAction, barTop: getComputedStyle($('#lb-bar')).top,
    hitDl: (() => { const r = $('#lightbox-dl').getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2); return !!t && $('#lightbox-dl').contains(t); })(),
    hitClose: (() => { const r = $('#lightbox-close').getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2); return !!t && $('#lightbox-close').contains(t); })(),
    style: { transform: img.style.transform, rootTransform: l.style.transform, rootOpacity: l.style.opacity },
  };
};
</script></body></html>`;
}

async function withChrome(fn) {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found — set CHROME_PATH');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-lb-'));
  const port = 9700 + Math.floor(Math.random() * 200);
  fs.writeFileSync(path.join(tmp, 'page.html'), pageHtml());
  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(tmp, 'prof')}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });
  let ver = null;
  for (let i = 0; i < 80 && !ver; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch {}
    if (!ver) await sleep(250);
  }
  if (!ver) { try { chrome.kill(); } catch {} return skip('Chrome did not expose the DevTools port'); }
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const { on, send, close } = connectWs(target.webSocketDebuggerUrl);
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
  const evaluate = async (expression) => {
    const r = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const device = async (w, h, { touch = true } = {}) => {
    await rpc('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
    await rpc('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: touch });
    await sleep(300);
  };
  try {
    await rpc('Page.enable');
    await rpc('Runtime.enable');
    await rpc('Page.navigate', { url: 'file:///' + path.join(tmp, 'page.html').replace(/\\/g, '/') });
    await sleep(900);
    return await fn({ device, evaluate, tmp });
  } finally {
    try { close(); } catch {}
    try { chrome.kill(); } catch {}
    await sleep(200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

const inside = (r, vw, vh, slack = 1) => r && r.l >= -slack && r.t >= -slack && r.r <= vw + slack && r.b <= vh + slack;

function staticChecks() {
  console.log('\n[1] the controls live in a fixed safe-area bar');
  check(/#lb-bar\{position:absolute;top:calc\(\.6rem \+ var\(--safe-t\)\)/.test(css), 'the bar is pinned to the safe-area top');
  check(/#lightbox\{position:fixed;inset:0;background:rgba\(3,5,10,\.94\);z-index:200;overflow:hidden;touch-action:none/.test(css), 'the overlay is fixed, clipped and owns its gestures');
  check(/\.lb-close\{padding:0;width:40px/.test(css), 'the close control is a square 40px target');
  check(/id="lightbox-close"/.test(index) && /id="lb-bar"/.test(index) && /id="lb-stage"/.test(index), 'the markup carries stage, bar, download and close');
  check(/function closeLightbox\(\)/.test(pickers) && /window.addEventListener\('pointerup', lbPointerUp\)/.test(pickers), 'the overlay is driven by pointer events (pinch/swipe capable)');
  // The old bug: no close button at all, and a bare absolute anchor with no
  // safe-area inset.
  check(!/#lightbox-dl\{position:absolute;top:1rem;right:1rem/.test(css), 'the old unsafetied corner anchor is gone');
}

async function main() {
  staticChecks();
  await withChrome(async ({ device, evaluate }) => {
    const open = async (w, h) => {
      await evaluate(`__open(__imgSrc(${w},${h}), 'photo.png')`);
      await sleep(280);
      return evaluate('__geo()');
    };
    const state = () => evaluate('__state()');

    console.log('\n[2] every control is reachable for tall / wide / square photos');
    await device(390, 844);
    for (const [w, h] of [[1200, 4000], [4000, 1200], [800, 800], [1170, 2100]]) {
      const g = await open(w, h);
      const tag = `390x844 ${w}x${h}`;
      check(inside(g.dl, g.vw, g.vh) && g.hitDl, `${tag}: Download is on screen and hit-testable`, g.dl);
      check(inside(g.close, g.vw, g.vh) && g.hitClose, `${tag}: Close is on screen and hit-testable`, g.close);
      check(inside(g.img, g.vw, g.vh), `${tag}: the photo stays inside the viewport`, g.img);
      check(g.img.t >= g.bar.b - 1, `${tag}: the photo starts below the control bar`, { img: g.img, bar: g.bar });
      check(g.lbTouch === 'none', `${tag}: the overlay owns touch gestures`, g.lbTouch);
    }

    console.log('\n[3] landscape and desktop keep them reachable too');
    for (const [vw, vh, touch] of [[852, 393, true], [667, 375, true], [1280, 800, false]]) {
      await device(vw, vh, { touch });
      const g = await open(1600, 2400);
      const tag = `${vw}x${vh}`;
      check(inside(g.dl, g.vw, g.vh) && g.hitDl, `${tag}: Download is reachable`, g.dl);
      check(inside(g.close, g.vw, g.vh) && g.hitClose, `${tag}: Close is reachable`, g.close);
      check(inside(g.img, g.vw, g.vh), `${tag}: the photo fits`, g.img);
    }

    console.log('\n[4] zoom: double-tap, pinch, and pan');
    await device(390, 844);
    const g0 = await open(1200, 4000);
    const centerX = g0.img.l + (g0.img.r - g0.img.l) / 2;
    const centerY = g0.img.t + (g0.img.b - g0.img.t) / 2;
    await evaluate(`__tap(${centerX}, ${centerY}); __tap(${centerX}, ${centerY})`);
    await sleep(80);
    let s = await state();
    check(s.scale > 1.5, 'double-tap zooms the photo in', s);
    check(/scale\(/.test((await evaluate('__geo()')).style.transform), 'the zoom is painted as a transform');
    // A short drag on a zoomed photo pans it and must not close the viewer.
    const before = s.ty;
    await evaluate(`__swipe(${centerX}, ${centerY}, 60)`);
    await sleep(60);
    s = await state();
    check(!s.hidden, 'panning a zoomed photo does not close the viewer');
    check(s.ty !== before, 'panning moves the photo', { before, after: s.ty });
    // Double-tap again resets.
    await evaluate(`__tap(${centerX}, ${centerY}); __tap(${centerX}, ${centerY})`);
    await sleep(80);
    s = await state();
    check(s.scale === 1 && s.tx === 0 && s.ty === 0, 'double-tap again resets the zoom', s);
    // A mouse zooms on a SINGLE click (click to zoom in, click again to zoom
    // out) — the touch double-tap above is deliberately not required there.
    await evaluate(`__mclick(${centerX}, ${centerY})`);
    await sleep(60);
    s = await state();
    check(s.scale > 1.5, 'one mouse click zooms in', s);
    await evaluate(`__mclick(${centerX}, ${centerY})`);
    await sleep(60);
    s = await state();
    check(s.scale === 1 && s.tx === 0 && s.ty === 0, 'a second mouse click zooms back out', s);
    // Pinch out zooms.
    await evaluate(`__pinch(180, 420, 210, 420, 70)`);
    await sleep(60);
    s = await state();
    check(s.scale > 1.5, 'pinch zooms the photo', s);

    console.log('\n[5] dismissal: swipe down, short drag springs back, taps');
    await open(800, 800);
    await evaluate('__swipe(195, 380, 180)');
    await sleep(320);
    check((await state()).hidden === true, 'dragging down past the threshold closes the viewer');

    await open(800, 800);
    await evaluate('__swipe(195, 380, 40)');
    await sleep(260);
    let st = await state();
    check(st.hidden === false, 'a short drag springs back instead of closing', st);
    check(st.tx === 0 && st.ty === 0, 'the spring-back leaves no leftover offset', st);

    // A tap on the photo does nothing (double-tap needs the first tap to land).
    await evaluate('__tap(195, 420)');
    await sleep(40);
    check((await state()).hidden === false, 'a single tap on the photo does not close it');
    // A tap on the backdrop closes.
    await evaluate('__tap(6, 420)');
    await sleep(40);
    check((await state()).hidden === true, 'a tap on the backdrop closes the viewer');

    // The Close button closes (a real tap synthesizes a click after the
    // pointer sequence, so drive the real click handler).
    await open(800, 800);
    await evaluate("document.getElementById('lightbox-close').click()");
    await sleep(40);
    check((await state()).hidden === true, 'the Close button closes the viewer');

    // Tapping Download must not close it (the anchor handles the download and
    // stops the click from reaching the overlay).
    await open(800, 800);
    const gd = await evaluate('__geo()');
    await evaluate(`__tap(${(gd.dl.l + gd.dl.r) / 2}, ${(gd.dl.t + gd.dl.b) / 2}); document.getElementById('lightbox-dl').click()`);
    await sleep(40);
    check((await state()).hidden === false, 'tapping Download keeps the viewer open');

    console.log('\n[6] reopening resets the zoom');
    await open(1200, 4000);
    await evaluate('__tap(195, 420); __tap(195, 420)');
    await sleep(60);
    check((await state()).scale > 1.5, 'zoomed before closing');
    await evaluate('__close()');
    await sleep(30);
    const reopened = await open(800, 800);
    const rs = await state();
    check(rs.hidden === false && rs.scale === 1 && rs.tx === 0 && rs.ty === 0, 'a reopened viewer starts unzoomed', rs);
    check((reopened.img.b - reopened.img.t) <= (reopened.stage.b - reopened.stage.t) + 1, 'the reopened photo fits the stage', reopened.img);
  });

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
