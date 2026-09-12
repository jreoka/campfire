// The floating person popovers are the top layer of the app, not a layer under
// it (see the layer contract in public/styles.css).
//
// Owner report: in the story "who watched" list — a dialog — clicking a viewer
// opened their user card BEHIND the dialog, so it could not be read. The card
// was z-index 120 and the dialog layer 160. The card has to beat the dialog
// layer because dialogs contain people rows (the viewers list, the tag pills
// inside it), while staying under the lightbox, the context menus and the toast.
//
// Static half (always runs): the z-index contract, the fallback that lets a row
// hand over the person it already has, the viewers rows owning their click, and
// the backdrop-click guard that dismisses the card before the panel.
//
// Chrome half (skips without Chrome): the real stylesheet with the real layers
// stacked, asserting the card and the tag panel are what a click at their centre
// actually hits while a dialog is open, and that a backdrop click closes the
// card first and the dialog only on the second click.
//
// Usage: node scripts/test-user-card-layer.js
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
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}
const zOf = (css, sel) => {
  const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{[^}]*z-index:(\\d+)');
  const m = re.exec(css);
  return m ? Number(m[1]) : null;
};

const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'public/js/ui.js'), 'utf8');
const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
const stories = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

console.log('\n[1] the layer contract');
const cardZ = zOf(css, '#usercard');
const tagZ = zOf(css, '#tagcard');
const modalZ = zOf(css, '#modal-backdrop');
check(cardZ !== null && modalZ !== null && cardZ > modalZ, 'the user card beats the dialog layer', { cardZ, modalZ });
check(tagZ !== null && tagZ > cardZ, 'the tag mini-panel sits above the card (it opens from one)', { tagZ, cardZ });
check(tagZ !== null && tagZ > modalZ, 'and over the dialog layer too (tags render inside dialogs)', { tagZ, modalZ });
for (const [name, sel] of [['the lightbox', '#lightbox'], ['the context menu', '#ctx-menu'], ['the toast', '#toast']]) {
  const z = zOf(css, sel);
  check(z !== null && z > cardZ && z > tagZ, name + ' still wins', { z, cardZ, tagZ });
}
check(cardZ > zOf(css, '#profile-backdrop') && cardZ > zOf(css, '#settings-backdrop'),
  'and the card still floats over the screens it is opened from', { profile: zOf(css, '#profile-backdrop'), settings: zOf(css, '#settings-backdrop') });

console.log('\n[2] the rows hand over the person they already have');
check(/async function openUserCard\(uid, x, y, fallback\)/.test(pickers) && /const u = memberById\(uid\) \|\| \(fallback && fallback\.id === uid \? fallback : null\);/.test(pickers),
  'openUserCard takes a fallback user, like openProfileScreen');
