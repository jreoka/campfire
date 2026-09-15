// The attachment rows live in the MESSAGE menu, scoped to the file the pointer
// is on (see AGENTS.md verification conventions).
//
// The ask: media must not open a dedicated menu of its own any more — a message
// that carries attachments grows their rows (copy / save / link, and Scan info)
// inside the menu the message already has, so one right-click or long-press on a
// message with media covers both. Then the correction: with several files the
// menu grew a section per attachment no matter where it was opened, so a post of
// five photos buried the message actions under five identical "Save image"
// blocks. The rows are now scoped by the POINTER — on a picture you get THAT
// file's rows, on the message's own pixels you get none — and a heading appears
// only when the message carries more than the one file being acted on, which is
// the case it was written for.
//
// The two things that were easy to get wrong and are checked here:
//   - the rows must describe the RIGHT attachment (the identity of the element
//     under the pointer, which is what the rows are built from), and the scope
//     must not leak a sibling's rows or drop the pointer's own;
//   - nothing that cannot work may be offered: a file whose bytes were removed
//     (infected) or are not published yet (pending) offers the explanation and
//     nothing that would 404.
//
// The real functions are sliced out of public/js/actions.js and driven directly
// — no browser, no database. Usage: node scripts/test-attachment-menu.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const actions = fs.readFileSync(path.join(ROOT, 'public/js/actions.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function slice(src, from, to) {
  const i = src.indexOf(from);
  if (i < 0) return '';
  const j = src.indexOf(to, i);
  return j < 0 ? '' : src.slice(i, j);
}

// ---- the attachment builders, out of the real module ----
const attSrc = slice(actions, 'function attFromEl(', 'function mediaSheetHead(');
if (!attSrc) { console.log('FAILED: could not slice the attachment builders out of actions.js'); process.exit(1); }

const SVG = '<svg></svg>';
const attBuild = new Function(
  'IMG_COPY_SVG', 'SAVE_SVG', 'LINK_SVG', 'OPEN_SVG',
  'toast', 'copyTextNow', 'copyImageToClipboard', 'saveMediaFile', 'openMediaLink', 'scanInfoItem',
  attSrc + '\nreturn { attFromEl, attItemsFor, attMenuItems, msgAttItems };'
);
const att = attBuild(SVG, SVG, SVG, SVG, () => {}, () => {}, () => {}, () => {}, () => {},
  (a) => (a && a.id ? { label: 'Scan info', icon: SVG, fn: () => {} } : null));
const labels = (items) => items.map((i) => i.label || ('[' + i.head + ']'));

// ---- the message menu itself, out of the real module ----
const msgSrc = slice(actions, 'function messageMenuItems(', '// Report composer:');
if (!msgSrc) { console.log('FAILED: could not slice messageMenuItems out of actions.js'); process.exit(1); }

const noop = () => {};
const S = { me: { id: 'me' }, pinIds: new Set(), gifFavs: [], bookmarkIds: new Set() };
const msgBuild = new Function(
  'S', 'openPicker', 'replyToMsg', 'openForward', 'gifFavOf', 'gifFavMatch', 'toggleGifFav', 'openThread',
  'openReactionsModal', 'togglePin', 'canMod', 'api', 'toast', 'msgAttItems', 'markMessageUnread',
  'toggleBookmark', 'openReminderModal', 'openReportModal',
  'PIN_SVG', 'RX_SVG', 'GIF_STAR_SVG', 'BOOKMARK_SVG', 'BOOKMARK_ON_SVG', 'UNREAD_SVG', 'CLOCK_SVG', 'REPORT_SVG',
  msgSrc + '\nreturn messageMenuItems;'
);
const messageMenuItems = msgBuild(
  S, noop, noop, noop, () => null, () => false, noop, noop,
  noop, noop, () => false, () => Promise.resolve(), noop, att.msgAttItems, noop,
  noop, noop, noop,
  SVG, SVG, SVG, SVG, SVG, SVG, SVG, SVG
);
const seq = (items) => items.map((i) => (i.sep ? '—' : i.head ? '[' + i.head + ']' : i.label));
const img = (id, name) => ({ id, url: '/uploads/files/' + name, name, kind: 'image', scan: 'clean' });
const post = (atts) => ({ id: 'm1', content: 'look', user: { id: 'someone' }, attachments: atts });
// The identity the element under the pointer carries — what the menu's scope is
// read from (attFromEl). `closest` answers for the selector attFromEl asks for
// and nothing else, exactly as the DOM would when the pointer is on the media.
const over = (id, name, kind) => ({
  closest: (sel) => (sel === '[data-att-id]'
    ? { dataset: { attId: id, fbUrl: '/uploads/files/' + name, fbName: name, fbKind: kind || 'image', fbScan: 'clean' } }
    : null),
});
const offMedia = { closest: () => null }; // the message's own pixels (text, padding)

