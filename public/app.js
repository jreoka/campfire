/* Campfire client — vanilla SPA + WebSocket + WebRTC mesh + PWA */
'use strict';
const $ = (s) => document.querySelector(s);
const apiBase = '';

const store = {
  get token() { return localStorage.getItem('cf_token') || ''; },
  set token(v) { v ? localStorage.setItem('cf_token', v) : localStorage.removeItem('cf_token'); },
};

const S = {
  me: null,
  servers: [],
  serverId: null,
  channelId: null,
  serverDetail: null, // {channels, members, ...}
  messages: new Map(), // channelId -> [msgs]
  online: {}, // userId -> status ('online'|'away'|'dnd'); absent = offline/invisible
  emoji: {}, // custom server emoji name -> url
  replyTo: null, // message being replied to
  pendingAtts: [], // uploaded attachments awaiting send
  thread: null, // {rootId, channelId, root, replies[]}
  editing: null, // message id being edited
  layoutFolders: [], // [{id,name,color,open,position,servers:[serverIds]}]
  serverMeta: new Map(), // serverId -> {folderId, position}
  rootOrder: [], // [{kind:'server'|'folder', id}] rail order top-to-bottom
  voiceOccupancy: new Map(), // channelId -> [peers]
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  voice: null, // {serverId, channelId, stream, pcs:Map, muted, analysers}
  ws: null,
  typingTimers: new Map(),
  lastTypingSent: 0,
};

// ---------- tiny helpers ----------
function toast(msg, ms = 2500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function linkify(s) {
  return esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}
function avatar(el, name, color) {
  el.style.background = color || '#5865f2';
  el.textContent = (name || '?').trim().charAt(0).toUpperCase() || '?';
}
function paintAvatar(el, user) {
  if (!el) return;
  el.classList.add('avatar');
  if (user && user.avatar_url) {
    el.style.background = 'transparent';
    el.innerHTML = '';
    const img = document.createElement('img');
    img.src = user.avatar_url; img.alt = ''; img.loading = 'lazy';
    img.onerror = () => { el.innerHTML = ''; avatar(el, user.display_name, user.avatar_color); };
    el.appendChild(img);
  } else {
    el.innerHTML = '';
    avatar(el, user ? user.display_name : '?', user ? user.avatar_color : '#555');
  }
}
function fmtSize(b) {
  b = +b || 0;
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}
function memberByUsername(un) {
  un = String(un || '').toLowerCase();
  if (S.me && S.me.username === un) return S.me;
  return (S.serverDetail?.members || []).find((m) => m.username === un) || null;
}
function memberById(id) {
  if (S.me && S.me.id === id) return S.me;
  return (S.serverDetail?.members || []).find((m) => m.id === id) || null;
}
// Escape + code/bold/italic/strike + custom emoji + @mentions + links.
function renderRich(text) {
  let h = esc(text);
  const codes = [];
  h = h.replace(/`([^`\n]+)`/g, (m, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
       .replace(/(^|[\s(])\*([^\*\n]+)\*/g, '$1<em>$2</em>')
       .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  h = h.replace(/:([a-z0-9_+-]{2,32}):/g, (m, n) => S.emoji[n]
    ? '<img class="cemoi" src="' + S.emoji[n] + '" alt="' + m + '" title="' + m + '" data-fb-emoji="' + m + '">' : m);
  h = h.replace(/(^|[\s(])@([a-z0-9_.]{2,24})/g, (m, pre, un) => {
    const mem = memberByUsername(un);
    if (!mem) return m;
    return pre + '<span class="mention' + (mem.id === S.me.id ? ' me' : '') + '" data-uid="' + mem.id + '">@' + esc(mem.display_name) + '</span>';
  });
  h = h.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  h = h.replace(/\u0000(\d+)\u0000/g, (m, i) => '<code>' + codes[+i] + '</code>');
  return h;
}
function isBigEmoji(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 24) return false;
  try { return /^[\p{Extended_Pictographic}\s]+$/u.test(t) && [...t].filter((c) => c.trim()).length <= 6; }
  catch { return false; }
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDay(ts) {
  return new Date(ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
async function api(path, opts = {}) {
  const res = await fetch(apiBase + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(store.token ? { Authorization: 'Bearer ' + store.token } : {}), ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('http_' + res.status));
  return data;
}

// ---------- auth ----------
let mode = 'login';
function setMode(m) {
  mode = m;
  $('#tab-login').classList.toggle('active', m === 'login');
  $('#tab-register').classList.toggle('active', m === 'register');
  $('#wrap-display').classList.toggle('hidden', m === 'login');
  $('#btn-auth').textContent = m === 'login' ? 'Log in' : 'Create account';
  $('#auth-error').classList.add('hidden');
}
$('#tab-login').onclick = () => setMode('login');
$('#tab-register').onclick = () => setMode('register');
$('#form-auth').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#in-username').value.trim();
  const password = $('#in-password').value;
  const displayName = $('#in-display').value.trim();
  $('#auth-error').classList.add('hidden');
  try {
    const data = mode === 'login'
      ? await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) })
      : await api('/api/register', { method: 'POST', body: JSON.stringify({ username, password, displayName }) });
    store.token = data.token;
    await boot();
  } catch (err) {
    const el = $('#auth-error');
    el.textContent = '⚠️ ' + prettyError(err.message);
    el.classList.remove('hidden');
  }
});
function prettyError(e) {
  const map = {
    invalid_login: 'Wrong username or password.', username_taken: 'That username is taken.',
    bad_username: 'Username needs 2–24 chars (a-z, 0-9, _ .).', bad_invite: 'Invite code not found.',
    slow_down: 'Slow down — you\'re sending too fast.', owner_only: 'Only the server owner can do that.',
  };
  return map[e] || e.replace(/_/g, ' ');
}
async function doLogout() {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  try { leaveVoice(true); } catch {}
  try { S.ws?.close(); } catch {}
  store.token = '';
  location.reload();
}

// ---------- boot ----------
async function boot() {
  try {
    const cfg = await api('/api/config').catch(() => null);
    if (cfg?.iceServers?.length) S.iceServers = cfg.iceServers;
    const { user } = await api('/api/me');
    S.me = user;
  } catch {
    showAuth();
    return;
  }
  showMain();
  let draft = null;
  try { draft = JSON.parse(sessionStorage.getItem('cf_draft') || 'null'); sessionStorage.removeItem('cf_draft'); } catch {}
  if (draft && draft.s) S.serverId = draft.s;
  await refreshServers();
  if (draft && draft.c && S.serverId === draft.s) { try { await selectChannel(draft.c); } catch {} }
  if (draft && draft.t) $('#in-message').value = draft.t;
  connectWS();
  pollVersion();
  // auto-join via ?invite=CODE
  const inv = new URLSearchParams(location.search).get('invite');
  if (inv) {
    history.replaceState(null, '', location.pathname);
    try {
      const { server } = await api('/api/servers/join', { method: 'POST', body: JSON.stringify({ inviteCode: inv }) });
      await refreshServers(server.id);
      toast('Joined "' + server.name + '"');
    } catch (err) { toast('Invite failed: ' + prettyError(err.message)); }
  }
}
function showAuth() {
  $('#view-auth').classList.remove('hidden');
  $('#view-main').classList.add('hidden');
}
function showMain() {
  $('#view-auth').classList.add('hidden');
  $('#view-main').classList.remove('hidden');
  paintMe();
}

// ---------- servers / channels ----------
async function refreshServers(selectId) {
  const { servers } = await api('/api/servers');
  S.servers = servers;
  try {
    const { folders, order } = await api('/api/me/layout');
    S.layoutFolders = folders.map((f) => ({ ...f, open: f.open !== 0, servers: [] }));
    S.serverMeta = new Map(order.map((o) => [o.server_id, { folderId: o.folder_id, position: o.position }]));
  } catch { S.layoutFolders = []; S.serverMeta = new Map(); }
  buildRootOrder();
  if (!servers.length) {
    S.serverId = null;
    renderServerList();
    openAddServer();
    return;
  }
  if (selectId) S.serverId = selectId;
  if (!S.serverId || !servers.find((s) => s.id === S.serverId)) S.serverId = servers[0].id;
  renderServerList();
  await selectServer(S.serverId);
}
function folderById(id) { return S.layoutFolders.find((f) => f.id === id); }
function buildRootOrder() {
  for (const f of S.layoutFolders) f.servers = [];
  const unfiled = [];
  for (const s of S.servers) {
    const m = S.serverMeta.get(s.id);
    const f = m && m.folderId ? folderById(m.folderId) : null;
    if (f) f.servers.push(s.id);
    else unfiled.push(s.id);
  }
  for (const f of S.layoutFolders) {
    f.servers.sort((a, b) => (S.serverMeta.get(a)?.position ?? 0) - (S.serverMeta.get(b)?.position ?? 0));
  }
  S.rootOrder = [
    ...S.layoutFolders.map((f) => ({ kind: 'folder', id: f.id, pos: f.position })),
    ...unfiled.map((id) => ({ kind: 'server', id, pos: S.serverMeta.get(id)?.position ?? 999 })),
  ].sort((a, b) => a.pos - b.pos);
}
function serverBtn(s) {
  const b = document.createElement('button');
  const label = s.name.trim().charAt(0).toUpperCase() || '?';
  b.className = 'server-btn' + (s.id === S.serverId ? ' active' : '') + (s.icon_url ? ' has-icon' : '');
  b.title = s.name;
  b.draggable = true;
  b.dataset.drag = 'server:' + s.id;
  if (s.icon_url) {
    // background-image (not <img>): immune to flex-item sizing quirks, always fills
    b.style.backgroundImage = `url("${s.icon_url}")`;
    const probe = new Image();
    probe.onerror = () => {
      if (!document.contains(b)) return;
      b.classList.remove('has-icon');
      b.style.backgroundImage = '';
      b.textContent = label;
    };
    probe.src = s.icon_url;
  } else {
    b.textContent = label;
  }
  b.onclick = () => selectServer(s.id);
  wireDrag(b, 'server', s.id);
  return b;
}
function folderEl(f, kids) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:2px';
  const b = document.createElement('button');
  b.className = 'server-btn folder-btn' + (f.open ? ' open' : '');
  b.style.background = f.color;
  b.title = f.name;
  b.draggable = true;
  b.dataset.drag = 'folder:' + f.id;
  b.innerHTML = `<span>${kids.length}</span>`;
  if (kids.some((k) => k.id === S.serverId)) b.style.outline = '2px solid #ffffff88';
  b.onclick = () => { f.open = !f.open; saveLayout(); renderServerList(); };
  b.ondblclick = () => renameFolder(f.id);
  b.oncontextmenu = (e) => { e.preventDefault(); openFolderMenu(f.id, e.clientX, e.clientY); };
  wireDrag(b, 'folder', f.id);
  wrap.appendChild(b);
  if (f.open) {
    const kidsBox = document.createElement('div');
    kidsBox.className = 'folder-children';
    for (const s of kids) kidsBox.appendChild(serverBtn(s));
    wrap.appendChild(kidsBox);
  }
  return wrap;
}
function renderServerList() {
  const box = $('#server-list');
  box.innerHTML = '';
  const byId = new Map(S.servers.map((s) => [s.id, s]));
  for (const it of S.rootOrder) {
    if (it.kind === 'folder') {
      const f = folderById(it.id);
      if (!f) continue;
      box.appendChild(folderEl(f, (f.servers || []).map((id) => byId.get(id)).filter(Boolean)));
    } else {
      const s = byId.get(it.id);
      if (s) box.appendChild(serverBtn(s));
    }
  }
  for (const s of S.servers) {
    if (!S.rootOrder.some((it) => it.kind === 'server' && it.id === s.id)) box.appendChild(serverBtn(s));
  }
}
async function selectServer(id) {
  S.serverId = id;
  S.channelId = null;
  renderServerList();
  document.body.classList.remove('nav-open');
  try {
    const { server } = await api('/api/servers/' + id);
    S.serverDetail = server;
    $('#server-name').textContent = server.name;
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
    if (S.channelId) selectChannel(S.channelId);
    else { $('#chan-name').textContent = '—'; $('#messages').innerHTML = ''; }
  } catch (err) {
    toast('Could not load server');
    await refreshServers();
  }
}
function renderChannels() {
  const d = S.serverDetail;
  if (!d) return;
  const tc = $('#text-channels'), vc = $('#voice-channels');
  tc.innerHTML = ''; vc.innerHTML = '';
  for (const c of d.channels.filter((x) => x.type === 'text')) {
    const b = document.createElement('button');
    b.className = 'chan' + (c.id === S.channelId ? ' active' : '');
    b.innerHTML = `<span class="muted">#</span><span>${esc(c.name)}</span>`;
    b.onclick = () => selectChannel(c.id);
    b.ondblclick = () => confirmDeleteChannel(c);
    tc.appendChild(b);
  }
  for (const c of d.channels.filter((x) => x.type === 'voice')) {
    const occ = S.voiceOccupancy.get(c.id) || [];
    const wrap = document.createElement('div');
    const b = document.createElement('button');
    b.className = 'chan' + (S.voice && S.voice.channelId === c.id ? ' active' : '');
    b.innerHTML = `<span class="vicon"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16 8a5 5 0 0 1 0 8" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg></span><span>${esc(c.name)}</span>${occ.length ? `<span class="count">${occ.length}</span>` : ''}`;
    b.title = occ.length ? occ.map((p) => p.display_name).join(', ') : 'Join voice';
    b.onclick = () => joinVoice(S.serverId, c.id);
    const users = document.createElement('div');
    users.className = 'vusers';
    users.id = 'vusers-' + c.id;
    wrap.append(b, users);
    vc.appendChild(wrap);
  }
  renderVoiceUsers();
}
function confirmDeleteChannel(c) {
  if (S.serverDetail.owner_id !== S.me.id) return;
  openModal(`Delete #${c.name}?`, `<p class="muted">Messages in this channel are deleted forever.</p>`, 'Delete', async () => {
    await api(`/api/servers/${S.serverId}/channels/${c.id}`, { method: 'DELETE' });
    S.serverDetail.channels = S.serverDetail.channels.filter((x) => x.id !== c.id);
    if (S.channelId === c.id) S.channelId = (S.serverDetail.channels.find((x) => x.type === 'text') || {}).id || null;
    renderChannels();
    if (S.channelId) selectChannel(S.channelId);
  });
}
async function selectChannel(id) {
  S.channelId = id;
  renderChannels();
  const ch = S.serverDetail.channels.find((c) => c.id === id);
  $('#chan-name').textContent = ch ? ch.name : '—';
  $('#in-message').placeholder = ch ? `Message #${ch.name}` : 'Message…';
  $('#messages').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { messages } = await api(`/api/servers/${S.serverId}/channels/${id}/messages?limit=80`);
    S.messages.set(id, messages);
    S.editing = null;
    renderMessages(true);
  } catch { $('#messages').innerHTML = '<p class="error">Could not load messages.</p>'; }
}
function statusOf(id) {
  if (S.me && id === S.me.id) return S.me.status || 'online';
  return S.online[id] || 'offline';
}
function paintMe() {
  if (!S.me) return;
  paintAvatar($('#me-avatar'), S.me);
  $('#me-name').textContent = S.me.display_name;
}
function mentionsMe(msg) {
  if (!msg || !msg.content || !S.me) return false;
  return new RegExp('(^|[\\s(])@' + S.me.username + '\\b').test(msg.content);
}
function renderMembers() {
  const d = S.serverDetail;
  if (!d) return;
  const box = $('#member-list');
  box.innerHTML = '';
  const sorted = [...d.members].sort((a, b) => {
    const ao = statusOf(a.id) === 'offline' ? 1 : 0, bo = statusOf(b.id) === 'offline' ? 1 : 0;
    return ao - bo || a.display_name.localeCompare(b.display_name);
  });
  $('#online-count').textContent = d.members.filter((m) => statusOf(m.id) !== 'offline').length;
  for (const m of sorted) {
    const st = statusOf(m.id);
    const div = document.createElement('div');
    div.className = 'member' + (st === 'offline' ? ' off' : '');
    div.dataset.uid = m.id;
    div.innerHTML = `<span class="avatar"></span><span class="mnames"><span>${esc(m.display_name)}${m.role === 'owner' ? ' ★' : ''}</span>${m.status_text && st !== 'offline' ? `<span class="mstatus">${esc(m.status_text)}</span>` : ''}</span><span class="status-dot ${st}"></span>`;
    paintAvatar(div.querySelector('.avatar'), m);
    box.appendChild(div);
  }
}

