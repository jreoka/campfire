'use strict';
/* ================= stories: 24-hour photo/video posts =================
   A story is a photo (or a video shot in-app or picked from the gallery)
   that friends — or everyone in one server — can watch for 24 hours.

   Surfaces:
     - #story-rail   the strip at the top of the Friends page (Home)
     - #srv-stories  a row in the server sidebar, shown while that server
                     has live stories from other members
     - friend rows   get a ring around the avatar when they've posted
     - #story-view   full-screen viewer (tap zones, progress bars, reply)
     - #story-compose camera + gallery composer
   Media uploads ride the normal /api/upload pipeline, so scanning and
   compression come for free; the server reaps expired items and bytes. */

const STORY_IMG_MS = 5000;        // how long a photo shows before advancing
const STORY_VIDEO_MAX_MS = 60000; // recording cap (matches the server hint)
const STORY_MAX_EDGE = 1920;      // picked photos are downscaled to this long edge
// Camera grabs are capped lower on touch devices: a 1920px frame is 2.25x the
// pixels of a 1280px one. (The old multi-second shutter lag was never the
// readback — see storyShowPendingShot: Android encodes canvas.toBlob on the
// main thread during idle time, so the shutter no longer waits for it.)
const storyCamMaxEdge = () => (isCoarse() ? 1280 : STORY_MAX_EDGE);

// Icon set (inline SVG, no emoji — see the design language in AGENTS.md).
const svSvg = {
  plus: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  globe: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>',
  users: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  check: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  camera: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-2.5h6L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.2"/></svg>',
  soundOn: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z" fill="currentColor" stroke="none"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
  soundOff: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z" fill="currentColor" stroke="none"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5"/></svg>',
  mic: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3"/></svg>',
  micOff: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9V5a3 3 0 0 1 6 0v6"/><path d="M5 10a7 7 0 0 0 10.5 6.1M12 19v3"/><path d="M4 4l16 16"/></svg>',
};

let storyData = { mine: null, friends: [], everyone: [], servers: [] };
let storyFetch = null;
let storyRefreshT = null;

function storyLive(items) {
  const t = Date.now();
  return (items || []).filter((s) => s && s.expires_at > t);
}
// A tray is a person: their friend-audience and everyone-audience stories are
// merged so the rail stays people-based (one tile per person) no matter which
// audience each item used.
function storyUserTrays() {
  const by = new Map();
  const add = (list, friend) => {
    for (const t of list || []) {
      const items = storyLive(t.items);
      if (!items.length || !t.user) continue;
      let e = by.get(t.user.id);
      if (!e) { e = { id: t.user.id, user: t.user, items: [], unseen: 0, latest: 0, friend: false }; by.set(t.user.id, e); }
      if (friend) e.friend = true;
      const seenIds = new Set(e.items.map((i) => i.id));
      for (const it of items) if (!seenIds.has(it.id)) e.items.push(it);
    }
  };
  add(storyData.friends, true);
  add(storyData.everyone, false);
  for (const e of by.values()) {
    e.items.sort((a, b) => a.created_at - b.created_at);
    e.unseen = e.items.filter((i) => !i.seen).length;
    e.latest = e.items.reduce((m, i) => Math.max(m, i.created_at), 0);
  }
  // People first, then public-only authors; unseen first, newest within each.
  return [...by.values()].sort((a, b) => (b.friend - a.friend) || (b.unseen - a.unseen) || (b.latest - a.latest));
}
function storyTrayFor(userId) { return storyUserTrays().find((t) => t.id === userId) || null; }
function storyServerTray(serverId) { return (storyData.servers || []).find((t) => t.server && t.server.id === serverId) || null; }
// A server tray's unseen count, computed from its items (never the server's
// cached number): marking a story seen in the viewer clears the badge right
// away, and my own posts never count — I can't watch my own story, so they
// would otherwise leave a dot on Home and a "1 new" in the server forever.
function serverTrayUnseen(t) {
  return storyLive(t && t.items).filter((i) => !i.seen && !(i.author && S.me && i.author.id === S.me.id)).length;
}
// Home counts people and stories, not trays (drives the Stories row label and
// the unseen badge/dot). One story is delivered in several trays — a
// friends/everyone tray per person plus a tray per server it was posted to —
// so one account posting once to friends *and* to a server we share would
// otherwise read as "2 people with stories" / "2 new". My own posts count as a
// person (the row's avatar is usually mine) but never as unseen.
function storyHomeCounts() {
  const byStory = new Map();
  const add = (list) => {
    for (const t of list || []) for (const it of storyLive(t.items)) byStory.set(it.id, it);
  };
  add(storyUserTrays());
  add(storyData.servers);
  const people = new Set();
  let unseen = 0;
  for (const it of byStory.values()) {
    const uid = it.author && it.author.id;
    if (uid) people.add(uid);
    if (!it.seen && (!S.me || uid !== S.me.id)) unseen++;
  }
  return { people: people.size, unseen };
}
function storyAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

// ---------- data ----------
async function loadStories() {
  if (storyFetch) return storyFetch;
  storyFetch = api('/api/stories')
    .then((d) => {
      storyData = { mine: d.mine || null, friends: d.friends || [], everyone: d.everyone || [], servers: d.servers || [] };
      return storyData;
    })
    .catch(() => storyData)
    .finally(() => { storyFetch = null; });
  return storyFetch;
}
// Coalesce bursts (several friends posting at once, view receipts, …).
function scheduleStoryRefresh(ms = 600) {
  clearTimeout(storyRefreshT);
  storyRefreshT = setTimeout(async () => {
    await loadStories();
    renderStorySurfaces();
    if (sv) svSyncState();
  }, ms);
}
function renderStorySurfaces() {
  try { renderStoryRail(); } catch {}
  try { renderServerStories(); } catch {}
  try { renderHomeStories(); } catch {}
  try { paintStoryRingsEverywhere(); } catch {}
}
// Rings live on rows that other code rebuilds, so story changes repaint them
// (friend list, server member list, DM list) without a full view refresh.
function paintStoryRingsEverywhere() {
  renderFriendStoryRings();
  try { if (S.view === 'server') renderMembers(); } catch {}
  try { if (S.dms && S.dms.length) renderDmLists(); } catch {}
}

// ---------- shared bits ----------
// The ring shows a thumbnail of the story itself, cropped into the circle
// behind the person's avatar ("cookie-cutter" style): the avatar is the
// fallback if the media can't render.
function storyThumbItem(items) {
  const live = storyLive(items);
  if (!live.length) return null;
  const unseen = live.filter((i) => !i.seen);
  const pool = unseen.length ? unseen : live;
  return pool[pool.length - 1];
}
function storyThumbEl(it, cls) {
  if (!it) return null;
  let el;
  if (it.kind === 'video') {
    el = document.createElement('video');
    el.muted = true;
    el.defaultMuted = true;
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.preload = 'metadata';
    el.onerror = () => { try { el.remove(); } catch {} };
    el.onloadeddata = () => { try { el.currentTime = 0.06; } catch {} };
    el.src = it.url;
  } else {
    el = document.createElement('img');
    el.alt = '';
    el.loading = 'lazy';
    el.decoding = 'async';
    el.onerror = () => { try { el.remove(); } catch {} };
    el.src = it.url;
  }
  el.className = (cls || 'st-thumb');
  return el;
}
function storyRing(user, unseen, items) {
  const ring = document.createElement('span');
  ring.className = 'st-ring' + (unseen ? '' : ' seen');
  const av = document.createElement('span');
  av.className = 'avatar';
  paintAvatar(av, user || { display_name: '?' });
  ring.appendChild(av);
  const thumb = storyThumbEl(storyThumbItem(items));
  if (thumb) ring.appendChild(thumb);
  return ring;
}
function storyTile(user, label, unseen, onClick, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'st-tile';
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'button');
  wrap.title = opts.title || label;
  const ring = storyRing(user, unseen, opts.items);
  wrap.appendChild(ring);
  if (opts.plus) {
    // A real button so "post another" stays reachable once you have a live
    // story (tapping the tile itself then opens the viewer).
    const p = document.createElement('button');
    p.type = 'button';
    p.className = 'st-plus';
    p.title = label === 'Add story' ? 'Add to your story' : 'Add another';
    p.setAttribute('aria-label', p.title);
    p.innerHTML = svSvg.plus;
    p.onclick = (e) => { e.stopPropagation(); (opts.onPlus || onClick)(); };
    ring.appendChild(p);
  }
  const n = document.createElement('span');
  n.className = 'st-name';
  n.textContent = label;
  wrap.appendChild(n);
  wrap.onclick = (e) => { if (e.target.closest('.st-plus')) return; onClick(); };
  wrap.onkeydown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    const plus = e.target.closest('.st-plus');
    if (plus) (opts.onPlus || onClick)();
    else onClick();
  };
  return wrap;
}

// ---------- rail (Friends page) ----------
function renderStoryRail() {
  const box = $('#story-rail');
  if (!box || !S.me) return;
  const mineItems = storyLive(storyData.mine && storyData.mine.items);
  box.innerHTML = '';
  box.appendChild(storyTile(S.me, mineItems.length ? 'Your story' : 'Add story', false, () => {
    if (mineItems.length) openStoryViewer({ kind: 'mine' });
    else openStoryComposer({});
  }, { plus: true, onPlus: () => openStoryComposer({}), items: mineItems }));
  for (const t of storyUserTrays()) {
    box.appendChild(storyTile(t.user, t.user.display_name, t.unseen > 0, () => openStoryViewer({ kind: 'user', userId: t.id }), { items: t.items }));
  }
  box.classList.remove('hidden');
}

