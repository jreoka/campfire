// The channel-description popout is READ-ONLY, so it wears one ✕ in its corner
// instead of a footer pair (owner request: the "#general / General chat (duh)"
// panel showed a Cancel and a Close that both did exactly the same nothing).
//
// Static half (always runs): the ✕ exists in the real dialog markup with an
// aria-label (it is an icon, and UI chrome carries no emoji), openModal's
// `xClose` option is what reveals it, the description popout asks for it on BOTH
// call sites (a server channel's and a group chat's — one feature), and the
// stylesheet hides the footer and wins the cascade over `.mini`'s inline-flex.
//
// Chrome half (skips without Chrome): the real markup, the real stylesheet and
// the real ui.js/pins.js code, at desktop and phone widths. It clicks the topic
// line, measures that the panel has exactly ONE visible control and that it sits
// in the corner without touching the title, closes it, and then opens an
// ordinary dialog to prove the default Cancel/OK footer is still there.
//
// Usage: node scripts/test-topic-popout.js
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

const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'public/js/ui.js'), 'utf8');
const pins = fs.readFileSync(path.join(ROOT, 'public/js/pins.js'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const n = (s) => s.replace(/\r\n/g, '\n');
const rule = (sel) => (new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}').exec(css) || [])[1] || '';

console.log('\n[1] the dialog carries one corner ✕, not a footer pair');
const modalMarkup = index.slice(index.indexOf('<div id="modal-backdrop"'), index.indexOf('<!-- create-story chooser'));
const xTag = /<button type="button" id="modal-x"[^>]*>([\s\S]*?)<\/button>/.exec(modalMarkup);
check(!!xTag, 'the modal markup has a #modal-x button');
check(!!xTag && /aria-label="Close"/.test(xTag[0]) && /title="Close"/.test(xTag[0]),
  'it is labelled for what it does (an icon button, not a pill)');
check(!!xTag && /<svg[\s\S]*M6 6l12 12M18 6L6 18/.test(xTag[1]), 'and it draws a ✕ as an SVG (no emoji in chrome)');
check(!!xTag && xTag[1].replace(/<[^>]*>/g, '').trim() === '', 'carrying no text at all', xTag && xTag[1]);
check(modalMarkup.indexOf('id="modal-x"') > -1 && modalMarkup.indexOf('id="modal-x"') < modalMarkup.indexOf('id="modal-title"'),
  'the ✕ comes before the title, so it is the panel\'s own corner control');
check(/<button type="button" id="modal-x" class="mini modal-x"/.test(index), 'it wears the shared square close-button shape (.mini)');

console.log('\n[2] openModal is what reveals it');
check(/\.classList\.toggle\('x-only', !!opts\.xClose\)/.test(n(ui)), 'openModal stamps .x-only from opts.xClose');
check(/\$\('#modal-x'\)\.onclick = \(\) => cancelModal\(\);/.test(ui), 'and the ✕ is wired to the same closer as Cancel');
check(/\$\('#modal-close'\)\.textContent = opts\.cancelLabel \|\| 'Cancel';/.test(ui), 'the ordinary footer is untouched');

console.log('\n[3] the description popout asks for it — both surfaces');
// renderTopic + the topic line's click handler, run verbatim in the browser pass.
const topicBlock = n(pins).slice(n(pins).indexOf('function renderTopic() {'), n(pins).indexOf('async function selectDmThread'));
check((topicBlock.match(/\{ xClose: true \}/g) || []).length === 2, 'both the channel and the group-chat call site pass xClose', topicBlock.match(/openModal\([^\n]*/g));
check(!/'Close'/.test(topicBlock), 'neither offers a Close button any more', (topicBlock.match(/'Close'/g) || []).length);
check(/openModal\(`#\$\{ch\.name\}`/.test(topicBlock) && /openModal\(t\.name \|\| 'Group chat'/.test(topicBlock),
  'and they are still the two description panels (a channel\'s and a group chat\'s)');

console.log('\n[4] the stylesheet does what the markup expects');
check(/position:relative/.test(rule('.modal')), '.modal is a positioning context for the corner ✕');
check(/display:none/.test(rule('.modal-x')), 'the ✕ is hidden by default (every other dialog keeps its footer)', rule('.modal-x'));
check(/display:inline-flex/.test(rule('.modal.x-only .modal-x')), 'and shown only on a read-only popout', rule('.modal.x-only .modal-x'));
check(/display:none/.test(rule('.modal.x-only .row.end')), 'whose footer row is gone entirely', rule('.modal.x-only .row.end'));
check(/padding-right/.test(rule('.modal.x-only h3')), 'with the title kept clear of the ✕', rule('.modal.x-only h3'));
// The cascade is the whole reason those rules live in the modal block: .mini is
// inline-flex, so a display:none earlier in the sheet would simply lose.
check(css.indexOf('.modal-x{') > css.indexOf('.mini{'), 'the ✕ rules come after .mini, so display:none actually wins',
  { mini: css.indexOf('.mini{'), x: css.indexOf('.modal-x{') });
// 30x30 with a .6rem inset, so 2.1rem of title padding clears it.
const xRule = rule('.modal-x');
check(/width:30px/.test(xRule) && /height:30px/.test(xRule) && /top:\.6rem/.test(xRule) && /right:\.6rem/.test(xRule),
  'the ✕ is the 30×30 box the other close buttons use, inset .6rem', xRule);
check(/padding-right:2\.1rem/.test(rule('.modal.x-only h3')), 'and the title pays for the ✕ in padding', rule('.modal.x-only h3'));
// Why 2.1rem: the ✕ is 30px wide, inset .6rem (9.6px) from the panel's edge, and
// the content box already stops 1.5rem (24px) short of it — so the ✕ reaches
// 30 + 9.6 − 24 = 15.6px into the content box. 2.1rem = 33.6px clears that with
// ~18px to spare at a 16px root (the browser pass measures a wrapping title).
check(/padding-right:2\.1rem/.test(rule('.modal.x-only h3')) && 2.1 * 16 - (30 + 9.6 - 24) >= 8,
  'which is ≥ the 15.6px the ✕ reaches into the content box', { padding: 2.1 * 16, bite: 30 + 9.6 - 24 });
// The ✕ wears .mini for its 30×30 shape, and the coarse-pointer tap-target
// rule gives every .mini position:relative for its ::after hit box. That rule
// comes later in the sheet than .modal-x's absolute placement, so without a
// carve-out the ✕ falls into flow above the title on touch devices (owner
// screenshot, 2026-09-24: the ✕ sat top-left, clipping the title). Walk every
// rule after .modal-x's own and flag one that would turn it relative again.
const laterCss = css.slice(css.indexOf('.modal-x{')).replace(/\/\*[\s\S]*?\*\//g, '');
const relapses = [];
for (const m of laterCss.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
  if (!/position\s*:\s*relative/.test(m[2])) continue;
  const hooks = m[1].match(/\.[A-Za-z0-9_-]+/g) || [];
  if (hooks.some((h) => h === '.mini' || h === '.modal-x') && !/:not\(\.modal-x\)/.test(m[1]))
    relapses.push(m[1].trim().split('\n').pop());
}
check(relapses.length === 0, 'no later rule turns the corner ✕ relative again', relapses);

const chromePath = findChrome();
if (!chromePath) {
  console.log('\n[5] the popout in a browser — SKIPPED (no Chrome/Edge found; set CHROME_PATH)');
  finish();
}

const modalSrc = n(ui).slice(n(ui).indexOf('let modalOkFn = null;'), n(ui).indexOf('// Promise-based confirm dialog.'));
const topicSrc = topicBlock;
function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><title></title>
<style>${css}</style></head><body>
<div class="chat-head"><span id="chan-topic" class="hidden"></span></div>
${modalMarkup}
<script>
window.$ = (s) => document.querySelector(s);
window.toast = () => {};
window.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
window.S = { view: 'server', channelId: 'c1', dms: [], serverDetail: { channels: [{ id: 'c1', name: 'general', description: 'General chat (duh)' }] } };
${modalSrc}
${topicSrc}
const out = {};
out.vw = innerWidth;
// Visible means "on screen", not "its own display says so": a button inside the
// hidden footer still reports display:inline-block, so the question is asked of
// the client rects, which are empty the moment any ancestor is display:none.
const shown = (sel) => { const el = document.querySelector(sel); return !!(el && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length); };
const visibleBtns = () => [...document.querySelectorAll('#modal-backdrop button')].filter((b) => b.getClientRects().length).map((b) => b.id);
const rect = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
// The title's TEXT box (a Range), not its block box — an h3 spans the panel
// whatever it says, so a block-box comparison would always "overlap" the ✕.
const textRect = (sel) => {
  const rng = document.createRange(); rng.selectNodeContents(document.querySelector(sel));
  const r = rng.getBoundingClientRect();
  return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) };
};
// The topic line renders the description, then a tap opens the popout.
renderTopic();
out.topicText = document.querySelector('#chan-topic').textContent;
document.querySelector('#chan-topic').click();
out.backdropOpen = !document.querySelector('#modal-backdrop').classList.contains('hidden');
const panel = document.querySelector('#modal-backdrop .modal');
out.xOnly = panel.classList.contains('x-only');
out.title = document.querySelector('#modal-title').textContent;
out.body = document.querySelector('#modal-body').textContent;
out.footerHidden = !shown('#modal-backdrop .row.end');
out.xShown = shown('#modal-x');
out.footerButtons = visibleBtns().filter((id) => id === 'modal-close' || id === 'modal-ok');
out.visibleButtons = visibleBtns();
out.xText = document.querySelector('#modal-x').textContent.trim();
const p = rect('#modal-backdrop .modal'), x = rect('#modal-x');
out.panel = p; out.x = x;
// The corner: right half, top half of the panel, and its far edge inset from it.
out.inCorner = x.l > p.l + p.w / 2 && x.t < p.t + p.h / 2 && x.r <= p.r && x.t >= p.t;
// The text never runs under the ✕ — measured on the SHORT title here and on a
// title long enough to wrap below, which is the case the padding exists for.
const t1 = textRect('#modal-title');
out.titleClear = t1.r <= x.l || t1.b <= x.t || t1.l >= x.r || t1.t >= x.b;
out.shortTitle = { title: out.title, ...t1 };
// One way out, and it works.
document.querySelector('#modal-x').click();
out.closedByX = document.querySelector('#modal-backdrop').classList.contains('hidden');
// A title long enough to wrap into the ✕'s row: the padding has to hold it off.
S.serverDetail.channels[0].name = 'a-very-long-channel-name-that-wraps-the-popout-title';
renderTopic();
document.querySelector('#chan-topic').click();
const longTitle = document.querySelector('#modal-title').textContent;
const lt = textRect('#modal-title'), lx = rect('#modal-x');
out.longTitle = { title: longTitle, ...lt };
out.longTitleClear = lt.r <= lx.l || lt.b <= lx.t;
document.querySelector('#modal-x').click();
S.serverDetail.channels[0].name = 'general';
renderTopic();
// ...and an ordinary dialog is untouched: footer back, ✕ gone.
document.querySelector('#chan-topic').click();
out.reopenXOnly = document.querySelector('#modal-backdrop .modal').classList.contains('x-only');
openModal('Delete folder?', '<p class="muted">gone</p>', 'Delete', null, { danger: true });
out.normalXOnly = document.querySelector('#modal-backdrop .modal').classList.contains('x-only');
out.normalFooterHidden = !shown('#modal-backdrop .row.end');
out.normalButtons = visibleBtns();
out.normalOk = document.querySelector('#modal-ok').textContent;
out.normalX = shown('#modal-x');
document.querySelector('#modal-close').click();
out.normalClosedByCancel = document.querySelector('#modal-backdrop').classList.contains('hidden');
// ...and the ✕ is not left behind on the next read-only open either.
document.querySelector('#chan-topic').click();
openModal('Servers', '<p>x</p>', 'Close', null, { wide: true });
out.afterXOnlyNormal = shown('#modal-x');
document.title = JSON.stringify(out);
</script></body></html>`;
}

// Desktop Chrome on this machine will not open a 390px window (its own minimum
// is ~500px, which is how a "390" pass silently measured a 504px one), so the
// phone pass is a 390px IFRAME: media queries inside a frame resolve against the
// frame's box, so it is a real phone viewport. Reading the frame's title back
// needs --allow-file-access-from-files (same trick as test-admin-page.js).
function frameHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title></title></head><body style="margin:0">
<iframe id="f" src="page.html" style="width:390px;height:700px;border:0;display:block"></iframe>
<script>
const iv = setInterval(() => {
  try {
    const t = document.getElementById('f').contentDocument.title;
    if (t && t.trim()) { document.title = t; clearInterval(iv); }
  } catch (e) { document.title = JSON.stringify({ err: 'frame unreadable: ' + e }); clearInterval(iv); }
}, 40);
</script></body></html>`;
}

// One Chrome pass. `frame` runs the page inside a 390px iframe; otherwise the
// page IS the window.
function runChrome(chromePath, dir, w, h, frame) {
  fs.writeFileSync(path.join(dir, 'page.html'), pageHtml());
  const main = frame ? 'frame.html' : 'page.html';
  if (frame) fs.writeFileSync(path.join(dir, 'frame.html'), frameHtml());
  const r = spawnSync(chromePath, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--allow-file-access-from-files', '--user-data-dir=' + path.join(dir, 'prof-' + (frame ? 'f' : w)),
    `--window-size=${w},${h}`, '--virtual-time-budget=3000', '--dump-dom', 'file:///' + path.join(dir, main).replace(/\\/g, '/')],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
  if (!m) return null;
  try {
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  } catch { return null; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-topic-popout-'));
try {
  const desktop = runChrome(chromePath, dir, 1280, 800, false);
  const phone = runChrome(chromePath, dir, 900, 800, true); // the page is the 390px frame
  if (!desktop || !phone || phone.err) { check(false, 'the popout harness ran', { desktop, phone }); finish(); }
  check(desktop.vw >= 1200, 'the desktop pass is a desktop viewport', desktop.vw);
  check(phone.vw === 390, 'the phone pass really is 390px wide', phone.vw);
  for (const [label, out] of [['desktop', desktop], ['phone', phone]]) {
    console.log(`\n[5] the description popout — ${label}`);
    check(out.topicText === 'General chat (duh)', 'the topic line renders the description', out.topicText);
    check(out.backdropOpen === true, 'tapping it opens the popout', out);
    check(out.xOnly === true, 'which is the read-only shape', out.xOnly);
    check(out.title === '#general' && out.body === 'General chat (duh)', 'showing the channel and its description', out);
    check(out.footerHidden === true && out.footerButtons.length === 0, 'with no Cancel and no Close', { hidden: out.footerHidden, buttons: out.footerButtons });
    check(out.visibleButtons.length === 1 && out.visibleButtons[0] === 'modal-x', 'exactly one control in the whole panel — the ✕', out.visibleButtons);
    check(out.xText === '', 'and it carries no text', out.xText);
    check(out.inCorner === true, 'the ✕ sits in the panel\'s corner', { panel: out.panel, x: out.x });
    check(out.titleClear === true, 'and the title never runs under it', out.shortTitle);
    check(out.longTitleClear === true, 'even a title long enough to wrap stays clear of it', out.longTitle);
    check(out.closedByX === true, 'the ✕ is the way out, and it works', out);
    check(out.reopenXOnly === true, 'reopening the topic is read-only again', out);
    check(out.normalXOnly === false && out.normalFooterHidden === false && out.normalX === false,
      'an ordinary dialog is untouched — footer back, corner ✕ gone', { xOnly: out.normalXOnly, hidden: out.normalFooterHidden, x: out.normalX });
    check(out.normalButtons.join(',') === 'modal-close,modal-ok' && out.normalOk === 'Delete',
      'with its real Cancel/OK pair', { buttons: out.normalButtons, ok: out.normalOk });
    check(out.normalClosedByCancel === true, 'still closable the ordinary way', out);
    check(out.afterXOnlyNormal === false, 'and the read-only shape never leaks into the next dialog', out.afterXOnlyNormal);
  }
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
finish();

function finish() {
  console.log('\n' + (failures.length ? 'FAILED: ' + failures.length : 'OK') + ' — ' + passed + ' checks passed');
  if (failures.length) process.exit(1);
  process.exit(0);
}
