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
  online: new Set(),
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
$('#btn-logout').onclick = async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  leaveVoice();
  S.ws?.close();
  store.token = '';
  location.reload();
};

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
  await refreshServers();
  connectWS();
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
  avatar($('#me-avatar'), S.me.display_name, S.me.avatar_color);
  $('#me-name').textContent = S.me.display_name;
}

// ---------- servers / channels ----------
async function refreshServers(selectId) {
  const { servers } = await api('/api/servers');
  S.servers = servers;
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
function renderServerList() {
  const box = $('#server-list');
  box.innerHTML = '';
  for (const s of S.servers) {
    const b = document.createElement('button');
    b.className = 'server-btn' + (s.id === S.serverId ? ' active' : '');
    b.title = s.name;
    b.textContent = s.name.trim().charAt(0).toUpperCase() || '?';
    b.onclick = () => selectServer(s.id);
    box.appendChild(b);
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
    const b = document.createElement('button');
    b.className = 'chan' + (S.voice && S.voice.channelId === c.id ? ' active' : '');
    b.innerHTML = `<span class="vicon"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16 8a5 5 0 0 1 0 8" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg></span><span>${esc(c.name)}</span>${occ.length ? `<span class="count">${occ.length}</span>` : ''}`;
    b.title = occ.length ? occ.map((p) => p.display_name).join(', ') : 'Join voice';
    b.onclick = () => joinVoice(S.serverId, c.id);
    vc.appendChild(b);
  }
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
    renderMessages();
  } catch { $('#messages').innerHTML = '<p class="error">Could not load messages.</p>'; }
}
function renderMembers() {
  const d = S.serverDetail;
  if (!d) return;
  const box = $('#member-list');
  box.innerHTML = '';
  const online = [...d.members].sort((a, b) => {
    const ao = S.online.has(a.id) ? 0 : 1, bo = S.online.has(b.id) ? 0 : 1;
    return ao - bo || a.display_name.localeCompare(b.display_name);
  });
  $('#online-count').textContent = d.members.filter((m) => S.online.has(m.id)).length;
  for (const m of online) {
    const div = document.createElement('div');
    div.className = 'member' + (S.online.has(m.id) ? '' : ' off');
    div.innerHTML = `<span class="avatar"></span><span>${esc(m.display_name)}${m.role === 'owner' ? ' 👑' : ''}</span><span class="presence ${S.online.has(m.id) ? 'on' : ''}"></span>`;
    avatar(div.querySelector('.avatar'), m.display_name, m.avatar_color);
    box.appendChild(div);
  }
}

