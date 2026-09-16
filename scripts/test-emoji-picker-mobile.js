// The emoji/GIF picker on a phone (see AGENTS.md verification conventions).
//
// The complaint: opening the picker while the keyboard was up pushed everything
// around and left the menu cramped and half off the screen — the picker and the
// system keyboard were both claiming the bottom of a 400px-wide, 900px-tall
// screen, and the picker (max-height:62dvh, sitting ABOVE the composer) ended up
// fighting the keys for room.
//
// The rule this pins down: ON A PHONE THE PICKER TAKES THE KEYBOARD'S PLACE. It
// does not coexist with it. Opening the picker dismisses the keyboard, and the
// sheet then fills the room the keys gave up. Three halves, all asserted here:
//
//   1. openPicker() blurs the composer on a phone layout (so the keyboard comes
//      down) and does NOT focus its own search field — an emoji key must never
//      answer with a keyboard. On a desktop the search field still takes focus,
//      because there is no keyboard to fight.
//   2. the height is MEASURED (sizePicker), not a fixed vh: the sheet gets the
//      space that actually exists above the composer, minus the keyboard the
//      viewport has not already absorbed. The cap holds under both viewport
//      models — the resizes-content one Android uses (layout viewport shrinks)
//      and the visual-only one iOS/WKWebView uses (layout box stays tall and the
//      keyboard overlaps it, which is the case that used to shove the picker off
//      the top).
//   3. dismissing the sheet (its ✕, Escape, a tap outside) does NOT hand the
//      caret back, because that would answer "close this" by raising the
//      keyboard. A pick still does hand it back, with preventScroll.
//
// Driven against the REAL styles.css and the REAL pickers.js (which is evaluated
// whole, with the few app globals it references stubbed), in headless Chrome
// over CDP with touch emulation forced so the phone @media block compiles.
//
// Usage: node scripts/test-emoji-picker-mobile.js
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

const PHONE_MQ = '(max-width:700px), (max-height:560px) and (pointer:coarse)';
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
function connectWs(url) {
  const WS = globalThis.WebSocket || require('ws');
  const sock = new WS(url, { perMessageDeflate: false });
  const on = (ev, fn) => (typeof sock.addEventListener === 'function' ? sock.addEventListener(ev, fn) : sock.on(ev, fn));
  return { send: (d) => sock.send(d), on, close: () => { try { sock.close(); } catch {} } };
}

