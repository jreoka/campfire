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
  stdEmoji: {}, // standard :shortcode: -> char, warmed from emoji.json at boot
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
// Escape + fenced code / quotes / inline code / bold / italic / strike +
// spoilers + custom + standard emoji + @mentions + links.
function renderRich(text, opts = {}) {
  let h = esc(text);
  // Fenced code blocks first, so nothing inside them is formatted. A trailing
  // unclosed fence runs to end of message (Discord-style).
  const fences = [];
  h = h.replace(/^```([A-Za-z0-9_+-]*)\r?\n([\s\S]*?)\r?\n```/gm, (m, lang, code) => {
    fences.push({ lang, code });
    return '\u0001' + (fences.length - 1) + '\u0001';
  });
  h = h.replace(/^```([A-Za-z0-9_+-]*)\r?\n([\s\S]*)$/m, (m, lang, code) => {
    fences.push({ lang, code });
    return '\u0001' + (fences.length - 1) + '\u0001';
  });
  // Quote runs: consecutive > lines merge into one blockquote.
  h = h.replace(/(?:^|\n)((?:&gt;[^\n]*(?:\n|$))+)/g, (m, run) => {
    const inner = run.split('\n').filter((l) => l.startsWith('&gt;')).map((l) => l.replace(/^&gt; ?/, ''));
    if (!inner.join('').trim()) return m;
    return '<blockquote>' + inner.join('<br>') + '</blockquote>';
  });
  const codes = [];
  h = h.replace(/`([^`\n]+)`/g, (m, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  h = h.replace(/\|\|(.+?)\|\|/gs, (m, inner) => '<span class="spoiler">' + inner + '</span>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
       .replace(/(^|[\s(])\*([^\*\n]+)\*/g, '$1<em>$2</em>')
       .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  if (!opts.plain) {
  h = h.replace(/:([a-z0-9_+-]{2,32}):/g, (m, n) => S.emoji[n]
    ? '<img class="cemoi" src="' + S.emoji[n] + '" alt="' + m + '" title="' + m + '" data-fb-emoji="' + m + '">' : (S.stdEmoji[n] || m));
  h = h.replace(/(^|[\s(])@([A-Za-z0-9_.]{2,24})/g, (m, pre, un) => {
    const mem = memberByUsername(un);
    if (!mem) return m;
    return pre + '<span class="mention' + (mem.id === S.me.id ? ' me' : '') + '" data-uid="' + mem.id + '">@' + esc(mem.display_name) + '</span>';
  });
  }
  h = h.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  h = h.replace(/\u0000(\d+)\u0000/g, (m, i) => '<code>' + codes[+i] + '</code>');
  h = h.replace(/\u0001(\d+)\u0001/g, (m, i) => {
    const f = fences[+i];
    if (!f) return m;
    const code = f.code.replace(/^\r?\n+|\r?\n+$/g, '');
    return '<pre class="codeblock">' + (f.lang ? '<span class="cb-lang">' + f.lang + '</span>' : '') + '<code>' + code + '</code></pre>';
  });
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

