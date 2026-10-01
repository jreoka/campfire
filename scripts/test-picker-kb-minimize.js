// The phone picker's keyboard mode is a GEOMETRY fact, not a focus fact — and
// two owner reports came out of getting that wrong:
//
//   1. "if you open the gif picker and then open the keyboard it slides the gif
//       picker up which it's supposed to do but if you minimize the keyboard the
//       gif picker doesn't go back it only goes back down a little bit"
//   2. "i searched a gif and picked it and i had to tap it twice to send it. the
//       first time i tapped it it just highlighted it and then i had to tap it
//       again to send it"
//
// Both are the same defect seen from two sides. The keyboard's own minimize key
// hides the keys WITHOUT blurring the search field, so a mode keyed on focus
// kept the sheet up at the keyboard's old height (1) — and that same focus-keyed
// class also re-laid the sheet out between a finger landing on a GIF and lifting
// off it (the lift blurs the field, so the class flips and sizePicker runs),
// sliding the collage out from under the tap: the click was delivered to the
// section header where the tile had just been, so the GIF only highlighted and
// the SECOND tap sent it (2).
//
// The fix: keyboard mode comes from keyboardCovering() (is the visible viewport
// shorter than the screen's high-water mark?), and sizePicker holds the geometry
// still while a finger is down on the sheet.
//
// Static half (always runs): both rules are in the source.
// Browser half (skips without Chrome): the REAL #picker markup, the REAL
// styles.css and the REAL pickers.js at a 390px phone viewport, real GIF tiles
// served as real images (the collage's height is the real one) and REAL touch
// events. The caret is dropped on lift-off, the way a device's engine drops it —
// the one piece of a real tap CDP's synthetic touch does not do on its own, and
// the one the bug depends on.
//
// Usage: node scripts/test-picker-kb-minimize.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCREEN = 844;          // the phone's screen height in this walk
const KB_H = 444;            // how much of it the keyboard takes
const n = (s) => s.replace(/\r\n/g, '\n');

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function finish() {
  console.log('\n' + (failures.length ? 'FAILED: ' + failures.length : 'OK') + ' — ' + passed + ' checks passed');
  process.exit(failures.length ? 1 : 0);
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

const pickers = n(fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8'));
const css = n(fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8'));
const index = n(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'));

console.log('\n[1] keyboard mode is decided by geometry, not by focus');
check(/function keyboardCovering\(\) \{/.test(pickers), 'keyboardCovering() exists');
check(/_pkFullH - h >= PK_KB_MIN/.test(pickers),
  'it reads the visible viewport against the screen\u2019s high-water mark', 'the two-viewport contract');
check(/if \(h > _pkFullH\) _pkFullH = h;/.test(pickers), 'and keeps the high-water mark as a maximum');
check(/PK_KB_MIN = 90/.test(pickers), 'with a floor for browser chrome vs a keyboard');
check(/orientationchange[\s\S]{0,160}_pkFullH = 0/.test(pickers),
  'a rotation drops the mark — a rotated phone is a different screen');
const modeBlock = (pickers.match(/function paintPickerKeyboardMode\(\) \{[\s\S]*?\n\}/) || [])[0] || '';
check(/pkSearchFocused\(\) && keyboardCovering\(\)/.test(modeBlock),
  'the class is painted from the caret AND the geometry — never the caret alone', modeBlock.slice(0, 300));
check(!/const on = document\.activeElement === \$\('#pk-search'\);/.test(pickers),
  'the old focus-only decision is gone');

console.log('\n[2] the sheet cannot re-lay itself under a finger');
check(/function pickerFingerDown\(\)/.test(pickers), 'pickerFingerDown() exists');
const sizeBlock = (pickers.match(/function sizePicker\(\) \{[\s\S]*?\n  const comp/) || [])[0] || '';
check(/if \(pickerFingerDown\(\)\) return;/.test(sizeBlock),
  'sizePicker stands down while a finger is down on the sheet', sizeBlock);
const settleBlock = (pickers.match(/function settlePickerKeyboard\(\) \{[\s\S]*?\n\}/) || [])[0] || '';
check(/_pkTouchAt = 0;/.test(settleBlock),
  'the settle clears the guard outright, so it can never outlast the real re-measure');
check(/paintPickerKeyboardMode\(\);/.test(settleBlock),
  'the settle re-derives the mode too — that is the ▼-key path (the caret never blurs)');
check(!/addEventListener\('touchend', pkFingerUp/.test(pickers),
  'and no touchend handler clears it — the click lands AFTER the lift-off');

console.log('\n[3] the keyboard walk in a browser');
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/ms-playwright/chromium-1148/chrome-linux/chrome',
    '/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell',
    '/opt/meta-chromium/chrome',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}
const chromePath = findChrome();
if (!chromePath) {
  console.log('  (skipped — no Chrome/Edge found; set CHROME_PATH)');
  finish();
}

// The real #picker markup, verbatim from index.html.
const pickerMarkup = (() => {
  const a = index.indexOf('<div id="picker"');
  const b = index.indexOf('<!-- user card -->', a);
  return index.slice(a, b).replace('class="hidden"', '');
})();
// A real GIF, so the tiles have their true shape before anything is measured.
const TINY_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const pageHtml = `
<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,interactive-widget=resizes-content">
<title>picker kb minimize</title><style>${css}</style></head><body style="margin:0">
<div id="app"><div id="left"></div><div id="main"><main id="chat"><div id="messages"></div>
<div id="typing-bar" style="height:0"></div>
<form id="composer" style="height:74px"><div id="composer-tools" style="height:30px"></div></form>
</main></div>
${pickerMarkup}
</div>
<input id="in-message" /><div id="btn-threads"></div><div id="thread-close"></div>
<div id="thread-resizer"></div><div id="thread-composer"></div>
<div id="profile-close"></div><div id="profile-backdrop"></div>
<script>
// The app globals pickers.js expects from the other modules. Nothing here
// reimplements any of the behaviour under test.
window.S = { view:'server', serverId:1, channelId:2, pendingAtts:[], gifFavs:null };
window.$ = (s) => document.querySelector(s);
window.phoneLayout = () => true; window.cfEditable = () => false;
window.closeProfileScreen = () => {}; window.onComposerInput = () => {}; window.onComposerKeydown = () => {};
window.haptic = () => {}; window.toast = () => {};
window.setAttPreview = () => {}; window.renderComposerMeta = () => {}; window.renderThreadComposerMeta = () => {};
window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message || e.error)));
window.esc = (s) => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
window.gifFavMatch = (favs,key,gifUrl) => { const l = favs || window.S.gifFavs || [];
  return l.some(f => f && ((!!key && f.slug===key) || (!!gifUrl && f.gif===gifUrl))); };
window.__gifUrl = (i) => new URL('g.gif?i=' + i, location.href).href;
window.api = async (u) => u === '/api/me/gif-favorites' ? { favorites: [] }
  : { gifs: [1,2,3,4,5,6,7,8].map(i => ({ slug:'g'+i, title:'Gif '+i,
      gif: window.__gifUrl(i), thumb: window.__gifUrl(i), mp4:null, w:4, h:3 })) };
window.__sent = [];
window.sendChat = (t,o) => { window.__sent.push((o.attachments||[]).map(a=>a.gifSlug||a.url).join(',')); };
window.sendDm = () => {};

// __vis is the visible viewport — what the engine reports AND what the reader
// sees. opts.silent is the engine telling the truth with no event at all.
let __vis = ${SCREEN};
const vv = window.visualViewport;
Object.defineProperty(vv, 'height', { configurable: true, get: () => __vis });
Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 });
window.__kb = (h, opts) => {
  opts = opts || {};
  __vis = h;
  document.documentElement.style.setProperty('--vvh', h + 'px');
  if (opts.silent) return;
  vv.dispatchEvent(new Event('resize'));
  window.dispatchEvent(new Event('resize'));
};
window.__focusSearch = () => { const s=document.querySelector('#pk-search'); s.focus();
  s.dispatchEvent(new FocusEvent('focus')); return 1; };
// Tapping a focused input is a tap ON it: the engine drops the caret on
// lift-off. Driven explicitly here, because CDP's synthetic touch does not.
window.__dropCaret = () => { const a=document.activeElement; if (a && a.blur) a.blur(); return 1; };
window.__m = () => { const pk=document.querySelector('#picker'); const r=pk.getBoundingClientRect();
  const vb = Math.min(${SCREEN}, __vis);
  return { top:Math.round(r.top), bottom:Math.round(r.bottom), h:Math.round(r.height),
    visibleBottom: vb, gapToBottom: Math.round(vb - r.bottom),
    fullyOnScreen: r.top >= 0 && r.bottom <= vb + 1,
    keyboardMode: pk.classList.contains('pk-kb'), inlineBottom: pk.style.bottom }; };
window.__open = () => { openPicker('insert', null, 'gifs', null, 'main'); return 1; };
window.__tiles = () => [...document.querySelectorAll('#pk-gifs .pk-gif')].map((t,i) => {
  const r=t.getBoundingClientRect(); const x=Math.round(r.left+r.width/2), y=Math.round(r.top+r.height/2);
  return { i, x, y, top:Math.round(r.top), bottom:Math.round(r.bottom), onScreen: y>=0 && y<=Math.min(${SCREEN},__vis) }; });
window.__at = (x,y) => { const el=document.elementFromPoint(x,y);
  return el ? (el.closest('.pk-gif') ? 'a GIF TILE' : (el.id||el.className||el.tagName).toString()) : 'none'; };
window.__geo = () => { const pk=document.querySelector('#picker');
  const t=document.querySelectorAll('#pk-gifs .pk-gif')[4] || document.querySelector('.pk-gif');
  const r=pk.getBoundingClientRect(); const tr=t?t.getBoundingClientRect():null;
  return { sheetTop:Math.round(r.top), sheetH:Math.round(r.height),
    kbMode:pk.classList.contains('pk-kb'), tileTop: tr&&Math.round(tr.top) }; };
window.__tapLog = [];
for (const type of ['touchstart','touchend','click']) document.addEventListener(type, (e) => {
  window.__tapLog.push(type + (e.target.closest && e.target.closest('.pk-gif') ? ' [on a GIF tile]' : ' [on '
    + ((e.target.id||e.target.className||e.target.tagName)||'').toString().slice(0,18) + ']')
    + ' ' + JSON.stringify(window.__geo()));
}, true);
</scr` + `ipt>
<script>${pickers}</scr` + `ipt>
</body></html>`;

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function cdpConnect(url) {
  const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    let id = 0;
    const pending = new Map();
    ws.on('open', () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          const myId = ++id;
          pending.set(myId, { res, rej });
          ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
        });
      },
      close() { try { ws.close(); } catch {} },
    }));
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message));
        else res(m.result);
      }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('cdp connect timeout')), 15000);
  });
}

