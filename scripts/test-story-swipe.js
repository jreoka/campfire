// Swipe-down closes the story viewer (mobile), see AGENTS.md verification
// conventions.
//
// The complaint: on a phone a downward swipe in story view did nothing. Two
// causes, both here:
//   - `.sv-stage` carried `touch-action: pan-y`, so the browser claimed the
//     vertical drag for panning, cancelled the pointer stream (pointercancel)
//     and the stage's pointerup never saw the move;
//   - the tap zones cover the whole stage and fired next/prev on any pointerup,
//     so even when the swipe landed it advanced the story on the way out.
// The follow-up: the drag has to move the WHOLE overlay (progress bars, header
// with ✕/sound/more, footer), not just the media, and then carry on off the
// bottom of the screen instead of snapping away.
//
// This drives the REAL tap-zone + swipe wiring out of stories.js (sliced, since
// there is no bundler) against the real `#story-view` markup and the real
// stylesheet in headless Chrome, dispatching real PointerEvents at a phone
// viewport. Drags are spaced out in time so the flick-velocity test is honest.
// Skips without Chrome.
//
// Usage: node scripts/test-story-swipe.js
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
const stories = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const viewerMarkup = index.slice(index.indexOf('<div id="story-view"'), index.indexOf('<!-- stories: composer'));
const gestureStart = stories.indexOf('// Tap zones with press-and-hold to pause');
const gestureSrc = stories.slice(gestureStart, stories.indexOf("document.addEventListener('keydown'", gestureStart));

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css"></head><body>
${viewerMarkup}
<script>
window.$ = (s) => document.querySelector(s);
window.sv = {};              // a viewer is open
window.__calls = [];
window.svPause = () => __calls.push('pause');
window.svResume = () => __calls.push('resume');
window.svNext = () => __calls.push('next');
window.svPrev = () => __calls.push('prev');
window.svClose = () => __calls.push('close');
${gestureSrc}
const out = {};
const root = document.getElementById('story-view');
// The real viewer removes this when it opens.
root.classList.remove('hidden');
document.body.classList.add('story-open');
const stage = document.getElementById('sv-stage');
const next = document.getElementById('sv-next');
const prev = document.getElementById('sv-prev');
const closeBtn = document.getElementById('sv-close');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerType: 'touch', isPrimary: true, pointerId: 1 }));
const reset = () => { window.__calls.length = 0; root.style.transform = ''; root.style.transition = ''; };
// A deliberate drag, spaced over ~4 steps so velocity stays human.
const swipe = async (el, x0, y0, x1, y1, steps = 3, gap = 60) => {
  ev(el, 'pointerdown', x0, y0);
  for (let i = 1; i <= steps; i++) { await sleep(gap); ev(el, 'pointermove', x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps); }
  await sleep(gap); ev(el, 'pointerup', x1, y1);
};
const flick = (el, x0, y0, x1, y1) => { ev(el, 'pointerdown', x0, y0); ev(el, 'pointermove', x1, y1); ev(el, 'pointerup', x1, y1); };
const tap = (el, x, y) => { ev(el, 'pointerdown', x, y); ev(el, 'pointerup', x, y); };

