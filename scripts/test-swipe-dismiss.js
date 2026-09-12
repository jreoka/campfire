// Swipe-down-to-dismiss on mobile panels (see AGENTS.md verification conventions).
//
// The ask: on a phone, swiping down on your profile page should drag it down and
// close it (the me-bar card sheet gets the same gesture, since it slides up).
//
// The trap this exists for: the panel's own body is a scroll container, so with
// pointer events the browser treats a downward drag at the top as an overscroll
// pan, cancels the pointer stream (pointercancel) and the gesture never lands —
// exactly what `touch-action: none` had to fix for the story viewer. So the
// helper listens to TOUCH events and preventDefaults the move it owns, and only
// when its scroller is already at the top (normal scrolling still wins below).
//
// A second ask rides here because it is the same gesture family: the members
// drawer comes in from the right edge and must leave the same way
// (`swipeRightToClose`), and a tap outside it must ONLY dismiss it — the tap used
// to reach the chat underneath and activate whatever was under the finger.
//
// Drives the REAL `swipeDownToClose`/`swipeRightToClose` out of final.js (sliced)
// against the real `#profile-backdrop` markup and stylesheet in headless Chrome,
// dispatching real TouchEvents. Skips without Chrome.
//
// Usage: node scripts/test-swipe-dismiss.js
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
const finalSrc = fs.readFileSync(path.join(ROOT, 'public/js/final.js'), 'utf8');
const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const profileMarkup = index.slice(index.indexOf('<div id="profile-backdrop"'), index.indexOf('<!-- settings'));
const helperSrc = finalSrc.slice(finalSrc.indexOf('function swipeDownToClose('), finalSrc.indexOf('// ---------- global closers ----------'));

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>#usercard{position:fixed;left:0;right:0;bottom:0;width:100%;height:100%;background:var(--panel-2);overflow-y:auto}
#usercard.hidden{display:none!important}</style></head><body>
${profileMarkup}
<div id="usercard" class="sheet hidden"></div>
<!-- The members drawer (a right-hand drawer on a phone) plus the chat it covers:
     the tap that dismisses the drawer must not reach the chat underneath. -->
<header id="chat-header"><button type="button" id="btn-members" class="icon-btn">Members</button></header>
<aside id="members"><div id="member-list"><button type="button" class="member" id="m-row">Jordan</button></div></aside>
<div id="chat-pane"><button type="button" id="msg-under">message under the drawer</button></div>
<script>
window.$ = (s) => document.querySelector(s);
window.__calls = [];
window.closeProfileScreen = () => { __calls.push('closeProfile'); document.getElementById('profile-backdrop').classList.add('hidden'); };
window.closeUserCard = () => {
  __calls.push('closeCard');
  const c = document.getElementById('usercard');
  c.classList.add('hidden'); c.classList.remove('sheet');
  c.style.transform = ''; c.style.transition = ''; c.style.animation = '';
};
${helperSrc}
// A drag handler elsewhere on the page: a swallowed click must not reach it.
document.body.addEventListener('click', () => __calls.push('bogus-click'));
// The chat control under the drawer, and the drawer's own row.
document.getElementById('msg-under').addEventListener('click', () => __calls.push('chat-click'));
document.getElementById('m-row').addEventListener('click', () => __calls.push('row-click'));
const out = {};
const panel = document.querySelector('#profile-backdrop .profile');
const body = document.getElementById('pf-body');
const card = document.getElementById('usercard');
document.getElementById('profile-backdrop').classList.remove('hidden');
card.classList.remove('hidden');
card.classList.add('sheet');
// Give the profile body something to scroll so scrollTop can be non-zero. It
// needs flex:none — a plain tall child of the column flex body just shrinks.
body.innerHTML = '<div style="height:4000px;flex:0 0 auto">long profile</div>';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (el, type, x, y) => {
  const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y });
  return el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], targetTouches: type === 'touchend' ? [] : [t], changedTouches: [t] }));
};
const reset = () => { window.__calls.length = 0; panel.style.transform = ''; panel.style.transition = ''; card.style.transform = ''; card.style.transition = ''; };
// A previous subtest closed the profile page; show it again (its box is
// display:none otherwise, so scrollTop is ignored and geometry reads 0).
const reopen = () => { document.getElementById('profile-backdrop').classList.remove('hidden'); reset(); panel.style.animation = ''; };
// A deliberate drag, spaced out so it is a drag and not a tap. Returns whether
// the move was preventDefaulted (dispatchEvent returns false when it was).
const drag = async (el, x0, y0, x1, y1, steps = 3, gap = 40) => {
  ev(el, 'touchstart', x0, y0);
  let prevented = false;
  for (let i = 1; i <= steps; i++) {
    await sleep(gap);
    if (ev(el, 'touchmove', x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps) === false) prevented = true;
  }
  await sleep(gap);
  ev(el, 'touchend', x1, y1);
  return prevented;
};
const tap = (el, x, y) => { ev(el, 'touchstart', x, y); ev(el, 'touchend', x, y); };

