/* Campfire — the native shell.
 *
 * Everything in here exists for one reason: the installed app (and the mobile
 * web app) should behave like an app, not like a page in a browser. Three
 * pieces, none of which the SPA had before:
 *
 *   1. Back navigation. Android's system back button / edge-swipe and the
 *      browser's back gesture are THE navigation primitive on a phone. The SPA
 *      never touched history, so back from an open lightbox, a half-written
 *      story or a DM left the app entirely. Now one sentinel history entry is
 *      armed while the shell is up; a back press closes exactly one thing (the
 *      topmost overlay, then the nav page, then "leave the conversation for
 *      the list") and re-arms. When nothing is left to close we stop re-arming,
 *      so the next press leaves the app — what back does at the root of a
 *      native app.
 *
 *   2. Edge-swipe navigation. Swiping in from the left edge of a conversation
 *      pulls the nav page in under the finger; swiping left on the open nav
 *      page pushes it away. Same gesture as every native chat app, and the page
 *      tracks the finger rather than snapping after the fact.
 *
 *   3. Two small platform affordances that CSS cannot do on its own: `:active`
 *      press states need a touchstart listener to exist at all on iOS, and the
 *      installed-app flag (`html.standalone`) is read once here for the few
 *      rules that should only apply to the installed app.
 */
'use strict';

// ---------------------------------------------------------------------------
// 1. Back navigation
// ---------------------------------------------------------------------------

// The back stack, topmost first. Each layer answers "is this actually on
// screen right now?" and closes exactly that one thing. Order is the visual
// stacking order, so a sheet opened over settings closes before settings does.
// The closers are the app's own functions — back must leave the same state
// behind as tapping ✕, or a re-open would find a half-torn-down overlay.
const CF_BACK_LAYERS = [
  // Fullscreen media first: they sit above everything.
  { name: 'story-compose-audience', open: () => cfVisible('#story-compose') && cfVisible('#sc-pick'), close: () => { if (typeof sc !== 'undefined' && sc && !sc.busy) storySetStep('preview'); } },
  { name: 'story-compose', open: () => cfVisible('#story-compose'), close: () => closeStoryComposer() },
  { name: 'viewonce', open: () => cfShown('#vo-view'), close: () => { closeViewOnce(); } },
  { name: 'story-viewer', open: () => cfShown('#story-view'), close: () => svClose() },
  { name: 'lightbox', open: () => cfShown('#lightbox'), close: () => closeLightbox() },
  // The create-story chooser sits over the app like a dialog.
  { name: 'story-new', open: () => cfShown('#story-new'), close: () => closeStoryNewMenu() },
  // Menus and sheets: these are the ones that genuinely used to trap a phone.
  { name: 'folder-flyout', open: () => !!document.querySelector('#folder-menu'), close: () => closeFolderFlyout() },
  { name: 'folder-popout', open: () => cfFolderOpen(), close: () => closeFolderPopout() },
  { name: 'ctx-sheet', open: () => !!document.querySelector('#sheet'), close: () => closeMsgSheet() },
  { name: 'ctx-menu', open: () => !!document.querySelector('#ctx-menu'), close: () => closeCtx() },
  { name: 'picker', open: () => cfVisible('#picker'), close: () => closePicker() },
  { name: 'composer-more', open: () => cfVisible('#composer-more'), close: () => $('#composer-more').classList.add('hidden') },
  { name: 'emoji-pop', open: () => cfVisible('#emoji-pop'), close: () => hideEmojiPop() },
  { name: 'mention-pop', open: () => cfVisible('#mention-pop'), close: () => hideMentionPop() },
  { name: 'chan-pop', open: () => cfVisible('#chan-pop'), close: () => hideChanPop() },
  // Cards and panels.
  { name: 'usercard', open: () => cfVisible('#usercard'), close: () => closeUserCard() },
  { name: 'tagcard', open: () => cfVisible('#tagcard'), close: () => closeTagCard() },
  { name: 'profile', open: () => cfShown('#profile-backdrop'), close: () => closeProfileScreen() },
  { name: 'modal', open: () => cfShown('#modal-backdrop'), close: () => cancelModal() },
  { name: 'settings', open: () => cfShown('#settings-backdrop'), close: () => closeSettings() },
  { name: 'admin', open: () => cfShown('#admin-backdrop'), close: () => closeAdminConsole() },
  { name: 'server-settings', open: () => cfShown('#srv-settings-backdrop'), close: () => closeServerSettings() },
  { name: 'channel-settings', open: () => cfShown('#chan-settings-backdrop'), close: () => closeChannelSettings() },
  { name: 'call-view', open: () => cfCallOpen(), close: () => closeCallView() },
  { name: 'thread', open: () => cfVisible('#thread-panel'), close: () => closeThread() },
  { name: 'find', open: () => cfVisible('#find-panel'), close: () => closeFind() },
  { name: 'members-drawer', open: () => document.body.classList.contains('members-open'), close: () => document.body.classList.remove('members-open') },
];

