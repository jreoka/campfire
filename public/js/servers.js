'use strict';
// ---------- servers / channels ----------
async function refreshServers(selectId, autoSelect = true) {
  const { servers } = await api('/api/servers');
  S.servers = servers;
  try {
    const { folders, order } = await api('/api/me/layout');
    S.layoutFolders = (folders || []).map((f) => ({ ...f, open: f.open !== 0, servers: [] }));
    S.serverMeta = new Map((order || []).map((o) => [o.server_id, { folderId: o.folder_id, position: o.position }]));
  } catch { S.layoutFolders = []; S.serverMeta = new Map(); }
  buildRootOrder();
  S.openFolderId = null;
  if (!servers.length) {
    S.serverId = null;
    renderServerList();
    await openHome();
    refreshAllEmojis().catch(() => {});
    return;
  }
  if (selectId) S.serverId = selectId;
  // autoSelect: land on a server when none is chosen (join/leave/first visit).
  // Not at boot with a remembered Home view — that would jump into the first
  // server and leave its rail button highlighted on top of Home's.
  if (autoSelect && (!S.serverId || !servers.find((s) => s.id === S.serverId))) S.serverId = servers[0].id;
  renderServerList();
  // Never yank the user out of Home (e.g. kicked from a server while on Home).
  if (S.view !== 'home' && S.serverId && servers.find((s) => s.id === S.serverId)) await selectServer(S.serverId);
  // membership changed (join/leave/kick) — refresh the cross-server emoji union
  refreshAllEmojis().catch(() => {});
}
function folderById(id) { return S.layoutFolders.find((f) => f.id === id); }
function buildRootOrder() {
  // Assign each server to its folder (by folder_id) or leave it unfiled, then
  // build one sorted rail list of folders + unfiled servers using scalar position.
  for (const f of S.layoutFolders) f.servers = [];
  for (const s of S.servers) {
    const m = S.serverMeta.get(s.id);
    const f = m && m.folderId ? folderById(m.folderId) : null;
    if (f) f.servers.push(s.id);
  }
  for (const f of S.layoutFolders) {
    f.servers.sort((x, y) => (S.serverMeta.get(x)?.position ?? 999) - (S.serverMeta.get(y)?.position ?? 999));
  }
  const pos = (id) => S.serverMeta.get(id)?.position ?? 999;
  const fpos = (id) => (folderById(id)?.position ?? 999);
  S.rootOrder = [
    ...S.layoutFolders.map((f) => ({ kind: 'folder', id: f.id, pos: fpos(f.id) })),
    ...S.servers.filter((s) => !(S.serverMeta.get(s.id)?.folderId && folderById(S.serverMeta.get(s.id).folderId))).map((s) => ({ kind: 'server', id: s.id, pos: pos(s.id) })),
  ].sort((x, y) => x.pos - y.pos);
}
function isFolderActive(f) { return S.view === 'server' && (f.servers || []).includes(S.serverId); }
function iconCell(s) {
  const label = (s.name || '?').trim().charAt(0).toUpperCase() || '?';
  if (s.icon_url) {
    // Show the image alone once it loads; keep the letter only as a fallback
    // if the image fails (onerror) — never overlay the letter on a real pfp.
    return '<span class="fc"><img src="' + esc(s.icon_url) + '" alt="" loading="lazy" draggable="false" onerror="this.style.display=\'none\'" onload="this.nextElementSibling.style.display=\'none\'" /><span class="fc-letter">' + esc(label) + '</span></span>';
  }
  return '<span class="fc"><span class="fc-letter">' + esc(label) + '</span></span>';
}
function folderGridHtml(f) {
  const kids = (f.servers || []).map((id) => S.servers.find((s) => s.id === id)).filter(Boolean);
  if (!kids.length) return '<span class="fgrid fg0"><span class="fc-letter fg-empty">' + esc((f.name || 'F').trim().charAt(0).toUpperCase()) + '</span></span>';
  const shown = kids.slice(0, 4);
  return '<span class="fgrid fg' + shown.length + '">' + shown.map(iconCell).join('') + '</span>';
}
function serverBtn(s) {
  const b = document.createElement('button');
  const label = s.name.trim().charAt(0).toUpperCase() || '?';
  b.className = 'server-btn' + (S.view === 'server' && s.id === S.serverId ? ' active' : '') + (s.icon_url ? ' has-icon' : '') + (serverMuted(s.id) ? ' muted' : '');
  b.title = s.name;
  b.draggable = !isCoarse(); // touch devices: drop native drag so long-press opens the slide-up sheet
  b.dataset.drag = 'server:' + s.id;
  b.dataset.sid = s.id;
  if (s.icon_url) {
    const img = document.createElement('img');
    img.src = s.icon_url; img.alt = ''; img.draggable = false;
    img.width = 48; img.height = 48;
    img.style.cssText = 'width:48px!important;height:48px!important;object-fit:cover!important;border-radius:inherit!important;display:block!important;pointer-events:none!important';
    img.onerror = () => { b.classList.remove('has-icon'); b.innerHTML = ''; b.textContent = label; };
    b.appendChild(img);
  } else {
    b.textContent = label;
  }
  b.onclick = () => selectServer(s.id);
  wireDrag(b, 'server', s.id);
  return b;
}
function folderBtn(f) {
  const w = document.createElement('div');
  w.className = 'fwrap' + (isFolderActive(f) ? ' active' : '');
  const b = document.createElement('button');
  b.className = 'folder-btn' + (S.openFolderId === f.id ? ' open' : '');
  b.title = f.name || 'Folder';
  b.draggable = !isCoarse(); // touch devices: native drag fights the long-press sheet
  b.dataset.drag = 'folder:' + f.id;
  b.dataset.fid = f.id;
  b.style.setProperty('--fcolor', f.color || '#5865f2');
  b.innerHTML = folderGridHtml(f);
  b.onclick = (e) => { e.stopPropagation(); toggleFolder(f.id); };
  b.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); openFolderMenu(f.id, e.clientX, e.clientY); };
  wireDrag(b, 'folder', f.id);
  w.appendChild(b);
  return w;
}
function renderServerList() {
  const box = $('#server-list');
  box.innerHTML = '';
  const byId = new Map(S.servers.map((s) => [s.id, s]));
  const inFolder = new Set([...S.layoutFolders].flatMap((f) => f.servers || []));
  for (const it of S.rootOrder) {
    if (it.kind === 'folder') {
      const f = folderById(it.id);
      if (f) {
        box.appendChild(folderBtn(f));
        if (S.openFolderId === f.id) box.appendChild(folderOpenBox(f));
      }
    } else {
      const s = byId.get(it.id);
      if (s) box.appendChild(serverBtn(s));
    }
  }
  for (const s of S.servers) {
    if (!S.rootOrder.some((it) => it.kind === 'server' && it.id === s.id) && !inFolder.has(s.id)) box.appendChild(serverBtn(s));
  }
}
function toggleFolder(id) {
  S.openFolderId = (S.openFolderId === id) ? null : id;
  renderServerList();
}
function closeFolderPopout() { if (S.openFolderId) { S.openFolderId = null; renderServerList(); } }
function folderOpenBox(f) {
  const color = f.color || '#5865f2';
  const box = document.createElement('div');
  box.className = 'folder-open';
  box.dataset.fid = f.id;
  box.style.setProperty('--fcolor', color);
  for (const id of (f.servers || [])) {
    const s = S.servers.find((x) => x.id === id);
    if (!s) continue;
    // Selecting a server inside a folder must NOT collapse the folder —
    // it only collapses when the folder header (top part) is clicked.
    box.appendChild(serverBtn(s));
  }
  wireFolderOpenDrop(box, f.id);
  return box;
}


