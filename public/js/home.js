'use strict';
/* ================= home: friends + DMs ================= */
function dmPeer(t) { return (t.members || []).find((m) => m.id !== S.me.id) || null; }
function dmTitle(t) { return t.isGroup ? (t.name || 'Group chat') : ((dmPeer(t) || {}).display_name || 'Direct message'); }
function openServerView() {
  S.view = 'server';
  S.callOpen = false;
  stopRinging();
  $('#chat').classList.remove('call-open');
  document.body.classList.remove('view-home', 'dm-open');
  $('#friends-page').classList.add('hidden');
  $('#messages').classList.remove('hidden');
  $('#server-ui').classList.remove('hidden');
  $('#home-ui').classList.add('hidden');
  $('#btn-home').classList.remove('active');
  paintDmCallButtons();
}
async function openHome() {
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
  document.querySelectorAll('#server-list .server-btn').forEach((b) => b.classList.remove('active'));
  rememberView();
  closeThread(true);
  await Promise.all([refreshFriends(), refreshDms()]);
  S.dmThreadId = null;
  renderDmBlank();
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
    renderDmLists();
  } catch {}
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
  const dot = dotOf(st);
  const div = document.createElement('div');
  div.className = 'dmrow';
  const fPlaying = !isOff(st) && u.playing_game;
  div.innerHTML = `<span class="avwrap st-${dot}"><span class="avatar"></span><span class="status-dot ${dot}"></span></span><span class="dmmain"><span class="mname-row"><span class="dmname" style="${nameStyleFor(u)}">${esc(u.display_name)}</span>${fPlaying ? gameBadgeHTML(u.playing_game) : ''}</span><span class="dmlast">@${esc(u.username)}${u.status_text ? ' · ' + esc(u.status_text) : (fPlaying ? ` · Playing ${esc(u.playing_game)}` : '')}</span></span>`;
  paintAvatar(div.querySelector('.avatar'), u);
  paintGameBadge(div.querySelector('.gbadge'));
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
function isBlocked(id) { return (S.friends.blocked || []).some((u) => u.id === id); }
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
function activeCard(c) {
  const dot = dotOf(c.st);
  const el = document.createElement('div');
  el.className = 'anow-card' + (c.off ? ' anow-off' : '');
  let act = '';
  if (c.live) {
    act = `<div class="anow-game">Playing ${c.hit?.icon_url ? `<img class="anow-gicon" src="${esc(c.hit.icon_url)}" alt="" loading="lazy" onerror="this.remove()" />` : ''}<b>${esc(c.live)}</b>${c.hit ? `<span> · Lv ${c.hit.level} · ${fmtPlay(c.hit.total_ms)}</span>` : ''}</div>`;
  } else if (c.recent && c.recent.last_seen_ms) {
    act = `<div class="anow-recent">Last played <b>${esc(c.recent.game)}</b> · ${agoStr(c.recent.last_seen_ms)}</div>`;
  }
  const stLine = (!c.off && c.f.status_text) ? `<span class="anow-sub">${esc(c.f.status_text)}</span>` : '';
  el.innerHTML = `<span class="avwrap st-${dot}"><span class="avatar"></span><span class="status-dot ${dot}"></span></span><span class="anow-main"><span class="anow-name" style="${nameStyleFor(c.f)}">${esc(c.f.display_name)}</span><span class="anow-sub">@${esc(c.f.username)}</span>${stLine}${act}</span>`;
  paintAvatar(el.querySelector('.avatar'), c.f);
  el.onclick = (e) => openMemberCard(c.f.id, el);
  return el;
}
async function renderActiveNow() {
  if (S.view !== 'home' || S.dmThreadId) return;
  const box = $('#member-list');
  if (!box || !S.friends) return;
  const gen = ++activeNowGen;
  const friends = [...(S.friends.friends || [])];
  const paint = () => {
    if (gen !== activeNowGen || S.view !== 'home' || S.dmThreadId) return;
    const head = $('#members-head');
    head.classList.remove('hidden');
    box.innerHTML = '';
    if (!friends.length) {
      $('#members-title').textContent = 'ACTIVE NOW';
      $('#online-count').textContent = '0';
      box.innerHTML = '<p class="muted small anow-empty">No friends yet — add someone from the list to see what they are up to.</p>';
      return;
    }
    const cards = friends.map((f) => {
      const st = statusOf(f.id);
      const off = isOff(st);
      const g = activeGamingFresh(f.username);
      const live = !off ? (g?.now_playing || (!off && f.playing_game)) : null;
      const games = g?.games || [];
      const recent = games.length ? games.reduce((a, b) => ((a.last_seen_ms || 0) > (b.last_seen_ms || 0) ? a : b)) : null;
      const hit = live ? games.find((x) => x.game === live) : null;
      return { f, st, off, live, hit, recent };
    });
    const playing = cards.filter((c) => c.live).sort((a, b) => a.f.display_name.localeCompare(b.f.display_name));
    const online = cards.filter((c) => !c.live && !c.off).sort((a, b) => a.f.display_name.localeCompare(b.f.display_name));
    const offline = cards.filter((c) => c.off).sort((a, b) => ((b.recent?.last_seen_ms || 0) - (a.recent?.last_seen_ms || 0)) || a.f.display_name.localeCompare(b.f.display_name));
    $('#members-title').textContent = 'ACTIVE NOW';
    $('#online-count').textContent = String(playing.length);
    const sec = (t, n) => {
      const e = document.createElement('div');
      e.className = 'role-head';
      e.innerHTML = `<span>${t}</span><span class="muted"> — ${n}</span>`;
      box.appendChild(e);
    };
    if (playing.length) { sec('NOW PLAYING', playing.length); for (const c of playing) box.appendChild(activeCard(c)); }
    if (online.length) { sec('ONLINE', online.length); for (const c of online) box.appendChild(activeCard(c)); }
    if (offline.length) { sec('OFFLINE', offline.length); for (const c of offline) box.appendChild(activeCard(c)); }
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
function friendBtnHTML(uid, id = 'uc-friend') {
  const st = friendState(uid);
  if (st === 'friend') return `<button class="btn small danger" id="${id}">Unfriend</button>`;
  if (st === 'pending-out') return `<button class="btn small" id="${id}">Cancel request</button>`;
  if (st === 'pending-in') return `<button class="btn small primary" id="${id}">Accept request</button>`;
  return `<button class="btn small" id="${id}">Add friend</button>`;
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
  document.querySelectorAll('#friend-tabs .ftab').forEach((b) => {
    b.classList.toggle('active', b.dataset.ftab === S.friendTab);
    b.onclick = () => { S.friendTab = b.dataset.ftab; renderFriendLists(); };
  });
  const nReq = f.pendingIn.length + f.pendingOut.length;
  $('#req-count').textContent = nReq ? ` (${nReq})` : '';
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
  // online / all friends tabs
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
      row.appendChild(smallBtn('Message', () => openDmWith(u.id)));
      row.appendChild(smallBtn('Unfriend', () => unfriendUser(u.id, u.username), true));
      row.appendChild(smallBtn('Block', () => blockUser(u.id, u.username), true));
      fl.appendChild(row);
    }
  }
  // blocked tab
  const bl = $('#blocked-list');
  bl.innerHTML = '';
  bl.style.display = S.friendTab === 'blocked' ? '' : 'none';
  if (S.friendTab === 'blocked') {
    const blocked = f.blocked || [];
    if (!blocked.length) bl.innerHTML = '<p class="muted small" style="padding:0 .7rem">Nobody blocked.</p>';
    for (const u of blocked) {
      const row = friendRowEl(u);
      row.appendChild(smallBtn('Unblock', () => unblockUser(u.id)));
      bl.appendChild(row);
    }
  }
  if (S.view === 'home' && !S.dmThreadId) renderActiveNow();
}
function dmRowEl(t) {
  const b = document.createElement('button');
  b.className = 'dmrow' + (t.id === S.dmThreadId ? ' active' : '');
  b.dataset.dmthread = t.id;
  const av = t.isGroup ? null : dmPeer(t);
  const callN = dmCallPeers(t.id).length || t.callCount || 0;
  const inThis = S.voice && S.voice.kind === 'dm' && S.voice.threadId === t.id;
  if (callN > 0 || inThis) b.classList.add('in-call');
  const sub = inThis ? '<span class="dm-incall">In call — you</span>'
    : callN > 0 ? `<span class="dm-incall">${callN} in call — open to join</span>`
    : esc(t.last ? `${t.last.author}: ${t.last.content}`.slice(0, 60) : 'No messages yet');
  b.innerHTML = `<span class="avatar">${t.isGroup ? '#' : ''}</span><span class="dmmain"><span class="dmname" style="${!t.isGroup && av ? nameStyleFor(av) : ''}">${esc(dmTitle(t))}</span><span class="dmlast">${sub}</span></span>`;
  const avSpan = b.querySelector('.avatar');
  if (av) paintAvatar(avSpan, av);
  else avSpan.style.background = 'var(--panel-3)';
  avSpan.style.boxShadow = 'none'; // no grey ring on sidebar DM pfps (matches the DM rail)
  if (av && av.sidebar_banner_url && !isOff(statusOf(av.id))) {
    b.style.backgroundImage = `linear-gradient(rgba(0,0,0,.45),rgba(0,0,0,.45)),linear-gradient(90deg, var(--panel) 5%, rgba(0,0,0,0) 78%), url("${av.sidebar_banner_url}")`;
    b.style.backgroundSize = 'cover';
    b.style.backgroundPosition = 'right center';
  }
  b.onclick = () => selectDmThread(t.id);
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
    x.textContent = '×';
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
function renderDmLists() {
  const dl = $('#dm-list'), gl = $('#group-list');
  dl.innerHTML = ''; gl.innerHTML = '';
  for (const t of S.dms.filter((x) => !x.isGroup)) dl.appendChild(dmRowEl(t));
  for (const t of S.dms.filter((x) => x.isGroup)) gl.appendChild(dmRowEl(t));
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
  if (S.dmThreadId === tid) { S.dmThreadId = null; renderDmBlank(); }
  refreshDms();
}
function openGroupModal() {
  const friends = S.friends.friends;
  openModal('New group chat', `
    <label>Group name<input id="m-group-name" maxlength="40" placeholder="e.g. Notes to self" /></label>
    ${friends.length ? `<div style="margin-top:.6rem;max-height:220px;overflow-y:auto" id="m-group-picks">
      ${friends.map((f) => `<label class="gpick"><input type="checkbox" value="${f.id}" /> ${esc(f.display_name)} <span class="muted">@${esc(f.username)}</span></label>`).join('')}
    </div>` : '<p class="muted small">Just you for now — invite friends later.</p><div id="m-group-picks"></div>'}`, 'Create', async () => {
    const name = (document.querySelector('#m-group-name') || {}).value || '';
    const ids = [...document.querySelectorAll('#m-group-picks input:checked')].map((i) => i.value);
    try {
      const { thread } = await api('/api/dms/group', { method: 'POST', body: JSON.stringify({ name, userIds: ids }) });
      await refreshDms();
      selectDmThread(thread.id);
    } catch (err) { toast(prettyError(err.message)); }
  });
}
function dmCtxMenu(tid, x, y) {
  const t = S.dms.find((t) => t.id === tid);
  const items = [
    { label: 'Open', icon: '→', fn: () => selectDmThread(tid) },
  ];
  if (t && !t.isGroup) {
    items.push({ label: 'Close DM', icon: '×', fn: () => closeDm(tid) });
  }
  if (t && t.isGroup) {
    items.push({ label: 'Add members…', icon: '+', fn: () => openGroupAdd(tid) });
  }
  if (t && t.isGroup && t.created_by === S.me?.id) {
    items.push({ label: 'Banned members…', icon: '⊘', fn: () => openGroupBans(tid) });
  }
  // Direct (1:1) DMs can be dismissed but never totally left — Leave only exists for groups.
  if (t && t.isGroup) {
    items.push({ label: 'Leave chat', icon: '🗑', danger: true, fn: async () => {
      try { await api(`/api/dms/${tid}/leave`, { method: 'POST' }); } catch {}
      if (S.dmThreadId === tid) { S.dmThreadId = null; renderDmBlank(); rememberView(); }
      refreshDms();
    } });
  }
  openCtx(x, y, items);
}
async function openGroupAdd(tid) {
  const t = S.dms.find((x) => x.id === tid);
  if (!t) return;
  await ensureFriends();
  const inGroup = new Set((t.members || []).map((m) => m.id));
  const cands = (S.friends.friends || []).filter((f) => !inGroup.has(f.id));
  if (!cands.length) { toast('No friends to add — everyone is already here'); return; }
  openModal(`Add to ${esc(t.name || 'group chat')}`, `
    <div style="margin-top:.2rem;max-height:220px;overflow-y:auto" id="m-add-picks">
      ${cands.map((f) => `<label class="gpick"><input type="checkbox" value="${f.id}" /> ${esc(f.display_name)} <span class="muted">@${esc(f.username)}</span></label>`).join('')}
    </div>`, 'Add', async () => {
    const ids = [...document.querySelectorAll('#m-add-picks input:checked')].map((i) => i.value);
    if (!ids.length) return;
    let failed = 0;
    for (const id of ids) {
      try { await api(`/api/dms/${tid}/members`, { method: 'POST', body: JSON.stringify({ userId: id }) }); }
      catch { failed++; }
    }
    await refreshDms();
    if (S.view === 'home' && S.dmThreadId === tid) selectDmThread(tid);
    if (failed >= ids.length) toast('Could not add members');
    else if (failed) toast('Some members could not be added');
    else toast(ids.length === 1 ? 'Member added' : 'Members added');
  });
}
async function openGroupBans(tid) {
  let bans = [];
  try { ({ bans } = await api(`/api/dms/${tid}/bans`)); } catch { toast('Could not load banned list'); return; }
  openModal('Banned members', bans.length
    ? `<div id="m-banlist">${bans.map((u) => `<div class="row" style="justify-content:space-between;padding:.3rem 0"><span>${esc(u.display_name)} <span class="muted small">@${esc(u.username)}</span></span><button class="mini" data-unban="${u.id}">Unban</button></div>`).join('')}</div>`
    : '<p class="muted small">Nobody is banned from this group.</p>', 'Done', null);
  document.querySelectorAll('#m-banlist [data-unban]').forEach((b) => (b.onclick = async () => {
    try { await api(`/api/dms/${tid}/bans/${b.dataset.unban}`, { method: 'DELETE' }); } catch {}
    $('#modal-backdrop').classList.add('hidden');
    openGroupBans(tid);
  }));
}
