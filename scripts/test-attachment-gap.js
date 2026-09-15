// The attachment strip's distance from the message box — on BOTH bars.
//
// Reported (first): with an upload card on screen, and again with the finished
// attachment chip, both sat "quite far" above the composer, because the
// always-reserved typing strip (#typing-bar, --strip-h) lives between them and
// #composer and cannot simply be dropped. The fix was targeted: while either card
// list is on screen #composer gives back most of its top padding, so the cards
// come down to the field.
//
// Reported (again, the other way): they then sat ON the box — the two stages of
// an upload (the progress card, then the chip with its Spoiler toggle) read as
// touching the field they are about to be sent from. So the composer gives back
// LESS (.55rem, not .25rem), which is what this pins. The thread bar is the chat
// bar's own version and has its own copy of the same three pieces — its chip row,
// its upload list and its own typing strip (#thread-typing-bar) — so it is
// measured here too, and must land on the same gap.
//
// Two halves:
//   [A] headless Chrome — builds the REAL chat column and the REAL thread panel
//       (index.html's markup + the real styles.css) and MEASURES the gap between
//       the cards and the input pill on both, at a desktop and a phone viewport,
//       with and without the cards on screen, plus each strip's unchanged height.
//   [B] static — the rules must out-cascade the `#composer{padding:…}` shorthand
//       (specificity 1,1,0 beats the media-query 1,0,0 regardless of source
//       order) and the card lists must really be siblings of their composer.
//
// Skips (exit 0) without Chrome. Usage: node scripts/test-attachment-gap.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9356', 10);
const DESKTOP = { w: 1200, h: 800 };
const PHONE = { w: 390, h: 780 };

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
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

// The card lists, the typing strip and the composer, in document order, taken
// out of the real index.html (so a reorder in the shell fails the test).
function columnMarkup() {
  const grab = (id) => {
    const a = html.indexOf('<div id="' + id + '"');
    if (a < 0) return null;
    // Each of these is an empty, self-closing div in the shell.
    return html.slice(a, html.indexOf('</div>', a) + 6);
  };
  const cf = html.indexOf('<form id="composer">');
  return ['attach-preview', 'upload-list', 'typing-bar'].map(grab).join('\n')
    + '\n' + html.slice(cf, html.indexOf('</form>', cf) + 7);
}
// The thread panel verbatim (the second composer, with its own two card rows and
// its own typing strip), with `hidden` off so it has layout to measure.
function threadMarkup() {
  const a = html.indexOf('<aside id="thread-panel"');
  return html.slice(a, html.indexOf('<!-- search tab -->')).replace('class="hidden"', '');
}

function pageHtml() {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<link rel="stylesheet" href="/styles.css">'
    + '<style>body{margin:0;height:100vh}'
    // cf-rise scales the panel on its first frame and a probe page never advances
    // it: measure the settled layout the reader ends up with.
    + '#thread-panel{animation:none!important}</style></head><body>'
    + '<div style="display:flex;height:100vh"><div id="chat"><div id="messages"></div>' + columnMarkup() + '</div>'
    + threadMarkup() + '</div>'
    + '</body></html>';
}

