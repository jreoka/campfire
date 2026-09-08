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
function fmtDT(ts) {
  try {
    return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
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
      <div class="pf-sec-label">Broadcast to everyone online</div>
      <div class="row" style="gap:.4rem">
        <input id="adm-announce" maxlength="500" placeholder="Message all online users…" style="flex:1" autocomplete="off" />
        <button id="adm-send" class="btn small primary">Send</button>
      </div>
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
      </div>
      <div class="pf-sec-label">Recent messages</div>
      <div id="adm-msgs"><p class="muted small">Loading…</p></div>`;
    $('#adm-send').onclick = async () => {
      const inp = $('#adm-announce');
      const text = inp.value.trim();
      if (!text) return;
      try {
        const { delivered } = await api('/api/admin/announce', { method: 'POST', body: JSON.stringify({ text }) });
        inp.value = '';
        toast(`Sent to ${delivered} session${delivered === 1 ? '' : 's'}`);
      } catch (err) { toast('Broadcast failed: ' + prettyError(err.message)); }
    };
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
  loadAdminRecent();
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
    <span class="avatar adm-sav">${esc((s.name || '?').trim().charAt(0).toUpperCase())}</span>
    <div class="adm-main">
      <div class="adm-name">${esc(s.name)}</div>
      <div class="muted small">owner @${esc(s.owner_username)} · ${s.memberCount} member${s.memberCount === 1 ? '' : 's'} · ${s.channelCount} channels · ${s.messageCount} msgs · created ${fmtDate(s.created_at)}</div>
      <div class="muted small">invite <span class="codebox-inline">${esc(s.invite_code)}</span></div>
      <div class="adm-actions">
        <button class="mini" data-act="s-rename">Rename</button>
        <button class="mini" data-act="s-invite">Reset invite</button>
        <button class="mini" data-act="s-members">${open ? 'Hide members' : 'Members'}</button>
        <button class="mini danger" data-act="s-del">Delete</button>
      </div>
      <div class="adm-members${open ? '' : ' hidden'}"></div>
    </div>
  </div>`;
}

async function loadAdminServers() {
  const box = $('#adm-servers');
  if (!box) return;
  box.innerHTML = '<p class="muted small">Loading…</p>';
  try {
    const { servers, total } = await api(
      `/api/admin/servers?q=${encodeURIComponent(Admin.sq)}&limit=${ADMIN_PAGE}&offset=${Admin.soff}`);
    Admin.stotal = total;
    box.innerHTML = servers.length ? servers.map(admServerRow).join('') : '<p class="muted small">No servers found.</p>';
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

async function loadAdminRecent() {
  const box = $('#adm-msgs');
  if (!box) return;
  box.innerHTML = '<p class="muted small">Loading…</p>';
  try {
    const { messages } = await api('/api/admin/messages/recent?limit=30');
    box.innerHTML = messages.length ? messages.map((m) =>
      `<div class="adm-subrow" data-mid="${esc(m.id)}">
        <div class="adm-main">
          <div><strong>${esc(m.display_name || m.username || 'deleted')}</strong>
          <span class="muted small">@${esc(m.username || '?')} · #${esc(m.channel_name || '?')} · ${esc(m.server_name || '?')} · ${fmtDT(m.created_at)}</span></div>
          <div class="adm-snippet">${esc(String(m.content || '').slice(0, 200))}</div>
        </div>
        <button class="mini danger" data-act="m-del">Delete</button>
      </div>`).join('') : '<p class="muted small">No messages yet.</p>';
  } catch { box.innerHTML = '<p class="muted small">Could not load messages.</p>'; }
}

// One delegated handler for every admin row button.
async function adminClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  const urow = b.closest('.adm-row[data-uid]');
  const srow = b.closest('.adm-row[data-sid]');
  const sub = b.closest('.adm-subrow[data-uid]');
  const msg = b.closest('.adm-subrow[data-mid]');
  try {
    if (act === 'u-edit' && urow) {
      const { user: u } = await api(`/api/admin/users/${urow.dataset.uid}`);
      if (!u) return toast('User not found');
      openModal(`Edit @${u.username}`, `
        <label>Display name<input id="m-adm-display" maxlength="32" value="${esc(u.display_name)}" /></label>
        <div class="row" style="margin-top:.6rem;gap:.6rem">
          <label style="flex:1">Avatar color<input id="m-adm-color" type="color" value="${/^#[0-9a-fA-F]{6}$/.test(u.avatar_color) ? u.avatar_color : '#5865f2'}" /></label>
        </div>
        <label style="margin-top:.6rem">Bio<textarea id="m-adm-bio" maxlength="300" rows="3">${esc(u.bio || '')}</textarea></label>
      `, 'Save', async () => {
        await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({
          displayName: $('#m-adm-display').value.trim(),
          avatarColor: $('#m-adm-color').value,
          bio: $('#m-adm-bio').value,
        }) });
        toast('User updated');
        loadAdminUsers();
      });
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
    else if (act === 'u-del' && urow) {
      if (urow.dataset.uid === S.me.id) return toast('You cannot delete yourself');
      const ok = await openConfirmModal({ title: 'Delete this user?', message: 'Their account, messages authorship aside, is removed permanently. This cannot be undone.', okLabel: 'Delete' });
      if (!ok) return;
      await api(`/api/admin/users/${urow.dataset.uid}`, { method: 'DELETE' });
      toast('User deleted');
      loadAdminStats(); loadAdminUsers();
    }
    else if (act === 's-rename' && srow) {
      const name = await openPromptModal({ title: 'Rename server', label: 'Server name', initial: srow.querySelector('.adm-name').textContent, okLabel: 'Rename', maxlength: 48 });
      if (!name || !name.trim()) return;
      await api(`/api/admin/servers/${srow.dataset.sid}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) });
      toast('Server renamed');
      loadAdminServers();
      refreshServers();
      S.ws?.send(JSON.stringify({ t: 'subscribe' }));
    }
    else if (act === 's-invite' && srow) {
      const { invite_code } = await api(`/api/admin/servers/${srow.dataset.sid}/invite/reset`, { method: 'POST' });
      toast(`New invite code: ${invite_code}`);
      loadAdminServers();
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
    else if (act === 'm-del' && msg) {
      const ok = await openConfirmModal({ title: 'Delete this message?', message: 'It is removed for everyone.', okLabel: 'Delete' });
      if (!ok) return;
      await api(`/api/admin/messages/${msg.dataset.mid}`, { method: 'DELETE' });
      toast('Message deleted');
      loadAdminRecent();
    }
  } catch (err) { toast('Failed: ' + prettyError(err.message)); }
}
