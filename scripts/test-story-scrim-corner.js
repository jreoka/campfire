// Story-center scrim corners: the picture must not peek out at the rounded
// corners of the "your story" hero (or the portrait cards next to it).
//
// Owner report: on the hero's left corners the left-to-right scrim stopped a few
// pixels short of the curve, so a hairline of the photo showed as a brighter
// arc. The cause was structural: the scrim was a SECOND element painted over the
// picture, and a rounded clip is antialiased per layer — at a corner pixel the
// photo survived at partial coverage underneath a scrim that covered only that
// same fraction of the pixel. Every pixel inside the shape now comes from ONE
// paint: the media carries the scrim as a CSS mask and fades into the hero's own
// dark surface (mask alpha = 1 minus the old scrim alpha, so the look is
// unchanged).
//
// Static half (always runs): no scrim element is built, no `.sp-*-scrim` rule is
// left in the stylesheet, and the media really carries the mask.
//
// Chrome half (skips without Chrome): runs the REAL `spHero`/`spCard` sliced out
// of public/js/stories.js against the REAL stylesheet with a pure-white test
// photo, screenshots the corners at 8x, and asserts that no pixel inside the
// picture's rounded shape is brighter than the same edge measured away from the
// corner — with the bug the corner peaked ~2x the border's own brightness.
//
// Usage: node scripts/test-story-scrim-corner.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9371', 10);
const DSF = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}
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
const stories = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');
const centerSrc = slice(stories, '// ---------- story center (Home → Stories) ----------', '\n// ---------- server sidebar row + Home sidebar entry ----------');
const svgSrc = slice(stories, 'const svSvg = {', '};') + '};';
const agoSrc = slice(stories, 'function storyAgo(ts) {', '\n// ---------- data ----------');
if (!/function spHero/.test(centerSrc) || !/function spCard/.test(centerSrc)) {
  console.error('[test] the extracted story-center block is incomplete');
  process.exit(1);
}

