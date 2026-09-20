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
//   - the phone layout is the SETTINGS shape (menu, then one section with back),
//     not a rail squeezed into the header, and the return label shortens so the
//     header cannot overflow a 360px screen;
//   - the phone menu carries NO lit row (a list of sections, not a tab strip —
//     the accent would claim a section is open while the pane behind it is
//     hidden) and a phone SECTION shows ONE bar: the console header stands down
//     and the detail header is it, with the queue chip riding along in there.
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
// The phone view helpers, run for real in the browser half (the same slice
// trick test-mobile-settings-sheet.js uses for the settings pair). The section
// name table comes with them: paintAdminTitle has nothing to read without it.
const viewSrc = adminJs.slice(adminJs.indexOf('function setAdminView(view) {'), adminJs.indexOf('// Opening is two class flips'));
const labelsSrc = adminJs.slice(adminJs.indexOf('const ADMIN_SECTION_LABELS'), adminJs.indexOf('const ADMIN_PAGE'));

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

console.log('\n[6] the phone layout: the settings menu shape, and a shorter way out');
// The console's OWN block, found by a rule that only it carries: the same media
// query appears elsewhere in the stylesheet (the update banner's padding), and
// taking the first match would test the wrong block.
const phoneStart = css.indexOf('@media (max-width:820px),(max-height:560px) and (pointer:coarse){', css.indexOf('.adm-mhead'));
const phone = phoneStart < 0 ? '' : css.slice(phoneStart, css.indexOf('@media (max-width:600px)', phoneStart));
check(phone.length > 0, 'the console\'s phone media block exists');
check(/#admin-body\{flex-direction:column\}/.test(phone),
  'under 820px the menu and the panes stack in one column');
check(/#admin-page\.adm-section #admin-menu\{display:none\}/.test(phone),
  'and the view classes show the menu OR the section, never both (the settings master/detail)');
check(/#admin-page\.adm-menu #admin-panes\{display:none\}/.test(phone),
  'the phone pane column is hidden by the menu class alone');
check(!/^\s*\.adm-mhead\{/m.test(phone),
  'and the phone block never styles an unclassed .adm-mhead (a desktop open must not grow a detail header)');
check(/\.adm-mhead\{display:flex\}/.test(phone) || /#admin-page\.adm-section \.adm-mhead\{display:flex\}/.test(phone),
  'the phone detail header appears with them');
check(/\.adm-nav\{[^}]*min-height:52px[^}]*background:var\(--panel\)/.test(phone),
  'a menu row is a settings-shaped row: a surface, an icon, a label');
check(/\.adm-nav::after\{[\s\S]{0,220}border-right:2px solid var\(--faint\)/.test(phone),
  'with the chevron that says "this opens something" (as .set-tab::after does)');
check(/#admin-page\.adm-menu \.adm-head-reports\{display:none\}/.test(phone),
  'and the header chip stands down on the menu: the Reports row carries the count there');
// One bar per phone screen: in a section the detail header IS the bar, and the
// console header (mark + the way out of the console) is off the screen, since the
// way out is one step back — the menu — and two bars over one screen is one too
// many (owner request).
check(/#admin-page\.adm-section #admin-head\{display:none\}/.test(phone),
  'a section hides the console header: the detail header is the only bar');
check(/#admin-page\.adm-menu \.adm-nav\.active\{background:var\(--panel\);color:var\(--text\)\}/.test(phone)
  && !/#admin-page\.adm-menu \.adm-nav\.active\{background:var\(--accent-dim\)/.test(phone),
  'and no menu row is lit: a list of sections, not a tab strip (the accent would claim a section is open)');
check(/#admin-page #admin-panes\{[\s\S]{0,140}padding:\.5rem \.7rem 1rem/.test(phone),
  'the full-width overrides out-specify the desktop id rules (else the rail keeps its width)');check(/#admin-page\.adm-section #admin-panes\{padding-top:1\.2rem\}/.test(phone),
  'and an opened section starts below the detail header, not against it');
// The desktop rail must NOT be redrawn by the phone block: the row rules live
// under the media query only (an unscoped .adm-nav override would restyle the
// desktop rail too).
const navBase = /(^|\n)\.adm-nav\{([^}]*)\}/.exec(css);
check(!!navBase && /background:transparent/.test(navBase[2]) && /min-height:52px/.test(phone),
  'the desktop rail keeps its transparent row (the surface is the phone row\'s)', navBase && navBase[2]);
