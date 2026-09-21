// A chat shows its scrollbar — every type of chat.
//
// Owner request: "pls add a scrollbar to all types of chats". The app hides the
// global 8px bar on every INNER scroller (see the opt-out list in styles.css:
// the rails, the member list, the pins/inbox rows, the upload stages) because a
// UA thumb's length and position read as a floating pill in a panel whose edge
// already says where it ends. A CONVERSATION is the one region where that trade
// goes the other way: "how much more is there, where am I" is exactly what the
// reader is asking. So `#messages` and `#thread-replies` come off that list and
// keep the bar.
//
// Those two ids ARE every type of chat the app has: a server channel and a 1:1
// or group DM both render into `#messages` (renderMessages in messages.js,
// renderDmMessages in pins.js) and a thread's replies into `#thread-replies`
// (renderThread in pickers.js). Nothing else renders a conversation, so nothing
// else needs the bar — and that is read out of the JS here, not asserted from
// memory.
//
// Three halves:
//   [A] static — both ids are off the opt-out lists (BOTH of them: the
//       `scrollbar-width:none` rule and the `::-webkit-scrollbar{display:none}`
//       one, because an engine that honours only one would still hide the bar),
//       both are still real scrollers, and both reserve their gutter.
//   [B] headless Chrome — the REAL stylesheet, four scrollers that all really
//       overflow: the two chats, `#member-list` (still opted out) and a plain
//       `#ctrl` (gutter `auto`). It measures the gutter each one takes, proves
//       `stable` means a short channel and a long one are the SAME width, and
//       does it again at phone width.
//   [C] pixels — a screenshot of that page, scanned for the app's own thumb
//       colour. A reserved gutter would pass [B] while painting nothing, which
//       is precisely the failure this request is about, so the bar is confirmed
//       on screen: thumb pixels in the chat's gutter column, and none at all
//       beside the list that is still opted out.
//
// Skips (exit 0) without Chrome. Usage: node scripts/test-chat-scrollbar.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { decodePNG } = require('./png-util');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9366', 10);
const DESKTOP = { w: 1400, h: 900 };
const PHONE = { w: 390, h: 780 };
const THUMB = [0x2b, 0x35, 0x4d]; // #2b354d — the app's scrollbar thumb
// The test page's own columns (nothing in styles.css sizes #chat/#thread-panel
// to a fixed width, so these two numbers ARE the layout under test).
const COL = { chat: 600, panel: 330 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const css = read('public/styles.css');
const messagesJs = read('public/js/messages.js');
const pinsJs = read('public/js/pins.js');
const pickersJs = read('public/js/pickers.js');
const shellHtml = read('public/index.html');

// ---------- reading a rule's selector list out of the stylesheet ----------
// Every selector list that carries `decl`, found by walking back from each
// occurrence to the `{` that opens its block and from there to the previous
// brace/semicolon. Comments are stripped first so prose cannot be read as CSS.
function selectorsWith(styles, decl) {
  const clean = styles.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let at = -1;
  while ((at = clean.indexOf(decl, at + 1)) >= 0) {
    const open = clean.lastIndexOf('{', at);
    if (open < 0) continue;
    let start = open - 1;
    while (start >= 0 && clean[start] !== '}' && clean[start] !== '{' && clean[start] !== ';') start--;
    const sel = clean.slice(start + 1, open).trim();
    if (sel && !out.includes(sel)) out.push(sel);
  }
  return out;
}
// A selector list names `id` if one of its comma-separated selectors IS that id
// (a `::-webkit-scrollbar` suffix is stripped first, so `#messages::-webkit-scrollbar`
// still counts as naming #messages — the whole point of the second list).
function names(list, id) {
  return list.some((s) => s.split(',').some((one) => {
    const sel = one.trim().replace(/::[\w-]+[\s\S]*$/, '').trim();
    return sel === id || sel.split(/\s+/).includes(id);
  }));
}

const HIDDEN_BY_WIDTH = selectorsWith(css, 'scrollbar-width:none');
const HIDDEN_BY_WEBKIT = selectorsWith(css, 'display:none').filter((s) => /::-webkit-scrollbar/.test(s));

// ---------- [A] the stylesheet ----------
function ruleChecks() {
  console.log('\n[A] the stylesheet: the chats are off the opt-out list and get a bar of their own');

  check(names(HIDDEN_BY_WIDTH, '#member-list') && names(HIDDEN_BY_WIDTH, '#server-list')
    && names(HIDDEN_BY_WIDTH, '.up-rows'),
    'the opt-out list is still doing its job (rails, member list, upload stages stay barless)');
  check(!names(HIDDEN_BY_WIDTH, '#messages'),
    '#messages is off the scrollbar-width:none list — the channel / DM / group list gets the bar');
  check(!names(HIDDEN_BY_WIDTH, '#thread-replies'),
    '#thread-replies is off it too — a thread reply list gets the bar');
  check(!names(HIDDEN_BY_WEBKIT, '#messages') && !names(HIDDEN_BY_WEBKIT, '#thread-replies'),
    'and neither is hidden by a ::-webkit-scrollbar{display:none} rule — the engine that ignores scrollbar-width',
    { webkitHideLists: HIDDEN_BY_WEBKIT.length });

  check(/#messages,#thread-replies\{scrollbar-gutter:stable\}/.test(css),
    'both chat scrollers reserve their gutter (scrollbar-gutter:stable): short and long are ONE layout');
  check(/#messages\{[^}]*overflow-y:auto/.test(css) && /#thread-replies\{[^}]*overflow-y:auto/.test(css),
    'both are still real scrollers (a bar only exists on one)');

  // The bar itself is the app's own, so chat cannot drift into a second look.
  check(/::-webkit-scrollbar\{width:8px;height:8px\}/.test(css)
    && /::-webkit-scrollbar-thumb\{background:#2b354d;border-radius:99px\}/.test(css)
    && /\*\{scrollbar-width:thin;scrollbar-color:#2b354d transparent\}/.test(css),
    'the bar chat inherits is the app\'s 8px themed one — both flavours of the property, not a UA default');
  check(/\[data-theme="light"\] ::-webkit-scrollbar-thumb\{background:#b9c2d4\}/.test(css)
    && /\[data-theme="light"\] \*\{scrollbar-color:#b9c2d4 transparent\}/.test(css),
    'and the light theme restyles it too, so chat is not left with a UA bar there');

  // Every type of chat, read off the renderers: channel + DM + group all paint
  // into #messages, the thread panel into #thread-replies. A fourth surface that
  // grew its own message list is what these notice.
  check(/function renderMessages\(force = false\) \{\s*const box = \$\('#messages'\)/.test(messagesJs),
    'a server channel renders into #messages');
  check(/function renderDmMessages\(force = false\) \{\s*const box = \$\('#messages'\)/.test(pinsJs),
    'a 1:1 DM and a group chat render into the SAME #messages (they are one thread view)');
  check(/function renderThread\(scroll = false\) \{[\s\S]{0,400}?repBox = \$\('#thread-replies'\)/.test(pickersJs),
    'and a thread renders its replies into #thread-replies');
  for (const id of ['#messages', '#thread-replies']) {
    const n = (shellHtml.match(new RegExp('id="' + id.slice(1) + '"', 'g')) || []).length;
    check(n === 1, 'the shell carries exactly one ' + id + ' (' + n + ') — no second conversation list to forget');
  }
}

// ---------- the page ----------
// Four scrollers that all really overflow, on the REAL stylesheet:
//   #messages / #thread-replies  the chats under test
//   #member-list                 opted out — the contrast (hidden, no gutter)
//   #ctrl                        no gutter rule at all — what `auto` gives
const PAGE = (cssText) => '<!doctype html><html><head><meta charset="utf-8">'
  + '<style>' + cssText + '</style>'
  + '<style>'
  + 'html,body{margin:0;height:100%;overflow:hidden;background:var(--bg)}'
  + 'body{display:flex;align-items:stretch}'
  + '#chat{flex:0 0 ' + COL.chat + 'px;height:100vh}'
  + '#members{flex:0 0 244px;height:100vh}'
  + '#thread-panel{flex:0 0 ' + COL.panel + 'px;height:100vh}'
  + '#ctrl{flex:0 0 120px;height:100vh;overflow-y:auto}'
  + '.row40{height:40px;flex:0 0 40px;overflow:hidden}'
  + '</style></head><body>'
  + '<main id="chat"><div id="messages"></div>'
  + '<form id="composer"><textarea id="in-message" rows="1"></textarea></form></main>'
  + '<aside id="members"><div id="member-list"></div></aside>'
  + '<aside id="thread-panel"><div id="thread-root"></div><div id="thread-replies"></div></aside>'
  + '<div id="ctrl"></div>'
  + '<script>'
  + 'window.fill=function(id,n){var el=document.getElementById(id);el.innerHTML="";'
  + 'for(var i=0;i<n;i++){var d=document.createElement("div");d.className="row40";d.textContent="row "+i;el.appendChild(d);}'
  + 'return el.scrollHeight;};'
  + 'window.metrics=function(id){var el=document.getElementById(id),cs=getComputedStyle(el),r=el.getBoundingClientRect();'
  + 'return{bar:el.offsetWidth-el.clientWidth,gutter:cs.scrollbarGutter||"",sw:cs.scrollbarWidth||"",'
  + 'overflowY:cs.overflowY,scrolls:el.scrollHeight>el.clientHeight+1,hOver:el.scrollWidth-el.clientWidth,'
  + 'clientW:el.clientWidth,offsetW:el.offsetWidth,parentW:el.parentElement.clientWidth,'
  + 'rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom}};};'
  + 'window.shellW=function(){var c=document.getElementById("chat");'
  + 'return{chatW:c.clientWidth,messagesW:document.getElementById("messages").offsetWidth,'
  + 'composerW:document.getElementById("composer").offsetWidth,'
  + 'docOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth};};'
  + '</script></body></html>';

const CHATS = ['messages', 'thread-replies'];
const OTHERS = ['member-list', 'ctrl'];

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

// Pixels within `tol` of a colour, in a rectangle of a decoded screenshot.
function countColour(img, colour, box, tol) {
  let n = 0;
  const x0 = Math.max(0, Math.floor(box.left)), x1 = Math.min(img.w, Math.ceil(box.right));
  const y0 = Math.max(0, Math.floor(box.top)), y1 = Math.min(img.h, Math.ceil(box.bottom));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * img.w + x) * 4;
      if (Math.abs(img.px[o] - colour[0]) <= tol && Math.abs(img.px[o + 1] - colour[1]) <= tol
        && Math.abs(img.px[o + 2] - colour[2]) <= tol) n++;
    }
  }
  return n;
}

async function browserChecks() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-chatscroll-'));
  const page = path.join(dir, 'p.html');
  fs.writeFileSync(page, PAGE(css));

  // Deliberately NO --hide-scrollbars: every other test wants them out of the
  // way, and this one exists to look at one.
  const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
    '--window-size=' + DESKTOP.w + ',' + DESKTOP.h,
    'file:///' + page.replace(/\\/g, '/')], { stdio: 'ignore' });

  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 80 && !target; i++) {
      await sleep(200);
      try {
        const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch {}
    }
    if (!target) return skip('headless Chrome never came up');

    ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0; const pending = new Map(); const pageErrors = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const call = (method, params) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const ev = async (expression) => {
      const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'page error');
      return r.result.value;
    };
    const fill = (el, n) => ev('window.fill(' + JSON.stringify(el) + ', ' + n + ')');
    const metrics = (el) => ev('window.metrics(' + JSON.stringify(el) + ')');
    const shot = async () => {
      const r = await call('Page.captureScreenshot', { format: 'png' });
      const f = path.join(dir, 'shot.png');
      fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
      return decodePNG(f);
    };
    await call('Page.enable');
    await call('Runtime.enable');
    await sleep(400);
    if (pageErrors.length) { console.error('[test] the probe page threw:\n  ' + pageErrors.join('\n  ')); process.exit(1); }

    console.log('\n[B] headless Chrome: four scrollers that all really overflow');
    for (const el of CHATS.concat(OTHERS)) await fill(el, 60);
    await sleep(200);

    const long = {};
    for (const el of CHATS.concat(OTHERS)) long[el] = await metrics(el);
    const notScrolling = CHATS.concat(OTHERS).filter((el) => !long[el].scrolls);
    if (notScrolling.length) {
      console.error('[test] these never overflowed, so nothing below is measured: ' + notScrolling.join(', '));
      process.exit(1);
    }

    // 1. the bar takes layout space in the chats...
    for (const el of CHATS) {
      check(long[el].bar >= 6 && long[el].bar <= 20,
        '#' + el + ': the scrollbar is drawn and takes real layout space (' + long[el].bar + 'px)',
        { bar: long[el].bar, scrollbarWidth: long[el].sw, gutter: long[el].gutter });
      check(long[el].sw !== 'none',
        '#' + el + ': and it is the themed thin bar, not the opt-out\'s `none`', { scrollbarWidth: long[el].sw });
      check(long[el].gutter === 'stable',
        '#' + el + ': the gutter is reserved (computed scrollbar-gutter:stable)');
      // The bar lives INSIDE the box: the list keeps its whole column and only
      // its own content narrows, so it never shrinks against the composer above.
      check(long[el].offsetW === long[el].parentW,
        '#' + el + ': the element itself keeps the full column — only its content pays (' + long[el].offsetW + 'px)',
        { offsetW: long[el].offsetW, parentW: long[el].parentW });
      check(long[el].hOver === 0, '#' + el + ': and the bar adds no sideways overflow of its own', { hOver: long[el].hOver });
    }
    check(long['messages'].offsetW === COL.chat && long['thread-replies'].offsetW === COL.panel - 1,
      'the two chats are exactly their columns wide (600px, and the 330px panel less its 1px border)',
      { messages: long['messages'].offsetW, replies: long['thread-replies'].offsetW });

    // 2. ...and NOT in the panels that opted out, which is what makes the
    //    measurement above a measurement of a scrollbar and not of whitespace.
    check(long['member-list'].bar === 0,
      '#member-list stays opted out — a full list with no bar and no gutter reserved',
      { bar: long['member-list'].bar, sw: long['member-list'].sw });
    check(long['ctrl'].bar >= 6,
      'a plain scroller (no gutter rule) still takes the UA auto gutter — the control case',
      { bar: long['ctrl'].bar, gutter: long['ctrl'].gutter, sw: long['ctrl'].sw });

    // 3. `stable` is the whole point: the SAME channel, short and long, is one
    //    width. With `auto` the control grows back by its bar the moment it empties.
    for (const el of CHATS.concat(OTHERS)) await fill(el, 1);
    await sleep(200);
    const brief = {};
    for (const el of CHATS.concat(OTHERS)) brief[el] = await metrics(el);
    for (const el of CHATS) {
      check(!brief[el].scrolls, '#' + el + ': it really was short (nothing left to scroll)');
      check(brief[el].clientW === long[el].clientW,
        '#' + el + ': and a short conversation is exactly as wide as a long one (' + brief[el].clientW
        + 'px) — no sideways jump at the fold', { short: brief[el].clientW, long: long[el].clientW });
    }
    check(brief['ctrl'].clientW === long['ctrl'].clientW + long['ctrl'].bar,
      'the control shows what that bought: with `auto` the emptied list grew back by its bar',
      { short: brief['ctrl'].clientW, long: long['ctrl'].clientW, bar: long['ctrl'].bar });

    // 4. the narrow layout too.
    console.log('\n[B2] a phone-width column (390px)');
    await call('Emulation.setDeviceMetricsOverride', {
      width: PHONE.w, height: PHONE.h, deviceScaleFactor: 1, mobile: false,
    });
    for (const el of CHATS) await fill(el, 60);
    await sleep(250);
    const shellW = await ev('window.shellW()');
    for (const el of CHATS) {
      const m = await metrics(el);
      check(m.bar >= 6 && m.scrolls && m.gutter === 'stable',
        '#' + el + ': still a visible, gutter-reserving bar at 390px wide',
        { bar: m.bar, gutter: m.gutter, scrolls: m.scrolls });
    }
    check(shellW.messagesW === shellW.chatW && shellW.composerW === shellW.chatW,
      'and the message list still fills the column, level with the composer — the bar takes nothing off the shell',
      shellW);

    // ---------- [C] the pixels ----------
    console.log('\n[C] the pixels: the bar is PAINTED, not merely reserved');
    await call('Emulation.clearDeviceMetricsOverride');
    await sleep(250);
    for (const el of CHATS.concat(['member-list'])) await fill(el, 60);
    await sleep(250);
    const img = await shot();
    for (const el of CHATS) {
      const m = await metrics(el);
      const r = m.rect;
      const strip = { left: r.right - m.bar, right: r.right, top: r.top + 2, bottom: r.bottom - 2 };
      const n = countColour(img, THUMB, strip, 18);
      check(n > 200,
        '#' + el + ': the app\'s own thumb colour (#2b354d) is on screen in its gutter — ' + n + 'px of it',
        { strip, bar: m.bar });
      // The strip really is the gutter: the thumb colour appears in it and
      // nowhere in the first 40px of the list beside it.
      const outside = countColour(img, THUMB, { left: r.left, right: r.left + 40, top: r.top + 2, bottom: r.bottom - 2 }, 0);
      check(outside === 0, '#' + el + ': and that colour is nowhere in the first 40px of the list', { outside });
    }
    const ml = await metrics('member-list');
    const mlStrip = { left: ml.rect.right - 20, right: ml.rect.right, top: ml.rect.top + 2, bottom: ml.rect.bottom - 2 };
    check(countColour(img, THUMB, mlStrip, 18) === 0,
      '#member-list: not one thumb pixel beside a list that is still opted out — the opt-out is intact',
      { strip: mlStrip, bar: ml.bar });
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome.kill(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  ruleChecks();
  await browserChecks();
  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
})().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
