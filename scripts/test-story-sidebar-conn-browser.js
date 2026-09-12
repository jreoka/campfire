// The sidebar Stories ＋ and the voice connection chip, measured in a real
// browser (see AGENTS.md verification conventions).
//
// Two reports, both about a sidebar surface:
//
//  1. The server sidebar's Stories row already had an accent ＋, but it sat at
//     the end of the row's text flow — .1rem after the "N new" chip — while
//     Home's identical ＋ is pinned to the sidebar's trailing slot (.6rem from
//     the edge). Two lists, two columns, visibly out of line. The ＋ is now a
//     sibling pinned over the row's trailing edge like Home's.
//     The subtlety this test exists for: the server row's wrapper used to carry
//     its own .45rem right margin, and an absolutely pinned ＋ inherits that —
//     7.2px short of Home's. The wrapper spans the full width now and the ROW
//     pays for the inset, so the two ＋s measure to the same pixel.
//  2. The sidebar voice bar only ever printed the room name, so a call where
//     the other side never answers looked exactly like one at rest. It now
//     carries a Connecting…/Connected/Reconnecting… chip (state machine tested
//     in test-voice-conn-status.js) — this half checks the LAYOUT: the chip
//     takes the bar's trailing slot, the room name yields with an ellipsis, and
//     a long name can never push the chip out of the bar.
//
// The REAL renderServerStories builds the row and the REAL stylesheet lays it
// out, side by side with the REAL Home markup. Offline checks first; the
// browser half skips without Chrome/Edge.
//
// Usage: node scripts/test-story-sidebar-conn-browser.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

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

const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const stories = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');

function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}
// A div by id, its nested divs balanced (so a wrapper comes out whole).
function divBlock(id) {
  const at = index.indexOf('id="' + id + '"');
  if (at < 0) return null;
  const start = index.lastIndexOf('<div', at);
  const tagEnd = index.indexOf('>', at) + 1;
  let depth = 1, i = tagEnd;
  while (i < index.length) {
    const open = index.indexOf('<div', i);
    const shut = index.indexOf('</div>', i);
    if (shut < 0) return null;
    if (open >= 0 && open < shut) { depth++; i = open + 4; }
    else { depth--; i = shut + 6; if (depth === 0) return index.slice(start, i); }
  }
  return null;
}

// ---------- offline checks ----------
console.log('\n[1] both sides of the ＋ move are pinned to the same CSS');
check(/#stories-nav-add\{position:absolute;right:\.6rem;top:50%;transform:translateY\(-50%\)\}/.test(css),
  'Home\'s ＋ stays pinned .6rem from the sidebar edge');
check(/#srv-stories \.ss-add\{position:absolute;right:\.6rem;top:50%;transform:translateY\(-50%\);margin:0\}/.test(css),
  'and the server sidebar\'s ＋ is now pinned to the same slot');
check(/\.srv-stories-wrap\{position:relative;display:flex;margin:\.5rem 0 0\}/.test(css),
  'the server wrapper spans the sidebar\'s full content width — a margin here would hold the ＋ short of Home\'s');
check(/\.srv-stories\{[^}]*margin:0 \.45rem/.test(css),
  'the row pays for that inset on its own margins instead');
