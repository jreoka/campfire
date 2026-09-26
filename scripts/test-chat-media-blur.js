// Chat media blur-up: every upload in the message list gets the same "blur-up"
// placeholder the stories got — a blurred version of the media behind the
// spinner while it loads.
//
// Photos: the message list already paints the derived thumb first; now the
// <img> paints BLURRED behind a transparent spinner placeholder while pending
// and sharpens in place on .ready (CSS-only: wireAttImage's pending/ready
// classes already exist).
//
// Videos: a files/ clip with no client-captured frame now renders a blurred
// <img class="att-vid-blur"> from the server-minted first-frame poster
// (/uploads/posters/..., see media-compress.js) behind the spinner shell, and
// the <video> wears the same URL as its poster attribute. wireServerPoster
// reveals the shell the moment the frame lands (skipping the client-side
// capture, which would download the clip just to redraw a frame it already
// has); a poster that fails to mint falls back to the old capture path.
//
// Static half (always runs): the derivation, the markup, the stylesheet, and
// the wiring call sites.
// Chrome half (skips without Chrome): the REAL attVideoHTML / wireServerPoster
// / wireAttImage sliced out of messages.js against the REAL stylesheet — the
// blur reveals the shell, the failed poster falls back, the photo sharpens.
//
// Usage: node scripts/test-chat-media-blur.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9373', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function finish(msg) {
  if (msg) console.log('[test] SKIP: ' + msg);
  if (failures.length) { console.log(`\nFAILED (${failures.length})`); process.exit(1); }
  console.log(`\nall ${passed} checks passed`);
  process.exit(0);
}
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

const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const msgs = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
const pins = fs.readFileSync(path.join(ROOT, 'public/js/pins.js'), 'utf8');
const posterSrc = slice(msgs, 'function serverPosterSrcFor(url) {', 'function imageSrcFor(a) {');
const videoHtmlSrc = slice(msgs, 'function attVideoHTML(a, opts) {', '// The still FRAME this page already holds');
const revealSrc = slice(msgs, 'function revealVideoShell(v) {', '// Capture can outlast the reader');
const wireSrc = slice(msgs, 'function wireServerPoster(v) {', '// ---------- stick-to-bottom');
const wireImgSrc = slice(msgs, 'function wireAttImage(img) {', '// ---------- the picked bytes');
if (!/serverPosterSrcFor/.test(posterSrc) || !/att-vid-blur/.test(videoHtmlSrc) ||
    !/revealVideoShell/.test(wireSrc) || !/pending/.test(wireImgSrc)) {
  console.error('[test] an extracted block is incomplete');
  process.exit(1);
}

console.log('\n[1] the server-poster derivation only accepts files/ video keys');
{
  const fn = new Function(posterSrc + '\nreturn serverPosterSrcFor;')();
  check(fn('/uploads/files/abc.mp4') === '/uploads/posters/files/abc.mp4.webp', 'mp4 maps to the posters pipeline');
  check(fn('/uploads/files/a.MOV') === '/uploads/posters/files/a.MOV.webp', 'mov is accepted (case-insensitive)');
  check(fn('/uploads/files/b.webm') === '/uploads/posters/files/b.webm.webp', 'webm is accepted');
  check(fn('/uploads/files/c.mp4?v=12') === '/uploads/posters/files/c.mp4.webp?v=12', 'the cache-buster survives');
  check(fn('/uploads/files/p.jpg') === '', 'stills stay out of the poster pipeline');
  check(fn('/uploads/files/p.mp4.webp') === '', 'a derived poster is not re-derived');
  check(fn('https://example.invalid/v.mp4') === '', 'remote urls stay out');
  check(fn('/uploads/files/../x.mp4') === '', 'unsafe keys stay out');
  check(fn(null) === '', 'null degrades to empty');
}