// Injected as ONE expression so nothing can depend on page timing: paint a stage
// on BOTH bars, then read the geometry back.
const PROBE = `(() => {
  var CHIP = '<div class="att-chip" id="CHIPID"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt=""><span>HSD4VkcbAAAvP4x.jpg</span><button class="mini">Spoiler</button><button class="mini">x</button></div>';
  var CARD = '<div class="up-card" id="CARDID"><div class="up-ic"></div><div class="up-body"><div class="up-top"><span class="up-name">x.jpg</span><span class="up-pct"></span></div><div class="up-track"><div class="up-fill" style="width:80%"></div></div><div class="up-sub">132.0 KB &middot; Uploading&hellip;</div></div></div>';
  var stage = window.__stage || 'none';
  function fill(apId, ulId, prefix) {
    var ap = document.getElementById(apId), ul = document.getElementById(ulId);
    ap.className = 'hidden'; ul.className = 'hidden';
    ap.innerHTML = ''; ul.innerHTML = '';
    if (stage === 'chip' || stage === 'both') {
      ap.className = '';
      ap.innerHTML = CHIP.replace('CHIPID', prefix + '-chip');
    }
    if (stage === 'both') {
      ul.className = '';
      ul.innerHTML = CARD.replace('CARDID', prefix + '-card');
    }
  }
  fill('attach-preview', 'upload-list', 'c');
  fill('thread-attach-preview', 'thread-upload-list', 't');
  function measure(cfg) {
    var ap = document.getElementById(cfg.chips), ul = document.getElementById(cfg.uploads);
    var row = ul.classList.contains('hidden') ? ap : ul;
    var box = document.getElementById(cfg.box), comp = document.getElementById(cfg.composer);
    var strip = document.getElementById(cfg.strip);
    var chip = document.getElementById(cfg.prefix + '-chip');
    // With no card on screen there is nothing to measure FROM (the empty rows are
    // zero-height at the top of the page).
    var rb = chip && row ? row.getBoundingClientRect() : null;
    var bb = box ? box.getBoundingClientRect() : null;
    var cb = chip ? chip.getBoundingClientRect() : null;
    return {
      rowBottom: rb ? Math.round(rb.bottom) : null,
      boxTop: bb ? Math.round(bb.top) : null,
      gap: rb && bb ? Math.round(bb.top - rb.bottom) : null,
      gapFromChip: cb && bb ? Math.round(bb.top - cb.bottom) : null,
      pad: comp ? getComputedStyle(comp).paddingTop : null,
      stripH: strip ? Math.round(strip.getBoundingClientRect().height) : null,
      chipH: cb ? Math.round(cb.height) : null,
      chipW: cb ? Math.round(cb.width) : null,
    };
  }
  var chat = measure({ chips: 'attach-preview', uploads: 'upload-list', strip: 'typing-bar', composer: 'composer', box: 'composer-box', prefix: 'c' });
  var thread = measure({ chips: 'thread-attach-preview', uploads: 'thread-upload-list', strip: 'thread-typing-bar', composer: 'thread-composer', box: 'thread-composer-box', prefix: 't' });
  return { stage: stage, chat: chat, thread: thread, bothGap: Math.round(chat.gap) === Math.round(thread.gap) };
})()`;