// ---------- server sidebar row + Home sidebar entry ----------
function storyStackHTML(users) {
  const stack = document.createElement('span');
  stack.className = 'ss-stack';
  for (const u of users.slice(0, 3)) {
    const a = document.createElement('span');
    a.className = 'avatar';
    paintAvatar(a, u);
    stack.appendChild(a);
  }
  return stack;
}
// The server row's trailing chip — the ambiguity trap.
// It used to print a bare grey number of the server's authors once everything
// was watched, so "1" read as "1 unread" and people went hunting for a story
// that did not exist (worst of all when the only live post was their own, which
// they cannot watch). Only two states are honest: an accent "N new" while
// something is waiting, and a muted "Seen" once the reader has watched it all.
// Nothing to watch from anyone else (no stories, or mine only) → no chip; the
// label and the avatar stack already carry that.
function serverStoryChip(unseen, otherAuthors) {
  if (unseen > 0) return { text: unseen + ' new', seen: false };
  if (otherAuthors > 0) return { text: 'Seen', seen: true };
  return null;
}
function renderServerStories() {
  const box = $('#srv-stories');
  if (!box) return;
  if (!S.serverId || !S.serverDetail) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const tray = storyServerTray(S.serverId);
  const items = tray ? storyLive(tray.items) : [];
  const unseen = tray ? serverTrayUnseen(tray) : 0;
  const others = items.filter((i) => i.author && i.author.id !== S.me.id);
  box.classList.remove('hidden');
  box.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'srv-stories' + (items.length ? '' : ' srv-stories-empty');
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  row.title = items.length ? 'Watch stories from this server' : 'Post the first story in this server';
  const users = [];
  const seen = new Set();
  for (const it of items) {
    const u = it.author;
    if (!u || seen.has(u.id)) continue;
    seen.add(u.id);
    users.push(u);
  }
  if (users.length) row.appendChild(storyStackHTML(users));
  else {
    const ic = document.createElement('span');
    ic.className = 'ss-ic';
    ic.innerHTML = svSvg.camera;
    row.appendChild(ic);
  }
  const lab = document.createElement('span');
  lab.className = 'ss-label';
  lab.textContent = 'Stories';
  row.appendChild(lab);
  if (!items.length) {
    const hint = document.createElement('span');
    hint.className = 'ss-hint';
    hint.textContent = 'Be the first';
    row.appendChild(hint);
  } else {
    const chip = serverStoryChip(unseen, others.length);
    if (chip) {
      const n = document.createElement('span');
      n.className = 'ss-count' + (chip.seen ? ' seen' : '');
      n.textContent = chip.text;
      row.appendChild(n);
    }
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'ss-add';
  add.title = 'Post to this server\'s stories';
  add.setAttribute('aria-label', add.title);
  add.innerHTML = svSvg.plus;
  add.onclick = (e) => { e.stopPropagation(); openStoryComposer({ serverId: S.serverId }); };
  row.appendChild(add);
  const open = () => openStoriesSheet({ serverId: S.serverId, name: S.serverDetail.name });
  row.onclick = open;
  row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  box.appendChild(row);
}
// Home sidebar: a Stories entry (with an unseen badge) that opens the sheet.
function renderHomeStories() {
  const btn = $('#btn-stories');
  if (!btn) return;
  const trays = storyUserTrays();
  const srvTrays = (storyData.servers || []).filter((t) => storyLive(t.items).length);
  const { people: n, unseen } = storyHomeCounts();
  const av = $('#stories-nav-av');
  if (av) {
    av.innerHTML = '';
    const first = trays[0] || srvTrays[0];
    if (first && first.user) paintAvatar(av, first.user);
    else if (first && first.items && first.items[0] && first.items[0].author) paintAvatar(av, first.items[0].author);
    else {
      av.textContent = '';
      av.style.background = 'var(--panel-3)';
      av.innerHTML = svSvg.camera;
    }
    av.classList.add('avatar');
    av.style.width = '28px';
    av.style.height = '28px';
  }
  const badge = $('#stories-nav-count');
  if (badge) { badge.textContent = unseen > 99 ? '99+' : String(unseen); badge.classList.toggle('hidden', !unseen); }
  // Home rail dot: "someone you can watch posted" even while inside a server.
  const homeDot = $('#home-story-dot');
  if (homeDot) homeDot.classList.toggle('hidden', !unseen);
  const sub = $('#stories-nav-sub');
  if (sub) {
    sub.textContent = unseen ? `${unseen} new from ${n} ${n === 1 ? 'person' : 'people'}`
      : (n ? `${n} ${n === 1 ? 'person' : 'people'} with stories` : 'No stories yet — be the first');
  }
}

// ---------- rings on other people's rows ----------
// One helper for every roster surface: accent ring when unread, hairline when
// read, and a tap on the avatar opens that person's tray.
function paintRowStoryRing(row, user, avatarSel) {
  if (!row || !user || !user.id) return false;
  if (S.me && user.id === S.me.id) return false;
  const tray = storyTrayFor(user.id);
  const items = tray ? storyLive(tray.items) : [];
  if (!items.length) return false;
  const unseen = items.some((i) => !i.seen);
  const av = row.querySelector(avatarSel || '.avatar');
  if (av) av.style.boxShadow = '0 0 0 2px ' + (unseen ? 'var(--accent)' : 'var(--line)');
  const wrap = row.querySelector('.avwrap') || av;
  if (wrap) {
    // The thumbnail goes INSIDE the avatar element: .avatar{overflow:hidden}
    // clips it to the same circle, so its antialiased edge never blends with
    // the person's avatar color at the rim.
    try {
      const host = av || wrap;
      const prev = row.querySelector('.st-thumb-inline');
      if (prev) prev.remove();
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      const thumb = storyThumbEl(storyThumbItem(items), 'st-thumb-inline');
      if (thumb) host.appendChild(thumb);
    } catch {}
    wrap.classList.add('st-clickable');
    wrap.title = `Watch ${user.display_name || user.username || 'their'} story`;
    wrap.onclick = (e) => { e.stopPropagation(); openStoryViewer({ kind: 'user', userId: user.id }); };
  }
  return true;
}
// ---------- friend-list rings ----------
function paintFriendStoryRing(row, u) { paintRowStoryRing(row, u); }
function paintDMStoryRing(row, peer) { paintRowStoryRing(row, peer); }
function paintMemberStoryRing(row, m) { paintRowStoryRing(row, m); }
// ---------- user card / profile ----------
// The card's picture IS the story affordance: the ring + cropped thumb already
// say "there is a story here", so clicking the avatar opens it (and a stale
// "Watch story" button next to the action tabs is gone). Keyboard-reachable too.
function paintUserCardStory(card, u) {
  if (!card || !u || !S.me || u.id === S.me.id) return;
  const tray = storyTrayFor(u.id);
  const items = tray ? storyLive(tray.items) : [];
  if (!items.length) return;
  const unseen = items.some((i) => !i.seen);
  const av = card.querySelector('.uc-head .avatar');
  if (!av) return;
  av.style.boxShadow = '0 0 0 2.5px ' + (unseen ? 'var(--accent)' : 'var(--line)');
  try {
    if (getComputedStyle(av).position === 'static') av.style.position = 'relative';
    const prev = av.querySelector('.st-thumb-inline');
    if (prev) prev.remove();
    const thumb = storyThumbEl(storyThumbItem(items), 'st-thumb-inline');
    if (thumb) av.appendChild(thumb);
  } catch {}
  av.classList.add('st-click');
  av.setAttribute('role', 'button');
  av.setAttribute('tabindex', '0');
  const label = unseen ? 'Watch story' : 'Watch story (seen)';
  av.title = label;
  av.setAttribute('aria-label', label);
  const open = () => { try { closeUserCard(); } catch {} openStoryViewer({ kind: 'user', userId: u.id }); };
  av.onclick = open;
  av.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  };
}
// Same affordance inside the full profile screen.
function paintProfileStory(u) {
  const host = $('#pf-story');
  if (!host || !u || !S.me || u.id === S.me.id) { if (host) host.innerHTML = ''; return; }
  const tray = storyTrayFor(u.id);
  const items = tray ? storyLive(tray.items) : [];
  host.innerHTML = '';
  if (!items.length) return;
  const unseen = items.some((i) => !i.seen);
  const av = $('#pf-avatar');
  if (av) av.style.boxShadow = '0 0 0 3px ' + (unseen ? 'var(--accent)' : 'var(--line)');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn small' + (unseen ? ' primary' : '');
  b.textContent = unseen ? 'Watch story' : 'Watch story (seen)';
  b.onclick = () => { try { closeProfileScreen(); } catch {} openStoryViewer({ kind: 'user', userId: u.id }); };
  host.appendChild(b);
}
function renderFriendStoryRings() {
  const list = $('#friend-list');
  if (!list) return;
  for (const row of list.querySelectorAll('.dmrow[data-uid]')) {
    paintFriendStoryRing(row, { id: row.dataset.uid, display_name: row.dataset.uname || '' });
  }
}

// ================= stories sheet (the "stories area") =================
// scope: 'home' (friends + everyone) or { serverId, name }.
function storySheetRow(user, items, unseen, onClick) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'story-row';
  const ring = storyRing(user, unseen > 0, items);
  ring.style.width = ring.style.height = '44px';
  row.appendChild(ring);
  const main = document.createElement('span');
  main.className = 'story-row-main';
  const name = document.createElement('span');
  name.className = 'story-row-name';
  name.style.cssText = nameStyleFor(user);
  name.textContent = user.display_name || user.username || 'User';
  main.appendChild(name);
  const sub = document.createElement('span');
  sub.className = 'story-row-sub';
  const last = items[items.length - 1];
  sub.textContent = `${items.length} ${items.length === 1 ? 'story' : 'stories'} · ${storyAgo(last ? last.created_at : Date.now())}`;
  main.appendChild(sub);
  row.appendChild(main);
  if (unseen) {
    const dot = document.createElement('span');
    dot.className = 'story-row-new';
    dot.textContent = `${unseen} new`;
    row.appendChild(dot);
  }
  const go = document.createElement('span');
  go.className = 'story-row-go';
  go.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
  row.appendChild(go);
  row.onclick = onClick;
  return row;
}
function openStoriesSheet(scope = 'home') {
  const serverId = scope && scope.serverId ? scope.serverId : null;
  const title = serverId ? `Stories · ${scope.name || 'Server'}` : 'Stories';
  const body = document.createElement('div');
  body.className = 'story-sheet';
  const addSec = (label) => {
    const e = document.createElement('div');
    e.className = 'story-sec';
    e.textContent = label;
    body.appendChild(e);
  };
  const addPost = (label, serverIdForPost) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'story-post';
    b.innerHTML = svSvg.camera + `<span>${esc(label)}</span>`;
    b.onclick = () => { $('#modal-backdrop').classList.add('hidden'); openStoryComposer({ serverId: serverIdForPost || null }); };
    body.appendChild(b);
  };
  if (serverId) {
    const tray = storyServerTray(serverId);
    const items = tray ? storyLive(tray.items) : [];
    const byAuthor = new Map();
    for (const it of items) {
      const u = it.author;
      if (!u) continue;
      const e = byAuthor.get(u.id) || byAuthor.set(u.id, { user: u, items: [], unseen: 0 }).get(u.id);
      e.items.push(it);
      if (!it.seen && u.id !== S.me.id) e.unseen++;
    }
    const rows = [...byAuthor.values()].sort((a, b) => (b.unseen - a.unseen));
    addPost('Post to this server\'s story', serverId);
    if (!rows.length) {
      const p = document.createElement('p');
      p.className = 'muted small story-empty';
      p.textContent = 'No stories here yet — post the first one and it shows up for everyone in this server for 24 hours.';
      body.appendChild(p);
    } else {
      addSec('THIS SERVER');
      for (const t of rows) {
        body.appendChild(storySheetRow(t.user, t.items, t.unseen, () => {
          $('#modal-backdrop').classList.add('hidden');
          // Open on THIS person's first item inside the server's playlist.
          openStoryViewer({ kind: 'server', serverId, userId: t.user.id });
        }));
      }
    }
  } else {
    const trays = storyUserTrays();
    const mineItems = storyLive(storyData.mine && storyData.mine.items);
    addPost('Post a story', null);
    if (mineItems.length) {
      addSec('YOUR STORY');
      body.appendChild(storySheetRow(S.me, mineItems, 0, () => {
        $('#modal-backdrop').classList.add('hidden');
        openStoryViewer({ kind: 'mine' });
      }));
    }
    const friends = trays.filter((t) => t.friend);
    const others = trays.filter((t) => !t.friend);
    if (friends.length) {
      addSec('FRIENDS');
      for (const t of friends) body.appendChild(storySheetRow(t.user, t.items, t.unseen, () => {
        $('#modal-backdrop').classList.add('hidden');
        openStoryViewer({ kind: 'user', userId: t.id });
      }));
    }
    if (others.length) {
      addSec('EVERYONE');
      for (const t of others) body.appendChild(storySheetRow(t.user, t.items, t.unseen, () => {
        $('#modal-backdrop').classList.add('hidden');
        openStoryViewer({ kind: 'user', userId: t.id });
      }));
    }
    const srvTrays = (storyData.servers || []).filter((t) => storyLive(t.items).length);
    if (srvTrays.length) {
      addSec('SERVERS');
      for (const t of srvTrays) {
        const author = (t.items.find((i) => i.author && i.author.id !== S.me.id) || {}).author || S.me;
        body.appendChild(storySheetRow(
          { id: t.server.id, display_name: t.server.name, username: 'server' },
          t.items, serverTrayUnseen(t),
          () => { $('#modal-backdrop').classList.add('hidden'); openStoryViewer({ kind: 'server', serverId: t.server.id, unseen: true }); },
        ));
        void author;
      }
    }
    if (!mineItems.length && !friends.length && !others.length && !srvTrays.length) {
      const p = document.createElement('p');
      p.className = 'muted small story-empty';
      p.textContent = 'No stories right now. Post one — your friends see it in their Home rail, and you can also share it to everyone here or to a specific server.';
      body.appendChild(p);
    }
  }
  openModal(title, '<div id="story-sheet-mount"></div>', 'Close', null);
  document.querySelector('#modal-body').innerHTML = '';
  document.querySelector('#modal-body').appendChild(body);
}