// ---------- messages ----------
function canMod(m) {
  return m.user && (m.user.id === S.me.id || (S.serverDetail && S.serverDetail.owner_id === S.me.id));
}
function msgById(id) {
  for (const [, arr] of S.messages) { const f = arr.find((x) => x.id === id); if (f) return f; }
  if (S.thread) {
    if (S.thread.root?.id === id) return S.thread.root;
    const f = S.thread.replies.find((x) => x.id === id); if (f) return f;
  }
  return null;
}
function updateMsgInCaches(mid, fn) {
  for (const [, arr] of S.messages) { const i = arr.findIndex((x) => x.id === mid); if (i >= 0) fn(arr[i]); }
  if (S.thread) {
    if (S.thread.root?.id === mid) fn(S.thread.root);
    const r = S.thread.replies.find((x) => x.id === mid); if (r) fn(r);
  }
}
function attachmentHTML(a) {
  if (a.kind === 'image') return `<img class="att-img" src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy" data-fb-name="${esc(a.name)}" data-fb-url="${esc(a.url)}" />`;
  if (a.kind === 'video') return `<video class="att-vid" src="${esc(a.url)}" controls preload="metadata"></video>`;
  if (a.kind === 'audio') return `<audio src="${esc(a.url)}" controls preload="metadata"></audio>`;
  return `<a class="file-card" href="${esc(a.url)}" target="_blank" rel="noopener"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg><span><span class="fname">${esc(a.name)}</span><br/><span class="fsize">${fmtSize(a.size)}</span></span></a>`;
}
function reactionsHTML(m) {
  if (!m.reactions?.length) return '';
  return '<div class="reactions">' + m.reactions.map((r) => {
    const label = r.emoji.startsWith(':') && r.emoji.endsWith(':') && S.emoji[r.emoji.slice(1, -1)]
      ? `<img class="cemoi" src="${S.emoji[r.emoji.slice(1, -1)]}" alt="${esc(r.emoji)}" data-fb-emoji="${esc(r.emoji)}">`
      : esc(r.emoji);
    return `<button class="reaction${r.me ? ' me' : ''}" data-act="react" data-emoji="${esc(r.emoji)}" title="${r.count}">${label} ${r.count}</button>`;
  }).join('') + '</div>';
}
function messageEl(m, opts = {}) {
  const div = document.createElement('div');
  div.className = 'msg';
  div.dataset.mid = m.id;
  const own = m.user && m.user.id === S.me.id;
  let inner = '<span class="avatar" data-uid="' + (m.user ? m.user.id : '') + '"></span><div class="body">';
  inner += `<div class="head"><span class="who" data-uid="${m.user ? m.user.id : ''}">${esc(m.user ? m.user.display_name : 'deleted')}</span><span class="when">${fmtTime(m.created_at)}</span>${m.edited ? '<span class="edited">(edited)</span>' : ''}</div>`;
  if (m.replyTo) {
    inner += `<div class="reply-quote" data-jump="${m.replyTo.id}"><span class="rq-author">${esc(m.replyTo.author)}</span><span class="rq-text">${esc(m.replyTo.snippet)}</span></div>`;
  }
  if (S.editing === m.id) {
    inner += `<div class="edit-box"><textarea id="edit-area" maxlength="2000">${esc(m.content)}</textarea><div class="row"><button class="btn small primary" data-act="edit-save">Save</button><button class="btn small" data-act="edit-cancel">Cancel</button></div></div>`;
  } else if (m.content) {
    const big = isBigEmoji(m.content) && !m.attachments?.length;
    inner += `<div class="text${big ? ' bigemoji' : ''}">${renderRich(m.content)}</div>`;
  }
  if (m.attachments?.length) {
    inner += '<div class="msg-atts">' + m.attachments.map(attachmentHTML).join('') + '</div>';
  }
  inner += reactionsHTML(m);
  if (!opts.inThread && m.threadCount > 0) {
    inner += `<button class="thread-link" data-act="thread">${m.threadCount} ${m.threadCount === 1 ? 'reply' : 'replies'} →</button>`;
  }
  inner += '</div>';
  // hover actions
  const acts = [['react', 'React'], ['reply', 'Reply'], ['thread', 'Thread']];
  if (own) acts.push(['edit', 'Edit']);
  if (canMod(m)) acts.push(['del', 'Delete']);
  inner += '<div class="msg-actions">' + acts.map(([a, l]) => `<button data-act="${a}">${l}</button>`).join('') + '</div>';
  div.innerHTML = inner;
  paintAvatar(div.querySelector('.avatar'), m.user);
  return div;
}
function renderMessages(force = false) {
  const box = $('#messages');
  const msgs = S.messages.get(S.channelId) || [];
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
  box.innerHTML = '';
  let lastDay = '';
  for (const m of msgs) {
    const day = fmtDay(m.created_at);
    if (day !== lastDay) { lastDay = day; const d = document.createElement('div'); d.className = 'day'; d.textContent = day; box.appendChild(d); }
    box.appendChild(messageEl(m));
  }
  if (!msgs.length) box.innerHTML += '<p class="muted" style="text-align:center">No messages yet — say hello.</p>';
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
}
function renderComposerMeta() {
  const box = $('#attach-preview');
  box.innerHTML = '';
  const hasReply = !!S.replyTo, hasAtts = S.pendingAtts.length > 0;
  box.classList.toggle('hidden', !hasReply && !hasAtts);
  if (hasReply) {
    const chip = document.createElement('div');
    chip.className = 'att-chip';
    chip.innerHTML = `<span>Replying to <b>${esc(S.replyTo.user ? S.replyTo.user.display_name : '?')}</b>: ${esc(String(S.replyTo.content || '').slice(0, 60))}</span>`;
    const x = document.createElement('button'); x.className = 'mini'; x.textContent = '✕';
    x.onclick = () => { S.replyTo = null; renderComposerMeta(); };
    chip.appendChild(x); box.appendChild(chip);
  }
  S.pendingAtts.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'att-chip';
    const thumb = a.kind === 'image' ? `<img src="${esc(a.url)}" alt="" />` : '';
    chip.innerHTML = `${thumb}<span>${esc(a.name)} (${fmtSize(a.size)})</span>`;
    const x = document.createElement('button'); x.className = 'mini'; x.textContent = '✕';
    x.onclick = () => { S.pendingAtts.splice(i, 1); renderComposerMeta(); };
    chip.appendChild(x); box.appendChild(chip);
  });
}
async function uploadAndAttach(file) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) { toast('File too big (max 25MB)'); return; }
  if (S.pendingAtts.length >= 5) { toast('Max 5 attachments per message'); return; }
  const fd = new FormData();
  fd.append('file', file);
  toast('Uploading…');
  try {
    const res = await fetch('/api/upload', { method: 'POST', headers: store.token ? { Authorization: 'Bearer ' + store.token } : {}, body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'upload_failed');
    S.pendingAtts.push(data);
    renderComposerMeta();
  } catch (err) { toast('Upload failed: ' + prettyError(err.message)); }
}
$('#btn-attach').onclick = () => $('#in-attach').click();
$('#in-attach').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  uploadAndAttach(f);
});
// drag-drop + paste images/files onto the chat
['dragover', 'drop'].forEach((ev) => $('#chat').addEventListener(ev, (e) => {
  e.preventDefault();
  if (ev === 'drop' && e.dataTransfer?.files?.length) uploadAndAttach(e.dataTransfer.files[0]);
}));
document.addEventListener('paste', (e) => {
  if (document.activeElement !== $('#in-message') && document.activeElement !== $('#in-thread')) return;
  const f = [...(e.clipboardData?.files || [])][0];
  if (f) uploadAndAttach(f);
});
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const inp = $('#in-message');
  const content = inp.value.trim();
  if ((!content && !S.pendingAtts.length) || !S.serverId || !S.channelId) return;
  inp.value = '';
  hideMentionPop();
  sendChat(content, { attachments: S.pendingAtts, replyTo: S.replyTo?.id || null });
  S.pendingAtts = []; S.replyTo = null;
  renderComposerMeta();
});
function sendChat(content, opts = {}) {
  if (S.ws && S.ws.readyState === 1) {
    S.ws.send(JSON.stringify({
      t: 'message', serverId: S.serverId, channelId: S.channelId, content,
      attachments: opts.attachments || [], replyTo: opts.replyTo || null, threadRoot: opts.threadRoot || null,
    }));
    if (!opts.threadRoot) renderMessages(true);
  } else {
    toast('Reconnecting… try again in a second');
  }
}
$('#in-message').addEventListener('input', () => {
  const t = Date.now();
  if (t - S.lastTypingSent > 2500 && S.ws?.readyState === 1) {
    S.lastTypingSent = t;
    S.ws.send(JSON.stringify({ t: 'typing', serverId: S.serverId, channelId: S.channelId }));
  }
});
function showTyping(userId, name) {
  if (userId === S.me.id) return;
  $('#typing').textContent = `${name} is typing…`;
  clearTimeout(S.typingTimers.get(userId));
  S.typingTimers.set(userId, setTimeout(() => { $('#typing').textContent = ''; }, 2500));
}

