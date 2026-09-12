// Role mentions + admin-only @everyone / @here (see AGENTS.md verification
// conventions).
//
// The rules this locks in:
//   - a server role is mentionable by anyone: `@Role Name` renders as a chip and
//     pings every holder (longest role name wins, so "@Mod Team" is never also a
//     mention of a role called "Mod");
//   - `@everyone` / `@here` belong to server admins (owner or an admin role) —
//     from anyone else's message they are plain text and ping nobody, and the
//     composer's autocomplete never even offers them;
//   - a role you hold highlights like a personal mention.
//
// There is no bundler and no exports, so this drives the REAL functions by
// extracting them from public/js/core.js and server.js and running them with
// stubs. Offline (no database, no browser required).
//
// Usage: node scripts/test-role-mentions.js
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

// ---------- the client renderer ----------
const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const escStart = core.indexOf('function esc(');
const richStart = core.indexOf('function renderRich(');
const richEnd = core.indexOf('function isBigEmoji');
if (escStart < 0 || richStart < 0 || richEnd < 0) {
  console.error('[test] could not find esc()/renderRich() in public/js/core.js');
  process.exit(1);
}

const ROLES = [
  { id: 'r-mod', name: 'Mod', color: '#3ba55d', admin: 0, hoist: 1, position: 2 },
  { id: 'r-modteam', name: 'Mod Team', color: '#ff8800', admin: 0, hoist: 0, position: 1 },
  { id: 'r-admin', name: 'Ops', color: '', admin: 1, hoist: 0, position: 3 },
];
// A fresh server object each time: the renderer caches its matcher against the
// live member/role arrays, so replacing the object is exactly what a
// `server-updated` push does.
function server({ meRoles = ['r-mod'], members } = {}) {
  S.serverDetail = {
    id: 's1',
    owner_id: 'owner',
    roles: ROLES.map((r) => ({ ...r })),
    members: members || [
      { id: 'me', username: 'jordan', display_name: 'Jordan', roleIds: meRoles },
      { id: 'bob', username: 'bob', display_name: 'Bob', roleIds: ['r-modteam'] },
      { id: 'owner', username: 'root', display_name: 'Root', roleIds: [] },
    ],
  };
}

global.S = {
  me: { id: 'me', username: 'jordan' },
  view: 'server',
  serverId: 's1',
  dmThreadId: null,
  dms: [],
  emojiAll: {},
  stdEmoji: {},
  serverDetail: null,
};
server();
// The non-plain branch resolves emoji + usernames; nothing here needs stubs
// beyond S, which the slice owns a copy of.
const clientCode = core.slice(escStart, richStart) + core.slice(richStart, richEnd);
const { renderRich, memberIsAdmin, mentionsToken, mentionedRoleIds } = eval(
  clientCode + '\n;({ renderRich, memberIsAdmin, mentionsToken, mentionedRoleIds })');

const render = (text, authorId) => renderRich(text, { authorId });

console.log('\n[1] @everyone / @here are the admins\' alone');
check(/class="mention all">@everyone</.test(render('heads up @everyone', 'owner')), 'the owner broadcasts', render('heads up @everyone', 'owner'));
check(/class="mention all">@here</.test(render('@here stand up', 'owner')), '@here renders for the owner', render('@here stand up', 'owner'));
server({ meRoles: ['r-admin'] });
check(/class="mention all">@everyone</.test(render('@everyone', 'me')), 'an admin role broadcasts too', render('@everyone', 'me'));
server();
check(render('@everyone please read', 'bob') === '@everyone please read', 'a plain member typing @everyone renders as plain text', render('@everyone please read', 'bob'));
check(render('@here now', 'bob') === '@here now', 'and @here likewise', render('@here now', 'bob'));
check(!render('@everyoneish stuff', 'owner').includes('mention'), '@everyoneish is not a mention', render('@everyoneish stuff', 'owner'));
check(!render('mail@everyone.com', 'owner').includes('mention'), 'an email-ish @everyone is not a mention', render('mail@everyone.com', 'owner'));
check(!render('@everyone', undefined).includes('mention'), 'no author (a bio, a preview) never broadcasts', render('@everyone', undefined));

console.log('\n[2] roles are mentionable by everyone');
server({ meRoles: [] });
const roleChip = render('ping @Mod', 'bob');
check(/<span class="mention role" data-rid="r-mod"/.test(roleChip) && />@Mod</.test(roleChip), 'a role name renders as its own chip', roleChip);
check(roleChip.includes('style="--rc:#3ba55d"'), "the chip carries the role's colour", roleChip);
check(!roleChip.includes('mention role me'), 'a role you do not hold is not "me"', roleChip);
const noColor = render('@Ops now', 'owner');
check(!noColor.includes('--rc:'), 'a colourless role adds no inline colour', noColor);
server({ meRoles: ['r-mod'] });
check(/class="mention role me" data-rid="r-mod"/.test(render('ping @Mod', 'bob')) && !render('ping @Mod', 'bob').includes('--rc:'),
  'a role you hold highlights as a personal mention (and drops the inline colour)', render('ping @Mod', 'bob'));
check(render('nothing to see', 'bob') === 'nothing to see', 'plain text is untouched');

