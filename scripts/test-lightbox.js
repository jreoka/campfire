// Lightbox: reachable controls, zoom, swipe-down dismissal, gallery arrows.
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
//   - closing and reopening resets the zoom;
//   - a picture posted with others opens with a back and a next arrow on either
//     side of the screen, the arrows (and the arrow keys, and a sideways swipe)
//     walk the message's PICTURES in order, each end disables its arrow, and a
//     lone picture shows no arrows at all;
//   - a CLIP beside those pictures is not in that set, and there is no video
//     stage in the viewer and no chip on a clip pretending to open one — the
//     behaviour Discord has, where a video plays where it sits by its own
//     controls.
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
const messages = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');

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
  dl: document.getElementById('lightbox-dl').getAttribute('href') || '',
  dlName: document.getElementById('lightbox-dl').getAttribute('download') || '',
  prevHidden: document.getElementById('lb-prev').classList.contains('hidden'),
  nextHidden: document.getElementById('lb-next').classList.contains('hidden'),
  prevOff: document.getElementById('lb-prev').disabled,
  nextOff: document.getElementById('lb-next').disabled,
  index: lb.index, n: lb.items ? lb.items.length : 0,
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
// The same gesture sideways: the gallery's touch twin.
window.__swipeX = (x, y, dx) => {
  pev('pointerdown', 1, x, y);
  for (let i = 1; i <= 6; i++) pev('pointermove', 1, x + dx * i / 6, y);
  pev('pointerup', 1, x + dx, y);
};
// A message's own attachment block, as messages.js renders one: each attachment
// is an .att-slot holding its .att-wrap, its media element and its corner chips.
// The tile paints the derived PREVIEW while data-fb-url is the ORIGINAL, which is
// exactly what the lightbox has to open — so the two are different pictures of
// different sizes, and a viewer showing the wrong one is visible in the state.
window.__pic = (i) => 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="' + (220 + i * 10) + '" height="160"><rect width="100%" height="100%" fill="#33507a"/></svg>');
window.__thumb = (i) => 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><rect width="100%" height="100%" fill="#0c1020"/></svg>');
window.__picSlot = (i) => '<span class="att-slot"><span class="att-wrap" data-fb-name="p' + i + '.png" data-fb-url="' + __pic(i) + '">'
  + '<img class="att-img" src="' + __thumb(i) + '" data-fb-url="' + __pic(i) + '" data-fb-name="p' + i + '.png" />'
  + '<a class="att-dl" href="' + __pic(i) + '" download="p' + i + '.png"></a></span></span>';
window.__clipSlot = () => '<span class="att-slot"><span class="att-wrap" data-fb-name="clip.mp4" data-fb-url="/clip.mp4">'
  + '<video class="att-vid" src="/clip.mp4" data-fb-src="/clip.mp4"></video>'
  + '<a class="att-dl" href="/clip.mp4" download="clip.mp4"></a></span></span>';
