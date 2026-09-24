'use strict';
// ---------- modals (in-app dialogs — no native alert/confirm/prompt) ----------
let modalOkFn = null;
let modalCancelFn = null;
// Is a floating person popover on screen? These are the two layers that sit
// ABOVE the dialog layer by the contract in styles.css (#usercard 170 /
// #tagcard 171 vs #modal-backdrop 160).
function popoverOpen() {
  return ['#usercard', '#tagcard'].some((sel) => { const el = $(sel); return el && !el.classList.contains('hidden'); });
}
function openModal(title, bodyHTML, okLabel, onOk, opts = {}) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHTML;
  const ok = $('#modal-ok');
  ok.textContent = okLabel || 'OK';
  ok.classList.toggle('danger', !!opts.danger);
  ok.classList.toggle('primary', !opts.danger);
  $('#modal-close').textContent = opts.cancelLabel || 'Cancel';
  // A read-only popout has ONE way out. `hideCancel` is the older half of that
  // rule (a lone "Close"); `xClose` is the whole thing — the footer goes away
  // and a ✕ sits in the panel's corner, because a Cancel and a Close that both
  // dismiss the panel are two buttons saying the same nothing.
  $('#modal-close').style.display = opts.hideCancel ? 'none' : '';
  modalOkFn = onOk || null;
  modalCancelFn = opts.onCancel || null;
  document.querySelector('#modal-backdrop .modal').classList.toggle('wide', !!opts.wide);
  document.querySelector('#modal-backdrop .modal').classList.toggle('x-only', !!opts.xClose);
  // A dialog opened FROM an open person popover has to be painted ABOVE it, so
  // that one gets .over-pop (the rule is beside the layer contract in
  // styles.css). The static order keeps cards over the dialog layer because
  // dialogs contain people rows, so the other direction is decided here, per
  // open, from what is on screen right now. Without it "Set a status" on your
  // own card opened its editor behind the card — which on a phone is a
  // full-height sheet, so the editor was simply not there. Decided on every
  // open (not just when set) so no dialog can inherit the class from a previous
  // one; left in place on close, because the click that closes the dialog is
  // still the card's own (see final.js).
  $('#modal-backdrop').classList.toggle('over-pop', popoverOpen());
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
$('#modal-x').onclick = () => cancelModal();
$('#modal-backdrop').addEventListener('click', (e) => {
  if (e.target.id !== 'modal-backdrop') return;
  // A person card floats ABOVE the dialog layer (see the layer contract in
  // styles.css), so a click on the backdrop is usually aimed at the card: the
  // card's own closer (final.js) takes that click, and the panel underneath
  // stays put. Dismiss the panel only when nothing is floating over it — and
  // the exception is the dialog that floats over a card itself (.over-pop): its
  // backdrop is genuinely its own, so the click closes it and leaves the card
  // (the card's closer reads the same class and stands down), which is what
  // makes tapping past the status editor land you back on your card.
  if (!$('#modal-backdrop').classList.contains('over-pop') && popoverOpen()) return;
  cancelModal();
});
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
  // The tab title is the one piece of the preview a browser can still get wrong:
  // /invite/:code is served with the server's name in its OpenGraph tags, and a
  // client-side route change (or a crawler that runs JS) repaints them here, so
  // the preview and the page always name the same thing.
  try {
    const nm = info.name || 'Server';
    document.title = nm + ' · Campfire';
    let ogi = document.querySelector('meta[property="og:image"]');
    if (!ogi) { ogi = document.createElement('meta'); ogi.setAttribute('property', 'og:image'); document.head.appendChild(ogi); }
    if (info.icon_url || info.banner_url) ogi.setAttribute('content', info.icon_url || info.banner_url);
  } catch {}
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
$('#btn-menu').onclick = () => {
  document.body.classList.toggle('nav-open');
  // The drawer covers the conversation: a bar painted while reading must not
  // linger over the channel list.
  if (document.body.classList.contains('nav-open')) unreadBarHide();
};
// Mobile nav is a full-screen page, so it carries its own ✕ (the chat header's
// ☰ is behind the page while it is open).
$('#btn-nav-close').onclick = (e) => { e.stopPropagation(); document.body.classList.remove('nav-open'); };
// The nav page's destinations close it (channel and DM rows already do that in
// their own selectors; Friends and Stories close it too). The campfire Home
// button deliberately KEEPS it open: Home just swaps the chat list over to the
// home lists (Friends / Stories / DMs), so the page has to stay up for a
// conversation to be picked out of it — closing it there dropped the reader
// into whatever conversation was open behind the page.
$('#left').addEventListener('click', (e) => {
  if (!document.body.classList.contains('nav-open')) return;
  if (e.target.closest && e.target.closest('#btn-friends, #btn-stories')) document.body.classList.remove('nav-open');
});
/* ---------- the members bar: a drawer on a phone, a column on a desktop ----------
   One control, two meanings, and the LAYOUT picks which (membersDrawerLayout,
   core.js — the same condition as the stylesheet's members block). In drawer
   shape the button opens and closes an overlay; in column shape the panel is
   part of the shell, so the same button collapses it out of the layout and
   brings it back.

   The two states are deliberately kept apart: the drawer's open/close is
   transient (nothing about it survives a reload, and crossing the breakpoint
   drops it), while a desktop collapse is a preference a reader who wants the
   width back should keep. */