async function main() {
  console.log('\n[A] the markup and the rule line up');
  const order = ['id="attach-preview"', 'id="upload-list"', 'id="typing-bar"', '<form id="composer">']
    .map((needle) => html.indexOf(needle));
  check(order.every((i) => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]),
    'attach-preview → upload-list → typing-bar → composer, in that order', order);
  const torder = ['id="thread-attach-preview"', 'id="thread-upload-list"', 'id="thread-typing-bar"', '<form id="thread-composer">']
    .map((needle) => html.indexOf(needle));
  check(torder.every((i) => i > 0) && torder.every((v, i) => i === 0 || v > torder[i - 1]),
    'and the thread panel repeats it: chips → cards → typing strip → reply box', torder);
  check(/#chat:has\(#attach-preview:not\(\.hidden\)\) #composer,#chat:has\(#upload-list:not\(\.hidden\)\) #composer\{padding-top:\.55rem\}/.test(css),
    'the composer gives back LESS air while a card list is on screen (.55rem — the two stages no longer sit on the field)');
  check(/#thread-panel:has\(#thread-attach-preview:not\(\.hidden\)\) #thread-composer,[\s\S]{0,60}#thread-composer\{padding-top:\.55rem\}/.test(css),
    'and the thread bar does the same, by the same number');
  check(/#thread-typing-bar\{[^}]*height:var\(--strip-h\)/.test(css),
    'the thread panel reserves the strip slot too (it is what keeps the cards off the reply box)');
  check(!/#composer:has\([^)]*~/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')),
    'and it does NOT key on a sibling combinator inside :has() (accepted by CSS.supports, never matched)', null);
  check(/#composer\{display:flex;[\s\S]{0,80}padding:\.9rem \.9rem \.9rem;/.test(css),
    'and the bare #composer shorthand it must out-cascade is still there');

  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-attgap-'));
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
    ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
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
    await sleep(600);
    const built = await ev('JSON.stringify({comp:!!document.getElementById("composer"),box:!!document.getElementById("composer-box"),strip:!!document.getElementById("typing-bar"),tcomp:!!document.getElementById("thread-composer"),tbox:!!document.getElementById("thread-composer-box"),tstrip:!!document.getElementById("thread-typing-bar")})');
    if (!/true/.test(built) || /false/.test(built)) {
      console.error('[test] the columns did not build: ' + built);
      process.exit(1);
    }
    const measure = async (stage) => {
      await ev('window.__stage=' + JSON.stringify(stage));
      await sleep(40);
      return ev(PROBE);
    };

    for (const [label, vp] of [['desktop', DESKTOP], ['phone', PHONE]]) {
      await sess('Emulation.setDeviceMetricsOverride', {
        width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: label === 'phone',
      });
      await sleep(150);

      const none = await measure('none');
      check(none.chat.pad === '14.4px' && none.thread.pad === '11.2px',
        label + ': with no cards each bar keeps its own normal top padding (.9rem chat, .7rem thread)',
        { chat: none.chat.pad, thread: none.thread.pad });
      check(none.chat.gap === null && none.thread.gap === null,
        label + ': and neither input pill has a card to measure against', none);

      const chip = await measure('chip');
      check(chip.chat.pad === '8.8px', label + ': with a chip on screen the chat composer takes .55rem back', chip.chat);
      // The row's own bottom padding is part of this measure: 8.8 (chip row) + 19
      // (strip) + 8.8 (composer) ≈ 37px from the chip's own edge to the pill.
      check(chip.chat.gapFromChip !== null && chip.chat.gapFromChip >= 30 && chip.chat.gapFromChip <= 44,
        label + ': so the chip clears the input pill by a real gap, not a hairline',
        { fromChip: chip.chat.gapFromChip, rowGap: chip.chat.gap, baseline: none.chat.boxTop });
      check(chip.chat.stripH === none.chat.stripH && chip.chat.stripH > 0,
        label + ': the typing strip keeps its reserved height (nothing below the cards moves)',
        { withCards: chip.chat.stripH, without: none.chat.stripH });

      const both = await measure('both');
      check(both.chat.gap !== none.chat.gap && both.chat.gap <= 130,
        label + ': an upload card above the chip stacks normally', both.chat);
      check(both.chat.stripH === none.chat.stripH,
        label + ': and the strip still has not moved', both.chat);
      check(chip.chat.chipH >= 40 && chip.chat.chipW > 150,
        label + ': the chip keeps its own thickness and width (the gap was not paid for by shrinking it)', chip.chat);

      // The thread bar, measured in the same pass: the same three pieces, the same
      // gap, its own strip keeping its own height.
      check(chip.thread.pad === '8.8px', label + ': the thread bar takes the same .55rem back', chip.thread);
      check(Math.abs(chip.thread.gapFromChip - chip.chat.gapFromChip) <= 2,
        label + ': and its cards sit exactly as far from the reply box as the chat\'s do',
        { chat: chip.chat.gapFromChip, thread: chip.thread.gapFromChip });
      check(chip.thread.stripH === none.thread.stripH && chip.thread.stripH > 0,
        label + ': the thread typing strip keeps its slot (the reply bar does not jump when someone types)',
        { withCards: chip.thread.stripH, without: none.thread.stripH });
      check(both.thread.gap === chip.thread.gap,
        label + ': with both stages up the thread bar keeps that same gap', both.thread);
      check(chip.thread.chipH >= 40 && chip.thread.chipW > 150,
        label + ': the reply chip keeps its own thickness and width too', chip.thread);
      check(none.thread.boxTop !== null && none.thread.stripH === none.chat.stripH,
        label + ': both bars reserve the same strip height',
        { chat: none.chat.stripH, thread: none.thread.stripH });

      const back = await measure('none');
      check(back.chat.gap === null && back.chat.pad === '14.4px' && back.thread.gap === null && back.thread.pad === '11.2px'
        && Math.abs(back.chat.boxTop - none.chat.boxTop) <= 1 && Math.abs(back.thread.boxTop - none.thread.boxTop) <= 1,
        label + ': clearing the cards restores both bars exactly as they were',
        { chatPad: back.chat.pad, threadPad: back.thread.pad, chatTop: [none.chat.boxTop, back.chat.boxTop], threadTop: [none.thread.boxTop, back.thread.boxTop] });
    }
  } catch (e) {
    console.error('[test] ' + (e && e.stack || e));
    process.exit(1);
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome.kill(); } catch {}
    try { srv.close(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
