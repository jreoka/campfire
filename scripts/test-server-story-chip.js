// Server sidebar Stories row: the trailing chip (see AGENTS.md).
//
// The complaint: the row showed a grey "1" next to "Stories" after everything
// had been watched. It was the old all-watched branch printing a bare count of
// the server's other authors (or of the items, when the only live post was
// mine), which reads exactly like an unread badge — so people went looking for
// a story that did not exist. The chip is now two honest states only: an accent
// "N new" while something is waiting, and a muted "SEEN" once it is not.
//
// No bundler and no exports here, so this drives the REAL function by
// extracting it from stories.js and running it — no DOM needed.
//
// Offline (no database required).
//
// Usage: node scripts/test-server-story-chip.js
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
const code = slice('function serverStoryChip(unseen, otherAuthors) {', 'function renderServerStories() {');
// Strict mode gives eval its own scope, so hand the function back explicitly.
const { serverStoryChip } = eval(code + '\n;({ serverStoryChip })');

console.log('\n[1] something to watch → an accent "<n> new"');
const oneNew = serverStoryChip(2, 3);
check(oneNew && oneNew.text === '2 new' && oneNew.seen === false, 'unseen items are counted as new', oneNew);
check(serverStoryChip(1, 0).text === '1 new', 'my own posts never suppress the new count');
check(serverStoryChip(3, 1).text === '3 new', 'items, not authors, drive the new count');

console.log('\n[2] everything watched → a muted "Seen", never a bare number');
const seen = serverStoryChip(0, 2);
check(seen && seen.text === 'Seen' && seen.seen === true, 'the all-watched state says Seen', seen);
check(!/\d/.test(seen.text), 'no digit in the all-watched chip (the old grey "1")', seen.text);
check(serverStoryChip(0, 1).text === 'Seen', 'one other author who is watched → Seen, not "1"');

console.log('\n[3] nothing from anyone else → no chip at all');
check(serverStoryChip(0, 0) === null, 'only my own story → no chip (I cannot watch my own)');
check(serverStoryChip(0, 0) === null, 'no stories → no chip (the "Be the first" hint owns that row)');

console.log('\n[4] the wired call site uses the helper');
check(/const chip = serverStoryChip\(unseen, others\.length\);/.test(src), 'the server row asks serverStoryChip for its chip');
check(/n\.className = 'ss-count' \+ \(chip\.seen \? ' seen' : ''\);/.test(src), 'the muted class follows the seen flag');
check(!/n\.textContent = String\(others\.length \|\| items\.length\)/.test(src), 'the old bare grey count is gone');
check(/\.ss-count\.seen\{[^}]*text-transform:uppercase/.test(fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8')),
  'the Seen chip is styled as a status, not a badge');

console.log('\n' + (failures.length ? failures.length + ' FAILED, ' + passed + ' passed' : 'all ' + passed + ' checks passed'));
process.exit(failures.length ? 1 : 0);
