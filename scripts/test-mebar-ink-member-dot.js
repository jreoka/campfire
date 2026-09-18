// Two reports about the sidebar's bottom-left corner, both fixed in CSS only:
//
//   1. "on light mode the buttons arent visible on the me bar."
//      The me bar paints a member's sidebar banner as a photo under a flat 45%
//      black scrim, and the light theme's own text fixes already keep the NAME and
//      the STATUS line white on it — but the bar's icon buttons (mute / deafen /
//      settings) are borderless glyphs whose colour IS their only chrome, and
//      `[data-theme="light"] .me-icobtn{color:var(--text)}` painted them the light
//      theme's near-black. MEASURED in the browser, on a scrimmed banner: the name
//      read rgb(255,255,255) while the icons read rgb(20,26,38) — a contrast ratio
//      of ~1.1:1, i.e. not there. They wear the name's white over a banner now.
//
//   2. "on the member bar the status light on all themes is too close to the bottom
//      of the member slot. can you adjust that without making the member slot
//      thicker at all"
//      A member slot is 38.2px (a 28px avatar inside .32rem of padding) and the
//      presence dot hung -3px below the avatar, so the disc had 2.1px to the slot's
//      own bottom edge — LESS than the dot's own 2.5px halo, which therefore bled
//      out of the slot into the row gap. At -1px the disc still overhangs the avatar
//      (it stays a corner badge) and the halo ends 1.6px inside the slot. The slot
//      is not one pixel thicker: the dot is absolutely positioned, so it is not in
//      the layout at all — which the browser half proves by measuring the slot with
//      the dot and with the dot hidden and requiring the two to be identical.
//
// [A] reads the rules out of styles.css (scoping, the numbers, and that the slot's
//     own geometry was NOT touched to buy the fix).
// [B] renders the REAL memberRowEl / dotHTML / paintSidebarBanner (sliced out of
//     servers.js) into the REAL #member-list and #me-card with the REAL styles.css,
//     and measures both fixes in a real browser, in every theme.
//
// Chrome/Edge needed for [B]; skips (exit 0) without it. Usage:
//   node scripts/test-mebar-ink-member-dot.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// Node's own WebSocket client: this test has to run in a checkout with no
// node_modules (the CDP socket is all it needs from outside the stdlib).
const WS = globalThis.WebSocket;

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9367', 10);
const REM = 16; // the root font size the rem values below are authored against
const DESKTOP = { w: 1200, h: 820 };
const PHONE = { w: 390, h: 780 };

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
const servers = fs.readFileSync(path.join(ROOT, 'public/js/servers.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

function sliceFn(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not slice "' + from + '"'); process.exit(1); }
  return src.slice(a, b);
}
// The REAL painters and the REAL row builder — a class rename or a template change
// in servers.js has to fail here rather than pass against a hand-copied mock.
const DOT_HTML = sliceFn(servers, 'function dotHTML(uid, dot) {', "// ---------- the chat header's leading glyph ----------");
const PAINT_BANNER = sliceFn(servers, 'function paintSidebarBanner(el, url, base, opts) {', "// ---------- the me bar's sub-line");
const MEMBER_ROW = sliceFn(servers, 'function memberRowEl(m) {', 'function memberSort(a, b) {');

// The slot's own geometry, read out of the stylesheet — never hardcoded, and the
// thing the fix is forbidden from touching.
function cssNum(re, what) {
  const m = css.match(re);
  if (!m) { console.error('[test] could not read ' + what + ' out of styles.css'); process.exit(1); }
  return parseFloat(m[1]) * REM;
}
function cssPx(re, what) {
  const m = css.match(re);
  if (!m) { console.error('[test] could not read ' + what + ' out of styles.css'); process.exit(1); }
  return parseFloat(m[1]);
}
const MEMBER_PAD_Y = cssNum(/\.member\{[^}]*padding:([\d.]+)rem/, "the member slot's own padding");
const AVATAR = cssPx(/\.member \.avwrap\{position:relative;width:([\d.]+)px/, 'the member avatar slot');
const DOT = cssPx(/\.member \.avwrap \.status-dot,\.dmrow \.avwrap \.status-dot\{position:absolute;bottom:(-?[\d.]+)px/, 'the presence dot offset');
const HALO = cssPx(/\.member \.avwrap \.status-dot,\.dmrow \.avwrap \.status-dot\{[^}]*box-shadow:0 0 0 ([\d.]+)px/, 'the presence dot halo');
const SLOT_H = AVATAR + MEMBER_PAD_Y * 2;
const OVERHANG = -DOT; // how far the disc hangs below the avatar

// The banner the browser half paints, and the scrim paintSidebarBanner lays over it.
const BANNER_FILL = '#1d3b22';
const BANNER_IMG = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="48"><rect width="240" height="48" fill="' + BANNER_FILL + '"/></svg>'
).toString('base64');
const SCRIM = (() => {
  const m = /const scrim = 'linear-gradient\(rgba\((\d+),(\d+),(\d+),([\d.]+)\),rgba\(/.exec(servers);
  if (!m) { console.error('[test] could not read the banner scrim out of servers.js'); process.exit(1); }
  return { rgb: [+m[1], +m[2], +m[3]], a: parseFloat(m[4]) };
})();

function hexRGB(hex) { return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); }
function over(fg, bg, a) { return fg.map((c, i) => a * c + (1 - a) * bg[i]); }
function relLum(rgb) {
  const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) { const l1 = relLum(a), l2 = relLum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
const SCRIMMED_BANNER = over(SCRIM.rgb, hexRGB(BANNER_FILL), SCRIM.a);

function findChrome() {
  const c = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return c.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

// The me-card markup, VERBATIM from index.html (a shell change has to be measured,
// not a copy of last week's shell).
const ME_CARD = (() => {
  const a = html.indexOf('<div id="me-card">');
  const b = html.indexOf('</div>', html.indexOf('id="btn-settings-me"'));
  if (a < 0 || b < 0) { console.error('[test] could not slice #me-card out of index.html'); process.exit(1); }
  return html.slice(a, b + 6);
})();

// ---------- [A] the rules ----------
function ruleChecks() {
  console.log('\n[A] the rules, and what they were scoped to');

  // 1. the me bar's icons over a banner
  const ink = /\[data-theme="light"\] #me-card\.has-banner \.me-icobtn[^{]*\{color:#fff\}/.exec(css);
  check(!!ink, 'the light theme keeps a has-banner me bar\'s icon buttons white, like its name and status line');
  check(/\[data-theme="light"\] #me-card\.has-banner \.gbadge/.test(ink ? ink[0] : ''),
    '…taking the game badge beside the name with them (same ink, same bar)');
  check(/\[data-theme="light"\] \.me-icobtn\{color:var\(--text\)\}/.test(css),
    'and the plain light-theme rule still darkens them for a --panel-2 bar (the fix is not a blanket white)');
  check(!/\[data-theme="light"\] \.me-icobtn\{color:#fff/.test(css),
    'which is why the override is scoped to #me-card.has-banner rather than the button class');
  // The hover tint has to live with the other hover rules (hover-only: a touch
  // screen leaves a synthetic :hover behind). Found by brace-matching every
  // `@media (hover:hover)` block rather than by trusting the first one in the file.
  const HOVER_RULE = /\[data-theme="light"\] #me-card\.has-banner \.me-icobtn:hover\{background:rgba\(255,255,255,\.16\)\}/;
  const rule = HOVER_RULE.exec(css);
  const hoverSpans = [];
  for (let at = css.indexOf('@media (hover:hover){'); at >= 0; at = css.indexOf('@media (hover:hover){', at + 1)) {
    let i = css.indexOf('{', at), depth = 0, end = -1;
    for (; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) { end = i; break; }
    }
    hoverSpans.push([at, end]);
  }
  check(!!rule && hoverSpans.some(([a, b]) => rule.index > a && rule.index < b),
    'and over a banner the hover tint is light in the light theme too, inside a hover-only block',
    { blocks: hoverSpans.length });

  // 2. the presence light in the slot
  check(DOT === -1, 'the presence light hangs 1px under the avatar, not the old -3px', { bottom: DOT });
  check(HALO === 2.5, 'the halo is still the 2.5px ring that keeps the light legible over a busy avatar', { halo: HALO });
  check(OVERHANG < HALO, 'so the ring now ends INSIDE the slot (the old overhang was 3px against a 2.5px halo — it bled out of the slot)',
    { overhang: OVERHANG, halo: HALO });
  check(MEMBER_PAD_Y === 0.32 * REM && AVATAR === 28,
    'and the slot\'s own geometry is untouched: the avatar and the .32rem padding that make its height',
    { padY: MEMBER_PAD_Y, avatar: AVATAR, slot: SLOT_H });
}

// ---------- [B] the layout ----------
const STUBS = `
  var S = { me: { id: 'me' } };
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];});}
  function onMobileNow(){ return false; }
  function statusOf(){ return 'online'; }
  function isOff(){ return false; }
  function dotOf(){ return 'online'; }
  function nameStyleFor(){ return ''; }
  function tagHTML(){ return ''; }
  function gameBadgeHTML(g){ return '<span class="gbadge" data-game="'+g+'">G</span>'; }
  function paintAvatar(el){ el.style.background='#b98d8d'; el.textContent='C'; }
  function paintGameBadge(){}
  function paintMemberStoryRing(){}
`;
const BUILD = `
  var BANNER = __BANNER__;
  var ml = document.getElementById('member-list');
  ['Cross','Ash','Rowan'].forEach(function (n, i) {
    ml.appendChild(memberRowEl({ id: 'u' + i, display_name: n, playing_game: i === 1 ? 'Deep Rock' : null }));
  });
  // The DM list wears the same .avwrap/.status-dot pair through the same rule, so
  // one of these rows is re-classed into a .dmrow to measure that other selector.
  var dm = memberRowEl({ id: 'd0', display_name: 'A DM row' });
  dm.className = 'dmrow';
  document.getElementById('dm-list').appendChild(dm);
  var last = ml.querySelectorAll('.member')[1];
  paintSidebarBanner(last, BANNER, 'var(--panel)');
  last.classList.add('has-banner');
  var card = document.getElementById('me-card');
  paintSidebarBanner(card, BANNER, 'var(--panel-2)', { ramp: false });
  card.classList.add('has-banner');
  document.getElementById('me-name').textContent = 'Cross';
  document.getElementById('me-sub').textContent = 'Online';
  document.getElementById('me-sub').style.display = '';
  window.__bannerPainted = /url\\(/.test(card.style.backgroundImage) && /rgba\\(0, 0, 0, 0\\.45\\)/.test(card.style.backgroundImage);
`;

const PROBE = `(() => {
  function rect(n){ var b = n.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height }; }
  function rgb(s){ var m = /rgba?\\((\\d+), ?(\\d+), ?(\\d+)/.exec(s); return m ? [+m[1], +m[2], +m[3]] : null; }
  function shadowSpread(s){ var m = /0px 0px 0px ([\\d.]+)px/.exec(s); return m ? parseFloat(m[1]) : null; }
  function slots(sel) {
    var out = [];
    document.querySelectorAll(sel).forEach(function (row) {
      var av = row.querySelector('.avwrap'), dot = row.querySelector('.status-dot');
      var rb = rect(row), ab = rect(av), db = rect(dot);
      var cs = getComputedStyle(row), ds = getComputedStyle(dot);
      out.push({ banner: row.classList.contains('has-banner'),
        twoLine: !!row.querySelector('.mstatus'),
        slotH: rb.height, padBot: cs.paddingBottom, slotBottom: rb.bottom,
        avatarBottom: ab.bottom, avatarH: ab.height,
        dotTop: db.top, dotBottom: db.bottom, dotH: db.height,
        discGap: rb.bottom - db.bottom, haloGap: (rb.bottom - db.bottom) - (shadowSpread(ds.boxShadow) || 0),
        overhang: db.bottom - ab.bottom, theme: document.documentElement.dataset.theme || 'dark' });
    });
    return out;
  }
  var out = { themes: {} };
  ['light', 'dark', 'oled'].forEach(function (theme) {
    document.documentElement.dataset.theme = theme;
    void document.body.offsetHeight;
    var member = slots('#member-list .member');
    var dm = slots('#dm-list .dmrow');
    // The dot is absolutely positioned, so hiding it must not move the slot by a
    // single pixel — the direct proof that the fix cannot have thickened anything.
    var dots = document.querySelectorAll('#member-list .status-dot');
    dots.forEach(function (d) { d.style.display = 'none'; });
    void document.body.offsetHeight;
    var noDot = slots('#member-list .member');
    dots.forEach(function (d) { d.style.display = ''; });
    void document.body.offsetHeight;
    var card = document.getElementById('me-card');
    var icons = [].slice.call(card.querySelectorAll('.me-icobtn')).map(function (b) {
      return { id: b.id, color: rgb(getComputedStyle(b).color), cls: b.className };
    });
    out.themes[theme] = { member: member, dm: dm, noDot: noDot,
      barName: rgb(getComputedStyle(document.getElementById('me-name')).color),
      onBanner: card.classList.contains('has-banner'),
      barBg: getComputedStyle(card).backgroundColor,
      icons: icons };
  });
  // …and the same bar with no banner at all: the light theme's ordinary bar.
  var card = document.getElementById('me-card');
  var saved = card.style.backgroundImage;
  card.classList.remove('has-banner');
  card.style.backgroundImage = '';
  document.documentElement.dataset.theme = 'light';
  void document.body.offsetHeight;
  out.plainLight = { icons: [].slice.call(card.querySelectorAll('.me-icobtn')).map(function (b) { return { id: b.id, color: rgb(getComputedStyle(b).color) }; }),
    barBg: getComputedStyle(card).backgroundColor };
  card.classList.add('has-banner');
  card.style.backgroundImage = saved;
  return out;
})()`;

function pageHtml() {
  return '<!doctype html><html data-theme="dark"><head><meta charset="utf-8">'
    + '<link rel="stylesheet" href="/styles.css">'
    + '<style>:root{--rail-w:0px}body{margin:0;background:var(--bg);font-family:system-ui,sans-serif}'
    // The shell animates theme changes (background-color/color transitions), so a
    // computed style read the instant after a theme flip is a value MID-TRANSITION.
    // The app's own transitions are not what this test is about.
    + '*{transition:none!important;animation:none!important}'
    + '#members{height:420px}#dm-list{width:244px;background:var(--panel);padding:.4rem .55rem}</style></head>'
    + '<body><div id="members"><div id="member-list"></div></div>'
    + '<div id="dm-list"></div>'
    + ME_CARD
    + '<script>' + STUBS + DOT_HTML + PAINT_BANNER + MEMBER_ROW
    + BUILD.replace('__BANNER__', JSON.stringify(BANNER_IMG))
    + '</script></body></html>';
}

async function layoutChecks() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-mebar-dot-'));
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/styles.css')) { res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' }); res.end(css); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(pageHtml());
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
    ws = new WS(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    let id = 0; const pending = new Map();
    const pageErrors = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
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
    await sleep(600);

    if (pageErrors.length) {
      console.error('[test] the probe page threw:\n  ' + pageErrors.join('\n  '));
      process.exit(1);
    }
    const painted = await ev('window.__bannerPainted === true && document.querySelectorAll("#member-list .member").length');
    check(painted === 3, 'the real memberRowEl + paintSidebarBanner built the fixture (3 rows, banner painted)', { painted });
    await ev(PROBE); // warm the layout once before measuring

    console.log('\n[B1] the member slot: the light is not jammed against its bottom');
    for (const [label, vp] of [['desktop', DESKTOP], ['phone', PHONE]]) {
      await sess('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: label === 'phone' });
      const m = await ev(PROBE);
      for (const theme of ['light', 'dark', 'oled']) {
        const t = m.themes[theme];
        const where = label + ' ' + theme;
        const rows = t.member;
        check(rows.length === 3 && rows.every((r) => r.dotH > 0),
          where + ': every member row carries its presence light', { rows: rows.length });
        // A row showing "Playing X" is a line taller than the avatar — that is the
        // status line's own height, not the dot's, and it is why the arithmetic
        // below is asked of the single-line rows only.
        const oneLine = rows.filter((r) => !r.twoLine);
        check(oneLine.length === 2 && oneLine.every((r) => near(r.slotH, SLOT_H, 0.2)),
          where + ': the slot is still exactly the avatar + its own .32rem padding (' + SLOT_H.toFixed(2) + 'px) — it did not get thicker',
          { slotH: rows.map((r) => Math.round(r.slotH * 100) / 100) });
        check(rows.every((r, i) => near(r.slotH, t.noDot[i].slotH, 0.01)),
          where + ': and hiding the dot does not move the slot by a pixel (an absolutely positioned dot is not in the layout)',
          { with: rows[0].slotH, without: t.noDot[0].slotH });
        check(rows.every((r) => r.discGap >= 4),
          where + ': the disc clears the slot\'s bottom edge by ~4px (was 2.1px — the report)',
          { discGap: rows.map((r) => Math.round(r.discGap * 100) / 100) });
        check(rows.every((r) => r.haloGap > 0),
          where + ': and the 2.5px halo now ends INSIDE the slot (was 0.4px outside it)',
          { haloGap: rows.map((r) => Math.round(r.haloGap * 100) / 100) });
        check(rows.every((r) => r.overhang > 0),
          where + ': while the disc still overhangs the avatar, so it is still a corner badge and not a dot floating inside it',
          { overhang: rows.map((r) => Math.round(r.overhang * 100) / 100) });
        // The rule is shared, so the DM rows must land on the same numbers.
        check(t.dm.length === 1 && t.dm.every((r) => near(r.discGap, rows[0].discGap, 0.01) && r.haloGap > 0),
          where + ': the DM rows (same rule, same 28px avatar) sit identically', { dm: t.dm.map((r) => Math.round(r.discGap * 100) / 100) });
      }
    }

    console.log('\n[B2] the me bar\'s icons over a banner');
    // Back to a desktop shell: the phone pass left a 390px emulation override on.
    await sess('Emulation.setDeviceMetricsOverride', { width: DESKTOP.w, height: DESKTOP.h, deviceScaleFactor: 1, mobile: false });
    const bar = await ev(PROBE);
    for (const theme of ['light', 'dark', 'oled']) {
      const t = bar.themes[theme];
      check(t.onBanner === true && t.icons.length === 3,
        theme + ': the bar wears a banner and all three icon buttons rendered', { onBanner: t.onBanner, icons: t.icons.length });
      const white = t.icons.every((i) => i.color.join(',') === '255,255,255');
      if (theme === 'light') {
        check(white, 'light: mute / deafen / settings are the name\'s white on the banner (was rgb(20,26,38) — invisible)', { icons: t.icons });
        check(t.barName.join(',') === '255,255,255', 'light: …the same ink the name already had, so the row reads as one bar', { name: t.barName });
        const ratios = t.icons.map((i) => Math.round(contrast(i.color, SCRIMMED_BANNER) * 10) / 10);
        check(ratios.every((r) => r >= 4.5),
          'light: every icon clears WCAG AA on the scrimmed banner (' + SCRIMMED_BANNER.map((v) => Math.round(v)).join(',') + ')', { ratios });
        const oldInk = bar.plainLight.icons[0].color;
        check(contrast(oldInk, SCRIMMED_BANNER) < 2,
          '…where the ink the light theme used to paint them with is unreadable there — the reported bug, reproduced',
          { ink: oldInk, ratio: Math.round(contrast(oldInk, SCRIMMED_BANNER) * 100) / 100 });
      } else {
        check(white, theme + ': white, unchanged — the bar is dark in every theme over a banner', { icons: t.icons });
      }
    }
    // Scoped, not a blanket: an ordinary light-theme bar keeps its dark icons — they
    // sit on --panel-2, where white would be the invisible ink instead. The surface
    // is the browser's own resolved background, not a guessed hex.
    const plain = bar.plainLight.icons.map((i) => i.color);
    const plainBg = (bar.plainLight.barBg.match(/\d+/g) || []).slice(0, 3).map(Number);
    const plainRatios = plain.map((c) => Math.round(contrast(c, plainBg) * 10) / 10);
    check(plainBg.length === 3 && plain.every((c) => c.join(',') !== '255,255,255' && contrast(c, plainBg) >= 4.5),
      'an ordinary light-theme bar (no banner) keeps the dark ink the theme paints for its own surface',
      { icons: plain, barBg: bar.plainLight.barBg, ratios: plainRatios });
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