// ---------- websocket ----------
function connectWS() {
  S.ws?.close();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(store.token)}`);
  S.ws = ws;
  ws.onopen = () => { ws.send(JSON.stringify({ t: 'subscribe' })); checkVersion(); };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    onWS(m);
  };
  ws.onclose = () => {
    // auto-reconnect
    setTimeout(() => { if (store.token) connectWS(); }, 2500);
  };
}
function onWS(m) {
  switch (m.t) {
    case 'hello': {
      S.me = m.user;
      // deploys drop + re-establish every WS: version mismatch here means an
      // update landed while the tab was open — prompt immediately, no waiting
      if (m.version && S.bootVersion && m.version !== S.bootVersion && !S.updateReady) onUpdateReady();
      else if (m.version && !S.bootVersion) S.bootVersion = m.version;
      break;
    }
    case 'message-new': {
      if (m.serverId !== S.serverId) break;
      const msg = m.message;
      const dnd = S.me && S.me.status === 'dnd';
      if (msg.threadRoot) {
        updateMsgInCaches(msg.threadRoot, (r) => { r.threadCount = (r.threadCount || 0) + 1; });
        if (m.channelId === S.channelId) renderMessages();
        if (S.thread && S.thread.rootId === msg.threadRoot) {
          S.thread.replies.push(msg);
          renderThread(true);
          if (document.hidden && !dnd) notifyMsg(msg);
        }
      } else {
        const arr = S.messages.get(m.channelId) || [];
        arr.push(msg);
        S.messages.set(m.channelId, arr);
        if (m.channelId === S.channelId) {
          renderMessages();
          if (document.hidden && !dnd) notifyMsg(msg);
          else if (!document.hidden && !dnd && mentionsMe(msg)) toast(`${msg.user.display_name} mentioned you`);
        } else if (!dnd) {
          toast(`#${chanName(m.channelId)}: ${msg.user.display_name}: ${(msg.content || '[attachment]').slice(0, 60)}`);
        }
      }
      break;
    }
    case 'message-updated': {
      updateMsgInCaches(m.message.id, (old) => Object.assign(old, m.message));
      if (m.channelId === S.channelId) renderMessages();
      if (S.thread && (S.thread.rootId === m.message.id || S.thread.replies.some((r) => r.id === m.message.id))) renderThread();
      break;
    }
    case 'reaction-update': {
      updateMsgInCaches(m.messageId, (old) => {
        old.reactions = (m.reactions || []).map((r) => ({ emoji: r.emoji, count: r.count, me: (r.users || []).includes(S.me.id) }));
      });
      if (m.channelId === S.channelId) renderMessages();
      if (S.thread && S.thread.replies.some((r) => r.id === m.messageId)) renderThread();
      break;
    }
    case 'message-deleted': {
      const arr = (S.messages.get(m.channelId) || []).filter((x) => x.id !== m.messageId);
      S.messages.set(m.channelId, arr);
      if (S.thread) {
        if (S.thread.rootId === m.messageId) closeThread();
        else S.thread.replies = S.thread.replies.filter((x) => x.id !== m.messageId);
        renderThread();
      }
      if (m.channelId === S.channelId) renderMessages();
      break;
    }
    case 'channel-new':
      if (m.channel.server_id === S.serverId) { S.serverDetail.channels.push(m.channel); renderChannels(); }
      break;
    case 'channel-deleted':
      if (m.serverId === S.serverId) {
        S.serverDetail.channels = S.serverDetail.channels.filter((c) => c.id !== m.channelId);
        renderChannels();
        if (S.channelId === m.channelId) selectChannel((S.serverDetail.channels.find((c) => c.type === 'text') || {}).id);
      }
      break;
    case 'presence':
      if (m.serverId === S.serverId) { S.online = m.online || {}; S.online[S.me.id] = S.me.status || 'online'; renderMembers(); }
      break;
    case 'user-online':
      if (m.serverId === S.serverId) { S.online[m.userId] = m.status || 'online'; renderMembers(); }
      break;
    case 'user-offline':
      if (m.serverId === S.serverId) { delete S.online[m.userId]; renderMembers(); }
      break;
    case 'user-status':
      if (m.serverId === S.serverId) {
        if (m.status === 'invisible') delete S.online[m.userId];
        else S.online[m.userId] = m.status;
        renderMembers();
      }
      break;
    case 'user-updated': {
      const u = m.user;
      if (u.id === S.me.id) { S.me = { ...S.me, ...u }; paintMe(); }
      const mem = (S.serverDetail?.members || []).find((x) => x.id === u.id);
      if (mem) Object.assign(mem, u);
      renderMembers();
      if (S.channelId) renderMessages();
      break;
    }
    case 'server-updated': {
      const si = S.servers.findIndex((s) => s.id === m.server.id);
      if (si >= 0) S.servers[si] = { ...S.servers[si], ...m.server };
      if (m.server.id === S.serverId) {
        const keepChan = S.channelId;
        S.serverDetail = m.server;
        $('#server-name').textContent = m.server.name;
        if (!m.server.channels.find((c) => c.id === keepChan)) S.channelId = (m.server.channels.find((c) => c.type === 'text') || {}).id || null;
        renderServerList(); renderChannels();
        if (S.channelId && S.channelId !== keepChan) selectChannel(S.channelId);
      } else renderServerList();
      break;
    }
    case 'emoji-updated':
      if (m.serverId === S.serverId) {
        S.emoji = {};
        for (const e of m.emoji || []) S.emoji[e.name] = e.url;
        if (S.channelId) renderMessages();
      }
      break;
    case 'typing':
      if (m.channelId === S.channelId) showTyping(m.userId, m.display_name);
      break;
    case 'member-left':
      if (m.serverId === S.serverId) selectServer(S.serverId);
      break;
    case 'server-deleted':
      toast('Server was deleted'); refreshServers(); break;
    case 'invite-updated':
      if (m.serverId === S.serverId) S.serverDetail.invite_code = m.invite_code;
      break;
    // ---- voice ----
    case 'voice-peers': {
      S.voiceOccupancy.set(m.channelId, m.peers);
      if (m.serverId === S.serverId) renderChannels();
      else renderVoiceUsers();
      if (S.voice && S.voice.serverId === m.serverId && S.voice.channelId === m.channelId) {
        onVoicePeers(m.peers);
      }
      break;
    }
    case 'voice-peer-joined': {
      if (S.voice && S.voice.serverId === m.serverId && S.voice.channelId === m.channelId) {
        ensurePeer(m.peer.id, false); // existing member: wait for offer
      } else {
        // update occupancy cache so channel counts refresh on next voice-peers
        toast(`${m.peer.display_name} joined voice`);
        S.ws.send(JSON.stringify({ t: 'subscribe' }));
      }
      renderVoiceUsers();
      break;
    }
    case 'voice-peer-left': {
      closePeer(m.userId);
      renderVoiceUsers();
      break;
    }
    case 'voice-state': {
      const occ = S.voiceOccupancy.get(m.channelId) || [];
      const p = occ.find((x) => x.id === m.userId);
      if (p) { p.muted = m.muted; p.speaking = !!m.speaking; }
      if (m.serverId === S.serverId) renderVoiceUsers();
      break;
    }
    case 'voice-signal':
      onVoiceSignal(m.from, m.data);
      break;
    case 'voice-kicked':
      if (S.voice && S.voice.channelId === m.channelId) { leaveVoice(); toast('Voice room was deleted'); }
      break;
    case 'error':
      toast(prettyError(m.error));
      break;
  }
}
function chanName(id) {
  return (S.serverDetail?.channels.find((c) => c.id === id) || {}).name || 'chat';
}
function notifyMsg(m) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(`${m.user.display_name} (#${chanName(m.channelId)})`, { body: m.content.slice(0, 120) }); } catch {}
}
if ('Notification' in window && Notification.permission === 'default') {
  document.addEventListener('click', function once() {
    Notification.requestPermission().catch(() => {});
    document.removeEventListener('click', once);
  });
}

