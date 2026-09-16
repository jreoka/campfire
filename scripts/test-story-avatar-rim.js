// The story preview's edge on an avatar — the rim, the ring, and who owns it.
//
// Two reports live here, and one of them is why this test exists.
//
// 1. "There is artifacting around the edges of the pfp circle" (a user card: the
//    friend's story preview inside a 66px avatar, an avatar decoration on, on
//    the OLED theme). Measured on the crop: the ring was exactly rgb(42,42,49)
//    (OLED --line, fitted to r=34.1 = the card's 66px face + its 2.5px ring),
//    and the preview met the ring's inner edge with no gap, no sliver of the
//    old profile picture and no double edge. The rim was right; the noise was
//    the story photo's own pixels at 66px. That is what the first block below
//    pins, so the answer stops depending on my reading of one screenshot: the
//    preview covers the face at every device scale factor, and the ring at the
//    edge is the STORY ring.
//
// 2. The real defect found in the same place: the ring the photo never got. A
//    decoration's outer ring animates `box-shadow` (Ember Glow, Neon Pulse) and
//    an animation beats the inline style paintStoryAvatar() writes — so those
//    two avatars showed NO story ring at all: no accent for an unwatched story,
//    no hairline for a watched one, just the decoration's ring (and its
//    coloured halo) hugging the pfp. `.st-ringed` (stories.js) is the marker
//    the stylesheet now keys on: the ring that carries information wins, the
//    inner ::before effects keep playing, and with no story the decoration is
//    untouched (all three are asserted below, so the fix cannot be "switch the
//    decorations off").
//
// Drives the REAL paintAvatar (core.js) + paintStoryAvatar/paintRowStoryRing
// (stories.js) against the REAL styles.css in headless Chrome, on the card's
// 66px face and on a roster row's 28px one.
//
// Skips (exit 0) when Chrome is unavailable.
//
// Usage: node scripts/test-story-avatar-rim.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9346', 10);
// The two decoration ids whose OUTER effect owns box-shadow (styles.css).
const RING_DECOS = ['ember', 'neon'];
// The four whose effect is an inner ::before overlay and must survive the fix.
const INNER_DECOS = ['fireflies', 'aurora', 'tide', 'stardust'];
const DECOS = ['', ...RING_DECOS, ...INNER_DECOS];

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
function slice(src, from, to, what) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block in ' + what); process.exit(1); }
  return src.slice(a, b);
}

const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const stories = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');

// ---------- the static half: the marker and the precedence rule ----------
console.log('\n[1] the story ring marks the avatar it rings');
check(/av\.classList\.add\('st-ringed'\)/.test(stories), 'paintStoryAvatar/paintRowStoryRing flag their avatar (.js)');
check(/av\.classList\.remove\('st-ringed'\)/.test(stories), 'and clearStoryAvatar takes the flag back (.js)');
check(/\.avatar\.st-ringed\.deco-ember,\.avatar\.st-ringed\.deco-neon\{animation:none\}/.test(css),
  'a decoration whose outer ring animates stands down while a story ring is up (.css)');
// Specificity: the stand-down rule (3 classes) has to beat the plain animation
// rule it overrides (2 classes), or the fix is a no-op in the cascade.
const classes = (sel) => (sel.match(/\./g) || []).length;
check(classes('.avatar.st-ringed.deco-ember') > classes('.avatar.deco-ember'),
  'and it outranks the animation it overrides (.css)');
for (const id of RING_DECOS) {
  check(new RegExp('\\.avatar\\.deco-' + id + '\\{animation:deco-' + id).test(css),
    'the ' + id + ' decoration still animates on an avatar with no story (.css)');
}

const chromePath = findChrome();
if (!chromePath) {
  console.log('\n[2] the rim in a browser — SKIPPED (no Chrome/Edge found; set CHROME_PATH)');
  finish();
}

function solid(color) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="100%" height="100%" fill="' + color + '"/></svg>';
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

