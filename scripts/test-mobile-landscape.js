// Phone landscape: the shell must stay the one-column phone layout (see
// AGENTS.md verification conventions).
//
// The complaint: rotate the phone sideways and "the layout completely goes to
// crap — buttons and menus overlap and the panels are all open including the
// member side panel and it crushes everything". Every mobile rule in
// styles.css was keyed on width alone (`max-width:700px` / `900px`), and a
// phone held sideways is 850+px wide but only ~390px tall. So landscape landed
// on the DESKTOP three-pane shell: the server rail + chat list were static
// columns (always open), the members panel was a static 244px column (always
// open), and the chat was squeezed into ~320px of a 915px viewport.
//
// The fix: the phone layout also applies to a short touch viewport
// (`max-height:560px and pointer:coarse`), in styles.css AND in the JS that
// makes layout decisions (core.js `phoneLayout()`, shared by picksers/ui/…).
//
// This test has two halves:
//   [1] static wiring: every mobile @media block carries the short-landscape
//       condition, the key rules (#members drawer, the #left nav page) are in
//       those blocks, and no module still decides layout on the raw 700px
//       width query;
//   [2..5] the REAL index.html markup + REAL styles.css in headless Chrome
//       over CDP with device emulation (touch emulation is what makes
//       `pointer:coarse` true, exactly like a real phone): the shell in
//       landscape, the nav page / members drawer lifecycle, the overlays that
//       used to collide, and that portrait + desktop are unchanged.
//
// Skips (exit 0) when Chrome is unavailable.
//
// Usage: node scripts/test-mobile-landscape.js

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

// A WS client that works on node's built-in WebSocket (EventTarget) and on the
// `ws` package (EventEmitter) — the other CDP tests require('ws'), which is a
// runtime dep, but node >= 22 has a global one so this runs without node_modules.
function connectWs(url) {
  const WS = globalThis.WebSocket || require('ws');
  const sock = new WS(url, { perMessageDeflate: false });
  const on = (ev, fn) => (typeof sock.addEventListener === 'function' ? sock.addEventListener(ev, fn) : sock.on(ev, fn));
  return { sock, on, send: (s) => sock.send(s), close: () => sock.close() };
}

const PHONE_MQ = '(max-width:700px), (max-height:560px) and (pointer:coarse)';