const MEMBERS_PREF = 'cf_members_collapsed';
const membersCollapsedPref = () => { try { return localStorage.getItem(MEMBERS_PREF) === '1'; } catch { return false; } };
// The button's own state is painted from the panel it controls, never from the
// click that toggled it, so the phone's ⋯ sheet (which just calls b.click()) and
// a restored preference can never disagree with what is on screen.
function paintMembersToggle() {
  const b = $('#btn-members');
  if (!b) return;
  const open = membersDrawerLayout()
    ? document.body.classList.contains('members-open')
    : !document.body.classList.contains('members-collapsed');
  b.setAttribute('aria-expanded', open ? 'true' : 'false');
  b.title = open ? 'Hide members' : 'Show members';
}
// The collapsed class is only ever applied in the static-column shape: in the
// drawer shape the panel is off-screen on its own terms, and a remembered
// collapse must not follow the reader onto a phone.
function applyMembersBar() {
  document.body.classList.toggle('members-collapsed', !membersDrawerLayout() && membersCollapsedPref());
  paintMembersToggle();
}
function setMembersCollapsed(v) {
  try { v ? localStorage.setItem(MEMBERS_PREF, '1') : localStorage.removeItem(MEMBERS_PREF); } catch {}
  applyMembersBar();
}
$('#btn-members').onclick = (e) => {
  e.stopPropagation();
  if (membersDrawerLayout()) { document.body.classList.toggle('members-open'); paintMembersToggle(); return; }
  setMembersCollapsed(!document.body.classList.contains('members-collapsed'));
};
applyMembersBar();
// Crossing the breakpoint by resizing hands the panel back in the new shape:
// the drawer's transient flag is dropped for the column, and the remembered
// collapse is re-applied (or shelved) without ever being forgotten.
if (window.matchMedia) {
  const membersMQ = matchMedia(MEMBERS_MQ);
  const onMembersLayout = () => {
    if (!membersDrawerLayout()) document.body.classList.remove('members-open');
    applyMembersBar();
  };
  if (membersMQ.addEventListener) membersMQ.addEventListener('change', onMembersLayout);
  else if (membersMQ.addListener) membersMQ.addListener(onMembersLayout);
}
// Mobile header overflow (⋯): the phone header hides its secondary rails behind
// this sheet (see styles.css), so the sheet lists exactly what is available:
// a `.hidden` class means the app switched that control off (pins with nothing
// pinned, threads in a DM), and Members is only offered where the drawer has
// something in it — a conversation (a DM/group, or a server channel). Home's
// feed keeps the Active Now strip instead and hides that button outright.
// The rows read in the HEADER's own rail order (index.html): the controls that
// come and go with the conversation first, then the fixed ones — search, pins,
// inbox, members — so a phone and a desktop never disagree about where a
// familiar control lives. scripts/test-header-rails.js pins it.
$('#btn-chat-more').onclick = (e) => {
  e.stopPropagation();
  const defs = [
    ['#btn-threads', 'Active threads'],
    ['#btn-find', 'Search chats'],
    ['#btn-pins', 'Pinned messages'],
    ['#btn-notifs', 'Inbox'],
    ['#btn-members', 'Members'],
  ];
  const homeFeed = document.body.classList.contains('view-home') && !document.body.classList.contains('dm-open');
  // A control's own badge rides into the sheet, or hiding the button would hide
  // "3 unread notifications" / "2 new pins" with it.
  const badgeOf = (sel) => {
    const b = $(sel);
    if (!b || b.classList.contains('hidden')) return '';
    return (b.textContent || '').trim();
  };
  const items = [];
  for (const [sel, label] of defs) {
    const b = $(sel);
    if (!b || b.classList.contains('hidden')) continue;
    if (sel === '#btn-members' && homeFeed) continue;
    const n = sel === '#btn-notifs' ? badgeOf('#notifs-count') : (sel === '#btn-pins' ? badgeOf('#pins-count') : '');
    items.push({ label: n ? `${label} · ${n}${sel === '#btn-pins' ? ' new' : ''}` : label, fn: () => b.click() });
  }
  if (!items.length) return;
  openCtxSheet(items, { title: ($('#chan-name') || {}).textContent || 'Chat', sub: 'Chat options' });
};
// A 1:1 DM's name (and its @) opens that person's card — on a phone as the
// full-height sheet that slides up from the bottom, the same surface the me bar
// uses (openUserCard with a sheet: see openOwnCard). Groups have no single peer
// and a server channel has no card at all, so the name stays inert there; that
// is what paintHeaderNameTap() marks on the header.
$('#chat-header').addEventListener('click', (e) => {
  if (!e.target.closest || !e.target.closest('#chan-name, #chan-hash')) return;
  if (!document.body.classList.contains('dm-open')) return;
  const t = (S.dms || []).find((x) => x.id === S.dmThreadId);
  const peer = t && !t.isGroup ? dmPeer(t) : null;
  if (!peer) return;
  const card = $('#usercard');
  if (!card.classList.contains('hidden') && card.dataset.uid === peer.id) { closeUserCard(); return; }
  const r = (e.target.closest('#chan-hash') || e.target.closest('#chan-name')).getBoundingClientRect();
  openUserCard(peer.id, r.left, r.bottom + 6, peer, { sheet: phoneLayout() });
});

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
function closeFind() { $('#find-panel')?.classList.add('hidden'); hideFindSuggest(); }
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
// Discord-style operators: from:user, in:#channel, has:image|video|file|link,
// before:YYYY-MM-DD, after:YYYY-MM-DD. Each narrows the message search;
// whatever else is in the box is the text query. The rest of the panel
// (channels, servers, DMs) always matches the text part alone.
function parseFindQuery(raw) {
  const src = String(raw || '');
  const out = { text: '', from: '', in: '', has: '', before: '', after: '' };
  let rest = src;
  // Extract each operator: (start|space)op:"quoted"|value, closing the slot up.
  const opRe = /(^|\s)(from|in|has|before|after):("[^"]*"|\S+)/gi;
  let m;
  while ((m = opRe.exec(rest))) {
    const op = m[2].toLowerCase();
    const val = m[3].replace(/^"|"$/g, '').trim();
    if (op === 'from' && !out.from) out.from = val;
    else if (op === 'in' && !out.in) out.in = val;
    else if (op === 'has' && !out.has) out.has = val.toLowerCase();
    else if (op === 'before' && !out.before) out.before = val;
    else if (op === 'after' && !out.after) out.after = val;
    rest = (rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length)).replace(/\s+/g, ' ');
    opRe.lastIndex = 0; // the string changed; rescan from the start
  }
  out.text = rest.trim();
  return out;
}
function runFindMsgSearch(raw, box, searching) {
  const my = ++findMsgSeq;
  clearTimeout(findMsgTimer);
  findMsgTimer = setTimeout(async () => {
    const { text, from, in: inCh, has, before, after } = parseFindQuery(raw);
    let results = [], fromInfo = null;
    try {
      const r = await api('/api/search?limit=20'
        + (text ? '&q=' + encodeURIComponent(text) : '')
        + (from ? '&from=' + encodeURIComponent(from) : '')
        + (inCh ? '&in=' + encodeURIComponent(inCh) : '')
        + (has ? '&has=' + encodeURIComponent(has) : '')
        + (before ? '&before=' + encodeURIComponent(before) : '')
        + (after ? '&after=' + encodeURIComponent(after) : ''));
      results = r.results || [];
      fromInfo = r.from || null;
    } catch { results = []; }
    if (my !== findMsgSeq || !findOpen() || !searching.isConnected) return;
    if (($('#find-input')?.value || '').trim() !== raw) return; // superseded
    searching.remove();
    if (!results.length) {
      // Nothing to show is two different answers: nobody by that name, or that
      // person has nothing matching.
      if (from && fromInfo && !fromInfo.users) box.innerHTML = '<p class="muted small find-empty">No one matches from:' + esc(from) + '.</p>';
      else if (!findRows.length) box.innerHTML = '<p class="muted small find-empty">Nothing matches your search.</p>';
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
      // A deleted account keeps its messages (the chat shows them too), so name
      // the state instead of inventing a person called "Someone".
      const who = m.user ? m.user.display_name : 'Deleted user';
      const where = r.kind === 'dm' ? (r.threadTitle || 'Direct message') : ('#' + (r.channelName || 'chat') + ' \u00B7 ' + (r.serverName || ''));
      const ago = fmtAgo(m.created_at);
      rowFn((who || '?').trim().charAt(0).toUpperCase(), text, who + ' \u00B7 ' + where + (ago ? ' \u00B7 ' + ago : ''), () => findGoMessage(r), fmtFull(m.created_at));
    }
    paintFindSel();
  }, 250);
}
// Row builder shared by the sync chat sections and the async message
// section (which renders later into the same list).
function findRowFactory(box) {
  return (icon, name, sub, fn, title) => {
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
    if (title) b.title = title;
    b.onclick = () => activateFind(idx);
    box.appendChild(b);
  };
}
function renderFindResults(q) {
  const box = $('#find-results');
  if (!box) return;
  findRows = [];
  findSel = 0;
  const { text: qText, from: qFrom, in: qIn, has: qHas, before: qBefore, after: qAfter } = parseFindQuery(q);
  const qFilter = qFrom || qIn || qHas || qBefore || qAfter;
  const query = qText.trim().toLowerCase();
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
  if (!findRows.length && query.length < 2 && !qFilter) box.innerHTML = '<p class="muted small find-empty">No chats match.</p>';
  paintFindSel();
  // Message text searches the server (debounced) once the query is long
  // enough to be selective — or straight away when an author was named, since
  // `from:ada` on its own is a real search. Renders into this same list.
  if (query.length >= 2 || qFilter) {
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
// Discord-style filter autocomplete: typing `from:`, `in:`, or `has:` pops a
// suggestion list; picking one completes the filter value.
let fsSel = 0, fsRows = [];
function findSuggestOp() {
  const inp = $('#find-input');
  if (!inp) return null;
  const pos = inp.selectionStart ?? inp.value.length;
  const before = inp.value.slice(0, pos);
  const m = /(^|\s)(from|in|has|before|after):("[^"]*"?|\S*)$/i.exec(before);
  if (!m) return null;
  return { op: m[2].toLowerCase(), partial: m[3].replace(/^"|"$/g, ''), start: pos - m[0].length + (m[1] ? 1 : 0), full: m[0] };
}
function renderFindSuggest() {
  const box = $('#find-suggest');
  if (!box) return;
  const ctx = findSuggestOp();
  fsRows = []; fsSel = 0;
  if (!ctx || (ctx.op !== 'from' && ctx.op !== 'in' && ctx.op !== 'has')) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const q = ctx.partial.toLowerCase();
  const hit = (s) => !q || String(s || '').toLowerCase().includes(q);
  const rows = [];
  if (ctx.op === 'from') {
    // Users: server members first, then DM peers.
    const seen = new Set();
    const members = (S.view === 'server' && S.serverDetail) ? (S.serverDetail.members || []) : [];
    for (const m of members) {
      const u = m.user || m;
      if (!u || seen.has(u.id)) continue;
      if (hit(u.display_name) || hit(u.username)) { seen.add(u.id); rows.push({ icon: (u.display_name || '?')[0].toUpperCase(), name: u.display_name || u.username, sub: '@' + (u.username || ''), val: u.username || u.display_name }); }
      if (rows.length >= 8) break;
    }
  } else if (ctx.op === 'in') {
    const chans = (S.view === 'server' && S.serverDetail) ? (S.serverDetail.channels || []) : [];
    for (const c of chans) {
      if (c.type !== 'text') continue;
      if (hit(c.name)) rows.push({ icon: '#', name: '#' + c.name, sub: S.serverDetail.name, val: c.name });
      if (rows.length >= 8) break;
    }
  } else if (ctx.op === 'has') {
    for (const [v, d] of [['image', 'Photos and GIFs'], ['video', 'Video clips'], ['file', 'Any attachment'], ['link', 'Links in the text']]) {
      if (hit(v)) rows.push({ icon: '◈', name: v, sub: d, val: v });
    }
  }
  if (!rows.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.innerHTML = '';
  const sec = document.createElement('div');
  sec.className = 'fs-sec';
  sec.textContent = ctx.op === 'from' ? 'FROM' : ctx.op === 'in' ? 'IN CHANNEL' : 'HAS';
  box.appendChild(sec);
  rows.forEach((r, i) => {
    fsRows.push(r);
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'fs-row'; b.dataset.fsIdx = i;
    b.innerHTML = '<span class="fs-ic"></span><span class="fs-main"><span class="fs-name"></span><span class="fs-sub"></span></span>';
    b.querySelector('.fs-ic').textContent = r.icon;
    b.querySelector('.fs-name').textContent = r.name;
    b.querySelector('.fs-sub').textContent = r.sub;
    b.onclick = () => applyFindSuggest(i);
    box.appendChild(b);
  });
  box.classList.remove('hidden');
  paintFindSuggestSel();
}
function paintFindSuggestSel() {
  document.querySelectorAll('#find-suggest .fs-row').forEach((el) => {
    el.classList.toggle('sel', Number(el.dataset.fsIdx) === fsSel);
  });
}
function applyFindSuggest(idx) {
  const r = fsRows[idx];
  const inp = $('#find-input');
  const ctx = findSuggestOp();
  if (!r || !inp || !ctx) return;
  const pos = inp.selectionStart ?? inp.value.length;
  // Quote values with spaces so the parser keeps them as one token.
  const val = /\s/.test(r.val) ? `"${r.val}"` : r.val;
  const before = inp.value.slice(0, ctx.start) + ctx.op + ':' + val + ' ';
  inp.value = before + inp.value.slice(pos);
  inp.selectionStart = inp.selectionEnd = before.length;
  findLastQ = inp.value;
  renderFindResults(inp.value);
  renderFindSuggest();
  inp.focus();
}
function hideFindSuggest() { const b = $('#find-suggest'); if (b) { b.classList.add('hidden'); b.innerHTML = ''; } fsRows = []; }
$('#find-input').addEventListener('input', (e) => { findLastQ = e.target.value; renderFindResults(e.target.value); renderFindSuggest(); });
$('#find-input').addEventListener('keydown', (e) => {
  // Filter suggestions take arrow keys / Enter / Tab / Escape first.
  if (fsRows.length && !$('#find-suggest').classList.contains('hidden')) {
    if (e.key === 'ArrowDown') { e.preventDefault(); fsSel = (fsSel + 1) % fsRows.length; paintFindSuggestSel(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); fsSel = (fsSel - 1 + fsRows.length) % fsRows.length; paintFindSuggestSel(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyFindSuggest(fsSel); return; }
    if (e.key === 'Escape') { e.preventDefault(); hideFindSuggest(); return; }
  }
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
  if (!phoneLayout()) {
    const w = parseInt(localStorage.getItem('cf_sidebar_w') || '', 10);
    if (w >= SIDEBAR_W_MIN) $('#sidebar').style.width = clampSidebarW(w) + 'px';
  }
} catch {}
$('#sidebar-resizer').addEventListener('pointerdown', (e) => {
  if (phoneLayout()) return;
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
