// The composer's + on a touch device (see AGENTS.md verification conventions).
//
// The complaint: on an iPad, the + that opens attach / emoji / GIF / voice sat
// at the RIGHT end of the message box, next to the GIF key, instead of in the
// field's left gutter where it lives on a desktop.
//
// The cause was a cascade collision, not a layout one. `#btn-plus` is pinned
// into the gutter by `position:absolute;left:.4rem;bottom:9.6px` — but the
// coarse-pointer tap-target block at the bottom of the sheet listed it with the
// in-flow controls (`#btn-plus,#btn-more{position:relative}`), which overrode
// `absolute` by source order. The + stopped being pinned, rejoined the composer
// row's own flow and settled at its right end, in the gap before the send key.
//
// It survived every browser test because **an unemulated headless Chrome
// reports `pointer:fine`**: `--dump-dom` cannot enter `pointer:coarse` (the file
// says so above its own hit-box assertions), so nothing in this suite had ever
// executed that block. The geometry checks below therefore drive Chrome over
// CDP with `Emulation.setTouchEmulationEnabled` — the only way to compile a
// coarse-pointer media query for real — and assert BOTH halves: the + stays in
// the gutter, and its invisible ::after thumb target is still a real 44px box
// centred on it (the reason the `position:relative` was there in the first
// place: an absolutely positioned box is already a containing block for its own
// ::after, so the hit box needs no `position:relative` at all).
//
// Usage: node scripts/test-composer-touch-plus.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }

const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const composerMarkup = index.slice(index.indexOf('<form id="composer">'), index.indexOf('<!-- members -->'));

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

