// The sidebar-banner ramp must not leave a light line down the left edge (see
// AGENTS.md verification conventions).
//
// The complaint: wherever a sidebar banner shows (member rows, DM rows, the me
// bar) the picture is darkened toward the left by a ramp gradient, and right at
// the left edge a strip of a few pixels went back to light — the undarkened
// picture leaking through.
//
// Cause: those rows are fractional-width (the me bar measures 327.406px, the
// member list rows ~250.4px) and the paint set `background-size: cover` +
// `background-position: right center` while leaving `background-repeat` at its
// default `repeat`. Blink rasterises the covered layers a sub-pixel short of the
// box, and with the position anchored right the leftover sliver at the LEFT gets
// filled from the tiled copy — the banner starts again there, above the ramp's
// own repeat, so the ramp is dark but the picture shows through. At dpr 1 that
// sub-pixel lands on a whole device pixel: the light 1px line.
//
// This drives the REAL paintSidebarBanner() out of public/js/servers.js in
// headless Chrome, paints a pure-white banner through it at three device scale
// factors, screenshots the rows and asserts the left edge stays dark while the
// picture is still visibly painted further in. A "vintage" row keeps the old
// inline recipe so the harness proves it can reproduce the seam at all.
//
// Skips (exit 0) when Chrome is unavailable.
//
// Usage: node scripts/test-sidebar-banner-edge.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { decodePNG } = require('./png-util.js');

const ROOT = path.join(__dirname, '..');
const DPFS = [1, 1.25, 2];
// Row geometry the harness lays out (CSS px): rows are 44 tall with a 12 gap.
const ROW_H = 44, GAP = 12, SIDE_W = 268, LIST_PAD = 0.55 * 16; // .55rem, as the sidebar lists use

let passed = 0;
const failures = [];
let notes = 0;
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function note(msg) { notes++; console.log('  NOTE ' + msg); }
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

// The real painter, sliced out of servers.js — there is no bundler here, so the
// page runs the shipped source (same trick as test-story-ring.js).
function bannerSource() {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/servers.js'), 'utf8');
  const a = src.indexOf('function paintSidebarBanner(');
  const b = src.indexOf('function paintMe() {');
  if (a < 0 || b < 0 || b < a) {
    console.error('[test] could not find paintSidebarBanner in public/js/servers.js');
    process.exit(1);
  }
  return src.slice(a, b);
}