// ---------- modals ----------
let modalOkFn = null;
function openModal(title, bodyHTML, okLabel, onOk) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHTML;
  $('#modal-ok').textContent = okLabel || 'OK';
  modalOkFn = onOk || null;
  $('#modal-backdrop').classList.remove('hidden');
}
$('#modal-close').onclick = () => $('#modal-backdrop').classList.add('hidden');
$('#modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') $('#modal-backdrop').classList.add('hidden'); });
$('#modal-ok').onclick = async () => {
  $('#modal-backdrop').classList.add('hidden');
  if (modalOkFn) { try { await modalOkFn(); } catch (err) { toast('Failed: ' + prettyError(err.message)); } }
};
function openAddServer() {
  openModal('Servers', `
    <label>Create a new server<input id="m-server-name" maxlength="48" placeholder="e.g. The Crew" /></label>
    <div class="row" style="margin-top:.6rem"><button class="btn primary" id="m-create">Create</button></div>
    <hr style="border-color:var(--line);margin:1rem 0" />
    <label>…or join with an invite code<input id="m-invite" placeholder="e.g. aB3xK9qZ" /></label>
    <div class="row" style="margin-top:.6rem"><button class="btn" id="m-join">Join</button></div>
  `, 'Close', null);
  $('#m-create').onclick = async () => {
    const name = $('#m-server-name').value.trim();
    if (!name) return toast('Give your server a name');
    $('#modal-backdrop').classList.add('hidden');
    const { server } = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name }) });
    await refreshServers(server.id);
    S.ws?.send(JSON.stringify({ t: 'subscribe' }));
    showInvite(server);
  };
  $('#m-join').onclick = async () => {
    const code = $('#m-invite').value.trim();
    if (!code) return toast('Paste an invite code');
    $('#modal-backdrop').classList.add('hidden');
    try {
      const { server } = await api('/api/servers/join', { method: 'POST', body: JSON.stringify({ inviteCode: code }) });
      await refreshServers(server.id);
      S.ws?.send(JSON.stringify({ t: 'subscribe' }));
      toast(`Joined "${server.name}"`);
    } catch (err) { toast('Join failed: ' + prettyError(err.message)); }
  };
}
$('#btn-add-server').onclick = openAddServer;
$('#btn-invite').onclick = () => showInvite(S.serverDetail);
function showInvite(srv) {
  if (!srv) return;
  const url = `${location.origin}${location.pathname}?invite=${srv.invite_code}`;
  openModal(`Invite to ${srv.name}`, `
    <p class="muted">Share this code or link — anyone with it can join.</p>
    <div class="codebox">${esc(srv.invite_code)}</div>
    <div class="row"><button class="btn" id="m-copy-code">Copy code</button>
    <button class="btn" id="m-copy-link">Copy link</button></div>
  `, 'Done', null);
  $('#m-copy-code').onclick = () => { navigator.clipboard?.writeText(srv.invite_code); toast('Code copied'); };
  $('#m-copy-link').onclick = () => { navigator.clipboard?.writeText(url); toast('Link copied'); };
}
$('#btn-server-menu').onclick = () => {
  const d = S.serverDetail;
  if (!d) return;
  const owner = d.owner_id === S.me.id;
  openModal(d.name, `
    <label>New text channel<input id="m-chan" maxlength="32" placeholder="e.g. clips" /></label>
    <div class="row" style="margin:.6rem 0"><button class="btn" id="m-mkchan">Create channel</button></div>
    ${owner ? `<div class="row"><button class="btn" id="m-reset">Reset invite</button>
      <button class="btn danger" id="m-del">Delete server</button></div>`
      : `<button class="btn danger" id="m-leave">Leave server</button>`}
  `, 'Close', null);
  $('#m-mkchan').onclick = async () => {
    const name = $('#m-chan').value.trim().replace(/\s+/g, '-');
    if (!name) return;
    await api(`/api/servers/${d.id}/channels`, { method: 'POST', body: JSON.stringify({ name, type: 'text' }) });
    $('#modal-backdrop').classList.add('hidden');
    selectServer(d.id);
  };
  $('#m-reset') && ($('#m-reset').onclick = async () => {
    const { invite_code } = await api(`/api/servers/${d.id}/invite/reset`, { method: 'POST' });
    S.serverDetail.invite_code = invite_code;
    showInvite({ ...d, invite_code });
  });
  $('#m-leave') && ($('#m-leave').onclick = async () => {
    await api(`/api/servers/${d.id}/leave`, { method: 'POST' });
    $('#modal-backdrop').classList.add('hidden');
    S.ws?.send(JSON.stringify({ t: 'subscribe' }));
    refreshServers();
  });
  $('#m-del') && ($('#m-del').onclick = async () => {
    if (!confirm('Delete this server forever?')) return;
    await api(`/api/servers/${d.id}`, { method: 'DELETE' });
    $('#modal-backdrop').classList.add('hidden');
    refreshServers();
  });
};
$('#btn-add-voice').onclick = async () => {
  const name = prompt('Voice room name:', 'Hangout');
  if (!name) return;
  try {
    await api(`/api/servers/${S.serverId}/channels`, { method: 'POST', body: JSON.stringify({ name: name.trim().slice(0, 32), type: 'voice' }) });
    selectServer(S.serverId);
  } catch (err) { toast('Failed: ' + prettyError(err.message)); }
};

// ---------- mobile nav ----------
$('#btn-menu').onclick = () => document.body.classList.toggle('nav-open');
$('#sidebar-scrim').onclick = () => document.body.classList.remove('nav-open');

// ---------- VOICE (WebRTC mesh) ----------
$('#btn-voice-leave').onclick = () => leaveVoice();
$('#btn-mute').onclick = () => toggleMute();

async function joinVoice(serverId, channelId) {
  if (S.voice && S.voice.serverId === serverId && S.voice.channelId === channelId) return; // already here
  leaveVoice(true);
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  } catch {
    toast('Microphone blocked — allow mic access to join voice');
    return;
  }
  const ch = S.serverDetail?.channels.find((c) => c.id === channelId);
  S.voice = { serverId, channelId, stream, pcs: new Map(), muted: false, speaking: false, audioEls: new Map() };
  $('#voice-bar').classList.remove('hidden');
  $('#voice-chan-name').textContent = ch ? ch.name : 'voice';
  $('#btn-mute').textContent = 'Mute';
  S.ws?.send(JSON.stringify({ t: 'voice-join', serverId, channelId }));
  renderChannels();
  startSpeakingMonitor();
  toast('Connected to voice');
}
function leaveVoice(silent) {
  if (!S.voice) return;
  for (const [, pc] of S.voice.pcs) { try { pc.close(); } catch {} }
  S.voice.stream?.getTracks().forEach((t) => t.stop());
  for (const [, el] of S.voice.audioEls) { try { el.remove(); } catch {} }
  const { serverId, channelId } = S.voice;
  S.voice = null;
  stopSpeakingMonitor();
  $('#voice-bar').classList.add('hidden');
  // optimistically drop self so the sidebar clears instantly (server echo confirms)
  const occ = S.voiceOccupancy.get(channelId) || [];
  S.voiceOccupancy.set(channelId, occ.filter((p) => p.id !== S.me.id));
  if (!silent) S.ws?.send(JSON.stringify({ t: 'voice-leave' }));
  renderChannels();
  if (S.updateReady && !silent) location.reload();
}
function toggleMute() {
  if (!S.voice) return;
  S.voice.muted = !S.voice.muted;
  S.voice.stream.getAudioTracks().forEach((t) => (t.enabled = !S.voice.muted));
  $('#btn-mute').textContent = S.voice.muted ? 'Unmute' : 'Mute';
  if (S.voice.muted) { S.voice.speaking = false; setSpeakingUI(S.me.id, false); }
  S.ws?.send(JSON.stringify({ t: 'voice-state', muted: S.voice.muted, speaking: S.voice.muted ? false : !!S.voice.speaking }));
  renderVoiceUsers();
}
function ensurePeer(peerId, initiator) {
  if (!S.voice || peerId === S.me.id || S.voice.pcs.has(peerId)) return S.voice?.pcs.get(peerId);
  const pc = new RTCPeerConnection({ iceServers: S.iceServers });
  S.voice.pcs.set(peerId, pc);
  for (const track of S.voice.stream.getTracks()) pc.addTrack(track, S.voice.stream);
  pc.onicecandidate = (e) => {
    if (e.candidate) S.ws?.send(JSON.stringify({ t: 'voice-signal', to: peerId, data: { kind: 'ice', candidate: e.candidate } }));
  };
  pc.ontrack = (e) => attachRemoteAudio(peerId, e.streams[0]);
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) closePeer(peerId);
  };
  if (initiator) {
    pc.createOffer().then((offer) => pc.setLocalDescription(offer).then(() => {
      S.ws?.send(JSON.stringify({ t: 'voice-signal', to: peerId, data: { kind: 'offer', sdp: pc.localDescription } }));
    })).catch(() => {});
  }
  return pc;
}
async function onVoiceSignal(fromId, data) {
  if (!S.voice || !data) return;
  if (data.kind === 'offer') {
    const pc = ensurePeer(fromId, false);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      S.ws?.send(JSON.stringify({ t: 'voice-signal', to: fromId, data: { kind: 'answer', sdp: pc.localDescription } }));
    } catch {}
  } else if (data.kind === 'answer') {
    const pc = S.voice.pcs.get(fromId);
    if (pc) { try { await pc.setRemoteDescription(new RTCSessionDescription(data.sdp)); } catch {} }
  } else if (data.kind === 'ice' && data.candidate) {
    const pc = S.voice.pcs.get(fromId);
    if (pc) { try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {} }
  }
}
function onVoicePeers(peers) {
  if (!S.voice) return;
  // I just joined (or update): initiate offers to everyone already here
  for (const p of peers) {
    if (p.id !== S.me.id && !S.voice.pcs.has(p.id)) ensurePeer(p.id, true);
  }
  // clean up PCs for people who left
  const ids = new Set(peers.map((p) => p.id));
  for (const pid of [...S.voice.pcs.keys()]) {
    if (!ids.has(pid)) closePeer(pid);
  }
}
function closePeer(peerId) {
  if (!S.voice) return;
  const pc = S.voice.pcs.get(peerId);
  if (pc) { try { pc.close(); } catch {} S.voice.pcs.delete(peerId); }
  const el = S.voice.audioEls.get(peerId);
  if (el) { try { el.remove(); } catch {} S.voice.audioEls.delete(peerId); }
}
function attachRemoteAudio(peerId, stream) {
  if (!S.voice) return;
  let el = S.voice.audioEls.get(peerId);
  if (!el) {
    el = document.createElement('audio');
    el.autoplay = true;
    el.playsInline = true;
    document.body.appendChild(el);
    S.voice.audioEls.set(peerId, el);
  }
  el.srcObject = stream;
}
const MIC_OFF_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3M2 2l20 20"/></svg>';
// Discord-style: occupants listed under their voice channel, green ring while talking.
function renderVoiceUsers() {
  const d = S.serverDetail;
  if (!d) return;
  for (const c of d.channels.filter((x) => x.type === 'voice')) {
    const box = document.getElementById('vusers-' + c.id);
    if (!box) continue;
    const occ = S.voiceOccupancy.get(c.id) || [];
    box.innerHTML = '';
    for (const p of occ) {
      const u = document.createElement('div');
      u.className = 'vuser' + (p.speaking && !p.muted ? ' speaking' : '');
      u.dataset.vuser = p.id;
      u.dataset.uid = p.id;
      u.innerHTML = `<span class="avatar"></span><span class="vname">${esc(p.display_name)}${p.id === S.me.id ? ' (you)' : ''}</span>${p.muted ? '<span class="vmic">' + MIC_OFF_SVG + '</span>' : ''}`;
      paintAvatar(u.querySelector('.avatar'), p);
      box.appendChild(u);
    }
  }
}
function setSpeakingUI(userId, speaking) {
  const el = document.querySelector('[data-vuser="' + CSS.escape(userId) + '"]');
  if (el) el.classList.toggle('speaking', speaking);
}
// Voice activity detection: local mic level → broadcast speech state so every
// client sees green rings (works for all rooms, not just the one you're in).
let speakTimer = null, speakCtx = null, speakOn = false, speakQuiet = 0;
function startSpeakingMonitor() {
  stopSpeakingMonitor();
  try {
    speakCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = speakCtx.createMediaStreamSource(S.voice.stream);
    const an = speakCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    speakTimer = setInterval(() => {
      if (!S.voice) return;
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const lvl = Math.sqrt(sum / buf.length);
      let talking = speakOn;
      if (S.voice.muted) { talking = false; speakQuiet = 0; }
      else if (lvl > 0.09) { talking = true; speakQuiet = 0; }
      else if (speakOn && ++speakQuiet >= 3) { talking = false; speakQuiet = 0; }
      if (talking !== speakOn) {
        speakOn = talking;
        S.voice.speaking = talking;
        setSpeakingUI(S.me.id, talking);
        const occ = S.voiceOccupancy.get(S.voice.channelId) || [];
        const me = occ.find((p) => p.id === S.me.id);
        if (me) me.speaking = talking;
        S.ws?.send(JSON.stringify({ t: 'voice-state', muted: S.voice.muted, speaking: talking }));
      }
    }, 200);
  } catch {}
}
function stopSpeakingMonitor() {
  clearInterval(speakTimer); speakTimer = null;
  if (speakOn) { speakOn = false; speakQuiet = 0; if (S.me) setSpeakingUI(S.me.id, false); }
  try { speakCtx?.close(); } catch {}
  speakCtx = null;
}
window.addEventListener('beforeunload', () => { try { S.ws?.send(JSON.stringify({ t: 'voice-leave' })); } catch {} });