// The app around the picker, reduced to the parts the picker measures: the app
// shell (--vvh), a composer at the bottom, and the picker's own markup taken
// straight out of public/index.html so a change there cannot silently stop being
// under test. pickers.js runs for real; the handful of app globals it touches
// get the smallest honest stand-in.
function pageHtml(realPickerBlock) {
  const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
  const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<style>${css}</style>
<style>
  /* The two dots the app paints into :root, and which the picker's cap reads. */
  :root{--composer-h:74px;--strip-h:1.2rem;--safe-t:0px;--safe-b:0px}
  /* overflow:clip, not hidden: hidden on <html> propagates to the viewport and a
     horizontal scrollbar survives, which then steals 13px of height from the
     layout viewport and skews every geometry assertion below. clip cannot
     scroll, so nothing leaks into the viewport's own overflow. */
  html,body{margin:0;height:100%;overflow:clip}
  *,*::before,*::after{box-sizing:border-box}
  #app{height:var(--vvh,100dvh);display:flex;flex-direction:column;overflow:hidden}
  #chat{flex:1;min-height:0;display:flex;flex-direction:column;position:relative}
  #messages{flex:1;min-height:0;overflow:auto;padding:.5rem}
  #typing-bar{flex:0 0 auto;height:var(--strip-h);padding:0 1.1rem}
  #composer{flex:0 0 auto}
</style>
</head><body>
<div id="app"><main id="chat">
  <div id="messages"><div style="height:2000px"></div></div>
  <div id="typing-bar"><span id="typing"></span></div>
  <form id="composer"><div id="composer-box">
    <textarea id="in-message" rows="1"></textarea>
    <div id="composer-tools"></div>
  </div><button class="send-btn" type="submit">S</button></form>
</main></div>
${realPickerBlock}
<script>
/* ---- app globals pickers.js expects (the smallest honest stand-ins) ---- */
window.__calls = { focusCalls: 0, sizeRun: 0, toasts: 0 };
window.S = { picker: null, pickerReturnFocus: null, gifPick: null, tagEmojiInput: null, tagEmojiDone: null, gifFavs: null };
window.$ = (sel) => document.querySelector(sel);
window.$$ = (sel) => document.querySelectorAll(sel);
window.haptic = () => {};
window.toast = () => { window.__calls.toasts++; };
/* native.js's cfEditable — the only thing openPicker asks it is "was an editable
   focused before we took the caret", so the stand-in mirrors its real shape. */
window.cfEditable = (el) => {
  if (!el || el.nodeType !== 1) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return !/^(button|checkbox|radio|file|submit|reset|range|color|image|hidden)$/i.test(el.type || 'text');
  return el.isContentEditable === true;
};
window.api = async () => ({ favorites: [], gifs: [] });
window.esc = (s) => String(s == null ? '' : s);
window.renderRich = (s) => s;
window.insertAtCursor = (inp, t) => { if (inp) inp.value += t; };
window.syncRenderFor = () => {};
window.syncComposerRender = () => {};
window.syncThreadRender = () => {};
window.draftSoon = () => {};
window.draftCtxForEl = () => null;
window.showEmojiPop = () => {};
window.applyProfileUrl = () => {};
window.renderComposerMeta = () => {};
window.renderThreadComposerMeta = () => {};
window.threadComposerAnchor = () => null;
window.composerAnchor = () => null;
window.composerHasDraft = () => false;
window.gifComposerReady = () => false;
window.pickerVisibleThread = () => false;
window.setAttPreview = () => {};
window.postGif = () => {};
window.sendChat = () => {};
window.sendDm = () => {};
window.toggleReaction = () => {};
window.msgById = () => null;
window.chatGifFavFromBtn = () => null;
/* The picker's own search focus() is what a phone must NOT call on open, so the
   count of focus() calls on that field is the assertion, not a side effect. */
document.getElementById('pk-search').addEventListener('focus', () => { window.__calls.focusCalls++; });
/* phoneLayout() out of core.js — the picker branches on it, so the test has to
   answer it the way the app does. */
window.phoneLayout = () => matchMedia(${JSON.stringify(PHONE_MQ)}).matches;

window.__baseH = () => __realInner();
/* Model a keyboard the way the two viewport models really behave, by stubbing
   the two numbers the platform reports — never by moving the real window, which
   would resize the layout box for the wrong reason:

     mode 'content' (Android, interactive-widget=resizes-content): the layout box
        already pays for the keys, so innerHeight shrinks and --kb stays 0.
     mode 'visual'  (iOS / a WebView that ignores the hint): only the visual
        viewport shrinks. The layout box stays tall, the keyboard overlaps it, and
        --kb is what reports the difference — the model that used to shove the
        picker off the top.

   Both getters fall through to the REAL value when no keyboard is stubbed, so a
   later device() (a genuinely resized viewport) is picked up rather than masked
   by a stale number. */
window.__kb = { on: false, px: 0, mode: null };
const __innerDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window), 'innerHeight') || Object.getOwnPropertyDescriptor(window, 'innerHeight');
const __clientDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
const __realInner = () => (__innerDesc && __innerDesc.get ? __innerDesc.get.call(window) : 911);
const __realClient = () => (__clientDesc && __clientDesc.get ? __clientDesc.get.call(document.documentElement) : __realInner());
let __kbInner = null, __kbClient = null, __kbVv = null;
Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => (__kbInner == null ? __realInner() : __kbInner) });
Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, get: () => (__kbClient == null ? __realClient() : __kbClient) });
window.__setKeyboard = (px, mode) => {
  const vv = window.visualViewport;
  const fi = __realInner(), fv = vv ? vv.height : fi;
  window.__kb.on = px > 0; window.__kb.px = px; window.__kb.mode = px > 0 ? mode : null;
  __kbInner = px > 0 && mode === 'content' ? fi - px : null;
  __kbClient = __kbInner;
  __kbVv = px > 0 ? fv - px : null;
  if (__kbVv != null && vv) { try { Object.defineProperty(vv, 'height', { configurable: true, get: () => __kbVv }); } catch {} }
  document.documentElement.style.setProperty('--vvh', (__kbVv == null ? fv : __kbVv) + 'px');
  dispatchEvent(new Event('resize'));
  if (vv) vv.dispatchEvent(new Event('resize'));
  return { innerHeight: __kbInner == null ? fi : __kbInner, vvh: __kbVv == null ? fv : __kbVv };
};
window.__box = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
};
window.__pick = (sel, x, y) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const t = document.elementFromPoint(x, y);
  return !!(t && (t === el || el.contains(t)));
};
window.__state = () => ({
  vw: innerWidth, vh: innerHeight,
  // --kb as the app itself computed it (wirePickerViewport), not the test's own
  // idea of the keyboard: this is the number the stylesheet's bottom uses.
  kb: +((getComputedStyle(document.documentElement).getPropertyValue('--kb') || '').replace('px', '')) || 0,
  phone: matchMedia(${JSON.stringify(PHONE_MQ)}).matches,
  pickerPos: getComputedStyle(document.querySelector('#picker')).position,
  pickerCls: document.querySelector('#picker').className,
  picker: window.__box('#picker'),
  tabs: window.__box('#picker .pk-tabs'),
  search: window.__box('#pk-search'),
  grid: window.__box('#pk-emoji'),
  composer: window.__box('#composer'),
  maxH: document.querySelector('#picker').style.maxHeight,
  open: !document.querySelector('#picker').classList.contains('hidden'),
  focusCalls: window.__calls.focusCalls,
  activeId: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
});
window.__open = (tab) => { window.__calls.focusCalls = 0; openPicker('insert', null, tab || 'emoji', null, null); return window.__state(); };
window.__settle = () => new Promise((r) => setTimeout(r, 320));
window.__openSettled = async (tab) => { window.__open(tab); await window.__settle(); return window.__state(); };
window.__searchFocus = () => { document.getElementById('pk-search').focus(); return window.__state(); };
window.__closeDirect = (restore) => { closePicker(restore); return window.__state(); };
window.__composerFocus = () => { document.getElementById('in-message').focus(); return window.__state(); };
window.__closeClick = () => { document.getElementById('pk-close').click(); return window.__state(); };
/* The real app's listener over this contract (final.js): putting the caret in a
   composer means the reader wants to type, so the sheet gets out of the way. It
   lives in final.js, which is not under test here, so the page carries the same
   three lines — the CSS/JS halves above are the real ones. */
