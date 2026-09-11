// Story viewer start position (see AGENTS.md verification conventions).
//
// The complaint: after a friend posted a story to a server and I posted mine,
// tapping MY row in that server's Stories sheet opened the friend's story. A
// server tray is ONE playlist holding every author's items, and every row opened
// it at index 0 — the oldest post in the server — so the row you tapped had no
// say in what you saw. storyStartIndex() in public/js/stories.js now picks the
// item: a person's row opens that person's first item, a server row opens its
// first unseen item, and personal trays keep starting at the top.
//
// There is no bundler and no exports here, so this drives the REAL function by
// extracting it from stories.js and running it with stubs — no DOM needed.
//
// Offline (no database required).
//
// Usage: node scripts/test-story-start.js
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

const src = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');
function slice(from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block in public/js/stories.js'); process.exit(1); }
  return src.slice(a, b);
}
// storyStartIndex leans on storyLive (TTL filter) and S.me.
const code = slice('function storyLive(items) {', 'function storyUserTrays() {')
  + '\n' + slice('function storyStartIndex(tray, opt = {}) {', 'function openStoryViewer(opt = {}) {');
global.S = { me: { id: 'me' } };
// Strict mode gives eval its own scope, so hand the function back explicitly.
const { storyLive, storyStartIndex } = eval(code + '\n;({ storyLive, storyStartIndex })');

const T0 = Date.now();
const item = (id, authorId, at, seen) => ({ id, author: { id: authorId }, created_at: T0 + at, expires_at: T0 + 86400000, seen: !!seen });
const srvTray = (items) => ({ kind: 'server', id: 's1', server: { id: 's1', name: 'Studio' }, items });
const userTray = (items) => ({ kind: 'user', id: 'friend', user: { id: 'friend' }, items });

// The reported case: the friend posted first, I posted after; the server tray
// holds [friend, me] oldest-first.
const friendThenMe = srvTray([item('f1', 'friend', 0, false), item('m1', 'me', 1000, true)]);

console.log('\n[1] a server sheet row opens the tapped person');
check(storyStartIndex(friendThenMe, { userId: 'me' }) === 1, 'my row → my item, not the friend\'s', { got: storyStartIndex(friendThenMe, { userId: 'me' }) });
check(storyStartIndex(friendThenMe, { userId: 'friend' }) === 0, 'the friend\'s row → their first item');

const threeAuthors = srvTray([item('a1', 'a', 0, false), item('b1', 'b', 1000, false), item('b2', 'b', 2000, false), item('c1', 'c', 3000, false)]);
check(storyStartIndex(threeAuthors, { userId: 'c' }) === 3, 'third author → their first item', { got: storyStartIndex(threeAuthors, { userId: 'c' }) });
check(storyStartIndex(threeAuthors, { userId: 'b' }) === 1, 'an author with several items → the earliest of theirs');
check(storyStartIndex(threeAuthors, { userId: 'nobody' }) === 0, 'an author with nothing in the server → head (no crash)');

console.log('\n[2] a server row opens its first unseen item');
const mixed = srvTray([item('a1', 'a', 0, true), item('a2', 'a', 1000, false), item('m1', 'me', 2000, true), item('b1', 'b', 3000, false)]);
check(storyStartIndex(mixed, { unseen: true }) === 1, 'skips already-seen items');
check(storyStartIndex(mixed, { userId: 'a' }) === 0, 'a person\'s row still opens their first item, seen or not');
const allSeen = srvTray([item('a1', 'a', 0, true), item('b1', 'b', 1000, true)]);
check(storyStartIndex(allSeen, { unseen: true }) === 0, 'all seen → head');
// My own items are always flagged seen server-side, but never let one act as
// "the new one" if that ever changes.
check(storyStartIndex(srvTray([item('m1', 'me', 0, false), item('a1', 'a', 1000, false)]), { unseen: true }) === 1, 'my own item never counts as unseen');

console.log('\n[3] personal trays and expired items keep the old behavior');
check(storyStartIndex(userTray([item('f1', 'friend', 0, false)]), { kind: 'user', userId: 'friend' }) === 0, 'a friend tray still starts at the top');
check(storyStartIndex(srvTray([item('a1', 'a', 0, false)]), {}) === 0, 'a server tray with no hint starts at the top');
const expired = srvTray([{ ...item('a1', 'a', 0, false), expires_at: T0 - 1 }, item('m1', 'me', 1000, true)]);
check(storyLive(expired.items).length === 1 && storyStartIndex(expired, { userId: 'me' }) === 0, 'expired items are filtered before indexing');
check(storyStartIndex(null, { userId: 'me' }) === 0 && storyStartIndex(srvTray([]), { unseen: true }) === 0, 'empty/missing tray → 0 (no crash)');

console.log('\n[4] the wired call sites pass the hints');
check(/openStoryViewer\(\{\s*kind:\s*'server',\s*serverId,\s*userId:\s*t\.user\.id\s*\}\)/.test(src), 'server sheet row passes the row\'s author');
check(/openStoryViewer\(\{\s*kind:\s*'server',\s*serverId:\s*t\.server\.id,\s*unseen:\s*true\s*\}\)/.test(src), 'Home sheet server row passes unseen');
check(/const ii = storyStartIndex\(trays\[ti\], opt\);/.test(src) && /svShow\(ti, ii\);/.test(src), 'openStoryViewer starts at storyStartIndex(...)');

console.log('\n' + (failures.length ? failures.length + ' FAILED, ' + passed + ' passed' : 'all ' + passed + ' checks passed'));
process.exit(failures.length ? 1 : 0);
