// Friend-row clicks open the DM — and nothing else.
//
// The bug: a friend row carries data-uid (the story-ring painter needs it to
// find the row again after a roster rebuild), and the global [data-uid] click
// delegate in pickers.js read that as "open the user card". Clicking a friend
// under All/Online therefore opened the DM AND stacked their card on top of it.
// Rows that own their click now declare it (data-ownclick) and the delegate
// leaves them alone.
//
// Boots a real server against a throwaway database and drives Chrome over the
// DevTools protocol (no puppeteer — plain CDP over ws, same harness as
// scripts/test-drafts-browser.js). It counts openUserCard calls with a patched
// global, so "no card" is proved, not inferred.
//
// Skips (exit 0) when Postgres or Chrome is unavailable.
//
// Usage: node scripts/test-friend-click.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_friendclick_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3417', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9334', 10);

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-friendclick-e2e-'));
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
        JWT_SECRET: 'test-friendclick-secret',
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

    await send('Page.enable');
    await send('Runtime.enable');
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    check(!!(await waitFor(`typeof boot === 'function'`)), 'the app loads');

    console.log('\n[1] two friends, one page');
    const reg = await evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'forest', displayName: 'Forest', password: 'passw0rd!x' }) });
      const d = await r.json();
      store.token = d.token; store.sid = d.sid;
      return { ok: !!d.token };
    })()`);
    check(!!reg.ok, 'registered an account');
    await send('Page.reload');
    check(!!(await waitFor(`S.me && S.me.username === 'forest'`)), 'boots signed in');
    const pair = await evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pal', displayName: 'Pal', password: 'passw0rd!x' }) });
      const p = await r.json();
      await api('/api/friends', { method: 'POST', body: JSON.stringify({ username: 'pal' }) });
      await fetch('/api/friends/' + S.me.id + '/accept', { method: 'POST', headers: { Authorization: 'Bearer ' + p.token } });
      // A second incoming request stays pending so the Pending tab has a row.
      const w = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'waiter', displayName: 'Waiter', password: 'passw0rd!x' }) });
      const wd = await w.json();
      await fetch('/api/friends', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + wd.token }, body: JSON.stringify({ username: 'forest' }) });
      await refreshFriends();
      await openHome();
      return { palId: p.user.id, waiterId: wd.user.id, friends: S.friends.friends.length, pending: S.friends.pendingIn.length };
    })()`);
    check(pair.friends === 1 && pair.pending === 1, 'the roster has one friend and one pending request', pair);

    // Count card opens. Function declarations are writable window props, so
    // both the row handlers and the delegate resolve to the patched version.
    const patched = await evaluate(`(() => {
      window.__cards = 0;
      if (typeof openUserCard !== 'function') return 'missing';
      const real = window.openUserCard;
      window.openUserCard = function (...a) { window.__cards++; return real.apply(this, a); };
      window.openUserCard('no-such-user-id');
      if (window.__cards !== 1) return 'not-patched';
      window.__cards = 0;
      return 'ok';
    })()`);
    check(patched === 'ok', 'openUserCard is counted (the assertions are not vacuous)', { patched });
    if (patched !== 'ok') return fail('could not instrument openUserCard');

    // Shared click helper: reset to the friends list, click a friend row (the
    // avatar inside it, like a finger would), and report what happened.
    const setupClick = (uid, tab, presence) => `(() => {
      window.__cards = 0;
      if (document.querySelector('#usercard')) closeUserCard();
      S.dmThreadId = null; renderDmBlank();
      ${presence ? `S.presenceAll[${JSON.stringify(uid)}] = 'online';` : ''}
      S.friendTab = ${JSON.stringify(tab)};
      renderFriendLists();
      const row = [...document.querySelectorAll('#friend-list .dmrow[data-uid], #friend-reqs .dmrow[data-uid]')].find((r) => r.dataset.uid === ${JSON.stringify(uid)});
      if (!row) return false;
      const av = row.querySelector('.avatar') || row;
      const r = row.getBoundingClientRect();
      av.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.left + 14, clientY: r.top + 14 }));
      return true;
    })()`;

    console.log('\n[2] All tab: the row opens the DM, never a card');
    const clickAll = await evaluate(`(async () => {
      const clicked = ${setupClick(pair.palId, 'all', false)};
      await new Promise((r) => setTimeout(r, 700));
      return { clicked, cards: window.__cards, dmOpen: document.body.classList.contains('dm-open'), name: document.querySelector('#chan-name').textContent, hidden: document.querySelector('#usercard').classList.contains('hidden') };
    })()`);
    check(clickAll.clicked === true, 'the friend is listed under All');
    check(clickAll.dmOpen && clickAll.name === 'Pal', 'the click opened the DM', clickAll);
    check(clickAll.cards === 0 && clickAll.hidden, 'and no user card came with it', clickAll);

    console.log('\n[3] Online tab: same contract');
    const clickOnline = await evaluate(`(async () => {
      const clicked = ${setupClick(pair.palId, 'online', true)};
      await new Promise((r) => setTimeout(r, 700));
      return { clicked, cards: window.__cards, dmOpen: document.body.classList.contains('dm-open'), name: document.querySelector('#chan-name').textContent, hidden: document.querySelector('#usercard').classList.contains('hidden') };
    })()`);
    check(clickOnline.clicked === true, 'the online friend is listed under Online');
    check(clickOnline.dmOpen && clickOnline.name === 'Pal', 'the click opened the DM', clickOnline);
    check(clickOnline.cards === 0 && clickOnline.hidden, 'and no user card came with it', clickOnline);

    console.log('\n[3b] a friend row\'s server tag goes to the DM, never the server panel');
    const tagClick = await evaluate(`(async () => {
      window.__tags = 0;
      if (typeof openTagCard !== 'function') return { err: 'missing openTagCard' };
      const realTag = window.openTagCard;
      window.openTagCard = function (...a) { window.__tags++; return realTag.apply(this, a); };
      // Positive control: a live tag really does reach openTagCard, so the
      // "no panel" assertion below is not vacuous.
      const probe = document.createElement('span');
      probe.className = 'usertag clickable';
      probe.setAttribute('data-tag-sid', 'probe-server');
      document.body.appendChild(probe);
      probe.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
      await new Promise((r) => setTimeout(r, 80));
      const control = window.__tags;
      probe.remove();
      closeTagCard();

      const pal = (S.friends.friends || []).find((u) => u.id === ${JSON.stringify(pair.palId)});
      pal.active_tag = 'TST';
      pal.active_tag_server_id = 'srv-tag';
      S.dmThreadId = null; renderDmBlank();
      S.presenceAll[pal.id] = 'online';
      S.friendTab = 'online'; renderFriendLists();
      const row = [...document.querySelectorAll('#friend-list .dmrow[data-uid]')].find((r) => r.dataset.uid === pal.id);
      if (!row) return { err: 'no friend row' };
      const tag = row.querySelector('.usertag');
      if (!tag) return { err: 'no tag rendered' };
      const decorative = !tag.dataset.tagSid && !tag.classList.contains('clickable');
      window.__tags = 0; window.__cards = 0;
      const r = tag.getBoundingClientRect();
      tag.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.left + 2, clientY: r.top + 2 }));
      await new Promise((res) => setTimeout(res, 700));
      return { control, decorative, tags: window.__tags, cards: window.__cards,
        dmOpen: document.body.classList.contains('dm-open'),
        name: document.querySelector('#chan-name').textContent,
        tagHidden: document.querySelector('#tagcard').classList.contains('hidden') };
    })()`);
    check(tagClick.control === 1, 'the tag-click probe reaches openTagCard (not vacuous)', tagClick);
    check(tagClick.decorative === true, 'a friend row renders its tag as a decorative pill', tagClick);
    check(tagClick.dmOpen && tagClick.name === 'Pal', 'clicking the tag opens the DM', tagClick);
    check(tagClick.tags === 0 && tagClick.tagHidden, 'and the server tag panel never opens', tagClick);

    console.log('\n[4] the row\'s own card affordances still work');
    const viaMenu = await evaluate(`(async () => {
      window.__cards = 0; closeUserCard();
      const row = [...document.querySelectorAll('#friend-list .dmrow[data-uid]')].find((r) => r.dataset.uid === ${JSON.stringify(pair.palId)});
      row.querySelector('.fact-btn[title="More actions"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
      const item = [...document.querySelectorAll('#ctx-menu .ctx-item')].find((b) => /View profile/.test(b.textContent));
      if (!item) return { err: 'no View profile item' };
      item.click();
      await new Promise((r) => setTimeout(r, 500));
      const card = document.querySelector('#usercard');
      return { cards: window.__cards, open: !card.classList.contains('hidden'), uid: card.dataset.uid };
    })()`);
    check(viaMenu.cards === 1 && viaMenu.open && viaMenu.uid === pair.palId, 'More actions → View profile opens exactly one card', viaMenu);

    const viaMessageBtn = await evaluate(`(async () => {
      window.__cards = 0; closeUserCard();
      const row = [...document.querySelectorAll('#friend-list .dmrow[data-uid]')].find((r) => r.dataset.uid === ${JSON.stringify(pair.palId)});
      row.querySelector('.fact-btn[title="Message"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
      await new Promise((r) => setTimeout(r, 600));
      return { cards: window.__cards, dmOpen: document.body.classList.contains('dm-open') };
    })()`);
    check(viaMessageBtn.cards === 0 && viaMessageBtn.dmOpen, 'the Message button opens the DM and no card', viaMessageBtn);

    console.log('\n[5] Pending tab: one card, not two');
    const pendingClick = await evaluate(`(async () => {
      const clicked = ${setupClick(pair.waiterId, 'pending', false)};
      await new Promise((r) => setTimeout(r, 600));
      return { clicked, cards: window.__cards, open: !document.querySelector('#usercard').classList.contains('hidden'), uid: document.querySelector('#usercard')?.dataset.uid };
    })()`);
    check(pendingClick.clicked === true, 'the request row is there');
    check(pendingClick.cards === 1 && pendingClick.open && pendingClick.uid === pair.waiterId, 'the pending row opens one card', pendingClick);

    console.log('\n[6] a voice occupant opens one card, not two');
    const voiceClick = await evaluate(`(async () => {
      closeUserCard();
      const s = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: 'Voice Lab' }) });
      await refreshServers(s.server.id);
      if (S.ws) S.ws.send(JSON.stringify({ t: 'subscribe' }));
      await selectServer(s.server.id);
      const c = await api('/api/servers/' + s.server.id + '/channels', { method: 'POST', body: JSON.stringify({ name: 'lounge', type: 'voice' }) });
      await selectServer(s.server.id);
      S.voiceOccupancy.set(c.channel.id, [{ id: ${JSON.stringify(pair.palId)}, display_name: 'Pal', username: 'pal', muted: false, deafened: false }]);
      renderVoiceUsers();
      window.__cards = 0;
      const row = document.querySelector('.vuser[data-uid]');
      if (!row) return { err: 'no occupant row' };
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
      await new Promise((r) => setTimeout(r, 500));
      return { cards: window.__cards };
    })()`);
    check(voiceClick.cards === 1, 'the occupant row opens exactly one card', voiceClick);

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
