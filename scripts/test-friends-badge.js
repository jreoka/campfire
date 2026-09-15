// The red request badge on Home counts INCOMING friend requests only.
//
// The bug: the Friends row in the Home sidebar painted `pendingIn + pendingOut`
// in the same red `.dm-badge` the unread surfaces use, so a request YOU sent lit
// a red number you could not clear by reading anything — it only went away when
// the other person answered. A red count means "something of yours is waiting",
// and a request you sent is waiting on somebody else (owner report). The Pending
// TAB still lists both directions and still counts both in its own label; only
// the badge is incoming-only.
//
// Drives the real page in headless Chrome against a real server, with the three
// accounts the case needs: one outgoing request, one incoming, then the incoming
// accepted. Skips (exit 0) when Postgres or Chrome is unavailable.
//
// Usage: node scripts/test-friends-badge.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_friends_badge_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3431', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9348', 10);

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-friends-badge-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });

  let child = null, chrome = null, ws = null;
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
        JWT_SECRET: 'test-friends-badge-secret',
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

    // ---- three accounts, driven through the real API ----
    const base = `http://127.0.0.1:${PORT}`;
    const account = async (username) => {
      const r = await fetch(`${base}/api/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, displayName: username, password: 'passw0rd!x' }),
      });
      const d = await r.json();
      if (!d.token) throw new Error('register failed for ' + username + ': ' + JSON.stringify(d));
      return d;
    };
    const friendReq = (token, username) => fetch(`${base}/api/friends`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ username }),
    }).then((r) => r.json());

    const me = await account('badgehost');     // the account the page is signed in as
    const fan = await account('badgefan');     // sends ME a request  → incoming
    const fri = await account('badgefri');     // I send THEM a request → outgoing
    check(!!me.token && !!fan.token && !!fri.token, 'three accounts exist');

    // ---- Chrome + CDP ----
    const profile = path.join(tmp, 'chrome');
    chrome = spawn(chromePath, [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
      '--window-size=1200,900', 'about:blank',
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

    await send('Page.enable');
    await send('Runtime.enable');
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    check(!!(await waitFor(`typeof boot === 'function'`)), 'the app loads');

    await evaluate(`(() => { store.token = ${JSON.stringify(me.token)}; store.sid = ${JSON.stringify(me.sid)}; })()`);
    await send('Page.reload');
    check(!!(await waitFor(`S.me && S.me.username === 'badgehost'`)), 'boots signed in as the host');

    // What the sidebar shows for the two directions, read together so a paint
    // that moved the count from one badge to the other cannot pass by accident.
    const badges = () => evaluate(`(async () => {
      await refreshFriends();
      S.friendTab = 'pending';
      renderFriendLists();
      const nav = document.querySelector('#friends-nav-count');
      const home = document.querySelector('#home-badge');
      const req = document.querySelector('#req-count');
      return {
        in: (S.friends.pendingIn || []).length,
        out: (S.friends.pendingOut || []).length,
        navText: nav.textContent, navHidden: nav.classList.contains('hidden'),
        homeText: home.textContent, homeHidden: home.classList.contains('hidden'),
        reqCount: req.textContent,
        rows: [...document.querySelectorAll('#friend-reqs button')].map((b) => b.textContent.trim()),
      };
    })()`);

    console.log('\n[1] an outgoing request lights nothing');
    const sent = await friendReq(me.token, 'badgefri');
    check(!!sent.ok, 'the host sent a request', sent);
    const outOnly = await badges();
    check(outOnly.out === 1 && outOnly.in === 0, 'the roster has one outgoing request and no incoming', outOnly);
    check(outOnly.navHidden && outOnly.navText === '', 'the Friends row badge stays hidden for a request I sent', outOnly);
    check(outOnly.homeHidden && outOnly.homeText === '', 'and so does the campfire button badge', outOnly);
    check(outOnly.reqCount === ' (1)', 'the Pending tab still counts it', outOnly.reqCount);
    check(outOnly.rows.join('|') === 'Cancel', 'and still lists it, with its Cancel', outOnly.rows);

    console.log('\n[2] an incoming request is what the badge is for');
    const got = await friendReq(fan.token, 'badgehost');
    check(!!got.ok, 'a second account requested the host', got);
    const inbound = await badges();
    check(inbound.in === 1 && inbound.out === 1, 'one each way', inbound);
    check(!inbound.navHidden && inbound.navText === '1', 'the Friends row badge counts the incoming one only', inbound);
    check(!inbound.homeHidden && inbound.homeText === '1', 'so does the campfire button badge', inbound);
    check(inbound.reqCount === ' (2)', 'the Pending tab label counts both', inbound.reqCount);
    check(inbound.rows.join('|') === 'Accept|Decline|Cancel', 'both directions are still listed, newest incoming first', inbound.rows);

    console.log('\n[3] answering it clears the badge');
    const accepted = await evaluate(`(async () => {
      const id = (S.friends.pendingIn || [])[0].id;
      const r = await api('/api/friends/' + encodeURIComponent(id) + '/accept', { method: 'POST' });
      return { ok: !!(r && r.ok), id };
    })()`);
    check(accepted.ok === true, 'the request was accepted', accepted);
    const done = await badges();
    check(done.in === 0 && done.out === 1, 'the incoming request is gone, the outgoing one is not', done);
    check(done.navHidden && done.navText === '', 'the Friends row badge is hidden again', done);
    check(done.homeHidden && done.homeText === '', 'and the campfire button badge with it', done);

    console.log('\n[4] the row is not painted by an unrelated roster fetch');
    // cancel the outgoing one through the row's own button, the way a user does
    const cancelled = await evaluate(`(async () => {
      const btn = [...document.querySelectorAll('#friend-reqs button')].find((b) => b.textContent.trim() === 'Cancel');
      if (!btn) return { found: false };
      btn.click();
      const t0 = performance.now();
      while (performance.now() - t0 < 8000) {
        if ((S.friends.pendingOut || []).length === 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return { found: true, out: (S.friends.pendingOut || []).length, navHidden: document.querySelector('#friends-nav-count').classList.contains('hidden') };
    })()`);
    check(cancelled.found === true, 'the outgoing request had its Cancel row', cancelled);
    check(cancelled.out === 0, 'clicking it withdrew the request', cancelled);
    check(cancelled.navHidden === true, 'and left no badge behind', cancelled);

    const realErrors = pageErrors.filter((e) => e && !/favicon|Failed to load resource/i.test(e));
    check(realErrors.length === 0, 'no page exceptions', realErrors.slice(0, 3));
  } finally {
    try { if (ws) ws.close(); } catch {}
    try { if (chrome) chrome.kill(); } catch {}
    try { if (child) child.kill(); } catch {}
    try { const c = new Client({ ...pg, database: 'postgres' }); await c.connect(); await c.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`); await c.end(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? failures.length + ' FAILED, ' + passed + ' passed' : 'all ' + passed + ' checks passed'));
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
