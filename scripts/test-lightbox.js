// Lightbox: reachable controls, zoom, swipe-down dismissal, gallery arrows,
// clips and the thumbnail strip.
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
//   - a message with more than one MEDIA item opens with a back and a next arrow
//     on either side of the screen — the arrows (and the arrow keys, and a
//     sideways swipe) walk the message's media in order, each end disables its
//     arrow, and a lone item shows no arrows at all;
//   - the strip: one thumb per item along the bottom, the one on the stage lit,
//     a clip's thumb marked as a clip, a press on a thumb stepping straight to
//     that item — and no strip at all when there is only one item to see;
//   - a CLIP is part of the set ("if a video is in a collage, can it open in a
//     lightbox"): the collage tile is the door (no controls of its own) and the
//     player on the stage is where it plays, with its own controls and the
//     corner download button, while a photo keeps the zoom gestures.
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
window.__state = () => {
  const root = document.getElementById('lightbox');
  const strip = document.getElementById('lb-strip');
  const v = document.getElementById('lightbox-vid');
  const thumbs = [...document.getElementById('lb-strip-track').children];
  return {
    hidden: root.classList.contains('hidden'),
    scale: lb.scale, tx: lb.tx, ty: lb.ty,
    img: document.getElementById('lightbox-img').getAttribute('src') || '',
    imgHidden: document.getElementById('lightbox-img').classList.contains('hidden'),
    vid: v.getAttribute('src') || '',
    vidHidden: v.classList.contains('hidden'),
    kind: lb.items && lb.items[lb.index] ? (lb.items[lb.index].kind || 'image') : (v.classList.contains('hidden') ? 'image' : 'video'),
    dl: document.getElementById('lightbox-dl').getAttribute('href') || '',
    dlName: document.getElementById('lightbox-dl').getAttribute('download') || '',
    prevHidden: document.getElementById('lb-prev').classList.contains('hidden'),
    nextHidden: document.getElementById('lb-next').classList.contains('hidden'),
    prevOff: document.getElementById('lb-prev').disabled,
    nextOff: document.getElementById('lb-next').disabled,
    index: lb.index, n: lb.items ? lb.items.length : 0,
    hasStrip: root.classList.contains('has-strip'),
    stripHidden: strip.classList.contains('hidden'),
    stripN: thumbs.length,
    stripKinds: thumbs.map((b) => b.dataset.kind),
    stripActive: thumbs.findIndex((b) => b.classList.contains('active')),
    stripThumbs: thumbs.map((b) => { const im = b.querySelector('img'); return im ? (im.getAttribute('src') || '') : ''; }),
  };
};
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
window.__clipSlot = (bare) => '<span class="att-slot"><span class="att-wrap" data-fb-name="clip.mp4" data-fb-url="/clip.mp4">'
  + '<video class="att-vid" src="/clip.mp4" data-fb-src="/clip.mp4" data-fb-name="clip.mp4"' + (bare ? '' : ' poster="' + __thumb(9) + '"') + '></video>'
  + '<a class="att-dl" href="/clip.mp4" download="clip.mp4"></a></span></span>';
