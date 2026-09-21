// A YouTube SHORT is shot vertical, so its embed is a vertical rectangle.
//
// Reported: a Short pasted into chat rendered inside the 16:9 facade — a
// landscape box holding a portrait picture, with black bars down both sides. The
// shape can only come from the URL (a Short read through `/watch?v=` or a bare
// youtu.be link is indistinguishable from an ordinary video, and the oEmbed
// answer carries no shape either), so `/shorts/<id>` is what the facade keys on:
// the tile takes 9:16, the CARD narrows to hug that tile (a full-width card
// wrapped around a narrow box reads as a mistake), the played player inherits the
// shape, and a normal video keeps the 16:9 box it always had.
//
// The poster needs no special treatment: YouTube pillarboxes a vertical frame
// into hqdefault's 4:3 thumbnail, and `.yt-facade img{object-fit:cover}` crops
// exactly those bars back off — so `cover` is load-bearing here, not decoration.
//
// Two halves:
//   [A] the REAL embeds.js offline (which URLs are Shorts, and what markup each
//       one gets) plus the stylesheet/JS wiring that turns that markup into a
//       shape.
//   [B] the REAL stylesheet measured in headless Chrome, at a desktop and a phone
//       width, off that markup: the ratio, the hug, the player, and the phone
//       step-down.
//
// Skips (exit 0) without Chrome. Usage: node scripts/test-yt-shorts.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9368', 10);
const DESKTOP = { w: 1200, h: 800 };
const PHONE = { w: 390, h: 780 };
// 9:16 tall, 16:9 wide. A tile is allowed a couple of pixels of rounding.
const TALL = 16 / 9;
const WIDE = 9 / 16;

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

const styles = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const embedsSrc = fs.readFileSync(path.join(ROOT, 'public/embeds.js'), 'utf8');
const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');

// embeds.js calls the app's global esc() at call time (classic script).
global.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const embeds = require(path.join(ROOT, 'public/embeds.js'));

const SHORT_ID = 'aBcDeFgHiJk';
const SHORT = 'https://www.youtube.com/shorts/' + SHORT_ID;
const WATCH = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

