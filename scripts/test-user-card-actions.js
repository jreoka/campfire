// User-card actions, the me-bar tag, and the avatar-as-story-button (see
// AGENTS.md verification conventions).
//
// Three owner asks in one surface:
//   1. the me bar should not show your own active server tag any more,
//   2. on someone's card the profile picture IS the story affordance — clicking
//      it opens their story, and the separate "Watch story" button is gone,
//   3. the card's action buttons (Mention / Message / friend / Kick / Ban /
//      Block / Profile / Close) are a vertical tab list, not a wrapped row of
//      pills.
//
// Offline sections run the real `ucTabHTML`/`ucIconHTML` (pickers.js) and
// `friendBtnHTML` (home.js) against stubs. The last section drives the REAL
// `paintMe` (servers.js) and `paintUserCardStory` (stories.js) in headless
// Chrome: a tag-returning `tagHTML` proves the me bar drops it, and real clicks
// / keydowns prove the avatar opens the story. Skips without Chrome.
//
// Usage: node scripts/test-user-card-actions.js
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
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
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

const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
const home = fs.readFileSync(path.join(ROOT, 'public/js/home.js'), 'utf8');
const servers = fs.readFileSync(path.join(ROOT, 'public/js/servers.js'), 'utf8');
const stories = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

// ---------- the real tab builders ----------
const tabCode = slice(pickers, 'const UC_ICONS = {', '// ---------- user card ----------');
const { ucTabHTML, ucIconHTML, UC_ICONS } = eval(tabCode + '\n;({ ucTabHTML, ucIconHTML, UC_ICONS })');

// ---------- the real friend button, in both shapes ----------
const friendCode = slice(home, 'const FRIEND_TAB_ICONS = {', 'async function friendCardAction(');
let lastIcon = null;
const friendEval = 'const friendState = (uid) => globalThis.__friendState;'
  + '\nconst ucIconHTML = (n) => { globalThis.__lastIcon = n; return "<svg data-i=\\"" + n + "\\"></svg>"; };'
  + '\n' + friendCode + '\n;({ friendBtnHTML })';
const { friendBtnHTML } = eval(friendEval);
const btn = (state, ...args) => { globalThis.__friendState = state; globalThis.__lastIcon = null; return friendBtnHTML('friend-id', ...args); };