// Is this overlay on screen? Accepts an element or a selector — a selector is
// not a convenience, it is a guard: every layer predicate runs inside a
// try/catch so that one broken overlay can never wedge the back button, and a
// predicate that silently throws is therefore indistinguishable from one that
// is legitimately closed. Taking both forms removes the trap.
function cfShown(el) {
  if (typeof el === 'string') el = $(el);
  return !!el && !el.classList.contains('hidden');
}
function cfVisible(sel) { return cfShown(sel); }
function cfCallOpen() {
  try { return !!(typeof S !== 'undefined' && S.callOpen); } catch { return false; }
}
function cfFolderOpen() {
  try { return !!(typeof S !== 'undefined' && S.openFolderId); } catch { return false; }
}

// Back is only intercepted on a touch device. On a desktop browser the back
// button belongs to the browser — hijacking Alt+Left / the back arrow to close
// a popup would be its own kind of wrong.
function cfBackWanted() {
  try { return isCoarse(); } catch { return false; }
}

let cfArmed = false;

function cfArm() {
  if (cfArmed || !cfBackWanted()) return;
  try {
    history.pushState({ cfNav: 1 }, '', location.href);
    cfArmed = true;
  } catch {}
}

// Drop the sentinel without treating the resulting popstate as a user press.
function cfDisarm() {
  if (!cfArmed) return;
  cfArmed = false;
  try { history.back(); } catch {}
}

// One back press. Returns true when it closed/opened something (so the shell
// re-arms for the next press), false at the root.
function cfBack() {
  for (const layer of CF_BACK_LAYERS) {
    try {
      if (!layer.open()) continue;
      layer.close();
      return true;
    } catch {}
  }
  // The nav page itself.
  if (document.body.classList.contains('nav-open')) {
    cfCloseNav();
    return true;
  }
  // A conversation on a phone steps back to the list, not out of the app.
  if (cfPhone() && cfInConversation()) {
    cfOpenNav();
    return true;
  }
  return false;
}

function cfPhone() {
  try { return phoneLayout(); } catch { return false; }
}
function cfInConversation() {
  if (document.body.classList.contains('dm-open')) return true;
  try { return S.view === 'server' && !!S.channelId; } catch { return false; }
}
function cfOpenNav() { document.body.classList.add('nav-open'); cfArm(); }
function cfCloseNav() { document.body.classList.remove('nav-open'); cfArm(); }

window.addEventListener('popstate', () => {
  // A disarm() consumes the sentinel itself; that pop is ours, not the user's.
  if (!cfArmed) return;
  cfArmed = false;
  if (cfBack()) cfArm();
});

// Arm once the shell is signed in. The sentinel is (re)armed on the first sign
// of life rather than at parse time, because the boot sequence is async: at
// script-eval time S.me does not exist yet, and arming over the auth screen
// would swallow the back button for a user who is not even in the app.
function cfMaybeArm() {
  if (cfArmed) return;
  try { if (S && S.me) cfArm(); } catch {}
}
try { cfMaybeArm(); } catch {}
document.addEventListener('pointerdown', cfMaybeArm, { passive: true, capture: true });
document.addEventListener('touchstart', cfMaybeArm, { passive: true, capture: true });
document.addEventListener('keydown', cfMaybeArm, { capture: true });
// Signing out drops it again: the auth screen has nothing to step back through.
window.addEventListener('cf:signed-out', cfDisarm);

// ---------------------------------------------------------------------------
// 2. Edge-swipe navigation
// ---------------------------------------------------------------------------
// The nav page is the phone's "conversation list", so it gets the two gestures
// every chat app has: pull it in from the left edge, push it out to the left.
// The page tracks the finger and the release picks a side, so the motion is
// continuous instead of a delayed snap.

const CF_EDGE = 26;        // px from the left edge that starts an open-swipe
const CF_AXIS = 12;        // px of travel before we commit to horizontal
const CF_SETTLE = 0.34;    // fraction of the page width that locks the swipe in

let cfDrag = null;

function cfLeftEl() { return $('#left'); }

function cfNavDragBlocked(target) {
  // Anything that owns horizontal dragging or scrolling of its own keeps it.
  if (!target || !target.closest) return false;
  return !!target.closest('.anow-rail, .set-tabs, #sidebar-resizer, #thread-resizer, #lightbox, #story-view, #story-compose, #vo-view, #sv-floats, .gif-grid, .hist-row, input, textarea, select');
}

