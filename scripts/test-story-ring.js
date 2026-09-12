// The story ring's photo must fully cover the avatar it replaces (see AGENTS.md
// verification conventions).
//
// The complaint: in the Friends rail the tile above "Your story" showed the
// story preview with a hairline of the profile picture still visible along the
// bottom of the circle.
//
// The rail ring is a cookie cutter: the avatar sits inside the ring and paints
// the gap between the photo and the ring stroke with its own background-coloured
// border (ring padding 2.5px + border 2.5px = 5px in). The thumbnail could not
// sit on that inner edge exactly, because Blink floors border widths to whole
// device pixels: the 2.5px border lays out as 2px at dpr 1/1.5 and 2.4px at
// 1.25, so the avatar's face circle measured 49px (not 48px) while the
// thumbnail's inset stayed exact — the old face showed in a crescent just
// outside the photo's edge (measured 47 avatar-coloured pixels at dpr 1, mostly
// along the bottom; 150 at dpr 1.5, all the way round). The thumbnail now
// overfills by 0.5px (inset 4.5px), which covers the widest possible face
// circle while keeping the ring's own gap visible.
//
// This drives the REAL storyRing() out of public/js/stories.js in headless
// Chrome against the REAL styles.css, screenshots the ring at four device
// scale factors and two ring sizes (the rail's 58px and the stories sheet's
// 44px), and asserts no avatar-coloured pixel survives around the photo — plus
// that the ring stroke and its gap are still there, so the fix cannot be
// "cover the whole ring with the photo".
//
// Skips (exit 0) when Chrome is unavailable.
//
// Usage: node scripts/test-story-ring.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9338', 10);
const DPFS = [1, 1.25, 1.5, 2];

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

// The ring builders out of stories.js. There is no bundler and no exports here,
// so this slices the real source (same trick as test-story-start.js) instead of
// re-typing the markup — a change to storyRing()/storyThumbEl() is covered.
function ringSource() {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');
  const a = src.indexOf('function storyLive(items) {');
  const b = src.indexOf('// ---------- story center (Home \u2192 Stories) ----------');
  if (a < 0 || b < 0 || b < a) {
    console.error('[test] could not find the storyLive..story-center block in public/js/stories.js');
    process.exit(1);
  }
  return src.slice(a, b);
}

// The overlay model + renderer (public/js/story-edit.js). The ring code now
// depends on it: a thumbnail with markup composites the same list the viewer
// does, and even the plain path asks ovParse whether there is any.
function overlaySource() {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/story-edit.js'), 'utf8');
  // Drop the directive: this is inlined into a page, not a module.
  return src.split("'use strict';").join('');
}

function solidPx(color) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="100%" height="100%" fill="' + color + '"/></svg>';
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

