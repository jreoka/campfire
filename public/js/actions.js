'use strict';
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
    { label: 'Reply', icon: '↩', fn: () => replyToMsg(m) },
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
  const em = S.emojiAll[e.slice(1, -1)];
  return (e.startsWith(':') && e.endsWith(':') && em)
    ? `<img class="cemoi" src="${em.url}" alt="${esc(e)}">` : esc(e);
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
  closePicker();
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
/* generic slide-up bottom sheet for right-click-style menus (mobile long-press) */
function closeCtxSheet() {
  document.querySelector('#sheet-backdrop')?.remove();
  document.querySelector('#sheet')?.remove();
}
function openServerSheet(sid) {
  const s = S.servers.find((v) => v.id === sid);
  if (!s) return;
  openCtxSheet(serverMenuItems(sid), { title: s.name, sub: '', serverUser: { display_name: s.name, avatar_color: '#5865f2', avatar_url: s.icon_url || null } });
}
function openChannelSheet(cid, ctype) {
  const c = S.serverDetail?.channels.find((v) => v.id === cid);
  if (!c) return;
  openCtxSheet(channelMenuItems(cid, ctype), { title: c.name, sub: ctype === 'voice' ? 'Voice channel' : 'Text channel', glyph: ctype === 'voice' ? '♪' : '#', color: 'var(--panel-3)' });
}
function openFolderSheet(fid) {
  const f = folderById(fid);
  if (!f) return;
  openCtxSheet(folderSheetItems(fid), { title: f.name || 'Folder', sub: (f.servers || []).length + ' server' + ((f.servers || []).length === 1 ? '' : 's'), glyph: (f.name || 'F').trim().charAt(0).toUpperCase(), color: f.color || '#5865f2' });
}
function openCtxSheet(items, head) {
  if (!items || !items.length) return;
  closeCtx();
  closePicker();
  closeMsgSheet(true);
  closeCtxSheet();
  const bd = document.createElement('div');
  bd.id = 'sheet-backdrop';
  bd.onclick = () => closeCtxSheet();
  const sh = document.createElement('div');
  sh.id = 'sheet';
  sh.setAttribute('role', 'dialog');
  sh.innerHTML = '<div class="sheet-handle"></div>';
  if (head && (head.title || head.sub)) {
    const h = document.createElement('div');
    h.className = 'sheet-head';
    h.innerHTML = '<span class="avatar"></span><div style="min-width:0;flex:1"><div class="sheet-who"></div><div class="sheet-snip"></div></div>';
    const av = h.querySelector('.avatar');
    if (head.serverUser) paintAvatar(av, head.serverUser);
    else if (head.avatarEl) av.appendChild(head.avatarEl);
    else { av.textContent = head.glyph || (head.title ? head.title.trim().charAt(0).toUpperCase() : '?'); av.style.background = head.color || 'var(--panel-3)'; }
    h.querySelector('.sheet-who').textContent = head.title || '';
    h.querySelector('.sheet-snip').textContent = head.sub || '';
    sh.appendChild(h);
  }
  const rows = document.createElement('div');
  rows.className = 'sheet-rows';
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'sheet-sep'; rows.appendChild(s); continue; }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sheet-row' + (it.danger ? ' danger' : '');
    b.innerHTML = `<span class="ctx-ic">${it.icon || ''}</span>`;
    const lb = document.createElement('span');
    lb.textContent = it.label;
    b.appendChild(lb);
    b.onclick = () => { closeCtxSheet(); it.fn && it.fn(); };
    rows.appendChild(b);
  }
  sh.appendChild(rows);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'sheet-cancel';
  cancel.textContent = 'Cancel';
  cancel.onclick = () => closeCtxSheet();
  sh.appendChild(cancel);
  document.body.appendChild(bd);
  document.body.appendChild(sh);
  requestAnimationFrame(() => requestAnimationFrame(() => { bd.classList.add('open'); sh.classList.add('open'); }));
}
function folderSheetItems(fid) {
  const f = folderById(fid); if (!f) return [];
  return [
    { label: S.openFolderId === fid ? 'Collapse folder' : 'Expand folder', icon: S.openFolderId === fid ? '▴' : '▾', fn: () => toggleFolder(fid) },
    { label: 'Rename folder', icon: '✎', fn: () => renameFolder(fid) },
    { label: 'Delete folder', icon: '🗑', danger: true, fn: () => deleteFolder(fid) },
  ];
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
    { label: 'View profile', icon: '👤', fn: () => openMemberCard(uid, null, y) },
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
function folderMoveItems(sid) {
  const current = serverFolder(sid);
  const items = [{ label: 'New folder', icon: '＋', fn: () => createFolderFromServers([sid]) }];
  if (current) items.push({ label: 'Remove from folder', icon: '↩', fn: () => removeServerFromFolder(sid) });
  const others = S.layoutFolders.filter((f) => f.id !== (current && current.id));
  if (others.length) {
    items.push({ sep: true });
    for (const f of others) items.push({ label: 'Move to ' + (f.name || 'Folder'), icon: '▸', fn: () => moveServerToFolder(sid, f.id) });
  }
  return items;
}
function serverMenuItems(sid) {
  const s = S.servers.find((v) => v.id === sid);
  if (!s) return [];
  const own = notifPrefsCache['s:' + sid] || '';
  return [
    { label: 'Open', icon: '→', fn: () => selectServer(sid) },
    { label: 'Invite links', icon: '⧉', fn: async () => { if (sid !== S.serverId) await selectServer(sid); S.serverSubTab = 'general'; openServerSettings(); } },
    { label: 'Server settings', icon: '⚙', fn: async () => { if (sid !== S.serverId) await selectServer(sid); openServerSettings(); } },
    { sep: true },
    ...folderMoveItems(sid),
    { sep: true },
    muteToggleItem(serverMuted(sid), own === 'muted', 'server', 's:' + sid),
    { label: 'Notification settings', icon: BELL_SVG, fn: () => openServerNotifSettings(sid) },
  ];
}
function serverCtxMenu(sid, x, y) { openCtx(x, y, serverMenuItems(sid)); }
function channelMenuItems(cid, ctype) {
  const c = S.serverDetail?.channels.find((v) => v.id === cid);
  if (!c) return [];
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
  return items;
}
function channelCtxMenu(cid, ctype, x, y) { openCtx(x, y, channelMenuItems(cid, ctype)); }
function ctxFor(el, x, y) {
  if (!el || !el.closest) return false;
  const msg = el.closest('.msg[data-mid]');
  if (msg) { messageCtxMenu(msg.dataset.mid, x, y); return true; }
  const vu = el.closest('.vuser[data-uid]');
  if (vu && vu.dataset.uid) { openUserCard(vu.dataset.uid, x, y); return true; }
  const mem = el.closest('.member[data-uid]');
  if (mem && mem.dataset.uid) { memberCtxMenu(mem.dataset.uid, x, y); return true; }
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
  // On touch-primary devices the long-press is owned by the bottom-sheet/popup
  // handler below. Suppress the native menu AND the desktop-style popup here so
  // they don't both appear alongside the slide-up sheet. Desktop right-click
  // keeps the ctxFor popup.
  if (isCoarse()) { e.preventDefault(); return; }
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
  const t = e.target.closest('.msg,.chan,.member,.server-btn,.folder-btn,.vuser,[data-dmthread]');
  if (!t) return;
  const touch = e.touches[0];
  const x = touch.clientX, y = touch.clientY;
  holdX = x; holdY = y;
  holdMenu = false;
  holdT = setTimeout(() => {
    holdT = null;
    try { navigator.vibrate && navigator.vibrate(10); } catch {}
    const mt = t.closest('.msg[data-mid]');
    if (mt && isCoarse()) { holdSheet = true; openMsgSheet(mt.dataset.mid); return; }
    const ch = t.closest('.chan[data-cid]');
    if (ch && isCoarse()) { holdSheet = true; openChannelSheet(ch.dataset.cid, ch.dataset.ctype); return; }
    const sb = t.closest('.server-btn[data-sid]');
    if (sb && isCoarse()) { holdSheet = true; openServerSheet(sb.dataset.sid); return; }
    const fb = t.closest('.folder-btn[data-fid]');
    if (fb && isCoarse()) { holdSheet = true; openFolderSheet(fb.dataset.fid); return; }
    if (ctxFor(t, x, y)) holdMenu = true;
  }, 550);
}, { passive: true });
['touchend', 'touchcancel'].forEach((ev) => document.addEventListener(ev, () => { clearTimeout(holdT); holdT = null; }, { passive: true }));
// touchmove only cancels a hold on a real move (finger jitter is normal)
document.addEventListener('touchmove', (e) => {
  const t = e.touches && e.touches[0];
  if (t && Math.hypot(t.clientX - holdX, t.clientY - holdY) > 12) { clearTimeout(holdT); holdT = null; }
}, { passive: true });

