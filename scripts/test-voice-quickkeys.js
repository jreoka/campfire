// The in-call quick keys above the me bar (see AGENTS.md verification
// conventions).
//
// Two reports, and they are the same bug seen from two sides:
//
//  1. Hover used to swap the key's tone to --panel-4 — the step this app uses
//     for a SELECTED row — and, sitting later in the cascade, that swap also
//     beat the red of an engaged key (.vb-btn.off / .danger). So hovering a
//     muted mic made it look unmuted, and the hover a touch tap leaves stuck
//     behind read as a toggled state: "hover looks the same as being clicked
//     on". The me bar's own buttons got an .off:hover fix once; this row never
//     did. Hover is now a LIFT + hairline ring and never hides the state, and
//     PRESS is the opposite gesture (it sinks a tonal step and drops the ring),
//     so the three can never be confused for one another.
//  2. The row had no life at all: it appeared and sat there. It now staggers in
//     when the call bar is revealed, pops the key (and every mirror of it) on a
//     toggle, and the streaming key breathes a ring while you are on air.
//
// The stylesheet's own cascade is what decides all of that, so the browser half
// RESOLVES it instead of grepping for it: the real stylesheet is inlined, the
// real voice-bar markup is used, and a small cascade reader (specificity +
// document order, with :hover/:active forced to match) answers "what wins in
// this state?". Rest and engaged-rest are cross-checked against the browser's
// own getComputedStyle, so a resolver that disagrees with Chrome fails the test
// rather than quietly passing itself.
//
// Usage: node scripts/test-voice-quickkeys.js
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
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }

const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const voice = fs.readFileSync(path.join(ROOT, 'public/js/voice.js'), 'utf8');

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

// ---------- offline checks ----------
console.log('\n[1] the row itself');
const bar = (() => {
  const a = index.indexOf('<div id="voice-bar"');
  const b = a < 0 ? -1 : index.indexOf('<div id="me-card">', a);
  return a < 0 || b < 0 ? null : index.slice(a, b);
})();
check(!!bar, 'the voice bar markup is where the test expects it');
const keyIds = ['btn-mute', 'btn-deafen', 'btn-camera', 'btn-share', 'btn-voice-leave'];
check(keyIds.every((id) => bar.includes('id="' + id + '"')), 'the bar carries the five quick keys', keyIds);
check(bar.includes('<div class="vb-btns">'), 'and they live in the one .vb-btns row');

console.log('\n[2] rest / hover / press are three different things');
check(/#me-card\{[^}]*z-index:2\}/.test(css) && index.indexOf('id="voice-bar"') < index.indexOf('id="me-card"'),
  'the bar still sits above the me bar (the surface the report named)');
