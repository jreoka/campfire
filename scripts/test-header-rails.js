// The chat header's rail order (offline — reads the shipped source, no browser).
//
// The header's right-hand icons are two kinds of control, and they used to be
// interleaved in the order they happened to be written: `search, [a DM's
// voice/video calls], inbox, [a server's Active threads], pins, members`. The
// result was that a familiar control MOVED when the conversation changed —
// pins sat to the right of the threads button in a server and to the right of
// nothing (but left of the inbox) in a DM — which is exactly what a rail must
// never do.
//
// The owner's rule, and the layout now: the controls that never change with the
// view sit at the RIGHT edge in one order, reading left to right —
//
//     search, pins, inbox, members
//
// (so right to left: hide/show members, inbox, pinned, search) — and the ones
// that come and go with the conversation (a 1:1 DM's voice/video call buttons, a
// server's Active threads) sit to their LEFT. The phone's ⋯ overflow is last.
//
// Three surfaces have to agree on that order, and this test is what keeps them
// agreeing:
//   [1] index.html   — the header markup itself (the rail order),
//   [2] js/ui.js     — the ⋯ sheet's rows (the phone's copy of the same rail),
//   [3] styles.css   — the phone block's hide list (the rails it hands over),
// plus the invariants that make the order meaningful: nothing re-orders a rail
// with CSS `order:` (which would silently beat the markup), and the fixed rails
// are the ones that need no view to be live.
//
// This test is the OFFLINE half, on purpose — the order is a source contract, so
// it runs with no browser and no server. The rendered half (read back off the
// pixels at desktop width, which is what catches a row-reverse container or a
// `order:` this file could not see) lives in scripts/test-mobile-landscape.js
// [6], where the real header is already on screen.
//
// Usage: node scripts/test-header-rails.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}

const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'public/js/ui.js'), 'utf8');
const pins = fs.readFileSync(path.join(ROOT, 'public/js/pins.js'), 'utf8');
const voice = fs.readFileSync(path.join(ROOT, 'public/js/voice.js'), 'utf8');
const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

// The fixed rails need no view to be live; pins is the one that waits for a
// conversation to exist (see [4]).
const FIXED = ['#btn-find', '#btn-pins', '#btn-notifs', '#btn-members'];
const FIXED_AT_BOOT = ['#btn-find', '#btn-notifs', '#btn-members'];
const VARYING = ['#btn-call-voice', '#btn-call-video', '#btn-threads'];
const RAIL_ORDER = [...VARYING, ...FIXED];
// The rails a phone hands to the ⋯ sheet: the calls stay in the header there,
// so only the threads rail represents the varying kind in the sheet and the
// hide list. Both read varying-first, then the fixed four.
const SHEET_ORDER = ['#btn-threads', ...FIXED];

// ---------- [1] the header markup ----------
// Every icon button in the header, in document order. The parse starts at the
// spacer, so ☰/#channel/name/topic (the left half) can never be mistaken for a
// rail.
const headerHtml = (index.match(/<header id="chat-header">[\s\S]*?<\/header>/) || [''])[0];
const afterSpacer = headerHtml.slice(headerHtml.indexOf('class="spacer"'));
const railIds = [...afterSpacer.matchAll(/id="(btn-[^"]+)"/g)].map((m) => '#' + m[1]);
const attrs = (id) => (afterSpacer.match(new RegExp(`<button id="${id.slice(1)}"[^>]*>`)) || [''])[0];

console.log('[1] index.html: the rails, in one order');
check(railIds.length > 0, 'the header has rail buttons to check', railIds);
check(JSON.stringify(railIds) === JSON.stringify([...RAIL_ORDER, '#btn-chat-more']),
  'varying rails first, then the fixed ones (search, pins, inbox, members), then ⋯', railIds);
check(railIds[railIds.length - 1] === '#btn-chat-more',
  'the phone\'s ⋯ overflow is the rightmost button (where styles.css left it)');
check(railIds.indexOf('#btn-members') > railIds.indexOf('#btn-notifs')
  && railIds.indexOf('#btn-notifs') > railIds.indexOf('#btn-pins')
  && railIds.indexOf('#btn-pins') > railIds.indexOf('#btn-find'),
  'read right to left it is members → inbox → pins → search, as asked');
check(VARYING.every((id) => railIds.indexOf(id) < railIds.indexOf('#btn-find')),
  'every rail that varies with the view sits to the LEFT of the fixed block');
