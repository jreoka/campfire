'use strict';
// ---------- auth ----------
let mode = 'login';
// Cloudflare Turnstile: site key comes from /api/config (public). The widget
// stays hidden until the user presses Log in / Create account — the form
// stays clean until the captcha is actually needed. Tokens are single-use,
// so the widget resets after every submit attempt.
S.turnstileKey = null; S.tsWidget = undefined;
let tsNeeded = false; // submit was pressed: the captcha area may now appear
function renderTurnstile() {
  if (!S.turnstileKey || !window.turnstile || S.tsWidget !== undefined) return;
  const slot = document.querySelector('#ts-widget');
  if (!slot) return;
  try {
    slot.innerHTML = '';
    S.tsWidget = turnstile.render(slot, { sitekey: S.turnstileKey, theme: 'dark' });
  } catch { S.tsWidget = undefined; }
}
// Shows + renders the captcha area if it's ready; true when it's visible
// (or when captcha is unconfigured), false while the API script loads.
function showTurnstile() {
  if (!S.turnstileKey) return true;
  if (!window.turnstile) return false;
  if (S.tsWidget === undefined) renderTurnstile();
  if (S.tsWidget === undefined) return false;
  $('#ts-wrap').classList.remove('hidden');
  return true;
}
// Named in index.html (?onload=cfTurnstileReady): fires when the API script
// finishes loading. Assigned here so it exists before the async script runs.
// Only surfaces the widget if the user has already pressed submit.
window.cfTurnstileReady = () => {
  if (!tsNeeded || !S.turnstileKey || S.tsWidget !== undefined) return;
  renderTurnstile();
  if (S.tsWidget !== undefined) $('#ts-wrap').classList.remove('hidden');
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
$('#form-auth').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#in-username').value.trim();
  const password = $('#in-password').value;
  const displayName = $('#in-display').value.trim();
  $('#auth-error').classList.add('hidden');
  if (mode === 'register' && password !== $('#in-confirm').value) {
    authError('Passwords do not match.');
    return;
  }
  if (S.turnstileKey) {
    tsNeeded = true;
    if (!showTurnstile()) { authError('Captcha still loading — wait a moment and try again.'); return; }
    if (!turnstileToken()) { authError('Complete the captcha to continue.'); return; }
  }
  try {
    const data = mode === 'login'
      ? await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password, turnstile: turnstileToken(), device: deviceName() }) })
      : await api('/api/register', { method: 'POST', body: JSON.stringify({ username, password, displayName, turnstile: turnstileToken(), device: deviceName() }) });
    if (data.need2fa) { pending2faTmp = data.tmp; show2faStep(); return; }
    store.token = data.token;
    if (data.sid) store.sid = data.sid;
    await boot();
  } catch (err) {
    const el = $('#auth-error');
    el.textContent = '⚠️ ' + prettyError(err.message);
    el.classList.remove('hidden');
  } finally {
    turnstileReset();
  }
});
function prettyError(e) {
  const map = {
    invalid_login: 'Wrong username or password.', username_taken: 'That username is taken.',
    bad_username: 'Username needs 2–24 chars (a-z, 0-9, _ .).', bad_invite: 'Invite code not found.',
    slow_down: 'Slow down — you\'re sending too fast.', owner_only: 'Only the server owner can do that.', banned: 'You are banned from this server.', slow_mode: 'Slow mode is on — wait a moment.',
    captcha_required: 'Complete the captcha to continue.', captcha_failed: 'Captcha check failed — please try again.',
    bad_color: 'Pick a valid color.', cannot_kick_admin: 'Only the owner can remove admins.',
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
    const { user } = await api('/api/me');
    S.me = user;
  } catch {
    const inv0 = consumeInvite();
    if (inv0) stashInvite(inv0);
    showAuth();
    if (inv0) showInviteLanding(inv0);
    return;
  }
  showMain();
  let draft = null;
  try { draft = JSON.parse(sessionStorage.getItem('cf_draft') || 'null'); sessionStorage.removeItem('cf_draft'); } catch {}
  if (draft && draft.s) S.serverId = draft.s;
  await warmStdEmoji().catch(() => {});
  await refreshServers();
  if (draft && draft.c && S.serverId === draft.s) { try { await selectChannel(draft.c); } catch {} }
  if (draft && draft.t) $('#in-message').value = draft.t;
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

