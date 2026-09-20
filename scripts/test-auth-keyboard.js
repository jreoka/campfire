// The sign-up form with the on-screen keyboard up (see AGENTS.md verification
// conventions).
//
// The complaint: "mom's trying to sign up on her iPhone and there's a blank
// space that appears when the keyboard is open and allows you to scroll and
// covers some of the UI."
//
// #view-auth was the LAST full-screen surface still sized on `100dvh` alone, and
// on iOS the keys shrink only the VISUAL viewport, so `dvh` stayed the full
// screen height. Two failures came out of that one box: the sign-up card FITTED
// the 844px the view still claimed, so the view had nothing to scroll
// (`scrollH === clientH`) while its Sign up button sat below the keys; and with
// no scroller able to reveal the field being typed in, iOS panned the visual
// viewport instead — which dragged the empty page background under the
// (--vvh-sized) shell into view as that blank band and slid the top of the form
// under the status bar. Every other full-screen surface already read the
// keyboard (`html,body`, `#app`, `#view-main`, `#modal-backdrop`,
// `#usercard.sheet`) — see test-mobile-landscape.js [8] for the same contract on
// the status editor.
//
// The fix keys #view-auth to the visible strip exactly like #modal-backdrop:
// `position:fixed` (a fixed box cannot be panned away from the strip),
// `top:var(--vv-top,0px)` (a visual-only engine PANS rather than resizing), and
// `height:var(--vvh,100dvh)` (which also ends the box on the keyboard's top
// edge). The card then overflows the box, safe centring top-aligns it, and the
// form scrolls inside: no band under the box, and the last control reachable.
//
// The keyboard is MODELLED the way the app models it, in place of a browser that
// has none: --vvh is the visible height, --kb how much of the layout box the
// keys cover at the bottom, --vv-top how far the visible strip sits below the
// layout box's top (pickers.js/voice.js keep all three in sync off
// visualViewport). Both keyboard models are measured: the resize one (Android /
// resizes-content) and the visual-only one that PANS (iOS).
//
// The card is driven in SIGN-UP mode — display name + confirm + passkey is the
// tallest the form ever gets, and the screen that was reported.
//
// Skips (exit 0) when Chrome is unavailable.
//
// Usage: node scripts/test-auth-keyboard.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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
const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

// A WS client that works on node's built-in WebSocket (EventTarget) and on the
// `ws` package (EventEmitter) — the other CDP tests require('ws'), a runtime
// dep, but node >= 22 has a global one so this runs without node_modules.
function connectWs(url) {
  const WS = globalThis.WebSocket || require('ws');
  const sock = new WS(url, { perMessageDeflate: false });
  const on = (ev, fn) => (typeof sock.addEventListener === 'function' ? sock.addEventListener(ev, fn) : sock.on(ev, fn));
  return { sock, on, send: (s) => sock.send(s), close: () => sock.close() };
}

