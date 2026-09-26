// The user card + profile screen show the user's local time, from the IANA
// zone their client reports (POST /api/me/timezone).
//
// Offline: reads the shipped source for the contracts (migration, column list,
// serialization, endpoint, client wiring, styles, SW cache bump) and executes
// the real fmtLocalTime / localTimeRowHTML out of core.js's source with a
// stubbed esc() — the functions are pure (Intl only), so extraction tests the
// shipped code, not a copy.
//
// Usage: node scripts/test-localtime.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const db = src('db.js');
const server = src('server.js');
const core = src('public/js/core.js');
const pickers = src('public/js/pickers.js');
const socket = src('public/js/socket.js');
const auth = src('public/js/auth.js');
const css = src('public/styles.css');
const sw = src('public/service-worker.js');

// ---------- server contract ----------
check('migration adds users.timezone', /addColumn\('users',\s*'timezone',\s*'TEXT'\)/.test(db));
check('USER_COLS selects timezone', /USER_COLS\s*=\s*'[^']*\btimezone\b/.test(server));
check('publicUser serializes timezone', /timezone:\s*u\.timezone\s*\|\|\s*null/.test(server));
check('POST /api/me/timezone endpoint exists', /app\.post\('\/api\/me\/timezone'/.test(server));
check('endpoint validates against ICU zones', /new Intl\.DateTimeFormat\('en-US',\s*\{\s*timeZone:\s*tz\s*\}\)/.test(server));
check('endpoint rejects empty timezone', /timezone_required/.test(server));
check('endpoint rejects bad timezone', /bad_timezone/.test(server));
check('timezone change broadcasts user-updated', (() => {
  const i = server.indexOf("app.post('/api/me/timezone'");
  const block = server.slice(i, i + 1200);
  return /broadcastUserUpdate/.test(block) && /notifyUser/.test(block);
})());

// ---------- client contract ----------
for (const fn of ['fmtLocalTime', 'localTimeRowHTML', 'tickLocalTimes', 'reportTimezone', 'LOCALTIME_CLOCK_SVG']) {
  check('core.js defines ' + fn, core.includes(fn));
}
check('no emoji in the clock (SVG per chrome rules)', !/\u{1F550}|\u{1F550}/u.test(core.slice(core.indexOf('LOCALTIME_CLOCK_SVG'), core.indexOf('LOCALTIME_CLOCK_SVG') + 400)));
check('user card paints the local-time row', pickers.includes("localTimeRowHTML(u, 'uc-localtime')"));
check('profile paints the local-time row', pickers.includes("localTimeRowHTML(u, 'pf-localtime')"));
check('refreshUserCardLocalTime exists', /function refreshUserCardLocalTime/.test(pickers));
check('refreshProfileLocalTime exists', /function refreshProfileLocalTime/.test(pickers));
check('socket refreshes card time on user-updated', socket.includes('refreshUserCardLocalTime(u)'));
check('socket refreshes profile time on user-updated', socket.includes('refreshProfileLocalTime(u)'));
check('boot reports the IANA zone', auth.includes('reportTimezone()'));
check('styles: .uc-localtime', /\.uc-localtime\{/.test(css));
check('styles: .pf-localtime', /\.pf-localtime\{/.test(css));
check('card row reads --uc-faint on custom backdrops', /#usercard \.uc-localtime\{color:var\(--uc-faint\)\}/.test(css));
check('SW cache bumped for the frontend change', /const CACHE = 'campfire-v707'/.test(sw));

// ---------- extracted pure functions, executed for real ----------
function extract(re, name) {
  const m = core.match(re);
  check('extract ' + name + ' from core.js', !!m);
  return m && m[0];
}
const escStub = `function esc(s){return String(s??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}\n`;
const fmtSrc = extract(/function fmtLocalTime\(tz, d = new Date\(\)\) \{[\s\S]*?\n\}/, 'fmtLocalTime');
const rowSrc = extract(/function localTimeRowHTML\(u, cls\) \{[\s\S]*?\n\}/, 'localTimeRowHTML');
const clockSrc = extract(/const LOCALTIME_CLOCK_SVG = '.*?';/, 'LOCALTIME_CLOCK_SVG');
if (fmtSrc && rowSrc && clockSrc) {
  const fns = new Function(escStub + fmtSrc + '\n' + clockSrc + '\n' + rowSrc + '\nreturn { fmtLocalTime, localTimeRowHTML };')();
  const { fmtLocalTime, localTimeRowHTML } = fns;
  const fixed = new Date('2026-01-15T12:00:00Z'); // 7:00 AM EST, 9:00 PM JST — deterministic
  check('fmtLocalTime renders a zone time', fmtLocalTime('America/New_York', fixed).includes('7:00'));
  check('fmtLocalTime differs across zones', fmtLocalTime('America/New_York', fixed) !== fmtLocalTime('Asia/Tokyo', fixed));
  check('fmtLocalTime Tokyo renders 9:00', fmtLocalTime('Asia/Tokyo', fixed).includes('9:00'));
  check('fmtLocalTime empty zone -> hidden', fmtLocalTime('') === '' && fmtLocalTime(null) === '');
  check('fmtLocalTime garbage zone -> hidden', fmtLocalTime('Not/AZone') === '');
  const row = localTimeRowHTML({ timezone: 'America/New_York' }, 'uc-localtime');
  check('row carries the class', row.includes('class="uc-localtime"'));
  check('row carries data-tz for the ticker', row.includes('data-tz="America/New_York"'));
  check('row has an SVG clock, no emoji', row.includes('<svg') && !/[\u{1F300}-\u{1FAFF}]/u.test(row));
  check('row has the time span the ticker repaints', row.includes('class="lt-time"'));
  check('row without a zone renders nothing', localTimeRowHTML({}, 'uc-localtime') === '' && localTimeRowHTML({ timezone: 'Bogus/Zone' }, 'pf-localtime') === '');
  // Garbage never reaches the HTML at all (fmtLocalTime rejects it first), and
  // no Intl-valid zone contains HTML-special chars — the esc(tz) in the row is
  // defense in depth. Pin that it's there:
  check('zone is escaped in data-tz (defense in depth)', /data-tz="\$\{esc\(tz\)\}"/.test(rowSrc));
}

// ---------- the server's own validation rule, exercised ----------
function validZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date()); return true; }
  catch { return false; }
}
check('validation accepts America/New_York', validZone('America/New_York'));
check('validation accepts Pacific/Auckland', validZone('Pacific/Auckland'));
check('validation rejects empty', !validZone(''));
check('validation rejects garbage', !validZone('Not/AZone'));
check('validation rejects SQL-ish junk', !validZone("'; DROP TABLE users; --"));

// ---------- cross-file top-level collision guard ----------
// Two top-level `const`/`let`/`class` with the same name in different scripts
// is a SyntaxError that kills every script after the second one (2026-09-26:
// CLOCK_SVG in core.js collided with actions.js and stuck the app on the boot
// splash because final.js never ran). `function` redeclaration is legal, so
// only const/let/class are checked.
{
  const seen = new Map();
  const dupes = [];
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'public', 'js'))) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8');
    for (const m of src.matchAll(/^(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      if (seen.has(m[1])) dupes.push(`${m[1]} (in ${seen.get(m[1])} and ${f})`);
      else seen.set(m[1], f);
    }
  }
  check('no duplicate top-level const/let/class across scripts' + (dupes.length ? ': ' + dupes.join('; ') : ''), dupes.length === 0);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);

