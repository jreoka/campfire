// A link on a story is the CARD on every surface that previews the story — the
// story center's hero, the portrait cards, the rings.
//
// The complaint: Home → Stories, your own story's card drew the raw URL as a
// ladder of characters across the "Your story" title and the Watch/Add buttons
// instead of the little embed card the viewer and the composer already paint.
// Three faults stacked up, and each one is measured here:
//
//   1. storyThumbWithMarkup() painted the markup layer WITHOUT `links: true`, so
//      a sticker that is a URL stayed a raw URL (the viewer, the view-once
//      player and the composer all pass it — the thumbnails were the one
//      surface left out);
//   2. the wrapper it hands back never established a containing block, and the
//      layer inside it is `position:absolute` — so on an unpositioned surface
//      (`.sp-hero-media` on the story center's big card) the layer resolved
//      against whatever ancestor happened to be positioned;
//   3. ovFitLayer() fitted the layer to the media's whole `cover` content box.
//      For a portrait story in the story center's landscape banner that box is
//      6.8x the height of the visible slice, so the sticker's own geometry —
//      including its font size, 8.5% of the layer's height — was computed
//      against a box that is almost entirely off-screen, and the card was
//      clipped out of the picture altogether.
//
// This drives the REAL storyThumbEl/storyThumbWithMarkup out of
// public/js/stories.js and the REAL ovPaintLayer/ovFitLayer out of
// public/js/story-edit.js against the REAL styles.css and embeds.js in headless
// Chrome: it builds the wrapper exactly the way spHero/spCard/storyRing do (same
// class, same real CSS, same real host element), paints a text-only story whose
// markup is a YouTube URL, and measures where the card actually lands. Writes
// campfire-story-thumb-link.png to the temp dir.
//
// Skips (exit 0) when Chrome is unavailable.
//
// Usage: node scripts/test-story-thumb-links.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9371', 10);
// Absolute positioning lands on half pixels (`translate(-50%,-50%)`), so every
// containment assertion is a 1px tolerance rather than exact equality.
const TOL = 2;

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

// The thumbnail builders out of stories.js, verbatim (no bundler, no exports —
// the same slice trick test-story-ring.js uses, so a change to storyThumbEl() or
// storyThumbWithMarkup() is covered rather than re-typed).
function thumbSource() {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');
  const a = src.indexOf('function storyThumbItem(items) {');
  const b = src.indexOf('function storyRing(user, unseen, items) {');
  if (a < 0 || b < 0 || b < a) {
    console.error('[test] could not find the storyThumbItem..storyRing block in public/js/stories.js');
    process.exit(1);
  }
  return src.slice(a, b);
}
// The overlay model + renderer (public/js/story-edit.js), inlined: it depends on
// the app's global esc(), and on nothing else.
function overlaySource() {
  return fs.readFileSync(path.join(ROOT, 'public/js/story-edit.js'), 'utf8').split("'use strict';").join('');
}
// A text-only story's picture: the composer's own 9:16 gradient, so the wrapper
// has a real intrinsic size to fit the layer to. A 1080x1920 story on the story
// center's ~1100x162 banner is the case that was reported.
const STORY_PX = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><defs>'
  + '<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b3a8f"/>'
  + '<stop offset="1" stop-color="#7b2d63"/></linearGradient></defs>'
  + '<rect width="100%" height="100%" fill="url(#g)"/></svg>').toString('base64');