for (const id of ['in-message']) {
  document.getElementById(id).addEventListener('focus', () => { const p = document.getElementById('picker'); if (p && !p.classList.contains('hidden')) closePicker(); });
}
</script>
<script>${pickers}</script>
</body></html>`;
}

// The picker's markup, lifted verbatim out of public/index.html so a change to
// the real sheet cannot quietly stop being under test.
function pickerMarkup(index) {
  const start = index.indexOf('<div id="picker"');
  if (start < 0) return null;
  // Walk the div nesting from #picker's own tag rather than regex-matching
  // closing tags — the block contains several sibling divs and a regex happily
  // stops at the wrong one.
  let depth = 0, i = start;
  for (; i < index.length; i++) {
    if (index.startsWith('<div', i)) { depth++; i += 3; }
    else if (index.startsWith('</div>', i)) { depth--; i += 5; if (depth === 0) return index.slice(start, i + 1); }
  }
  return null;
}

async function withChrome(fn) {  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found — set CHROME_PATH');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-pick-'));
  const port = 9700 + Math.floor(Math.random() * 200);
  const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const block = pickerMarkup(index);
  if (!block) return skip('could not find the #picker block in public/index.html');
  const htmlPath = path.join(tmp, 'picker.html');
  fs.writeFileSync(htmlPath, pageHtml(block));
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
    // screenWidth/screenHeight are what stop Chrome's mobile emulation from
    // fitting the page into the 944x1024 DEVICE pixels of its own window: without
    // them the page is scaled by ~0.968, and every getBoundingClientRect comes
    // back proportionally smaller than the layout numbers they are compared to.
    await rpc('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 2, mobile: touch,
      screenWidth: w, screenHeight: h, screenOrientation: { type: 'portraitPrimary', angle: 0 },
    });
    // A headless page is NOT focused, and an unfocused document makes focus/blur
    // events unreliable — which is exactly what the search-field behaviour is
    // built on. Focus emulation makes the page behave like a real one there.
    try { await rpc('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch {}
    // Pin the page scale. Mobile emulation answers `width=device-width` by
    // fitting the page into the emulator's own device pixels, which scales every
    // client rect by ~0.968 and desynchronises it from the layout numbers
    // (innerHeight, offsetHeight) the assertions compare against.
    try { await rpc('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }); } catch {}
    await sleep(320);
  };
  try {
    await rpc('Page.enable');
    await rpc('Runtime.enable');
    await rpc('Page.navigate', { url: 'file:///' + htmlPath.replace(/\\/g, '/') });
    await sleep(900);
    // Render the current sheet to a PNG (see PICK_SHOT).
    const shoot = async (setup, file) => {
      await evaluate(setup);
      await sleep(200);
      const r = await rpc('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      console.log('  shot ' + file);
    };
    return await fn({ device, evaluate, rpc, shoot });
  } finally {
    try { close(); } catch {}
    try { chrome.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

const inside = (r, vw, vh, slack = 1) => r && r.l >= -slack && r.t >= -slack && r.r <= vw + slack && r.b <= vh + slack;

// The phone @media block, brace-counted out of the stylesheet. There are several
// blocks with this exact condition, so a regex that just hunts for `#picker` from
// the first one happily backtracks into the DESKTOP rule further down — which is
// what a naive match did, and why this scans instead.
function phoneBlock(css) {
  const open = '@media (max-width:700px),(max-height:560px) and (pointer:coarse){';
  let from = 0;
  for (;;) {
    const i = css.indexOf(open, from);
    if (i < 0) return null;
    let d = 0;
    for (let j = i + open.length - 1; j < css.length; j++) {
      if (css[j] === '{') d++;
      else if (css[j] === '}') { d--; if (d === 0) { const body = css.slice(i, j + 1); if (body.includes('#picker{')) return body; break; } }
    }
    from = i + open.length;
  }
}

