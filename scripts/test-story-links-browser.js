// Links on a story's prose surfaces — the TAP CONTRACT, in a real engine.
//
// A story is a full-bleed picture with two transparent buttons over it (the
// prev/next zones) and gestures on top of those, so "the link is clickable" is
// not something CSS review can settle: three separate rules have to line up.
//   1. the caption's bar is pointer-events:none (or the zones stop stepping the
//      story when the reader taps the picture), so the anchors opt back IN;
//   2. a link inside the markup (an .ov-item text sticker) is hit-tested above
//      the zones (.ov-layer.ov-view must out-stack .sv-zone), while the rest of
//      that sticker stays transparent to the tap;
//   3. the preview card is tappable, and the whole bar still fits the stage on a
//      phone.
// This drives the REAL index.html markup, the REAL styles.css and the REAL
// ovPaintLayer/linkifyHTML/storyLinkEmbedsHTML in headless Chrome and asks
// document.elementFromPoint what a finger at that pixel actually lands on.
//
// Skips (exit 0) when Chrome is unavailable.
//
// Usage: node scripts/test-story-links-browser.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9341', 10);
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

// The real dialogs, straight out of index.html: the tap contract is about THIS
// markup (the bar, the zones, the layers), so nothing here is re-typed.
function sliceDialog(src, id, stopAt) {
  const a = src.indexOf('<div id="' + id + '"');
  const b = src.indexOf(stopAt, a);
  if (a < 0 || b < 0 || b <= a) {
    console.error('[test] could not find the ' + id + ' block in public/index.html');
    process.exit(1);
  }
  return src.slice(a, b);
}

