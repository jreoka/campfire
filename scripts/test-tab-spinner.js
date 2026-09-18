// The loading spinner for the settings and admin-console tab panes (see
// AGENTS.md → design language: a pick that has to wait must say so).
//
// Both consoles drive one shared helper: `tabSpin`/`tabSpinWhile` (core.js) —
// Settings as a `.set-tab` rail over `.set-pane` pages, the admin console as a
// full page (`.adm-nav` menu + `.set-pane` panes, see test-admin-page.js). The
// contract this test protects:
//   - the mark is on the PANE the reader is looking at, never beside the tab
//     button — it has to survive the phone layout, where picking a section hides
//     the rail entirely;
//   - a pane that fetches marks its OWN page, and the synchronous panes
//     (Profile, Themes) never spin;
//   - the mark is a COUNT, so two overlapping loads of one pane cannot clear it
//     when the first one finishes;
//   - a fast answer never flashes a spinner (the delay threshold), because a
//     60ms flash reads as a glitch;
//   - while it waits, the stale content stands down and the ring holds the page,
//     so a refresh never shows the old rows as if they were the answer.
//
// Static checks run everywhere; the browser half drives the REAL extracted
// helper against the REAL markup + stylesheet in headless Chrome and skips
// without it.
//
// Usage: node scripts/test-tab-spinner.js
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
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }
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