// The rule body of `#btn-plus` in the coarse-pointer block (the one that broke),
// so the source check reads the same bytes the browser compiles.
function coarseBlock() {
  const i = css.indexOf('@media (pointer:coarse){');
  if (i < 0) return '';
  // the tap-target block is the one carrying --tap
  const j = css.indexOf('width:var(--tap)', i);
  const end = css.indexOf('\n}', j);
  return css.slice(i, end < 0 ? css.length : end);
}

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>#chat{display:flex;flex-direction:column;height:100vh}</style></head><body>
<main id="chat">${composerMarkup}</main>
<script>
setTimeout(function () {
  const leadEl = document.querySelector('#btn-plus').offsetWidth ? document.querySelector('#btn-plus') : document.querySelector('#btn-more');
  const b = (el) => { const r = el.getBoundingClientRect(); return { t:+r.top.toFixed(1), l:+r.left.toFixed(1), w:+r.width.toFixed(1), h:+r.height.toFixed(1), r:+r.right.toFixed(1), b:+r.bottom.toFixed(1) }; };
  const af = getComputedStyle(leadEl, '::after');
  const ab = leadEl.getBoundingClientRect();
  const aw = parseFloat(af.width) || 0, ah = parseFloat(af.height) || 0;
  const cx = ab.left + ab.width / 2, cy = ab.top + ab.height / 2;
  document.title = JSON.stringify({
    coarse: matchMedia('(pointer:coarse)').matches,
    vw: innerWidth,
    lead: b(leadEl),
    leadIs: leadEl.id,
    field: b(document.querySelector('#in-render')),
    send: b(document.querySelector('#composer .send-btn')),
    tools: b(document.querySelector('#composer-tools')),
    position: getComputedStyle(leadEl).position,
    hit: { w: aw, h: ah, cx: +cx.toFixed(1), cy: +cy.toFixed(1) },
    tap: getComputedStyle(document.documentElement).getPropertyValue('--tap').trim(),
  });
}, 300);
</script></body></html>`;
}

function probeNonTouch(chrome, url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-touch-'));
  try {
    const r = spawnSync(chrome, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=1200,820',
      '--virtual-time-budget=2000', '--dump-dom', url,
    ], { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
    if (!m) throw new Error('no title (chrome status ' + r.status + ')');
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}

// Chrome over CDP with touch emulation — the ONLY way a headless browser
// compiles `@media (pointer:coarse)`. Returns one report per viewport.
async function probeTouch(chrome, url, sizes) {
  let WebSocket;
  try { WebSocket = require('ws'); } catch { skip('ws is not installed (npm install)'); }
  const port = 9300 + (process.pid % 400);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-touch-cdp-'));
  const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + port, '--user-data-dir=' + path.join(dir, 'prof'), 'about:blank',
  ], { stdio: 'ignore' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  try {
    let wsUrl = null;
    for (let i = 0; i < 60 && !wsUrl; i++) {
      await sleep(200);
      try { const r = await fetch('http://127.0.0.1:' + port + '/json/version'); wsUrl = (await r.json()).webSocketDebuggerUrl; } catch {}
    }
    if (!wsUrl) skip('Chrome never opened a debugging port');
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0;
    const pending = new Map();
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const send = (method, params, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {}, sessionId })); });
    const { result: target } = await send('Target.createTarget', { url: 'about:blank' });
    const { result: attached } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const sid = attached.sessionId;
    await send('Page.enable', {}, sid);
    await send('Runtime.enable', {}, sid);
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sid);
    for (const size of sizes) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: size.w, height: size.h, deviceScaleFactor: 2, mobile: true, screenWidth: size.w, screenHeight: size.h,
      }, sid);
      await send('Page.navigate', { url }, sid);
      await sleep(900);
      const ev = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sid);
      const raw = ((ev.result || {}).result || {}).value;
      if (!raw) throw new Error('no report at ' + size.name);
      out.push({ name: size.name, ...JSON.parse(raw) });
    }
    ws.close();
  } finally {
    try { child.kill(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  return out;
}

async function main() {
  console.log('\n[1] the + is pinned by the base rule, and the coarse block leaves it alone');
  const base = /\n#btn-plus\{([^}]*)\}/.exec(css);
  check(!!base && /position:absolute/.test(base[1]), 'the base rule pins the + with position:absolute', base && base[1].slice(0, 80));
  check(!!base && /left:\.4rem/.test(base[1]), 'and into the field\'s left gutter (left:.4rem)', base && base[1].slice(0, 80));
  const block = coarseBlock();
  check(/#btn-plus::after,#btn-more::after\{/.test(block), 'the coarse block still grows the + a thumb target', block.slice(0, 60));
  check(!/#btn-plus\b[^{]*\{[^}]*position:relative/.test(block),
    'and no longer repositions it — `position:relative` here is what put the + at the right end of the box',
    (/#btn-plus[^{]*\{[^}]*\}/.exec(block) || [''])[0]);
  check(/#btn-more\{display:inline-flex/.test(css) && /#btn-more\{display:none\}/.test(css),
    'the phone still swaps the two (the desktop + menu and the phone + menu are one rule each)');

  const chrome = findChrome();
  if (!chrome) return skip('no Chrome/Edge found (set CHROME_PATH)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-touch-html-'));
  const htmlPath = path.join(dir, 'page.html');
  fs.writeFileSync(htmlPath, pageHtml());
  const url = 'file:///' + htmlPath.replace(/\\/g, '/');

  try {
    console.log('\n[2] a fine-pointer (desktop) browser is the control case');
    const desk = probeNonTouch(chrome, url);
    check(desk.coarse === false, 'an unemulated headless Chrome is a fine pointer (this is why the bug hid)', desk.coarse);
    check(desk.position === 'absolute', 'the reported + is the absolutely positioned one', desk.position);
    check(desk.leadIs === 'btn-plus', 'and it is #btn-plus on the desktop', desk.leadIs);
    check(desk.lead.l - desk.field.l > 0 && desk.lead.l - desk.field.l < 12,
      'the + sits in the field\'s left gutter', { plusLeft: desk.lead.l, fieldLeft: desk.field.l });

    console.log('\n[3] under real touch emulation (pointer:coarse) the + stays in the gutter');
    const reps = await probeTouch(chrome, url, [
      { name: 'ipad-landscape', w: 1180, h: 820 },
      { name: 'ipad-portrait', w: 820, h: 1180 },
      { name: 'ipad-mini', w: 1024, h: 768 },
    ]);
    for (const r of reps) {
      const tag = r.name + ': ';
      check(r.coarse === true, tag + 'the viewport compiled as a coarse pointer', r.coarse);
      check(r.position === 'absolute', tag + 'the + is still position:absolute (not dropped into the row\'s flow)', r.position);
      const inset = +(r.lead.l - r.field.l).toFixed(1);
      check(inset > 0 && inset < 12, tag + 'the + sits inside the field\'s LEFT gutter', { inset, plus: r.lead, field: r.field });
      check(r.lead.l < r.field.l + r.field.w / 2,
        tag + 'the + is left of the field\'s midpoint (it used to land in the right gutter, before the send key)',
        { plusLeft: r.lead.l, mid: +(r.field.l + r.field.w / 2).toFixed(1) });
      check(r.lead.b > r.field.t && r.lead.t < r.field.b,
        tag + 'and vertically inside the field', { plus: r.lead, field: r.field });
      check(r.lead.r < r.tools.l && r.tools.w > 0,
        tag + 'nothing overlaps: the + ends before the tool rail begins', { plusRight: r.lead.r, toolsLeft: r.tools.l });
      // The hit box is the whole reason the broken rule existed — it must survive.
      check(r.tap === '44px' && r.hit.w === 44 && r.hit.h === 44,
        tag + 'its ::after thumb target is still a real 44px box', { tap: r.tap, hit: r.hit });
      check(Math.abs(r.hit.cx - (r.lead.l + r.lead.w / 2)) < 0.6 && Math.abs(r.hit.cy - (r.lead.t + r.lead.h / 2)) < 0.6,
        tag + 'centred on the + (an abspos box is its own containing block for ::after)',
        { hitCentre: [r.hit.cx, r.hit.cy], plusCentre: [+(r.lead.l + r.lead.w / 2).toFixed(1), +(r.lead.t + r.lead.h / 2).toFixed(1)] });
    }
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exit(1); });
