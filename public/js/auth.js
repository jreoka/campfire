'use strict';
// ---------- auth ----------
let mode = 'login';
// Cloudflare Turnstile: site key comes from /api/config (public). The widget
// stays hidden until the user presses Log in / Create account — the form
// stays clean until the captcha is actually needed. Tokens are single-use,
// so the widget resets after every consumed submit (never while the user
// is still solving, and never in a way that auto-resubmits).
S.turnstileKey = null; S.tsWidget = undefined;
let tsNeeded = false; // submit was pressed: the captcha area may now appear
let submitting = false; // a submit is in flight (guards against double-fire)
function renderTurnstile() {
  if (!S.turnstileKey || !window.turnstile || S.tsWidget !== undefined) return;
  const slot = document.querySelector('#ts-widget');
  if (!slot) return;
  try {
    slot.innerHTML = '';
    // callback fires when the challenge is solved (or auto-passes). If the
    // user already pressed submit, re-submit automatically — no second click.
    S.tsWidget = turnstile.render(slot, {
      sitekey: S.turnstileKey,
      theme: (typeof getTheme === 'function' && getTheme() === 'light') ? 'light' : 'dark',
      callback: () => { if (tsNeeded && !submitting) doAuthSubmit(); },
      // Token sat unsent past its lifetime: re-arm the widget so the user
      // can solve again (the kept submit intent auto-submits on solve).
      'expired-callback': () => { try { turnstile.reset(S.tsWidget); } catch {} },
      // Widget-level failure (blocked CDN, VPN/proxy interference, ...):
      // say so plainly instead of spinning/resetting forever.
      'error-callback': () => { authError('Captcha failed to load — disable adblock/VPN for this site and reload the page.'); },
    });
  } catch { S.tsWidget = undefined; }
}
// Shows + renders the captcha area if it's ready; true when it's visible
// (or when captcha is unconfigured), false while the API script loads.
function showTurnstile() {
  if (!S.turnstileKey) return true;
  if (!window.turnstile) return false;
  // Unhide BEFORE rendering: Turnstile misbehaves (sizing errors, reset
  // loops) when rendered into a display:none container.
  $('#ts-wrap').classList.remove('hidden');
  if (S.tsWidget === undefined) renderTurnstile();
  return S.tsWidget !== undefined;
}
// Named in index.html (?onload=cfTurnstileReady): fires when the API script
// finishes loading. Assigned here so it exists before the async script runs.
// Only surfaces the widget if the user has already pressed submit.
window.cfTurnstileReady = () => {
  if (!S.turnstileKey || S.tsWidget !== undefined) return;
  // Only surface the widget if the user has already pressed submit —
  // otherwise the login form stays clean until the captcha is needed.
  if (!tsNeeded) return;
  renderTurnstile();
  if (S.tsWidget !== undefined) $('#ts-wrap').classList.remove('hidden');
  doAuthSubmit(); // submit was pressed while the script loaded
};
async function initTurnstile() {
  try {
    const cfg = await api('/api/config');
    if (!cfg || !cfg.turnstileSiteKey) return;
    S.turnstileKey = cfg.turnstileSiteKey;
  } catch {}
}
function turnstileToken() {
  try { return (window.turnstile && S.tsWidget !== undefined) ? turnstile.getResponse(S.tsWidget) : ''; }
  catch { return ''; }
}
function turnstileReset() {
  try { if (window.turnstile && S.tsWidget !== undefined) turnstile.reset(S.tsWidget); } catch {}
}
function authError(msg) {
  const el = $('#auth-error');
  el.textContent = '⚠️ ' + msg;
  el.classList.remove('hidden');
}
function setMode(m) {
  mode = m;
  $('#tab-login').classList.toggle('active', m === 'login');
  $('#tab-register').classList.toggle('active', m === 'register');
  $('#wrap-display').classList.toggle('hidden', m === 'login');
  $('#wrap-confirm').classList.toggle('hidden', m === 'login');
  $('#btn-auth').textContent = m === 'login' ? 'Log in' : 'Create account';
  $('#auth-error').classList.add('hidden');
}
$('#tab-login').onclick = () => setMode('login');
$('#tab-register').onclick = () => setMode('register');
$('#form-auth').addEventListener('submit', (e) => {
  e.preventDefault();
  doAuthSubmit();
});
// Shared submit path: the button and the Turnstile completion callback both
// funnel here, so solving the captcha after the first click submits on its own.
async function doAuthSubmit() {
  if (submitting) return;
  submitting = true;
  let didSubmit = false; // a captcha token was consumed: reset the widget after (tokens are single-use)
  try {
    const username = $('#in-username').value.trim();
    const password = $('#in-password').value;
    const displayName = $('#in-display').value.trim();
    $('#auth-error').classList.add('hidden');
    if (mode === 'register' && password !== $('#in-confirm').value) {
      authError('Passwords do not match.');
      return;
    }
    let token = '';
    if (S.turnstileKey) {
      tsNeeded = true;
      if (!showTurnstile()) { authError('Captcha still loading — wait a moment and try again.'); return; }
      token = turnstileToken();
      if (!token) { authError('Complete the captcha to continue.'); return; }
      // The submit intent is consumed HERE, before the API call — not after.
      // A failed attempt (wrong password, taken name, rejected captcha...)
      // must not leave tsNeeded set: the reset below re-runs the challenge,
      // whose callback would auto-submit again — an infinite
      // solve→fail→reset loop that looks like a broken, ever-resetting captcha.
      tsNeeded = false;
      didSubmit = true;
    }
    const data = mode === 'login'
      ? await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password, turnstile: token, device: deviceName() }) })
      : await api('/api/register', { method: 'POST', body: JSON.stringify({ username, password, displayName, turnstile: token, device: deviceName() }) });
    // (tsNeeded was already cleared above, before the API call, so the
    // reset below can never trigger a re-submit — including when the user
    // is already typing into the 2FA step.)
    if (data.need2fa) { pending2faTmp = data.tmp; show2faStep(); return; }
    store.token = data.token;
    if (data.sid) store.sid = data.sid;
    await boot();
  } catch (err) {
    const el = $('#auth-error');
    el.textContent = '⚠️ ' + prettyError(err.message);
    el.classList.remove('hidden');
  } finally {
    submitting = false;
    // Only reset when a token was actually consumed. Resetting on the
    // "complete the captcha" path would yank the widget the user is
    // about to solve; never resetting would reuse a single-use token.
    if (didSubmit) turnstileReset();
  }
}
function prettyError(e) {
  const map = {
    invalid_login: 'Wrong username or password.', username_taken: 'That username is taken.',
    bad_username: 'Username needs 2–24 chars (a-z, 0-9, _ .).', bad_invite: 'Invite code not found.',
    invite_expired: 'This invite has expired.', invite_exhausted: 'This invite has reached its use limit.',
    bad_limit: 'Pick a use limit between 1 and 100000.', bad_expiry: 'Pick a valid expiry (1 minute to 1 year).',
    too_many_invites: 'Too many invite links — revoke one first.', no_invite: 'Invite link not found.',
    no_main_invite: 'That invite no longer exists — ask for a new link.',
    slow_down: 'Slow down — you\'re sending too fast.', owner_only: 'Only the server owner can do that.', banned: 'You are banned from this server.', slow_mode: 'Slow mode is on — wait a moment.',
    not_logged_in: 'Sign in first to join.', bad_token: 'Session expired — sign in again.', user_gone: 'That account no longer exists.',
    captcha_required: 'Complete the captcha to continue.', captcha_failed: 'Captcha check failed — please try again.',
    bad_color: 'Pick a valid color.', cannot_kick_admin: 'Only the owner can remove admins.',
    admin_only: 'Only site admins can do that.', account_disabled: 'This account has been disabled.',
    account_locked: 'This account is locked pending a safety review. Contact a site admin.',
    illegal_content: 'That file was rejected: it matches known illegal material. The account has been locked pending review.',
    cannot_reset_own_2fa: 'Manage your own 2FA in Settings instead.', '2fa_not_enabled': 'That user does not have 2FA enabled.',
    nsfw_confirm_required: 'Confirm you are 18 or older to view this channel.',
    group_full: 'Group chats fit up to 9 friends.',
  };
  return map[e] || e.replace(/_/g, ' ');
}
async function doLogout() {
  try { await pushTeardown(); } catch {}
  try { await api('/api/sessions/current', { method: 'DELETE' }); } catch {}
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  try { leaveVoice(true); } catch {}
  try { S.ws?.close(); } catch {}
  store.token = '';
  store.sid = '';
  location.reload();
}

