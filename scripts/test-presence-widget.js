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
// The last section is the one thing that needs a real event loop: the menu
// re-renders itself in place, and a click inside it must not be mistaken for a
// click outside the card (which closes it). It drives real clicks in headless
// Chrome against the REAL clickInPath() closer helper, and skips without
// Chrome.
//
// Offline except that section (no database required).
//
// Usage: node scripts/test-presence-widget.js
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

// Normalise line endings: this suite matches source formatting with \n
// regexes, and a Windows checkout (core.autocrlf) hands back CRLF, which made
// the user-card menu check fail with no code change behind it.
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const pickers = readSrc('public/js/pickers.js');
const finalSrc = readSrc('public/js/final.js');
const core = readSrc('public/js/core.js');
const css = readSrc('public/styles.css');
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
// The words a presence state is called are shared from core.js (the me bar paints
// before the later files parse), so a slice that leans on them declares them.
global.STATUS_TEXT = { online: 'Online', away: 'Away', dnd: 'Do not disturb', offline: 'Offline', invisible: 'Invisible' };

// statusLineHTML + the switcher live between wireStatusBubble and clearMyStatus.
const code = slice(core, 'function esc(s) {', '// Layout size of a popup')
  + '\n' + slice(pickers, 'function fmtCountdown(ts) {', 'async function clearMyStatus() {');
// Strict mode gives eval its own scope, so hand the functions back explicitly.
const {
  fmtCountdown, fmtUntil, statusLineHTML, presenceWidgetHTML, presenceDurationSel, choosePresence, wirePresenceWidget, presenceMenu,
  getPresenceMenu, setPresenceMenu,
} = eval(code + '\n;({ fmtCountdown, fmtUntil, statusLineHTML, presenceWidgetHTML, presenceDurationSel, choosePresence, wirePresenceWidget, presenceMenu, getPresenceMenu: () => presenceMenu, setPresenceMenu: (open, cascade) => { presenceMenu = { open, cascade }; } })');

