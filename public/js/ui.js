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
    const { server } = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name }) });
    await refreshServers(server.id);
    S.ws?.send(JSON.stringify({ t: 'subscribe' }));
    showInvite(server);
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
  if (store.token) {
    mkBtn('Join server', true, async () => {
      try {
        const { server } = await api('/api/servers/join', { method: 'POST', body: JSON.stringify({ inviteCode: code }) });
        $('#invite-view').classList.add('hidden');
        await refreshServers(server.id);
        S.ws?.send(JSON.stringify({ t: 'subscribe' }));
        toast(`Joined "${server.name}"`);
      } catch (err) { toast('Join failed: ' + prettyError(err.message)); }
    });
    mkBtn('Cancel', false, () => $('#invite-view').classList.add('hidden'));
  } else {
    mkBtn('Sign in', true, () => { stashInvite(code); $('#invite-view').classList.add('hidden'); setMode('login'); });
    mkBtn('Sign up', false, () => { stashInvite(code); $('#invite-view').classList.add('hidden'); setMode('register'); });
  }
  $('#invite-view').classList.remove('hidden');
}
$('#btn-invite').onclick = () => showInvite(S.serverDetail);
function showInvite(srv) {
  if (!srv) return;
  const url = `${location.origin}/invite/${srv.invite_code}`;
  openModal(`Invite to ${srv.name}`, `
    <p class="muted">Share this code or link — anyone with it can join.</p>
    <div class="codebox">${esc(srv.invite_code)}</div>
    <div class="row"><button class="btn" id="m-copy-code">Copy code</button>
    <button class="btn" id="m-copy-link">Copy link</button></div>
    <div class="chan-group-label" style="padding-left:0">Invite friends directly</div>
    <div id="m-inv-friends"><p class="muted small">Loading friends…</p></div>
    <div class="row" style="margin-top:.5rem"><button class="btn small primary" id="m-inv-send">Send invites</button></div>
  `, 'Done', null);
  $('#m-copy-code').onclick = () => { navigator.clipboard?.writeText(srv.invite_code); toast('Code copied'); };
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
    list.style.cssText = 'max-height:180px;overflow-y:auto';
    for (const f of picks) {
      const lab = document.createElement('label');
      lab.className = 'gpick';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.value = f.id;
      lab.appendChild(cb);
      const nm = document.createElement('span');
      nm.textContent = `${f.display_name} `;
      const un = document.createElement('span');
      un.className = 'muted'; un.textContent = `@${f.username}`;
      nm.appendChild(un); lab.appendChild(nm);
      list.appendChild(lab);
    }
    box.appendChild(list);
  })();
  $('#m-inv-send').onclick = async () => {
    const ids = [...document.querySelectorAll('#m-inv-friends input:checked')].map((i) => i.value);
    if (!ids.length) { toast('Pick at least one friend'); return; }
    try {
      const { sent } = await api(`/api/servers/${srv.id}/invite-friends`, { method: 'POST', body: JSON.stringify({ userIds: ids }) });
      toast(sent === 1 ? 'Invite sent' : `${sent} invites sent`);
      document.querySelectorAll('#m-inv-friends input:checked').forEach((i) => { i.checked = false; });
    } catch (err) { toast('Invite failed: ' + prettyError(err.message)); }
  };
}

// ---------- mobile nav ----------
// ---------- mobile navigation ----------
$('#btn-menu').onclick = () => document.body.classList.toggle('nav-open');
$('#btn-members').onclick = (e) => { e.stopPropagation(); document.body.classList.toggle('members-open'); };
$('#sidebar-scrim').onclick = () => document.body.classList.remove('nav-open');

