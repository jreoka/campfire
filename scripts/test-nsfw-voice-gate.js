// The 18+ gate on VOICE rooms (offline — reads the shipped source and runs the
// real client functions with stubbed neighbours; no browser, no database).
//
// The rule is one sentence — a member who has never confirmed 18+ does not end
// up in an NSFW voice room — and it used to hold only because every UI door
// happened to call the gated door. Two ways around it:
//
//   [a] The server had no opinion at all. `voice-join` checked membership and
//       that the channel was a voice channel, and nothing else; `nsfwBlocked`
//       was wired into the message-history and search routes only. So a client
//       that skipped the modal (an older build, a raw frame) was in the room.
//   [b] `watchStream` joined straight through `joinVoice`. It also could not
//       have worked: a server room's occupancy key is the CHANNEL id, and the
//       code split that key on ':' and passed the halves on as
//       (serverId, channelId) — so the server was asked to join a room whose
//       "server" was a channel, refused, and the client was left in a call
//       nobody else was in.
//
// What this test pins:
//   [1] server.js — the refusal exists, it happens BEFORE anything registers
//       the socket in a room, and it reads the account's flag from the row
//       (ws.meta is a connect-time snapshot, so a confirmation made later in
//       the same session would not be on it),
//   [2] the client answers the refusal by tearing down the call it optimistically
//       built, asking once, and rejoining ONLY on a real confirmation,
//   [3] that answer stays scoped to the join it belongs to (a refusal for a room
//       we have left, or never tried, must not knock us out of the room we are
//       in),
//   [4] room resolution from the occupancy cache (channel key -> owning server)
//       and that no path splits that key any more,
//   [5] the client gate still runs BEFORE the call is built (so the age question
//       comes before the microphone permission prompt).
//
// Usage: node scripts/test-nsfw-voice-gate.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}

const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const voice = fs.readFileSync(path.join(ROOT, 'public/js/voice.js'), 'utf8');
const socket = fs.readFileSync(path.join(ROOT, 'public/js/socket.js'), 'utf8');
const servers = fs.readFileSync(path.join(ROOT, 'public/js/servers.js'), 'utf8');

// Read one function's text out of a module: from its header to the brace that
// closes it. The bodies involved carry no braces inside strings, so counting
// braces is exact here (and a mismatch fails the checks below rather than
// silently testing an empty string).
function sliceFn(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return '';
  let depth = 0, started = false;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) return src.slice(i, k + 1); }
  }
  return '';
}
function sliceFrom(src, header, endHeader) {
  const i = src.indexOf(header);
  if (i < 0) return '';
  const j = endHeader ? src.indexOf(endHeader, i) : -1;
  return j < 0 ? src.slice(i) : src.slice(i, j);
}