function cardPageHtml() {
  const meSrc = slice(servers, 'function paintSidebarBanner(', 'function mentionsMe(');
  const storySrc = slice(stories, 'function paintUserCardStory(', '// Same affordance inside the full profile screen.');
  const avatar = '<span class="avatar big"></span>';
  const card = (id) => `<div id="${id}" data-uid="${id}"><div class="uc-body"><div class="uc-head">${avatar}</div></div></div>`;
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css"></head><body>
<div id="me-card">
  <button type="button" id="me-open">
    <span id="me-avwrap" class="avwrap st-online"><span id="me-avatar" class="avatar">?</span><span id="me-dot" class="status-dot online"></span></span>
    <span class="mnames"><span class="mname-row"><span id="me-name">—</span><span id="me-game-badge" class="gbadge" style="display:none"></span></span><span id="me-sub" class="mstatus" style="display:none"></span></span>
  </button>
</div>
${card('card1')}${card('card2')}${card('card3')}${card('card4')}
<div id="minecard" data-uid="me"><div class="uc-body"><div class="uc-head">${avatar}</div></div></div>
<div id="tabhost" class="uc-tabs"><button type="button" class="uc-tab" id="uc-mention">${ucIconHTML('mention')}<span>Mention</span></button><button type="button" class="uc-tab danger" id="uc-kick">${ucIconHTML('minus-user')}<span>Kick</span></button></div>
<script>
window.S = { view: 'home', me: { id: 'me', username: 'jordan', display_name: 'Jordan', status: 'online', active_tag: 'CF', active_tag_server_id: 's1', avatar_color: '#5865f2' } };
window.$ = (s) => document.querySelector(s);
window.paintAvatar = () => {};
window.isOff = (st) => st === 'offline' || st === 'invisible';
window.dotOf = (st) => st;
window.nameStyleFor = () => '';
window.paintGameBadge = () => {};
// A tag-returning tagHTML: if paintMe ever inserts one into the me row again,
// the harness sees it.
window.tagHTML = (u) => (u && u.active_tag ? '<span class="usertag">' + u.active_tag + '</span>' : '');
${meSrc}
${storySrc}
const out = {};
// [1] the me bar
paintMe();
const meRow = document.getElementById('me-name').parentElement;
out.meName = document.getElementById('me-name').textContent;
out.meTags = meRow.querySelectorAll('.usertag').length;
out.meRowHTML = meRow.outerHTML;
// [2] the avatar is the story button
let opened = null, closed = 0;
window.openStoryViewer = (o) => { opened = o; };
window.closeUserCard = () => { closed++; };
window.__tray = { items: [{ id: 's1', kind: 'image', url: 'x', seen: false, expires_at: Date.now() + 3600e3 }] };
window.storyTrayFor = () => window.__tray;
window.storyLive = (items) => items;
window.storyThumbItem = (items) => items[0];
window.storyThumbEl = () => { const e = document.createElement('span'); e.className = 'st-thumb-inline'; return e; };
const card1 = document.getElementById('card1');
paintUserCardStory(card1, { id: 'friend', display_name: 'Sam' });
const av = card1.querySelector('.uc-head .avatar');
out.avRole = av.getAttribute('role');
out.avTab = av.getAttribute('tabindex');
out.avClickable = av.classList.contains('st-click');
out.avLabel = av.getAttribute('aria-label');
out.thumbInAvatar = !!av.querySelector('.st-thumb-inline');
out.storyButtonLeft = card1.querySelectorAll('#uc-story').length;
av.click();
out.opened = opened;
out.closed = closed;
// keyboard parity
opened = null; closed = 0;
av.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
out.kbOpened = opened;
out.kbClosed = closed;
// a seen story still opens (different label)
window.__tray = { items: [{ id: 's2', kind: 'image', url: 'x', seen: true, expires_at: Date.now() + 3600e3 }] };
paintUserCardStory(document.getElementById('card2'), { id: 'friend', display_name: 'Sam' });
const av2 = document.querySelector('#card2 .uc-head .avatar');
out.seenLabel = av2.getAttribute('aria-label');
out.seenRole = av2.getAttribute('role');
// no live items → not a button
window.__tray = null;
paintUserCardStory(document.getElementById('card3'), { id: 'friend', display_name: 'Sam' });
out.emptyClickable = document.querySelector('#card3 .uc-head .avatar').classList.contains('st-click');
// my own card → not a button
window.__tray = { items: [{ id: 's3', kind: 'image', url: 'x', seen: false, expires_at: Date.now() + 3600e3 }] };
paintUserCardStory(document.getElementById('minecard'), window.S.me);
const myAv = document.querySelector('#minecard .uc-head .avatar');
out.mineClickable = myAv.classList.contains('st-click');
out.mineHandler = typeof myAv.onclick;
// [3] the tabs are real vertical rows
const host = document.getElementById('tabhost');
out.tabDirection = getComputedStyle(host).flexDirection;
const mentionTab = document.getElementById('uc-mention');
const hostW = host.getBoundingClientRect().width;
const tabW = mentionTab.getBoundingClientRect().width;
out.hostW = hostW;
out.tabW = tabW;
out.tabIcon = !!mentionTab.querySelector('svg');
out.kickDanger = getComputedStyle(document.getElementById('uc-kick')).color !== getComputedStyle(mentionTab).color;
document.title = JSON.stringify(out);
</script></body></html>`;
}

function main() {
  console.log('\n[1] the action tabs render as icon + label rows');
  const mention = ucTabHTML('uc-mention', 'mention', 'Mention');
  check(mention.includes('class="uc-tab"') && mention.includes('id="uc-mention"'), 'a plain tab row', mention);
  check(/<svg[\s\S]*<\/svg><span>Mention<\/span>/.test(mention), 'an inline SVG then the label', mention);
  check(mention.includes('aria-hidden="true"'), 'the icon is decorative to a screen reader');
  check(ucTabHTML('uc-message', 'message', 'Message', ' primary').includes('class="uc-tab primary"'), 'the primary variant (Message)');
  check(ucTabHTML('uc-ban', 'x-user', 'Ban', ' danger').includes('class="uc-tab danger"'), 'the danger variant (Ban)');
  for (const name of ['mention', 'message', 'plus', 'x-user', 'check-user', 'minus-user', 'slash', 'check', 'user', 'close']) {
    check(!!UC_ICONS[name], 'icon ' + name + ' exists');
  }
  check(ucIconHTML('nope') === '', 'an unknown icon renders nothing, never "undefined"');

  console.log('\n[2] the card uses them (and keeps no pills)');
  check(/class="uc-tabs">/.test(pickers), 'the card action list is a .uc-tabs container');
  for (const id of ['uc-mention', 'uc-message', 'uc-kick', 'uc-ban', 'uc-remove', 'uc-block', 'uc-profile', 'uc-close']) {
    check(new RegExp("ucTabHTML\\('" + id + "'").test(pickers), id + ' is built as a tab row');
  }
  check(!/class="btn small" id="uc-mention"/.test(pickers) && !/class="btn small" id="uc-close"/.test(pickers), 'no .btn small pills left in the card actions');
  // The voice-call controls stay a compact pill row (different job).
  check(/class="uc-actions" style="margin-top:0"/.test(pickers), 'the voice call controls keep their own pill row');
  check(/\.uc-tabs\{[^}]*flex-direction:column/.test(css), 'the container stacks its rows (.css)');
  check(/\.uc-tab\{[^}]*width:100%/.test(css), 'each row fills the width (.css)');
  check(/\.uc-tab\.danger\{[^}]*--danger-tx/.test(css), 'danger rows are tinted (.css)');
  check(/\.uc-tab\.primary\{[^}]*--accent-container/.test(css), 'the primary row is tinted (.css)');
  check(/\.avatar\.st-click\{[^}]*cursor:pointer/.test(css), 'the story avatar reads as clickable (.css)');

  console.log('\n[3] the friend button has a tab shape');
  let b = btn('friend', 'uc-friend', 'uc-tab', true);
  check(b.includes('class="uc-tab danger"') && /<span>Unfriend<\/span>/.test(b), 'a friend → a danger tab', b);
  check(globalThis.__lastIcon === 'minus-user', 'with the user-minus icon', globalThis.__lastIcon);
  b = btn('pending-out', 'uc-friend', 'uc-tab', true);
  check(b.includes('class="uc-tab"') && /Cancel request/.test(b) && globalThis.__lastIcon === 'x-user', 'pending-out → x-user');
  b = btn('pending-in', 'uc-friend', 'uc-tab', true);
  check(b.includes('class="uc-tab primary"') && /Accept request/.test(b) && globalThis.__lastIcon === 'check-user', 'pending-in → primary + check-user');
  b = btn('none', 'uc-friend', 'uc-tab', true);
  check(b.includes('class="uc-tab"') && /Add friend/.test(b) && globalThis.__lastIcon === 'plus', 'none → plus');
  check(b.includes('data-friend-state="none"'), 'the state rides along as data for tests/restyles', b);
  b = btn('friend'); // the profile screen's default shape
  check(b.includes('class="btn small danger"') && !b.includes('<svg'), 'the profile screen keeps its plain pill (no icon)');
  check(pickers.includes("friendBtnHTML(uid, 'uc-friend', 'uc-tab', true)"), 'the card asks for the tab shape');

  console.log('\n[4] the me bar drops your own tag, and the pfp is the story button');
  check(!/tagHTML\(S\.me\)/.test(slice(servers, 'function paintMe() {', 'function mentionsMe(')), 'paintMe no longer inserts a tag');
  check(!stories.includes('uc-story'), 'the "Watch story" button is gone from the card');
  check(stories.includes("card.querySelector('.uc-head .avatar')"), 'the card avatar is the story anchor');
  const chrome = findChrome();
  if (!chrome) { console.log('  (skipped: no Chrome/Edge found — set CHROME_PATH)'); }
  else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-card-'));
    try {
      const htmlPath = path.join(dir, 'page.html');
      fs.writeFileSync(htmlPath, cardPageHtml());
      const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
        '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=520,720',
        '--virtual-time-budget=3000', '--dump-dom', 'file:///' + htmlPath.replace(/\\/g, '/')],
        { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
      if (!m) check(false, 'the card harness ran', { status: r.status });
      else {
        const out = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
        check(out.meName === 'Jordan' && out.meTags === 0, 'the me bar shows the name and no server tag', { name: out.meName, tags: out.meTags, html: out.meRowHTML });
        check(out.avRole === 'button' && out.avTab === '0' && out.avClickable === true, 'the story avatar is a real button', { role: out.avRole, tab: out.avTab, cls: out.avClickable });
        check(out.thumbInAvatar === true, 'and still shows the cropped story thumb');
        check(out.avLabel === 'Watch story', 'labelled for screen readers', out.avLabel);
        check(out.storyButtonLeft === 0, 'no leftover Watch story button');
        check(out.opened && out.opened.kind === 'user' && out.opened.userId === 'friend' && out.closed === 1, 'clicking the pfp opens their story and closes the card', { opened: out.opened, closed: out.closed });
        check(out.kbOpened && out.kbOpened.userId === 'friend' && out.kbClosed === 1, 'Enter does the same (keyboard parity)', { opened: out.kbOpened, closed: out.kbClosed });
        check(out.seenLabel === 'Watch story (seen)' && out.seenRole === 'button', 'a seen story still opens, labelled seen', out.seenLabel);
        check(out.emptyClickable === false, 'no live story → the pfp stays a plain picture');
        check(out.mineClickable === false && out.mineHandler !== 'function', 'my own card never becomes a story button', { clickable: out.mineClickable, handler: out.mineHandler });
        check(out.tabDirection === 'column', 'the action tabs really are vertical', out.tabDirection);
        check(out.tabW > 0 && out.hostW > 0 && out.tabW > out.hostW - 12 && out.tabW <= out.hostW, 'and each row spans the card', { tabW: out.tabW, hostW: out.hostW });
        check(out.tabIcon === true, 'with its icon');
        check(out.kickDanger === true, 'danger rows read differently from plain ones');
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
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
