// The shape of a picture, before its bytes (see AGENTS.md → media attachments).
//
// The complaint: "media attachments when loading just kind of uncollapse and
// appear." An <img> with no intrinsic size renders at zero height, so a chat row
// collapses to nothing and then shoves everything below it as the picture lands
// — and every list rebuild does it again. A picture now carries the size the
// server measured (image-size.js at upload, att-dims.js for everything that
// predates the record) as width/height attributes, the browser reserves exactly
// the box it will occupy, and a placeholder holds it until the bytes paint.
//
// Three halves:
//   [1] the header parser, offline and pure — including the formats it must
//       REFUSE, because a wrong shape is worse than no shape;
//   [2] the wiring: the guarded columns, the bounded leader-locked backfill, the
//       upload route that measures, the ingest that clamps, and the client
//       markup that reserves the box;
//   [3] headless Chrome against the real markup, stylesheet and REAL generated
//       PNGs of known size: the reserved box must equal the box the loaded
//       picture takes, at every shape and against both caps. Skips without
//       Chrome.
//
// Usage: node scripts/test-att-shape.js
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');

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
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

const db = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const attDims = fs.readFileSync(path.join(ROOT, 'att-dims.js'), 'utf8');
const messages = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
const pins = fs.readFileSync(path.join(ROOT, 'public/js/pins.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const { dimsFromBuffer, dimsFromFile } = require(path.join(ROOT, 'image-size.js'));

// ---------- real PNGs, generated (no fixtures, no ffmpeg) ----------
function pngBytes(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h); // filter byte 0 + RGB, all black
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- crafted headers for the formats a generator can't reach ----------
const hdr = {
  gif: (w, h) => { const b = Buffer.alloc(13); b.write('GIF89a', 0, 'latin1'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b; },
  bmp: (w, h) => { const b = Buffer.alloc(30); b.write('BM', 0, 'latin1'); b.writeInt32LE(w, 18); b.writeInt32LE(h, 22); return b; },
  jpeg: (w, h) => {
    const app0 = Buffer.alloc(18); app0.writeUInt16BE(0xffe0, 0); app0.writeUInt16BE(16, 2);
    const sof = Buffer.alloc(19); sof.writeUInt16BE(0xffc0, 0); sof.writeUInt16BE(17, 2);
    sof.writeUInt8(8, 4); sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
  },
  webpVp8x: (w, h) => { const b = Buffer.alloc(30); b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1'); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b; },
  webpVp8l: (w, h) => {
    const b = Buffer.alloc(30); b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8L', 12, 'latin1'); b.writeUInt8(0x2f, 20);
    b.writeUInt32LE((((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)) >>> 0, 21); return b;
  },
  webpVp8: (w, h) => {
    const b = Buffer.alloc(32); b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8 ', 12, 'latin1');
    b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a; b.writeUInt16LE(w & 0x3fff, 26); b.writeUInt16LE(h & 0x3fff, 28); return b;
  },
};

// ---------- the browser page ----------
const MARK_START = messages.indexOf('const DL_ICON =');
const MARK_END = messages.indexOf('// ---------- video posters:');
const markSource = messages.slice(MARK_START, MARK_END);

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<style>${css}</style>
<style>html,body{margin:0;background:#0e1420;overflow-x:hidden}
/* The real message chain: a .text column of definite width, so max-width:100%
   on a picture resolves the way it does in a real channel. Transitions are off
   so the computed opacities report the CASCADE (which is what is under test)
   rather than wherever an animation clock happens to be. */
#host{width:420px;padding:10px}
#host *{transition:none!important}</style>
</head><body><div id="host"><div class="msg"><div class="body"><div class="text" id="text"></div></div></div></div><script>
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtSize() { return '1 KB'; }
function toast() {}
function audioPlayerHTML() { return ''; }
function textPreviewable() { return false; }
function textFileHTML() { return ''; }
${markSource}
const text = document.getElementById('text');
// Tenths, not whole pixels: a thin panorama box is 47.6px tall, and rounding it
// to 48 would read as an 8% ratio error that isn't there.
const rect = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; };
// The real renderer + the real wiring, exactly as messageEl does it.
function mk(att) {
  const box = document.createElement('div');
  box.className = 'msg-atts';
  box.innerHTML = attachmentHTML(att);
  text.appendChild(box);
  const wrap = box.firstElementChild;
  if (typeof wireAttImage === 'function') wireAttImage(wrap.querySelector('img.att-img'));
  return wrap;
}
function whenLoaded(img) {
  return new Promise((res) => {
    if (img.complete && img.naturalWidth > 0) return res(true);
    img.addEventListener('load', () => res(true), { once: true });
    img.addEventListener('error', () => res(false), { once: true });
  });
}
(async () => {
 try {
  const out = { rows: [], noar: null, warm: null };
  const CASES = [
    ['landscape', 1920, 1080], ['portrait', 1080, 1920], ['small', 200, 150],
    ['square', 600, 600], ['pano', 4000, 500],
  ];
  const wraps = [];
  for (const [name, w, h] of CASES) {
    const wrap = mk({ kind: 'image', url: '/uploads/files/' + name + '.png?v=1', name: name + '.png', w, h });
    wraps.push(wrap);
    // Read SYNCHRONOUSLY: the bytes cannot have landed yet, so this is the
    // reserved box, before any load event could fire.
    out.rows.push({ name, w, h, reserved: rect(wrap), ph: rect(wrap.querySelector('.att-ph')), cls: wrap.className, ready: wrap.classList.contains('ready') });
    const cs = getComputedStyle(wrap);
    const ics = getComputedStyle(wrap.querySelector('img.att-img'));
    out.rows[out.rows.length - 1].diag = { style: wrap.getAttribute('style'), varAr: cs.getPropertyValue('--att-ar'), aspect: cs.aspectRatio, w: cs.width, h: cs.height, display: cs.display, minH: cs.minHeight, img: rect(wrap.querySelector('img.att-img')), iw: ics.width, ih: ics.height, iar: ics.aspectRatio, iaspect: ics.getPropertyValue('aspect-ratio') };
  }
  for (let i = 0; i < wraps.length; i++) {
    const img = wraps[i].querySelector('img.att-img');
    const ok = await whenLoaded(img);
    out.rows[i].loaded = ok && img.naturalWidth > 0;
  }
  // Let the hand-over transition finish before reading opacities.
  await new Promise((r) => setTimeout(r, 600));
  for (let i = 0; i < wraps.length; i++) {
    const wrap = wraps[i], img = wrap.querySelector('img.att-img');
    out.rows[i].final = rect(wrap);
    out.rows[i].ready = wrap.classList.contains('ready');
    out.rows[i].phOpacity = getComputedStyle(wrap.querySelector('.att-ph')).opacity;
    out.rows[i].imgOpacity = getComputedStyle(img).opacity;
    out.rows[i].natural = img.naturalWidth + 'x' + img.naturalHeight;
  }
  // Nothing knows this shape: a small neutral placeholder, then the real size.
  const noar = mk({ kind: 'image', url: '/uploads/files/noar.png?v=1', name: 'noar.png' });
  out.noar = { reserved: rect(noar), cls: noar.className, ph: rect(noar.querySelector('.att-ph')) };
  await whenLoaded(noar.querySelector('img.att-img'));
  out.noar.final = rect(noar);
  out.noar.ready = noar.classList.contains('ready');
  out.noar.phDisplay = getComputedStyle(noar.querySelector('.att-ph')).display;

  // A second render of an already-cached picture: the placeholder must clear.
  const warm = mk({ kind: 'image', url: '/uploads/files/landscape.png?v=1', name: 'landscape.png', w: 1920, h: 1080 });
  await whenLoaded(warm.querySelector('img.att-img'));
  out.warm = { ready: warm.classList.contains('ready'), final: rect(warm), phOpacity: getComputedStyle(warm.querySelector('.att-ph')).opacity };

  // The spoiler path keeps its blur and its veil on top of the same machinery.
  const sp = mk({ kind: 'image', url: '/uploads/files/landscape.png?v=1', name: 'landscape.png', w: 1920, h: 1080, spoiler: true });
  await whenLoaded(sp.querySelector('img.att-img'));
  out.spoiler = { ready: sp.classList.contains('ready'), veil: !!sp.querySelector('.spoiler-veil'), blur: getComputedStyle(sp.querySelector('img')).filter };
  document.title = JSON.stringify(out);
 } catch (e) { document.title = 'ERR ' + String((e && e.stack) || e); }
})();
</script></body></html>`;
}

function runChrome(chrome, html, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-shape-'));
  return new Promise((resolve) => {
    const finish = (val) => { try { srv.close(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} resolve(val); };
    const srv = http.createServer((req, res) => {
      const url = (req.url || '/').split('?')[0];
      if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      const buf = files[url];
      if (!buf) { res.writeHead(404); return res.end('nope'); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length });
      res.end(buf);
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      // spawn, not spawnSync: the server answering these pictures lives in THIS
      // process, and a synchronous wait would block the event loop and deadlock
      // the page against its own images.
      const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
        '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=460,1400',
        '--virtual-time-budget=20000', '--dump-dom', 'http://127.0.0.1:' + port + '/'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, 90000);
      child.on('error', (e) => { clearTimeout(timer); finish({ err: 'chrome: ' + e.message }); });
      child.on('close', (status) => {
        clearTimeout(timer);
        const m = /<title>([\s\S]*?)<\/title>/.exec(out);
        if (!m) return finish({ err: 'no title, status ' + status });
        try { finish(JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))); }
        catch { finish({ err: 'bad title: ' + String(m[1]).slice(0, 200) }); }
      });
    });
  });
}

async function main() {
  console.log('\n[1] the size comes out of the file\'s own header');
  check(JSON.stringify(dimsFromBuffer(pngBytes(800, 600))) === '{"w":800,"h":600}', 'a real PNG parses');
  check(JSON.stringify(dimsFromBuffer(hdr.jpeg(1920, 1080))) === '{"w":1920,"h":1080}', 'JPEG walks to the SOF marker');
  check(JSON.stringify(dimsFromBuffer(hdr.gif(320, 240))) === '{"w":320,"h":240}', 'GIF reads its screen descriptor');
  check(JSON.stringify(dimsFromBuffer(hdr.bmp(640, 480))) === '{"w":640,"h":480}', 'BMP reads its info header');
  check(JSON.stringify(dimsFromBuffer(hdr.bmp(640, -480))) === '{"w":640,"h":480}', 'and a top-down (negative height) BMP');
  check(JSON.stringify(dimsFromBuffer(hdr.webpVp8x(1000, 500))) === '{"w":1000,"h":500}', 'WebP reads the VP8X canvas');
  check(JSON.stringify(dimsFromBuffer(hdr.webpVp8l(300, 200))) === '{"w":300,"h":200}', 'and the VP8L bitstream');
  check(JSON.stringify(dimsFromBuffer(hdr.webpVp8(640, 360))) === '{"w":640,"h":360}', 'and the lossy VP8 frame header');
  const real = await dimsFromFile(fs, path.join(ROOT, 'public/icons/icon-192.png'));
  check(real && real.w === 192 && real.h === 192, 'a committed PNG on disk parses through dimsFromFile', real);
  // Refusals matter more than hits: a wrong shape makes the layout jump worse,
  // so anything unreadable must answer null and reserve nothing.
  check(dimsFromBuffer(hdr.jpeg(1920, 1080).subarray(0, 6)) === null, 'a truncated JPEG answers null');
  check(dimsFromBuffer(pngBytes(64, 64).subarray(0, 12)) === null, 'a truncated PNG answers null');
  check(dimsFromBuffer(Buffer.from('this is not an image at all')) === null, 'so does a non-image');
  check(dimsFromBuffer(Buffer.alloc(0)) === null, 'and an empty head');
  check(dimsFromBuffer(hdr.bmp(99999, 10)) === null, 'a size past any real picture is refused, not clamped');
  check(dimsFromBuffer(hdr.gif(0, 0)) === null, 'so is a zero dimension');
  check(dimsFromBuffer(Buffer.concat([Buffer.from('0000ftypavif'), Buffer.alloc(64)])) === null, 'AVIF is left alone (no reservation beats a guess)');

  console.log('\n[2] the record, and the worker that fills it in');
  check(/await addColumn\('attachments', 'w', 'BIGINT'\)/.test(db) && /await addColumn\('attachments', 'h', 'BIGINT'\)/.test(db), 'attachments carries a guarded w/h');
  check(/await addColumn\('dm_attachments', 'w', 'BIGINT'\)/.test(db) && /await addColumn\('dm_attachments', 'h', 'BIGINT'\)/.test(db), 'and so does dm_attachments');
  check(/CREATE INDEX IF NOT EXISTS idx_attachments_unmeasured[\s\S]{0,120}WHERE w IS NULL/.test(db), 'a partial index keeps the backfill a lookup');
  check(/attDims: 771015/.test(db), 'the backfill has its own advisory-lock key');
  check(/if \(row\.kind !== 'image'\) \{ await mark\(table, row\.id, null\); done\+\+; continue; \}/.test(attDims), 'a non-image is marked "nothing to reserve" without a read');
  check(/ORDER BY created_at DESC LIMIT \?/.test(attDims), 'the backfill works newest-first');
  check(/bytes=0-' \+ \(HEAD_BYTES - 1\)/.test(attDims), 'an S3 read is a ranged GET of just the head');
  check(/await db\.withLock\(db\.LOCKS\.attDims, \(\) => runOnce\(\)\)/.test(attDims), 'and only one replica runs it');
  check(/warn\('could not measure /.test(attDims), 'one unreadable object never stops the run');
  check(/require\('\.\/att-dims'\)\.startAttDims\(\)/.test(server), 'the worker starts at boot');

  console.log('\n[3] measuring at upload, storing, and handing it back');
  check(/const imageSize = require\('\.\/image-size'\)/.test(server), 'the server owns the header parser');
  check(/async function uploadDims\(file, kind\)/.test(server) && /\.\.\.\(await uploadDims\(req\.file, kind\)\)/.test(server),
    'the upload route measures the file it just stored and answers with its shape');
  check(/dimsFromBuffer\(file\.buffer\)/.test(server) && /dimsFromFile\(fs, file\.path\)/.test(server),
    'from the buffered bytes in S3 mode, from the file on disk otherwise');
  check(/const ATT_DIM_MAX = 20000;/.test(server) && /w <= ATT_DIM_MAX && h <= ATT_DIM_MAX/.test(server),
    'client-supplied sizes are clamped, and a silly pair stores 0/0');
  check(/\.\.\.cleanAttDims\(a\)/.test(server), 'the ingest carries the pair through');
  for (const table of ['attachments', 'dm_attachments']) {
    const all = [...server.matchAll(new RegExp(`INSERT INTO ${table} \\(([^)]*)\\) VALUES \\(([^)]*)\\)`, 'g'))]
      .map((m) => ({ cols: m[1].split(',').map((s) => s.trim()), vals: m[2].split(',').map((s) => s.trim()) }));
    check(all.length > 0 && all.every((x) => x.vals.length === x.cols.length && x.vals.every((v) => v === '?')),
      `every ${table} insert keeps its columns and placeholders in step`, all.map((x) => x.cols.length + '/' + x.vals.length));
  }
  check((server.match(/INSERT INTO attachments \([^)]*w,h,gif_slug,gif_thumb,gif_mp4,created_at\)/g) || []).length === 1
    && (server.match(/INSERT INTO dm_attachments \([^)]*w,h,gif_slug,gif_thumb,gif_mp4,created_at\)/g) || []).length === 1,
    'the channel and DM message inserts write the measured pair');
  check((server.match(/a\.spoiler \|\| 0, a\.w \|\| 0, a\.h \|\| 0, a\.gif_slug \|\| null, a\.gif_thumb \|\| null, a\.gif_mp4 \|\| null, now\(\)/g) || []).length === 2,
    'and bind it for both');
  // One shared wire shape (attWire) feeds both hydrations, so the pair can only
  // be handed to the client in one place — and the GIF identity with it.
  check((server.match(/w: Number\(a\.w\) \|\| 0, h: Number\(a\.h\) \|\| 0/g) || []).length === 1
    && /function attWire\(a, scan\)/.test(server) && (server.match(/attWire\(a, \(sk && scanMap\.get\(sk\)\) \|\| 'clean'\)/g) || []).length === 2,
    'both message payloads hand the pair to the client');

  console.log('\n[4] the client reserves the box');
  check(/const d = attDimsFor\(a\);/.test(markSource) && /width:min\(\$\{d\.w\}px,100%,420px,calc\(var\(--att-max-h,320px\) \* \$\{r\}\)\)/.test(markSource),
    'a known shape reserves the box on the wrap, from the size and the caps');
  check(/width="\$\{d\.w\}" height="\$\{d\.h\}"/.test(markSource), 'and rides on the picture as its intrinsic size');
  check(/class="att-ph" aria-hidden="true"/.test(markSource), 'with a placeholder to hold the box until it paints');
  check(/\$\{d \? ' ar' : ' no-ar'\}/.test(markSource), 'a picture with no known shape is marked as such');
  check(/function wireAttImage\(img\)/.test(markSource) && /if \(img\.complete && img\.naturalWidth > 0\)/.test(markSource),
    'the wiring marks it ready on load — including an already-complete cached image');
  check(/if \(wrap\) wrap\.classList\.add\('pending'\);/.test(markSource), 'and it is the wiring that SHOWS the placeholder (.pending)');
  check(/attDimsSeen\.set\(attCleanUrl\(url\), \{ w, h \}\)/.test(markSource), 'and learns the shape of anything the record did not have');
  check(/div\.querySelectorAll\('img\.att-img'\)\.forEach\(\(img\) => \{ observeStick\(img\); wireAttImage\(img\); \}\)/.test(messages),
    'messageEl wires it for every rendered picture');
  check(/attsEl\.querySelectorAll\('img\.att-img'\)\.forEach\(wireAttImage\)/.test(pins),
    'and so does the pinned-message list — an unwired surface would park the picture invisible');
  check(/\.att-wrap\.ar\{aspect-ratio:var\(--att-ar\)\}/.test(css), 'the wrap takes its height from the ratio');
  check(/\.att-wrap\{[^}]*--att-max-h:320px\}/.test(css) && /\.pin-atts \.att-wrap\{--att-max-h:200px\}/.test(css),
    'and the height cap it is computed against follows the surface');
  check(/\.att-wrap \.att-ph\{display:none;position:absolute[^}]*pointer-events:none/.test(css) && /\.att-wrap\.pending \.att-ph\{display:flex\}/.test(css),
    'the placeholder is hidden until the wiring shows it, and eats no taps');
  check(/\.att-wrap\.pending\.ready \.att-ph\{opacity:0\}/.test(css) && /\.att-wrap\.pending:not\(\.ready\) img\.att-img\{opacity:0/.test(css),
    'and hands the box over once the picture paints');
  check(/\.att-wrap\.no-ar\.pending \.att-ph\{position:static;width:min\(200px,55vw\);aspect-ratio:4\/3/.test(css), 'an unmeasured picture gets a small neutral box instead of a guess');
  check(/\.att-wrap:has\(\.file-card\) \.att-ph\{display:none\}/.test(css), 'a picture that degrades to a file card drops the placeholder');
  check(/prefers-reduced-motion:reduce\)\{[\s\S]{0,600}?\.att-wrap \.att-ph,\.att-wrap img\.att-img\{transition:none\}/.test(css), 'reduced motion keeps the hand-over, without the fade');

  const chrome = findChrome();
  if (!chrome) return skip('no Chrome/Edge found — set CHROME_PATH');

  console.log('\n[5] the reserved box IS the box the picture takes (headless Chrome, real PNGs)');
  const files = {};
  const CASES = [['landscape', 1920, 1080], ['portrait', 1080, 1920], ['small', 200, 150], ['square', 600, 600], ['pano', 4000, 500], ['noar', 640, 360]];
  for (const [name, w, h] of CASES) {
    const bytes = pngBytes(w, h);
    // Both halves, exactly as a real upload serves them: the chat asks for the
    // derived preview, the original is what it falls back to.
    files['/uploads/files/' + name + '.png'] = bytes;
    files['/uploads/thumbs/files/' + name + '.png.webp'] = bytes;
  }
  const out = await runChrome(chrome, pageHtml(), files);
  if (out.err) { check(false, 'the harness ran', out.err); }
  else {
    for (const row of out.rows) {
      check(row.loaded && row.natural === row.w + 'x' + row.h, `${row.name}: the real ${row.w}x${row.h} picture loaded`, row.natural);
      check(row.ready === true, `${row.name}: the placeholder stands down once it paints`);
      check(Math.abs(row.reserved.w - row.final.w) <= 1 && Math.abs(row.reserved.h - row.final.h) <= 1,
        `${row.name}: the reserved box equals the box it lands in (no uncollapse)`, { reserved: row.reserved, final: row.final });
      check(row.reserved.w <= 420 && row.reserved.h <= 320, `${row.name}: inside the 420x320 caps`, row.reserved);
      check(Math.abs((row.reserved.w / row.reserved.h) - (row.w / row.h)) < 0.05, `${row.name}: and at the picture's own ratio`, row.diag);
      check(row.phOpacity === '0' && row.imgOpacity === '1', `${row.name}: the hand-over actually happened`, { ph: row.phOpacity, img: row.imgOpacity });
    }
    const pano = out.rows.find((r) => r.name === 'pano');
    check(pano && pano.reserved.h <= 320 && pano.final.w <= 420, 'a 4000px panorama is capped, not overflowing', pano && pano.final);
    const small = out.rows.find((r) => r.name === 'small');
    check(small && small.reserved.w === 200 && small.reserved.h === 150, 'a picture under the caps is not scaled at all', small && small.reserved);

    check(out.noar && out.noar.reserved.w === 200 && out.noar.reserved.h === 150, 'an unmeasured picture still shows a placeholder box', out.noar && out.noar.reserved);
    check(out.noar && out.noar.cls.includes('no-ar') && out.noar.final.w > 300 && out.noar.final.w <= 420
      && Math.abs((out.noar.final.w / out.noar.final.h) - (640 / 360)) < 0.03,
      'then takes its real size and ratio once it lands', out.noar);
    check(out.noar && out.noar.ready === true && out.noar.phDisplay === 'none', 'and the neutral box leaves the flow (not just fades)', out.noar);
    check(out.warm && out.warm.ready === true && out.warm.phOpacity === '0', 'a warm second render clears its placeholder too', out.warm);
    check(out.spoiler && out.spoiler.ready === true && out.spoiler.veil === true && /blur/.test(out.spoiler.blur),
      'a spoilered picture keeps its veil and its blur', out.spoiler);
  }

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
}

main();
