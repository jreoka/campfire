// Video attachments must not preview as the browser's "no frame yet"
// placeholder (see AGENTS.md verification conventions).
//
// The complaint: on mobile a just-loaded video sat as a grey slab with a big
// play button until the captured poster frame landed — it read as a broken
// attachment. The wrap now starts life with `.loading`: the element is hidden
// behind a dark panel with a spinner, and it is revealed when the poster
// arrives. The spinner is also the play affordance it replaced — tapping it
// reveals the element and starts playback, so a slow capture never holds
// playback hostage.
//
// Runs the REAL attachmentHTML video branch plus the REAL poster block pulled
// out of public/js/messages.js against the REAL styles.css in headless Chrome
// (skips without Chrome; generates its own mp4 with ffmpeg and skips without
// it), and pins:
//   - the video is invisible and the overlay covers its box exactly, with the
//     overlay (not the native play button) on top of the centre hit test;
//   - once the poster frame is captured the video is revealed, carries a
//     data: poster and the overlay is gone (the happy path the app drives);
//   - a capture that fails (404) still reveals the element instead of leaving
//     a permanent spinner;
//   - tapping the spinner on a slow-loading video reveals it immediately;
//   - the stylesheet keeps the hiding rule and honours reduced motion.
//
// Usage: node scripts/test-video-placeholder.js

'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9341', 10);

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

const messages = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

