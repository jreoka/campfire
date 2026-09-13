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
  render2faBox(); renderPasskeyBox(); renderSessionBox(); renderDangerBox();
}
// ---------- close your own account ----------
// Both actions sign the account out everywhere, so both re-prove it: the
// password, and a 2FA code (or a backup code) when 2FA is on. Deleting also
// asks for the username to be typed — the server checks that too, so it is a
// real gate rather than dialog theatre. The instance owner is refused by the
// server: no other admin may manage that account, so closing it would leave
// the instance with no way back in.
async function renderDangerBox() {
  const box = $('#set-danger');
  if (!box) return;
  let has2fa = false;
  try { has2fa = !!(await api('/api/2fa/status')).enabled; } catch {}
  box.innerHTML = '';
  const dz = document.createElement('div'); dz.className = 'danger-zone';
  const h = document.createElement('h4'); h.textContent = 'Close account';
  const dis = document.createElement('p'); dis.className = 'muted small';
  dis.textContent = 'Disabling signs you out on every device right away, and you cannot sign back in until a site admin re-enables the account.';
  const del = document.createElement('p'); del.className = 'muted small';
  del.textContent = 'Deleting removes your account for good: profile, friends, DMs, stories and server memberships.';
  const row = document.createElement('div'); row.className = 'row'; row.style.marginTop = '.5rem';
  const bk = document.createElement('button'); bk.className = 'btn danger small'; bk.textContent = 'Disable account';
  bk.onclick = () => openCloseAccount('disable', has2fa);
  const bd = document.createElement('button'); bd.className = 'btn danger small'; bd.textContent = 'Delete account';
  bd.onclick = () => openCloseAccount('delete', has2fa);
  row.append(bk, bd);
  dz.append(h, dis, del, row);
  box.appendChild(dz);
}
function openCloseAccount(mode, has2fa, retry) {
  const del = mode === 'delete';
  const name = (S.me && S.me.username) || '';
  const prev = (retry && retry.body) || {};
  const lines = del
    ? ['Your profile, avatar, friends, DMs and stories go with it.',
       'You leave every server. Messages you wrote stay in their chats, shown as a deleted user.',
       'This cannot be undone — there is no way to restore the account.']
    : ['You are signed out on every device right away.',
       'You cannot sign in again until a site admin re-enables the account.',
       'Nothing is deleted — your messages, servers and chats are kept.'];
  openModal(del ? 'Delete your account?' : 'Disable your account?', `
    <p class="muted">${del ? 'This permanently deletes' : 'This closes'} <b>@${esc(name)}</b>.</p>
    <ul class="danger-list">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    ${retry && retry.msg ? `<p class="error">${esc(retry.msg)}</p>` : ''}
    <label>Your password<input id="acct-pw" type="password" autocomplete="current-password" value="${esc(prev.password || '')}" /></label>
    ${has2fa ? `<label>2FA code <span class="muted">(or one of your backup codes)</span><input id="acct-code" maxlength="16" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" value="${esc(prev.code || '')}" /></label>` : ''}
    ${del ? `<label>Type <b>${esc(name)}</b> to confirm<input id="acct-confirm" autocomplete="off" maxlength="24" placeholder="${esc(name)}" value="${esc(prev.confirm || '')}" /></label>` : ''}
  `, del ? 'Delete account' : 'Disable account', () => submitCloseAccount(mode, has2fa), { danger: true, cancelLabel: 'Keep my account' });
  const ok = $('#modal-ok'), pw = $('#acct-pw'), code = $('#acct-code'), conf = $('#acct-confirm');
  const sync = () => {
    ok.disabled = !(pw && pw.value)
      || (has2fa && !(code && code.value.trim()))
      || (del && (!conf || conf.value.trim().toLowerCase() !== name.toLowerCase()));
  };
  for (const el of [pw, code, conf]) if (el) el.addEventListener('input', sync);
  sync();
}
async function submitCloseAccount(mode, has2fa) {
  const body = {
    password: ($('#acct-pw') || {}).value || '',
    code: (($('#acct-code') || {}).value || '').trim(),
    confirm: (($('#acct-confirm') || {}).value || '').trim(),
  };
  try {
    await api(mode === 'delete' ? '/api/me/delete' : '/api/me/disable', { method: 'POST', body: JSON.stringify(body) });
  } catch (err) {
    // Keep the gate in front of them: the same dialog with what they typed and
    // the server's reason on top, rather than a closed dialog and a toast.
    openCloseAccount(mode, has2fa, { msg: prettyError(err.message), body });
    return;
  }
  accountClosed(mode);
}
// The account is off (or gone) and so is every session: tear the local session
// down without asking the API for anything, forget this account's device
// memories, and hand the person the sign-in screen with the reason.
function accountClosed(mode) {
  const uid = S.me && S.me.id;
  try { leaveVoice(true); } catch {}
  try { closeFind(); } catch {}
  try { closeSettings(); } catch {}
  try { S.ws?.close(); } catch {}
  store.token = ''; store.sid = '';
  if (mode === 'delete' && uid) {
    for (const key of ['cf_drafts_', 'cf_view_', 'cf_home_tab_', 'cf_chanunread_', 'cf_pinseen_']) {
      try { localStorage.removeItem(key + uid); } catch {}
    }
  }
  const msg = mode === 'delete'
    ? 'Your account has been deleted. Messages you wrote stay in their chats as a deleted user.'
    : 'Your account is disabled. A site admin can re-enable it for you.';
  showAuth();
  const el = $('#auth-error');
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
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
// Everything the app considers "waiting for you", in one number: unread DM
// messages, unread channels (one each — a channel is a conversation, not a
// message count, matching the rail badge) and the notification inbox. This is
// what the APP ICON shows, on every platform that can show one.
function totalUnreadCount() {
  let n = S.notifUnread || 0;
  for (const c of S.dmUnread.values()) n += c || 0;
  n += S.chanUnread.size;
  return n;
}
// The icon badge is one call per platform, and it is deliberately NOT tied to
// the inbox count any more: a DM used to land with a tray dot only if it also
// produced an inbox row, which plain messages never do.
//  - navigator.setAppBadge / clearAppBadge: the installed PWA (Chrome/Edge on
//    Android and desktop) — the launcher/dock badge on the phone's home screen.
//  - the Tauri `set_unread_count` command: the desktop app's tray icon dot,
//    Windows taskbar overlay and macOS dock badge (unknown command on Android,
//    where the invoke simply rejects and is swallowed).
function paintAppBadge() {
  const n = totalUnreadCount();
  try {
    if (navigator.setAppBadge) {
      if (n > 0) { const p = navigator.setAppBadge(Math.min(n, 99)); if (p && p.catch) p.catch(() => {}); }
      else if (navigator.clearAppBadge) { const p = navigator.clearAppBadge(); if (p && p.catch) p.catch(() => {}); }
    }
  } catch {}
  try {
    const inv = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
    if (typeof inv === 'function') inv('set_unread_count', { count: n | 0 }).catch(() => {});
  } catch {}
}
function paintNotifBadge(n) {
  S.notifUnread = n | 0;
  const txt = n > 99 ? '99+' : String(n);
  const b = $('#notifs-count');
  if (b) { b.textContent = txt; b.classList.toggle('hidden', !n); }
  // The phone header hides the bell behind the ⋯ sheet (see styles.css), so the
  // same count rides that button — otherwise an unread notification would be
  // invisible on a phone. On desktop the ⋯ button is display:none, so the pill
  // can never show twice.
  const more = $('#chat-more-count');
  if (more) { more.textContent = txt; more.classList.toggle('hidden', !n); }
  // Desktop/mobile app: mirror the app's total unread onto the app icon (no-op
  // in a plain browser; older app builds reject the unknown command).
  paintAppBadge();
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
// ---------- the inbox: notifications, reminders, bookmarks ----------
// One panel behind the bell, three lists that are all "something waiting for
// you": the notification inbox it always was, the reminders you set off a
// message (or from nothing at all), and the messages you bookmarked. Each tab
// carries its own search box — the lists are read on the fly (bookmarks and
// reminders are capped server-side) so filtering is instant and never a round
// trip per keystroke.
const INBOX_TABS = [
  { id: 'notifs', label: 'Notifications', hint: 'Search notifications…' },
  { id: 'reminders', label: 'Reminders', hint: 'Search reminders…' },
  { id: 'bookmarks', label: 'Bookmarks', hint: 'Search bookmarks…' },
];
let inboxTab = 'notifs';
let inboxQuery = '';
let inboxData = { notifs: null, reminders: null, bookmarks: null };
// "in 3 hr" / "2 days ago" — a reminder is read on a clock, not a calendar.
function inboxRel(ts) {
  if (!ts) return '';
  const diff = Number(ts) - Date.now();
  const past = diff < 0;
  const abs = Math.abs(diff);
  if (abs < 60000) return 'now';
  let text;
  if (abs < 3600000) text = Math.round(abs / 60000) + ' min';
  else if (abs < 86400000) text = Math.round(abs / 3600000) + ' hr';
  else { const d = Math.round(abs / 86400000); text = d + (d === 1 ? ' day' : ' days'); }
  return past ? text + ' ago' : 'in ' + text;
}
function inboxChip(text, cls) { return text ? `<span class="inbox-chip${cls ? ' ' + cls : ''}">${esc(text)}</span>` : ''; }
// Local copies of the two row marks so this module paints its own list without
// depending on another module's icon constants (and never an emoji glyph).
const INBOX_CLOCK_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9.5V13l2.5 1.6"/><path d="M9 2h6"/></svg>';
const INBOX_CHECK_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>';
async function openInbox(tab) {
  if (tab && INBOX_TABS.some((t) => t.id === tab)) inboxTab = tab;
  inboxQuery = '';
  inboxData = { notifs: null, reminders: null, bookmarks: null };
  const tabs = INBOX_TABS.map((t) =>
    `<button type="button" class="inbox-tab${t.id === inboxTab ? ' on' : ''}" data-tab="${t.id}" role="tab" aria-selected="${t.id === inboxTab}">${t.label}<span class="inbox-tab-n hidden" data-n="${t.id}"></span></button>`).join('');
  // The search field is added a beat later, on purpose: openModal() focuses the
  // first <input> it finds, and a phone should not raise its keyboard just
  // because the inbox was opened to read something.
  openModal('Inbox', `<div class="inbox-tabs" id="inbox-tabs" role="tablist">${tabs}</div><div id="inbox-pane"></div>`, 'Close', null, { wide: true });
  const tabEl = $('#inbox-tabs');
  tabEl.querySelectorAll('.inbox-tab').forEach((b) => {
    b.onclick = () => {
      inboxTab = b.dataset.tab;
      inboxQuery = '';
      tabEl.querySelectorAll('.inbox-tab').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); });
      paintInboxShell();
    };
  });
  paintInboxShell();
  await loadInboxAll();
  // Repaint the LIST only: rebuilding the shell here would tear the search
  // field out from under a reader who is already typing in it.
  paintInboxList();
  paintInboxCounts();
}
function inboxTabDef(id) { return INBOX_TABS.find((t) => t.id === id) || INBOX_TABS[0]; }
function inboxLoading() { return inboxData[inboxTab] === null; }
// The shell (search + list) is rebuilt on a tab change; typing only ever
// repaints the LIST, so the caret stays in the field.
function paintInboxShell() {
  const pane = $('#inbox-pane');
  if (!pane) return;
  pane.innerHTML = `
    <div class="inbox-search"><input id="inbox-q" type="search" autocomplete="off" spellcheck="false" placeholder="${esc(inboxTabDef(inboxTab).hint)}" value="${esc(inboxQuery)}" /></div>
    <div class="inbox-list" id="inbox-list"></div>`;
  const q = $('#inbox-q');
  if (q) {
    q.oninput = () => { inboxQuery = q.value.trim().toLowerCase(); paintInboxList(); };
    q.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); q.value = ''; inboxQuery = ''; paintInboxList(); } };
  }
  paintInboxList();
  paintInboxCounts();
}
function paintInboxCounts() {
  const set = (id, n) => {
    const el = document.querySelector(`#inbox-tabs .inbox-tab-n[data-n="${id}"]`);
    if (!el) return;
    el.textContent = n > 99 ? '99+' : String(n);
    el.classList.toggle('hidden', !n);
  };
  set('notifs', S.notifUnread || 0);
  set('reminders', (inboxData.reminders || []).filter((r) => !r.firedAt).length);
  set('bookmarks', (inboxData.bookmarks || []).length);
}
async function loadInboxAll() {
  const [n, r, b] = await Promise.all([
    api('/api/notifs/inbox').catch(() => null),
    api('/api/reminders').catch(() => null),
    api('/api/bookmarks').catch(() => null),
  ]);
  // null keeps a tab in its loading state; an empty array is a real answer.
  if (n) { inboxData.notifs = n.items || []; paintNotifBadge(n.unread || 0); } else if (!inboxData.notifs) inboxData.notifs = [];
  if (r) inboxData.reminders = r.items || []; else if (!inboxData.reminders) inboxData.reminders = [];
  if (b) inboxData.bookmarks = b.items || []; else if (!inboxData.bookmarks) inboxData.bookmarks = [];
}
function inboxMatches(...fields) {
  if (!inboxQuery) return true;
  return fields.some((f) => String(f || '').toLowerCase().includes(inboxQuery));
}
function paintInboxList() {
  const list = $('#inbox-list');
  if (!list) return;
  list.innerHTML = '';
  if (inboxLoading()) { list.innerHTML = '<p class="muted" style="text-align:center;padding:1rem">Loading…</p>'; return; }
  if (inboxTab === 'notifs') paintNotifRows(list);
  else if (inboxTab === 'reminders') paintReminderRows(list);
  else paintBookmarkRows(list);
  if (!list.children.length) {
    const msg = inboxQuery
      ? 'Nothing matches that search.'
      : inboxTab === 'notifs' ? 'All caught up — mentions and friend updates land here.'
      : inboxTab === 'reminders' ? 'No reminders yet — set one from a message\'s menu (Create reminder).'
      : 'No bookmarks yet — save a message from its menu.';
    list.innerHTML = `<p class="muted" style="text-align:center;padding:1rem">${esc(msg)}</p>`;
  }
}
function paintNotifRows(list) {
  const items = (inboxData.notifs || []).filter((n) => inboxMatches(n.title, n.body, n.kind));
  if (items.length) {
    const bar = document.createElement('div');
    bar.className = 'row end';
    bar.innerHTML = '<button class="btn small" id="m-notif-readall">Mark all read</button><button class="btn small" id="m-notif-clear">Dismiss all</button>';
    list.appendChild(bar);
    bar.querySelector('#m-notif-readall').onclick = async () => {
      try { await api('/api/notifs/read', { method: 'PUT', body: JSON.stringify({ all: true }) }); } catch {}
      paintNotifBadge(0);
      for (const n of (inboxData.notifs || [])) n.read_at = n.read_at || Date.now();
      paintInboxList(); paintInboxCounts();
    };
    bar.querySelector('#m-notif-clear').onclick = async () => {
      try { await api('/api/notifs', { method: 'DELETE' }); } catch {}
      paintNotifBadge(0);
      inboxData.notifs = [];
      paintInboxList(); paintInboxCounts();
    };
  }
  for (const n of items) {
    const b = document.createElement('div');
    b.className = 'inbox-item' + (n.read_at ? ' read' : '');
    b.tabIndex = 0;
    const kind = n.kind === 'dm' ? 'DM' : n.kind === 'friend' ? 'Friend' : n.kind === 'reaction' ? 'Reaction' : n.kind === 'friend-status' ? 'Friend status' : n.kind === 'report' ? 'Report' : n.kind === 'reminder' ? 'Reminder' : 'Mention';
    // A mention of a message with a picture carries that picture's url (see
    // notifyMentions) — the row shows it, so the inbox reads at a glance.
    const media = n.media_url ? inboxThumbsOf([{ url: n.media_url, kind: n.media_kind === 'video' ? 'video' : 'image' }]) : [];
    b.innerHTML = `<span class="dot"></span><span class="imain"><span class="ititle">${esc(n.title || kind)}</span><br/><span class="ibody">${esc(n.body || '')}</span>${inboxMediaHTML(media)}</span><span class="iwhen">${esc(inboxWhen(n.created_at))}</span><button type="button" class="inbox-x" title="Dismiss">×</button>`;
    b.onclick = () => openNotifItem(n);
    b.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openNotifItem(n); } };
    b.querySelector('.inbox-x').onclick = (e) => { e.stopPropagation(); dismissNotif(n); };
    wireInboxMedia(b, media);
    list.appendChild(b);
  }
}
function paintReminderRows(list) {
  const items = (inboxData.reminders || []).filter((r) => inboxMatches(r.text, r.where));
  for (const r of items) {
    const b = document.createElement('div');
    b.className = 'inbox-item saved' + (r.firedAt ? ' read' : '');
    b.tabIndex = 0;
    const when = r.firedAt ? 'rang ' + inboxRel(r.firedAt) : inboxRel(r.remindAt);
    b.innerHTML = `<span class="isave">${r.firedAt ? INBOX_CHECK_SVG : INBOX_CLOCK_SVG}</span><span class="imain">`
      + `<span class="ititle">${esc(r.text || 'Reminder')}</span><br/>`
      + `<span class="ibody">${r.where ? esc(r.where) + ' · ' : ''}${esc(inboxWhen(r.remindAt))}</span></span>`
      + `<span class="iwhen">${esc(when)}</span><button type="button" class="inbox-x" title="Delete">×</button>`;
    b.onclick = () => openSavedTarget(r);
    b.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSavedTarget(r); } };
    b.querySelector('.inbox-x').onclick = (e) => { e.stopPropagation(); deleteReminder(r); };
    list.appendChild(b);
  }
}
// A saved message's media, as thumbnails. A picture is recognised at a glance
// where a line of text is not, and the thumbnail is the fastest way to find the
// thing you saved — so a bookmark with pictures shows them, up to three, with a
// count for the rest. Local uploads paint the derived preview (the same URL the
// chat uses, so the browser usually has it already); a remote GIF has only its
// own bytes; a video has no still until `whenVideoPoster` has captured one, so
// it starts as a play tile and takes its frame when that lands.
const INBOX_THUMB_MAX = 3;
const INBOX_MEDIA_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.6" cy="9.6" r="1.6"/><path d="M3.6 17.2l4.6-4.4a1.6 1.6 0 0 1 2.2 0l3.2 3 2.4-2.2a1.6 1.6 0 0 1 2.2 0l2.4 2.2"/></svg>';
function inboxThumbsOf(media) {
  return (media || []).filter((x) => x && x.url && (x.kind === 'image' || x.kind === 'video'));
}
function inboxMediaHTML(media) {
  const shown = inboxThumbsOf(media).slice(0, INBOX_THUMB_MAX);
  if (!shown.length) return '';
  const tiles = shown.map((x, i) => {
    const src = x.kind === 'image' ? (imageSrcFor(x) || x.url) : '';
    const inner = src
      ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async" />`
      : `<span class="inbox-thumb-glyph">${x.kind === 'video' ? '▶' : INBOX_MEDIA_SVG}</span>`;
    return `<button type="button" class="inbox-thumb ${x.kind === 'video' ? 'video' : 'image'}${x.spoiler ? ' spoiler' : ''}"`
      + ` data-i="${i}" title="${esc(x.name || (x.kind === 'video' ? 'Video' : 'Image'))}"`
      + ` aria-label="${esc(x.name || (x.kind === 'video' ? 'Video' : 'Image'))}">${inner}</button>`;
  }).join('');
  const rest = inboxThumbsOf(media).length - shown.length;
  return `<div class="inbox-media">${tiles}${rest > 0 ? `<span class="inbox-thumb-more">+${rest}</span>` : ''}</div>`;
}
// Wire one bookmark's thumbnails: a picture opens the lightbox, a video opens
// its own bytes (there is nothing to zoom in a video), and a preview that will
// not load steps back to the original and then to a neutral tile — never a
// broken-image box, and never the message's file card (the document-level
// fallback in final.js only owns images it can identify by data-fb-*).
function wireInboxMedia(row, shown) {
  row.querySelectorAll('.inbox-thumb').forEach((tile) => {
    const x = shown[Number(tile.dataset.i)];
    if (!x) return;
    tile.onclick = (e) => {
      e.stopPropagation();
      if (x.kind === 'video') { openMediaLink(absUrl(x.url)); return; }
      openLightbox(x.url, x.name);
    };
    if (x.kind === 'video' && typeof whenVideoPoster === 'function') {
      whenVideoPoster(x.url, (shot) => {
        if (!shot || !tile.isConnected) return;
        tile.style.backgroundImage = `url("${String(shot).replace(/"/g, '%22')}")`;
        tile.classList.add('has-poster');
      });
    }
    const img = tile.querySelector('img');
    if (img) {
      img.addEventListener('error', () => {
        if (img.dataset.triedOriginal) { tile.classList.remove('image'); tile.replaceChildren(tileGlyphNode()); return; }
        img.dataset.triedOriginal = '1';
        img.src = x.url;
      });
    }
  });
}
function tileGlyphNode() {
  const s = document.createElement('span');
  s.className = 'inbox-thumb-glyph';
  s.innerHTML = INBOX_MEDIA_SVG;
  return s;
}
function paintBookmarkRows(list) {
  const items = (inboxData.bookmarks || []).filter((b) => inboxMatches(b.content, b.authorName, b.where));
  for (const m of items) {
    const b = document.createElement('div');
    b.className = 'inbox-item saved';
    b.tabIndex = 0;
    const thumbs = inboxThumbsOf(m.media);
    const files = (m.media || []).length - thumbs.length;
    const snip = String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    // The pictures speak for themselves: text is only echoed when there is some,
    // and the "[N attachments]" placeholder is left for media that cannot be
    // shown as a tile (a zip, a PDF, a spoilered file).
    const body = snip || (files > 0 ? `[${files} file${files === 1 ? '' : 's'}]` : (thumbs.length ? '' : '[no text]'));
    b.innerHTML = `<span class="isave">${BOOKMARK_SVG}</span><span class="imain">`
      + `<span class="ititle">${esc(m.authorName || 'Unknown')}</span>${inboxChip(m.where)}`
      + (body ? `<br/><span class="ibody">${esc(body)}</span>` : '')
      + inboxMediaHTML(m.media)
      + `</span><span class="iwhen">${esc(inboxWhen(m.createdAt))}</span><button type="button" class="inbox-x" title="Remove bookmark">×</button>`;
    b.onclick = () => openSavedTarget({ messageId: m.messageId, threadId: m.threadId, serverId: m.serverId, channelId: m.channelId });
    b.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSavedTarget({ messageId: m.messageId, threadId: m.threadId, serverId: m.serverId, channelId: m.channelId }); } };
    b.querySelector('.inbox-x').onclick = (e) => { e.stopPropagation(); removeBookmarkRow(m); };
    wireInboxMedia(b, thumbs.slice(0, INBOX_THUMB_MAX));
    list.appendChild(b);
  }
}
async function removeBookmarkRow(m) {
  try { await api('/api/bookmarks/' + encodeURIComponent(m.messageId), { method: 'DELETE' }); } catch {}
  if (S.bookmarkIds) S.bookmarkIds.delete(m.messageId);
  inboxData.bookmarks = (inboxData.bookmarks || []).filter((x) => x.messageId !== m.messageId);
  paintInboxList(); paintInboxCounts();
}
async function deleteReminder(r) {
  try { await api('/api/reminders/' + encodeURIComponent(r.id), { method: 'DELETE' }); } catch {}
  inboxData.reminders = (inboxData.reminders || []).filter((x) => x.id !== r.id);
  paintInboxList(); paintInboxCounts();
}
// A saved entry opens the LIVE message when it still exists (so it can be
// replied to, reacted to, read in context) and the conversation it came from
// when it does not — the snapshot on the bookmark is what keeps it readable.
async function openSavedTarget(item) {
  const messageId = item.messageId || '';
  const threadId = item.threadId || '';
  const serverId = item.serverId || '';
  const channelId = item.channelId || '';
  $('#modal-backdrop').classList.add('hidden');
  try {
    if (threadId) {
      await openHome();
      if (!S.dms.some((t) => t.id === threadId)) {
        try { await api(`/api/dms/${threadId}/open`, { method: 'POST' }); await refreshDms(); } catch {}
      }
      selectDmThread(threadId);
      if (messageId) setTimeout(() => { try { jumpToMessage(messageId); } catch {} }, 450);
      return;
    }
    if (serverId) {
      if (serverId !== S.serverId) await selectServer(serverId);
      if (channelId && channelId !== S.channelId) await selectChannel(channelId, { keepNav: true });
      if (messageId) setTimeout(() => { try { jumpToMessage(messageId); } catch {} }, 450);
      return;
    }
  } catch {}
  if (messageId) { try { await jumpToMessage(messageId); } catch {} }
}
async function openNotifItem(n) {
  try { await api('/api/notifs/read', { method: 'PUT', body: JSON.stringify({ ids: [n.id] }) }); } catch {}
  refreshNotifBadge();
  // A reminder's row carries the conversation it was set off, so it lands the
  // same way any other notification does.
  $('#modal-backdrop').classList.add('hidden');
  try {
    // Site-admin reports open the console's queue rather than a chat.
    if (n.kind === 'report' && isSiteAdmin()) { openAdminConsole('reports'); return; }
    if ((n.kind === 'dm' || n.kind === 'reaction' || n.kind === 'reminder') && n.thread_id) { await openHome(); selectDmThread(n.thread_id); if (n.message_id) setTimeout(() => { try { jumpToMessage(n.message_id); } catch {} }, 450); }
    else if (n.kind === 'friend') { await openHome(); S.friendTab = 'pending'; document.querySelector('#friend-tabs .ftab[data-ftab="pending"]')?.click(); refreshFriends(); }
    else if (n.kind === 'friend-status') { await openHome(); showFriendsPanel(); }
    else if (n.server_id) {
      if (n.server_id !== S.serverId) await selectServer(n.server_id);
      if (n.channel_id) await selectChannel(n.channel_id);
      if (n.message_id) jumpToMessage(n.message_id);
    }
  } catch {}
}
async function dismissNotif(n) {
  try { const { unread } = await api('/api/notifs/' + n.id, { method: 'DELETE' }); paintNotifBadge(unread || 0); } catch {}
  inboxData.notifs = (inboxData.notifs || []).filter((x) => x.id !== n.id);
  paintInboxList(); paintInboxCounts();
}
$('#btn-notifs').onclick = openInbox;
function openOwnCard() {
  if (!S.me) return;
  const card = $('#usercard');
  if (!card.classList.contains('hidden') && card.dataset.uid === S.me.id) { closeUserCard(); return; }
  const r = $('#me-card').getBoundingClientRect();
  // Phone: a full-height sheet that slides up from the bottom (openUserCard
  // applies it). Desktop keeps the popup, bottom-anchored so the card grows
  // upward as content (gaming, bio) loads and can never slide down over the
  // name/avatar area.
  const sheet = phoneLayout();
  openUserCard(S.me.id, r.left, r.top, null, { sheet });
  if (sheet) return;
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
      const hint = document.createElement('p'); hint.className = 'muted small';
      hint.textContent = 'Anyone can @mention a role to ping everyone who holds it. @everyone and @here are for server admins.';
      rbox.appendChild(hint);
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

