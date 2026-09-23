#!/usr/bin/env node
// Your own live story counts on the Home sidebar's Stories row.
// The complaint: post a story while nobody else has one, and the row still
// says "No stories yet — be the first" (with the camera mark for a face).
// The server delivers your own posts in `storyData.mine`, apart from the
// friends/everyone trays — but storyHomeCounts() only looked at those trays
// and the server trays, so your own posts counted as nobody. The module's own
// comment said they should count as a person (never as unseen); the code just
// never implemented it.
//
// Drives the REAL storyLive/storyUserTrays/storyHomeCounts/renderHomeStories
// out of public/js/stories.js (verbatim slices, like
// scripts/test-story-delete-refresh.js) against stub DOM for the row.
// Pure node — no Chrome needed.
//
// Usage: node scripts/test-story-own-counts.js
'use strict';
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(cond, name) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name); }
}

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');
function slice(from, to) {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] block not found: ' + from); process.exit(1); }
  return src.slice(a, b);
}

// Minimal stub DOM for the Stories row.
function fakeEl() {
  const set = new Set();
  return {
    innerHTML: '', textContent: '',
    style: {},
    classList: {
      add: (c) => set.add(c), remove: (c) => set.delete(c),
      toggle: (c, f) => { f ? set.add(c) : set.delete(c); },
      contains: (c) => set.has(c),
      [Symbol.iterator]: () => set[Symbol.iterator](),
    },
    _has: (c) => set.has(c),
    querySelector: () => null,
  };
}
const ME = { id: 'me', username: 'me', display_name: 'Jordan' };
const FRIEND = { id: 'f1', username: 'f1', display_name: 'Aiko' };
const now = Date.now();
const liveItem = (id, author, seen) =>
  ({ id, author, seen: !!seen, created_at: now - 1000, expires_at: now + 3600000 });
const deadItem = (id, author) =>
  ({ id, author, seen: false, created_at: now - 7200000, expires_at: now - 1000 });

function build(S, storyData, els) {
  const $ = (sel) => els[sel] || null;
  const painted = [];
  const paintAvatar = (el, user) => { painted.push(user && user.id); };
  const harness =
    slice('const svSvg = {', '\n// Trays as the API returns them') + '\n' +
    slice('function storyLive(items)', '\nfunction storyUserTrays') + '\n' +
    slice('function storyUserTrays()', '\nfunction storyTrayFor') + '\n' +
    slice('function storyHomeCounts()', '\nfunction storyAgo') + '\n' +
    slice('function renderHomeStories()', '\n// ---------- rings on other people\'s rows ----------') + '\n' +
    'return { storyHomeCounts, renderHomeStories };';
  const fns = new Function('$', 'paintAvatar', 'S', 'storyData', harness)($, paintAvatar, S, storyData);
  return { ...fns, painted };
}
function rowEls() {
  return {
    '#btn-stories': fakeEl(),
    '#stories-nav-av': fakeEl(),
    '#stories-nav-count': fakeEl(),
    '#home-story-dot': fakeEl(),
    '#stories-nav-sub': fakeEl(),
  };
}
const S = { me: ME };

console.log('[1] your own live story counts as a person, never as unseen');
{
  const els = rowEls();
  const data = { mine: { items: [liveItem('m1', ME, true)], latest: now, viewers: 0 }, friends: [], everyone: [], servers: [] };
  const { renderHomeStories, painted } = build(S, data, els);
  renderHomeStories();
  check(els['#stories-nav-sub'].textContent === '1 person with stories',
    'the row says "1 person with stories"', );
  check(els['#stories-nav-count']._has('hidden'), 'no unseen badge for your own story');
  check(els['#home-story-dot']._has('hidden'), 'no Home dot for your own story');
  check(painted.length === 1 && painted[0] === 'me', 'the row wears your avatar, not the camera mark');
}

console.log('\n[2] the empty state is unchanged');
{
  const els = rowEls();
  const data = { mine: null, friends: [], everyone: [], servers: [] };
  const { renderHomeStories, painted } = build(S, data, els);
  renderHomeStories();
  check(els['#stories-nav-sub'].textContent === 'No stories yet — be the first', 'the row says "No stories yet"');
  check(painted.length === 0, 'nothing is avatar-painted');
  check(els['#stories-nav-av'].innerHTML.includes('svg'), 'the camera mark shows');
}

console.log('\n[3] your story plus a friend\'s unseen story');
{
  const els = rowEls();
  const data = {
    mine: { items: [liveItem('m1', ME, true)], latest: now, viewers: 0 },
    friends: [{ user: FRIEND, items: [liveItem('f1', FRIEND, false)] }],
    everyone: [], servers: [],
  };
  const { renderHomeStories } = build(S, data, els);
  renderHomeStories();
  check(els['#stories-nav-sub'].textContent === '1 new from 2 people', 'one unseen item across two people');
  check(!els['#stories-nav-count']._has('hidden') && els['#stories-nav-count'].textContent === '1', 'the badge counts 1');
}

console.log('\n[4] one story shared to friends and a server is still one person');
{
  const els = rowEls();
  const item = liveItem('m1', ME, true);
  const data = {
    mine: { items: [item], latest: now, viewers: 0 },
    friends: [], everyone: [],
    servers: [{ server: { id: 's1' }, items: [item], unseen: 0, latest: now, mine: 1 }],
  };
  const { renderHomeStories } = build(S, data, els);
  renderHomeStories();
  check(els['#stories-nav-sub'].textContent === '1 person with stories', 'the same item in two trays is not two people');
}

console.log('\n[5] an expired own story counts as nothing');
{
  const els = rowEls();
  const data = { mine: { items: [deadItem('m1', ME)], latest: now, viewers: 0 }, friends: [], everyone: [], servers: [] };
  const { renderHomeStories, painted } = build(S, data, els);
  renderHomeStories();
  check(els['#stories-nav-sub'].textContent === 'No stories yet — be the first', 'an expired story is not counted');
  check(painted.length === 0, 'an expired story does not paint your avatar');
}

if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('\nAll checks passed.');
