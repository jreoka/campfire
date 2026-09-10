'use strict';
// ---------- site admin panel (Settings → Admin, is_admin users only) ----------
// Controls: stats, broadcast, user management (edit / disable / admin role /
// password reset / forced logout / delete) and server management (rename /
// transfer owner / reset invite / members + kick / delete) plus recent-message
// moderation. All data comes from /api/admin/* (server-enforced admin_only).
const Admin = {
  uq: '', uf: 'all', uoff: 0, utotal: 0,
  sq: '', soff: 0, stotal: 0,
  membersOpen: null,
};
const ADMIN_PAGE = 25;

function fmtDate(ts) {
  try { return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return ''; }
}

// Wrap openSettings so the Admin tab only appears for admins (and a stale
// admin deep-link can never land on a dead pane).
(function () {
  const base = openSettings;
  openSettings = function (tab = 'profile') {
    const isAdmin = !!(S.me && S.me.is_admin);
    if (tab === 'admin' && !isAdmin) tab = 'profile';
    base(tab);
    const btn = $('#set-tab-admin');
    if (btn) btn.classList.toggle('hidden', !isAdmin);
  };
})();

async function renderAdminTab() {
  const box = $('#set-admin');
  if (!box) return;
  if (!S.me || !S.me.is_admin) { box.innerHTML = '<p class="muted">Not available.</p>'; return; }
  if (!box.dataset.built) {
    box.dataset.built = '1';
    box.innerHTML = `
      <div id="adm-stats" class="adm-stats"><p class="muted small">Loading…</p></div>
      <div class="pf-sec-label">Users</div>
      <div class="row" style="gap:.4rem">
        <input id="adm-uq" placeholder="Search username or display name…" style="flex:1" autocomplete="off" />
        <select id="adm-uf" style="max-width:130px">
          <option value="all">Everyone</option>
          <option value="admins">Admins</option>
          <option value="disabled">Disabled</option>
        </select>
        <button id="adm-usearch" class="btn small">Search</button>
      </div>
      <div id="adm-users"></div>
      <div class="row end" style="gap:.5rem;align-items:center">
        <button id="adm-uprev" class="btn small">Prev</button>
        <span id="adm-ucount" class="muted small"></span>
        <button id="adm-unext" class="btn small">Next</button>
      </div>
      <div class="pf-sec-label">Servers</div>
      <div class="row" style="gap:.4rem">
        <input id="adm-sq" placeholder="Search servers…" style="flex:1" autocomplete="off" />
        <button id="adm-ssearch" class="btn small">Search</button>
      </div>
      <div id="adm-servers"></div>
      <div class="row end" style="gap:.5rem;align-items:center">
        <button id="adm-sprev" class="btn small">Prev</button>
        <span id="adm-scount" class="muted small"></span>
        <button id="adm-snext" class="btn small">Next</button>
      </div>`;
    const uSearch = () => { Admin.uq = $('#adm-uq').value.trim(); Admin.uf = $('#adm-uf').value; Admin.uoff = 0; loadAdminUsers(); };
    $('#adm-usearch').onclick = uSearch;
    $('#adm-uq').addEventListener('keydown', (e) => { if (e.key === 'Enter') uSearch(); });
    $('#adm-uprev').onclick = () => { Admin.uoff = Math.max(0, Admin.uoff - ADMIN_PAGE); loadAdminUsers(); };
    $('#adm-unext').onclick = () => { if (Admin.uoff + ADMIN_PAGE < Admin.utotal) { Admin.uoff += ADMIN_PAGE; loadAdminUsers(); } };
    const sSearch = () => { Admin.sq = $('#adm-sq').value.trim(); Admin.soff = 0; loadAdminServers(); };
    $('#adm-ssearch').onclick = sSearch;
    $('#adm-sq').addEventListener('keydown', (e) => { if (e.key === 'Enter') sSearch(); });
    $('#adm-sprev').onclick = () => { Admin.soff = Math.max(0, Admin.soff - ADMIN_PAGE); loadAdminServers(); };
    $('#adm-snext').onclick = () => { if (Admin.soff + ADMIN_PAGE < Admin.stotal) { Admin.soff += ADMIN_PAGE; loadAdminServers(); } };
    box.addEventListener('click', adminClick);
  }
  loadAdminStats();
  loadAdminUsers();
  loadAdminServers();
}

