// The pinned-chat mark on a DM row must stay legible over the person's banner.
//
// The complaint: "when a dm is pinned its hard to see the pin icon with the
// persons banner." The pin sat in the row's trailing column, which is exactly
// where a sidebar banner paints its BRIGHTEST pixels — the ramp in
// paintSidebarBanner() darkens toward the LEFT, so the right end is the picture
// under nothing but a 45% scrim. An accent-coloured 12px outline over a sunlit
// photo is a smudge, and over a white sky it is invisible.
//
// The mark is a filled chip now, so the background behind it cannot matter. This
// test proves that rather than trusting it: it paints a PURE WHITE banner through
// the REAL paintSidebarBanner(), screenshots the row and samples the inside of
// the chip — every sample must still be the accent, not the picture.
//
// Static checks run everywhere; the browser half skips without Chrome.
//
// Usage: node scripts/test-dm-pin.js
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

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>
  html,body{margin:0;background:var(--panel)}
  #dm-list{width:${SIDE_W}px;padding:.55rem}
  .dmrow{height:${ROW_H}px}
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
  + '<span class="dm-badge">3</span>';
document.getElementById('dm-list').appendChild(row);
paintSidebarBanner(row, WHITE, 'var(--panel)');
const pin = row.querySelector('.dm-pin');
const cs = getComputedStyle(pin);
const glyph = pin.querySelector('svg');
const chip = [cs.backgroundColor, cs.width, cs.height, cs.borderTopLeftRadius, cs.color];
const rect = (() => { const r = pin.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })();
// The disc's BODY, clear of the glyph at its centre: the four quarter points.
const inside = [0.25, 0.75].flatMap((fx) => [0.25, 0.75].map((fy) => [Math.round(rect.x + rect.w * fx), Math.round(rect.y + rect.h * fy)]));
window.__out = {
  chip,
  color: cs.color,
  glyphStroke: getComputedStyle(glyph).stroke,
  rect,
  inside,
  dpr: devicePixelRatio,
  rowBg: getComputedStyle(row).backgroundImage.slice(0, 40),
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
  console.log('\n[1] the mark is a filled chip, not a bare glyph');
  const rule = /\.dm-pin\{([^}]*)\}/.exec(css);
  check(!!rule, 'styles.css styles .dm-pin');
  if (rule) {
    check(/background:var\(--accent\)/.test(rule[1]), 'the chip is filled with the accent', rule[1]);
    check(/color:var\(--on-accent\)/.test(rule[1]), 'and the glyph is the on-accent colour that reads on it', rule[1]);
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

  const chrome = findChrome();
  if (!chrome) return skip('no Chrome/Edge found — set CHROME_PATH');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-dmpin-'));
  try {
    console.log('\n[2] a pure-white banner cannot show through it (headless Chrome)');
    const html = pageHtml();
    for (const dpr of [1, 2]) {
      const out = shot(chrome, html, dpr, dir);
      if (out.err) { check(false, 'the dpr ' + dpr + ' harness ran', out.err); continue; }
      const [bg, w, h, radius, color] = out.chip;
      check(bg === 'rgb(91, 108, 255)', 'dpr ' + dpr + ' — the chip is opaque accent (nothing paints through)', bg);
      check(w === '18px' && h === '18px' && radius === '50%', 'dpr ' + dpr + ' — an 18px disc', { w, h, radius });
      check(color === 'rgb(255, 255, 255)', 'dpr ' + dpr + ' — glyph on-accent white', color);
      check(out.glyphStroke === 'rgb(255, 255, 255)', 'dpr ' + dpr + ' — the glyph actually takes it', out.glyphStroke);
      if (!out.png) { check(false, 'dpr ' + dpr + ' — a screenshot to sample', 'none'); continue; }
      const img = out.png;
      const px = (x, y) => { const i = (y * img.w + x) * 4; return [img.px[i], img.px[i + 1], img.px[i + 2]]; };
      const near = (p, [r, g, b], tol) => Math.abs(p[0] - r) <= tol && Math.abs(p[1] - g) <= tol && Math.abs(p[2] - b) <= tol;
      const samples = out.inside.map(([x, y]) => ({ at: [x, y], px: px(Math.round(x * dpr), Math.round(y * dpr)) }));
      // Every sample inside the disc is the accent, not the white banner behind it.
      const painted = samples.filter((s) => near(s.px, [91, 108, 255], 26));
      check(painted.length === samples.length, 'dpr ' + dpr + ' — the accent fills the mark over a white banner',
        { samples: samples.length, accent: painted.length, read: samples.map((s) => s.px.join(',')) });
      const white = samples.filter((s) => near(s.px, [255, 255, 255], 26));
      check(white.length === 0, 'dpr ' + dpr + ' — and the picture behind never reaches the inside of it', white.map((s) => s.at));
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
