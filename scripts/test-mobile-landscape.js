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
  // The two conversation shells a phone header has to survive: a 1:1 DM (which
  // also paints the call buttons) and Home's feed.
  document.body.classList.toggle('view-home', !!s.home);
  document.body.classList.toggle('dm-open', !!(s.home && s.dm));
  const cls = (sel, on) => { const el = $$(sel); if (el) el.classList.toggle('hidden', !on); };
  cls('#btn-call-voice', !!(s.dm && s.call));
  cls('#btn-call-video', !!(s.dm && s.call));
  cls('#btn-pins', !!s.pins);
  // Active threads is a server control (paintThreadsBtn), hidden in the markup;
  // the desktop rail-order check asks for it so the varying side is real.
  cls('#btn-threads', !!s.threads);
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
// Populate the channel list so the sidebar-overflow case (the me bar pushed
// below the fold) is under test, not just the empty shell.
window.__fillChannels = (n) => {
  const tc = $$('#text-channels');
  tc.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const b = document.createElement('button');
    b.className = 'chan' + (i === 1 ? ' unread' : '');
    b.innerHTML = '<span class="unread-dot"></span><span class="muted">#</span><span>channel-' + i + '</span>';
    tc.appendChild(b);
  }
  const su = $$('#server-ui'); if (su) su.scrollTop = 0;
};
window.__scrollServerUi = (to) => { const e = $$('#server-ui'); if (e) e.scrollTop = to; return e ? e.scrollTop : -1; };
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
// Model the on-screen keyboard the way the app models it, in place of a browser
// that has none: --vvh is the visible height, --kb how much of the layout box the
// keys cover at the bottom, and --vv-top how far the visible strip sits below the
// layout box's top (pickers.js keeps all three in sync off visualViewport; a
// visual-only engine PANS the page rather than resizing it, which is the pan
// argument).
// Opens the me-bar card as its phone sheet with a plausible own-card body, and
// the status editor the way openStatusEditor builds it — the exact pair the
// keyboard report was about.
window.__kb = (kb, pan) => {
  pan = pan || 0;
  const root = document.documentElement;
  const vvh = innerHeight - kb;
  root.style.setProperty('--vvh', vvh + 'px');
  root.style.setProperty('--kb', Math.max(0, kb - pan) + 'px');
  root.style.setProperty('--vv-top', pan + 'px');
  const uc = $$('#usercard');
  uc.className = 'sheet';
  uc.innerHTML = '<div class="uc-banner"></div><div class="uc-body"><div class="uc-head"><span class="avatar big"></span>'
    + '<div class="uc-bubble-wrap"><div class="uc-bubble-fit"><button class="uc-bubble edit">Set a status</button></div></div></div>'
    + '<div class="uc-name">Cross</div><div class="uc-sub">@cross</div>'
    + '<div class="uc-presence"><button class="prow toggle"><span class="status-dot online"></span><span class="plabel">Online</span></button></div>'
    + '<div class="uc-tabs"><button class="uc-tab">Profile</button><button class="uc-tab">Close</button></div></div>';
  const bd = $$('#modal-backdrop');
  bd.classList.remove('hidden');
  bd.classList.add('over-pop');
  $$('#modal-title').textContent = 'Custom status';
  $$('#modal-body').innerHTML = '<label>Status<input id="m-status-text" value="hi" /></label>'
    + '<div class="uc-sec-label">Clear after</div><select id="m-status-exp"><option>Never</option><option>30 min</option></select>'
    + '<div class="row" style="margin-top:.7rem"><button class="btn small danger">Clear status</button></div>';
  $$('#modal-ok').textContent = 'Save';
  $$('#modal-close').textContent = 'Cancel';
  const de = document.scrollingElement;
  de.scrollTop = 99999;
  const range = (el) => (el ? Math.max(0, el.scrollHeight - el.clientHeight) : -1);
  return {
    layoutH: innerHeight, kb, pan, vvh,
    rootH: Math.round(root.getBoundingClientRect().height),
    docRange: range(de), docScrolledTo: de.scrollTop,
    bodyRange: range(document.body),
    app: box('#app'),
    card: box('#usercard'), cardRange: range(uc),
    backdrop: box('#modal-backdrop'), backdropRange: range(bd),
    modal: box('#modal-backdrop .modal'),
    input: box('#m-status-text'),
  };
};
window.__kbOff = () => {
  const root = document.documentElement.style;
  root.removeProperty('--vvh'); root.removeProperty('--kb'); root.removeProperty('--vv-top');
};
const own = (sel, x, y) => { const el = $$(sel); if (!el) return false; const t = document.elementFromPoint(x, y); return !!(t && (t === el || el.contains(t))); };
window.__dump = () => {
  const btns = [...document.querySelectorAll('#chat-header .icon-btn')].filter((b) => b.offsetParent !== null);
  return {
    vw: innerWidth, vh: innerHeight,
    sw: document.documentElement.scrollWidth,
    phone: matchMedia(${JSON.stringify(PHONE_MQ)}).matches,
    leftPos: style('#left', 'position'), leftDisplay: style('#left', 'display'), membersPos: style('#members', 'position'),
    left: box('#left'), rail: box('#rail'), sidebar: box('#sidebar'), chat: box('#chat'), members: box('#members'),
    meCard: box('#me-card'),
    serverUi: (() => { const e = $$('#server-ui'); return e ? { scrollH: e.scrollHeight, clientH: e.clientHeight, scrollTop: e.scrollTop } : null; })(),
    menuVisible: (() => { const b = $$('#btn-menu'); return !!(b && b.offsetParent !== null); })(),
    membersBtnVisible: (() => { const b = $$('#btn-members'); return !!(b && b.offsetParent !== null); })(),
    // The phone header hides its secondary rails behind the ⋯ sheet (styles.css),
    // so a reachable Members control can be either the button itself (desktop) or
    // that sheet (phone).
    moreBtnVisible: (() => { const b = $$('#btn-chat-more'); return !!(b && b.offsetParent !== null); })(),
    // The rails the phone header hides and hands to the ⋯ sheet.
    hiddenRails: ['#btn-find', '#btn-notifs', '#btn-threads', '#btn-pins', '#btn-members']
      .filter((s) => { const b = $$(s); return !(b && b.offsetParent !== null); }),
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
    'the rail + chat list is the full-page nav in portrait');
  // Landscape is different: the rail + sidebar are persistent columns (the
  // Discord shape), so the portrait full-page nav must be neutralised there.
  check(/@media \(max-height:560px\) and \(pointer:coarse\)\{\s*#left\{display:contents\}/.test(css),
    'landscape restores the rail + sidebar as columns');
  check(/#left #sidebar\{width:min\(260px,38vw\)!important;flex:0 0 auto!important/.test(css),
    'the landscape sidebar is a fixed-width column, not the nav page\'s flex:1');
  check(/#btn-menu\{display:none!important\}/.test(css) && /#btn-nav-close\{display:none!important\}/.test(css),
    'landscape hides the chat ☰ and the nav ✕ (the sidebar is always visible)');
  check(/#voice-fab\{display:none!important\}/.test(css),
    'landscape hides the duplicate chat voice pill (the sidebar voice bar is on screen)');
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
  // The phone header's overflow: every view hides its secondary rails on a phone
  // (not just a DM) and offers ⋯ instead, and the sheet it opens lists exactly
  // those rails. Members stays out of it on Home's feed, where the drawer has no
  // content (the Active Now strip stands in).
  const ui = fs.readFileSync(path.join(ROOT, 'public/js/ui.js'), 'utf8');
  check(/#btn-threads,\s*#btn-find,\s*#btn-pins,\s*#btn-notifs,\s*#btn-members\{display:none\}/.test(css)
    && /#btn-chat-more\{display:inline-flex\}/.test(css),
    'the phone chat header hides its secondary rails and offers the ⋯ sheet (.css)');
  check(/const homeFeed = document\.body\.classList\.contains\('view-home'\) && !document\.body\.classList\.contains\('dm-open'\);/.test(ui)
    && /if \(sel === '#btn-members' && homeFeed\) continue;/.test(ui),
    'the ⋯ sheet offers Members for any open conversation, never on Home\'s feed (ui.js)');
  // Moving the bell into that sheet must not hide its unread count: it rides the
  // ⋯ button, and both badges also come along into the sheet's row labels.
  const security = fs.readFileSync(path.join(ROOT, 'public/js/security.js'), 'utf8');
  check(/id="chat-more-count"/.test(index) && /\$\('#chat-more-count'\)/.test(security),
    'the unread-notification count rides the ⋯ button (the bell is hidden on a phone)');
  check(/#chat-more-count\{[^}]*background:var\(--red\)/.test(css) && /#chat-more-count\.hidden\{display:none\}/.test(css),
    'drawn like the bell\'s own pill (.css)');
  check(/sel === '#btn-notifs' \? badgeOf\('#notifs-count'\) : \(sel === '#btn-pins' \? badgeOf\('#pins-count'\) : ''\)/.test(ui)
    && /items\.push\(\{ label: n \? `\$\{label\} · \$\{n\}/.test(ui),
    'and the ⋯ sheet\'s row labels carry the counts its buttons had (ui.js)');
  // The on-screen keyboard is a viewport (see [8]): the root box, the phone card
  // sheet and the dialog layer all read the VISIBLE strip, never the layout box.
  check(/html,body\{height:100vh;height:100dvh;height:var\(--vvh,100dvh\);overflow:hidden/.test(css),
    'the root box compresses with the keyboard exactly like the shell (.css)');
  check(/#modal-backdrop\{position:fixed;inset:0;top:var\(--vv-top,0px\);bottom:var\(--kb,0px\)/.test(css),
    'the dialog layer IS the visible strip — top and bottom both measured (.css)');
  check(/#usercard\.sheet\{[^}]*bottom:var\(--kb,0px\)[^}]*height:var\(--vvh,100dvh\)/.test(css),
    'and so is the phone card sheet (.css)');
  const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
  check(/root\.setProperty\('--vv-top', Math\.max\(0, Math\.round\(vv\.offsetTop\)\) \+ 'px'\)/.test(pickers)
    && /--vv-top is how far the visible area sits/.test(pickers),
    'pickers.js publishes the visual viewport\'s top offset as --vv-top (the pan half of the contract)');
}

function shellChecks(tag, d, expect) {
  const { vw, vh } = d;
  check(d.phone === true, `${tag}: the phone layout is active`);
  check(d.sw <= vw + 1, `${tag}: nothing overflows the viewport horizontally`, { sw: d.sw, vw });
  check(d.membersPos === 'fixed', `${tag}: the members panel is an overlay, not a column`, { membersPos: d.membersPos });
  if (expect.columns) {
    // Landscape (Discord shape): rail + channel sidebar are persistent
    // columns on the left and the chat takes the rest.
    check(d.leftDisplay === 'contents', `${tag}: the rail + sidebar are columns, never the nav page`, { display: d.leftDisplay });
    check(d.rail && d.rail.l <= 1 && d.rail.w >= 50 && d.rail.h > vh - 60, `${tag}: the server rail is a full-height column`, d.rail);
    check(!!d.sidebar && d.sidebar.l >= d.rail.r - 1 && Math.abs(d.sidebar.w - Math.min(260, 0.38 * vw)) <= 2,
      `${tag}: the channel sidebar sits beside the rail at its column width`, d.sidebar);
    check(!!d.chat && d.chat.l >= d.sidebar.r - 1 && d.chat.r >= vw - 1, `${tag}: the chat fills the rest of the width`, d.chat);
    check(d.chat.w < vw, `${tag}: the chat no longer owns the full width`, { chatW: d.chat.w, vw });
    check(d.navCloseVisible === false, `${tag}: the nav page ✕ is gone (the sidebar is always visible)`);
    check(d.menuVisible === false, `${tag}: the chat ☰ is gone (nothing left to overlay)`);
  } else {
    check(d.leftPos === 'fixed' && d.leftDisplay !== 'contents', `${tag}: the rail/members are overlays, not columns`, { leftPos: d.leftPos, display: d.leftDisplay });
    check(expect.navOpen ? d.left.l === 0 && d.left.r === vw : d.left.r <= 0, `${tag}: the nav page is ${expect.navOpen ? 'edge to edge' : 'off-screen while closed'}`, d.left);
    check(d.left.w === vw && d.left.h === vh, `${tag}: it covers the whole viewport`, d.left);
    check(d.chat.l === 0 && d.chat.w === vw, `${tag}: the chat keeps the full width`, d.chat);
  }
  check(expect.membersOpen ? d.members.r === vw && d.members.w < vw : d.members.l >= vw,
    `${tag}: the members drawer is ${expect.membersOpen ? 'in from the right edge' : 'off-screen while closed'}`, d.members);
  // The members drawer has to stay reachable on a phone. Since the phone header
  // moved its secondary rails into the ⋯ sheet, "reachable" means the button
  // itself OR that sheet (which offers Members for any open conversation).
  check(d.membersBtnVisible === true || d.moreBtnVisible === true,
    `${tag}: the members drawer is still reachable from the header`, { members: d.membersBtnVisible, more: d.moreBtnVisible });
  check(d.composer && d.composer.b <= vh + 1 && d.composer.t > 0, `${tag}: the composer sits on the bottom edge`, d.composer);
  check(d.msgs && d.msgs.h >= 40, `${tag}: the message list keeps a usable height`, d.msgs);
}

function headerChecks(tag, d) {
  const { vw, vh } = d;
  // On a phone this header is deliberately spare: the name plus whatever the
  // screen has room for, with the secondary rails in the ⋯ sheet. So the count
  // only has to be non-empty — the ⋯ sheet is what has to be there.
  check(d.btns.length >= 1, `${tag}: the header buttons are there`, { n: d.btns.length });
  check(d.moreBtnVisible === true, `${tag}: the ⋯ overflow is offered (the header's secondary rails live there)`);
  check(d.btns.every((b) => inside(b, vw, vh)), `${tag}: every header button is inside the viewport`, d.btns.filter((b) => !inside(b, vw, vh)));
  let clash = null;
  for (let i = 0; i < d.btns.length && !clash; i++) {
    for (let j = i + 1; j < d.btns.length; j++) if (overlaps(d.btns[i], d.btns[j])) { clash = [d.btns[i].id, d.btns[j].id]; break; }
  }
  check(!clash, `${tag}: no two header buttons overlap`, clash);
  check(d.chan && !d.btns.some((b) => overlaps(b, d.chan)), `${tag}: the channel name is not buried under a button`);
  check(d.head && d.head.l === d.chat.l && d.head.r <= vw + 1, `${tag}: the header spans the chat column`, d.head);
}

async function main() {
  staticChecks();

  await withChrome(async ({ device, state, dump, auth, evaluate }) => {
    console.log('\n[2] landscape: the rail + sidebar are columns, the chat takes the rest');
    for (const [w, h] of [[852, 393], [667, 375], [915, 412]]) {
      const tag = `${w}x${h}`;
      await device(w, h);
      await state({});
      const closed = await dump();
      shellChecks(tag, closed, { columns: true, membersOpen: false });
      headerChecks(tag, closed);
      check(closed.centerOwner !== 'left' && closed.centerOwner !== 'members', `${tag}: the middle of the screen is the chat, not an open panel`, { owner: closed.centerOwner });
      // A server with more channels than the viewport is tall must scroll the
      // channel list, not push the me bar off the bottom (the reported bug).
      await evaluate('__fillChannels(16)');
      let full = await dump();
      check(full.meCard && inside(full.meCard, full.vw, full.vh), `${tag}: the me bar stays on screen with a long channel list`, full.meCard);
      check(!!full.serverUi && full.serverUi.scrollH > full.serverUi.clientH + 1, `${tag}: the channel list scrolls instead of overflowing the sidebar`, full.serverUi);
      await evaluate('__scrollServerUi(99999)');
      full = await dump();
      check(full.meCard && inside(full.meCard, full.vw, full.vh), `${tag}: the me bar stays pinned after scrolling the list`, full.meCard);
      check(!!full.serverUi && full.serverUi.scrollTop > 0, `${tag}: the channel list actually scrolled`, full.serverUi);
      await evaluate('__fillChannels(0)');
      // The portrait nav page is inert in landscape: flipping body.nav-open must
      // move nothing (the sidebar is already on screen).
      const before = JSON.stringify({ rail: closed.rail, sidebar: closed.sidebar, chat: closed.chat });
      await state({ nav: true });
      const nav = await dump();
      shellChecks(`${tag} nav-open`, nav, { columns: true, membersOpen: false });
      check(JSON.stringify({ rail: nav.rail, sidebar: nav.sidebar, chat: nav.chat }) === before,
        `${tag}: the portrait nav-open flag moves nothing in landscape`, { chat: nav.chat });
      await state({ members: true });
      const members = await dump();
      shellChecks(`${tag} members-open`, members, { columns: true, membersOpen: true });
      check(members.centerInMembers === true, `${tag}: the members drawer is hit-testable where it sits`, members.centerOwner);
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
      check(inside(d.tools, d.vw, d.vh) && inside(d.scBar, d.vw, d.vh), `${tag}: the markup tool rail and the Next bar fit`, { tools: d.tools, bar: d.scBar });
      check(inside(d.edit, d.vw, d.vh) && inside(d.scNext, d.vw, d.vh), `${tag}: the caption slot and Next fit`, { edit: d.edit, next: d.scNext });
      check(d.editVisible === true && d.colorsVisible === false, `${tag}: the caption owns the slot when no colour tool is up`);
      check(!overlaps(d.tools, d.caption) && !overlaps(d.tools, d.scBar), `${tag}: the tool rail collides with neither the caption nor the bar`, { tools: d.tools, caption: d.caption, bar: d.scBar });
      await state({ compose: true, step: 'preview', colors: true });
      d = await dump();
      check(d.colorsVisible === true && d.editVisible === false, `${tag}: the colour row takes the caption slot (they never stack)`, { colors: d.colorsVisible, edit: d.editVisible });
      check(inside(d.colors, d.vw, d.vh) && inside(d.scBar, d.vw, d.vh), `${tag}: the colour row and the Next bar fit`, { colors: d.colors, bar: d.scBar });
      check(!overlaps(d.colors, d.scBar), `${tag}: the colour row does not sit on the Next bar`, { colors: d.colors, bar: d.scBar });
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
    shellChecks('390x844', port, { columns: false, navOpen: false, membersOpen: false });
    headerChecks('390x844', port);
    await device(1200, 900, { touch: false });
    await state({});
    const desk = await dump();
    check(desk.phone === false, 'desktop: the phone layout is off');
    check(desk.leftPos !== 'fixed' && desk.membersPos !== 'fixed', 'desktop: the rail and members stay in the layout', { leftPos: desk.leftPos, membersPos: desk.membersPos });
    check(desk.sw <= desk.vw + 1, 'desktop: no horizontal overflow', { sw: desk.sw, vw: desk.vw });
    check(desk.members && desk.members.r <= desk.vw + 1 && desk.members.w >= 200, 'desktop: the members panel is the usual column', desk.members);
    // The header rails render in the header's ONE order (index.html): the fixed
    // controls rightmost — search, pins, inbox, members — with the ones that
    // come and go with the conversation (a DM's calls, a server's threads) to
    // their left. Read back off the PIXELS, not the markup, so a CSS `order:`
    // or a row-reverse container cannot pass. A server channel has no calls; a
    // 1:1 DM has them and no threads. The offline half of this contract (the
    // markup, the ⋯ sheet, the phone hide list) is scripts/test-header-rails.js.
    const railOrder = async (s) => {
      await state(s);
      return (await dump()).btns.slice().sort((a, b) => a.l - b.l).map((b) => b.id);
    };
    const chanRails = await railOrder({ pins: true, threads: true });
    check(JSON.stringify(chanRails) === JSON.stringify(['btn-threads', 'btn-find', 'btn-pins', 'btn-notifs', 'btn-members']),
      'desktop channel: Active threads sits LEFT of the fixed rails (search → pins → inbox → members)', chanRails);
    const dmRails = await railOrder({ home: true, dm: true, call: true, pins: true });
    check(JSON.stringify(dmRails) === JSON.stringify(['btn-call-voice', 'btn-call-video', 'btn-find', 'btn-pins', 'btn-notifs', 'btn-members']),
      'desktop DM: the call buttons sit LEFT of the fixed rails (right to left still members, inbox, pins, search)', dmRails);
    await state({});
    await device(1024, 500, { touch: false });
    const short = await dump();
    check(short.phone === false, 'a short DESKTOP window (fine pointer) keeps the desktop shell');
    check(short.leftPos !== 'fixed', 'a short desktop window does not get the nav page', short.leftPos);

    console.log('\n[7] the phone chat header is the spare one, in a DM and in a channel');
    for (const [w, h] of [[390, 844], [852, 393]]) {
      const tag = `${w}x${h}`;
      await device(w, h);
      // A DM with both call buttons live and something pinned — the busiest the
      // header ever gets on a phone.
      await state({ home: true, dm: true, call: true, pins: true });
      const dm = await dump();
      check(dm.hiddenRails.length === 5, `${tag} DM: the secondary rails leave the header`, dm.hiddenRails);
      check(dm.moreBtnVisible === true, `${tag} DM: the ⋯ overflow stands in for them`);
      check(dm.btns.every((b) => ['btn-menu', 'btn-call-voice', 'btn-call-video', 'btn-chat-more'].includes(b.id)),
        `${tag} DM: only the call buttons + ⋯ + ☰ are left`, dm.btns.map((b) => b.id));
      check(dm.btns.some((b) => b.id === 'btn-call-voice') && dm.btns.some((b) => b.id === 'btn-call-video'),
        `${tag} DM: calling stays one tap away`);
      headerChecks(`${tag} DM`, dm);
      // A server channel: nothing but the name and ⋯.
      await state({ pins: true });
      const chan = await dump();
      check(chan.hiddenRails.length === 5 && chan.moreBtnVisible === true, `${tag} channel: same spare header`, chan.hiddenRails);
      check(chan.btns.every((b) => ['btn-menu', 'btn-chat-more'].includes(b.id)),
        `${tag} channel: only ☰ + ⋯ are left`, chan.btns.map((b) => b.id));
    }

    console.log('\n[8] the keyboard is a viewport, never room to scroll into');
    // Reported: with the status editor open over the me-bar card, the on-screen
    // keyboard let the page be scrolled "pretty far down". The keys are not a
    // resize of the LAYOUT box on every engine (iOS pans instead), so anything
    // sized to dvh stayed full height — 305px of card and dialog sitting below
    // the keys, and that band is exactly what the page scrolled/panned into.
    // These two surfaces are keyed to the VISIBLE area instead (--vvh) and end
    // on the keyboard's top edge (--kb), which also makes them track a pan.
    for (const [w, h, kb] of [[390, 844, 380], [360, 740, 320]]) {
      const tag = `${w}x${h} kb${kb}`;
      await device(w, h);
      const k = await evaluate(`__kb(${kb})`);
      check(k.layoutH === h && k.vvh === h - kb, `${tag}: the modelled keyboard shortens the visible area`, k);
      check(k.rootH === k.vvh && k.app && k.app.b === k.vvh, `${tag}: the root box and the shell are the visible height`, { rootH: k.rootH, app: k.app, vvh: k.vvh });
      check(k.card && k.card.t === 0 && k.card.b === k.vvh, `${tag}: the card sheet is exactly the strip above the keys`, k.card);
      check(k.backdrop && k.backdrop.t === 0 && k.backdrop.b === k.vvh, `${tag}: the dialog layer ends at the keys`, k.backdrop);
      check(k.modal && k.modal.t >= -1 && k.modal.b <= k.vvh + 1, `${tag}: the status editor fits above them`, { modal: k.modal, vvh: k.vvh });
      check(k.input && k.input.b < k.vvh, `${tag}: with the field you are typing in on screen`, k.input);
      // Nothing below the strip is scrollable: not the document, not the body,
      // not the card, and the dialog only as far as its own content runs.
      check(k.docRange === 0 && k.docScrolledTo === 0 && k.bodyRange === 0,
        `${tag}: no page under the keys to scroll into`, { docRange: k.docRange, docScrolledTo: k.docScrolledTo, bodyRange: k.bodyRange });
      check(k.cardRange === 0, `${tag}: and the card has nothing to scroll either`, k.cardRange);
      await evaluate('__kbOff()');
    }
    // The visual-only model, which PANS the page instead of resizing it (iOS):
    // the visible strip is not at y=0, and the same three numbers have to hold
    // there too — otherwise the dialog is centred in the layout box, the card
    // stretches below the keys, and the page scrolls into the difference.
    for (const [w, h, kb, pan] of [[390, 844, 380, 200], [390, 844, 380, 320]]) {
      const tag = `${w}x${h} kb${kb} pan${pan}`;
      await device(w, h);
      const k = await evaluate(`__kb(${kb}, ${pan})`);
      check(k.card && k.card.t === pan && k.card.b === pan + k.vvh,
        `${tag}: the card sheet holds the visible strip, wherever the pan put it`, k.card);
      check(k.backdrop && k.backdrop.t === pan && k.backdrop.b === pan + k.vvh,
        `${tag}: so does the dialog layer (the scrim covers the strip, not the layout box)`, k.backdrop);
      check(k.modal && k.modal.t >= pan - 1 && k.modal.b <= pan + k.vvh + 1,
        `${tag}: and the dialog is centred in the strip rather than above it`, { modal: k.modal, strip: [pan, pan + k.vvh] });
      check(k.docRange === 0 && k.bodyRange === 0, `${tag}: with no band under the keys to scroll into`, k);
      await evaluate('__kbOff()');
    }
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