async function loadAdminStats() {
  const box = $('#adm-stats');
  if (!box) return;
  try {
    const s = await api('/api/admin/stats');
    const card = (n, l) => `<div class="adm-stat"><b>${n}</b><span>${l}</span></div>`;
    box.innerHTML =
      card(s.users, 'Users') + card(s.servers, 'Servers') +
      card(s.channels, 'Channels') + card(s.messages, 'Messages') +
      card(s.online, 'Online') + card(s.newWeek, 'New this week');
  } catch { box.innerHTML = '<p class="muted small">Could not load stats.</p>'; }
}

function admUserRow(u) {
  const badges =
    (u.is_admin ? '<span class="adm-badge admin">ADMIN</span>' : '') +
    (u.disabled ? '<span class="adm-badge off">DISABLED</span>' : '') +
    (u.has2fa ? '<span class="adm-badge me">2FA</span>' : '') +
    (u.id === S.me.id ? '<span class="adm-badge me">YOU</span>' : '');
  return `<div class="adm-row" data-uid="${esc(u.id)}">
    <span class="avatar adm-av"></span>
    <div class="adm-main">
      <div class="adm-name" style="${nameStyleFor(u)}">${esc(u.display_name)}</div>
      <div class="muted small">@${esc(u.username)} · ${u.serverCount} server${u.serverCount === 1 ? '' : 's'} · ${u.messageCount + u.dmCount} msgs · joined ${fmtDate(u.created_at)}</div>
      <div class="adm-badges">${badges}</div>
      <div class="adm-actions">
        <button class="mini" data-act="u-edit">Edit</button>
        <button class="mini" data-act="u-pw">Password</button>
        <button class="mini${u.disabled ? '' : ' danger'}" data-act="u-disable">${u.disabled ? 'Enable' : 'Disable'}</button>
        <button class="mini" data-act="u-admin">${u.is_admin ? 'Remove admin' : 'Make admin'}</button>
        <button class="mini" data-act="u-logout">Log out</button>
        <button class="mini" data-act="u-2fa">Reset 2FA</button>
        <button class="mini danger" data-act="u-del">Delete</button>
      </div>
    </div>
  </div>`;
}

async function loadAdminUsers() {
  const box = $('#adm-users');
  if (!box) return;
  box.innerHTML = '<p class="muted small">Loading…</p>';
  try {
    const { users, total } = await api(
      `/api/admin/users?q=${encodeURIComponent(Admin.uq)}&filter=${Admin.uf}&limit=${ADMIN_PAGE}&offset=${Admin.uoff}`);
    Admin.utotal = total;
    box.innerHTML = users.length ? users.map(admUserRow).join('') : '<p class="muted small">No users found.</p>';
    box.querySelectorAll('.adm-av').forEach((el) => {
      const row = el.closest('.adm-row');
      const u = users.find((x) => x.id === row.dataset.uid);
      if (u) paintAvatar(el, u);
    });
    const c = $('#adm-ucount');
    if (c) c.textContent = total ? `${Admin.uoff + 1}–${Math.min(Admin.uoff + users.length, total)} of ${total}` : '';
  } catch { box.innerHTML = '<p class="muted small">Could not load users.</p>'; }
}

function admServerRow(s) {
  const open = Admin.membersOpen === s.id;
  return `<div class="adm-row" data-sid="${esc(s.id)}">
    <span class="avatar adm-sav"></span>
    <div class="adm-main">
      <div class="adm-name">${esc(s.name)}</div>
      <div class="muted small">owner @${esc(s.owner_username)} · ${s.memberCount} member${s.memberCount === 1 ? '' : 's'} · ${s.channelCount} channels · ${s.messageCount} msgs · created ${fmtDate(s.created_at)}</div>
      <div class="muted small">invite links: ${s.inviteCount}</div>
      <div class="adm-actions">
        <button class="mini" data-act="s-edit">Edit</button>
        <button class="mini" data-act="s-members">${open ? 'Hide members' : 'Members'}</button>
        <button class="mini danger" data-act="s-del">Delete</button>
      </div>
      <div class="adm-members${open ? '' : ' hidden'}"></div>
    </div>
  </div>`;
}

