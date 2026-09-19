// The story composer's caption field and its camera choice.
//
// Two things the owner reported from the phone:
//
//   (1) "where it says add a caption, theres a scrollbar there even though there
//       doesnt need to be until the message gets very long." The field is one
//       line (rows=1) and grows with the text, and the growth ran
//       `height = min(scrollHeight, 88)`. `scrollHeight` EXCLUDES the border
//       while the height being set is border-box (`*{box-sizing:border-box}`),
//       so every measurement left the box 2px short of its own content — a
//       permanent 2px scroll range, drawn as a full-height scrollbar thumb in a
//       caption that had nothing to scroll. Worse, it stuck: the inline height
//       survived the value being cleared, so the empty field in the screenshot
//       still showed it. The fix adds the border back, keeps `overflow-y:hidden`
//       until the text really passes the cap, and re-derives the height on every
//       path that clears the caption or re-enters the preview step.
//
//   (2) "can the camera front back on mobile remember your last orientation" —
//       the composer opened on `facing:'user'` every single time. It now reads
//       `cf_story_facing` from localStorage (a DEVICE pref, like the other
//       `cf_*` ones) and the flip button is the only writer.
//
// Two halves, like scripts/test-attachment-gap.js:
//   [A] static — the rule, the wiring, and the two clear paths that must reset.
//   [B] headless Chrome — builds the REAL composer out of index.html with the
//       REAL stylesheet and the REAL storyCaptionGrow() taken out of stories.js,
//       and MEASURES the field's scroll range at a phone and a desktop viewport:
//       empty, short, cleared, wrapped, and long enough to be capped.
//   [C] the same page — the facing helpers round-trip through localStorage.
//
// Skips (exit 0) without Chrome. Usage: node scripts/test-story-composer.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9366', 10);
const PHONE = { w: 390, h: 780 };
const DESKTOP = { w: 1200, h: 800 };

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
const stories = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');

// Pull a top-level function out of stories.js by name, brace-matched, so the
// page under test runs the SHIPPED code rather than a copy of it that can drift.
function sliceFn(src, name) {
  const head = 'function ' + name + '(';
  const at = src.indexOf(head);
  if (at < 0) return null;
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  return null;
}
const captionFn = sliceFn(stories, 'storyCaptionGrow');
const facingFn = sliceFn(stories, 'storySavedFacing');
const facingSaveFn = sliceFn(stories, 'storySaveFacing');
const facingKey = /const STORY_FACING_KEY = '[^']*';/.exec(stories);

// The composer verbatim, with its own `hidden` (and the caption slot's) off so
// there is something to measure.
function composerMarkup() {
  const a = html.indexOf('<div id="story-compose"');
  const b = html.indexOf('\n<script src="/embeds.js">', a);
  return html.slice(a, html.lastIndexOf('</div>', b) + 6)
    .replace('<div id="story-compose" class="hidden"', '<div id="story-compose"')
    .replace('<div class="sc-edit hidden" id="sc-edit">', '<div class="sc-edit" id="sc-edit">');
}

function pageHtml() {
  return '<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<link rel="stylesheet" href="/styles.css">'
    + '<style>body{margin:0;background:#05070c}</style></head><body>'
    + composerMarkup()
    + '<script>' + [facingKey[0], captionFn, facingFn, facingSaveFn].join('\n') + '</script>'
    + '</body></html>';
}

// Read the field back. `range` is the whole point: scrollHeight - clientHeight is
// exactly the scroll range the browser is obliged to offer a scrollbar for.
const CAPTION_PROBE = `(function () {
  var el = document.getElementById('sc-caption');
  if (!el) return { missing: true };
  function snap(tag) {
    var cs = getComputedStyle(el);
    return {
      tag: tag,
      h: el.offsetHeight,
      client: el.clientHeight,
      scroll: el.scrollHeight,
      range: el.scrollHeight - el.clientHeight,
      overflowY: cs.overflowY,
      inlineHeight: el.style.height || '',
      value: el.value.length,
    };
  }
  el.style.height = ''; el.style.overflowY = ''; el.value = '';
  var out = { untouched: snap('untouched') };
  el.value = 'hi';
  storyCaptionGrow(el);
  out.short = snap('short');
  el.value = '';
  storyCaptionGrow(el);
  out.cleared = snap('cleared');
  el.value = 'y'.repeat(100);
  storyCaptionGrow(el);
  out.wrapped = snap('wrapped');
  el.value = 'x'.repeat(400);
  storyCaptionGrow(el);
  out.long = snap('long');
  el.value = '';
  storyCaptionGrow(el);
  out.reset = snap('reset');
  return out;
})()`;

const FACING_PROBE = `(function () {
  var out = {};
  var storage = window.localStorage;
  function wipe() { try { storage.removeItem('cf_story_facing'); } catch (e) {} }
  wipe();
  out.fresh = storySavedFacing();
  out.saved = storySaveFacing('environment');
  out.stored = storage.getItem('cf_story_facing');
  out.readBack = storySavedFacing();
  storySaveFacing('user');
  out.back = storySavedFacing();
  storage.setItem('cf_story_facing', 'sideways');
  out.garbage = storySavedFacing();
  wipe();
  return out;
})()`;