/* ================= rail folders + drag reorder ================= */
let dragPayload = null, dropTarget = null, dropMarker = null, folderMenuEl = null;
function showMarker(rect, edge) {
  if (!dropMarker) { dropMarker = document.createElement('div'); dropMarker.id = 'drop-marker'; document.body.appendChild(dropMarker); }
  dropMarker.style.display = 'block';
  dropMarker.style.left = rect.left + 'px';
  dropMarker.style.width = rect.width + 'px';
  dropMarker.style.top = (edge === 'before' ? rect.top - 2 : rect.bottom - 1) + 'px';
}
function hideMarker() { if (dropMarker) dropMarker.style.display = 'none'; }
function clearDropMarks() { document.querySelectorAll('.drop-combine').forEach((el) => el.classList.remove('drop-combine')); }
function detachServer(sid) {
  S.rootOrder = S.rootOrder.filter((it) => !(it.kind === 'server' && it.id === sid));
  for (const f of S.layoutFolders) f.servers = (f.servers || []).filter((id) => id !== sid);
}
function containerOf(sid) {
  for (const f of S.layoutFolders) {
    const i = (f.servers || []).indexOf(sid);
    if (i >= 0) return { type: 'folder', f, index: i };
  }
  return { type: 'root', index: S.rootOrder.findIndex((it) => it.kind === 'server' && it.id === sid) };
}
function normalizeAndSave() { renderServerList(); saveLayout(); }
let saveLayoutT = null;
function saveLayout() {
  clearTimeout(saveLayoutT);
  saveLayoutT = setTimeout(persistLayout, 400);
}
async function persistLayout() {
  const folders = [];
  S.rootOrder.forEach((it, i) => { if (it.kind === 'folder') { const f = folderById(it.id); if (f) folders.push(f); } });
  for (const f of S.layoutFolders) if (!folders.includes(f)) folders.push(f);
  const pos = new Map();
  S.rootOrder.forEach((it, i) => { if (it.kind === 'server') pos.set(it.id, { folderId: null, position: i }); });
  folders.forEach((f) => { (f.servers || []).forEach((sid, i) => pos.set(sid, { folderId: f.id, position: i })); });
  try {
    await api('/api/me/layout', { method: 'PUT', body: JSON.stringify({
      folders: folders.map((f) => ({
        id: f.id, name: f.name, color: f.color, open: !!f.open,
        position: Math.max(0, S.rootOrder.findIndex((it) => it.kind === 'folder' && it.id === f.id)),
      })),
      servers: S.servers.map((s) => ({ id: s.id, ...(pos.get(s.id) || { folderId: null, position: 999 }) })),
    }) });
  } catch {}
}
function applyDrop(dd, t) {
  if (!dd || !t) return;
  if (dd.kind === 'server') {
    if (t.zone === 'folder') {
      const f = folderById(t.id);
      if (!f) return;
      detachServer(dd.id);
      if (!f.servers.includes(dd.id)) f.servers.push(dd.id);
      f.open = true;
    } else if (t.zone === 'combine') {
      if (dd.id === t.id) return;
      detachServer(dd.id);
      const tc = containerOf(t.id);
      if (tc.index < 0 && tc.type === 'root') return;
      const nf = { id: (crypto.randomUUID ? crypto.randomUUID() : 'f' + Date.now()), name: 'New folder', color: '#5865f2', open: true, servers: [], position: 0 };
      if (tc.type === 'root') S.rootOrder.splice(tc.index, 0, { kind: 'folder', id: nf.id });
      else {
        const fi = S.rootOrder.findIndex((it) => it.kind === 'folder' && it.id === tc.f.id);
        S.rootOrder.splice(fi < 0 ? S.rootOrder.length : fi + 1, 0, { kind: 'folder', id: nf.id });
      }
      S.layoutFolders.push(nf);
      detachServer(t.id);
      nf.servers.push(t.id, dd.id);
      normalizeAndSave();
      renameFolder(nf.id);
      return;
    } else {
      const c = containerOf(t.id);
      if (c.type === 'folder') {
        detachServer(dd.id);
        const cc = containerOf(t.id);
        cc.f.servers.splice(cc.index + (t.zone === 'after' ? 1 : 0), 0, dd.id);
      } else {
        if (c.index < 0) return;
        detachServer(dd.id);
        const nc = containerOf(t.id);
        S.rootOrder.splice(nc.index + (t.zone === 'after' ? 1 : 0), 0, { kind: 'server', id: dd.id });
      }
    }
  } else {
    const from = S.rootOrder.findIndex((it) => it.kind === 'folder' && it.id === dd.id);
    if (from < 0) return;
    let idx;
    if (t.zone === 'before-folder' || t.zone === 'after-folder') {
      idx = S.rootOrder.findIndex((it) => it.kind === 'folder' && it.id === t.id);
      if (idx < 0) return;
      idx += t.zone === 'after-folder' ? 1 : 0;
    } else {
      const c = containerOf(t.id);
      idx = (c.type === 'root' ? c.index : S.rootOrder.findIndex((it) => it.kind === 'folder' && it.id === c.f.id)) + (t.zone === 'after' ? 1 : 0);
    }
    const [mv] = S.rootOrder.splice(from, 1);
    if (from < idx) idx--;
    S.rootOrder.splice(idx, 0, mv);
  }
  normalizeAndSave();
}
function wireDrag(el, kind, id) {
  el.addEventListener('dragstart', (e) => {
    dragPayload = { kind, id };
    try { e.dataTransfer.setData('text/plain', kind + ':' + id); } catch {}
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragover', (e) => {
    if (!dragPayload) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = el.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    clearDropMarks(); hideMarker();
    if (kind === 'folder' && dragPayload.kind === 'server') {
      el.classList.add('drop-combine');
      dropTarget = { zone: 'folder', id };
    } else if (kind === 'server' && dragPayload.kind === 'server' && dragPayload.id !== id && y >= 0.3 && y <= 0.7) {
      el.classList.add('drop-combine');
      dropTarget = { zone: 'combine', id };
    } else if (kind === 'folder') {
      const edge = y < 0.5 ? 'before' : 'after';
      showMarker(r, edge);
      dropTarget = { zone: edge + '-folder', id };
    } else {
      const edge = y < 0.5 ? 'before' : 'after';
      showMarker(r, edge);
      dropTarget = { zone: edge, id };
    }
  });
  el.addEventListener('dragleave', () => { el.classList.remove('drop-combine'); hideMarker(); });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const dd = dragPayload;
    clearDropMarks(); hideMarker();
    dragPayload = null;
    if (dd) applyDrop(dd, dropTarget);
    dropTarget = null;
  });
  el.addEventListener('dragend', () => { dragPayload = null; dropTarget = null; clearDropMarks(); hideMarker(); });
}
// drop on empty rail space → move to end of root
$('#server-list').addEventListener('dragover', (e) => {
  if (!dragPayload || e.target.closest('[data-drag]')) return;
  e.preventDefault();
});
$('#server-list').addEventListener('drop', (e) => {
  if (!dragPayload || e.target.closest('[data-drag]')) return;
  e.preventDefault();
  const dd = dragPayload;
  dragPayload = null; hideMarker();
  if (dd.kind === 'server') { detachServer(dd.id); S.rootOrder.push({ kind: 'server', id: dd.id }); }
  else {
    const from = S.rootOrder.findIndex((it) => it.kind === 'folder' && it.id === dd.id);
    if (from >= 0) { const [mv] = S.rootOrder.splice(from, 1); S.rootOrder.push(mv); }
  }
  normalizeAndSave();
});
function closeFolderMenu() { if (folderMenuEl) { folderMenuEl.remove(); folderMenuEl = null; } }
function renameFolder(fid) {
  const f = folderById(fid);
  if (!f) return;
  const n = prompt('Folder name:', f.name);
  if (n === null) return;
  f.name = n.trim().slice(0, 32) || 'Folder';
  saveLayout(); renderServerList();
}
const FOLDER_COLORS = ['#5865f2', '#3ba55d', '#ed4245', '#faa81a', '#9b59b6', '#1abc9c', '#e91e63', '#00b0f4'];
function openFolderMenu(fid, x, y) {
  closeFolderMenu();
  const f = folderById(fid);
  if (!f) return;
  const m = document.createElement('div');
  m.id = 'folder-menu';
  m.innerHTML = `<button class="fm-item" data-fact="rename">Rename</button><div class="swatches"></div><button class="fm-item" data-fact="toggle">${f.open ? 'Collapse' : 'Expand'}</button><button class="fm-item danger" data-fact="delete">Delete folder</button>`;
  const sw = m.querySelector('.swatches');
  for (const c of FOLDER_COLORS) {
    const d = document.createElement('div');
    d.className = 'sw' + (f.color === c ? ' sel' : '');
    d.style.background = c;
    d.onclick = () => { f.color = c; saveLayout(); renderServerList(); closeFolderMenu(); };
    sw.appendChild(d);
  }
  m.querySelector('[data-fact="rename"]').onclick = () => { closeFolderMenu(); renameFolder(fid); };
  m.querySelector('[data-fact="toggle"]').onclick = () => { f.open = !f.open; saveLayout(); renderServerList(); closeFolderMenu(); };
  m.querySelector('[data-fact="delete"]').onclick = () => {
    closeFolderMenu();
    const fi = S.rootOrder.findIndex((it) => it.kind === 'folder' && it.id === fid);
    const kids = [...(f.servers || [])];
    S.rootOrder = S.rootOrder.filter((it) => !(it.kind === 'folder' && it.id === fid));
    kids.forEach((sid, i) => S.rootOrder.splice(fi + i, 0, { kind: 'server', id: sid }));
    S.layoutFolders = S.layoutFolders.filter((x) => x.id !== fid);
    saveLayout(); renderServerList();
  };
  document.body.appendChild(m);
  m.style.left = Math.min(x, innerWidth - 210) + 'px';
  m.style.top = Math.min(y, innerHeight - 230) + 'px';
  folderMenuEl = m;
}

