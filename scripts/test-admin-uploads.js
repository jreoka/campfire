// Admin → Users: how much each account has uploaded.
//
// The request: every user row in the console should say how much that account
// has uploaded, in KB/MB/GB.
//
// What that number IS, and what this pins:
//
//   1. It is summed from what the DATABASE still points at — chat attachments
//      (`attachments`) plus DM attachments (`dm_attachments`, which is where
//      view-once media lives too) — attributed to the message's AUTHOR, so one
//      person's uploads never land on someone else's row.
//   2. Profile media (avatars, banners, custom emoji) records no size anywhere,
//      so it is deliberately not in this figure — the Media tab's storage
//      listing is the view that counts actual bytes on the bucket.
//   3. The list route reads the whole page with two GROUP BY queries, never one
//      query per row (the console lists up to 200 accounts at a time), and a
//      single-user route (the edit modal, an action's response) reads just that
//      account.
//   4. The row renders it through the client's own fmtSize, which now has the GB
//      step (a chat attachment never needed one; a per-account total does).
//
// Static half (always runs). API half (skips without Postgres): a throwaway
// database, a real server, real rows, and the real admin routes over HTTP.
//
// Usage: node scripts/test-admin-uploads.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_admin_uploads_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3423', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const MB = 1024 * 1024;

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
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}

const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const adminJs = fs.readFileSync(path.join(ROOT, 'public/js/admin.js'), 'utf8');
const coreJs = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');

function staticChecks() {
  console.log('\n[1] the server sums what an account uploaded');
  check(/async function uploadBytesByUser\(ids\)/.test(serverSrc), 'there is one shared aggregate for a set of accounts');
  check(/FROM attachments a JOIN messages m ON m\.id = a\.message_id[\s\S]*?GROUP BY m\.user_id/.test(serverSrc),
    'chat attachments are summed and grouped by the message author');
  check(/FROM dm_attachments a JOIN dm_messages m ON m\.id = a\.message_id[\s\S]*?GROUP BY m\.user_id/.test(serverSrc),
    'DM attachments (view-once media included) are summed the same way');
  check(/const ph = ids\.map\(\(\) => '\?'\)\.join\(','\)/.test(serverSrc) && /WHERE m\.user_id IN \(\$\{ph\}\)/.test(serverSrc),
    'the whole page is read with one IN (...) query per table, not one query per row');
  check(/uploadCount: up\.files, uploadBytes: up\.bytes/.test(serverSrc), 'the admin view carries the count and the byte total');
  check(/let up = uploads && typeof uploads\.get === 'function' \? uploads\.get\(u\.id\) : null;/.test(serverSrc)
    && /if \(!up && !uploads\) up = \(await uploadBytesByUser\(\[u\.id\]\)\)\.get\(u\.id\);/.test(serverSrc),
    'a precomputed page map is reused, and a single-user route reads just that account');
  check(/const uploads = await uploadBytesByUser\(rows\.map\(\(r\) => r\.id\)\);/.test(serverSrc),
    'the users list hands the page map in');
  check(/const uploads0 = await uploadBytesByUser\(rows0\.map\(\(r\) => r\.id\)\);/.test(serverSrc),
    'so does the server-members list');

  console.log('\n[2] the console says it, in KB/MB/GB');
  check(/function admUploadsText\(u\) \{/.test(adminJs), 'one helper renders the number');
  check(/\$\{u\.messageCount \+ u\.dmCount\} msgs · \$\{admUploadsText\(u\)\} · joined/.test(adminJs),
    'every user row carries it beside the message count');
  check(/Storage used: \$\{esc\(admUploadsText\(u\)\)\}/.test(adminJs), 'the edit modal states it too');
  check(/if \(!n\) return 'no uploads';/.test(adminJs), 'an account that never uploaded says so instead of "0 B"');

  // The real fmtSize, run: a per-account total is the first caller to need GB.
  const fmtSrc = slice(coreJs, 'function fmtSize(b) {', 'function memberByUsername(');
  const fmtSize = new Function(fmtSrc + '; return fmtSize;')();
  check(fmtSize(900) === '900 B' && fmtSize(2048) === '2.0 KB', 'bytes and KB still read as before', fmtSize(2048));
  check(fmtSize(6 * MB) === '6.0 MB', 'MB as before', fmtSize(6 * MB));
  check(fmtSize(1536 * MB) === '1.50 GB' && fmtSize(3 * 1024 * MB) === '3.00 GB',
    'and a total past a gigabyte reads in GB', fmtSize(1536 * MB));

  console.log('\n[3] it is the message author\'s number, and only uploads are in it');
  check(!/custom_emoji|media_history|avatar_url|banner_url/.test(slice(serverSrc, 'async function uploadBytesByUser(ids) {', 'const EMPTY_UPLOADS')),
    'profile media (which records no size) is not folded into the figure');
  console.log('  (the API half proves the attribution against a real database)');
}

async function req(method, p, { token, body } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, data: d };
}