// The REAL index.html markup (auth view included) + the REAL stylesheet, minus
// the app scripts — this is a layout test, no API. The turnstile loader is
// dropped too: it is an external script and this test has no network.
function pageHtml() {
  const cut = index.indexOf('<script src="/embeds.js">');
  if (cut < 0) throw new Error('index.html: could not find the first app script tag');
  const head = index.slice(0, cut)
    .replace('<link rel="stylesheet" href="/styles.css" />', `<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">`)
    .replace(/[ \t]*<script src="https:\/\/challenges\.cloudflare\.com[\s\S]*?<\/script>\n?/, '');
  return head + `
<style>*{transition:none!important;animation:none!important}</style>
<script>
document.getElementById('boot-splash').style.display = 'none';
const $$ = (s) => document.querySelector(s);
const box = (sel) => {
  const el = $$(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
};
// The reported screen: sign-up, which is the tallest the card ever gets
// (display name + confirm + passkey). auth.js does this by class in register
// mode; the two hidden wraps are the only parts of it this test needs.
function signUp() {
  document.getElementById('form-auth').classList.add('reg');
  document.getElementById('wrap-display').classList.remove('hidden');
  document.getElementById('wrap-confirm').classList.remove('hidden');
  document.getElementById('btn-auth').textContent = 'Sign up';
  $$('#view-main').classList.add('hidden');
  document.getElementById('view-auth').classList.remove('hidden');
}
// The keyboard, modelled the way the app models it (pickers.js/voice.js):
// --vvh is the visible height, --kb how much of the layout box the keys cover at
// the BOTTOM, --vv-top how far the visible strip sits below the layout box's top
// (a visual-only engine pans the page instead of resizing it).
function kbOn(kb, pan) {
  pan = pan || 0;
  const root = document.documentElement.style;
  root.setProperty('--vvh', (innerHeight - kb) + 'px');
  root.setProperty('--kb', Math.max(0, kb - pan) + 'px');
  root.setProperty('--vv-top', pan + 'px');
}
window.__authKb = (kb, pan) => {
  pan = pan || 0;
  signUp();
  kbOn(kb, pan);
  const vvh = innerHeight - kb;
  const a = document.getElementById('view-auth');
  a.scrollTop = 0;
  const boxR = box('#view-auth');
  const cardR = box('#view-auth .auth-card');
  const logo = box('#view-auth .logo');
  a.scrollTop = 1e9;
  const scrolled = a.scrollTop;
  const cardEnd = box('#view-auth .auth-card');
  const pw = box('#in-password');
  const conf = box('#in-confirm');
  const sub = box('#btn-auth');
  const pk = box('#btn-passkey');
  const clientH = a.clientHeight, scrollH = a.scrollHeight;
  // Nothing under the keys may scroll: the document cannot answer for the view.
  const de = document.scrollingElement;
  de.scrollTop = 1e9;
  const docScrolledTo = de.scrollTop;
  const docRange = Math.max(0, de.scrollHeight - de.clientHeight);
  de.scrollTop = 0;
  a.scrollTop = 0;
  return {
    vw: innerWidth, vh: innerHeight, kb, pan, vvh,
    box: boxR, cardTop: cardR, cardH: cardR.h, cardEnd, logo,
    pw, conf, sub, pk, scrolled, clientH, scrollH,
    canScroll: scrollH > clientH + 1,
    docRange, docScrolledTo,
  };
};
window.__kbOff = () => {
  const root = document.documentElement.style;
  root.removeProperty('--vvh'); root.removeProperty('--kb'); root.removeProperty('--vv-top');
};
// The same view with NO keyboard at all (the layout every other test sees).
window.__authPlain = () => {
  signUp();
  window.__kbOff();
  const a = document.getElementById('view-auth');
  a.scrollTop = 0;
  const boxR = box('#view-auth');
  const cardR = box('#view-auth .auth-card');
  const canScroll = a.scrollHeight > a.clientHeight + 1;
  const de = document.scrollingElement;
  return { vw: innerWidth, vh: innerHeight, box: boxR, card: cardR, canScroll, clientH: a.clientHeight, scrollH: a.scrollHeight,
    docRange: Math.max(0, de.scrollHeight - de.clientHeight), gapTop: +(cardR.t - boxR.t).toFixed(1), gapBottom: +(boxR.b - cardR.b).toFixed(1) };
};
</script>
</body></html>`;
}

async function withChrome(fn) {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found — set CHROME_PATH');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-authkb-'));
  const port = 9560 + Math.floor(Math.random() * 200);
  fs.writeFileSync(path.join(tmp, 'page.html'), pageHtml());
  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(tmp, 'prof')}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-dev-shm-usage', '--window-size=420,900', 'about:blank'], { stdio: 'ignore' });
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
  const device = async (w, h) => {
    await rpc('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await rpc('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await sleep(320);
  };
  try {
    await rpc('Page.enable');
    await rpc('Runtime.enable');
    await rpc('Page.navigate', { url: 'file:///' + path.join(tmp, 'page.html').replace(/\\/g, '/') });
    await sleep(700);
    return await fn({ device, evaluate });
  } finally {
    try { close(); } catch {}
    try { chrome.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ---------------- the checks ----------------
function staticChecks() {
  console.log('\n[1] the auth view wears the keyboard contract, not a dvh');
  const rule = (css.match(/#view-auth\{[^}]*\}/) || [''])[0];
  check(/position:fixed/.test(rule), 'the auth view is position:fixed — a fixed box cannot be panned off the strip', rule);
  check(/left:0;right:0;top:var\(--vv-top,0px\)/.test(rule), 'hung off --vv-top, so a visual-only engine\'s pan carries it', rule);
  check(/height:100vh;height:100dvh;height:var\(--vvh,100dvh\)/.test(rule),
    'and as tall as --vvh (the visible height), with vh/dvh kept as no-JS fallbacks', rule);
  check(/overflow-y:auto/.test(rule) && /overscroll-behavior:contain/.test(rule),
    'it is still the one surface that scrolls, and never rubber-bands the page', rule);
  check(/align-items:center;align-items:safe center/.test(rule) && /justify-content:center;justify-content:safe center/.test(rule),
    'safe centring survives: centred when the card fits, top-aligned (and scrollable) when it does not', rule);
  // The house contract the dialog layer already implements — the two surfaces
  // have to agree on the same three numbers.
  const backdrop = (css.match(/#modal-backdrop\{[^}]*\}/) || [''])[0];
  check(/position:fixed/.test(backdrop) && /top:var\(--vv-top,0px\);bottom:var\(--kb,0px\)/.test(backdrop),
    'the dialog layer reads the same strip (--vv-top/--kb) — the pair agrees', backdrop);
  // No other full-screen surface may be left on dvh alone. The operative
  // declaration is the LAST `height:` in the selector's rules (a later rule
  // wins — #view-main takes `height:100%` from one, #view-auth the var()).
  const heights = (sel) => ((css.match(new RegExp(sel + '\\{[^}]*\\}', 'g')) || []).join(';').match(/height:[^;}]+/g) || []);
  const stray = ['#app', '#view-main', '#view-auth'].filter((s) => {
    const hs = heights(s);
    const last = hs.length ? hs[hs.length - 1] : '';
    return !(last === 'height:100%' || /var\(--vvh/.test(last));
  });
  check(stray.length === 0, 'no full-screen surface is sized on dvh alone any more', { stray });
  check((heights('#view-main') || []).pop() === 'height:100%',
    '#view-main still takes its height from the shell (100%)', heights('#view-main'));
}

async function main() {
  staticChecks();

  await withChrome(async ({ device, evaluate }) => {
    console.log('\n[2] keyboard down: the auth view is the whole screen and the form is centred');
    for (const [w, h] of [[390, 844], [360, 740], [667, 375]]) {
      await device(w, h);
      const p = await evaluate('__authPlain()');
      check(p.box.t === 0 && p.box.b === h && p.box.l === 0 && p.box.r === w,
        `${w}x${h}: the view still covers the layout box with no keyboard`, p.box);
      check(p.docRange === 0, `${w}x${h}: and the page never scrolls`, p);
      if (h >= 700) {
        check(p.canScroll === false, `${w}x${h}: a form that fits has nothing to scroll`, p);
        check(Math.abs(p.gapTop - p.gapBottom) <= 1, `${w}x${h}: the card sits centred in it`, p);
      } else {
        check(p.canScroll === true, `${w}x${h}: a short viewport still scrolls the tall sign-up card`, p);
      }
    }

    console.log('\n[3] the resize model (Android / resizes-content): the box IS the visible strip');
    for (const [w, h, kb] of [[390, 844, 380], [360, 740, 320], [390, 844, 500]]) {
      const tag = `${w}x${h} kb${kb}`;
      await device(w, h);
      const k = await evaluate(`__authKb(${kb})`);
      check(k.vvh === h - kb, `${tag}: the modelled keyboard shortens the visible area`, k);
      check(k.box.t === 0 && k.box.b === k.vvh && k.box.l === 0 && k.box.r === w,
        `${tag}: the auth view IS the strip above the keys`, k.box);
      check(k.docRange === 0 && k.docScrolledTo === 0, `${tag}: no page under the keys to scroll into`, k);
      check(k.cardH > k.clientH && k.canScroll === true, `${tag}: the tall form overflows it and scrolls inside`, k);
      check(Math.abs(k.cardTop.t - 24) <= 1, `${tag}: safe centring top-aligns the card on the view's padding`, k.cardTop);
      check(k.logo.t >= k.box.t - 1, `${tag}: the logo starts on screen at rest (nothing cut off the top)`, { logo: k.logo, box: k.box });
      check(k.scrolled > 0 && Math.abs(k.box.b - k.cardEnd.b - 24) <= 1,
        `${tag}: scrolled to the end the card lands on the bottom padding (no blank tail)`, k);
      check(Math.abs(k.scrollH - (k.cardH + 48)) <= 2,
        `${tag}: the scroller's whole range is the card's own overflow`, { scrollH: k.scrollH, cardH: k.cardH });
      check(k.pw.t >= k.box.t - 1 && k.pw.b <= k.box.b + 1, `${tag}: the field being typed in ends up inside the strip`, { pw: k.pw, box: k.box });
      check(k.sub.t >= k.box.t - 1 && k.sub.b <= k.box.b + 1, `${tag}: and so does the Sign up button`, { sub: k.sub, box: k.box });
      check(k.pk.t >= k.box.t - 1 && k.pk.b <= k.box.b + 1, `${tag}: the passkey button too (the last thing in the form)`, { pk: k.pk, box: k.box });
      await evaluate('__kbOff()');
    }

    console.log('\n[4] the visual-only model (iOS PANS instead of resizing)');
    // The report's engine: the strip is not at y=0, so a box that ignores
    // --vv-top is slid off the visible area while the page behind it is panned
    // into the empty band under the shell.
    for (const [w, h, kb, pan] of [[390, 844, 380, 200], [390, 844, 380, 320], [390, 844, 460, 120]]) {
      const tag = `${w}x${h} kb${kb} pan${pan}`;
      await device(w, h);
      const k = await evaluate(`__authKb(${kb}, ${pan})`);
      check(k.box.t === pan && k.box.b === pan + k.vvh,
        `${tag}: the auth view holds the visible strip, wherever the pan put it`, { box: k.box, strip: [pan, pan + k.vvh] });
      check(k.docRange === 0 && k.docScrolledTo === 0, `${tag}: with no band under the keys to scroll into`, k);
      check(k.canScroll === true && Math.abs(k.cardTop.t - (pan + 24)) <= 1,
        `${tag}: and the card still top-aligns inside the strip`, k.cardTop);
      check(k.sub.t >= k.box.t - 1 && k.sub.b <= k.box.b + 1,
        `${tag}: the Sign up button is reachable inside it`, { sub: k.sub, box: k.box });
      await evaluate('__kbOff()');
    }
  });

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