console.log('\n[1] one paint, not a scrim layer over the picture');
check(!/sp-hero-scrim|sp-card-scrim/.test(stories), 'no scrim element is built any more');
check(!/sp-hero-scrim|sp-card-scrim/.test(css), 'no scrim rule is left in the stylesheet');
check(/\.sp-hero-media\{[^}]*mask-image:linear-gradient\(90deg/.test(css), 'the hero photo carries the left-to-right mask (.css)');
check(/\.sp-hero:not\(\.sp-hero-empty\)\{background:#05070c\}/.test(css), 'the hero surface is the scrim base colour (.css)');
check(/\.sp-card-media\{[^}]*mask-image:linear-gradient\(to top/.test(css), 'the card photo carries the bottom-up mask (.css)');
check(/\.sp-card:has\(> \.sp-card-media\)\{background:#05070c\}/.test(css), 'the card surface is the scrim base colour (.css)');
// 1 - the old alphas: .94/.6/.28 for the hero, .92/.35/.05 for the card.
check(/mask-image:linear-gradient\(90deg,rgba\(0,0,0,\.06\) 12%,rgba\(0,0,0,\.4\) 58%,rgba\(0,0,0,\.72\)\)/.test(css), "the hero mask matches the old scrim's alpha ramp");
check(/mask-image:linear-gradient\(to top,rgba\(0,0,0,\.08\) 4%,rgba\(0,0,0,\.65\) 42%,rgba\(0,0,0,\.95\) 70%\)/.test(css), "the card mask matches the old scrim's alpha ramp");

const chromePath = findChrome();
if (!chromePath) finish('no Chrome/Edge found (set CHROME_PATH)');

// A pure-white photo: anything the scrim fails to cover shows up as a bright
// pixel, so the measurement does not depend on what a real photo looks like.
const WHITE = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='600' height='600'><rect width='600' height='600' fill='white'/></svg>";

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<style>${css}</style>
<style>html,body{margin:0;padding:0;background:var(--bg)}
#hero{width:420px}.sp-hero{margin-top:0}
#grid{width:180px;margin-top:8px}
#grid .sp-card{width:100%}</style></head><body>
<div id="hero"></div><div id="grid"></div>
<script>
window.S = { me: { id: 'me', username: 'me', display_name: 'Jordan' } };
window.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
window.paintAvatar = () => {};
window.storyThumbEl = (it, cls) => { if (!it) return null; const img = document.createElement('img'); img.className = cls || 'st-thumb'; img.src = ${JSON.stringify(WHITE)}; return img; };
window.storyThumbItem = (items) => (items || [])[items.length - 1] || null;
window.openStoryViewer = () => {};
window.createStory = () => {};
window.storyViewersModal = () => Promise.resolve(true);
window.api = () => Promise.resolve({ viewers: [] });
${svgSrc}
${agoSrc}
${centerSrc}
const now = Date.now();
const it = { id: 's1', kind: 'image', created_at: now - 3600e3, expires_at: now + 72000e3, views: 3, reactions: [] };
document.getElementById('hero').appendChild(spHero([it, it]));
const tray = { id: 'f1', user: { id: 'f1', username: 'ada', display_name: 'Ada', avatar_color: '#5865f2' }, items: [it], unseen: 1, latest: now - 600e3 };
document.getElementById('grid').appendChild(spCard(tray));
window.__ready = true;
</script></body></html>`;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-scrim-'));
  const pagePath = path.join(tmp, 'page.html');
  fs.writeFileSync(pagePath, pageHtml());
  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    '--user-data-dir=' + path.join(tmp, 'prof'), '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--hide-scrollbars', '--window-size=900,900', 'about:blank'], { stdio: 'ignore' });
  let ws = null;
  try {
    let ver = null;
    for (let i = 0; i < 80 && !ver; i++) {
      try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch {}
      if (!ver) await sleep(200);
    }
    if (!ver) return finish('Chrome did not expose the DevTools port');
    const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    let id = 0; const pend = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    });
    const cmd = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expression) => {
      const r = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    await cmd('Page.enable'); await cmd('Runtime.enable');
    await cmd('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: DSF, mobile: false });
    await cmd('Page.navigate', { url: 'file:///' + pagePath.replace(/\\/g, '/') });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) { ready = await ev('!!window.__ready').catch(() => false); if (!ready) await sleep(150); }
    if (!ready) return finish('the harness page did not render');
    await sleep(400);

    const shot = async (clip, label) => {
      const r = await cmd('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
      fs.writeFileSync(path.join(os.tmpdir(), `campfire-scrim-${label}.png`), Buffer.from(r.data, 'base64'));
      return ev(`(async () => {
        const img = new Image();
        img.src = 'data:image/png;base64,${r.data}';
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, img.width, img.height).data;
        const px = [];
        for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
          const i = (y * img.width + x) * 4;
          px.push([x, y, Math.round(0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2])]);
        }
        return { w: img.width, h: img.height, px };
      })()`);
    };
    const cssX = (clip, px) => clip.x + (px + 0.5) / DSF;
    const cssY = (clip, py) => clip.y + (py + 0.5) / DSF;
    const inside = (el, cx, cy) => insideRounded(cx - el.x, cy - el.y, el.w, el.h, el.radius, el.border);
    // The flat scrim ramp along the element's long axis, one bucket per CSS px:
    // the value a corner pixel must match at its own x (hero) / y (card).
    const band = async (el, axis) => {
      const clip = axis === 'x'
        ? { x: el.x, y: el.y + Math.round(el.h / 2), width: el.w, height: 4 }
        : { x: el.x + Math.round(el.w / 2), y: el.y, width: 4, height: el.h };
      const img = await shot(clip, 'ref-' + axis);
      const map = new Map();
      for (const [px, py, lum] of img.px) {
        const cx = cssX(clip, px), cy = cssY(clip, py);
        if (!inside(el, cx, cy)) continue;
        const k = Math.round(axis === 'x' ? cx - el.x : cy - el.y);
        map.set(k, Math.max(map.has(k) ? map.get(k) : -1, lum));
      }
      return map;
    };
    // How much brighter the brightest pixel inside an element's corner is than
    // anything legitimately painted at its own coordinate: the flat scrim ramp
    // (same x for the hero / y for the card) or the hairline, whichever is
    // brighter there. A blend of two colours cannot exceed the brighter one, so
    // a positive excess is a leak — with the scrim stacked over the photo it
    // reached ~+45 on the dark corners.
    const maxExcess = (img, clip, el, ref, axis, borderLum) => {
      let worst = null;
      for (const [px, py, lum] of img.px) {
        const cx = cssX(clip, px), cy = cssY(clip, py);
        if (!inside(el, cx, cy)) continue;
        const k = Math.round(axis === 'x' ? cx - el.x : cy - el.y);
        if (!ref.has(k)) continue;
        const d = lum - Math.max(borderLum, ref.get(k));
        if (worst === null || d > worst) worst = d;
      }
      return worst;
    };

    console.log('\n[2] the hero\'s rounded corners paint the scrim, not the photo');
    const hero = await ev(`(() => { const r = document.querySelector('#hero .sp-hero').getBoundingClientRect();
      const cs = getComputedStyle(document.querySelector('#hero .sp-hero'));
      return { x: r.x, y: r.y, w: r.width, h: r.height, radius: parseFloat(cs.borderTopLeftRadius), border: parseFloat(cs.borderTopWidth) }; })()`);
    check(hero.radius > 8 && hero.border >= 1, 'the hero really is rounded with a hairline', hero);

    // The flat ramp, sampled across the middle of the hero: the reference a
    // corner pixel has to match at its own x. (Absolute check too: a white photo
    // must still read near-black at the left end and bright at the right, or the
    // scrim itself is gone and the relative check below would pass vacuously.)
    const ref = await band(hero, 'x');
    const at = (map, k) => (map.has(k) ? map.get(k) : null);
    // The hairline's own brightness, sampled on the straight left edge: the
    // brightest legitimately-painted thing the corner can blend into.
    const borderLum = (await shot({ x: hero.x, y: hero.y + Math.round(hero.h / 2), width: 2, height: 4 }, 'border')).px.reduce((m, p) => Math.max(m, p[2]), 0);
    check(borderLum < 120, 'the hero hairline is a subtle line, not a bright ring', { borderLum });
    check(at(ref, 6) !== null && at(ref, 6) < 60, 'the left end of a white photo is scrimmed near-black', { l: at(ref, 6) });
    check(at(ref, Math.round(hero.w) - 6) > 120, 'and the right end still shows the photo', { r: at(ref, Math.round(hero.w) - 6) });

    for (const [name, corner] of [['top-left', 'tl'], ['bottom-left', 'bl'], ['top-right', 'tr'], ['bottom-right', 'br']]) {
      const box = cornerBox(hero, corner);
      const img = await shot(box.clip, 'hero-' + corner);
      const excess = maxExcess(img, box.clip, hero, ref, 'x', borderLum);
      check(excess !== null && excess <= 8, 'no photo leaks into the hero\'s ' + name + ' corner', { excess, borderLum });
    }

    console.log('\n[3] same for a portrait story card');
    const card = await ev(`(() => { const e = document.querySelector('#grid .sp-card'); const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return { x: r.x, y: r.y, w: r.width, h: r.height, radius: parseFloat(cs.borderTopLeftRadius), border: parseFloat(cs.borderTopWidth) }; })()`);
    check(card.w > 100 && card.h > 150, 'the card renders at its portrait size', { w: card.w, h: card.h });
    const cref = await band(card, 'y');
    check(at(cref, Math.round(card.h) - 8) !== null && at(cref, Math.round(card.h) - 8) < 70, 'the bottom of a white card photo is scrimmed near-black', { b: at(cref, Math.round(card.h) - 8) });
    check(at(cref, 8) > 120, 'and the top still shows the photo', { t: at(cref, 8) });
    for (const [name, corner] of [['bottom-left', 'bl'], ['bottom-right', 'br']]) {
      const box = cornerBox(card, corner);
      const img = await shot(box.clip, 'card-' + corner);
      const excess = maxExcess(img, box.clip, card, cref, 'y', 0);
      check(excess !== null && excess <= 8, 'no photo leaks into the card\'s ' + name + ' corner', { excess });
    }
    if (!failures.length) console.log('\n(screenshots written to ' + os.tmpdir() + ': campfire-scrim-*.png)');
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  finish();
}

// The clip that holds one corner: the radius plus a small margin.
function cornerBox(box, corner) {
  const m = Math.ceil(box.radius) + 2;
  const x = corner === 'tl' || corner === 'bl' ? box.x : box.x + box.w - m;
  const y = corner === 'tl' || corner === 'tr' ? box.y : box.y + box.h - m;
  return { clip: { x, y, width: m, height: m } };
}
// A point (relative to the element's border box) inside the padding-box rounded
// rect — the shape the media is actually clipped to.
function insideRounded(x, y, w, h, radius, border) {
  const r = Math.max(0, radius - border);
  const x0 = border, y0 = border, x1 = w - border, y1 = h - border;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const qx = x < x0 + r ? x0 + r : (x > x1 - r ? x1 - r : x);
  const qy = y < y0 + r ? y0 + r : (y > y1 - r ? y1 - r : y);
  return (x - qx) * (x - qx) + (y - qy) * (y - qy) <= r * r;
}

function finish(skipMsg) {
  if (skipMsg) { console.log('\n[test] SKIP browser half: ' + skipMsg); }
  console.log('\n' + (failures.length ? 'FAILED: ' + failures.length : 'OK') + ' — ' + passed + ' checks passed');
  if (failures.length) process.exit(1);
  process.exit(0);
}

main().catch((e) => { console.error('[test] crashed:', (e && e.message) || e); process.exit(1); });
