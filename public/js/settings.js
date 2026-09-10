'use strict';
// ---------- settings (tabbed) ----------
function openSettings(tab = 'profile') {
  setSettingsTab(tab);
  $('#set-display').value = S.me.display_name || '';
  S.pendingDeco = undefined;
  renderDecoPicker();
  $('#set-namecustom').checked = !!(S.me.name_color || S.me.name_gradient);
  const remNc = rememberedNameColors();
  $('#set-namecolor').value = S.me.name_color || remNc.c || '#aac7ff';
  $('#set-namegrad').value = S.me.name_gradient || S.me.name_color || remNc.g || remNc.c || '#aac7ff';
  $('#set-namecustom').onchange = () => {
    if (!$('#set-namecustom').checked) return;
    const rem = rememberedNameColors();
    if (rem.c && $('#set-namecolor').value === '#aac7ff') $('#set-namecolor').value = rem.c;
    if (rem.g && $('#set-namegrad').value === '#aac7ff') $('#set-namegrad').value = rem.g;
  };
  $('#set-cardcustom').checked = !!(S.me.card_color || S.me.card_gradient);
  const remCc = rememberedCardColors();
  $('#set-cardcolor').value = S.me.card_color || remCc.c || '#aac7ff';
  $('#set-cardgrad').value = S.me.card_gradient || S.me.card_color || remCc.g || remCc.c || '#aac7ff';
  $('#set-cardcustom').onchange = () => {
    if (!$('#set-cardcustom').checked) return;
    const rem = rememberedCardColors();
    if (rem.c && $('#set-cardcolor').value === '#aac7ff') $('#set-cardcolor').value = rem.c;
    if (rem.g && $('#set-cardgrad').value === '#aac7ff') $('#set-cardgrad').value = rem.g;
  };
  $('#set-statustext').value = S.me.status_text || '';
  updatePresenceNote();
  // Server-tag picker: every joined server that has a tag set, plus None.
  // S.servers carries full rows (SELECT s.*) so tags ride along for free.
  try {
    const sel = $('#set-tag');
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = ''; none.textContent = 'None';
    sel.appendChild(none);
    for (const s of (S.servers || []).filter((x) => x && (x.tag || x.tag_emoji))) {
      const o = document.createElement('option');
      o.value = s.id; o.textContent = `${s.tag_emoji || ''}${s.tag || ''} — ${s.name}`;
      if (S.me.active_tag_server_id === s.id) o.selected = true;
      sel.appendChild(o);
    }
    if (S.me.active_tag_server_id && ![...sel.options].some((o) => o.value === S.me.active_tag_server_id)) {
      const o = document.createElement('option');
      o.value = S.me.active_tag_server_id; o.selected = true;
      o.textContent = S.me.active_tag ? `${S.me.active_tag} — unavailable` : 'Unavailable';
      sel.appendChild(o);
    }
    if (!sel.value) sel.value = '';
  } catch {}
  $('#set-bio').value = S.me.bio || '';
  updateBioCount();
  $('#set-username').value = S.me.username || '';
  $('#set-pw-cur').value = ''; $('#set-pw-new').value = '';
  paintAvatar($('#set-avatar-prev'), S.me);
  const b = $('#set-banner-prev');
  b.style.backgroundImage = S.me.banner_url ? `url('${S.me.banner_url}')` : '';
  const sb = $('#set-sidebar-prev');
  if (sb) sb.style.backgroundImage = S.me.sidebar_banner_url ? `url('${S.me.sidebar_banner_url}')` : '';
  loadMediaHist();
  $('#settings-backdrop').classList.remove('hidden');
}
function closeSettings() { closePicker(); try { stopMediaPreview(); } catch {} $('#settings-backdrop').classList.add('hidden'); }
// ---------- notifications (Web Push + per-scope prefs) ----------
const NOTIF_OPTS = [['all', 'All messages'], ['mentions', 'Mentions only'], ['muted', 'Muted']];
const NOTIF_LABEL = { all: 'All messages', mentions: 'Mentions only', muted: 'Muted' };
let notifPrefsCache = {};
async function refreshNotifPrefs() {
  try { const { prefs } = await api('/api/notifs/prefs'); notifPrefsCache = prefs || {}; }
  catch { notifPrefsCache = {}; }
  return notifPrefsCache;
}
async function setNotifPref(scope, mode) {
  try {
    await api('/api/notifs/prefs', { method: 'PUT', body: JSON.stringify({ scope, mode }) });
    if (mode === 'inherit') delete notifPrefsCache[scope];
    else notifPrefsCache[scope] = mode;
  } catch (err) { toast('Failed: ' + prettyError(err.message)); }
}
function notifSelect(scope, val, small) {
  const sel = document.createElement('select');
  if (small) sel.style.maxWidth = '150px';
  const opts = scope === 'global' ? NOTIF_OPTS : [['', 'Use default'], ...NOTIF_OPTS];
  for (const [v, l] of opts) {
    const o = document.createElement('option');
    o.value = v; o.textContent = l;
    if (v === val) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = async () => {
    await setNotifPref(scope, sel.value || 'inherit');
    sel.value = notifPrefsCache[scope] || '';
    renderServerList(); renderChannels();
  };
  return sel;
}
async function renderNotifsTab() {
  const box = $('#set-notifs');
  box.innerHTML = '<p class="muted small">Loading…</p>';
  const pushOK = ('serviceWorker' in navigator) && ('PushManager' in window);
  const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
  try { const { prefs } = await api('/api/notifs/prefs'); notifPrefsCache = prefs || {}; } catch { notifPrefsCache = {}; }
  if (!$('#set-notifs')) return;
  box.innerHTML = '';
  const h = (t) => { const e = document.createElement('h4'); e.textContent = t; e.style.margin = '1rem 0 .4rem'; box.appendChild(e); };
  h('Push notifications');
  const st = document.createElement('p'); st.className = 'muted small';
  let subscribed = false;
  if (pushOK && perm === 'granted') {
    try {
      const reg = await navigator.serviceWorker.ready;
      subscribed = !!(await reg.pushManager.getSubscription());
    } catch {}
  }
  if (!pushOK) st.textContent = 'Push is not supported in this browser.';
  else if (subscribed) st.textContent = 'Push notifications are enabled on this device — you will get pings even with Campfire closed.';
  else if (perm === 'denied') st.textContent = 'Notifications are blocked. Allow them in your browser or OS settings, then return here.';
  else if (perm === 'granted') st.textContent = 'Push is off on this device. Turn it back on below.';
  else st.textContent = 'Get pings on desktop and mobile, even with Campfire closed.';
  box.appendChild(st);
  if (pushOK && !subscribed && perm !== 'granted' && perm !== 'denied') {
    const en = document.createElement('button'); en.className = 'btn small primary'; en.textContent = 'Enable notifications';
    en.onclick = async () => {
      try {
        const p = await Notification.requestPermission();
        if (p === 'granted') { await pushSetup(); renderNotifsTab(); toast('Notifications enabled'); }
        else { toast('Notifications blocked'); renderNotifsTab(); }
      } catch { toast('Could not enable'); }
    };
    box.appendChild(en);
  }
  if (pushOK && perm === 'granted' && !subscribed) {
    const en = document.createElement('button'); en.className = 'btn small primary'; en.textContent = 'Enable on this device';
    en.onclick = async () => { await pushSetup(); renderNotifsTab(); toast('Notifications enabled'); };
    box.appendChild(en);
  }
  if (pushOK && subscribed) {
    const test = document.createElement('button'); test.className = 'btn small'; test.textContent = 'Send test push';
    test.onclick = async () => { try { await api('/api/push/test', { method: 'POST' }); toast('Test push sent'); } catch { toast('Test failed'); } };
    box.appendChild(test);
    const off = document.createElement('button'); off.className = 'btn small'; off.textContent = 'Disable on this device';
    off.onclick = async () => { await pushTeardown(); renderNotifsTab(); };
    box.appendChild(off);
  }
  h('Default for everything');
  box.appendChild(notifSelect('global', notifPrefsCache.global || 'all'));
  const note = document.createElement('p'); note.className = 'muted small';
  note.textContent = 'Right-click (or long-press) a server or channel for its own rules. DM threads follow the default rule.';
  box.appendChild(note);
}
function urlB64ToU8(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function pushSetup() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (!store.token || Notification.permission !== 'granted') return;
    const { publicKey } = await api('/api/push/config');
    if (!publicKey) return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(publicKey) });
    const js = sub.toJSON();
    await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint, keys: js.keys }) });
  } catch {}
}
async function pushTeardown() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      try { await api('/api/push/unsubscribe', { method: 'DELETE', body: JSON.stringify({ endpoint: sub.endpoint }) }); } catch {}
      try { await sub.unsubscribe(); } catch {}
    }
    toast('Notifications disabled on this device');
  } catch {}
}
function setSettingsTab(t) {
  document.querySelectorAll('.set-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  $('#set-profile').classList.toggle('hidden', t !== 'profile');
  $('#set-account').classList.toggle('hidden', t !== 'account');
  $('#set-games').classList.toggle('hidden', t !== 'games');
  $('#set-media').classList.toggle('hidden', t !== 'media');
  $('#set-notifs').classList.toggle('hidden', t !== 'notifs');
  $('#set-blocked').classList.toggle('hidden', t !== 'blocked');
  $('#set-themes').classList.toggle('hidden', t !== 'themes');
  $('#set-admin').classList.toggle('hidden', t !== 'admin');
  if (t === 'notifs') renderNotifsTab();
  if (t === 'blocked') renderBlockedTab();
  if (t === 'themes') renderThemesTab();
  if (t === 'games') renderGamesTab();
  if (t === 'media') renderMediaTab();
  else if (typeof stopMediaPreview === 'function') stopMediaPreview();
  if (t === 'admin' && typeof renderAdminTab === 'function') renderAdminTab();
}
// ---------- blocked users (moved here from the Home friends tabs) ----------
async function renderBlockedTab() {
  const box = $('#set-blocked');
  if (!box) return;
  try { await ensureFriends(); } catch {}
  const blocked = (S.friends && S.friends.blocked) || [];
  box.innerHTML = '';
  const h = document.createElement('h4');
  h.textContent = 'Blocked users';
  h.style.margin = '1rem 0 .4rem';
  box.appendChild(h);
  const note = document.createElement('p');
  note.className = 'muted small';
  note.textContent = 'Blocked users are removed from your friends and cannot send you new friend requests.';
  box.appendChild(note);
  if (!blocked.length) {
    box.insertAdjacentHTML('beforeend', '<p class="muted small">Nobody blocked.</p>');
    return;
  }
  const list = document.createElement('div');
  list.className = 'set-blocked-list';
  for (const u of blocked) {
    const row = friendRowEl(u);
    row.appendChild(smallBtn('Unblock', async () => { await unblockUser(u.id); renderBlockedTab(); }));
    list.appendChild(row);
  }
  box.appendChild(list);
}
// ---------- themes (dark = current skin, light, dracula, oled) ----------
const THEME_META = [
  { id: 'dark', name: 'Dark', desc: 'The current Campfire look.' },
  { id: 'light', name: 'Light', desc: 'Bright surfaces for daylight.' },
  { id: 'dracula', name: 'Dracula', desc: 'Official Dracula palette.' },
  { id: 'oled', name: 'OLED Black', desc: 'Pure black for OLED screens.' },
];
function renderThemesTab() {
  const box = $('#set-themes');
  if (!box) return;
  const cur = (typeof getTheme === 'function' ? getTheme() : 'dark');
  box.innerHTML = '';
  const h = document.createElement('h4');
  h.textContent = 'Appearance';
  h.style.margin = '1rem 0 .4rem';
  box.appendChild(h);
  const note = document.createElement('p');
  note.className = 'muted small';
  note.textContent = 'Applies instantly on this device.';
  box.appendChild(note);
  const grid = document.createElement('div');
  grid.className = 'theme-grid';
  for (const m of THEME_META) {
    const b = document.createElement('button');
    b.className = 'theme-card' + (m.id === cur ? ' sel' : '');
    b.setAttribute('aria-pressed', m.id === cur ? 'true' : 'false');
    b.innerHTML = `<span class="theme-prev prev-${m.id}" aria-hidden="true"><span class="tp-bar"></span><span class="tp-main"><span class="tp-dot"></span><span class="tp-line"></span><span class="tp-line short"></span></span></span><span class="theme-name">${m.name}${m.id === cur ? ' ✓' : ''}</span><span class="theme-desc">${m.desc}</span>`;
    b.onclick = () => {
      applyTheme(m.id);
      toast(m.name + ' theme applied');
      renderThemesTab();
    };
    grid.appendChild(b);
  }
  box.appendChild(grid);
}
document.querySelectorAll('.set-tab').forEach((b) => (b.onclick = () => { setSettingsTab(b.dataset.tab); if (b.dataset.tab === 'account') { renderSecurityTab(); renderDesktopApp(); } }));
$('#btn-settings-me').onclick = (e) => { if (e) e.stopPropagation(); openSettings('profile'); };
$('#btn-home').onclick = openHome;
$('#btn-friends').onclick = showFriendsPanel;
$('#btn-pins').onclick = openPins;
$('#jump-present').onclick = jumpToPresent;
$('#messages').addEventListener('scroll', () => updatePill(), { passive: true });
$('#btn-friend-add-open').onclick = () => {
  const w = $('#friend-add-wrap');
  w.classList.toggle('hidden');
  if (!w.classList.contains('hidden')) $('#in-friend').focus();
};
$('#in-friend').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#btn-friend-add').click(); } });
$('#btn-friend-add').onclick = async () => {
  const v = $('#in-friend').value.trim();
  if (!v) return;
  try {
    await api('/api/friends', { method: 'POST', body: JSON.stringify({ username: v }) });
    $('#in-friend').value = '';
    toast('Request sent');
    refreshFriends();
  } catch (err) { toast(prettyError(err.message)); }
};
$('#btn-group-new').onclick = openGroupModal;
$('#btn-server-menu').onclick = () => openServerSettings();
$('#settings-close').onclick = closeSettings;
$('#settings-backdrop').addEventListener('click', (e) => { if (e.target.id === 'settings-backdrop') closeSettings(); });
$('#srv-settings-close').onclick = () => closeServerSettings();
$('#srv-settings-backdrop').addEventListener('click', (e) => { if (e.target.id === 'srv-settings-backdrop') closeServerSettings(); });
async function uploadImage(url, file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(url, { method: 'POST', headers: store.token ? { Authorization: 'Bearer ' + store.token } : {}, body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'upload_failed');
  return data;
}
$('#set-avatar-btn').onclick = () => $('#set-avatar-file').click();
$('#set-banner-btn').onclick = () => $('#set-banner-file').click();
// dedicated centered GIF chooser for profile media (avatar / banner / sidebar)
async function openProfileGifPicker(kind) {
  const title = kind === 'avatar' ? 'Choose an avatar GIF' : kind === 'banner' ? 'Choose a banner GIF' : 'Choose a sidebar GIF';
  openModal(title, `
    <input id="m-gif-search" placeholder="Search GIFs" autocomplete="off" />
    <div id="m-gif-grid" class="gif-grid"></div>
    <div class="pk-attr">Powered by <a href="https://klipy.com" target="_blank" rel="noopener">KLIPY</a></div>
  `, 'Close', null, { wide: true });
  const grid = $('#m-gif-grid');
  const draw = (gifs) => {
    grid.innerHTML = '';
    if (!gifs.length) { grid.innerHTML = '<div class="pk-empty">No GIFs found.</div>'; return; }
    for (const g of gifs) {
      const b = document.createElement('button');
      b.className = 'pk-gif'; b.title = g.title || 'GIF';
      b.innerHTML = `<img src="${esc(g.thumb || g.preview || g.gif)}" alt="${esc(g.title || 'GIF')}" loading="lazy" />`;
      b.onclick = async () => {
        $('#modal-backdrop').classList.add('hidden');
        const url = g.gif || g.mp4;
        if (url) await applyProfileUrl(kind, url);
      };
      grid.appendChild(b);
    }
  };
  const load = async (q) => {
    grid.innerHTML = '<div class="pk-empty">Loading…</div>';
    try {
      const { gifs } = await api(q ? '/api/gifs/search?q=' + encodeURIComponent(q) : '/api/gifs/trending');
      if ($('#m-gif-grid')) draw(gifs || []);
    } catch { grid.innerHTML = '<div class="pk-empty">GIFs unavailable.</div>'; }
  };
  let t = null;
  $('#m-gif-search').addEventListener('input', (e) => {
    clearTimeout(t);
    const q = e.target.value.trim();
    t = setTimeout(() => load(q), 350);
  });
  load('');
}
$('#set-avatar-gif').onclick = () => openProfileGifPicker('avatar');
$('#set-banner-gif').onclick = () => openProfileGifPicker('banner');
$('#set-sidebar-btn').onclick = () => $('#set-sidebar-file').click();
$('#set-sidebar-gif').onclick = () => openProfileGifPicker('sidebar');
$('#set-sidebar-prev').onclick = () => $('#set-sidebar-file').click();
$('#set-sidebar-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const { user } = await uploadImage('/api/me/sidebar-banner', f);
    S.me = { ...S.me, ...user };
    paintMe(); renderMembers();
    $('#set-sidebar-prev').style.backgroundImage = S.me.sidebar_banner_url ? `url('${S.me.sidebar_banner_url}')` : '';
    toast('Sidebar banner updated');
  } catch (err) { toast('Upload failed: ' + prettyError(err.message)); }
});
$('#set-sidebar-rm').onclick = async () => {
  try {
    const { user } = await api('/api/me/sidebar-banner', { method: 'DELETE' });
    S.me = { ...S.me, ...user };
    paintMe(); renderMembers();
    $('#set-sidebar-prev').style.backgroundImage = '';
  } catch { toast('Remove failed'); }
};
$('#set-avatar-prev').onclick = () => $('#set-avatar-file').click();
$('#set-banner-prev').onclick = () => $('#set-banner-file').click();
$('#set-avatar-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { const { user } = await uploadImage('/api/me/avatar', f); S.me = { ...S.me, ...user }; paintMe(); paintAvatar($('#set-avatar-prev'), S.me); loadMediaHist(); toast('Avatar updated'); }
  catch (err) { toast('Avatar failed: ' + prettyError(err.message)); }
});
$('#set-banner-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { const { user } = await uploadImage('/api/me/banner', f); S.me = { ...S.me, ...user }; $('#set-banner-prev').style.backgroundImage = `url('${S.me.banner_url}')`; loadMediaHist(); toast('Banner updated'); }
  catch (err) { toast('Banner failed: ' + prettyError(err.message)); }
});
$('#set-avatar-rm').onclick = async () => {
  try { const { user } = await api('/api/me/avatar', { method: 'DELETE' }); S.me = { ...S.me, ...user }; paintMe(); paintAvatar($('#set-avatar-prev'), S.me); }
  catch { toast('Remove failed'); }
};
$('#set-banner-rm').onclick = async () => {
  try { const { user } = await api('/api/me/banner', { method: 'DELETE' }); S.me = { ...S.me, ...user }; $('#set-banner-prev').style.backgroundImage = ''; }
  catch { toast('Remove failed'); }
};
function rememberedNameColors() { try { return JSON.parse(localStorage.getItem('cf_namecolors') || 'null') || {}; } catch { return {}; } }
function rememberedCardColors() { try { return JSON.parse(localStorage.getItem('cf_cardcolors') || 'null') || {}; } catch { return {}; } }
function renderDecoPicker() {
  const grid = $('#set-deco-grid');
  if (!grid) return;
  const cur = S.pendingDeco !== undefined ? S.pendingDeco : ((S.me || {}).avatar_decoration || '');
  grid.innerHTML = '';
  const mk = (id, name) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'deco-opt' + (cur === id ? ' sel' : '');
    b.dataset.deco = id;
    const av = document.createElement('span');
    try { paintAvatar(av, { ...(S.me || {}), display_name: ((S.me || {}).display_name || '?'), avatar_decoration: id }); } catch {}
    const nm = document.createElement('span');
    nm.textContent = name;
    b.append(av, nm);
    b.onclick = () => {
      S.pendingDeco = id;
      grid.querySelectorAll('.deco-opt').forEach((o) => o.classList.toggle('sel', o === b));
      try { paintAvatar($('#set-avatar-prev'), { ...(S.me || {}), avatar_decoration: id }); } catch {}
    };
    return b;
  };
  grid.appendChild(mk('', 'None'));
  const camp = AVATAR_DECOS.filter((d) => d.camp), other = AVATAR_DECOS.filter((d) => !d.camp);
  const lab = (t) => { const s = document.createElement('span'); s.className = 'deco-group'; s.textContent = t; return s; };
  if (camp.length) { grid.appendChild(lab('Camping')); camp.forEach((d) => grid.appendChild(mk(d.id, d.name))); }
  if (other.length) { grid.appendChild(lab('More')); other.forEach((d) => grid.appendChild(mk(d.id, d.name))); }
}
// Pending timed-presence note (status lives in the avatar menu;
// saving here never touches it).
function updatePresenceNote() {
  const el = $('#set-presence-note');
  if (!el) return;
  const ts = +((S.me || {}).presence_expires_at || 0);
  el.textContent = (ts > Date.now() && (S.me || {}).status !== 'online')
    ? `Returns to Online ${fmtCountdown(ts)} — changing status via your avatar clears the timer.`
    : '';
}
function updateBioCount() { const b = $('#set-bio'); if (b) $('#set-bio-count').textContent = `${b.value.length} / 300`; }
$('#set-bio').addEventListener('input', updateBioCount);
$('#set-profile-save').onclick = async () => {
  try {
    if ($('#set-namecustom').checked) { try { localStorage.setItem('cf_namecolors', JSON.stringify({ c: $('#set-namecolor').value, g: $('#set-namegrad').value })); } catch {} }
    if ($('#set-cardcustom').checked) { try { localStorage.setItem('cf_cardcolors', JSON.stringify({ c: $('#set-cardcolor').value, g: $('#set-cardgrad').value })); } catch {} }
    const body = {
      displayName: $('#set-display').value.trim(),
      statusText: $('#set-statustext').value.trim(),
      bio: $('#set-bio').value,
      nameColor: $('#set-namecustom').checked ? $('#set-namecolor').value : '',
      nameGradient: $('#set-namecustom').checked ? $('#set-namegrad').value : '',
      cardColor: $('#set-cardcustom').checked ? $('#set-cardcolor').value : '',
      cardGradient: $('#set-cardcustom').checked ? $('#set-cardgrad').value : '',
      decoration: S.pendingDeco !== undefined ? S.pendingDeco : ((S.me || {}).avatar_decoration || ''),
    };
    // Only send the tag when it changed: a stale selection (server removed
    // its tag) must never block the rest of the profile save.
    const wantTag = $('#set-tag').value || null;
    if (wantTag !== (S.me.active_tag_server_id || null)) body.tagServerId = wantTag;
    const { user } = await api('/api/me', { method: 'PATCH', body: JSON.stringify(body) });
    S.me = { ...S.me, ...user };
    paintMe(); renderMembers();
    try { renderMessages(); } catch {}
    try { renderFriendLists(); } catch {}
    try { renderDmMembers(); } catch {}
    updatePresenceNote();
    toast('Profile saved');
  } catch (err) { toast('Save failed: ' + prettyError(err.message)); }
};
$('#set-pw-save').onclick = async () => {
  try {
    await api('/api/me/password', { method: 'POST', body: JSON.stringify({ current: $('#set-pw-cur').value, next: $('#set-pw-new').value }) });
    $('#set-pw-cur').value = ''; $('#set-pw-new').value = '';
    toast('Password changed');
  } catch (err) { toast('Failed: ' + prettyError(err.message)); }
};
$('#set-logout').onclick = doLogout;
async function renderDesktopApp() {
  const box = $('#set-desktop');
  if (!box) return;
  box.innerHTML = '';
  const inApp = !!(window.__TAURI__ && window.__TAURI__.core);
  const p = document.createElement('p'); p.className = 'muted small';
  p.textContent = 'Run Campfire as a native Windows app — tray icon, start on login, and automatic game detection. It shows "Playing …" while a game runs and tracks playtime, levels and streaks on your profile.';
  box.appendChild(p);
  const row = document.createElement('div'); row.className = 'row'; row.style.marginTop = '.5rem';
  const dl = document.createElement('a');
  dl.className = 'btn small primary'; dl.textContent = 'Download for Windows';
  dl.href = 'https://github.com/jreoka/campfire/releases/latest'; dl.target = '_blank';
  row.appendChild(dl);
  if (inApp) {
    const cb = document.createElement('label'); cb.className = 'set-check';
    const inp = document.createElement('input'); inp.type = 'checkbox';
    cb.appendChild(inp); cb.appendChild(document.createTextNode(' Start on login'));
    row.appendChild(cb);
    try { inp.checked = !!(await window.__TAURI__.core.invoke('get_autostart')); } catch {}
    inp.onchange = async () => {
      try { await window.__TAURI__.core.invoke('set_autostart', { enabled: inp.checked }); toast(inp.checked ? 'Start on login enabled' : 'Start on login disabled'); }
      catch (err) { toast('Failed: ' + prettyError(err.message)); }
    };
  } else {
    const note = document.createElement('p'); note.className = 'muted small';
    note.textContent = 'Game detection runs inside the app and needs you signed in.';
    box.appendChild(row);
    box.appendChild(note);
  }
  if (inApp) box.appendChild(row);
}
async function renderGamesTab() {
  const box = $('#set-games');
  if (!box) return;
  box.innerHTML = '<p class="muted small">Loading…</p>';
  try {
    const { enabled, exclusions, games } = await api('/api/me/games');
    const excludedSet = new Set(exclusions || []);
    box.innerHTML = '';
    const h = (t) => { const e = document.createElement('h4'); e.textContent = t; e.style.margin = '1rem 0 .4rem'; box.appendChild(e); };
    h('Game activity');
    const glob = document.createElement('label'); glob.className = 'set-check';
    const globInp = document.createElement('input'); globInp.type = 'checkbox';
    globInp.checked = !!enabled;
    glob.appendChild(globInp); glob.appendChild(document.createTextNode(' Show what game I am playing on my profile'));
    box.appendChild(glob);
    globInp.onchange = async () => {
      try {
        await api('/api/me', { method: 'PATCH', body: JSON.stringify({ gameEnabled: globInp.checked }) });
        S.me.game_enabled = globInp.checked ? 1 : 0;
        toast(globInp.checked ? 'Game activity enabled' : 'Game activity hidden');
      } catch (err) { toast('Failed: ' + prettyError(err.message)); }
    };
    const note = document.createElement('p'); note.className = 'muted small';
    note.textContent = 'When off, no game status is shown and no playtime is tracked.';
    box.appendChild(note);
    h('Detected games');
    if (!games.length) {
      box.insertAdjacentHTML('beforeend', '<p class="muted small">No games detected yet. Play something with the desktop app running to see it here.</p>');
      return;
    }
    const list = document.createElement('div'); list.className = 'set-games-list';
    for (const g of games) {
      const row = document.createElement('div'); row.className = 'set-game-row';
      const icon = document.createElement('span'); icon.className = 'set-game-icon';
      if (g.icon_url) { const im = document.createElement('img'); im.src = g.icon_url; im.alt = ''; im.loading = 'lazy'; im.onerror = () => { im.remove(); icon.textContent = g.game.charAt(0).toUpperCase(); }; icon.appendChild(im); }
      else icon.textContent = g.game.charAt(0).toUpperCase();
      const info = document.createElement('div'); info.className = 'set-game-info';
      const name = document.createElement('div'); name.className = 'set-game-name'; name.textContent = g.game;
      const meta = document.createElement('div'); meta.className = 'muted small';
      meta.textContent = fmtPlay(g.total_ms) + ' · Lv ' + levelForMs(g.total_ms);
      info.appendChild(name); info.appendChild(meta);
      const actions = document.createElement('div'); actions.className = 'row'; actions.style.gap = '.35rem';
      const toggle = document.createElement('button');
      toggle.className = 'btn small' + (excludedSet.has(g.game) ? '' : ' primary');
      toggle.textContent = excludedSet.has(g.game) ? 'Ignored' : 'Tracking';
      toggle.onclick = async () => {
        const nowExcluded = !excludedSet.has(g.game);
        if (nowExcluded) excludedSet.add(g.game); else excludedSet.delete(g.game);
        try {
          await api('/api/me', { method: 'PATCH', body: JSON.stringify({ gameExclusions: [...excludedSet] }) });
          S.me.game_exclusions = JSON.stringify([...excludedSet]);
          toggle.className = 'btn small' + (nowExcluded ? '' : ' primary');
          toggle.textContent = nowExcluded ? 'Ignored' : 'Tracking';
          toast(nowExcluded ? g.game + ' ignored' : g.game + ' tracked');
        } catch (err) { toast('Failed: ' + prettyError(err.message)); }
      };
      const del = document.createElement('button'); del.className = 'btn small danger';
      del.textContent = 'Delete';
      del.onclick = async () => {
        const ok = await openConfirmModal({
          title: 'Remove ' + g.game + '?',
          message: 'All playtime, levels and streaks for this game will be permanently deleted.',
          okLabel: 'Remove',
          danger: true,
        });
        if (!ok) return;
        try {
          await api('/api/me/games/' + encodeURIComponent(g.game), { method: 'DELETE' });
          toast(g.game + ' removed from profile');
          renderGamesTab();
        } catch (err) { toast('Failed: ' + prettyError(err.message)); }
      };
      actions.appendChild(toggle); actions.appendChild(del);
      row.appendChild(icon); row.appendChild(info); row.appendChild(actions);
      list.appendChild(row);
    }
    box.appendChild(list);
  } catch {
    box.innerHTML = '<p class="muted small">Could not load game activity.</p>';
  }
}
function levelForMs(ms) {
  const min = ms / 60000;
  const LEVEL_MIN = [0, 60, 180, 480, 1200, 2400, 4800, 9600, 19200, 38400, 76800, 153600];
  let l = 1;
  for (let i = 1; i < LEVEL_MIN.length; i++) if (min >= LEVEL_MIN[i]) l = i + 1;
  return l;
}
// ---------- media tab (call devices + voice processing) ----------
let mediaPrev = null; // { micStream, micCtx, micRaf, camStream }
function stopMicTest() {
  if (!mediaPrev) return;
  try { mediaPrev.micStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { mediaPrev.micCtx?.close(); } catch {}
  if (mediaPrev.micRaf) cancelAnimationFrame(mediaPrev.micRaf);
  mediaPrev.micStream = null; mediaPrev.micCtx = null; mediaPrev.micRaf = null;
  const b = $('#media-mictest'); if (b) b.textContent = 'Test microphone';
  const bar = $('#media-micbar'); if (bar) bar.style.width = '0';
}
function stopCamPreview() {
  if (!mediaPrev) return;
  try { mediaPrev.camStream?.getTracks().forEach((t) => t.stop()); } catch {}
  mediaPrev.camStream = null;
  const v = $('#media-camprev'); if (v) v.srcObject = null;
  const b = $('#media-camtest'); if (b) b.textContent = 'Preview camera';
}
function stopMediaPreview() { stopMicTest(); stopCamPreview(); mediaPrev = null; }
async function startMicTest(micId) {
  stopMicTest();
  const b = $('#media-mictest');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: micId ? { deviceId: { ideal: micId } } : true });
  } catch { toast('Microphone blocked — allow mic access to test'); return; }
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser(); an.fftSize = 512;
    src.connect(an);
    mediaPrev = { ...(mediaPrev || {}), micStream: stream, micCtx: ctx, micRaf: null };
    const bar = $('#media-micbar');
    const data = new Uint8Array(an.frequencyBinCount);
    const tick = () => {
      if (!mediaPrev || mediaPrev.micStream !== stream) return;
      an.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128) / 128);
      if (bar) bar.style.width = Math.min(100, Math.round(peak * 140)) + '%';
      mediaPrev.micRaf = requestAnimationFrame(tick);
    };
    mediaPrev.micRaf = requestAnimationFrame(tick);
    if (b) b.textContent = 'Stop test';
  } catch { try { stream.getTracks().forEach((t) => t.stop()); } catch {} toast('Could not start mic test'); }
}
async function startCamPreview(camId) {
  stopCamPreview();
  const b = $('#media-camtest');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: camId ? { deviceId: { ideal: camId }, width: { ideal: 1280 } } : { width: { ideal: 1280 } } });
  } catch { toast('Camera blocked — allow camera access to preview'); return; }
  mediaPrev = { ...(mediaPrev || {}), camStream: stream };
  const v = $('#media-camprev');
  if (v) { v.srcObject = stream; v.play().catch(() => {}); }
  if (b) b.textContent = 'Stop preview';
}
async function testSpeakerOutput(speakerId) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const o = ctx.createOscillator(), g = ctx.createGain();
    const dest = ctx.createMediaStreamDestination();
    o.type = 'sine'; o.frequency.value = 660;
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(g); g.connect(dest);
    const a = new Audio();
    if (speakerId && typeof a.setSinkId === 'function') { try { await a.setSinkId(speakerId); } catch {} }
    a.srcObject = dest.stream;
    o.start(t); o.stop(t + 0.6);
    await a.play().catch(() => {});
    setTimeout(() => { try { o.disconnect(); g.disconnect(); ctx.close(); } catch {} }, 900);
  } catch { try { sfx.join(); } catch {} }
}
function onMediaDeviceChange() {
  if (!$('#set-media') || $('#set-media').classList.contains('hidden')) return;
  renderMediaTab();
}
if (navigator.mediaDevices?.addEventListener) {
  try { navigator.mediaDevices.removeEventListener('devicechange', onMediaDeviceChange); } catch {}
  navigator.mediaDevices.addEventListener('devicechange', onMediaDeviceChange);
}
async function renderMediaTab() {
  const box = $('#set-media');
  if (!box) return;
  stopMediaPreview();
  if (!navigator.mediaDevices?.enumerateDevices) {
    box.innerHTML = '<p class="muted small">Device selection is not supported in this browser.</p>';
    return;
  }
  const mp = mediaPrefs();
  const sinkOK = 'setSinkId' in HTMLMediaElement.prototype;
  box.innerHTML = '';
  const h = (t) => { const e = document.createElement('h4'); e.textContent = t; e.style.margin = '1rem 0 .4rem'; box.appendChild(e); };
  const mkLabel = (text) => { const l = document.createElement('label'); l.textContent = text; box.appendChild(l); return l; };
  const mkSelect = (opts, val) => {
    const sel = document.createElement('select');
    for (const [v, l] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = l; if (v === val) o.selected = true; sel.appendChild(o); }
    return sel;
  };
  h('Devices');
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch {}
  if (!box.isConnected) return;
  const mics = devs.filter((d) => d.kind === 'audioinput');
  const cams = devs.filter((d) => d.kind === 'videoinput');
  const spks = devs.filter((d) => d.kind === 'audiooutput');
  const needsPerm = devs.length > 0 && devs.every((d) => !d.label);
  const micSel = mkSelect([['', 'System default'], ...mics.map((d, i) => [d.deviceId, d.label || ('Microphone ' + (i + 1))])], mp.micId);
  mkLabel('Microphone').appendChild(micSel);
  micSel.onchange = () => {
    saveMediaPref('micId', micSel.value);
    toast(micSel.value ? 'Microphone saved' : 'Using system default mic');
    if (mediaPrev?.micStream) startMicTest(micSel.value);
  };
  const camSel = mkSelect([['', 'System default'], ...cams.map((d, i) => [d.deviceId, d.label || ('Camera ' + (i + 1))])], mp.camId);
  mkLabel('Camera').appendChild(camSel);
  camSel.onchange = () => {
    saveMediaPref('camId', camSel.value);
    toast(camSel.value ? 'Camera saved' : 'Using system default camera');
    if (mediaPrev?.camStream) startCamPreview(camSel.value);
  };
  const spkSel = mkSelect([['', 'System default'], ...spks.map((d, i) => [d.deviceId, d.label || ('Speaker ' + (i + 1))])], mp.speakerId);
  mkLabel('Speakers').appendChild(spkSel);
  spkSel.onchange = () => {
    saveMediaPref('speakerId', spkSel.value);
    applySpeakerOutput();
    toast(spkSel.value ? 'Speaker output saved' : 'Using system default output');
  };
  if (!sinkOK) {
    const n = document.createElement('p'); n.className = 'muted small';
    n.textContent = 'This browser always uses the system output — per-device speakers need Chrome or Edge.';
    box.appendChild(n);
  }
  const trow = document.createElement('div'); trow.className = 'row'; trow.style.marginTop = '.5rem';
  const tbtn = document.createElement('button'); tbtn.className = 'btn small'; tbtn.textContent = 'Play test sound';
  tbtn.onclick = () => testSpeakerOutput(spkSel.value);
  trow.appendChild(tbtn);
  if (needsPerm) {
    const en = document.createElement('button'); en.className = 'btn small primary'; en.textContent = 'Detect devices';
    en.onclick = async () => {
      try { const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }); s.getTracks().forEach((t) => t.stop()); } catch {}
      renderMediaTab();
    };
    trow.appendChild(en);
  }
  box.appendChild(trow);
  h('Microphone test');
  const meter = document.createElement('div'); meter.className = 'mic-meter';
  meter.innerHTML = '<i id="media-micbar"></i>';
  box.appendChild(meter);
  const mrow = document.createElement('div'); mrow.className = 'row'; mrow.style.marginTop = '.5rem';
  const mbtn = document.createElement('button'); mbtn.className = 'btn small'; mbtn.id = 'media-mictest'; mbtn.textContent = 'Test microphone';
  mbtn.onclick = () => { if (mediaPrev?.micStream) stopMicTest(); else startMicTest(micSel.value); };
  mrow.appendChild(mbtn);
  box.appendChild(mrow);
  h('Camera preview');
  const pv = document.createElement('div'); pv.className = 'media-preview';
  pv.innerHTML = '<video id="media-camprev" muted playsinline></video>';
  box.appendChild(pv);
  const crow = document.createElement('div'); crow.className = 'row'; crow.style.marginTop = '.5rem';
  const cbtn = document.createElement('button'); cbtn.className = 'btn small'; cbtn.id = 'media-camtest'; cbtn.textContent = 'Preview camera';
  cbtn.onclick = () => { if (mediaPrev?.camStream) stopCamPreview(); else startCamPreview(camSel.value); };
  crow.appendChild(cbtn);
  box.appendChild(crow);
  h('Voice processing');
  const nz = document.createElement('label'); nz.className = 'set-check';
  const nzInp = document.createElement('input'); nzInp.type = 'checkbox'; nzInp.id = 'set-noise'; nzInp.checked = noiseSuppressionEnabled();
  nzInp.onchange = () => { setNoiseSuppression(nzInp.checked); toast(nzInp.checked ? 'Noise suppression on' : 'Noise suppression off'); };
  nz.appendChild(nzInp); nz.appendChild(document.createTextNode(' RNNoise noise suppression — removes fans and background hum'));
  box.appendChild(nz);
  const ec = document.createElement('label'); ec.className = 'set-check';
  const ecInp = document.createElement('input'); ecInp.type = 'checkbox'; ecInp.checked = mp.ec;
  ecInp.onchange = () => { saveMediaPref('ec', ecInp.checked); toast(ecInp.checked ? 'Echo cancellation on' : 'Echo cancellation off'); };
  ec.appendChild(ecInp); ec.appendChild(document.createTextNode(' Echo cancellation'));
  box.appendChild(ec);
  const ag = document.createElement('label'); ag.className = 'set-check';
  const agInp = document.createElement('input'); agInp.type = 'checkbox'; agInp.checked = mp.agc;
  agInp.onchange = () => { saveMediaPref('agc', agInp.checked); toast(agInp.checked ? 'Auto gain control on' : 'Auto gain control off'); };
  ag.appendChild(agInp); ag.appendChild(document.createTextNode(' Automatic gain control — keeps your volume steady'));
  box.appendChild(ag);
  h('Video quality');
  const qSel = mkSelect(Object.entries(V_QUALITY).map(([v, q]) => [v, q.label + (v === 'fhd' ? ' (best)' : '')]), mp.quality);
  mkLabel('Camera resolution').appendChild(qSel);
  qSel.onchange = () => {
    saveMediaPref('quality', qSel.value);
    if (S.voice) for (const [, pc] of S.voice.pcs) for (const s of pc.getSenders()) applySenderQuality(s);
    toast('Video quality saved');
  };
  const note = document.createElement('p'); note.className = 'muted small media-note';
  note.textContent = S.voice
    ? 'Microphone, camera and quality apply to your next call — rejoin to pick them up. Speaker output switches immediately.'
    : 'Microphone, camera and quality apply when you join a call. Speaker output switches immediately.';
  box.appendChild(note);
}