// ================= viewer =================
let sv = null;

function storyViewerTrays(opt = {}) {
  const out = [];
  // Opening from a server scopes the playlist to that server's stories, so
  // watching a server's Stories area never wanders into friends' trays.
  if (opt.kind === 'server') {
    const t = storyServerTray(opt.serverId);
    const items = t ? storyLive(t.items) : [];
    if (items.length) out.push({ kind: 'server', id: t.server.id, server: t.server, items });
    return out;
  }
  for (const t of storyUserTrays()) out.push({ kind: 'user', id: t.id, user: t.user, items: t.items });
  const mine = storyLive(storyData.mine && storyData.mine.items);
  if (mine.length) out.push({ kind: 'mine', id: S.me.id, user: S.me, items: mine });
  return out;
}
function svAuthor(tray, item) { return (tray.kind === 'mine') ? (S.me || (item && item.author)) : ((item && item.author) || tray.user); }
// "Friends, Everyone, Studio" — who can see my own post.
function shareSummary(shared) {
  if (!shared) return '';
  const bits = [];
  if (shared.friends) bits.push('Friends');
  if (shared.everyone) bits.push('Everyone');
  for (const sid of shared.servers || []) {
    const s = (S.servers || []).find((x) => x.id === sid);
    bits.push(s ? s.name : 'Server');
  }
  const users = shared.users || [];
  if (users.length) {
    const names = users.map((id) => {
      const u = ((S.friends && S.friends.friends) || []).find((f) => f.id === id) || (typeof memberById === 'function' ? memberById(id) : null);
      return u ? (u.display_name || u.username) : null;
    }).filter(Boolean);
    if (names.length && names.length <= 3) bits.push(names.join(', '));
    else bits.push(users.length === 1 ? '1 friend' : users.length + ' friends');
  }
  return bits.join(', ');
}
// Typing a reply holds the story: the auto-advance must never wipe the box.
function svReplyBusy() {
  const inp = $('#sv-reply');
  return !!(inp && (document.activeElement === inp || String(inp.value || '').trim()));
}

// Which item in the tray a tap should land on.
// A server tray is ONE playlist holding every author's items, so a tap on a
// person's row there has to select that person's first item: always starting at
// index 0 opened whichever member posted first, which is why tapping "my story"
// right after a friend posted showed the friend's story instead. A server row
// (the Home sheet's SERVERS list) advertises its unseen count, so it opens the
// first new item. Personal trays are one person's own items and still start at
// the top.
function storyStartIndex(tray, opt = {}) {
  if (!tray || tray.kind !== 'server') return 0;
  const items = storyLive(tray.items);
  if (!items.length) return 0;
  if (opt.userId) {
    const j = items.findIndex((it) => it.author && it.author.id === opt.userId);
    return j > 0 ? j : 0;
  }
  if (opt.unseen) {
    const j = items.findIndex((it) => !it.seen && !(S.me && it.author && it.author.id === S.me.id));
    return j > 0 ? j : 0;
  }
  return 0;
}

function openStoryViewer(opt = {}) {
  const trays = storyViewerTrays(opt);
  if (!trays.length) return;
  let ti = 0;
  if (opt.kind === 'user') { const i = trays.findIndex((t) => t.kind === 'user' && t.id === opt.userId); ti = i < 0 ? 0 : i; }
  else if (opt.kind === 'server') { const i = trays.findIndex((t) => t.kind === 'server' && t.id === opt.serverId); ti = i < 0 ? 0 : i; }
  else if (opt.kind === 'mine') { const i = trays.findIndex((t) => t.kind === 'mine'); ti = i < 0 ? 0 : i; }
  const ii = storyStartIndex(trays[ti], opt);
  if (sv) svTeardown();
  sv = { trays, ti: 0, ii: 0, dur: STORY_IMG_MS, t0: 0, elapsed: 0, paused: false, raf: 0, holdT: 0, swipe: null, muted: false, gen: 0, seenT: 0, retryT: 0, retries: 0, waiting: false, replyFor: null, opt: { kind: opt.kind, userId: opt.userId, serverId: opt.serverId } };
  $('#story-view').classList.remove('hidden');
  document.body.classList.add('story-open');
  $('#sv-reply').value = '';
  svShow(ti, ii);
}
function svTeardown() {
  if (!sv) return;
  cancelAnimationFrame(sv.raf);
  clearTimeout(sv.seenT);
  clearTimeout(sv.retryT);
  clearTimeout(sv.holdT);
  try { $('#sv-vid').pause(); } catch {}
  $('#sv-vid').removeAttribute('src');
  $('#sv-img').removeAttribute('src');
  // A half-finished swipe-down must not leave the stage offset for the next open.
  const st = $('#sv-stage');
  if (st) { st.style.transform = ''; st.style.transition = ''; }
  const root = $('#story-view');
  root.classList.add('hidden');
  document.body.classList.remove('story-open');
  const wasMuted = sv.muted;
  sv = null;
  return wasMuted;
}
function svClose() {
  const hadViewer = !!sv;
  svTeardown();
  if (hadViewer) { renderStorySurfaces(); scheduleStoryRefresh(200); }
}

function svShow(ti, ii) {
  if (!sv) return;
  const tray = sv.trays[ti];
  if (!tray) return svClose();
  const items = storyLive(tray.items);
  if (!items.length) return svNextTray();
  if (ii < 0) ii = 0;
  if (ii >= items.length) return svNextTray();
  sv.ti = ti; sv.ii = ii;
  const it = items[ii];
  const author = svAuthor(tray, it) || { display_name: '?' };

  // header
  paintAvatar($('#sv-av'), author);
  // "Your story" whenever the item is mine — including my post inside a
  // server's tray (same rule the footer/menu use).
  $('#sv-name').textContent = svItemIsMine(tray, it) ? 'Your story' : (author.display_name || author.username || 'Story');
  const bits = [storyAgo(it.created_at)];
  if (tray.kind === 'server' && tray.server) bits.push(tray.server.name);
  if (tray.kind === 'mine' && it.shared) { const who = shareSummary(it.shared); if (who) bits.push(who); }
  $('#sv-sub').textContent = bits.join(' · ');

  // progress bars
  const bars = $('#sv-bars');
  bars.innerHTML = '';
  for (let k = 0; k < items.length; k++) {
    const b = document.createElement('span');
    b.className = 'sv-bar';
    const f = document.createElement('i');
    if (k < ii) f.style.width = '100%';
    b.appendChild(f);
    bars.appendChild(b);
  }
  sv.fill = bars.children[ii] ? bars.children[ii].firstChild : null;

  // caption
  const cap = $('#sv-cap');
  cap.textContent = it.caption || '';
  cap.classList.toggle('hidden', !it.caption);

  // media
  // Nothing is shown until the bytes actually decode: while an upload is still
  // being scanned/compressed the route answers 423 and the browser would
  // otherwise paint its broken-media placeholder behind the wait pill.
  const img = $('#sv-img'), vid = $('#sv-vid');
  img.classList.add('hidden'); img.removeAttribute('src'); img.alt = '';
  img.onload = null; img.onerror = null;
  vid.classList.add('hidden');
  try { vid.pause(); } catch {}
  vid.removeAttribute('src');
  vid.onerror = null; vid.onloadeddata = null; vid.onloadedmetadata = null;
  $('#sv-wait').classList.add('hidden');
  $('#sv-wait').classList.remove('sv-wait-dead');
  const waitTxt = $('#sv-wait-txt');
  if (waitTxt) waitTxt.textContent = 'Processing…';
  sv.retries = 0;
  sv.waiting = false;
  const ti0 = ti, ii0 = ii;
  const current = () => !!sv && sv.ti === ti0 && sv.ii === ii0;
  const ready = () => {
    if (!current()) return;
    (it.kind === 'video' ? vid : img).classList.remove('hidden');
    sv.waiting = false;
    sv.elapsed = 0;
    sv.t0 = performance.now();
    $('#sv-wait').classList.add('hidden');
    $('#sv-wait').classList.remove('sv-wait-dead');
  };
  if (it.kind === 'video') {
    vid.muted = sv.muted;
    vid.onerror = () => { if (current()) svMediaError(it); };
    vid.onloadeddata = ready;
    let durMs = Math.max(1000, Math.min(STORY_VIDEO_MAX_MS, Number(it.duration_ms) || 5000));
    vid.onloadedmetadata = () => {
      if (!current()) return;
      const d = vid.duration;
      if (isFinite(d) && d > 0.2) durMs = Math.max(1000, Math.min(STORY_VIDEO_MAX_MS, Math.round(d * 1000)));
      sv.dur = durMs;
    };
    sv.dur = durMs;
    vid.src = it.url;
    const p = vid.play();
    if (p && p.catch) p.catch(() => {
      // Autoplay with sound was refused: fall back to muted playback so the
      // story still plays, and let the speaker button unmute.
      if (!sv || !current()) return;
      sv.muted = true;
      paintSvSound();
      vid.muted = true;
      vid.play().catch(() => {});
    });
  } else {
    img.onerror = () => { if (current()) svMediaError(it); };
    img.onload = ready;
    img.src = it.url;
    sv.dur = STORY_IMG_MS;
  }

  // footer: reply (others) vs viewers (mine)
  const isMine = svItemIsMine(tray, it);
  $('#sv-reply-row').classList.toggle('hidden', isMine);
  $('#sv-views').classList.toggle('hidden', !isMine);
  if (isMine) $('#sv-views-n').textContent = it.views === 1 ? '1 view' : (it.views || 0) + ' views';
  else {
    // Keep a half-written reply while it still belongs to this author (typing
    // pauses the story, but a manual skip must not eat what you wrote).
    const rid = (author && author.id) || '';
    if (sv.replyFor !== rid) { $('#sv-reply').value = ''; sv.replyFor = rid; }
  }
  paintSvSound();

  // resume/pause state + timer
  sv.elapsed = 0;
  sv.paused = false;
  sv.t0 = performance.now();
  cancelAnimationFrame(sv.raf);
  sv.raf = requestAnimationFrame(svTick);
  clearTimeout(sv.retryT);

  // count as seen shortly after it actually appears
  clearTimeout(sv.seenT);
  const gen = ++sv.gen;
  sv.seenT = setTimeout(() => {
    if (!sv || sv.gen !== gen) return;
    markStorySeen(it);
  }, 500);
}

// A story's bytes may still be scanning/compressing right after posting:
// /uploads answers 423 and the element fires an error. Hide the media, hold the
// progress bar and retry (the pill explains the wait), then give up and move on.
function svMediaError(it) {
  if (!sv) return;
  const img = $('#sv-img'), vid = $('#sv-vid');
  (it.kind === 'video' ? vid : img).classList.add('hidden');
  // The item was never really shown: rewind the bar so the crash-frame tick
  // doesn't leave a sliver of progress behind the pill.
  sv.waiting = true;
  sv.elapsed = 0;
  if (sv.fill) sv.fill.style.width = '0%';
  sv.retries++;
  const wait = $('#sv-wait');
  if (sv.retries > 12) {
    wait.classList.remove('hidden');
    wait.classList.add('sv-wait-dead');
    const txt = $('#sv-wait-txt');
    if (txt) txt.textContent = 'Story unavailable';
    const gen = sv.gen;
    clearTimeout(sv.retryT);
    sv.retryT = setTimeout(() => { if (sv && sv.gen === gen) { sv.waiting = false; svNext(); } }, 1800);
    return;
  }
  wait.classList.remove('hidden');
  wait.classList.remove('sv-wait-dead');
  const txt2 = $('#sv-wait-txt');
  if (txt2) txt2.textContent = 'Processing…';
  const gen = sv.gen;
  clearTimeout(sv.retryT);
  sv.retryT = setTimeout(() => {
    if (!sv || sv.gen !== gen) return;
    const url = it.url + (it.url.includes('?') ? '&' : '?') + 'r=' + Date.now();
    if (it.kind === 'video') { vid.src = url; try { vid.play().catch(() => {}); } catch {} }
    else img.src = url;
  }, 3000);
}

