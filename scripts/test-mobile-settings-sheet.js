// Mobile settings master/detail and the me-bar user-card sheet (see AGENTS.md).
//
// Two mobile navigation asks:
//   1. the me bar opens a full-height user-card sheet that slides up from the
//      bottom (desktop keeps the bottom-anchored popup);
//   2. settings is a menu of vertical section rows on a phone, and picking one
//      opens that section alone with back (left) + close (right) — instead of
//      the horizontal tab strip that used to run along the top.
//
// Drives the REAL `openOwnCard` (security.js) and the REAL settings view helpers
// (settings.js) against the REAL index.html markup and styles.css in headless
// Chrome, at a phone viewport (Chrome clamps the layout viewport to 500px) and a
// desktop one. Skips without Chrome.
//
// Usage: node scripts/test-mobile-settings-sheet.js
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

const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const security = fs.readFileSync(path.join(ROOT, 'public/js/security.js'), 'utf8');
const settings = fs.readFileSync(path.join(ROOT, 'public/js/settings.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

const settingsMarkup = index.slice(index.indexOf('<!-- settings'), index.indexOf('<!-- server settings'));
const ownCardSrc = security.slice(security.indexOf('function openOwnCard() {'), security.indexOf('// Only the avatar + name opens it'));
const viewSrc = settings.slice(settings.indexOf('function settingsPanelEl()'), settings.indexOf('function openSettings('));

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>#me-card{position:fixed;left:0;bottom:0;width:280px;height:58px}
*{animation:none!important;transition:none!important}</style></head><body>
<div id="me-card"><button type="button" id="me-open">me</button></div>
<div id="usercard" class="hidden"></div>
${settingsMarkup}
<script>
window.S = { me: { id: 'me', display_name: 'Jordan', username: 'jordan' } };
window.$ = (s) => document.querySelector(s);
window.__calls = [];
window.openUserCard = (uid, x, y) => {
  const c = document.getElementById('usercard');
  c.dataset.uid = uid;
  c.classList.remove('hidden');
  __calls.push(['openUserCard', uid]);
};
window.closeUserCard = () => {
  const c = document.getElementById('usercard');
  c.classList.add('hidden');
  c.classList.remove('sheet');
  __calls.push(['closeUserCard']);
};
${ownCardSrc}
${viewSrc}
const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), y: Math.round(r.y), h: Math.round(r.height), bottom: Math.round(r.bottom) }; };
const outer = (el) => { const cs = getComputedStyle(el); return { display: cs.display, position: cs.position, height: cs.height, radiusTop: cs.borderTopLeftRadius }; };
const out = { innerW: innerWidth, innerH: innerHeight };
// ---- me bar sheet ----
document.getElementById('settings-backdrop').classList.add('hidden');
openOwnCard();
const card = document.getElementById('usercard');
out.sheetClass = card.classList.contains('sheet');
out.inline = { left: card.style.left, top: card.style.top, bottom: card.style.bottom, maxHeight: card.style.maxHeight };
out.cardRect = rect(card);
out.cardStyle = outer(card);
out.calls = __calls.slice();
// closing drops the class
closeUserCard();
out.afterClose = { sheet: card.classList.contains('sheet'), hidden: card.classList.contains('hidden') };
// ---- settings master/detail ----
const sb = document.getElementById('settings-backdrop');
sb.classList.remove('hidden');
const panel = sb.querySelector('.settings');
const rail = sb.querySelector('.set-tabs');
const body = sb.querySelector('.set-body');
const detailHead = sb.querySelector('.set-mhead-detail');
const back = document.getElementById('settings-back');
const closeDetail = document.getElementById('settings-close-detail');
const railClose = document.getElementById('settings-close');
const menuClose = document.getElementById('settings-close-menu');
out.servedClass = panel.className;
out.menu = { rail: outer(rail).display, body: outer(body).display, detailHead: outer(detailHead).display, menuClose: outer(menuClose).display, railClose: outer(railClose).display };
setSettingsView('section');
out.section = { rail: outer(rail).display, body: outer(body).display, detailHead: outer(detailHead).display };
out.detailRect = { back: rect(back), close: rect(closeDetail), head: rect(detailHead) };
setSettingsView('menu');
out.backToMenu = { rail: outer(rail).display, body: outer(body).display };
out.labels = { account: settingsTabLabel('account'), themes: settingsTabLabel('themes'), nope: settingsTabLabel('nope') };
out.phone = settingsIsPhone();
document.title = JSON.stringify(out);
</script></body></html>`;
}

function run(chrome, html, size) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-mobset-'));
  try {
    const p = path.join(dir, 'page.html');
    fs.writeFileSync(p, html);
    const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=' + size,
      '--virtual-time-budget=2000', '--dump-dom', 'file:///' + p.replace(/\\/g, '/')],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
    if (!m) return { err: 'no title, status ' + r.status + ' ' + (r.stderr || '').slice(-300) };
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function main() {
  console.log('\n[1] the wiring is there');
  check(/\.set-mhead\{display:none/.test(css), 'the mobile header rows are desktop-hidden by default (.set-mhead)');
  check(/#settings-backdrop \.settings\.menu \.set-body/.test(css) && /#settings-backdrop \.settings\.section \.set-tabs\{display:none\}/.test(css), 'the menu/section view classes drive the mobile CSS');
  check(/#settings-backdrop #settings-close\{display:none\}/.test(css), 'the rail close gives way to the mobile headers');
  check(settings.includes("setSettingsTab(b.dataset.tab);") && settings.includes("setSettingsView('section')"), 'a section row opens that section');
  check(settings.includes("if (settingsBack) settingsBack.onclick = () => setSettingsView('menu');"), 'the back button returns to the menu');
  check(settings.includes("['settings-close-menu', 'settings-close-detail']"), 'both mobile close buttons are wired');
  check(/function openSettings\(tab\) \{[\s\S]{0,90}const explicit = tab !== undefined;/.test(settings), 'openSettings knows whether a tab was asked for');
  check(/setSettingsView\(settingsIsPhone\(\) && !explicit \? 'menu' : 'section'\)/.test(settings), 'the gear opens the menu on a phone, a caller-named tab opens straight to it');
  check(/#usercard\.sheet\{[^}]*translateY|@keyframes cf-sheet-up\{from\{transform:translateY\(100%\)/.test(css), 'the sheet animates up from below (.css)');
  check(/@media \(max-width:700px\)\{[^}]*#usercard\.sheet|#usercard\.sheet\{/.test(css), 'the sheet rules only exist on mobile');
  check(security.includes("card.classList.add('sheet')"), 'openOwnCard switches the card to a sheet on a phone');
  check(security.includes("card.classList.remove('sheet')"), 'and the desktop branch clears it');

  const chrome = findChrome();
  if (!chrome) return skip('no Chrome/Edge found — set CHROME_PATH');
  const html = pageHtml();

  console.log('\n[2] phone: the me bar gives a bottom sheet');
  const phone = run(chrome, html, '500,900');
  if (phone.err) check(false, 'the phone harness ran', phone.err);
  else {
    check(phone.sheetClass === true, 'the open card carries .sheet');
    check(phone.inline.left === '' && phone.inline.top === '' && phone.inline.bottom === '' && phone.inline.maxHeight === '', 'the popup positioning is cleared so the CSS owns it', phone.inline);
    check(phone.cardStyle.position === 'fixed' && phone.cardRect.bottom === phone.innerH, 'pinned to the bottom of the viewport', { r: phone.cardRect, innerH: phone.innerH });
    check(phone.cardRect.x === 0 && phone.cardRect.w === phone.innerW, 'edge to edge', { r: phone.cardRect, innerW: phone.innerW });
    check(phone.cardRect.h === phone.innerH, 'full height', { h: phone.cardRect.h, innerH: phone.innerH });
    check(parseFloat(phone.cardStyle.radiusTop) >= 14, 'with a rounded top', phone.cardStyle.radiusTop);
    check(phone.afterClose.sheet === false && phone.afterClose.hidden === true, 'closing clears the sheet class (so the next open re-animates)');
  }

  console.log('\n[3] phone: settings is a menu, then a section with back + close');
  if (phone.err) { /* already reported */ }
  else {
    check(phone.phone === true, 'the phone branch is the one under test', phone.phone);
    check(phone.servedClass.includes('menu'), 'settings opens on the menu', phone.servedClass);
    check(phone.menu.rail !== 'none', 'the menu lists the section rows', phone.menu.rail);
    check(phone.menu.body === 'none' && phone.menu.detailHead === 'none', 'with the section body and its header hidden', phone.menu);
    check(phone.menu.menuClose !== 'none' && phone.menu.railClose === 'none', 'the menu header owns the close button', phone.menu);
    check(phone.section.rail === 'none' && phone.section.body !== 'none' && phone.section.detailHead !== 'none', 'picking a section shows it alone', phone.section);
    check(phone.detailRect.back.x < phone.detailRect.head.w / 2 && phone.detailRect.close.x > phone.detailRect.head.w / 2, 'back on the left half, close on the right half', phone.detailRect);
    check(phone.detailRect.close.x + phone.detailRect.close.w <= phone.detailRect.head.w + 1, 'and the header fits the viewport (no clipped close)', phone.detailRect);
    check(phone.backToMenu.rail !== 'none' && phone.backToMenu.body === 'none', 'back returns to the menu');
    check(phone.labels.account === 'Account' && phone.labels.themes === 'Themes' && phone.labels.nope === 'Settings', 'the detail title comes off the row label', phone.labels);
  }

  console.log('\n[4] desktop keeps the rail and the popup');
  const desk = run(chrome, html, '1200,900');
  if (desk.err) check(false, 'the desktop harness ran', desk.err);
  else {
    check(desk.phone === false, 'the desktop branch is the one under test', desk.phone);
    check(desk.sheetClass === false, 'no sheet class', desk.sheetClass);
    check(desk.inline.bottom !== '' && desk.inline.top === 'auto', 'the card is bottom-anchored above the me bar', desk.inline);
    check(desk.cardStyle.position === 'fixed' && desk.cardRect.w === 300, 'and stays the 300px popup', { r: desk.cardRect, style: desk.cardStyle });
    check(desk.menu.detailHead === 'none', 'no mobile detail header on desktop', desk.menu.detailHead);
    check(desk.menu.rail !== 'none' && desk.menu.body !== 'none', 'the rail and the body show together', desk.menu);
    check(desk.menu.railClose !== 'none', 'with the rail close button', desk.menu.railClose);
    check(desk.section.rail !== 'none' && desk.section.detailHead === 'none', 'the view classes are inert on desktop', desk.section);
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
