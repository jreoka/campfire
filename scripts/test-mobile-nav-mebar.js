// Mobile nav is a full-screen page, and the me bar has a real click target
// (see AGENTS.md verification conventions).
//
// Two complaints:
//  1. the mobile sidebar (server rail + chat list) slid in as a partial-width
//     drawer that hung *over* the chat, dimmed by a scrim. It is a whole page
//     now: it covers the viewport, nothing shows behind it, the scrim is gone
//     and the page carries its own ✕ (the chat's ☰ is behind the page).
//  2. the whole me bar opened your user card, so a click *around* the
//     mute/deafen/settings buttons opened it too. Only the avatar + name does
//     now, and that target outlines itself on hover.
//
// Drives the REAL styles.css and the REAL index.html markup in headless Chrome
// at a phone viewport and a desktop viewport; the page reports geometry and
// hit-testing through document.title (no CDP client needed).
//
// Skips (exit 0) when Chrome is unavailable.
//
// Usage: node scripts/test-mobile-nav-mebar.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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

// The real me bar + nav page markup, trimmed to what the two rules touch.
function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>#view-main{height:100vh}</style></head><body>
<section id="view-main"><div id="left">
  <nav id="rail"><div class="rail-head"><span id="home-wrap"><button id="btn-home" class="server-btn home-btn">H</button></span></div>
    <div class="rail-divider"></div><div id="server-list"><button id="btn-add-server">+</button></div></nav>
  <aside id="sidebar">
    <button type="button" id="btn-nav-close" class="icon-btn" title="Close menu" aria-label="Close menu"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    <div id="sidebar-resizer"></div>
    <div id="server-ui" class="hidden"><div id="server-header"><strong id="server-name">Studio</strong></div></div>
    <div id="home-ui">
      <div class="home-head"><strong>Home</strong></div>
      <button id="btn-friends" class="dmrow friends-btn"><span class="dmmain"><span class="dmname">Friends</span></span></button>
      <div class="chan-group-label">DIRECT MESSAGES</div>
      <div id="dm-list"></div>
    </div>
    <div id="me-card">
      <button type="button" id="me-open" title="Your profile card">
        <span id="me-avwrap" class="avwrap st-online"><span id="me-avatar" class="avatar">J</span><span id="me-dot" class="status-dot online"></span></span>
        <span class="mnames"><span class="mname-row"><span id="me-name">Jordan</span></span><span id="me-sub" class="mstatus">Heads down</span></span>
      </button>
      <button id="me-mute" class="me-icobtn" title="Mute mic">M</button>
      <button id="me-deafen" class="me-icobtn" title="Deafen">D</button>
      <button id="btn-settings-me" class="me-icobtn" title="Settings">S</button>
    </div>
  </aside>
