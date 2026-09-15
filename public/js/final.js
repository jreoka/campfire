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
// ---------- native notification bridges ----------
// Two shells have a WebView with no usable notification stack, and they are
// different problems:
//
// - Desktop (Windows/WebView2 implements no Notification API): the app is
//   always running with a live socket, so the page just hands each message it
//   would have shown to the native `notify` command. Nothing to keep alive.
// - Android (Android WebView implements neither PushManager nor Notification,
//   and the shell pauses the WebView whenever the app is backgrounded): the page
//   cannot be the notification path at all. The native PushService
//   (gen/android .../PushService.kt) holds its own socket to the server's
//   /ws/push instead, surviving both backgrounding and the task being swiped
//   away. All the page does is hand that service the session, read its state
//   back for Settings, and route the conversation a tapped notification asks
//   for.
function isAndroidShell() {
  try { return !!(window.__TAURI__ && /android/i.test(navigator.userAgent || '')); } catch { return false; }
}
// The desktop shells (Windows/macOS/Linux) — the page is the notification path
// there, because the app is always running.
function isDesktopShell() {
  try { return !!window.__TAURI__ && !isAndroidShell(); } catch { return false; }
}
// window.CampfireNative is installed by the Android shell's MainActivity.
function nativeBridge() {
  try {
    const b = window.CampfireNative;
    return (b && typeof b.configure === 'function') ? b : null;
  } catch { return null; }
}
function nativePushKey() { return 'cf_native_push:' + ((S.me && S.me.id) || 'anon'); }
function nativePushEnabled() {
  try { return localStorage.getItem(nativePushKey()) !== '0'; } catch { return true; }
}
function setNativePushEnabled(on) {
  try { if (on) localStorage.removeItem(nativePushKey()); else localStorage.setItem(nativePushKey(), '0'); } catch {}
}
function nativePushState() {
  const b = nativeBridge();
  if (!b) return null;
  try { return JSON.parse(b.status() || '{}'); } catch { return {}; }
}
// Hand the shell the session, or take it away on sign-out. Called at boot (via
// pushSetup, which every session runs), and whenever the Settings switch flips.
function syncNativePush(on) {
  const b = nativeBridge();
  if (!b) return;
  const want = (on === undefined ? nativePushEnabled() : !!on) && !!store.token;
  try { b.configure(store.token || '', location.origin, want); } catch {}
}
function nativePushEnable() {
  const b = nativeBridge();
  if (b) { try { b.requestPermission(); } catch {} }
  setNativePushEnabled(true);
  syncNativePush(true);
}
function nativePushDisable() {
  setNativePushEnabled(false);
  syncNativePush(false);
}
// Desktop shell only: on Android the service owns notifications, and a page-led
// one would double up with it.
function nativeNotify(title, body) {
  if (!isDesktopShell()) return false;
  const inv = window.__TAURI__.core && window.__TAURI__.core.invoke;
  if (typeof inv !== 'function') return false;
  try {
    inv('notify', { title: String(title || 'Campfire'), body: String(body || '') }).catch(() => {});
    return true;
  } catch { return false; }
}
// A tapped notification carries the conversation it came from (the server's
// payload url: /?dm=ID, /?server=ID&channel=ID, …). The URL routing itself lives
// in auth.js's handleDeepLinkQuery, shared with a normal page load.
function routeDeepLink(url) {
  try {
    if (typeof handleDeepLinkQuery !== 'function') return;
    return handleDeepLinkQuery(new URL(url, location.origin).searchParams);
  } catch {}
}
// The Android shell calls this when its window is already up.
window.__cfDeepLink = function (url) {
  try { routeDeepLink(url); return true; } catch { return false; }
};
function takeNativeDeepLink() {
  const b = nativeBridge();
  if (!b || typeof b.takeUrl !== 'function') return;
  let url = '';
  try { url = b.takeUrl() || ''; } catch { return; }
  if (url) routeDeepLink(url);
}
// ---------- presence: idle auto-away + the state setter ----------
// The quick-switch menu that used to hang off the avatar is gone: the states
// live on your own user card now (see presenceWidgetHTML in pickers.js), and
// clicking the avatar opens that card like every other avatar does.
function presenceExpiry() { const ts = +((S.me || {}).presence_expires_at || 0); return ts > Date.now() ? ts : 0; }
// Was the current away set by the IDLE CLOCK? That is the one presence activity
// may silently undo. A state the user picked by hand (even a timerless Away,
// which carries no expiry yet) is theirs to keep — the old blanket "untimed
// away → online on activity" rule undid the pick on the very next mouse move, so
// the status looked like it never changed. The origin is recorded SERVER-side
// (users.presence_auto, set only by the idle flip below and cleared by every
// plain status write) because it belongs to the ACCOUNT: with a per-browser
// localStorage marker, picking Away on the phone left the desktop's stale marker
// behind and the next mouse move there undid the pick.
function idleAwayIsOurs() {
  if (!S.me || S.me.status !== 'away' || presenceExpiry()) return false;
  return !!S.me.presence_auto;
}
// The client half of a pick: clear the marker the instant the user taps one, so
// the idle clock cannot race the request and revert it back to Online between
// the tap and the server's answer. The server clears the column for real.
function markPresenceManual() { if (S.me) S.me.presence_auto = 0; }
async function setStatus(s, presenceExpiresAt, opts) {
  try {
    const body = { status: s };
    if (s === 'online' || presenceExpiresAt !== undefined) body.presenceExpiresAt = s === 'online' ? null : (presenceExpiresAt ?? null);
    if (opts && opts.auto) {
      body.presenceAuto = true; // "the idle clock put me here"
      // …and whether THIS device is the one being looked at. The server drops the
      // flip when a hidden device's clock fires while another device of the
      // account is in front (see anyoneInFront in server.js): a phone in a pocket
      // must not read its owner away while the desktop is in use, or the two
      // clocks fight and the dot flaps between amber and green.
      body.presenceVisible = document.visibilityState === 'visible';
    }
    const { user } = await api('/api/me', { method: 'PATCH', body: JSON.stringify(body) });
    S.me = { ...S.me, ...user };
    paintMe(); renderMembers();
    if (S.view === 'home') renderDmMembers();
    // Keep the open user card's dot/label + switcher honest too (this path also
    // fires for the idle auto-away flip, not just the card's own chips).
    try { refreshOwnPresence(); } catch {}
    return true;
  } catch { return false; }
}