console.log('[1] server.js: the voice door enforces the rule itself');
// The DM branch is the notice's first `voice-join`; the server-room one is the
// second, which is the door this test is about.
const dmJoinAt = server.indexOf("if (msg.t === 'voice-join' && msg.threadId)");
const srvJoinAt = server.indexOf("if (msg.t === 'voice-join')", dmJoinAt + 1);
const srvJoin = sliceFrom(server, "if (msg.t === 'voice-join') {", "if (msg.t === 'voice-leave') {");
const dmJoin = sliceFrom(server, "if (msg.t === 'voice-join' && msg.threadId) {", "if (msg.t === 'voice-join') {");
check(srvJoinAt > dmJoinAt && srvJoin.length > 0, 'the server-room voice join is where the test expects it');
check(/if \(ch\.nsfw && !\(await nsfwConfirmed\(me\.userId\)\)\) \{/.test(srvJoin),
  'an NSFW room plus an unconfirmed account is refused (flag read for THIS socket\'s user)');
check(/safeSend\(ws, \{ t: 'voice-nsfw-required', serverId, channelId, name: ch\.name \}\);/.test(srvJoin),
  'and the client is told which room, by name, so it can ask');
check(/voice-nsfw-required[\s\S]{0,80}return;/.test(srvJoin),
  'the refusal returns — the frame goes no further');
// Order matters: a refusal that happened after the room roster or `me.voice`
// was written would leave a ghost occupant in the room it refused.
const refuseAt = srvJoin.indexOf('nsfwConfirmed(me.userId)');
const leaveAt = srvJoin.indexOf('if (me.voice) await leaveVoice(ws);');
check(leaveAt >= 0 && leaveAt < refuseAt,
  'the room the session was in is left first — a join is a switch, and the client already left it');
check(refuseAt >= 0 && refuseAt < srvJoin.indexOf('voiceRooms.get(key).add(ws)'),
  'the refusal is before the socket joins the room roster', refuseAt);
check(refuseAt >= 0 && refuseAt < srvJoin.indexOf('me.voice = {'),
  'and before this session is marked as being in voice');
check(refuseAt >= 0 && refuseAt < srvJoin.indexOf('voiceUpsert(ws)'),
  'and before the occupant registry is written');
check(!/nsfw/.test(dmJoin),
  'the DM-call door is untouched — a DM thread carries no 18+ flag');

const confirmed = sliceFn(server, 'async function nsfwConfirmed(userId)');
check(confirmed.length > 0, 'nsfwConfirmed() exists');
check(/SELECT nsfw_ok FROM users WHERE id = \?/.test(confirmed),
  'it reads the account flag from the ROW (ws.meta is a connect-time snapshot)');
check(!/ws\.meta/.test(confirmed), 'and never from the socket snapshot');
check(/catch \{ return true; \}/.test(confirmed),
  'a failed read does not block — a database hiccup must not seal every voice room');
check(server.indexOf('async function nsfwConfirmed') > server.indexOf('async function nsfwBlocked'),
  'it sits with the REST gate it mirrors');

console.log('\n[2] socket.js: the refusal reaches the client handler');
check(/case 'voice-nsfw-required':[\s\S]{0,400}onVoiceNsfwRequired\(m\);/.test(socket),
  'the frame is dispatched to onVoiceNsfwRequired');

console.log('\n[3] voice.js: the client asks once and only rejoins for real');
const parts = {
  onVoiceNsfwRequired: sliceFn(voice, 'async function onVoiceNsfwRequired(m)'),
  openVoiceChannel: sliceFn(voice, 'async function openVoiceChannel(serverId, channelId)'),
  openNsfwVoiceModal: sliceFn(voice, 'function openNsfwVoiceModal(ch)'),
  voiceRoomOfUser: sliceFn(voice, 'function voiceRoomOfUser(uid)'),
  // The confirmation itself lives with the text gate (servers.js) — the voice
  // dialog is a second caller of the same one-shot confirmation.
  confirmNsfwAge: sliceFn(servers, 'async function confirmNsfwAge()'),
};
const missing = Object.keys(parts).filter((k) => !parts[k]);
check(missing.length === 0, 'every client function was extracted by name', missing);
const SRC = Object.values(parts).join('\n');

function harness(over = {}) {
  const calls = { leave: [], modal: [], join: [], toast: [] };
  const sandbox = {
    S: Object.assign({
      voice: null, me: { id: 'me', nsfw_ok: 0 }, serverId: 's1',
      voiceOccupancy: new Map(), friendsVoice: new Map(), serverDetail: { channels: [] },
    }, over.S || {}),
    api: over.api || (async () => ({ user: { nsfw_ok: 1 } })),
    toast: (m) => calls.toast.push(m),
    leaveVoice: (silent) => { calls.leave.push(silent); sandbox.S.voice = null; },
    joinVoice: async (sid, cid) => { calls.join.push([sid, cid]); sandbox.S.voice = { kind: 'server', serverId: sid, channelId: cid }; },
    openModal: (title, body, okLabel, onOk, opts) => { calls.modal.push({ title, body, okLabel, onOk, onCancel: opts && opts.onCancel }); },
  };
  const api = new Function('sandbox', `with (sandbox) { ${SRC}
    return { onVoiceNsfwRequired, openVoiceChannel, openNsfwVoiceModal, confirmNsfwAge, voiceRoomOfUser }; }`)(sandbox);
  return { sandbox, api, calls };
}
const REFUSAL = { serverId: 's1', channelId: 'v1', name: 'after-dark' };

// ---------- [6] the same rule against a real server ----------
// The offline halves above pin the SOURCE and the client's own logic; this one
// proves the door actually closes, by sending the raw `voice-join` frame a
// gated client would never send. It boots the real server against a throwaway
// database and reads voice_occupants to answer the only question that matters:
// is the refused account in the room?
//
// Requirements: Postgres reachable (docker compose up -d db). Skips (exit 0)
// with a message when it isn't — or when the connection cannot create its own
// throwaway database.
async function e2e() {
  let Client, WebSocket;
  try { Client = require('pg').Client; WebSocket = require('ws'); }
  catch (e) { console.log('\n[6] end-to-end: SKIP — pg/ws not installed (' + ((e && e.message) || e) + ')'); return; }
  const os = require('os');
  const { spawn } = require('child_process');
  const TEST_DB = 'campfire_nsfw_voice_gate_test';
  const PORT = parseInt(process.env.TEST_PORT || '3455', 10);
  console.log('\n[6] end-to-end: a real server refuses the room');
  const envFile = (() => {
    const out = {};
    try {
      for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
        if (/^\s*#/.test(line)) continue;
        const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch {}
    return out;
  })();
  const pg = {
    host: process.env.PGHOST || envFile.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || envFile.PGPORT || '5432', 10),
    user: process.env.PGUSER || envFile.POSTGRES_USER || 'campfire',
    password: process.env.PGPASSWORD || envFile.POSTGRES_PASSWORD || '',
  };
  const admin = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
  try { await admin.connect(); }
  catch (e) { console.log('  SKIP Postgres unreachable (' + ((e && e.message) || e) + ') — docker compose up -d db'); return; }
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } catch (e) {
    console.log('  SKIP cannot create a throwaway database (' + ((e && e.message) || e) + ')');
    try { await admin.end(); } catch {}
    return;
  }
  await admin.end();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-nsfw-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  // The spawned copy must not inherit the live deployment's data settings: on a
  // host that has them (the production container) it would otherwise point at
  // the REAL media bucket, scanner and push keys and run its own sweeps there.
  // Everything that addresses data is dropped and the workers are forced off,
  // which is what makes this test safe to run beside a live instance.
  const DATA_ENV = /^(S3_|R2_|CLAMAV_|VIRUS_SCAN|MEDIA_|BUCKET_SCAN|ORPHAN_SWEEP|BACKUP|VAPID|PUSH_|WEBPUSH_|TURN_|STUN_|TURNSTILE)/;
  const cleanEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!DATA_ENV.test(k)) cleanEnv[k] = v;

  let child = null, serverLog = '';
  const sockets = [];
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, ms) {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try { v = await fn(); } catch {}
      if (v) return v;
      if (Date.now() - t0 > ms) return null;
      await sleep(120);
    }
  }
  const connect = (token) => new Promise((resolve, reject) => {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
    sockets.push(ws);
    ws.on('error', reject);
    ws.on('message', (raw) => { try { events.push(JSON.parse(raw.toString())); } catch {} });
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'subscribe' })); // what the real client does
      resolve({ events, send: (o) => { try { ws.send(JSON.stringify(o)); } catch {} } });
    });
  });

  try {
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: {
        ...cleanEnv,
        PORT: String(PORT),
        PGHOST: pg.host, PGPORT: String(pg.port), PGUSER: pg.user, PGPASSWORD: pg.password, PGDATABASE: TEST_DB,
        JWT_SECRET: 'test-nsfw-voice-secret',
        UPLOAD_DIR: uploads,
        UNFURL: '0', VIRUS_SCAN: '0', MEDIA_COMPRESS: '0', MEDIA_BUCKET_SWEEP: '0', BUCKET_SCAN: '0', ORPHAN_SWEEP: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    const up = await waitUntil(async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/api/config`)).ok; } catch { return false; } }, 30000);
    check(!!up, 'the server boots against a throwaway database', serverLog.split('\n').slice(-4).join(' | '));
    if (!up) return;

    const reg = async (n) => {
      const r = await api('POST', '/api/register', { body: { username: n, displayName: n.toUpperCase(), password: 'passw0rd!x' } });
      if (!(r.status === 200 && r.data.token)) throw new Error('register ' + n + ' failed: ' + JSON.stringify(r.data));
      return r.data;
    };
    const A = await reg('gatea'), B = await reg('gateb'), C = await reg('gatec');
    const meOf = async (t) => (await api('GET', '/api/me', { token: t })).data.user;
    const idB = (await meOf(B.token)).id, idC = (await meOf(C.token)).id;
    check((await meOf(B.token)).nsfw_ok === false, 'the account under test has never confirmed 18+');

    const srv = (await api('POST', '/api/servers', { token: A.token, body: { name: 'Gate Test' } })).data.server;
    const mkChannel = async (name, type) => (await api('POST', `/api/servers/${srv.id}/channels`, { token: A.token, body: { name, type } })).data.channel;
    const nsfwVc = await mkChannel('after-dark', 'voice');
    const plainVc = await mkChannel('Lobby', 'voice');
    const nsfwTc = await mkChannel('lounge', 'text');
    check((await api('PATCH', `/api/servers/${srv.id}/channels/${nsfwVc.id}`, { token: A.token, body: { nsfw: true } })).status === 200,
      'the owner marks one voice room 18+');
    check((await api('PATCH', `/api/servers/${srv.id}/channels/${nsfwTc.id}`, { token: A.token, body: { nsfw: true } })).status === 200,
      'and one text channel');
    const code = (await api('POST', `/api/servers/${srv.id}/invites`, { token: A.token, body: {} })).data.invite.code;
    for (const t of [B.token, C.token]) {
      check((await api('POST', '/api/servers/join', { token: t, body: { inviteCode: code } })).status === 200, 'a member joins the server');
    }

    const dbc = new Client({ ...pg, database: TEST_DB });
    await dbc.connect();
    const occupants = async (uid) => (await dbc.query('SELECT channel_id FROM voice_occupants WHERE user_id = $1', [uid])).rows;
    const inRoom = async (uid, cid) => (await occupants(uid)).some((r) => String(r.channel_id) === String(cid));

    console.log('\n[6a] the long-standing REST gate is untouched');
    const hist = await api('GET', `/api/servers/${srv.id}/channels/${nsfwTc.id}/messages`, { token: B.token });
    check(hist.status === 403 && hist.data.error === 'nsfw_confirm_required',
      'an unconfirmed member still cannot read an 18+ text channel', hist.data);

    console.log('\n[6b] the raw voice-join frame a gated client would never send');
    const b = await connect(B.token);
    b.send({ t: 'voice-join', serverId: srv.id, channelId: nsfwVc.id });
    const refused = await waitUntil(() => b.events.find((e) => e.t === 'voice-nsfw-required'), 5000);
    check(!!refused && String(refused.channelId) === String(nsfwVc.id), 'the server refuses the join and names the room', refused);
    check(!!refused && refused.name === 'after-dark', "with the channel name the client's dialog needs", refused && refused.name);
    check(!b.events.some((e) => e.t === 'voice-peers' && String(e.channelId) === String(nsfwVc.id)),
      'and sends no peer list — the join never happened');
    check((await occupants(idB)).length === 0, 'so the account is in no voice room at all (no ghost occupant)', await occupants(idB));

    console.log('\n[6c] the same raw frame into an ordinary room still works');
    const c = await connect(C.token);
    c.send({ t: 'voice-join', serverId: srv.id, channelId: plainVc.id });
    check(!!(await waitUntil(() => c.events.some((e) => e.t === 'voice-peers' && String(e.channelId) === String(plainVc.id)), 5000)),
      'an unconfirmed account joins a normal voice room, exactly as before');
    check(await waitUntil(() => inRoom(idC, plainVc.id), 5000), 'and the occupant row is really written', await occupants(idC));

    console.log('\n[6d] a refused SWITCH leaves the room it came from');
    c.send({ t: 'voice-join', serverId: srv.id, channelId: nsfwVc.id });
    check(!!(await waitUntil(() => c.events.some((e) => e.t === 'voice-nsfw-required'), 5000)), 'the switch into the 18+ room is refused');
    check(await waitUntil(async () => (await occupants(idC)).length === 0, 5000),
      'and the room they were in is gone too — the client already dropped it, so the server agrees on "nowhere"', await occupants(idC));

    console.log('\n[6e] confirming 18+ opens it, from the same flag');
    check((await api('POST', '/api/me/nsfw-confirm', { token: B.token })).status === 200, 'the member confirms they are 18 or older');
    check((await meOf(B.token)).nsfw_ok === true, 'the account carries the confirmation');
    b.send({ t: 'voice-join', serverId: srv.id, channelId: nsfwVc.id });
    check(!!(await waitUntil(() => b.events.some((e) => e.t === 'voice-peers' && String(e.channelId) === String(nsfwVc.id)), 5000)),
      'the same raw join now succeeds');
    check(await waitUntil(() => inRoom(idB, nsfwVc.id), 5000), 'and the occupancy row exists', await occupants(idB));
    check((await api('GET', `/api/servers/${srv.id}/channels/${nsfwTc.id}/messages`, { token: B.token })).status === 200,
      'and the 18+ text channel reads too — one flag, both doors');
    await dbc.end();
  } finally {
    for (const ws of sockets) { try { ws.close(); } catch {} }
    if (child) { try { child.kill(); } catch {} }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    const adm = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
    try { await adm.connect(); await adm.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`); await adm.end(); } catch {}
  }
}

