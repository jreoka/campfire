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
// The real send-key logic, verbatim (it is the last function in core.js).
const paintSrc = core.slice(core.indexOf('function paintComposerSend()'));
// The field's visible surface rules, for the source-level assertions.
function ruleBody(sel) {
  const i = css.indexOf('\n' + sel + '{');
  if (i < 0) return null;
  const j = css.indexOf('}', i);
  return css.slice(i + sel.length + 2, j);
}

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>#chat{display:flex;flex-direction:column;height:100vh}</style></head><body>
<main id="chat">${composerMarkup}</main>
<script>
window.$ = (s) => document.querySelector(s);
window.S = { view: 'server', serverId: 's', channelId: 'c', dmThreadId: null, pendingAtts: [] };
${paintSrc}
window.__send = () => ({ off: document.querySelector('.send-btn').classList.contains('is-off'), disabled: document.querySelector('.send-btn').disabled, title: document.querySelector('.send-btn').title });
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
    menuRows: menuRows.length,
    menuRowsWithIcon: menuRows.filter((r) => r.querySelector('.ctx-ic svg')).length,
    menuSeps: document.querySelectorAll('#composer-more .ctx-sep').length,
    // The send key, driven through the real function.
    empty: (paintComposerSend(), window.__send()),
    typed: (() => { const i = document.querySelector('#in-message'); i.value = 'hello'; paintComposerSend(); return window.__send(); })(),
    attOnly: (() => { const i = document.querySelector('#in-message'); i.value = ''; S.pendingAtts = [{ id: 'a' }]; paintComposerSend(); return window.__send(); })(),
    blank: (() => { const i = document.querySelector('#in-message'); i.value = '   '; S.pendingAtts = []; paintComposerSend(); return window.__send(); })(),
    noChat: (() => { S.channelId = null; document.querySelector('#in-message').value = 'hi'; paintComposerSend(); const r = window.__send(); S.channelId = 'c'; return r; })(),
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
  check(/#in-render\{[^}]*background:var\(--field\)/.test(css), 'the field is painted with --field, not --inset');
  check(!/#in-render\{[^}]*background:var\(--inset\)/.test(css), 'and no longer with the login-input well');
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
  const fieldRule = ruleBody('#in-render') || '';
  check(/border-radius:16px/.test(fieldRule), 'the field and the send key share one radius family', fieldRule.slice(0, 60));

  console.log('\n[2] the field\'s own controls are wired and styled');
  check(/align-items:flex-end/.test(ruleBody('#composer') || ''), '#composer bottom-aligns its children (send key stays on the bar when the box grows)');
  check(/bottom:7px/.test(ruleBody('#btn-plus') || ''), 'the leading + rides the bottom of the box');
  check(/bottom:7px/.test(ruleBody('#composer-tools') || ''), 'and so does the tool rail');
  check(/color-mix\(in srgb, var\(--text\) 8%, transparent\)/.test(ruleBody('#btn-plus,#btn-more') || ''), 'the + has a resting surface mixed off --text (so it lifts in light mode too)');
  check(/#composer \.tool-btn:not\(#btn-plus\):not\(#btn-more\)/.test(css), 'the phone thumbs-size rule exempts the +, which must stay smaller than its field');
  const tap = /--tap:\s*(\d+)px/.exec(css);
  check(!!tap && Number(tap[1]) >= 44, '--tap is a real thumb target', tap && tap[1]);
  check(/#btn-plus::after,#btn-more::after\{[^}]*width:var\(--tap\)/.test(css.replace(/\s+/g, '')), 'and the + gets its thumb target from a hit box instead of from its own size');

  console.log('\n[3] the + menu reads as a menu');
  const menuRows = [...index.matchAll(/<button type="button" class="ctx-item" id="cm-[a-z]+">([\s\S]*?)<\/button>/g)];
  check(menuRows.length === 7, 'all seven composer actions are present', menuRows.length);
  check(menuRows.every((m) => /class="ctx-ic"><svg/.test(m[1])), 'every row carries an icon (it used to be a column of bare labels)');
  check(/<div class="ctx-sep"><\/div>/.test(index), 'and the media actions are separated from the content ones');
  check(/\.ctx-sep\{/.test(css), 'the separator is styled');

  console.log('\n[4] the send key follows the box');
  check(/function paintComposerSend\(\)/.test(core), 'paintComposerSend exists');
  check(/paintComposerSend\(\); \} catch \{\} \}\s*$/.test(core.trimEnd()) || /try \{ paintComposerSend\(\); \} catch \{\}/.test(core), 'applyComposerDraft repaints it on every channel / DM / thread switch');
  check(/syncComposerRender\(\);\s*\n\s*try \{ paintComposerSend\(\); \} catch \{\}/.test(messages), 'renderComposerMeta repaints it (attachments and reply chips)');
  check(/\$\('#in-message'\)\.addEventListener\('input', \(\) => \{ try \{ paintComposerSend\(\); \} catch \{\} \}\)/.test(finalJs), 'and so does typing in the box');
  check(/\.send-btn\.is-off\{background:var\(--panel-3\)/.test(css), 'the off state is a muted surface, not the accent');
  check(/\.send-btn\.is-off:hover\{background:var\(--panel-3\)\}/.test(css) && /\.send-btn\.is-off:hover svg\{transform:none\}/.test(css), 'and it does not play the accent hover or the nudge it cannot honour');
  // The composer's hover rules live in the one @media (hover:hover) block at the
  // bottom of the sheet, or a tap would leave the artifact stuck on the key.
  const hoverBlock = css.indexOf('hover, only where hover exists');
  check(hoverBlock > 0 && css.indexOf('.send-btn:hover{') > hoverBlock, 'the send key is only hover-styled where hovering exists');
  check(css.indexOf('#btn-plus:hover,#btn-more:hover{') > hoverBlock, 'and so is the leading +');

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
    check(phone.leadTop > 2 && phone.leadBottom > 2 && phone.leadLeft > 2 && phone.leadRight > 2,
      'the leading + sits fully INSIDE the field (it used to overflow the top and get clipped by the corner)',
      { top: phone.leadTop, bottom: phone.leadBottom, left: phone.leadLeft, right: phone.leadRight, lead: phone.lead, field: phone.field });
    check(Math.abs(phone.leadTop - phone.leadBottom) <= 3, 'and it is centred on the one-line field', { top: phone.leadTop, bottom: phone.leadBottom });
    check(phone.lead.h >= 30 && phone.lead.h <= 34, 'at 32px, small enough to fit the field', phone.lead.h);
    check(phone.composerAlign === 'flex-end', 'the send key rides the bottom of the row', phone.composerAlign);
    check(phone.menuRows === 7 && phone.menuRowsWithIcon === 7, 'the + menu rows render with their icons', { rows: phone.menuRows, icons: phone.menuRowsWithIcon });
    check(phone.menuSeps === 1, 'and the separator renders', phone.menuSeps);

    console.log('\n[6] the send key reads the box');
    check(phone.empty.off && phone.empty.disabled, 'empty box: muted and not clickable', phone.empty);
    check(phone.empty.title === 'Nothing to send yet', 'and it says why on hover', phone.empty.title);
    check(!phone.typed.off && !phone.typed.disabled, 'text in the box: lit and clickable', phone.typed);
    check(!phone.attOnly.off, 'an attachment with no text is still sendable', phone.attOnly);
    check(phone.blank.off, 'whitespace only is not', phone.blank);
    check(phone.noChat.off, 'and neither is a box with no conversation behind it', phone.noChat);

    console.log('\n[7] the desktop field matches');
    desktop = probe(chrome, base, { width: 1200, height: 820, dpr: 2, touch: false });
    check(!desktop.phone, 'the desktop shell is active', desktop.phone);
    check(desktop.inputPad === desktop.renderPad, 'paddings still match on the desktop rule', { input: desktop.inputPad, render: desktop.renderPad });
    check(desktop.leadTop > 2 && desktop.leadBottom > 2, 'the + is inside the field there too', { top: desktop.leadTop, bottom: desktop.leadBottom, lead: desktop.lead, field: desktop.field });
    check(desktop.fieldBg === phone.fieldBg, 'same field surface on both layouts', { phone: phone.fieldBg, desktop: desktop.fieldBg });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exitCode = 1; }
}

main();