function cfSetDragVisual(mode, dx) {
  const el = cfLeftEl();
  if (!el) return;
  const w = el.offsetWidth || 1;
  const shift = mode === 'close' ? Math.max(-w, dx) : Math.min(w, Math.max(0, dx));
  el.style.transform = 'translateX(' + shift + 'px)';
}

function cfEndDrag(commit) {
  const el = cfLeftEl();
  const drag = cfDrag;
  cfDrag = null;
  if (!el || !drag || drag.axis !== 'x') return;
  const w = el.offsetWidth || 1;
  const travelled = drag.mode === 'open' ? Math.max(0, drag.dx) : Math.max(0, -drag.dx);
  const far = commit && travelled > w * CF_SETTLE;
  // Opening commits when the page is pulled in far enough; closing commits on
  // the mirror image of the same distance.
  const open = drag.mode === 'open' ? far : !far;
  el.classList.remove('nav-dragging');
  // Animate from wherever the finger left it to the side it belongs on, then
  // hand the state back to the CSS class and drop the inline geometry. The
  // targets are the stylesheet's own values so the finish cannot pop.
  el.style.transition = 'transform .24s cubic-bezier(.2,0,0,1)';
  el.style.transform = open ? 'translateX(0%)' : 'translateX(-102%)';
  let fired = false;
  let once = () => {};
  const done = () => {
    if (fired) return;
    fired = true;
    el.removeEventListener('transitionend', once);
    el.style.transition = '';
    el.style.transform = '';
    document.body.classList.toggle('nav-open', open);
  };
  once = () => done();
  el.addEventListener('transitionend', once);
  setTimeout(once, 320);
}

document.addEventListener('touchstart', (e) => {
  if (!cfPhone() || !cfBackWanted()) return;
  if (document.body.classList.contains('nav-open')) {
    // Only from the nav page's own surface, and never from a drawer above it.
    if (document.body.classList.contains('members-open')) return;
    if (!cfLeftEl()) return;
    if (cfNavDragBlocked(e.target)) return;
    const t = e.touches[0];
    cfDrag = { mode: 'close', x0: t.clientX, y0: t.clientY, dx: 0, axis: null };
    return;
  }
  const t = e.touches[0];
  if (t.clientX > CF_EDGE) return;
  if (!cfInConversation()) return;
  if (document.querySelector('#sheet, #ctx-menu, #picker, #modal-backdrop:not(.hidden), #profile-backdrop:not(.hidden), #lightbox:not(.hidden), #story-view:not(.hidden), #story-compose:not(.hidden), #vo-view:not(.hidden), #usercard:not(.hidden), #settings-backdrop:not(.hidden)')) return;
  cfDrag = { mode: 'open', x0: t.clientX, y0: t.clientY, dx: 0, axis: null };
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (!cfDrag) return;
  const t = e.touches[0];
  const dx = t.clientX - cfDrag.x0;
  const dy = t.clientY - cfDrag.y0;
  if (cfDrag.axis === null) {
    if (Math.abs(dx) < CF_AXIS && Math.abs(dy) < CF_AXIS) return;
    // Vertical intent belongs to the list under the finger.
    if (Math.abs(dy) > Math.abs(dx)) { cfDrag = null; return; }
    cfDrag.axis = 'x';
    const el = cfLeftEl();
    if (el) el.classList.add('nav-dragging');
  }
  if (cfDrag.mode === 'open' && dx <= 0) { cfDrag.dx = 0; cfSetDragVisual('open', 0); return; }
  if (cfDrag.mode === 'close' && dx >= 0) { cfDrag.dx = 0; cfSetDragVisual('close', 0); return; }
  cfDrag.dx = dx;
  cfSetDragVisual(cfDrag.mode, dx);
  e.preventDefault();
}, { passive: false });

function cfTouchEnd() {
  if (!cfDrag) return;
  if (cfDrag.axis !== 'x') { cfDrag = null; return; }
  cfEndDrag(true);
}
document.addEventListener('touchend', cfTouchEnd, { passive: true });
document.addEventListener('touchcancel', () => { if (cfDrag && cfDrag.axis === 'x') cfEndDrag(false); else cfDrag = null; }, { passive: true });

// ---------------------------------------------------------------------------
// 3. Platform affordances
// ---------------------------------------------------------------------------

// iOS only paints :active while a touchstart listener exists on the document.
// Without this, every press state in the stylesheet is invisible on iPhone —
// which is most of what makes a tap feel like it landed.
document.addEventListener('touchstart', () => {}, { passive: true });

// Coarse pointers get a tick when the nav page locks open or shut: the gesture
// has no other confirmation that it committed.
try {
  document.addEventListener('click', (e) => {
    if (!e.target.closest) return;
    if (e.target.closest('#btn-menu, #btn-nav-close')) haptic(7);
  });
} catch {}
