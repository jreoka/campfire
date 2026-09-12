// Search: what it may return, who it may filter by, and when it happened.
//
// Owner report: search returned messages from chats the searcher cannot open
// (a DM you dismiss keeps its membership row, so its history stayed
// searchable), and a message whose author's account was deleted was listed
// under an invented name ("Someone").
//
// Static half (always runs): `fmtAgo`'s buckets, the `from:` operator parser,
// and the wiring that ties them to the panel.
//
// API half (skips without Postgres): a throwaway database with a server, a 1:1
// DM and a site admin, driving the real routes over HTTP + WS — a dismissed DM
// drops out of the searcher's results (and their DM list) while still showing
// for the other participant, a non-member sees nothing from the server,
// `from:` resolves handles / display names / handle prefixes (and reports when
// nobody matches), an author-only search works with no text, and a deleted
// author's messages come back with no user at all.
//
// Usage: node scripts/test-search.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_search_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3421', 10);
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

const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'public/js/ui.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

console.log('\n[1] "how long ago", for a list that is not in front of you');
const { fmtAgo } = eval(slice(core, 'function fmtAgo(', 'async function api(') + '\n;({ fmtAgo })');
const NOW = Date.now();
check(fmtAgo(NOW - 5e3) === 'just now', 'seconds read as "just now"', fmtAgo(NOW - 5e3));
check(fmtAgo(NOW - 10 * 60e3) === '10m ago', 'minutes read as "10m ago"', fmtAgo(NOW - 10 * 60e3));
check(fmtAgo(NOW - 3 * 3600e3) === '3h ago', 'hours read as "3h ago"', fmtAgo(NOW - 3 * 3600e3));
check(fmtAgo(NOW - 2 * 86400e3) === '2d ago', 'days read as "2d ago"', fmtAgo(NOW - 2 * 86400e3));
check(fmtAgo(NOW - 6 * 86400e3) === '6d ago', 'a week is still relative', fmtAgo(NOW - 6 * 86400e3));
const old = fmtAgo(NOW - 400 * 86400e3);
check(/\d/.test(old) && !/ago/.test(old), 'beyond a week it is a date, not "N ago"', old);
check(/[A-Za-z]{3}/.test(old), 'and the date carries a month name', old);
check(fmtAgo(0) === '' && fmtAgo(undefined) === '', 'no timestamp, no text');

console.log('\n[2] the from: operator');
const { parseFindQuery } = eval(slice(ui, 'function parseFindQuery(', 'function runFindMsgSearch(') + '\n;({ parseFindQuery })');
let p = parseFindQuery('deploy notes');
check(p.text === 'deploy notes' && p.from === '', 'a plain query has no author', p);
p = parseFindQuery('from:ada');
check(p.text === '' && p.from === 'ada', 'from: alone is a valid search', p);
p = parseFindQuery('deploy from:ada notes');
check(p.text === 'deploy notes' && p.from === 'ada', 'the operator comes out of the text', p);
p = parseFindQuery('FROM:Ada');
check(p.from === 'Ada', 'the operator is case-insensitive, the name is not lowercased', p);
p = parseFindQuery('from:"Ada Lovelace" cake');
check(p.from === 'Ada Lovelace' && p.text === 'cake', 'a quoted name keeps its space', p);
p = parseFindQuery('email from:ada@example.com');
check(p.from === 'ada@example.com', 'a name is taken whole', p);

