'use strict';
/* ================= pins + jump-to-present ================= */
function pinsCtx() {
  if (S.view === 'home') return S.dmThreadId ? { kind: 'dm', id: S.dmThreadId } : null;
  return (S.serverId && S.channelId) ? { kind: 'server', id: S.channelId, serverId: S.serverId } : null;
}
function pinsUrl(ctx, suffix = '') {
  return ctx.kind === 'dm' ? `/api/dms/${ctx.id}/pins${suffix}` : `/api/servers/${ctx.serverId}/channels/${ctx.id}/pins${suffix}`;
}
function sameCtx(a, b) { return !!a && !!b && a.kind === b.kind && a.id === b.id; }
/* ---------- "new pins" memory ----------
 * The pin button's badge is a hint that this conversation has pins this account
 * has not looked at, not a permanent count of them: a number that sits there
 * however many times you open the panel reads as an unread badge that cannot be
 * cleared. Opening the panel (or pinning something yourself) remembers what was
 * in it, so the badge goes away and stays away across reloads.
 * Per account, and mirrored on the server (pin_seen table) so the memory
 * follows the account across devices rather than per browser: clearing it on
 * the phone clears it on the desktop, live (the server pushes pin-seen to the
 * account's other sockets). localStorage stays as the instant-paint cache and
 * is merged with the server copy on boot. Contexts match draftCtx:
 * 's:<serverId>:<channelId>' / 'd:<threadId>'. */
