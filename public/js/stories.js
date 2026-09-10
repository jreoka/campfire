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
const STORY_MAX_EDGE = 1920;      // photos are downscaled to this long edge

// Icon set (inline SVG, no emoji — see the design language in AGENTS.md).
const svSvg = {
  plus: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
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
// Unseen count across everything I can watch (drives the Home dot/rows).
function storyUnseenTotal() {
  let n = 0;
  for (const t of storyUserTrays()) n += t.unseen;
  for (const t of storyData.servers || []) n += (t.unseen || 0);
  return n;
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
function renderServerStories() {
  const box = $('#srv-stories');
  if (!box) return;
  if (!S.serverId || !S.serverDetail) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const tray = storyServerTray(S.serverId);
  const items = tray ? storyLive(tray.items) : [];
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
  } else if (tray.unseen) {
    const n = document.createElement('span');
    n.className = 'ss-count';
    n.textContent = tray.unseen + ' new';
    row.appendChild(n);
  } else {
    const n = document.createElement('span');
    n.className = 'ss-count seen';
    n.textContent = String(others.length || items.length);
    row.appendChild(n);
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
  const mineItems = storyLive(storyData.mine && storyData.mine.items);
  const srvTrays = (storyData.servers || []).filter((t) => storyLive(t.items).length);
  const unseen = storyUnseenTotal();
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
    const n = trays.length + srvTrays.length;
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
    try {
      const old = wrap.querySelector('.st-thumb-inline');
      if (old) old.remove();
      if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
      const thumb = storyThumbEl(storyThumbItem(items), 'st-thumb-inline');
      if (thumb) wrap.appendChild(thumb);
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
// "Watch story" on the card (ring around the avatar too) — the affordance
// people look for after clicking someone's name.
function paintUserCardStory(card, u) {
  if (!card || !u || !S.me || u.id === S.me.id) return;
  const tray = storyTrayFor(u.id);
  const items = tray ? storyLive(tray.items) : [];
  if (!items.length) return;
  const unseen = items.some((i) => !i.seen);
  const av = card.querySelector('.avatar');
  if (av) {
    av.style.boxShadow = '0 0 0 2.5px ' + (unseen ? 'var(--accent)' : 'var(--line)');
    try {
      if (getComputedStyle(av).position === 'static') av.style.position = 'relative';
      const old = av.querySelector('.st-thumb-inline');
      if (old) old.remove();
      const thumb = storyThumbEl(storyThumbItem(items), 'st-thumb-inline');
      if (thumb) av.appendChild(thumb);
    } catch {}
  }
  const actions = card.querySelector('.uc-actions');
  if (!actions || card.querySelector('#uc-story')) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn small' + (unseen ? ' primary' : '');
  b.id = 'uc-story';
  b.textContent = unseen ? 'Watch story' : 'Watch story (seen)';
  b.onclick = () => { try { closeUserCard(); } catch {} openStoryViewer({ kind: 'user', userId: u.id }); };
  actions.insertBefore(b, actions.firstChild);
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
          openStoryViewer({ kind: 'server', serverId });
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
          t.items, t.unseen,
          () => { $('#modal-backdrop').classList.add('hidden'); openStoryViewer({ kind: 'server', serverId: t.server.id }); },
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
  return bits.join(', ');
}
// Typing a reply holds the story: the auto-advance must never wipe the box.
function svReplyBusy() {
  const inp = $('#sv-reply');
  return !!(inp && (document.activeElement === inp || String(inp.value || '').trim()));
}

function openStoryViewer(opt = {}) {
  const trays = storyViewerTrays(opt);
  if (!trays.length) return;
  let ti = 0;
  if (opt.kind === 'user') { const i = trays.findIndex((t) => t.kind === 'user' && t.id === opt.userId); ti = i < 0 ? 0 : i; }
  else if (opt.kind === 'server') { const i = trays.findIndex((t) => t.kind === 'server' && t.id === opt.serverId); ti = i < 0 ? 0 : i; }
  else if (opt.kind === 'mine') { const i = trays.findIndex((t) => t.kind === 'mine'); ti = i < 0 ? 0 : i; }
  if (sv) svTeardown();
  sv = { trays, ti: 0, ii: 0, dur: STORY_IMG_MS, t0: 0, elapsed: 0, paused: false, raf: 0, holdT: 0, swipe: null, muted: false, gen: 0, seenT: 0, retryT: 0, retries: 0, waiting: false, replyFor: null, opt: { kind: opt.kind, userId: opt.userId, serverId: opt.serverId } };
  $('#story-view').classList.remove('hidden');
  document.body.classList.add('story-open');
  $('#sv-reply').value = '';
  svShow(ti, 0);
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
  $('#sv-name').textContent = tray.kind === 'mine' ? 'Your story' : (author.display_name || author.username || 'Story');
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
  const isMine = tray.kind === 'mine';
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
  // A refresh landed while the viewer is open (someone posted, an item
  // expired): rebuild the tray list in place, keeping the current item.
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
  const ii = cur ? items.findIndex((i) => i.id === cur.id) : 0;
  sv.ti = ti;
  sv.ii = Math.max(0, Math.min(ii < 0 ? 0 : ii, items.length - 1));
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
    const cur = svCurrentItem();
    if (cur && cur.id === storyId) svNext();
    else svSyncState();
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
function svMoreMenu(x, y) {
  if (!sv) return;
  const it = svCurrentItem();
  if (!it) return;
  const tray = sv.trays[sv.ti];
  const items = [
    { label: 'Copy link', icon: '⧉', fn: () => { try { navigator.clipboard.writeText(location.origin + it.url); toast('Link copied'); } catch {} } },
  ];
  if (tray.kind === 'mine') {
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
    const mine = storyData.mine;
    if (mine) {
      mine.items = (mine.items || []).filter((s) => s.id !== it.id);
      if (!mine.items.length) storyData.mine = null;
    }
    if (!sv) { renderStorySurfaces(); return; }
    const tray = sv.trays[sv.ti];
    if (tray && tray.kind === 'mine') {
      tray.items = storyLive(tray.items).filter((s) => s.id !== it.id);
      if (!tray.items.length) sv.trays.splice(sv.ti, 1);
    }
    renderStorySurfaces();
    if (!sv) return;
    if (!sv.trays.length) return svClose();
    const ti = Math.min(sv.ti, sv.trays.length - 1);
    const items = storyLive(sv.trays[ti].items);
    if (!items.length) { sv.ti = ti; sv.ii = 0; svNextTray(); }
    else svShow(ti, Math.min(sv.ii, items.length - 1));
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
    step: 'capture', camSeq: 0,
    // audiences: friends / everyone / servers (multi-select)
    audFriends: true, audEveryone: false, audServers: [],
    // view-once mode: pick friends instead of audiences, sends one DM each
    vo: !!opts.viewOnce, voIds: [],
    micCtx: null, micGain: null, micAnalyser: null, micTimer: null, micSource: null, micRaw: null, micLevel: 0,
  };
  if (opts.serverId) { sc.audServers = [opts.serverId]; sc.audFriends = true; }
  if (opts.everyone) sc.audEveryone = true;
  if (opts.viewOnce) { try { await ensureFriends(); } catch {} }
  storySetStep('capture');
  renderStoryAudience();
  paintScMic();
  await storyStartCam();
}
function storySetStep(step) {
  if (sc) sc.step = step;
  const capture = step === 'capture';
  $('#sc-cam').classList.toggle('hidden', !capture);
  // Entering capture clears the preview; entering preview keeps whichever
  // media element storyShowPreview just revealed (hiding both here would
  // blank the freshly captured shot).
  if (capture) { $('#sc-shot').classList.add('hidden'); $('#sc-play').classList.add('hidden'); }
  $('#sc-edit').classList.toggle('hidden', capture);
  $('#sc-foot').classList.toggle('hidden', !capture);
  $('#sc-bar').classList.toggle('hidden', capture);
  $('#sc-flip').classList.toggle('hidden', !capture || sc.camFailed);
  $('#sc-mic').classList.toggle('hidden', !capture || sc.camFailed || sc.mode !== 'video');
  if (capture) $('#sc-hint').classList.add('hidden');
}
async function storyStartCam() {
  if (!sc) return;
  storyStopCamTracks();
  // Any start already in flight is stale once a newer one begins (flip, or a
  // retake). Its stream must not be attached — nor may its tail-end UI reset
  // stomp on a preview the user reached while the camera was still opening.
  const gen = ++sc.camSeq;
  const vid = $('#sc-cam');
  if (!storyCamSupported()) {
    sc.camFailed = true;
    storyCamHint('Camera not available here — pick a photo or video instead.');
    storySetStep('capture');
    return;
  }
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: sc.facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (err) {
    if (!sc || gen !== sc.camSeq || sc.step !== 'capture') return;
    sc.camFailed = true;
    storyCamHint('Camera blocked — allow access, or pick a photo/video instead.');
    storySetStep('capture');
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
  storyCamHint('');
  storySetStep('capture');
}
function storyStopCamTracks() {
  if (!sc) return;
  sc.camSeq = (sc.camSeq || 0) + 1; // invalidate any in-flight start
  try { if (sc.stream) sc.stream.getTracks().forEach((t) => t.stop()); } catch {}
  storyStopMic();
  sc.stream = null; sc.audio = null;
  const vid = $('#sc-cam');
  if (vid) vid.srcObject = null;
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
          sc.micLevel = Math.min(1, rms * 8);
          paintScLevel();
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
  paintScLevel();
}
function paintScLevel() {
  const bar = $('#sc-level-fill');
  if (!bar) return;
  const lvl = sc && sc.audio && !sc.micDenied ? (sc.micLevel || 0) : 0;
  bar.style.width = Math.round(lvl * 100) + '%';
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
  sc.micLevel = 0;
  paintScLevel();
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
function captureStoryPhoto() {
  const vid = $('#sc-cam');
  if (!sc || !vid || !vid.videoWidth) { toast('Camera is still starting'); return; }
  const w = vid.videoWidth, h = vid.videoHeight;
  const scale = Math.min(1, STORY_MAX_EDGE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  try {
    c.getContext('2d').drawImage(vid, 0, 0, c.width, c.height);
    c.toBlob((blob) => {
      if (!blob || !sc) return;
      storyShowPreview(blob, 'image', 0);
    }, 'image/jpeg', 0.92);
  } catch { toast('Could not capture that frame'); }
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
function storyShowPreview(blob, kind, durationMs) {
  if (!sc) return;
  storyStopRec();
  storyStopCamTracks();
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
  } else {
    vid.classList.add('hidden');
    vid.removeAttribute('src');
    img.classList.remove('hidden');
    img.src = sc.previewUrl;
  }
  storySetStep('preview');
  renderStoryAudience();
  $('#sc-post').disabled = false;
  $('#sc-post').textContent = sc.vo ? 'Send' : 'Post story';
  storyProgress(null);
  renderStoryAudience();
}
function storyRetake() {
  if (!sc) return;
  if (sc.previewUrl) { try { URL.revokeObjectURL(sc.previewUrl); } catch {} }
  sc.previewUrl = null; sc.blob = null; sc.kind = null; sc.durationMs = 0;
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
  return (sc.audFriends ? 1 : 0) + (sc.audEveryone ? 1 : 0) + (sc.audServers || []).length;
}
// View-once recipients: your friends, pick as many as you like. Each one gets
// their own DM (never a group), so the view/replay bookkeeping stays per chat.
function renderViewOnceRecipients() {
  const box = $('#sc-aud');
  if (!box || !sc) return;
  box.innerHTML = '';
  const friends = [...((S.friends && S.friends.friends) || [])].sort((a, b) => String(a.display_name || '').localeCompare(String(b.display_name || '')));
  for (const f of friends) {
    const on = sc.voIds.includes(f.id);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sc-chip' + (on ? ' sel' : '');
    b.textContent = f.display_name || f.username;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.onclick = () => {
      sc.voIds = on ? sc.voIds.filter((x) => x !== f.id) : [...sc.voIds, f.id];
      renderStoryAudience();
    };
    box.appendChild(b);
  }
  const hint = $('#sc-aud-hint');
  if (hint) {
    hint.textContent = !friends.length ? 'Add friends first — view-once items go to friends only'
      : (sc.voIds.length ? `Sends ${sc.voIds.length === 1 ? 'a separate DM to 1 friend' : sc.voIds.length + ' separate DMs'}` : 'Pick who gets it');
  }
  const post = $('#sc-post');
  if (post) {
    post.disabled = !sc.voIds.length || !!sc.busy;
    if (!sc.busy) post.textContent = sc.voIds.length ? `Send (${sc.voIds.length})` : 'Send';
  }
  const wrap = $('#sc-edit .sc-vo-note');
  if (!wrap) {
    const n = document.createElement('p');
    n.className = 'sc-vo-note';
    n.textContent = 'View once · they can replay it one time, then it is deleted';
    const host = $('#sc-edit');
    if (host) host.appendChild(n);
  }
}
// Audience chips are a multi-select: a post can go to friends, to everyone on
// this Campfire, and to any number of servers in one shot.
function renderStoryAudience() {
  const box = $('#sc-aud');
  if (!box || !sc) return;
  if (sc.vo) return renderViewOnceRecipients();
  box.innerHTML = '';
  const chip = (label, selected, onToggle, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sc-chip' + (selected ? ' sel' : '');
    b.textContent = label;
    if (title) b.title = title;
    b.setAttribute('aria-pressed', selected ? 'true' : 'false');
    b.onclick = () => { onToggle(); renderStoryAudience(); };
    box.appendChild(b);
    return b;
  };
  chip('Friends', !!sc.audFriends, () => { sc.audFriends = !sc.audFriends; }, 'Your friends see it in their Home rail');
  chip('Everyone', !!sc.audEveryone, () => { sc.audEveryone = !sc.audEveryone; }, 'Any account on this Campfire can watch it');
  for (const s of S.servers || []) {
    const on = (sc.audServers || []).includes(s.id);
    chip(s.name, on, () => {
      sc.audServers = on ? sc.audServers.filter((x) => x !== s.id) : [...(sc.audServers || []), s.id];
    }, 'Everyone in this server');
  }
  const hint = $('#sc-aud-hint');
  if (hint) hint.textContent = storyAudCount() ? '' : 'Pick at least one audience';
  const post = $('#sc-post');
  if (post) post.disabled = !storyAudCount() || !!sc.busy;
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
  const cam = $('#sc-cam');
  if (cam) cam.srcObject = null;
  const play = $('#sc-play');
  if (play) { try { play.pause(); } catch {} play.removeAttribute('src'); }
  const shot = $('#sc-shot');
  if (shot) shot.removeAttribute('src');
  const cap = $('#sc-caption');
  if (cap) cap.value = '';
  $('#sc-file').value = '';
  storyProgress(null);
  $('#story-compose').classList.add('hidden');
  if (!$('#story-view') || $('#story-view').classList.contains('hidden')) document.body.classList.remove('story-open');
}
// Downscale a picked photo (max long edge 1920, JPEG) so phone photos don't
// burn upload bandwidth. Any failure falls back to the original file.
async function storyDownscaleImage(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, STORY_MAX_EDGE / Math.max(bmp.width, bmp.height));
    if (scale >= 1 && file.size < 2 * 1024 * 1024) { try { bmp.close(); } catch {} return file; }
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    try { bmp.close(); } catch {}
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
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
    const img = await storyDownscaleImage(file);
    storyShowPreview(img, 'image', 0);
  } else if (file.type.startsWith('video/')) {
    if (file.size > S.maxUploadMb * 1024 * 1024) { toast(`Videos are limited to ${S.maxUploadMb}MB`); return; }
    storyShowPreview(file, 'video', await storyVideoDuration(file));
  } else {
    toast('Pick a photo or a video');
  }
}
async function storyPostNow() {
  if (!sc || sc.busy || !sc.blob) return;
  const st = sc;
  st.busy = true;
  const btn = $('#sc-post');
  btn.disabled = true;
  btn.textContent = 'Uploading…';
  const caption = ($('#sc-caption').value || '').trim().slice(0, 200);
  const fd = new FormData();
  const type = st.blob.type || (st.kind === 'video' ? 'video/webm' : 'image/jpeg');
  fd.append('file', new File([st.blob], (st.vo ? 'viewonce-' : 'story-') + Date.now() + '.' + storyExtFor(type), { type }));
  const up = await new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    st.xhr = xhr;
    xhr.open('POST', st.vo ? '/api/upload/viewonce' : '/api/upload');
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
  if (up.error) { st.busy = false; btn.disabled = false; btn.textContent = 'Post story'; storyProgress(null); toast('Upload failed: ' + prettyError(up.error)); return; }
  if (up.scan === 'infected') { st.busy = false; btn.disabled = false; btn.textContent = st.vo ? 'Send' : 'Post story'; storyProgress(null); toast('That file was blocked by the scanner'); return; }
  if (st.vo) {
    btn.textContent = 'Sending…';
    try {
      const r = await sendViewOnce({ url: up.url, mime: up.mime, kind: up.kind || st.kind, caption, userIds: st.voIds });
      storyProgress(null);
      closeStoryComposer();
      toast(r.sent === 1 ? 'View-once sent' : `View-once sent to ${r.sent} friends`);
      refreshDms().catch(() => {});
    } catch (err) {
      st.busy = false; btn.disabled = false; btn.textContent = 'Send'; storyProgress(null);
      toast('Could not send: ' + prettyError(err.message));
    }
    return;
  }
  btn.textContent = 'Posting…';
  try {
    await api('/api/stories', {
      method: 'POST',
      body: JSON.stringify({
        url: up.url, mime: up.mime, kind: st.kind, caption,
        friends: !!st.audFriends, everyone: !!st.audEveryone, servers: st.audServers || [],
        durationMs: st.durationMs || undefined,
      }),
    });
  } catch (err) {
    st.busy = false; btn.disabled = false; btn.textContent = 'Post story'; storyProgress(null);
    toast('Could not post: ' + prettyError(err.message));
    return;
  }
  storyProgress(null);
  closeStoryComposer();
  toast('Story posted — live for 24 hours');
  await loadStories();
  renderStorySurfaces();
  // Straight into the viewer so it can be checked (and deleted) at once.
  setTimeout(() => { if (!sv) openStoryViewer({ kind: 'mine' }); }, 120);
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
  let held = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return;
    held = false;
    clearTimeout(svHoldT);
    svHoldT = setTimeout(() => { held = true; svPause(); }, 200);
  });
  const up = () => {
    clearTimeout(svHoldT);
    if (held) { held = false; svResume(); return; }
    fn();
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', () => { clearTimeout(svHoldT); held = false; svResume(); });
  el.addEventListener('pointerleave', () => { if (held) { clearTimeout(svHoldT); held = false; svResume(); } });
}
let svHoldT = 0;
storyZoneEl($('#sv-next'), () => sv && svNext());
storyZoneEl($('#sv-prev'), () => sv && svPrev());
// Swipe down on the stage closes the viewer.
(function () {
  const stage = $('#sv-stage');
  let sx = 0, sy = 0, active = false;
  stage.addEventListener('pointerdown', (e) => { active = true; sx = e.clientX; sy = e.clientY; });
  stage.addEventListener('pointerup', (e) => {
    if (!active) return;
    active = false;
    const dy = e.clientY - sy, dx = Math.abs(e.clientX - sx);
    if (dy > 90 && dx < 80) svClose();
  });
  stage.addEventListener('pointercancel', () => { active = false; });
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
$('#sc-shutter').onclick = () => storyShutter();
$('#sc-flip').onclick = () => storyFlipCam();
$('#sc-mic').onclick = () => storyToggleMic();
$('#sc-gallery').onclick = () => $('#sc-file').click();
$('#sc-retake').onclick = () => storyRetake();
$('#sc-post').onclick = () => storyPostNow();
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
