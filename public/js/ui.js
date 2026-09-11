'use strict';
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
    const { server, invite } = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name }) });
    await refreshServers(server.id);
    S.ws?.send(JSON.stringify({ t: 'subscribe' }));
    showInvite(server, invite);
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
  // Only offer a one-click join when we actually hold a live session (S.me).
  // A stale/expired token alone must fall through to sign in/up — otherwise
  // the join just 401s behind this overlay with no way forward.
  if (store.token && S.me) {
    mkBtn('Join server', true, async () => {
      try {
        const { server } = await api('/api/servers/join', { method: 'POST', body: JSON.stringify({ inviteCode: code }) });
        takeInvite();
        $('#invite-view').classList.add('hidden');
        await refreshServers(server.id);
        S.ws?.send(JSON.stringify({ t: 'subscribe' }));
        toast(`Joined "${server.name}"`);
      } catch (err) {
        if (err.message === 'not_logged_in' || err.message === 'bad_token' || err.message === 'user_gone') {
          store.token = '';
          store.sid = '';
          S.me = null;
          stashInvite(code);
          $('#invite-view').classList.add('hidden');
          showAuth();
          setMode('login');
          toast('Sign in to join this server');
        } else toast('Join failed: ' + prettyError(err.message));
      }
    });
    mkBtn('Cancel', false, () => $('#invite-view').classList.add('hidden'));
  } else {
    mkBtn('Sign in', true, () => { stashInvite(code); $('#invite-view').classList.add('hidden'); setMode('login'); });
    mkBtn('Sign up', false, () => { stashInvite(code); $('#invite-view').classList.add('hidden'); setMode('register'); });
  }
  $('#invite-view').classList.remove('hidden');
}
$('#btn-invite').onclick = () => {
  if (canManage()) { S.serverSubTab = 'invites'; openServerSettings(); }
  else toast('Only admins can create invite links');
};
function showInvite(srv, invite) {
  if (!srv || !invite) return;
  const url = `${location.origin}/invite/${invite.code}`;
  openModal(`Invite to ${srv.name}`, `
    <p class="muted">Share this code or link — anyone with it can join.${invite.label ? ` (${esc(invite.label)})` : ''}</p>
    <div class="codebox">${esc(invite.code)}</div>
    <div class="row"><button class="btn" id="m-copy-code">Copy code</button>
    <button class="btn" id="m-copy-link">Copy link</button></div>
    <div class="chan-group-label" style="padding-left:0">Invite friends directly</div>
    <div id="m-inv-friends"><p class="muted small">Loading friends…</p></div>
    <div class="row" style="margin-top:.5rem"><button class="btn small primary" id="m-inv-send">Send invites</button></div>
  `, 'Done', null);
  $('#m-copy-code').onclick = () => { navigator.clipboard?.writeText(invite.code); toast('Code copied'); };
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
    list.className = 'gmem-list';
    for (const f of picks) list.appendChild(gmemRowEl(f));
    box.appendChild(list);
  })();
  $('#m-inv-send').onclick = async () => {
    const ids = [...document.querySelectorAll('#m-inv-friends input:checked')].map((i) => i.value);
    if (!ids.length) { toast('Pick at least one friend'); return; }
    try {
      const { sent } = await api(`/api/servers/${srv.id}/invite-friends`, { method: 'POST', body: JSON.stringify({ userIds: ids }) });
      toast(sent === 1 ? 'Invite sent' : `${sent} invites sent`);
      document.querySelectorAll('#m-inv-friends input:checked').forEach((i) => { i.checked = false; i.closest('.gmem')?.classList.remove('sel'); });
    } catch (err) { toast('Invite failed: ' + prettyError(err.message)); }
  };
}