function pickFile(cb) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/png,image/jpeg,image/gif,image/webp';
  inp.onchange = () => { if (inp.files[0]) cb(inp.files[0]); };
  inp.click();
}
function paintServerIcon(el, s) {
  const label = (s.name || '?').trim().charAt(0).toUpperCase() || '?';
  el.innerHTML = '';
  if (s.icon_url) {
    const img = document.createElement('img');
    img.src = s.icon_url; img.alt = ''; img.loading = 'lazy';
    img.onerror = () => { el.innerHTML = ''; el.textContent = label; };
    el.appendChild(img);
  } else {
    el.textContent = label;
  }
}

async function loadAdminServers() {
  const box = $('#adm-servers');
  if (!box) return;
  box.innerHTML = '<p class="muted small">Loading…</p>';
  try {
    const { servers, total } = await api(
      `/api/admin/servers?q=${encodeURIComponent(Admin.sq)}&limit=${ADMIN_PAGE}&offset=${Admin.soff}`);
    Admin.stotal = total;
    Admin.sCache = servers;
    box.innerHTML = servers.length ? servers.map(admServerRow).join('') : '<p class="muted small">No servers found.</p>';
    box.querySelectorAll('.adm-sav').forEach((el) => {
      const row = el.closest('.adm-row');
      const s = servers.find((x) => x.id === row.dataset.sid);
      if (s) paintServerIcon(el, s);
    });
    const c = $('#adm-scount');
    if (c) c.textContent = total ? `${Admin.soff + 1}–${Math.min(Admin.soff + servers.length, total)} of ${total}` : '';
    if (Admin.membersOpen) {
      const row = box.querySelector(`[data-sid="${CSS.escape(Admin.membersOpen)}"] .adm-members`);
      if (row) loadAdminMembers(Admin.membersOpen, row);
      else Admin.membersOpen = null;
    }
  } catch { box.innerHTML = '<p class="muted small">Could not load servers.</p>'; }
}

async function loadAdminMembers(sid, slot) {
  slot = slot || document.querySelector(`#adm-servers [data-sid="${CSS.escape(sid)}"] .adm-members`);
  if (!slot) return;
  slot.innerHTML = '<p class="muted small">Loading…</p>';
  try {
    const { members } = await api(`/api/admin/servers/${sid}/members`);
    slot.innerHTML = members.length ? members.map((m) =>
      `<div class="adm-subrow" data-uid="${esc(m.id)}">
        <span class="adm-subname" style="${nameStyleFor(m)}">${esc(m.display_name)}</span>
        <span class="muted small">@${esc(m.username)}${m.role === 'owner' ? ' · owner' : ''}${m.disabled ? ' · disabled' : ''}</span>
        <span class="spacer"></span>
        ${m.role === 'owner' ? '' : `<button class="mini" data-act="s-owner">Make owner</button>
        <button class="mini danger" data-act="s-kick">Kick</button>`}
      </div>`).join('') : '<p class="muted small">No members.</p>';
  } catch { slot.innerHTML = '<p class="muted small">Could not load members.</p>'; }
}

