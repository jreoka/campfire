// Settings → Games, end-to-end in a real browser (see AGENTS.md verification
// conventions).
//
// The complaint: "I deleted Minecraft but it won't re-track, and there's no
// option to re-track or manage games." scripts/test-games-manager.js proves the
// server side (ignored games with no stats stay listed, Track again clears
// them, a beacon re-tracks). This drives the real redesigned tab and proves the
// UI actually offers those controls, in order:
//   - the summary, per-game rows, streaks and the live "Playing now" chip,
//   - the row menu → stop tracking → Ignored chip + Track again → tracked,
//   - the ignored section lists a game with no playtime at all,
//   - Track again from that section removes it,
//   - search filters rows without losing what was typed,
//   - "Track a game again" by name un-ignores anything,
//   - "Remove all playtime" wipes stats but leaves the ignore list alone,
//   - the state survives a reload.
//
// Boots a real server against a throwaway database and drives Chrome over the
// DevTools protocol (no puppeteer — plain CDP over ws).
//
// Skips (exit 0) when Postgres or Chrome is unavailable.
//
// Usage: node scripts/test-games-tab-browser.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_games_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3432', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9345', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }

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

async function main() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-games-e2e-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });

  let child = null, chrome = null, ws = null, db = null;
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
        JWT_SECRET: 'test-games-e2e-secret',
        UPLOAD_DIR: uploads,
        UNFURL: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    const fail = (msg) => { throw new Error(msg + '\n--- server log ---\n' + serverLog.slice(-3000)); };
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${PORT}/api/config`)).ok; } catch {}
      if (!up) await sleep(250);
    }
    if (!up) return fail('server did not come up');

    // ---- Chrome + CDP ----
    const profile = path.join(tmp, 'chrome');
    chrome = spawn(chromePath, [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
      '--window-size=1280,900', 'about:blank',
    ], { stdio: 'ignore' });
    let ver = null;
    for (let i = 0; i < 80 && !ver; i++) {
      try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch {}
      if (!ver) await sleep(250);
    }
    if (!ver) return fail('Chrome did not expose the DevTools port');

    const targetRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' });
    const target = await targetRes.json();
    ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

    let msgId = 0;
    const pending = new Map();
    const pageErrors = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        pageErrors.push((m.params.args || []).map((a) => a.value || a.description).join(' '));
      }
    });
    const send = (method, params = {}) => new Promise((res, rej) => {
      const i = ++msgId;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const waitFor = async (expr, ms = 20000) => {
      const t0 = Date.now();
      for (;;) {
        try { const v = await evaluate(`(() => { try { return ${expr} } catch (e) { return false } })()`); if (v) return v; } catch {}
        if (Date.now() - t0 > ms) return null;
        await sleep(200);
      }
    };
    // The tab's own DOM, as plain data (one round trip per assertion group).
    const tab = () => evaluate(`(() => {
      const box = document.querySelector('#set-games');
      const rows = (sel) => [...box.querySelectorAll(sel)].map((r) => ({
        name: r.querySelector('.set-game-name')?.textContent,
        meta: r.querySelector('.set-game-meta')?.textContent,
        chip: r.querySelector('.set-game-chip')?.textContent || null,
        btn: r.querySelector('.set-game-actions .btn')?.textContent || null,
      }));
      return {
        open: !!box && !box.classList.contains('hidden') && !!box.querySelector('.set-games-sum'),
        total: box.querySelector('.gsum-time')?.textContent || null,
        badges: [...box.querySelectorAll('.gsum-r .pf-badge')].map((b) => b.textContent),
        live: box.querySelector('.set-game-now')?.textContent || null,
        tracked: rows('.set-games-list [data-gsec="tracked"]'),
        ignored: rows('.set-games-list [data-gsec="ignored"]'),
        ignoredHead: [...box.querySelectorAll('.set-games-head h4')].some((h) => h.textContent === 'Ignored games'),
        search: box.querySelector('.set-games-search')?.value ?? null,
        emptyNotes: [...box.querySelectorAll('.set-games-empty')].filter((n) => !n.classList.contains('hidden')).map((n) => n.textContent),
      };
    })()`);
    const openTab = () => evaluate(`(async () => { openSettings('games'); return true; })()`);
    // Menu → item, exactly like a user: the row's ··· then the labelled entry.
    const clickMenu = (game, label) => evaluate(`(async () => {
      const row = [...document.querySelectorAll('#set-games [data-gname]')].find((r) => r.dataset.gname === ${JSON.stringify(game)});
      if (!row) return 'no-row';
      row.querySelector('.set-game-more').click();
      await new Promise((r) => setTimeout(r, 80));
      const item = [...document.querySelectorAll('#ctx-menu .ctx-item')].find((b) => b.textContent.includes(${JSON.stringify(label)}));
      if (!item) return 'no-item:' + [...document.querySelectorAll('#ctx-menu .ctx-item')].map((b) => b.textContent).join('|');
      item.click();
      await new Promise((r) => setTimeout(r, 600));
      return 'ok';
    })()`);
    const clickIn = (game, label) => evaluate(`(async () => {
      const row = [...document.querySelectorAll('#set-games [data-gname]')].find((r) => r.dataset.gname === ${JSON.stringify(game)});
      if (!row) return 'no-row';
      const btn = [...row.querySelectorAll('.btn')].find((b) => b.textContent === ${JSON.stringify(label)});
      if (!btn) return 'no-btn';
      btn.click();
      await new Promise((r) => setTimeout(r, 600));
      return 'ok';
    })()`);

    await send('Page.enable');
    await send('Runtime.enable');
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    check(!!(await waitFor(`typeof boot === 'function'`)), 'the app loads');

    console.log('\n[1] an account with tracked playtime');
    const reg = await evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'playa', displayName: 'Playa', password: 'passw0rd!x' }) });
      const d = await r.json();
      store.token = d.token; store.sid = d.sid;
      return { ok: !!d.token };
    })()`);
    check(!!reg.ok, 'registered an account');
    db = new Client({ ...pg, database: TEST_DB });
    await db.connect();
    const uid = (await db.query("SELECT id FROM users WHERE username = 'playa'")).rows[0].id;
    // Cached "no artwork" rows keep the tab's Steam lookups off the network.
    await db.query(`INSERT INTO game_icons (game, url, updated_at) VALUES ('apex legends', NULL, $1), ('celeste', NULL, $1)
      ON CONFLICT(game) DO UPDATE SET url = NULL, updated_at = excluded.updated_at`, [Date.now()]);
    const now = Date.now();
    await db.query('INSERT INTO user_games (user_id, game, total_ms, first_seen_ms, last_seen_ms) VALUES ($1, $2, 7200000, $3, $3)', [uid, 'Minecraft', now]);
    await db.query("UPDATE users SET playing_game = 'Minecraft' WHERE id = $1", [uid]);
    await db.query('INSERT INTO user_games (user_id, game, total_ms, first_seen_ms, last_seen_ms) VALUES ($1, $2, 3600000, $3, $3)', [uid, 'Celeste', now - 5 * 86400000]);
    await evaluate(`(() => { store.user = null; })()`);
    await send('Page.reload');

    console.log('\n[2] the tab renders the manager, not a single toggle');
    check(!!(await waitFor(`S.me && S.me.username === 'playa'`)), 'boots signed in');
    // Day rows are seeded in the PLAYER's calendar (the boot PATCH above just
    // taught the server this browser's timezone), exactly like a real streak.
    const tzMin = Number((await db.query('SELECT tz_offset FROM users WHERE id = $1', [uid])).rows[0].tz_offset) || 0;
    const lday = (n) => new Date(now - n * 86400000 + tzMin * 60000).toISOString().slice(0, 10);
    await db.query('INSERT INTO game_days (user_id, game, day, ms) VALUES ($1, $2, $3, 3600000), ($1, $2, $4, 3600000)', [uid, 'Minecraft', lday(0), lday(1)]);
    await db.query('INSERT INTO game_days (user_id, game, day, ms) VALUES ($1, $2, $3, 3600000)', [uid, 'Celeste', lday(9)]);
    await openTab();
    let t = await waitFor(`document.querySelector('#set-games .set-games-sum') && (${JSON.stringify(true)})`, 20000) && await tab();
    check(t && t.open, 'the Games pane is open', t && t.open);
    check(t && t.total === '3h', 'total playtime is summed up', t && t.total);
    check(t && t.badges.includes('Lv 3') && t.badges.includes('2-day streak'), 'level + streak ride along', t && t.badges);
    check(t && /Playing\s+Minecraft/.test(t.live || ''), 'the running game is called out', t && t.live);
    check(t && t.tracked.length === 2, 'both tracked games are listed', t && t.tracked);
    const mc = (t.tracked || []).find((r) => r.name === 'Minecraft');
    check(mc && mc.chip === 'Playing now' && mc.btn === '···', 'a live row is chipped and has its options button', mc);
    check(mc && /Lv 2 · 2h · 2-day streak/.test(mc.meta), 'the row spells out level, time and streak', mc && mc.meta);
    const ce = (t.tracked || []).find((r) => r.name === 'Celeste');
    check(ce && /best 1d/.test(ce.meta) && !ce.chip, 'a stale game shows its best streak, no chip', ce);
    check(t.tracked.every((r) => r.btn), 'every tracked row can be managed');
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const shotPath = path.join(os.tmpdir(), 'campfire-games-tab.png');
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    console.log('  (screenshot: ' + shotPath + ')');

    console.log('\n[3] stop tracking → Ignored chip → Track again');
    check((await clickMenu('Minecraft', 'Stop tracking')) === 'ok', 'the row menu offers Stop tracking');
    t = await tab();
    let mcRow = t.tracked.find((r) => r.name === 'Minecraft');
    check(mcRow && mcRow.chip === 'Ignored' && mcRow.btn === 'Track again', 'the row flips to Ignored with a way back', mcRow);
    check(!t.live, 'the live banner is gone while ignored', t.live);
    check((await clickIn('Minecraft', 'Track again')) === 'ok', 'Track again is one tap');
    t = await tab();
    mcRow = t.tracked.find((r) => r.name === 'Minecraft');
    check(mcRow && !mcRow.chip && mcRow.btn === '···', 'and the row is back to normal', mcRow);

    console.log('\n[4] an ignored game with no playtime is still on screen');
    const typed = await evaluate(`(async () => {
      const i = document.querySelector('#set-games .set-games-name');
      i.value = 'Apex Legends'; i.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('#set-games .set-games-add .btn')].find((b) => b.textContent === 'Track').click();
      await new Promise((r) => setTimeout(r, 700));
      return i.value;
    })()`);
    check(typed === '', 'tracking by name clears the input');
    // Ignore it (it has no stats, so this is the whole trap the old tab had).
    await evaluate(`(async () => {
      const r = await api('/api/me/games/' + encodeURIComponent('Apex Legends') + '/ignore', { method: 'POST' });
      gamesData = r; paintGamesTab();
      return true;
    })()`);
    t = await tab();
    check(t.ignored.length === 1 && t.ignored[0].name === 'Apex Legends', 'the ignored section lists a game with zero playtime', t.ignored);
    check(t.ignored[0].btn === 'Track again' && t.ignored[0].meta === 'Ignored · no playtime recorded', 'with its state spelled out', t.ignored[0]);
    check(t.ignoredHead, 'the section is titled Ignored games');
    check((await clickIn('Apex Legends', 'Track again')) === 'ok', 'Track again works from the ignored section');
    t = await tab();
    check(t.ignored.length === 0 && !t.ignoredHead, 'the section disappears once nothing is ignored', t.ignored);

    console.log('\n[5] search filters in place (the caret keeps its text)');
    await evaluate(`(async () => {
      const i = document.querySelector('#set-games .set-games-search');
      i.value = 'cel'; i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    let vis = await evaluate(`[...document.querySelectorAll('#set-games [data-gsec="tracked"]')].filter((r) => !r.classList.contains('hidden')).map((r) => r.dataset.gname)`);
    check(vis.length === 1 && vis[0] === 'Celeste', 'only the matching game stays visible', vis);
    vis = await evaluate(`(() => { const i = document.querySelector('#set-games .set-games-search'); i.value = 'zzz'; i.dispatchEvent(new Event('input', { bubbles: true })); return [...document.querySelectorAll('#set-games .set-games-empty')].filter((n) => !n.classList.contains('hidden')).map((n) => n.textContent); })()`);
    check(vis.length === 1 && /No tracked game matches/.test(vis[0]), 'and an honest empty note when nothing matches', vis);
    check((await tab()).search === 'zzz', 'the query survives a repaint');
    await evaluate(`(() => { const i = document.querySelector('#set-games .set-games-search'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);

    console.log('\n[6] the tab state survives a reload');
    await evaluate(`(async () => {
      await api('/api/me/games/' + encodeURIComponent('Celeste') + '/ignore', { method: 'POST' });
      return true;
    })()`);
    await evaluate(`openSettings('games')`);
    await send('Page.reload');
    check(!!(await waitFor(`S.me && S.me.username === 'playa'`)), 'still signed in after the reload');
    await openTab();
    t = await (waitFor(`document.querySelector('#set-games .set-games-sum')`, 20000).then(() => tab()));
    check(t.tracked.find((r) => r.name === 'Celeste')?.chip === 'Ignored', 'the ignored game is ignored after a reload', t.tracked);
    check(t.ignored.length === 0, 'with stats, it stays in the tracked list rather than the ignored section');

    console.log('\n[7] remove all playtime keeps the ignore list');
    await evaluate(`[...document.querySelectorAll('#set-games .danger-zone .btn')].find((b) => b.textContent === 'Remove all playtime').click()`);
    check(!!(await waitFor(`!document.querySelector('#modal-backdrop').classList.contains('hidden')`)), 'the confirm dialog opens');
    check((await evaluate(`document.querySelector('#modal-backdrop').textContent`)).includes('Remove all playtime'), 'and says what it is about to do');
    await evaluate(`document.querySelector('#modal-ok').click()`);
    await waitFor(`document.querySelector('#set-games .gsum-time') && document.querySelector('#set-games .gsum-time').textContent === '0m'`);
    t = await tab();
    check(t.total === '0m' && t.tracked.length === 0, 'every stats row is gone', { total: t.total, tracked: t.tracked });
    check(t.ignored.length === 1 && t.ignored[0].name === 'Celeste', 'but the ignored game is still listed (never silently untracked)', t.ignored);

    console.log('\n[8] nothing blew up');
    check(pageErrors.length === 0, 'no page errors while driving the tab', pageErrors.slice(0, 3));

    console.log('\n' + (failures.length ? failures.length + ' FAILED, ' + passed + ' passed' : 'all ' + passed + ' checks passed'));
    try { await db.end(); } catch {}
    try { ws.close(); } catch {}
    try { chrome.kill(); } catch {}
    try { child.kill(); } catch {}
    await dropTestDb(pg);
    process.exit(failures.length ? 1 : 0);
  } catch (err) {
    console.error('\n[test] ERROR: ' + ((err && err.message) || err));
    try { await db && db.end(); } catch {}
    try { ws && ws.close(); } catch {}
    try { chrome && chrome.kill(); } catch {}
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
