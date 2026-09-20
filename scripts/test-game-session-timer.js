// The session clock in the user card's "Playing <game>" box and on the profile
// screen's Gaming widget.
//
// The ask: when someone is playing a game, the box that says "Playing X" should
// carry, on its right side, how long THAT session has been going. Two things
// make that harder than a counter:
//
//   * "How long" is not something a client can know — a watcher beacons every
//     10-30s and the badge is re-broadcast with every frame, so a client that
//     stamped its own start would restart the clock on every reconnect, reload
//     and device. The start is therefore SERVER state beside the game name
//     (users.playing_since), stamped ONCE on the first beacon of a game and
//     cleared wherever the game is cleared. The whole clear-path scan below is
//     that invariant: every `playing_game = NULL` must take the clock with it,
//     or a finished session leaves a timer running forever.
//   * The number must sit on the RIGHT EDGE of the box and stay there, without
//     pushing a long game name out or being pushed out by it. That is a claim
//     about layout, so it is measured off the pixels in headless Chrome (a
//     short name and a name far too long for the card's width).
//
// The profile screen's own "Playing X" line was REMOVED (owner request: the
// profile said it twice). Its clock did not go with it — it rides the Gaming
// widget's "Currently playing X" line, which is the same row on the same
// surface, so [1b] pins that the standalone row is gone, that the clock there
// is the shared span fed by the same server fact, and the browser half measures
// the widget's line where it used to measure the row.
//
// Static half: always runs (source wiring + the formatter, driven by the real
// extracted code). Chrome half: skips without Chrome.
//
// Usage: node scripts/test-game-session-timer.js
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
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}

const servers = readSrc('public/js/servers.js');
const pickers = readSrc('public/js/pickers.js');
const socket = readSrc('public/js/socket.js');
const server = readSrc('server.js');
const dbjs = readSrc('db.js');
const css = readSrc('public/styles.css');

// The real formatter / row builder / ticker, out of the real file. `esc` is the
// app's own escaper (core.js) in miniature — this suite is about the row's
// shape, not about escaping.
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const svg = slice(servers, 'const CONTROLLER_SVG =', 'const gameArtCache');
const rows = slice(servers, 'function gameBadgeHTML(game) {', 'function paintGameBadge(el) {');
const fmt = slice(servers, 'function fmtElapsed(ms) {', '// ---------- unread channels ----------');
const fmtElapsed = eval(slice(servers, 'function fmtElapsed(ms) {', '\n}') + '\n}\n;fmtElapsed');
// (`fmt` — the ticker — is deliberately NOT eval'd here: it registers a real
// interval, and this file only wants the row builder. The Chrome fixture runs
// the real ticker.)
const built = eval(svg + '\n' + rows + '\n;({ gameBadgeHTML, gameRowHTML, gameClockHTML })');
const { gameRowHTML, gameClockHTML } = built;

console.log('\n[1] the card row: badge · name · clock, and the clock only when the server knows the start');
const NOW = Date.now();
const live = gameRowHTML({ playing_game: 'Chess', playing_since: NOW - 65000 });
check(live.includes('class="uc-statustext ugame"'), 'it is the card\'s game box', live);
check(live.includes('class="uc-game-name"') && live.includes('Playing Chess'), 'the name is its own span (it has to be the thing that ellipsises)', live);
check(live.includes('class="game-clock"') && live.includes('data-gtimer="' + (NOW - 65000) + '"'),
  'the clock carries the server\'s session start, not a locally guessed one', live);
check(live.includes('>1:05<'), 'and paints the elapsed time already (no empty frame until the first tick)', live);
check(!gameRowHTML({ playing_game: 'Chess' }).includes('game-clock'),
  'a game with no recorded start shows no clock rather than a wrong one', gameRowHTML({ playing_game: 'Chess' }));
check(gameRowHTML({}) === '' && gameRowHTML(null) === '', 'and no game at all renders no box');
check(/esc\(u\.playing_game\)/.test(rows), 'the name is escaped, as every user-supplied string on the card is');

console.log('\n[1b] the profile screen has ONE live line, in its Gaming widget, and the clock rides it');
check(!/profileGameRowHTML/.test(servers) && !/profileGameRowHTML/.test(pickers),
  'the profile\'s standalone "Playing X" row builder is gone (the crossed-out line)', 'servers.js/pickers.js');
check(!/\$\{profileGameRowHTML\(u\)\}/.test(pickers) && !/class="pf-playing-name"/.test(css),
  'openProfileScreen does not paint it, and no dead rule for its name is left in the sheet', 'openProfileScreen');