// ---------- mobile nav ----------
// ---------- mobile navigation ----------
$('#btn-menu').onclick = () => document.body.classList.toggle('nav-open');
// Mobile nav is a full-screen page, so it carries its own ✕ (the chat header's
// ☰ is behind the page while it is open).
$('#btn-nav-close').onclick = (e) => { e.stopPropagation(); document.body.classList.remove('nav-open'); };
// The nav page's destinations close it (channel and DM rows already do that in
// their own selectors; a server tap deliberately keeps it open so a channel can
// be picked).
$('#left').addEventListener('click', (e) => {
  if (!document.body.classList.contains('nav-open')) return;
  if (e.target.closest && e.target.closest('#btn-home, #btn-friends, #btn-stories')) document.body.classList.remove('nav-open');
});
$('#btn-members').onclick = (e) => { e.stopPropagation(); document.body.classList.toggle('members-open'); };
// Mobile DM header overflow (⋯): voice/video call buttons stay on top; the
// rest open from a bottom sheet. Items mirror the header buttons' own
// enabled state (.hidden), so the sheet never offers anything unavailable.
$('#btn-chat-more').onclick = (e) => {
  e.stopPropagation();
  const defs = [
    ['#btn-find', 'Search chats'],
    ['#btn-notifs', 'Notifications'],
    ['#btn-threads', 'Active threads'],
    ['#btn-pins', 'Pinned messages'],
    ['#btn-members', 'Members'],
  ];
  const items = [];
  for (const [sel, label] of defs) {
    const b = $(sel);
    if (!b || b.classList.contains('hidden')) continue;
    if (sel === '#btn-members' && !document.body.classList.contains('dm-open')) continue;
    items.push({ label, fn: () => b.click() });
  }
  if (!items.length) return;
  openCtxSheet(items, { title: ($('#chan-name') || {}).textContent || 'Chat', sub: 'Chat options' });
};