check(/#stories-nav-wrap\{position:relative/.test(css), 'and each row is its own positioning context');
check(!/\.ss-add\{[^}]*margin-left:\.1rem/.test(css),
  'the old in-flow .1rem margin is gone (it was what parked the ＋ against the chip)');
check(/\.ss-hint\{margin-left:\.35rem/.test(css) && /\.ss-count\{margin-left:\.35rem/.test(css),
  'the row\'s chips sit with the label instead of eating the trailing slot');

console.log('\n[2] the voice chip is inside the bar and can never be pushed out');
check(/#voice-conn\{margin-left:auto/.test(css), 'the chip claims the bar\'s trailing slot');
check(/#voice-chan-name\{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0\}/.test(css),
  'and the room name yields with an ellipsis (a long name cannot shove it out)');
check(/#voice-status\{display:flex;align-items:center;min-width:0/.test(css),
  'the row that holds both is a min-width:0 flex line, so the ellipsis can engage');

// ---------- headless Chrome ----------
const srvBlock = divBlock('srv-stories');
const homeWrap = divBlock('stories-nav-wrap');
const voiceBar = (() => {
  const a = index.indexOf('<div id="voice-bar"');
  const b = a < 0 ? -1 : index.indexOf('<div id="me-card">', a);
  return a < 0 || b < 0 ? null : index.slice(a, b);
})();
// The REAL functions out of stories.js, wrapped in a scope of their own so
// their `const svSvg` / helper declarations cannot collide with the page's.
const renderSrc = `(function () {\nconst svSvg = { plus: 'x', camera: 'x' };\n`
  + slice(stories, 'function storyStackHTML(users) {', '// Home sidebar: a Stories entry')
  + '\nwindow.__renderServerStories = renderServerStories;\n})();\n';
const groupPlus = '<button id="btn-group-new" class="mini" title="New group chat"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg></button>';

function pageHtml(roomName) {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>#view-main{height:100vh}#home-ui,#server-ui{display:block}</style></head><body>
<section id="view-main"><div id="left">
  <nav id="rail"></nav>
  <aside id="sidebar">
    <div id="server-ui">
      ${srvBlock}
      <div class="chan-group-label">TEXT CHANNELS</div>
      <div id="text-channels"></div>
    </div>
    <div id="home-ui">
      <div class="home-head"><strong>Home</strong></div>
      ${homeWrap}
      <div class="chan-group-label row-between">GROUP CHATS ${groupPlus}</div>
      <div id="group-list"></div>
    </div>
    <div class="spacer"></div>
    ${voiceBar}
    <div id="me-card"><button type="button" id="me-open"><span id="me-avatar" class="avatar">?</span><span id="me-name">me</span></button></div>
  </aside>
</div><main id="chat"></main></section>
<script>
window.__errs = [];
window.addEventListener('error', (e) => window.__errs.push(String((e && e.message) || e)));
const $ = (s) => document.querySelector(s);
const S = { serverId: 's1', serverDetail: { name: 'Test', channels: [] }, me: { id: 'u1' }, view: 'server', voice: null };
// The empty-server state: the row draws the camera icon and the "Be the first"
// hint — the case where the ＋ used to be crammed against the hint. (With a live
// tray the row draws an avatar stack in the icon's place; same trailing slot.)
function storyServerTray() { return { items: [] }; }
function serverTrayUnseen() { return 0; }
function storyLive(items) { return items || []; }
function paintAvatar() {}
function createStory() {}
function openStoriesSheet() {}
${renderSrc}
window.__renderServerStories();
// the voice bar's real markup, with a long room name painted the way
// voice.js's voiceLabel() paints it
document.getElementById('voice-bar').classList.remove('hidden');
document.getElementById('voice-chan-name').textContent = ${JSON.stringify(roomName)};
document.getElementById('voice-bar').classList.add('vc-connected');
document.getElementById('voice-conn').textContent = 'Connected';
// On a phone the sidebar is a full-page nav (body.nav-open) that is otherwise
// slid off screen, and it gets there with a 260ms transform transition. Set the
// flag and then pin #left to its settled state: a measurement that races a
// virtual-time run must not read the nav mid-slide (it would report the whole
// panel off-canvas and the ＋ unhittable).
if (innerWidth <= 700 || (innerHeight <= 560 && matchMedia('(pointer:coarse)').matches)) {
  document.body.classList.add('nav-open');
  const left = document.getElementById('left');
  if (left) { left.style.transition = 'none'; left.style.transform = 'none'; }
}

const box = (el) => {
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return { l: +b.left.toFixed(2), t: +b.top.toFixed(2), r: +b.right.toFixed(2), b: +b.bottom.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2) };
};
const hits = (x, y, sel) => { const el = document.elementFromPoint(x, y); return !!(el && el.closest && el.closest(sel)); };
window.__report = function () {
  const srvRow = document.querySelector('#srv-stories .srv-stories');
  const srvAdd = document.querySelector('#srv-stories .ss-add');
  const homeAdd = document.getElementById('stories-nav-add');
  const homeRow = document.getElementById('btn-stories');
  const gPlus = document.getElementById('btn-group-new');
  const names = { srvRow, srvAdd, homeAdd, homeRow, gPlus, sidebar: document.getElementById('sidebar') };
  const missing = Object.keys(names).filter((k) => !names[k]);
  if (missing.length) return { fatal: 'missing elements: ' + missing.join(',') };
  const sb = box(document.getElementById('sidebar'));
  const bar = box(document.getElementById('voice-bar'));
  const chip = box(document.getElementById('voice-conn'));
  const name = box(document.getElementById('voice-chan-name'));
  const srvAddBox = box(srvAdd), homeAddBox = box(homeAdd), gBox = box(gPlus);
  const cam = box(srvRow.querySelector('.ss-ic'));
  const srvRowBox = box(srvRow);
  if (!srvAddBox || !homeAddBox || !gBox || !cam || !srvRowBox) return { fatal: 'a measured element is missing' };
  const cx = (srvAddBox.l + srvAddBox.r) / 2, cy = (srvAddBox.t + srvAddBox.b) / 2;
  return {
    vw: innerWidth, vh: innerHeight,
    srvRow: srvRowBox, srvAdd: srvAddBox, srvCam: cam, srvHint: box(srvRow.querySelector('.ss-hint')),
    homeAdd: homeAddBox, homeRow: box(homeRow), groupPlus: gBox, sidebar: sb,
    srvFromEdge: +(sb.r - srvAddBox.r).toFixed(2),
    homeFromEdge: +(sb.r - homeAddBox.r).toFixed(2),
    addCol: { right: +(srvAddBox.r - homeAddBox.r).toFixed(2), left: +(srvAddBox.l - homeAddBox.l).toFixed(2), size: +(srvAddBox.w - homeAddBox.w).toFixed(2) },
    homeVsGroup: +(homeAddBox.r - gBox.r).toFixed(2),
    centred: +(((srvAddBox.t + srvAddBox.b) / 2) - ((srvRowBox.t + srvRowBox.b) / 2)).toFixed(2),
    overlap: srvAddBox.l < cam.r,
    nested: !!srvRow.querySelector('.ss-add'),
    hit: { at0: hits(cx, cy, '#srv-stories .ss-add'), up18: hits(cx, cy - 18, '#srv-stories .ss-add'), down18: hits(cx, cy + 18, '#srv-stories .ss-add') },
    bar, chip, name,
    chipGap: bar && chip ? +(bar.r - chip.r).toFixed(2) : null,
    chipInside: !!(bar && chip) && chip.l >= bar.l - 0.5 && chip.r <= bar.r + 0.5,
    nameClipped: !!(name && chip && bar) && name.r <= chip.l + 0.5 && name.w < bar.w - chip.w - 20,
    errs: window.__errs.slice(),
  };
};
setTimeout(() => {
  try { document.title = JSON.stringify(window.__report()); }
  catch (e) { document.title = JSON.stringify({ fatal: (e && e.message) || String(e) }); }
}, 400);
</script>
</body></html>`;
}

function probe(chrome, html, { width, height, dpr }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-storysb-'));
  try {
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, html);
    const args = [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + path.join(dir, 'prof'), '--force-device-scale-factor=' + dpr,
      '--window-size=' + width + ',' + height, '--virtual-time-budget=4000',
      '--dump-dom', 'file:///' + file.replace(/\\/g, '/'),
    ];
    const r = spawnSync(chrome, args, { encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024 });
    const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
    if (!m) throw new Error('no title in dump (chrome status ' + r.status + ')');
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function chromeHalf() {
  const chrome = findChrome();
  if (!chrome) return skip('no Chrome/Edge found (set CHROME_PATH)');
  if (!srvBlock || !homeWrap || !voiceBar) return skip('could not extract the sidebar markup from index.html');
  const LONG = 'very-long-voice-room-name-that-should-ellipsise';

  console.log('\n[3] desktop: the two Stories ＋s land in one column');
  const desk = probe(chrome, pageHtml(LONG), { width: 1100, height: 760, dpr: 2 });
  if (desk.fatal) throw new Error('page reported: ' + desk.fatal);
  check(desk.nested === false, 'the server ＋ is a sibling of its row, not nested in it');
  check(Math.abs(desk.srvFromEdge - 0.6 * 16) <= 2,
    'and sits .6rem from the sidebar edge, like Home\'s', { srv: desk.srvFromEdge, home: desk.homeFromEdge });
  check(Math.abs(desk.srvFromEdge - desk.homeFromEdge) <= 0.6,
    'the two rows put their ＋ in exactly the same place', { srv: desk.srvFromEdge, home: desk.homeFromEdge });
  check(desk.addCol.right === 0 && desk.addCol.left === 0 && desk.addCol.size === 0,
    'right edge, left edge and size all agree (same column, same circle)', desk.addCol);
  check(Math.abs(desk.homeVsGroup) <= 0.6, 'and Home\'s ＋ is still in column with the GROUP CHATS ＋', { d: desk.homeVsGroup });
  check(Math.abs(desk.centred) <= 1, 'the ＋ sits on the row\'s centre line', { dy: desk.centred });
  check(desk.overlap === false && desk.srvAdd.l >= desk.srvCam.r + 4,
    'it is clear of the row\'s camera icon (never on top of the label)', { add: desk.srvAdd, cam: desk.srvCam });
  check(desk.srvHint && desk.srvHint.r <= desk.srvAdd.l + 1,
    'and the "Be the first" hint runs right up to it without overlapping — the row paid for the slot', { hint: desk.srvHint, add: desk.srvAdd });
  check(Math.abs(desk.srvAdd.w - 24) <= 0.5 && Math.abs(desk.srvAdd.h - 24) <= 0.5,
    'the circle is still 24px', { w: desk.srvAdd.w, h: desk.srvAdd.h });

  console.log('\n[4] desktop: the voice chip takes the trailing slot');
  check(desk.chipInside, 'the chip is inside the voice bar', { bar: desk.bar, chip: desk.chip });
  check(desk.chipGap >= 0 && desk.chipGap <= 14, 'and hugs the bar\'s trailing edge', { gap: desk.chipGap });
  check(desk.nameClipped && desk.name.r <= desk.chip.l + 0.5,
    'a very long room name ellipsises instead of pushing the chip out', { name: desk.name, chip: desk.chip });
  check(desk.chip.l > desk.bar.l + 60, 'the chip did not eat the room name\'s whole line', { chip: desk.chip, bar: desk.bar });

  console.log('\n[5] a phone: the ＋ grows its hit box, nothing else moves');
  const phone = probe(chrome, pageHtml(LONG), { width: 390, height: 844, dpr: 3 });
  if (phone.fatal) throw new Error('page reported: ' + phone.fatal);
  check(phone.vw <= 700, 'the probe really runs in the phone layout', { vw: phone.vw });
  check(phone.hit.at0 && phone.hit.up18 && phone.hit.down18,
    'a thumb 18px above/below the centre still lands on the ＋', { hit: phone.hit, add: phone.srvAdd });
  check(Math.abs(phone.srvAdd.w - 24) <= 0.5, 'the circle itself never resizes', { w: phone.srvAdd.w, h: phone.srvAdd.h });
  check(phone.srvAdd.r <= phone.sidebar.r - 8 && phone.srvAdd.l >= phone.srvRow.l,
    'and it stays inside the sidebar (no sideways overflow to scroll)', { add: phone.srvAdd, sidebar: phone.sidebar });
  check(phone.chipInside && phone.nameClipped, 'the chip still fits a phone-width bar', { bar: phone.bar, chip: phone.chip });
}

chromeHalf();
console.log('\n' + (failures.length ? failures.length + ' FAILED, ' + passed + ' passed' : 'all ' + passed + ' checks passed'));
if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
