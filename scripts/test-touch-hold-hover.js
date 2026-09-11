// A long-press must not leave a row looking pre-selected (see AGENTS.md).
//
// The complaint: holding a message on a phone slides the action sheet up under a
// finger that is still on the screen, and one row is already highlighted. That is
// Blink painting the `:hover` background of whatever row the finger lands on (and
// it keeps it sticky after the lift), so a row reads as chosen before anything
// was chosen.
//
// `suppressHoverFromTouch()` puts `body.touch-hold` on for anything opened out of
// a recent touch, and the stylesheet neutralizes those hovers under it; the class
// comes off on the next touch / real move, when a row under the finger is honest
// feedback again. This drives the REAL helper out of actions.js and checks the
// stylesheet actually covers every hover a touch-opened menu can paint.
//
// Offline (no Chrome, no database).
//
// Usage: node scripts/test-touch-hold-hover.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}

const actions = fs.readFileSync(path.join(ROOT, 'public/js/actions.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

// ---- the real helper, against a fake body classList and a fake clock --------
const helperSrc = actions.slice(actions.indexOf('let lastTouchAt = 0;'), actions.indexOf('function openCtx(x, y, items) {'));
const classes = new Set();
const evalSrc = `
const document = { body: { classList: {
  add: (c) => __classes.add(c),
  remove: (c) => __classes.delete(c),
  contains: (c) => __classes.has(c),
} } };
const Date = { now: () => globalThis.__now };
${helperSrc}
;({ suppressHoverFromTouch, noteTouchStart, noteTouchMove })
`;
globalThis.__classes = classes;
globalThis.__now = 1000000;
const { suppressHoverFromTouch, noteTouchStart, noteTouchMove } = eval(evalSrc);
const held = () => classes.has('touch-hold');

console.log('\n[1] the guard only applies to a touch-opened menu');
check(suppressHoverFromTouch() === undefined && !held(), 'never touched (a mouse/right-click menu): nothing is suppressed');
noteTouchStart();
suppressHoverFromTouch();
check(held(), 'a touch just began then the sheet opened → hover is held off', [...classes]);
globalThis.__now += 2000;
suppressHoverFromTouch();
check(held(), 'still held for that menu (the class is idempotent)');
noteTouchMove();
check(!held(), 'a real finger move hands hover back (feedback while exploring)');
noteTouchStart();
globalThis.__now += 4000; // stale touch: this menu was not opened by a touch
suppressHoverFromTouch();
check(!held(), 'a much older touch never suppresses a later menu');
noteTouchStart();
check(!held(), 'and starting a new touch clears the class');

console.log('\n[2] every hover a touch-opened menu can paint is covered');
const HOVERS = [
  ['.sheet-row:hover', 'body.touch-hold .sheet-row:hover'],
  ['.sheet-reacts button:hover', 'body.touch-hold .sheet-reacts button:hover'],
  ['.sheet-cancel:hover', 'body.touch-hold .sheet-cancel:hover'],
  ['.ctx-item:hover', 'body.touch-hold .ctx-item:hover'],
];
const rule = (sel) => {
  // The guard rule is a selector LIST (`a:hover, b:hover, c:hover{...}`), so find
  // the next `{` after the selector rather than expecting `sel{`.
  let from = 0;
  for (;;) {
    const i = css.indexOf(sel, from);
    if (i < 0) return null;
    const rest = css.slice(i + sel.length);
    const ob = rest.indexOf('{'), cb = rest.indexOf('}');
    if (ob >= 0 && (cb < 0 || ob < cb)) return rest.slice(ob + 1, rest.indexOf('}', ob));
    from = i + sel.length;
  }
};
for (const [hover, guard] of HOVERS) {
  const base = rule(hover);
  check(!!base, hover + ' exists in the stylesheet', base);
  const g = rule(guard);
  check(!!g, guard + ' neutralizes it', g);
  const prop = /background:([^;}]+)/.exec(base || '');
  if (prop) {
    check(new RegExp('background:\\s*(transparent|var\\(--panel-3\\))').test(g || ''), guard + ' overrides the background ' + prop[1].trim(), g);
  }
}
// A generic sweep: anything else hover-styled inside the touch-opened menus has
// to be covered too, or the next row added would glow again.
const menuHover = [...css.matchAll(/(?:^|\})\s*(\.(?:sheet-row|sheet-cancel|sheet-sw|sheet-head[^\s{,]*|ctx-item)[^{},]*:hover[^{},]*)\{/gm)].map((m) => m[1].trim());
const uncovered = menuHover.filter((sel) => !css.includes('body.touch-hold ' + sel));
check(uncovered.length === 0, 'no hover inside a touch-opened menu is left uncovered', uncovered);

console.log('\n[3] the openers and the touch listeners are wired');
check(/function openCtx\(x, y, items\) \{\n  suppressHoverFromTouch\(\);/.test(actions) || /function openCtx\(x, y, items\) \{[\s\S]{0,40}suppressHoverFromTouch\(\);/.test(actions), 'the floating popup suppresses');
check(/function openCtxSheet\(items, head\) \{[\s\S]{0,90}suppressHoverFromTouch\(\);/.test(actions), 'the sheet suppresses');
check(/function openMsgSheet\(mid\) \{[\s\S]{0,90}suppressHoverFromTouch\(\);/.test(actions), 'the message sheet suppresses');
check(/document\.addEventListener\('touchstart', \(e\) => \{\r?\n\s*noteTouchStart\(\);/.test(actions), 'touchstart records the touch before its early returns');
check(/touchmove[\s\S]{0,400}noteTouchMove\(\)/.test(actions), 'a real move hands hover back');
check(/pointermove'[\s\S]{0,80}pointerType === 'mouse'[\s\S]{0,40}noteTouchMove\(\)/.test(actions), 'and so does a real mouse move (hybrid devices)');

console.log('');
if (failures.length) {
  console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log(`All ${passed} checks passed.`);