function pageHtml() {
  const rows = ['panel', 'panel2', 'vintage']
    .map((id, i) => `<div class="member has-banner" data-row="${i}" id="${id}"><span class="mnames"><span class="mname-row"><span class="mname">Ada</span></span></span></div>`)
    .join('');
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>
  html,body{margin:0;background:#000}
  #side{width:${SIDE_W}px;background:var(--panel)}
  #dm-list{padding:0 ${LIST_PAD}px}
  #dm-list .member{height:${ROW_H}px;margin:0 0 ${GAP}px;border-radius:10px}
  #dm-list .member:last-child{margin-bottom:0}
</style></head><body>
<div id="side"><div id="dm-list">${rows}</div></div>
<script>
const WHITE = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#fff"/></svg>');
${bannerSource()}
paintSidebarBanner(document.getElementById('panel'), WHITE, 'var(--panel)');
paintSidebarBanner(document.getElementById('panel2'), WHITE, 'var(--panel-2)');
// The recipe this test exists to keep out: cover + right-anchored + default repeat.
const v = document.getElementById('vintage');
v.style.backgroundImage = 'linear-gradient(rgba(0,0,0,.45),rgba(0,0,0,.45)),linear-gradient(90deg, var(--panel) 5%, rgba(0,0,0,0) 78%), url("' + WHITE + '")';
v.style.backgroundSize = 'cover';
v.style.backgroundPosition = 'right center';
window.__boxes = [...document.querySelectorAll('[data-row]')].map((el) => {
  const b = el.getBoundingClientRect();
  return { id: el.id, left: b.left, top: b.top, width: b.width, height: b.height };
});
</script></body></html>`;
}

function runChrome(chromePath, url, dpr, outPng, dir) {
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'profile-' + dpr),
    '--force-device-scale-factor=' + dpr,
    '--window-size=' + SIDE_W + ',' + (ROW_H * 3 + GAP * 2),
    '--screenshot=' + outPng, url,
  ];
  const r = spawnSync(chromePath, args, { stdio: 'ignore', timeout: 60000 });
  return fs.existsSync(outPng) && r.status === 0;
}

function main() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');
  for (const f of ['public/styles.css', 'public/js/servers.js']) {
    if (!fs.existsSync(path.join(ROOT, f))) { console.error('[test] missing ' + f); process.exit(1); }
  }
  const html = pageHtml();

  console.log('\n[1] the recipe keeps every layer untitled and box-sized');
  check(/backgroundRepeat = 'no-repeat'/.test(html), 'the banner layers are painted no-repeat');
  check(/backgroundSize = '100% 100%, 100% 100%, cover'/.test(html), 'the two ramps are exactly box-sized, only the picture is cover');
  check(/backgroundPosition = '0 0, 0 0, right center'/.test(html), 'the ramps are box-anchored, only the picture is right-anchored');
  const servers = fs.readFileSync(path.join(ROOT, 'public/js/servers.js'), 'utf8');
  const home = fs.readFileSync(path.join(ROOT, 'public/js/home.js'), 'utf8');
  check(!/90deg, var\(--panel/.test(servers) && !/90deg, var\(--panel/.test(home), 'no surface re-inlines the old cover/repeat recipe');
  check((servers.match(/paintSidebarBanner\(/g) || []).length === 3, 'servers.js paints the me bar + member rows through the helper');
  check((home.match(/paintSidebarBanner\(/g) || []).length === 1, 'home.js paints DM rows through the helper');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-banner-'));
  let vintageLeaked = 0;
  try {
    const htmlPath = path.join(dir, 'banner.html');
    fs.writeFileSync(htmlPath, html);
    const url = 'file:///' + htmlPath.replace(/\\/g, '/');

    console.log('\n[2] the left edge of a painted row stays dark (no light seam)');
    for (const dpr of DPFS) {
      const png = path.join(dir, 'shot-' + dpr + '.png');
      if (!runChrome(chromePath, url, dpr, png, dir)) { note('dpr ' + dpr + ': Chrome produced no screenshot, skipped'); continue; }
      const img = decodePNG(png);
      const at = (x, y) => { const i = (y * img.w + x) * 4; return [img.px[i], img.px[i + 1], img.px[i + 2]]; };
      const scale = img.w / SIDE_W;
      // The list is padded on the left, so the rows start inset by LIST_PAD.
      const edgeX = LIST_PAD * scale;

      const scanRow = (rowIndex) => {
        const top = Math.round(rowIndex * (ROW_H + GAP) * scale);
        const bottom = Math.round((rowIndex * (ROW_H + GAP) + ROW_H) * scale);
        // Device-pixel rows only, and clear of the rounded corners.
        const y0 = top + Math.round(6 * scale), y1 = bottom - Math.round(6 * scale);
        const x0 = Math.ceil(edgeX), x1 = Math.ceil(edgeX + 2 * scale);
        let lightest = 0, lightestAt = null, far = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const p = at(x, y);
            if (p[0] > lightest) { lightest = p[0]; lightestAt = [x, y, p]; }
          }
        }
        // And prove the picture is actually painted further in (right side).
        const midY = Math.round((top + bottom) / 2);
        for (let x = Math.ceil((SIDE_W - LIST_PAD - 5) * scale); x < Math.ceil((SIDE_W - LIST_PAD - 1) * scale); x++) {
          far = Math.max(far, at(x, midY)[0]);
        }
        return { lightest, lightestAt, far };
      };

      const painted = scanRow(0);
      const painted2 = scanRow(1);
      const vintage = scanRow(2);
      if (vintage.lightest > 40) vintageLeaked++;

      check(painted.lightest <= 30, 'dpr ' + dpr + ' — me bar (panel base) left edge is dark', { lightest: painted.lightest, at: painted.lightestAt });
      check(painted2.lightest <= 30, 'dpr ' + dpr + ' — banner row (panel-2 base) left edge is dark', { lightest: painted2.lightest, at: painted2.lightestAt });
      check(painted.far >= 120 && painted2.far >= 120, 'dpr ' + dpr + ' — the banner is still painted (right side is bright)', { panel: painted.far, panel2: painted2.far });
    }
    if (!vintageLeaked) note('the vintage cover/repeat recipe did not reproduce the seam on this Chrome — the harness may have gone stale');
    else console.log('  (harness check: the old cover/repeat recipe still reproduces the light edge at ' + vintageLeaked + '/' + DPFS.length + ' dprs)');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed' + (notes ? ' (' + notes + ' note' + (notes === 1 ? '' : 's') + ')' : '')));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

main();
