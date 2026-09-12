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
  if (anchor && !phoneLayout()) {
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
  haptic(10); // picking an option ticks; merely opening the picker does not
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
  // Programmatic insert (emoji / mention pickers) fires no 'input' event, so
  // the composer draft has to be told about it explicitly.
  try { draftSoon(input, draftCtxForEl(input)); } catch {}
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
  const att = { url, name: (g.title || 'gif').slice(0, 80) + '.gif', mime: 'image/gif', size: 0, kind: 'image' };
  // A pending reply (main composer chip or in-thread chip) rides along —
  // otherwise the GIF lands as a standalone message.
  if (S.view === 'home') {
    if (!S.dmThreadId || !url) return;
    sendDm('', { attachments: [att], replyTo: S.replyTo?.id || null });
    S.replyTo = null;
    renderComposerMeta();
    return;
  }
  if (!S.serverId || !S.channelId || !url) return;
  if (S.threadReplyTo && S.thread) {
    sendChat('', { attachments: [att], threadRoot: S.thread.rootId, replyTo: S.threadReplyTo.id });
    S.threadReplyTo = null;
    renderThreadComposerMeta();
    return;
  }
  sendChat('', { attachments: [att], replyTo: S.replyTo?.id || null });
  S.replyTo = null;
  renderComposerMeta();
}

