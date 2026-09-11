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
// Drives the REAL `swipeDownToClose` out of final.js (sliced) against the real
// `#profile-backdrop` markup and stylesheet in headless Chrome, dispatching real
// TouchEvents. Skips without Chrome.
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

  document.title = JSON.stringify(out);
})();
</script></body></html>`;
}

function main() {
  console.log('\n[1] the wiring is there');
  check(/function swipeDownToClose\(panel, onClose, opts = \{\}\)/.test(finalSrc), 'the helper exists');
  check(finalSrc.includes("panel.addEventListener('touchmove'") && finalSrc.includes('{ passive: false }'), 'it owns a non-passive touchmove (pointer events lose this to the scroller)');
  check(finalSrc.includes("swipeDownToClose($('#profile-backdrop .profile'), () => closeProfileScreen()"), 'the profile page is wired');
  check(finalSrc.includes("swipeDownToClose($('#usercard'), () => closeUserCard(), { enabled: () => $('#usercard').classList.contains('sheet') })"), 'the me-bar sheet is wired, and only as a sheet');
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
