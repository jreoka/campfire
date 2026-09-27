// The message hover bar stuck open after a MOUSE click, because the clicked
// button stayed document.activeElement and `.msg:focus-within` counts that.
//
// The bar opens on `.msg:hover` (pointer) and, for the keyboard, on focus
// inside the message. Those are two different conditions, and :focus-within is
// the wrong way to spell the second one:
//
//   Click a quick-reaction 👍 on a message. That button is now
//   document.activeElement and it stays that way until something else takes
//   focus — a mouse click does not blur it, and moving the pointer does not
//   either. So `.msg:focus-within` on THAT message stays true. Move the
//   pointer down to another message: its bar opens on :hover, and the first
//   message's bar stays open too, on the strength of focus nobody can see. Two
//   bars, one conversation, and nothing on screen to dismiss either.
//
//   :focus-visible is the condition that means "the reader is using the
//   keyboard" — true for Tab-driven focus, false for focus that came from a
//   mouse click. Keying the reveal on it fixes the freeze and leaves the
//   keyboard path alone.
//
// This is measured, not asserted as CSS text, because the bug IS a rendered
//   state: a static check for the literal `:focus-visible` would also pass
//   against a rule that never matches, sitting next to a dead :focus-within
//   still doing the real work.
//
// Halves:
//   [A] headless Chrome — the REAL resting state, two messages, REAL mouse and
//       key events through CDP, reading computed visibility. The same script is
//       replayed against a control page that keeps :focus-within (the shipped
//       bug) and a page that keeps the fix, so the rule is the only variable —
//       and the control's expected-wrong answer is asserted, because a control
//       that cannot fail proves nothing.
//   [B] static — the reveal is split across two rules (an unparseable :has()
//       would otherwise take the :hover reveal down with it, since one bad
//       selector invalidates the entire list), the focus half is genuinely
//       :has(:focus-visible), and no :focus-within reveal of the bar is left.
//
// Run one browser test at a time and give it its own port; parallel Chrome
// spawns collide and report "Chrome never opened its DevTools port".
// Usage: node scripts/test-hoverbar-focus.js   (TEST_CDP_PORT=9402 to move it)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9402', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/home/agent/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

const chromePath = findChrome();
if (!chromePath) skip('no Chrome/Chromium found (set CHROME_PATH)');

const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8').replace(/\r\n/g, '\n');

// The resting state, copied from the real rule rather than approximated: the bar
// is `visibility:hidden; pointer-events:none` at rest, and that pair is load-
// bearing twice over — a hidden bar cannot be clicked, and a hidden bar's
// buttons are not focusable, which is why the keyboard half below has to be
// driven through a LINK rather than by tabbing onto a reaction button.
const base = `
  .msg{position:relative;display:flex;gap:.7rem;padding:.45rem .6rem;min-height:44px;align-items:flex-start}
  .msg-actions{position:absolute;right:.6rem;top:-18px;display:flex;gap:2px;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .13s ease-out,visibility .13s}
  .msg-actions button{border:0;background:transparent;min-width:30px;min-height:24px;padding:.2rem .35rem;cursor:pointer}
`;
// The two rules under test, each page carrying exactly one so nothing can be
// masked by the other matching first. CONTROL is the shipped rule verbatim.
const RULE_CONTROL = '.msg:hover .msg-actions,.msg:focus-within .msg-actions{opacity:1;visibility:visible;pointer-events:auto}';
const RULE_FIX_HOVER = '.msg:hover .msg-actions{opacity:1;visibility:visible;pointer-events:auto}';
const RULE_FIX_FOCUS = '.msg:has(:focus-visible) .msg-actions{opacity:1;visibility:visible;pointer-events:auto}';

const bar = (act) => `<div class="msg-actions"><button data-act="react">&#128077;</button>`
  + `<button data-act="reply">R</button><button data-act="menu">M</button></div>`;

function pageHtml(rules) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${base}\n${rules}</style></head>
<body>
  <div id="messages">
    <div class="msg" id="m1"><span class="avatar">A</span>
      <span class="text">first message with <a href="#somewhere" id="lnk1">a link</a></span>${bar()}</div>
    <div class="msg" id="m2"><span class="avatar">B</span><span class="text">second message</span>${bar()}</div>
  </div>
  <!-- Outside every message: the "focus left the message" target, and the
       place the pointer is parked so that no :hover is in play. -->
  <button id="outside" style="position:fixed;left:0;bottom:0;width:100%;height:120px">outside</button>
