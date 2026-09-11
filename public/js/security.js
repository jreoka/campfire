'use strict';
// ---------- security: 2FA, passkeys, sessions + notification inbox ----------
function deviceName() {
  try {
    const ud = navigator.userAgentData;
    if (ud?.platform) return `${ud.platform} ${(ud.brands || []).map((b) => b.brand)[0] || ''}`.trim().slice(0, 32);
  } catch {}
  return '';
}
function b64ToBuf(s) {
  const bin = atob(String(s || '').replace(/-/g, '+').replace(/_/g, '/'));
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}
function bufToB64(buf) {
  const u = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pkToJson(cred) {
  const o = { id: cred.id, rawId: bufToB64(cred.rawId), type: cred.type, response: {} };
  for (const k of ['clientDataJSON', 'attestationObject', 'authenticatorData', 'signature', 'userHandle']) {
    if (cred.response[k]) o.response[k] = bufToB64(cred.response[k]);
  }
  return o;
}
function pkFromJson(opts) {
  const o = { ...opts, challenge: b64ToBuf(opts.challenge) };
  if (o.user && o.user.id) o.user = { ...o.user, id: b64ToBuf(o.user.id) };
  if (o.allowCredentials) o.allowCredentials = o.allowCredentials.map((c) => ({ ...c, id: b64ToBuf(c.id) }));
  if (o.excludeCredentials) o.excludeCredentials = o.excludeCredentials.map((c) => ({ ...c, id: b64ToBuf(c.id) }));
  return o;
}
function webauthnSupported() { return !!(navigator.credentials && window.PublicKeyCredential); }
let pending2faTmp = null;
function show2faStep() {
  $('#form-auth').classList.add('hidden');
  $('#btn-passkey').classList.add('hidden');
  $('#auth-tabs').classList.add('hidden');
  $('#form-2fa').classList.remove('hidden');
  $('#in-2fa').value = '';
  $('#auth-2fa-error').classList.add('hidden');
  setTimeout(() => { try { $('#in-2fa').focus(); } catch {} }, 50);
}
function hide2faStep() {
  $('#form-2fa').classList.add('hidden');
  $('#form-auth').classList.remove('hidden');
  $('#btn-passkey').classList.remove('hidden');
  $('#auth-tabs').classList.remove('hidden');
  pending2faTmp = null;
}
$('#btn-2fa-back').onclick = hide2faStep;
$('#form-2fa').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('#in-2fa').value.trim();
  if (!code || !pending2faTmp) return;
  try {
    const data = await api('/api/login/2fa', { method: 'POST', body: JSON.stringify({ tmp: pending2faTmp, code }) });
    store.token = data.token;
    if (data.sid) store.sid = data.sid;
    hide2faStep();
    await boot();
  } catch (err) {
    const el = $('#auth-2fa-error');
    el.textContent = '⚠️ ' + prettyError(err.message);
    el.classList.remove('hidden');
  }
});
$('#btn-passkey').onclick = async () => {
  if (!webauthnSupported()) { toast('Passkeys are not supported in this browser'); return; }
  try {
    const username = $('#in-username').value.trim().toLowerCase() || undefined;
    const { stateId, options } = await api('/api/passkeys/login/options', { method: 'POST', body: JSON.stringify({ username }) });
    const cred = await navigator.credentials.get({ publicKey: pkFromJson(options) });
    const data = await api('/api/passkeys/login/verify', { method: 'POST', body: JSON.stringify({ stateId, authResp: pkToJson(cred), device: deviceName() }) });
    store.token = data.token;
    if (data.sid) store.sid = data.sid;
    await boot();
  } catch (err) { toast(prettyError(err.message)); }
};
async function renderSecurityTab() {
  if (!S.me) return;
  render2faBox(); renderPasskeyBox(); renderSessionBox();
}
async function render2faBox() {
  const box = $('#set-2fa');
  if (!box) return;
  let enabled = false;
  try { ({ enabled } = await api('/api/2fa/status')); } catch { box.innerHTML = '<p class="muted small">Unavailable.</p>'; return; }
  box.innerHTML = '';
  if (!enabled) {
    const p = document.createElement('p'); p.className = 'muted small'; p.textContent = 'Off — add an authenticator app for a second step at sign in.';
    const b = document.createElement('button'); b.className = 'btn small primary'; b.textContent = 'Set up 2FA';
    b.onclick = start2faSetup;
    box.append(p, b);
    return;
  }
  const p = document.createElement('p'); p.className = 'muted small'; p.textContent = 'On — signing in asks for a code from your authenticator app.';
  const row = document.createElement('div'); row.className = 'row'; row.style.marginTop = '.5rem';
  const regen = document.createElement('button'); regen.className = 'btn small'; regen.textContent = 'New backup codes';
  regen.onclick = async () => {
    const code = await openPromptModal({ title: 'Confirm it\'s you', label: 'Enter a 2FA code or backup code', okLabel: 'Continue', maxlength: 16 });
    if (code === null) return;
    try {
      const { backupCodes } = await api('/api/2fa/backup-codes/regenerate', { method: 'POST', body: JSON.stringify({ code: (code || '').trim() }) });
      showBackupCodes(backupCodes);
    } catch (err) { toast('Failed: ' + prettyError(err.message)); }
  };
  const dis = document.createElement('button'); dis.className = 'btn small danger'; dis.textContent = 'Disable 2FA';
  dis.onclick = async () => {
    const code = await openPromptModal({ title: 'Disable 2FA?', label: 'Enter a 2FA code or backup code to confirm', okLabel: 'Disable', maxlength: 16 });
    if (code === null) return;
    try { await api('/api/2fa/disable', { method: 'POST', body: JSON.stringify({ code: (code || '').trim() }) }); render2faBox(); toast('2FA disabled'); }
    catch (err) { toast('Failed: ' + prettyError(err.message)); }
  };
  row.append(regen, dis);
  box.append(p, row);
}
async function start2faSetup() {
  const box = $('#set-2fa');
  let setup;
  try { setup = await api('/api/2fa/setup', { method: 'POST' }); }
  catch (err) { toast('Failed: ' + prettyError(err.message)); return; }
  box.innerHTML = '';
  const p = document.createElement('p'); p.className = 'muted small';
  p.textContent = 'Scan this secret into your authenticator app (or tap the link on mobile), then enter the 6-digit code.';
  const link = document.createElement('div');
  link.innerHTML = `<a href="${esc(setup.otpauth_url)}">Add to authenticator app</a>`;
  const code = document.createElement('div'); code.className = 'codebox'; code.textContent = setup.secret;
  const cp = document.createElement('button'); cp.className = 'btn small'; cp.textContent = 'Copy secret';
  cp.onclick = () => { try { navigator.clipboard.writeText(setup.secret); toast('Secret copied'); } catch {} };
  const inp = document.createElement('input'); inp.maxLength = 16; inp.placeholder = '123456'; inp.inputMode = 'numeric'; inp.style.marginTop = '.5rem';
  const row = document.createElement('div'); row.className = 'row'; row.style.marginTop = '.5rem';
  const ok = document.createElement('button'); ok.className = 'btn small primary'; ok.textContent = 'Confirm';
  ok.onclick = async () => {
    try {
      const { backupCodes } = await api('/api/2fa/enable', { method: 'POST', body: JSON.stringify({ code: inp.value.trim() }) });
      render2faBox();
      showBackupCodes(backupCodes);
    } catch (err) { toast('Failed: ' + prettyError(err.message)); }
  };
  const cancel = document.createElement('button'); cancel.className = 'btn small'; cancel.textContent = 'Cancel';
  cancel.onclick = render2faBox;
  row.append(ok, cancel);
  box.append(p, link, code, cp, inp, row);
}
function showBackupCodes(codes) {
  openModal('Backup codes', `<p class="muted">Save these somewhere safe — each works once if you lose your authenticator. This is the only time they are shown.</p><div class="backup-codes">${(codes || []).map(esc).join('<br/>')}</div>`, 'Done', null);
}
async function renderPasskeyBox() {
  const box = $('#set-passkeys');
  if (!box) return;
  let passkeys = [];
  try { ({ passkeys } = await api('/api/passkeys')); } catch { box.innerHTML = '<p class="muted small">Unavailable.</p>'; return; }
  box.innerHTML = '';
  if (!passkeys.length) box.innerHTML = '<p class="muted small">None yet — add one to sign in without a password.</p>';
  for (const p of passkeys) {
    const row = document.createElement('div'); row.className = 'sec-row';
    const main = document.createElement('span'); main.className = 'grow';
    main.innerHTML = `<span>${esc(p.name || 'Passkey')}</span><span class="sub">added ${new Date(p.created_at).toLocaleDateString()}${p.last_used ? ' · used ' + new Date(p.last_used).toLocaleDateString() : ''}</span>`;
    const rn = document.createElement('button'); rn.className = 'mini'; rn.textContent = 'Rename';
    rn.onclick = async () => {
      const v = await openPromptModal({ title: 'Rename passkey', label: 'Passkey name', initial: p.name || 'Passkey', okLabel: 'Save', maxlength: 32 });
      if (v === null) return;
      try { await api(`/api/passkeys/${p.id}`, { method: 'PATCH', body: JSON.stringify({ name: v.trim() }) }); renderPasskeyBox(); }
      catch (err) { toast('Failed: ' + prettyError(err.message)); }
    };
    const del = document.createElement('button'); del.className = 'mini danger'; del.textContent = '✕';
    del.onclick = async () => {
      try { await api(`/api/passkeys/${p.id}`, { method: 'DELETE' }); renderPasskeyBox(); toast('Passkey removed'); }
      catch (err) { toast('Failed: ' + prettyError(err.message)); }
    };
    row.append(main, rn, del);
    box.appendChild(row);
  }
}
$('#set-passkey-add').onclick = async () => {
  if (!webauthnSupported()) { toast('Passkeys are not supported in this browser'); return; }
  const name = await openPromptModal({ title: 'Add passkey', label: 'Name this passkey', initial: 'My passkey', okLabel: 'Continue', maxlength: 32 });
  if (name === null) return;
  try {
    const { stateId, options } = await api('/api/passkeys/register/options', { method: 'POST' });
    const cred = await navigator.credentials.create({ publicKey: pkFromJson(options) });
    await api('/api/passkeys/register/verify', { method: 'POST', body: JSON.stringify({ stateId, name: (name || '').trim() || 'Passkey', attResp: pkToJson(cred) }) });
    toast('Passkey added');
    renderPasskeyBox();
  } catch (err) { toast(prettyError(err.message)); }
};
function fmtSeen(ts) {
  const d = Date.now() - ts;
  if (d < 60e3) return 'just now';
  if (d < 3600e3) return Math.floor(d / 60e3) + 'm ago';
  if (d < 86400e3) return Math.floor(d / 3600e3) + 'h ago';
  if (d < 30 * 86400e3) return Math.floor(d / 86400e3) + 'd ago';
  return new Date(ts).toLocaleDateString();
}
async function renderSessionBox() {
  const box = $('#set-sessions');
  if (!box) return;
  let sessions = [];
  try { ({ sessions } = await api('/api/sessions')); } catch { box.innerHTML = '<p class="muted small">Unavailable.</p>'; return; }
  box.innerHTML = '';
  if (!sessions.length) box.innerHTML = '<p class="muted small">No active sessions.</p>';
  for (const s of sessions) {
    const row = document.createElement('div'); row.className = 'sec-row';
    const main = document.createElement('span'); main.className = 'grow';
    const ua = (s.user_agent || '').slice(0, 48);
    main.innerHTML = `<span>${esc(s.name || 'Unnamed device')}${s.current ? ' · this device' : ''}</span><span class="sub">${esc([s.ip, ua].filter(Boolean).join(' · '))} · seen ${fmtSeen(s.last_seen || s.created_at)}</span>`;
    const rn = document.createElement('button'); rn.className = 'mini'; rn.textContent = 'Rename';
    rn.onclick = async () => {
      const v = await openPromptModal({ title: 'Rename session', label: 'Session name', initial: s.name || '', placeholder: 'e.g. Home PC', okLabel: 'Save', maxlength: 32 });
      if (v === null) return;
      try { await api(`/api/sessions/${s.id}`, { method: 'PATCH', body: JSON.stringify({ name: (v || '').trim() }) }); renderSessionBox(); }
      catch (err) { toast('Failed: ' + prettyError(err.message)); }
    };
    row.appendChild(main);
    row.appendChild(rn);
    if (!s.current) {
      const rev = document.createElement('button'); rev.className = 'mini danger'; rev.textContent = 'Revoke';
      rev.onclick = async () => {
        try { await api(`/api/sessions/${s.id}`, { method: 'DELETE' }); renderSessionBox(); toast('Session revoked'); }
        catch (err) { toast('Failed: ' + prettyError(err.message)); }
      };
      row.appendChild(rev);
    }
    box.appendChild(row);
  }
}
$('#set-sess-revoke-others').onclick = async () => {
  try { await api('/api/sessions/others', { method: 'DELETE' }); renderSessionBox(); toast('Other sessions revoked'); }
  catch (err) { toast('Failed: ' + prettyError(err.message)); }
};
// ---------- notification inbox ----------
function paintNotifBadge(n) {
  const b = $('#notifs-count');
  if (!b) return;
  b.textContent = n > 99 ? '99+' : String(n);
  b.classList.toggle('hidden', !n);
  // Desktop app: mirror the count onto the tray icon + taskbar badge
  // (no-op in a browser; older app builds reject the unknown command).
  try {
    const inv = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
    if (typeof inv === 'function') inv('set_unread_count', { count: n | 0 }).catch(() => {});
  } catch {}
}
async function refreshNotifBadge() {
  if (!store.token) return;
  try {
    const { unread } = await api('/api/notifs/inbox');
    paintNotifBadge(unread || 0);
  } catch {}
}
function inboxWhen(ts) {
  try { return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}
async function openInbox() {
  let items = [];
  try { ({ items } = await api('/api/notifs/inbox')); } catch { toast('Could not load notifications'); return; }
  openModal('Notifications', `<div class="row end" style="margin:0 0 .4rem"><button class="btn small" id="m-notif-readall">Mark all read</button><button class="btn small" id="m-notif-clear">Dismiss all</button></div><div id="m-inbox-list"></div>`, 'Close', null, { wide: true });
  const list = $('#m-inbox-list');
  if (!items.length) list.innerHTML = '<p class="muted" style="text-align:center;padding:1rem">All caught up — mentions and friend updates land here.</p>';
  for (const n of items) {
    const b = document.createElement('div');
    b.className = 'inbox-item' + (n.read_at ? ' read' : '');
    b.tabIndex = 0;
    const kind = n.kind === 'dm' ? 'DM' : n.kind === 'friend' ? 'Friend' : n.kind === 'reaction' ? 'Reaction' : n.kind === 'friend-status' ? 'Friend status' : n.kind === 'report' ? 'Report' : 'Mention';
    b.innerHTML = `<span class="dot"></span><span class="imain"><span class="ititle">${esc(n.title || kind)}</span><br/><span class="ibody">${esc(n.body || '')}</span></span><span class="iwhen">${esc(inboxWhen(n.created_at))}</span><button type="button" class="inbox-x" title="Dismiss">×</button>`;
    b.onclick = () => openNotifItem(n);
    b.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openNotifItem(n); } };
    b.querySelector('.inbox-x').onclick = (e) => { e.stopPropagation(); dismissNotif(n, b); };
    list.appendChild(b);
  }
  $('#m-notif-readall').onclick = async () => {
    try { await api('/api/notifs/read', { method: 'PUT', body: JSON.stringify({ all: true }) }); } catch {}
    paintNotifBadge(0);
    openInbox();
  };
  $('#m-notif-clear').onclick = async () => {
    try { await api('/api/notifs', { method: 'DELETE' }); } catch {}
    paintNotifBadge(0);
    openInbox();
  };
}
async function openNotifItem(n) {
  try { await api('/api/notifs/read', { method: 'PUT', body: JSON.stringify({ ids: [n.id] }) }); } catch {}
  refreshNotifBadge();
  $('#modal-backdrop').classList.add('hidden');
  try {
    // Site-admin reports open the console's queue rather than a chat.
    if (n.kind === 'report' && isSiteAdmin()) { openAdminConsole('reports'); return; }
    if ((n.kind === 'dm' || n.kind === 'reaction') && n.thread_id) { await openHome(); selectDmThread(n.thread_id); }
    else if (n.kind === 'friend') { await openHome(); S.friendTab = 'pending'; document.querySelector('#friend-tabs .ftab[data-ftab="pending"]')?.click(); refreshFriends(); }
    else if (n.kind === 'friend-status') { await openHome(); showFriendsPanel(); }
    else if (n.server_id) {
      if (n.server_id !== S.serverId) await selectServer(n.server_id);
      if (n.channel_id) await selectChannel(n.channel_id);
      if (n.message_id) jumpToMessage(n.message_id);
    }
  } catch {}
}
async function dismissNotif(n, el) {
  try { const { unread } = await api('/api/notifs/' + n.id, { method: 'DELETE' }); paintNotifBadge(unread || 0); } catch {}
  el.remove();
  const list = $('#m-inbox-list');
  if (list && !list.children.length) list.innerHTML = '<p class="muted" style="text-align:center;padding:1rem">All caught up — mentions and friend updates land here.</p>';
}
$('#btn-notifs').onclick = openInbox;
function openOwnCard() {
  if (!S.me) return;
  const card = $('#usercard');
  if (!card.classList.contains('hidden') && card.dataset.uid === S.me.id) { closeUserCard(); return; }
  const r = $('#me-card').getBoundingClientRect();
  openUserCard(S.me.id, r.left, r.top);
  if (window.matchMedia && matchMedia('(max-width:700px)').matches) {
    // Phone: a full-height sheet that slides up from the bottom. The sheet CSS
    // owns the geometry, so drop the popup's inline positioning (the async
    // clampUserCard() bails on a sheet for the same reason).
    card.classList.add('sheet');
    card.style.left = ''; card.style.top = ''; card.style.bottom = '';
    card.style.maxHeight = ''; card.style.overflowY = '';
    return;
  }
  card.classList.remove('sheet');
  // Bottom-anchored so the card grows upward as content (gaming, bio) loads
  // and can never slide down over the name/avatar area.
  card.style.left = Math.max(8, Math.min(r.left, innerWidth - Math.min(296, innerWidth - 16))) + 'px';
  card.style.top = 'auto';
  card.style.bottom = (innerHeight - r.top + 8) + 'px';
  card.style.maxHeight = Math.max(200, r.top - 16) + 'px';
  card.style.overflowY = 'auto';
}
// Only the avatar + name opens it — the rest of the bar (the space around
// mute/deafen/settings) is dead, and the target outlines itself on hover so
// that is obvious (see #me-open in styles.css).
$('#me-open').onclick = openOwnCard;
function renderServerHeader() {
  const d = S.serverDetail;
  const el = $('#srv-banner');
  if (!el) return;
  if (d && d.banner_url) { el.style.backgroundImage = `url("${d.banner_url}")`; el.classList.remove('hidden'); }
  else { el.classList.add('hidden'); el.style.backgroundImage = ''; }
}
async function refreshServerTab() {
  const id = S.serverDetail?.id;
  if (!id) return;
  try {
    const { server } = await api('/api/servers/' + id);
    if (S.serverDetail?.id !== id) return;
    S.serverDetail = server;
    renderServerTab();
    renderMembers();
    renderServerHeader();
  } catch {}
}
function openServerSettings() {
  const d = S.serverDetail;
  if (!d) return;
  S.srvSetId = d.id;
  renderServerTab();
  $('#srv-settings-backdrop').classList.remove('hidden');
}
function closeServerSettings() { S.srvSetId = null; $('#srv-settings-backdrop')?.classList.add('hidden'); }
function fmtInviteDur(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 3600) return Math.max(1, Math.floor(s / 60)) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}
function inviteMetaText(inv) {
  const bits = [inv.max_uses ? `${inv.uses}/${inv.max_uses} uses` : `${inv.uses} ${inv.uses === 1 ? 'use' : 'uses'}`];
  if (inv.expires_at) {
    const ms = inv.expires_at - Date.now();
    bits.push(ms <= 0 ? 'expired' : 'expires in ' + fmtInviteDur(ms));
  } else bits.push('never expires');
  if (inv.exhausted && !inv.expired) bits.push('used up');
  return bits.join(' · ');
}
async function renderInviteLinks(box, d) {
  box.innerHTML = '<p class="muted small">Loading…</p>';
  let invites = [];
  try { ({ invites } = await api(`/api/servers/${d.id}/invites`)); }
  catch { box.innerHTML = '<p class="muted small">Could not load invite links.</p>'; return; }
  if (!box.isConnected) return;
  box.innerHTML = '';
  if (!invites.length) box.innerHTML = '<p class="muted small">No extra links yet — create one below.</p>';
  for (const inv of invites) {
    const row = document.createElement('div'); row.className = 'set-row';
    const main = document.createElement('div'); main.style.cssText = 'flex:1;min-width:0';
    const top = document.createElement('div');
    top.style.cssText = 'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    top.textContent = inv.label || 'Untitled link';
    const code = document.createElement('div'); code.className = 'muted small';
    code.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    code.textContent = `${location.origin}/invite/${inv.code}`;
    const meta = document.createElement('div'); meta.className = 'muted small';
    meta.textContent = inviteMetaText(inv);
    if (inv.expired || inv.exhausted) meta.style.color = 'var(--red)';
    main.append(top, code, meta);
    row.appendChild(main);
    const cp = document.createElement('button'); cp.className = 'mini'; cp.textContent = 'Copy';
    cp.onclick = () => { navigator.clipboard?.writeText(`${location.origin}/invite/${inv.code}`); toast('Link copied'); };
    const rn = document.createElement('button'); rn.className = 'mini'; rn.textContent = 'Rename';
    rn.onclick = async () => {
      const name = await openPromptModal({ title: 'Rename invite link', label: 'Nickname', initial: inv.label || '', placeholder: 'e.g. Friday game night', okLabel: 'Save', maxlength: 32 });
      if (name === null) return;
      try { await api(`/api/servers/${d.id}/invites/${inv.id}`, { method: 'PATCH', body: JSON.stringify({ label: name.trim() }) }); renderInviteLinks(box, d); }
      catch (err) { toast('Failed: ' + prettyError(err.message)); }
    };
    const rv = document.createElement('button'); rv.className = 'mini danger'; rv.textContent = 'Revoke';
    rv.onclick = async () => {
      const ok = await openConfirmModal({ title: 'Revoke this link?', message: `"${inv.label || 'Untitled link'}" will stop working immediately. People who already joined stay.`, okLabel: 'Revoke', danger: true });
      if (!ok) return;
      try { await api(`/api/servers/${d.id}/invites/${inv.id}`, { method: 'DELETE' }); toast('Link revoked'); renderInviteLinks(box, d); }
      catch (err) { toast('Failed: ' + prettyError(err.message)); }
    };
    row.append(cp, rn, rv);
    box.appendChild(row);
  }
}
function renderServerTab() {
  const box = $('#srvset-body');
  if (!box) return;
  const d = S.serverDetail;
  if (!d || (S.srvSetId && d.id !== S.srvSetId)) { box.innerHTML = '<p class="muted">No server selected.</p>'; return; }
  $('#srv-settings-title').textContent = d.name;
  const owner = d.owner_id === S.me.id;
  const mgr = canManage();
  const scroller = box.parentElement;
  const keepScroll = scroller ? scroller.scrollTop : 0;
  box.innerHTML = '';
  let sub = S.serverSubTab || 'general';
  if ((sub === 'roles' || sub === 'bans') && !mgr) sub = 'general';
  if (!['general', 'invites', 'channels', 'emoji', 'roles', 'bans'].includes(sub)) sub = 'general';
  const wrap = document.createElement('div');
  wrap.className = 'srvset-wrap';
  box.appendChild(wrap);
  const subTabs = document.createElement('div');
  subTabs.className = 'srv-subtabs vertical';
  wrap.appendChild(subTabs);
  const content = document.createElement('div');
  content.className = 'srvset-content';
  wrap.appendChild(content);
  for (const [sid, slabel] of [['general', 'General'], ['invites', 'Invites'], ['channels', 'Channels'], ['emoji', 'Emoji'], ['roles', 'Roles'], ['bans', 'Bans']]) {
    if ((sid === 'roles' || sid === 'bans') && !mgr) continue;
    const b = document.createElement('button');
    b.className = 'ftab' + (sub === sid ? ' active' : '');
    b.textContent = slabel;
    b.onclick = () => {
      S.serverSubTab = sid;
      subTabs.querySelectorAll('.ftab').forEach((x) => x.classList.toggle('active', x === b));
      content.querySelectorAll('[data-ssub]').forEach((x) => (x.style.display = x.dataset.ssub === sid ? '' : 'none'));
    };
    subTabs.appendChild(b);
  }
  const sec = (id) => { const el = document.createElement('div'); el.dataset.ssub = id; el.style.display = sub === id ? '' : 'none'; content.appendChild(el); return el; };
  let cur = sec('general');
  const h = (t) => { const e = document.createElement('h4'); e.textContent = t; e.style.margin = '1rem 0 .4rem'; cur.appendChild(e); };
  // general
  h('General');
  const nameRow = document.createElement('div');
  nameRow.innerHTML = `<label style="flex:1">Server name<input id="srv-name" maxlength="48" value="${esc(d.name)}" ${mgr ? '' : 'disabled'} /></label>`;
  cur.appendChild(nameRow);
  const descRow = document.createElement('div');
  descRow.innerHTML = `<label style="flex:1">Description (shown on invites)<input id="srv-desc" maxlength="200" placeholder="What is this server about?" value="${esc(d.description || '')}" ${mgr ? '' : 'disabled'} /></label>`;
  cur.appendChild(descRow);
  const tagRow = document.createElement('div');
  tagRow.innerHTML = `<label style="flex:1">Server tag (optional emoji + up to 4 characters, members can show it after their name)<span class="row" style="margin-top:.35rem">`
    + `<button type="button" id="srv-tag-emoji" class="tag-emoji-btn empty" title="Pick a tag emoji">😀</button>`
    + `<input id="srv-tag" maxlength="4" placeholder="e.g. NOOB" value="${esc(d.tag || '')}" style="flex:1;width:auto;min-width:0" ${mgr ? '' : 'disabled'} />`
    + (mgr ? `<button type="button" id="srv-tag-unemoji" class="mini danger" title="Remove emoji">✕</button>` : '') + `</span></label>`;
  cur.appendChild(tagRow);
  const eBtn = tagRow.querySelector('#srv-tag-emoji');
  eBtn.dataset.emoji = d.tag_emoji || '';
  const paintEB = () => {
    const v = eBtn.dataset.emoji || '';
    eBtn.textContent = v || '😀';
    eBtn.classList.toggle('empty', !v);
    const un = tagRow.querySelector('#srv-tag-unemoji');
    if (un) un.style.display = v ? '' : 'none';
  };
  paintEB();
  if (mgr) {
    eBtn.onclick = (e) => {
      S.tagEmojiInput = eBtn;
      // Picking saves immediately (like avatar/banner uploads) so the
      // choice can't be lost by closing settings without pressing Save.
      S.tagEmojiDone = async () => {
        paintEB();
        try {
          await api(`/api/servers/${d.id}`, { method: 'PATCH', body: JSON.stringify({ name: box.querySelector('#srv-name').value, description: box.querySelector('#srv-desc').value, tag: box.querySelector('#srv-tag').value, tagEmoji: eBtn.dataset.emoji || '' }) });
        } catch (err) { toast('Save failed: ' + prettyError(err.message)); }
      };
      openPicker('tag', null, 'emoji', { x: e.clientX, y: e.clientY });
      document.querySelector('#picker .pk-tabs').style.display = 'none';
      document.querySelector('#pk-klipy').classList.add('hidden');
      document.querySelector('#pk-search').placeholder = 'Search emoji';
    };
    tagRow.querySelector('#srv-tag-unemoji').onclick = async () => {
      eBtn.dataset.emoji = ''; paintEB();
      try {
        await api(`/api/servers/${d.id}`, { method: 'PATCH', body: JSON.stringify({ name: box.querySelector('#srv-name').value, description: box.querySelector('#srv-desc').value, tag: box.querySelector('#srv-tag').value, tagEmoji: '' }) });
      } catch (err) { toast('Save failed: ' + prettyError(err.message)); }
    };
  } else eBtn.disabled = true;
  const iconRow = document.createElement('div');
  iconRow.className = 'row';
  iconRow.style.margin = '.5rem 0';
  iconRow.innerHTML = `<span class="server-btn" style="width:40px;height:40px;font-size:1rem"></span>`;
  const prev = iconRow.querySelector('.server-btn');
  const paintPrev = () => {
    prev.innerHTML = '';
    if (d.icon_url) {
      prev.classList.add('has-icon');
      const im = document.createElement('img');
      im.src = d.icon_url; im.alt = ''; im.width = 40; im.height = 40;
      im.style.cssText = 'width:40px!important;height:40px!important;object-fit:cover!important;border-radius:10px!important;display:block!important';
      im.onerror = () => { prev.classList.remove('has-icon'); prev.innerHTML = ''; prev.textContent = d.name.trim().charAt(0).toUpperCase(); };
      prev.appendChild(im);
    }
    else { prev.classList.remove('has-icon'); prev.textContent = d.name.trim().charAt(0).toUpperCase(); }
  };
  paintPrev();
  if (mgr) {
    const ch = document.createElement('button'); ch.className = 'btn small'; ch.textContent = 'Change icon';
    const rm = document.createElement('button'); rm.className = 'btn small'; rm.textContent = 'Remove';
    const fi = document.createElement('input'); fi.type = 'file'; fi.accept = 'image/png,image/jpeg,image/gif,image/webp'; fi.className = 'hidden';
    ch.onclick = () => fi.click();
    fi.onchange = async () => { if (!fi.files[0]) return; try { await uploadImage(`/api/servers/${d.id}/icon`, fi.files[0]); renderServerTab(); } catch (err) { toast('Icon failed: ' + prettyError(err.message)); } };
    rm.onclick = async () => { try { await api(`/api/servers/${d.id}/icon`, { method: 'DELETE' }); renderServerTab(); } catch {} };
    const sv = document.createElement('button'); sv.className = 'btn small primary'; sv.textContent = 'Save name';
    sv.onclick = async () => { try { await api(`/api/servers/${d.id}`, { method: 'PATCH', body: JSON.stringify({ name: box.querySelector('#srv-name').value, description: box.querySelector('#srv-desc').value, tag: box.querySelector('#srv-tag').value, tagEmoji: box.querySelector('#srv-tag-emoji').dataset.emoji || '' }) }); toast('Server saved'); } catch (err) { toast('Save failed: ' + prettyError(err.message)); } };
    iconRow.append(ch, rm, sv);
  }
  cur.appendChild(iconRow);
  // banner
  h('Banner');
  const banPrev = document.createElement('div');
  banPrev.className = 'set-banner';
  if (d.banner_url) banPrev.style.backgroundImage = `url('${esc(d.banner_url)}')`;
  cur.appendChild(banPrev);
  if (mgr) {
    const brow = document.createElement('div'); brow.className = 'row'; brow.style.marginTop = '.55rem';
    const bch = document.createElement('button'); bch.className = 'btn small'; bch.textContent = 'Upload';
    const brm = document.createElement('button'); brm.className = 'btn small'; brm.textContent = 'Remove';
    const bfi = document.createElement('input'); bfi.type = 'file'; bfi.accept = 'image/png,image/jpeg,image/gif,image/webp'; bfi.className = 'hidden';
    bch.onclick = () => bfi.click();
    bfi.onchange = async () => { if (!bfi.files[0]) return; try { await uploadImage(`/api/servers/${d.id}/banner`, bfi.files[0]); refreshServerTab(); if (d.id === S.serverId) selectServer(d.id); } catch (err) { toast('Banner failed: ' + prettyError(err.message)); } };
    brm.onclick = async () => { try { await api(`/api/servers/${d.id}/banner`, { method: 'DELETE' }); refreshServerTab(); if (d.id === S.serverId) selectServer(d.id); } catch {} };
    brow.append(bch, brm); cur.appendChild(brow);
  }
  // invites live on their own tab (every link is a named, revocable row —
  // there is no permanent code)
  cur = sec('invites');
  h('Invite links');
  if (!mgr) {
    const note = document.createElement('p'); note.className = 'muted small';
    note.textContent = 'Only admins can create invite links — ask one for a link.';
    cur.appendChild(note);
  } else {
    const xsub = document.createElement('p'); xsub.className = 'muted small';
    xsub.textContent = 'Named links with optional use limits or expiry. Revoked links stop working immediately.';
    cur.appendChild(xsub);
    const xlist = document.createElement('div'); cur.appendChild(xlist);
    renderInviteLinks(xlist, d);
    const form = document.createElement('div');
    form.innerHTML = `<div class="row" style="margin-top:.55rem;flex-wrap:wrap">`
      + `<input id="srv-inv-label" maxlength="32" placeholder="Nickname (e.g. Friday game night)" style="flex:1 1 100%;width:auto" />`
      + `</div><div class="row" style="margin-top:.4rem;flex-wrap:wrap">`
      + `<input id="srv-inv-max" type="number" min="1" max="100000" placeholder="Max uses" style="flex:1;width:auto;min-width:90px" />`
      + `<select id="srv-inv-exp" style="flex:1;width:auto;min-width:150px"><option value="">Never expires</option><option value="3600">1 hour</option><option value="86400">24 hours</option><option value="604800">7 days</option><option value="2592000">30 days</option></select>`
      + `<button class="btn small primary" id="srv-inv-create">Create link</button></div>`;
    cur.appendChild(form);
    form.querySelector('#srv-inv-create').onclick = async () => {
      const label = form.querySelector('#srv-inv-label').value.trim();
      const maxUses = form.querySelector('#srv-inv-max').value.trim();
      const expiresIn = form.querySelector('#srv-inv-exp').value;
      try {
        const { invite } = await api(`/api/servers/${d.id}/invites`, { method: 'POST', body: JSON.stringify({ label, maxUses: maxUses || null, expiresIn: expiresIn || null }) });
        try { await navigator.clipboard?.writeText(`${location.origin}/invite/${invite.code}`); toast('Link created and copied'); }
        catch { toast('Link created'); }
        renderInviteLinks(xlist, d);
      } catch (err) { toast('Failed: ' + prettyError(err.message)); }
    };
  }
  cur = sec('channels');
  // channels
  h('Channels');
  for (const c of d.channels) {
    const row = document.createElement('div');
    row.className = 'set-row';
    const slowBadge = c.slowmode ? ` <span class="muted small">· ${c.slowmode}s slow</span>` : '';
    const descBadge = c.description ? ` <span class="muted small">· ${esc(c.description.slice(0, 24))}${c.description.length > 24 ? '…' : ''}</span>` : '';
    row.innerHTML = `<span class="muted">(${c.type})</span><span class="grow">${esc(c.name)}${slowBadge}${descBadge}</span>`;
    if (mgr) {
      const ed = document.createElement('button'); ed.className = 'mini'; ed.textContent = 'Edit';
      ed.onclick = () => openChannelSettings(d.id, c);
      row.appendChild(ed);
      const del = document.createElement('button'); del.className = 'mini danger'; del.textContent = 'Delete';
      del.onclick = async () => { try { await api(`/api/servers/${d.id}/channels/${c.id}`, { method: 'DELETE' }); } catch (err) { toast('Delete failed: ' + prettyError(err.message)); } };
      row.appendChild(del);
    }
    cur.appendChild(row);
  }
  if (mgr) {
    const add = document.createElement('div'); add.className = 'row'; add.style.marginTop = '.5rem';
    add.innerHTML = `<input id="srv-newchan" maxlength="32" placeholder="new-channel" style="flex:2" /><select id="srv-newtype" style="flex:1"><option value="text">Text</option><option value="voice">Voice</option></select>`;
    const go = document.createElement('button'); go.className = 'btn small'; go.textContent = 'Add';
    go.onclick = async () => {
      const name = add.querySelector('#srv-newchan').value.trim().replace(/\s+/g, '-');
      if (!name) return;
      try { await api(`/api/servers/${d.id}/channels`, { method: 'POST', body: JSON.stringify({ name, type: add.querySelector('#srv-newtype').value }) }); renderServerTab(); }
      catch (err) { toast('Failed: ' + prettyError(err.message)); }
    };
    add.appendChild(go); cur.appendChild(add);
  }
  cur = sec('emoji');
  // custom emoji
  h('Custom emoji');
  const elist = document.createElement('div'); elist.id = 'srv-emojilist';
  const drawEmoji = () => {
    elist.innerHTML = '';
    const names = Object.keys(S.emoji).sort();
    if (!names.length) elist.innerHTML = '<p class="muted small">None yet — add some below. Use them with :name: or the emoji picker.</p>';
    for (const n of names) {
      const row = document.createElement('div'); row.className = 'set-row';
      row.innerHTML = `<img class="set-emoji-img" src="${esc(S.emoji[n])}" alt="" /><span class="grow">:${esc(n)}:</span>`;
      if (mgr) {
        const del = document.createElement('button'); del.className = 'mini danger'; del.textContent = 'Delete';
        del.onclick = async () => { try { await api(`/api/servers/${d.id}/emoji/${encodeURIComponent(n)}`, { method: 'DELETE' }); const r = await api(`/api/servers/${d.id}/emoji`); S.emoji = {}; for (const e of r.emoji) S.emoji[e.name] = e.url; refreshAllEmojis().catch(() => {}); drawEmoji(); } catch {} };
        row.appendChild(del);
      }
      elist.appendChild(row);
    }
  };
  drawEmoji(); cur.appendChild(elist);
  const eadd = document.createElement('div'); eadd.className = 'row'; eadd.style.marginTop = '.5rem';
  eadd.innerHTML = `<input id="srv-emojiname" maxlength="32" placeholder="name" style="flex:1" />`;
  const epick = document.createElement('button'); epick.className = 'btn small'; epick.textContent = 'Upload image';
  const efile = document.createElement('input'); efile.type = 'file'; efile.accept = 'image/png,image/jpeg,image/gif,image/webp'; efile.className = 'hidden';
  epick.onclick = () => efile.click();
  efile.onchange = async () => {
    const nm = eadd.querySelector('#srv-emojiname').value.trim().toLowerCase();
    if (!efile.files[0] || !nm) { toast('Enter a name and pick an image'); return; }
    const fd = new FormData(); fd.append('file', efile.files[0]); fd.append('name', nm);
    try {
      const res = await fetch(`/api/servers/${d.id}/emoji`, { method: 'POST', headers: store.token ? { Authorization: 'Bearer ' + store.token } : {}, body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'failed');
      S.emoji = {}; for (const e of data.emoji) S.emoji[e.name] = e.url;
      refreshAllEmojis().catch(() => {});
      drawEmoji();
    } catch (err) { toast('Emoji failed: ' + prettyError(err.message)); }
  };
  eadd.appendChild(epick); cur.appendChild(eadd); box.appendChild(efile);
  cur = sec('bans');
  // banned members (owner only)
  if (mgr) {
    h('Banned members');
    const banBox = document.createElement('div');
    banBox.innerHTML = '<p class="muted small">Loading…</p>';
    cur.appendChild(banBox);
    api(`/api/servers/${d.id}/bans`).then(({ bans }) => {
      banBox.innerHTML = '';
      if (!bans.length) banBox.innerHTML = '<p class="muted small">Nobody is banned.</p>';
      for (const u of bans || []) {
        const row = document.createElement('div');
        row.className = 'set-row';
        row.innerHTML = `<span class="avatar" style="width:26px;height:26px;font-size:.65rem"></span><span class="grow">${esc(u.display_name)} <span class="muted">@${esc(u.username)}</span>${u.reason ? ` — ${esc(u.reason)}` : ''}</span>`;
        paintAvatar(row.querySelector('.avatar'), u);
        const un = document.createElement('button'); un.className = 'mini'; un.textContent = 'Unban';
        un.onclick = async () => { try { await api(`/api/servers/${d.id}/bans/${u.id}`, { method: 'DELETE' }); renderServerTab(); } catch (err) { toast('Failed: ' + prettyError(err.message)); } };
        row.appendChild(un);
        banBox.appendChild(row);
      }
    }).catch(() => { banBox.innerHTML = '<p class="muted small">Could not load bans.</p>'; });
  }
  cur = sec('roles');
  // roles
  if (mgr) {
    h('Roles');
    const rbox = document.createElement('div');
    cur.appendChild(rbox);
    const drawRoles = () => {
      rbox.innerHTML = '';
      const roles = (S.serverDetail?.roles || []);
      if (!roles.length) rbox.innerHTML = '<p class="muted small">No roles yet — create one below. Assign them from a member\'s profile card.</p>';
      else rbox.innerHTML = '<p class="muted small">Top first — hoisted roles show in this order.</p>';
      for (const [idx, r] of roles.entries()) {
        const row = document.createElement('div'); row.className = 'set-row';
        row.innerHTML = `<span class="rdot"${r.color ? ` style="background:${esc(r.color)}"` : ''}></span><span class="grow">${esc(r.name)}${r.admin ? ' <span class="muted small">· admin</span>' : ''}${r.hoist ? ' <span class="muted small">· hoisted</span>' : ''}</span>`;
        const up = document.createElement('button'); up.className = 'mini'; up.textContent = '▲'; up.title = 'Move up';
        up.disabled = idx === 0;
        up.onclick = async () => { try { await api(`/api/servers/${d.id}/roles/${r.id}/move`, { method: 'POST', body: JSON.stringify({ dir: 'up' }) }); refreshServerTab(); } catch (err) { toast('Failed: ' + prettyError(err.message)); } };
        const dn = document.createElement('button'); dn.className = 'mini'; dn.textContent = '▼'; dn.title = 'Move down';
        dn.disabled = idx === roles.length - 1;
        dn.onclick = async () => { try { await api(`/api/servers/${d.id}/roles/${r.id}/move`, { method: 'POST', body: JSON.stringify({ dir: 'down' }) }); refreshServerTab(); } catch (err) { toast('Failed: ' + prettyError(err.message)); } };
        row.append(up, dn);
        const nm = document.createElement('button'); nm.className = 'mini'; nm.textContent = 'Rename';
        nm.onclick = async () => {
          const v = await openPromptModal({ title: 'Rename role', label: 'Role name', initial: r.name, okLabel: 'Save', maxlength: 32 });
          if (v === null || !v.trim()) return;
          try { await api(`/api/servers/${d.id}/roles/${r.id}`, { method: 'PATCH', body: JSON.stringify({ name: v.trim() }) }); refreshServerTab(); } catch (err) { toast('Failed: ' + prettyError(err.message)); }
        };
        const cl = document.createElement('input'); cl.type = 'color'; cl.value = r.color || '#5865f2'; cl.title = 'Role color'; cl.className = 'clr';
        cl.onchange = async () => { try { await api(`/api/servers/${d.id}/roles/${r.id}`, { method: 'PATCH', body: JSON.stringify({ color: cl.value }) }); refreshServerTab(); } catch (err) { toast('Failed: ' + prettyError(err.message)); } };
        const ho = document.createElement('button'); ho.className = 'mini' + (r.hoist ? ' on' : ''); ho.textContent = 'Hoist';
        ho.title = 'Show separately in the member list';
        ho.onclick = async () => { try { await api(`/api/servers/${d.id}/roles/${r.id}`, { method: 'PATCH', body: JSON.stringify({ hoist: !r.hoist }) }); refreshServerTab(); } catch {} };
        row.append(nm, cl, ho);
        if (owner) {
          const ad = document.createElement('button'); ad.className = 'mini' + (r.admin ? ' on' : ''); ad.textContent = 'Admin';
          ad.title = 'Can manage the server (only the owner can grant this)';
          ad.onclick = async () => { try { await api(`/api/servers/${d.id}/roles/${r.id}`, { method: 'PATCH', body: JSON.stringify({ admin: !r.admin }) }); refreshServerTab(); } catch (err) { toast('Failed: ' + prettyError(err.message)); } };
          row.appendChild(ad);
        }
        const del = document.createElement('button'); del.className = 'mini danger'; del.textContent = '✕';
        del.onclick = async () => { try { await api(`/api/servers/${d.id}/roles/${r.id}`, { method: 'DELETE' }); refreshServerTab(); } catch (err) { toast('Failed: ' + prettyError(err.message)); } };
        row.appendChild(del);
        rbox.appendChild(row);
      }
      const add = document.createElement('div'); add.className = 'row'; add.style.marginTop = '.5rem';
      add.innerHTML = `<input id="srv-newrole" maxlength="32" placeholder="new role" style="flex:2" /><input id="srv-newrole-c" type="color" value="#5865f2" class="clr" />`;
      const go = document.createElement('button'); go.className = 'btn small'; go.textContent = 'Add';
      go.onclick = async () => {
        const name = add.querySelector('#srv-newrole').value.trim();
        if (!name) return;
        try { await api(`/api/servers/${d.id}/roles`, { method: 'POST', body: JSON.stringify({ name, color: add.querySelector('#srv-newrole-c').value }) }); refreshServerTab(); }
        catch (err) { toast('Failed: ' + prettyError(err.message)); }
      };
      add.appendChild(go); rbox.appendChild(add);
    };
    drawRoles();
  }
  cur = sec('general');
  // danger / leave
  const dz = document.createElement('div'); dz.className = 'danger-zone';
  dz.innerHTML = `<h4>${owner ? 'Danger zone' : 'Leave'}</h4>`;
  const lb = document.createElement('button');
  lb.className = 'btn danger small';
  lb.textContent = owner ? 'Delete server' : 'Leave server';
  lb.onclick = async () => {
    if (!owner) {
      try {
        await api(`/api/servers/${d.id}/leave`, { method: 'POST' });
        closeServerSettings();
        S.ws?.send(JSON.stringify({ t: 'subscribe' }));
        refreshServers();
      } catch (err) { toast('Failed: ' + prettyError(err.message)); }
      return;
    }
    openModal(`Delete "${d.name}"?`, `<p class="muted">This server and all its messages are deleted forever. Type <b>${esc(d.name)}</b> below to confirm.</p><label>Server name<input id="m-del-name" autocomplete="off" maxlength="48" placeholder="${esc(d.name)}" /></label>`, 'Delete', async () => {
      try {
        await api(`/api/servers/${d.id}`, { method: 'DELETE' });
        closeServerSettings();
        S.ws?.send(JSON.stringify({ t: 'subscribe' }));
        refreshServers();
      } catch (err) { toast('Failed: ' + prettyError(err.message)); }
    }, { danger: true });
    const okBtn = $('#modal-ok'), nameInp = $('#m-del-name');
    okBtn.disabled = true;
    nameInp.addEventListener('input', () => { okBtn.disabled = nameInp.value.trim() !== d.name; });
  };
  dz.appendChild(lb); cur.appendChild(dz);
  if (scroller) scroller.scrollTop = keepScroll;
}