check(/openProfileScreen\(uid, u\)/.test(pickers), 'and the card\'s Profile tab carries it on');
check(/if \(memberEl\?\.dataset\.uid && !memberEl\.dataset\.ownclick\) \{ openMemberCard/.test(pickers),
  'a member row that owns its click is left alone by the delegate');
check(/row\.dataset\.ownclick = '1';\n    row\.onclick = \(e\) => \{ openUserCard\(u\.id, e\.clientX, e\.clientY, u\); \};/.test(stories.replace(/\r\n/g, '\n')),
  'the story viewers rows open the card at the tap with the viewer object', /row\.onclick = [^\n]*/.exec(stories));
check(/if \(floating\) return;\n  cancelModal\(\);/.test(ui.replace(/\r\n/g, '\n')),
  'a backdrop click dismisses a floating card before the panel');
check(/const floating = \['#usercard', '#tagcard'\]\.some/.test(ui), 'and it looks at both popovers');

const chromePath = findChrome();
if (!chromePath) {
  console.log('\n[3] the layers in a browser — SKIPPED (no Chrome/Edge found; set CHROME_PATH)');
  finish();
}

// Real modal markup + wiring, real stylesheet, the real layers stacked the way
// the viewers panel leaves them.
const modalMarkup = index.slice(index.indexOf('<div id="modal-backdrop"'), index.indexOf('<!-- create-story chooser'));
const modalSrc = slice(ui, 'let modalOkFn = null;', '// Promise-based confirm dialog.');
function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<style>${css}</style></head><body>
${modalMarkup}
<div id="usercard" class="hidden"><div class="uc-body">card</div></div>
<div id="tagcard" class="hidden"><div class="tc-body">tag</div></div>
<div id="ctx-menu" class="hidden"></div>
<div id="lightbox" class="hidden"></div>
<div id="toast"></div>
<script>
window.$ = (s) => document.querySelector(s);
window.toast = () => {};
window.prettyError = (e) => String(e);
${modalSrc}
const box = (sel) => { const el = document.querySelector(sel); el.classList.remove('hidden'); return el; };
const at = (sel, dx, dy) => {
  const r = document.querySelector(sel).getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + (dx === undefined ? r.width / 2 : dx), r.top + (dy === undefined ? r.height / 2 : dy));
  return {
    hitId: hit ? (hit.id || hit.className) : null,
    inside: !!(hit && hit.closest && hit.closest(sel)),
    z: getComputedStyle(document.querySelector(sel)).zIndex,
  };
};
const out = {};
// The viewers panel is open (the app opens it through openModal) with a row in it.
openModal('3 views', '<div class="gmem-list"><div class="member sv-viewer" data-uid="u1"><span class="avwrap"><span class="avatar"></span></span><span class="dmmain"><span class="dmname">Ada</span></span></div></div>', 'Close', null, { wide: true });
out.panelOpen = !document.querySelector('#modal-backdrop').classList.contains('hidden');
// The card the row would open, floating over it.
const card = box('#usercard');
card.style.left = '60px'; card.style.top = '40px'; card.style.height = '120px';
out.card = at('#usercard');
const tag = box('#tagcard');
tag.style.left = '60px'; tag.style.top = '200px'; tag.style.height = '90px';
out.tag = at('#tagcard');
// Backdrop click: the card goes (its own closer owns that click), the panel stays.
document.querySelector('#modal-backdrop').click();
out.panelAfterFirstClick = !document.querySelector('#modal-backdrop').classList.contains('hidden');
card.classList.add('hidden'); tag.classList.add('hidden');
document.querySelector('#modal-backdrop').click();
out.panelAfterSecondClick = document.querySelector('#modal-backdrop').classList.contains('hidden');
// The ✕ still closes the panel with a card up (it is not the backdrop path).
card.classList.remove('hidden');
document.querySelector('#modal-close').click();
out.closeButtonWorks = document.querySelector('#modal-backdrop').classList.contains('hidden');
document.title = JSON.stringify(out);
</script></body></html>`;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-card-layer-'));
try {
  const p = path.join(dir, 'page.html');
  fs.writeFileSync(p, pageHtml());
  const r = spawnSync(chromePath, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=900,700',
    '--virtual-time-budget=2000', '--dump-dom', 'file:///' + p.replace(/\\/g, '/')],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
  if (!m) { check(false, 'the layer harness ran', (r.stderr || '').slice(-300)); finish(); }
  const out = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  console.log('\n[3] the layers in a browser');
  check(out.panelOpen === true, 'the viewers panel is open', out);
  check(out.card.inside === true, 'with the dialog open, the centre of the card IS the card', out.card);
  check(Number(out.card.z) > Number(zOf(css, '#modal-backdrop')), 'because it is above the dialog layer', out.card.z);
  check(out.tag.inside === true, 'and the tag panel beats the card it opened from', out.tag);
  check(out.panelAfterFirstClick === true, 'a backdrop click dismisses the card, not the panel', out);
  check(out.panelAfterSecondClick === true, 'and the next one closes the panel', out);
  check(out.closeButtonWorks === true, 'the panel\'s own ✕ still works with a card up', out);
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
finish();

function finish() {
  console.log('\n' + (failures.length ? 'FAILED: ' + failures.length : 'OK') + ' — ' + passed + ' checks passed');
  if (failures.length) process.exit(1);
  process.exit(0);
}