check(VARYING.every((id) => railIds.indexOf(id) >= 0) && railIds.length === RAIL_ORDER.length + 1,
  'the rail set is exactly these seven controls + ⋯ (nothing renamed or dropped)', railIds);
check(VARYING.every((id) => /class="[^"]*\bhidden\b/.test(attrs(id))),
  'the varying rails wait for their view — they start hidden in the markup', VARYING.map(attrs));
check(FIXED_AT_BOOT.every((id) => !/\bhidden\b/.test(attrs(id))),
  'and the fixed rails that need nothing to be live start visible', FIXED_AT_BOOT.map(attrs));

// ---------- [2] the ⋯ sheet ----------
console.log('\n[2] ui.js: the phone\'s ⋯ sheet reads in the header\'s order');
const defsBlock = (ui.match(/const defs = \[[\s\S]*?\];/) || [''])[0];
const sheetIds = [...defsBlock.matchAll(/'#(btn-[^']+)'/g)].map((m) => '#' + m[1]);
check(JSON.stringify(sheetIds) === JSON.stringify(SHEET_ORDER),
  'the sheet lists the varying rail first, then the fixed four — the header order', sheetIds);
check(/for \(const \[sel, label\] of defs\)/.test(ui) && /items\.push\(\{ label:/.test(ui),
  'and it is painted in that array order (one row per rail, in a loop)');
check(sheetIds.length === SHEET_ORDER.length && new Set(sheetIds).size === sheetIds.length,
  'with exactly one row per rail, no duplicates');

// ---------- [3] the phone block ----------
console.log('\n[3] styles.css: the phone block hands over those rails');
// The rail block is the one that hands over the members button (the file has a
// dozen phone blocks; only this one is the header's).
const phoneBlock = [...css.matchAll(/@media \(max-width:700px\),\(max-height:560px\) and \(pointer:coarse\)\{([\s\S]*?)\n\}/g)]
  .map((m) => m[1]).find((b) => /#btn-members\{display:none\}/.test(b)) || '';
const hideList = (phoneBlock.match(/(#btn-[^{]*)\{display:none\}/) || ['', ''])[1];
const hidden = [...hideList.matchAll(/#(btn-[a-z-]+)/g)].map((m) => '#' + m[1]);
check(JSON.stringify(hidden) === JSON.stringify(SHEET_ORDER),
  'the five rails leave the phone header in the rail\'s own order', hidden);
check(!hidden.includes('#btn-call-voice') && !hidden.includes('#btn-call-video'),
  'a DM\'s call buttons stay on top on a phone');
check(/#btn-chat-more\{display:inline-flex\}/.test(phoneBlock),
  'and ⋯ stands in for them there');
// A rail hidden on a phone but missing from `defs` is a control no phone can
// reach; a rail in `defs` that is not hidden is a row for a button already there.
check(JSON.stringify([...hidden].sort()) === JSON.stringify([...sheetIds].sort()),
  'the rails hidden on a phone are exactly the rails the sheet offers');

// ---------- [4] the invariants behind the order ----------
console.log('\n[4] the order is the markup\'s, and the two kinds really are two kinds');
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
const reordered = [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((m) => RAIL_ORDER.some((id) => m[1].includes(id)) && /\border\s*:/.test(m[2]))
  .map((m) => m[1].trim().replace(/\s+/g, ' '));
check(reordered.length === 0,
  'no rail button carries a CSS `order:` (that would beat the markup silently)', reordered);
// Pins is a fixed rail that waits for a CONVERSATION, never for a view: it is the
// one fixed button whose own visibility is written outside the header's markup.
check(/btn\.classList\.toggle\('hidden', !ctx\)/.test(pins),
  'pins is gated on there being a conversation (pins.js), not on the view');
check(/const show = S\.view === 'home' && !!S\.dmThreadId;/.test(voice)
  && /for \(const id of \['#btn-call-voice', '#btn-call-video'\]\)/.test(voice),
  'the call buttons are the varying pair (a 1:1 DM, voice.js)');
check(/b\.classList\.toggle\('hidden', !\(S\.view === 'server' && !!S\.serverId\)\)/.test(pickers),
  'and Active threads is the varying one on the server side (pickers.js)');
// The sheet's own membership rule (Home's feed has no members drawer) has to stay
// keyed to the button, not to a position in the list.
check(/if \(sel === '#btn-members' && homeFeed\) continue;/.test(ui),
  'the sheet\'s one special case is still keyed to the members rail');

console.log('');
if (failures.length) {
  console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log(`All ${passed} checks passed.`);
