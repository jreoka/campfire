// The thread bar is the chat bar's own version (see AGENTS.md conventions).
//
// The thread panel's composer used to be a bare textarea with a "Reply" button:
// no tools, no attachments, no mention completion, no markdown backdrop — a form
// field bolted to the bottom of the panel while the surface two inches to its
// left had all of it. It is now the chat bar's own version: the same pill, the
// same in-field controls (+ menu on the phone, attach / emoji / GIF on the
// desktop), the same round send key, and its own chip row and upload cards.
//
// This drives the REAL page in headless Chrome against a real server (skips
// without Chrome or Postgres) and pins the parts that only exist at runtime:
//
//   - the two bars are one design: same pill surface, radius, metrics and send
//     key geometry in the real layout (test-composer-field pins the CSS);
//   - typing in the thread box lights ITS send key (and the chat bar's is not
//     what answers);
//   - the emoji picker opened from the thread bar inserts into the REPLY box;
//   - @mention / #channel / :emoji complete in the reply box, with the popover
//     placed over the thread panel rather than over the chat;
//   - a file picked with the thread bar's paperclip stages on the THREAD (its
//     own chip row and progress card), never on the chat composer beside it;
//   - the reply goes out with those files attached, the chips clear, and the
//     files come back with the thread when the panel is reopened;
//   - Escape / a click elsewhere closes the thread bar's + menu.
//
// Usage: node scripts/test-thread-composer.js
//   (PGPASSWORD=<the db password> if it is not in .env — see .env.example)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_test_threadbar';
const PORT = parseInt(process.env.TEST_PORT || '3439', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9439', 10);

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-threadbar-'));
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
        JWT_SECRET: 'test-thread-bar-secret',
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

    const profile = path.join(tmp, 'chrome');
    chrome = spawn(chromePath, [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
      '--window-size=1400,900', 'about:blank',
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

    console.log('\n[1] sign in, open a channel, start a thread');
    await evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'barfly', displayName: 'Bar Fly', password: 'passw0rd!x' }) });
      const d = await r.json();
      store.token = d.token; store.sid = d.sid;
    })()`);
    await send('Page.reload');
    if (!(await waitFor(`S.me && S.me.username === 'barfly'`))) return fail('never booted signed in');
    const srv = await evaluate(`(async () => {
      const r = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: 'Bar Lab' }) });
      await refreshServers(r.server.id);
      if (S.ws) S.ws.send(JSON.stringify({ t: 'subscribe' }));
      await selectServer(r.server.id);
      return { sid: r.server.id, cid: S.channelId };
    })()`);
    if (!srv || !srv.cid) return fail('no channel open');
    await evaluate(`(() => { S.ws.send(JSON.stringify({ t: 'message', serverId: S.serverId, channelId: S.channelId, content: 'thread root' })); return true; })()`);
    const rootId = await waitFor(`(() => { const m = (S.messages.get(S.channelId) || []).find((x) => x.content === 'thread root'); return m ? m.id : false; })()`);
    if (!rootId) return fail('the root never landed');
    await waitFor(`(() => {
      const c = document.querySelector('.msg[data-mid="${rootId}"] .thread-link');
      return !!c;
    })()`, 1000).catch(() => {});
    // A root with replies is what shows the card; a reply makes the thread real.
    await evaluate(`(() => { S.ws.send(JSON.stringify({ t: 'message', serverId: S.serverId, channelId: S.channelId, content: 'first reply', threadRoot: ${JSON.stringify(rootId)} })); return true; })()`);
    await waitFor(`(() => { const r = (S.messages.get(S.channelId) || []).find((x) => x.id === ${JSON.stringify(rootId)}); return !!(r && r.threadCount === 1); })()`);
    await waitFor(`(() => !!document.querySelector('.msg[data-mid="${rootId}"] .thread-link .tc-last'))()`);
    await evaluate(`(() => { document.querySelector('.msg[data-mid="${rootId}"] .thread-link').click(); return true; })()`);
    if (!(await waitFor(`(() => { const p = document.querySelector('#thread-panel'); return p && !p.classList.contains('hidden') && !!document.querySelector('.thread-link') && S.thread; })()`))) {
      return fail('the thread panel never opened');
    }
    // The rise animation scales the panel on its first frame; let it settle so the
    // geometry below is the layout the reader ends up with.
    await sleep(400);

    console.log('\n[2] the two bars are one design');
    const geo = await evaluate(`(() => {
      const R = (s) => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect(); return { t: +b.top.toFixed(1), l: +b.left.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), b: +b.bottom.toFixed(1), r: +b.right.toFixed(1) }; };
      const cs = (s, p) => getComputedStyle(document.querySelector(s))[p];
      return {
        chatField: R('#in-render'), threadField: R('#thread-render'),
        chatSend: R('#composer .send-btn'), threadSend: R('#thread-composer .send-btn'),
        chatInput: { font: cs('#in-message', 'fontSize'), line: cs('#in-message', 'lineHeight'), pad: cs('#in-message', 'padding') },
        threadInput: { font: cs('#in-thread', 'fontSize'), line: cs('#in-thread', 'lineHeight'), pad: cs('#in-thread', 'padding') },
        chatSurface: { bg: cs('#in-render', 'backgroundColor'), radius: cs('#in-render', 'borderRadius') },
        threadSurface: { bg: cs('#thread-render', 'backgroundColor'), radius: cs('#thread-render', 'borderRadius') },
        threadTools: ['#tbtn-attach', '#tbtn-emoji', '#tbtn-gif', '#tbtn-more'].map((s) => cs(s, 'display')),
        chatTools: ['#btn-attach', '#btn-emoji', '#btn-gif', '#btn-more'].map((s) => cs(s, 'display')),
        threadPlus: cs('#tbtn-plus', 'display'), chatPlus: cs('#btn-plus', 'display'),
        chatRowAlign: cs('#composer', 'align-items'), threadRowAlign: cs('#thread-composer-row', 'align-items'),
      };
    })()`);
    check(!!geo.threadField && Math.abs(geo.threadField.h - geo.chatField.h) <= 0.5,
      'the reply pill is exactly as tall as the message pill', { thread: geo.threadField, chat: geo.chatField });
    check(geo.threadSurface.bg === geo.chatSurface.bg && geo.threadSurface.radius === geo.chatSurface.radius,
      'same surface and radius', { chat: geo.chatSurface, thread: geo.threadSurface });
    check(JSON.stringify(geo.threadInput) === JSON.stringify(geo.chatInput),
      'same type metrics (font, line-height, padding)', { chat: geo.chatInput, thread: geo.threadInput });
    check(!!geo.threadSend && Math.abs(geo.threadSend.h - geo.threadField.h) <= 0.5
      && Math.abs(geo.threadSend.t - geo.threadField.t) <= 0.5 && Math.abs(geo.threadSend.b - geo.threadField.b) <= 0.5,
      'and the round send key lands on the pill\'s own edges', { send: geo.threadSend, field: geo.threadField });
    check(geo.threadRowAlign === 'flex-end' && geo.chatRowAlign === 'flex-end', 'both bars bottom-align the key',
      { thread: geo.threadRowAlign, chat: geo.chatRowAlign });
    check(geo.threadPlus === geo.chatPlus && JSON.stringify(geo.threadTools) === JSON.stringify(geo.chatTools),
      'the same controls are visible on both bars (attach / emoji / GIF on the desktop, + menu on a phone)',
      { plus: [geo.chatPlus, geo.threadPlus], chat: geo.chatTools, thread: geo.threadTools });

    console.log('\n[3] each bar\'s key reads its own box');
    const keys = await evaluate(`(() => {
      const st = (s) => { const b = document.querySelector(s); return { off: b.classList.contains('is-off'), disabled: b.disabled }; };
      const out = {};
      document.querySelector('#in-thread').value = '';
      paintComposerSend();
      out.empty = st('#thread-composer .send-btn');
      document.querySelector('#in-thread').value = 'a reply';
      document.querySelector('#in-thread').dispatchEvent(new Event('input', { bubbles: true }));
      out.typedThread = st('#thread-composer .send-btn');
      out.chatUntouched = st('#composer .send-btn');
      document.querySelector('#in-message').value = 'a channel message';
      document.querySelector('#in-message').dispatchEvent(new Event('input', { bubbles: true }));
      out.both = { thread: st('#thread-composer .send-btn'), chat: st('#composer .send-btn') };
      document.querySelector('#in-thread').value = '';
      document.querySelector('#in-message').value = '';
      document.querySelector('#in-thread').dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#in-message').dispatchEvent(new Event('input', { bubbles: true }));
      return out;
    })()`);
    check(keys.empty.off && keys.empty.disabled, 'an empty reply box leaves the reply key muted', keys.empty);
    check(!keys.typedThread.off && keys.chatUntouched.off, 'typing a reply lights the reply key and leaves the chat key alone', keys);
    check(!keys.both.thread.off && !keys.both.chat.off, 'and each lights for its own text', keys.both);

    console.log('\n[4] the emoji picker inserts into the reply box');
    await evaluate(`(() => { document.querySelector('#tbtn-emoji').click(); return true; })()`);
    const pickerOpen = await waitFor(`(() => { const p = document.querySelector('#picker'); return p && !p.classList.contains('hidden') && S.picker && S.picker.input === 'thread'; })()`);
    check(!!pickerOpen, 'the thread bar\'s emoji button opens the picker, told which bar it serves');
    await evaluate(`(() => { document.querySelector('#in-thread').focus(); document.querySelector('#in-thread').value = 'hello '; insertAtCursor(document.querySelector('#in-thread'), '🎉'); return true; })()`);
    await sleep(200);
    check(await evaluate(`document.querySelector('#in-thread').value`) === 'hello 🎉',
      'and the pick lands in the reply box', await evaluate(`document.querySelector('#in-thread').value`));
    check(await evaluate(`document.querySelector('#thread-render-inner').innerHTML.length > 0`),
      'the reply box paints the same live backdrop as the chat box');
    await evaluate(`(() => { closePicker(); return true; })()`);

    console.log('\n[5] @mention / #channel / :emoji complete in the reply box');
    const mention = await evaluate(`(async () => {
      const inp = document.querySelector('#in-thread');
      inp.value = '@bar';
      inp.selectionStart = inp.selectionEnd = 4;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      const pop = document.querySelector('#mention-pop');
      const box = document.querySelector('#thread-composer-box').getBoundingClientRect();
      const pr = pop.getBoundingClientRect();
      return { open: !pop.classList.contains('hidden'), items: pop.querySelectorAll('.mention-item').length, overPanel: pr.left >= box.left - 40 && pr.bottom <= box.top + 2 };
    })()`);
    check(mention.open && mention.items > 0, 'typing @ in the reply box offers the roster', mention);
    check(mention.overPanel, 'with the popover placed over the thread panel, not the chat', mention);
    const completed = await evaluate(`(() => {
      const item = document.querySelector('#mention-pop .mention-item');
      if (!item) return null;
      item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      const v = document.querySelector('#in-thread').value;
      document.querySelector('#in-thread').value = '';
      document.querySelector('#in-thread').dispatchEvent(new Event('input', { bubbles: true }));
      return v;
    })()`);
    check(!!completed && /^@barfly /.test(completed), 'and picking one completes it into the reply box', completed);
    const chan = await evaluate(`(async () => {
      const inp = document.querySelector('#in-thread');
      inp.value = '#gen';
      inp.selectionStart = inp.selectionEnd = 4;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      const pop = document.querySelector('#chan-pop');
      const open = !pop.classList.contains('hidden') && pop.querySelectorAll('.mention-item').length > 0;
      const item = pop.querySelector('.mention-item');
      if (item) item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      const v = document.querySelector('#in-thread').value;
      document.querySelector('#in-thread').value = '';
      document.querySelector('#in-thread').dispatchEvent(new Event('input', { bubbles: true }));
      return { open, v };
    })()`);
    check(chan.open && /^#general /.test(chan.v), 'a #channel completes there too', chan);
    const emoji = await evaluate(`(async () => {
      const inp = document.querySelector('#in-thread');
      inp.value = ':fir';
      inp.selectionStart = inp.selectionEnd = 4;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      const pop = document.querySelector('#emoji-pop');
      const open = !pop.classList.contains('hidden') && pop.querySelectorAll('.emoji-item').length > 0;
      const item = pop.querySelector('.emoji-item');
      const name = item ? item.dataset.name : null;
      if (item) item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      const v = document.querySelector('#in-thread').value;
      document.querySelector('#in-thread').value = '';
      document.querySelector('#in-thread').dispatchEvent(new Event('input', { bubbles: true }));
      return { open, v, name };
    })()`);
    check(emoji.open && !!emoji.name && emoji.v === ':' + emoji.name + ': ', 'and a :shortcode: completes', emoji);

    console.log('\n[6] a file picked for a reply stages on the THREAD');
    const staged = await evaluate(`(async () => {
      const inp = document.querySelector('#in-thread-attach');
      const dt = new DataTransfer();
      dt.items.add(new File(['reply notes, a harmless text file\\n'], 'reply-notes.txt', { type: 'text/plain' }));
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    check(!!staged, 'the reply bar takes a file from its own input');
    const settled = await waitFor(`(() => {
      const chip = document.querySelector('#thread-attach-preview .att-chip');
      const card = document.querySelector('#thread-upload-list .up-card');
      if (!chip) return false;
      return { chip: chip.textContent.trim(), cardWas: !!card, chatChips: document.querySelectorAll('#attach-preview .att-chip').length, chatCards: document.querySelectorAll('#upload-list .up-card').length };
    })()`, 20000);
    check(!!settled, 'it becomes a chip on the reply bar', settled);
    check(!!settled && /reply-notes\.txt/.test(settled.chip), 'named for the file', settled && settled.chip);
    check(!!settled && settled.chatChips === 0 && settled.chatCards === 0,
      'and never a chip or card on the chat composer beside it', settled);

    console.log('\n[7] the reply carries it, and the thread keeps it');
    await evaluate(`(() => {
      const inp = document.querySelector('#in-thread');
      inp.value = 'here are the notes';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#thread-composer').requestSubmit();
      return true;
    })()`);
    const sent = await waitFor(`(async () => {
      const r = await api('/api/servers/' + S.serverId + '/channels/' + S.channelId + '/threads/${rootId}');
      const m = r.replies.find((x) => x.content === 'here are the notes');
      return m ? { atts: (m.attachments || []).map((a) => a.name) } : false;
    })()`, 15000);
    check(!!sent && sent.atts.includes('reply-notes.txt'), 'the reply goes out with the file attached', sent);
    const cleared = await waitFor(`(() => document.querySelector('#thread-attach-preview').classList.contains('hidden')
      && document.querySelector('#thread-upload-list').classList.contains('hidden')
      && document.querySelector('#in-thread').value === '')()`);
    check(!!cleared, 'the reply box, its chips and its cards all clear on send');
    const painted = await waitFor(`(() => {
      const box = document.querySelector('#thread-replies');
      return !!box && /here are the notes/.test(box.textContent || '');
    })()`, 10000);
    check(!!painted, 'and the reply renders in the panel with its attachment');

    console.log('\n[8] the + menu is the bar\'s own, and closes like the chat bar\'s');
    const menu = await evaluate(`(() => {
      document.querySelector('#tbtn-more').click();
      const pop = document.querySelector('#thread-composer-more');
      const rows = [...pop.querySelectorAll('.ctx-item')].map((b) => b.textContent.trim());
      const open = !pop.classList.contains('hidden');
      const chat = document.querySelector('#composer-more').classList.contains('hidden');
      return { open, rows, chatStayedShut: chat };
    })()`);
    check(menu.open && menu.chatStayedShut, 'the thread + opens its own menu (the chat bar\'s stays shut)', menu);
    check(menu.rows.length === 3 && /Attach/.test(menu.rows[0]) && /emoji/i.test(menu.rows[1]) && /GIF/.test(menu.rows[2]),
      'carrying the actions a thread reply can actually honour', menu.rows);
    await evaluate(`(() => { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
    check(await waitFor(`document.querySelector('#thread-composer-more').classList.contains('hidden')`),
      'a click elsewhere closes it');
    await evaluate(`(() => { document.querySelector('#tbtn-plus').click(); return true; })()`);
    check(await evaluate(`!document.querySelector('#thread-composer-more').classList.contains('hidden')`), 'and the leading + opens it again');
    await evaluate(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true; })()`);
    check(await waitFor(`document.querySelector('#thread-composer-more').classList.contains('hidden')`), 'Escape closes it');

    console.log('\n[9] a reply draft and its files survive the panel closing');
    await evaluate(`(async () => {
      const inp = document.querySelector('#in-thread-attach');
      const dt = new DataTransfer();
      dt.items.add(new File(['staged for later\\n'], 'later.txt', { type: 'text/plain' }));
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor(`!!document.querySelector('#thread-attach-preview .att-chip')`);
    await evaluate(`(() => {
      const inp = document.querySelector('#in-thread');
      inp.value = 'half-written reply';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(500); // the draft store is debounced
    await evaluate(`(() => { closeThread(true); return true; })()`);
    check(await waitFor(`document.querySelector('#thread-panel').classList.contains('hidden')`), 'the panel closes');
    await evaluate(`(() => { openThread(${JSON.stringify(rootId)}); return true; })()`);
    const restored = await waitFor(`(() => {
      const chip = document.querySelector('#thread-attach-preview .att-chip');
      if (!chip) return false;
      return { draft: document.querySelector('#in-thread').value, chip: chip.textContent.trim() };
    })()`, 10000);
    check(!!restored && restored.draft === 'half-written reply', 'the half-written reply comes back with the thread', restored);
    check(!!restored && /later\.txt/.test(restored.chip), 'and so does the file staged for it', restored);

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
  console.log('Thread bar: OK');
}

main().catch((e) => { console.error('[test] FAILED:', (e && e.stack) || e); process.exit(1); });
