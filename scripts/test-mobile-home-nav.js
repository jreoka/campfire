// The mobile nav page and the campfire Home button (see AGENTS.md).
//
// The complaint: on a phone the nav page (server rail + chat list) closed the
// moment the campfire Home button was tapped, and the tap dropped the reader
// straight back into the conversation that had been open behind the page — the
// one thing Home exists to get you out of. Home only swaps the chat list over
// to the home lists (Friends / Stories / DMs), so the page has to stay up for a
// conversation to be picked out of it.
//
// A second half of the same complaint: Home clears the open conversation only
// after its two roster refreshes came back, so the previous DM stayed painted
// under the closed page until the network answered (indefinitely on a bad
// connection). The clear has to be synchronous.
//
// Drives the REAL page in headless Chrome at a phone viewport against a
// throwaway database (real touch events for the tap itself).
//
// Skips (exit 0) when Postgres or Chrome is unavailable.
//
// Usage: node scripts/test-mobile-home-nav.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_mobile_home_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3429', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9346', 10);

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-mobile-home-'));
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
        JWT_SECRET: 'test-mobile-home-secret',
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

    const register = async (username, displayName) => {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, displayName, password: 'passw0rd!x' }),
      });
      const d = await r.json();
      if (!d.token) throw new Error('register failed: ' + JSON.stringify(d));
      return d;
    };
    const me = await register('mainuser', 'Main');
    const pally = await register('pally', 'Pally');

    // ---- Chrome + CDP ----
    const profile = path.join(tmp, 'chrome');
    chrome = spawn(chromePath, [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
      '--window-size=420,900', 'about:blank',
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
    const phone = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 3, mobile: true });
    const shot = async (name) => {
      try {
        const r = await send('Page.captureScreenshot', { format: 'png' });
        const p = path.join(os.tmpdir(), name);
        fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
        return p;
      } catch { return null; }
    };
    // A real touch tap on an element's centre (the page's own handlers run).
    const touchTap = async (selector) => {
      const c = await evaluate(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y }] });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(120);
      return c;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await phone(390, 844);
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    if (!(await waitFor(`typeof boot === 'function'`))) return fail('the app never loaded');
    await evaluate(`(() => { localStorage.setItem('cf_token', ${JSON.stringify(me.token)}); localStorage.setItem('cf_sid', ${JSON.stringify(me.sid)}); return 1; })()`);
    await send('Page.reload');
    if (!(await waitFor(`S.me && S.me.username === 'mainuser'`))) return fail('boots signed in');

    console.log('\n[1] a DM is open, then the mobile nav page');
    const setup = await evaluate(`(async () => {
      const t = await api('/api/dms', { method: 'POST', body: JSON.stringify({ userId: ${JSON.stringify(pally.user.id)} }) });
      await refreshDms();
      await openHome();
      await selectDmThread(t.thread.id);
      const s = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: 'Studio' }) });
      await refreshServers(s.server.id);
      if (S.ws) S.ws.send(JSON.stringify({ t: 'subscribe' }));
      await selectServer(s.server.id);
      return { tid: t.thread.id, sid: s.server.id, cid: S.channelId };
    })()`);
    check(!!setup.cid, 'a server channel and a 1:1 DM exist', setup);
    // Back into the DM — the conversation the complaint says Home fails to leave.
    await evaluate(`(async () => { await openHome(); await selectDmThread(${JSON.stringify(setup.tid)}); })()`);
    const dmOpen = await evaluate(`({ view: S.view, dm: S.dmThreadId, name: document.querySelector('#chan-name').textContent })`);
    check(dmOpen.view === 'home' && dmOpen.dm === setup.tid, 'the DM is the open conversation', dmOpen);

    await touchTap('#btn-menu');
    await sleep(350);
    const navOpen = await evaluate(`(() => {
      const l = document.querySelector('#left').getBoundingClientRect();
      return { open: document.body.classList.contains('nav-open'), covers: l.left <= 0 && l.width >= innerWidth - 1,
        where: document.elementFromPoint(innerWidth / 2, innerHeight / 2) ? document.elementFromPoint(innerWidth / 2, innerHeight / 2).closest('#left') ? 'left' : 'chat' : 'none' };
    })()`);
    check(navOpen.open && navOpen.covers, 'the nav page is the whole screen', navOpen);
    check(navOpen.where === 'left', 'the chat behind it is unreachable', navOpen);

    console.log('\n[2] the campfire Home button keeps the page open');
    const before = await evaluate(`(() => { const b = document.querySelector('#btn-home').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: before.x, y: before.y }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(120);
    const afterTap = await evaluate(`({ navOpen: document.body.classList.contains('nav-open'),
      open: document.querySelector('#left').getBoundingClientRect().left, dm: S.dmThreadId, view: S.view })`);
    check(afterTap.navOpen, 'tapping Home does not close the page', afterTap);
    check(afterTap.open <= 0, 'the page is still slid in', afterTap);
    check(afterTap.view === 'home' && afterTap.dm === null, 'it does land on Home (no conversation selected)', afterTap);

    console.log('\n[3] no conversation stays painted behind the page');
    // Home's clear must be synchronous: the tap revealed the previous DM to the
    // reader while the roster refreshes were still in flight.
    await evaluate(`(async () => { await selectDmThread(${JSON.stringify(setup.tid)}); document.body.classList.add('nav-open'); })()`);
    await sleep(250);
    const sameTask = await evaluate(`(() => {
      document.querySelector('#btn-home').click();
      return {
        navOpen: document.body.classList.contains('nav-open'),
        dm: S.dmThreadId,
        messagesHidden: document.querySelector('#messages').classList.contains('hidden'),
        friendsHidden: document.querySelector('#friends-page').classList.contains('hidden'),
        chanName: document.querySelector('#chan-name').textContent,
      };
    })()`);
    check(sameTask.navOpen, 'the click handler alone already keeps the page up', sameTask);
    check(sameTask.dm === null && sameTask.messagesHidden && !sameTask.friendsHidden,
      'and the chat area is already the Friends page, not the DM it was', sameTask);

    console.log('\n[4] Home from inside a server keeps the page up, with the DM list in it');
    await evaluate(`(async () => { await selectServer(${JSON.stringify(setup.sid)}); })()`);
    await sleep(200);
    await evaluate(`document.body.classList.add('nav-open')`);
    await sleep(250);
    const fromServer = await evaluate(`(() => {
      const sidebar = document.querySelector('#sidebar');
      return { serverUi: !document.querySelector('#server-ui').classList.contains('hidden'), dmRows: document.querySelectorAll('#dm-list .dmrow').length };
    })()`);
    check(fromServer.serverUi === true && fromServer.dmRows === 1, 'the page shows the server channels to start', fromServer);
    await touchTap('#btn-home');
    await sleep(300);
    const homePanel = await evaluate(`(() => {
      const row = document.querySelector('#dm-list .dmrow');
      const b = row && row.getBoundingClientRect();
      const hit = b ? document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) : null;
      return {
        navOpen: document.body.classList.contains('nav-open'),
        serverUi: !document.querySelector('#server-ui').classList.contains('hidden'),
        homeUi: !document.querySelector('#home-ui').classList.contains('hidden'),
        dmRows: document.querySelectorAll('#dm-list .dmrow').length,
        dmReachable: !!(hit && hit.closest('#dm-list .dmrow')),
        pan: document.body.className,
      };
    })()`);
    check(homePanel.navOpen, 'the page is still open', homePanel);
    check(!homePanel.serverUi && homePanel.homeUi && homePanel.dmRows === 1, 'the chat list switched to the home lists', homePanel);
    check(homePanel.dmReachable, 'a DM row is right there to pick', homePanel);
    const openShot = await shot('mobile-home-nav-open.png');

    console.log('\n[5] picking a DM from the kept-open page still works');
    await touchTap('#dm-list .dmrow');
    await sleep(350);
    const picked = await evaluate(`({ navOpen: document.body.classList.contains('nav-open'), dm: S.dmThreadId,
      inPanel: document.querySelector('#messages').classList.contains('hidden') })`);
    check(!picked.navOpen, 'picking a conversation closes the page', picked);
    check(picked.dm === setup.tid && !picked.inPanel, 'and opens that DM', picked);
    await shot('mobile-home-nav-dm.png');

    console.log('\n[6] the page still closes from its own ✕');
    await touchTap('#btn-menu');
    await sleep(300);
    check(await evaluate(`document.body.classList.contains('nav-open')`), 'the page opens again', null);
    await touchTap('#btn-nav-close');
    await sleep(300);
    check(!(await evaluate(`document.body.classList.contains('nav-open')`)), 'and the ✕ closes it', null);

    const realErrors = pageErrors.filter((e) => e && !/favicon|Failed to load resource/i.test(e));
    check(realErrors.length === 0, 'no page exceptions', realErrors.slice(0, 3));
    if (openShot) console.log('\n[test] screenshots: ' + openShot);
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
