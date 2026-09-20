// Custom status as a thought bubble beside the avatar (see AGENTS.md).
//
// The complaint: the custom status lived in the card BODY as a tonal box with
// its own "Custom status" heading and Edit/Clear buttons, and everywhere else
// it was another body row. It is now a Discord-style thought bubble sitting
// next to the profile picture — set, read and cleared from right there.
//
// Then the owner asked for the controls the bubble carries to be ONE oval chip:
// "add an edit pencil to the left of the x in the same box like make the circle
// more of an oval with 2 buttons", the pencil reopening the current status in
// the pop-up editor. That is a claim about pixels — the chip is an oval, the
// pencil is left of the ×, and the status text wraps clear of the chip instead
// of running underneath it — so the last section measures the real markup under
// the real stylesheet in headless Chrome (and skips without one).
//
// No bundler and no exports here, so this drives the REAL statusBubbleHTML()
// by extracting it from public/js/pickers.js and running it with stub globals.
//
// Offline except that last section (no database, no browser required).
//
// Usage: node scripts/test-status-bubble.js
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

const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}

// statusBubbleHTML leans on esc() and fmtCountdown().
global.S = { me: { id: 'me', username: 'jordan' } };
const code = slice(core, 'function esc(s) {', '// Layout size of a popup')
  + '\n' + slice(pickers, 'function fmtCountdown(ts) {', 'function wireStatusBubble(card) {');
// Strict mode gives eval its own scope, so hand the functions back explicitly.
const { esc, fmtCountdown, fmtUntil, statusBubbleHTML } = eval(code + '\n;({ esc, fmtCountdown, fmtUntil, statusBubbleHTML })');

const NOW = Date.now();
const other = (extra = {}) => ({ id: 'friend', username: 'sam', display_name: 'Sam', ...extra });
const me = (extra = {}) => ({ id: 'me', username: 'jordan', display_name: 'Jordan', ...extra });

console.log('\n[1] other people only get a bubble when they set something');
check(statusBubbleHTML(other()) === '', 'nothing set → no bubble at all');
check(statusBubbleHTML(other({ status_text: '   ' })) === '', 'whitespace-only status counts as unset');
const o = statusBubbleHTML(other({ status_text: 'Out camping this weekend' }));
check(o.includes('uc-bubble-wrap') && o.includes('uc-bubble-fit'), 'the bubble rides in the avatar row wrapper', o);
check(o.includes('<div class="uc-bubble">') && o.includes('Out camping this weekend'), 'a plain read-only bubble');
check(!o.includes('uc-bubble-acts') && !o.includes('uc-status-edit'), 'no edit / clear affordances on someone else\'s card');
check(!o.includes('uc-bubble-exp'), 'their expiry is never rendered here');
check(!statusBubbleHTML(other({ status_text: 'hi', status_expires_at: NOW + 3600e3 })).includes('Until'), 'expiry note is mine-only');

console.log('\n[2] my card always keeps the bubble, set or not');
const emptyMine = statusBubbleHTML(me());
check(emptyMine.includes('Set a status'), 'unset → a "Set a status" placeholder, not a body section', emptyMine);
check(emptyMine.includes('id="uc-status-edit"') && emptyMine.includes('empty'), 'the placeholder itself opens the editor');
check(!emptyMine.includes('uc-bubble-acts'), 'nothing to act on while unset');
// The placeholder used to be a bare dashed outline, which vanished against the
// card (and over a banner). It has to be filled to read at a glance, and keep
// the dashed hairline so it still says "not set" rather than "this is my status".
const emptyRule = /\.uc-bubble\.empty\{([^}]*)\}/.exec(css);
check(!!emptyRule, 'the empty placeholder has its own rule');
check(/background:var\(--panel-3\)/.test(emptyRule[1]), 'the placeholder is tonally filled (visible at rest)', emptyRule[1]);
check(/border:1px dashed/.test(emptyRule[1]), 'and keeps a dashed hairline so it reads as unset', emptyRule[1]);

const setMine = statusBubbleHTML(me({ status_text: 'Heads down on the voice rewrite' }));
check(setMine.includes('Heads down on the voice rewrite'), 'my status text is in the bubble');
check(setMine.includes('id="uc-status-edit"') && !setMine.includes('empty'), 'the bubble is the editor affordance');
check(setMine.includes('id="uc-status-clear"'), 'and carries a clear button');

