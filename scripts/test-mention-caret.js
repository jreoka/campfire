// The mention caret (see AGENTS.md verification conventions).
//
// The complaint: "@miicat47 you wanna see n" — mention a user, type a word, and
// the caret sits in the middle of a letter. Two independent causes, both pinned
// here, because either one alone produces the same picture:
//
//  1. the PILL WAS BOLDER THAN THE TEXTAREA. The composer is a transparent
//     textarea with a rendered backdrop on top; the caret belongs to the
//     textarea, so the two must lay out the same advance widths. `.mention` is
//     `font-weight:650` and the backdrop's own neutralising rules killed the
//     pill's padding but not its weight, so on any real UI face (Segoe UI, SF,
//     Roboto) the bolder glyphs were wider and every mention pushed the text
//     after it — caret included — right by a few px per pill.
//     THIS IS THE TRAP IN TESTING IT: the default face in a bare Linux CI
//     container has IDENTICAL 400 and 650 advances, so a naive probe measures
//     zero drift and the bug looks already-fixed. The test therefore measures
//     with an explicitly weight-differentiating face (Liberation Sans: 70.5px
//     at 400, 74.05px at 650 for '@miicat47') and fails on the old CSS.
//  2. THE INSERT LEFT THE CARET WHEREVER THE ASSIGNMENT PUT IT. Setting
//     `textarea.value` resets the selection to the end of the box, and the
//     popups are reachable from the middle of a line. Accepting a completion
//     jumped the caret to the end of the message, so the next character landed
//     somewhere else entirely.
//
// Drives the real index.html + styles.css in headless Chrome against the real
// renderRich / syncComposerRender / applyMention / applyChannel / applyEmoji /
// completeInsert sliced out of the sources, at a phone and a desktop viewport.
//
// Usage: node scripts/test-mention-caret.js
//   (CHROME_PATH to point at a specific browser; skips without one)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/ms-playwright/chromium-1148/chrome-linux/chrome',
    '/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/opt/meta-chromium/chrome',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

// Slice a top-level `function name(...) { ... }` out of a source file.
function sliceFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('function ' + name + ' not found');
  let depth = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(i, j + 1);
}

const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

// The composer form, verbatim, so the harness measures the real thing.
const composerMarkup = index.slice(index.indexOf('<form id="composer">'), index.indexOf('<!-- members -->'));

// The real units under test, verbatim.
const escStart = core.indexOf('function esc(');
const richStart = core.indexOf('function renderRich(');
const richEnd = core.indexOf('function isBigEmoji');
const richSrc = core.slice(escStart, richStart) + core.slice(richStart, richEnd);
const painterSrc = sliceFn(core, 'emojifyHTML');
const syncRenderSrc = sliceFn(fs.readFileSync(path.join(ROOT, 'public/js/final.js'), 'utf8'), 'syncComposerRender');
const completeInsertSrc = sliceFn(pickers, 'completeInsert');
const applyMentionSrc = sliceFn(pickers, 'applyMention');
const applyChannelSrc = sliceFn(pickers, 'applyChannel');
const applyEmojiSrc = sliceFn(pickers, 'applyEmoji');

// ---------- [1] source-level invariants ----------
// ---------- stylesheet model ----------
// Comments are stripped FIRST and rules are then indexed BY SELECTOR. Both
// steps are load-bearing: this stylesheet explains a rule in a comment sitting
// directly above it, so a plain `selector{body}` pattern captures the comment's
// text and braces as part of the "selector" — which is how the pill rule, the
// spoiler rule and the heading rule quietly go missing from an audit. And a
// literal `indexOf(selector)` is no better: `#in-render-inner .mention` also
// occurs as the thread half of the same rule and inside a comment, and the
// first hit is the wrong thing.
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
const allRules = [...cssNoComments.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1].indexOf('@') < 0);
const rulesBySelector = new Map();
for (const m of allRules) {
  for (const one of m[1].trim().split(',')) {
    const sel = one.trim();
    if (!sel || rulesBySelector.has(sel)) continue;
    rulesBySelector.set(sel, m[2]);
  }
}
function rule(selector) {
  return rulesBySelector.has(selector) ? rulesBySelector.get(selector) : null;
}

