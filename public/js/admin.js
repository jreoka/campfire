'use strict';
// ---------- site admin console (rail shield button, is_admin users only) ----------
// A surface of its own rather than a Settings tab: the shield under the
// create-server button opens it, with a tab per area (Overview / Media / Users
// / Servers). All data comes from /api/admin/* (server-enforced admin_only)
// and every row action is delegated through adminClick().
const Admin = {
  tab: 'overview',
  uq: '', uf: 'all', uoff: 0, utotal: 0,
  sq: '', soff: 0, stotal: 0,
  membersOpen: null,
  stats: null, statsAt: 0, statsErr: false, poll: null, refreshSoon: null,
};
const ADMIN_PAGE = 25;
// Recent-files card in Admin → Media: fetch this many, scroll inside the card.
const ADMIN_MEDIA_RECENT = 12;

function fmtDate(ts) {
  try { return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return ''; }
}

function isSiteAdmin() { return !!(S.me && S.me.is_admin); }
function adminConsoleOpen() { return !!($('#admin-backdrop') && !$('#admin-backdrop').classList.contains('hidden')); }

function openAdminConsole(tab) {
  if (!isSiteAdmin()) { toast('Site admins only'); return; }
  const box = $('#admin-backdrop');
  if (!box) return;
  try { document.body.classList.remove('nav-open'); } catch {} // mobile drawer out of the way
  box.classList.remove('hidden');
  try { $('#btn-admin')?.classList.add('active'); } catch {}
  setAdminTab(tab || Admin.tab || 'overview');
}
function closeAdminConsole() {
  try { $('#admin-backdrop')?.classList.add('hidden'); } catch {}
  try { $('#btn-admin')?.classList.remove('active'); } catch {}
  stopAdminStatsLive();
}

// Panes are built the first time their tab opens and refreshed on every visit:
// the numbers move between opens and the list panes are search-driven.
function setAdminTab(t) {
  if (!isSiteAdmin()) return;
  Admin.tab = t;
  document.querySelectorAll('#admin-backdrop .set-tab').forEach((b) => b.classList.toggle('active', b.dataset.atab === t));
  for (const key of ['overview', 'media', 'users', 'servers']) {
    const pane = document.getElementById('adm-' + key);
    if (pane) pane.classList.toggle('hidden', key !== t);
  }
  if (t === 'overview') { ensureAdminOverviewPane(); loadAdminStats(); startAdminStatsLive(); }
  else if (t === 'media') loadAdminMedia();
  else if (t === 'users') { ensureAdminUsersPane(); loadAdminUsers(); }
  else if (t === 'servers') { ensureAdminServersPane(); loadAdminServers(); }
  if (t !== 'overview') stopAdminStatsLive();
}

function ensureAdminOverviewPane() {
  const pane = $('#adm-overview');
  if (!pane || pane.dataset.built) return;
  pane.dataset.built = '1';
  pane.innerHTML = '<div id="adm-stats" class="adm-stats"><p class="muted small">Loading…</p></div>';
}

function ensureAdminUsersPane() {
  const pane = $('#adm-users');
  if (!pane || pane.dataset.built) return;
  pane.dataset.built = '1';
  pane.innerHTML = `
    <div class="row" style="gap:.4rem">
      <input id="adm-uq" placeholder="Search username or display name…" style="flex:1" autocomplete="off" />
      <select id="adm-uf" style="max-width:130px">
        <option value="all">Everyone</option>
        <option value="admins">Admins</option>
        <option value="disabled">Disabled</option>
      </select>
      <button id="adm-usearch" class="btn small">Search</button>
    </div>
    <div id="adm-users-list"></div>
    <div class="row end" style="gap:.5rem;align-items:center">
      <button id="adm-uprev" class="btn small">Prev</button>
      <span id="adm-ucount" class="muted small"></span>
      <button id="adm-unext" class="btn small">Next</button>
    </div>`;
  const uSearch = () => { Admin.uq = $('#adm-uq').value.trim(); Admin.uf = $('#adm-uf').value; Admin.uoff = 0; loadAdminUsers(); };
  $('#adm-usearch').onclick = uSearch;
  $('#adm-uq').addEventListener('keydown', (e) => { if (e.key === 'Enter') uSearch(); });
  $('#adm-uprev').onclick = () => { Admin.uoff = Math.max(0, Admin.uoff - ADMIN_PAGE); loadAdminUsers(); };
  $('#adm-unext').onclick = () => { if (Admin.uoff + ADMIN_PAGE < Admin.utotal) { Admin.uoff += ADMIN_PAGE; loadAdminUsers(); } };
}

