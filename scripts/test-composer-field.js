// The composer field (see AGENTS.md verification conventions).
//
// The complaint: the input box looked like a form field on a web page rather
// than the thing you write chat in. Four separate causes, all pinned here:
//
//  1. the field was painted with --inset — the same recessed well the app's
//     LOGIN INPUTS use — so it read as a hole punched in the bar. It now has its
//     own --field/--field-line pair, one tonal step above the bar it sits on, in
//     every theme (OLED included, where black-on-black would erase it).
//  2. the leading + was a bare transparent glyph floating in the field's left
//     gutter. It is a soft disc now (mixed off --text so it lifts in light mode
//     too) and the field's own controls ride the BOTTOM of the box, so a box
//     grown to four lines keeps them on the bar instead of floating mid-block.
//  3. the send key was permanently lit accent, inviting a tap that quietly did
//     nothing. It reads the box now: muted and disabled when there is nothing to
//     send, accent the moment there is. Same size and place either way, so
//     nothing reflows as you type — and it is cosmetic only, requestSubmit()
//     still fires with the key disabled (pinned in test-drafts-browser.js).
//     It is also exactly as TALL as the field it sends from (--field-h), which
//     it used to miss by a few pixels as a flat 46px key.
//  4. the + menu was a column of bare labels. It is the phone's only way into
//     attach / emoji / GIF / voice, so it gets icon rows like the ctx menu.
//
// Offline static checks, then the real index.html + styles.css in headless
// Chrome (skipping without Chrome) for the geometry and the send key, driven
// through the real paintComposerSend() sliced out of core.js.
//
// Usage: node scripts/test-composer-field.js
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
const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const messages = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
const finalJs = fs.readFileSync(path.join(ROOT, 'public/js/final.js'), 'utf8');

// The composer form, verbatim, so the harness measures the real thing.
const composerMarkup = index.slice(index.indexOf('<form id="composer">'), index.indexOf('<!-- members -->'));
// The thread bar's own composer, verbatim: the same chrome on a second surface.
// `hidden` comes off so it has layout to measure.
const threadMarkup = index.slice(index.indexOf('<aside id="thread-panel"'), index.indexOf('<!-- search tab -->')).replace('class="hidden"', '');
// The me bar, verbatim: the input pill is specified to be exactly its height.
const meCardMarkup = index.slice(index.indexOf('<div id="me-card">'), index.indexOf('\n      </div>', index.indexOf('<div id="me-card">')) + '\n      </div>'.length);
// The real send-key logic, verbatim (it is the last function in core.js).
const paintSrc = core.slice(core.indexOf('function paintComposerSend()'));
// The field's visible surface rules, for the source-level assertions.
function ruleBody(sel) {
  const i = css.indexOf('\n' + sel + '{');
  if (i < 0) return null;
  const j = css.indexOf('}', i);
  return css.slice(i + sel.length + 2, j);
}
// Since the thread bar became a second composer the two share most of their CSS,
// so a rule may name several selectors. This finds the first rule whose selector
// LIST contains the given one — exactly as a member, never as a substring (the
// focus-within rule mentions #in-render too, and is not the field's own rule).
function ruleFor(sel) {
  const re = /(?:^|\n)([^{}\n]+)\{([^{}]*)\}/g;
  for (let m; (m = re.exec(css)); ) {
    const members = m[1].split(',').map((s) => s.trim());
    if (members.includes(sel)) return { sel: m[1].trim(), body: m[2] };
  }
  return null;
}

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>#chat{display:flex;flex-direction:column;height:100vh}
 #sidebar{width:268px;flex:0 0 auto}
 /* The thread panel rises in with cf-rise, whose first frame is scale(.985) —
    and a --dump-dom page never advances that animation, so an un-suppressed
    panel measures 1.5% small and every one of its boxes with it. Measure the
    settled layout the reader actually ends up looking at. */
 #thread-panel{animation:none!important}</style></head><body>
