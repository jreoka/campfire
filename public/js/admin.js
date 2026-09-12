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
  rq: '', rst: 'open', roff: 0, rtotal: 0, rcounts: null, rcache: [],
  openReports: 0,
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
function adminTabIs(t) { return Admin.tab === t; }

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
  for (const key of ['overview', 'reports', 'media', 'users', 'servers']) {
    const pane = document.getElementById('adm-' + key);
    if (pane) pane.classList.toggle('hidden', key !== t);
  }
  if (t === 'overview') { ensureAdminOverviewPane(); loadAdminStats(); startAdminStatsLive(); }
  else if (t === 'reports') { ensureAdminReportsPane(); loadAdminReports(); }
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

// ---------- reports ----------
// The queue behind the chat's Report action. One card per report: status,
// reason, where it happened, who wrote it and who flagged it, a snapshot of
// the message (survives deletion), how many times this author has been
// reported before, and the actions. Searching and the status filter cover
// reason, details, message text, author and reporter names.
function ensureAdminReportsPane() {
  const pane = $('#adm-reports');
  if (!pane || pane.dataset.built) return;
  pane.dataset.built = '1';
  pane.innerHTML = `
    <div class="row" style="gap:.4rem">
      <input id="adm-rq" placeholder="Search reports, authors, reporters…" style="flex:1" autocomplete="off" />
      <select id="adm-rst" style="max-width:130px">
        <option value="open">Open</option>
        <option value="all">All</option>
        <option value="resolved">Resolved</option>
        <option value="dismissed">Dismissed</option>
      </select>
      <button id="adm-rsearch" class="btn small">Search</button>
    </div>
    <div id="adm-reports-counts" class="adm-badges"></div>
    <div id="adm-reports-list"></div>
    <div class="row end" style="gap:.5rem;align-items:center">
      <button id="adm-rprev" class="btn small">Prev</button>
      <span id="adm-rcount" class="muted small"></span>
      <button id="adm-rnext" class="btn small">Next</button>
      <button id="adm-rrefresh" class="btn small">Refresh</button>
    </div>`;
  const sel = $('#adm-rst');
  if (sel) sel.value = Admin.rst;
  const rSearch = () => { Admin.rq = $('#adm-rq').value.trim(); Admin.rst = $('#adm-rst').value; Admin.roff = 0; loadAdminReports(); };
  $('#adm-rsearch').onclick = rSearch;
  $('#adm-rq').addEventListener('keydown', (e) => { if (e.key === 'Enter') rSearch(); });
  $('#adm-rst').onchange = rSearch;
  $('#adm-rprev').onclick = () => { Admin.roff = Math.max(0, Admin.roff - ADMIN_PAGE); loadAdminReports(); };
  $('#adm-rnext').onclick = () => { if (Admin.roff + ADMIN_PAGE < Admin.rtotal) { Admin.roff += ADMIN_PAGE; loadAdminReports(); } };
  $('#adm-rrefresh').onclick = () => loadAdminReports();
}

