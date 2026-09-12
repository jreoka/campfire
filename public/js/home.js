'use strict';
/* ================= home: friends + DMs ================= */
function dmPeer(t) { return (t.members || []).find((m) => m.id !== S.me.id) || null; }
function dmTitle(t) { return t.isGroup ? (t.name || 'Group chat') : ((dmPeer(t) || {}).display_name || 'Direct message'); }
function openServerView() {
  saveScrollPos();
  S.view = 'server';
  S.callOpen = false;
  stopRinging();
  $('#chat').classList.remove('call-open');
  document.body.classList.remove('view-home', 'dm-open');
  $('#friends-page').classList.add('hidden');
  $('#stories-page').classList.add('hidden');
  $('#messages').classList.remove('hidden');
  $('#server-ui').classList.remove('hidden');
  $('#home-ui').classList.add('hidden');
  $('#btn-home').classList.remove('active');
  paintDmCallButtons();
}
// The campfire button. Home is where you come back to, so it reopens the tab
// you were last on — the DM or group you were in, or the Friends/Stories panel
// — instead of always dropping you on the empty feed (see readHomeTab).
async function openHomeTab() {
  const tab = readHomeTab();
  await openHome({ panel: tab.panel, dm: tab.dm });
}
// Every other caller of openHome() is a "jump into Home" step that picks its
// own conversation right after (a notification, a DM row, a share target), so
// they pass nothing and land on the blank Home feed. Only openHomeTab() restores.
async function openHome(opts = {}) {
  flushDrafts(); // file the outgoing conversation's text before its context changes
  saveScrollPos();
  closeServerSettings();
  S.view = 'home';
  S.serverId = null;
  S.channelId = null;
  S.callOpen = false;
  $('#chat').classList.remove('call-open');
  document.body.classList.add('view-home');
  $('#server-ui').classList.add('hidden');
  $('#home-ui').classList.remove('hidden');
  $('#btn-home').classList.add('active');
  popRailPill();
  // Which of the two no-conversation panels Home shows: Friends by default,
  // or the tab the campfire button is bringing back.
  S.homePanel = opts.panel === 'stories' ? 'stories' : 'friends';
  document.querySelectorAll('#server-list .server-btn').forEach((b) => b.classList.remove('active'));
  rememberView();
  closeThread(true);
  // Drop the open conversation NOW, before the roster refreshes: their network
  // round-trips used to leave the previous DM (or channel) painted underneath
  // the mobile nav page, so closing that page revealed a chat that had already
  // been left. The blank is synchronous; the awaits below only fill it in.
  S.dmThreadId = null;
  renderDmBlank();
  // …and put back the conversation Home was left on, in the same tick, so the
  // campfire button lands on it instead of flashing the blank first. A thread
  // that is gone (closed, left, deleted) just leaves the blank in place.
  const back = opts.dm && (S.dms || []).some((t) => t.id === opts.dm) ? opts.dm : null;
  // keepNav: restoring must not close the phone's nav page — Home keeps it up
  // so a conversation can be picked out of it (see selectDmThread).
  if (back) selectDmThread(back, { keepNav: true });
  await Promise.all([refreshFriends(), refreshDms()]);
  // Stories live at the top of the Friends feed — refresh on every visit so
  // the 24h window and seen rings are current.
  try { loadStories().then(renderStorySurfaces); } catch {}
}
// Sidebar Friends button → back to the friends menu in the main panel.
function showFriendsPanel() {
  if (S.view !== 'home') { openHome({ panel: 'friends', dm: null }); return; }
  flushDrafts(); // leaving a DM — its text must be in the store before the context clears
  saveScrollPos();
  S.homePanel = 'friends';
  S.dmThreadId = null;
  renderDmBlank();
  rememberView();
  rememberHomeTab();
}
async function refreshFriends() {
  try { S.friends = await api('/api/friends'); S.friendsAt = Date.now(); renderFriendLists(); paintHomeBadge(); } catch {}
}
// Cards/menus need friend state even if Home was never opened this session.
async function ensureFriends() {
  if (S.friendsAt && Date.now() - S.friendsAt < 30000) return;
  await refreshFriends();
}
function friendState(id) {
  if ((S.friends.friends || []).some((u) => u.id === id)) return 'friend';
  if ((S.friends.pendingOut || []).some((u) => u.id === id)) return 'pending-out';
  if ((S.friends.pendingIn || []).some((u) => u.id === id)) return 'pending-in';
  return 'none';
}
async function refreshDms() {
  try {
    const { threads } = await api('/api/dms');
    S.dms = threads;
    // Drop unread counts for threads that no longer exist (left/deleted).
    const alive = new Set(threads.map((t) => t.id));
    for (const tid of [...S.dmUnread.keys()]) if (!alive.has(tid)) S.dmUnread.delete(tid);
    // The count is the server's (dm_members.last_read_at), not a tally that
    // only exists in this tab: a reload — the auto-updater fires one seconds
    // after every deploy — repaints the rail badges from it instead of losing
    // every DM that arrived since the page loaded. The chat you are looking at
    // is read by definition, so it never gets a badge back here.
    for (const t of threads) {
      const n = (S.view === 'home' && S.dmThreadId === t.id) ? 0 : (t.unread || 0);
      if (n) S.dmUnread.set(t.id, n);
      else S.dmUnread.delete(t.id);
    }
    renderDmLists();
  } catch {}
}
// Reading a thread is reported to the server, or the next reload brings its
// badge back. Opening a chat stamps immediately; the messages that arrive in an
// already-open chat are coalesced into one stamp (a busy DM is one write).
const dmReadTimers = new Map();
function markDmRead(tid, delay = 500) {
  if (!tid || !S.me) return;
  if (S.dmUnread.delete(tid)) paintHomeBadge();
  const prev = dmReadTimers.get(tid);
  if (prev) clearTimeout(prev);
  dmReadTimers.set(tid, setTimeout(() => {
    dmReadTimers.delete(tid);
    api('/api/dms/' + encodeURIComponent(tid) + '/read', { method: 'POST' }).catch(() => {});
  }, delay));
}
// Red count on the campfire home button: incoming friend requests only.
// Unread DMs already show as their own red count on the rail avatars, so
// counting them again here would double the badge.
function paintHomeBadge() {
  const b = $('#home-badge');
  if (!b) return;
  const n = ((S.friends && S.friends.pendingIn) || []).length;
  b.textContent = n > 99 ? '99+' : String(n);
  b.classList.toggle('hidden', !n);
  renderDmRail();
}
// Unread DM senders park under Home: avatar + red per-thread count.
// Clicking opens the DM, which clears the unread and dismisses the avatar.
function renderDmRail() {
  const box = $('#dm-rail');
  if (!box || !S.me) return;
  box.innerHTML = '';
  for (const [tid, count] of S.dmUnread) {
    if (!count) continue;
    const t = S.dms.find((x) => x.id === tid);
    if (!t) continue;
    const b = document.createElement('button');
    b.className = 'server-btn';
    b.title = dmTitle(t);
    const av = t.isGroup ? null : dmPeer(t);
    if (av) {
      const a = document.createElement('span');
      a.className = 'avatar';
      paintAvatar(a, av);
      a.style.boxShadow = 'none'; // no ring/glow here — it read as a venn-diagram double circle
      b.appendChild(a);
    } else {
      const g = document.createElement('span');
      g.textContent = t.isGroup ? '#' : '?';
      g.style.fontWeight = '700';
      b.appendChild(g);
    }
    const badge = document.createElement('span');
    badge.className = 'rail-dm-badge';
    badge.textContent = count > 99 ? '99+' : String(count);
    b.appendChild(badge);
    b.onclick = async () => { if (S.view !== 'home') await openHome(); selectDmThread(tid); };
    box.appendChild(b);
  }
}
function friendRowEl(u, extra) {
  const st = statusOf(u.id);
  const off = isOff(st);
  const streaming = !off && (u.streaming_game || null);
  const dot = dotOf(st, streaming);
  const div = document.createElement('div');
  div.className = 'dmrow';
  // data-uid lets the story ring painter find this row again after a rebuild
  // (friends with an unseen story get an accent ring on their avatar).
  div.dataset.uid = u.id;
  // ...but the row owns its click below (friends list → DM, pending/settings →
  // card), so the global [data-uid] delegate must not stack a second card on it.
  div.dataset.ownclick = '1';
  div.dataset.uname = u.display_name || '';
  const fPlaying = !off && !streaming && u.playing_game;
  // Plain tag: the row owns its click (friends list → DM, pending → card), so
  // the tag must not steal the tap into the server mini-panel. Same rule as
  // the DM sidebar rows — otherwise a tag click both opened the DM and stacked
  // the server panel on top of it.
  div.innerHTML = `<span class="avwrap st-${dot}"><span class="avatar"></span><span class="status-dot ${dot}"></span></span><span class="dmmain"><span class="mname-row"><span class="dmname" style="${nameStyleFor(u)}">${esc(u.display_name)}</span>${tagHTML(u, true)}${fPlaying ? gameBadgeHTML(u.playing_game) : ''}</span><span class="dmlast">@${esc(u.username)}${streaming ? ` · <span class="ustream-t">Streaming ${esc(streaming)}</span>` : (u.status_text ? ' · ' + esc(u.status_text) : (fPlaying ? ` · Playing ${esc(u.playing_game)}` : ''))}</span></span>`;
  paintAvatar(div.querySelector('.avatar'), u);
  paintGameBadge(div.querySelector('.gbadge'));
  try { paintFriendStoryRing(div, u); } catch {}
  if (extra) div.appendChild(extra);
  div.onclick = (e) => { if (e.target.closest('button')) return; openUserCard(u.id, e.clientX, e.clientY); };
  return div;
}
function smallBtn(label, fn, danger) {
  const b = document.createElement('button');
  b.className = 'mini' + (danger ? ' danger' : '');
  b.textContent = label;
  b.onclick = (e) => { e.stopPropagation(); fn(); };
  return b;
}
const MAIL_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="3"/><path d="m2.5 6.5 9.5 7 9.5-7"/></svg>';
const DOTS_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
function friendIconBtn(label, svg, fn) {
  const b = document.createElement('button');
  b.className = 'fact-btn';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = svg;
  b.onclick = (e) => { e.stopPropagation(); fn(e); };
  return b;
}
function friendMoreMenu(u, anchor) {
  const r = anchor.getBoundingClientRect();
  openCtx(r.left, r.bottom + 6, [
    { label: 'View profile', icon: '@', fn: () => openUserCard(u.id, r.left + r.width / 2, r.bottom + 6) },
    { label: 'Unfriend', icon: '\u2212', fn: () => unfriendUser(u.id, u.username) },
    { label: 'Block', icon: '\u2298', danger: true, fn: () => blockUser(u.id, u.username) },
  ]);
}
function isBlocked(id) { return (S.friends.blocked || []).some((u) => u.id === id); }
// The friends page is a live roster: presence flips (online/offline/status/
// playing) must repaint its rows. Coalesced so a burst of presence frames
// (every server roster arriving at once) only costs one rebuild.
let friendsPaintT = null;
function repaintFriendsIfVisible() {
  if (S.view !== 'home') return;
  if ($('#friends-page')?.classList.contains('hidden')) return;
  clearTimeout(friendsPaintT);
  friendsPaintT = setTimeout(() => { try { renderFriendLists(); } catch {} }, 120);
}
// ---------- Active Now (friends activity rail on the friends page) ----------
const activeGaming = new Map(); // username -> { at, data }
let activeNowGen = 0;
function agoStr(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  if (d < 30) return d + 'd ago';
  return new Date(ts).toLocaleDateString();
}
function activeGamingFresh(un) {
  const c = activeGaming.get(un);
  return c && Date.now() - c.at < 90000 ? c.data : null;
}
// Voice activity line + a Join affordance for friends who are in a room the
// viewer can actually reach (shared server, or a DM call of a thread they are
// in). Rooms outside the viewer's reach stay deliberately nameless.
const ANOW_VOICE_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M14.5 9.5a4 4 0 0 1 0 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M17 7a8 8 0 0 1 0 10" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
function anowVoiceHTML(v) {
  if (v.kind === 'dm') {
    const t = (S.dms || []).find((x) => x.id === v.threadId);
    const where = t && t.isGroup ? ` — <b>${esc(t.name || 'group chat')}</b>` : (t ? ' with you' : '');
    return `<div class="anow-voice">${ANOW_VOICE_ICON}<span>In a call${where}</span></div>`;
  }
  const where = (v.joinable && v.channelName) ? ` — ${v.serverName ? esc(v.serverName) + ' / ' : ''}<b>${esc(v.channelName)}</b>` : '';
  return `<div class="anow-voice">${ANOW_VOICE_ICON}<span>In voice${where}</span></div>`;
}
function anowInThisRoom(v) {
  if (!S.voice) return false;
  return v.kind === 'dm'
    ? (S.voice.kind === 'dm' && S.voice.threadId === v.threadId)
    : (S.voice.kind !== 'dm' && S.voice.serverId === v.serverId && S.voice.channelId === v.channelId);
}
function anowJoinBtn(v) {
  if (!v || !v.joinable) return null;
  const inThis = anowInThisRoom(v);
  const b = document.createElement('button');
  b.className = 'mini anow-join';
  b.textContent = inThis ? 'Open' : 'Join';
  b.title = inThis ? 'Open the call' : (v.kind === 'dm' ? 'Join this call' : 'Join this voice channel');
  b.onclick = async (e) => {
    e.stopPropagation();
    try {
      if (inThis) { openCallView(); return; }
      if (v.kind === 'dm') { joinDmCall(v.threadId, false); return; }
      if (v.nsfw && !S.me?.nsfw_ok && !(await openNsfwVoiceModal({ name: v.channelName || 'voice' }))) return;
      joinVoice(v.serverId, v.channelId);
    } catch (err) { toast('Could not join: ' + prettyError(err.message)); }
  };
  return b;
}
function activeCard(c) {
  const dot = dotOf(c.st, c.stream);
  const el = document.createElement('div');
  el.className = 'anow-card' + (c.off ? ' anow-off' : '');
  let act = '';
  if (c.stream) {
    act += `<div class="anow-stream"><span class="vlive">LIVE</span><span>Streaming <b>${esc(c.stream)}</b></span></div>`;
  }
  if (c.voice) act += anowVoiceHTML(c.voice);
  if (!c.stream && c.live) {
    act += `<div class="anow-game">Playing ${c.hit?.icon_url ? `<img class="anow-gicon" src="${esc(c.hit.icon_url)}" alt="" loading="lazy" onerror="this.remove()" />` : ''}<b>${esc(c.live)}</b>${c.hit ? `<span> · Lv ${c.hit.level} · ${fmtPlay(c.hit.total_ms)}</span>` : ''}</div>`;
  }
  if (!c.stream && !c.voice && !c.live && c.recent && c.recent.last_seen_ms) {
    act += `<div class="anow-recent">Last played <b>${esc(c.recent.game)}</b> · ${agoStr(c.recent.last_seen_ms)}</div>`;
  }
  const stLine = (!c.off && c.f.status_text) ? `<span class="anow-sub">${esc(c.f.status_text)}</span>` : '';
  el.innerHTML = `<span class="avwrap st-${dot}"><span class="avatar"></span><span class="status-dot ${dot}"></span></span><span class="anow-main"><span class="mname-row"><span class="anow-name" style="${nameStyleFor(c.f)}">${esc(c.f.display_name)}</span>${tagHTML(c.f)}</span><span class="anow-sub">@${esc(c.f.username)}</span>${stLine}${act}</span>`;
  paintAvatar(el.querySelector('.avatar'), c.f);
  const join = anowJoinBtn(c.voice);
  if (join) el.appendChild(join);
  el.onclick = (e) => openMemberCard(c.f.id, el);
  return el;
}
/* ---------- Active Now on a phone ----------
 * The rail lives in #members, which at <=900px is a drawer Home never opens
 * (Home hides the members button), so the same people are mirrored into the
 * home sidebar as a horizontal scroller under Stories — one compact tile per
 * friend, most-urgent first. Same data, same tap target (the member card) and
 * the same Join affordance as the desktop card. */
