// "Send a view-once" opens the recipient picker with the DM you clicked it in
// already selected (see AGENTS.md verification conventions).
//
// The complaint: you are in a DM with someone, you hit composer → Send a
// view-once, shoot, and the "Who gets this?" menu is empty — so you have to
// find that same person again in a friends list sorted by someone else's
// alphabet, with nothing telling you the empty picker is even normal. The
// composer now arrives with that person picked (viewOnceDmPeerId +
// viewOncePrePick in public/js/stories.js).
//
// Offline: both REAL helpers are sliced out of public/js/stories.js and driven
// with stubbed S, plus static checks on the wiring. Then the REAL
// renderStoryAudience is driven against the real #sc-pick markup + stylesheet
// in headless Chrome (skips without Chrome): a pre-picked friend's row is the
// lit, aria-pressed one and the count/button agree, an un-picked peer leaves
// the menu honestly empty, and tapping a second friend adds them.
//
// Usage: node scripts/test-viewonce-pick.js
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

const stories = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const src = stories;
function slice(from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block in public/js/stories.js'); process.exit(1); }
  return src.slice(a, b);
}
// Both helpers live together, right above openStoryComposer.
const code = slice('function viewOnceDmPeerId() {', 'async function openStoryComposer(');
global.S = { me: { id: 'me' } };
// Strict mode gives eval its own scope, so hand the functions back explicitly.
const { viewOnceDmPeerId, viewOncePrePick } = eval(code + '\n;({ viewOnceDmPeerId, viewOncePrePick })');

const dm = (id, members, extra) => ({ id, members, ...(extra || {}) });
const me = { id: 'me', username: 'me' };
const them = { id: 'u2', username: 'ada' };

console.log('\n[1] the peer of an open 1:1 DM');
global.S = { me, view: 'home', dmThreadId: 't1', dms: [dm('t1', [me, them]), dm('t2', [me, { id: 'u3' }])] };
check(viewOnceDmPeerId() === 'u2', 'a 1:1 DM → the other member', { got: viewOnceDmPeerId() });
global.S.dmThreadId = 't2';
check(viewOnceDmPeerId() === 'u3', 'a different thread → that thread\'s peer');

console.log('\n[2] nowhere to pick from stays empty');
global.S = { me, view: 'server', channelId: 'c1', dmThreadId: 't1', dms: [dm('t1', [me, them])] };
check(viewOnceDmPeerId() === '', 'a server channel has no single recipient (even with a DM still open)');
global.S = { me, view: 'home', dmThreadId: 't1', dms: [dm('t1', [me, them], { isGroup: true })] };
check(viewOnceDmPeerId() === '', 'a group chat has no single recipient', { got: viewOnceDmPeerId() });
global.S = { me, view: 'home', dmThreadId: null, dms: [dm('t1', [me, them])] };
check(viewOnceDmPeerId() === '', 'Home with no conversation open');
global.S = { me, view: 'home', dmThreadId: 'gone', dms: [dm('t1', [me, them])] };
check(viewOnceDmPeerId() === '', 'a thread id that is not in S.dms (no crash)');
global.S = { me: null, view: 'home', dmThreadId: 't1', dms: [dm('t1', [me, them])] };
check(viewOnceDmPeerId() === '', 'signed out / no account yet (no crash)');

console.log('\n[3] only a friend can be pre-picked');
const friends = [{ id: 'u2', username: 'ada' }, { id: 7, username: 'grace' }];
check(JSON.stringify(viewOncePrePick('u2', friends)) === '["u2"]', 'a friend peer arrives picked');
check(JSON.stringify(viewOncePrePick(7, friends)) === '[7]', 'id types need not match — the friend\'s own id is used');
const stranger = viewOncePrePick('u9', friends);
check(Array.isArray(stranger) && stranger.length === 0, 'a peer who is not a friend → nothing picked', { got: stranger });
check(viewOncePrePick('', friends).length === 0, 'no peer (channel / group) → nothing picked');
check(viewOncePrePick('u2', undefined).length === 0 && viewOncePrePick('u2', null).length === 0, 'no friends list yet → nothing picked (no crash)');
check(viewOncePrePick('u2', [{ id: 'u55' }]).length === 0, 'an unrelated friends list doesn\'t pick anyone');

