// Lightbox right-click menu (desktop).
//
// The ask: right-clicking the media viewer should offer the item's own
// attachment rows — Copy image, Save, Copy link, Open link, Scan info — the
// same rows a right-click on the message's tile offers, instead of the
// browser's native menu (or nothing).
//
// The two things that were easy to get wrong and are checked here:
//   - the rows must describe the RIGHT item: a right-click on a strip thumb
//     addresses that thumb's item, anywhere else the item on the stage;
//   - the viewer must own the gesture: ctxFor routes a #lightbox target to the
//     lightbox rows and never to the message menu behind it, while a
//     right-click on an ordinary message still reaches the message menu.
//
// The real functions are sliced out of public/js/pickers.js (lbItemAt,
// lbMenuItemsFor) and public/js/actions.js (attItemsFor, ctxFor) and driven
// directly — no browser, no database. Usage: node scripts/test-lightbox-menu.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
const actions = fs.readFileSync(path.join(ROOT, 'public/js/actions.js'), 'utf8');

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

const SVG = '<svg></svg>';
const absUrl = (u) => { try { return new URL(u, 'https://campfire.test').href; } catch { return String(u || ''); } };
// The real attItemsFor, with the same Scan-info stub test-attachment-menu.js uses.
const attItemsSrc = slice(actions, 'function attItemsFor(', 'function attMenuItems(');
if (!attItemsSrc) { console.log('FAILED: could not slice attItemsFor out of actions.js'); process.exit(1); }
const attItemsFor = new Function(
  'IMG_COPY_SVG', 'SAVE_SVG', 'LINK_SVG', 'OPEN_SVG', 'absUrl',
  'copyImageToClipboard', 'saveMediaFile', 'copyTextNow', 'toast', 'openMediaLink', 'scanInfoItem',
  attItemsSrc + '\nreturn attItemsFor;'
)(SVG, SVG, SVG, SVG, absUrl, () => {}, () => {}, () => {}, () => {}, () => {},
  (a) => (a && a.id ? { label: 'Scan info', icon: SVG, fn: () => {} } : null));

// The real lightbox menu builders, driven by a controllable lb state.
const lbSrc = slice(pickers, '// ---------- lightbox right-click ----------', '// Step one item.');
if (!lbSrc || !/function lbMenuItemsFor/.test(lbSrc)) { console.log('FAILED: could not slice the lightbox right-click block out of pickers.js'); process.exit(1); }
function driveLb(lbState, attFromElImpl) {
  return new Function('lb', 'attFromEl', 'attItemsFor', lbSrc + '\nreturn { lbItemAt, lbMenuItemsFor };')
    (lbState, attFromElImpl, attItemsFor);
}

// A fake element whose closest() answers the two selectors the code uses.
function fakeEl({ inLightbox = true, thumbIndex = null, msgMid = null } = {}) {
  return {
    dataset: {},
    closest(sel) {
      if (sel === '#lightbox') return inLightbox ? {} : null;
      if (sel === '.lb-thumb[data-lb-i]') return thumbIndex == null ? null : { dataset: { lbI: String(thumbIndex) } };
      if (sel === '.msg[data-mid]') return msgMid == null ? null : { dataset: { mid: msgMid } };
      return null;
    },
  };
}
const labels = (items) => items.map((i) => i.label || ('[' + i.head + ']'));
const lbState = (items, index) => ({ open: true, items, index: index || 0 });
const photo = (n) => ({ kind: 'image', src: '/uploads/files/photo' + n + '.png', name: 'photo' + n + '.png', el: { slot: n } });
const clip = (n) => ({ kind: 'video', src: '/uploads/files/clip' + n + '.mp4', name: 'clip' + n + '.mp4', el: { slot: n } });

// The identity the message's own rendering carries (id + scan verdict ride along).
const attFromEl = () => ({ id: 'att-1', url: '/uploads/files/photo1.png', name: 'photo1.png', kind: 'image', size: 42, scan: 'clean' });