console.log('\n[2b] the bubble carries ONE oval chip: a pencil, then the ×');
// The chip is the whole of the markup between the bubble and the expiry note.
const actsAt = setMine.indexOf('<span class="uc-bubble-acts">');
const actsEnd = setMine.indexOf('×</button></span>', actsAt);
const acts = actsAt < 0 ? '' : setMine.slice(actsAt, actsEnd + '×</button></span>'.length);
check(!!acts, 'my set bubble builds the chip', setMine);
check(setMine.indexOf('<span class="uc-bubble-acts">', actsAt + 1) === -1, 'exactly one chip (two separate boxes is what was asked away)');
check(acts.includes('id="uc-status-editpen"') && acts.includes('id="uc-status-clear"'), 'both controls live inside it', acts);
check(acts.indexOf('id="uc-status-editpen"') < acts.indexOf('id="uc-status-clear"'), 'the pencil comes first — left of the ×', acts);
check(/<svg[\s\S]*<\/svg>/.test(acts) && !/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}]/u.test(acts), 'the pencil is inline SVG chrome, never an emoji glyph', acts);
check(!css.includes('.uc-bubble-x'), 'the old single round × rule is gone (no dead CSS)');
const actsRule = /\.uc-bubble-acts\{([^}]*)\}/.exec(css);
check(!!actsRule, 'the chip has its own rule');
check(/border-radius:999px/.test(actsRule[1]), 'and is a pill — a circle grown into an oval by its second button', actsRule[1]);
check(/background:var\(--panel-4\)/.test(actsRule[1]), 'it keeps the thought bubble\'s own panel tone (a theme panel on a user-coloured card)', actsRule[1]);
const editRule = /\.uc-bubble\.edit\{([^}]*)\}/.exec(css);
check(!!editRule && /padding-right:2\.\d+rem/.test(editRule[1]), 'and the bubble reserves the chip\'s width, so text wraps clear of it', editRule && editRule[1]);

console.log('\n[3] the expiry note rides under the bubble');
const withExp = statusBubbleHTML(me({ status_text: 'Back later', status_expires_at: NOW + 3600e3 }));
check(withExp.includes('uc-bubble-exp') && withExp.includes('Until ' + fmtUntil(NOW + 3600e3)), 'future expiry → the clock time it clears at', withExp);
check(!statusBubbleHTML(me({ status_text: 'Back later', status_expires_at: NOW - 1000 })).includes('uc-bubble-exp'), 'a lapsed expiry shows no note');
check(!statusBubbleHTML(me({ status_text: 'Back later' })).includes('uc-bubble-exp'), 'no expiry → no note');
check(fmtCountdown(NOW - 1) === 'soon', 'a lapsed timer reads "soon"');
check(/^in \d+m$/.test(fmtCountdown(Date.now() + 30 * 60e3)), 'minutes phrasing');
check(/^in \d+h$/.test(fmtCountdown(Date.now() + 3 * 3600e3)), 'hours phrasing');
check(/^in \d+d$/.test(fmtCountdown(Date.now() + 10 * 864e5)), 'days phrasing');

console.log('\n[4] status text is escaped, never markup');
const nasty = statusBubbleHTML(other({ status_text: '<img src=x onerror=alert(1)> & "quotes"' }));
check(!nasty.includes('<img') && nasty.includes('&lt;img'), 'angle brackets escaped');
check(nasty.includes('&amp;') && nasty.includes('&quot;'), 'ampersands and quotes escaped');
check(!statusBubbleHTML(me({ status_text: '<b>bold</b>' })).includes('<b>bold</b>'), 'mine is escaped too');
// The escaped text is what the chip must never mistake for its own controls.
check(!statusBubbleHTML(me({ status_text: 'uc-status-clear <button>' })).includes('<button>uc-status'), 'the text cannot inject a button');

