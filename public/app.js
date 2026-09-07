/* Campfire client — vanilla SPA + WebSocket + WebRTC mesh + PWA */
'use strict';
const $ = (s) => document.querySelector(s);
const apiBase = '';

const store = {
  get token() { return localStorage.getItem('cf_token') || ''; },
  set token(v) { v ? localStorage.setItem('cf_token', v) : localStorage.removeItem('cf_token'); },
  get sid() { return localStorage.getItem('cf_sid') || ''; },
  set sid(v) { v ? localStorage.setItem('cf_sid', v) : localStorage.removeItem('cf_sid'); },
};
const isCoarse = () => window.matchMedia && matchMedia('(hover: none)').matches;

const S = {
  me: null,
  servers: [],
  serverId: null,
  channelId: null,
  serverDetail: null, // {channels, members, ...}
  messages: new Map(), // channelId -> [msgs]
  online: {}, // userId -> status ('online'|'away'|'dnd'); absent = offline/invisible
  presenceAll: {}, // userId -> last-seen live status across ALL shared servers (feeds DM member list)
  emoji: {}, // custom server emoji name -> url
  replyTo: null, // message being replied to
  pendingAtts: [], // uploaded attachments awaiting send
  thread: null, // {rootId, channelId, root, replies[]}
  histMode: null, // {kind:'server'|'dm', id, serverId?} — viewing older (jump-to-pin) context
  histNew: 0, // live arrivals while viewing history (drives the jump pill)
  pinIds: new Set(), // pinned message ids in the current channel/thread
  pinCount: 0,
  pinsCtx: null, // context the pins popup is open for
  editing: null, // message id being edited
  layoutFolders: [], // [{id,name,color,open,position,servers:[serverIds]}]
  serverMeta: new Map(), // serverId -> {folderId, position}
  rootOrder: [], // [{kind:'server'|'folder', id}] rail order top-to-bottom
  view: 'server', // 'server' | 'home'
  dms: [], friends: { friends: [], pendingIn: [], pendingOut: [], blocked: [] },
  friendTab: 'all', // friends sidebar tab: 'online' | 'all' | 'pending' | 'blocked'
  dmThreadId: null, dmMessages: new Map(), // threadId -> [msgs]
  dmUnread: new Map(), // threadId -> unread DM count (drives DM row + home button badges)
  voiceOccupancy: new Map(), // channelId -> [peers]
  voiceSince: new Map(), // channelId -> epoch ms first seen occupied (drives room timers)
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
  return (S.serverDetail?.members || []).find((m) => m.username === un)
    || (S.dmThreadId ? ((S.dms.find((t) => t.id === S.dmThreadId) || {}).members || []).find((m) => m.username === un) : null) || null;
}
function memberById(id) {
  if (S.me && S.me.id === id) return S.me;
  return (S.serverDetail?.members || []).find((m) => m.id === id)
    || (S.dms.find((t) => t.id === S.dmThreadId)?.members || []).find((m) => m.id === id)
    || [...S.friends.friends, ...S.friends.pendingIn, ...S.friends.pendingOut, ...(S.friends.blocked || [])].find((m) => m.id === id)
    || null;
}
// Escape + code/bold/italic/strike + custom emoji + @mentions + links.
function renderRich(text, opts = {}) {
  let h = esc(text);
  const codes = [];
  h = h.replace(/`([^`\n]+)`/g, (m, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  h = h.replace(/\|\|(.+?)\|\|/gs, (m, inner) => '<span class="spoiler">' + inner + '</span>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
       .replace(/(^|[\s(])\*([^\*\n]+)\*/g, '$1<em>$2</em>')
       .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  if (!opts.plain) {
  h = h.replace(/:([a-z0-9_+-]{2,32}):/g, (m, n) => S.emoji[n]
    ? '<img class="cemoi" src="' + S.emoji[n] + '" alt="' + m + '" title="' + m + '" data-fb-emoji="' + m + '">' : m);
  h = h.replace(/(^|[\s(])@([A-Za-z0-9_.]{2,24})/g, (m, pre, un) => {
    const mem = memberByUsername(un);
    if (!mem) return m;
    return pre + '<span class="mention' + (mem.id === S.me.id ? ' me' : '') + '" data-uid="' + mem.id + '">@' + esc(mem.display_name) + '</span>';
  });
  }
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
// Cloudflare Turnstile: site key comes from /api/config (public); the widget
// is explicitly rendered once the key is known. Tokens are single-use, so
// the widget resets after every submit attempt.
S.turnstileKey = null; S.tsWidget = undefined;
// Renders the widget as soon as BOTH the site key (from /api/config) and the
// Turnstile API are ready, regardless of which arrives first. On cold first
// loads the async API script routinely lands after our config fetch, so
// rendering only from initTurnstile() left the widget permanently missing.
function renderTurnstile() {
  if (!S.turnstileKey || !window.turnstile || S.tsWidget !== undefined) return;
  const slot = document.querySelector('#ts-widget');
  if (!slot) return;
  try {
    slot.innerHTML = '';
    S.tsWidget = turnstile.render(slot, { sitekey: S.turnstileKey, theme: 'dark' });
  } catch { S.tsWidget = undefined; }
}
// Named in index.html (?onload=cfTurnstileReady): fires when the API script
// finishes loading. Assigned here so it exists before the async script runs.
window.cfTurnstileReady = () => renderTurnstile();
async function initTurnstile() {
  try {
    const cfg = await api('/api/config');
    if (!cfg || !cfg.turnstileSiteKey) return;
    S.turnstileKey = cfg.turnstileSiteKey;
    $('#ts-wrap').classList.remove('hidden');
    renderTurnstile();
  } catch {}
}
function turnstileToken() {
  try { return (window.turnstile && S.tsWidget !== undefined) ? turnstile.getResponse(S.tsWidget) : ''; }
  catch { return ''; }
}
function turnstileReset() {
  try { if (window.turnstile && S.tsWidget !== undefined) turnstile.reset(S.tsWidget); } catch {}
}
function authError(msg) {
  const el = $('#auth-error');
  el.textContent = '⚠️ ' + msg;
  el.classList.remove('hidden');
}
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
  if (S.turnstileKey) {
    if (!window.turnstile || S.tsWidget === undefined) { authError('Captcha still loading — wait a moment and try again.'); return; }
    if (!turnstileToken()) { authError('Complete the captcha to continue.'); return; }
  }
  try {
    const data = mode === 'login'
      ? await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password, turnstile: turnstileToken(), device: deviceName() }) })
      : await api('/api/register', { method: 'POST', body: JSON.stringify({ username, password, displayName, turnstile: turnstileToken(), device: deviceName() }) });
    if (data.need2fa) { pending2faTmp = data.tmp; show2faStep(); return; }
    store.token = data.token;
    if (data.sid) store.sid = data.sid;
    await boot();
  } catch (err) {
    const el = $('#auth-error');
    el.textContent = '⚠️ ' + prettyError(err.message);
    el.classList.remove('hidden');
  } finally {
    turnstileReset();
  }
});
function prettyError(e) {
  const map = {
    invalid_login: 'Wrong username or password.', username_taken: 'That username is taken.',
    bad_username: 'Username needs 2–24 chars (a-z, 0-9, _ .).', bad_invite: 'Invite code not found.',
    slow_down: 'Slow down — you\'re sending too fast.', owner_only: 'Only the server owner can do that.', banned: 'You are banned from this server.', slow_mode: 'Slow mode is on — wait a moment.',
    captcha_required: 'Complete the captcha to continue.', captcha_failed: 'Captcha check failed — please try again.',
    bad_color: 'Pick a valid color.', cannot_kick_admin: 'Only the owner can remove admins.',
  };
  return map[e] || e.replace(/_/g, ' ');
}
async function doLogout() {
  try { await pushTeardown(); } catch {}
  try { await api('/api/sessions/current', { method: 'DELETE' }); } catch {}
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  try { leaveVoice(true); } catch {}
  try { S.ws?.close(); } catch {}
  store.token = '';
  store.sid = '';
  location.reload();
}

function stashInvite(code) { try { if (code) sessionStorage.setItem('cf_invite', code); } catch {} }
function takeInvite() { try { const p = sessionStorage.getItem('cf_invite'); if (p) sessionStorage.removeItem('cf_invite'); return p || null; } catch { return null; } }
// Invite codes arrive as /invite/CODE (pretty links) or legacy ?invite=CODE.
// Reads + cleans the URL (other query params are preserved).
function consumeInvite() {
  const u = new URL(location.href);
  let code = null;
  const pm = u.pathname.match(/^\/invite\/([\w-]+)\/?$/);
  if (pm) { code = pm[1]; u.pathname = '/'; }
  else if (u.searchParams.get('invite')) { code = u.searchParams.get('invite'); u.searchParams.delete('invite'); }
  if (code) { try { history.replaceState(null, '', u.pathname + u.search + u.hash); } catch {} }
  return code;
}
// ---------- boot ----------
async function boot() {
  try {
    const cfg = await api('/api/config').catch(() => null);
    if (cfg?.iceServers?.length) S.iceServers = cfg.iceServers;
    const { user } = await api('/api/me');
    S.me = user;
  } catch {
    const inv0 = consumeInvite();
    if (inv0) stashInvite(inv0);
    showAuth();
    if (inv0) showInviteLanding(inv0);
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
  pushSetup();
  refreshNotifBadge();
  // Prefetch DMs + friends so the home button badge (unread DMs, incoming
  // requests) is live even before Home is opened this session.
  refreshDms().catch(() => {});
  ensureFriends().catch(() => {});
  // Warm the per-user notification prefs so channel/server right-click menus
  // and muted indicators are correct from the start.
  refreshNotifPrefs().then(() => { renderServerList(); renderChannels(); }).catch(() => {});
  // invite landing (/invite/CODE or ?invite=CODE)
  const inv = consumeInvite();
  if (inv) {
    stashInvite(inv);
    showInviteLanding(inv);
  } else {
    const pending = takeInvite();
    if (pending) showInviteLanding(pending);
  }
  // deep links from push notifications (?server=ID&channel=ID, ?dm=ID)
  try {
    const qs = new URLSearchParams(location.search);
    const qdm = qs.get('dm'), qserv = qs.get('server'), qchan = qs.get('channel');
    if (qdm || qserv) history.replaceState(null, '', location.pathname);
    if (qdm) {
      await openHome();
      if (S.dms.some((t) => t.id === qdm)) selectDmThread(qdm);
      else {
        // dismissed (hidden) thread from a notification link — reopen it
        try {
          const { thread } = await api(`/api/dms/${qdm}/open`, { method: 'POST' });
          await refreshDms();
          selectDmThread(thread.id);
        } catch {}
      }
    } else if (qserv && S.servers.some((s) => s.id === qserv)) {
      await selectServer(qserv);
      if (S.serverDetail?.channels.some((c) => c.id === qchan && c.type === 'text')) await selectChannel(qchan);
    }
  } catch {}
}
function showAuth() {
  $('#boot-splash')?.classList.add('hidden');
  $('#view-auth').classList.remove('hidden');
  $('#view-main').classList.add('hidden');
}
function showMain() {
  $('#boot-splash')?.classList.add('hidden');
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
    // No auto-popping Servers dialog on first login/signup — land on Home
    // (friends + DMs); the rail + button is there when they want a server.
    await openHome();
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
  b.className = 'server-btn' + (s.id === S.serverId ? ' active' : '') + (s.icon_url ? ' has-icon' : '') + (serverMuted(s.id) ? ' muted' : '');
  b.title = s.name;
  b.draggable = true;
  b.dataset.drag = 'server:' + s.id;
  b.dataset.sid = s.id;
  if (s.icon_url) {
    // Explicit <img> with every property inline: renders identically no matter
    // what state any stylesheet is in (opaque + fully covering, so no
    // background rule can affect it). Broken URLs fall back to the letter.
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
function folderGrid(kids) {
  // Shrink-wrapped centered rows: big dark previews, symmetric blue all
  // around — no edge-to-edge bands to read as cut off.
  const shown = kids.slice(0, 4);
  if (!shown.length) return '';
  const cell = (s) => {
    const label = (s.name || '?').trim().charAt(0).toUpperCase() || '?';
    return s.icon_url
      ? `<span class="fic"><img src="${esc(s.icon_url)}" alt="" loading="lazy" draggable="false" data-fb-letter="${esc(label)}" /></span>`
      : `<span class="fic">${esc(label)}</span>`;
  };
  if (shown.length === 1) return `<span class="fgrid n1"><span class="frow">${cell(shown[0])}</span></span>`;
  const rows = [];
  for (let i = 0; i < shown.length; i += 2) rows.push(`<span class="frow">${shown.slice(i, i + 2).map(cell).join('')}</span>`);
  return `<span class="fgrid n${shown.length}">${rows.join('')}</span>`;
}
function folderEl(f, kids) {
  const wrap = document.createElement('div');
  wrap.className = 'folder-wrap' + (f.open ? ' open' : '');
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center';
  const b = document.createElement('button');
  b.className = 'server-btn folder-btn' + (f.open ? ' open' : '');
  b.style.background = f.color;
  b.title = f.name;
  b.draggable = true;
  b.dataset.drag = 'folder:' + f.id;
  b.dataset.fid = f.id;
  b.innerHTML = folderGrid(kids);
  if (kids.some((k) => k.id === S.serverId)) b.style.outline = '2px solid #ffffff88';
  b.onclick = () => { f.open = !f.open; saveLayout(); renderServerList(); };
  // NOTE: no dblclick-to-rename here — a quick expand+collapse reads as a
  // double click and would pop the rename box by accident. Rename lives in
  // the folder's right-click menu.
  b.oncontextmenu = (e) => { e.preventDefault(); openFolderMenu(f.id, e.clientX, e.clientY); };
  wireDrag(b, 'folder', f.id);
  wrap.appendChild(b);
  if (f.open) {
    const kidsBox = document.createElement('div');
    kidsBox.className = 'folder-children';
    // Open folder + dropdown read as one piece: the wash lives on the wrap
    // so it encapsulates the folder button too (Discord-style).
    if (/^#[0-9a-fA-F]{6}$/.test(f.color || '')) {
      wrap.style.background = f.color + '33';
    }
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
    if (S.rootOrder.some((it) => it.kind === 'server' && it.id === s.id)) continue;
    // Servers living inside a folder render under that folder only — without
    // this they would duplicate at the bottom of the rail.
    if (S.layoutFolders.some((f) => (f.servers || []).includes(s.id))) continue;
    box.appendChild(serverBtn(s));
  }
}
async function selectServer(id) {
  openServerView();
  S.serverId = id;
  S.channelId = null;
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
  b.draggable = true;
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
  const div = document.createElement('div');
  div.className = 'member' + (st === 'offline' ? ' off' : '');
  div.dataset.uid = m.id;
  if (m.sidebar_banner_url && st !== 'offline') {
    div.style.backgroundImage = `linear-gradient(rgba(0,0,0,.45),rgba(0,0,0,.45)),linear-gradient(90deg, var(--panel) 5%, rgba(0,0,0,0) 78%), url("${m.sidebar_banner_url}")`;
    div.style.backgroundSize = 'cover';
    div.style.backgroundPosition = 'right center';
  }
  div.innerHTML = `<span class="avatar"></span><span class="mnames"><span style="${nameStyleFor(m)}">${esc(m.display_name)}${m.role === 'owner' ? ' ★' : ''}</span>${m.status_text && st !== 'offline' ? `<span class="mstatus" title="${esc(m.status_text)}">${esc(m.status_text)}</span>` : ''}</span><span class="status-dot ${st}"></span>`;
  paintAvatar(div.querySelector('.avatar'), m);
  return div;
}
function memberSort(a, b) {
  const ao = statusOf(a.id) === 'offline' ? 1 : 0, bo = statusOf(b.id) === 'offline' ? 1 : 0;
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
  const on = rest.filter((m) => statusOf(m.id) !== 'offline').sort(memberSort);
  const off = rest.filter((m) => statusOf(m.id) === 'offline').sort(memberSort);
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
  const sorted = [...members].sort(memberSort);
  $('#online-count').textContent = members.filter((m) => statusOf(m.id) !== 'offline').length;
  for (const m of sorted) box.appendChild(memberRowEl(m));
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
// ---------- messages ----------
function canMod(m) {
  if (!m.user) return false;
  if (S.view === 'home') return m.user.id === S.me.id;
  return m.user.id === S.me.id || (S.view === 'server' && canManage());
}
function msgById(id) {
  for (const [, arr] of S.messages) { const f = arr.find((x) => x.id === id); if (f) return f; }
  if (S.thread) {
    if (S.thread.root?.id === id) return S.thread.root;
    const f = S.thread.replies.find((x) => x.id === id); if (f) return f;
  }
  for (const [, arr] of S.dmMessages) { const f = arr.find((x) => x.id === id); if (f) return f; }
  return null;
}
function updateMsgInCaches(mid, fn) {
  for (const [, arr] of S.messages) { const i = arr.findIndex((x) => x.id === mid); if (i >= 0) fn(arr[i]); }
  if (S.thread) {
    if (S.thread.root?.id === mid) fn(S.thread.root);
    const r = S.thread.replies.find((x) => x.id === mid); if (r) fn(r);
  }
  for (const [, arr] of S.dmMessages) { const i = arr.findIndex((x) => x.id === mid); if (i >= 0) fn(arr[i]); }
}
const DL_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>';
function attDl(a) { return `<a class="att-dl" href="${esc(a.url)}" download="${esc(a.name)}" target="_blank" rel="noopener" title="Download">${DL_ICON}</a>`; }
function attachmentHTML(a) {
  if (a.kind === 'image') return `<span class="att-wrap${a.spoiler ? ' spoiler' : ''}"><img class="att-img" src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy" data-fb-name="${esc(a.name)}" data-fb-url="${esc(a.url)}" />${attDl(a)}${a.spoiler ? '<button type="button" class="spoiler-veil">Spoiler</button>' : ''}</span>`;
  if (a.kind === 'video') return `<span class="att-wrap${a.spoiler ? ' spoiler' : ''}"><video class="att-vid" src="${esc(a.url)}" controls preload="metadata"></video>${attDl(a)}${a.spoiler ? '<button type="button" class="spoiler-veil">Spoiler</button>' : ''}</span>`;
  if (a.kind === 'audio') return audioPlayerHTML(a);
  if (textPreviewable(a)) return textFileHTML(a);
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
// ---------- text/code file previews (expandable + downloadable) ----------
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'json', 'py', 'pyw', 'rb', 'java', 'c', 'h', 'hpp', 'cpp', 'cc', 'cs', 'go', 'rs', 'php', 'swift', 'kt', 'kts', 'scala', 'sh', 'bash', 'zsh', 'sql', 'html', 'htm', 'css', 'scss', 'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'csv', 'tsv', 'log', 'diff', 'patch', 'vue', 'svelte', 'lua', 'dart']);
const TEXT_MIMES = new Set(['application/json', 'application/javascript', 'application/xml', 'application/x-sh']);
function textPreviewable(a) {
  if (!a || (a.size || 0) > 256 * 1024) return false;
  if (/^text\//.test(a.mime || '') || TEXT_MIMES.has(a.mime)) return true;
  const parts = String(a.name || '').split('.');
  return parts.length > 1 && TEXT_EXTS.has(parts.pop().toLowerCase());
}
const txtCache = new Map(); // url -> {status, text, preview, truncated}
function textFileHTML(a) {
  queueTextPreview(a.url);
  const c = txtCache.get(a.url);
  const prev = c && c.status === 'ready'
    ? (c.preview || '(empty file)')
    : (c && c.status === 'err' ? 'Preview unavailable — download to view.' : 'Loading preview…');
  return `<div class="txtfile" data-turl="${esc(a.url)}" data-tname="${esc(a.name)}">`
    + `<div class="txt-head"><span class="txt-ic">&lt;/&gt;</span><span class="txt-name">${esc(a.name)}</span><span class="txt-size">${fmtSize(a.size)}</span><span class="spacer"></span>${attDl(a)}</div>`
    + `<pre class="txt-prev">${esc(prev)}</pre>`
    + `<button type="button" class="mini" data-act="expand-file">Expand</button></div>`;
}
function queueTextPreview(url) {
  if (!url || txtCache.has(url)) { paintTextPreviews(url); return; }
  txtCache.set(url, { status: 'loading' });
  fetch(url).then((r) => { if (!r.ok) throw 0; return r.text(); }).then((t) => {
    const preview = t.split('\n').slice(0, 12).join('\n').slice(0, 1200);
    txtCache.set(url, { status: 'ready', text: t, preview, truncated: t.length > preview.length });
    paintTextPreviews(url);
  }).catch(() => { txtCache.set(url, { status: 'err' }); paintTextPreviews(url); });
}
function paintTextPreviews(url) {
  if (!url) return;
  const c = txtCache.get(url);
  document.querySelectorAll('.txtfile').forEach((card) => {
    if (card.dataset.turl !== url) return;
    const el = card.querySelector('.txt-prev');
    if (!el) return;
    el.textContent = !c || c.status === 'loading' ? 'Loading preview…' : c.status === 'ready' ? (c.preview || '(empty file)') : 'Preview unavailable — download to view.';
  });
}
async function expandTextFile(el) {
  const card = el.closest ? el.closest('.txtfile') : null;
  const url = card && card.dataset.turl, name = (card && card.dataset.tname) || 'file';
  if (!url) return;
  let c = txtCache.get(url);
  if (!c || c.status !== 'ready') {
    try {
      const r = await fetch(url);
      if (!r.ok) throw 0;
      c = { status: 'ready', text: await r.text(), preview: '', truncated: false };
      txtCache.set(url, c);
      paintTextPreviews(url);
    } catch { toast('Could not load file'); return; }
  }
  openModal(name, `<pre class="txt-full">${esc(c.text)}</pre><div class="row" style="margin-top:.6rem"><a class="btn small primary" href="${esc(url)}" download="${esc(name)}">Download</a><button type="button" class="btn small" id="m-copy-txt">Copy</button></div>`, 'Close', null, { wide: true });
  const cp = $('#m-copy-txt');
  if (cp) cp.onclick = () => { try { navigator.clipboard.writeText(c.text); toast('Copied'); } catch {} };
}
function fmtClock(s) {
  s = Math.max(0, Math.floor(s || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
// ---------- voice/audio player (one shared look for every audio embed) ----------
let vpSeq = 0;
const VP_BARS = 36;
function audioPlayerHTML(a) {
  const tag = 'vp' + (++vpSeq).toString(36) + Date.now().toString(36).slice(-3);
  return `<div class="vplayer" data-vp="${tag}" data-url="${esc(a.url)}" data-size="${a.size || 0}">`
    + `<button type="button" class="vp-play" data-vp-toggle title="Play"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path class="vp-ic-play" d="M8 5v14l11-7z"/><path class="vp-ic-pause" d="M7 5h4v14H7zM13 5h4v14h-4z" style="display:none"/></svg></button>`
    + `<audio src="${esc(a.url)}" preload="metadata"></audio>`
    + `<div class="vp-body"><div class="vp-bars" data-vp-seek>${'<i></i>'.repeat(VP_BARS)}</div>`
    + `<div class="vp-meta"><span data-vp-cur>0:00</span><span class="vp-dur">…</span></div></div>`
    + attDl(a) + `</div>`;
}
function vpAudio(root) { return root ? root.querySelector('audio') : null; }
function vpPaint(root) {
  const audio = vpAudio(root);
  if (!audio) return;
  const dur = audio.duration || 0, cur = audio.currentTime || 0;
  const ratio = dur > 0 ? Math.min(1, cur / dur) : 0;
  const bars = root.querySelectorAll('.vp-bars i');
  const n = Math.round(ratio * bars.length);
  bars.forEach((b, i) => b.classList.toggle('on', i < n));
  const ce = root.querySelector('[data-vp-cur]');
  if (ce) ce.textContent = fmtClock(cur);
  const playing = !audio.paused && !audio.ended;
  const play = root.querySelector('.vp-ic-play'), pause = root.querySelector('.vp-ic-pause');
  if (play) play.style.display = playing ? 'none' : '';
  if (pause) pause.style.display = playing ? '' : 'none';
  const tg = root.querySelector('[data-vp-toggle]');
  if (tg) tg.title = playing ? 'Pause' : 'Play';
}
// Real waveform peaks, decoded lazily once the clip's metadata is in.
// Big files skip decoding and keep the flat segmented track.
let vpAC = null;
async function paintPeaks(root, audio) {
  if (!root || root.dataset.peaks) return;
  const size = parseInt(root.dataset.size || '0', 10) || 0;
  if (size > 25 * 1024 * 1024) return;
  root.dataset.peaks = '1';
  try {
    if (!vpAC) vpAC = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await (await fetch(audio.currentSrc || audio.src)).arrayBuffer();
    const dec = await vpAC.decodeAudioData(buf);
    if (!dec || !dec.length) return;
    const ch = dec.getChannelData(0);
    const out = new Array(VP_BARS).fill(0);
    const per = Math.max(1, Math.floor(ch.length / VP_BARS));
    for (let i = 0; i < VP_BARS; i++) {
      let m = 0;
      const s = i * per;
      for (let j = s; j < Math.min(s + per, ch.length); j += 11) { const v = Math.abs(ch[j]); if (v > m) m = v; }
      out[i] = m;
    }
    const mx = Math.max(...out, 0.02);
    root.querySelectorAll('.vp-bars i').forEach((b, i) => { b.style.height = Math.max(14, Math.round((out[i] / mx) * 100)) + '%'; });
  } catch { delete root.dataset.peaks; }
}
document.addEventListener('click', (e) => {
  const tg = e.target.closest('[data-vp-toggle]');
  const sk = e.target.closest('[data-vp-seek]');
  if (tg) {
    const root = tg.closest('.vplayer'), audio = vpAudio(root);
    if (!audio) return;
    if (audio.paused) {
      // one clip at a time: stop anything else playing first
      document.querySelectorAll('.vplayer audio').forEach((o) => { if (o !== audio && !o.paused) o.pause(); });
      audio.play().catch(() => {});
    } else audio.pause();
    return;
  }
  if (sk) {
    const root = sk.closest('.vplayer'), audio = vpAudio(root);
    if (audio && audio.duration) {
      const r = sk.getBoundingClientRect();
      audio.currentTime = Math.min(0.999, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width))) * audio.duration;
      vpPaint(root);
    }
    return;
  }
});
['play', 'pause', 'timeupdate', 'ended'].forEach((ev) => document.addEventListener(ev, (e) => {
  const t = e.target;
  if (t && t.tagName === 'AUDIO' && t.closest) {
    const root = t.closest('.vplayer');
    if (root) vpPaint(root);
  }
}, true));
document.addEventListener('loadedmetadata', (e) => {
  const t = e.target;
  if (!t || t.tagName !== 'AUDIO' || !t.closest) return;
  const root = t.closest('.vplayer');
  if (!root) return;
  const de = root.querySelector('.vp-dur');
  if (de && isFinite(t.duration)) de.textContent = fmtClock(t.duration);
  vpPaint(root);
  paintPeaks(root, t);
}, true);
// ---------- polls ----------
function pollHTML(m) {
  const p = m.poll;
  if (!p) return '';
  const total = p.total || 0;
  const opts = (p.options || []).map((o) => {
    const mine = !!(S.me && (o.voters || []).includes(S.me.id));
    const pct = total ? Math.round(((o.votes || 0) / total) * 100) : 0;
    return `<button type="button" class="poll-opt${mine ? ' voted' : ''}" data-act="vote" data-opt="${o.id}" title="${o.votes || 0} vote${(o.votes || 0) === 1 ? '' : 's'}">`
      + `<span class="poll-fill" style="width:${pct}%"></span>`
      + `<span class="poll-label">${esc(o.label)}</span>`
      + `<span class="poll-meta">${mine ? '✓ ' : ''}${o.votes || 0} · ${pct}%</span></button>`;
  }).join('');
  return `<div class="poll" data-poll="${p.id}"><div class="poll-opts">${opts}</div>`
    + `<div class="poll-foot">${total} vote${total === 1 ? '' : 's'} · tap an option to vote</div></div>`;
}
async function votePoll(mid, optionId) {
  const m = msgById(mid);
  const pid = m && m.poll && m.poll.id;
  if (!pid || !optionId) return;
  try { await api(`/api/polls/${pid}/vote`, { method: 'POST', body: JSON.stringify({ optionId }) }); }
  catch (err) { toast(prettyError(err.message)); }
}
function messageEl(m, opts = {}) {
  const div = document.createElement('div');
  if (m.sys) {
    div.className = 'msg sys';
    div.dataset.mid = m.id;
    div.textContent = m.content;
    return div;
  }
  div.className = 'msg';
  div.dataset.mid = m.id;
  const own = m.user && m.user.id === S.me.id;
  const lu = liveUserFor(m.user);
  let inner = '<span class="avatar" data-uid="' + (m.user ? m.user.id : '') + '"></span><div class="body">';
  inner += `<div class="head"><span class="who" data-uid="${m.user ? m.user.id : ''}" style="${nameStyleFor(lu)}">${esc(lu ? lu.display_name : 'deleted')}</span><span class="when">${fmtTime(m.created_at)}</span>${m.edited ? '<span class="edited">(edited)</span>' : ''}</div>`;
  if (m.fwdFrom) {
    inner += `<div class="fwd-tag">Forwarded from <b>${esc(m.fwdFrom)}</b></div>`;
  }
  if (m.replyTo) {
    inner += `<div class="reply-quote" data-jump="${m.replyTo.id}"><span class="rq-author">${esc(m.replyTo.author)}</span><span class="rq-text">${esc(m.replyTo.snippet)}</span></div>`;
  }
  if (S.editing === m.id) {
    inner += `<div class="edit-box"><textarea id="edit-area" maxlength="5000">${esc(m.content)}</textarea><div class="row"><button class="btn small primary" data-act="edit-save">Save</button><button class="btn small" data-act="edit-cancel">Cancel</button></div></div>`;
  } else if (m.content) {
    const big = isBigEmoji(m.content) && !m.attachments?.length;
    inner += `<div class="text${big ? ' bigemoji' : ''}">${renderRich(m.content)}</div>`;
    if (!big && typeof linkEmbedsHTML === 'function') inner += linkEmbedsHTML(m.content);
  }
  if (m.attachments?.length) {
    inner += '<div class="msg-atts">' + m.attachments.map(attachmentHTML).join('') + '</div>';
  }
  if (m.poll) inner += pollHTML(m);
  inner += reactionsHTML(m);
  if (!opts.inThread && !m.threadRoot && m.threadCount > 0) {
    inner += `<button class="thread-link" data-act="thread">${m.threadCount} ${m.threadCount === 1 ? 'reply' : 'replies'} →</button>`;
  }
  inner += '</div>';
  // hover bar: most-used emoji + more + reply + overflow menu
  let bar = topReactions().map((e) => {
    const label = (e.startsWith(':') && e.endsWith(':') && S.emoji[e.slice(1, -1)])
      ? `<img class="cemoi" src="${S.emoji[e.slice(1, -1)]}" alt="${esc(e)}">` : esc(e);
    return `<button data-act="react" data-emoji="${esc(e)}" title="${esc(e)}">${label}</button>`;
  }).join('');
  bar += `<button data-act="more" title="More reactions">➕</button><button data-act="reply" title="Reply">↩</button><button data-act="menu" title="More actions">⋯</button>`;
  inner += '<div class="msg-actions">' + bar + '</div>';
  div.innerHTML = inner;
  paintAvatar(div.querySelector('.avatar'), lu);
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
  updatePill();
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
    if (a.kind === 'image' || a.kind === 'video') {
      const sp = document.createElement('button');
      sp.type = 'button'; sp.className = 'mini' + (a.spoiler ? ' on' : ''); sp.textContent = 'Spoiler'; sp.title = 'Mark as spoiler';
      sp.onclick = () => { a.spoiler = !a.spoiler; renderComposerMeta(); };
      chip.appendChild(sp);
    }
    chip.appendChild(x); box.appendChild(chip);
  });
  syncComposerRender();
}
async function uploadAndAttach(file) {
  if (!file) return;
  if (file.size > 100 * 1024 * 1024) { toast('File too big (max 100MB)'); return; }
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
function composerTargetReady() {
  return S.view === 'home' ? !!S.dmThreadId : !!(S.serverId && S.channelId);
}
document.addEventListener('paste', (e) => {
  const cd = e.clipboardData;
  if (!cd) return;
  const files = [...(cd.files || [])];
  if (files.length) {
    // screenshots / images / video pasted anywhere go straight to the composer
    e.preventDefault();
    if (!composerTargetReady()) { toast('Pick a chat first, then paste'); return; }
    files.slice(0, 5).forEach((f) => uploadAndAttach(f));
    $('#in-message').focus();
    return;
  }
  const t = e.target;
  if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
  // plain text pasted while the window (not a field) is focused → drop it in the composer
  let text = '';
  try { text = cd.getData('text/plain'); } catch {}
  if (text) {
    if (!composerTargetReady()) return;
    e.preventDefault();
    $('#in-message').focus();
    insertAtCursor($('#in-message'), text);
  }
});
// drag-and-drop files anywhere over the chat → composer attachments
let dropDepth = 0;
const dragHasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
$('#chat').addEventListener('dragenter', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dropDepth++;
  $('#chat').classList.add('dropping');
});
$('#chat').addEventListener('dragover', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
$('#chat').addEventListener('dragleave', (e) => {
  if (!dragHasFiles(e)) return;
  if (--dropDepth <= 0) { dropDepth = 0; $('#chat').classList.remove('dropping'); }
});
$('#chat').addEventListener('drop', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dropDepth = 0;
  $('#chat').classList.remove('dropping');
  const files = [...(e.dataTransfer.files || [])];
  if (!files.length) return;
  if (!composerTargetReady()) { toast('Pick a chat first, then drop'); return; }
  files.slice(0, 5).forEach((f) => uploadAndAttach(f));
  $('#in-message').focus();
});
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const inp = $('#in-message');
  const content = inp.value.trim();
  inp.value = '';
  hideMentionPop();
  if (S.view === 'home') {
    if ((!content && !S.pendingAtts.length) || !S.dmThreadId) { inp.value = content; return; }
    sendDm(content, { attachments: S.pendingAtts, replyTo: S.replyTo?.id || null });
  } else {
    if ((!content && !S.pendingAtts.length) || !S.serverId || !S.channelId) { inp.value = content; return; }
    sendChat(content, { attachments: S.pendingAtts, replyTo: S.replyTo?.id || null });
  }
  S.pendingAtts = []; S.replyTo = null;
  renderComposerMeta();
  syncComposerRender();
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
    if (S.view === 'home' && S.dmThreadId) S.ws.send(JSON.stringify({ t: 'dm-typing', threadId: S.dmThreadId }));
    else S.ws.send(JSON.stringify({ t: 'typing', serverId: S.serverId, channelId: S.channelId }));
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
        const inHist = S.histMode && S.histMode.kind === 'server' && S.histMode.id === m.channelId;
        if (inHist) {
          // viewing older messages: hold the window, count up the jump pill
          if (!msg.sys) {
            S.histNew++;
            updatePill();
            if (!dnd) sfx.msg();
            if (document.hidden && !dnd) notifyMsg(msg);
          }
          break;
        }
        const arr = S.messages.get(m.channelId) || [];
        arr.push(msg);
        S.messages.set(m.channelId, arr);
        if (m.channelId === S.channelId) {
          renderMessages();
          if (!msg.sys && document.hidden && !dnd) notifyMsg(msg);
          else if (!msg.sys && !document.hidden && !dnd && mentionsMe(msg)) sfx.msg();
        } else if (!msg.sys && !dnd) {
          sfx.msg();
        }
      }
      break;
    }
    case 'message-updated': {
      updateMsgInCaches(m.message.id, (old) => Object.assign(old, m.message));
      const inHistUp = S.histMode && S.histMode.kind === 'server' && S.histMode.id === m.channelId;
      if (m.channelId === S.channelId && !inHistUp) renderMessages();
      if (S.thread && (S.thread.rootId === m.message.id || S.thread.replies.some((r) => r.id === m.message.id))) renderThread();
      break;
    }
    case 'reaction-update': {
      updateMsgInCaches(m.messageId, (old) => {
        old.reactions = (m.reactions || []).map((r) => ({ emoji: r.emoji, count: r.count, me: (r.users || []).includes(S.me.id) }));
      });
      const inHistRx = S.histMode && S.histMode.kind === 'server' && S.histMode.id === m.channelId;
      if (m.channelId === S.channelId && !inHistRx) renderMessages();
      break;
    }
    case 'message-deleted': {
      const arr = (S.messages.get(m.channelId) || []).filter((x) => x.id !== m.messageId);
      S.messages.set(m.channelId, arr);
      // A deleted reply drops the root's live reply count (drives the N-replies link).
      if (m.threadRoot) updateMsgInCaches(m.threadRoot, (r) => { r.threadCount = Math.max(0, (r.threadCount || 1) - 1); });
      if (S.thread) {
        if (S.thread.rootId === m.messageId) closeThread();
        else S.thread.replies = S.thread.replies.filter((x) => x.id !== m.messageId);
        renderThread();
      }
      const inHistDel = S.histMode && S.histMode.kind === 'server' && S.histMode.id === m.channelId;
      if (m.channelId === S.channelId && !inHistDel) renderMessages();
      break;
    }
    case 'dm-new': {
      const msg = m.message;
      const inHistDm = S.histMode && S.histMode.kind === 'dm' && S.histMode.id === msg.threadId;
      if (!inHistDm) {
        const arr = S.dmMessages.get(msg.threadId) || [];
        arr.push(msg);
        S.dmMessages.set(msg.threadId, arr);
      }
      const ddnd = S.me && S.me.status === 'dnd';
      const own = !!(msg.user && S.me && msg.user.id === S.me.id);
      if (S.view === 'home' && S.dmThreadId === msg.threadId) {
        if (inHistDm) {
          // viewing older messages: hold the window, count up the jump pill
          if (!msg.sys) {
            S.histNew++;
            updatePill();
            if (!ddnd && !own) sfx.msg();
            if (document.hidden && !ddnd) notifyMsg(msg);
          }
        } else {
          renderDmMessages();
          if (!msg.sys && document.hidden && !ddnd) notifyMsg(msg);
        }
      } else if (!msg.sys && !own) {
        // background thread: count up the DM row + home button badges (no popup)
        S.dmUnread.set(msg.threadId, (S.dmUnread.get(msg.threadId) || 0) + 1);
        refreshDms();
        paintHomeBadge();
        if (!ddnd) sfx.msg();
      } else {
        refreshDms();
      }
      break;
    }
    case 'dm-updated': {
      updateMsgInCaches(m.message.id, (old) => Object.assign(old, m.message));
      const inHistDu = S.histMode && S.histMode.kind === 'dm' && S.histMode.id === m.message.threadId;
      if (S.view === 'home' && S.dmThreadId === m.message.threadId && !inHistDu) renderDmMessages();
      break;
    }
    case 'dm-deleted': {
      const darr = (S.dmMessages.get(m.threadId) || []).filter((x) => x.id !== m.messageId);
      S.dmMessages.set(m.threadId, darr);
      const inHistDd = S.histMode && S.histMode.kind === 'dm' && S.histMode.id === m.threadId;
      if (S.view === 'home' && S.dmThreadId === m.threadId && !inHistDd) renderDmMessages();
      break;
    }
    case 'dm-reaction': {
      updateMsgInCaches(m.messageId, (old) => {
        old.reactions = (m.reactions || []).map((r) => ({ emoji: r.emoji, count: r.count, me: (r.users || []).includes(S.me.id) }));
      });
      const inHistDr = S.histMode && S.histMode.kind === 'dm' && S.histMode.id === m.threadId;
      if (S.view === 'home' && S.dmThreadId === m.threadId && !inHistDr) renderDmMessages();
      break;
    }
    case 'pins-changed':
      if (m.serverId === S.serverId && m.channelId === S.channelId) {
        refreshPinsCount();
        if (S.pinsCtx && S.pinsCtx.kind === 'server' && S.pinsCtx.id === m.channelId) renderPinsList();
      }
      break;
    case 'dm-pins-changed':
      if (S.view === 'home' && S.dmThreadId === m.threadId) {
        refreshPinsCount();
        if (S.pinsCtx && S.pinsCtx.kind === 'dm' && S.pinsCtx.id === m.threadId) renderPinsList();
      }
      break;
    case 'dm-threads-changed':
      if (S.view === 'home') {
        refreshDms().then(() => {
          if (S.dmThreadId && !S.dms.some((t) => t.id === S.dmThreadId)) { S.dmThreadId = null; renderDmBlank(); }
          else renderDmMembers();
        });
      }
      break;
    case 'friends-changed':
      // Always refresh so the home button badge (pending requests) stays
      // correct even when looking at a server; no popup.
      refreshFriends();
      break;
    case 'dm-typing':
      if (S.view === 'home' && S.dmThreadId === m.threadId) showTyping(m.userId, m.display_name);
      break;
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
      Object.assign(S.presenceAll, m.online || {});
      if (m.serverId === S.serverId) { S.online = m.online || {}; S.online[S.me.id] = S.me.status || 'online'; }
      if (S.view === 'server') renderMembers(); else if (S.view === 'home') renderDmMembers();
      break;
    case 'user-online':
      S.presenceAll[m.userId] = m.status || 'online';
      if (m.serverId === S.serverId) S.online[m.userId] = m.status || 'online';
      if (S.view === 'server') renderMembers(); else if (S.view === 'home') renderDmMembers();
      break;
    case 'user-offline':
      delete S.presenceAll[m.userId];
      if (m.serverId === S.serverId) delete S.online[m.userId];
      if (S.view === 'server') renderMembers(); else if (S.view === 'home') renderDmMembers();
      break;
    case 'user-status':
      if (m.status === 'invisible') delete S.presenceAll[m.userId];
      else S.presenceAll[m.userId] = m.status;
      if (m.serverId === S.serverId) {
        if (m.status === 'invisible') delete S.online[m.userId];
        else S.online[m.userId] = m.status;
      }
      if (S.view === 'server') renderMembers(); else if (S.view === 'home') renderDmMembers();
      break;
    case 'user-updated': {
      const u = m.user;
      if (u.id === S.me.id) { S.me = { ...S.me, ...u }; paintMe(); }
      const mem = (S.serverDetail?.members || []).find((x) => x.id === u.id);
      if (mem) Object.assign(mem, u);
      for (const t of S.dms) {
        const dm = (t.members || []).find((x) => x.id === u.id);
        if (dm) Object.assign(dm, u);
      }
      renderMembers();
      if (S.view === 'home') renderDmMembers();
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
        renderServerHeader();
        renderTopic();
        if (!m.server.channels.find((c) => c.id === keepChan)) S.channelId = (m.server.channels.find((c) => c.type === 'text') || {}).id || null;
        renderServerList(); renderChannels(); renderMembers();
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
    case 'removed-from-server':
      if (S.voice && S.voice.serverId === m.serverId) leaveVoice(true);
      toast(m.reason === 'banned' ? 'You were banned from a server' : 'You were kicked from a server');
      S.ws?.send(JSON.stringify({ t: 'subscribe' }));
      refreshServers();
      break;
    case 'removed-from-dm':
      if (S.dmThreadId === m.threadId) { S.dmThreadId = null; renderDmBlank(); }
      refreshDms();
      toast('You were removed from a group chat');
      break;
    case 'server-deleted':
      toast('Server was deleted'); refreshServers(); break;
    case 'invite-updated':
      if (m.serverId === S.serverId) S.serverDetail.invite_code = m.invite_code;
      break;
    case 'notif-new':
      paintNotifBadge(m.unread || 0);
      break;
    // ---- voice ----
    case 'voice-peers': {
      S.voiceOccupancy.set(m.channelId, m.peers);
      if ((m.peers || []).length) { if (!S.voiceSince.has(m.channelId)) S.voiceSince.set(m.channelId, Date.now()); }
      else S.voiceSince.delete(m.channelId);
      if (m.serverId === S.serverId) renderChannels();
      else renderVoiceUsers();
      if (S.voice && S.voice.serverId === m.serverId && S.voice.channelId === m.channelId) {
        onVoicePeers(m.peers);
        renderStage();
      }
      break;
    }
    case 'voice-peer-joined': {
      if (S.voice && S.voice.serverId === m.serverId && S.voice.channelId === m.channelId) {
        ensurePeer(m.peer.id, false); // existing member: wait for offer
        sfx.join();
      } else {
        // update occupancy cache so channel counts refresh on next voice-peers
        S.ws.send(JSON.stringify({ t: 'subscribe' }));
      }
      renderVoiceUsers();
      renderStage();
      break;
    }
    case 'voice-peer-left': {
      closePeer(m.userId);
      if (S.voice && S.voice.serverId === m.serverId && S.voice.channelId === m.channelId) sfx.leave();
      renderVoiceUsers();
      renderStage();
      break;
    }
    case 'voice-state': {
      const occ = S.voiceOccupancy.get(m.channelId) || [];
      const p = occ.find((x) => x.id === m.userId);
      if (p) { p.muted = m.muted; p.speaking = !!m.speaking; p.deafened = !!m.deafened; p.camera = !!m.camera; p.sharing = !!m.sharing; }
      if (m.serverId === S.serverId) renderVoiceUsers();
      if (S.voice && S.voice.channelId === m.channelId) renderStage();
      break;
    }
    case 'voice-signal':
      onVoiceSignal(m.from, m.data);
      break;
    case 'voice-kicked':
      if (S.voice && S.voice.channelId === m.channelId) { leaveVoice(); toast('Voice room was deleted'); }
      break;
    case 'error':
      toast(m.error === 'slow_mode' && m.retryAfter ? `Slow mode — wait ${m.retryAfter}s` : prettyError(m.error));
      break;
  }
}
function chanName(id) {
  return (S.serverDetail?.channels.find((c) => c.id === id) || {}).name || 'chat';
}
function notifyMsg(m) {
  if (!m.user) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  sfx.msg();
  try { new Notification(m.threadId ? `${m.user.display_name} (DM)` : `${m.user.display_name} (#${chanName(m.channelId)})`, { body: (m.content || '[attachment]').slice(0, 120) }); } catch {}
}
if ('Notification' in window && Notification.permission === 'default') {
  document.addEventListener('click', function once() {
    Notification.requestPermission().catch(() => {});
    document.removeEventListener('click', once);
  });
}

