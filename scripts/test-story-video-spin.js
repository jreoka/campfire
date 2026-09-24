// Story hero video placeholder: while a video story's thumbnail <video> has no
// frame yet, mobile browsers paint their own grey play-button placeholder into
// it — which reads as broken for the second the story takes to load.
//
// Owner report (with screenshots): on the Stories page the "your story" card
// sat grey with a circle-and-play-button in it while the video loaded.
//
// Then: a spinner replaced the placeholder (storyThumbSpin + .st-loading),
// settling on the SEEKED frame (the thumbnail seeks to 0.06 on loadeddata).
//
// Now: the spinner is joined by a "blur-up" placeholder — a tiny derived still
// of the story (the thumbs/ pipeline for photos, a first-frame poster for
// video) painted blurred behind the spinner while the real media loads, with
// the media crossfading in over it. Photos arm the spinner now too.
//
// Static half (always runs): the helpers exist, spHero/spCard wire them, the
// stylesheet hides the media / paints the blur + spinner, and the server-side
// poster derivation (media-compress.js) only accepts video files/ keys.
//
// Chrome half (skips without Chrome): runs the REAL spHero sliced out of
// public/js/stories.js against the REAL stylesheet with stub thumbnails, and
// asserts the loading class, the crossfade, the blur-up layer's lifecycle
// (appears blurred behind, leaves after the settle), the seek race, the
// give-up path, the photo path, and the blur-error fallback.
//
// Usage: node scripts/test-story-video-spin.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9372', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function finish(msg) {
  if (msg) console.log('[test] SKIP: ' + msg);
  if (failures.length) { console.log(`\nFAILED (${failures.length})`); process.exit(1); }
  console.log(`\nall ${passed} checks passed`);
  process.exit(0);
}
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
if (!/function spHero/.test(centerSrc) || !/function storyThumbSpin/.test(centerSrc)) {
  console.error('[test] the extracted story-center block is incomplete');
  process.exit(1);
}

