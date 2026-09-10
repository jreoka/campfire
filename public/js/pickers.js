'use strict';
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
  renderEmojiRail();
  renderEmojiGrid('');
  ensureEmojiData().then(() => { if (S.picker) renderEmojiGrid($('#pk-search').value); });
  if (mode !== 'react' && mode !== 'tag') loadGifTrending();
  loadGifFavs();
  setTimeout(() => $('#pk-search').focus(), 0);
}
function closePicker() { $('#picker').classList.add('hidden'); S.picker = null; S.gifPick = null; }
S.gifPick = null; // 'avatar'|'banner' when the GIF picker is choosing profile media
S.tagEmojiInput = null; // target button when the picker is choosing a server-tag emoji
S.tagEmojiDone = null; // repaint callback after a tag-emoji pick
function setPickerTab(t) {
  document.querySelectorAll('.pk-tab').forEach((b) => b.classList.toggle('active', b.dataset.ptab === t));
  $('#pk-emoji').classList.toggle('hidden', t !== 'emoji');
  $('#picker .pk-body').classList.toggle('hidden', t !== 'emoji');
  $('#pk-gifs').classList.toggle('hidden', t !== 'gifs');
  $('#pk-klipy').classList.toggle('hidden', t !== 'gifs');
  $('#pk-search').placeholder = t === 'gifs' ? 'Search KLIPY' : 'Search emoji';
  if (t === 'emoji') renderEmojiRail();
  if (t === 'gifs') { gifSubView = 'all'; renderGifTab(); }
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
// Load the full emoji dataset (if needed) and build the :shortcode: -> char
// map used by renderRich. Awaited in boot() before first message render.
function warmStdEmoji() {
  return ensureEmojiData().then(() => {
    S.stdEmoji = {};
    const sc = emojiData && emojiData.shortcodes;
    if (sc) for (const [name, ch] of Object.entries(sc)) S.stdEmoji[name] = ch;
  });
}
function emojiButton(box, ch, label, onclick) {
  const b = document.createElement('button');
  b.className = 'pk-emoji-btn';
  b.textContent = ch;
  if (label) b.title = label;
  b.onclick = onclick;
  box.appendChild(b);
}
// Emoji tab navigation: 'Emoji' (standard) or a joined server's custom
// emoji (Discord-style server rail). Search spans all servers + standard.
let emojiPickServer = null; // server id in the rail (null = standard view)
function emojiCustomBtn(box, n, url) {
  const b = document.createElement('button');
  b.className = 'pk-emoji-btn'; b.title = ':' + n + ':';
  b.innerHTML = `<img class="pk-custom" src="${esc(url)}" alt=":${esc(n)}:" />`;
  b.onclick = () => pickEmoji(':' + n + ':');
  box.appendChild(b);
}
function renderStdGroups(box, f) {
  let shown = 0;
  if (emojiData) {
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
  } else {
    for (const [ch, kw] of EMOJI) {
      if (ch === 'sec') { box.insertAdjacentHTML('beforeend', `<div class="pk-sec">${esc(kw)}</div>`); continue; }
      if (f && !(kw || '').includes(f)) continue;
      emojiButton(box, ch, null, () => pickEmoji(ch));
    }
  }
}
function renderEmojiRail() {
  const rail = $('#pk-server-rail');
  if (!rail) return;
  rail.innerHTML = '';
  const mk = (ico, name, active, fn) => {
    const b = document.createElement('button');
    b.className = 'pk-rail-btn' + (active ? ' active' : '');
    b.innerHTML = `<span class="pk-rail-ico">${ico}</span><span class="pk-rail-name">${esc(name)}</span>`;
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    rail.appendChild(b);
  };
  mk('<span class="pk-rail-std">😀</span>', 'Emoji', emojiPickServer === null, () => { emojiPickServer = null; renderEmojiRail(); renderEmojiGrid($('#pk-search').value); });
  for (const s of S.serverEmojis || []) {
    const sv = (S.servers || []).find((x) => x.id === s.id);
    const letter = (s.name || 'S').trim().charAt(0).toUpperCase();
    const ico = sv && sv.icon_url
      ? `<img src="${esc(sv.icon_url)}" alt="" loading="lazy" draggable="false" onerror="this.replaceWith(document.createTextNode('${letter}'))" />`
      : letter;
    mk(ico, s.name, emojiPickServer === s.id, () => { emojiPickServer = s.id; renderEmojiRail(); renderEmojiGrid($('#pk-search').value); });
  }
}
function renderEmojiGrid(filter) {
  const box = $('#pk-emoji');
  box.innerHTML = '';
  const f = filter.trim().toLowerCase();
  if (f) {
    // search spans every joined server's custom emoji + standard
    for (const s of S.serverEmojis || []) {
      const hits = s.emoji.filter((e) => e.name.toLowerCase().includes(f));
      if (!hits.length) continue;
      box.insertAdjacentHTML('beforeend', `<div class="pk-sec">${esc(s.name)}</div>`);
      for (const e of hits) emojiCustomBtn(box, e.name, e.url);
    }
    renderStdGroups(box, f);
  } else if (emojiPickServer) {
    const s = (S.serverEmojis || []).find((x) => x.id === emojiPickServer);
    if (!s || !s.emoji.length) box.innerHTML = '<div class="pk-empty">No custom emoji in this server yet.</div>';
    else {
      box.insertAdjacentHTML('beforeend', `<div class="pk-sec">${esc(s.name)}</div>`);
      for (const e of s.emoji) emojiCustomBtn(box, e.name, e.url);
    }
  } else {
    renderStdGroups(box, '');
  }
  if (!box.children.length) box.innerHTML = '<div class="pk-empty">No emoji match.</div>';
}
function pickEmoji(e) {
  if (S.picker?.mode === 'tag') {
    // Server-tag emoji: standard unicode emoji only (no custom :shortcodes:).
    // Done (auto-save) runs only on a valid pick.
    if (!/\p{Extended_Pictographic}/u.test(e) || /^:[\w+-]+:$/.test(e)) { toast('Tags support standard emoji only'); }
    else {
      if (S.tagEmojiInput && S.tagEmojiInput.isConnected) S.tagEmojiInput.dataset.emoji = e;
      try { S.tagEmojiDone && S.tagEmojiDone(); } catch {}
    }
    S.tagEmojiInput = null; S.tagEmojiDone = null;
    closePicker();
    return;
  }
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
    if (gifSubView === 'favs') { gifQuery = q; renderGifTab(); return; }
    clearTimeout(gifSearchT);
    if (!q.trim()) { loadGifTrending(); return; }
    gifSearchT = setTimeout(() => loadGifSearch(q.trim()), 350);
  } else {
    renderEmojiGrid(q);
  }
}
$('#pk-search').addEventListener('input', (e) => applyPickerSearch(e.target.value));
let gifResults = null; // null = loading
let gifQuery = '';
let gifFailed = false;
let gifSubView = 'all'; // 'all' (trending/results) | 'favs' (Favorites menu)
const STAR_PATH = 'M12 2l2.9 6.9 7.1.6-5.4 4.7 1.6 7-6.2-3.8-6.2 3.8 1.6-7-5.4-4.7 7.1-.6z';
function gifButton(g, fav, onclick) {
  const b = document.createElement('button');
  b.className = 'pk-gif'; b.title = g.title || 'GIF';
  b.innerHTML = `<img src="${esc(g.thumb || g.preview || g.gif)}" alt="${esc(g.title || 'GIF')}" loading="lazy" />` +
    `<button class="pk-star${fav ? ' on' : ''}" title="${fav ? 'Remove favorite' : 'Add to favorites'}">` +
    `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}"/></svg></button>`;
  b.onclick = onclick;
  b.querySelector('.pk-star').onclick = (e) => { e.stopPropagation(); toggleGifFav(g); };
  return b;
}
// GIFs tab has two sub-views: "All GIFs" (KLIPY trending/search results) and
// "Favorites" (its own menu). The search box filters whichever sub-view is open.
function renderGifTab() {
  const box = $('#pk-gifs');
  box.innerHTML = '';
  const q = gifQuery.toLowerCase();
  const n = S.gifFavs ? S.gifFavs.length : null;
  const favSlugs = new Set((S.gifFavs || []).map((f) => f.slug));
  $('#pk-search').placeholder = gifSubView === 'favs' ? 'Search favorites' : 'Search KLIPY';
  if (gifSubView === 'favs') {
    box.insertAdjacentHTML('beforeend',
      `<div class="pk-subrow"><button class="pk-subbtn" data-pkback="1">← All GIFs</button>` +
      `<span class="pk-subtitle">Favorites${n === null ? '' : ` (${n})`}</span></div>`);
    box.querySelector('[data-pkback]').onclick = (e) => {
      e.stopPropagation(); // re-render detaches this button; without this the
      // global "outside click closes picker" handler would see a detached target
      gifSubView = 'all';
      $('#pk-search').value = '';
      loadGifTrending();
    };
    if (S.gifFavs === null) {
      box.insertAdjacentHTML('beforeend', '<div class="pk-empty small">Loading…</div>');
    } else {
      const favs = q
        ? S.gifFavs.filter((g) => (g.title || '').toLowerCase().includes(q) || (g.slug || '').includes(q))
        : S.gifFavs;
      if (!favs.length) {
        box.insertAdjacentHTML('beforeend', `<div class="pk-empty small">${q ? 'No favorites match.' : 'No favorites yet — star a GIF in All GIFs to add them here.'}</div>`);
      } else {
        for (const g of favs) box.appendChild(gifButton(g, true, () => sendGif(g)));
      }
    }
  } else {
    box.insertAdjacentHTML('beforeend',
      `<div class="pk-subrow"><button class="pk-subbtn on" data-pkfavs="1">Favorites${n === null ? '' : ` (${n})`}</button></div>`);
    box.querySelector('[data-pkfavs]').onclick = (e) => {
      e.stopPropagation(); // re-render detaches this button; without this the
      // global "outside click closes picker" handler would see a detached target
      gifSubView = 'favs';
      renderGifTab();
    };
    box.insertAdjacentHTML('beforeend', `<div class="pk-sec">${q ? 'KLIPY results' : 'Trending'}</div>`);
    if (gifResults === null) box.insertAdjacentHTML('beforeend', '<div class="pk-empty small">Loading…</div>');
    else if (!gifResults.length) box.insertAdjacentHTML('beforeend', `<div class="pk-empty small">${gifFailed ? 'GIFs unavailable.' : 'No GIFs found.'}</div>`);
    else for (const g of gifResults) box.appendChild(gifButton(g, favSlugs.has(g.slug), () => sendGif(g)));
  }
}
// ---------- GIF favorites (per-user, synced across devices) ----------
async function loadGifFavs() {
  if (S.gifFavs !== null) return;
  try {
    const { favorites } = await api('/api/me/gif-favorites');
    if (S.gifFavs !== null) return; // superseded by a later load
    S.gifFavs = favorites;
  } catch { /* leave null; the tab shows Loading and retries on next open */ }
  refreshFavViews();
}
async function toggleGifFav(g) {
  if (!g || !g.slug) return;
  const fav = (S.gifFavs || []).some((f) => f.slug === g.slug);
  try {
    if (fav) {
      await api('/api/me/gif-favorites/' + encodeURIComponent(g.slug), { method: 'DELETE' });
      S.gifFavs = S.gifFavs.filter((f) => f.slug !== g.slug);
    } else {
      const saved = await api('/api/me/gif-favorites', {
        method: 'POST',
        body: JSON.stringify({ slug: g.slug, title: g.title, thumb: g.thumb, gif: g.gif, mp4: g.mp4 }),
      });
      S.gifFavs = [saved, ...((S.gifFavs || []).filter((f) => f.slug !== g.slug))];
    }
    refreshFavViews();
  } catch (err) { toast('Favorites update failed: ' + prettyError(err.message)); }
}
function refreshFavViews() {
  if (!S.picker) return;
  if (document.querySelector('.pk-tab.active')?.dataset.ptab === 'gifs') renderGifTab();
}
async function loadGifTrending() {
  gifQuery = ''; gifResults = null; gifFailed = false;
  renderGifTab();
  try {
    const { gifs } = await api('/api/gifs/trending');
    gifResults = gifs;
  } catch { gifResults = []; gifFailed = true; }
  if (S.picker) renderGifTab();
}
async function loadGifSearch(q) {
  gifQuery = q; gifResults = null; gifFailed = false;
  renderGifTab();
  try {
    const { gifs } = await api('/api/gifs/search?q=' + encodeURIComponent(q));
    gifResults = gifs;
  } catch { gifResults = []; gifFailed = true; }
  if (S.picker) renderGifTab();
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
    updateMsgInCaches(mid, (m) => { m.reactions = reactions.map((r) => ({ emoji: r.emoji, count: r.count, me: r.me, users: r.users || [] })); });
    reactionDetailCache.delete(mid); // counts changed — refetch on next view
    if (S.view === 'home') { if (S.dmThreadId) renderDmMessages(); }
    else if (S.channelId) renderMessages();
    if (S.thread) renderThread();
  } catch (err) { toast('Reaction failed: ' + prettyError(err.message)); }
}
/* ---------- reaction details: hover tooltip + View-reactions modal ---------- */
// Per-message cache of the detailed endpoint (emoji -> full user objects).
// Invalidated on toggle + live socket updates so names never go stale.
const reactionDetailCache = new Map(); // mid -> { at, reactions }
async function fetchReactionDetails(mid) {
  const hit = reactionDetailCache.get(mid);
  if (hit && Date.now() - hit.at < 30000) return hit.reactions;
  const m = msgById(mid);
  if (!m) return null;
  const base = m._dm ? '/api/dms/messages/' : '/api/messages/';
  const { reactions } = await api(base + mid + '/reactions');
  reactionDetailCache.set(mid, { at: Date.now(), reactions });
  return reactions;
}
function reactionEmojiHTML(emoji) {
  const em = S.emojiAll[String(emoji).slice(1, -1)];
  if (String(emoji).startsWith(':') && String(emoji).endsWith(':') && em)
    return `<img class="cemoi" src="${esc(em.url)}" alt="${esc(emoji)}">`;
  return esc(emoji);
}
// Styled hover tooltip (desktop): emoji + up to 10 names + overflow count.
// Native `title` (see reactionTitle) remains as the fallback / a11y label;
// while the bubble is visible we clear it so both don't stack.
let reactTipEl = null, reactTipFor = null, reactTipTimer = 0;
function hideReactionTip(restore = true) {
  if (reactTipTimer) { clearTimeout(reactTipTimer); reactTipTimer = 0; }
  if (reactTipEl) { reactTipEl.remove(); reactTipEl = null; }
  if (restore && reactTipFor && reactTipFor.isConnected) {
    const r = reactTipFor._reactRef;
    if (r) reactTipFor.title = reactionTitle(r);
  }
  reactTipFor = null;
}
function showReactionTip(btn, mid, emoji) {
  if (isCoarse()) return; // touch: tap toggles, long-press menu has View reactions
  hideReactionTip(false);
  const m = msgById(mid);
  const ref = m?.reactions?.find((x) => x.emoji === emoji);
  if (!m || !ref) return;
  btn._reactRef = ref;
  const tip = document.createElement('div');
  tip.id = 'reaction-tip';
  const paint = (users, loading) => {
    const shown = users.slice(0, 10);
    const total = ref.count || users.length;
    const extra = total > shown.length ? total - shown.length : 0;
    tip.innerHTML = `<span class="rt-emoji">${reactionEmojiHTML(emoji)}</span><span class="rt-names">${shown.map((u) => `<b>${esc(u.display_name || u.username || '?')}</b>`).join(', ')}${extra ? ` <span class="muted">and ${extra} more</span>` : ''}${loading ? ' <span class="muted">…</span>' : ''}</span><span class="rt-count">${ref.count}</span>`;
  };
  // Instant: resolve cached IDs locally, then enrich via the endpoint.
  const local = (ref.users || []).map((id) => {
    if (S.me && id === S.me.id) return S.me;
    try { return memberById(id) || { id, display_name: null, username: null }; }
    catch { return { id, display_name: null, username: null }; }
  });
  const known = local.filter((u) => u && (u.display_name || u.username));
  paint(known.length ? known : [{ display_name: `${ref.count} reaction${ref.count === 1 ? '' : 's'}` }], true);
  document.body.appendChild(tip);
  const r = btn.getBoundingClientRect();
  tip.style.visibility = 'hidden';
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = Math.max(8, Math.min(r.left + r.width / 2 - tw / 2, innerWidth - tw - 8)) + 'px';
  let top = r.top - th - 8;
  if (top < 8) top = r.bottom + 8;
  tip.style.top = top + 'px';
  tip.style.visibility = '';
  reactTipEl = tip;
  reactTipFor = btn;
  btn.title = ''; // suppress native while the bubble shows
  fetchReactionDetails(mid).then((full) => {
    if (!reactTipEl || reactTipFor !== btn || !btn.isConnected) return;
    const g = (full || []).find((x) => x.emoji === emoji);
    if (g && g.users?.length) {
      paint(g.users, false);
      const r2 = btn.getBoundingClientRect();
      const tw2 = tip.offsetWidth;
      tip.style.left = Math.max(8, Math.min(r2.left + r2.width / 2 - tw2 / 2, innerWidth - tw2 - 8)) + 'px';
    } else if (known.length) paint(known, false);
  }).catch(() => { if (reactTipEl && reactTipFor === btn) paint(known.length ? known : [{ display_name: `${ref.count}` }], false); });
  reactTipTimer = setTimeout(() => hideReactionTip(), 4000);
}
// Hover delegation: slight delay so sweeping the mouse across chat doesn't
// flash bubbles on every reaction.
let reactHoverT = 0;
document.addEventListener('mouseover', (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('.reaction[data-emoji]') : null;
  if (!btn) return;
  if (reactTipFor === btn) return;
  clearTimeout(reactHoverT);
  const msgEl = btn.closest('[data-mid]');
  const mid = msgEl && msgEl.dataset.mid;
  if (!mid) return;
  reactHoverT = setTimeout(() => showReactionTip(btn, mid, btn.dataset.emoji), 350);
});
document.addEventListener('mouseout', (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('.reaction[data-emoji]') : null;
  if (btn && reactTipFor === btn) { clearTimeout(reactHoverT); hideReactionTip(); }
  else clearTimeout(reactHoverT);
});
document.addEventListener('scroll', () => hideReactionTip(), true);
// Full viewer: grouped by emoji, every reactor with avatar + name.
async function openReactionsModal(mid) {
  const m = msgById(mid);
  if (!m) return;
  if (!m.reactions?.length) { toast('No reactions yet'); return; }
  const total = m.reactions.reduce((n, r) => n + (r.count || 0), 0);
  openModal(`Reactions · ${total}`, '<div class="rx-list"><p class="muted small" style="text-align:center;padding:1rem">Loading…</p></div>', 'Close', null, { wide: true });
  const box = document.querySelector('#modal-body .rx-list');
  if (!box) return;
  let full;
  try { full = await fetchReactionDetails(mid); }
  catch { box.innerHTML = '<p class="error">Could not load reactions.</p>'; return; }
  if (!box.isConnected) return;
  if (!full?.length) { box.innerHTML = '<p class="muted small" style="text-align:center;padding:1rem">No reactions yet.</p>'; return; }
  // Keep the message's own emoji order.
  const order = new Map((m.reactions || []).map((r, i) => [r.emoji, i]));
  full = [...full].sort((a, b) => (order.get(a.emoji) ?? 99) - (order.get(b.emoji) ?? 99));
  box.innerHTML = '';
  for (const g of full) {
    const sec = document.createElement('div');
    sec.className = 'rx-group';
    sec.innerHTML = `<div class="rx-head"><span class="rx-emoji">${reactionEmojiHTML(g.emoji)}</span><span class="rx-count">${g.count}</span></div><div class="rx-users"></div>`;
    const list = sec.querySelector('.rx-users');
    for (const u of g.users || []) {
      const row = document.createElement('div');
      row.className = 'rx-user';
      const isMe = S.me && u.id === S.me.id;
      row.innerHTML = '<span class="avatar"></span><span class="rx-main"><span class="rx-name"></span><span class="rx-sub"></span></span>';
      paintAvatar(row.querySelector('.avatar'), u);
      const nm = row.querySelector('.rx-name');
      nm.innerHTML = esc(u.display_name || u.username || 'deleted user') + (isMe ? ' (you)' : '') + tagHTML(u);
      try { nm.style.cssText = nameStyleFor(u); } catch {}
      row.querySelector('.rx-sub').textContent = u.username ? '@' + u.username : '';
      list.appendChild(row);
    }
    if ((g.count || 0) > (g.users || []).length) {
      const more = document.createElement('div');
      more.className = 'rx-more muted small';
      more.textContent = `and ${g.count - g.users.length} more…`;
      list.appendChild(more);
    }
    box.appendChild(sec);
  }
}
async function jumpToMessage(id) {
  const sel = `#messages [data-mid="${CSS.escape(id)}"]`;
  const el = document.querySelector(sel);
  if (el) { flashMsgEl(el); return; }
  // Parent isn't in the loaded window: pull a context window around it (same
  // UX as pin jumps) so the quote always lands + highlights. This sets
  // histMode, so the jump-present pill offers a way back to the bottom.
  const land = () => requestAnimationFrame(() => {
    const target = document.querySelector(sel);
    if (target) flashMsgEl(target);
    updatePill();
  });
  // Replies land in the same thread, so try the current DM first.
  if (S.view === 'home' && S.dmThreadId) {
    try {
      const { messages } = await api(`/api/dms/${S.dmThreadId}/messages?limit=60&around=${encodeURIComponent(id)}`);
      S.dmMessages.set(S.dmThreadId, messages);
      S.histMode = { kind: 'dm', id: S.dmThreadId };
      S.histNew = 0;
      renderDmMessages();
      land();
      return;
    } catch {}
  }
  try {
    const { message } = await api('/api/messages/' + id);
    if (!message) throw new Error('no_message');
    if (message.serverId !== S.serverId) await selectServer(message.serverId);
    if (message.channelId !== S.channelId) await selectChannel(message.channelId, { keepNav: true });
    const ctx = pinsCtx();
    if (!ctx || ctx.kind !== 'server') throw new Error('no_message');
    const { messages: msgs } = await api(`/api/servers/${ctx.serverId}/channels/${ctx.id}/messages?limit=60&around=${encodeURIComponent(id)}`);
    S.messages.set(ctx.id, msgs);
    S.histMode = { ...ctx };
    S.histNew = 0;
    renderMessages();
    land();
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
  const clEl = e.target.closest('[data-clink]');
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
    // Thread the attachment filename through so the lightbox corner button
    // can download it (embed images have no attachment — no button then).
    const dl = imgEl.closest('.att-wrap')?.querySelector('.att-dl');
    openLightbox(imgEl.src, dl?.getAttribute('download') || ''); return;
  }
  if (clEl) {
    const ch = (S.serverDetail?.channels || []).find((c) => c.id === clEl.dataset.clink);
    if (ch && S.view === 'server') {
      if (clEl.dataset.ctype === 'voice') openVoiceChannel(S.serverId, ch.id);
      else if (S.channelId !== ch.id) selectChannel(ch.id);
    }
    return;
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
    else if (act === 'reply' && mid) replyToMsg(msgById(mid));
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
  // Server tags own their clicks (final.js opens the server mini-panel) — a
  // tag click must never re-open/re-anchor the user card underneath (e.g.
  // the tag inside an open user card), and plain clicks inside the open card
  // (whose own container carries data-uid) must not rebuild it either.
  if (e.target.closest && e.target.closest('.usertag[data-tag-sid]')) return;
  if (memberEl?.dataset.uid) { openMemberCard(memberEl.dataset.uid, memberEl); return; }
  if (uidEl?.dataset.uid && uidEl.id !== 'usercard') { openUserCard(uidEl.dataset.uid, e.clientX, e.clientY); return; }
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
    S.threadReplyTo = null; renderThreadComposerMeta();
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
  const anchor = nearBottom ? null : captureListAnchor(repBox);
  const keepDist = repBox.scrollHeight - repBox.scrollTop; // fallback (anchor scrolled away)
  repBox.innerHTML = '';
  let tprev = null;
  for (const r of S.thread.replies) { repBox.appendChild(messageEl(r, { inThread: true, grouped: shouldGroup(tprev, r) })); tprev = r; }
  if (!S.thread.replies.length) repBox.innerHTML = '<p class="muted small" style="text-align:center">No replies yet.</p>';
  if (scroll || nearBottom) anchorBottom(repBox);
  else if (typeof pinAnchorWhileSettling === 'function') pinAnchorWhileSettling(repBox, restoreListAnchor(repBox, anchor, keepDist));
  else restoreListAnchor(repBox, anchor, keepDist);
}
function closeThread(silent) {
  S.thread = null;
  S.threadReplyTo = null; renderThreadComposerMeta();
  const p = $('#thread-panel');
  if (p) p.classList.add('hidden');
}
// Active threads panel: threads you're part of with a message in the last
// 4 days (header Threads button). Rows jump straight into the thread.
function threadAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}
let threadsSearchT = null, threadsSearchSeq = 0;
async function openActiveThreads() {
  openModal('Active threads', '<input id="m-threads-search" placeholder="Search threads" autocomplete="off" /><div id="m-threads-list"><p class="muted" style="text-align:center;padding:1rem">Loading…</p></div>', 'Close', null, { wide: true });
  const input = $('#m-threads-search');
  if (!$('#m-threads-list')) return;
  await loadThreadsList('');
  if (input) input.addEventListener('input', () => {
    clearTimeout(threadsSearchT);
    threadsSearchT = setTimeout(() => loadThreadsList(input.value.trim()), 300);
  });
}
function threadsEmptyHTML(q) {
  return q
    ? `<p class="muted" style="text-align:center;padding:1rem">No threads match “${esc(q)}”.</p>`
    : '<p class="muted" style="text-align:center;padding:1rem">Nothing active — threads you start or reply to stay here for 4 days after the last message.</p>';
}
async function loadThreadsList(q) {
  const list = $('#m-threads-list');
  if (!list) return;
  const my = ++threadsSearchSeq;
  list.innerHTML = '<p class="muted" style="text-align:center;padding:1rem">Loading…</p>';
  let threads = [];
  try { ({ threads } = await api('/api/threads/active' + (q ? '?q=' + encodeURIComponent(q) : ''))); }
  catch { if (my === threadsSearchSeq && document.contains(list)) list.innerHTML = '<p class="error" style="text-align:center;padding:1rem">Could not load threads.</p>'; return; }
  if (my !== threadsSearchSeq || !document.contains(list)) return; // stale response
  if (!threads || !threads.length) { list.innerHTML = threadsEmptyHTML(q); return; }
  list.innerHTML = '';
  for (const t of threads) {
    const b = document.createElement('div');
    b.className = 'thread-item';
    b.tabIndex = 0;
    b.innerHTML = `<span class="t-main"><span class="t-ctx">${esc(t.serverName || '')} <span class="t-hash">#</span>${esc(t.channelName || '')} · ${esc(threadAgo(t.lastActivity))}</span><span class="t-root"><b>${esc((t.root && t.root.author) || '?')}</b> ${esc((t.root && t.root.snippet) || '')}</span><span class="t-meta"><span class="t-count">${t.replyCount} ${t.replyCount === 1 ? 'reply' : 'replies'}</span>${t.last ? `<span class="t-last">last by <b>${esc(t.last.author || '?')}</b> — ${esc(t.last.snippet || '')}</span>` : ''}</span></span><span class="t-avs"></span>`;
    const avBox = b.querySelector('.t-avs');
    for (const p of (t.participants || []).slice(0, 4)) {
      const s = document.createElement('span');
      s.className = 'avatar t-av';
      s.title = p.name || '?';
      try { paintAvatar(s, { display_name: p.name, avatar_color: p.color, avatar_url: p.avatar }); } catch {}
      avBox.appendChild(s);
    }
    b.insertAdjacentHTML('beforeend', '<button type="button" class="thread-x" title="Unfollow thread">×</button>');
    b.querySelector('.thread-x').onclick = async (e) => {
      e.stopPropagation();
      try { await api('/api/threads/' + encodeURIComponent(t.rootId) + '/unfollow', { method: 'POST' }); }
      catch { toast('Could not unfollow thread'); return; }
      b.remove();
      toast('Thread unfollowed — reply to rejoin it');
      const qv = $('#m-threads-search') ? $('#m-threads-search').value.trim() : '';
      if (list && !list.children.length) list.innerHTML = threadsEmptyHTML(qv);
    };
    const go = () => openActiveThread(t);
    b.onclick = go;
    b.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    list.appendChild(b);
  }
}
async function openActiveThread(t) {
  try { $('#modal-backdrop').classList.add('hidden'); } catch {}
  try {
    if (t.serverId !== S.serverId) await selectServer(t.serverId);
    if (t.channelId && t.channelId !== S.channelId) await selectChannel(t.channelId);
    openThread(t.rootId);
  } catch {}
}
$('#btn-threads').onclick = openActiveThreads;
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
  sendChat(content, { threadRoot: S.thread.rootId, replyTo: S.threadReplyTo?.id || null });
  S.threadReplyTo = null;
  renderThreadComposerMeta();
  composerAutoGrow(inp); // programmatic clear doesn't fire 'input', so reset height here
  // Mobile: keep the keyboard open for rapid follow-up replies.
  try { inp.focus({ preventScroll: true }); } catch { inp.focus(); }
});