// ---------- modals (in-app dialogs — no native alert/confirm/prompt) ----------
let modalOkFn = null;
let modalCancelFn = null;
function openModal(title, bodyHTML, okLabel, onOk, opts = {}) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHTML;
  const ok = $('#modal-ok');
  ok.textContent = okLabel || 'OK';
  ok.classList.toggle('danger', !!opts.danger);
  ok.classList.toggle('primary', !opts.danger);
  $('#modal-close').textContent = opts.cancelLabel || 'Cancel';
  modalOkFn = onOk || null;
  modalCancelFn = opts.onCancel || null;
  document.querySelector('#modal-backdrop .modal').classList.toggle('wide', !!opts.wide);
  $('#modal-backdrop').classList.remove('hidden');
  const input = $('#modal-body input');
  if (input) setTimeout(() => { try { input.focus(); input.select?.(); } catch {} }, 0);
}
function cancelModal() {
  if ($('#modal-backdrop').classList.contains('hidden')) return;
  $('#modal-backdrop').classList.add('hidden');
  const fn = modalCancelFn;
  modalCancelFn = null;
  if (fn) { try { fn(); } catch {} }
}
$('#modal-close').onclick = () => cancelModal();
$('#modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') cancelModal(); });
$('#modal-ok').onclick = async () => {
  $('#modal-backdrop').classList.add('hidden');
  modalCancelFn = null;
  if (modalOkFn) { try { await modalOkFn(); } catch (err) { toast('Failed: ' + prettyError(err.message)); } }
};
// Promise-based confirm dialog. Resolves true on confirm, false on cancel/dismiss.
function openConfirmModal({ title, message, okLabel = 'Delete', cancelLabel = 'Cancel', danger = true }) {
  return new Promise((resolve) => {
    openModal(title, `<p class="muted">${esc(message)}</p>`, okLabel, () => resolve(true), { danger, cancelLabel, onCancel: () => resolve(false) });
  });
}
// Promise-based text-input dialog. Resolves the entered string on confirm, null on cancel/dismiss.
function openPromptModal({ title, label, initial = '', placeholder = '', okLabel = 'Create', cancelLabel = 'Cancel', maxlength = 32 }) {
  return new Promise((resolve) => {
    openModal(title, `<label>${esc(label)}<input id="m-prompt-input" maxlength="${maxlength}" placeholder="${esc(placeholder)}" value="${esc(initial)}" /></label>`, okLabel, () => resolve($('#m-prompt-input')?.value ?? null), { cancelLabel, onCancel: () => resolve(null) });
    $('#m-prompt-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#modal-ok').click(); } });
  });
}
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
async function showInviteLanding(code) {
  let info;
  try {
    const r = await fetch('/api/invite/' + encodeURIComponent(code));
    info = await r.json();
    if (!r.ok) throw new Error(info.error || 'bad_invite');
  } catch (err) { toast('Invite failed: ' + prettyError(err.message || 'bad_invite')); return; }
  $('#inv-name').textContent = info.name || 'Server';
  $('#inv-banner').style.backgroundImage = info.banner_url ? `url('${info.banner_url}')` : '';
  const icon = $('#inv-icon');
  if (info.icon_url) icon.innerHTML = `<img src="${esc(info.icon_url)}" alt="" />`;
  else { icon.innerHTML = ''; icon.textContent = (info.name || 'S').trim().charAt(0).toUpperCase(); }
  const dd = $('#inv-desc');
  if (info.description) { dd.textContent = info.description; dd.classList.remove('hidden'); }
  else dd.classList.add('hidden');
  const n = info.memberCount || 0;
  $('#inv-count').textContent = n === 1 ? '1 member' : `${n} members`;
  const acts = $('#inv-actions');
  acts.innerHTML = '';
  const mkBtn = (label, primary, fn) => { const b = document.createElement('button'); b.className = 'btn' + (primary ? ' primary' : ''); b.textContent = label; b.onclick = fn; acts.appendChild(b); };
  if (store.token) {
    mkBtn('Join server', true, async () => {
      try {
        const { server } = await api('/api/servers/join', { method: 'POST', body: JSON.stringify({ inviteCode: code }) });
        $('#invite-view').classList.add('hidden');
        await refreshServers(server.id);
        S.ws?.send(JSON.stringify({ t: 'subscribe' }));
        toast(`Joined "${server.name}"`);
      } catch (err) { toast('Join failed: ' + prettyError(err.message)); }
    });
    mkBtn('Cancel', false, () => $('#invite-view').classList.add('hidden'));
  } else {
    mkBtn('Sign in', true, () => { stashInvite(code); $('#invite-view').classList.add('hidden'); setMode('login'); });
    mkBtn('Sign up', false, () => { stashInvite(code); $('#invite-view').classList.add('hidden'); setMode('register'); });
  }
  $('#invite-view').classList.remove('hidden');
}
$('#btn-invite').onclick = () => showInvite(S.serverDetail);
function showInvite(srv) {
  if (!srv) return;
  const url = `${location.origin}/invite/${srv.invite_code}`;
  openModal(`Invite to ${srv.name}`, `
    <p class="muted">Share this code or link — anyone with it can join.</p>
    <div class="codebox">${esc(srv.invite_code)}</div>
    <div class="row"><button class="btn" id="m-copy-code">Copy code</button>
    <button class="btn" id="m-copy-link">Copy link</button></div>
    <div class="chan-group-label" style="padding-left:0">Invite friends directly</div>
    <div id="m-inv-friends"><p class="muted small">Loading friends…</p></div>
    <div class="row" style="margin-top:.5rem"><button class="btn small primary" id="m-inv-send">Send invites</button></div>
  `, 'Done', null);
  $('#m-copy-code').onclick = () => { navigator.clipboard?.writeText(srv.invite_code); toast('Code copied'); };
  $('#m-copy-link').onclick = () => { navigator.clipboard?.writeText(url); toast('Link copied'); };
  (async () => {
    const box = $('#m-inv-friends');
    if (!box) return;
    let friends = (S.friends && S.friends.friends) || [];
    if (!friends.length) { try { ({ friends } = await api('/api/friends')); } catch { friends = []; } }
    const memberIds = new Set((srv.members || []).map((m) => m.id));
    const picks = friends.filter((f) => f.id !== S.me.id && !memberIds.has(f.id));
    if (!box.isConnected) return;
    if (!picks.length) { box.innerHTML = '<p class="muted small">No friends to invite — everyone is already here.</p>'; return; }
    box.innerHTML = '';
    const list = document.createElement('div');
    list.style.cssText = 'max-height:180px;overflow-y:auto';
    for (const f of picks) {
      const lab = document.createElement('label');
      lab.className = 'gpick';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.value = f.id;
      lab.appendChild(cb);
      const nm = document.createElement('span');
      nm.textContent = `${f.display_name} `;
      const un = document.createElement('span');
      un.className = 'muted'; un.textContent = `@${f.username}`;
      nm.appendChild(un); lab.appendChild(nm);
      list.appendChild(lab);
    }
    box.appendChild(list);
  })();
  $('#m-inv-send').onclick = async () => {
    const ids = [...document.querySelectorAll('#m-inv-friends input:checked')].map((i) => i.value);
    if (!ids.length) { toast('Pick at least one friend'); return; }
    try {
      const { sent } = await api(`/api/servers/${srv.id}/invite-friends`, { method: 'POST', body: JSON.stringify({ userIds: ids }) });
      toast(sent === 1 ? 'Invite sent' : `${sent} invites sent`);
      document.querySelectorAll('#m-inv-friends input:checked').forEach((i) => { i.checked = false; });
    } catch (err) { toast('Invite failed: ' + prettyError(err.message)); }
  };
}