</div>
<main id="chat"><header id="chat-header"><button id="btn-menu" class="icon-btn">☰</button><strong id="chan-name">general</strong></header></main>
</section>
<script>
const params = new URLSearchParams(location.search);
if (params.get('nav') === '1') document.body.classList.add('nav-open');
let opened = 0;
document.getElementById('me-open').onclick = () => { opened++; };   // stands in for openOwnCard
const box = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
const owner = (x, y) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return 'none';
  for (const id of ['me-open', 'me-mute', 'me-deafen', 'btn-settings-me', 'me-card', 'left', 'chat']) {
    if (el.closest('#' + id)) return id;
  }
  return el.tagName.toLowerCase();
};
window.__report = function () {
  const meOpen = document.getElementById('me-open');
  const o = box(meOpen);
  const mute = box(document.getElementById('me-mute'));
  const deaf = box(document.getElementById('me-deafen'));
  const set = box(document.getElementById('btn-settings-me'));
  const card = box(document.getElementById('me-card'));
  const left = box(document.getElementById('left'));
  const close = document.getElementById('btn-nav-close');
  // A point in the dead space between the name target and the first icon button.
  const gapX = (o.r + mute.l) / 2, gapY = (o.t + o.b) / 2;
  const nameX = o.l + 10, nameY = (o.t + o.b) / 2;
  // Click those two points and see who reacted.
  const clickAt = (x, y) => { const el = document.elementFromPoint(x, y); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })); };
  opened = 0; clickAt(nameX, nameY); const afterName = opened;
  opened = 0; clickAt(gapX, gapY); const afterGap = opened;
  return {
    vw: innerWidth, vh: innerHeight,
    left, card, meOpen: o, mute, deaf, set,
    closeVisible: !!(close.offsetWidth || close.offsetHeight),
    centerOwner: owner(innerWidth / 2, innerHeight / 2),
    nameOwner: owner(nameX, nameY),
    gapOwner: owner(gapX, gapY),
    gapBetween: mute.l - o.r,
    afterName, afterGap,
    meCardCursor: getComputedStyle(document.getElementById('me-card')).cursor,
    meOpenCursor: getComputedStyle(meOpen).cursor,
    meOpenTag: meOpen.tagName,
    iconInsideTarget: !!meOpen.querySelector('#me-mute, #me-deafen, #btn-settings-me'),
  };
};
setTimeout(() => { document.title = JSON.stringify(window.__report()); }, 250);
</script>
</body></html>`;
}

function probe(chrome, url, { width, height, dpr, mobile }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-nav-'));
  try {
    const args = [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + path.join(dir, 'prof'), '--force-device-scale-factor=' + dpr,
      '--window-size=' + width + ',' + height, '--virtual-time-budget=3000', '--dump-dom', url,
    ];
    if (mobile) args.splice(1, 0, '--enable-features=TouchpadOverscrollHistoryNavigation'); // noop, keeps args tidy
    const r = spawnSync(chrome, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
    if (!m) throw new Error('no title in dump (chrome status ' + r.status + ')');
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function main() {
  const chrome = findChrome();
  if (!chrome) return skip('no Chrome/Edge found (set CHROME_PATH)');

  console.log('\n[1] source-level shape of both changes');
  const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
  const ui = fs.readFileSync(path.join(ROOT, 'public/js/ui.js'), 'utf8');
  const security = fs.readFileSync(path.join(ROOT, 'public/js/security.js'), 'utf8');
  check(!index.includes('sidebar-scrim') && !css.includes('sidebar-scrim') && !ui.includes('sidebar-scrim'), 'the nav scrim is gone (element, CSS and handler)');
  check(/<button type="button" id="btn-nav-close" class="icon-btn"/.test(index), 'the nav page carries its own ✕');
  check(/\$\('#btn-nav-close'\)\.onclick/.test(ui) && /#btn-home, #btn-friends, #btn-stories/.test(ui), 'the ✕ and the nav destinations close the page');
  check(/<button type="button" id="me-open" title="Your profile card">/.test(index), 'the me bar wraps the avatar + name in an explicit click target');
  check(!/\$\('#me-card'\)\.onclick/.test(security) && /\$\('#me-open'\)\.onclick = openOwnCard/.test(security), 'only that target opens the card');
  check(!/#me-card:hover\{background-color/.test(css), 'the whole bar no longer highlights as if it were clickable');
  check(/#me-open:hover\{background:var\(--panel-3\);outline:1px solid var\(--line\);outline-offset:1px\}/.test(css) && /@media \(hover:hover\)/.test(css), 'the target outlines itself on hover (desktop only)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-navpage-'));
  let phone, desktop;
  try {
    const htmlPath = path.join(dir, 'page.html');
    fs.writeFileSync(htmlPath, pageHtml());
    const base = 'file:///' + htmlPath.replace(/\\/g, '/');

    console.log('\n[2] the phone nav is a full-screen page');
    phone = probe(chrome, base + '?nav=1', { width: 390, height: 844, dpr: 3, mobile: true });
    check(Math.abs(phone.left.l) <= 0.01 && Math.abs(phone.left.t) <= 0.01, 'the page sits at the viewport origin', phone.left);
    check(phone.left.w >= phone.vw - 0.5 && phone.left.h >= phone.vh - 0.5, 'and covers it edge to edge (no partial-width drawer)', { left: phone.left, vw: phone.vw, vh: phone.vh });
    check(phone.centerOwner === 'left', 'the chat is not reachable behind it (hit test at the centre lands in the page)', { centerOwner: phone.centerOwner });
    check(phone.closeVisible, 'the page shows its ✕ (the chat ☰ is behind it)');
    const hidden = probe(chrome, base, { width: 390, height: 844, dpr: 3, mobile: true });
    check(hidden.left.l < -100, 'and it is off-screen while closed', { left: hidden.left.l });

    console.log('\n[3] the me bar: the name area is the target, the rest is dead');
    desktop = probe(chrome, base, { width: 1100, height: 700, dpr: 2, mobile: false });
    check(desktop.meOpenTag === 'BUTTON', 'the target is a real button (keyboard reachable)');
    check(!desktop.iconInsideTarget, 'the mute/deafen/settings buttons are outside it');
    check(desktop.gapBetween > 6, 'there is real dead space between the target and the buttons', { gap: desktop.gapBetween });
    check(desktop.nameOwner === 'me-open', 'hit test on the avatar/name lands on the target');
    check(desktop.gapOwner === 'me-card', 'hit test in the dead space lands on the bar, not the target');
    check(desktop.afterName === 1, 'clicking the avatar/name opens the card', { opened: desktop.afterName });
    check(desktop.afterGap === 0, 'clicking the dead space opens nothing', { opened: desktop.afterGap });
    check(desktop.meOpenCursor === 'pointer' && desktop.meCardCursor === 'auto', 'only the target reads as clickable', { open: desktop.meOpenCursor, card: desktop.meCardCursor });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

main();
