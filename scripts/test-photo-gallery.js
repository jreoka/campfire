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
// two, 5 = one tall + four, 6 = three by two, 7 = one tall + six, 8 = three by
// three with two on the last row, 10 = three by four — every count a message can
// carry (the composer caps it at ten). The counts a plain grid leaves a hole in
// (odd: 3/5/7/9) get the tall first tile, spanning both rows.
//
// This test has three halves:
//   [0] static wiring, always: the class comes from a helper msgHTML calls, the
//       gallery needs 2+ attachments that are ALL pictures, the pinned-message
//       panel (which renders its own narrow list) is untouched, and the CSS rules
//       are in an order that works — the spanning tile's `aspect-ratio:auto` must
//       come AFTER the square, and the warning card IS a grid item, not a child
//       of a slot;
//   [1] the REAL attachmentHTML + attsBlockHTML + styles.css in headless Chrome:
//       for 1..10 photos the class, the tile sizes, the exact span, that the grid
//       is completely FILLED (no hole at any count it can fill), the square crop,
//       the original kept on every tile for the lightbox, and the one state
//       rendered in place of a slot (virus-removed);
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

// Photos whose own shapes are all different (landscape, portrait, square, wide,
// tall) — a gallery ignores every one of them. The shapes cycle, so a case can
// hold as many photos as a message is allowed to carry.
const SHAPES = [[480, 320], [320, 480], [420, 420], [600, 300], [300, 420]];
function photo(i, extra) {
  const [w, h] = SHAPES[i % SHAPES.length];
  return Object.assign({
    id: 'att' + i, kind: 'image', mime: 'image/jpeg', url: '/uploads/files/p' + i + '.jpg?v=1',
    name: 'p' + i + '.jpg', size: 120000 + i, w, h,
  }, extra || {});
}
// A clip carries its own shape too (1280×720 here) and the gallery ignores it for
// the same reason it ignores a photo's: the tile is the square.
function clip(i, extra) {
  return Object.assign({
    id: 'vid' + i, kind: 'video', mime: 'video/mp4', url: '/uploads/files/v' + i + '.mp4?v=1',
    name: 'v' + i + '.mp4', size: 900000 + i, w: 1280, h: 720,
  }, extra || {});
}
const CASES = [
  { title: '1 photo', atts: [photo(0)] },
  { title: '2 photos', atts: [photo(0), photo(1)] },
  { title: '3 photos', atts: [photo(0), photo(1), photo(2)] },
  { title: '4 photos', atts: [photo(0), photo(1), photo(2), photo(3)] },
  { title: '5 photos', atts: [photo(0), photo(1), photo(2), photo(3), photo(4)] },
  { title: '2 photos + a file', atts: [photo(0), photo(1), { id: 'f1', kind: 'file', url: '/uploads/files/p0.jpg', name: 'notes.pdf', size: 40213 }] },
  { title: '2 photos + a clip', atts: [photo(0), clip(0)] },
  { title: '3 photos, one removed', atts: [photo(0), photo(1), photo(2, { scan: 'infected' })] },
  { title: '6 photos', atts: [0, 1, 2, 3, 4, 5].map((i) => photo(i)) },
  { title: '7 photos', atts: [0, 1, 2, 3, 4, 5, 6].map((i) => photo(i)) },
  { title: '8 photos', atts: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => photo(i)) },
  { title: '9 photos', atts: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => photo(i)) },
  { title: '10 photos (the cap)', atts: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => photo(i)) },
  { title: '3 photos + 2 clips', atts: [photo(0), photo(1), photo(2), clip(0), clip(1)] },
  { title: '2 photos + a voice note', atts: [photo(0), photo(1), { id: 'a1', kind: 'audio', mime: 'audio/mp4', url: '/uploads/files/note.m4a', name: 'Voice message', size: 21000 }] },
  { title: '5 clips', atts: [0, 1, 2, 3, 4].map((i) => clip(i)) },
];
// The count a gallery is arranged by: 2 columns up to four, three columns from
// five (the widths a 420px chat block makes sane), and the tall first tile on the
// odd counts — which is every count the tall arrangement can leave no hole in.
const colsFor = (n) => (n >= 5 ? 3 : 2);
// The counts whose first tile spans two rows. 7 is deliberately not one of them:
// `dense` is what fills a 7 (see the stylesheet), and a spanned first tile there
// was measured leaving the last row short.
const tallAt = (n) => n === 3 || n === 5 || n === 9;
const ARRANGED = [2, 3, 4, 5, 6, 7, 8, 9, 10];
// Where each case sits in CASES, by what it is: the plain runs of photos are 2..5
// and then 6..10 (the cap), with the fixtures that are not a run of photos in
// between and the mixed-media ones after them. The test reads a case by what it
// holds, so this is the one place the layout of CASES has to be known.
const IX = { photo1: 0, photo2: 1, photo3: 2, photo4: 3, photo5: 4, withFile: 5, withClip: 6, infected: 7, photo6: 8, photo7: 9, photo8: 10, photo9: 11, photo10: 12, mixed5: 13, withVoice: 14, clips5: 15 };

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
// The render path's own wiring for the clips (paintMessage does all three).
document.querySelectorAll('video.att-vid').forEach((v) => wireVideoPlayState(v));
// One case's grid, measured: the container, every tile, and what each tile says
// about the picture (or the clip) it is standing in for.
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
      const vid = t.querySelector('video.att-vid');
      const wrap = t.querySelector('.att-wrap');
      const vb = vid ? vid.getBoundingClientRect() : null;
      return {
        cls: t.className.split(' ')[0],
        x: +(b.left - r.left).toFixed(1), y: +(b.top - r.top).toFixed(1),
        w: +b.width.toFixed(1), h: +b.height.toFixed(1),
        row: getComputedStyle(t).gridRow,
        fit: img ? getComputedStyle(img).objectFit : '',
        orig: img ? (img.dataset.fbUrl || '') : '',
        radius: getComputedStyle(t.querySelector('.att-wrap') || t).borderRadius,
        // A clip's tile: does the player fill it, how is it fitted, is the tile
        // marked as a clip, and is it playing? The mark is the ::after triangle,
        // and it takes TWO readings, because a computed style keeps its specified
        // values even when the pseudo is not rendered: content says whether the
        // rule applies at all (a photo's wrap has none), display says whether it
        // is drawn right now (none while the clip plays).
        vid: !!vid,
        vidFit: vid ? getComputedStyle(vid).objectFit : '',
        // A collage tile is the media viewer's door, not a player: attVideoHTML
        // builds it WITHOUT native controls (see the lightbox test), because a
        // control strip inside a 120px square owns most of the tile and pressing
        // play there would show a crop of the clip.
        controls: vid ? vid.hasAttribute('controls') : null,
        vidW: vb ? +vb.width.toFixed(1) : 0,
        vidH: vb ? +vb.height.toFixed(1) : 0,
        badgeContent: wrap ? getComputedStyle(wrap, '::after').content : '',
        badgeDisplay: wrap ? getComputedStyle(wrap, '::after').display : '',
        badgeW: wrap ? getComputedStyle(wrap, '::after').borderLeftWidth : '',
        wrapCls: wrap ? wrap.className : '',
      };
    }),
  };
};
// Press play on one tile's clip — the event a real player fires, which is exactly
// what the wiring listens for (a headless page cannot actually play media).
window.__play = function (i, t) {
  const g = document.querySelectorAll('.case')[i].querySelector('.msg-atts');
  const vid = g.children[t] && g.children[t].querySelector('video.att-vid');
  if (!vid) return false;
  vid.dispatchEvent(new Event('play'));
  return true;
};
// What the republish patch does to ONE attachment where it stands: the renderer's
// own body markup, dropped into the tile it belongs to — with the SAME tile flag
// the patch path reads off the element it is replacing (patchVideoNode).
window.__repatch = function (i) {
  const g = document.querySelectorAll('.case')[i].querySelector('.msg-atts');
  const slot = g.querySelector('.att-slot');
  const a = CASES[i].atts[0];
  const tile = !!slot.closest('.msg-atts.gallery');
  slot.innerHTML = attachmentBodyHTML(a, tile ? { live: false, tile: true } : { live: false });
  slot.querySelectorAll('img.att-img').forEach((im) => wireAttImage(im));
  return true;
};
// …and what it does to a CLIP tile: patchVideoNode rebuilds the WRAP with
// attVideoHTML and the tile flag read off the element it is replacing.
window.__repatchVid = function (i, t) {
  const g = document.querySelectorAll('.case')[i].querySelector('.msg-atts');
  const wrap = g.children[t].querySelector('.att-wrap');
  const a = CASES[i].atts[t];
  const box = document.createElement('span');
  box.innerHTML = attVideoHTML(Object.assign({}, a, { scan: 'clean' }), { live: false, tile: !!wrap.closest('.msg-atts.gallery') });
  wrap.replaceWith(box.firstElementChild);
  return true;
};
</script></body></html>`;
}

// A tile arrangement covers the block completely. Two questions, both asked off
// the ROWS (the tiles that do not span):
//   [1] the rows' horizontal coverage — every tile standing anywhere in a row,
//       a spanning one included, taken as its [x, x+w] — is one unbroken run from
//       the left edge of the block to the right edge. A hole at the end of a short
//       row, or under a tile that stops early, both show up here.
//   [2] the rows stack with nothing but the tile gap between them and the last one
//       ends at the block's bottom.
// A spanning tile must then be exactly as tall as the rows it covers (2 for the
// two-row arrangement, which is every count this block draws).
function gridIsFull(g, debug) {
  const why = (m) => { if (debug) console.log('    gridIsFull: ' + m); return false; };
  if (!g.w || !g.h) return why('no box');
  const rows = [];
  // The rows are the tiles that do not span — a spanning tile's top edge is the
  // top of a row it is NOT alone in, so letting it in would make that row read as
  // two different heights.
  for (const t of g.tiles.filter((x) => x.row !== 'span 2').sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs(r.y - t.y) <= 0.5);
    if (row) row.tiles.push(t);
    else rows.push({ y: t.y, tiles: [t] });
  }
  if (!rows.length) return why('no rows');
  const lastY = Math.max(...rows.map((r) => r.y));
  // [1] horizontal coverage, per row, with the spanning tiles standing in it too.
  //     Every row but the last must reach the block's right edge; the last one may
  //     END short when a count leaves an odd tile there (7, 10) — that is the gap a
  //     10-photo message would otherwise show, and the layout is what makes it
  //     acceptable, not a hole in the middle of the block.
  for (const row of rows) {
    const band = g.tiles
      .filter((t) => t.y <= row.y + 0.5 && t.y + t.h >= row.y + 0.5)
      .map((t) => [t.x, t.x + t.w])
      .sort((a, b) => a[0] - b[0]);
    let edge = 0;
    for (const [l, r] of band) {
      if (l - edge > GAP + 1) return why('gap at y=' + row.y + ' before x=' + l);
      edge = Math.max(edge, r);
    }
    const last = Math.abs(row.y - lastY) <= 0.5;
    if (last ? (edge > g.w + 1 || edge <= 0) : Math.abs(edge - g.w) > 1) {
      return why('row y=' + row.y + ' ends at ' + edge + ', block is ' + g.w);
    }
  }
  // [2] the rows stack, and reach the bottom exactly. A row's tiles are all as tall
  //     as the row — except the last one, whose lone tile may be stretched across
  //     the leftover width (that is the layout's own choice, measured above).
  let expectY = 0;
  for (const row of rows) {
    if (Math.abs(row.y - expectY) > 1) return why('row at ' + row.y + ' expected ' + expectY);
    const h = Math.max(...row.tiles.map((t) => t.h));
    const last = Math.abs(row.y - lastY) <= 0.5;
    if (!last && !row.tiles.every((t) => Math.abs(t.h - h) <= 1)) return why('mixed heights in row y=' + row.y + ': ' + row.tiles.map((t) => t.h));
    expectY = row.y + h + GAP;
  }
  if (Math.abs((expectY - GAP) - g.h) > 1) return why('bottom ' + (expectY - GAP) + ', block ' + g.h);
  for (const t of g.tiles) {
    if (t.row !== 'span 2') continue;
    const covered = rows.filter((r) => r.y >= t.y - 1 && r.y < t.y + t.h - 1);
    if (covered.length !== 2) return why('span covers ' + covered.length + ' rows');
    const expected = covered.reduce((s, r) => s + Math.max(...r.tiles.map((x) => x.h)), 0) + GAP;
    if (Math.abs(t.h - expected) > 1.5) return why('span height ' + t.h + ' expected ' + expected);
  }
  return true;
}

async function main() {
  console.log('\n[0] the wiring: one block per message, a gallery of pictures AND clips');
  check(/function attsBlockHTML\(list\)/.test(messages), 'the block is built in one place (attsBlockHTML)');
  check(/inner \+= attsBlockHTML\(m\.attachments\);/.test(messages), 'and that is what msgHTML paints');
  check(/function attsCollage\(atts\) \{\s*return atts\.length > 1 && atts\.every\(\(a\) => !!a && \(a\.kind === 'image' \|\| a\.kind === 'video'\)\);\s*\}/.test(messages),
    'a gallery needs MORE THAN ONE attachment and every one a picture OR a clip (reported: one video dropped the whole collage)');
  check(/const gallery = attsCollage\(atts\);\s*\n\s*const cls = 'msg-atts' \+ \(gallery \? ' gallery g' \+ Math\.min\(atts\.length, 11\) : ''\);/.test(messages),
    'the count rides the container as g2…g10 — plus one class past them, so an over-cap list still lands on a grid');
  check(/attsEl\.innerHTML = atts\.map\(attachmentHTML\)\.join\(''\);/.test(pins),
    'the pinned-message panel keeps its own stacked rendering (a narrow list, not a gallery)');
  check(/wireVideoPlayState\(v\)/.test(messages) && /v\.addEventListener\('play', on\)/.test(messages)
    && !/classList\.toggle\('vid-playing', !v\.paused\)/.test(messages),
    'a clip marks its tile from the EVENTS a player fires — never by reading `paused`, which a test cannot drive');
  // A tile is the media viewer's DOOR (reported: "if a video is in a collage, can
  // it open in a lightbox"): it carries no controls of its own, and it is built
  // that way by the one place that knows it is a tile.
  check(/\$\{tile \? '' : ' controls'\}/.test(messages) && /const tile = !!\(opts && opts\.tile\);/.test(messages),
    'a collage tile is built WITHOUT native controls (attVideoHTML), so the tile is not a player');
  check(/atts\.map\(\(a\) => attachmentHTML\(a, gallery \? \{ tile: true \} : undefined\)\)/.test(messages),
    'every attachment of a collage block is built as a tile, and a block that is not a collage is not');
  check(/tile: !!\(oldEl\.closest && oldEl\.closest\('\.msg-atts\.gallery'\)\)/.test(messages),
    'and a clip republished in place is rebuilt as the same kind of clip it replaced');

  console.log('\n[1] the stylesheet, in an order that works');
  check(/\.msg-atts\.gallery\{display:grid;grid-auto-flow:dense;gap:4px;width:min\(420px,100%\);grid-template-columns:repeat\(2,1fr\)\}/.test(css),
    'the block is a two-column grid, capped like a single picture, packed densely (a message can carry any count up to ten)');
  check(/\.msg-atts\.gallery\.g5,\.msg-atts\.gallery\.g6,\.msg-atts\.gallery\.g7,\.msg-atts\.gallery\.g8,\.msg-atts\.gallery\.g9,\.msg-atts\.gallery\.g10\{grid-template-columns:repeat\(3,1fr\)\}/.test(css),
    'five photos and up get a third column (ten 2-wide tiles in a 420px block would be a 2200px column)');
  check(/\.msg-atts\.gallery > \.att-slot\{width:100%;min-width:0;aspect-ratio:1\}/.test(css),
    'a tile is a square and fills its cell');
  const spanAt = css.indexOf('.msg-atts.gallery.g3 > :first-child');
  const squareAt = css.indexOf('.msg-atts.gallery > .att-slot{');
  check(spanAt > squareAt && spanAt > 0,
    'the tall tile\'s `aspect-ratio:auto` comes AFTER the square (same specificity: later wins)',
    { squareAt, spanAt });
  check(/\.msg-atts\.gallery\.g3 > :first-child,\.msg-atts\.gallery\.g5 > :first-child,\.msg-atts\.gallery\.g9 > :first-child\{grid-row:span 2;aspect-ratio:auto;align-self:stretch;height:100%\}/.test(css),
    'the first tile spans both rows at the counts a span fills — and is told to fill them (a span alone left it content-tall, measured)');
  check(/\.msg-atts\.gallery > \.scan-block\{[^}]*aspect-ratio:1[^}]*\}/.test(css),
    'the warning card IS the grid item (attachmentHTML returns it in place of the slot), so it is square too');
  check(!/\.msg-atts\.gallery > \.att-slot > \.scan-block/.test(css), 'and is not looked for inside a slot it never has');
  check(/\.msg-atts\.gallery img\.att-img\{width:100%;height:100%;max-width:100%;max-height:none;object-fit:cover\}/.test(css),
    'the photo fills the tile (a contact sheet: the crop is the tile, the whole picture is the lightbox)');
  check(/\.msg-atts\.gallery \.att-wrap\{display:block;width:100%!important;height:100%;max-width:100%;overflow:hidden;border-radius:12px;aspect-ratio:auto\}/.test(css),
    'the wrap fills the tile, and overrides the width an attachment reserves for its own shape');
  check(/\.msg-atts\.gallery video\.att-vid\{width:100%;height:100%;max-width:100%;max-height:none;object-fit:cover\}/.test(css),
    'a CLIP fills its tile exactly as a photo does (a clip has a poster frame like any other media)');
  check(/\.msg-atts\.gallery \.att-wrap:has\(video\.att-vid\)::after\{[^}]*border-left:14px solid/.test(css)
    && /\.msg-atts\.gallery \.att-wrap:has\(video\.att-vid\)::before\{[^}]*background:rgba\(4,6,11,\.28\)/.test(css),
    'and its tile says so — the veil + play triangle the inbox video tile uses (.inbox-thumb.video), drawn by the tile itself');
  check(/\.msg-atts\.gallery \.att-wrap\.vid-playing video\.att-vid\{object-fit:contain\}/.test(css)
    && /\.msg-atts\.gallery \.att-wrap\.vid-playing::before,\.msg-atts\.gallery \.att-wrap\.vid-playing::after\{display:none\}/.test(css),
    'while playing it shows its WHOLE frame: the tile stays the square (the grid cannot reflow) and the crop goes');

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

    check(grids[IX.photo1].cls === 'msg-atts' && grids[IX.photo1].display === 'flex',
      'ONE photo is not a gallery: it keeps the shape its own bytes asked for', grids[IX.photo1].cls);
    check(grids[IX.photo1].tiles.length === 1 && grids[IX.photo1].tiles[0].fit === 'contain',
      'and is fitted, never cropped', grids[IX.photo1].tiles[0]);
    check(grids[IX.withFile].cls === 'msg-atts' && grids[IX.withFile].tiles.length === 3,
      'a message with a FILE in it is not a gallery (a 120px square is not a document)', grids[IX.withFile].cls);
    check(grids[IX.withVoice].cls === 'msg-atts',
      'nor one with a voice note (nor a player in a tile)', grids[IX.withVoice].cls);

    for (const n of ARRANGED) {
      const g = grids[IX['photo' + n]];
      const cols = colsFor(n);
      check(g.cls === 'msg-atts gallery g' + n, `${n} photos are a gallery block (g${n})`, g.cls);
      check(g.display === 'grid' && g.tiles.length === n, 'as a grid with one tile per photo', { display: g.display, tiles: g.tiles.length });
      check(Math.abs(g.w - 420) <= 1, `the block is 420px wide (the chat media cap)`, g.w);
      check(gridIsFull(g), `and the grid is completely FULL at ${n} (no hole, any count)`, { w: g.w, h: g.h, tiles: g.tiles });

      const tall = tallAt(n);
      const rest = g.tiles.slice(tall ? 1 : 0);
      const squares = rest.filter((t) => Math.abs(t.w - t.h) <= 1);
      const stretched = rest.filter((t) => Math.abs(t.w - t.h) > 1);
      // A count whose last row ends one column short (8 and 10) leaves the lone
      // tile filling that row — wider than tall, and the only tile there. Anything
      // else that is not square would be a layout this test does not expect.
      const lastBand = Math.max(...g.tiles.map((t) => t.y));
      check(squares.length >= rest.length - 1 && stretched.every((t) => {
        const band = g.tiles.filter((s) => Math.abs(s.y - t.y) <= 1);
        return band.length === 1 && Math.abs(t.y - lastBand) <= 1 && t.w > t.h;
      }), 'every tile is a perfect square (bar a lone one stretched across its row)',
        rest.map((t) => t.w + '×' + t.h));
      check(rest.filter((t) => Math.abs(t.w - t.h) <= 1).every((t) => t.fit === 'cover'),
        'with the photo cropped to it (object-fit:cover)', [...new Set(rest.map((t) => t.fit))]);
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

    console.log('\n[3] a tile can also be a CLIP (reported: it dropped the whole collage)');
    // 2 photos + a clip: the reported shape — one video in the set used to send
    // every tile back to full-width stacking.
    const pair = grids[IX.withClip];
    check(pair.cls === 'msg-atts gallery g2' && pair.display === 'grid' && pair.tiles.length === 2,
      'a photo and a clip together are still a gallery block', { cls: pair.cls, display: pair.display });
    check(gridIsFull(pair), 'as a grid that fills the block, exactly like two photos', pair.tiles);
    const clipTile = pair.tiles[1];
    check(clipTile.vid === true && Math.abs(clipTile.w - clipTile.h) <= 1,
      'the clip is a square tile like its neighbour (its own 1280×720 shape is ignored, as a photo\'s is)',
      { w: clipTile.w, h: clipTile.h, vid: clipTile.vid });
    check(clipTile.vidFit === 'cover' && Math.abs(clipTile.vidW - clipTile.w) <= 1 && Math.abs(clipTile.vidH - clipTile.h) <= 1,
      'and the player fills it — the contact-sheet crop while it is a still',
      { fit: clipTile.vidFit, vid: clipTile.vidW + '×' + clipTile.vidH, tile: clipTile.w + '×' + clipTile.h });
    check(clipTile.controls === false && pair.tiles[0].controls === null,
      'the tile carries no native controls (it is the viewer\'s door) and the photo beside it has no player at all',
      { clip: clipTile.controls, photo: pair.tiles[0].controls });
    check(clipTile.badgeContent === '""' && clipTile.badgeDisplay !== 'none' && clipTile.badgeW === '14px'
      && pair.tiles[0].badgeContent === 'none',
      'the tile says it is a clip (veil + play triangle) and the photo beside it does not',
      { clip: clipTile.badgeContent + '/' + clipTile.badgeDisplay + '/' + clipTile.badgeW, photo: pair.tiles[0].badgeContent });
    check(!clipTile.wrapCls.includes('vid-playing'), 'nothing is playing yet', clipTile.wrapCls);
    // The tile is a door now, so this state is driven programmatically — the rule
    // itself is still the one that matters: a clip that IS playing is never shown
    // as a crop.
    check((await evaluate(`window.__play(${IX.withClip}, 1)`)) === true, 'pressing play on the clip');
    const played = (await evaluate(`window.__grid(${IX.withClip})`)).tiles[1];
    check(played.wrapCls.includes('vid-playing') && played.vidFit === 'contain',
      'shows its WHOLE frame inside the tile (contain, never a crop of a video you are watching)',
      { cls: played.wrapCls, fit: played.vidFit });
    check(played.badgeDisplay === 'none', 'with the veil and the badge gone', played.badgeDisplay);
    check(Math.abs(played.w - clipTile.w) <= 1 && Math.abs(played.h - clipTile.h) <= 1,
      'and the tile itself never changed shape — the grid cannot reflow under a reader who just pressed play',
      { before: clipTile.w + '×' + clipTile.h, after: played.w + '×' + played.h });
    check(gridIsFull(await evaluate(`window.__grid(${IX.withClip})`)), 'so the block is still full while a clip plays', null);

    console.log('\n[3b] a whole mixed batch, tall tile and all');
    const mixed = grids[IX.mixed5];
    check(mixed.cls === 'msg-atts gallery g5' && mixed.display === 'grid' && mixed.tiles.length === 5,
      'three photos + two clips are g5, the same class five photos would take', mixed.cls);
    check(gridIsFull(mixed), 'and the same arrangement — including the tall first tile', mixed.tiles);
    check(mixed.tiles[0].row === 'span 2' && Math.abs(mixed.tiles[0].h - (2 * mixed.tiles[0].w + GAP)) <= 1.5,
      'the tall tile is the first attachment, whatever kind it is', { row: mixed.tiles[0].row, h: mixed.tiles[0].h });
    check(mixed.tiles.filter((t) => t.vid).length === 2
      && mixed.tiles.filter((t) => t.vid).every((t) => t.vidFit === 'cover' && t.badgeContent === '""'
        && Math.abs(t.w - t.h) <= 1 && Math.abs(t.vidH - t.h) <= 1),
      'and both clips are square, filled, marked tiles like the photos', mixed.tiles.map((t) => (t.vid ? 'clip' : 'photo') + ' ' + t.w + '×' + t.h));
    const clipsOnly = grids[IX.clips5];
    check(clipsOnly.cls === 'msg-atts gallery g5' && gridIsFull(clipsOnly)
      && clipsOnly.tiles.every((t) => t.vid && t.vidFit === 'cover'),
      'five clips alone take the identical arrangement (the collage does not care which media it holds)', clipsOnly.cls);

    console.log('\n[3c] the state a tile can be in');
    const infectedCard = grids[IX.infected].tiles[2];
    check(grids[IX.infected].cls === 'msg-atts gallery g3' && infectedCard.cls === 'scan-block',
      'a photo the scanner removed is the warning card, IN the grid', { cls: grids[IX.infected].cls, tile: infectedCard.cls });
    check(Math.abs(infectedCard.w - grids[IX.infected].tiles[1].w) <= 1 && Math.abs(infectedCard.h - grids[IX.infected].tiles[1].h) <= 1,
      'and it is a tile like any other (the card IS the grid item, not a slot child)',
      { card: infectedCard.w + '×' + infectedCard.h, square: grids[IX.infected].tiles[1].w + '×' + grids[IX.infected].tiles[1].h });

    console.log('\n[4] a verdict landing must not break the tile');
    await evaluate(`window.__repatch(${IX.photo2})`);
    const after = await evaluate(`window.__grid(${IX.photo2})`);
    check(gridIsFull(after), 'the grid is still full after one attachment is rebuilt in place', after.tiles);
    const t1 = after.tiles[0];
    check(Math.abs(t1.w - t1.h) <= 1 && t1.fit === 'cover',
      'and the rebuilt tile is still the same square, with its photo still cropped to it',
      { w: t1.w, h: t1.h, fit: t1.fit });
    // The same patch landing on a CLIP: the replacement must still be a tile (no
    // controls, the square crop), not a full player dropped into a 120px cell.
    await evaluate(`window.__repatchVid(${IX.withClip}, 1)`);
    const afterVid = await evaluate(`window.__grid(${IX.withClip})`);
    const rv = afterVid.tiles[1];
    check(rv.vid === true && rv.controls === false && rv.vidFit === 'cover' && Math.abs(rv.w - rv.h) <= 1,
      'and a republished clip comes back as a tile, never as a control strip in a square',
      { controls: rv.controls, fit: rv.vidFit, tile: rv.w + '×' + rv.h });
    check(gridIsFull(afterVid), 'with the block still full after the clip was replaced', afterVid.tiles);

    console.log('\n[5] a phone: the same arrangement, scaled to the column');
    await sess('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await sess('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
    await sleep(500);
    for (const n of [3, 5, 6, 10]) {
      const g = await evaluate(`window.__grid(${IX['photo' + n]})`);
      check(g.cls === 'msg-atts gallery g' + n && Math.abs(g.w - g.bodyW) <= 1,
        `${n} photos take the whole column on a phone (${g.w}px of ${g.bodyW}px), still a gallery`, g.cls);
      check(g.w < 420, 'which is narrower than the 420px cap the desktop block uses', g.w);
      check(gridIsFull(g), `and the grid is full there too, at ${n}`, g.tiles);
      check(g.tiles.every((t) => t.row === 'span 2' || Math.abs(t.w - t.h) <= 1 || t.w > t.h),
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