const narrow = /@media \(max-width:600px\)\{([\s\S]*?)\n\}/.exec(css);
check(!!narrow && /\.adm-back-t\{display:none\}/.test(narrow[1]) && /\.adm-back-s\{display:inline\}/.test(narrow[1]),
  'and under 600px the return button swaps to its short label', narrow && narrow[1]);
check(!!narrow && /\.adm-head-reports-tx\{display:none\}/.test(narrow[1]),
  'and the report chip drops its wording so the header cannot overflow', narrow && narrow[1]);
check(!!narrow && /\.adm-filter\{flex-wrap:wrap\}/.test(narrow[1]) && /\.adm-filter input\{flex:1 1 100%\}/.test(narrow[1]),
  'and a search row gives its field a full line', narrow && narrow[1]);
check((adminJs.match(/class="row adm-filter"/g) || []).length === 3,
  'the three search rows (users, reports, servers) carry that class');

console.log('\n[7] the phone view is one class flip, and it is wired by name');
check(/const ADMIN_SECTION_LABELS = \{[\s\S]{0,240}overview: 'Overview'[\s\S]{0,200}servers: 'Servers'/.test(adminJs),
  'every section has its own name for the phone header (the row that was tapped is gone)');
check(/const ADMIN_PHONE_MQ = '\(max-width:820px\), \(max-height:560px\) and \(pointer:coarse\)';/.test(adminJs),
  'the console\'s phone breakpoint is the SAME condition its stylesheet block uses (no JS/CSS drift)');
check(/function adminIsPhone\(\) \{ return !!window\.matchMedia && matchMedia\(ADMIN_PHONE_MQ\)\.matches; \}/.test(adminJs),
  'and the phone test reads it (not phoneLayout(), whose 700px is narrower than the console\'s block)');
check(/function matchAdminView\(\) \{ setAdminView\(adminIsPhone\(\) \? 'adm-section' : 'menu'\); \}/.test(adminJs),
  'the view follows the layout (inert on desktop: both classes are meaningless there)');
check(/paintAdminTitle\(t\);/.test(adminJs) && /function setAdminTab\(t\) \{/.test(adminJs),
  'opening a section paints its name into the header');
check(/if \(!tab && adminIsPhone\(\)\) setAdminView\('adm-menu'\);/.test(adminJs),
  'a bare open (the shield) lands on the phone MENU, like the settings gear');
check(/sectionBack\.onclick = \(\) => setAdminView\('adm-menu'\)/.test(adminJs),
  'and the detail header\'s arrow steps back to the menu');
check(/back\.onclick = closeAdminConsole/.test(adminJs),
  'while Return to Campfire still leaves the console entirely');
check(/mq\.addEventListener\('change', onPhoneChange\)/.test(adminJs) && /mq\.addListener\(onPhoneChange\)/.test(adminJs),
  'a breakpoint change re-derives the view (a window dragged narrow, or a rotation)');
check(/id="admin-back"/.test(adminMarkup) && /id="admin-title"/.test(adminMarkup),
  'the detail header exists in the markup with its way back and its name');
check(/class="adm-mhead"/.test(adminMarkup), 'as the mobile header row (.adm-mhead, desktop-hidden)');

const chrome = findChrome();
if (!chrome) return skip('no Chrome/Edge found — set CHROME_PATH');

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<!-- No transitions: a view-class flip is MEASURED here (the menu's rows, the
     section's bars), and headless Chrome's virtual time does not advance the
     animation clock, so a transitioned background reads back as the value it is
     leaving — the old one. Settling instantly is what makes the reading true. -->
<style>*{animation:none!important;transition:none!important}</style></head><body>
${viewMain}
<script>
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cs = (el) => getComputedStyle(el);
const rt = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), y: Math.round(r.y), h: Math.round(r.height) }; };
${labelsSrc}
${viewSrc}
(async () => {
  const out = {};
  // The console's own helpers reach for the $ selector (core.js's global in the
  // real app), so the harness has to provide it: without it paintAdminTitle
  // throws inside the promise and the page title never lands.
  window.$ = window.q = (s) => document.querySelector(s);
  const q = window.q;
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
  out.panes = { scroll: cs(q('#admin-panes')).overflowY, hidden: [...document.querySelectorAll('#admin-panes .set-pane')].filter((p) => p.classList.contains('hidden')).length };
  // No class set yet: this is what a browser that opened the console and never
  // touched a row would draw, and it is how the DESKTOP is meant to look.
  out.default = { detailHead: cs(q('.adm-mhead')).display, menu: cs(q('#admin-menu')).display, panes: cs(q('#admin-panes')).display };
  // The phone menu, for real: the helpers under test are the real ones, calling
  // the real stylesheet.
  setAdminView('adm-menu');
  paintAdminTitle('overview');
  await wait(60);
  const nav = q('#admin-menu .adm-nav');
  const navs = rt(nav);
  // The Reports row's count badge is hidden until a count lands; show it while
  // the row is measured, because that badge is what the label must make room for.
  const rbadge = q('#adm-reports-badge');
  rbadge.classList.remove('hidden');
  rbadge.textContent = '4';
  const rrow = q('#admin-menu .adm-nav[data-atab="reports"]');
  out.menu = {
    page: page.className,
    menu: cs(q('#admin-menu')).display, panes: cs(q('#admin-panes')).display,
    detailHead: cs(q('.adm-mhead')).display,
    label: cs(q('.adm-menu-label')).display,
    chip: cs(q('#adm-head-reports')).display,
    dir: cs(q('#admin-menu')).flexDirection,
    nav: navs,
    navBg: cs(nav).backgroundColor,
    // The row the markup ships lit (Overview) against an untouched sibling: on a
    // phone they have to read the same, on the desktop rail they must not.
    activeBg: cs(q('#admin-menu .adm-nav.active')).backgroundColor,
    plainBg: cs(q('#admin-menu .adm-nav[data-atab="media"]')).backgroundColor,
    activeIc: cs(q('#admin-menu .adm-nav.active .adm-nav-ic')).color,
    plainIc: cs(q('#admin-menu .adm-nav[data-atab="media"] .adm-nav-ic')).color,
    chevron: getComputedStyle(nav, '::after').content !== 'none',
    ident: rt(q('.adm-nav-ic')), text: rt(q('.adm-nav-tx')),
    rrow: rt(rrow), rtext: rt(rrow.querySelector('.adm-nav-tx')), badge: rt(rbadge),
    headOverflow: Math.round(head.scrollWidth - head.clientWidth),
  };
  // The section view: one section alone, the detail header up, back on the left.
  setAdminView('adm-section');
  paintAdminTitle('reports');
  await wait(60);
  const det = q('.adm-mhead');
  out.section = {
    page: page.className,
    menu: cs(q('#admin-menu')).display, panes: cs(q('#admin-panes')).display,
    detailHead: cs(det).display, title: q('#admin-title').textContent.trim(),
    back: rt(q('#admin-back')), head: rt(det),
    adminHead: cs(head).display,
    chip: cs(q('#adm-head-reports')).display,
    chipParent: q('#adm-head-reports').parentElement.className,
    chipRect: rt(q('#adm-head-reports')),
    detailOverflow: Math.round(det.scrollWidth - det.clientWidth),
    headOverflow: Math.round(head.scrollWidth - head.clientWidth),
  };
  out.labels = ['overview', 'reports', 'media', 'users', 'servers', 'nope'].map(adminTabLabel);
  setAdminView('menu');
  out.backToMenu = { menu: cs(q('#admin-menu')).display, panes: cs(q('#admin-panes')).display };

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
    try {
      return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    } catch (e) {
      return { err: 'bad title (' + e.message + '): ' + m[1].slice(0, 200) + ' :: ' + (r.stderr || '').slice(-300) };
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

console.log('\n[8] the real page against the real shell (headless Chrome, desktop)');
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
  check(desk.menu.dir === 'column', 'as a side column on a desktop', desk.menu.dir);
  check(desk.panes.scroll === 'auto' && desk.panes.hidden === 4, 'the panes scroll, with Overview the only one showing', desk.panes);
  // The mobile pair is INERT here: no detail header, menu and panes together —
  // even with a view class set, which is the whole point of the classes.
  check(desk.default.menu !== 'none' && desk.default.panes !== 'none', 'the menu and the panes show together by default', desk.default);
  check(desk.default.detailHead === 'none', 'and no phone detail header', desk.default);
  check(desk.menu.menu !== 'none' && desk.menu.panes !== 'none' && desk.menu.detailHead === 'none',
    'a phone view class changes nothing on a desktop (one set of rules, no second layout)', desk.menu);
  check(desk.menu.activeBg !== desk.menu.plainBg && desk.menu.activeIc !== desk.menu.plainIc,
    'and the desktop rail still lights the open row (the menu rule is the phone\'s alone)', desk.menu);
  check(desk.section.adminHead !== 'none' && desk.section.chipParent === '',
    'the console header stays up on a desktop section, with the chip still in it (#admin-head carries no class)', desk.section);
  check(desk.back.visible && desk.back.full && !desk.back.short && !desk.back.wraps, 'the full return label shows and does not wrap', desk.back);
  check(desk.head.overflow === 0 && desk.head.chipTx && desk.head.chipRight <= desk.viewport.w,
    'and the header fits with the queue chip spelled out', desk.head);
  check(desk.labels.join(',') === 'Overview,Reports,Media,Users,Servers,Instance console',
    'the phone header takes its name off the section table', desk.labels);
  check(desk.restored.left !== 'none' && desk.restored.rail > 0 && desk.restored.members !== 'none', 'clearing the flag puts the shell back', desk.restored);
}

console.log('\n[9] the same page in a real 390px viewport (headless Chrome, iframe)');
const phoneOut = run(chrome, { 'page.html': pageHtml(), 'narrow.html': pageHtml(), 'frame.html': frameHtml() }, 'frame.html', '1280,800');
if (phoneOut.err) { check(false, 'the phone harness ran', phoneOut.err); }
else {
  check(phoneOut.viewport.w === 390, 'the frame really is 390px wide', phoneOut.viewport);
  check(phoneOut.page.w === 390 && phoneOut.page.h === 700, 'the page owns that screen too', { page: phoneOut.page });
  check(phoneOut.shell.left === 'none' && phoneOut.shell.members === 'none',
    'the fixed member drawer (z-index 45) stands down with the rest', phoneOut.shell);
  check(phoneOut.back.visible && !phoneOut.back.full && phoneOut.back.short, 'and the return button shows its short label', phoneOut.back);
  check(!phoneOut.back.wraps, 'so the header does not wrap at 390px', phoneOut.back);
  check(phoneOut.head.overflow === 0 && !phoneOut.head.chipTx && phoneOut.head.chipRight <= 390,
    'and the queue chip keeps its count inside the screen (its wording stands down)', phoneOut.head);

  console.log('\n[9a] and the phone menu is the settings menu: a list of section rows');
  check(phoneOut.menu.page.includes('adm-menu') && !phoneOut.menu.page.includes('adm-section'), 'the menu view is the class the stylesheet reads', phoneOut.menu.page);
  check(phoneOut.menu.menu !== 'none' && phoneOut.menu.panes === 'none', 'the menu takes the whole body, the panes step aside', phoneOut.menu);
  check(phoneOut.menu.detailHead === 'none', 'and the menu carries no detail header (it IS the front page)', phoneOut.menu);
  check(phoneOut.menu.label !== 'none', 'its "Console" group label survives, as the settings rail keeps its own heading', phoneOut.menu);
  check(phoneOut.menu.chip === 'none', 'the header chip stands down here (the Reports row carries the count)', phoneOut.menu);
  check(phoneOut.menu.dir === 'column', 'the rows stack in a column, not a horizontal rail', phoneOut.menu);
  check(phoneOut.menu.activeBg === phoneOut.menu.plainBg && phoneOut.menu.activeIc === phoneOut.menu.plainIc,
    'and no row is lit: the menu is a list of sections, not a tab strip (the last visit must not leave one looking open)',
    { active: phoneOut.menu.activeBg, plain: phoneOut.menu.plainBg });
  check(phoneOut.menu.nav.x === 11 && Math.abs(phoneOut.menu.nav.w - (390 - 11 - 11)) <= 1,
    'a row spans the menu width with its own inset (the settings rail\'s .7rem)', { nav: phoneOut.menu.nav, vw: 390 });
  check(phoneOut.menu.nav.h >= 52, 'and is a 52px touch row, like a settings row', phoneOut.menu.nav);
  check(phoneOut.menu.chevron, 'with the chevron pseudo-element the settings rows use');
  check(phoneOut.menu.ident.x >= phoneOut.menu.nav.x + 13 && phoneOut.menu.text.x > phoneOut.menu.ident.x + phoneOut.menu.ident.w,
    'icon first, then the label — the icon keeps the row inset', { ident: phoneOut.menu.ident, text: phoneOut.menu.text, nav: phoneOut.menu.nav });
  // The count badge has to sit where the trailing edge leaves room for it: after
  // the label and before the chevron. The label is what grows (an auto margin on
  // an inline-block badge does nothing in a flex row), or the badge lands against
  // the label's ellipsis end and never reaches the trailing edge.
  check(phoneOut.menu.badge.x > phoneOut.menu.rtext.x + phoneOut.menu.rtext.w - 1
    && phoneOut.menu.badge.x + phoneOut.menu.badge.w <= phoneOut.menu.rrow.x + phoneOut.menu.rrow.w - 12,
    'the report count rides the trailing edge, between the label and the chevron',
    { badge: phoneOut.menu.badge, text: phoneOut.menu.rtext, row: phoneOut.menu.rrow });
  check(phoneOut.menu.headOverflow === 0, 'and the header still fits at 390px on the menu', phoneOut.menu);

  console.log('\n[9b] a section opens alone, with back on the left');
  check(phoneOut.section.page.includes('adm-section'), 'the section view is the other class', phoneOut.section.page);
  check(phoneOut.section.menu === 'none' && phoneOut.section.panes !== 'none', 'the menu steps aside and the section shows alone', phoneOut.section);
  check(phoneOut.section.detailHead === 'flex', 'under the phone detail header', phoneOut.section);
  check(phoneOut.section.title === 'Reports', 'which names the section the reader is looking at', phoneOut.section);
  check(phoneOut.section.back.x < phoneOut.section.head.w / 2, 'back on the left half, the step to the menu', phoneOut.section);
  check(phoneOut.section.back.x + phoneOut.section.back.w <= phoneOut.section.head.w + 1 && phoneOut.section.detailOverflow === 0,
    'and nothing spills off the 390px screen', phoneOut.section);
  check(phoneOut.section.adminHead === 'none',
    'the console header stands down in a section: ONE bar, not two stacked over one screen', phoneOut.section);
  check(phoneOut.section.chip !== 'none' && /adm-mhead/.test(phoneOut.section.chipParent),
    'and the queue chip rides that one bar (the shortcut survives the bar it used to live in)', phoneOut.section);
  check(phoneOut.section.chipRect.x + phoneOut.section.chipRect.w <= phoneOut.section.head.x + phoneOut.section.head.w + 1
    && phoneOut.section.chipRect.x > phoneOut.section.back.x + phoneOut.section.back.w,
    'on the trailing edge, past the section name', { chip: phoneOut.section.chipRect, head: phoneOut.section.head });
  check(phoneOut.labels.join(',') === 'Overview,Reports,Media,Users,Servers,Instance console',
    'every section has a phone name, and an unknown one falls back to the console', phoneOut.labels);
  check(phoneOut.backToMenu.menu !== 'none' && phoneOut.backToMenu.panes === 'none', 'back returns to the menu', phoneOut.backToMenu);
}

console.log('');
if (failures.length) {
  console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log(`All ${passed} checks passed.`);