async function main() {
  console.log('\n[A] the field and the camera are wired to their fixes');
  const capRule = /#sc-caption\{([^}]*)\}/.exec(css);
  check(!!capRule && /overflow-y:hidden/.test(capRule[1]) && /max-height:88px/.test(capRule[1]),
    'the stylesheet gives the caption no scrollbar by default, under an 88px cap', capRule && capRule[1]);
  check(!/\$\('#sc-caption'\)\.addEventListener\('input', \(e\) => \{\s*\n\s*e\.target\.style\.height/.test(stories),
    'the old inline grow handler is gone');
  check(/\$\('#sc-caption'\)\.addEventListener\('input', \(e\) => storyCaptionGrow\(e\.target\)\)/.test(stories),
    'typing in the caption goes through the helper');
  check(!!captionFn, 'storyCaptionGrow() exists');
  check(!!captionFn && /parseFloat\(cs\.borderTopWidth\)/.test(captionFn) && /scrollHeight \+ border/.test(captionFn),
    'the helper measures content + BORDER (a border-box height set from scrollHeight alone is 2px short)');
  check(!!captionFn && /el\.style\.overflowY = full > max \? 'auto' : 'hidden'/.test(captionFn),
    'and its scrollbar is reserved for the one case it exists for: text past the cap');
  check(!!captionFn && /if \(el\.scrollHeight <= 0\)/.test(captionFn),
    'a field with no layout (the hidden caption slot) is handed back to the stylesheet, never shrunk to its border');
  const growCalls = (stories.match(/storyCaptionGrow\(/g) || []).length;
  check(growCalls >= 5, 'every path that owns the field calls it: input, preview step, both clears and the definition',
    { calls: growCalls });
  check(/\$\('#sc-caption'\)\.value = '';\s*\n\s*storyCaptionGrow\(\$\('#sc-caption'\)\);/.test(stories),
    'storyRetake() resets the caption height with the value it clears');
  check(/if \(cap\) \{ cap\.value = ''; storyCaptionGrow\(cap\); \}/.test(stories),
    'and so does closeStoryComposer(), so the next story opens on a clean one-line field');

  check(!!facingKey && facingKey[0].includes('cf_story_facing'),
    'the camera choice is a local pref (cf_story_facing), not account state');
  check(/facing: storySavedFacing\(\),/.test(stories),
    'the composer opens on the saved camera instead of a hardcoded front');
  check(/sc\.facing = storySaveFacing\(sc\.facing === 'user' \? 'environment' : 'user'\)/.test(stories),
    'and the flip button is the only writer');
  check(!!facingFn && !!facingSaveFn, 'both facing helpers exist');

  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-storycomposer-'));
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
    '--window-size=' + PHONE.w + ',' + PHONE.h, 'about:blank'], { stdio: 'ignore' });

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
    await sleep(500);
    const built = await ev('JSON.stringify({compose:!!document.getElementById("story-compose"),edit:!!document.getElementById("sc-edit"),cap:!!document.getElementById("sc-caption"),fn:typeof storyCaptionGrow,facing:typeof storySavedFacing})');
    if (!/true/.test(built) || /false/.test(built)) {
      console.error('[test] the composer did not build: ' + built);
      process.exit(1);
    }

    console.log('\n[B] the caption has no scroll range until it has something to scroll');
    for (const [label, vp] of [['phone', PHONE], ['desktop', DESKTOP]]) {
      await sess('Emulation.setDeviceMetricsOverride', {
        width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: label === 'phone',
      });
      await sleep(150);
      const m = await ev(CAPTION_PROBE);
      if (!m || m.missing) { check(false, label + ': the caption field is on the page', m); continue; }
      const { untouched, short, cleared, wrapped, long, reset } = m;
      check(untouched.range === 0 && untouched.overflowY === 'hidden',
        label + ': an untouched caption has no scroll range at all', untouched);
      check(short.range === 0 && short.overflowY === 'hidden',
        label + ': a short caption still has none (the 2px border-box range is gone)', short);
      check(short.h === untouched.h, label + ': and it did not change height doing it',
        { untouched: untouched.h, short: short.h });
      check(cleared.range === 0 && cleared.overflowY === 'hidden' && cleared.h === untouched.h,
        label + ': clearing the caption takes the scrollbar away with it (this is what stuck in the screenshot)',
        cleared);
      check(wrapped.h > untouched.h && wrapped.range === 0,
        label + ': a wrapped line grows the field instead of scrolling it',
        { h: wrapped.h, untouched: untouched.h, scroll: wrapped.scroll });
      check(reset.range === 0 && reset.h === untouched.h,
        label + ': and after a very long one, an emptied field comes back to one line', reset);
      check(long.h <= 88 && long.h > untouched.h,
        label + ': only a caption past the cap stops growing', { h: long.h, untouched: untouched.h });
      check(long.range > 0 && long.overflowY === 'auto',
        label + ': and that is the one case that gets a scrollbar', long);
    }

    console.log('\n[C] the camera choice survives the composer');
    const f = await ev(FACING_PROBE);
    check(f.fresh === 'user', 'a device that has never flipped opens on the front camera', f);
    check(f.saved === 'environment' && f.stored === 'environment',
      'flipping to the back camera writes the pref', f);
    check(f.readBack === 'environment', 'and the next composer reads it back', f);
    check(f.back === 'user' && f.garbage === 'user',
      'flipping back is remembered too, and anything unreadable falls back to the front camera', f);
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
  if (failures.length) { for (const x of failures) console.log('  - ' + x); process.exit(1); }
}

main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
