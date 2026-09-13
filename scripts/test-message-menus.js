// The message / media context menus, the reminder composer and the tabbed inbox
// (see AGENTS.md verification conventions).
//
// The features this pins down:
//  - a right-click or long-press ON a picture is about the PICTURE (Copy image,
//    Save image, Copy image link, Open image link) and never the message menu;
//  - the message menu carries Copy text, Mark unread, Bookmark message and
//    Create reminder…, plus View reactions whenever the message has any;
//  - a menu taller than the viewport gets a real scrollbar (max-height +
//    overflow-y:auto) instead of running off the screen;
//  - the phone's slide-up sheet is made TALLER by dragging its handle up (the
//    gesture, not a scrollbar) and keeps a scroll region for what still does not
//    fit;
//  - the reminder composer fans out preset times and a custom field that take
//    the choice back off each other;
//  - the bell opens an inbox with Notifications / Reminders / Bookmarks tabs and
//    a search box per tab, and a bookmark really round-trips through the server.
//
// Headless Chrome driving the REAL app against a throwaway database.
// Skips (exit 0) when Postgres or Chrome is unavailable.
//
// Usage: node scripts/test-message-menus.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_menus_test';
const PORT = parseInt(process.env.TEST_PORT || '3423', 10);
const CDP_PORT = parseInt(process.env.CDP_PORT || '9423', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }

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
function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

