// The invite card, measured in a real browser against the REAL stylesheet and
// the REAL public/embeds.js — the offline test pins the markup and states, this
// one pins what a reader actually sees and taps.
//
// What it is here to catch, and why it is worth a browser:
//
//   - the card is a card. Icon, name, live member count and description have to
//     be laid out at the sizes the theme gives them (a 56px icon, a filled
//     indigo button with white ink) and fit a 390px phone without overflowing.
//   - the BUTTON's behaviour, which is the owner's one requirement: someone
//     already in the server gets "Open server" and a click switches to it
//     in-app (no navigation); someone who is not gets "Join server" pointing at
//     the landing page, and clicking that must NOT be swallowed by the
//     delegated handler.
//
// Skips (exit 0) when Chrome is unavailable. Usage:
//   node scripts/test-invite-embeds-browser.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9361', 10);
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

const embedsSrc = () => fs.readFileSync(path.join(ROOT, 'public', 'embeds.js'), 'utf8');

// The page is served over HTTP (not file://) on purpose: the invite card has two
// behaviours depending on whether the link points at THIS app or another
// instance, and `inviteFromUrl` decides that by comparing hosts — which a
// file:// page cannot do (its location has no host at all). Served from
// 127.0.0.1, the invite URL built from location.origin is genuinely same-origin.
function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="/styles.css">
</head><body>
<div id="messages" style="max-width:720px">
  <div class="msg" id="m1"><div class="body"><div class="text">join us</div><div id="slot"></div></div></div>
