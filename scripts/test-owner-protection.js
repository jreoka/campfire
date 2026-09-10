// Owner-account protection (see AGENTS.md verification conventions).
//
// @jreoka (db.OWNER_USERNAME) is the instance owner and is auto-admin. The
// owner asked that their account be untouchable from the site-admin panel:
// greyed out and read-only for every other admin, while they keep full use of
// their own account. This boots a real server against a throwaway database and
// proves the enforcement is server-side, not just dimmed buttons:
//   - a second site admin gets 'owner_protected' from every account route
//     (edit, password, disable, demote, delete, forced logout, 2FA reset,
//     profile media, server kick) and from the account-level report actions
//     (disable / delete+disable / ban),
//   - the owner can still manage their own account and other users,
//   - ordinary users are unaffected by the lock,
//   - the admin payloads carry ownerAccount:true so the panel can grey the row.
//
// Requirements: Postgres reachable (docker compose up -d db).
// Skips (exit 0) with a message when it isn't.
//
// Usage: node scripts/test-owner-protection.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_owner_test';
const PORT = parseInt(process.env.TEST_PORT || '3415', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }

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

async function api(method, p, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers, body: payload });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

let nextStart = 0;
async function connectWs(token) {
  const wait = nextStart - Date.now();
  if (wait > 0) await sleep(wait);
  nextStart = Date.now() + 300;
  return new Promise((resolve, reject) => {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
    ws.on('error', reject);
    ws.on('message', (raw) => { try { events.push(JSON.parse(raw.toString())); } catch {} });
    ws.on('open', () => resolve({
      events,
      send: (obj) => ws.send(JSON.stringify(obj)),
      last: (t) => [...events].reverse().find((e) => e.t === t) || null,
      close: () => { try { ws.close(); } catch {} },
    }));
  });
}

async function waitFor(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(120);
  }
}
async function waitForAsync(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(120);
  }
}
async function waitForHttp(p, ms) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); if (r.ok) return true; } catch {}
    if (Date.now() - t0 > ms) return false;
    await sleep(250);
  }
}

