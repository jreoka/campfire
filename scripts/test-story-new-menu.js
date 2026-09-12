// "Add to your story" asks how on a desktop instead of opening the camera
// (see AGENTS.md verification conventions).
//
// The complaint: every way into a new post opened the camera, so a desktop user
// who meant to upload a photo (or write a text-only card) got a browser camera
// permission prompt over an empty viewfinder first. Now every create-story
// entry goes through createStory() in public/js/stories.js: a touch device still
// gets the camera in one tap (isCoarse), a mouse device gets a three-row chooser
// — Use your camera / Upload a photo or video / Text only — and the composer can
// be opened straight into a picked file or a text card with no camera at all.
//
// Offline: the markup, the stylesheet and every wiring/entry-point check. Then
// headless Chrome drives the REAL chooser markup + stylesheet and the REAL
// createStory/openStoryNewMenu/closeStoryNewMenu and wiring (skips without
// Chrome): the menu opens on the camera row, each row hands the composer the
// right thing (server scope carried through), Upload keeps the menu up until a
// real file lands (and refuses a non-media file), the backdrop/✕ close it, and
// a coarse pointer skips the menu entirely.
//
// Usage: node scripts/test-story-new-menu.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
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

const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const stories = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');
const final = fs.readFileSync(path.join(ROOT, 'public/js/final.js'), 'utf8');
const auth = fs.readFileSync(path.join(ROOT, 'public/js/auth.js'), 'utf8');
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}
const menuMarkup = (/<div id="story-new" class="hidden">[\s\S]*?<input id="sn-file"[^>]*\/>\s*<\/div>/.exec(index) || [''])[0];
const createSrc = slice(stories, 'let snOpts = null;', 'async function openStoryComposer(opts = {}) {');
const menuWire = slice(stories, "$('#sn-close').onclick", "$('#sv-close').onclick");

console.log('\n[1] the chooser exists, and every row says what it does');
check(!!menuMarkup && /class="sn-card"/.test(menuMarkup) && /role="dialog"/.test(menuMarkup),
  'a dialog card is in the markup', { found: !!menuMarkup });
check(/id="sn-title"[^>]*>Add to your story</.test(menuMarkup), 'headed "Add to your story"');
for (const [id, name, sub] of [
  ['sn-camera', 'Use your camera', 'Snap a photo'],
  ['sn-upload', 'Upload a photo or video', 'Pick something from this device'],
  ['sn-text', 'Text only', 'no camera'],
]) {
  const row = new RegExp('<button type="button" class="sn-row" id="' + id + '">[\\s\\S]*?</button>').exec(menuMarkup);
  check(!!row && row[0].includes('>' + name + '<') && row[0].includes(sub),
    'the ' + id + ' row carries its label and its one-line explanation', row && row[0].slice(0, 90));
}
check(/id="sn-camera"[\s\S]*?<svg/.test(menuMarkup) && /id="sn-upload"[\s\S]*?<svg/.test(menuMarkup),
  'camera and upload draw real icons (no emoji in chrome — owner design rule)');
check(/id="sn-text"[\s\S]{0,400}?<span class="sn-ic sn-aa">Aa<\/span>/.test(menuMarkup),
  'text-only reuses the composer\'s "Aa" mark');
check(/<input id="sn-file" type="file" accept="image\/\*,video\/\*" class="hidden" \/>/.test(menuMarkup),
  'and a media-only file input is parked in the card');
check(/id="sn-close"/.test(menuMarkup) && /aria-label="Cancel"/.test(menuMarkup), 'with a labelled cancel button');

console.log('\n[2] the stylesheet: a centred card of tonal rows');
check(/#story-new\{position:fixed;inset:0;[\s\S]{0,120}?display:flex;align-items:center;justify-content:center/.test(css),
  'the overlay centres its card (no menu hanging off an anchor)');