console.log('\n[2] attVideoHTML renders the blur-up layer');
{
  const stubs = `const attDimsFor=()=>null, attPickedFrame=()=> (globalThis.__shot || ''), attMeta=()=> '', attDl=()=> '';
const esc=(s)=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));\n`;
  const api = new Function(stubs + posterSrc + videoHtmlSrc + '\nreturn { attVideoHTML, serverPosterSrcFor };')();
  const vid = { kind: 'video', id: 'v1', url: '/uploads/files/x.mp4', name: 'x.mp4' };
  const html = api.attVideoHTML(vid);
  check(/att-wrap loading has-sposter/.test(html), 'no captured frame: the shell arms with has-sposter');
  check(html.includes('<img class="att-vid-blur" src="/uploads/posters/files/x.mp4.webp"'), 'the blur layer points at the server poster');
  check(html.includes('poster="/uploads/posters/files/x.mp4.webp"'), 'the <video> wears the poster as its poster attribute');
  globalThis.__shot = 'data:image/jpeg;base64,AAA';
  const html2 = api.attVideoHTML(vid);
  check(!/loading/.test(html2) && !/att-vid-blur/.test(html2), 'a captured frame keeps the old instant path');
  check(html2.includes('poster="data:image/jpeg;base64,AAA"'), 'the captured frame wins the poster attribute');
  delete globalThis.__shot;
  const html3 = api.attVideoHTML({ kind: 'video', id: 'v2', url: 'https://example.invalid/v.mp4', name: 'v.mp4' });
  check(!/has-sposter/.test(html3) && !/att-vid-blur/.test(html3), 'a remote clip keeps the old shell');
  check(/att-wrap loading /.test(html3), 'a remote clip still waits behind the spinner');
  const html4 = api.attVideoHTML(vid, { live: false });
  check(!/has-sposter/.test(html4), 'a non-live render never asks for a server poster');
}

console.log('\n[3] the stylesheet paints the blur-up states');
check(/\.att-wrap\.pending:not\(\.ready\):not\(\.att-swap\) img\.att-img\{[^}]*opacity:1[^}]*filter:blur\(16px\)/.test(css),
  'a pending photo paints blurred, not hidden');
check(/\.att-wrap\.pending:not\(\.ready\):not\(\.att-swap\) \.att-ph\{background:transparent\}/.test(css),
  'the photo placeholder goes transparent so the blur shows through');
check(/\.att-wrap\.pending:not\(\.ready\):not\(\.att-swap\)\{overflow:hidden\}/.test(css),
  'the photo wrap clips the blur fringe while pending');
check(/\.att-wrap img\.att-img\{[^}]*transition:[^}]*filter/.test(css),
  'the photo sharpens with a filter transition');
check(/\.att-vid-blur\{[^}]*position:absolute[^}]*filter:blur\(16px\)/.test(css),
  'the video blur layer is an absolutely positioned blurred image');
check(/\.att-wrap\.loading\.has-sposter \.att-vid-load\{background:transparent\}/.test(css),
  'the video shell goes transparent so the blur shows through the spinner');
check(/\.att-wrap\.loading\.has-sposter\{overflow:hidden\}/.test(css),
  'the video wrap clips the blur fringe');

console.log('\n[4] the wiring reaches every video surface');
check(/function wireServerPoster\(v\)/.test(msgs), 'wireServerPoster is defined');
check(/\.forEach\(\(v\) => \{ wireServerPoster\(v\); requestVideoPoster\(v\); wireVideoPlayState\(v\); observeStick\(v\); \}\)/.test(msgs),
  'the message batch wires the server poster before the client capture');
check(/wireServerPoster\(nextVid\); requestVideoPoster\(nextVid\)/.test(msgs),
  'the verdict patch path wires it too');
check(/wireServerPoster\(v\)/.test(pins) && /ensureVideoPoster\(v\)/.test(pins),
  'pinned videos wire it ahead of ensureVideoPoster');
check(/\.att-wrap\.pending\.ready \.att-ph\{opacity:0\}/.test(css),
  'the photo placeholder still fades on ready');

