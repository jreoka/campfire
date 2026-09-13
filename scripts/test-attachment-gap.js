// The attachment strip's distance from the message box.
//
// Reported: with an upload card on screen, and again with the finished
// attachment chip, both cards sat "quite far" above the composer. The cause is
// the always-reserved typing strip (#typing-bar, --strip-h) that lives between
// them and #composer — #messages gave up its bottom padding for it, so it is
// load-bearing and cannot simply be dropped. The fix is targeted: while either
// card list is on screen, #composer pays the strip's height back as a negative
// top padding, so the cards come down to the field, while the strip keeps its
// exact height and nothing below the cards moves.
//
// Two halves:
//   [A] headless Chrome — builds the REAL chat column (index.html's markup +
//       the real styles.css) and MEASURES the gap between the cards and the
//       input pill, at a desktop and a phone viewport, with and without the
//       cards on screen, plus the strip's unchanged height.
//   [B] static — the rule must out-cascade the `#composer{padding:…}` shorthand
//       (specificity 1,1,0 beats the media-query 1,0,0 regardless of source
//       order) and the card lists must really be siblings of the composer.
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

function pageHtml() {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<link rel="stylesheet" href="/styles.css">'
    + '<style>body{margin:0;height:100vh}</style></head><body>'
    + '<div id="chat"><div id="messages"></div>' + columnMarkup() + '</div>'
    + '</body></html>';
}

// Injected as ONE expression so nothing can depend on page timing: paint a
// stage, then read the geometry back.
const PROBE = `(() => {
  var ap = document.getElementById('attach-preview');
  var ul = document.getElementById('upload-list');
  var el = window.__stage || 'none';
  ap.className = 'hidden'; ul.className = 'hidden';
  ap.innerHTML = ''; ul.innerHTML = '';
  if (el === 'chip' || el === 'both') {
    ap.className = '';
    ap.innerHTML = '<div class="att-chip" id="t-chip"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt=""><span>HSD4VkcbAAAvP4x.jpg</span><button class="mini">Spoiler</button><button class="mini">x</button></div>';
  }
  if (el === 'both') {
    ul.className = '';
    ul.innerHTML = '<div class="up-card" id="t-card"><div class="up-ic"></div><div class="up-body"><div class="up-top"><span class="up-name">x.jpg</span><span class="up-pct"></span></div><div class="up-track"><div class="up-fill" style="width:80%"></div></div><div class="up-sub">132.0 KB &middot; Uploading&hellip;</div></div></div>';
  }
  var chip = document.getElementById('t-chip') || document.getElementById('t-card');
  var box = document.getElementById('composer-box') || document.getElementById('composer');
  var strip = document.getElementById('typing-bar');
  var comp = document.getElementById('composer');
  var cb = chip ? chip.getBoundingClientRect() : null;
  var bb = box ? box.getBoundingClientRect() : null;
  return {
    stage: el,
    chipBottom: cb ? Math.round(cb.bottom) : null,
    chipH: cb ? Math.round(cb.height) : null,
    chipW: cb ? Math.round(cb.width) : null,
    boxTop: bb ? Math.round(bb.top) : null,
    gap: cb && bb ? Math.round(bb.top - cb.bottom) : null,
    stripH: strip ? Math.round(strip.getBoundingClientRect().height) : null,
    compTop: comp ? Math.round(comp.getBoundingClientRect().top) : null,
    compPadTop: comp ? getComputedStyle(comp).paddingTop : null,
  };
})()`;

async function main() {
  console.log('\n[A] the markup and the rule line up');
  const order = ['id="attach-preview"', 'id="upload-list"', 'id="typing-bar"', '<form id="composer">']
    .map((needle) => html.indexOf(needle));
  check(order.every((i) => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]),
    'attach-preview → upload-list → typing-bar → composer, in that order', order);
  check(/#chat:has\(#attach-preview:not\(\.hidden\)\) #composer,#chat:has\(#upload-list:not\(\.hidden\)\) #composer\{padding-top:\.25rem\}/.test(css),
    'the composer shrinks its top padding only while a card list is on screen');
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
    const built = await ev('JSON.stringify({comp:!!document.getElementById("composer"),box:!!document.getElementById("composer-box"),strip:!!document.getElementById("typing-bar")})');
    if (!/true/.test(built)) {
      console.error('[test] the chat column did not build: ' + built);
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
      check(none.compPadTop === '14.4px',
        label + ': with no cards, the composer keeps its normal .9rem top padding', none);
      check(none.boxTop !== null && none.gap === null,
        label + ': and the input pill has no card to measure against', none);

      const chip = await measure('chip');
      check(chip.compPadTop === '4px',
        label + ': with a chip on screen it drops to .25rem (the strip still separates them)', chip);
      check(chip.gap !== null && chip.gap <= none.boxTop - 8,
        label + ': so the chip ends up markedly closer to the input pill',
        { withChip: chip.gap, baselineGap: none.boxTop });
      check(chip.stripH === none.stripH && chip.stripH > 0,
        label + ': the typing strip keeps its reserved height (nothing below the cards moves)',
        { withCards: chip.stripH, without: none.stripH });

      const both = await measure('both');
      check(both.gap !== none.gap && both.gap <= 130,
        label + ': an upload card above the chip stacks normally', both);
      check(both.stripH === none.stripH,
        label + ': and the strip still has not moved', both);
      check(chip.chipH >= 40 && chip.chipW > 150,
        label + ': the chip keeps its own thickness and width (the gap was not paid for by shrinking it)', chip);

      const back = await measure('none');
      check(back.gap === null && back.compPadTop === '14.4px' && back.boxTop === none.boxTop,
        label + ': clearing the cards restores the composer exactly as it was',
        { cleared: back.compPadTop, withChip: chip.compPadTop, boxTop: back.boxTop, baseline: none.boxTop });
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