/* ================= v2 features: emoji, GIFs, replies, threads, reactions, cards, settings ================= */
const EMOJI = [
 ['sec','Smileys & people'],
 ['😀','grinning smile happy'],['😁','grin happy'],['😂','joy laugh lol tears'],['🤣','rofl laugh'],['😊','smile blush'],['😍','heart eyes love'],['😘','kiss'],['😎','cool sunglasses'],['🤔','thinking hmm'],['😴','sleep tired'],['🤯','mind blown'],['🥳','party celebrate'],['😢','cry sad tears'],['😭','sob cry'],['😡','angry rage'],['💀','skull dead lol'],['👍','thumbs up yes'],['👎','thumbs down no'],['👏','clap applause'],['🙏','pray thanks please'],['👋','wave hi hello'],['👀','eyes look'],['💪','muscle strong'],
 ['sec','Hearts & fun'],
 ['❤️','heart love red'],['💔','broken heart'],['💯','100 hundred'],['✨','sparkles new'],['🔥','fire lit'],['🎉','party tada celebrate'],['⭐','star'],['🌈','rainbow'],['🎮','game controller gaming'],['🚀','rocket ship'],['🎁','gift present'],['🏆','trophy win'],['🎵','music note'],['💡','idea lightbulb'],['✅','check yes'],['❌','cross no'],['❓','question'],['💩','poop'],['👻','ghost'],['🤖','robot'],['🍕','pizza'],['☕','coffee'],['🐱','cat kitten'],['🐶','dog puppy'],
];
S.picker = null; // {mode:'insert'|'react', mid?}

// ---------- emoji / GIF picker ----------
function openPicker(mode = 'insert', mid = null, tab = 'emoji') {
  S.picker = { mode, mid };
  $('#picker').classList.remove('hidden');
  setPickerTab(tab);
  $('#pk-search').value = '';
  renderEmojiGrid('');
  ensureEmojiData().then(() => { if (S.picker) renderEmojiGrid($('#pk-search').value); });
  loadGifTrending();
  setTimeout(() => $('#pk-search').focus(), 0);
}
function closePicker() { $('#picker').classList.add('hidden'); S.picker = null; }
function setPickerTab(t) {
  document.querySelectorAll('.pk-tab').forEach((b) => b.classList.toggle('active', b.dataset.ptab === t));
  $('#pk-emoji').classList.toggle('hidden', t !== 'emoji');
  $('#pk-gifs').classList.toggle('hidden', t !== 'gifs');
  $('#pk-klipy').classList.toggle('hidden', t !== 'gifs');
  $('#pk-search').placeholder = t === 'gifs' ? 'Search KLIPY' : 'Search emoji';
}
document.querySelectorAll('.pk-tab').forEach((b) => (b.onclick = () => setPickerTab(b.dataset.ptab)));
let emojiData = null, emojiLoadP = null;
function ensureEmojiData() {
  if (emojiData) return Promise.resolve(emojiData);
  if (!emojiLoadP) {
    emojiLoadP = fetch('/emoji.json').then((r) => {
      if (!r.ok) throw new Error('no dataset');
      return r.json();
    }).then((j) => { emojiData = j; return j; }).catch(() => null);
  }
  return emojiLoadP;
}
function emojiButton(box, ch, label, onclick) {
  const b = document.createElement('button');
  b.className = 'pk-emoji-btn';
  b.textContent = ch;
  if (label) b.title = label;
  b.onclick = onclick;
  box.appendChild(b);
}
function renderEmojiGrid(filter) {
  const box = $('#pk-emoji');
  box.innerHTML = '';
  const f = filter.trim().toLowerCase();
  const custom = Object.entries(S.emoji).filter(([n]) => !f || n.includes(f));
  if (custom.length) {
    box.insertAdjacentHTML('beforeend', '<div class="pk-sec">Custom</div>');
    for (const [n, url] of custom) {
      const b = document.createElement('button');
      b.className = 'pk-emoji-btn'; b.title = ':' + n + ':';
      b.innerHTML = `<img class="pk-custom" src="${esc(url)}" alt=":${esc(n)}:" />`;
      b.onclick = () => pickEmoji(':' + n + ':');
      box.appendChild(b);
    }
  }
  for (const [ch, kw] of EMOJI) {
    if (ch === 'sec') { box.insertAdjacentHTML('beforeend', `<div class="pk-sec">${esc(kw)}</div>`); continue; }
    if (f && !(kw || '').includes(f)) continue;
    emojiButton(box, ch, null, () => pickEmoji(ch));
  }
  if (emojiData) {
    box.innerHTML = '';
    if (custom.length) {
      box.insertAdjacentHTML('beforeend', '<div class="pk-sec">Custom</div>');
      for (const [n, url] of custom) {
        const b = document.createElement('button');
        b.className = 'pk-emoji-btn'; b.title = ':' + n + ':';
        b.innerHTML = `<img class="pk-custom" src="${esc(url)}" alt=":${esc(n)}:" />`;
        b.onclick = () => pickEmoji(':' + n + ':');
        box.appendChild(b);
      }
    }
    let shown = 0;
    for (const g of emojiData.groups) {
      const items = f ? g.items.filter((it) => it[1].includes(f)) : g.items;
      if (!items.length) continue;
      const capped = f ? items.slice(0, 120) : items;
      box.insertAdjacentHTML('beforeend', `<div class="pk-sec">${esc(g.name)}${f && items.length > capped.length ? ` (${items.length})` : ''}</div>`);
      for (const [ch] of capped) {
        emojiButton(box, ch, null, () => pickEmoji(ch));
        if (f && ++shown >= 400) break;
      }
      if (f && shown >= 400) break;
    }
  }
  if (!box.children.length) box.innerHTML = '<div class="pk-empty">No emoji match.</div>';
}
function pickEmoji(e) {
  if (S.picker?.mode === 'react' && S.picker.mid) toggleReaction(S.picker.mid, e);
  else insertAtCursor($('#in-message'), e);
  closePicker();
  $('#in-message').focus();
}
function insertAtCursor(input, text) {
  const s = input.selectionStart ?? input.value.length, e = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, s) + text + input.value.slice(e);
  input.selectionStart = input.selectionEnd = s + text.length;
}
let gifSearchT = null;
$('#pk-search').addEventListener('input', (e) => {
  const q = e.target.value;
  renderEmojiGrid(q);
  clearTimeout(gifSearchT);
  if (!q.trim()) { loadGifTrending(); return; }
  setPickerTab('gifs');
  gifSearchT = setTimeout(() => loadGifSearch(q.trim()), 350);
});
function renderGifGrid(gifs) {
  const box = $('#pk-gifs');
  box.innerHTML = '';
  if (!gifs.length) { box.innerHTML = '<div class="pk-empty">No GIFs found.</div>'; return; }
  for (const g of gifs) {
    const b = document.createElement('button');
    b.className = 'pk-gif'; b.title = g.title || 'GIF';
    b.innerHTML = `<img src="${esc(g.thumb || g.preview || g.gif)}" alt="${esc(g.title || 'GIF')}" loading="lazy" />`;
    b.onclick = () => sendGif(g);
    box.appendChild(b);
  }
}
async function loadGifTrending() {
  const box = $('#pk-gifs');
  box.innerHTML = '<div class="pk-empty">Loading…</div>';
  try {
    const { gifs } = await api('/api/gifs/trending');
    renderGifGrid(gifs);
  } catch { box.innerHTML = '<div class="pk-empty">GIFs unavailable.</div>'; }
}
async function loadGifSearch(q) {
  const box = $('#pk-gifs');
  box.innerHTML = '<div class="pk-empty">Searching…</div>';
  try {
    const { gifs } = await api('/api/gifs/search?q=' + encodeURIComponent(q));
    renderGifGrid(gifs);
  } catch { box.innerHTML = '<div class="pk-empty">Search failed.</div>'; }
}
function sendGif(g) {
  closePicker();
  if (!S.serverId || !S.channelId) return;
  sendChat('', { attachments: [{ url: g.gif, name: (g.title || 'gif').slice(0, 80) + '.gif', mime: 'image/gif', size: 0, kind: 'image' }] });
}

// ---------- reactions / reply / edit / thread actions ----------
async function toggleReaction(mid, emoji) {
  try {
    const { reactions } = await api('/api/messages/' + mid + '/reactions', { method: 'POST', body: JSON.stringify({ emoji }) });
    updateMsgInCaches(mid, (m) => { m.reactions = reactions.map((r) => ({ emoji: r.emoji, count: r.count, me: r.me })); });
    if (S.channelId) renderMessages();
    if (S.thread) renderThread();
  } catch (err) { toast('Reaction failed: ' + prettyError(err.message)); }
}
async function jumpToMessage(id) {
  const el = document.querySelector(`#messages [data-mid="${CSS.escape(id)}"]`);
  if (el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    return;
  }
  try {
    const { message } = await api('/api/messages/' + id);
    toast(`${message.user ? message.user.display_name : '?'}: ${(message.content || '[attachment]').slice(0, 100)}`);
  } catch { toast('Message not found'); }
}
function startEdit(mid) {
  S.editing = mid;
  if (S.channelId) renderMessages();
  if (S.thread) renderThread();
  setTimeout(() => { const t = $('#edit-area'); if (t) { t.focus(); t.selectionStart = t.value.length; } }, 0);
}
async function saveEdit(mid) {
  const t = $('#edit-area');
  const content = (t?.value || '').trim();
  if (!content) return;
  S.editing = null;
  try { await api('/api/messages/' + mid, { method: 'PATCH', body: JSON.stringify({ content }) }); }
  catch (err) { toast('Edit failed: ' + prettyError(err.message)); if (S.channelId) renderMessages(); }
}
// global delegation for message interactions
 document.addEventListener('click', (e) => {
  const uidEl = e.target.closest('[data-uid]');
  const actEl = e.target.closest('[data-act]');
  const jumpEl = e.target.closest('[data-jump]');
  const reactEl = e.target.closest('.reaction');
  const imgEl = e.target.closest('.att-img');
  const memberEl = e.target.closest('.member');
  if (reactEl && reactEl.dataset.emoji) {
    const msgEl = reactEl.closest('[data-mid]');
    if (msgEl) toggleReaction(msgEl.dataset.mid, reactEl.dataset.emoji);
    return;
  }
  if (imgEl) { openLightbox(imgEl.src); return; }
  if (jumpEl) { jumpToMessage(jumpEl.dataset.jump); return; }
  if (actEl) {
    const msgEl = actEl.closest('[data-mid]');
    const mid = msgEl?.dataset.mid;
    const act = actEl.dataset.act;
    if (act === 'react' && !actEl.dataset.emoji) openPicker('react', mid);
    else if (act === 'reply' && mid) { S.replyTo = msgById(mid); renderComposerMeta(); $('#in-message').focus(); }
    else if (act === 'thread' && mid) openThread(mid);
    else if (act === 'edit' && mid) startEdit(mid);
    else if (act === 'edit-save' && mid) saveEdit(mid);
    else if (act === 'edit-cancel') { S.editing = null; if (S.channelId) renderMessages(); if (S.thread) renderThread(); }
    else if (act === 'del' && mid) api('/api/messages/' + mid, { method: 'DELETE' }).catch(() => toast('Delete failed'));
    return;
  }
  if (memberEl?.dataset.uid) { const r = memberEl.getBoundingClientRect(); openUserCard(memberEl.dataset.uid, r.right + 8, r.top); return; }
  if (uidEl?.dataset.uid) { openUserCard(uidEl.dataset.uid, e.clientX, e.clientY); return; }
});