/* ---------- chat finder: quick-jump to channels, servers, DMs + message text ---------- */
let findSel = 0, findRows = [], findLastQ = '', findMsgSeq = 0, findMsgTimer = null;
function findOpen() { return !$('#find-panel')?.classList.contains('hidden'); }
function openFind() {
  const p = $('#find-panel');
  if (!p) return;
  p.classList.remove('hidden');
  const inp = $('#find-input');
  // Keep your last search so hopping between results doesn't mean retyping.
  inp.value = findLastQ;
  renderFindResults(findLastQ);
  setTimeout(() => { try { inp.focus(); } catch {} }, 0);
  // DM list may be stale/empty if Home was never opened this session —
  // refresh in the background and repaint if the panel is still up.
  try { refreshDms().then(() => { if (findOpen() && !$('#find-input').value) renderFindResults(''); }); } catch {}
}
function closeFind() { $('#find-panel')?.classList.add('hidden'); }
async function findGoChannel(sid, cid, type) {
  if (sid !== S.serverId) await selectServer(sid);
  if (type === 'voice') openVoiceChannel(sid, cid);
  else selectChannel(cid);
}
// Jump to a message search hit in context: navigate to its chat first (if
// needed), then reuse the pin-jump window + highlight.
async function findGoMessage(r) {
  const m = r.message || {};
  if (r.kind === 'dm') {
    if (S.view !== 'home') await openHome();
    if (S.dmThreadId !== m.threadId) await selectDmThread(m.threadId);
    jumpToPin({ kind: 'dm', id: m.threadId }, m.id);
  } else {
    if (m.serverId !== S.serverId) await selectServer(m.serverId);
    if (S.channelId !== m.channelId) await selectChannel(m.channelId);
    jumpToPin({ kind: 'server', id: m.channelId, serverId: m.serverId }, m.id);
  }
}
function runFindMsgSearch(q, box, searching) {
  const my = ++findMsgSeq;
  clearTimeout(findMsgTimer);
  findMsgTimer = setTimeout(async () => {
    let results = [];
    try { ({ results } = await api('/api/search?q=' + encodeURIComponent(q) + '&limit=20')); } catch { results = []; }
    if (my !== findMsgSeq || !findOpen() || !searching.isConnected) return;
    if (($('#find-input')?.value || '').trim() !== q) return; // superseded
    searching.remove();
    if (!results.length) {
      if (!findRows.length) box.innerHTML = '<p class="muted small find-empty">Nothing matches your search.</p>';
      return;
    }
    const secEl = document.createElement('div');
    secEl.className = 'find-sec';
    secEl.textContent = 'MESSAGES';
    box.appendChild(secEl);
    const rowFn = findRowFactory(box);
    for (const r of results) {
      const m = r.message || {};
      const text = m.content ? (m.content.length > 140 ? m.content.slice(0, 140) + '\u2026' : m.content)
        : (m.attachments?.length ? `[${m.attachments.length} attachment${m.attachments.length === 1 ? '' : 's'}]` : '[no text]');
      const who = m.user ? m.user.display_name : 'Someone';
      const where = r.kind === 'dm' ? (r.threadTitle || 'Direct message') : ('#' + (r.channelName || 'chat') + ' \u00B7 ' + (r.serverName || ''));
      rowFn((who || '?').trim().charAt(0).toUpperCase(), text, who + ' \u00B7 ' + where, () => findGoMessage(r));
    }
    paintFindSel();
  }, 250);
}
// Row builder shared by the sync chat sections and the async message
// section (which renders later into the same list).
function findRowFactory(box) {
  return (icon, name, sub, fn) => {
    const idx = findRows.length;
    findRows.push(fn);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'find-row';
    b.dataset.findIdx = idx;
    b.innerHTML = '<span class="find-ic"></span><span class="find-main"><span class="find-name"></span><span class="find-sub"></span></span>';
    b.querySelector('.find-ic').textContent = icon;
    b.querySelector('.find-name').textContent = name;
    b.querySelector('.find-sub').textContent = sub;
    b.onclick = () => activateFind(idx);
    box.appendChild(b);
  };
}
function renderFindResults(q) {
  const box = $('#find-results');
  if (!box) return;
  findRows = [];
  findSel = 0;
  const query = q.trim().toLowerCase();
  const hit = (s) => !query || String(s || '').toLowerCase().includes(query);
  box.innerHTML = '';
  const sec = (t) => { const e = document.createElement('div'); e.className = 'find-sec'; e.textContent = t; box.appendChild(e); };
  const row = findRowFactory(box);
  const cap = (arr) => query ? arr.slice(0, 8) : arr;
  const chans = (S.view === 'server' && S.serverDetail) ? (S.serverDetail.channels || []) : [];
  const texts = cap(chans.filter((c) => c.type === 'text' && (hit(c.name) || hit(c.description))));
  const voices = cap(chans.filter((c) => c.type === 'voice' && hit(c.name)));
  if (texts.length) {
    sec('TEXT CHANNELS');
    for (const c of texts) row('#', '#' + c.name, S.serverDetail.name, () => findGoChannel(S.serverId, c.id, 'text'));
  }
  if (voices.length) {
    sec('VOICE ROOMS');
    for (const c of voices) row('\u266A', c.name, S.serverDetail.name, () => findGoChannel(S.serverId, c.id, 'voice'));
  }
  const srvHits = cap((S.servers || []).filter((s) => hit(s.name)));
  if (srvHits.length) {
    sec('SERVERS');
    for (const s of srvHits) row((s.name || '?').trim().charAt(0).toUpperCase(), s.name, 'Server', () => selectServer(s.id));
  }
  const dmHits = cap((S.dms || []).filter((t) => hit(dmTitle(t)) || hit((dmPeer(t) || {}).username)));
  if (dmHits.length) {
    sec('DIRECT MESSAGES');
    for (const t of dmHits) {
      const peer = t.isGroup ? null : dmPeer(t);
      row(t.isGroup ? '#' : '@', dmTitle(t), t.isGroup ? `Group · ${(t.members || []).length} members` : '@' + ((peer || {}).username || ''),
        async () => { if (S.view !== 'home') await openHome(); await selectDmThread(t.id); });
    }
  }
  if (!findRows.length && query.length < 2) box.innerHTML = '<p class="muted small find-empty">No chats match.</p>';
  paintFindSel();
  // Message text searches the server (debounced) once the query is long
  // enough to be selective. Renders into this same list when it lands.
  if (query.length >= 2) {
    const searching = document.createElement('p');
    searching.className = 'muted small find-empty';
    searching.textContent = 'Searching messages…';
    box.appendChild(searching);
    runFindMsgSearch(q.trim(), box, searching);
  }
}
function paintFindSel() {
  document.querySelectorAll('#find-results .find-row').forEach((el) => {
    el.classList.toggle('sel', Number(el.dataset.findIdx) === findSel);
  });
  try { document.querySelector('#find-results .find-row.sel')?.scrollIntoView({ block: 'nearest' }); } catch {}
}
async function activateFind(idx) {
  const fn = findRows[idx];
  // Docked tab: stay open on desktop so you can hop between results
  // without re-searching. Overlay mode (narrow screens) covers the chat,
  // so dismiss there after jumping.
  if (matchMedia('(max-width: 1100px)').matches) closeFind();
  if (fn) { try { await fn(); } catch (err) { toast('Could not open chat'); } }
}
$('#find-close').onclick = () => closeFind();
$('#btn-find').onclick = (e) => { e.stopPropagation(); findOpen() ? closeFind() : openFind(); };
$('#find-input').addEventListener('input', (e) => { findLastQ = e.target.value; renderFindResults(e.target.value); });
$('#find-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); if (findRows.length) { findSel = (findSel + 1) % findRows.length; paintFindSel(); } }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (findRows.length) { findSel = (findSel - 1 + findRows.length) % findRows.length; paintFindSel(); } }
  else if (e.key === 'Enter') { e.preventDefault(); activateFind(findSel); }
  else if (e.key === 'Escape') { closeFind(); }
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); findOpen() ? closeFind() : openFind(); }
});

