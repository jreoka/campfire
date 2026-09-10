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
        box.scrollTop += (el.getBoundingClientRect().top - box.getBoundingClientRect().top) - a.off;
        updatePill();
        stickRestoredAnchor(box, scrollMemKey(ctx));
        return;
      }
    }
    if (mem.dist != null && mem.dist > 200) box.scrollTop = Math.max(0, box.scrollHeight - mem.dist);
    updatePill();
  } catch {}
}
// Late media (cold-cache images, video metadata) changes heights after a
// restore and would nudge the view. Briefly glue the anchor while things
// settle — stops the moment the user scrolls themselves.
function stickRestoredAnchor(box, key) {
  try {
    const mem = S.scrollMem.get(key);
    const mid = mem && mem.anchor && mem.anchor.mid;
    if (!mid || typeof mem.anchor.off !== 'number') return;
    const sel = '[data-mid="' + CSS.escape(mid) + '"]';
    const media = [...box.querySelectorAll('img, video')].filter((m) =>
      m.tagName === 'VIDEO' ? m.readyState < 1 : !m.complete);
    if (!media.length) return;
    const t0 = Date.now();
    let expected = box.scrollTop, done = 0;
    const realign = () => {
      if (done >= media.length || Date.now() - t0 > 2500) return;
      if (Math.abs(box.scrollTop - expected) > 2) { done = media.length; return; } // user took over
      const el = box.querySelector(sel);
      if (!el || !el.isConnected) return;
      const want = expected + ((el.getBoundingClientRect().top - box.getBoundingClientRect().top) - mem.anchor.off);
      if (Math.abs(want - box.scrollTop) > 0.5) box.scrollTop = want;
      expected = box.scrollTop;
    };
    setTimeout(() => { done = media.length; }, 2600);
    for (const m of media) {
      const once = () => {
        m.removeEventListener('load', once); m.removeEventListener('error', once);
        m.removeEventListener('loadedmetadata', once); m.removeEventListener('loadeddata', once);
        done++;
        realign();
      };
      m.addEventListener('load', once); m.addEventListener('error', once);
      if (m.tagName === 'VIDEO') { m.addEventListener('loadedmetadata', once); m.addEventListener('loadeddata', once); }
    }
  } catch {}
}
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
    row.querySelector('.when').title = fmtFull(p.created_at);
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
  saveScrollPos();
  S.dmThreadId = id;
  rememberView();
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
  paintSlowmodeHint();
  $('#chan-hash').textContent = t.isGroup ? '' : '@';
  const peer = dmPeer(t);
  $('#chan-name').textContent = t.isGroup ? (t.name || 'Group chat') : ((peer || {}).display_name || 'DM');
  paintDmCallButtons();
  try { clearTyping(); } catch {}
  $('#in-message').placeholder = t.isGroup ? `Message ${t.name || 'group'}` : `Message @${(peer || {}).username || ''}`;
  S.replyTo = null; S.pendingAtts = []; S.editing = null;
  renderComposerMeta();
  // Instant: paint the cached tail (if any) at the remembered anchor so
  // switching back never flashes Loading… or jumps; the fetch below tops up.
  S.histMode = null;
  S.histNew = 0;
  const cachedDm = S.dmMessages.get(id);
  if (cachedDm && cachedDm.length) {
    renderDmMessages();
    restoreScrollPos({ kind: 'dm', id });
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
      renderDmMessages(); // keepDist holds; anchor re-align nails it exactly
      restoreScrollPos({ kind: 'dm', id });
    } else {
      renderDmMessages(true);
      restoreScrollPos({ kind: 'dm', id });
    }
    refreshPinsCount();
    updatePill();
  } catch {
    if (S.dmThreadId !== id) return;
    if (!cachedDm || !cachedDm.length) $('#messages').innerHTML = '<p class="error">Could not load messages.</p>';
  }
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
  try { clearTyping(); } catch {}
  paintDmCallButtons();
  renderTopic();
  renderActiveNow();
}
function renderDmMessages(force = false) {
  const box = $('#messages');
  const msgs = S.dmMessages.get(S.dmThreadId) || [];
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
  else restoreListAnchor(box, anchor, keepDist);
  updatePill();
}
function sendDm(content, opts = {}) {
  if (!S.dmThreadId) return;
  if (S.ws && S.ws.readyState === 1) {
    S.ws.send(JSON.stringify({ t: 'dm', threadId: S.dmThreadId, content, attachments: opts.attachments || [], replyTo: opts.replyTo || null }));
    // Optimistic: echo appends incrementally — just jump to the bottom now
    // (a full render here flashes every avatar in Safari).
    try { const _b = $('#messages'); _b.scrollTop = _b.scrollHeight; updatePill(); } catch {}
  } else toast('Reconnecting… try again in a second');
}
