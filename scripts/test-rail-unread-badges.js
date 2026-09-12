// The rail's unread badges: a count in a red corner circle on the server icon,
// the same number on a collapsed folder, and "Mark all as read" on the
// right-click / long-press menus (see AGENTS.md verification conventions).
//
// The requests:
//   - a server notification is a number in a red circle in the icon's corner,
//     not a bare white dot;
//   - a collapsed folder carries the number for the servers inside it;
//   - opening the folder hands the numbers back to those servers (the folder's
//     own circle disappears), and retracting without reading puts it back;
//   - a server, or a whole folder, can be marked read in one go from its menu.
//
// Offline: the wiring is checked statically. Then headless Chrome drives the
// REAL app against a throwaway database at a desktop viewport (skips without
// Postgres or Chrome) and measures the generated badges themselves — computed
// pseudo-element styles, the data counts, the folder hand-off on expansion and
// both menus end to end.
//
// Usage: node scripts/test-rail-unread-badges.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_rail_badges_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3433', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9351', 10);

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

// ---------- the wiring, offline ----------
const servers = fs.readFileSync(path.join(ROOT, 'public/js/servers.js'), 'utf8');
const actions = fs.readFileSync(path.join(ROOT, 'public/js/actions.js'), 'utf8');
const rail = fs.readFileSync(path.join(ROOT, 'public/js/rail.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

console.log('\n[0] the wiring');
check(/function serverUnreadCount\(serverId\)/.test(servers) && /function folderUnreadCount\(f\)/.test(servers),
  'the counts are one helper each (server = its channels, folder = its servers)');
check(/function paintServerBadge\(btn, s\)/.test(servers) && /function paintFolderBadge\(btn, f\)/.test(servers),
  'one painter per badge, used by both the initial render and the live mark');
check(/paintServerBadge\(b, s\)/.test(servers) && /paintFolderBadge\(b, f\)/.test(servers),
  'serverBtn / folderBtn paint through them');
check(/btn\.dataset\.unread = n > 99 \? '99\+' : String\(n\)/.test(servers), 'the number lives on data-unread');
check(/folderUnreadCount\(f\) \? \[\{ label: 'Mark all as read'/.test(actions), 'the folder sheet offers Mark all as read');
check(/serverUnreadCount\(sid\) \? \[\{ label: 'Mark all as read'/.test(actions), 'and so does the server menu');
check(/'Mark all as read'/.test(rail), 'the folder flyout carries the same row');
check(/function markServerRead\(serverId\)/.test(servers) && /function markFolderRead\(fid\)/.test(servers),
  'both menus clear through the shared helpers');

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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-rail-badges-'));
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
        JWT_SECRET: 'test-rail-badges-secret',
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

    // Three servers, one folder holding two of them, and a second text channel
    // on Alpha (the active server's badge has to survive opening it, which reads
    // the channel the server lands on).
    const reg = await (await fetch(`http://127.0.0.1:${PORT}/api/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'railuser', displayName: 'Rail', password: 'passw0rd!x' }),
    })).json();
    if (!reg.token) return fail('register failed: ' + JSON.stringify(reg));
    const jh = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + reg.token };
    const mkServer = async (name) => (await (await fetch(`http://127.0.0.1:${PORT}/api/servers`, { method: 'POST', headers: jh, body: JSON.stringify({ name }) })).json()).server;
    const alpha = await mkServer('Alpha');
    const beta = await mkServer('Beta');
    const gamma = await mkServer('Gamma');
    const delta = await mkServer('Delta'); // never marked until the end: the menu must not offer the action
    // Every server starts with one text channel; a second one makes "two unread
    // channels" a real state, and gives the active-server check a channel that
    // is NOT the one the server opens on.
    for (const s of [alpha, beta, gamma, delta]) {
      await fetch(`http://127.0.0.1:${PORT}/api/servers/${s.id}/channels`, {
        method: 'POST', headers: jh, body: JSON.stringify({ name: 'chat', type: 'text' }),
      });
    }
    await fetch(`http://127.0.0.1:${PORT}/api/me/layout`, {
      method: 'PUT', headers: jh,
      body: JSON.stringify({
        folders: [{ id: 'fold-games', name: 'Games', color: '#3ba55d', position: 1, open: 1 }],
        servers: [
          { id: alpha.id, folderId: null, position: 0 },
          { id: beta.id, folderId: 'fold-games', position: 1 },
          { id: gamma.id, folderId: 'fold-games', position: 2 },
          { id: delta.id, folderId: null, position: 2 },
        ],
      }),
    });

    const profile = path.join(tmp, 'chrome');
    chrome = spawn(chromePath, [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
      '--window-size=1280,860', 'about:blank',
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
    // What the reader actually sees on a badge: the generated pseudo-element's
    // own box, plus the count the button carries.
    const badgeOf = (sel) => evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      const cs = getComputedStyle(el, '::after');
      return {
        d: el.dataset.unread || null, unread: el.classList.contains('unread'),
        content: cs.content, bg: cs.backgroundColor, display: cs.display,
        right: cs.right, bottom: cs.bottom, radius: cs.borderRadius,
        weight: cs.fontWeight, color: cs.color,
      };
    })()`);
    const menuItems = (sel) => evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((b) => b.textContent.trim())`);

    await send('Page.enable');
    await send('Runtime.enable');
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    if (!(await waitFor(`typeof boot === 'function'`))) return fail('the app never loaded');
    await evaluate(`(() => { localStorage.setItem('cf_token', ${JSON.stringify(reg.token)}); localStorage.setItem('cf_sid', ${JSON.stringify(reg.sid)}); return 1; })()`);
    await send('Page.reload');
    if (!(await waitFor(`S.me && S.me.username === 'railuser'`))) return fail('boots signed in');
    if (!(await waitFor(`S.servers.length === 4`))) return fail('the four servers did not load');

    const sels = {
      alpha: `.server-btn[data-sid="${alpha.id}"]`,
      beta: `.server-btn[data-sid="${beta.id}"]`,
      gamma: `.server-btn[data-sid="${gamma.id}"]`,
      delta: `.server-btn[data-sid="${delta.id}"]`,
      folder: `.folder-btn[data-fid="fold-games"]`,
    };

    // A page helper: mark N of a server's text channels unread, newest last (so
    // the mark is never on the channel opening the server lands on). It writes
    // through the app's own S.chanUnread and mirrors it to localStorage, which
    // is exactly what a live background message does.
    await evaluate(`(async () => {
      window.__mark = async (spec) => {
        for (const [sid, n] of spec) {
          const d = await api('/api/servers/' + sid);
          const texts = (d.server.channels || []).filter((c) => c.type === 'text').map((c) => c.id);
          if (texts.length < n) throw new Error('not enough text channels on ' + sid);
          for (let i = 0; i < n; i++) S.chanUnread.set(sid + ':' + texts[texts.length - 1 - i], 1);
        }
        localStorage.setItem('cf_chanunread_' + S.me.id, JSON.stringify(Object.fromEntries([...S.chanUnread.keys()].map((k) => [k, { at: Date.now() }]))));
        renderServerList();
        return [...S.chanUnread.keys()];
      };
      return true;
    })()`);

    console.log('\n[1] a server notification is a number in a red corner circle');
    const marked = await evaluate(`__mark([[${JSON.stringify(alpha.id)}, 1], [${JSON.stringify(beta.id)}, 2], [${JSON.stringify(gamma.id)}, 1]])`);
    check(marked.length === 4 && !marked.some((k) => /undefined/.test(k)), 'four real channels are marked unread', marked);

    const alphaBadge = await badgeOf(sels.alpha);
    check(!!alphaBadge && alphaBadge.d === '1' && alphaBadge.unread === true, 'Alpha carries the count', alphaBadge);
    check(alphaBadge.content === '"1"', 'the generated badge renders that number', alphaBadge.content);
    const redVar = await evaluate(`(() => { const d = document.createElement('div'); d.style.color = 'var(--red)'; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; })()`);
    check(alphaBadge.bg === redVar, 'in the app red', { bg: alphaBadge.bg, redVar });
    check(alphaBadge.right === '-4px' && alphaBadge.bottom === '-4px', 'pinned to the icon\'s corner', alphaBadge);
    check(/999px/.test(alphaBadge.radius) && alphaBadge.color === 'rgb(255, 255, 255)', 'as a white-on-red circle', alphaBadge);
    check(alphaBadge.weight === '800', 'with the app\'s badge weight', alphaBadge);

    console.log('\n[2] a collapsed folder carries the sum');
    check((await evaluate(`!document.querySelector(${JSON.stringify(sels.beta)})`)), 'the folder\'s servers are not in the rail while it is collapsed');
    const foldBadge = await badgeOf(sels.folder);
    check(!!foldBadge && foldBadge.d === '3', 'the folder shows its servers\' total (2 + 1)', foldBadge);
    check(foldBadge.content === '"3"' && /999px/.test(foldBadge.radius), 'with the same red circle', foldBadge);
    check((await badgeOf(sels.alpha)).d === '1', 'a server outside the folder keeps its own', await badgeOf(sels.alpha));
    check((await badgeOf(sels.delta)) === null || (await badgeOf(sels.delta)).d === null, 'a read server has no badge at all');

    console.log('\n[3] expanding hands the numbers to the servers');
    await evaluate(`document.querySelector(${JSON.stringify(sels.folder)}).click()`);
    await waitFor(`!!document.querySelector('.folder-open')`);
    const openFold = await badgeOf(sels.folder);
    check(openFold.display === 'none' && openFold.d === '3',
      'the folder\'s circle disappears while it is open (the count is still there for the retract)', openFold);
    const betaBadge = await badgeOf(sels.beta), gammaBadge = await badgeOf(sels.gamma);
    check(!!betaBadge && betaBadge.d === '2', 'Beta shows its own 2', betaBadge);
    check(!!gammaBadge && gammaBadge.d === '1', 'Gamma shows its own 1', gammaBadge);
    check(betaBadge.content === '"2"' && betaBadge.display !== 'none', 'rendered, on the icon', betaBadge);
    // The badge must sit on the icon, not float off the rail.
    const geom = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(sels.beta)});
      const r = el.getBoundingClientRect();
      const railR = document.getElementById('server-list').getBoundingClientRect();
      return { inside: r.right + 4 <= railR.right + 0.5, w: Math.round(r.width), left: Math.round(r.left - railR.left) };
    })()`);
    check(geom.inside, 'the icon (and its corner badge) stays inside the rail', geom);

    console.log('\n[4] retracting without reading puts it back');
    await evaluate(`document.querySelector(${JSON.stringify(sels.folder)}).click()`);
    await waitFor(`!document.querySelector('.folder-open')`);
    const backFold = await badgeOf(sels.folder);
    check(backFold.display !== 'none' && backFold.d === '3' && backFold.content === '"3"', 'the folder\'s 3 is back', backFold);
    check((await evaluate(`!document.querySelector(${JSON.stringify(sels.beta)})`)), 'and the inner icons are gone again');

    console.log('\n[5] the server menu marks one server read');
    // A read server gets no action at all.
    await evaluate(`(() => {
      const b = document.querySelector(${JSON.stringify(sels.delta)});
      const r = b.getBoundingClientRect();
      b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 10, clientY: r.top + 10 }));
      return 1;
    })()`);
    await waitFor(`!!document.getElementById('ctx-menu')`);
    check(!(await menuItems('#ctx-menu .ctx-item')).includes('Mark all as read'), 'a read server does not offer it',
      await menuItems('#ctx-menu .ctx-item'));
    await evaluate(`closeCtx()`);
    // With unread it is the last row.
    await evaluate(`(() => {
      const b = document.querySelector(${JSON.stringify(sels.alpha)});
      const r = b.getBoundingClientRect();
      b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 10, clientY: r.top + 10 }));
      return 1;
    })()`);
    await waitFor(`!!document.getElementById('ctx-menu')`);
    const items = await menuItems('#ctx-menu .ctx-item');
    check(items.some((t) => /Mark all as read/.test(t)), 'Alpha\'s menu offers Mark all as read', items);
    check(/Mark all as read/.test(items[items.length - 1] || ''), 'as the last row, under the notification settings', items.slice(-3));
    await evaluate(`[...document.querySelectorAll('#ctx-menu .ctx-item')].find((b) => /Mark all as read/.test(b.textContent)).click()`);
    await sleep(600); // saveChanUnread is debounced
    const afterAlpha = await badgeOf(sels.alpha);
    check(afterAlpha.d === null && afterAlpha.unread === false, 'the badge is gone', afterAlpha);
    check((await badgeOf(sels.folder)).d === '3', 'the folder\'s total is untouched by it', await badgeOf(sels.folder));
    const stored = await evaluate(`Object.keys(JSON.parse(localStorage.getItem('cf_chanunread_' + S.me.id) || '{}'))`);
    check(!stored.some((k) => k.startsWith(alpha.id + ':')), 'and its marks are cleared from the store', stored);

    console.log('\n[6] the active server keeps its count (another channel can be unread)');
    await evaluate(`(async () => { await selectServer(${JSON.stringify(delta.id)}); })()`);
    await sleep(400);
    const deltaMarked = await evaluate(`__mark([[${JSON.stringify(delta.id)}, 1]])`);
    check(!deltaMarked.some((k) => /undefined/.test(k)), 'Delta gets a real unread channel', deltaMarked);
    const deltaOnIt = await badgeOf(sels.delta);
    check(deltaOnIt.d === '1' && deltaOnIt.display !== 'none', 'the open server still shows its unread channel', deltaOnIt);
    await evaluate(`(async () => { await selectServer(${JSON.stringify(alpha.id)}); })()`);
    await sleep(250);

    console.log('\n[7] the folder menu marks every server in it read');
    await evaluate(`(() => {
      const b = document.querySelector(${JSON.stringify(sels.folder)});
      const r = b.getBoundingClientRect();
      b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 10, clientY: r.top + 10 }));
      return 1;
    })()`);
    await waitFor(`!!document.getElementById('folder-menu')`);
    const folderItems = await menuItems('#folder-menu .fm-item');
    check(folderItems.some((t) => /Mark all as read/.test(t)), 'the folder flyout offers it', folderItems);
    await evaluate(`[...document.querySelectorAll('#folder-menu .fm-item')].find((b) => /Mark all as read/.test(b.textContent)).click()`);
    await sleep(600);
    check((await badgeOf(sels.folder)).d === null, 'the folder badge is gone');
    const left = await evaluate(`Object.keys(JSON.parse(localStorage.getItem('cf_chanunread_' + S.me.id) || '{}'))`);
    check(!left.some((k) => k.startsWith(beta.id + ':') || k.startsWith(gamma.id + ':')),
      'every mark of every server in the folder is cleared', left);
    check(left.some((k) => k.startsWith(delta.id + ':')), 'and a server outside the folder is left alone', { left, delta: delta.id });
    check((await badgeOf(sels.delta)).d === '1', 'Delta still carries its own unread', await badgeOf(sels.delta));

    const realErrors = pageErrors.filter((e) => e && !/favicon|Failed to load resource/i.test(e));
    check(realErrors.length === 0, 'no page exceptions', realErrors.slice(0, 3));
  } catch (e) {
    console.error('[test] ' + (e && e.stack || e));
    process.exit(1);
  } finally {
    try { if (ws) ws.close(); } catch {}
    try { if (chrome) chrome.kill(); } catch {}
    try { if (child) child.kill(); } catch {}
    try { const c = new Client({ ...pg, database: 'postgres' }); await c.connect(); await c.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`); await c.end(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

main()
  .then(() => {
    console.log('\n' + (failures.length ? failures.length + ' FAILED, ' + passed + ' passed' : 'all ' + passed + ' checks passed'));
    process.exit(failures.length ? 1 : 0);
  })
  .catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