// Badge on the tab (and a dot on the rail shield) so new reports are visible
// without the panel being open. Fed by /api/admin/reports*, the Overview stats
// payload and the live 'report-new' / 'report-updated' pushes.
function paintAdminReportBadge(n) {
  Admin.openReports = Number(n) || 0;
  const b = $('#adm-reports-badge');
  if (b) {
    b.textContent = Admin.openReports > 99 ? '99+' : String(Admin.openReports);
    b.classList.toggle('hidden', !Admin.openReports);
  }
  try { $('#btn-admin')?.classList.toggle('has-reports', !!Admin.openReports); } catch {}
}
async function refreshAdminReportBadge() {
  if (!isSiteAdmin()) return;
  try { const { open } = await api('/api/admin/reports/count'); paintAdminReportBadge(open); } catch {}
}
function renderAdminReportCounts() {
  const box = $('#adm-reports-counts');
  if (!box) return;
  const c = Admin.rcounts || {};
  const chip = (n, l, cls) => `<span class="adm-badge${cls ? ' ' + cls : ''}">${n} ${l}</span>`;
  box.innerHTML = chip(c.open || 0, 'open') + chip(c.resolved || 0, 'resolved', 'ok') + chip(c.dismissed || 0, 'dismissed', 'me')
    + '<span class="spacer"></span><span class="muted small" style="margin-left:auto">Newest first</span>';
}
function admReportMediaChips(r) {
  const media = (r.snapshot && r.snapshot.message && r.snapshot.message.media) || [];
  if (!media.length) return '';
  return `<div class="adm-rep-media">${media.map((a) => a.gated
    ? `<span class="adm-rep-chip">${esc(a.name || a.kind || 'media')} · view-once</span>`
    : `<a class="adm-rep-chip" href="${esc(a.url || '#')}" target="_blank" rel="noopener noreferrer">${esc(a.name || a.kind || 'file')}</a>`).join('')}</div>`;
}
function admReportRow(r) {
  const st = { open: ['OPEN', 'admin'], resolved: ['RESOLVED', 'ok'], dismissed: ['DISMISSED', 'me'] }[r.status] || ['OPEN', 'admin'];
  const w = (r.snapshot && r.snapshot.where) || {};
  const where = r.kind === 'dm'
    ? ('Direct message' + (w.thread && w.thread.isGroup && w.thread.name ? ' · ' + esc(w.thread.name) : ''))
    : ('#' + esc((w.channel && w.channel.name) || 'chat') + ' · ' + esc((w.server && w.server.name) || 'server'));
  const author = r.author ? `<span style="${nameStyleFor(r.author)}">${esc(r.author.display_name)}</span>${r.author.username ? ' <span class="muted small">@' + esc(r.author.username) + '</span>' : ''}${r.author.ownerAccount ? ' <span class="adm-badge owner" title="Instance owner account — other admins cannot disable or ban it">PROTECTED</span>' : ''}${r.author.gone ? ' <span class="adm-badge off">GONE</span>' : ''}` : '<span class="muted">unknown author</span>';
  const reporter = r.reporter ? `<span class="muted">reported by</span> <span style="${nameStyleFor(r.reporter)}">${esc(r.reporter.display_name)}</span>${r.reporter.username ? ' <span class="muted small">@' + esc(r.reporter.username) + '</span>' : ''}` : '<span class="muted">reporter account deleted</span>';
  const prior = r.priorReports ? ` <span class="adm-badge off">${r.priorReports} prior report${r.priorReports === 1 ? '' : 's'}</span>` : '';
  // Account actions are off the table when the reported message came from the
  // protected owner account (the server refuses them for everyone, the owner
  // included); moderating the message itself is still allowed.
  const lockedAuthor = !!(r.author && r.author.ownerAccount);
  const peers = r.kind === 'dm'
    ? ((w.thread && w.thread.members) || []).map((u) => '@' + u.username).filter((x) => x !== '@').join(', ')
    : '';
  const mediaCount = ((r.snapshot && r.snapshot.message && r.snapshot.message.media) || []).length;
  const body = r.content ? esc(r.content) : (mediaCount ? `<span class="muted">[${mediaCount} attachment${mediaCount === 1 ? '' : 's'}]</span>` : '<span class="muted">[no text]</span>');
  const open = r.status === 'open';
  const res = r.resolved
    ? `<div class="adm-rep-res"><b>${esc(admActionLabel(r.resolved.action))}</b> · ${esc(r.resolved.by)} · ${esc(agoStr(r.resolved.at))}${r.resolved.note ? ' — ' + esc(r.resolved.note) : ''}</div>`
    : '';
  const actions = open
    ? `<div class="adm-actions">
        ${r.messageExists ? '<button class="mini" data-act="rep-jump">Open in chat</button>' : '<span class="muted small" style="align-self:center">message deleted</span>'}
        ${r.messageExists ? '<button class="mini danger" data-act="rep-del">Delete message</button>' : ''}
        ${r.messageExists && r.author && !r.author.gone && !lockedAuthor ? '<button class="mini danger" data-act="rep-del-disable">Delete + disable</button>' : ''}
        ${r.author && !r.author.gone && !lockedAuthor ? '<button class="mini danger" data-act="rep-disable">Disable author</button>' : ''}
        ${r.author && !r.author.gone && !lockedAuthor && r.kind === 'server' && r.server_id ? '<button class="mini danger" data-act="rep-ban">Ban from server</button>' : ''}
        <button class="mini" data-act="rep-dismiss">Dismiss</button>
      </div>
      <input class="adm-rep-note" maxlength="500" placeholder="Note (optional) — saved with the outcome" />`
    : `<div class="adm-actions">${r.messageExists ? '<button class="mini" data-act="rep-jump">Open in chat</button>' : ''}${r.messageExists ? '<button class="mini danger" data-act="rep-del">Delete message</button>' : ''}</div>`;
  return `<div class="adm-report" data-rid="${esc(r.id)}">
    <div class="adm-rep-top">
      <span class="adm-badge ${st[1]}">${st[0]}</span>
      <span class="adm-badge">${esc(r.reasonLabel || 'Report')}</span>
      <span class="adm-badge">${r.kind === 'dm' ? 'DM' : 'SERVER'}</span>
      <span class="spacer"></span>
      <span class="muted small" title="${esc(fmtFull(r.created_at))}">${esc(agoStr(r.created_at))}</span>
    </div>
    <div class="adm-rep-where">${where}</div>
    <div class="adm-rep-meta">${author}${prior} · ${reporter}${peers ? ' · in DM with <span class="muted">' + esc(peers) + '</span>' : ''}</div>
    <div class="adm-rep-msg">
      <span class="avatar adm-rep-av"></span>
      <div class="adm-rep-mbody">
        <div class="adm-rep-text">${body}</div>
        ${admReportMediaChips(r)}
      </div>
    </div>
    ${r.details ? `<div class="adm-rep-details"><b>Reporter note:</b> ${esc(r.details)}</div>` : ''}
    ${res}
    ${actions}
  </div>`;
}
function admActionLabel(a) {
  return ({ dismiss: 'Dismissed', delete: 'Message deleted', delete_disable: 'Message deleted · author disabled', disable: 'Author disabled', ban: 'Author banned' })[a] || 'Resolved';
}
async function loadAdminReports() {
  const box = $('#adm-reports-list');
  if (!box) return;
  box.innerHTML = '<p class="muted small">Loading…</p>';
  try {
    const { reports, total, counts } = await api(
      `/api/admin/reports?q=${encodeURIComponent(Admin.rq)}&status=${encodeURIComponent(Admin.rst)}&limit=${ADMIN_PAGE}&offset=${Admin.roff}`);
    Admin.rtotal = total; Admin.rcounts = counts; Admin.rcache = reports;
    paintAdminReportBadge(counts.open || 0);
    renderAdminReportCounts();
    box.innerHTML = reports.length ? reports.map(admReportRow).join('')
      : `<p class="muted small">${Admin.rq ? 'No reports match that search.' : (Admin.rst === 'open' ? 'Nothing open — all clear.' : 'No reports here.')}</p>`;
    box.querySelectorAll('.adm-rep-av').forEach((el) => {
      const rid = el.closest('.adm-report')?.dataset.rid;
      const rep = reports.find((x) => x.id === rid);
      if (rep && rep.author) paintAvatar(el, rep.author);
      else if (rep) { el.textContent = '?'; el.style.background = 'var(--panel-3)'; }
    });
    const c = $('#adm-rcount');
    if (c) c.textContent = total ? `${Admin.roff + 1}–${Math.min(Admin.roff + reports.length, total)} of ${total}` : '';
  } catch { box.innerHTML = '<p class="muted small">Could not load reports.</p>'; }
}
// Work a report. The server closes every other open report about the same
// message with the same outcome, so this is a single call per decision.
async function admReportAction(act, rid) {
  const card = document.querySelector(`.adm-report[data-rid="${CSS.escape(rid)}"]`);
  const note = (card?.querySelector('.adm-rep-note')?.value || '').trim();
  const r = (Admin.rcache || []).find((x) => x.id === rid);
  const conf = {
    dismiss: { title: 'Dismiss this report?', message: 'No action is taken. Other open reports about the same message close too.', ok: 'Dismiss', danger: false },
    delete: { title: 'Delete this message?', message: 'It disappears from chat for everyone. Other open reports about it close too.', ok: 'Delete', danger: true },
    disable: { title: `Disable ${r && r.author ? '@' + r.author.username : 'this account'}?`, message: 'They are logged out immediately and cannot log in until re-enabled. The message stays in chat.', ok: 'Disable', danger: true },
    delete_disable: { title: 'Delete the message and disable the author?', message: 'The message is removed from chat and the account is disabled and logged out everywhere.', ok: 'Do both', danger: true },
    ban: { title: 'Ban the author from this server?', message: 'They are removed from the server and cannot rejoin with invites. The message stays in chat.', ok: 'Ban', danger: true },
  }[act];
  if (!conf) return;
  const ok = await openConfirmModal({ title: conf.title, message: conf.message, okLabel: conf.ok, danger: conf.danger });
  if (!ok) return;
  try {
    const out = await api(`/api/admin/reports/${rid}/resolve`, { method: 'POST', body: JSON.stringify({ action: act, note }) });
    paintAdminReportBadge(out.openReports || 0);
    toast(act === 'dismiss' ? 'Report dismissed' : (out.resolved > 1 ? `Action taken · ${out.resolved} reports closed` : 'Report resolved'));
    loadAdminReports();
    if (act !== 'dismiss' && act !== 'delete') loadAdminUsers();
  } catch (err) { toast('Failed: ' + prettyError(err.message)); }
}
async function adminJumpToReport(rid) {
  const r = (Admin.rcache || []).find((x) => x.id === rid);
  if (!r) return;
  closeAdminConsole();
  try {
    if (r.kind === 'dm') {
      if (!(S.dms || []).some((t) => t.id === r.thread_id)) { toast('You are not in that DM — the snapshot above is what was reported'); return; }
      await openHome();
      await selectDmThread(r.thread_id);
      jumpToMessage(r.message_id);
    } else {
      if (r.server_id !== S.serverId) await selectServer(r.server_id);
      if (r.channel_id) await selectChannel(r.channel_id);
      jumpToMessage(r.message_id);
    }
  } catch { toast('Could not open that message'); }
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
    card(s.openReports || 0, 'Open reports') +
    `<div class="adm-note muted small">Live · ${esc(when)}</div>`;
}

