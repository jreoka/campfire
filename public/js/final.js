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
// ---------- presence: idle auto-away + the state setter ----------
// The quick-switch menu that used to hang off the avatar is gone: the states
// live on your own user card now (see presenceWidgetHTML in pickers.js), and
// clicking the avatar opens that card like every other avatar does.
function presenceExpiry() { const ts = +((S.me || {}).presence_expires_at || 0); return ts > Date.now() ? ts : 0; }
// Was the current away set by the idle timer? That is the one presence activity
// may silently undo. A state the user picked by hand (even a timerless Away,
// which carries no expiry yet) is theirs to keep — the old blanket "untimed
// away → online on activity" rule undid the pick on the very next mouse move, so
// the status looked like it never changed. The flag lives in storage (keyed per
// account) so a reload keeps an idle Away revertible without turning a picked
// one sticky; the read only happens while the status is an untimed away.
const IDLE_AWAY_KEY = 'cf_idle_away:';
function setIdleAway(v) {
  try { if (v) localStorage.setItem(IDLE_AWAY_KEY + S.me.id, '1'); else localStorage.removeItem(IDLE_AWAY_KEY + S.me.id); } catch {}
}
function idleAwayIsOurs() {
  if (!S.me || S.me.status !== 'away' || presenceExpiry()) return false;
  try { return localStorage.getItem(IDLE_AWAY_KEY + S.me.id) === '1'; } catch { return false; }
}
function markPresenceManual() { setIdleAway(false); }
async function setStatus(s, presenceExpiresAt) {
  try {
    const body = { status: s };
    if (s === 'online' || presenceExpiresAt !== undefined) body.presenceExpiresAt = s === 'online' ? null : (presenceExpiresAt ?? null);
    const { user } = await api('/api/me', { method: 'PATCH', body: JSON.stringify(body) });
    S.me = { ...S.me, ...user };
    paintMe(); renderMembers();
    if (S.view === 'home') renderDmMembers();
    // Keep the open user card's dot/label + switcher honest too (this path also
    // fires for the idle auto-away flip, not just the card's own chips).
    try { refreshOwnPresence(); } catch {}
  } catch {}
}
let idleTimer = null;
function poke() {
  if (!S.me) return;
  clearTimeout(idleTimer);
  // A timed Away owns its own revert, and so does a picked one — only the idle
  // auto-away may be cleared by activity.
  if (idleAwayIsOurs()) { markPresenceManual(); setStatus('online'); }
  idleTimer = setTimeout(() => { if (S.me && S.me.status === 'online') { setIdleAway(true); setStatus('away'); } }, 5 * 60 * 1000);
}
['mousemove', 'keydown', 'click'].forEach((ev) => document.addEventListener(ev, poke, { passive: true }));

// ---------- swipe-down-to-dismiss (mobile panels) ----------
// Drag a full-screen mobile panel (the profile page, the me-bar card sheet)
// downward and it follows the finger, then closes past the threshold or springs
// back. Touch events, not pointer events: the panel's own body is a scroll
// container, and with pointer events the browser treats a downward drag at the
// top as an overscroll pan, cancels the pointer stream and the gesture never
// lands (the same trap `.sv-stage`'s touch-action had). A non-passive touchmove
// lets us preventDefault and take the drag ourselves — but only from the top of
// the scroller, so normal scrolling still wins below it. The synthetic click
// after a drag is swallowed, or the panel would also activate whatever row was
// under the finger.
// One shared swallow window: a drag fires a synthetic click when the finger
// lifts, and that click must not also activate whatever row was under it. It
// lives on the function object (see below) so wiring a freshly created sheet
// does not add a document listener per open.

