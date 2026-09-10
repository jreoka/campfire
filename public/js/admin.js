'use strict';
// ---------- site admin panel (Settings → Admin, is_admin users only) ----------
// Controls: stats, media compression monitor, broadcast, user management (edit / disable / admin role /
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
      <div class="pf-sec-label">Safety — known illegal content</div>
      <div id="adm-safety"><p class="muted small">Loading…</p></div>
      <div class="pf-sec-label">Media compression</div>
      <div id="adm-media"><p class="muted small">Loading…</p></div>
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
  loadAdminSafety();
  loadAdminMedia();
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

// ---------- safety (known-CSAM hash matching) ----------
// The review UI deliberately shows NO preview of suspected material: viewing
// suspected CSAM is itself an offence in most jurisdictions. Match kind,
// Hamming distance, uploader and context are enough to judge a false positive.
function safetyBadge(txt, cls) { return `<span class="adm-badge${cls ? ' ' + cls : ''}">${esc(txt)}</span>`; }

function admReviewRow(r) {
  const who = r.displayName || r.username || 'deleted user';
  const state = r.status === 'open' ? safetyBadge('OPEN', 'off')
    : r.status === 'cleared' ? safetyBadge('CLEARED', 'admin') : safetyBadge('CONFIRMED', 'off');
  const exact = r.matchKind === 'sha256' || r.matchKind === 'md5';
  const dist = r.matchDistance === null ? '' : ` · distance ${r.matchDistance}`;
  const note = r.notes ? `<div class="muted small">Note: ${esc(r.notes)}</div>` : '';
  const reviewed = r.reviewedAt ? `<span class="muted small">${r.status === 'cleared' ? 'cleared' : 'confirmed'} by ${esc(r.reviewedByName || 'admin')} ${agoStr(r.reviewedAt)}</span>` : '';
  // An exact hash hit is a byte-for-byte match: never a false positive, and
  // worth saying so, because it changes how an admin should treat it.
  const certainty = exact
    ? '<div class="muted small">Byte-for-byte match — this cannot be a false positive.</div>'
    : `<div class="muted small">Perceptual match${dist}. Near-misses happen; check the uploader and context before deciding.</div>`;
  return `<div class="adm-row" data-rid="${esc(r.id)}" data-uid="${esc(r.userId || '')}">
    <span class="avatar adm-av" style="background:${esc(r.avatarColor || '#5865f2')}"></span>
    <div class="adm-main">
      <div class="adm-name">${esc(who)} ${state}</div>
      <div class="muted small">@${esc(r.username || 'unknown')}${r.isAdmin ? ' · site admin' : ''} · ${esc(r.context || 'upload')} · ${agoStr(r.createdAt)}</div>
      <div class="muted small">matched <b>${esc(r.matchKind)}</b>${dist}${r.matchSource ? ' · list: ' + esc(r.matchSource) : ''}</div>
      <div class="muted small" style="word-break:break-all">${esc(r.matchHash || '')}</div>
      ${certainty}
      ${note}
      ${reviewed}
      <div class="adm-actions">
        ${r.status === 'open'
          ? `<button class="mini" data-act="safe-clear">False positive — unlock</button>
             <button class="mini danger" data-act="safe-confirm">Confirm &amp; keep locked</button>`
          : `<button class="mini" data-act="safe-reopen">Reopen</button>`}
        <button class="mini" data-act="safe-unlock">Unlock account</button>
        <button class="mini danger" data-act="safe-purge">Delete evidence</button>
      </div>
    </div>
  </div>`;
}

