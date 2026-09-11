// Presence switcher on your own user card (see AGENTS.md).
//
// The change: the online/away/DND/invisible quickswitch used to be a floating
// menu hanging off your avatar, with a second menu for the timed revert. It is
// now a widget on your own user card — one tap per state, the timed "back to
// Online" one more tap away — so the avatar can just open the card like every
// other avatar in the app does.
//
// No bundler and no exports here, so this drives the REAL presenceWidgetHTML()
// and choosePresence() by extracting them from public/js/pickers.js and running
// them against stub globals.
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
  fmtCountdown, statusLineHTML, presenceWidgetHTML, presenceDurationSel, choosePresence, wirePresenceWidget,
} = eval(code + '\n;({ fmtCountdown, statusLineHTML, presenceWidgetHTML, presenceDurationSel, choosePresence, wirePresenceWidget })');

const setMe = (status, exp) => { S.me = { id: 'me', username: 'jordan', status, presence_expires_at: exp || null }; };
const NOW = Date.now();
const chipOn = (html, id) => new RegExp('class="mini on" data-presence="' + id + '"').test(html);

async function main() {
  console.log('\n[1] the switcher replaces the avatar menu');
  check(pickers.includes('<div class="uc-head"><span class="avatar big"></span>${statusBubbleHTML(u)}</div>'), 'the card still leads with the avatar');
  check(pickers.includes("${uid === S.me.id ? presenceWidgetHTML() : ''}"), 'the card mounts the switcher for me (and only me)');
  check(pickers.includes('wirePresenceWidget(card)'), 'and wires it');
  check(!finalSrc.includes('status-pop') && !finalSrc.includes('openStatusMenu') && !finalSrc.includes('statusMenuEl'), 'the floating status menu is gone');
  check(!/me-avatar'\)\.onclick/.test(finalSrc), 'the avatar no longer owns a click handler');
  check(!css.includes('#status-pop') && !css.includes('.stat-check'), 'and its CSS is gone with it');

  console.log('\n[2] four states, the active one lit');
  setMe('online');
  const online = presenceWidgetHTML();
  for (const id of ['online', 'away', 'dnd', 'invisible']) check(online.includes('data-presence="' + id + '"'), 'has a ' + id + ' chip');
  check(chipOn(online, 'online') && !chipOn(online, 'away') && !chipOn(online, 'dnd') && !chipOn(online, 'invisible'), 'Online is the lit chip while online');
  check(!online.includes('uc-presence-dur'), 'no timer row while online');
  check(online.includes('aria-pressed="true"'), 'the lit chip reports itself pressed');
  setMe('dnd');
  check(chipOn(presenceWidgetHTML(), 'dnd'), 'Do not disturb is lit while dnd');
  setMe('invisible');
  check(chipOn(presenceWidgetHTML(), 'invisible'), 'Invisible is lit while invisible');

  console.log('\n[3] the timed revert is one tap away, and reflects the live timer');
  setMe('away', NOW + 4 * 3600e3 - 1000); // ~4h left: the 4h chip is the nearest
  const away = presenceWidgetHTML();
  check(away.includes('uc-presence-dur') && away.includes('data-presence-ms="14400000"'), 'a set state gets the Back to Online row');
  check(chipOn(away, 'away'), 'the set state stays lit');
  check(away.includes('class="mini on" data-presence-ms="14400000"'), 'the nearest duration chip is lit (4h)');
  check(away.includes('Clears ' + fmtCountdown(NOW + 4 * 3600e3 - 1000)), 'the note counts down the live timer');
  check(away.includes('data-presence-ms="never"'), 'Never is offered to drop the timer');
  check(presenceDurationSel('away', 0) === 6, 'no timer → Never is the lit duration');
  check(presenceDurationSel('away', NOW + 15 * 60e3) === 0, 'a 15m timer → the 15m chip');

  console.log('\n[4] chips keep a live timer; Online drops it');
  statusCalls = [];
  setMe('away', NOW + 3600e3);
  await choosePresence('away'); // tapping the state you are already in
  check(statusCalls.length === 0, 'tapping the current state does nothing (never clears a live timer)', statusCalls);

  statusCalls = [];
  const pending = S.me.presence_expires_at;
  await choosePresence('dnd');
  check(statusCalls.length === 1 && statusCalls[0][0] === 'dnd' && statusCalls[0][1] === pending, 'switching state carries the pending timer over', statusCalls);

  statusCalls = [];
  setMe('dnd', NOW + 3600e3);
  await choosePresence('online');
  check(statusCalls.length === 1 && statusCalls[0][0] === 'online' && statusCalls[0][1] === null, 'picking Online clears the timer for good', statusCalls);

  statusCalls = [];
  setMe('away', NOW + 3600e3);
  await choosePresence('away', null);
  check(statusCalls.length === 1 && statusCalls[0][1] === null, 'tapping Never keeps the state and drops the timer', statusCalls);

  statusCalls = [];
  setMe('invisible');
  await choosePresence('invisible', 15 * 60e3);
  check(statusCalls.length === 1 && statusCalls[0][1] === 15 * 60e3, 'a duration tap sends the chosen absolute expiry', statusCalls);

  console.log('\n[4b] the chips are wired to the handler (DOM-less)');
  const btn = (attrs) => ({ dataset: attrs, onclick: null });
  const stateBtns = [btn({ presence: 'online' }), btn({ presence: 'away' })];
  const durBtns = [btn({ presenceMs: 'never' }), btn({ presenceMs: '3600000' })];
  const box = { querySelectorAll: (sel) => (sel === '[data-presence]' ? stateBtns : durBtns) };
  wirePresenceWidget({ querySelector: (sel) => (sel === '#uc-presence' ? box : null) });
  check(stateBtns.every((b) => typeof b.onclick === 'function') && durBtns.every((b) => typeof b.onclick === 'function'), 'every chip gets an onclick');
  statusCalls = [];
  setMe('online');
  stateBtns[1].onclick();
  await null;
  check(statusCalls.length === 1 && statusCalls[0][0] === 'away', 'a state chip sends its own state', statusCalls);
  statusCalls = [];
  setMe('away');
  durBtns[0].onclick();
  await null;
  check(statusCalls.length === 1 && statusCalls[0][0] === 'away' && statusCalls[0][1] === null, 'the Never chip drops the timer', statusCalls);
  statusCalls = [];
  setMe('away');
  durBtns[1].onclick();
  await null;
  check(statusCalls.length === 1 && statusCalls[0][1] === 3600e3, 'a duration chip sends its own ms', statusCalls);
  check(wirePresenceWidget({ querySelector: () => null }) === undefined, 'no card element → a quiet no-op');

  console.log('\n[5] the card repaints itself after a change');
  check(pickers.includes('function refreshOwnPresence()') && pickers.includes('line.innerHTML = statusLineHTML(S.me.id, S.me)'), 'the status line is repainted in place');
  check(pickers.includes('box.outerHTML = presenceWidgetHTML(); wirePresenceWidget(card);'), 'and so is the switcher');
  check(finalSrc.includes('refreshOwnPresence()'), 'setStatus refreshes it for every path (idle auto-away included)');
  check((pickers.match(/function refreshOwnPresence\(/g) || []).length === 1, 'refresh exists once');

  console.log('\n[6] the status line still reads for everyone else');
  S.online = { sam: 'dnd' };
  check(statusLineHTML('sam', { id: 'sam' }).includes('Do not disturb'), 'another user\u2019s card keeps its label');
  check(statusLineHTML('sam', { id: 'sam', streaming_game: 'Rocket League' }).includes('Streaming'), 'streaming wins the line');
  check(statusLineHTML('sam', { id: 'sam' }).includes('status-dot dnd'), 'and the dot matches');
  setMe('invisible');
  check(statusLineHTML('me', S.me).includes('status-dot offline') && statusLineHTML('me', S.me).includes('Invisible'), 'invisible stays grey-on-grey with an honest label');

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
}

main();