// The real index.html, minus the app scripts (this is a layout test — no API),
// with the stylesheet pointed at the working copy. The harness below opens the
// panels each check needs.
function pageHtml() {
  const head = index.slice(0, index.indexOf('<script src="/embeds.js">'))
    .replace('<link rel="stylesheet" href="/styles.css" />', `<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">`);
  return head + `
<style>*{transition:none!important;animation:none!important}</style>
<script>
document.getElementById('view-auth').classList.add('hidden');
document.getElementById('boot-splash').style.display = 'none';
document.getElementById('view-main').classList.remove('hidden');
// The message action sheet is built at runtime (actions.js) — a faithful copy so
// its bottom-sheet geometry is under test too.
const mkSheet = () => {
  const bd = document.createElement('div');
  bd.id = 'sheet-backdrop';
  const sh = document.createElement('div');
  sh.id = 'sheet';
  sh.className = 'hidden';
  sh.innerHTML = '<div class="sheet-handle"></div><div class="sheet-head"><span class="avatar">J</span>'
    + '<span class="sheet-who">Jordan</span></div><div class="sheet-rows">'
    + ['Reply', 'Copy text', 'Pin message', 'Report message'].map((t) => '<button class="sheet-row">' + t + '</button>').join('')
    + '</div>';
  document.body.append(bd, sh);
};
mkSheet();
const $$ = (s) => document.querySelector(s);
const hide = (s) => { const e = $$(s); if (e) e.classList.add('hidden'); };
const show = (s) => { const e = $$(s); if (e) e.classList.remove('hidden'); };
// Settings panel: the phone shape is the section menu.
$$('#settings-backdrop .settings').classList.add('menu');
// Story composer: model the real step visibility (storySetStep/storyPaintOv) —
// in preview the caption slot is hidden while the colour row is up.
document.getElementById('sc-colors').innerHTML = ['#5b6cff','#ef4444','#22c55e','#f59e0b','#a855f7','#ffffff']
  .map((c, i) => '<button class="sc-swatch' + (i ? '' : ' on') + '" style="background:' + c + '"></button>').join('');
window.__state = (s) => {
  const story = document.getElementById('story-compose');
  document.body.classList.toggle('nav-open', !!s.nav);
  document.body.classList.toggle('members-open', !!s.members);
  const box = (sel, open, cls) => {
    const el = $$(sel);
    if (!el) return;
    el.classList.toggle('hidden', !open);
    if (cls) el.classList.toggle(cls, !!open);
  };
  box('#picker', s.picker);
  box('#usercard', s.card, 'sheet');
  box('#settings-backdrop', s.settings);
  box('#modal-backdrop', s.modal);
  box('#sheet', s.sheet, 'open');
  box('#sheet-backdrop', s.sheet, 'open');
  box('#profile-backdrop', s.profile, 'open');
  box('#story-view', s.story);
  box('#story-compose', s.compose);
  box('#sc-tools', s.compose && s.step !== 'capture');
  box('#sc-bar', s.compose && s.step !== 'capture');
  box('#sc-edit', s.compose && s.step !== 'capture' && !s.colors);
  box('#sc-colors', s.compose && s.step !== 'capture' && !!s.colors);
  box('#sc-foot', s.compose && s.step === 'capture');
  if (story) {
    story.classList.toggle('sheet-open', false);
    story.style.setProperty('--sheet-h', '0px');
  }
};
const box = (sel) => {
  const el = $$(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
};
// The auth screen is the one full page that is not the app shell: a tall form
// must scroll inside it (a landscape viewport is shorter than the card).
window.__auth = () => {
  document.getElementById('view-main').classList.add('hidden');
  const a = document.getElementById('view-auth');
  a.classList.remove('hidden');
  a.scrollTop = 0;
  const card = a.querySelector('.auth-card');
  const top = card.getBoundingClientRect().top;
  const atTop = top >= -1;
  a.scrollTop = 99999;
  const sub = document.getElementById('btn-auth').getBoundingClientRect();
  const reachable = sub.top >= -1 && sub.bottom <= innerHeight + 1;
  const scrolled = a.scrollTop;
  const clientH = a.clientHeight, scrollH = a.scrollHeight;
  a.scrollTop = 0;
  a.classList.add('hidden');
  document.getElementById('view-main').classList.remove('hidden');
  return { vh: innerHeight, clientH, scrollH, canScroll: scrollH > clientH + 1, cardTop: +top.toFixed(1), atTop, scrolled, reachable };
};
const style = (sel, prop) => { const el = $$(sel); return el ? getComputedStyle(el)[prop] : null; };
const own = (sel, x, y) => { const el = $$(sel); if (!el) return false; const t = document.elementFromPoint(x, y); return !!(t && (t === el || el.contains(t))); };
window.__dump = () => {
  const btns = [...document.querySelectorAll('#chat-header .icon-btn')].filter((b) => b.offsetParent !== null);
  return {
    vw: innerWidth, vh: innerHeight,
    sw: document.documentElement.scrollWidth,
    phone: matchMedia(${JSON.stringify(PHONE_MQ)}).matches,
    leftPos: style('#left', 'position'), membersPos: style('#members', 'position'),
    left: box('#left'), chat: box('#chat'), members: box('#members'),
    membersBtnVisible: (() => { const b = $$('#btn-members'); return !!(b && b.offsetParent !== null); })(),
    navCloseVisible: (() => { const b = $$('#btn-nav-close'); return !!(b && b.offsetWidth); })(),
    head: box('#chat-header'), chan: box('#chan-name'), caption: box('#sc-caption'),
    btns: btns.map((b) => Object.assign({ id: b.id }, box('#' + b.id))),
    composer: box('#composer'), msgs: box('#messages'),
    picker: box('#picker'), card: box('#usercard'), settings: box('#settings-backdrop .settings'),
    setClose: box('#settings-close-menu'), modal: box('#modal-backdrop .modal'),
    sheet: box('#sheet'), profile: box('#profile-backdrop .profile'),
    stage: box('#sc-stage'), tools: box('#sc-tools'), colors: box('#sc-colors'), edit: box('#sc-edit'),
    editVisible: (() => { const e = $$('#sc-edit'); return !!(e && e.offsetParent !== null); })(),
    colorsVisible: (() => { const e = $$('#sc-colors'); return !!(e && e.offsetParent !== null); })(),
    foot: box('#sc-foot'), shutter: box('#sc-shutter'), scBar: box('#sc-bar'), scNext: box('#sc-next'), scTop: box('#story-compose .sc-top'),
    // who owns the middle of the viewport — the nav page must be on top of the chat
    centerOwner: (() => { const t = document.elementFromPoint(innerWidth / 2, innerHeight / 2); if (!t) return 'none'; for (const id of ['left', 'chat', 'members', 'story-view', 'story-compose', 'settings-backdrop', 'modal-backdrop']) { if (t.closest('#' + id)) return id; } return t.tagName.toLowerCase(); })(),
    centerInLeft: own('#left', innerWidth / 2, innerHeight / 2),
    centerInMembers: own('#members', innerWidth - 20, innerHeight / 2),
  };
};
</script></body></html>`;
}