// The page's one-frame-per-url cache, as messages.js serves it: the lightbox asks
// for a clip's frame through this (lbFillThumb), and the answer can arrive after
// the strip is already up.
function whenVideoPoster(url, cb) { window.__posterWaiters.push([url, cb]); }
window.__posterWaiters = [];
window.__posterLand = (shot) => {
  const w = window.__posterWaiters.shift();
  if (!w) return false;
  w[1](shot);
  return true;
};
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
window.__galleryWithClip = (name, pics, bareClip) => {
  const box = document.createElement('div');
  box.className = 'msg-atts';
  box.id = name;
  let html = __picSlot(0) + __clipSlot(bareClip);
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
// …and the clip's entry point, which is the OTHER branch of that handler: the
// whole tile is the target (the poster frame, and the shell a clip waits behind
// until its frame has been captured), and the viewer walks the message's whole
// media set with this clip's place in it.
window.__clickClip = (el) => {
  const slot = el && el.closest ? el.closest('.att-slot') : null;
  const vid = slot && slot.querySelector('video.att-vid');
  const src = (vid && (vid.dataset.fbSrc || vid.getAttribute('src'))) || '';
  if (!src) return false;
  const dl = slot.querySelector('.att-dl');
  openLightbox(src, dl?.getAttribute('download') || '', lbGalleryAt(vid));
  return true;
};
// Click the i-th thing matching sel inside the block called name.
window.__slotIn = (name, sel, i) => {
  const box = document.getElementById(name);
  const list = box ? box.querySelectorAll(sel) : [];
  return list[i || 0] || null;
};
window.__clickIn = (name, sel, i) => __clickMedia(__slotIn(name, sel, i));
window.__clickClipIn = (name, i) => __clickClip(__slotIn(name, 'video.att-vid', i));
// Press the i-th thumb of the strip, as a reader would.
window.__stripPress = (i) => {
  const b = document.querySelectorAll('#lb-strip-track .lb-thumb')[i];
  if (!b) return false;
  b.click();
  return true;
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
  const hit = (sel) => { const el = $(sel); if (!el || el.classList.contains('hidden')) return false; const r = el.getBoundingClientRect(); if (!r.width) return false; const t = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2); return !!t && el.contains(t); };
  return {
    vw: innerWidth, vh: innerHeight,
    bar: __box('#lb-bar'), dl: __box('#lightbox-dl'), close: __box('#lightbox-close'), stage: __box('#lb-stage'),
    prev: __box('#lb-prev'), next: __box('#lb-next'),
    strip: __box('#lb-strip'), thumb: __box('#lb-strip-track .lb-thumb'),
    img: { l:+rimg.left.toFixed(1), t:+rimg.top.toFixed(1), r:+rimg.right.toFixed(1), b:+rimg.bottom.toFixed(1) },
    vid: (() => { const v = $('#lightbox-vid'); const r = v.getBoundingClientRect(); return { l:+r.left.toFixed(1), t:+r.top.toFixed(1), r:+r.right.toFixed(1), b:+r.bottom.toFixed(1), hidden: v.classList.contains('hidden') }; })(),
    lbTouch: getComputedStyle(l).touchAction, barTop: getComputedStyle($('#lb-bar')).top,
    stripTrackMargin: getComputedStyle($('#lb-strip-track')).marginLeft,
    hitDl: hit('#lightbox-dl'),
    hitClose: hit('#lightbox-close'),
    hitPrev: hit('#lb-prev'),
    hitNext: hit('#lb-next'),
    hitThumb: hit('#lb-strip-track .lb-thumb'),
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

  console.log('\n[2] media with neighbours gets an arrow on each side of the screen');
  check(/id="lb-prev"/.test(index) && /id="lb-next"/.test(index), 'the overlay carries a back and a next arrow');
  check(/\.lb-nav\{position:absolute;top:calc\(\(var\(--lb-pad-t\) \+ 100% - var\(--lb-pad-b\) - var\(--lb-strip-h\)\) \/ 2\);transform:translateY\(-50%\)/.test(css), 'each arrow is centred on the media\'s own line (the stage\'s content box, strip included)');
  check(/\.lb-prev\{left:calc\(\.6rem \+ var\(--safe-l\)\)\}/.test(css) && /\.lb-next\{right:calc\(\.6rem \+ var\(--safe-r\)\)\}/.test(css), 'and held inside the safe-area insets');
  check(/\.lb-nav:disabled\{opacity:\.3;cursor:default\}/.test(css), 'the arrow at the end of the set goes dark rather than vanishing');
  check(/function lbMediaOf\(/.test(pickers) && /function lbGalleryAt\(/.test(pickers), 'the set is the message\'s own media, in order');
  check(/openLightbox\(imgEl\.dataset\.fbUrl \|\| imgEl\.src, dl\?\.getAttribute\('download'\) \|\| '', lbGalleryAt\(imgEl\)\)/.test(pickers), 'a picture click hands the viewer that set');
  check(/if \(img\) \{\s*\n\s*const src = img\.dataset\.fbUrl \|\| img\.dataset\.fbOrig \|\| img\.getAttribute\('src'\) \|\| '';\s*\n\s*if \(src\) items\.push\(\{ el: slot, kind: 'image'/.test(pickers)
    && /if \(vid\) \{\s*\n\s*const src = vid\.dataset\.fbSrc \|\| vid\.getAttribute\('src'\)/.test(pickers),
    'lbMediaOf takes the PICTURES and the CLIPS off the DOM — one item per .att-slot, in the order the message renders them');

  console.log('\n[2b] a collage clip is a door into the viewer, and the viewer plays it');
  check(/id="lightbox-vid"/.test(index) && /#lightbox-vid\{max-width:100%;max-height:100%/.test(css),
    'the stage carries a player of its own');
  check(/\.msg-atts\.gallery \.att-slot video\.att-vid, \.msg-atts\.gallery \.att-slot \.att-vid-load, \.msg-atts\.gallery \.att-slot \.att-tile-open/.test(pickers),
    'and a press on a COLLAGE clip — its own full-tile door, the poster frame, or the shell it waits behind — opens it');
  // The door is what makes that press reliable: a bare <video> is not a click
  // target a phone can be trusted to hand the page (reported: on Android a tap on
  // a collage video opened the clip in the browser instead of the viewer), so the
  // tile carries a transparent button over its player, built with the tile and by
  // the same one place that leaves the controls off it.
  check(/const door = tile \? '<button type="button" class="att-tile-open"/.test(messages),
    'the door is built with the TILE, so a standalone player (which plays where it sits, by its own controls) never gets one');
  check(/\$\{door\}\$\{attDl\(a\)\}/.test(messages) && /\.msg-atts\.gallery \.att-tile-open\{position:absolute;inset:0;z-index:1/.test(css),
    'and it lies OVER the clip — transparent, full-tile — with the download chip above it');
  check(/\$\{tile \? '' : ' controls'\}/.test(messages) && /const tile = !!\(opts && opts\.tile\);/.test(messages),
    'a collage tile is built without native controls: the 120px square is not a player (attVideoHTML)');
  check(/atts\.map\(\(a\) => attachmentHTML\(a, gallery \? \{ tile: true \} : undefined\)\)/.test(messages),
    'and every tile of a collage is built that way');
  check(/if \(v\.closest && v\.closest\('\.msg-atts\.gallery'\)\) return;/.test(messages),
    'the tile shell does not reveal-and-play in place behind the viewer opening over it');
  check(/tile: !!\(oldEl\.closest && oldEl\.closest\('\.msg-atts\.gallery'\)\)/.test(messages),
    'and a republished clip is patched back as the SAME kind of clip');
  check(/function lbIsVid\(\)/.test(pickers) && /if \(!stage \|\| lbIsVid\(\)\) return;/.test(pickers),
    'the photo gestures (tap-zoom, trackpad pinch) stand down while a clip is on the stage');
  check(/if \(vid && !vid\.classList\.contains\('hidden'\) && \(target === vid/.test(pickers),
    'and a tap on the player (or its controls) is the player\'s, never a close');

  console.log('\n[2c] the strip of the message\'s media');
  check(/id="lb-strip"/.test(index) && /id="lb-strip-track"/.test(index), 'the overlay carries the strip and its track');
  check(/#lb-strip\{position:absolute;left:0;right:0;bottom:0/.test(css), 'it lies along the bottom of the screen');
  check(/#lb-strip-track\{display:flex;align-items:center;gap:\.5rem;flex:0 0 auto;width:max-content;margin:0 auto\}/.test(css),
    'the track centres a short row and scrolls a long one from its true first thumb (margin:auto, not justify-content)');
  check(/\.lb-thumb\.active\{opacity:1;border-color:rgba\(255,255,255,\.94\)/.test(css), 'the thumb on the stage is the lit one');
  check(/\.lb-thumb\[data-kind="video"\]::after\{[^}]*border-left:11px solid/.test(css),
    'and a clip\'s thumb says it is a clip (the play triangle)');
  check(/function lbBuildStrip\(\)/.test(pickers) && /function lbMarkStrip\(\)/.test(pickers), 'the strip is built once per open and lit per step');
  check(/const show = !!lb\.open && list\.length > 1;/.test(pickers), 'it exists exactly while there is more than one item to walk');
  check(/\$\('#lb-strip'\)\?\.addEventListener\('click'/.test(pickers) && /lbShow\(lb\.items\[i\]\);/.test(pickers),
    'a press on a thumb steps straight to that item');
  check(/function lbFillThumb\(b, it\)/.test(pickers) && /whenVideoPoster\(it\.src, \(shot\) =>/.test(pickers),
    'and a clip whose frame has not been captured yet fills its thumb in when it lands, instead of staying a broken picture');
  check(/if \(e\.target\.closest\('#lb-bar, \.lb-nav, #lb-strip'\)\) return;/.test(pickers),
    'and the strip owns its presses (the tap-to-close rule never sees one)');
  check(/#lightbox\.has-strip\{--lb-strip-h:calc\(56px \+ \.9rem\)\}/.test(css)
    && /padding:var\(--lb-pad-t\) calc\(1rem \+ var\(--safe-r\)\) calc\(var\(--lb-pad-b\) \+ var\(--lb-strip-h\)\)/.test(css),
    'the stage reserves the strip\'s height, so it can never cover the bottom of a tall photo');
  check(/body\.ub-open #lightbox\{--lb-pad-t:calc\(4\.4rem \+ var\(--safe-t\) \+ var\(--ub-h\)\)\}/.test(css),
    'and the update banner moves the top of that one line, so the arrows follow it too');
  check(/top:calc\(\(var\(--lb-pad-t\) \+ 100% - var\(--lb-pad-b\) - var\(--lb-strip-h\)\) \/ 2\)/.test(css),
    'the arrows ride on the media\'s centre rather than the screen\'s');
  check(!/att-expand/.test(messages) && !/att-expand/.test(css) && !/att-expand/.test(pickers),
    'and still no chip on a clip pretending to open a viewer — the tile itself is the door');
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

    console.log('\n[7] a message of several pictures: arrows on both sides, and the strip');
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
      // With the strip up the arrows ride on the MEDIA's centre, not the screen's:
      // the stage gave the strip its room at the bottom.
      check(Math.abs((box.t + box.b) / 2 - (g.img.t + g.img.b) / 2) < 3, `the ${tag} arrow sits level with the media it walks`);
    }
    check(g.prev.l < g.vw / 2 && g.next.r > g.vw / 2, 'one on the left, one on the right', { prev: g.prev, next: g.next });
    // The strip: one thumb per item, along the bottom, the first one lit.
    check(s7.stripN === 3 && !s7.stripHidden && s7.hasStrip, 'the strip carries one thumb per item', s7);
    check(s7.stripActive === 0, 'with the item on the stage lit', s7.stripActive);
    check(s7.stripKinds.join(',') === 'image,image,image', 'and every thumb a photo here', s7.stripKinds);
    check(s7.stripThumbs[0] === await evaluate('__thumb(0)'), 'each thumb paints the tile\'s own preview (not the full picture)', s7.stripThumbs);
    check(inside(g.strip, g.vw, g.vh) && g.strip.t > g.vh * 0.6, 'the strip lies along the bottom of the screen and inside it', g.strip);
    check(g.strip.b <= g.img.b + 1 || g.strip.t >= g.img.b - 1, 'and the stage keeps the media clear of it', { strip: g.strip, img: g.img });
    check(g.hitThumb, 'its thumbs are hit-testable (the stage is not over them)');
    check(g.stripTrackMargin === 'auto' || parseFloat(g.stripTrackMargin) > 0, 'and the track is what centres the row', g.stripTrackMargin);
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
    check(s7.stripActive === 1, 'and the strip lights the second thumb', s7.stripActive);
    await evaluate("document.getElementById('lb-next').click()");
    await sleep(60);
    s7 = await state();
    check(s7.img === await evaluate('__pic(2)') && s7.nextOff === true, 'the last picture disables it: the end is the end');
    // …and a press on a thumb is the arrows' shortcut: straight to that item.
    check(await evaluate('__stripPress(0)') === true, 'a press on the first thumb');
    await sleep(60);
    s7 = await state();
    check(s7.img === await evaluate('__pic(0)') && s7.index === 0 && s7.hidden === false,
      'steps straight to the first picture, without closing the viewer', s7);
    check(s7.stripActive === 0, 'and the strip follows', s7.stripActive);
    await evaluate("document.getElementById('lb-next').click()");
    await sleep(60);
    await evaluate("document.getElementById('lb-next').click()");
    await sleep(60);
    check((await state()).img === await evaluate('__pic(2)'), 'back on the last picture');
    await evaluate("document.getElementById('lb-next').click()");
    await sleep(60);
    check((await state()).img === await evaluate('__pic(2)'), 'and clicking a disabled arrow goes nowhere');
    check(await evaluate('__stripPress(2)') === true, 'a press on the thumb already on the stage');
    await sleep(60);
    s7 = await state();
    check(s7.index === 2 && s7.img === await evaluate('__pic(2)') && s7.hidden === false, 'does nothing at all (there is nowhere to go)', s7);
    // The arrow keys are the desktop twin.
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))");
    await sleep(60);
    check((await state()).img === await evaluate('__pic(1)'), 'ArrowLeft steps back');
    check((await state()).stripActive === 1, 'and the strip follows the keyboard too');
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
    // Nor must a tap on a thumb (which would close the viewer).
    g = await evaluate('__geo()');
    await evaluate(`__tap(${(g.thumb.l + g.thumb.r) / 2}, ${(g.thumb.t + g.thumb.b) / 2})`);
    await sleep(60);
    check((await state()).hidden === false, 'tapping the strip keeps the viewer open');

    console.log('\n[8] nowhere to go, no arrows and no strip');
    await evaluate('__close()');
    await sleep(30);
    await evaluate("__gallery('g1', 1)");
    await evaluate("__clickIn('g1', '.att-img', 0)");
    await sleep(60);
    s7 = await state();
    check(s7.hidden === false && s7.img === await evaluate('__pic(0)'), 'a single-picture message still opens the viewer');
    check(s7.prevHidden && s7.nextHidden, 'with no arrows at all — there is nowhere to go', s7);
    check(s7.stripHidden && !s7.hasStrip && s7.stripN === 0, 'and no strip either: a row of one is not a row', s7);
    await evaluate('__close()');
    await sleep(30);
    await open(800, 800);
    s7 = await state();
    check(s7.prevHidden && s7.nextHidden, 'and a picture with no message block around it (an embed) never grows arrows', s7);
    check(s7.stripHidden, 'nor a strip', s7);
    // Desktop too: the arrows are not a phone-only control.
    await device(1280, 800, { touch: false });
    await evaluate('__close()');
    await sleep(30);
    await evaluate("__clickIn('g3', '.att-img', 0)");
    await sleep(120);
    g = await evaluate('__geo()');
    check(inside(g.prev, g.vw, g.vh) && g.hitPrev && inside(g.next, g.vw, g.vh) && g.hitNext, 'on a desktop both arrows are reachable too');
    check((await state()).n === 3, 'and the set is the same one');

    console.log('\n[9] a clip is part of the set, and the VIEWER is where it plays');
    await device(390, 844, { touch: true });
    await evaluate('__close()');
    await sleep(30);
    // Two pictures with a clip between them: the set is all three, in the order
    // the message renders them.
    await evaluate("__galleryWithClip('gm', 2)");
    await evaluate("__clickIn('gm', '.att-img', 0)");
    await sleep(120);
    let s9 = await state();
    check(s9.n === 3 && !s9.prevHidden && !s9.nextHidden, 'two pictures beside a clip are a set of THREE', s9);
    check(s9.kind === 'image' && s9.vidHidden && !s9.imgHidden, 'the picture is on the stage, and the player is not', s9);
    check(s9.prevOff === true && s9.nextOff === false, 'the first picture is the first of the set', s9);
    check(s9.stripKinds.join(',') === 'image,video,image', 'and the strip marks the clip as one, in its place', s9.stripKinds);
    await evaluate("document.getElementById('lb-next').click()");
    await sleep(120);
    s9 = await state();
    check(s9.kind === 'video' && s9.vid === '/clip.mp4' && !s9.vidHidden && s9.imgHidden,
      'next steps onto the CLIP — the player is on the stage, not a cropped tile', s9);
    check(s9.dl === '/clip.mp4' && s9.dlName === 'clip.mp4', 'the corner button downloads the clip by its own name', s9);
    check(s9.stripActive === 1, 'and the strip lights the clip', s9.stripActive);
    check(s9.stripThumbs[1] === await evaluate('__thumb(9)'), 'whose thumb is the poster frame it holds', s9.stripThumbs);
    check(s9.stripThumbs[0] === await evaluate('__thumb(0)'), 'next to the picture before it', s9.stripThumbs);
    await evaluate("document.getElementById('lb-next').click()");
    await sleep(120);
    s9 = await state();
    check(s9.kind === 'image' && s9.img === await evaluate('__pic(1)') && s9.vidHidden && s9.nextOff === true,
      'and on to the picture after it — where the player stands down (no sound behind a photo)', s9);
    check(s9.vid === '' && s9.imgHidden === false, 'the clip is unloaded, not left playing behind the picture', s9);
    // A press on the CLIP TILE is the door: the viewer opens ON it, inside the set.
    await evaluate('__close()');
    await sleep(30);
    await evaluate("__galleryWithClip('gm2', 2)");
    check(await evaluate("__clickClipIn('gm2', 0)") === true, 'a press on a collage clip opens the viewer');
    await sleep(120);
    s9 = await state();
    check(s9.hidden === false && s9.kind === 'video' && s9.index === 1 && s9.n === 3,
      'ON that clip, with the message\'s whole set around it', s9);
    check(s9.dlName === 'clip.mp4' && s9.stripActive === 1, 'and its own download name and strip thumb', s9);
    // A picture sharing its message with a clip and nothing else: two items, so a
    // set of two — the clip is somewhere the arrows can go now.
    await evaluate('__close()');
    await sleep(30);
    await evaluate("__galleryWithClip('gm1', 1)");
    await evaluate("__clickIn('gm1', '.att-img', 0)");
    await sleep(60);
    s9 = await state();
    check(s9.hidden === false && s9.img === await evaluate('__pic(0)'), 'a picture sharing its message with a clip still opens');
    check(s9.n === 2 && !s9.prevHidden && !s9.nextHidden, 'and the clip beside it is the other item the arrows walk to', s9);
    check(s9.stripN === 2 && s9.stripKinds.join(',') === 'image,video', 'with the strip showing both', s9);
    // Closing clears the set: the next single picture gets no arrows back.
    await evaluate('__close()');
    await sleep(30);
    await open(800, 800);
    s9 = await state();
    check(s9.hidden === false && s9.prevHidden && s9.nextHidden, 'a reopened single picture has no arrows left over', s9);
    check(s9.stripHidden && s9.n === 0, 'and no strip left over either', s9);

    console.log('\n[10] a clip whose frame has not been captured yet');
    await evaluate('__close()');
    await sleep(30);
    // A tile the reader never scrolled near has no poster yet: the clip is on the
    // stage playing, and its strip thumb is the bare veil + play triangle until
    // the frame lands — then it fills in, without reopening the viewer.
    await evaluate("__galleryWithClip('gm3', 1, true)");
    await evaluate("__clickClipIn('gm3', 0)");
    await sleep(120);
    let s10 = await state();
    check(s10.hidden === false && s10.kind === 'video' && s10.stripN === 2, 'the clip opens inside its set', s10);
    check(s10.stripThumbs[1] === '' && s10.stripThumbs[0] !== '', 'with its thumb bare (no frame yet) beside the picture that has one', s10.stripThumbs);
    check(await evaluate('__posterWaiters.length') > 0, 'and the viewer asked the page for that frame');
    check(await evaluate('__posterLand(__thumb(9))') === true, 'the frame lands');
    await sleep(60);
    s10 = await state();
    check(s10.stripThumbs[1] === await evaluate('__thumb(9)'), 'the thumb fills in where it stood', s10.stripThumbs);
    check(s10.stripKinds[1] === 'video' && s10.stripActive === 1, 'still the clip, still the one on the stage', s10);
    check(await evaluate('__posterLand(__thumb(9))') === false, 'and a second answer for the same clip is not asked for twice');
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