function svTick() {
  if (!sv) return;
  // `waiting`: the media is still being prepared server-side — hold the bar
  // (and the auto-advance) until it actually decodes.
  if (!sv.paused && !sv.waiting) {
    if (sv.fill) sv.fill.style.width = Math.min(1, (sv.elapsed + (performance.now() - sv.t0)) / sv.dur) * 100 + '%';
    if (sv.elapsed + (performance.now() - sv.t0) >= sv.dur) return svNext();
  }
  sv.raf = requestAnimationFrame(svTick);
}
function svPause() {
  if (!sv || sv.paused) return;
  sv.elapsed += performance.now() - sv.t0;
  sv.paused = true;
  if (sv.fill) sv.fill.style.width = Math.min(1, sv.elapsed / sv.dur) * 100 + '%';
  try { $('#sv-vid').pause(); } catch {}
}
function svResume() {
  if (!sv || !sv.paused) return;
  sv.paused = false;
  sv.t0 = performance.now();
  const it = svCurrentItem();
  if (it && it.kind === 'video') { try { $('#sv-vid').play().catch(() => {}); } catch {} }
  cancelAnimationFrame(sv.raf);
  sv.raf = requestAnimationFrame(svTick);
}
function svTogglePause() { sv && sv.paused ? svResume() : svPause(); }
function svCurrentItem() {
  if (!sv) return null;
  const tray = sv.trays[sv.ti];
  if (!tray) return null;
  return storyLive(tray.items)[sv.ii] || null;
}
function svNext() {
  if (!sv) return;
  const tray = sv.trays[sv.ti];
  const items = tray ? storyLive(tray.items) : [];
  if (sv.ii + 1 < items.length) svShow(sv.ti, sv.ii + 1);
  else svNextTray();
}
function svNextTray() {
  if (!sv) return;
  let ti = sv.ti + 1;
  while (ti < sv.trays.length && !storyLive(sv.trays[ti].items).length) ti++;
  if (ti >= sv.trays.length) return svClose();
  svShow(ti, 0);
}
function svPrev() {
  if (!sv) return;
  if (sv.ii > 0) return svShow(sv.ti, sv.ii - 1);
  if (sv.ti > 0) {
    let ti = sv.ti - 1;
    while (ti > 0 && !storyLive(sv.trays[ti].items).length) ti--;
    const items = storyLive(sv.trays[ti].items);
    return svShow(ti, Math.max(0, items.length - 1));
  }
  svShow(0, 0); // first item: restart it
}
function svSyncState() {
  // A refresh landed while the viewer is open (someone posted, an item was
  // deleted or expired): rebuild the tray list from the live data and keep the
  // current item when it is still there.
  if (!sv) return;
  const cur = svCurrentItem();
  const curTray = sv.trays[sv.ti];
  const curKey = curTray ? curTray.kind + ':' + curTray.id : '';
  const nextTrays = storyViewerTrays(sv.opt || {});
  if (!nextTrays.length) return svClose();
  sv.trays = nextTrays;
  let ti = nextTrays.findIndex((t) => t.kind + ':' + t.id === curKey);
  if (ti < 0) ti = Math.max(0, Math.min(sv.ti, nextTrays.length - 1));
  const items = storyLive(nextTrays[ti].items);
  if (!items.length) { sv.ti = ti; sv.ii = 0; return svNextTray(); }
  const ii = cur ? items.findIndex((i) => i.id === cur.id) : -1;
  // The item we were showing is gone (deleted / expired): land on the tray's
  // first item instead of silently pointing at a stale index.
  if (ii < 0) { sv.ti = ti; sv.ii = 0; return svShow(ti, 0); }
  sv.ti = ti;
  sv.ii = ii;
  const it = items[sv.ii];
  $('#sv-views-n').textContent = it.views === 1 ? '1 view' : (it.views || 0) + ' views';
}
// Live view receipts: someone watched my story while the viewer is open.
function storyViewsUpdated(storyId, views) {
  if (storyData.mine) for (const it of storyData.mine.items) if (it.id === storyId) it.views = views;
  if (!sv) return;
  const it = svCurrentItem();
  if (it && it.id === storyId) $('#sv-views-n').textContent = views === 1 ? '1 view' : (views || 0) + ' views';
}
// An item vanished for everyone (deleted, or its 24h ran out).
function storyRemoved(storyId) {
  const drop = (list) => (list || []).filter((t) => (t.items = (t.items || []).filter((i) => i.id !== storyId)).length);
  storyData.friends = drop(storyData.friends);
  storyData.everyone = drop(storyData.everyone);
  storyData.servers = drop(storyData.servers);
  if (storyData.mine) {
    storyData.mine.items = (storyData.mine.items || []).filter((i) => i.id !== storyId);
    if (!storyData.mine.items.length) storyData.mine = null;
  }
  if (sv) {
    // Rebuild from the live data; svSyncState re-renders or advances when the
    // item we were watching is the one that just vanished.
    svSyncState();
  }
  renderStorySurfaces();
}
function markStorySeen(it) {
  if (!it || it.seen) return;
  it.seen = true;
  renderStorySurfaces();
  api('/api/stories/' + encodeURIComponent(it.id) + '/view', { method: 'POST' })
    .then(({ views }) => { if (views && storyData.mine) for (const m of storyData.mine.items) if (m.id === it.id) m.views = views; })
    .catch(() => {});
}
function paintSvSound() {
  const b = $('#sv-sound');
  if (!b || !sv) return;
  b.innerHTML = sv.muted ? svSvg.soundOff : svSvg.soundOn;
  b.title = sv.muted ? 'Unmute' : 'Mute';
  b.setAttribute('aria-pressed', sv.muted ? 'false' : 'true');
}
async function svViewers() {
  if (!sv) return;
  const it = svCurrentItem();
  if (!it) return;
  svPause();
  let viewers = [];
  try { ({ viewers } = await api('/api/stories/' + encodeURIComponent(it.id) + '/viewers')); }
  catch { toast('Could not load viewers'); svResume(); return; }
  if (!viewers.length) {
    openModal('No views yet', '<p class="muted">Nobody has watched this story yet.</p>', 'Close', null);
    svResume();
    return;
  }
  const html = `<div class="gmem-list">${viewers.map((u) => `<div class="member sv-viewer" data-uid="${esc(u.id)}"><span class="avwrap"><span class="avatar"></span></span><span class="dmmain"><span class="mname-row"><span class="dmname">${esc(u.display_name)}</span>${tagHTML(u)}</span><span class="dmlast">@${esc(u.username)} · ${esc(storyAgo(u.viewed_at))}</span></span></div>`).join('')}</div>`;
  openModal(viewers.length === 1 ? '1 view' : viewers.length + ' views', html, 'Close', null, { wide: true });
  const box = $('#modal-body');
  viewers.forEach((u) => {
    const row = box.querySelector(`.member[data-uid="${u.id}"]`);
    if (row) paintAvatar(row.querySelector('.avatar'), u);
  });
}
// "Mine" is about who posted the item, not the tray: your own story also
// appears inside a server's tray, and it must still offer viewers + delete.
function svItemIsMine(tray, item) {
  if (tray && tray.kind === 'mine') return true;
  const a = (item && item.author) || null;
  return !!(a && a.id && S.me && a.id === S.me.id);
}
function svMoreMenu(x, y) {
  if (!sv) return;
  const it = svCurrentItem();
  if (!it) return;
  const tray = sv.trays[sv.ti];
  const items = [
    { label: 'Copy link', icon: '⧉', fn: () => { try { navigator.clipboard.writeText(location.origin + it.url); toast('Link copied'); } catch {} } },
  ];
  if (svItemIsMine(tray, it)) {
    items.push({ label: 'Who watched', icon: '◎', fn: () => svViewers() });
    items.push({ label: 'Delete story', icon: '✕', danger: true, fn: () => svDelete(it) });
  } else {
    items.push({ label: 'Reply', icon: '↩', fn: () => { const r = $('#sv-reply'); if (r) r.focus(); } });
  }
  openCtx(x, y, items);
}
async function svDelete(it) {
  const ok = await openConfirmModal({
    title: 'Delete this story?',
    message: 'It disappears for everyone right away.',
    okLabel: 'Delete',
  });
  if (!ok) { svResume(); return; }
  try {
    await api('/api/stories/' + encodeURIComponent(it.id), { method: 'DELETE' });
    toast('Story deleted');
    // Drives both the cached trays (mine/friends/everyone/servers) and the open
    // viewer, whichever tray this item was reached through.
    storyRemoved(it.id);
    scheduleStoryRefresh(300);
  } catch (err) { toast('Delete failed: ' + prettyError(err.message)); svResume(); }
}
// Reply to someone's story without leaving the viewer: the server opens (or
// reuses) the 1:1 DM and copies the story's media in as the preview, so what
// they see in chat survives the story's 24h expiry.
async function storySendReply() {
  if (!sv) return;
  const inp = $('#sv-reply');
  const text = (inp.value || '').trim().slice(0, 500);
  if (!text) return;
  const tray = sv.trays[sv.ti];
  const it = svCurrentItem();
  const author = svAuthor(tray, it);
  if (!author || !author.id || !it) return;
  inp.value = '';
  sv.replyFor = author.id;
  svResume();
  try {
    const { threadId } = await api('/api/stories/' + encodeURIComponent(it.id) + '/reply', { method: 'POST', body: JSON.stringify({ text }) });
    toast('Reply sent to ' + (author.display_name || 'them'));
    if (threadId) refreshDms().catch(() => {});
  } catch (err) { toast('Reply failed: ' + prettyError(err.message)); }
}

// ================= composer (camera + gallery) =================
let sc = null;

function storyCamSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}
function storyRecMime() {
  if (!window.MediaRecorder) return null;
  const cands = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  for (const t of cands) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch {}
  }
  return '';
}
function storyExtFor(mime) {
  const m = String(mime || '');
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('webm')) return 'webm';
  if (m.includes('quicktime')) return 'mov';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  return 'jpg';
}

