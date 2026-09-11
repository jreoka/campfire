// Composer live-preview backdrop (see AGENTS.md verification conventions).
//
// The complaint: after typing ||spoiler|| the blinking caret sat a few pixels
// left/right of where it looked like it should be. The composer is a
// transparent textarea with a rendered backdrop on top (`#in-render`); the
// caret belongs to the textarea, so the backdrop has to lay out EXACTLY the
// same characters. It used to drop every markdown delimiter (`**`, `||`,
// backticks, `> `) from the rendered HTML and re-style runs with padding /
// bold weight / monospace size, each of which shifts every following glyph
// away from the caret.
//
// This test drives the real `renderRich` pulled out of public/js/core.js and
// locks in the invariant: in `{plain:true}` mode, stripping the tags off the
// backdrop gives back the escaped source text, character for character — and
// the composer CSS stays metric-neutral. Offline (no database required).
//
// Usage: node scripts/test-composer-preview.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}

const src = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const escStart = src.indexOf('function esc(');
const richStart = src.indexOf('function renderRich(');
const richEnd = src.indexOf('function isBigEmoji');
if (escStart < 0 || richStart < 0 || richEnd < 0) {
  console.error('[test] could not find esc()/renderRich() in public/js/core.js');
  process.exit(1);
}
// Forward references inside renderRich (esc, S, memberByUsername) are resolved
// at call time; stub the ones the non-plain branch touches.
global.S = { emojiAll: {}, stdEmoji: {}, me: { id: 'u1' }, view: 'server', serverDetail: null };
global.memberByUsername = () => null;
const code = src.slice(escStart, richStart) + src.slice(richStart, richEnd);
const { esc, renderRich } = eval(code + '\n;({ esc, renderRich })');

// What the user typed (the textarea's value) vs what the backdrop shows.
const text = (html) => String(html)
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]*>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

const cases = [
  ['plain text', 'hello there'],
  ['bold', 'hello **bold** world'],
  ['bold then text', '**done** and after'],
  ['italic', 'an *italic* word'],
  ['strike', '~~gone~~ kept'],
  ['spoiler', 'a ||secret|| b'],
  ['spoiler only', '||secret||'],
  ['two spoilers', '||one|| middle ||two|| tail'],
  ['spoiler + bold', '**b** ||s|| **b2**'],
  ['inline code', 'run `npm test` now'],
  ['code then spoiler', '`x` ||y|| `z`'],
  ['fenced code', '```js\nconst a = 1;\n```'],
  ['unclosed fence', '```\nraw **not bold** ||x||'],
  ['quote', '> quoted line\nplain after'],
  ['quote run', 'a\n> one\n> two\nb'],
  ['link', 'see https://example.com/x ok'],
  ['multiline spoiler', 'start ||line one\nline two|| end'],
  ['html-ish', 'a <b> & "c" \'d\''],
  ['empty', ''],
];

for (const [name, input] of cases) {
  const out = renderRich(input, { plain: true });
  check(text(out) === input, 'backdrop keeps every character: ' + name, { input, out, got: text(out) });
}

// The delimiters have to actually be there (dimmed), not silently dropped.
const spoil = renderRich('a ||secret|| b', { plain: true });
check(/<span class="md-tok">\|\|<\/span><span class="spoiler">secret<\/span><span class="md-tok">\|\|<\/span>/.test(spoil), 'spoiler pipes kept and dimmed', spoil);
check(/<span class="md-tok">\*\*<\/span><strong>bold<\/strong>/.test(renderRich('**bold**', { plain: true })), 'bold markers kept and dimmed');
check(/<span class="md-tok">`<\/span><code>npm<\/code>/.test(renderRich('`npm`', { plain: true })), 'inline-code backticks kept and dimmed');
check(/<span class="md-tok">```js<\/span>/.test(renderRich('```js\nx\n```', { plain: true })), 'fence lines kept and dimmed');
check(/<span class="md-quote">/.test(renderRich('> quoted', { plain: true })), 'quote keeps its > characters');

// Messages themselves must not regress: same features, markers still gone.
check(renderRich('hello **bold**') === 'hello <strong>bold</strong>', 'message render unchanged: bold', renderRich('hello **bold**'));
check(renderRich('a ||secret|| b') === 'a <span class="spoiler">secret</span> b', 'message render unchanged: spoiler', renderRich('a ||secret|| b'));
check(renderRich('run `npm test`') === 'run <code>npm test</code>', 'message render unchanged: inline code', renderRich('run `npm test`'));
check(/<pre class="codeblock"><span class="cb-lang">js<\/span><code>const a = 1;<\/code><\/pre>/.test(renderRich('```js\nconst a = 1;\n```')), 'message render unchanged: code block', renderRich('```js\nconst a = 1;\n```'));
check(renderRich('> one\n> two') === '<blockquote>one<br>two</blockquote>', 'message render unchanged: quote', renderRich('> one\n> two'));
check(!renderRich('plain text').includes('md-tok'), 'messages carry no backdrop spans');

// The backdrop styles must not change glyph metrics. A padding, font-size,
// font-family or real font-weight on these selectors re-breaks the caret —
// and they have to override the generic rules that already set them (the
// composer spoiler inherited `.spoiler{padding:0 .3rem}` and `<code>` inherited
// the UA's monospace font until the backdrop rules said so explicitly).
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
function rule(selector) {
  const i = css.indexOf(selector + '{');
  if (i < 0) return null;
  return css.slice(i + selector.length + 1, css.indexOf('}', i));
}
for (const sel of ['#in-render .spoiler', '#in-render code']) {
  const body = rule(sel);
  check(body !== null, 'composer rule exists: ' + sel);
  check(body !== null && !/(^|;)\s*(font-size|letter-spacing)\s*:/.test(body), 'composer rule declares no metric changes: ' + sel, body);
}
// `.spoiler` has a global padding rule that would otherwise cascade in.
const spoilerRule = rule('#in-render .spoiler') || '';
check(/(^|;)\s*padding\s*:\s*0\b/.test(spoilerRule), 'composer spoiler kills the global padding', spoilerRule);
const codeRule = rule('#in-render code') || '';
check(/(^|;)\s*font-family\s*:\s*inherit\b/.test(codeRule), 'composer code keeps the textarea font', codeRule);
check(!/(^|;)\s*padding\s*:/.test(codeRule) || /(^|;)\s*padding\s*:\s*0\b/.test(codeRule), 'composer code has no padding', codeRule);
const strong = rule('#in-render strong');
check(strong !== null && /font-weight\s*:\s*inherit/.test(strong) && !/font-weight\s*:\s*(bold|[5-9]00)/.test(strong), 'composer bold does not widen glyphs', strong);
check(rule('#in-render .md-tok') !== null, 'composer delimiter style exists');

// OLED: the hidden-text pill must not be black-on-black (dark and light
// themes can keep the near-black bar; OLED has to lift off the true-black bg).
const oled = css.slice(css.indexOf('[data-theme="oled"]{'), css.indexOf('[data-theme="oled"]{') + 900);
const veil = (oled.match(/--spoiler:\s*(#[0-9a-f]{6})/i) || [])[1];
check(!!veil, 'oled defines a spoiler veil colour');
check(!!veil && veil.toLowerCase() !== '#000000' && veil.toLowerCase() !== '#07090e', 'oled spoiler veil is not black', { veil });

console.log('\n' + (failures.length ? 'FAILED: ' + failures.length : 'OK') + ' — ' + passed + ' checks passed');
if (failures.length) process.exit(1);