// ---------- mobile nav ----------
// ---------- mobile navigation ----------
$('#btn-menu').onclick = () => document.body.classList.toggle('nav-open');
$('#btn-members').onclick = (e) => { e.stopPropagation(); document.body.classList.toggle('members-open'); };
$('#sidebar-scrim').onclick = () => document.body.classList.remove('nav-open');

// ---------- VOICE (WebRTC mesh) ----------
// call + notification sounds (synthesized with WebAudio, no assets)
let sfxCtx = null;
function sfxTone(freq, dur = 0.12, type = 'sine', vol = 0.1, delay = 0) {
  try {
    if (!sfxCtx) sfxCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (sfxCtx.state === 'suspended') { sfxCtx.resume().catch(() => {}); return; }
    const t0 = sfxCtx.currentTime + delay;
    const o = sfxCtx.createOscillator(), g = sfxCtx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(sfxCtx.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  } catch {}
}
const sfx = {
  msg() { sfxTone(880, 0.1, 'sine', 0.09); sfxTone(1318, 0.12, 'sine', 0.07, 0.08); },
  mute() { sfxTone(440, 0.1, 'square', 0.045); },
  unmute() { sfxTone(660, 0.1, 'square', 0.045); },
  deaf() { sfxTone(330, 0.14, 'sawtooth', 0.045); sfxTone(220, 0.16, 'sawtooth', 0.045, 0.1); },
  undeaf() { sfxTone(520, 0.12, 'sine', 0.09); },
  join() { sfxTone(523, 0.1, 'sine', 0.09); sfxTone(784, 0.14, 'sine', 0.09, 0.09); },
  leave() { sfxTone(784, 0.1, 'sine', 0.08); sfxTone(523, 0.16, 'sine', 0.08, 0.09); },
};
const VB_SVG = {
  mic: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3"/></svg>',
  deaf: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/></svg>',
  cam: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="13" height="12" rx="2.5"/><path d="M15 10.5l6-3.5v10l-6-3.5"/></svg>',
  share: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M12 17v4M8 21h8"/></svg>',
};
for (const [id, svg] of [['#btn-mute', VB_SVG.mic], ['#vf-mute', VB_SVG.mic], ['#cv-mute', VB_SVG.mic], ['#btn-deafen', VB_SVG.deaf], ['#vf-deafen', VB_SVG.deaf], ['#cv-deafen', VB_SVG.deaf], ['#btn-camera', VB_SVG.cam], ['#vf-camera', VB_SVG.cam], ['#cv-camera', VB_SVG.cam], ['#btn-share', VB_SVG.share], ['#vf-share', VB_SVG.share], ['#cv-share', VB_SVG.share]]) {
  const b = $(id); if (b && !b.innerHTML.trim()) b.innerHTML = svg;
}
if ($('#btn-voice-leave') && !$('#btn-voice-leave').innerHTML.trim()) $('#btn-voice-leave').innerHTML = '✕';
$('#btn-voice-leave').onclick = () => leaveVoice();
$('#vf-leave').onclick = () => leaveVoice();
$('#vf-mute').onclick = () => toggleMute();
$('#btn-mute').onclick = () => toggleMute();
$('#vf-deafen').onclick = () => toggleDeafen();
$('#btn-deafen').onclick = () => toggleDeafen();
$('#vf-camera').onclick = () => toggleCamera();
$('#btn-camera').onclick = () => toggleCamera();
$('#vf-share').onclick = () => toggleScreen();
$('#btn-share').onclick = () => toggleScreen();
if ($('#sc-min')) $('#sc-min').onclick = () => closeCallView();
$('#voice-status').style.cursor = 'pointer';
$('#voice-status').onclick = () => openCallView();
$('#cv-leave').onclick = () => leaveVoice();
$('#cv-mute').onclick = () => toggleMute();
$('#cv-deafen').onclick = () => toggleDeafen();
$('#cv-camera').onclick = () => toggleCamera();
$('#cv-share').onclick = () => toggleScreen();
paintVoiceControls();

async function openVoiceChannel(serverId, channelId) {
  if (S.voice && S.voice.serverId === serverId && S.voice.channelId === channelId) { openCallView(); return; }
  await joinVoice(serverId, channelId);
  if (S.voice && S.voice.serverId === serverId && S.voice.channelId === channelId) openCallView();
}
function callViewOpen() { return !!S.callOpen; }
function openCallView() {
  if (!S.voice) return;
  S.callOpen = true;
  $('#chat').classList.add('call-open');
  const ch = S.serverDetail?.channels.find((c) => c.id === S.voice.channelId);
  $('#stage-name').textContent = ch ? ch.name : 'voice';
  $('#messages').classList.add('hidden');
  $('#friends-page').classList.add('hidden');
  $('#composer').classList.add('hidden');
  $('#attach-preview').classList.add('hidden');
  $('#mention-pop').classList.add('hidden');
  $('#voice-fab').classList.add('hidden');
  renderStage();
}
function closeCallView() {
  S.callOpen = false;
  $('#chat').classList.remove('call-open');
  if (S.view === 'home' && !S.dmThreadId) renderDmBlank();
  else {
    $('#friends-page').classList.add('hidden');
    $('#messages').classList.remove('hidden');
    $('#composer').classList.remove('hidden');
    if (S.voice) $('#voice-fab').classList.remove('hidden');
    renderComposerMeta();
  }
  renderStage();
}
function updateCallHead() {
  if (!S.voice || !S.callOpen) return;
  const occ = S.voiceOccupancy.get(S.voice.channelId) || [];
  const srv = (S.servers || []).find((s) => s.id === S.voice.serverId);
  $('#stage-name').textContent = (S.serverDetail?.channels.find((c) => c.id === S.voice.channelId) || {}).name || 'voice';
  const t0 = S.voice.channelId && S.voiceSince.get(S.voice.channelId);
  $('#stage-sub').innerHTML = `${esc(srv ? srv.name + ' · ' : '')}${occ.length} in call${t0 ? ` · <span class="vtime" data-vtimer="${S.voice.channelId}">${fmtVoiceTime(Date.now() - t0)}</span>` : ''}`;
}
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
  S.voice = { serverId, channelId, stream, camStream: null, screenStream: null, pcs: new Map(), senders: new Map(), muted: false, deafened: false, cameraOn: false, sharing: false, quality: 'high', speaking: false, audioEls: new Map(), remoteVideo: new Map(), trackMeta: new Map(), tiles: new Map() };
  $('#voice-bar').classList.remove('hidden');
  $('#voice-fab').classList.remove('hidden');
  $('#voice-chan-name').textContent = ch ? ch.name : 'voice';
  $('#vf-name').textContent = ch ? ch.name : 'voice';
  paintVoiceControls();
  renderStage();
  S.ws?.send(JSON.stringify({ t: 'voice-join', serverId, channelId }));
  renderChannels();
  startSpeakingMonitor();
  sfx.join();
}
function leaveVoice(silent) {
  if (!S.voice) return;
  for (const [, pc] of S.voice.pcs) { try { pc.close(); } catch {} }
  S.voice.stream?.getTracks().forEach((t) => t.stop());
  S.voice.camStream?.getTracks().forEach((t) => t.stop());
  S.voice.screenStream?.getTracks().forEach((t) => t.stop());
  for (const [, el] of S.voice.audioEls) { try { el.remove(); } catch {} }
  S.callOpen = false;
  $('#chat').classList.remove('call-open');
  if (S.view === 'home' && !S.dmThreadId) renderDmBlank();
  else { $('#friends-page').classList.add('hidden'); $('#messages').classList.remove('hidden'); $('#composer').classList.remove('hidden'); renderComposerMeta(); }
  $('#stage').classList.add('hidden');
  $('#stage-grid').innerHTML = '';
  const { serverId, channelId } = S.voice;
  S.voice = null;
  stopSpeakingMonitor();
  $('#voice-bar').classList.add('hidden');
  $('#voice-fab').classList.add('hidden');
  paintVoiceControls();
  // optimistically drop self so the sidebar clears instantly (server echo confirms)
  const occ = S.voiceOccupancy.get(channelId) || [];
  S.voiceOccupancy.set(channelId, occ.filter((p) => p.id !== S.me.id));
  if (!(S.voiceOccupancy.get(channelId) || []).length) S.voiceSince.delete(channelId);
  if (!silent) { sfx.leave(); S.ws?.send(JSON.stringify({ t: 'voice-leave' })); }
  renderChannels();
  if (S.updateReady && !silent) location.reload();
}
function sendVoiceState() {
  if (!S.voice) return;
  S.ws?.send(JSON.stringify({ t: 'voice-state',
    muted: S.voice.muted, deafened: S.voice.deafened,
    camera: S.voice.cameraOn, sharing: S.voice.sharing,
    speaking: (!S.voice.muted && !S.voice.deafened) && !!S.voice.speaking }));
}
function paintVoiceControls() {
  const v = S.voice;
  const set = (id, off, label) => { const b = $(id); if (!b) return; b.classList.toggle('off', !!off); b.title = label; };
  // Deafening also mutes the mic, so the mic button stays red while deafened.
  const micOff = v?.muted || v?.deafened;
  const micLabel = v?.deafened ? 'Deafened — undeafen to unmute' : (v?.muted ? 'Unmute mic' : 'Mute mic');
  set('#btn-mute', micOff, micLabel);
  set('#vf-mute', micOff, micLabel);
  set('#cv-mute', micOff, micLabel);
  set('#btn-deafen', v?.deafened, v?.deafened ? 'Undeafen' : 'Deafen');
  set('#vf-deafen', v?.deafened, v?.deafened ? 'Undeafen' : 'Deafen');
  set('#cv-deafen', v?.deafened, v?.deafened ? 'Undeafen' : 'Deafen');
  set('#btn-camera', !v?.cameraOn, v?.cameraOn ? 'Turn camera off' : 'Turn camera on');
  set('#vf-camera', !v?.cameraOn, v?.cameraOn ? 'Turn camera off' : 'Turn camera on');
  set('#cv-camera', !v?.cameraOn, v?.cameraOn ? 'Turn camera off' : 'Turn camera on');
  set('#btn-share', v?.sharing, v?.sharing ? 'Stop sharing screen' : 'Share screen');
  set('#vf-share', v?.sharing, v?.sharing ? 'Stop sharing screen' : 'Share screen');
  set('#cv-share', v?.sharing, v?.sharing ? 'Stop sharing screen' : 'Share screen');
}
function applyMicState() {
  if (!S.voice) return;
  const off = S.voice.muted || S.voice.deafened;
  S.voice.stream.getAudioTracks().forEach((t) => (t.enabled = !off));
  if (off) { S.voice.speaking = false; setSpeakingUI(S.me.id, false); }
}
function toggleMute() {
  if (!S.voice) return;
  if (S.voice.deafened) { toast('Undeafen to change your mic'); return; }
  S.voice.muted = !S.voice.muted;
  sfx[S.voice.muted ? 'mute' : 'unmute']();
  applyMicState();
  $('#vf-name').textContent = (S.serverDetail?.channels.find((c) => c.id === S.voice.channelId) || {}).name || 'voice';
  sendVoiceState();
  paintVoiceControls();
  renderVoiceUsers();
  renderStage();
}
function toggleDeafen() {
  if (!S.voice) return;
  S.voice.deafened = !S.voice.deafened;
  sfx[S.voice.deafened ? 'deaf' : 'undeaf']();
  applyMicState();
  for (const [, el] of S.voice.audioEls) el.muted = S.voice.deafened;
  sendVoiceState();
  paintVoiceControls();
  renderVoiceUsers();
  renderStage();
}
const V_QUALITY = {
  high: { label: '720p', w: 1280, h: 720, br: 2500000 },
  medium: { label: '480p', w: 854, h: 480, br: 1000000 },
  low: { label: '360p', w: 640, h: 360, br: 500000 },
};
function applySenderQuality(sender) {
  if (!sender || !S.voice) return;
  const q = V_QUALITY[S.voice.quality] || V_QUALITY.high;
  try {
    const p = sender.getParameters();
    p.encodings = (p.encodings && p.encodings.length) ? p.encodings : [{}];
    p.encodings[0].maxBitrate = q.br;
    sender.setParameters(p).catch(() => {});
  } catch {}
}
async function toggleCamera() {
  if (!S.voice) return;
  if (S.voice.cameraOn) { stopCamera(); return; }
  const q = V_QUALITY[S.voice.quality] || V_QUALITY.high;
  let cam;
  try {
    cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: 30 } }, audio: false });
  } catch { toast('Camera blocked — allow camera access'); return; }
  S.voice.camStream = cam;
  S.voice.cameraOn = true;
  const track = cam.getVideoTracks()[0];
  for (const [pid, pc] of S.voice.pcs) {
    try {
      const sender = pc.addTrack(track, cam);
      S.voice.senders.get(pid).camera = sender;
      applySenderQuality(sender);
      S.ws?.send(JSON.stringify({ t: 'voice-signal', to: pid, data: { kind: 'track-meta', trackId: track.id, media: 'camera' } }));
    } catch {}
  }
  sendVoiceState();
  paintVoiceControls();
  renderStage();
}
function stopCamera() {
  if (!S.voice || !S.voice.cameraOn) return;
  S.voice.camStream?.getVideoTracks().forEach((t) => { try { t.stop(); } catch {} });
  S.voice.camStream = null;
  S.voice.cameraOn = false;
  for (const [pid, pc] of S.voice.pcs) {
    const s = S.voice.senders.get(pid);
    if (s?.camera) { try { pc.removeTrack(s.camera); } catch {} s.camera = null; }
  }
  sendVoiceState();
  paintVoiceControls();
  renderStage();
}
async function toggleScreen() {
  if (!S.voice) return;
  if (S.voice.sharing) { stopScreen(); return; }
  if (!navigator.mediaDevices?.getDisplayMedia) { toast('Screen sharing is not supported here'); return; }
  let screen;
  try {
    screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false });
  } catch { return; }
  S.voice.screenStream = screen;
  S.voice.sharing = true;
  const track = screen.getVideoTracks()[0];
  if (track) track.onended = () => { if (S.voice?.sharing) stopScreen(); };
  for (const [pid, pc] of S.voice.pcs) {
    try {
      const sender = pc.addTrack(track, screen);
      S.voice.senders.get(pid).screen = sender;
      applySenderQuality(sender);
      S.ws?.send(JSON.stringify({ t: 'voice-signal', to: pid, data: { kind: 'track-meta', trackId: track.id, media: 'screen' } }));
    } catch {}
  }
  sendVoiceState();
  paintVoiceControls();
  renderStage();
  toast('You are sharing your screen');
}
function stopScreen() {
  if (!S.voice || !S.voice.sharing) return;
  S.voice.screenStream?.getTracks().forEach((t) => { try { t.stop(); } catch {} });
  S.voice.screenStream = null;
  S.voice.sharing = false;
  for (const [pid, pc] of S.voice.pcs) {
    const s = S.voice.senders.get(pid);
    if (s?.screen) { try { pc.removeTrack(s.screen); } catch {} s.screen = null; }
  }
  sendVoiceState();
  paintVoiceControls();
  renderStage();
}
function renegotiate(peerId) {
  if (!S.voice) return;
  const pc = S.voice.pcs.get(peerId);
  if (!pc || pc.signalingState !== 'stable') return;
  pc.createOffer().then((offer) => pc.setLocalDescription(offer)).then(() => {
    S.ws?.send(JSON.stringify({ t: 'voice-signal', to: peerId, data: { kind: 'offer', sdp: pc.localDescription } }));
  }).catch(() => {});
}
function ensurePeer(peerId, initiator) {
  if (!S.voice || peerId === S.me.id || S.voice.pcs.has(peerId)) return S.voice?.pcs.get(peerId);
  const pc = new RTCPeerConnection({ iceServers: S.iceServers });
  pc._initiator = !!initiator;
  pc._remoteOfferSeen = false;
  S.voice.pcs.set(peerId, pc);
  S.voice.senders.set(peerId, { audio: null, camera: null, screen: null });
  const senders = S.voice.senders.get(peerId);
  for (const track of S.voice.stream.getTracks()) senders.audio = pc.addTrack(track, S.voice.stream);
  if (S.voice.cameraOn && S.voice.camStream) {
    const ct = S.voice.camStream.getVideoTracks()[0];
    if (ct) {
      senders.camera = pc.addTrack(ct, S.voice.camStream);
      applySenderQuality(senders.camera);
      S.ws?.send(JSON.stringify({ t: 'voice-signal', to: peerId, data: { kind: 'track-meta', trackId: ct.id, media: 'camera' } }));
    }
  }
  if (S.voice.sharing && S.voice.screenStream) {
    const st = S.voice.screenStream.getVideoTracks()[0];
    if (st) {
      senders.screen = pc.addTrack(st, S.voice.screenStream);
      applySenderQuality(senders.screen);
      S.ws?.send(JSON.stringify({ t: 'voice-signal', to: peerId, data: { kind: 'track-meta', trackId: st.id, media: 'screen' } }));
    }
  }
  pc.onnegotiationneeded = () => {
    if (pc._politeWait) return; // non-initiator: wait for the other side's offer first
    renegotiate(peerId);
  };
  if (!initiator) pc._politeWait = true;
  pc.onicecandidate = (e) => {
    if (e.candidate) S.ws?.send(JSON.stringify({ t: 'voice-signal', to: peerId, data: { kind: 'ice', candidate: e.candidate } }));
  };
  pc.ontrack = (e) => {
    if (!e.track) return;
    if (e.track.kind === 'audio') { attachRemoteAudio(peerId, (e.streams && e.streams[0]) || new MediaStream([e.track])); return; }
    const media = (S.voice.trackMeta.get(e.track.id)) || guessRemoteMedia(peerId);
    attachRemoteVideo(peerId, media, e.track);
  };
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
  if (data.kind === 'track-meta' && data.trackId) {
    const want = data.media === 'screen' ? 'screen' : 'camera';
    S.voice.trackMeta.set(data.trackId, want);
    // relocate the track if it arrived before its label did
    for (const [, rv] of S.voice.remoteVideo) {
      for (const key of ['camera', 'screen']) {
        if (key === want) continue;
        const tr = rv[key].getVideoTracks().find((t) => t.id === data.trackId);
        if (tr) { try { rv[key].removeTrack(tr); rv[want].addTrack(tr); } catch {} }
      }
    }
    renderStage();
    return;
  }
  if (data.kind === 'offer') {
    const pc = ensurePeer(fromId, false);
    pc._remoteOfferSeen = true;
    pc._politeWait = false;
    try {
      if (pc.signalingState !== 'stable') {
        if (pc._initiator) return; // glare: our offer wins, ignore theirs
        try { await pc.setLocalDescription({ type: 'rollback' }); } catch {}
      }
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
  S.voice.senders.delete(peerId);
  S.voice.remoteVideo.delete(peerId);
  const el = S.voice.audioEls.get(peerId);
  if (el) { try { el.remove(); } catch {} S.voice.audioEls.delete(peerId); }
  renderStage();
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
  el.muted = !!S.voice.deafened;
  el.srcObject = stream;
}
function guessRemoteMedia(peerId) {
  const rv = S.voice.remoteVideo.get(peerId);
  if (rv && rv.camera.getVideoTracks().some((t) => t.readyState === 'live') && !rv.screen.getVideoTracks().some((t) => t.readyState === 'live')) return 'screen';
  return 'camera';
}
function attachRemoteVideo(peerId, media, track) {
  if (!S.voice) return;
  let rv = S.voice.remoteVideo.get(peerId);
  if (!rv) { rv = { camera: new MediaStream(), screen: new MediaStream() }; S.voice.remoteVideo.set(peerId, rv); }
  const ms = media === 'screen' ? rv.screen : rv.camera;
  ms.getVideoTracks().forEach((t) => { if (t.id !== track.id) { try { ms.removeTrack(t); } catch {} } });
  try { if (!ms.getVideoTracks().some((t) => t.id === track.id)) ms.addTrack(track); } catch {}
  track.onended = () => { try { ms.removeTrack(track); } catch {} renderStage(); };
  renderStage();
}
// ---------- voice stage (video grid) ----------
function liveVideoTracks(ms) { return ms ? ms.getVideoTracks().filter((t) => t.readyState === 'live') : []; }
function stageVisible() {
  if (!S.voice) return false;
  if (S.callOpen) return true;
  if (S.voice.cameraOn || S.voice.sharing) return true;
  for (const [, rv] of S.voice.remoteVideo) {
    if (liveVideoTracks(rv.camera).length || liveVideoTracks(rv.screen).length) return true;
  }
  return false;
}
function voicePeerInfo(id) {
  if (id === 'me' || (S.me && id === S.me.id)) {
    return {
      id: S.me.id, display_name: S.me.display_name, username: S.me.username,
      avatar_color: S.me.avatar_color, avatar_url: S.me.avatar_url || null,
      muted: !!S.voice?.muted, deafened: !!S.voice?.deafened,
      camera: !!S.voice?.cameraOn, sharing: !!S.voice?.sharing,
      speaking: !!S.voice?.speaking, me: true,
    };
  }
  const p = (S.voiceOccupancy.get(S.voice?.channelId) || []).find((x) => x.id === id);
  return p || { id, display_name: '?', username: '?', avatar_color: '#555', avatar_url: null };
}
function tileStream(key) {
  if (!S.voice) return null;
  if (key === 'me:cam') return S.voice.camStream;
  if (key === 'me:screen') return S.voice.screenStream;
  const [pid, media] = key.split(':');
  const rv = S.voice.remoteVideo.get(pid);
  return rv ? rv[media === 'screen' ? 'screen' : 'camera'] : null;
}
function paintTile(key, el) {
  const [pid, media] = key.split(':');
  const isScreen = media === 'screen';
  const u = voicePeerInfo(pid);
  const ms = tileStream(key);
  const live = liveVideoTracks(ms).length > 0;
  let video = el.querySelector('video');
  let fb = el.querySelector('.vfallback');
  if (live) {
    if (!video) { video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = true; el.prepend(video); }
    if (video.srcObject !== ms) video.srcObject = ms;
    video.classList.toggle('mirror', key === 'me:cam');
    video.style.display = '';
    if (fb) fb.style.display = 'none';
  } else {
    if (video) video.style.display = 'none';
    if (!fb) {
      fb = document.createElement('div');
      fb.className = 'vfallback';
      fb.innerHTML = '<span class="avatar"></span>';
      paintAvatar(fb.querySelector('.avatar'), u);
      el.prepend(fb);
    }
    fb.style.display = '';
  }
  el.querySelector('.vname').textContent = isScreen ? `${u.display_name}’s screen` : (u.me ? `${u.display_name} (you)` : u.display_name);
  const icons = el.querySelector('.vicons');
  icons.innerHTML = '';
  const badge = (svg, cls, title) => { const s = document.createElement('span'); if (cls) s.className = cls; s.title = title; s.innerHTML = svg; icons.appendChild(s); };
  if (u.deafened) badge(VB_SVG.deaf, '', 'Deafened');
  else if (u.muted) badge(VB_SVG.mic, '', 'Muted');
  if (!isScreen && u.sharing) badge(VB_SVG.share, 'ok', 'Sharing screen');
  el.classList.toggle('speaking', !!u.speaking && !u.muted && !u.deafened);
  el.dataset.vuser = pid === 'me' ? (S.me?.id || 'me') : pid;
}
function renderStage() {
  const stage = $('#stage'), grid = $('#stage-grid');
  if (!stageVisible() || !S.voice) { stage.classList.add('hidden'); return; }
  stage.classList.remove('hidden');
  const full = !!S.callOpen;
  $('#stage-head').classList.toggle('hidden', !full);
  $('#stage-controls').classList.toggle('hidden', !full);
  const occ = S.voiceOccupancy.get(S.voice.channelId) || [];
  const order = ['me:cam'];
  if (S.voice.sharing) order.push('me:screen');
  for (const p of occ) {
    if (p.id === S.me.id) continue;
    order.push(p.id + ':cam');
  }
  for (const p of occ) {
    if (p.id === S.me.id) continue;
    const rv = S.voice.remoteVideo.get(p.id);
    if (rv && liveVideoTracks(rv.screen).length) order.push(p.id + ':screen');
  }
  const want = new Set(order);
  for (const [k, el] of [...S.voice.tiles]) {
    if (!want.has(k)) { el.remove(); S.voice.tiles.delete(k); }
  }
  for (const k of order) {
    let el = S.voice.tiles.get(k);
    if (!el || !el.isConnected) {
      el = document.createElement('div');
      el.className = 'vtile';
      el.dataset.vtile = k;
      el.innerHTML = '<div class="vname"></div><div class="vicons"></div>';
      S.voice.tiles.set(k, el);
      grid.appendChild(el);
    }
    paintTile(k, el);
  }
  updateCallHead();
  fitStage();
}
// Full call view: size tiles to fit the available area — no scrollbar, no giant tiles.
function fitStage() {
  const grid = $('#stage-grid');
  if (!grid) return;
  const n = grid.children.length;
  if (!S.callOpen || !S.voice || !n) { grid.style.gridTemplateColumns = ''; grid.style.justifyContent = ''; return; }
  const gap = 8, W = grid.clientWidth, H = grid.clientHeight;
  if (!W || !H) return;
  // Widest tile that still fits: cap every column layout by the available height.
  let best = null;
  for (let c = 1; c <= n; c++) {
    const rows = Math.ceil(n / c);
    const w = Math.min((W - (c - 1) * gap) / c, ((H - (rows - 1) * gap) / rows) * 16 / 9);
    if (w <= 0) continue;
    if (!best || w > best.w) best = { cols: c, w };
  }
  if (!best) return;
  let { cols, w } = best;
  const MIN = 140;
  if (w < MIN) {
    // Tons of people: keep tiles usable and allow the scroll instead.
    cols = Math.max(1, Math.floor((W + gap) / (MIN + gap)));
    w = Math.min(MIN, (W - (cols - 1) * gap) / cols);
  }
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, ${Math.floor(w)}px))`;
  grid.style.justifyContent = 'center';
}
window.addEventListener('resize', () => { try { fitStage(); } catch {} });
// Mobile keyboard: track the visual viewport so the app shell compresses
// instead of panning — top stays anchored, composer + messages slide up.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const syncVV = () => {
    document.documentElement.style.setProperty('--vvh', vv.height + 'px');
    const ae = document.activeElement;
    if (ae && (ae.id === 'in-message' || ae.id === 'in-thread')) {
      const m = $('#messages');
      if (m) m.scrollTop = m.scrollHeight;
    }
  };
  let vvT = null;
  vv.addEventListener('resize', () => { clearTimeout(vvT); vvT = setTimeout(syncVV, 60); });
  syncVV();
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
      u.className = 'vuser' + (p.speaking && !p.muted && !p.deafened ? ' speaking' : '');
      u.dataset.vuser = p.id;
      u.dataset.uid = p.id;
      let stat = '';
      if (p.deafened) stat = '<span class="vstat"><span class="bad" title="Deafened">' + VB_SVG.deaf + '</span></span>';
      else if (p.muted) stat = '<span class="vstat"><span class="bad" title="Muted">' + VB_SVG.mic + '</span></span>';
      else {
        const subs = [];
        if (p.camera) subs.push('<span class="on" title="Camera on">' + VB_SVG.cam + '</span>');
        if (p.sharing) subs.push('<span class="on" title="Sharing screen">' + VB_SVG.share + '</span>');
        if (subs.length) stat = '<span class="vstat">' + subs.join('') + '</span>';
      }
      u.innerHTML = `<span class="avatar"></span><span class="vname">${esc(p.display_name)}${p.id === S.me.id ? ' (you)' : ''}</span>${stat || (p.muted ? '<span class="vmic">' + MIC_OFF_SVG + '</span>' : '')}`;
      paintAvatar(u.querySelector('.avatar'), p);
      box.appendChild(u);
    }
  }
}
function setSpeakingUI(userId, speaking) {
  document.querySelectorAll('[data-vuser="' + CSS.escape(userId) + '"]').forEach((el) => el.classList.toggle('speaking', speaking));
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
      if (S.voice.muted || S.voice.deafened) { talking = false; speakQuiet = 0; }
      else if (lvl > 0.09) { talking = true; speakQuiet = 0; }
      else if (speakOn && ++speakQuiet >= 3) { talking = false; speakQuiet = 0; }
      if (talking !== speakOn) {
        speakOn = talking;
        S.voice.speaking = talking;
        setSpeakingUI(S.me.id, talking);
        const occ = S.voiceOccupancy.get(S.voice.channelId) || [];
        const me = occ.find((p) => p.id === S.me.id);
        if (me) me.speaking = talking;
        sendVoiceState();
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

/* ================= frequent reactions + context menus ================= */
function topReactions() {
  let f = {};
  try { f = JSON.parse(localStorage.getItem('cf_freq') || '{}'); } catch {}
  const def = ['👍', '❤️', '😂', '😮', '😢'];
  const ranked = Object.entries(f).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return [...new Set([...ranked, ...def])].slice(0, 5);
}
function bumpFreq(e) {
  if (!e || typeof e !== 'string') return;
  try {
    const f = JSON.parse(localStorage.getItem('cf_freq') || '{}');
    f[e] = (f[e] || 0) + 1;
    const keys = Object.keys(f);
    if (keys.length > 40) {
      keys.sort((a, b) => f[a] - f[b]);
      for (const k of keys.slice(0, keys.length - 40)) delete f[k];
    }
    localStorage.setItem('cf_freq', JSON.stringify(f));
  } catch {}
}
let ctxEl = null;
function closeCtx() { if (ctxEl) { ctxEl.remove(); ctxEl = null; } }
function openCtx(x, y, items) {
  closeCtx();
  const m = document.createElement('div');
  m.id = 'ctx-menu';
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; m.appendChild(s); continue; }
    const b = document.createElement('button');
    b.className = 'ctx-item' + (it.danger ? ' danger' : '');
    b.innerHTML = (it.icon ? `<span class="ctx-ic">${it.icon}</span>` : '') + `<span>${esc(it.label)}</span>`;
    b.onclick = (ev) => { ev.stopPropagation(); closeCtx(); it.fn && it.fn(); };
    m.appendChild(b);
  }
  m.style.visibility = 'hidden';
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  m.style.visibility = '';
  ctxEl = m;
}
const PIN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l1 7 3 3v2H5v-2l3-3z"/><path d="M12 16v5"/></svg>';
function sysMenuItems(m) {
  return [{ label: 'Copy text', icon: '⧉', fn: () => { try { navigator.clipboard.writeText(m.content || ''); toast('Copied'); } catch {} } }];
}
function messageMenuItems(m, mid, x, y) {
  const dm = !!m._dm;
  const own = m.user && m.user.id === S.me.id;
  const items = [
    { label: 'Add reaction…', icon: '➕', fn: () => openPicker('react', mid, 'emoji', { x, y }) },
    { label: 'Reply', icon: '↩', fn: () => { S.replyTo = m; renderComposerMeta(); $('#in-message').focus(); } },
    { label: 'Forward', icon: '↗', fn: () => openForward(mid) },
  ];
  if (!dm && !m.threadRoot) items.push({ label: 'Open thread', icon: '💬', fn: () => openThread(mid) });
  if (!m.threadRoot) items.push({ label: S.pinIds.has(mid) ? 'Unpin message' : 'Pin message', icon: PIN_SVG, fn: () => togglePin(mid) });
  items.push({ sep: true });
  if (own) items.push({ label: 'Edit message', icon: '✎', fn: () => startEdit(mid) });
  if (canMod(m)) items.push({ label: 'Delete message', icon: '🗑', danger: true, fn: () => api((dm ? '/api/dms/messages/' : '/api/messages/') + mid, { method: 'DELETE' }).catch(() => toast('Delete failed')) });
  items.push({ label: 'Copy text', icon: '⧉', fn: () => { try { navigator.clipboard.writeText(m.content || ''); toast('Copied'); } catch {} } });
  return items;
}
function messageCtxMenu(mid, x, y) {
  const m = msgById(mid);
  if (!m) return;
  if (m.sys) { openCtx(x, y, sysMenuItems(m)); return; }
  openCtx(x, y, messageMenuItems(m, mid, x, y));
}
function reactLabel(e) {
  return (e.startsWith(':') && e.endsWith(':') && S.emoji[e.slice(1, -1)])
    ? `<img class="cemoi" src="${S.emoji[e.slice(1, -1)]}" alt="${esc(e)}">` : esc(e);
}
function closeMsgSheet(instant) {
  const bd = document.querySelector('#sheet-backdrop'), sh = document.querySelector('#sheet');
  if (!bd && !sh) return;
  if (instant) { bd?.remove(); sh?.remove(); return; }
  bd?.classList.remove('open'); sh?.classList.remove('open');
  setTimeout(() => { document.querySelector('#sheet-backdrop')?.remove(); document.querySelector('#sheet')?.remove(); }, 240);
}
function openMsgSheet(mid) {
  const m = msgById(mid);
  if (!m) return;
  closeCtx();
  closeMsgSheet(true);
  const bd = document.createElement('div');
  bd.id = 'sheet-backdrop';
  bd.onclick = () => closeMsgSheet();
  const sh = document.createElement('div');
  sh.id = 'sheet';
  sh.setAttribute('role', 'dialog');
  sh.innerHTML = '<div class="sheet-handle"></div>';
  const head = document.createElement('div');
  head.className = 'sheet-head';
  head.innerHTML = '<span class="avatar"></span><div style="min-width:0;flex:1"><div class="sheet-who"></div><div class="sheet-snip"></div></div>';
  if (m.sys) {
    paintAvatar(head.querySelector('.avatar'), null);
    head.querySelector('.sheet-who').textContent = 'Message';
    head.querySelector('.sheet-snip').textContent = m.content || '';
  } else {
    const lu = liveUserFor(m.user);
    paintAvatar(head.querySelector('.avatar'), lu);
    head.querySelector('.sheet-who').innerHTML = `<span style="${nameStyleFor(lu)}">${esc(lu ? lu.display_name : 'deleted')}</span><span class="when">${fmtTime(m.created_at)}</span>`;
    head.querySelector('.sheet-snip').textContent = m.content
      ? (m.content.length > 120 ? m.content.slice(0, 120) + '…' : m.content)
      : (m.attachments?.length ? `[${m.attachments.length} attachment${m.attachments.length === 1 ? '' : 's'}]` : '');
  }
  sh.appendChild(head);
  if (!m.sys) {
    const reacts = document.createElement('div');
    reacts.className = 'sheet-reacts';
    for (const e of topReactions()) {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = reactLabel(e);
      b.onclick = () => { closeMsgSheet(); toggleReaction(mid, e); };
      reacts.appendChild(b);
    }
    sh.appendChild(reacts);
  }
  const rows = document.createElement('div');
  rows.className = 'sheet-rows';
  for (const it of (m.sys ? sysMenuItems(m) : messageMenuItems(m, mid, 0, 0))) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'sheet-sep'; rows.appendChild(s); continue; }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sheet-row' + (it.danger ? ' danger' : '');
    b.innerHTML = `<span class="ctx-ic">${it.icon || ''}</span>`;
    const lb = document.createElement('span');
    lb.textContent = it.label;
    b.appendChild(lb);
    b.onclick = () => { closeMsgSheet(); it.fn && it.fn(); };
    rows.appendChild(b);
  }
  sh.appendChild(rows);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'sheet-cancel';
  cancel.textContent = 'Cancel';
  cancel.onclick = () => closeMsgSheet();
  sh.appendChild(cancel);
  document.body.appendChild(bd);
  document.body.appendChild(sh);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bd.classList.add('open'); sh.classList.add('open');
  }));
}
/* ================= forward messages ================= */
S.fwdSrc = null; S.fwdPick = null;
let fwdDestCache = null;
async function loadFwdDests() {
  if (fwdDestCache && Date.now() - fwdDestCache.at < 30000) return fwdDestCache;
  const chans = [];
  const details = await Promise.all((S.servers || []).map((s) => api(`/api/servers/${s.id}`).then((d) => d.server).catch(() => null)));
  for (const d of details) {
    if (!d) continue;
    for (const c of (d.channels || []).filter((x) => x.type === 'text')) chans.push({ kind: 'server', serverId: d.id, serverName: d.name, id: c.id, name: c.name });
  }
  let dms = S.dms || [];
  if (!dms.length) { try { ({ threads: dms } = await api('/api/dms')); S.dms = dms; } catch { dms = []; } }
  fwdDestCache = { at: Date.now(), chans, dms };
  return fwdDestCache;
}
function renderFwdDests(filter = '') {
  const box = document.querySelector('#fwd-dests');
  if (!box || !fwdDestCache) return;
  const q = filter.trim().toLowerCase();
  const hit = (s) => !q || String(s || '').toLowerCase().includes(q);
  box.innerHTML = '';
  const mkRow = (pick, avText, name, sub, peer) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fwd-dest' + (S.fwdPick && S.fwdPick.kind === pick.kind && S.fwdPick.id === pick.id ? ' sel' : '');
    b.innerHTML = '<span class="avatar"></span><span class="fwd-main"><span class="fwd-name"></span><br/><span class="fwd-sub"></span></span><span class="fwd-check">✓</span>';
    const av = b.querySelector('.avatar');
    if (peer) paintAvatar(av, peer);
    else { av.textContent = avText; av.style.background = 'var(--panel-3)'; }
    b.querySelector('.fwd-name').textContent = name;
    b.querySelector('.fwd-sub').textContent = sub;
    b.onclick = () => { S.fwdPick = pick; renderFwdDests(document.querySelector('#fwd-search')?.value || ''); };
    return b;
  };
  const sec = (t) => { const e = document.createElement('div'); e.className = 'fwd-sec'; e.textContent = t; box.appendChild(e); };
  const chanHits = fwdDestCache.chans.filter((c) => !sameCtx(S.fwdSrcCtx, c) && (hit(c.name) || hit(c.serverName)));
  if (chanHits.length) {
    sec('CHANNELS');
    for (const c of chanHits) box.appendChild(mkRow(c, '#', '#' + c.name, c.serverName, null));
  }
  const dmHits = fwdDestCache.dms.filter((t) => !sameCtx(S.fwdSrcCtx, { kind: 'dm', id: t.id }) && hit(dmTitle(t)));
  if (dmHits.length) {
    sec('DIRECT MESSAGES');
    for (const t of dmHits) {
      const peer = t.isGroup ? null : dmPeer(t);
      box.appendChild(mkRow({ kind: 'dm', id: t.id }, t.isGroup ? '#' : '', dmTitle(t), t.isGroup ? 'Group chat' : ('@' + (peer?.username || '')), peer));
    }
  }
  if (!chanHits.length && !dmHits.length) box.innerHTML = '<p class="muted small" style="text-align:center;padding:.6rem">No chats match.</p>';
}
async function openForward(mid) {
  const m = msgById(mid);
  if (!m || m.sys) return;
  S.fwdSrc = m;
  const ctx = pinsCtx();
  S.fwdSrcCtx = ctx;
  S.fwdPick = null;
  const author = m.user ? m.user.display_name : 'Someone';
  const snip = m.content ? (m.content.length > 140 ? m.content.slice(0, 140) + '…' : m.content)
    : (m.attachments?.length ? `[${m.attachments.length} attachment${m.attachments.length === 1 ? '' : 's'}]` : '[no text]');
  openModal('Forward message', `
    <div class="fwd-preview"><span class="avatar"></span><div class="fwd-pmain"><div class="fwd-from"></div><div class="fwd-snip"></div></div></div>
    <label class="fwd-label">Add a message <span class="muted">(optional)</span><textarea id="fwd-comment" maxlength="2000" rows="2" placeholder="Say something about this…"></textarea></label>
    <input id="fwd-search" placeholder="Search chats…" autocomplete="off" />
    <div id="fwd-dests"><p class="muted small" style="text-align:center;padding:.6rem">Loading chats…</p></div>
  `, 'Forward', () => sendForward(), { wide: true });
  const pv = document.querySelector('#modal-body .fwd-preview');
  if (pv) {
    paintAvatar(pv.querySelector('.avatar'), m.user);
    pv.querySelector('.fwd-from').textContent = author;
    pv.querySelector('.fwd-snip').textContent = snip;
  }
  document.querySelector('#fwd-search')?.addEventListener('input', (e) => renderFwdDests(e.target.value));
  try {
    await loadFwdDests();
    if (!S.fwdPick) {
      const firstChan = (fwdDestCache.chans || []).find((c) => !sameCtx(S.fwdSrcCtx, c));
      const firstDm = (fwdDestCache.dms || []).map((t) => ({ kind: 'dm', id: t.id })).find((p) => !sameCtx(S.fwdSrcCtx, p));
      S.fwdPick = firstChan || firstDm || null;
    }
    renderFwdDests();
  } catch { renderFwdDests(); }
}
function sendForward() {
  const pick = S.fwdPick, src = S.fwdSrc;
  if (!pick || !src) { toast('Pick a chat first'); return; }
  if (sameCtx(S.fwdSrcCtx, pick)) { toast('Pick a different chat'); return; }
  const comment = (document.querySelector('#fwd-comment')?.value || '').trim().slice(0, 2000);
  const orig = src.content || '';
  let content = comment ? (orig ? comment + '\n\n' + orig : comment) : orig;
  content = content.slice(0, 5000);
  const atts = (src.attachments || []).slice(0, 5).map((a) => ({ url: a.url, name: a.name, mime: a.mime, size: a.size, kind: a.kind, spoiler: !!a.spoiler }));
  if (!content && !atts.length) { toast('Nothing to forward'); return; }
  if (!S.ws || S.ws.readyState !== 1) { toast('Reconnecting… try again in a second'); return; }
  const fwdFrom = src.fwdFrom || (src.user ? src.user.display_name : 'Someone');
  if (pick.kind === 'dm') {
    S.ws.send(JSON.stringify({ t: 'dm', threadId: pick.id, content, attachments: atts, replyTo: null, fwdFrom }));
  } else {
    S.ws.send(JSON.stringify({ t: 'message', serverId: pick.serverId, channelId: pick.id, content, attachments: atts, replyTo: null, threadRoot: null, fwdFrom }));
  }
  toast('Forwarded');
}
function memberCtxMenu(uid, x, y) {
  const u = memberById(uid);
  if (!u) return;
  const items = [
    { label: 'View profile', icon: '👤', fn: () => openUserCard(uid, x, y) },
    { label: `Mention @${u.username}`, icon: '@', fn: () => { insertAtCursor($('#in-message'), '@' + u.username + ' '); $('#in-message').focus(); } },
  ];
  if (S.me && uid !== S.me.id) {
    if (S.view === 'server' && S.serverDetail && canManage() && uid !== S.serverDetail.owner_id) {
      items.push({ label: `Kick @${u.username}`, icon: '→', danger: true, fn: () => modServerMember('kick', u) });
      items.push({ label: `Ban @${u.username}`, icon: '⊘', danger: true, fn: () => modServerMember('ban', u) });
    } else if (S.view === 'home' && S.dmThreadId) {
      const t = S.dms.find((t) => t.id === S.dmThreadId);
      if (t && t.isGroup) modGroupItems(items, t, u);
    }
    if (isBlocked(uid)) items.push({ label: `Unblock @${u.username}`, icon: '⊘', fn: () => unblockUser(uid) });
    else items.push({ label: `Block @${u.username}`, icon: '⊘', danger: true, fn: () => blockUser(uid, u.username) });
  }
  openCtx(x, y, items);
}
async function modServerMember(kind, u) {
  const d = S.serverDetail;
  if (!d) return;
  const ok = await openConfirmModal({
    title: `${kind === 'ban' ? 'Ban' : 'Kick'} @${u.username}?`,
    message: kind === 'ban' ? 'They will be removed and blocked from rejoining with invites.' : 'They will be removed from the server.',
    okLabel: kind === 'ban' ? 'Ban' : 'Kick',
  });
  if (!ok) return;
  try {
    await api(`/api/servers/${d.id}/members/${u.id}/${kind}`, { method: 'POST' });
  } catch (err) { toast('Failed: ' + prettyError(err.message)); }
}
function modGroupItems(items, t, u) {
  if (!t.created_by || t.created_by !== S.me.id) return;
  if (u.id === t.created_by) return;
  items.push({ label: `Remove @${u.username}`, icon: '→', danger: true, fn: () => modGroupMember('remove', t, u) });
  items.push({ label: `Ban @${u.username}`, icon: '⊘', danger: true, fn: () => modGroupMember('ban', t, u) });
}
async function openChannelSettings(sid, c) {
  const slows = [[0, 'Off'], [5, '5 seconds'], [10, '10 seconds'], [30, '30 seconds'], [60, '1 minute'], [300, '5 minutes']];
  openModal(`#${c.name} settings`, `
    <label>Channel name<input id="m-chan-name" maxlength="32" value="${esc(c.name)}" /></label>
    <label style="margin-top:.6rem;display:block">Description<input id="m-chan-desc" maxlength="200" placeholder="What's this channel about?" value="${esc(c.description || '')}" /></label>
    <label style="margin-top:.6rem;display:block">Slow mode<select id="m-chan-slow">${slows.map(([v, l]) => `<option value="${v}"${(c.slowmode || 0) === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
  `, 'Save', async () => {
    const name = $('#m-chan-name').value.trim().replace(/\s+/g, '-');
    if (!name) { toast('Give the channel a name'); return; }
    await api(`/api/servers/${sid}/channels/${c.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, description: $('#m-chan-desc').value.trim(), slowmode: Number($('#m-chan-slow').value) }),
    });
    renderServerTab();
    if (sid === S.serverId) selectServer(sid);
  });
}
async function modGroupMember(kind, t, u) {
  const ok = await openConfirmModal({
    title: `${kind === 'ban' ? 'Ban' : 'Remove'} @${u.username}?`,
    message: kind === 'ban' ? 'They will be removed and blocked from being re-added.' : 'They will be removed from the group.',
    okLabel: kind === 'ban' ? 'Ban' : 'Remove',
  });
  if (!ok) return;
  try {
    await api(`/api/dms/${t.id}/members/${u.id}/${kind}`, { method: 'POST' });
    refreshDms().then(() => renderDmMembers());
  } catch (err) { toast('Failed: ' + prettyError(err.message)); }
}
const BELL_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';
const MUTE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
// Effective notification mode for the current user: first stored pref in the
// chain wins (channel → server → global), defaulting to 'all'.
function notifEffective(...scopes) {
  for (const s of scopes) if (notifPrefsCache[s]) return notifPrefsCache[s];
  return 'all';
}
function serverMuted(sid) {
  return notifEffective('s:' + sid) === 'muted';
}
function chanMuted(cid) {
  return notifEffective('c:' + cid, 's:' + S.serverId) === 'muted';
}
// Toggle item for a mute/unmute row: unmuting clears your own override, or
// overrides an inherited mute with an explicit 'all'.
function muteToggleItem(muted, ownMuted, labelBase, scope) {
  return {
    label: (muted ? 'Unmute ' : 'Mute ') + labelBase, icon: MUTE_SVG,
    fn: async () => { await setNotifPref(scope, muted ? (ownMuted ? 'inherit' : 'all') : 'muted'); renderServerList(); renderChannels(); },
  };
}
async function openServerNotifSettings(sid) {
  const s = S.servers.find((v) => v.id === sid);
  if (!s) return;
  await refreshNotifPrefs();
  const cur = notifPrefsCache['s:' + sid] || '';
  const glob = notifEffective('global');
  const opt = (v, l) => `<option value="${v}"${cur === v ? ' selected' : ''}>${l}</option>`;
  openModal(`${esc(s.name)} notifications`, `
    <p class="muted small">How should <b>${esc(s.name)}</b> notify you? This is personal — it does not change anything for other members.</p>
    <label style="margin-top:.6rem;display:block">Notify me<select id="m-notif-mode">
      ${opt('', `Use global default (currently ${NOTIF_LABEL[glob]})`)}
      ${opt('all', 'All messages')}
      ${opt('mentions', 'Mentions only')}
      ${opt('muted', 'Muted')}
    </select></label>
  `, 'Save', async () => {
    await setNotifPref('s:' + sid, $('#m-notif-mode').value || 'inherit');
    renderServerList(); renderChannels();
  });
}
async function openChannelNotifSettings(cid) {
  const c = S.serverDetail?.channels.find((v) => v.id === cid);
  if (!c) return;
  await refreshNotifPrefs();
  const cur = notifPrefsCache['c:' + cid] || '';
  const srv = notifEffective('s:' + S.serverId);
  const opt = (v, l) => `<option value="${v}"${cur === v ? ' selected' : ''}>${l}</option>`;
  openModal(`#${esc(c.name)} notifications`, `
    <p class="muted small">How should <b>#${esc(c.name)}</b> notify you? This is personal — it does not change anything for other members.</p>
    <label style="margin-top:.6rem;display:block">Notify me<select id="m-notif-mode">
      ${opt('', `Use server default (currently ${NOTIF_LABEL[srv]})`)}
      ${opt('all', 'All messages')}
      ${opt('mentions', 'Mentions only')}
      ${opt('muted', 'Muted')}
    </select></label>
  `, 'Save', async () => {
    await setNotifPref('c:' + cid, $('#m-notif-mode').value || 'inherit');
    renderChannels();
  });
}
function serverCtxMenu(sid, x, y) {
  const s = S.servers.find((v) => v.id === sid);
  if (!s) return;
  const d = S.serverDetail && S.serverDetail.id === sid ? S.serverDetail : null;
  const owner = d ? d.owner_id === S.me.id : false;
  const own = notifPrefsCache['s:' + sid] || '';
  openCtx(x, y, [
    { label: 'Open', icon: '→', fn: () => selectServer(sid) },
    { label: 'Copy invite link', icon: '⧉', fn: () => { try { navigator.clipboard.writeText(`${location.origin}/invite/${s.invite_code}`); toast('Link copied'); } catch {} } },
    { label: 'Server settings', icon: '⚙', fn: async () => { if (sid !== S.serverId) await selectServer(sid); openServerSettings(); } },
    { sep: true },
    muteToggleItem(serverMuted(sid), own === 'muted', 'server', 's:' + sid),
    { label: 'Notification settings', icon: BELL_SVG, fn: () => openServerNotifSettings(sid) },
  ]);
}
function channelCtxMenu(cid, ctype, x, y) {
  const c = S.serverDetail?.channels.find((v) => v.id === cid);
  if (!c) return;
  const owner = canManage();
  const items = ctype === 'voice'
    ? [{ label: 'Join voice', icon: '→', fn: () => openVoiceChannel(S.serverId, cid) }]
    : [{ label: 'Open channel', icon: '→', fn: () => selectChannel(cid) }];
  items.push({ label: 'Copy name', icon: '⧉', fn: () => { try { navigator.clipboard.writeText(c.name); toast('Copied'); } catch {} } });
  if (ctype === 'text') {
    const own = notifPrefsCache['c:' + cid] || '';
    items.push({ sep: true });
    items.push(muteToggleItem(chanMuted(cid), own === 'muted', '#' + c.name, 'c:' + cid));
    items.push({ label: 'Notification settings', icon: BELL_SVG, fn: () => openChannelNotifSettings(cid) });
  }
  if (owner) items.push({ label: 'Delete channel', icon: '🗑', danger: true, fn: () => confirmDeleteChannel(c) });
  openCtx(x, y, items);
}
function ctxFor(el, x, y) {
  if (!el || !el.closest) return false;
  const msg = el.closest('.msg[data-mid]');
  if (msg) { messageCtxMenu(msg.dataset.mid, x, y); return true; }
  const vu = el.closest('.vuser[data-uid]');
  if (vu && vu.dataset.uid) { openUserCard(vu.dataset.uid, x, y); return true; }
  const mem = el.closest('.member[data-uid]');
  if (mem && mem.dataset.uid) { memberCtxMenu(mem.dataset.uid, x, y); return true; }
  const fb = el.closest('.folder-btn');
  if (fb && fb.dataset.fid) { openFolderMenu(fb.dataset.fid, x, y); return true; }
  const sb = el.closest('.server-btn');
  if (sb && sb.dataset.sid) { serverCtxMenu(sb.dataset.sid, x, y); return true; }
  const dmr = el.closest('[data-dmthread]');
  if (dmr && dmr.dataset.dmthread) { dmCtxMenu(dmr.dataset.dmthread, x, y); return true; }
  const ch = el.closest('.chan');
  if (ch && ch.dataset.cid) { channelCtxMenu(ch.dataset.cid, ch.dataset.ctype || 'text', x, y); return true; }
  return false;
}
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"], a')) return;
  if (isCoarse() && e.target.closest && e.target.closest('.msg[data-mid]')) { e.preventDefault(); return; } // touch sheet owns message long-press
  if (ctxFor(e.target, e.clientX, e.clientY)) e.preventDefault();
});
// touch-hold (long press): bottom sheet for messages, popup menus elsewhere
let holdT = null;
let holdSheet = false; // long-press opened the sheet: swallow the lift-off click
let holdMenu = false; // long-press opened a ctx menu: swallow the lift-off click too
let holdX = 0, holdY = 0; // finger jitter must not cancel a hold; only real moves do
// (non-passive so preventDefault() can cancel the synthetic click)
document.addEventListener('touchend', (e) => {
  if (holdSheet) { holdSheet = false; try { e.preventDefault(); } catch {} }
  if (holdMenu) { holdMenu = false; try { e.preventDefault(); } catch {} }
}, { passive: false });
document.addEventListener('touchstart', (e) => {
  if (!e.target.closest || e.target.closest('input, textarea, select, a')) return;
  const t = e.target.closest('.msg,.chan,.member,.server-btn,.vuser,[data-dmthread]');
  if (!t) return;
  const touch = e.touches[0];
  const x = touch.clientX, y = touch.clientY;
  holdX = x; holdY = y;
  holdMenu = false;
  holdT = setTimeout(() => {
    holdT = null;
    try { navigator.vibrate && navigator.vibrate(10); } catch {}
    const mt = t.closest('.msg[data-mid]');
    if (mt && isCoarse()) { holdSheet = true; openMsgSheet(mt.dataset.mid); }
    else if (ctxFor(t, x, y)) holdMenu = true;
  }, 550);
}, { passive: true });
['touchend', 'touchcancel'].forEach((ev) => document.addEventListener(ev, () => { clearTimeout(holdT); holdT = null; }, { passive: true }));
// touchmove only cancels a hold on a real move (finger jitter is normal)
document.addEventListener('touchmove', (e) => {
  const t = e.touches && e.touches[0];
  if (t && Math.hypot(t.clientX - holdX, t.clientY - holdY) > 12) { clearTimeout(holdT); holdT = null; }
}, { passive: true });

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
  folders.forEach((f) => {
    // Folders hold servers only: strip stale ids (and folder ids most of
    // all) before persisting, so nesting can never be saved.
    f.servers = (f.servers || []).filter((sid) => S.servers.some((s) => s.id === sid));
    f.servers.forEach((sid, i) => pos.set(sid, { folderId: f.id, position: i }));
  });
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
  // No nested folders, ever: a dragged folder can only reorder at root, so a
  // folder-on-folder drop lands after the target instead of inside it.
  if (dd.kind === 'folder' && t.zone === 'folder') t = { zone: 'after-folder', id: t.id };
  if (dd.kind === 'server') {
    if (t.zone === 'folder') {
      const f = folderById(t.id);
      if (!f) return;
      detachServer(dd.id);
      if (!f.servers.includes(dd.id)) f.servers.push(dd.id);
      f.open = true;
    } else if (t.zone === 'before-folder' || t.zone === 'after-folder') {
      // Gap drop beside a whole folder: land at root next to it (this is
      // how servers leave an open folder without aiming at a thin line).
      const fi = S.rootOrder.findIndex((it) => it.kind === 'folder' && it.id === t.id);
      if (fi < 0) return;
      detachServer(dd.id);
      S.rootOrder.splice(fi + (t.zone === 'after-folder' ? 1 : 0), 0, { kind: 'server', id: dd.id });
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
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
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
  el.addEventListener('dragleave', (e) => {
    // Moving between buttons/gaps inside the rail just hands the marker to
    // the next target — only clear when actually leaving the rail.
    try {
      if (e.relatedTarget && document.querySelector('#server-list')?.contains(e.relatedTarget)) return;
    } catch {}
    el.classList.remove('drop-combine'); hideMarker();
  });
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
// The whole rail is a drop surface (not just the list): rail gaps above the
// first item, below the last, and around the spacer would otherwise swallow
// drops silently. Gaps between top-level items mean root; gaps inside an
// open folder's box mean that folder.
$('#rail').addEventListener('dragover', (e) => {
  if (!dragPayload) return;
  if (e.target.closest && e.target.closest('[data-drag]')) return; // button handlers own direct hovers
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  clearDropMarks();
  // Inside an open folder's box? Nearest child decides (stays in folder) —
  // except the tinted padding strips above the first / below the last child:
  // when dragging one of that folder's own servers those strips eject to
  // root, so leaving never needs pixel-perfect aim. Anywhere else outside
  // boxes? Nearest top-level unit decides (root level).
  const box = e.target.closest ? e.target.closest('.folder-children') : null;
  let cands = [];
  let boxExit = null; // {fid} when the strips mean "leave this folder"
  if (box) {
    const kids = [...box.querySelectorAll('[data-drag]')];
    const wrap = box.closest('.folder-wrap');
    const fid = wrap ? (wrap.querySelector('[data-fid]') || {}).dataset?.fid : null;
    const ownKid = fid && dragPayload.kind === 'server' && (() => { const c = containerOf(dragPayload.id); return c.type === 'folder' && c.f.id === fid; })();
    if (ownKid && kids.length) {
      const first = kids[0].getBoundingClientRect(), last = kids[kids.length - 1].getBoundingClientRect();
      if (e.clientY < first.top) boxExit = { fid, edge: 'before' };
      else if (e.clientY > last.bottom) boxExit = { fid, edge: 'after' };
    }
    if (!boxExit) cands = kids.map((el) => ({ el, fid: null }));
  } else {
    for (const child of document.querySelectorAll('#server-list > *')) {
      if (child.dataset && child.dataset.drag) {
        cands.push({ el: child, fid: null });
      } else if (child.classList && child.classList.contains('folder-wrap')) {
        const fb = child.querySelector('[data-fid]');
        if (fb) cands.push({ el: child, fid: fb.dataset.fid });
      }
    }
  }
  let best = null, bestDist = Infinity, bestEdge = 'after';
  for (const c of cands) {
    const r = c.el.getBoundingClientRect();
    if (!r.height) continue;
    const mid = r.top + r.height / 2;
    const d = Math.abs(e.clientY - mid);
    if (d < bestDist) { bestDist = d; best = c; bestEdge = e.clientY < mid ? 'before' : 'after'; }
  }
  if (boxExit) {
    const wrap = box.closest('.folder-wrap');
    dropTarget = { zone: boxExit.edge + '-folder', id: boxExit.fid };
    if (wrap) showMarker(wrap.getBoundingClientRect(), boxExit.edge);
    return;
  }
  if (!best) { hideMarker(); dropTarget = null; return; }
  if (best.fid) {
    dropTarget = { zone: bestEdge + '-folder', id: best.fid };
  } else {
    dropTarget = { zone: bestEdge, id: best.el.dataset.drag.split(':')[1] };
  }
  showMarker(best.el.getBoundingClientRect(), bestEdge);
});
$('#rail').addEventListener('drop', (e) => {
  if (!dragPayload || (e.target.closest && e.target.closest('[data-drag]'))) return;
  e.preventDefault();
  const dd = dragPayload, t = dropTarget;
  dragPayload = null; dropTarget = null; hideMarker(); clearDropMarks();
  if (dd && t) { applyDrop(dd, t); return; } // gap drop with a snapped target
  if (!dd) return;
  if (dd.kind === 'server') { detachServer(dd.id); S.rootOrder.push({ kind: 'server', id: dd.id }); }
  else {
    const from = S.rootOrder.findIndex((it) => it.kind === 'folder' && it.id === dd.id);
    if (from >= 0) { const [mv] = S.rootOrder.splice(from, 1); S.rootOrder.push(mv); }
  }
  normalizeAndSave();
});
function closeFolderMenu() { if (folderMenuEl) { folderMenuEl.remove(); folderMenuEl = null; } }
async function renameFolder(fid) {
  const f = folderById(fid);
  if (!f) return;
  const n = await openPromptModal({ title: 'Rename folder', label: 'Folder name', initial: f.name, placeholder: 'e.g. Favorites', okLabel: 'Save', maxlength: 32 });
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

/* ================= home: friends + DMs ================= */
function dmPeer(t) { return (t.members || []).find((m) => m.id !== S.me.id) || null; }
function dmTitle(t) { return t.isGroup ? (t.name || 'Group chat') : ((dmPeer(t) || {}).display_name || 'Direct message'); }
function openServerView() {
  S.view = 'server';
  S.callOpen = false;
  $('#chat').classList.remove('call-open');
  document.body.classList.remove('view-home', 'dm-open');
  $('#friends-page').classList.add('hidden');
  $('#messages').classList.remove('hidden');
  $('#server-ui').classList.remove('hidden');
  $('#home-ui').classList.add('hidden');
  $('#btn-home').classList.remove('active');
}
async function openHome() {
  closeServerSettings();
  S.view = 'home';
  S.callOpen = false;
  $('#chat').classList.remove('call-open');
  document.body.classList.add('view-home');
  document.body.classList.remove('nav-open');
  $('#server-ui').classList.add('hidden');
  $('#home-ui').classList.remove('hidden');
  $('#btn-home').classList.add('active');
  document.querySelectorAll('#server-list .server-btn').forEach((b) => b.classList.remove('active'));
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
function dmUnreadTotal() {
  let n = 0;
  for (const c of S.dmUnread.values()) n += c;
  return n;
}
// Red count on the campfire home button: unread DMs + incoming friend requests.
function paintHomeBadge() {
  const b = $('#home-badge');
  if (!b) return;
  const n = dmUnreadTotal() + ((S.friends && S.friends.pendingIn) || []).length;
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
  const div = document.createElement('div');
  div.className = 'dmrow';
  div.innerHTML = `<span class="avatar"></span><span class="dmmain"><span class="dmname" style="${nameStyleFor(u)}">${esc(u.display_name)}</span><br/><span class="dmlast">@${esc(u.username)}${u.status_text ? ' · ' + esc(u.status_text) : ''}</span></span>`;
  paintAvatar(div.querySelector('.avatar'), u);
  const dot = document.createElement('span');
  dot.className = 'status-dot ' + statusOf(u.id);
  div.appendChild(dot);
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
function friendBtnHTML(uid) {
  const st = friendState(uid);
  if (st === 'friend') return '<button class="btn small danger" id="uc-friend">Unfriend</button>';
  if (st === 'pending-out') return '<button class="btn small" id="uc-friend">Cancel request</button>';
  if (st === 'pending-in') return '<button class="btn small primary" id="uc-friend">Accept request</button>';
  return '<button class="btn small" id="uc-friend">Add friend</button>';
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
    const list = S.friendTab === 'online' ? f.friends.filter((u) => statusOf(u.id) !== 'offline') : f.friends;
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
}
function dmRowEl(t) {
  const b = document.createElement('button');
  b.className = 'dmrow' + (t.id === S.dmThreadId ? ' active' : '');
  b.dataset.dmthread = t.id;
  const av = t.isGroup ? null : dmPeer(t);
  b.innerHTML = `<span class="avatar">${t.isGroup ? '#' : ''}</span><span class="dmmain"><span class="dmname" style="${!t.isGroup && av ? nameStyleFor(av) : ''}">${esc(dmTitle(t))}</span><br/><span class="dmlast">${esc(t.last ? `${t.last.author}: ${t.last.content}`.slice(0, 60) : 'No messages yet')}</span></span>`;
  if (av) paintAvatar(b.querySelector('.avatar'), av);
  else { const a = b.querySelector('.avatar'); a.style.background = 'var(--panel-3)'; }
  if (av && av.sidebar_banner_url && statusOf(av.id) !== 'offline') {
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
      if (S.dmThreadId === tid) { S.dmThreadId = null; renderDmBlank(); }
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
/* ================= pins + jump-to-present ================= */
function pinsCtx() {
  if (S.view === 'home') return S.dmThreadId ? { kind: 'dm', id: S.dmThreadId } : null;
  return (S.serverId && S.channelId) ? { kind: 'server', id: S.channelId, serverId: S.serverId } : null;
}
function pinsUrl(ctx, suffix = '') {
  return ctx.kind === 'dm' ? `/api/dms/${ctx.id}/pins${suffix}` : `/api/servers/${ctx.serverId}/channels/${ctx.id}/pins${suffix}`;
}
function sameCtx(a, b) { return !!a && !!b && a.kind === b.kind && a.id === b.id; }
async function refreshPinsCount() {
  const ctx = pinsCtx();
  if (!ctx) { S.pinCount = 0; S.pinIds = new Set(); paintPinsBtn(); return; }
  try {
    const { pins } = await api(pinsUrl(ctx));
    if (!sameCtx(pinsCtx(), ctx)) return;
    S.pinCount = pins.length;
    S.pinIds = new Set(pins.map((p) => p.id));
  } catch { S.pinCount = 0; S.pinIds = new Set(); }
  paintPinsBtn();
}
function paintPinsBtn() {
  $('#btn-pins').classList.toggle('hidden', !pinsCtx());
  const b = $('#pins-count');
  b.textContent = S.pinCount > 0 ? String(S.pinCount) : '';
  b.classList.toggle('hidden', !S.pinCount);
}
async function togglePin(mid) {
  const ctx = pinsCtx();
  if (!ctx) return;
  const pinned = S.pinIds.has(mid);
  try {
    if (pinned) await api(pinsUrl(ctx, '/' + mid), { method: 'DELETE' });
    else await api(pinsUrl(ctx), { method: 'POST', body: JSON.stringify({ messageId: mid }) });
    toast(pinned ? 'Unpinned' : 'Pinned to this ' + (ctx.kind === 'dm' ? 'chat' : 'channel'));
    refreshPinsCount();
  } catch (err) { toast(prettyError(err.message)); }
}
async function openPins() {
  const ctx = pinsCtx();
  if (!ctx) return;
  S.pinsCtx = ctx;
  openModal('Pinned messages', '<div class="pins-list"><p class="muted small" style="text-align:center;padding:1rem">Loading…</p></div>', 'Close', null, { wide: true });
  await renderPinsList();
}
async function renderPinsList() {
  const ctx = S.pinsCtx;
  const box = document.querySelector('#modal-body .pins-list');
  if (!ctx || !box) return;
  let pins = [];
  try { ({ pins } = await api(pinsUrl(ctx))); }
  catch { box.innerHTML = '<p class="error">Could not load pins.</p>'; return; }
  if (!sameCtx(pinsCtx(), ctx)) return;
  S.pinCount = pins.length;
  S.pinIds = new Set(pins.map((p) => p.id));
  paintPinsBtn();
  if (!pins.length) { box.innerHTML = '<p class="muted small" style="text-align:center;padding:1rem">No pinned messages yet — right-click (or long-press) a message to pin it.</p>'; return; }
  box.innerHTML = '';
  for (const p of pins) {
    const row = document.createElement('div');
    row.className = 'pin-row';
    const text = p.content ? (p.content.length > 220 ? p.content.slice(0, 220) + '…' : p.content)
      : (p.attachments?.length ? `[${p.attachments.length} attachment${p.attachments.length === 1 ? '' : 's'}]` : '[no text]');
    row.innerHTML = '<span class="avatar"></span><div class="pin-main"><div class="pin-head"><span class="who"></span><span class="when"></span></div><div class="pin-text"></div><div class="pin-meta"></div></div>';
    const who = row.querySelector('.who');
    who.textContent = p.user ? p.user.display_name : 'deleted';
    if (p.user) who.style.cssText = nameStyleFor(p.user);
    row.querySelector('.when').textContent = fmtTime(p.created_at);
    row.querySelector('.pin-text').textContent = text;
    row.querySelector('.pin-meta').textContent = 'Pinned by ' + (p.pinned_by ? p.pinned_by.display_name : '?');
    paintAvatar(row.querySelector('.avatar'), p.user);
    const btns = document.createElement('div');
    btns.className = 'pin-btns';
    const jump = document.createElement('button');
    jump.className = 'mini'; jump.textContent = 'Jump';
    jump.onclick = () => { S.pinsCtx = null; cancelModal(); jumpToPin(ctx, p.id); };
    btns.appendChild(jump);
    if (ctx.kind === 'dm' || (p.pinned_by && p.pinned_by.id === S.me.id) || canManage()) {
      const un = document.createElement('button');
      un.className = 'mini danger'; un.textContent = 'Unpin';
      un.onclick = async () => {
        try { await api(pinsUrl(ctx, '/' + p.id), { method: 'DELETE' }); }
        catch (err) { toast(prettyError(err.message)); return; }
        renderPinsList();
      };
      btns.appendChild(un);
    }
    row.appendChild(btns);
    box.appendChild(row);
  }
}
function flashMsgEl(el) {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}
async function jumpToPin(ctx, mid) {
  const sel = `#messages [data-mid="${CSS.escape(mid)}"]`;
  const el = document.querySelector(sel);
  if (el) { flashMsgEl(el); return; }
  let msgs = [];
  try {
    const url = ctx.kind === 'dm'
      ? `/api/dms/${ctx.id}/messages?limit=60&around=${encodeURIComponent(mid)}`
      : `/api/servers/${ctx.serverId}/channels/${ctx.id}/messages?limit=60&around=${encodeURIComponent(mid)}`;
    ({ messages: msgs } = await api(url));
  } catch { toast('Message not found'); return; }
  if (!sameCtx(pinsCtx(), ctx)) return;
  if (ctx.kind === 'dm') S.dmMessages.set(ctx.id, msgs);
  else S.messages.set(ctx.id, msgs);
  S.histMode = { ...ctx };
  S.histNew = 0;
  if (ctx.kind === 'dm') renderDmMessages();
  else renderMessages();
  requestAnimationFrame(() => {
    const target = document.querySelector(sel);
    if (target) flashMsgEl(target);
    updatePill();
  });
}
function jumpToPresent() {
  const box = $('#messages');
  S.histNew = 0;
  if (S.histMode) {
    const ctx = S.histMode;
    S.histMode = null;
    updatePill();
    reloadLatest(ctx);
  } else {
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
    updatePill();
  }
}
async function reloadLatest(ctx) {
  try {
    if (ctx.kind === 'dm') {
      const { messages } = await api(`/api/dms/${ctx.id}/messages?limit=80`);
      if (!sameCtx(pinsCtx(), ctx)) return;
      S.dmMessages.set(ctx.id, messages);
      renderDmMessages(true);
    } else {
      const { messages } = await api(`/api/servers/${ctx.serverId}/channels/${ctx.id}/messages?limit=80`);
      if (!sameCtx(pinsCtx(), ctx)) return;
      S.messages.set(ctx.id, messages);
      renderMessages(true);
    }
  } catch { toast('Could not load messages'); }
  updatePill();
}
function updatePill() {
  const pill = $('#jump-present'), box = $('#messages');
  if (!pill || !box) return;
  if (!pinsCtx() || box.classList.contains('hidden')) { pill.classList.add('hidden'); return; }
  if (S.histMode) {
    $('#jp-text').textContent = "You're viewing older messages · Jump to present";
    pill.classList.remove('hidden');
    return;
  }
  const dist = box.scrollHeight - box.scrollTop - box.clientHeight;
  if (dist > 400) {
    $('#jp-text').textContent = S.histNew > 0
      ? `${S.histNew} new message${S.histNew === 1 ? '' : 's'}`
      : 'Jump to present';
    pill.classList.remove('hidden');
  } else {
    S.histNew = 0;
    pill.classList.add('hidden');
  }
}
function renderTopic() {
  const el = $('#chan-topic');
  const ch = S.view === 'server' ? (S.serverDetail?.channels || []).find((c) => c.id === S.channelId) : null;
  const desc = (ch?.description || '').trim();
  if (desc) {
    el.textContent = desc;
    el.title = desc;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.title = '';
    el.classList.add('hidden');
  }
}
$('#chan-topic').onclick = () => {
  const ch = (S.serverDetail?.channels || []).find((c) => c.id === S.channelId);
  const desc = (ch?.description || '').trim();
  if (desc) openModal(`#${ch.name}`, `<p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(desc)}</p>`, 'Close', null);
};
async function selectDmThread(id) {
  S.dmThreadId = id;
  // Opening a thread clears its unread badge (row + home button).
  if (S.dmUnread.delete(id)) paintHomeBadge();
  renderDmLists();
  S.callOpen = false;
  document.body.classList.remove('nav-open');
  $('#chat').classList.remove('call-open');
  renderStage();
  document.querySelectorAll('.dmrow').forEach((b) => b.classList.toggle('active', b.dataset.dmthread === id));
  const t = S.dms.find((x) => x.id === id);
  if (!t) { renderDmBlank(); return; }
  document.body.classList.add('dm-open');
  $('#composer').classList.remove('hidden');
  $('#friends-page').classList.add('hidden');
  $('#messages').classList.remove('hidden');
  renderDmMembers();
  renderTopic();
  $('#chan-hash').textContent = t.isGroup ? '' : '@';
  const peer = dmPeer(t);
  $('#chan-name').textContent = t.isGroup ? (t.name || 'Group chat') : ((peer || {}).display_name || 'DM');
  $('#typing').textContent = '';
  $('#in-message').placeholder = t.isGroup ? `Message ${t.name || 'group'}` : `Message @${(peer || {}).username || ''}`;
  S.replyTo = null; S.pendingAtts = []; S.editing = null;
  renderComposerMeta();
  $('#messages').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { messages } = await api(`/api/dms/${id}/messages?limit=80`);
    if (S.dmThreadId !== id) return;
    S.dmMessages.set(id, messages);
    S.histMode = null;
    S.histNew = 0;
    renderDmMessages(true);
    refreshPinsCount();
    updatePill();
  } catch { $('#messages').innerHTML = '<p class="error">Could not load messages.</p>'; }
}
function renderDmBlank() {
  document.body.classList.remove('dm-open');
  S.histMode = null;
  S.histNew = 0;
  // Friends screen has no conversation: clear any stale pins state so the
  // header pins icon from the previous channel/DM doesn't linger.
  S.pinCount = 0; S.pinIds = new Set(); paintPinsBtn();
  updatePill();
  document.body.classList.remove('dm-open');
  $('#composer').classList.add('hidden');
  $('#messages').classList.add('hidden');
  $('#friends-page').classList.remove('hidden');
  $('#chan-hash').textContent = '';
  $('#chan-name').textContent = 'Friends';
  $('#typing').textContent = '';
  renderTopic();
}
function renderDmMessages(force = false) {
  const box = $('#messages');
  const msgs = S.dmMessages.get(S.dmThreadId) || [];
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
  updatePill();
}
function sendDm(content, opts = {}) {
  if (!S.dmThreadId) return;
  if (S.ws && S.ws.readyState === 1) {
    S.ws.send(JSON.stringify({ t: 'dm', threadId: S.dmThreadId, content, attachments: opts.attachments || [], replyTo: opts.replyTo || null }));
    renderDmMessages(true);
  } else toast('Reconnecting… try again in a second');
}
// ---------- voice messages (record → attach → Send) ----------
let recSt = null; // {rec, stream, chunks, t0, timer, cancelled}
const REC_MAX_MS = 5 * 60 * 1000;
function recMime() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  try {
    return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  } catch { return ''; }
}
async function startVoiceRec() {
  if (recSt) { toast('Already recording'); return; }
  if (!composerTargetReady()) { toast('Pick a chat first, then record'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { toast('Microphone blocked — allow mic access to record'); return; }
  const mt = recMime();
  let rec;
  try { rec = new MediaRecorder(stream, mt ? { mimeType: mt } : undefined); }
  catch { try { stream.getTracks().forEach((t) => t.stop()); } catch {} toast('Recording is not supported here'); return; }
  recSt = { rec, stream, chunks: [], t0: Date.now(), timer: null, cancelled: false };
  rec.ondataavailable = (e) => { if (recSt && e.data && e.data.size) recSt.chunks.push(e.data); };
  rec.onstop = finishVoiceRec;
  try { rec.start(); } catch { cancelVoiceRec(); return; }
  paintRecBar();
  recSt.timer = setInterval(() => {
    if (!recSt) return;
    paintRecTime();
    if (Date.now() - recSt.t0 >= REC_MAX_MS) stopVoiceRec(); // cap: auto-finish
  }, 500);
}
function paintRecBar() {
  const bar = $('#rec-bar');
  if (!bar) return;
  bar.classList.toggle('hidden', !recSt);
  paintRecTime();
}
function paintRecTime() {
  const t = $('#rec-time');
  if (t) t.textContent = fmtClock(recSt ? (Date.now() - recSt.t0) / 1000 : 0);
}
function stopVoiceRec() {
  if (recSt && !recSt.cancelled) { try { recSt.rec.stop(); } catch {} }
}
function cancelVoiceRec() {
  if (!recSt) return;
  recSt.cancelled = true;
  try { recSt.rec.stop(); } catch { finishVoiceRec(); }
}
function finishVoiceRec() {
  const st = recSt;
  recSt = null;
  if (st) {
    if (st.timer) clearInterval(st.timer);
    try { st.stream.getTracks().forEach((t) => t.stop()); } catch {}
  }
  paintRecBar();
  if (!st || st.cancelled || !st.chunks.length) return;
  const type = String((st.rec.mimeType || 'audio/webm')).split(';')[0] || 'audio/webm';
  const file = new File(st.chunks, 'voice-message.' + (type === 'audio/mp4' ? 'm4a' : 'webm'), { type });
  if (!composerTargetReady()) { toast('Pick a chat first, then record'); return; }
  uploadAndAttach(file);
  $('#in-message').focus();
}
// ---------- polls ----------
function sendPoll(question, options) {
  question = String(question || '').trim().slice(0, 200);
  options = [...new Set((options || []).map((o) => String(o || '').trim().slice(0, 60)).filter(Boolean))].slice(0, 8);
  if (!question || options.length < 2) return;
  if (!S.ws || S.ws.readyState !== 1) { toast('Reconnecting… try again in a second'); return; }
  if (S.view === 'home') {
    if (!S.dmThreadId) { toast('Pick a chat first'); return; }
    S.ws.send(JSON.stringify({ t: 'dm', threadId: S.dmThreadId, content: question, attachments: [], replyTo: null, poll: { options } }));
    renderDmMessages(true);
  } else {
    if (!S.serverId || !S.channelId) { toast('Pick a chat first'); return; }
    S.ws.send(JSON.stringify({ t: 'message', serverId: S.serverId, channelId: S.channelId, content: question, attachments: [], replyTo: null, threadRoot: null, poll: { options } }));
    renderMessages(true);
  }
}
function openPollModal(q = '', opts = []) {
  const cur = opts.length ? opts : ['', ''];
  openModal('Create a poll', `
    <label>Question<input id="m-poll-q" maxlength="200" placeholder="What should we ask?" value="${esc(q)}" /></label>
    <div id="m-poll-opts" style="margin-top:.6rem;display:flex;flex-direction:column;gap:.4rem">
      ${cur.map((o, i) => `<input class="m-poll-opt" maxlength="60" placeholder="Option ${i + 1}" value="${esc(o)}" />`).join('')}
    </div>
    <div class="row" style="margin-top:.5rem"><button type="button" class="btn small" id="m-poll-add">Add option</button></div>
    <p class="muted small">2–8 options · one vote per person · tap your vote again to take it back</p>
  `, 'Post poll', () => {
    const question = ($('#m-poll-q') || {}).value.trim();
    const options = [...document.querySelectorAll('.m-poll-opt')].map((i) => i.value.trim()).filter(Boolean);
    if (!question || options.length < 2) {
      toast(!question ? 'Ask a question first' : 'Add at least 2 options');
      setTimeout(() => openPollModal(question, [...document.querySelectorAll('.m-poll-opt')].map((i) => i.value)), 0);
      return;
    }
    sendPoll(question, options);
  });
  $('#m-poll-add').onclick = () => {
    const box = $('#m-poll-opts');
    const n = box.querySelectorAll('.m-poll-opt').length;
    if (n >= 8) { toast('Max 8 options'); return; }
    const inp = document.createElement('input');
    inp.className = 'm-poll-opt'; inp.maxLength = 60; inp.placeholder = `Option ${n + 1}`;
    box.appendChild(inp);
    inp.focus();
  };
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
function openPicker(mode = 'insert', mid = null, tab = 'emoji', anchor = null) {
  S.picker = { mode, mid };
  const pk = $('#picker');
  pk.classList.remove('hidden');
  if (anchor && !matchMedia('(max-width: 700px)').matches) {
    // reaction picker: float near the button that opened it (desktop only;
    // mobile keeps the bottom-sheet). Prefer above, fall back below, clamped.
    pk.classList.add('anchored');
    const w = Math.min(360, innerWidth - 16), h = 380;
    const left = Math.min(Math.max(8, anchor.x - w / 2), Math.max(8, innerWidth - w - 8));
    let top = anchor.y - h - 10;
    if (top < 8) top = anchor.y + 12;
    if (top + h > innerHeight - 8) top = Math.max(8, innerHeight - h - 8);
    pk.style.left = left + 'px';
    pk.style.top = top + 'px';
  } else {
    pk.classList.remove('anchored');
    pk.style.left = ''; pk.style.top = '';
  }
  setPickerTab(tab);
  document.querySelector('#picker .pk-tabs').style.display = mode === 'react' ? 'none' : '';
  $('#pk-search').value = '';
  renderEmojiGrid('');
  ensureEmojiData().then(() => { if (S.picker) renderEmojiGrid($('#pk-search').value); });
  if (mode !== 'react') loadGifTrending();
  setTimeout(() => $('#pk-search').focus(), 0);
}
function closePicker() { $('#picker').classList.add('hidden'); S.picker = null; S.gifPick = null; }
S.gifPick = null; // 'avatar'|'banner' when the GIF picker is choosing profile media
function setPickerTab(t) {
  document.querySelectorAll('.pk-tab').forEach((b) => b.classList.toggle('active', b.dataset.ptab === t));
  $('#pk-emoji').classList.toggle('hidden', t !== 'emoji');
  $('#pk-gifs').classList.toggle('hidden', t !== 'gifs');
  $('#pk-klipy').classList.toggle('hidden', t !== 'gifs');
  $('#pk-search').placeholder = t === 'gifs' ? 'Search KLIPY' : 'Search emoji';
}
document.querySelectorAll('.pk-tab').forEach((b) => (b.onclick = () => { setPickerTab(b.dataset.ptab); applyPickerSearch($('#pk-search').value || ''); }));
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
  else { bumpFreq(e); insertAtCursor($('#in-message'), e); }
  closePicker();
  $('#in-message').focus();
}
function insertAtCursor(input, text) {
  const s = input.selectionStart ?? input.value.length, e = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, s) + text + input.value.slice(e);
  input.selectionStart = input.selectionEnd = s + text.length;
  syncComposerRender();
}
let gifSearchT = null;
function applyPickerSearch(q) {
  const gifsActive = document.querySelector('.pk-tab.active')?.dataset.ptab === 'gifs';
  if (gifsActive && S.picker?.mode !== 'react') {
    clearTimeout(gifSearchT);
    if (!q.trim()) { loadGifTrending(); return; }
    gifSearchT = setTimeout(() => loadGifSearch(q.trim()), 350);
  } else {
    renderEmojiGrid(q);
  }
}
$('#pk-search').addEventListener('input', (e) => applyPickerSearch(e.target.value));
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
  const url = g.gif || g.mp4;
  const pick = S.gifPick;
  closePicker();
  if (pick === 'avatar' || pick === 'banner' || pick === 'sidebar') { if (url) applyProfileUrl(pick, url); return; }
  if (S.view === 'home') {
    if (!S.dmThreadId || !url) return;
    sendDm('', { attachments: [{ url, name: (g.title || 'gif').slice(0, 80) + '.gif', mime: 'image/gif', size: 0, kind: 'image' }] });
    return;
  }
  if (!S.serverId || !S.channelId || !url) return;
  sendChat('', { attachments: [{ url, name: (g.title || 'gif').slice(0, 80) + '.gif', mime: 'image/gif', size: 0, kind: 'image' }] });
}

// ---------- reactions / reply / edit / thread actions ----------
async function toggleReaction(mid, emoji) {
  const dm = msgById(mid)?._dm;
  const base = dm ? '/api/dms/messages/' : '/api/messages/';
  try {
    const { reactions } = await api(base + mid + '/reactions', { method: 'POST', body: JSON.stringify({ emoji }) });
    bumpFreq(emoji);
    updateMsgInCaches(mid, (m) => { m.reactions = reactions.map((r) => ({ emoji: r.emoji, count: r.count, me: r.me })); });
    if (S.view === 'home') { if (S.dmThreadId) renderDmMessages(); }
    else if (S.channelId) renderMessages();
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
  if (S.view === 'home' && S.dmThreadId) renderDmMessages();
  if (S.thread) renderThread();
  setTimeout(() => { const t = $('#edit-area'); if (t) { t.focus(); t.selectionStart = t.value.length; } }, 0);
}
async function saveEdit(mid) {
  const t = $('#edit-area');
  const content = (t?.value || '').trim();
  if (!content) return;
  S.editing = null;
  const base = msgById(mid)?._dm ? '/api/dms/messages/' : '/api/messages/';
  try { await api(base + mid, { method: 'PATCH', body: JSON.stringify({ content }) }); }
  catch (err) { toast('Edit failed: ' + prettyError(err.message)); if (S.channelId) renderMessages(); }
}
// global delegation for message interactions
 document.addEventListener('click', (e) => {
  const uidEl = e.target.closest('[data-uid]');
  const actEl = e.target.closest('[data-act]');
  const jumpEl = e.target.closest('[data-jump]');
  const reactEl = e.target.closest('.reaction');
  const imgEl = e.target.closest('.att-img,.embed-img');
  const memberEl = e.target.closest('.member');
  if (reactEl && reactEl.dataset.emoji) {
    const msgEl = reactEl.closest('[data-mid]');
    if (msgEl) toggleReaction(msgEl.dataset.mid, reactEl.dataset.emoji);
    return;
  }
  const spEl = e.target.closest('.spoiler');
  const ytBtn = e.target.closest('[data-yt-play]');
  if (ytBtn) {
    const wrap = ytBtn.closest('.embed');
    const src = ytBtn.getAttribute('data-yt-play');
    if (wrap && src && !wrap.querySelector('iframe')) {
      const f = document.createElement('iframe');
      f.className = 'embed-frame yt-player';
      f.src = src;
      f.title = 'YouTube video';
      f.loading = 'lazy';
      f.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
      f.allowFullscreen = true;
      ytBtn.replaceWith(f);
    }
    return;
  }
  if (spEl && !spEl.classList.contains('shown') && spEl.closest('.msg .text,.uc-bio')) { spEl.classList.add('shown'); return; }
  const spVeil = e.target.closest('.spoiler-veil');
  if (spVeil) { spVeil.closest('.att-wrap')?.classList.add('shown'); return; }
  if (imgEl) {
    const spWrap = imgEl.closest('.att-wrap.spoiler:not(.shown)');
    if (spWrap) { spWrap.classList.add('shown'); return; }
    openLightbox(imgEl.src); return;
  }
  if (jumpEl) { jumpToMessage(jumpEl.dataset.jump); return; }
  if (actEl) {
    const msgEl = actEl.closest('[data-mid]');
    const mid = msgEl?.dataset.mid;
    const act = actEl.dataset.act;
    if (act === 'react' && mid) {
      if (actEl.dataset.emoji) toggleReaction(mid, actEl.dataset.emoji);
      else openPicker('react', mid, 'emoji', { x: e.clientX, y: e.clientY });
    }
    else if (act === 'more' && mid) openPicker('react', mid, 'emoji', { x: e.clientX, y: e.clientY });
    else if (act === 'menu' && mid) messageCtxMenu(mid, e.clientX, e.clientY);
    else if (act === 'reply' && mid) { S.replyTo = msgById(mid); renderComposerMeta(); $('#in-message').focus(); }
    else if (act === 'thread' && mid) openThread(mid);
    else if (act === 'vote' && mid) votePoll(mid, actEl.dataset.opt);
    else if (act === 'expand-file') expandTextFile(actEl);
    else if (act === 'edit' && mid) startEdit(mid);
    else if (act === 'edit-save' && mid) saveEdit(mid);
    else if (act === 'edit-cancel') { S.editing = null; if (S.channelId) renderMessages(); if (S.view === 'home' && S.dmThreadId) renderDmMessages(); if (S.thread) renderThread(); }
    else if (act === 'del' && mid) {
      const base = msgById(mid)?._dm ? '/api/dms/messages/' : '/api/messages/';
      api(base + mid, { method: 'DELETE' }).catch(() => toast('Delete failed'));
    }
    return;
  }
  if (memberEl?.dataset.uid) { const r = memberEl.getBoundingClientRect(); openUserCard(memberEl.dataset.uid, r.right + 8, r.top); return; }
  if (uidEl?.dataset.uid) { openUserCard(uidEl.dataset.uid, e.clientX, e.clientY); return; }
});

// ---------- threads ----------
async function applyProfileUrl(kind, url) {
  const ep = kind === 'sidebar' ? 'sidebar-banner' : kind;
  try {
    const { user } = await api(`/api/me/${ep}/url`, { method: 'POST', body: JSON.stringify({ url }) });
    S.me = { ...S.me, ...user };
    paintMe(); renderMembers();
    if (kind === 'avatar') paintAvatar($('#set-avatar-prev'), S.me);
    else if (kind === 'banner') $('#set-banner-prev').style.backgroundImage = S.me.banner_url ? `url('${S.me.banner_url}')` : '';
    else $('#set-sidebar-prev').style.backgroundImage = S.me.sidebar_banner_url ? `url('${S.me.sidebar_banner_url}')` : '';
    if (kind !== 'sidebar') loadMediaHist();
    toast((kind === 'avatar' ? 'Avatar' : kind === 'banner' ? 'Banner' : 'Sidebar banner') + ' updated');
  } catch (err) { toast('Failed: ' + prettyError(err.message)); }
}
async function loadMediaHist() {
  try {
    const h = await api('/api/me/media-history');
    renderHistRow($('#set-avatar-hist'), h.avatar || [], 'avatar', false);
    renderHistRow($('#set-banner-hist'), h.banner || [], 'banner', true);
  } catch {}
}
function renderHistRow(box, items, kind, wide) {
  if (!box) return;
  box.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hist-dot' + (wide ? ' wide' : '');
    b.style.backgroundImage = `url("${it.url}")`;
    b.title = 'Use this ' + kind;
    b.onclick = () => applyProfileUrl(kind, it.url);
    const x = document.createElement('span');
    x.className = 'hist-x'; x.textContent = '✕'; x.title = 'Forget';
    x.onclick = async (e) => {
      e.stopPropagation();
      try { await api('/api/me/media-history/' + it.id, { method: 'DELETE' }); loadMediaHist(); }
      catch {}
    };
    b.appendChild(x);
    box.appendChild(b);
  }
}
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
// Keep the hover quick-action bar usable near the top of a scroll list: when
// a message sits within the bar's clearance (~36px) of the scrollport top
// (e.g. the first thread reply right under the root section), pin the bar
// inside the message instead of letting it clip above.
let flipMsgEl = null;
function positionFlipActions(msgEl) {
  if (!msgEl || !msgEl.isConnected) return;
  const scroller = msgEl.closest('#messages,#thread-replies');
  if (!scroller) { msgEl.classList.remove('flip-actions'); return; }
  const top = msgEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  msgEl.classList.toggle('flip-actions', top < 36);
}
document.addEventListener('mouseover', (e) => {
  const m = e.target && e.target.closest ? e.target.closest('.msg') : null;
  if (m === flipMsgEl) return;
  if (flipMsgEl) flipMsgEl.classList.remove('flip-actions');
  flipMsgEl = m;
  if (m) positionFlipActions(m);
});
for (const sid of ['#messages', '#thread-replies']) {
  const sc = $(sid);
  if (sc) sc.addEventListener('scroll', () => positionFlipActions(flipMsgEl), { passive: true });
}
$('#thread-close').onclick = () => closeThread();
// thread sidebar resize (drag left edge, clamped + remembered)
const THREAD_W_MIN = 280, THREAD_W_MAX = 620;
const threadWMax = () => Math.max(THREAD_W_MIN + 40, Math.min(THREAD_W_MAX, Math.floor(innerWidth * 0.6)));
const clampThreadW = (w) => Math.min(threadWMax(), Math.max(THREAD_W_MIN, Math.round(w)));
try {
  const w = parseInt(localStorage.getItem('cf_thread_w') || '', 10);
  if (w >= THREAD_W_MIN) $('#thread-panel').style.width = clampThreadW(w) + 'px';
} catch {}
$('#thread-resizer').addEventListener('pointerdown', (e) => {
  if (matchMedia('(max-width: 700px)').matches) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  const panel = $('#thread-panel');
  const rz = e.currentTarget;
  const startX = e.clientX, startW = panel.getBoundingClientRect().width;
  document.body.classList.add('thread-resizing');
  try { rz.setPointerCapture(e.pointerId); } catch {}
  const move = (ev) => { panel.style.width = clampThreadW(startW + (startX - ev.clientX)) + 'px'; };
  const done = (ev) => {
    panel.style.width = clampThreadW(startW + (startX - ev.clientX)) + 'px';
    try { localStorage.setItem('cf_thread_w', panel.style.width.replace('px', '')); } catch {}
    document.body.classList.remove('thread-resizing');
    rz.removeEventListener('pointermove', move);
    rz.removeEventListener('pointerup', done);
    rz.removeEventListener('pointercancel', done);
  };
  rz.addEventListener('pointermove', move);
  rz.addEventListener('pointerup', done);
  rz.addEventListener('pointercancel', done);
});
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
async function openUserCard(uid, x, y) {
  if (S.me && uid !== S.me.id) await ensureFriends();
  const u = memberById(uid);
  if (!u) return;
  const card = $('#usercard');
  const canMod = S.view === 'server' && S.serverDetail && canManage() && uid !== S.me.id && uid !== S.serverDetail.owner_id;
  const st = statusOf(uid);
  const stLabel = { online: 'Online', away: 'Away', dnd: 'Do not disturb', offline: 'Offline' }[st];
  card.innerHTML = `
    <div class="uc-banner"${u.banner_url ? ` style="background-image:url('${esc(u.banner_url)}')"` : ''}></div>
    <div class="uc-body">
      <span class="avatar big"></span>
      <div class="uc-name" style="${nameStyleFor(u)}">${esc(u.display_name)}</div>
      <div class="uc-sub">@${esc(u.username)}${u.role === 'owner' ? ' · server owner' : ''}</div>
      <div class="uc-status"><span class="status-dot ${st}"></span><span>${stLabel}</span></div>
      ${u.status_text ? `<div class="uc-statustext">${esc(u.status_text)}</div>` : ''}
      ${u.bio ? `<div class="uc-bio">${renderRich(u.bio)}</div>` : ''}
      ${u.created_at ? `<div class="uc-since">Member since ${new Date(u.created_at).toLocaleDateString()}</div>` : ''}
      ${cardRolesHTML(uid)}
      <div class="uc-actions">${uid !== S.me.id ? '<button class="btn small" id="uc-mention">Mention</button>' : ''}${uid !== S.me.id && !isBlocked(uid) ? '<button class="btn small primary" id="uc-message">Message</button>' : ''}${uid !== S.me.id && !isBlocked(uid) ? friendBtnHTML(uid) : ''}${canMod ? '<button class="btn small danger" id="uc-kick">Kick</button><button class="btn small danger" id="uc-ban">Ban</button>' : ''}${uid !== S.me.id ? `<button class="btn small${isBlocked(uid) ? '' : ' danger'}" id="uc-block">${isBlocked(uid) ? 'Unblock' : 'Block'}</button>` : ''}<button class="btn small" id="uc-close">Close</button></div>
    </div>`;
  paintAvatar(card.querySelector('.avatar'), u);
  card.classList.remove('hidden');
  const r = card.getBoundingClientRect();
  card.style.left = Math.max(8, Math.min(x || 8, innerWidth - Math.min(296, innerWidth - 16))) + 'px';
  card.style.top = Math.max(8, Math.min(y || 8, innerHeight - (r.height || 300) - 8)) + 'px';
  $('#uc-close').onclick = closeUserCard;
  const men = $('#uc-mention');
  if (men) men.onclick = () => { insertAtCursor($('#in-message'), '@' + u.username + ' '); closeUserCard(); $('#in-message').focus(); };
  const msg = $('#uc-message');
  if (msg) msg.onclick = () => messageUser(uid);
  const blk = $('#uc-block');
  if (blk) blk.onclick = () => { const was = isBlocked(uid), nm = u.username; closeUserCard(); if (was) unblockUser(uid); else blockUser(uid, nm); };
  const fr = $('#uc-friend');
  if (fr) fr.onclick = () => friendCardAction(uid, x, y);
  const kik = $('#uc-kick');
  if (kik) kik.onclick = () => { closeUserCard(); modServerMember('kick', u); };
  const bnn = $('#uc-ban');
  if (bnn) bnn.onclick = () => { closeUserCard(); modServerMember('ban', u); };
  card.querySelectorAll('[data-role-toggle]').forEach((b) => (b.onclick = async () => {
    const rid = b.dataset.roleToggle, has = b.dataset.has === '1';
    try {
      if (has) await api(`/api/servers/${S.serverDetail.id}/roles/${rid}/members/${uid}`, { method: 'DELETE' });
      else await api(`/api/servers/${S.serverDetail.id}/roles/${rid}/members`, { method: 'POST', body: JSON.stringify({ userId: uid }) });
      const { server } = await api('/api/servers/' + S.serverDetail.id);
      S.serverDetail = server;
      renderMembers();
      openUserCard(uid, x, y);
    } catch (err) { toast('Failed: ' + prettyError(err.message)); }
  }));
}
function cardRolesHTML(uid) {
  if (S.view !== 'server' || !S.serverDetail) return '';
  const d = S.serverDetail;
  const m = d.members.find((x) => x.id === uid);
  if (!m || !(d.roles || []).length) return '';
  const mine = new Set(m.roleIds || []);
  const editable = canManage() && (uid !== d.owner_id || isOwner());
  let h = '<div class="uc-roles">';
  for (const r of d.roles) {
    const has = mine.has(r.id);
    const col = r.color ? ` style="border-color:${esc(r.color)};${has ? `background:${esc(r.color)}22;color:${esc(r.color)};` : ''}"` : '';
    if (editable) h += `<button class="role-pill${has ? ' on' : ''}" data-role-toggle="${r.id}" data-has="${has ? '1' : '0'}"${col}>${has ? '✓ ' : '+ '}${esc(r.name)}</button>`;
    else if (has) h += `<span class="role-pill"${col}>${esc(r.name)}</span>`;
  }
  return h + '</div>';
}
function closeUserCard() { $('#usercard').classList.add('hidden'); }

// ---------- @mention autocomplete ----------
let mentionIdx = 0;
function hideMentionPop() { $('#mention-pop').classList.add('hidden'); }
$('#in-message').addEventListener('input', () => {
  const inp = $('#in-message');
  const upto = inp.value.slice(0, inp.selectionStart ?? inp.value.length);
  const m = upto.match(/@([A-Za-z0-9_.]{1,24})$/);
  if (!m) { hideMentionPop(); return; }
  const q = m[1].toLowerCase();
  const pool = S.view === 'home'
    ? (((S.dms.find((t) => t.id === S.dmThreadId) || {}).members) || [])
    : (S.serverDetail?.members || []);
  const cands = pool.filter((x) => x.username.includes(q) || x.display_name.toLowerCase().includes(q)).slice(0, 6);
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
  inp.value = inp.value.slice(0, pos).replace(/@[A-Za-z0-9_.]{1,24}$/, '@' + username + ' ');
  hideMentionPop();
  inp.focus();
  syncComposerRender();
}

// ---------- settings (tabbed) ----------
function openSettings(tab = 'profile') {
  setSettingsTab(tab);
  $('#set-display').value = S.me.display_name || '';
  $('#set-namecustom').checked = !!(S.me.name_color || S.me.name_gradient);
  const remNc = rememberedNameColors();
  $('#set-namecolor').value = S.me.name_color || remNc.c || '#aac7ff';
  $('#set-namegrad').value = S.me.name_gradient || S.me.name_color || remNc.g || remNc.c || '#aac7ff';
  $('#set-namecustom').onchange = () => {
    if (!$('#set-namecustom').checked) return;
    const rem = rememberedNameColors();
    if (rem.c && $('#set-namecolor').value === '#aac7ff') $('#set-namecolor').value = rem.c;
    if (rem.g && $('#set-namegrad').value === '#aac7ff') $('#set-namegrad').value = rem.g;
  };
  $('#set-status').value = S.me.status || 'online';
  $('#set-statustext').value = S.me.status_text || '';
  $('#set-bio').value = S.me.bio || '';
  updateBioCount();
  $('#set-username').value = S.me.username || '';
  $('#set-pw-cur').value = ''; $('#set-pw-new').value = '';
  paintAvatar($('#set-avatar-prev'), S.me);
  const b = $('#set-banner-prev');
  b.style.backgroundImage = S.me.banner_url ? `url('${S.me.banner_url}')` : '';
  const sb = $('#set-sidebar-prev');
  if (sb) sb.style.backgroundImage = S.me.sidebar_banner_url ? `url('${S.me.sidebar_banner_url}')` : '';
  loadMediaHist();
  $('#settings-backdrop').classList.remove('hidden');
}
function closeSettings() { closePicker(); $('#settings-backdrop').classList.add('hidden'); }
// ---------- notifications (Web Push + per-scope prefs) ----------
const NOTIF_OPTS = [['all', 'All messages'], ['mentions', 'Mentions only'], ['muted', 'Muted']];
const NOTIF_LABEL = { all: 'All messages', mentions: 'Mentions only', muted: 'Muted' };
let notifPrefsCache = {};
async function refreshNotifPrefs() {
  try { const { prefs } = await api('/api/notifs/prefs'); notifPrefsCache = prefs || {}; }
  catch { notifPrefsCache = {}; }
  return notifPrefsCache;
}
async function setNotifPref(scope, mode) {
  try {
    await api('/api/notifs/prefs', { method: 'PUT', body: JSON.stringify({ scope, mode }) });
    if (mode === 'inherit') delete notifPrefsCache[scope];
    else notifPrefsCache[scope] = mode;
  } catch (err) { toast('Failed: ' + prettyError(err.message)); }
}
function notifSelect(scope, val, small) {
  const sel = document.createElement('select');
  if (small) sel.style.maxWidth = '150px';
  const opts = scope === 'global' ? NOTIF_OPTS : [['', 'Use default'], ...NOTIF_OPTS];
  for (const [v, l] of opts) {
    const o = document.createElement('option');
    o.value = v; o.textContent = l;
    if (v === val) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = async () => {
    await setNotifPref(scope, sel.value || 'inherit');
    sel.value = notifPrefsCache[scope] || '';
    renderServerList(); renderChannels();
  };
  return sel;
}
async function renderNotifsTab() {
  const box = $('#set-notifs');
  box.innerHTML = '<p class="muted small">Loading…</p>';
  const pushOK = ('serviceWorker' in navigator) && ('PushManager' in window);
  const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
  try { const { prefs } = await api('/api/notifs/prefs'); notifPrefsCache = prefs || {}; } catch { notifPrefsCache = {}; }
  if (!$('#set-notifs')) return;
  box.innerHTML = '';
  const h = (t) => { const e = document.createElement('h4'); e.textContent = t; e.style.margin = '1rem 0 .4rem'; box.appendChild(e); };
  h('Push notifications');
  const st = document.createElement('p'); st.className = 'muted small';
  let subscribed = false;
  if (pushOK && perm === 'granted') {
    try {
      const reg = await navigator.serviceWorker.ready;
      subscribed = !!(await reg.pushManager.getSubscription());
    } catch {}
  }
  if (!pushOK) st.textContent = 'Push is not supported in this browser.';
  else if (subscribed) st.textContent = 'Push notifications are enabled on this device — you will get pings even with Campfire closed.';
  else if (perm === 'denied') st.textContent = 'Notifications are blocked. Allow them in your browser or OS settings, then return here.';
  else if (perm === 'granted') st.textContent = 'Push is off on this device. Turn it back on below.';
  else st.textContent = 'Get pings on desktop and mobile, even with Campfire closed.';
  box.appendChild(st);
  if (pushOK && !subscribed && perm !== 'granted' && perm !== 'denied') {
    const en = document.createElement('button'); en.className = 'btn small primary'; en.textContent = 'Enable notifications';
    en.onclick = async () => {
      try {
        const p = await Notification.requestPermission();
        if (p === 'granted') { await pushSetup(); renderNotifsTab(); toast('Notifications enabled'); }
        else { toast('Notifications blocked'); renderNotifsTab(); }
      } catch { toast('Could not enable'); }
    };
    box.appendChild(en);
  }
  if (pushOK && perm === 'granted' && !subscribed) {
    const en = document.createElement('button'); en.className = 'btn small primary'; en.textContent = 'Enable on this device';
    en.onclick = async () => { await pushSetup(); renderNotifsTab(); toast('Notifications enabled'); };
    box.appendChild(en);
  }
  if (pushOK && subscribed) {
    const off = document.createElement('button'); off.className = 'btn small'; off.textContent = 'Disable on this device';
    off.onclick = async () => { await pushTeardown(); renderNotifsTab(); };
    box.appendChild(off);
  }
  h('Default for everything');
  box.appendChild(notifSelect('global', notifPrefsCache.global || 'all'));
  h('Per server');
  if (!S.servers.length) box.appendChild(Object.assign(document.createElement('p'), { className: 'muted small' }));
  for (const s of S.servers) {
    const row = document.createElement('div'); row.className = 'set-row';
    row.innerHTML = `<span class="grow">${esc(s.name)}</span>`;
    row.appendChild(notifSelect('s:' + s.id, notifPrefsCache['s:' + s.id] || ''));
    box.appendChild(row);
  }
  const note = document.createElement('p'); note.className = 'muted small';
  note.textContent = 'Right-click a channel or server for its own rules. DM threads follow the default rule.';
  box.appendChild(note);
}
function urlB64ToU8(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function pushSetup() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (!store.token || Notification.permission !== 'granted') return;
    const { publicKey } = await api('/api/push/config');
    if (!publicKey) return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(publicKey) });
    const js = sub.toJSON();
    await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint, keys: js.keys }) });
  } catch {}
}
async function pushTeardown() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      try { await api('/api/push/unsubscribe', { method: 'DELETE', body: JSON.stringify({ endpoint: sub.endpoint }) }); } catch {}
      try { await sub.unsubscribe(); } catch {}
    }
    toast('Notifications disabled on this device');
  } catch {}
}
function setSettingsTab(t) {
  document.querySelectorAll('.set-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  $('#set-profile').classList.toggle('hidden', t !== 'profile');
  $('#set-account').classList.toggle('hidden', t !== 'account');
  $('#set-notifs').classList.toggle('hidden', t !== 'notifs');
  if (t === 'notifs') renderNotifsTab();
}
document.querySelectorAll('.set-tab').forEach((b) => (b.onclick = () => { setSettingsTab(b.dataset.tab); if (b.dataset.tab === 'account') renderSecurityTab(); }));
$('#btn-settings-rail').onclick = () => openSettings('profile');
$('#btn-home').onclick = openHome;
$('#btn-pins').onclick = openPins;
$('#jump-present').onclick = jumpToPresent;
$('#messages').addEventListener('scroll', () => updatePill(), { passive: true });
$('#btn-friend-add').onclick = async () => {
  const v = $('#in-friend').value.trim();
  if (!v) return;
  try {
    await api('/api/friends', { method: 'POST', body: JSON.stringify({ username: v }) });
    $('#in-friend').value = '';
    toast('Request sent');
    refreshFriends();
  } catch (err) { toast(prettyError(err.message)); }
};
$('#btn-group-new').onclick = openGroupModal;
$('#btn-server-menu').onclick = () => openServerSettings();
$('#settings-close').onclick = closeSettings;
$('#settings-backdrop').addEventListener('click', (e) => { if (e.target.id === 'settings-backdrop') closeSettings(); });
$('#srv-settings-close').onclick = closeServerSettings;
$('#srv-settings-backdrop').addEventListener('click', (e) => { if (e.target.id === 'srv-settings-backdrop') closeServerSettings(); });
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
// dedicated centered GIF chooser for profile media (avatar / banner / sidebar)
async function openProfileGifPicker(kind) {
  const title = kind === 'avatar' ? 'Choose an avatar GIF' : kind === 'banner' ? 'Choose a banner GIF' : 'Choose a sidebar GIF';
  openModal(title, `
    <input id="m-gif-search" placeholder="Search GIFs" autocomplete="off" />
    <div id="m-gif-grid" class="gif-grid"></div>
    <div class="pk-attr">Powered by <a href="https://klipy.com" target="_blank" rel="noopener">KLIPY</a></div>
  `, 'Close', null, { wide: true });
  const grid = $('#m-gif-grid');
  const draw = (gifs) => {
    grid.innerHTML = '';
    if (!gifs.length) { grid.innerHTML = '<div class="pk-empty">No GIFs found.</div>'; return; }
    for (const g of gifs) {
      const b = document.createElement('button');
      b.className = 'pk-gif'; b.title = g.title || 'GIF';
      b.innerHTML = `<img src="${esc(g.thumb || g.preview || g.gif)}" alt="${esc(g.title || 'GIF')}" loading="lazy" />`;
      b.onclick = async () => {
        $('#modal-backdrop').classList.add('hidden');
        const url = g.gif || g.mp4;
        if (url) await applyProfileUrl(kind, url);
      };
      grid.appendChild(b);
    }
  };
  const load = async (q) => {
    grid.innerHTML = '<div class="pk-empty">Loading…</div>';
    try {
      const { gifs } = await api(q ? '/api/gifs/search?q=' + encodeURIComponent(q) : '/api/gifs/trending');
      if ($('#m-gif-grid')) draw(gifs || []);
    } catch { grid.innerHTML = '<div class="pk-empty">GIFs unavailable.</div>'; }
  };
  let t = null;
  $('#m-gif-search').addEventListener('input', (e) => {
    clearTimeout(t);
    const q = e.target.value.trim();
    t = setTimeout(() => load(q), 350);
  });
  load('');
}
$('#set-avatar-gif').onclick = () => openProfileGifPicker('avatar');
$('#set-banner-gif').onclick = () => openProfileGifPicker('banner');
$('#set-sidebar-btn').onclick = () => $('#set-sidebar-file').click();
$('#set-sidebar-gif').onclick = () => openProfileGifPicker('sidebar');
$('#set-sidebar-prev').onclick = () => $('#set-sidebar-file').click();
$('#set-sidebar-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const { user } = await uploadImage('/api/me/sidebar-banner', f);
    S.me = { ...S.me, ...user };
    paintMe(); renderMembers();
    $('#set-sidebar-prev').style.backgroundImage = S.me.sidebar_banner_url ? `url('${S.me.sidebar_banner_url}')` : '';
    toast('Sidebar banner updated');
  } catch (err) { toast('Upload failed: ' + prettyError(err.message)); }
});
$('#set-sidebar-rm').onclick = async () => {
  try {
    const { user } = await api('/api/me/sidebar-banner', { method: 'DELETE' });
    S.me = { ...S.me, ...user };
    paintMe(); renderMembers();
    $('#set-sidebar-prev').style.backgroundImage = '';
  } catch { toast('Remove failed'); }
};
$('#set-avatar-prev').onclick = () => $('#set-avatar-file').click();
$('#set-banner-prev').onclick = () => $('#set-banner-file').click();
$('#set-avatar-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { const { user } = await uploadImage('/api/me/avatar', f); S.me = { ...S.me, ...user }; paintMe(); paintAvatar($('#set-avatar-prev'), S.me); loadMediaHist(); toast('Avatar updated'); }
  catch (err) { toast('Avatar failed: ' + prettyError(err.message)); }
});
$('#set-banner-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { const { user } = await uploadImage('/api/me/banner', f); S.me = { ...S.me, ...user }; $('#set-banner-prev').style.backgroundImage = `url('${S.me.banner_url}')`; loadMediaHist(); toast('Banner updated'); }
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
function rememberedNameColors() { try { return JSON.parse(localStorage.getItem('cf_namecolors') || 'null') || {}; } catch { return {}; } }
function updateBioCount() { const b = $('#set-bio'); if (b) $('#set-bio-count').textContent = `${b.value.length} / 300`; }
$('#set-bio').addEventListener('input', updateBioCount);
$('#set-profile-save').onclick = async () => {
  try {
    if ($('#set-namecustom').checked) { try { localStorage.setItem('cf_namecolors', JSON.stringify({ c: $('#set-namecolor').value, g: $('#set-namegrad').value })); } catch {} }
    const { user } = await api('/api/me', { method: 'PATCH', body: JSON.stringify({
      displayName: $('#set-display').value.trim(),
      status: $('#set-status').value,
      statusText: $('#set-statustext').value.trim(),
      bio: $('#set-bio').value,
      nameColor: $('#set-namecustom').checked ? $('#set-namecolor').value : '',
      nameGradient: $('#set-namecustom').checked ? $('#set-namegrad').value : '',
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
// ---------- security: 2FA, passkeys, sessions + notification inbox ----------
function deviceName() {
  try {
    const ud = navigator.userAgentData;
    if (ud?.platform) return `${ud.platform} ${(ud.brands || []).map((b) => b.brand)[0] || ''}`.trim().slice(0, 32);
  } catch {}
  return '';
}
function b64ToBuf(s) {
  const bin = atob(String(s || '').replace(/-/g, '+').replace(/_/g, '/'));
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}
function bufToB64(buf) {
  const u = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pkToJson(cred) {
  const o = { id: cred.id, rawId: bufToB64(cred.rawId), type: cred.type, response: {} };
  for (const k of ['clientDataJSON', 'attestationObject', 'authenticatorData', 'signature', 'userHandle']) {
    if (cred.response[k]) o.response[k] = bufToB64(cred.response[k]);
  }
  return o;
}
function pkFromJson(opts) {
  const o = { ...opts, challenge: b64ToBuf(opts.challenge) };
  if (o.user && o.user.id) o.user = { ...o.user, id: b64ToBuf(o.user.id) };
  if (o.allowCredentials) o.allowCredentials = o.allowCredentials.map((c) => ({ ...c, id: b64ToBuf(c.id) }));
  if (o.excludeCredentials) o.excludeCredentials = o.excludeCredentials.map((c) => ({ ...c, id: b64ToBuf(c.id) }));
  return o;
}
function webauthnSupported() { return !!(navigator.credentials && window.PublicKeyCredential); }
let pending2faTmp = null;
function show2faStep() {
  $('#form-auth').classList.add('hidden');
  $('#btn-passkey').classList.add('hidden');
  $('#form-2fa').classList.remove('hidden');
  $('#in-2fa').value = '';
  $('#auth-2fa-error').classList.add('hidden');
  setTimeout(() => { try { $('#in-2fa').focus(); } catch {} }, 50);
}
function hide2faStep() {
  $('#form-2fa').classList.add('hidden');
  $('#form-auth').classList.remove('hidden');
  $('#btn-passkey').classList.remove('hidden');
  pending2faTmp = null;
}
$('#btn-2fa-back').onclick = hide2faStep;
$('#form-2fa').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('#in-2fa').value.trim();
  if (!code || !pending2faTmp) return;
  try {
    const data = await api('/api/login/2fa', { method: 'POST', body: JSON.stringify({ tmp: pending2faTmp, code }) });
    store.token = data.token;
    if (data.sid) store.sid = data.sid;
    hide2faStep();
    await boot();
  } catch (err) {
    const el = $('#auth-2fa-error');
    el.textContent = '⚠️ ' + prettyError(err.message);
    el.classList.remove('hidden');
  }
});
$('#btn-passkey').onclick = async () => {
  if (!webauthnSupported()) { toast('Passkeys are not supported in this browser'); return; }
  try {
    const username = $('#in-username').value.trim().toLowerCase() || undefined;
    const { stateId, options } = await api('/api/passkeys/login/options', { method: 'POST', body: JSON.stringify({ username }) });
    const cred = await navigator.credentials.get({ publicKey: pkFromJson(options) });
    const data = await api('/api/passkeys/login/verify', { method: 'POST', body: JSON.stringify({ stateId, authResp: pkToJson(cred), device: deviceName() }) });
    store.token = data.token;
    if (data.sid) store.sid = data.sid;
    await boot();
  } catch (err) { toast(prettyError(err.message)); }
};
async function renderSecurityTab() {
  if (!S.me) return;
  render2faBox(); renderPasskeyBox(); renderSessionBox();
}
async function render2faBox() {
  const box = $('#set-2fa');
  if (!box) return;
  let enabled = false;
  try { ({ enabled } = await api('/api/2fa/status')); } catch { box.innerHTML = '<p class="muted small">Unavailable.</p>'; return; }
  box.innerHTML = '';
  if (!enabled) {
    const p = document.createElement('p'); p.className = 'muted small'; p.textContent = 'Off — add an authenticator app for a second step at sign in.';
    const b = document.createElement('button'); b.className = 'btn small primary'; b.textContent = 'Set up 2FA';
    b.onclick = start2faSetup;
    box.append(p, b);
    return;
  }
  const p = document.createElement('p'); p.className = 'muted small'; p.textContent = 'On — signing in asks for a code from your authenticator app.';
  const row = document.createElement('div'); row.className = 'row'; row.style.marginTop = '.5rem';
  const regen = document.createElement('button'); regen.className = 'btn small'; regen.textContent = 'New backup codes';
  regen.onclick = async () => {
    const code = await openPromptModal({ title: 'Confirm it\'s you', label: 'Enter a 2FA code or backup code', okLabel: 'Continue', maxlength: 16 });
    if (code === null) return;
    try {
      const { backupCodes } = await api('/api/2fa/backup-codes/regenerate', { method: 'POST', body: JSON.stringify({ code: (code || '').trim() }) });
      showBackupCodes(backupCodes);
    } catch (err) { toast('Failed: ' + prettyError(err.message)); }
  };
  const dis = document.createElement('button'); dis.className = 'btn small danger'; dis.textContent = 'Disable 2FA';
  dis.onclick = async () => {
    const code = await openPromptModal({ title: 'Disable 2FA?', label: 'Enter a 2FA code or backup code to confirm', okLabel: 'Disable', maxlength: 16 });
    if (code === null) return;
    try { await api('/api/2fa/disable', { method: 'POST', body: JSON.stringify({ code: (code || '').trim() }) }); render2faBox(); toast('2FA disabled'); }
    catch (err) { toast('Failed: ' + prettyError(err.message)); }
  };
  row.append(regen, dis);
  box.append(p, row);
}
async function start2faSetup() {
  const box = $('#set-2fa');
  let setup;
  try { setup = await api('/api/2fa/setup', { method: 'POST' }); }
  catch (err) { toast('Failed: ' + prettyError(err.message)); return; }
  box.innerHTML = '';
  const p = document.createElement('p'); p.className = 'muted small';
  p.textContent = 'Scan this secret into your authenticator app (or tap the link on mobile), then enter the 6-digit code.';
  const link = document.createElement('div');
  link.innerHTML = `<a href="${esc(setup.otpauth_url)}">Add to authenticator app</a>`;
  const code = document.createElement('div'); code.className = 'codebox'; code.textContent = setup.secret;
  const cp = document.createElement('button'); cp.className = 'btn small'; cp.textContent = 'Copy secret';
  cp.onclick = () => { try { navigator.clipboard.writeText(setup.secret); toast('Secret copied'); } catch {} };
  const inp = document.createElement('input'); inp.maxLength = 16; inp.placeholder = '123456'; inp.inputMode = 'numeric'; inp.style.marginTop = '.5rem';
  const row = document.createElement('div'); row.className = 'row'; row.style.marginTop = '.5rem';
  const ok = document.createElement('button'); ok.className = 'btn small primary'; ok.textContent = 'Confirm';
  ok.onclick = async () => {
    try {
      const { backupCodes } = await api('/api/2fa/enable', { method: 'POST', body: JSON.stringify({ code: inp.value.trim() }) });
      render2faBox();
      showBackupCodes(backupCodes);
    } catch (err) { toast('Failed: ' + prettyError(err.message)); }
  };
  const cancel = document.createElement('button'); cancel.className = 'btn small'; cancel.textContent = 'Cancel';
  cancel.onclick = render2faBox;
  row.append(ok, cancel);
  box.append(p, link, code, cp, inp, row);
}
function showBackupCodes(codes) {
  openModal('Backup codes', `<p class="muted">Save these somewhere safe — each works once if you lose your authenticator. This is the only time they are shown.</p><div class="backup-codes">${(codes || []).map(esc).join('<br/>')}</div>`, 'Done', null);
}
async function renderPasskeyBox() {
  const box = $('#set-passkeys');
  if (!box) return;
  let passkeys = [];
  try { ({ passkeys } = await api('/api/passkeys')); } catch { box.innerHTML = '<p class="muted small">Unavailable.</p>'; return; }
  box.innerHTML = '';
  if (!passkeys.length) box.innerHTML = '<p class="muted small">None yet — add one to sign in without a password.</p>';
  for (const p of passkeys) {
    const row = document.createElement('div'); row.className = 'sec-row';
    const main = document.createElement('span'); main.className = 'grow';
    main.innerHTML = `<span>${esc(p.name || 'Passkey')}</span><span class="sub">added ${new Date(p.created_at).toLocaleDateString()}${p.last_used ? ' · used ' + new Date(p.last_used).toLocaleDateString() : ''}</span>`;
    const rn = document.createElement('button'); rn.className = 'mini'; rn.textContent = 'Rename';
    rn.onclick = async () => {
      const v = await openPromptModal({ title: 'Rename passkey', label: 'Passkey name', initial: p.name || 'Passkey', okLabel: 'Save', maxlength: 32 });
      if (v === null) return;
      try { await api(`/api/passkeys/${p.id}`, { method: 'PATCH', body: JSON.stringify({ name: v.trim() }) }); renderPasskeyBox(); }
      catch (err) { toast('Failed: ' + prettyError(err.message)); }
    };
    const del = document.createElement('button'); del.className = 'mini danger'; del.textContent = '✕';
    del.onclick = async () => {
      try { await api(`/api/passkeys/${p.id}`, { method: 'DELETE' }); renderPasskeyBox(); toast('Passkey removed'); }
      catch (err) { toast('Failed: ' + prettyError(err.message)); }
    };
    row.append(main, rn, del);
    box.appendChild(row);
  }
}
$('#set-passkey-add').onclick = async () => {
  if (!webauthnSupported()) { toast('Passkeys are not supported in this browser'); return; }
  const name = await openPromptModal({ title: 'Add passkey', label: 'Name this passkey', initial: 'My passkey', okLabel: 'Continue', maxlength: 32 });
  if (name === null) return;
  try {
    const { stateId, options } = await api('/api/passkeys/register/options', { method: 'POST' });
    const cred = await navigator.credentials.create({ publicKey: pkFromJson(options) });
    await api('/api/passkeys/register/verify', { method: 'POST', body: JSON.stringify({ stateId, name: (name || '').trim() || 'Passkey', attResp: pkToJson(cred) }) });
    toast('Passkey added');
    renderPasskeyBox();
  } catch (err) { toast(prettyError(err.message)); }
};
function fmtSeen(ts) {
  const d = Date.now() - ts;
  if (d < 60e3) return 'just now';
  if (d < 3600e3) return Math.floor(d / 60e3) + 'm ago';
  if (d < 86400e3) return Math.floor(d / 3600e3) + 'h ago';
  if (d < 30 * 86400e3) return Math.floor(d / 86400e3) + 'd ago';
  return new Date(ts).toLocaleDateString();
}
async function renderSessionBox() {
  const box = $('#set-sessions');
  if (!box) return;
  let sessions = [];
  try { ({ sessions } = await api('/api/sessions')); } catch { box.innerHTML = '<p class="muted small">Unavailable.</p>'; return; }
  box.innerHTML = '';
  if (!sessions.length) box.innerHTML = '<p class="muted small">No active sessions.</p>';
  for (const s of sessions) {
    const row = document.createElement('div'); row.className = 'sec-row';
    const main = document.createElement('span'); main.className = 'grow';
    const ua = (s.user_agent || '').slice(0, 48);
    main.innerHTML = `<span>${esc(s.name || 'Unnamed device')}${s.current ? ' · this device' : ''}</span><span class="sub">${esc([s.ip, ua].filter(Boolean).join(' · '))} · seen ${fmtSeen(s.last_seen || s.created_at)}</span>`;
    const rn = document.createElement('button'); rn.className = 'mini'; rn.textContent = 'Rename';
    rn.onclick = async () => {
      const v = await openPromptModal({ title: 'Rename session', label: 'Session name', initial: s.name || '', placeholder: 'e.g. Home PC', okLabel: 'Save', maxlength: 32 });
      if (v === null) return;
      try { await api(`/api/sessions/${s.id}`, { method: 'PATCH', body: JSON.stringify({ name: (v || '').trim() }) }); renderSessionBox(); }
      catch (err) { toast('Failed: ' + prettyError(err.message)); }
    };
    row.appendChild(main);
    row.appendChild(rn);
    if (!s.current) {
      const rev = document.createElement('button'); rev.className = 'mini danger'; rev.textContent = 'Revoke';
      rev.onclick = async () => {
        try { await api(`/api/sessions/${s.id}`, { method: 'DELETE' }); renderSessionBox(); toast('Session revoked'); }
        catch (err) { toast('Failed: ' + prettyError(err.message)); }
      };
      row.appendChild(rev);
    }
    box.appendChild(row);
  }
}
$('#set-sess-revoke-others').onclick = async () => {
  try { await api('/api/sessions/others', { method: 'DELETE' }); renderSessionBox(); toast('Other sessions revoked'); }
  catch (err) { toast('Failed: ' + prettyError(err.message)); }
};
// ---------- notification inbox ----------
function paintNotifBadge(n) {
  const b = $('#notifs-count');
  if (!b) return;
  b.textContent = n > 99 ? '99+' : String(n);
  b.classList.toggle('hidden', !n);
}
async function refreshNotifBadge() {
  if (!store.token) return;
  try {
    const { unread } = await api('/api/notifs/inbox');
    paintNotifBadge(unread || 0);
  } catch {}
}
function inboxWhen(ts) {
  try { return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}
async function openInbox() {
  let items = [];
  try { ({ items } = await api('/api/notifs/inbox')); } catch { toast('Could not load notifications'); return; }
  openModal('Notifications', `<div class="row end" style="margin:0 0 .4rem"><button class="btn small" id="m-notif-readall">Mark all read</button></div><div id="m-inbox-list"></div>`, 'Close', null, { wide: true });
  const list = $('#m-inbox-list');
  if (!items.length) list.innerHTML = '<p class="muted" style="text-align:center;padding:1rem">All caught up — mentions and friend requests land here.</p>';
  for (const n of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'inbox-item' + (n.read_at ? ' read' : '');
    const kind = n.kind === 'dm' ? 'DM' : n.kind === 'friend' ? 'Friend' : 'Mention';
    b.innerHTML = `<span class="dot"></span><span class="imain"><span class="ititle">${esc(n.title || kind)}</span><br/><span class="ibody">${esc(n.body || '')}</span></span><span class="iwhen">${esc(inboxWhen(n.created_at))}</span>`;
    b.onclick = () => openNotifItem(n);
    list.appendChild(b);
  }
  $('#m-notif-readall').onclick = async () => {
    try { await api('/api/notifs/read', { method: 'PUT', body: JSON.stringify({ all: true }) }); } catch {}
    paintNotifBadge(0);
    openInbox();
  };
}
async function openNotifItem(n) {
  try { await api('/api/notifs/read', { method: 'PUT', body: JSON.stringify({ ids: [n.id] }) }); } catch {}
  refreshNotifBadge();
  $('#modal-backdrop').classList.add('hidden');
  try {
    if (n.kind === 'dm' && n.thread_id) { await openHome(); selectDmThread(n.thread_id); }
    else if (n.kind === 'friend') { await openHome(); S.friendTab = 'pending'; document.querySelector('#friend-tabs .ftab[data-ftab="pending"]')?.click(); refreshFriends(); }
    else if (n.server_id) {
      if (n.server_id !== S.serverId) await selectServer(n.server_id);
      if (n.channel_id) await selectChannel(n.channel_id);
      if (n.message_id) jumpToMessage(n.message_id);
    }
  } catch {}
}
$('#btn-notifs').onclick = openInbox;
$('#me-card').style.cursor = 'pointer';
$('#me-card').onclick = () => openSettings('profile');
function renderServerHeader() {
  const d = S.serverDetail;
  const el = $('#srv-banner');
  if (!el) return;
  if (d && d.banner_url) { el.style.backgroundImage = `url("${d.banner_url}")`; el.classList.remove('hidden'); }
  else { el.classList.add('hidden'); el.style.backgroundImage = ''; }
}
async function refreshServerTab() {
  const id = S.serverDetail?.id;
  if (!id) return;
  try {
    const { server } = await api('/api/servers/' + id);
    if (S.serverDetail?.id !== id) return;
    S.serverDetail = server;
    renderServerTab();
    renderMembers();
    renderServerHeader();
  } catch {}
}
function openServerSettings() {
  const d = S.serverDetail;
  if (!d) return;
  S.srvSetId = d.id;
  renderServerTab();
  $('#srv-settings-backdrop').classList.remove('hidden');
}
function closeServerSettings() { S.srvSetId = null; $('#srv-settings-backdrop')?.classList.add('hidden'); }
function renderServerTab() {
  const box = $('#srvset-body');
  if (!box) return;
  const d = S.serverDetail;
  if (!d || (S.srvSetId && d.id !== S.srvSetId)) { box.innerHTML = '<p class="muted">No server selected.</p>'; return; }
  $('#srv-settings-title').textContent = d.name;
  const owner = d.owner_id === S.me.id;
  const mgr = canManage();
  const scroller = box.parentElement;
  const keepScroll = scroller ? scroller.scrollTop : 0;
  box.innerHTML = '';
  let sub = S.serverSubTab || 'general';
  if ((sub === 'roles' || sub === 'bans') && !mgr) sub = 'general';
  const subTabs = document.createElement('div');
  subTabs.className = 'srv-subtabs';
  box.appendChild(subTabs);
  for (const [sid, slabel] of [['general', 'General'], ['channels', 'Channels'], ['emoji', 'Emoji'], ['roles', 'Roles'], ['bans', 'Bans']]) {
    if ((sid === 'roles' || sid === 'bans') && !mgr) continue;
    const b = document.createElement('button');
    b.className = 'ftab' + (sub === sid ? ' active' : '');
    b.textContent = slabel;
    b.onclick = () => {
      S.serverSubTab = sid;
      subTabs.querySelectorAll('.ftab').forEach((x) => x.classList.toggle('active', x === b));
      box.querySelectorAll('[data-ssub]').forEach((x) => (x.style.display = x.dataset.ssub === sid ? '' : 'none'));
    };
    subTabs.appendChild(b);
  }
  const sec = (id) => { const el = document.createElement('div'); el.dataset.ssub = id; el.style.display = sub === id ? '' : 'none'; box.appendChild(el); return el; };
  let cur = sec('general');
  const h = (t) => { const e = document.createElement('h4'); e.textContent = t; e.style.margin = '1rem 0 .4rem'; cur.appendChild(e); };
  // general
  h('General');
  const nameRow = document.createElement('div');
  nameRow.innerHTML = `<label style="flex:1">Server name<input id="srv-name" maxlength="48" value="${esc(d.name)}" ${mgr ? '' : 'disabled'} /></label>`;
  cur.appendChild(nameRow);
  const descRow = document.createElement('div');
  descRow.innerHTML = `<label style="flex:1">Description (shown on invites)<input id="srv-desc" maxlength="200" placeholder="What is this server about?" value="${esc(d.description || '')}" ${mgr ? '' : 'disabled'} /></label>`;
  cur.appendChild(descRow);
  const iconRow = document.createElement('div');
  iconRow.className = 'row';
  iconRow.style.margin = '.5rem 0';
  iconRow.innerHTML = `<span class="server-btn" style="width:40px;height:40px;font-size:1rem"></span>`;
  const prev = iconRow.querySelector('.server-btn');
  const paintPrev = () => {
    prev.innerHTML = '';
    if (d.icon_url) {
      prev.classList.add('has-icon');
      const im = document.createElement('img');
      im.src = d.icon_url; im.alt = ''; im.width = 40; im.height = 40;
      im.style.cssText = 'width:40px!important;height:40px!important;object-fit:cover!important;border-radius:10px!important;display:block!important';
      im.onerror = () => { prev.classList.remove('has-icon'); prev.innerHTML = ''; prev.textContent = d.name.trim().charAt(0).toUpperCase(); };
      prev.appendChild(im);
    }
    else { prev.classList.remove('has-icon'); prev.textContent = d.name.trim().charAt(0).toUpperCase(); }
  };
  paintPrev();
  if (mgr) {
    const ch = document.createElement('button'); ch.className = 'btn small'; ch.textContent = 'Change icon';
    const rm = document.createElement('button'); rm.className = 'btn small'; rm.textContent = 'Remove';
    const fi = document.createElement('input'); fi.type = 'file'; fi.accept = 'image/png,image/jpeg,image/gif,image/webp'; fi.className = 'hidden';
    ch.onclick = () => fi.click();
    fi.onchange = async () => { if (!fi.files[0]) return; try { await uploadImage(`/api/servers/${d.id}/icon`, fi.files[0]); renderServerTab(); } catch (err) { toast('Icon failed: ' + prettyError(err.message)); } };
    rm.onclick = async () => { try { await api(`/api/servers/${d.id}/icon`, { method: 'DELETE' }); renderServerTab(); } catch {} };
    const sv = document.createElement('button'); sv.className = 'btn small primary'; sv.textContent = 'Save name';
    sv.onclick = async () => { try { await api(`/api/servers/${d.id}`, { method: 'PATCH', body: JSON.stringify({ name: box.querySelector('#srv-name').value, description: box.querySelector('#srv-desc').value }) }); toast('Server saved'); } catch (err) { toast('Save failed: ' + prettyError(err.message)); } };
    iconRow.append(ch, rm, sv);
  }
  cur.appendChild(iconRow);
  // banner
  h('Banner');
  const banPrev = document.createElement('div');
  banPrev.className = 'set-banner';
  if (d.banner_url) banPrev.style.backgroundImage = `url('${esc(d.banner_url)}')`;
  cur.appendChild(banPrev);
  if (mgr) {
    const brow = document.createElement('div'); brow.className = 'row'; brow.style.marginTop = '.55rem';
    const bch = document.createElement('button'); bch.className = 'btn small'; bch.textContent = 'Upload';
    const brm = document.createElement('button'); brm.className = 'btn small'; brm.textContent = 'Remove';
    const bfi = document.createElement('input'); bfi.type = 'file'; bfi.accept = 'image/png,image/jpeg,image/gif,image/webp'; bfi.className = 'hidden';
    bch.onclick = () => bfi.click();
    bfi.onchange = async () => { if (!bfi.files[0]) return; try { await uploadImage(`/api/servers/${d.id}/banner`, bfi.files[0]); refreshServerTab(); if (d.id === S.serverId) selectServer(d.id); } catch (err) { toast('Banner failed: ' + prettyError(err.message)); } };
    brm.onclick = async () => { try { await api(`/api/servers/${d.id}/banner`, { method: 'DELETE' }); refreshServerTab(); if (d.id === S.serverId) selectServer(d.id); } catch {} };
    brow.append(bch, brm); cur.appendChild(brow);
  }
  // invite
  h('Invite');
  const inv = document.createElement('div');
  inv.innerHTML = `<div class="codebox">${esc(d.invite_code)}</div>`;
  const invRow = document.createElement('div'); invRow.className = 'row';
  const cp = document.createElement('button'); cp.className = 'btn small'; cp.textContent = 'Copy link';
  cp.onclick = () => { navigator.clipboard?.writeText(`${location.origin}/invite/${d.invite_code}`); toast('Link copied'); };
  invRow.appendChild(cp);
  if (mgr) {
    const rs = document.createElement('button'); rs.className = 'btn small'; rs.textContent = 'Reset code';
    rs.onclick = async () => { try { const r = await api(`/api/servers/${d.id}/invite/reset`, { method: 'POST' }); S.serverDetail.invite_code = r.invite_code; renderServerTab(); } catch {} };
    invRow.appendChild(rs);
  }
  inv.appendChild(invRow); cur.appendChild(inv);
  cur = sec('channels');
  // channels
  h('Channels');
  for (const c of d.channels) {
    const row = document.createElement('div');
    row.className = 'set-row';
    const slowBadge = c.slowmode ? ` <span class="muted small">· ${c.slowmode}s slow</span>` : '';
    const descBadge = c.description ? ` <span class="muted small">· ${esc(c.description.slice(0, 24))}${c.description.length > 24 ? '…' : ''}</span>` : '';
    row.innerHTML = `<span class="muted">(${c.type})</span><span class="grow">${esc(c.name)}${slowBadge}${descBadge}</span>`;
    if (mgr) {
      const ed = document.createElement('button'); ed.className = 'mini'; ed.textContent = 'Edit';
      ed.onclick = () => openChannelSettings(d.id, c);
      row.appendChild(ed);
      const del = document.createElement('button'); del.className = 'mini danger'; del.textContent = 'Delete';
      del.onclick = async () => { try { await api(`/api/servers/${d.id}/channels/${c.id}`, { method: 'DELETE' }); } catch (err) { toast('Delete failed: ' + prettyError(err.message)); } };
      row.appendChild(del);
    }
    cur.appendChild(row);
  }
  if (mgr) {
    const add = document.createElement('div'); add.className = 'row'; add.style.marginTop = '.5rem';
    add.innerHTML = `<input id="srv-newchan" maxlength="32" placeholder="new-channel" style="flex:2" /><select id="srv-newtype" style="flex:1"><option value="text">Text</option><option value="voice">Voice</option></select>`;
    const go = document.createElement('button'); go.className = 'btn small'; go.textContent = 'Add';
    go.onclick = async () => {
      const name = add.querySelector('#srv-newchan').value.trim().replace(/\s+/g, '-');
      if (!name) return;
      try { await api(`/api/servers/${d.id}/channels`, { method: 'POST', body: JSON.stringify({ name, type: add.querySelector('#srv-newtype').value }) }); renderServerTab(); }
      catch (err) { toast('Failed: ' + prettyError(err.message)); }
    };
    add.appendChild(go); cur.appendChild(add);
  }
  cur = sec('emoji');
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
      if (mgr) {
        const del = document.createElement('button'); del.className = 'mini danger'; del.textContent = 'Delete';
        del.onclick = async () => { try { await api(`/api/servers/${d.id}/emoji/${encodeURIComponent(n)}`, { method: 'DELETE' }); const r = await api(`/api/servers/${d.id}/emoji`); S.emoji = {}; for (const e of r.emoji) S.emoji[e.name] = e.url; drawEmoji(); } catch {} };
        row.appendChild(del);
      }
      elist.appendChild(row);
    }
  };
  drawEmoji(); cur.appendChild(elist);
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
  eadd.appendChild(epick); cur.appendChild(eadd); box.appendChild(efile);
  cur = sec('bans');
  // banned members (owner only)
  if (mgr) {
    h('Banned members');
    const banBox = document.createElement('div');
    banBox.innerHTML = '<p class="muted small">Loading…</p>';
    cur.appendChild(banBox);
    api(`/api/servers/${d.id}/bans`).then(({ bans }) => {
      banBox.innerHTML = '';
      if (!bans.length) banBox.innerHTML = '<p class="muted small">Nobody is banned.</p>';
      for (const u of bans || []) {
        const row = document.createElement('div');
        row.className = 'set-row';
        row.innerHTML = `<span class="avatar" style="width:26px;height:26px;font-size:.65rem"></span><span class="grow">${esc(u.display_name)} <span class="muted">@${esc(u.username)}</span>${u.reason ? ` — ${esc(u.reason)}` : ''}</span>`;
        paintAvatar(row.querySelector('.avatar'), u);
        const un = document.createElement('button'); un.className = 'mini'; un.textContent = 'Unban';
        un.onclick = async () => { try { await api(`/api/servers/${d.id}/bans/${u.id}`, { method: 'DELETE' }); renderServerTab(); } catch (err) { toast('Failed: ' + prettyError(err.message)); } };
        row.appendChild(un);
        banBox.appendChild(row);
      }
    }).catch(() => { banBox.innerHTML = '<p class="muted small">Could not load bans.</p>'; });
  }
  cur = sec('roles');
  // roles
  if (mgr) {
    h('Roles');
    const rbox = document.createElement('div');
    cur.appendChild(rbox);
    const drawRoles = () => {
      rbox.innerHTML = '';
      const roles = (S.serverDetail?.roles || []);
      if (!roles.length) rbox.innerHTML = '<p class="muted small">No roles yet — create one below. Assign them from a member\'s profile card.</p>';
      for (const r of roles) {
        const row = document.createElement('div'); row.className = 'set-row';
        row.innerHTML = `<span class="rdot"${r.color ? ` style="background:${esc(r.color)}"` : ''}></span><span class="grow">${esc(r.name)}${r.admin ? ' <span class="muted small">· admin</span>' : ''}${r.hoist ? ' <span class="muted small">· hoisted</span>' : ''}</span>`;
        const nm = document.createElement('button'); nm.className = 'mini'; nm.textContent = 'Rename';
        nm.onclick = async () => {
          const v = await openPromptModal({ title: 'Rename role', label: 'Role name', initial: r.name, okLabel: 'Save', maxlength: 32 });
          if (v === null || !v.trim()) return;
          try { await api(`/api/servers/${d.id}/roles/${r.id}`, { method: 'PATCH', body: JSON.stringify({ name: v.trim() }) }); refreshServerTab(); } catch (err) { toast('Failed: ' + prettyError(err.message)); }
        };
        const cl = document.createElement('input'); cl.type = 'color'; cl.value = r.color || '#5865f2'; cl.title = 'Role color'; cl.className = 'clr';
        cl.onchange = async () => { try { await api(`/api/servers/${d.id}/roles/${r.id}`, { method: 'PATCH', body: JSON.stringify({ color: cl.value }) }); refreshServerTab(); } catch (err) { toast('Failed: ' + prettyError(err.message)); } };
        const ho = document.createElement('button'); ho.className = 'mini' + (r.hoist ? ' on' : ''); ho.textContent = 'Hoist';
        ho.title = 'Show separately in the member list';
        ho.onclick = async () => { try { await api(`/api/servers/${d.id}/roles/${r.id}`, { method: 'PATCH', body: JSON.stringify({ hoist: !r.hoist }) }); refreshServerTab(); } catch {} };
        row.append(nm, cl, ho);
        if (owner) {
          const ad = document.createElement('button'); ad.className = 'mini' + (r.admin ? ' on' : ''); ad.textContent = 'Admin';
          ad.title = 'Can manage the server (only the owner can grant this)';
          ad.onclick = async () => { try { await api(`/api/servers/${d.id}/roles/${r.id}`, { method: 'PATCH', body: JSON.stringify({ admin: !r.admin }) }); refreshServerTab(); } catch (err) { toast('Failed: ' + prettyError(err.message)); } };
          row.appendChild(ad);
        }
        const del = document.createElement('button'); del.className = 'mini danger'; del.textContent = '✕';
        del.onclick = async () => { try { await api(`/api/servers/${d.id}/roles/${r.id}`, { method: 'DELETE' }); refreshServerTab(); } catch (err) { toast('Failed: ' + prettyError(err.message)); } };
        row.appendChild(del);
        rbox.appendChild(row);
      }
      const add = document.createElement('div'); add.className = 'row'; add.style.marginTop = '.5rem';
      add.innerHTML = `<input id="srv-newrole" maxlength="32" placeholder="new role" style="flex:2" /><input id="srv-newrole-c" type="color" value="#5865f2" class="clr" />`;
      const go = document.createElement('button'); go.className = 'btn small'; go.textContent = 'Add';
      go.onclick = async () => {
        const name = add.querySelector('#srv-newrole').value.trim();
        if (!name) return;
        try { await api(`/api/servers/${d.id}/roles`, { method: 'POST', body: JSON.stringify({ name, color: add.querySelector('#srv-newrole-c').value }) }); refreshServerTab(); }
        catch (err) { toast('Failed: ' + prettyError(err.message)); }
      };
      add.appendChild(go); rbox.appendChild(add);
    };
    drawRoles();
  }
  cur = sec('general');
  // danger / leave
  const dz = document.createElement('div'); dz.className = 'danger-zone';
  dz.innerHTML = `<h4>${owner ? 'Danger zone' : 'Leave'}</h4>`;
  const lb = document.createElement('button');
  lb.className = 'btn danger small';
  lb.textContent = owner ? 'Delete server' : 'Leave server';
  lb.onclick = async () => {
    if (!owner) {
      try {
        await api(`/api/servers/${d.id}/leave`, { method: 'POST' });
        closeServerSettings();
        S.ws?.send(JSON.stringify({ t: 'subscribe' }));
        refreshServers();
      } catch (err) { toast('Failed: ' + prettyError(err.message)); }
      return;
    }
    openModal(`Delete "${d.name}"?`, `<p class="muted">This server and all its messages are deleted forever. Type <b>${esc(d.name)}</b> below to confirm.</p><label>Server name<input id="m-del-name" autocomplete="off" maxlength="48" placeholder="${esc(d.name)}" /></label>`, 'Delete', async () => {
      try {
        await api(`/api/servers/${d.id}`, { method: 'DELETE' });
        closeServerSettings();
        S.ws?.send(JSON.stringify({ t: 'subscribe' }));
        refreshServers();
      } catch (err) { toast('Failed: ' + prettyError(err.message)); }
    }, { danger: true });
    const okBtn = $('#modal-ok'), nameInp = $('#m-del-name');
    okBtn.disabled = true;
    nameInp.addEventListener('input', () => { okBtn.disabled = nameInp.value.trim() !== d.name; });
  };
  dz.appendChild(lb); cur.appendChild(dz);
  if (scroller) scroller.scrollTop = keepScroll;
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
    if (S.view === 'home') renderDmMembers();
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
  if (!e.target.closest('#picker') && !e.target.closest('#btn-emoji') && !e.target.closest('#btn-gif') && !e.target.closest('.msg-actions')) closePicker();
  if (!e.target.closest('#usercard') && !e.target.closest('[data-uid]') && !e.target.closest('.member')) closeUserCard();
  if (statusMenuEl && !e.target.closest('#status-pop') && !e.target.closest('#me-avatar')) closeStatusMenu();
  if (folderMenuEl && !e.target.closest('#folder-menu')) closeFolderMenu();
  if (ctxEl && !e.target.closest('#ctx-menu') && !e.target.closest('.msg-actions')) closeCtx();
  if (document.body.classList.contains('members-open') && !e.target.closest('#members') && !e.target.closest('#btn-members')) document.body.classList.remove('members-open');
  if (!e.target.closest('#composer-more') && !e.target.closest('#btn-more') && !e.target.closest('#btn-plus')) $('#composer-more')?.classList.add('hidden');
});
 document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closePicker(); closeUserCard(); closeStatusMenu(); closeFolderMenu(); closeCtx(); closeSettings(); closeServerSettings(); $('#composer-more')?.classList.add('hidden'); cancelModal(); $('#lightbox').classList.add('hidden'); }
});
function composerAnchor() {
  const t = $('#composer-tools')?.getBoundingClientRect();
  if (!t || !t.width) return null;
  return { x: t.right - 180, y: t.top };
}
$('#btn-emoji').onclick = () => { $('#picker').classList.contains('hidden') ? openPicker('insert', null, 'emoji', composerAnchor()) : closePicker(); };
$('#btn-gif').onclick = () => { $('#picker').classList.contains('hidden') ? openPicker('insert', null, 'gifs', composerAnchor()) : closePicker(); };
// Mobile: composer options live under a + menu (attach / emoji / GIF stay visible on desktop)
$('#btn-more').onclick = (e) => { e.stopPropagation(); closePicker(); $('#composer-more').classList.toggle('hidden'); };
$('#btn-plus').onclick = (e) => { e.stopPropagation(); closePicker(); $('#composer-more').classList.toggle('hidden'); };
$('#cm-attach').onclick = (e) => { e.stopPropagation(); $('#composer-more').classList.add('hidden'); $('#btn-attach').click(); };
$('#cm-emoji').onclick = (e) => { e.stopPropagation(); $('#composer-more').classList.add('hidden'); $('#btn-emoji').click(); };
$('#cm-gif').onclick = (e) => { e.stopPropagation(); $('#composer-more').classList.add('hidden'); $('#btn-gif').click(); };
$('#cm-voice').onclick = (e) => { e.stopPropagation(); $('#composer-more').classList.add('hidden'); startVoiceRec(); };
$('#cm-poll').onclick = (e) => { e.stopPropagation(); $('#composer-more').classList.add('hidden'); openPollModal(); };
$('#rec-cancel').onclick = cancelVoiceRec;
$('#rec-done').onclick = stopVoiceRec;
// Live markdown preview: rendered backdrop behind the transparent input text.
function syncComposerRender() {
  const inp = $('#in-message'), r = $('#in-render-inner');
  if (!inp || !r) return;
  r.innerHTML = inp.value ? renderRich(inp.value, { plain: true }) : '';
  r.style.marginLeft = (-inp.scrollLeft) + 'px';
}
$('#in-message').addEventListener('input', syncComposerRender);
$('#in-message').addEventListener('scroll', () => { const r = $('#in-render-inner'); if (r) r.style.marginLeft = (-$('#in-message').scrollLeft) + 'px'; });

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
  } else if (t.dataset.fbLetter) {
    const cell = t.parentNode;
    if (cell) cell.textContent = t.dataset.fbLetter;
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
initTurnstile();
if (store.token) boot();
else {
  showAuth();
  // Signed-out invite link: preview the server + offer sign in/up (join happens after auth).
  const inv0 = consumeInvite();
  if (inv0) {
    stashInvite(inv0);
    showInviteLanding(inv0);
  }
}