async function selectServer(id) {
  openServerView();
  S.serverId = id;
  S.channelId = null;
  rememberView();
  renderServerList();
  document.body.classList.remove('nav-open');
  try {
    const { server } = await api('/api/servers/' + id);
    S.serverDetail = server;
    $('#server-name').textContent = server.name;
    renderServerHeader();
    try {
      const { emoji } = await api(`/api/servers/${id}/emoji`);
      S.emoji = {};
      for (const e of emoji) S.emoji[e.name] = e.url;
    } catch { S.emoji = {}; }
    S.replyTo = null; S.pendingAtts = []; S.editing = null;
    renderComposerMeta(); closeThread(true);
    // pick first text channel
    const texts = server.channels.filter((c) => c.type === 'text');
    const voices = server.channels.filter((c) => c.type === 'voice');
    if (texts.length && !texts.find((c) => c.id === S.channelId)) S.channelId = texts[0].id;
    renderChannels();
    renderMembers();
    if (S.srvSetId) { if (server.id === S.srvSetId) renderServerTab(); else closeServerSettings(); }
    if (S.channelId) selectChannel(S.channelId);
    else { $('#chan-name').textContent = '—'; $('#messages').innerHTML = ''; }
  } catch (err) {
    toast('Could not load server');
    await refreshServers();
  }
}
function fmtVoiceTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0');
}
setInterval(() => {
  const now = Date.now();
  document.querySelectorAll('[data-vtimer]').forEach((el) => {
    const t0 = S.voiceSince.get(el.dataset.vtimer);
    if (!t0) { el.remove(); return; }
    el.textContent = fmtVoiceTime(now - t0);
  });
}, 1000);
function renderChannels() {
  const d = S.serverDetail;
  if (!d) return;
  const tc = $('#text-channels'), vc = $('#voice-channels');
  tc.innerHTML = ''; vc.innerHTML = '';
  for (const c of d.channels.filter((x) => x.type === 'text')) {
    const b = document.createElement('button');
    b.className = 'chan' + (c.id === S.channelId ? ' active' : '') + (chanMuted(c.id) ? ' muted' : '');
    b.innerHTML = `<span class="muted">#</span><span>${esc(c.name)}</span>`;
    b.onclick = () => selectChannel(c.id);
    b.dataset.cid = c.id; b.dataset.ctype = 'text';
    b.ondblclick = () => confirmDeleteChannel(c);
    wireChanDrag(b, c);
    tc.appendChild(b);
  }
  for (const c of d.channels.filter((x) => x.type === 'voice')) {
    const occ = S.voiceOccupancy.get(c.id) || [];
    const wrap = document.createElement('div');
    const b = document.createElement('button');
    b.className = 'chan' + (S.voice && S.voice.channelId === c.id ? ' active' : '');
    b.innerHTML = `<span class="vicon"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M14.5 9.5a4 4 0 0 1 0 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M17 7a8 8 0 0 1 0 10" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M19.5 4.5a12 12 0 0 1 0 15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg></span><span>${esc(c.name)}</span>${occ.length ? `<span class="count">${occ.length}</span>` : ''}${occ.length && S.voiceSince.get(c.id) ? `<span class="vtime" data-vtimer="${c.id}">${fmtVoiceTime(Date.now() - S.voiceSince.get(c.id))}</span>` : ''}`;
    b.title = occ.length ? occ.map((p) => p.display_name).join(', ') : 'Join voice';
    b.onclick = () => openVoiceChannel(S.serverId, c.id);
    b.dataset.cid = c.id; b.dataset.ctype = 'voice';
    wireChanDrag(b, c);
    const users = document.createElement('div');
    users.className = 'vusers';
    users.id = 'vusers-' + c.id;
    wrap.append(b, users);
    vc.appendChild(wrap);
  }
  renderVoiceUsers();
}
// Admin channel reordering: drag a channel above/below another of the same
// type (text and voice order independently). Reuses the rail drop marker.
let chanDrag = null;
function wireChanDrag(b, c) {
  if (!canManage()) return;
  b.draggable = !isCoarse(); // touch devices: let long-press open the channel sheet, not drag
  b.addEventListener('dragstart', (e) => {
    chanDrag = { id: c.id, type: c.type, target: null, edge: null };
    try { e.dataTransfer.setData('text/plain', 'channel:' + c.id); } catch {}
    e.dataTransfer.effectAllowed = 'move';
  });
  b.addEventListener('dragover', (e) => {
    if (!chanDrag || chanDrag.id === c.id || chanDrag.type !== c.type) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const r = b.getBoundingClientRect();
    const edge = (e.clientY - r.top) / r.height < 0.5 ? 'before' : 'after';
    showMarker(r, edge);
    chanDrag.target = c.id; chanDrag.edge = edge;
  });
  b.addEventListener('dragleave', () => { hideMarker(); });
  b.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    const dd = chanDrag; chanDrag = null; hideMarker();
    if (dd && dd.target) moveChannel(dd.id, dd.target, dd.edge);
  });
  b.addEventListener('dragend', () => { chanDrag = null; hideMarker(); });
}
async function moveChannel(dragId, targetId, edge) {
  const d = S.serverDetail;
  const drag = d?.channels.find((v) => v.id === dragId);
  const tgt = d?.channels.find((v) => v.id === targetId);
  if (!d || !drag || !tgt || drag.type !== tgt.type || dragId === targetId) return;
  const arr = d.channels.filter((x) => x.id !== dragId);
  arr.splice(arr.findIndex((x) => x.id === targetId) + (edge === 'after' ? 1 : 0), 0, drag);
  d.channels = arr;
  renderChannels();
  try {
    await api(`/api/servers/${d.id}/channels/order`, { method: 'PUT',
      body: JSON.stringify({ order: arr.filter((x) => x.type === drag.type).map((x) => x.id) }) });
  } catch (err) {
    toast('Reorder failed: ' + prettyError(err.message));
    selectServer(d.id);
  }
}
function confirmDeleteChannel(c) {
  if (!canManage()) return;
  openModal(`Delete #${c.name}?`, `<p class="muted">Messages in this channel are deleted forever.</p>`, 'Delete', async () => {
    await api(`/api/servers/${S.serverId}/channels/${c.id}`, { method: 'DELETE' });
    S.serverDetail.channels = S.serverDetail.channels.filter((x) => x.id !== c.id);
    if (S.channelId === c.id) S.channelId = (S.serverDetail.channels.find((x) => x.type === 'text') || {}).id || null;
    renderChannels();
    if (S.channelId) selectChannel(S.channelId);
  }, { danger: true });
}
async function selectChannel(id) {
  S.channelId = id;
  rememberView();
  S.callOpen = false;
  document.body.classList.remove('nav-open');
  $('#chat').classList.remove('call-open');
  renderChannels();
  renderStage();
  const ch = S.serverDetail.channels.find((c) => c.id === id);
  $('#chan-name').textContent = ch ? ch.name : '—';
  $('#composer').classList.remove('hidden');
  $('#in-message').placeholder = ch ? `Message #${ch.name}` : 'Message…';
  $('#messages').classList.remove('hidden');
  renderTopic();
  $('#messages').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { messages } = await api(`/api/servers/${S.serverId}/channels/${id}/messages?limit=80`);
    S.messages.set(id, messages);
    S.editing = null;
    S.histMode = null;
    S.histNew = 0;
    renderMessages(true);
    refreshPinsCount();
    updatePill();
  } catch { $('#messages').innerHTML = '<p class="error">Could not load messages.</p>'; }
}
function statusOf(id) {
  if (S.me && id === S.me.id) return S.me.status || 'online';
  return S.online[id] || S.presenceAll[id] || 'offline';
}
// Invisible is offline for display purposes: greyed out, sunk to the OFFLINE
// section. (Only your own client ever sees 'invisible' — the server hides it
// from everyone else, who just see you as offline.)
function isOff(st) { return st === 'offline' || st === 'invisible'; }
function dotOf(st) { return st === 'invisible' ? 'offline' : st; }
function paintMe() {
  if (!S.me) return;
  paintAvatar($('#me-avatar'), S.me);
  $('#me-name').textContent = S.me.display_name;
}
function mentionsMe(msg) {
  if (!msg || !msg.content || !S.me) return false;
  return new RegExp('(^|[\\s(])@' + S.me.username + '\\b').test(msg.content);
}
function memberRowEl(m) {
  const st = statusOf(m.id);
  const off = isOff(st);
  const dot = dotOf(st);
  const div = document.createElement('div');
  div.className = 'member' + (off ? ' off' : '');
  div.dataset.uid = m.id;
  if (m.sidebar_banner_url && !off) {
    div.style.backgroundImage = `linear-gradient(rgba(0,0,0,.45),rgba(0,0,0,.45)),linear-gradient(90deg, var(--panel) 5%, rgba(0,0,0,0) 78%), url("${m.sidebar_banner_url}")`;
    div.style.backgroundSize = 'cover';
    div.style.backgroundPosition = 'right center';
  }
  div.innerHTML = `<span class="avwrap st-${dot}"><span class="avatar"></span><span class="status-dot ${dot}"></span></span><span class="mnames"><span style="${nameStyleFor(m)}">${esc(m.display_name)}${m.role === 'owner' ? ' ★' : ''}</span>${m.status_text && !off ? `<span class="mstatus" title="${esc(m.status_text)}">${esc(m.status_text)}</span>` : ''}${m.playing_game && !off ? `<span class="mstatus ugame" title="Playing ${esc(m.playing_game)}">Playing ${esc(m.playing_game)}</span>` : ''}</span>`;
  paintAvatar(div.querySelector('.avatar'), m);
  return div;
}
function memberSort(a, b) {
  const ao = isOff(statusOf(a.id)) ? 1 : 0, bo = isOff(statusOf(b.id)) ? 1 : 0;
  return ao - bo || a.display_name.localeCompare(b.display_name);
}
function renderMembers() {
  // Server roster only — never paint it over the DM member list in home view.
  if (S.view !== 'server') return;
  const d = S.serverDetail;
  if (!d) return;
  $('#members-head').classList.add('hidden');
  const box = $('#member-list');
  box.innerHTML = '';
  const hoisted = (d.roles || []).filter((r) => r.hoist);
  const shown = new Set();
  for (const r of hoisted) {
    const mems = d.members.filter((m) => (m.roleIds || []).includes(r.id)).sort(memberSort);
    if (!mems.length) continue;
    const head = document.createElement('div');
    head.className = 'role-head';
    head.innerHTML = `<span${r.color ? ` style="color:${esc(r.color)}"` : ''}>${esc(r.name.toUpperCase())}</span><span class="muted"> — ${mems.length}</span>`;
    box.appendChild(head);
    for (const m of mems) { box.appendChild(memberRowEl(m)); shown.add(m.id); }
  }
  const rest = d.members.filter((m) => !shown.has(m.id));
  const on = rest.filter((m) => !isOff(statusOf(m.id))).sort(memberSort);
  const off = rest.filter((m) => isOff(statusOf(m.id))).sort(memberSort);
  if (on.length) {
    const head = document.createElement('div');
    head.className = 'role-head';
    head.innerHTML = `<span>ONLINE</span><span class="muted"> — ${on.length}</span>`;
    box.appendChild(head);
    for (const m of on) box.appendChild(memberRowEl(m));
  }
  if (off.length) {
    const head = document.createElement('div');
    head.className = 'role-head';
    head.innerHTML = `<span>OFFLINE</span><span class="muted"> — ${off.length}</span>`;
    box.appendChild(head);
    for (const m of off) box.appendChild(memberRowEl(m));
  }
}
function renderDmMembers() {
  if (S.view !== 'home') return;
  const t = S.dms.find((x) => x.id === S.dmThreadId);
  if (!t) return;
  $('#members-head').classList.remove('hidden');
  $('#members-title').textContent = 'MEMBERS';
  const box = $('#member-list');
  box.innerHTML = '';
  const members = t.members || [];
  const on = members.filter((m) => !isOff(statusOf(m.id))).sort((a, b) => a.display_name.localeCompare(b.display_name));
  const off = members.filter((m) => isOff(statusOf(m.id))).sort((a, b) => a.display_name.localeCompare(b.display_name));
  $('#online-count').textContent = on.length;
  if (on.length) {
    const head = document.createElement('div');
    head.className = 'role-head';
    head.innerHTML = `<span>ONLINE</span><span class="muted"> — ${on.length}</span>`;
    box.appendChild(head);
    for (const m of on) box.appendChild(memberRowEl(m));
  }
  if (off.length) {
    const head = document.createElement('div');
    head.className = 'role-head';
    head.innerHTML = `<span>OFFLINE</span><span class="muted"> — ${off.length}</span>`;
    box.appendChild(head);
    for (const m of off) box.appendChild(memberRowEl(m));
  }
  renderDmLists();
}

