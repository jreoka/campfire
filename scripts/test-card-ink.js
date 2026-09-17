// The user card's ink follows a custom card colour (see AGENTS.md).
//
// The report: pick a bright profile gradient colour and the text on the card —
// which was simply "whatever the theme says" — stops being readable. A custom
// card colour IS the card's backdrop, so neither theme's ink can be trusted on
// it: the light theme's near-black text disappears into a saturated gradient
// (the picked colour is usually a vivid blue/red), and the dark theme's
// near-white disappears into a pale one. So the card paints its own tones
// (--uc-text/--uc-muted/--uc-faint/--uc-link/--uc-chip), defaulted to the
// theme's in styles.css and re-pointed by two classes the card wears.
//
// The direction is cardInkFor()'s (servers.js), and this drives the REAL one by
// extracting it from the file and running it against the colours people pick.
// The last section loads the REAL stylesheet in headless Chrome and reads
// computed styles, because "the text is white and the tab list is not" is a
// claim about CSS, not about a string.
//
// Offline except that section (no database, no server required).
//
// Usage: node scripts/test-card-ink.js
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

const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const servers = readSrc('public/js/servers.js');
const pickers = readSrc('public/js/pickers.js');
const css = readSrc('public/styles.css');

function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}

// The real HEXC / cardBgFor / hexRelLum / cardInkFor, out of the real file.
const code = slice(servers, 'const HEXC =', '// Live profile for a message author');
const { cardBgFor, cardInkFor, hexRelLum } = eval(code + '\n;({ cardBgFor, cardInkFor, hexRelLum })');