// ---------- reactions / reply / edit / thread actions ----------
async function toggleReaction(mid, emoji) {
  haptic(10); // reacting is one of the few taps that still ticks
  const dm = msgById(mid)?._dm;
  const base = dm ? '/api/dms/messages/' : '/api/messages/';
  try {
    const { reactions } = await api(base + mid + '/reactions', { method: 'POST', body: JSON.stringify({ emoji }) });
    bumpFreq(emoji);
    updateMsgInCaches(mid, (m) => { m.reactions = reactions.map((r) => ({ emoji: r.emoji, count: r.count, me: r.me, users: r.users || [] })); });
    reactionDetailCache.delete(mid); // counts changed — refetch on next view
    // Patch the one reaction bar in place; a full rebuild would jump the
    // scroll (and flash every avatar) for a change that touches one element.
    if (S.view === 'home') { if (S.dmThreadId && !patchMessageReactions(mid, $('#messages'))) renderDmMessages(); }
    else if (S.channelId && !patchMessageReactions(mid, $('#messages'))) renderMessages();
    if (S.thread && (S.thread.rootId === mid || S.thread.replies.some((r) => r.id === mid))) {
      if (!patchMessageReactions(mid, $('#thread-replies'))) renderThread();
    }
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
      nm.innerHTML = `<span class="mname-row"><span class="mname" style="${nameStyleFor(u)}">${esc(u.display_name || u.username || 'deleted user')}</span>${isMe ? ' (you)' : ''}${tagHTML(u)}</span>`;
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
  const land = () => {
    const target = document.querySelector(sel);
    if (target) flashMsgEl(target);
    updatePill();
  };
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
  S.editRemovals = new Set(); // attachment ids to drop on save
  if (S.channelId) renderMessages();
  if (S.view === 'home' && S.dmThreadId) renderDmMessages();
  if (S.thread) renderThread();
  setTimeout(() => { const t = $('#edit-area'); if (t) { t.focus(); t.selectionStart = t.value.length; } }, 0);
}
// Abandon an in-progress edit (Cancel button, Escape). `focus` hands the caret
// back to the composer — used for Escape, where the keyboard is already up and
// the reader expects to keep typing; the button leaves focus alone.
function cancelEdit(opts = {}) {
  if (!S.editing) return;
  S.editing = null;
  S.editRemovals = new Set();
  if (S.channelId) renderMessages();
  if (S.view === 'home' && S.dmThreadId) renderDmMessages();
  if (S.thread) renderThread();
  if (opts.focus) { try { $('#in-message')?.focus(); } catch {} }
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !S.editing) return;
  const t = e.target;
  const inBox = !!(t && t.id === 'edit-area');
  // Escape inside some other field (a modal's input, the composer) belongs to
  // that field — only the edit box, or the page at large, cancels the edit.
  if (!inBox && t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
  cancelEdit({ focus: true });
});
// Up arrow in an empty composer edits your last message in this conversation
// (Discord's shortcut). Nothing else may own the key when it fires: an open
// autocomplete popup, an in-flight attach, or an edit already in progress.
// With text present, Up keeps its normal job of moving the caret.
$('#in-message').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
  if (e.defaultPrevented) return; // a popup already handled it
  const inp = e.target;
  if (!inp || inp.value.trim()) return;
  if ((S.pendingAtts || []).length) return;
  if (S.editing) return;
  for (const sel of ['#mention-pop', '#emoji-pop', '#chan-pop']) {
    const pop = $(sel);
    if (pop && !pop.classList.contains('hidden')) return;
  }
  const list = S.view === 'home'
    ? (S.dmMessages.get(S.dmThreadId) || [])
    : (S.messages.get(S.channelId) || []);
  let last = null;
  for (const m of list) {
    if (m.sys || m.webhook) continue;
    if (m.user && S.me && m.user.id === S.me.id) last = m; // keep scanning: we want the newest
  }
  if (!last) return;
  e.preventDefault();
  startEdit(last.id);
  // The message can be above the viewport when the reader is up in history,
  // and an edit box they can't see is worse than no shortcut at all.
  setTimeout(() => {
    try {
      const el = document.querySelector('#messages [data-mid="' + CSS.escape(last.id) + '"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    } catch {}
  }, 0);
});
async function saveEdit(mid) {
  const t = $('#edit-area');
  const content = (t?.value || '').trim();
  if (!content) return;
  const remove = [...(S.editRemovals || [])];
  S.editing = null;
  S.editRemovals = new Set();
  const base = msgById(mid)?._dm ? '/api/dms/messages/' : '/api/messages/';
  try { await api(base + mid, { method: 'PATCH', body: JSON.stringify({ content, removeAttachments: remove }) }); }
  catch (err) { toast('Edit failed: ' + prettyError(err.message)); if (S.channelId) renderMessages(); }
}
// Edit box: Enter saves the edit, Shift+Enter inserts a line break — same
// contract as the composer. Without this, Enter only added a newline and the
// edit could only be committed with the Save button. Works for channel, DM
// and thread replies (the box is (re)created by messageEl in each of them).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  const t = e.target;
  if (!t || t.id !== 'edit-area') return;
  const owner = t.closest && t.closest('.msg[data-mid]');
  const mid = owner ? owner.dataset.mid : null;
  if (!mid) return; // stray box (no message to save): leave the default alone
  e.preventDefault();
  saveEdit(mid);
});
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
    else if (act === 'edit-unattach' && mid) {
      const aid = actEl.dataset.aid;
      if (aid) {
        S.editRemovals = S.editRemovals || new Set();
        S.editRemovals.add(aid);
        // Drop just the chip — a full re-render would lose the textarea text.
        const chip = actEl.closest('.edit-att');
        const wrap = actEl.closest('.edit-atts');
        if (chip) chip.remove();
        if (wrap && !wrap.querySelector('.edit-att')) wrap.remove();
      }
    }
    else if (act === 'edit-save' && mid) saveEdit(mid);
    else if (act === 'edit-cancel') cancelEdit();
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
  // data-ownclick rows (friends list, voice occupants) already handled the click
  // themselves — opening the card here too would put it on top of the DM (or
  // re-anchor it) the moment they clicked.
  if (uidEl?.dataset.uid && uidEl.id !== 'usercard' && !uidEl.dataset.ownclick) { openUserCard(uidEl.dataset.uid, e.clientX, e.clientY); return; }
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
async function openThread(rootId, opts = {}) {
  flushDrafts();
  try {
    const { root, replies } = await api(`/api/servers/${S.serverId}/channels/${S.channelId}/threads/${rootId}`);
    S.thread = { rootId, channelId: S.channelId, root, replies };
    S.threadReplyTo = null; renderThreadComposerMeta();
    $('#thread-sub').textContent = '#' + chanName(S.channelId);
    $('#thread-panel').classList.remove('hidden');
    rememberView(); // a reload lands you back in the thread you had open
    renderThread(true);
    applyComposerDraft(); // the reply you were typing in this thread, if any
  } catch { if (!opts.silent) toast('Could not open thread'); }
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
  flushDrafts();
  S.thread = null;
  S.threadReplyTo = null; renderThreadComposerMeta();
  const p = $('#thread-panel');
  if (p) p.classList.add('hidden');
  if (!silent) rememberView();
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
  if (phoneLayout()) return;
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
  const ctx = draftThreadCtx();
  // Enter on a newline-only reply box: nothing to send, so clear the stray
  // line breaks and re-fit — the same shape as the main composer's empty
  // submit. Otherwise the tall box (and its phantom draft) just sits there.
  if (!content) {
    inp.value = '';
    draftClear(ctx);
    composerAutoGrow(inp);
    return;
  }
  inp.value = '';
  draftClear(ctx); // sent: the reply draft goes with it
  sendChat(content, { threadRoot: S.thread.rootId, replyTo: S.threadReplyTo?.id || null });
  S.threadReplyTo = null;
  renderThreadComposerMeta();
  composerAutoGrow(inp); // programmatic clear doesn't fire 'input', so reset height here
  // Mobile: keep the keyboard open for rapid follow-up replies.
  try { inp.focus({ preventScroll: true }); } catch { inp.focus(); }
});

