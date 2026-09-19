// More than one photo in a message is a GALLERY, not a column (see AGENTS.md
// verification conventions).
//
// The request: "uploading multiple photos in the same message ... makes them a
// gallery type arrangement instead of always vertically aligned. Make it look
// good even with odd numbers of pics." Photos used to stack one per row, so four
// of them were a column ~1200px tall, and an odd count simply ended with a gap.
//
// The arrangement follows the COUNT, which is a fact only the renderer knows
// (attsBlockHTML in messages.js): 2 = two squares, 3 = one tall + two, 4 = two by
// two, 5 = one tall + four — the last two being the counts a plain two-column
// grid leaves a hole in. The tall tile is the first, spanning both rows.
//
// This test has three halves:
//   [0] static wiring, always: the class comes from a helper msgHTML calls, the
//       gallery needs 2+ attachments that are ALL pictures, the pinned-message
//       panel (which renders its own narrow list) is untouched, and the CSS rules
//       are in an order that works — the spanning tile's `aspect-ratio:auto` must
//       come AFTER the square, and the warning card IS a grid item, not a child
//       of a slot;
//   [1] the REAL attachmentHTML + attsBlockHTML + styles.css in headless Chrome:
//       for 1..5 photos the class, the tile sizes, the exact span, that the grid
//       is completely FILLED (no hole at any count), the square crop, the
//       original kept on every tile for the lightbox, and the one state rendered
//       in place of a slot (virus-removed);
//   [2] the republish patch still fits a tile (its markup is rebuilt without any
//       gallery class of its own — the tile must style it anyway).
//
// Skips the browser half (exit 0) when Chrome is unavailable.
//
// Usage: node scripts/test-photo-gallery.js

'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9357', 10);
const GAP = 4;

// A 1x1 PNG: what the tiles are painted with does not matter to their geometry
// (the crop is what the stylesheet does), and every photo the fixture posts says
// its own shape in its w/h — which the gallery deliberately ignores.
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

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

const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const messages = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
const pins = fs.readFileSync(path.join(ROOT, 'public/js/pins.js'), 'utf8');

// The real attachment markup + the block builder, exactly as test-image-previews
// slices them (the block builder lives inside this range).
const MARK_START = messages.indexOf('const DL_ICON =');
const MARK_END = messages.indexOf('// ---------- video posters:');
if (MARK_START < 0 || MARK_END < 0) {
  console.error('[test] could not locate the attachmentHTML block in public/js/messages.js');
  process.exit(1);
}
const markSource = messages.slice(MARK_START, MARK_END);

