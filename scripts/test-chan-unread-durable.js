// Durable channel unread (see AGENTS.md verification conventions).
//
// The bug this covers: channel unread lived only in a per-account localStorage
// map fed by live WebSocket pushes. Anything that arrived while the app was
// closed — or while the socket was down, or overnight on a sleeping phone —
// was invisible the next time the app opened: no dot on the channel, no count
// on the server's rail icon, nothing. The owner hit exactly that on Android.
//
// The fix is the channel twin of DM unread: `channel_reads` holds one
// last_read_at per (account, channel), `GET /api/unread` answers which text
// channels of the caller's servers have an unseen message, and
// `POST /api/channels/:chId/read` / `POST /api/servers/:id/read` stamp it. A
// (user, channel) with no row counts from server_members.joined_at, so joining
// an old server never lights up its history.
//
// The client half — the real syncChanUnread / markChannelRead / markServerRead
// helpers against fakes — lives in scripts/test-chan-unread.js, which already
// owns that fake DOM; this file checks the wiring statically, the app-icon badge
// as a pure function, and then drives a real server against a throwaway
// database: the API, membership, the rules (own / system / thread-reply
// messages never count) and the one-shot migration seed. Skips (exit 0) when
// Postgres is down.
//
// Usage: node scripts/test-chan-unread-durable.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_chan_unread_durable';
const PORT = parseInt(process.env.TEST_PORT || '3436', 10);

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