function anowTileLine(c) {
  if (c.stream) return { cls: ' stream', title: 'Streaming ' + c.stream, html: esc(c.stream) };
  if (c.voice) {
    const v = c.voice;
    const where = v.kind === 'dm' ? 'In a call' : (v.channelName ? 'In ' + v.channelName : 'In voice');
    return { cls: ' voice', title: (v.kind === 'dm' ? 'In a call' : 'In voice') + (v.serverName && v.joinable ? ' — ' + v.serverName : ''), html: esc(where) };
  }
  if (c.live) {
    const icon = c.hit?.icon_url ? `<img class="anow-gicon" src="${esc(c.hit.icon_url)}" alt="" loading="lazy" onerror="this.remove()" />` : '';
    return { cls: '', title: 'Playing ' + c.live, html: `${icon}${c.hit?.icon_url ? '' : 'Playing '}${esc(c.live)}` };
  }
  const label = c.st === 'away' ? 'Away' : (c.st === 'dnd' ? 'Do not disturb' : (c.f.status_text || 'Online'));
  return { cls: '', title: label, html: esc(label) };
}
function anowTileEl(c) {
  const dot = dotOf(c.st, c.stream);
  const line = anowTileLine(c);
  const el = document.createElement('div');
  el.className = 'anow-tile' + (c.off ? ' anow-off' : '');
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.title = `${c.f.display_name} — ${line.title}`;
  el.innerHTML = `<span class="avwrap st-${dot}"><span class="avatar"></span><span class="status-dot ${dot}"></span></span>`
    + `<span class="anow-tname" style="${nameStyleFor(c.f)}">${esc(c.f.display_name)}</span>`
    + `<span class="anow-tline${line.cls}" title="${esc(line.title)}">${line.html}</span>`;
  paintAvatar(el.querySelector('.avatar'), c.f);
  const join = anowJoinBtn(c.voice);
  if (join) el.appendChild(join);
  el.onclick = () => openMemberCard(c.f.id, el);
  el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMemberCard(c.f.id, el); } };
  return el;
}
function paintActiveNowStrip(g) {
  const wrap = $('#anow-strip'), rail = $('#anow-rail');
  if (!wrap || !rail) return;
  // Everyone the panel lists (streaming, then in voice, then playing, then
  // just online) in one scroller; nothing online → no strip at all.
  const list = [...g.streaming, ...g.voiced, ...g.playing, ...g.online];
  wrap.classList.toggle('hidden', !list.length);
  rail.innerHTML = '';
  for (const c of list) rail.appendChild(anowTileEl(c));
}
// One friend lands in exactly one section: streaming beats voice, voice beats
// now-playing, and everyone else online is just online.
function activeNowGroups(friends) {
  const cards = friends.map((f) => {
    const st = statusOf(f.id);
    const off = isOff(st);
    const stream = !off && (f.streaming_game || null);
    const voice = off ? null : (S.friendsVoice.get(f.id) || null);
    const g = activeGamingFresh(f.username);
    const live = !off && !stream ? (g?.now_playing || (!off && f.playing_game)) : null;
    const games = g?.games || [];
    const recent = games.length ? games.reduce((a, b) => ((a.last_seen_ms || 0) > (b.last_seen_ms || 0) ? a : b)) : null;
    const hit = live ? games.find((x) => x.game === live) : null;
    return { f, st, off, stream, voice, live, hit, recent };
  });
  const byName = (a, b) => a.f.display_name.localeCompare(b.f.display_name);
  return {
    streaming: cards.filter((c) => c.stream).sort(byName),
    voiced: cards.filter((c) => !c.stream && c.voice).sort(byName),
    playing: cards.filter((c) => !c.stream && !c.voice && c.live).sort(byName),
    online: cards.filter((c) => !c.stream && !c.voice && !c.live && !c.off).sort(byName),
  };
}
async function renderActiveNow() {
  if (S.view !== 'home') return;
  const box = $('#member-list');
  if (!box || !S.friends) return;
  const gen = ++activeNowGen;
  const friends = [...(S.friends.friends || [])];
  const paint = () => {
    if (gen !== activeNowGen || S.view !== 'home') return;
    const groups = activeNowGroups(friends);
    const { streaming, voiced, playing, online } = groups;
    paintActiveNowStrip(groups);
    // With a DM open the member panel lists that thread's members instead.
    if (S.dmThreadId) return;
    const head = $('#members-head');
    head.classList.remove('hidden');
    box.innerHTML = '';
    if (!friends.length) {
      $('#members-title').textContent = 'ACTIVE NOW';
      $('#online-count').textContent = '0';
      box.innerHTML = '<p class="muted small anow-empty">No friends yet — add someone from the list to see what they are up to.</p>';
      return;
    }
    $('#members-title').textContent = 'ACTIVE NOW';
    $('#online-count').textContent = String(streaming.length + voiced.length + playing.length);
    if (!streaming.length && !voiced.length && !playing.length && !online.length) {
      box.innerHTML = '<p class="muted small anow-empty">No friends are online right now.</p>';
      return;
    }
    const sec = (t, n) => {
      const e = document.createElement('div');
      e.className = 'role-head';
      e.innerHTML = `<span>${t}</span><span class="muted"> — ${n}</span>`;
      box.appendChild(e);
    };
    if (streaming.length) { sec('STREAMING', streaming.length); for (const c of streaming) box.appendChild(activeCard(c)); }
    if (voiced.length) { sec('IN VOICE', voiced.length); for (const c of voiced) box.appendChild(activeCard(c)); }
    if (playing.length) { sec('NOW PLAYING', playing.length); for (const c of playing) box.appendChild(activeCard(c)); }
    if (online.length) { sec('ONLINE', online.length); for (const c of online) box.appendChild(activeCard(c)); }
  };
  paint();
  const stale = friends.filter((f) => !activeGamingFresh(f.username));
  if (!stale.length) return;
  try {
    const res = await Promise.all(stale.map((f) => api('/api/users/' + encodeURIComponent(f.username) + '/gaming').catch(() => null)));
    res.forEach((d, i) => { if (d) activeGaming.set(stale[i].username, { at: Date.now(), data: d }); });
  } catch {}
  paint();
}
// `base` is the button class and `icon` adds the card-tab SVG (the profile
// screen keeps its plain pill). The label always sits in a span so both shapes
// lay out the same.
const FRIEND_TAB_ICONS = { friend: 'minus-user', 'pending-out': 'x-user', 'pending-in': 'check-user', none: 'plus' };
function friendBtnHTML(uid, id = 'uc-friend', base = 'btn small', icon = false) {
  const st = friendState(uid);
  const ico = (icon && typeof ucIconHTML === 'function') ? ucIconHTML(FRIEND_TAB_ICONS[st] || 'plus') : '';
  const mk = (mod, label) => `<button type="button" class="${base}${mod}" id="${id}" data-friend-state="${st}">${ico}<span>${label}</span></button>`;
  if (st === 'friend') return mk(' danger', 'Unfriend');
  if (st === 'pending-out') return mk('', 'Cancel request');
  if (st === 'pending-in') return mk(' primary', 'Accept request');
  return mk('', 'Add friend');
}
async function friendCardAction(uid, x, y) {
  const u = memberById(uid);
  const st = friendState(uid);
  try {
    if (st === 'friend') {
      const ok = await openConfirmModal({
        title: `Unfriend @${u?.username || 'user'}?`,
        message: 'They will be removed from your friends list.',
        okLabel: 'Unfriend',
      });
      if (!ok) return;
      await api(`/api/friends/${uid}`, { method: 'DELETE' });
      toast('Unfriended');
    } else if (st === 'pending-out') {
      await api(`/api/friends/${uid}`, { method: 'DELETE' });
      toast('Request cancelled');
    } else if (st === 'pending-in') {
      await api(`/api/friends/${uid}/accept`, { method: 'POST' });
      toast('Friend added');
    } else {
      if (!u) return;
      await api('/api/friends', { method: 'POST', body: JSON.stringify({ username: u.username }) });
      toast('Friend request sent');
    }
    await refreshFriends();
    openUserCard(uid, x, y);
  } catch (err) { toast(prettyError(err.message)); }
}
async function unfriendUser(id, username) {
  const ok = await openConfirmModal({
    title: `Unfriend @${username || 'user'}?`,
    message: 'They will be removed from your friends list.',
    okLabel: 'Unfriend',
  });
  if (!ok) return;
  try {
    await api(`/api/friends/${id}`, { method: 'DELETE' });
    toast('Unfriended');
    await refreshFriends();
  } catch (err) { toast(prettyError(err.message)); }
}
async function blockUser(id, username) {
  const ok = await openConfirmModal({
    title: `Block @${username || 'user'}?`,
    message: 'They will be removed from your friends and you will not see new requests from them.',
    okLabel: 'Block',
  });
  if (!ok) return;
  try {
    await api('/api/blocks', { method: 'POST', body: JSON.stringify({ userId: id }) });
    await refreshFriends();
    toast('User blocked');
  } catch (err) { toast('Block failed: ' + prettyError(err.message)); }
}
async function unblockUser(id) {
  try { await api(`/api/blocks/${id}`, { method: 'DELETE' }); await refreshFriends(); }
  catch (err) { toast('Unblock failed: ' + prettyError(err.message)); }
}
function renderFriendLists() {
  const f = S.friends;
  if (S.friendTab === 'blocked') S.friendTab = 'all'; // moved to Settings → Blocked
  document.querySelectorAll('#friend-tabs .ftab').forEach((b) => {
    b.classList.toggle('active', b.dataset.ftab === S.friendTab);
    b.onclick = () => { S.friendTab = b.dataset.ftab; renderFriendLists(); };
  });
  const nReq = f.pendingIn.length + f.pendingOut.length;
  $('#req-count').textContent = nReq ? ` (${nReq})` : '';
  const nbc = $('#friends-nav-count');
  if (nbc) { nbc.textContent = nReq > 99 ? '99+' : String(nReq); nbc.classList.toggle('hidden', !nReq); }
  // pending requests tab
  const rq = $('#friend-reqs');
  rq.innerHTML = '';
  $('#friend-reqs-wrap').style.display = S.friendTab === 'pending' ? '' : 'none';
  if (S.friendTab === 'pending') {
    if (!nReq) rq.innerHTML = '<p class="muted small" style="padding:0 .7rem">No pending requests.</p>';
    for (const u of f.pendingIn) {
      const row = friendRowEl(u);
      const wrap = document.createElement('div');
      wrap.className = 'row'; wrap.style.cssText = 'padding:0 .55rem';
      wrap.appendChild(row);
      const go = document.createElement('div'); go.className = 'row';
      const ok = smallBtn('Accept', async () => { await api(`/api/friends/${u.id}/accept`, { method: 'POST' }); refreshFriends(); });
      const no = smallBtn('Decline', async () => { await api(`/api/friends/${u.id}`, { method: 'DELETE' }); refreshFriends(); }, true);
      go.append(ok, no); wrap.appendChild(go);
      rq.appendChild(wrap);
    }
    for (const u of f.pendingOut) {
      const row = friendRowEl(u);
      const wrap = document.createElement('div');
      wrap.className = 'row'; wrap.style.cssText = 'padding:0 .55rem';
      wrap.appendChild(row);
      wrap.appendChild(smallBtn('Cancel', async () => { await api(`/api/friends/${u.id}`, { method: 'DELETE' }); refreshFriends(); }, true));
      rq.appendChild(wrap);
    }
  }
  // online / all friends tabs (hidden while viewing pending requests)
  const fl = $('#friend-list');
  fl.innerHTML = '';
  const showFriends = S.friendTab === 'online' || S.friendTab === 'all';
  fl.style.display = showFriends ? '' : 'none';
  if (showFriends) {
    const list = S.friendTab === 'online' ? f.friends.filter((u) => !isOff(statusOf(u.id))) : f.friends;
    if (!list.length) fl.innerHTML = S.friendTab === 'online'
      ? '<p class="muted small" style="padding:0 .7rem">No friends online right now.</p>'
      : '<p class="muted small" style="padding:0 .7rem">No friends yet — add someone above.</p>';
    for (const u of list) {
      const row = friendRowEl(u);
      row.title = `Message @${u.username}`;
      row.onclick = (e) => { if (e.target.closest('button')) return; openDmWith(u.id); };
      row.appendChild(friendIconBtn('Message', MAIL_SVG, () => openDmWith(u.id)));
      row.appendChild(friendIconBtn('More actions', DOTS_SVG, (e) => friendMoreMenu(u, e.currentTarget)));
      fl.appendChild(row);
    }
  }
  if (S.view === 'home' && !S.dmThreadId) renderActiveNow();
  try { renderFriendStoryRings(); } catch {}
}
function dmRowEl(t) {
  const b = document.createElement('button');
  b.className = 'dmrow' + (t.id === S.dmThreadId ? ' active' : '') + (t.pinned ? ' pinned' : '');
  b.dataset.dmthread = t.id;
  const av = t.isGroup ? null : dmPeer(t);
  // Presence light on direct DMs: same corner dot the friends list uses.
  const avSt = av ? statusOf(av.id) : '';
  const avDot = av ? dotOf(avSt, !isOff(avSt) && av.streaming_game ? av.streaming_game : null) : '';
  const callN = dmCallPeers(t.id).length || t.callCount || 0;
  const inThis = S.voice && S.voice.kind === 'dm' && S.voice.threadId === t.id;
  if (callN > 0 || inThis) b.classList.add('in-call');
  // Attachment-only messages still read as a sentence in the preview
  // ("Cross: Sent an attachment") instead of trailing off after the colon.
  const lastText = t.last
    ? (String(t.last.content || '').trim() || ((t.last.attachments || 0) > 0 ? 'Sent an attachment' : ''))
    : '';
  const sub = inThis ? '<span class="dm-incall">In call — you</span>'
    : callN > 0 ? `<span class="dm-incall">${callN} in call — open to join</span>`
    : esc(t.last ? `${t.last.author}: ${lastText}`.slice(0, 60) : 'No messages yet');
  // Name span holds only the text: the gradient style clips its background to
  // the element box, so a tag inside would eat the far colour stop. The
  // mname-row keeps name + tag on one line with the tag right after the name.
  const avHTML = av
    ? `<span class="avwrap st-${avDot}"><span class="avatar"></span><span class="status-dot ${avDot}"></span></span>`
    : `<span class="avatar">${t.isGroup ? '#' : ''}</span>`;
  b.innerHTML = `${avHTML}<span class="dmmain"><span class="mname-row"><span class="dmname" style="${!t.isGroup && av ? nameStyleFor(av) : ''}">${esc(dmTitle(t))}</span>${!t.isGroup && av ? tagHTML(av, true) : ''}</span><span class="dmlast">${sub}</span></span>`;
  const avSpan = b.querySelector('.avatar');
  if (av) paintAvatar(avSpan, av);
  else avSpan.style.background = 'var(--panel-3)';
  avSpan.style.boxShadow = 'none'; // no grey ring on sidebar DM pfps (matches the DM rail)
  if (av) { try { paintDMStoryRing(b, av); } catch {} }
  // Sidebar banner: the DM list is a people roster, not a presence view (rows
  // aren't dimmed), so the peer's banner shows even while they're offline —
  // same picture the member sidebar paints next to their name.
  if (av && av.sidebar_banner_url) {
    b.classList.add('has-banner');
    paintSidebarBanner(b, av.sidebar_banner_url, 'var(--panel)');
  }
  b.onclick = () => selectDmThread(t.id);
  if (t.pinned) {
    const pin = document.createElement('span');
    pin.className = 'dm-pin';
    pin.title = 'Pinned to top';
    pin.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l1 7 3 3v2H5v-2l3-3z"/><path d="M12 16v5"/></svg>';
    b.appendChild(pin);
  }
  const unread = S.dmUnread.get(t.id) || 0;
  if (unread > 0) {
    const badge = document.createElement('span');
    badge.className = 'dm-badge';
    badge.textContent = unread > 99 ? '99+' : String(unread);
    b.appendChild(badge);
  }
  if (!t.isGroup) {
    const x = document.createElement('span');
    x.className = 'dm-close';
    x.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    x.title = 'Close DM';
    x.setAttribute('role', 'button');
    x.tabIndex = 0;
    const doClose = (e) => { e.stopPropagation(); closeDm(t.id); };
    x.onclick = doClose;
    x.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doClose(e); } };
    b.appendChild(x);
  }
  return b;
}
function dmLastTs(t) { return (t.last && t.last.created_at) || t.created_at || 0; }
function sortDmThreads(list) {
  return [...list].sort((a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || (dmLastTs(b) - dmLastTs(a)));
}
function renderDmLists() {
  const dl = $('#dm-list'), gl = $('#group-list');
  dl.innerHTML = ''; gl.innerHTML = '';
  for (const t of sortDmThreads(S.dms.filter((x) => !x.isGroup))) dl.appendChild(dmRowEl(t));
  for (const t of sortDmThreads(S.dms.filter((x) => x.isGroup))) gl.appendChild(dmRowEl(t));
  paintHomeBadge();
}
async function openDmWith(userId) {
  try {
    const { thread } = await api('/api/dms', { method: 'POST', body: JSON.stringify({ userId }) });
    await refreshDms();
    selectDmThread(thread.id);
  } catch (err) { toast(prettyError(err.message)); }
}
// User card → Message: jump to Home if needed, then open (or create) the 1:1.
// No friendship required — strangers can DM each other unless blocked.
async function messageUser(uid) {
  closeUserCard();
  if (S.view !== 'home') await openHome();
  await openDmWith(uid);
}
async function closeDm(tid) {
  try { await api(`/api/dms/${tid}/close`, { method: 'POST' }); } catch {}
  if (S.dmThreadId === tid) { saveScrollPos(); S.dmThreadId = null; renderDmBlank(); rememberHomeTab(); }
  refreshDms();
}
// Member-card style friend picker row: presence-ring avatar + name/sub-line
// with a big native checkbox. Shared by new-group, add-members and the
// server-invite friend picker.
function gmemRowEl(u) {
  const st = statusOf(u.id);
  const off = isOff(st);
  const streaming = !off && (u.streaming_game || null);
  const dot = dotOf(st, streaming);
  const playing = !off && !streaming && u.playing_game;
  const lab = document.createElement('label');
  lab.className = 'member gmem';
  lab.dataset.search = `${u.display_name || ''} ${u.username || ''}`.toLowerCase();
  lab.title = `Add ${u.display_name || u.username}`;
  lab.innerHTML = `<span class="avwrap st-${dot}"><span class="avatar"></span><span class="status-dot ${dot}"></span></span>`
    + `<span class="dmmain"><span class="mname-row"><span class="dmname" style="${nameStyleFor(u)}">${esc(u.display_name)}</span>${tagHTML(u)}</span>`
    + `<span class="dmlast">@${esc(u.username)}${streaming ? ` · <span class="ustream-t">Streaming ${esc(streaming)}</span>` : (u.status_text ? ' · ' + esc(u.status_text) : (playing ? ` · Playing ${esc(playing)}` : ''))}</span></span>`
    + `<input type="checkbox" class="gcheck" value="${u.id}" />`;
  paintAvatar(lab.querySelector('.avatar'), u);
  const cb = lab.querySelector('.gcheck');
  cb.addEventListener('change', () => lab.classList.toggle('sel', cb.checked));
  return lab;
}
function mountGmemPicker(box, users) {
  box.innerHTML = '';
  const sorted = [...users].sort((a, b) => String(a.display_name || a.username || '').localeCompare(String(b.display_name || b.username || '')));
  for (const u of sorted) box.appendChild(gmemRowEl(u));
}
// Group chats fit 9 friends + creator (DM_GROUP_MAX total).
const DM_GROUP_MAX = 10;
// Search filter + selected counter for a mounted picker. When max is set,
// selection caps there (the rest disable) and the counter shows the cap.
function wireGmemPicker(searchSel, boxSel, countSel, max) {
  const inp = document.querySelector(searchSel), box = document.querySelector(boxSel), count = countSel && document.querySelector(countSel);
  if (!box) return;
  const total = box.querySelectorAll('.gmem').length;
  const update = () => {
    const q = (inp && inp.value || '').trim().toLowerCase();
    let visible = 0;
    for (const lab of box.querySelectorAll('.gmem')) {
      const hit = !q || (lab.dataset.search || '').includes(q);
      lab.style.display = hit ? '' : 'none';
      if (hit) visible++;
    }
    const boxes = [...box.querySelectorAll('.gcheck')];
    const picked = boxes.filter((c) => c.checked).length;
    if (max) for (const c of boxes) c.disabled = !c.checked && picked >= max;
    let none = box.querySelector('.gmem-none');
    if (!visible) {
      if (!none) { none = document.createElement('p'); none.className = 'muted small gmem-none'; none.style.padding = '.4rem .2rem'; box.appendChild(none); }
      none.textContent = 'No friends match.';
    } else none?.remove();
    if (count) count.textContent = max
      ? (picked ? `${picked}/${max} selected` : `${total} friend${total === 1 ? '' : 's'} · pick up to ${max}`)
      : (picked ? `${picked} selected` : `${total} friend${total === 1 ? '' : 's'}`);
  };
  inp?.addEventListener('input', update);
  box.addEventListener('change', update);
  update();
}
function openGroupModal() {
  const friends = S.friends.friends || [];
  const max = DM_GROUP_MAX - 1; // seats for friends — you take one
  openModal('New group chat', `
    <label>Group name<input id="m-group-name" maxlength="40" placeholder="e.g. Weekend squad" /></label>
    ${friends.length ? `<p class="muted small" style="margin:.4rem 0 0">Up to ${DM_GROUP_MAX - 1} friends.</p>
    <input id="m-group-search" placeholder="Search friends…" autocomplete="off" />
    <div class="gmem-count muted small" id="m-group-count"></div>
    <div class="gmem-list" id="m-group-picks"></div>` : '<p class="muted small">Just you for now — invite friends later.</p><div id="m-group-picks"></div>'}`, 'Create', async () => {
    const name = (document.querySelector('#m-group-name') || {}).value || '';
    const ids = [...document.querySelectorAll('#m-group-picks input:checked')].map((i) => i.value);
    if (ids.length > max) { toast(`Group chats fit up to ${DM_GROUP_MAX - 1} friends`); return; }
    try {
      const { thread } = await api('/api/dms/group', { method: 'POST', body: JSON.stringify({ name, userIds: ids }) });
      await refreshDms();
      selectDmThread(thread.id);
    } catch (err) { toast(prettyError(err.message)); }
  }, { wide: true });
  const gbox = document.querySelector('#m-group-picks');
  if (gbox && friends.length) { mountGmemPicker(gbox, friends); wireGmemPicker('#m-group-search', '#m-group-picks', '#m-group-count', max); }
}
async function toggleDmPin(tid) {
  const t = S.dms.find((x) => x.id === tid);
  if (!t) return;
  // Optimistic: flip locally so the list re-sorts instantly, then confirm.
  t.pinned = !t.pinned;
  renderDmLists();
  try {
    await api(`/api/dms/${tid}/${t.pinned ? 'pin' : 'unpin'}`, { method: 'POST' });
    toast(t.pinned ? 'Pinned to top' : 'Unpinned');
  } catch { t.pinned = !t.pinned; renderDmLists(); toast('Pin failed'); }
  refreshDms();
}
function dmCtxMenu(tid, x, y) {
  const items = dmMenuItems(tid);
  if (items.length) openCtx(x, y, items);
}
// Same item list for the desktop popup and the mobile slide-up sheet, so the
// two can never drift apart.
function dmMenuItems(tid) {
  const t = S.dms.find((x) => x.id === tid);
  if (!t) return [];
  const items = [
    { label: 'Open', icon: '→', fn: () => selectDmThread(tid) },
    { label: t.pinned ? 'Unpin chat' : 'Pin chat', icon: (typeof PIN_SVG !== 'undefined' ? PIN_SVG : '📌'), fn: () => toggleDmPin(tid) },
  ];
  if (t.isGroup) {
    items.push({ sep: true });
    items.push({ label: 'Edit group chat', icon: '✎', fn: () => openGroupEdit(tid) });
    items.push({ label: 'Add members…', icon: '+', fn: () => openGroupAdd(tid) });
    items.push({ sep: true });
    items.push({ label: 'Leave chat', icon: '🗑', danger: true, fn: async () => {
      try { await api(`/api/dms/${tid}/leave`, { method: 'POST' }); } catch {}
      if (S.dmThreadId === tid) { saveScrollPos(); S.dmThreadId = null; renderDmBlank(); rememberView(); rememberHomeTab(); }
      refreshDms();
    } });
  } else {
    // Direct (1:1) DMs can be dismissed but never totally left — Leave only exists for groups.
    items.push({ sep: true });
    items.push({ label: 'Close DM', icon: '×', fn: () => closeDm(tid) });
  }
  return items;
}
// Mobile long-press on a DM / group row opens the slide-up sheet (same items
// as the desktop right-click popup), headed by the conversation's avatar.
function openDmSheet(tid) {
  const t = S.dms.find((x) => x.id === tid);
  if (!t) return;
  const items = dmMenuItems(tid);
  if (!items.length) return;
  const peer = dmPeer(t);
  const head = t.isGroup
    ? { title: dmTitle(t), sub: (t.members || []).length + ' member' + ((t.members || []).length === 1 ? '' : 's'), glyph: '#', color: 'var(--panel-3)' }
    : { title: (peer || {}).display_name || 'Direct message', sub: peer ? '@' + peer.username : '', serverUser: peer || undefined, glyph: '?' };
  openCtxSheet(items, head);
}
// Group chat settings: name + description. The only surface is the DM row's
// right-click / long-press menu; the server re-checks membership and is_group.
async function openGroupEdit(tid) {
  const t = S.dms.find((x) => x.id === tid);
  if (!t || !t.isGroup) return;
  openModal('Group chat settings', `
    <label>Group name<input id="m-grp-name" maxlength="40" value="${esc(t.name || '')}" placeholder="Group chat" /></label>
    <label style="margin-top:.6rem;display:block">Description<input id="m-grp-desc" maxlength="300" value="${esc(t.description || '')}" placeholder="What's this group about?" /></label>
  `, 'Save', async () => {
    const name = ($('#m-grp-name')?.value || '').trim();
    const description = ($('#m-grp-desc')?.value || '').trim();
    try {
      await api(`/api/dms/${tid}`, { method: 'PATCH', body: JSON.stringify({ name, description }) });
    } catch (err) { toast('Save failed: ' + prettyError(err.message)); return; }
    await refreshDms();
    if (S.view === 'home' && S.dmThreadId === tid) paintDmHead(S.dms.find((x) => x.id === tid));
    toast('Group chat updated');
  });
}
// The open conversation's header: hash + name + placeholder, plus the topic
// line (a group's description). Shared by selectDmThread and the socket's
// dm-threads-changed so a rename on another device reaches this header too.
function paintDmHead(t) {
  if (!t) return;
  const peer = dmPeer(t);
  $('#chan-hash').textContent = t.isGroup ? '' : '@';
  $('#chan-name').textContent = t.isGroup ? (t.name || 'Group chat') : ((peer || {}).display_name || 'DM');
  $('#in-message').placeholder = t.isGroup ? `Message ${t.name || 'group'}` : `Message @${(peer || {}).username || ''}`;
  renderTopic();
}
async function openGroupAdd(tid) {
  const t = S.dms.find((x) => x.id === tid);
  if (!t) return;
  await ensureFriends();
  const inGroup = new Set((t.members || []).map((m) => m.id));
  const cands = (S.friends.friends || []).filter((f) => !inGroup.has(f.id));
  if (!cands.length) { toast('No friends to add — everyone is already here'); return; }
  const roomLeft = DM_GROUP_MAX - (t.members || []).length;
  if (roomLeft <= 0) { toast(`Group is full — ${DM_GROUP_MAX - 1} friends max`); return; }
  openModal(`Add to ${esc(t.name || 'group chat')}`, `
    <p class="muted small" style="margin:.2rem 0 0">${roomLeft} of ${DM_GROUP_MAX - 1} friend spots left.</p>
    <input id="m-add-search" placeholder="Search friends…" autocomplete="off" />
    <div class="gmem-count muted small" id="m-add-count"></div>
    <div class="gmem-list" id="m-add-picks"></div>`, 'Add', async () => {
    const ids = [...document.querySelectorAll('#m-add-picks input:checked')].map((i) => i.value);
    if (!ids.length) return;
    let failed = 0, full = false;
    for (const id of ids) {
      try { await api(`/api/dms/${tid}/members`, { method: 'POST', body: JSON.stringify({ userId: id }) }); }
      catch (err) { failed++; if (err.message === 'group_full') full = true; }
    }
    await refreshDms();
    if (S.view === 'home' && S.dmThreadId === tid) selectDmThread(tid);
    if (full) toast(`Group is full — ${DM_GROUP_MAX - 1} friends max`);
    else if (failed >= ids.length) toast('Could not add members');
    else if (failed) toast('Some members could not be added');
    else toast(ids.length === 1 ? 'Member added' : 'Members added');
  }, { wide: true });
  const abox = document.querySelector('#m-add-picks');
  if (abox) { mountGmemPicker(abox, cands); wireGmemPicker('#m-add-search', '#m-add-picks', '#m-add-count', roomLeft); }
}

