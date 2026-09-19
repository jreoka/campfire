// The members bar collapses — and comes back.
//
// The members bar is ONE surface in two shapes: below 900px (or in a short touch
// viewport) #members is a drawer over the chat, opened and closed transiently
// from the header's members button; above that it is a static 244px column that
// used to be permanent — nothing could give the width back to the conversation.
//
// The fix reuses the same header control, with the LAYOUT deciding what it
// means (ui.js reads membersDrawerLayout(), core.js's copy of the stylesheet's
// members @media condition). The desktop collapse is a PREFERENCE
// (cf_members_collapsed), so it survives a reload; the phone's drawer state
// deliberately is not, and crossing the breakpoint must never let the remembered
// collapse hide the drawer.
//
// Three things are checked, and the third is the one that catches the real
// breakages: [1] the wiring is where it claims to be (static source checks);
// [2] in headless Chrome, the REAL markup + REAL stylesheet + the REAL sliced
// logic block, driven by real clicks — column shape, drawer shape, both
// breakpoints, and a real page reload; [3] the two states stay apart.
//
// Skips (exit 0) when Chrome is unavailable.
//
// Usage: node scripts/test-members-collapse.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DESKTOP = { w: 1280, h: 900 };
const PHONE = { w: 390, h: 844 };
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9357', 10);
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

const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'public/js/ui.js'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

// The REAL decision, sliced out of core.js — not a paraphrase, so a change to the
// breakpoint fails here instead of passing on a copy of itself.
function layoutSource() {
  const m = core.match(/const MEMBERS_MQ = '[^']+';\r?\nconst membersDrawerLayout = \(\) => [^\n]+;/);
  if (!m) {
    console.error('[test] could not find MEMBERS_MQ / membersDrawerLayout in public/js/core.js');
    process.exit(1);
  }
  return m[0];
}
// ...and the REAL members block out of ui.js: the state helpers, the button's
// routing and the boot repaint, up to the next section (the ⋯ sheet).
function membersSource() {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/ui.js'), 'utf8');
  const a = src.indexOf('/* ---------- the members bar: a drawer on a phone, a column on a desktop');
  const b = src.indexOf('// Mobile header overflow');
  if (a < 0 || b < 0 || b <= a) {
    console.error('[test] could not find the members block in public/js/ui.js');
    process.exit(1);
  }
  return src.slice(a, b);
}

// The real index.html head + body, minus the app scripts (this is a layout test —
// no API), with the sliced logic injected so clicks run the shipping code path.
function pageHtml() {
  const cut = index.indexOf('<script src="/embeds.js">');
  const head = index.slice(0, cut);
  return head + `
<style>*{transition:none!important;animation:none!important}</style>
<script>
document.getElementById('view-auth').classList.add('hidden');
document.getElementById('boot-splash').style.display = 'none';
document.getElementById('view-main').classList.remove('hidden');
</script>
<script>
// ---- the app globals the sliced blocks touch ----
const $ = (s) => document.querySelector(s);
</script>
<script>
${layoutSource()}
</script>
<script>
${membersSource()}
</script>
<script>
var box = (el) => { const r = el.getBoundingClientRect(); return { l: +r.left.toFixed(1), r: +r.right.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
window.__probe = () => {
  const b = $('#btn-members'), m = $('#members'), c = $('#chat');
  let pref = 'ERR';
  try { pref = localStorage.getItem('cf_members_collapsed'); } catch (e) {}
  return {
    vw: innerWidth, vh: innerHeight, sw: document.documentElement.scrollWidth,
    drawerLayout: membersDrawerLayout(),
    collapsed: document.body.classList.contains('members-collapsed'),
    open: document.body.classList.contains('members-open'),
    membersDisplay: getComputedStyle(m).display,
    members: box(m), chat: box(c),
    btnVisible: b.offsetParent !== null, btnDisplay: getComputedStyle(b).display,
    expanded: b.getAttribute('aria-expanded'), title: b.title,
    pref,
  };
};
window.__click = () => $('#btn-members').click();
window.__home = (on) => document.body.classList.toggle('view-home', !!on);
</script>
</body></html>`;
}

function connectWs(url) {
  const WS = globalThis.WebSocket || require('ws');
  const sock = new WS(url, { perMessageDeflate: false });
  const on = (ev, fn) => (typeof sock.addEventListener === 'function' ? sock.addEventListener(ev, fn) : sock.on(ev, fn));
  return { sock, on, send: (s) => sock.send(s), close: () => sock.close() };
}

const inside = (r, vw) => r && r.l >= -1 && r.r <= vw + 1;