console.log('\n[3] the panel is wired to both');
check(/from:name finds one person/.test(index), 'the panel hint teaches the operator', /find-hint[^<]*/.exec(index));
check(/&from=' \+ encodeURIComponent\(from\)/.test(ui), 'the request carries the author filter');
check(/const \{ text, from \} = parseFindQuery\(raw\)/.test(ui), 'the message search parses the box itself');
check(/fmtAgo\(m\.created_at\)/.test(ui), 'each result shows how long ago it was');
check(/'Deleted user'/.test(ui) && !/:\s*'Someone';/.test(ui), 'a deleted author is named as such, never "Someone"');
check(/if \(query\.length >= 2 \|\| qFrom\)/.test(ui), 'an author-only search still runs');
check(/SQL_FROM_LIST/.test('') === false && /function searchAuthors\(/.test(serverSrc), 'the server resolves from: to accounts');
check(/AND \(dmm\.hidden IS NULL OR dmm\.hidden = 0\)/.test(serverSrc), 'the search excludes DMs the account dismissed');

async function req(method, p, { token, body } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(d)}`);
  return d;
}
const openWs = (token) => new Promise((res, rej) => {
  const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
  w.once('open', () => res(w));
  w.once('error', rej);
});
const search = async (token, { q, from } = {}) => {
  const qs = '/api/search?limit=20' + (q ? '&q=' + encodeURIComponent(q) : '') + (from ? '&from=' + encodeURIComponent(from) : '');
  return req('GET', qs, { token });
};

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-search-e2e-'));
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
        JWT_SECRET: 'test-search-secret', UPLOAD_DIR: path.join(tmp, 'uploads'), VIRUS_SCAN: '0', MEDIA_COMPRESS: '0', UNFURL: '0',
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

    const reg = async (username, displayName) => req('POST', '/api/register', { body: { username, displayName, password: 'passw0rd!x' } });
    const alice = await reg('alice', 'Alice');
    const bob = await reg('bob', 'Bob');
    const carol = await reg('carol', 'Carol');
    // The instance owner's handle is the site admin (db.OWNER_USERNAME).
    const boss = await reg('jreoka', 'Boss');
    const made = await req('POST', '/api/servers', { token: alice.token, body: { name: 'Search Lab' } });
    const sid = made.server.id;
    const cid = made.server.channels.find((c) => c.type === 'text').id;
    await req('POST', '/api/servers/join', { token: bob.token, body: { inviteCode: made.invite.code } });

    const wsFor = {};
    for (const u of [alice, bob]) { wsFor[u.user.username] = await openWs(u.token); sockets.push(wsFor[u.user.username]); }
    await sleep(300);
    const say = async (who, content) => { wsFor[who].send(JSON.stringify({ t: 'message', serverId: sid, channelId: cid, content })); await sleep(400); };
    await say('alice', 'needle alice one');
    await say('bob', 'needle bob two');

    const dm = (await req('POST', '/api/dms', { token: alice.token, body: { userId: bob.user.id } })).thread;
    wsFor.bob.send(JSON.stringify({ t: 'dm', threadId: dm.id, content: 'needle dm secret' }));
    await sleep(500);

    console.log('\n[4] an accessible DM is searchable (so [5] is not a vacuous pass)');
    let r = await search(alice.token, { q: 'needle dm secret' });
    check(r.results.length === 1 && r.results[0].kind === 'dm' && r.results[0].message.threadId === dm.id, 'alice finds her DM message while the chat is open', r.results.map((x) => x.kind));

    console.log('\n[5] a dismissed DM drops out of its ex-reader\'s search');
    await req('POST', `/api/dms/${dm.id}/close`, { token: alice.token, body: {} });
    const list = await req('GET', '/api/dms', { token: alice.token });
    check(!(list.threads || []).some((t) => t.id === dm.id), 'the chat is gone from alice\'s DM list (inaccessible)', (list.threads || []).map((t) => t.id));
    r = await search(alice.token, { q: 'needle dm secret' });
    check(r.results.length === 0, 'and its history is gone from her search', r.results.map((x) => x.message && x.message.content));
    const bobList = await req('GET', '/api/dms', { token: bob.token });
    check((bobList.threads || []).some((t) => t.id === dm.id), 'the other participant still has it', (bobList.threads || []).map((t) => t.id));
    r = await search(bob.token, { q: 'needle dm secret' });
    check(r.results.length === 1 && r.results[0].kind === 'dm', 'and can still find it', r.results.map((x) => x.kind));

    console.log('\n[6] search is scoped to servers you are in');
    r = await search(alice.token, { q: 'needle alice' });
    check(r.results.length === 1 && r.results[0].kind === 'server' && r.results[0].channelName === 'general' && r.results[0].serverName === 'Search Lab',
      'a member finds the channel message, labelled', r.results[0]);
    r = await search(carol.token, { q: 'needle' });
    check(r.results.length === 0, 'a non-member finds nothing from that server', r.results.map((x) => x.message && x.message.content));

    console.log('\n[7] from: narrows to one author');
    r = await search(alice.token, { q: 'needle', from: 'bob' });
    check(r.results.length === 1 && r.results[0].message.user.username === 'bob', 'text + handle keeps only that author', r.results.map((x) => x.message.content));
    r = await search(alice.token, { from: 'bob' });
    check(r.results.length === 1 && r.results[0].message.content === 'needle bob two', 'an author-only search needs no text', r.results.map((x) => x.message.content));
    check(r.from && r.from.users === 1, 'the response says who it resolved to', r.from);
    r = await search(alice.token, { from: 'Bob' });
    check(r.results.length === 1 && r.results[0].message.user.username === 'bob', 'a display name resolves too', r.from);
    r = await search(alice.token, { from: 'bo' });
    check(r.results.length === 1 && r.from.users >= 1, 'a half-typed handle still lands somewhere', r.from);
    r = await search(alice.token, { from: 'nobody' });
    check(r.results.length === 0 && r.from && r.from.users === 0, 'an unknown author is reported as unknown, not as empty', r.from);
    r = await search(alice.token, { q: 'needle', from: 'carol' });
    check(r.results.length === 0 && r.from.users === 1, 'a real author with no matching text returns nothing', r.from);

    console.log('\n[8] a deleted author is not renamed');
    await req('DELETE', `/api/admin/users/${bob.user.id}`, { token: boss.token });
    r = await search(alice.token, { q: 'needle bob two' });
    check(r.results.length === 1, 'the message survives its author', r.results.map((x) => x.message.content));
    check(r.results[0] && r.results[0].message.user === null, 'and comes back with no user at all (the panel says "Deleted user")', r.results[0] && r.results[0].message.user);
    r = await search(alice.token, { from: 'bob' });
    check(r.results.length === 0 && r.from.users === 0, 'nobody answers to that handle any more', r.from);
  } finally {
    for (const w of sockets) { try { w.close(); } catch {} }
    try { child && child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED: ' + failures.length : 'OK') + ' — ' + passed + ' checks passed');
  if (failures.length) process.exit(1);
  process.exit(0);
}

main().catch((e) => { console.error('[test] crashed:', (e && e.message) || e); process.exit(1); });
