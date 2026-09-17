// A group chat's header chip IS its settings button.
//
// The request, verbatim: "for group chats can you do something like this where
// clicking allows editing and the little logo" — with a mock of the group's name
// in a pill, a pencil beside it, and the tooltip "Edit group" under the pill.
//
// Group settings (name + description, PATCH /api/dms/:tid) already existed, but
// the ONLY way in was the DM row's right-click / long-press menu: nothing on
// screen said the group could be edited at all. So the open conversation's title
// became the control — one chip holding the group's glyph, its name and a pencil,
// opening the same editor, with the pencil saying what the click does.
//
// What this test is actually protecting:
//   - the chip is ONE box. Three adjacent backgrounds could not light up as the
//     single hover pill the mock shows, and the pencil has to be INSIDE the chip
//     or a 14px icon would be its own thumb target (the chip's phone rule grows
//     the box for the whole thing, exactly like the 1:1 DM's name).
//   - the pencil is visible at REST. A hover-only control does not exist on a
//     touch screen, and on a desktop an invisible one cannot be discovered.
//   - the header is in exactly one of two modes. A group's chip opens its settings
//     (this file); a 1:1 DM's name opens that person's card (ui.js, and
//     test-dm-head-avatar.js). paintHeaderNameTap / paintHeaderGroupEdit are set
//     together by paintDmHead, and every other header painter clears both — a
//     pencil left behind on a text channel would open a group editor for a group
//     that is not open.
//   - the group glyph: a group has no single face, so its slot wears the app's own
//     people mark at the 1:1 DM's 24px, and #chan-hash still has ONE writer, so a
//     face, a people mark and a '#' can never leak into each other.
//
// Static checks run everywhere; the browser half skips without Chrome.
//
// Usage: node scripts/test-group-head-edit.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { decodePNG } = require('./png-util.js');

const ROOT = path.join(__dirname, '..');
const WINDOW_H = 64;
const PANEL = [13, 18, 28];    // --panel    #0d121c  (the header surface)
const PANEL3 = [29, 37, 54];   // --panel-3  #1d2536  (the group glyph's circle)

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

const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const servers = fs.readFileSync(path.join(ROOT, 'public/js/servers.js'), 'utf8');
const home = fs.readFileSync(path.join(ROOT, 'public/js/home.js'), 'utf8');
const pins = fs.readFileSync(path.join(ROOT, 'public/js/pins.js'), 'utf8');
// The REAL code the header runs, sliced out of the shipped files so the browser
// half clicks the app's own handler and not a copy of it.
const avSrc = core.slice(core.indexOf('const AV_COLORS = ['), core.indexOf('// Webhook messages carry'));
const glyphSrc = servers.slice(servers.indexOf('function statusOf('), servers.indexOf('// ---------- game activity badge'));
const peerSrc = home.slice(home.indexOf('function dmPeer(t)'), home.indexOf('function openServerView()'));
// openGroupEdit … repaintDmHead: the editor, the two header-mode painters, the
// click wiring and paintDmHead itself.
const headSrc = home.slice(home.indexOf('// Group chat settings: name + description.'),
  home.indexOf('async function openGroupAdd(tid)'));
// The hover-only section of the stylesheet, so a rule can be asserted to be IN it.
// LAST occurrence: the file's own prose explains that convention and names the
// at-rule, so the first match is a sentence, not the block.
const hoverStart = css.lastIndexOf('@media (hover:hover){');
const hoverBlock = css.slice(hoverStart, css.indexOf('\n}', hoverStart));

