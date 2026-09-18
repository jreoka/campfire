// The site admin console is a FULL PAGE, not a dialog (owner request).
//
// It used to be a `.settings` modal on a dimming backdrop: five tabs on a rail,
// one pane beside them, and a ✕ in the corner. A moderation console is a place
// you work in, not something you peek through, so it now owns the window — it
// lives inside #chat as a positioned sheet, the body flag `adm-page` stands the
// rest of the shell down (rail, sidebar, member list, the chat column's
// siblings), its own header carries a "Return to Campfire" button, and the areas
// are a nav MENU rather than a tab strip.
//
// What this test protects, in order:
//   - the console really is inside #chat (a page), and the old dialog id is gone
//     from every file that used to reference it;
//   - the stand-down is CSS-ONLY: nothing in #chat is display:none'd, so the
//     conversation underneath keeps its scroll, its draft and its uploads and
//     Return brings them back untouched (the browser half proves the chat
//     surfaces are still `display:flex/block` while the page is up);
//   - the page is above every floating chat surface and below the app's own
//     overlays (menus/pickers/modals), because the console keeps using them;
//   - the header's way out, the queue shortcut and the menu wiring exist, and
//     the menu is one row per area with an icon and a label;
//   - the phone layout turns the menu into a horizontal rail and shortens the
//     return label, so the header cannot overflow a 360px screen.
//
// Static checks run everywhere; the browser half drives the REAL shell markup
// against the REAL stylesheet in headless Chrome and skips without it.
//
// Usage: node scripts/test-admin-page.js
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
const adminJs = fs.readFileSync(path.join(ROOT, 'public/js/admin.js'), 'utf8');
const nativeJs = fs.readFileSync(path.join(ROOT, 'public/js/native.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

// The console block, and the column it lives in.
const adminMarkup = index.slice(index.indexOf('<!-- site admin console'), index.indexOf('<!-- end site admin console -->'));
const chatMarkup = index.slice(index.indexOf('<main id="chat">'), index.indexOf('</main>'));
// The real shell, for the browser half: the whole #view-main section (rail,
// sidebar, chat column, members) — everything the page has to stand down.
const viewMain = index.slice(index.indexOf('<section id="view-main"'), index.indexOf('<!-- invite landing -->'));

console.log('\n[1] the console is a page inside #chat, not a dialog over it');
check(adminMarkup.length > 0, 'the console markup block is present');
check(/id="admin-page"/.test(adminMarkup), 'it is #admin-page');
check(/id="admin-page"/.test(chatMarkup), 'and it lives INSIDE #chat (the page fills the chat column)');
check(!/admin-backdrop/.test(index) && !/admin-backdrop/.test(adminJs) && !/admin-backdrop/.test(nativeJs) && !/admin-backdrop/.test(css),
  'nothing still points at the old #admin-backdrop dialog');
const pageRule = /#admin-page\{([^}]*)\}/.exec(css);
check(!!pageRule && /position:absolute/.test(pageRule[1]) && /inset:0/.test(pageRule[1]) && /flex-direction:column/.test(pageRule[1]),
  '#admin-page is a positioned full-height column', pageRule && pageRule[1]);
check(!!pageRule && /background:var\(--bg\)/.test(pageRule[1]), 'on an opaque background, so the chat underneath is not visible through it');
check(!/admin-console|adm-tabs/.test(index) && !/admin-console|adm-tabs/.test(adminJs), 'the old modal rail and its tab strip are gone');

console.log('\n[2] the shell stands down in CSS only — nothing is torn down');
check(/body\.adm-page #left,[\s\S]{0,160}body\.adm-page #find-panel\{display:none!important\}/.test(css),
  'body.adm-page hides the rail, the sidebar, the member list and the chat panels');
check(/body\.adm-page #members/.test(css), 'including #members, which is fixed at z-index 45 on a phone and would float over the page');
check(!/body\.adm-page #messages/.test(css), 'the message list is deliberately NOT hidden — it stays in flow, just covered');
check(/document\.body\.classList\.add\('adm-page'\)/.test(adminJs), 'opening adds the body flag');
check(/document\.body\.classList\.remove\('adm-page'\)/.test(adminJs), 'closing takes it away again (no teardown to undo)');

console.log('\n[3] the page sits above the chat chrome and below the app\'s overlays');
function zIndexOf(sel) {
  const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}').exec(css);
  const z = m && /z-index:(\d+)/.exec(m[1]);
  return z ? Number(z[1]) : null;
}
const pageZ = zIndexOf('#admin-page');
const jumpZ = zIndexOf('#jump-present');
const pickerZ = zIndexOf('#picker');
check(pageZ === 40, 'the page is z-index 40', pageZ);
check(jumpZ !== null && jumpZ < pageZ, 'above #jump-present, the chat\'s own floating pill', { jumpZ, pageZ });
check(pickerZ !== null && pickerZ > pageZ, 'below #picker / the modals the console keeps using', { pickerZ, pageZ });

console.log('\n[4] a way back, a queue shortcut, and one menu row per area');
check(/id="admin-return"/.test(adminMarkup), 'the header has the return button');
check(/Return to Campfire/.test(adminMarkup), 'labelled "Return to Campfire"');
check(/id="admin-return"[\s\S]{0,420}class="adm-back-s">Campfire</.test(adminMarkup),
  'with a short label for narrow screens (the full sentence overflows a phone header)');
check(/back\.onclick = closeAdminConsole/.test(adminJs), 'and it closes the console');
check(/id="adm-head-reports"/.test(adminMarkup) && /adm-head-reports-n/.test(adminMarkup),
  'the header carries the open-report count as a chip');
check(/class="adm-head-reports-tx"/.test(adminMarkup), 'whose wording lives in its own span (the phone drops it and keeps the count)');
check(/chip\.onclick = \(\) => setAdminTab\('reports'\)/.test(adminJs), 'which jumps straight to the queue');
const navs = [...adminMarkup.matchAll(/class="adm-nav[^"]*" data-atab="([a-z]+)"/g)].map((m) => m[1]);
check(navs.join(',') === 'overview,reports,media,users,servers', 'the menu has one row per area, in order', navs);
check((adminMarkup.match(/class="adm-nav-ic"/g) || []).length === navs.length, 'every row carries an icon (no emoji in chrome)');
check((adminMarkup.match(/class="adm-nav-tx"/g) || []).length === navs.length, 'and a text label');
const panes = [...adminMarkup.matchAll(/id="adm-([a-z]+)" class="set-pane/g)].map((m) => m[1]);
check(panes.join(',') === 'overview,reports,media,users,servers', 'and a matching pane for each (still .set-pane, so the shared spinner works)', panes);
check(/id="admin-menu"/.test(adminMarkup) && /<nav id="admin-menu"/.test(adminMarkup), 'the menu is a <nav>, not a tab strip');
check(/id="admin-panes"/.test(adminMarkup), 'and the panes share one scroller');

console.log('\n[5] the console keeps driving the shared behaviour');
check(/document\.querySelectorAll\('#admin-menu \.adm-nav'\)/.test(adminJs), 'the active menu row is painted from Admin.tab');
check(/scroller\.scrollTop = 0/.test(adminJs), 'and a section opens at its top, not where the last one was scrolled to');
check(/ADMIN_SECTIONS/.test(adminJs) && /adm-head-sub/.test(adminMarkup) && /sub\.textContent/.test(adminJs),
  'the header subtitle names what the reader is looking at');
check(/cfShown\('#admin-page'\)/.test(nativeJs), 'the Android/browser back button peels the page (native.js)');
check(/visibilitychange/.test(adminJs) && /adminConsoleOpen\(\)/.test(adminJs), 'the Overview poll still resumes with the tab');

console.log('\n[6] the phone layout: menu across the top, shorter way out');
const phone = /@media \(max-width:820px\),\(max-height:560px\) and \(pointer:coarse\)\{\s*\/\* The menu becomes[\s\S]{0,700}?flex-direction:row/.exec(css);
check(!!phone, 'under 820px the menu turns into a horizontal rail above the panes');
const narrow = /@media \(max-width:600px\)\{([\s\S]*?)\n\}/.exec(css);
check(!!narrow && /\.adm-back-t\{display:none\}/.test(narrow[1]) && /\.adm-back-s\{display:inline\}/.test(narrow[1]),
  'and under 600px the return button swaps to its short label', narrow && narrow[1]);
check(!!narrow && /\.adm-head-reports-tx\{display:none\}/.test(narrow[1]),
  'and the report chip drops its wording so the header cannot overflow', narrow && narrow[1]);
check(!!narrow && /\.adm-filter\{flex-wrap:wrap\}/.test(narrow[1]) && /\.adm-filter input\{flex:1 1 100%\}/.test(narrow[1]),
  'and a search row gives its field a full line', narrow && narrow[1]);
check((adminJs.match(/class="row adm-filter"/g) || []).length === 3,
  'the three search rows (users, reports, servers) carry that class');

const chrome = findChrome();
if (!chrome) return skip('no Chrome/Edge found — set CHROME_PATH');

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css"></head><body>
${viewMain}
<script>
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cs = (el) => getComputedStyle(el);
(async () => {
  const out = {};
  const q = (s) => document.querySelector(s);
  // A hidden parent does not change a child's OWN computed display, so the
  // stand-down is measured as a zero-width box as well as the flag itself.
  const wide = (s) => Math.round(q(s).getBoundingClientRect().width);
  q('#view-main').classList.remove('hidden');
  await wait(30);
  out.viewport = { w: innerWidth, h: innerHeight };
  const leftBefore = cs(q('#left')).display;
  const railBefore = wide('#rail');
  const membersBefore = cs(q('#members')).display;

  q('#admin-page').classList.remove('hidden');
  document.body.classList.add('adm-page');
  // The queue chip is normally revealed by a report count landing; show it here
  // so the header's width is measured in its WIDEST real state.
  q('#adm-head-reports').classList.remove('hidden');
  q('#adm-head-reports-n').textContent = '4';
  await wait(60);

  const page = q('#admin-page');
  const r = page.getBoundingClientRect();
  out.page = { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), top: Math.round(r.top), z: Number(cs(page).zIndex) };
  out.shell = {
    leftBefore, railBefore, membersBefore,
    left: cs(q('#left')).display, rail: wide('#rail'), sidebar: wide('#sidebar'), members: cs(q('#members')).display,
  };
  // The conversation is still THERE (in flow, covered) — that is what makes
  // Return free: no scroll jump, no lost draft, no cancelled upload.
  out.chat = { header: cs(q('#chat-header')).display, messages: cs(q('#messages')).display, composer: cs(q('#composer')).display };
  const back = q('#admin-return');
  out.back = { visible: back.getBoundingClientRect().width > 0, wraps: back.getBoundingClientRect().height > 60,
    full: cs(q('.adm-back-t')).display !== 'none', short: cs(q('.adm-back-s')).display !== 'none' };
  const head = q('#admin-head');
  out.head = {
    overflow: Math.round(head.scrollWidth - head.clientWidth),
    chipRight: Math.round(q('#adm-head-reports').getBoundingClientRect().right),
    chipTx: cs(q('.adm-head-reports-tx')).display !== 'none',
  };
  out.nav = [...document.querySelectorAll('#admin-menu .adm-nav')].map((b) => b.dataset.atab);
  out.navDir = cs(q('#admin-menu')).flexDirection;
  out.panes = { scroll: cs(q('#admin-panes')).overflowY, hidden: [...document.querySelectorAll('#admin-panes .set-pane')].filter((p) => p.classList.contains('hidden')).length };

  document.body.classList.remove('adm-page');
  await wait(60);
  out.restored = { left: cs(q('#left')).display, rail: wide('#rail'), members: cs(q('#members')).display };
  document.title = JSON.stringify(out);
})();
</script></body></html>`;
}

// A phone viewport the desktop Chrome on this machine will not open (its own
// minimum window width is ~500px) is a 390px IFRAME: media queries inside a frame
// resolve against the frame's box, so this is a real 390px viewport, not a narrow
// desktop. The frame cannot be read back without file access to its own origin,
// hence --allow-file-access-from-files in run().
function frameHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><title></title></head><body style="margin:0">
<iframe id="f" src="narrow.html" style="width:390px;height:700px;border:0;display:block"></iframe>
<script>
const iv = setInterval(() => {
  try {
    const t = document.getElementById('f').contentDocument.title;
    if (t && t.trim()) { document.title = t; clearInterval(iv); }
  } catch (e) {
    document.title = JSON.stringify({ err: 'frame unreadable: ' + e });
    clearInterval(iv);
  }
}, 40);
</script></body></html>`;
}

function run(chrome, files, main, win) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-admpage-'));
  try {
    for (const [name, html] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), html);
    const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--allow-file-access-from-files', '--user-data-dir=' + path.join(dir, 'prof'),
      '--window-size=' + win, '--virtual-time-budget=8000', '--dump-dom', 'file:///' + path.join(dir, main).replace(/\\/g, '/')],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
    if (!m) return { err: 'no title, status ' + r.status + ' ' + (r.stderr || '').slice(-300) };
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

console.log('\n[7] the real page against the real shell (headless Chrome, desktop)');
const desk = run(chrome, { 'page.html': pageHtml() }, 'page.html', '1280,800');
if (desk.err) { check(false, 'the desktop harness ran', desk.err); }
else {
  check(desk.page.w >= desk.viewport.w - 1 && desk.page.h >= desk.viewport.h - 1,
    'the console fills the window (rail + sidebar are gone, not squeezed)', { page: desk.page, vp: desk.viewport });
  check(desk.page.left === 0 && desk.page.top === 0, 'from the very corner', desk.page);
  check(desk.shell.leftBefore !== 'none' && desk.shell.railBefore > 0 && desk.shell.membersBefore !== 'none',
    'the shell was up before the flag', desk.shell);
  check(desk.shell.left === 'none' && desk.shell.rail === 0 && desk.shell.sidebar === 0 && desk.shell.members === 'none',
    'and every column stands down for the page', desk.shell);
  check(desk.chat.messages !== 'none' && desk.chat.composer !== 'none' && desk.chat.header !== 'none',
    'while the chat surfaces stay in flow underneath (covered, never torn down)', desk.chat);
  check(desk.nav.join(',') === 'overview,reports,media,users,servers', 'the menu renders one row per area', desk.nav);
  check(desk.navDir === 'column', 'as a side column on a desktop', desk.navDir);
  check(desk.panes.scroll === 'auto' && desk.panes.hidden === 4, 'the panes scroll, with Overview the only one showing', desk.panes);
  check(desk.back.visible && desk.back.full && !desk.back.short && !desk.back.wraps, 'the full return label shows and does not wrap', desk.back);
  check(desk.head.overflow === 0 && desk.head.chipTx && desk.head.chipRight <= desk.viewport.w,
    'and the header fits with the queue chip spelled out', desk.head);
  check(desk.restored.left !== 'none' && desk.restored.rail > 0 && desk.restored.members !== 'none', 'clearing the flag puts the shell back', desk.restored);
}

console.log('\n[8] the same page in a real 390px viewport (headless Chrome, iframe)');
const phoneOut = run(chrome, { 'page.html': pageHtml(), 'narrow.html': pageHtml(), 'frame.html': frameHtml() }, 'frame.html', '1280,800');
if (phoneOut.err) { check(false, 'the phone harness ran', phoneOut.err); }
else {
  check(phoneOut.viewport.w === 390, 'the frame really is 390px wide', phoneOut.viewport);
  check(phoneOut.page.w === 390 && phoneOut.page.h === 700, 'the page owns that screen too', { page: phoneOut.page });
  check(phoneOut.shell.left === 'none' && phoneOut.shell.members === 'none',
    'the fixed member drawer (z-index 45) stands down with the rest', phoneOut.shell);
  check(phoneOut.navDir === 'row', 'the menu is a horizontal rail on a phone', phoneOut.navDir);
  check(phoneOut.back.visible && !phoneOut.back.full && phoneOut.back.short, 'and the return button shows its short label', phoneOut.back);
  check(!phoneOut.back.wraps, 'so the header does not wrap at 390px', phoneOut.back);
  check(phoneOut.head.overflow === 0 && !phoneOut.head.chipTx && phoneOut.head.chipRight <= 390,
    'and the queue chip keeps its count inside the screen (its wording stands down)', phoneOut.head);
}

console.log('');
if (failures.length) {
  console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log(`All ${passed} checks passed.`);