const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const settings = fs.readFileSync(path.join(ROOT, 'public/js/settings.js'), 'utf8');
const admin = fs.readFileSync(path.join(ROOT, 'public/js/admin.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

const SPIN_FROM = '// A tab whose pane has to be fetched says so IN the pane';
const SPIN_TO = '/* Default avatar color';
const spinSrc = core.slice(core.indexOf(SPIN_FROM), core.indexOf(SPIN_TO));
// The settings rail lives between the settings block and the server-settings
// one. The admin console is no longer a rail inside that range: it is a FULL
// PAGE inside #chat now, so its markup is lifted out by its own sentinels and
// wrapped in the #chat it is positioned against (see test-admin-page.js).
const railsMarkup = index.slice(index.indexOf('<!-- settings'), index.indexOf('<!-- server settings'));
const adminMarkup = index.slice(index.indexOf('<!-- site admin console'), index.indexOf('<!-- end site admin console -->'));

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css"></head><body>
${railsMarkup}
<div id="chat">${adminMarkup}</div>
<script>
${spinSrc}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const out = {};
  const sr = document.querySelector('#settings-backdrop .set-tab[data-tab="games"]');
  const ar = document.querySelector('#admin-menu .adm-nav[data-atab="reports"]');
  const spane = document.getElementById('set-games');
  const apane = document.getElementById('adm-reports');
  document.getElementById('settings-backdrop').classList.remove('hidden');
  document.getElementById('admin-page').classList.remove('hidden');
  // The shown pane, exactly as setSettingsTab/setAdminTab leave it.
  spane.classList.remove('hidden');
  apane.classList.remove('hidden');
  // Stale content a refresh has to stand down.
  spane.innerHTML = '<p class="muted small">stale rows</p>';
  apane.innerHTML = '<p class="muted small">stale rows</p>';
  const stale = spane.firstElementChild;
  const ring = (pane) => {
    const cs = getComputedStyle(pane, '::before');
    return { content: cs.content, width: cs.width, height: cs.height, radius: cs.borderTopLeftRadius, anim: cs.animationName, top: cs.borderTopColor };
  };
  out.rows = { settings: !!sr, admin: !!ar, panes: !!spane && !!apane };
  out.tabButtons = { spinChild: !!document.querySelector('.set-tab .set-tab-spin'), busy: sr.classList.contains('busy'), busyAttr: sr.hasAttribute('aria-busy') };

  // [1] a fast pane never flashes a spinner
  tabSpinWhile(spane, wait(20));
  await wait(400);
  out.fast = { loading: spane.classList.contains('loading'), aria: spane.getAttribute('aria-busy'), staleShown: getComputedStyle(stale).display };

  // [2] a slow pane holds the page with the ring
  let release;
  tabSpinWhile(spane, new Promise((r) => { release = r; }));
  await wait(60);
  out.beforeDelay = spane.classList.contains('loading');
  await wait(300);
  out.during = {
    loading: spane.classList.contains('loading'),
    aria: spane.getAttribute('aria-busy'),
    display: getComputedStyle(spane).display,
    align: getComputedStyle(spane).alignItems,
    minH: getComputedStyle(spane).minHeight,
    staleDisplay: getComputedStyle(stale).display,
    ring: ring(spane),
    tabStillClean: !sr.querySelector('.set-tab-spin') && !sr.classList.contains('busy'),
  };
  release();
  await wait(40);
  out.after = { loading: spane.classList.contains('loading'), aria: spane.getAttribute('aria-busy'), staleDisplay: getComputedStyle(stale).display };

  // [3] two overlapping loads hold the mark until the LAST one settles
  let a, b;
  tabSpinWhile(apane, new Promise((r) => { a = r; }));
  tabSpinWhile(apane, new Promise((r) => { b = r; }));
  await wait(260);
  out.overlapDuring = apane.classList.contains('loading');
  a();
  await wait(40);
  out.overlapHalf = apane.classList.contains('loading');
  b();
  await wait(40);
  out.overlapDone = { loading: apane.classList.contains('loading'), aria: apane.getAttribute('aria-busy') };

  // [4] a pane that rejects still clears the mark (no ring parks forever)
  let fail;
  tabSpinWhile(spane, new Promise((_, rej) => { fail = rej; })).catch(() => {});
  await wait(260);
  out.rejectDuring = spane.classList.contains('loading');
  fail(new Error('nope'));
  await wait(40);
  out.rejectAfter = { loading: spane.classList.contains('loading'), aria: spane.getAttribute('aria-busy') };

  document.title = JSON.stringify(out);
})();
</script></body></html>`;
}

function run(chrome, html) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-tabspin-'));
  try {
    const p = path.join(dir, 'page.html');
    fs.writeFileSync(p, html);
    const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=1200,900',
      '--virtual-time-budget=6000', '--dump-dom', 'file:///' + p.replace(/\\/g, '/')],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
    if (!m) return { err: 'no title, status ' + r.status + ' ' + (r.stderr || '').slice(-300) };
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function main() {
  console.log('\n[1] the helper is the shared one, and it counts');
  check(/const TAB_SPIN_DELAY_MS = \d+;/.test(core), 'the flash threshold is a named constant');
  check(/function tabSpin\(pane, on\)/.test(core) && /pane\.classList\.toggle\('loading', n > 0\)/.test(core),
    'tabSpin marks the PANE, not the tab button');
  check(/const tabSpinN = new WeakMap\(\)/.test(core) && /tabSpinN\.get\(pane\) \|\| 0\) \+ \(on \? 1 : -1\)/.test(core),
    'it holds a per-pane count, not a boolean (overlapping loads cannot clear it early)');
  check(/if \(n\) pane\.setAttribute\('aria-busy', 'true'\); else pane\.removeAttribute\('aria-busy'\)/.test(core),
    'and says so to assistive tech on the page it is updating');
  check(/function tabSpinWhile\(pane, p\)[\s\S]{0,320}setTimeout\([\s\S]{0,120}clearTimeout\(t\)/.test(core),
    'tabSpinWhile arms the visible mark on a timer and clears it when the promise settles');
  check(!/set-tab-spin/.test(core), 'nothing is injected into the tab row any more');

  console.log('\n[2] every fetching pane is wired, and the synchronous ones are not');
  check(/const pane = \$\(('#set-' \+ t)\);/.test(settings), 'the settings pane is looked up from the tab id');
  for (const [tab, fn] of [['account', 'Promise.all\\(\\[renderSecurityTab\\(\\), renderDesktopApp\\(\\)\\]\\)'], ['notifs', 'renderNotifsTab\\(\\)'], ['blocked', 'renderBlockedTab\\(\\)'], ['games', 'renderGamesTab\\(\\)'], ['media', 'renderMediaTab\\(\\)']]) {
    check(new RegExp(`if \\(t === '${tab}'\\) tabSpinWhile\\(pane, ${fn}\\);`).test(settings), `Settings → ${tab} marks its own page while the pane loads`);
  }
  check(/if \(t === 'themes'\) renderThemesTab\(\);/.test(settings), 'the synchronous Themes pane paints without a spinner');
  check(/let pane = null;[\s\S]{0,320}if \(key === t\) pane = p;/.test(admin), 'the admin pane is the one being shown');
  for (const [tab, fn] of [['overview', 'loadAdminStats\\(\\)'], ['reports', 'loadAdminReports\\(\\)'], ['media', 'loadAdminMedia\\(\\)'], ['users', 'loadAdminUsers\\(\\)'], ['servers', 'loadAdminServers\\(\\)']]) {
    check(new RegExp(`tabSpinWhile\\(pane, ${fn}\\);`).test(admin) && new RegExp(`t === '${tab}'`).test(admin), `Admin → ${tab} marks its own page while the pane loads`);
  }
  check(!/tabSpinWhile\(row/.test(settings) && !/tabSpinWhile\(row/.test(admin), 'no caller marks a tab row');

  console.log('\n[3] the ring lives on the page, and the stale content stands down');
  const paneRule = /\.set-pane\.loading\{([^}]*)\}/.exec(css);
  check(!!paneRule && /display:flex/.test(paneRule[1]) && /align-items:center/.test(paneRule[1]) && /justify-content:center/.test(paneRule[1]),
    'the loading pane centres its ring', paneRule && paneRule[1]);
  check(!!paneRule && /min-height:min\(240px,45vh\)/.test(paneRule[1]), 'in a block tall enough to read as a page', paneRule && paneRule[1]);
  check(/\.set-pane\.loading>\*\{display:none\}/.test(css), 'the stale rows stand down while it waits');
  const beforeRule = /\.set-pane\.loading::before\{([^}]*)\}/.exec(css);
  check(!!beforeRule && /width:26px/.test(beforeRule[1]) && /height:26px/.test(beforeRule[1]) && /border-radius:50%/.test(beforeRule[1]),
    'the ring is a 26px circle', beforeRule && beforeRule[1]);
  check(!!beforeRule && /border-top-color:var\(--accent\)/.test(beforeRule[1]) && /animation:up-spin/.test(beforeRule[1]),
    'an accent arc on the app\'s existing spin keyframes', beforeRule && beforeRule[1]);
  check(/prefers-reduced-motion:reduce\)\{[^}]*\.set-pane\.loading::before/.test(css), 'reduced motion turns the animation off');
  check(!/\.set-tab-spin\{/.test(css), 'the tab-row ring is gone from the stylesheet');

  const chrome = findChrome();
  if (!chrome) return skip('no Chrome/Edge found — set CHROME_PATH');

  console.log('\n[4] the real helper against the real markup (headless Chrome)');
  const out = run(chrome, pageHtml());
  if (out.err) { check(false, 'the harness ran', out.err); }
  else {
    check(out.rows.settings && out.rows.admin && out.rows.panes, 'both consoles and their panes rendered', out.rows);
    check(out.fast.loading === false && out.fast.aria === null, 'a fast answer never flashes a spinner', out.fast);
    check(out.fast.staleShown !== 'none', 'and leaves the pane exactly as it was', out.fast);
    check(out.beforeDelay === false, 'nothing shows before the threshold', out.beforeDelay);
    check(out.during.loading === true, 'a slow answer marks the page, not the rail', out.during);
    check(out.during.aria === 'true', 'and says so to assistive tech', out.during);
    check(out.during.display === 'flex' && out.during.align === 'center', 'the page centres its ring', out.during);
    check(/45vh|240px/.test(out.during.minH), 'in a page-tall block', out.during.minH);
    check(out.during.staleDisplay === 'none', 'the stale rows stand down while it waits', out.during);
    check(out.during.ring.width === '26px' && out.during.ring.height === '26px' && out.during.ring.radius === '50%', 'a 26px ring', out.during.ring);
    check(out.during.ring.anim === 'up-spin', 'and it is the animated one', out.during.ring);
    check(out.during.tabStillClean === true && out.tabButtons.spinChild === false && out.tabButtons.busy === false && !out.tabButtons.busyAttr,
      'the tab button carries no mark at all', out.tabButtons);
    check(out.after.loading === false && out.after.aria === null && out.after.staleDisplay !== 'none', 'the page is handed back when the pane lands', out.after);
    check(out.overlapDuring === true, 'two overlapping loads spin', out.overlapDuring);
    check(out.overlapHalf === true, 'and the first one settling does not clear the second', out.overlapHalf);
    check(out.overlapDone.loading === false && out.overlapDone.aria === null, 'the last one settling clears it', out.overlapDone);
    check(out.rejectDuring === true && out.rejectAfter.loading === false && out.rejectAfter.aria === null, 'a rejected pane clears the mark instead of parking on it', out);
  }

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
}

main();