// ---------- threads ----------
async function openThread(rootId) {
  try {
    const { root, replies } = await api(`/api/servers/${S.serverId}/channels/${S.channelId}/threads/${rootId}`);
    S.thread = { rootId, channelId: S.channelId, root, replies };
    $('#thread-sub').textContent = '#' + chanName(S.channelId);
    $('#thread-panel').classList.remove('hidden');
    renderThread(true);
  } catch { toast('Could not open thread'); }
}
function renderThread(scroll = false) {
  if (!S.thread) return;
  const rootBox = $('#thread-root'), repBox = $('#thread-replies');
  rootBox.innerHTML = '';
  rootBox.appendChild(messageEl(S.thread.root, { inThread: true }));
  const nearBottom = repBox.scrollHeight - repBox.scrollTop - repBox.clientHeight < 200;
  repBox.innerHTML = '';
  for (const r of S.thread.replies) repBox.appendChild(messageEl(r, { inThread: true }));
  if (!S.thread.replies.length) repBox.innerHTML = '<p class="muted small" style="text-align:center">No replies yet.</p>';
  if (scroll || nearBottom) repBox.scrollTop = repBox.scrollHeight;
}
function closeThread(silent) {
  S.thread = null;
  const p = $('#thread-panel');
  if (p) p.classList.add('hidden');
}
$('#thread-close').onclick = () => closeThread();
$('#thread-composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!S.thread) return;
  const inp = $('#in-thread');
  const content = inp.value.trim();
  if (!content) return;
  inp.value = '';
  sendChat(content, { threadRoot: S.thread.rootId });
});

// ---------- lightbox ----------
function openLightbox(src) {
  $('#lightbox-img').src = src;
  $('#lightbox').classList.remove('hidden');
}
$('#lightbox').onclick = () => { $('#lightbox').classList.add('hidden'); $('#lightbox-img').src = ''; };

// ---------- user card ----------
function openUserCard(uid, x, y) {
  const u = memberById(uid);
  if (!u) return;
  const card = $('#usercard');
  const st = statusOf(uid);
  const stLabel = { online: 'Online', away: 'Away', dnd: 'Do not disturb', offline: 'Offline' }[st];
  card.innerHTML = `
    <div class="uc-banner"${u.banner_url ? ` style="background-image:url('${esc(u.banner_url)}')"` : ''}></div>
    <div class="uc-body">
      <span class="avatar big"></span>
      <div class="uc-name">${esc(u.display_name)}</div>
      <div class="uc-sub">@${esc(u.username)}${u.role === 'owner' ? ' · server owner' : ''}</div>
      <div class="uc-status"><span class="status-dot ${st}"></span><span>${stLabel}</span></div>
      ${u.status_text ? `<div class="uc-statustext">${esc(u.status_text)}</div>` : ''}
      ${u.created_at ? `<div class="uc-since">Member since ${new Date(u.created_at).toLocaleDateString()}</div>` : ''}
      <div class="uc-actions">${uid !== S.me.id ? '<button class="btn small" id="uc-mention">Mention</button>' : ''}<button class="btn small" id="uc-close">Close</button></div>
    </div>`;
  paintAvatar(card.querySelector('.avatar'), u);
  card.classList.remove('hidden');
  const r = card.getBoundingClientRect();
  card.style.left = Math.max(8, Math.min(x || 8, innerWidth - 296)) + 'px';
  card.style.top = Math.max(8, Math.min(y || 8, innerHeight - (r.height || 300) - 8)) + 'px';
  $('#uc-close').onclick = closeUserCard;
  const men = $('#uc-mention');
  if (men) men.onclick = () => { insertAtCursor($('#in-message'), '@' + u.username + ' '); closeUserCard(); $('#in-message').focus(); };
}
function closeUserCard() { $('#usercard').classList.add('hidden'); }