</body></html>`;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-hoverfocus-'));
  const controlPath = path.join(dir, 'control.html');
  const fixPath = path.join(dir, 'fix.html');
  fs.writeFileSync(controlPath, pageHtml(RULE_CONTROL));
  fs.writeFileSync(fixPath, pageHtml(RULE_FIX_HOVER + '\n' + RULE_FIX_FOCUS));

  // --no-sandbox is required in this container, not optional: without it the
  // zygote aborts with "No usable sandbox" and the DevTools port never opens.
  const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--disable-dev-shm-usage', '--hide-scrollbars',
    '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=700,600',
    `--remote-debugging-port=${CDP_PORT}`, 'about:blank'], { stdio: 'ignore' });

  const cleanup = () => { try { chrome.kill(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  process.on('exit', cleanup);

  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    try { ready = (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok; } catch {}
    if (!ready) await sleep(500);
  }
  if (!ready) { console.error('[test] Chrome never opened its DevTools port ' + CDP_PORT); cleanup(); process.exit(1); }

  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let id = 0;
  const pend = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  // REAL input throughout. el.click() would not move focus the way a press
  // does, and the whole distinction here is which modality set the focus, so
  // every click is a dispatched pointer sequence and every Tab a dispatched key.
  const move = async (x, y) => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }); await sleep(220); };
  const click = async (sel) => {
    const r = await evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    await move(r.x, r.y);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(300);
  };
  const key = async (vk, k) => {
    const b = { windowsVirtualKeyCode: vk, key: k, code: k, nativeVirtualKeyCode: vk };
    await send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, b));
    await send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, b));
    await sleep(170);
  };
  // visibility is the one that matters: opacity can be mid-transition, and the
  // bar at rest is visibility:hidden.
  const openBars = `(() => { const out = [];
    for (const el of document.querySelectorAll('.msg')) {
      if (getComputedStyle(el.querySelector('.msg-actions')).visibility === 'visible') out.push(el.id);
    }
    const ae = document.activeElement;
    return { open: out, focus: ae ? (ae.id || ae.tagName) : null,
      fv: !!(ae && ae.matches && ae.matches(':focus-visible')),
      inMsg: !!(ae && ae.closest && ae.closest('.msg')) }; })()`;
  const centre = (sel) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);

  await send('Page.enable');
  await send('Runtime.enable');

  // The script, replayed against whichever page is loaded. `stuck` is the
  // expected answer on the control page: it is the bug, asserted rather than
  // merely tolerated.
  async function scenario(file, label, stuck) {
    console.log('\n  --- ' + label + ' ---');
    await send('Page.navigate', { url: 'file://' + file });
    await sleep(700);

    // 1. resting state: pointer parked off every message, no bar anywhere.
    await move(650, 590);
    const rest = await evaluate(openBars);
    check(rest.open.length === 0, 'no bar is open at rest', rest.open);

    // 2. the pointer reveal, which the fix must not break.
    let p = await centre('#m1 .text');
    await move(p.x, p.y);
    const hov = await evaluate(openBars);
    check(hov.open.length === 1 && hov.open[0] === 'm1', 'hovering a message opens that message\'s bar, and only its', hov.open);

    // 3. THE BUG. Click the quick-reaction with the MOUSE, then walk the pointer
    //    to the other message. The clicked button is still the active element.
    await click('#m1 .msg-actions button[data-act=react]');
    const afterClick = await evaluate(openBars);
    check(afterClick.fv === false, 'the click left focus on the button, and it is NOT focus-visible', afterClick);
    check(afterClick.focus === 'BODY' ? true : !afterClick.inMsg === false, 'focus is still inside the clicked message', afterClick);
    p = await centre('#m2 .text');
    await move(p.x, p.y);
    const afterLeave = await evaluate(openBars);
    if (stuck) {
      check(afterLeave.open.includes('m1') && afterLeave.open.includes('m2'),
        'CONTROL: the clicked message\'s bar is stuck open next to the hovered one (the bug, reproduced)', afterLeave.open);
    } else {
      check(afterLeave.open.length === 1 && afterLeave.open[0] === 'm2',
        'after clicking a quick-reaction and moving on, only the message under the pointer has a bar', afterLeave.open);
      check(!afterLeave.open.includes('m1'), 'and the clicked message\'s bar did not stay stuck open', afterLeave.open);
    }

    // 4. the keyboard path, which the fix must leave alone — otherwise it has
    //    traded a mouse bug for an accessibility one.
    //
    //    Driven the way a keyboard user actually arrives: Tab onto the LINK in
    //    the message. Not by tabbing onto a reaction button: a bar at rest is
    //    visibility:hidden, and a hidden bar's buttons are not focusable, so
    //    there is nothing to tab to until something else in the message has
    //    focus. That is true of both rules and is unchanged by this fix — but
    //    it means the only honest keyboard route in is via focusable content,
    //    and a link is what real messages have.
    await send('Page.navigate', { url: 'file://' + file });
    await sleep(600);
    await move(650, 590);
    await key(9, 'Tab');                                  // keyboard modality, set by a real key
    const onLink = await evaluate(openBars);
    check(onLink.focus === 'lnk1' && onLink.inMsg && onLink.fv === true,
      'Tab reaches the link in the first message, and it is focus-visible', onLink);
    check(onLink.open.includes('m1'), 'and the bar opens for that keyboard focus', onLink.open);
    await key(9, 'Tab');                                  // into the bar, now that it is visible
    const inBar = await evaluate(openBars);
    check(inBar.inMsg === true, 'Tab then reaches a button inside the bar', inBar);
    p = await centre('#m2 .text');
    await move(p.x, p.y);
    const kbdAway = await evaluate(openBars);
    check(kbdAway.open.includes('m1'),
      'the keyboard-focused bar stays open even when the pointer moves to another message', kbdAway.open);
    await evaluate(`document.getElementById('outside').focus()`);
    // Settle first: the bar's resting state is behind a .13s opacity/visibility
    // transition, and reading computed style in the middle of it still says
    // "visible" — a stale read here would blame the rule for the animation.
    await sleep(350);
    const left = await evaluate(openBars);
    check(!left.open.includes('m1'), 'and it closes once focus leaves the message', left.open);
  }

  console.log('[1] one script, two rules');
  await scenario(controlPath, 'CONTROL — :focus-within (the rule that shipped)', true);
  await scenario(fixPath, 'FIX — :has(:focus-visible)', false);

  console.log('\n[2] the stylesheet, statically');
  const hoverRule = /\.msg:hover \.msg-actions\{([^}]*)\}/.exec(css);
  check(!!hoverRule, 'the pointer reveal is a .msg:hover rule of its own', (css.match(/\.msg:hover \.msg-actions[^\n]*/) || [null])[0]);
  if (hoverRule) for (const p of ['opacity:1', 'visibility:visible', 'pointer-events:auto']) check(hoverRule[1].includes(p), 'it pins ' + p);
  const focusRule = /\.msg:has\(:focus-visible\) \.msg-actions\{([^}]*)\}/.exec(css);
  check(!!focusRule, 'the keyboard reveal is a .msg:has(:focus-visible) rule', (css.match(/\.msg:has\([^\n]*/) || [null])[0]);
  if (focusRule) for (const p of ['opacity:1', 'visibility:visible', 'pointer-events:auto']) check(focusRule[1].includes(p), 'and it pins ' + p);
  // The two must not share a selector list: one unparseable :has() invalidates
  // the whole list, taking the hover reveal with it and leaving a bar that
  // never appears at all — a worse bug than the one being fixed.
  check(!/\.msg:hover \.msg-actions\s*,[^{]*:has\(:focus-visible\)/.test(css),
    'the :has() rule does NOT share a selector list with :hover (an engine without :has() would lose the bar entirely)');
  check(!/\.msg:focus-within \.msg-actions/.test(css), 'no :focus-within reveal of the bar is left anywhere in the sheet');
  check(/@media \(hover:none\)\{\s*\.msg-actions\{display:none!important\}/.test(css),
    'touch is still served by (hover:none) removing the bar, so the focus half has no touch consumer to lose');

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f of failures) console.log('  - ' + f);
    cleanup();
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
  try { ws.close(); } catch {}
  cleanup();
  process.exit(0);
})().catch((e) => { console.error('[test] ERR', e && e.message); process.exit(1); });