// The card's two inks, read out of the stylesheet so this suite cannot drift
// from the CSS it is describing (and so the contrast maths below is about the
// real tones).
function cssInk(which) {
  const m = new RegExp('#usercard\\.uc-ink-' + which + '\\{([^}]*)\\}').exec(css);
  if (!m) return null;
  const v = /--uc-text:\s*(#[0-9a-fA-F]{3,6})/.exec(m[1]);
  if (!v) return null;
  let hex = v[1];
  if (hex.length === 4) hex = '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
  return hex;
}
const INK_LIGHT_HEX = cssInk('light');
const INK_DARK_HEX = cssInk('dark');
function contrast(a, b) {
  const la = hexRelLum(a), lb = hexRelLum(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
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

// A card with one of each text position on it: the plain tones that sit on the
// backdrop, the bio's link and inline code, and the opaque panels (tab list,
// status bubble, presence switcher) that must keep the theme's own tones.
function inkPageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>*{transition:none!important;animation:none!important}</style></head><body>
<div id="usercard" style="background:linear-gradient(180deg,#5b6cff,#7c3aed)">
  <div class="uc-body">
    <div class="uc-name"><span>Jordan</span></div>
    <div class="uc-sub">@jordan</div>
    <div class="uc-status"><span>Online</span></div>
    <div class="uc-bio">out camping <a href="#">a link</a> <code>code</code></div>
    <div class="uc-since">Member since 2024</div>
    <div class="uc-sec-label">Mic volume</div>
    <div class="uc-vol"><input type="range" value="50" /><span>50%</span></div>
    <div id="uc-gaming" class="uc-gaming"><div class="uc-gaming-head">Gaming</div>
      <div class="uc-gaming-row"><span class="uc-gaming-name">Chess</span><span class="uc-gaming-meta">Lv 3 · 4h</span></div></div>
    <div class="uc-tabs"><button type="button" class="uc-tab"><span>Message</span></button></div>
    <div class="uc-badges"><span class="early-badge">Early user</span><span class="sysadmin-badge">System admin</span></div>
    <div class="uc-statustext ustream"><span class="vlive">LIVE</span><span>Streaming</span></div>
    <div class="uc-statustext ugame"><span class="gbadge"></span><span>Playing Chess</span></div>
    <div class="uc-roles"><span class="role-pill">Admin</span></div>
    <div class="uc-head"><span class="avatar big"></span><div class="uc-bubble-wrap"><div class="uc-bubble">a status</div></div></div>
    <div class="uc-presence"><button type="button" class="prow"><span class="plabel">Online</span></button></div>
  </div>
</div>
<script>
const card = document.getElementById('usercard');
const out = {};
const color = (sel) => { const el = card.querySelector(sel); return el ? getComputedStyle(el).color : null; };
const bg = (sel) => { const el = card.querySelector(sel); return el ? getComputedStyle(el).backgroundColor : null; };
const border = (sel) => { const el = card.querySelector(sel); return el ? getComputedStyle(el).borderTopColor : null; };
const snap = () => ({
  name: color('.uc-name'),
  sub: color('.uc-sub'),
  status: color('.uc-status'),
  bio: color('.uc-bio'),
  link: color('.uc-bio a'),
  since: color('.uc-since'),
  seclabel: color('.uc-sec-label'),
  volpct: color('.uc-vol span'),
  gamingHead: color('.uc-gaming-head'),
  gamingRow: color('.uc-gaming-row'),
  gamingMeta: color('.uc-gaming-meta'),
  codeBg: bg('.uc-bio code'),
  tab: color('.uc-tab'),
  bubble: color('.uc-bubble'),
  prow: color('.prow'),
  early: { color: color('.early-badge'), bg: bg('.early-badge') },
  admin: { color: color('.sysadmin-badge'), bg: bg('.sysadmin-badge') },
  stream: { color: color('.uc-statustext.ustream'), bg: bg('.uc-statustext.ustream') },
  streamLive: color('.uc-statustext.ustream .vlive'),
  game: { color: color('.uc-statustext.ugame'), bg: bg('.uc-statustext.ugame') },
  gameBadge: { color: color('.gbadge'), bg: bg('.gbadge') },
  pill: { color: color('.role-pill'), border: border('.role-pill') },
});
const both = { light: {}, dark: {} };
for (const theme of ['dark', 'light']) {
  document.documentElement.dataset.theme = theme;
  for (const [key, cls] of [['light', 'uc-ink-light'], ['dark', 'uc-ink-dark']]) {
    card.classList.remove('uc-ink-light', 'uc-ink-dark');
    card.classList.add(cls);
    both[key][theme] = snap();
  }
  card.classList.remove('uc-ink-light', 'uc-ink-dark');
  both['themeOnly'] = both['themeOnly'] || {};
  both.themeOnly[theme] = snap();
}
document.title = JSON.stringify(both);
</script></body></html>`;
}

async function main() {
  console.log('\n[1] no custom card colour leaves the card to the theme');
  check(cardInkFor(null) === '', 'a null user paints no ink');
  check(cardInkFor({}) === '', 'no colours set → no ink');
  check(cardInkFor({ card_color: 'red' }) === '', 'a colour that is not #rrggbb is ignored, as cardBgFor ignores it');
  check(cardInkFor({ card_gradient: '#ffffff' }) === '', 'a gradient with no base colour is not a backdrop at all (cardBgFor returns nothing)');
  check(cardBgFor({ card_color: '#5b6cff', card_gradient: '#7c3aed' }) === 'linear-gradient(180deg,#5b6cff,#7c3aed)', 'and the pair still paints the gradient');

  console.log('\n[2] a pale card takes dark ink');
  const pale = [
    ['#ffffff', 'white'],
    ['#aac7ff', 'the colour picker\'s own default'],
    ['#ffd166', 'a warm pastel'],
    ['#e9edf4', 'the light theme\'s own card surface'],
    ['#39ff14', 'a neon green — bright enough that pale ink on it is the trap, not the fix'],
  ];
  for (const [hex, why] of pale) check(cardInkFor({ card_color: hex }) === 'dark', hex + ' (' + why + ') → dark ink', cardInkFor({ card_color: hex }));

  console.log('\n[3] a deep or saturated card takes light ink');
  const deep = [
    ['#000000', 'black'],
    ['#1d2536', 'the dark theme\'s own tonal surface'],
    ['#5b6cff', 'the app\'s own accent — the case that was reported'],
    ['#7c3aed', 'violet'],
    ['#b91c1c', 'the danger red'],
    ['#dc2626', 'a brighter red'],
  ];
  for (const [hex, why] of deep) check(cardInkFor({ card_color: hex }) === 'light', hex + ' (' + why + ') → light ink', cardInkFor({ card_color: hex }));

  console.log('\n[4] a gradient is judged on the middle of its ramp');
  check(cardInkFor({ card_color: '#5b6cff', card_gradient: '#7c3aed' }) === 'light', 'two saturated stops → light ink');
  check(cardInkFor({ card_color: '#1d2536', card_gradient: '#aac7ff' }) === 'dark', 'a dark top into a pale bottom → dark ink (the mean is pale)');
  const mid = { card_color: '#000000', card_gradient: '#ffffff' };
  check(cardInkFor(mid) === 'dark', 'black → white lands just above the crossover, so dark ink wins it', cardInkFor(mid));

  console.log('\n[5] the rule is luminance, not vibes');
  // A vivid green is the case that separates the two: it *looks* saturated
  // enough to want white text, but dark ink beats it by a wide margin.
  const green = '#0f9d6c';
  check(cardInkFor({ card_color: green }) === 'dark', 'a vivid green still takes dark ink', cardInkFor({ card_color: green }));
  check(contrast(INK_DARK_HEX, green) > contrast(INK_LIGHT_HEX, green),
    'because dark ink really is the more readable one there',
    { dark: +contrast(INK_DARK_HEX, green).toFixed(2), light: +contrast(INK_LIGHT_HEX, green).toFixed(2) });
  // The grey ramp: monotone in luminance, one flip, and never an unreadable
  // pairing on either side of it.
  let flips = 0, flipAt = null, worst = { ratio: Infinity, hex: null };
  let prev = cardInkFor({ card_color: '#000000' });
  const hex2 = (v) => '#' + v.toString(16).padStart(2, '0').repeat(3);
  for (let v = 1; v <= 255; v++) {
    const hex = hex2(v);
    const ink = cardInkFor({ card_color: hex });
    if (ink !== prev) { flips++; flipAt = hex; }
    prev = ink;
    const ratio = contrast(ink === 'light' ? INK_LIGHT_HEX : INK_DARK_HEX, hex);
    if (ratio < worst.ratio) worst = { ratio: +ratio.toFixed(2), hex, ink };
  }
  check(flips === 1, 'the ink flips exactly once across the whole grey ramp', { flips, flipAt });
  check(flipAt >= '#7a7a7a' && flipAt <= '#8a8a8a', 'and it flips at mid-grey, where the two inks are equally readable', flipAt);
  check(worst.ratio >= 3.5, 'every grey on the ramp keeps at least 3.5:1 against the ink it is given', worst);
  check(hexRelLum('#000000') === 0 && Math.abs(hexRelLum('#ffffff') - 1) < 1e-9, 'the luminance ramp is anchored at both ends');

  console.log('\n[6] the card wears the ink it was given');
  const paint = slice(pickers, 'card.style.background = cardBgFor(u);', 'card.innerHTML =');
  check(/const ink = cardInkFor\(u\);/.test(paint), 'openUserCard asks cardInkFor for the direction', paint);
  check(/card\.classList\.toggle\('uc-ink-light', ink === 'light'\)/.test(paint), 'and toggles the light-ink class', paint);
  check(/card\.classList\.toggle\('uc-ink-dark', ink === 'dark'\)/.test(paint), 'as well as the dark-ink one — toggled, not added, so a card with no custom colour clears both', paint);

  console.log('\n[7] the stylesheet paints the tones it promised');
  check(!!INK_LIGHT_HEX && !!INK_DARK_HEX, 'both ink classes define --uc-text', { INK_LIGHT_HEX, INK_DARK_HEX });
  check(/\n#usercard\{[^}]*--uc-text:var\(--text\)/.test(css), 'and the card defaults its tones to the theme\'s');
  const onBackdrop = ['#usercard .uc-name', '#usercard .uc-sub', '#usercard .uc-bio', '#usercard .uc-since',
    '#usercard .uc-sec-label', '#usercard .uc-vol span', '#usercard .uc-gaming-head', '#usercard .uc-gaming-row',
    '#usercard .uc-gaming-meta', '#usercard .uc-bubble-exp', '#usercard .uc-status'];
  for (const sel of onBackdrop) check(css.includes(sel), sel.slice('#usercard '.length) + ' reads a card tone, not the theme\'s');
  check(/#usercard \.uc-bio a[^{]*\{color:var\(--uc-link\)\}/.test(css), 'so does the bio\'s link');
  check(css.includes('#usercard .uc-bio code,#usercard .uc-bio .spoiler.shown{background:var(--uc-chip)}'),
    'and the bio\'s chips (inline code, a revealed spoiler) go tonal against the backdrop');
  // The opaque panels are their own backdrop: re-pointing them would move THEIR
  // text off the surface it actually sits on.
  const panels = ['#usercard .uc-tab', '#usercard .uc-tabs', '#usercard .uc-bubble', '#usercard .uc-presence', '#usercard .prow', '#usercard .uc-statustext'];
  for (const sel of panels) check(!new RegExp(sel.replace(/[.#]/g, '\\$&') + '\\{[^}]*var\\(--uc-(text|muted|faint)\\)').test(css),
    sel.slice('#usercard '.length) + ' keeps the theme\'s own tones');
  check(css.includes('#usercard.uc-ink-light .uc-statustext.ugame') && css.includes('#usercard.uc-ink-dark .uc-statustext.ugame'),
    'while the two translucent status rows (game, stream) get one on each ink, because they are NOT opaque');

  console.log('\n[8] the real stylesheet, in a real browser');
  const chrome = findChrome();
  if (!chrome) console.log('  (skipped: no Chrome/Edge found — set CHROME_PATH)');
  else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-card-ink-'));
    try {
      const htmlPath = path.join(dir, 'page.html');
      fs.writeFileSync(htmlPath, inkPageHtml());
      const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
        '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=520,900',
        '--virtual-time-budget=2000', '--dump-dom', 'file:///' + htmlPath.replace(/\\/g, '/')],
        { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
      if (!m) check(false, 'the fixture page ran', { status: r.status });
      else {
        const out = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
        const WHITE = 'rgb(255, 255, 255)';
        const DARK = 'rgb(17, 21, 31)';
        const THEME_TEXT = { dark: 'rgb(238, 241, 248)', light: 'rgb(20, 26, 38)' };
        for (const theme of ['dark', 'light']) {
          const l = out.light[theme], d = out.dark[theme], t = out.themeOnly[theme];
          check(l.name === WHITE && l.status === WHITE && l.bio === WHITE && l.gamingRow === WHITE,
            '[' + theme + '] a saturated card paints its own text white whatever the theme says', { name: l.name, themeText: t.name });
          check(d.name === DARK && d.status === DARK && d.bio === DARK && d.gamingRow === DARK,
            '[' + theme + '] a pale card paints it near-black', d.name);
          check(l.themeOnly !== null && t.name === THEME_TEXT[theme], '[' + theme + '] which is not what the theme itself would have used',
            { themeText: t.name, expected: THEME_TEXT[theme] });
          check(/^rgba\(255, 255, 255, 0\.\d+\)$/.test(l.sub || '') && /^rgba\(255, 255, 255, 0\.\d+\)$/.test(l.since || ''),
            '[' + theme + '] the muted tiers follow to white alphas', { sub: l.sub, since: l.since });
          check(/^rgba\(17, 21, 31, 0\.\d+\)$/.test(d.sub || '') && /^rgba\(17, 21, 31, 0\.\d+\)$/.test(d.since || ''),
            '[' + theme + '] and to near-black alphas', { sub: d.sub, since: d.since });
          check(l.seclabel === l.since && l.volpct === l.sub && l.gamingHead === l.since && l.gamingMeta === l.sub,
            '[' + theme + '] every section label, slider readout and gaming row lands on the right tier',
            { seclabel: l.seclabel, since: l.since, volpct: l.volpct, sub: l.sub, gamingHead: l.gamingHead, gamingMeta: l.gamingMeta });
          check(l.codeBg !== d.codeBg && /rgba/.test(l.codeBg || ''),
            '[' + theme + '] inline code goes tonal (a dark chip under light ink, a dark tint under dark ink)', { light: l.codeBg, dark: d.codeBg });
          check(l.tab === THEME_TEXT[theme] && d.tab === THEME_TEXT[theme] && l.bubble === THEME_TEXT[theme] && d.bubble === THEME_TEXT[theme]
            && l.prow === THEME_TEXT[theme] && d.prow === THEME_TEXT[theme],
            '[' + theme + '] while the tab list, status bubble and presence switcher keep the theme\'s tones — they are their own backdrop',
            { tab: l.tab, bubble: l.bubble, prow: l.prow, expected: THEME_TEXT[theme] });
          // The chips on the card that are NOT opaque: the badges, the game and
          // stream rows and the role pills all sat on a translucent theme tint,
          // which over a bright card is neither the card nor the theme.
          const chip = (v) => v.color + ' on ' + v.bg;
          check(l.early.color === WHITE && /^rgba\(0, 0, 0, 0\.\d+\)$/.test(l.early.bg || ''),
            '[' + theme + '] the badges under light ink are a dark tonal chip with white text', chip(l.early));
          check(l.admin.color === 'rgb(255, 218, 218)' && l.admin.bg === l.early.bg,
            '[' + theme + '] and the red one keeps its tint on that same chip', chip(l.admin));
          check(d.early.color === 'rgb(43, 53, 144)' && d.admin.color === 'rgb(143, 20, 20)',
            '[' + theme + '] under dark ink both badges go dark, each in its own hue', { early: chip(d.early), admin: chip(d.admin) });
          check(l.stream.color === WHITE && l.game.color === WHITE && /^rgba\(0, 0, 0, 0\.\d+\)$/.test(l.stream.bg || '') && l.stream.bg === l.game.bg,
            '[' + theme + '] the game and stream rows take that chip on light ink', { stream: chip(l.stream), game: chip(l.game) });
          check(d.stream.color === DARK && d.game.color === DARK && d.stream.bg === d.game.bg,
            '[' + theme + '] and go dark under dark ink', { stream: chip(d.stream), game: chip(d.game) });
          check(l.streamLive === WHITE && d.streamLive === WHITE,
            '[' + theme + '] the LIVE chip keeps its own white on green either way', { light: l.streamLive, dark: d.streamLive });
          check(l.gameBadge.color === WHITE && /^rgba\(255, 255, 255, 0\.\d+\)$/.test(l.gameBadge.bg || '') && d.gameBadge.color === DARK,
            '[' + theme + '] and the game badge goes tonal with the row it rides in', { light: l.gameBadge, dark: d.gameBadge });
          check(l.pill.color === l.sub && d.pill.color === d.sub && l.pill.border !== d.pill.border,
            '[' + theme + '] and the role pills take the ink and a matching hairline', { light: l.pill, dark: d.pill });
        }
        check(!!out.light.dark && !!out.light.light && !!out.dark.dark && !!out.dark.light,
          'both inks were measured against both themes');
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
}

main();
