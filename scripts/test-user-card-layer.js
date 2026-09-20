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
const final = fs.readFileSync(path.join(ROOT, 'public/js/final.js'), 'utf8');
const native = fs.readFileSync(path.join(ROOT, 'public/js/native.js'), 'utf8');
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
check(/async function openUserCard\(uid, x, y, fallback, opts = \{\}\)/.test(pickers) && /const u = memberById\(uid\) \|\| \(fallback && fallback\.id === uid \? fallback : null\);/.test(pickers),
  'openUserCard takes a fallback user, like openProfileScreen');
check(/openProfileScreen\(uid, u\)/.test(pickers), 'and the card\'s Profile tab carries it on');
check(/if \(memberEl\?\.dataset\.uid && !memberEl\.dataset\.ownclick\) \{ openMemberCard/.test(pickers),
  'a member row that owns its click is left alone by the delegate');
// The profile PAGE is the wholesale case: its backdrop wears the uid it is
// showing as a marker for refreshProfileGame, so without the opt-out the
// delegate read that marker as a person chip and opened the card of the person
// whose page was already open — from any click anywhere on the page.
check(/<div id="profile-backdrop" class="hidden" data-ownclick="1">/.test(index),
  'and the profile page opts its whole surface out of that delegate',
  /<div id="profile-backdrop"[^>]*>/.exec(index)?.[0]);
check(pickers.includes('bd.dataset.uid = uid'),
  'while still recording who it is showing, which is what that marker is for', 'openProfileScreen');
check(/row\.dataset\.ownclick = '1';\n    row\.onclick = \(e\) => \{ openUserCard\(u\.id, e\.clientX, e\.clientY, u\); \};/.test(stories.replace(/\r\n/g, '\n')),
  'the story viewers rows open the card at the tap with the viewer object', /row\.onclick = [^\n]*/.exec(stories));
check(/if \(floating\) return;\n  cancelModal\(\);/.test(ui.replace(/\r\n/g, '\n')) || /&& popoverOpen\(\)\) return;\n  cancelModal\(\);/.test(ui.replace(/\r\n/g, '\n')),
  'a backdrop click dismisses a floating card before the panel');