</div>
<script>
// embeds.js is a classic app script: it uses the app's globals at call time.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]); }
window.__opened = [];
function selectServer(id) { window.__opened.push(id); return Promise.resolve(); }
window.__inviteResponse = null;
window.__fetches = [];
const realFetch = window.fetch.bind(window);
window.fetch = (u, o) => {
  if (String(u).indexOf('/api/invite/') > -1) {
    window.__fetches.push(String(u));
    const r = window.__inviteResponse;
    if (!r) return realFetch(u, o);
    return Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, json: () => Promise.resolve(r.body) });
  }
  return realFetch(u, o);
};
${embedsSrc()}
// The invite under test is always OUR OWN origin, which is what a reader pastes
// from the address bar of this app.
window.__ownInvite = location.origin + '/invite/aB3xK9qZ';
window.__render = (resp, url) => {
  window.__inviteResponse = resp;
  // The card cache is a real cache: a case that wants a different answer for
  // the same link has to clear it, exactly like a reader who reloads would.
  inviteCache.clear();
  // A fresh slot every time: the real list rebuilds its DOM per render, and a
  // card left over from a previous case would answer for the new one.
  const slot = document.getElementById('slot');
  slot.innerHTML = linkEmbedsHTML('join us ' + (url || window.__ownInvite));
  const card = slot.querySelector('.embed-invite');
  // The message list's own observer is what fills a card in the real app; this
  // test drives the same entry point directly.
  scanInviteCards(slot);
  return card;
};
window.__settle = () => new Promise((r) => setTimeout(r, 120));
window.__box = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { w: +r.width.toFixed(2), h: +r.height.toFixed(2), x: +r.left.toFixed(2), right: +r.right.toFixed(2) };
};
window.__cs = (sel, props) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const c = getComputedStyle(el);
  const out = {};
  for (const p of props) out[p] = c.getPropertyValue(p);
  return out;
};
</script>
</body></html>`;
}

// A local stand-in for the app: the real stylesheet, and a real /api/invite
// route (the page's fetch is stubbed, but a request that slips past the stub
// must still get JSON rather than an HTML 404).
function startServer(html) {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const server = require('http').createServer((req, res) => {
    if (req.url.startsWith('/api/invite/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ serverId: 'srv0', joined: false, name: 'Stub', memberCount: 1 }));
    }
    if (req.url.startsWith('/styles.css')) {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      return res.end(css);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-invcard-'));
  const { server: httpServer, port } = await startServer(pageHtml());

  const child = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
    '--window-size=900,900', 'about:blank'], { stdio: 'ignore' });

  let ws;
  try {
    let info = null;
    for (let i = 0; i < 60 && !info; i++) {
      try { info = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); } catch { await sleep(250); }
    }
    if (!info) return skip('Chrome never opened its DevTools port');
    ws = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0;
    const pending = new Map();
    const pageErrors = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params?.exceptionDetails?.exception?.description || 'error');
    });
    const call = (method, params, sessionId) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
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
    await sess('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
    await sleep(900);
    // The phone frame has to be set AFTER the navigation lands: overriding the
    // metrics against about:blank is thrown away by the next navigation.
    await sess('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await sess('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(320);
    if (!(await evaluate('typeof window.__render === "function"'))) {
      console.error('[test] embeds.js did not evaluate in the page');
      process.exit(1);
    }

    console.log('\n[1] the invitation itself: icon, name, members, description, button');
    {
      const r = await evaluate(`(async () => {
        const card = window.__render({ status: 200, body: {
          serverId: 'srv1', joined: false, name: 'Game Night',
          description: 'Friday crew, casual ranked, no sweat.', icon_url: '',
          memberCount: 42,
        }});
        await window.__settle();
        return {
          exists: !!card,
          card: window.__box('.embed-invite'),
          icon: window.__box('.embed-invite .iv-icon'),
          iconCs: window.__cs('.embed-invite .iv-icon', ['border-radius', 'background-color', 'font-size', 'font-weight']),
          name: window.__cs('.embed-invite .iv-name', ['font-size', 'font-weight', 'color']),
          meta: document.querySelector('.embed-invite .iv-meta').textContent,
          desc: document.querySelector('.embed-invite .iv-desc').textContent,
          initial: document.querySelector('.embed-invite .iv-icon').textContent,
          borderLeft: window.__cs('.embed-invite', ['border-left-width', 'border-left-color']),
          btn: window.__box('.embed-invite .emb-go'),
          btnCs: window.__cs('.embed-invite .emb-go', ['background-color', 'color', 'border-radius']),
          label: document.querySelector('.embed-invite .emb-go').textContent,
          href: document.querySelector('.embed-invite .emb-go').getAttribute('href'),
          joinHook: document.querySelector('.embed-invite .emb-go').getAttribute('data-invite-join'),
          head: document.querySelector('.embed-invite .iv-head') ? document.querySelector('.embed-invite .iv-head').textContent : null,
          headCs: window.__cs('.embed-invite .iv-head', ['text-transform', 'font-size', 'font-weight', 'color']),
          vw: innerWidth,
        };
      })()`);
      check(r.exists && r.card && r.card.w > 200, 'the card renders at a real width', r.card);
      check(r.card.w <= r.vw && r.card.right <= r.vw, 'and fits its column', { card: r.card, vw: r.vw });
      check(r.head === 'Invite to Game Night', 'the heading names the invitation, not just the server', r.head);
      check(r.headCs && r.headCs['text-transform'] === 'uppercase' && parseFloat(r.headCs['font-size']) <= 11.5,
        'and it reads as a caption over the server name', r.headCs);
      check(r.icon && Math.round(r.icon.w) === 56 && Math.round(r.icon.h) === 56, 'a 56px server icon', r.icon);
      check(parseFloat(r.iconCs['border-radius']) >= 12, 'rounded like the app\u2019s rail icons', r.iconCs);
      check(r.initial === 'G', 'without an icon it falls back to the server\u2019s initial', r.initial);
      check(/42 members/.test(r.meta), 'the live member count is on it', r.meta);
      check(/Friday crew/.test(r.desc), 'and the server\u2019s description', r.desc);
      check(parseFloat(r.borderLeft['border-left-width']) >= 3, 'the accent hairline marks it as an invitation', r.borderLeft);
      check(r.btn && r.btn.h >= 26, 'the button is a real tap target', r.btn);
      check(r.btnCs['background-color'] === 'rgb(91, 108, 255)', 'filled with the theme accent', r.btnCs);
      check(r.btnCs.color === 'rgb(255, 255, 255)', 'carrying white ink', r.btnCs.color);
      check(r.label === 'Join server' && /\/invite\/aB3xK9qZ$/.test(r.href) && r.joinHook === null,
        'a non-member gets Join server, pointed at the landing page, with no in-place join hook', r);
    }

    console.log('\n[2] a member taps Open server and lands in the server in-app');
    {
      const r = await evaluate(`(async () => {
        window.__opened.length = 0;
        const card = window.__render({ status: 200, body: { serverId: 'srv1', joined: true, name: 'Game Night', memberCount: 42 } });
        await window.__settle();
        const btn = document.querySelector('.embed-invite .emb-go');
        return {
          label: btn.textContent, hook: btn.getAttribute('data-invite-join'),
          attrs: Array.from(btn.attributes).map((a) => a.name + '=' + a.value),
          cardHtml: card ? card.outerHTML.slice(0, 300) : null,
        };
      })()`);
      check(r.label === 'Open server', 'the member is offered Open server', r.label);
      check(r.hook === 'srv1', 'the button names the server to switch to', r);
    }
    {
      const r = await evaluate(`(async () => {
        window.__opened.length = 0;
        const btn = document.querySelector('.embed-invite .emb-go');
        btn.click();
        await window.__settle();
        return { opened: window.__opened.slice(), url: location.href };
      })()`);
      check(r.opened.length === 1 && r.opened[0] === 'srv1', 'and a tap switches to it', r.opened);
      check(!/invite\/aB3xK9qZ/.test(r.url), 'without navigating the page away', r.url);
    }

    console.log('\n[3] a non-member taps Join server and is sent to the landing page');
    {
      const r = await evaluate(`(async () => {
        window.__opened.length = 0;
        await window.__render({ status: 200, body: { serverId: 'srv1', joined: false, name: 'Game Night', memberCount: 42 } });
        await window.__settle();
        const btn = document.querySelector('.embed-invite .emb-go');
        // The delegated handler must not swallow this click: no hook, so the
        // anchor keeps its own navigation. The navigation itself is cancelled
        // here (the page under test is the app, not a copy of the landing
        // page), after recording whether anything else had already cancelled
        // it — which is exactly what "the handler left it alone" means.
        let kept = null;
        btn.addEventListener('click', (e) => { kept = !e.defaultPrevented; e.preventDefault(); });
        btn.click();
        await window.__settle();
        return { kept, opened: window.__opened.slice(), hook: btn.hasAttribute('data-invite-join'), url: location.href };
      })()`);
      check(r.kept === true, 'the click is left to the browser', r);
      check(r.opened.length === 0, 'nothing joins in place', r.opened);
      check(!r.hook && /127\.0\.0\.1/.test(r.url), 'and the page stayed put', r.url);
    }

    console.log('\n[4] a dead invite is a card too, and stays a small one');
    {
      const r = await evaluate(`(async () => {
        await window.__render({ status: 410, body: { error: 'invite_expired' } });
        await window.__settle();
        const dead = document.querySelector('.embed-invite');
        const deadBox = dead ? dead.getBoundingClientRect().height : 0;
        const deadTexts = dead ? dead.textContent : '';
        const hasBtn = !!(dead && dead.querySelector('.emb-go'));
        const deadCls = dead ? dead.className : '';
        // A live card with all the same fields, to compare against: the dead one
        // must not be wearing a server it could not resolve.
        await window.__render({ status: 200, body: {
          serverId: 'srv1', joined: false, name: 'Game Night', memberCount: 42,
          description: 'Friday crew, casual ranked, no sweat.',
        }});
        await window.__settle();
        const live = document.querySelector('.embed-invite');
        return {
          deadTexts, hasBtn, deadCls, deadBox,
          liveBox: live ? live.getBoundingClientRect().height : 0,
          liveBtn: !!(live && live.querySelector('.emb-go')),
        };
      })()`);
      check(/expired/i.test(r.deadTexts), 'an expired link says so on the card', r.deadTexts);
      check(!/Game Night|42 members/.test(r.deadTexts), 'and carries none of the live server\u2019s details', r.deadTexts);
      check(!r.hasBtn && /\bbad\b/.test(r.deadCls), 'with no button, and marked as the dead state', r);
      check(r.liveBtn && r.deadBox < r.liveBox, 'the dead card is the smaller one', r);
    }

    console.log('\n[5] a long server name wraps instead of pushing the card out');
    {
      const r = await evaluate(`(async () => {
        await window.__render({ status: 200, body: {
          serverId: 'srv2', joined: false, memberCount: 1234,
          name: 'The Extremely Long Server Name That Somebody Actually Typed Out',
          description: 'x'.repeat(400),
        }});
        await window.__settle();
        return { card: window.__box('.embed-invite'), vw: innerWidth, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      })()`);
      check(r.card.right <= r.vw + 1, 'the card never runs off the screen', r);
      check(r.overflow <= 0, 'and the page gains no sideways scroll', r);
    }

    console.log('\n[6] an invite from ANOTHER Campfire is never treated as ours');
    {
      const r = await evaluate(`(async () => {
        // Same shape, different host: the card is still drawn (a second instance
        // runs the same app), but it must not claim we are a member of a server
        // on a deployment this session has never talked to.
        await window.__render({ status: 200, body: { serverId: 'srv9', joined: true, name: 'Elsewhere', memberCount: 7 } },
          'https://other.example.net/invite/xyz789');
        await window.__settle();
        const btn = document.querySelector('.embed-invite .emb-go');
        return {
          label: btn ? btn.textContent : null,
          hook: btn ? btn.getAttribute('data-invite-join') : null,
          target: btn ? btn.getAttribute('target') : null,
          rel: btn ? btn.getAttribute('rel') : null,
          href: btn ? btn.getAttribute('href') : null,
        };
      })()`);
      check(r.label === 'Join server', 'a foreign invite is a Join offer, however the other side answers', r);
      check(!r.hook, 'with no in-place switch to a server this session does not have', r);
      check(r.target === '_blank' && /noopener/.test(r.rel || ''), 'and it opens out of app, safely', r);
      check(/^https:\/\/other\.example\.net\/invite\/xyz789$/.test(r.href || ''), 'pointing at the other instance\u2019s landing page', r);
    }

    check(pageErrors.length === 0, 'no uncaught page errors through the whole run', pageErrors.slice(0, 3));
  } catch (e) {
    console.error('[test] ' + (e && e.message));
    process.exit(1);
  } finally {
    try { ws && ws.close(); } catch {}
    try { child.kill(); } catch {}
    try { httpServer.close(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

main();
