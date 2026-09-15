// The gap above a group's first follow-up — it used to be the odd one out.
//
// Reported: "i think theres more space inbetween the first and second consecutive
// message than there is for every consecutive message after that". Measured on the
// real CSS, a two-line group read
//   head → follow-up  = 11.2px
//   follow-up → follow-up = 5.6px
// because the head row's own .45rem bottom padding (.45+.15+.1 = .7rem) — its box
// padding, i.e. also its hover pill — was the thing the FIRST follow-up paid for,
// while every line after it paid `.1+.15+.1` (`.35rem`). The fix buys the collapsed
// stack on the follow-up instead (`.msg:not(.grouped) + .msg.grouped{margin-top:-.35rem}`),
// so the head keeps its shape and nothing else in the list moves.
//
// Two halves:
//   [A] static — the rule exists, is scoped to a head as the immediate predecessor,
//       and is NOT a bare `.msg.grouped` margin (that trailing margin applied to
//       every follow-up, which pulled the SECOND one flush to zero — measured
//       0px, and it is the trap this half exists to catch).
//   [B] headless Chrome — renders the REAL messageEl (sliced out of messages.js)
//       into a real #messages with the real styles.css, and MEASURES the text
//       gaps: every intra-group gap must equal the CSS's own arithmetic, a new
//       group must still clear it by a real margin, and the head's own padding
//       must be untouched (the fix must not be bought by reshaping the hover pill).
//
// Skips (exit 0) without Chrome. Usage: node scripts/test-msg-group-gap.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9358', 10);
const DESKTOP = { w: 1200, h: 800 };
const PHONE = { w: 390, h: 780 };
const REM = 16; // the root font size the rem values below are authored against

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }

const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const messages = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');

function sliceFn(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not slice "' + from + '" out of messages.js'); process.exit(1); }
  return src.slice(a, b);
}
// The REAL element builder and the REAL grouping rule — a class rename in either
// one has to fail here rather than pass against a hand-copied mock.
const MESSAGE_EL = sliceFn(messages, 'function messageEl(m, opts = {}) {', '// Discord-style grouping:');
const GROUPING = sliceFn(messages, 'const GROUP_MS = 5 * 60 * 1000;', 'function anchorBottom(');

