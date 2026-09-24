// The chat name hover underline (see AGENTS.md verification conventions).
//
// The ask (owner request): hovering a sender's name in the chat underlines it,
// and the underline must be the name's OWN colour when the name has one.
//
// The trap this pins: `nameStyleFor` paints a two-tone name with
// `background-clip:text` + `color:transparent` — there `currentColor` (and with
// it a plain `text-decoration:underline`) is INVISIBLE. So the name carries its
// gradient as `--nm-c1`/`--nm-c2` and wears `grad-name`, and the hover paints
// the same gradient as its line instead. Solid names — a `name_color` or the
// member's top role colour — underline in `currentColor`, which is exactly the
// inline colour.
//
// Scope is part of the contract: the hover lives ONLY on the two conversation
// surfaces (`#messages`, `#thread-replies` — every conversation renders into one
// of them). Member lists, the user card, the DM rows and the admin lists must
// stay unadorned, and the rule must live in the END `@media (hover:hover)`
// block (base-rule `:hover` is a pinned bug on touch).
//
// Offline (no Chrome, no database): the real nameStyleFor/nameClassFor sliced
// out of `public/js/servers.js` run against a fake `S`, plus the stylesheet and
// paint-site contracts.
//
// Usage: node scripts/test-name-hover.js
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

const servers = fs.readFileSync(path.join(ROOT, 'public/js/servers.js'), 'utf8');
const messages = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}

// ---- the real colour helpers, against a fake S ------------------------------
const code = slice(servers, 'function topRoleOf(m) {', '// Card background:');
const build = new Function('S', code + '\nreturn { nameStyleFor, nameClassFor };');
const S = { view: 'server', serverDetail: { members: [], roles: [] } };
const { nameStyleFor, nameClassFor } = build(S);

console.log('\n[1] the underline is the name\'s own ink (the colour source)');
check(nameStyleFor({ name_color: '#aabbcc' }) === 'color:#aabbcc',
  'a chosen name colour arrives as inline color — so currentColor on hover is exact',
  nameStyleFor({ name_color: '#aabbcc' }));
check(nameClassFor({ name_color: '#aabbcc' }) === '', 'and a solid name needs no gradient class');

S.serverDetail = { members: [{ id: 'u1', roleIds: ['r2'] }], roles: [
  { id: 'r1', color: '#111111', position: 5 },
  { id: 'r2', color: '#778899', position: 9 },
] };
check(nameStyleFor({ id: 'u1' }) === 'color:#778899',
  'a role-coloured name is its TOP role\'s color (same ink rule)', nameStyleFor({ id: 'u1' }));
check(nameClassFor({ id: 'u1' }) === '', 'and still no gradient class');
check(nameStyleFor({}) === '' && nameClassFor({}) === '',
  'an uncoloured name gets nothing (the underline follows the theme text)');

const grad = nameStyleFor({ name_color: '#112233', name_gradient: '#445566' });
check(/background:linear-gradient\(90deg,#112233,#445566\)/.test(grad) && /color:transparent/.test(grad),
  'a two-tone name is still painted background-clip:text', grad);
check(/--nm-c1:#112233/.test(grad) && /--nm-c2:#445566/.test(grad),
  'and now carries its gradient as --nm-c1/--nm-c2 (the hover line paints the same)', grad);
check(nameClassFor({ name_color: '#112233', name_gradient: '#445566' }) === ' grad-name',
  'with the grad-name marker class');
check(nameClassFor({ name_gradient: '#445566' }) === '' && nameStyleFor({ name_gradient: '#445566' }) === '',
  'a lone second colour is not a gradient (both halves required)');

console.log('\n[2] the stylesheet contract');
check(/class="who\$\{nameClassFor\(au\)\}"/.test(messages) && /style="\$\{nameStyleFor\(au\)\}"/.test(messages),
  'the chat row paints the name through both helpers (one .who site serves #messages and #thread-replies)');
const rule = `#messages .msg .who:hover,#thread-replies .msg .who:hover{text-decoration:underline;text-decoration-thickness:.08em;text-underline-offset:.22em;text-decoration-color:currentColor}`;
check(css.includes(rule), 'hovering a chat name underlines it in currentColor', rule);
const gradRule = `#messages .msg .who.grad-name:hover::after,#thread-replies .msg .who.grad-name:hover::after{`;
check(css.includes(gradRule)
  && /background:linear-gradient\(90deg,var\(--nm-c1\),var\(--nm-c2\)\)\}/.test(css),
  'and a two-tone name\'s line is its own gradient');

const lastHover = css.lastIndexOf('@media (hover:hover){');
check(lastHover > 0 && css.indexOf('.who:hover') > lastHover,
  'the rule lives in the END hover block (a base-rule :hover is a pinned bug on touch)');
check(!/#messages \.msg \.who:hover[^}]*text-decoration/.test(css.slice(0, lastHover)),
  'and nowhere in the base cascade');

console.log('\n[3] the chat area, and only the chat area');
const whoHover = css.indexOf('#messages .msg .who:hover,#thread-replies .msg .who:hover');
check(whoHover > lastHover && /#messages \.msg \.who:hover,#thread-replies \.msg \.who:hover/.test(css),
  'both conversation surfaces carry it (a channel, a DM and a thread all render into these)');
for (const sel of ['.dmname:hover', '.mname:hover', '.anow-name:hover', '.uc-name', '.adm-name']) {
  const i = css.indexOf(sel);
  const nearby = i < 0 ? '' : css.slice(i, i + 220);
  check(i < 0 || !/text-decoration/.test(nearby),
    'no underline leaks onto ' + sel + ' (member lists, the user card, DM rows, admin)', nearby);
}

console.log('');
if (failures.length) {
  console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log(`All ${passed} checks passed.`);