async function loadAdminStats() {
  const box = $('#adm-stats');
  if (!box) return;
  try {
    const s = await api('/api/admin/stats');
    Admin.stats = s; Admin.statsAt = Date.now(); Admin.statsErr = false;
    if (s.openReports !== undefined) paintAdminReportBadge(s.openReports);
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
  const c = sc.counts || {};
  // No clamd (a small node cannot afford it): the slot is still doing work — it
  // holds every compression candidate until the compressor has settled it — so
  // the line must not read as "idle".
  if (sc.mode === 'compress') {
    return `Virus scan: OFF (no clamd) · uploads wait for compression, then serve · pending ${c.pending || 0} · errors ${c.error || 0}`;
  }
  const eng = { off: 'OFF', none: 'NO ENGINE (fail-open)', starting: 'STARTING', ready: 'READY', failed: 'ENGINE FAILED (fail-open)' }[sc.engine || ''] || String(sc.engine || '?');
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
// Where the bytes went: media total, a per-prefix split with share bars, and
// what the database still points at. Server-cached for 10 minutes; Recompute
// forces a fresh listing. Off-site backups live in the R2 bucket, not this one,
// so nothing here reports on them.
function storageCard(usage, tracked) {
  if (!usage) return '<p class="muted small">Storage usage unavailable.</p>';
  const t = usage.total || { bytes: 0, objects: 0 };
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
    <div class="adm-stats" style="grid-template-columns:repeat(2,1fr)">
      ${card(fmtSize(t.bytes), 'Media total')}
      ${card(t.objects, 'Files')}
    </div>
    ${usage.listing && usage.listing.truncated ? '<div class="muted small">Listing truncated — totals cover the first 100k objects.</div>' : ''}
    <div style="margin-top:.5rem">${rows || '<p class="muted small">Nothing stored yet.</p>'}</div>
    <div class="muted small" style="margin-top:.4rem">
      ${chat ? `Chat attachments the database still points at: ${chat.objects} file${chat.objects === 1 ? '' : 's'} · ${fmtSize(chat.bytes)}` : ''}
      ${localNote}${orphanHint}
    </div>
    <div class="muted small" style="margin-top:.35rem">${esc(cacheNote)}</div>
    <div class="adm-actions">
      <button class="mini" id="adm-storage-refresh">Recompute</button>
      <button class="mini" id="adm-sweep-check">Check for orphans</button>
    </div>
    <div id="adm-sweep-out" class="muted small"></div>`;
}
// The bucket reconciliation pass: it lists the bucket itself and compresses
// what the flag-driven queue never saw (profile media, a story whose row landed
// late, anything an older build left behind). The ledger is what stops it
// re-encoding a file it already handled.
function bucketScanLine(b) {
  if (!b) return '';
  if (!b.enabled) return ' · Bucket scan: OFF';
  const every = (b.everyMs || 0) < 3600000 ? `${Math.round((b.everyMs || 0) / 60000)}min` : `${Math.round((b.everyMs || 0) / 3600000)}h`;
  const last = b.lastRunAt ? agoStr(b.lastRunAt) : 'not yet';
  const r = b.lastResult;
  const did = r
    ? `${r.compressed} compressed${r.savedBytes ? ' (' + fmtSize(r.savedBytes) + ')' : ''} of ${r.candidates} candidate${r.candidates === 1 ? '' : 's'} · ${r.objects} object${r.objects === 1 ? '' : 's'} listed`
    : 'no pass yet';
  const extra = [];
  if (r && r.deferred) extra.push(`${r.deferred} deferred`);
  if (r && r.skippedText) extra.push(`${r.skippedText} pasted-link only`);
  if (r && r.errors) extra.push(`${r.errors} errors`);
  const led = b.ledger ? ` · ledger ${b.ledger.keys} key${b.ledger.keys === 1 ? '' : 's'}` : '';
  return ` · Bucket scan: every ${every}, last ${esc(last)} — ${esc(did)}${extra.length ? ' · ' + esc(extra.join(' · ')) : ''}${led}`;
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
      <div class="muted small" style="margin-top:.25rem">${bucketScanLine(m.bucketScan)}</div>
      <div class="pf-sec-label" style="margin-top:1rem">Recent files</div>
      ${jobs.length
        ? `<div class="adm-scroll">${jobs.map(jobRow).join('')}</div>`
          + (capped ? `<div class="muted small adm-recent-note">Newest ${ADMIN_MEDIA_RECENT} · the log keeps more</div>` : '')
        : '<p class="muted small">Nothing compressed yet.</p>'}
      <div class="adm-actions">
        <button class="mini" id="adm-media-refresh">Refresh</button>
        <button class="mini" id="adm-bucket-check">Check bucket</button>
        <button class="mini" id="adm-bucket-run">Compress now</button>
      </div>
      <div id="adm-bucket-out" class="muted small"></div>`;
    const rb = $('#adm-media-refresh');
    if (rb) rb.onclick = () => { box.innerHTML = '<p class="muted small">Loading…</p>'; loadAdminMedia(); };
    const bc = $('#adm-bucket-check');
    if (bc) bc.onclick = async () => {
      const out = $('#adm-bucket-out');
      bc.disabled = true;
      out.textContent = 'Listing the bucket…';
      try {
        const res = await api('/api/admin/media/scan?dry=1', { method: 'POST' });
        const x = res.result || {};
        out.textContent = `${x.objects || 0} objects · ${x.referenced || 0} referenced keys · ${x.candidates || 0} would be compressed`
          + (x.skippedOrphan ? ` · ${x.skippedOrphan} unreferenced (orphan sweep has them)` : '')
          + (x.skippedText ? ` · ${x.skippedText} pasted-link only` : '')
          + (x.skippedFloor ? ` · ${x.skippedFloor} under the size floor` : '')
          + (x.skippedFresh ? ` · ${x.skippedFresh} too new` : '');
      } catch (e) { out.textContent = prettyError(e.message); }
      bc.disabled = false;
    };
    const br = $('#adm-bucket-run');
    if (br) br.onclick = async () => {
      const out = $('#adm-bucket-out');
      br.disabled = true;
      try {
        await api('/api/admin/media/scan', { method: 'POST' });
        out.textContent = 'Pass started — it runs in the background (watch the line above).';
        setTimeout(() => { if ($('#adm-media')) loadAdminMedia(); }, 5000);
      } catch (e) { out.textContent = prettyError(e.message); }
      br.disabled = false;
    };
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
  // The instance owner's account is locked for every admin — including the
  // owner's own session here, so the row reads the same to everyone. The
  // server refuses these routes for anyone but that account's own session
  // (blockedByOwnerLock); the owner manages their account from
  // Settings → Profile / Account instead.
  const locked = !!u.ownerAccount;
  const dis = locked ? ' disabled' : '';
  const badges =
    (u.ownerAccount ? '<span class="adm-badge owner" title="Instance owner account — protected from the admin panel">PROTECTED</span>' : '') +
    (u.is_admin ? '<span class="adm-badge admin">ADMIN</span>' : '') +
    (u.disabled ? '<span class="adm-badge off">DISABLED</span>' : '') +
    (u.has2fa ? '<span class="adm-badge me">2FA</span>' : '') +
    (u.id === S.me.id ? '<span class="adm-badge me">YOU</span>' : '');
  return `<div class="adm-row${locked ? ' protected' : ''}" data-uid="${esc(u.id)}">
    <span class="avatar adm-av"></span>
    <div class="adm-main">
      <div class="adm-name" style="${nameStyleFor(u)}">${esc(u.display_name)}</div>
      <div class="muted small">@${esc(u.username)} · ${u.serverCount} server${u.serverCount === 1 ? '' : 's'} · ${u.messageCount + u.dmCount} msgs · joined ${fmtDate(u.created_at)}</div>
      <div class="adm-badges">${badges}</div>
      <div class="adm-actions">
        <button class="mini" data-act="u-edit"${dis}>Edit</button>
        <button class="mini" data-act="u-pw"${dis}>Password</button>
        <button class="mini${u.disabled ? '' : ' danger'}" data-act="u-disable"${dis}>${u.disabled ? 'Enable' : 'Disable'}</button>
        <button class="mini" data-act="u-admin"${dis}>${u.is_admin ? 'Remove admin' : 'Make admin'}</button>
        <button class="mini" data-act="u-logout"${dis}>Log out</button>
        <button class="mini" data-act="u-2fa"${dis}>Reset 2FA</button>
        <button class="mini danger" data-act="u-del"${dis}>Delete</button>
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
      `<div class="adm-subrow${m.ownerAccount ? ' protected' : ''}" data-uid="${esc(m.id)}">
        <span class="adm-subname" style="${nameStyleFor(m)}">${esc(m.display_name)}</span>
        <span class="muted small">@${esc(m.username)}${m.role === 'owner' ? ' · owner' : ''}${m.disabled ? ' · disabled' : ''}</span>
        ${m.ownerAccount ? '<span class="adm-badge owner" title="Instance owner account — protected from the admin panel">PROTECTED</span>' : ''}
        <span class="spacer"></span>
        ${m.role === 'owner' || m.ownerAccount ? '' : `<button class="mini" data-act="s-owner">Make owner</button>
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
  const rrow = b.closest('.adm-report[data-rid]');
  try {
    if (act === 'rep-jump' && rrow) { await adminJumpToReport(rrow.dataset.rid); return; }
    if (act === 'rep-dismiss' && rrow) { await admReportAction('dismiss', rrow.dataset.rid); return; }
    if (act === 'rep-del' && rrow) { await admReportAction('delete', rrow.dataset.rid); return; }
    if (act === 'rep-disable' && rrow) { await admReportAction('disable', rrow.dataset.rid); return; }
    if (act === 'rep-del-disable' && rrow) { await admReportAction('delete_disable', rrow.dataset.rid); return; }
    if (act === 'rep-ban' && rrow) { await admReportAction('ban', rrow.dataset.rid); return; }
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