function ensureAdminServersPane() {
  const pane = $('#adm-servers');
  if (!pane || pane.dataset.built) return;
  pane.dataset.built = '1';
  pane.innerHTML = `
    <div class="row" style="gap:.4rem">
      <input id="adm-sq" placeholder="Search servers…" style="flex:1" autocomplete="off" />
      <button id="adm-ssearch" class="btn small">Search</button>
    </div>
    <div id="adm-servers-list"></div>
    <div class="row end" style="gap:.5rem;align-items:center">
      <button id="adm-sprev" class="btn small">Prev</button>
      <span id="adm-scount" class="muted small"></span>
      <button id="adm-snext" class="btn small">Next</button>
    </div>`;
  const sSearch = () => { Admin.sq = $('#adm-sq').value.trim(); Admin.soff = 0; loadAdminServers(); };
  $('#adm-ssearch').onclick = sSearch;
  $('#adm-sq').addEventListener('keydown', (e) => { if (e.key === 'Enter') sSearch(); });
  $('#adm-sprev').onclick = () => { Admin.soff = Math.max(0, Admin.soff - ADMIN_PAGE); loadAdminServers(); };
  $('#adm-snext').onclick = () => { if (Admin.soff + ADMIN_PAGE < Admin.stotal) { Admin.soff += ADMIN_PAGE; loadAdminServers(); } };
}

// ---------- overview ----------
// Renders from Admin.stats (the last full payload) with whatever the server
// pushed since. Two live feeds keep it current without a manual refresh: the
// WS 'admin-presence' push (instant, on every connect/disconnect/status flip —
// it carries a fresh online/session count) and a slow poll while the pane is
// open, which picks up the DB-backed counts (users/servers/channels/messages)
// changing because of other people's actions.
const ADMIN_STATS_POLL_MS = 10000;

function renderAdminStats() {
  const box = $('#adm-stats');
  if (!box || !Admin.stats) return;
  const s = Admin.stats;
  const sessions = Number(s.sessions) || 0;
  const when = Admin.statsErr ? 'reconnecting…' : (Admin.statsAt ? 'updated ' + agoStr(Admin.statsAt) : 'live');
  const card = (n, l, sub) => `<div class="adm-stat"><b>${n}</b><span>${l}</span>${sub ? `<em>${esc(sub)}</em>` : ''}</div>`;
  box.innerHTML =
    card(s.users, 'Users') + card(s.servers, 'Servers') +
    card(s.channels, 'Channels') + card(s.messages, 'Messages') +
    card(s.online, 'Online', sessions ? `${sessions} session${sessions === 1 ? '' : 's'}` : '') +
    card(s.newWeek, 'New this week') +
    `<div class="adm-note muted small">Live · ${esc(when)}</div>`;
}

async function loadAdminStats() {
  const box = $('#adm-stats');
  if (!box) return;
  try {
    const s = await api('/api/admin/stats');
    Admin.stats = s; Admin.statsAt = Date.now(); Admin.statsErr = false;
    renderAdminStats();
  } catch {
    // A background refresh that fails (server restart, lost network) keeps the
    // last numbers on screen and just flags the note, instead of blanking out.
    Admin.statsErr = true;
    if (Admin.stats) renderAdminStats();
    else box.innerHTML = '<p class="muted small">Could not load stats.</p>';
  }
}

// Server push (t:'admin-presence'): apply the fresh counts in place, then pull
// the rest of the cards once behind a short debounce so a burst of people
// connecting is a single fetch rather than one per socket.
function adminPresence(online, sessions) {
  if (!Admin.stats) return;
  if (Admin.stats.online !== online || Admin.stats.sessions !== sessions) {
    Admin.stats.online = online; Admin.stats.sessions = sessions;
    if (adminConsoleOpen() && Admin.tab === 'overview') renderAdminStats();
  }
  if (Admin.refreshSoon) return;
  Admin.refreshSoon = setTimeout(() => {
    Admin.refreshSoon = null;
    if (adminConsoleOpen() && Admin.tab === 'overview' && !document.hidden) loadAdminStats();
  }, 2000);
}