// ---------- the idle clock ----------
// Online → Away on its own after five quiet minutes, and back to Online on the
// next thing the user does. Three rules make that hold up:
//   * the deadline is a WALL-CLOCK stamp (lastActive) read by a slow tick, never
//     a lone 5-minute setTimeout. A background tab has its timers throttled and
//     a suspended one has none at all, so a single timeout silently never fires;
//     and, the other way, a fired timeout is never re-armed when the status
//     moves on its own — a timed Away lapsing back to Online at 2am used to
//     leave the account Online for the rest of the night.
//   * ACTIVITY is the user's own input, never the app's. An auto-scroll from an
//     arriving message, a repaint or a game beacon must not count, or a busy
//     channel would pin an empty chair Online forever.
//   * only the idle clock's own Away is reverted (idleAwayIsOurs), and it is
//     reverted on ANY of the account's devices — see markPresenceManual.
const IDLE_AWAY_MS = 5 * 60 * 1000;
const IDLE_TICK_MS = 20 * 1000;   // how late the flip can be: ≤20s visible, ≤60s throttled
const IDLE_RETRY_MS = 60 * 1000;  // a failed flip waits its turn instead of hammering
let lastActive = Date.now();
let idleTicker = null, idlePending = false, idleRetryAt = 0;
// The one question the clock asks.
function idleAwayDue() {
  if (!S.me) return false;
  if ((S.me.status || 'online') !== 'online') return false; // dnd/invisible/away are not ours to move
  if (presenceExpiry()) return false;                       // a timed state owns its own revert
  return Date.now() - lastActive >= IDLE_AWAY_MS;
}
function idleGoAway() {
  const at = lastActive;
  return setStatus('away', undefined, { auto: true }).then((ok) => {
    if (!ok) return false;
    if (S.me.status !== 'away') {
      // The server DROPPED it: this device is hidden and another device of the
      // account is in front. Not an error — back off, and let the world change
      // (the desktop going quiet is what makes the next try land).
      idleRetryAt = Date.now() + IDLE_RETRY_MS;
      return true;
    }
    // The user came back while the request was in flight: the Away is written
    // now, so take it back rather than leave them Away until the next input.
    if (lastActive !== at) { markPresenceManual(); setStatus('online'); }
    return true;
  });
}
function idleTick() {
  if (idlePending || Date.now() < idleRetryAt) return;
  if (!idleAwayDue() || idleAwayIsOurs()) return;
  idlePending = true;
  idleGoAway().then((ok) => { if (!ok) idleRetryAt = Date.now() + IDLE_RETRY_MS; })
    .catch(() => {})
    .then(() => { idlePending = false; });
}
function startIdleWatch() { if (!idleTicker) idleTicker = setInterval(() => { try { idleTick(); } catch {} }, IDLE_TICK_MS); }
// Every kind of input the user makes is activity: the deadline moves, and an
// idle Away (ours — never a picked one) goes back to Online. touchstart and
// wheel matter as much as the mouse pair: a phone user reading by scrolling
// never fires mousemove, and they are exactly who an "away" dot misreads.
function poke() {
  if (!S.me) return;
  lastActive = Date.now();
  startIdleWatch();
  if (idleAwayIsOurs()) { markPresenceManual(); setStatus('online'); }
}
['mousemove', 'keydown', 'click', 'wheel', 'touchstart'].forEach((ev) => document.addEventListener(ev, poke, { passive: true }));
// Coming back to the tab is activity too — and, just as importantly, the moment
// every throttled timer starts running again at full speed.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poke(); });

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
// A bottom sheet whose menu is longer than the sheet is made TALLER by dragging
// it up from its handle/header — the phone gesture, not a scrollbar the thumb
// has to find. The rows stay a scroll region (a flick still scrolls a menu that
// outgrows even the expanded sheet), so this only decides how much of the
// screen the sheet is allowed to claim: drag up past a third of the way and it
// stays tall, drag down and it gives the screen back before the next downward
// pull closes it.
//
// The grab zone is deliberately the chrome, never the rows: a drag from inside
// the list must stay the list's scroll (and, at its top, the close gesture
// swipeDownToClose owns). Direction is decided once per touch, so the two
// handlers can share a finger without fighting over it.
function sheetDragExpand(panel, opts = {}) {
  if (!panel) return;
  const maxH = () => Math.round((window.visualViewport && window.visualViewport.height ? window.visualViewport.height : innerHeight) * (opts.max || 0.94));
  const onGrab = (target) => {
    try { return !!target.closest('.sheet-handle, .sheet-head, .sheet-reacts, .sheet-swrow, .sheet-swlabel'); } catch { return false; }
  };
  let startH = 0, startY = 0, active = false, dir = 0;
  panel.addEventListener('touchstart', (e) => {
    active = false; dir = 0;
    if (e.touches.length !== 1 || (opts.enabled && !opts.enabled())) return;
    if (!onGrab(e.target)) return;
    active = true;
    startH = panel.offsetHeight;
    startY = e.touches[0].clientY;
  }, { passive: true });
  panel.addEventListener('touchmove', (e) => {
    if (!active || e.touches.length !== 1) return;
    const d = startY - e.touches[0].clientY; // up is positive
    if (!dir) {
      if (Math.abs(d) < 6) return;
      // Downward belongs to the close gesture — hand the finger over rather
      // than growing and shrinking the sheet in the same frame.
      if (d < 0) { active = false; return; }
      dir = 1;
    }
    e.preventDefault();
    panel.classList.add('sheet-dragging');
    // The stylesheet's own cap (78vh) is what a drag is lifting, so it has to be
    // overridden while the finger owns the height — clearing the inline value
    // instead would leave the sheet clamped to exactly where it started.
    panel.style.maxHeight = maxH() + 'px';
    panel.style.height = Math.max(120, Math.min(maxH(), startH + d)) + 'px';
  }, { passive: false });
  const end = () => {
    if (!active) return;
    active = false;
    const h = parseFloat(panel.style.height) || 0;
    const wasDrag = !!dir;
    dir = 0;
    panel.classList.remove('sheet-dragging');
    // Settle on the side of the decision the finger was on: the sheet is either
    // tall or it is not, never halfway. The class goes on BEFORE the inline cap
    // comes off, so the height never falls back for a frame.
    if (h && h > startH + 24) panel.classList.add('sheet-tall');
    else if (h) panel.classList.remove('sheet-tall');
    panel.style.height = '';
    panel.style.maxHeight = '';
    if (h) {
      panel.style.transition = 'max-height .2s var(--ease-native)';
      setTimeout(() => { if (!panel.classList.contains('sheet-dragging')) panel.style.transition = ''; }, 220);
    }
    // Only a real drag swallows the release click; a touch that wobbled and
    // lifted is still a tap on whatever row it was over.
    if (wasDrag) swipeDownToClose.swallowUntil = Date.now() + 400;
  };
  panel.addEventListener('touchend', end, { passive: true });
  panel.addEventListener('touchcancel', end, { passive: true });
}

