// The marks on a DM row must stay legible over the person's banner.
//
// The complaint: "when a dm is pinned its hard to see the pin icon with the
// persons banner." Both trailing marks had it. The pin was a bare
// accent-coloured outline and the ✕ a bare grey one, and they sit in the row's
// trailing column — exactly where a sidebar banner paints its BRIGHTEST pixels,
// because the ramp in paintSidebarBanner() darkens toward the LEFT, so the right
// end is the picture under nothing but a 45% scrim. Over a sunlit photo both
// were smudges; over a white sky, invisible.
//
// The pin is a filled accent chip now and the ✕ a dark scrim chip, so what is
// behind the row cannot matter. This test proves that rather than trusting it:
// it paints a PURE WHITE banner through the REAL paintSidebarBanner(),
// screenshots the row and samples the inside of each mark — every sample must
// still be that mark's own fill, not the picture.
//
// Static checks run everywhere; the browser half skips without Chrome.
//
// Usage: node scripts/test-dm-row-marks.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { decodePNG } = require('./png-util.js');

const ROOT = path.join(__dirname, '..');
const SIDE_W = 320, ROW_H = 44;

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
const home = fs.readFileSync(path.join(ROOT, 'public/js/home.js'), 'utf8');
const servers = fs.readFileSync(path.join(ROOT, 'public/js/servers.js'), 'utf8');
const bannerSrc = servers.slice(servers.indexOf('function paintSidebarBanner('), servers.indexOf('function paintMe() {'));

// The row dmRowEl() builds for a pinned, bannered 1:1 DM, minus the parts this
// test is not about (the avatar's picture and the story ring).
const PIN_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l1 7 3 3v2H5v-2l3-3z"/><path d="M12 16v5"/></svg>';
const X_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>
  html,body{margin:0;background:var(--panel)}
  #dm-list{width:${SIDE_W}px;padding:.55rem}
  .dmrow{height:${ROW_H}px}
  /* The ✕ reveals itself on row hover; this harness is about its FILL over a
     banner, not about the reveal, and a hover state cannot be held in a
     screenshot run. Everything else is the shipped cascade. */
  .dmrow .dm-close{opacity:1!important;transition:none!important}
</style></head><body>
<div id="dm-list"></div>
<script>
${bannerSrc}
// A sidebar banner that is pure WHITE — the worst case a bare glyph ever met.
const WHITE = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#fff"/></svg>');
const row = document.createElement('button');
row.className = 'dmrow pinned has-banner';
row.innerHTML = '<span class="avwrap st-online"><span class="avatar" style="background:#5865f2">J</span>'
  + '<span class="status-dot online"></span></span>'
  + '<span class="dmmain"><span class="mname-row"><span class="dmname">Jordan</span></span>'
  + '<span class="dmlast">Pinned chat</span></span>'
  + '<span class="dm-pin" title="Pinned to top">${PIN_SVG}</span>'
  + '<span class="dm-badge">3</span>'
  + '<span class="dm-close" role="button" tabindex="0" title="Close DM">${X_SVG}</span>';
