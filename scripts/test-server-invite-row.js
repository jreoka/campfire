// Server settings -> Invites: a link row must fit the phone.
//
// The row is a label + the full invite URL + Copy / Rename / Revoke. The URL is
// long ("https://campfire.dill.moe/invite/aB3xK9qZ"), and on a phone the three
// buttons used to be pushed off the right edge of the screen, so Revoke could
// only be reached by scrolling the panel sideways.
//
// Drives the REAL renderInviteLinks (security.js) against the REAL index.html
// markup and styles.css in headless Chrome at a phone viewport and a desktop
// one. "Fits" means every button's right edge is inside the panel and the
// panel itself has no horizontal overflow — the thing the report is about.
//
// Usage: node scripts/test-server-invite-row.js
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

const srvMarkup = index.slice(index.indexOf('<!-- server settings'), index.indexOf('<!-- channel settings'));
const inviteSrc = security.slice(security.indexOf('function fmtInviteDur(ms) {'), security.indexOf('function renderServerTab() {'));
// The phone breakpoint, exactly as styles.css spells it out (see AGENTS.md).
const PHONE_MQ = '(max-width:700px), (max-height:560px) and (pointer:coarse)';

// One server with a nickname long enough to be a real one, and the kinds of
// links the API hands back (never-expires, use-limited, expired).
const INVITES = [
  { id: 'i1', code: 'aB3xK9qZ', label: 'Friday game night', uses: 0, max_uses: null, expires_at: null },
  { id: 'i2', code: 'Zq9Kx3Ba', label: '', uses: 3, max_uses: 10, expires_at: Date.now() + 86400000 },
  { id: 'i3', code: 'qZ3aB9Kx', label: 'A really quite long invite nickname for the row', uses: 1, max_uses: 1, expires_at: Date.now() - 1000, exhausted: true },
];

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>*{animation:none!important;transition:none!important}
html,body{margin:0}</style></head><body>
${srvMarkup}
<script>
window.__calls = [];
window.S = { serverDetail: { id: 's1', name: 'Campfire Test', owner_id: 'me', channels: [] }, serverSubTab: 'invites', me: { id: 'me' } };
window.$ = (s) => document.querySelector(s);
window.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
window.prettyError = (e) => String(e);
window.toast = () => {};
window.api = async (u, o) => {
  if (/\\/invites$/.test(u) && (!o || o.method !== 'POST')) return { invites: ${JSON.stringify(INVITES)} };
  return {};
};
window.canManage = () => true;
window.openPromptModal = async () => null;
window.openConfirmModal = async () => false;
${inviteSrc}
const row = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), right: Math.round(r.right) }; };
const finish = (o) => { document.title = JSON.stringify(o).replace(/</g, '\\u003c'); };
window.onerror = (m, s, l) => finish({ err: 'onerror: ' + m + ' @' + l });
(async () => {
  try {
  const out = { innerW: innerWidth, phone: matchMedia('${PHONE_MQ}').matches, rows: [] };
  // The real settings shell, then the real invite list inside it — the same
  // nest renderServerTab builds (.srvset-wrap > .srv-subtabs.vertical +
  // .srvset-content, each section inside it).
  const backdrop = document.getElementById('srv-settings-backdrop');
  backdrop.classList.remove('hidden');
  const body = document.getElementById('srvset-body');
  const wrap = document.createElement('div'); wrap.className = 'srvset-wrap';
  const tabs = document.createElement('div'); tabs.className = 'srv-subtabs vertical';
  for (const t of ['General', 'Invites', 'Channels', 'Emoji', 'Roles', 'Bans']) { const b = document.createElement('button'); b.className = 'ftab' + (t === 'Invites' ? ' active' : ''); b.textContent = t; tabs.appendChild(b); }
  const content = document.createElement('div'); content.className = 'srvset-content';
  content.appendChild(document.createElement('div'));
  wrap.append(tabs, content);
  body.appendChild(wrap);
  const boxEl = content.firstElementChild;
  await renderInviteLinks(boxEl, S.serverDetail);
  const pane = document.getElementById('srvset-body');
  out.pane = row(pane); out.tabs = row(tabs); out.content = row(content);
  out.contentScrollW = content.scrollWidth;
  out.paneScrollW = pane.scrollWidth; out.paneClientW = pane.clientWidth;
  out.docScrollW = document.documentElement.scrollWidth;
  out.rowCount = boxEl.querySelectorAll('.set-row').length;
  out.links = [...boxEl.querySelectorAll('.set-row > div > .muted.small:nth-child(2)')].map((x) => x.textContent);
  out.rowDisplay = boxEl.querySelector('.set-row') ? getComputedStyle(boxEl.querySelector('.set-row')).display : '';
  for (const r of boxEl.querySelectorAll('.set-row')) {
    const buttons = [...r.querySelectorAll('button')].map((x) => ({ label: x.textContent, ...row(x) }));
    out.rows.push({ rect: row(r), buttons });
  }
  finish(out);
  } catch (e) { finish({ err: 'threw: ' + (e && e.message || e) + ' | ' + String(e && e.stack || '').split(String.fromCharCode(10)).slice(0, 3).join(' ~ ') }); }
})();
</script></body></html>`;
}

function run(chrome, html, size) {
  const dir = process.env.CF_TEST_DEBUG ? path.join(os.tmpdir(), 'cf-invrow-debug') : fs.mkdtempSync(path.join(os.tmpdir(), 'cf-invrow-'));
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

  console.log('\n[0] the CSS keeps the settings column inside the pane');
  // The bug: .srvset-wrap is `align-items:flex-start`, and `.srvset-content` was
  // a plain `flex:1` item, so in the COLUMN (phone) direction its cross-size was
  // fit-content — one nowrap invite URL made the whole column 571px wide inside
  // a 452px pane, and the row's buttons ran off the right of the screen.
  check(/\.srvset-wrap\{[^}]*align-items:flex-start/.test(css), 'the wrapper still aligns its rows to the start (.srvset-wrap)');
  check(/\.srvset-content\{[^}]*align-self:stretch/.test(css), 'the content column stretches to the pane instead of to its content');
  check(/\.set-row\{[^}]*display:flex/.test(css), 'the invite rows are still flex rows (.set-row)');

  for (const [name, size] of [['phone', '390,844'], ['narrow desktop', '760,900'], ['desktop', '1280,900']]) {
    console.log(`\n[${name}] invite rows fit`);
    const out = run(chrome, html, size);
    if (out.err) { check(false, `${name}: the harness ran`, out.err); continue; }
    check(out.rowCount === INVITES.length, `${name}: every link painted a row`, out.rowCount);
    check(out.rowDisplay === 'flex', `${name}: the rows render as flex rows`, out.rowDisplay);
    check(out.content.w <= out.pane.w + 1, `${name}: the content column is not wider than the pane`, { content: out.content.w, pane: out.pane.w });
    check(out.paneScrollW <= out.paneClientW + 1, `${name}: the settings pane has no horizontal overflow`, { scrollW: out.paneScrollW, clientW: out.paneClientW });
    check(out.contentScrollW <= out.content.w + 1, `${name}: nothing inside the column overflows it`, { scrollW: out.contentScrollW, w: out.content.w });
    check(out.docScrollW <= out.innerW + 1, `${name}: the page itself does not scroll sideways`, { doc: out.docScrollW, innerW: out.innerW });
    check(out.links.length === INVITES.length && out.links.every((t, i) => t.endsWith('/invite/' + INVITES[i].code)),
      `${name}: each row still names its own full link (ellipsised, never truncated in the DOM)`, out.links);
    let worst = -1;
    for (const [i, r] of out.rows.entries()) {
      for (const b of r.buttons) worst = Math.max(worst, b.right);
      check(r.rect.right <= out.pane.right + 1, `${name}: row ${i + 1} stays inside the pane`, { row: r.rect, pane: out.pane });
      check(r.buttons.length === 3 && r.buttons[2].label === 'Revoke', `${name}: row ${i + 1} still offers Copy / Rename / Revoke`, r.buttons.map((b) => b.label));
    }
    check(worst <= out.innerW, `${name}: the right-most button is on screen`, { right: worst, innerW: out.innerW });
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
