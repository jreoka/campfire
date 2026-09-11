// Group chat settings + the DM row's mobile slide-up menu, end-to-end (see
// AGENTS.md verification conventions).
//
// scripts/test-group-dm-settings.js covers the API and the wiring offline; this
// one proves the PHONE actually behaves: a long-press on a group row opens the
// slide-up sheet (never the desktop right-click popup) carrying "Edit group
// chat", the sheet's modal renames + describes the group and the open header
// follows, a 1:1 row gets Close DM but no group settings, the row text cannot
// be text-selected by the hold, and the server tag in a DM row is decorative
// (clicking it opens the conversation, never the server mini-panel).
//
// Boots a real server against a throwaway database and drives headless Chrome
// over CDP at a phone viewport with real touch events. Skips (exit 0) when
// Postgres or Chrome is unavailable.
//
// Usage: node scripts/test-group-dm-browser.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_group_dm_e2e';
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-gdm-e2e-'));
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
        JWT_SECRET: 'test-group-dm-e2e-secret',
        UPLOAD_DIR: uploads,
        UNFURL: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    const fail = (msg) => { throw new Error(msg + '\n--- server log ---\n' + serverLog.slice(-4000)); };
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${PORT}/api/config`)).ok; } catch {}
      if (!up) await sleep(250);
    }
    if (!up) return fail('server did not come up');

    console.log('\n[1] two friends (pally carries a server tag)');
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
    const api = async (method, p, token, body) => {
      const headers = { Authorization: 'Bearer ' + token };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      let data = null; try { data = await r.json(); } catch {}
      return { status: r.status, data };
    };
    // Friend request from main, accepted by pally.
    check((await api('POST', '/api/friends', me.token, { username: 'pally' })).status === 200, 'friend request sent');
    check((await api('POST', `/api/friends/${me.user.id}/accept`, pally.token)).status === 200, 'friend request accepted');
    // Pally mints a tag and activates it, so their name in the DM sidebar
    // renders one (the decorative-tag case).
    const srv = (await api('POST', '/api/servers', pally.token, { name: 'Pally Club' })).data.server;
    check((await api('PATCH', `/api/servers/${srv.id}`, pally.token, { name: 'Pally Club', tag: 'TST' })).status === 200, 'pally sets a server tag');
    const act = await api('PATCH', '/api/me', pally.token, { tagServerId: srv.id });
    check(act.status === 200 && act.data.user && act.data.user.active_tag === 'TST', 'and activates it', act.data.user && act.data.user.active_tag);

    // ---- Chrome + CDP ----
    chrome = spawn(chromePath, [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(tmp, 'chrome')}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
      '--window-size=420,900', 'about:blank',
    ], { stdio: 'ignore' });
    let ver = null;
    for (let i = 0; i < 80 && !ver; i++) {
      try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch {}
      if (!ver) await sleep(250);
    }
    if (!ver) return fail('Chrome did not expose the DevTools port');

    const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

    let msgId = 0;
    const pending = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
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
    const waitFor = async (expr, ms = 15000) => {
      const t0 = Date.now();
      for (;;) {
        try { const v = await evaluate(`(() => { try { return ${expr} } catch (e) { return false } })()`); if (v) return v; } catch {}
        if (Date.now() - t0 > ms) return null;
        await sleep(150);
      }
    };
    const screenshot = async (name) => {
      try {
        const r = await send('Page.captureScreenshot', { format: 'png' });
        const p = path.join(os.tmpdir(), name);
        fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
        return p;
      } catch { return null; }
    };
    const centerOf = (selector) => evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    })()`);
    // A real long-press: touchStart, wait past the 550ms hold, touchEnd. The
    // lift-off click must be swallowed by the page itself. The row is scrolled
    // into the middle first — the sidebar is a scroll container.
    const touchHold = async (selector) => {
      await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'center' }); })()`);
      await sleep(200);
      const c = await centerOf(selector);
      if (!c) throw new Error('no element for ' + selector);
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y }] });
      await sleep(820);
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(200);
      return c;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    // Touch emulation is what makes (hover: none) — and so isCoarse() — true.
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    if (!(await waitFor(`typeof boot === 'function'`))) return fail('the app never loaded');
    await evaluate(`(() => { localStorage.setItem('cf_token', ${JSON.stringify(me.token)}); localStorage.setItem('cf_sid', ${JSON.stringify(me.sid)}); return 1; })()`);
    await send('Page.reload');
    if (!(await waitFor(`S.me && S.me.username === 'mainuser'`))) return fail('boots signed in');
    check(await evaluate(`matchMedia('(hover: none)').matches`), 'the page sees a coarse pointer (touch emulation)');

    console.log('\n[2] group chat settings from the long-press sheet');
    const setup = await evaluate(`(async () => {
      const t = await api('/api/dms/group', { method: 'POST', body: JSON.stringify({ name: 'Roll call', userIds: [${JSON.stringify(pally.user.id)}] }) });
      await refreshDms();
      await openHome();
      await selectDmThread(t.thread.id);
      document.body.classList.add('nav-open');
      return { gid: t.thread.id };
    })()`);
    check(!!setup.gid, 'group chat created and opened', setup);
    await evaluate(`document.querySelector('#group-list .dmrow').scrollIntoView({ block: 'center' })`);
    await sleep(200);
    const hitRow = await evaluate(`(() => {
      const el = document.querySelector('#group-list .dmrow');
      const b = el.getBoundingClientRect();
      const px = Math.round(b.left + b.width / 2), py = Math.round(b.top + b.height / 2);
      const top = document.elementFromPoint(px, py);
      return { name: el.querySelector('.dmname').textContent, rect: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
        hit: !!(top && top.closest('#group-list .dmrow')), top: top ? (top.id || top.className || top.tagName) : 'none' };
    })()`);
    check(hitRow.name === 'Roll call' && hitRow.hit, 'the group row is on screen and hit-testable', hitRow);

    await touchHold('#group-list .dmrow');
    let sheet = await evaluate(`(() => {
      const sh = document.querySelector('#sheet');
      return {
        open: !!sh && sh.classList.contains('open'),
        ctx: !!document.querySelector('#ctx-menu'),
        labels: sh ? [...sh.querySelectorAll('.sheet-row')].map((r) => r.textContent.trim()) : [],
        head: sh ? (sh.querySelector('.sheet-who') || {}).textContent : '',
      };
    })()`);
    check(sheet.open, 'the long-press opens the slide-up sheet', sheet);
    check(!sheet.ctx, 'and never the desktop right-click popup', sheet);
    check(sheet.labels.some((l) => l.includes('Edit group chat')), 'the sheet offers Edit group chat', sheet.labels);
    check(sheet.head === 'Roll call', 'headed by the group name', sheet.head);
    console.log('  (wrote ' + (await screenshot('campfire-group-dm-sheet.png')) + ')');

    await evaluate(`[...document.querySelectorAll('#sheet .sheet-row')].find((r) => r.textContent.includes('Edit group chat')).click()`);
    await sleep(250);
    let modal = await evaluate(`(() => ({
      open: !document.querySelector('#modal-backdrop').classList.contains('hidden'),
      title: document.querySelector('#modal-title').textContent,
      name: (document.querySelector('#m-grp-name') || {}).value,
      desc: (document.querySelector('#m-grp-desc') || {}).value,
      sheetGone: !document.querySelector('#sheet'),
    }))()`);
    check(modal.open && modal.title === 'Group chat settings', 'the row opens the settings modal', modal);
    check(modal.name === 'Roll call' && modal.desc === '', 'prefilled with the current name and empty description', modal);
    check(modal.sheetGone, 'and the sheet closed behind it', modal);

    await evaluate(`(() => {
      document.querySelector('#m-grp-name').value = 'Saturday squad';
      document.querySelector('#m-grp-desc').value = 'Board games at 7';
      document.querySelector('#modal-ok').click();
    })()`);
    const saved = await waitFor(`(() => {
      const row = document.querySelector('#group-list .dmrow .dmname');
      return row && row.textContent === 'Saturday squad' ? {
        row: row.textContent,
        header: document.querySelector('#chan-name').textContent,
        topic: document.querySelector('#chan-topic').textContent,
        topicHidden: document.querySelector('#chan-topic').classList.contains('hidden'),
      } : null;
    })()`);
    check(!!saved, 'the sidebar row picks up the new name');
    check(!!saved && saved.header === 'Saturday squad', 'the open header follows', saved);
    check(!!saved && saved.topic === 'Board games at 7' && !saved.topicHidden, 'and the description becomes the topic line', saved);

    console.log('\n[3] a 1:1 row gets the sheet too, without group settings');
    await evaluate(`(async () => {
      const t = await api('/api/dms', { method: 'POST', body: JSON.stringify({ userId: ${JSON.stringify(pally.user.id)} }) });
      await refreshDms();
      document.body.classList.add('nav-open');
      return t.thread.id;
    })()`);
    // Give the peer a tag so the row renders one.
    const tagged = await waitFor(`(() => {
      const row = document.querySelector('#dm-list .dmrow');
      return row && row.querySelector('.usertag') ? true : false;
    })()`);
    check(!!tagged, 'the 1:1 row renders pally\'s server tag');
    await touchHold('#dm-list .dmrow');
    sheet = await evaluate(`(() => {
      const sh = document.querySelector('#sheet');
      return {
        open: !!sh && sh.classList.contains('open'),
        ctx: !!document.querySelector('#ctx-menu'),
        labels: sh ? [...sh.querySelectorAll('.sheet-row')].map((r) => r.textContent.trim()) : [],
      };
    })()`);
    check(sheet.open && !sheet.ctx, 'the 1:1 long-press opens the sheet, not the popup', sheet);
    check(sheet.labels.some((l) => l.includes('Close DM')), 'with Close DM', sheet.labels);
    check(!sheet.labels.some((l) => l.includes('Edit group chat')), 'and no group settings', sheet.labels);
    await evaluate(`document.querySelector('#sheet-backdrop').click()`);
    await sleep(300);

    console.log('\n[4] the hold cannot text-select the row');
    const selectable = await evaluate(`(() => {
      const chan = document.querySelector('#group-list .dmrow .dmname');
      const row = document.querySelector('#group-list .dmrow');
      return {
        name: getComputedStyle(chan).userSelect || getComputedStyle(chan).webkitUserSelect,
        row: getComputedStyle(row).userSelect || getComputedStyle(row).webkitUserSelect,
      };
    })()`);
    check(selectable.name === 'none' && selectable.row === 'none', 'sidebar rows opt out of text selection', selectable);
    const sel = await evaluate(`(() => { const s = String(getSelection()); return s; })()`);
    check(sel === '', 'nothing is selected after the holds', JSON.stringify(sel));

    console.log('\n[5] the tag in a DM row opens the conversation, not the server panel');
    const tagState = await evaluate(`(() => {
      const row = document.querySelector('#dm-list .dmrow');
      const tag = row.querySelector('.usertag');
      return {
        text: tag ? tag.textContent : '',
        sid: tag ? (tag.dataset.tagSid || '') : 'x',
        clickable: tag ? tag.classList.contains('clickable') : true,
        role: tag ? (tag.getAttribute('role') || '') : 'x',
      };
    })()`);
    check(tagState.text === 'TST', 'the tag is rendered', tagState);
    check(!tagState.sid && !tagState.clickable && !tagState.role, 'but as a plain pill with no click target', tagState);

    const beforeDm = await evaluate(`S.dmThreadId`);
    await evaluate(`document.querySelector('#dm-list .dmrow .usertag').click()`);
    await sleep(300);
    const afterTag = await evaluate(`({ tagcard: !document.querySelector('#tagcard').classList.contains('hidden'), dm: S.dmThreadId })`);
    check(!afterTag.tagcard, 'clicking the tag does not open the server mini-panel', afterTag);
    check(afterTag.dm !== beforeDm, 'the click falls through to the DM row and opens it', afterTag);
  } catch (e) {
    console.error('[test] ' + (e && e.stack || e));
    process.exit(1);
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome && chrome.kill(); } catch {}
    try { child && child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}
main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
