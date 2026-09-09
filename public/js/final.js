'use strict';
// ---------- desktop/mobile app: external links open in the OS browser ----------
// Inside the Tauri wrapper, target=_blank clicks die silently in the WebView
// (no navigation, no window, no error — at least on Windows/WebView2), so
// external http(s) links are handed to the native `open_external` command
// instead. Same-origin links (invites, uploads) keep navigating in-app.
// No-ops in a real browser (no __TAURI__ global there).
function tauriExternalLink(e) {
  try {
    if (!window.__TAURI__) return;
    const isAux = e.type === 'auxclick';
    if (isAux ? e.button !== 1 : e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    let url;
    try { url = new URL(href, location.href); } catch { return; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (url.origin === location.origin) return;
    e.preventDefault();
    const inv = window.__TAURI__.core && window.__TAURI__.core.invoke;
    if (typeof inv === 'function') inv('open_external', { url: url.href }).catch(() => {});
  } catch {}
}
document.addEventListener('click', tauriExternalLink);
document.addEventListener('auxclick', tauriExternalLink);
// ---------- presence: quick switch + timed revert ----------
let statusMenuEl = null, statusSubEl = null;
function closeStatusMenu() { statusMenuEl?.remove(); statusMenuEl = null; statusSubEl?.remove(); statusSubEl = null; }
// How long a timed away/dnd/invisible lasts before lapsing back to Online.
const PRESENCE_DURATIONS = [
  { label: '15 minutes', ms: 15 * 60e3 },
  { label: '1 hour', ms: 3600e3 },
  { label: '4 hours', ms: 4 * 3600e3 },
  { label: '8 hours', ms: 8 * 3600e3 },
  { label: '24 hours', ms: 24 * 3600e3 },
  { label: '3 days', ms: 3 * 864e5 },
  { label: 'Never', ms: null },
];
const STATUS_LABEL = { online: 'Online', away: 'Away', dnd: 'Do not disturb', invisible: 'Invisible' };
function presenceExpiry() { const ts = +((S.me || {}).presence_expires_at || 0); return ts > Date.now() ? ts : 0; }
function openStatusMenu() {
  closeStatusMenu();
  const r = $('#me-avatar').getBoundingClientRect();
  statusMenuEl = document.createElement('div');
  statusMenuEl.id = 'status-pop';
  statusMenuEl.style.cssText = `position:fixed;left:${r.left}px;bottom:${innerHeight - r.top + 8}px;top:auto;min-width:200px`;
  const cur = (S.me || {}).status || 'online';
  const exp = presenceExpiry();
  for (const s of ['online', 'away', 'dnd', 'invisible']) {
    const b = document.createElement('button');
    b.className = 'mention-item';
    const timer = s !== 'online' && cur === s && exp ? `<span class="cnt">${fmtCountdown(exp)}</span>` : '';
    const tail = s === 'online'
      ? (cur === 'online' ? '<span class="stat-check">\u2713</span>' : '')
      : `${timer}<span class="chev">\u203a</span>`;
    b.innerHTML = `<span class="status-dot ${s}"></span><span>${STATUS_LABEL[s]}</span>${tail}`;
    if (s === 'online') {
      b.onclick = async () => { closeStatusMenu(); await setStatus('online', null); };
    } else {
      b.onclick = (e) => { e.stopPropagation(); openStatusSub(s, b); };
      if (!isCoarse()) b.onmouseenter = () => openStatusSub(s, b);
    }
    statusMenuEl.appendChild(b);
  }
  if (exp && cur !== 'online') {
    const f = document.createElement('div');
    f.className = 'stat-foot';
    f.textContent = `Back to Online ${fmtCountdown(exp)}`;
    statusMenuEl.appendChild(f);
  }
  document.body.appendChild(statusMenuEl);
}
function openStatusSub(s, anchorRow) {
  if (!statusMenuEl) return;
  statusSubEl?.remove(); statusSubEl = null;
  const sub = document.createElement('div');
  sub.id = 'status-sub';
  const head = document.createElement('div');
  head.className = 'stat-subhead';
  head.textContent = `${STATUS_LABEL[s]} — online again after`;
  sub.appendChild(head);
  // Preselect the pending timer (nearest match) so the menu reflects state.
  const exp = ((S.me || {}).status === s && presenceExpiry()) || 0;
  let sel = PRESENCE_DURATIONS.length - 1;
  if (exp) {
    let best = -1, bd = Infinity;
    PRESENCE_DURATIONS.forEach((p, i) => { if (p.ms) { const d = Math.abs((Date.now() + p.ms) - exp); if (d < bd) { bd = d; best = i; } } });
    if (best >= 0 && bd < 5 * 60e3) sel = best;
  }
  PRESENCE_DURATIONS.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'mention-item';
    b.innerHTML = `<span>${p.label}</span>${i === sel ? '<span class="stat-check">\u2713</span>' : ''}`;
    b.onclick = async () => { closeStatusMenu(); await setStatus(s, p.ms ? Date.now() + p.ms : null); };
    sub.appendChild(b);
  });
  document.body.appendChild(sub);
  statusSubEl = sub;
  // Pin beside the parent row; flip to the left when space runs out.
  const mr = statusMenuEl.getBoundingClientRect();
  const ar = anchorRow.getBoundingClientRect();
  const w = sub.offsetWidth || 220;
  let left = mr.right + 6;
  if (left + w > innerWidth - 8) left = mr.left - w - 6;
  if (left < 8) left = Math.max(8, Math.min(mr.left, innerWidth - w - 8));
  let top = Math.min(Math.max(8, ar.top - 34), Math.max(8, innerHeight - sub.offsetHeight - 8));
  sub.style.cssText = `position:fixed;left:${left}px;top:${top}px;min-width:210px`;
}
$('#me-avatar').style.cursor = 'pointer';
$('#me-avatar').onclick = (e) => {
  e.stopPropagation();
  if (statusMenuEl) { closeStatusMenu(); return; }
  openStatusMenu();
};
async function setStatus(s, presenceExpiresAt) {
  try {
    const body = { status: s };
    if (s === 'online' || presenceExpiresAt !== undefined) body.presenceExpiresAt = s === 'online' ? null : (presenceExpiresAt ?? null);
    const { user } = await api('/api/me', { method: 'PATCH', body: JSON.stringify(body) });
    S.me = { ...S.me, ...user };
    paintMe(); renderMembers();
    if (S.view === 'home') renderDmMembers();
  } catch {}
}
let idleTimer = null;
function poke() {
  if (!S.me) return;
  clearTimeout(idleTimer);
  // A timed Away owns its own revert — activity must not clear it early.
  if (S.me.status === 'away' && !(+((S.me || {}).presence_expires_at || 0) > Date.now())) setStatus('online');
  idleTimer = setTimeout(() => { if (S.me && S.me.status === 'online') setStatus('away'); }, 5 * 60 * 1000);
}
['mousemove', 'keydown', 'click'].forEach((ev) => document.addEventListener(ev, poke, { passive: true }));

