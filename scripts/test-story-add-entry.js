// Adding to your story from Home + the home-screen shortcut (see AGENTS.md
// verification conventions).
//
// The complaint: getting a post out on a phone was a navigation exercise. In a
// server the sidebar's Stories row already carries an accent ＋, but Home's row
// had no add affordance at all — you had to open the story center and use its
// header button (☰ → Stories → Post story) or find "Post to your story" inside
// the *message* composer's menu. Two changes, both pinned here:
//
//  1. Home's Stories row carries the same accent ＋ as the server sidebar's row,
//     so adding a post is ☰ → ＋. That ＋ is a SIBLING pinned over the row's
//     trailing edge, never a nested one: a <button> cannot nest a <button>, and
//     the obvious alternative (div[role=button], the shape the server row uses)
//     would drop the row out of the UA button font the Friends row above it
//     renders in — the same row, in a different typeface.
//  2. A home-screen shortcut ("Add to story") lands at /?story=1, which boot
//     turns into the story camera. The URL is cleaned before the camera opens.
//
// Offline checks (markup, stylesheet, wiring, manifest, deep-link shape) always
// run. Then headless Chrome drives the REAL markup + the REAL stylesheet and the
// REAL wiring and boot deep-link code pulled out of stories.js / auth.js, at a
// phone and a desktop viewport (skips without Chrome).
//
// Usage: node scripts/test-story-add-entry.js
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
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const stories = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');
const auth = fs.readFileSync(path.join(ROOT, 'public/js/auth.js'), 'utf8');
const manifestRaw = fs.readFileSync(path.join(ROOT, 'public/manifest.webmanifest'), 'utf8');
let manifest = null;
try { manifest = JSON.parse(manifestRaw); } catch {}

// The real markup for an element id (the whole element, children included).
function markupFor(id, tag) {
  const start = index.indexOf('<' + tag + ' id="' + id + '"');
  if (start < 0) return null;
  const end = index.indexOf('</' + tag + '>', start);
  return end < 0 ? null : index.slice(start, end + tag.length + 3);
}
// The real wiring between two markers in stories.js.
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}
// The real boot deep-link chain out of auth.js: everything after its
// URLSearchParams line, minus the trailing "} catch {}" of its own try.
function deepLinkBlock() {
  const a = auth.indexOf('const qs = new URLSearchParams(location.search);');
  const b = auth.indexOf('// shared from the Android system share sheet', a);
  if (a < 0 || b < 0) { console.error('[test] could not find the boot deep-link block in auth.js'); process.exit(1); }
  return auth.slice(a, b).replace(/\}\s*catch\s*\{\}\s*$/, '');
}

const rowBlock = markupFor('btn-stories', 'button');
const friendsBlock = markupFor('btn-friends', 'button');
const wrapStart = index.indexOf('<div id="stories-nav-wrap">');
const wrapEnd = index.indexOf('<div id="anow-strip"');
const wrapBlock = (wrapStart >= 0 && wrapEnd > wrapStart)
  ? index.slice(wrapStart, index.lastIndexOf('</div>', wrapEnd) + 6)
  : null;

console.log('\n[1] the ＋ is a sibling of the row, not nested in it');
check(!!wrapBlock && /id="btn-stories"/.test(wrapBlock) && /id="stories-nav-add"/.test(wrapBlock),
  'Home\'s Stories row is wrapped together with its ＋');
check(!!rowBlock && /^<button /.test(rowBlock), 'the row is still a real <button> (keyboard, and the Friends row\'s typeface)', rowBlock && rowBlock.slice(0, 24));
check(!!rowBlock && !/stories-nav-add/.test(rowBlock), 'and the ＋ is NOT inside it (a button cannot nest a button)');
check(/<button type="button" id="stories-nav-add" class="ss-add" title="Add to your story" aria-label="Add to your story">/.test(index),
  'the ＋ reuses the server sidebar row\'s .ss-add control and is labelled for screen readers');
check(/id="stories-nav-add"[\s\S]{0,400}?<path d="M12 5v14M5 12h14"\/>/.test(index),
  'and draws the same plus glyph svgSvg.plus does');