// The real markup generator (attachmentHTML and the helpers it needs) and the
// real poster block — no re-typed copies, so a regression in either is caught.
const MARK_START = messages.indexOf('const DL_ICON =');
const MARK_END = messages.indexOf('// ---------- video posters:');
const POST_START = MARK_END;
const POST_END = messages.indexOf('// ---------- stick-to-bottom on media resize ----------');
if (MARK_START < 0 || MARK_END < 0 || POST_START < 0 || POST_END < 0) {
  console.error('[test] could not locate the attachmentHTML / video-poster blocks in public/js/messages.js');
  process.exit(1);
}
const markSource = messages.slice(MARK_START, MARK_END);
const postSource = messages.slice(POST_START, POST_END);
if (!/function attachmentHTML/.test(markSource) || !/function ensureVideoPoster/.test(postSource) || !/function revealVideoShell/.test(postSource)) {
  console.error('[test] the extracted blocks are incomplete');
  process.exit(1);
}

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>${css}</style>
<style>html,body{margin:0;background:#0e1420}</style>
</head><body>
<div id="host" style="padding:12px;display:flex;flex-direction:column;align-items:flex-start;gap:16px"></div>
<script>
// Stand-ins for the module globals attachmentHTML only touches in branches we
// never call (plus esc/toast, which the video branch does use).
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtSize() { return '1 KB'; }
function toast() {}
function audioPlayerHTML() { return ''; }
function textPreviewable() { return false; }
function textFileHTML() { return ''; }
${markSource}
${postSource}
window.__mk = function (url) {
  const host = document.getElementById('host');
  const d = document.createElement('div');
  d.innerHTML = attachmentHTML({ kind: 'video', url, name: 'clip.mp4', size: 1234, spoiler: false });
  const wrap = d.firstElementChild;
  host.appendChild(wrap);
  return wrap;
};
window.__state = function (wrap) {
  const vid = wrap.querySelector('video.att-vid');
  const load = wrap.querySelector('.att-vid-load');
  const wr = wrap.getBoundingClientRect();
  const vr = vid.getBoundingClientRect();
  const lr = load.getBoundingClientRect();
  const box = (r) => [Math.round(r.left * 100) / 100, Math.round(r.top * 100) / 100, Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100];
  const cx = Math.round(vr.left + vr.width / 2), cy = Math.round(vr.top + vr.height / 2);
  const top = document.elementFromPoint(cx, cy);
  const over = (el) => !!(el && el.closest && el.closest('.att-vid-load'));
  return {
    loading: wrap.classList.contains('loading'),
    vis: getComputedStyle(vid).visibility,
    loadDisplay: getComputedStyle(load).display,
    loadTag: load.tagName,
    poster: (vid.poster || '').slice(0, 24),
    hasPoster: /^data:image/.test(vid.poster || ''),
    box: { w: Math.round(vr.width), h: Math.round(vr.height) },
    rects: { wrap: box(wr), video: box(vr), load: box(lr) },
    // The overlay must cover the video's box exactly, and it (or its spinner)
    // must be what a tap in the middle lands on — never the native control.
    covers: Math.abs(lr.left - vr.left) < 1.5 && Math.abs(lr.top - vr.top) < 1.5
      && Math.abs(lr.width - vr.width) < 1.5 && Math.abs(lr.height - vr.height) < 1.5,
    hitOverlay: over(top),
    hitVideo: top === vid,
  };
};
window.__clickLoad = function (wrap) {
  const load = wrap.querySelector('.att-vid-load');
  load.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};
</script>
</body></html>`;
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const probe = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' });
  if (probe.error) return skip('ffmpeg not found (set FFMPEG_PATH)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-vid-ph-'));
  const mp4 = path.join(dir, 'test.mp4');
  const gen = spawnSync(ffmpeg, [
    '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15',
    '-t', '2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4,
  ], { stdio: 'inherit' });
  if (gen.status !== 0 || !fs.existsSync(mp4)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return skip('ffmpeg could not generate a test clip');
  }

  // A tiny same-origin static server: the canvas poster capture must not be
  // tainted, and /slow.mp4 keeps a capture in flight for the tap-to-play check.
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/' || url === '/index.html') {
      const body = pageHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
      return;
    }
    if (url === '/test.mp4' || url === '/slow.mp4') {
      const send = () => {
        const stat = fs.statSync(mp4);
        const range = req.headers.range;
        const m = range && /bytes=(\d*)-(\d*)/.exec(range);
        if (m) {
          const start = m[1] ? parseInt(m[1], 10) : 0;
          const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
          res.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
          fs.createReadStream(mp4, { start, end }).pipe(res);
        } else {
          res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': stat.size });
          fs.createReadStream(mp4).pipe(res);
        }
      };
      if (url === '/slow.mp4') setTimeout(send, 4000); else send();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('nope');
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;

  const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--window-size=520,640', 'about:blank'], { stdio: 'ignore' });

  let ws;
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
    await sess('Emulation.setDeviceMetricsOverride', { width: 420, height: 620, deviceScaleFactor: 2, mobile: true });
    await sess('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
    await sleep(700);
    if (!(await evaluate('typeof window.__mk === "function"'))) {
      console.error('[test] the extracted messages.js code did not evaluate in the page');
      process.exit(1);
    }

    console.log('\n[1] a fresh video is hidden behind the spinner, with no native play button reachable');
    await evaluate('window.__mk("/test.mp4")');
    await sleep(120);
    let s = await evaluate('window.__state(document.querySelector(".att-wrap"))');
    check(s.loading, 'the wrap starts in the loading state', s);
    check(s.vis === 'hidden', 'the video element is hidden while the poster is captured', s);
    check(s.loadDisplay === 'flex', 'the loading overlay is shown', s);
    check(s.loadTag === 'BUTTON', 'the overlay is a real button (keyboard-operable)', s);
    check(s.covers, 'the overlay covers the video box exactly', s);
    check(s.hitOverlay && !s.hitVideo, 'a tap in the middle lands on the overlay, not the native control', s);
    check(!s.hasPoster, 'no poster has been captured yet at this point', s);
    // A visual artifact for eyeballing the loading panel (temp dir).
    try {
      const shot = (await sess('Page.captureScreenshot', { format: 'png' })).data;
      const out = path.join(os.tmpdir(), 'campfire-video-placeholder.png');
      fs.writeFileSync(out, Buffer.from(shot, 'base64'));
      console.log('  (wrote ' + out + ')');
    } catch {}

    console.log('\n[2] the captured poster reveals the video');
    await evaluate('ensureVideoPoster(document.querySelector("video.att-vid"))');
    let revealed = false;
    for (let i = 0; i < 40 && !revealed; i++) { await sleep(150); revealed = !(await evaluate('document.querySelector(".att-wrap").classList.contains("loading")')); }
    s = await evaluate('window.__state(document.querySelector(".att-wrap"))');
    check(revealed, 'the wrap leaves the loading state once the frame is captured', s);
    check(s.hasPoster, 'the video carries a captured data: poster', s);
    check(s.vis !== 'hidden', 'the video element is revealed', s);
    check(s.loadDisplay === 'none', 'the overlay is gone', s);
    check(s.box.w > 40 && s.box.h > 40, 'the video box has real size', s);

    console.log('\n[3] a capture that fails still reveals the element');
    await evaluate('window.__mk("/missing.mp4")');
    await evaluate('ensureVideoPoster(document.querySelectorAll("video.att-vid")[1])');
    let failedRevealed = false;
    for (let i = 0; i < 30 && !failedRevealed; i++) { await sleep(150); failedRevealed = !(await evaluate('document.querySelectorAll(".att-wrap")[1].classList.contains("loading")')); }
    s = await evaluate('window.__state(document.querySelectorAll(".att-wrap")[1])');
    check(failedRevealed, 'a failed capture falls back to the native preview instead of a stuck spinner', s);
    check(s.vis !== 'hidden', 'the video is visible after the failure', s);

    console.log('\n[4] tapping the spinner on a slow video starts playback right away');
    await evaluate('window.__mk("/slow.mp4")');
    await evaluate('ensureVideoPoster(document.querySelectorAll("video.att-vid")[2])');
    await sleep(120);
    s = await evaluate('window.__state(document.querySelectorAll(".att-wrap")[2])');
    check(s.loading, 'the video is still loading (slow source)', s);
    await evaluate('window.__clickLoad(document.querySelectorAll(".att-wrap")[2])');
    await sleep(60);
    s = await evaluate('window.__state(document.querySelectorAll(".att-wrap")[2])');
    check(!s.loading && s.vis !== 'hidden', 'tapping the overlay reveals the video immediately', s);

    console.log('\n[5] the stylesheet keeps the rules the fix depends on');
    check(/\.att-wrap\.loading video\.att-vid\{visibility:hidden\}/.test(css), 'the loading rule hides the video');
    check(/\.att-wrap\.loading \.att-vid-load\{display:flex\}/.test(css), 'the overlay is flex only while loading');
    check(/prefers-reduced-motion:reduce\)\{[^}]*\.att-spin/.test(css), 'reduced motion disables the spinner animation');
    check(/class="att-wrap loading/.test(markSource) && /att-vid-load/.test(markSource) && /att-spin/.test(markSource), 'the video markup carries the wrap state, overlay and spinner');
    check(/revealVideoShell\(v\);\s*\}\s*\/\/ One frame per URL/.test(postSource), 'the poster capture reveals the shell');
  } catch (e) {
    console.error('[test] ' + (e && e.stack || e));
    process.exit(1);
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome.kill(); } catch {}
    try { server.close(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}
main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