async function main() {
  const envFile = readEnvFile();
  const pg = {
    host: process.env.PGHOST || envFile.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || envFile.POSTGRES_USER || 'campfire',
    password: process.env.PGPASSWORD || envFile.POSTGRES_PASSWORD || '',
  };
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  const admin = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
  try { await admin.connect(); }
  catch (e) { return skip('Postgres unreachable (' + ((e && e.message) || e) + ') — docker compose up -d db'); }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-menus-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });

  let child = null, chrome = null, ws = null, sock = null;
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
        JWT_SECRET: 'test-menus-secret',
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

    const reg = await (await fetch(`http://127.0.0.1:${PORT}/api/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'menuuser', displayName: 'Menu User', password: 'passw0rd!x' }),
    })).json();
    if (!reg.token) return fail('register failed: ' + JSON.stringify(reg));
    const srvRes = await (await fetch(`http://127.0.0.1:${PORT}/api/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + reg.token },
      body: JSON.stringify({ name: 'Menus' }),
    })).json();
    const srv = srvRes.server;
    // A second account writes the message the menus are opened on: unread only
    // ever counts SOMEONE ELSE's message (see channelUnreadFor), so a menu check
    // on your own post could never exercise Mark unread.
    const reg2 = await (await fetch(`http://127.0.0.1:${PORT}/api/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'menufriend', displayName: 'Menu Friend', password: 'passw0rd!x' }),
    })).json();
    const join = await (await fetch(`http://127.0.0.1:${PORT}/api/servers/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + reg2.token },
      body: JSON.stringify({ inviteCode: srvRes.invite.code }),
    })).json();
    if (!reg2.token) return fail('second register failed: ' + JSON.stringify(reg2));

    sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(reg.token)}`);
    await new Promise((res, rej) => { sock.once('open', res); sock.once('error', rej); });
    sock.send(JSON.stringify({ t: 'subscribe' }));
    const sock2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(reg2.token)}`);
    await new Promise((res, rej) => { sock2.once('open', res); sock2.once('error', rej); });
    sock2.send(JSON.stringify({ t: 'subscribe' }));

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

    const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
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
    const labels = () => evaluate(`[...document.querySelectorAll('#ctx-menu .ctx-item')].map((b) => b.textContent.trim())`);
    const sheetLabels = () => evaluate(`[...document.querySelectorAll('#sheet .sheet-row')].map((b) => b.textContent.trim())`);
    const closeCtx = async () => { await evaluate(`(() => { try { closeCtx(); } catch (e) {} })()`); await sleep(80); };
    const closeSheet = async () => { await evaluate(`(() => { try { closeMsgSheet(true); closeCtxSheet(); } catch (e) {} })()`); await sleep(120); };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    if (!(await waitFor(`typeof boot === 'function'`))) return fail('the app never loaded');
    await evaluate(`(() => { localStorage.setItem('cf_token', ${JSON.stringify(reg.token)}); localStorage.setItem('cf_sid', ${JSON.stringify(reg.sid)}); return 1; })()`);
    await send('Page.reload');
    if (!(await waitFor(`S.me && S.me.username === 'menuuser'`))) return fail('boots signed in');

    console.log('\n[1] a message on screen with a reaction');
    const opened = await evaluate(`(async () => {
      await selectServer(${JSON.stringify(srv.id)});
      const ch = S.serverDetail.channels.find((c) => c.type === 'text');
      if (ch) await selectChannel(ch.id);
      return { serverId: S.serverId, channelId: S.channelId };
    })()`);
    check(!!opened.channelId, 'the channel is open', opened);
    sock2.send(JSON.stringify({ t: 'message', serverId: srv.id, channelId: opened.channelId, content: 'a message with a menu' }));
    // Target the message BY CONTENT: joining the server left a system line in
    // the same channel, so "the first .msg[data-mid]" is not a stable handle.
    if (!(await waitFor(`[...document.querySelectorAll('.msg[data-mid]')].some((m) => (m.textContent || '').includes('a message with a menu'))`))) return fail('the message never rendered');
    const mid = await evaluate(`[...document.querySelectorAll('.msg[data-mid]')].find((m) => (m.textContent || '').includes('a message with a menu')).dataset.mid`);
    const rowSel = '.msg[data-mid="' + mid + '"]';
    const textSel = rowSel + ' .text';
    const openMenuOnText = () => evaluate(`(() => {
      const t = document.querySelector(${JSON.stringify(textSel)});
      const r = t.getBoundingClientRect();
      t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 8), clientY: Math.round(r.top + 8), button: 2 }));
      return 1;
    })()`);
    const react = await (await fetch(`http://127.0.0.1:${PORT}/api/messages/${mid}/reactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + reg.token },
      body: JSON.stringify({ emoji: '👍' }),
    })).json();
    check(Array.isArray(react.reactions) && react.reactions.length === 1, 'a reaction lands on it', react);
    // The menu reads the CLIENT's copy of the message, so wait for the live
    // reaction push to be applied before judging the menu.
    check(!!(await waitFor(`(msgById(${JSON.stringify(mid)}).reactions || []).length === 1`)), 'and the client has the reaction');

    console.log('\n[2] the message menu');
    await openMenuOnText();
    await sleep(150);
    const menu = await labels();
    check(menu.length > 0, 'right-click opens the context menu', menu);
    for (const want of ['Copy text', 'Mark unread', 'Bookmark message', 'Create reminder', 'View reactions', 'Add reaction', 'Reply']) {
      check(menu.some((l) => l.includes(want)), 'the menu carries ' + want, menu);
    }
    check(menu.some((l) => /View reactions \(1\)/.test(l)), 'and View reactions counts the reaction', menu.filter((l) => l.includes('reactions')));

    console.log('\n[3] a tall menu gets a scrollbar instead of running off the screen');
    const tall = await evaluate(`(() => {
      const items = [];
      for (let i = 0; i < 40; i++) items.push({ label: 'Row ' + i, fn: () => {} });
      openCtx(20, 20, items);
      const m = document.querySelector('#ctx-menu');
      const cs = getComputedStyle(m);
      return { h: m.offsetHeight, vh: innerHeight, top: m.getBoundingClientRect().top, bottom: m.getBoundingClientRect().bottom, overflowY: cs.overflowY, maxH: cs.maxHeight, scrollable: m.scrollHeight > m.clientHeight };
    })()`);
    check(tall.overflowY === 'auto', 'a long menu scrolls (overflow-y:auto)', tall);
    check(tall.h <= tall.vh * 0.75, 'its height is capped well inside the viewport', tall);
    check(tall.bottom <= tall.vh && tall.top >= 0, 'and it is fully on screen', tall);
    check(tall.scrollable, 'with content taller than the box (so the scrollbar exists)', tall);
    const scrollbar = await evaluate(`(() => { const m = document.querySelector('#ctx-menu'); m.scrollTop = 40; return m.scrollTop > 0; })()`);
    check(scrollbar, 'and it really scrolls');
    await closeCtx();

    console.log('\n[4] a picture has its own menu');
    await evaluate(`(() => {
      const msg = document.querySelector(${JSON.stringify(textSel)});
      const wrap = document.createElement('span');
      wrap.className = 'att-wrap';
      wrap.dataset.fbUrl = '/uploads/files/photo.jpg';
      wrap.dataset.fbName = 'photo.jpg';
      wrap.dataset.fbKind = 'image';
      wrap.innerHTML = '<img class="att-img" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="photo" />';
      msg.appendChild(wrap);
      return 1;
    })()`);
    await evaluate(`(() => {
      const img = document.querySelector(${JSON.stringify(textSel)} + ' .att-wrap .att-img');
      const r = img.getBoundingClientRect();
      img.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 2), clientY: Math.round(r.top + 2), button: 2 }));
      return 1;
    })()`);
    await sleep(150);
    const imgMenu = await labels();
    for (const want of ['Copy image', 'Save image', 'Copy image link', 'Open image link']) {
      check(imgMenu.some((l) => l.includes(want)), 'the image menu carries ' + want, imgMenu);
    }
    check(!imgMenu.some((l) => l.includes('Mark unread')), 'and is the picture\'s menu, not the message\'s', imgMenu);
    await closeCtx();

    await evaluate(`(() => {
      const wrap = document.querySelector(${JSON.stringify(textSel)} + ' .att-wrap');
      wrap.dataset.fbUrl = '/uploads/files/clip.mp4';
      wrap.dataset.fbName = 'clip.mp4';
      wrap.dataset.fbKind = 'video';
      wrap.innerHTML = '<video class="att-vid" src="/uploads/files/clip.mp4"></video>';
      return 1;
    })()`);
    await evaluate(`(() => {
      const v = document.querySelector(${JSON.stringify(textSel)} + ' .att-wrap .att-vid');
      const r = v.getBoundingClientRect();
      v.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 2), clientY: Math.round(r.top + 2), button: 2 }));
      return 1;
    })()`);
    await sleep(150);
    const vidMenu = await labels();
    for (const want of ['Save video', 'Copy video link', 'Open video link']) {
      check(vidMenu.some((l) => l.includes(want)), 'the video menu carries ' + want, vidMenu);
    }
    check(!vidMenu.some((l) => l.includes('Copy video') && !l.includes('link')), 'and never promises to copy the bytes of a video', vidMenu);
    await closeCtx();

    console.log('\n[5] bookmarking from the menu really round-trips');
    await openMenuOnText();
    await sleep(150);
    const clicked = await evaluate(`(() => {
      const b = [...document.querySelectorAll('#ctx-menu .ctx-item')].find((x) => x.textContent.includes('Bookmark message'));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    check(clicked, 'the Bookmark message row is clickable');
    await sleep(600);
    const listed = await evaluate(`(async () => (await api('/api/bookmarks')).items.map((b) => b.messageId))()`);
    check(Array.isArray(listed) && listed.includes(mid), 'it is in the account\'s bookmarks on the server', listed);
    check(await evaluate(`S.bookmarkIds.has(${JSON.stringify(mid)})`), 'and in the client\'s toggle set');
    await openMenuOnText();
    await sleep(150);
    const menu2 = await labels();
    check(menu2.some((l) => l.includes('Remove bookmark')), 'the menu now offers to remove it', menu2);
    await closeCtx();

    console.log('\n[6] Mark unread from the menu');
    const marked = await evaluate(`(async () => {
      await markMessageUnread(${JSON.stringify(mid)});
      return { ctx: S.chanUnread.has(S.serverId + ':' + S.channelId), unread: (await api('/api/unread')).channels[S.serverId] || [] };
    })()`);
    check(marked.ctx, 'the open channel is painted unread', marked);
    check(marked.unread.includes(opened.channelId), 'and the server agrees (the watermark moved)', marked.unread);
    await evaluate(`(() => { try { markChannelRead(S.serverId, S.channelId, 0); } catch (e) {} return 1; })()`);

    console.log('\n[7] the reminder composer fans out the times');
    await evaluate(`(() => { try { openReminderModal(${JSON.stringify(mid)}); } catch (e) { window.__remErr = String(e); } return 1; })()`);
    const rem = await evaluate(`(() => {
      const chips = [...document.querySelectorAll('#rem-chips .rem-chip')].map((c) => c.textContent.trim());
      return {
        open: !document.querySelector('#modal-backdrop').classList.contains('hidden'),
        title: (document.querySelector('#modal-title') || {}).textContent,
        chips,
        custom: !!document.querySelector('#rem-custom'),
        when: (document.querySelector('#rem-when') || {}).textContent,
        sel: document.querySelectorAll('#rem-chips .rem-chip.sel').length,
      };
    })()`);
    check(rem.open && rem.title === 'Create reminder', 'the composer opens', rem);
    check(rem.chips.length === 5 && rem.chips.includes('In 20 minutes') && rem.chips.includes('Next week'), 'with the preset fan-out', rem.chips);
    check(rem.custom, 'and a custom time field');
    check(rem.sel === 1 && /Reminds you/.test(rem.when || ''), 'one preset is chosen and the summary says when', rem);
    const chipPick = await evaluate(`(() => {
      const b = [...document.querySelectorAll('#rem-chips .rem-chip')].find((x) => x.textContent.includes('Next week'));
      b.click();
      return { sel: [...document.querySelectorAll('#rem-chips .rem-chip.sel')].map((x) => x.textContent.trim()), when: document.querySelector('#rem-when').textContent };
    })()`);
    check(chipPick.sel.length === 1 && chipPick.sel[0].includes('Next week') && /Next week/.test(chipPick.when), 'picking a preset re-labels the summary', chipPick);
    const customPick = await evaluate(`(() => {
      const cu = document.querySelector('#rem-custom');
      const d = new Date(Date.now() + 5 * 864e5 + 3 * 36e5);
      const p = (n) => String(n).padStart(2, '0');
      cu.value = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
      cu.dispatchEvent(new Event('input', { bubbles: true }));
      return { sel: document.querySelectorAll('#rem-chips .rem-chip.sel').length, when: document.querySelector('#rem-when').textContent };
    })()`);
    check(customPick.sel === 0 && /custom/.test(customPick.when), 'a custom time takes the choice off the presets', customPick);
    // Create it (custom time, ~5 days out) and let the server confirm.
    await evaluate(`(() => { document.querySelector('#rem-text').value = 'check this later'; document.querySelector('#modal-ok').click(); return 1; })()`);
    await sleep(800);
    const remList = await evaluate(`(async () => (await api('/api/reminders')).items)()`);
    check(Array.isArray(remList) && remList.some((r) => r.text === 'check this later' && r.messageId === mid), 'the reminder is created and points at the message', remList);

    console.log('\n[8] the inbox: three tabs, each searchable');
    await evaluate(`(() => { try { document.querySelector('#modal-backdrop').classList.add('hidden'); } catch (e) {} return 1; })()`);
    await evaluate(`openInbox()`);
    if (!(await waitFor(`!!document.querySelector('#inbox-tabs, .inbox-tabs')`))) return fail('the inbox never opened');
    const shell = await evaluate(`(() => ({
      title: (document.querySelector('#modal-title') || {}).textContent,
      tabs: [...document.querySelectorAll('.inbox-tab')].map((t) => t.textContent.replace(/[0-9]+$/, '').trim()),
      on: (document.querySelector('.inbox-tab.on') || {}).textContent,
      search: !!document.querySelector('#inbox-q'),
      placeholder: (document.querySelector('#inbox-q') || {}).placeholder,
    }))()`);
    check(shell.title === 'Inbox', 'the bell opens an Inbox', shell);
    check(shell.tabs.length === 3 && shell.tabs.join(',') === 'Notifications,Reminders,Bookmarks', 'with the three tabs', shell.tabs);
    check(shell.on && shell.on.includes('Notifications') && shell.search, 'Notifications is the default tab, and it is searchable', shell);
    const bmTab = await evaluate(`(() => {
      [...document.querySelectorAll('.inbox-tab')].find((t) => t.textContent.includes('Bookmarks')).click();
      return { placeholder: (document.querySelector('#inbox-q') || {}).placeholder, rows: [...document.querySelectorAll('#inbox-list .inbox-item .ibody')].map((r) => r.textContent) };
    })()`);
    check(/bookmarks/i.test(bmTab.placeholder), 'the Bookmarks tab swaps the search hint', bmTab);
    check(bmTab.rows.some((r) => r.includes('a message with a menu')), 'and lists the saved message', bmTab.rows);
    const filtered = await evaluate(`(() => {
      const q = document.querySelector('#inbox-q');
      q.focus();
      q.value = 'zzzznomatch';
      q.dispatchEvent(new Event('input', { bubbles: true }));
      const none = document.querySelectorAll('#inbox-list .inbox-item').length;
      q.value = 'menu';
      q.dispatchEvent(new Event('input', { bubbles: true }));
      const some = document.querySelectorAll('#inbox-list .inbox-item').length;
      return { none, some, focused: document.activeElement === q };
    })()`);
    check(filtered.none === 0, 'searching filters the list', filtered);
    check(filtered.some >= 1, 'and matching text brings it back', filtered);
    check(filtered.focused, 'without the search field losing focus mid-typing', filtered);
    const remTab = await evaluate(`(() => {
      [...document.querySelectorAll('.inbox-tab')].find((t) => t.textContent.includes('Reminders')).click();
      return [...document.querySelectorAll('#inbox-list .inbox-item .ititle')].map((r) => r.textContent);
    })()`);
    check(remTab.some((r) => r.includes('check this later')), 'the Reminders tab lists the reminder', remTab);
    const counts = await evaluate(`(() => [...document.querySelectorAll('.inbox-tab')].map((t) => t.textContent.trim()))()`);
    check(counts.some((c) => /Bookmarks\s*1|Bookmarks1/.test(c)), 'the Bookmarks tab carries its count', counts);
    await evaluate(`(() => { try { cancelModal(); } catch (e) {} return 1; })()`);

    console.log('\n[9] the inbox button, and pictures in the lists');
    const icon = await evaluate(`(() => {
      const b = document.querySelector('#btn-notifs');
      const svg = b && b.querySelector('svg');
      return {
        has: !!svg,
        rect: !!(svg && svg.querySelector('rect')),
        bell: !!(svg && /A6 6 0 0 0 6 8/.test(svg.innerHTML)),
        paths: svg ? svg.querySelectorAll('path').length : -1,
      };
    })()`);
    check(icon.has && icon.rect && !icon.bell, 'the inbox button draws an envelope, not a bell', icon);
    check(icon.paths >= 1, 'with a flap', icon);
    const thumbs = await evaluate(`(() => {
      // A bookmark whose message carried pictures (the server snapshots the
      // media with it) and a mention that carried one.
      inboxData.bookmarks = [{
        id: 'x1', messageId: 'm1', kind: 'server', serverId: 's1', channelId: 'c1',
        authorName: 'Bruce', content: '', where: '#general · Menus', createdAt: Date.now(),
        media: [
          { name: 'photo.png', kind: 'image', url: '/uploads/files/photo.png?v=1' },
          { name: 'clip.mp4', kind: 'video', url: '/uploads/files/clip.mp4' },
          { name: 'notes.txt', kind: 'file', url: '/uploads/files/notes.txt' },
        ],
      }];
      inboxData.notifs = [{
        id: 'n1', kind: 'mention', title: '#general · Menus', body: 'Bruce: have a look',
        created_at: Date.now(), read_at: null,
        media_url: '/uploads/files/notif.png?v=2', media_kind: 'image',
      }];
      inboxTab = 'bookmarks';
      paintInboxShell();
      const tiles = [...document.querySelectorAll('.inbox-thumb')].map((t) => {
        const img = t.querySelector('img');
        return { src: img ? img.getAttribute('src') : null, video: t.classList.contains('video'), label: t.getAttribute('aria-label') };
      });
      const body = (document.querySelector('#inbox-list .inbox-item .ibody') || {}).textContent || '';
      const more = !!document.querySelector('.inbox-thumb-more');
      document.querySelector('.inbox-thumb').click();
      const lbOpen = !document.querySelector('#lightbox').classList.contains('hidden');
      const lbSrc = document.querySelector('#lightbox-img').getAttribute('src');
      try { closeLightbox(); } catch (e) {}
      inboxTab = 'notifs';
      paintInboxShell();
      const notifTiles = [...document.querySelectorAll('.inbox-thumb')].map((t) => {
        const img = t.querySelector('img');
        return img ? img.getAttribute('src') : null;
      });
      return { tiles, body, more, lbOpen, lbSrc, notifTiles };
    })()`);
    check(thumbs.tiles.length === 2, 'a bookmark shows one tile per picture/video, and none for a plain file', thumbs.tiles);
    check(thumbs.tiles[0] && /^\/uploads\/thumbs\/files\/photo\.png\.webp\?v=1$/.test(thumbs.tiles[0].src || ''),
      'a local upload is thumbnailed through the derived preview, cache key and all', thumbs.tiles[0]);
    check(thumbs.tiles[1] && thumbs.tiles[1].video && !thumbs.tiles[1].src, 'a video is a play tile until a poster lands', thumbs.tiles[1]);
    check(!/notes\.txt/.test(JSON.stringify(thumbs.tiles)), 'the file is not a tile', thumbs.tiles);
    check(/\[1 file\]/.test(thumbs.body), 'and is counted in the row body instead', thumbs.body);
    check(thumbs.lbOpen && thumbs.lbSrc === '/uploads/files/photo.png?v=1', 'tapping a picture tile opens it full size (the original, not the preview)', { open: thumbs.lbOpen, src: thumbs.lbSrc });
    check(thumbs.notifTiles.length === 1 && /^\/uploads\/thumbs\/files\/notif\.png\.webp\?v=2$/.test(thumbs.notifTiles[0] || ''),
      'and a mention of a message with a picture shows it too', thumbs.notifTiles);
    await evaluate(`(() => { try { cancelModal(); } catch (e) {} return 1; })()`);

    console.log('\n[10] the phone: a long-press sheet, and dragging it taller');
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await sleep(400);
    check(await evaluate(`matchMedia('(hover: none)').matches`), 'the page now sees a coarse pointer');
    await evaluate(`(() => {
      const t = document.querySelector(${JSON.stringify(textSel)});
      const r = t.getBoundingClientRect();
      window.__pt = { x: Math.round(r.left + 20), y: Math.round(r.top + Math.min(10, r.height / 2)) };
      return 1;
    })()`);
    const pt = await evaluate(`window.__pt`);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y }] });
    await sleep(900);
    const phoneSheet = await evaluate(`(() => {
      const sh = document.querySelector('#sheet');
      return sh ? { open: sh.classList.contains('open'), labels: [...sh.querySelectorAll('.sheet-row')].map((r) => r.textContent.trim()) } : null;
    })()`);
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(250);
    check(!!phoneSheet && phoneSheet.open, 'a long-press slides the sheet up', phoneSheet);
    if (phoneSheet) {
      check(phoneSheet.labels.some((l) => /bookmark/i.test(l)), 'with the bookmark row in it', phoneSheet.labels);
      check(phoneSheet.labels.some((l) => l.includes('Create reminder')), 'and the reminder row', phoneSheet.labels);
      check(phoneSheet.labels.some((l) => l.includes('Mark unread')), 'and mark unread', phoneSheet.labels);
    }
    await closeSheet();
    // A picture with a real box: the media sheet is opened by holding the
    // picture itself, so the finger has to land on the picture.
    await evaluate(`(() => {
      document.querySelectorAll('.att-wrap').forEach((w) => w.remove());
      const msg = document.querySelector(${JSON.stringify(textSel)});
      const wrap = document.createElement('span');
      wrap.className = 'att-wrap';
      wrap.dataset.fbUrl = '/uploads/files/phone.jpg';
      wrap.dataset.fbName = 'phone.jpg';
      wrap.dataset.fbKind = 'image';
      wrap.style.display = 'block';
      wrap.innerHTML = '<img class="att-img" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" style="display:block;width:220px;height:140px" alt="phone" />';
      msg.appendChild(wrap);
      return 1;
    })()`);
    await sleep(150);
    const imgSheet = await evaluate(`(() => {
      const im = document.querySelector('.att-wrap .att-img');
      if (!im) return null;
      const r = im.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (imgSheet) {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: imgSheet.x, y: imgSheet.y }] });
      await sleep(900);
      const mediaSheet = await evaluate(`(() => {
        const sh = document.querySelector('#sheet');
        return sh ? { labels: [...sh.querySelectorAll('.sheet-row')].map((r) => r.textContent.trim()), sub: (sh.querySelector('.sheet-snip') || {}).textContent } : null;
      })()`);
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(250);
      check(!!mediaSheet && mediaSheet.labels.some((l) => l.includes('Save image')) && mediaSheet.labels.some((l) => l.includes('Copy image link')),
        'a long-press ON the picture opens the media sheet, not the message sheet', mediaSheet);
    }
    await closeSheet();
    // A deliberately long menu, opened as a sheet, then dragged taller by its handle.
    const drag = await evaluate(`(() => {
      const items = [];
      for (let i = 0; i < 26; i++) items.push({ label: 'Row ' + i, fn: () => {} });
      openCtxSheet(items, { title: 'Long menu', sub: '26 rows', glyph: '#' });
      const sh = document.querySelector('#sheet');
      return { h: sh.offsetHeight, vh: innerHeight };
    })()`);
    await sleep(320);
    const dragGeo = await evaluate(`(() => {
      const h = document.querySelector('#sheet .sheet-handle');
      const r = h.getBoundingClientRect();
      const sh = document.querySelector('#sheet');
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), h: sh.offsetHeight, vh: innerHeight };
    })()`);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: dragGeo.x, y: dragGeo.y }] });
    for (let i = 1; i <= 8; i++) {
      await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: dragGeo.x, y: dragGeo.y - i * 20 }] });
      await sleep(16);
    }
    const midDrag = await evaluate(`(() => { const sh = document.querySelector('#sheet'); return { h: sh.offsetHeight, dragging: sh.classList.contains('sheet-dragging') }; })()`);
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(420);
    const afterDrag = await evaluate(`(() => {
      const sh = document.querySelector('#sheet');
      const rows = sh.querySelector('.sheet-rows');
      return {
        h: sh.offsetHeight, vh: innerHeight, tall: sh.classList.contains('sheet-tall'),
        rowsScroll: getComputedStyle(rows).overflowY,
        rowsFits: rows.scrollHeight > rows.clientHeight,
      };
    })()`);
    check(midDrag.dragging && midDrag.h > dragGeo.h + 40, 'dragging the handle up grows the sheet under the finger', { mid: midDrag, start: dragGeo });
    check(afterDrag.tall && afterDrag.h > dragGeo.h + 40, 'and it stays taller after the release', { after: afterDrag, start: dragGeo });
    check(afterDrag.h <= afterDrag.vh, 'without ever leaving the viewport', afterDrag);
    check(afterDrag.rowsScroll === 'auto', 'the list inside stays a scroll region (no scrollbar chrome)', afterDrag);
    check(drag.h > 0, 'the sheet had a real height to start from', drag);
    await closeSheet();

    const realErrors = pageErrors.filter((e) => e && !/favicon|Failed to load resource/i.test(e));
    check(realErrors.length === 0, 'no page exceptions', realErrors.slice(0, 3));
  } catch (e) {
    console.error('[test] ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    try { if (sock) sock.close(); } catch {}
    try { if (ws) ws.close(); } catch {}
    try { if (chrome) chrome.kill(); } catch {}
    try { if (child) child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
  process.exit(0);
}
main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
