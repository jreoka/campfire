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
// The card itself is the ordinary one: the provider banner is a header row along
// the top, up BEFORE the video starts and unmoved when it plays (owner request:
// "can we keep the banner along the top of the embed the way it is before starting
// the video too"), so starting the video swaps the tile and nothing else.
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
  // The player takes the tile's place inside the same card, under the same header
  // (see the handler in pickers.js) — nothing else about the card changes.
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
  // The video is the TILE inside the facade button now (the caption shares the
  // button with it — see scripts/test-yt-titles.js), or the player that replaced
  // the whole button. A Short's shape is on the tile and the player alike.
  const media = card.querySelector('.yt-tile, .embed-frame.yt-player');
  const img = card.querySelector('.yt-facade img');
  const label = card.querySelector('.embed-src');
  const play = card.querySelector('.yt-play');
  const cap = card.querySelector('.embed-yt-meta');
  const cb = card.getBoundingClientRect();
  const mb = media ? media.getBoundingClientRect() : null;
  const lb = label ? label.getBoundingClientRect() : null;
  const pb = play ? play.getBoundingClientRect() : null;
  const cs = media ? getComputedStyle(media) : null;
  const ls = label ? getComputedStyle(label) : null;
  return {
    cards: document.querySelectorAll('#slot .embed').length,
    tag: media ? media.tagName : null,
    isPlayer: !!(media && media.classList.contains('yt-player')),
    cardW: Math.round(cb.width), cardH: Math.round(cb.height),
    mediaW: mb ? Math.round(mb.width) : 0, mediaH: mb ? Math.round(mb.height) : 0,
    ratio: mb ? +(mb.height / mb.width).toFixed(3) : 0,
    label: label ? label.textContent : null,
    host: card.querySelector('.embed-src .embed-host')?.textContent || null,
    capH: cap ? Math.round(cap.getBoundingClientRect().height) : 0,
    vertical: card.classList.contains('embed-vertical'),
    cardCls: card.className,
    fit: img ? getComputedStyle(img).objectFit : null,
    bg: media ? getComputedStyle(media).backgroundColor : null,
    // The card anatomy: the provider banner is a ROW above the video, before the
    // video starts and while it plays (the chip that used to ride on the poster is
    // gone — see [A3]).
    labelPos: ls ? ls.position : null,
    labelRadius: ls ? ls.borderTopLeftRadius : null,
    labelInside: !!(lb && mb && lb.top >= mb.top - 1 && lb.bottom <= mb.bottom + 1 && lb.left >= mb.left - 1),
    labelBorder: ls ? ls.borderBottomWidth : null,
    // A played player: the label owns a row of its own ABOVE the video, so nothing
    // is painted over the picture.
    mediaBelowLabel: !!(mb && lb && mb.top >= lb.bottom - 1),
    playRadius: play ? getComputedStyle(play).borderTopLeftRadius : null,
    playW: pb ? Math.round(pb.width) : 0,
    cardIsTile: Math.abs(cb.height - (mb ? mb.height : 0)) <= 2,
    border: cs ? cs.borderTopWidth : null,
  };
})()`;

async function main() {
  console.log('\n[A] a /shorts/ link is a Short, and nothing else is');
  const short = embeds.embedForUrl(SHORT);
  check(/<div class="embed embed-vertical">/.test(short), 'the Short\'s card is the vertical one', short.slice(0, 60));
  check(/class="yt-facade vertical"/.test(short), 'and its facade wears the vertical shape');
  check(short.includes('<span class="embed-src">YouTube<span class="embed-host">youtube.com</span>'),
    'the label is the provider name and the URL tail — a Short is a URL form, not a different site', short.match(/embed-src">[^<]+/));
  check(short.includes('src="https://i.ytimg.com/vi/' + SHORT_ID + '/maxresdefault.jpg"'),
    'the poster asks for the sharpest frame first (maxresdefault, 1280x720)',
    short.match(/i\.ytimg[^"]+/));
  check(short.includes('data-yt-thumb="' + SHORT_ID + '"') && /data-yt-thumb-rung="0"/.test(short)
    && /onerror="ytThumbNext\(this\)"/.test(short),
    'and climbs the ladder itself — sddefault then hqdefault — because YouTube 404s maxresdefault for any video it holds no HD frame for',
    short.match(/data-yt-thumb[^>]+/));
  check(JSON.stringify(embeds.YT_THUMBS) === JSON.stringify(['maxresdefault', 'sddefault', 'hqdefault'])
    && embeds.ytThumb(SHORT_ID, 2).endsWith('/hqdefault.jpg'),
    'the last rung is hqdefault — the 480x360 frame that exists for EVERY id is still the floor', embeds.YT_THUMBS);
  // The ladder only works if a dead rung actually advances, and only stops at
  // the end: hqdefault missing must remove the picture, not leave a broken tile.
  const imgs = [...short.matchAll(/<img ([^>]+)>/g)].map((m) => {
    const a = {};
    for (const at of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[at[1]] = at[2];
    return a;
  }).filter((a) => a['data-yt-thumb']);
  check(imgs.length === 1 && imgs[0]['data-yt-thumb'] === SHORT_ID,
    "the facade's poster carries the id and its rung, which is all the handler needs", imgs);
  // Drive the handler the way onerror does: an exhausted ladder removes the media
  // box, so a video YouTube has no frame for looks the same as any other card
  // with no image rather than showing a broken image icon.
  const probeImg = { attrs: { 'data-yt-thumb': 'aaaaaa', 'data-yt-thumb-rung': '2' },
    getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = v; },
    src: '', style: {},
    removed: false,
    closest(sel) { if (sel !== '.el-media') return null; const self = this; return { remove() { self.removed = true; } }; } };
  embeds.ytThumbNext(probeImg);
  check(probeImg.removed === true && probeImg.src === '',
    'the handler gives up cleanly at the end of the ladder (no broken tile, no further request)', probeImg);
  const midImg = { attrs: { 'data-yt-thumb': 'aaaaaa', 'data-yt-thumb-rung': '0' },
    getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = v; }, src: '',
    closest() { return null; } };
  embeds.ytThumbNext(midImg);
  check(midImg.src.endsWith('/sddefault.jpg') && midImg.attrs['data-yt-thumb-rung'] === '1',
    'and steps down one rung at a time, remembering where it is', midImg);
  check(short.includes('youtube-nocookie.com/embed/' + SHORT_ID + '?autoplay=1'), 'and the play url is unchanged');

  const watch = embeds.embedForUrl(WATCH);
  check(/<div class="embed">/.test(watch) && /class="yt-facade"/.test(watch),
    'an ordinary /watch video is the plain card with the plain facade', watch.slice(0, 60));
  check(!/vertical/.test(watch) && /<span class="embed-src">YouTube<span class="embed-host">/.test(watch),
    'and is never labelled a Short either', watch.slice(0, 90));
  check(watch.indexOf('<span class="embed-src">') < watch.indexOf('class="yt-facade"'),
    'with the provider header BEFORE the tile, the same card every other provider gets', watch.slice(0, 90));

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
  check(/embed-vertical/.test(music) && /<span class="embed-src">YouTube Music<span class="embed-host">music\.youtube\.com<\/span>/.test(music),
    'YouTube Music keeps its own name, and no shape suffix either', music.match(/embed-src">[^<]+/));
  check(embeds.embedForUrl('https://example.com/shorts/' + SHORT_ID) === null,
    'a /shorts/ path on somebody else\'s domain is not a YouTube Short (it gets no facade at all)');

  console.log('\n[A2] the shape is CSS, and it is an override of the 16:9 box');
  check(/\.yt-facade \.yt-tile\{position:relative;display:block;width:100%;aspect-ratio:16\/9;/.test(styles),
    'the base facade is still the 16:9 box');
  check(/\.yt-facade\.vertical \.yt-tile\{aspect-ratio:9\/16\}/.test(styles),
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

  console.log('\n[A3] the box around it: ONE card anatomy, the provider header on every one');
  // The chip anatomy is gone (owner request: "can we keep the banner along the top
  // of the embed the way it is before starting the video too"): the facade card now
  // wears the same header row the player does, so starting the video changes the
  // tile and nothing else — no chip to sit over the picture, and no anatomy swap.
  // Comments are stripped first: this asks what the CODE uses, and the stylesheet
  // deliberately names the retired class in a note for whoever goes looking.
  const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  // `.embed-yt-meta` (the caption row, see scripts/test-yt-titles.js) is a
  // DIFFERENT class from the retired chip `.embed-yt` — checked on its own so
  // this sweep does not quietly stop meaning what it says.
  check(!/(^|[^-\w])\.embed-yt\b(?!-meta)/.test(noComments(styles)) && !/embed-yt\b(?!-meta)/.test(noComments(embedsSrc)) && !/embed-yt\b(?!-meta)/.test(noComments(pickers)),
    'no card anywhere wears the retired chip anatomy — not the stylesheet, not the markup, not the handler');
  check(/\.embed\{background:var\(--panel-2\);border:1px solid var\(--line-soft\);border-radius:6px;overflow:hidden;max-width:100%\}/.test(styles),
    'so a facade card keeps the card chrome it used to drop (surface, hairline, the 6px clip)');
  check(!/\.yt-facade::after/.test(styles),
    'and the tile needs no inset hairline of its own: the card\'s border box is the edge now');
  check(/\.yt-play\{[^}]*border-radius:8px[^}]*box-shadow:0 0 0 1px rgba\(255,255,255,\.14\)/.test(styles),
    'the play affordance is a rounded square with a hairline ring (the app\'s own button shape), not a bare circle');
  check(/\.yt-facade:hover \.yt-play\{background:#f00/.test(styles),
    'and it takes YouTube red under the pointer — brand colour on user content, where it belongs');
  check(/\.embed-src\{display:flex;align-items:baseline;gap:\.5rem;font-size:\.68rem;font-weight:800;letter-spacing:\.07em;text-transform:uppercase;color:var\(--faint\);padding:\.5rem \.8rem;border-bottom:1px solid var\(--line-soft\)/.test(styles),
    'the provider label is a header with a hairline under it — for the player AND for the facade above it');
  check(/\.embed-src \.embed-host\{margin-left:auto/.test(styles),
    'and it now carries the URL tail beside the name, so the row is one line tall and says something');
  check(/function embedShell\(provider, inner\) \{\s*return '<div class="embed"><span class="embed-src">'/.test(embedsSrc),
    'every iframe shell still goes through that one header (no shell left with the old caption padding)', null);
  const pic = embeds.embedForUrl('https://cdn.example.com/pic.png');
  check(/class="embed embed-media embed-plain"/.test(pic),
    'an inline picture is the card — one boundary, not a hairline box around a rounded picture', pic);
  check(/class="embed embed-media embed-plain"/.test(embeds.embedForUrl('https://cdn.example.com/clip.mp4') || ''),
    'and so is a clip');
  const song = embeds.embedForUrl('https://cdn.example.com/song.mp3') || '';
  check(/class="embed embed-media"/.test(song) && !/embed-plain/.test(song),
    'audio keeps the card — a bare <audio> element has no shape of its own', song.slice(0, 50));

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
    const facade = m;
    check(Math.abs(m.ratio - TALL) < 0.04, 'its tile is TALLER than it is wide (9:16)', { ratio: m.ratio, w: m.mediaW, h: m.mediaH });
    check(m.mediaH > m.mediaW && m.mediaW <= 260, 'the vertical rectangle is capped at the 260px card width', m);
    check(m.vertical === true && m.label === 'YouTubeyoutube.com',
      'the card is the vertical one, and the header says YOUTUBE with the URL tail beside it', { vertical: m.vertical, label: m.label });
    check(m.cardW - m.mediaW <= 2 && m.cardW <= 262,
      'the card hugs the tile — it does not stay full width around a narrow box', { card: m.cardW, tile: m.mediaW });
    // The banner is up BEFORE the video starts (owner request), exactly as it is
    // while it plays: the label owns a row of its own above the tile.
    check(m.labelPos === 'static' && m.mediaBelowLabel === true && m.labelInside === false && m.labelBorder !== '0px',
      'the provider banner sits along the top of the card before starting too — nothing over the poster',
      { pos: m.labelPos, below: m.mediaBelowLabel, inside: m.labelInside, border: m.labelBorder });
    check(m.cardIsTile === false && (m.cardH - m.mediaH) > 16 && (m.cardH - m.mediaH) < 44,
      'so the card is the tile PLUS that one header row', { card: m.cardH, tile: m.mediaH });
    check(m.playRadius === '8px' && m.playW >= 56,
      'and the play affordance is a rounded square, not a bare circle', { radius: m.playRadius, w: m.playW });
    check(m.fit === 'cover' && m.bg === 'rgb(0, 0, 0)',
      'the poster is cover-cropped (hqdefault\'s pillarbox bars come off, not the picture)', { fit: m.fit, bg: m.bg });

    check((await ev('window.__play()')) === true, 'playing it swaps the facade for the player');
    m = await ev(PROBE);
    check(m.isPlayer === true && m.tag === 'IFRAME', 'which is the real player iframe', m.tag);
    check(Math.abs(m.ratio - TALL) < 0.04 && m.cardW - m.mediaW <= 2,
      'and it keeps the vertical shape and the hugged card (no reflow back to 16:9)', { ratio: m.ratio, card: m.cardW, player: m.mediaW });
    // The banner is the SAME row in both states, and the tile is the same box: the
    // card is identical before and after starting, so nothing shifts but the media.
    check(m.label === facade.label && m.labelPos === 'static' && m.mediaBelowLabel === true && m.labelBorder === facade.labelBorder,
      'under the very same header row it already had — the banner never moves',
      { before: facade.labelPos, after: m.labelPos, border: [facade.labelBorder, m.labelBorder] });
    check(Math.abs((m.cardH - m.mediaH) - (facade.cardH - facade.mediaH)) <= 1 && Math.abs(m.mediaH - facade.mediaH) <= 1,
      'and the card does not move at all when the video starts (same header, same tile)',
      { header: [facade.cardH - facade.mediaH, m.cardH - m.mediaH], tile: [facade.mediaH, m.mediaH] });

    await ev('window.__render(' + JSON.stringify(WATCH) + ')');
    m = await ev(PROBE);
    check(Math.abs(m.ratio - WIDE) < 0.04, 'an ordinary video is still the 16:9 box', { ratio: m.ratio, w: m.mediaW, h: m.mediaH });
    check(m.vertical === false && m.label === 'YouTubeyoutube.com', 'with the plain card and the plain header', { vertical: m.vertical, label: m.label });
    check(m.cardW > 400 && m.labelPos === 'static' && m.mediaBelowLabel === true,
      'and the same banner along the top, full width', { card: m.cardW, pos: m.labelPos, below: m.mediaBelowLabel });
    check((await ev('window.__play()')) === true, 'playing the wide one too');
    m = await ev(PROBE);
    check(m.isPlayer === true && m.labelPos === 'static' && m.mediaBelowLabel === true,
      'keeps that banner where it was — the same anatomy on both shapes, before and after',
      { pos: m.labelPos, below: m.mediaBelowLabel, cls: m.cardCls });

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
