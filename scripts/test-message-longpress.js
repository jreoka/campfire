// A long-press on a message opens its sheet — never the browser's text
// selection (see AGENTS.md verification conventions).
//
// The complaint: on Android, holding the left side of a message highlighted the
// message's timestamp instead of sliding the action sheet up. The cause was the
// `html.standalone` half of the installed-app rules not applying to the Tauri
// wrapper (its WebView is not `display-mode: standalone`), so the app stayed
// text-selectable: Chrome recognised its own long-press (~500ms) first,
// highlighted the nearest word and cancelled the touch — which killed the
// app's 550ms hold, so the sheet never opened.
//
// This drives headless Chrome over CDP at a phone viewport with REAL touch
// events and holds the finger down: the sheet must open from the row's left
// padding (no text under it), from the timestamp, from the avatar and from the
// message body, and nothing may be selected in any of those places. Skips
// (exit 0) when Postgres or Chrome is unavailable.
//
// Usage: node scripts/test-message-longpress.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_msg_longpress';
const PORT = parseInt(process.env.TEST_PORT || '3437', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9354', 10);

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

// ---------- the stylesheet, offline (the mechanism behind the fix) ----------
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const coarse = (() => {
  const i = css.indexOf('/* On a touch screen a long-press IS the message menu');
  if (i < 0) return null;
  const open = css.indexOf('{', i);
  const close = css.indexOf('\n}', open);
  return css.slice(open + 1, close);
})();
console.log('\n[0] the stylesheet opts message content out of native selection');
check(!!coarse, 'the coarse-pointer block exists');
check(/\.msg,\.msg \*,/.test(coarse || ''), 'every part of a message is covered (.msg and .msg *)');
check(/html\.standalone \.msg,html\.standalone \.msg \*,/.test(coarse || ''), 'including in the installed PWA (html.standalone)');
check(/html\.wrapper-app \.msg,html\.wrapper-app \.msg \*,/.test(coarse || ''), 'and in the Tauri wrapper (html.wrapper-app) — the Android app');
check(/user-select:none/.test(coarse || '') && /-webkit-touch-callout:none/.test(coarse || ''),
  'which turns off selection AND the touch callout');
check(/\.msg input,\.msg textarea,/.test(coarse || '') && /user-select:text/.test(coarse || ''),
  'while the one real field a message holds (Edit message) stays selectable');
check(/html\.standalone body,html\.wrapper-app body\{/.test(css),
  'the wrapper gets the standalone shell rules too (it is not display-mode: standalone)');

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
  catch (e) {
    console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
    if (failures.length) process.exit(1);
    return skip('Postgres unreachable (' + ((e && e.message) || e) + ') — docker compose up -d db');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-longpress-'));
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
        JWT_SECRET: 'test-longpress-secret',
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
      body: JSON.stringify({ username: 'lpuser', displayName: 'Long Press', password: 'passw0rd!x' }),
    })).json();
    if (!reg.token) return fail('register failed: ' + JSON.stringify(reg));
    const jh = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + reg.token };
    const srv = (await (await fetch(`http://127.0.0.1:${PORT}/api/servers`, { method: 'POST', headers: jh, body: JSON.stringify({ name: 'Longpress' }) })).json()).server;

    // A signed-in socket to post the message we are going to hold a finger on.
    sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(reg.token)}`);
    await new Promise((res, rej) => { sock.once('open', res); sock.once('error', rej); });
    sock.send(JSON.stringify({ t: 'subscribe' }));

    const profile = path.join(tmp, 'chrome');
    chrome = spawn(chromePath, [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
      '--window-size=390,844', 'about:blank',
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
    // A real hold: touchStart, stay down past the app's 550ms, then touchEnd.
    // What happens DURING the hold is the whole point, so the state is read
    // before the finger lifts.
    const holdAt = async (x, y, ms = 900) => {
      const selectBefore = await evaluate(`window.getSelection().toString()`);
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(x), y: Math.round(y) }] });
      await sleep(ms);
      const mid = await evaluate(`(() => {
        const sel = window.getSelection();
        return {
          selected: sel ? sel.toString() : null,
          ranges: sel ? sel.rangeCount : -1,
          sheet: !!document.querySelector('#sheet'),
          ctx: !!document.querySelector('#ctx-menu'),
        };
      })()`);
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(250);
      const after = await evaluate(`(() => {
        const sh = document.querySelector('#sheet');
        return {
          open: !!sh && sh.classList.contains('open'),
          labels: sh ? [...sh.querySelectorAll('.sheet-row')].map((r) => r.textContent.trim()) : [],
          who: sh ? (sh.querySelector('.sheet-who') || {}).textContent : '',
        };
      })()`);
      return { selectBefore, mid, after };
    };
    const closeSheet = async () => { await evaluate(`(() => { try { closeMsgSheet(true); } catch (e) {} })()`); await sleep(120); };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    if (!(await waitFor(`typeof boot === 'function'`))) return fail('the app never loaded');
    await evaluate(`(() => { localStorage.setItem('cf_token', ${JSON.stringify(reg.token)}); localStorage.setItem('cf_sid', ${JSON.stringify(reg.sid)}); return 1; })()`);
    await send('Page.reload');
    if (!(await waitFor(`S.me && S.me.username === 'lpuser'`))) return fail('boots signed in');
    check(await evaluate(`matchMedia('(hover: none)').matches`), 'the page sees a coarse pointer (touch emulation)');

    console.log('\n[1] a message on screen');
    const opened = await evaluate(`(async () => {
      await selectServer(${JSON.stringify(srv.id)});
      const ch = S.serverDetail.channels.find((c) => c.type === 'text');
      if (ch) await selectChannel(ch.id);
      return { serverId: S.serverId, channelId: S.channelId };
    })()`);
    check(!!opened.channelId, 'the server and its text channel are open', opened);
    sock.send(JSON.stringify({ t: 'message', serverId: srv.id, channelId: opened.channelId, content: 'hold me from the left' }));
    if (!(await waitFor(`!!document.querySelector('.msg[data-mid] .text')`))) return fail('the message never rendered');
    await sleep(300);
    const geom = await evaluate(`(() => {
      const msg = document.querySelector('.msg[data-mid]');
      const r = msg.getBoundingClientRect();
      const av = msg.querySelector('.avatar').getBoundingClientRect();
      const when = msg.querySelector('.when').getBoundingClientRect();
      const text = msg.querySelector('.text').getBoundingClientRect();
      return {
        mid: msg.dataset.mid,
        row: [r.left, r.top, r.width, r.height],
        left: { x: r.left + 3, y: r.top + r.height / 2 },
        avatar: { x: av.left + av.width / 2, y: av.top + av.height / 2 },
        when: { x: when.left + when.width / 2, y: when.top + when.height / 2 },
        text: { x: text.left + text.width / 2, y: text.top + text.height / 2 },
        whenText: msg.querySelector('.when').textContent,
      };
    })()`);
    check(!!geom.mid && geom.row[2] > 0, 'the message has real geometry', geom.row);

    console.log('\n[2] nothing in a message can start a native selection on touch');
    const styles = await evaluate(`(() => {
      const msg = document.querySelector('.msg[data-mid]');
      const cs = (el) => { const s = getComputedStyle(el); return { userSelect: s.webkitUserSelect || s.userSelect, callout: s.webkitTouchCallout }; };
      const out = { when: cs(msg.querySelector('.when')), text: cs(msg.querySelector('.text')), body: cs(msg), avatar: cs(msg.querySelector('.avatar')) };
      document.documentElement.classList.add('wrapper-app');
      out.wrapperBody = cs(document.body);
      out.wrapperText = cs(msg.querySelector('.text'));
      document.documentElement.classList.remove('wrapper-app');
      return out;
    })()`);
    check(styles.when.userSelect === 'none', 'the timestamp is not selectable', styles.when);
    check(styles.text.userSelect === 'none', 'nor is the message body', styles.text);
    check(styles.body.userSelect === 'none' && styles.avatar.userSelect === 'none',
      'nor the row and its avatar (the empty left side included)', { body: styles.body, avatar: styles.avatar });
    check(styles.wrapperBody.userSelect === 'none' && styles.wrapperText.userSelect === 'none',
      'the Tauri wrapper (html.wrapper-app) gets the same treatment as the installed PWA',
      { body: styles.wrapperBody, text: styles.wrapperText });

    console.log('\n[3] holding the left side slides the sheet up');
    const left = await holdAt(geom.left.x, geom.left.y);
    check(left.mid.selected === '' && left.mid.ranges <= 1 && !left.mid.selected,
      'the hold selects NOTHING (this was the timestamp highlight)', left.mid);
    check(left.after.open, 'and the message sheet is open', left.after);
    check(!left.mid.ctx, 'never the desktop right-click popup', left.mid);
    check(left.after.labels.some((l) => l.includes('Copy text')),
      'with Copy text in it, so nothing was lost by turning selection off', left.after.labels);
    await closeSheet();

    console.log('\n[4] …and from the timestamp, the avatar and the body');
    const onWhen = await holdAt(geom.when.x, geom.when.y);
    check(onWhen.after.open && onWhen.mid.selected === '', 'holding the timestamp opens the sheet, selects nothing', { mid: onWhen.mid, open: onWhen.after.open });
    await closeSheet();
    const onAvatar = await holdAt(geom.avatar.x, geom.avatar.y);
    check(onAvatar.after.open && onAvatar.mid.selected === '', 'holding the avatar opens the sheet, selects nothing', { mid: onAvatar.mid, open: onAvatar.after.open });
    await closeSheet();
    const onText = await holdAt(geom.text.x, geom.text.y);
    check(onText.after.open && onText.mid.selected === '', 'holding the message text opens the sheet, selects nothing', { mid: onText.mid, open: onText.after.open });
    await closeSheet();

    console.log('\n[5] the sheet still acts on the right message');
    const mid = await evaluate(`document.querySelector('.msg[data-mid]').dataset.mid`);
    const acted = await holdAt(geom.left.x, geom.left.y);
    check(acted.after.who && acted.after.who.includes('Long Press'), 'the sheet is headed by the message author', acted.after);
    check(!!mid && acted.after.labels.length > 0, 'and carries the message actions', acted.after.labels.slice(0, 4));
    await closeSheet();
    // A tap still opens the user card etc. — the hold must not have eaten clicks.
    const tapped = await evaluate(`(() => {
      const msg = document.querySelector('.msg[data-mid] .text');
      const r = msg.getBoundingClientRect();
      return { x: Math.round(r.left + 10), y: Math.round(r.top + Math.min(8, r.height / 2)) };
    })()`);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tapped.x, y: tapped.y }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(200);
    check(!(await evaluate(`!!document.querySelector('#sheet')`)), 'a plain tap does not leave a sheet open');

    const realErrors = pageErrors.filter((e) => e && !/favicon|Failed to load resource/i.test(e));
    check(realErrors.length === 0, 'no page exceptions', realErrors.slice(0, 3));
  } catch (e) {
    console.error('[test] ' + (e && e.stack || e));
    process.exit(1);
  } finally {
    try { if (sock) sock.close(); } catch {}
    try { if (ws) ws.close(); } catch {}
    try { if (chrome) chrome.kill(); } catch {}
    try { if (child) child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}
main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