async function main() {
  const envFile = readEnvFile();
  const pg = {
    host: process.env.PGHOST || envFile.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || envFile.POSTGRES_USER || 'campfire',
    password: process.env.PGPASSWORD || envFile.POSTGRES_PASSWORD || '',
  };
  const admin = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
  try { await admin.connect(); }
  catch (e) { return skip('Postgres unreachable (' + ((e && e.message) || e) + ') — docker compose up -d db'); }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-owner-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });

  let child = null;
  const conns = [];
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
        JWT_SECRET: 'test-owner-secret',
        UPLOAD_DIR: uploads,
        UNFURL: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    const fail = (msg) => { throw new Error(msg + '\n--- server log ---\n' + serverLog.slice(-4000)); };
    if (!(await waitForHttp('/api/config', 30000))) return fail('server did not come up');

    console.log('\n[1] accounts — a second site admin');
    const owner = await api('POST', '/api/register', { body: { username: 'jreoka', displayName: 'Owner', password: 'passw0rd!x' } });
    const alice = await api('POST', '/api/register', { body: { username: 'alice', displayName: 'Alice', password: 'passw0rd!x' } });
    const bob = await api('POST', '/api/register', { body: { username: 'bob', displayName: 'Bob', password: 'passw0rd!x' } });
    check([owner, alice, bob].every((r) => r.status === 200 && r.data.token), 'registered three accounts');
    const tOwner = owner.data.token, tAlice = alice.data.token;
    let tBob = bob.data.token; // refreshed after the disable/re-enable below revokes sessions
    const ownerId = owner.data.user.id, aliceId = alice.data.user.id, bobId = bob.data.user.id;

    let r = await api('PATCH', `/api/admin/users/${aliceId}`, { token: tOwner, body: { is_admin: true } });
    check(r.status === 200 && r.data.user.is_admin === true, 'owner promotes Alice to site admin', r.data);
    r = await api('GET', '/api/admin/users', { token: tAlice });
    check(r.status === 200, 'Alice can use the admin panel', r.status);
    const ownerRow = (r.data.users || []).find((u) => u.id === ownerId);
    check(!!ownerRow && ownerRow.ownerAccount === true, 'the owner row is flagged ownerAccount for the panel to grey out', ownerRow && { ownerAccount: ownerRow.ownerAccount });

    console.log('\n[2] another admin cannot touch the owner account');
    const locked = [
      ['PATCH', `/api/admin/users/${ownerId}`, { displayName: 'Hacked' }, 'rename'],
      ['PATCH', `/api/admin/users/${ownerId}`, { password: 'newpass1' }, 'password reset'],
      ['PATCH', `/api/admin/users/${ownerId}`, { disabled: true }, 'disable'],
      ['PATCH', `/api/admin/users/${ownerId}`, { is_admin: false }, 'demote'],
      ['PATCH', `/api/admin/users/${ownerId}`, { bio: 'nope' }, 'bio edit'],
      ['DELETE', `/api/admin/users/${ownerId}`, undefined, 'delete'],
      ['POST', `/api/admin/users/${ownerId}/sessions/revoke`, {}, 'forced logout'],
      ['POST', `/api/admin/users/${ownerId}/2fa/disable`, {}, '2FA reset'],
      ['DELETE', `/api/admin/users/${ownerId}/avatar`, undefined, 'avatar removal'],
      ['DELETE', `/api/admin/users/${ownerId}/banner`, undefined, 'banner removal'],
      ['DELETE', `/api/admin/users/${ownerId}/sidebar-banner`, undefined, 'member-list banner removal'],
    ];
    for (const [method, p, body, label] of locked) {
      const res = await api(method, p, { token: tAlice, body });
      check(res.status === 403 && res.data.error === 'owner_protected', `Alice: ${label} → owner_protected`, { status: res.status, error: res.data && res.data.error });
    }
    // Nothing above actually changed anything.
    const ownerNow = await api('GET', `/api/admin/users/${ownerId}`, { token: tOwner });
    check(ownerNow.data.user.display_name === 'Owner' && ownerNow.data.user.disabled === false && ownerNow.data.user.is_admin === true,
      'the owner account is untouched after all of it', { name: ownerNow.data.user.display_name, disabled: ownerNow.data.user.disabled });
    const ownerLogin = await api('POST', '/api/login', { body: { username: 'jreoka', password: 'passw0rd!x' } });
    check(ownerLogin.status === 200, 'the owner password still works', ownerLogin.status);

    console.log('\n[3] the owner still runs their own account');
    r = await api('PATCH', `/api/admin/users/${ownerId}`, { token: tOwner, body: { displayName: 'Owner', bio: 'instance owner' } });
    check(r.status === 200 && r.data.user.bio === 'instance owner', 'the owner can edit their own profile from the panel', r.data && r.data.user && r.data.user.bio);
    r = await api('PATCH', `/api/admin/users/${bobId}`, { token: tOwner, body: { displayName: 'Bobby' } });
    check(r.status === 200 && r.data.user.display_name === 'Bobby', 'the owner can still manage other users', r.data && r.data.user && r.data.user.display_name);

    console.log('\n[4] ordinary users are unaffected');
    r = await api('PATCH', `/api/admin/users/${bobId}`, { token: tAlice, body: { disabled: true } });
    check(r.status === 200 && r.data.user.disabled === true, 'Alice can disable a normal account', r.data && r.data.user && r.data.user.disabled);
    r = await api('POST', '/api/login', { body: { username: 'bob', password: 'passw0rd!x' } });
    check(r.status === 403 && r.data.error === 'account_disabled', 'Bob is locked out', r.data);
    r = await api('PATCH', `/api/admin/users/${bobId}`, { token: tAlice, body: { disabled: false } });
    check(r.status === 200 && r.data.user.disabled === false, 'and can be re-enabled', r.data && r.data.user && r.data.user.disabled);
    // Disabling revoked every session, so Bob needs a fresh login for the rest.
    const bobBack = await api('POST', '/api/login', { body: { username: 'bob', password: 'passw0rd!x' } });
    check(bobBack.status === 200 && !!bobBack.data.token, 'Bob can log back in');
    if (bobBack.data && bobBack.data.token) tBob = bobBack.data.token;
    r = await api('PATCH', `/api/admin/users/${aliceId}`, { token: tOwner, body: { is_admin: true } });
    check(r.status === 200, 'Alice keeps her admin flag');

    console.log('\n[5] kick is refused too');
    const srv = await api('POST', '/api/servers', { token: tAlice, body: { name: 'Alice Land' } });
    const sid = srv.data.server.id;
    let join = await api('POST', '/api/servers/join', { token: tOwner, body: { inviteCode: srv.data.invite.code } });
    check(join.status === 200, 'the owner joins Alice\'s server', join.data);
    r = await api('DELETE', `/api/admin/servers/${sid}/members/${ownerId}`, { token: tAlice });
    check(r.status === 403 && r.data.error === 'owner_protected', 'Alice cannot kick the owner from a server', r.data);
    const stillMember = await api('GET', `/api/admin/servers/${sid}/members`, { token: tAlice });
    const members = stillMember.data.members || [];
    check(members.some((m) => m.id === ownerId), 'the owner is still in the server');
    join = await api('POST', '/api/servers/join', { token: tBob, body: { inviteCode: srv.data.invite.code } });
    check(join.status === 200, 'Bob joins too');
    const memberList = await api('GET', `/api/admin/servers/${sid}/members`, { token: tAlice });
    const ownerMember = (memberList.data.members || []).find((m) => m.id === ownerId);
    check(!!ownerMember && ownerMember.ownerAccount === true, 'the members list flags the owner account so the row can be greyed', ownerMember && { ownerAccount: ownerMember.ownerAccount });
    r = await api('DELETE', `/api/admin/servers/${sid}/members/${bobId}`, { token: tAlice });
    check(r.status === 200, 'Alice can still kick a normal member', r.data);

    console.log('\n[6] report actions cannot be aimed at the owner');
    const ownerWs = await connectWs(tOwner); conns.push(ownerWs);
    const bobWs = await connectWs(tBob); conns.push(bobWs);
    await waitFor(() => ownerWs.last('hello'), 5000);
    await waitFor(() => bobWs.last('hello'), 5000);
    const channelId = srv.data.server.channels.find((c) => c.type === 'text').id;
    ownerWs.send({ t: 'message', serverId: sid, channelId, content: 'an owner message', replyTo: null, threadRoot: null });
    const posted = await waitForAsync(async () => {
      const h = await api('GET', `/api/servers/${sid}/channels/${channelId}/messages`, { token: tAlice });
      return (h.data.messages || []).find((m) => m.content.includes('an owner message')) || null;
    }, 5000);
    if (!posted) return fail('owner message never landed');
    const rep = await api('POST', '/api/reports', { token: tAlice, body: { messageId: posted.id, kind: 'server', reason: 'other' } });
    check(rep.status === 200, 'Alice files a report about the owner\'s message', rep.data);
    const list = await api('GET', '/api/admin/reports?status=open', { token: tAlice });
    const row = list.data.reports.find((x) => x.id === rep.data.id);
    check(!!row && row.author && row.author.ownerAccount === true, 'the report view flags the protected author', row && row.author);
    for (const [action, label] of [['disable', 'disable'], ['delete_disable', 'delete + disable'], ['ban', 'ban']]) {
      const res = await api('POST', `/api/admin/reports/${rep.data.id}/resolve`, { token: tAlice, body: { action } });
      check(res.status === 403 && res.data.error === 'owner_protected', `report action ${label} → owner_protected`, { status: res.status, error: res.data && res.data.error });
    }
    r = await api('POST', `/api/admin/reports/${rep.data.id}/resolve`, { token: tAlice, body: { action: 'delete' } });
    check(r.status === 200 && r.data.messageDeleted === true, 'deleting the reported message is still allowed', r.data);
    const ownerAfter = await api('GET', `/api/admin/users/${ownerId}`, { token: tOwner });
    check(ownerAfter.data.user.disabled === false && ownerAfter.data.user.is_admin === true, 'the owner account survived the reports queue', { disabled: ownerAfter.data.user.disabled, is_admin: ownerAfter.data.user.is_admin });

    console.log('\n[7] the owner can still act through their own panel session');
    r = await api('POST', `/api/admin/users/${bobId}/sessions/revoke`, { token: tOwner });
    check(r.status === 200, 'the owner can revoke another user\'s sessions', r.data);
  } finally {
    for (const c of conns) { try { c.close(); } catch {} }
    if (child) { try { child.kill(); } catch {} }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => '  - ' + f).join('\n')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('[test] crashed:', (e && e.message) || e); process.exit(1); });
