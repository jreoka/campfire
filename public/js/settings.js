'use strict';
// ---------- settings (tabbed) ----------
function openSettings(tab = 'profile') {
  setSettingsTab(tab);
  $('#set-display').value = S.me.display_name || '';
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
  $('#set-status').value = S.me.status || 'online';
  $('#set-statustext').value = S.me.status_text || '';
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
function closeSettings() { closePicker(); $('#settings-backdrop').classList.add('hidden'); }
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
  h('Per server');
  if (!S.servers.length) box.appendChild(Object.assign(document.createElement('p'), { className: 'muted small' }));
  for (const s of S.servers) {
    const row = document.createElement('div'); row.className = 'set-row';
    row.innerHTML = `<span class="grow">${esc(s.name)}</span>`;
    row.appendChild(notifSelect('s:' + s.id, notifPrefsCache['s:' + s.id] || ''));
    box.appendChild(row);
  }
  const note = document.createElement('p'); note.className = 'muted small';
  note.textContent = 'Right-click a channel or server for its own rules. DM threads follow the default rule.';
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
  $('#set-notifs').classList.toggle('hidden', t !== 'notifs');
  if (t === 'notifs') renderNotifsTab();
}
document.querySelectorAll('.set-tab').forEach((b) => (b.onclick = () => { setSettingsTab(b.dataset.tab); if (b.dataset.tab === 'account') { renderSecurityTab(); renderDesktopApp(); } }));
$('#btn-settings-rail').onclick = () => openSettings('profile');
$('#set-noise').checked = noiseSuppressionEnabled();
$('#set-noise').addEventListener('change', (e) => setNoiseSuppression(e.target.checked));
$('#btn-home').onclick = openHome;
$('#btn-pins').onclick = openPins;
$('#jump-present').onclick = jumpToPresent;
$('#messages').addEventListener('scroll', () => updatePill(), { passive: true });
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
function updateBioCount() { const b = $('#set-bio'); if (b) $('#set-bio-count').textContent = `${b.value.length} / 300`; }
$('#set-bio').addEventListener('input', updateBioCount);
$('#set-profile-save').onclick = async () => {
  try {
    if ($('#set-namecustom').checked) { try { localStorage.setItem('cf_namecolors', JSON.stringify({ c: $('#set-namecolor').value, g: $('#set-namegrad').value })); } catch {} }
    const { user } = await api('/api/me', { method: 'PATCH', body: JSON.stringify({
      displayName: $('#set-display').value.trim(),
      status: $('#set-status').value,
      statusText: $('#set-statustext').value.trim(),
      bio: $('#set-bio').value,
      nameColor: $('#set-namecustom').checked ? $('#set-namecolor').value : '',
      nameGradient: $('#set-namecustom').checked ? $('#set-namegrad').value : '',
    }) });
    S.me = { ...S.me, ...user };
    paintMe(); renderMembers();
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