// ---------- lightbox ----------
// Full-screen photo viewer. The Download / Close controls sit in #lb-bar, a
// fixed safe-area bar, so a tall photo can never carry them off the top of the
// screen. One pointer pans a zoomed photo, two pinch it, double-tap toggles
// zoom, and dragging an unzoomed photo down dismisses the viewer (the whole
// overlay follows the finger, exactly like the story viewer).
const LB_MIN = 1, LB_MAX = 6;
const lb = { open: false, scale: 1, tx: 0, ty: 0, gen: 0, ptrs: new Map(), pinch: null, pan: null, swipe: null, lastTap: 0, tapX: 0, tapY: 0 };
function lbStage() { return $('#lb-stage'); }
function lbImg() { return $('#lightbox-img'); }
// Keep a zoomed photo from being dragged off its own edges (and re-centre it
// when it is smaller than the stage). Uses layout sizes, not the transformed
// rect, so it stays correct while the finger is moving.
function lbClampPan() {
  const img = lbImg(), stage = lbStage();
  if (!img || !stage) return;
  const cs = getComputedStyle(stage);
  const availW = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const maxX = Math.max(0, (img.offsetWidth * lb.scale - availW) / 2);
  const maxY = Math.max(0, (img.offsetHeight * lb.scale - availH) / 2);
  lb.tx = Math.min(maxX, Math.max(-maxX, lb.tx));
  lb.ty = Math.min(maxY, Math.max(-maxY, lb.ty));
}
function lbApply(animate) {
  const img = lbImg();
  if (!img) return;
  img.style.transition = animate ? 'transform .16s ease-out' : '';
  img.style.transform = `translate(${lb.tx.toFixed(1)}px, ${lb.ty.toFixed(1)}px) scale(${lb.scale.toFixed(4)})`;
  $('#lightbox').classList.toggle('zoomed', lb.scale > 1.001);
}
function lbReset() {
  lb.scale = 1; lb.tx = 0; lb.ty = 0;
  lb.ptrs.clear(); lb.pinch = null; lb.pan = null; lb.swipe = null;
  const img = lbImg();
  if (img) { img.style.transition = ''; img.style.transform = ''; }
  const root = $('#lightbox');
  if (root) { root.classList.remove('zoomed', 'dragging'); root.style.transform = ''; root.style.opacity = ''; root.style.transition = ''; }
}
function closeLightbox() {
  const root = $('#lightbox');
  if (!root || !lb.open) return;
  lb.gen++;
  lb.open = false;
  root.classList.add('hidden');
  const img = lbImg();
  if (img) img.src = '';
  $('#lightbox-dl')?.classList.add('hidden');
  lbReset();
}
function openLightbox(src, name) {
  const root = $('#lightbox');
  const img = lbImg();
  if (!root || !img) return;
  lb.gen++;
  lbReset();
  img.src = src;
  const dl = $('#lightbox-dl');
  if (dl) {
    if (src && name) { dl.href = src; dl.setAttribute('download', name); dl.classList.remove('hidden'); }
    else { dl.removeAttribute('href'); dl.classList.add('hidden'); }
  }
  lb.open = true;
  root.classList.remove('hidden');
}
// Zoom about a point given in stage-centre coordinates (the same convention as
// the story composer's pinch): the content under the point stays under it.
function lbZoomAt(scale, mx, my) {
  const next = Math.min(LB_MAX, Math.max(LB_MIN, scale));
  const k = next / lb.scale;
  lb.tx = mx - (mx - lb.tx) * k;
  lb.ty = my - (my - lb.ty) * k;
  lb.scale = next;
  lbClampPan();
  lbApply(false);
}
function lbToggleZoom(cx, cy) {
  const stage = lbStage();
  if (!stage) return;
  if (lb.scale > 1.001) { lb.scale = 1; lb.tx = 0; lb.ty = 0; lbApply(true); return; }
  const r = stage.getBoundingClientRect();
  const mx = cx - (r.left + r.width / 2), my = cy - (r.top + r.height / 2);
  lb.scale = 1; lb.tx = 0; lb.ty = 0;
  lbZoomAt(2.4, mx, my);
  lbApply(true);
}
function lbSlideOut() {
  const root = $('#lightbox');
  const g = lb.gen;
  root.classList.remove('dragging');
  root.style.transition = 'transform .2s ease-in, opacity .2s ease-in';
  root.style.transform = 'translateY(100%)';
  root.style.opacity = '0';
  setTimeout(() => { if (lb.gen === g) closeLightbox(); }, 210);
}
$('#lightbox')?.addEventListener('pointerdown', (e) => {
  if (!lb.open) return;
  if (e.target.closest('#lb-bar')) return; // the buttons own their own clicks
  lb.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (lb.ptrs.size === 2) {
    const [a, b] = [...lb.ptrs.values()];
    const r = lbStage().getBoundingClientRect();
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    lb.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: lb.scale, tx: lb.tx, ty: lb.ty, mx: c.x - (r.left + r.width / 2), my: c.y - (r.top + r.height / 2) };
    lb.pan = null; lb.swipe = null;
  } else if (lb.ptrs.size === 1) {
    if (lb.scale > 1.001) lb.pan = { x: e.clientX, y: e.clientY, tx: lb.tx, ty: lb.ty, moved: false };
    else lb.swipe = { x: e.clientX, y: e.clientY, t0: Date.now(), dy: 0, moved: false };
  }
});
$('#lightbox')?.addEventListener('pointermove', (e) => {
  if (!lb.open || !lb.ptrs.has(e.pointerId)) return;
  lb.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const r = lbStage().getBoundingClientRect();
  if (lb.pinch && lb.ptrs.size >= 2) {
    e.preventDefault();
    const [a, b] = [...lb.ptrs.values()];
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const z = Math.min(LB_MAX, Math.max(LB_MIN, lb.pinch.scale * (d / lb.pinch.d)));
    const k = z / lb.pinch.scale;
    lb.scale = z;
    lb.tx = (c.x - (r.left + r.width / 2)) - (lb.pinch.mx - lb.pinch.tx) * k;
    lb.ty = (c.y - (r.top + r.height / 2)) - (lb.pinch.my - lb.pinch.ty) * k;
    lbClampPan();
    lbApply(false);
    return;
  }
  if (lb.pan) {
    e.preventDefault();
    const dx = e.clientX - lb.pan.x, dy = e.clientY - lb.pan.y;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) lb.pan.moved = true;
    lb.tx = lb.pan.tx + dx; lb.ty = lb.pan.ty + dy;
    lbClampPan();
    lbApply(false);
    return;
  }
  if (lb.swipe) {
    const dx = e.clientX - lb.swipe.x, dy = e.clientY - lb.swipe.y;
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) { lb.swipe = null; return; } // sideways: not a dismissal
    if (Math.abs(dy) > 8) lb.swipe.moved = true;
    const root = $('#lightbox');
    if (dy > 0) {
      lb.swipe.dy = dy;
      root.classList.add('dragging');
      root.style.transition = '';
      root.style.transform = `translateY(${Math.round(dy)}px)`;
      root.style.opacity = String(Math.max(0.4, 1 - dy / 700));
    } else { lb.swipe.dy = 0; root.style.transform = ''; root.style.opacity = ''; }
  }
});
// Up/cancel on the window, not the overlay: a finger that leaves the picture
// (or a pointer the browser cancels) must still retire its entry, or the next
// single-finger tap reads as a two-finger pinch.
function lbPointerUp(e) {
  if (!lb.ptrs.has(e.pointerId)) return;
  lb.ptrs.delete(e.pointerId);
  if (lb.pinch) {
    if (lb.ptrs.size < 2) lb.pinch = null;
    if (lb.ptrs.size === 1) {
      const p = [...lb.ptrs.values()][0];
      if (lb.scale > 1.001) lb.pan = { x: p.x, y: p.y, tx: lb.tx, ty: lb.ty, moved: true };
    }
    if (lb.ptrs.size) return;
  }
  if (lb.ptrs.size) return;
  const wasPan = lb.pan, swipe = lb.swipe, target = e.target;
  lb.pan = null; lb.swipe = null;
  if (!lb.open) return;
  if (swipe && swipe.moved) {
    const d = swipe.dy, v = d / Math.max(1, Date.now() - swipe.t0);
    if (d > 110 || (v > 0.55 && d > 40)) { lbSlideOut(); return; }
    const root = $('#lightbox'); // short drag: spring back
    root.classList.remove('dragging');
    root.style.transition = 'transform .18s ease-out, opacity .18s ease-out';
    root.style.transform = ''; root.style.opacity = '';
    setTimeout(() => { if (lb.open) root.style.transition = ''; }, 200);
    return;
  }
  if (wasPan && wasPan.moved) return;
  // A tap on the photo toggles the zoom. Mouse and pen get it on the first
  // click (click to zoom in, click again to zoom out); touch keeps double-tap
  // so a stray single tap never jumps the zoom. A tap on the backdrop closes.
  if (target === lbImg()) {
    if (e.pointerType === 'touch') {
      const now = Date.now();
      const near = Math.hypot(e.clientX - lb.tapX, e.clientY - lb.tapY) < 60;
      if (now - lb.lastTap < 320 && near) { lb.lastTap = 0; lbToggleZoom(e.clientX, e.clientY); }
      else { lb.lastTap = now; lb.tapX = e.clientX; lb.tapY = e.clientY; }
    } else {
      lbToggleZoom(e.clientX, e.clientY);
    }
    return;
  }
  closeLightbox();
}
window.addEventListener('pointerup', lbPointerUp);
window.addEventListener('pointercancel', lbPointerUp);
// Trackpad pinch arrives as ctrl+wheel on desktop.
$('#lightbox')?.addEventListener('wheel', (e) => {
  if (!lb.open || !e.ctrlKey) return;
  e.preventDefault();
  const r = lbStage().getBoundingClientRect();
  lbZoomAt(lb.scale * (1 - e.deltaY / 240), e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
}, { passive: false });
$('#lightbox-close')?.addEventListener('click', (e) => { e.stopPropagation(); closeLightbox(); });
$('#lightbox-dl')?.addEventListener('click', (e) => {
  // Don't let the tap reach the overlay (which would close it); the anchor
  // still downloads natively. Toast here — the document-level att-dl toast
  // never sees this click because of the stopPropagation.
  e.stopPropagation();
  const dl = e.currentTarget;
  toast(`Downloading ${(dl.getAttribute('download') || 'image').slice(0, 60)}…`);
});

// ---------- user card action tabs ----------
// The card's actions are a vertical list of tab rows (icon + label), not a
// wrapped row of pills: they read top-to-bottom like a menu and the destructive
// ones sit last. No emoji in chrome, so every tab carries an inline SVG.
const UC_ICONS = {
  mention: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  plus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  'x-user': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M17 8l5 5M22 8l-5 5"/>',
  'check-user': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M16 11l2 2 4-4"/>',
  'minus-user': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11h-6"/>',
  slash: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.2l2.4 2.4 4.6-4.8"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
};
function ucIconHTML(name) {
  const d = UC_ICONS[name];
  if (!d) return '';
  return `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}
// `mod` is ' primary' | ' danger' | '' — one tab row.
function ucTabHTML(id, icon, label, mod = '') {
  return `<button type="button" class="uc-tab${mod}" id="${id}">${ucIconHTML(icon)}<span>${label}</span></button>`;
}
// The user card's Remove tab. Groups have no mod roles, so removal is the group
// creator's alone — the same predicate the member row's right-click / long-press
// menu goes through (canRemoveGroupMember in actions.js), so the two paths can
// never disagree about who may remove whom. '' when it is not on offer.
function groupRemoveTabHTML(t, uid) {
  if (!canRemoveGroupMember(t, uid)) return '';
  return ucTabHTML('uc-remove', 'x-user', 'Remove', ' danger');
}
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
  // Group chats have no mod roles, so removal is the group creator's alone and
  // lives on the card exactly like a server's Kick/Ban: the same predicate the
  // member row's right-click / long-press menu uses (groupRemoveTabHTML).
  const dmThread = S.view === 'home' ? (S.dms || []).find((t) => t.id === S.dmThreadId) : null;
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
  const ban = u.banner_url || u.sidebar_banner_url;
  card.dataset.uid = uid;
  // The status menu always opens as just your current status.
  if (uid === S.me.id) presenceMenu = { open: false, cascade: null };
  card.style.background = cardBgFor(u);
  card.innerHTML = `
    <div class="uc-banner"${ban ? ` style="background-image:url('${esc(ban)}')"` : ''}></div>
    <div class="uc-body">
      <div class="uc-head"><span class="avatar big"></span>${statusBubbleHTML(u)}</div>
      <div class="uc-name"><span style="${nameStyleFor(u)}">${esc(u.display_name)}</span>${tagHTML(u)}</div>
      <div class="uc-sub">@${esc(u.username)}${u.role === 'owner' ? ' · server owner' : ''}</div>
      ${isSysAdmin(u) || isEarlyUser(u) ? `<div class="uc-badges">${isSysAdmin(u) ? '<span class="sysadmin-badge">System admin</span>' : ''}${isEarlyUser(u) ? '<span class="early-badge">Early user</span>' : ''}</div>` : ''}
      ${uid === S.me.id
        ? presenceWidgetHTML()
        : `<div class="uc-status" id="uc-statusline">${statusLineHTML(uid, u)}</div>`}
      ${streaming ? `<div class="uc-statustext ustream"><span class="vlive">LIVE</span><span>Streaming ${esc(streaming)}</span></div>` : ''}
      ${u.playing_game ? `<div class="uc-statustext ugame">${gameBadgeHTML(u.playing_game)}<span>Playing ${esc(u.playing_game)}</span></div>` : ''}
      ${u.bio ? `<div class="uc-bio">${renderRich(u.bio)}</div>` : ''}
      ${u.created_at ? `<div class="uc-since">Member since ${new Date(u.created_at).toLocaleDateString()}</div>` : ''}
      <div id="uc-gaming" class="uc-gaming hidden"></div>
      ${voiceVolHTML}
      ${voiceModHTML}
      ${cardRolesHTML(uid)}
      <div class="uc-tabs">${uid !== S.me.id ? ucTabHTML('uc-mention', 'mention', 'Mention') : ''}${uid !== S.me.id && !isBlocked(uid) ? ucTabHTML('uc-message', 'message', 'Message', ' primary') : ''}${uid !== S.me.id && !isBlocked(uid) ? friendBtnHTML(uid, 'uc-friend', 'uc-tab', true) : ''}${canMod ? ucTabHTML('uc-kick', 'minus-user', 'Kick', ' danger') + ucTabHTML('uc-ban', 'x-user', 'Ban', ' danger') : ''}${groupRemoveTabHTML(dmThread, uid)}${uid !== S.me.id ? ucTabHTML('uc-block', isBlocked(uid) ? 'check' : 'slash', isBlocked(uid) ? 'Unblock' : 'Block', isBlocked(uid) ? '' : ' danger') : ''}${ucTabHTML('uc-profile', 'user', 'Profile')}${ucTabHTML('uc-close', 'close', 'Close')}</div>
    </div>`;
  paintAvatar(card.querySelector('.avatar'), u);
  paintGameBadge(card.querySelector('.gbadge'));
  try { paintUserCardStory(card, u); } catch {}
  wireStatusBubble(card);
  wirePresenceWidget(card);
  loadUserGaming($('#uc-gaming'), u.username, { compact: true });
  card.style.bottom = ''; card.style.maxHeight = ''; card.style.overflowY = '';
  card.classList.remove('hidden');
  const h = card.offsetHeight || 300; // offsetHeight, not the animating rect (see popupBox)
  card.style.left = Math.max(8, Math.min(x || 8, innerWidth - Math.min(296, innerWidth - 16))) + 'px';
  card.style.top = Math.max(8, Math.min(y || 8, innerHeight - h - 8)) + 'px';
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
  const rmv = $('#uc-remove');
  if (rmv) rmv.onclick = () => { closeUserCard(); modGroupMember(dmThread, u); };
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
// A swipe-down dismiss leaves an inline `transform` (and the `animation: none`
// that let the drag take over the entry animation) on the panel — clear both so
// the next open animates in and nothing starts offset.
function closeUserCard() {
  const c = $('#usercard');
  c.classList.add('hidden');
  c.classList.remove('sheet');
  c.style.transform = '';
  c.style.transition = '';
  c.style.animation = '';
}
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
            message: 'Playtime, levels and streaks for this game are deleted for good. Detection keeps working — play it again and the record starts fresh.',
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
              haptic(12);
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
  if (card.classList.contains('sheet')) return; // the mobile sheet owns its geometry
  if (card.style.bottom && card.style.bottom !== 'auto') return; // grows upward, always safe
  const h = card.offsetHeight || 300; // see popupBox: never measure mid-animation
  let left = parseFloat(card.style.left);
  let top = parseFloat(card.style.top);
  if (!Number.isFinite(left)) left = 8;
  if (!Number.isFinite(top)) top = 8;
  card.style.left = Math.max(8, Math.min(left, innerWidth - Math.min(296, innerWidth - 16))) + 'px';
  card.style.top = Math.max(8, Math.min(top, innerHeight - h - 8)) + 'px';
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
// Wall-clock form of a pending timer — "3:55 PM" — for the "Until …" notes on
// your own card. A countdown makes you do arithmetic; the clock time is what
// you actually want to read. Longer spans pick up the day so the hour is never
// ambiguous; same-day stays bare.
function fmtUntil(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return time;
  const tmr = new Date(now.getTime() + 864e5);
  if (d.toDateString() === tmr.toDateString()) return 'tomorrow ' + time;
  if (d.getTime() - now.getTime() < 7 * 864e5) return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time;
}
// Custom status shown as a thought bubble beside the avatar (Discord-style).
// Other people only get a bubble when they set something; my own card always
// shows one so "set a status" lives up by the picture, not in the card body.
function statusBubbleHTML(u) {
  const mine = !!(S.me && u && u.id === S.me.id);
  const cur = ((u && u.status_text) || '').trim();
  if (!cur && !mine) return '';
  const exp = +((u && u.status_expires_at) || 0);
  const expNote = (mine && cur && exp > Date.now()) ? `<div class="uc-bubble-exp">Until ${fmtUntil(exp)}</div>` : '';
  const bubble = mine
    ? `<button type="button" class="uc-bubble edit${cur ? '' : ' empty'}" id="uc-status-edit" aria-label="${cur ? 'Edit custom status' : 'Set a custom status'}">${cur ? esc(cur) : 'Set a status'}</button>`
    : `<div class="uc-bubble">${esc(cur)}</div>`;
  const clear = (mine && cur)
    ? '<button type="button" class="uc-bubble-x" id="uc-status-clear" aria-label="Clear custom status" title="Clear status">×</button>'
    : '';
  return `<div class="uc-bubble-wrap"><div class="uc-bubble-fit">${bubble}${clear}</div>${expNote}</div>`;
}
function wireStatusBubble(card) {
  const se = card && card.querySelector('#uc-status-edit');
  if (se) se.onclick = () => openStatusEditor();
  const sc = card && card.querySelector('#uc-status-clear');
  if (sc) sc.onclick = () => clearMyStatus();
}
// ---------- presence switcher (your own card) ----------
// A vertical menu, like Discord's status picker: it starts as just your current
// status, opening it cascades the states (each with a chevron), and picking one
// cascades that state's timer underneath it. It replaces the status readout line
// on your own card (the collapsed row IS the readout), so the avatar can just
// open the card like every other avatar does.
const STATUS_TEXT = { online: 'Online', away: 'Away', dnd: 'Do not disturb', offline: 'Offline', invisible: 'Invisible' };
const PRESENCE_STATES = [['online', 'Online'], ['away', 'Away'], ['dnd', 'Do not disturb'], ['invisible', 'Invisible']];
// How long away/dnd/invisible lasts before lapsing back to Online.
const PRESENCE_DURATIONS = [
  { label: 'For 15 Minutes', ms: 15 * 60e3 },
  { label: 'For 1 Hour', ms: 3600e3 },
  { label: 'For 4 Hours', ms: 4 * 3600e3 },
  { label: 'For 8 Hours', ms: 8 * 3600e3 },
  { label: 'For 24 Hours', ms: 24 * 3600e3 },
  { label: 'For 3 Days', ms: 3 * 864e5 },
  { label: 'Forever', ms: null },
];
const PRESENCE_CARET = '<span class="pcaret"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>';
// Open/cascaded state of the menu. Reset whenever the card opens, so it always
// starts as just your current status.
let presenceMenu = { open: false, cascade: null };
function statusLineHTML(uid, u) {
  const st = statusOf(uid);
  const streaming = !isOff(st) && (u.streaming_game || null);
  const label = streaming ? 'Streaming' : (STATUS_TEXT[st] || 'Offline');
  return `<span class="status-dot ${dotOf(st, streaming)}"></span><span>${label}</span>`;
}
// Index of the pending duration nearest the live timer (so the option stays lit
// on a reopen), else the last one — "Forever".
function presenceDurationSel(cur, exp) {
  if (cur === 'online' || !exp) return PRESENCE_DURATIONS.length - 1;
  let best = -1, bd = Infinity;
  PRESENCE_DURATIONS.forEach((p, i) => { if (p.ms) { const d = Math.abs((Date.now() + p.ms) - exp); if (d < bd) { bd = d; best = i; } } });
  return (best >= 0 && bd < 5 * 60e3) ? best : PRESENCE_DURATIONS.length - 1;
}
function presenceWidgetHTML() {
  if (!S.me) return '';
  const cur = S.me.status || 'online';
  const exp = presenceExpiry();
  const open = presenceMenu.open;
  const cascade = open ? presenceMenu.cascade : null;
  const toggle = `<button type="button" class="prow toggle" id="presence-toggle" aria-expanded="${open}" aria-controls="presence-list"><span class="status-dot ${dotOf(cur, false)}"></span><span class="plabel">${STATUS_TEXT[cur] || 'Online'}</span>${PRESENCE_CARET}</button>`;
  let list = '';
  if (open) {
    list = '<div class="plist" id="presence-list">' + PRESENCE_STATES.map(([id, label]) => {
      // Online has no timer, so no chevron and no cascade from it.
      const chevron = id === 'online' ? '' : PRESENCE_CARET;
      const willCascade = cascade === id;
      const row = `<button type="button" class="prow sub${cur === id ? ' sel' : ''}" data-presence="${id}" aria-pressed="${cur === id}"${id === 'online' ? '' : ` aria-expanded="${willCascade}"`}><span class="status-dot ${id}"></span><span class="plabel">${label}</span>${chevron}</button>`;
      if (!willCascade) return row;
      const sel = cur === id ? presenceDurationSel(cur, exp) : -1;
      const times = PRESENCE_DURATIONS.map((p, i) => `<button type="button" class="prow time${i === sel ? ' on' : ''}" data-presence-ms="${p.ms === null ? 'never' : p.ms}" data-presence-state="${id}">${p.label}</button>`).join('');
      return row + `<div class="ptimes">${times}</div>`;
    }).join('') + '</div>';
  }
  const note = (cur !== 'online' && exp) ? `<div class="uc-preseg-note">Until ${fmtUntil(exp)}</div>` : '';
  return `<div class="uc-presence" id="uc-presence">${toggle}${list}${note}</div>`;
}
function renderPresenceWidget(card) {
  // Swap just the menu so the open card never moves, rescales, or loses its
  // scroll position — then pull a top-anchored card back on screen if the
  // menu's growth pushed it off.
  const box = card && card.querySelector('#uc-presence');
  if (!box) return;
  box.outerHTML = presenceWidgetHTML();
  wirePresenceWidget(card);
  try { clampUserCard(); } catch {}
}
function wirePresenceWidget(card) {
  const box = card && card.querySelector('#uc-presence');
  if (!box) return;
  const tog = box.querySelector('#presence-toggle');
  if (tog) tog.onclick = () => {
    presenceMenu.open = !presenceMenu.open;
    if (!presenceMenu.open) presenceMenu.cascade = null;
    renderPresenceWidget(card);
  };
  // Picking a state applies it and cascades its timer under the row it came
  // from; Online has nothing to cascade.
  box.querySelectorAll('[data-presence]').forEach((b) => (b.onclick = () => {
    const id = b.dataset.presence;
    presenceMenu.open = true;
    presenceMenu.cascade = id === 'online' ? null : id;
    choosePresence(id);
  }));
  box.querySelectorAll('[data-presence-ms]').forEach((b) => (b.onclick = () => {
    const raw = b.dataset.presenceMs;
    // The ladder applies the state it belongs to, not whatever the live status
    // happens to be: reading it here sent Online + a timer after the state had
    // lapsed, and setStatus drops the timer for Online picks — the click did
    // nothing at all.
    const state = b.dataset.presenceState || (S.me || {}).status || 'online';
    // `data-presence-ms` is a SPAN ("900000" = 15 minutes) while the setter wants
    // an absolute expiry. Posting the span raw sent an epoch-1970 timestamp, the
    // server answered 400 bad_expiry, and setStatus swallows that — so the state
    // stuck but the timer and its "Until …" note never appeared. Convert here.
    const ms = raw === 'never' ? null : Date.now() + Number(raw);
    // A picked span is the end of the interaction: collapse the menu back to the
    // status readout (the user card itself stays open).
    presenceMenu = { open: false, cascade: null };
    renderPresenceWidget(card);
    choosePresence(state, ms);
  }));
}
// State picks keep whatever timer is already counting; picking Online drops it.
async function choosePresence(s, ms) {
  const cur = (S.me || {}).status || 'online';
  // A hand-picked presence must survive the next mouse move (only the idle
  // auto-away is revertible), including re-picking the state you are in.
  if (typeof markPresenceManual === 'function') markPresenceManual();
  if (ms === undefined && s === cur) { renderPresenceWidget($('#usercard')); return; } // nothing changed: never clear a live timer
  const exp = ms === undefined ? (presenceExpiry() || null) : ms;
  try { await setStatus(s, s === 'online' ? null : exp); } catch {}
}
function refreshOwnPresence() {
  // Repaint the menu in place (setStatus calls this for every path, the idle
  // auto-away flip included) with its open/cascaded state intact.
  const card = $('#usercard');
  if (!card || card.classList.contains('hidden') || card.dataset.uid !== S.me.id) return;
  renderPresenceWidget(card);
}
function refreshOwnStatusBubble() {
  // Swap just the bubble so the open card never moves, rescales, or loses
  // its scroll position.
  const card = $('#usercard');
  if (!card || card.classList.contains('hidden') || card.dataset.uid !== S.me.id) return;
  const wrap = card.querySelector('.uc-bubble-wrap');
  if (!wrap) return;
  wrap.outerHTML = statusBubbleHTML(S.me);
  wireStatusBubble(card);
}
async function clearMyStatus() {
  try {
    const { user } = await api('/api/me', { method: 'PATCH', body: JSON.stringify({ statusText: '' }) });
    if (user) { S.me = { ...S.me, ...user }; paintMe(); }
    toast('Status cleared');
    refreshOwnStatusBubble();
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
    <select id="m-status-exp" aria-label="Clear custom status after">${presets.map((p, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${p.label}</option>`).join('')}</select>
    ${cur ? '<div class="row" style="margin-top:.7rem"><button type="button" class="btn small danger" id="m-status-clear">Clear status</button></div>' : ''}
  `, 'Save', async () => {
    const text = ((($('#m-status-text') || {}).value) || '').trim().slice(0, 64);
    const ts = presets[sel].ts;
    try {
      const { user } = await api('/api/me', { method: 'PATCH', body: JSON.stringify({ statusText: text, statusExpiresAt: text ? ts : null }) });
      if (user) { S.me = { ...S.me, ...user }; paintMe(); }
      toast(text ? 'Status updated' : 'Status cleared');
      refreshOwnStatusBubble();
    } catch (err) { toast(prettyError(err.message)); }
  });
  const mclr = $('#m-status-clear');
  if (mclr) mclr.onclick = async () => { cancelModal(); await clearMyStatus(); };
  const expSel = $('#m-status-exp');
  if (expSel) expSel.onchange = () => { sel = +expSel.value; };
}
// ---------- profile screen (full overlay) ----------
// `fallback` is a user object to use when the account is not in any loaded
// roster (a story author from a server you have since left, for instance).
function openProfileScreen(uid, fallback) {
  const u = memberById(uid) || (fallback && fallback.id === uid ? fallback : null);
  if (!u) return;
  const bd = $('#profile-backdrop');
  const isMe = uid === S.me.id;
  const st = statusOf(uid);
  const pstreaming = !isOff(st) && (u.streaming_game || null);
  const stLabel = pstreaming ? 'Streaming' : ({ online: 'Online', away: 'Away', dnd: 'Do not disturb', offline: 'Offline', invisible: 'Invisible' }[st] || 'Offline');
  $('#pf-banner').style.backgroundImage = u.banner_url ? `url('${esc(u.banner_url)}')` : '';
  paintAvatar($('#pf-avatar'), u);
  $('#pf-name').innerHTML = `<span class="mname" style="${nameStyleFor(u)}">${esc(u.display_name)}</span>${tagHTML(u)}`;
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
  // The profile picture carries the story affordance (see paintProfileStory).
  try { paintProfileStory(u); } catch {}
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
function closeProfileScreen() {
  const p = document.querySelector('#profile-backdrop .profile');
  $('#profile-backdrop').classList.add('hidden');
  if (p) { p.style.transform = ''; p.style.transition = ''; p.style.animation = ''; }
}
$('#profile-close').onclick = closeProfileScreen;
$('#profile-backdrop').addEventListener('click', (e) => { if (e.target.id === 'profile-backdrop') closeProfileScreen(); });

// ---------- @mention autocomplete ----------
// Enter/Tab is owned by an open popup: it completes the name, it never sends.
// Registering order matters here — this file loads before final.js, so the
// pop handler runs first and hides the popup while the same keydown event is
// still being dispatched; the send handler (composerSendKey in final.js) would
// then see a hidden popup and submit. Marking the event tells it to stand down.
function popupTookKey(e) { e.cfAutocomplete = true; }
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
    popupTookKey(e);
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
    popupTookKey(e);
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
    popupTookKey(e);
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