function pageHtml() {
  // A real chat column, so the widths the embeds see are the widths a reader has.
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/styles.css"></head><body>
<div id="view-main"><div id="chat"><div id="messages">
<div class="msg"><div class="body" id="slot"></div></div>
</div></div></div>
<script src="/embeds.js"></script>
<script>
// embeds.js is a classic script that calls the app's global esc() at call time
// (verbatim from public/js/core.js). Without it the facade throws inside
// linkEmbedsHTML's try/catch and the message silently falls back to a card.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
window.__render = (url) => { document.getElementById('slot').innerHTML = linkEmbedsHTML(url); return !!document.querySelector('#slot .embed'); };
// Exactly what the delegated click handler (pickers.js [data-yt-play]) builds: the
// class name is the contract between that handler and the shape rule.
window.__play = () => {
  const tile = document.querySelector('#slot .yt-facade');
  if (!tile) return false;
  const f = document.createElement('iframe');
  f.className = 'embed-frame yt-player';
  tile.replaceWith(f);
  return true;
};
</script>
</body></html>`;
}

// One expression: whatever is standing in for the video right now (the facade, or
// the player that replaced it) plus the card around it.
const PROBE = `(() => {
  const card = document.querySelector('#slot .embed');
  if (!card) return { none: true };
  const media = card.querySelector('.yt-facade, .embed-frame.yt-player');
  const img = card.querySelector('.yt-facade img');
  const label = card.querySelector('.embed-src');
  const cb = card.getBoundingClientRect();
  const mb = media ? media.getBoundingClientRect() : null;
  return {
    cards: document.querySelectorAll('#slot .embed').length,
    tag: media ? media.tagName : null,
    isPlayer: !!(media && media.classList.contains('yt-player')),
    cardW: Math.round(cb.width), cardH: Math.round(cb.height),
    mediaW: mb ? Math.round(mb.width) : 0, mediaH: mb ? Math.round(mb.height) : 0,
    ratio: mb ? +(mb.height / mb.width).toFixed(3) : 0,
    label: label ? label.textContent : null,
    vertical: card.classList.contains('embed-vertical'),
    fit: img ? getComputedStyle(img).objectFit : null,
    bg: media ? getComputedStyle(media).backgroundColor : null,
  };
})()`;

async function main() {
  console.log('\n[A] a /shorts/ link is a Short, and nothing else is');
  const short = embeds.embedForUrl(SHORT);
  check(/<div class="embed embed-vertical">/.test(short), 'the Short\'s card is the vertical one', short.slice(0, 60));
  check(/class="yt-facade vertical"/.test(short), 'and its facade wears the vertical shape');
  check(short.includes('YouTube Short'), 'the label says SHORT (the shape is otherwise unexplained)');
  check(short.includes('i.ytimg.com/vi/' + SHORT_ID + '/hqdefault.jpg'),
    'the poster is still hqdefault — it is the fallback for every id', short.match(/i\.ytimg[^"]+/));
  check(short.includes('youtube-nocookie.com/embed/' + SHORT_ID + '?autoplay=1'), 'and the play url is unchanged');

  const watch = embeds.embedForUrl(WATCH);
  check(/<div class="embed">/.test(watch) && /class="yt-facade"/.test(watch),
    'an ordinary /watch video keeps the plain 16:9 facade', watch.slice(0, 60));
  check(!/vertical|Short/.test(watch), 'and is never labelled a Short', watch.slice(0, 90));

  // The URL is the only signal there is: these must NOT be treated as Shorts.
  for (const u of ['https://youtu.be/' + SHORT_ID, 'https://www.youtube.com/live/' + SHORT_ID,
    'https://m.youtube.com/watch?v=' + SHORT_ID, 'https://www.youtube.com/embed/' + SHORT_ID]) {
    const out = embeds.embedForUrl(u);
    check(!!out && !/vertical/.test(out), u + ' is not a Short', out && out.slice(0, 50));
  }
  // …and the /shorts/ path is what makes one, on every YouTube host and with a
  // query string or a trailing path segment after the id.
  for (const u of ['https://m.youtube.com/shorts/' + SHORT_ID,
    'https://www.youtube.com/shorts/' + SHORT_ID + '?feature=share',
    'https://youtube.com/shorts/' + SHORT_ID + '/']) {
    const out = embeds.embedForUrl(u);
    check(!!out && /embed-vertical/.test(out) && /yt-facade vertical/.test(out), u + ' is a Short', out && out.slice(0, 50));
  }
  const music = embeds.embedForUrl('https://music.youtube.com/shorts/' + SHORT_ID);
  check(/embed-vertical/.test(music) && music.includes('YouTube Music Short'),
    'YouTube Music keeps its provider name and still says Short', music.match(/embed-src">[^<]+/));
  check(embeds.embedForUrl('https://example.com/shorts/' + SHORT_ID) === null,
    'a /shorts/ path on somebody else\'s domain is not a YouTube Short (it gets no facade at all)');

  console.log('\n[A2] the shape is CSS, and it is an override of the 16:9 box');
  check(/\.yt-facade\{position:relative;display:block;width:100%;aspect-ratio:16\/9;/.test(styles),
    'the base facade is still the 16:9 box');
  check(/\.yt-facade\.vertical\{aspect-ratio:9\/16\}/.test(styles),
    'and the vertical one overrides only the shape', null);
  check(/\.embed-vertical\{width:min\(260px,100%\)\}/.test(styles),
    'the card narrows to hug the tile (a full-width card around a narrow box reads as a mistake)');
  check(/\.embed-vertical \.embed-frame\.yt-player\{aspect-ratio:9\/16;height:auto\}/.test(styles),
    'the played player inherits the same shape');
  check(/\.yt-facade img\{width:100%;height:100%;object-fit:cover;display:block\}/.test(styles),
    'cover is what crops hqdefault\'s pillarbox bars back off (load-bearing, not decoration)');
  check(/@media \(max-width:700px\),\(max-height:560px\) and \(pointer:coarse\)\{\s*\.embed-vertical\{width:min\(220px,100%\)\}/.test(styles),
    'a phone steps the width down, so one Short never owns the screen');
  check(/f\.className = 'embed-frame yt-player'/.test(pickers),
    'the click handler builds the player with the class the vertical rule keys on');

  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-shorts-'));
  const srv = http.createServer((req, res) => {
    const url = req.url || '';
    if (/^\/styles\.css/.test(url)) { res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' }); res.end(styles); return; }
    if (/^\/embeds\.js/.test(url)) { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); res.end(embedsSrc); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml());
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
    '--window-size=' + DESKTOP.w + ',' + DESKTOP.h, 'about:blank'], { stdio: 'ignore' });

  let ws = null;
  try {
    let info = null;
    for (let i = 0; i < 60 && !info; i++) {
      try { info = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); } catch { await sleep(250); }
    }
    if (!info) return skip('Chrome never opened its DevTools port');
    ws = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0; const pending = new Map();
    ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const call = (method, params, sessionId) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
      ws.send(JSON.stringify({ id: i, sessionId, method, params }));
    });
    const targetId = (await call('Target.createTarget', { url: 'about:blank' })).targetId;
    const sessionId = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    const sess = (m, p) => call(m, p, sessionId);
    const ev = async (expression) => {
      const r = await sess('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'page error');
      return r.result.value;
    };
    await sess('Page.enable');
    await sess('Runtime.enable');
    await sess('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
    await sleep(500);
    if (!(await ev('typeof window.__render === "function"'))) {
      console.error('[test] the real embeds.js did not evaluate in the page');
      process.exit(1);
    }

    console.log('\n[B] the rendered shape, desktop 1200x800');
    await sess('Emulation.setDeviceMetricsOverride', { width: DESKTOP.w, height: DESKTOP.h, deviceScaleFactor: 1, mobile: false });
    await sleep(120);
    check((await ev('window.__render(' + JSON.stringify(SHORT) + ')')) === true, 'the Short renders a facade');
    let m = await ev(PROBE);
    check(Math.abs(m.ratio - TALL) < 0.04, 'its tile is TALLER than it is wide (9:16)', { ratio: m.ratio, w: m.mediaW, h: m.mediaH });
    check(m.mediaH > m.mediaW && m.mediaW <= 260, 'the vertical rectangle is capped at the 260px card width', m);
    check(m.vertical === true && m.label === 'YouTube Short', 'the card is the vertical one and says SHORT', { vertical: m.vertical, label: m.label });
    check(m.cardW - m.mediaW <= 2 && m.cardW <= 262,
      'the card hugs the tile — it does not stay full width around a narrow box', { card: m.cardW, tile: m.mediaW });
    check(m.fit === 'cover' && m.bg === 'rgb(0, 0, 0)',
      'the poster is cover-cropped (hqdefault\'s pillarbox bars come off, not the picture)', { fit: m.fit, bg: m.bg });

    check((await ev('window.__play()')) === true, 'playing it swaps the facade for the player');
    m = await ev(PROBE);
    check(m.isPlayer === true && m.tag === 'IFRAME', 'which is the real player iframe', m.tag);
    check(Math.abs(m.ratio - TALL) < 0.04 && m.cardW - m.mediaW <= 2,
      'and it keeps the vertical shape and the hugged card (no reflow back to 16:9)', { ratio: m.ratio, card: m.cardW, player: m.mediaW });

    await ev('window.__render(' + JSON.stringify(WATCH) + ')');
    m = await ev(PROBE);
    check(Math.abs(m.ratio - WIDE) < 0.04, 'an ordinary video is still the 16:9 box', { ratio: m.ratio, w: m.mediaW, h: m.mediaH });
    check(m.vertical === false && m.label === 'YouTube', 'with the plain card and the plain label', { vertical: m.vertical, label: m.label });
    check(m.cardW > 400, 'and the full-width card it always had', { card: m.cardW });

    console.log('\n[B2] the phone width, 390x780');
    await sess('Emulation.setDeviceMetricsOverride', { width: PHONE.w, height: PHONE.h, deviceScaleFactor: 1, mobile: true });
    await sleep(120);
    await ev('window.__render(' + JSON.stringify(SHORT) + ')');
    m = await ev(PROBE);
    check(Math.abs(m.ratio - TALL) < 0.04, 'a phone gets the same vertical rectangle', { ratio: m.ratio, w: m.mediaW, h: m.mediaH });
    check(m.mediaW <= 221 && m.mediaW >= 200, 'stepped down to 220px wide (391px tall, ~half the screen)', { w: m.mediaW, h: m.mediaH });
    await ev('window.__render(' + JSON.stringify(WATCH) + ')');
    m = await ev(PROBE);
    check(Math.abs(m.ratio - WIDE) < 0.04 && m.mediaW > 300, 'and an ordinary video still fills the phone\'s width', { ratio: m.ratio, w: m.mediaW });
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