console.log('\n[2] the stylesheet: the row pays for the slot, the ＋ stays reachable');
check(/#stories-nav-wrap\{position:relative;display:flex;margin-top:\.3rem\}/.test(css), 'the wrapper anchors the ＋ (and carries the row\'s old .3rem gap)');
check(/#stories-nav-wrap #btn-stories\{margin-top:0;padding-right:2\.7rem\}/.test(css),
  'the row gives up the trailing slot and its own margin, so the wrapper IS its box (the centred ＋ lands on the row, not 2.4px high)');
check(/#stories-nav-add\{position:absolute;right:\.6rem;top:50%;transform:translateY\(-50%\)\}/.test(css),
  'the ＋ is pinned to the row\'s trailing edge, vertically centred');
check(/#stories-nav-add svg\{color:var\(--on-accent\)\}/.test(css),
  'the glyph keeps the on-accent white (the row\'s muted-svg rule would grey it on the accent circle)');
check(/#stories-nav-add::after\{content:'';position:absolute;inset:-10px -9px;border-radius:50%\}/.test(css),
  'a phone grows the 24px circle a ~42x44 hit box without resizing it');
// The other "create" ＋ in the same list: same shape, and the same trailing
// inset, or it sits 5.6px out of column with this one.
check(/#btn-group-new\{width:24px;height:24px;min-height:24px;padding:0;border-radius:50%;background:var\(--accent\);color:var\(--on-accent\)\}/.test(css),
  'the GROUP CHATS ＋ is the same shape as this one (24px accent circle, not a grey square)');
check(/\.chan-group-label\.row-between\{padding-right:\.6rem\}/.test(css),
  'and the section label it sits in uses the Home list\'s trailing inset (.6rem), so the two line up');
// The rule must live inside the phone-nav @media block — the nearest @media
// above it has to be the one condition every mobile block spells out.
const afterIx = css.indexOf('#stories-nav-add::after');
const mediaIx = css.lastIndexOf('@media', afterIx);
const mediaCond = css.slice(mediaIx, css.indexOf('{', mediaIx));
check(afterIx > 0 && /\(max-width:700px\),\(max-height:560px\) and \(pointer:coarse\)/.test(mediaCond),
  'and only under the phone condition (never on a fine pointer)', mediaCond);

console.log('\n[3] the wiring');
check(/\$\('#stories-nav-add'\)\.onclick = \(\) => createStory\(\{\}\);/.test(stories),
  'the ＋ starts a post (friends default, like the story center\'s own button)');
check(/\$\('#btn-stories'\)\.onclick = \(\) => showStoriesPanel\(\)/.test(stories), 'the row itself still opens the story center');

console.log('\n[4] the home-screen shortcut');
const shortcuts = (manifest && manifest.shortcuts) || [];
const addSc = shortcuts.find((s) => s && typeof s.url === 'string' && /[?&]story=1\b/.test(s.url));
check(!!addSc, 'the manifest declares an "add to story" shortcut', shortcuts.map((s) => s && s.url));
check(!!addSc && /add/i.test((addSc.name || '') + ' ' + (addSc.short_name || '')), 'named so the long-press menu reads as adding a post', addSc && addSc.name);
check(!!addSc && addSc.url.charAt(0) === '/', 'its url is inside the app scope (a cross-scope shortcut never appears)', addSc && addSc.url);
check(!!addSc && (addSc.icons || []).some((i) => i && fs.existsSync(path.join(ROOT, 'public', String(i.src).replace(/^\//, '')))),
  'and it carries an icon the server actually serves', addSc && addSc.icons);
check(/qs\.get\('story'\)/.test(auth) && /if \(qdm \|\| qserv \|\| qfriends \|\| qadmin \|\| qstory\)/.test(auth),
  'boot reads the story param and cleans it out of the URL (a refresh must not reopen the camera)');
check(/else if \(qstory\) \{[\s\S]*?await openStoryComposer\(\{\}\)/.test(auth), 'and lands in the story camera');
check(/else if \(qfriends\) \{[\s\S]*?\} else if \(qstory\) \{/.test(auth),
  'the story branch is last, so a notification deep link still outranks it');

// ---------- headless Chrome ----------
// The real createStory/openStoryNewMenu/closeStoryNewMenu (this harness is the
// phone nav's, so isCoarse() is true: the entry must go straight to the camera
// and never touch the desktop chooser — that lives in test-story-new-menu.js).
const createSrc = slice(stories, 'let snOpts = null;', 'async function openStoryComposer(opts = {}) {');
function pageHtml() {
  const deep = deepLinkBlock();
  const wire = slice(stories, "$('#btn-stories').onclick", "$('#sp-post').onclick");
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>#view-main{height:100vh}</style></head><body>
<section id="view-main"><div id="left">
  <nav id="rail"></nav>
  <aside id="sidebar">
    <div id="server-ui" class="hidden"></div>
    <div id="home-ui">
      <div class="home-head"><strong>Home</strong></div>
      ${friendsBlock}
      ${wrapBlock}
      <div id="anow-strip" class="hidden"><div class="chan-group-label">ACTIVE NOW</div><div class="anow-rail" id="anow-rail"></div></div>
      <div class="chan-group-label">DIRECT MESSAGES</div>
      <div id="dm-list"></div>
      <div class="chan-group-label row-between">GROUP CHATS <button id="btn-group-new" class="mini" title="New group chat"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg></button></div>
      <div id="group-list"></div>
    </div>
  </aside>
</div><main id="chat"></main></section>
<script>
const params = new URLSearchParams(location.search);
if (params.get('nav') === '1') document.body.classList.add('nav-open');

// One shared counter: the REAL wiring below and the REAL deep-link chain further
// down both call openStoryComposer, and a case must never see the other's tally.
const calls = { composer: 0, panel: 0, dm: [], admin: [], rs: [] };
function resetCalls() { calls.composer = 0; calls.panel = 0; calls.dm = []; calls.admin = []; calls.rs = []; }

// ---- the REAL createStory block out of stories.js, with its two calls stubbed ----
const $ = (sel) => document.querySelector(sel);
let sc = null;                       // no composer is running in this page
function isCoarse() { return true; } // a phone: the entry must skip the chooser
function toast() {}
function showStoriesPanel() { calls.panel++; }
function openStoryComposer() { calls.composer++; return Promise.resolve(true); }
eval(${JSON.stringify(createSrc)});
// ---- the REAL wiring out of stories.js, with its two calls stubbed ----
eval(${JSON.stringify(wire)});
// the rule in ui.js that closes the phone nav page when a nav row is tapped
document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('#btn-friends, #btn-stories')) document.body.classList.remove('nav-open');
});

// ---- the REAL boot deep-link chain out of auth.js, with the URL faked ----
let CASE_PARAMS = {};
window.S = { dms: [{ id: 't1' }], servers: [{ id: 's1' }] };
function isSiteAdmin() { return true; }
function openAdminConsole(x) { calls.admin.push(x); }
async function openHome() {}
function showFriendsPanel() { calls.panel++; }
function selectDmThread(id) { calls.dm.push(id); }
async function api() { throw new Error('offline'); }
async function refreshDms() {}
const realRS = history.replaceState.bind(history);
history.replaceState = function (a, b, c) { calls.rs.push(c); try { realRS(a, b, c); } catch (e) {} };
const DEEP_SRC = ${JSON.stringify(deep)};
async function runDeep(q) {
  CASE_PARAMS = Object.fromEntries(new URLSearchParams(q));
  resetCalls();
  // The snippet reads location.search; shadow the constructor so one page load
  // can drive every case, and hand the real code through untouched.
  const src = '(async () => { const URLSearchParams = function () { return { get: (k) => (k in CASE_PARAMS ? CASE_PARAMS[k] : null) }; };'
    + ' try { ' + DEEP_SRC + ' } catch (e) { return String(e); } })()';
  const err = await eval(src);
  return { q, err, composer: calls.composer, dm: calls.dm.slice(), panel: calls.panel, admin: calls.admin.slice(), rs: calls.rs.slice() };
}

const box = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
const hitsAdd = (x, y) => { const el = document.elementFromPoint(x, y); return !!(el && el.closest && el.closest('#stories-nav-add')); };
const owner = (x, y) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return 'none';
  for (const [sel, name] of [['#stories-nav-add', 'add'], ['#btn-stories', 'row'], ['#btn-friends', 'friends'], ['.chan-group-label', 'label'], ['#anow-strip', 'anow']]) {
    if (el.closest(sel)) return name;
  }
  return el.tagName.toLowerCase();
};

window.__report = async function () {
  const row = document.getElementById('btn-stories');
  const add = document.getElementById('stories-nav-add');
  const friends = document.getElementById('btn-friends');
  const wrap = document.getElementById('stories-nav-wrap');
  const groupPlus = document.getElementById('btn-group-new');
  const cam = row.querySelector('svg');
  const rb = box(row), ab = box(add), fb = box(friends), wb = box(wrap), cb = box(cam);
  const gb = box(groupPlus);
  const cx = (ab.l + ab.r) / 2, cy = (ab.t + ab.b) / 2;
  const probe = { at0: hitsAdd(cx, cy), up18: hitsAdd(cx, cy - 18), down18: hitsAdd(cx, cy + 18), up30: hitsAdd(cx, cy - 30) };
  document.body.classList.add('nav-open');
  resetCalls();
  add.click();
  const afterAdd = { composer: calls.composer, panel: calls.panel, navOpen: document.body.classList.contains('nav-open') };
  resetCalls();
  row.click();
  const afterRow = { composer: calls.composer, panel: calls.panel, navOpen: document.body.classList.contains('nav-open') };
  const deep = [];
  for (const q of ['?story=1', '?story=1&dm=t1', '?dm=t1', '?friends=1', '?admin=reports']) deep.push(await runDeep(q));
  return {
    vw: innerWidth, vh: innerHeight, pathname: location.pathname,
    rowTag: row.tagName, rowTab: row.tabIndex, nested: !!row.querySelector('#stories-nav-add'),
    row: rb, add: ab, friends: fb, wrap: wb, cam: cb, groupPlus: gb,
    // The two "create" ＋s in the Home list share one column: the Stories row's
    // and the GROUP CHATS header's, two rows apart.
    plusAlign: { right: +(ab.r - gb.r).toFixed(2), left: +(ab.l - gb.l).toFixed(2), size: +((ab.w - gb.w) || (ab.h - gb.h)).toFixed(2) },
    // the hit box the CSS adds, measured the way the browser uses it
    hitBox: { l: ab.l - 9, t: ab.t - 10, r: ab.r + 9, b: ab.b + 10 },
    probe, afterAdd, afterRow, deep,
    friendsCenter: owner((fb.l + fb.r) / 2, (fb.t + fb.b) / 2),
    rowFont: getComputedStyle(row).fontFamily, friendsFont: getComputedStyle(friends).fontFamily,
    addColor: getComputedStyle(add.querySelector('svg')).color, camColor: getComputedStyle(cam).color,
  };
};
setTimeout(async () => {
  try { document.title = JSON.stringify(await window.__report()); }
  catch (e) { document.title = JSON.stringify({ fatal: (e && e.message) || String(e) }); }
}, 250);
</script>
</body></html>`;
}

function probe(chrome, url, { width, height, dpr }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-storyadd-'));
  try {
    const args = [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + path.join(dir, 'prof'), '--force-device-scale-factor=' + dpr,
      '--window-size=' + width + ',' + height, '--virtual-time-budget=4000', '--dump-dom', url,
    ];
    const r = spawnSync(chrome, args, { encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024 });
    const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
    if (!m) throw new Error('no title in dump (chrome status ' + r.status + ')');
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function chromeHalf() {
  const chrome = findChrome();
  if (!chrome) return skip('no Chrome/Edge found (set CHROME_PATH)');
  if (!wrapBlock || !friendsBlock) return skip('could not extract the nav row markup from index.html');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-storyadd-page-'));
  try {
    const htmlPath = path.join(dir, 'page.html');
    fs.writeFileSync(htmlPath, pageHtml());
    const base = 'file:///' + htmlPath.replace(/\\/g, '/');

    console.log('\n[5] the phone nav row (real markup + real stylesheet)');
    const phone = probe(chrome, base + '?nav=1', { width: 390, height: 844, dpr: 3 });
    if (phone.fatal) throw new Error('page reported: ' + phone.fatal);
    check(phone.vw <= 700, 'the probe really runs in the phone layout', { vw: phone.vw });
    check(phone.rowTag === 'BUTTON' && phone.rowTab === 0 && !phone.nested,
      'the row is a focusable button and the ＋ is not inside it', { tag: phone.rowTag, tab: phone.rowTab, nested: phone.nested });
    check(Math.abs((phone.add.t + phone.add.b) / 2 - (phone.row.t + phone.row.b) / 2) <= 1,
      'the ＋ sits on the row\'s centre line', { add: phone.add, row: phone.row });
    check(phone.add.r <= phone.row.r - 8 && phone.add.l >= phone.cam.r + 6,
      'it is inside the row\'s trailing slot, clear of the camera icon', { add: phone.add, cam: phone.cam, row: phone.row });
    check(phone.hitBox.l >= phone.row.l && phone.hitBox.r <= phone.wrap.r - 0.5,
      'the grown hit box stays inside the row (no sideways overflow to scroll)', { hitBox: phone.hitBox, row: phone.row, wrap: phone.wrap });
    check(phone.hitBox.t >= phone.friends.b - 0.5 && phone.hitBox.b <= phone.row.b + 3.5,
      'and inside the gap around the row — the Friends row above keeps its own taps', { hitBox: phone.hitBox, friends: phone.friends });
    check(phone.probe.at0 && phone.probe.up18 && phone.probe.down18,
      'a thumb 18px above/below the centre still lands on the ＋ (24px circle, 44px target)', phone.probe);
    check(phone.probe.up30 === false, 'but the target is bounded (~44px), not the whole column', phone.probe);
    check(phone.friendsCenter === 'friends', 'and the Friends row above is still reachable', { center: phone.friendsCenter });
    // Two "create" ＋s sit in this list, two rows apart. The GROUP CHATS header
    // carried .95rem of right padding while every trailing action in the Home
    // list sits at .6rem, so its ＋ was 5.6px left of this one — visibly out of
    // column. Both edges are pinned, so a change to either inset has to keep
    // them together.
    check(phone.plusAlign.right === 0 && phone.plusAlign.left === 0,
      'the GROUP CHATS ＋ below lines up with the Stories ＋ (same column, both edges)', phone.plusAlign);
    check(phone.plusAlign.size === 0, 'and the two are the same size', phone.plusAlign);

    console.log('\n[6] the two targets do their own thing');
    check(phone.afterAdd.composer === 1 && phone.afterAdd.panel === 0,
      'tapping the ＋ opens the composer and NOT the story center', phone.afterAdd);
    check(phone.afterRow.panel === 1 && phone.afterRow.composer === 0,
      'tapping the row opens the story center and NOT the composer', phone.afterRow);
    check(phone.afterRow.navOpen === false, 'the row closes the phone nav page (ui.js)', phone.afterRow);
    check(phone.afterAdd.navOpen === true,
      'the ＋ leaves it open behind the composer — the server sidebar\'s ＋ behaves the same', phone.afterAdd);
    check(phone.rowFont === phone.friendsFont, 'both nav rows still render in the same typeface', { row: phone.rowFont, friends: phone.friendsFont });
    check(phone.addColor !== phone.camColor, 'the ＋ keeps the on-accent glyph while the row\'s icons stay muted', { add: phone.addColor, cam: phone.camColor });

    console.log('\n[7] the deep link really drives the camera');
    const byQ = Object.fromEntries(phone.deep.map((d) => [d.q, d]));
    const story = byQ['?story=1'];
    check(story && !story.err, '?story=1 runs without error', story && story.err);
    check(story && story.composer === 1 && !story.dm.length && !story.panel && !story.admin.length,
      'it opens the story camera and nothing else', story);
    check(story && story.rs.length === 1 && story.rs[0] === phone.pathname && !/\?/.test(String(story.rs[0])),
      'and it strips the param before composing (a refresh must not reopen the camera)', story && story.rs);
    const dm = byQ['?dm=t1'];
    check(dm && dm.dm.length === 1 && dm.composer === 0, '?dm=ID still opens the DM', dm);
    const both = byQ['?story=1&dm=t1'];
    check(both && both.dm.length === 1 && both.composer === 0, 'a notification link outranks the shortcut', both);
    const fr = byQ['?friends=1'];
    check(fr && fr.panel === 1 && fr.composer === 0, '?friends=1 still opens Friends', fr);
    const ad = byQ['?admin=reports'];
    check(ad && ad.admin.length === 1 && ad.composer === 0, '?admin=reports still opens the console', ad);

    console.log('\n[8] desktop keeps the plain 24px circle');
    const desk = probe(chrome, base, { width: 1100, height: 760, dpr: 2 });
    if (desk.fatal) throw new Error('page reported: ' + desk.fatal);
    check(desk.probe.at0 === true, 'the ＋ is still clickable on desktop');
    check(desk.probe.up18 === false && desk.probe.down18 === false,
      'but its hit box does not grow there (phone-only rule)', desk.probe);
    check(Math.abs(desk.add.w - 24) <= 0.5 && Math.abs(desk.add.h - 24) <= 0.5,
      'the circle stays 24px in both layouts', { w: desk.add.w, h: desk.add.h });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

chromeHalf();
console.log('\n' + (failures.length ? failures.length + ' FAILED, ' + passed + ' passed' : 'all ' + passed + ' checks passed'));
if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