console.log('\n[3] longest role name wins');
const long = render('@Mod Team assemble', 'bob');
check(long.includes('data-rid="r-modteam"') && !long.includes('data-rid="r-mod"'), '"@Mod Team" is the long role, not "Mod" + " Team"', long);
const both = render('@Mod and @Mod Team', 'bob');
check(both.includes('data-rid="r-mod"') && both.includes('data-rid="r-modteam"'), 'both roles ping when both are named', both);
check(!render('@Moderator hi', 'bob').includes('mention'), '@Moderator is not @Mod', render('@Moderator hi', 'bob'));

console.log('\n[4] usernames still behave');
const user = render('hi @bob', 'me');
check(/class="mention" data-uid="bob">@Bob</.test(user), 'a plain @username chip is unchanged', user);
server({ meRoles: ['r-mod'] });
check(/class="mention me" data-uid="me">@Jordan</.test(render('@jordan look', 'bob')), 'mentioning yourself still reads as "me"', render('@jordan look', 'bob'));

console.log('\n[5] outside a server it stays username-only');
S.view = 'home';
S.dmThreadId = 't1';
S.dms = [{ id: 't1', members: [{ id: 'bob', username: 'bob', display_name: 'Bob' }] }];
check(/data-uid="bob"/.test(render('hi @bob')), 'a DM still renders username mentions', render('hi @bob'));
check(render('hi @everyone') === 'hi @everyone', 'a DM never renders @everyone', render('hi @everyone'));
check(render('hi @Mod') === 'hi @Mod', 'and never renders a server role', render('hi @Mod'));
S.view = 'server';
S.dmThreadId = null;

console.log('\n[6] the server-side matcher agrees with the renderer');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const sStart = serverSrc.indexOf('function reEsc(');
const sEnd = serverSrc.indexOf('async function unreadNotifs(');
if (sStart < 0 || sEnd < 0) {
  console.error('[test] could not find the mention helpers in server.js');
  process.exit(1);
}
const { mentionsName, mentionsToken: sToken, mentionedRoleIds: sRoleIds } = eval(
  serverSrc.slice(sStart, sEnd) + '\n;({ mentionsName, mentionsToken, mentionedRoleIds })');

check(sToken('hey @everyone!', 'everyone') === true, 'server: @everyone matches mid-sentence');
check(sToken('@everyone', 'everyone') === true, 'server: @everyone matches at the start');
check(sToken('@everyoneish', 'everyone') === false, 'server: @everyoneish does not match');
check(sToken('mail@everyone.com', 'everyone') === false, 'server: a bare email does not match');
check(sToken('@HERE now', 'here') === true, 'server: @here is case-insensitive');
check(mentionsName('hi @bob', 'bob') === true && mentionsName('hi @bobby', 'bob') === false, 'server: username mentions keep their word boundary');
check(JSON.stringify(sRoleIds('@Mod Team', ROLES)) === '["r-modteam"]', 'server: longest role wins', sRoleIds('@Mod Team', ROLES));
check(JSON.stringify(sRoleIds('@Mod and @Mod Team', ROLES)) === '["r-modteam","r-mod"]', 'server: both roles ping', sRoleIds('@Mod and @Mod Team', ROLES));
check(JSON.stringify(sRoleIds('@Moderator', ROLES)) === '[]', 'server: @Moderator pings nothing', sRoleIds('@Moderator', ROLES));
// The same text has to mean the same thing on both sides.
for (const [text, roles] of [['@Mod Team', ['r-modteam']], ['@Mod', ['r-mod']], ['@Mod and @Mod Team', ['r-modteam', 'r-mod']]]) {
  const ids = mentionedRoleIds(text, ROLES).slice().sort().join(',');
  const sids = sRoleIds(text, ROLES).slice().sort().join(',');
  check(ids === sids && ids === roles.slice().sort().join(','), 'client and server agree on ' + JSON.stringify(text), { ids, sids });
}

console.log('\n[7] the notification gate is wired to that matcher');
check(/const authorAdmin = author\.userId \? await isAdmin\(serverId, author\.userId\) : false;/.test(serverSrc),
  'the notifier resolves the author\'s admin status');
check(/const everyone = authorAdmin && mentionsToken\(text, 'everyone'\);/.test(serverSrc),
  '@everyone pings only from an admin');
check(/const here = authorAdmin && !everyone && mentionsToken\(text, 'here'\);/.test(serverSrc),
  '@here pings only from an admin');
check(/roleHolders\.has\(uid\)/.test(serverSrc) && /presenceFor\(serverId, author\.userId\)/.test(serverSrc),
  'role holders and (for @here) online members are resolved server-side');
const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
check(/if \(canManage\(\)\) for \(const t of \['everyone', 'here'\]\)/.test(pickers),
  'the composer never offers @everyone / @here to a non-admin');
check(/kind: 'role', insert: r\.name/.test(pickers), 'the composer offers roles');
const messages = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
check(/renderRich\(m\.content, \{ authorId: m\.user && m\.user\.id \}\)/.test(messages),
  'the chat tells the renderer who wrote the message');
const servers = fs.readFileSync(path.join(ROOT, 'public/js/servers.js'), 'utf8');
check(/function mentionsMe\(msg\) \{[\s\S]*?memberIsAdmin\(msg\.user && msg\.user\.id\)/.test(servers),
  'the mention sound is gated on the author being an admin too');
check(/(?:\r?\n)  if \(!S\.serverDetail \|\| !S\.me\) return false;\r?\n  return memberIsAdmin\(S\.me\.id\);/.test(servers),
  'canManage() and the mention gate share one admin test');

console.log('\n' + (failures.length ? 'FAILED: ' + failures.length : 'OK') + ' — ' + passed + ' checks passed');
if (failures.length) process.exit(1);