console.log('\n[5] the bubble lives in the avatar row, not the card body');
check(pickers.includes('<div class="uc-head"><span class="avatar big"></span>${statusBubbleHTML(u)}</div>'), 'card head renders the bubble beside the pfp');
check(!pickers.includes('statusEditHTML') && !pickers.includes('uc-statusbox'), 'the old body section is gone (no dead code)');
check(!/uid !== S\.me\.id && u\.status_text \? `<div class="uc-statustext">/.test(pickers), 'the old body status row is gone');
check(pickers.includes('wireStatusBubble(card)') && pickers.includes('refreshOwnStatusBubble()'), 'card wiring + in-place refresh are hooked up');
check(!pickers.includes('refreshOwnStatusBox('), 'no stale refresh call left behind');
// Both controls reopen the same editor (`openStatusEditor`) or clear the status.
const wiring = slice(pickers, 'function wireStatusBubble(card) {', '// ---------- presence switcher');
check(/querySelector\('#uc-status-editpen'\)[\s\S]*openStatusEditor\(\)/.test(wiring), 'the pencil opens the status pop-up for editing', wiring);
check(/querySelector\('#uc-status-clear'\)[\s\S]*clearMyStatus\(\)/.test(wiring), 'the × is still the clear button', wiring);

console.log('\n[6] the chip, measured in a real browser');
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
// The real markup, in the real card, under the real stylesheet. `--window-size`
// is a desktop width on purpose: the point is the chip's own geometry, not the
// phone sheet's.
function chipPageHtml(bubbleHtml) {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>*{transition:none!important;animation:none!important}</style></head><body>
<div id="usercard" style="width:300px"><div class="uc-body"><div class="uc-head"><span class="avatar big"></span>${bubbleHtml}</div></div></div>
<script>
const card = document.getElementById('usercard');
const bubble = card.querySelector('.uc-bubble');
const acts = card.querySelector('.uc-bubble-acts');
const buttons = acts ? Array.from(acts.querySelectorAll('button')) : [];
const R = (box) => { const r = box.getBoundingClientRect(); return { l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
// The painted ink, not the content box: a Range over the button's own text.
const textBox = () => { const rg = document.createRange(); rg.selectNodeContents(bubble); return R(rg); };
document.title = JSON.stringify({
  acts: acts ? R(acts) : null,
  radius: acts ? getComputedStyle(acts).borderRadius : null,
  bg: acts ? getComputedStyle(acts).backgroundColor : null,
  buttons: buttons.map((b) => Object.assign({ id: b.id, svg: !!b.querySelector('svg') }, R(b))),
  text: textBox(),
  bubble: R(bubble),
  contentRight: +(bubble.getBoundingClientRect().right - parseFloat(getComputedStyle(bubble).paddingRight)).toFixed(1),
  card: R(card),
});
</script></body></html>`;
}

const chrome = findChrome();
if (!chrome) console.log('  (skipped: no Chrome/Edge found — set CHROME_PATH)');
else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-status-bubble-'));
  const measure = (label, statusText) => {
    const page = path.join(dir, 'bubble.html');
    fs.writeFileSync(page, chipPageHtml(statusBubbleHTML(me({ status_text: statusText }))));
    const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=1100,900',
      '--virtual-time-budget=2000', '--dump-dom', 'file:///' + page.replace(/\\/g, '/')],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
    if (!m) { check(false, 'the fixture page ran (' + label + ')', { status: r.status }); return null; }
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  };
  const short = measure('short', 'Test status');
  const long = measure('long', 'Out camping this weekend, back on Monday with a status long enough to wrap');
  if (short && long) {
    check(short.buttons.length === 2 && short.buttons.map((b) => b.id).join(',') === 'uc-status-editpen,uc-status-clear',
      'both controls render inside the one chip, pencil first', short.buttons.map((b) => b.id));
    check(short.radius === '999px', 'the chip is a pill — the circle grew into an oval', short.radius);
    check(short.acts.w > short.acts.h * 1.5, 'and really is wider than it is tall', short.acts);
    check(short.buttons[0].r <= short.buttons[1].l, 'the pencil sits left of the ×', { pen: short.buttons[0].r, x: short.buttons[1].l });
    check(short.buttons.every((b) => b.l >= short.acts.l - 0.6 && b.r <= short.acts.r + 0.6 && b.t >= short.acts.t - 0.6 && b.b <= short.acts.b + 0.6),
      'each button sits inside the chip box', short.acts);
    check(short.buttons[0].svg && !short.buttons[1].svg, 'the pencil is the inline SVG, the × a glyph');
    check(short.contentRight <= short.acts.l, 'the bubble reserves the chip\'s width (nothing can run under it)',
      { contentRight: short.contentRight, chipLeft: short.acts.l });
    check(short.text.r <= short.acts.l, 'so a short status paints clear of the chip', { text: short.text.r, chip: short.acts.l });
    check(long.text.r <= long.acts.l, 'and one that wraps does too — every line, not just the first',
      { text: long.text.r, chip: long.acts.l });
    check(short.acts.r <= short.card.r - 8 && long.acts.r <= long.card.r - 8, 'the chip never hangs off the card',
      { short: short.acts.r, long: long.acts.r, card: short.card.r });
    check(/^rgb\(/.test(short.bg || ''), 'it is an opaque theme panel (it sits on a user-coloured card)', short.bg);
    check(short.acts.t < short.bubble.t + 2 && short.acts.b < short.bubble.b, 'it rides the bubble\'s top-right corner, as the single × did',
      { chip: short.acts, bubble: short.bubble });
  }
}

console.log('');
if (failures.length) {
  console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log(`All ${passed} checks passed.`);