// ---------- messages ----------
function renderMessages() {
  const box = $('#messages');
  const msgs = S.messages.get(S.channelId) || [];
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
  box.innerHTML = '';
  let lastDay = '';
  const amOwner = S.serverDetail && S.serverDetail.owner_id === S.me.id;
  for (const m of msgs) {
    const day = fmtDay(m.created_at);
    if (day !== lastDay) { lastDay = day; const d = document.createElement('div'); d.className = 'day'; d.textContent = day; box.appendChild(d); }
    const div = document.createElement('div');
    div.className = 'msg';
    const canDel = m.user && (m.user.id === S.me.id || amOwner);
    div.innerHTML = `
      <span class="avatar"></span>
      <div class="body">
        <div class="head"><span class="who">${esc(m.user ? m.user.display_name : 'deleted')}</span>
        <span class="when">${fmtTime(m.created_at)}</span>${canDel ? '<button class="mini del" title="Delete">✕</button>' : ''}</div>
        <div class="text">${linkify(m.content)}</div>
      </div>`;
    avatar(div.querySelector('.avatar'), m.user ? m.user.display_name : '?', m.user ? m.user.avatar_color : '#555');
    if (canDel) div.querySelector('.del').onclick = async () => {
      try { await api('/api/messages/' + m.id, { method: 'DELETE' }); } catch { toast('Delete failed'); }
    };
    box.appendChild(div);
  }
  if (!msgs.length) box.innerHTML += '<p class="muted" style="text-align:center">No messages yet — say hello.</p>';
  box.scrollTop = box.scrollHeight;
  void nearBottom;
}
let composerCooldown = false;
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const inp = $('#in-message');
  const content = inp.value.trim();
  if (!content || !S.serverId || !S.channelId) return;
  inp.value = '';
  sendChat(content);
});
function sendChat(content) {
  if (S.ws && S.ws.readyState === 1) {
    S.ws.send(JSON.stringify({ t: 'message', serverId: S.serverId, channelId: S.channelId, content }));
  } else {
    // fallback REST (not implemented server-side for POST; use WS) — queue via reload
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
  ws.onopen = () => ws.send(JSON.stringify({ t: 'subscribe' }));
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
    case 'hello': S.me = m.user; break;
    case 'message-new': {
      if (m.serverId !== S.serverId) { refreshServers(); break; }
      const arr = S.messages.get(m.channelId) || [];
      arr.push(m.message);
      S.messages.set(m.channelId, arr);
      if (m.channelId === S.channelId) {
        renderMessages();
        if (document.hidden) notifyMsg(m.message);
      } else {
        toast(`#${chanName(m.channelId)}: ${m.message.user.display_name}: ${m.message.content.slice(0, 60)}`);
      }
      break;
    }
    case 'message-deleted': {
      const arr = (S.messages.get(m.channelId) || []).filter((x) => x.id !== m.messageId);
      S.messages.set(m.channelId, arr);
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
      if (m.serverId === S.serverId) { S.online = new Set(m.online); S.online.add(S.me.id); renderMembers(); }
      break;
    case 'user-online':
      if (m.serverId === S.serverId) { S.online.add(m.userId); renderMembers(); }
      break;
    case 'user-offline':
      if (m.serverId === S.serverId) { S.online.delete(m.userId); renderMembers(); }
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
      if (S.voice && S.voice.serverId === m.serverId && S.voice.channelId === m.channelId) {
        onVoicePeers(m.peers);
      }
      renderVoiceGrid();
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
      renderVoiceGrid();
      break;
    }
    case 'voice-peer-left': {
      closePeer(m.userId);
      renderVoiceGrid();
      break;
    }
    case 'voice-state': {
      const occ = S.voiceOccupancy.get(m.channelId) || [];
      const p = occ.find((x) => x.id === m.userId);
      if (p) p.muted = m.muted;
      renderVoiceGrid();
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
$('#btn-join-voice').onclick = () => {
  const voices = S.serverDetail?.channels.filter((c) => c.type === 'voice') || [];
  if (!voices.length) return toast('No voice rooms yet — create one with ＋');
  joinVoice(S.serverId, voices[0].id);
};
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
  S.voice = { serverId, channelId, stream, pcs: new Map(), muted: false, audioEls: new Map() };
  $('#voice-bar').classList.remove('hidden');
  $('#voice-grid').classList.remove('hidden');
  $('#voice-chan-name').textContent = ch ? ch.name : 'voice';
  $('#btn-mute').textContent = 'Mute';
  S.ws?.send(JSON.stringify({ t: 'voice-join', serverId, channelId }));
  renderChannels();
  renderVoiceGrid();
  startSpeakingMonitor();
  toast('Connected to voice');
}
function leaveVoice(silent) {
  if (!S.voice) return;
  for (const [, pc] of S.voice.pcs) { try { pc.close(); } catch {} }
  S.voice.stream?.getTracks().forEach((t) => t.stop());
  for (const [, el] of S.voice.audioEls) { try { el.remove(); } catch {} }
  const { serverId } = S.voice;
  S.voice = null;
  stopSpeakingMonitor();
  $('#voice-bar').classList.add('hidden');
  const grid = $('#voice-grid');
  grid.classList.add('hidden'); grid.innerHTML = '';
  if (!silent) S.ws?.send(JSON.stringify({ t: 'voice-leave' }));
  renderChannels();
}
function toggleMute() {
  if (!S.voice) return;
  S.voice.muted = !S.voice.muted;
  S.voice.stream.getAudioTracks().forEach((t) => (t.enabled = !S.voice.muted));
  $('#btn-mute').textContent = S.voice.muted ? 'Unmute' : 'Mute';
  S.ws?.send(JSON.stringify({ t: 'voice-state', muted: S.voice.muted }));
  renderVoiceGrid();
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
  renderVoiceGrid();
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
function renderVoiceGrid() {
  const grid = $('#voice-grid');
  if (!S.voice) { grid.classList.add('hidden'); grid.innerHTML = ''; return; }
  const occ = S.voiceOccupancy.get(S.voice.channelId) || [];
  grid.classList.remove('hidden');
  grid.innerHTML = '';
  // include self first
  const tiles = [{ id: S.me.id, display_name: S.me.display_name + ' (you)', avatar_color: S.me.avatar_color, muted: S.voice.muted }, ...occ.filter((p) => p.id !== S.me.id)];
  for (const p of tiles) {
    const d = document.createElement('div');
    d.className = 'vtile';
    d.id = 'vt-' + p.id;
    d.innerHTML = `<span class="avatar"></span><span>${esc(p.display_name)}</span>${p.muted ? '<span class="muted-tag">muted</span>' : ''}`;
    avatar(d.querySelector('.avatar'), p.display_name, p.avatar_color);
    grid.appendChild(d);
  }
  const joinBtn = $('#btn-join-voice');
  joinBtn.classList.add('hidden');
}
// speaking indicator (local mic level → green ring on own tile)
let speakTimer = null, speakCtx = null;
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
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const loud = Math.sqrt(sum / buf.length) > (S.voice?.muted ? 99 : 0.08);
      document.getElementById('vt-' + S.me.id)?.classList.toggle('speaking', loud);
    }, 200);
  } catch {}
}
function stopSpeakingMonitor() {
  clearInterval(speakTimer); speakTimer = null;
  try { speakCtx?.close(); } catch {}
  speakCtx = null;
}
window.addEventListener('beforeunload', () => { try { S.ws?.send(JSON.stringify({ t: 'voice-leave' })); } catch {} });

// ---------- go ----------
setMode('login');
if (store.token) boot();
else showAuth();
