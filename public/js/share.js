'use strict';
// ---------- Web Share Target (Android system share sheet → Campfire) ----------
// The PWA manifest declares a share_target (/share?title=&text=&url=): when
// Campfire is installed, Android lists it in the system share sheet (e.g.
// Share on a YouTube video → Campfire). The service worker serves the app
// shell at /share and this module turns the payload into a "pick a recipient
// + optional message" dialog. Text/URL only — shared files are not accepted.
function stashShare(s) { try { if (s) sessionStorage.setItem('cf_share', JSON.stringify(s)); } catch {} }
function takeShare() {
  try {
    const p = sessionStorage.getItem('cf_share');
    if (p) sessionStorage.removeItem('cf_share');
    return p ? JSON.parse(p) : null;
  } catch { return null; }
}
// Reads + cleans share params (they arrive at the /share action URL, but the
// params are honored on any path). Returns null when nothing was shared.
function consumeShare() {
  let u;
  try { u = new URL(location.href); } catch { return null; }
  const title = (u.searchParams.get('title') || '').trim().slice(0, 200);
  const text = (u.searchParams.get('text') || '').trim().slice(0, 2000);
  const url = (u.searchParams.get('url') || '').trim().slice(0, 2000);
  if (!title && !text && !url) return null;
  u.searchParams.delete('title'); u.searchParams.delete('text'); u.searchParams.delete('url');
  if (u.pathname === '/share') u.pathname = '/';
  try { history.replaceState(null, '', u.pathname + u.search + u.hash); } catch {}
  return { title, text, url };
}
// One shared block: title + text + link, with YouTube-style duplicates
// (the URL often already sits inside text) collapsed to a single copy.
function shareBlock(s) {
  if (!s) return '';
  const parts = [];
  if (s.title && !(s.text || '').includes(s.title)) parts.push(s.title);
  if (s.text) parts.push(s.text);
  if (s.url && !(s.text || '').includes(s.url)) parts.push(s.url);
  return parts.join('\n');
}
async function openShareDialog(share) {
  const block = shareBlock(share);
  if (!block || !S.me) return;
  try { await refreshDms(); } catch {}
  // Text-channel catalog across every joined server (DMs come from S.dms).
  const details = new Map();
  await Promise.all((S.servers || []).map(async (sv) => {
    try {
      const { server } = await api('/api/servers/' + sv.id);
      details.set(sv.id, (server.channels || []).filter((c) => c.type === 'text'));
    } catch {}
  }));
  let picked = null; // {kind:'server'|'dm', serverId?, id, label}
  const previewTitle = share.title || (share.url ? 'Shared link' : 'Shared text');
  openModal('Share to Campfire', `
    <div class="share-preview"><b>${esc(previewTitle)}</b>${share.text ? `<span>${esc(share.text.length > 220 ? share.text.slice(0, 220) + '…' : share.text)}</span>` : ''}${share.url && !(share.text || '').includes(share.url) ? `<a href="${esc(share.url)}" target="_blank" rel="noopener">${esc(share.url.length > 80 ? share.url.slice(0, 80) + '…' : share.url)}</a>` : ''}</div>
    <input id="share-filter" class="share-filter" placeholder="Search channels and people" autocomplete="off" />
    <div id="share-targets" class="share-targets"></div>
    <label style="margin-top:.6rem">Message (optional)<textarea id="share-msg" maxlength="2000" rows="2" placeholder="Say something about this…"></textarea></label>
  `, 'Send', async () => {
    if (!picked) { toast('Pick a channel or person first'); return; }
    const extra = (($('#share-msg') || {}).value || '').trim().slice(0, 2000);
    const content = (extra ? extra + '\n\n' : '') + block;
    if (!S.ws || S.ws.readyState !== 1) { stashShare(share); toast('Not connected — try again in a second'); return; }
    if (picked.kind === 'dm') S.ws.send(JSON.stringify({ t: 'dm', threadId: picked.id, content, attachments: [], replyTo: null }));
    else S.ws.send(JSON.stringify({ t: 'message', serverId: picked.serverId, channelId: picked.id, content, attachments: [], replyTo: null, threadRoot: null }));
    toast('Shared to ' + picked.label);
    if (picked.kind === 'dm') { if (S.view !== 'home') await openHome(); selectDmThread(picked.id); }
    else {
      if (picked.serverId !== S.serverId) await selectServer(picked.serverId);
      await selectChannel(picked.id);
    }
  });
  const box = $('#share-targets');
  const paint = (q) => {
    box.innerHTML = '';
    const query = (q || '').trim().toLowerCase();
    const hit = (s) => !query || (s || '').toLowerCase().includes(query);
    const row = (label, sub, isHash, avUser) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'share-row';
      const ic = document.createElement('span');
      if (avUser) { ic.className = 'avatar'; paintAvatar(ic, avUser); }
      else { ic.className = 'hash'; ic.textContent = '#'; }
      const main = document.createElement('span');
      main.className = 'share-main';
      const nm = document.createElement('span');
      nm.className = 'share-name';
      nm.textContent = label;
      main.appendChild(nm);
      if (sub) { const sb = document.createElement('span'); sb.className = 'share-sub muted'; sb.textContent = sub; main.appendChild(sb); }
      b.append(ic, main);
      b.dataset.key = label + ' ' + (sub || '');
      return b;
    };
    for (const sv of (S.servers || [])) {
      const chans = (details.get(sv.id) || []).filter((c) => hit(c.name) || hit(sv.name));
      if (!chans.length) continue;
      const sec = document.createElement('div');
      sec.className = 'share-sec';
      sec.textContent = sv.name;
      box.appendChild(sec);
      for (const c of chans) {
        const b = row(c.name, sv.name, true, null);
        b.onclick = () => { picked = { kind: 'server', serverId: sv.id, id: c.id, label: '#' + c.name }; syncSel(); };
        b._pick = { kind: 'server', serverId: sv.id, id: c.id };
        box.appendChild(b);
      }
    }
    const dms = (S.dms || []).filter((t) => hit(dmTitle(t)));
    if (dms.length) {
      const sec = document.createElement('div');
      sec.className = 'share-sec';
      sec.textContent = 'Direct messages';
      box.appendChild(sec);
      for (const t of dms) {
        const peer = t.isGroup ? null : dmPeer(t);
        const b = row(dmTitle(t), t.isGroup ? ((t.members || []).length + ' members') : ('@' + ((peer || {}).username || '')), !peer, peer);
        b.onclick = () => { picked = { kind: 'dm', id: t.id, label: dmTitle(t) }; syncSel(); };
        b._pick = { kind: 'dm', id: t.id };
        box.appendChild(b);
      }
    }
    if (!box.children.length) box.innerHTML = '<p class="muted small" style="padding:.5rem 0">Nothing matches — join a server or start a DM first.</p>';
    syncSel();
  };
  const syncSel = () => {
    box.querySelectorAll('.share-row').forEach((b) => {
      const p = b._pick;
      b.classList.toggle('sel', !!picked && !!p && p.kind === picked.kind && p.id === picked.id);
    });
  };
  paint('');
  const f = $('#share-filter');
  if (f) {
    f.oninput = () => paint(f.value);
    f.onkeydown = (e) => e.stopPropagation();
    setTimeout(() => { try { f.focus(); } catch {} }, 0);
  }
}
