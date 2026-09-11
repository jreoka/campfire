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
// "Phone layout" = the single-column shell (nav page, drawers, bottom sheets).
// Width alone is the wrong test: a phone held sideways is 850+px wide but only
// ~390px tall, and the desktop three-pane shell (rail + chat list + members)
// crushes the chat in a viewport that short. So a short touch viewport counts
// too. This exact condition is spelled out in the mobile @media blocks in
// styles.css — the two must be kept in sync.
const PHONE_MQ = '(max-width:700px), (max-height:560px) and (pointer:coarse)';
const phoneLayout = () => !!(window.matchMedia && matchMedia(PHONE_MQ).matches);
// ---------- haptics ----------
// Android WebView and Chrome expose navigator.vibrate (iOS never does, so this
// is a silent no-op there). Patterns stay tiny — a tick, not a buzz — and a
// short debounce keeps one gesture's several handlers from rattling the phone.
// The on/off switch lives in Settings → Media (cf_media.haptics).
//
// Deliberately opt-in only: the sheet/ctx long-press, reacting, and picking an
// option. No delegated listener on every button — ordinary taps stay silent so
// the phone isn't buzzing constantly.
let hapticAt = 0;
function hapticsEnabled() {
  try { return typeof mediaPrefs === 'function' ? mediaPrefs().haptics !== false : true; } catch { return true; }
}
function haptic(pattern = 9) {
  if (!navigator.vibrate || !hapticsEnabled()) return;
  const now = Date.now();
  if (now - hapticAt < 40) return; // same gesture, one tick
  hapticAt = now;
  try { navigator.vibrate(pattern); } catch {}
}
// ---------- themes (Settings → Themes): 'dark' (default Campfire skin) |
// 'light' | 'dracula' | 'oled'. Stored globally in localStorage so the auth page and
// the app shell match; applied via <html data-theme> before CSS paints
// (see the inline head script in index.html — this keeps it live after).
const THEME_IDS = ['dark', 'light', 'dracula', 'oled'];
function validTheme(t) { return THEME_IDS.includes(t) ? t : null; }
function localTheme() {
  try { return validTheme(localStorage.getItem('cf_theme')); } catch { return null; }
}
// Account setting wins (S.me.theme may be '' = never set); otherwise the
// device-local value, so the signed-out auth page still matches.
function accountTheme() {
  try { return (typeof S !== 'undefined' && S.me) ? validTheme(S.me.theme) : null; }
  catch { return null; }
}
function getTheme() { return accountTheme() || localTheme() || 'dark'; }
function applyTheme(t, opts = {}) {
  t = validTheme(t) || 'dark';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('cf_theme', t); } catch {}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === 'light' ? '#f2f4f8' : t === 'dracula' ? '#282a36' : t === 'oled' ? '#000000' : '#07090e';
  // Persist to the account so it follows the user cross-device.
  // Fire-and-forget; the server value is authoritative on next boot.
  if (opts.save !== false && typeof S !== 'undefined' && S.me && S.me.theme !== t) {
    S.me.theme = t;
    try {
      api('/api/me', { method: 'PATCH', body: JSON.stringify({ theme: t }) })
        .then(({ user }) => { if (user && validTheme(user.theme)) S.me.theme = user.theme; })
        .catch(() => {});
    } catch {}
  }
}
// Reconcile on boot: server wins once set; otherwise the device-local choice
// is adopted as the account default (covers themes picked while signed out).
function syncAccountTheme() {
  const server = accountTheme(), local = localTheme();
  if (server) { if (local !== server) applyTheme(server, { save: false }); }
  else if (local) applyTheme(local);
  else applyTheme('dark', { save: false });
}
try { applyTheme(localTheme() || 'dark', { save: false }); } catch {}
// Tauri Android draws edge-to-edge; the CSS env() insets normally report the
// status-bar/cutout size, but some WebViews report 0 — probe once and fall
// back to a standard 30px status-bar pad so the header never sits under the
// clock/battery/camera. Desktop and browsers are untouched (insets nonzero
// or no overlap there).
try {
  if (window.__TAURI__ && /android/i.test(navigator.userAgent || '')) {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;padding-top:env(safe-area-inset-top,0px);';
    document.body.appendChild(probe);
    const inset = parseFloat(getComputedStyle(probe).paddingTop) || 0;
    probe.remove();
    if (inset < 8) document.documentElement.classList.add('no-sys-insets');
  }
} catch {}