<div style="display:flex;height:100vh"><aside id="sidebar"><div style="flex:1"></div>${meCardMarkup}</aside>
<main id="chat">${composerMarkup}</main>${threadMarkup}</div>
<script>
window.$ = (s) => document.querySelector(s);
window.S = { view: 'server', serverId: 's', channelId: 'c', dmThreadId: null, pendingAtts: [] };
${paintSrc}
window.__send = (sel) => { const b = document.querySelector(sel || '.send-btn'); return { off: b.classList.contains('is-off'), disabled: b.disabled, title: b.title }; };
window.__report = function () {
  const R = (s) => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect(); return { t: +b.top.toFixed(1), l: +b.left.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), b: +b.bottom.toFixed(1), r: +b.right.toFixed(1) }; };
  const field = R('#in-render');
  const lead = R('#btn-plus').w ? R('#btn-plus') : R('#btn-more');
  const afterW = parseFloat(getComputedStyle(document.querySelector('#btn-plus').offsetWidth ? document.querySelector('#btn-plus') : document.querySelector('#btn-more'), '::after').width) || 0;
  const cs = (s, p) => getComputedStyle(document.querySelector(s))[p];
  const inner = document.querySelector('#in-render');
  const menuRows = [...document.querySelectorAll('#composer-more .ctx-item')];
  return {
    vw: innerWidth,
    phone: matchMedia('(max-width:700px), (max-height:560px) and (pointer:coarse)').matches,
    coarse: matchMedia('(pointer:coarse)').matches,
    field,
    meBar: R('#me-card'), // the input pill is meant to be exactly this tall
    fieldBg: cs('#in-render', 'backgroundColor'),
    fieldLine: cs('#in-render', 'borderTopColor'),
    fieldRadius: cs('#in-render', 'borderRadius'),
    insetBg: getComputedStyle(document.documentElement).getPropertyValue('--inset').trim(),
    inputPad: cs('#in-message', 'padding'),
    renderPad: cs('#in-render', 'padding'),
    lead,
    leadTop: +(lead.t - field.t).toFixed(1),
    leadBottom: +(field.b - lead.b).toFixed(1),
    leadLeft: +(lead.l - field.l).toFixed(1),
    leadRight: +(field.r - lead.r).toFixed(1),
    leadAfter: afterW,
    composerAlign: cs('#composer', 'align-items'),
    // The composer's own height and the variable popovers anchor on: they must
    // agree at every breakpoint (the phone tightens its padding and re-states it).
    composerH: R('#composer').h,
    composerVar: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--composer-h')) || 0,
    menuRows: menuRows.length,
    menuRowsWithIcon: menuRows.filter((r) => r.querySelector('.ctx-ic svg')).length,
    menuSeps: document.querySelectorAll('#composer-more .ctx-sep').length,
    // The thread bar: the chat bar's own version, so every one of these has to
    // match the chat bar's numbers, not just look similar.
    threadField: R('#thread-render'),
    threadSend: R('#thread-composer .send-btn'),
    threadLead: R('#tbtn-plus') && R('#tbtn-plus').w ? R('#tbtn-plus') : R('#tbtn-more'),
    threadTools: R('#thread-composer-tools'),
    threadInputPad: cs('#in-thread', 'padding'),
    threadRenderPad: cs('#thread-render', 'padding'),
    threadFieldBg: cs('#thread-render', 'backgroundColor'),
    threadRadius: cs('#thread-render', 'borderRadius'),
    threadFont: cs('#thread-render', 'fontSize'),
    fieldFont: cs('#in-render', 'fontSize'),
    // Every metric that decides the box's height and the caret's place: if any of
    // these differs between the two bars, the "own version" claim is a lie.
    chatInputBox: ((s) => ({ font: cs(s, 'fontSize'), line: cs(s, 'lineHeight'), pad: cs(s, 'padding'), border: cs(s, 'borderTopWidth'), h: R(s).h }))('#in-message'),
    threadInputBox: ((s) => ({ font: cs(s, 'fontSize'), line: cs(s, 'lineHeight'), pad: cs(s, 'padding'), border: cs(s, 'borderTopWidth'), h: R(s).h }))('#in-thread'),
    threadAlign: cs('#thread-composer-row', 'align-items'),
    tbtnPlus: cs('#tbtn-plus', 'display'),
    tbtnMore: cs('#tbtn-more', 'display'),
    tbtnAttach: cs('#tbtn-attach', 'display'),
    // The send key, driven through the real function.
    // The send key rides the field's own height: same top and bottom edges.
    send: R('#composer .send-btn'),
    empty: (paintComposerSend(), window.__send()),
    typed: (() => { const i = document.querySelector('#in-message'); i.value = 'hello'; paintComposerSend(); return window.__send(); })(),
    attOnly: (() => { const i = document.querySelector('#in-message'); i.value = ''; S.pendingAtts = [{ id: 'a' }]; paintComposerSend(); return window.__send(); })(),
    blank: (() => { const i = document.querySelector('#in-message'); i.value = '   '; S.pendingAtts = []; paintComposerSend(); return window.__send(); })(),
    noChat: (() => { S.channelId = null; document.querySelector('#in-message').value = 'hi'; paintComposerSend(); const r = window.__send(); S.channelId = 'c'; return r; })(),
    // ...and the thread bar's key reads ITS box (the same function drives both).
    threadEmpty: (() => { S.thread = null; document.querySelector('#in-thread').value = ''; paintComposerSend(); return window.__send('#thread-composer .send-btn'); })(),
    threadTyped: (() => { S.thread = { rootId: 'r1' }; document.querySelector('#in-thread').value = 'a reply'; paintComposerSend(); return window.__send('#thread-composer .send-btn'); })(),
    threadBlank: (() => { S.thread = { rootId: 'r1' }; document.querySelector('#in-thread').value = '   '; paintComposerSend(); return window.__send('#thread-composer .send-btn'); })(),
  };
};
setTimeout(() => { document.title = JSON.stringify(window.__report()); }, 300);
</script>
</body></html>`;
}

function probe(chrome, url, { width, height, dpr, touch }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-field-'));
  try {
    const args = [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + path.join(dir, 'prof'), '--force-device-scale-factor=' + dpr,
      '--window-size=' + width + ',' + height, '--virtual-time-budget=3000', '--dump-dom', url,
    ];
    const r = spawnSync(chrome, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
    if (!m) throw new Error('no title in dump (chrome status ' + r.status + ')' + (r.stderr || '').slice(-300));
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function main() {
  console.log('\n[1] the field has its own surface, in every theme');
  const fieldRuleAll = ruleFor('#in-render') || { sel: '', body: '' };
  check(/background:var\(--field\)/.test(fieldRuleAll.body), 'the field is painted with --field, not --inset', fieldRuleAll.sel);
  check(!/background:var\(--inset\)/.test(fieldRuleAll.body), 'and no longer with the login-input well');
  const themeNames = ['dark', 'light', 'dracula', 'oled'];
  const missing = themeNames.filter((t) => {
    // :root/[data-theme="dark"] carries the dark pair; the others carry their own.
    const marker = t === 'dark' ? ':root,[data-theme="dark"]{' : `[data-theme="${t}"]{`;
    const i = css.indexOf(marker);
    if (i < 0) return true;
    const body = css.slice(i, css.indexOf('}', i));
    return !/--field:/.test(body) || !/--field-line:/.test(body);
  });
  check(missing.length === 0, 'all four themes define --field and --field-line', missing);
  const fieldRule = ruleFor('#in-render')?.body || '';
  check(/border-radius:16px/.test(fieldRule), 'the field and the send key share one radius family', fieldRule.slice(0, 60));

  console.log('\n[2] the field\'s own controls are wired and styled');
  check(/align-items:flex-end/.test(ruleBody('#composer') || ''), '#composer bottom-aligns its children (send key stays on the bar when the box grows)');
  // The two offsets are the centred rest position for a 32px control inside the
  // one-line pill — (pill height - 32) / 2 — so they move with --field-pad-y and
  // must agree with each other. [5]/[7] measure the result.
  const plusBottom = /bottom:([\d.]+)px/.exec(ruleBody('#btn-plus,#tbtn-plus') || '');
  const toolsBottom = /bottom:([\d.]+)px/.exec(ruleFor('#composer-tools')?.body || '');
  check(!!plusBottom && Number(plusBottom[1]) > 2, 'the leading + rides the bottom of the box', plusBottom && plusBottom[1]);
  check(!!toolsBottom && !!plusBottom && toolsBottom[1] === plusBottom[1], 'and the tool rail sits on the same optical line', toolsBottom && toolsBottom[1]);
  const leadDisc = ruleBody('#btn-plus,#btn-more,#tbtn-plus,#tbtn-more');
  check(/color-mix\(in srgb, var\(--text\) 8%, transparent\)/.test(leadDisc || ''), 'the + has a resting surface mixed off --text (so it lifts in light mode too)');
  check(/#composer \.tool-btn:not\(#btn-plus\):not\(#btn-more\)/.test(css), 'the phone thumbs-size rule exempts the +, which must stay smaller than its field');
  const tap = /--tap:\s*(\d+)px/.exec(css);
  check(!!tap && Number(tap[1]) >= 44, '--tap is a real thumb target', tap && tap[1]);
  const tapBox = ruleFor('#btn-plus::after') || { sel: '', body: '' };
  check(/width:var\(--tap\)/.test(tapBox.body) && /#tbtn-plus::after/.test(tapBox.sel),
    'and both bars\' + keys get their thumb target from a hit box instead of from their own size', tapBox.sel);

  console.log('\n[3] the + menu reads as a menu');
  const menuRows = [...index.matchAll(/<button type="button" class="ctx-item" id="cm-[a-z]+">([\s\S]*?)<\/button>/g)];
  check(menuRows.length === 7, 'all seven composer actions are present', menuRows.length);
  check(menuRows.every((m) => /class="ctx-ic"><svg/.test(m[1])), 'every row carries an icon (it used to be a column of bare labels)');
  check(/<div class="ctx-sep"><\/div>/.test(index), 'and the media actions are separated from the content ones');
  check(/\.ctx-sep\{/.test(css), 'the separator is styled');

  console.log('\n[4] the send key follows the box');
  check(/function paintComposerSend\(\)/.test(core), 'paintComposerSend exists');
  check(/paintComposerSend\(\); \} catch \{\} \}\s*$/.test(core.trimEnd()) || /try \{ paintComposerSend\(\); \} catch \{\}/.test(core), 'applyComposerDraft repaints it on every channel / DM / thread switch');
  const rc = messages.slice(messages.indexOf('function renderComposerMeta()'), messages.indexOf('function renderThreadComposerMeta()'));
  check(/syncComposerRender\(\)/.test(rc) && /syncThreadRender\(\)/.test(rc) && /paintComposerSend\(\)/.test(rc),
    'renderComposerMeta repaints both bars (attachments, reply chips, backdrops, send keys)');
  check(/\$\('#in-message'\)\.addEventListener\('input', \(\) => \{ try \{ paintComposerSend\(\); \} catch \{\} \}\)/.test(finalJs), 'and so does typing in the box');
  check(/\.send-btn\.is-off\{background:var\(--panel-3\)/.test(css), 'the off state is a muted surface, not the accent');
  // The key's height is the field's, derived from the same numbers (2 x padding +
  // one 1.5 line + border) rather than a flat pixel value — and the phone, whose
  // field is 16px, restates it. [5]/[7] measure both layouts.
  check(/\.send-btn\{[^}]*height:var\(--field-h\)/.test(css), 'the send key takes its height from --field-h, not a hardcoded size');
  check(/--field-h:calc\(2 \* var\(--field-pad-y\) \+ 1\.5 \* \.93rem \+ 2px\)/.test(css), 'which is derived from the desktop field\'s own metrics');
  check(/--field-h:calc\(2 \* var\(--field-pad-y\) \+ 1\.5 \* 1rem \+ 2px\)/.test(css), 'and restated against the phone\'s 16px field');
  check(/\.send-btn\.is-off:hover\{background:var\(--panel-3\)\}/.test(css) && /\.send-btn\.is-off:hover svg\{transform:none\}/.test(css), 'and it does not play the accent hover or the nudge it cannot honour');
  // The composer's hover rules live in the one @media (hover:hover) block at the
  // bottom of the sheet, or a tap would leave the artifact stuck on the key.
  const hoverBlock = css.indexOf('hover, only where hover exists');
  check(hoverBlock > 0 && css.indexOf('.send-btn:hover{') > hoverBlock, 'the send key is only hover-styled where hovering exists');
  const leadHover = ruleFor('#btn-plus:hover') || { sel: '' };
  check(css.indexOf(leadHover.sel + '{') > hoverBlock && /#tbtn-plus:hover/.test(leadHover.sel), 'and so is the leading +, on both bars', leadHover.sel);

  const chrome = findChrome();
  if (!chrome) return skip('no Chrome/Edge found (set CHROME_PATH)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-field-html-'));
  let phone, desktop;
  try {
    const htmlPath = path.join(dir, 'page.html');
    fs.writeFileSync(htmlPath, pageHtml());
    const base = 'file:///' + htmlPath.replace(/\\/g, '/');

    console.log('\n[5] geometry at a phone viewport');
    phone = probe(chrome, base, { width: 390, height: 844, dpr: 3, touch: true });
    // `--dump-dom` cannot enter a pointer:coarse media query (that needs CDP
    // touch emulation), so the 44px hit-box expansion is asserted at source
    // level in [2]; everything else here is real computed layout.
    check(phone.phone, 'the phone shell is active', { phone: phone.phone, coarse: phone.coarse });
    check(phone.fieldBg !== phone.insetBg, 'the field is not the inset well', { field: phone.fieldBg, inset: phone.insetBg });
    check(phone.fieldBg === 'rgb(23, 31, 47)', 'and it is the dark theme field surface', phone.fieldBg);
    check(phone.inputPad === phone.renderPad, 'the textarea and the backdrop have identical padding, or the caret drifts off the glyphs', { input: phone.inputPad, render: phone.renderPad });
    check(phone.field.h > 40 && phone.field.h < 56, 'a one-line field is a comfortable bar', phone.field.h);
    check(!!phone.meBar && Math.abs(phone.field.h - phone.meBar.h) <= 0.5,
      'the input pill is EXACTLY as tall as the me bar (2 x --field-pad-y + one 1.5 line + border)',
      { pill: phone.field.h, me: phone.meBar && phone.meBar.h });
    check(phone.leadTop > 2 && phone.leadBottom > 2 && phone.leadLeft > 2 && phone.leadRight > 2,
      'the leading + sits fully INSIDE the field (it used to overflow the top and get clipped by the corner)',
      { top: phone.leadTop, bottom: phone.leadBottom, left: phone.leadLeft, right: phone.leadRight, lead: phone.lead, field: phone.field });
    check(Math.abs(phone.leadTop - phone.leadBottom) <= 3, 'and it is centred on the one-line field', { top: phone.leadTop, bottom: phone.leadBottom });
    check(phone.lead.h >= 30 && phone.lead.h <= 34, 'at 32px, small enough to fit the field', phone.lead.h);
    check(phone.composerAlign === 'flex-end', 'the send key rides the bottom of the row', phone.composerAlign);
    check(!!phone.send && Math.abs(phone.send.h - phone.field.h) <= 0.5,
      'the send key is EXACTLY as tall as the message box (it was a flat 46px, ~5px short)',
      { send: phone.send && phone.send.h, field: phone.field.h });
    check(!!phone.send && Math.abs(phone.send.t - phone.field.t) <= 0.5 && Math.abs(phone.send.b - phone.field.b) <= 0.5,
      'so its top and bottom edges land on the box\'s',
      { sendTop: phone.send && phone.send.t, fieldTop: phone.field.t, sendBottom: phone.send && phone.send.b, fieldBottom: phone.field.b });
    check(Math.abs(phone.composerH - phone.composerVar) <= 1.5, 'the phone composer is the height --composer-h claims (the popovers above it anchor on it)',
      { h: phone.composerH, v: phone.composerVar });
    check(phone.menuRows === 7 && phone.menuRowsWithIcon === 7, 'the + menu rows render with their icons', { rows: phone.menuRows, icons: phone.menuRowsWithIcon });
    check(phone.menuSeps === 1, 'and the separator renders', phone.menuSeps);
    // The thread bar is the chat bar's own version: same pill, same controls,
    // same key — measured on the same page, so any drift shows up as a number.
    check(!!phone.threadField && Math.abs(phone.threadField.h - phone.field.h) <= 0.5,
      'the thread bar\'s pill is exactly the chat bar\'s height on the phone',
      { thread: phone.threadField && phone.threadField.h, chat: phone.field.h, chatBox: phone.chatInputBox, threadBox: phone.threadInputBox });
    check(phone.threadInputPad === phone.threadRenderPad, 'its textarea and backdrop share one padding too', { input: phone.threadInputPad, render: phone.threadRenderPad });
    check(JSON.stringify(phone.threadInputBox) === JSON.stringify(phone.chatInputBox),
      'and every metric that sizes the box (font, line, padding, border) is the chat box\'s',
      { chat: phone.chatInputBox, thread: phone.threadInputBox });
    check(phone.threadFieldBg === phone.fieldBg && phone.threadRadius === phone.fieldRadius && phone.threadFont === phone.fieldFont,
      'and one surface, radius and type size', { bg: phone.threadFieldBg, r: phone.threadRadius, font: phone.threadFont, chatFont: phone.fieldFont });
    check(!!phone.threadSend && Math.abs(phone.threadSend.h - phone.threadField.h) <= 0.5
      && Math.abs(phone.threadSend.t - phone.threadField.t) <= 0.5 && Math.abs(phone.threadSend.b - phone.threadField.b) <= 0.5,
      'its send key is the same key on the same edges',
      { send: phone.threadSend && phone.threadSend.h, field: phone.threadField.h });
    check(phone.threadAlign === 'flex-end', 'and the row bottom-aligns it, like the chat bar\'s', phone.threadAlign);
    const tl = phone.threadLead || {};
    const tf = phone.threadField || {};
    check(!!tl.w && tl.t - tf.t > 2 && tf.b - tl.b > 2 && tl.l - tf.l > 2 && tf.r - tl.r > 2,
      'the thread + sits fully inside its own field', { lead: tl, field: tf });
    check(/flex/.test(phone.tbtnMore) && phone.tbtnPlus === 'none' && phone.tbtnAttach === 'none',
      'the phone keeps only the + menu, exactly as the chat bar does',
      { more: phone.tbtnMore, plus: phone.tbtnPlus, attach: phone.tbtnAttach });

    console.log('\n[6] the send key reads the box');
    check(phone.empty.off && phone.empty.disabled, 'empty box: muted and not clickable', phone.empty);
    check(phone.empty.title === 'Nothing to send yet', 'and it says why on hover', phone.empty.title);
    check(!phone.typed.off && !phone.typed.disabled, 'text in the box: lit and clickable', phone.typed);
    check(!phone.attOnly.off, 'an attachment with no text is still sendable', phone.attOnly);
    check(phone.blank.off, 'whitespace only is not', phone.blank);
    check(phone.noChat.off, 'and neither is a box with no conversation behind it', phone.noChat);
    check(phone.threadEmpty.off && phone.threadEmpty.disabled, 'the thread key is muted while its box is empty and no thread is open', phone.threadEmpty);
    check(!phone.threadTyped.off && !phone.threadTyped.disabled, 'lit with a reply in it', phone.threadTyped);
    check(phone.threadBlank.off, 'and whitespace alone does not light it', phone.threadBlank);

    console.log('\n[7] the desktop field matches');
    desktop = probe(chrome, base, { width: 1200, height: 820, dpr: 2, touch: false });
    check(!desktop.phone, 'the desktop shell is active', desktop.phone);
    check(desktop.inputPad === desktop.renderPad, 'paddings still match on the desktop rule', { input: desktop.inputPad, render: desktop.renderPad });
    check(Math.abs(desktop.composerH - desktop.composerVar) <= 1.5, 'and the desktop composer matches its own --composer-h', { h: desktop.composerH, v: desktop.composerVar });
    check(!!desktop.meBar && Math.abs(desktop.field.h - desktop.meBar.h) <= 0.5,
      'the pill matches the me bar on the desktop rule too (both are 51.2px there)',
      { pill: desktop.field.h, me: desktop.meBar && desktop.meBar.h });
    check(desktop.leadTop > 2 && desktop.leadBottom > 2, 'the + is inside the field there too', { top: desktop.leadTop, bottom: desktop.leadBottom, lead: desktop.lead, field: desktop.field });
    check(!!desktop.send && Math.abs(desktop.send.h - desktop.field.h) <= 0.5,
      'and the send key matches the box on the desktop rule too',
      { send: desktop.send && desktop.send.h, field: desktop.field.h });
    check(desktop.fieldBg === phone.fieldBg, 'same field surface on both layouts', { phone: phone.fieldBg, desktop: desktop.fieldBg });
    check(!!desktop.threadField && Math.abs(desktop.threadField.h - desktop.field.h) <= 0.5,
      'the thread bar matches the chat bar on the desktop rule too',
      { thread: desktop.threadField && desktop.threadField.h, chat: desktop.field.h });
    check(desktop.threadFieldBg === desktop.fieldBg && desktop.threadRadius === desktop.fieldRadius,
      'with the same surface (the panel is its own column, not its own design)',
      { bg: desktop.threadFieldBg, r: desktop.threadRadius });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exitCode = 1; }
}

main();
