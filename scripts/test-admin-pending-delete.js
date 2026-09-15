// Admin → Users rows for an account inside its deletion grace period.
//
// The grace period's whole promise is the CONSOLE: an admin has to be able to
// see that an account is closed but not gone, how long is left, who asked, and
// that the destructive button is no longer the right one. That is what this
// measures — the row the panel paints, with the real admUserRow out of
// admin.js, in a real browser.
//
// Static half (always runs): the console offers the filter, the overview counts
// them, and the row is wired to the restore route.
// Browser half (skips without Chrome/Edge): the pending row carries the
// countdown badge, the requester line, data-pending and a Restore button
// INSTEAD of Delete; a normal row keeps Delete; the protected owner row never
// shows the pending state; and the countdown switches units as the deadline
// approaches rather than printing a negative number.
//
// Usage: node scripts/test-admin-pending-delete.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
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

const adminJs = fs.readFileSync(path.join(ROOT, 'public/js/admin.js'), 'utf8');
const coreJs = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const serversJs = fs.readFileSync(path.join(ROOT, 'public/js/servers.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

console.log('\n[1] the console is wired for a pending account');
check(/<option value="pending">Pending deletion<\/option>/.test(adminJs), 'the user list has a Pending deletion filter');
check(/if \(filter === 'pending'\) conds\.push\('deletion_scheduled_at IS NOT NULL'\)/.test(serverSrc), 'and the server answers it');
check(/card\(s\.pendingDeletes \|\| 0, 'Pending deletion'\)/.test(adminJs), 'the overview counts them');
check(/data-act="u-restore"/.test(adminJs) && /"u-restore"/.test(adminJs), 'the row has a Restore action');
check(/api\(`\/api\/admin\/users\/\$\{urow\.dataset\.uid\}\/restore`, \{ method: 'POST' \}\)/.test(adminJs), 'which POSTs the restore route');
check(/The scheduled deletion is cancelled and the account works again/.test(adminJs), 'and says what restoring does');
check(/deleted for good in \$\{days\} days/.test(adminJs), 'the delete dialog warns that the purge is delayed');

// ---------- the row itself, in a real browser ----------
function browserHalf() {
  const chrome = findChrome();
  if (!chrome) { skip('no Chrome/Edge found (set CHROME_PATH)'); }
  const escSrc = slice(coreJs, 'function esc(', 'function popupBox(');
  const styleSrc = slice(serversJs, 'const HEXC = /^#[0-9a-fA-F]{6}$/;', '// Card background:');
  const fmtSrc = slice(adminJs, 'function fmtDate(ts) {', 'function isSiteAdmin()');
  const rowSrc = slice(adminJs, 'function admUserRow(u) {', 'async function loadAdminUsers() {');

  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
window.S = { me: { id: 'me', username: 'boss' }, view: 'dm', deleteGraceDays: 7 };
${escSrc}
${styleSrc}
${fmtSrc}
${rowSrc}
(async () => {
  const out = {};
  const DAY = 86400000;
  const now = Date.now();
  const base = { avatar_color: '#5865f2', name_color: '', name_gradient: '', serverCount: 1, messageCount: 4, dmCount: 2, created_at: now - 30 * DAY, has2fa: false };
  const pendingSelf = { ...base, id: 'u1', username: 'dana', display_name: 'Dana', disabled: true,
    deletion_scheduled_at: now + 7 * DAY, deletion_requested_at: now, deletion_requested_by: 'self' };
  const pendingAdmin = { ...base, id: 'u2', username: 'erin', display_name: 'Erin', disabled: true,
    deletion_scheduled_at: now + 2 * DAY, deletion_requested_at: now, deletion_requested_by: 'jreoka' };
  const plain = { ...base, id: 'u3', username: 'finn', display_name: 'Finn', disabled: false };
  const owner = { ...base, id: 'u4', username: 'jreoka', display_name: 'Boss', disabled: true, ownerAccount: true,
    deletion_scheduled_at: now + 3 * DAY, deletion_requested_by: 'self' };
  document.body.innerHTML = '<div id="box">' + [pendingSelf, pendingAdmin, plain, owner].map(admUserRow).join('') + '</div>';

  const row = (uid) => document.querySelector('[data-uid="' + uid + '"]');
  const info = (uid) => {
    const r = row(uid);
    const del = r.querySelector('.adm-badge.del');
    return {
      pending: r.getAttribute('data-pending') === '1',
      badge: del ? del.textContent.trim() : null,
      title: del ? del.getAttribute('title') : null,
      acts: [...r.querySelectorAll('[data-act]')].map((b) => b.dataset.act),
      line: (r.querySelectorAll('.adm-main > .muted.small')[1] || {}).textContent || '',
      disabledBtns: [...r.querySelectorAll('button')].filter((b) => b.disabled).length,
      buttons: [...r.querySelectorAll('button')].map((b) => b.textContent),
    };
  };
  out.self = info('u1');
  out.admin = info('u2');
  out.plain = info('u3');
  out.owner = info('u4');
  out.units = {
    week: fmtCountdown(now + 7 * DAY),
    days: fmtCountdown(now + 2 * DAY),
    hours: fmtCountdown(now + 5 * 3600e3),
    minutes: fmtCountdown(now + 20 * 60e3),
    lapsed: fmtCountdown(now - 5000),
  };
  document.title = JSON.stringify(out);
})();
</script></body></html>`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-adm-pending-'));
  try {
    const p = path.join(dir, 'page.html');
    fs.writeFileSync(p, html);
    const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=1000,900',
      '--virtual-time-budget=3000', '--dump-dom', 'file:///' + p.replace(/\\/g, '/')],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
    if (!m) { check(false, 'the row harness ran', (r.stderr || '').slice(-300)); return; }
    const out = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    console.log('\n[2] the rows a site admin actually sees');
    check(out.self.pending && out.self.badge === 'DELETES IN 7D', 'a pending row is marked and counts the days', out.self);
    check(/^Restorable until /.test(out.self.title || ''), 'with the deadline on hover', out.self.title);
    check(out.self.acts.includes('u-restore') && !out.self.acts.includes('u-del'), 'and offers Restore instead of Delete', out.self.acts);
    check(/requested by the account holder/.test(out.self.line), 'saying the account holder asked for it', out.self.line);
    check(out.admin.badge === 'DELETES IN 2D' && /requested by @jreoka/.test(out.admin.line), 'an admin-requested one names the admin', out.admin);
    check(!out.plain.pending && !out.plain.badge && out.plain.acts.includes('u-del') && !out.plain.acts.includes('u-restore'), 'an ordinary row keeps Delete and carries no countdown', out.plain);
    check(!out.owner.pending && !out.owner.badge && out.owner.buttons.length > 0 && out.owner.disabledBtns === out.owner.buttons.length, 'the protected owner row stays locked (every button disabled, no pending state)', out.owner);
    check(out.units.week === 'in 7d' && out.units.days === 'in 2d', 'the countdown reads in days while there is time', out.units);
    check(out.units.hours === 'in 5h' && out.units.minutes === 'in 20m', 'switches to hours and minutes as it runs out', out.units);
    check(out.units.lapsed === 'any moment now', 'and never prints a negative number once the deadline passes', out.units);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

browserHalf();
console.log('\n' + (failures.length ? 'FAILED: ' + failures.length : 'OK') + ' — ' + passed + ' checks passed');
if (failures.length) process.exit(1);
process.exit(0);
