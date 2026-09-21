/* Campfire — the address bar.
 *
 * Every place in the app has a path: /login, /signup, /home, /stories,
 * /dm/<thread> and /c/<server>[/<channel>]. Two halves, and the order between
 * them matters:
 *
 *   1. WRITING. Every navigation already funnels through rememberView()
 *      (selectServer, selectChannel, selectDmThread, openHome, showFriendsPanel,
 *      showStoriesPanel), so the URL is painted there rather than from a dozen
 *      call sites — one hook, and a view change that forgets to call it is a view
 *      change that also forgets its last-view memory. The path is derived from
 *      the state that is on screen, never accumulated.
 *
 *   2. READING. boot() resolves the path BEFORE the local last-view memory, so a
 *      pasted link opens the thing it names even on a device that has never seen
 *      it. A signed-out visitor is sent to /login with the target kept aside
 *      (sessionStorage, the same trick as an invite code) and lands on it after
 *      signing in; an unusable one degrades to Home rather than an error page.
 *
 * Deliberately replaceState, never pushState. native.js owns exactly ONE history
 * entry — the back sentinel it re-arms on every press — and one entry per
 * navigation would bury it and hand Android's back button a trail the app never
 * offered to walk (the URL is a label for where you are, not a second back
 * stack). Two consequences of that rule are load-bearing:
 *
 *   - The existing history STATE is passed straight back through, or the
 *     sentinel's { cfNav: 1 } would be erased by the first navigation and back
 *     would stop closing anything on a phone.
 *   - The query string is preserved: boot still has to READ it (?dm=, ?story=,
 *     ?invite=) and a navigation that happened to land before boot's deep-link
 *     pass must not be able to strip it.
 *
 * /invite/:code and /share keep their own paths and this file actively stays off
 * them: the server routes the first one with the server's own OpenGraph preview,
 * both are read from the pathname at the END of boot (consumeInvite /
 * consumeShare), and a last-view restore that landed first would otherwise
 * rename the URL out from under them and eat the invite code or share payload.
 * cfReservedPath is that promise.
 */
'use strict';

const CF_LOGIN = '/login';
const CF_SIGNUP = '/signup';
const CF_ROUTE_KEY = 'cf_route'; // where to land after signing in (sessionStorage)
const CF_URL_KEY = 'cf_url'; // the last path this TAB wrote, and whose account wrote it
const CF_SEG = /^[\w-]{1,64}$/; // ids are uuids; a shape check on the RAW segment, never after decoding

// Path -> what it names. Returns null for anything this app does not claim, which
// is what keeps /invite/:code, /share and junk out of the router's hands.
function cfRouteFromPath(path) {
  let p = String(path || '/').split('?')[0].split('#')[0];
  if (p.length > 1) p = p.replace(/\/+$/, '');
  if (p === '' || p === '/') return null;
  const seg = p.replace(/^\/+/, '').split('/');
  if (seg.some((s) => !CF_SEG.test(s))) return null; // strict: no empty segment, no escape
  const head = seg[0].toLowerCase();
  if (seg.length === 1) {
    if (head === 'login') return { kind: 'login' };
    if (head === 'signup' || head === 'register') return { kind: 'signup' };
    if (head === 'home' || head === 'friends') return { kind: 'home' };
    if (head === 'stories') return { kind: 'stories' };
    return null;
  }
  // /channels/... is accepted as an alias of /c/... (it is what every other chat
  // app calls this route); the canonical form is always the short one.
  if (head === 'dm' && seg.length === 2) return { kind: 'dm', id: seg[1] };
  if ((head === 'c' || head === 'channels') && (seg.length === 2 || seg.length === 3)) {
    return { kind: 'server', serverId: seg[1], channelId: seg[2] || null };
  }
  return null;
}
// The path for what is on screen. Null while signed out: the auth screen has its
// own two paths and cfSetPath (below) is what names them.
function cfPathForState() {
  try {
    if (!S.me) return null;
    if (S.view === 'home') {
      if (S.dmThreadId) return '/dm/' + encodeURIComponent(S.dmThreadId);
      return S.homePanel === 'stories' ? '/stories' : '/home';
    }
    if (S.view === 'server' && S.serverId) {
      return S.channelId
        ? '/c/' + encodeURIComponent(S.serverId) + '/' + encodeURIComponent(S.channelId)
        : '/c/' + encodeURIComponent(S.serverId);
    }
  } catch {}
  return null;
}
function cfSetPath(p) {
  if (!p) return false;
  cfRememberUrl(p);
  const url = p + location.search + location.hash;
  if (url === location.pathname + location.search + location.hash) return true;
  try { history.replaceState(history.state || null, '', url); return true; } catch { return false; }
}
// A URL is a label for where AN ACCOUNT is, and this tab wrote it on that
// account's behalf. So the bar is remembered with its owner, and a path that is
// still exactly as that account left it does not get to speak for a different
// one — signing in as somebody else must not surface the previous person's
// conversation, the same rule the per-account last-view memory and the draft
// store already live by. A path this tab did NOT write (a pasted link, a
// bookmark, a notification) is the reader's own entry and is always honored.
function cfRememberUrl(p) {
  try {
    sessionStorage.setItem(CF_URL_KEY, JSON.stringify({
      p: String(p).split('?')[0].split('#')[0],
      u: (typeof S !== 'undefined' && S.me) ? S.me.id : null,
    }));
  } catch {}
}
function cfUrlOwnedByOther(meId) {
  try {
    const v = JSON.parse(sessionStorage.getItem(CF_URL_KEY) || 'null');
    if (!v || !v.u) return false; // no account wrote it: it is the reader's own entry
    if (v.p !== location.pathname) return false; // a later navigation replaced it
    return v.u !== (meId || null);
  } catch { return false; }
}
// Paths the shell serves but this file does not own: /invite/:code (the server
// builds that page's preview) and /share are read from the pathname at the END of
// boot, so a navigation that lands first must not rename the URL before their own
// module has looked at it.
function cfReservedPath(p) {
  const s = String(p || '');
  return /^\/invite\/[\w-]+\/?$/.test(s) || /^\/share\/?$/.test(s);
}
// The one writer. Called from rememberView() on every view change.
function cfSyncUrl() {
  try { if (cfReservedPath(location.pathname)) return false; } catch {}
  return cfSetPath(cfPathForState());
}
// What native.js's back sentinel has to be pushed at: the canonical path of the
// view on screen, so a back press cannot leave a stale path in the bar (the entry
// it pops to is whatever the page was loaded or last labelled with).
function cfArmUrl() {
  try { return (cfPathForState() || location.pathname) + location.search + location.hash; }
  catch { return location.href; }
}