async function apiHalf() {
  const envFile = readEnvFile();
  const pg = {
    host: process.env.PGHOST || envFile.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || envFile.POSTGRES_USER || 'campfire',
    password: process.env.PGPASSWORD || envFile.POSTGRES_PASSWORD || '',
  };
  const admin = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
  try { await admin.connect(); }
  catch (e) {
    console.log('\n[4] the routes — SKIPPED (Postgres unreachable: ' + ((e && e.message) || e) + ')');
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-adm-uploads-'));
  let child = null;
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
        JWT_SECRET: 'test-admin-uploads-secret', UPLOAD_DIR: path.join(tmp, 'uploads'),
        VIRUS_SCAN: '0', MEDIA_COMPRESS: '0', UNFURL: '0',
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
    // The instance owner's username is what grants the console (db.js's
    // OWNER_USERNAME auto-admin), so the admin in this test IS 'jreoka'.
    const owner = await req('POST', '/api/register', { body: { username: 'jreoka', displayName: 'Boss', password: PW } });
    const dana = await reg('dana', 'Dana');
    const erin = await reg('erin', 'Erin');
    if (!owner.data.token) throw new Error('owner registration failed: ' + JSON.stringify(owner.data));
    const token = owner.data.token;

    // A server dana posts in, so her attachments hang off a real message.
    const made = (await req('POST', '/api/servers', { token, body: { name: 'Upload Lab' } })).data;
    const sid = made.server.id;
    const cid = made.server.channels.find((c) => c.type === 'text').id;
    await req('POST', '/api/servers/join', { token: dana.token, body: { inviteCode: made.invite.code } });

    // Rows the app would have written, written directly: two of dana's chat
    // uploads (1.5 MB + 0.5 MB), a 3 MB one of the OWNER's in the same channel
    // (the attribution this is about), and a 6 MB DM attachment of dana's.
    const db = new Client({ ...pg, database: TEST_DB, connectionTimeoutMillis: 4000 });
    await db.connect();
    const t = Date.now();
    const insMsg = (id, uid, content) => db.query(
      'INSERT INTO messages (id, server_id, channel_id, user_id, content, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, sid, cid, uid, content, t]);
    const insAtt = (id, mid, url, name, size, kind) => db.query(
      'INSERT INTO attachments (id, message_id, url, filename, mime, size, kind, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, mid, url, name, 'application/octet-stream', size, kind, t]);
    await insMsg('m-dana-1', dana.user.id, 'dana one');
    await insMsg('m-dana-2', dana.user.id, 'dana two');
    await insMsg('m-boss-1', owner.data.user.id, 'boss one');
    await insAtt('a-dana-1', 'm-dana-1', '/uploads/a1.bin', 'a1.bin', Math.round(1.5 * MB), 'file');
    await insAtt('a-dana-2', 'm-dana-2', '/uploads/a2.bin', 'a2.bin', Math.round(0.5 * MB), 'file');
    await insAtt('a-boss-1', 'm-boss-1', '/uploads/b1.bin', 'b1.bin', 3 * MB, 'file');
    const dm = (await req('POST', '/api/dms', { token: dana.token, body: { userId: owner.data.user.id } })).data.thread;
    await db.query('INSERT INTO dm_messages (id, thread_id, user_id, content, created_at) VALUES ($1,$2,$3,$4,$5)',
      ['dm-dana-1', dm.id, dana.user.id, 'dana dm', t]);
    await db.query('INSERT INTO dm_attachments (id, message_id, url, filename, mime, size, kind, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      ['da-dana-1', 'dm-dana-1', '/uploads/d1.bin', 'd1.bin', 'application/octet-stream', 6 * MB, 'file', t]);
    // Erin never uploaded a file, but she does carry profile media — which is
    // deliberately outside this figure.
    await db.query("UPDATE users SET avatar_url = '/uploads/avatars/erin.png', banner_url = '/uploads/banners/erin.png' WHERE id = $1", [erin.user.id]);
    await db.end();

    console.log('\n[4] the console reads it off the database');
    let r = await req('GET', '/api/admin/users?q=dana&limit=50&offset=0', { token });
    check(r.status === 200 && r.data.users.length === 1, 'the admin can list the account', { status: r.status, n: r.data.users?.length });
    let u = r.data.users[0] || {};
    check(u.uploadBytes === Math.round(1.5 * MB) + Math.round(0.5 * MB) + 6 * MB && u.uploadCount === 3,
      'dana reads 3 uploads totalling 8 MB (chat + DM attachments)', { bytes: u.uploadBytes, n: u.uploadCount });
    check(typeof u.uploadBytes === 'number', 'as a number the client can format', typeof u.uploadBytes);

    // Queried by DISPLAY NAME in the case it is stored in: the console's search
    // box has to answer to "Boss" when the account is @jreoka, which is what the
    // ILIKE fix was for.
    r = await req('GET', '/api/admin/users?q=Boss&limit=50&offset=0', { token });
    check(r.data.users.length === 1, 'the console search finds a display name by its stored case', (r.data.users || []).map((x) => x.display_name));
    const bossRow = (r.data.users || []).find((x) => x.id === owner.data.user.id) || {};
    check(bossRow.uploadBytes === 3 * MB && bossRow.uploadCount === 1,
      'the owner is credited with their own upload only, in the same channel', { bytes: bossRow.uploadBytes, n: bossRow.uploadCount });

    r = await req('GET', '/api/admin/users?q=erin&limit=50&offset=0', { token });
    const erinRow = (r.data.users || [])[0] || {};
    check(erinRow.uploadBytes === 0 && erinRow.uploadCount === 0,
      'an account with only profile media reads nothing uploaded', { bytes: erinRow.uploadBytes, n: erinRow.uploadCount });

    console.log('\n[5] a single-account read agrees, and so does the members list');
    r = await req('GET', `/api/admin/users/${dana.user.id}`, { token });
    check(r.data.user && r.data.user.uploadBytes === 8 * MB && r.data.user.uploadCount === 3,
      'GET /api/admin/users/:id sums the same account on its own',
      { bytes: r.data.user && r.data.user.uploadBytes, n: r.data.user && r.data.user.uploadCount });
    r = await req('GET', `/api/admin/servers/${sid}/members`, { token });
    const member = (r.data.members || []).find((m) => m.id === dana.user.id) || {};
    check(member.uploadBytes === 8 * MB, 'the server-members list carries it too', member.uploadBytes);

    console.log('\n[6] the number follows the rows');
    const db2 = new Client({ ...pg, database: TEST_DB, connectionTimeoutMillis: 4000 });
    await db2.connect();
    await db2.query('DELETE FROM attachments WHERE id = $1', ['a-dana-1']);
    await db2.end();
    r = await req('GET', `/api/admin/users/${dana.user.id}`, { token });
    check(r.data.user.uploadBytes === Math.round(0.5 * MB) + 6 * MB && r.data.user.uploadCount === 2,
      'a removed attachment leaves the total', { bytes: r.data.user && r.data.user.uploadBytes, n: r.data.user && r.data.user.uploadCount });
  } finally {
    try { if (child) child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  console.log('[test] admin → users: per-account upload totals');
  staticChecks();
  await apiHalf();
  console.log('\n' + (failures.length ? 'FAILED: ' + failures.length : 'OK') + ' — ' + passed + ' checks passed');
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('[test] crashed:', (e && e.message) || e); process.exit(1); });