// 1. Stage right-click → the item on the stage, with the message rendering's identity.
{
  const { lbMenuItemsFor } = driveLb(lbState([photo(1), photo(2)], 0), attFromEl);
  check(JSON.stringify(labels(lbMenuItemsFor(fakeEl()))) === JSON.stringify(['[photo1.png]', 'Copy image', 'Save image', 'Copy image link', 'Open image link', 'Scan info']),
    'stage right-click offers the current item\u2019s rows with its scan info', labels(lbMenuItemsFor(fakeEl())));
}
// 2. Strip-thumb right-click → THAT thumb's item, not the one on the stage.
{
  const items = [photo(1), photo(2)];
  const seen = [];
  const { lbMenuItemsFor } = driveLb(lbState(items, 0), (el) => { seen.push(el); return null; });
  const got = labels(lbMenuItemsFor(fakeEl({ thumbIndex: 1 })));
  check(JSON.stringify(got) === JSON.stringify(['[photo2.png]', 'Copy image', 'Save image', 'Copy image link', 'Open image link']),
    'strip-thumb right-click addresses the thumb\u2019s item', got);
  check(seen[0] === items[1].el || seen.length === 1, 'the thumb\u2019s slot is what identity is read from');
}
// 3. A clip on the stage gets the video rows and no Copy image.
{
  const { lbMenuItemsFor } = driveLb(lbState([photo(1), clip(2)], 1), () => null);
  const got = labels(lbMenuItemsFor(fakeEl()));
  check(JSON.stringify(got) === JSON.stringify(['[clip2.mp4]', 'Save video', 'Copy video link', 'Open video link']),
    'clip rows are the video set (no Copy image)', got);
}
// 4. Lightbox closed → no rows (the dispatcher falls through).
{
  const { lbMenuItemsFor } = driveLb({ open: false, items: [photo(1)], index: 0 }, attFromEl);
  check(lbMenuItemsFor(fakeEl()).length === 0, 'no menu rows when the viewer is closed');
}
// 5. An infected file offers the explanation, never the bytes.
{
  const { lbMenuItemsFor } = driveLb(lbState([photo(1)], 0),
    () => ({ id: 'att-9', url: '/uploads/files/bad.png', name: 'bad.png', kind: 'image', scan: 'infected' }));
  const got = labels(lbMenuItemsFor(fakeEl()));
  check(JSON.stringify(got) === JSON.stringify(['[bad.png]', 'Scan info']), 'infected item offers only Scan info', got);
}

// 6. ctxFor routes a #lightbox target to the lightbox rows, never the message menu.
const ctxSrc = slice(actions, 'function ctxFor(el, x, y) {', "document.addEventListener('contextmenu'");
if (!ctxSrc) { console.log('FAILED: could not slice ctxFor out of actions.js'); process.exit(1); }
{
  let opened = null;
  let messageMenuOpened = 0;
  const ctxFor = new Function(
    'messageCtxMenu', 'msgById', 'attMenuItems', 'openUserCard', 'memberCtxMenu',
    'serverCtxMenu', 'dmCtxMenu', 'channelCtxMenu', 'openCtx', 'lbMenuItemsFor',
    ctxSrc + '\nreturn ctxFor;'
  )(
    () => { messageMenuOpened++; }, () => null, () => null, () => {}, () => {}, () => {}, () => {}, () => {},
    (x, y, items) => { opened = { x, y, items }; },
    () => [{ head: 'photo1.png' }, { label: 'Save image' }]
  );
  const r = ctxFor(fakeEl(), 111, 222);
  check(r === true, 'ctxFor claims the lightbox target');
  check(opened && opened.x === 111 && opened.y === 222 && opened.items[1].label === 'Save image',
    'the lightbox rows open at the pointer');
  check(messageMenuOpened === 0, 'the message menu is not opened for a lightbox target');
}
// 7. Regression: an ordinary message still reaches its own menu.
{
  let messageMenuOpened = 0;
  let opened = null;
  const ctxFor = new Function(
    'messageCtxMenu', 'msgById', 'attMenuItems', 'openUserCard', 'memberCtxMenu',
    'serverCtxMenu', 'dmCtxMenu', 'channelCtxMenu', 'openCtx', 'lbMenuItemsFor',
    ctxSrc + '\nreturn ctxFor;'
  )(
    () => { messageMenuOpened++; }, () => ({ id: 'm1' }), () => null, () => {}, () => {}, () => {}, () => {}, () => {},
    (x, y, items) => { opened = items; }, () => { throw new Error('must not run'); }
  );
  const r = ctxFor(fakeEl({ inLightbox: false, msgMid: 'm1' }), 5, 5);
  check(r === true && messageMenuOpened === 1 && opened === null, 'message right-click still routes to the message menu');
}

if (failures.length) { console.log('\n' + failures.length + ' FAILED'); process.exit(1); }
console.log('\nall ' + passed + ' checks passed');
