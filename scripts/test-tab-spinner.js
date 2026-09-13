// The loading spinner on the settings rail and the admin console's tab strip
// (see AGENTS.md → design language: a pick that has to wait must say so).
//
// Both rails are `.set-tab` rows built from index.html and styled by styles.css,
// and both drive one shared helper: `tabSpin`/`tabSpinWhile` (core.js). The
// contract this test protects:
//   - a pane that fetches marks its OWN row busy until the fetch lands, and the
//     synchronous panes (Profile, Themes) never spin;
//   - the mark is a COUNT, so two overlapping loads of one row cannot clear it
//     when the first one finishes;
//   - a fast answer never flashes a spinner (the delay threshold), because a
//     60ms flash reads as a glitch;
//   - the spinner is an in-flow element, never a pseudo-element: the mobile
//     settings row spends ::after on its chevron and a narrow admin strip would
//     put an absolutely positioned ring on top of the label.
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

const SPIN_FROM = '// A tab whose pane has to be fetched marks itself busy';
const SPIN_TO = '/* Default avatar color';
const spinSrc = core.slice(core.indexOf(SPIN_FROM), core.indexOf(SPIN_TO));
// Both rails live between the settings block and the server-settings one.
const railsMarkup = index.slice(index.indexOf('<!-- settings'), index.indexOf('<!-- server settings'));

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css"></head><body>
${railsMarkup}
<script>
${spinSrc}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rowHtml = (el) => el.outerHTML;
(async () => {
  const out = {};
  const sr = document.querySelector('#settings-backdrop .set-tab[data-tab="games"]');
  const ar = document.querySelector('#admin-backdrop .set-tab[data-atab="reports"]');
  document.getElementById('settings-backdrop').classList.remove('hidden');
  document.getElementById('admin-backdrop').classList.remove('hidden');
  out.rows = { settings: !!sr, admin: !!ar, settingsLabel: sr && sr.textContent.trim(), adminLabel: ar && ar.textContent.trim() };
  const h0 = Math.round(sr.getBoundingClientRect().height);

  // [1] a fast pane never flashes a spinner
  tabSpinWhile(sr, wait(20));
  await wait(400);
  out.fast = { spin: !!sr.querySelector('.set-tab-spin'), busy: sr.classList.contains('busy'), aria: sr.getAttribute('aria-busy'), label: sr.textContent.trim() };

  // [2] a slow pane spins for exactly as long as it waits
  let release;
  tabSpinWhile(sr, new Promise((r) => { release = r; }));
  await wait(60);
  out.beforeDelay = !!sr.querySelector('.set-tab-spin');
  await wait(300);
  const sp = sr.querySelector('.set-tab-spin');
  const cs = sp ? getComputedStyle(sp) : null;
  out.during = {
    spin: !!sp, busy: sr.classList.contains('busy'), aria: sr.getAttribute('aria-busy'),
    label: sr.textContent.trim(), markup: sp ? rowHtml(sp) : '',
    style: cs ? { display: cs.display, position: cs.position, width: cs.width, height: cs.height, radius: cs.borderTopLeftRadius, anim: cs.animationName, margin: cs.marginLeft } : null,
    heightDelta: Math.round(sr.getBoundingClientRect().height) - h0,
  };
  release();
  await wait(40);
  out.after = { spin: !!sr.querySelector('.set-tab-spin'), busy: sr.classList.contains('busy'), aria: sr.getAttribute('aria-busy'), label: sr.textContent.trim() };

  // [3] two overlapping loads hold the mark until the LAST one settles
  let a, b;
  tabSpinWhile(ar, new Promise((r) => { a = r; }));
  tabSpinWhile(ar, new Promise((r) => { b = r; }));
  await wait(260);
  out.overlapDuring = !!ar.querySelector('.set-tab-spin');
  a();
  await wait(40);
  out.overlapHalf = !!ar.querySelector('.set-tab-spin');
  b();
  await wait(40);
  out.overlapDone = { spin: !!ar.querySelector('.set-tab-spin'), busy: ar.classList.contains('busy') };

  // [4] a pane that rejects still clears the mark (no spinner parks forever)
  let fail;
  tabSpinWhile(sr, new Promise((_, rej) => { fail = rej; })).catch(() => {});
  await wait(260);
  out.rejectDuring = !!sr.querySelector('.set-tab-spin');
  fail(new Error('nope'));
  await wait(40);
  out.rejectAfter = { spin: !!sr.querySelector('.set-tab-spin'), busy: sr.classList.contains('busy') };

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
  check(/const tabSpinN = new WeakMap\(\)/.test(core) && /tabSpinN\.get\(btn\) \|\| 0\) \+ \(on \? 1 : -1\)/.test(core),
    'tabSpin holds a per-row count, not a boolean (overlapping loads cannot clear it early)');
  check(/function tabSpinWhile\(btn, p\)[\s\S]{0,320}setTimeout\([\s\S]{0,120}clearTimeout\(t\)/.test(core),
    'tabSpinWhile arms the visible mark on a timer and clears it when the promise settles');
  check(/sp = btn\.querySelector\('\.set-tab-spin'\)/.test(spinSrc) && /btn\.appendChild\(sp\)/.test(spinSrc),
    'the spinner is a real child of the row, appended inside it');

  console.log('\n[2] every fetching tab is wired, and the synchronous ones are not');
  for (const [tab, fn] of [['account', 'Promise.all\\(\\[renderSecurityTab\\(\\), renderDesktopApp\\(\\)\\]\\)'], ['notifs', 'renderNotifsTab\\(\\)'], ['blocked', 'renderBlockedTab\\(\\)'], ['games', 'renderGamesTab\\(\\)'], ['media', 'renderMediaTab\\(\\)']]) {
    check(new RegExp(`if \\(t === '${tab}'\\) tabSpinWhile\\(row, ${fn}\\);`).test(settings), `Settings → ${tab} marks its row while the pane loads`);
  }
  check(/if \(t === 'themes'\) renderThemesTab\(\);/.test(settings), 'the synchronous Themes pane paints without a spinner');
  check(/const row = document\.querySelector\('#settings-backdrop \.set-tab\[data-tab="/.test(settings), 'the settings row is looked up from the tab id');
  for (const [tab, fn] of [['overview', 'loadAdminStats\\(\\)'], ['reports', 'loadAdminReports\\(\\)'], ['media', 'loadAdminMedia\\(\\)'], ['users', 'loadAdminUsers\\(\\)'], ['servers', 'loadAdminServers\\(\\)']]) {
    check(new RegExp(`tabSpinWhile\\(row, ${fn}\\);`).test(admin) && new RegExp(`t === '${tab}'`).test(admin), `Admin → ${tab} marks its row while the pane loads`);
  }
  check(/const row = document\.querySelector\('#admin-backdrop \.set-tab\[data-atab="/.test(admin), 'the admin row is looked up from the tab id');

  console.log('\n[3] the spinner is the app\'s one ring, in the row\'s own flow');
  const spinRule = /\.set-tab-spin\{([^}]*)\}/.exec(css);
  check(!!spinRule, 'styles.css has a .set-tab-spin rule');
  if (spinRule) {
    check(/border-radius:50%/.test(spinRule[1]) && /border-top-color:var\(--accent\)/.test(spinRule[1]), 'it is a circle with an accent arc', spinRule[1]);
    check(/animation:up-spin/.test(spinRule[1]), 'it rides the app\'s existing spin keyframes');
    check(/display:inline-block/.test(spinRule[1]) && !/position:absolute/.test(spinRule[1]), 'it sits in the row flow, never absolutely positioned');
  }
  check(/prefers-reduced-motion:reduce\)\{[^}]*\.set-tab-spin/.test(css), 'reduced motion turns the animation off');
  check(/#settings-backdrop \.set-tab \.set-tab-spin\{margin-left:0\}/.test(css), 'the mobile menu row lets its own flex gap do the spacing');

  const chrome = findChrome();
  if (!chrome) return skip('no Chrome/Edge found — set CHROME_PATH');

  console.log('\n[4] the real helper against the real markup (headless Chrome)');
  const out = run(chrome, pageHtml());
  if (out.err) { check(false, 'the harness ran', out.err); }
  else {
    check(out.rows.settings && out.rows.admin, 'both rails rendered', out.rows);
    check(out.rows.settingsLabel === 'Games' && out.rows.adminLabel === 'Reports', 'the rows carry their labels', out.rows);
    check(out.fast.spin === false && out.fast.busy === false && out.fast.aria === null, 'a fast answer never flashes a spinner', out.fast);
    check(out.fast.label === 'Games', 'and leaves the label alone', out.fast);
    check(out.beforeDelay === false, 'nothing shows before the threshold', out.beforeDelay);
    check(out.during.spin === true, 'a slow answer puts the spinner in the row', out.during);
    check(out.during.busy === true && out.during.aria === 'true', 'the row is marked busy for assistive tech too', out.during);
    check(out.during.label === 'Games', 'the label text survives the extra child', out.during);
    check(out.during.markup === '<span class="set-tab-spin" aria-hidden="true"></span>', 'the mark is one empty decorative span', out.during.markup);
    check(out.during.style && out.during.style.display === 'inline-block' && out.during.style.position === 'static', 'it is laid out in the row, not over it', out.during.style);
    check(out.during.style && out.during.style.width === '12px' && out.during.style.height === '12px' && out.during.style.radius === '50%', 'a 12px ring', out.during.style);
    check(out.during.style && out.during.style.anim === 'up-spin', 'and it is the animated one', out.during.style);
    check(Math.abs(out.during.heightDelta) <= 1, 'the row does not change height when the ring appears', out.during.heightDelta);
    check(out.after.spin === false && out.after.busy === false && out.after.aria === null && out.after.label === 'Games', 'it clears when the pane lands', out.after);
    check(out.overlapDuring === true, 'two overlapping loads spin', out.overlapDuring);
    check(out.overlapHalf === true, 'and the first one settling does not clear the second', out.overlapHalf);
    check(out.overlapDone.spin === false && out.overlapDone.busy === false, 'the last one settling clears it', out.overlapDone);
    check(out.rejectDuring === true && out.rejectAfter.spin === false && out.rejectAfter.busy === false, 'a rejected pane clears the mark instead of parking on it', out);
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
