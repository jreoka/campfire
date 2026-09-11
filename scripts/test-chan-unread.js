// Unread channel dots (see AGENTS.md verification conventions).
//
// A text channel that gets a message while you are not looking at it earns a
// small dot on the left plus a brighter, heavier name, and the affected
// server's rail icon gets a quiet dot too. The memory is per account in
// localStorage, so it survives a reload, and the live message push arrives for
// every joined server, so the dot lands even from a server you are not in.
//
// Offline (no database, no browser): the real helpers are sliced out of
// public/js/servers.js and run against a tiny fake DOM + localStorage. The
// render/socket wiring and the stylesheet are checked statically.
//
// Usage: node scripts/test-chan-unread.js
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
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}

const servers = fs.readFileSync(path.join(ROOT, 'public/js/servers.js'), 'utf8');
const socket = fs.readFileSync(path.join(ROOT, 'public/js/socket.js'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

// ---------- fake DOM + storage so the real helpers can run ----------
const rows = new Map(); // selector -> fake element
function fakeEl() {
  const set = new Set();
  return { classList: { toggle: (c, on) => { if (on) set.add(c); else set.delete(c); }, has: (c) => set.has(c), _set: set } };
}
function fakeQuery(sel) {
  // Both helpers build their selector from serverId/channelId, so match on the
  // quoted id: '#text-channels .chan[data-cid="c1"]' / '#server-list .server-btn[data-sid="s1"]'.
  const m = /\[data-(cid|sid)="([^"]+)"\]/.exec(sel);
  return m ? (rows.get(m[1] + ':' + m[2]) || null) : null;
}
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
global.document = { querySelector: fakeQuery };
global.CSS = { escape: (s) => String(s).replace(/["\\]/g, '\\$&') };
global.S = { me: { id: 'me' }, serverId: 's1', channelId: null, view: 'server', chanUnread: new Map() };

const code = slice(servers, '// ---------- unread channels ----------', 'function renderChannels() {');
const api = eval(code + '\n;({ loadChanUnread, saveChanUnread, markChanUnread, clearChanUnread, hasChanUnread, serverHasUnread, chanUnreadCtx, paintChanUnread, paintServerUnread, clearActiveChanUnread, CHAN_UNREAD_MAX, CHAN_UNREAD_TTL })');
const { loadChanUnread, markChanUnread, clearChanUnread, hasChanUnread, serverHasUnread, chanUnreadCtx, paintChanUnread, saveChanUnread, clearActiveChanUnread, CHAN_UNREAD_MAX, CHAN_UNREAD_TTL } = api;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n[1] mark / clear / reload');
  store.clear();
  S.chanUnread = new Map();
  loadChanUnread();
  check(!hasChanUnread('s1', 'c1'), 'a fresh account has nothing unread');
  markChanUnread('s1', 'c1');
  check(hasChanUnread('s1', 'c1'), 'a background message marks its channel');
  check(serverHasUnread('s1') && !serverHasUnread('s2'), 'the server knows one of its channels is unread');
  await sleep(500); // saveChanUnread is debounced
  const persisted = JSON.parse(store.get('cf_chanunread_me') || '{}');
  check(!!persisted['s1:c1'], 'the mark is persisted per account', persisted);
  // Reload from storage (a page refresh).
  S.chanUnread = new Map();
  loadChanUnread();
  check(hasChanUnread('s1', 'c1'), 'a reload restores the unread dot');
  clearChanUnread('s1', 'c1');
  check(!hasChanUnread('s1', 'c1'), 'opening the channel clears it');
  await sleep(500);
  check(!JSON.parse(store.get('cf_chanunread_me') || '{}')['s1:c1'], 'the cleared mark is persisted too');

  console.log('\n[2] per-account isolation');
  store.clear();
  S.me = { id: 'me' }; S.chanUnread = new Map();
  markChanUnread('s1', 'c1');
  await sleep(500);
  S.me = { id: 'other' }; S.chanUnread = new Map();
  loadChanUnread();
  check(!hasChanUnread('s1', 'c1'), 'another account does not inherit the dot');
  check(!!store.get('cf_chanunread_me') && !store.get('cf_chanunread_other'), 'the stores are keyed by account');
  S.me = { id: 'me' };
  S.chanUnread = new Map(); loadChanUnread();
  check(hasChanUnread('s1', 'c1'), 'the original account still has its dot');

  console.log('\n[3] the store stays bounded and forgets old marks');
  store.clear();
  S.chanUnread = new Map();
  const many = CHAN_UNREAD_MAX + 25;
  for (let i = 0; i < many; i++) markChanUnread('s1', 'c' + i);
  check(S.chanUnread.size === many, 'every mark is live in the map');
  await sleep(500);
  const capped = JSON.parse(store.get('cf_chanunread_me') || '{}');
  check(Object.keys(capped).length === CHAN_UNREAD_MAX, 'only the newest ' + CHAN_UNREAD_MAX + ' are persisted', { n: Object.keys(capped).length });
  check(!capped['s1:c0'] && !!capped['s1:c' + (many - 1)], 'the oldest marks fall off the front');
  // A mark past the TTL is dropped on load.
  store.set('cf_chanunread_me', JSON.stringify({ 's1:old': { at: Date.now() - CHAN_UNREAD_TTL - 1000 }, 's1:fresh': { at: Date.now() } }));
  S.chanUnread = new Map();
  loadChanUnread();
  check(!hasChanUnread('s1', 'old') && hasChanUnread('s1', 'fresh'), 'a stale mark is forgotten, a fresh one kept');

  console.log('\n[4] the row repaints in place');
  store.clear();
  S.chanUnread = new Map();
  S.serverId = 's1';
  const row = fakeEl(); rows.set('cid:c1', row);
  const rail = fakeEl(); rows.set('sid:s1', rail);
  markChanUnread('s1', 'c1');
  check(row.classList.has('unread'), 'the open server\'s channel row gets .unread live');
  check(rail.classList.has('unread'), 'the server rail icon gets .unread live');
  rows.delete('cid:c1'); rows.delete('sid:s1');
  // A mark for a server we are not in updates no DOM (there is none).
  markChanUnread('s2', 'z9');
  check(hasChanUnread('s2', 'z9'), 'a background server is remembered');
  const row2 = fakeEl(); rows.set('cid:c2', row2);
  paintChanUnread('s1', 'c2');
  check(!row2.classList.has('unread'), 'a read row paints without the dot');

  console.log('\n[5] an open channel is read again when the tab returns');
  store.clear();
  S.chanUnread = new Map(); S.serverId = 's1'; S.channelId = 'c1'; S.view = 'server';
  markChanUnread('s1', 'c1'); // message arrived while the tab was hidden
  check(hasChanUnread('s1', 'c1'), 'hidden-tab message marks the open channel');
  clearActiveChanUnread();
  check(!hasChanUnread('s1', 'c1'), 'becoming visible clears the channel being read');
  markChanUnread('s1', 'c1');
  S.view = 'home';
  clearActiveChanUnread();
  check(hasChanUnread('s1', 'c1'), 'on Home nothing is cleared');

  console.log('\n[6] the real render/socket wiring');
  check(/const unread = hasChanUnread\(S\.serverId, c\.id\)/.test(servers), 'renderChannels reads the store');
  check(/unread \? ' unread' : ''/.test(servers), 'renderChannels adds the .unread class');
  check(/class="unread-dot"/.test(servers), 'renderChannels emits the dot slot (always present, so the name never jumps)');
  check(/serverHasUnread\(s\.id\) \? ' unread' : ''/.test(servers), 'serverBtn adds the rail dot class');
  check(/clearChanUnread\(S\.serverId, id\);\s*\/\/ it is in front of the reader now/.test(servers), 'selectChannel clears the channel it opens');
  check(/markChanUnread\(m\.serverId, m\.channelId\)/.test(socket) && /const viewing = m\.serverId === S\.serverId && m\.channelId === S\.channelId && !document\.hidden/.test(socket),
    'message-new marks only unviewed channels');
  check(/if \(m\.serverId !== S\.serverId\) break;/.test(socket.slice(socket.indexOf("case 'message-new'"), socket.indexOf("case 'message-new'") + 900)),
    'the unread mark runs before the active-server early-out');
  check(/chanUnread: new Map\(\)/.test(core), 'the store lives on S');
  check(/cf_chanunread_/.test(servers) && /loadChanUnread\(\)/.test(fs.readFileSync(path.join(ROOT, 'public/js/auth.js'), 'utf8')),
    'the store is loaded per account at boot');
  check(/visibilitychange/.test(fs.readFileSync(path.join(ROOT, 'public/js/final.js'), 'utf8')), 'returning to the tab re-reads the open channel');

  console.log('\n[7] the stylesheet draws both dots');
  const dot = /\.chan \.unread-dot\{([^}]*)\}/.exec(css);
  check(!!dot && /opacity:0/.test(dot[1]) && /background:var\(--text\)/.test(dot[1]), 'the channel dot is always laid out, hidden while read', dot && dot[1]);
  check(/\.chan\.unread \.unread-dot\{opacity:1\}/.test(css), 'an unread channel shows its dot');
  const label = /\.chan\.unread\{([^}]*)\}/.exec(css);
  check(!!label && /color:var\(--text\)/.test(label[1]) && /font-weight:650/.test(label[1]), 'an unread channel name is brighter and heavier', label && label[1]);
  check(/\.server-btn\.unread::after\{[^}]*border-radius:50%/.test(css), 'the rail icon carries an unread dot');
  check(/\.server-btn\.unread\.active::after\{display:none\}/.test(css), 'the active pill wins over the rail dot');
  check(/class="unread-dot" aria-hidden="true"/.test(servers), 'the dot is decorative (not announced)');
  check(index.includes('id="text-channels"'), 'text channels are the surface the dots attach to');

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
})();