// ---------- lightbox ----------
function openLightbox(src, name) {
  $('#lightbox-img').src = src;
  const dl = $('#lightbox-dl');
  if (dl) {
    if (src && name) { dl.href = src; dl.setAttribute('download', name); dl.classList.remove('hidden'); }
    else { dl.removeAttribute('href'); dl.classList.add('hidden'); }
  }
  $('#lightbox').classList.remove('hidden');
}
$('#lightbox-dl').addEventListener('click', (e) => {
  // Don't bubble to #lightbox (which would close it); the anchor still
  // downloads natively. Toast here — the document-level att-dl toast never
  // sees this click because of the stopPropagation below.
  e.stopPropagation();
  const dl = e.currentTarget;
  toast(`Downloading ${(dl.getAttribute('download') || 'image').slice(0, 60)}…`);
});
$('#lightbox').onclick = () => { $('#lightbox').classList.add('hidden'); $('#lightbox-img').src = ''; $('#lightbox-dl')?.classList.add('hidden'); };

// ---------- user card ----------
// Member-rail cards open to the LEFT of the sidebar, never over it.
function openMemberCard(uid, rowEl, y) {
  const p = $('#members')?.getBoundingClientRect();
  const r = rowEl?.getBoundingClientRect?.();
  const w = Math.min(300, innerWidth - 16);
  openUserCard(uid, (p && p.width ? p.left : (r ? r.left : innerWidth)) - w - 8, r ? r.top : y);
}
async function openUserCard(uid, x, y) {
  if (S.me && uid !== S.me.id) await ensureFriends();
  const u = memberById(uid);
  if (!u) return;
  const card = $('#usercard');
  const canMod = S.view === 'server' && S.serverDetail && canManage() && uid !== S.me.id && uid !== S.serverDetail.owner_id;
  // Voice: local volume for anyone in my current call, plus mod controls +
  // watch button when applicable.
  const inMyCall = !!(S.voice && S.me && uid !== S.me.id && occupantInMyRoom(uid));
  const myPeer = inMyCall ? (myRoomOccupants().find((p) => p.id === uid) || null) : null;
  let canVoiceMod = false;
  if (inMyCall) {
    if (S.voice.kind === 'server') canVoiceMod = S.view === 'server' && !!S.serverDetail && canManage() && uid !== S.serverDetail.owner_id;
    else {
      const t = (S.dms || []).find((x) => x.id === S.voice.threadId);
      canVoiceMod = !!(t && t.created_by && S.me && t.created_by === S.me.id);
    }
  }
  const volVal = getUserVolume(uid);
  const voiceVolHTML = inMyCall ? `
      <div class="uc-sec-label">Voice volume</div>
      <div class="uc-vol"><input type="range" id="uc-vol" min="0" max="100" step="1" value="${volVal}" aria-label="Voice volume" /><span id="uc-vol-pct">${volVal}%</span></div>` : '';
  const peerMuted = !!(myPeer && (myPeer.muted || myPeer.serverMuted));
  const voiceModHTML = (inMyCall && (canVoiceMod || (myPeer && myPeer.sharing))) ? `
      <div class="uc-sec-label">Voice call</div>
      <div class="uc-actions" style="margin-top:0">${myPeer && myPeer.sharing ? '<button class="btn small primary" id="uc-watch">Watch stream</button>' : ''}${canVoiceMod ? `<button class="btn small${peerMuted ? '' : ' danger'}" id="uc-vmute">${peerMuted ? 'Unmute' : 'Mute'}</button><button class="btn small danger" id="uc-vdrop">Disconnect</button>` : ''}</div>` : '';
  const st = statusOf(uid);
  const streaming = !isOff(st) && (u.streaming_game || null);
  const stLabel = streaming ? 'Streaming' : ({ online: 'Online', away: 'Away', dnd: 'Do not disturb', offline: 'Offline', invisible: 'Invisible' }[st] || 'Offline');
  const ban = u.banner_url || u.sidebar_banner_url;
  card.dataset.uid = uid;
  card.style.background = cardBgFor(u);
  card.innerHTML = `
    <div class="uc-banner"${ban ? ` style="background-image:url('${esc(ban)}')"` : ''}></div>
    <div class="uc-body">
      <span class="avatar big"></span>
      <div class="uc-name" style="${nameStyleFor(u)}">${esc(u.display_name)}${tagHTML(u)}</div>
      <div class="uc-sub">@${esc(u.username)}${u.role === 'owner' ? ' · server owner' : ''}</div>
      ${isSysAdmin(u) || isEarlyUser(u) ? `<div class="uc-badges">${isSysAdmin(u) ? '<span class="sysadmin-badge">System admin</span>' : ''}${isEarlyUser(u) ? '<span class="early-badge">Early user</span>' : ''}</div>` : ''}
      <div class="uc-status"><span class="status-dot ${dotOf(st, streaming)}"></span><span>${stLabel}</span></div>
      ${uid !== S.me.id && u.status_text ? `<div class="uc-statustext">${esc(u.status_text)}</div>` : ''}
      ${uid === S.me.id ? statusEditHTML() : ''}
      ${streaming ? `<div class="uc-statustext ustream"><span class="vlive">LIVE</span><span>Streaming ${esc(streaming)}</span></div>` : ''}
      ${u.playing_game ? `<div class="uc-statustext ugame">${gameBadgeHTML(u.playing_game)}<span>Playing ${esc(u.playing_game)}</span></div>` : ''}
      ${u.bio ? `<div class="uc-bio">${renderRich(u.bio)}</div>` : ''}
      ${u.created_at ? `<div class="uc-since">Member since ${new Date(u.created_at).toLocaleDateString()}</div>` : ''}
      <div id="uc-gaming" class="uc-gaming hidden"></div>
      ${voiceVolHTML}
      ${voiceModHTML}
      ${cardRolesHTML(uid)}
      <div class="uc-actions">${uid !== S.me.id ? '<button class="btn small" id="uc-mention">Mention</button>' : ''}${uid !== S.me.id && !isBlocked(uid) ? '<button class="btn small primary" id="uc-message">Message</button>' : ''}${uid !== S.me.id && !isBlocked(uid) ? friendBtnHTML(uid) : ''}${canMod ? '<button class="btn small danger" id="uc-kick">Kick</button><button class="btn small danger" id="uc-ban">Ban</button>' : ''}${uid !== S.me.id ? `<button class="btn small${isBlocked(uid) ? '' : ' danger'}" id="uc-block">${isBlocked(uid) ? 'Unblock' : 'Block'}</button>` : ''}<button class="btn small" id="uc-profile">Profile</button><button class="btn small" id="uc-close">Close</button></div>
    </div>`;
  paintAvatar(card.querySelector('.avatar'), u);
  paintGameBadge(card.querySelector('.gbadge'));
  const se = $('#uc-status-edit');
  if (se) se.onclick = () => openStatusEditor();
  const sc = $('#uc-status-clear');
  if (sc) sc.onclick = () => clearMyStatus();
  loadUserGaming($('#uc-gaming'), u.username, { compact: true });
  card.style.bottom = ''; card.style.maxHeight = ''; card.style.overflowY = '';
  card.classList.remove('hidden');
  const r = card.getBoundingClientRect();
  card.style.left = Math.max(8, Math.min(x || 8, innerWidth - Math.min(296, innerWidth - 16))) + 'px';
  card.style.top = Math.max(8, Math.min(y || 8, innerHeight - (r.height || 300) - 8)) + 'px';
  $('#uc-close').onclick = closeUserCard;
  const pr = $('#uc-profile');
  if (pr) pr.onclick = () => { closeUserCard(); openProfileScreen(uid); };
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
  const vvol = $('#uc-vol');
  if (vvol) vvol.oninput = () => {
    setUserVolume(uid, vvol.value);
    const pct = $('#uc-vol-pct');
    if (pct) pct.textContent = getUserVolume(uid) + '%';
  };
  const wch = $('#uc-watch');
  if (wch) wch.onclick = () => { closeUserCard(); watchStream(uid); };
  const vmu = $('#uc-vmute');
  if (vmu) vmu.onclick = async () => {
    sendVoiceMod(peerMuted ? 'unmute' : 'mute', uid);
    toast((peerMuted ? 'Unmuted @' : 'Muted @') + u.username);
    setTimeout(() => { try { if (!$('#usercard').classList.contains('hidden')) openUserCard(uid, x, y); } catch {} }, 800);
  };
  const vdr = $('#uc-vdrop');
  if (vdr) vdr.onclick = async () => {
    const ok = await openConfirmModal({
      title: `Disconnect @${u.username} from voice?`,
      message: 'They will be removed from the voice room but stay on the server.',
      okLabel: 'Disconnect',
    });
    if (!ok) return;
    sendVoiceMod('disconnect', uid);
    closeUserCard();
    toast('Disconnected @' + u.username);
  };
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
function closeUserCard() { $('#usercard').classList.add('hidden'); }
// ---------- server tag mini-panel ----------
function closeTagCard() { $('#tagcard').classList.add('hidden'); }
async function tagServerInfo(sid) {
  const local = (S.servers || []).find((s) => s && s.id === sid)
    || (S.serverDetail && S.serverDetail.id === sid ? S.serverDetail : null);
  if (local) return { id: local.id, name: local.name, description: local.description || '', icon_url: local.icon_url || null, banner_url: local.banner_url || null, tag: local.tag || null, tag_emoji: local.tag_emoji || null, member: true };
  const { server } = await api('/api/servers/' + sid + '/preview');
  return { ...server, member: false };
}
async function openTagCard(sid, x, y) {
  if (!sid) return;
  const card = $('#tagcard');
  card.innerHTML = '<div class="tc-banner"></div><div class="tc-body"><div class="tc-name muted">Loading…</div></div>';
  card.classList.remove('hidden');
  const place = () => {
    const r = card.getBoundingClientRect();
    card.style.left = Math.max(8, Math.min(x || 8, innerWidth - (r.width || 280) - 8)) + 'px';
    card.style.top = Math.max(8, Math.min(y || 8, innerHeight - (r.height || 200) - 8)) + 'px';
  };
  place();
  let info = null;
  try { info = await tagServerInfo(sid); } catch { info = null; }
  if (card.classList.contains('hidden')) return;
  if (!info) {
    card.innerHTML = '<div class="tc-error">Couldn\'t load this server.</div><div class="tc-actions" style="padding:0 1rem 1rem"><button class="btn small" id="tc-close">Close</button></div>';
  } else {
    const initial = (info.name || '?').trim().charAt(0).toUpperCase() || '?';
    card.innerHTML = `
      <div class="tc-banner"${info.banner_url ? ` style="background-image:url('${esc(info.banner_url)}')"` : ''}></div>
      <div class="tc-body">
        <span class="tc-icon">${info.icon_url ? `<img src="${esc(info.icon_url)}" alt="" />` : esc(initial)}</span>
        <div class="tc-name">${esc(info.name || 'Unknown server')}</div>
        ${(info.tag_emoji || info.tag) ? `<div class="tc-tagline"><span class="usertag">${esc((info.tag_emoji || '') + (info.tag || ''))}</span></div>` : ''}
        ${info.description ? `<div class="tc-desc">${esc(info.description)}</div>` : ''}
        <div class="tc-actions">${info.member ? '<button class="btn small primary" id="tc-view">View server</button>' : ''}<button class="btn small" id="tc-close">Close</button></div>
      </div>`;
    const vw = $('#tc-view');
    if (vw) vw.onclick = () => { closeTagCard(); selectServer(info.id); };
  }
  const cl = $('#tc-close');
  if (cl) cl.onclick = closeTagCard;
  place();
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
function fmtPlay(ms) {
  const h = ms / 3600000;
  if (h < 1) return Math.max(1, Math.round(ms / 60000)) + 'm';
  if (h < 48) { const m = Math.round((h % 1) * 60); return Math.floor(h) + 'h' + (m ? ' ' + m + 'm' : ''); }
  return Math.floor(h / 24) + 'd ' + Math.round(h % 24) + 'h';
}
// Relative "last played" with full units: minutes → hours → days → weeks → months → years.
function fmtLastPlayed(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
  const h = Math.floor(m / 60);
  if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
  const d = Math.floor(h / 24);
  if (d < 7) return d + (d === 1 ? ' day ago' : ' days ago');
  if (d < 30) { const w = Math.floor(d / 7); return w + (w === 1 ? ' week ago' : ' weeks ago'); }
  const mo = Math.floor(d / 30.44);
  if (mo < 12) return mo + (mo === 1 ? ' month ago' : ' months ago');
  const y = Math.floor(mo / 12);
  return y + (y === 1 ? ' year ago' : ' years ago');
}
function levelColor(lv) {
  if (lv >= 10) return '#ff4757';
  if (lv >= 7) return '#ff6348';
  if (lv >= 5) return '#ffa502';
  if (lv >= 3) return '#2ed573';
  return '#5b6cff';
}
async function loadUserGaming(box, username, opts = {}) {
  if (!box) return;
  box.classList.add('hidden');
  try {
    const g = await api('/api/users/' + encodeURIComponent(username) + '/gaming');
    if (!g || !g.total_ms) return;
    const { compact, canDelete } = opts;
    // Authoritative "now playing": the live playing_game, not recency of
    // last_seen_ms (which stays fresh for minutes after quitting and made
    // the card keep saying "Playing X" after the game closed).
    const live = g.now_playing || (typeof memberByUsername === 'function' ? (memberByUsername(username) || {}).playing_game : null) || null;
    const hit = live ? (g.games || []).find((x) => x.game === live) : null;
    const nowPlaying = hit || (live ? { game: live } : null);
    if (compact) {
      const rows = (g.games || []).slice(0, 4).map((x) => `
        <div class="uc-gaming-row">
          <span class="uc-gaming-name">${esc(x.game)}</span>
          <span class="uc-gaming-meta">Lv ${x.level} · ${fmtPlay(x.total_ms)}</span>
        </div>
      `).join('');
      box.innerHTML = `
        <div class="uc-gaming-head">Gaming · Lv ${g.level} · ${fmtPlay(g.total_ms)}</div>
        ${nowPlaying ? `<div class="uc-gaming-now">Playing <b>${esc(nowPlaying.game)}</b></div>` : ''}
        ${rows}`;
    } else {
      const cards = (g.games || []).map((x) => {
        const col = levelColor(x.level);
        const isLive = live && x.game === live;
        const streakLine = x.streak
          ? `<span class="pf-badge streak">${x.streak}-day streak</span>${x.best_streak > x.streak ? `<span class="pf-game-best">Best ${x.best_streak} day${x.best_streak === 1 ? '' : 's'}</span>` : ''}`
          : (x.best_streak ? `<span class="pf-game-best">Best streak ${x.best_streak} day${x.best_streak === 1 ? '' : 's'}</span>` : '');
        return `
          <div class="pf-game-card" data-game="${esc(x.game)}">
            <div class="pf-game-icon" style="background:${col}">${x.icon_url ? `<img src="${esc(x.icon_url)}" alt="" loading="lazy" onerror="this.remove()" />` : esc(x.game.charAt(0).toUpperCase())}</div>
            <div class="pf-game-info">
              <div class="pf-game-top">
                <div class="pf-game-name">${esc(x.game)}</div>
                <span class="pf-badge lv" style="background:${col}22;color:${col}">Lv ${x.level}</span>
              </div>
              <div class="pf-game-time">${fmtPlay(x.total_ms)} <span>total</span></div>
              ${isLive
                ? '<div class="pf-game-sub"><span class="live-dot"></span><span class="pf-game-live">Playing now</span></div>'
                : (x.last_seen_ms ? `<div class="pf-game-sub">Last played ${fmtLastPlayed(x.last_seen_ms)}</div>` : '')}
              ${streakLine ? `<div class="pf-game-streak">${streakLine}</div>` : ''}
            </div>
          </div>
        `;
      }).join('');
      box.innerHTML = `
        <div class="pf-gaming-head">
          <span class="pf-gaming-title">Gaming</span>
          <span class="pf-gaming-total">Lv ${g.level} · ${fmtPlay(g.total_ms)}${g.streak ? ' · ' + g.streak + 'd streak' : ''}${g.best_streak ? ' · best ' + g.best_streak + 'd' : ''}</span>
        </div>
        ${nowPlaying ? `<div class="pf-gaming-now">Currently playing <b>${esc(nowPlaying.game)}</b></div>` : ''}
        <div class="pf-gaming-grid">${cards}</div>
      `;
      if (canDelete) {
        const doRemoveGame = async (game) => {
          const ok = await openConfirmModal({
            title: 'Remove ' + game + '?',
            message: 'All playtime, levels and streaks for this game will be permanently deleted.',
            okLabel: 'Remove',
            danger: true,
          });
          if (!ok) return;
          try {
            await api('/api/me/games/' + encodeURIComponent(game), { method: 'DELETE' });
            toast(game + ' removed from profile');
            loadUserGaming(box, username, opts);
          } catch (err) { toast('Failed: ' + prettyError(err.message)); }
        };
        box.querySelectorAll('.pf-game-card').forEach((card) => {
          const game = card.dataset.game;
          const menuItems = () => [{ label: 'Remove game', icon: '🗑', danger: true, fn: () => doRemoveGame(game) }];
          // Desktop: right-click menu (on touch devices the long-press sheet below owns this;
          // the browser's synthetic contextmenu must not also pop the floating menu)
          card.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (isCoarse()) return;
            openCtx(e.clientX, e.clientY, menuItems());
          };
          // Touch: long-press opens the bottom sheet
          let lt = null, sx = 0, sy = 0;
          const cancelHold = () => { if (lt) { clearTimeout(lt); lt = null; } };
          card.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            sx = e.touches[0].clientX; sy = e.touches[0].clientY;
            cancelHold();
            lt = setTimeout(() => {
              lt = null;
              try { navigator.vibrate && navigator.vibrate(10); } catch {}
              if (isCoarse()) openCtxSheet(menuItems(), { title: game, sub: meta });
              else openCtx(sx, sy, menuItems());
            }, 550);
          }, { passive: true });
          card.addEventListener('touchmove', (e) => {
            const t = e.touches && e.touches[0];
            if (t && Math.hypot(t.clientX - sx, t.clientY - sy) > 12) cancelHold();
          }, { passive: true });
          ['touchend', 'touchcancel'].forEach((ev) => card.addEventListener(ev, cancelHold, { passive: true }));
        });
      }
    }
    box.classList.remove('hidden');
    // The card was positioned before this async section filled in — pull
    // top-anchored cards back on screen if the growth pushed them off.
    // (Bottom-anchored cards grow upward and are left alone.)
    try { if (box && box.closest && box.closest('#usercard')) clampUserCard(); } catch {}
  } catch {}
}
// Re-clamp a top-anchored user card into the viewport (no-op while hidden
// or bottom-anchored).
function clampUserCard() {
  const card = $('#usercard');
  if (!card || card.classList.contains('hidden')) return;
  if (card.style.bottom && card.style.bottom !== 'auto') return; // grows upward, always safe
  const r = card.getBoundingClientRect();
  let left = parseFloat(card.style.left);
  let top = parseFloat(card.style.top);
  if (!Number.isFinite(left)) left = 8;
  if (!Number.isFinite(top)) top = 8;
  card.style.left = Math.max(8, Math.min(left, innerWidth - Math.min(296, innerWidth - 16))) + 'px';
  card.style.top = Math.max(8, Math.min(top, innerHeight - (r.height || 300) - 8)) + 'px';
}
// ---------- custom status quick-edit (own user card) ----------
function fmtCountdown(ts) {
  const d = ts - Date.now();
  if (d <= 0) return 'soon';
  const m = Math.floor(d / 60000);
  if (m < 1) return 'in under a minute';
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.floor(h / 24)}d`;
}
function statusEditHTML() {
  const cur = S.me.status_text || '';
  const exp = +S.me.status_expires_at || 0;
  const expNote = cur && exp ? `<div class="uc-status-exp">Expires ${fmtCountdown(exp)}</div>` : '';
  return `<div class="uc-statusbox" id="uc-statusbox"><div class="uc-sec-label">Custom status</div>
    <div class="uc-status-cur">${cur ? esc(cur) : '<span class="muted">Not set</span>'}</div>${expNote}
    <div class="row"><button class="btn small" id="uc-status-edit">${cur ? 'Edit' : 'Set status'}</button>${cur ? '<button class="btn small danger" id="uc-status-clear">Clear</button>' : ''}</div></div>`;
}
function refreshOwnStatusBox() {
  // Update the status section in place so the open card never moves,
  // rescales, or loses its scroll position.
  const card = $('#usercard');
  if (!card || card.classList.contains('hidden') || card.dataset.uid !== S.me.id) return;
  const box = $('#uc-statusbox');
  if (!box) return;
  box.outerHTML = statusEditHTML();
  const se = $('#uc-status-edit');
  if (se) se.onclick = () => openStatusEditor();
  const sc = $('#uc-status-clear');
  if (sc) sc.onclick = () => clearMyStatus();
}
async function clearMyStatus() {
  try {
    const { user } = await api('/api/me', { method: 'PATCH', body: JSON.stringify({ statusText: '' }) });
    if (user) { S.me = { ...S.me, ...user }; paintMe(); }
    toast('Status cleared');
    refreshOwnStatusBox();
  } catch (err) { toast(prettyError(err.message)); }
}
function openStatusEditor() {
  const cur = S.me.status_text || '';
  const curExp = +S.me.status_expires_at || 0;
  const t0 = Date.now();
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  const presets = [
    { label: 'Never', ts: null },
    { label: '30 min', ts: t0 + 30 * 60e3 },
    { label: '1 hour', ts: t0 + 3600e3 },
    { label: '4 hours', ts: t0 + 4 * 3600e3 },
    { label: 'Tomorrow', ts: midnight.getTime() },
    { label: '1 week', ts: t0 + 7 * 864e5 },
  ];
  let sel = 0;
  if (curExp) {
    let best = -1, bd = Infinity;
    presets.forEach((p, i) => { if (p.ts) { const d = Math.abs(p.ts - curExp); if (d < bd) { bd = d; best = i; } } });
    if (best > 0 && bd < 5 * 60e3) sel = best;
  }
  openModal('Custom status', `
    <label>Status<input id="m-status-text" maxlength="64" placeholder="What's up?" value="${esc(cur)}" /></label>
    <div class="uc-sec-label">Clear after</div>
    <div class="exp-row" id="m-status-exp">${presets.map((p, i) => `<button type="button" class="mini${i === sel ? ' on' : ''}" data-exp="${i}">${p.label}</button>`).join('')}</div>
  `, 'Save', async () => {
    const text = ((($('#m-status-text') || {}).value) || '').trim().slice(0, 64);
    const ts = presets[sel].ts;
    try {
      const { user } = await api('/api/me', { method: 'PATCH', body: JSON.stringify({ statusText: text, statusExpiresAt: text ? ts : null }) });
      if (user) { S.me = { ...S.me, ...user }; paintMe(); }
      toast(text ? 'Status updated' : 'Status cleared');
      refreshOwnStatusBox();
    } catch (err) { toast(prettyError(err.message)); }
  });
  document.querySelectorAll('#m-status-exp [data-exp]').forEach((b) => (b.onclick = () => {
    sel = +b.dataset.exp;
    document.querySelectorAll('#m-status-exp [data-exp]').forEach((x) => x.classList.toggle('on', +x.dataset.exp === sel));
  }));
}
// ---------- profile screen (full overlay) ----------
function openProfileScreen(uid) {
  const u = memberById(uid);
  if (!u) return;
  const bd = $('#profile-backdrop');
  const isMe = uid === S.me.id;
  const st = statusOf(uid);
  const pstreaming = !isOff(st) && (u.streaming_game || null);
  const stLabel = pstreaming ? 'Streaming' : ({ online: 'Online', away: 'Away', dnd: 'Do not disturb', offline: 'Offline', invisible: 'Invisible' }[st] || 'Offline');
  $('#pf-banner').style.backgroundImage = u.banner_url ? `url('${esc(u.banner_url)}')` : '';
  paintAvatar($('#pf-avatar'), u);
  $('#pf-name').style.cssText = nameStyleFor(u);
  $('#pf-name').innerHTML = esc(u.display_name) + tagHTML(u);
  $('#pf-sub').textContent = '@' + u.username + (u.role === 'owner' ? ' · server owner' : '');
  const body = $('#pf-body');
  let actions = '';
  if (!isMe) {
    if (!isBlocked(uid)) actions += '<button class="btn small primary" id="pf-message">Message</button>' + friendBtnHTML(uid, 'pf-friend');
    actions += `<button class="btn small${isBlocked(uid) ? '' : ' danger'}" id="pf-block">${isBlocked(uid) ? 'Unblock' : 'Block'}</button>`;
  }
  body.innerHTML = `
    ${isSysAdmin(u) || isEarlyUser(u) ? `<div class="pf-badges">${isSysAdmin(u) ? '<span class="sysadmin-badge">System admin</span>' : ''}${isEarlyUser(u) ? '<span class="early-badge">Early user</span>' : ''}</div>` : ''}
    <div class="pf-status"><span class="status-dot ${dotOf(st, pstreaming)}"></span><span>${stLabel}</span>${u.status_text ? `<span class="pf-statustext">${esc(u.status_text)}</span>` : ''}</div>
    ${pstreaming ? `<div class="pf-playing ustream">Streaming ${esc(pstreaming)}</div>` : ''}
    ${u.playing_game ? `<div class="pf-playing">Playing ${esc(u.playing_game)}</div>` : ''}
    ${u.bio ? `<div class="pf-bio">${renderRich(u.bio)}</div>` : ''}
    ${u.created_at ? `<div class="pf-since">Member since ${new Date(u.created_at).toLocaleDateString()}</div>` : ''}
    <div id="pf-gaming" class="pf-gaming hidden"></div>
    <div class="pf-actions">${actions}<button class="btn small" id="pf-close">Close</button></div>`;
  loadUserGaming($('#pf-gaming'), u.username, { canDelete: isMe });
  $('#pf-close').onclick = closeProfileScreen;
  const msg = $('#pf-message');
  if (msg) msg.onclick = () => { closeProfileScreen(); messageUser(uid); };
  const fr = $('#pf-friend');
  if (fr) fr.onclick = () => { closeProfileScreen(); friendCardAction(uid); };
  const blk = $('#pf-block');
  if (blk) blk.onclick = () => {
    const was = isBlocked(uid), nm = u.username;
    closeProfileScreen();
    if (was) unblockUser(uid); else blockUser(uid, nm);
  };
  bd.classList.remove('hidden');
}
function closeProfileScreen() { $('#profile-backdrop').classList.add('hidden'); }
$('#profile-close').onclick = closeProfileScreen;
$('#profile-backdrop').addEventListener('click', (e) => { if (e.target.id === 'profile-backdrop') closeProfileScreen(); });

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
    b.innerHTML = `<span class="avatar"></span><span>${esc(c.display_name)}${tagHTML(c)} <span class="muted">@${esc(c.username)}</span></span>`;
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

// ---------- #channel autocomplete (same UX as @mentions) ----------
// Typing #gen in a server offers matching channels; picking inserts #name,
// which renders as a clickable link (see renderRich in core.js).
let chanIdx = 0;
function hideChanPop() { $('#chan-pop').classList.add('hidden'); }
$('#in-message').addEventListener('input', () => {
  const inp = $('#in-message');
  const upto = inp.value.slice(0, inp.selectionStart ?? inp.value.length);
  const m = upto.match(/#([A-Za-z0-9_-]{0,32})$/);
  const pool = S.view === 'server' ? (S.serverDetail?.channels || []) : [];
  if (!m || !pool.length) { hideChanPop(); return; }
  const q = m[1].toLowerCase();
  const cands = pool.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 6);
  if (!cands.length) { hideChanPop(); return; }
  chanIdx = 0;
  const pop = $('#chan-pop');
  pop.innerHTML = '';
  cands.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mention-item' + (i === 0 ? ' sel' : '');
    b.dataset.name = c.name;
    b.innerHTML = `<span class="chan-glyph">${c.type === 'voice' ? '♪' : '#'}</span><span>#${esc(c.name)}</span>`;
    b.onmousedown = (e) => { e.preventDefault(); applyChannel(c.name); };
    pop.appendChild(b);
  });
  pop.classList.remove('hidden');
});
$('#in-message').addEventListener('keydown', (e) => {
  const pop = $('#chan-pop');
  if (pop.classList.contains('hidden')) return;
  const items = [...pop.querySelectorAll('.mention-item')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    chanIdx = (chanIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((b, i) => b.classList.toggle('sel', i === chanIdx));
  } else if ((e.key === 'Enter' || e.key === 'Tab') && items[chanIdx]) {
    e.preventDefault();
    applyChannel(items[chanIdx].dataset.name);
  } else if (e.key === 'Escape') hideChanPop();
});
function applyChannel(name) {
  const inp = $('#in-message');
  const pos = inp.selectionStart ?? inp.value.length;
  inp.value = inp.value.slice(0, pos).replace(/#[A-Za-z0-9_-]{0,32}$/, '#' + name + ' ');
  hideChanPop();
  inp.focus();
  syncComposerRender();
}

// ---------- :emoji autocomplete (same UX as @mentions) ----------
// Typing a trailing :name shows matching emoji (custom + standard) to pick
// from with arrow keys / Enter / click; it completes the :name: code.
let emojiIdx = 0;
function hideEmojiPop() { $('#emoji-pop').classList.add('hidden'); }
function emojiCandidates(q) {
  const out = [];
  // custom emoji from every joined server (label shows which server)
  for (const [n, em] of Object.entries(S.emojiAll)) {
    if (!q || n.toLowerCase().includes(q)) {
      out.push({ kind: 'custom', name: n, url: em.url, srv: (S.serverEmojis.find((s) => s.id === em.serverId) || {}).name || '' });
    }
  }
  if (emojiData && emojiData.shortcodes) {
    for (const [n, ch] of Object.entries(emojiData.shortcodes)) {
      if (!q || n.toLowerCase().includes(q)) out.push({ kind: 'std', name: n, ch });
    }
  }
  return out.slice(0, 8);
}
$('#in-message').addEventListener('input', () => {
  const inp = $('#in-message');
  const upto = inp.value.slice(0, inp.selectionStart ?? inp.value.length);
  const m = upto.match(/:([a-z0-9_+-]{1,32})$/);
  if (!m) { hideEmojiPop(); return; }
  const q = m[1].toLowerCase();
  const cands = emojiCandidates(q);
  if (!cands.length) { hideEmojiPop(); return; }
  emojiIdx = 0;
  const pop = $('#emoji-pop');
  pop.innerHTML = '';
  cands.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'emoji-item' + (i === 0 ? ' sel' : '');
    b.dataset.name = c.name;
    b.innerHTML = c.kind === 'custom'
      ? `<img class="ep-img" src="${esc(c.url)}" alt="" data-fb-emoji=":${esc(c.name)}:" /><span class="ep-name">:${esc(c.name)}:</span>${c.srv ? `<span class="ep-srv">${esc(c.srv)}</span>` : ''}`
      : `<span class="ep-char">${esc(c.ch)}</span><span class="ep-name">:${esc(c.name)}:</span>`;
    b.onmousedown = (e) => { e.preventDefault(); applyEmoji(c.name); };
    pop.appendChild(b);
  });
  pop.classList.remove('hidden');
});
$('#in-message').addEventListener('keydown', (e) => {
  const pop = $('#emoji-pop');
  if (pop.classList.contains('hidden')) return;
  const items = [...pop.querySelectorAll('.emoji-item')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    emojiIdx = (emojiIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((b, i) => b.classList.toggle('sel', i === emojiIdx));
  } else if ((e.key === 'Enter' || e.key === 'Tab') && items[emojiIdx]) {
    e.preventDefault();
    applyEmoji(items[emojiIdx].dataset.name);
  } else if (e.key === 'Escape') hideEmojiPop();
});
function applyEmoji(name) {
  const inp = $('#in-message');
  const pos = inp.selectionStart ?? inp.value.length;
  inp.value = inp.value.slice(0, pos).replace(/:[a-z0-9_+-]{1,32}$/, ':' + name + ': ');
  hideEmojiPop();
  inp.focus();
  syncComposerRender();
}