// channel sidebar resize (drag right edge, clamped + remembered)
const SIDEBAR_W_MIN = 200, SIDEBAR_W_MAX = 400;
const sidebarWMax = () => Math.max(SIDEBAR_W_MIN + 40, Math.min(SIDEBAR_W_MAX, Math.floor(innerWidth * 0.55)));
const clampSidebarW = (w) => Math.min(sidebarWMax(), Math.max(SIDEBAR_W_MIN, Math.round(w)));
try {
  if (!matchMedia('(max-width: 700px)').matches) {
    const w = parseInt(localStorage.getItem('cf_sidebar_w') || '', 10);
    if (w >= SIDEBAR_W_MIN) $('#sidebar').style.width = clampSidebarW(w) + 'px';
  }
} catch {}
$('#sidebar-resizer').addEventListener('pointerdown', (e) => {
  if (matchMedia('(max-width: 700px)').matches) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  const bar = $('#sidebar');
  const rz = e.currentTarget;
  const startX = e.clientX, startW = bar.getBoundingClientRect().width;
  document.body.classList.add('sidebar-resizing');
  try { rz.setPointerCapture(e.pointerId); } catch {}
  const move = (ev) => { bar.style.width = clampSidebarW(startW + (ev.clientX - startX)) + 'px'; };
  const done = (ev) => {
    bar.style.width = clampSidebarW(startW + (ev.clientX - startX)) + 'px';
    try { localStorage.setItem('cf_sidebar_w', bar.style.width.replace('px', '')); } catch {}
    document.body.classList.remove('sidebar-resizing');
    rz.removeEventListener('pointermove', move);
    rz.removeEventListener('pointerup', done);
    rz.removeEventListener('pointercancel', done);
  };
  rz.addEventListener('pointermove', move);
  rz.addEventListener('pointerup', done);
  rz.addEventListener('pointercancel', done);
});
