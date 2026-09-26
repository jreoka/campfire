// A paste that lands while the composer is NOT focused used to leave the link
// "shifted downwards": the document-level paste handler (messages.js) focuses
// #in-message and inserts programmatically via insertAtCursor, which fires no
// 'input' event — so composerAutoGrow never ran and the wrapped multi-line
// value sat in a one-row box while the backdrop rendered it half-clipped
// below the optical centre. insertAtCursor now runs the grow (and the send-key
// paint) explicitly for composer fields.
//
// Real composer markup + real styles.css in headless Chrome, at a phone and a
// desktop viewport, driving the REAL insertAtCursor / composerAutoGrow /
// syncComposerRender / paintComposerSend sliced out of the sources. The
// backdrop painter's markdown is stubbed (escaper only): the growth under
// test comes from the textarea's own scrollHeight, not from the backdrop.
//
// Usage: node scripts/test-composer-paste.js
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

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/opt/meta-chromium/chrome',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

// Slice a top-level `function name(...) { ... }` out of a source file.
function sliceFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('function ' + name + ' not found');
  let depth = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(i, j + 1);
}

const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
const finalJs = fs.readFileSync(path.join(ROOT, 'public/js/final.js'), 'utf8');

// The composer form, verbatim, so the harness measures the real thing.
const composerMarkup = index.slice(index.indexOf('<form id="composer">'), index.indexOf('<!-- members -->'));

// The real units under test, verbatim.
const insertSrc = sliceFn(pickers, 'insertAtCursor');
const isComposerFieldSrc = sliceFn(pickers, 'isComposerField');
const syncRenderForSrc = sliceFn(pickers, 'syncRenderFor');
const growSrc = sliceFn(finalJs, 'composerAutoGrow');
const syncRenderSrc = sliceFn(finalJs, 'syncComposerRender');
const paintSrc = sliceFn(core, 'paintComposerSend');
const paintKeySrc = sliceFn(core, 'paintSendKey');

// Source-level: the programmatic insert must carry the input-event side
// effects for composer fields, or the box never grows.
console.log('\n[1] insertAtCursor mirrors the input-event side effects');
check(/composerAutoGrow\(input\)/.test(insertSrc), 'insertAtCursor calls composerAutoGrow for composer fields');
check(/paintComposerSend\(\)/.test(insertSrc), 'insertAtCursor repaints the send key for composer fields');
check(/isComposerField\(input\)/.test(insertSrc), 'non-composer fields still take the early return (real input event)');

const LONG_URL = 'https://music.youtube.com/playlist?list=OLAK5uy_kOHctqqPth8nl69_PfraSPw4vD9ENuTm0&si=eRLe69TlUS4WqmRvz';
// The desktop bar is wide enough to fit the reported link on one line, so the
// desktop probe pads it until it wraps there too.
const LONG_URL_DESKTOP = LONG_URL + '&pad=' + 'a'.repeat(160);