async function loadAdminSafety() {
  const box = $('#adm-safety');
  if (!box) return;
  try {
    const [st, rv] = await Promise.all([
      api('/api/admin/safety'),
      api('/api/admin/safety/reviews?status=all&limit=25'),
    ]);
    Admin.safety = st;
    const card = (n, l) => `<div class="adm-stat"><b>${n}</b><span>${l}</span></div>`;
    const total = (st.listCounts.sha256 || 0) + (st.listCounts.md5 || 0) + (st.listCounts.pdq || 0);
    const reviews = rv.reviews || [];
    const open = reviews.filter((r) => r.status === 'open');
    const done = reviews.filter((r) => r.status !== 'open');
    box.innerHTML = `
      <div class="adm-badges" style="margin:0 0 .55rem">
        ${st.enabled ? safetyBadge('DETECTION ON', 'admin') : safetyBadge('DETECTION OFF', 'off')}
        ${st.hasList ? safetyBadge(`${total} HASHES`, 'admin') : safetyBadge('NO HASH LIST — INACTIVE', 'off')}
        ${st.action === 'lock' ? safetyBadge('AUTO-LOCK') : safetyBadge('FLAG ONLY')}
        ${st.adminExempt ? safetyBadge('ADMINS EXEMPT') : safetyBadge('ADMINS NOT EXEMPT', 'off')}
        ${safetyBadge('CHECKS ' + st.matchDistance + '/256')}
        ${safetyBadge('PREVIEW ' + String(st.preview || 'off').toUpperCase())}
        ${st.ffmpeg ? '' : safetyBadge('NO FFMPEG — EXACT MATCH ONLY', 'off')}
      </div>
      <div class="adm-stats" style="grid-template-columns:repeat(4,1fr)">
        ${card(st.listCounts.pdq || 0, 'PDQ hashes')}
        ${card((st.listCounts.sha256 || 0) + (st.listCounts.md5 || 0), 'Exact hashes')}
        ${card(st.reviews.open || 0, 'Open reviews')}
        ${card(st.lockedUsers || 0, 'Locked accounts')}
      </div>
      <div class="muted small" style="margin-top:.55rem">
        Uploads are fingerprinted and compared against the hash list stored on this server.
        No image, video or hash is ever sent to a third party.
        ${st.hasList ? '' : '<b>Detection is inactive until hashes are imported</b> — known-CSAM hash lists are issued by NCMEC, Project Arachnid and the IWF.'}
      </div>
      <div class="muted small">
        scanned ${st.scanned || 0} · clean ${st.clean || 0} · matched ${st.matched || 0} · errors ${st.errors || 0}
        · quarantined ${st.quarantineFiles || 0} file${st.quarantineFiles === 1 ? '' : 's'}
        · retention ${st.retentionDays || 0}d
        · allowlisted ${(st.allowCounts.pdq || 0) + (st.allowCounts.sha256 || 0) + (st.allowCounts.md5 || 0)}
        ${st.loadedAt ? '· list loaded ' + agoStr(st.loadedAt) : ''}
      </div>
      ${st.lastError ? `<div class="muted small">Last error: ${esc(st.lastError.error || '')} (${esc(String(st.lastError.key || '').split('/').pop())})</div>` : ''}
      <div class="adm-actions" style="margin-top:.5rem">
        <button class="mini" data-act="safe-import">Import hash list…</button>
        <button class="mini" data-act="safe-rescan">Rescan existing uploads</button>
        <button class="mini" data-act="safe-allowlist">Allowlist</button>
      </div>
      <div class="pf-sec-label" style="margin-top:.7rem">Open reviews (${open.length})</div>
      ${open.length ? open.map(admReviewRow).join('') : '<p class="muted small">No open reviews.</p>'}
      ${done.length ? `<div class="pf-sec-label">Recently reviewed</div>${done.map(admReviewRow).join('')}` : ''}
      <div class="muted small" style="margin-top:.5rem">
        Suspected material is never previewed here. Preserved files are kept out of the served upload area
        and purged automatically after the retention window. If a match is confirmed, report it to your
        national hotline (NCMEC CyberTipline in the US) — an ESP that learns of illegal material must report it.
      </div>`;
  } catch (e) {
    box.innerHTML = `<p class="muted small">Could not load safety state: ${esc(String(e && e.message || e))}</p>`;
  }
}

async function importHashList() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.csv,.txt,.tsv,text/plain';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const kind = await promptHashKind(f.name);
    if (kind === undefined) return;
    const fd = new FormData();
    fd.append('file', f);
    if (kind) fd.append('kind', kind);
    fd.append('source', f.name.slice(0, 100));
    try {
      const res = await fetch('/api/admin/safety/hashlist', {
        method: 'POST', headers: store.token ? { Authorization: 'Bearer ' + store.token } : {}, body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || data.error || res.status);
      const parts = Object.entries(data.byKind || {}).map(([k, n]) => `${n} ${k}`).join(', ');
      toast(`Imported ${data.added} hash${data.added === 1 ? '' : 'es'} (${parts}).`);
      loadAdminSafety();
    } catch (e) { toast('Import failed: ' + prettyError(String(e.message || e))); }
  };
  inp.click();
}

// A kind is only required when the file is a bare list of 64-hex hashes, which
// are ambiguous between PDQ and SHA-256. Cancelling returns undefined.
function promptHashKind(filename) {
  return new Promise((resolve) => {
    openModal('Import hash list', `
      <p class="muted small" style="margin-top:0">Importing <b>${esc(filename)}</b>.</p>
      <p class="muted small">If the file has a header row (for example <code>kind,hash</code> or
      <code>hashType,hashValue</code>) the types are detected automatically. Otherwise pick the hash type:</p>
      <label>Hash type<select id="m-kl-kind">
        <option value="">Auto-detect from the file</option>
        <option value="pdq">PDQ (perceptual, 64 hex chars)</option>
        <option value="sha256">SHA-256 (exact, 64 hex chars)</option>
        <option value="md5">MD5 (exact, 32 hex chars)</option>
      </select></label>
      <p class="muted small">Existing hashes of the same type are kept; duplicates are ignored.</p>
    `, 'Import', async () => { resolve($('#m-kl-kind').value); }, { onCancel: () => resolve(undefined) });
  });
}

