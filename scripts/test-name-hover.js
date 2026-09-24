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
// Scope is part of the contract: the hover lives on the names you read — the
// two conversation surfaces (`#messages`, `#thread-replies` — every conversation
// renders into one of them), the user card name and the profile screen name.
// Member lists, the DM rows and the admin lists stay unadorned, and every rule
// must live in the END `@media (hover:hover)` block (base-rule `:hover` is a
// pinned bug on touch).
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
const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
check(/class="uc-uname\$\{nameClassFor\(u\)\}"/.test(pickers) && /style="\$\{nameStyleFor\(u\)\}"/.test(pickers),
  'the user card name goes through both helpers too (the grad-name marker drives the gradient line)');
check(/class="mname\$\{nameClassFor\(u\)\}"/.test(pickers),
  'and the profile screen name');
const rule = `#messages .msg .who:hover,#thread-replies .msg .who:hover{text-decoration:underline;text-decoration-thickness:.13em;text-underline-offset:.05em;text-decoration-color:currentColor}`;
check(css.includes(rule), 'hovering a chat name underlines it in currentColor', rule);
const gradRule = `#messages .msg .who.grad-name:hover::after,#thread-replies .msg .who.grad-name:hover::after{`;
check(css.includes(gradRule)
  && /background:linear-gradient\(90deg,var\(--nm-c1\),var\(--nm-c2\)\)\}/.test(css),
  'and a two-tone name\'s line is its own gradient');
check(/#messages \.msg \.who\.grad-name:hover::after,#thread-replies \.msg \.who\.grad-name:hover::after\{[^}]*bottom:\.23em;height:\.12em/.test(css),
  'the gradient line sits at the tuned height');
for (const [sel, label] of [
  ['#usercard .uc-name .uc-uname:hover', 'the user card name'],
  ['#pf-name .mname:hover', 'the profile screen name'],
]) {
  check(new RegExp(sel.replace(/[.#]/g, '\\$&') + '\\{[^}]*text-decoration:underline;text-decoration-thickness:\\.13em;text-underline-offset:\\.05em;text-decoration-color:currentColor\\}').test(css),
    'hovering ' + label + ' underlines it exactly like the chat name', sel);
}
check(/#usercard \.uc-name \.uc-uname\.grad-name:hover::after\{[^}]*bottom:\.23em[^}]*background:linear-gradient\(90deg,var\(--nm-c1\),var\(--nm-c2\)\)/.test(css)
  && /#pf-name \.mname\.grad-name:hover::after\{[^}]*bottom:\.23em[^}]*background:linear-gradient\(90deg,var\(--nm-c1\),var\(--nm-c2\)\)/.test(css),
  'two-tone names get the same gradient line on the card and the profile');

const lastHover = css.lastIndexOf('@media (hover:hover){');
check(lastHover > 0 && css.indexOf('.who:hover') > lastHover,
  'the rule lives in the END hover block (a base-rule :hover is a pinned bug on touch)');
check(css.indexOf('#usercard .uc-name .uc-uname:hover') > lastHover
  && css.indexOf('#pf-name .mname:hover') > lastHover,
  'the card and profile rules live there too');
check(!/#messages \.msg \.who:hover[^}]*text-decoration/.test(css.slice(0, lastHover))
  && !/#usercard \.uc-name \.uc-uname:hover/.test(css.slice(0, lastHover))
  && !/#pf-name \.mname:hover/.test(css.slice(0, lastHover)),
  'and none of them in the base cascade');

console.log('\n[3] names you read, and only those');
const whoHover = css.indexOf('#messages .msg .who:hover,#thread-replies .msg .who:hover');
check(whoHover > lastHover && /#messages \.msg \.who:hover,#thread-replies \.msg \.who:hover/.test(css),
  'both conversation surfaces carry it (a channel, a DM and a thread all render into these)');
for (const sel of ['.dmname:hover', '.anow-name:hover', '.adm-name']) {
  const i = css.indexOf(sel);
  const nearby = i < 0 ? '' : css.slice(i, i + 220);
  check(i < 0 || !/text-decoration/.test(nearby),
    'no underline leaks onto ' + sel + ' (member lists, DM rows, admin)', nearby);
}
// .mname is shared: member lists wear it bare, the profile screen wears it under
// #pf-name. Only the #pf-name one may hover-underline.
const cssSansProfile = css.replace(/#pf-name \.mname(\.grad-name)?(:hover)?(::after)?/g, '');
check(!/\.mname:hover/.test(cssSansProfile),
  'no underline leaks onto member-list .mname (only #pf-name wears it)');

console.log('');
if (failures.length) {
  console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log(`All ${passed} checks passed.`);