// A rule is metric-neutral when it changes no advance width. This is
// font-INDEPENDENT, so the check still holds on a CI box whose default face
// cannot tell 400 from 650 — the check that is impossible to pass by accident.
const METRIC_DECLS = [
  'font-weight', 'font-size', 'font-family', 'letter-spacing', 'word-spacing',
  'font-stretch', 'font-variant', 'font-feature-settings', 'text-indent',
  'text-transform', 'font-kerning', 'font-variation-settings',
  'padding', 'padding-left', 'padding-right', 'margin-left', 'margin-right',
];
// A declaration whose value is neutral does not count: `padding:0` is exactly
// how a backdrop rule KILLS an inherited padding, and reading that as a metric
// change would fail the very rule that fixes the bug.
const NEUTRAL_VALUE = /(^|\s)(inherit|initial|unset|revert|none|0|0px|0em|0rem)(\s|;|$)/;
function metricDecls(body) {
  if (!body) return [];
  return body.split(';')
    .map((d) => d.split(':'))
    .filter((parts) => parts.length > 1 && METRIC_DECLS.includes(parts[0].trim().toLowerCase()))
    .filter((parts) => !NEUTRAL_VALUE.test(parts.slice(1).join(':')))
    .map((parts) => parts[0].trim() + ': ' + parts.slice(1).join(':').trim());
}

console.log('\n[1] the backdrop pill cannot widen the text it sits over');
const pillRule = rule('#in-render-inner .mention') || '';
const pillThreadRule = rule('#thread-render-inner .mention') || '';
check(pillRule !== '', 'composer backdrop has a .mention rule');
check(/padding-left\s*:\s*0/.test(pillRule) && /padding-right\s*:\s*0/.test(pillRule),
  'backdrop pill drops the horizontal padding', pillRule);
check(/font-weight\s*:\s*inherit/.test(pillRule),
  'backdrop pill inherits the textarea weight instead of 650', pillRule);
check(!/font-weight\s*:\s*(bold|[5-9]00)/.test(pillRule), 'backdrop pill is never bolder than the text', pillRule);
check(pillThreadRule !== '' && /font-weight\s*:\s*inherit/.test(pillThreadRule),
  'the thread bar backdrop pill is neutralised too (same rule pair)', pillThreadRule);
// The weight has to still LOOK weighted, the way `strong` does, without
// changing an advance width.
check(/text-shadow/.test(pillRule), 'backdrop pill fakes the weight with a text-shadow', pillRule);
check(/#in-render strong[^}]*font-weight:inherit/.test(cssNoComments),
  'the same rule already holds for strong (bold markers)');

// The general form of the fix, so the guarantee is the invariant and not one
// hand-written line: no rule that styles a CHILD of a backdrop may change an
// advance width. The audit is scoped to those on purpose — the backdrop's OWN
// box (its font-size, the side padding that clears the field's buttons, and the
// phone's restatement of both) sets the two surfaces' SHARED metrics, which is
// where "identical between the two" is enforced, and the browser leg measures
// the result. Everything painting INSIDE one (a pill, a delimiter, bold, a
// spoiler) is the drift case, and every one of those is audited.
const backdropBox = new Set(['#in-render', '#thread-render', '#in-render-inner', '#thread-render-inner']);
const inBackdrop = [...rulesBySelector.keys()].filter((sel) =>
  !backdropBox.has(sel) && (sel.startsWith('#in-render') || sel.startsWith('#thread-render')));
check(inBackdrop.length >= 10, 'found the in-backdrop rules to audit', inBackdrop.length);
for (const sel of inBackdrop) {
  const bad = metricDecls(rule(sel));
  check(bad.length === 0, 'in-backdrop rule changes no glyph metrics: ' + sel, bad);
}