function pageHtml() {
  const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const storyView = sliceDialog(index, 'story-view', '<!-- stories: composer');
  const voView = sliceDialog(index, 'vo-view', '<!-- stories: composer');
  const embeds = fs.readFileSync(path.join(ROOT, 'public/embeds.js'), 'utf8');
  // story-edit.js is inlined, not loaded as a module: drop the directive.
  const edit = fs.readFileSync(path.join(ROOT, 'public/js/story-edit.js'), 'utf8').split("'use strict';").join('');
  const shot = 'data:image/svg+xml;base64,' + Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="500"><rect width="100%" height="100%" fill="#123"/></svg>').toString('base64');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
</head><body>
${storyView}
${voView}
<script>
// core.js's esc(), verbatim: embeds.js and story-edit.js call the app's global.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// A file:// page has no /api/unfurl. By default every fetch is parked forever,
// so the card under test is the unfilled stub; setting __unfurl makes the next
// one resolve, which is how the FILLED card is checked.
window.__unfurl = null;
window.fetch = (url) => {
  if (window.__unfurl) return Promise.resolve({ ok: true, json: () => Promise.resolve(window.__unfurl) });
  return new Promise(() => {});
};
</script>
<script>${embeds}</script>
<script>${edit}</script>
<script>
const SHOT = ${JSON.stringify(shot)};
const CAPTION = 'watch https://youtu.be/dQw4w9WgXcQ then read https://example.com/a.';
// mode picks the markup: a sticker with a link in it, or a bare one. They are
// built separately because a long URL wraps into a tall column in the sticker
// box, and two of them would overlap and answer for each other.
window.__buildStory = async (mode) => {
  document.querySelector('#vo-view').classList.add('hidden');
  const sv = document.querySelector('#story-view');
  sv.classList.remove('hidden');
  document.body.classList.add('story-open');
  const stage = document.querySelector('#sv-stage');
  const img = document.querySelector('#sv-img');
  img.src = SHOT;
  await img.decode().catch(() => {});
  const cap = document.querySelector('#sv-cap');
  cap.innerHTML = linkifyHTML(CAPTION);
  cap.classList.remove('hidden');
  const links = document.querySelector('#sv-links');
  links.innerHTML = storyLinkEmbedsHTML(CAPTION);
  links.classList.remove('hidden');
  const ov = document.querySelector('#sv-ov');
  ovFitLayer(ov, stage, img);
  const text = mode === 'plain' ? 'plain sticker' : 'tap https://e.co/x';
  ovPaintLayer(ov, [{ t: 'text', text, x: 0.5, y: 0.3, r: 0, s: 1, color: '#ffffff' }], { editable: false, links: true });
  return true;
};
// A text-only story: a generated gradient (the composer's own shape — a flat
// picture) with the author's text as the markup, and no caption (that field is
// hidden for a text story; the text IS the story). This is the surface the
// owner posts a link on, so it gets its own scenario.
window.__buildTextStory = async (text) => {
  document.querySelector('#vo-view').classList.add('hidden');
  const sv = document.querySelector('#story-view');
  sv.classList.remove('hidden');
  document.body.classList.add('story-open');
  const stage = document.querySelector('#sv-stage');
  const img = document.querySelector('#sv-img');
  img.src = ${JSON.stringify('data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b3a8f"/><stop offset="1" stop-color="#7b2d63"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>').toString('base64'))};
  await img.decode().catch(() => {});
  const cap = document.querySelector('#sv-cap');
  cap.innerHTML = '';
  cap.classList.add('hidden');
  const links = document.querySelector('#sv-links');
  links.innerHTML = storyLinkEmbedsHTML(text);
  links.classList.toggle('hidden', !links.innerHTML);
  const ov = document.querySelector('#sv-ov');
  ovFitLayer(ov, stage, img);
  ovPaintLayer(ov, [{ t: 'text', text, x: 0.5, y: 0.42, r: 0, s: 1, color: '#ffffff' }], { editable: false, links: true });
  return true;
};
// How many text lines a box actually took, from its height and its font.
window.__lines = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.14);
  return Math.round(el.getBoundingClientRect().height / lh);
};
window.__buildVo = async () => {
  document.querySelector('#story-view').classList.add('hidden');
  const vo = document.querySelector('#vo-view');
  vo.classList.remove('hidden');
  const stage = document.querySelector('#vo-stage');
  let img = stage.querySelector('img');
  if (!img) { img = document.createElement('img'); img.id = 'vo-img'; stage.appendChild(img); }
  img.src = SHOT;
  await img.decode().catch(() => {});
  const cap = document.querySelector('#vo-cap');
  cap.innerHTML = linkifyHTML('read https://example.com/keep');
  cap.classList.remove('hidden');
  const ov = document.querySelector('#vo-ov');
  ovFitLayer(ov, stage, img);
  ovPaintLayer(ov, [{ t: 'text', text: 'in markup https://example.com/ov', x: 0.5, y: 0.3, r: 0, s: 1, color: '#ffffff' }], { editable: false, links: true });
  return true;
};
// The composer's copy: a bare overlay layer, fitted to a stage and painted the
// way storyPaintOv paints it (editable + links), to prove the editor shows the
// same chip the reader will see — and that the chip is dead under the finger
// there, or it would steal the drag that moves the sticker.
window.__buildComposer = async (text) => {
  const host = document.createElement('div');
  host.id = 'cbox';
  host.style.cssText = 'position:fixed;left:0;top:0;width:390px;height:700px;z-index:200';
  const img = document.createElement('img');
  img.src = SHOT;
  host.appendChild(img);
  const layer = document.createElement('div');
  layer.className = 'ov-layer ov-editable';
  host.appendChild(layer);
  document.body.appendChild(host);
  await img.decode().catch(() => {});
  ovFitLayer(layer, host, img);
  ovPaintLayer(layer, [{ t: 'text', text, x: 0.5, y: 0.42, r: 0, s: 1, color: '#ffffff' }], { editable: true, selected: null, links: true });
  return true;
};
window.__composer = () => {
  const a = document.querySelector('#cbox .ov-item a');
  if (!a) return null;
  return {
    text: a.textContent,
    lines: Math.round(a.getBoundingClientRect().height / (parseFloat(getComputedStyle(a).lineHeight) || 1)),
    events: getComputedStyle(a).pointerEvents,
    boxH: Math.round(a.closest('.ov-item').getBoundingClientRect().height),
    itemEvents: getComputedStyle(a.closest('.ov-item')).pointerEvents,
  };
};
// What a finger at (x,y) lands on, and whether that element is (or is inside) a
// link — which is exactly the question the zones' pointerup listener asks.
window.__hit = (x, y) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return { at: 'nothing', link: false };
  return {
    at: el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : ''),
    link: !!(el.closest && el.closest('a[href]')),
  };
};
// The centre of the first link matching the selector, and a point on the first
// LINE of its sticker (above the link, which wraps below the words before it).
window.__points = (sel) => {
  const a = document.querySelector(sel);
  if (!a) return null;
  const ab = a.getBoundingClientRect();
  const item = a.closest('.ov-item');
  const ib = item ? item.getBoundingClientRect() : null;
  return {
    link: { x: ab.left + ab.width / 2, y: ab.top + ab.height / 2 },
    head: ib ? { x: ib.left + ib.width / 2, y: ib.top + Math.min(6, ib.height / 4) } : null,
  };
};
window.__rect = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
};
window.__css = (sel, prop) => {
  const el = document.querySelector(sel);
  return el ? getComputedStyle(el)[prop] : null;
};
</script>
</body></html>`;
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-storylinks-'));
  const htmlPath = path.join(dir, 'links.html');
  fs.writeFileSync(htmlPath, pageHtml());

  const child = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=1100,800', 'about:blank'], { stdio: 'ignore' });

  let ws;
  try {
    let info = null;
    for (let i = 0; i < 60 && !info; i++) {
      try { info = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); } catch { await sleep(250); }
    }
    if (!info) return skip('Chrome never opened its DevTools port');

    ws = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 128 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0;
    const pending = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
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
    const evaluate = async (expression) => {
      const r = await sess('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'page error');
      return r.result.value;
    };
    // Centre of the first link inside `sel`, in CSS pixels.
    const linkPoint = async (sel) => {
      const r = await evaluate('(() => { const a = document.querySelector(' + JSON.stringify(sel) + '); if (!a) return null;'
        + ' const b = a.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()');
      return r;
    };

    await sess('Page.enable');
    await sess('Runtime.enable');
    await sess('Page.navigate', { url: 'file:///' + htmlPath.replace(/\\/g, '/') });
    await sleep(1000);
    if (!(await evaluate('typeof linkifyHTML === "function" && typeof ovPaintLayer === "function"'))) {
      console.error('[test] embeds.js / story-edit.js did not evaluate in the page');
      process.exit(1);
    }

    for (const vp of [{ w: 1100, h: 800, label: 'desktop', touch: false }, { w: 390, h: 844, label: 'phone portrait', touch: true }, { w: 844, h: 390, label: 'phone landscape', touch: true }]) {
      console.log('\n[' + vp.label + ' ' + vp.w + 'x' + vp.h + '] the bar is transparent, the links are not');
      await sess('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.touch });
      await sess('Emulation.setTouchEmulationEnabled', { enabled: vp.touch, maxTouchPoints: vp.touch ? 5 : 1 });
      await evaluate('window.__buildStory("linked")');
      await sleep(250);

      const capP = await evaluate('window.__points("#sv-cap a")');
      check(!!capP, 'the caption link is in the layout', capP);
      if (capP) {
        const hit = await evaluate('window.__hit(' + capP.link.x + ',' + capP.link.y + ')');
        check(hit.link, 'a tap on the caption link reaches the link (not the prev/next zone)', hit);
      }
      const ovP = await evaluate('window.__points("#sv-ov .ov-item a")');
      check(!!ovP, 'the markup link is in the layout', ovP);
      if (ovP) {
        const hit = await evaluate('window.__hit(' + ovP.link.x + ',' + ovP.link.y + ')');
        check(hit.link, 'a tap on a link in the markup reaches it (it out-stacks the zone)', hit);
        const head = await evaluate('window.__hit(' + ovP.head.x + ',' + ovP.head.y + ')');
        check(!head.link && /sv-zone/.test(head.at),
          'the sticker\'s own words around the link still step the story', head);
      }

      // The rest of the bar must leave the tap alone.
      const capBox = await evaluate('window.__rect("#sv-cap")');
      const linkBox = await evaluate('window.__rect("#sv-links")');
      if (capBox && linkBox) {
        const gapY = (capBox.bottom + linkBox.y) / 2;
        const hit = await evaluate('window.__hit(' + (vp.w / 2) + ',' + gapY + ')');
        check(!hit.link, 'the gap in the bar still steps the story', hit);
      }

      // The opt-ins, while the linked sticker is still the one on screen.
      check(await evaluate('window.__css(".sv-below", "pointerEvents")') === 'none', 'the bar declares pointer-events:none', null);
      check(await evaluate('window.__css(".sv-cap a", "pointerEvents")') === 'auto', 'the caption anchor opts back in', null);
      check(await evaluate('window.__css(".sv-links .embed-link", "pointerEvents")') === 'auto', 'the card opts back in', null);
      check(await evaluate('window.__css("#sv-ov a", "pointerEvents")') === 'auto', 'and a markup anchor does too', null);

      // The preview card is a real target, and the bar never leaves the stage.
      const card = await evaluate('window.__points("#sv-links a")');
      check(!!card, 'the preview card is in the layout', card);
      if (card) {
        const hit = await evaluate('window.__hit(' + card.link.x + ',' + card.link.y + ')');
        check(hit.link, 'a tap on the card opens it', hit);
      }
      const stage = await evaluate('window.__rect("#sv-stage")');
      const bar = await evaluate('window.__rect(".sv-below")');
      check(!!stage && !!bar && bar.x >= stage.x - 1 && bar.right <= stage.right + 1,
        'the bar stays inside the stage', { stage, bar });
      check(!!stage && !!bar && bar.y >= stage.y - 1 && bar.bottom <= stage.bottom + 1,
        'and never overflows the picture', { stage, bar });
      check(!!bar && bar.w <= vp.w, 'and fits the viewport', { bar, vw: vp.w });
      // The stage is the short one on a phone held sideways: a story bar that
      // eats most of it leaves no picture to look at.
      check(!!stage && !!bar && bar.h <= stage.h * 0.62, 'and leaves most of the picture visible', { barH: bar && Math.round(bar.h), stageH: stage && Math.round(stage.h) });

      // A sticker with no link at all is inert — that is what makes the link
      // inside the other one a targeted change rather than "the layer is live".
      await evaluate('window.__buildStory("plain")');
      await sleep(150);
      const plain = await evaluate('(() => { const el = document.querySelector("#sv-ov .ov-item"); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()');
      const plainHit = await evaluate('window.__hit(' + plain.x + ',' + plain.y + ')');
      check(!plainHit.link && /sv-zone/.test(plainHit.at), 'a text sticker with no link is still a tap on the story', plainHit);
    }

    console.log('\n[text story] the link is a card under a sticker that still reads');
    await sess('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sess('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    // The card FILLS: this is the path that matters (an unfurled title, site and
    // thumbnail), and the one the parked-fetch scenario above cannot see.
    await evaluate(`window.__unfurl = { embed: { host: 'example.com', site: 'Example', title: 'A page worth opening', description: 'The unfurled summary lands in the card.', image: SHOT } }`);
    const URL_TXT = 'read this https://example.com/a/very/long/path/that/keeps/going';
    await evaluate('window.__buildTextStory(' + JSON.stringify(URL_TXT) + ')');
    await sleep(400);
    const filled = await evaluate('(() => { const c = document.querySelector("#sv-links a.embed-link");'
      + ' return c ? { title: (c.querySelector(".el-title") || {}).textContent || "", site: (c.querySelector(".el-site") || {}).textContent || "", img: !!c.querySelector(".el-img") } : null; })()');
    check(!!filled && filled.title === 'A page worth opening' && filled.site === 'Example' && filled.img,
      'the card fills in from the unfurl (title, site and thumbnail)', filled);

    const stick = await evaluate('window.__rect("#sv-ov .ov-item")');
    const anchor = await evaluate('window.__rect("#sv-ov .ov-item a")');
    const stage2 = await evaluate('window.__rect("#sv-stage")');
    const lines = await evaluate('window.__lines("#sv-ov .ov-item a")');
    check(!!anchor, 'the URL in the sticker is a real anchor', anchor);
    // The URL is one unbroken token, so it has to wrap — but a sticker that
    // wraps it a handful of characters to a line reads as a ladder, not a link.
    check(lines !== null && lines <= 3, 'the URL wraps into at most three lines', { lines, stick, anchor });
    check(!!stick && !!stage2 && stick.x >= stage2.x - 1 && stick.right <= stage2.right + 1,
      'the sticker stays inside the picture', { stick, stage2 });
    const cardPt = await evaluate('window.__points("#sv-links a")');
    const cardHit = cardPt && await evaluate('window.__hit(' + cardPt.link.x + ',' + cardPt.link.y + ')');
    check(!!cardHit && cardHit.link, 'and the filled card is tappable', cardHit);
    const shotPng = (await sess('Page.captureScreenshot', { format: 'png' }));
    const shotPath = path.join(os.tmpdir(), 'campfire-story-link.png');
    fs.writeFileSync(shotPath, Buffer.from(shotPng.data, 'base64'));
    console.log('  (screenshot: ' + shotPath + ')');

    console.log('\n[composer] the preview shows the same chip, and it is dead while editing');
    await evaluate('window.__buildComposer(' + JSON.stringify(URL_TXT) + ')');
    await sleep(200);
    const comp = await evaluate('window.__composer()');
    check(!!comp && comp.text === 'https://example.com/a/very/long/path/that/keeps/going',
      'the composer renders the URL as a chip, not a ladder', comp);
    check(!!comp && comp.lines === 1, 'and the chip is one line', comp);
    check(!!comp && comp.events === 'none', 'the chip cannot be clicked mid-edit', comp);
    check(!!comp && comp.itemEvents === 'auto', 'while the sticker around it still takes the drag', comp);
    await evaluate('document.querySelector("#cbox").remove()');

    console.log('\n[view-once] a link in a one-shot does not consume the view');
    await sess('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate('window.__buildVo()');
    await sleep(200);
    for (const sel of ['#vo-cap a', '#vo-ov .ov-item a']) {
      const p = await linkPoint(sel);
      check(!!p, 'the link is in the layout: ' + sel, p);
      if (!p) continue;
      const hit = await evaluate('window.__hit(' + p.x + ',' + p.y + ')');
      // The stage's own click handler bails on `e.target.closest('a[href]')`, so
      // the anchor being the hit target IS the guarantee that the view survives.
      check(hit.link, 'the tap lands on the link: ' + sel, hit);
    }
  } catch (e) {
    console.error('[test] ' + (e && e.message));
    process.exit(1);
  } finally {
    try { ws && ws.close(); } catch {}
    try { child.kill(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}
main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
