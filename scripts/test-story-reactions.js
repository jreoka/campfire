// Story quick reactions (see AGENTS.md verification conventions).
//
// A story can be reacted to from the viewer's rail: one reaction per person
// (latest wins, tapping it again takes it back), the author sees who reacted
// what under "Who watched", and everyone else only ever gets the counts — which
// float up when the story opens. This test covers the whole route:
//   - static wiring: the client's emoji set + repeat cap match the server's, the
//     rail + float lane exist in the markup, and the CSS keyframes are there,
//   - the same emoji can be tapped up to 4 times (each tap adds a copy), and a
//     tap at the cap takes all of that person's copies back,
//   - different emojis stack independently (the store is per emoji),
//   - the author's payload carries the tally and the author's own item never
//     offers a reaction,
//   - /viewers lists each viewer with the emojis they sent and how many,
//   - reacting records the view too (a reactor is never missing from the list),
//   - auth / audience / blacklist / emoji validation,
//   - the live `story-reaction` push goes to the audience (author + friends)
//     and not to strangers, carrying the full tally plus the view count.
//
// Requirements: Postgres reachable (docker compose up -d db).
// The static half always runs; the API half skips (exit 0) without Postgres.
//
// Usage: node scripts/test-story-reactions.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_story_reactions_test';
const PORT = parseInt(process.env.TEST_PORT || '3421', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) {
  console.log('[test] SKIP: ' + msg);
  console.log('\n' + (failures.length ? failures.length + ' static FAILED, ' + passed + ' passed' : 'static: all ' + passed + ' checks passed'));
  process.exit(failures.length ? 1 : 0);
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR4nGNgGAWDHjAyMDD8J1czIyMjA1KQEUwGAGZ3A0FyYw0eAAAAAElFTkSuQmCC', 'base64');

// ---------- static wiring (runs without a database) ----------
function emojiList(src, name) {
  const m = new RegExp('(?:const\\s+)?' + name + '\\s*=\\s*\\[([^\\]]*)\\]').exec(src);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}
function staticChecks() {
  console.log('\n[0] static wiring');
  const stories = fs.readFileSync(path.join(ROOT, 'public', 'js', 'stories.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const index = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const socket = fs.readFileSync(path.join(ROOT, 'public', 'js', 'socket.js'), 'utf8');

  const clientSet = emojiList(stories, 'SV_REACTIONS');
  const serverSet = emojiList(server, 'STORY_REACTIONS');
  check(!!clientSet && !!serverSet, 'both sides declare a reaction set', { clientSet, serverSet });
  check(!!clientSet && !!serverSet && clientSet.join(',') === serverSet.join(','), 'the client set matches the server allowlist', { clientSet, serverSet });
  check(!!clientSet && clientSet.length >= 4 && clientSet.length <= 8, 'the rail is a quick-pick row, not a whole emoji picker', clientSet && clientSet.length);
  const capRe = (src, name) => Number((new RegExp(name + '\\s*=\\s*(\\d+)').exec(src) || [])[1]);
  check(capRe(stories, 'SV_REACTION_MAX') === 4 && capRe(server, 'STORY_REACTION_MAX') === 4, 'the repeat cap (4) is the same on both sides', { client: capRe(stories, 'SV_REACTION_MAX'), server: capRe(server, 'STORY_REACTION_MAX') });
  check(/STORY_REACTION_SET\s*=\s*new Set\(STORY_REACTIONS\)/.test(server), 'the server validates against a Set of that allowlist');
  check(/app\.post\('\/api\/stories\/:id\/react'/.test(server), 'POST /api/stories/:id/react exists');
  check(/story_reactions/.test(server) && /CREATE TABLE IF NOT EXISTS story_reactions/.test(fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8')), 'reactions have a table (guarded migration)');
  check(/svRenderReactions/.test(stories) && /svFloatEmoji/.test(stories) && /svStartReactionBurst/.test(stories), 'the viewer paints the rail, floats a copy, and replays on open');
  check(/id="sv-react"/.test(index) && /id="sv-floats"/.test(index), 'the rail and the float lane are in the viewer markup');
  check(/@keyframes sv-float/.test(css) && /\.sv-float\{/.test(css), 'the float-up animation is styled');
  check(/prefers-reduced-motion/.test(css) && /sv-float-reduced/.test(css), 'reduced motion gets a fade instead of the long rise');
  check(/case 'story-reaction'/.test(socket) && /storyReactionPush\(m\)/.test(socket), 'the socket routes the live reaction push');
  check(/\.sv-viewer-rx/.test(css), 'a viewer row can carry the emoji they picked');
}

// ---------- API + WS ----------
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
async function api(method, p, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers, body: payload });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
let nextStart = 0;
async function connectWs(token) {
  const wait = nextStart - Date.now();
  if (wait > 0) await sleep(wait);
  nextStart = Date.now() + 250;
  return new Promise((resolve, reject) => {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
    ws.on('error', reject);
    ws.on('message', (raw) => { try { events.push(JSON.parse(raw.toString())); } catch {} });
    ws.on('open', () => { ws.send(JSON.stringify({ t: 'subscribe' })); resolve({ events, close: () => { try { ws.close(); } catch {} } }); });
  });
}
async function waitFor(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = fn(); } catch {}
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
const total = (counts, e) => ((counts || []).find((c) => c.emoji === e) || {}).count || 0;

async function main() {
  staticChecks();

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-rx-'));
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
        JWT_SECRET: 'test-story-reactions-secret',
        UPLOAD_DIR: uploads,
        VIRUS_SCAN: '0',
        UNFURL: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    const fail = (msg) => { throw new Error(msg + '\n--- server log ---\n' + serverLog.slice(-4000)); };
    if (!(await waitForHttp('/api/config', 30000))) return fail('server did not come up');

    console.log('\n[1] accounts, friendship, a posted story');
    const reg = async (n) => {
      const r = await api('POST', '/api/register', { body: { username: n, displayName: n.toUpperCase(), password: 'passw0rd!x' } });
      if (!(r.status === 200 && r.data.token)) throw new Error('register ' + n + ' failed: ' + JSON.stringify(r.data));
      return r.data;
    };
    const A = await reg('rxa'), B = await reg('rxb'), C = await reg('rxc');
    await api('POST', '/api/friends', { token: A.token, body: { username: B.user.username } });
    await api('POST', '/api/friends/' + A.user.id + '/accept', { token: B.token });

    const fd = new FormData();
    fd.append('file', new Blob([PNG], { type: 'image/png' }), 'rx.png');
    const up = await api('POST', '/api/upload', { token: A.token, form: fd });
    check(up.status === 200 && !!up.data.url, 'A uploads media', up.data && up.data.error);
    let r = await api('POST', '/api/stories', { token: A.token, body: { url: up.data.url, mime: up.data.mime, kind: 'image', caption: 'react to me', friends: true } });
    check(r.status === 200 && !!r.data.story, 'A posts a friends story', r.data && r.data.error);
    const story = r.data.story;
    check(Array.isArray(story.reactions) && story.reactions.length === 0, 'a fresh story arrives with no reactions', story.reactions);
    check(Array.isArray(story.myReactions) && story.myReactions.length === 0, 'and nothing sent by me', story.myReactions);

    console.log('\n[2] B sees it and reacts');
    r = await api('GET', '/api/stories', { token: B.token });
    let item = ((r.data.friends || []).find((t) => t.user && t.user.id === A.user.id) || { items: [] }).items[0];
    check(!!item && item.id === story.id, 'B sees the story');
    check(item.reactions.length === 0 && item.myReactions.length === 0, 'nothing lit for B yet', { c: item.reactions, m: item.myReactions });
    r = await api('POST', '/api/stories/' + story.id + '/react', { token: B.token, body: { emoji: '❤️' } });
    check(r.status === 200 && !r.data.cleared && r.data.count === 1, 'B reacts', r.data);
    check(total(r.data.reactions, '❤️') === 1 && r.data.myReactions.length === 1 && r.data.myReactions[0].emoji === '❤️' && r.data.myReactions[0].count === 1, 'one heart, lit and counted for B', r.data);
    check(r.data.views === 1, 'reacting records the view too (a reactor cannot be missing from "Who watched")', r.data.views);

    console.log('\n[3] the same emoji can be tapped up to four times, then clears');
    for (const want of [2, 3, 4]) {
      r = await api('POST', '/api/stories/' + story.id + '/react', { token: B.token, body: { emoji: '❤️' } });
      check(r.status === 200 && r.data.count === want && total(r.data.reactions, '❤️') === want, `tap ${want} adds another copy`, { c: r.data.count, t: r.data.reactions });
    }
    r = await api('POST', '/api/stories/' + story.id + '/react', { token: B.token, body: { emoji: '❤️' } });
    check(r.status === 200 && r.data.cleared === true && r.data.count === 0 && r.data.reactions.length === 0 && r.data.myReactions.length === 0, 'a tap on the maxed-out emoji takes all four back', r.data);
    r = await api('POST', '/api/stories/' + story.id + '/react', { token: B.token, body: { emoji: '❤️' } });
    check(r.status === 200 && r.data.count === 1, 'and it can be started over', r.data.count);
    // Two emojis at once: the store is per (person, emoji), not per person.
    r = await api('POST', '/api/stories/' + story.id + '/react', { token: B.token, body: { emoji: '😂' } });
    check(r.status === 200 && total(r.data.reactions, '❤️') === 1 && total(r.data.reactions, '😂') === 1, 'a second emoji stacks beside the first', r.data.reactions);

    console.log('\n[4] the author sees the tally and who sent what');
    r = await api('GET', '/api/stories', { token: A.token });
    const mine = (r.data.mine && r.data.mine.items || []).find((i) => i.id === story.id);
    check(!!mine && total(mine.reactions, '❤️') === 1 && total(mine.reactions, '😂') === 1, 'the author\'s own item carries the counts', mine && mine.reactions);
    check(mine.myReactions.length === 0, 'the author never has reactions of their own', mine.myReactions);
    r = await api('GET', '/api/stories/' + story.id + '/viewers', { token: A.token });
    check(r.status === 200 && r.data.viewers.length === 1, 'one viewer', r.data);
    check(r.data.viewers[0].id === B.user.id && r.data.viewers[0].reactions.length === 2, 'the viewer row carries the emojis they sent', r.data.viewers && r.data.viewers[0]);
    check(total(r.data.reactions, '❤️') === 1 && total(r.data.reactions, '😂') === 1, 'with an aggregate summary for the panel header', r.data.reactions);

    console.log('\n[5] validation + audience');
    r = await api('POST', '/api/stories/' + story.id + '/react', { token: B.token, body: { emoji: '💀' } });
    check(r.status === 400 && r.data.error === 'bad_emoji', 'an emoji outside the allowlist is refused', r.data);
    r = await api('POST', '/api/stories/' + story.id + '/react', { token: A.token, body: { emoji: '❤️' } });
    check(r.status === 400 && r.data.error === 'own_story', 'no reacting to your own story', r.data);
    r = await api('POST', '/api/stories/' + story.id + '/react', { token: C.token, body: { emoji: '❤️' } });
    check(r.status === 404, 'a stranger cannot react to a story they cannot see', r.data);
    r = await api('POST', '/api/stories/' + story.id + '/react', { body: { emoji: '❤️' } });
    check(r.status === 401, 'no token → 401', r.status);
    r = await api('POST', '/api/stories/nope/react', { token: B.token, body: { emoji: '❤️' } });
    check(r.status === 404, 'an unknown story → 404', r.data);

    console.log('\n[6] the live push');
    // rateOk allows 12 story actions per 10s per account; let the earlier taps
    // fall out of the window so the two sections below are not throttled.
    await sleep(10100);
    const aws = await connectWs(A.token); conns.push(aws);
    const bws = await connectWs(B.token); conns.push(bws);
    const cws = await connectWs(C.token); conns.push(cws);
    check(await waitFor(() => aws.events.some((e) => e.t === 'hello'), 5000), 'sockets are up');
    r = await api('POST', '/api/stories/' + story.id + '/react', { token: B.token, body: { emoji: '🔥' } });
    check(r.status === 200, 'B reacts again', r.data);
    const push = await waitFor(() => aws.events.find((e) => e.t === 'story-reaction'), 5000);
    check(!!push, 'the author is pushed the reaction live');
    check(push && push.storyId === story.id && push.emoji === '🔥' && push.userId === B.user.id && push.cleared === false, 'with the story, emoji and who sent it', push);
    check(push && push.count === 1, 'and how many copies that person now holds', push && push.count);
    check(push && Array.isArray(push.reactions) && total(push.reactions, '🔥') === 1, 'carrying the FULL tally (idempotent to apply, in any order)', push && push.reactions);
    check(push && typeof push.views === 'number' && push.views === 1, 'and the view count', push && push.views);
    check(!!(await waitFor(() => bws.events.find((e) => e.t === 'story-reaction'), 3000)), 'another viewer of the story hears it (that is the live float)');
    check(!cws.events.some((e) => e.t === 'story-reaction'), 'a stranger hears nothing');
    const before = aws.events.length;
    for (let i = 0; i < 3; i++) await api('POST', '/api/stories/' + story.id + '/react', { token: B.token, body: { emoji: '🔥' } });
    const maxed = await waitFor(() => aws.events.slice(before).find((e) => e.t === 'story-reaction' && e.count === 4), 5000);
    check(!!maxed && total(maxed.reactions, '🔥') === 4, 'the fourth tap is pushed with the count at the cap', maxed && maxed.reactions);
    const before2 = aws.events.length;
    await api('POST', '/api/stories/' + story.id + '/react', { token: B.token, body: { emoji: '🔥' } });
    const cleared = await waitFor(() => aws.events.slice(before2).find((e) => e.t === 'story-reaction' && e.cleared), 5000);
    check(!!cleared && cleared.count === 0 && total(cleared.reactions, '🔥') === 0, 'clearing them is pushed too (with the tally updated)', cleared);
    check(!!cleared && total(cleared.reactions, '❤️') === 1 && total(cleared.reactions, '😂') === 1, 'and only that emoji\'s copies were taken back', cleared && cleared.reactions);

    console.log('\n[7] blocked pairs, then cascade');
    const blk = await api('POST', '/api/blocks', { token: A.token, body: { userId: B.user.id } });
    check(blk.status === 200 || blk.status === 204, 'A blocks B', blk.data || blk.status);
    r = await api('POST', '/api/stories/' + story.id + '/react', { token: B.token, body: { emoji: '❤️' } });
    check(r.status === 403 || r.status === 404, 'a blocked pair cannot react to each other', { s: r.status, e: r.data && r.data.error });
    r = await api('DELETE', '/api/stories/' + story.id, { token: A.token });
    check(r.status === 200, 'A deletes the story');
    const dbc = new Client({ ...pg, database: TEST_DB });
    await dbc.connect();
    const left = await dbc.query('SELECT COUNT(*)::int AS c FROM story_reactions WHERE story_id = $1', [story.id]);
    await dbc.end();
    check(left.rows[0].c === 0, 'deleting the story cascades its reactions away', left.rows[0]);

    console.log('\n' + (failures.length ? failures.length + ' FAILED, ' + passed + ' passed' : 'all ' + passed + ' checks passed'));
    for (const c of conns) c.close();
    try { child.kill(); } catch {}
    await dropTestDb(pg);
    process.exit(failures.length ? 1 : 0);
  } catch (err) {
    console.error('\n[test] ERROR: ' + ((err && err.message) || err));
    for (const c of conns) c.close();
    try { child && child.kill(); } catch {}
    await dropTestDb(pg);
    process.exit(1);
  }
}

async function dropTestDb(pg) {
  try {
    const c = new Client({ ...pg, database: 'postgres' });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await c.end();
  } catch {}
}

main();