function pageHtml(width, cssPath, withTitle) {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///${cssPath.replace(/\\/g, '/')}">
<style>html,body{margin:0;background:var(--bg)}</style></head>
<body class="dm-open"><main id="chat"><header id="chat-header">
  <button id="btn-menu" class="icon-btn">☰</button>
  <span id="chan-head"><span id="chan-hash">#</span><strong id="chan-name">general</strong><button id="btn-group-edit" type="button" class="hidden" aria-label="Edit group"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button></span>
  <span id="chan-topic" class="hidden"></span>
</header><input id="in-message"></main>
<script>
const $ = (s) => document.querySelector(s);
function deviceIsMobile() { return ${width} <= 700; }
function renderTopic() {}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
${avSrc}
${glyphSrc}
${peerSrc}
${headSrc}
// The editor's own modal, stubbed to record what it was asked to open: the real
// openModal only paints these two nodes, so what matters is the title and that the
// group's current name arrived prefilled.
const modals = [];
function openModal(title, body) { modals.push({ title, body }); }
const ME = { id: 'me', display_name: 'Me' };
const GROUP = { id: 't2', isGroup: true, name: 'Cross\\'s Group', description: 'weekend squad', members: [ME, { id: 'u2', display_name: 'Miicat_47' }] };
const DM = { id: 't1', isGroup: false, members: [ME, { id: 'u2', display_name: 'Miicat_47' }] };
const S = { me: ME, view: 'home', dmThreadId: 't2', dms: [GROUP, DM], online: {}, presenceAll: {}, presenceMobile: {} };
const chip = () => document.querySelector('#chan-head');
const glyph = () => document.querySelector('#chan-hash');
const pencil = () => document.querySelector('#btn-group-edit');
const header = () => document.querySelector('#chat-header');
const named = () => document.querySelector('#chan-name');
const box = (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: Math.round(r.width), h: Math.round(r.height), right: r.right, bottom: r.bottom, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
};
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const out = {};
// Everything runs after load: in headless Chrome the viewport is not laid out yet
// when the parser reaches this script, and a rect measured then can belong to a
// layout the screenshot never shows. The dumped title carries the state out.
function run() {
  // ---- the shipped path: paintDmHead() on a group ----
  paintDmHead(GROUP);
  {
    const g = box(glyph()), p = box(pencil());
    out.group = {
      name: named().textContent,
      headerText: header().textContent.replace(/\\s+/g, ' ').trim(),
      glyphClass: glyph().className,
      glyphSvg: !!glyph().querySelector('svg'),
      glyphBox: { w: g.w, h: g.h, cy: g.cy },
      nameCy: box(named()).cy,
      pencilDisplay: getComputedStyle(pencil()).display,
      pencilInsideChip: chip().contains(pencil()),
      // The chip holds glyph, name and pencil as one inline run, in that order.
      order: [...chip().children].map((el) => el.id || el.tagName.toLowerCase()),
      groupEdit: header().classList.contains('group-edit'),
      dmTap: header().classList.contains('dm-name-tap'),
      cursor: getComputedStyle(chip()).cursor,
      title: chip().title,
      chipPill: getComputedStyle(chip()).borderTopLeftRadius,
    };
  }

  // ---- clicking the chip opens the group editor (the whole point) ----
  modals.length = 0;
  click(named());
  out.clickName = { n: modals.length, title: modals[0] && modals[0].title, body: modals[0] && modals[0].body };
  modals.length = 0;
  click(pencil());
  out.clickPencil = { n: modals.length, title: modals[0] && modals[0].title };
  modals.length = 0;
  click(glyph());
  out.clickGlyph = { n: modals.length, title: modals[0] && modals[0].title };

  // ---- a 1:1 DM is the OTHER mode: its name reaches ui.js's card, never this ----
  S.dmThreadId = 't1';
  paintDmHead(DM);
  out.dm = {
    name: named().textContent,
    pencilDisplay: getComputedStyle(pencil()).display,
    groupEdit: header().classList.contains('group-edit'),
    dmTap: header().classList.contains('dm-name-tap'),
    title: chip().title,
    face: glyph().className,
    faceBox: { w: box(glyph()).w, h: box(glyph()).h },
  };
  modals.length = 0;
  click(named());
  out.dmClick = { n: modals.length };
  // ---- and a header with no open conversation ignores the chip entirely ----
  document.body.classList.remove('dm-open');
  click(named());
  out.closedClick = { n: modals.length };
  document.body.classList.add('dm-open');

  // ---- no leak: a channel clears glyph, pencil, tooltip and mode together ----
  paintChanGlyph('#');
  paintHeaderGroupEdit(false);
  out.clear = {
    text: glyph().textContent,
    cls: glyph().className,
    kids: glyph().childElementCount,
    pencilDisplay: getComputedStyle(pencil()).display,
    groupEdit: header().classList.contains('group-edit'),
    title: chip().title,
  };

  // ---- back to the group: the state the screenshot is sampled from ----
  S.dmThreadId = 't2';
  paintDmHead(GROUP);
  // The phone's grown thumb box is the chip's ::after, so its computed box is what
  // says how big the target is (see the loop: a squeezed headless layout makes
  // elementFromPoint useless here, and the box is a CSS box either way).
  const cb = box(chip());
  const af = getComputedStyle(chip(), '::after');
  out.thumb = { content: af.content, top: af.top, left: af.left, right: af.right, bottom: af.bottom, chipH: cb.h };
  out.final = { chip: cb, glyph: box(glyph()), pencil: box(pencil()), name: box(named()) };
}
window.addEventListener('load', () => setTimeout(() => {
  run();
  ${withTitle ? 'document.title = JSON.stringify(out);' : ''}
}, 0));
</script></body></html>`;
}

function measure(chrome, w, dpr, dir, cssPath) {
  const p = path.join(dir, `m-${w}-${dpr}-${path.basename(cssPath)}.html`);
  fs.writeFileSync(p, pageHtml(w, cssPath, true));
  const png = path.join(dir, `m-${w}-${dpr}-${path.basename(cssPath)}.png`);
  const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--user-data-dir=' + path.join(dir, `prof-${w}-${dpr}-${path.basename(cssPath)}`),
    '--force-device-scale-factor=' + dpr, '--window-size=' + w + ',' + WINDOW_H,
    '--virtual-time-budget=2500', '--screenshot=' + png, '--dump-dom', 'file:///' + p.replace(/\\/g, '/')],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
  if (!m) return { err: 'no title, status ' + r.status };
  const res = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  res.png = fs.existsSync(png) ? decodePNG(png) : null;
  return res;
}

function main() {
  console.log('\n[1] the chip is one control holding glyph + name + pencil');
  check(/<span id="chan-head">[\s\S]*?<span id="chan-hash">#<\/span><strong id="chan-name">[\s\S]*?<button id="btn-group-edit"[^>]*class="hidden"[^>]*aria-label="Edit group"[\s\S]*?<\/button><\/span>/.test(html),
    'index.html puts the glyph, the name and the pencil in ONE #chan-head chip');
  check(/id="btn-group-edit"[^>]*class="hidden"/.test(html), 'the pencil starts hidden (no conversation is open at boot)');
  check(/id="btn-group-edit"[\s\S]{0,220}?M12 20h9/.test(html), 'and it is a pencil, not a dot or a gear');

  console.log('\n[2] the group half of the header state has one painter');
  check(/function paintHeaderGroupEdit\(on\) \{/.test(home) && /chip\.title = on \? 'Edit group' : ''/.test(home),
    'paintHeaderGroupEdit owns the mode, the tooltip and the pencil');
  check(/pencil\.classList\.toggle\('hidden', !on\)/.test(home), 'and the pencil is shown only in that mode');
  check(/if \(t\.isGroup\) paintGroupHeadGlyph\(\);[\s\S]{0,600}?paintHeaderNameTap\(!t\.isGroup && !!peer\);[\s\S]{0,120}?paintHeaderGroupEdit\(t\.isGroup\);/.test(home),
    'paintDmHead sets the group mode and the DM name-tap from the same thread, never both');
  check(/function paintGroupHeadGlyph\(\)/.test(servers) && /h\.classList\.add\('group-head-glyph'\)/.test(servers),
    'servers.js paints the group glyph');
  check(/h\.classList\.remove\('dm-head-av', 'group-head-glyph'\)/.test(servers),
    'and paintChanGlyph clears BOTH glyphs, so a face and a people mark cannot leak into each other');
  check((servers.match(/paintHeaderGroupEdit\(false\)/g) || []).length === 2,
    'both server header paths clear the group mode (a channel, and a server with no text channel)');
  check(/paintHeaderGroupEdit\(false\)/.test(pins), 'and so does a blank Home panel');

  console.log('\n[3] the click goes to the group editor, and only there');
  check(/\$\('#chan-head'\)\?\.addEventListener\('click', \(e\) => \{/.test(home), 'the handler is on the chip itself');
  check(/if \(!document\.body\.classList\.contains\('dm-open'\)\) return;/.test(home), 'a header with no open conversation does nothing');
  check(/if \(!\$\('#chat-header'\)\?\.classList\.contains\('group-edit'\)\) return;/.test(home), 'so does a 1:1 DM (its name is ui.js\'s person card)');
  check(/const t = \(S\.dms \|\| \[\]\)\.find\(\(x\) => x\.id === S\.dmThreadId\);[\s\S]{0,160}?if \(!t \|\| !t\.isGroup\) return;[\s\S]{0,60}?openGroupEdit\(t\.id\);/.test(home),
    'and a group opens the very editor its row menu opens (openGroupEdit)');

  console.log('\n[4] styles.css: one pill, a visible pencil, a real thumb box');
  const chipRule = /#chan-head\{([^}]*)\}/.exec(css);
  check(!!chipRule, 'styles.css styles #chan-head');
  if (chipRule) {
    check(/display:flex/.test(chipRule[1]) && /align-items:center/.test(chipRule[1]), 'as one flex box', chipRule[1]);
    check(/border-radius:999px/.test(chipRule[1]), 'that can read as a pill', chipRule[1]);
    check(/padding:\.2rem \.4rem/.test(chipRule[1]) && /margin:-\.2rem -\.4rem/.test(chipRule[1]),
      'whose padding is cancelled by the same negative margin (the name does not move)', chipRule[1]);
    check(/min-width:0/.test(chipRule[1]), 'and that can shrink, so a long group name still ellipsizes', chipRule[1]);
  }
  const gRule = /#chan-hash\.group-head-glyph\{([^}]*)\}/.exec(css);
  check(!!gRule && /width:24px/.test(gRule[1]) && /height:24px/.test(gRule[1]) && /border-radius:50%/.test(gRule[1]),
    'the group glyph is a 24px circle — the 1:1 DM face\'s own box', gRule && gRule[1]);
  check(!!gRule && /background:var\(--panel-3\)/.test(gRule[1]), 'on the tonal circle the DM list gives a group', gRule && gRule[1]);
  const pRule = /#btn-group-edit\{([^}]*)\}/.exec(css);
  check(!!pRule && /display:inline-flex/.test(pRule[1]), 'the pencil is displayed at rest, not only on hover', pRule && pRule[1]);
  check(/\.hidden\{display:none!important\}/.test(css), 'and .hidden is what takes it away (!important, so the rule above cannot win)');
  check(/#chat-header\.group-edit #chan-head:hover\{background:var\(--panel-3\)\}/.test(hoverBlock),
    'the pill hover lives in the "hover, only where hover exists" block (a tap cannot leave it stuck)');
  check(hoverStart > 0 && hoverBlock.length > 100, 'that block is a real block');
  check(/#chat-header\.group-edit #chan-head::after\{content:'';position:absolute;inset:-9px -4px\}/.test(css),
    'and the phone grows ONE thumb box over the whole chip (a 14px pencil is not a target)');
  check(/#chat-header\.group-edit #chan-head:active\{background:var\(--panel-3\)\}/.test(css),
    'a press tints the chip on touch, where the hover pill never appears');

  const chrome = findChrome();
  if (!chrome) return skip('no Chrome/Edge found — set CHROME_PATH');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-grphead-'));
  try {
    console.log('\n[5] the real painters and the real click handler (headless Chrome)');
    // The thumb box lives under `@media (pointer:coarse)`, and headless Chrome has
    // no way to claim a coarse pointer — so the SAME stylesheet is loaded a second
    // time with that one at-rule turned into `@media all`, and the box is then
    // measured where it lands. Nothing else about the sheet changes.
    const phoneCss = path.join(dir, 'styles-coarse.css');
    fs.writeFileSync(phoneCss, css.replace('@media (pointer:coarse){', '@media all{'));
    const realCss = path.join(ROOT, 'public/styles.css');
    for (const [w, dpr, coarse] of [[480, 1, false], [480, 2, false], [960, 1, false], [480, 1, true]]) {
      const out = measure(chrome, w, dpr, dir, coarse ? phoneCss : realCss);
      const tag = 'w' + w + '@' + dpr + (coarse ? ' coarse' : '') + ' — ';
      if (out.err) { check(false, tag + 'the harness ran', out.err); continue; }
      const g = out.group;
      check(g.name === "Cross's Group" && g.headerText.indexOf("Cross's Group") >= 0,
        tag + 'the header reads the group\'s name', g.headerText);
      check(g.glyphSvg && /group-head-glyph/.test(g.glyphClass), tag + 'the group wears the people mark', g.glyphClass);
      check(g.glyphBox.w === 24 && g.glyphBox.h === 24, tag + 'at the 1:1 DM face\'s own 24px', g.glyphBox);
      check(Math.abs(g.nameCy - g.glyphBox.cy) <= 2, tag + 'on the name\'s line', { name: Math.round(g.nameCy), glyph: Math.round(g.glyphBox.cy) });
      // A flex item's `display:inline-flex` computes to `flex` — it is blockified.
      check((g.pencilDisplay === 'flex' || g.pencilDisplay === 'inline-flex') && g.pencilInsideChip,
        tag + 'the pencil is drawn at rest, inside the chip', { display: g.pencilDisplay });
      check(g.order.join(',') === 'chan-hash,chan-name,btn-group-edit', tag + 'glyph → name → pencil, one run', g.order);
      check(g.chipPill === '999px', tag + 'the chip is a pill', g.chipPill);
      check(g.groupEdit && !g.dmTap && g.cursor === 'pointer' && g.title === 'Edit group',
        tag + 'a group is in group-edit mode: pointer, tooltip, no person-card',
        { groupEdit: g.groupEdit, dmTap: g.dmTap, cursor: g.cursor, title: g.title });

      check(out.clickName.n === 1 && out.clickName.title === 'Group chat settings',
        tag + 'clicking the NAME opens Group chat settings', out.clickName);
      check(/value="Cross&#39;s Group"/.test(out.clickName.body || ''),
        tag + 'with the group\'s own name prefilled', out.clickName.body);
      check(out.clickPencil.n === 1 && out.clickPencil.title === 'Group chat settings',
        tag + 'clicking the PENCIL opens the same editor', out.clickPencil);
      check(out.clickGlyph.n === 1 && out.clickGlyph.title === 'Group chat settings',
        tag + 'and so does the glyph (one chip, one action)', out.clickGlyph);

      check(out.dm.pencilDisplay === 'none' && !out.dm.groupEdit && out.dm.dmTap && out.dm.title === '',
        tag + 'a 1:1 DM clears the pencil, the tooltip and the mode', out.dm);
      check(/dm-head-av/.test(out.dm.face) && out.dm.faceBox.w === 24, tag + 'and wears that person\'s face instead', out.dm);
      check(out.dmClick.n === 0, tag + 'whose name never opens a group editor', out.dmClick);
      check(out.closedClick.n === 0, tag + 'and a chip with no open conversation does nothing', out.closedClick);

      check(out.clear.text === '#' && !/group-head-glyph|dm-head-av/.test(out.clear.cls) && out.clear.kids === 0,
        tag + 'a channel is exactly a #, with no glyph left over', out.clear);
      check(out.clear.pencilDisplay === 'none' && !out.clear.groupEdit && out.clear.title === '',
        tag + 'and no pencil, tooltip or mode either', out.clear);

      // The point of the thumb box is that a thumb can hit the chip, so the box is
      // asserted to be at least 44px tall on a coarse pointer and absent otherwise.
      const tb = out.thumb || {};
      const grow = -parseFloat(tb.top || '0') - parseFloat(tb.bottom || '0');
      if (coarse) {
        check(tb.content !== 'none' && tb.top === '-9px' && tb.left === '-4px' && tb.chipH + grow >= 44,
          tag + 'a phone grows ONE thumb box over the whole chip (≥44px tall)', tb);
      } else {
        check(tb.content === 'none', tag + 'a desktop header grows none', tb);
      }

      if (!out.png) { check(false, tag + 'a screenshot to sample', 'none'); continue; }
      const img = out.png;
      check(img.w === Math.round(w * dpr) && img.h === WINDOW_H * dpr,
        tag + 'the screenshot is the window, so the sample coordinates are real', { png: [img.w, img.h] });
      // Everything below is read out of the PNG itself. The page's own rects cannot
      // be trusted for position: headless Chrome reports a 0-wide viewport while
      // laying the page out, so the paint is a different (wider) layout than the
      // rects describe — but it is the paint the reader sees.
      const near = (p, [r, g2, b], tol) => Math.abs(p[0] - r) <= tol && Math.abs(p[1] - g2) <= tol && Math.abs(p[2] - b) <= tol;
      const px = (x, y) => { const i = (y * img.w + x) * 4; return [img.px[i], img.px[i + 1], img.px[i + 2]]; };
      // The circle, as the rows whose WIDEST run of --panel-3 is a circle-sized
      // chord. The header's hairline bottom border is the same colour and spans the
      // whole width, so a run longer than the circle is not it; antialiased text
      // edges never hold a 16px horizontal run of exactly that colour.
      const lo = Math.round(16 * dpr), hi = Math.round(32 * dpr);
      let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, widest = 0, centerRow = -1;
      for (let y = 0; y < img.h; y++) {
        let run = 0, start = 0, best = 0, bestAt = 0;
        for (let x = 0; x < img.w; x++) {
          if (near(px(x, y), PANEL3, 6)) { if (!run) start = x; run++; }
          else { if (run > best) { best = run; bestAt = start; } run = 0; }
        }
        if (run > best) { best = run; bestAt = start; }
        if (best < lo || best > hi) continue;
        if (best > widest) { widest = best; centerRow = y; }
        if (bestAt < minX) minX = bestAt;
        if (bestAt + best - 1 > maxX) maxX = bestAt + best - 1;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      // The fill is then COUNTED over that box rather than summed from the runs:
      // the people mark is drawn in --muted ON the circle, so the centre rows hold
      // several short runs instead of one long one.
      let n = 0;
      for (let y = Math.max(0, minY); y <= Math.min(img.h - 1, maxY); y++) {
        for (let x = Math.max(0, minX); x <= Math.min(img.w - 1, maxX); x++) if (near(px(x, y), PANEL3, 6)) n++;
      }
      const circle = { n, w: maxX - minX + 1, h: maxY - minY + 1, widest };
      check(Math.abs(widest - 24 * dpr) <= 3 * dpr && Math.abs(circle.w - 24 * dpr) <= 3 * dpr
        && circle.h >= Math.round(16 * dpr) && circle.h <= Math.round(26 * dpr) && n >= Math.round(200 * dpr * dpr),
        tag + 'the group\'s 24px circle is actually drawn on screen', circle);
      if (centerRow >= 0) {
        const outside = px(Math.max(0, minX - Math.round(4 * dpr)), centerRow);
        check(near(outside, PANEL, 10), tag + 'and it sits on the header surface, round and not smeared', outside);
        const inside = px(minX + Math.round(3 * dpr), centerRow);
        check(near(inside, PANEL3, 14), tag + 'with its own tonal fill inside', inside);
      }
      // The pencil, without trusting a rect: the group's name is the only BRIGHT
      // text in the header, so the last bright column is where the name ends and
      // the pencil is the --muted ink to the right of it. (The glyph's people mark
      // is muted too, but it is inside the circle, i.e. LEFT of the name.) Rows are
      // kept to the circle's band so the header's own hairline border — one tonal
      // step off --panel — cannot be mistaken for ink.
      const bandTop = Math.max(0, Math.min(minY, maxY));
      const bandBot = Math.min(img.h - 1, Math.max(minY, maxY));
      let nameEnd = -1;
      for (let y = bandTop; y <= bandBot; y++) {
        for (let x = img.w - 1; x > nameEnd; x--) {
          if (near(px(x, y), [238, 241, 248], 45)) { nameEnd = x; break; }
        }
      }
      let ink = 0;
      for (let y = bandTop; y <= bandBot; y++) {
        for (let x = nameEnd + Math.round(3 * dpr); x <= nameEnd + Math.round(30 * dpr) && x < img.w; x++) {
          if (!near(px(x, y), PANEL, 25)) ink++;
        }
      }
      check(nameEnd > maxX && ink >= 3 * dpr * dpr,
        tag + 'the pencil is drawn too: ink past the end of the name', { nameEnd, circleEnd: maxX, ink });
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
}

main();