check(/function popoverOpen\(\) \{\n  return \['#usercard', '#tagcard'\]\.some/.test(ui.replace(/\r\n/g, '\n')), 'and it looks at both popovers');

console.log('\n[1b] a dialog opened FROM a popover is painted over it');
// The other direction of the same contract: a dialog whose parent is the card
// (your own "Set a status", the voice "Disconnect" confirm, the "Unfriend?"
// confirm) must beat the card. openModal decides it per open, from what is on
// screen, so the viewers-list case above — a card opened from INSIDE a dialog —
// keeps the static order. On a phone the card is a full-height sheet and the
// dialog at 160 was painted entirely behind it: "Set a status" looked dead.
const overZ = zOf(css, '#modal-backdrop.over-pop');
check(overZ !== null && overZ > cardZ && overZ > tagZ, 'the dialog that came from a card beats both popovers', { overZ, cardZ, tagZ });
check(overZ !== null && overZ < zOf(css, '#lightbox'), 'and still stays under the lightbox', { overZ, lightbox: zOf(css, '#lightbox') });
check(/#modal-backdrop\.over-pop\{z-index:175\}/.test(css), 'the rule is the one the contract names', /#modal-backdrop\.over-pop\{[^}]*\}/.exec(css)?.[0]);
check(/\$\('#modal-backdrop'\)\.classList\.toggle\('over-pop', popoverOpen\(\)\);/.test(ui),
  'openModal asks whether a popover is up as it opens');
check(/#modal-backdrop'\)\.classList\.contains\('over-pop'\) && popoverOpen\(\)\) return;/.test(ui),
  'and a backdrop click closes THAT dialog instead of being swallowed by the guard');
check(/function clickInOverPopDialog\(e\) \{[\s\S]{0,240}classList\.contains\('over-pop'\)[\s\S]{0,80}clickInPath\(e, \['#modal-backdrop'\]\)/.test(final),
  'the card\'s closer treats a click in that dialog as its own');
check(/!ucOpenedByThisClick\(\) && !clickInOverPopDialog\(e\)\) closeUserCard\(\);/.test(final),
  'so the card survives typing in the editor it opened');
check(/\{ name: 'modal-over-card', open: \(\) => cfShown\('#modal-backdrop'\) && \$\('#modal-backdrop'\)\.classList\.contains\('over-pop'\), close: \(\) => cancelModal\(\) \},/.test(native),
  'phone back closes that dialog first');
check(native.indexOf("name: 'modal-over-card'") < native.indexOf("name: 'usercard'"),
  'because it is the top of the stack, unlike the card-over-dialog order below');

console.log('\n[2b] the click that opens a card is not a click outside it');
// The card's closer is a document-level listener, so it runs after the opener
// in the same click — and with a warm friend list the card is already painted
// by then (ensureFriends() no-ops), which is what used to make the Active Now
// rail and a 1:1 DM's header name look dead. The opener stamps the click it was
// asked for and the closer checks it.
check(/const openClick = ucClickSeq;[^\n]*\n[^\n]*await ensureFriends\(\);/.test(pickers.replace(/\r\n/g, '\n')),
  'openUserCard reads this click\'s number before it awaits anything');
check(/card\.dataset\.openClick = String\(openClick\);/.test(pickers), 'and stamps it on the card it opens');
check(/let ucClickSeq = 0;\ndocument\.addEventListener\('click', \(\) => \{ ucClickSeq\+\+; \}, true\);/.test(pickers.replace(/\r\n/g, '\n')),
  'the counter is bumped in the capture phase, so an opener already sees this click');
check(/function ucOpenedByThisClick\(\) \{[\s\S]{0,220}dataset\.openClick === String\(ucClickSeq\)/.test(pickers),
  'and the predicate compares it with the card\'s own stamp');
check(/if \(!clickInPath\(e, \[[\s\S]*?\]\) && !ucOpenedByThisClick\(\) && !clickInOverPopDialog\(e\)\) closeUserCard\(\);/.test(final),
  'the card\'s closer consults it before closing', final.match(/if \(!clickInPath[^\n]*/)?.[0]);
check(/openUserCard\(uid, \(p && p\.width/.test(pickers) && /function openMemberCard\(uid, rowEl, y, opts = \{\}\)/.test(pickers),
  'the member-rail opener passes its options through (the phone shape travels with it)');
check(/openMemberCard\(c\.f\.id, el, undefined, \{ sheet: phoneLayout\(\) \}\)/.test(fs.readFileSync(path.join(ROOT, 'public/js/home.js'), 'utf8')),
  'and an Active Now rail row asks for the phone sheet');

const chromePath = findChrome();
if (!chromePath) {
  console.log('\n[3] the layers in a browser — SKIPPED (no Chrome/Edge found; set CHROME_PATH)');
  finish();
}

// Real modal markup + wiring, real stylesheet, the real layers stacked the way
// the viewers panel leaves them.
const modalMarkup = index.slice(index.indexOf('<div id="modal-backdrop"'), index.indexOf('<!-- create-story chooser'));
// The profile page's real markup and the delegate's real decision ([3c]).
const profileMarkup = index.slice(index.indexOf('<div id="profile-backdrop"'), index.indexOf('<!-- photo lightbox'));
const uidFnSrc = slice(pickers, 'function uidClickTarget(e) {', '\n// ---------- threads ----------');
const modalSrc = slice(ui, 'let modalOkFn = null;', '// Promise-based confirm dialog.');
// The card's real outside-click predicate + the over-pop stand-down, run
// verbatim against the card this page opens.
const closerSrc = slice(final, 'function clickInPath(e, sels) {', ' document.addEventListener');
function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<style>${css}</style></head><body>
${modalMarkup}
${profileMarkup}
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
${closerSrc}
window.closeUserCard = () => document.querySelector('#usercard').classList.add('hidden');
window.ucOpenedByThisClick = () => false; // no card here is opened by a click
// final.js's closer, with the layers this page has (the rest of that listener
// is other popovers).
document.addEventListener('click', (e) => {
  if (!clickInPath(e, ['#usercard', '#me-card', '[data-uid]', '.member', '.usertag[data-tag-sid]']) && !ucOpenedByThisClick() && !clickInOverPopDialog(e)) closeUserCard();
});
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
out.vh = innerHeight;
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
// The card is opened FIRST and the dialog FROM it (the real "Set a status"
// case). On a phone the card is the full-height sheet, so the dialog shares its
// pixels — which is exactly where the old 160 painted it behind the card.
card.classList.remove('hidden');
if (matchMedia('(max-width:700px)').matches) {
  // The real phone shape, geometry and all (openUserCard -> userCardAsSheet):
  // the sheet drops the popup's inline box and lets the CSS own it.
  card.classList.add('sheet');
  card.style.left = ''; card.style.top = ''; card.style.width = ''; card.style.height = '';
  out.cardRect = (() => { const r = card.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })();
} else {
  card.style.left = '0px'; card.style.top = '0px'; card.style.width = '100%'; card.style.height = '100%';
}
openModal('Custom status', '<label>Status<input id="m-status-text" value="hi" /></label>', 'Save', null);
out.phone = matchMedia('(max-width:700px)').matches;
out.overPop = document.querySelector('#modal-backdrop').classList.contains('over-pop');
const modalEl = document.querySelector('#modal-backdrop .modal');
const mr = modalEl.getBoundingClientRect();
const mHit = document.elementFromPoint(mr.left + mr.width / 2, mr.top + mr.height / 2);
out.dialogOverCard = !!(mHit && (mHit === modalEl || modalEl.contains(mHit)));
out.dialogZ = getComputedStyle(document.querySelector('#modal-backdrop')).zIndex;
// Typing in the editor must not shut the card underneath it.
document.querySelector('#m-status-text').click();
out.cardAfterDialogClick = !document.querySelector('#usercard').classList.contains('hidden');
// Tapping the backdrop closes the dialog and lands back on the card.
document.querySelector('#modal-backdrop').click();
out.dialogAfterBackdrop = document.querySelector('#modal-backdrop').classList.contains('hidden');
out.cardAfterBackdrop = !document.querySelector('#usercard').classList.contains('hidden');
// ...and the guard does not lock the card open: a click anywhere else still
// closes it.
document.body.click();
out.cardAfterOutsideClick = !document.querySelector('#usercard').classList.contains('hidden');
// [3c] The profile PAGE, clicked for real with the shipping decision function.
// openProfileScreen records the person it is showing on the backdrop (and it is
// the marker refreshProfileGame matches a live frame against), so a click
// anywhere on the page resolves up to that marker — which the delegate used to
// read as a person chip and answer by opening the card of the person whose page
// was already open.
${uidFnSrc}
const bd = box('#profile-backdrop');
bd.dataset.uid = 'u1'; // what openProfileScreen does on the way in
let seen = 'unset';
document.addEventListener('click', (e) => { seen = uidClickTarget(e); });
out.profileBodyUid = (document.querySelector('#pf-body').click(), seen);
out.profileCloseUid = (document.querySelector('#profile-close').click(), seen);
out.profileBackdropUid = (bd.click(), seen);
out.cardClickUid = (document.querySelector('#usercard').click(), seen);
const chip = document.createElement('div');
chip.dataset.uid = 'u9'; chip.textContent = 'chip';
document.body.appendChild(chip);
out.chipClickUid = (chip.click(), seen);
const own = document.createElement('div');
own.dataset.uid = 'u10'; own.dataset.ownclick = '1'; own.textContent = 'own';
document.body.appendChild(own);
out.ownClickUid = (own.click(), seen);
document.title = JSON.stringify(out);
</script></body></html>`;
}

// One Chrome pass. The same page is run twice: desktop-shaped and phone-shaped,
// because the report was a phone one — the card is a full-height sheet there,
// and the layering has to hold when the two surfaces are exactly the same box.
function runChrome(chromePath, dir, w, h) {
  const p = path.join(dir, `page-${w}x${h}.html`);
  fs.writeFileSync(p, pageHtml());
  const r = spawnSync(chromePath, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof-' + w), `--window-size=${w},${h}`,
    '--virtual-time-budget=2000', '--dump-dom', 'file:///' + p.replace(/\\/g, '/')],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
  if (!m) return null;
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-card-layer-'));
try {
  const desktop = runChrome(chromePath, dir, 900, 700);
  const phone = runChrome(chromePath, dir, 390, 760);
  if (!desktop || !phone) { check(false, 'the layer harness ran', 'no title from Chrome'); finish(); }
  for (const [label, out] of [['desktop', desktop], ['phone', phone]]) {
    console.log(`\n[3] the layers in a browser — ${label}`);
    check(out.panelOpen === true, 'the viewers panel is open', out);
    check(out.card.inside === true, 'with the dialog open, the centre of the card IS the card', out.card);
    check(Number(out.card.z) > Number(zOf(css, '#modal-backdrop')), 'because it is above the dialog layer', out.card.z);
    check(out.tag.inside === true, 'and the tag panel beats the card it opened from', out.tag);
    check(out.panelAfterFirstClick === true, 'a backdrop click dismisses the card, not the panel', out);
    check(out.panelAfterSecondClick === true, 'and the next one closes the panel', out);
    check(out.closeButtonWorks === true, 'the panel\'s own ✕ still works with a card up', out);
  }
  for (const [label, out] of [['desktop', desktop], ['phone', phone]]) {
    console.log(`\n[3b] a dialog opened from a card — ${label}`);
    check(out.overPop === true, 'openModal marks the dialog as one that came from a popover', out);
    check(out.dialogOverCard === true, 'so a card under it does not own the dialog\'s centre', out);
    check(Number(out.dialogZ) > Number(cardZ), 'because it is over the card', { dialogZ: out.dialogZ, cardZ });
    check(out.cardAfterDialogClick === true, 'and typing in the dialog does not shut the card it came from', out);
    check(out.dialogAfterBackdrop === true && out.cardAfterBackdrop === true, 'a backdrop click dismisses the dialog and leaves the card', out);
    check(out.cardAfterOutsideClick === false, 'while any other click still closes the card', out);
  }
  for (const [label, out] of [['desktop', desktop], ['phone', phone]]) {
    console.log(`\n[3c] the profile page and the card delegate — ${label}`);
    check(out.profileBodyUid === null, 'a click on the profile page opens NO card for the person it is showing', out.profileBodyUid);
    check(out.profileCloseUid === null && out.profileBackdropUid === null, 'nor does its Close button or the backdrop around it', { close: out.profileCloseUid, backdrop: out.profileBackdropUid });
    check(out.cardClickUid === null, 'a click inside the open card still does not rebuild it', out.cardClickUid);
    check(out.chipClickUid === 'u9', 'while an ordinary person chip still opens that person', out.chipClickUid);
    check(out.ownClickUid === null, 'and a row that owns its click is still left alone', out.ownClickUid);
  }
  // The phone pass is the reported one: the card really was the full-height
  // sheet the dialog used to hide behind.
  check(phone.phone === true, 'the phone pass is the phone layout', phone.phone);
  check(!!phone.cardRect && phone.cardRect.h >= phone.vh - 1, 'with the card as a full-height sheet under the dialog', { card: phone.cardRect, vh: phone.vh });
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
finish();

function finish() {
  console.log('\n' + (failures.length ? 'FAILED: ' + failures.length : 'OK') + ' — ' + passed + ' checks passed');
  if (failures.length) process.exit(1);
  process.exit(0);
}