// ---------------- the checks ----------------
function staticChecks() {
  console.log('\n[1] the phone picker is pinned to the screen, never stacked on the keyboard');
  const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
  const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
  const phone = phoneBlock(css);
  check(!!phone, 'the phone block carries its own #picker rule');
  const block = phone || '';
  check(/bottom:var\(--kb,0px\)/.test(block), 'the sheet rides the app keyboard offset (--kb)', block.slice(-260));
  check(!/max-height:62dvh/.test(block), 'the old fixed 62dvh cap is gone — a vh cannot know about the composer or the keys');
  check(/max-height:clamp\(220px/.test(block), 'the cap is a floor/ceiling clamp, so it can never measure to nothing');
  check(/#picker\.pk-kb\{position:fixed;bottom:0;/.test(css),
    'while search is focused the sheet is fixed at the keyboard’s own top edge');
  check(/classList\.toggle\('pk-kb'/.test(pickers), 'and the class is painted by the search field’s own focus/blur');
  check(/#picker\.pk-resizing\{max-height:none\}/.test(css), 'a drag owns the height while the finger is down');
  // The JS half: the phone never focuses the picker's search field, and a pick
  // differs from a dismissal.
  check(/if \(!phone\) setTimeout\(\(\) => \{ const s = \$\('#pk-search'\); if \(S\.picker\) s\.focus\(\); \}, 0\);/.test(pickers),
    'a phone picker does not answer an emoji key with a keyboard');
  check(/closePicker\(!phoneLayout\(\), inp\)/.test(pickers), 'a pick hands the caret back on a desktop, not on a phone');
  check(/function closePicker\(restoreFocus = true, focusBack = undefined\)/.test(pickers), 'closePicker takes the behaviour and the target explicitly');
  check(/#pk-close\{/.test(css), 'the sheet carries its own dismiss key');
}

async function browserChecks() {
  await withChrome(async ({ device, evaluate, rpc, shoot }) => {
    // The reported device: 406x911 CSS px, portrait, touch.
    await device(406, 911);
    await evaluate('__boot = true');

    console.log('\n[2] 406x911 phone: the sheet is measured against the room that exists');
    await evaluate('__setKeyboard(0, "content")'); // clean baseline: no keys, nothing stale
    let s = await evaluate('__openSettled()');
    // Looking at it is worth as much as measuring it: PICK_SHOT=<file> writes the
    // open sheet (and, at the end, the search state) as PNGs.
    if (process.env.PICK_SHOT) await shoot(`(() => { __setKeyboard(0, "content"); return __openSettled(); })()`, process.env.PICK_SHOT.replace(/\.png$/, '') + '-open.png');
    check(s.phone === true, 'the phone layout block is active at 406x911');
    check(s.open === true, 'the picker opens');
    check(s.focusCalls === 0, 'opening it did NOT focus the search field (no keyboard raised)', { focusCalls: s.focusCalls });
    check(!!s.picker && s.picker.h > 200, 'the sheet is a real sheet, not a sliver', s.picker);
    check(inside(s.picker, s.vw, s.vh), 'the sheet fits on screen with the keyboard down', s.picker);
    // The sheet is the keyboard's stand-in, so it HIDES the composer rather than
    // floating above it — exactly where the keys would be. What must survive is
    // the chat: the top 18% of the screen stays readable, so a picker never eats
    // the conversation behind it.
    check(!!s.picker && Math.abs(s.picker.b - s.vh) <= 1, 'the sheet is pinned to the screen bottom, where the keyboard would be', { b: s.picker && s.picker.b, vh: s.vh });
    check(!!s.picker && s.picker.t >= s.vh * 0.18 - 2, 'and real chat stays visible above it', { top: s.picker && s.picker.t, floor: +(s.vh * 0.18).toFixed(1) });
    check(!!s.grid && s.grid.h > 100, 'the tile grid has room to be usable', s.grid);
    check(!!s.tabs && s.tabs.t >= -1, 'the tabs (and the ✕) are on screen', s.tabs);
    check(!!s.search && s.search.t >= -1, 'the search field is on screen', s.search);

    console.log('\n[3] the same sheet under BOTH keyboard models');
    // (a) Android/resizes-content: the layout box shrinks with the keys. This one
    // needs a REAL viewport change — a scripted innerHeight cannot move CSS layout,
    // so `position:fixed; bottom:0` would still sit on the true window edge.
    await device(406, 611);
    let a = await evaluate('(async () => { __setKeyboard(0, "content"); await __settle(); return Object.assign({ base: __baseH() }, __state()); })()');
    check(a.vh === 611, 'a resizes-content keyboard shrinks the layout viewport (Android)', { vh: a.vh });
    check(a.kb === 0, 'and leaves --kb at 0 (the shell already paid for the keys)', { kb: a.kb });
    check(inside(a.picker, a.vw, a.vh), 'android: the sheet fits the shrunken viewport', a.picker);
    check(!!a.picker && a.picker.t >= a.vh * 0.18 - 2, 'android: real chat still stays visible above it', { top: a.picker && a.picker.t, floor: +(a.vh * 0.18).toFixed(1) });
    check(!!a.grid && a.grid.h > 60, 'android: the grid keeps usable height', a.grid);
    check(!!a.tabs && a.tabs.t >= -1, 'android: the tabs and ✕ are still on screen', a.tabs);
    // (b) iOS/WKWebView: only the VISUAL viewport shrinks; the layout box stays
    // tall, which is the model that used to shove the picker off the top. This
    // one CAN be scripted, because the fix is what the sheet does with --kb.
    await device(406, 911);
    let b = await evaluate('(async () => { __setKeyboard(300, "visual"); await __settle(); return Object.assign({ base: __baseH() }, __state()); })()');
    check(b.vh === b.base, 'a visual-only keyboard leaves the layout viewport tall (iOS/WKWebView)', { vh: b.vh, base: b.base });
    check(b.kb === 300, 'and is reported as --kb=300, which puts the sheet’s bottom edge on the keyboard', { kb: b.kb });
    check(!!b.picker && b.picker.t >= -1, 'iOS-style: the sheet is not pushed off the top', b.picker);
    check(!!b.picker && b.picker.b <= b.vh - 300 + 2, 'iOS-style: the sheet stops at the keyboard, which the layout box cannot see', { b: b.picker && b.picker.b, kbTop: b.vh - 300 });

    console.log('\n[4] search is the one moment the keyboard is welcome back');
    let f = await evaluate('(async () => { __setKeyboard(0, "content"); await __openSettled(); return __searchFocus(); })()');
    check(f.activeId === 'pk-search', 'the search field holds the caret', { activeId: f.activeId });
    check(f.pickerCls.includes('pk-kb'), 'with search focused the sheet switches to the keyboard-edge mode', { cls: f.pickerCls });
    if (process.env.PICK_SHOT) await shoot('(() => { __setKeyboard(300, "visual"); return __settle(); })()', process.env.PICK_SHOT.replace(/\.png$/, '') + '-search.png');
    check(f.pickerPos === 'fixed', 'and is fixed at the keyboard edge, not floated above the composer', { pos: f.pickerPos });
    check(!!f.picker && inside(f.picker, f.vw, f.vh), 'the search sheet still fits the visible viewport', f.picker);

    console.log('\n[5] dismissing the sheet must not answer with a keyboard');
    let afterX = await evaluate('(() => { __setKeyboard(0, "content"); __open(); return __closeClick(); })()');
    check(afterX.open === false, 'the ✕ closes the sheet', { open: afterX.open });
    check(afterX.activeId !== 'in-message', 'the ✕ does not hand the caret back (which would raise the keyboard)', { activeId: afterX.activeId });
    let comp = await evaluate('(() => { __open(); return __composerFocus(); })()');
    check(comp.open === false, 'putting the caret in the composer closes the sheet (they never share the screen)');
    let restore = await evaluate('(() => { __open(); closePicker(true, document.getElementById("in-message")); return __state(); })()');
    check(restore.open === false && restore.activeId === 'in-message', 'a PICK still hands the caret back', { activeId: restore.activeId });
    let closed = await evaluate('(() => { __open(); return __closeDirect(false); })()');
    check(closed.maxH === '', 'the sheet’s inline height cap is cleared on close', { maxH: closed.maxH });
    // A desktop dismissal still puts the caret back where it was taken from.
    let outside = await evaluate('(() => { __open(); closePicker(false); return __state(); })()');
    check(outside.open === false, 'a plain dismissal closes the sheet');
  });
}

async function desktopChecks() {
  await withChrome(async ({ device, evaluate }) => {
    await device(1280, 900, { touch: false });
    console.log('\n[6] a desktop is untouched: search still takes focus, no sheet sizing');
    let s = await evaluate('__open()');
    await sleep(60);
    s = await evaluate('__state()');
    check(s.phone === false, 'the desktop does not get the phone layout');
    check(s.focusCalls >= 1, 'the desktop still focuses the search field', { focusCalls: s.focusCalls });
    check(s.pickerPos === 'absolute', 'the desktop picker stays the anchored popup', { pos: s.pickerPos });
    check(!!s.picker && s.picker.w <= 400, 'the desktop popup keeps its popup width', s.picker);
  });
}

(async () => {
  console.log('[test] emoji/GIF picker on a phone');
  staticChecks();
  await browserChecks();
  await desktopChecks();
  console.log('\n' + (failures.length ? 'FAILED ' + failures.length + ' of ' + (passed + failures.length) : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