// ---------- [A] the wiring, offline ----------
function clientChecks() {
  const servers = fs.readFileSync(path.join(ROOT, 'public/js/servers.js'), 'utf8');
  const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
  const socket = fs.readFileSync(path.join(ROOT, 'public/js/socket.js'), 'utf8');
  const final = fs.readFileSync(path.join(ROOT, 'public/js/final.js'), 'utf8');
  const auth = fs.readFileSync(path.join(ROOT, 'public/js/auth.js'), 'utf8');
  const home = fs.readFileSync(path.join(ROOT, 'public/js/home.js'), 'utf8');
  const security = fs.readFileSync(path.join(ROOT, 'public/js/security.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const db = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');

  console.log('\n[A1] the wiring: boot, resume, reconnect, cross-device');
  check(/async function refreshUnreadState\(\)/.test(servers) && /syncChanUnread\(\)/.test(servers) && /refreshDms\(\)/.test(servers),
    'one refresh reads every unread surface (channels + DMs + inbox)');
  check(/syncChanUnread\(\);/.test(auth), 'boot syncs the channel badges (the localStorage cache only paints first)');
  // final.js has more than one visibilitychange listener (the auto-updater has
  // its own), so the unread one is judged on its OWN block rather than on a
  // character window measured from the first listener in the file.
  const visBlocks = final.split("document.addEventListener('visibilitychange'").slice(1);
  check(visBlocks.some((b) => /clearActiveChanUnread\(\)/.test(b.slice(0, 900)) && /refreshUnreadState\(\)/.test(b.slice(0, 900))),
    'a foregrounded tab re-reads them (the sleeping-phone case)');
  check(/if \(wsOpened\) \{\s*try \{ refreshUnreadState\(\); \} catch \{\}\s*\}/.test(socket),
    'a socket RECONNECT re-reads them too (the missed-push case)');
  check(/markChannelRead\(m\.serverId, m\.channelId\)/.test(socket),
    'a message landing in the open channel is stamped read, so it is not unread next boot');
  check(/case 'chan-read': \{[\s\S]{0,240}applyRemoteChanRead\(m\.serverId, m\.channelId\)/.test(socket),
    'the chan-read push clears this account\'s other devices');
  check(/loadChanUnread\(\)/.test(auth), 'the per-account cache still paints before the fetch lands');
  check(/chanUnread: new Map\(\)/.test(core), 'the store lives on S');

  console.log('\n[A2] the app icon badge counts everything waiting');
  check(/notifUnread: 0,/.test(core), 'the inbox count has a home on S');
  const badge = slice(security, 'function totalUnreadCount()', 'async function refreshNotifBadge()');
  const MS = { dmUnread: new Map([['t1', 3], ['t2', 1]]), chanUnread: new Map([['s1:c1', 1], ['s2:c2', 1]]), notifUnread: 2 };
  const total = new Function('S', badge + '\nreturn totalUnreadCount();')(MS);
  check(total === 8, 'unread DMs (4) + unread channels (2) + inbox (2)', total);
  check(/navigator\.setAppBadge/.test(badge) && /navigator\.clearAppBadge/.test(badge),
    'the installed PWA gets a launcher/dock badge through the Badging API');
  check(/inv\('set_unread_count', \{ count: n \| 0 \}\)/.test(badge),
    'and the desktop app still gets its tray dot through set_unread_count');
  check(/paintAppBadge\(\);\r?\n\}/.test(security), 'paintNotifBadge repaints it (inbox changes)');
  check(/try \{ paintAppBadge\(\); \} catch \{\}/.test(home), 'so does paintHomeBadge (DM changes)');
  check((servers.match(/paintAppBadge\(\)/g) || []).length >= 3, 'and the channel marks', (servers.match(/paintAppBadge\(\)/g) || []).length);

  console.log('\n[A3] the server side is wired and guarded');
  check(/app\.get\('\/api\/unread', authRequired/.test(server), 'GET /api/unread exists and requires auth');
  check(/app\.post\('\/api\/channels\/:chId\/read', authRequired/.test(server), 'the per-channel read route exists');
  check(/app\.post\('\/api\/servers\/:id\/read', authRequired/.test(server), 'and the whole-server one');
  check(/COALESCE\(m\.sys, ''\) = ''/.test(server), 'system lines never count');
  check(/\(m\.thread_root_id IS NULL OR m\.thread_root_id = ''\)/.test(server), 'thread replies never count (they have their own surface)');
  check(/\(m\.user_id IS NULL OR m\.user_id <> \?\)/.test(server), 'your own messages never count (a webhook is someone else)');
  check(/m\.created_at > COALESCE\(r\.last_read_at, sm\.joined_at\)/.test(server), 'a never-read channel starts at joined_at, not at the dawn of time');
  check(/notifyUser\(req\.user\.id, \{ t: 'chan-read'/.test(server), 'both read routes push the clear to the account');
  check(/CREATE TABLE IF NOT EXISTS channel_reads/.test(db), 'the table is a guarded migration');
  check(/const hadChannelReads = await tableExists\('channel_reads'\);/.test(db) && /if \(!hadChannelReads\) \{/.test(db),
    'the one-time seed only runs on the boot that CREATES the table');
  check(/SELECT m\.user_id, c\.id, \$\{Date\.now\(\)\} FROM server_members m JOIN channels c ON c\.server_id = m\.server_id/.test(db),
    'the seed covers every membership that existed before the table');
  check(/async function tableExists\(table\)/.test(db), 'and it detects that with a real table check, not a guess');
}

// ---------- [B] the API, against a real server ----------
async function main() {
  clientChecks();

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
    console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
    if (failures.length) process.exit(1);
    return skip('Postgres unreachable (' + ((e && e.message) || e) + ') — docker compose up -d db');
  }

  const api = async (method, p, { token, body } = {}) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    let payload;
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers, body: payload });
    let data = null;
    try { data = await r.json(); } catch {}
    return { status: r.status, data };
  };
  const waitFor = async (fn, ms) => {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try { v = await fn(); } catch {}
      if (v) return v;
      if (Date.now() - t0 > ms) return null;
      await sleep(100);
    }
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cud-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });

  let child = null;
  const conns = [];
  let serverLog = '';
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();

    const env = {
      ...process.env,
      PORT: String(PORT),
      PGHOST: pg.host, PGPORT: String(pg.port), PGUSER: pg.user, PGPASSWORD: pg.password, PGDATABASE: TEST_DB,
      JWT_SECRET: 'test-chan-unread-durable',
      UPLOAD_DIR: uploads,
      UNFURL: '0',
    };
    const fail = (msg) => { throw new Error(msg + '\n--- server log ---\n' + serverLog.slice(-4000)); };
    const waitHttp = async (p, ms) => {
      const t0 = Date.now();
      for (;;) {
        try { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); if (r.ok) return true; } catch {}
        if (Date.now() - t0 > ms) return false;
        await sleep(250);
      }
    };
    const boot = async () => {
      child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (d) => { serverLog += d; });
      child.stderr.on('data', (d) => { serverLog += d; });
      if (!(await waitHttp('/api/config', 30000))) fail('server did not come up');
    };
    const stop = async () => {
      try { child && child.kill(); } catch {}
      child = null;
      const t0 = Date.now();
      for (;;) {
        try { await fetch(`http://127.0.0.1:${PORT}/api/config`); } catch { return; }
        if (Date.now() - t0 > 8000) return;
        await sleep(150);
      }
    };
    await boot();

    const reg = async (n) => {
      const r = await api('POST', '/api/register', { body: { username: n, displayName: n.toUpperCase(), password: 'passw0rd!x' } });
      if (!(r.status === 200 && r.data.token)) throw new Error('register ' + n + ' failed: ' + JSON.stringify(r.data));
      return r.data;
    };
    const connect = (token) => new Promise((resolve, reject) => {
      const events = [];
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
      ws.on('error', reject);
      ws.on('message', (raw) => { try { events.push(JSON.parse(raw.toString())); } catch {} });
      ws.on('open', () => { ws.send(JSON.stringify({ t: 'subscribe' })); resolve({ events, send: (o) => ws.send(JSON.stringify(o)), close: () => { try { ws.close(); } catch {} } }); });
    });
    // What the client's boot reads: the set of channel ids the server calls unread.
    const unreadOf = async (token, sid) => {
      const r = await api('GET', '/api/unread', { token });
      return ((r.data && r.data.channels) || {})[sid] || [];
    };

    console.log('\n[B1] the answer a cold start repaints from');
    const A = await reg('cuda'), B = await reg('cudb');
    const srv = (await api('POST', '/api/servers', { token: A.token, body: { name: 'Alpha' } })).data.server;
    const general = srv.channels.find((c) => c.type === 'text');
    const chat = (await api('POST', `/api/servers/${srv.id}/channels`, { token: A.token, body: { name: 'chat', type: 'text' } })).data.channel;
    const invite = (await api('POST', `/api/servers/${srv.id}/invites`, { token: A.token, body: {} })).data.invite;
    const join = await api('POST', '/api/servers/join', { token: B.token, body: { code: invite.code } });
    check(join.status === 200, 'B joins the server with an invite', join.data);

    const asock0 = await connect(A.token), bsock = await connect(B.token);
    conns.push(asock0, bsock);
    // A's socket dies with the process on every restart below; re-connect it (a
    // send on a closed socket is silently dropped, which would look like the
    // server ignoring the message).
    let asock = asock0;
    const reconnectA = async () => { try { asock.close(); } catch {} asock = await connect(A.token); conns.push(asock); await sleep(250); };
    await sleep(300);
    check((await unreadOf(B.token, srv.id)).length === 0, 'a fresh membership starts caught up (joined_at, not history)');

    asock.send({ t: 'message', serverId: srv.id, channelId: general.id, content: 'morning' });
    check(await waitFor(async () => (await unreadOf(B.token, srv.id)).includes(general.id), 5000),
      'a message in a channel B is not looking at makes it unread for B');
    check((await unreadOf(A.token, srv.id)).length === 0, 'the sender never has their own message unread');

    asock.send({ t: 'message', serverId: srv.id, channelId: chat.id, content: 'and here' });
    check(await waitFor(async () => (await unreadOf(B.token, srv.id)).length === 2, 5000),
      'a second channel counts too (this is the rail badge number)', await unreadOf(B.token, srv.id));
    check((await unreadOf(B.token, srv.id)).length === 2, 'and the count is channels, not messages');
    asock.send({ t: 'message', serverId: srv.id, channelId: chat.id, content: 'more' });
    await sleep(400);
    check((await unreadOf(B.token, srv.id)).length === 2, 'another message in the same channel does not double it');

    console.log('\n[B2] reading is durable, and follows the account across devices');
    let r = await api('POST', `/api/channels/${chat.id}/read`, { token: B.token });
    check(r.status === 200, 'B marks one channel read', r.data);
    check(!(await unreadOf(B.token, srv.id)).includes(chat.id), 'a fresh fetch agrees (a cold start keeps it cleared)');
    check((await unreadOf(B.token, srv.id)).includes(general.id), 'and the other channel is untouched');
    check(bsock.events.some((e) => e.t === 'chan-read' && e.channelId === chat.id),
      'the read is pushed to the account, so reading on the phone clears the desktop',
      bsock.events.map((e) => e.t).slice(-4));

    asock.send({ t: 'message', serverId: srv.id, channelId: chat.id, content: 'after the read' });
    check(await waitFor(async () => (await unreadOf(B.token, srv.id)).includes(chat.id), 5000),
      'a message after the read is unread again');

    r = await api('POST', `/api/servers/${srv.id}/read`, { token: B.token });
    check(r.status === 200, 'the whole server can be marked read in one request', r.data);
    check((await unreadOf(B.token, srv.id)).length === 0, 'and nothing in it is left unread');
    check(bsock.events.some((e) => e.t === 'chan-read' && !e.channelId && e.serverId === srv.id),
      'that one is pushed as the whole server (no channelId)');

    console.log('\n[B3] what never counts');
    asock.send({ t: 'message', serverId: srv.id, channelId: general.id, content: 'thread root' });
    check(await waitFor(async () => (await unreadOf(B.token, srv.id)).includes(general.id), 5000),
      'a top-level message counts');
    const hist = await api('GET', `/api/servers/${srv.id}/channels/${general.id}/messages`, { token: A.token });
    const rootId = ((hist.data.messages || []).find((m) => !m.sys && m.content === 'thread root') || {}).id;
    check(!!rootId, 'the root message is in the history', (hist.data.messages || []).map((m) => m.content));
    await api('POST', `/api/channels/${general.id}/read`, { token: B.token });
    check((await unreadOf(B.token, srv.id)).length === 0, 'reading it clears it');
    asock.send({ t: 'message', serverId: srv.id, channelId: general.id, content: 'a reply', threadRoot: rootId });
    await sleep(600);
    check((await unreadOf(B.token, srv.id)).length === 0,
      'a thread reply does not light the channel up (threads have their own surface)');
    asock.send({ t: 'message', serverId: srv.id, channelId: general.id, content: 'a real message' });
    check(await waitFor(async () => (await unreadOf(B.token, srv.id)).includes(general.id), 5000),
      'a real message after it still does');

    console.log('\n[B4] auth and membership');
    r = await api('GET', '/api/unread', {});
    check(r.status === 401, 'listing unread needs auth', r.status);
    r = await api('POST', `/api/channels/${general.id}/read`, {});
    check(r.status === 401, 'so does marking one read', r.status);
    r = await api('POST', `/api/servers/${srv.id}/read`, {});
    check(r.status === 401, 'and the whole-server one', r.status);
    const D = await reg('cudd');
    r = await api('POST', `/api/channels/${general.id}/read`, { token: D.token });
    check(r.status === 403 && r.data.error === 'not_member', 'a stranger cannot mark a channel of a server they are not in', r.data);
    r = await api('POST', `/api/servers/${srv.id}/read`, { token: D.token });
    check(r.status === 403, 'nor the whole server', r.data);
    r = await api('GET', '/api/unread', { token: D.token });
    check(r.status === 200 && Object.keys((r.data.channels) || {}).length === 0, 'and their own unread list is empty', r.data);
    r = await api('POST', '/api/channels/nope/read', { token: A.token });
    check(r.status === 404, 'an unknown channel is a 404', r.data);

    console.log('\n[B5] leaving does not resurrect on rejoin, and the seed is one-shot');
    // B leaves: their read rows stay, so a rejoin must NOT count the history.
    r = await api('POST', `/api/servers/${srv.id}/leave`, { token: B.token });
    check(r.status === 200, 'B leaves the server', r.data);
    const rejoin = await api('POST', '/api/servers/join', { token: B.token, body: { code: invite.code } });
    check(rejoin.status === 200, 'and rejoins', rejoin.data);
    const afterRejoin = await unreadOf(B.token, srv.id);
    check(afterRejoin.length === 0, 'rejoining is caught up at joined_at, not handed the history', afterRejoin);

    // Unread state survives a restart, and the first boot with the table seeds
    // every existing membership as caught up (the upgrade path).
    asock.send({ t: 'message', serverId: srv.id, channelId: general.id, content: 'unread going into the restart' });
    await waitFor(async () => (await unreadOf(B.token, srv.id)).includes(general.id), 5000);
    check((await unreadOf(B.token, srv.id)).includes(general.id), 'B has an unread channel going in');
    await stop();
    await boot();
    await reconnectA();
    check((await unreadOf(B.token, srv.id)).includes(general.id), 'a plain restart does not mark it read');

    // Simulate a database that predates the table: drop it (which also proves
    // the CREATE is what puts it back) with unread state live, then boot.
    await stop();
    const sqldb = new Client({ ...pg, database: TEST_DB, connectionTimeoutMillis: 4000 });
    await sqldb.connect();
    await sqldb.query('SET statement_timeout = \'10000\'');
    await sqldb.query('DROP TABLE IF EXISTS channel_reads');
    await boot();
    await reconnectA();
    const seeded = await sqldb.query('SELECT COUNT(*)::int AS n FROM channel_reads');
    check(seeded.rows[0].n > 0, 'the first boot with the table seeds it', seeded.rows[0]);
    check((await unreadOf(B.token, srv.id)).length === 0,
      'so an upgrade does not light up every channel that ever saw a message');
    asock.send({ t: 'message', serverId: srv.id, channelId: general.id, content: 'after the migration' });
    check(await waitFor(async () => (await unreadOf(B.token, srv.id)).includes(general.id), 5000),
      'a message after the migration is unread');
    await stop();
    await boot();
    await reconnectA();
    check((await unreadOf(B.token, srv.id)).includes(general.id), 'and the seed does not run again on the next boot');
    const seeded2 = await sqldb.query('SELECT COUNT(*)::int AS n FROM channel_reads');
    check(seeded2.rows[0].n > 0, 'the rows are still there', seeded2.rows[0]);
    await sqldb.end();
  } catch (e) {
    console.error('[test] ' + (e && e.stack || e));
    process.exit(1);
  } finally {
    for (const c of conns) { try { c.close(); } catch {} }
    try { child && child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}
main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
