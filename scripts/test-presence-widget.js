// Presence switcher on your own user card (see AGENTS.md).
//
// The change: the online/away/DND/invisible quickswitch used to be a floating
// menu hanging off your avatar, then a 2×2 grid of chips on the card. It is now
// a vertical menu in Discord's shape — it starts as just your current status,
// opening it cascades the states (each with a chevron), and picking one cascades
// that state's timer underneath it. The collapsed row doubles as the card's
// status readout, and the avatar-menu code is gone so the avatar can just open
// the card like every other avatar does.
//
// No bundler and no exports here, so this drives the REAL presenceWidgetHTML(),
// choosePresence() and wirePresenceWidget() by extracting them from
// public/js/pickers.js and running them against stub globals.
//
// Offline (no database, no browser required).
//
// Usage: node scripts/test-presence-widget.js
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
const finalSrc = fs.readFileSync(path.join(ROOT, 'public/js/final.js'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}

// ---- stub globals the helpers lean on -------------------------------------
global.S = { me: { id: 'me', status: 'online' } };
global.statusOf = (id) => (id === 'me' ? (S.me.status || 'online') : (S.online?.[id] || 'offline'));
global.isOff = (st) => st === 'offline' || st === 'invisible';
global.dotOf = (st, streaming) => (streaming && !isOff(st) ? 'streaming' : (st === 'invisible' ? 'offline' : st));
global.presenceExpiry = () => { const ts = +((S.me || {}).presence_expires_at || 0); return ts > Date.now() ? ts : 0; };
let statusCalls = [];
global.setStatus = async (s, exp) => {
  statusCalls.push([s, exp]);
  S.me = { ...S.me, status: s, presence_expires_at: s === 'online' ? null : (exp ?? null) };
};
global.$ = () => null;

// statusLineHTML + the switcher live between wireStatusBubble and clearMyStatus.
const code = slice(core, 'function esc(s) {', '// Layout size of a popup')
  + '\n' + slice(pickers, 'function fmtCountdown(ts) {', 'async function clearMyStatus() {');
// Strict mode gives eval its own scope, so hand the functions back explicitly.
const {
  fmtCountdown, statusLineHTML, presenceWidgetHTML, presenceDurationSel, choosePresence, wirePresenceWidget, presenceMenu,
} = eval(code + '\n;({ fmtCountdown, statusLineHTML, presenceWidgetHTML, presenceDurationSel, choosePresence, wirePresenceWidget, presenceMenu })');

const setMe = (status, exp) => { S.me = { id: 'me', username: 'jordan', status, presence_expires_at: exp || null }; };
const setMenu = (open, cascade) => { presenceMenu.open = open; presenceMenu.cascade = cascade; };

async function main() {
  console.log('\n[1] the menu replaces the status readout on my own card');
  check(/\$\{uid === S\.me\.id\n\s*\? presenceWidgetHTML\(\)\n\s*: `<div class="uc-status" id="uc-statusline">\$\{statusLineHTML\(uid, u\)\}<\/div>`\}/.test(pickers), 'the card shows the menu for me and the plain readout for everyone else');
  check(/if \(uid === S\.me\.id\) presenceMenu = \{ open: false, cascade: null \};/.test(pickers), 'opening the card resets it to just your current status');
  check(pickers.includes('wirePresenceWidget(card)'), 'and wires it');
  check(!finalSrc.includes('status-pop') && !finalSrc.includes('openStatusMenu') && !finalSrc.includes('statusMenuEl'), 'the floating status menu is gone');
  check(!/me-avatar'\)\.onclick/.test(finalSrc), 'the avatar no longer owns a click handler');
  check(!css.includes('#status-pop') && !css.includes('.preseg'), 'and its CSS (and the chip grid) is gone with it');

  console.log('\n[2] it starts as just your current status');
  setMe('online'); setMenu(false, null);
  const closed = presenceWidgetHTML();
  check(closed.includes('id="presence-toggle"') && closed.includes('aria-expanded="false"'), 'a single collapsed toggle row');
  check(closed.includes('<span class="plabel">Online</span>'), 'showing the current status label');
  check(closed.includes('status-dot online'), 'and its dot');
  check(!closed.includes('plist') && !closed.includes('data-presence=') && !closed.includes('data-presence-ms='), 'no states or timers until it is opened');
  setMe('invisible');
  const inv = presenceWidgetHTML();
  check(inv.includes('<span class="plabel">Invisible</span>') && inv.includes('status-dot offline'), 'invisible reads grey-on-grey with an honest label');

  console.log('\n[3] opening it cascades the states');
  setMe('online'); setMenu(true, null);
  const open = presenceWidgetHTML();
  check(open.includes('aria-expanded="true"') && open.includes('class="plist"'), 'the toggle reports itself open and the list renders');
  for (const id of ['online', 'away', 'dnd', 'invisible']) check(open.includes('data-presence="' + id + '"'), 'has a ' + id + ' row');
  check((open.match(/class="prow sub sel"/g) || []).length === 1 && open.includes('class="prow sub sel" data-presence="online"'), 'the current state is the marked row');
  check(!/data-presence="online"[^>]*aria-expanded/.test(open), 'Online has no timer cascade (no chevron)');
  check(/data-presence="away"[^>]*aria-expanded="false"/.test(open), 'the other states offer a cascade');
  check(!open.includes('ptimes'), 'and nothing is cascaded yet');
  check(!open.includes('uc-preseg-note'), 'no timer note while online');

  console.log('\n[4] picking a state cascades its timer underneath it');
  const pending = Date.now() + 4 * 3600e3 - 1000; // ~4h left: the 4h row is the nearest
  setMe('away', pending); setMenu(true, 'away');
  const away = presenceWidgetHTML();
  const awayRow = away.indexOf('data-presence="away"');
  const times = away.indexOf('<div class="ptimes">');
  const dndRow = away.indexOf('data-presence="dnd"');
  check(awayRow > -1 && times > awayRow && times < dndRow, 'the timer list hangs off the Away row it came from', { awayRow, times, dndRow });
  check(away.includes('For 15 Minutes') && away.includes('For 1 Hour') && away.includes('For 4 Hours') && away.includes('For 8 Hours') && away.includes('For 24 Hours') && away.includes('For 3 Days') && away.includes('Forever'), 'with the full timer ladder');
  check(away.includes('class="prow time on" data-presence-ms="14400000"'), 'the live timer\'s nearest option is marked (4h)', away.slice(times, times + 260));
  check(away.includes('class="prow sub sel" data-presence="away"'), 'the picked state is the marked row');
  check(presenceDurationSel('away', 0) === 6, 'no timer → Forever is the marked option');
  check(away.includes('Clears ' + fmtCountdown(pending)), 'the live countdown is noted under the menu');

  setMe('dnd'); setMenu(true, 'dnd');
  const dnd = presenceWidgetHTML();
  check(dnd.indexOf('<div class="ptimes">') > dnd.indexOf('data-presence="dnd"') && dnd.indexOf('<div class="ptimes">') < dnd.indexOf('data-presence="invisible"'), 'a different state cascades under its own row');
  check(dnd.includes('class="prow time on" data-presence-ms="never"'), 'with no timer set, Forever is marked');
  check(!dnd.includes('uc-preseg-note'), 'and there is no countdown note');

  console.log('\n[5] the rows are wired to those semantics (DOM-less)');
  const fake = () => {
    const toggle = { onclick: null };
    const subRows = [{ dataset: { presence: 'online' }, onclick: null }, { dataset: { presence: 'away' }, onclick: null }];
    const timeRows = [{ dataset: { presenceMs: 'never' }, onclick: null }, { dataset: { presenceMs: '3600000' }, onclick: null }];
    const box = { outerHTML: '', querySelector: (s) => (s === '#presence-toggle' ? toggle : null), querySelectorAll: (s) => (s === '[data-presence]' ? subRows : timeRows) };
    return { card: { querySelector: (s) => (s === '#uc-presence' ? box : null) }, box, toggle, subRows, timeRows };
  };
  const f = fake();
  wirePresenceWidget(f.card);
  check(typeof f.toggle.onclick === 'function' && f.subRows.every((r) => typeof r.onclick === 'function') && f.timeRows.every((r) => typeof r.onclick === 'function'), 'every row gets an onclick');
  setMe('online'); setMenu(false, null);
  f.toggle.onclick();
  check(presenceMenu.open === true && f.box.outerHTML.includes('plist'), 'the toggle opens the state list');
  f.toggle.onclick();
  check(presenceMenu.open === false && presenceMenu.cascade === null, 'the toggle again collapses it and drops the cascade');

  setMe('online'); setMenu(true, null);
  statusCalls = [];
  f.subRows[1].onclick(); // Away
  await null;
  check(presenceMenu.open === true && presenceMenu.cascade === 'away' && statusCalls.length === 1 && statusCalls[0][0] === 'away', 'a state row applies the state and cascades its timer', { cascade: presenceMenu.cascade, statusCalls });
  statusCalls = [];
  f.timeRows[0].onclick(); // Forever
  await null;
  check(statusCalls.length === 1 && statusCalls[0][1] === null, 'Forever keeps the state and drops the timer', statusCalls);
  statusCalls = [];
  setMe('away', pending);
  f.timeRows[1].onclick(); // For 1 Hour
  await null;
  check(statusCalls.length === 1 && statusCalls[0][1] === 3600e3, 'a timer row sends its own span', statusCalls);
  check(wirePresenceWidget({ querySelector: () => null }) === undefined, 'no card element → a quiet no-op');

  console.log('\n[6] chips keep a live timer; Online drops it');
  statusCalls = [];
  setMe('away', pending);
  await choosePresence('away');
  check(statusCalls.length === 0, 're-picking the state you are in does nothing (never clears a live timer)', statusCalls);
  statusCalls = [];
  await choosePresence('dnd');
  check(statusCalls.length === 1 && statusCalls[0][0] === 'dnd' && statusCalls[0][1] === pending, 'switching state carries the pending timer over', statusCalls);
  statusCalls = [];
  setMe('dnd', pending);
  await choosePresence('online');
  check(statusCalls.length === 1 && statusCalls[0][0] === 'online' && statusCalls[0][1] === null, 'picking Online clears the timer for good', statusCalls);

  console.log('\n[7] the card repaints itself after a change');
  check(pickers.includes('function renderPresenceWidget(card)') && pickers.includes('box.outerHTML = presenceWidgetHTML()'), 'the menu is re-rendered in place');
  check(pickers.includes('try { clampUserCard(); } catch {}'), 'and a top-anchored card is pulled back on screen after it grows');
  check(finalSrc.includes('refreshOwnPresence()'), 'setStatus refreshes it for every path (idle auto-away included)');
  check((pickers.match(/function refreshOwnPresence\(/g) || []).length === 1, 'refresh exists once');

  console.log('\n[8] the status line still reads for everyone else');
  S.online = { sam: 'dnd' };
  check(statusLineHTML('sam', { id: 'sam' }).includes('Do not disturb'), 'another user\u2019s card keeps its label');
  check(statusLineHTML('sam', { id: 'sam', streaming_game: 'Rocket League' }).includes('Streaming'), 'streaming wins the line');
  check(statusLineHTML('sam', { id: 'sam' }).includes('status-dot dnd'), 'and the dot matches');

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f2 of failures) console.log('  - ' + f2);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
}

main();
