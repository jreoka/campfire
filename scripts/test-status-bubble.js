// Custom status as a thought bubble beside the avatar (see AGENTS.md).
//
// The complaint: the custom status lived in the card BODY as a tonal box with
// its own "Custom status" heading and Edit/Clear buttons, and everywhere else
// it was another body row. It is now a Discord-style thought bubble sitting
// next to the profile picture — set, read and cleared from right there.
//
// No bundler and no exports here, so this drives the REAL statusBubbleHTML()
// by extracting it from public/js/pickers.js and running it with stub globals.
//
// Offline (no database, no browser required).
//
// Usage: node scripts/test-status-bubble.js
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

const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}

// statusBubbleHTML leans on esc() and fmtCountdown().
global.S = { me: { id: 'me', username: 'jordan' } };
const code = slice(core, 'function esc(s) {', '// Layout size of a popup')
  + '\n' + slice(pickers, 'function fmtCountdown(ts) {', 'function wireStatusBubble(card) {');
// Strict mode gives eval its own scope, so hand the functions back explicitly.
const { esc, fmtCountdown, statusBubbleHTML } = eval(code + '\n;({ esc, fmtCountdown, statusBubbleHTML })');

const NOW = Date.now();
const other = (extra = {}) => ({ id: 'friend', username: 'sam', display_name: 'Sam', ...extra });
const me = (extra = {}) => ({ id: 'me', username: 'jordan', display_name: 'Jordan', ...extra });

console.log('\n[1] other people only get a bubble when they set something');
check(statusBubbleHTML(other()) === '', 'nothing set → no bubble at all');
check(statusBubbleHTML(other({ status_text: '   ' })) === '', 'whitespace-only status counts as unset');
const o = statusBubbleHTML(other({ status_text: 'Out camping this weekend' }));
check(o.includes('uc-bubble-wrap') && o.includes('uc-bubble-fit'), 'the bubble rides in the avatar row wrapper', o);
check(o.includes('<div class="uc-bubble">') && o.includes('Out camping this weekend'), 'a plain read-only bubble');
check(!o.includes('uc-bubble-x') && !o.includes('uc-status-edit'), 'no edit / clear affordances on someone else\'s card');
check(!o.includes('uc-bubble-exp'), 'their expiry is never rendered here');
check(!statusBubbleHTML(other({ status_text: 'hi', status_expires_at: NOW + 3600e3 })).includes('Clears'), 'expiry note is mine-only');

console.log('\n[2] my card always keeps the bubble, set or not');
const emptyMine = statusBubbleHTML(me());
check(emptyMine.includes('Set a status'), 'unset → a "Set a status" placeholder, not a body section', emptyMine);
check(emptyMine.includes('id="uc-status-edit"') && emptyMine.includes('empty'), 'the placeholder itself opens the editor');
check(!emptyMine.includes('uc-bubble-x'), 'nothing to clear while unset');

const setMine = statusBubbleHTML(me({ status_text: 'Heads down on the voice rewrite' }));
check(setMine.includes('Heads down on the voice rewrite'), 'my status text is in the bubble');
check(setMine.includes('id="uc-status-edit"') && !setMine.includes('empty'), 'the bubble is the editor affordance');
check(setMine.includes('id="uc-status-clear"'), 'and carries a clear button');

console.log('\n[3] the expiry note rides under the bubble');
const withExp = statusBubbleHTML(me({ status_text: 'Back later', status_expires_at: NOW + 3600e3 }));
check(withExp.includes('uc-bubble-exp') && withExp.includes('Clears ' + fmtCountdown(NOW + 3600e3)), 'future expiry → "Clears in 1h"', withExp);
check(!statusBubbleHTML(me({ status_text: 'Back later', status_expires_at: NOW - 1000 })).includes('uc-bubble-exp'), 'a lapsed expiry shows no note');
check(!statusBubbleHTML(me({ status_text: 'Back later' })).includes('uc-bubble-exp'), 'no expiry → no note');
check(fmtCountdown(NOW - 1) === 'soon', 'a lapsed timer reads "soon"');
check(/^in \d+m$/.test(fmtCountdown(Date.now() + 30 * 60e3)), 'minutes phrasing');
check(/^in \d+h$/.test(fmtCountdown(Date.now() + 3 * 3600e3)), 'hours phrasing');
check(/^in \d+d$/.test(fmtCountdown(Date.now() + 10 * 864e5)), 'days phrasing');

console.log('\n[4] status text is escaped, never markup');
const nasty = statusBubbleHTML(other({ status_text: '<img src=x onerror=alert(1)> & "quotes"' }));
check(!nasty.includes('<img') && nasty.includes('&lt;img'), 'angle brackets escaped');
check(nasty.includes('&amp;') && nasty.includes('&quot;'), 'ampersands and quotes escaped');
check(!statusBubbleHTML(me({ status_text: '<b>bold</b>' })).includes('<b>bold</b>'), 'mine is escaped too');

console.log('\n[5] the bubble lives in the avatar row, not the card body');
check(pickers.includes('<div class="uc-head"><span class="avatar big"></span>${statusBubbleHTML(u)}</div>'), 'card head renders the bubble beside the pfp');
check(!pickers.includes('statusEditHTML') && !pickers.includes('uc-statusbox'), 'the old body section is gone (no dead code)');
check(!/uid !== S\.me\.id && u\.status_text \? `<div class="uc-statustext">/.test(pickers), 'the old body status row is gone');
check(pickers.includes('wireStatusBubble(card)') && pickers.includes('refreshOwnStatusBubble()'), 'card wiring + in-place refresh are hooked up');
check(!pickers.includes('refreshOwnStatusBox('), 'no stale refresh call left behind');

console.log('');
if (failures.length) {
  console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log(`All ${passed} checks passed.`);