console.log('\n[2] a completion leaves the caret after the text it inserted');
check(/setSelectionRange\(m\.index \+ text\.length/.test(completeInsertSrc),
  'completeInsert puts the caret after what it inserted', completeInsertSrc);
check(/inp\.value = head\.replace\(re, \(\) => text\) \+ tail/.test(completeInsertSrc),
  'completeInsert keeps the text after the caret (the old code rebuilt the value from the head alone, so completing mid-line deleted the rest of the sentence)', completeInsertSrc);
check(/\^\\s\/.test\(tail\)/.test(completeInsertSrc),
  'a completion does not double the space when one already follows', completeInsertSrc);
check(/try \{ inp\.setSelectionRange/.test(completeInsertSrc), 'setSelectionRange is guarded (it throws on an unsupported input)');
check(/if \(!m\) \{ try \{ inp\.setSelectionRange\(pos, pos\)/.test(completeInsertSrc),
  'a completion that matches nothing leaves the caret where it was', completeInsertSrc);

// The insert itself, run here rather than in a browser: it is pure string work,
// and a mid-line completion is exactly the case the bug report is about.
const completeInsert = eval('(' + completeInsertSrc + ')');
const fakeField = (value, at) => ({ value, selectionStart: at, setSelectionRange(a) { this.selectionStart = a; this.selectionEnd = a; } });
const MENTION = /@[^@\n]{0,32}$/;
{
  const f = fakeField('ask @mic about the thing', 8);
  completeInsert(f, f.value.slice(0, 8), MENTION, '@miicat47 ');
  check(f.value === 'ask @miicat47 about the thing',
    'completing mid-line rewrites only the query and keeps the rest of the sentence', f.value);
  check(f.selectionStart === 13, 'and leaves the caret right after the name', f);
  check(f.value.slice(f.selectionStart) === ' about the thing', 'the rest of the sentence is still after the caret', f);
}
{
  const f = fakeField('you wanna see @mic', 19);
  completeInsert(f, f.value.slice(0, 19), MENTION, '@miicat47 ');
  check(f.value === 'you wanna see @miicat47 ', 'completing at the end adds the trailing space', f.value);
  check(f.selectionStart === f.value.length, 'and the caret follows it', f);
}
{
  const f = fakeField('hello there', 5);
  completeInsert(f, f.value.slice(0, 5), MENTION, '@miicat47 ');
  check(f.value === 'hello there' && f.selectionStart === 5,
    'a completion with nothing to complete changes nothing', f);
}
{
  // A role named with `$&` in it must stay literal, not become the match. The
  // replacement is a FUNCTION, so `$&` / `$1` in a role name are not expanded.
  // The word after the caret begins with a space, so no trailing space is added
  // — that covers the no-double-gap rule in the same case.
  const f = fakeField('ping @Mods now', 10);
  const insert = '@' + '$&' + '$1' + ' Team';
  completeInsert(f, f.value.slice(0, 10), MENTION, insert);
  check(f.value === 'ping ' + insert + ' now',
    'a name containing ' + '$&' + ' / ' + '$1' + ' stays literal, and the word after it is untouched',
    { got: f.value, want: 'ping ' + insert + ' now' });
  check(f.selectionStart === f.value.indexOf(' now'),
    'the caret stops before the space that was already there', f);
}
// A name is at most 32 characters AFTER its leading '@', but `head` ends AT the
// caret — so a {0,32} pattern swallows the 33rd character (the space that
// followed the query) and welds it to the name. This pins the off-by-one.
{
  const f = fakeField('hi @Mods ', 9);
  completeInsert(f, f.value.slice(0, 9), /@[^@\n]{0,31}$/, '@miicat47 ');
  check(f.value === 'hi @miicat47 ', 'a 32-character name does not swallow the space after it', { got: f.value });
  const g = fakeField('hi @Mods', 8);
  completeInsert(g, g.value.slice(0, 8), /@[^@\n]{0,31}$/, '@miicat47 ');
  check(g.value === 'hi @miicat47 ' && g.selectionStart === 13,
    'and the caret still lands after the name and its space', g);
}
for (const [name, src] of [['applyMention', applyMentionSrc], ['applyChannel', applyChannelSrc], ['applyEmoji', applyEmojiSrc]]) {
  check(/completeInsert\(inp, inp\.value\.slice\(0, pos\)/.test(src), name + ' routes through completeInsert', src);
  check(!/inp\.value = inp\.value\.slice\(0, pos\)\.replace\(/.test(src),
    name + ' no longer assigns .value without a caret', src);
}

// ---------- [3] the real page ----------
function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>
  /* THE POINT OF THE TEST: a face whose regular and semibold advances really
     differ. A bare Linux container's default face does not (measured: 68.95px
     for '@miicat47' at both 400 and 650), which is what let the bug ship. */
  html,body,#in-render,#in-message{font-family:"Liberation Sans",Arial,sans-serif}
  #chat{display:flex;flex-direction:column;height:100vh}
</style></head><body>
<main id="chat">${composerMarkup}</main>
<script>
window.$ = (s) => document.querySelector(s);
window.S = { emojiAll: {}, stdEmoji: {}, me: { id: 'u9' }, view: 'server',
  serverDetail: { id: 's1', members: [
    { id: 'u1', username: 'miicat47', display_name: 'Miicat47' },
    { id: 'u2', username: 'near', display_name: 'near' },
  ], roles: [{ id: 'r1', name: 'Mods' }], channels: [{ id: 'c1', name: 'general', type: 'text' }] } };
window.memberByUsername = (u) => (S.serverDetail.members.find((m) => m.username === u) || null);
${painterSrc}
${richSrc}
${syncRenderSrc}
${completeInsertSrc}
${applyMentionSrc}
${applyChannelSrc}
${applyEmojiSrc}
const inp = document.querySelector('#in-message');
const inner = document.querySelector('#in-render-inner');
// The textarea's caret x for a character index, via a mirror div that copies
// every metric it has (a textarea exposes no caret geometry).
function taCaretX(idx) {
  const cs = getComputedStyle(inp);
  const d = document.createElement('div');
  for (const p of ['fontFamily','fontSize','fontWeight','fontStyle','letterSpacing','lineHeight',
    'paddingTop','paddingRight','paddingBottom','paddingLeft','borderTopWidth','borderRightWidth',
    'borderBottomWidth','borderLeftWidth','boxSizing','wordSpacing','textTransform','textIndent'])
    d.style[p] = cs[p];
  d.style.position = 'absolute'; d.style.visibility = 'hidden'; d.style.whiteSpace = 'pre-wrap';
  d.style.overflowWrap = 'anywhere'; d.style.width = inp.clientWidth + 'px'; d.style.top = '0'; d.style.left = '0';
  document.body.appendChild(d);
  const tn = document.createTextNode(inp.value.slice(0, idx) + '\\u200b');
  d.appendChild(tn);
  const r1 = document.createRange(); r1.setStart(tn, 0); r1.setEnd(tn, 1);
  const r2 = document.createRange(); r2.setStart(tn, tn.length - 1); r2.setEnd(tn, tn.length);
  const a = r1.getBoundingClientRect().left, b = [...r2.getClientRects()].pop().right;
  d.remove();
  return b - a;
}
// The backdrop's painted x for the same character index, via a Range over the
// rendered DOM — the caret is the textarea's, but what the eye tracks is this.
function bdCaretX(idx) {
  const walk = document.createTreeWalker(inner, NodeFilter.SHOW_TEXT);
  let seen = 0, first = null, node = null, off = 0;
  while (walk.nextNode()) {
    const t = walk.currentNode, len = t.length;
    if (!first && len) first = t;
    if (seen + len >= idx) { node = t; off = idx - seen; break; }
    seen += len;
  }
  if (!node) return null;
  const r1 = document.createRange(); r1.setStart(first, 0); r1.setEnd(first, 1);
  const r2 = document.createRange(); r2.setStart(node, off); r2.setEnd(node, off);
  return r2.getBoundingClientRect().left - r1.getBoundingClientRect().left;
}
const setVal = (v) => { inp.value = v; try { syncComposerRender(); } catch {} };
const paint = (v) => { setVal(v); return { ta: taCaretX(v.length), bd: bdCaretX(v.length) }; };
window.__result = (function () {
  const out = { rows: [], carets: [] };
  out.pads = { backdrop: getComputedStyle(document.querySelector('#in-render')).padding,
               ta: getComputedStyle(inp).padding };
  // Is the test face actually weight-differentiating? If it is not, every
  // drift number below is meaningless and the test must say so rather than
  // pass quietly on a font that hides the bug.
  const w = (weight) => { const d = document.createElement('div');
    d.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-family:inherit;font-size:.93rem';
    d.style.fontWeight = weight; d.textContent = '@miicat47';
    document.body.appendChild(d); const r = d.getBoundingClientRect().width; d.remove(); return +r.toFixed(2); };
  out.face = { w400: w('400'), w650: w('650'), delta: +(w('650') - w('400')).toFixed(2) };
  const cases = [
    ['baseline: plain sentence', 'you wanna see n'],
    ['mention only', '@miicat47'],
    ['mention then a word', '@miicat47 you wanna see n'],
    ['mention mid-line', 'ask @near about this now'],
    ['role mention then a word', '@Mods you wanna see n'],
    ['two mentions', '@near and @miicat47 ok'],
    ['bold then mention', '**hi** @near ok'],
    ['mention after a word', 'hey @miicat47 look'],
    ['mention at the start of a longer line', '@miicat47 the thing you asked about yesterday'],
  ];
  for (const [n, v] of cases) {
    const r = paint(v);
    out.rows.push({ name: n, ta: +r.ta.toFixed(2), bd: r.bd === null ? null : +r.bd.toFixed(2),
                    drift: r.bd === null ? null : +(r.ta - r.bd).toFixed(2) });
  }
  // The pill's own painted width vs the same characters in the textarea.
  setVal('@miicat47 x');
  const span = inner.querySelector('.mention');
  out.pill = span ? { w: +span.getBoundingClientRect().width.toFixed(2),
                      fw: getComputedStyle(span).fontWeight, taW: +taCaretX(9).toFixed(2) } : null;
  // The caret after a real completion, from the MIDDLE of a line and at the end.
  const doMention = (value, at) => {
    setVal(value);
    inp.focus();
    inp.setSelectionRange(at, at);
    applyMention({ kind: 'user', user: S.serverDetail.members[0] }, inp);
    return { value: inp.value, sel: inp.selectionStart };
  };
  out.carets.push(Object.assign({ name: 'mention at the end' }, doMention('you wanna see @mic', 19)));
  out.carets.push(Object.assign({ name: 'mention in the middle' }, doMention('@mic you wanna see this', 4)));
  out.carets.push(Object.assign({ name: 'mention mid-line, text after the caret' },
    doMention('ask @mic about the thing', 8)));
  out.carets.push(Object.assign({ name: 'role mention' }, (function () {
    setVal('hey @Mod'); inp.focus(); inp.setSelectionRange(7, 7);
    applyMention({ kind: 'role', role: S.serverDetail.roles[0] }, inp);
    return { value: inp.value, sel: inp.selectionStart };
  })()));
  out.carets.push(Object.assign({ name: 'channel' }, (function () {
    setVal('see #gen'); inp.focus(); inp.setSelectionRange(8, 8);
    applyChannel('general', inp);
    return { value: inp.value, sel: inp.selectionStart };
  })()));
  out.carets.push(Object.assign({ name: 'emoji' }, (function () {
    setVal('nice :fire'); inp.focus(); inp.setSelectionRange(10, 10);
    applyEmoji('fire', inp);
    return { value: inp.value, sel: inp.selectionStart };
  })()));
  return out;
})();
</script></body></html>`;
}

// Minimal CDP driver: navigate, read window.__result.
async function probe(chrome, pageFile, { width, height, dpr }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-mention-'));
  const port = 18800 + (process.pid % 400);
  const proc = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--no-sandbox',
    '--user-data-dir=' + path.join(dir, 'prof'), '--force-device-scale-factor=' + dpr,
    '--window-size=' + width + ',' + height, '--remote-debugging-port=' + port, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const kill = () => { try { proc.kill('SIGKILL'); } catch {} };
  try {
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('devtools listen timeout')), 20000);
      proc.stderr.on('data', (d) => {
        if (/DevTools listening on/.test(String(d))) { clearTimeout(t); res(); }
      });
      proc.on('exit', () => { clearTimeout(t); rej(new Error('chrome exited early')); });
    });
    let target = null;
    for (let i = 0; i < 50 && !target; i++) {
      try {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch {}
      if (!target) await sleep(200);
    }
    if (!target) throw new Error('no page target');
    const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('cdp timeout: ' + method)); } }, 20000);
    });
    await send('Page.enable');
    await send('Page.navigate', { url: 'file://' + pageFile });
    await sleep(800);
    const ev = await send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__result || { ERR: String(window.__err) })',
      returnByValue: true,
    });
    ws.close();
    const val = ev.result && ev.result.result && ev.result.result.value;
    if (!val) throw new Error('no __result: ' + JSON.stringify(ev).slice(0, 300));
    return JSON.parse(val);
  } finally {
    kill();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  const chrome = findChrome();
  if (!chrome) skip('no Chrome/Chromium found');
  console.log('  (browser: ' + chrome + ')');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-mention-page-'));
  const pageFile = path.join(dir, 'page.html');
  fs.writeFileSync(pageFile, pageHtml());
  try {
    for (const vp of [
      { name: 'desktop', width: 1440, height: 900, dpr: 1 },
      { name: 'phone', width: 390, height: 844, dpr: 2 },
    ]) {
      console.log(`\n[3] ${vp.name} viewport (${vp.width}x${vp.height}) — the caret on the rendered text`);
      const r = await probe(chrome, pageFile, vp);
      check(!r.ERR, 'the harness ran', r.ERR);
      console.log('   test face: ' + JSON.stringify(r.face));
      check(Math.abs(r.face.delta) > 0.5,
        'the test face really does differentiate 400 from 650 (else the numbers below are meaningless)', r.face);
      check(r.pads.backdrop === r.pads.ta, 'backdrop and textarea share their padding', r.pads);
      for (const row of r.rows) {
        check(row.drift !== null && Math.abs(row.drift) <= 0.75,
          'the caret lands on the glyph, not inside it: ' + row.name, row);
      }
      if (r.pill) {
        check(r.pill.fw === '400', 'the painted pill is not bolder than the text', r.pill);
        check(Math.abs(r.pill.w - r.pill.taW) <= 0.75,
          'the painted pill is exactly as wide as the typed characters', r.pill);
      }
    }
    console.log('\n[4] the caret after a completion, from the middle of a line');
    const r = await probe(chrome, pageFile, { width: 1440, height: 900, dpr: 1 });
    const want = {
      'mention at the end': 'you wanna see @miicat47 ',
      'mention in the middle': '@miicat47 you wanna see this',
      'mention mid-line, text after the caret': 'ask @miicat47 about the thing',
      'role mention': 'hey @Mods ',
      'channel': 'see #general ',
      'emoji': 'nice :fire: ',
    };
    for (const c of r.carets) {
      check(c.value === want[c.name], 'the completion inserts the right text: ' + c.name, { got: c.value, want: want[c.name] });
      check(c.sel === c.value.length || c.name === 'mention mid-line, text after the caret',
        'the caret sits at the end of the inserted text: ' + c.name, c);
    }
    // The mid-line case is the one the bug report is about: completing a
    // mention in the middle of a sentence must leave the caret right after it,
    // with the rest of the sentence intact after that.
    const mid = r.carets.find((c) => c.name === 'mention in the middle');
    check(mid && mid.value === '@miicat47 you wanna see this' && mid.sel === 10,
      'a mention completed mid-line leaves the caret after the name, not at the end of the box', mid);
    const after = r.carets.find((c) => c.name === 'mention mid-line, text after the caret');
    check(after && after.value.slice(after.sel) === 'about the thing',
      'text the writer had after the caret is still after the caret', after);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log('failures:\n - ' + failures.join('\n - ')); process.exit(1); }
}

main().catch((e) => { console.error('HARNESS ERROR: ' + (e && e.stack || e)); process.exit(2); });
