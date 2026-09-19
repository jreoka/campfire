// Editing a message, end-to-end in a real browser (see AGENTS.md verification
// conventions).
//
// The complaint: "when editing a message the save and cancel buttons don't
// appear to do anything until you refresh the page and find the save button
// worked apparently". scripts/test-message-edit.js proves the client's decisions
// in isolation; this one proves the whole page behaves, through the real UI:
// the message menu's Edit row, the box's own Save/Cancel buttons, a PATCH that
// reaches the server — and, the part nobody could see before, a WITNESS tab
// whose copy of the message repaints when the edit is broadcast.
//
// Boots a real server against a throwaway database, drives Chrome over the
// DevTools protocol (no puppeteer — plain CDP over ws).
//
// Skips (exit 0) when Postgres or Chrome is unavailable.
//
// Usage: node scripts/test-message-edit-browser.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_edit_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3421', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9337', 10);

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

// One CDP page: the same send/evaluate/waitFor trio the other browser tests use.
async function openPage(wsUrl) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
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
      await sleep(150);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  return { ws, send, evaluate, waitFor, pageErrors, close: () => { try { ws.close(); } catch {} } };
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  const envFile = readEnvFile();
  const pg = {
    host: process.env.PGHOST || envFile.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || envFile.PGPORT || '5432', 10),
    user: process.env.PGUSER || envFile.POSTGRES_USER || 'campfire',
    password: process.env.PGPASSWORD || envFile.POSTGRES_PASSWORD || '',
  };
  const admin = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
  try { await admin.connect(); }
  catch (e) { return skip('Postgres unreachable (' + ((e && e.message) || e) + ') — docker compose up -d db'); }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-edit-e2e-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });

  let child = null, chrome = null;
  const pages = [];
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
        JWT_SECRET: 'test-edit-secret',
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

    const newPage = async () => {
      const t = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
      const p = await openPage(t.webSocketDebuggerUrl);
      pages.push(p);
      return p;
    };

    // ---- the edit side ----
    const A = await newPage();
    await A.evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    check(!!(await A.waitFor(`typeof boot === 'function'`)), 'the app loads');
    const reg = await A.evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'editor', displayName: 'Editor', password: 'passw0rd!x' }) });
      const d = await r.json();
      store.token = d.token; store.sid = d.sid;
      return { ok: !!d.token };
    })()`);
    check(!!reg.ok, 'registered an account');
    await A.send('Page.reload');
    check(!!(await A.waitFor(`S.me && S.me.username === 'editor'`)), 'boots signed in');

    const srv = await A.evaluate(`(async () => {
      const r = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: 'Edit Lab' }) });
      await refreshServers(r.server.id);
      if (S.ws) S.ws.send(JSON.stringify({ t: 'subscribe' }));
      await selectServer(r.server.id);
      return { sid: r.server.id, cid: S.channelId };
    })()`);
    check(!!srv.cid, 'a channel is open', srv);

    // ---- a witness page, signed in as the same account, showing the same row:
    // the reader on the other end of the edit. Two tabs of one account is
    // deliberate (no second signup needed) and proves the same thing: this page
    // cached the OLD text and has to repaint when the edit is broadcast.
    const B = await newPage();
    await B.evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    check(!!(await B.waitFor(`S.me && S.me.username === 'editor'`)), 'the witness tab boots signed in');
    check(!!(await B.waitFor(`S.channelId === ${JSON.stringify(srv.cid)}`)), 'and lands in the same channel');
    await B.waitFor(`document.querySelector('#messages .msg[data-mid]') !== null`, 8000);

    console.log('\n[1] post a message and open its Edit box through the real menu');
    await A.evaluate(`sendChat('original text')`);
    const mid = await A.waitFor(`(() => { const n = [...document.querySelectorAll('#messages .msg[data-mid]')]; return n.length ? n[n.length - 1].dataset.mid : null })()`, 8000);
    check(!!mid, 'the message is on screen', mid);
    check(!!(await B.waitFor(`!!document.querySelector('#messages .msg[data-mid="${mid}"]')`, 8000)), 'and in the witness tab');
    const opened = await A.evaluate(`(() => {
      messageCtxMenu(${JSON.stringify(mid)}, 120, 120);
      const item = [...document.querySelectorAll('#ctx-menu button')].find((b) => /Edit message/.test(b.textContent || ''));
      if (!item) return { found: false };
      item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return { found: true, box: !!document.querySelector('#edit-area') };
    })()`);
    check(opened.found && opened.box, 'the message menu\'s Edit opens the box', opened);
    check(await A.waitFor(`document.activeElement && document.activeElement.id === 'edit-area'`, 4000), 'with the caret in it');

    console.log('\n[2] Save acts on the spot, before the server has answered');
    const saved = await A.evaluate(`(() => {
      const t = document.querySelector('#edit-area');
      t.value = 'edited text';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      const btn = document.querySelector('[data-act="edit-save"]');
      if (!btn) return { clicked: false };
      // Synchronous on purpose: this is the reported symptom. Save has to close
      // the box and paint the new words in the same tick it is pressed — the
      // PATCH is still in flight here.
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      const node = document.querySelector('#messages .msg[data-mid="${mid}"]');
      const box = document.querySelector('#edit-area');
      return {
        clicked: true,
        boxGone: !box,
        text: node ? (node.querySelector('.text') ? node.querySelector('.text').textContent.trim() : '') : null,
        editedMark: node ? /\\(edited\\)/.test(node.textContent) : false,
        editing: S.editing,
      };
    })()`);
    check(saved.clicked, 'the Save button exists', saved);
    check(saved.boxGone === true, 'the edit box is gone the moment Save is pressed', saved);
    check(saved.text === 'edited text', 'and the message already shows what was typed', saved);
    check(saved.editedMark === true, 'with the (edited) marker', saved);
    check(saved.editing === null, 'S.editing is cleared, so nothing can re-open it', saved);

    console.log('\n[3] a Cancel after Save changes nothing (the reported dead-button order)');
    const afterCancel = await A.evaluate(`(() => {
      cancelEdit();
      const node = document.querySelector('#messages .msg[data-mid="${mid}"]');
      const t = node && node.querySelector('.text');
      return { box: !!document.querySelector('#edit-area'), text: t ? t.textContent.trim() : null };
    })()`);
    check(!afterCancel.box && afterCancel.text === 'edited text', 'no box, no reverted text', afterCancel);

    console.log('\n[4] the edit reaches the server, and the witness tab repaints');
    const stored = await A.waitFor(`(async () => {
      const r = await api('/api/messages/${mid}');
      return r && r.message && r.message.content === 'edited text' && r.message.edited === true ? r.message.content : null;
    })()`, 8000);
    check(stored === 'edited text', 'the stored message is the edited one, marked edited', stored);
    const witness = await B.waitFor(`(() => {
      const n = document.querySelector('#messages .msg[data-mid="${mid}"]');
      const t = n && n.querySelector('.text');
      return t && t.textContent.trim() === 'edited text' ? t.textContent.trim() : null;
    })()`, 8000);
    check(witness === 'edited text', 'the other tab showing the same message repaints with the new words', witness);

    console.log('\n[5] Cancel really does abandon an edit');
    const cancelled = await A.evaluate(`(() => {
      startEdit(${JSON.stringify(mid)});
      const t = document.querySelector('#edit-area');
      t.value = 'thrown away';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      const btn = document.querySelector('[data-act="edit-cancel"]');
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      const node = document.querySelector('#messages .msg[data-mid="${mid}"]');
      return { boxGone: !document.querySelector('#edit-area'), text: node.querySelector('.text').textContent.trim(), editing: S.editing };
    })()`);
    check(cancelled.boxGone && cancelled.editing === null, 'Cancel closes the box', cancelled);
    check(cancelled.text === 'edited text', 'and leaves the message exactly as it was', cancelled);
    await sleep(600);
    const stillStored = await A.evaluate(`(async () => (await api('/api/messages/${mid}')).message.content)()`);
    check(stillStored === 'edited text', 'nothing was PATCHed by the cancelled edit', stillStored);

    console.log('\n[6] Enter in the box saves it too (the keyboard path)');
    const viaEnter = await A.evaluate(`(async () => {
      startEdit(${JSON.stringify(mid)});
      const t = document.querySelector('#edit-area');
      t.value = 'saved with enter';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const node = document.querySelector('#messages .msg[data-mid="${mid}"]');
      return { boxGone: !document.querySelector('#edit-area'), text: node.querySelector('.text').textContent.trim() };
    })()`);
    check(viaEnter.boxGone === true && viaEnter.text === 'saved with enter', 'Enter saves and paints like the button', viaEnter);
    const entered = await A.waitFor(`(async () => ((await api('/api/messages/${mid}')).message.content === 'saved with enter') || null)()`, 8000);
    check(!!entered, 'and the server has it', entered);

    check(A.pageErrors.length === 0, 'no uncaught page errors (editor)', A.pageErrors.slice(0, 3));
    check(B.pageErrors.length === 0, 'no uncaught page errors (witness)', B.pageErrors.slice(0, 3));
    if (A.pageErrors.length) console.log('  page errors: ' + JSON.stringify(A.pageErrors.slice(0, 5)));
  } finally {
    for (const p of pages) { try { p.close(); } catch {} }
    try { chrome && chrome.kill(); } catch {}
    try { child && child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => '  - ' + f).join('\n')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('[test] crashed:', (e && e.message) || e); process.exit(1); });