async function adminSafetyClick(act, row) {
  const rid = row && row.dataset.rid;
  if (act === 'safe-import') return importHashList();
  if (act === 'safe-rescan') {
    return openModal('Rescan existing uploads', `
      <p class="muted small" style="margin-top:0">Re-hashes media that was uploaded before the current hash list.
      Hash lists are updated continuously, so content that did not match previously may match now.</p>
      <label>What to scan<select id="m-rescan-scope">
        <option value="files">Chat attachments (including DMs)</option>
        <option value="profiles">Profile images (avatars, banners, emoji, server icons)</option>
        <option value="all">Everything</option>
      </select></label>
      <p class="muted small">Runs in the background; the server stays responsive. Anything that matches is quarantined and reviewed.</p>
    `, 'Start scan', async () => {
      const scope = $('#m-rescan-scope').value;
      const r = await api('/api/admin/safety/rescan', { method: 'POST', body: JSON.stringify({ scope }) });
      toast(`Queued ${r.queued} file${r.queued === 1 ? '' : 's'} for rescan.`);
      setTimeout(loadAdminSafety, 1200);
    });
  }
  if (act === 'safe-allowlist') {
    const r = await api('/api/admin/safety/allowlist');
    const rows = r.allowlist || [];
    openModal('Allowlisted hashes', `
      <p class="muted small" style="margin-top:0">Hashes cleared as false positives. They never trigger a lock, for anyone.</p>
      <div id="m-allow-list">${rows.length ? rows.map((a) => `<div class="adm-subrow" data-hash="${esc(a.hash)}" data-kind="${esc(a.kind)}">
        <span class="adm-subname" style="word-break:break-all">${esc(a.hash.slice(0, 24))}…</span>
        <span class="muted small">${esc(a.kind)}${a.reason ? ' · ' + esc(a.reason) : ''}</span>
        <span class="spacer"></span>
        <button class="mini danger" data-act="safe-allow-del">Remove</button>
      </div>`).join('') : '<p class="muted small">Nothing allowlisted.</p>'}</div>
    `, 'Close', null, { wide: true });
    // Modal content lives outside the settings pane, so delegate on its own body.
    const list = $('#m-allow-list');
    if (list) list.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act="safe-allow-del"]');
      if (!b) return;
      const sub = b.closest('.adm-subrow');
      try {
        await api(`/api/admin/safety/allowlist?hash=${encodeURIComponent(sub.dataset.hash)}&kind=${encodeURIComponent(sub.dataset.kind)}`, { method: 'DELETE' });
        sub.remove();
        toast('Removed from allowlist');
        loadAdminSafety();
      } catch (err) { toast('Failed: ' + prettyError(err.message)); }
    });
    return;
  }
  if (act === 'safe-unlock') {
    const uid = row && row.dataset.uid;
    if (!uid) return;
    await api(`/api/admin/safety/users/${uid}/unlock`, { method: 'POST' });
    toast('Account unlocked');
    return loadAdminSafety();
  }
  if (act === 'safe-purge') {
    return openModal('Delete preserved evidence', `
      <p class="muted small" style="margin-top:0">Permanently deletes the preserved file for this review.</p>
      <p class="muted small">Only do this once you no longer need it — in the US, an ESP that reports to the
      CyberTipline is expected to preserve the material for 90 days. This cannot be undone.</p>
    `, 'Delete', async () => {
      await api('/api/admin/safety/quarantine/purge', { method: 'POST', body: JSON.stringify({ reviewId: rid }) });
      toast('Evidence deleted');
      loadAdminSafety();
    });
  }
  if (!rid) return;
  if (act === 'safe-clear') {
    return openModal('Clear as false positive', `
      <p class="muted small" style="margin-top:0">Unlocks the account, restores the file and allowlists this hash
      so the same image never triggers a lock again — for anyone.</p>
      <label>Note (optional)<input id="m-safe-note" maxlength="200" placeholder="why this is a false positive" /></label>
    `, 'Clear & unlock', async () => {
      await api(`/api/admin/safety/reviews/${rid}/clear`, { method: 'POST', body: JSON.stringify({ notes: $('#m-safe-note').value.trim() }) });
      toast('Cleared — account unlocked');
      loadAdminSafety();
    });
  }
  if (act === 'safe-confirm') {
    return openModal('Confirm match', `
      <p class="muted small" style="margin-top:0">Keeps the account locked and the file preserved.
      Review the evidence, then report it to your national hotline.</p>
      <label style="display:flex;gap:.5rem;align-items:center;margin:.4rem 0">
        <input type="checkbox" id="m-safe-ban" style="width:auto" /> Also disable the account permanently
      </label>
      <label>Note (optional)<input id="m-safe-note" maxlength="200" /></label>
    `, 'Confirm', async () => {
      await api(`/api/admin/safety/reviews/${rid}/confirm`, { method: 'POST', body: JSON.stringify({ notes: $('#m-safe-note').value.trim(), ban: $('#m-safe-ban').checked }) });
      toast('Confirmed');
      loadAdminSafety();
    });
  }
  if (act === 'safe-reopen') {
    await api(`/api/admin/safety/reviews/${rid}/reopen`, { method: 'POST' });
    toast('Review reopened');
    return loadAdminSafety();
  }
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
async function loadAdminMedia() {
  const box = $('#adm-media');
  if (!box) return;
  try {
    const [m, r] = await Promise.all([api('/api/admin/media'), api('/api/admin/media/recent?limit=25')]);
    const w = m.worker || {};
    const enc = w.encoders || {};
    const missing = Object.keys(enc).filter((k) => !enc[k]);
    const badge = (txt, cls) => `<span class="adm-badge${cls ? ' ' + cls : ''}">${esc(txt)}</span>`;
    const pend = m.queue?.pending || {};
    const pendKinds = ['image', 'video', 'audio']
      .map((k) => ({ k, n: pend[k]?.n || 0, bytes: pend[k]?.bytes || 0 }))
      .filter((x) => x.n > 0);
    const pendN = Object.values(pend).reduce((a, x) => a + (x?.n || 0), 0);
    const pendB = Object.values(pend).reduce((a, x) => a + (x?.bytes || 0), 0);
    const card = (n, l) => `<div class="adm-stat"><b>${n}</b><span>${l}</span></div>`;
    const lastJob = w.lastJob
      ? `${esc(String(w.lastJob.key || '').split('/').pop())} · ${fmtSize(w.lastJob.origSize)} → ${fmtSize(w.lastJob.newSize)} · ${agoStr(w.lastJob.at)}`
      : 'none yet';
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
      <div class="adm-stats" style="grid-template-columns:repeat(4,1fr)">
        ${card(pendN, 'Queued')}
        ${card(fmtSize(pendB), 'Queued size')}
        ${card(m.totals?.compressed || 0, 'Compressed')}
        ${card(fmtSize(m.totals?.savedBytes || 0), 'Saved total')}
      </div>
      <div class="muted small" style="margin-top:.55rem">${
        pendKinds.length ? 'Queued: ' + pendKinds.map((x) => `${x.k} ${x.n} (${fmtSize(x.bytes)})`).join(' · ') : 'Queue empty — everything is compressed.'
      }</div>
      <div class="muted small">Schedule: continuous while queued (~${Math.round((w.activeMs || 2000) / 100) / 10}s between files) · idle poll every ${Math.round((w.everyMs || 30000) / 1000)}s · ${w.batch || 1} file/tick · 1 thread${missing.length ? '' : ' · low priority'} · load ${w.load != null ? Number(w.load).toFixed(2) : '?'} / ${w.cpus || '?'} cores${missing.length ? ` · encoders missing: ${esc(missing.join(', '))}` : ''}</div>
      ${!w.ffmpeg ? '<div class="muted small">ffmpeg is not on PATH — uploads work, they just stay uncompressed.</div>' : ''}
      <div class="muted small">Last file: ${lastJob}${w.lastError ? ` · last error: ${esc(w.lastError.key || '')} (${esc((w.lastError.error || '').slice(0, 80))})` : ''}</div>
      <div class="muted small" style="margin-top:.4rem">${scanLine(m.scan)}${sweepLine(m.sweep)}</div>
      <div class="pf-sec-label" style="margin-top:1rem">Recent files</div>
      <div>${(r.jobs || []).length ? r.jobs.map(jobRow).join('') : '<p class="muted small">Nothing compressed yet.</p>'}</div>
      <div class="adm-actions"><button class="mini" id="adm-media-refresh">Refresh</button></div>`;
    const rb = $('#adm-media-refresh');
    if (rb) rb.onclick = () => { box.innerHTML = '<p class="muted small">Loading…</p>'; loadAdminMedia(); };
  } catch { box.innerHTML = '<p class="muted small">Could not load media info.</p>'; }
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
  // Safety actions live in their own module section and use their own row ids.
  if (act.startsWith('safe-')) {
    try { await adminSafetyClick(act, b.closest('.adm-row[data-rid]')); }
    catch (err) { toast('Failed: ' + prettyError(err.message)); }
    return;
  }
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
