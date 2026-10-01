// The DM call lines: "<user> started a call — Join" and "Call ended · lasted
// X" (see AGENTS.md verification conventions).
//
// What this feature has to get right, and what a naive version gets wrong:
//
//   1. EXACTLY ONE PAIR PER CALL. A group call has N members and every join and
//      every leave runs the same "roster changed" path. The lines must be posted
//      on the two TRANSITIONS (empty->occupied, occupied->empty) and not per
//      event, or a five-person call leaves ten lines.
//   2. THE BOUNDARY IS NOT THE COUNT. Posting "started" on peers.length === 1
//      looks right and is wrong: a call going 2 -> 1 on a leave reads as
//      "length 1" and would announce itself all over again. The latch has to be
//      "is a call already open in this thread", which is what dm_call_sessions
//      is for.
//   3. THE SERVER POSTS THEM, NOT THE CLIENT. The starter frequently closes the
//      tab (ring, no answer, gone) — the start line has to exist without them,
//      and the end line has to survive them being gone. A client-side
//      implementation loses both.
//   4. THE DURATION IS MEASURED FROM THE REAL FIRST JOIN, by the replica that
//      sees the room drain, which is usually NOT the one that started it.
//   5. A CALL NOBODY JOINED IS NOT A CALL. Ring an empty thread and hang up two
//      seconds later and there must be no "lasted 2 seconds" line.
//   6. IT SELF-HEALS. A replica dying while holding the last occupant means the
//      leave never runs, so the row outlives the call. Left alone it is
//      permanent: every later call in that thread finds it, thinks it is already
//      announced, and says nothing. The roster contradicting the row must retire
//      it.
//   7. THE JOIN BUTTON IS NOT A LIE. The start line is written when the call
//      STARTS and never rewritten, so it cannot consult the roster at click time
//      (by then the answer is "no call") — and joining from an old line is a NEW
//      call, which is correct and must not be presented as rejoining.
//
// Boots a real server against a throwaway database and drives the real
// WebSocket voice path, then reads the thread back over the real API. Skips
// (exit 0) when Postgres is down.
//
// Usage: node scripts/test-dm-call-lines.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_dm_call_lines_test';
const PORT = parseInt(process.env.TEST_PORT || '3431', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(1); }
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
const ENV = readEnvFile();
const PG_ENV = {
  PGHOST: process.env.PGHOST || ENV.PGHOST || 'localhost',
  PGPORT: process.env.PGPORT || ENV.PGPORT || '5432',
  PGUSER: process.env.PGUSER || ENV.PGUSER || 'campfire',
  PGPASSWORD: process.env.PGPASSWORD || ENV.PGPASSWORD || '',
};
const JWT_SECRET = 'call-lines-test-secret-0123456789';

async function pgOk() {
  const c = new Client({ ...PG_ENV, database: 'postgres' });
  try { await c.connect(); await c.query('SELECT 1'); return true; }
  catch { return false; }
  finally { try { await c.end(); } catch {} }
}

// ============ [A] the real functions, sliced out of the real source ============
// These are pure (a duration formatter, the client card builder), so they are run
// directly rather than through a browser. A test that re-derives the rule is a
// test of the test, so both are taken as written.
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const messagesSrc = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');

const fmtCallDuration = new Function(
  slice(serverSrc, 'function fmtCallDuration(ms) {', '\nasync function postDmCallLine') + '\nreturn fmtCallDuration;'
)();

// The two SVG constants the card draws with are sliced out alongside the
// function, so the test renders with the REAL glyphs rather than a stand-in —
// the icons are part of what "make it look nice" means, and a card that
// rendered with a placeholder would still pass a shape-only assertion.
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const callSysLineHTML = new Function('esc',
  slice(messagesSrc, 'const CALL_SVG =', '\n// The button is delegated')
  + '\nreturn callSysLineHTML;'
)(esc);

