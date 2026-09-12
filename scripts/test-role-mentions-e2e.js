// Role mentions + admin-only @everyone / @here, end-to-end (see AGENTS.md
// verification conventions).
//
// scripts/test-role-mentions.js checks the matcher and the wiring offline; this
// one proves the behaviour against a real server + database (and a real browser,
// when one is available):
//   - a message from a plain member saying "@everyone" pings NOBODY (no inbox
//     entry anywhere), while the same text from the owner or from a holder of an
//     admin role pings everyone — including members who are offline;
//   - "@here" reaches online members only;
//   - "@Role Name" reaches exactly the members holding it, and role holders are
//     resolved server-side (not by whoever happens to be looking);
//   - the composer's autocomplete offers roles to everyone and @everyone / @here
//     to admins alone, and inserting one writes the mention into the box;
//   - the chat renders a real mention chip for an admin's broadcast and plain
//     text for a member's.
//
// Boots a throwaway database (never the dev one) and, if a Chrome/Edge binary is
// found, drives the page over the DevTools protocol. Skips (exit 0) when
// Postgres is unavailable; the browser half alone is skipped without Chrome.
//
// Usage: node scripts/test-role-mentions-e2e.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_role_mentions_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3417', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9334', 10);
const BASE = `http://127.0.0.1:${PORT}`;

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