console.log('\n[1] the pointer\'s attachment grows the message menu with its rows');
const one = seq(messageMenuItems(post([img('a1', 'cat.png')]), 'm1', 0, 0, over('a1', 'cat.png')));
check(one.includes('Copy text') && one.includes('Mark unread') && one.includes('Bookmark message'),
  'the message actions are all still there', one);
for (const want of ['Copy image', 'Save image', 'Copy image link', 'Open image link', 'Scan info']) {
  check(one.includes(want), 'and the picture under the pointer adds ' + want, one);
}
check(one.indexOf('Copy text') < one.indexOf('Copy image') && one.indexOf('Open image link') < one.indexOf('Mark unread'),
  'the file rows sit between the content actions and the reader-memory rows', one);
check(!one.includes('[cat.png]'), 'the only file in the message needs no heading — the labels are unambiguous', one);

console.log('\n[2] a press on the message itself carries no file rows at all');
const body = seq(messageMenuItems(post([img('a1', 'cat.png')]), 'm1', 0, 0, offMedia));
check(!body.some((l) => /Scan info|Save |Copy image|Copy link|Open image/.test(l)),
  'the message\'s own pixels grow no attachment rows', body);
check(body.length === one.length - 7,
  'exactly the attachment\'s five rows and their two separators are missing', { body: body.length, one: one.length });
check(body.includes('Copy text') && body.includes('Mark unread'), 'the message actions are untouched', body);
const none = seq(messageMenuItems(post([]), 'm1', 0, 0));
check(JSON.stringify(none) === JSON.stringify(body), 'and a message with no media reads the same way', none);

console.log('\n[3] with several files, only the one under the pointer is in the menu');
const two = seq(messageMenuItems(post([img('a1', 'cat.png'), img('a2', 'dog.png')]), 'm1', 0, 0, over('a2', 'dog.png')));
check(two.includes('[dog.png]'), 'the file under the pointer names its own rows', two);
check(!two.includes('[cat.png]'), 'and its sibling is not in the menu at all', two);
check(two.filter((l) => l === 'Save image').length === 1, 'exactly one Save image row, for the file pointed at', two);
const twoBody = seq(messageMenuItems(post([img('a1', 'cat.png'), img('a2', 'dog.png')]), 'm1', 0, 0, offMedia));
check(!twoBody.some((l) => /Save image|\[cat.png\]|\[dog.png\]/.test(l)),
  'a press on the message body of a five-photo post grows no sections', twoBody);
const first = seq(messageMenuItems(post([img('a1', 'cat.png'), img('a2', 'dog.png')]), 'm1', 0, 0, over('a1', 'cat.png')));
check(first.includes('[cat.png]') && !first.includes('[dog.png]'), 'and the other file scopes the other way', first);

console.log('\n[4] the heading is what tells this file from its siblings');
// A rendering the message's record does not list (an older payload, a rendering
// built from the identity alone): it stays actionable, and it still gets a name
// — the message is showing another file beside it.
const hovered = seq(messageMenuItems(post([img('a1', 'cat.png')]), 'm1', 0, 0, over('a9', 'hover.png')));
check(hovered.includes('[hover.png]'), 'an attachment only the element knows about still gets its rows', hovered);
check(hovered.filter((l) => l === 'Save image').length === 1 && !hovered.includes('[cat.png]'),
  'scoped to it alone — the record\'s own file is not dragged in', hovered);
const sameEl = over('a1', 'cat.png');
const same = seq(messageMenuItems(post([img('a1', 'cat.png')]), 'm1', 0, 0, sameEl));
check(same.filter((l) => l === 'Save image').length === 1 && !same.includes('[cat.png]'),
  'and the one file the message does list needs no heading', same);

