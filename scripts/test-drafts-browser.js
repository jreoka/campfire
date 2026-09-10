// Composer drafts, end-to-end in a real browser (see AGENTS.md verification
// conventions).
//
// The complaint: a server deploy / auto-update reload wiped whatever was being
// typed. scripts/test-composer-drafts.js checks the store's semantics in
// isolation; this one proves the whole page behaves: type in the composer,
// reload (`location.reload()` is exactly what the auto-updater does), and the
// text is still there — in the same channel, and in DMs, while other
// conversations stay untouched and a sent message leaves no ghost draft.
//
// Boots a real server against a throwaway database, drives Chrome over the
// DevTools protocol (no puppeteer — plain CDP over ws).
//
// Skips (exit 0) when Postgres or Chrome is unavailable.
//
// Usage: node scripts/test-drafts-browser.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_drafts_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3416', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9333', 10);

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-drafts-e2e-'));
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
        JWT_SECRET: 'test-drafts-secret',
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
    const type = (text) => evaluate(`(() => { const i = document.querySelector('#in-message'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return i.value; })()`);
    // Type and reload with no gap at all: the 300ms draft debounce cannot have
    // fired, so whatever survives proves the beforeunload flush (the same path
    // a deploy's auto-update reload takes) works.
    const typeThenReload = (text) => evaluate(`(() => { const i = document.querySelector('#in-message'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); setTimeout(() => location.reload(), 0); return i.value; })()`);

    await send('Page.enable');
    await send('Runtime.enable');
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    check(!!(await waitFor(`typeof boot === 'function'`)), 'the app loads');
    check(!!(await waitFor(`!!document.querySelector('#in-message')`)), 'the composer is there');

    console.log('\n[1] sign in and open a channel');
    const reg = await evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'drafty', displayName: 'Drafty', password: 'passw0rd!x' }) });
      const d = await r.json();
      store.token = d.token; store.sid = d.sid;
      return { ok: !!d.token };
    })()`);
    check(!!reg.ok, 'registered an account');
    await send('Page.reload');
    check(!!(await waitFor(`S.me && S.me.username === 'drafty'`)), 'boots signed in');
    const srv = await evaluate(`(async () => {
      const r = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: 'Draft Lab' }) });
      await refreshServers(r.server.id);
      if (S.ws) S.ws.send(JSON.stringify({ t: 'subscribe' }));
      await selectServer(r.server.id);
      return { sid: r.server.id, cid: S.channelId };
    })()`);
    check(!!srv.cid, 'a channel is open', srv);

    console.log('\n[2] typing survives a reload (what the auto-updater does)');
    await typeThenReload('half a thought');
    check(!!(await waitFor(`S.channelId === ${JSON.stringify(srv.cid)}`)), 'the reload lands in the same channel');
    const afterReload = await waitFor(`document.querySelector('#in-message').value || null`, 8000);
    check(afterReload === 'half a thought', 'the text that was being typed is back', { afterReload });

    console.log('\n[3] conversations keep their own drafts');
    const ch2 = await evaluate(`(async () => {
      const c = await api('/api/servers/' + S.serverId + '/channels', { method: 'POST', body: JSON.stringify({ name: 'other', type: 'text' }) });
      await selectServer(S.serverId);
      await selectChannel(c.channel.id, { keepNav: true });
      return { id: c.channel.id, val: document.querySelector('#in-message').value };
    })()`);
    check(ch2.val === '', 'a channel you never typed in opens empty', ch2);
    await type('channel two text');
    await sleep(400);
    const backInOne = await evaluate(`(async () => { await selectChannel(${JSON.stringify(srv.cid)}); return document.querySelector('#in-message').value; })()`);
    check(backInOne === 'half a thought', 'switching back restores that channel\'s own text', { backInOne });
    const backInTwo = await evaluate(`(async () => { await selectChannel(${JSON.stringify(ch2.id)}); return document.querySelector('#in-message').value; })()`);
    check(backInTwo === 'channel two text', 'and the other channel kept its own', { backInTwo });

    console.log('\n[4] a sent message leaves no ghost draft');
    await type('');
    await evaluate(`document.querySelector('#composer').requestSubmit()`);
    await sleep(800);
    const dump = await evaluate(`localStorage.getItem('cf_drafts_' + S.me.id) || '{}'`);
    check(!JSON.parse(dump)[`s:${srv.sid}:${ch2.id}`], 'the draft is gone once sent', dump);

    console.log('\n[5] DM drafts');
    const dm = await evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pally', displayName: 'Pally', password: 'passw0rd!x' }) });
      const p = await r.json();
      const t = await api('/api/dms', { method: 'POST', body: JSON.stringify({ userId: p.user.id }) });
      await refreshDms();
      await openHome();
      await selectDmThread(t.thread.id);
      return { tid: t.thread.id, view: S.view };
    })()`);
    check(dm.view === 'home' && !!dm.tid, 'a DM is open', dm);
    await typeThenReload('dm half text');
    check(!!(await waitFor(`S.view === 'home' && S.dmThreadId === ${JSON.stringify(dm.tid)}`)), 'the reload reopens the same DM');
    const dmAfter = await waitFor(`document.querySelector('#in-message').value || null`, 8000);
    check(dmAfter === 'dm half text', 'the DM draft comes back too', { dmAfter });

    check(pageErrors.length === 0, 'no uncaught page errors', pageErrors.slice(0, 3));
    if (pageErrors.length) console.log('  page errors: ' + JSON.stringify(pageErrors.slice(0, 5)));
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome && chrome.kill(); } catch {}
    try { child && child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => '  - ' + f).join('\n')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('[test] crashed:', (e && e.message) || e); process.exit(1); });
