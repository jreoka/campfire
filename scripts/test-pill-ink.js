// The reaction pill's ink: the emoji and the number beside it have to read as
// ONE line.
//
// The report: "the emoji is too far down compared to the number beside it".
// It was — MEASURED on the reporter's own screenshot, the heart's ink centre sat
// 2.4px below the digit's in a 27px pill. The cause is box geometry, not taste:
// a native emoji's inline box is ~1.3em tall and the count's window was .95em, so
// with `align-items:center` on the button the two boxes were centred at
// different points and baseline alignment did the rest. The emoji's own box is
// the one box that cannot move (it is what makes the pill 27px), so the count's
// window is matched to it.
//
// What this pins, all of it read off the PIXELS of the real stylesheet in
// headless Chrome (skips without Chrome):
//   [1] the wiring — the glyph is an element the stylesheet can shape, and the
//       count's window in the pill is the matched one;
//   [2] the alignment — emoji ink centre and digit ink centre within a pixel,
//       for a spread of emoji (a glyph's bitmap can sit low in its own em box,
//       so this is a budget, not zero: ❤️ and 💩 are the two worst offenders and
//       the fix takes them from 2.4/2.2px to 0.6/0.5px);
//   [3] the pill's SHAPE is unchanged — matching the windows must not grow it;
//   [4] the count roll — a reaction landing replaces the .rcount's content with
//       an .rc-roll window. If that window were left at .95em the digit would hop
//       ~1px exactly when somebody reacts, so the roll is measured against the
//       resting state;
//   [5] an IMAGE emoji is the exception and keeps the old window (an <img> is
//       centred by its own vertical-align, so the taller box would drag the digit
//       below it), and the me bar's own roll — which is NOT inside a .reaction —
//       is untouched.
//
// Usage: node scripts/test-pill-ink.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.env.TEST_PORT || '3455', 10) + (process.pid % 40);
const SCALE = 10;               // device scale factor for the screenshots
const ALIGN_BUDGET = 1.0;       // px between the two ink centres
const SHAPE_BUDGET = 1.0;       // px the pill's height may move
const IMAGE_BUDGET = 1.0;       // px between the two ink centres, image emoji

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const c = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return c.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

// ---------- a PNG reader, so the assertions are on pixels, not on boxes ----------
function decodePNG(buf) {
  let off = 8; const chunks = []; let ihdr = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), color: data[9] };
    if (type === 'IDAT') chunks.push(data);
    if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('not a PNG');
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const ch = ihdr.color === 6 ? 4 : ihdr.color === 2 ? 3 : 1;
  const stride = ihdr.w * ch;
  const out = Buffer.alloc(ihdr.h * stride);
  let pos = 0;
  for (let y = 0; y < ihdr.h; y++) {
    const f = raw[pos++];
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
  }
  return { ...ihdr, ch, data: out };
}

// A 16x16 PNG for the custom-emoji case, so it cannot be a broken image.
function pinkPng() {
  const w = 16, h = 16, raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = 230; raw[o + 1] = 60; raw[o + 2] = 120; raw[o + 3] = 255; }
  }
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- the wiring, offline ----------
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const messages = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');

console.log('\n[1] the wiring');
check(/<span class="rx-e">\$\{label\}<\/span> <span class="rcount">/.test(messages),
  'the glyph is its own element inside the pill, before the count');
check(/\.reaction \.rx-e\{line-height:1\.3\}/.test(css), 'the glyph wears the pill\'s own line box (1.3em)');
check(/\.reaction \.rcount,\.reaction \.rc-roll\{height:1\.3em;line-height:1\.3em\}/.test(css),
  'the count window is matched to it — and the roll window with it');
check(/\.reaction \.rc-roll>span\{line-height:1\.3em\}/.test(css), 'the rolling copies inherit the window');
check(/\.reaction:has\(img\.cemoi\) \.rcount\{height:\.95em;line-height:\.95em\}/.test(css),
  'an image emoji keeps the digit-sized window');
