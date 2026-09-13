// Launch must not open the on-screen keyboard (see AGENTS.md verification
// conventions).
//
// The complaint: "make sure when the app is opened the keyboard isn't open on
// screen when entering the app on mobile." Nothing in the SPA focuses a field
// at boot — the PLATFORM does it: an Android WebView gives focus to the first
// editable element, Android restores the focus that was live when the app was
// backgrounded, and a reload/bfcache restore re-focuses the composer mid-draft.
// So native.js refuses focus on text fields until the user's own first gesture,
// sweeps a few times across launch, and then disarms for good.
//
// This test runs the REAL guard sliced out of public/js/native.js in headless
// Chrome at a phone viewport: a field the platform focused before the guard
// installed is blurred, focus is refused on every editable while armed, a
// button/checkbox is left alone (the guard is not a focus thief), and one real
// touch disarms it for the rest of the session — the composer then focuses
// exactly as it did before.
//
// Skips (exit 0) when Chrome is unavailable.
//
// Usage: node scripts/test-launch-keyboard.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9353', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' - ' + d : '')); }
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

const nativeJs = fs.readFileSync(path.join(ROOT, 'public/js/native.js'), 'utf8');
// The real guard block: everything from its state down to the end of the file
// (it is the last section), so the test cannot drift from the shipped code.
const GUARD_START = nativeJs.indexOf('let cfGesture = false;');
if (GUARD_START < 0 || !/function cfRefuseLaunchFocus/.test(nativeJs.slice(GUARD_START))) {
  console.error('[test] could not locate the launch-keyboard guard in public/js/native.js');
  process.exit(1);
}
const guardSource = nativeJs.slice(GUARD_START);

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#0e1420}textarea,input,button{display:block;margin:8px;font-size:16px}</style>
</head><body>
<textarea id="ta" rows="2"></textarea>
<input id="txt" />
<input id="cb" type="checkbox" />
<button id="btn">ok</button>
<div id="ce" contenteditable="true" style="width:200px;height:40px;border:1px solid #333"></div>
<script>
// The platform's launch focus: a field holding focus BEFORE the guard installs
// (a WebView first-focus, an Android restore). The guard's launch sweep is what
// has to take it back.
document.getElementById('ta').focus();
window.__preFocus = document.activeElement && document.activeElement.id;
</script>
<script>
${guardSource}
window.__armed = () => !cfGesture;
window.__active = () => {
  const el = document.activeElement;
  if (!el || el === document.body) return 'body';
  return el.id || el.tagName.toLowerCase();
};
window.__focus = (id) => { const el = document.getElementById(id); el.focus(); return window.__active(); };
window.__isCoarseQuery = () => !!(window.matchMedia && matchMedia('(hover: none)').matches);
</script>
</body></html>`;
}

async function main() {
  console.log('\n[0] the guard is wired into the native shell');
  const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  check(/<script src="\/js\/native\.js"><\/script>/.test(index), 'native.js is loaded by the shell');
  check(/isCoarse\(\)/.test(guardSource) && /matchMedia\('\(hover: none\)'\)/.test(guardSource),
    'the guard only arms on a coarse pointer (a desktop reload restoring the caret is a feature)');
  check(/document\.addEventListener\('focusin'[\s\S]{0,220}cfEditable\(e\.target\)[\s\S]{0,80}blur\(\)/.test(guardSource),
    'while armed, any focus landing on a text field is refused');
  check(/for \(const ev of \['pointerdown', 'touchstart', 'mousedown', 'keydown', 'wheel'\]\)/.test(guardSource),
    'and the first real gesture disarms it');
  check(/\{ capture: true, passive: true \}/.test(guardSource), 'in the capture phase, so the gesture that focuses a field is already accounted for');
  check(/for \(const ms of \[0, 60, 250, 800, 2000\]\)/.test(guardSource),
    'plus timed sweeps, because platform focus does not arrive at one predictable moment');
  check(/window\.addEventListener\('pageshow', cfRefuseLaunchFocus\)/.test(guardSource),
    'and a bfcache/back restore is swept too');
  check(/el\.tagName === 'TEXTAREA'/.test(guardSource) && /el\.isContentEditable === true/.test(guardSource),
    'a textarea and a contenteditable count as editable');
  check(/el\.tagName === 'INPUT'[\s\S]{0,160}button\|checkbox/.test(guardSource),
    'a button/checkbox/radio is never treated as a field');
  check(/removeAllRanges/.test(guardSource), 'and the selection is dropped with the focus');

  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-launch-kb-'));
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml());
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;

  const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
    '--window-size=420,760', 'about:blank'], { stdio: 'ignore' });

  let ws = null;
  try {
    let info = null;
    for (let i = 0; i < 60 && !info; i++) {
      try { info = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); } catch { await sleep(250); }
    }
    if (!info) return skip('Chrome never opened its DevTools port');

    ws = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 128 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0; const pending = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const call = (method, params, sessionId) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
      ws.send(JSON.stringify({ id: i, sessionId, method, params }));
    });
    const targetId = (await call('Target.createTarget', { url: 'about:blank' })).targetId;
    const sessionId = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    const sess = (m, p) => call(m, p, sessionId);
    const evaluate = async (expression) => {
      const r = await sess('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'page error');
      return r.result.value;
    };

    await sess('Page.enable');
    await sess('Runtime.enable');
    // A phone: touch emulation is what makes the guard's coarse-pointer gate
    // true, exactly like the real device it exists for.
    await sess('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await sess('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
    await sess('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
    await sleep(400);
    if (!(await evaluate('typeof window.__armed === "function"'))) {
      console.error('[test] the extracted native.js guard did not evaluate in the page');
      process.exit(1);
    }

    console.log('\n[1] the platform-focused field is released before the app is usable');
    check(await evaluate('window.__isCoarseQuery()'), 'the emulated phone reports a coarse pointer (the guard armed)');
    check((await evaluate('window.__preFocus')) === 'ta', 'the field really was focused before the guard installed', await evaluate('window.__preFocus'));
    check((await evaluate('window.__active()')) === 'body', 'and the launch sweep dropped it, so no keyboard can be up');
    check(await evaluate('window.__armed()'), 'the guard is still armed (no gesture yet)');

    console.log('\n[2] while armed, a text field cannot take focus');
    check((await evaluate("window.__focus('ta')")) === 'body', 'a textarea refuses focus');
    check((await evaluate("window.__focus('txt')")) === 'body', 'and so does a text input');
    check((await evaluate("window.__focus('ce')")) === 'body', 'and a contenteditable');
    check((await evaluate("window.__focus('btn')")) === 'btn', 'a button keeps focus (the guard is not a focus thief)');
    check((await evaluate("window.__focus('cb')")) === 'cb', 'and so does a checkbox');

    console.log('\n[3] the first real gesture disarms it, permanently');
    await sess('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 12, y: 200 }] });
    await sess('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(80);
    check(!(await evaluate('window.__armed()')), 'a touch disarms the guard');
    check((await evaluate("window.__focus('ta')")) === 'ta', 'and the composer then focuses normally (typing still works)');
    check((await evaluate("window.__focus('txt')")) === 'txt', 'as does every other field, including one opened later');

    console.log('\n[4] a second launch would arm again (the sweep is not one-shot state)');
    check(/let cfGesture = false;/.test(guardSource), 'the state starts disarmed per document load');
  } catch (e) {
    console.error('[test] ' + (e && e.stack || e));
    process.exit(1);
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome.kill(); } catch {}
    try { srv.close(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