console.log('\n[1] the helper exists and is wired to the story surfaces');
check(/function storyThumbSpin\(host, media, it\)/.test(stories), 'storyThumbSpin(host, media, it) exists');
check(/const img = !vid \? \(media\.tagName === 'IMG'/.test(stories), 'photos arm the spinner too (not just video)');
check(/vid\.addEventListener\('loadeddata', onData, \{ once: true \}\)/.test(stories), 'it waits for the first data');
check(/if \(vid\.seeking\) vid\.addEventListener\('seeked', settle, \{ once: true \}\)/.test(stories), 'a seek in flight settles on `seeked`, not `loadeddata`');
check(/img\.addEventListener\('load', settle, \{ once: true \}\)/.test(stories), 'a photo settles on load');
check(/storyThumbRetry removes the media/.test(stories), 'the give-up path (media removed) settles it too');
check(/function storyBlurSrc\(it\)/.test(stories), 'storyBlurSrc(it) exists');
check(/function storyThumbBlur\(host, it\)/.test(stories), 'storyThumbBlur(host, it) exists');
const heroSrc = slice(stories, 'function spHero(mineItems) {', '\nfunction spEmpty() {');
check(/storyThumbSpin\(hero, media, latest\)/.test(heroSrc), 'spHero arms the spinner on the hero backdrop');
check(/storyThumbSpin\(av, thumb, storyThumbItem\(mineItems\)\)/.test(heroSrc), 'spHero arms the spinner on the badge ring thumbnail');
const cardSrc = slice(stories, 'function spCard(t) {', '\nfunction spGrid(trays) {');
check(/storyThumbSpin\(b, media, thumbItem\)/.test(cardSrc), 'spCard arms the spinner on story cards');

console.log('\n[1b] the blur source derivation (pure string logic, no DOM)');
const blurSrcFn = slice(stories, 'function storyBlurSrc(it) {', 'function storyThumbBlur(host, it) {');
const storyBlurSrc = new Function(blurSrcFn + '; return storyBlurSrc;')();
check(storyBlurSrc({ kind: 'image', url: '/uploads/files/abc.jpg' }) === '/uploads/thumbs/files/abc.jpg.webp', 'a photo blurs up from the thumbs/ pipeline');
check(storyBlurSrc({ kind: 'image', url: '/uploads/files/abc.jpg?v=xyz' }) === '/uploads/thumbs/files/abc.jpg.webp?v=xyz', 'the photo blur keeps the cache-buster');
check(storyBlurSrc({ kind: 'video', url: '/uploads/files/abc.mp4' }) === '/uploads/posters/files/abc.mp4.webp', 'a video blurs up from the posters/ pipeline');
check(storyBlurSrc({ kind: 'video', url: '/uploads/files/abc.mp4?v=xyz' }) === '/uploads/posters/files/abc.mp4.webp?v=xyz', 'the video blur keeps the cache-buster');
check(storyBlurSrc({ kind: 'image', url: 'https://example.invalid/x.jpg' }) === '', 'remote URLs get no blur');
check(storyBlurSrc({ kind: 'video', url: '/uploads/files/a b.mp4' }) === '', 'unsafe keys get no blur');
check(storyBlurSrc(null) === '', 'a missing item gets no blur');

console.log('\n[1c] server: the video poster derivation');
const mc = require(path.join(ROOT, 'media-compress.js'));
check(mc.posterKeyFor('files/abc.mp4') === 'posters/files/abc.mp4.webp', 'mp4 maps into posters/');
check(mc.posterKeyFor('files/a.webm') === 'posters/files/a.webm.webp', 'webm maps too');
check(mc.posterKeyFor('files/abc.jpg') === null, 'stills stay out of posters/');
check(mc.posterKeyFor('viewonce/x.mp4') === null, 'only files/ uploads');
check(mc.posterKeyFor('files/../x.mp4') === null, 'no traversal');
check(mc.posterSourceKey('posters/files/abc.mp4.webp') === 'files/abc.mp4', 'round trip');
check(mc.posterSourceKey('posters/files/abc.jpg.webp') === null, 'round trip rejects non-video');
check(mc.posterSourceKey('posters/files/abc.mp4.png') === null, 'round trip rejects the wrong ext');

console.log('\n[2] the stylesheet hides the media, blurs the placeholder, paints the spinner');
check(/\.st-loading \.st-real\{opacity:0\}/.test(css), 'a loading thumbnail keeps its media invisible (crossfade)');
check(/\.st-blur\{[^}]*filter:blur\(/.test(css), 'the blur-up layer is really blurred');
check(/\.st-blur\{[^}]*object-fit:cover/.test(css), 'the blur-up layer covers the card');
check(/\.st-loading::after\{[^}]*animation:up-spin/.test(css), 'the spinner is the app\'s own up-spin mark');
check(/\.sp-hero-badge \.st-loading::after\{[^}]*width:18px/.test(css), 'the badge ring gets the small spinner');
check(/\.sp-hero-badge \.st-blur\{[^}]*border-radius:50%/.test(css), 'the badge blur wears the ring geometry');

const chromePath = findChrome();
if (!chromePath) finish('no Chrome/Edge found (set CHROME_PATH)');

const WHITE = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='600' height='600'><rect width='600' height='600' fill='white'/></svg>";

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<style>${css}</style>
<style>html,body{margin:0;padding:0;background:var(--bg)}
#hero,#hero2,#hero3{width:420px}.sp-hero{margin-top:0}</style></head><body>
<div id="hero"></div><div id="hero2"></div><div id="hero3"></div><div id="hero4"></div>
<script>
window.S = { me: { id: 'me', username: 'me', display_name: 'Jordan' } };
window.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
window.paintAvatar = () => {};
// The real wiring, but thumbnails we control: a genuine <video> with no src,
// so it never loads and stays in the loading state until we say otherwise.
window.storyThumbEl = (it, cls) => {
  if (!it) return null;
  const el = it.kind === 'video' ? document.createElement('video') : document.createElement('img');
  el.className = cls || 'st-thumb';
  if (it.kind !== 'video') el.src = ${JSON.stringify(WHITE)};
  return el;
};
window.storyThumbItem = (items) => (items || [])[items.length - 1] || null;
window.openStoryViewer = () => {};
window.createStory = () => {};
window.storyViewersModal = () => Promise.resolve(true);
window.api = () => Promise.resolve({ viewers: [] });
${svgSrc}
${agoSrc}
${centerSrc}
// Point the blur at an instant data URL: this half tests the blur-up
// mechanics, not the network. (The real derivation is pinned in [1b].)
storyBlurSrc = () => ${JSON.stringify(WHITE)};
const now = Date.now();
const vit = { id: 'v1', kind: 'video', url: 'https://example.invalid/v.mp4', created_at: now - 3600e3, expires_at: now + 72000e3, views: 2, reactions: [] };
const hero = spHero([vit]);
document.getElementById('hero').appendChild(hero);
const vid = hero.querySelector('.sp-hero-media');
const badgeAv = hero.querySelector('.sp-hero-badge .avatar');
const spinCs = getComputedStyle(hero, '::after');
window.__t1 = {
  heroLoading: hero.classList.contains('st-loading'),
  badgeLoading: !!(badgeAv && badgeAv.classList.contains('st-loading')),
  mediaReal: vid.classList.contains('st-real'),
  mediaFaded: getComputedStyle(vid).opacity === '0',
  spinAnim: spinCs.animationName === 'up-spin',
  spinSize: spinCs.width,
};
setTimeout(() => {
  const blur = hero.querySelector(':scope > .st-blur');
  window.__t1b = {
    blurUp: !!blur,
    blurIsImg: !!blur && blur.tagName === 'IMG',
    blurBehind: !!blur && getComputedStyle(blur).position === 'absolute',
  };
  // storyThumbMedia seeks to 0.06 on loadeddata: fake the seek in flight the
  // way the real thumbnail does, or the test would never see the race.
  Object.defineProperty(vid, 'seeking', { get: () => true, configurable: true });
  vid.dispatchEvent(new Event('loadeddata'));
  window.__t2 = {
    heroLoading: hero.classList.contains('st-loading'),
    mediaFaded: getComputedStyle(vid).opacity === '0',
    blurUp: !!hero.querySelector(':scope > .st-blur'),
  };
  Object.defineProperty(vid, 'seeking', { get: () => false, configurable: true });
  vid.dispatchEvent(new Event('seeked'));
  setTimeout(() => {
    window.__t3 = {
      heroLoading: hero.classList.contains('st-loading'),
      mediaShown: getComputedStyle(vid).opacity === '1',
      blurGone: !hero.querySelector(':scope > .st-blur'),
    };
    // The give-up path: storyThumbRetry removes a thumbnail the 423 gate never
    // opens. The spinner must not sit on the empty card forever.
    const hero2 = spHero([vit]);
    document.getElementById('hero2').appendChild(hero2);
    hero2.querySelector('.sp-hero-media').remove();
    setTimeout(() => {
      window.__t4 = {
        heroLoading: hero2.classList.contains('st-loading'),
        blurGone: !hero2.querySelector(':scope > .st-blur'),
      };
      // A photo arms the spinner now too, with the same blur-up, and settles
      // on load (the stub points the photo at an instant data URL).
      const pit = { id: 'p1', kind: 'image', url: ${JSON.stringify(WHITE)}, created_at: now - 3600e3, expires_at: now + 72000e3, views: 1, reactions: [] };
      const hero3 = spHero([pit]);
      document.getElementById('hero3').appendChild(hero3);
      const pimg = hero3.querySelector('.sp-hero-media');
      window.__t5 = {
        heroLoading: hero3.classList.contains('st-loading'),
        mediaReal: pimg.classList.contains('st-real'),
        mediaFaded: getComputedStyle(pimg).opacity === '0',
      };
      setTimeout(() => {
        window.__t6 = {
          heroLoading: hero3.classList.contains('st-loading'),
          mediaShown: getComputedStyle(pimg).opacity === '1',
          blurGone: !hero3.querySelector(':scope > .st-blur'),
        };
        // A blur that can never load degrades to spinner-only: no broken
        // image, no stranded layer, the spinner keeps working.
        storyBlurSrc = () => 'https://example.invalid/nope.webp';
        const hero4 = spHero([vit]);
        document.getElementById('hero4').appendChild(hero4);
        setTimeout(() => {
          window.__t7 = {
            heroLoading: hero4.classList.contains('st-loading'),
            blurGone: !hero4.querySelector(':scope > .st-blur'),
          };
          window.__ready = true;
        }, 600);
      }, 600);
    }, 700);
  }, 400);
}, 400);
</script></body></html>`;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-vidspin-'));
  const pagePath = path.join(tmp, 'page.html');
  fs.writeFileSync(pagePath, pageHtml());
  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    '--user-data-dir=' + path.join(tmp, 'prof'), '--no-first-run', '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu', '--hide-scrollbars', '--window-size=900,1200', 'about:blank'], { stdio: 'ignore' });
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
    await cmd('Page.navigate', { url: 'file:///' + pagePath.replace(/\\/g, '/') });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) { ready = await ev('!!window.__ready').catch(() => false); if (!ready) await sleep(150); }
    if (!ready) return finish('the harness page did not render');

    console.log('\n[3] a loading video hero wears the spinner over a blurred placeholder');
    const t1 = await ev('window.__t1');
    check(t1.heroLoading, 'the hero arms .st-loading while the video has no frame');
    check(t1.badgeLoading, 'the badge ring arms it too');
    check(t1.mediaReal, 'the media carries .st-real for the crossfade');
    check(t1.mediaFaded, 'the <video> is faded out (no grey play button can paint)');
    check(t1.spinAnim, 'the ::after spinner is animated with up-spin');
    check(t1.spinSize === '26px', 'the hero spinner is the full-size mark', t1.spinSize);

    console.log('\n[3b] the blur-up layer paints behind the spinner');
    const t1b = await ev('window.__t1b');
    check(t1b.blurUp, 'a .st-blur layer appears while loading');
    check(t1b.blurIsImg, 'the blur layer is an <img>');
    check(t1b.blurBehind, 'the blur layer is absolutely positioned behind the media');

    console.log('\n[4] the 0.06s seek does not flash the placeholder');
    const t2 = await ev('window.__t2');
    check(t2.heroLoading, 'loadeddata mid-seek keeps the spinner up');
    check(t2.mediaFaded, 'the <video> stays faded through the seek');
    check(t2.blurUp, 'the blur stays up through the seek');

    console.log('\n[5] the seeked frame settles it');
    const t3 = await ev('window.__t3');
    check(!t3.heroLoading, 'seeked drops the loading class');
    check(t3.mediaShown, 'the video is visible again');
    check(t3.blurGone, 'the blur leaves after the crossfade');

    console.log('\n[6] the give-up path does not strand a spinner');
    const t4 = await ev('window.__t4');
    check(!t4.heroLoading, 'removing the thumbnail clears the loading class');
    check(t4.blurGone, 'removing the thumbnail clears the blur too');

    console.log('\n[7] photos arm the spinner with the same blur-up');
    const t5 = await ev('window.__t5');
    check(t5.heroLoading, 'a photo hero arms .st-loading while it loads');
    check(t5.mediaReal, 'the photo carries .st-real for the crossfade');
    check(t5.mediaFaded, 'the photo is faded out while loading');
    const t6 = await ev('window.__t6');
    check(!t6.heroLoading, 'load drops the loading class');
    check(t6.mediaShown, 'the photo is visible again');
    check(t6.blurGone, 'the blur leaves after the crossfade');

    console.log('\n[8] a blur that cannot load degrades to spinner-only');
    const t7 = await ev('window.__t7');
    check(t7.heroLoading, 'the spinner keeps working without the blur');
    check(t7.blurGone, 'the failed blur never paints');
  } finally {
    try { if (ws) ws.close(); } catch {}
    try { chrome.kill(); } catch {}
  }
  finish();
}

main().catch((e) => { console.error('[test] ' + (e && e.message || e)); process.exit(1); });