check(/\.reaction:has\(img\.cemoi\) \.rx-e\{line-height:normal\}/.test(css),
  'and does not inherit the glyph\'s taller line box either');
check(/^\.rcount\{display:inline-block;height:\.95em;line-height:\.95em;vertical-align:baseline\}$/m.test(css),
  'the unscoped .rcount default (the me bar\'s) is still the .95em window');
check(!/\.rcount/.test(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')),
  'nothing in the shell markup carries .rcount, so the default has no other callers');

const chromePath = findChrome();
if (!chromePath) skip('no Chrome/Edge found (set CHROME_PATH)');

// ---------- headless Chrome ----------
async function main() {
  const WebSocket = globalThis.WebSocket;
  if (!WebSocket) skip('this node has no global WebSocket (needs node >= 22)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-pill-ink-'));
  fs.writeFileSync(path.join(tmp, 'e.png'), pinkPng());
  fs.writeFileSync(path.join(tmp, 'p.html'), `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
<body style="background:#0b0f1a;margin:0">
  <div id="host" style="padding:30px"></div>
  <div id="user-footer"><div id="me-card"><div id="me-sub">Playing a game</div></div></div>
  <script>
    window.build = function (h) { document.getElementById('host').innerHTML = h; };
    window.buildSub = function (h) { document.getElementById('me-sub').innerHTML = h; };
  </script>
</body></html>`);

  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(tmp, 'chrome')}`, '--no-first-run', '--disable-gpu',
    '--hide-scrollbars', '--window-size=460,320',
    'file:///' + path.join(tmp, 'p.html').replace(/\\/g, '/')]);
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch {}
  }
  if (!target) { try { chrome.kill(); } catch {} skip('headless Chrome never came up'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params) => new Promise((res) => {
    const i = ++id; pend.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evalJS = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  };
  const shot = async () => decodePNG(Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 460, height: 320, deviceScaleFactor: SCALE, mobile: false });
  await sleep(600);

  const pxOf = (img) => (x, y) => { const i = (y * img.w + x) * img.ch; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };

  // Ink bounds inside a horizontal band, against the pill's own fill colour.
  const inkIn = (img, band, geo) => {
    const px = pxOf(img);
    const Y0 = Math.round(geo.y * SCALE), Y1 = Math.round((geo.y + geo.h) * SCALE);
    const X0 = Math.round(band[0] * SCALE), X1 = Math.round(band[1] * SCALE);
    const hist = new Map();
    for (let y = Y0 + 3; y < Y1 - 3; y++) for (let x = X0; x < X1; x++) {
      const k = px(x, y).join(','); hist.set(k, (hist.get(k) || 0) + 1);
    }
    const fill = [...hist.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
    const base = Math.max(...fill);
    const isInk = (p) => Math.max(...p) - base > 55 || (p[0] - p[2] > 35 && p[0] > 110);
    let t = 1e9, b = -1, l = 1e9, r = -1;
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
      if (isInk(px(x, y))) { if (y < t) t = y; if (y > b) b = y; if (x < l) l = x; if (x > r) r = x; }
    }
    if (t === 1e9) return null;
    return {
      cy: ((t + b) / 2 - Y0) / SCALE, top: (t - Y0) / SCALE, bot: (b - Y0) / SCALE,
      h: (b - t + 1) / SCALE, left: (l - X0) / SCALE, right: (r - X0) / SCALE,
    };
  };

  // The pill's real box, measured off its fill colour (the button rect includes
  // the inline boxes that overflow it).
  const pillBox = (img, geo) => {
    const px = pxOf(img);
    const X0 = Math.round(geo.x * SCALE) - 4, X1 = Math.round((geo.x + geo.w) * SCALE) + 4;
    const Y0 = Math.round(geo.y * SCALE) - 4, Y1 = Math.round((geo.y + geo.h) * SCALE) + 4;
    const hist = new Map();
    for (let y = Y0; y < Y1; y++) for (let x = Math.round(geo.x * SCALE) + 4; x < Math.round((geo.x + geo.w) * SCALE) - 4; x++) {
      const k = px(x, y).join(','); hist.set(k, (hist.get(k) || 0) + 1);
    }
    const fill = [...hist.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
    let t = 1e9, b = -1, l = 1e9, r = -1;
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
      const p = px(x, y);
      if (Math.abs(p[0] - fill[0]) < 20 && Math.abs(p[1] - fill[1]) < 20 && Math.abs(p[2] - fill[2]) < 24) {
        if (y < t) t = y; if (y > b) b = y; if (x < l) l = x; if (x > r) r = x;
      }
    }
    return { top: t / SCALE, height: (b - t + 1) / SCALE, width: (r - l + 1) / SCALE, fill };
  };

  // Build one pill and read both inks out of the pixels.
  const measurePill = async (glyphInner, count, emojiKey) => {
    await evalJS(`(async () => {
      window.build('<div class="reactions"><button class="reaction me" data-emoji="${emojiKey}"><span class="rx-e">${glyphInner}</span> <span class="rcount">${count}</span></button></div>');
      const img = document.querySelector('img.cemoi');
      if (img) await img.decode();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    })()`);
    const geo = await evalJS(`(() => {
      const b = document.querySelector('.reaction').getBoundingClientRect();
      const el = document.querySelector('.rx-e');
      const img = document.querySelector('img.cemoi');
      const c = document.querySelector('.rcount');
      const cr = c.getBoundingClientRect();
      const gr = (img || el).getBoundingClientRect();
      return { g: { x: b.x, y: b.y, w: b.width, h: b.height }, eLeft: gr.left, eRight: gr.right, nLeft: cr.left, nRight: cr.right };
    })()`);
    const img = await shot();
    const gap = (geo.eRight + geo.nLeft) / 2;
    const emoji = inkIn(img, [geo.eLeft - 2, gap], geo.g);
    const digit = inkIn(img, [gap, geo.nRight + 2], geo.g);
    const pill = pillBox(img, geo.g);
    return { emoji, digit, pill };
  };

  console.log('\n[2] the emoji and the number share one centre (headless Chrome, real stylesheet)');
  const GLYPHS = [
    ['❤️', 'heart'], ['👍', 'thumbs'], ['🔥', 'fire'], ['😀', 'grin'],
    ['🎉', 'party'], ['😢', 'cry'], ['💩', 'poop'], ['❤', 'heart-text'],
  ];
  let worst = { name: null, delta: 0 };
  let baseHeight = null;
  for (const [glyph, name] of GLYPHS) {
    const r = await measurePill(glyph, '2', glyph);
    if (!r.emoji || !r.digit) { check(false, `${name}: both parts have ink`); continue; }
    const delta = r.emoji.cy - r.digit.cy;
    if (Math.abs(delta) > Math.abs(worst.delta)) worst = { name, delta };
    if (baseHeight === null) baseHeight = r.pill.height;
    check(Math.abs(delta) <= ALIGN_BUDGET,
      `${name}: emoji ink is on the digit's centre line`,
      { delta: +delta.toFixed(2), emojiCy: +r.emoji.cy.toFixed(2), digitCy: +r.digit.cy.toFixed(2) });
    check(Math.abs(r.pill.height - baseHeight) <= SHAPE_BUDGET,
      `${name}: the pill's height is unchanged`,
      { height: +r.pill.height.toFixed(2), base: +baseHeight.toFixed(2) });
  }
  console.log(`  note  worst pair: ${worst.name} at ${worst.delta.toFixed(2)}px (was 1.1–2.4px before the fix)`);

  console.log('\n[3] the digit does not hop when the count rolls');
  {
    const resting = await measurePill('👍', '2', '👍');
    // exactly what rollValue builds: the .rcount's content becomes an .rc-roll
    await evalJS(`(() => {
      const el = document.querySelector('.rcount');
      el.innerHTML = '<span class="rc-roll"><span class="rc-old">2</span><span class="rc-new">3</span></span>';
      for (const s of el.querySelectorAll('.rc-roll, .rc-roll > span')) s.style.animationPlayState = 'paused';
      return true;
    })()`);
    await evalJS(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    const geo = await evalJS(`(() => {
      const b = document.querySelector('.reaction').getBoundingClientRect();
      const w = document.querySelector('.rc-roll').getBoundingClientRect();
      return { g: { x: b.x, y: b.y, w: b.width, h: b.height }, w: { left: w.left, right: w.right, height: w.height } };
    })()`);
    const img = await shot();
    const digit = inkIn(img, [geo.w.left - 2, geo.w.right + 2], geo.g);
    check(!!digit, 'the rolled digit has ink');
    if (digit) {
      check(Math.abs(digit.cy - resting.digit.cy) <= 0.5,
        'the digit sits on the same line mid-roll as at rest',
        { rolling: +digit.cy.toFixed(2), resting: +resting.digit.cy.toFixed(2) });
    }
    check(Math.abs(geo.w.height - resting.pill.height) < 12 && geo.w.height > 10,
      'the roll window is a one-digit window, not a line box',
      { roll: +geo.w.height.toFixed(2), pill: +resting.pill.height.toFixed(2) });
  }

  console.log('\n[4] an image emoji keeps the digit-sized window');
  {
    await evalJS(`window.build('<div class="reactions"><button class="reaction me" data-emoji=":p:"><span class="rx-e"><img class="cemoi" src="e.png" alt=":p:" data-fb-emoji=":p:"></span> <span class="rcount">3</span></button></div>')`);
    const geo = await evalJS(`(() => {
      const el = document.querySelector('.rcount');
      const w = document.querySelector('.rx-e img').getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { imgH: w.height, height: cs.height, lineHeight: cs.lineHeight, fontSize: cs.fontSize };
    })()`);
    const ratio = parseFloat(geo.height) / parseFloat(geo.fontSize);
    check(Math.abs(ratio - 0.95) < 0.02, 'the count window is .95em for an image emoji', { ratio: +ratio.toFixed(3), ...geo });
  }

  console.log('\n[5] the me bar\'s own roll is untouched');
  {
    const rest = await evalJS(`(() => {
      window.buildSub('Playing a game');
      const sub = document.getElementById('me-sub');
      const cs = getComputedStyle(sub);
      return { h: sub.getBoundingClientRect().height, lh: cs.lineHeight, fs: cs.fontSize };
    })()`);
    await evalJS(`(async () => {
      window.buildSub('<span class="rc-roll wide"><span class="rc-old">Playing a game</span><span class="rc-new">Somebody</span></span>');
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    })()`);
    const rolling = await evalJS(`(() => {
      const sub = document.getElementById('me-sub');
      const w = sub.querySelector('.rc-roll');
      return { subH: sub.getBoundingClientRect().height, rollH: w.getBoundingClientRect().height, fs: getComputedStyle(sub).fontSize };
    })()`);
    check(Math.abs(rolling.subH - rest.h) < 0.5, 'the sub-line does not change height mid-roll', { rest: rest.h, rolling: rolling.subH });
    const wideRatio = rolling.rollH / parseFloat(rolling.fs);
    check(Math.abs(wideRatio - 1.35) < 0.02, 'the wide roll window is still 1.35em', { ratio: +wideRatio.toFixed(3) });
  }

  try { chrome.kill(); } catch {}
  await sleep(200);

  console.log('\n' + (failures.length ? 'FAILED ' + failures.length + ' of ' + (passed + failures.length)
    : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
