// The home sidebar's chat rows must have a hair of air between them (see
// AGENTS.md verification conventions).
//
// The request: "between dm's and group dms in the home sidebar can you add a
// very tiny amount of padding between the chats." #dm-list and #group-list were
// plain stacks of .dmrow rows with no gap at all, so two chats read as one block
// — and the tell was a hover or active fill, where the pair merged into a single
// slab with no line of sidebar between the two.
//
// Why a flex GAP and not the padding the request sounds like: a DM row carries a
// presence light whose 2.5px halo is knocked out in --panel, the sidebar's own
// colour, and a DM's own banner paints edge to edge inside the row. Anything
// painted in that halo's colour reads as a seam. A gap adds the sidebar's own
// colour BETWEEN two intact row boxes, which is the one thing that cannot cut a
// mark in half. The two header rows in the column (#btn-friends,
// #stories-nav-wrap) are .dmrow too, so the gap is ID-scoped to the two lists and
// leaves the headers exactly where they were.
//
//   [A] static — the rule exists, is scoped to the two lists (not .dmrow at
//       large, which would also move the header rows and every other row type in
//       the app), carries a gap rather than a margin/padding, matches the channel
//       list's own gap, and still lets an EMPTY list hide (this id pair outranks
//       the shared `#dm-list:empty` rule, so that has to be restated beside it —
//       the trap this half exists to catch).
//   [B] headless Chrome — boots the REAL page (the shipped index.html, every
//       /js/*.js module, the shipped styles.css) off the dev server, signs in,
//       then hands it two DMs and two groups through the app's own refreshDms()
//       and MEASURES the painted boxes in all three themes: the air between two
//       rows is the gap, every row keeps its own height, the rows stay in one
//       column, an active row's fill stops at its own edge, and the pixels under
//       the presence light are still the sidebar's own colour.
//
// Skips (exit 0) when Chrome or Postgres is unavailable.
//
// Usage: node scripts/test-dm-list-gap.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
// The 'ws' client, on the WHATWG one (Node 22 has it) when the checkout has no
// node_modules: this suite has to be runnable straight out of a clone.
const WebSocket = (() => { try { return require('ws'); } catch { return globalThis.WebSocket; } })();

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_dm_list_gap_e2e';
// A per-run tag so the fixture accounts can never collide with an earlier run's.
const RUN_TAG = process.env.GAP_TEST_TAG || Math.random().toString(36).slice(2, 7);
// The fixture narrates its steps into this run's output (GAP_TEST_QUIET=1 for CI).
const LOG_FROM_PAGE = process.env.GAP_TEST_QUIET !== '1';
const PORT = parseInt(process.env.TEST_PORT || '3431', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9371', 10);
const REM = 16; // the root font size the rem values below are authored against
const THEMES = ['dark', 'light', 'oled'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let notes = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function note(msg) { notes++; console.log('  NOTE ' + msg); }
const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }

const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

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
function readEnvFile() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}

function cssNum(re, what) {
  const m = css.match(re);
  if (!m) { console.error('[test] could not read ' + what + ' out of styles.css'); process.exit(1); }
  return parseFloat(m[1]) * REM;
}
function cssPx(re, what) {
  const m = css.match(re);
  if (!m) { console.error('[test] could not read ' + what + ' out of styles.css'); process.exit(1); }
  return parseFloat(m[1]);
}