// ---------- global closers ----------
 document.addEventListener('click', (e) => {
  // Clicks inside the bottom sheet are handled by the sheet's own rows (a row may
  // open the picker), so they must not close it again in the same click.
  if (!e.target.closest('#picker') && !e.target.closest('#btn-emoji') && !e.target.closest('#btn-gif') && !e.target.closest('.msg-actions') && !e.target.closest('#sheet')) closePicker();
  if (!e.target.closest('#usercard') && !e.target.closest('#me-card') && !e.target.closest('[data-uid]') && !e.target.closest('.member')) closeUserCard();
  if (statusMenuEl && !e.target.closest('#status-pop') && !e.target.closest('#status-sub') && !e.target.closest('#me-avatar')) closeStatusMenu();
  if (ctxEl && !e.target.closest('#ctx-menu') && !e.target.closest('.msg-actions')) closeCtx();
  if ($('#emoji-pop') && !e.target.closest('#emoji-pop') && !e.target.closest('#in-message')) hideEmojiPop();
  if (folderFlyoutEl && !e.target.closest('#folder-menu')) closeFolderFlyout();
  // A folder only collapses when its own header (top part) is clicked; never
  // on outside/background clicks or when selecting one of its servers.
  if (document.body.classList.contains('members-open') && !e.target.closest('#members') && !e.target.closest('#btn-members')) document.body.classList.remove('members-open');
  if (!e.target.closest('#composer-more') && !e.target.closest('#btn-more') && !e.target.closest('#btn-plus')) $('#composer-more')?.classList.add('hidden');
});
 document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closePicker(); closeUserCard(); closeStatusMenu(); closeCtx(); closeFolderFlyout(); closeFolderPopout(); closeSettings(); closeServerSettings(); closeProfileScreen(); $('#composer-more')?.classList.add('hidden'); cancelModal(); $('#lightbox').classList.add('hidden'); hideEmojiPop(); }
});
function composerAnchor() {
  const t = $('#composer-tools')?.getBoundingClientRect();
  if (!t || !t.width) return null;
  return { x: t.right - 180, y: t.top };
}
$('#btn-emoji').onclick = () => { $('#picker').classList.contains('hidden') ? openPicker('insert', null, 'emoji', composerAnchor()) : closePicker(); };
$('#btn-gif').onclick = () => { $('#picker').classList.contains('hidden') ? openPicker('insert', null, 'gifs', composerAnchor()) : closePicker(); };
// Mobile: composer options live under a + menu (attach / emoji / GIF stay visible on desktop)
$('#btn-more').onclick = (e) => { e.stopPropagation(); closePicker(); $('#composer-more').classList.toggle('hidden'); };
$('#btn-plus').onclick = (e) => { e.stopPropagation(); closePicker(); $('#composer-more').classList.toggle('hidden'); };
$('#cm-attach').onclick = (e) => { e.stopPropagation(); $('#composer-more').classList.add('hidden'); $('#btn-attach').click(); };
$('#cm-emoji').onclick = (e) => { e.stopPropagation(); $('#composer-more').classList.add('hidden'); $('#btn-emoji').click(); };
$('#cm-gif').onclick = (e) => { e.stopPropagation(); $('#composer-more').classList.add('hidden'); $('#btn-gif').click(); };
$('#cm-voice').onclick = (e) => { e.stopPropagation(); $('#composer-more').classList.add('hidden'); startVoiceRec(); };
$('#cm-poll').onclick = (e) => { e.stopPropagation(); $('#composer-more').classList.add('hidden'); openPollModal(); };
$('#rec-cancel').onclick = cancelVoiceRec;
$('#rec-done').onclick = stopVoiceRec;
$('#rec-pause').onclick = toggleRecPause;
// Live markdown preview: rendered backdrop behind the transparent input text.
function syncComposerRender() {
  const inp = $('#in-message'), r = $('#in-render-inner');
  if (!inp || !r) return;
  r.innerHTML = inp.value ? renderRich(inp.value, { plain: true }) : '';
  r.style.marginLeft = (-inp.scrollLeft) + 'px';
}
$('#in-message').addEventListener('input', syncComposerRender);
$('#in-message').addEventListener('input', (e) => composerAutoGrow(e.target));
$('#in-thread').addEventListener('input', (e) => composerAutoGrow(e.target));
// Composer auto-grows with content (Discord-style); caps at 40% of the viewport.
// scrollHeight excludes the border but the height we set is border-box,
// so add the border back or an empty box gets a tiny (2px) scroll range.
function composerAutoGrow(inp) {
  const cs = getComputedStyle(inp);
  const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  inp.style.height = 'auto';
  inp.style.height = Math.min(inp.scrollHeight + border, Math.round(window.innerHeight * 0.4)) + 'px';
}
// Enter sends, Shift+Enter inserts a line break. Skipped while the @mention
// popup is open — its own keydown handler owns Enter in that case.
function composerSendKey(inp, formId) {
  inp.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    if ($('#mention-pop') && !$('#mention-pop').classList.contains('hidden')) return;
    if ($('#emoji-pop') && !$('#emoji-pop').classList.contains('hidden')) return;
    if ($('#chan-pop') && !$('#chan-pop').classList.contains('hidden')) return;
    e.preventDefault();
    document.getElementById(formId)?.requestSubmit();
  });
}
composerSendKey($('#in-message'), 'composer');
composerSendKey($('#in-thread'), 'thread-composer');
// Mobile: tapping a Send/Reply button focuses the button first, which blurs
// the textarea and collapses the keyboard (sometimes with a flicker even
// though submit refocuses). Suppress the focus steal — click still fires.
// NOTE: mousedown only — canceling pointerdown/touchstart would also cancel
// the tap's click and break sending entirely.
for (const sel of ['#composer .send-btn', '#thread-composer [type="submit"]']) {
  const btn = document.querySelector(sel);
  if (!btn) continue;
  btn.addEventListener('mousedown', (e) => { e.preventDefault(); });
}
$('#in-message').addEventListener('scroll', () => {
  const inp = $('#in-message'), r = $('#in-render-inner'), c = $('#in-render');
  if (c) c.scrollTop = inp.scrollTop;
  if (r) r.style.marginLeft = (-inp.scrollLeft) + 'px';
});