swipeDownToClose($('#profile-backdrop .profile'), () => closeProfileScreen(), { scroller: () => $('#pf-body') });
swipeDownToClose($('#usercard'), () => closeUserCard(), { enabled: () => $('#usercard').classList.contains('sheet') });
// The members drawer's own dismiss: it comes in from the right edge, so it
// leaves the same way. Same touch-event shape as the vertical twin (and it
// shares that swallow window, so the release click cannot land on the member
// row the finger was dragged across), but there is no "at the top" rule: the
// drawer's own list only ever scrolls vertically, so a mostly-horizontal drag
// is always this gesture. A leftward drag or a vertical one is left alone —
// that is the list scrolling.
function swipeRightToClose(panel, onClose, opts = {}) {
  if (!panel) return;
  const threshold = opts.threshold || 80;
  let sx = 0, sy = 0, dx = 0, active = false;
  panel.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || (opts.enabled && !opts.enabled())) { active = false; return; }
    active = true;
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; dx = 0;
  }, { passive: true });
  panel.addEventListener('touchmove', (e) => {
    if (!active || e.touches.length !== 1) return;
    const t = e.touches[0];
    const ddx = t.clientX - sx, ddy = t.clientY - sy;
    if (ddx <= 0 || Math.abs(ddy) > Math.abs(ddx)) { dx = 0; panel.style.transform = ''; panel.style.transition = ''; return; }
    e.preventDefault();
    dx = ddx;
    panel.style.transition = 'none';
    panel.style.transform = 'translateX(' + Math.round(Math.min(dx, 340)) + 'px)';
  }, { passive: false });
  const end = () => {
    if (!active) return;
    active = false;
    const dragged = dx > 8, close = dx > threshold;
    dx = 0;
    if (dragged) swipeDownToClose.swallowUntil = Date.now() + 400;
    if (close) {
      // The class owns the geometry: clearing the inline transform hands the
      // drawer back to `body.members-open`'s rule, and removing it below eases
      // it out through the CSS transition (`--t-drawer`).
      panel.style.transition = '';
      panel.style.transform = '';
      onClose();
      return;
    }
    panel.style.transition = 'transform .2s ease-out';
    panel.style.transform = '';
    setTimeout(() => { panel.style.transition = ''; }, 240);
  };
  panel.addEventListener('touchend', end, { passive: true });
  panel.addEventListener('touchcancel', end, { passive: true });
}
// Only on a phone (and only while it is open): on desktop #members is a static
// column and the enabled() guard leaves it alone.
swipeRightToClose($('#members'), () => document.body.classList.remove('members-open'),
  { enabled: () => document.body.classList.contains('members-open') });