// ---------- @mention autocomplete ----------
let mentionIdx = 0;
function hideMentionPop() { $('#mention-pop').classList.add('hidden'); }
$('#in-message').addEventListener('input', () => {
  const inp = $('#in-message');
  const upto = inp.value.slice(0, inp.selectionStart ?? inp.value.length);
  const m = upto.match(/@([a-z0-9_.]{1,24})$/);
  if (!m) { hideMentionPop(); return; }
  const q = m[1].toLowerCase();
  const cands = (S.serverDetail?.members || []).filter((x) => x.username.includes(q) || x.display_name.toLowerCase().includes(q)).slice(0, 6);
  if (!cands.length) { hideMentionPop(); return; }
  mentionIdx = 0;
  const pop = $('#mention-pop');
  pop.innerHTML = '';
  cands.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mention-item' + (i === 0 ? ' sel' : '');
    b.innerHTML = `<span class="avatar"></span><span>${esc(c.display_name)} <span class="muted">@${esc(c.username)}</span></span>`;
    paintAvatar(b.querySelector('.avatar'), c);
    b.onmousedown = (e) => { e.preventDefault(); applyMention(c.username); };
    pop.appendChild(b);
  });
  pop.classList.remove('hidden');
});
$('#in-message').addEventListener('keydown', (e) => {
  const pop = $('#mention-pop');
  if (pop.classList.contains('hidden')) return;
  const items = [...pop.querySelectorAll('.mention-item')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    mentionIdx = (mentionIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((b, i) => b.classList.toggle('sel', i === mentionIdx));
  } else if ((e.key === 'Enter' || e.key === 'Tab') && items[mentionIdx]) {
    e.preventDefault();
    applyMention(items[mentionIdx].querySelector('.muted').textContent.slice(1));
  } else if (e.key === 'Escape') hideMentionPop();
});
function applyMention(username) {
  const inp = $('#in-message');
  const pos = inp.selectionStart ?? inp.value.length;
  inp.value = inp.value.slice(0, pos).replace(/@[a-z0-9_.]{1,24}$/, '@' + username + ' ');
  hideMentionPop();
  inp.focus();
}

// ---------- settings (tabbed) ----------
function openSettings(tab = 'profile') {
  setSettingsTab(tab);
  $('#set-display').value = S.me.display_name || '';
  $('#set-status').value = S.me.status || 'online';
  $('#set-statustext').value = S.me.status_text || '';
  $('#set-username').value = S.me.username || '';
  $('#set-pw-cur').value = ''; $('#set-pw-new').value = '';
  paintAvatar($('#set-avatar-prev'), S.me);
  const b = $('#set-banner-prev');
  b.style.backgroundImage = S.me.banner_url ? `url('${S.me.banner_url}')` : '';
  renderServerTab();
  $('#settings-backdrop').classList.remove('hidden');
}
function closeSettings() { $('#settings-backdrop').classList.add('hidden'); }
function setSettingsTab(t) {
  document.querySelectorAll('.set-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  $('#set-profile').classList.toggle('hidden', t !== 'profile');
  $('#set-account').classList.toggle('hidden', t !== 'account');
  $('#set-server').classList.toggle('hidden', t !== 'server');
}
document.querySelectorAll('.set-tab').forEach((b) => (b.onclick = () => setSettingsTab(b.dataset.tab)));
$('#btn-settings-rail').onclick = () => openSettings('profile');
$('#btn-server-menu').onclick = () => openSettings('server');
$('#settings-close').onclick = closeSettings;
$('#settings-backdrop').addEventListener('click', (e) => { if (e.target.id === 'settings-backdrop') closeSettings(); });
async function uploadImage(url, file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(url, { method: 'POST', headers: store.token ? { Authorization: 'Bearer ' + store.token } : {}, body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'upload_failed');
  return data;
}
$('#set-avatar-btn').onclick = () => $('#set-avatar-file').click();
$('#set-banner-btn').onclick = () => $('#set-banner-file').click();
$('#set-avatar-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { const { user } = await uploadImage('/api/me/avatar', f); S.me = { ...S.me, ...user }; paintMe(); paintAvatar($('#set-avatar-prev'), S.me); toast('Avatar updated'); }
  catch (err) { toast('Avatar failed: ' + prettyError(err.message)); }
});
$('#set-banner-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { const { user } = await uploadImage('/api/me/banner', f); S.me = { ...S.me, ...user }; $('#set-banner-prev').style.backgroundImage = `url('${S.me.banner_url}')`; toast('Banner updated'); }
  catch (err) { toast('Banner failed: ' + prettyError(err.message)); }
});
$('#set-avatar-rm').onclick = async () => {
  try { const { user } = await api('/api/me/avatar', { method: 'DELETE' }); S.me = { ...S.me, ...user }; paintMe(); paintAvatar($('#set-avatar-prev'), S.me); }
  catch { toast('Remove failed'); }
};
$('#set-banner-rm').onclick = async () => {
  try { const { user } = await api('/api/me/banner', { method: 'DELETE' }); S.me = { ...S.me, ...user }; $('#set-banner-prev').style.backgroundImage = ''; }
  catch { toast('Remove failed'); }
};
$('#set-profile-save').onclick = async () => {
  try {
    const { user } = await api('/api/me', { method: 'PATCH', body: JSON.stringify({
      displayName: $('#set-display').value.trim(),
      status: $('#set-status').value,
      statusText: $('#set-statustext').value.trim(),
    }) });
    S.me = { ...S.me, ...user };
    paintMe(); renderMembers();
    toast('Profile saved');
  } catch (err) { toast('Save failed: ' + prettyError(err.message)); }
};
$('#set-pw-save').onclick = async () => {
  try {
    await api('/api/me/password', { method: 'POST', body: JSON.stringify({ current: $('#set-pw-cur').value, next: $('#set-pw-new').value }) });
    $('#set-pw-cur').value = ''; $('#set-pw-new').value = '';
    toast('Password changed');
  } catch (err) { toast('Failed: ' + prettyError(err.message)); }
};
$('#set-logout').onclick = doLogout;
$('#me-card').style.cursor = 'pointer';
$('#me-card').onclick = () => openSettings('profile');
function renderServerTab() {
  const box = $('#set-server');
  const d = S.serverDetail;
  if (!d) { box.innerHTML = '<p class="muted">No server selected.</p>'; return; }
  const owner = d.owner_id === S.me.id;
  box.innerHTML = '';
  const h = (t) => { const e = document.createElement('h4'); e.textContent = t; e.style.margin = '1rem 0 .4rem'; box.appendChild(e); };
  // general
  h('General');
  const nameRow = document.createElement('div');
  nameRow.innerHTML = `<label style="flex:1">Server name<input id="srv-name" maxlength="48" value="${esc(d.name)}" ${owner ? '' : 'disabled'} /></label>`;
  box.appendChild(nameRow);
  const iconRow = document.createElement('div');
  iconRow.className = 'row';
  iconRow.style.margin = '.5rem 0';
  iconRow.innerHTML = `<span class="server-btn" style="width:40px;height:40px;font-size:1rem"></span>`;
  const prev = iconRow.querySelector('.server-btn');
  const paintPrev = () => {
    if (d.icon_url) { prev.textContent = ''; prev.classList.add('has-icon'); prev.style.backgroundImage = `url("${d.icon_url}")`; }
    else { prev.classList.remove('has-icon'); prev.style.backgroundImage = ''; prev.textContent = d.name.trim().charAt(0).toUpperCase(); }
  };
  paintPrev();
  if (owner) {
    const ch = document.createElement('button'); ch.className = 'btn small'; ch.textContent = 'Change icon';
    const rm = document.createElement('button'); rm.className = 'btn small'; rm.textContent = 'Remove';
    const fi = document.createElement('input'); fi.type = 'file'; fi.accept = 'image/png,image/jpeg,image/gif,image/webp'; fi.className = 'hidden';
    ch.onclick = () => fi.click();
    fi.onchange = async () => { if (!fi.files[0]) return; try { await uploadImage(`/api/servers/${d.id}/icon`, fi.files[0]); renderServerTab(); } catch (err) { toast('Icon failed: ' + prettyError(err.message)); } };
    rm.onclick = async () => { try { await api(`/api/servers/${d.id}/icon`, { method: 'DELETE' }); renderServerTab(); } catch {} };
    const sv = document.createElement('button'); sv.className = 'btn small primary'; sv.textContent = 'Save name';
    sv.onclick = async () => { try { await api(`/api/servers/${d.id}`, { method: 'PATCH', body: JSON.stringify({ name: box.querySelector('#srv-name').value }) }); toast('Server saved'); } catch (err) { toast('Save failed: ' + prettyError(err.message)); } };
    iconRow.append(ch, rm, sv);
  }
  box.appendChild(iconRow);
  // invite
  h('Invite');
  const inv = document.createElement('div');
  inv.innerHTML = `<div class="codebox">${esc(d.invite_code)}</div>`;
  const invRow = document.createElement('div'); invRow.className = 'row';
  const cp = document.createElement('button'); cp.className = 'btn small'; cp.textContent = 'Copy link';
  cp.onclick = () => { navigator.clipboard?.writeText(`${location.origin}${location.pathname}?invite=${d.invite_code}`); toast('Link copied'); };
  invRow.appendChild(cp);
  if (owner) {
    const rs = document.createElement('button'); rs.className = 'btn small'; rs.textContent = 'Reset code';
    rs.onclick = async () => { try { const r = await api(`/api/servers/${d.id}/invite/reset`, { method: 'POST' }); S.serverDetail.invite_code = r.invite_code; renderServerTab(); } catch {} };
    invRow.appendChild(rs);
  }
  inv.appendChild(invRow); box.appendChild(inv);
  // channels
  h('Channels');
  for (const c of d.channels) {
    const row = document.createElement('div');
    row.className = 'set-row';
    row.innerHTML = `<span class="muted">(${c.type})</span><span class="grow">${esc(c.name)}</span>`;
    if (owner) {
      const del = document.createElement('button'); del.className = 'mini danger'; del.textContent = 'Delete';
      del.onclick = async () => { try { await api(`/api/servers/${d.id}/channels/${c.id}`, { method: 'DELETE' }); } catch (err) { toast('Delete failed: ' + prettyError(err.message)); } };
      row.appendChild(del);
    }
    box.appendChild(row);
  }
  if (owner) {
    const add = document.createElement('div'); add.className = 'row'; add.style.marginTop = '.5rem';
    add.innerHTML = `<input id="srv-newchan" maxlength="32" placeholder="new-channel" style="flex:2" /><select id="srv-newtype" style="flex:1"><option value="text">Text</option><option value="voice">Voice</option></select>`;
    const go = document.createElement('button'); go.className = 'btn small'; go.textContent = 'Add';
    go.onclick = async () => {
      const name = add.querySelector('#srv-newchan').value.trim().replace(/\s+/g, '-');
      if (!name) return;
      try { await api(`/api/servers/${d.id}/channels`, { method: 'POST', body: JSON.stringify({ name, type: add.querySelector('#srv-newtype').value }) }); renderServerTab(); }
      catch (err) { toast('Failed: ' + prettyError(err.message)); }
    };
    add.appendChild(go); box.appendChild(add);
  }
  // custom emoji
  h('Custom emoji');
  const elist = document.createElement('div'); elist.id = 'srv-emojilist';
  const drawEmoji = () => {
    elist.innerHTML = '';
    const names = Object.keys(S.emoji).sort();
    if (!names.length) elist.innerHTML = '<p class="muted small">None yet — add some below. Use them with :name: or the emoji picker.</p>';
    for (const n of names) {
      const row = document.createElement('div'); row.className = 'set-row';
      row.innerHTML = `<img class="set-emoji-img" src="${esc(S.emoji[n])}" alt="" /><span class="grow">:${esc(n)}:</span>`;
      if (owner) {
        const del = document.createElement('button'); del.className = 'mini danger'; del.textContent = 'Delete';
        del.onclick = async () => { try { await api(`/api/servers/${d.id}/emoji/${encodeURIComponent(n)}`, { method: 'DELETE' }); const r = await api(`/api/servers/${d.id}/emoji`); S.emoji = {}; for (const e of r.emoji) S.emoji[e.name] = e.url; drawEmoji(); } catch {} };
        row.appendChild(del);
      }
      elist.appendChild(row);
    }
  };
  drawEmoji(); box.appendChild(elist);
  const eadd = document.createElement('div'); eadd.className = 'row'; eadd.style.marginTop = '.5rem';
  eadd.innerHTML = `<input id="srv-emojiname" maxlength="32" placeholder="name" style="flex:1" />`;
  const epick = document.createElement('button'); epick.className = 'btn small'; epick.textContent = 'Upload image';
  const efile = document.createElement('input'); efile.type = 'file'; efile.accept = 'image/png,image/jpeg,image/gif,image/webp'; efile.className = 'hidden';
  epick.onclick = () => efile.click();
  efile.onchange = async () => {
    const nm = eadd.querySelector('#srv-emojiname').value.trim().toLowerCase();
    if (!efile.files[0] || !nm) { toast('Enter a name and pick an image'); return; }
    const fd = new FormData(); fd.append('file', efile.files[0]); fd.append('name', nm);
    try {
      const res = await fetch(`/api/servers/${d.id}/emoji`, { method: 'POST', headers: store.token ? { Authorization: 'Bearer ' + store.token } : {}, body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'failed');
      S.emoji = {}; for (const e of data.emoji) S.emoji[e.name] = e.url;
      drawEmoji();
    } catch (err) { toast('Emoji failed: ' + prettyError(err.message)); }
  };
  eadd.appendChild(epick); box.appendChild(eadd); box.appendChild(efile);
  // danger / leave
  const dz = document.createElement('div'); dz.className = 'danger-zone';
  dz.innerHTML = `<h4>${owner ? 'Danger zone' : 'Leave'}</h4>`;
  const lb = document.createElement('button');
  lb.className = 'btn danger small';
  lb.textContent = owner ? 'Delete server' : 'Leave server';
  lb.onclick = async () => {
    if (owner && !confirm('Delete this server forever?')) return;
    try {
      if (owner) await api(`/api/servers/${d.id}`, { method: 'DELETE' });
      else await api(`/api/servers/${d.id}/leave`, { method: 'POST' });
      closeSettings();
      S.ws?.send(JSON.stringify({ t: 'subscribe' }));
      refreshServers();
    } catch (err) { toast('Failed: ' + prettyError(err.message)); }
  };
  dz.appendChild(lb); box.appendChild(dz);
}

// ---------- presence: quick switch + idle auto-away ----------
let statusMenuEl = null;
function closeStatusMenu() { statusMenuEl?.remove(); statusMenuEl = null; }
$('#me-avatar').style.cursor = 'pointer';
$('#me-avatar').onclick = (e) => {
  e.stopPropagation();
  if (statusMenuEl) { closeStatusMenu(); return; }
  const r = $('#me-avatar').getBoundingClientRect();
  statusMenuEl = document.createElement('div');
  statusMenuEl.id = 'status-pop';
  statusMenuEl.style.cssText = `position:fixed;left:${r.left}px;bottom:${innerHeight - r.top + 8}px;top:auto;min-width:180px`;
  statusMenuEl.classList.remove('hidden');
  for (const s of ['online', 'away', 'dnd', 'invisible']) {
    const b = document.createElement('button');
    b.className = 'mention-item';
    b.innerHTML = `<span class="status-dot ${s}"></span><span style="text-transform:capitalize">${s === 'dnd' ? 'Do not disturb' : s}</span>`;
    b.onclick = async () => { closeStatusMenu(); await setStatus(s); };
    statusMenuEl.appendChild(b);
  }
  document.body.appendChild(statusMenuEl);
};
async function setStatus(s) {
  try {
    const { user } = await api('/api/me', { method: 'PATCH', body: JSON.stringify({ status: s }) });
    S.me = { ...S.me, ...user };
    paintMe(); renderMembers();
  } catch {}
}
let idleTimer = null;
function poke() {
  if (!S.me) return;
  clearTimeout(idleTimer);
  if (S.me.status === 'away') setStatus('online');
  idleTimer = setTimeout(() => { if (S.me && S.me.status === 'online') setStatus('away'); }, 5 * 60 * 1000);
}
['mousemove', 'keydown', 'click'].forEach((ev) => document.addEventListener(ev, poke, { passive: true }));

// ---------- global closers ----------
 document.addEventListener('click', (e) => {
  if (!e.target.closest('#picker') && !e.target.closest('#btn-emoji') && !e.target.closest('#btn-gif') && !e.target.closest('[data-act="react"]')) closePicker();
  if (!e.target.closest('#usercard') && !e.target.closest('[data-uid]') && !e.target.closest('.member')) closeUserCard();
  if (statusMenuEl && !e.target.closest('#status-pop') && !e.target.closest('#me-avatar')) closeStatusMenu();
  if (folderMenuEl && !e.target.closest('#folder-menu')) closeFolderMenu();
});
 document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closePicker(); closeUserCard(); closeStatusMenu(); closeFolderMenu(); closeSettings(); $('#lightbox').classList.add('hidden'); }
});
$('#btn-emoji').onclick = () => { $('#picker').classList.contains('hidden') ? openPicker('insert', null, 'emoji') : closePicker(); };
$('#btn-gif').onclick = () => { $('#picker').classList.contains('hidden') ? openPicker('insert', null, 'gifs') : closePicker(); };

// Broken images (deleted/missing uploads) degrade gracefully instead of
// rendering as crushed broken-image boxes.
document.addEventListener('error', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLImageElement)) return;
  if (t.dataset.fbName) {
    const a = document.createElement('a');
    a.className = 'file-card'; a.href = t.dataset.fbUrl; a.target = '_blank'; a.rel = 'noopener';
    const s = document.createElement('span');
    const n = document.createElement('span'); n.className = 'fname'; n.textContent = t.dataset.fbName;
    s.appendChild(n); a.appendChild(s);
    t.replaceWith(a);
  } else if (t.dataset.fbEmoji) {
    t.replaceWith(document.createTextNode(t.dataset.fbEmoji));
  }
}, true);

// ---------- auto-update (deploys apply without hard refresh) ----------
S.bootVersion = null; S.updateReady = false;
async function checkVersion() {
  try {
    const r = await fetch('/api/version', { cache: 'no-store' });
    const { version } = await r.json();
    if (!S.bootVersion) { S.bootVersion = version; return; }
    if (version === S.bootVersion) return;
    if (!S.updateReady) onUpdateReady();
    else if (!S.voice && !document.hidden) location.reload();
  } catch {}
}
function onUpdateReady() {
  S.updateReady = true;
  if (S.voice) { toast('Update ready — applies when you leave voice'); return; }
  toastAction('App updated — refresh for the latest version', 'Refresh', () => location.reload());
  clearTimeout(onUpdateReady._t);
  onUpdateReady._t = setTimeout(() => { if (S.updateReady && !S.voice && !document.hidden) location.reload(); }, 30000);
}
function toastAction(msg, label, fn) {
  const el = $('#toast');
  el.innerHTML = '';
  el.appendChild(document.createTextNode(msg));
  if (label) {
    const b = document.createElement('button');
    b.className = 'btn small primary'; b.style.marginLeft = '.6rem'; b.textContent = label;
    b.onclick = () => { el.classList.add('hidden'); fn && fn(); };
    el.appendChild(b);
  }
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 8000);
}
function pollVersion() {
  checkVersion();
  setInterval(checkVersion, 60000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      checkVersion();
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
        navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
      }
    }
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.t === 'SW_PING' && e.source) {
        try { e.source.postMessage({ t: 'SW_PONG', hasUpdater: true }); } catch {}
        checkVersion();
      }
      else if (e.data && e.data.t === 'SW_UPDATED') checkVersion();
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => checkVersion());
  }
}
window.addEventListener('beforeunload', () => {
  try { sessionStorage.setItem('cf_draft', JSON.stringify({ s: S.serverId, c: S.channelId, t: document.querySelector('#in-message') ? document.querySelector('#in-message').value : '' })); } catch {}
});

// ---------- go ----------
setMode('login');
if (store.token) boot();
else showAuth();
