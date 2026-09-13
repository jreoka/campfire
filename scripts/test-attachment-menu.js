// The attachment rows live in the MESSAGE menu (see AGENTS.md verification
// conventions).
//
// The ask: media must not open a dedicated menu of its own any more. A message
// that carries attachments grows those rows — copy / save / link, and Harbin
// info — inside the menu the message already has, so one right-click or
// long-press on a message with media covers both. The two things that were easy
// to get wrong and are checked here:
//   - the rows must describe the RIGHT attachment (a message's own record, plus
//     the identity of the element under the pointer), and a message with several
//     files must say which file each row belongs to;
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
  'toast', 'copyTextNow', 'copyImageToClipboard', 'saveMediaFile', 'openMediaLink', 'harbinInfoItem',
  attSrc + '\nreturn { attFromEl, attItemsFor, attMenuItems, msgAttItems };'
);
const att = attBuild(SVG, SVG, SVG, SVG, () => {}, () => {}, () => {}, () => {}, () => {},
  (a) => (a && a.id ? { label: 'Harbin info', icon: SVG, fn: () => {} } : null));
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

console.log('\n[1] one attachment grows the message menu with its rows');
const one = seq(messageMenuItems(post([img('a1', 'cat.png')]), 'm1', 0, 0));
check(one.includes('Copy text') && one.includes('Mark unread') && one.includes('Bookmark message'),
  'the message actions are all still there', one);
for (const want of ['Copy image', 'Save image', 'Copy image link', 'Open image link', 'Harbin info']) {
  check(one.includes(want), 'and the picture adds ' + want, one);
}
check(one.indexOf('Copy text') < one.indexOf('Copy image') && one.indexOf('Open image link') < one.indexOf('Mark unread'),
  'the file rows sit between the content actions and the reader-memory rows', one);
check(!one.includes('[cat.png]'), 'a single attachment needs no heading — the labels are unambiguous', one);

console.log('\n[2] a message with no media is unchanged');
const none = seq(messageMenuItems(post([]), 'm1', 0, 0));
check(!none.some((l) => /Harbin|Save |Copy image|Copy link/.test(l)), 'no attachment rows at all', none);
check(none.length === one.length - 7, 'exactly the attachment\'s five rows and their two separators are missing', { none: none.length, one: one.length });

console.log('\n[3] several attachments name their own rows');
const two = seq(messageMenuItems(post([img('a1', 'cat.png'), img('a2', 'dog.png')]), 'm1', 0, 0));
check(two.includes('[cat.png]') && two.includes('[dog.png]'), 'each file gets its name as a heading', two);
check(two.indexOf('[cat.png]') < two.indexOf('[dog.png]'), 'in the order the message renders them', two);
const catAt = two.indexOf('[cat.png]'), dogAt = two.indexOf('[dog.png]');
check(two.slice(catAt, dogAt).filter((l) => l === 'Save image').length === 1
  && two.slice(dogAt).filter((l) => l === 'Save image').length === 1,
  'and each heading owns exactly one Save image row', two);

console.log('\n[4] the pointer\'s own attachment is honoured');
// The identity the element under the pointer carries (attFromEl), for a message
// whose record does not list it — a rendering stays actionable.
const el = { closest: (sel) => (sel === '[data-att-id]' ? {
  dataset: { attId: 'a9', fbUrl: '/uploads/files/hover.png', fbName: 'hover.png', fbKind: 'image', fbScan: 'clean' },
} : null) };
const withEl = seq(messageMenuItems(post([img('a1', 'cat.png')]), 'm1', 0, 0, el));
check(withEl.includes('[hover.png]'), 'an attachment only the element knows about still gets rows', withEl);
check(withEl.indexOf('[cat.png]') < withEl.indexOf('[hover.png]'), 'appended after the message\'s own record', withEl);
const sameEl = { closest: () => ({ dataset: { attId: 'a1', fbUrl: '/uploads/files/cat.png', fbName: 'cat.png', fbKind: 'image', fbScan: 'clean' } }) };
check(seq(messageMenuItems(post([img('a1', 'cat.png')]), 'm1', 0, 0, sameEl)).filter((l) => l === 'Save image').length === 1,
  'and never duplicates the attachment the message already lists');

console.log('\n[5] nothing that cannot work is offered');
const shapes = {
  video: { label: ['Save video', 'Copy video link', 'Open video link', 'Harbin info'] },
  audio: { label: ['Save audio', 'Copy link', 'Harbin info'] },
  file: { label: ['Save file', 'Copy link', 'Harbin info'] },
};
for (const [kind, want] of Object.entries(shapes)) {
  const got = labels(att.attItemsFor({ id: 'x', url: '/uploads/files/x', name: 'x', kind, scan: 'clean' }));
  check(JSON.stringify(got) === JSON.stringify(want.label), 'a ' + kind + ' gets its own save/link wording', got);
  check(got.includes('Harbin info'), 'and the scanner row', got);
}
const vid = labels(att.attItemsFor({ id: 'v', url: '/uploads/files/v.mp4', name: 'v.mp4', kind: 'video', scan: 'clean' }));
check(!vid.some((l) => /^Copy video$/.test(l)), 'a video never promises to put its bytes on the clipboard', vid);
for (const scan of ['infected', 'pending']) {
  const gone = labels(att.attItemsFor({ id: 'x', url: '/uploads/files/x', name: 'x', kind: 'image', scan }));
  check(JSON.stringify(gone) === JSON.stringify(['Harbin info']),
    'a ' + scan + ' file offers the explanation and nothing that would 404', gone);
}
check(labels(att.attItemsFor({ id: '', url: '/uploads/files/x', name: 'x', kind: 'file', scan: 'clean' })).length === 2,
  'an optimistic attachment with no id keeps save/link, minus the scanner row',
  labels(att.attItemsFor({ id: '', url: '', name: 'x', kind: 'file', scan: 'clean' })));
check(att.attItemsFor(null).length === 0, 'and no attachment is no rows');

console.log('\n[6] the message owns the click now, the attachment is the fallback');
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
  'the phone sheet builds the same merged menu, with the same element identity');

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