function pageHtml(url) {
  const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>#chat{display:flex;flex-direction:column;height:100vh}</style></head><body>
<main id="chat">${composerMarkup}</main>
<script>
window.$ = (s) => document.querySelector(s);
window.S = { view: 'server', serverId: 's', channelId: 'c', dmThreadId: null, pendingAtts: [] };
window.threadAtts = () => [];
// Stubs: the draft store and the markdown painter are not under test. The
// painter only needs to not throw; growth is measured on the textarea itself.
window.renderRich = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
window.draftSoon = () => {};
window.draftCtxForEl = () => ({});
window.draftCtx = () => ({});
${isComposerFieldSrc}
${syncRenderSrc}
${syncRenderForSrc}
${growSrc}
${paintKeySrc}
${paintSrc}
${insertSrc}
// The real 'input' line-up from final.js, verbatim in behaviour: a native
// paste fires it, a programmatic insert does not.
document.querySelector('#in-message').addEventListener('input', syncComposerRender);
document.querySelector('#in-message').addEventListener('input', () => { try { paintComposerSend(); } catch {} });
document.querySelector('#in-message').addEventListener('input', (e) => composerAutoGrow(e.target));
document.querySelector('#in-message').addEventListener('input', (e) => { try { draftSoon(e.target, draftCtx()); } catch {} });
window.__result = (function () {
  const inp = document.querySelector('#in-message');
  const url = /*__PROBE_URL__*/ null;
  const out = {};
  const h = () => Math.round(inp.getBoundingClientRect().height);
  out.oneRow = h();
  // Path A — the working baseline: click first, then a native paste, which
  // fires a real 'input' event (grow + send key ride on it).
  inp.focus();
  inp.value = url;
  inp.selectionStart = inp.selectionEnd = url.length;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  out.focusedHeight = h();
  out.focusedSendOff = document.querySelector('#composer .send-btn').classList.contains('is-off');
  // Reset to one row.
  inp.value = '';
  try { composerAutoGrow(inp); } catch {}
  try { paintComposerSend(); } catch {}
  out.resetHeight = h();
  // Path B — the reported bug: the paste lands while the box is NOT focused,
  // so the document-level handler focuses it and inserts programmatically,
  // with no 'input' event.
  inp.blur();
  inp.focus();
  insertAtCursor(inp, url);
  out.unfocusedHeight = h();
  out.unfocusedSendOff = document.querySelector('#composer .send-btn').classList.contains('is-off');
  out.backdropTop = Math.round(document.querySelector('#in-render-inner').getBoundingClientRect().top);
  out.fieldTop = Math.round(document.querySelector('#in-render').getBoundingClientRect().top);
  out.fieldPadTop = parseFloat(getComputedStyle(document.querySelector('#in-render')).paddingTop);
  out.scrollHeight = inp.scrollHeight;
  out.clientHeight = inp.clientHeight;
  return out;
})();
</script>
</body></html>`;
  return html.replace('/*__PROBE_URL__*/ null', JSON.stringify(url));
}

// Minimal CDP driver: navigate, read window.__result.
async function probe(chrome, pageFile, { width, height, dpr }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-paste-'));
  const port = 18700 + (process.pid % 500);
  const proc = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--no-sandbox',
    '--user-data-dir=' + path.join(dir, 'prof'), '--force-device-scale-factor=' + dpr,
    '--window-size=' + width + ',' + height, '--remote-debugging-port=' + port, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const kill = () => { try { proc.kill('SIGKILL'); } catch {} };
  try {
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('devtools listen timeout')), 20000);
      proc.stderr.on('data', (d) => {
        if (/DevTools listening on/.test(String(d))) { clearTimeout(t); res(); }
      });
      proc.on('exit', () => { clearTimeout(t); rej(new Error('chrome exited early')); });
    });
    let target = null;
    for (let i = 0; i < 50 && !target; i++) {
      try {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch {}
      if (!target) await new Promise((r) => setTimeout(r, 200));
    }
    if (!target) throw new Error('no page target');
    const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    let loadResolve;
    const loaded = new Promise((res) => { loadResolve = res; });
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method === 'Page.loadEventFired') loadResolve();
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('cdp timeout: ' + method)); } }, 20000);
    });
    await send('Page.enable');
    await send('Page.navigate', { url: 'file://' + pageFile });
    await Promise.race([loaded, new Promise((_, rej) => setTimeout(() => rej(new Error('load timeout')), 20000))]);
    await new Promise((r) => setTimeout(r, 500));
    const ev = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__result)', returnByValue: true });
    ws.close();
    const val = ev.result && ev.result.result && ev.result.result.value;
    if (!val) throw new Error('no __result: ' + JSON.stringify(ev).slice(0, 300));
    return JSON.parse(val);
  } finally {
    kill();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  const chrome = findChrome();
  if (!chrome) skip('no Chrome/Chromium found');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-paste-page-'));
  const pageFile = path.join(dir, 'page.html');
  fs.writeFileSync(pageFile, pageHtml());
  try {
    for (const vp of [
      { name: 'phone', width: 390, height: 844, dpr: 2, url: LONG_URL },
      { name: 'desktop', width: 1440, height: 900, dpr: 1, url: LONG_URL_DESKTOP },
    ]) {
      console.log(`\n[2] ${vp.name} viewport (${vp.width}x${vp.height})`);
      fs.writeFileSync(pageFile, pageHtml(vp.url));
      const r = await probe(chrome, pageFile, vp);
      check(!r.renderErr && !r.paintErr && !r.growErr, 'no exceptions from the sliced units', r);
      check(r.focusedHeight > r.oneRow * 1.5, 'focused paste grows the box for the long link', r);
      check(r.resetHeight === r.oneRow, 'clearing the box drops it back to one row', r);
      check(r.unfocusedHeight === r.focusedHeight,
        'unfocused paste grows the box to exactly the focused-paste height', r);
      check(r.unfocusedHeight > r.oneRow * 1.5, 'the box is not stuck at one row', r);
      check(r.clientHeight >= r.scrollHeight - 1, 'no clipped overflow left inside the textarea',
        { scrollHeight: r.scrollHeight, clientHeight: r.clientHeight });
      check(r.focusedSendOff === false && r.unfocusedSendOff === false, 'send key lights up on both paste paths',
        { focusedSendOff: r.focusedSendOff, unfocusedSendOff: r.unfocusedSendOff });
      check(Math.abs(r.backdropTop - (r.fieldTop + r.fieldPadTop)) <= 2.5,
        'backdrop text starts at the field padding, not shifted down', r);
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log('failures:\n - ' + failures.join('\n - ')); process.exit(1); }
}

main().catch((e) => { console.error('HARNESS ERROR: ' + (e && e.stack || e)); process.exit(2); });
