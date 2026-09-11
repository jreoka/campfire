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
//
// This drives the REAL tap-zone + swipe wiring out of stories.js (sliced, since
// there is no bundler) against the real `#story-view` markup and the real
// stylesheet in headless Chrome, dispatching real PointerEvents at a phone
// viewport. Skips without Chrome.
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
const gestureSrc = stories.slice(
  gestureStart,
  stories.indexOf("document.addEventListener('keydown'", gestureStart)
);

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
const stage = document.getElementById('sv-stage');
const next = document.getElementById('sv-next');
const prev = document.getElementById('sv-prev');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerType: 'touch', isPrimary: true, pointerId: 1 }));
const swipe = (el, x0, y0, x1, y1) => { ev(el, 'pointerdown', x0, y0); ev(el, 'pointermove', (x0 + x1) / 2, (y0 + y1) / 2); ev(el, 'pointermove', x1, y1); ev(el, 'pointerup', x1, y1); };
const tap = (el, x, y) => { ev(el, 'pointerdown', x, y); ev(el, 'pointerup', x, y); };
const reset = () => { window.__calls.length = 0; stage.style.transform = ''; };

(async () => {
  out.touchAction = getComputedStyle(stage).touchAction;
  // A downward swipe starting on the (stage-covering) next zone: close, no step.
  reset(); swipe(next, 200, 200, 210, 330);
  out.swipeOnNext = __calls.slice();
  // Same from the prev zone.
  reset(); swipe(prev, 200, 200, 205, 330);
  out.swipeOnPrev = __calls.slice();
  // Straight on the picture (no zone involved).
  reset(); swipe(document.getElementById('sv-img'), 200, 200, 200, 330);
  out.swipeOnImg = __calls.slice();
  // The picture follows the finger while dragging.
  reset(); ev(stage, 'pointerdown', 200, 200); ev(stage, 'pointermove', 200, 300);
  out.dragTransform = stage.style.transform;
  ev(stage, 'pointerup', 200, 200);
  out.dragCleared = stage.style.transform === '';
  // Too short: springs back, no close.
  reset(); swipe(stage, 200, 200, 205, 240);
  out.shortDrag = __calls.slice();
  out.shortCleared = stage.style.transform === '';
  // Sideways: not a close, and the zone guard keeps it from stepping either.
  reset(); swipe(next, 120, 300, 320, 310);
  out.horizontal = __calls.slice();
  // Plain taps still step.
  reset(); tap(next, 300, 300);
  out.tapNext = __calls.slice();
  reset(); tap(prev, 60, 300);
  out.tapPrev = __calls.slice();
  // Press-and-hold pauses, and releasing without moving does not step.
  reset(); ev(next, 'pointerdown', 300, 300);
  await sleep(260);
  out.holdSoFar = __calls.slice();
  ev(next, 'pointerup', 300, 300);
  out.holdThenRelease = __calls.slice();
  // A quick flick must not leave the story paused.
  reset(); ev(next, 'pointerdown', 300, 300); ev(next, 'pointermove', 300, 340); await sleep(260);
  out.flickNoPause = __calls.slice();
  ev(next, 'pointerup', 300, 340);
  out.flickRelease = __calls.slice();
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
  check(stories.includes("st.style.transform = ''"), 'and a closed/swapped viewer resets the stage offset');

  check(gestureSrc.length > 500 && gestureSrc.length < 4000, 'the gesture block slices cleanly', gestureSrc.length);
  check(gestureSrc.includes('storyZoneEl($(\'#sv-next\')') && gestureSrc.includes("stage.addEventListener('pointerup', end)"), 'and holds both the zones and the swipe');
  const chrome = findChrome();
  if (!chrome) { return skip('no Chrome/Edge found — set CHROME_PATH'); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-swipe-'));
  try {
    const htmlPath = path.join(dir, 'page.html');
    fs.writeFileSync(htmlPath, pageHtml());
    const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=390,780',
      '--virtual-time-budget=4000', '--dump-dom', 'file:///' + htmlPath.replace(/\\/g, '/')],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
    if (!m) return check(false, 'the swipe harness ran', { status: r.status, err: (r.stderr || '').slice(-400) });
    const out = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    console.log('\n[2] swiping down closes it');
    check(out.touchAction === 'none', 'the stage really computes touch-action:none', out.touchAction);
    check(out.swipeOnNext && out.swipeOnNext.join() === 'close', 'a swipe down on the right zone closes (and does not advance)', out.swipeOnNext);
    check(out.swipeOnPrev && out.swipeOnPrev.join() === 'close', 'and the same from the left zone', out.swipeOnPrev);
    check(out.swipeOnImg && out.swipeOnImg.join() === 'close', 'and straight off the picture', out.swipeOnImg);
    check(out.dragTransform && /translateY\(/.test(out.dragTransform), 'the picture follows the finger while dragging', out.dragTransform);
    check(out.dragCleared === true, 'and the offset is cleared on release');
    console.log('\n[3] taps and short/horizontal drags still behave');
    check(out.shortDrag && out.shortDrag.length === 0, 'a drag under the threshold neither closes nor steps', out.shortDrag);
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
