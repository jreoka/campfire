// Pin button badge, end-to-end in a real browser (see AGENTS.md).
//
// The complaint: the pin icon wore a purple count of the conversation's pins
// that never went away, so it read as unread notifications that could not be
// cleared. scripts/test-pin-badge.js checks the store's semantics in isolation;
// this one proves the page behaves: pinning something yourself does not badge,
// a pin from someone else does (across a reload), opening the panel clears it,
// and it stays cleared after another reload.
//
// Boots a real server against a throwaway database, drives Chrome over the
// DevTools protocol (no puppeteer — plain CDP over ws). A second account joins
// by invite and pins over plain HTTP, so no second browser is needed.
//
// Skips (exit 0) when Postgres or Chrome is unavailable.
//
// Usage: node scripts/test-pin-badge-browser.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_pinbadge_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3426', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9343', 10);

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-pinbadge-e2e-'));
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
        JWT_SECRET: 'test-pinbadge-secret',
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
    // The badge as the user sees it: null when hidden, else the number.
    const badge = () => evaluate(`(() => { const b = document.querySelector('#pins-count'); return b && !b.classList.contains('hidden') ? b.textContent : null; })()`);
    const badgeIs = (want) => waitFor(`(() => { const b = document.querySelector('#pins-count'); const v = b && !b.classList.contains('hidden') ? b.textContent : null; return v === ${JSON.stringify(want)}; })()`, 8000);
    // No unseen pins = the pill is hidden, not "0": wait for it to go away.
    const badgeGone = () => waitFor(`(() => { const b = document.querySelector('#pins-count'); return !b || b.classList.contains('hidden'); })()`, 8000);
    const openConv = (sid, cid) => evaluate(`(async () => {
      await refreshServers(${JSON.stringify(sid)});
      await selectServer(${JSON.stringify(sid)});
      if (S.channelId !== ${JSON.stringify(cid)}) await selectChannel(${JSON.stringify(cid)});
      return S.channelId;
    })()`);
    const sendMsg = async (text) => {
      await evaluate(`(() => { const i = document.querySelector('#in-message'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#composer').requestSubmit(); })()`);
      const found = await waitFor(`!!(S.messages.get(S.channelId) || []).find((m) => m.content === ${JSON.stringify(text)})`, 10000);
      return found ? evaluate(`(S.messages.get(S.channelId) || []).find((m) => m.content === ${JSON.stringify(text)}).id`) : null;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    check(!!(await waitFor(`typeof boot === 'function'`)), 'the app loads');

    console.log('\n[1] sign in, make a server, post two messages');
    const a = await evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pinner', displayName: 'Pinner', password: 'passw0rd!x' }) });
      const d = await r.json();
      store.token = d.token; store.sid = d.sid;
      return { uid: d.user.id };
    })()`);
    await send('Page.reload');
    check(!!(await waitFor(`S.me && S.me.username === 'pinner'`)), 'boots signed in');
    const srv = await evaluate(`(async () => {
      const r = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: 'Pin Lab' }) });
      await refreshServers(r.server.id);
      if (S.ws) S.ws.send(JSON.stringify({ t: 'subscribe' }));
      await selectServer(r.server.id);
      return { sid: r.server.id, cid: S.channelId };
    })()`);
    check(!!srv.cid, 'a channel is open', srv);
    const mid1 = await sendMsg('the first thing worth pinning');
    const mid2 = await sendMsg('the second thing worth pinning');
    check(!!mid1 && !!mid2, 'two messages posted', { mid1, mid2 });

    console.log('\n[2] pinning something myself does not badge');
    await evaluate(`togglePin(${JSON.stringify(mid1)})`);
    check(!!(await waitFor(`S.pinIds.has(${JSON.stringify(mid1)})`)), 'the pin landed');
    check((await badge()) === null, 'no badge for a pin I just made');

    console.log('\n[3] someone else pinning shows "1 new" — and it survives a reload');
    const other = await evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pinner2', displayName: 'Pinner Two', password: 'passw0rd!x' }) });
      const d = await r.json();
      const inv = await api('/api/servers/' + S.serverId + '/invites', { method: 'POST', body: JSON.stringify({}) });
      await fetch('/api/servers/join', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + d.token }, body: JSON.stringify({ inviteCode: inv.invite.code }) });
      const p = await fetch('/api/servers/' + S.serverId + '/channels/' + S.channelId + '/pins', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + d.token },
        body: JSON.stringify({ messageId: ${JSON.stringify(mid2)} }),
      });
      return { status: p.status, token: d.token };
    })()`);
    check(other.status === 200 || other.status === 201, 'the other account pinned over HTTP', other.status);
    check(await badgeIs('1'), 'the badge counts the pin I have not looked at');
    await send('Page.reload');
    check(!!(await waitFor(`S.me && S.me.username === 'pinner'`)), 'the reload signs back in');
    check(!!(await openConv(srv.sid, srv.cid)), 'and lands back in the channel');
    check(await badgeIs('1'), 'the badge is still there after the reload (it is persisted, not per-page)');

    console.log('\n[4] opening the pinned panel clears it');
    await evaluate(`openPins()`);
    check(!!(await waitFor(`!!document.querySelector('#modal-body .pins-list .pin-row')`)), 'the panel lists the pins');
    check(await badgeGone(), 'the badge is gone', await badge());
    check((await badge()) === null, 'and with nothing unseen the pill is hidden entirely');
    await evaluate(`cancelModal()`);

    console.log('\n[5] it stays cleared across another reload');
    await send('Page.reload');
    check(!!(await waitFor(`S.me && S.me.username === 'pinner'`)), 'signed in again');
    check(!!(await openConv(srv.sid, srv.cid)), 'channel reopened');
    await sleep(600); // let the pins fetch land
    check((await badge()) === null, 'no badge on the conversation I have reviewed', await badge());

    console.log('\n[6] a per-account memory, not a shared blob');
    const key = await evaluate(`Object.keys(localStorage).filter((k) => k.indexOf('cf_pinseen_') === 0)`);
    check(Array.isArray(key) && key.length === 1 && key[0] === 'cf_pinseen_' + a.uid, 'the memory lives under this account\'s key', key);

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