check(/class="pf-gaming-now"><span class="pf-gaming-now-name">Currently playing <b>\$\{esc\(nowPlaying\.game\)\}<\/b><\/span>\$\{gameClockHTML\(/.test(pickers),
  'the widget\'s "Currently playing X" line carries the SAME clock span, so no two surfaces can drift apart', 'pickers.js');
check(/const liveSince = \(g && g\.playing_since\) \|\| \(mu && mu\.playing_since\) \|\| 0;/.test(pickers),
  'and it is fed the server\'s session start (the gaming payload, with the roster as the frame-lag fallback)', 'pickers.js');
check(/const playing_since = now_playing \? \(u\.playing_since \|\| null\) : null;/.test(server) && /now_playing, playing_since, games: top/.test(server),
  'which is why gamingFor returns it beside the live game name — and only while one is running', 'gamingFor');
check(gameClockHTML({}) === '' && gameClockHTML({ playing_since: 0 }) === '' && gameClockHTML(null) === '',
  'the clock helper itself renders nothing without a start', [gameClockHTML({}), gameClockHTML({ playing_since: 0 })]);
check(/esc\(u\.playing_game\)/.test(rows) && !/class="pf-playing"/.test(slice(servers, 'function gameRowHTML(u) {', 'function gameClockHTML')),
  'the card row stays a card row — the two builders are separate, only the clock is shared', 'servers.js');

console.log('\n[2] the formatter: one shape for a voice room and a game session');
check(fmt.includes('data-gtimer') && fmt.includes('[data-vtimer]'),
  'ONE ticker paints both clocks (the voice room\'s and the game\'s)', 'ticker');
check(/const t0 = Number\(el\.dataset\.gtimer\)/.test(fmt), 'the game clock reads the value off the element — no per-user map to go stale', 'ticker');
check(/if \(!t0\) \{ el\.remove\(\); return; \}/.test(fmt), 'and an element with no start retires instead of rendering NaN', 'ticker');
check(fmtElapsed(0) === '0:00' && fmtElapsed(59000) === '0:59', 'under a minute, and under an hour, reads M:SS', [fmtElapsed(0), fmtElapsed(59000)]);
check(fmtElapsed(60000) === '1:00' && fmtElapsed(3599000) === '59:59', 'minutes roll into the same shape', [fmtElapsed(60000), fmtElapsed(3599000)]);
check(fmtElapsed(3600000) === '1:00:00' && fmtElapsed(26 * 3600000 + 3 * 60000 + 11000) === '26:03:11',
  'past an hour it grows H:MM:SS, and hours never wrap — a game left running overnight reads 26:03:11',
  [fmtElapsed(3600000), fmtElapsed(26 * 3600000 + 3 * 60000 + 11000)]);

console.log('\n[3] the server stamps the start once, and never leaves it behind');
check(/addColumn\('users', 'playing_since', 'BIGINT'\)/.test(dbjs),
  'the column is a guarded migration (existing databases upgrade in place)', 'db.js');
check(server.includes('playing_since') && /playing_since: u\.playing_game \? \(u\.playing_since \|\| null\) : null/.test(server),
  'publicUser carries it, and only while a game is actually running', 'publicUser');
check(/, playing_game, playing_since, streaming_game,/.test(server), 'it rides USER_COLS (every user payload, including /api/me)', 'USER_COLS');
check(/u\.playing_game, u\.playing_since, u\.streaming_game/.test(server), 'and the server roster query, which is where the card\'s person usually comes from', 'serverView');
check(/const since = \(prev === game && prevRow\.playing_since\) \? prevRow\.playing_since : now;/.test(server),
  'a later beacon of the SAME game keeps the original start (the clock must not restart every 15s)', 'watcher');
check(/if \(game && \(prev !== game \|\| !prevRow\.playing_since\)\)/.test(server),
  'a game that changed — or a stored one that predates the column — gets a fresh start', 'watcher');
const clears = [];
for (let i = server.indexOf('playing_game = NULL'); i >= 0; i = server.indexOf('playing_game = NULL', i + 1)) clears.push(i);
check(clears.length >= 7, 'every clear path is there to check', clears.length);
let orphan = null;
for (const i of clears) {
  // The statement the match sits in: up to the next quote that closes it (every
  // one of these is a single-quoted SQL string with no quotes of its own).
  const ends = ["'", '`'].map((q) => server.indexOf(q, i)).filter((k) => k >= 0);
  const stmt = server.slice(i, ends.length ? Math.min(...ends) : i + 200);
  if (!stmt.includes('playing_since = NULL')) orphan = server.slice(Math.max(0, i - 60), i + 90);
}
check(!orphan, 'and EVERY one of them clears the clock with the game (a finished session must not leave a timer running)', orphan);

console.log('\n[4] both surfaces use it, and follow a game starting or stopping while they are open');
check(pickers.includes('${u.playing_game ? gameRowHTML(u) : \'\'}'), 'openUserCard builds the box from the row helper', 'openUserCard');
check(/function refreshUserCardGame\(u\)/.test(pickers) && /cur\.outerHTML = html/.test(pickers),
  'the open card can swap that one row in place', 'pickers.js');
check(/function refreshProfileGame\(u\)/.test(pickers) && /String\(bd\.dataset\.uid\) !== String\(u\.id\)/.test(pickers),
  'the open profile screen answers a live frame too — matched to the person it is showing', 'pickers.js');
check(/const box = \$\('#pf-gaming'\);/.test(pickers) && /box\.dataset\.live = live \|\| ''/.test(pickers)
  && /if \(String\(box\.dataset\.live \|\| ''\) === String\(live\)\) return;/.test(pickers)
  && /loadUserGaming\(box, u\.username, \{ canDelete: String\(u\.id\) === String\(S\.me\.id\) \}\)/.test(pickers),
  'by re-reading the Gaming WIDGET, and only when the live game actually changed (a user-updated frame also carries presence churn)', 'pickers.js');
check(!/const cur = body\.querySelector\('\.pf-playing:not\(\.ustream\)'\)/.test(pickers),
  'the old one-row swap is gone with the row it swapped', 'refreshProfileGame');
check(/bd\.dataset\.uid = uid/.test(pickers), 'which is why the screen records who it is showing', 'pickers.js');
check(/try \{ refreshUserCardGame\(u\); \} catch \{\}\n\s*try \{ refreshProfileGame\(u\); \} catch \{\}/.test(socket),
  'socket.js calls both on user-updated — a friend launching a game must land on whichever surface is open', 'socket.js');
check(/\.uc-statustext\.ugame \.uc-game-name\{[^}]*text-overflow:ellipsis/.test(css), 'the card name ellipsises in the stylesheet', 'styles.css');
check(/\.uc-statustext\.ugame \.game-clock\{[^}]*margin-left:auto/.test(css), 'and the clock is pushed to the box\'s right edge by CSS', 'styles.css');
check(/\.uc-statustext\.ugame \.game-clock\{[^}]*color:inherit/.test(css),
  'the clock wears the box\'s OWN ink — the box is its own backdrop, so the card\'s --uc-* tones stop at its edge', 'styles.css');
check(/\.uc-statustext\.ugame \.game-clock\{[^}]*tabular-nums/.test(css), 'with tabular figures, so the clock does not jitter as the digits change', 'styles.css');
check(/\.pf-gaming-now\{[^}]*display:flex/.test(css) && /\.pf-gaming-now-name\{[^}]*text-overflow:ellipsis/.test(css),
  'the widget\'s live line is a flex row too, and its name is what gives way', 'styles.css');
check(/\.pf-gaming-now \.game-clock\{[^}]*margin-left:auto/.test(css) && /\.pf-gaming-now \.game-clock\{[^}]*color:inherit/.test(css),
  'with the same clock on its right edge, in the line\'s own ink', 'styles.css');
check(/\.pf-playing\{[^}]*display:flex/.test(css) && !/\.pf-playing \.game-clock/.test(css),
  'and the streaming row (the only .pf-playing left) carries no clock of its own', 'styles.css');

console.log('\n[5] the real stylesheet, in a real browser');
const chrome = findChrome();
if (!chrome) console.log('  (skipped: no Chrome/Edge found — set CHROME_PATH)');
else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-gtimer-'));
  try {
    const htmlPath = path.join(dir, 'page.html');
    fs.writeFileSync(htmlPath, pageHtml(fmt));
    const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=520,900',
      '--virtual-time-budget=4000', '--dump-dom', 'file:///' + htmlPath.replace(/\\/g, '/')],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
    if (!m) check(false, 'the fixture page ran', { status: r.status });
    else {
      const out = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      const near = (a, b, tol) => Math.abs(a - b) <= tol;
      // Both surfaces, same three claims: the clock is running, it sits on the
      // row's right content edge, and a name too long gives way instead of
      // shoving the clock off the row.
      for (const [surface, s, l] of [['the card box', out.short, out.long], ['the widget line', out.pfShort, out.pfLong]]) {
        check(/^\d+:\d\d$/.test(s.text) && /^\d+:\d\d$/.test(l.text),
          surface + '\'s clock is running (M:SS, painted by the shared ticker)', [s.text, l.text]);
        check(near(s.timerRight, s.contentRight, 1.5), surface + '\'s clock sits at its right content edge', { timer: s.timerRight, edge: s.contentRight });
        check(near(l.timerRight, s.timerRight, 1.5),
          'and a name far too long does NOT push it out — measured on ' + surface, { long: l.timerRight, short: s.timerRight });
        check(l.timerLeft > l.nameLeft && l.nameRight <= l.timerLeft + 1,
          surface + ' keeps the name left and the clock right, in that order', l);
        check(l.ellipsised && !s.ellipsised, surface + '\'s long name ellipsises while a name that fits is left alone', { long: l.ellipsised, short: s.ellipsised });
      }
      check(out.gone === null, 'a clock element with no start is removed by the ticker', out.gone);
      check(out.since > 0 && out.painted >= 1 && out.pfPainted >= 1,
        'and the ticker really repainted the value it was handed, on both surfaces', { since: out.since, painted: out.painted, pf: out.pfPainted });
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

console.log('');
if (failures.length) {
  console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log(`All ${passed} checks passed.`);

// The measuring page: the real stylesheet, the real ticker (extracted from
// servers.js, so what runs here is what ships), and the live line on BOTH
// surfaces — the card's game box and the profile's Gaming widget — with a short
// name, one far too long, and (on the card) one with no start at all.
function pageHtml(tickerSrc) {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>*{transition:none!important;animation:none!important}
#usercard{width:260px;background:var(--panel-2)}
.uc-body{padding:10px}
#profile{width:360px;background:var(--panel-2)}
.pf-body{padding:10px}</style></head><body>
<div id="usercard"><div class="uc-body">
  <div class="uc-sub">@jordan</div>
  <div class="uc-status"><span>Online</span></div>
  <div class="uc-statustext ugame" id="short"><span class="gbadge"></span><span class="uc-game-name">Playing Chess</span><span class="game-clock" data-gtimer="__SINCE__" title="Time in this session"></span></div>
  <div class="uc-statustext ugame" id="long"><span class="gbadge"></span><span class="uc-game-name">Playing Sid Meier's Civilization VI: Gathering Storm</span><span class="game-clock" data-gtimer="__SINCE__" title="Time in this session"></span></div>
  <div class="uc-statustext ugame" id="nostart"><span class="gbadge"></span><span class="uc-game-name">Playing Chess</span><span class="game-clock" data-gtimer=""></span></div>
</div></div>
<div id="profile"><div class="pf-body">
  <div class="pf-status"><span>Online</span></div>
  <div class="pf-gaming">
    <div class="pf-gaming-head"><span class="pf-gaming-title">Gaming</span><span class="pf-gaming-total">Lv 3 · 12h</span></div>
    <div class="pf-gaming-now" id="pfshort"><span class="pf-gaming-now-name">Currently playing <b>Chess</b></span><span class="game-clock" data-gtimer="__SINCE__" title="Time in this session"></span></div>
    <div class="pf-gaming-now" id="pflong"><span class="pf-gaming-now-name">Currently playing <b>Sid Meier's Civilization VI: Gathering Storm</b></span><span class="game-clock" data-gtimer="__SINCE__" title="Time in this session"></span></div>
  </div>
</div></div>
<script>
window.S = { voiceSince: new Map() };
window.__painted = 0;
window.__pfPainted = 0;
eval(${JSON.stringify(tickerSrc)});
// Count the ticker's writes to each surface's clock, so "the real interval ran"
// is measured and not assumed.
const count = (sel, key) => {
  const el = document.querySelector(sel);
  new MutationObserver(() => { window[key]++; }).observe(el, { childList: true, characterData: true, subtree: true });
};
count('#long .game-clock', '__painted');
count('#pflong .game-clock', '__pfPainted');
const rect = (el) => el.getBoundingClientRect();
const measure = (boxSel, nameSel) => {
  const box = document.querySelector(boxSel);
  const cs = getComputedStyle(box);
  const t = box.querySelector('.game-clock');
  const n = box.querySelector(nameSel);
  return {
    text: t ? t.textContent : null,
    timerRight: t ? rect(t).right : null,
    timerLeft: t ? rect(t).left : null,
    nameLeft: rect(n).left,
    nameRight: rect(n).right,
    contentRight: rect(box).right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth),
    ellipsised: n.scrollWidth > n.clientWidth + 1,
  };
};
// AFTER the ticker has had a few seconds of virtual time: measuring at parse
// time would read the pre-tick DOM and prove nothing about the clock.
setTimeout(() => {
  const out = {
    short: measure('#short', '.uc-game-name'),
    long: measure('#long', '.uc-game-name'),
    pfShort: measure('#pfshort', '.pf-gaming-now-name'),
    pfLong: measure('#pflong', '.pf-gaming-now-name'),
  };
  out.gone = document.querySelector('#nostart .game-clock') ? 'present' : null;
  out.since = Number(document.querySelector('#long .game-clock').dataset.gtimer);
  out.painted = window.__painted;
  out.pfPainted = window.__pfPainted;
  document.title = JSON.stringify(out);
}, 2500);
</script></body></html>`.replace(/__SINCE__/g, String(Date.now() - 65000));
}