check(/\.sn-card\{background:var\(--panel-2\);border:1px solid var\(--line-soft\)/.test(css),
  'the card is a flat tonal surface with a hairline edge (elevation by tonal step, per the design rules)');
check(/\.sn-row\{[^}]*background:var\(--panel-3\)/.test(css) && /\.sn-row:hover\{background:var\(--panel-4\)/.test(css),
  'rows are tonal steps, and hover is one step up');
check(/\.sn-rows\{display:flex;flex-direction:column/.test(css), 'the three rows stack vertically');
check(/\.sn-ic\{width:42px;height:42px;[^}]*background:var\(--accent-dim\)/.test(css),
  'each row leads with a 42px accent-tinted icon tile');
check(/#story-new,\.sn-card,#lightbox img/.test(css), 'the chooser honours prefers-reduced-motion with the other overlays');

console.log('\n[3] createStory owns the desktop/touch decision');
check(/function createStory\(opts = \{\}\) \{\r?\n\s*if \(isCoarse\(\)\) \{ openStoryComposer\(opts\); return; \}\r?\n\s*openStoryNewMenu\(opts\);/.test(createSrc),
  'a coarse pointer goes straight to the camera, a mouse gets the menu');
check(/function openStoryNewMenu\(opts = \{\}\) \{[\s\S]*?if \(!el \|\| sc\) return;/.test(createSrc),
  'the menu never opens over a running composer');
check(/const b = \$\('#sn-camera'\);[\s\S]{0,80}?b\.focus\(\)/.test(createSrc),
  'opening it focuses the first row (keyboard reachable)');

console.log('\n[4] every create-story entry asks first');
const entries = [
  ['the story center hero\'s Add', /add\.onclick = \(\) => createStory\(\{\}\);/],
  ['the hero\'s Post a story', /post\.onclick = \(\) => createStory\(\{\}\);/],
  ['the empty-state button', /b\.onclick = \(\) => createStory\(\{\}\);/],
  ['the server sidebar ＋', /add\.onclick = \(e\) => \{ e\.stopPropagation\(\); createStory\(\{ serverId: S\.serverId \}\); \};/],
  ['the server stories sheet', /classList\.add\('hidden'\); createStory\(\{ serverId: serverIdForPost \|\| null \}\);/],
  ['the composer menu item', /createStory\(\{ serverId: S\.view === 'server' \? S\.serverId : null \}\);/],
  ['Home\'s Stories ＋', /\$\('#stories-nav-add'\)\.onclick = \(\) => createStory\(\{\}\);/],
  ['the story page\'s post button', /\$\('#sp-post'\)\.onclick = \(\) => createStory\(\{\}\);/],
];
for (const [name, re] of entries) check(re.test(stories), name + ' starts a post through createStory');
check(!/onclick = \(\) => openStoryComposer\(/.test(stories), 'no entry still opens the camera directly');
check(/openStoryComposer\(\{ viewOnce: true, viewOnceUser: viewOnceDmPeerId\(\) \}\);/.test(stories),
  'the view-once composer is untouched (it is not a story post)');
check(/await openStoryComposer\(\{\}\)/ .test(auth), 'and the home-screen shortcut still lands in the camera (it asked for it)');

console.log('\n[5] the rows, and the composer they open');
check(/\$\('#sn-camera'\)\.onclick = \(\) => \{ const o = snOpts \|\| \{\}; closeStoryNewMenu\(\); openStoryComposer\(o\); \};/.test(stories),
  'camera hands the stored options to the composer unchanged');
check(/\$\('#sn-text'\)\.onclick = \(\) => \{ const o = snOpts \|\| \{\}; closeStoryNewMenu\(\); openStoryComposer\(\{ \.\.\.o, text: true \}\); \};/.test(stories),
  'text-only opens the composer with text:true');
check(/\$\('#sn-upload'\)\.onclick = \(\) => \{ const f = \$\('#sn-file'\); if \(f\) f\.click\(\); \};/.test(stories),
  'upload opens the file dialog out of the click itself (a real user gesture)');
check(/\$\('#sn-file'\)\.addEventListener\('change',[\s\S]{0,400}?if \(!\/\^\(image\|video\)\\\/\/\.test\(file\.type \|\| ''\)\) \{ toast\('Pick a photo or a video'\); return; \}/.test(stories),
  'and refuses a non-media file before the composer is opened at all');
check(/\$\('#sn-close'\)\.onclick = \(\) => closeStoryNewMenu\(\);/.test(stories)
  && /\$\('#story-new'\)\.addEventListener\('click', \(e\) => \{ if \(e\.target\.id === 'story-new'\) closeStoryNewMenu\(\); \}\)/.test(stories),
  'the ✕ and the backdrop both close it');
check(/closeStoryNewMenu\(\); cancelModal\(\)/.test(final), 'Escape closes it too');

console.log('\n[6] the composer can start from a file or a text card (no camera)');
check(/if \(opts\.file\) \{\r?\n\s*const shown = await storyPickFile\(opts\.file\);\r?\n\s*if \(sc && !shown\) await storyStartCam\(\);/.test(stories),
  'a picked file skips the camera, and a refused one falls back to it');
check(/\} else if \(opts\.text\) \{\r?\n\s*await storyStartTextOnly\(\);/.test(stories),
  'a text card opens straight into the text editor');
check(/\} else \{\r?\n\s*await storyStartCam\(\);/.test(stories), 'and the plain path is still the camera');
check(/async function storyPickFile\(file\) \{\r?\n\s*if \(!sc \|\| !file\) return false;/.test(stories)
  && /toast\('Pick a photo or a video'\);\r?\n\s*return false;/.test(stories),
  'storyPickFile reports whether anything landed');

// ---------- headless Chrome ----------
function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<!-- Headless virtual time freezes compositor animations on their first frame,
     and cf-rise starts the card at scale(.985) — every measurement below would
     read 1.5% small. The entry animation is covered by the stylesheet checks. -->
<style>#story-new,.sn-card{animation:none!important}</style></head><body>
${menuMarkup}
<script>
window.$ = (s) => document.querySelector(s);
window.sc = null;
let COARSE = new URLSearchParams(location.search).get('coarse') === '1';
function isCoarse() { return COARSE; }
const calls = [], toasts = [];
function openStoryComposer(o) { calls.push(o || {}); return Promise.resolve(true); }
function toast(m) { toasts.push(String(m)); }
eval(${JSON.stringify(createSrc + '\n' + menuWire)});

function geom(sel) { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; }
window.__run = function () {
  const menu = document.getElementById('story-new');
  const vis = () => !menu.classList.contains('hidden');
  const reset = () => { calls.length = 0; toasts.length = 0; closeStoryNewMenu(); };
  const out = { vw: innerWidth, vh: innerHeight };
  const rows = () => [...document.querySelectorAll('#story-new .sn-row')];

  // A. a mouse device: the menu, not the camera
  reset();
  createStory({ serverId: 's1' });
  out.opens = { menu: vis(), composer: calls.length, focused: (document.activeElement || {}).id || '' };
  const card = document.querySelector('.sn-card');
  const cs = getComputedStyle(card);
  out.look = {
    card: geom('.sn-card'), bg: cs.backgroundColor, radius: cs.borderTopLeftRadius,
    rows: rows().length, rowTexts: rows().map((r) => ({ name: r.querySelector('.sn-name').textContent, sub: r.querySelector('.sn-sub').textContent })),
    ics: rows().map((r) => r.querySelector('.sn-ic')),
    overflow: rows().map((r) => r.scrollWidth - r.clientWidth),
    // the rows must be a vertical stack of comfortable targets
    stack: rows().every((r, i) => i === 0 || r.getBoundingClientRect().top >= rows()[i - 1].getBoundingClientRect().bottom - 1),
    heights: rows().map((r) => Math.round(r.getBoundingClientRect().height)),
    icBoxes: rows().map((r) => { const b = r.querySelector('.sn-ic').getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; }),
    centered: Math.abs((geom('.sn-card').l + geom('.sn-card').r) / 2 - innerWidth / 2) <= 1.5,
  };

  // B. camera → the composer with the same options, menu gone
  document.getElementById('sn-camera').click();
  out.camera = { menu: vis(), opts: calls[0] };

  // C. text only → text:true (and the server scope survives)
  reset(); createStory({ serverId: 's1' }); document.getElementById('sn-text').click();
  out.text = { menu: vis(), opts: calls[0] };

  // D. upload: nothing opens until a file lands
  reset(); createStory({ serverId: 's1' }); document.getElementById('sn-upload').click();
  out.uploadClick = { menu: vis(), composer: calls.length };
  const input = document.getElementById('sn-file');
  const feed = (file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); };
  feed(new File(['x'], 'notes.txt', { type: 'text/plain' }));
  out.badFile = { menu: vis(), composer: calls.length, toasts: toasts.slice() };
  feed(new File(['x'], 'shot.png', { type: 'image/png' }));
  out.goodFile = { menu: vis(), composer: calls.length, name: calls[0] && calls[0].file && calls[0].file.name, serverId: calls[0] && calls[0].serverId, text: !!(calls[0] && calls[0].text) };

  // E. the way out
  reset(); createStory({}); document.getElementById('story-new').click();
  out.backdrop = { menu: vis() };
  reset(); createStory({}); document.getElementById('sn-close').click();
  out.close = { menu: vis() };
  reset(); createStory({}); closeStoryNewMenu();
  out.cleared = { menu: vis() };

  // F. a phone: no menu at all, the camera is the tap
  COARSE = true;
  reset();
  createStory({ serverId: 's7' });
  out.coarse = { menu: vis(), composer: calls.length, opts: calls[0] };
  COARSE = false;

  // G. a second open after a cancel still behaves (snOpts was cleared)
  reset();
  createStory({ serverId: 's1' });
  document.getElementById('sn-close').click();
  createStory({ serverId: 's2' });
  document.getElementById('sn-camera').click();
  out.reopen = { opts: calls[0], menu: vis() };
  return out;
};
// The card has a .16s entry animation (cf-rise scales it from .985), so report
// once it has settled — measurements taken mid-animation read a 41px tile.
// ?shot=1 just leaves the menu open for a screenshot.
if (/shot=1/.test(location.search)) { createStory({}); }
else setTimeout(() => {
  try { document.title = JSON.stringify(window.__run()); }
  catch (e) { document.title = JSON.stringify({ fatal: (e && e.message) || String(e) }); }
}, 400);
</script></body></html>`;
}

function probe(chrome, url, width, height, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-storynew-'));
  try {
    const htmlPath = path.join(dir, (tag || 'page') + '.html');
    fs.writeFileSync(htmlPath, pageHtml());
    const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=' + width + ',' + height,
      '--virtual-time-budget=3000', '--dump-dom', 'file:///' + htmlPath.replace(/\\/g, '/')],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
    if (!m) throw new Error('no title in dump (chrome status ' + r.status + ')');
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

const chrome = findChrome();
if (!chrome) {
  console.log('\n[test] SKIP browser half: no Chrome/Edge found (set CHROME_PATH)');
} else {
  const out = probe(chrome, '', 1000, 720, 'desktop');
  if (out.fatal) {
    check(false, 'the chooser harness ran', out.fatal);
  } else {
    console.log('\n[7] the menu itself (headless Chrome, 1000x720)');
    check(out.opens.menu === true && out.opens.composer === 0, 'createStory opens the menu, not the camera', out.opens);
    check(out.opens.focused === 'sn-camera', 'with the camera row focused', out.opens.focused);
    check(out.look.rows === 3 && out.look.rowTexts.map((r) => r.name).join('|') === 'Use your camera|Upload a photo or video|Text only',
      'three rows, in that order', out.look.rowTexts);
    check(out.look.rowTexts.every((r) => r.sub.length > 6), 'each one explains itself', out.look.rowTexts);
    check(out.look.stack && out.look.heights.every((h) => h >= 56), 'they stack as comfortable targets', out.look.heights);
    check(out.look.icBoxes.every(([w, h]) => w === 42 && h === 42), 'every row leads with the same 42px tile', out.look.icBoxes);
    check(out.look.overflow.every((n) => n <= 1), 'and nothing overflows its row', out.look.overflow);
    check(out.look.centered && out.look.card.w <= 404 && out.look.card.t > 60 && out.look.card.b < out.vh - 60,
      'the card is centred with room around it', out.look.card);
    check(/^rgb/.test(out.look.bg) && out.look.bg !== 'rgba(0, 0, 0, 0)', 'the card is an opaque surface, not a floating ghost', out.look.bg);

    console.log('\n[8] what each row hands the composer');
    check(JSON.stringify(out.camera.opts) === '{"serverId":"s1"}' && out.camera.menu === false,
      'camera: the same options, menu closed', out.camera);
    check(JSON.stringify(out.text.opts) === '{"serverId":"s1","text":true}' && out.text.menu === false,
      'text only: text:true on top of those options', out.text);
    check(out.uploadClick.menu === true && out.uploadClick.composer === 0,
      'upload: the menu stays up — nothing opens until a file is picked', out.uploadClick);
    check(out.badFile.composer === 0 && out.badFile.menu === true && out.badFile.toasts.join('|') === 'Pick a photo or a video',
      'a non-media file is refused out loud and opens nothing', out.badFile);
    check(out.goodFile.composer === 1 && out.goodFile.menu === false && out.goodFile.name === 'shot.png'
      && out.goodFile.serverId === 's1' && out.goodFile.text === false,
      'a picked photo opens the composer with the file and the server scope', out.goodFile);

    console.log('\n[9] the way out, and the phone\'s one tap');
    check(out.backdrop.menu === false && out.close.menu === false && out.cleared.menu === false,
      'the backdrop, the ✕ and a programmatic close all put it away', out);
    check(out.coarse.menu === false && out.coarse.composer === 1 && JSON.stringify(out.coarse.opts) === '{"serverId":"s7"}',
      'a coarse pointer never sees the menu — straight to the camera', out.coarse);
    check(JSON.stringify(out.reopen.opts) === '{"serverId":"s2"}' && out.reopen.menu === false,
      'a cancelled menu does not leak its options into the next one', out.reopen);

    console.log('\n[10] a narrow desktop window still fits');
    const narrow = probe(chrome, '', 420, 620, 'narrow');
    if (narrow.fatal) {
      check(false, 'the narrow harness ran', narrow.fatal);
    } else {
      check(narrow.look.card.l >= 8 && narrow.look.card.r <= narrow.vw - 8, 'the card keeps its side margin', narrow.look.card);
      check(narrow.look.card.b <= narrow.vh && narrow.look.overflow.every((n) => n <= 1),
        'and stays inside the window with nothing clipped', { card: narrow.look.card, overflow: narrow.look.overflow });
    }

    // A picture of the settled card, for eyeballing (the numbers above are the
    // assertions). Writes campfire-story-new-menu.png to the temp dir.
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-storynew-shot-'));
      const htmlPath = path.join(dir, 'shot.html');
      fs.writeFileSync(htmlPath, pageHtml());
      const png = path.join(os.tmpdir(), 'campfire-story-new-menu.png');
      spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
        '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=1000,720',
        '--virtual-time-budget=3000', '--screenshot=' + png, 'file:///' + htmlPath.replace(/\\/g, '/') + '?shot=1'],
        { encoding: 'utf8', timeout: 60000 });
      fs.rmSync(dir, { recursive: true, force: true });
      if (fs.existsSync(png)) console.log('  (wrote ' + png + ')');
    } catch {}
  }
}

console.log('\n' + (failures.length ? failures.length + ' FAILED, ' + passed + ' passed' : 'all ' + passed + ' checks passed'));
process.exit(failures.length ? 1 : 0);