function swipeDownToClose(panel, onClose, opts = {}) {
  if (!panel) return;
  const threshold = opts.threshold || 90;
  const live = opts.live || 0.55;
  // A class that suppresses the panel's own transform transition while the
  // finger owns the motion; it comes off on release so the settle still eases.
  const dragClass = opts.dragClass || null;
  const scroller = () => (opts.scroller ? opts.scroller() : panel);
  const atTop = () => { const s = scroller(); return !s || s.scrollTop <= 0; };
  let sx = 0, sy = 0, dy = 0, active = false;
  panel.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || (opts.enabled && !opts.enabled())) { active = false; return; }
    active = atTop();
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; dy = 0;
  }, { passive: true });
  panel.addEventListener('touchmove', (e) => {
    if (!active || e.touches.length !== 1) return;
    const t = e.touches[0];
    const d = t.clientY - sy, dx = t.clientX - sx;
    if (!atTop()) { active = false; dy = 0; panel.style.transform = ''; if (dragClass) panel.classList.remove(dragClass); return; }
    // Upward is the scroll's, sideways is nobody's: leave both alone.
    if (d <= 0 || Math.abs(dx) > Math.abs(d) * 1.4) { dy = 0; panel.style.transform = ''; if (dragClass) panel.classList.remove(dragClass); return; }
    e.preventDefault();
    if (dragClass) panel.classList.add(dragClass);
    dy = d;
    panel.style.animation = 'none'; // take over from the entry animation
    panel.style.transition = '';
    panel.style.transform = 'translateY(' + Math.round(Math.min(d, 340) * live) + 'px)';
  }, { passive: false });
  const end = () => {
    if (!active) return;
    active = false;
    const close = dy > threshold;
    const dragged = dy > 8;
    dy = 0;
    if (dragClass) panel.classList.remove(dragClass);
    panel.style.transform = '';
    if (dragged) swipeDownToClose.swallowUntil = Date.now() + 400;
    // The inline animation override stays: clearing it here would restart the
    // panel's entry animation on the spot. The panel's close function clears it
    // so the next open still animates in.
    if (close) { panel.style.transition = ''; onClose(); return; }
    panel.style.transition = 'transform .2s ease-out';
    setTimeout(() => { if (!active) panel.style.transition = ''; }, 220);
  };
  panel.addEventListener('touchend', end, { passive: true });
  panel.addEventListener('touchcancel', end, { passive: true });
}
// One shared swallow window for every sweepable panel: a drag fires a
// synthetic click when the finger lifts, and that click must not also activate
// whatever row was under it. Kept on the function object (not a module-level
// let) so the whole behaviour stays in one readable piece and wiring a freshly
// created sheet never adds a document listener per open.
swipeDownToClose.swallowUntil = 0;
document.addEventListener('click', (e) => {
  if (Date.now() < swipeDownToClose.swallowUntil) { e.stopPropagation(); e.preventDefault(); }
}, true);
swipeDownToClose($('#profile-backdrop .profile'), () => closeProfileScreen(), { scroller: () => $('#pf-body') });
swipeDownToClose($('#usercard'), () => closeUserCard(), { enabled: () => $('#usercard').classList.contains('sheet') });
// Context / message sheets are built fresh on every open (see openMsgSheet and
// openCtxSheet), so their swipe is wired where they are created.
// ---------- global closers ----------
// Was this click originally inside one of `sels`? composedPath() is captured
// when the event is dispatched, so it keeps answering correctly even after a
// handler has replaced — and thereby detached — the node that was clicked.
// The card's status menu re-renders itself in place, and with a plain
// `e.target.closest('#usercard')` that swap made the closer read the click as
// "outside": the card closed the instant you tapped your status.
function clickInPath(e, sels) {
  const path = e.composedPath ? e.composedPath() : null;
  if (path && path.length) return path.some((n) => n && n.nodeType === 1 && sels.some((s) => n.matches && n.matches(s)));
  return !!(e.target && e.target.closest && sels.some((s) => e.target.closest(s)));
}
 document.addEventListener('click', (e) => {
  // Clicks inside the bottom sheet are handled by the sheet's own rows (a row may
  // open the picker), so they must not close it again in the same click.
  if (!e.target.closest('#picker') && !e.target.closest('#btn-emoji') && !e.target.closest('#btn-gif') && !e.target.closest('#srv-tag-emoji') && !e.target.closest('.msg-actions') && !e.target.closest('#sheet')) closePicker();
  if (!clickInPath(e, ['#usercard', '#me-card', '[data-uid]', '.member', '.usertag[data-tag-sid]'])) closeUserCard();
  if (ctxEl && !e.target.closest('#ctx-menu') && !e.target.closest('.msg-actions')) closeCtx();
  if ($('#emoji-pop') && !e.target.closest('#emoji-pop') && !e.target.closest('#in-message')) hideEmojiPop();
  if (folderFlyoutEl && !e.target.closest('#folder-menu')) closeFolderFlyout();
  // A folder only collapses when its own header (top part) is clicked; never
  // on outside/background clicks or when selecting one of its servers.
  if (document.body.classList.contains('members-open') && !e.target.closest('#members') && !e.target.closest('#btn-members')) document.body.classList.remove('members-open');
  if (!e.target.closest('#composer-more') && !e.target.closest('#btn-more') && !e.target.closest('#btn-plus')) $('#composer-more')?.classList.add('hidden');
  if (!e.target.closest('#tagcard') && !e.target.closest('.usertag[data-tag-sid]')) closeTagCard();
});
// Server tags open their server's mini-panel (banner + icon + name +
// description). Delegated: tags render inside chat, lists, cards, voice…
document.addEventListener('click', (e) => {
  const t = e.target.closest && e.target.closest('.usertag[data-tag-sid]');
  if (!t) return;
  openTagCard(t.dataset.tagSid, e.clientX, e.clientY);
});
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('.usertag[data-tag-sid]')) {
    e.preventDefault();
    const r = e.target.getBoundingClientRect();
    openTagCard(e.target.dataset.tagSid, r.left + r.width / 2, r.bottom + 6);
  }
});
// Escape is the desktop twin of the phone's back button: it peels one layer at
// a time, topmost first, and must never throw on the way down or the layers
// under the one that threw stay open. (`closeStatusMenu` used to be called here
// and does not exist — the status menu lives inside the user card now — so the
// whole list after it was dead code.)
const ESCAPE_LAYERS = [
  () => closePicker(),
  () => closeUserCard(),
  () => closeTagCard(),
  () => closeCtx(),
  () => closeFolderFlyout(),
  () => closeFolderPopout(),
  () => closeSettings(),
  () => closeServerSettings(),
  () => closeChannelSettings(),
  () => closeAdminConsole(),
  () => closeProfileScreen(),
  () => $('#composer-more')?.classList.add('hidden'),
  () => closeStoryNewMenu(),
  () => cancelModal(),
  () => closeLightbox(),
  () => hideEmojiPop(),
];
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const close of ESCAPE_LAYERS) { try { close(); } catch {} }
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
// Drafts: keep what you're typing for the conversation you're typing it in, so
// a reload (auto-update, deploy, F5) brings it back with the chat.
$('#in-message').addEventListener('input', (e) => draftSoon(e.target, draftCtx()));
$('#in-thread').addEventListener('input', (e) => draftSoon(e.target, draftThreadCtx()));
// Composer auto-grows with content (Discord-style); caps at 40% of the viewport.
// scrollHeight excludes the border but the height we set is border-box,
// so add the border back or an empty box gets a tiny (2px) scroll range.
function composerAutoGrow(inp) {
  // A box with no layout (hidden thread panel, hidden view) reports a
  // scrollHeight of 0; measuring it would shrink the textarea to its border,
  // so leave the height alone until it is actually on screen.
  if (!inp || inp.scrollHeight <= 0) return;
  const cs = getComputedStyle(inp);
  const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  inp.style.height = 'auto';
  inp.style.height = Math.min(inp.scrollHeight + border, Math.round(window.innerHeight * 0.4)) + 'px';
}
// Enter sends, Shift+Enter inserts a line break. Skipped while an @mention /
// #channel / :emoji popup is open — its own keydown handler owns Enter in that
// case. Those handlers run first (pickers.js loads before this file) and mark
// the event, because they also hide the popup before this handler sees it.
function composerSendKey(inp, formId) {
  inp.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    if (e.cfAutocomplete) return;
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
  } catch { try { if (typeof armConnSoon === 'function') armConnSoon(); } catch {} }
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
  flushDrafts(); // synchronous localStorage write — the last keystrokes survive a reload
  rememberView();
  // The pin "seen" memory is mirrored on the server: a panel opened moments
  // before the reload must not lose its push (keepalive so it still lands).
  try { pinSeenFlush(); } catch {}
});
// Coming back to a tab that was hidden while the open channel collected
// background messages: that channel is being read again, so drop its dot.
// (The composer/scroll state is untouched; this is purely the sidebar dot.)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { try { clearActiveChanUnread(); } catch {} }
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