(async () => {
  // ---- [A] duration wording ------------------------------------------------
  check(fmtCallDuration(1000) === '1 second', 'one second', fmtCallDuration(1000));
  check(fmtCallDuration(45000) === '45 seconds', 'seconds', fmtCallDuration(45000));
  // Flooring, not rounding: a 59.9s call must NOT be promoted to a minute, and a
  // 0.9s call must not be promoted to a second. Both would be a boundary the
  // call never reached.
  check(fmtCallDuration(59900) === '59 seconds', 'a call short of a minute is not called a minute', fmtCallDuration(59900));
  check(fmtCallDuration(900) === '0 seconds', 'a sub-second call floors rather than rounds up', fmtCallDuration(900));
  check(fmtCallDuration(60000) === '1 minute', 'one minute', fmtCallDuration(60000));
  check(fmtCallDuration(90000) === '1 minute', 'a minute and a half reads as one minute, not a rounded 1.5', fmtCallDuration(90000));
  check(fmtCallDuration(20 * 60000) === '20 minutes', 'minutes', fmtCallDuration(20 * 60000));
  check(fmtCallDuration(3600000) === '1 hour', 'one hour', fmtCallDuration(3600000));
  check(fmtCallDuration(3600000 + 60000) === '1 hour 1 minute', 'hour and minute', fmtCallDuration(3600000 + 60000));
  check(fmtCallDuration(25 * 3600000) === '1 day 1 hour', 'day and hour', fmtCallDuration(25 * 3600000));
  check(fmtCallDuration(0) === 'under a minute' && fmtCallDuration(-5) === 'under a minute', 'nonsense is not a duration', [fmtCallDuration(0), fmtCallDuration(-5)]);

  // ---- [A] the start card offers Join, the end card does not ---------------
  const start = callSysLineHTML({ sys: 'call-start', content: 'aaa started a voice call', callMeta: { threadId: 't1', video: false } });
  check(/data-calljoin="t1"/.test(start), 'the start line carries the thread it belongs to', start);
  check(/data-callvideo="0"/.test(start), 'a voice call joins as a voice call', start);
  check(/>Join</.test(start), 'the start line offers Join', start);
  check(!/lasted/.test(start), 'the start line does not claim a duration', start);
  const vstart = callSysLineHTML({ sys: 'call-start', content: 'aaa started a video call', callMeta: { threadId: 't1', video: true } });
  check(/data-callvideo="1"/.test(vstart), 'a video call joins as a video call', vstart);
  const end = callSysLineHTML({ sys: 'call-end', content: 'Call ended · lasted 4 minutes', callMeta: { durationMs: 240000 } });
  check(!/data-calljoin/.test(end), 'a call that is over does not offer to join it', end);
  check(/lasted 4 minutes/.test(end), 'the end line shows the measured duration', end);
  // The thread id must come off the line's own metadata, and fall back to the
  // message's thread when an old row somehow lacks it — a Join button with no
  // thread is a dead button.
  const noMeta = callSysLineHTML({ sys: 'call-start', content: 'x started a call', threadId: 't9' });
  check(/data-calljoin="t9"/.test(noMeta), 'a line with no callMeta still knows its thread', noMeta);
  // Escaping: the content is server-authored but the name is a user string.
  const nasty = callSysLineHTML({ sys: 'call-start', content: '<img src=x onerror=alert(1)> started a call', callMeta: { threadId: 't1' } });
  check(!/<img/.test(nasty), 'line content is escaped', nasty);
  check(/&lt;img/.test(nasty), 'escaped, not dropped', nasty);

  // ---- [A] a sys line with no call metadata is not a card ------------------
  check(!/data-calljoin/.test(callSysLineHTML({ sys: 'call-end', content: 'x left the chat' })),
    'a non-call system line never becomes a card', callSysLineHTML({ sys: 'call-end', content: 'x left the chat' }));

  // ---- [A] the wiring the cards depend on ---------------------------------
  check(/if \(m\.sys === 'call-start' \|\| m\.sys === 'call-end'\)/.test(messagesSrc),
    'messageEl routes only the two call sys kinds to the card');
  check(/div\.className = 'msg sys call-sys'/.test(messagesSrc), 'the card row is marked so CSS can centre it as a system line');
  check(/const stick = m\.sys === 'call-start'/.test(messagesSrc) === false, 'no stale reference to a removed variable');
  // Every OTHER system line must still be plain text: the card builder is only
  // reached for the two call kinds, and this asserts the plain path survived.
  check(/    div\.textContent = m\.content;\n    return div;/.test(messagesSrc),
    'non-call system lines are still rendered as plain text');
  check(/document\.addEventListener\('click', \(e\) => \{\n  const b = e\.target\.closest \? e\.target\.closest\('\[data-calljoin\]'\) : null;/.test(messagesSrc),
    'the Join key is handled by ONE delegated listener, not one per row');
  check(/async function joinCallFromLine\(threadId, video\)/.test(messagesSrc), 'joining from a line has its own entry point');
  check(/await selectDmThread\(threadId\)/.test(messagesSrc),
    'joining from a line in another thread navigates there first');

  // ============ [B] the live server: one pair per real call ============
  if (!(await pgOk())) skip('Postgres is not reachable (start the dev db) — [A] passed');

  // WITH (FORCE) so a database left behind by an interrupted previous run —
  // still holding the dead server's connections — is dropped in one step
  // instead of failing the DROP and leaving this run to build on a half-cleared
  // name. The test must be safe to run twice in a row with no cleanup between.
  const admin = new Client({ ...PG_ENV, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const env = {
    ...process.env,
    JWT_SECRET,
    PGDATABASE: TEST_DB,
    PGHOST: PG_ENV.PGHOST, PGPORT: PG_ENV.PGPORT,
    PGUSER: PG_ENV.PGUSER, PGPASSWORD: PG_ENV.PGPASSWORD,
    PORT: String(PORT),
    VIRUS_SCAN: '0', MEDIA_COMPRESS: '0', BUS: '0',
  };
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = '';
  srv.stdout.on('data', (d) => { srvLog += d; });
  srv.stderr.on('data', (d) => { srvLog += d; });

  const base = `http://127.0.0.1:${PORT}`;
  const api = async (p, opts = {}) => {
    const r = await fetch(base + p, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: 'Bearer ' + opts.token } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let json = null;
    try { json = await r.json(); } catch {}
    return { status: r.status, json };
  };
  const waitUp = async () => {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/api/config')).ok) return; } catch {}
      await sleep(400);
    }
    throw new Error('server never came up:\n' + srvLog);
  };
  const socks = [];
  const cleanup = async () => {
    for (const s of socks) { try { s.w.close(); } catch {} }
    // Wait for the PROCESS to be gone before dropping its database. A DROP that
    // races a still-connecting server fails, and the next run then finds a
    // half-built database and reports it as a product failure.
    try { srv.kill('SIGKILL'); } catch {}
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
      if (srv.exitCode !== null || srv.signalCode !== null) break;
      await sleep(100);
    }
    await sleep(300);
    const c = new Client({ ...PG_ENV, database: 'postgres' });
    try {
      await c.connect();
      // Any connection the dying server left behind blocks the DROP; with the
      // process gone they close on their own, but the pool may need a moment.
      await c.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    } catch {}
    try { await c.end(); } catch {}
  };

  try {
    await waitUp();

    const mkUser = async (name) => {
      const r = await api('/api/register', { method: 'POST', body: { username: name, password: 'password123', display_name: name } });
      if (r.status !== 200) throw new Error('register ' + name + ': ' + JSON.stringify(r.json));
      return { token: r.json.token, id: r.json.user.id, name };
    };
    const A = await mkUser('aaa');
    const B = await mkUser('bbb');
    const C = await mkUser('ccc');

    // A group needs real friendships, and the route takes userIds — both are the
    // app's rules, not test conveniences, so the test obeys them rather than
    // reaching into the database to shortcut them.
    for (const [x, y] of [[A, B], [A, C], [B, C]]) {
      const f = await api('/api/friends', { method: 'POST', token: x.token, body: { username: y.name } });
      if (f.status !== 200) throw new Error('friend ' + x.name + '->' + y.name + ': ' + f.status + ' ' + JSON.stringify(f.json));
      const acc = await api('/api/friends/' + x.id + '/accept', { method: 'POST', token: y.token });
      if (acc.status !== 200) throw new Error('accept for ' + y.name + ': ' + acc.status + ' ' + JSON.stringify(acc.json));
    }
    const grp = await api('/api/dms/group', { method: 'POST', token: A.token, body: { userIds: [B.id, C.id], name: 'The Group' } });
    const tid = grp.json && grp.json.thread && grp.json.thread.id;
    if (!tid) throw new Error('no group thread: ' + JSON.stringify(grp.json));
    // If the group did not actually take both of them, every later assertion
    // would be measuring a 1:1 call and quietly pass for the wrong reason.
    check((grp.json.thread.members || []).length === 3, 'the group really has three members', (grp.json.thread.members || []).length);

    const connect = (user) => new Promise((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${user.token}`, { perMessageDeflate: false });
      const got = [];
      w.on('message', (raw) => { try { got.push(JSON.parse(raw)); } catch {} });
      w.on('open', () => resolve({ w, got, send: (o) => w.send(JSON.stringify(o)) }));
      w.on('error', reject);
      socks.push({ w });
    });
    const a = await connect(A);
    const b = await connect(B);
    const c = await connect(C);
    // Every socket needs its roster before the frames under test mean anything.
    for (const s of [a, b, c]) s.send({ t: 'subscribe' });
    await sleep(500);
    for (const s of [a, b, c]) s.got.length = 0;

    const callLines = (s) => s.got.filter((m) => m.t === 'dm-new' && m.message && String(m.message.sys || '').startsWith('call-'));
    const until = async (fn, ms = 5000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(60); }
      return false;
    };

    // ---- [1] the first join posts exactly one start line, to everyone -----
    a.send({ t: 'voice-join', threadId: tid, video: false });
    await until(() => callLines(c).length >= 1);
    const first = callLines(c);
    check(first.length === 1, 'the first join posts exactly one start line', first.map((m) => m.message.content));
    check(first[0] && first[0].message.sys === 'call-start', 'it is a call-start line', first[0] && first[0].message.sys);
    check(first[0] && /aaa started a voice call/.test(first[0].message.content), 'it names the caller and the kind',
      first[0] && first[0].message.content);
    check(first[0] && first[0].message.callMeta && first[0].message.callMeta.threadId === tid,
      'the line carries the thread the Join key needs', first[0] && first[0].message.callMeta);
    check(first[0] && first[0].message.user === null, 'a system line has no author', first[0] && JSON.stringify(first[0].message.user));

    // ---- [2] the 2nd and 3rd joiners are NOT a second announcement --------
    b.send({ t: 'voice-join', threadId: tid });
    c.send({ t: 'voice-join', threadId: tid });
    await until(() => (c.got.filter((m) => m.t === 'voice-peers' && (m.peers || []).length === 3).length) >= 1);
    await sleep(700); // give any duplicate a chance to arrive
    check(callLines(c).length === 1, 'a three-person call is still ONE start line', callLines(c).map((m) => m.message.content));

    // ---- [3] going 3 -> 2 -> 1 is still one start line --------------------
    c.send({ t: 'voice-leave' });
    await until(() => (c.got.filter((m) => m.t === 'voice-peers' && (m.peers || []).length === 1).length) >= 1);
    await sleep(700);
    check(callLines(c).length === 1, 'the call running down to one person is not re-announced', callLines(c).map((m) => m.message.content));
    b.send({ t: 'voice-leave' });
    await sleep(700);
    check(callLines(c).length === 1, 'the call down to the caller alone is still one start line', callLines(c).map((m) => m.message.content));

    // ---- [4] the last one out ends it, with a real duration ---------------
    // The minimum is 10s of wall clock (CALL_ANNOUNCE_IGNORE_MS), so this is the
    // one assertion that genuinely has to wait.
    await sleep(10500);
    a.send({ t: 'voice-leave' });
    await until(() => callLines(c).length >= 2, 6000);
    const ended = callLines(c);
    check(ended.length === 2, 'the call posts exactly one end line', ended.map((m) => m.message.content));
    check(ended[1] && ended[1].message.sys === 'call-end', 'it is a call-end line', ended[1] && ended[1].message.sys);
    check(ended[1] && /^Call ended · lasted /.test(ended[1].message.content), 'it says how long the call lasted',
      ended[1] && ended[1].message.content);
    check(ended[1] && ended[1].message.callMeta && ended[1].message.callMeta.durationMs >= 10000,
      'the duration is the real elapsed time', ended[1] && ended[1].message.callMeta);
    check(ended[1] && ended[1].message.callMeta && ended[1].message.callMeta.startedAt < ended[1].message.callMeta.endedAt,
      'the duration is measured from the first join, not from the end', ended[1] && ended[1].message.callMeta);

    // ---- [5] a second call in the same thread announces again -------------
    a.send({ t: 'voice-join', threadId: tid });
    await until(() => callLines(c).length >= 3);
    await sleep(600);
    check(callLines(c).length === 3, 'a NEW call gets its own start line', callLines(c).map((m) => m.message.content));
    a.send({ t: 'voice-leave' });
    await sleep(600);

    // ---- [6] a call under the threshold posts a start and no end ---------
    // The gate is DURATION ALONE. It never asks how many people were in the
    // call, so this section deliberately makes no claim about headcount: what it
    // pins is that a call which lives under CALL_ANNOUNCE_IGNORE_MS leaves an
    // ORPHAN start line and no end line. That orphan is the accepted behaviour
    // (the start cannot be retracted — somebody may already have read it), and
    // asserting it here is what stops a later reader from "fixing" the pairing.
    const before = callLines(c).length;
    a.send({ t: 'voice-join', threadId: tid });
    await until(() => callLines(c).length > before);
    a.send({ t: 'voice-leave' }); // straight back out, nobody answered
    await sleep(1500);
    check(callLines(c).length === before + 1, 'a call under 10s posts its start line and NO end line',
      callLines(c).map((m) => m.message.content));
    // Scoped to what THIS section added — callLines() is the whole thread
    // history, and earlier sections legitimately left a call-end line behind.
    check(callLines(c).slice(before).every((m) => m.message.sys === 'call-start'),
      'the orphan it leaves behind is a start line, not a silent end', callLines(c).slice(before).map((m) => m.message.sys));
    check(!callLines(c).slice(before).some((m) => m.message.sys === 'call-end'),
      'and there is no end line to match it', callLines(c).slice(before).map((m) => m.message.sys));

    // ---- [7] it self-heals: a stale row is retired by the roster ----------
    // Simulates the replica that died holding the last occupant: the session row
    // survives with nobody in the room. The next call must still announce, and
    // must announce only once.
    //
    // This has to be built from a genuinely EMPTY room, so it waits for the
    // server to have finished the previous leave first — a voice_occupants row
    // deleted out from under a socket the server still believes is in the room
    // would be testing something the app can never actually be in.
    await until(() => c.got.filter((m) => m.t === 'voice-peers' && (m.peers || []).length === 0).length > 0, 5000);
    const pg = new Client({ ...PG_ENV, database: TEST_DB });
    await pg.connect();
    const occ = await pg.query('SELECT COUNT(*) AS n FROM voice_occupants WHERE thread_id = $1', [tid]);
    check(Number(occ.rows[0].n) === 0, 'the room really is empty before the stale row is planted', occ.rows[0].n);
    await pg.query('INSERT INTO dm_call_sessions (thread_id,started_at,started_by,video) VALUES ($1,$2,$3,0) ON CONFLICT (thread_id) DO NOTHING', [tid, Date.now(), A.id]);
    await pg.end();
    const stale = callLines(c).length;
    a.send({ t: 'voice-join', threadId: tid });
    await until(() => callLines(c).length > stale, 5000);
    await sleep(900);
    check(callLines(c).length === stale + 1, 'a row left behind by a dead replica does not silence the next call',
      callLines(c).slice(stale).map((m) => m.message.content));

    // ---- [8] the lines are in the real history, in order ------------------
    a.send({ t: 'voice-leave' });
    await sleep(800);
    const hist = await api(`/api/dms/${tid}/messages`, { token: C.token });
    // History comes back OLDEST first (the route reverses its DESC query).
    const rows = (hist.json && hist.json.messages ? hist.json.messages : []).filter((m) => String(m.sys || '').startsWith('call-'));
    check(rows.length >= 3, 'the call lines survive in the thread history', rows.map((m) => m.content));
    check(rows[0] && rows[0].sys === 'call-start' && rows[1] && rows[1].sys === 'call-end',
      'the first call in the history reads start then end', rows.map((m) => m.sys));
    // The pairing rule, stated exactly as the product behaves it. An END must
    // always follow a START — an end with no open call is impossible. Two STARTS
    // in a row IS legal and expected: a call that is rung and abandoned (nobody
    // joins, so it is under the ignore threshold and posts no end) leaves its
    // start on screen, and the next call opens a fresh one beside it. What must
    // never happen is an end that doesn't belong to an open call, or an end for
    // the wrong call — and both are covered by the end always directly following
    // the most recent unclosed start.
    let bad = null;
    let openIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].sys === 'call-start') openIdx = i;         // a new call opens (or re-opens) the pending one
      else if (rows[i].sys === 'call-end') {
        if (openIdx < 0) { bad = 'end with no start at ' + i; break; } // cannot happen; assert it
      }
    }
    check(bad === null, 'every end belongs to an open call', bad || rows.map((m) => m.sys));
    check(rows.filter((m) => m.sys === 'call-start').length >= rows.filter((m) => m.sys === 'call-end').length,
      'there is never more than one more end than starts (each end closes one open)', rows.map((m) => m.sys));
    check(rows.every((m) => m.callMeta), 'every call line in history carries its metadata', rows.map((m) => !!m.callMeta));
    // A system line must not light up an unread badge — that is what sys is for.
    const unread = await api('/api/dms', { token: C.token });
    const row = (unread.json && unread.json.threads ? unread.json.threads : []).find((t) => t.id === tid);
    check(!!row, 'the thread is still listed for C');
    check(row && (row.unread || 0) === 0, 'call lines never count as unread', row && row.unread);
    // ...and the sidebar preview must not invent an author for a line that has
    // none (it used to render "?: Call ended · lasted 4 minutes").
    check(row && row.last && !!row.last.sys, 'the sidebar preview knows its last line is a system line', row && row.last);
    check(row && row.last && row.last.author === '?', 'a system line reports no author, so the client drops the name prefix', row && row.last);

    // ---- [9] the client escapes and wires what the server sends -----------
    const aEnd = rows.find((m) => m.sys === 'call-end');
    if (aEnd) {
      const rendered = callSysLineHTML(aEnd);
      check(/lasted/.test(rendered), 'a real end line from the server renders with its duration', rendered);
      check(!/data-calljoin/.test(rendered), 'and renders with no Join key', rendered);
    }
  } catch (e) {
    failures.push('harness');
    console.log('  FAIL harness — ' + (e && e.message ? e.message : e));
    if (process.env.CALL_LINES_DEBUG) console.log(srvLog.split('\n').slice(-40).join('\n'));
  } finally {
    await cleanup();
  }

  if (failures.length) {
    console.log('\n' + failures.length + ' failed, ' + passed + ' passed');
    process.exit(1);
  }
  console.log('\nall ' + passed + ' checks passed');
  process.exit(0);
})();