document.getElementById('dm-list').appendChild(row);
paintSidebarBanner(row, WHITE, 'var(--panel)');
// Sample points inside each mark, clear of its glyph: the pin's body sits in the
// four quarter cells (its head and stem cross the middle), and the ✕'s strokes
// run corner to corner on the diagonals, so its fill is read at the edge centres.
function probe(sel, points) {
  const el = row.querySelector(sel);
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    sel,
    background: cs.backgroundColor,
    color: cs.color,
    width: cs.width, height: cs.height, radius: cs.borderTopLeftRadius,
    stroke: getComputedStyle(el.querySelector('svg')).stroke,
    opacity: cs.opacity,
    points: points.map(([fx, fy]) => [Math.round(r.left + r.width * fx), Math.round(r.top + r.height * fy)]),
  };
}
window.__out = {
  pin: probe('.dm-pin', [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]),
  close: probe('.dm-close', [[0.5, 0.18], [0.5, 0.82], [0.18, 0.5], [0.82, 0.5]]),
  dpr: devicePixelRatio,
};
document.title = JSON.stringify(window.__out);
</script></body></html>`;
}

function shot(chrome, html, dpr, dir) {
  const p = path.join(dir, 'p.html');
  fs.writeFileSync(p, html);
  const png = path.join(dir, 'pin-' + dpr + '.png');
  const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof-' + dpr),
    '--force-device-scale-factor=' + dpr, '--window-size=' + SIDE_W + ',' + (ROW_H + 24),
    '--virtual-time-budget=2500', '--screenshot=' + png, '--dump-dom', 'file:///' + p.replace(/\\/g, '/')],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
  if (!m) return { err: 'no title, status ' + r.status };
  const out = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  out.png = fs.existsSync(png) ? decodePNG(png) : null;
  return out;
}

function main() {
  console.log('\n[1] both marks are filled chips, not bare glyphs');
  const rule = /\.dm-pin\{([^}]*)\}/.exec(css);
  check(!!rule, 'styles.css styles .dm-pin');
  if (rule) {
    check(/background:var\(--accent\)/.test(rule[1]), 'the pin is filled with the accent', rule[1]);
    check(/color:var\(--on-accent\)/.test(rule[1]), 'and its glyph is the on-accent colour that reads on it', rule[1]);
    check(/border-radius:50%/.test(rule[1]) && /width:18px/.test(rule[1]) && /height:18px/.test(rule[1]), 'an 18px disc', rule[1]);
    check(/justify-content:center/.test(rule[1]) && /align-items:center/.test(rule[1]), 'with the glyph centred', rule[1]);
  }
  check(/\.dm-pin svg\{[^}]*width:11px/.test(css), 'the glyph is sized inside it');
  check(!/\.dmrow\.pinned \.dm-pin\{color:/.test(css),
    'and nothing re-colours the glyph behind the chip (the trap: a higher-specificity colour on a filled disc hides it)');
  check(/pin\.className = 'dm-pin';/.test(home) && /pin\.title = 'Pinned to top';/.test(home),
    'the row still renders the same element for a pinned chat');
  check(/stroke="currentColor"/.test(home), 'the glyph rides currentColor, so the chip decides how it reads');
  check((home.match(/dm-pin/g) || []).length === 1, 'the pin is only ever the one mark on the row');
  // The ✕ is a control rather than a state, so it wears the scrim `.att-dl` uses
  // over media rather than the accent: dark, white glyph, no hue change on hover
  // (the danger wash it keeps on a flat row is 9% red — no use over a picture).
  check(/\.dmrow\.has-banner \.dm-close\{background:rgba\(0,0,0,\.6\);color:#fff\}/.test(css),
    'a bannered row\'s ✕ gets a dark scrim and a white glyph');
  check(/\.dmrow\.has-banner \.dm-close:hover\{background:rgba\(0,0,0,\.8\);color:#fff\}/.test(css),
    'which darkens rather than changing hue on hover');
  const scrim = /\.dmrow\.has-banner \.dm-close\{background:rgba\(0,0,0,\.6\)/.exec(css);
  check(!!scrim && /\.dm-close:hover\{background:var\(--danger-bg\)/.test(css),
    'and the flat-row hover is left as it was (the bannered rule outranks it)');
  check(/x\.className = 'dm-close';/.test(home) && (home.match(/dm-close/g) || []).length === 1,
    'the ✕ still comes from the one place in the row builder');
  // Worst case, the scrim leaves white on <=102 grey: still comfortably readable.
  const lum = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const L = (rgb) => 0.2126 * lum(rgb[0]) + 0.7152 * lum(rgb[1]) + 0.0722 * lum(rgb[2]);
  const worst = Math.round(255 * (1 - 0.6));
  const ratio = (1.0 + 0.05) / (L([worst, worst, worst]) + 0.05);
  check(ratio >= 4.5, 'the glyph clears 4.5:1 even over a pure-white picture', { worst, ratio: Math.round(ratio * 10) / 10 });

  const chrome = findChrome();
  if (!chrome) return skip('no Chrome/Edge found — set CHROME_PATH');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-dmmark-'));
  try {
    console.log('\n[2] a pure-white banner cannot show through either of them (headless Chrome)');
    const html = pageHtml();
    for (const dpr of [1, 2]) {
      const out = shot(chrome, html, dpr, dir);
      if (out.err) { check(false, 'the dpr ' + dpr + ' harness ran', out.err); continue; }
      const pin = out.pin, close = out.close;
      check(pin.background === 'rgb(91, 108, 255)', 'dpr ' + dpr + ' — the pin chip is opaque accent (nothing paints through)', pin.background);
      check(pin.width === '18px' && pin.height === '18px' && pin.radius === '50%', 'dpr ' + dpr + ' — an 18px pin disc', { w: pin.width, h: pin.height });
      check(pin.color === 'rgb(255, 255, 255)' && pin.stroke === 'rgb(255, 255, 255)', 'dpr ' + dpr + ' — its glyph takes the on-accent white', pin.stroke);
      check(close.background === 'rgba(0, 0, 0, 0.6)' && close.color === 'rgb(255, 255, 255)', 'dpr ' + dpr + ' — the ✕ has its scrim and a white glyph', { bg: close.background, c: close.color });
      check(close.stroke === 'rgb(255, 255, 255)', 'dpr ' + dpr + ' — and the ✕ glyph takes it too', close.stroke);
      check(close.opacity === '1', 'dpr ' + dpr + ' — the ✕ is actually on screen to be sampled', close.opacity);
      if (!out.png) { check(false, 'dpr ' + dpr + ' — a screenshot to sample', 'none'); continue; }
      const img = out.png;
      const px = (x, y) => { const i = (y * img.w + x) * 4; return [img.px[i], img.px[i + 1], img.px[i + 2]]; };
      const near = (p, [r, g, b], tol) => Math.abs(p[0] - r) <= tol && Math.abs(p[1] - g) <= tol && Math.abs(p[2] - b) <= tol;
      const read = (mark) => mark.points.map(([x, y]) => ({ at: [x, y], px: px(Math.round(x * dpr), Math.round(y * dpr)) }));

      const ps = read(pin);
      const accent = ps.filter((s) => near(s.px, [91, 108, 255], 26));
      check(accent.length === ps.length, 'dpr ' + dpr + ' — the accent fills the pin over a white banner',
        { samples: ps.length, accent: accent.length, read: ps.map((s) => s.px.join(',')) });
      check(ps.every((s) => !near(s.px, [255, 255, 255], 26)), 'dpr ' + dpr + ' — the picture never reaches the inside of the pin');

      const xs = read(close);
      // A 60% black scrim over the (scrimmed) white banner composites well under
      // 120; the point is that it is nowhere near the picture's own white.
      check(xs.every((s) => s.px[0] < 120 && s.px[1] < 120 && s.px[2] < 120), 'dpr ' + dpr + ' — the ✕ chip is dark over a white banner',
        { read: xs.map((s) => s.px.join(',')) });
      const spread = Math.max(...xs.map((s) => Math.max(...s.px))) - Math.min(...xs.map((s) => Math.min(...s.px)));
      check(spread <= 20, 'dpr ' + dpr + ' — and it is a flat fill, not the picture showing through', { spread, read: xs.map((s) => s.px.join(',')) });
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
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