/* ---------- the signed-out side ----------
 * showAuth() calls this the moment the auth screen is up. It names the screen in
 * the bar and keeps a deeper target aside for after sign-in; a path it does not
 * recognize (an invite, a share action, junk) is left exactly where it is,
 * because something else may still have to read it. */
function cfAuthScreenEnter() {
  let r = null;
  try { r = cfRouteFromPath(location.pathname); } catch {}
  if (r && r.kind === 'signup') {
    try { setMode('register'); } catch {}
    cfSetPath(CF_SIGNUP);
    return;
  }
  if (r && r.kind !== 'login' && !cfUrlOwnedByOther(null)) cfStashPendingRoute(location.pathname);
  if (r || location.pathname === '/') cfSetPath(CF_LOGIN);
}
function cfStashPendingRoute(p) {
  try { if (p && p !== '/') sessionStorage.setItem(CF_ROUTE_KEY, p); } catch {}
}
function cfTakePendingRoute() {
  let p = null;
  try { p = sessionStorage.getItem(CF_ROUTE_KEY); if (p) sessionStorage.removeItem(CF_ROUTE_KEY); } catch {}
  return p ? cfRouteFromPath(p) : null;
}
function cfForgetPendingRoute() { try { sessionStorage.removeItem(CF_ROUTE_KEY); } catch {} }

/* ---------- the signed-in side ----------
 * Resolved once, by boot(), in place of the local last-view memory. The stash is
 * only consulted when the path itself has nothing to say (/login after a session
 * dropped), so a fresh load of a real path can never pick up a stale target. */
function cfBootRoute() {
  const r = cfRouteFromPath(location.pathname);
  if (r && r.kind !== 'login' && r.kind !== 'signup') {
    if (cfUrlOwnedByOther((typeof S !== 'undefined' && S.me) ? S.me.id : null)) return null;
    return r;
  }
  return cfTakePendingRoute();
}
async function cfOpenRoute(r) {
  if (!r) return;
  try {
    if (r.kind === 'home') return await openHome({ panel: 'friends', dm: null });
    if (r.kind === 'stories') return await showStoriesPanel();
    if (r.kind === 'dm') return await cfOpenDmRoute(r.id);
    if (r.kind === 'server') return await cfOpenServerRoute(r.serverId, r.channelId);
  } catch {}
}
async function cfOpenDmRoute(id) {
  await openHome({ panel: 'friends', dm: null });
  if (S.dms.some((t) => t.id === id)) { selectDmThread(id); return; }
  // A dismissed (hidden) thread is still joinable — the notification deep link
  // reopens it the same way, one API call away.
  try {
    const { thread } = await api(`/api/dms/${id}/open`, { method: 'POST' });
    await refreshDms();
    if (S.dms.some((t) => t.id === thread.id)) selectDmThread(thread.id);
  } catch { toast('That conversation is no longer available'); }
}
async function cfOpenServerRoute(serverId, channelId) {
  if (!S.servers.some((s) => s.id === serverId)) {
    toast('That server is not in your list');
    await openHome({ panel: 'friends', dm: null });
    return;
  }
  await selectServer(serverId);
  if (!channelId) return;
  const ch = (S.serverDetail?.channels || []).find((c) => c.id === channelId);
  if (!ch) { toast('That channel no longer exists'); return; }
  // A voice room has no "selected" state — opening one JOINS it — so a path that
  // names one lands on the server and leaves the joining to the reader.
  if (ch.type === 'text') await selectChannel(channelId);
}
