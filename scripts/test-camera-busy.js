// The camera button spins while the camera is opening.
//
// Tapping the camera button in a call used to be dead air for as long as
// getUserMedia took (permission prompt + sensor warm-up) and then a beat more
// while the first frame painted into the local tile. The button now carries a
// spinner for that whole stretch: `camBusy` (public/js/voice.js) drives a
// `.busy` class on all three camera buttons (#btn-camera / #vf-camera /
// #cv-camera) from paintVoiceControls, and the icon gives way to the shared
// up-spin ring.
//
// Offline: the REAL paintVoiceControls is sliced out of public/js/voice.js and
// run against a fake DOM (the same shape as the shipped buttons) across the
// idle / starting / on states, plus static checks on the toggleCamera guard
// and clear paths (a busy flag that never clears — or clears only on the happy
// path — is exactly how a button parks on a spinner forever) and on the
// stylesheet, including `camBusy` being declared before the top-level
// paintVoiceControls() call (a `let` below it is a TDZ ReferenceError on boot).
//
// Then the real markup + stylesheet in headless Chrome (skips without Chrome):
// the icon is gone, the ::after ring is a 14px circle running the shared
// animation, it sits inside the button's own box, and the box does not move —
// plus a screenshot for eyeballing.
//
// Usage: node scripts/test-camera-busy.js

'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9351', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}
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

