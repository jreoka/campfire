// GIF results render as a masonry collage (each GIF keeps its own aspect
// ratio) instead of a uniform cropped grid, and the picker window is bigger on
// a desktop. Static checks against the real styles.css and pickers.js.
//
// The complaint: every GIF tile was forced to the same shape (90px tall with
// object-fit:cover), so wide GIFs got their sides cut off. The picker window
// itself was also small (370px wide, 390px tall).
//
// Usage: node scripts/test-gif-collage.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const pickers = fs.readFileSync(path.join(ROOT, 'public', 'js', 'pickers.js'), 'utf8');

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// --- masonry collage in the main picker ---
check(/#pk-gifs\{display:block;columns:3;column-gap:6px\}/.test(css),
  'the GIF tab is a 3-column masonry, not a flex grid');
check(/#pk-gifs>\.pk-subrow,#pk-gifs>\.pk-sec,#pk-gifs>\.pk-empty\{column-span:all\}/.test(css),
  'headers and empty states span the columns instead of landing in one');
check(/#pk-gifs \.pk-gif\{width:100%;margin:0 0 6px;break-inside:avoid\}/.test(css),
  'tiles are full column width and never split across columns');
check(/#pk-gifs \.pk-gif img\{height:auto\}/.test(css),
  'GIFs keep their own aspect ratio — no more cropped sides');

// --- the profile-media GIF modal gets the same treatment ---
check(/\.gif-grid\{display:block;columns:3;column-gap:6px;/.test(css),
  'the profile GIF modal is a masonry too');
check(/\.gif-grid \.pk-gif img\{height:auto\}/.test(css),
  'its GIFs keep their aspect ratio as well');
check(!/\.gif-grid \.pk-gif\{width:calc\(33\.333%/.test(css),
  'the old uniform 3-across tile width is gone');

// --- narrow layouts drop to two columns ---
check(/@media \(max-width:700px\),\(max-height:560px\) and \(pointer:coarse\)\{[\s\S]*?#pk-gifs\{columns:2\}/.test(css),
  'the picker GIF tab drops to two columns on narrow layouts');
check(/@media \(max-width:520px\)\{\s*\.gif-grid\{columns:2\}/.test(css),
  'the modal drops to two columns on phones');

// --- picker window size on desktop: skinnier than the first pass, and its
// footing/height are anchored to the measured top of the bottom stack ---
check(/#picker\{[^}]*width:min\(460px,calc\(100vw - 2rem\)\)/.test(css),
  'the picker window is skinnier on desktop (460px, was 560px)');
check(/max-height:min\(480px,calc\(100dvh - var\(--composer-h\) - var\(--strip-h\) - var\(--safe-b\) - 24px\)\)/.test(css),
  'the stylesheet caps the picker at the room above the composer even before JS runs');
check(/#picker\{[^}]*bottom:calc\(var\(--composer-h\) \+ var\(--strip-h\) \+ var\(--safe-b\) \+ max\(0px, 100dvh - var\(--vvh, 100dvh\)\)\)/.test(css),
  'the stylesheet fallback lifts the picker when the layout viewport runs taller than the visible window');
check(/max = Math\.min\(480, stackTop - GAP - 16\)/.test(pickers),
  'sizePicker caps the desktop height at 480 and at the real room above the measured stack top');
check(/pk\.style\.bottom = Math\.max\(0, Math\.round\(layoutH - stackTop \+ GAP\)\) \+ 'px'/.test(pickers),
  'sizePicker parks the desktop picker a fixed gap above the measured stack top (rect-based, immune to a stale layout viewport)');
check(/getBoundingClientRect\(\)\.top/.test(pickers),
  'the desktop footing is measured with getBoundingClientRect (visual-viewport coords from the real layout)');
check(/contains\('anchored'\)\) \{/.test(pickers),
  'the anchored reaction picker keeps bottom:auto (the measured footing must not touch it)');
check(!/vvh - footing - 24/.test(pickers),
  'the old offsetHeight-summed footing math is gone');
check(!/#picker\{[^}]*width:min\(560px,calc\(100vw - 2rem\)\)/.test(css),
  'the old 560px desktop width is gone');

if (failures.length) { console.log('\n' + failures.length + ' FAILURES'); process.exit(1); }
console.log('\n' + passed + ' checks passed');