async function openStoryComposer(opts = {}) {
  if (sc) return;
  const el = $('#story-compose');
  if (!el) return;
  el.classList.remove('hidden');
  document.body.classList.add('story-open');
  sc = {
    stream: null, audio: null, micDenied: false, facing: 'user', mode: 'photo',
    rec: null, chunks: [], recT0: 0, recTimer: null, blob: null, kind: null,
    previewUrl: null, durationMs: 0, busy: false, camFailed: false, xhr: null,
    step: 'capture', camSeq: 0, camReady: false,
    // A shot whose bytes are still encoding (Android encodes toBlob on the
    // main thread during idle time — seconds). pendingShownUrl: the stand-in
    // on screen is that URL, not the frozen camera frame.
    shotSeq: 0, pendingShot: false, pendingUrl: null, pendingShownUrl: false,
    // audiences: friends / everyone / servers (multi-select)
    audFriends: true, audEveryone: false, audServers: [], audUsers: [],
    // view-once mode: pick friends instead of audiences, sends one DM each
    vo: !!opts.viewOnce, voIds: [],
    micCtx: null, micGain: null, micAnalyser: null, micTimer: null, micSource: null, micRaw: null,
  };
  if (opts.serverId) { sc.audServers = [opts.serverId]; sc.audFriends = true; }
  if (opts.everyone) sc.audEveryone = true;
  if (opts.viewOnce) { try { await ensureFriends(); } catch {} }
  scCapBusy = false; // a toBlob from a previous session must not block this one
  storyClearFreeze(); // a stale shot must not sit over the fresh camera
  storyResetShotUi();
  storySetStep('capture');
  renderStoryAudience();
  paintScMic();
  await storyStartCam();
}
function storySetStep(step) {
  if (sc) sc.step = step;
  const capture = step === 'capture';
  const preview = step === 'preview';
  const pick = step === 'audience';
  paintScCam();
  // Entering capture clears the preview; entering preview keeps whichever
  // media element storyShowPreview just revealed (hiding both here would
  // blank the freshly captured shot).
  if (capture) { $('#sc-shot').classList.add('hidden'); $('#sc-play').classList.add('hidden'); }
  $('#sc-edit').classList.toggle('hidden', !preview);
  $('#sc-foot').classList.toggle('hidden', !capture);
  $('#sc-bar').classList.toggle('hidden', !preview);
  $('#sc-bar2').classList.toggle('hidden', !pick);
  $('#sc-pick').classList.toggle('hidden', !pick);
  $('#sc-flip').classList.toggle('hidden', !capture || sc.camFailed);
  $('#sc-mic').classList.toggle('hidden', !capture || sc.camFailed || sc.mode !== 'video');
  if (capture) $('#sc-hint').classList.add('hidden');
  if (pick) renderStoryAudience();
}
async function storyStartCam() {
  if (!sc) return;
  storyStopCamTracks();
  // Any start already in flight is stale once a newer one begins (flip, or a
  // retake). Its stream must not be attached — nor may its tail-end UI reset
  // stomp on a preview the user reached while the camera was still opening.
  const gen = ++sc.camSeq;
  const vid = $('#sc-cam');
  storyCamHint('');
  if (!storyCamSupported()) {
    sc.camFailed = true;
    storySetStep('capture');
    storyCamHint('Camera not available here — pick a photo or video instead.');
    return;
  }
  let stream = null;
  const vq = isCoarse() ? { w: 1280, h: 720 } : { w: 1920, h: 1080 };
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: sc.facing, width: { ideal: vq.w }, height: { ideal: vq.h } },
      audio: false,
    });
  } catch (err) {
    if (!sc || gen !== sc.camSeq || sc.step !== 'capture') return;
    sc.camFailed = true;
    storySetStep('capture'); // first: entering capture clears a stale hint
    storyCamHint('Camera blocked — allow access, or pick a photo/video instead.');
    return;
  }
  const stop = () => { try { stream.getTracks().forEach((t) => t.stop()); } catch {} };
  if (!sc || gen !== sc.camSeq) { stop(); return; }
  if (sc.step !== 'capture') { stop(); return; } // previewing: don't keep the camera warm
  sc.stream = stream;
  sc.camFailed = false;
  vid.srcObject = stream;
  vid.muted = true;
  try { await vid.play(); } catch {}
  if (!sc || gen !== sc.camSeq || sc.step !== 'capture') { stop(); return; }
  await storyCamFrameReady(vid);
  if (!sc || gen !== sc.camSeq || sc.step !== 'capture') { stop(); return; }
  sc.camReady = true;
  storyWarmCapture(vid);
  storySetStep('capture');
}
// The camera element is kept out of the render until it has real frames. An
// empty/loading <video> makes mobile browsers paint their own grey play-button
// placeholder, so while the camera opens we show the viewer's wait pill
// instead — and the element only appears with the first frame behind it.
function paintScCam() {
  const cam = $('#sc-cam'), wait = $('#sc-wait');
  const capture = !!(sc && sc.step === 'capture');
  const ready = capture && !!sc.camReady;
  const loading = capture && !sc.camReady && !sc.camFailed;
  if (cam) cam.classList.toggle('hidden', !ready);
  if (wait) wait.classList.toggle('hidden', !loading);
  // A tap during startup must wait for a real frame, not fire into a dead
  // pipeline (that silent no-op is what read as a multi-second shutter lag).
  // No camera at all (blocked/unsupported): the shutter stays off too.
  const btn = $('#sc-shutter');
  if (btn) btn.disabled = loading || !!(sc && sc.camFailed);
}
// Resolves once the stream has actually decoded a frame. MediaStream metadata
// (videoWidth) can arrive well before the first frame is decodable on Android,
// and drawing at that point is what made the shutter feel dead — the canvas
// readback waits for a frame that isn't there yet. requestVideoFrameCallback
// fires on a frame the user can see, so prefer it; loadeddata/canplay (a real
// decoded frame, not just metadata) cover the rest. The cap keeps a stalled
// camera from parking on the pill forever.
function storyCamFrameReady(vid) {
  if (!vid) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      vid.removeEventListener('loadeddata', onData);
      vid.removeEventListener('canplay', onData);
      resolve(true);
    };
    const onData = () => { if (vid.readyState >= 2) finish(); };
    const timer = setTimeout(finish, 3000);
    vid.addEventListener('loadeddata', onData);
    vid.addEventListener('canplay', onData);
    if (vid.readyState >= 2) finish(); // already painting
    if (typeof vid.requestVideoFrameCallback === 'function') {
      try { vid.requestVideoFrameCallback(() => finish()); } catch {}
    }
  });
}
function storyStopCamTracks() {
  if (!sc) return;
  sc.camSeq = (sc.camSeq || 0) + 1; // invalidate any in-flight start
  try { if (sc.stream) sc.stream.getTracks().forEach((t) => t.stop()); } catch {}
  storyStopMic();
  sc.stream = null; sc.audio = null;
  sc.camReady = false;
  const vid = $('#sc-cam');
  if (vid) vid.srcObject = null;
  paintScCam();
}
function storyCamHint(text) {
  const h = $('#sc-hint');
  if (!h) return;
  h.textContent = text || '';
  h.classList.toggle('hidden', !text);
}
// Mic capture for video stories goes through a small Web Audio chain so quiet
// speakers still come out audible: high-pass (rumble) → auto gain → gentle
// compressor (tames the boosted peaks) → the track the recorder captures.
// The gain rides the measured RMS toward a speech target. Falls back to the
// raw mic track whenever Web Audio isn't available.
async function storyEnsureMic() {
  if (!sc || sc.audio || sc.micDenied) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  let raw = null;
  try {
    raw = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    sc.micDenied = true;
    paintScMic();
    toast('Microphone blocked — recording without sound');
    return;
  }
  if (!sc) { try { raw.getTracks().forEach((t) => t.stop()); } catch {} return; }
  sc.micRaw = raw;
  let outTrack = raw.getAudioTracks()[0] || null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC && outTrack) {
    try {
      const ctx = new AC();
      try { await ctx.resume(); } catch {}
      const src = ctx.createMediaStreamSource(raw);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 85;
      const gain = ctx.createGain();
      gain.gain.value = 1;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 24;
      comp.ratio.value = 4;
      comp.attack.value = 0.004;
      comp.release.value = 0.18;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      const dest = ctx.createMediaStreamDestination();
      src.connect(hp); hp.connect(gain); gain.connect(comp); comp.connect(analyser); comp.connect(dest);
      const track = dest.stream.getAudioTracks()[0];
      if (track) {
        sc.micCtx = ctx; sc.micGain = gain; sc.micAnalyser = analyser; sc.micSource = src;
        outTrack = track;
        const buf = new Float32Array(analyser.fftSize);
        const TARGET = 0.06; // ≈ -24 dBFS RMS
        sc.micTimer = setInterval(() => {
          if (!sc || !sc.micGain || !sc.micAnalyser) return;
          try { sc.micAnalyser.getFloatTimeDomainData(buf); } catch { return; }
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const rms = Math.sqrt(sum / buf.length);
          if (rms < 0.0008) return; // silence: hold the current gain
          const want = Math.max(0.6, Math.min(8, TARGET / rms));
          const cur = sc.micGain.gain.value;
          sc.micGain.gain.value = cur + (want - cur) * 0.3; // smooth, no pumping
        }, 120);
      }
    } catch { /* fall back to the raw track */ }
  }
  sc.audio = raw;
  try { if (sc.stream && outTrack) sc.stream.addTrack(outTrack); } catch {}
  paintScMic();
}
function storyStopMic() {
  if (!sc) return;
  clearInterval(sc.micTimer);
  sc.micTimer = null;
  try { if (sc.micSource) sc.micSource.disconnect(); } catch {}
  try { if (sc.micCtx) sc.micCtx.close(); } catch {}
  sc.micCtx = null; sc.micGain = null; sc.micAnalyser = null; sc.micSource = null;
  try { if (sc.micRaw) sc.micRaw.getTracks().forEach((t) => t.stop()); } catch {}
  sc.micRaw = null;
}
function paintScMic() {
  const b = $('#sc-mic');
  if (!b || !sc) return;
  const on = !!sc.audio && !sc.micDenied;
  b.innerHTML = on ? svSvg.mic : svSvg.micOff;
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.title = on ? 'Microphone on — tap to mute' : 'Microphone off';
  b.style.opacity = on || sc.micDenied ? '1' : '.75';
  if (!on) return;
  for (const t of sc.audio.getAudioTracks()) t.enabled = true;
}
async function storyToggleMic() {
  if (!sc) return;
  if (!sc.audio) { await storyEnsureMic(); return; }
  const tracks = sc.audio.getAudioTracks();
  const on = tracks.some((t) => t.enabled);
  for (const t of tracks) t.enabled = !on;
  const b = $('#sc-mic');
  if (b) {
    b.innerHTML = on ? svSvg.micOff : svSvg.mic;
    b.setAttribute('aria-pressed', on ? 'false' : 'true');
    b.title = on ? 'Microphone off' : 'Microphone on';
  }
}
function storyFlipCam() {
  if (!sc) return;
  sc.facing = sc.facing === 'user' ? 'environment' : 'user';
  storyStartCam();
}
// One reusable capture canvas for the whole session. A fresh 2MP canvas per
// tap (plus its first GPU readback and JPEG encode) is what made the shutter
// feel dead on Android WebView — the warm canvas plus willReadFrequently keeps
// the pixels CPU-side and the pipeline already paid for.
let scCapCanvas = null, scCapCtx = null, scCapBusy = false;
function storyCaptureCanvas(w, h) {
  if (!scCapCanvas) {
    scCapCanvas = document.createElement('canvas');
    try { scCapCtx = scCapCanvas.getContext('2d', { willReadFrequently: true }) || scCapCanvas.getContext('2d'); }
    catch { scCapCtx = scCapCanvas.getContext('2d'); }
  }
  if (scCapCanvas.width !== w || scCapCanvas.height !== h) { scCapCanvas.width = w; scCapCanvas.height = h; }
  return { c: scCapCanvas, ctx: scCapCtx };
}
// Draw one tiny frame the moment the camera is live so the renderer, canvas
// surface and encoder are initialized before the shutter is ever tapped.
function storyWarmCapture(vid) {
  try { storyCaptureCanvas(32, 18).ctx.drawImage(vid, 0, 0, 32, 18); } catch {}
}
// White flash on tap: the capture itself is async, so the shutter must answer
// immediately even when the JPEG encode takes a beat.
function storyFlash() {
  const f = $('#sc-flash');
  if (!f) return;
  f.classList.remove('on');
  void f.offsetWidth;
  f.classList.add('on');
  setTimeout(() => f.classList.remove('on'), 280);
}
/* ---------- JPEG encode, off the main thread ----------
 * canvas.toBlob is not background work on Android: Blink's async blob creator
 * picks the idle-period implementation there, so the JPEG is encoded on the
 * renderer's main thread between frames — and while anything else keeps that
 * thread busy (the camera teardown, the audience list, a spinner, a flash
 * animation) a 2MP shot can sit at "Saving…" for tens of seconds. The same
 * pixels handed to a worker with an OffscreenCanvas land on the worker's own
 * thread, which has no idle scheduling to wait for. Falls back to toBlob when
 * OffscreenCanvas-in-a-worker is missing, and the picked-file path falls back
 * to the original file on top of that. */