(async () => {
  out.touchAction = getComputedStyle(stage).touchAction;

  // A deliberate swipe down starting on the (stage-covering) next zone: the whole
  // overlay keeps going off the bottom, then the viewer closes.
  reset(); await swipe(next, 200, 200, 210, 330);
  out.closeAnim = root.style.transform;
  await sleep(320);
  out.swipeOnNext = window.__calls.slice();

  reset(); await swipe(prev, 200, 200, 205, 330); await sleep(320);
  out.swipeOnPrev = window.__calls.slice();

  reset(); await swipe(document.getElementById('sv-img'), 200, 200, 200, 330); await sleep(320);
  out.swipeOnImg = window.__calls.slice();

  // Mid-drag: the WHOLE view travels — the ✕ in the header moves by the same
  // amount as the finger, so bars/header/footer all go together.
  reset();
  const baseY = Math.round(closeBtn.getBoundingClientRect().y);
  ev(stage, 'pointerdown', 200, 200); ev(stage, 'pointermove', 200, 300);
  out.dragTransform = root.style.transform;
  out.headerDelta = Math.round(closeBtn.getBoundingClientRect().y) - baseY;
  ev(stage, 'pointerup', 200, 200);
  out.dragCleared = root.style.transform === '';

  // A quick short flick still dismisses.
  reset(); flick(stage, 200, 200, 202, 275);
  out.flickAnim = root.style.transform;
  await sleep(320);
  out.flick = window.__calls.slice();

  // Too short and slow: springs back, no close.
  reset(); await swipe(stage, 200, 200, 205, 240);
  out.shortDrag = window.__calls.slice();
  out.shortCleared = root.style.transform === '';

  // Sideways: not a close, and the zone guard keeps it from stepping either.
  reset(); await swipe(next, 120, 300, 320, 310);
  out.horizontal = window.__calls.slice();

  // Plain taps still step.
  reset(); tap(next, 300, 300);
  out.tapNext = window.__calls.slice();
  reset(); tap(prev, 60, 300);
  out.tapPrev = window.__calls.slice();

  // Press-and-hold pauses, and releasing without moving does not step.
  reset(); ev(next, 'pointerdown', 300, 300);
  await sleep(260);
  out.holdSoFar = window.__calls.slice();
  ev(next, 'pointerup', 300, 300);
  out.holdThenRelease = window.__calls.slice();

  // A quick flick must not leave the story paused.
  reset(); ev(next, 'pointerdown', 300, 300); ev(next, 'pointermove', 300, 340); await sleep(260);
  out.flickNoPause = window.__calls.slice();
  ev(next, 'pointerup', 300, 340);
  out.flickRelease = window.__calls.slice();

  document.title = JSON.stringify(out);
})();
</script></body></html>`;
}

function main() {
  console.log('\n[1] the wiring is there');
  check(/\.sv-stage\{[^}]*touch-action:none/.test(css), 'the stage refuses browser panning (.sv-stage touch-action:none)');
  check(!/\.sv-stage\{[^}]*touch-action:pan-y/.test(css), 'pan-y is gone (that is what cancelled the swipe)');
  check(stories.includes('const dragged = Math.hypot('), 'a zone press that moved is not a tap');
  check(stories.includes('if (dragged) return;'), 'so a drag never steps the story');
  check(/const root = \$\('#story-view'\);[\s\S]{0,400}stage\.addEventListener\('pointerdown'/.test(gestureSrc), 'the drag drives the whole overlay, not the stage');
  check(gestureSrc.includes("root.style.transform = 'translateY(' + Math.round(dy)"), 'and follows the finger 1:1');
  check(gestureSrc.includes("root.style.transform = 'translateY(100%)'"), 'then carries on off the bottom of the screen');
  check(stories.includes("root.style.transform = '';\n  root.style.transition = '';") || /root\.style\.transform = '';[\s\S]{0,60}root\.style\.transition = '';/.test(stories), 'and teardown resets the overlay offset');
  check(gestureSrc.length > 500 && gestureSrc.length < 5000, 'the gesture block slices cleanly', gestureSrc.length);

  const chrome = findChrome();
  if (!chrome) return skip('no Chrome/Edge found — set CHROME_PATH');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-swipe-'));
  try {
    const htmlPath = path.join(dir, 'page.html');
    fs.writeFileSync(htmlPath, pageHtml());
    const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=390,780',
      '--virtual-time-budget=8000', '--dump-dom', 'file:///' + htmlPath.replace(/\\/g, '/')],
      { encoding: 'utf8', timeout: 90000, maxBuffer: 16 * 1024 * 1024 });
    const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
    if (!m) return check(false, 'the swipe harness ran', { status: r.status, err: (r.stderr || '').slice(-400) });
    const out = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    console.log('\n[2] swiping down takes the whole window with it');
    check(out.touchAction === 'none', 'the stage really computes touch-action:none', out.touchAction);
    check(out.swipeOnNext && out.swipeOnNext.join() === 'close', 'a swipe down on the right zone closes (and does not advance)', out.swipeOnNext);
    check(out.swipeOnPrev && out.swipeOnPrev.join() === 'close', 'and the same from the left zone', out.swipeOnPrev);
    check(out.swipeOnImg && out.swipeOnImg.join() === 'close', 'and straight off the picture', out.swipeOnImg);
    check(out.closeAnim === 'translateY(100%)', 'the overlay is sent all the way off the bottom before it closes', out.closeAnim);
    check(out.dragTransform === 'translateY(100px)', 'mid-drag the overlay tracks the finger 1:1', out.dragTransform);
    check(Math.abs(out.headerDelta - 100) <= 3, 'and the header (the ✕) travels with it — bars, head and foot together', out.headerDelta);
    check(out.dragCleared === true, 'the offset is cleared on release');
    check(out.flickAnim === 'translateY(100%)' && out.flick.join() === 'close', 'a quick short flick dismisses too', { anim: out.flickAnim, calls: out.flick });
    console.log('\n[3] taps and short/horizontal drags still behave');
    check(out.shortDrag && out.shortDrag.length === 0, 'a slow short drag neither closes nor steps', out.shortDrag);
    check(out.shortCleared === true, 'and springs back');
    check(out.horizontal && out.horizontal.length === 0, 'a sideways drag is not a close and not a step', out.horizontal);
    check(out.tapNext && out.tapNext.join() === 'next', 'a plain tap on the right steps forward', out.tapNext);
    check(out.tapPrev && out.tapPrev.join() === 'prev', 'a plain tap on the left steps back', out.tapPrev);
    check(out.holdSoFar && out.holdSoFar.join() === 'pause', 'press-and-hold pauses', out.holdSoFar);
    check(out.holdThenRelease && out.holdThenRelease.join() === 'pause,resume', 'releasing a hold resumes without stepping', out.holdThenRelease);
    check(out.flickNoPause && out.flickNoPause.length === 0, 'a quick flick never pauses (the hold timer drops on movement)', out.flickNoPause);
    check(out.flickRelease && out.flickRelease.length === 0, 'and releasing a flick steps nothing', out.flickRelease);
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