const setMe = (status, exp) => { S.me = { id: 'me', username: 'jordan', status, presence_expires_at: exp || null }; };
// The menu is a `let` the code reassigns, so read/write it through accessors.
const setMenu = (open, cascade) => setPresenceMenu(open, cascade);

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
// A live card with the real menu wired in, and the real closer condition
// (clickInPath) watching document clicks. The menu swaps itself out mid-click,
// which is exactly the trap this section exists for.
function clickPageHtml() {
  const escSrc = slice(core, 'function esc(s) {', '// Layout size of a popup');
  const codeSrc = slice(pickers, 'function fmtCountdown(ts) {', 'async function clearMyStatus() {');
  const closer = slice(finalSrc, 'function clickInPath(e, sels) {', " document.addEventListener('click'");
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css"></head><body>
<div id="usercard"><div class="uc-body"><div id="presence-slot"></div></div></div>
<div id="outside" style="height:40px">outside</div>
<script>
window.S = { me: { id: 'me', status: 'online' } };
window.statusOf = () => S.me.status || 'online';
window.isOff = (st) => st === 'offline' || st === 'invisible';
window.dotOf = (st, t) => (t && !isOff(st)) ? 'streaming' : (st === 'invisible' ? 'offline' : st);
window.$ = (s) => document.querySelector(s);
window.presenceExpiry = () => +((S.me && S.me.presence_expires_at) || 0);
window.clampUserCard = () => {};
// The words a presence state is called come from core.js (shared with the me
// bar), so the slice needs them declared here like its other dependencies.
const STATUS_TEXT = { online: 'Online', away: 'Away', dnd: 'Do not disturb', offline: 'Offline', invisible: 'Invisible' };
// Mirror the server's PATCH: an expiry has to be a future epoch or it is a 400
// (bad_expiry), which the real setStatus swallows.
window.__sent = [];
window.__badExpiry = null;
window.setStatus = async (s, exp) => {
  const abs = s === 'online' ? null : (exp ?? null);
  window.__sent.push([s, abs]);
  if (abs !== null && !(abs > Date.now())) { window.__badExpiry = abs; return; }
  S.me = { ...S.me, status: s, presence_expires_at: abs };
  try { refreshOwnPresence(); } catch (e) { window.__refreshErr = String(e); }
};
${escSrc}
${closer}
${codeSrc}
const card = document.getElementById('usercard');
card.dataset.uid = 'me';
document.getElementById('presence-slot').outerHTML = presenceWidgetHTML();
wirePresenceWidget(card);
let wouldClose = false;
document.addEventListener('click', (e) => {
  if (!clickInPath(e, ['#usercard', '#me-card', '[data-uid]', '.member', '.usertag[data-tag-sid]'])) wouldClose = true;
});
const out = {};
try {
wouldClose = false; document.getElementById('presence-toggle').click();
out.toggle = { wouldClose, open: presenceMenu.open, listRendered: !!document.querySelector('.plist') };
wouldClose = false; document.querySelector('[data-presence="away"]').click();
out.pickAway = { wouldClose, cascade: presenceMenu.cascade, status: S.me.status };
// The real app re-renders the ladder from setStatus; setStatus is a stub here.
renderPresenceWidget(card);
wouldClose = false; document.querySelector('[data-presence-ms="3600000"]').click();
out.pickTime = { wouldClose, open: presenceMenu.open, cascade: presenceMenu.cascade, listLeft: !!document.querySelector('.plist'), cardThere: !!document.getElementById('usercard') };
wouldClose = false; document.getElementById('outside').click();
out.realOutside = { wouldClose };
} catch (e) { out.err = String(e && e.stack || e); }
setTimeout(() => {
  const note = document.querySelector('.uc-preseg-note');
  out.pickTime.note = note ? note.textContent : null;
  out.pickTime.label = (document.querySelector('#presence-toggle .plabel') || {}).textContent || null;
  out.pickTime.sent = window.__sent;
  out.pickTime.badExpiry = window.__badExpiry;
  out.pickTime.refreshErr = window.__refreshErr || null;
  document.title = JSON.stringify(out);
}, 80);
</script></body></html>`;
}
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
  check(away.includes('Until ' + fmtUntil(pending)), 'the live timer is noted as a wall-clock time under the menu');

  setMe('dnd'); setMenu(true, 'dnd');
  const dnd = presenceWidgetHTML();
  check(dnd.indexOf('<div class="ptimes">') > dnd.indexOf('data-presence="dnd"') && dnd.indexOf('<div class="ptimes">') < dnd.indexOf('data-presence="invisible"'), 'a different state cascades under its own row');
  check(dnd.includes('class="prow time on" data-presence-ms="never"'), 'with no timer set, Forever is marked');
  check(!dnd.includes('uc-preseg-note'), 'and there is no countdown note');

  console.log('\n[4b] the note reads as a clock time, not a countdown');
  check(fmtUntil(Date.now() + 3600e3).length > 0 && /\d/.test(fmtUntil(Date.now() + 3600e3)) && !/^in /.test(fmtUntil(Date.now() + 3600e3)), '"3:55 PM"-shaped, never an "in 45m" countdown', fmtUntil(Date.now() + 3600e3));
  const sameDay = new Date(); sameDay.setHours(23, 59, 0, 0);
  check(fmtUntil(sameDay.getTime()) === sameDay.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), 'same day → bare clock time', fmtUntil(sameDay.getTime()));
  const tmr = new Date(); tmr.setDate(tmr.getDate() + 1); tmr.setHours(15, 55, 0, 0);
  check(fmtUntil(tmr.getTime()).startsWith('tomorrow '), 'the next day is named', fmtUntil(tmr.getTime()));
  const wk = new Date(); wk.setDate(wk.getDate() + 3); wk.setHours(15, 55, 0, 0);
  check(/\d/.test(fmtUntil(wk.getTime())) && !fmtUntil(wk.getTime()).startsWith('tomorrow ') && !/^in /.test(fmtUntil(wk.getTime())), 'a few days out carries its day', fmtUntil(wk.getTime()));

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
  check(getPresenceMenu().open === true && f.box.outerHTML.includes('plist'), 'the toggle opens the state list');
  f.toggle.onclick();
  check(getPresenceMenu().open === false && getPresenceMenu().cascade === null, 'the toggle again collapses it and drops the cascade');

  setMe('online'); setMenu(true, null);
  statusCalls = [];
  f.subRows[1].onclick(); // Away
  await null;
  check(getPresenceMenu().open === true && getPresenceMenu().cascade === 'away' && statusCalls.length === 1 && statusCalls[0][0] === 'away', 'a state row applies the state and cascades its timer', { cascade: getPresenceMenu().cascade, statusCalls });
  statusCalls = [];
  f.timeRows[0].onclick(); // Forever
  await null;
  check(statusCalls.length === 1 && statusCalls[0][1] === null, 'Forever keeps the state and drops the timer', statusCalls);
  check(getPresenceMenu().open === false && getPresenceMenu().cascade === null, 'and collapses the menu (the card itself stays open)');
  statusCalls = [];
  setMe('away', pending);
  setMenu(true, 'away');
  const tBefore = Date.now();
  f.timeRows[1].onclick(); // For 1 Hour
  await null;
  check(statusCalls.length === 1 && statusCalls[0][1] > tBefore, 'a timer row sends a future epoch, not the raw span', statusCalls);
  check(Math.abs(statusCalls[0][1] - (tBefore + 3600e3)) < 5000, 'and it is exactly the span from now (the server rejects anything else)', statusCalls);
  check(getPresenceMenu().open === false && getPresenceMenu().cascade === null, 'picking a span is the end of the interaction — menu collapsed');
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

  console.log('\n[9] a click inside the menu is never read as a click outside the card');
  const chrome = findChrome();
  if (!chrome) console.log('  (skipped: no Chrome/Edge found — set CHROME_PATH)');
  else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-presence-'));
    try {
      const htmlPath = path.join(dir, 'page.html');
      fs.writeFileSync(htmlPath, clickPageHtml());
      const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
        '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=520,420',
        '--virtual-time-budget=2000', '--dump-dom', 'file:///' + htmlPath.replace(/\\/g, '/')],
        { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
      if (!m) check(false, 'the click harness ran', { status: r.status });
      else {
        const out = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
        check(out.toggle.wouldClose === false && out.toggle.open === true && out.toggle.listRendered === true, 'opening the menu leaves the card open', out.toggle);
        check(out.pickAway.wouldClose === false && out.pickAway.cascade === 'away' && out.pickAway.status === 'away', 'picking a state cascades it and leaves the card open', out.pickAway);
        check(out.pickTime.wouldClose === false && out.pickTime.open === false && out.pickTime.cascade === null, 'picking a span collapses the menu', out.pickTime);
        check(out.pickTime.listLeft === false && out.pickTime.cardThere === true, 'and the card stays open, just without the open menu', out.pickTime);
        const sent = out.pickTime.sent || [];
        const lastSent = sent[sent.length - 1] || [];
        check(sent[0] && sent[0][1] === null && lastSent[0] === 'away' && lastSent[1] > Date.now(), 'the span goes out as a future epoch, never the raw span', sent);
        check(out.pickTime.badExpiry === null, 'so the server-shaped expiry check accepts it (a raw span 400s)', { badExpiry: out.pickTime.badExpiry });
        check(out.pickTime.note && /^Until /.test(out.pickTime.note), 'and the card shows the Until note under the state', { note: out.pickTime.note, label: out.pickTime.label });
        check(out.pickTime.label === 'Away', 'under the state that was picked', out.pickTime.label);
        check(out.realOutside.wouldClose === true, 'a click genuinely outside still closes the card', out.realOutside);
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  console.log('\n[10] the timer ladder applies the state it hangs off, not the live status');
  // Regression: the row read (S.me||{}).status. A picked Away carries no timer
  // yet, activity used to clear it back to Online, and then "For 1 Hour" sent
  // Online + a timer — which setStatus drops, so the click did nothing at all.
  check(pickers.includes('data-presence-state="${id}"'), 'the rendered ladder stamps every row with its state');
  check(/const state = b\.dataset\.presenceState \|\|/.test(pickers), 'and the handler reads that, not the live status');
  const f2 = fake();
  f2.timeRows.forEach((r) => { r.dataset.presenceState = 'away'; });
  wirePresenceWidget(f2.card);
  setMe('online'); setMenu(true, 'away');
  statusCalls = [];
  const t0b = Date.now();
  f2.timeRows[1].onclick(); // For 1 Hour, while the state has lapsed to Online
  await null;
  check(statusCalls.length === 1 && statusCalls[0][0] === 'away' && Math.abs(statusCalls[0][1] - (t0b + 3600e3)) < 5000, 'picking a timer mid-lapse still applies Away + the span', statusCalls);

  console.log('\n[11] activity reverts only the idle auto-away');
  // The other half: poke() runs on every input event, and its old "untimed away
  // → Online" rule undid a hand-picked Away on the next mouse move. Drive the
  // real block out of final.js with a stubbed document + captured intervals; the
  // deadline itself is moved by reaching into lastActive, because the clock is a
  // wall-time stamp rather than a single 5-minute timeout.
  const idlePrelude = `
const __sent = [];
const __ticks = [];
const __listeners = {};
const __api = { ok: true, drop: false, calls: 0 };
let __seq = 0;
const S = { me: { id: 'me', status: 'online', presence_expires_at: null, presence_auto: 0 } };
const api = async (p, o) => {
  __api.calls++;
  if (!__api.ok) throw new Error('offline'); // what api() does on a dead network
  const body = JSON.parse(o.body);
  __sent.push(body);
  // What the server answers when it DROPS a hidden device's auto-away because
  // another device of the account is in front: the user, unchanged.
  if (__api.drop && body.presenceAuto) return { user: { ...S.me } };
  return { user: { status: body.status, presence_expires_at: body.presenceExpiresAt ?? null, presence_auto: body.presenceAuto ? 1 : 0 } };
};
function paintMe() {}
function renderMembers() {}
function renderDmMembers() {}
function refreshOwnPresence() {}
const document = {
  visibilityState: 'visible',
  addEventListener(ev, fn) { (__listeners[ev] = __listeners[ev] || []).push(fn); },
};
function setInterval(fn, ms) { const id = ++__seq; __ticks.push({ id, fn, ms }); return id; }
function clearInterval() {}
`;
  const idle = eval(idlePrelude + slice(finalSrc, 'function presenceExpiry() {', '// ---------- global closers')
    + '\n;({ poke, markPresenceManual, idleTick, idleAwayIsOurs, idleAwayDue, __S: S, __sent, __ticks, __listeners, __api, __doc: document,'
    + ' __reset: () => { idleRetryAt = 0; }, __setLast: (ms) => { lastActive = Date.now() - ms; } })');
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const awaySends = () => idle.__sent.filter((b) => b.status === 'away');
  idle.poke();
  check(idle.__ticks.length === 1 && idle.__ticks[0].ms === 20000,
    'activity starts a slow idle tick (not one 5-minute timeout a throttled tab can swallow)', idle.__ticks.map((t) => t.ms));
  check(!idle.__ticks.some((t) => t.ms === 5 * 60 * 1000), 'and nothing arms a lone 5-minute timeout any more');
  check(Array.isArray(idle.__listeners.visibilitychange) && idle.__listeners.visibilitychange.length === 1,
    'coming back to the tab counts as activity (a throttled tab resumes on exactly that event)');
  check(['mousemove', 'keydown', 'click', 'wheel', 'touchstart'].every((ev) => Array.isArray(idle.__listeners[ev])),
    'and so do touch and wheel — a phone user scrolling a chat is not "away"', Object.keys(idle.__listeners));
  check(idle.__S.me.status === 'online', 'nothing happens at boot beyond arming the clock');
  idle.__setLast(4 * 60e3);
  idle.idleTick(); await tick();
  check(idle.__S.me.status === 'online', 'four quiet minutes is not away yet');
  idle.__setLast(6 * 60e3);
  idle.idleTick(); await tick();
  check(idle.__S.me.status === 'away', 'past five quiet minutes it flips to Away on its own');
  check(idle.__S.me.presence_auto === 1, 'and the Away is recorded as the IDLE clock\'s');
  check(awaySends().some((b) => b.presenceAuto === true),
    'the request says so (presenceAuto is what lets any of the account\'s devices undo it)', awaySends());
  idle.poke(); await tick();
  check(idle.__S.me.status === 'online', 'activity clears the idle Away');
  check(idle.__S.me.presence_auto === 0, 'and the idle marker goes with it');

  // A hand-picked Away is the user's: activity must leave it alone. The pick
  // clears the marker locally (so the clock cannot race the request) and the
  // server clears the column for real.
  idle.__setLast(6 * 60e3); idle.idleTick(); await tick();
  check(idle.__S.me.status === 'away' && idle.__S.me.presence_auto === 1, 'idle again → away again');
  idle.markPresenceManual(); // e.g. the user picked a state on their card
  check(idle.__S.me.presence_auto === 0, 'a pick drops the idle marker');
  idle.poke(); await tick();
  check(idle.__S.me.status === 'away', 'so a hand-picked Away survives the next mouse move');
  idle.__S.me.status = 'away';
  idle.__S.me.presence_expires_at = Date.now() + 3600e3;
  idle.poke(); await tick();
  check(idle.__S.me.status === 'away', 'a timed Away still keeps its own revert');

  // The edge case a lone timeout could never cover: a timed Away lapses back to
  // Online (the server sweep writes that) while the user is still not there. The
  // 5-minute timer had fired hours earlier, so nothing was left to notice — the
  // account sat Online all night. The wall clock notices.
  idle.__S.me.status = 'online';
  idle.__S.me.presence_expires_at = null;
  idle.__S.me.presence_auto = 0;
  idle.__setLast(30 * 60e3);
  idle.idleTick(); await tick();
  check(idle.__S.me.status === 'away', 'a lapse while nobody is there goes back to Away on the next tick');
  check(idle.__S.me.presence_auto === 1, 'as the idle clock\'s Away again');
  // …but a lapse while the user IS there must not bounce them straight to Away.
  idle.__S.me.status = 'online'; idle.__S.me.presence_auto = 0;
  idle.poke(); // input right now
  idle.idleTick(); await tick();
  check(idle.__S.me.status === 'online', 'a lapse the user is present for does not bounce back to Away');

  // A flip that fails (offline, server down) must not be marked as ours, and
  // must not be retried on every single tick.
  idle.__reset();
  idle.__S.me.status = 'online'; idle.__S.me.presence_auto = 0;
  idle.__api.ok = false; idle.__api.calls = 0;
  idle.__setLast(10 * 60e3);
  idle.idleTick(); await tick(); await tick();
  idle.idleTick(); await tick();
  check(idle.__S.me.status === 'online' && idle.__S.me.presence_auto === 0, 'a failed flip leaves the account Online and unmarked');
  check(idle.__api.calls === 1, 'and the clock backs off instead of hammering the server on every tick', idle.__api.calls);
  idle.__api.ok = true;

  // A DROPPED flip — the server refusing a hidden device's clock because another
  // device of the account is in front — is not an error, but it must back off the
  // same way rather than ask again on every 20s tick for as long as the desktop
  // is being used.
  idle.__reset();
  idle.__doc.visibilityState = 'hidden'; // this device is a phone in a pocket
  idle.__S.me.status = 'online'; idle.__S.me.presence_auto = 0;
  idle.__api.drop = true; idle.__api.calls = 0;
  idle.__setLast(10 * 60e3);
  idle.idleTick(); await tick(); await tick();
  idle.idleTick(); await tick();
  check(idle.__S.me.status === 'online' && idle.__S.me.presence_auto === 0, 'a hidden device whose account is in front elsewhere stays Online');
  check(idle.__api.calls === 1, 'and backs off there too', idle.__api.calls);
  check(idle.__sent.some((b) => b.presenceAuto === true && b.presenceVisible === false),
    'the flip tells the server whether THIS device is the one being looked at', idle.__sent.filter((b) => b.presenceAuto));
  idle.__api.drop = false;
  idle.__doc.visibilityState = 'visible';

  check(/if \(req\.body\?\.presenceAuto === true && req\.body\.presenceVisible === false && \(await anyoneInFront\(req\.user\.id\)\)\)/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')),
    'and the server drops exactly that request while a device of the account holds a page-in-front lease');
  check(/async function anyoneInFront\(userId\)/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')),
    'read from the same visible_at lease as the phone indicator');

  check(/if \(typeof markPresenceManual === 'function'\) markPresenceManual\(\)/.test(pickers), 'choosePresence marks a pick as not auto');
  check(/const claimingIdle = !!\(S\.me && S\.me\.presence_auto\) && s === cur && !presenceExpiry\(\);/.test(pickers),
    'and re-picking the state the idle clock put you in still WRITES (only the server clears presence_auto)');
  check(/if \(ms === undefined && s === cur && !claimingIdle\)/.test(pickers), 'while every other re-pick stays the no-op that never clears a live timer');
  check(!/localStorage/.test(slice(finalSrc, 'function idleAwayIsOurs()', '// ---------- the idle clock')), 'the origin is account state now, not a per-browser localStorage marker');
  check(/presence_auto: u\.presence_auto \? 1 : 0/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')),
    'the server ships it on the user object every client reads');
  check(/addColumn\('users', 'presence_auto'/.test(fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8')),
    'as a guarded migration (existing databases upgrade in place)');

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f2 of failures) console.log('  - ' + f2);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
}

main();