let storyEnc = null, storyEncSeq = 0;
const storyEncJobs = new Map();
function storyEncoder() {
  if (storyEnc !== null) return storyEnc;
  storyEnc = false;
  try {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined'
      || typeof OffscreenCanvas.prototype.convertToBlob !== 'function') return storyEnc;
    const src = 'self.onmessage = async (e) => {'
      + 'const d = e.data;'
      + 'try {'
      + 'const c = new OffscreenCanvas(d.width, d.height);'
      + 'c.getContext("2d").drawImage(d.bitmap, 0, 0);'
      + 'd.bitmap.close();'
      + 'const blob = await c.convertToBlob({ type: "image/jpeg", quality: d.quality });'
      + 'self.postMessage({ id: d.id, blob });'
      + '} catch (err) { self.postMessage({ id: d.id, error: String((err && err.message) || err) }); }'
      + '};';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const w = new Worker(url);
    w.onmessage = (e) => {
      const d = e.data || {};
      const job = storyEncJobs.get(d.id);
      if (!job) return;
      storyEncJobs.delete(d.id);
      clearTimeout(job.timer);
      if (d.blob && d.blob.size) job.resolve(d.blob);
      else job.reject(new Error(d.error || 'encode_failed'));
    };
    w.onerror = () => {
      // A dead worker only means the main-thread encoder: retire it (and let
      // anything already posted to it time out into the same fallback).
      storyEnc = false;
      try { w.terminate(); } catch {}
    };
    storyEnc = w;
  } catch { storyEnc = false; }
  return storyEnc;
}
// One job on the worker. The timeout is a wedge guard, not the expected path:
// an encode that has not answered in seconds is broken, and re-encoding on the
// main thread beats leaving the reader on "Saving…" forever.
function storyWorkerEncode(bitmap, width, height, quality) {
  const worker = storyEncoder();
  if (!worker) { try { bitmap.close(); } catch {} return null; }
  return new Promise((resolve, reject) => {
    const id = ++storyEncSeq;
    const timer = setTimeout(() => {
      if (storyEncJobs.delete(id)) reject(new Error('encode_timeout'));
    }, 5000);
    storyEncJobs.set(id, { resolve, reject, timer });
    try { worker.postMessage({ id, bitmap, width, height, quality }, [bitmap]); }
    catch (err) {
      clearTimeout(timer);
      storyEncJobs.delete(id);
      try { bitmap.close(); } catch {}
      reject(err);
    }
  });
}
// JPEG bytes for a canvas. Never throws and never returns the wrong pixels: the
// worker runs first, toBlob is the net under it.
async function storyJpegBlob(source, quality = 0.86) {
  const w = Math.round(source.width || 0), h = Math.round(source.height || 0);
  if (!w || !h) return null;
  if (storyEncoder()) {
    try {
      const blob = await storyWorkerEncode(await createImageBitmap(source), w, h, quality);
      if (blob && blob.size) return blob;
    } catch { /* fall through to the main-thread encoder */ }
  }
  return await new Promise((resolve) => {
    try { source.toBlob(resolve, 'image/jpeg', quality); } catch { resolve(null); }
  });
}
function captureStoryPhoto() {
  const vid = $('#sc-cam');
  if (!sc || !vid || !vid.videoWidth) { toast('Camera is still starting'); return; }
  if (scCapBusy) return;
  scCapBusy = true;
  storyFlash();
  const w = vid.videoWidth, h = vid.videoHeight;
  const scale = Math.min(1, storyCamMaxEdge() / Math.max(w, h));
  const { c, ctx } = storyCaptureCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  try {
    ctx.drawImage(vid, 0, 0, c.width, c.height);
  } catch { scCapBusy = false; toast('Could not capture that frame'); return; }
  // The frame is in the canvas; the JPEG encode is the slow half, and on
  // Android it is not background work at all — Blink encodes canvas.toBlob
  // during main-thread idle slices there, so waiting for the callback left the
  // user staring at a live camera for seconds after the flash. Answer the tap
  // now instead: the captured pixels go up as the stand-in photo (see
  // storyFreeze), the camera is released, and the blob lands behind it.
  storyFreeze();
  const seq = storyShowPendingShot(null);
  // The encode runs behind the frozen frame (see storyJpegBlob) and the reader
  // may walk the audience step while it does; storyPostNow is what waits for it.
  sc.encodePromise = storyJpegBlob(c, 0.86).then((blob) => {
    // Retaken or closed while the encoder ran — the shot is stale, drop it (and
    // leave scCapBusy alone: a newer frame owns the flag now).
    if (!sc || sc.shotSeq !== seq) return;
    scCapBusy = false;
    if (!sc.pendingShot) return;
    if (!blob || !blob.size) { toast('Could not save that photo'); storyRetake(); return; }
    storyShowPreview(blob, 'image', 0);
  });
}
function storyStartRec() {
  if (!sc || sc.rec) return;
  const mime = storyRecMime();
  if (mime === null) { toast('Recording is not supported here — pick a video instead'); return; }
  let rec;
  try { rec = new MediaRecorder(sc.stream, mime ? { mimeType: mime } : undefined); }
  catch { toast('Recording is not supported here — pick a video instead'); return; }
  sc.chunks = [];
  sc.recT0 = Date.now();
  rec.ondataavailable = (e) => { if (e.data && e.data.size) sc.chunks.push(e.data); };
  rec.onstop = () => {
    if (!sc) return;
    const type = String(rec.mimeType || 'video/webm').split(';')[0] || 'video/webm';
    const blob = new Blob(sc.chunks, { type });
    sc.chunks = [];
    if (sc.cancelled) { sc.cancelled = false; return; }
    const ms = Math.max(1000, Math.min(STORY_VIDEO_MAX_MS, Date.now() - sc.recT0));
    if (!blob.size) { toast('Nothing was recorded'); storySetShutter(false); return; }
    storyShowPreview(blob, 'video', ms);
  };
  sc.rec = rec;
  try { rec.start(); } catch { sc.rec = null; toast('Could not start recording'); return; }
  storySetShutter(true);
  sc.recTimer = setInterval(() => {
    if (!sc || !sc.rec) return;
    const ms = Date.now() - sc.recT0;
    const el = $('#sc-rec-time');
    if (el) { el.classList.remove('hidden'); el.textContent = fmtClock(ms / 1000); }
    if (ms >= STORY_VIDEO_MAX_MS) storyStopRec();
  }, 250);
}
function storyStopRec() {
  if (!sc || !sc.rec) return;
  clearInterval(sc.recTimer);
  sc.recTimer = null;
  try { sc.rec.stop(); } catch { sc.rec = null; }
  sc.rec = null;
  storySetShutter(false);
}
function storySetShutter(recording) {
  const b = $('#sc-shutter');
  if (!b) return;
  b.classList.toggle('rec', !!recording);
  b.title = recording ? 'Stop recording' : (sc && sc.mode === 'video' ? 'Record' : 'Take photo');
  if (!recording) $('#sc-rec-time').classList.add('hidden');
}
function storyShutter() {
  if (!sc || sc.busy) return;
  if (sc.mode === 'photo') { captureStoryPhoto(); return; }
  if (sc.rec) storyStopRec();
  else { storyEnsureMic().then(() => storyStartRec()); }
}
function storySetMode(mode) {
  if (!sc) return;
  sc.mode = mode === 'video' ? 'video' : 'photo';
  document.querySelectorAll('.sc-mode').forEach((b) => b.classList.toggle('active', b.dataset.smode === sc.mode));
  storySetShutter(false);
  storySetStep('capture');
  if (sc.mode === 'video') storyEnsureMic();
}
// ---------- preview (after capture / pick) ----------
// Show the captured pixels as the stand-in photo. Putting the very canvas the
// encoder reads from into the stage costs no copy and no decode, and — unlike
// pausing a MediaStream <video>, which some Android WebViews blank — it cannot
// go black while the JPEG encodes.
function storyFreeze() {
  storyClearFreeze();
  const stage = $('#story-compose .sc-stage');
  if (!stage || !scCapCanvas) return;
  scCapCanvas.classList.add('sc-freeze');
  stage.appendChild(scCapCanvas);
}
function storyClearFreeze() {
  try { if (scCapCanvas) scCapCanvas.remove(); } catch {}
}
// The bytes are still encoding (see storyJpegBlob). Put something real on
// screen immediately and finish behind it:
//   url === null → the frozen captured frame (storyFreeze)
//   url          → the picked file's own object URL (the gallery path shows the
//                  photo it was handed while it re-encodes the downscale)
// Next stays disabled until a blob exists to carry into the audience step.
// Returns the shot sequence the caller must present to check against.
function storyShowPendingShot(url) {
  if (!sc) return 0;
  const seq = (sc.shotSeq || 0) + 1;
  sc.shotSeq = seq;
  sc.pendingShot = true;
  if (sc.pendingUrl) { try { URL.revokeObjectURL(sc.pendingUrl); } catch {} }
  sc.pendingUrl = url || null;
  sc.pendingShownUrl = !!url;
  const img = $('#sc-shot'), vid = $('#sc-play');
  vid.classList.add('hidden');
  vid.removeAttribute('src');
  img.classList.add('hidden');
  storyStopCamTracks(); // either path is done with the camera now
  if (url) {
    storyClearFreeze();
    img.src = url;
    img.classList.remove('hidden');
  }
  // Next goes live with the frozen frame, not with the bytes. Making the reader
  // stare at a disabled "Saving…" while the JPEG encodes is the whole "saving
  // takes forever" complaint; the pixels they need to see are already up, and
  // storyPostNow waits for the encode at the end, after the audience step.
  storyResetShotUi();
  storySetStep('preview');
  storyProgress(null);
  // The audience list is a lot of DOM; it has no business delaying the paint
  // of the shot the user just took.
  setTimeout(() => { if (sc && sc.pendingShot) renderStoryAudience(); }, 0);
  return seq;
}
function storyResetShotUi() {
  const next = $('#sc-next');
  if (next) { next.disabled = false; next.textContent = 'Next'; }
}
function storyShowPreview(blob, kind, durationMs) {
  if (!sc) return;
  storyStopRec();
  if (sc.previewUrl) { try { URL.revokeObjectURL(sc.previewUrl); } catch {} }
  sc.blob = blob;
  sc.kind = kind;
  sc.durationMs = durationMs || 0;
  sc.previewUrl = URL.createObjectURL(blob);
  const img = $('#sc-shot'), vid = $('#sc-play');
  if (kind === 'video') {
    img.classList.add('hidden');
    vid.classList.remove('hidden');
    vid.src = sc.previewUrl;
    vid.muted = false;
    vid.play().catch(() => { vid.muted = true; vid.play().catch(() => {}); });
    storyRevealPreview('video', true);
  } else if (sc.pendingShownUrl) {
    // The <img> is already showing this picture (the picked file). Swapping in
    // the re-encoded downscale would blank it for the length of an Android
    // decode, for pixels nobody will see again — the upload uses sc.blob.
    storyRevealPreview('image', false);
  } else {
    vid.classList.add('hidden');
    vid.removeAttribute('src');
    // Hand over to the encoded shot only once it can paint, so the frozen
    // frame never blanks out in between. The guard matters: clearing or
    // replacing the <img> below (a retake clears its src) can fire load/error
    // on this element, and a stale handler must not reveal a shot that no
    // longer exists — Next would go live with no blob behind it.
    const seq = sc.shotSeq;
    let done = false, bail = 0;
    const once = () => {
      if (done || !sc || sc.shotSeq !== seq || !sc.pendingShot) return;
      done = true;
      clearTimeout(bail);
      img.onload = null;
      img.onerror = null;
      storyRevealPreview('image', true);
    };
    bail = setTimeout(once, 1500); // a stalled decode must not strand the user
    img.onload = once;
    img.onerror = once;
    img.src = sc.previewUrl;
    if (img.decode) { try { img.decode().then(once).catch(() => {}); } catch {} }
  }
}
function storyRevealPreview(kind, showImg) {
  if (!sc) return;
  sc.pendingShot = false;
  storyStopCamTracks();
  storyClearFreeze();
  const img = $('#sc-shot');
  if (kind === 'image' && showImg) img.classList.remove('hidden');
  storyResetShotUi();
  // The encode is allowed to land late, so by now the reader may be picking an
  // audience — never yank them back a step when the bytes arrive.
  if (sc.step !== 'audience') storySetStep('preview');
  renderStoryAudience();
  storyProgress(null);
}
function storyRetake() {
  if (!sc) return;
  if (sc.previewUrl) { try { URL.revokeObjectURL(sc.previewUrl); } catch {} }
  if (sc.pendingUrl) { try { URL.revokeObjectURL(sc.pendingUrl); } catch {} }
  sc.previewUrl = null; sc.blob = null; sc.kind = null; sc.durationMs = 0;
  sc.pendingShot = false; sc.pendingUrl = null; sc.pendingShownUrl = false;
  sc.shotSeq = (sc.shotSeq || 0) + 1; // an in-flight encode must not resurrect this shot
  scCapBusy = false;                  // …nor may its callback keep the shutter locked
  storyResetShotUi();
  storyClearFreeze();
  const vid = $('#sc-play');
  try { vid.pause(); } catch {}
  vid.removeAttribute('src');
  $('#sc-shot').removeAttribute('src');
  $('#sc-caption').value = '';
  storySetStep('capture');
  storyStartCam();
}
function storyAudCount() {
  if (!sc) return 0;
  if (sc.vo) return (sc.voIds || []).length;
  return (sc.audFriends ? 1 : 0) + (sc.audEveryone ? 1 : 0) + (sc.audServers || []).length + (sc.audUsers || []).length;
}
// Broadcast audiences post a story (tray). Individually picked friends are a
// private delivery instead: each one gets a view-once DM (one view, one
// replay), never a tray entry.
function scBroadcast() {
  return !!(sc && (sc.audFriends || sc.audEveryone || (sc.audServers || []).length));
}
function scPostLabel() {
  if (!sc) return 'Post story';
  const n = storyAudCount();
  if (sc.vo) return n ? `Send (${n})` : 'Send';
  const priv = (sc.audUsers || []).length;
  if (!scBroadcast() && priv) return n === 1 ? 'Send view-once' : `Send view-once (${n})`;
  if (scBroadcast() && priv) return priv === 1 ? 'Post + DM' : `Post + ${priv} DMs`;
  return 'Post story';
}
// Step 2: the audience menu. Everything is a toggle row — all friends,
// everyone on this Campfire, whole servers, or individual friends.
function renderStoryAudience() {
  const list = $('#sc-pick-list');
  if (!list || !sc) return;
  const q = String(($('#sc-pick-search') || {}).value || '').trim().toLowerCase();
  const friends = [...((S.friends && S.friends.friends) || [])]
    .sort((a, b) => String(a.display_name || '').localeCompare(String(b.display_name || '')));
  const shown = friends.filter((f) => !q || `${f.display_name || ''} ${f.username || ''}`.toLowerCase().includes(q));
  list.innerHTML = '';
  const section = (label) => {
    const e = document.createElement('div');
    e.className = 'sc-pick-sec';
    e.textContent = label;
    list.appendChild(e);
  };
  const row = (opts) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sc-pick-row' + (opts.on ? ' on' : '');
    b.setAttribute('aria-pressed', opts.on ? 'true' : 'false');
    if (opts.user) {
      const av = document.createElement('span');
      av.className = 'avatar';
      paintAvatar(av, opts.user);
      b.appendChild(av);
    } else {
      const ic = document.createElement('span');
      ic.className = 'sc-pick-ico';
      ic.innerHTML = opts.icon || '';
      b.appendChild(ic);
    }
    const main = document.createElement('span');
    main.className = 'sc-pick-main';
    const nm = document.createElement('span');
    nm.className = 'sc-pick-name';
    nm.textContent = opts.name;
    const sub = document.createElement('span');
    sub.className = 'sc-pick-sub';
    sub.textContent = opts.sub || '';
    main.append(nm, sub);
    b.appendChild(main);
    const chk = document.createElement('span');
    chk.className = 'sc-pick-check';
    chk.innerHTML = svSvg.check;
    b.appendChild(chk);
    b.onclick = () => { opts.toggle(); renderStoryAudience(); };
    list.appendChild(b);
    return b;
  };
  if (sc.vo) {
    section(friends.length ? 'SEND TO' : 'NO FRIENDS YET');
    for (const f of shown) {
      row({
        user: f, name: f.display_name || f.username, sub: '@' + f.username,
        on: sc.voIds.includes(f.id),
        toggle: () => { sc.voIds = sc.voIds.includes(f.id) ? sc.voIds.filter((x) => x !== f.id) : [...sc.voIds, f.id]; },
      });
    }
    if (!friends.length) {
      const p = document.createElement('p');
      p.className = 'sc-pick-sub';
      p.style.padding = '.2rem .15rem';
      p.textContent = 'View-once items go to friends — add someone from Home → Friends first.';
      list.appendChild(p);
    }
  } else {
    section('AUDIENCE');
    row({
      icon: svSvg.users, name: 'All friends', sub: 'Everyone on your friends list',
      on: !!sc.audFriends, toggle: () => { sc.audFriends = !sc.audFriends; },
    });
    row({
      icon: svSvg.globe, name: 'Everyone', sub: 'Any account on this Campfire',
      on: !!sc.audEveryone, toggle: () => { sc.audEveryone = !sc.audEveryone; },
    });
    if ((S.servers || []).length) {
      section('SERVERS');
      for (const srv of S.servers) {
        row({
          icon: svSvg.camera, name: srv.name, sub: 'Everyone in this server',
          on: (sc.audServers || []).includes(srv.id),
          toggle: () => {
            sc.audServers = (sc.audServers || []).includes(srv.id)
              ? sc.audServers.filter((x) => x !== srv.id)
              : [...(sc.audServers || []), srv.id];
          },
        });
      }
    }
    section(shown.length ? 'SEND PRIVATELY' : 'FRIENDS');
    if (shown.length) {
      const note = document.createElement('p');
      note.className = 'sc-vo-note';
      note.textContent = 'Friends you pick here get it in their DMs as a view-once — one view, one replay.';
      list.appendChild(note);
    }
    for (const f of shown) {
      row({
        user: f, name: f.display_name || f.username, sub: '@' + f.username,
        on: (sc.audUsers || []).includes(f.id),
        toggle: () => {
          sc.audUsers = (sc.audUsers || []).includes(f.id)
            ? sc.audUsers.filter((x) => x !== f.id)
            : [...(sc.audUsers || []), f.id];
        },
      });
    }
    if (!friends.length) {
      const p = document.createElement('p');
      p.className = 'sc-pick-sub';
      p.style.padding = '.2rem .15rem';
      p.textContent = 'You have no friends yet — share to Everyone or a server instead.';
      list.appendChild(p);
    }
  }
  const search = $('#sc-pick-search');
  if (search) search.classList.toggle('hidden', friends.length < 3);
  const n = storyAudCount();
  const count = $('#sc-pick-count');
  if (count) count.textContent = n ? `${n} selected` : 'None selected';
  const title = $('#sc-pick-title');
  if (title) title.textContent = 'Who gets this?';
  const post = $('#sc-post');
  if (post) {
    post.disabled = !n || !!sc.busy;
    if (!sc.busy) post.textContent = scPostLabel();
  }
}