(async () => {
  // --- our own join, user confirms ---
  {
    const h = harness({ S: { voice: { kind: 'server', serverId: 's1', channelId: 'v1' } } });
    const p = h.api.onVoiceNsfwRequired(REFUSAL);
    check(h.calls.modal.length === 1, 'the refusal opens the age dialog', h.calls.modal.length);
    check(h.calls.modal[0] && h.calls.modal[0].title === '#after-dark is NSFW',
      'titled with the room the server named', h.calls.modal[0] && h.calls.modal[0].title);
    check(h.calls.leave.length === 1 && h.calls.leave[0] === true,
      'the call the client optimistically built is torn down first, silently', h.calls.leave);
    check(h.sandbox.S.voice === null, 'so the client is not left in a room it was refused');
    await h.calls.modal[0].onOk();
    await p;
    check(JSON.stringify(h.calls.join) === JSON.stringify([['s1', 'v1']]),
      'confirming 18+ rejoins the room the server refused', h.calls.join);
    check(h.sandbox.S.me.nsfw_ok === 1, 'and the account now carries the confirmation');
  }
  // --- our own join, user declines ---
  {
    const h = harness({ S: { voice: { kind: 'server', serverId: 's1', channelId: 'v1' } } });
    const p = h.api.onVoiceNsfwRequired(REFUSAL);
    h.calls.modal[0].onCancel();
    await p;
    check(h.calls.join.length === 0 && h.sandbox.S.voice === null,
      'declining leaves the client out of the room', h.calls.join);
  }
  // --- the confirmation itself failed: never rejoin on a false "yes" ---
  {
    const h = harness({
      S: { voice: { kind: 'server', serverId: 's1', channelId: 'v1' } },
      api: async () => { throw new Error('offline'); },
    });
    const p = h.api.onVoiceNsfwRequired(REFUSAL);
    await h.calls.modal[0].onOk();
    await p;
    check(h.calls.join.length === 0,
      'a confirm POST that failed does not rejoin (no prompt/rejoin loop)', h.calls.join);
    check(h.calls.toast.length === 1, 'and it says so', h.calls.toast);
  }
  // --- not our refusal ---
  {
    for (const [label, st] of [
      ['a room we have moved on to', { kind: 'server', serverId: 's2', channelId: 'v2' }],
      ['a DM call', { kind: 'dm', threadId: 't1' }],
      ['no call at all', null],
    ]) {
      const h = harness({ S: { voice: st } });
      await h.api.onVoiceNsfwRequired(REFUSAL);
      check(h.calls.leave.length === 0 && h.calls.modal.length === 0 && h.calls.join.length === 0,
        'a refusal for a join we are not making is ignored (' + label + ')', h.calls);
    }
  }

  console.log('\n[4] voice.js: which room is a person actually in');
  const room = (over) => harness(over).api.voiceRoomOfUser('u2');
  const occ = (entries) => new Map(entries);
  check(JSON.stringify(room({
    S: { serverId: 's1', serverDetail: { channels: [{ id: 'v1', type: 'voice' }] }, voiceOccupancy: occ([['v1', [{ id: 'u2', sharing: true }]]]) },
  })) === JSON.stringify({ kind: 'server', serverId: 's1', channelId: 'v1' }),
    'a channel key resolves against the open server\'s own channel list');
  check(JSON.stringify(room({
    S: { voiceOccupancy: occ([['dm:t9', [{ id: 'u2', sharing: true }]]]) },
  })) === JSON.stringify({ kind: 'dm', threadId: 't9' }), 'a dm: key resolves to the DM call');
  check(room({ S: { voiceOccupancy: occ([['v1', [{ id: 'u2', sharing: false }]]]) } }) === null,
    'someone in a room who is not sharing has no stream to watch');
  check(room({ S: { voiceOccupancy: occ([['v1', [{ id: 'u3', sharing: true }]]]) } }) === null,
    'and neither does someone else entirely');
  check(JSON.stringify(room({
    S: {
      voiceOccupancy: occ([['v7', [{ id: 'u2', sharing: true }]]]),
      friendsVoice: new Map([['u2', { kind: 'server', serverId: 's7', channelId: 'v7', joinable: true }]]),
    },
  })) === JSON.stringify({ kind: 'server', serverId: 's7', channelId: 'v7' }),
    'a friend\'s room in a server we are not looking at takes its server id from Active Now');
  check(room({
    S: { voiceOccupancy: occ([['v7', [{ id: 'u2', sharing: true }]]]) },
  }) === null, 'and an unresolvable server id is given up on rather than guessed');
  check(!voice.includes("found.split(':')") && !voice.includes('joinVoice(srv, ch)'),
    'nothing splits an occupancy key into (serverId, channelId) any more (the old watchStream bug)');

  console.log('\n[5] voice.js: the gate is before the call, not after it');
  const open = sliceFn(voice, 'async function openVoiceChannel(serverId, channelId)');
  const gateAt = open.indexOf('nsfwGated(vch) && !(await openNsfwVoiceModal(vch))');
  check(gateAt >= 0 && gateAt < open.indexOf('await joinVoice(serverId, channelId)'),
    'the age dialog is asked before joinVoice() — so before the microphone prompt');
  const watch = sliceFn(voice, 'async function watchStream(uid)');
  check(/await openVoiceChannel\(room\.serverId, room\.channelId\)/.test(watch),
    'watching a stream joins through the gated door, not straight through joinVoice');
  check(!/joinVoice\(/.test(watch), 'watchStream never calls joinVoice itself');

  await e2e();

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
  process.exit(0);
})().catch((e) => { console.error('[test] crashed:', (e && e.message) || e); process.exit(1); });