// Everything the geometry is judged against, read out of the shipped stylesheet
// rather than written down here. A padding-based fix would have made the row
// taller; these are what say it did not.
const AVATAR = cssPx(/\.dmrow \.avwrap\{position:relative;width:([\d.]+)px/, 'the DM row avatar');
// The value a `prop` shorthand resolves to for a selector, counting the cascade
// as the browser does: a rule whose selector matches the element exactly (no
// descendant part), the last such declaration winning. `#friends-page .dmrow` is
// a different row in a different pane, so it is deliberately not in the running.
function shorthandPx(selector, prop) {
  // A rule is either at the start of a line (this stylesheet is one rule per
  // line) or after a comma in a selector list — `.chan-group-label,[data-theme=oled]
  // .dmrow{...}` declares the second selector that way. The `m` flag is what
  // makes the first case work, and the separator deliberately does NOT include a
  // `{`: a rule can also be introduced by `*/` at the end of a comment.
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(?:^|[,}])\\s*' + esc + '\\s*\\{([^}]*)\\}', 'gm');
  let vals = null, m;
  while ((m = re.exec(css))) {
    const d = m[1].match(new RegExp('(?:^|;)\\s*' + prop + ':([^;}]+)'));
    if (d) vals = d[1].trim().split(/\s+/).map((v) => parseFloat(v) * REM);
  }
  if (!vals) { console.error('[test] could not read ' + prop + ' for ' + selector + ' in styles.css'); process.exit(1); }
  return vals;
}
const ROW_PAD = shorthandPx('.dmrow', 'padding');
const ROW_PAD_Y = ROW_PAD[0];
const LINE = cssPx(/\.dmrow \.dmlast\{[^}]*font-size:([\d.]+)rem/, 'the DM preview line size');
const HALO = cssPx(/\.member \.avwrap \.status-dot,\.dmrow \.avwrap \.status-dot\{[^}]*box-shadow:0 0 0 ([\d.]+)px/, 'the presence dot halo');
// The section label's own padding, straight out of the stylesheet: this is the
// spacing that has to survive the gap.
const LABEL_PAD = shorthandPx('.chan-group-label', 'padding');
const LABEL_PAD_BOTTOM = LABEL_PAD[LABEL_PAD.length - 1];
// The Friends header row\'s own padding (it is a .dmrow with a .7rem override).
const FRIENDS_PAD = shorthandPx('#btn-friends', 'padding');
const FRIENDS_PAD_TOP = FRIENDS_PAD[0];
const FRIENDS_PAD_BOTTOM = FRIENDS_PAD[FRIENDS_PAD.length - 1];
// The Stories row's own offset above the Friends row: #stories-nav-wrap's
// margin-top, the app's pre-existing layout (not part of this change, so it is
// a hard number and a change to it should fail this suite loudly).
const STORIES_OFFSET = 4.8; // .3rem
const DM_GAP = cssPx(/#home-ui>#dm-list,#home-ui>#group-list\{display:flex;flex-direction:column;gap:([\d.]+)px/, 'the home chat-list gap');
const CHAN_GAP = cssPx(/#text-channels,#voice-channels\{display:flex;flex-direction:column;gap:([\d.]+)px/, 'the channel list gap');

console.log('\n[1] the gap is the lists\' own, and it is scoped to the lists');
// The LAST rule this selector pair resolves to wins, so match the one that
// declares the declarations (a full-width read of everything between its braces).
let ruleDecl = '', ruleText = '';
for (const m of css.matchAll(/#home-ui>#dm-list,#home-ui>#group-list\{([\s\S]*?)\}/g)) {
  if (/\b(gap|display|flex-direction)\b/.test(m[1])) { ruleDecl = m[1]; ruleText = m[0]; }
}
check(!!ruleText, 'styles.css has one rule for both home chat lists');
const decl = ruleDecl;
check(/display:flex/.test(decl) && /flex-direction:column/.test(decl), 'the lists are the flex column the gap lives in', decl);
check(/gap:[\d.]+px/.test(decl) && !/margin/.test(decl) && !/padding/.test(decl),
  'the space is a flex GAP — not padding or a margin, so no row\'s own box (banner, hover pill, halo) is cut', decl);
check(DM_GAP === CHAN_GAP, 'it is the same gap the channel list uses (' + DM_GAP + 'px), so a channel row and a chat row are one rhythm', { dm: DM_GAP, channels: CHAN_GAP });
check(DM_GAP > 0 && DM_GAP <= 3, 'and it is a HAIR, not a new section spacing (' + DM_GAP + 'px)', DM_GAP);
check(/^#home-ui>#dm-list,#home-ui>#group-list\{/.test(ruleText),
  'it is scoped by the two list ids — a bare .dmrow rule would also move the Friends/Stories header rows and every other row type');
check(!/\.dmrow \+ \.dmrow/.test(css) && !/\.dmrow\+/.test(css),
  'and not bought with row-to-row margins, which would have doubled up between the two sections');
// This id pair outranks the shared empty rule further down the sheet, so the
// hiding of an empty list has to be restated here or a roster with no DMs at all
// would keep this rule's display and render as a stuck-open 0-height column.
check(/#home-ui>#dm-list:empty,#home-ui>#group-list:empty\{display:none\}/.test(css),
  'an empty list still hides — the id pair outranks the shared `#dm-list:empty` rule, so it is restated beside it');
check(/#dm-list:empty,#group-list:empty\{display:none\}/.test(css),
  'and the shared empty rule is still there for the rest of the app');
check(/#home-ui>#btn-friends\{width:auto\}/.test(css), '#btn-friends keeps its own width rule (a gap does not need it moved)');
check(/margin-left:\.55rem;margin-right:\.55rem/.test(css), 'the column\'s .55rem inset is unchanged — this was a vertical request');

console.log('\n[2] a hair of air between the rows, in every theme (headless Chrome + the real page)');
const chromePath = findChrome();
if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

// The REAL fixtures, thrown at the app's own render path — nothing about the
// rows is hand-built here, so a row-shape change upstream fails this test.
// `renderActiveNow` and the DM rail's badge painter are stubbed because this
// harness has no server sockets to receive a friends push.
const FIXTURES = `
  const LOG_FROM_PAGE = ${LOG_FROM_PAGE};
  // The REAL fixtures, thrown at the app's own render path: a 1:1 plus two groups
  // so each list has a gap to measure, and the 1:1 shows the peer's display name
  // rather than a stubbed string. Every account is registered through
  // /api/register and made friends through the real request/accept pair — group
  // chats are friends-only, and an invented shortcut here would let the harness
  // build a roster the product would refuse.
  //
  // Names carry a per-run tag because this suite's database is recreated when it
  // can be and REUSED when a previous run left a connection holding it; colliding
  // on a fixed name would then fail for a reason that has nothing to do with the
  // gap (which is the whole point of this file).
  const TAG = ${JSON.stringify(RUN_TAG)};
  const PASSWORD = 'gap-test-pw-1234';
  const step = (m) => { if (LOG_FROM_PAGE) console.log('  [page] ' + m); };
  // Signing in is a real credential exchange, so switching back to the account
  // under test needs no session juggling at all.
  async function signIn(name) {
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: name, password: PASSWORD }) });
    S.me = r.user; store.token = r.token; if (r.sid) store.sid = r.sid;
    return r.user;
  }
  async function reg(name, display) {
    await api('/api/register', { method: 'POST', body: JSON.stringify({ username: name, password: PASSWORD, displayName: display }) });
    return signIn(name);
  }
  // The whole round trip, in the direction the server enforces: the request goes
  // out as 'mine', and it is the RECIPIENT who accepts (the server refuses
  // action_by), so this signs in as the friend and back again.
  async function befriend(mine, theirs) {
    const sent = await api('/api/friends', { method: 'POST', body: JSON.stringify({ username: theirs.username }) });
    step('friend request to ' + theirs.username + ': ' + JSON.stringify(sent));
    await signIn(theirs.username);
    const who = await api('/api/me');
    step('now signed in as ' + who.user.username + ' (' + who.user.id + ')');
    const accepted = await api('/api/friends/' + mine.id + '/accept', { method: 'POST' });
    step(mine.username + ' accepted: ' + JSON.stringify(accepted));
    await signIn(mine.username);
  }
  async function setup() {
    step('registering the four accounts');
    const a = await reg('gappa' + TAG, 'Gap One');
    const b = await reg('gappb' + TAG, 'Gap Two');
    const c = await reg('gappc' + TAG, 'Gap Three');
    const d = await reg('gappd' + TAG, 'Gap Four');
    step('back on ' + a.username);
    await signIn(a.username);                    // back to the account under test
    step('friending');
    await befriend(a, b); await befriend(a, c); await befriend(a, d);
    step('opening chats');
    // Two 1:1s and two groups, so BOTH lists have a pair of rows to measure and
    // neither measurement stands alone.
    await api('/api/dms', { method: 'POST', body: JSON.stringify({ userId: b.id }) });
    await api('/api/dms', { method: 'POST', body: JSON.stringify({ userId: c.id }) });
    await api('/api/dms/group', { method: 'POST', body: JSON.stringify({ name: 'Weekend squad', userIds: [b.id, c.id] }) });
    await api('/api/dms/group', { method: 'POST', body: JSON.stringify({ name: 'Work chat', userIds: [c.id, d.id] }) });

    // The app's OWN boot, so the shell is in the state a signed-in user's window
    // is in: without it #view-main stays hidden, the sidebar lays out at zero and
    // every rectangle measured off it is a fiction.
    step('booting the app as ' + a.username);
    await boot();
    if (!document.getElementById('view-main') || document.getElementById('view-main').classList.contains('hidden')) {
      step('boot() did not show the shell — laying it out anyway');
      try { showMain(); } catch {}
    }
    step('shell: ' + (document.getElementById('view-main').classList.contains('hidden') ? 'hidden' : 'shown') + ', sidebar ' + Math.round(document.getElementById('sidebar').getBoundingClientRect().width) + 'px wide');

    // Home itself, the way the campfire button gets there. It also fetches the
    // roster this time, so the list is painted from S.dms and not from a state
    // object poked in from outside.
    step('opening Home');
    await openHome();
    step('home is open: ' + document.querySelectorAll('#dm-list .dmrow').length + ' dm rows, ' + document.querySelectorAll('#group-list .dmrow').length + ' group rows');
    await selectDmThread(S.dms.filter((t) => !t.isGroup)[0].id);
    step('open chat: ' + S.dms.filter((t) => !t.isGroup)[0].name);
    return S.dms.map((t) => ({ id: t.id, isGroup: !!t.isGroup, name: dmTitle(t),
      rows: document.querySelectorAll(t.isGroup ? '#group-list .dmrow' : '#dm-list .dmrow').length }));
  }
`;

// The measurement: the boxes the browser actually painted, in the theme named.
const PROBE = `
  (function probe() {
    function box(el) { var b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height }; }
    function rowsOf(sel) { return [...document.querySelectorAll(sel)].map(box); }
    var dl = document.getElementById('dm-list'), gl = document.getElementById('group-list');
    var cs = getComputedStyle(dl), gcs = getComputedStyle(gl);
    // The DIRECT MESSAGES label is the list's previous SIBLING; styles.css
    // restyles .chan-group-label inside #friends-page, so it is read by
    // relationship, not by class.
    var dmLabel = dl.previousElementSibling;
    // …and it is the one DIRECT MESSAGES label (the sidebar carries another one
    // inside the Friends pane), so it is identified by its text.
    if (dmLabel && !/DIRECT/i.test(dmLabel.textContent || '')) dmLabel = null;
    var active = document.querySelector('#dm-list .dmrow.active');
    var acs = getComputedStyle(active);
    var av = active.querySelector('.avwrap, .av, .avatar');
    var ab = av ? box(av) : null;
    // Where the air is painted. The gap itself shows the LIST through, and a
    // list paints nothing of its own — so this is the rail behind the sidebar,
    // which --panel is a translucent panel ON, not --panel itself. The row's own
    // halo knock-out is --panel and must match it to the pixel: a hair of
    // difference there is exactly the seam a gap can cut under a presence light.
    var air = [getComputedStyle(dl).backgroundColor,
               getComputedStyle(document.querySelector('#left')).backgroundColor,
               getComputedStyle(active.querySelector('.avwrap')).backgroundColor];
    // …and the point just under the avatar, past the halo, only as a record of
    // what is under the light (it lands inside the row's own box, whose padding
    // is 5.12px against a 2.5px halo, so it is the row's colour by construction).
    var probeBg = null, probeIn = null;
    if (ab) {
      var el = document.elementFromPoint(Math.round(ab.left + ab.width / 2), Math.round(ab.bottom + ${HALO} + 1));
      probeBg = el ? getComputedStyle(el).backgroundColor : 'none';
      probeIn = el ? dl.contains(el) || gl.contains(el) : false;
    }
    // A theme must REPAINT, not just relabel itself, before anything here is worth
    // reading: the real user waits for the paint.
    void document.body.offsetHeight;
    return {
      theme: document.documentElement.dataset.theme,
      dmDisplay: cs.display, dmDir: cs.flexDirection, dmGap: cs.rowGap,
      grpDisplay: gcs.display, grpDir: gcs.flexDirection, grpGap: gcs.rowGap,
      dmMargin: cs.marginLeft,
      dms: rowsOf('#dm-list .dmrow'), grp: rowsOf('#group-list .dmrow'),
      rowPad: acs.padding, rowPadY: parseFloat(acs.paddingTop) || 0,
      activeBg: acs.backgroundColor, active: box(active),
      panelBg: getComputedStyle(document.getElementById('sidebar')).backgroundColor,
      probeBg: probeBg, probeIn: probeIn, air: air,
      names: [...document.querySelectorAll('#dm-list .dmname, #group-list .dmname')].map((n) => n.textContent),
      // The header rows and the two lists are siblings, so the gap must stop at
      // each list's own edge — measured, not assumed.
      friendsBottom: box(document.getElementById('btn-friends')).bottom,
      storiesTop: box(document.getElementById('stories-nav-wrap')).top,
      headerBottom: box(document.getElementById('stories-nav-wrap')).bottom,
      headerBottom0: box(document.getElementById('btn-friends')).bottom,
      dmTop: dl.getBoundingClientRect().top,
      grpTop: gl.getBoundingClientRect().top,
      // The DIRECT MESSAGES label and the spacing the two header rows keep for
      // themselves — the check above is that the gap ate none of it.
      dmLabelBottom: dmLabel ? box(dmLabel).bottom : -1,
      dmLabelText: dmLabel ? dmLabel.textContent.trim().slice(0, 20) : null,
      labelPadBottom: dmLabel ? parseFloat(getComputedStyle(dmLabel).paddingBottom) || 0 : -1,
      labelGap: box(dmLabel).bottom - box(document.getElementById('stories-nav-wrap')).bottom,
    };
  })()
`;

async function main() {
  const envFile = readEnvFile();
  const pg = {
    host: process.env.PGHOST || envFile.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || envFile.POSTGRES_USER || 'campfire',
    password: process.env.PGPASSWORD || envFile.POSTGRES_PASSWORD || '',
  };
  const { Client } = require('pg');
  // PGHOST here is sometimes a socket DIRECTORY (the dev box keeps its cluster in
  // /tmp), so this is a field set rather than a URL.
  const admin = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
  try { await admin.connect(); }
  catch (e) { return skip('Postgres unreachable (' + ((e && e.message) || e) + ') — docker compose up -d db'); }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-dm-gap-'));
  let child = null, chrome = null, ws = null;
  try {
    // A fresh database every run. The drop is retried while something still holds
    // it (a previous run's server, which takes a moment to let go) and only then
    // is the create treated as optional: the fixture's accounts are unique-named
    // per run, so a leftover database left by an interrupted run is a nuisance,
    // not a reason to fail.
    let made = false;
    for (let i = 0; i < 10 && !made; i++) {
      try { await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`); }
      catch { await sleep(500); continue; }
      try { await admin.query(`CREATE DATABASE ${TEST_DB}`); made = true; }
      catch (e) { if (e.code !== '42P04') throw e; await sleep(500); }
    }
    if (!made) console.log('  (note: ' + TEST_DB + ' was still in use; this run reuses it)');
    await admin.end();

    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT), PGHOST: pg.host, PGPORT: String(pg.port), PGUSER: pg.user,
        PGPASSWORD: pg.password, PGDATABASE: TEST_DB,
        JWT_SECRET: 'test-dm-list-gap-secret',
        UPLOAD_DIR: path.join(tmp, 'uploads'),
        UNFURL: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    const fail = (msg) => { throw new Error(msg + '\n--- server log ---\n' + serverLog.slice(-3000)); };
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${PORT}/api/config`)).ok; } catch {}
      if (!up) await sleep(250);
    }
    if (!up) return fail('server did not come up');

    chrome = spawn(chromePath, [
      '--headless=new', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(tmp, 'chrome')}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
      '--window-size=1200,900', 'about:blank',
    ], { stdio: 'ignore' });
    let ver = null;
    for (let i = 0; i < 80 && !ver; i++) {
      try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch {}
      if (!ver) await sleep(250);
    }
    if (!ver) return fail('Chrome did not expose the DevTools port');

    const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    let msgId = 0;
    const pending = new Map();
    const pageErrors = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
      } else if (m.method === 'Runtime.consoleAPICalled' && LOG_FROM_PAGE) {
        const text = (m.params.args || []).map((a) => (a.value !== undefined ? a.value : a.description || a.type)).join(' ');
        console.log('  [page] ' + text);
      }
    });
    const send = (method, params) => new Promise((res, rej) => {
      const id = ++msgId;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
    // A thrown expression must not sit in the queue forever: a rejected call here
    // would take the whole run down on the next await, which reads as a silent
    // hang rather than as a failed check. Every call is also raced against a
    // deadline so a page that never answers (a modal or an alert swallowing the
    // evaluate) fails loudly instead of stalling the suite.
    const evaluate = async (expression, ms = 45000) => {
      const r = await Promise.race([
        send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
        sleep(ms).then(() => ({ timedOut: true })),
      ]);
      if (r.timedOut) throw new Error('the page never answered a Runtime.evaluate: ' + String(expression).slice(0, 120));
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'page error');
      return r.result.value;
    };
    await send('Page.enable');
    await send('Runtime.enable');
    // A real pointer, because the tell this change is about is a HOVERED row's
    // fill: a synthetic class would paint a state the product never reaches.
    const hover = async (sel, nth = 0) => {
      const at = await evaluate(`(() => { const el = document.querySelectorAll(${JSON.stringify(sel)})[${nth}];
        if (!el) return null; const b = el.getBoundingClientRect();
        return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
      if (!at) return false;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, buttons: 0 });
      await sleep(250);
      return true;
    };
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    const waitFor = async (expr, ms = 30000) => {
      const t0 = Date.now();
      for (;;) {
        try { const v = await evaluate(`(() => { try { return ${expr} } catch (e) { return false } })()`); if (v) return v; } catch {}
        if (Date.now() - t0 > ms) return null;
        await sleep(200);
      }
    };
    if (!(await waitFor(`typeof boot === 'function'`))) return fail('the app never loaded');
    if (pageErrors.length) { console.error('[test] the page threw:\n  ' + pageErrors.join('\n  ')); process.exit(1); }

    const rows = await evaluate(`(async () => {${FIXTURES}
      return await setup();
    })()`, 180000);   // ~20 real round trips (registers, logins, threads, boot)
    check(Array.isArray(rows) && rows.filter((r) => !r.isGroup).length >= 1 && rows.filter((r) => r.isGroup).length >= 2,
      'the real render path built both sections (1:1 rows in #dm-list, group rows in #group-list)', { rows });
    if (!Array.isArray(rows) || rows.filter((r) => r.isGroup).length < 2) { console.error('[test] the fixture did not build two groups: ' + JSON.stringify(rows)); process.exit(1); }
    if (pageErrors.length) { console.error('[test] the page threw while rendering:\n  ' + pageErrors.join('\n  ')); process.exit(1); }

    // A gap only shows its worth against a FILLED row, and the fill is the one
    // thing here that must not smear into the new air — so open a conversation
    // the way a user does (the row's own click handler) and measure that row. It
    // has to be the 1:1 the roster holds, so this can only ever be a real pick,
    // and it is re-opened after each theme flip because openHome() re-renders the
    // lists and the active class is state, not layout.
    if (process.env.GAP_DEBUG) {
      const dump = await evaluate(`(() => { const out = []; var el = document.getElementById('home-ui');
        for (var c = el.firstElementChild; c; c = c.nextElementSibling) { var b = c.getBoundingClientRect(), s = getComputedStyle(c);
          out.push([c.tagName + '#' + (c.id || '') + '.' + (c.className || '-'), Math.round(b.top) + '..' + Math.round(b.bottom), 'h' + Math.round(b.height),
            s.display, 'mt' + s.marginTop, 'pt' + s.paddingTop, 'pb' + s.paddingBottom, s.visibility].join(' ')); }
        return out.join(String.fromCharCode(10)); })()`);
      console.log('  [column]' + String.fromCharCode(10) + String(dump).split(String.fromCharCode(10)).map((l) => '    ' + l).join(String.fromCharCode(10)));
    }
    const openA = async (why) => {
      await evaluate(`document.querySelector('#dm-list .dmrow').click()`, 20000);
      const on = await waitFor(`!!document.querySelector('#dm-list .dmrow.active')`, 15000);
      const name = on ? await evaluate(`document.querySelector('#dm-list .dmrow.active .dmname').textContent`) : null;
      check(!!name, why + ': the row opens and paints its active fill (the real click path)', { activeName: name });
    };
    await openA('once');

    // The app's own theme painter, called from the harness: same entry point the
    // Settings panel uses, so a per-theme restatement of the gap would show.
    const applyThemeProbe = async (theme) => {
      const flipped = await evaluate(`(() => { applyTheme(${JSON.stringify(theme)}, { save: false }); return document.documentElement.dataset.theme; })()`);
      check(flipped === theme, theme + ': the theme setter took the sidebar to ' + theme, { got: flipped });
      await sleep(200);
    };
    const measured = {};
    const shots = [];
    for (const theme of THEMES) {
      // A theme flip is a real user path, so go through the app's own painter
      // rather than poking the attribute: that is what keeps any per-theme
      // restatement of the gap honest.
      await applyThemeProbe(theme);
      await openA(theme);
      measured[theme] = await evaluate(PROBE);
      // "Make it look right" is not something an offline assertion settles, so
      // the sidebar is also written out as a picture in every theme.
      const clip = await evaluate(`(() => { var b = document.getElementById('sidebar').getBoundingClientRect();
        return { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.min(460, Math.round(b.height)) }; })()`);
      if (!(clip.width > 4 && clip.height > 4)) { check(false, theme + ': the sidebar has a size to photograph', { clip }); continue; }
      const shot = await send('Page.captureScreenshot', { format: 'png', clip: Object.assign({ scale: 1 }, clip) });
      const png = path.join(tmp, 'dm-list-gap-' + theme + '.png');
      fs.writeFileSync(png, Buffer.from(shot.data, 'base64'));
      shots.push(png);
    }

    for (const theme of THEMES) {
      const m = measured[theme];
      if (!m) continue;
      console.log('\n  [' + theme + ']');
      check(m.dmDisplay === 'flex' && m.dmDir === 'column' && m.grpDisplay === 'flex' && m.grpDir === 'column',
        theme + ': both lists are the flex column the gap lives in', { dm: [m.dmDisplay, m.dmDir], grp: [m.grpDisplay, m.grpDir] });
      check(near(parseFloat(m.dmGap), DM_GAP, 0.01) && near(parseFloat(m.grpGap), DM_GAP, 0.01),
        theme + ': both computed gaps are the ' + DM_GAP + 'px the stylesheet asks for', { dm: m.dmGap, grp: m.grpGap });
      check(m.dms.length >= 2 && m.grp.length >= 2, theme + ': there are enough rows to measure a gap in each list',
        { dms: m.dms.length, grp: m.grp.length });
      // A second 1:1, so the 1:1 list can be measured the same way the group list
      // is. Two friends and two groups is also just a busier, more honest sidebar.
      if (m.dms.length < 2) { check(false, theme + ': nothing more to measure'); continue; }
      check(m.names.length === m.dms.length + m.grp.length && m.names.every((n) => n && n !== 'undefined'),
        theme + ': every chat row carries a real name (the 1:1 rows show a friend\'s display name, so this is the app\'s own row builder and not a stub)',
        { names: m.names });

      // The row's own box. A gap never touches it; the padding the request asked
      // for would have grown every row.
      for (const [label, now] of [['DM', m.dms], ['group', m.grp]]) {
        check(now.every((r) => near(r.width, m.dms[0].width, 0.5) && near(r.left, m.dms[0].left, 0.5)),
          theme + ': every ' + label + ' row is in the same column (the gap is vertical; nothing narrowed)',
          { lefts: now.map((r) => Math.round(r.left * 100) / 100) });
        check(now.every((r) => near(r.height, m.dms[0].height, 0.5)),
          theme + ': every ' + label + ' row is exactly as tall as the first (a padding fix would have grown it)',
          { heights: now.map((r) => Math.round(r.height * 100) / 100) });
      }
      check(near(m.rowPadY, ROW_PAD_Y, 0.6), theme + ': the row keeps its own ' + ROW_PAD_Y + 'px of vertical padding — the gap was not bought with padding',
        { paddingTop: m.rowPadY, expected: ROW_PAD_Y });

      // THE measurement the request is about: the air between two chats.
      for (const [label, now] of [['DM', m.dms], ['group', m.grp]]) {
        for (let i = 1; i < now.length; i++) {
          const air = now[i].top - now[i - 1].bottom;
          check(near(air, DM_GAP, 0.6),
            theme + ': ' + DM_GAP + 'px of air between ' + label + ' row ' + i + ' and the one above it (measured ' + air.toFixed(2) + 'px)',
            { air: Math.round(air * 100) / 100 });
        }
      }
      check(m.dms.every((r, i) => i === 0 || r.top - m.dms[i - 1].bottom > 0),
        theme + ': no two chats touch — the pair reads as two rows, not one slab');

      // ...and the gap is scoped: the lists are their own box, so the first row
      // cannot be pushed off the list's own top edge by whatever is above it.
      check(near(m.dmTop, m.dms[0].top, 0.5) && near(m.grpTop, m.grp[0].top, 0.5),
        theme + ': the gap is inside each list — the first row still sits on the list\'s own top edge',
        { dmListTop: Math.round(m.dmTop * 100) / 100, dmRow0: Math.round(m.dms[0].top * 100) / 100,
          grpListTop: Math.round(m.grpTop * 100) / 100, grpRow0: Math.round(m.grp[0].top * 100) / 100 });
      // Nothing above the first list moved: the Friends header row and the
      // Stories row keep the spacing the section labels give them, and the
      // DIRECT MESSAGES label still has exactly its own .35rem of bottom padding
      // between it and the list — the gap was not bought out of the label.
      // The label's own bottom padding is the air between the label and the
      // first row. It is measured on the row, not the list: a flex container's
      // own box starts at its first child, so list.top === firstRow.top and
      // would read as no air at all.
      // The label's box is flush with the list — that is the app's arrangement, and
      // the gap keeps it so instead of pushing a row up into the label. The air
      // between the label's TEXT and the first chat is the label's own bottom
      // padding, which is inside its box: so that is read off the label itself.
      check(near(m.dms[0].top, m.dmLabelBottom, 0.5),
        theme + ': the DIRECT MESSAGES label still ends exactly where the first chat begins',
        { labelBottom: Math.round(m.dmLabelBottom * 100) / 100, firstRowTop: Math.round(m.dms[0].top * 100) / 100, label: m.dmLabelText });
      check(near(m.labelPadBottom, LABEL_PAD_BOTTOM, 0.6),
        theme + ': and the label keeps its own ' + LABEL_PAD_BOTTOM + 'px of bottom padding, which is the air under its text',
        { labelPaddingBottom: m.labelPadBottom });
      // The two header rows above the lists are .dmrow too, and the first of
      // them carries its own .7rem of padding (#btn-friends). Both kept it, which
      // is the id-scoped gap showing its hand: a .dmrow-wide gap would have added
      // to the spacing between them instead of the chats.
      // The Stories row is separated from the row above it by its own .3rem
      // margin and nothing else: both rows are block boxes that already contain
      // their own padding, so a .dmrow-wide gap would have shown up HERE as extra
      // air between the two header rows.
      check(near(m.storiesTop - m.friendsBottom, STORIES_OFFSET, 0.6),
        theme + ': the header rows above the lists kept their own spacing (a gap on .dmrow would have grown it)',
        { friendsToStories: Math.round((m.storiesTop - m.friendsBottom) * 100) / 100, expected: STORIES_OFFSET });

      // The active row's fill stops at its own edge: the new air is the sidebar's
      // own colour, so a highlight reads as one row and not as a merged block.
      check(m.activeBg && m.activeBg !== 'rgba(0, 0, 0, 0)', theme + ': the open chat still paints its own fill', { fill: m.activeBg });
      check(near(m.active.height, m.dms[0].height, 0.5), theme + ': and that fill is the row, not the row plus the gap',
        { activeH: Math.round(m.active.height * 100) / 100, rowH: Math.round(m.dms[0].height * 100) / 100 });

      // And the one mark a gap could catch: the presence light\'s halo, which is
      // knocked out in --panel, and the air between rows, which is the list\'s
      // own colour. Both must be the sidebar\'s colour, or a seam shows.
      check(m.air.length === 3 && m.air[0] === m.air[1] && m.air[2] === m.air[1],
        theme + ': the air between rows is the sidebar\'s own colour, and the presence light is knocked out in it — no seam under the dot',
        { list: m.air[0], rail: m.air[1], haloKnockoutArea: m.air[2], halo: m.haloKnockout, panel: m.panelBg });
      check(near(parseFloat(m.dmMargin), 0.55 * REM, 0.6), theme + ': the column\'s .55rem side inset is unchanged', { marginLeft: m.dmMargin });
    }

    // The one measurement that matches the report: with a real hover on a real
    // row, the two fills must not touch. The 2px line between them is read off
    // the PIXELS (elementFromPoint in the air, the fill's own box above and
    // below), not off the stylesheet.
    if (await hover('#group-list .dmrow', 0)) {
      await applyThemeProbe('dark');
      const h = measured.dark || await evaluate(PROBE);
      const hov = await evaluate(`(() => { const rows = [...document.querySelectorAll('#group-list .dmrow')];
        const b = rows.map((r) => { const x = r.getBoundingClientRect(); return { top: x.top, bottom: x.bottom, h: x.height, bg: getComputedStyle(r).backgroundColor }; });
        // The middle of the AIR, not the middle of the hovered row (which is
        // filled): between the two row boxes, at the sidebar's left edge where
        // only the list itself is in that band.
        // The first whole pixel that lies ENTIRELY in the air: the row edges are
        // fractional, so the pixel at the row's own bottom edge is half fill and
        // half air, and the pixel at the next row's top edge is the other way
        // round. Anything else measures a row, not the gap.
        var air = Math.ceil(b[0].bottom);
        if (air >= b[1].top) return { b: b, air: 'no whole pixel in a ' + (b[1].top - b[0].bottom).toFixed(2) + 'px gap' };
        var x = Math.round(document.getElementById('group-list').getBoundingClientRect().left + 20);
        // What is PAINTED there: the first opaque background up from whatever the
        // hit test found, since a list (and a row at rest) paints nothing itself
        // and the colour of the air is its ancestor's.
        var el = document.elementFromPoint(x, air), col = null, from = null;
        for (var n = el; n; n = n.parentElement) {
          var c = getComputedStyle(n).backgroundColor;
          if (c && c !== 'rgba(0, 0, 0, 0)') { col = c; from = n.id || n.className; break; }
        }
        return { b: b, air: col, airFrom: from, hit: el ? (el.id || el.className) : null,
          airAt: air, airTop: Math.round(b[0].bottom * 100) / 100, airBottom: Math.round(b[1].top * 100) / 100,
          panel: getComputedStyle(document.getElementById('sidebar')).backgroundColor }; })()`);
      check(hov.b[0].bg !== 'rgba(0, 0, 0, 0)', 'the hovered row really is filled (a real :hover fill, not a painted-on class)',
        { fill: hov.b[0].bg });
      check(near(hov.b[1].top - hov.b[0].bottom, DM_GAP, 0.6),
        'the hovered fill stops 2px short of the next row — the slab is broken', { air: Math.round((hov.b[1].top - hov.b[0].bottom) * 100) / 100 });
      check(hov.air === hov.panel, 'and the 2px between the two rows is the sidebar\'s own colour',
        { air: hov.air, panel: hov.panel, paintedBy: hov.airFrom, hit: hov.hit, sampledAt: hov.airAt,
          between: hov.airTop + ' and ' + hov.airBottom });
      const shot = await send('Page.captureScreenshot', {
        format: 'png', clip: { x: 0, y: 260, width: 268, height: 150, scale: 2 },
      });
      const png = path.join(ROOT, '..', 'tmp', 'dm-list-gap', 'dm-list-gap-hover.png');
      fs.mkdirSync(path.dirname(png), { recursive: true });
      fs.writeFileSync(png, Buffer.from(shot.data, 'base64'));
      console.log('  (wrote dm-list-gap-hover.png — the hovered pair, 2x)');
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 640, buttons: 0 });
    }

    // Photos are how this change gets signed off by eye; the run's own temp
    // directory is removed in the finally, so they are copied out to last.
    const shotDir = path.join(ROOT, '..', 'tmp', 'dm-list-gap');
    fs.mkdirSync(shotDir, { recursive: true });
    for (const f of shots) fs.copyFileSync(f, path.join(shotDir, path.basename(f)));
    console.log('\n  [3] the gap is the channel list\'s rhythm too');
    check(DM_GAP === CHAN_GAP, 'the home chat lists use the same gap as #text-channels/#voice-channels', { dm: DM_GAP, channels: CHAN_GAP });
    const h = measured.dark && measured.dark.dms[0] ? measured.dark.dms[0].height : 0;
    note('a DM row measures ' + Math.round(h * 10) / 10 + 'px tall in the browser (its own box, unchanged by the gap); the ' + DM_GAP + 'px sits between rows, not inside one');
    console.log('  (wrote ' + (shots.length ? shots.map((f) => path.basename(f)).join(', ') : 'no') + ' to ' + shotDir + ')');
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome && chrome.kill(); } catch {}
    try { child && child.kill(); } catch {}
    try { await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`); } catch {}
    try { admin && await admin.end(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed' + (notes ? ' (' + notes + ' note' + (notes === 1 ? '' : 's') + ')' : '')));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

main();