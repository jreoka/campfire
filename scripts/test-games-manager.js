// Games tab / game-activity manager — server routes (see AGENTS.md
// verification conventions).
//
// The complaint that started this: a game deleted under Settings → Games never
// came back, and the tab offered no way to manage games at all. Two things
// caused it. The UI was one "Tracking / Ignored" pill over an invisible list,
// and ignored names were only ever rendered when the game still had a stats
// row — so an ignored game whose playtime had been removed had no row
// anywhere, which made it impossible to un-ignore and it stayed silently
// untracked forever.
//
// This boots a real server against a throwaway database and asserts the whole
// manager:
//   - the payload Settings → Games renders (totals, per-game level + streak,
//     live game, ignored names),
//   - ignore / un-ignore one game by name, including a game with no stats,
//   - an ignored game with no stats stays listed, and "Track again" clears it,
//   - removing playtime leaves detection (and the ignore state) alone,
//   - a watcher beacon re-tracks the game after all of that,
//   - "remove all playtime" keeps the ignore list, "track all again" clears it,
//   - names are validated and every route is authed.
//
// Requirements: Postgres reachable (docker compose up -d db).
// Skips (exit 0) with a message when it isn't.
//
// Usage: node scripts/test-games-manager.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_games_test';
const PORT = parseInt(process.env.TEST_PORT || '3431', 10);

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

async function waitForHttp(p, ms) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); if (r.ok) return true; } catch {}
    if (Date.now() - t0 > ms) return false;
    await sleep(250);
  }
}

const dayAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-gm-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });

  let child = null;
  let db = null;
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
        JWT_SECRET: 'test-games-secret',
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

    console.log('\n[1] two accounts, and a game with real playtime on one of them');
    const reg = async (n) => {
      const r = await api('POST', '/api/register', { body: { username: n, displayName: n.toUpperCase(), password: 'passw0rd!x' } });
      if (!(r.status === 200 && r.data.token)) throw new Error('register ' + n + ' failed: ' + JSON.stringify(r.data));
      return r.data.token;
    };
    const tokA = await reg('gamesa'), tokB = await reg('gamesb');
    db = new Client({ ...pg, database: TEST_DB });
    await db.connect();
    const uid = (await db.query("SELECT id FROM users WHERE username = 'gamesa'")).rows[0].id;
    // Cached "no artwork" rows keep the tab's Steam lookups off the network.
    await db.query(`INSERT INTO game_icons (game, url, updated_at) VALUES ('apex legends', NULL, $1), ('not a real game', NULL, $1)
      ON CONFLICT(game) DO UPDATE SET url = NULL, updated_at = excluded.updated_at`, [Date.now()]);
    const now = Date.now();
    await db.query('INSERT INTO user_games (user_id, game, total_ms, first_seen_ms, last_seen_ms) VALUES ($1, $2, $3, $4, $4)', [uid, 'Minecraft', 7200000, now]);
    await db.query('INSERT INTO game_days (user_id, game, day, ms) VALUES ($1, $2, $3, 3600000), ($1, $2, $4, 3600000)', [uid, 'Minecraft', dayAgo(0), dayAgo(1)]);
    await db.query("UPDATE users SET playing_game = 'Minecraft' WHERE id = $1", [uid]);

    console.log('\n[2] the manager payload (Settings → Games renders this)');
    let r = await api('GET', '/api/me/games', { token: tokA });
    check(r.status === 200, 'GET /api/me/games answers', r.status);
    let mc = (r.data.games || []).find((g) => g.game === 'Minecraft');
    check(!!mc, 'the tracked game is listed', r.data.games);
    check(mc && mc.total_ms === 7200000 && mc.level === 2, '2h of playtime → Lv 2', mc);
    check(mc && mc.streak === 2 && mc.best_streak === 2, 'today + yesterday → a 2-day streak (per game)', mc);
    check(mc && mc.excluded === false && 'icon_url' in mc, 'the row carries its ignore state and artwork slot', mc);
    check(r.data.total_ms === 7200000 && r.data.level === 2 && r.data.streak === 2, 'account totals match', r.data);
    check(r.data.now_playing === 'Minecraft', 'the live game rides along (drives the "Playing now" chip)', r.data.now_playing);
    check(r.data.last_seen_ms > 0 && !(r.data.ignored || []).length, 'last-played stamp set, nothing ignored yet', r.data);
    const other = await api('GET', '/api/me/games', { token: tokB });
    check(other.data.games.length === 0 && other.data.total_ms === 0 && other.data.now_playing === null, 'another account sees nothing of it', other.data);

    console.log('\n[3] ignore / un-ignore the game that is running');
    r = await api('POST', '/api/me/games/Minecraft/ignore', { token: tokA });
    check(r.status === 200 && r.data.exclusions.includes('Minecraft'), 'ignoring stores the name', r.data.exclusions);
    mc = (r.data.games || []).find((g) => g.game === 'Minecraft');
    check(mc && mc.excluded === true, 'the row still ships (so the tab can offer Track again)', mc);
    check(r.data.now_playing === null, 'ignoring the game being played drops the live status at once', r.data.now_playing);
    check((await db.query('SELECT playing_game FROM users WHERE id = $1', [uid])).rows[0].playing_game === null, 'and the stored status is cleared too');
    r = await api('POST', '/api/me/games/Minecraft/track', { token: tokA });
    check(r.status === 200 && r.data.exclusions.length === 0 && r.data.games[0].excluded === false, 'Track again clears the ignore', r.data.exclusions);
    check(r.data.now_playing === null, 'un-ignoring does not fake a live status — the next beacon owns that');

    console.log('\n[4] an ignored game that has no playtime at all');
    r = await api('POST', `/api/me/games/${encodeURIComponent('Apex Legends')}/ignore`, { token: tokA });
    check(r.status === 200 && r.data.exclusions.includes('Apex Legends'), 'ignoring a game with no stats works', r.data.exclusions);
    check(!r.data.games.some((g) => g.game === 'Apex Legends'), 'it is not in the tracked list (it has no stats)');
    const ig = (r.data.ignored || []).find((g) => g.game === 'Apex Legends');
    check(!!ig, 'but it IS listed as ignored — the escape hatch the old tab never had', r.data.ignored);
    check(ig && 'icon_url' in ig, 'the ignored row resolves artwork like a tracked one', ig);

    console.log('\n[5] the exact bug report: ignored, then playtime removed');
    r = await api('POST', '/api/me/games/Minecraft/ignore', { token: tokA });
    check(r.status === 200, 'Minecraft ignored again');
    r = await api('DELETE', '/api/me/games/Minecraft', { token: tokA });
    check(r.status === 200 && !r.data.games.some((g) => g.game === 'Minecraft'), 'its playtime is gone', r.data.games);
    check(r.data.ignored.some((g) => g.game === 'Minecraft'), 'and it is STILL listed as ignored (old code: no row anywhere → unreachable)', r.data.ignored);
    check(r.data.exclusions.includes('Minecraft'), 'the ignore state itself is untouched by removing playtime', r.data.exclusions);
    r = await api('POST', '/api/me/games/Minecraft/track', { token: tokA });
    check(!r.data.exclusions.includes('Minecraft') && !r.data.ignored.some((g) => g.game === 'Minecraft'), 'Track again brings it back', r.data);
    check(r.data.games.length === 0, 'with no stats yet — it is just first in line for detection again');

    console.log('\n[6] detection re-tracks it (no stats needed to come back)');
    const t0 = Date.now();
    r = await api('POST', '/api/watcher/status', { token: tokA, body: { game: 'Minecraft', ts: t0, tz: 0 } });
    check(r.status === 200 && r.data.playing_game === 'Minecraft', 'a watcher beacon picks the game back up', r.data);
    r = await api('POST', '/api/watcher/status', { token: tokA, body: { game: 'Minecraft', ts: t0 + 60000, tz: 0 } });
    check(r.status === 200, 'a second beacon credits the elapsed minute', r.status);
    r = await api('GET', '/api/me/games', { token: tokA });
    mc = (r.data.games || []).find((g) => g.game === 'Minecraft');
    check(!!mc && mc.total_ms >= 60000, 'the game is re-created with fresh playtime', mc);
    check(r.data.now_playing === 'Minecraft', 'and reads as live again', r.data.now_playing);

    console.log('\n[7] "remove all playtime" keeps the ignore list and detection');
    await api('POST', `/api/me/games/${encodeURIComponent('Apex Legends')}/ignore`, { token: tokA });
    r = await api('DELETE', '/api/me/games', { token: tokA });
    check(r.status === 200 && (r.data.games || []).length === 0 && r.data.total_ms === 0, 'every stats row is gone', r.data);
    check(r.data.exclusions.includes('Apex Legends'), 'the ignore list survives the wipe', r.data.exclusions);
    check(r.data.now_playing === 'Minecraft', 'detection is untouched — the game is still running', r.data.now_playing);
    r = await api('DELETE', '/api/me/games', { token: tokA });
    check(r.status === 200 && (r.data.games || []).length === 0, 'wiping an empty account is harmless', r.status);

    console.log('\n[8] "track all again" clears the ignore list');
    r = await api('DELETE', '/api/me/games/ignored', { token: tokA });
    check(r.status === 200 && r.data.exclusions.length === 0 && (r.data.ignored || []).length === 0, 'every ignored game is back in line', r.data);
    r = await api('DELETE', '/api/me/games/ignored', { token: tokA });
    check(r.status === 200 && r.data.exclusions.length === 0, 'running it with nothing ignored is a no-op', r.status);

    console.log('\n[9] names are validated, routes are authed');
    r = await api('POST', '/api/me/games/a/ignore', { token: tokA });
    check(r.status === 400 && r.data.error === 'bad_game', 'a one-character name is refused', r.data);
    r = await api('POST', '/api/me/games/' + encodeURIComponent('bad/name') + '/ignore', { token: tokA });
    check(r.status === 400, 'a name with a slash is refused', r.status);
    r = await api('POST', '/api/me/games/' + encodeURIComponent('x'.repeat(80)) + '/track', { token: tokA });
    check(r.status === 400, 'an over-long name is refused', r.status);
    check((await api('GET', '/api/me/games')).status === 401, 'no token on read → 401');
    check((await api('POST', '/api/me/games/Minecraft/ignore')).status === 401, 'no token on ignore → 401');
    check((await api('POST', '/api/me/games/Minecraft/track')).status === 401, 'no token on track → 401');
    check((await api('DELETE', '/api/me/games')).status === 401, 'no token on remove-all → 401');
    check((await api('DELETE', '/api/me/games/ignored')).status === 401, 'no token on track-all → 401');
    check((await api('DELETE', '/api/me/games/Minecraft')).status === 401, 'no token on remove-one → 401');
    const bAfter = await api('GET', '/api/me/games', { token: tokB });
    check(bAfter.data.exclusions.length === 0 && bAfter.data.games.length === 0, 'nothing leaked to the other account', bAfter.data);

    console.log('\n[10] the profile card still uses the same streak math');
    await db.query('INSERT INTO user_games (user_id, game, total_ms, first_seen_ms, last_seen_ms) VALUES ($1, $2, 7200000, $3, $3)', [uid, 'Minecraft', Date.now()]);
    await db.query('INSERT INTO game_days (user_id, game, day, ms) VALUES ($1, $2, $3, 3600000), ($1, $2, $4, 3600000)', [uid, 'Minecraft', dayAgo(0), dayAgo(1)]);
    r = await api('GET', '/api/me/gaming', { token: tokA });
    check(r.status === 200 && r.data.level === 2 && r.data.streak === 2, 'profile totals still carry level + streak', r.data);
    check(r.data.games[0] && r.data.games[0].streak === 2 && r.data.games[0].best_streak === 2, 'and the per-game card too', r.data.games[0]);
    r = await api('GET', '/api/users/gamesa/gaming', { token: tokB });
    check(r.data.games[0] && r.data.games[0].streak === 2, 'reading someone else\u2019s profile agrees', r.data.games[0]);

    console.log('\n' + (failures.length ? failures.length + ' FAILED, ' + passed + ' passed' : 'all ' + passed + ' checks passed'));
    try { await db.end(); } catch {}
    try { child.kill(); } catch {}
    await dropTestDb(pg);
    process.exit(failures.length ? 1 : 0);
  } catch (err) {
    console.error('\n[test] ERROR: ' + ((err && err.message) || err));
    try { await db && db.end(); } catch {}
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
