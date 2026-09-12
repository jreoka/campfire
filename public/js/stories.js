'use strict';
/* ================= stories: 24-hour photo/video posts =================
   A story is a photo (or a video shot in-app or picked from the gallery)
   that friends — or everyone in one server — can watch for 24 hours.

   Surfaces:
     - #stories-page the story center (Home → Stories): your story's numbers,
                     everyone else's live posts, and the servers you share
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
// Quick reactions. A small fixed set, mirrored by the server's allowlist, so the
// rail, the float-up animation and the author's viewer list all agree on what
// can be sent. Each tap adds another copy of that emoji up to SV_REACTION_MAX;
// tapping a maxed-out one takes all of that person's copies back.
const SV_REACTIONS = ['❤️', '😂', '😮', '😢', '🔥', '👏'];
const SV_REACTION_MAX = 4; // matches the server cap (STORY_REACTION_MAX)

// Icon set (inline SVG, no emoji — see the design language in AGENTS.md).
const svSvg = {
  plus: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  users: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  check: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  eye: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  clock: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.4 2"/></svg>',
  camera: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-2.5h6L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.2"/></svg>',
  soundOn: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z" fill="currentColor" stroke="none"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
  soundOff: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z" fill="currentColor" stroke="none"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5"/></svg>',
  mic: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3"/></svg>',
  micOff: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9V5a3 3 0 0 1 6 0v6"/><path d="M5 10a7 7 0 0 0 10.5 6.1M12 19v3"/><path d="M4 4l16 16"/></svg>',
};

// Trays as the API returns them. `everyone` is legacy: the composer no longer
// offers an instance-wide post and the server refuses to create one, but a row
// posted before that still reads back (and shows in trays) until its 24h run out.
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
  add(storyData.everyone, false); // legacy instance-wide posts
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
  try { renderStoriesPage(); } catch {}
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
// A story's bytes are not servable the instant the upload finishes: the
// /uploads gate answers 423 until the scanner's verdict lands, which an <img>
// (or <video>) reads as an error. Give a thumbnail a couple of tries before
// falling back, or a story posted a second ago shows up as a bare ring.
function storyThumbRetry(media, giveUp) {
  let tries = 0;
  media.addEventListener('error', () => {
    if (!media.isConnected) return;
    if (tries >= 2) { giveUp(); return; }
    tries++;
    setTimeout(() => {
      if (!media.isConnected) return;
      const src = media.getAttribute('src') || '';
      if (!src) return;
      // A fresh cache key, or the browser may hand back the same 423 it cached.
      media.setAttribute('src', src.split('?')[0] + '?v=' + Date.now().toString(36));
    }, 900 * tries);
  });
}
function storyThumbMedia(it) {
  if (it.kind === 'video') {
    const el = document.createElement('video');
    el.muted = true;
    el.defaultMuted = true;
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.preload = 'metadata';
    el.onloadeddata = () => { try { el.currentTime = 0.06; } catch {} };
    el.src = it.url;
    return el;
  }
  const el = document.createElement('img');
  el.alt = '';
  // No loading=lazy: this is a 49px preview that is on screen the moment it is
  // built, and a deferred image that never gets its turn reads as a bare ring.
  el.decoding = 'async';
  el.src = it.url;
  return el;
}
function storyThumbEl(it, cls) {
  if (!it) return null;
  const ovs = ovParse(it.overlays);
  const media = storyThumbMedia(it);
  if (!ovs.length) {
    media.className = cls || 'st-thumb';
    storyThumbRetry(media, () => { try { media.remove(); } catch {} });
    return media;
  }
  return storyThumbWithMarkup(media, cls, ovs);
}
/* A ring thumbnail is the story's MEDIA, and the markup rides beside the bytes
 * (see story-edit.js) — so without this a text-only story previewed as a bare
 * gradient, and every other shot lost its text. The wrapper is the
 * cookie-cutter circle; the layer is fitted to the photo with the fit the ring
 * uses (cover), so an item near the edge is cropped exactly where the picture
 * is. Fitting has to wait for layout (and for the media's intrinsic size), and
 * it is a no-op if the ring was rebuilt and dropped this element. */
function storyThumbWithMarkup(media, cls, ovs) {
  const wrap = document.createElement('span');
  wrap.className = (cls || 'st-thumb') + ' st-thumb-ov';
  // The media gets its OWN class inside the wrapper: it must not inherit the
  // cookie-cutter positioning (.st-thumb is inset into its parent), which left
  // it offset and clipped a second time.
  media.className = 'st-thumb-media';
  wrap.appendChild(media);
  const layer = document.createElement('span');
  layer.className = 'ov-layer';
  wrap.appendChild(layer);
  // If the media never loads, the whole thumbnail goes, so the ring falls back
  // to the avatar exactly like the plain path — leaving the wrapper behind
  // would strand a ring with no picture under its markup.
  storyThumbRetry(media, () => { try { wrap.remove(); } catch {} });
  const fit = () => {
    if (!wrap.isConnected) return;
    try {
      if (!ovFitLayer(layer, wrap, media, 'cover')) return;
      ovPaintLayer(layer, ovs, { editable: false });
    } catch {}
  };
  const refit = () => requestAnimationFrame(fit);
  requestAnimationFrame(fit);
  if (media.tagName === 'IMG') media.addEventListener('load', refit, { once: true });
  else media.addEventListener('loadeddata', refit, { once: true });
  return wrap;
}
function storyRing(user, unseen, items) {
  const mine = !!(typeof S !== 'undefined' && S && S.me && user && user.id === S.me.id);
  const ring = document.createElement('span');
  // Two different things, two different classes. `seen` is the ring's own
  // colour (accent while something waits, hairline once it is watched) and
  // applies to everyone; `muted` desaturates the PHOTO and only ever means
  // "you have already watched this". Your own story is never muted — you
  // cannot watch your own post, and greying it turned a flat-coloured story
  // (a text-only gradient, say) into a dead grey disc in the rail.
  ring.className = 'st-ring' + (unseen ? '' : ' seen') + (!mine && !unseen ? ' muted' : '');
  const av = document.createElement('span');
  av.className = 'avatar';
  paintAvatar(av, user || { display_name: '?' });
  ring.appendChild(av);
  const thumb = storyThumbEl(storyThumbItem(items));
  if (thumb) ring.appendChild(thumb);
  return ring;
}
// ---------- story center (Home → Stories) ----------
// The full page behind the sidebar's Stories row: your own story with its
// numbers, then everyone else's live posts, then the servers you share it
// with. (The old horizontal strip at the top of Friends is gone.)
function storyLeft(ts) {
  const ms = Math.max(0, Number(ts) - Date.now());
  const h = Math.floor(ms / 3600000);
  if (h >= 1) return h + 'h left';
  return Math.max(1, Math.round(ms / 60000)) + 'm left';
}
function spChip(icon, text, title) {
  const c = document.createElement('span');
  c.className = 'sp-chip';
  if (title) c.title = title;
  c.innerHTML = icon + '<span>' + text + '</span>';
  return c;
}
function spSection(label) {
  const s = document.createElement('div');
  s.className = 'sp-sec';
  s.textContent = label;
  return s;
}
// One card per person: their latest frame, who it is, how many are waiting.
function spCard(t) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sp-card' + (t.unseen > 0 ? '' : ' seen');
  const name = t.user.display_name || t.user.username || 'User';
  b.title = t.unseen > 0 ? `Watch ${name} — ${t.unseen} new` : `Watch ${name}'s story again`;
  const media = storyThumbEl(storyThumbItem(t.items), 'sp-card-media');
  if (media) b.appendChild(media);
  const ago = document.createElement('span');
  ago.className = 'sp-card-ago';
  ago.textContent = storyAgo(t.latest || ((t.items[t.items.length - 1] || {}).created_at) || Date.now());
  b.appendChild(ago);
  if (t.unseen > 0) {
    const n = document.createElement('span');
    n.className = 'sp-card-new';
    n.textContent = t.unseen > 9 ? '9+' : String(t.unseen);
    b.appendChild(n);
  }
  const who = document.createElement('span');
  who.className = 'sp-card-who';
  const av = document.createElement('span');
  av.className = 'avatar';
  paintAvatar(av, t.user);
  const nm = document.createElement('span');
  nm.className = 'sp-card-name';
  nm.textContent = name;
  who.append(av, nm);
  b.appendChild(who);
  b.onclick = () => openStoryViewer({ kind: 'user', userId: t.id });
  return b;
}
function spGrid(trays) {
  const g = document.createElement('div');
  g.className = 'sp-grid';
  for (const t of trays) g.appendChild(spCard(t));
  return g;
}
function spServerRow(srvTrays) {
  const row = document.createElement('div');
  row.className = 'sp-srv-row';
  for (const t of srvTrays) {
    const unseen = serverTrayUnseen(t);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sp-srv';
    b.title = unseen ? `Watch ${unseen} new in ${t.server.name}` : `Watch ${t.server.name}'s stories`;
    const ic = document.createElement('span');
    ic.className = 'sp-srv-ic';
    if (t.server.icon_url) {
      const img = document.createElement('img');
      img.src = t.server.icon_url;
      img.alt = '';
      ic.appendChild(img);
    } else ic.textContent = (t.server.name || 'S').slice(0, 1).toUpperCase();
    const nm = document.createElement('span');
    nm.className = 'sp-srv-name';
    nm.textContent = t.server.name || 'Server';
    b.append(ic, nm);
    const chip = document.createElement('span');
    chip.className = 'sp-srv-chip' + (unseen ? '' : ' seen');
    chip.textContent = unseen ? unseen + ' new' : 'Seen';
    b.appendChild(chip);
    b.onclick = () => openStoryViewer({ kind: 'server', serverId: t.server.id, unseen: true });
    row.appendChild(b);
  }
  return row;
}
// The hero: your story, its numbers, and the way in (watch / add).
function spHero(mineItems) {
  const latest = mineItems[mineItems.length - 1] || null;
  const hero = document.createElement('div');
  hero.className = 'sp-hero' + (latest ? '' : ' sp-hero-empty');
  if (latest) {
    const media = storyThumbEl(latest, 'sp-hero-media');
    if (media) hero.appendChild(media);
  }
  const inn = document.createElement('div');
  inn.className = 'sp-hero-in';
  const badge = document.createElement('span');
  badge.className = 'sp-hero-badge';
  if (latest) {
    const av = document.createElement('span');
    av.className = 'avatar';
    paintAvatar(av, S.me);
    const thumb = storyThumbEl(storyThumbItem(mineItems), 'st-thumb-inline');
    if (thumb) av.appendChild(thumb);
    badge.appendChild(av);
  } else badge.innerHTML = svSvg.camera;
  inn.appendChild(badge);

  const txt = document.createElement('div');
  txt.className = 'sp-hero-txt';
  const title = document.createElement('div');
  title.className = 'sp-hero-title';
  title.textContent = latest ? 'Your story' : 'Your story starts here';
  const sub = document.createElement('div');
  sub.className = 'sp-hero-sub';
  sub.textContent = latest
    ? `${mineItems.length} ${mineItems.length === 1 ? 'post' : 'posts'} · posted ${storyAgo(latest.created_at)}`
    : 'Share a photo or a video — it disappears after 24 hours.';
  txt.append(title, sub);

  if (latest) {
    const stats = document.createElement('div');
    stats.className = 'sp-hero-stats';
    const views = mineItems.reduce((n, i) => n + (Number(i.views) || 0), 0);
    stats.appendChild(spChip(svSvg.eye, views === 1 ? '1 view' : views + ' views', 'Views across your live posts'));
    const tally = new Map();
    let reacts = 0;
    for (const it of mineItems) for (const r of (it.reactions || [])) { tally.set(r.emoji, (tally.get(r.emoji) || 0) + (Number(r.count) || 0)); reacts += Number(r.count) || 0; }
    if (reacts) {
      const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const c = document.createElement('span');
      c.className = 'sp-chip sp-chip-rx';
      c.title = 'Reactions on your story';
      c.innerHTML = top.map(([e, n]) => `<span class="sp-rx">${esc(e)}${n > 1 ? `<b>${n}</b>` : ''}</span>`).join('')
        + `<span>${reacts === 1 ? '1 reaction' : reacts + ' reactions'}</span>`;
      stats.appendChild(c);
    }
    stats.appendChild(spChip(svSvg.clock, storyLeft(latest.expires_at), 'Time until your newest post expires'));
    txt.appendChild(stats);
    // Who watched — filled in from the viewers route below (one request).
    const who = document.createElement('button');
    who.type = 'button';
    who.className = 'sp-hero-viewers hidden';
    txt.appendChild(who);
  }
  inn.appendChild(txt);

  const btns = document.createElement('div');
  btns.className = 'sp-hero-btns';
  if (latest) {
    const watch = document.createElement('button');
    watch.type = 'button';
    watch.className = 'btn small primary';
    watch.textContent = 'Watch';
    watch.onclick = () => openStoryViewer({ kind: 'mine' });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn small';
    add.textContent = 'Add';
    add.title = 'Add another post to your story';
    add.onclick = () => createStory({});
    btns.append(watch, add);
  } else {
    const post = document.createElement('button');
    post.type = 'button';
    post.className = 'btn small primary';
    post.textContent = 'Post a story';
    post.onclick = () => createStory({});
    btns.appendChild(post);
  }
  inn.appendChild(btns);
  hero.appendChild(inn);
  return hero;
}
function spEmpty() {
  const box = document.createElement('div');
  box.className = 'sp-empty';
  const ic = document.createElement('span');
  ic.className = 'sp-empty-ic';
  ic.innerHTML = svSvg.camera;
  const h = document.createElement('div');
  h.className = 'sp-empty-title';
  h.textContent = 'No stories right now';
  const p = document.createElement('p');
  p.className = 'muted small';
  p.textContent = 'Your story, and your friends\u2019 stories, all in one place.';
  const tips = document.createElement('div');
  tips.className = 'sp-tips';
  for (const t of [
    'Post a photo or a video — straight from the camera, or from your gallery.',
    'Everything here lasts 24 hours, then it disappears.',
    'Reply to a friend privately, or tap an emoji while you watch.',
  ]) {
    const row = document.createElement('span');
    row.className = 'sp-tip';
    row.textContent = t;
    tips.appendChild(row);
  }
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn small primary';
  b.textContent = 'Post a story';
  b.onclick = () => createStory({});
  box.append(ic, h, p, tips, b);
  return box;
}
// One viewers request fills the hero's "who watched" row; it is the same panel
// the viewer's "N views" button opens.
let spViewersGen = 0;
async function spLoadHeroViewers(mineItems, hero) {
  const it = [...mineItems].reverse().find((i) => (Number(i.views) || 0) > 0);
  if (!it) return;
  const gen = ++spViewersGen;
  let viewers = [];
  try { ({ viewers } = await api('/api/stories/' + encodeURIComponent(it.id) + '/viewers')); } catch { return; }
  if (gen !== spViewersGen) return;
  const slot = hero.querySelector('.sp-hero-viewers');
  if (!slot || !viewers.length) return;
  const stack = document.createElement('span');
  stack.className = 'sp-vstack';
  for (const u of viewers.slice(0, 5)) {
    const a = document.createElement('span');
    a.className = 'avatar';
    paintAvatar(a, u);
    stack.appendChild(a);
  }
  const txt = document.createElement('span');
  // Deliberately not a count: the chip above already reports views, and two
  // different numbers side by side read as one wrong one.
  txt.textContent = 'See who watched';
  slot.append(stack, txt);
  slot.title = 'See who watched';
  slot.classList.remove('hidden');
  slot.onclick = () => { storyViewersModal(it); };
}
function renderStoriesPage() {
  const page = $('#stories-page');
  const body = $('#sp-body');
  if (!page || page.classList.contains('hidden') || !body || !S.me) return;
  const mineItems = storyLive(storyData.mine && storyData.mine.items);
  const trays = storyUserTrays();
  const fresh = trays.filter((t) => t.unseen > 0);
  const watched = trays.filter((t) => !t.unseen);
  const srvTrays = (storyData.servers || []).filter((t) => storyLive(t.items).length);
  const unseen = fresh.reduce((n, t) => n + t.unseen, 0);
  // The summary line only speaks when it has something to say. An empty tray
  // is already spelled out by the welcome panel below, so it never renders a
  // "nothing live" line here (and the element is hidden rather than left as an
  // empty box in the header).
  const sub = $('#sp-sub');
  if (sub) {
    const summary = unseen
      ? `${unseen} new ${unseen === 1 ? 'story' : 'stories'} from ${fresh.length} ${fresh.length === 1 ? 'person' : 'people'}`
      : (trays.length ? `${trays.length} ${trays.length === 1 ? 'person' : 'people'} with live stories` : '');
    sub.textContent = summary;
    sub.classList.toggle('hidden', !summary);
  }
  body.innerHTML = '';
  const nothing = !mineItems.length && !trays.length && !srvTrays.length;
  // Nothing live anywhere: one welcome panel, never a "your story" slot stacked
  // on top of an empty-state card saying the same thing twice.
  if (nothing) body.appendChild(spEmpty());
  else {
    body.appendChild(spHero(mineItems));
    if (fresh.length) { body.appendChild(spSection('New stories')); body.appendChild(spGrid(fresh)); }
    if (watched.length) { body.appendChild(spSection('Already watched')); body.appendChild(spGrid(watched)); }
    if (srvTrays.length) { body.appendChild(spSection('Servers')); body.appendChild(spServerRow(srvTrays)); }
  }
  if (mineItems.length) spLoadHeroViewers(mineItems, body.firstChild);
}