function stashInvite(code) { try { if (code) sessionStorage.setItem('cf_invite', code); } catch {} }
function takeInvite() { try { const p = sessionStorage.getItem('cf_invite'); if (p) sessionStorage.removeItem('cf_invite'); return p || null; } catch { return null; } }
// Invite codes arrive as /invite/CODE (pretty links) or legacy ?invite=CODE.
// Reads + cleans the URL (other query params are preserved).
function consumeInvite() {
  const u = new URL(location.href);
  let code = null;
  const pm = u.pathname.match(/^\/invite\/([\w-]+)\/?$/);
  if (pm) { code = pm[1]; u.pathname = '/'; }
  else if (u.searchParams.get('invite')) { code = u.searchParams.get('invite'); u.searchParams.delete('invite'); }
  if (code) { try { history.replaceState(null, '', u.pathname + u.search + u.hash); } catch {} }
  return code;
}
// ---------- boot ----------
async function boot() {
  try {
    const cfg = await api('/api/config').catch(() => null);
    if (cfg?.iceServers?.length) S.iceServers = cfg.iceServers;
    // Link previews are a server-side fetch (UNFURL=0 disables them fleet-wide).
    if (cfg && cfg.linkPreviews === false && typeof setLinkPreviews === 'function') setLinkPreviews(false);
    const { user } = await api('/api/me');
    S.me = user;
    S.bootRetrying = false;
    try { syncAccountTheme(); } catch {}
    // Report local timezone so game streaks bucket play on the player's
    // calendar days instead of UTC (a 7-8 PM ET session crosses UTC
    // midnight and used to mint a bogus 2-day streak). Fire-and-forget.
    try {
      const tz = -new Date().getTimezoneOffset();
      if (Number.isFinite(tz)) api('/api/me', { method: 'PATCH', body: JSON.stringify({ tzOffset: tz }) }).catch(() => {});
    } catch {}
  } catch (err) {
    // Saved session but unreachable server (offline, wifi dead, server down):
    // stay on the app shell under the full-screen reconnect overlay instead
    // of dropping to the login form — the user is still signed in, just
    // disconnected. Genuine auth failures (bad/expired token) still go to login.
    const emsg = String((err && err.message) || '');
    const authDead = /^(bad_token|user_gone|account_disabled|account_locked|not_logged_in)$/.test(emsg) || /^http_40[13]/.test(emsg);
    // A locked account is a deliberate, admin-visible state, not a broken
    // session: say so plainly instead of recycling the login screen silently.
    if (emsg === 'account_locked') {
      showAuth();
      try { toast(prettyError('account_locked'), 8000); } catch {}
      return;
    }
    if (store.token && !authDead && !S.bootRetrying) {
      S.bootRetrying = true;
      const invR = consumeInvite();
      if (invR) stashInvite(invR);
      try { const shR = consumeShare(); if (shR) stashShare(shR); } catch {}
      try { showMain(); } catch {}
      try { showConn(); } catch {}
      const retryBoot = () => {
        if (!S.bootRetrying) return;
        S.bootRetrying = false;
        window.removeEventListener('online', retryBoot);
        clearTimeout(retryBoot._t);
        boot();
      };
      window.addEventListener('online', retryBoot);
      retryBoot._t = setTimeout(retryBoot, 10000);
      return;
    }
    S.bootRetrying = false;
    const inv0 = consumeInvite();
    if (inv0) stashInvite(inv0);
    const sh0 = consumeShare();
    if (sh0) stashShare(sh0);
    showAuth();
    if (inv0) showInviteLanding(inv0);
    return;
  }
  showMain();
  let draft = null;
  try { draft = JSON.parse(sessionStorage.getItem('cf_draft') || 'null'); sessionStorage.removeItem('cf_draft'); } catch {}
  // Persistent per-user last-view (localStorage, survives browser restarts);
  // the sessionStorage draft only covers same-tab reloads and composer text.
  const mem = readMemView();
  if (mem && mem.s) S.serverId = mem.s;
  else if (draft && draft.s) S.serverId = draft.s;
  await warmStdEmoji().catch(() => {});
  await refreshAllEmojis().catch(() => {});
  // Only auto-open a server when restoring a server view; a remembered Home
  // view must stay on Home (no implicit jump to the first server).
  await refreshServers(mem && mem.view === 'server' ? mem.s : null, !(mem && mem.view === 'home'));
  // Reopen exactly where the user left off: a DM/group thread under Home,
  // or a server + channel. Missing ids fall back gracefully.
  if (mem && mem.view === 'home') {
    await openHome();
    if (mem.dm) {
      if (S.dms.some((t) => t.id === mem.dm)) await selectDmThread(mem.dm);
      else {
        // dismissed (hidden) thread from last time — try to reopen it
        try {
          const { thread } = await api(`/api/dms/${mem.dm}/open`, { method: 'POST' });
          await refreshDms();
          if (S.dms.some((t) => t.id === thread.id)) await selectDmThread(thread.id);
        } catch {}
      }
    }
  } else if (mem && mem.view === 'server' && mem.s && S.servers.some((x) => x.id === mem.s)) {
    if (S.serverId !== mem.s) await selectServer(mem.s);
    const wantC = mem.c || (draft && draft.s === mem.s ? draft.c : null);
    if (wantC && S.serverDetail?.channels.some((c) => c.id === wantC && c.type === 'text')) await selectChannel(wantC);
  }
  if (draft && draft.t && S.view === 'server') $('#in-message').value = draft.t;
  connectWS();
  pollVersion();
  pushSetup();
  refreshNotifBadge();
  // Prefetch DMs + friends so the home button badge (unread DMs, incoming
  // requests) is live even before Home is opened this session.
  refreshDms().catch(() => {});
  ensureFriends().catch(() => {});
  // Warm the per-user notification prefs so channel/server right-click menus
  // and muted indicators are correct from the start.
  refreshNotifPrefs().then(() => { renderServerList(); renderChannels(); }).catch(() => {});
  // invite landing (/invite/CODE or ?invite=CODE)
  const inv = consumeInvite();
  if (inv) {
    stashInvite(inv);
    showInviteLanding(inv);
  } else {
    const pending = takeInvite();
    if (pending) showInviteLanding(pending);
  }
  // deep links from push notifications (?server=ID&channel=ID, ?dm=ID)
  try {
    const qs = new URLSearchParams(location.search);
    const qdm = qs.get('dm'), qserv = qs.get('server'), qchan = qs.get('channel');
    if (qdm || qserv) history.replaceState(null, '', location.pathname);
    if (qdm) {
      await openHome();
      if (S.dms.some((t) => t.id === qdm)) selectDmThread(qdm);
      else {
        // dismissed (hidden) thread from a notification link — reopen it
        try {
          const { thread } = await api(`/api/dms/${qdm}/open`, { method: 'POST' });
          await refreshDms();
          selectDmThread(thread.id);
        } catch {}
      }
    } else if (qserv && S.servers.some((s) => s.id === qserv)) {
      await selectServer(qserv);
      if (S.serverDetail?.channels.some((c) => c.id === qchan && c.type === 'text')) await selectChannel(qchan);
    }
  } catch {}
  // shared from the Android system share sheet (/share?title=&text=&url=)
  try {
    const sh = consumeShare() || takeShare();
    if (sh && shareBlock(sh)) openShareDialog(sh);
  } catch {}
}
function showAuth() {
  $('#boot-splash')?.classList.add('hidden');
  $('#view-auth').classList.remove('hidden');
  $('#view-main').classList.add('hidden');
}
function showMain() {
  $('#boot-splash')?.classList.add('hidden');
  $('#view-auth').classList.add('hidden');
  $('#view-main').classList.remove('hidden');
  paintMe();
}