console.log('\n[4] the wiring');
check(/\$\('#cm-viewonce'\)\.onclick[\s\S]*?openStoryComposer\(\{\s*viewOnce:\s*true,\s*viewOnceUser:\s*viewOnceDmPeerId\(\)\s*\}\)/.test(src), 'the view-once button passes the open DM\'s peer');
check(/if \(opts\.viewOnce\) \{[\s\S]{0,400}?sc\.voIds = viewOncePrePick\(opts\.viewOnceUser, \(S\.friends && S\.friends\.friends\) \|\| \[\]\);/.test(src), 'the composer applies it to voIds after the friends list loads');
check(!/sc\.voIds = viewOncePrePick/.test(src.slice(0, src.indexOf('if (opts.viewOnce) {'))), 'a plain story composer (no view-once) is never given a pick');
check(/const dmIds = st\.vo \? \(st\.voIds \|\| \[\]\)\.slice\(\)/.test(src), 'the send path reads the same voIds the picker shows');
check(/if \(sc\.vo\) return n \? `Send \(\$\{n\}\)` : 'Send';/.test(src), 'one picked friend reads as "Send (1)"');
check(/\$\('#sc-pick-list \.sc-pick-row\.on'\)/.test(src), 'the pre-picked row is scrolled into view when the picker opens');

// ---------- the real picker menu, in a browser ----------
const menuSrc = slice('function renderStoryAudience() {', '\nfunction storyProgress(pct) {');
const svgSrc = slice('const svSvg = {', '};') + '};';
const countSrc = slice('function storyAudCount() {', 'function renderStoryAudience() {');
const pickMarkup = (/<div class="sc-pick hidden" id="sc-pick">[\s\S]*?<div id="sc-pick-list" class="sc-pick-list"><\/div>/.exec(index) || [''])[0];
const bar2Markup = (/<div class="sc-bar hidden" id="sc-bar2">[\s\S]*?<\/div>/.exec(index) || [''])[0];

function pageHtml(pre) {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css"></head><body>
${pickMarkup}
${bar2Markup}
<script>
window.$ = (s) => document.querySelector(s);
window.paintAvatar = () => {};
window.S = { friends: { friends: [
  { id: 'f1', display_name: 'Ada', username: 'ada' },
  { id: 'f2', display_name: 'Bo', username: 'bo' },
  { id: 'f3', display_name: 'Cy', username: 'cy' }] }, servers: [] };
window.sc = { audFriends: false, audServers: [], audUsers: [], vo: true, voIds: ${JSON.stringify(pre)} };
${svgSrc}
${countSrc}
${menuSrc}
try {
const out = {};
const snap = () => ({
  rows: [...document.querySelectorAll('#sc-pick-list .sc-pick-row')].map((b) => ({
    name: (b.querySelector('.sc-pick-name') || {}).textContent || '',
    on: b.classList.contains('on'),
    pressed: b.getAttribute('aria-pressed'),
  })),
  voIds: window.sc.voIds.slice(),
  count: (document.getElementById('sc-pick-count') || {}).textContent || '',
  label: (document.getElementById('sc-post') || {}).textContent || '',
  disabled: !!(document.getElementById('sc-post') || {}).disabled,
  title: (document.getElementById('sc-pick-title') || {}).textContent || '',
  sections: [...document.querySelectorAll('#sc-pick-list .sc-pick-sec')].map((e) => e.textContent),
  hasCheck: [...document.querySelectorAll('#sc-pick-list .sc-pick-row')].every((b) => !!b.querySelector('.sc-pick-check svg')),
});
renderStoryAudience();          // the composer paints the menu when the step opens
out.picked = snap();
// A second friend is tapped on: the pre-pick must not block a normal toggle.
[...document.querySelectorAll('#sc-pick-list .sc-pick-row')].find((b) => /Ada/.test(b.textContent)).click();
out.added = snap();
document.title = JSON.stringify(out);
} catch (e) { document.title = JSON.stringify({ error: String((e && e.message) || e) }); }
</script></body></html>`;
}

function runChrome(pre) {
  const chrome = findChrome();
  if (!chrome) return { skip: true };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-vo-pick-'));
  try {
    const htmlPath = path.join(dir, 'page.html');
    fs.writeFileSync(htmlPath, pageHtml(pre));
    const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=420,760',
      '--virtual-time-budget=2500', '--dump-dom', 'file:///' + htmlPath.replace(/\\/g, '/')],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
    if (!m) return { error: 'harness produced no title (status ' + r.status + ')' };
    return { out: JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')) };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

if (!findChrome()) {
  console.log('\n[test] SKIP browser half: no Chrome/Edge found (set CHROME_PATH)');
} else {
  console.log('\n[5] the menu itself (headless Chrome)');
  const picked = runChrome(['f2']);
  if (picked.skip) {
    console.log('[test] SKIP: no Chrome');
  } else if (picked.error || !picked.out || picked.out.error) {
    check(false, 'the picker harness ran', picked.error || (picked.out && picked.out.error));
  } else {
    const p = picked.out.picked;
    check(p.rows.map((x) => x.name).join('|') === 'Ada|Bo|Cy', 'the SEND TO list is your friends', p.rows);
    check(p.rows[1].on && p.rows[1].pressed === 'true', 'the DM peer\'s row arrives picked', p.rows);
    check(!p.rows[0].on && !p.rows[2].on && p.voIds.join() === 'f2', 'and only that row', p.voIds);
    check(p.count === '1 selected', 'the count says one is selected', p.count);
    check(p.label === 'Send (1)' && !p.disabled, 'and Send is one tap away', [p.label, p.disabled]);
    check(p.title === 'Who gets this?', 'the menu is headed "Who gets this?"', p.title);
    check(p.sections.join('|') === 'SEND TO', 'view-once mode keeps its own section', p.sections);
    check(p.hasCheck, 'every row keeps its tick');
    const a = picked.out.added;
    check(a.voIds.join() === 'f2,f1' && a.count === '2 selected' && a.label === 'Send (2)', 'tapping a second friend adds them', a.voIds);
  }
  const none = runChrome([]);
  if (!none.skip && !none.error && none.out && !none.out.error) {
    const p = none.out.picked;
    check(!p.rows.some((x) => x.on) && p.count === 'None selected' && p.label === 'Send' && p.disabled, 'a peer who is not a friend leaves the menu honestly empty', p);
  }
}

console.log('\n' + (failures.length ? failures.length + ' FAILED, ' + passed + ' passed' : 'all ' + passed + ' checks passed'));
process.exit(failures.length ? 1 : 0);
