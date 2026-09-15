// Closing your own account from Settings → Account, and closing somebody
// else's from the admin console — both now a 7-DAY GRACE PERIOD rather than an
// instant purge, with a site admin able to restore inside the window.
//
// Static half (always runs): the pane exists and is rendered with the account
// tab, both routes exist, the delete route checks the typed username server-side,
// the grace period is one constant with one shared request/restore/purge path,
// the restore route and the sweep are registered, and the local device memories
// are cleared on delete.
//
// API half (skips without Postgres): a throwaway database, a real TOTP secret
// computed the way an authenticator app would, and the real routes over HTTP —
// a wrong password and a wrong 2FA code each leave the account intact; disable
// signs the account out everywhere and blocks sign-in until a site admin
// re-enables it; delete needs the username typed as well (a backup code works
// in place of the authenticator); deleting CLOSES the account at once (sessions
// dead, sign-in refused with `pending_deletion`, memberships and messages
// untouched) and schedules the purge 7 days out; a site admin restores it and
// the same account signs back in with 2FA intact; enabling through PATCH
// cancels a pending deletion too; the owner's account is refused; and once the
// deadline is actually past, the leader-locked sweep purges the row for real —
// messages stay in their chats with no author, memberships cascade, and a
// restore afterwards is refused. Wrong passwords are braked.
//
// Usage: node scripts/test-account-close.js
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_account_close_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3422', 10);
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}
function readEnvFile() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}