// The list's own geometry, read out of the stylesheet (never hardcoded). A row's
// distance to the next is its neighbour's padding plus the container's own gap —
// and #messages is a flex column with one while #thread-replies (the thread
// panel's reply list, the other place messageEl groups) has none, which is
// exactly why the rule must be padding arithmetic and not a fixed pixel count.
function cssNum(re, what) {
  const m = css.match(re);
  if (!m) { console.error('[test] could not read ' + what + ' out of styles.css'); process.exit(1); }
  return parseFloat(m[1]) * REM;
}
const GROUPED_PAD = cssNum(/\.msg\.grouped\{padding-top:([\d.]+)rem;padding-bottom:[\d.]+rem\}/, 'the grouped rows\' padding');
const HEAD_PAD = cssNum(/\.msg\{display:flex;gap:[\d.]+rem;padding:([\d.]+)rem/, 'the message row padding');
const EXCESS = Math.round((HEAD_PAD - GROUPED_PAD) * 10) / 10; // .45 − .1 = .35rem = 5.6px
// The gap each container adds between rows, per container.
const CONTAINERS = [
  { id: 'messages', gap: cssNum(/#messages\{[^}]*gap:([\d.]+)rem\}/, 'the list gap') },
  { id: 'thread-replies', gap: 0 }, // #thread-replies is a plain block scroller
];

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

// One conversation that covers every adjacency the list can produce: a head, a
// three-line stack, another head with one follow-up, a lone message, a system
// line, then a lone message handing off to a new group.
const FIXTURE = [
  { id: 1, user: 'u1', text: 'Damn', head: true },
  { id: 2, user: 'u1', text: "That's a big trash can" },
  { id: 3, user: 'u1', text: 'wow' },
  { id: 4, user: 'u1', text: 'a fourth line in the same group' },
  { id: 5, user: 'u2', text: 'hello there', head: true },
  { id: 6, user: 'u2', text: 'and a second line from them' },
  { id: 7, user: 'u1', text: 'a lone message', head: true },
  { id: 8, user: null, sys: true, text: 'Cross pinned a message to this channel' },
  { id: 9, user: 'u1', text: 'after a system line', head: true },
  { id: 10, user: 'u2', text: 'a new group right after a lone message', head: true },
];

// The stubs messageEl leans on for plain text. Everything it must NOT get from a
// stub — the class names, the row structure, the grouping rule — comes from the
// real source above.
const STUBS = `
  var S = { me: { id: 'me' } };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function fmtFull() { return 'Thu, Sep 11 2026 at 2:00 PM'; }
  function fmtTime() { return '02:00 PM'; }
  function nameStyleFor() { return ''; }
  function tagHTML() { return ''; }
  function isBigEmoji() { return false; }
  function renderRich(t) { return esc(t); }
  function linkEmbedsHTML() { return ''; }
  function attachmentHTML() { return ''; }
  function voCardHTML() { return ''; }
  function pollHTML() { return ''; }
  function reactionsHTML() { return ''; }
  function quickReactsHTML() { return '<button class="qr">+</button>'; }
  function threadCardHTML() { return ''; }
  function paintAvatar(el) { el.style.background = '#b98d8d'; el.textContent = 'C'; }
  function paintThreadCardAvatar() {}
  function requestVideoPoster() {}
  function observeStick() {}
  function wireAttImage() {}
  function msgAuthor(m) { return m.user ? { id: m.user, display_name: 'Cross', username: 'cross' } : null; }
`;

// The paint loop from renderMessages, verbatim in shape: a day divider heads each
// day, and grouping is decided by the real shouldGroup().
const PAINT = `
  var FIXTURE = __FIXTURE__;
  function fmtDay(ts) { return new Date(ts).toDateString(); }
  function paintOne(box) {
    box.innerHTML = '';
    var msgs = FIXTURE.map(function (m, i) {
      return { id: m.id, created_at: 1757000000000 + i * 60000, content: m.text, sys: m.sys || false,
        user: m.user ? { id: m.user, display_name: 'Cross', username: 'cross' } : null };
    });
    var lastDay = '', prev = null;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      var day = 'THU, SEP 11';
      if (day !== lastDay) { lastDay = day; prev = null; var d = document.createElement('div'); d.className = 'day'; d.textContent = day; box.appendChild(d); }
      box.appendChild(messageEl(m, { grouped: shouldGroup(prev, m) }));
      prev = m;
    }
    box.dataset.painted = String(msgs.length);
  }
  __BOXES__.forEach(function (id) { paintOne(document.getElementById(id)); });
`;

const PROBE = `(() => {
  var box = document.getElementById(__BOX__);
  var rows = [].slice.call(box.querySelectorAll(':scope > .msg'));
  function r(n) { var b = n.getBoundingClientRect(); return { top: Math.round(b.top * 100) / 100, bottom: Math.round(b.bottom * 100) / 100 }; }
  var out = rows.map(function (el) {
    var t = el.querySelector('.text') || el;
    var head = el.querySelector('.head');
    var cs = getComputedStyle(el);
    return { mid: el.dataset.mid, grouped: el.classList.contains('grouped'), sys: el.classList.contains('sys'),
      textTop: r(t).top, textBot: r(t).bottom, headTop: head ? r(head).top : null,
      padTop: cs.paddingTop, padBot: cs.paddingBottom, marginTop: cs.marginTop, height: Math.round(el.getBoundingClientRect().height * 100) / 100 };
  });
  return { rows: out, painted: box.dataset.painted,
    followUps: box.querySelectorAll(':scope > .msg:not(.grouped) + .msg.grouped').length,
    bareFollowUps: box.querySelectorAll(':scope > .msg.grouped').length };
})()`;

function pageHtml() {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<link rel="stylesheet" href="/styles.css">'
    + '<style>body{margin:0;background:var(--bg)}#chat{display:flex;flex-direction:column;height:100vh}'
    + '#messages{padding-bottom:1rem}</style></head>'
    + '<body><div id="chat"><div id="messages"></div></div>'
    // The thread panel's own reply list: a bare container with that id is enough
    // to get its real CSS (a plain block scroller, no flex gap of its own).
    + '<div id="thread-replies"></div>'
    + '<script>' + STUBS + MESSAGE_EL + GROUPING
    + PAINT.replace('__FIXTURE__', JSON.stringify(FIXTURE)).replace('__BOXES__', JSON.stringify(CONTAINERS.map((c) => c.id)))
    + '</script>'
    + '</body></html>';
}

// ---------- [A] the rule ----------
function ruleChecks() {
  console.log('\n[A] the rule, and its reach');
  check(/\.msg:not\(\.grouped\) \+ \.msg\.grouped\{margin-top:-\.35rem\}/.test(css),
    'a follow-up that directly follows a HEAD rides up by the excess the head\'s own padding used to add');
  check(!/^\.msg\.grouped\{[^}]*margin-top/m.test(css),
    'and it is NOT a bare .msg.grouped margin — that also hit a follow-up after a follow-up (measured 0px)');
  check(!/\.msg:has\(/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')),
    'and it needs no :has() to find the head it follows — a plain `+` every engine here already honours');
  // The number is PADDING arithmetic only — head bottom minus follow-up padding —
  // which is what makes it right in a container with a flex gap (#messages) and
  // in one without (#thread-replies) at the same time.
  check(near(EXCESS, 0.35 * REM, 0.01) && near(HEAD_PAD - GROUPED_PAD, EXCESS, 0.01),
    'the number is the arithmetic: the head\'s padding minus the follow-up\'s, with no container gap in it',
    { headPad: HEAD_PAD, followUpPad: GROUPED_PAD, excess: EXCESS });
}

// ---------- [B] the layout ----------
async function layoutChecks() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-msggap-'));
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/styles.css')) {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end(css);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml());
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
    '--window-size=' + DESKTOP.w + ',' + DESKTOP.h, 'about:blank'], { stdio: 'ignore' });

  let ws = null;
  try {
    let info = null;
    for (let i = 0; i < 60 && !info; i++) {
      try { info = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); } catch { await sleep(250); }
    }
    if (!info) return skip('Chrome never opened its DevTools port');
    ws = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0; const pending = new Map();
    // A page error would leave the list empty and every measure reading the same
    // nothing, so it is collected and reported rather than silently tolerated.
    const pageErrors = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const call = (method, params, sessionId) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
      ws.send(JSON.stringify({ id: i, sessionId, method, params }));
    });
    const targetId = (await call('Target.createTarget', { url: 'about:blank' })).targetId;
    const sessionId = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    const sess = (m, p) => call(m, p, sessionId);
    const ev = async (expression) => {
      const r = await sess('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'page error');
      return r.result.value;
    };
    await sess('Page.enable');
    await sess('Runtime.enable');
    await sess('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
    await sleep(500);

    const probe = (boxId) => ev(PROBE.replace('__BOX__', JSON.stringify(boxId)));
    for (const container of CONTAINERS) {
      const built = await probe(container.id);
      if (pageErrors.length) {
        console.error('[test] the probe page threw:\n  ' + pageErrors.join('\n  '));
        process.exit(1);
      }
      if (Number(built.painted) !== FIXTURE.length) {
        console.error('[test] ' + container.id + ' did not paint (painted ' + built.painted + ')');
        process.exit(1);
      }
      check(built.followUps === 2 && built.bareFollowUps === 4,
        container.id + ': the real messageEl + shouldGroup produced 4 grouped rows, 2 of them right under a head', built);
    }

    // Every number the layout is judged against, from the stylesheet: a row's
    // distance to the next is its neighbour's padding plus the container's gap.
    const geometry = (container) => ({
      stack: Math.round((GROUPED_PAD * 2 + container.gap) * 10) / 10,          // follow-up → follow-up
      afterStack: Math.round((GROUPED_PAD + container.gap + HEAD_PAD) * 10) / 10, // last follow-up → new head
      afterHead: Math.round((HEAD_PAD + container.gap + HEAD_PAD) * 10) / 10,     // lone message → new head
    });

    for (const [label, vp] of [['desktop', DESKTOP], ['phone', PHONE]]) {
      await sess('Emulation.setDeviceMetricsOverride', {
        width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: label === 'phone',
      });
      await sleep(150);

      for (const container of CONTAINERS) {
        const g = geometry(container);
        const where = label + ' ' + container.id;
        const m = await probe(container.id);
        const byId = {};
        for (const row of m.rows) byId[row.mid] = row;
        const textGap = (a, b) => Math.round((byId[b].textTop - byId[a].textBot) * 10) / 10;
        // Air above a NEW group: the last line of the previous group to the new
        // head's own name line (so the head's line-height is not in the measure).
        const groupAir = (a, b) => Math.round((byId[b].headTop - byId[a].textBot) * 10) / 10;

        const intra = [textGap(1, 2), textGap(2, 3), textGap(3, 4), textGap(5, 6)];
        check(intra.every((x) => near(x, g.stack, 0.6)),
          where + ': every stacked follow-up sits ' + g.stack + 'px under the line above it (the CSS\'s own arithmetic)',
          intra);
        check(near(textGap(1, 2), textGap(2, 3), 0.3),
          where + ': the FIRST follow-up is exactly as far under its head as the next one is under it (the report)',
          { first: textGap(1, 2), second: textGap(2, 3) });
        check(intra.every((x) => x > 1),
          where + ': and the stack is still a stack, not lines run together', intra);

        const air = [groupAir(4, 5), groupAir(6, 7), groupAir(9, 10)];
        check(air.every((x) => x >= g.stack + 4),
          where + ': a NEW group still clears the stack by a real margin (grouping reads at a glance)',
          { air: air, stack: g.stack });
        // After a stacked line the air is one follow-up padding less than after a
        // head — the untouched geometry: this fix moved exactly one gap, not the
        // rhythm of the list.
        check(near(air[0], g.afterStack, 0.6) && near(air[1], g.afterStack, 0.6) && near(air[2], g.afterHead, 0.6),
          where + ': and no other gap moved (after a stack ' + g.afterStack + 'px, after a head ' + g.afterHead + 'px)',
          { air: air, want: [g.afterStack, g.afterStack, g.afterHead] });

        check(near(parseFloat(byId['1'].padBot), HEAD_PAD, 0.01) && near(parseFloat(byId['2'].padTop), GROUPED_PAD, 0.01),
          where + ': the fix did not come from reshaping the head row — its own padding (the hover pill) is intact',
          { headPadBot: byId['1'].padBot, followUpPadTop: byId['2'].padTop });
        check(near(parseFloat(byId['2'].marginTop), -EXCESS, 0.01)
          && parseFloat(byId['3'].marginTop) === 0 && parseFloat(byId['4'].marginTop) === 0
          && parseFloat(byId['6'].marginTop) < 0,
          where + ': only the row that hands off from a head moves; a stack\'s later lines are untouched',
          { first: byId['2'].marginTop, second: byId['3'].marginTop, third: byId['4'].marginTop, other: byId['6'].marginTop });
        check(byId['2'].height > 0 && byId['3'].height > 0,
          where + ': and both rows still have their own height (no row collapsed into its neighbour)',
          { second: byId['2'].height, third: byId['3'].height });
      }
    }
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome.kill(); } catch {}
    try { srv.close(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  ruleChecks();
  await layoutChecks();
  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
})().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