function storyProgress(pct) {
  const wrap = $('#sc-prog'), fill = $('#sc-prog-fill');
  if (!wrap || !fill) return;
  if (pct === null) { wrap.classList.add('hidden'); fill.style.width = '0%'; return; }
  wrap.classList.remove('hidden');
  fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
}
function closeStoryComposer() {
  if (!sc) return;
  const st = sc;
  sc = null;
  scCapBusy = false;
  if (st.xhr) { try { st.xhr.abort(); } catch {} }
  if (st.rec) { try { st.cancelled = true; st.rec.stop(); } catch {} }
  clearInterval(st.recTimer);
  clearInterval(st.micTimer);
  try { if (st.micSource) st.micSource.disconnect(); } catch {}
  try { if (st.micCtx) st.micCtx.close(); } catch {}
  try { if (st.micRaw) st.micRaw.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (st.stream) st.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (st.audio) st.audio.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (st.previewUrl) URL.revokeObjectURL(st.previewUrl); } catch {}
  try { if (st.pendingUrl) URL.revokeObjectURL(st.pendingUrl); } catch {}
  const cam = $('#sc-cam');
  if (cam) cam.srcObject = null;
  const play = $('#sc-play');
  if (play) { try { play.pause(); } catch {} play.removeAttribute('src'); }
  const shot = $('#sc-shot');
  if (shot) shot.removeAttribute('src');
  storyClearFreeze();
  const cap = $('#sc-caption');
  if (cap) cap.value = '';
  $('#sc-file').value = '';
  storyProgress(null);
  $('#story-compose').classList.add('hidden');
  if (!$('#story-view') || $('#story-view').classList.contains('hidden')) document.body.classList.remove('story-open');
}
// Downscale a picked photo (max long edge 1920, JPEG) so phone photos don't
// burn upload bandwidth. Animated images are passed through untouched: drawing
// a GIF/WebP onto a canvas bakes the first frame, so the animation would die.
// Any failure falls back to the original file.
function storyIsAnimated(file) {
  const t = String((file && file.type) || '').toLowerCase();
  const n = String((file && file.name) || '').toLowerCase();
  return t === 'image/gif' || t === 'image/apng' || t === 'image/webp' || /\.(gif|apng|webp)$/.test(n);
}
async function storyDownscaleImage(file) {
  if (storyIsAnimated(file)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, STORY_MAX_EDGE / Math.max(bmp.width, bmp.height));
    if (scale >= 1 && file.size < 2 * 1024 * 1024) { try { bmp.close(); } catch {} return file; }
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    try { bmp.close(); } catch {}
    const blob = await storyJpegBlob(c, 0.92);
    if (!blob || !blob.size) return file;
    return new File([blob], (file.name || 'story').replace(/\.[a-z0-9]+$/i, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; }
}
function storyVideoDuration(file) {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      let done = false;
      const finish = (ms) => {
        if (done) return;
        done = true;
        try { v.removeAttribute('src'); } catch {}
        try { URL.revokeObjectURL(url); } catch {}
        resolve(ms);
      };
      v.preload = 'metadata';
      v.muted = true;
      v.onloadedmetadata = () => finish(isFinite(v.duration) && v.duration > 0 ? Math.min(STORY_VIDEO_MAX_MS, Math.round(v.duration * 1000)) : 0);
      v.onerror = () => finish(0);
      setTimeout(() => finish(0), 4000);
      v.src = url;
    } catch { resolve(0); }
  });
}
async function storyPickFile(file) {
  if (!sc || !file) return;
  if (file.type.startsWith('image/')) {
    // Show the picked file at once (its own bytes, no encode) and re-encode
    // behind it — the downscale/JPEG is the same slow main-thread idle work
    // that made the shutter look broken on Android.
    const quick = URL.createObjectURL(file);
    const seq = storyShowPendingShot(quick);
    sc.encodePromise = (async () => {
      const img = await storyDownscaleImage(file);
      if (!sc || sc.shotSeq !== seq) { try { URL.revokeObjectURL(quick); } catch {} return; }
      storyShowPreview(img, 'image', 0);
    })();
    await sc.encodePromise;
  } else if (file.type.startsWith('video/')) {
    if (file.size > S.maxUploadMb * 1024 * 1024) { toast(`Videos are limited to ${S.maxUploadMb}MB`); return; }
    storyShowPreview(file, 'video', await storyVideoDuration(file));
  } else {
    toast('Pick a photo or a video');
  }
}
async function storyPostNow() {
  if (!sc || sc.busy) return;
  const st = sc;
  const btn = $('#sc-post');
  // The shot's JPEG may still be encoding (see storyJpegBlob): Next no longer
  // waits for it, so this is where the wait belongs — at the last tap, with the
  // frozen frame still on screen. "Saving…" is honest about what is happening.
  if (!st.blob && st.encodePromise) {
    st.busy = true; // a second tap must not queue a second post while we wait
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try { await st.encodePromise; } catch {}
    if (sc !== st) return;
    st.busy = false;
    btn.disabled = false;
    btn.textContent = scPostLabel();
    if (!st.blob) { toast('Could not save that photo — try another shot'); storyProgress(null); return; }
  }
  if (!st.blob) return;
  st.busy = true;
  btn.disabled = true;
  btn.textContent = 'Uploading…';
  const caption = ($('#sc-caption').value || '').trim().slice(0, 200);
  const dmIds = st.vo ? (st.voIds || []).slice() : (st.audUsers || []).slice();
  const broadcast = !st.vo && scBroadcast();
  const privateOnly = !st.vo && !broadcast && dmIds.length > 0;
  // A private-only send uploads straight into the gated viewonce/ prefix: a
  // files/ upload is served to anyone holding the URL, so it would not be
  // view-once at all (the story path below copies its bytes over instead).
  const voUpload = st.vo || privateOnly;
  const fd = new FormData();
  const type = st.blob.type || (st.kind === 'video' ? 'video/webm' : 'image/jpeg');
  fd.append('file', new File([st.blob], (voUpload ? 'viewonce-' : 'story-') + Date.now() + '.' + storyExtFor(type), { type }));
  const up = await new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    st.xhr = xhr;
    xhr.open('POST', voUpload ? '/api/upload/viewonce' : '/api/upload');
    if (store.token) xhr.setRequestHeader('Authorization', 'Bearer ' + store.token);
    xhr.upload.onprogress = (e) => {
      if (!sc) return;
      if (e.lengthComputable && e.total) storyProgress((e.loaded / e.total) * 100);
      btn.textContent = 'Uploading… ' + Math.round((e.loaded / (e.total || 1)) * 100) + '%';
    };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch {}
      resolve(xhr.status >= 200 && xhr.status < 300 && data ? data : { error: (data && data.error) || 'http_' + xhr.status });
    };
    xhr.onerror = () => resolve({ error: 'network_error' });
    xhr.onabort = () => resolve({ error: 'cancelled' });
    try { xhr.send(fd); } catch (err) { resolve({ error: (err && err.message) || 'upload_failed' }); }
  });
  if (!sc) return;
  st.xhr = null;
  if (up.error) { st.busy = false; btn.disabled = false; btn.textContent = scPostLabel(); storyProgress(null); toast('Upload failed: ' + prettyError(up.error)); return; }
  if (up.scan === 'infected') { st.busy = false; btn.disabled = false; btn.textContent = scPostLabel(); storyProgress(null); toast('That file was blocked by the scanner'); return; }
  if (st.vo || privateOnly) {
    btn.textContent = 'Sending…';
    try {
      const r = await sendViewOnce({ url: up.url, mime: up.mime, kind: up.kind || st.kind, caption, userIds: dmIds });
      storyProgress(null);
      closeStoryComposer();
      toast(r.sent === 1 ? 'Sent to their DMs — view-once' : `Sent to ${r.sent} friends as view-once DMs`);
      refreshDms().catch(() => {});
    } catch (err) {
      st.busy = false; btn.disabled = false; btn.textContent = scPostLabel(); storyProgress(null);
      toast('Could not send: ' + prettyError(err.message));
    }
    return;
  }
  btn.textContent = 'Posting…';
  let story = null;
  try {
    const r = await api('/api/stories', {
      method: 'POST',
      body: JSON.stringify({
        url: up.url, mime: up.mime, kind: st.kind, caption,
        friends: !!st.audFriends, everyone: !!st.audEveryone,
        servers: st.audServers || [],
        durationMs: st.durationMs || undefined,
      }),
    });
    story = r.story || null;
  } catch (err) {
    st.busy = false; btn.disabled = false; btn.textContent = scPostLabel(); storyProgress(null);
    toast('Could not post: ' + prettyError(err.message));
    return;
  }
  // Individually picked friends get a private view-once copy: the server
  // re-files the story's bytes under the gated prefix (no second upload), so
  // each DM still views once, replays once, and dies after use.
  let dmSent = 0;
  if (dmIds.length && story) {
    try {
      const r = await sendViewOnce({ storyId: story.id, userIds: dmIds, caption });
      dmSent = Number(r.sent) || 0;
    } catch (err) { toast('Story posted, but the DMs failed: ' + prettyError(err.message)); }
  }
  storyProgress(null);
  closeStoryComposer();
  if (dmSent) {
    toast('Story posted — ' + (dmSent === 1 ? 'and sent as a view-once DM' : `and sent to ${dmSent} friends as view-once DMs`));
    refreshDms().catch(() => {});
  } else {
    toast('Story posted — live for 24 hours');
  }
  // Refresh the tray so the new post is there — but never force it open. The
  // uploader knows what they just sent; auto-playing it back (and rendering
  // their own story seen) is not what they asked for.
  await loadStories();
  renderStorySurfaces();
}