function pageHtml(avatarSrc, storySrc) {
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>html,body{margin:0;background:var(--bg)}#wrap{padding:20px;width:460px}</style>
</head><body>
<div id="wrap">
  <div class="profile" id="card" style="max-width:420px;overflow:visible">
    <div class="uc-banner" id="banner"></div>
    <div class="uc-body">
      <div class="uc-head"><span class="avatar big" id="av"></span></div>
    </div>
  </div>
  <div class="member" id="row" style="margin-top:24px"><span class="avwrap"><span class="avatar" id="rav"></span></span><span class="dmmain">Friend</span></div>
</div>
<script>
// story-edit.js is what ovParse/ovPaintLayer come from (the ring thumbnail
// composites a post's markup), so it is sliced in verbatim like the ring tests.
${fs.readFileSync(path.join(ROOT, 'public/js/story-edit.js'), 'utf8').split("'use strict';").join('')}
${slice(stories, 'function storyLive(items) {', '// ================= stories sheet (the "stories area") =================', 'public/js/stories.js')}
// core.js's paintAvatar (with AV_COLORS/AVATAR_DECOS/AV_DECO_IDS, which it reads).
${slice(core, 'const AV_COLORS =', '\nfunction msgAuthor(', 'public/js/core.js')}
window.S = { me: { id: 'me' } };
window.storyData = { mine: null, friends: [], everyone: [], servers: [] };
const AV = ${JSON.stringify(avatarSrc)};
const STORY = ${JSON.stringify(storySrc)};
document.getElementById('banner').style.backgroundImage = 'url(' + ${JSON.stringify(solid('#a020f0'))} + ')';

window.__build = function (deco, seen, surface) {
  const user = { id: 'u2', display_name: 'Friend', username: 'friend', avatar_url: AV, avatar_decoration: deco || '' };
  window.storyData.friends = [{
    user: { id: 'u2', display_name: 'Friend', username: 'friend' },
    items: [{
      id: 's1', kind: 'image', url: STORY, seen: !!seen,
      created_at: Date.now(), expires_at: Date.now() + 86400000, overlays: null,
    }],
  }];
  if (surface === 'row') {
    const row = document.getElementById('row');
    const rav = document.getElementById('rav');
    rav.className = 'avatar';
    paintAvatar(rav, user);
    return { ringed: paintRowStoryRing(row, { id: 'u2', display_name: 'Friend' }) };
  }
  const av = document.getElementById('av');
  const card = document.getElementById('card');
  av.className = 'avatar big';
  paintAvatar(av, user);
  // The card paints the story on the head avatar (paintUserCardStory's call).
  paintStoryAvatar(card.querySelector('.uc-head .avatar'), user, {});
  return { ringed: true };
};
// A story-less build, to prove the decoration itself is untouched by the fix.
window.__buildNoStory = function (deco, surface) {
  const user = { id: 'u2', display_name: 'Friend', username: 'friend', avatar_url: AV, avatar_decoration: deco || '' };
  window.storyData.friends = [];
  const el = document.getElementById(surface === 'row' ? 'rav' : 'av');
  el.className = surface === 'row' ? 'avatar' : 'avatar big';
  paintAvatar(el, user);
  if (surface === 'row') paintRowStoryRing(document.getElementById('row'), { id: 'u2', display_name: 'Friend' });
  else paintStoryAvatar(document.querySelector('#card .uc-head .avatar'), user, {});
  return { deco: [...el.classList].filter((c) => c.indexOf('deco-') === 0) };
};

// Colours the theme/dressings actually put at the rim. The banner behind the
// card's head avatar is a purple no ring colour can be confused with (a cyan
// banner sat within tolerance of Neon Pulse's own ring).
const ACCENT = [91, 108, 255], LINE = [38, 48, 70];
const DECO_RING = {
  ember: [[255, 154, 60], [255, 210, 60]],
  neon: [[34, 211, 238]],
};
const near = (p, c, tol) => Math.abs(p[0] - c[0]) <= tol && Math.abs(p[1] - c[1]) <= tol && Math.abs(p[2] - c[2]) <= tol;
const FRAME = {};   // baseline pixels per dpr/seen/surface, for the "stands down" check

window.__scan = async function (png, surface, seen, deco, phase) {
  const img = new Image();
  img.src = 'data:image/png;base64,' + png;
  await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const sx = img.width / innerWidth, sy = img.height / innerHeight;
  const el = document.getElementById(surface === 'row' ? 'rav' : 'av');
  const b = el.getBoundingClientRect();
  const cx = (b.x + b.width / 2) * sx, cy = (b.y + b.height / 2) * sy, R = b.width / 2;
  const x0 = Math.max(0, Math.floor(cx - (R + 5) * sx)), y0 = Math.max(0, Math.floor(cy - (R + 5) * sx));
  const W = Math.min(img.width - x0, Math.ceil((2 * R + 10) * sx)), H = Math.min(img.height - y0, Math.ceil((2 * R + 10) * sx));
  const d = g.getImageData(x0, y0, W, H).data;
  const at = (px, py) => { const i = ((py - y0) * W + (px - x0)) * 4; return i < 0 || i + 2 >= d.length ? null : [d[i], d[i + 1], d[i + 2]]; };
  let faceLeak = 0, storyRing = 0, decoRing = 0, band = 0, disc = 0;
  const want = seen ? LINE : ACCENT;
  const stacks = DECO_RING[deco] || [];
  for (let y = y0; y < y0 + H; y++) for (let x = x0; x < x0 + W; x++) {
    const p = at(x, y); if (!p) continue;
    const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / sx;   // CSS px from the centre
    if (dist <= R - 0.5) {
      disc++;
      // The stand-in profile picture is pure red and the preview pure green, so
      // a red pixel inside the disc is the face showing through the preview.
      if (p[0] > 140 && p[1] < 110 && p[2] < 110) faceLeak++;
    }
    // The ring sits just outside the face — the story ring's 2.5px spread on a
    // card, 2px on a row — and a decoration's ring rides the same band.
    if (dist >= R - 0.5 && dist <= R + 2.5) {
      band++;
      if (near(p, want, 26)) storyRing++;
      for (const s of stacks) if (near(p, s, 44)) decoRing++;
    }
  }
  // An inner decoration tints the PREVIEW, so what it painted is measured
  // against the no-decoration frame (the preview's own antialiased rim would
  // otherwise read as "something was painted here").
  const key = Math.round(sx * 100) + '/' + (seen ? 'seen' : 'new') + '/' + surface + '/' + (phase || 'story');
  const base = FRAME[key];
  let innerEffect = 0, diff = null;
  const px = new Uint8Array(d.subarray(0, W * H * 4));
  if (!base) FRAME[key] = px;
  else {
    diff = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const changed = px[i] !== base[i] || px[i + 1] !== base[i + 1] || px[i + 2] !== base[i + 2];
      if (!changed) continue;
      diff++;
      const dist = Math.hypot(x + x0 + 0.5 - cx, y + y0 + 0.5 - cy) / sx;
      if (dist <= R - 1.5) innerEffect++;
    }
  }
  return { faceLeak, storyRing, decoRing, band, innerEffect, disc, diff };
};
</script>
</body></html>`;
}

async function main() {
  for (const f of ['public/styles.css', 'public/js/stories.js', 'public/js/core.js', 'public/js/story-edit.js']) {
    if (!fs.existsSync(path.join(ROOT, f))) { console.error('[test] missing ' + f); process.exit(1); }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-rim-'));
  const htmlPath = path.join(dir, 'rim.html');
  fs.writeFileSync(htmlPath, pageHtml(solid('red'), solid('#00ff00')));

  const child = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=520,540', 'about:blank'], { stdio: 'ignore' });
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
    ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const call = (method, params, sessionId) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
      ws.send(JSON.stringify({ id: i, sessionId, method, params }));
    });
    const targetId = (await call('Target.createTarget', { url: 'about:blank' })).targetId;
    const sessionId = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    const sess = (m, p) => call(m, p, sessionId);
    const evaluate = async (e) => {
      const r = await sess('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'page error');
      return r.result.value;
    };
    await sess('Page.enable'); await sess('Runtime.enable');
    await sess('Page.navigate', { url: 'file:///' + htmlPath.replace(/\\/g, '/') });
    await sleep(900);
    if (!(await evaluate('typeof window.__build === "function"'))) {
      console.error('[test] the sliced paint code did not evaluate in the page');
      process.exit(1);
    }

    // The whole viewport, like the ring tests: __scan() resolves the element's
    // own box against the viewport, so a clipped capture would offset it.
    const shot = async () => (await sess('Page.captureScreenshot', { format: 'png' })).data;

    console.log('\n[2] the preview covers the face, and the ring at the rim is the story ring');
    for (const dpr of [1, 3]) {
      await sess('Emulation.setDeviceMetricsOverride', { width: 520, height: 540, deviceScaleFactor: dpr, mobile: false });
      for (const surface of ['card', 'row']) {
        for (const seen of [false, true]) {
          for (const deco of DECOS) {
            const label = dpr + 'x ' + surface + ' ' + (seen ? 'watched' : 'new') + ' ' + (deco || 'no decoration');
            const built = await evaluate(`window.__build(${JSON.stringify(deco)}, ${seen}, ${JSON.stringify(surface)})`);
            if (!built || !built.ringed) { check(false, 'the ring builder ran — ' + label, built); continue; }
            await sleep(dpr === 1 ? 90 : 120);
            const s = await evaluate('window.__scan(' + JSON.stringify(await shot()) + ',' + JSON.stringify(surface) + ',' + seen + ',' + JSON.stringify(deco) + ')');
            check(s.faceLeak === 0, 'no profile picture at the rim — ' + label, { facePixels: s.faceLeak, disc: s.disc });
            // The story ring's own colour has to be what the band is made of.
            // The watched ring is the discriminator: a decoration's ring is a
            // saturated colour (orange/cyan/accent), never the --line hairline.
            // (Under half the band: the ring's antialiased inner edge blends
            // with the green preview and its outer one with the panel.)
            check(s.storyRing > 80 && s.storyRing > s.band * 0.35, 'the rim wears the ' + (seen ? 'watched-story hairline' : 'new-story accent') + ' — ' + label, { ring: s.storyRing, band: s.band });
            if (RING_DECOS.includes(deco)) {
              check(s.decoRing === 0, 'the decoration\'s ring does not replace it — ' + label, s);
              // The whole avatar box, so this covers the ring band too: with a
              // story up, Ember Glow/Neon Pulse now draw exactly the frame a
              // bare avatar draws (its ring is the story's). A couple of pixels
              // of antialiasing is the rasterizer, not the decoration.
              check(s.diff !== null && s.diff <= 8, 'the whole face is the no-decoration frame — ' + label, { differing: s.diff, tinted: s.innerEffect });
            } else if (INNER_DECOS.includes(deco)) {
              check(s.innerEffect > 20, 'the decoration still plays over the preview — ' + label, { tinted: s.innerEffect });
            }
          }
        }
      }
    }

    console.log('\n[3] with no story the decoration is untouched');
    // A story-less frame for the same avatar, so "the decoration still paints"
    // is measured as a difference rather than by colour: an animated ring is
    // caught wherever in its cycle the capture lands.
    for (const deco of RING_DECOS) {
      await evaluate('window.__buildNoStory("", "card")');
      await sleep(120);
      await evaluate('window.__scan(' + JSON.stringify(await shot()) + ',"card",false,"","nostory")');
      const built = await evaluate(`window.__buildNoStory(${JSON.stringify(deco)}, "card")`);
      await sleep(220);
      const s = await evaluate('window.__scan(' + JSON.stringify(await shot()) + ',"card",false,' + JSON.stringify(deco) + ',"nostory")');
      check(built.deco.indexOf('deco-' + deco) === 0, 'the avatar still wears ' + deco, built);
      check(s.diff > 20, 'and its outer effect still paints — ' + deco, { differing: s.diff });
      check(s.faceLeak > 0, 'with the profile picture in the circle (no story, no preview) — ' + deco, { disc: s.disc });
    }
  } catch (e) {
    console.error('[test] ' + (e && e.stack || e));
    process.exit(1);
  } finally {
    try { ws && ws.close(); } catch {}
    try { child.kill(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  finish();
}

function finish() {
  console.log('\n' + (failures.length ? 'FAILED: ' + failures.length : 'OK') + ' — ' + passed + ' checks passed');
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
  process.exit(0);
}
main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
