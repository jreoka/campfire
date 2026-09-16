// The DM row's message preview, end-to-end in a real browser (see AGENTS.md).
//
// The complaint: "deleting the most recent message in a dm doesnt update the
// sidebar message preview until you refresh the page".
//
// The row's sub-line is the thread's NEWEST message, and it is a SERVER
// snapshot: `/api/dms` computes `dmThreadView().last` from the database. When the
// delete removes exactly that message there is nothing local to fall back on —
// no client-side list knows which message came before the newest one (the live
// tail only holds what this tab has seen, and the thread may not even be open).
// So the row has to be re-read when `dm-deleted` lands, the way `dm-new` already
// re-reads it. It did not, so the sidebar kept quoting the deleted words (and
// kept sorting the thread by their timestamp) until a manual refresh.
//
// An edit has the same shape: the preview is a copy of the newest message's text,
// so `dm-updated` has to re-read the row too.
//
// This drives the real path end to end — the real message context menu's Delete
// item, the real websocket push, the real refreshDms()/renderDmLists() — and
// never reloads the page. Boots a real server against a throwaway database and
// drives Chrome over the DevTools protocol (no puppeteer — plain CDP over ws).
//
// Skips (exit 0) when Postgres or Chrome is unavailable.
//
// Usage: node scripts/test-dm-row-preview.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_dmrow_prev_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3462', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9362', 10);

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

  // [A] the wiring, offline: the row's preview is a server snapshot, so the two
  // frames that can invalidate it must re-read the rows.
  console.log('\n[A] the preview is a server snapshot, and both frames re-read it');
  const homeSrc = fs.readFileSync(path.join(ROOT, 'public/js/home.js'), 'utf8');
  const socketSrc = fs.readFileSync(path.join(ROOT, 'public/js/socket.js'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  // One switch case's body, bounded by the next case: a lazy regex across the
  // whole file would happily match the NEXT case's refreshDms() and call a
  // missing one wired.
  const caseBody = (name, next) => {
    const a = socketSrc.indexOf(`case '${name}': {`);
    const b = a < 0 ? -1 : socketSrc.indexOf(`case '${next}': {`, a);
    return a < 0 || b < 0 ? '' : socketSrc.slice(a, b);
  };
  const del = caseBody('dm-deleted', 'dm-reaction');
  const upd = caseBody('dm-updated', 'dm-deleted');
  check(del.length > 0 && /\brefreshDms\(\);/.test(del),
    'dm-deleted re-reads the DM rows (the deleted message is often the preview)');
  check(upd.length > 0 && /\brefreshDms\(\);/.test(upd),
    'dm-updated re-reads them too (an edit to the newest message is the preview)');
  check(/ORDER BY m\.created_at DESC LIMIT 1/.test(serverSrc),
    '/api/dms computes each thread\'s preview from the database, newest first (nothing local can stand in for it)');
  check(homeSrc.includes('${t.last.author}: ${lastText}'),
    'the row paints that snapshot (t.last) as its sub-line');

  const envFile = readEnvFile();
  const pg = {
    host: process.env.PGHOST || envFile.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || envFile.POSTGRES_USER || 'campfire',
    password: process.env.PGPASSWORD || envFile.POSTGRES_PASSWORD || '',
  };
  const admin = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
  try { await admin.connect(); }
  catch (e) {
    console.log('\n' + (failures.length ? failures.length + ' FAILED, ' + passed + ' passed' : 'all ' + passed + ' checks passed'));
    if (failures.length) process.exit(1);
    return skip('Postgres unreachable (' + ((e && e.message) || e) + ') — docker compose up -d db');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-dmrow-'));
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
        JWT_SECRET: 'test-dm-row-preview-secret',
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
        await sleep(150);
      }
    };
    // The row the user reads: "DisplayName: the newest message".
    const rowPreview = () => evaluate(`(() => {
      const r = [...document.querySelectorAll('#dm-list .dmrow')].find((x) => x.dataset.dmthread === S.dmThreadId);
      return r ? (r.querySelector('.dmlast') || {}).textContent.trim() : null;
    })()`);
    const previewIs = (want) => waitFor(`(() => {
      const r = [...document.querySelectorAll('#dm-list .dmrow')].find((x) => x.dataset.dmthread === S.dmThreadId);
      return !!r && (r.querySelector('.dmlast') || {}).textContent.trim() === ${JSON.stringify(want)};
    })()`, 8000);
    const sendDm = async (text) => {
      await evaluate(`(() => { S.ws.send(JSON.stringify({ t: 'dm', threadId: S.dmThreadId, content: ${JSON.stringify(text)}, attachments: [], replyTo: null })); return true; })()`);
      return await waitFor(`(() => { const m = (S.dmMessages.get(S.dmThreadId) || []).find((x) => x.content === ${JSON.stringify(text)}); return m ? m.id : null; })()`, 10000);
    };
    // The real user path: the message's own context menu, then its Delete row.
    const deleteViaMenu = async (mid) => {
      const clicked = await evaluate(`(() => {
        const mid = ${JSON.stringify(mid)};
        const el = document.querySelector('#messages .msg[data-mid="' + CSS.escape(mid) + '"]');
        messageCtxMenu(mid, 40, 40, el || document.querySelector('#messages'));
        const b = [...document.querySelectorAll('#ctx-menu .ctx-item')].find((x) => /Delete message/.test(x.textContent));
        if (b) b.click();
        return !!b;
      })()`);
      if (!clicked) return false;
      return !!(await waitFor(`!((S.dmMessages.get(S.dmThreadId) || []).some((x) => x.id === ${JSON.stringify(mid)}))`, 8000));
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    check(!!(await waitFor(`typeof boot === 'function'`)), 'the app loads');

    console.log('\n[1] sign in and open a DM with a second account');
    const me = await evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'dmprev', displayName: 'Dm Prev', password: 'passw0rd!x' }) });
      const d = await r.json();
      store.token = d.token; store.sid = d.sid;
      return { uid: d.user.id };
    })()`);
    await send('Page.reload');
    check(!!(await waitFor(`S.me && S.me.username === 'dmprev'`)), 'boots signed in');
    const peer = await evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'dmprev2', displayName: 'Dm Two', password: 'passw0rd!x' }) });
      const d = await r.json();
      return { uid: d.user.id };
    })()`);
    check(!!peer.uid && peer.uid !== me.uid, 'a second account exists', peer);
    const opened = await evaluate(`(async () => {
      if (S.view !== 'home') await openHome();
      await openDmWith(${JSON.stringify(peer.uid)});
      return S.dmThreadId;
    })()`);
    check(!!opened, 'the DM thread is open', opened);
    check((await rowPreview()) === 'No messages yet', 'a fresh thread reads as empty', await rowPreview());

    console.log('\n[2] the preview tracks the newest message');
    const m1 = await sendDm('the first line');
    check(!!m1, 'the first message landed');
    check(await previewIs('Dm Prev: the first line'), 'the row shows it', await rowPreview());
    const m2 = await sendDm('the second line');
    check(!!m2, 'the second message landed');
    check(await previewIs('Dm Prev: the second line'), 'the row follows the newest one', await rowPreview());

    console.log('\n[3] deleting the newest message re-reads the row (no reload)');
    check(await deleteViaMenu(m2), 'Delete message removed it (through the real menu)');
    check(await previewIs('Dm Prev: the first line'),
      'the preview falls back to the message before it, live', await rowPreview());
    // The row must agree with what a reload would show, i.e. with the server.
    const afterDelete = await evaluate(`(async () => { const { threads } = await api('/api/dms'); const t = threads.find((x) => x.id === S.dmThreadId); return t && t.last ? t.last.content : null; })()`);
    check(afterDelete === 'the first line', 'and the server names the same message', afterDelete);

    console.log('\n[4] emptying the thread reads as empty again, live');
    check(await deleteViaMenu(m1), 'the last message was deleted');
    check(await previewIs('No messages yet'), 'the preview is empty again, no reload', await rowPreview());

    console.log('\n[5] editing the newest message is the preview too');
    const m3 = await sendDm('third line');
    check(!!m3, 'a third message landed');
    check(await previewIs('Dm Prev: third line'), 'the row shows it', await rowPreview());
    // The same PATCH the composer's edit sends (pickers.js editMsg).
    await evaluate(`api('/api/dms/messages/' + ${JSON.stringify(m3)}, { method: 'PATCH', body: JSON.stringify({ content: 'third line (edited)' }) })`);
    check(await previewIs('Dm Prev: third line (edited)'), 'the row shows the edit, no reload', await rowPreview());

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