// ================= wiring =================
$('#cm-viewonce').onclick = (e) => {
  e.stopPropagation();
  $('#composer-more').classList.add('hidden');
  openStoryComposer({ viewOnce: true });
};
$('#cm-story').onclick = (e) => {
  e.stopPropagation();
  $('#composer-more').classList.add('hidden');
  openStoryComposer({ serverId: S.view === 'server' ? S.serverId : null });
};
$('#btn-stories').onclick = () => openStoriesSheet('home');
$('#sv-close').onclick = () => svClose();
$('#sv-sound').onclick = () => {
  if (!sv) return;
  sv.muted = !sv.muted;
  const vid = $('#sv-vid');
  vid.muted = sv.muted;
  paintSvSound();
};
$('#sv-more').onclick = (e) => {
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  svMoreMenu(r.left, r.bottom + 6);
};
$('#sv-views').onclick = () => svViewers();
$('#sv-reply-send').onclick = () => storySendReply();
$('#sv-reply').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); storySendReply(); }
});
$('#sv-vid').addEventListener('ended', () => { if (svReplyBusy()) svPause(); else svNext(); });
// Focusing the reply box pauses the story (blur lets it run again): the story
// must never advance out from under someone mid-sentence.
$('#sv-reply').addEventListener('focus', () => svPause());
$('#sv-reply').addEventListener('blur', () => { if (sv && !svReplyBusy()) svResume(); });
// Tap zones with press-and-hold to pause (like Snapchat/Instagram).
function storyZoneEl(el, fn) {
  let held = false, sx = 0, sy = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return;
    held = false;
    sx = e.clientX; sy = e.clientY;
    clearTimeout(svHoldT);
    svHoldT = setTimeout(() => { held = true; svPause(); }, 200);
  });
  // Dragging is a swipe (the stage's own handler owns it), never a tap: drop the
  // hold-to-pause timer so a quick flick doesn't leave the story paused.
  el.addEventListener('pointermove', (e) => {
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > 12) clearTimeout(svHoldT);
  });
  const up = (e) => {
    clearTimeout(svHoldT);
    const wasHeld = held;
    held = false;
    const dragged = Math.hypot(e.clientX - sx, e.clientY - sy) > 12;
    if (wasHeld) svResume();
    // The zones cover the whole stage, so without this a swipe-down closed the
    // viewer *and* advanced it first; a drag must never step the story.
    if (dragged) return;
    if (wasHeld) return; // a hold is a pause, not a tap
    fn();
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', () => { clearTimeout(svHoldT); held = false; svResume(); });
  el.addEventListener('pointerleave', () => { if (held) { clearTimeout(svHoldT); held = false; svResume(); } });
}
let svHoldT = 0;
storyZoneEl($('#sv-next'), () => sv && svNext());
storyZoneEl($('#sv-prev'), () => sv && svPrev());
// Swipe down on the stage closes the viewer. The stage has nothing to scroll,
// so touch-action:none (see .sv-stage) keeps the browser from claiming the drag
// — under pan-y the pointer stream was cancelled and the swipe never landed.
// The picture follows the finger, then closes past the threshold or springs back.
(function () {
  const stage = $('#sv-stage');
  const LIMIT = 90;
  let sx = 0, sy = 0, dy = 0, active = false;
  const clearDrag = () => { active = false; dy = 0; stage.style.transform = ''; stage.style.transition = ''; };
  stage.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return;
    active = true; sx = e.clientX; sy = e.clientY; dy = 0;
    stage.style.transition = '';
  });
  stage.addEventListener('pointermove', (e) => {
    if (!active) return;
    const dx = e.clientX - sx;
    if (Math.abs(dx) > Math.abs(e.clientY - sy) * 1.5) return; // sideways: leave it to the zones
    dy = e.clientY - sy;
    if (dy <= 0) { stage.style.transform = ''; return; }
    stage.style.transform = 'translateY(' + Math.round(Math.min(dy, 240) * 0.6) + 'px)';
  });
  const end = (e) => {
    if (!active) return;
    const d = e.clientY - sy, dx = Math.abs(e.clientX - sx);
    active = false;
    const close = d > LIMIT && dx < 80;
    dy = 0;
    if (close) { stage.style.transform = ''; svClose(); return; }
    // Not far enough: spring back.
    stage.style.transition = 'transform .18s ease-out';
    stage.style.transform = '';
    setTimeout(() => { if (!active) stage.style.transition = ''; }, 200);
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', clearDrag);
})();
document.addEventListener('keydown', (e) => {
  if (!sv) return;
  // A dialog opened from the viewer (delete confirm, viewers list) owns the
  // keyboard while it is up.
  if (!$('#modal-backdrop').classList.contains('hidden')) return;
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  if (typing && e.key !== 'Escape') return;
  if (e.key === 'Escape') { e.preventDefault(); svClose(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); svNext(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); svPrev(); }
  else if (e.key === ' ') { e.preventDefault(); svTogglePause(); }
  else if (e.key === 'm' || e.key === 'M') { if (sv) { sv.muted = !sv.muted; $('#sv-vid').muted = sv.muted; paintSvSound(); } }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) svPause(); });
document.addEventListener('pointerdown', (e) => {
  // A tap outside the stage pauses too (viewer is a modal, so only its own
  // chrome counts) — keeps hold-to-pause from leaking into the next tap.
  if (sv && !e.target.closest('#sv-stage') && !e.target.closest('.sv-ico') && !e.target.closest('.sv-foot')) svResume();
});

// composer wiring
$('#sc-close').onclick = () => closeStoryComposer();
// Shutter on pointerdown, not click: the WebView's click synthesis can add
// real latency to the one control where a lag reads as "broken". The click
// path stays for keyboard activation (and is ignored right after a tap).
let scShutterTap = 0;
$('#sc-shutter').addEventListener('pointerdown', (e) => {
  if (e.button && e.button !== 0) return;
  scShutterTap = Date.now();
  storyShutter();
});
$('#sc-shutter').addEventListener('click', () => {
  if (Date.now() - scShutterTap < 600) return;
  storyShutter();
});
$('#sc-flip').onclick = () => storyFlipCam();
$('#sc-mic').onclick = () => storyToggleMic();
$('#sc-gallery').onclick = () => $('#sc-file').click();
$('#sc-retake').onclick = () => storyRetake();
$('#sc-post').onclick = () => storyPostNow();
$('#sc-next').onclick = () => { if (sc && !sc.busy) storySetStep('audience'); };
$('#sc-back').onclick = () => { if (sc && !sc.busy) storySetStep('preview'); };
$('#sc-pick-back').onclick = () => { if (sc && !sc.busy) storySetStep('preview'); };
$('#sc-pick-close').onclick = () => closeStoryComposer();
$('#sc-pick-search').addEventListener('input', () => renderStoryAudience());
$('#sc-file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  // Clear only after handing the File over: some browsers invalidate blobs
  // still owned by a reset input.
  if (f) storyPickFile(f);
  e.target.value = '';
});
document.querySelectorAll('.sc-mode').forEach((b) => { b.onclick = () => storySetMode(b.dataset.smode); });
$('#sc-caption').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 88) + 'px';
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sc) { e.preventDefault(); closeStoryComposer(); }
});
