// Cards that say "Processing" after a missed verdict push (see AGENTS.md
// verification conventions).
//
// A verdict reaches the reader as a LIVE push (message-updated / dm-updated).
// The push is gone forever if the socket was down when it fired — a deploy
// restarts the app, a phone loses signal, a laptop sleeps — and the page's own
// cached copy is left holding a card the server has long since settled. (Since
// uploads are served as they land and a verdict is a background judgement, the
// card can only come from a copy that never heard the push — which is why the
// browser half of this test manufactures exactly that state rather than waiting
// for a slow scanner to produce one.)
//
// The client's answer is a TARGETED resync on the two moments pushes were
// missed: a socket reconnect (socket.js) and a foregrounded tab (final.js). It
// asks the server about exactly the messages still showing a scanning card and
// patches them where they stand — the list itself is deliberately never
// refetched, because that would cost the reader their place in the conversation.
//
// [1] the route it asks with — GET /api/dms/messages/:mid, the DM twin of the
//     server-message route that already existed — including that it will not
//     answer a stranger (404, like its neighbours, so ids cannot be probed).
// [2] the whole thing in a real browser: a real upload posted over the page's own
//     socket, its cached copy rolled back to the stale scanning state, the socket
//     CLOSED (so the repair cannot be pushed either) — and then ONE reconnect
//     flipping it, with no reload and no refetch of the conversation.
//
// Needs Postgres (docker compose up -d db) and Chrome/Edge; skips (exit 0)
// without either.
//
// Usage: node scripts/test-media-resync.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');
const fake = require(path.join(__dirname, 'fake-clamd'));

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_media_resync';
const PORT = parseInt(process.env.TEST_PORT || '3415', 10);
const DAEMON_PORT = parseInt(process.env.TEST_CLAMAV_PORT || '3416', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9349', 10);
// Long enough that the socket is closed well before the verdict, short enough
// that the test does not sit around waiting for it.
const SCAN_DELAY_MS = 7000;

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
async function api(method, p, body, token) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await res.json(); } catch {}
  return { status: res.status, data: j };
}
async function uploadFile(filePath, name, mime, token) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(filePath)], { type: mime }), name);
  const res = await fetch(`http://127.0.0.1:${PORT}/api/upload`, {
    method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('upload -> ' + res.status + ' ' + JSON.stringify(j));
  return j;
}
function connectWs(token) {
  return new Promise((resolve, reject) => {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
    ws.on('error', reject);
    ws.on('message', (raw) => { try { events.push(JSON.parse(raw.toString())); } catch {} });
    ws.on('open', () => resolve({
      events,
      send: (o) => ws.send(JSON.stringify(o)),
      close: () => { try { ws.close(); } catch {} },
    }));
  });
}
async function waitFor(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch {}
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(200);
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-resync-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  const note1 = path.join(tmp, 'first-upload.txt');
  const note2 = path.join(tmp, 'second-upload.txt');
  fs.writeFileSync(note1, 'the file whose verdict nobody was told about\n');
  fs.writeFileSync(note2, 'and the one the reader is looking at\n');

  let child = null, chrome = null, cdp = null, daemon = null, db = null;
  let serverLog = '';
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();

    // The stand-in engine: it answers every scan, slowly, so the pending state
    // is long enough to close a socket inside.
    process.env.FAKE_CLAMAV_DELAY_MS = String(SCAN_DELAY_MS);
    daemon = await fake.start({ port: DAEMON_PORT });

    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        PGHOST: pg.host, PGPORT: String(pg.port), PGUSER: pg.user, PGPASSWORD: pg.password, PGDATABASE: TEST_DB,
        JWT_SECRET: 'test-media-resync-secret',
        UPLOAD_DIR: uploads,
        VIRUS_SCAN: '1',
        MEDIA_COMPRESS: '0', // the scan alone is the work: a .txt has nothing to encode
        CLAMAV_HOST: '127.0.0.1',
        CLAMAV_PORT: String(daemon.port),
        UNFURL: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    const fail = (msg) => { throw new Error(msg + '\n--- server log ---\n' + serverLog.slice(-4000)); };
    if (!(await waitForHttp('/api/config', 30000))) return fail('server did not come up');

    const reg = async (username) => (await api('POST', '/api/register', { username, password: 'test1234', displayName: username })).data;
    const a = await reg('resynca');
    const b = await reg('resyncb');
    const stranger = await reg('resyncc');
    const dm = (await api('POST', '/api/dms', { userId: b.user.id }, a.token)).data.thread;
    db = new Client({ ...pg, database: TEST_DB });
    await db.connect();
    const scanRow = async (key) => (await db.query('SELECT status FROM file_scans WHERE key = $1', [key])).rows[0] || null;

    // ---------- [1] the route the resync asks with ----------
    console.log('\n[1] GET /api/dms/messages/:mid — the DM twin the resync needs');
    const conn = await connectWs(a.token);
    await waitFor(() => conn.events.some((e) => e.t === 'hello'), 5000);
    const up1 = await uploadFile(note1, 'first-upload.txt', 'text/plain', a.token);
    const key1 = up1.url.split('?')[0].replace('/uploads/', '');
    conn.send({ t: 'dm', threadId: dm.id, content: '', attachments: [{ url: up1.url, name: up1.name, mime: up1.mime, size: up1.size, kind: up1.kind }], replyTo: null });
    const created = await waitFor(() => conn.events.find((e) => e.t === 'dm-new'), 8000);
    check(!!created, 'a DM message with a scanning attachment exists', created && created.message && created.message.id);
    const mid = created && created.message.id;

    let r = await api('GET', `/api/dms/messages/${mid}`, undefined, a.token);
    check(r.status === 200 && r.data && r.data.message && r.data.message.id === mid, 'a member re-reads it by id', { status: r.status });
    check(!!r.data && r.data.message.threadId === dm.id, 'and it comes back on its thread', r.data && r.data.message.threadId);
    const atts = (r.data && r.data.message && r.data.message.attachments) || [];
    check(atts.length === 1 && ['pending', 'clean'].includes(atts[0].scan), 'carrying the attachment\'s CURRENT scan state', atts.map((x) => x.scan));
    check(r.data.message.attachments[0].id && r.data.message.attachments[0].id === (created.message.attachments[0] || {}).id,
      'with the attachment id the client patches by', r.data.message.attachments[0].id);
    r = await api('GET', `/api/dms/messages/${mid}`, undefined, stranger.token);
    check(r.status === 404, 'a stranger gets 404 — the route cannot be used to probe ids', r.status);
    r = await api('GET', '/api/dms/messages/does-not-exist', undefined, a.token);
    check(r.status === 404, 'an unknown id is a 404 too', r.status);
    r = await api('GET', `/api/dms/messages/${mid}`);
    check(r.status === 401, 'and it needs a session', r.status);

    // Let the first verdict land before the browser opens, so the only scanning
    // card on screen is the one this test is about.
    const firstClean = await waitFor(async () => { const r2 = await scanRow(key1); return r2 && r2.status === 'clean'; }, 30000);
    check(!!firstClean, 'the first upload is judged (so the browser opens on a settled conversation)');
    conn.close();

    // ---------- [2] the browser: a missed push, and one reconnect ----------
    console.log('\n[2] a verdict that landed while the socket was down');
    chrome = spawn(chromePath, [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(tmp, 'chrome')}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
      '--window-size=1280,900', 'about:blank',
    ], { stdio: 'ignore' });
    let ver = null;
    for (let i = 0; i < 80 && !ver; i++) {
      try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch {}
      if (!ver) await sleep(250);
    }
    if (!ver) return fail('Chrome did not expose the DevTools port');
    const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    cdp = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { cdp.once('open', res); cdp.once('error', rej); });
    let msgId = 0;
    const pending = new Map();
    // Page exceptions, collected off the protocol rather than window.onerror: a
    // thrown error inside the app's own handlers is exactly the kind that would
    // otherwise leave the card stuck with nothing to see.
    const pageErrors = [];
    cdp.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push((m.params && m.params.exceptionDetails && m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description)
          || (m.params && m.params.exceptionDetails && m.params.exceptionDetails.text) || 'exception');
      }
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
      }
    });
    const send = (method, params = {}) => new Promise((res, rej) => {
      const i = ++msgId;
      pending.set(i, { res, rej });
      cdp.send(JSON.stringify({ id: i, method, params }));
    });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const waitForPage = async (expr, ms = 15000) => {
      const t0 = Date.now();
      for (;;) {
        try { const v = await evaluate(`(() => { try { return ${expr} } catch (e) { return false } })()`); if (v) return v; } catch {}
        if (Date.now() - t0 > ms) return null;
        await sleep(150);
      }
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    if (!(await waitForPage(`typeof boot === 'function'`))) return fail('the app never loaded');
    await evaluate(`(() => { localStorage.setItem('cf_token', ${JSON.stringify(a.token)}); localStorage.setItem('cf_sid', ${JSON.stringify(a.sid)}); return 1; })()`);
    await send('Page.reload');
    const booted = await waitForPage(`S.me && S.me.username === ${JSON.stringify(a.user.username)}`, 25000);
    if (!booted) {
      const diag = await evaluate(`({
        token: (localStorage.getItem('cf_token') || '').slice(0, 10),
        sid: !!localStorage.getItem('cf_sid'),
        me: !!S.me,
        mainShown: !document.getElementById('view-main').classList.contains('hidden'),
        authShown: !document.getElementById('view-auth').classList.contains('hidden'),
        overlay: !!document.querySelector('#conn-overlay') && !document.querySelector('#conn-overlay').classList.contains('hidden'),
      })`);
      return fail('boots signed in: ' + JSON.stringify(diag) + ' exceptions=' + JSON.stringify(pageErrors.slice(0, 3)));
    }
    // Open the DM. The app's own boot restore is still settling when a scripted
    // open runs this soon after `booted` (it lands on Home with no conversation
    // and closes one that was opened first), so re-open until it sticks rather
    // than racing it — this is a harness race, not something a reader can hit.
    let opened = null;
    for (let i = 0; i < 20 && !opened; i++) {
      await evaluate(`(async () => { await refreshDms(); await openHome(); await selectDmThread(${JSON.stringify(dm.id)}); return 1; })()`);
      opened = await waitForPage(`S.dmThreadId === ${JSON.stringify(dm.id)}`, 1200);
    }
    check(!!opened, 'the conversation is the one on screen',
      await evaluate(`({ thread: S.dmThreadId, view: S.view, dms: (S.dms || []).length, ids: (S.dms || []).map((d) => d.id).slice(0, 4) })`));
    check(await waitForPage(`!!document.querySelector('#messages .msg[data-mid="' + ${JSON.stringify(mid)} + '"]')`),
      'the settled conversation is on screen, its first upload rendered as the real file',
      await evaluate(`({ dom: document.querySelectorAll('#messages .msg').length, scanning: document.querySelectorAll('#messages .scan-block.scanning').length })`));

    // The second upload: posted over the PAGE's own socket, so this is the app's
    // real path. It is final the moment it lands (there is no scanning card on
    // the upload path any more — see virus-scan.js), so the STALE card this test
    // is about is manufactured where it actually comes from in the wild: the
    // page's own cached copy of a message whose verdict push it never heard. That
    // is the state a dropped socket, a sleeping laptop or a deploy leaves behind,
    // and it is exactly what the resync has to repair.
    const up2 = await uploadFile(note2, 'second-upload.txt', 'text/plain', a.token);
    const key2 = up2.url.split('?')[0].replace('/uploads/', '');
    const att2 = { url: up2.url, name: up2.name, mime: up2.mime, size: up2.size, kind: up2.kind };
    const sent = await evaluate(`(async () => {
      const before = (S.dmMessages.get(${JSON.stringify(dm.id)}) || []).length;
      S.ws.send(JSON.stringify({ t: 'dm', threadId: ${JSON.stringify(dm.id)}, content: '', attachments: [${JSON.stringify(att2)}], replyTo: null }));
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        const arr = S.dmMessages.get(${JSON.stringify(dm.id)}) || [];
        if (arr.length > before) return arr[arr.length - 1];
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    })()`);
    check(!!sent, 'the second upload is posted and cached', sent && sent.id);
    const mid2 = sent && sent.id;
    const att2Id = sent && sent.attachments && sent.attachments[0] && sent.attachments[0].id;
    check(await waitForPage(`!!document.querySelector('#messages .att-slot[data-att-slot="' + ${JSON.stringify(att2Id)} + '"]')`),
      'it renders as the real file the moment it lands');
    const card = `document.querySelector('#messages .scan-block.scanning[data-att-id="' + ${JSON.stringify(att2Id)} + '"]')`;

    // Roll the page's copy back to the stale state, and re-render: what a reader
    // is left looking at when the verdict's push never arrived.
    const staled = await evaluate(`(() => {
      const m = (S.dmMessages.get(${JSON.stringify(dm.id)}) || []).find((x) => x.id === ${JSON.stringify(mid2)});
      if (!m || !m.attachments || !m.attachments[0]) return false;
      m.attachments[0].scan = 'pending';
      renderDmMessages();
      return true;
    })()`);
    check(staled === true, 'the page is left holding a stale scanning card');
    check(await waitForPage(`!!${card}`), 'it renders as a "Processing file" card', att2Id);

    // Now the missed push: close the socket and stop it reconnecting, exactly
    // like a tab whose connection dropped across the verdict.
    await evaluate(`(() => { try { S.ws.onclose = null; S.ws.onmessage = null; S.ws.close(); } catch {} return 1; })()`);
    const down = await waitForPage(`!S.ws || S.ws.readyState !== 1`);
    check(!!down, 'the socket is down (so nothing can be pushed to this page)');

    const serverNow = await api('GET', `/api/dms/messages/${mid2}`, undefined, a.token);
    const serverAtt = serverNow.data && serverNow.data.message && serverNow.data.message.attachments[0];
    check(!!serverAtt && serverAtt.scan === 'clean', 'the server holds the verdict the page never heard', serverAtt && serverAtt.scan);
    check(await evaluate(`!!${card}`), 'and the card is STILL saying Processing — the push it needed is gone');
    check(await evaluate(`S.dmMessages.get(${JSON.stringify(dm.id)}).find((m) => m.id === ${JSON.stringify(mid2)}).attachments[0].scan === 'pending'`),
      'the page\'s own copy of the message is stale too');

    // One reconnect. This is the whole fix: the reopen handler re-reads the
    // durable state it missed.
    await evaluate(`(() => {
      window.__apiCalls = [];
      const real = window.api;
      window.api = (p, o) => { window.__apiCalls.push(p); return real(p, o); };
      connectWS();
      return 1;
    })()`);
    const flipped = await waitForPage(`!!document.querySelector('#messages .att-slot[data-att-slot="' + ${JSON.stringify(att2Id)} + '"]')`, 15000);
    check(!!flipped, 'the reconnect flips the card to the real file', await evaluate(`document.querySelectorAll('#messages .scan-block.scanning').length`));
    check(await waitForPage(`!(${card})`), 'and the Processing card is gone');
    check(await evaluate(`S.dmMessages.get(${JSON.stringify(dm.id)}).find((m) => m.id === ${JSON.stringify(mid2)}).attachments[0].scan === 'clean'`),
      'the page\'s copy is fresh again, so a later render agrees');
    const called = await evaluate(`window.__apiCalls.slice()`);
    check(called.includes('/api/dms/messages/' + mid2), 'it asked the server about exactly that message', called);
    check(await evaluate(`document.querySelectorAll('#messages .msg').length > 0`), 'and the conversation is still the same one on screen');

    // The no-op path: with nothing pending, the resync must cost no request at
    // all (it runs on every reconnect and every foregrounding).
    const idle = await evaluate(`(async () => {
      window.__apiCalls = [];
      await resyncPendingMedia();
      return window.__apiCalls.slice();
    })()`);
    check(Array.isArray(idle) && idle.length === 0, 'with nothing pending it makes no request at all', idle);

    check(pageErrors.length === 0, 'no page exceptions along the way', pageErrors.slice(0, 3));
  } catch (e) {
    console.error('[test] ' + ((e && e.stack) || e));
    process.exit(1);
  } finally {
    try { cdp && cdp.close(); } catch {}
    try { chrome && chrome.kill(); } catch {}
    try { child && child.kill(); } catch {}
    try { daemon && daemon.close(); } catch {}
    try { db && await db.end(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
}

main().catch((e) => { console.error('[test] ' + ((e && e.stack) || e)); process.exit(1); });