(async () => {
  out.profilePos = getComputedStyle(panel).position;

  // [1] a swipe down on the profile page closes it
  reset();
  out.prevented = await drag(body, 200, 200, 205, 330);
  out.profileCalls = window.__calls.slice();
  out.profileCleared = panel.style.transform === '';

  // mid-drag feedback + the whole panel follows
  reopen();
  ev(body, 'touchstart', 200, 200);
  await sleep(20);
  ev(body, 'touchmove', 200, 300);
  out.midTransform = panel.style.transform;
  out.midAnimationName = getComputedStyle(panel).animationName;
  ev(body, 'touchend', 200, 200);
  out.midCleared = panel.style.transform === '';

  // [2] a short drag springs back and does not close
  reopen();
  await drag(body, 200, 200, 205, 230);
  out.shortCalls = window.__calls.slice();
  out.shortCleared = panel.style.transform === '';

  // [3] a drag that starts below the top belongs to the scroller
  reopen();
  body.scrollTop = 300;
  out.scrollTopSet = body.scrollTop;
  out.scrollable = { sh: body.scrollHeight, ch: body.clientHeight };
  out.preventedWhenScrolled = await drag(body, 200, 200, 205, 330);
  out.scrolledCalls = window.__calls.slice();
  body.scrollTop = 0;

  // [4] an upward drag is the scroller's too
  reopen();
  out.preventedUp = await drag(body, 200, 400, 205, 260);
  out.upCalls = window.__calls.slice();

  // [5] the click a drag produces is swallowed (no row fires underneath)
  reopen();
  await drag(body, 200, 200, 205, 330);
  document.querySelector('#profile-backdrop .profile').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  out.swallowed = window.__calls.slice();
  await sleep(500);
  document.querySelector('#profile-backdrop .profile').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  out.lateClick = window.__calls.slice();

  // [6] the me-bar card sheet gets the same gesture, and only as a sheet
  document.getElementById('profile-backdrop').classList.add('hidden');
  reset();
  await drag(card, 200, 200, 205, 330);
  out.cardCalls = window.__calls.slice();
  reset();
  card.classList.remove('sheet');
  await drag(card, 200, 200, 205, 330);
  out.noSheetCalls = window.__calls.slice();

  // [7] the members drawer swipes away to the right
  const drawer = document.getElementById('members');
  const rowBox = document.getElementById('member-list');
  const openDrawer = () => { document.body.classList.add('members-open'); window.__calls.length = 0; drawer.style.transform = ''; drawer.style.transition = ''; };
  const drawerStyles = () => ({ pos: getComputedStyle(drawer).position, tr: getComputedStyle(drawer).transform });
  openDrawer();
  out.drawerStyle = drawerStyles();
  ev(rowBox, 'touchstart', 300, 400);
  await sleep(20);
  ev(rowBox, 'touchmove', 360, 402);
  out.drawerMidTransform = drawer.style.transform;
  out.drawerMidTransition = drawer.style.transition;
  ev(rowBox, 'touchend', 360, 402);
  await sleep(20);
  out.drawerOpenAfterMid = document.body.classList.contains('members-open');
  out.drawerClearedAfterMid = drawer.style.transform === '';
  openDrawer();
  out.drawerPrevented = await drag(rowBox, 300, 400, 420, 402);
  out.drawerClosed = !document.body.classList.contains('members-open');
  out.drawerCalls = window.__calls.slice();
  // a short drag springs back and stays open
  await sleep(450);
  openDrawer();
  await drag(rowBox, 300, 400, 340, 402);
  out.drawerShortOpen = document.body.classList.contains('members-open');
  out.drawerShortCleared = drawer.style.transform === '';
  // a vertical drag belongs to the list, and a leftward one is nobody's
  await sleep(450);
  openDrawer();
  out.drawerDownPrevented = await drag(rowBox, 300, 400, 302, 520);
  out.drawerDownOpen = document.body.classList.contains('members-open');
  openDrawer();
  out.drawerLeftPrevented = await drag(rowBox, 420, 400, 300, 402);

  // [8] a tap outside the drawer dismisses it and nothing else
  await sleep(500); // clear the drag's shared swallow window
  openDrawer();
  document.getElementById('msg-under').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  out.tapClosed = !document.body.classList.contains('members-open');
  out.tapCalls = window.__calls.slice();
  // a tap INSIDE the drawer is the drawer's (it keeps it open and runs the row)
  await sleep(500);
  openDrawer();
  document.getElementById('m-row').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  out.rowTapOpen = document.body.classList.contains('members-open');
  out.rowTapCalls = window.__calls.slice();
  // the header is exempt — ☰ and the members button are deliberate destinations
  await sleep(500);
  openDrawer();
  document.getElementById('btn-members').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  out.headerTapOpen = document.body.classList.contains('members-open');
  out.headerTapCalls = window.__calls.slice();
  document.body.classList.remove('members-open');

  document.title = JSON.stringify(out);
})();
</script></body></html>`;
}

function main() {
  console.log('\n[1] the wiring is there');
  check(/function swipeDownToClose\(panel, onClose, opts = \{\}\)/.test(finalSrc), 'the helper exists');
  check(/function swipeRightToClose\(panel, onClose, opts = \{\}\)/.test(finalSrc), 'the right-swipe twin exists');
  check(finalSrc.includes("panel.addEventListener('touchmove'") && finalSrc.includes('{ passive: false }'), 'it owns a non-passive touchmove (pointer events lose this to the scroller)');
  check(finalSrc.includes("swipeDownToClose($('#profile-backdrop .profile'), () => closeProfileScreen()"), 'the profile page is wired');
  check(finalSrc.includes("swipeDownToClose($('#usercard'), () => closeUserCard(), { enabled: () => $('#usercard').classList.contains('sheet') })"), 'the me-bar sheet is wired, and only as a sheet');
  check(finalSrc.includes("swipeRightToClose($('#members'), () => document.body.classList.remove('members-open')"), 'the members drawer swipes away to the right');
  check(/document\.addEventListener\('click', \(e\) => \{\s*if \(!document\.body\.classList\.contains\('members-open'\)\) return;[\s\S]{0,420}e\.stopPropagation\(\);\s*e\.preventDefault\(\);/.test(finalSrc),
    'a tap outside the open drawer is swallowed in the capture phase (it used to click through)');
  check(/function closeProfileScreen\(\) \{[\s\S]{0,240}p\.style\.animation = ''/.test(pickers), 'closeProfileScreen clears the drag overrides');
  check(/function closeUserCard\(\) \{[\s\S]{0,240}c\.style\.animation = ''/.test(pickers), 'closeUserCard clears the drag overrides');
  check(/\.pf-body\{[^}]*overscroll-behavior:contain/.test(css), 'the profile body contains its overscroll (.css)');

  const chrome = findChrome();
  if (!chrome) return skip('no Chrome/Edge found — set CHROME_PATH');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-dismiss-'));
  try {
    const htmlPath = path.join(dir, 'page.html');
    fs.writeFileSync(htmlPath, pageHtml());
    const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=500,900',
      '--virtual-time-budget=8000', '--dump-dom', 'file:///' + htmlPath.replace(/\\/g, '/')],
      { encoding: 'utf8', timeout: 90000, maxBuffer: 16 * 1024 * 1024 });
    const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
    if (!m) return check(false, 'the dismiss harness ran', { status: r.status, err: (r.stderr || '').slice(-400) });
    const out = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    console.log('\n[2] the profile page swipes down and closes');
    check(out.prevented === true, 'the drag is taken from the browser (touchmove preventDefault)');
    check(out.profileCalls && out.profileCalls.join() === 'closeProfile', 'and the panel closes', out.profileCalls);
    check(out.profileCleared === true, 'the offset is cleared');
    check(out.midTransform === 'translateY(55px)', 'the panel follows the finger while dragging', out.midTransform);
    check(out.midAnimationName === 'none', 'and the entry animation is taken over', out.midAnimationName);
    check(out.midCleared === true, 'releasing early restores it');
    console.log('\n[3] the scroller keeps its own gestures');
    check(out.shortCalls && out.shortCalls.length === 0, 'a short drag springs back without closing', out.shortCalls);
    check(out.shortCleared === true, 'and clears the offset');
    check(out.preventedWhenScrolled === false && out.scrolledCalls.length === 0, 'a drag below the top is left to the scroller', { prevented: out.preventedWhenScrolled, calls: out.scrolledCalls, scrollTop: out.scrollTopSet, scrollable: out.scrollable });
    check(out.preventedUp === false && out.upCalls.length === 0, 'so is an upward drag', { prevented: out.preventedUp, calls: out.upCalls });
    console.log('\n[4] a drag never presses what was under the finger');
    check(out.swallowed && out.swallowed.join() === 'closeProfile', 'the synthetic click after the drag is swallowed', out.swallowed);
    check(out.lateClick && out.lateClick.includes('bogus-click'), 'a later ordinary click still gets through', out.lateClick);
    console.log('\n[5] the me-bar card sheet');
    check(out.cardCalls && out.cardCalls.join() === 'closeCard', 'swiping the sheet down closes it', out.cardCalls);
    check(out.noSheetCalls && out.noSheetCalls.length === 0, 'the popup card (not a sheet) is left alone', out.noSheetCalls);
    console.log('\n[6] the members drawer swipes away to the right');
    check(out.drawerStyle && out.drawerStyle.pos === 'fixed', 'the drawer is the phone overlay (.css)', out.drawerStyle);
    check(out.drawerMidTransform === 'translateX(60px)', 'it follows the finger while dragging', out.drawerMidTransform);
    check(out.drawerMidTransition === 'none', 'and the CSS transition is out of the way mid-drag', out.drawerMidTransition);
    check(out.drawerOpenAfterMid === true && out.drawerClearedAfterMid === true, 'releasing early leaves it open and clears the offset', out);
    check(out.drawerPrevented === true, 'a rightward drag is taken from the browser (touchmove preventDefault)');
    check(out.drawerClosed === true, 'and past the threshold the drawer closes', out.drawerCalls);
    check(out.drawerShortOpen === true && out.drawerShortCleared === true, 'a short drag springs back without closing', out);
    check(out.drawerDownPrevented === false && out.drawerDownOpen === true, 'a vertical drag is left to the list', { prevented: out.drawerDownPrevented, open: out.drawerDownOpen });
    check(out.drawerLeftPrevented === false, 'so is a leftward one', out.drawerLeftPrevented);
    console.log('\n[7] a tap outside the open drawer only dismisses it');
    check(out.tapClosed === true, 'the tap closes the drawer', out.tapCalls);
    check(out.tapCalls && out.tapCalls.length === 0,
      'and the chat underneath never sees it (no click-through)', out.tapCalls);
    check(out.rowTapOpen === true && out.rowTapCalls && out.rowTapCalls.join() === 'row-click,bogus-click',
      'a tap inside the drawer is still the drawer\'s, and it stays open', out.rowTapCalls);
    check(out.headerTapOpen === true && out.headerTapCalls && out.headerTapCalls.includes('bogus-click'),
      'a header control (the members button) is exempt from the swallow', out.headerTapCalls);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
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
