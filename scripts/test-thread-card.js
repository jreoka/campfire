// The thread card under a root message.
//
// The old affordance was a bare line of text ("3 replies →") at the end of the
// message. It says how MANY, never WHAT — opening the panel was the only way to
// find out whether the thread was worth opening. The card replaces it with the
// thread's newest reply: author, the first reaction on it, the snippet (or that
// a file was sent), and when. This drives the real page in headless Chrome
// against a real server (skips without Chrome or Postgres) and pins the whole
// path:
//
//   - a message with no replies grows no card at all;
//   - a card counts in whole words ("1 Message", "2 Messages") and previews the
//     NEWEST reply — text, author, relative time — with an attachment-only reply
//     reading as its own italic line;
//   - a reaction on the previewed reply shows as the card's chip, live, and is
//     taken back with it;
//   - the card arrives on a live push and comes back identically from a reload
//     (the server hydrates `threadLast`, it is not a client-only illusion);
//   - the whole card is one button: clicking the PREVIEW (not a word at the end
//     of it) opens the thread;
//   - deleting the previewed reply never leaves its words in the card: with the
//     panel open the card falls back to the reply before it, and with it closed
//     to the bare label — and a reload reads the real newest reply back.
//
// Usage: node scripts/test-thread-card.js
//   (PGPASSWORD=<the db password> if it is not in .env — see .env.example)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_test_threadcard';
const PORT = parseInt(process.env.TEST_PORT || '3433', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9433', 10);

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-threadcard-'));
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
        JWT_SECRET: 'test-thread-card-secret',
        UPLOAD_DIR: uploads,
        VIRUS_SCAN: '0',
        MEDIA_COMPRESS: '0',
        BUCKET_SCAN_FIRST_MS: '3600000',
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
    await send('Page.enable');
    await send('Runtime.enable');
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    if (!(await waitFor(`typeof boot === 'function'`))) return fail('the app never loaded');

    console.log('\n[1] sign in and open a channel');
    await evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'threader', displayName: 'Thread Tester', password: 'passw0rd!x' }) });
      const d = await r.json();
      store.token = d.token; store.sid = d.sid;
    })()`);
    await send('Page.reload');
    if (!(await waitFor(`S.me && S.me.username === 'threader'`))) return fail('never booted signed in');
    const srv = await evaluate(`(async () => {
      const r = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: 'Thread Lab' }) });
      await refreshServers(r.server.id);
      if (S.ws) S.ws.send(JSON.stringify({ t: 'subscribe' }));
      await selectServer(r.server.id);
      return { sid: r.server.id, cid: S.channelId };
    })()`);
    if (!srv || !srv.cid) return fail('no channel open');

    // Post through the socket the way the composer does. A reply NEVER lands in
    // the channel list (it lives in the panel, and only the root's card changes),
    // so a reply is waited for as the card effect it must have, and its id is
    // read back from the thread endpoint the panel itself uses.
    const idOf = async (content) => {
      const rows = await evaluate(`(async () => {
        const r = await api('/api/servers/' + S.serverId + '/channels/' + S.channelId + '/threads/${rootId}');
        return r.replies.map((x) => ({ id: x.id, content: x.content }));
      })()`);
      const hit = (rows || []).filter((x) => x.content === content).pop();
      if (!hit) throw new Error('no reply with content ' + JSON.stringify(content) + ' — got ' + JSON.stringify(rows));
      return hit.id;
    };
    const post = async (content, threadRoot, attachments) => {
      // A reply NEVER lands in the channel list (it lives in the panel; only the
      // root's card changes), so a reply is waited for as the card effect it has
      // to have, and its id is read back from the thread endpoint the panel uses.
      let expect = 0;
      if (threadRoot) {
        expect = await evaluate(`(() => { const r = (S.messages.get(S.channelId) || []).find((x) => x.id === ${JSON.stringify(threadRoot)}); return r ? (r.threadCount || 0) + 1 : null; })()`);
        if (expect == null) throw new Error('root not in the channel model: ' + threadRoot);
      }
      const payload = { t: 'message', serverId: srv.sid, channelId: srv.cid, content, replyTo: null, threadRoot: threadRoot || null, attachments: attachments || [] };
      await evaluate(`(() => { S.ws.send(${JSON.stringify(JSON.stringify(payload))}); return true; })()`);
      const ok = await waitFor(threadRoot
        ? `(() => { const r = (S.messages.get(S.channelId) || []).find((x) => x.id === ${JSON.stringify(threadRoot)}); return !!(r && (r.threadCount || 0) === ${expect}); })()`
        : `(() => (S.messages.get(S.channelId) || []).some((x) => x.content === ${JSON.stringify(content)}))()`, 15000);
      if (!ok) {
        const dump = await evaluate(`(S.messages.get(S.channelId) || []).map((x) => ({ c: x.content, t: x.threadRoot, n: x.threadCount, a: (x.attachments || []).length }))`);
        throw new Error('message never landed: ' + JSON.stringify({ content, threadRoot, dump }) + '\n--- server log ---\n' + serverLog.slice(-2000));
      }
      if (threadRoot) return idOf(content);
      return evaluate(`(() => { const m = (S.messages.get(S.channelId) || []).find((x) => x.content === ${JSON.stringify(content)}); return m ? m.id : null; })()`);
    };
    // The card's own state, re-read from the DOM every time (a repaint replaces
    // the node, so holding one would be holding a detached element).

    console.log('\n[2] a message with no replies grows no card');
    const rootId = await post('kick off the release notes');
    await sleep(300);
    const bare = await evaluate(`(() => {
      const msg = document.querySelector('.msg[data-mid="${rootId}"]');
      return { found: !!msg, card: !!(msg && msg.querySelector('.thread-link')) };
    })()`);
    check(bare.found, 'the root message rendered');
    check(bare.card === false, 'and it carries no thread card yet', bare);

    console.log('\n[3] the first reply becomes the card — count, author, preview');
    const uploaded = await evaluate(`(async () => {
      const fd = new FormData();
      fd.append('file', new Blob(['not a real png, but a file by name\\n'], { type: 'image/png' }), 'screenshot.png');
      const r = await (await fetch('/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + store.token }, body: fd })).json();
      return r;
    })()`);
    if (!uploaded || !uploaded.url) return fail('the upload never answered');
    const reply1 = await post('', rootId, [{ url: uploaded.url, name: uploaded.name, mime: uploaded.mime, size: uploaded.size, kind: uploaded.kind }]);
    const state = () => evaluate(`(() => {
      const msg = document.querySelector('.msg[data-mid="${rootId}"]');
      const card = msg && msg.querySelector('.thread-link');
      if (!card) return { card: false };
      const t = (s) => { const e = card.querySelector(s); return e ? e.textContent.trim() : null; };
      return {
        card: true, tag: card.tagName, label: t('.tc-label'), count: t('.tc-count'),
        who: t('.tc-who'), react: t('.tc-react'), text: t('.tc-text'),
        att: !!card.querySelector('.tc-text.att'), when: t('.tc-when'),
        rows: card.querySelectorAll('.tc-top, .tc-last').length,
      };
    })()`);
    let cs = await waitFor(`(() => {
      const msg = document.querySelector('.msg[data-mid="${rootId}"]');
      return !!(msg && msg.querySelector('.thread-link .tc-last'));
    })()`) ? await state() : { card: false };
    check(cs.card && cs.tag === 'BUTTON', 'the card is one button on the root', cs);
    check(cs.label === 'Thread', 'labelled "Thread"', cs);
    check(cs.count === '1 Message ›', 'counting in whole words', cs);
    check(cs.who === 'Thread Tester', 'naming the reply\'s author', cs);
    check(cs.att && cs.text === 'sent an attachment', 'an attachment-only reply reads as its own line', cs);
    check(!!cs.when && /now|ago/.test(cs.when), 'and stamps when it landed', cs);
    check(cs.rows === 2, 'two rows: the label and the preview', cs);

    console.log('\n[4] a reaction on the previewed reply is the card\'s chip, live');
    await evaluate(`(async () => {
      await api('/api/messages/${reply1}/reactions', { method: 'POST', body: JSON.stringify({ emoji: '👍' }) });
      return true;
    })()`);
    const chip = await waitFor(`(() => {
      const c = document.querySelector('.msg[data-mid="${rootId}"] .thread-link .tc-react');
      return c ? c.textContent.trim() : false;
    })()`);
    check(chip === '👍', 'the reaction appears in the card without a reload', chip);
    await evaluate(`(async () => {
      await api('/api/messages/${reply1}/reactions', { method: 'POST', body: JSON.stringify({ emoji: '👍' }) });
      return true;
    })()`);
    const noChip = await waitFor(`(() => !document.querySelector('.msg[data-mid="${rootId}"] .thread-link .tc-react'))()`);
    check(!!noChip, 'and is taken back with the reaction');

    console.log('\n[5] a newer reply takes over the preview');
    const reply2 = await post('second reply, much newer', rootId);
    const cs2 = await waitFor(`(() => {
      const c = document.querySelector('.msg[data-mid="${rootId}"] .thread-link');
      return c && c.querySelector('.tc-count').textContent.trim() === '2 Messages ›' && c.querySelector('.tc-text');
    })()`) ? await state() : { card: false };
    check(cs2.count === '2 Messages ›', 'the count follows', cs2);
    check(cs2.text === 'second reply, much newer', 'and so does the preview', cs2);
    check(cs2.att === false, 'plain text is not styled as the attachment placeholder', cs2);

    console.log('\n[6] a reload reads the same card back from the server');
    await send('Page.reload');
    if (!(await waitFor(`S.me && S.me.username === 'threader'`))) return fail('reload never booted');
    await waitFor(`(() => {
      const c = document.querySelector('.msg[data-mid="${rootId}"] .thread-link');
      return !!(c && c.querySelector('.tc-text'));
    })()`);
    const cs3 = await state();
    check(cs3.count === '2 Messages ›', 'the hydrated card counts the same', cs3);
    check(cs3.text === 'second reply, much newer', 'and previews the same newest reply', cs3);

    console.log('\n[7] the whole card is the click target');
    await evaluate(`(() => {
      const p = document.querySelector('.msg[data-mid="${rootId}"] .thread-link .tc-last');
      p.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    const opened = await waitFor(`(() => {
      const p = document.querySelector('#thread-panel');
      return !!(p && !p.classList.contains('hidden') && /second reply, much newer/.test(document.querySelector('#thread-replies').textContent || ''));
    })()`, 10000);
    check(!!opened, 'clicking the PREVIEW opens the thread panel');

    console.log('\n[8] deleting the previewed reply never leaves its words in the card');
    await evaluate(`(async () => { await api('/api/messages/${reply2}', { method: 'DELETE' }); return true; })()`);
    const afterDelete = await waitFor(`(() => {
      const c = document.querySelector('.msg[data-mid="${rootId}"] .thread-link');
      return c && c.querySelector('.tc-count').textContent.trim() === '1 Message ›' ? true : false;
    })()`) ? await state() : { card: false };
    check(afterDelete.count === '1 Message ›', 'the count drops back', afterDelete);
    check(afterDelete.text === 'sent an attachment', 'with the panel open the card falls back to the reply before it', afterDelete);
    check(!/second reply/.test(JSON.stringify(afterDelete)), 'the deleted reply\'s words are gone', afterDelete);

    console.log('\n[9] with the panel closed a delete falls back to the bare label');
    const reply3 = await post('third reply, to be removed', rootId);
    await waitFor(`(() => {
      const c = document.querySelector('.msg[data-mid="${rootId}"] .thread-link .tc-text');
      return c && c.textContent.trim() === 'third reply, to be removed';
    })()`);
    await evaluate(`(() => { closeThread(true); return true; })()`);
    await evaluate(`(async () => { await api('/api/messages/${reply3}', { method: 'DELETE' }); return true; })()`);
    const afterDelete2 = await waitFor(`(() => {
      const c = document.querySelector('.msg[data-mid="${rootId}"] .thread-link');
      return c && c.querySelector('.tc-count').textContent.trim() === '1 Message ›' ? true : false;
    })()`) ? await state() : { card: false };
    check(afterDelete2.count === '1 Message ›', 'the count drops again', afterDelete2);
    check(afterDelete2.card && !afterDelete2.text, 'and the card is the label alone — no stale preview', afterDelete2);

    console.log('\n[10] a reload reads the real newest reply back');
    await send('Page.reload');
    if (!(await waitFor(`S.me && S.me.username === 'threader'`))) return fail('reload never booted');
    await waitFor(`(() => {
      const c = document.querySelector('.msg[data-mid="${rootId}"] .thread-link .tc-text');
      return !!(c && c.textContent.trim() === 'sent an attachment');
    })()`);
    const cs4 = await state();
    check(cs4.count === '1 Message ›', 'the label is filled back in from the server', cs4);
    check(cs4.text === 'sent an attachment', 'with the surviving reply as the preview', cs4);

    console.log('\n[11] the card fits a phone');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await sleep(500);
    const phone = await evaluate(`(() => {
      const card = document.querySelector('.msg[data-mid="${rootId}"] .thread-link');
      const body = card.closest('.body');
      const cb = card.getBoundingClientRect(), bb = body.getBoundingClientRect();
      const row = card.querySelector('.tc-last');
      return {
        overflow: card.scrollWidth - card.clientWidth,
        inside: Math.round(cb.right) <= Math.round(bb.right) + 1 && Math.round(cb.width) <= Math.round(bb.width) + 1,
        rowOverflow: row ? row.scrollWidth - row.clientWidth : 0,
        size: [Math.round(cb.width), Math.round(cb.height)],
      };
    })()`);
    check(phone.overflow <= 1, 'nothing overflows the card horizontally', phone);
    check(phone.inside, 'and it stays inside the message', phone);
    check(phone.rowOverflow <= 1, 'the preview row clips with ellipsis, not a scrollbar', phone);
    check(phone.size[0] > 150 && phone.size[1] > 30, 'the card is laid out, not collapsed', phone);

    check(pageErrors.length === 0, 'no uncaught page errors through the whole run', pageErrors.slice(0, 3));
  } catch (e) {
    console.error('\n[test] FAILED:', (e && e.stack) || e);
    failures.push('exception: ' + ((e && e.message) || e));
  } finally {
    try { if (ws) ws.close(); } catch {}
    try { if (chrome) chrome.kill(); } catch {}
    try { if (child) child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    try {
      const drop = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
      await drop.connect();
      await drop.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      await drop.end();
    } catch {}
  }

  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('Thread card: OK');
}

main().catch((e) => { console.error('[test] FAILED:', (e && e.stack) || e); process.exit(1); });