function startAdminStatsLive() {
  if (Admin.poll) return;
  Admin.poll = setInterval(() => {
    // The numbers matter only while someone is looking at them.
    if (document.hidden || !adminConsoleOpen() || Admin.tab !== 'overview') return;
    loadAdminStats();
  }, ADMIN_STATS_POLL_MS);
}
function stopAdminStatsLive() {
  if (Admin.poll) { clearInterval(Admin.poll); Admin.poll = null; }
}

// ---------- media compression monitor ----------
function scanLine(sc) {
  if (!sc) return '';
  const eng = { off: 'OFF', none: 'NO ENGINE (fail-open)', starting: 'STARTING', ready: 'READY', failed: 'ENGINE FAILED (fail-open)' }[sc.engine || ''] || String(sc.engine || '?');
  const c = sc.counts || {};
  const sig = sc.dbPresent ? `signatures ${sc.dbAgeMs != null ? agoStr(Date.now() - sc.dbAgeMs) : 'present'}` : 'no signatures';
  return `Virus scan: ${esc(eng)} · pending ${c.pending || 0} · infected ${c.infected || 0} · errors ${c.error || 0} · ${esc(sig)}`;
}
function sweepLine(sw) {
  if (!sw) return '';
  if (!sw.enabled) return ' · Orphan sweep: OFF';
  const r = sw.lastResult;
  const last = sw.lastRunAt ? agoStr(sw.lastRunAt) : 'never';
  const what = r ? `${r.deleted} deleted (${fmtSize(r.bytes || 0)}) from ${r.scanned} stored` : 'no run yet';
  return ` · Orphan sweep: ${esc(what)} · last ${esc(last)} · every 24h, grace ${sw.graceH || 48}h`;
}
// Where the bytes went: media total (backups/ excluded), a per-prefix split
// with share bars, and what the database still points at. Server-cached for
// 10 minutes; Recompute forces a fresh listing.
function storageCard(usage, tracked) {
  if (!usage) return '<p class="muted small">Storage usage unavailable.</p>';
  const t = usage.total || { bytes: 0, objects: 0 };
  const bk = usage.backups || { bytes: 0, objects: 0 };
  const card = (n, l) => `<div class="adm-stat"><b>${n}</b><span>${l}</span></div>`;
  const rows = (usage.prefixes || []).map((p) => {
    const pct = t.bytes ? Math.max(1, Math.round((p.bytes / t.bytes) * 100)) : 0;
    return `<div class="adm-subrow">
      <span class="adm-subname" style="flex:0 0 72px">${esc(p.prefix)}</span>
      <span class="muted small" style="flex:0 0 62px">${p.objects} file${p.objects === 1 ? '' : 's'}</span>
      <span class="scan-track" style="flex:1;margin-top:0"><span class="scan-fill" style="width:${pct}%;animation:none"></span></span>
      <span class="muted small" style="flex:0 0 74px;text-align:right">${fmtSize(p.bytes)}</span>
      <span class="muted small" style="flex:0 0 34px;text-align:right">${pct}%</span>
    </div>`;
  }).join('');
  const chat = tracked && tracked.chat ? tracked.chat : null;
  const filesPrefix = (usage.prefixes || []).find((p) => p.prefix === 'files/');
  const orphanHint = (usage.mode === 's3' && chat && filesPrefix && filesPrefix.bytes > chat.bytes * 1.1)
    ? `<div class="muted small">files/ holds ${fmtSize(filesPrefix.bytes - chat.bytes)} more than chat references — uploads never attached, deleted uploads the sweep hasn't reached yet, or webhook/profile media.</div>`
    : '';
  const localNote = usage.mode === 's3'
    ? `<div class="muted small">Local disk leftovers: ${usage.local.objects} file${usage.local.objects === 1 ? '' : 's'} · ${fmtSize(usage.local.bytes)}${usage.local.objects ? ' (pre-S3 files the sweep also walks)' : ''}</div>`
    : '';
  const cacheNote = `${usage.cached ? 'cached' : 'fresh'} · computed ${usage.cached ? agoStr(Date.now() - usage.ageMs) : 'just now'}${usage.listing ? ' · ' + usage.listing.objects + ' objects listed in ' + usage.listing.ms + 'ms' : ''}`;
  return `
    <div class="adm-stats" style="grid-template-columns:repeat(3,1fr)">
      ${card(fmtSize(t.bytes), 'Media total')}
      ${card(t.objects, 'Files')}
      ${card(fmtSize(bk.bytes), 'Backups (excluded)')}
    </div>
    ${usage.listing && usage.listing.truncated ? '<div class="muted small">Listing truncated — totals cover the first 100k objects.</div>' : ''}
    <div style="margin-top:.5rem">${rows || '<p class="muted small">Nothing stored yet.</p>'}</div>
    <div class="muted small" style="margin-top:.4rem">
      ${chat ? `Chat attachments the database still points at: ${chat.objects} file${chat.objects === 1 ? '' : 's'} · ${fmtSize(chat.bytes)}<br/>` : ''}
      Backups: ${bk.objects} dump${bk.objects === 1 ? '' : 's'} · ${fmtSize(bk.bytes)} — never served, never swept, not in the total above.<br/>
      ${localNote}${orphanHint}
    </div>
    <div class="muted small" style="margin-top:.35rem">${esc(cacheNote)}</div>
    <div class="adm-actions">
      <button class="mini" id="adm-storage-refresh">Recompute</button>
      <button class="mini" id="adm-sweep-check">Check for orphans</button>
    </div>
    <div id="adm-sweep-out" class="muted small"></div>`;
}
async function loadAdminMedia() {
  const box = $('#adm-media');
  if (!box) return;
  try {
    const [m, r] = await Promise.all([api('/api/admin/media'), api(`/api/admin/media/recent?limit=${ADMIN_MEDIA_RECENT}`)]);
    const w = m.worker || {};
    const badge = (txt, cls) => `<span class="adm-badge${cls ? ' ' + cls : ''}">${esc(txt)}</span>`;
    const jobs = r.jobs || [];
    const capped = jobs.length >= ADMIN_MEDIA_RECENT;
    const pend = m.queue?.pending || {};
    const pendN = Object.values(pend).reduce((a, x) => a + (x?.n || 0), 0);
    const pendB = Object.values(pend).reduce((a, x) => a + (x?.bytes || 0), 0);
    const card = (n, l) => `<div class="adm-stat"><b>${n}</b><span>${l}</span></div>`;
    const jobRow = (j) => {
      const ok = j.result === 'compressed';
      const pct = ok && j.orig_size > 0 ? ` (-${Math.round((1 - j.new_size / j.orig_size) * 100)}%)` : '';
      const sizes = ok ? `${fmtSize(j.orig_size)} → ${fmtSize(j.new_size)}${pct}` : fmtSize(j.orig_size);
      return `<div class="adm-subrow">
        <span class="adm-subname" title="${esc(j.filename || '')}">${esc(j.filename || 'file')}</span>
        ${badge(j.kind || '?', '')}
        ${ok ? '' : badge('FAILED', 'off')}
        <span class="spacer"></span>
        <span class="muted small">${esc(sizes)} · ${esc(j.pipeline || '')} · ${agoStr(j.created_at)}</span>
      </div>`;
    };
    box.innerHTML = `
      <div class="adm-badges" style="margin:0 0 .55rem">
        ${badge(w.enabled ? (w.ffmpeg ? 'WORKER ON' : 'ON — NO FFMPEG') : 'WORKER OFF', w.enabled && w.ffmpeg ? 'admin' : 'off')}
        ${badge(w.s3 ? 'S3 STORAGE' : 'LOCAL DISK', 'me')}
        ${w.busy ? badge('WORKING NOW', 'admin') : ''}
      </div>
      <div class="pf-sec-label" style="margin-top:.2rem">Storage</div>
      ${storageCard(m.usage, m.tracked)}
      <div class="pf-sec-label" style="margin-top:1rem">Compression</div>
      <div class="adm-stats" style="grid-template-columns:repeat(4,1fr)">
        ${card(pendN, 'Queued')}
        ${card(fmtSize(pendB), 'Queued size')}
        ${card(m.totals?.compressed || 0, 'Compressed')}
        ${card(fmtSize(m.totals?.savedBytes || 0), 'Saved total')}
      </div>
      ${!w.ffmpeg ? '<div class="muted small">ffmpeg is not on PATH — uploads work, they just stay uncompressed.</div>' : ''}
      <div class="muted small" style="margin-top:.4rem">${scanLine(m.scan)}${sweepLine(m.sweep)}</div>
      <div class="pf-sec-label" style="margin-top:1rem">Recent files</div>
      ${jobs.length
        ? `<div class="adm-scroll">${jobs.map(jobRow).join('')}</div>`
          + (capped ? `<div class="muted small adm-recent-note">Newest ${ADMIN_MEDIA_RECENT} · the log keeps more</div>` : '')
        : '<p class="muted small">Nothing compressed yet.</p>'}
      <div class="adm-actions"><button class="mini" id="adm-media-refresh">Refresh</button></div>`;
    const rb = $('#adm-media-refresh');
    if (rb) rb.onclick = () => { box.innerHTML = '<p class="muted small">Loading…</p>'; loadAdminMedia(); };
    const sb = $('#adm-storage-refresh');
    if (sb) sb.onclick = async () => {
      sb.disabled = true;
      try { await api('/api/admin/media/storage?refresh=1'); }
      catch (e) { toast(prettyError(e.message)); }
      loadAdminMedia(); // the forced walk is cached now, so this is instant
    };
    const ck = $('#adm-sweep-check');
    if (ck) ck.onclick = () => adminSweepCheck();
  } catch { box.innerHTML = '<p class="muted small">Could not load media info.</p>'; }
}
// Dry-run the orphan sweep: what would be deleted right now, without deleting.
// Deletion stays opt-in behind a confirm (the nightly run does it anyway).
async function adminSweepCheck() {
  const out = $('#adm-sweep-out');
  if (out) out.innerHTML = '<span class="muted small">Walking storage…</span>';
  try {
    const r = await api('/api/admin/sweep/run?dry=1', { method: 'POST' });
    const res = r.result || {};
    if (!res.dry) { if (out) out.textContent = 'Sweep already running — try again in a moment.'; return; }
    const v = res.victims || [];
    const n = Number.isFinite(res.victimsTotal) ? res.victimsTotal : v.length;
    const bytes = v.reduce((a, x) => a + (x.size || 0), 0);
    if (out) {
      out.innerHTML = `Orphans: ${n} file(s) · ${fmtSize(bytes)} older than the grace period, out of ${res.scanned} stored.`;
      if (v.length) out.innerHTML += `<div class="muted small" style="margin-top:.3rem">${v.slice(0, 5).map((x) => esc(x.key) + ' · ' + fmtSize(x.size)).join('<br/>')}${v.length > 5 ? '<br/>…' : ''}</div>`;
    }
    if (v.length) {
      const ok = await openConfirmModal({ title: 'Delete orphaned files?', message: `Removes ${n} unreferenced file(s) (${fmtSize(bytes)}). Referenced or still-scanning files are never touched.`, okLabel: 'Delete' });
      if (ok) {
        const run = await api('/api/admin/sweep/run', { method: 'POST' });
        const d = run.result || {};
        toast(`Swept ${d.deleted || 0} file(s), ${fmtSize(d.bytes || 0)} freed`);
        loadAdminMedia();
      }
    }
  } catch (e) { if (out) out.textContent = prettyError(e.message); }
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
  const box = $('#adm-users-list');
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
  const box = $('#adm-servers-list');
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
  slot = slot || document.querySelector(`#adm-servers-list [data-sid="${CSS.escape(sid)}"] .adm-members`);
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

// ---------- console wiring ----------
// One delegated listener for every admin row button plus the tab strip, wired
// once at load (the console markup is static; panes are built on demand).
(function wireAdminConsole() {
  const box = $('#admin-backdrop');
  if (!box) return;
  const tabs = box.querySelector('.adm-tabs');
  if (tabs) tabs.addEventListener('click', (e) => {
    const b = e.target.closest('.set-tab[data-atab]');
    if (b) setAdminTab(b.dataset.atab);
  });
  box.addEventListener('click', adminClick);
  box.addEventListener('click', (e) => { if (e.target === box) closeAdminConsole(); });
  const close = $('#admin-close');
  if (close) close.onclick = closeAdminConsole;
  const rail = $('#btn-admin');
  if (rail) rail.onclick = () => openAdminConsole();
  // Returning to the tab shouldn't show numbers from when it was hidden — the
  // poll is paused while hidden, so take one fresh reading on the way back.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && adminConsoleOpen() && Admin.tab === 'overview') loadAdminStats();
  });
})();