async function req(method, p, { token, body } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(d)}`);
  return d;
}
const openWs = (token) => new Promise((res, rej) => {
  const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
  w.once('open', () => res(w));
  w.once('error', rej);
});
const wsSend = (w, obj) => w.send(JSON.stringify(obj));
const inbox = async (token) => (await req('GET', '/api/notifs/inbox', { token })).items || [];
// How many mention rows in this user's inbox carry `needle`.
const pings = (items, needle) => items.filter((i) => i.kind === 'mention' && String(i.body || '').includes(needle)).length;

async function main() {
  const chromePath = findChrome();
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-role-e2e-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });

  let child = null, chrome = null, cdp = null;
  const sockets = [];
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
        JWT_SECRET: 'test-role-mentions-secret',
        UPLOAD_DIR: uploads,
        VIRUS_SCAN: '0', MEDIA_COMPRESS: '0', UNFURL: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    const fail = (msg) => { throw new Error(msg + '\n--- server log ---\n' + serverLog.slice(-3000)); };
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try { up = (await fetch(BASE + '/api/config')).ok; } catch {}
      if (!up) await sleep(250);
    }
    if (!up) return fail('server did not come up');

    // ---------- a server with an owner, a member, a role holder, an offline user ----------
    const reg = async (username, displayName) => (await req('POST', '/api/register', { body: { username, displayName, password: 'passw0rd!x' } }));
    const boss = await reg('boss', 'Boss');
    const mem = await reg('mem', 'Mem');
    const pal = await reg('pal', 'Pal');
    const off = await reg('off', 'Off');
    const made = await req('POST', '/api/servers', { token: boss.token, body: { name: 'Role Lab' } });
    const sid = made.server.id;
    const chid = (made.server.channels.find((c) => c.type === 'text') || {}).id;
    check(!!sid && !!chid && !!made.invite, 'the owner created a server with a channel + invite', { sid, chid });
    for (const u of [mem, pal, off]) await req('POST', '/api/servers/join', { token: u.token, body: { inviteCode: made.invite.code } });
    const role = (await req('POST', `/api/servers/${sid}/roles`, { token: boss.token, body: { name: 'Mod Team', color: '#ff8800' } })).role;
    await req('POST', `/api/servers/${sid}/roles/${role.id}/members`, { token: boss.token, body: { userId: pal.user.id } });
    const ops = (await req('POST', `/api/servers/${sid}/roles`, { token: boss.token, body: { name: 'Ops', color: '#5b6cff' } })).role;
    await req('PATCH', `/api/servers/${sid}/roles/${ops.id}`, { token: boss.token, body: { admin: 1 } });

    // boss/mem/pal are online (a live socket each); `off` never connects.
    for (const u of [boss, mem, pal]) sockets.push(await openWs(u.token));
    await sleep(500);

    const PING = {
      memberAll: 'from a member @everyone', bossAll: 'from the boss @everyone',
      bossHere: '@here roll call', memberRole: '@Mod Team assemble', palAll: '@everyone admin role speaking',
    };
    // Distinct texts for the rendered-chip half, so the DOM assertions are about
    // a message that arrived live (not one the page loaded from history).
    const LIVE = {
      memberAll: 'live from a member @everyone', bossAll: 'live from the boss @everyone',
      bossHere: '@here live roll call', role: '@Mod Team live assemble',
    };
    const send = async (token, content) => {
      const w = await openWs(token);
      sockets.push(w);
      wsSend(w, { t: 'message', serverId: sid, channelId: chid, content });
      await sleep(500);
    };

    console.log('\n[1] a plain member cannot @everyone');
    await send(mem.token, PING.memberAll);
    for (const [who, u] of [['the owner', boss], ['a member', mem], ['a role holder', pal], ['an offline user', off]]) {
      check(pings(await inbox(u.token), PING.memberAll) === 0, 'no ping for ' + who);
    }

    console.log('\n[2] the owner can');
    await send(boss.token, PING.bossAll);
    for (const [who, u] of [['a member', mem], ['a role holder', pal], ['an offline user', off]]) {
      check(pings(await inbox(u.token), PING.bossAll) === 1, '@everyone reached ' + who);
    }
    check(pings(await inbox(boss.token), PING.bossAll) === 0, 'the author is not pinged by their own broadcast');

    console.log('\n[3] @here reaches online members only');
    await send(boss.token, PING.bossHere);
    check(pings(await inbox(mem.token), PING.bossHere) === 1, '@here reached the online member');
    check(pings(await inbox(pal.token), PING.bossHere) === 1, '@here reached the online role holder');
    check(pings(await inbox(off.token), PING.bossHere) === 0, '@here skipped the offline member');

    console.log('\n[4] role mentions reach exactly the holders');
    await send(mem.token, PING.memberRole);
    check(pings(await inbox(pal.token), PING.memberRole) === 1, 'the role holder was pinged');
    check(pings(await inbox(boss.token), PING.memberRole) === 0, 'a non-holder was not');
    check(pings(await inbox(off.token), PING.memberRole) === 0, 'nor was an offline non-holder');

    console.log('\n[5] an admin role is enough to broadcast');
    await req('POST', `/api/servers/${sid}/roles/${ops.id}/members`, { token: boss.token, body: { userId: pal.user.id } });
    await send(pal.token, PING.palAll);
    check(pings(await inbox(mem.token), PING.palAll) === 1, '@everyone from an admin role reached a member');
    check(pings(await inbox(off.token), PING.palAll) === 1, 'and reached an offline member');

    // ---------- the browser half: autocomplete + rendered chips ----------
    if (!chromePath) {
      console.log('\n[6] browser checks — SKIPPED (no Chrome/Edge found; set CHROME_PATH)');
    } else {
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

      const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
      cdp = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
      await new Promise((res, rej) => { cdp.once('open', res); cdp.once('error', rej); });
      let msgId = 0;
      const pending = new Map();
      const pageErrors = [];
      cdp.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.id && pending.has(m.id)) {
          const { res, rej } = pending.get(m.id);
          pending.delete(m.id);
          if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
        } else if (m.method === 'Runtime.exceptionThrown') {
          pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
        }
      });
      const cmd = (method, params = {}) => new Promise((res, rej) => {
        const i = ++msgId;
        pending.set(i, { res, rej });
        cdp.send(JSON.stringify({ id: i, method, params }));
      });
      const evaluate = async (expression) => {
        const r = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
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
      // Sign a browser session in as `token` and land in the server's channel.
      const enterAs = async (token) => {
        await evaluate(`localStorage.setItem('cf_token', ${JSON.stringify(token)})`);
        await cmd('Page.reload');
        if (!(await waitFor(`typeof S !== 'undefined' && !!S.me`))) throw new Error('the app did not boot');
        await evaluate(`(async () => { await refreshServers(${JSON.stringify(sid)}); await selectServer(${JSON.stringify(sid)}); await selectChannel(${JSON.stringify(chid)}); return true; })()`);
        if (!(await waitFor(`S.channelId === ${JSON.stringify(chid)}`))) throw new Error('the channel did not open');
      };
      // Type a mention query into the composer and read back the popup rows.
      const popup = (query) => evaluate(`(() => {
        const i = document.querySelector('#in-message');
        i.value = ${JSON.stringify(query)};
        i.selectionStart = i.value.length;
        i.dispatchEvent(new Event('input', { bubbles: true }));
        const pop = document.querySelector('#mention-pop');
        if (!pop || pop.classList.contains('hidden')) return { open: false, rows: [] };
        return { open: true, rows: [...pop.querySelectorAll('.mention-item')].map((b) => b.dataset.insert) };
      })()`);
      const insertMention = (query, insert) => evaluate(`(() => {
        const i = document.querySelector('#in-message');
        i.value = ${JSON.stringify(query)};
        i.selectionStart = i.value.length;
        i.dispatchEvent(new Event('input', { bubbles: true }));
        const row = [...document.querySelectorAll('#mention-pop .mention-item')].find((b) => b.dataset.insert === ${JSON.stringify(insert)});
        if (!row) return null;
        row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        return document.querySelector('#in-message').value;
      })()`);
      await cmd('Page.enable');
      await cmd('Runtime.enable');
      // Land on the app's origin first — `about:blank` has no localStorage.
      await evaluate(`location.href = ${JSON.stringify(BASE + '/')}`);
      if (!(await waitFor(`typeof S !== 'undefined'`))) throw new Error('the app did not load');

      console.log('\n[6] the composer offers roles to everyone, @everyone to admins only');
      await enterAs(mem.token);
      check(!!(await waitFor(`!!document.querySelector('#in-message')`)), 'the app boots signed in as a member');
      const memberRole = await popup('@M');
      check(memberRole.open && memberRole.rows.includes('Mod Team'), 'a member is offered the role', memberRole);
      const memberAll = await popup('@ev');
      check(!memberAll.open || !memberAll.rows.includes('everyone'), 'a member is NOT offered @everyone', memberAll);
      const memberHere = await popup('@he');
      check(!memberHere.open || !memberHere.rows.includes('here'), 'a member is NOT offered @here', memberHere);
      check(!(await popup('@bob')).open, 'an unmatched query leaves the popup closed');
      check((await insertMention('@M', 'Mod Team')) === '@Mod Team ', 'picking a role writes the mention into the composer');

      console.log('\n[7] the chat renders an admin broadcast, and plain text for a member');
      await evaluate(`document.querySelector('#in-message').value = ''`);
      await send(mem.token, LIVE.memberAll);
      const memberMsg = await waitFor(`(() => { const e = [...document.querySelectorAll('#messages .msg .text')].pop(); return e && e.textContent.includes('live from a member') ? e.innerHTML : null })()`);
      check(!!memberMsg && !memberMsg.includes('class="mention'), "a member's @everyone renders as plain text in the chat", memberMsg);
      await send(boss.token, LIVE.bossAll);
      const bossMsg = await waitFor(`(() => { const e = [...document.querySelectorAll('#messages .msg .text')].pop(); return e && e.textContent.includes('live from the boss') ? e.innerHTML : null })()`);
      check(!!bossMsg && /class="mention all">@everyone</.test(bossMsg), "the owner's @everyone renders as a broadcast chip", bossMsg);
      await send(boss.token, LIVE.bossHere);
      const hereMsg = await waitFor(`(() => { const e = [...document.querySelectorAll('#messages .msg .text')].pop(); return e && e.textContent.includes('live roll call') ? e.innerHTML : null })()`);
      check(!!hereMsg && /class="mention all">@here</.test(hereMsg), '@here renders as a chip too', hereMsg);
      await send(boss.token, LIVE.role);
      const roleMsg = await waitFor(`(() => { const e = [...document.querySelectorAll('#messages .msg .text')].pop(); return e && e.textContent.includes('live assemble') ? e.innerHTML : null })()`);
      check(!!roleMsg && roleMsg.includes('data-rid="' + role.id + '"'), 'a role mention renders as a role chip', roleMsg);
      check(!!roleMsg && roleMsg.includes('--rc:#ff8800'), "with the role's colour", roleMsg);

      console.log('\n[8] an admin sees @everyone / @here in the composer');
      await enterAs(boss.token);
      const bossAllRows = await popup('@ev');
      check(bossAllRows.open && bossAllRows.rows.includes('everyone'), 'the owner is offered @everyone', bossAllRows);
      const bossHereRows = await popup('@he');
      check(bossHereRows.open && bossHereRows.rows.includes('here'), 'the owner is offered @here', bossHereRows);
      check((await insertMention('@ev', 'everyone')) === '@everyone ', 'picking @everyone writes it into the composer');

      check(pageErrors.length === 0, 'no uncaught page errors', pageErrors.slice(0, 3));
    }
  } finally {
    for (const w of sockets) { try { w.close(); } catch {} }
    try { cdp && cdp.close(); } catch {}
    try { chrome && chrome.kill(); } catch {}
    try { child && child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => '  - ' + f).join('\n')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('[test] crashed:', (e && e.message) || e); process.exit(1); });