function pageHtml() {
  const embeds = fs.readFileSync(path.join(ROOT, 'public/embeds.js'), 'utf8');
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
</head><body>
<!-- The hero lives inside #stories-page in the app, which is where the crop
     zoom is declared — so the test hosts it there too. -->
<div id="stories-page">
<div id="hero" class="sp-hero">
  <div class="sp-hero-in">
    <span class="sp-hero-badge"></span>
    <div class="sp-hero-txt">
      <div class="sp-hero-title">Your story</div>
      <div class="sp-hero-sub">1 post &middot; posted just now</div>
      <div class="sp-hero-stats">
        <span class="sp-chip">0 views</span>
        <span class="sp-chip">23h left</span>
      </div>
    </div>
    <div class="sp-hero-btns">
      <button type="button" class="btn small primary">Watch</button>
      <button type="button" class="btn small">Add</button>
    </div>
  </div>
</div>
<div id="grid" class="sp-grid">
  <button type="button" class="sp-card"><span class="sp-card-ago">just now</span></button>
</div>
</div>
<div id="rail" class="st-ring"><span class="avatar"></span></div>
<div id="row"><span id="row-av" class="avatar" style="width:40px;height:40px"></span></div>
<script>
// core.js's esc(), verbatim: embeds.js and story-edit.js call the app's global.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// A file:// page has no /api/unfurl: park every fetch, so what is on screen is
// the card the CLIENT built by itself — never something an unfurl handed back.
window.fetch = () => new Promise(() => {});
window.S = { me: { id: 'me' }, emojiAll: {} };
</script>
<script>${embeds}</script>
<script>${overlaySource()}</script>
<script>
const STORY_PX = ${JSON.stringify(STORY_PX)};
// A text-only story exactly as the composer posts one: the picture is the
// generated gradient, the author's text is the markup (overlays JSON), and
// there is no caption at all.
window.__item = function (text, twoStickers) {
  const ovs = [{ t: 'text', text, x: 0.5, y: twoStickers ? 0.52 : 0.42, r: 0, s: 1, color: '#ffffff' }];
  // The reported post: a link card and, under it, the words (the two placements
  // that collided in the preview).
  if (twoStickers) ovs.push({ t: 'text', text: 'good song', x: 0.5, y: 0.68, r: 0, s: 1, color: '#ffffff' });
  return {
    id: 's1', kind: 'image', url: STORY_PX, seen: false, views: 0,
    created_at: Date.now(), expires_at: Date.now() + 82800000,
    overlays: JSON.stringify(ovs),
  };
};
// Build the thumbnail the way each surface does, INTO the REAL host element
// (the hero's, the card's, the ring's) so the real CSS decides its box.
window.__build = async function (which, text, twoStickers) {
  document.querySelectorAll('#hero .sp-hero-media,#hero .st-thumb-ov').forEach((n) => n.remove());
  document.querySelectorAll('#grid .sp-card-media,#grid .st-thumb-ov').forEach((n) => n.remove());
  document.querySelectorAll('#rail .st-thumb,#rail .st-thumb-ov').forEach((n) => n.remove());
  document.querySelectorAll('#row-av .st-thumb,#row-av .st-thumb-ov').forEach((n) => n.remove());
  const item = window.__item(text, twoStickers);
  let el = null;
  if (which === 'hero') el = storyThumbEl(item, 'sp-hero-media');
  else if (which === 'card') el = storyThumbEl(item, 'sp-card-media');
  else if (which === 'inline') el = storyThumbEl(item, 'st-thumb-inline');
  else el = storyThumbEl(item);
  if (!el) return false;
  if (which === 'hero') document.getElementById('hero').insertBefore(el, document.getElementById('hero').firstChild);
  else if (which === 'card') document.querySelector('#grid .sp-card').insertBefore(el, document.querySelector('#grid .sp-card').firstChild);
  else if (which === 'inline') {
    // paintRowStoryRing (stories.js) puts the thumbnail inside the avatar and
    // makes the avatar the containing block when it is not already one.
    const host = document.getElementById('row-av');
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(el);
  } else document.getElementById('rail').appendChild(el);
  const img = el.tagName === 'IMG' ? el : el.querySelector('img,video');
  if (img && img.decode) await img.decode().catch(() => {});
  // The real renderer re-fits from the media's load event; give that a frame.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return true;
};
window.__url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
window.__probe = function (hostSel, thumbSel) {
  const host = document.querySelector(hostSel);
  const thumb = document.querySelector(thumbSel);
  const wrap = document.querySelector(thumbSel + '.st-thumb-ov') || thumb;
  const item = document.querySelector(thumbSel + ' .ov-item');
  const card = document.querySelector(thumbSel + ' .embed-link');
  const layer = document.querySelector(thumbSel + ' .ov-layer');
  const site = document.querySelector(thumbSel + ' .el-site');
  const posterImg = document.querySelector(thumbSel + ' .el-img');
  const hr = host.getBoundingClientRect();
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
  let opIsLayer = false;
  if (layer) {
    // The containing block the absolutely positioned layer actually resolves
    // against: its positioned ancestor. On a thumbnail that must be the
    // wrapper, never some banner the wrapper was dropped into.
    const op = layer.offsetParent;
    opIsLayer = !!op && !!(op.classList && op.classList.contains('st-thumb-ov'));
  }
  return {
    hasWrap: !!(thumb && thumb.classList.contains('st-thumb-ov')),
    cards: document.querySelectorAll(thumbSel + ' .embed-link').length,
    rawText: item ? item.textContent : null,
    leftOver: item ? /https?:\\/\\//.test(item.textContent) : null,
    site: site ? site.textContent : null,
    poster: posterImg ? posterImg.getAttribute('src') : null,
    wrapPos: wrap ? getComputedStyle(wrap).position : null,
    layerParent: layer && layer.parentElement ? layer.parentElement.className : null,
    layerIsContainingBlock: opIsLayer,
    layerBox: box(layer),
    itemBox: box(item),
    cardFont: card ? parseFloat(getComputedStyle(card).fontSize) : null,
    // The sticker's own font, so the card can be measured AGAINST it: the card
    // must be a fixed fraction of the sticker on every surface (see the
    // proportional-embed rule in styles.css), never a px floor that holds it at
    // one size while the words around it scale.
    itemFont: item ? parseFloat(getComputedStyle(item).fontSize) : null,
    // The picture's crop zoom, as the real rule computes it for this surface.
    // (A backslash-d escape would be eaten by the JS template this page is
    // built from, so the matrix is parsed as plain text.)
    zoom: (() => {
      const media = document.querySelector(thumbSel + ' .st-thumb-media');
      if (!media) return null;
      const t = getComputedStyle(media).transform;
      const m = t.indexOf('matrix(') === 0 ? t.slice(7).split(',')[0] : null;
      return m == null ? (t === 'none' ? 1 : null) : +(+m).toFixed(3);
    })(),
    host: { x: Math.round(hr.left), y: Math.round(hr.top), w: Math.round(hr.width), h: Math.round(hr.height), bottom: Math.round(hr.bottom) },
    wrapBox: box(wrap),
  };
};
// How much of the card is inside the surface that shows it — the measurement
// that would have caught the reported bug on its own (the intersection was
// empty: the card sat ~100px above the hero).
window.__visible = function (hostSel, cardSel) {
  const host = document.querySelector(hostSel).getBoundingClientRect();
  const c = document.querySelector(cardSel).getBoundingClientRect();
  const w = Math.max(0, Math.min(host.right, c.right) - Math.max(host.left, c.left));
  const h = Math.max(0, Math.min(host.bottom, c.bottom) - Math.max(host.top, c.top));
  return { seen: Math.round(w * h), area: Math.round(c.width * c.height) };
};
</script>
<script>${thumbSource()}</script>
</body></html>`;
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-thumblinks-'));
  const htmlPath = path.join(dir, 'thumb.html');
  fs.writeFileSync(htmlPath, pageHtml());

  const child = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=1100,900'], { stdio: 'ignore' });

  let ws;
  try {
    let info = null;
    for (let i = 0; i < 60 && !info; i++) {
      try { info = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); } catch { await sleep(250); }
    }
    if (!info) return skip('Chrome never opened its DevTools port');

    ws = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 128 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0; const pending = new Map();
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

    await sess('Page.enable');
    await sess('Runtime.enable');
    await sess('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
    await sess('Page.navigate', { url: 'file:///' + htmlPath.replace(/\\/g, '/') });
    await sleep(900);
    if (!(await evaluate('typeof storyThumbEl === "function" && typeof ovPaintLayer === "function"'))) {
      console.error('[test] the extracted thumbnail / overlay code did not evaluate in the page');
      process.exit(1);
    }

    console.log('\n[1] the story center hero (your own story)');
    await evaluate('window.__build("hero", window.__url)');
    const hero = await evaluate('window.__probe("#hero", ".sp-hero-media")');
    check(hero.hasWrap, 'the markup thumbnail is the wrapper, not a bare <img>', hero);
    check(hero.cards === 1, 'the URL is the embed CARD, not a ladder of characters', hero);
    check(hero.leftOver === false, 'and the raw URL text is gone', hero.rawText);
    check(hero.site === 'YouTube', 'the card names the site with no unfurl at all', hero);
    check(!!hero.poster && /i\.ytimg\.com\/vi\/dQw4w9WgXcQ\/hqdefault\.jpg$/.test(hero.poster),
      'and carries the video poster frame', hero.poster);
    check(!!hero.wrapPos && hero.wrapPos !== 'static', 'the wrapper is a positioned box', hero.wrapPos);
    check(hero.layerIsContainingBlock, 'so the overlay layer resolves against the thumbnail, not the banner', hero.layerParent);
    check(!!hero.itemFont && !!hero.cardFont,
      'the sticker and its card both render in the hero preview', { cardFont: hero.cardFont, itemFont: hero.itemFont });
    // The hero's picture IS the card's background: full-bleed, with the hero's
    // own title/stats/buttons on top of it. The layer is that visible crop, and
    // the markup is measured against it — which is what keeps the post's words
    // and its link card apart at this size.
    const heroBox = await evaluate(`(() => {
      const hero = document.getElementById('hero').getBoundingClientRect();
      const wrapEl = document.querySelector('#hero .st-thumb-ov');
      const wrap = wrapEl.getBoundingClientRect();
      return { hero: [Math.round(hero.width), Math.round(hero.height)],
        wrap: [Math.round(wrap.width), Math.round(wrap.height)],
        left: Math.round(wrap.left - hero.left),
        tail: Math.round(hero.right - wrap.right) };
    })()`);
    check(Math.abs(heroBox.wrap[0] - heroBox.hero[0]) <= TOL && Math.abs(heroBox.wrap[1] - heroBox.hero[1]) <= TOL
      && heroBox.left <= TOL && heroBox.tail <= TOL,
      'the preview is the card\'s full-width background', heroBox);
    // The embed must NOT be held at its px floor here (that is what crossed the
    // words): it is the sticker's own .3em, the same share of the picture the
    // viewer gives it. Its floor stays for the viewer and the composer.
    check(!!hero.itemFont && !!hero.cardFont
      && Math.abs((hero.cardFont / hero.itemFont) - 0.3) < 0.02,
      'and its card is proportional (.3em), not a px floor that crosses the words',
      { cardFont: hero.cardFont, itemFont: hero.itemFont });
    // The two stickers must not collide in the preview, and this is the measured
    // fault: with the embed held at its px floor the card's box reached ~3px into
    // the words below it. Rebuilt here with the post's two real placements.
    await evaluate('window.__build("hero", window.__url, true)');
    const gap = await evaluate(`(() => {
      const items = [...document.querySelectorAll('#hero .ov-item')];
      if (items.length < 2) return null;
      const a = items[0].getBoundingClientRect(), b = items[1].getBoundingClientRect();
      return { items: items.length, gap: +(b.top - a.bottom).toFixed(1) };
    })()`);
    check(!!gap && gap.items === 2 && gap.gap >= 0, 'the post\'s own stickers do not collide', gap);
    await evaluate('window.__build("hero", window.__url)');
    const vis = await evaluate('window.__visible("#hero", "#hero .embed-link")');
    check(vis.area > 0 && vis.seen >= vis.area * 0.99, 'and the whole card is visible inside the hero (nothing clipped away)', vis);
    // Fault 3, measured: the layer must be the rectangle the photo actually
    // paints. Fitted to the image's whole `cover` content box it was 1098x1952
    // Fault 3, measured: the layer must be the rectangle the photo actually
    // paints. Fitted to the image's whole `cover` content box it was 1098x1952
    // — 12x the hero's height — which is what sized the sticker out of frame.
    check(!!hero.layerBox && !!hero.wrapBox && Math.abs(hero.layerBox.h - hero.wrapBox.h) <= TOL && Math.abs(hero.layerBox.w - hero.wrapBox.w) <= TOL,
      'the layer is the picture\'s VISIBLE box, the same rectangle the photo paints', { layer: hero.layerBox, wrap: hero.wrapBox });
    check(!!hero.itemBox && !!hero.host && hero.itemBox.y >= hero.host.y - TOL && hero.itemBox.bottom <= hero.host.bottom + TOL,
      'the sticker (card included) stays inside the hero', { item: hero.itemBox, host: hero.host });

    console.log('\n[2] a portrait card and a ring carry the same card');
    await evaluate('window.__build("card", window.__url)');
    const card = await evaluate('window.__probe("#grid .sp-card", ".sp-card-media")');
    check(card.cards === 1 && card.leftOver === false && card.site === 'YouTube', 'the portrait card paints the card too', card);
    check(!!card.itemFont && !!card.cardFont,
      'and the card renders with the sticker on the wall card', { cardFont: card.cardFont, itemFont: card.itemFont });
    check(!!card.itemBox && !!card.wrapBox && card.itemBox.y >= card.wrapBox.y - TOL && card.itemBox.bottom <= card.wrapBox.bottom + TOL
      && card.itemBox.x >= card.wrapBox.x - TOL && card.itemBox.right <= card.wrapBox.right + TOL,
    'and it stays inside the picture', { item: card.itemBox, wrap: card.wrapBox });
    // The card is a stamp INSIDE the post's own text box: its size is written
    // as a share of the visible picture, so it must stay a fraction of it and
    // sit where the sticker put it (y 0.42 in the fixture), not run off it —
    // and it must not be the whole picture either, which is what a px floor
    // fighting the sticker's own scale produced.
    check(!!card.itemBox && !!card.wrapBox
      && (card.itemBox.w / card.wrapBox.w) <= 1 && (card.itemBox.h / card.wrapBox.h) <= 1
      && (card.itemBox.y - card.wrapBox.y) / card.wrapBox.h > 0.05 && (card.itemBox.y - card.wrapBox.y) / card.wrapBox.h < 0.5,
    'and keeps its share of the picture (a stamp on the sticker, not the whole card)', {
      shareW: card.itemBox.w / card.wrapBox.w, shareH: card.itemBox.h / card.wrapBox.h,
      atY: (card.itemBox.y - card.wrapBox.y) / card.wrapBox.h,
    });
    await evaluate('window.__build("ring", window.__url)');
    const ring = await evaluate('window.__probe("#rail", ".st-thumb")');
    check(ring.cards === 1 && ring.leftOver === false, 'the ring thumbnail paints it as well (what the viewer shows)', ring);
    // The row/inline ring puts the thumbnail INSIDE the avatar (so the avatar's
    // own circle clips it) — the wrapper is absolutely positioned there, so it
    // has to land in the same box the bare <img> did.
    await evaluate('window.__build("inline", window.__url)');
    const inline = await evaluate('window.__probe("#row-av", ".st-thumb-inline")');
    check(inline.cards === 1 && inline.leftOver === false, 'and so does the in-avatar thumbnail on a DM/friend row', inline);

    console.log('\n[3] a sticker with no link grows no card, and keeps its text');
    await evaluate('window.__build("hero", "good song")');
    const plain = await evaluate('window.__probe("#hero", ".sp-hero-media")');
    check(plain.cards === 0, 'no card for a plain text sticker', plain);
    check(plain.rawText === 'good song' && plain.leftOver === false, 'the words stay the words', plain.rawText);

    // Picture of record: the linked story on the hero, the case that was reported.
    await evaluate('window.__build("hero", window.__url)');
    await sleep(250);
    const shot = (await sess('Page.captureScreenshot', { format: 'png' })).data;
    const shotPath = path.join(os.tmpdir(), 'campfire-story-thumb-link.png');
    fs.writeFileSync(shotPath, Buffer.from(shot, 'base64'));
    console.log('\n  (screenshot: ' + shotPath + ')');
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
