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
  renderEmojiGrid('');
  ensureEmojiData().then(() => { if (S.picker) renderEmojiGrid($('#pk-search').value); });
  if (mode !== 'react') loadGifTrending();
  loadGifFavs();
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
    box.querySelector('[data-pkback]').onclick = () => {
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
    box.querySelector('[data-pkfavs]').onclick = () => { gifSubView = 'favs'; renderGifTab(); };
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
  repBox.innerHTML = '';
  for (const r of S.thread.replies) repBox.appendChild(messageEl(r, { inThread: true }));
  if (!S.thread.replies.length) repBox.innerHTML = '<p class="muted small" style="text-align:center">No replies yet.</p>';
  if (scroll || nearBottom) anchorBottom(repBox);
}
function closeThread(silent) {
  S.thread = null;
  S.threadReplyTo = null; renderThreadComposerMeta();
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
  sendChat(content, { threadRoot: S.thread.rootId, replyTo: S.threadReplyTo?.id || null });
  S.threadReplyTo = null;
  renderThreadComposerMeta();
  composerAutoGrow(inp); // programmatic clear doesn't fire 'input', so reset height here
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