function staticChecks() {
  console.log('\n[1] the wiring: one condition, one preference, one control');
  check(/const MEMBERS_MQ = '\(max-width:900px\), \(max-height:560px\) and \(pointer:coarse\)'/.test(core)
    && /const membersDrawerLayout = \(\) =>/.test(core),
    'core.js owns the members drawer condition (the stylesheet\'s 900px block, in one place)');
  check(/body\.members-collapsed #members\{display:none\}/.test(css),
    'the collapsed column is removed from the layout (styles.css)');
  check(/body\.members-collapsed #members\{display:flex\}/.test(css),
    'and the drawer block out-specifies it, so a remembered collapse can never hide the phone drawer');
  check(/\.members-btn\{display:inline-flex/.test(css),
    'the members button is a desktop control now, not a phone-only one');
  check(!/^\s*\.members-btn\{display:none\}/m.test(css),
    'the old "hidden on desktop" rule is gone');
  check(/#btn-threads,\s*#btn-find,\s*#btn-pins,\s*#btn-notifs,\s*#btn-members\{display:none\}/.test(css),
    'the phone header still hands it to the ⋯ sheet (the same five rails, in rail order)');
  const homeRule = css.indexOf('body.view-home:not(.dm-open) #btn-members{display:none!important}');
  const drawerBlock = css.search(/@media \(max-width:900px\),\(max-height:560px\) and \(pointer:coarse\)\{\s*#members\{display:flex/);
  check(homeRule > drawerBlock && drawerBlock > 0,
    'and Home\'s feed only hides it where the drawer is in play (inside that block)');
  check(/if \(membersDrawerLayout\(\)\) \{ document\.body\.classList\.toggle\('members-open'\)/.test(ui)
    && /setMembersCollapsed\(!document\.body\.classList\.contains\('members-collapsed'\)\)/.test(ui),
    'ui.js routes the button by layout: drawer toggle in the drawer shape, collapse in the column shape');
  check(/const MEMBERS_PREF = 'cf_members_collapsed'/.test(ui) && /localStorage\.setItem\(MEMBERS_PREF, '1'\)/.test(ui),
    'the desktop collapse is remembered (cf_members_collapsed)');
  check(/function applyMembersBar\(\)[\s\S]{0,220}membersCollapsedPref\(\)/.test(ui) && /\napplyMembersBar\(\);/.test(ui),
    'and re-applied at boot from the preference, never from a click');
  check(/membersMQ\.addEventListener\('change', onMembersLayout\)/.test(ui),
    'crossing the breakpoint re-evaluates the panel (the drawer flag is dropped for the column)');
  check(/aria-controls="members" aria-expanded="true"/.test(index),
    'the button declares what it controls and starts expanded (index.html)');
}

async function main() {
  staticChecks();

  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found — set CHROME_PATH');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-memcol-'));
  const html = pageHtml();
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/styles.css')) {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end(css);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;

  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(dir, 'prof')}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-dev-shm-usage', `--window-size=${DESKTOP.w},${DESKTOP.h}`, 'about:blank'],
    { stdio: 'ignore' });

  let close = () => {};
  try {
    let info = null;
    for (let i = 0; i < 80 && !info; i++) {
      try { info = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch {}
      if (!info) await sleep(250);
    }
    if (!info) return skip('Chrome did not expose the DevTools port');
    const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const { on, send, close: closeWs } = connectWs(target.webSocketDebuggerUrl);
    close = closeWs;
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
    const ev = async (expression) => {
      const r = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const url = `http://127.0.0.1:${port}/`;
    const load = async () => { await rpc('Page.navigate', { url }); await sleep(700); };
    const device = async (w, h, { touch = false } = {}) => {
      await rpc('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
      await rpc('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: touch ? 2 : 1, mobile: touch });
      await sleep(320);
    };
    const probe = () => ev('__probe()');
    const click = async () => { await ev('__click()'); await sleep(60); return probe(); };

    await rpc('Page.enable');
    await rpc('Runtime.enable');

    console.log('\n[2] desktop: the members column collapses and gives the width back');
    await device(DESKTOP.w, DESKTOP.h, { touch: false });
    await load();
    const base = await probe();
    check(base.drawerLayout === false, 'desktop is the column shape, not the drawer', base);
    check(base.membersDisplay === 'flex' && Math.round(base.members.w) === 244,
      'the members column is on screen at its 244px width', base.members);
    check(Math.abs(base.chat.r - base.members.l) <= 1 && base.members.r <= base.vw + 1,
      'and the chat ends exactly where it starts', { chat: base.chat, members: base.members });
    check(base.btnVisible === true && base.expanded === 'true' && base.title === 'Hide members',
      'the header control is on screen and declares the panel open', base);
    check(base.pref === null, 'nothing is collapsed until the reader asks', base.pref);

    const off = await click();
    check(off.collapsed === true && off.membersDisplay === 'none',
      'clicking the members button collapses the bar out of the layout', off);
    check(Math.abs(off.chat.r - off.vw) <= 1 && Math.abs((off.chat.w - base.chat.w) - base.members.w) <= 1,
      'the chat absorbs the full 244px (nothing overlapping, nothing left behind)', { chat: off.chat, was: base.chat, vw: off.vw });
    check(off.sw <= off.vw + 1, 'and nothing overflows horizontally', { sw: off.sw, vw: off.vw });
    check(off.expanded === 'false' && off.title === 'Show members',
      'the control now reads as "show"', { aria: off.expanded, title: off.title });
    check(off.pref === '1', 'and the collapse is remembered', off.pref);
    check(off.btnVisible === true, 'the control that brings it back is still one click away');

    const shown = await click();
    check(shown.collapsed === false && shown.membersDisplay === 'flex' && Math.round(shown.members.w) === 244,
      'clicking again restores the column at its width', shown.members);
    check(Math.abs(shown.chat.r - shown.members.l) <= 1, 'and the chat gives the space back', { chat: shown.chat, members: shown.members });
    check(shown.pref === null && shown.expanded === 'true', 'with the preference cleared', shown.pref);

    console.log('\n[3] the collapse survives a reload; the drawer shape never inherits it');
    await click(); // collapse again
    await load();  // ...a real page load, so the injected block re-runs its boot repaint
    const reloaded = await probe();
    check(reloaded.collapsed === true && reloaded.membersDisplay === 'none',
      'a reload comes back collapsed (the preference, not the click, decided)', reloaded);
    check(reloaded.pref === '1' && reloaded.expanded === 'false',
      'and the control is painted for it at boot', { pref: reloaded.pref, aria: reloaded.expanded });

    // The drawer starts below 900px — wider than the phone layout's 700px — and
    // the header control is what opens it there (at <=700px the phone header
    // hands it to the ⋯ sheet, which calls this same click).
    await device(820, 900, { touch: true });
    const drawer = await probe();
    check(drawer.drawerLayout === true, 'a narrow touch viewport is the drawer shape', drawer);
    check(drawer.collapsed === false && !drawer.open,
      'the remembered collapse is shelved, not applied to the drawer', drawer);
    check(drawer.membersDisplay === 'flex' && drawer.members.l >= drawer.vw,
      'the drawer is closed and off-screen, exactly as before this feature', drawer.members);
    check(drawer.btnVisible === true, 'the members control is on the header there', drawer);

    const drawerOpen = await click();
    check(drawerOpen.open === true && Math.abs(drawerOpen.members.r - drawerOpen.vw) <= 1,
      'the same button opens the drawer (the ⋯ sheet calls this same click)', drawerOpen.members);
    check(drawerOpen.collapsed === false && drawerOpen.expanded === 'true',
      'and it is a drawer open, never a collapse', drawerOpen);
    const drawerShut = await click();
    check(drawerShut.open === false && drawerShut.members.l >= drawerShut.vw, 'and closes it again', drawerShut.members);

    console.log('\n[4] the two states stay apart');
    await device(PHONE.w, PHONE.h, { touch: true });
    const phoneHeader = await probe();
    check(phoneHeader.btnVisible === false,
      'at phone width the header is the spare one — the ⋯ sheet carries the control (unchanged)', phoneHeader.btnDisplay);
    // The drawer still opens from that route, and a stale collapsed class (the one
    // a desktop collapse would leave behind if the breakpoint were ever lost)
    // cannot hide it: the stylesheet's drawer override is what guarantees that.
    await ev("document.body.classList.add('members-collapsed')");
    const staleOpen = await ev("document.body.classList.add('members-open'); __probe()");
    check(staleOpen.membersDisplay === 'flex' && Math.abs(staleOpen.members.r - staleOpen.vw) <= 1,
      'a stale collapsed class cannot hide the drawer (the stylesheet override)', staleOpen);
    await ev("document.body.classList.remove('members-collapsed','members-open')");

    await device(DESKTOP.w, DESKTOP.h, { touch: false });
    const backToDesk = await probe();
    check(backToDesk.drawerLayout === false && backToDesk.collapsed === true,
      'returning to a desktop restores the remembered collapse', backToDesk);
    const backOn = await click();
    check(backOn.collapsed === false && Math.round(backOn.members.w) === 244, 'and it expands on request', backOn.members);

    // Home's feed: the Active Now panel is the same column there, so the control
    // must be there too — but on a phone the feed uses the inline strip instead
    // and the button has nothing to open.
    await ev('__home(true)');
    const homeDesk = await probe();
    check(homeDesk.btnVisible === true, 'Home\'s feed keeps the members control on a desktop (it collapses the Active Now panel)', homeDesk.btnDisplay);
    const homeOff = await click();
    check(homeOff.collapsed === true && homeOff.membersDisplay === 'none',
      'and it collapses that panel too', homeOff);
    await click();
    await ev('__home(false)');
    await device(PHONE.w, PHONE.h, { touch: true });
    await ev('__home(true)');
    const homePhone = await probe();
    check(homePhone.btnVisible === false,
      'on a phone Home\'s feed still hides it (the Active Now strip stands in)', homePhone.btnDisplay);
    await ev('__home(false)');
  } finally {
    try { close(); } catch {}
    try { chrome.kill(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    try { srv.close(); } catch {}
  }

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