// Broken images (deleted/missing uploads) degrade gracefully instead of
// rendering as crushed broken-image boxes.
document.addEventListener('error', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLImageElement)) return;
  if (t.dataset.fbName) {
    const a = document.createElement('a');
    a.className = 'file-card'; a.href = t.dataset.fbUrl; a.target = '_blank'; a.rel = 'noopener';
    const s = document.createElement('span');
    const n = document.createElement('span'); n.className = 'fname'; n.textContent = t.dataset.fbName;
    s.appendChild(n); a.appendChild(s);
    t.replaceWith(a);
  } else if (t.dataset.fbEmoji) {
    t.replaceWith(document.createTextNode(t.dataset.fbEmoji));
  } else if (t.dataset.fbLetter) {
    const cell = t.parentNode;
    if (cell) cell.textContent = t.dataset.fbLetter;
  }
}, true);

// ---------- auto-update (deploys apply without hard refresh) ----------
S.bootVersion = null; S.updateReady = false;
async function checkVersion() {
  try {
    const r = await fetch('/api/version', { cache: 'no-store' });
    const { version } = await r.json();
    if (!S.bootVersion) { S.bootVersion = version; return; }
    if (version === S.bootVersion) return;
    if (!S.updateReady) onUpdateReady();
    else if (!S.voice && !document.hidden) location.reload();
  } catch {}
}
function onUpdateReady() {
  S.updateReady = true;
  if (S.voice) { toast('Update ready — applies when you leave voice'); return; }
  toastAction('App updated — refresh for the latest version', 'Refresh', () => location.reload());
  clearTimeout(onUpdateReady._t);
  onUpdateReady._t = setTimeout(() => { if (S.updateReady && !S.voice && !document.hidden) location.reload(); }, 30000);
}
function toastAction(msg, label, fn) {
  const el = $('#toast');
  el.innerHTML = '';
  el.appendChild(document.createTextNode(msg));
  if (label) {
    const b = document.createElement('button');
    b.className = 'btn small primary'; b.style.marginLeft = '.6rem'; b.textContent = label;
    b.onclick = () => { el.classList.add('hidden'); fn && fn(); };
    el.appendChild(b);
  }
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 8000);
}
function pollVersion() {
  checkVersion();
  setInterval(checkVersion, 60000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      checkVersion();
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
        navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
      }
    }
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.t === 'SW_PING' && e.source) {
        try { e.source.postMessage({ t: 'SW_PONG', hasUpdater: true }); } catch {}
        checkVersion();
      }
      else if (e.data && e.data.t === 'SW_UPDATED') checkVersion();
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => checkVersion());
  }
}
window.addEventListener('beforeunload', () => {
  try { sessionStorage.setItem('cf_draft', JSON.stringify({ s: S.serverId, c: S.channelId, t: document.querySelector('#in-message') ? document.querySelector('#in-message').value : '' })); } catch {}
  rememberView();
});

// ---------- go ----------
setMode('login');
initTurnstile();
if (store.token) boot();
else {
  showAuth();
  // Signed-out invite link: preview the server + offer sign in/up (join happens after auth).
  const inv0 = consumeInvite();
  if (inv0) {
    stashInvite(inv0);
    showInviteLanding(inv0);
  }
}
