// The phone picker rides above the keyboard while its search field is focused
// (the .pk-kb slide-up), and must come back DOWN when the keyboard goes away.
//
// Static half (always runs): the settle pass exists — a keyboard transition is
// an animation (~250ms) but some WebViews report it with a single resize/blur
// at the START, so the measurement taken then is mid-flight and, with no
// further events, the sheet parks at the keyboard's half-gone height and never
// comes back down (owner report: "if you drop the keyboard back down the
// picker never lowers back down properly"). The settle re-measures once the
// animation has surely finished, from every signal a transition produces.
//
// Chrome half (skips without Chrome): the REAL pickers.js, the REAL
// styles.css and the REAL #picker markup, at a 390px mobile viewport, with the
// visual viewport shadowed so a keyboard can be raised and lowered on demand.
// It walks the reported scenario — keyboard up (the good shift), then keyboard
// down with ONE mid-flight resize and silence after — and asserts the picker
// is still floating at the stale height before the settle fires, and back at
// the bottom edge after it. Driven over CDP (--dump-dom hangs on this
// machine's Chromium; remote debugging is the working path).
//
// Usage: node scripts/test-picker-keyboard-settle.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/opt/meta-chromium/chrome',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}
function finish() {
  console.log('\n' + (failures.length ? 'FAILED: ' + failures.length : 'OK') + ' — ' + passed + ' checks passed');
  process.exit(failures.length ? 1 : 0);
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const n = (s) => s.replace(/\r\n/g, '\n');

console.log('\n[1] the settle pass exists in the source');
check(/function settlePickerKeyboard\(\) \{/.test(n(pickers)), 'settlePickerKeyboard is defined');
const paintBlock = (n(pickers).match(/function paintPickerKeyboard\(\) \{[\s\S]*?\n\}/) || [])[0] || '';
check(/settlePickerKeyboard\(\);/.test(paintBlock), 'every focus/blur re-check schedules the settle', paintBlock.slice(0, 200));
const syncBlock = (n(pickers).match(/const sync = \(\) => \{[\s\S]*?\n  \};/) || [])[0] || '';
check(/settlePickerKeyboard\(\);/.test(syncBlock), 'every visual-viewport sync schedules the settle too', syncBlock.slice(0, 300));
const settleBlock = (n(pickers).match(/function settlePickerKeyboard\(\) \{[\s\S]*?\n\}/) || [])[0] || '';
check(/}, 400\);/.test(settleBlock), 'it waits out the keyboard animation (400ms)', settleBlock.slice(-60));
check(/pk-resizing/.test(settleBlock), 'it never fights a drag-resize in progress', settleBlock.slice(0, 400));
check(/classList\.contains\('hidden'\)/.test(settleBlock), 'it stands down when the picker is closed', settleBlock.slice(0, 400));
check(/setProperty\('--kb', keyboardOffset\(\) \+ 'px'\)/.test(settleBlock) &&
      /setProperty\('--vv-top'/.test(settleBlock) && /setProperty\('--vvh'/.test(settleBlock),
  'it re-syncs --kb, --vv-top and --vvh from live geometry');
check(/try \{ sizePicker\(\); \} catch \{\}/.test(settleBlock), 'then re-runs sizePicker on the settled numbers');

console.log('\n[2] the close path still clears the keyboard footing immediately');
const sizeBlock = (n(pickers).match(/function sizePicker\(\) \{[\s\S]*?\n\}\n/) || [])[0] || '';
check(/pk\.style\.bottom = ''/.test(sizeBlock), 'sizePicker drops the inline bottom when pk-kb is off');

const chromePath = findChrome();
if (!chromePath) {
  console.log('\n[3] the keyboard walk in a browser — SKIPPED (no Chrome/Edge found; set CHROME_PATH)');
  finish();
}

// The real #picker markup, verbatim from index.html.
const pickerMarkup = (() => {
  const src = n(index);
  const a = src.indexOf('<div id="picker"');
  const b = src.indexOf('<!-- user card -->', a);
  return src.slice(a, b).replace('class="hidden"', '');
})();

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,interactive-widget=resizes-content">
<title>picker-kb</title>
<style>${n(css)}</style>
</head><body style="margin:0">
<div id="composer" style="height:74px"></div>
<div id="typing-bar" style="height:0"></div>
${pickerMarkup}
<div id="profile-close"></div><div id="profile-backdrop"></div><input id="in-message">
<div id="btn-threads"></div><div id="thread-close"></div><div id="thread-resizer"></div><div id="thread-composer"></div>
<script>
// The app globals pickers.js expects from the other modules.
window.S = {};
window.$ = (s) => document.querySelector(s);
window.phoneLayout = () => true;
window.cfEditable = () => false;
window.closeProfileScreen = () => {};
window.onComposerInput = () => {};
window.onComposerKeydown = () => {};
window.__errs = [];
window.addEventListener('error', (e) => window.__errs.push(String(e.message || e.error)));
// A scriptable keyboard: the visual-only model (the layout box keeps its
// height and the keys cover the bottom of it), which is the model whose
// close path depends on a settle measurement.
let __vvh = 700, __vvo = 0;
Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => __vvh });
Object.defineProperty(window.visualViewport, 'offsetTop', { configurable: true, get: () => __vvo });
const vvResize = () => window.visualViewport.dispatchEvent(new Event('resize'));
</scr` + `ipt>
<script>${n(pickers)}</scr` + `ipt>
</body></html>`;
}

// The scenario, run inside the page. Returns its measurements.
const SCENARIO = `async () => {
  const out = { errs: window.__errs };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pk = document.querySelector('#picker');
  const kbVar = () => getComputedStyle(document.documentElement).getPropertyValue('--kb').trim();
  out.vw = window.innerWidth;
  out.kbStart = keyboardOffset();

  // Keyboard down, picker open: parked on the bottom edge.
  sizePicker();
  out.openBottom = getComputedStyle(pk).bottom;

  // Keyboard OPENS: search focused, visual viewport shrinks to 400px.
  // (In headless CDP the window is unfocused so .focus() sets activeElement
  // without dispatching the event; a real device fires it, so we do too.)
  const __s = document.querySelector('#pk-search');
  __s.focus();
  __s.dispatchEvent(new FocusEvent('focus'));
  __vvh = 400; vvResize();
  await sleep(150);
  out.kbUpInline = pk.style.bottom;
  out.kbUpClass = pk.classList.contains('pk-kb');
  out.kbUpVar = kbVar();

  // Keyboard CLOSES, badly: blur fires, ONE resize lands mid-flight (556px,
  // so --kb measures 144px), and then the WebView goes silent — the keyboard
  // is fully gone (700px) but nothing says so.
  document.querySelector('#pk-search').blur();
  __s.dispatchEvent(new FocusEvent('blur'));
  __vvh = 556; vvResize();
  await sleep(150);
  __vvh = 700;
  out.stuckBottom = getComputedStyle(pk).bottom;
  out.stuckVar = kbVar();
  out.stuckInline = pk.style.bottom;
  out.stuckClass = pk.classList.contains('pk-kb');

  // The settle pass fires ~400ms after the last signal and re-measures.
  await sleep(700);
  out.settledBottom = getComputedStyle(pk).bottom;
  out.settledVar = kbVar();
  out.settledClass = pk.classList.contains('pk-kb');
  out.errs = window.__errs;
  return out;
}`;

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// Minimal CDP client over the ws module (a campfire dependency).
function cdpConnect(url) {
  const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    let id = 0;
    const pending = new Map();
    ws.on('open', () => {
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            const myId = ++id;
            pending.set(myId, { res, rej });
            ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
          });
        },
        close() { try { ws.close(); } catch {} },
      });
    });
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

async function runBrowser() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-picker-kb-'));
  fs.writeFileSync(path.join(dir, 'page.html'), pageHtml());
  const port = 19321 + Math.floor(Math.random() * 500);
  const chrome = spawn(chromePath,
    ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
     `--remote-debugging-port=${port}`, '--user-data-dir=' + path.join(dir, 'prof'), 'about:blank'],
    { stdio: 'ignore' });
  try {
    let ep = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      try {
        const v = await getJson(`http://127.0.0.1:${port}/json/version`);
        if (v && v.webSocketDebuggerUrl) { ep = v; break; }
      } catch {}
      await sleepMs(150);
    }
    if (!ep) return { err: 'no devtools endpoint' };
    const list = await getJson(`http://127.0.0.1:${port}/json/list`);
    const page = (list || []).find((t) => t.type === 'page');
    if (!page || !page.webSocketDebuggerUrl) return { err: 'no page target' };
    const cdp = await cdpConnect(page.webSocketDebuggerUrl);
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride',
        { width: 390, height: 700, deviceScaleFactor: 2, mobile: true });
      await cdp.send('Page.enable');
      await cdp.send('Page.navigate', { url: 'file://' + path.join(dir, 'page.html') });
      // Wait for the page to settle, then run the scenario.
      for (let i = 0; i < 50; i++) {
        const r = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
        if (r && r.result && r.result.value === 'complete') break;
        await sleepMs(100);
      }
      await sleepMs(300);
      const r = await cdp.send('Runtime.evaluate',
        { expression: `(${SCENARIO})()`, awaitPromise: true, returnByValue: true });
      const val = r && r.result && r.result.value;
      if (val) return val;
      if (r && r.result && r.result.subtype === 'error')
        return { err: 'scenario threw: ' + r.result.description };
      return { err: 'no scenario result' };
    } finally {
      cdp.close();
    }
  } finally {
    try { chrome.kill('SIGKILL'); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  console.log('\n[3] the keyboard walk in a browser');
  let out;
  try {
    out = await runBrowser();
  } catch (e) {
    check(false, 'the harness ran', String(e && e.message || e));
    finish();
  }
  if (!out || out.err) { check(false, 'the harness ran', out && out.err); finish(); }
  if (out.errs && out.errs.length) { check(false, 'the page ran clean', out.errs.slice(0, 3)); finish(); }
  check(out.vw === 390, 'the phone pass really is 390px wide', out.vw);
  check(out.kbStart === 0, 'keyboardOffset reads 0 with the keyboard down', out.kbStart);
  check(out.openBottom === '0px', 'picker open, keyboard down: parked on the bottom edge', out.openBottom);
  check(out.kbUpClass === true, 'search focused: the sheet takes its .pk-kb keyboard mode', out.kbUpClass);
  check(out.kbUpInline === '300px', 'keyboard up: the sheet is parked 300px up, on the keys\u2019 top edge', out.kbUpInline);
  check(out.kbUpVar === '300px', '--kb tracks the measured keyboard height', out.kbUpVar);
  // The reported bug, frozen mid-flight: one resize at 556px, then silence.
  check(out.stuckBottom === '144px', 'keyboard dropped with no final event: the sheet is still floating at the stale 144px', out.stuckBottom);
  check(out.stuckVar === '144px', 'on the stale --kb, not the real (gone) keyboard', out.stuckVar);
  check(out.stuckClass === false && out.stuckInline === '', 'blur already dropped the class and the inline footing — the var is what holds it up', { c: out.stuckClass, i: out.stuckInline });
  // The fix: the settle pass re-measures after the animation.
  check(out.settledBottom === '0px', 'after the settle: the sheet is back on the bottom edge', out.settledBottom);
  check(out.settledVar === '0px', '--kb re-measured at 0 once the keys were gone', out.settledVar);
  check(out.settledClass === false, 'and it never re-entered keyboard mode', out.settledClass);
  finish();
})().catch((e) => { check(false, 'the harness ran', String(e && e.message || e)); finish(); });