function pageHtml(avatarSrc, storySrc) {
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>html,body{margin:0;background:var(--bg,#0e1420)}#story-rail{padding:20px}</style>
</head><body>
<div id="story-rail"></div>
<script>
// Stand-in for core.js's paintAvatar: same DOM shape (an .avatar wrapper with a
// filling <img>), so the CSS under test sees exactly what the app produces.
function paintAvatar(el, user) {
  el.classList.add('avatar');
  el.style.background = 'transparent';
  el.innerHTML = '';
  const img = document.createElement('img');
  img.src = ${JSON.stringify(avatarSrc)};
  img.alt = '';
  el.appendChild(img);
}
${overlaySource()}
${ringSource()}
window.S = { me: { id: 'me' } };
const AVATAR_PX = ${JSON.stringify(avatarSrc)};
const STORY_PX = ${JSON.stringify(storySrc)};
window.__buildRing = function (size, seen, mine) {
  const rail = document.getElementById('story-rail');
  rail.innerHTML = '';
  const tile = document.createElement('div');
  tile.className = 'st-tile';
  const ring = storyRing({ id: mine ? 'me' : 'other', display_name: 'Me' }, !seen, [{
    id: 's1', kind: 'image', url: STORY_PX, seen: false,
    created_at: Date.now(), expires_at: Date.now() + 86400000,
  }]);
  if (size) { ring.style.width = ring.style.height = size + 'px'; }
  tile.appendChild(ring);
  rail.appendChild(tile);
  return !!(ring.querySelector('.st-thumb') && ring.querySelector('.avatar img'));
};
// Classify the screenshot around the photo. The avatar stand-in is pure red and
// the story a saturated green, while the ring's own colours are the theme's
// --bg (near black), --accent (indigo) and --line (grey): the photo and the face
// are the only things outside that palette.
const PALETTE = { bg: [7, 9, 14], line: [38, 48, 70], accent: [91, 108, 255] };
const NEAR = 24;
const dist2 = (p, c) => (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
const near = (p, c) => dist2(p, c) < NEAR * NEAR;
window.__scan = async function (png) {
  const img = new Image();
  img.src = 'data:image/png;base64,' + png;
  await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const sx = img.width / innerWidth, sy = img.height / innerHeight;
  const rb = document.querySelector('.st-ring').getBoundingClientRect();
  const tb = document.querySelector('.st-thumb').getBoundingClientRect();
  const cx = (tb.x + tb.width / 2) * sx, cy = (tb.y + tb.height / 2) * sy;
  const tr = tb.width / 2 * sx;
  const x0 = Math.floor(rb.x * sx), y0 = Math.floor(rb.y * sy);
  const W = Math.ceil(rb.width * sx), H = Math.ceil(rb.height * sy);
  const d = g.getImageData(x0, y0, W, H).data;
  const at = (px, py) => {
    const i = ((py - y0) * W + (px - x0)) * 4;
    return i < 0 || i + 2 >= d.length ? null : [d[i], d[i + 1], d[i + 2]];
  };
  const isFace = (p) => p[0] > 100 && p[1] < 100 && p[2] < 100;
  const isGap = (p) => near(p, PALETTE.bg);
  const isStroke = (p) => near(p, PALETTE.line) || near(p, PALETTE.accent);
  let face = 0, strokePx = 0;
  // How much colour is left in the photo itself: the muted ("already watched
  // someone else's") thumbnail is desaturated, and a full-colour one is not.
  // A solid fill makes this a clean split (max-min channel spread 128 vs ~14).
  let vivid = 0, muted = 0;
  const faceAngles = {};
  for (let y = y0; y < y0 + H; y++) for (let x = x0; x < x0 + W; x++) {
    const p = at(x, y); if (!p) continue;
    if (isStroke(p)) strokePx++;
    const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    if (dist <= tr - 3) {
      const spread = Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]);
      if (spread >= 60) vivid++;
      else if (spread <= 40) muted++;
    }
    // Just outside the photo's edge, where a too-small thumbnail let the face
    // show through.
    if (dist < tr - 0.5 || dist > tr + 3) continue;
    if (isFace(p)) {
      face++;
      const k = Math.round(Math.atan2(y + 0.5 - cy, x + 0.5 - cx) * 180 / Math.PI / 45) * 45;
      faceAngles[k] = (faceAngles[k] || 0) + 1;
    }
  }
  // Rays out of the centre: photo -> gap -> ring stroke, in that order (a
  // "cover the whole ring" fix would swallow the stroke; the old inset let the
  // face show up in between). The photo's outer edge is antialiased, so anything
  // outside the ring's own palette counts as "still the photo" and is skipped.
  const rays = [];
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2;
    let gap = 0, stroke = 0;
    for (let r = tr; r <= rb.width / 2 * sx + 1; r += 0.25) {
      const p = at(Math.floor(cx + Math.cos(a) * r), Math.floor(cy + Math.sin(a) * r));
      if (!p) break;
      if (isFace(p)) { gap = -999; break; }      // face leaked into the gap
      if (isGap(p)) { gap++; continue; }
      if (isStroke(p)) { stroke = 1; break; }
      // anything else is the photo (or its blended edge) — keep walking
    }
    rays.push({ gap: Math.round(gap * 0.25 * 100) / 100, stroke });
  }
  const thumbR = tr / sx;
  const ringR = rb.width / 2;
  const css = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.x * 100) / 100, Math.round(b.y * 100) / 100, Math.round(b.width * 100) / 100, Math.round(b.height * 100) / 100]; };
  const boxes = {
    ring: css(document.querySelector('.st-ring')),
    av: css(document.querySelector('.avatar')),
    avimg: css(document.querySelector('.avatar img')),
    thumb: css(document.querySelector('.st-thumb')),
  };
  const profiles = [];
  if (face) {
    // Diagnostic: what the outer edge actually looks like, radius -> rgb.
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2;
      const row = [];
      for (let r = tr - 1.5; r <= tr + 1.5; r += 0.5) {
        row.push(r.toFixed(1) + ':' + (at(Math.floor(cx + Math.cos(a) * r), Math.floor(cy + Math.sin(a) * r)) || []).join(','));
      }
      profiles.push(row);
    }
  }
  return {
    face, faceAngles, strokePx, rays, profiles, boxes, vivid, muted,
    thumbR: Math.round(thumbR * 100) / 100,
    ringR, offX: Math.round(((tb.x + tb.width / 2) - (rb.x + rb.width / 2)) * 100) / 100,
    offY: Math.round(((tb.y + tb.height / 2) - (rb.y + rb.height / 2)) * 100) / 100,
  };
};
</script>
</body></html>`;
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');
  for (const f of ['public/styles.css', 'public/js/stories.js']) {
    if (!fs.existsSync(path.join(ROOT, f))) { console.error('[test] missing ' + f); process.exit(1); }
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-ring-'));
  const htmlPath = path.join(dir, 'ring.html');
  fs.writeFileSync(htmlPath, pageHtml(solidPx('red'), solidPx('green')));

  const child = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=420,260', 'about:blank'], { stdio: 'ignore' });

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
    await sess('Page.navigate', { url: 'file:///' + htmlPath.replace(/\\/g, '/') });
    await sleep(900);
    if (!(await evaluate('typeof window.__buildRing === "function"'))) {
      console.error('[test] the extracted ring code did not evaluate in the page');
      process.exit(1);
    }

    console.log('\n[1] the photo covers the avatar at every device scale factor');
    for (const dpr of DPFS) {
      await sess('Emulation.setDeviceMetricsOverride', { width: 420, height: 260, deviceScaleFactor: dpr, mobile: false });
      for (const size of [null, 44]) {
        for (const v of [
          { seen: false, mine: false, label: ' unseen' },
          { seen: true, mine: false, label: ' seen' },
          { seen: true, mine: true, label: ' seen / mine' },
        ]) {
          const built = await evaluate('window.__buildRing(' + (size || 0) + ',' + (v.seen ? 'true' : 'false') + ',' + (v.mine ? 'true' : 'false') + ')');
          const label = 'dpr ' + dpr + ' / ' + (size || 58) + 'px' + v.label;
          if (!built) { check(false, 'ring built — ' + label, 'storyRing() produced no avatar+thumb'); continue; }
          await sleep(120);
          const shot = (await sess('Page.captureScreenshot', { format: 'png' })).data;
          const s = await evaluate('window.__scan(' + JSON.stringify(shot) + ')');
          check(s.face === 0, 'no face colour around the photo — ' + label, { facePixels: s.face, angles: s.faceAngles, thumbR: s.thumbR, boxes: s.boxes, profiles: s.profiles });
          check(s.strokePx > 40, 'ring stroke still visible — ' + label, { strokePixels: s.strokePx });
          const gaps = s.rays.filter((r) => r.gap >= 1 && r.stroke === 1).length;          check(gaps === 4, 'gap between photo and stroke on all four sides — ' + label, { rays: s.rays });
          check(Math.abs(s.offX) <= 0.05 && Math.abs(s.offY) <= 0.05, 'photo stays centred — ' + label, { offX: s.offX, offY: s.offY });
          // Only someone else's watched story is muted. Your own tile keeps its
          // colours: you cannot watch your own post, and greying it made a
          // flat-coloured (text-only) story look like a broken thumbnail.
          if (v.mine) check(s.vivid > 200 && s.muted === 0, 'your own story keeps its colours — ' + label, { vivid: s.vivid, muted: s.muted });
          else if (v.seen) check(s.muted > 200 && s.vivid === 0, 'a watched story is muted — ' + label, { vivid: s.vivid, muted: s.muted });
          else check(s.vivid > 200 && s.muted === 0, 'an unwatched story is in colour — ' + label, { vivid: s.vivid, muted: s.muted });
        }
      }
    }
  } catch (e) {
    console.error('[test] ' + e.message);
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