// ---- RFC 6238 TOTP (SHA-1, 6 digits, 30s), the server's exact recipe ----
const B32ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32decode(s) {
  const clean = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  const bytes = [];
  let bits = 0, val = 0;
  for (const ch of clean) {
    val = (val << 5) | B32ABC.indexOf(ch); bits += 5;
    if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}
function totpNow(secret) {
  const counter = BigInt(Math.floor(Date.now() / 30000));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const h = crypto.createHmac('sha1', b32decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}

const security = fs.readFileSync(path.join(ROOT, 'public/js/security.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
const adminJs = fs.readFileSync(path.join(ROOT, 'public/js/admin.js'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const auth = fs.readFileSync(path.join(ROOT, 'public/js/auth.js'), 'utf8');

console.log('\n[1] the gate is in the account pane and enforced by the server');
check(/<div id="set-danger">/.test(index), 'the account pane has a place for it');
check(/render2faBox\(\); renderPasskeyBox\(\); renderSessionBox\(\); renderDangerBox\(\);/.test(security), 'the account tab renders it');
check(/app\.post\('\/api\/me\/disable', authRequired/.test(serverSrc) && /app\.post\('\/api\/me\/delete', authRequired/.test(serverSrc), 'both self-service routes exist');
check(/if \(isOwnerAccount\(me\)\) \{ res\.status\(403\)\.json\(\{ error: 'owner_protected' \}\); return null; \}/.test(serverSrc), 'the instance owner is refused');
check(/if \(!pw \|\| !\(await bcrypt\.compare\(pw, me\.password_hash\)\)\)/.test(serverSrc), 'the password is required and checked');
check(/if \(me\.totp_enabled && !\(await check2faCode\(me\.id, me\.totp_secret, req\.body\?\.code\)\)\)/.test(serverSrc), 'a 2FA code is required when 2FA is on (backup codes included, via check2faCode)');
check(/String\(req\.body\?\.confirm \|\| ''\)\.trim\(\)\.toLowerCase\(\) !== me\.username/.test(serverSrc), 'the typed username is checked server-side, not just in the dialog');
check(/const brake = await rateHit\('acct:' \+ me\.id, 10, 60e3\);/.test(serverSrc), 'wrong passwords are braked');
check(/'cf_drafts_', 'cf_view_', 'cf_home_tab_', 'cf_chanunread_', 'cf_pinseen_'/.test(security), 'delete forgets this account\'s device memories');
check(/owner_protected: /.test(auth) && /wrong_password: /.test(auth) && /bad_code: /.test(auth), 'the errors people will actually see are worded');
check(/pending_deletion: /.test(auth), 'and so is the one a closed account meets at sign-in');
check(/cancelLabel: 'Keep my account'/.test(security) && /danger: true/.test(security), 'the dialog is a danger dialog with an explicit "keep"');
check(/ok\.disabled = !\(pw && pw\.value\)/.test(security), 'the confirm button stays off until the gate is filled in');
check(/A site admin can restore it inside that window/.test(security), 'the delete warning promises the grace period in words');
check(/can restore it until then/.test(security), 'and says so again after the account is closed');

console.log('\n[1b] deleting is a request, not a purge');
check(/const DELETE_GRACE_DAYS = Math\.max\(0, parseInt\(process\.env\.ACCOUNT_DELETE_GRACE_DAYS \|\| '', 10\) \|\| 7\)/.test(serverSrc), 'one 7-day constant (env-tunable, defaulting to a week)');
check(/async function requestAccountDeletion\(target, by\)/.test(serverSrc), 'one shared "close this account" path');
check(/async function restoreAccount\(target\)/.test(serverSrc), 'and one shared restore');
check(/const scheduledAt = await requestAccountDeletion\(me, 'self'\);/.test(serverSrc), 'the account owner\'s own route schedules it');
check(/const scheduledAt = await requestAccountDeletion\(target, req\.user\.username\);/.test(serverSrc), 'so does the admin route');
check(/app\.post\('\/api\/admin\/users\/:id\/restore', authRequired, requireSiteAdmin/.test(serverSrc), 'a site admin can undo it');
check(/if \(!target\.deletion_scheduled_at\) return res\.status\(409\)\.json\(\{ error: 'not_pending' \}\);/.test(serverSrc), 'and restoring something that is not pending is refused');
check(!/await purgeAccount\(me\);/.test(serverSrc), 'nothing purges an account straight off a request');
check(/async function purgeAccount\(target\)/.test(serverSrc) && /DELETE FROM users WHERE id = \?/.test(serverSrc), 'the purge still deletes the row last');
check(/async function purgeDueAccounts\(\)/.test(serverSrc), 'a sweep is what actually purges');
check(/db\.withKeyLock\(accountLockKey\(row\.id\)/.test(serverSrc) && /db\.withKeyLock\(accountLockKey\(target\.id\), \(\) => restoreAccount\(target\)\)/.test(serverSrc), 'the purge and a restore take the same per-account lock');
check(/if \(isOwnerAccount\(target\)\) \{ await restoreAccount\(target\); return null; \}/.test(serverSrc), 'the owner account is never purged by the sweep');
check(/safeLockedInterval\('accounts', db\.LOCKS\.accountPurge, purgeDueAccounts,/.test(serverSrc) && /await db\.withLock\(db\.LOCKS\.accountPurge, purgeDueAccounts\)/.test(serverSrc), 'leader-locked, and run at boot as well as on the tick');
check(/accountPurge: 771019,/.test(dbSrc), 'the lock key is registered');
check(/addColumn\('users', 'deletion_scheduled_at', 'BIGINT'\)/.test(dbSrc) && /addColumn\('users', 'deletion_requested_by', 'TEXT'\)/.test(dbSrc) && /addColumn\('users', 'deletion_prev_disabled'/.test(dbSrc), 'the schema change is a guarded additive migration');
check(/disabled = deletion_prev_disabled/.test(serverSrc), 'a restore puts back the disabled flag that was there before');
check(/if \(!req\.body\.disabled && target\.deletion_scheduled_at\) \{/.test(serverSrc), 'enabling through PATCH cancels a pending deletion instead of leaving a purge armed');
check(/error: 'pending_deletion'/.test(serverSrc), 'sign-in is refused with the deletion named');
check(/refuseClosedAccount\(u, res\)/.test(serverSrc), 'every credential path shares that gate');
check(/deleteGraceDays: DELETE_GRACE_DAYS/.test(serverSrc), 'the number the client shows comes from the server');
check(/deletion_scheduled_at: u\.deletion_scheduled_at \? Number\(u\.deletion_scheduled_at\) : null,/.test(serverSrc), 'the admin view carries the deadline to the console');
check(/if \(filter === 'pending'\) conds\.push\('deletion_scheduled_at IS NOT NULL'\)/.test(serverSrc), 'the user list can filter for them');
check(/pendingDeletes: await count\(/.test(serverSrc), 'and the overview counts them');
check(/data-act="u-restore"/.test(adminJs) && /\/api\/admin\/users\/\$\{urow\.dataset\.uid\}\/restore/.test(adminJs), 'the console row offers Restore');
check(/deleted for good in \$\{days\} days/.test(adminJs), 'and the delete dialog says when it actually happens');

async function req(method, p, { token, body } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, data: d };
}

// ---------- the dialog itself, in a real browser ----------
// The API half proves the gate; this proves the thing a person actually meets:
// the danger zone, the warning list, the fields, a confirm button that stays
// off until the gate is filled, a rejected attempt that comes back with the
// reason and the answers still in it, and the hand-off to the sign-in screen.
function browserHalf() {
  const chrome = findChrome();
  if (!chrome) { console.log('\n[2] the dialog — SKIPPED (no Chrome/Edge found; set CHROME_PATH)'); return; }
  const uiJs = fs.readFileSync(path.join(ROOT, 'public/js/ui.js'), 'utf8');
  const coreJs = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
  const modalSrc = slice(uiJs, 'let modalOkFn = null;', '// Promise-based confirm dialog.');
  const showAuthSrc = slice(auth, 'function showAuth() {', 'function showMain()');
  const dangerSrc = slice(security, 'function deleteGraceDays() {', 'async function render2faBox() {');
  const escSrc = slice(coreJs, 'function esc(', 'function popupBox(');

  const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<style>${css}</style>
<style>body{margin:0;padding:20px;background:var(--bg)}</style></head><body>
<div id="boot-splash"></div>
<section id="view-auth" class="view hidden"><p id="auth-error" class="error hidden"></p></section>
<section id="view-main" class="view"></section>
<div id="set-danger"></div>
<div id="modal-backdrop" class="hidden">
  <div class="modal">
    <h3 id="modal-title">t</h3>
    <div id="modal-body"></div>
    <div class="row end"><button id="modal-close" class="btn">Cancel</button><button id="modal-ok" class="btn primary">OK</button></div>
  </div>
</div>
<script>
window.S = { me: { id: 'me', username: 'dana', display_name: 'Dana' } };
window.$ = (s) => document.querySelector(s);
window.store = { token: 'tok', sid: 'sid' };
window.toast = () => {};
// The real map lives in auth.js; the two entries the dialog can hit are enough
// here, and they are the wordings the assertion below expects.
window.prettyError = (e) => ({ wrong_password: 'That password is not right.', bad_code: 'That code is not right.', confirm_mismatch: 'Type your username exactly to confirm.' }[String((e && e.message) || e)] || String((e && e.message) || e));
window.leaveVoice = () => { __calls.push(['leaveVoice']); };
window.closeFind = () => { __calls.push(['closeFind']); };
window.closeSettings = () => { __calls.push(['closeSettings']); };
window.__calls = [];
window.__has2fa = true;
window.__fail = null;
window.api = async (p) => {
  __calls.push([p]);
  if (p === '/api/2fa/status') return { enabled: __has2fa };
  if (__fail) throw new Error(__fail);
  return { ok: true };
};
${escSrc}
${modalSrc}
${showAuthSrc}
${dangerSrc}
(async () => {
  const out = {};
  const type = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  await renderDangerBox();
  const dz = document.querySelector('#set-danger .danger-zone');
  out.danger = !!dz;
  out.heading = dz && dz.querySelector('h4') ? dz.querySelector('h4').textContent : '';
  out.buttons = [...document.querySelectorAll('#set-danger button')].map((b) => b.textContent);
  out.warnings = [...document.querySelectorAll('#set-danger p')].map((p) => p.textContent).length;
  document.querySelectorAll('#set-danger button')[1].click();
  out.title = document.querySelector('#modal-title').textContent;
  out.okLabel = document.querySelector('#modal-ok').textContent;
  out.cancelLabel = document.querySelector('#modal-close').textContent;
  out.okDanger = document.querySelector('#modal-ok').classList.contains('danger');
  out.bullets = document.querySelectorAll('#modal-body .danger-list li').length;
  out.bulletsText = [...document.querySelectorAll('#modal-body .danger-list li')].map((li) => li.textContent).join(' ');
  out.fields = { pw: !!document.querySelector('#acct-pw'), code: !!document.querySelector('#acct-code'), confirm: !!document.querySelector('#acct-confirm') };
  out.pwType = (document.querySelector('#acct-pw') || {}).type;
  const ok = document.querySelector('#modal-ok');
  out.blockedEmpty = ok.disabled;
  type('#acct-pw', 'pw'); type('#acct-code', '123456');
  out.blockedNoName = ok.disabled;
  type('#acct-confirm', 'nope');
  out.blockedWrongName = ok.disabled;
  type('#acct-confirm', 'DANA');
  out.readyWhenFilled = !ok.disabled;
  __fail = 'wrong_password';
  ok.click();
  await new Promise((r) => setTimeout(r, 50));
  out.retry = {
    err: (document.querySelector('#modal-body .error') || {}).textContent || '',
    pw: (document.querySelector('#acct-pw') || {}).value || '',
    code: (document.querySelector('#acct-code') || {}).value || '',
    confirm: (document.querySelector('#acct-confirm') || {}).value || '',
    open: !document.querySelector('#modal-backdrop').classList.contains('hidden'),
  };
  __fail = null;
  document.querySelector('#modal-ok').click();
  await new Promise((r) => setTimeout(r, 50));
  out.authed = {
    authVisible: !document.querySelector('#view-auth').classList.contains('hidden'),
    mainHidden: document.querySelector('#view-main').classList.contains('hidden'),
    notice: document.querySelector('#auth-error').textContent,
    token: store.token,
    calls: __calls.map((c) => c[0]),
  };
  // The disable dialog is the lighter one: no typed-name field.
  document.querySelectorAll('#set-danger button')[0].click();
  out.disableFields = { pw: !!document.querySelector('#acct-pw'), code: !!document.querySelector('#acct-code'), confirm: !!document.querySelector('#acct-confirm') };
  out.disableTitle = document.querySelector('#modal-title').textContent;
  // Without 2FA the code field goes away.
  __has2fa = false;
  await renderDangerBox();
  document.querySelectorAll('#set-danger button')[1].click();
  out.no2faFields = { pw: !!document.querySelector('#acct-pw'), code: !!document.querySelector('#acct-code') };
  document.title = JSON.stringify(out);
})();
</script></body></html>`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-acct-dlg-'));
  try {
    const p = path.join(dir, 'page.html');
    fs.writeFileSync(p, html);
    const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=900,900',
      '--virtual-time-budget=3000', '--dump-dom', 'file:///' + p.replace(/\\/g, '/')],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
    if (!m) { check(false, 'the dialog harness ran', (r.stderr || '').slice(-300)); return; }
    const out = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    console.log('\n[2] the dialog a person actually meets');
    check(out.danger && out.heading === 'Close account', 'the account pane shows a danger zone', out);
    check(out.buttons.join(',') === 'Disable account,Delete account', 'with both actions', out.buttons);
    check(out.warnings >= 2, 'and says what each one does', out.warnings);
    check(out.title === 'Delete your account?' && out.okLabel === 'Delete account' && out.cancelLabel === 'Keep my account', 'delete opens a danger dialog with a way out', { title: out.title, ok: out.okLabel, cancel: out.cancelLabel });
    check(out.okDanger === true, 'whose confirm button is the danger one');
    check(out.bullets === 3, 'listing exactly what happens', out.bullets);
    check(/7 days/.test(out.bulletsText) && /site admin can restore/i.test(out.bulletsText) && /cannot be undone/i.test(out.bulletsText), 'with the grace period, the restore and the real deadline spelled out', out.bulletsText);
    check(out.fields.pw && out.fields.code && out.fields.confirm && out.pwType === 'password', 'and asking for the password, a 2FA code and the username', out.fields);
    check(out.blockedEmpty && out.blockedNoName && out.blockedWrongName, 'the confirm button is off until the gate is filled', out);
    check(out.readyWhenFilled === true, 'and turns on when it is (the username case-insensitively)', out.readyWhenFilled);
    check(out.retry.open && /password is not right/i.test(out.retry.err), 'a refused attempt comes back with the reason in words', out.retry);
    check(out.retry.pw === 'pw' && out.retry.code === '123456' && out.retry.confirm === 'DANA', 'and with what was typed still in it', out.retry);
    check(out.authed.authVisible && out.authed.mainHidden, 'success lands on the sign-in screen', out.authed);
    check(/deleted/i.test(out.authed.notice) && out.authed.token === '', 'with the reason said plainly and no token left behind', out.authed);
    check(out.authed.calls.includes('leaveVoice') && out.authed.calls.includes('closeSettings') && out.authed.calls.includes('closeFind'), 'after tearing the session down', out.authed.calls);
    check(!out.disableFields.confirm && out.disableFields.pw && out.disableFields.code && out.disableTitle === 'Disable your account?', 'disable asks for the password + code but not the typed name', out.disableFields);
    check(out.no2faFields.pw && !out.no2faFields.code, 'and drops the code field when 2FA is off', out.no2faFields);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
const openWs = (token) => new Promise((res, rej) => {
  const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
  w.once('open', () => res(w));
  w.once('error', rej);
});

async function main() {
  browserHalf();
  const envFile = readEnvFile();
  const pg = {
    host: process.env.PGHOST || envFile.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || envFile.POSTGRES_USER || 'campfire',
    password: process.env.PGPASSWORD || envFile.POSTGRES_PASSWORD || '',
  };
  const admin = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
  try { await admin.connect(); }
  catch (e) { console.log('\n[3] the routes — SKIPPED (Postgres unreachable: ' + ((e && e.message) || e) + ')'); return finish(); }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-account-close-'));
  let child = null;
  const sockets = [];
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        PGHOST: pg.host, PGPORT: String(pg.port), PGUSER: pg.user, PGPASSWORD: pg.password, PGDATABASE: TEST_DB,
        JWT_SECRET: 'test-account-close-secret', UPLOAD_DIR: path.join(tmp, 'uploads'), VIRUS_SCAN: '0', MEDIA_COMPRESS: '0', UNFURL: '0',
        // The grace period is seven days, but the SWEEP that acts on it has to
        // be watchable: backdate a deadline and the purge lands within a second.
        ACCOUNT_PURGE_EVERY_MS: '1000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try { up = (await fetch(BASE + '/api/config')).ok; } catch {}
      if (!up) await sleep(250);
    }
    if (!up) throw new Error('server did not come up\n' + log.slice(-2000));

    const PW = 'passw0rd!x';
    const reg = async (username, displayName) => (await req('POST', '/api/register', { body: { username, displayName, password: PW } })).data;
    const dana = await reg('dana', 'Dana');
    const boss = await reg('jreoka', 'Boss');   // the instance owner (site admin)
    const brakeUser = await reg('brakey', 'Brakey');
    check(!!dana.token && !!boss.token, 'registered the accounts');

    // A server the owner runs, which dana joins and posts in.
    const made = (await req('POST', '/api/servers', { token: boss.token, body: { name: 'Account Lab' } })).data;
    const sid = made.server.id;
    const cid = made.server.channels.find((c) => c.type === 'text').id;
    await req('POST', '/api/servers/join', { token: dana.token, body: { inviteCode: made.invite.code } });
    const dws = await openWs(dana.token); sockets.push(dws);
    await sleep(250);
    dws.send(JSON.stringify({ t: 'message', serverId: sid, channelId: cid, content: 'dana was here' }));
    await sleep(450);
    const dm = (await req('POST', '/api/dms', { token: dana.token, body: { userId: boss.user.id } })).data.thread;
    dws.send(JSON.stringify({ t: 'dm', threadId: dm.id, content: 'dana dm' }));
    await sleep(450);

    // 2FA on, the way an authenticator app would do it.
    const setup = (await req('POST', '/api/2fa/setup', { token: dana.token })).data;
    const enabled = (await req('POST', '/api/2fa/enable', { token: dana.token, body: { code: totpNow(setup.secret) } })).data;
    check(!!setup.secret && Array.isArray(enabled.backupCodes) && enabled.backupCodes.length === 10, 'dana has 2FA on with backup codes', enabled.backupCodes?.length);
    const backup = enabled.backupCodes[0];
    // Signing in with 2FA on takes the second step, like the app does.
    const login = async (username, password) => {
      let r = await req('POST', '/api/login', { body: { username, password } });
      if (r.status === 200 && r.data.need2fa) r = await req('POST', '/api/login/2fa', { body: { tmp: r.data.tmp, code: totpNow(setup.secret) } });
      return r;
    };

    console.log('\n[3] the password and the 2FA code are both required');
    let r = await req('POST', '/api/me/disable', { token: dana.token, body: { password: 'nope', code: totpNow(setup.secret) } });
    check(r.status === 401 && r.data.error === 'wrong_password', 'a wrong password is refused', r.data);
    r = await req('POST', '/api/me/disable', { token: dana.token, body: {} });
    check(r.status === 401, 'a missing password is refused', r.data);
    r = await req('POST', '/api/me/disable', { token: dana.token, body: { password: PW, code: '000000' } });
    check(r.status === 400 && r.data.error === 'bad_code', 'a wrong 2FA code is refused', r.data);
    r = await req('GET', '/api/2fa/status', { token: dana.token });
    check(r.status === 200 && r.data.enabled === true, 'the account is untouched by all of that', r.data);

    console.log('\n[4] disable signs the account out everywhere');
    r = await req('POST', '/api/me/disable', { token: dana.token, body: { password: PW, code: totpNow(setup.secret) } });
    check(r.status === 200 && r.data.ok === true, 'disable succeeds with the password + code', r.data);
    r = await req('GET', '/api/2fa/status', { token: dana.token });
    check(r.status === 403 && r.data.error === 'account_disabled', 'the old token is shut out', r.data);
    r = await req('POST', '/api/login', { body: { username: 'dana', password: PW } });
    check(r.status === 403 && r.data.error === 'account_disabled', 'and signing in is blocked', r.data);

    console.log('\n[5] a site admin can re-enable it (what the warning promises)');
    r = await req('PATCH', `/api/admin/users/${dana.user.id}`, { token: boss.token, body: { disabled: false } });
    check(r.status === 200, 'the admin re-enabled the account', r.data);
    const back = await login('dana', PW);
    check(back.status === 200 && !!back.data.token, 'and dana can sign in again (2FA included)', back.data.error);
    const dana2 = { token: back.data.token, user: dana.user };
    check((await req('GET', '/api/2fa/status', { token: dana2.token })).data.enabled === true, '2FA survived the round trip');
    // "Signed out everywhere" is the sessions, not just the flag: the token from
    // before the disable must stay dead now that the account works again.
    r = await req('GET', '/api/2fa/status', { token: dana.token });
    check(r.status === 401, 'the pre-disable session stayed revoked', r.data);

    console.log('\n[6] delete needs the username typed as well');
    r = await req('POST', '/api/me/delete', { token: dana2.token, body: { password: PW, code: totpNow(setup.secret), confirm: 'not-my-name' } });
    check(r.status === 400 && r.data.error === 'confirm_mismatch', 'a wrong confirmation is refused', r.data);
    r = await req('POST', '/api/me/delete', { token: dana2.token, body: { password: PW, code: totpNow(setup.secret) } });
    check(r.status === 400, 'so is a missing one', r.data);
    check((await req('GET', '/api/2fa/status', { token: dana2.token })).status === 200, 'the account is still there');

    console.log('\n[7] delete closes the account now and schedules the purge in 7 days');
    const asked = Date.now();
    r = await req('POST', '/api/me/delete', { token: dana2.token, body: { password: PW, code: backup, confirm: 'dana' } });
    check(r.status === 200 && r.data.ok === true && r.data.pending === true, 'delete succeeds (a backup code stands in for the authenticator)', r.data);
    check(r.data.graceDays === 7, 'and answers with the grace period it will wait', r.data.graceDays);
    const deadline = Number(r.data.scheduledAt);
    check(Math.abs(deadline - (asked + 7 * 864e5)) < 60e3, 'the deadline is seven days out, not "now"', { scheduledAt: r.data.scheduledAt, asked });
    r = await req('GET', '/api/2fa/status', { token: dana2.token });
    check(r.status === 403 && r.data.error === 'pending_deletion', 'its sessions are shut out at once, and told why', r.data);
    r = await req('POST', '/api/login', { body: { username: 'dana', password: PW } });
    check(r.status === 403 && r.data.error === 'pending_deletion', 'signing in is refused with the deletion named', r.data);
    check(Number(r.data.scheduledAt) === deadline, 'and the refusal carries the same deadline', r.data.scheduledAt);
    r = await req('GET', `/api/servers/${sid}`, { token: boss.token });
    check((r.data.server?.members || []).some((m) => m.id === dana.user.id), 'its server membership is NOT cascaded yet', (r.data.server?.members || []).map((m) => m.username));
    r = await req('GET', '/api/search?q=' + encodeURIComponent('dana was here'), { token: boss.token });
    check(r.data.results.length === 1 && r.data.results[0].message.user && r.data.results[0].message.user.id === dana.user.id, 'and its messages still have their author', r.data.results[0] && r.data.results[0].message.user);
    r = await req('POST', '/api/login', { body: { username: 'dana', password: 'nope' } });
    check(r.status === 403 && r.data.error === 'pending_deletion', 'a wrong password does not change the answer either (the gate is before the compare, as for disabled)', r.data);

    console.log('\n[8] a site admin can restore it inside the window');
    r = await req('GET', '/api/admin/users?filter=pending', { token: boss.token });
    const pending = (r.data.users || []).find((u) => u.id === dana.user.id);
    check(!!pending, 'the console lists it under Pending deletion', (r.data.users || []).map((u) => u.username));
    check(pending && pending.deletion_requested_by === 'self' && Number(pending.deletion_scheduled_at) === deadline, 'with who asked and the deadline', pending && { by: pending.deletion_requested_by });
    check((await req('GET', '/api/admin/stats', { token: boss.token })).data.pendingDeletes === 1, 'and the overview counts one');
    r = await req('POST', `/api/admin/users/${dana.user.id}/restore`, { token: boss.token });
    check(r.status === 200 && r.data.user && r.data.user.deletion_scheduled_at === null, 'the admin restores the account', r.data);
    check(r.data.user.disabled === false, 'and it is not left disabled', r.data.user);
    const back2 = await login('dana', PW);
    check(back2.status === 200 && !!back2.data.token, 'dana signs in again with the same password', back2.data.error);
    const dana3 = { token: back2.data.token, user: dana.user };
    check((await req('GET', '/api/2fa/status', { token: dana3.token })).data.enabled === true, '2FA survived the round trip');
    r = await req('GET', `/api/servers/${sid}`, { token: boss.token });
    check((r.data.server?.members || []).some((m) => m.id === dana.user.id), 'and she is still in her servers');
    // Restoring something that is not pending is a no-op with a reason, not a
    // silent success that looks like it did something.
    r = await req('POST', `/api/admin/users/${dana.user.id}/restore`, { token: boss.token });
    check(r.status === 409 && r.data.error === 'not_pending', 'restoring an account that is not pending is refused', r.data);
    // The console's other way of undoing it: the plain Enable button.
    await req('DELETE', `/api/admin/users/${dana.user.id}`, { token: boss.token });
    r = await req('PATCH', `/api/admin/users/${dana.user.id}`, { token: boss.token, body: { disabled: false } });
    check(r.status === 200 && r.data.user.deletion_scheduled_at === null && r.data.user.disabled === false, 'enabling through PATCH cancels the deletion too', r.data.user);
    check((await req('GET', '/api/admin/stats', { token: boss.token })).data.pendingDeletes === 0, 'nothing is left pending');

    console.log('\n[9] an admin delete follows the same 7 days — and then the sweep really purges');
    const erin = await reg('erin', 'Erin');
    await req('POST', '/api/servers/join', { token: erin.token, body: { inviteCode: made.invite.code } });
    const ews = await openWs(erin.token); sockets.push(ews);
    await sleep(200);
    ews.send(JSON.stringify({ t: 'message', serverId: sid, channelId: cid, content: 'erin was here' }));
    await sleep(450);
    r = await req('DELETE', `/api/admin/users/${erin.user.id}`, { token: boss.token });
    check(r.status === 200 && r.data.pending === true && r.data.user.deletion_scheduled_at, 'the admin route schedules it too', r.data.error || r.status);
    check(r.data.user.deletion_requested_by === 'jreoka', 'recording which admin asked', r.data.user && r.data.user.deletion_requested_by);
    check((await req('POST', '/api/login', { body: { username: 'erin', password: PW } })).data.error === 'pending_deletion', 'and erin cannot sign in meanwhile');
    // Backdate the deadline rather than wait a week: the sweep is what this is
    // about, so it has to be the sweep that collects it.
    const dancer = new Client({ ...pg, database: TEST_DB, connectionTimeoutMillis: 4000 });
    await dancer.connect();
    await dancer.query('UPDATE users SET deletion_scheduled_at = $1 WHERE id = $2', [Date.now() - 1000, erin.user.id]);
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      await sleep(250);
      gone = (await req('POST', '/api/login', { body: { username: 'erin', password: PW } })).data.error === 'invalid_login';
    }
    check(gone, 'once the deadline passes the sweep purges the row for real');
    const left = (await dancer.query('SELECT username FROM users WHERE id = $1', [erin.user.id])).rowCount;
    check(left === 0, 'the row is gone from the database', left);
    const danaRow = (await dancer.query('SELECT deletion_scheduled_at, disabled, deletion_prev_disabled FROM users WHERE id = $1', [dana.user.id])).rows[0];
    check(danaRow && danaRow.deletion_scheduled_at === null && Number(danaRow.disabled) === 0, 'and the restored account was never touched by it', danaRow);
    r = await req('GET', `/api/servers/${sid}`, { token: boss.token });
    check(!(r.data.server?.members || []).some((m) => m.id === erin.user.id), 'the purged account left its servers', (r.data.server?.members || []).map((m) => m.username));
    r = await req('GET', '/api/search?q=' + encodeURIComponent('erin was here'), { token: boss.token });
    check(r.data.results.length === 1 && r.data.results[0].message.content === 'erin was here', 'its message stays in the chat', r.data.results.length);
    check(r.data.results[0] && r.data.results[0].message.user === null, 'with no author (the panel names it "Deleted user")', r.data.results[0] && r.data.results[0].message.user);
    r = await req('POST', `/api/admin/users/${erin.user.id}/restore`, { token: boss.token });
    check(r.status === 404 && r.data.error === 'no_user', 'and by then a restore is refused — the window is what made it reversible', r.data);
    await dancer.end();

    console.log('\n[10] the instance owner\'s own account is refused');
    r = await req('POST', '/api/me/disable', { token: boss.token, body: { password: PW } });
    check(r.status === 403 && r.data.error === 'owner_protected', 'disable is refused', r.data);
    r = await req('POST', '/api/me/delete', { token: boss.token, body: { password: PW, confirm: 'jreoka' } });
    check(r.status === 403 && r.data.error === 'owner_protected', 'and so is delete', r.data);
    r = await req('DELETE', `/api/admin/users/${boss.user.id}`, { token: boss.token });
    check(r.status === 400 && r.data.error === 'cannot_delete_self', 'an admin cannot delete their own account from the console', r.data);
    check((await req('GET', '/api/2fa/status', { token: boss.token })).status === 200, 'the owner account works normally otherwise');

    console.log('\n[11] password guesses are braked');
    let last = null;
    for (let i = 0; i < 11; i++) last = await req('POST', '/api/me/disable', { token: brakeUser.token, body: { password: 'wrong-' + i } });
    check(last.status === 429 && last.data.error === 'slow_down', 'the eleventh wrong password is throttled', last.data);
    r = await req('POST', '/api/me/disable', { token: brakeUser.token, body: { password: PW } });
    check(r.status === 429, 'and even the right one waits out the brake', r.status);
  } finally {
    for (const w of sockets) { try { w.close(); } catch {} }
    try { child && child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  finish();
}

function finish() {
  console.log('\n' + (failures.length ? 'FAILED: ' + failures.length : 'OK') + ' — ' + passed + ' checks passed');
  if (failures.length) process.exit(1);
  process.exit(0);
}

main().catch((e) => { console.error('[test] crashed:', (e && e.message) || e); process.exit(1); });