// rest
check(/\.vb-btn\{position:relative;border:0;background:var\(--panel-3\)/.test(css),
  'a resting key is a tonal step off the bar (--panel-3)');
check(/\.vb-btn\.off\{background:#a83226;color:#fff\}/.test(css) && /\.vb-btn\.danger\{background:#a83226;color:#fff\}/.test(css),
  'an engaged key (mic/deafen/cam off, streaming) is red');
check(/\.vb-btn\{[^}]*outline:1\.5px solid transparent/.test(css),
  'the resting key reserves a transparent outline, so a hover ring can fade in without moving anything');
check(/\.vb-btn:focus-visible\{outline:2px solid var\(--accent\)/.test(css),
  'and the focus ring is restated on top of it (a class-level outline would otherwise outrank the global rule)');
// press
check(/\.vb-btn:active\{background:var\(--panel-2\);outline-color:transparent;transform:scale\(\.92\)\}/.test(css),
  'a press SINKS the key a tonal step, drops the ring, and scales down');
check(/\.vb-btn\.off:active,\.vb-btn\.danger:active\{background:#8d271e;outline-color:transparent\}/.test(css),
  'an engaged key presses to a deeper red (not to grey)');
check(css.indexOf('.vb-btn:active{background:var(--panel-2)') > css.indexOf('.vb-btn:hover{background:var(--panel-4)'),
  'and the press block is declared AFTER the hover block — a mouse holds :hover and :active at once, so equal specificity makes the LATER rule the one that paints');
check(!/\.vb-btn:active\{transform:scale\(\.92\);background/.test(css),
  'the press state is not also declared up beside the resting key (where it lost to hover)');
// hover
const hoverRule = /\.vb-btn:hover\{([^}]*)\}/.exec(css);
check(!!hoverRule, 'the hover block still owns the key rule');
check(!!hoverRule && /outline-color:var\(--line\)/.test(hoverRule[1]) && /transform:translateY\(-1px\)/.test(hoverRule[1]),
  'hover is a lift + a hairline ring', hoverRule && hoverRule[1]);
check(!!hoverRule && !/^background:var\(--panel-4\)$/.test(hoverRule[1].trim()),
  'and it is no longer only a tone swap to the app\'s selected step');
check(/\.vb-btn\.off:hover,\.vb-btn\.danger:hover\{background:#c03a2c/.test(css),
  'an engaged key stays red under the pointer, brightening the way the me bar\'s own buttons do');
check(/\.me-icobtn\.off:hover\{background:#c03a2c\}/.test(css),
  'which is the same fix the me bar already had (the row was the one left out)');
check(!/\.vb-btn:hover\{background:var\(--panel-4\)\}/.test(css),
  'the old tone-swap-only hover is gone');

console.log('\n[3] the row has some life');
check(/@keyframes vb-key-in\{/.test(css), 'an entrance is defined');
check(/#voice-bar:not\(\.hidden\) \.vb-btn\{animation:vb-key-in/.test(css),
  'it runs the moment the call bar is revealed');
const delays = ['\.02s', '\.05s', '\.08s', '\.11s', '\.14s'].map((d) => new RegExp('#voice-bar:not\\(\\.hidden\\) \\.vb-btn:nth-child\\(\\d\\)\\{animation-delay:' + d + '\\}'));
check(delays.every((re) => re.test(css)), 'and each of the five keys is staggered');
check(/@keyframes vb-key-pop\{/.test(css) && /\.vb-btn\.pop\{animation:vb-key-pop/.test(css),
  'a toggle pops the key');
check(css.indexOf('.vb-btn.pop{animation:vb-key-pop') > css.indexOf('#voice-bar:not(.hidden) .vb-btn{animation:vb-key-in'),
  'the pop rule is declared AFTER the entrance (same specificity — only the order lets a click during the entrance still pop)');
check(/@keyframes vb-air\{/.test(css) && /\.vb-btn\.on-air::before\{[^}]*animation:vb-air/.test(css),
  'and the streaming key breathes a ring while you are on air');
check(/\.vb-btn\.on-air::before\{[^}]*pointer-events:none/.test(css),
  'the ring is a ::before that cannot eat a tap (the button\'s own animation is taken by the entrance/pop)');
check(/@media \(prefers-reduced-motion:reduce\)\{\s*#voice-bar:not\(\.hidden\) \.vb-btn,/.test(css)
  && /\.vb-btn\.on-air::before\{animation:none\}/.test(css),
  'reduced motion cancels all three animations');
check(/@media \(prefers-reduced-motion:reduce\)\{\s*\.vb-btn:hover,\.vb-btn:hover svg,\.vb-btn:active\{transform:none\}\s*\}/.test(css)
  && css.indexOf('.vb-btn:hover,.vb-btn:hover svg,.vb-btn:active{transform:none}') > css.indexOf('.vb-btn:active{background:var(--panel-2)'),
  'including the hover lift and the press shrink — declared after both, since order is what the transforms turn on');

console.log('\n[4] voice.js plays the acknowledgement on every copy of a key');
const mirrors = /const VOICE_KEY_MIRRORS = \{([\s\S]*?)\};/.exec(voice);
check(!!mirrors, 'the mirror map exists');
const mirrorSrc = mirrors ? mirrors[1] : '';
for (const sel of ['#me-mute', '#btn-mute', '#vf-mute', '#cv-mute']) check(mirrorSrc.includes(sel), 'mic mirrors include ' + sel);
for (const sel of ['#me-deafen', '#btn-deafen', '#vf-deafen', '#cv-deafen']) check(mirrorSrc.includes(sel), 'deafen mirrors include ' + sel);
for (const sel of ['#btn-camera', '#vf-camera', '#cv-camera']) check(mirrorSrc.includes(sel), 'camera mirrors include ' + sel);
for (const sel of ['#btn-share', '#vf-share', '#cv-share']) check(mirrorSrc.includes(sel), 'share mirrors include ' + sel);
check(!voice.includes('popMeBtn'), 'the old single-button pop helper is gone');
const popCalls = (voice.match(/popVoiceKey\('(mute|deafen|camera|share)'\)/g) || []).length;
check(popCalls === 14, 'every handler for those keys pops its mirrors (4 mic + 4 deafen + 3 camera + 3 share)', { popCalls });
check(/b\.addEventListener\('animationend', function done\(ev\)[\s\S]*?b\.classList\.remove\('pop'\)/.test(voice),
  'and the .pop class is dropped when the pop ends, so it can never outrank the next call\'s entrance');
check(/if \(!b\.offsetParent\) continue;/.test(voice),
  'a key on a surface that is not on screen (the fab on desktop, the closed call view) is skipped rather than left holding a stale .pop');
check(/b\.classList\.toggle\('on-air', !!v\?\.sharing\)/.test(voice),
  'paintVoiceControls drives the on-air ring off the real sharing state');

// ---------- headless Chrome ----------
// A cascade reader for the page: which declaration WINS on this element in this
// forced state? Specificity + document order, with :hover/:active treated as
// matching (that is the whole point — a headless run cannot hover for real).
const cascadeJs = `
function specificity(sel) {
  var ids = 0, cls = 0, els = 0;
  var s = sel.replace(/:not\\(([^()]*)\\)/g, function (m, inner) {
    var sp = specificity(inner);
    ids += sp.ids; cls += sp.cls; els += sp.els;
    return ' ';
  });
  s = s.replace(/::[\\w-]+/g, '');
  ids += (s.match(/#[\\w-]+/g) || []).length;
  cls += (s.match(/\\.[\\w-]+/g) || []).length;
  cls += (s.match(/:(?!:)[\\w-]+(\\([^()]*\\))?/g) || []).length;
  var rest = s.replace(/[#.][\\w-]+/g, ' ').replace(/:(?!:)[\\w-]+(\\([^()]*\\))?/g, ' ');
  els += (rest.match(/(^|[\\s>+~])[a-zA-Z][\\w-]*/g) || []).length;
  return { ids: ids, cls: cls, els: els };
}
function splitTop(sel) {
  var out = [], depth = 0, cur = '';
  for (var i = 0; i < sel.length; i++) {
    var c = sel[i];
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}
function kebab(p) { return p.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }); }
var SHORT = { 'background-color': 'background', 'outline-color': 'outline', 'animation-name': 'animation' };
// A shorthand carrying a var() is stored whole and its longhands come back
// empty, so fall back to the shorthand (and take the name token for animation).
function declText(r, prop) {
  var k = kebab(prop);
  var v = r.style.getPropertyValue(k);
  if (v) return v;
  var short = SHORT[k];
  if (!short) return '';
  var s = r.style.getPropertyValue(short);
  if (!s) return '';
  if (k === 'animation-name') return s.split(/\\s+/)[0];
  return s;
}
// The winning declaration for el in a forced state (or null when nothing sets it).
function winner(el, prop, state) {
  var hits = [], order = 0;
  var walk = function (rules) {
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.type === 4) { if (matchMedia(r.conditionText).matches) walk(r.cssRules); continue; }
      if (r.type !== 1) continue;
      var sel = r.selectorText;
      if (/:hover/.test(sel) && !state.hover) continue;
      if (/:active/.test(sel) && !state.active) continue;
      if (/:focus/.test(sel)) continue; // keyboard focus is not the state under test
      var parts = splitTop(sel.replace(/:hover|:active/g, ''));
      for (var j = 0; j < parts.length; j++) {
        var one = parts[j].trim();
        if (!one) continue;
        var ok = false;
        try { ok = el.matches(one); } catch (e) { ok = false; }
        order++;
        if (!ok) continue;
        var value = declText(r, prop);
        if (value) hits.push({ order: order, spec: specificity(one), value: value });
      }
    }
  };
  walk(document.styleSheets[0].cssRules);
  if (!hits.length) return null;
  hits.sort(function (a, b) {
    return (a.spec.ids - b.spec.ids) || (a.spec.cls - b.spec.cls) || (a.spec.els - b.spec.els) || (a.order - b.order);
  });
  return hits[hits.length - 1];
}
// Apply the winner's own declaration to a throwaway element and read it back, so
// var() and shorthands resolve exactly as they do on the real key.
function resolved(el, prop, state) {
  var w = winner(el, prop, state);
  if (!w) return null;
  var probe = document.createElement('span');
  probe.style.cssText = 'all:unset';
  document.body.appendChild(probe);
  probe.style.display = 'block';
  probe.style.width = '10px';
  probe.style.height = '10px';
  probe.style.setProperty(kebab(prop), w.value);
  var out = getComputedStyle(probe)[prop];
  probe.remove();
  return { value: out, raw: w.value };
}
window.__cascade = { winner: winner, resolved: resolved, specificity: specificity };
`;

// The REAL voice bar out of index.html, with the REAL stylesheet inlined (an
// inlined sheet is also a same-origin one, so its cssRules are readable). The
// sheet is full of backticks in its comments, so it is escaped into the
// template rather than pasted raw.
const cssInline = css.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${cssInline}</style>
<style>#view-main{height:100vh}#probe-row{padding:.5rem}</style></head><body>
<section id="view-main"><div id="left">
  <nav id="rail"></nav>
  <aside id="sidebar">
    <div class="spacer"></div>
    ${bar}
    <div id="me-card"><button type="button" id="me-open"><span id="me-avatar" class="avatar">?</span><span id="me-name">me</span></button>
      <button id="me-mute" class="me-icobtn" title="Mute mic"></button><button id="me-deafen" class="me-icobtn" title="Deafen"></button></div>
  </aside>
</div><main id="chat"></main></section>
<script>
window.__errs = [];
window.addEventListener('error', function (e) { window.__errs.push(String((e && e.message) || e)); });
var $ = function (s) { return document.querySelector(s); };
${cascadeJs}
// The bar is shown exactly the way voice.js shows it (joinVoice removes .hidden).
document.getElementById('voice-bar').classList.remove('hidden');
document.getElementById('voice-chan-name').textContent = 'general';
document.getElementById('voice-bar').classList.add('vc-connected');
var SVGS = { mute: '<svg width="16" height="16" viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="12" rx="3"/></svg>',
  deaf: '<svg width="16" height="16" viewBox="0 0 24 24"><path d="M4 14v-2"/></svg>',
  cam: '<svg width="16" height="16" viewBox="0 0 24 24"><rect x="2" y="6" width="13" height="12" rx="2.5"/></svg>',
  share: '<svg width="16" height="16" viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="13" rx="2"/></svg>' };
[['#btn-mute', SVGS.mute], ['#btn-deafen', SVGS.deaf], ['#btn-camera', SVGS.cam], ['#btn-share', SVGS.share]].forEach(function (pair) {
  var b = $(pair[0]); if (b) b.innerHTML = pair[1];
});
var LEAVE = document.getElementById('btn-voice-leave');
if (LEAVE && !LEAVE.innerHTML.trim()) LEAVE.innerHTML = '\\u2715';

var box = function (el) {
  if (!el) return null;
  var b = el.getBoundingClientRect();
  return { l: +b.left.toFixed(2), t: +b.top.toFixed(2), r: +b.right.toFixed(2), b: +b.bottom.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2) };
};
function keyStyle(el) {
  var cs = getComputedStyle(el);
  return { bg: cs.backgroundColor, outline: cs.outlineColor, transform: cs.transform, animation: cs.animationName, delay: cs.animationDelay, box: box(el) };
}
// Settle the entrance first: a measurement racing an animation would read the
// key mid-drop.
// Every read below is synchronous on purpose: a headless dump cannot wait for a
// CSS animation's finished promise under virtual time (it never settles, and
// the whole report would be lost), so the entrance is measured as a DECLARATION
// and the geometry is taken after animations are switched off outright.
setTimeout(function () {
  var mute = $('#btn-mute'), cam = $('#btn-camera'), share = $('#btn-share'), leave = $('#btn-voice-leave');
  var C = window.__cascade;
  var report = {
    mediaHover: matchMedia('(hover:hover)').matches,
    mediaReduced: matchMedia('(prefers-reduced-motion:reduce)').matches,
    errs: window.__errs.slice(),
    keys: {}, row: null, bar: null, sidebar: null,
  };
  ['#btn-mute', '#btn-deafen', '#btn-camera', '#btn-share', '#btn-voice-leave'].forEach(function (sel) {
    report.keys[sel] = keyStyle($(sel));
  });
  // Kill transitions first: getComputedStyle reports the value a property is
  // TRANSITIONING THROUGH, so an engaged key read the instant its class flips
  // would still report the resting colour and the cross-check would be reading
  // the transition, not the cascade.
  var noTrans = document.createElement('style');
  noTrans.textContent = '*{transition:none!important}';
  document.head.appendChild(noTrans);
  // real states the browser can compute on its own — the resolver's yardstick
  mute.classList.remove('off');
  var restBg = getComputedStyle(mute).backgroundColor;
  mute.classList.add('off');
  var offBg = getComputedStyle(mute).backgroundColor;
  mute.classList.remove('off');
  report.ground = { restBg: restBg, offBg: offBg, restAnim: getComputedStyle(mute).animationName, hoverOK: report.mediaHover };
  var S = function (h, a) { return { hover: !!h, active: !!a }; };
  // A real click is BOTH states at once (a mouse holds :hover while the button
  // is down, and a touch screen leaves the hover behind after the tap), so the
  // press is measured in that combined state — that is the state the bug hid in.
  var PRESS = S(1, 1);
  report.cascade = {
    rest: { bg: C.resolved(mute, 'backgroundColor', S()), outline: C.resolved(mute, 'outlineColor', S()), transform: C.resolved(mute, 'transform', S()) },
    hover: { bg: C.resolved(mute, 'backgroundColor', S(1)), outline: C.resolved(mute, 'outlineColor', S(1)), transform: C.resolved(mute, 'transform', S(1)) },
    active: { bg: C.resolved(mute, 'backgroundColor', S(0, 1)), outline: C.resolved(mute, 'outlineColor', S(0, 1)), transform: C.resolved(mute, 'transform', S(0, 1)) },
    press: { bg: C.resolved(mute, 'backgroundColor', PRESS), outline: C.resolved(mute, 'outlineColor', PRESS), transform: C.resolved(mute, 'transform', PRESS) },
    restAnim: C.resolved(mute, 'animationName', S()),
    hoverAnim: C.resolved(mute, 'animationName', S(1)),
  };
  // engaged (mic off) in all three states, and the leave key (danger)
  mute.classList.add('off');
  leave.classList.add('danger');
  report.cascade.off = {
    rest: { bg: C.resolved(mute, 'backgroundColor', S()), outline: C.resolved(mute, 'outlineColor', S()) },
    hover: { bg: C.resolved(mute, 'backgroundColor', S(1)), outline: C.resolved(mute, 'outlineColor', S(1)) },
    active: { bg: C.resolved(mute, 'backgroundColor', S(0, 1)) },
    press: { bg: C.resolved(mute, 'backgroundColor', PRESS), outline: C.resolved(mute, 'outlineColor', PRESS) },
    dangerHover: { bg: C.resolved(leave, 'backgroundColor', S(1)) },
    dangerRest: { bg: C.resolved(leave, 'backgroundColor', S()) },
    dangerPress: { bg: C.resolved(leave, 'backgroundColor', PRESS) },
  };
  var offReal = getComputedStyle(mute).backgroundColor;
  mute.classList.remove('off');
  leave.classList.remove('danger');
  report.ground.offBgReal = offReal;
  // the pop outranks the entrance on a key that is already in the call
  mute.classList.add('pop');
  report.popAnim = getComputedStyle(mute).animationName;
  report.popWins = C.resolved(mute, 'animationName', S());
  mute.classList.remove('pop');
  // on air
  report.airBefore = getComputedStyle(share, '::before').animationName;
  report.airBeforeBorder = getComputedStyle(share, '::before').borderTopColor;
  share.classList.add('on-air');
  report.airOn = getComputedStyle(share, '::before').animationName;
  report.airOnBorder = getComputedStyle(share, '::before').borderTopColor;
  share.classList.remove('on-air');
  // the camera key's spinner must still be reachable (it is the button's ::after)
  cam.classList.add('busy');
  report.busyAfter = getComputedStyle(cam, '::after').animationName;
  cam.classList.remove('busy');
  // Animations off for the measurements: a box read mid-entrance would report
  // the key halfway through its drop, not where it rests.
  var kill = document.createElement('style');
  kill.textContent = '.vb-btn,.vb-btn::before{animation:none!important}';
  document.head.appendChild(kill);
  report.boxes = {};
  ['#btn-mute', '#btn-deafen', '#btn-camera', '#btn-share', '#btn-voice-leave'].forEach(function (sel) {
    report.boxes[sel] = box($(sel));
  });
  report.row = box($('.vb-btns'));
  report.bar = box($('#voice-bar'));
  report.sidebar = box($('#sidebar'));
  document.title = JSON.stringify(report);
}, 60);
</script>
</body></html>`;
}

function probe(chrome, html, { width, height, dpr }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-quickkeys-'));
  try {
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, html);
    const args = [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + path.join(dir, 'prof'), '--force-device-scale-factor=' + dpr,
      '--window-size=' + width + ',' + height, '--virtual-time-budget=6000',
      '--dump-dom', 'file:///' + file.replace(/\\/g, '/'),
    ];
    const r = spawnSync(chrome, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
    const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
    if (!m) {
      if (process.env.CF_DEBUG) {
        const keep = path.join(os.tmpdir(), 'cf-quickkeys-debug.html');
        fs.copyFileSync(file, keep);
        console.log('[debug] page kept at ' + keep);
        console.log('[debug] status ' + r.status + ' stderr: ' + String(r.stderr).slice(0, 800));
        console.log('[debug] stdout tail: ' + String(r.stdout).slice(-600));
      }
      throw new Error('no title in dump (chrome status ' + r.status + ')');
    }
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

const PANEL_3 = 'rgb(29, 37, 54)', PANEL_4 = 'rgb(39, 48, 72)', PANEL_2 = 'rgb(20, 26, 40)';
const RED = 'rgb(168, 50, 38)', RED_HOVER = 'rgb(192, 58, 44)', RED_DOWN = 'rgb(141, 39, 30)';

function chromeHalf() {
  const chrome = findChrome();
  if (!chrome) return skip('no Chrome/Edge found (set CHROME_PATH)');
  if (!bar) return skip('could not extract the voice bar from index.html');

  const r = probe(chrome, pageHtml(), { width: 1100, height: 760, dpr: 2 });
  if (r.errs && r.errs.length) throw new Error('page errors: ' + r.errs.join(' | '));
  if (!r.mediaHover) return skip('this browser reports no hover capability, so the hover rules cannot be judged');

  console.log('\n[5] the resolver agrees with the browser where the browser can answer');
  const g = r.ground;
  check(r.cascade.rest.bg.value === g.restBg,
    'rest background: resolver vs getComputedStyle', { resolver: r.cascade.rest.bg.value, chrome: g.restBg });
  check(r.cascade.off.rest.bg.value === g.offBgReal,
    'engaged (red) background: resolver vs getComputedStyle', { resolver: r.cascade.off.rest.bg.value, chrome: g.offBgReal });
  check(r.cascade.restAnim.value === g.restAnim,
    'rest animation: resolver vs getComputedStyle', { resolver: r.cascade.restAnim.value, chrome: g.restAnim });
  check(g.restBg === PANEL_3 && g.offBgReal === RED, 'the browser really is on the dark theme\'s own steps', g);

  console.log('\n[6] hover, press and rest are three different values');
  const c = r.cascade;
  check(c.rest.bg.value === PANEL_3, 'a neutral key rests on --panel-3', c.rest.bg);
  check(c.hover.bg.value === PANEL_4, 'hover lifts it one tonal step', c.hover.bg);
  check(c.press.bg.value === PANEL_2, 'a press sinks it below rest — and it WINS while the pointer is also hovering', c.press.bg);
  check(c.active.bg.value === PANEL_2, 'the same value as a bare :active', c.active.bg);
  check(c.hover.bg.value !== c.press.bg.value && c.hover.bg.value !== c.rest.bg.value,
    'so hovering can never be mistaken for clicking (or for resting)', { rest: c.rest.bg.value, hover: c.hover.bg.value, press: c.press.bg.value });
  check(String(c.hover.transform && c.hover.transform.value).includes('matrix') && c.hover.transform.raw.includes('translateY'),
    'hover is a LIFT, not just a tone', c.hover.transform);
  check(c.press.transform.raw.includes('scale'),
    'while a press is the opposite gesture: it shrinks, and the hover lift is gone', c.press.transform);
  check(c.hover.outline.value !== 'rgba(0, 0, 0, 0)' && c.hover.outline.value !== 'transparent',
    'hover rings the key', c.hover.outline);
  check(c.press.outline.value === 'rgba(0, 0, 0, 0)', 'and a press drops the ring', c.press.outline);
  check(c.rest.outline.value === 'rgba(0, 0, 0, 0)',
    'the ring is invisible at rest (the outline is reserved, so nothing moves on hover)', c.rest.outline);

  console.log('\n[7] an engaged key never loses its colour to the pointer');
  check(c.off.rest.bg.value === RED, 'an engaged key rests red', c.off.rest.bg);
  check(c.off.hover.bg.value === RED_HOVER,
    'and stays red — brighter — under the pointer, instead of turning grey', c.off.hover.bg);
  check(c.off.hover.bg.value !== c.hover.bg.value,
    'the engaged hover is nothing like a neutral key\'s hover', { engaged: c.off.hover.bg.value, neutral: c.hover.bg.value });
  check(c.off.press.bg.value === RED_DOWN, 'pressing it deepens the red (it does not go grey either)', c.off.press.bg);
  check(c.off.dangerRest.bg.value === RED && c.off.dangerHover.bg.value === RED_HOVER && c.off.dangerPress.bg.value === RED_DOWN,
    'the disconnect key behaves the same way (red / brighter / deeper)', c.off.dangerPress);

  console.log('\n[8] the life the row gained');
  const ids = ['#btn-mute', '#btn-deafen', '#btn-camera', '#btn-share', '#btn-voice-leave'];
  check(ids.every((sel) => r.keys[sel].animation === 'vb-key-in'),
    'every key plays the entrance animation when the bar appears', ids.map((s) => s + ':' + r.keys[s].animation));
  const delays = ids.map((sel) => r.keys[sel].delay);
  check(new Set(delays).size === 5, 'and each key is staggered off the others', delays);
  check(r.popWins && r.popWins.value === 'vb-key-pop' && r.popAnim === 'vb-key-pop',
    'a toggled key plays the pop (and it outranks the entrance on a key already in the call)', { resolved: r.popWins, computed: r.popAnim });
  check(r.airBefore === 'none' && r.airOn === 'vb-air',
    'the streaming key only breathes once it is actually on air', { off: r.airBefore, on: r.airOn });
  check(r.airOnBorder === 'rgba(248, 113, 113, 0.8)', 'and the ring wears the app\'s live red, not a second colour', r.airOnBorder);
  check(r.busyAfter === 'up-spin', 'the camera key\'s starting spinner still owns its ::after', r.busyAfter);

  console.log('\n[9] nothing about the layout moved');
  const bx = r.boxes;
  check(ids.every((sel) => Math.abs(bx[sel].w - 38) <= 0.5 && Math.abs(bx[sel].h - 38) <= 0.5),
    'every key is still the same 38x38 box', ids.map((s) => bx[s].w + 'x' + bx[s].h));
  const row = r.row, first = bx['#btn-mute'], last = bx['#btn-voice-leave'];
  check(Math.abs((last.r - first.l) - (38 * 5 + 6.4 * 4)) <= 1.5,
    'five keys and four .4rem gaps, still the same row width', { keys: +(last.r - first.l).toFixed(2), expected: 38 * 5 + 6.4 * 4 });
  check(Math.abs((first.l + last.r) / 2 - (row.l + row.r) / 2) <= 1,
    'and the row is still centred in the bar', { keys: (first.l + last.r) / 2, row: (row.l + row.r) / 2 });
  check(row.l >= r.bar.l && row.r <= r.bar.r, 'the keys stay inside the bar (the ring overhangs, the box does not)', { row, bar: r.bar });
  check(Math.abs(row.h - 38) <= 0.5, 'the transparent resting outline costs no height', { rowH: row.h });
}

chromeHalf();
console.log('\n' + (failures.length ? failures.length + ' FAILED, ' + passed + ' passed' : 'all ' + passed + ' checks passed'));
if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
