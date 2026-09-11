// Active Now strip on a phone (see AGENTS.md).
//
// The rail lives in #members, and at <=900px that is a drawer Home never opens
// (Home hides the members button), so on a phone a friend's voice/game activity
// was simply unreachable from the Home tab. The same people are mirrored into
// the home sidebar as a horizontal scroller under Stories, above the DIRECT
// MESSAGES list. This drives the real page in headless Chrome at a phone
// viewport with injected friend data and asserts the strip is there, ordered
// under Stories, actually scrolls horizontally, carries the Join affordance for
// a reachable voice room, and stays out of the way on desktop.
//
// Skips (exit 0) when Postgres or Chrome is unavailable.
//
// Usage: node scripts/test-anow-strip.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_anow_strip_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3428', 10);
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-anow-e2e-'));
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
        JWT_SECRET: 'test-anow-strip-secret',
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
    const phone = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    const shot = async (name) => {
      try {
        const r = await send('Page.captureScreenshot', { format: 'png' });
        const p = path.join(os.tmpdir(), name);
        fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
        return p;
      } catch { return null; }
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await phone(390, 844);
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    check(!!(await waitFor(`typeof boot === 'function'`)), 'the app loads');

    console.log('\n[1] sign in and land on Home');
    await evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'anow', displayName: 'Anow', password: 'passw0rd!x' }) });
      const d = await r.json();
      store.token = d.token; store.sid = d.sid;
    })()`);
    await send('Page.reload');
    check(!!(await waitFor(`S.me && S.me.username === 'anow'`)), 'boots signed in');
    check(!!(await evaluate(`(async () => { await openHome(); return S.view === 'home'; })()`)), 'the Home tab is open');

    console.log('\n[2] the strip is under Stories and above the DM list');
    const info = await evaluate(`(async () => {
      const F = (id, name, extra) => Object.assign({ id, username: id, display_name: name, status: 'online' }, extra || {});
      S.friends = { friends: [F('u1', 'Ana'), F('u2', 'Bo'), F('u3', 'Cy'), F('u4', 'Dee'), F('u5', 'Eli'), F('u6', 'Fay')], pendingIn: [], pendingOut: [], blocked: [] };
      const online = {};
      for (const f of S.friends.friends) online[f.id] = 'online';
      S.online = online; S.presenceAll = online;
      S.friendsVoice = new Map([['u3', { kind: 'server', serverId: 's1', channelId: 'v1', joinable: true, serverName: 'Lab', channelName: 'Lobby', count: 2 }]]);
      activeGaming.clear();
      await renderActiveNow();
      const strip = document.querySelector('#anow-strip');
      const rail = document.querySelector('#anow-rail');
      const stories = document.querySelector('#btn-stories');
      const dmLabel = [...document.querySelectorAll('#home-ui .chan-group-label')].find((e) => e.textContent.trim() === 'DIRECT MESSAGES');
      const tiles = [...rail.querySelectorAll('.anow-tile')];
      const r = rail.getBoundingClientRect();
      return {
        display: getComputedStyle(strip).display,
        hidden: strip.classList.contains('hidden'),
        label: strip.querySelector('.chan-group-label').textContent.trim(),
        afterStories: strip.getBoundingClientRect().top >= stories.getBoundingClientRect().bottom,
        beforeDms: strip.getBoundingClientRect().bottom <= dmLabel.getBoundingClientRect().top,
        tiles: tiles.length,
        names: tiles.map((t) => t.querySelector('.anow-tname').textContent),
        lines: tiles.map((t) => t.querySelector('.anow-tline').textContent),
        lineCls: tiles.map((t) => t.querySelector('.anow-tline').className),
        railOverflow: getComputedStyle(rail).overflowX,
        scrolls: rail.scrollWidth > Math.ceil(r.width) + 4,
        clientWidth: r.width, scrollWidth: rail.scrollWidth,
        joinOn: tiles.filter((t) => t.querySelector('.anow-join')).map((t) => t.querySelector('.anow-tname').textContent),
        joinText: (tiles.find((t) => t.querySelector('.anow-join')) || {}).querySelector ? null : null,
        role: tiles[0] && tiles[0].getAttribute('role'),
        tabIndex: tiles[0] && tiles[0].tabIndex,
        height: Math.round(tiles[0] ? tiles[0].getBoundingClientRect().height : 0),
      };
    })()`);
    check(info.display === 'block' && !info.hidden, 'a phone shows the strip', info);
    check(info.label === 'ACTIVE NOW', 'labelled ACTIVE NOW', info.label);
    check(info.afterStories && info.beforeDms, 'it sits under Stories and above DIRECT MESSAGES', info);
    check(info.tiles === 6, 'one tile per online friend', info.tiles);
    check(info.names.join(',') === 'Cy,Ana,Bo,Dee,Eli,Fay', 'the friend in a room sorts first, then everyone by name', info.names);
    check(info.lineCls.filter((c) => c.includes('voice')).length === 1, 'the friend in voice gets the green voice line', info.lineCls);
    check(info.lines.some((l) => l === 'In Lobby'), 'with the room they are in', info.lines);
    check(info.railOverflow === 'auto' && info.scrolls, 'the row scrolls horizontally on a phone', { client: info.clientWidth, scroll: info.scrollWidth });
    check(info.joinOn.join(',') === 'Cy', 'only the reachable voice room offers Join', info.joinOn);
    check(info.role === 'button' && info.tabIndex === 0, 'a tile is a keyboard-reachable control', { role: info.role, tab: info.tabIndex });
    const phoneShot = await shot('anow-strip-phone.png');
    const drawerShot = await (async () => {
      // The strip lives in the sidebar drawer on a phone: open it for a look.
      await evaluate(`document.body.classList.add('nav-open')`);
      await sleep(250);
      return shot('anow-strip-drawer.png');
    })();

    console.log('\n[3] empty state keeps the sidebar clean');
    const cleared = await evaluate(`(async () => {
      S.friends = { friends: [], pendingIn: [], pendingOut: [], blocked: [] };
      await renderActiveNow();
      return document.querySelector('#anow-strip').classList.contains('hidden');
    })()`);
    check(cleared === true, 'no friends online → no strip at all', cleared);

    console.log('\n[4] desktop keeps the members panel (no strip)');
    await evaluate(`(async () => {
      const F = (id, name) => ({ id, username: id, display_name: name, status: 'online' });
      S.friends = { friends: [F('u1', 'Ana'), F('u2', 'Bo')], pendingIn: [], pendingOut: [], blocked: [] };
      S.online = { u1: 'online', u2: 'online' }; S.presenceAll = S.online;
      S.friendsVoice = new Map();
      await renderActiveNow();
    })()`);
    await phone(1400, 900);
    await sleep(150);
    const desktop = await evaluate(`(() => {
      const strip = document.querySelector('#anow-strip');
      return { display: getComputedStyle(strip).display, tiles: strip.querySelectorAll('.anow-tile').length, panel: document.querySelectorAll('#member-list .anow-card').length };
    })()`);
    check(desktop.display === 'none', 'the strip is hidden on desktop', desktop);
    check(desktop.panel === 2, 'the members panel is the Active Now rail there', desktop);
    await shot('anow-strip-desktop.png');

    console.log('\n[5] the strip stays fed while a DM is open');
    const dm = await evaluate(`(() => {
      S.dms = [{ id: 't1', isGroup: false, created_at: Date.now(), members: [
        { id: 'u1', username: 'u1', display_name: 'Ana' },
        { id: S.me.id, username: S.me.username, display_name: S.me.display_name },
      ] }];
      S.dmThreadId = 't1';
      renderDmMembers();
      return {
        title: document.querySelector('#members-title').textContent,
        panelRows: document.querySelectorAll('#member-list .member').length,
        tiles: document.querySelectorAll('#anow-rail .anow-tile').length,
      };
    })()`);
    check(dm.title === 'MEMBERS' && dm.panelRows === 2, 'the members panel lists the thread', dm);
    check(dm.tiles === 2, 'and the friends\' strip is still there (not the thread\'s members)', dm);

    const realErrors = pageErrors.filter((e) => e && !/favicon|Failed to load resource/i.test(e));
    check(realErrors.length === 0, 'no page exceptions', realErrors.slice(0, 3));
    if (phoneShot) console.log('\n[test] screenshots: ' + phoneShot + (drawerShot ? ', ' + drawerShot : ''));
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
