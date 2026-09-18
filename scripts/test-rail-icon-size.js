// The server rail's icons are ONE size, and the active pill is pinned to the
// rail's own left edge (see AGENTS.md verification conventions).
//
// Two owner asks shaped this. First "make the server rail icons all a bit
// smaller": every rail icon — home, the DM avatars, servers, folders, the ＋ and
// the admin shield — is the same square in one column, and five different rules
// used to restate 48px for it, so a change had to be made in five places and
// could be made in four. They now all read --rail-ico, and the things derived
// from that size are derived in CSS too: the active pill's offset (the icons are
// centred, so it is exactly half of what the rail has left over), the campfire
// art's 3px inset, and the open folder's panel.
//
// Then "make the server rail and its icons larger on mobile/tablet only": the
// rail is the primary navigation there and it carried the smallest icons in the
// app (40px on the phone, under the 44px a thumb can hit), so ONE touch rule
// ("a larger rail for touch") restates both numbers upward — 52px in a 72px
// rail — for a phone AND a tablet, and nothing on the desktop moves.
//
// This test has two halves:
//   [0] static wiring, always: the size is one variable (restated only by the
//       touch rule), every box reads it, the pill never goes back to a number,
//       no rail glyph is left at a size that no longer matches its box, and the
//       touch rule is genuinely larger than the desktop one;
//   [1] the REAL stylesheet in headless Chrome against a fixture that mirrors the
//       live rail, at a desktop, a phone and a tablet viewport: every icon is the
//       documented square, they share one column, the pill lands on the rail's
//       edge, the badge stays inside, and the desktop rail did NOT change (the
//       owner asked for larger icons on touch, not a different desktop).
//
// Skips the browser half (exit 0) when Chrome is unavailable.
//
// Usage: node scripts/test-rail-icon-size.js