async function run() {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/g.gif')) { res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': TINY_GIF.length }); return res.end(TINY_GIF); }
    if (req.url.startsWith('/page.html')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(pageHtml); }
    res.writeHead(404); res.end('no');
  }).listen(0);
  const pagePort = srv.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-pkmin-'));
  const port = 18100 + Math.floor(Math.random() * 500);
  const chrome = spawn(chromePath,
    ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
     `--remote-debugging-port=${port}`, '--user-data-dir=' + path.join(dir, 'prof'),
     `--window-size=390,${SCREEN}`, 'about:blank'], { stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try { const v = await getJson(`http://127.0.0.1:${port}/json/version`); if (v && v.webSocketDebuggerUrl) up = true; } catch {}
      if (!up) await sleepMs(150);
    }
    if (!up) { check(false, 'chrome came up'); return; }
    const list = await getJson(`http://127.0.0.1:${port}/json/list`);
    const page = (list || []).find((t) => t.type === 'page');
    if (!page) { check(false, 'a page target'); return; }
    const cdp = await cdpConnect(page.webSocketDebuggerUrl);
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: SCREEN, deviceScaleFactor: 3, mobile: true });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await cdp.send('Page.enable');
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${pagePort}/page.html` });
      for (let i = 0; i < 50; i++) {
        const r = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
        if (r && r.result && r.result.value === 'complete') break;
        await sleepMs(100);
      }
      await sleepMs(500);
      const ev = async (expr) => {
        const r = await cdp.send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) return { __threw: r.exceptionDetails.exception && (r.exceptionDetails.exception.description || r.exceptionDetails.text) };
        return r.result.value;
      };
      const tap = async (x, y) => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await sleepMs(60);
        await ev('window.__dropCaret(); return 1');
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await sleepMs(700);
      };
      const m = async () => JSON.parse(await ev('return JSON.stringify(window.__m())'));

      const errs = await ev('return window.__errs || []');
      check(!errs.length, 'the page booted clean', errs);

      // ---- the minimize ----
      await ev('window.__open(); await new Promise(r=>setTimeout(r,700)); return 1');
      const closed = await m();
      check(closed.gapToBottom === 0, 'picker open, no keyboard: on the bottom edge', closed);
      await ev(`window.__focusSearch(); window.__kb(${SCREEN-KB_H}); await new Promise(r=>setTimeout(r,500)); return 1`);
      const raised = await m();
      check(raised.keyboardMode === true, 'raising the keyboard: the sheet rides up onto the keys', raised);
      check(raised.gapToBottom === 0, 'its bottom edge is the keyboard\u2019s top edge', raised);
      // The ▼ key: the keys hide, the caret stays exactly where it was, and the
      // engine reports the close once mid-flight and then goes quiet.
      await ev(`window.__kb(${SCREEN-KB_H+180}); await new Promise(r=>setTimeout(r,80)); return 1`);
      await ev(`window.__kb(${SCREEN}, { silent: true }); return 1`);
      await sleepMs(1200);
      const after = await m();
      check(after.keyboardMode === false, 'MINIMIZE: the sheet leaves keyboard mode even though the caret never moved', after);
      check(after.gapToBottom === 0, 'and comes all the way DOWN to the bottom edge', after);
      check(after.h === closed.h, 'back to exactly the height it had before the keyboard came up',
        { beforeTheKeyboard: closed.h, now: after.h });
      check(after.fullyOnScreen, 'and wholly on screen', after);

      // ---- one tap, while searching (the caret is in the field) ----
      await ev(`closePicker(false); window.__open(); await new Promise(r=>setTimeout(r,900));
        const s=document.querySelector('#pk-search'); s.focus(); s.dispatchEvent(new FocusEvent('focus'));
        window.__kb(${SCREEN-KB_H}); await new Promise(r=>setTimeout(r,600));
        s.value='cat'; s.dispatchEvent(new Event('input'));
        await new Promise(r=>setTimeout(r,1000));
        window.__sent.length=0; window.__tapLog.length=0; return 1`);
      const tiles = JSON.parse(await ev('return JSON.stringify(window.__tiles())'));
      const onScreen = tiles.filter((t) => t.onScreen);
      check(onScreen.length > 0, 'there are tiles on screen to tap', { tiles: tiles.length, onScreen: onScreen.length });
      const target = onScreen[Math.min(1, onScreen.length - 1)];
      if (target) {
        check((await ev(`return window.__at(${target.x},${target.y})`)) === 'a GIF TILE',
          'and the point under the finger is a GIF tile');
        await tap(target.x, target.y);
        const sent = JSON.parse(await ev('return JSON.stringify(window.__sent)'));
        const log = JSON.parse(await ev('return JSON.stringify(window.__tapLog)'));
        check(sent.length === 1, 'ONE tap sent the GIF — the reported "had to tap it twice"', { sent, log });
        check(log.some((l) => l.startsWith('click [on a GIF tile]')), 'the click landed on the tile itself', log);
        check(await ev("return document.querySelector('#picker').classList.contains('hidden')"),
          'and the picker closed itself');
        // The sheet must not move between the finger landing and the click.
        const geo = log.map((l) => JSON.parse(l.slice(l.indexOf('{'))));
        const moved = Math.abs(geo[0].sheetTop - geo[geo.length - 1].sheetTop);
        check(moved === 0, 'the sheet did not move between touchstart and the click', { movedPx: moved, log });
        const tileMoved = Math.abs((geo[0].tileTop || 0) - (geo[geo.length - 1].tileTop || 0));
        check(tileMoved === 0, 'so the tile was still under the finger', { movedPx: tileMoved });
      }

      // ---- one tap, keyboard already minimized ----
      await ev(`closePicker(false); window.__open(); window.__focusSearch(); window.__kb(${SCREEN-KB_H});
        await new Promise(r=>setTimeout(r,500));
        window.__kb(${SCREEN-KB_H+180}); await new Promise(r=>setTimeout(r,80));
        window.__kb(${SCREEN}, { silent: true });
        await new Promise(r=>setTimeout(r,1200));
        window.__open(); await new Promise(r=>setTimeout(r,900));
        window.__sent.length=0; window.__tapLog.length=0; return 1`);
      const m2 = await m();
      check(m2.keyboardMode === false, 'the sheet is off the keyboard footing after the minimize', m2);
      const tiles2 = JSON.parse(await ev('return JSON.stringify(window.__tiles())'));
      const on2 = tiles2.filter((t) => t.onScreen);
      if (on2.length) {
        await tap(on2[0].x, on2[0].y);
        const sent2 = JSON.parse(await ev('return JSON.stringify(window.__sent)'));
        check(sent2.length === 1, 'and one tap still sends it with no keyboard involved', sent2);
      }
      const errs2 = await ev('return window.__errs || []');
      check(!errs2.length, 'the page ran clean throughout', errs2);
    } finally { cdp.close(); }
  } finally {
    try { chrome.kill('SIGKILL'); } catch {}
    try { srv.close(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

run().then(finish).catch((e) => { check(false, 'the harness ran', String(e && e.message || e)); finish(); });