// Settings -> Security -> Sessions: a row must SHOW the device it stands for.
//
// The row is a name line, a device line (IP · user-agent · seen …) and the
// Rename / Revoke buttons. The device line is the only thing that tells two
// sessions apart, and it is long ("Mozilla/5.0 (Windows NT 10.0; Win64; x64)
// AppleWebKit/537.36 …"), so on a phone it used to run straight under the
// buttons and be chopped mid-word ("Pixel 10 Build/C · seen 5…") — the report.
//
// Two things had to be true, and both are checked here against the REAL
// renderSessionBox (security.js), the REAL index.html markup and styles.css:
//   * the text column must CLIP inside the row (`.sec-row .grow` was a <span>,
//     i.e. an inline box, and `overflow:hidden` does nothing to an inline box —
//     so the text grew past the buttons and the ROW cut it, not the column);
//   * the device line must WRAP rather than truncate, because ellipsising it
//     away is exactly the information loss being reported.
// "Fits" therefore means: no horizontal overflow anywhere, every button inside
// the panel, and the sub line's own box tall enough that no text is hidden.
//
// Usage: node scripts/test-session-rows.js
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
const security = fs.readFileSync(path.join(ROOT, 'public/js/security.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

// The sessions section of the Settings -> Security tab, verbatim.
const sessMarkup = index.slice(index.indexOf('<div id="set-sessions">'), index.indexOf('id="set-sess-revoke-others"'));
const sessSrc = security.slice(security.indexOf('function fmtSeen(ts) {'), security.indexOf("$('#set-sess-revoke-others')"));

// The phone breakpoint, exactly as styles.css spells it out (see AGENTS.md).
const PHONE_MQ = '(max-width:700px), (max-height:560px) and (pointer:coarse)';

// Two real sessions: the phone is the one that used to be chopped, and the
// desktop UA is the longest string the route ever hands back.
const UA_PHONE = 'Mozilla/5.0 (Linux; Android 17; Pixel 10 Build/CP1A.260101.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/152.0.0.0 Mobile Safari/537.36';
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const SESSIONS = [
  { id: 's1', name: '', current: true, ip: '107.4.0.167', user_agent: UA_DESKTOP, last_seen: Date.now() - 60e3, created_at: Date.now() - 86400e3 },
  { id: 's2', name: 'Phone', current: false, ip: '107.4.0.167', user_agent: UA_PHONE, last_seen: Date.now() - 5 * 60e3, created_at: Date.now() - 3600e3 },
];

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>*{animation:none!important;transition:none!important}html,body{margin:0}</style></head><body>
<section class="settings-pane">${sessMarkup}</section>
<script>
window.S = {};
window.$ = (s) => document.querySelector(s);
window.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
window.prettyError = (e) => String(e);
window.toast = () => {};
window.api = async (u) => {
  if (/\\/api\\/sessions$/.test(u)) return { sessions: ${JSON.stringify(SESSIONS)} };
  return {};
};
window.openPromptModal = async () => null;
${sessSrc}
const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }; };
const finish = (o) => { document.title = JSON.stringify(o).replace(/</g, '\\u003c'); };
window.onerror = (m, s, l) => finish({ err: 'onerror: ' + m + ' @' + l });
(async () => {
  try {
    const box = document.getElementById('set-sessions');
    const out = { innerW: innerWidth, phone: matchMedia('${PHONE_MQ}').matches, rows: [] };
    out.box = rect(box);
    out.paneScrollW = document.documentElement.scrollWidth;
    out.docScrollW = document.documentElement.scrollWidth;
    await renderSessionBox();
    out.rows = [...box.querySelectorAll('.sec-row')].map((r) => {
      const main = r.querySelector('.grow');
      const nameEl = main.firstElementChild;
      const sub = main.querySelector('.sub');
      const cs = getComputedStyle(main);
      const subCs = getComputedStyle(sub);
      return {
        row: rect(r),
        main: rect(main),
        mainDisplay: cs.display,
        name: nameEl.textContent,
        sub: rect(sub),
        // The whole point: the sub box must be big enough to hold its own text.
        subHidden: Math.max(0, sub.scrollHeight - sub.clientHeight),
        subScrollH: sub.scrollHeight, subClientH: sub.clientHeight,
        subScrollW: sub.scrollWidth, subClientW: sub.clientWidth,
        subWhiteSpace: subCs.whiteSpace,
        subOverflowWrap: subCs.overflowWrap,
        buttons: [...r.querySelectorAll('button')].map((b) => ({ label: b.textContent, ...rect(b) })),
      };
    });
    finish(out);
  } catch (e) { finish({ err: 'threw: ' + (e && e.message || e) + ' | ' + String(e && e.stack || '').split(String.fromCharCode(10)).slice(0, 3).join(' ~ ') }); }
})();
</script></body></html>`;
}

function run(chrome, html, size) {
  const dir = process.env.CF_TEST_DEBUG ? path.join(os.tmpdir(), 'cf-sessrow-debug') : fs.mkdtempSync(path.join(os.tmpdir(), 'cf-sessrow-'));
  try {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'page.html');
    fs.writeFileSync(p, html);
    const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=' + size,
      '--virtual-time-budget=3000', '--dump-dom', 'file:///' + p.replace(/\\/g, '/')],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    if (process.env.CF_TEST_DEBUG) {
      fs.writeFileSync(path.join(dir, 'stdout.html'), r.stdout || '');
      fs.writeFileSync(path.join(dir, 'stderr.txt'), (r.stderr || '') + '\nstatus=' + r.status);
      console.log('[debug] wrote ' + dir);
    }
    const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
    if (!m) return { err: 'no title, status ' + r.status + ' ' + (r.stderr || '').slice(-400) };
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  } finally {
    if (!process.env.CF_TEST_DEBUG) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  }
}

function main() {
  const chrome = findChrome();
  if (!chrome) return skip('no Chrome/Edge found — set CHROME_PATH');
  const html = pageHtml();

  // `node scripts/test-session-rows.js --html out.html` writes the exact page
  // the checks measure, so the layout can be screenshotted by eye too.
  const hi = process.argv.indexOf('--html');
  if (hi !== -1) {
    const out = process.argv[hi + 1] || path.join(os.tmpdir(), 'cf-session-rows.html');
    fs.writeFileSync(out, html);
    console.log('wrote ' + out);
    return;
  }

  console.log('\n[0] the CSS can actually clip the text column');
  // The bug in one line: `.grow` is a <span>, and an inline box ignores
  // `overflow:hidden` — the text grew past the buttons and the ROW cut it.
  check(/\.sec-row \.grow\{[^}]*display:block/.test(css), '.sec-row .grow is a block, so overflow can clip it');
  check(/\.sec-row \.grow\{[^}]*min-width:0/.test(css), 'the text column can still shrink (min-width:0)');
  check(!/\.sec-row \.sub\{[^}]*white-space:nowrap/.test(css), 'the device line is not pinned to one nowrap line');
  check(/\.sec-row \.sub\{[^}]*overflow-wrap:anywhere/.test(css), 'a run-on UA string can still break (overflow-wrap:anywhere)');

  for (const [name, size] of [['phone', '390,844'], ['narrow desktop', '760,900'], ['desktop', '1280,900']]) {
    console.log(`\n[${name}] session rows show their device`);
    const out = run(chrome, html, size);
    if (out.err) { check(false, `${name}: the harness ran`, out.err); continue; }
    check(out.rows.length === SESSIONS.length, `${name}: every session painted a row`, out.rows.length);
    check(out.rows.every((r) => r.mainDisplay === 'block'), `${name}: the text column renders as a block`, out.rows.map((r) => r.mainDisplay));
    check(out.docScrollW <= out.innerW + 1, `${name}: the page does not scroll sideways`, { doc: out.docScrollW, innerW: out.innerW });
    for (const [i, r] of out.rows.entries()) {
      check(r.subHidden === 0, `${name}: row ${i + 1} hides none of its device line`, { scrollH: r.subScrollH, clientH: r.subClientH, hidden: r.subHidden });
      check(r.subScrollW <= r.subClientW + 1, `${name}: row ${i + 1} device text fits its column width`, { scrollW: r.subScrollW, clientW: r.subClientW });
      check(r.main.right <= r.buttons[0].x + 1, `${name}: row ${i + 1} text column stops before the buttons`, { mainRight: r.main.right, firstBtn: r.buttons[0].x });
      check(r.buttons.some((b) => b.label === 'Rename'), `${name}: row ${i + 1} still offers Rename`, r.buttons.map((b) => b.label));
      check(r.row.right <= out.innerW + 1, `${name}: row ${i + 1} stays on screen`, { row: r.row, innerW: out.innerW });
    }
    // Only a row that is not this device may be revoked (row 1 is the current
    // session, so it deliberately has no Revoke).
    check(out.rows[0].buttons.length === 1 && out.rows[1].buttons.some((b) => b.label === 'Revoke'),
      `${name}: this device offers Rename only, the other offers Revoke`, out.rows.map((r) => r.buttons.map((b) => b.label)));
    // The reported row is on screen and legible at every width it is used at.
    check(out.rows[1].sub.h >= 16 && out.rows[1].subHidden === 0,
      `${name}: the "Phone" row's device line is legible`, { subH: out.rows[1].sub.h, hidden: out.rows[1].subHidden });
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