const chromePath = findChrome();
if (!chromePath) finish('no Chrome/Edge found (set CHROME_PATH)');

const WHITE = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='600' height='600'><rect width='600' height='600' fill='white'/></svg>";

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<style>${css}</style>
<style>html,body{margin:0;padding:0;background:var(--bg)}#chat{width:420px}</style></head><body>
<div id="chat"></div>
<script>
window.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
window.attDimsFor = () => null;
window.attPickedFrame = () => '';
window.attMeta = () => '';
window.attDl = () => '';
window.attDimsLearn = () => {};
${posterSrc}
${videoHtmlSrc}
${revealSrc}
${wireSrc}
${wireImgSrc}
// Instant posters: this half tests the blur-up mechanics, not the network.
serverPosterSrcFor = () => ${JSON.stringify(WHITE)};
const chat = document.getElementById('chat');
// --- a video with no captured frame ---
const vwrap = document.createElement('span');
vwrap.innerHTML = attVideoHTML({ kind: 'video', id: 'v1', url: '/uploads/files/x.mp4', name: 'x.mp4' });
chat.appendChild(vwrap);
const v = vwrap.querySelector('.att-vid');
const blur = vwrap.querySelector('.att-wrap > .att-vid-blur');
window.__v0 = {
  shell: vwrap.querySelector('.att-wrap').classList.contains('loading') && vwrap.querySelector('.att-wrap').classList.contains('has-sposter'),
  blurUp: !!blur,
  spinnerShown: getComputedStyle(vwrap.querySelector('.att-vid-load')).display === 'flex',
  vidHidden: getComputedStyle(v).visibility === 'hidden',
  posterAttr: v.getAttribute('poster') === ${JSON.stringify(WHITE)},
};
wireServerPoster(v);
setTimeout(() => {
  const w = vwrap.querySelector('.att-wrap');
  window.__v1 = {
    revealed: !w.classList.contains('loading'),
    blurGone: !w.querySelector('.att-vid-blur'),
    posterOk: v.dataset.posterOk === '1',
    vidShown: getComputedStyle(v).visibility !== 'hidden',
  };
  // --- a video whose poster cannot be minted: falls back, never strands ---
  serverPosterSrcFor = () => 'https://example.invalid/nope.webp';
  const fwrap = document.createElement('span');
  fwrap.innerHTML = attVideoHTML({ kind: 'video', id: 'v2', url: '/uploads/files/y.mp4', name: 'y.mp4' });
  chat.appendChild(fwrap);
  const fv = fwrap.querySelector('.att-vid');
  wireServerPoster(fv);
  setTimeout(() => {
    const fw = fwrap.querySelector('.att-wrap');
    window.__v2 = {
      blurGone: !fw.querySelector('.att-vid-blur'),
      shellBack: fw.classList.contains('loading') && !fw.classList.contains('has-sposter'),
      posterOkUnset: fv.dataset.posterOk !== '1',
    };
    // --- a photo: blurred while pending, sharp on ready ---
    const pwrap = document.createElement('span');
    pwrap.className = 'att-wrap pending ar';
    pwrap.style.setProperty('--att-ar', '1.5');
    pwrap.innerHTML = '<span class="att-ph"><span class="att-spin"></span></span>';
    const img = document.createElement('img');
    img.className = 'att-img';
    pwrap.appendChild(img);
    chat.appendChild(pwrap);
    wireAttImage(img);
    window.__p1 = {
      filter: getComputedStyle(img).filter,
      opacity: getComputedStyle(img).opacity,
      phBg: getComputedStyle(pwrap.querySelector('.att-ph')).backgroundColor,
    };
    img.src = ${JSON.stringify(WHITE)};
    setTimeout(() => {
      window.__p2 = {
        ready: pwrap.classList.contains('ready'),
        filter: getComputedStyle(img).filter,
      };
      // The reported bug: a photo visibly changed size as the blur lifted —
      // the blurred state used to zoom the picture (transform:scale(1.03)) and
      // animate back. Transitions are switched off for the measurement so the
      // toggle reads settled values, not a mid-flight interpolation; the
      // rendered box must be identical blurred and sharp.
      img.style.transition = 'none';
      pwrap.classList.add('ready');
      const rSharp = img.getBoundingClientRect();
      pwrap.classList.remove('ready');
      const rBlur = img.getBoundingClientRect();
      pwrap.classList.add('ready');
      img.style.transition = '';
      window.__p3 = {
        wSharp: rSharp.width, hSharp: rSharp.height,
        wBlur: rBlur.width, hBlur: rBlur.height,
      };
      window.__ready = true;
    }, 400);
  }, 500);
}, 400);
</script></body></html>`;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-chatblur-'));
  const pagePath = path.join(tmp, 'page.html');
  fs.writeFileSync(pagePath, pageHtml());
  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    '--user-data-dir=' + path.join(tmp, 'prof'), '--no-first-run', '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu', '--hide-scrollbars', '--window-size=900,1200', 'about:blank'], { stdio: 'ignore' });
  let ws = null;
  try {
    let ver = null;
    for (let i = 0; i < 80 && !ver; i++) {
      try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch {}
      if (!ver) await sleep(200);
    }
    if (!ver) return finish('Chrome did not expose the DevTools port');
    const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    let id = 0; const pend = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    });
    const cmd = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expression) => {
      const r = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    await cmd('Page.enable'); await cmd('Runtime.enable');
    await cmd('Page.navigate', { url: 'file:///' + pagePath.replace(/\\/g, '/') });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) { ready = await ev('!!window.__ready').catch(() => false); if (!ready) await sleep(150); }
    if (!ready) return finish('the harness page did not render');

    console.log('\n[5] a video with no captured frame wears the blur-up shell');
    const v0 = await ev('window.__v0');
    check(v0.shell, 'the wrap arms .loading.has-sposter');
    check(v0.blurUp, 'the .att-vid-blur layer is in the wrap');
    check(v0.spinnerShown, 'the spinner shell is showing');
    check(v0.vidHidden, 'the <video> hides until the frame lands');
    check(v0.posterAttr, 'the <video> poster is the server frame');

    console.log('\n[6] the landed frame reveals the shell');
    const v1 = await ev('window.__v1');
    check(v1.revealed, 'the loading shell lifts');
    check(v1.blurGone, 'the blur layer is removed');
    check(v1.posterOk, 'posterOk is set, so the client capture is skipped');
    check(v1.vidShown, 'the <video> is visible on its poster frame');

    console.log('\n[7] a poster that cannot mint falls back to the capture path');
    const v2 = await ev('window.__v2');
    check(v2.blurGone, 'the failed blur never paints');
    check(v2.shellBack, 'the shell returns to the old black-spinners state');
    check(v2.posterOkUnset, 'posterOk stays unset, so the client capture still runs');

    console.log('\n[8] a photo paints blurred behind the spinner, then sharpens');
    const p1 = await ev('window.__p1');
    check(/blur\(/.test(p1.filter), 'the pending photo is blurred', p1.filter);
    check(p1.opacity === '1', 'the pending photo is visible (not hidden)', p1.opacity);
    check(p1.phBg === 'rgba(0, 0, 0, 0)', 'the placeholder is transparent over the blur', p1.phBg);
    const p2 = await ev('window.__p2');
    check(p2.ready, 'load arms .ready');
    check(p2.filter === 'none', 'the photo sharpens on ready', p2.filter);
    const p3 = await ev('window.__p3');
    check(p3 && p3.wBlur === p3.wSharp && p3.hBlur === p3.hSharp && p3.wSharp > 0,
      'the photo keeps its exact box from blurred to sharp (no size change)', JSON.stringify(p3));
  } finally {
    try { if (ws) ws.close(); } catch {}
    try { chrome.kill(); } catch {}
  }
  finish();
}

main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