const voice = fs.readFileSync(path.join(ROOT, 'public/js/voice.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

// ---------- fake DOM so the real paintVoiceControls can run ----------
const CAM = ['#btn-camera', '#vf-camera', '#cv-camera'];
function fakeEl() {
  const set = new Set();
  return {
    classList: {
      toggle: (c, on) => { if (on) set.add(c); else set.delete(c); },
      has: (c) => set.has(c),
      _set: set,
    },
    title: '',
    innerHTML: '',
  };
}
const els = new Map();
for (const id of ['#btn-mute', '#me-mute', '#vf-mute', '#cv-mute', '#btn-deafen', '#me-deafen', '#vf-deafen', '#cv-deafen',
  '#btn-share', '#vf-share', '#cv-share', ...CAM]) els.set(id, fakeEl());
global.$ = (sel) => els.get(sel) || null;
global.selfVoicePrefs = () => ({ muted: false, deafened: false });
global.ME_SVG = { mic: '<svg id="mic"></svg>', micOff: '<svg id="micOff"></svg>', deaf: '<svg id="deaf"></svg>', deafOff: '<svg id="deafOff"></svg>' };
global.S = { voice: null, me: { id: 'me' } };

let camBusy = false; // the real flag lives in voice.js; this mirrors it for the slice
const paintSrc = slice(voice, 'function paintVoiceControls() {', '\nfunction applyMicState() {');
if (!/camBusy/.test(paintSrc)) { console.error('[test] paintVoiceControls no longer reads camBusy'); process.exit(1); }
// eslint-disable-next-line no-eval
const { paintVoiceControls } = eval(paintSrc + '\n;({ paintVoiceControls })');

function camState() {
  return CAM.map((id) => {
    const b = els.get(id);
    return { id, busy: b.classList.has('busy'), off: b.classList.has('off'), title: b.title };
  });
}

(async () => {
  console.log('\n[1] the camera buttons render the busy state');
  camBusy = false;
  S.voice = null;
  paintVoiceControls();
  check(camState().every((b) => !b.busy && b.off), 'outside a call the camera buttons are plain off buttons (no spinner)', camState());

  camBusy = true;
  paintVoiceControls();
  let st = camState();
  check(st.every((b) => b.busy), 'all three camera buttons spin while the camera opens', st);
  check(st.every((b) => !b.off), 'the busy button is not painted as "off" (red)', st);
  check(st.every((b) => b.title === 'Starting camera…'), 'the tooltip says it is starting', st);

  camBusy = false;
  S.voice = { cameraOn: true, muted: false, deafened: false, sharing: false, quality: 'high' };
  paintVoiceControls();
  st = camState();
  check(st.every((b) => !b.busy && !b.off), 'with the camera on the buttons go back to the normal on state', st);
  check(st.every((b) => b.title === 'Turn camera off'), 'and the tooltip flips to "turn off"', st);

  console.log('\n[2] the busy flag cannot park or leak');
  check(/if \(!S\.voice \|\| camBusy\) return;/.test(voice), 'toggleCamera refuses a second tap while the camera is opening');
  check(/camBusy = true;\r?\n\s*paintVoiceControls\(\);/.test(voice), 'it paints the spinner before awaiting getUserMedia');
  check(/catch \{ camBusy = false; paintVoiceControls\(\); toast\('Camera blocked/.test(voice), 'a blocked camera clears the spinner before toasting');
  check(/if \(!S\.voice\) \{[\s\S]{0,220}camBusy = false;[\s\S]{0,80}return;\r?\n\s*\}/.test(voice), 'leaving the call mid-prompt drops the camera and clears the spinner');
  check(/await camWaitFirstFrame\(cam\);\r?\n\s*camBusy = false;\r?\n\s*paintVoiceControls\(\);/.test(voice), 'the spinner clears once the first frame lands');
  const wait = slice(voice, 'function camWaitFirstFrame(ms) {', '\nasync function toggleCamera() {');
  check(/setTimeout\(fin, 3000\)/.test(wait), 'a stalled camera cannot hold the spinner past its cap');
  check(/removeEventListener\('loadeddata', fin\)/.test(wait) && /removeEventListener\('playing', fin\)/.test(wait), 'its listeners are torn down on both exits');
  check(/leaveVoice\(silent\) \{[\s\S]{0,1400}camBusy = false;/.test(voice), 'leaving the call clears the flag even while the first-frame wait is pending');

  console.log('\n[3] declaration order (the TDZ that would break boot)');
  const decl = voice.indexOf('let camBusy = false;');
  const firstPaint = voice.indexOf('\npaintVoiceControls();');
  check(decl > 0 && firstPaint > 0 && decl < firstPaint, 'camBusy is declared before the top-level paintVoiceControls() call', { decl, firstPaint });

  console.log('\n[4] stylesheet');
  check(/\.vb-btn\.busy svg\{display:none\}/.test(css), 'the busy button hides its icon');
  const rule = (/\.vb-btn\.busy::after\{([^}]*)\}/.exec(css) || [])[1] || '';
  check(/width:14px;height:14px/.test(rule) && /border-radius:50%/.test(rule), 'the spinner is a 14px circle', rule);
  check(/animation:up-spin \.8s linear infinite/.test(rule), 'it runs the shared up-spin animation', rule);
  check(/\.vb-btn\.big\.busy::after\{[^}]*width:18px;height:18px/.test(css), 'the bigger call-view button gets a bigger ring');
  check(/\.vb-btn\.busy::after,/.test(css), 'reduced motion turns the spinner animation off');
  check(/\.vb-btn\.busy\{cursor:default\}/.test(css), 'the busy button does not advertise a cursor pointer click');

  // ---------- headless Chrome: the painting ----------
  const chromePath = findChrome();
  if (!chromePath) {
    console.log('\n[test] SKIP browser half: no Chrome/Edge found (set CHROME_PATH)');
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cam-busy-'));
    const bars = slice(index, '<div id="voice-bar" class="hidden">', '<div id="me-card">');
    const fab = slice(index, '<div id="voice-fab" class="hidden">', '<div id="attach-preview"');
    const controls = (/<div id="stage-controls"[\s\S]*?<\/div>/.exec(index) || [''])[0];
    const svgs = slice(voice, 'const VB_SVG = {', '};') + '};';
    const page = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style>
<style>html,body{margin:0;background:#0e1420}#voice-bar,.hidden{display:block!important}
#voice-bar{padding:12px}#voice-fab{padding:12px}#stage-controls{padding:12px;display:block}</style>
</head><body>
<div id="host">${bars}${fab}<div id="stage">${controls}</div></div>
<script>
${svgs}
for (const [id, svg] of [['#btn-camera', VB_SVG.cam], ['#vf-camera', VB_SVG.cam], ['#cv-camera', VB_SVG.cam]]) {
  const b = document.querySelector(id); if (b) b.innerHTML = svg;
}
window.__state = function (id) {
  const b = document.querySelector(id);
  const svg = b.querySelector('svg');
  const after = getComputedStyle(b, '::after');
  const br = b.getBoundingClientRect();
  const sr = svg.getBoundingClientRect();
  const cs = getComputedStyle(b);
  const ar = after.width ? parseFloat(after.width) : 0;
  return {
    busy: b.classList.contains('busy'), off: b.classList.contains('off'),
    svgDisplay: getComputedStyle(svg).display,
    svgBox: [Math.round(sr.width * 100) / 100, Math.round(sr.height * 100) / 100],
    after: { content: after.content, w: after.width, h: after.height, radius: after.borderRadius, anim: after.animationName, dur: after.animationDuration, top: after.borderTopColor },
    box: [Math.round(br.width), Math.round(br.height), Math.round(br.left), Math.round(br.top)],
    bg: cs.backgroundColor, cursor: cs.cursor,
    ringInside: ar > 0 && ar <= br.width,
  };
};
window.__toggle = function (on) {
  for (const id of ['#btn-camera', '#vf-camera', '#cv-camera']) {
    const b = document.querySelector(id);
    b.classList.toggle('busy', on);
    b.classList.toggle('off', !on);
  }
};
</script></body></html>`;

    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page);
    });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const port = server.address().port;

    const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
      '--hide-scrollbars', '--window-size=520,700', 'about:blank'], { stdio: 'ignore' });

    let ws;
    try {
      let info = null;
      for (let i = 0; i < 60 && !info; i++) {
        try { info = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); } catch { await sleep(250); }
      }
      if (!info) return skip('Chrome never opened its DevTools port');

      ws = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
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
      await sess('Emulation.setDeviceMetricsOverride', { width: 420, height: 700, deviceScaleFactor: 2, mobile: true });
      await sess('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
      await sleep(400);

      console.log('\n[5] the painted spinner (headless Chrome)');
      const before = await evaluate('window.__state("#btn-camera")');
      await evaluate('document.querySelector("#btn-camera").classList.add("off")');
      await sleep(400); // .vb-btn transitions its background — read settled colours
      const off = await evaluate('window.__state("#btn-camera")');
      await evaluate('window.__toggle(true)');
      await sleep(400);
      const busy = await evaluate('window.__state("#btn-camera")');
      const busyVf = await evaluate('window.__state("#vf-camera")');
      const busyCv = await evaluate('window.__state("#cv-camera")');
      check(before.svgBox[0] > 0 && busy.svgBox[0] === 0, 'the icon is rendered, then gone while busy', { before: before.svgBox, busy: busy.svgBox });
      check(busy.after.content !== 'none' && busy.after.w === '14px', 'the ::after ring is painted at 14px', busy.after);
      check(busy.after.radius === '50%', 'the ring is round', busy.after);
      check(busy.after.anim === 'up-spin' && busy.after.dur === '0.8s', 'it runs the shared up-spin animation', busy.after);
      check(busy.ringInside, 'the ring fits inside the button box', busy);
      check(busy.busy && !busy.off && busy.bg === before.bg && busy.bg !== off.bg, 'the busy button drops the off colour but keeps its own surface', { before: before.bg, off: off.bg, busy: busy.bg });
      check(busyCv.after.anim === 'up-spin' && busyVf.after.anim === 'up-spin', 'the fab + call-view buttons paint the same ring', { vf: busyVf.after, cv: busyCv.after });
      check(busyCv.after.w === '18px' && busyVf.after.w === '14px', 'the big call-view button scales its ring up', { cv: busyCv.after.w, vf: busyVf.after.w });
      // The button must not resize when it swaps icon → spinner.
      const afterBox = (await evaluate('window.__state("#btn-camera")')).box;
      check(afterBox[0] === before.box[0] && afterBox[1] === before.box[1], 'the button box does not change size', { before: before.box, after: afterBox });

      try {
        const shot = (await sess('Page.captureScreenshot', { format: 'png' })).data;
        const out = path.join(os.tmpdir(), 'campfire-camera-busy.png');
        fs.writeFileSync(out, Buffer.from(shot, 'base64'));
        console.log('  (wrote ' + out + ')');
      } catch {}
    } catch (e) {
      console.error('[test] ' + ((e && e.stack) || e));
      failures.push('browser half threw: ' + ((e && e.message) || e));
    } finally {
      try { ws && ws.close(); } catch {}
      try { chrome.kill(); } catch {}
      try { server.close(); } catch {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  console.log('');
  if (failures.length) {
    console.log('[test] ' + failures.length + ' FAILED, ' + passed + ' passed');
    for (const f of failures) console.log('   - ' + f);
    process.exit(1);
  }
  console.log('[test] all ' + passed + ' checks passed');
})();