// One delegated handler for every admin row button.
async function adminClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  const urow = b.closest('.adm-row[data-uid]');
  const srow = b.closest('.adm-row[data-sid]');
  const sub = b.closest('.adm-subrow[data-uid]');
  try {
    if (act === 'u-edit' && urow) {
      let { user: u } = await api(`/api/admin/users/${urow.dataset.uid}`);
      if (!u) return toast('User not found');
      openModal(`Edit @${u.username}`, `
        <label>Display name<input id="m-adm-display" maxlength="32" value="${esc(u.display_name)}" /></label>
        <label style="margin-top:.6rem">Bio<textarea id="m-adm-bio" maxlength="300" rows="3">${esc(u.bio || '')}</textarea></label>
        <div class="pf-sec-label">Avatar</div>
        <div class="row" style="gap:.6rem"><span class="avatar adm-av" id="m-adm-avatar"></span>
          <button class="btn small primary" id="m-adm-avatar-up">Upload</button>
          <button class="btn small" id="m-adm-avatar-rm">Remove</button></div>
        <div class="pf-sec-label">Banner</div>
        <div id="m-adm-banner" class="set-banner"></div>
        <div class="row" style="margin-top:.5rem;gap:.4rem"><button class="btn small primary" id="m-adm-banner-up">Upload</button><button class="btn small" id="m-adm-banner-rm">Remove</button></div>
        <div class="pf-sec-label">Member list banner</div>
        <div id="m-adm-side" class="set-banner"></div>
        <div class="row" style="margin-top:.5rem;gap:.4rem"><button class="btn small primary" id="m-adm-side-up">Upload</button><button class="btn small" id="m-adm-side-rm">Remove</button></div>
      `, 'Save', async () => {
        await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({
          displayName: $('#m-adm-display').value.trim(),
          bio: $('#m-adm-bio').value,
        }) });
        toast('User updated');
        loadAdminUsers();
      }, { wide: true });
      const paintUMedia = (usr) => {
        paintAvatar($('#m-adm-avatar'), usr);
        $('#m-adm-banner').style.backgroundImage = usr.banner_url ? `url('${usr.banner_url}')` : '';
        $('#m-adm-side').style.backgroundImage = usr.sidebar_banner_url ? `url('${usr.sidebar_banner_url}')` : '';
      };
      paintUMedia(u);
      const upUMedia = (kind, label) => pickFile(async (f) => {
        try {
          const data = await uploadImage(`/api/admin/users/${u.id}/${kind}`, f);
          u = data.user; paintUMedia(u);
          toast(label + ' updated');
          loadAdminUsers();
        } catch (err) { toast('Upload failed: ' + prettyError(err.message)); }
      });
      const rmUMedia = (kind, label) => (async () => {
        try {
          const data = await api(`/api/admin/users/${u.id}/${kind}`, { method: 'DELETE' });
          u = data.user; paintUMedia(u);
          toast(label + ' removed');
          loadAdminUsers();
        } catch (err) { toast('Failed: ' + prettyError(err.message)); }
      })();
      $('#m-adm-avatar-up').onclick = () => upUMedia('avatar', 'Avatar');
      $('#m-adm-avatar-rm').onclick = () => rmUMedia('avatar', 'Avatar');
      $('#m-adm-banner-up').onclick = () => upUMedia('banner', 'Banner');
      $('#m-adm-banner-rm').onclick = () => rmUMedia('banner', 'Banner');
      $('#m-adm-side-up').onclick = () => upUMedia('sidebar-banner', 'Member list banner');
      $('#m-adm-side-rm').onclick = () => rmUMedia('sidebar-banner', 'Member list banner');
    }
    else if (act === 'u-pw' && urow) {
      const pw = await openPromptModal({ title: 'Set new password', label: 'New password (min 4 chars)', placeholder: '••••••', okLabel: 'Set password', maxlength: 64 });
      if (!pw) return;
      await api(`/api/admin/users/${urow.dataset.uid}`, { method: 'PATCH', body: JSON.stringify({ password: pw }) });
      toast('Password reset — user is logged out everywhere');
      loadAdminUsers();
    }
    else if (act === 'u-disable' && urow) {
      const row = urow;
      const dis = row.querySelector('[data-act="u-disable"]').textContent.trim() !== 'Enable';
      if (urow.dataset.uid === S.me.id) return toast('You cannot disable yourself');
      const ok = await openConfirmModal({
        title: (dis ? 'Disable @' : 'Enable @') + 'user?',
        message: dis ? 'They will be logged out immediately and cannot log back in until re-enabled.' : 'They will be able to log in again.',
        okLabel: dis ? 'Disable' : 'Enable',
      });
      if (!ok) return;
      await api(`/api/admin/users/${urow.dataset.uid}`, { method: 'PATCH', body: JSON.stringify({ disabled: dis }) });
      toast(dis ? 'User disabled' : 'User enabled');
      loadAdminUsers();
    }
    else if (act === 'u-admin' && urow) {
      const make = b.textContent.trim() === 'Make admin';
      if (urow.dataset.uid === S.me.id && !make) return toast('You cannot remove your own admin role');
      const ok = await openConfirmModal({
        title: `${make ? 'Make' : 'Remove'} admin?`,
        message: make ? 'They will get full control over all users and servers.' : 'They will lose access to the admin panel.',
        okLabel: make ? 'Make admin' : 'Remove',
      });
      if (!ok) return;
      await api(`/api/admin/users/${urow.dataset.uid}`, { method: 'PATCH', body: JSON.stringify({ is_admin: make }) });
      toast(make ? 'Admin granted' : 'Admin removed');
      loadAdminUsers();
    }
    else if (act === 'u-logout' && urow) {
      const ok = await openConfirmModal({ title: 'Log user out everywhere?', message: 'All of their sessions are revoked immediately.', okLabel: 'Log out' });
      if (!ok) return;
      await api(`/api/admin/users/${urow.dataset.uid}/sessions/revoke`, { method: 'POST' });
      toast('User logged out');
    }
    else if (act === 'u-2fa' && urow) {
      if (urow.dataset.uid === S.me.id) return toast('Use your own Settings to manage your 2FA');
      const ok = await openConfirmModal({ title: 'Reset 2FA for this user?', message: 'Their authenticator and backup codes are removed. They can log in with just their password again and re-enable 2FA later.', okLabel: 'Reset 2FA' });
      if (!ok) return;
      await api(`/api/admin/users/${urow.dataset.uid}/2fa/disable`, { method: 'POST' });
      toast('2FA reset — they can log in with password again');
      loadAdminUsers();
    }
    else if (act === 'u-del' && urow) {
      if (urow.dataset.uid === S.me.id) return toast('You cannot delete yourself');
      const ok = await openConfirmModal({ title: 'Delete this user?', message: 'Their account, messages authorship aside, is removed permanently. This cannot be undone.', okLabel: 'Delete' });
      if (!ok) return;
      await api(`/api/admin/users/${urow.dataset.uid}`, { method: 'DELETE' });
      toast('User deleted');
      loadAdminStats(); loadAdminUsers();
    }
    else if (act === 's-edit' && srow) {
      const sid = srow.dataset.sid;
      let s = (Admin.sCache || []).find((x) => x.id === sid);
      if (!s) return toast('Server not found');
      openModal(`Edit ${s.name}`, `
        <label>Server name<input id="m-adm-sname" maxlength="48" value="${esc(s.name)}" /></label>
        <label style="margin-top:.6rem">Description<textarea id="m-adm-sdesc" maxlength="200" rows="2" placeholder="What is this server about?">${esc(s.description || '')}</textarea></label>
        <div class="pf-sec-label">Server icon</div>
        <div class="row" style="gap:.6rem"><span class="avatar adm-sav" id="m-adm-sicon"></span>
          <button class="btn small primary" id="m-adm-sicon-up">Upload</button>
          <button class="btn small" id="m-adm-sicon-rm">Remove</button></div>
        <div class="pf-sec-label">Banner</div>
        <div id="m-adm-sbanner" class="set-banner"></div>
        <div class="row" style="margin-top:.5rem;gap:.4rem"><button class="btn small primary" id="m-adm-sbanner-up">Upload</button><button class="btn small" id="m-adm-sbanner-rm">Remove</button></div>
      `, 'Save', async () => {
        await api(`/api/admin/servers/${sid}`, { method: 'PATCH', body: JSON.stringify({
          name: $('#m-adm-sname').value.trim(),
          description: $('#m-adm-sdesc').value.trim(),
        }) });
        toast('Server updated');
        loadAdminServers();
        refreshServers();
        S.ws?.send(JSON.stringify({ t: 'subscribe' }));
      }, { wide: true });
      const paintSMedia = (srv) => {
        paintServerIcon($('#m-adm-sicon'), srv);
        $('#m-adm-sbanner').style.backgroundImage = srv.banner_url ? `url('${srv.banner_url}')` : '';
      };
      paintSMedia(s);
      const afterSMedia = (srv, label) => {
        s = srv;
        const i = (Admin.sCache || []).findIndex((x) => x.id === sid);
        if (i >= 0) Admin.sCache[i] = srv;
        paintSMedia(srv);
        toast(label);
        loadAdminServers();
        refreshServers();
        S.ws?.send(JSON.stringify({ t: 'subscribe' }));
      };
      $('#m-adm-sicon-up').onclick = () => pickFile(async (f) => {
        try {
          const data = await uploadImage(`/api/admin/servers/${sid}/icon`, f);
          afterSMedia(data.server, 'Server icon updated');
        } catch (err) { toast('Upload failed: ' + prettyError(err.message)); }
      });
      $('#m-adm-sicon-rm').onclick = async () => {
        try {
          const data = await api(`/api/admin/servers/${sid}/icon`, { method: 'DELETE' });
          afterSMedia(data.server, 'Server icon removed');
        } catch (err) { toast('Failed: ' + prettyError(err.message)); }
      };
      $('#m-adm-sbanner-up').onclick = () => pickFile(async (f) => {
        try {
          const data = await uploadImage(`/api/admin/servers/${sid}/banner`, f);
          afterSMedia(data.server, 'Banner updated');
        } catch (err) { toast('Upload failed: ' + prettyError(err.message)); }
      });
      $('#m-adm-sbanner-rm').onclick = async () => {
        try {
          const data = await api(`/api/admin/servers/${sid}/banner`, { method: 'DELETE' });
          afterSMedia(data.server, 'Banner removed');
        } catch (err) { toast('Failed: ' + prettyError(err.message)); }
      };
    }
    else if (act === 's-members' && srow) {
      const sid = srow.dataset.sid;
      Admin.membersOpen = Admin.membersOpen === sid ? null : sid;
      loadAdminServers();
    }
    else if (act === 's-kick' && srow && sub) {
      const ok = await openConfirmModal({ title: 'Kick this member?', message: 'They leave the server immediately and must rejoin with an invite.', okLabel: 'Kick' });
      if (!ok) return;
      await api(`/api/admin/servers/${srow.dataset.sid}/members/${sub.dataset.uid}`, { method: 'DELETE' });
      toast('Member kicked');
      loadAdminMembers(srow.dataset.sid);
      loadAdminServers();
    }
    else if (act === 's-owner' && srow && sub) {
      const ok = await openConfirmModal({ title: 'Transfer ownership?', message: 'They become the new server owner.', okLabel: 'Transfer' });
      if (!ok) return;
      await api(`/api/admin/servers/${srow.dataset.sid}`, { method: 'PATCH', body: JSON.stringify({ owner_id: sub.dataset.uid }) });
      toast('Ownership transferred');
      loadAdminServers();
      refreshServers();
    }
    else if (act === 's-del' && srow) {
      const ok = await openConfirmModal({ title: 'Delete this server?', message: 'Every channel and message in it is destroyed forever. This cannot be undone.', okLabel: 'Delete' });
      if (!ok) return;
      await api(`/api/admin/servers/${srow.dataset.sid}`, { method: 'DELETE' });
      toast('Server deleted');
      if (Admin.membersOpen === srow.dataset.sid) Admin.membersOpen = null;
      loadAdminStats(); loadAdminServers();
      await refreshServers();
      S.ws?.send(JSON.stringify({ t: 'subscribe' }));
    }
  } catch (err) { toast('Failed: ' + prettyError(err.message)); }
}
