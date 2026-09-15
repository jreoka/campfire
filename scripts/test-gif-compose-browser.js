// A GIF picked while a message is being written, end-to-end in a real browser.
//
// The request: "if i have a message typed out and i click a gif can it attach
// the gif to the message then i can send it instead of sending the gif
// separately". scripts/test-gif-compose.js proves the logic against fakes; this
// one proves the PAGE behaves — the real composer, the real chip stage, the real
// socket. It picks a GIF twice: with an empty box (still one click → one
// message) and with words in it (a chip appears, nothing is posted, and the
// reader's Send puts text + GIF out as ONE message, in a channel and in a DM).
//
// `sendGif` is called directly with a Klipy-shaped object: the tiles come from
// Klipy's API, which a test must not depend on. Everything downstream of the
// tile is the app's own code.
//
// Boots a real server against a throwaway database, drives Chrome over the
// DevTools protocol (no puppeteer — plain CDP over ws).
//
// Skips (exit 0) when Postgres or Chrome is unavailable.
//
// Usage: node scripts/test-gif-compose-browser.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_gifcompose_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3447', 10);
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

const GIF = {
  slug: 'sunday-al', title: 'Al Roker Shouts Sunday',
  gif: 'https://static.klipy.com/ii/d7ae/5e/90/UPvW7RGb.gif',
  thumb: 'https://static.klipy.com/ii/d7ae/5e/90/wDpY3Hvl.gif',
  mp4: 'https://static.klipy.com/ii/d7ae/5e/90/foquSkvAvV5CbRDkLsdl.mp4',
  w: 640, h: 398,
};
// A 1x1 GIF: what every static.klipy.com request in this test is answered with.
const TINY_GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-gifcompose-e2e-'));
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
        JWT_SECRET: 'test-gif-compose',
        UPLOAD_DIR: uploads,
        UNFURL: '0',
        VIRUS_SCAN: '0', MEDIA_COMPRESS: '0',
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
    let cdnFulfilled = 0;
    const cdnErrors = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
      } else if (m.method === 'Fetch.requestPaused') {
        // The Klipy CDN is answered locally with a real 1x1 GIF, so the picture
        // actually paints. Without this the URL is unreachable and the chat does
        // what it is designed to do with a dead picture — swaps it for a file
        // card — which is honest, but not what this test is about.
        send('Fetch.fulfillRequest', {
          requestId: m.params.requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'image/gif' }],
          body: TINY_GIF,
        }).then(() => { cdnFulfilled++; }, (e) => { cdnErrors.push(String(e && e.message || e)); });
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
    const type = (text) => evaluate(`(() => { const i = document.querySelector('#in-message'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return i.value; })()`);
    // The picker's own tile handler, minus the tile: the app's real entry point.
    const pick = (gif) => evaluate(`(() => { sendGif(${JSON.stringify(gif)}); return true; })()`);
    const chips = () => evaluate(`[...document.querySelectorAll('#attach-preview .att-chip')].map((c) => ({
      name: (c.querySelector('.chip-name') || {}).textContent || '',
      sub: (c.querySelector('.chip-sub') || {}).textContent || '',
      thumb: (c.querySelector('img.chip-thumb') || {}).getAttribute ? c.querySelector('img.chip-thumb').getAttribute('src') : null,
      spoiler: !!c.querySelector('button[title="Mark as spoiler"]'),
    }))`);

    await send('Page.enable');
    await send('Runtime.enable');
    // The app's service worker proxies EVERY GET (including these cross-origin
    // gif requests) through its own target, which the page's Fetch domain never
    // sees — bypass it so the interception below is what answers them.
    await send('Network.enable');
    await send('Network.setBypassServiceWorker', { bypass: true });
    // Every Klipy CDN request is fulfilled locally (see Fetch.requestPaused).
    await send('Fetch.enable', { patterns: [{ urlPattern: 'https://static.klipy.com/*' }] });
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    check(!!(await waitFor(`typeof sendGif === 'function'`)), 'the app loads');

    console.log('\n[1] sign in and open a channel');
    const reg = await evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'gifcomposer', displayName: 'Gif Composer', password: 'passw0rd!x' }) });
      const d = await r.json();
      store.token = d.token; store.sid = d.sid;
      return { ok: !!d.token };
    })()`);
    check(!!reg.ok, 'registered an account');
    await send('Page.reload');
    check(!!(await waitFor(`S.me && S.me.username === 'gifcomposer'`)), 'boots signed in');
    const srv = await evaluate(`(async () => {
      const r = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: 'GIF Lab' }) });
      await refreshServers(r.server.id);
      if (S.ws) S.ws.send(JSON.stringify({ t: 'subscribe' }));
      await selectServer(r.server.id);
      return { sid: r.server.id, cid: S.channelId };
    })()`);
    check(!!srv.cid, 'a channel is open', srv);

    console.log('\n[2] an empty composer: the click IS the message');
    const one = await evaluate(`(async () => {
      const before = (S.messages.get(S.channelId) || []).length;
      sendGif(${JSON.stringify(GIF)});
      await new Promise((r) => setTimeout(r, 900));
      const list = S.messages.get(S.channelId) || [];
      const last = list[list.length - 1] || {};
      return { before, after: list.length, content: last.content, atts: (last.attachments || []).length, url: ((last.attachments || [])[0] || {}).url, staged: S.pendingAtts.length };
    })()`);
    check(one.after === one.before + 1 && one.atts === 1 && one.url === GIF.gif,
      'it posts on the click, as its own message', one);
    check(one.content === '' && one.staged === 0,
      'with no text and nothing left staged on the composer', one);
    check((await chips()).length === 0, 'so the chip stage stays empty');

    console.log('\n[3] a message being written: the click ATTACHES it');
    await type('look at this');
    await pick(GIF);
    await sleep(500);
    const staged = await chips();
    const state = await evaluate(`({ staged: S.pendingAtts.length, url: (S.pendingAtts[0] || {}).url, msgs: (S.messages.get(S.channelId) || []).length, off: document.querySelector('#composer .send-btn').classList.contains('is-off') })`);
    check(state.staged === 1 && state.url === GIF.gif, 'the GIF is staged on the composer', state);
    check(state.msgs === one.after, 'and NOTHING was posted — the reader still owns the Send', state);
    check(staged.length === 1 && staged[0].sub === 'GIF' && staged[0].thumb === GIF.thumb,
      'the chip shows the Klipy thumb and reads "GIF" (not the "0 B" it would otherwise say)', staged);
    check(staged[0].spoiler === true, 'and it is a real attachment chip, with the Spoiler toggle', staged[0]);
    check(state.off === false, 'the send key is lit (there is something to send)', state);
    const textKept = await evaluate(`document.querySelector('#in-message').value`);
    check(textKept === 'look at this', 'and the words are still in the box', { textKept });

    console.log('\n[4] Send puts the words and the GIF out as ONE message');
    const sent = await evaluate(`(async () => {
      document.querySelector('#composer').requestSubmit();
      await new Promise((r) => setTimeout(r, 900));
      const list = S.messages.get(S.channelId) || [];
      const last = list[list.length - 1] || {};
      const a = (last.attachments || [])[0] || {};
      return {
        msgs: list.length, content: last.content, atts: (last.attachments || []).length,
        url: a.url, slug: a.gif_slug, thumb: a.gif_thumb, mp4: a.gif_mp4, w: a.w, h: a.h,
        staged: S.pendingAtts.length, box: document.querySelector('#in-message').value,
        chips: document.querySelectorAll('#attach-preview .att-chip').length,
      };
    })()`);
    check(sent.content === 'look at this' && sent.atts === 1 && sent.url === GIF.gif,
      'the text and the GIF arrived together in one message', sent);
    check(sent.msgs === one.after + 1, 'exactly one new message (the GIF did not go out separately)', sent);
    check(sent.slug === GIF.slug && sent.thumb === GIF.thumb && sent.mp4 === GIF.mp4 && sent.w === 640 && sent.h === 398,
      'with its whole Klipy identity and shape intact (so it is starrable where it lands)', sent);
    check(sent.staged === 0 && sent.box === '' && sent.chips === 0,
      'and the composer is cleared: no box text, no chips, nothing staged', sent);
    const painted = await evaluate(`(() => {
      const els = [...document.querySelectorAll('#messages .msg[data-mid]')];
      const last = els[els.length - 1];
      const img = last && last.querySelector('.att-wrap img');
      return { hasImg: !!img, src: img ? img.getAttribute('src') : null, star: !!(last && last.querySelector('.att-star')) };
    })()`);
    check(painted.hasImg && painted.src === GIF.gif, 'the chat paints the GIF the server echoed back',
      { ...painted, cdn: cdnFulfilled, cdnErrors });
    check(painted.star === true, 'and it carries the favorites star a picker GIF gets', painted);

    console.log('\n[5] the same thing in a DM');
    const dm = await evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'gifpal', displayName: 'Gif Pal', password: 'passw0rd!x' }) });
      const p = await r.json();
      const t = await api('/api/dms', { method: 'POST', body: JSON.stringify({ userId: p.user.id }) });
      await refreshDms();
      await openHome();
      await selectDmThread(t.thread.id);
      return { tid: t.thread.id, view: S.view };
    })()`);
    check(dm.view === 'home' && !!dm.tid, 'a DM is open', dm);
    await type('this one is for you');
    await pick(GIF);
    await sleep(400);
    const dmStaged = await evaluate(`({ staged: S.pendingAtts.length, msgs: (S.dmMessages.get(S.dmThreadId) || []).length, chips: document.querySelectorAll('#attach-preview .att-chip').length })`);
    check(dmStaged.staged === 1 && dmStaged.chips === 1, 'the DM composer stages it too', dmStaged);
    check(dmStaged.msgs === 0, 'and posts nothing yet', dmStaged);
    const dmSent = await evaluate(`(async () => {
      document.querySelector('#composer').requestSubmit();
      await new Promise((r) => setTimeout(r, 900));
      const list = S.dmMessages.get(S.dmThreadId) || [];
      const last = list[list.length - 1] || {};
      const a = (last.attachments || [])[0] || {};
      return { msgs: list.length, content: last.content, url: a.url, slug: a.gif_slug, staged: S.pendingAtts.length };
    })()`);
    check(dmSent.msgs === 1 && dmSent.content === 'this one is for you' && dmSent.url === GIF.gif && dmSent.slug === GIF.slug,
      'and one Send puts the text + GIF out as one DM', dmSent);
    check(dmSent.staged === 0, 'with the composer cleared', dmSent);

    console.log('\n[6] a second GIF stacks on the same message');
    await type('two of them');
    await pick(GIF);
    await sleep(250);
    await pick({ ...GIF, slug: 'second-one', gif: GIF.gif + '?two', title: 'Second' });
    await sleep(300);
    const twoChips = await chips();
    check(twoChips.length === 2, 'both GIFs are staged on the one message', twoChips);
    const cleared = await evaluate(`(() => { S.pendingAtts = []; renderComposerMeta(); document.querySelector('#in-message').value = ''; syncComposerRender(); return document.querySelectorAll('#attach-preview .att-chip').length; })()`);
    check(cleared === 0, 'and dropping them empties the stage again', cleared);

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