window.__gallery = (name, n) => {
  const box = document.createElement('div');
  box.className = 'msg-atts';
  box.id = name;
  let html = '';
  for (let i = 0; i < n; i++) html += __picSlot(i);
  box.innerHTML = html;
  document.body.appendChild(box);
  return true;
};
// A message of pictures AND a clip: the clip is not a picture, so the arrows walk
// the pictures and never land on the player (Discord does the same — a video
// plays where it sits, by its own controls).
window.__galleryWithClip = (name, pics) => {
  const box = document.createElement('div');
  box.className = 'msg-atts';
  box.id = name;
  let html = __picSlot(0) + __clipSlot();
  for (let i = 1; i < pics; i++) html += __picSlot(i);
  box.innerHTML = html;
  document.body.appendChild(box);
  return true;
};
// The entry point the real click handler owns (see pickers.js): a picture opens
// through its own url + download name, with the gallery read off the element the
// pointer was over.
window.__clickMedia = (el) => {
  if (!el || !el.classList.contains('att-img')) return false;
  const g = lbGalleryAt(el);
  if (!g) return false;
  const dl = el.closest('.att-wrap')?.querySelector('.att-dl');
  openLightbox(el.dataset.fbUrl || el.src, dl?.getAttribute('download') || '', g);
  return true;
};
// Click the i-th thing matching sel inside the block called name.
window.__slotIn = (name, sel, i) => {
  const box = document.getElementById(name);
  const list = box ? box.querySelectorAll(sel) : [];
  return list[i || 0] || null;
};
window.__clickIn = (name, sel, i) => __clickMedia(__slotIn(name, sel, i));
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
  const hit = (sel) => { const el = $(sel); if (!el || el.classList.contains('hidden')) return false; const r = el.getBoundingClientRect(); if (!r.width) return false; const t = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2); return !!t && el.contains(t); };
  return {
    vw: innerWidth, vh: innerHeight,
    bar: __box('#lb-bar'), dl: __box('#lightbox-dl'), close: __box('#lightbox-close'), stage: __box('#lb-stage'),
    prev: __box('#lb-prev'), next: __box('#lb-next'),
    img: { l:+rimg.left.toFixed(1), t:+rimg.top.toFixed(1), r:+rimg.right.toFixed(1), b:+rimg.bottom.toFixed(1) },
    lbTouch: getComputedStyle(l).touchAction, barTop: getComputedStyle($('#lb-bar')).top,
    hitDl: hit('#lightbox-dl'),
    hitClose: hit('#lightbox-close'),
    hitPrev: hit('#lb-prev'),
    hitNext: hit('#lb-next'),
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
    return await fn({ device, evaluate, tmp, shot: async () => (await rpc('Page.captureScreenshot', { format: 'png' })).data });
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

  console.log('\n[2] a gallery of pictures gets an arrow on each side of the screen');
  check(/id="lb-prev"/.test(index) && /id="lb-next"/.test(index), 'the overlay carries a back and a next arrow');
  check(/\.lb-nav\{position:absolute;top:50%;transform:translateY\(-50%\)/.test(css), 'each arrow is vertically centred on its side of the screen');
  check(/\.lb-prev\{left:calc\(\.6rem \+ var\(--safe-l\)\)\}/.test(css) && /\.lb-next\{right:calc\(\.6rem \+ var\(--safe-r\)\)\}/.test(css), 'and held inside the safe-area insets');
  check(/\.lb-nav:disabled\{opacity:\.3;cursor:default\}/.test(css), 'the arrow at the end of the set goes dark rather than vanishing');
  check(/function lbMediaOf\(/.test(pickers) && /function lbGalleryAt\(/.test(pickers), 'the gallery is the message\'s own attachments, in order');
  check(/openLightbox\(imgEl\.dataset\.fbUrl \|\| imgEl\.src, dl\?\.getAttribute\('download'\) \|\| '', lbGalleryAt\(imgEl\)\)/.test(pickers), 'a picture click hands the viewer that gallery');
  // Discord's viewer is the PHOTO viewer and this one is too: a clip's own
  // controls own a tap on it, it plays where it sits, and it is deliberately not
  // in the set the arrows walk. Pinned as an absence so re-adding a video stage
  // (or a chip that opens the viewer from a clip) has to be a decision.
  check(!/lightbox-vid/.test(index) && !/lightbox-vid/.test(css) && !/lbVid/.test(pickers), 'there is no video stage in the photo viewer');
  check(!/att-expand/.test(messages) && !/att-expand/.test(css) && !/att-expand/.test(pickers), 'and no chip on a clip pretending to open one');
  check(/for \(const slot of box\.querySelectorAll\(':scope > \.att-slot'\)\) \{\s*\n\s*const img = slot\.querySelector\('img\.att-img'\);\s*\n\s*if \(!img\) continue;/.test(pickers), 'lbMediaOf takes the pictures and skips everything else');
}

async function main() {
  staticChecks();
  await withChrome(async ({ device, evaluate, shot }) => {
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

    console.log('\n[7] a message of several pictures: arrows on both sides');
    await device(390, 844, { touch: true });
    await evaluate("__gallery('g3', 3)");
    const opened = await evaluate("__clickIn('g3', '.att-img', 0)");
    await sleep(280);
    check(opened === true, 'a picture in a message of three opens the viewer');
    let g = await evaluate('__geo()');
    let s7 = await state();
    check(s7.img === await evaluate('__pic(0)'), 'and it opens the ORIGINAL, never the tile\'s derived preview');
    check(!s7.prevHidden && !s7.nextHidden && s7.n === 3, 'both arrows appear, on a set of three');
    check(s7.prevOff === true && s7.nextOff === false, 'the first picture has no way back, and a way on', s7);
    for (const [tag, box, hit] of [['back', g.prev, g.hitPrev], ['next', g.next, g.hitNext]]) {
      check(inside(box, g.vw, g.vh) && hit, `the ${tag} arrow is on screen and hit-testable`, box);
      check(Math.abs((box.t + box.b) / 2 - g.vh / 2) < 3, `the ${tag} arrow is vertically centred on its side`);
    }
    check(g.prev.l < g.vw / 2 && g.next.r > g.vw / 2, 'one on the left, one on the right', { prev: g.prev, next: g.next });
    // A visual artifact for eyeballing the arrows (temp dir), like the video
    // placeholder test's own.
    try {
      const out = path.join(os.tmpdir(), 'campfire-lightbox-gallery.png');
      fs.writeFileSync(out, Buffer.from(await shot(), 'base64'));
      console.log('  (wrote ' + out + ')');
    } catch {}

    // The arrows walk the set, and the end of it disables the way on.
    await evaluate("document.getElementById('lb-next').click()");
    await sleep(60);
    s7 = await state();
    check(s7.img === await evaluate('__pic(1)') && s7.index === 1, 'next steps to the second picture', s7.index);
    check(s7.prevOff === false && s7.nextOff === false, 'both ways are open in the middle');
    await evaluate("document.getElementById('lb-next').click()");
    await sleep(60);
    s7 = await state();
    check(s7.img === await evaluate('__pic(2)') && s7.nextOff === true, 'the last picture disables it: the end is the end');
    await evaluate("document.getElementById('lb-next').click()");
    await sleep(60);
    check((await state()).img === await evaluate('__pic(2)'), 'and clicking a disabled arrow goes nowhere');
    // The arrow keys are the desktop twin.
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))");
    await sleep(60);
    check((await state()).img === await evaluate('__pic(1)'), 'ArrowLeft steps back');
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))");
    await sleep(60);
    check((await state()).img === await evaluate('__pic(2)'), 'ArrowRight steps on');
    // A sideways swipe is the touch twin (and is not the dismissal gesture).
    await evaluate('__swipeX(195, 420, -120)');
    await sleep(60);
    s7 = await state();
    check(s7.hidden === false && s7.img === await evaluate('__pic(2)'), 'a swipe left past the end goes nowhere, and does not close the viewer', s7.index);
    await evaluate('__swipeX(195, 420, 120)');
    await sleep(60);
    s7 = await state();
    check(s7.hidden === false && s7.img === await evaluate('__pic(1)'), 'a swipe right steps back one picture', s7.index);
    await evaluate('__swipeX(195, 420, -120)');
    await sleep(60);
    check((await state()).img === await evaluate('__pic(2)'), 'and a swipe left steps on');
    // A tap on an arrow must not reach the stage (which would close the viewer).
    g = await evaluate('__geo()');
    await evaluate(`__tap(${(g.next.l + g.next.r) / 2}, ${(g.next.t + g.next.b) / 2})`);
    await sleep(60);
    check((await state()).hidden === false, 'tapping an arrow keeps the viewer open');

    console.log('\n[8] nowhere to go, no arrows');
    await evaluate('__close()');
    await sleep(30);
    await evaluate("__gallery('g1', 1)");
    await evaluate("__clickIn('g1', '.att-img', 0)");
    await sleep(60);
    s7 = await state();
    check(s7.hidden === false && s7.img === await evaluate('__pic(0)'), 'a single-picture message still opens the viewer');
    check(s7.prevHidden && s7.nextHidden, 'with no arrows at all — there is nowhere to go', s7);
    await evaluate('__close()');
    await sleep(30);
    await open(800, 800);
    s7 = await state();
    check(s7.prevHidden && s7.nextHidden, 'and a picture with no message block around it (an embed) never grows arrows', s7);
    // Desktop too: the arrows are not a phone-only control.
    await device(1280, 800, { touch: false });
    await evaluate('__close()');
    await sleep(30);
    await evaluate("__clickIn('g3', '.att-img', 0)");
    await sleep(120);
    g = await evaluate('__geo()');
    check(inside(g.prev, g.vw, g.vh) && g.hitPrev && inside(g.next, g.vw, g.vh) && g.hitNext, 'on a desktop both arrows are reachable too');
    check((await state()).n === 3, 'and the set is the same one');

    console.log('\n[9] a clip in the message is not part of the picture set');
    await device(390, 844, { touch: true });
    await evaluate('__close()');
    await sleep(30);
    // Two pictures and a clip between them: the arrows walk the two pictures, in
    // their own order, and never land on the player.
    await evaluate("__galleryWithClip('gm', 2)");
    await evaluate("__clickIn('gm', '.att-img', 0)");
    await sleep(120);
    let s9 = await state();
    check(s9.n === 2 && !s9.prevHidden && !s9.nextHidden, 'two pictures beside a clip are a set of TWO', s9);
    check(s9.prevOff === true && s9.nextOff === false, 'the first picture is the first of the set', s9);
    await evaluate("document.getElementById('lb-next').click()");
    await sleep(120);
    s9 = await state();
    check(s9.img === await evaluate('__pic(1)'), 'next goes straight to the picture after the clip');
    check(s9.nextOff === true, 'and that picture is the end of the set', s9);
    check(s9.dl === await evaluate('__pic(1)') && s9.dlName === 'p1.png', 'the corner button still downloads the picture on the stage');
    // A picture with a clip beside it and nothing else: one picture, no arrows.
    await evaluate('__close()');
    await sleep(30);
    await evaluate("__galleryWithClip('gm1', 1)");
    await evaluate("__clickIn('gm1', '.att-img', 0)");
    await sleep(60);
    s9 = await state();
    check(s9.hidden === false && s9.img === await evaluate('__pic(0)'), 'a picture sharing its message with a clip still opens');
    check(s9.prevHidden && s9.nextHidden, 'and grows no arrows: a clip is not somewhere the photo viewer can go', s9);
    // Closing clears the set: the next single picture gets no arrows back.
    await evaluate('__close()');
    await sleep(30);
    await open(800, 800);
    s9 = await state();
    check(s9.hidden === false && s9.prevHidden && s9.nextHidden, 'a reopened single picture has no arrows left over', s9);
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