'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9356', 10);
const DESKTOP_ICO = 44;
const DESKTOP_RAIL = 64;
// Phone and tablet share one touch size, deliberately: one rule, one number.
const TOUCH_ICO = 52;
const TOUCH_RAIL = 72;

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
const serversJs = fs.readFileSync(path.join(ROOT, 'public/js/servers.js'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

// The real rail markup for the parts that are static in index.html, plus the
// buttons servers.js builds (a letter server, an icon server, an unread one, a
// plain folder, an open folder with its panel) — the same shapes it produces.
const ADD_SVG = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const ADMIN_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5l7.5 3.2v5.1c0 4.7-3.1 8.8-7.5 10.2-4.4-1.4-7.5-5.5-7.5-10.2V5.7z"/><path d="M8.8 11.8l2.2 2.2 4.3-4.3"/></svg>';
// A 1x1 PNG: a server icon is an <img>, and its size is the button's (servers.js
// writes width/height:100% inline — see the static check below).
const DOT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const ICON_IMG = `style="width:100%!important;height:100%!important;object-fit:cover!important;border-radius:inherit!important;display:block!important;pointer-events:none!important"`;

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/styles.css">
</head><body>
<section id="view-main"><div id="left">
  <nav id="rail" aria-label="Servers">
    <div class="rail-head">
      <span id="home-wrap"><button id="btn-home" class="server-btn home-btn active" title="Home"><img src="${DOT}" alt="Home" /><svg class="home-fire" viewBox="0 0 51 51" aria-hidden="true"></svg></button></span>
      <div id="dm-rail"><button class="server-btn" title="Ana"><span class="avatar">A</span></button></div>
    </div>
    <div class="rail-divider" aria-hidden="true"></div>
    <div id="server-list">
      <button id="btn-add-server" title="Create or join a server">${ADD_SVG}</button>
      <button id="btn-admin" aria-label="Site admin console" title="Site admin console">${ADMIN_SVG}</button>
      <button class="server-btn" title="Studio">S</button>
      <button class="server-btn has-icon" title="Icon server"><img src="${DOT}" alt="" ${ICON_IMG} /></button>
      <div class="fwrap"><button class="folder-btn" title="Games" style="--fcolor:#5865f2"><span class="fgrid fg2"><span class="fc"><span class="fc-letter">A</span></span><span class="fc"><span class="fc-letter">B</span></span></span></button></div>
      <div class="fwrap active"><button class="folder-btn open" title="Open folder" style="--fcolor:#5865f2"><span class="fgrid fg1"><span class="fc"><span class="fc-letter">C</span></span></span></button></div>
      <div class="folder-open" style="--fcolor:#5865f2">
        <button class="server-btn" title="Game one">G</button>
        <button class="server-btn active unread" data-unread="7" title="Game two">H</button>
      </div>
      <button class="server-btn unread" data-unread="3" title="Design">D</button>
    </div>
  </nav>
  <aside id="sidebar"><span>sidebar</span></aside>
</div><main id="chat"></main></section>
<script>
const rect = (el) => el.getBoundingClientRect();
const box = (el) => { const r = rect(el); return { l: +r.left.toFixed(1), r: +r.right.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
window.__probe = function () {
  const rail = document.getElementById('rail');
  const railBox = box(rail);
  const list = document.getElementById('server-list');
  // Every button in the rail: home + DM avatars + servers + folders + ＋ + shield
  // + the servers a folder has expanded.
  const icons = [...rail.querySelectorAll('.server-btn, .folder-btn, #btn-add-server, #btn-admin')];
  // The three active marks, one per owner of a pill.
  const pillOf = (el) => {
    const s = getComputedStyle(el, '::before');
    if (s.content === 'none') return null;
    const r = rect(el);
    const left = r.left + parseFloat(s.left || '0');
    return { left: +(left - railBox.l).toFixed(1), w: +parseFloat(s.width).toFixed(1), h: +parseFloat(s.height).toFixed(1) };
  };
  const out = {
    ico: getComputedStyle(document.getElementById('left')).getPropertyValue('--rail-ico').trim(),
    railW: getComputedStyle(document.getElementById('left')).getPropertyValue('--rail-w').trim(),
    rail: railBox,
    icons: icons.map((el) => Object.assign({ sel: el.id || el.className.split(' ').find((c) => c !== 'active' && c !== 'unread' && c !== 'has-icon') }, box(el))),
    // The image that fills an icon button, and the art inside the home button.
    serverIconImg: box(rail.querySelector('.server-btn.has-icon img')),
    homeArt: box(document.querySelector('#home-wrap .home-btn img')),
    homeFire: box(document.querySelector('#home-wrap .home-fire')),
    panel: box(rail.querySelector('.folder-open')),
    addGlyph: box(document.querySelector('#btn-add-server svg')),
    adminGlyph: box(document.querySelector('#btn-admin svg')),
    cells: [...rail.querySelectorAll('.fc')].map((el) => +rect(el).width.toFixed(1)),
    pills: {
      server: pillOf(rail.querySelector('.folder-open .server-btn.active')),
      folder: pillOf(rail.querySelector('.fwrap.active .folder-btn')),
      home: pillOf(document.querySelector('#home-wrap')),
    },
    // The unread badge is a ::after 4px outside its icon's bottom-right corner.
    badgeRight: (() => {
      const el = rail.querySelector('#server-list > .server-btn.unread');
      const s = getComputedStyle(el, '::after');
      return { right: s.right, w: s.width, h: s.height, iconRight: +rect(el).right.toFixed(1) };
    })(),
    // Everything the rail paints has to stay inside it (it clips).
    overflow: icons.filter((el) => { const r = rect(el); return r.left < railBox.l - 0.6 || r.right > railBox.r + 0.6; }).length,
    listScrolls: list.scrollWidth > Math.ceil(list.clientWidth) + 1,
  };
  return out;
};
</script>
</body></html>`;
}

async function main() {
  console.log('\n[0] one size for every rail icon, and the pill is derived from it');
  check(/--rail-ico:44px/.test(css), 'the rail icon size is a :root variable (44px)');
  check(/--rail-w:64px/.test(css), 'beside the rail width it is measured against');
  for (const sel of ['\\.server-btn', '#btn-add-server', '#btn-admin', '\\.fwrap', '\\.folder-btn', '#home-wrap']) {
    const re = new RegExp(sel + '\\{[^}]*width:var\\(--rail-ico\\)[^}]*height:var\\(--rail-ico\\)');
    check(re.test(css.replace(/\n/g, '')), `the ${sel.replace(/\\/g, '')} box reads it (width and height)`);
  }
  check(!/\.server-btn\{width:48px/.test(css) && !/#btn-add-server\{width:48px/.test(css) && !/#btn-admin\{[^}]*width:48px/.test(css),
    'no rail box restates the old 48px');
  check((css.match(/left:calc\(\(var\(--rail-ico\) - var\(--rail-w\)\) \/ 2\)/g) || []).length === 3,
    'the active pill (server, folder, home) is pinned by the icons\' own gutter, not a number',
    (css.match(/left:calc\(\(var\(--rail-ico\) - var\(--rail-w\)\) \/ 2\)/g) || []).length);
  check(!/\.(server-btn|folder-btn)[^{]*\{[^}]*left:-8px/.test(css) && !/#home-wrap[^{]*\{[^}]*left:-8px/.test(css),
    'and no pill rule went back to the hard-coded -8px');
  check(/#left\{--rail-w:72px;--rail-ico:52px\}/.test(css),
    'the touch rule restates BOTH numbers, larger (72px rail, 52px icons)');
  const deskIco = +((css.match(/--rail-ico:(\d+)px/) || [])[1] || 0);
  const touchIco = +((css.match(/#left\{--rail-w:\d+px;--rail-ico:(\d+)px\}/) || [])[1] || 0);
  check(touchIco > deskIco, 'and it really is larger than the desktop rail, not a restatement of it',
    { desktop: deskIco, touch: touchIco });
  check(/@media \(max-width:700px\),\(pointer:coarse\) and \(min-width:701px\) and \(max-width:1400px\)\{/.test(css),
    'one rule covers the phone AND the tablet (a touch desktop monitor is left out)');
  check(!/#left \.(server-btn|fwrap|folder-btn)[^{]*\{width:44px/.test(css),
    'and no longer restates icon boxes of its own (the variable carries them)');
  check(/\.home-btn img\{width:calc\(var\(--rail-ico\) - 6px\)/.test(css) && /\.home-btn \.home-fire\{[^}]*width:calc\(var\(--rail-ico\) - 6px\)/.test(css),
    'the campfire art keeps its 3px inset at any icon size');
  check(/\.folder-open\{[^}]*width:calc\(var\(--rail-ico\) \+ 4px\)/.test(css),
    'the open folder\'s panel is the icon plus its own 2px padding');
  check(/#btn-add-server svg\{display:block;width:26px;height:26px\}/.test(css) && /#btn-admin svg\{display:block;width:22px;height:22px\}/.test(css),
    'the ＋ and the shield glyphs keep their proportion to the desktop box (26px / 22px)');
  check(/#left #btn-add-server svg\{width:30px;height:30px\}/.test(css) && /#left #btn-admin svg\{width:26px;height:26px\}/.test(css),
    'with a larger step for the touch box');
  check(/#left \.fg1\{grid-template-columns:24px\}/.test(css) && /#left \.fc\{width:19px;height:19px\}/.test(css) && /#left \.fg1 \.fc\{width:24px;height:24px\}/.test(css),
    'the folder preview cells grow with the touch box (19px, 24px for a one-cell folder)');
  check(/#left \.server-btn\{font-size:1\.35rem\}/.test(css) && /#left #dm-rail \.server-btn \.avatar\{font-size:1\.35rem\}/.test(css),
    'and the letter a letter-server / DM avatar carries grows with it');
  check(/\.fwrap\.active \.folder-btn::before\{[^}]*width:4px;height:22px\}/.test(css),
    'the phone still slims the pill itself (width/height), only its offset is derived');
  check(/width:100%!important;height:100%!important/.test(serversJs) && !/img\.width = 48/.test(serversJs),
    'a server icon IMAGE fills its button rather than restating 48px');
  // Which only works because the buttons carry no padding of their own: the UA's
  // 1px 6px button padding made the content box 32x42, so a 100% avatar came out
  // letterboxed inside the icon (and a fixed 48px was the workaround).
  for (const sel of ['\\.server-btn', '\\.folder-btn', '#btn-add-server', '#btn-admin']) {
    const re = new RegExp(sel + '\\{[^}]*padding:0');
    check(re.test(css), `the ${sel.replace(/\\/g, '')} box is the icon (no UA padding to letterbox an avatar)`);
  }

  const chromePath = findChrome();
  if (!chromePath) {
    console.log('\n[1] SKIP the browser half: no Chrome/Edge found (set CHROME_PATH)');
    return finish();
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-rail-ico-'));
  const srv = http.createServer((req, res) => {
    if ((req.url || '/').startsWith('/styles.css')) {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      return res.end(css);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(pageHtml());
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;

  const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

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
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const call = (method, params, sessionId) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (m) => (m.error ? rej(new Error(method + ' — ' + JSON.stringify(m.error))) : res(m.result)));
      ws.send(JSON.stringify({ id: i, sessionId, method, params }));
    });
    const targetId = (await call('Target.createTarget', { url: 'about:blank' })).targetId;
    const sessionId = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    const sess = (m, p) => call(m, p, sessionId);
    const evaluate = async (expression) => {
      const r = await sess('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'page error');
      return r.result.value;
    };
    await sess('Page.enable');
    await sess('Runtime.enable');

    for (const [tag, vw, vh, mobile, ico, rail] of [
      ['desktop', 1280, 900, false, DESKTOP_ICO, DESKTOP_RAIL],
      ['phone', 390, 844, true, TOUCH_ICO, TOUCH_RAIL],
      ['tablet', 834, 1112, true, TOUCH_ICO, TOUCH_RAIL],
    ]) {
      const deskLayout = tag === 'desktop';
      // The phone LAYOUT slims the active pill; the tablet gets the desktop's.
      const phoneLayout = tag === 'phone';
      console.log(`\n[1] ${tag}: every rail icon is ${ico}px in a ${rail}px rail`);
      // Touch emulation is what makes `pointer:coarse` true, exactly like a real
      // phone or tablet — the touch rail hangs off that, so it has to be on.
      await sess('Emulation.setTouchEmulationEnabled', { enabled: !deskLayout, maxTouchPoints: deskLayout ? 1 : 5 });
      await sess('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 2, mobile });
      await sess('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
      await sleep(400);
      const p = await evaluate('window.__probe()');

      check(p.ico === ico + 'px' && p.railW === rail + 'px', `the rail reads --rail-ico:${ico}px inside --rail-w:${rail}px`, { ico: p.ico, rail: p.railW });
      check(Math.abs(p.rail.w - rail) <= 1, `the rail really is ${rail}px wide`, { w: p.rail.w });
      check(p.icons.length >= 9, 'every button in the rail was measured', p.icons.length);
      const sizes = [...new Set(p.icons.map((i) => i.w + 'x' + i.h))];
      check(sizes.length === 1 && sizes[0] === ico + 'x' + ico, `all of them are the same square (${ico}px)`, sizes);
      const lefts = [...new Set(p.icons.map((i) => i.l))];
      check(lefts.length === 1, 'and they share one column (home, DMs, servers, folders, ＋, shield, an open folder\'s servers)', lefts);
      check(p.overflow === 0, 'nothing the rail paints falls outside it', p.overflow);
      check(p.listScrolls === false, 'and the icon column never scrolls sideways', p.listScrolls);

      check(p.serverIconImg.w === ico && p.serverIconImg.h === ico, 'a server ICON image fills the button exactly', p.serverIconImg);
      check(p.homeArt.w === ico - 6 && p.homeFire.w === ico - 6, `the campfire art keeps its 3px inset (${ico - 6}px)`, { img: p.homeArt, fire: p.homeFire });
      check(p.panel.w === ico + 4, `an open folder\'s panel is the icon plus its 2px padding (${ico + 4}px)`, p.panel);
      check(p.addGlyph.w === (deskLayout ? 26 : 30) && p.adminGlyph.w === (deskLayout ? 22 : 26),
        'the ＋ and the shield scale with the box', { add: p.addGlyph.w, admin: p.adminGlyph.w });
      check(p.cells.join(',') === (deskLayout ? '16,16,20' : '19,19,24'),
        'the folder preview cells scale too (a one-cell folder keeps its larger preview)', p.cells);

      for (const [name, pill] of Object.entries(p.pills)) {
        check(!!pill, `the ${name}'s active pill exists`);
        check(pill && Math.abs(pill.left) <= 0.6, `and sits on the rail's own left edge (${name})`, pill);
      }
      check(p.pills.server && p.pills.server.w === (phoneLayout ? 4 : 6) && p.pills.server.h === (phoneLayout ? 22 : 28),
        `the ${tag} pill keeps its own bar`, p.pills.server);
      check(p.badgeRight.right === '-4px' && p.badgeRight.iconRight + 4 <= p.rail.r + 0.5,
        'an unread badge still hangs inside the rail, off the icon\'s corner', p.badgeRight);
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
  return finish();
}

function finish() {
  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