const PIN_SEEN_MAX = 60;          // conversations remembered (oldest fall off)
const PIN_SEEN_TTL = 90 * 864e5;
const PIN_SEEN_IDS_MAX = 300;    // ids kept per conversation (backstop)
function pinSeenStoreKey() { return S.me ? 'cf_pinseen_' + S.me.id : null; }
function pinSeenCtxKey(ctx) {
  if (!ctx) return null;
  return ctx.kind === 'dm' ? 'd:' + ctx.id : 's:' + ctx.serverId + ':' + ctx.id;
}
function pinSeenLoad() {
  const k = pinSeenStoreKey();
  if (!k) return {};
  try { return JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch { return {}; }
}
// Persist, pruning by age then by recency. The cap is by write/at time rather
// than insertion order so a merge (below) can't shuffle the survivors.
function pinSeenSave(all) {
  const k = pinSeenStoreKey();
  if (!k) return;
  const cut = Date.now() - PIN_SEEN_TTL;
  const keys = Object.keys(all).filter((x) => all[x] && (all[x].at || 0) >= cut);
  keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
  const out = {};
  for (const x of keys.slice(-PIN_SEEN_MAX)) out[x] = all[x];
  try { localStorage.setItem(k, JSON.stringify(out)); } catch {}
}
function pinSeenIds(ctx) {
  const key = pinSeenCtxKey(ctx);
  if (!key) return new Set();
  const e = pinSeenLoad()[key];
  return new Set(e && Array.isArray(e.ids) ? e.ids : []);
}
function pinSeenWrite(ctx, ids) {
  const key = pinSeenCtxKey(ctx);
  if (!pinSeenStoreKey() || !key) return;
  const all = pinSeenLoad();
  const list = [...new Set(ids || [])].filter((x) => x).slice(-PIN_SEEN_IDS_MAX);
  all[key] = { ids: list, at: Date.now() };
  pinSeenSave(all);
  pinSeenQueue(ctx, list); // ...and to the account's shared copy
}
/* ---- cross-device mirror ----
 * Writes are coalesced (the panel open walks every pin id, then the re-fetch
 * walks them again) and fire-and-forget: failing to reach the server must
 * never block the badge clearing locally. keepalive so the pagehide flush
 * still lands when the tab is being reloaded/closed. */
const pinSeenPending = new Map(); // ctxKey -> { key, ids }
let pinSeenPushT = null;
async function pinSeenFlush() {
  pinSeenPushT = null;
  const jobs = [...pinSeenPending.values()];
  pinSeenPending.clear();
  if (!jobs.length || typeof api !== 'function') return;
  await Promise.all(jobs.map((j) => api('/api/pins/seen', {
    method: 'POST', keepalive: true, body: JSON.stringify({ ctx: j.key, ids: j.ids }),
  }).catch(() => {})));
}
function pinSeenQueue(ctx, ids) {
  if (typeof api !== 'function') return; // e.g. the offline unit test harness
  const key = typeof ctx === 'string' ? ctx : pinSeenCtxKey(ctx);
  if (!key) return;
  pinSeenPending.set(key, { key, ids });
  if (!pinSeenPushT) pinSeenPushT = setTimeout(pinSeenFlush, 300);
}
// Merge a server copy (boot fetch or the live pin-seen push) into the cache.
// Union, never replace: the badge is a "have I looked at this" hint, so an id
// either side has read must stay read. Ids are never reused, so a stale id that
// the server no longer holds can't hide a genuinely new pin. A conversation
// this device has read but the server has not (the write never got through:
// offline, killed tab) is pushed back, so the copies converge on the next boot.
async function pinSeenPull() {
  try {
    const { seen } = await api('/api/pins/seen');
    applyPinSeenRemote(seen);
  } catch {}
}
function applyPinSeenRemote(seen) {
  const k = pinSeenStoreKey();
  if (!k || !seen) return;
  const all = pinSeenLoad();
  // Every conversation either side knows about: one the server has never heard
  // of is still this device's memory (the write never got through: offline,
  // tab killed before the flush), so it is pushed back below.
  for (const key of new Set([...Object.keys(all), ...Object.keys(seen)])) {
    const remote = seen[key] || { ids: [], at: 0 };
    const ids = Array.isArray(remote.ids) ? remote.ids : [];
    const cur = all[key] && Array.isArray(all[key].ids) ? all[key].ids : [];
    const remoteSet = new Set(ids);
    const localOnly = cur.filter((x) => !remoteSet.has(x));
    if (!localOnly.length && ids.every((x) => cur.includes(x))) continue; // already in sync
    const merged = [...new Set([...cur, ...ids])].slice(-PIN_SEEN_IDS_MAX);
    all[key] = { ids: merged, at: Math.max((all[key] && all[key].at) || 0, Number(remote.at) || 0) };
    if (localOnly.length) pinSeenQueue(key, merged);
  }
  pinSeenSave(all);
  try { paintPinsBtn(); } catch {}
}
// Pin something yourself → it is not news to you (the badge must not light for
// an action you just took).
function markPinsSeen(ctx, ids) {
  if (!ctx) return;
  const set = pinSeenIds(ctx);
  for (const id of ids || []) if (id) set.add(id);
  pinSeenWrite(ctx, set);
}
// The panel is open: what it lists IS what has been read, so the memory is
// replaced with exactly those ids and unpinned ones cannot pile up in the store.
function rememberPinsSeen(ctx, ids) {
  if (!ctx) return;
  pinSeenWrite(ctx, ids || []);
}
function pinsPanelOpen(ctx) {
  try {
    return sameCtx(S.pinsCtx, ctx) && !!document.querySelector('#modal-body .pins-list')
      && !$('#modal-backdrop').classList.contains('hidden');
  } catch { return false; }
}
function unseenPinCount(ctx) {
  const key = pinSeenCtxKey(ctx);
  // S.pinIds is only meaningful for the conversation it was fetched for: a
  // channel switch repaints the header before the new fetch lands.
  if (!key || S.pinIdsCtx !== key) return 0;
  const seen = pinSeenIds(ctx);
  let n = 0;
  for (const id of S.pinIds) if (!seen.has(id)) n++;
  return n;
}
// Per-conversation scroll memory: leaving a channel/DM mid-read and coming
// back restores where you were instead of forcing the bottom. Saved as the
// distance from the bottom so newly arrived messages don't shift the view.
function scrollMemKey(ctx) { return ctx ? ctx.kind + ':' + ctx.id : null; }
function saveScrollPos() {
  try {
    const key = scrollMemKey(pinsCtx());
    const box = $('#messages');
    // Only real message lists count — the Loading…/error placeholders and
    // the NSFW gate have no .msg nodes and must never clobber the memory.
    if (!key || !box || !box.querySelector('.msg')) return;
    // #messages is shared by every conversation and is only repainted after
    // the switch, so a caller that moves S.channelId/S.dmThreadId *before*
    // switching (selectServer's first channel, a deleted channel, a server
    // update) would otherwise key the still-displayed conversation's position
    // under the one being opened. The saved anchor then belongs to another
    // channel, the restore falls back to its distance-from-bottom against a
    // fresh layout, and the channel opens scrolled several messages up.
    if (box.dataset.ctx && box.dataset.ctx !== key) return;
    // Anchor on the topmost visible message (id + viewport offset, which is
    // negative when the message straddles the top edge — keep it raw, exact).
    // Distance-from-bottom stays as the fallback (anchor scrolled away).
    let anchor = null;
    const btop = box.getBoundingClientRect().top;
    for (const el of box.querySelectorAll('.msg')) {
      const r = el.getBoundingClientRect();
      if (r.bottom > btop + 1) { anchor = { mid: el.dataset.mid || null, off: r.top - btop }; break; }
    }
    S.scrollMem.set(key, { dist: box.scrollHeight - box.scrollTop, anchor });
  } catch {}
}
function restoreScrollPos(ctx) {
  try {
    if (!sameCtx(pinsCtx(), ctx)) return;
    const mem = S.scrollMem.get(scrollMemKey(ctx));
    if (!mem) return;
    const box = $('#messages');
    if (!box || box.classList.contains('hidden')) return;
    const a = mem.anchor;
    if (a && a.mid) {
      const el = box.querySelector('[data-mid="' + CSS.escape(a.mid) + '"]');
      if (el) {
        setScrollTop(box, box.scrollTop + ((el.getBoundingClientRect().top - box.getBoundingClientRect().top) - a.off), '0');
        updatePill();
        stickRestoredAnchor(box, scrollMemKey(ctx));
        return;
      }
    }
    if (mem.dist != null && mem.dist > 200) setScrollTop(box, Math.max(0, box.scrollHeight - mem.dist), '0');
    updatePill();
  } catch {}
}
// Channel/DM open: restore the saved mid-read position, or go to the live
// bottom? Only a position well beyond one viewport counts as mid-read — a
// bottom view saves ≈ viewport height, and restoring that through a fresh
// (media-unloaded) layout would yank the view and kill the bottom hold.
function wantsMidReadRestore(ctx) {
  try {
    if (!sameCtx(pinsCtx(), ctx)) return false;
    const box = $('#messages');
    const ch = (box && box.clientHeight) || 600;
    const mem = S.scrollMem.get(scrollMemKey(ctx));
    return !!(mem && mem.dist != null && mem.dist > ch + 200);
  } catch { return false; }
}
// Late media (cold-cache images, video metadata) changes heights after a
// restore and would nudge the view. Briefly glue the anchor while things
// settle — stops the moment the user scrolls themselves.
function stickRestoredAnchor(box, key) {
  try {
    const mem = S.scrollMem.get(key);
    if (mem && mem.anchor && typeof pinAnchorWhileSettling === 'function') pinAnchorWhileSettling(box, mem.anchor);
  } catch {}
}
async function refreshPinsCount() {
  const ctx = pinsCtx();
  if (!ctx) { S.pinCount = 0; S.pinIds = new Set(); S.pinIdsCtx = null; paintPinsBtn(); return; }
  try {
    const { pins } = await api(pinsUrl(ctx));
    if (!sameCtx(pinsCtx(), ctx)) return;
    S.pinCount = pins.length;
    S.pinIds = new Set(pins.map((p) => p.id));
    S.pinIdsCtx = pinSeenCtxKey(ctx);
    // Someone pinned while I had the panel open: those rows are on screen, so
    // re-fetching must not light a badge for a list I am already reading.
    if (pinsPanelOpen(ctx)) rememberPinsSeen(ctx, S.pinIds);
  } catch { S.pinCount = 0; S.pinIds = new Set(); S.pinIdsCtx = null; }
  paintPinsBtn();
}
function paintPinsBtn() {
  const ctx = pinsCtx();
  const btn = $('#btn-pins');
  btn.classList.toggle('hidden', !ctx);
  const unseen = unseenPinCount(ctx);
  const b = $('#pins-count');
  b.textContent = unseen > 99 ? '99+' : String(unseen);
  b.classList.toggle('hidden', !unseen);
  btn.title = unseen ? `Pinned messages · ${unseen} new` : 'Pinned messages';
}
async function togglePin(mid) {
  const ctx = pinsCtx();
  if (!ctx) return;
  const pinned = S.pinIds.has(mid);
  try {
    if (pinned) await api(pinsUrl(ctx, '/' + mid), { method: 'DELETE' });
    else await api(pinsUrl(ctx), { method: 'POST', body: JSON.stringify({ messageId: mid }) });
    toast(pinned ? 'Unpinned' : 'Pinned to this ' + (ctx.kind === 'dm' ? 'chat' : 'channel'));
    if (!pinned) markPinsSeen(ctx, [mid]);
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
  S.pinIdsCtx = pinSeenCtxKey(ctx);
  // The panel is open (or was just asked to open): everything in it is read.
  rememberPinsSeen(ctx, S.pinIds);
  paintPinsBtn();
  if (!pins.length) { box.innerHTML = '<p class="muted small" style="text-align:center;padding:1rem">No pinned messages yet — right-click (or long-press) a message to pin it.</p>'; return; }
  box.innerHTML = '';
  for (const p of pins) {
    const row = document.createElement('div');
    row.className = 'pin-row';
    const text = p.content ? (p.content.length > 220 ? p.content.slice(0, 220) + '…' : p.content) : '';
    const atts = Array.isArray(p.attachments) ? p.attachments : [];
    row.innerHTML = '<span class="avatar"></span><div class="pin-main"><div class="pin-head"><span class="who"></span><span class="when"></span></div><div class="pin-text"></div><div class="pin-atts"></div><div class="pin-meta"></div></div>';
    const who = row.querySelector('.who');
    who.innerHTML = p.user
      ? `<span style="${nameStyleFor(p.user)}">${esc(p.user.display_name)}</span>${tagHTML(p.user)}`
      : 'deleted';
    row.querySelector('.when').textContent = fmtTime(p.created_at);
    row.querySelector('.when').title = fmtFull(p.created_at);
    const textEl = row.querySelector('.pin-text');
    if (text) textEl.textContent = text;
    else if (!atts.length) textEl.textContent = '[no text]';
    else textEl.remove();
    const attsEl = row.querySelector('.pin-atts');
    if (atts.length && typeof attachmentHTML === 'function') attsEl.innerHTML = atts.map(attachmentHTML).join('');
    else attsEl.remove();
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
  try { box.querySelectorAll('video.att-vid').forEach((v) => ensureVideoPoster(v)); } catch {}
}
// Jump-to-message flight control.
//
// A plain `scrollIntoView({behavior:'smooth'})` cannot survive this list. A
// rebuilt window renders its lazy images/videos at zero height and they only
// start loading as they near the viewport, so every one that pops in while the
// animation runs moves the target — the animation keeps aiming at the offset
// it computed at the start — and the browser's scroll anchoring rewrites
// scrollTop to compensate for the growth, which aborts the in-flight smooth
// scroll. The view stops partway, and clicking the hit again nudges it a
// little further. So own the scroll instead: cancel the other scroll owners
// (bottom hold, rebuild anchor hold) and native anchoring, land on the target
// immediately, then re-center it on every settle until the user takes over.
function flashMsgEl(el) {
  if (!el) return;
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  const box = el.closest('#messages,#thread-replies');
  if (!box) { try { el.scrollIntoView({ block: 'center' }); } catch {} return; }
  holdMsgCentered(box, el.dataset.mid || null, el);
}
// Center `mid` (falling back to the element itself) in `box` and keep it
// centered while late media settles. Stops the moment the user scrolls
// themselves, when the conversation changes, or after a few seconds.
function holdMsgCentered(box, mid, fallbackEl) {
  if (!box) return;
  const sel = mid ? '[data-mid="' + CSS.escape(mid) + '"]' : null;
  const find = () => (sel ? box.querySelector(sel) : (fallbackEl && fallbackEl.isConnected ? fallbackEl : null));
  // One hold per box: bumping the bottom hold's gen (anchorBottom) and the
  // rebuild anchor hold's gen (pinAnchorWhileSettling) retires both, so they
  // can't yank the view back to where it was right after we land.
  box._holdGen = (box._holdGen | 0) + 1;
  box._pinGen = (box._pinGen | 0) + 1;
  // Native scroll anchoring would do the same behind our back — this function
  // is the anchor for the duration.
  box._jumpHold = true;
  const prevAnchorCss = box.style.overflowAnchor;
  box.style.overflowAnchor = 'none';
  const v = S.view, c = S.channelId, d = S.dmThreadId;
  const stillHere = () => S.view === v && S.channelId === c && S.dmThreadId === d && !box.classList.contains('hidden');
  // A second jump (impatient double-click on a hit) supersedes this one; the
  // loser must stop without clobbering the winner's state.
  const mine = (box._jumpGen = (box._jumpGen | 0) + 1);
  const current = () => live && box._jumpGen === mine;
  let live = true, expected = 0, mo = null, timer = 0;
  const stop = () => {
    if (!live) return; live = false;
    try { if (mo) mo.disconnect(); } catch {}
    clearTimeout(timer);
    box.removeEventListener('wheel', stop);
    box.removeEventListener('touchmove', stop);
    box.removeEventListener('scroll', onScroll);
    box.removeEventListener('load', onSettle, true);
    box.removeEventListener('error', onSettle, true);
    box.removeEventListener('loadedmetadata', onSettle, true);
    if (box._jumpGen === mine) {
      box._jumpHold = false;
      box.style.overflowAnchor = prevAnchorCss;
    }
  };
  const place = () => {
    if (!current()) { stop(); return; }
    if (!stillHere()) { stop(); return; }
    const t = find();
    if (!t || !t.isConnected) return;
    const r = t.getBoundingClientRect(), b = box.getBoundingClientRect();
    const delta = (r.top - b.top) - (box.clientHeight - r.height) / 2;
    if (Math.abs(delta) > 0.5) setScrollTop(box, box.scrollTop + delta, '0'); // jumping to a message is not the live bottom
    expected = box.scrollTop; // our own landings must not look like a takeover
  };
  const onScroll = () => {
    // Our own placements fire scroll events too — only a position that isn't
    // ours (checked next frame) means the user dragged the scrollbar.
    requestAnimationFrame(() => { if (current() && Math.abs(box.scrollTop - expected) > 2) stop(); });
  };
  const onSettle = (e) => {
    // Capture phase: 'load' doesn't bubble, but this still catches media
    // injected later (link embeds resolving seconds after the jump).
    if (e.target && e.target.matches && e.target.matches('img, video')) place();
  };
  place();
  // Not every late growth fires a media event (embeds, thumbnails, scans
  // flipping to files) — re-center through those too.
  try {
    mo = new MutationObserver(() => place());
    mo.observe(box, { childList: true, subtree: true, characterData: true });
  } catch { mo = null; }
  box.addEventListener('wheel', stop, { passive: true });
  box.addEventListener('touchmove', stop, { passive: true });
  box.addEventListener('scroll', onScroll, { passive: true });
  box.addEventListener('load', onSettle, true);
  box.addEventListener('error', onSettle, true);
  box.addEventListener('loadedmetadata', onSettle, true);
  // Media can keep landing for a while in a fresh window; stop chasing after
  // a few seconds so the reader is always free to scroll again.
  timer = setTimeout(stop, 6000);
  if (typeof updatePill === 'function') { try { updatePill(); } catch {} }
}
async function jumpToPin(ctx, mid) {
  // Landing on a pinned message is viewing it, wherever the jump came from
  // (the panel, a search hit) — clear its "new" mark for the conversation.
  if (sameCtx(pinsCtx(), ctx)) { markPinsSeen(ctx, [mid]); paintPinsBtn(); }
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
  const target = document.querySelector(sel);
  if (target) flashMsgEl(target);
  updatePill();
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
    // A deliberate request for the bottom: mark it now, and track our own
    // landing so the smooth scroll's pass over the history isn't mistaken for
    // the reader scrolling up (or cut short by the pinned-state re-pin).
    try { box.dataset.atBottom = '1'; box._autoTop = Math.max(0, box.scrollHeight - box.clientHeight); box._smoothUntil = Date.now() + 400; } catch {}
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
  let desc = '';
  if (S.view === 'server') {
    const ch = (S.serverDetail?.channels || []).find((c) => c.id === S.channelId);
    desc = (ch?.description || '').trim();
  } else {
    // A group chat's description is its topic line; 1:1 DMs have none.
    const t = (S.dms || []).find((x) => x.id === S.dmThreadId);
    if (t && t.isGroup) desc = (t.description || '').trim();
  }
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
  if (S.view !== 'server') {
    const t = (S.dms || []).find((x) => x.id === S.dmThreadId);
    const desc = (t && t.isGroup && (t.description || '').trim()) || '';
    if (desc) openModal(t.name || 'Group chat', `<p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(desc)}</p>`, 'Close', null);
    return;
  }
  const ch = (S.serverDetail?.channels || []).find((c) => c.id === S.channelId);
  const desc = (ch?.description || '').trim();
  if (desc) openModal(`#${ch.name}`, `<p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(desc)}</p>`, 'Close', null);
};
async function selectDmThread(id, opts = {}) {
  flushDrafts(); // file the previous conversation's text before its context changes
  saveScrollPos();
  S.dmThreadId = id;
  rememberView();
  rememberHomeTab(); // this is the tab Home comes back to
  // Opening a thread clears its unread badge (row + home button) and tells the
  // server, so it stays cleared across a reload or a rollout restart.
  markDmRead(id, 0);
  renderDmLists();
  S.callOpen = false;
  // A row tap closes the phone's nav page. The campfire button's restore must
  // not: Home deliberately keeps that page up so a conversation can be picked
  // out of it (keepNav).
  if (!opts.keepNav) document.body.classList.remove('nav-open');
  $('#chat').classList.remove('call-open');
  renderStage();
  document.querySelectorAll('.dmrow').forEach((b) => b.classList.toggle('active', b.dataset.dmthread === id));
  const t = S.dms.find((x) => x.id === id);
  if (!t) { renderDmBlank(); return; }
  document.body.classList.add('dm-open');
  $('#composer').classList.remove('hidden');
  $('#friends-page').classList.add('hidden');
  $('#stories-page').classList.add('hidden');
  $('#messages').classList.remove('hidden');
  renderDmMembers();
  paintSlowmodeHint();
  paintDmHead(t);
  paintDmCallButtons();
  try { clearTyping(); } catch {}
  applyComposerDraft(); // this DM's own unfinished text, if any
  S.replyTo = null; S.pendingAtts = []; S.editing = null;
  renderComposerMeta();
  // Instant: paint the cached tail (if any) at the remembered anchor so
  // switching back never flashes Loading… or jumps; the fetch below tops up.
  S.histMode = null;
  S.histNew = 0;
  const cachedDm = S.dmMessages.get(id);
  // Restore a saved mid-read position, or hold the live bottom — never
  // both (see selectChannel: a stale restore yank kills the bottom hold).
  const wantMidDm = wantsMidReadRestore({ kind: 'dm', id });
  if (cachedDm && cachedDm.length) {
    if (wantMidDm) { renderDmMessages(); restoreScrollPos({ kind: 'dm', id }); }
    else renderDmMessages(true);
  } else {
    $('#messages').innerHTML = '<p class="muted">Loading…</p>';
  }
  try {
    const { messages } = await api(`/api/dms/${id}/messages?limit=80`);
    if (S.dmThreadId !== id) return;
    S.dmMessages.set(id, messages);
    S.editing = null;
    S.histMode = null;
    S.histNew = 0;
    if (cachedDm && cachedDm.length) {
      if (wantMidDm) { renderDmMessages(); restoreScrollPos({ kind: 'dm', id }); }
      else renderDmMessages(true);
    } else {
      renderDmMessages(true);
    }
    refreshPinsCount();
    updatePill();
  } catch {
    if (S.dmThreadId !== id) return;
    if (!cachedDm || !cachedDm.length) $('#messages').innerHTML = '<p class="error">Could not load messages.</p>';
  }
}
// The Home main area shows one panel at a time — the Friends feed or the story
// center. Both are "no conversation" states, so every path that lands on one
// comes through here (and the header/nav highlight follow).
function paintHomePanel() {
  const stories = S.homePanel === 'stories';
  $('#friends-page').classList.toggle('hidden', stories);
  $('#stories-page').classList.toggle('hidden', !stories);
  if (stories) { try { renderStoriesPage(); } catch {} }
}
function renderDmBlank() {
  document.body.classList.remove('dm-open');
  S.histMode = null;
  S.histNew = 0;
  // A blank Home screen has no conversation: clear any stale pins state so the
  // header pins icon from the previous channel/DM doesn't linger.
  S.pinCount = 0; S.pinIds = new Set(); S.pinIdsCtx = null; paintPinsBtn();
  updatePill();
  document.body.classList.remove('dm-open');
  $('#composer').classList.add('hidden');
  $('#messages').classList.add('hidden');
  paintHomePanel();
  document.querySelectorAll('#home-ui .dmrow').forEach((b) => b.classList.remove('active'));
  const stories = S.homePanel === 'stories';
  $(stories ? '#btn-stories' : '#btn-friends')?.classList.add('active');
  $('#chan-hash').textContent = '';
  $('#chan-name').textContent = stories ? 'Stories' : 'Friends';
  try { clearTyping(); } catch {}
  paintDmCallButtons();
  renderTopic();
  renderActiveNow();
}
function renderDmMessages(force = false) {
  const box = $('#messages');
  const msgs = S.dmMessages.get(S.dmThreadId) || [];
  const dmCtx = 'dm:' + (S.dmThreadId || '');
  // Fade in only on a real conversation change (see convoSwapPulse): an
  // incoming message re-renders this same list and must not flicker.
  if (box.dataset.ctx && box.dataset.ctx !== dmCtx) convoSwapPulse();
  box.dataset.ctx = dmCtx; // see renderMessages/saveScrollPos
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
  // Same anchor preservation as renderMessages: rebuilding resets scrollTop
  // to 0, which used to yank scrolled-up readers upward on updates.
  const anchor = nearBottom ? null : captureListAnchor(box);
  const keepDist = box.scrollHeight - box.scrollTop;
  box.innerHTML = '';
  let lastDay = '', prev = null;
  for (const m of msgs) {
    const day = fmtDay(m.created_at);
    if (day !== lastDay) { lastDay = day; prev = null; const d = document.createElement('div'); d.className = 'day'; d.textContent = day; box.appendChild(d); }
    box.appendChild(messageEl(m, { grouped: shouldGroup(prev, m) }));
    prev = m;
  }
  if (!msgs.length) box.innerHTML += '<p class="muted" style="text-align:center">No messages yet — say hello.</p>';
  if (force || nearBottom) anchorBottom(box);
  else if (typeof pinAnchorWhileSettling === 'function') pinAnchorWhileSettling(box, restoreListAnchor(box, anchor, keepDist));
  else restoreListAnchor(box, anchor, keepDist);
  updatePill();
}
function sendDm(content, opts = {}) {
  if (!S.dmThreadId) return;
  if (S.ws && S.ws.readyState === 1) {
    S.ws.send(JSON.stringify({ t: 'dm', threadId: S.dmThreadId, content, attachments: opts.attachments || [], replyTo: opts.replyTo || null }));
    // Optimistic: echo appends incrementally — pin to the bottom now,
    // with the hold (a full render here flashes every avatar in Safari).
    try { const _b = $('#messages'); anchorBottom(_b); updatePill(); } catch {}
  } else toast('Reconnecting… try again in a second');
}
