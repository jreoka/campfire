// Unread channel dots + the rail's unread badges (see AGENTS.md verification
// conventions).
//
// A text channel that gets a message while you are not looking at it earns a
// small dot on the left plus a brighter, heavier name. The server's rail icon
// carries the count of those channels in a red corner badge, and a collapsed
// folder carries the sum for the servers inside it — opening the folder hands
// each number back to the servers themselves (the CSS hides the folder's pill
// while it is open). A server (or a folder) can be cleared in one go from its
// right-click / long-press menu, which drops the marks it owns.
//
// The memory is per account in localStorage, so it survives a reload, and the
// live message push arrives for every joined server, so the marks land even
// from a server you are not in.
//
// Offline (no database, no browser): the real helpers are sliced out of
// public/js/servers.js and run against a tiny fake DOM + localStorage. The
// render/menu/socket wiring and the stylesheet are checked statically.
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
const actions = fs.readFileSync(path.join(ROOT, 'public/js/actions.js'), 'utf8');
const rail = fs.readFileSync(path.join(ROOT, 'public/js/rail.js'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const auth = fs.readFileSync(path.join(ROOT, 'public/js/auth.js'), 'utf8');
const final = fs.readFileSync(path.join(ROOT, 'public/js/final.js'), 'utf8');

// ---------- fake DOM + storage so the real helpers can run ----------
// One element per data id, so the helpers' selectors ('#server-list
// .server-btn[data-sid="s1"]', '.folder-btn[data-fid="f1"]',
// '#text-channels .chan[data-cid="c1"]') resolve the way they do in the app.
const els = new Map(); // 'sid:s1' | 'fid:f1' | 'cid:c1' -> fake element
function fakeEl() {
  const set = new Set();
  return {
    dataset: {},
    title: '',
    classList: {
      toggle: (c, on) => { const want = on === undefined ? !set.has(c) : !!on; if (want) set.add(c); else set.delete(c); },
      has: (c) => set.has(c),
      _set: set,
    },
  };
}
function keyFor(sel) {
  const m = /\[data-(sid|fid|cid)="([^"]+)"\]/.exec(sel);
  return m ? m[1] + ':' + m[2] : null;
}
const fakeDocument = {
  querySelector: (sel) => { const k = keyFor(sel); return k ? (els.get(k) || null) : null; },
  querySelectorAll: (sel) => { const k = keyFor(sel); const el = k ? els.get(k) : null; return el ? [el] : []; },
};
const store = new Map();
const fakeStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const MS = {
  me: { id: 'me' }, serverId: 's1', channelId: null, view: 'server',
  chanUnread: new Map(),
  servers: [{ id: 's1', name: 'Alpha' }, { id: 's2', name: 'Beta' }, { id: 's3', name: 'Gamma' }],
  serverDetail: null,
  layoutFolders: [],
};
let serverListPaints = 0, channelPaints = 0;
// The app's "repaint the rail" is renderServerList() rebuilding every button
// through serverBtn/folderBtn. Model that: repaint the registered fake buttons
// from the live marks, so a badge that should come off actually comes off.
const railRepaint = { fn: null };
const renderServerList = () => { serverListPaints++; if (railRepaint.fn) railRepaint.fn(); };
const folderById = (fid) => MS.layoutFolders.find((f) => f.id === fid);
const serverFolder = (sid) => MS.layoutFolders.find((f) => (f.servers || []).includes(sid));
const folderOpen = (fid) => MS.layoutFolders.find((f) => f.id === fid);

const code = slice(servers, '// ---------- unread channels ----------', 'function renderChannels() {');
// Built with new Function so the fakes are the ONLY bindings in scope (a bare
// eval would let this file's own names shadow them — see test-dm-unread.js).
const build = new Function('S', 'localStorage', 'document', 'CSS', 'renderServerList', 'renderChannels', 'folderById', 'serverFolder',
  code + `
return { loadChanUnread, saveChanUnread, markChanUnread, clearChanUnread, hasChanUnread, serverHasUnread,
  serverUnreadCount, folderUnreadCount, paintChanUnread, paintServerUnread, paintServerBadge, paintFolderBadge,
  paintFolderUnread, clearActiveChanUnread, clearChanUnreadMatching, markServerRead, markFolderRead,
  chanUnreadCtx, CHAN_UNREAD_MAX, CHAN_UNREAD_TTL };`);
const api = build(MS, fakeStorage, fakeDocument, { escape: (s) => String(s).replace(/["\\]/g, '\\$&') },
  renderServerList, () => { channelPaints++; }, folderById, serverFolder);
const {
  loadChanUnread, markChanUnread, clearChanUnread, hasChanUnread, serverHasUnread, serverUnreadCount,
  folderUnreadCount, paintChanUnread, paintServerUnread, paintServerBadge, paintFolderBadge, clearActiveChanUnread,
  markServerRead, markFolderRead, CHAN_UNREAD_MAX, CHAN_UNREAD_TTL,
} = api;
railRepaint.fn = () => {
  for (const [k, el] of els) {
    if (k.startsWith('sid:')) {
      const s = MS.servers.find((x) => x.id === k.slice(4));
      if (s) paintServerBadge(el, s);
    } else if (k.startsWith('fid:')) {
      const f = folderById(k.slice(4));
      if (f) paintFolderBadge(el, f);
    }
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function resetStorage() {
  store.clear();
  MS.chanUnread = new Map();
  els.clear();
  MS.layoutFolders = [];
  MS.openFolderId = null;
  MS.serverDetail = { channels: [] }; // so the mark-all-read repaint also reaches the channel list
  serverListPaints = 0; channelPaints = 0;
}

(async () => {
  console.log('\n[1] mark / clear / reload');
  resetStorage();
  loadChanUnread();
  check(!hasChanUnread('s1', 'c1'), 'a fresh account has nothing unread');
  markChanUnread('s1', 'c1');
  check(hasChanUnread('s1', 'c1'), 'a background message marks its channel');
  check(serverHasUnread('s1') && !serverHasUnread('s2'), 'the server knows one of its channels is unread');
  check(serverUnreadCount('s1') === 1 && serverUnreadCount('s2') === 0, 'the count is the number of unread channels');
  markChanUnread('s1', 'c2');
  check(serverUnreadCount('s1') === 2, 'and it counts up per channel', serverUnreadCount('s1'));
  await sleep(500); // saveChanUnread is debounced
  const persisted = JSON.parse(store.get('cf_chanunread_me') || '{}');
  check(!!persisted['s1:c1'], 'the mark is persisted per account', persisted);
  // Reload from storage (a page refresh).
  MS.chanUnread = new Map();
  loadChanUnread();
  check(hasChanUnread('s1', 'c1'), 'a reload restores the unread dot');
  check(serverUnreadCount('s1') === 2, 'and the badge number comes back with it');
  clearChanUnread('s1', 'c1');
  check(!hasChanUnread('s1', 'c1'), 'opening the channel clears it');
  check(serverUnreadCount('s1') === 1, 'the count follows', serverUnreadCount('s1'));
  await sleep(500);
  check(!JSON.parse(store.get('cf_chanunread_me') || '{}')['s1:c1'], 'the cleared mark is persisted too');

  console.log('\n[2] per-account isolation');
  resetStorage();
  markChanUnread('s1', 'c1');
  await sleep(500);
  MS.me = { id: 'other' }; MS.chanUnread = new Map();
  loadChanUnread();
  check(!hasChanUnread('s1', 'c1'), 'another account does not inherit the dot');
  check(!!store.get('cf_chanunread_me') && !store.get('cf_chanunread_other'), 'the stores are keyed by account');
  MS.me = { id: 'me' };
  MS.chanUnread = new Map(); loadChanUnread();
  check(hasChanUnread('s1', 'c1'), 'the original account still has its dot');

  console.log('\n[3] the store stays bounded and forgets old marks');
  resetStorage();
  const many = CHAN_UNREAD_MAX + 25;
  for (let i = 0; i < many; i++) markChanUnread('s1', 'c' + i);
  check(MS.chanUnread.size === many, 'every mark is live in the map');
  await sleep(500);
  const capped = JSON.parse(store.get('cf_chanunread_me') || '{}');
  check(Object.keys(capped).length === CHAN_UNREAD_MAX, 'only the newest ' + CHAN_UNREAD_MAX + ' are persisted', { n: Object.keys(capped).length });
  check(!capped['s1:c0'] && !!capped['s1:c' + (many - 1)], 'the oldest marks fall off the front');
  // A mark past the TTL is dropped on load.
  store.set('cf_chanunread_me', JSON.stringify({ 's1:old': { at: Date.now() - CHAN_UNREAD_TTL - 1000 }, 's1:fresh': { at: Date.now() } }));
  MS.chanUnread = new Map();
  loadChanUnread();
  check(!hasChanUnread('s1', 'old') && hasChanUnread('s1', 'fresh'), 'a stale mark is forgotten, a fresh one kept');

  console.log('\n[4] the server badge is a red count in the corner');
  resetStorage();
  const s1btn = fakeEl(); els.set('sid:s1', s1btn);
  const c1row = fakeEl(); els.set('cid:c1', c1row);
  markChanUnread('s1', 'c1');
  check(s1btn.classList.has('unread'), 'the rail icon is marked unread');
  check(s1btn.dataset.unread === '1', 'and carries the number in data-unread (the CSS renders it)', s1btn.dataset.unread);
  check(/1 unread/.test(s1btn.title), 'the tooltip says how many', s1btn.title);
  check(c1row.classList.has('unread'), 'the channel row gets its dot live');
  markChanUnread('s1', 'c2');
  check(s1btn.dataset.unread === '2', 'a second unread channel counts up', s1btn.dataset.unread);
  markChanUnread('s1', 'c3');
  check(s1btn.dataset.unread === '3', 'and a third', s1btn.dataset.unread);
  clearChanUnread('s1', 'c2');
  check(s1btn.dataset.unread === '2', 'reading one drops the number', s1btn.dataset.unread);
  for (const ctx of ['s1:c1', 's1:c3']) MS.chanUnread.delete(ctx);
  paintServerUnread('s1');
  check(!s1btn.classList.has('unread') && s1btn.dataset.unread === undefined,
    'with nothing unread the badge is gone, not a zero', { cls: s1btn.classList.has('unread'), d: s1btn.dataset.unread });
  // A crowd of unread channels still fits a two-character badge.
  for (let i = 0; i < 120; i++) MS.chanUnread.set('s1:c' + i, 1);
  paintServerUnread('s1');
  check(s1btn.dataset.unread === '99+', 'the number caps at 99+', s1btn.dataset.unread);

  console.log('\n[5] a collapsed folder carries its servers\' counts');
  resetStorage();
  MS.layoutFolders = [{ id: 'f1', name: 'Games', servers: ['s2', 's3'] }];
  const fbtn = fakeEl(); els.set('fid:f1', fbtn);
  const s2btn = fakeEl(); els.set('sid:s2', s2btn); // present only while the folder is open
  markChanUnread('s2', 'c1');
  check(fbtn.dataset.unread === '1', 'a server in the folder lifts the folder badge', fbtn.dataset.unread);
  check(fbtn.classList.has('unread'), 'and marks the folder unread');
  check(s2btn.dataset.unread === '1', 'the server button itself is marked too (it shows once open)');
  markChanUnread('s2', 'c2');
  markChanUnread('s3', 'c9');
  check(fbtn.dataset.unread === '3', 'the folder sums its servers', fbtn.dataset.unread);
  check(folderUnreadCount(folderOpen('f1')) === 3, 'folderUnreadCount agrees', folderUnreadCount(folderOpen('f1')));
  markChanUnread('s1', 'zz');
  check(fbtn.dataset.unread === '3', 'a server outside the folder does not count towards it', fbtn.dataset.unread);
  clearChanUnread('s3', 'c9');
  check(fbtn.dataset.unread === '2', 'reading one inside drops the folder number', fbtn.dataset.unread);
  // Opening the folder is a class on the button; the CSS hands the numbers over.
  fbtn.classList.toggle('open', true);
  check(/\.folder-btn\.open\.unread\[data-unread\]::after\{display:none\}/.test(css),
    'the open folder hides its pill (the servers inside show their own)');
  check(/paintServerBadge\(b, s\)/.test(servers) && /folderOpenBox/.test(servers),
    'the servers inside an open folder are built through the same badge painter');
  // Retracting without reading restores it — the number was never thrown away.
  check(fbtn.dataset.unread === '2' && folderUnreadCount(folderOpen('f1')) === 2, 'so retracting brings it straight back');

  console.log('\n[6] mark all as read, per server and per folder');
  resetStorage();
  MS.layoutFolders = [{ id: 'f1', name: 'Games', servers: ['s2', 's3'] }];
  const b1 = fakeEl(); els.set('sid:s1', b1);
  const fb = fakeEl(); els.set('fid:f1', fb);
  markChanUnread('s1', 'c1');
  markChanUnread('s1', 'c2');
  markChanUnread('s2', 'c1');
  markChanUnread('s3', 'c1');
  check(serverUnreadCount('s1') === 2 && folderUnreadCount(folderOpen('f1')) === 2, 'marks are spread across a server and a folder');
  serverListPaints = 0; channelPaints = 0;
  check(markServerRead('s1') === true, 'marking the server read reports that it did something');
  check(serverUnreadCount('s1') === 0, 'every channel of that server is cleared');
  check(hasChanUnread('s2', 'c1') && hasChanUnread('s3', 'c1'), 'and nothing else was touched');
  check(serverListPaints === 1 && channelPaints === 1, 'the rail and the open channel list repaint', { serverListPaints, channelPaints });
  check(!b1.classList.has('unread') && b1.dataset.unread === undefined, 'the server badge comes off');
  check(fb.dataset.unread === '2', 'the folder keeps the count for its other servers', fb.dataset.unread);
  await sleep(500);
  const saved = JSON.parse(store.get('cf_chanunread_me') || '{}');
  check(!Object.keys(saved).some((k) => k.startsWith('s1:')), 'the cleared marks are persisted', Object.keys(saved));
  check(markServerRead('s1') === false, 'marking an already-read server changes nothing');
  check(markFolderRead('nope') === false, 'a folder that does not exist changes nothing');
  serverListPaints = 0;
  check(markFolderRead('f1') === true, 'marking the folder read reports that it did something');
  check(folderUnreadCount(folderOpen('f1')) === 0 && !hasChanUnread('s2', 'c1') && !hasChanUnread('s3', 'c1'),
    'every server in the folder is cleared');
  check(fb.dataset.unread === undefined && !fb.classList.has('unread'), 'the folder badge comes off');
  check(serverListPaints === 1, 'and everything repaints once');

  console.log('\n[7] an open channel is read again when the tab returns');
  resetStorage();
  MS.serverId = 's1'; MS.channelId = 'c1'; MS.view = 'server';
  markChanUnread('s1', 'c1'); // message arrived while the tab was hidden
  check(hasChanUnread('s1', 'c1'), 'hidden-tab message marks the open channel');
  clearActiveChanUnread();
  check(!hasChanUnread('s1', 'c1'), 'becoming visible clears the channel being read');
  markChanUnread('s1', 'c1');
  MS.view = 'home';
  clearActiveChanUnread();
  check(hasChanUnread('s1', 'c1'), 'on Home nothing is cleared');

  console.log('\n[8] the real render / menu / socket wiring');
  check(/const unread = hasChanUnread\(S\.serverId, c\.id\)/.test(servers), 'renderChannels reads the store');
  check(/unread \? ' unread' : ''/.test(servers), 'renderChannels adds the .unread class');
  check(/class="unread-dot"/.test(servers), 'renderChannels emits the dot slot (always present, so the name never jumps)');
  check(/paintServerBadge\(b, s\)/.test(servers), 'serverBtn paints the badge through the shared helper');
  check(!/serverHasUnread\(s\.id\) \? ' unread' : ''/.test(servers), 'and no longer inlines the old class');
  check(/paintFolderBadge\(b, f\)/.test(servers), 'folderBtn paints its own badge');
  check(/const f = serverFolder\(serverId\);\s*if \(f\) paintFolderUnread\(f\.id\);/.test(servers),
    'a live mark on a server inside a closed folder updates the folder');
  check(/for \(const btn of document\.querySelectorAll\(/.test(servers), 'paintServerUnread updates every copy of the button');
  check(/function repaintUnreadSurfaces\(\)/.test(servers) && /renderServerList\(\);\s*\/\/ rail badges/.test(servers),
    'mark-all-read repaints the rail (and the channel dots)');
  // The same action on both surfaces, gated so it only shows when useful.
  check(/serverUnreadCount\(sid\) \? \[\{ label: 'Mark all as read'/.test(actions), 'the server menu offers Mark all as read while unread');
  check(/folderUnreadCount\(f\) \? \[\{ label: 'Mark all as read'/.test(actions), 'the folder sheet does too');
  check(/folderUnreadCount\(f\)[\s\S]{0,240}?mr\.textContent = 'Mark all as read'/.test(rail),
    'and the folder\'s desktop flyout carries the same row');
  check(/markServerRead\(sid\)/.test(actions) && /markFolderRead\(fid\)/.test(actions), 'both go through the shared clearers');
  check(/clearChanUnread\(S\.serverId, id\);\s*\/\/ it is in front of the reader now/.test(servers), 'selectChannel clears the channel it opens');
  check(/markChanUnread\(m\.serverId, m\.channelId\)/.test(socket) && /const viewing = m\.serverId === S\.serverId && m\.channelId === S\.channelId && !document\.hidden/.test(socket),
    'message-new marks only unviewed channels');
  check(/if \(m\.serverId !== S\.serverId\) break;/.test(socket.slice(socket.indexOf("case 'message-new'"), socket.indexOf("case 'message-new'") + 900)),
    'the unread mark runs before the active-server early-out');
  check(/chanUnread: new Map\(\)/.test(core), 'the store lives on S');
  check(/cf_chanunread_/.test(servers) && /loadChanUnread\(\)/.test(auth), 'the store is loaded per account at boot');
  check(/clearActiveChanUnread/.test(final) && /visibilitychange/.test(final), 'returning to the tab re-reads the open channel');

  console.log('\n[9] the stylesheet draws the dots and the badges');
  const dot = /\.chan \.unread-dot\{([^}]*)\}/.exec(css);
  check(!!dot && /opacity:0/.test(dot[1]) && /background:var\(--text\)/.test(dot[1]), 'the channel dot is always laid out, hidden while read', dot && dot[1]);
  check(/\.chan\.unread \.unread-dot\{opacity:1\}/.test(css), 'an unread channel shows its dot');
  const label = /\.chan\.unread\{([^}]*)\}/.exec(css);
  check(!!label && /color:var\(--text\)/.test(label[1]) && /font-weight:650/.test(label[1]), 'an unread channel name is brighter and heavier', label && label[1]);
  const badge = /\.server-btn\.unread\[data-unread\]::after,\.folder-btn\.unread\[data-unread\]::after\{([^}]*)\}/.exec(css);
  check(!!badge && /content:attr\(data-unread\)/.test(badge[1]), 'the badge renders the count from the data attribute', badge && badge[1]);
  check(!!badge && /background:var\(--red\)/.test(badge[1]) && /border-radius:999px/.test(badge[1]), 'in a red pill', badge && badge[1]);
  check(!!badge && /right:-4px/.test(badge[1]) && /bottom:-4px/.test(badge[1]), 'pinned to the icon\'s corner', badge && badge[1]);
  check(!/\.server-btn\.unread::after\{/.test(css), 'the old white edge dot is gone');
  check(!/\.server-btn\.unread\.active::after\{display:none\}/.test(css),
    'and the active server keeps its count (another channel can still be unread)');
  check(/class="unread-dot" aria-hidden="true"/.test(servers), 'the channel dot is decorative (not announced)');
  check(index.includes('id="server-list"'), 'the rail is the surface the badges attach to');

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
})();