// Five photos whose own shapes are all different (landscape, portrait, square,
// wide, tall) — a gallery ignores every one of them.
const SHAPES = [[480, 320], [320, 480], [420, 420], [600, 300], [300, 420]];
function photo(i, extra) {
  return Object.assign({
    id: 'att' + i, kind: 'image', mime: 'image/jpeg', url: '/uploads/files/p' + i + '.jpg?v=1',
    name: 'p' + i + '.jpg', size: 120000 + i, w: SHAPES[i][0], h: SHAPES[i][1],
  }, extra || {});
}
const CASES = [
  { title: '1 photo', atts: [photo(0)] },
  { title: '2 photos', atts: [photo(0), photo(1)] },
  { title: '3 photos', atts: [photo(0), photo(1), photo(2)] },
  { title: '4 photos', atts: [photo(0), photo(1), photo(2), photo(3)] },
  { title: '5 photos', atts: [photo(0), photo(1), photo(2), photo(3), photo(4)] },
  { title: '2 photos + a file', atts: [photo(0), photo(1), { id: 'f1', kind: 'file', url: '/uploads/files/p0.jpg', name: 'notes.pdf', size: 40213 }] },
  { title: '2 photos + a clip', atts: [photo(0), { id: 'v1', kind: 'video', mime: 'video/mp4', url: '/uploads/files/clip.mp4', name: 'clip.mp4', size: 900000, w: 1280, h: 720 }] },
  { title: '3 photos, one removed', atts: [photo(0), photo(1), photo(2, { scan: 'infected' })] },
];

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/styles.css">
<style>
html,body{margin:0;background:var(--bg);font-family:system-ui,sans-serif}
#wrap{display:flex;flex-direction:column;gap:16px;padding:16px 12px 40px}
.case-label{font:700 11px/1 system-ui;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);margin:0 0 6px}
.msg{display:flex;gap:.7rem;align-items:flex-start}
.msg .avatar{width:38px;height:38px;border-radius:50%;background:var(--panel-3);flex-shrink:0}
</style></head><body><div id="wrap"></div>
<script>
const CASES = ${JSON.stringify(CASES)};
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtSize() { return '120 KB'; }
function toast() {}
function audioPlayerHTML() { return ''; }
function textPreviewable() { return false; }
function textFileHTML() { return ''; }
function attFromEl() { return null; }
${markSource}
document.getElementById('wrap').innerHTML = CASES.map((c) => '<div class="case"><div class="case-label">' + c.title + '</div><div class="msg"><span class="avatar ghost"></span><div class="body">' + attsBlockHTML(c.atts) + '</div></div></div>').join('');
document.querySelectorAll('img.att-img').forEach((im) => wireAttImage(im));
// One case's grid, measured: the container, every tile, and what each tile says
// about the picture it is standing in for.
window.__grid = function (i) {
  const g = document.querySelectorAll('.case')[i].querySelector('.msg-atts');
  const r = g.getBoundingClientRect();
  const body = g.parentElement.getBoundingClientRect();
  return {
    cls: g.className,
    w: +r.width.toFixed(1), h: +r.height.toFixed(1),
    bodyW: +body.width.toFixed(1),
    display: getComputedStyle(g).display,
    tiles: [...g.children].map((t) => {
      const b = t.getBoundingClientRect();
      const img = t.querySelector('img.att-img');
      return {
        cls: t.className.split(' ')[0],
        x: +(b.left - r.left).toFixed(1), y: +(b.top - r.top).toFixed(1),
        w: +b.width.toFixed(1), h: +b.height.toFixed(1),
        row: getComputedStyle(t).gridRow,
        fit: img ? getComputedStyle(img).objectFit : '',
        orig: img ? (img.dataset.fbUrl || '') : '',
        radius: getComputedStyle(t.querySelector('.att-wrap') || t).borderRadius,
      };
    }),
  };
};
// What the pending -> final patch does to ONE attachment where it stands: the
// renderer's own body markup, dropped into the tile it belongs to.
window.__repatch = function (i) {
  const g = document.querySelectorAll('.case')[i].querySelector('.msg-atts');
  const slot = g.querySelector('.att-slot');
  const a = CASES[i].atts[0];
  slot.innerHTML = attachmentBodyHTML(a, { live: false });
  slot.querySelectorAll('img.att-img').forEach((im) => wireAttImage(im));
  return true;
};
</script></body></html>`;
}

// A tile arrangement covers the block exactly: every band of rows is filled edge
// to edge (gaps only), the rows are contiguous, the last one ends at the block's
// bottom, and the tall tile spans exactly two of them plus a gap. That is what
// "no hole" means at every count.
function gridIsFull(g) {
  if (!g.w || !g.h) return false;
  const tall = g.tiles.filter((t) => t.row === 'span 2');
  const plain = g.tiles.filter((t) => t.row !== 'span 2');
  if (!plain.length || tall.length > 1) return false;
  const rows = new Map();
  for (const t of plain) {
    if (!rows.has(t.y)) rows.set(t.y, []);
    rows.get(t.y).push(t);
  }
  const ys = [...rows.keys()].sort((a, b) => a - b);
  let expectY = 0;
  for (const y of ys) {
    if (Math.abs(y - expectY) > 1) return false;
    // Everything standing in this band — the tall tile included — must fill the
    // width of the block, with the tile gap (and nothing more) between them.
    const band = g.tiles
      .filter((t) => t.y <= y + 1 && t.y + t.h > y + 1)
      .map((t) => [t.x, t.x + t.w])
      .sort((a, b) => a[0] - b[0]);
    let edge = 0;
    for (const [l, r] of band) {
      if (l - edge > GAP + 1) return false;
      edge = Math.max(edge, r);
    }
    if (Math.abs(edge - g.w) > 1) return false;
    expectY = y + Math.max(...rows.get(y).map((t) => t.h)) + GAP;
  }
  if (Math.abs((expectY - GAP) - g.h) > 1) return false;
  const rowH = Math.max(...plain.map((t) => t.h));
  for (const t of tall) {
    if (Math.abs(t.y) > 1 || Math.abs(t.w - plain[0].w) > 1 || Math.abs(t.h - (2 * rowH + GAP)) > 1) return false;
  }
  return true;
}

async function main() {
  console.log('\n[0] the wiring: one block per message, a gallery only of pictures');
  check(/function attsBlockHTML\(list\)/.test(messages), 'the block is built in one place (attsBlockHTML)');
  check(/inner \+= attsBlockHTML\(m\.attachments\);/.test(messages), 'and that is what msgHTML paints');
  check(/const gallery = atts\.length > 1 && atts\.every\(\(a\) => \(a && a\.kind \? a\.kind : 'file'\) === 'image'\);/.test(messages),
    'a gallery needs MORE THAN ONE attachment and every one of them a picture');
  check(/const cls = 'msg-atts' \+ \(gallery \? ' gallery g' \+ Math\.min\(atts\.length, 5\) : ''\);/.test(messages),
    'the count rides the container as g2…g5 (the composer caps a message at five)');
  check(/attsEl\.innerHTML = atts\.map\(attachmentHTML\)\.join\(''\);/.test(pins),
    'the pinned-message panel keeps its own stacked rendering (a narrow list, not a gallery)');

  console.log('\n[1] the stylesheet, in an order that works');
  check(/\.msg-atts\.gallery\{display:grid;gap:4px;width:min\(420px,100%\);grid-template-columns:repeat\(2,1fr\)\}/.test(css),
    'the block is a two-column grid, capped like a single picture');
  check(/\.msg-atts\.gallery\.g5\{grid-template-columns:repeat\(3,1fr\)\}/.test(css), 'five photos get a third column');
  check(/\.msg-atts\.gallery > \.att-slot\{width:100%;min-width:0;aspect-ratio:1\}/.test(css),
    'a tile is a square and fills its cell');
  const spanAt = css.indexOf('.msg-atts.gallery.g3 > :first-child');
  const squareAt = css.indexOf('.msg-atts.gallery > .att-slot{');
  check(spanAt > squareAt && spanAt > 0,
    'the tall tile\'s `aspect-ratio:auto` comes AFTER the square (same specificity: later wins)',
    { squareAt, spanAt });
  check(/\.msg-atts\.gallery\.g3 > :first-child,\.msg-atts\.gallery\.g5 > :first-child\{grid-row:span 2;aspect-ratio:auto;align-self:stretch;height:100%\}/.test(css),
    'the first tile spans both rows — and is told to fill them (a span alone left it content-tall, measured)');
  check(/\.msg-atts\.gallery > \.scan-block\{[^}]*aspect-ratio:1[^}]*\}/.test(css),
    'the warning card IS the grid item (attachmentHTML returns it in place of the slot), so it is square too');
  check(!/\.msg-atts\.gallery > \.att-slot > \.scan-block/.test(css), 'and is not looked for inside a slot it never has');
  check(/\.msg-atts\.gallery img\.att-img\{width:100%;height:100%;max-width:100%;max-height:none;object-fit:cover\}/.test(css),
    'the photo fills the tile (a contact sheet: the crop is the tile, the whole picture is the lightbox)');
  check(/\.msg-atts\.gallery \.att-wrap\{display:block;width:100%!important;height:100%;max-width:100%;overflow:hidden;border-radius:12px;aspect-ratio:auto\}/.test(css),
    'the wrap fills the tile, and overrides the width an attachment reserves for its own shape');

  const chromePath = findChrome();
  if (!chromePath) {
    console.log('\n[2] SKIP the browser half: no Chrome/Edge found (set CHROME_PATH)');
    return finish();
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-gallery-'));
  const srv = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/styles.css')) { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end(css); }
    if (url.startsWith('/uploads/files/')) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': TINY_PNG.length });
      return res.end(TINY_PNG);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(pageHtml());
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;

  const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=900,1400', 'about:blank'], { stdio: 'ignore' });

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
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const call = (method, params, sessionId) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (m) => (m.error ? rej(new Error(method + ' — ' + JSON.stringify(m.error))) : res(m.result)));
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
    await sess('Emulation.setDeviceMetricsOverride', { width: 900, height: 1400, deviceScaleFactor: 2, mobile: false });
    await sess('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
    await sleep(500);
    if (!(await evaluate('typeof window.__grid === "function"'))) {
      console.error('[test] the extracted messages.js code did not evaluate in the page');
      process.exit(1);
    }

    console.log('\n[2] the arrangements, measured in a real browser');
    const grids = [];
    for (let i = 0; i < CASES.length; i++) grids.push(await evaluate(`window.__grid(${i})`));

    check(grids[0].cls === 'msg-atts' && grids[0].display === 'flex',
      'ONE photo is not a gallery: it keeps the shape its own bytes asked for', grids[0].cls);
    check(grids[0].tiles.length === 1 && grids[0].tiles[0].fit === 'contain',
      'and is fitted, never cropped', grids[0].tiles[0]);
    check(grids[5].cls === 'msg-atts' && grids[5].tiles.length === 3,
      'a message with a FILE in it is not a gallery either', grids[5].cls);
    check(grids[6].cls === 'msg-atts' && grids[6].tiles.length === 2,
      'nor one with a clip', grids[6].cls);

    for (let n = 2; n <= 5; n++) {
      const g = grids[n - 1];
      const cols = n === 5 ? 3 : 2;
      check(g.cls === 'msg-atts gallery g' + n, `${n} photos are a gallery block (g${n})`, g.cls);
      check(g.display === 'grid' && g.tiles.length === n, 'as a grid with one tile per photo', { display: g.display, tiles: g.tiles.length });
      check(Math.abs(g.w - 420) <= 1, `the block is 420px wide (the chat media cap)`, g.w);
      check(gridIsFull(g), `and the grid is completely FULL at ${n} (no hole, any count)`, { w: g.w, h: g.h, tiles: g.tiles });

      const tall = n === 3 || n === 5;
      const rest = g.tiles.slice(tall ? 1 : 0);
      const squares = rest.every((t) => Math.abs(t.w - t.h) <= 1);
      check(squares, 'every other tile is a perfect square', rest.map((t) => t.w + '×' + t.h));
      check(rest.every((t) => t.fit === 'cover'), 'with the photo cropped to it (object-fit:cover)', [...new Set(rest.map((t) => t.fit))]);
      check(rest.every((t) => t.radius === '12px'), 'and the app\'s 12px rounding', [...new Set(rest.map((t) => t.radius))]);
      if (tall) {
        const t0 = g.tiles[0];
        check(t0.row === 'span 2', `the first tile is the tall one at ${n}`, t0.row);
        check(Math.abs(t0.h - (2 * t0.w + GAP)) <= 1.5,
          'exactly two squares plus the gap tall, so the odd count fills the block',
          { h: t0.h, expected: 2 * t0.w + GAP });
        check(Math.abs(t0.w - rest[0].w) <= 1, 'and one column wide, like the rest', { tall: t0.w, square: rest[0].w });
      }
      check(g.tiles.every((t) => t.orig && /^\/uploads\/files\/p\d\.jpg/.test(t.orig)),
        'every tile keeps the ORIGINAL url, so a tap opens the whole photo (not the crop)', g.tiles.map((t) => t.orig));
    }

    console.log('\n[3] the state a tile can be in');
    const infectedCard = grids[7].tiles[2];
    check(grids[7].cls === 'msg-atts gallery g3' && infectedCard.cls === 'scan-block',
      'a photo the scanner removed is the warning card, IN the grid', { cls: grids[7].cls, tile: infectedCard.cls });
    check(Math.abs(infectedCard.w - grids[7].tiles[1].w) <= 1 && Math.abs(infectedCard.h - grids[7].tiles[1].h) <= 1,
      'and it is a tile like any other (the card IS the grid item, not a slot child)',
      { card: infectedCard.w + '×' + infectedCard.h, square: grids[7].tiles[1].w + '×' + grids[7].tiles[1].h });

    console.log('\n[4] a verdict landing must not break the tile');
    await evaluate('window.__repatch(1)');
    const after = await evaluate('window.__grid(1)');
    check(gridIsFull(after), 'the grid is still full after one attachment is rebuilt in place', after.tiles);
    const t1 = after.tiles[0];
    check(Math.abs(t1.w - t1.h) <= 1 && t1.fit === 'cover',
      'and the rebuilt tile is still the same square, with its photo still cropped to it',
      { w: t1.w, h: t1.h, fit: t1.fit });

    console.log('\n[5] a phone: the same arrangement, scaled to the column');
    await sess('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await sess('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
    await sleep(500);
    for (const [idx, n] of [[2, 3], [4, 5], [3, 4]]) {
      const g = await evaluate(`window.__grid(${idx})`);
      check(g.cls === 'msg-atts gallery g' + n && Math.abs(g.w - g.bodyW) <= 1,
        `${n} photos take the whole column on a phone (${g.w}px of ${g.bodyW}px), still a gallery`, g.cls);
      check(g.w < 420, 'which is narrower than the 420px cap the desktop block uses', g.w);
      check(gridIsFull(g), `and the grid is full there too, at ${n}`, g.tiles);
      check(g.tiles.every((t) => t.row === 'span 2' || Math.abs(t.w - t.h) <= 1),
        'with the same squares (and the same tall first tile)', g.tiles.map((t) => t.w + '×' + t.h));
    }
  } catch (e) {
    console.error('[test] ' + (e && e.stack || e));
    process.exit(1);
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome.kill(); } catch {}
    try { srv.close(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  return finish();
}

function finish() {
  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