// ---------- roles + name styling ----------
function isOwner() { return !!(S.serverDetail && S.me && S.serverDetail.owner_id === S.me.id); }
function myRoleIds() {
  if (!S.serverDetail || !S.me) return [];
  const me = S.serverDetail.members.find((m) => m.id === S.me.id);
  return (me && me.roleIds) || [];
}
function canManage() {
  const d = S.serverDetail;
  if (!d || !S.me) return false;
  if (d.owner_id === S.me.id) return true;
  const mine = new Set(myRoleIds());
  return (d.roles || []).some((r) => r.admin && mine.has(r.id));
}
function topRoleOf(m) {
  const roles = S.serverDetail?.roles || [];
  let best = null;
  for (const rid of (m?.roleIds || [])) {
    const r = roles.find((x) => x.id === rid);
    if (r && r.color && (!best || r.position > best.position)) best = r;
  }
  return best;
}
const HEXC = /^#[0-9a-fA-F]{6}$/;
function nameStyleFor(u) {
  if (!u) return '';
  const c1 = HEXC.test(u.name_color || '') ? u.name_color : '';
  const c2 = HEXC.test(u.name_gradient || '') ? u.name_gradient : '';
  if (c1 && c2) return `background:linear-gradient(90deg,${c1},${c2});-webkit-background-clip:text;background-clip:text;color:transparent;display:inline-block`;
  if (c1) return `color:${c1}`;
  if (S.view === 'server' && S.serverDetail) {
    const m = S.serverDetail.members.find((x) => x.id === u.id);
    const top = m && topRoleOf(m);
    if (top) return `color:${top.color}`;
  }
  return '';
}
// Live profile for a message author: chat embeds a snapshot at send time, so
// resolve display name / avatar / name color from fresh state first so color
// and gradient names show in chat, not just the member sidebar.
function liveUserFor(u) {
  if (!u) return u;
  if (S.me && u.id === S.me.id) return S.me;
  if (S.view === 'server' && S.serverDetail) {
    const m = S.serverDetail.members.find((x) => x.id === u.id);
    if (m) return m;
  } else if (S.view === 'home' && S.dmThreadId) {
    const t = S.dms.find((x) => x.id === S.dmThreadId);
    const m = t && (t.members || []).find((x) => x.id === u.id);
    if (m) return m;
  }
  return u;
}