console.log('\n[5] nothing that cannot work is offered');
const shapes = {
  video: { label: ['Save video', 'Copy video link', 'Open video link', 'Scan info'] },
  audio: { label: ['Save audio', 'Copy link', 'Scan info'] },
  file: { label: ['Save file', 'Copy link', 'Scan info'] },
};
for (const [kind, want] of Object.entries(shapes)) {
  const got = labels(att.attItemsFor({ id: 'x', url: '/uploads/files/x', name: 'x', kind, scan: 'clean' }));
  check(JSON.stringify(got) === JSON.stringify(want.label), 'a ' + kind + ' gets its own save/link wording', got);
  check(got.includes('Scan info'), 'and the scanner row', got);
}
const vid = labels(att.attItemsFor({ id: 'v', url: '/uploads/files/v.mp4', name: 'v.mp4', kind: 'video', scan: 'clean' }));
check(!vid.some((l) => /^Copy video$/.test(l)), 'a video never promises to put its bytes on the clipboard', vid);
for (const scan of ['infected', 'pending']) {
  const gone = labels(att.attItemsFor({ id: 'x', url: '/uploads/files/x', name: 'x', kind: 'image', scan }));
  check(JSON.stringify(gone) === JSON.stringify(['Scan info']),
    'a ' + scan + ' file offers the explanation and nothing that would 404', gone);
}
check(labels(att.attItemsFor({ id: '', url: '/uploads/files/x', name: 'x', kind: 'file', scan: 'clean' })).length === 2,
  'an optimistic attachment with no id keeps save/link, minus the scanner row',
  labels(att.attItemsFor({ id: '', url: '', name: 'x', kind: 'file', scan: 'clean' })));
check(att.attItemsFor(null).length === 0, 'and no attachment is no rows');

console.log('\n[6] the message owns the click, the attachment is the fallback, the pointer decides the scope');
const ctxSrc = slice(actions, 'function ctxFor(', 'document.addEventListener(\'contextmenu\'');
check(/const msg = el\.closest\('\.msg\[data-mid\]'\)/.test(ctxSrc), 'ctxFor looks for the message first');
check(ctxSrc.indexOf("el.closest('.msg[data-mid]')") < ctxSrc.indexOf('attMenuItems(el)'),
  'and only falls back to the attachment rows for media with no message around it', ctxSrc.slice(0, 400));
check(/messageCtxMenu\(msg\.dataset\.mid, x, y, el\)/.test(ctxSrc), 'handing the message menu the element the pointer is over');
const holdSrc = slice(actions, 'const touch = e.touches[0];', 'if (ctxFor(t, x, y)) holdMenu = true;');
check(/openMsgSheet\(mt\.dataset\.mid, t\)/.test(holdSrc), 'a long-press on a message with media opens the MESSAGE sheet');
check(holdSrc.indexOf('openMsgSheet(mt.dataset.mid, t)') < holdSrc.indexOf('openCtxSheet(att, mediaSheetHead(aw))'),
  'and the attachment-only sheet is only the no-message fallback', holdSrc.slice(0, 900));
check(/function openMsgSheet\(mid, el\)/.test(actions) && /messageMenuItems\(m, mid, 0, 0, el\)/.test(actions),
  'the phone sheet builds the same menu, with the same element identity');
// The rows are only behind the pointer now, so EVERY rendering of an attachment
// has to be holdable — including the plain file card, which is an `<a>` and used
// to be skipped by the link guard along with every ordinary link.
const touchGuard = slice(actions, "document.addEventListener('touchstart'", 'const t = e.target.closest(');
check(/a:not\(\[data-att-id\]\)/.test(touchGuard),
  'a long-press is only refused for links that are NOT an attachment (the file card is an <a>)', touchGuard);
check(/e\.target\.closest\('input, textarea, select, a:not\(\[data-att-id\]\)'\)/.test(touchGuard),
  'and the guard still covers fields and ordinary links', touchGuard);

console.log('\n[7] a heading is a caption, not a row');
check(/\.ctx-head\{[^}]*color:var\(--muted\)/.test(css), 'the heading is styled as muted chrome', (css.match(/\.ctx-head\{[^}]*\}/) || [''])[0]);
check(/\.sheet-rows \.ctx-head\{/.test(css), 'and the sheet gives it its own spacing');
for (const [fn, to] of [
  ['openCtx', 'const PIN_SVG'],
  ['openMsgSheet', '/* generic slide-up bottom sheet'],
  ['openCtxSheet', 'function folderSheetItems('],
]) {
  const body = slice(actions, 'function ' + fn + '(', to);
  check(!body || /if \(it\.head\) \{/.test(body), fn + ' renders the heading (as a div, never a button)', fn);
}

console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