async function withChrome(fn) {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found — set CHROME_PATH');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-land-'));
  const port = 9350 + Math.floor(Math.random() * 200);
  fs.writeFileSync(path.join(tmp, 'page.html'), pageHtml());
  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(tmp, 'prof')}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });
  let ver = null;
  for (let i = 0; i < 80 && !ver; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch {}
    if (!ver) await sleep(250);
  }
  if (!ver) { try { chrome.kill(); } catch {} return skip('Chrome did not expose the DevTools port'); }
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const { on, send, close } = connectWs(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { on('open', res); on('error', rej); });
  let msgId = 0;
  const pending = new Map();
  on('message', (evt) => {
    const m = JSON.parse(String(evt.data !== undefined ? evt.data : evt));
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
    }
  });
  const rpc = (method, params = {}) => new Promise((res, rej) => {
    const i = ++msgId;
    pending.set(i, { res, rej });
    send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const device = async (w, h, { touch = true } = {}) => {
    await rpc('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
    await rpc('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: touch });
    await sleep(320);
  };
  const state = async (s) => { await evaluate(`__state(${JSON.stringify(s)})`); await sleep(120); };
  const dump = () => evaluate('__dump()');
  const auth = () => evaluate('__auth()');
  try {
    await rpc('Page.enable');
    await rpc('Runtime.enable');
    await rpc('Page.navigate', { url: 'file:///' + path.join(tmp, 'page.html').replace(/\\/g, '/') });
    await sleep(900);
    return await fn({ device, state, dump, evaluate, auth, tmp });
  } finally {
    try { close(); } catch {}
    try { chrome.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

const inside = (r, vw, vh, slack = 1) => r && r.l >= -slack && r.t >= -slack && r.r <= vw + slack && r.b <= vh + slack;
const overlaps = (a, b) => a && b && a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;

// ---------------- the checks ----------------
function staticChecks() {
  console.log('\n[1] the phone layout also answers to a short touch viewport');
  const mqCount = (css.match(/max-height:560px\) and \(pointer:coarse\)/g) || []).length;
  check(mqCount >= 12, 'every mobile block carries the short-landscape condition', { found: mqCount });
  check(/@media \(max-width:900px\),\(max-height:560px\) and \(pointer:coarse\)\{\s*#members\{display:flex;flex-direction:column;position:fixed/.test(css),
    'the members panel is a drawer in landscape, never a static column');
  check(/@media \(max-width:700px\),\(max-height:560px\) and \(pointer:coarse\)\{\s*\/\* The rail \+ chat list is a whole page/.test(css),
    'the rail + chat list is the full-page nav in landscape');
  check(/@media \(max-width:820px\),\(max-height:560px\) and \(pointer:coarse\)\{#profile-backdrop/.test(css),
    'the profile screen goes full-screen in landscape');
  check(core.includes("const PHONE_MQ = '(max-width:700px), (max-height:560px) and (pointer:coarse)'") && /const phoneLayout = \(\) =>/.test(core),
    'core.js owns the shared phoneLayout() condition');
  const jsFiles = fs.readdirSync(path.join(ROOT, 'public/js')).filter((f) => f.endsWith('.js'));
  const stray = jsFiles.filter((f) => /matchMedia\(\s*['"]\(max-width:\s?700px\)/.test(fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8')));
  check(stray.length === 0, 'no module decides layout on the raw 700px width query any more', { stray });
  const calls = ['pickers.js', 'ui.js', 'security.js', 'settings.js']
    .filter((f) => fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8').includes('phoneLayout()'));
  check(calls.length === 4, 'the layout-deciding modules call phoneLayout()', { calls });
}

function shellChecks(tag, d, expect) {
  const { vw, vh } = d;
  check(d.phone === true, `${tag}: the phone layout is active`);
  check(d.sw <= vw + 1, `${tag}: nothing overflows the viewport horizontally`, { sw: d.sw, vw });
  check(d.leftPos === 'fixed' && d.membersPos === 'fixed', `${tag}: the rail/members are overlays, not columns`, { leftPos: d.leftPos, membersPos: d.membersPos });
  check(expect.navOpen ? d.left.l === 0 && d.left.r === vw : d.left.r <= 0, `${tag}: the nav page is ${expect.navOpen ? 'edge to edge' : 'off-screen while closed'}`, d.left);
  check(d.left.w === vw && d.left.h === vh, `${tag}: it covers the whole viewport`, d.left);
  check(expect.membersOpen ? d.members.r === vw && d.members.w < vw : d.members.l >= vw,
    `${tag}: the members drawer is ${expect.membersOpen ? 'in from the right edge' : 'off-screen while closed'}`, d.members);
  check(d.chat.l === 0 && d.chat.w === vw, `${tag}: the chat keeps the full width`, d.chat);
  check(d.membersBtnVisible === true, `${tag}: the members button is offered`);
  check(d.composer && d.composer.b <= vh + 1 && d.composer.t > 0, `${tag}: the composer sits on the bottom edge`, d.composer);
  check(d.msgs && d.msgs.h >= 40, `${tag}: the message list keeps a usable height`, d.msgs);
}

function headerChecks(tag, d) {
  const { vw, vh } = d;
  check(d.btns.length >= 3, `${tag}: the header buttons are there`, { n: d.btns.length });
  check(d.btns.every((b) => inside(b, vw, vh)), `${tag}: every header button is inside the viewport`, d.btns.filter((b) => !inside(b, vw, vh)));
  let clash = null;
  for (let i = 0; i < d.btns.length && !clash; i++) {
    for (let j = i + 1; j < d.btns.length; j++) if (overlaps(d.btns[i], d.btns[j])) { clash = [d.btns[i].id, d.btns[j].id]; break; }
  }
  check(!clash, `${tag}: no two header buttons overlap`, clash);
  check(d.chan && !d.btns.some((b) => overlaps(b, d.chan)), `${tag}: the channel name is not buried under a button`);
  check(d.head.l === 0 && d.head.r <= vw + 1, `${tag}: the header spans the viewport`, d.head);
}

async function main() {
  staticChecks();

  await withChrome(async ({ device, state, dump, auth }) => {
    console.log('\n[2] landscape: rotate sideways and the shell stays one column');
    for (const [w, h] of [[852, 393], [667, 375], [915, 412]]) {
      await device(w, h);
      await state({});
      const closed = await dump();
      shellChecks(`${w}x${h}`, closed, { navOpen: false, membersOpen: false });
      headerChecks(`${w}x${h}`, closed);
      await state({ nav: true });
      const nav = await dump();
      shellChecks(`${w}x${h} nav-open`, nav, { navOpen: true, membersOpen: false });
      check(nav.centerInLeft === true && nav.centerOwner === 'left', `${w}x${h}: the open nav page covers the chat (chat unreachable)`, { owner: nav.centerOwner });
      check(nav.navCloseVisible === true, `${w}x${h}: the nav page carries its own close button`);
      await state({ members: true });
      const members = await dump();
      shellChecks(`${w}x${h} members-open`, members, { navOpen: false, membersOpen: true });
      check(members.centerInMembers === true, `${w}x${h}: the members drawer is hit-testable where it sits`, members.centerOwner);
    }

    console.log('\n[3] landscape: the overlays that used to collide still fit');
    await device(852, 393);
    for (const [name, s, sel, expect] of [
      ['the emoji picker is a bottom sheet', { picker: true }, '#picker', 'bottom'],
      ['your user card is a full-height sheet', { card: true }, '#usercard', 'full'],
      ['settings opens as the section menu', { settings: true }, '#settings-backdrop .settings', 'full'],
      ['a modal fits the short viewport', { modal: true }, '#modal-backdrop .modal', 'center'],
      ['the message action sheet is a bottom sheet', { sheet: true }, '#sheet', 'bottom'],
      ['the profile screen is full-screen', { profile: true }, '#profile-backdrop .profile', 'full'],
    ]) {
      await state(s);
      const d = await dump();
      const r = name.includes('modal') ? d.modal : name.includes('picker') ? d.picker : name.includes('user card') ? d.card
        : name.includes('settings') ? d.settings : name.includes('action sheet') ? d.sheet : d.profile;
      const vw = d.vw, vh = d.vh;
      check(inside(r, vw, vh), `landscape: ${name}`, r);
      if (expect === 'bottom') check(Math.abs(r.b - vh) <= 1, `landscape: ${name} — pinned to the bottom edge`, r);
      if (expect === 'full') check(r.t <= 1 && Math.abs(r.b - vh) <= 1, `landscape: ${name} — spans the height`, r);
    }
    const setOpen = await dump();
    check(setOpen.setClose && inside(setOpen.setClose, setOpen.vw, setOpen.vh), 'landscape: the settings close button is reachable', setOpen.setClose);

    console.log('\n[4] landscape: the story composer keeps its controls on screen');
    for (const [w, h] of [[852, 393], [667, 375], [568, 320]]) {
      const tag = `${w}x${h}`;
      await device(w, h);
      await state({ compose: true, step: 'capture' });
      let d = await dump();
      check(d.stage && d.stage.h >= 100, `${tag}: the capture stage keeps a workable height`, d.stage);
      check(inside(d.shutter, d.vw, d.vh) && inside(d.foot, d.vw, d.vh), `${tag}: the shutter and its foot row fit`, { shutter: d.shutter, foot: d.foot });
      check(!overlaps(d.shutter, d.scTop), `${tag}: the shutter never rides under the top bar`, { shutter: d.shutter, top: d.scTop });
      check(d.foot.t <= d.shutter.t && d.foot.b >= d.shutter.b, `${tag}: the shutter sits inside its foot row`, { shutter: d.shutter, foot: d.foot });
      await state({ compose: true, step: 'preview' });
      d = await dump();
      check(inside(d.tools, d.vw, d.vh) && inside(d.scBar, d.vw, d.vh), `${tag}: the markup tool rail and the Retake/Next bar fit`, { tools: d.tools, bar: d.scBar });
      check(inside(d.edit, d.vw, d.vh) && inside(d.scNext, d.vw, d.vh), `${tag}: the caption slot and Next fit`, { edit: d.edit, next: d.scNext });
      check(d.editVisible === true && d.colorsVisible === false, `${tag}: the caption owns the slot when no colour tool is up`);
      check(!overlaps(d.tools, d.caption) && !overlaps(d.tools, d.scBar), `${tag}: the tool rail collides with neither the caption nor the bar`, { tools: d.tools, caption: d.caption, bar: d.scBar });
      await state({ compose: true, step: 'preview', colors: true });
      d = await dump();
      check(d.colorsVisible === true && d.editVisible === false, `${tag}: the colour row takes the caption slot (they never stack)`, { colors: d.colorsVisible, edit: d.editVisible });
      check(inside(d.colors, d.vw, d.vh) && inside(d.scBar, d.vw, d.vh), `${tag}: the colour row and the Retake/Next bar fit`, { colors: d.colors, bar: d.scBar });
      check(!overlaps(d.colors, d.scBar), `${tag}: the colour row does not sit on the Retake/Next bar`, { colors: d.colors, bar: d.scBar });
    }

    console.log('\n[5] the auth screen scrolls instead of hiding its submit button');
    for (const [w, h] of [[852, 393], [667, 375], [568, 320]]) {
      await device(w, h);
      const a = await auth();
      check(a.clientH === h, `${w}x${h}: the auth view is clamped to the viewport`, a);
      check(a.canScroll === true && a.scrolled > 0, `${w}x${h}: a tall login form scrolls inside the auth view`, a);
      check(a.atTop === true, `${w}x${h}: the top of the form is reachable (safe centring)`, a);
      check(a.reachable === true, `${w}x${h}: the Log in button can be scrolled to`, a);
    }
    await device(390, 844);
    const aPort = await auth();
    check(aPort.canScroll === false && aPort.atTop === true && aPort.reachable === true, '390x844: portrait still centres the form with nothing to scroll', aPort);

    console.log('\n[6] portrait and desktop are untouched');
    await device(390, 844);
    await state({});
    const port = await dump();
    shellChecks('390x844', port, { navOpen: false, membersOpen: false });
    headerChecks('390x844', port);
    await device(1200, 900, { touch: false });
    await state({});
    const desk = await dump();
    check(desk.phone === false, 'desktop: the phone layout is off');
    check(desk.leftPos !== 'fixed' && desk.membersPos !== 'fixed', 'desktop: the rail and members stay in the layout', { leftPos: desk.leftPos, membersPos: desk.membersPos });
    check(desk.sw <= desk.vw + 1, 'desktop: no horizontal overflow', { sw: desk.sw, vw: desk.vw });
    check(desk.members && desk.members.r <= desk.vw + 1 && desk.members.w >= 200, 'desktop: the members panel is the usual column', desk.members);
    await device(1024, 500, { touch: false });
    const short = await dump();
    check(short.phone === false, 'a short DESKTOP window (fine pointer) keeps the desktop shell');
    check(short.leftPos !== 'fixed', 'a short desktop window does not get the nav page', short.leftPos);
  });

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
