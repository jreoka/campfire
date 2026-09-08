'use strict';
// ---------- presence: quick switch + idle auto-away ----------
let statusMenuEl = null;
function closeStatusMenu() { statusMenuEl?.remove(); statusMenuEl = null; }
$('#me-avatar').style.cursor = 'pointer';
$('#me-avatar').onclick = (e) => {
  e.stopPropagation();
  if (statusMenuEl) { closeStatusMenu(); return; }
  const r = $('#me-avatar').getBoundingClientRect();
  statusMenuEl = document.createElement('div');
  statusMenuEl.id = 'status-pop';
  statusMenuEl.style.cssText = `position:fixed;left:${r.left}px;bottom:${innerHeight - r.top + 8}px;top:auto;min-width:180px`;
  statusMenuEl.classList.remove('hidden');
  for (const s of ['online', 'away', 'dnd', 'invisible']) {
    const b = document.createElement('button');
    b.className = 'mention-item';
    b.innerHTML = `<span class="status-dot ${s}"></span><span style="text-transform:capitalize">${s === 'dnd' ? 'Do not disturb' : s}</span>`;
    b.onclick = async () => { closeStatusMenu(); await setStatus(s); };
    statusMenuEl.appendChild(b);
  }
  document.body.appendChild(statusMenuEl);
};
async function setStatus(s) {
  try {
    const { user } = await api('/api/me', { method: 'PATCH', body: JSON.stringify({ status: s }) });
    S.me = { ...S.me, ...user };
    paintMe(); renderMembers();
    if (S.view === 'home') renderDmMembers();
  } catch {}
}
let idleTimer = null;
function poke() {
  if (!S.me) return;
  clearTimeout(idleTimer);
  if (S.me.status === 'away') setStatus('online');
  idleTimer = setTimeout(() => { if (S.me && S.me.status === 'online') setStatus('away'); }, 5 * 60 * 1000);
}
['mousemove', 'keydown', 'click'].forEach((ev) => document.addEventListener(ev, poke, { passive: true }));

// ---------- global closers ----------
 document.addEventListener('click', (e) => {
  if (!e.target.closest('#picker') && !e.target.closest('#btn-emoji') && !e.target.closest('#btn-gif') && !e.target.closest('.msg-actions')) closePicker();
  if (!e.target.closest('#usercard') && !e.target.closest('[data-uid]') && !e.target.closest('.member')) closeUserCard();
  if (statusMenuEl && !e.target.closest('#status-pop') && !e.target.closest('#me-avatar')) closeStatusMenu();
  if (ctxEl && !e.target.closest('#ctx-menu') && !e.target.closest('.msg-actions')) closeCtx();
  if (folderFlyoutEl && !e.target.closest('#folder-menu')) closeFolderFlyout();
  // A folder only collapses when its own header (top part) is clicked; never
  // on outside/background clicks or when selecting one of its servers.
  if (document.body.classList.contains('members-open') && !e.target.closest('#members') && !e.target.closest('#btn-members')) document.body.classList.remove('members-open');
  if (!e.target.closest('#composer-more') && !e.target.closest('#btn-more') && !e.target.closest('#btn-plus')) $('#composer-more')?.classList.add('hidden');
});
 document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closePicker(); closeUserCard(); closeStatusMenu(); closeCtx(); closeFolderFlyout(); closeFolderPopout(); closeSettings(); closeServerSettings(); $('#composer-more')?.classList.add('hidden'); cancelModal(); $('#lightbox').classList.add('hidden'); }
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
$('#in-message').addEventListener('input', composerAutoGrow);
$('#in-thread').addEventListener('input', composerAutoGrow);
// Composer auto-grows with content (Discord-style); caps at 40% of the viewport.
function composerAutoGrow(inp) {
  inp.style.height = 'auto';
  inp.style.height = Math.min(inp.scrollHeight, Math.round(window.innerHeight * 0.4)) + 'px';
}
// Enter sends, Shift+Enter inserts a line break. Skipped while the @mention
// popup is open — its own keydown handler owns Enter in that case.
function composerSendKey(inp, formId) {
  inp.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    if ($('#mention-pop') && !$('#mention-pop').classList.contains('hidden')) return;
    e.preventDefault();
    document.getElementById(formId)?.requestSubmit();
  });
}
composerSendKey($('#in-message'), 'composer');
composerSendKey($('#in-thread'), 'thread-composer');
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