// Context / message sheets are built fresh on every open (see openMsgSheet and
// openCtxSheet), so their swipe is wired where they are created.
// A tap outside the open members drawer dismisses it — and does ONLY that. The
// drawer is a right-hand panel, not a full-screen page, so the tap that lands on
// the chat beside it used to reach whatever was under the finger as well (the
// reported bug: closing the drawer also opened the message/composer button
// underneath). This runs in the CAPTURE phase on purpose: the bubble listener
// further down is on this same document and is what would otherwise do the
// closing, so stopping propagation from here would skip it — instead the drawer
// closes here and the click never reaches the chat at all. `preventDefault` is
// part of it, because stopping propagation does not cancel a link's own default
// action. Header controls are exempt: ☰ and the members button are deliberate
// destinations, and the members button is how the drawer toggles.
document.addEventListener('click', (e) => {
  if (!document.body.classList.contains('members-open')) return;
  const t = e.target;
  if (t && t.closest && (t.closest('#members') || t.closest('#chat-header'))) return;
  document.body.classList.remove('members-open');
  e.stopPropagation();
  e.preventDefault();
}, true);
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
  if (!e.target.closest('#picker') && !e.target.closest('#btn-emoji') && !e.target.closest('#btn-gif') && !e.target.closest('#tbtn-emoji') && !e.target.closest('#tbtn-gif') && !e.target.closest('#srv-tag-emoji') && !e.target.closest('.msg-actions') && !e.target.closest('#sheet')) closePicker();
  // ...and a click that just OPENED the card is not a click outside it either:
  // this listener runs after the opener in the same click, and an already-loaded
  // friend list paints the card before it gets here (ucOpenedByThisClick).
  if (!clickInPath(e, ['#usercard', '#me-card', '[data-uid]', '.member', '.usertag[data-tag-sid]']) && !ucOpenedByThisClick()) closeUserCard();
  if (ctxEl && !e.target.closest('#ctx-menu') && !e.target.closest('.msg-actions')) closeCtx();
  if ($('#emoji-pop') && !e.target.closest('#emoji-pop') && !e.target.closest('#in-message') && !e.target.closest('#in-thread')) hideEmojiPop();
  if (folderFlyoutEl && !e.target.closest('#folder-menu')) closeFolderFlyout();
  // A folder only collapses when its own header (top part) is clicked; never
  // on outside/background clicks or when selecting one of its servers.
  // The ⋯ sheet is exempt for the same reason the header is: on a phone it IS
  // the header (Members lives in it, see ui.js), so a row that toggles the
  // drawer must not be read as a click "outside" it and close it again in the
  // same click — which is exactly why the drawer never opened from there.
  if (document.body.classList.contains('members-open') && !e.target.closest('#members') && !e.target.closest('#btn-members') && !e.target.closest('#sheet')) document.body.classList.remove('members-open');
  if (!e.target.closest('#composer-more') && !e.target.closest('#btn-more') && !e.target.closest('#btn-plus')) $('#composer-more')?.classList.add('hidden');
  if (!e.target.closest('#thread-composer-more') && !e.target.closest('#tbtn-more') && !e.target.closest('#tbtn-plus')) $('#thread-composer-more')?.classList.add('hidden');
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
  () => $('#thread-composer-more')?.classList.add('hidden'),
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
// The thread bar's own anchor: its tools sit in a different box, so the picker
// has to float from there (desktop; a phone keeps the bottom sheet).
function threadComposerAnchor() {
  const t = $('#thread-composer-tools')?.getBoundingClientRect();
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
// The thread bar is the chat bar's own version, so it carries its own copy of the
// tools — emoji, GIF and the + menu — and each one names the field a pick belongs
// to (`S.picker.input`, see pickers.js): an emoji picked here lands in the reply
// box, a GIF picked here joins the reply. Voice / view-once / poll / story are
// deliberately absent: those flows are scoped to a channel, not to a thread.
$('#tbtn-emoji').onclick = () => { $('#picker').classList.contains('hidden') ? openPicker('insert', null, 'emoji', threadComposerAnchor(), 'thread') : closePicker(); };
$('#tbtn-gif').onclick = () => { $('#picker').classList.contains('hidden') ? openPicker('insert', null, 'gifs', threadComposerAnchor(), 'thread') : closePicker(); };
$('#tbtn-more').onclick = (e) => { e.stopPropagation(); closePicker(); $('#thread-composer-more').classList.toggle('hidden'); };
$('#tbtn-plus').onclick = (e) => { e.stopPropagation(); closePicker(); $('#thread-composer-more').classList.toggle('hidden'); };
$('#tcm-attach').onclick = (e) => { e.stopPropagation(); $('#thread-composer-more').classList.add('hidden'); $('#tbtn-attach').click(); };
$('#tcm-emoji').onclick = (e) => { e.stopPropagation(); $('#thread-composer-more').classList.add('hidden'); $('#tbtn-emoji').click(); };
$('#tcm-gif').onclick = (e) => { e.stopPropagation(); $('#thread-composer-more').classList.add('hidden'); $('#tbtn-gif').click(); };
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
// The thread bar's field paints the same backdrop (its textarea is transparent
// too, and only carries the caret) — one painter each, same metrics.
function syncThreadRender() {
  const inp = $('#in-thread'), r = $('#thread-render-inner');
  if (!inp || !r) return;
  r.innerHTML = inp.value ? renderRich(inp.value, { plain: true }) : '';
  r.style.marginLeft = (-inp.scrollLeft) + 'px';
  const c = $('#thread-render');
  if (c) c.scrollTop = inp.scrollTop;
}
$('#in-thread').addEventListener('input', syncThreadRender);
// The send key follows the box (see paintComposerSend): lit as soon as there is
// something to send, muted again when it is emptied.
$('#in-message').addEventListener('input', () => { try { paintComposerSend(); } catch {} });
$('#in-thread').addEventListener('input', () => { try { paintComposerSend(); } catch {} });
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
$('#in-thread').addEventListener('scroll', () => {
  const inp = $('#in-thread'), r = $('#thread-render-inner'), c = $('#thread-render');
  if (c) c.scrollTop = inp.scrollTop;
  if (r) r.style.marginLeft = (-inp.scrollLeft) + 'px';
});

// Broken images (deleted/missing uploads) degrade gracefully instead of
// rendering as crushed broken-image boxes.
document.addEventListener('error', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLImageElement)) return;
  // A derived image preview that could not be minted — the server would not park
  // the request behind a cold encode, or the bytes will not decode — falls back
  // to the attachment's own upload, once. The marker is cleared first so a
  // second failure degrades to the file card below instead of looping.
  if (t.dataset.fbThumb && t.dataset.fbUrl) {
    t.removeAttribute('data-fb-thumb');
    t.src = t.dataset.fbUrl;
    return;
  }
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