// Sidebar Stories row → the story center in the main panel (the full page).
// The server sidebar's Stories row still opens the compact sheet — that one is
// scoped to a single server and is a quick look, not a destination.
async function showStoriesPanel() {
  if (S.view !== 'home') await openHome({ panel: 'stories', dm: null });
  flushDrafts();
  saveScrollPos();
  S.homePanel = 'stories';
  S.dmThreadId = null;
  renderDmBlank();
  rememberView();
  rememberHomeTab();
  try { await loadStories(); } catch {}
  renderStorySurfaces();
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
  // The ＋ is a SIBLING of the row, pinned over the row's trailing edge — the
  // exact slot Home's Stories row uses (.stories ＋ at .6rem from the sidebar's
  // edge). It used to sit at the end of the row's text flow, so it landed only
  // .1rem after the "N new"/"Be the first" chip while the Home ＋ sat on the
  // column every trailing action in that list shares. The row's own box comes
  // from .srv-stories (it owns the margins), so nothing has to be re-inset here.
  const wrap = document.createElement('div');
  wrap.className = 'srv-stories-wrap';
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
  add.onclick = (e) => { e.stopPropagation(); createStory({ serverId: S.serverId }); };
  const open = () => openStoriesSheet({ serverId: S.serverId, name: S.serverDetail.name });
  row.onclick = open;
  row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  wrap.appendChild(row);
  wrap.appendChild(add);
  box.appendChild(wrap);
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
// On both surfaces the picture IS the story affordance: the ring + cropped
// thumb already say "there is a story here", so clicking the avatar opens it —
// there is no separate "Watch story" button to add back. `opts.ring` is the
// ring width that surface wants and `opts.close` is what closing its host
// means (the card pops away, the profile screen closes).
function clearStoryAvatar(av) {
  if (!av) return;
  const thumb = av.querySelector('.st-thumb-inline');
  if (thumb) thumb.remove();
  av.style.boxShadow = '';
  av.classList.remove('st-click');
  av.removeAttribute('role');
  av.removeAttribute('tabindex');
  av.removeAttribute('aria-label');
  av.removeAttribute('title');
  av.onclick = null;
  av.onkeydown = null;
}
function paintStoryAvatar(av, u, opts = {}) {
  if (!av || !u || !S.me || u.id === S.me.id) return false;
  const tray = storyTrayFor(u.id);
  const items = tray ? storyLive(tray.items) : [];
  // Both hosts repaint the same avatar element (the profile screen keeps one
  // for good), so a story that has since expired must not leave its ring,
  // thumb or handler behind on the next person's profile.
  clearStoryAvatar(av);
  if (!items.length) return false;
  const unseen = items.some((i) => !i.seen);
  av.style.boxShadow = '0 0 0 ' + (opts.ring || '2.5px') + ' ' + (unseen ? 'var(--accent)' : 'var(--line)');
  try {
    // The thumbnail goes INSIDE the avatar element: .avatar{overflow:hidden}
    // clips it to the same circle, so its antialiased edge never blends with
    // the person's avatar color at the rim.
    if (getComputedStyle(av).position === 'static') av.style.position = 'relative';
    const thumb = storyThumbEl(storyThumbItem(items), 'st-thumb-inline');
    if (thumb) av.appendChild(thumb);
  } catch {}
  av.classList.add('st-click');
  av.setAttribute('role', 'button');
  av.setAttribute('tabindex', '0');
  const label = unseen ? 'Watch story' : 'Watch story (seen)';
  av.title = label;
  av.setAttribute('aria-label', label);
  const open = () => {
    try { if (opts.close) opts.close(); } catch {}
    openStoryViewer({ kind: 'user', userId: u.id });
  };
  av.onclick = open;
  av.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  };
  return true;
}
function paintUserCardStory(card, u) {
  if (!card) return;
  paintStoryAvatar(card.querySelector('.uc-head .avatar'), u, { close: () => { try { closeUserCard(); } catch {} } });
}
// Same affordance inside the full profile screen (no button beside it).
function paintProfileStory(u) {
  paintStoryAvatar($('#pf-avatar'), u, { ring: '3px', close: () => { try { closeProfileScreen(); } catch {} } });
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
    b.onclick = () => { $('#modal-backdrop').classList.add('hidden'); createStory({ serverId: serverIdForPost || null }); };
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
      p.textContent = 'No stories right now. Post one — your friends see it in their Home rail, and you can also share it with a specific server.';
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
  if (shared.everyone) bits.push('Everyone'); // legacy posts only (see storyData)
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
  sv = { trays, ti: 0, ii: 0, dur: STORY_IMG_MS, t0: 0, elapsed: 0, paused: false, raf: 0, holdT: 0, swipe: null, muted: false, gen: 0, seenT: 0, retryT: 0, retries: 0, waiting: false, replyFor: null, burstT: [], opt: { kind: opt.kind, userId: opt.userId, serverId: opt.serverId } };
  $('#story-view').classList.remove('hidden');
  document.body.classList.add('story-open');
  $('#sv-reply').value = '';
  svShow(ti, ii);
}
// A story's text/emoji/drawing markup, laid over the media. Normalised
// coordinates mean the viewer only has to find the picture's content box
// (object-fit:contain inside the stage), which it can only do once the bytes
// have decoded — hence the call from ready(), not from svShow.
function svPaintOverlays() {
  const layer = $('#sv-ov');
  if (!layer) return;
  if (!sv) { layer.classList.add('hidden'); return; }
  const it = svCurrentItem();
  const ovs = ovParse(it && it.overlays);
  if (!ovs.length) { layer.textContent = ''; layer.classList.add('hidden'); return; }
  const media = it.kind === 'video' ? $('#sv-vid') : $('#sv-img');
  if (!ovFitLayer(layer, $('#sv-stage'), media)) return;
  ovPaintLayer(layer, ovs, { editable: false });
}
function svTeardown() {
  if (!sv) return;
  cancelAnimationFrame(sv.raf);
  clearTimeout(sv.seenT);
  clearTimeout(sv.retryT);
  clearTimeout(sv.holdT);
  for (const t of sv.burstT || []) clearTimeout(t);
  sv.burstT = [];
  // The floats are mid-animation (a story can be skipped while they rise): drop
  // them or they linger over the next story.
  const floats = $('#sv-floats');
  if (floats) floats.textContent = '';
  const react = $('#sv-react');
  if (react) { react.textContent = ''; react.classList.add('hidden'); }
  try { $('#sv-vid').pause(); } catch {}
  $('#sv-vid').removeAttribute('src');
  $('#sv-img').removeAttribute('src');
  const ov = $('#sv-ov');
  if (ov) { ov.textContent = ''; ov.classList.add('hidden'); }
  // A half-finished swipe-down must not leave the overlay offset for the next
  // open (the gesture moves the whole #story-view, not just the media).
  const root = $('#story-view');
  root.style.transform = '';
  root.style.transition = '';
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
  // The header is who posted it and the way into their profile: the whole
  // block (picture + name) is one button.
  const who = $('#sv-who');
  if (who) {
    const aid = (author && author.id) || null;
    sv.whoId = aid;
    sv.whoUser = aid ? author : null;
    who.disabled = !aid;
    who.title = aid ? 'View profile' : '';
  }
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
  $('#sv-ov').classList.add('hidden');
  $('#sv-ov').textContent = '';
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
    svPaintOverlays(); // markup only lands once the picture has a real box
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

  // Reactions: paint the rail for this item, then replay what people already
  // left so a new viewer sees what the room thought of it.
  svRenderReactions();
  svStartReactionBurst(it);
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
  svRenderReactions();
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

// ---------- quick reactions ----------
// The rail sits under the stage. Each tap adds another copy of that emoji (up
// to SV_REACTION_MAX, like mashing the button on a live stream): a haptic tick
// and a copy of it floats up out of the button. A tap on a maxed-out emoji takes
// all of that person's copies back. On your own story the same row shows the
// counts only — who reacted what lives under "Who watched".
function svMyCount(it, emoji) {
  const e = (it && it.myReactions || []).find((r) => r && r.emoji === emoji);
  return (e && e.count) || 0;
}
function svRenderReactions() {
  const row = $('#sv-react');
  if (!row) return;
  row.textContent = '';
  const it = svCurrentItem();
  if (!it || !sv) { row.classList.add('hidden'); return; }
  const counts = (Array.isArray(it.reactions) ? it.reactions : []).filter((r) => r && r.emoji && r.count > 0);
  if (svItemIsMine(sv.trays[sv.ti], it)) {
    for (const r of counts) {
      const chip = document.createElement('span');
      chip.className = 'sv-rx-chip';
      chip.innerHTML = `<span>${esc(r.emoji)}</span><b>${r.count}</b>`;
      chip.title = r.count + ' reaction' + (r.count === 1 ? '' : 's');
      row.appendChild(chip);
    }
    row.classList.toggle('hidden', !counts.length);
    return;
  }
  for (const e of SV_REACTIONS) {
    const n = svMyCount(it, e);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sv-re' + (n ? ' on' : '');
    // The little badge is how you tell one tap from four, and it is why the
    // maxed-out tap (which clears them) is discoverable.
    b.innerHTML = n
      ? `<span class="sv-re-e">${esc(e)}</span><span class="sv-re-n">${n >= SV_REACTION_MAX ? SV_REACTION_MAX : n}</span>`
      : `<span class="sv-re-e">${esc(e)}</span>`;
    b.title = n >= SV_REACTION_MAX ? 'Clear your reactions' : (n ? `Send another ${e} (${n}/${SV_REACTION_MAX})` : 'React with ' + e);
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-pressed', n ? 'true' : 'false');
    b.dataset.n = String(n);
    b.onclick = () => svReact(e, b);
    row.appendChild(b);
  }
  // A running total beside the rail, so a viewer can see the room's reaction
  // without opening anything.
  const total = counts.reduce((a, r) => a + r.count, 0);
  if (total) {
    const chip = document.createElement('span');
    chip.className = 'sv-rx-chip';
    chip.innerHTML = `<b>${total}</b>`;
    chip.title = total === 1 ? '1 reaction' : total + ' reactions';
    row.appendChild(chip);
  }
  row.classList.remove('hidden');
}
// Optimistic: the button lights, its badge moves and the tally shifts before the
// round trip; a failure rolls all of it back. The server echoes the story's FULL
// tally, so applying that echo on top of the optimistic state is harmless.
async function svReact(emoji, btn) {
  const it = svCurrentItem();
  if (!it || !sv) return;
  haptic(12);
  const before = { mine: (it.myReactions || []).map((r) => ({ ...r })), reactions: (it.reactions || []).map((r) => ({ ...r })) };
  const have = svMyCount(it, emoji);
  // Mirrors the server rule exactly: +1 until the cap, then clear the set.
  const clearing = have >= SV_REACTION_MAX;
  const next = clearing ? 0 : have + 1;
  if (!clearing && btn) svFloatEmoji(emoji, btn);
  const mine = new Map((it.myReactions || []).map((r) => [r.emoji, r.count]));
  if (next) mine.set(emoji, next); else mine.delete(emoji);
  it.myReactions = [...mine.entries()].map(([e, count]) => ({ emoji: e, count }));
  const tally = new Map((it.reactions || []).map((r) => [r.emoji, r.count]));
  tally.set(emoji, Math.max(0, (tally.get(emoji) || 0) + (next - have)));
  it.reactions = [...tally.entries()].filter(([, n]) => n > 0).map(([e, count]) => ({ emoji: e, count }));
  svRenderReactions();
  try {
    const r = await api('/api/stories/' + encodeURIComponent(it.id) + '/react', { method: 'POST', body: JSON.stringify({ emoji }) });
    if (Array.isArray(r.myReactions)) it.myReactions = r.myReactions;
    if (Array.isArray(r.reactions)) it.reactions = r.reactions;
    if (typeof r.views === 'number') it.views = r.views;
    svRenderReactions();
  } catch (err) {
    it.myReactions = before.mine;
    it.reactions = before.reactions;
    svRenderReactions();
    toast('Reaction failed: ' + prettyError(err.message));
  }
}
// A copy of the emoji rises out of its button (or from a random spot when there
// is no anchor, i.e. the replay on open) and fades away.
function svFloatEmoji(emoji, anchor, opts = {}) {
  const box = $('#sv-floats');
  const root = $('#story-view');
  if (!box || !root || !emoji) return;
  if (box.childElementCount > 40) return; // a burst can't flood the DOM
  const rb = root.getBoundingClientRect();
  const w = rb.width || window.innerWidth || 360;
  const h = rb.height || window.innerHeight || 640;
  const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
  let x, y;
  if (r && r.width) {
    x = r.left - rb.left + r.width / 2 + (Math.random() * 24 - 12);
    y = r.top - rb.top + r.height / 2;
  } else {
    x = opts.x != null ? opts.x : w * (0.2 + Math.random() * 0.6);
    y = opts.y != null ? opts.y : h * 0.72;
  }
  const el = document.createElement('span');
  el.className = 'sv-float';
  el.textContent = emoji;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  if (opts.scale) el.style.fontSize = (opts.scale * 2).toFixed(2) + 'rem';
  el.addEventListener('animationend', () => { try { el.remove(); } catch {} });
  box.appendChild(el);
}
// Replay: when a story opens, the reactions people already left float up and
// fade, so a new viewer sees what the room thought of it. Your own story never
// replays at you — the counts are in the rail and the detail is under "Who
// watched" — and a burst is capped so a 200-heart story cannot strobe.
function svStartReactionBurst(it) {
  if (!it || !sv) return;
  if (svItemIsMine(sv.trays[sv.ti], it)) return;
  const list = [];
  for (const r of (Array.isArray(it.reactions) ? it.reactions : [])) {
    if (!r || !r.count) continue;
    for (let i = 0; i < Math.min(r.count, 5); i++) list.push(r.emoji);
  }
  if (!list.length) return;
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = list[i]; list[i] = list[j]; list[j] = t;
  }
  const box = $('#sv-floats');
  const w = (box && box.clientWidth) || window.innerWidth || 360;
  const h = (box && box.clientHeight) || window.innerHeight || 640;
  const gen = sv.gen;
  const n = Math.min(list.length, 16);
  const timers = sv.burstT || (sv.burstT = []);
  for (let i = 0; i < n; i++) {
    timers.push(setTimeout(() => {
      if (!sv || sv.gen !== gen) return;
      svFloatEmoji(list[i], null, { x: w * (0.14 + Math.random() * 0.72), y: h * (0.7 + Math.random() * 0.12), scale: 0.85 });
    }, 200 + i * 230));
  }
}
// A reaction landed somewhere (possibly my own, from another tab). The payload
// carries the story's full tally, so it is applied verbatim everywhere and a
// re-delivery is harmless; only someone else's tap floats.
function storyReactionPush(m) {
  if (!m || !m.storyId) return;
  const lists = [
    (storyData.mine && storyData.mine.items) || [],
    ...(storyData.friends || []).map((t) => t.items || []),
    ...(storyData.everyone || []).map((t) => t.items || []),
    ...(storyData.servers || []).map((t) => t.items || []),
  ];
  for (const items of lists) {
    for (const it of items) {
      if (!it || it.id !== m.storyId) continue;
      if (Array.isArray(m.reactions)) it.reactions = m.reactions;
      if (typeof m.views === 'number') it.views = m.views;
      if (m.userId && S.me && m.userId === S.me.id) {
        // My own tap, delivered to my other devices: mirror the per-emoji count
        // this account now holds (0 = cleared).
        const mine = (it.myReactions || []).filter((r) => r && r.emoji !== m.emoji);
        if (m.count > 0) mine.push({ emoji: m.emoji, count: m.count });
        it.myReactions = mine;
      }
    }
  }
  if (!sv) return;
  const it = svCurrentItem();
  if (!it || it.id !== m.storyId) return;
  if (!m.cleared && m.userId !== (S.me && S.me.id)) svFloatEmoji(m.emoji, null, { scale: 0.9 });
  svRenderReactions();
  if (svItemIsMine(sv.trays[sv.ti], it) && typeof m.views === 'number') {
    $('#sv-views-n').textContent = m.views === 1 ? '1 view' : (m.views || 0) + ' views';
  }
}
// The viewers panel. Shared by the viewer's "N views" button and the story
// center's hero, which opens it without a viewer on screen — hence the story
// item as the argument and a boolean back (false = nothing to show, so the
// caller can decide whether a paused story should resume).
async function storyViewersModal(it) {
  if (!it) return false;
  let viewers = [];
  try { ({ viewers } = await api('/api/stories/' + encodeURIComponent(it.id) + '/viewers')); }
  catch { toast('Could not load viewers'); return false; }
  if (!viewers.length) {
    openModal('No views yet', '<p class="muted">Nobody has watched this story yet.</p>', 'Close', null);
    return false;
  }
  // Reactions first (a chip per emoji with its total), then one row per viewer
  // with the emoji they sent on the right (×2 when they tapped it twice).
  const tally = new Map();
  for (const u of viewers) for (const r of (u.reactions || [])) tally.set(r.emoji, (tally.get(r.emoji) || 0) + r.count);
  const summary = [...tally.entries()].sort((a, b) => b[1] - a[1])
    .map(([e, n]) => `<span class="sv-rx-chip"><span>${esc(e)}</span><b>${n}</b></span>`).join('');
  const rxBadges = (u) => (u.reactions || []).map((r) => `<span class="sv-viewer-rx" title="${esc(u.display_name)} reacted ${esc(r.emoji)}">${esc(r.emoji)}${r.count > 1 ? `<b>${r.count}</b>` : ''}</span>`).join('');
  const html = `${summary ? `<div class="sv-viewers-sum">${summary}</div>` : ''}<div class="gmem-list">${viewers.map((u) => `<div class="member sv-viewer" data-uid="${esc(u.id)}"><span class="avwrap"><span class="avatar"></span></span><span class="dmmain"><span class="mname-row"><span class="dmname">${esc(u.display_name)}</span>${tagHTML(u)}</span><span class="dmlast">@${esc(u.username)} · ${esc(storyAgo(u.viewed_at))}</span></span><span class="sv-viewer-rxs">${rxBadges(u)}</span></div>`).join('')}</div>`;
  openModal(viewers.length === 1 ? '1 view' : viewers.length + ' views', html, 'Close', null, { wide: true });
  const box = $('#modal-body');
  viewers.forEach((u) => {
    const row = box.querySelector(`.member[data-uid="${u.id}"]`);
    if (row) paintAvatar(row.querySelector('.avatar'), u);
  });
  return true;
}
async function svViewers() {
  if (!sv) return;
  const it = svCurrentItem();
  if (!it) return;
  svPause();
  // Nothing to show (no views, or the request failed): the story picks up
  // where it left off instead of sitting paused under a closed modal.
  if (!(await storyViewersModal(it))) svResume();
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

// View-once is aimed at one person, so opening it from a 1:1 DM should arrive
// with that person already picked. A server channel has nobody to pick, and a
// group chat has no single recipient.
function viewOnceDmPeerId() {
  if (!S.me || S.view !== 'home' || !S.dmThreadId) return '';
  const t = (S.dms || []).find((x) => x.id === S.dmThreadId) || null;
  if (!t || t.isGroup) return '';
  const p = (t.members || []).find((m) => m.id !== S.me.id);
  return (p && p.id) || '';
}
// …but only someone on the friends list can actually take delivery: the picker
// lists friends and the server drops everyone else. A stranger's DM keeps the
// empty picker instead of a "1 selected" with no row to show for it.
function viewOncePrePick(peerId, friends) {
  const p = String(peerId || '');
  if (!p) return [];
  const f = (friends || []).find((u) => String(u.id) === p);
  return f ? [f.id] : [];
}
// ---------- the way into a new post (desktop asks first) ----------
// Every "add to your story" entry used to open the camera, so anyone who meant
// to upload a photo or write a text card was asked for camera permission first
// (and on a desktop that is a browser prompt over an empty viewfinder). On a
// mouse device the entries ask how the post should start; a touch device keeps
// the one-tap camera. Both land in the same composer.
let snOpts = null;
function openStoryNewMenu(opts = {}) {
  const el = $('#story-new');
  if (!el || sc) return; // never over a running composer
  snOpts = opts || {};
  el.classList.remove('hidden');
  const b = $('#sn-camera');
  if (b && b.focus) { try { b.focus(); } catch {} }
}
function closeStoryNewMenu() {
  const el = $('#story-new');
  if (el) el.classList.add('hidden');
  snOpts = null;
}
function createStory(opts = {}) {
  if (isCoarse()) { openStoryComposer(opts); return; }
  openStoryNewMenu(opts);
}
async function openStoryComposer(opts = {}) {
  if (sc) return;
  const el = $('#story-compose');
  if (!el) return;
  el.classList.remove('hidden');
  document.body.classList.add('story-open');
  sc = {
    stream: null, audio: null, outTrack: null, micDenied: false, facing: 'user',
    rec: null, chunks: [], recT0: 0, recTimer: null, blob: null, kind: null,
    previewUrl: null, durationMs: 0, busy: false, camFailed: false, xhr: null,
    step: 'capture', camSeq: 0, camReady: false,
    // Framing: the live camera covers the stage, and pinch/pan is expressed as
    // a transform on it (and on the captured frame — see storyDrawFrame) so
    // the preview is never a lie about what gets recorded.
    zoom: 1, ox: 0, oy: 0, comp: null,
    // Markup: text/emoji/draw items, the selected one, the tool in hand.
    ovs: [], sel: -1, draw: false, te: null, drawing: null,
    drawColor: '#ff4d6d', drawWidth: 0.007,
    textOnly: false, textBg: 0, textOnlyDims: null, bgSeq: 0,
    // A shot whose bytes are still encoding (Android encodes toBlob on the
    // main thread during idle time — seconds). pendingShownUrl: the stand-in
    // on screen is that URL, not the frozen camera frame.
    shotSeq: 0, pendingShot: false, pendingUrl: null, pendingShownUrl: false,
    // audiences: friends / servers (multi-select). Instance-wide "everyone"
    // was removed on the owner's request; the read side still serves rows an
    // old client posted so those finish their 24h instead of vanishing.
    audFriends: true, audServers: [], audUsers: [],
    // view-once mode: pick friends instead of audiences, sends one DM each
    vo: !!opts.viewOnce, voIds: [],
    micCtx: null, micGain: null, micAnalyser: null, micTimer: null, micSource: null, micRaw: null,
  };
  if (opts.serverId) { sc.audServers = [opts.serverId]; sc.audFriends = true; }
  if (opts.viewOnce) {
    try { await ensureFriends(); } catch {}
    // Opened from a DM, that person is who the view-once was aimed at: the
    // picker opens with them already picked.
    sc.voIds = viewOncePrePick(opts.viewOnceUser, (S.friends && S.friends.friends) || []);
  }
  scCapBusy = false; // a toBlob from a previous session must not block this one
  storyClearFreeze(); // a stale shot must not sit over the fresh camera
  storyResetShotUi();
  storySetStep('capture');
  storyRenderColors();
  renderStoryAudience();
  paintScMic();
  // How the composer was opened (see createStory): a file already in hand and a
  // text card both skip the camera — there is nothing to shoot, and asking for
  // it would prompt for a permission neither of them needs. A refused file
  // falls back to the camera rather than parking on a dead viewfinder.
  if (opts.file) {
    const shown = await storyPickFile(opts.file);
    if (sc && !shown) await storyStartCam();
  } else if (opts.text) {
    await storyStartTextOnly();
  } else {
    await storyStartCam();
  }
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
  if (capture && sc) { sc.sel = -1; sc.draw = false; sc.te = null; sc.drawing = null; }
  if (!preview) { storyCloseTextEditor(); storyCloseEmoji(); }
  $('#sc-edit').classList.toggle('hidden', !preview);
  $('#sc-tools').classList.toggle('hidden', !preview);
  $('#sc-foot').classList.toggle('hidden', !capture);
  $('#sc-bar').classList.toggle('hidden', !preview);
  $('#sc-bar2').classList.toggle('hidden', !pick);
  $('#sc-pick').classList.toggle('hidden', !pick);
  $('#sc-flip').classList.toggle('hidden', !capture || sc.camFailed);
  // The mic button is only meaningful for the thing it records: a hold.
  $('#sc-mic').classList.toggle('hidden', !capture || sc.camFailed);
  if (capture) $('#sc-hint').classList.add('hidden');
  if (preview) storyPaintOv();
  else $('#sc-ov').classList.add('hidden');
  storyRenderColors();
  if (pick) {
    renderStoryAudience();
    // The pre-picked recipient (opened from their DM) can sit below the fold in
    // a long friends list — bring their row into view so the menu opens on the
    // answer instead of on an alphabetically-earlier stranger.
    if (sc && (sc.voIds || []).length) {
      const on = $('#sc-pick-list .sc-pick-row.on');
      if (on && on.scrollIntoView) { try { on.scrollIntoView({ block: 'nearest' }); } catch {} }
    }
  }
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
  storyApplyZoom();
  storyWarmCapture(vid);
  storySetStep('capture');
  // Warm the mic in the background: a hold-to-record then starts on the tap
  // instead of waiting for a permission prompt mid-gesture.
  if (!sc.audio && !sc.micDenied) storyEnsureMic().catch(() => {});
}
/* ---------- framing: cover-fit + pinch zoom, shared by preview and capture ---
 * The live camera is object-fit:cover in the stage, so the picture always
 * fills it. Zoom is a CSS transform on that element (translate then scale) and
 * the captured frame replays the SAME numbers through storyDrawFrame — the
 * shot is exactly the rectangle that was on screen, never a wider sensor
 * frame the preview hid. */
const SC_ZOOM_MAX = 5;
function scStage() { return $('#sc-stage'); }
function storyClampPan() {
  const vid = $('#sc-cam'), stage = scStage();
  if (!sc || !vid || !stage) return;
  if (!vid.videoWidth || !vid.videoHeight || !stage.clientWidth) { sc.ox = 0; sc.oy = 0; return; }
  const cs = Math.max(stage.clientWidth / vid.videoWidth, stage.clientHeight / vid.videoHeight);
  const z = sc.zoom || 1;
  const maxX = Math.max(0, (vid.videoWidth * cs * z - stage.clientWidth) / 2);
  const maxY = Math.max(0, (vid.videoHeight * cs * z - stage.clientHeight) / 2);
  sc.ox = Math.min(maxX, Math.max(-maxX, sc.ox || 0));
  sc.oy = Math.min(maxY, Math.max(-maxY, sc.oy || 0));
}
function storyApplyZoom() {
  const vid = $('#sc-cam');
  if (!vid || !sc) return;
  storyClampPan();
  vid.style.transform = `translate(${(sc.ox || 0).toFixed(2)}px, ${(sc.oy || 0).toFixed(2)}px) scale(${(sc.zoom || 1).toFixed(4)})`;
}
function storyResetZoom() {
  if (!sc) return;
  sc.zoom = 1; sc.ox = 0; sc.oy = 0;
  storyApplyZoom();
}
// Output size for one capture: the stage's aspect ratio (so the shot is the
// frame that was on screen), long edge capped.
function storyDestDims(stage, maxEdge) {
  const sw = Math.max(1, stage.clientWidth || 1), sh = Math.max(1, stage.clientHeight || 1);
  const ar = sw / sh;
  let w, h;
  if (ar >= 1) { w = maxEdge; h = Math.round(maxEdge / ar); }
  else { h = maxEdge; w = Math.round(maxEdge * ar); }
  return { w: Math.max(2, Math.round(w)), h: Math.max(2, Math.round(h)) };
}
// The one place the framing math lives: draw the live video into a (dw,dh)
// canvas exactly as the stage shows it (cover + zoom + pan).
function storyDrawFrame(ctx, vid, dw, dh, stage) {
  const vw = vid && vid.videoWidth, vh = vid && vid.videoHeight;
  if (!vw || !vh || !ctx) return false;
  const sw = (stage && stage.clientWidth) || dw;
  const sh = (stage && stage.clientHeight) || dh;
  const cs = Math.max(sw / vw, sh / vh);
  const z = (sc && sc.zoom) || 1;
  const k = dw / sw;
  const tw = vw * cs * z * k, th = vh * cs * z * k;
  const ox = ((sc && sc.ox) || 0) * k, oy = ((sc && sc.oy) || 0) * k;
  ctx.drawImage(vid, (dw - tw) / 2 + ox, (dh - th) / 2 + oy, tw, th);
  return true;
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
  storyStopComposite();
  try { if (sc.stream) sc.stream.getTracks().forEach((t) => t.stop()); } catch {}
  storyStopMic();
  sc.stream = null; sc.audio = null; sc.outTrack = null;
  sc.camReady = false;
  const vid = $('#sc-cam');
  if (vid) { vid.srcObject = null; vid.style.transform = ''; }
  paintScCam();
}
// The recording source. When the preview is showing a crop or a zoom the raw
// sensor stream is not what the user sees, so it is composited through a
// canvas at the stage's aspect ratio and the processed mic track is mixed in.
function storyNeedsComposite() {
  const vid = $('#sc-cam'), stage = scStage();
  if (!vid || !stage || !vid.videoWidth || !vid.videoHeight || !sc) return false;
  if ((sc.zoom || 1) > 1.001) return true;
  const sa = stage.clientWidth / Math.max(1, stage.clientHeight);
  return Math.abs(vid.videoWidth / vid.videoHeight - sa) > 0.02;
}
function storyRecordStream() {
  if (!sc || !sc.stream) return null;
  if (!storyNeedsComposite()) {
    if (sc.outTrack && !sc.stream.getAudioTracks().length) { try { sc.stream.addTrack(sc.outTrack); } catch {} }
    return sc.stream;
  }
  const vid = $('#sc-cam'), stage = scStage();
  const dim = storyDestDims(stage, Math.min(1280, storyCamMaxEdge()));
  const c = document.createElement('canvas');
  c.width = dim.w; c.height = dim.h;
  const ctx = c.getContext('2d');
  if (!ctx || !c.captureStream) return sc.stream;
  const draw = () => { try { storyDrawFrame(ctx, vid, c.width, c.height, stage); } catch {} };
  draw();
  const timer = setInterval(draw, 33); // interval, not rAF: a hidden tab keeps recording
  let cs = null;
  try { cs = c.captureStream(30); } catch { cs = null; }
  if (!cs) { clearInterval(timer); return sc.stream; }
  sc.comp = { timer, cs };
  const out = new MediaStream(cs.getVideoTracks());
  if (sc.outTrack) { try { out.addTrack(sc.outTrack); } catch {} }
  return out;
}
function storyStopComposite() {
  if (!sc || !sc.comp) return;
  clearInterval(sc.comp.timer);
  try { sc.comp.cs.getTracks().forEach((t) => t.stop()); } catch {}
  sc.comp = null;
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
  sc.outTrack = outTrack || null;
  // storyRecordStream decides whether the mic rides the raw stream or the
  // composited one, so the track is only parked here until a recording starts.
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
  if (sc.outTrack) sc.outTrack.enabled = !on;
  const b = $('#sc-mic');
  if (b) {
    b.innerHTML = on ? svSvg.micOff : svSvg.mic;
    b.setAttribute('aria-pressed', on ? 'false' : 'true');
    b.title = on ? 'Microphone off' : 'Microphone on';
  }
}
function storyFlipCam() {
  if (!sc || sc.step !== 'capture') return;
  sc.facing = sc.facing === 'user' ? 'environment' : 'user';
  storyResetZoom();
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
  const vid = $('#sc-cam'), stage = scStage();
  if (!sc || !vid || !stage || !vid.videoWidth) { toast('Camera is still starting'); return; }
  if (scCapBusy) return;
  scCapBusy = true;
  storyFlash();
  const dim = storyDestDims(stage, storyCamMaxEdge());
  const { c, ctx } = storyCaptureCanvas(dim.w, dim.h);
  try {
    if (!storyDrawFrame(ctx, vid, c.width, c.height, stage)) throw new Error('no_frame');
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
    // Superseded while the encoder ran — a newly picked shot bumped the
    // sequence, or the composer closed — so this one is stale: drop it (and
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
  const src = storyRecordStream();
  if (!src) { toast('Camera is not ready yet'); return; }
  let rec;
  try { rec = new MediaRecorder(src, mime ? { mimeType: mime } : undefined); }
  catch { storyStopComposite(); toast('Recording is not supported here — pick a video instead'); return; }
  sc.chunks = [];
  sc.recT0 = Date.now();
  rec.ondataavailable = (e) => { if (e.data && e.data.size) sc.chunks.push(e.data); };
  rec.onstop = () => {
    if (!sc) return;
    storyStopComposite();
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
  const tick = () => {
    if (!sc || !sc.rec) return;
    const ms = Date.now() - sc.recT0;
    const el = $('#sc-rec-time');
    if (el) { el.classList.remove('hidden'); el.textContent = fmtClock(ms / 1000); }
    if (ms >= STORY_VIDEO_MAX_MS) storyStopRec();
  };
  tick(); // the timer is up on the first frame of the recording, not 250 ms in
  sc.recTimer = setInterval(tick, 250);
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
  const wrap = b.closest('.sc-shutter-wrap');
  if (wrap) wrap.classList.toggle('rec', !!recording);
  b.title = recording ? 'Stop recording' : 'Tap for a photo, hold to record';
  const hint = $('#sc-holdhint');
  if (hint) hint.style.visibility = recording ? 'hidden' : '';
  if (!recording) $('#sc-rec-time').classList.add('hidden');
}
/* ---------- shutter: tap for a photo, hold for a video -------------------
 * One control, Snapchat-style. pointerdown arms a 220 ms timer; letting go
 * before it fires is a photo, and still holding when it fires starts a
 * recording that stops on release. The click path stays for keyboard
 * activation (and is ignored right after a pointer gesture, since a real tap
 * fires both). */
let scHoldTimer = 0, scHoldArmed = false, scHoldRecording = false;
function storyShutterDown() {
  if (!sc || sc.busy || sc.step !== 'capture' || !sc.camReady) return;
  scHoldArmed = true;
  scHoldRecording = false;
  clearTimeout(scHoldTimer);
  scHoldTimer = setTimeout(() => {
    if (!sc || !scHoldArmed || sc.step !== 'capture') return;
    scHoldRecording = true;
    storyBeginRecording();
  }, 220);
}
function storyShutterUp() {
  clearTimeout(scHoldTimer);
  if (!scHoldArmed) return; // the click path (keyboard) owns this one
  scHoldArmed = false;
  if (scHoldRecording) { scHoldRecording = false; storyStopRec(); return; }
  captureStoryPhoto();
}
async function storyBeginRecording() {
  if (!sc || sc.rec || sc.busy) return;
  // The mic is usually already warm (see storyStartCam); if that prompt is
  // still on screen this is the one await between the hold and the recording.
  try { await storyEnsureMic(); } catch {}
  if (!sc || !scHoldRecording || sc.step !== 'capture') return;
  storyStartRec();
}
/* ---------- markup editor: text, emoji stickers, freehand drawing --------
 * Everything here edits sc.ovs (see story-edit.js for the model) and paints it
 * through ovPaintLayer, so what the composer shows is exactly what the viewer
 * and the view-once player will show. Coordinates are normalised to the media
 * content box, which is why a resize only has to re-fit the layer. */
function storyOvLayer() { return $('#sc-ov'); }
function storyOvMedia() {
  if (!sc) return null;
  if (sc.kind === 'video') return $('#sc-play');
  const img = $('#sc-shot');
  // While the JPEG is still encoding the <img> has no src (what is on screen is
  // the freeze canvas): lay the markup over that, or the tools would be up and
  // inert for as long as the encode takes.
  if (img && img.getAttribute('src') && !img.classList.contains('hidden')) return img;
  const stage = scStage();
  const freeze = stage && stage.querySelector('canvas.sc-freeze');
  return freeze || img;
}
function storyPaintOv() {
  const layer = storyOvLayer(), stage = scStage();
  if (!layer || !sc) return;
  if (sc.step !== 'preview') { layer.classList.add('hidden'); storyPaintTools(); return; }
  ovFitLayer(layer, stage, storyOvMedia());
  ovPaintLayer(layer, sc.ovs, { editable: true, selected: sc.draw ? null : sc.sel });
  layer.classList.toggle('ov-drawing', !!sc.draw);
  const edit = $('#sc-edit');
  // The colour row takes the caption's slot: a drawing is not a caption, and a
  // text-only story IS the text (its caption would just repeat it below).
  if (edit) edit.classList.toggle('hidden', !!sc.draw || !!sc.textOnly);
  storyPaintTools();
}
// Just the pen layer, for the frame-by-frame redraw while a stroke is going.
function storyPaintOvDraw() {
  const layer = storyOvLayer();
  if (!layer || !sc) return;
  const c = layer.querySelector('canvas.ov-draw');
  if (!c) return;
  const strokes = sc.ovs.filter((o) => o.t === 'draw');
  if (sc.drawing) strokes.push(sc.drawing);
  ovPaintDraw(c, strokes, layer.clientWidth, layer.clientHeight);
}
function storyPaintTools() {
  if (!sc) return;
  const draw = $('#sc-tool-draw');
  if (draw) draw.classList.toggle('active', !!sc.draw);
  const undo = $('#sc-tool-undo');
  if (undo) undo.classList.toggle('hidden', !sc.ovs.some((o) => o.t === 'draw'));
  const del = $('#sc-tool-del');
  if (del) del.classList.toggle('hidden', !(sc.sel >= 0 && sc.ovs[sc.sel]));
}
// A tool sheet covers the bottom of the composer, so anything pinned down there
// (the colour row, the tool rail) pays for it through --sheet-h. Without this
// the background swatches sat *behind* the text sheet: you had to tap Done
// before you could pick a background at all. `.sheet-open` is what tells the CSS
// to dock the colour row on the sheet instead of on the caption slot it owns
// when no sheet is up (see .sc-colors).
function storySheetHeight() {
  let h = 0;
  for (const sel of ['#sc-textedit', '#sc-emoji']) {
    const el = $(sel);
    if (el && !el.classList.contains('hidden')) h = Math.max(h, el.getBoundingClientRect().height || 0);
  }
  const root = $('#story-compose');
  if (root) {
    root.style.setProperty('--sheet-h', Math.round(h) + 'px');
    root.classList.toggle('sheet-open', h > 0);
  }
  return h;
}
const SC_TEXT_BGS = [
  { name: 'Midnight', stops: ['#1b2333', '#05070c'] },
  { name: 'Violet', stops: ['#7c3aed', '#2e1065'] },
  { name: 'Sunset', stops: ['#fb923c', '#be123c'] },
  { name: 'Ocean', stops: ['#22d3ee', '#1e3a8a'] },
  { name: 'Forest', stops: ['#34d399', '#14532d'] },
  { name: 'Candy', stops: ['#f472b6', '#7c3aed'] },
  { name: 'Gold', stops: ['#fde047', '#b45309'] },
  { name: 'Paper', stops: ['#f8fafc', '#cbd5e1'] },
];
function storySwatch(box, cls, style, on, onclick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls + (on ? ' on' : '');
  if (style) b.setAttribute('style', style);
  b.onclick = onclick;
  box.appendChild(b);
  return b;
}
// The colour row does double duty: pen colours in draw mode, background
// gradients for a text-only story. Only one of them is ever up.
function storyRenderColors() {
  const box = $('#sc-colors');
  if (!box || !sc) return;
  const preview = sc.step === 'preview';
  box.textContent = '';
  if (!preview || (!sc.draw && !sc.textOnly)) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  if (sc.textOnly) {
    SC_TEXT_BGS.forEach((bg, i) => {
      const b = storySwatch(box, 'sc-swatch tile', `background:linear-gradient(135deg,${bg.stops[0]},${bg.stops[1]})`, i === sc.textBg, () => storyTextOnlySetBg(i));
      b.title = bg.name;
    });
    return;
  }
  for (const c of OV_COLORS) {
    storySwatch(box, 'sc-swatch', 'background:' + c, c === sc.drawColor, () => { sc.drawColor = c; storyRenderColors(); });
  }
  for (const [label, w] of [['Thin', 0.003], ['Medium', 0.0075], ['Thick', 0.016]]) {
    const b = storySwatch(box, 'sc-swatch wide', '', w === sc.drawWidth, () => { sc.drawWidth = w; storyRenderColors(); });
    b.textContent = label;
  }
}
function storyDeleteSelected() {
  if (!sc || sc.sel < 0 || !sc.ovs[sc.sel]) return;
  sc.ovs.splice(sc.sel, 1);
  sc.sel = -1;
  if (sc.te) sc.te.i = -1;
  storyCloseTextEditor();
  storyPaintOv();
}
function storyUndoStroke() {
  if (!sc) return;
  for (let i = sc.ovs.length - 1; i >= 0; i--) {
    if (sc.ovs[i].t === 'draw') { sc.ovs.splice(i, 1); break; }
  }
  storyPaintOv();
}
function storySetDraw(on) {
  if (!sc) return;
  sc.draw = !!on;
  sc.sel = -1;
  if (sc.draw) storyCloseTextEditor();
  storyNear('emoji', false);
  storyRenderColors();
  storyPaintOv();
}
function storyNear(what, on) {
  if (what === 'emoji') $('#sc-emoji').classList.toggle('hidden', !on);
}
/* --- the text tool: type on the sheet, read it on the picture ------------- */
function storyOpenTextEditor(i) {
  if (!sc) return;
  const editing = Number.isInteger(i) && i >= 0 && sc.ovs[i] && sc.ovs[i].t === 'text' ? i : -1;
  const it = editing >= 0 ? sc.ovs[editing] : null;
  sc.te = { i: editing, color: (it && it.color) || '#ffffff', pill: !!(it && it.bg === 'pill') };
  const inp = $('#sc-te-input');
  if (inp) inp.value = it ? it.text : '';
  $('#sc-te-del').classList.toggle('hidden', editing < 0);
  const bgBtn = $('#sc-te-bg');
  if (bgBtn) bgBtn.textContent = sc.te.pill ? 'Fill: on' : 'Background';
  $('#sc-textedit').classList.remove('hidden');
  if (editing >= 0) { sc.sel = editing; storyPaintOv(); }
  storyRenderTextColors();
  storySheetHeight();
  setTimeout(() => { const s = $('#sc-te-input'); if (s) { s.focus(); try { s.setSelectionRange(s.value.length, s.value.length); } catch {} } storySheetHeight(); }, 30);
}
function storyRenderTextColors() {
  const box = $('#sc-te-colors');
  if (!box || !sc || !sc.te) return;
  box.textContent = '';
  for (const c of OV_COLORS) {
    storySwatch(box, 'sc-swatch', 'background:' + c, c === sc.te.color, () => {
      sc.te.color = c;
      const it = sc.te.i >= 0 ? sc.ovs[sc.te.i] : null;
      if (it) it.color = c;
      storyRenderTextColors();
      storyPaintOv();
    });
  }
  const pill = storySwatch(box, 'sc-swatch wide', '', !!sc.te.pill, () => {
    sc.te.pill = !sc.te.pill;
    const it = sc.te.i >= 0 ? sc.ovs[sc.te.i] : null;
    if (it) it.bg = sc.te.pill ? 'pill' : 'none';
    storyRenderTextColors();
    storyPaintOv();
  });
  pill.textContent = 'Fill';
}
// Every keystroke paints: the first non-empty one creates the item, later ones
// update it, so the text is always where it will be when it is posted.
function storyTextTyped(v) {
  if (!sc || !sc.te) return;
  if (sc.te.i < 0) {
    if (!String(v).trim()) return;
    sc.ovs.push({ t: 'text', x: 0.5, y: 0.5, r: 0, s: 1, text: String(v).slice(0, OV_TEXT_MAX), color: sc.te.color, bg: sc.te.pill ? 'pill' : 'none' });
    sc.te.i = sc.ovs.length - 1;
    sc.sel = sc.te.i;
  } else if (sc.ovs[sc.te.i]) {
    sc.ovs[sc.te.i].text = String(v).slice(0, OV_TEXT_MAX);
  }
  storyPaintOv();
}
function storyCloseTextEditor() {
  if (!sc || !sc.te) return;
  const t = sc.te;
  sc.te = null;
  const it = t.i >= 0 ? sc.ovs[t.i] : null;
  if (it && !String(it.text || '').trim()) { sc.ovs.splice(t.i, 1); if (sc.sel === t.i) sc.sel = -1; }
  const box = $('#sc-textedit');
  if (box) box.classList.add('hidden');
  storySheetHeight();
  storyPaintOv();
}
/* --- the emoji tool ------------------------------------------------------- */
async function storyOpenEmoji() {
  if (!sc) return;
  sc.sel = -1;
  storySetDraw(false);
  $('#sc-emoji').classList.remove('hidden');
  storySheetHeight();
  storyRenderEmoji('');
  setTimeout(() => { const s = $('#sc-emoji-search'); if (s) s.focus(); }, 30);
  try { await ensureEmojiData(); } catch {}
  const box = $('#sc-emoji');
  if (box && !box.classList.contains('hidden')) storyRenderEmoji(($('#sc-emoji-search') || {}).value || '');
}
function storyCloseEmoji() {
  const box = $('#sc-emoji');
  if (box) box.classList.add('hidden');
  storySheetHeight();
}
function storyEmojiGridAdd(box, char, url, title) {
  const b = document.createElement('button');
  b.type = 'button';
  b.title = title || '';
  if (url) { const img = document.createElement('img'); img.src = url; img.alt = title || ''; b.appendChild(img); }
  else b.textContent = char;
  b.onclick = () => storyAddSticker(char);
  box.appendChild(b);
}
function storyRenderEmoji(q) {
  const box = $('#sc-emoji-grid');
  if (!box) return;
  const f = String(q || '').trim().toLowerCase();
  box.textContent = '';
  const data = (typeof emojiData !== 'undefined') ? emojiData : null;
  if (data && data.groups) {
    for (const g of data.groups) {
      const items = f ? g.items.filter((it) => String(it[1] || '').includes(f)).slice(0, 240) : g.items.slice(0, 64);
      if (!items.length) continue;
      const sec = document.createElement('div');
      sec.className = 'sc-emoji-sec';
      sec.textContent = g.name;
      box.appendChild(sec);
      for (const [ch] of items) storyEmojiGridAdd(box, ch, null, null);
    }
  } else {
    for (const ch of OV_STICKERS) storyEmojiGridAdd(box, ch, null, null);
  }
  const custom = Object.entries((typeof S !== 'undefined' && S && S.emojiAll) || {});
  if (custom.length) {
    const sec = document.createElement('div');
    sec.className = 'sc-emoji-sec';
    sec.textContent = 'Custom';
    box.appendChild(sec);
    for (const [n, em] of custom.slice(0, 160)) storyEmojiGridAdd(box, ':' + n + ':', em.url, ':' + n + ':');
  }
  if (!box.children.length) {
    const p = document.createElement('p');
    p.className = 'sc-pick-sub';
    p.textContent = 'No emoji matched that.';
    box.appendChild(p);
  }
}
// A new sticker lands where the last one did not, so tapping five emoji in a
// row does not stack them into one.
function storyAddSticker(char) {
  if (!sc) return;
  const n = sc.ovs.filter((o) => o.t === 'emoji').length;
  const off = (n % 5) * 0.06;
  sc.ovs.push({ t: 'emoji', x: 0.5 + off, y: 0.42 + off, r: 0, s: 1, e: String(char).slice(0, 32) });
  sc.sel = sc.ovs.length - 1;
  storyPaintOv();
}
/* --- text-only stories: a generated background, no camera ---------------- */
async function storyTextOnlyBlob() {
  const stage = scStage();
  if (!stage || !stage.clientWidth) return null;
  // Fixed for the life of the story: the composer's stage changes shape when
  // the shutter foot is swapped for the action bar, and a background that
  // re-shaped itself on every swatch would slide the picture under the markup.
  if (!sc.textOnlyDims) sc.textOnlyDims = storyDestDims(stage, 1080);
  const dim = sc.textOnlyDims;
  const c = document.createElement('canvas');
  c.width = dim.w; c.height = dim.h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const bg = SC_TEXT_BGS[sc.textBg % SC_TEXT_BGS.length];
  const g = ctx.createLinearGradient(0, 0, c.width, c.height);
  g.addColorStop(0, bg.stops[0]);
  g.addColorStop(1, bg.stops[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
  return await storyJpegBlob(c, 0.9);
}
async function storyStartTextOnly() {
  if (!sc || sc.step !== 'capture' || sc.busy) return;
  storyStopCamTracks();
  sc.textOnly = true;
  sc.kind = 'image';
  const blob = await storyTextOnlyBlob();
  if (!sc || !sc.textOnly) return;
  if (!blob || !blob.size) { sc.textOnly = false; toast('Could not start that story'); storyStartCam(); return; }
  // Through the same pending-shot path the gallery uses: that is what puts the
  // picture on screen (and the composer on the markup step) straight away,
  // with the encode/URL bookkeeping the rest of the flow expects.
  storyShowPendingShot(URL.createObjectURL(blob));
  storyShowPreview(blob, 'image', 0);
  storyRenderColors();
  storyOpenTextEditor();
}
async function storyTextOnlySetBg(i) {
  if (!sc || !sc.textOnly) return;
  sc.textBg = ((i % SC_TEXT_BGS.length) + SC_TEXT_BGS.length) % SC_TEXT_BGS.length;
  storyRenderColors();
  const seq = (sc.bgSeq || 0) + 1;
  sc.bgSeq = seq;
  const blob = await storyTextOnlyBlob();
  // Two quick swatch taps: only the newest background may land.
  if (!sc || !sc.textOnly || sc.bgSeq !== seq || !blob || !blob.size) return;
  const old = sc.previewUrl;
  sc.blob = blob; sc.kind = 'image'; sc.durationMs = 0;
  sc.previewUrl = URL.createObjectURL(blob);
  const img = $('#sc-shot');
  if (img) { img.src = sc.previewUrl; img.classList.remove('hidden'); }
  if (old) { try { URL.revokeObjectURL(old); } catch {} }
  storyPaintOv();
}
/* --- gestures on the picture: tap/hold shutter, pinch zoom, double-tap flip,
 * drag/pinch/rotate a sticker, freehand drawing. All of it hangs off pointer
 * events on the stage and the overlay layer, and nothing is armed outside the
 * step it belongs to. ----------------------------------------------------- */
function storyBindGestures() {
  const stage = scStage(), layer = storyOvLayer();
  if (!stage || !layer) return;
  /* capture-side: pinch to zoom, drag to pan, double-tap to flip */
  const ptrs = new Map();
  let pin = null, pan = null, multi = false, lastTap = 0, lastTapX = 0, lastTapY = 0;
  stage.addEventListener('pointerdown', (e) => {
    if (!sc || sc.step !== 'capture') return;
    if (e.target.closest('button')) return;
    if (e.button && e.button !== 0) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const r = stage.getBoundingClientRect();
      const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      pin = {
        d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: (sc.zoom || 1), ox: (sc.ox || 0), oy: (sc.oy || 0),
        mx: c.x - (r.left + r.width / 2), my: c.y - (r.top + r.height / 2),
      };
      pan = null; multi = true;
    } else if (ptrs.size === 1 && (sc.zoom || 1) > 1.001) {
      pan = { x: e.clientX, y: e.clientY, ox: (sc.ox || 0), oy: (sc.oy || 0), moved: false };
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!sc || sc.step !== 'capture' || !ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pin && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const r = stage.getBoundingClientRect();
      const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const z = Math.min(SC_ZOOM_MAX, Math.max(1, pin.z * (d / pin.d)));
      const k = z / pin.z;
      sc.zoom = z;
      // The point under the fingers stays under the fingers: the content offset
      // scales with z, and the midpoint's own travel is added on top.
      sc.ox = (c.x - (r.left + r.width / 2)) - (pin.mx - pin.ox) * k;
      sc.oy = (c.y - (r.top + r.height / 2)) - (pin.my - pin.oy) * k;
      storyApplyZoom();
      return;
    }
    if (pan) {
      const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) pan.moved = true;
      sc.ox = pan.ox + dx; sc.oy = pan.oy + dy;
      storyApplyZoom();
    }
  });
  const stageUp = (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pin = null;
    if (ptrs.size) return;
    pan = null;
    if (!sc || sc.step !== 'capture') { multi = false; return; }
    // Double-tap flips the camera (the button stays for keyboard/mouse).
    if (!multi) {
      const t = Date.now();
      const near = Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 60;
      if (t - lastTap < 320 && near) { lastTap = 0; storyFlipCam(); }
      else { lastTap = t; lastTapX = e.clientX; lastTapY = e.clientY; }
    }
    multi = false;
  };
  // Up/cancel on the window, not the stage: a finger that leaves the picture
  // (or a pointer the browser cancels) must still retire its entry, or the
  // next single-finger tap reads as a two-finger pinch.
  window.addEventListener('pointerup', stageUp);
  window.addEventListener('pointercancel', stageUp);
  // Trackpad pinch arrives as ctrl+wheel on desktop.
  stage.addEventListener('wheel', (e) => {
    if (!sc || sc.step !== 'capture' || !e.ctrlKey) return;
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const mx = e.clientX - (r.left + r.width / 2), my = e.clientY - (r.top + r.height / 2);
    const z0 = sc.zoom || 1;
    const z = Math.min(SC_ZOOM_MAX, Math.max(1, z0 * (1 - e.deltaY / 240)));
    const k = z / z0;
    sc.ox = mx - (mx - (sc.ox || 0)) * k;
    sc.oy = my - (my - (sc.oy || 0)) * k;
    sc.zoom = z;
    storyApplyZoom();
  }, { passive: false });
  /* overlay-side: pen, then drag/pinch/rotate the selected sticker */
  const oPtrs = new Map();
  let gest = null, opinch = null;
  const itemEl = (i) => layer.querySelector('.ov-item[data-i="' + i + '"]');
  const place = (i) => {
    const el = itemEl(i), o = sc && sc.ovs[i];
    if (!el || !o) return;
    el.style.left = (o.x * 100).toFixed(3) + '%';
    el.style.top = (o.y * 100).toFixed(3) + '%';
    el.style.transform = 'translate(-50%,-50%) rotate(' + o.r.toFixed(2) + 'deg) scale(' + o.s.toFixed(4) + ')';
  };
  const penPoint = (e) => {
    const r = layer.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  layer.addEventListener('pointerdown', (e) => {
    if (!sc || sc.step !== 'preview') return;
    if (e.button && e.button !== 0) return;
    e.preventDefault();
    if (sc.draw) {
      try { layer.setPointerCapture(e.pointerId); } catch {}
      sc.drawing = { t: 'draw', color: sc.drawColor, w: sc.drawWidth, p: [penPoint(e)] };
      storyPaintOvDraw();
      return;
    }
    const i = ovHit(layer, e.clientX, e.clientY);
    if (i < 0) {
      if (sc.sel !== -1) { sc.sel = -1; storyPaintOv(); }
      return;
    }
    const wasSel = sc.sel === i;
    sc.sel = i;
    storyPaintOv();
    try { layer.setPointerCapture(e.pointerId); } catch {}
    oPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gest = { i, x0: e.clientX, y0: e.clientY, o: Object.assign({}, sc.ovs[i]), moved: false, wasSel, pid: e.pointerId };
    if (oPtrs.size === 2) {
      const [a, b] = [...oPtrs.values()];
      opinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, a0: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI, s0: sc.ovs[i].s, r0: sc.ovs[i].r };
    }
  });
  layer.addEventListener('pointermove', (e) => {
    if (!sc || sc.step !== 'preview') return;
    if (sc.drawing) {
      const p = penPoint(e);
      const last = sc.drawing.p[sc.drawing.p.length - 1];
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.006) return;
      if (sc.drawing.p.length >= OV_POINTS_MAX) return;
      sc.drawing.p.push(p);
      storyPaintOvDraw();
      return;
    }
    if (!gest || !oPtrs.has(e.pointerId)) return;
    const o = sc.ovs[gest.i];
    if (!o) return;
    oPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (opinch && oPtrs.size >= 2) {
      const [a, b] = [...oPtrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
      o.s = Math.min(8, Math.max(0.15, opinch.s0 * (d / opinch.d0)));
      o.r = opinch.r0 + (ang - opinch.a0);
      gest.moved = true;
      place(gest.i);
      return;
    }
    if (Math.abs(e.clientX - gest.x0) > 4 || Math.abs(e.clientY - gest.y0) > 4) gest.moved = true;
    const r = layer.getBoundingClientRect();
    o.x = Math.min(1.15, Math.max(-0.15, gest.o.x + (e.clientX - gest.x0) / r.width));
    o.y = Math.min(1.15, Math.max(-0.15, gest.o.y + (e.clientY - gest.y0) / r.height));
    place(gest.i);
  });
  const layerUp = (e) => {
    if (sc && sc.drawing) {
      const s = sc.drawing;
      sc.drawing = null;
      if (s.p.length) sc.ovs.push(s);
      storyPaintOv();
    }
    oPtrs.delete(e.pointerId);
    if (oPtrs.size < 2) opinch = null;
    if (!gest || oPtrs.size) return;
    const g = gest;
    gest = null;
    if (sc && sc.ovs[g.i]) sc.ovs[g.i].r = ((sc.ovs[g.i].r + 180) % 360 + 360) % 360 - 180;
    storyPaintOv();
    // A tap on an already-selected text sticker opens the editor; the first
    // tap just selects it (that is also what shows the delete button).
    if (!g.moved && g.wasSel && sc && sc.ovs[g.i] && sc.ovs[g.i].t === 'text') storyOpenTextEditor(g.i);
  };
  layer.addEventListener('pointerup', layerUp);
  layer.addEventListener('pointercancel', layerUp);
}
// Overlays are normalised against the media's content box, so anything that
// changes that box (a rotate, a window resize, the viewer's own layout) has to
// re-lay them out: the numbers are resolution-free, the pixels are not.
function ovRefit() {
  try { if (sc && sc.step === 'capture') storyApplyZoom(); } catch {}
  try { if (sc && sc.step === 'preview') storyPaintOv(); } catch {}
  try { if (sv) svPaintOverlays(); } catch {}
  try { if (typeof voState !== 'undefined' && voState) voRefitOverlays(); } catch {}
}
let ovRefitT = 0;
window.addEventListener('resize', () => { clearTimeout(ovRefitT); ovRefitT = setTimeout(ovRefit, 90); });
window.addEventListener('orientationchange', () => setTimeout(ovRefit, 180));

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
    vid.addEventListener('loadedmetadata', () => storyPaintOv(), { once: true });
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
// Back to the camera with an empty shot — the reset a capture that produced no
// bytes falls back to (see captureStoryPhoto). There is deliberately no Retake
// button in the composer: the flow is shoot → preview → next, and a reader who
// wants a different shot closes the composer and starts again.
function storyRetake() {
  if (!sc) return;
  if (sc.previewUrl) { try { URL.revokeObjectURL(sc.previewUrl); } catch {} }
  if (sc.pendingUrl) { try { URL.revokeObjectURL(sc.pendingUrl); } catch {} }
  sc.previewUrl = null; sc.blob = null; sc.kind = null; sc.durationMs = 0;
  sc.pendingShot = false; sc.pendingUrl = null; sc.pendingShownUrl = false;
  sc.textOnly = false;
  sc.textOnlyDims = null;
  sc.ovs = []; sc.sel = -1; sc.draw = false; sc.te = null; sc.drawing = null;
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
  return (sc.audFriends ? 1 : 0) + (sc.audServers || []).length + (sc.audUsers || []).length;
}
// Broadcast audiences post a story (tray). Individually picked friends are a
// private delivery instead: each one gets a view-once DM (one view, one
// replay), never a tray entry.
function scBroadcast() {
  return !!(sc && (sc.audFriends || (sc.audServers || []).length));
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
// Step 2: the audience menu. Everything is a toggle row — all friends, whole
// servers, or individual friends.
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
      p.textContent = 'You have no friends yet — add someone from Home → Friends to share this.';
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
  clearTimeout(scHoldTimer);
  scHoldArmed = false; scHoldRecording = false;
  storyStopComposite();
  const cam = $('#sc-cam');
  if (cam) { cam.srcObject = null; cam.style.transform = ''; }
  const play = $('#sc-play');
  if (play) { try { play.pause(); } catch {} play.removeAttribute('src'); }
  const shot = $('#sc-shot');
  if (shot) shot.removeAttribute('src');
  storyClearFreeze();
  const cap = $('#sc-caption');
  if (cap) cap.value = '';
  $('#sc-file').value = '';
  const ov = $('#sc-ov');
  if (ov) { ov.textContent = ''; ov.classList.add('hidden'); }
  // The tool sheets and the rows docked on them must not survive into the next
  // open (sc is already null here, so this is done directly rather than through
  // the editor/closer helpers, which bail without it).
  const te = $('#sc-textedit');
  if (te) te.classList.add('hidden');
  const em = $('#sc-emoji');
  if (em) em.classList.add('hidden');
  storySheetHeight();
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
// Returns false when nothing was shown (no composer, or a file this flow can't
// carry) so the caller that opened the composer for a picked file knows it has
// nothing behind it and can fall back to the camera.
async function storyPickFile(file) {
  if (!sc || !file) return false;
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
    return true;
  } else if (file.type.startsWith('video/')) {
    if (file.size > S.maxUploadMb * 1024 * 1024) { toast(`Videos are limited to ${S.maxUploadMb}MB`); return false; }
    storyShowPreview(file, 'video', await storyVideoDuration(file));
    return true;
  } else {
    toast('Pick a photo or a video');
    return false;
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
  // The markup rides with the post (see story-edit.js): the server validates
  // it again, stores it as JSON, and every surface that shows the story — the
  // viewer and a view-once DM made from it — renders it over the media.
  const overlays = ovSanitize(st.ovs);
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
      const r = await sendViewOnce({ url: up.url, mime: up.mime, kind: up.kind || st.kind, caption, overlays, userIds: dmIds });
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
        url: up.url, mime: up.mime, kind: st.kind, caption, overlays,
        friends: !!st.audFriends,
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
      const r = await sendViewOnce({ storyId: story.id, userIds: dmIds, caption, overlays });
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
  // In a DM the person you were just talking to opens the picker pre-picked.
  openStoryComposer({ viewOnce: true, viewOnceUser: viewOnceDmPeerId() });
};
$('#cm-story').onclick = (e) => {
  e.stopPropagation();
  $('#composer-more').classList.add('hidden');
  createStory({ serverId: S.view === 'server' ? S.serverId : null });
};
$('#btn-stories').onclick = () => showStoriesPanel();
// The row's trailing ＋ opens a post in one tap from anywhere in Home — the
// same control (and the same audience default: friends) as the story center's
// own post button (createStory decides camera vs chooser). It is a sibling of
// the row, not a child, so this tap never reaches the row's handler; like the
// server sidebar's ＋ it leaves the phone nav page open behind the composer, so
// posting lands you back on the nav.
$('#stories-nav-add').onclick = () => createStory({});
$('#sp-post').onclick = () => createStory({});
// The chooser itself (desktop only — createStory hands touch devices the
// camera). Upload keeps the menu up until a file actually lands, so a cancelled
// file dialog leaves the reader where they were rather than behind a
// viewfinder with no camera running.
$('#sn-close').onclick = () => closeStoryNewMenu();
$('#story-new').addEventListener('click', (e) => { if (e.target.id === 'story-new') closeStoryNewMenu(); });
$('#sn-camera').onclick = () => { const o = snOpts || {}; closeStoryNewMenu(); openStoryComposer(o); };
$('#sn-text').onclick = () => { const o = snOpts || {}; closeStoryNewMenu(); openStoryComposer({ ...o, text: true }); };
$('#sn-upload').onclick = () => { const f = $('#sn-file'); if (f) f.click(); };
$('#sn-file').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  const o = snOpts || {};
  e.target.value = '';
  if (!file) return;
  if (!/^(image|video)\//.test(file.type || '')) { toast('Pick a photo or a video'); return; }
  closeStoryNewMenu();
  openStoryComposer({ ...o, file });
});
$('#sv-close').onclick = () => svClose();
// Tapping the poster's picture/name opens their profile. The profile's own
// picture is the story button (paintProfileStory), so it leads straight back
// into the story that was just closed.
$('#sv-who').onclick = () => {
  const uid = sv && sv.whoId;
  if (!uid) return;
  const u = sv && sv.whoUser;
  svClose();
  openProfileScreen(uid, u);
};
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
// Swipe down anywhere on the media slides the WHOLE story view down — progress
// bars, header (✕/sound/more) and footer travel with the picture, then the
// overlay continues off the bottom of the screen and closes. The stage has
// nothing to scroll, so touch-action:none (see .sv-stage) keeps the browser from
// claiming the drag — under pan-y the pointer stream was cancelled and the swipe
// never landed. Listeners stay on the stage so the reply input keeps its own
// gestures.
(function () {
  const root = $('#story-view');
  const stage = $('#sv-stage');
  const CLOSE_PX = 110;   // dragged this far and it is a dismissal
  const FLICK = 0.55;     // px/ms — a quick short flick closes too
  let sx = 0, sy = 0, dy = 0, active = false, t0 = 0;
  const clearDrag = () => { active = false; dy = 0; root.style.transform = ''; root.style.transition = ''; };
  stage.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return;
    if (!sv) return;
    active = true; sx = e.clientX; sy = e.clientY; dy = 0; t0 = Date.now();
    root.style.transition = '';
  });
  stage.addEventListener('pointermove', (e) => {
    if (!active) return;
    const dx = e.clientX - sx;
    if (Math.abs(dx) > Math.abs(e.clientY - sy) * 1.5) return; // sideways: leave it to the zones
    dy = e.clientY - sy;
    if (dy <= 0) { root.style.transform = ''; return; }
    root.style.transform = 'translateY(' + Math.round(dy) + 'px)';
  });
  const end = (e) => {
    if (!active) return;
    const d = e.clientY - sy, dx = Math.abs(e.clientX - sx);
    const v = d / Math.max(1, Date.now() - t0); // px/ms
    active = false;
    dy = 0;
    if (dx < 90 && (d > CLOSE_PX || (v > FLICK && d > 30))) {
      // Let it keep going all the way off the bottom, then tear the viewer down.
      // Hold on to this viewer: if it was closed and reopened while the slide was
      // running, the stale timer must not close the new one.
      const mine = sv;
      root.style.transition = 'transform .2s ease-in';
      root.style.transform = 'translateY(100%)';
      setTimeout(() => { if (sv && sv === mine) svClose(); }, 210);
      return;
    }
    // Not far enough: spring back.
    root.style.transition = 'transform .2s ease-out';
    root.style.transform = '';
    setTimeout(() => { if (!active) root.style.transition = ''; }, 220);
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
// The shutter answers on pointerdown, not click (the WebView's click synthesis
// adds real latency to the one control where a lag reads as "broken"), and it
// resolves on release: a tap is a photo, a hold is a recording. The click path
// stays for keyboard activation and is ignored right after a pointer gesture,
// since a real tap fires both.
let scShutterTap = 0;
$('#sc-shutter').addEventListener('pointerdown', (e) => {
  if (e.button && e.button !== 0) return;
  scShutterTap = Date.now();
  // Capture so a hold that drifts off the button still ends on release (and
  // never leaves a recording running on a lost pointerup).
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  storyShutterDown();
});
$('#sc-shutter').addEventListener('pointerup', (e) => {
  if (e.button && e.button !== 0) return;
  storyShutterUp();
});
$('#sc-shutter').addEventListener('pointercancel', () => {
  clearTimeout(scHoldTimer);
  scHoldArmed = false;
  // A cancelled hold (the browser took the gesture) must not leave a recorder
  // running until the 60 s cap: stop it and keep whatever it captured.
  if (scHoldRecording) { scHoldRecording = false; storyStopRec(); }
});
$('#sc-shutter').addEventListener('lostpointercapture', () => { if (scHoldArmed) storyShutterUp(); });
$('#sc-shutter').addEventListener('click', () => {
  if (Date.now() - scShutterTap < 600) return;
  if (sc && sc.step === 'capture' && sc.camReady) captureStoryPhoto();
});
$('#sc-flip').onclick = () => storyFlipCam();
$('#sc-mic').onclick = () => storyToggleMic();
$('#sc-gallery').onclick = () => $('#sc-file').click();
$('#sc-textonly').onclick = () => storyStartTextOnly();
$('#sc-tool-text').onclick = () => storyOpenTextEditor(-1);
$('#sc-tool-emoji').onclick = () => storyOpenEmoji();
$('#sc-tool-draw').onclick = () => storySetDraw(!(sc && sc.draw));
$('#sc-tool-undo').onclick = () => storyUndoStroke();
$('#sc-tool-del').onclick = () => storyDeleteSelected();
$('#sc-te-input').addEventListener('input', (e) => storyTextTyped(e.target.value));
$('#sc-te-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); storyCloseTextEditor(); }
});
$('#sc-te-done').onclick = () => storyCloseTextEditor();
$('#sc-te-del').onclick = () => storyDeleteSelected();
$('#sc-te-bg').onclick = () => {
  if (!sc || !sc.te) return;
  sc.te.pill = !sc.te.pill;
  const it = sc.te.i >= 0 ? sc.ovs[sc.te.i] : null;
  if (it) it.bg = sc.te.pill ? 'pill' : 'none';
  $('#sc-te-bg').textContent = sc.te.pill ? 'Fill: on' : 'Background';
  storyRenderTextColors();
  storyPaintOv();
};
$('#sc-emoji-close').onclick = () => storyCloseEmoji();
$('#sc-emoji-search').addEventListener('input', (e) => storyRenderEmoji(e.target.value));
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
$('#sc-caption').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 88) + 'px';
});
// The text sheet grows with the text; the colour row and tool rail above it
// have to move up with it.
$('#sc-te-input').addEventListener('input', () => storySheetHeight());
storyBindGestures();
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sc) {
    // A tool sheet closes first; the second Escape leaves the composer.
    if (!$('#sc-textedit').classList.contains('hidden')) { e.preventDefault(); storyCloseTextEditor(); return; }
    if (!$('#sc-emoji').classList.contains('hidden')) { e.preventDefault(); storyCloseEmoji(); return; }
    e.preventDefault();
    closeStoryComposer();
  }
});