const S = {
  me: null,
  servers: [],
  serverId: null,
  channelId: null,
  serverDetail: null, // {channels, members, ...}
  messages: new Map(), // channelId -> [msgs]
  online: {}, // userId -> status ('online'|'away'|'dnd'); absent = offline/invisible
  presenceAll: {}, // userId -> last-seen live status across ALL shared servers (feeds DM member list)
  emoji: {}, // current server's custom emoji name -> url (server settings UI)
  emojiAll: {}, // custom emoji of EVERY joined server: name -> {url, serverId}
  serverEmojis: [], // per-server custom emoji lists (picker server rail)
  stdEmoji: {}, // standard :shortcode: -> char, warmed from emoji.json at boot
  gifFavs: null, // my Klipy GIF favorites (server-synced); null = not loaded yet
  replyTo: null, // message being replied to (main composer)
  threadReplyTo: null, // message being replied to (thread composer)
  pendingAtts: [], // uploaded attachments awaiting send
  uploads: [], // in-flight composer uploads (progress cards in #upload-list)
  thread: null, // {rootId, channelId, root, replies[]}
  histMode: null, // {kind:'server'|'dm', id, serverId?} — viewing older (jump-to-pin) context
  histNew: 0, // live arrivals while viewing history (drives the jump pill)
  scrollMem: new Map(), // convo key -> distance-from-bottom px (restores reading pos on return)
  pinIds: new Set(), // pinned message ids in the current channel/thread
  pinIdsCtx: null, // which conversation pinIds was fetched for (guards stale badges)
  pinCount: 0,
  pinsCtx: null, // context the pins popup is open for
  editing: null, // message id being edited
  layoutFolders: [], // [{id,name,color,open,position,servers:[serverId]}]
  serverMeta: new Map(), // serverId -> {folderId, position}
  rootOrder: [], // [{kind:'server'|'folder', id, pos}] rail order top-to-bottom
  openFolderId: null, // id of the folder whose pop-out is expanded (null = none)
  view: 'server', // 'server' | 'home'
  dms: [], friends: { friends: [], pendingIn: [], pendingOut: [], blocked: [] },
  friendTab: 'all', // friends page tab: 'online' | 'all' | 'pending' (blocked lives in Settings)
  dmThreadId: null, dmMessages: new Map(), // threadId -> [msgs]
  dmUnread: new Map(), // threadId -> unread DM count (drives DM row + home button badges)
  chanUnread: new Map(), // "serverId:channelId" -> 1 while the channel has unread messages (drives channel dots)
  voiceOccupancy: new Map(), // channelId -> [peers]
  voiceSince: new Map(), // channelId -> epoch ms first seen occupied (drives room timers)
  friendsVoice: new Map(), // userId -> {kind,serverId,channelId,threadId,joinable,…} (Active Now IN VOICE)
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  maxUploadMb: 200, // attachment cap, refreshed from /api/config at boot (server-owned)
  voice: null, // {serverId, channelId, stream, pcs:Map, muted, analysers}
  ws: null,
  typingTimers: new Map(),
  typingNames: new Map(),
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
// Layout size of a popup that was just inserted, for viewport clamping.
// Deliberately offsetWidth/offsetHeight and NOT getBoundingClientRect():
// popups enter with the cf-pop-in scale() animation, and the rect reports
// that shrunken (transformed) box while the animation runs — a menu clamped
// from a 94%-scale reading comes up ~6% short and hangs off the bottom edge.
function popupBox(el) {
  return { w: el.offsetWidth, h: el.offsetHeight };
}
/* Default avatar color: deterministic per account (no custom picker). Same
 * palette the backend uses at signup; keyed on stable account id so a user
 * keeps the same fallback color on every device. */
const AV_COLORS = ['#5865f2', '#3ba55d', '#ed4245', '#faa81a', '#9b59b6', '#1abc9c', '#e91e63', '#00b0f4'];
// Avatar decorations (settings → profile). IDs must match AVATAR_DECOS in server.js.
const AVATAR_DECOS = [
  { id: 'ember', name: 'Ember Glow', camp: true },
  { id: 'fireflies', name: 'Fireflies', camp: true },
  { id: 'aurora', name: 'Northern Lights', camp: true },
  { id: 'neon', name: 'Neon Pulse', camp: false },
  { id: 'tide', name: 'Tide Spin', camp: false },
  { id: 'stardust', name: 'Stardust Sweep', camp: false },
];
const AV_DECO_IDS = new Set(AVATAR_DECOS.map((d) => d.id));
/* Early-user badge: kept forever once earned. Eligibility is pinned to a fixed
 * cutoff (one year from 2026-09-10): any account created on or before that
 * date shows the badge permanently. */
const EARLY_USER_CUTOFF = Date.parse('2027-09-10T00:00:00Z');
function isEarlyUser(u) {
  const t = Number(u && u.created_at);
  return Number.isFinite(t) && t > 0 && t <= EARLY_USER_CUTOFF;
}
function isSysAdmin(u) { return !!(u && u.is_admin); }
/* Server tags: guild admins may set a ≤4-char tag members can show after
 * their name everywhere. The snapshot lives on the user (active_tag) so
 * every surface renders it with zero lookups. */
function activeTagFor(u) {
  const t = u && u.active_tag ? String(u.active_tag).replace(/\s/g, '') : '';
  if (!t) return '';
  // Emoji + up to 4 chars: cap at 5 graphemes as a backstop (server validates).
  try {
    const segs = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(t)].map((s) => s.segment);
    return segs.slice(0, 5).join('');
  } catch { return Array.from(t).slice(0, 5).join(''); }
}
function tagHTML(u, plain) {
  const t = activeTagFor(u);
  if (!t) return '';
  // `plain` renders it as a decorative pill (no click target). The DM sidebar
  // uses it: those rows are buttons that open a conversation, so a server tag
  // there must never steal the tap into its own mini-panel.
  const sid = !plain && u && u.active_tag_server_id ? String(u.active_tag_server_id) : '';
  // Span (not button: tags render inside buttons/links elsewhere) with a
  // delegated click in final.js that opens the server mini-panel.
  return '<span class="usertag' + (sid ? ' clickable' : '') + '"' + (sid ? ' data-tag-sid="' + esc(sid) + '" role="button" tabindex="0" title="View server"' : '') + '>' + esc(t) + '</span>';
}
function avatarColorFor(user) {
  const key = String((user && (user.id || user.username || user.display_name)) || '');
  if (!key) return AV_COLORS[0]; let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return AV_COLORS[(h >>> 0) % AV_COLORS.length];
}
function avatar(el, name, userOrColor) {
  const c = (userOrColor && typeof userOrColor === 'object') ? avatarColorFor(userOrColor)
    : avatarColorFor({ id: String((name || '?') + '') });
  el.style.background = c;
  el.style.boxShadow = 'none';
  el.textContent = (name || '?').trim().charAt(0).toUpperCase() || '?';
}
function paintAvatar(el, user) {
  if (!el) return;
  el.classList.add('avatar');
  for (const c of [...el.classList]) if (c.indexOf('deco-') === 0) el.classList.remove(c);
  const dec = user && AV_DECO_IDS.has(user.avatar_decoration) ? user.avatar_decoration : '';
  if (dec) el.classList.add('deco-' + dec);
  if (user && user.avatar_url) {
    el.style.background = 'transparent';
    el.style.boxShadow = 'none';
    el.innerHTML = '';
    const img = document.createElement('img');
    img.src = user.avatar_url; img.alt = ''; img.loading = 'lazy';
    img.onerror = () => { el.innerHTML = ''; avatar(el, user.display_name, user); };
    el.appendChild(img);
  } else {
    el.innerHTML = '';
    avatar(el, user ? user.display_name : '?', user || null);
  }
}
// Webhook messages carry their poster in m.webhook (a name/avatar snapshot),
// not m.user. This resolves whichever author a message actually has, so
// every surface (chat, sheets, forward, reply chips) renders bots right.
function msgAuthor(m) {
  if (m && m.webhook) return { id: 'wh:' + (m.webhook.id || m.webhook.name || '?'), display_name: m.webhook.name || 'Webhook', username: m.webhook.name || 'Webhook', avatar_url: m.webhook.avatar_url || null };
  return liveUserFor(m && m.user);
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
  // A user can appear in several sources at once (server members, current DM
  // members, friends). Server rows are partial (no created_at), so merge
  // matches: first source wins, missing fields are filled from the others.
  const matches = [
    ...((S.serverDetail && S.serverDetail.members) || []),
    ...((((S.dms || []).find((t) => t.id === S.dmThreadId)) || {}).members || []),
    ...((S.friends && S.friends.friends) || []),
    ...((S.friends && S.friends.pendingIn) || []),
    ...((S.friends && S.friends.pendingOut) || []),
    ...((S.friends && S.friends.blocked) || []),
  ].filter((m) => m && m.id === id);
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];
  const merged = { ...matches[0] };
  for (const m of matches.slice(1)) {
    for (const k in m) if (merged[k] === undefined || merged[k] === null || merged[k] === '') merged[k] = m[k];
  }
  return merged;
}
// Escape + fenced code / quotes / inline code / bold / italic / strike +
// spoilers + custom + standard emoji + @mentions + links.
//
// `opts.plain` is the composer's live-preview backdrop: the caret lives in the
// transparent textarea above it, so the backdrop must lay out exactly the same
// characters. Markdown delimiters are therefore kept in the flow (dimmed via
// .md-tok) instead of dropped, and the composer CSS must never change glyph
// metrics (weight, size, padding) — one dropped character and the caret drifts
// off the text it is supposed to be sitting in.
function renderRich(text, opts = {}) {
  const plain = !!opts.plain;
  const tok = (s) => (plain ? '<span class="md-tok">' + s + '</span>' : '');
  let h = esc(text);
  // Fenced code blocks first, so nothing inside them is formatted. A trailing
  // unclosed fence runs to end of message (Discord-style).
  const fences = [];
  h = h.replace(/^```([A-Za-z0-9_+-]*)\r?\n([\s\S]*?)\r?\n```/gm, (m, lang, code) => {
    fences.push({ lang, code, closed: true });
    return '\u0001' + (fences.length - 1) + '\u0001';
  });
  h = h.replace(/^```([A-Za-z0-9_+-]*)\r?\n([\s\S]*)$/m, (m, lang, code) => {
    fences.push({ lang, code, closed: false });
    return '\u0001' + (fences.length - 1) + '\u0001';
  });
  // Quote runs: consecutive > lines merge into one blockquote. The backdrop
  // keeps the > characters and just tones the run down.
  h = h.replace(/(?:^|\n)((?:&gt;[^\n]*(?:\n|$))+)/g, (m, run) => {
    const inner = run.split('\n').filter((l) => l.startsWith('&gt;')).map((l) => l.replace(/^&gt; ?/, ''));
    if (!inner.join('').trim()) return m;
    if (plain) return '<span class="md-quote">' + m + '</span>';
    return '<blockquote>' + inner.join('<br>') + '</blockquote>';
  });
  const codes = [];
  h = h.replace(/`([^`\n]+)`/g, (m, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  h = h.replace(/\|\|(.+?)\|\|/gs, (m, inner) => tok('||') + '<span class="spoiler">' + inner + '</span>' + tok('||'));
  h = h.replace(/\*\*([^*]+)\*\*/g, (m, inner) => tok('**') + '<strong>' + inner + '</strong>' + tok('**'))
       .replace(/(^|[\s(])\*([^\*\n]+)\*/g, (m, pre, inner) => pre + tok('*') + '<em>' + inner + '</em>' + tok('*'))
       .replace(/~~([^~]+)~~/g, (m, inner) => tok('~~') + '<del>' + inner + '</del>' + tok('~~'));
  if (!opts.plain) {
  h = h.replace(/:([a-z0-9_+-]{2,32}):/g, (m, n) => {
    const em = S.emojiAll[n]; // cross-server: any emoji from a joined server
    return em
      ? '<img class="cemoi" src="' + em.url + '" alt="' + m + '" title="' + m + '" data-fb-emoji="' + m + '">'
      : (S.stdEmoji[n] || m);
  });
  h = h.replace(/(^|[\s(])@([A-Za-z0-9_.]{2,24})/g, (m, pre, un) => {
    const mem = memberByUsername(un);
    if (!mem) return m;
    return pre + '<span class="mention' + (mem.id === S.me.id ? ' me' : '') + '" data-uid="' + mem.id + '">@' + esc(mem.display_name) + '</span>';
  });
  // #channel links: only in server context, and only when the name matches a
  // real channel (so #5, C#, hex colors etc. stay plain text).
  h = h.replace(/(^|[\s(])#([A-Za-z0-9_-]{1,32})/g, (m, pre, name) => {
    if (S.view !== 'server') return m;
    const ch = (S.serverDetail?.channels || []).find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!ch) return m;
    return pre + '<span class="chan-link" data-clink="' + ch.id + '" data-ctype="' + ch.type + '">#' + esc(ch.name) + '</span>';
  });
  }
  h = h.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  h = h.replace(/\u0000(\d+)\u0000/g, (m, i) => tok('`') + '<code>' + codes[+i] + '</code>' + tok('`'));
  h = h.replace(/\u0001(\d+)\u0001/g, (m, i) => {
    const f = fences[+i];
    if (!f) return m;
    // Backdrop: the exact fence characters with the ``` lines dimmed, so the
    // block still reads as code without moving a single glyph.
    if (plain) return tok('```' + f.lang) + '\n' + f.code + (f.closed ? '\n' + tok('```') : '');
    const code = f.code.replace(/^\r?\n+|\r?\n+$/g, '');
    return '<pre class="codeblock">' + (f.lang ? '<span class="cb-lang">' + f.lang + '</span>' : '') + '<code>' + code + '</code></pre>';
  });
  return h;
}
function isBigEmoji(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 24) return false;
  if (/^:[a-z0-9_+-]{2,32}:$/.test(t)) return true; // lone custom emoji renders big
  try { return /^[\p{Extended_Pictographic}\s]+$/u.test(t) && [...t].filter((c) => c.trim()).length <= 6; }
  catch { return false; }
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtFull(ts) {
  try { return new Date(ts).toLocaleString([], { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch { return String(ts || ''); }
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
// Union of custom emoji across every server the user has joined: a
// joined server's emoji can be sent and rendered anywhere, and the
// per-server lists feed the picker's server rail. The current server's
// emoji wins name collisions.
async function refreshAllEmojis() {
  try {
    const { servers } = await api('/api/emojis');
    const cur = S.serverId;
    const ordered = [...servers].sort((a, b) => (b.id === cur ? 1 : 0) - (a.id === cur ? 1 : 0));
    const all = {};
    for (const s of ordered) for (const e of s.emoji) if (!all[e.name]) all[e.name] = { url: e.url, serverId: s.id };
    S.emojiAll = all;
    S.serverEmojis = servers;
  } catch {}
}
// Local per-user memory of the last-open view (DM / group chat / server /
// channel). Kept in localStorage keyed by user id, so after a browser
// restart the app reopens exactly where you left off. Local-only —
// nothing is ever sent to the server.
function readMemView() {
  if (!S.me) return null;
  try {
    const v = JSON.parse(localStorage.getItem('cf_view_' + S.me.id) || 'null');
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}
function rememberView() {
  if (!S.me) return;
  const v = {
    view: S.view,
    s: S.view === 'server' ? S.serverId : null,
    c: S.view === 'server' ? S.channelId : null,
    dm: S.view === 'home' ? S.dmThreadId : null,
    // Only a thread that belongs to the channel we're remembering: a panel
    // left open across a channel switch must not come back in the wrong one.
    th: S.view === 'server' && S.thread && S.thread.channelId === S.channelId ? S.thread.rootId : null,
  };
  try { localStorage.setItem('cf_view_' + S.me.id, JSON.stringify(v)); } catch {}
}

/* ---------- composer drafts ----------
 * Text in the message box (and the thread reply box) is saved as you type,
 * per conversation, so a reload — the auto-updater, a deploy, an accidental
 * F5, a crash — never eats what was being written. Per account, in
 * localStorage, so signing in as someone else never surfaces leftover text.
 * Contexts: 's:<serverId>:<channelId>', 'd:<threadId>', 't:<rootMessageId>'. */
const DRAFTS_MAX = 40;
const DRAFTS_TTL = 30 * 864e5;
function draftsKey() { return S.me ? 'cf_drafts_' + S.me.id : null; }
function draftCtx() {
  if (S.view === 'home') return S.dmThreadId ? 'd:' + S.dmThreadId : null;
  return S.serverId && S.channelId ? 's:' + S.serverId + ':' + S.channelId : null;
}
function draftThreadCtx() { return S.thread && S.thread.rootId ? 't:' + S.thread.rootId : null; }
// Which draft key a composer element belongs to.
function draftCtxForEl(el) { return el && el.id === 'in-thread' ? draftThreadCtx() : draftCtx(); }
function draftGet(ctx) {
  if (!ctx) return '';
  let all = {};
  const k = draftsKey();
  if (!k) return '';
  try { all = JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch { return ''; }
  const d = all[ctx];
  if (!d || typeof d.t !== 'string') return '';
  return Date.now() - (d.at || 0) > DRAFTS_TTL ? '' : d.t;
}
function draftSet(ctx, text) {
  const k = draftsKey();
  if (!k || !ctx) return;
  let all = {};
  try { all = JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch { all = {}; }
  // Deleting first puts the key at the end when it is re-added, so the stored
  // order is write order (same-millisecond writes still prune deterministically).
  delete all[ctx];
  if (text) all[ctx] = { t: text, at: Date.now() };
  // Keep the store small: oldest writes fall off the front, anything past the
  // TTL is dropped.
  const cut = Date.now() - DRAFTS_TTL;
  const keys = Object.keys(all).filter((x) => all[x] && (all[x].at || 0) >= cut);
  const out = {};
  for (const x of keys.slice(-DRAFTS_MAX)) out[x] = all[x];
  try { localStorage.setItem(k, JSON.stringify(out)); } catch {}
}
// Clearing has to kill the debounced write too: sending a message clears the
// draft, and a pending keystroke from a moment earlier would otherwise land in
// the store 300ms later as a phantom draft of the message just sent.
function draftClear(ctx) {
  if (draftPending && (!ctx || draftPending.ctx === ctx)) {
    clearTimeout(draftTimer);
    draftTimer = null;
    draftPending = null;
  }
  draftSet(ctx, '');
}
// Typing is debounced, and the pending write remembers the context it was
// typed in — so switching chats right after typing still files the text under
// the conversation it belongs to. flushDrafts() writes it out synchronously
// (beforeunload, or right before a context switch).
let draftTimer = null, draftPending = null;
function draftSoon(el, ctx) {
  if (!el || !ctx) return;
  draftPending = { ctx, text: el.value };
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDrafts, 300);
}
function flushDrafts() {
  clearTimeout(draftTimer);
  draftTimer = null;
  const p = draftPending;
  draftPending = null;
  if (p) draftSet(p.ctx, p.text);
}
// Put the right drafts back into whatever conversation is open now: the main
// box from its channel/DM key, the thread box from its root message. Called at
// boot and on every channel / DM / thread switch.
function applyComposerDraft() {
  const ta = $('#in-message');
  const ctx = draftCtx();
  if (ta && ctx) {
    const t = draftGet(ctx);
    if (ta.value !== t) {
      ta.value = t;
      try { syncComposerRender(); } catch {}
    }
    // Re-fit on every switch, not just when the text changed: the box's
    // height has to track what is in it, or a stale height (a stray tall box)
    // rides along into the next chat until a reload.
    try { composerAutoGrow(ta); } catch {}
  }
  const ti = $('#in-thread');
  const tctx = draftThreadCtx();
  if (ti && tctx) {
    const t = draftGet(tctx);
    if (ti.value !== t) ti.value = t;
    try { composerAutoGrow(ti); } catch {}
  }
}