// ---------- update banner (a deploy never reloads the page for you) ----------
// A new build used to take the page: a toast with a Refresh button, a 30-second
// timer that reloaded anyway, an immediate reload the moment you left a voice
// call, and — if the socket reconnected mid-check — another one on the spot. A
// reader in the middle of typing, reading or a call could lose their place with
// no warning. Nothing reloads itself now. The banner waits at the top of the
// shell, the reader presses Update when it suits them, and dismissing it is a
// real choice: the app keeps working on the old build until they reload for
// some other reason (which is safe — the client/server protocol is additive).
//
// "Is there a newer release?" is answered by the server's RELEASE GENERATION, a
// cluster-wide counter (see app_releases in db.js), not by the build fingerprint.
// With a rolling update across replicas two builds are live at once, so a tab
// that booted from the new pod can poll an old one — and a fingerprint reads as
// a change in either direction, so it would announce the build the tab just left
// as "the update". A generation makes "older" decidable: the old pod reports a
// LOWER number and prompts nothing.
S.bootVersion = null;   // fingerprint, for the record
S.bootGen = null;       // generation of the build this page is running
S.updateReady = false;  // a newer release is waiting
S.updateDismissed = false;
S.updateGen = 0;        // generation of the release being offered
S.updateDismissedGen = 0;
// Record what this page is running. Always called before any comparison, so a
// client never prompts against a generation it has not established yet.
function noteBuild(version, gen) {
  if (version) S.bootVersion = version;
  if (S.bootGen === null) S.bootGen = (typeof gen === 'number' && gen > 0) ? gen : 0;
}
function updateBannerEl() { return $('#update-banner'); }
function paintUpdateBanner() {
  const el = updateBannerEl();
  if (!el) return;
  const on = !!(S.updateReady && !S.updateDismissed);
  el.classList.toggle('hidden', !on);
  // The strip takes real space, so the shell pays for it instead of hiding a
  // header underneath (see the #update-banner block in styles.css).
  document.body.classList.toggle('ub-open', on);
  if (!on) return;
  const sub = $('#ub-sub'), go = $('#ub-go');
  // In a call, reloading ends it — say so, and label the button with what it
  // will actually do rather than letting it read as a harmless refresh. The copy
  // is kept SHORT because this is a single ellipsised line on a phone: the old
  // "You are in a call — updating will end it" truncated to "…will …", cutting
  // the one word that mattered (test-update-banner-layout.js asserts it fits).
  if (sub) sub.textContent = S.voice
    ? 'Updating will end your call.'
    : 'A new version of Campfire has rolled out.';
  if (go) { go.textContent = S.voice ? 'Leave & update' : 'Update'; go.disabled = false; }
}
async function checkVersion() {
  try {
    const r = await fetch('/api/version', { cache: 'no-store' });
    const { version, gen } = await r.json();
    if (S.bootGen === null) { noteBuild(version, gen); return; }
    if (typeof gen === 'number' && gen > 0) {
      if (gen > S.bootGen) onUpdateReady(gen);
      return;
    }
    // A server too old to report a generation: fall back to the fingerprint. It
    // cannot tell which build is newer, so it only fires for a version this page
    // is not running and has not already offered.
    if (version && version !== S.bootVersion && !S.updateReady) onUpdateReady(0);
  } catch { try { if (typeof armConnSoon === 'function') armConnSoon(); } catch {} }
}
// Called from the version poll, from the socket's `hello` after a reconnect
// (a deploy drops every socket), and from the service worker's ping.
function onUpdateReady(gen) {
  const g = Number(gen) || 0;
  if (S.updateReady) {
    // Already waiting on this release or a newer one — nothing to re-announce.
    if (!g || g <= S.updateGen) return;
    // A NEWER release than the one that was dismissed speaks up again.
    if (S.updateDismissed && g <= S.updateDismissedGen) return;
    S.updateDismissed = false;
  }
  S.updateReady = true;
  if (g > S.updateGen) S.updateGen = g;
  paintUpdateBanner();
}
function dismissUpdateNotice() {
  S.updateDismissed = true;
  S.updateDismissedGen = S.updateGen || 0;
  paintUpdateBanner();
}
function applyUpdate() {
  const go = $('#ub-go');
  if (go) { go.disabled = true; go.textContent = 'Updating…'; }
  // Same last-breath flush beforeunload does, done here too so the click itself
  // is the moment the drafts are safe.
  try { flushDrafts(); } catch {}
  try { rememberView(); } catch {}
  try { pinSeenFlush(); } catch {}
  location.reload();
}
{
  const go = $('#ub-go'), x = $('#ub-x');
  if (go) go.addEventListener('click', applyUpdate);
  if (x) x.addEventListener('click', dismissUpdateNotice);
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
// A phone that slept through the night has missed every live push, so the
// durable unread state is re-read here too — this is the "opened the app and
// nothing looked unread" case. Throttled: the app fires visibilitychange for
// every app switch, and each pass costs three requests.
let unreadRefreshAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  // Foregrounding is also when a tapped notification is waiting to be routed
  // (the Android shell parks it until the page is up) and when an upload that
  // stalled while the page was hidden gets its verdict instead of shimmering.
  try { takeNativeDeepLink(); } catch {}
  try { if (typeof sweepStalledUploads === 'function') sweepStalledUploads(); } catch {}
  try { clearActiveChanUnread(); } catch {}
  if (Date.now() - unreadRefreshAt < 10000) return;
  unreadRefreshAt = Date.now();
  try { refreshUnreadState(); } catch {}
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
