// Scrolling up must not move the reader's line further than their own wheel.
//
// The complaint: "when scrolling up a couple messages it glitches me upwards a
// bit". Everything the list does to a scrolled-up reader is anchored — a
// picture's box is reserved from its stored shape before its bytes arrive (see
// `attachmentHTML`), a full rebuild restores the topmost visible message, and
// the bottom pin only ever pulls a reader who is ON the bottom. So this measures
// the thing the reader actually feels, in the real app, in a real browser:
//
//   k = (the topmost visible message's offset from the viewport top) + scrollTop
//
// k is that message's position IN THE CONVERSATION. Scrolling the list moves
// scrollTop and the line by equal and opposite amounts, so k never changes —
// unless something above the reader changed size. A jump in k IS the glitch,
// and its size says how much of the list moved under them.
//
// A channel with unshaped media (an attachment whose `w`/`h` were never
// recorded — everything uploaded before the shape record, or measured 0/0) is
// the interesting case: the picture lands later and grows the list from a 4:3
// placeholder to the real thing. If that growth is above the reader it is
// exactly "I scrolled up and it threw me further up".
//
// Boots a real server against a throwaway database, drives Chrome over CDP,
// seeds the channel through the API/WS (no puppeteer).
//
// Skips (exit 0) when Postgres or Chrome is unavailable.
//
// Usage: node scripts/test-scroll-up-hold.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_scroll_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3418', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9337', 10);
const CLIP_PORT = parseInt(process.env.TEST_CLIP_PORT || '3440', 10);
const NOTCH = 120;

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

// A real PNG of the given size: a solid colour is enough for a byte-accurate
// upload, and the size is what makes the layout grow when the shape is unknown.
function makePng(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      raw[row + 1 + x * 3] = rgb[0]; raw[row + 2 + x * 3] = rgb[1]; raw[row + 3 + x * 3] = rgb[2];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-scroll-e2e-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });

  let child = null, chrome = null, ws = null, clipServer = null;
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
        JWT_SECRET: 'test-scroll-secret',
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
      try { up = (await fetch(`http://127.0.0.1:${PORT}/api/config`)).ok; } catch {}
      if (!up) await sleep(250);
    }
    if (!up) return fail('server did not come up');
    // /api/config answers before the WS handler's `onMessage` is initialized
    // (it is declared later in server.js), so a frame that arrives in the first
    // moments after listen throws in the server's TDZ. Let it finish booting.
    await sleep(2500);

    // ---------- seed a real conversation ----------
    const api = async (method, p, body, token) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(j)}`);
      return j;
    };
    const reg = await api('POST', '/api/register', { username: 'scrollprobe', displayName: 'Scroll Probe', password: 'passw0rd!x' });
    const token = reg.token;
    const srv = await api('POST', '/api/servers', { name: 'Scroll Lab' }, token);
    const serverId = srv.server.id;
    const channelId = srv.server.channels.find((c) => c.type === 'text').id;
    const upload = async (name, buf, mime) => {
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: mime }), name);
      const res = await fetch(`http://127.0.0.1:${PORT}/api/upload`, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('upload -> ' + res.status + ' ' + JSON.stringify(j));
      return j;
    };
    const tall = await upload('tall.png', makePng(400, 900, [90, 60, 140]), 'image/png');
    const wide = await upload('wide.png', makePng(900, 400, [40, 110, 90]), 'image/png');
    // Videos: their size lives in the container, so the server records no shape
    // for them and the client reserves nothing — the box is the element's
    // default 300x150 until the metadata arrives, then it is the real thing.
    const ff = (args) => new Promise((res, rej) => {
      const p = spawn('ffmpeg', args, { stdio: 'ignore' });
      p.on('error', rej);
      p.on('exit', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exited ' + c))));
    });
    const landPath = path.join(tmp, 'land.mp4'), portPath = path.join(tmp, 'port.mp4');
    await ff(['-y', '-f', 'lavfi', '-i', 'color=c=navy:s=640x360:d=1', '-pix_fmt', 'yuv420p', landPath]);
    await ff(['-y', '-f', 'lavfi', '-i', 'color=c=maroon:s=360x640:d=1', '-pix_fmt', 'yuv420p', portPath]);
    const land = await upload('land.mp4', fs.readFileSync(landPath), 'video/mp4');
    const port = await upload('port.mp4', fs.readFileSync(portPath), 'video/mp4');
    // [3]'s clip: written WITHOUT faststart, so its metadata is in the last
    // bytes of the file. It is served by this test's own little HTTP server,
    // which sends the first bytes and then HOLDS the rest until we say so —
    // that is the only way to control exactly when the box changes under the
    // reader (`preload="metadata"` against a local upload resolves in
    // milliseconds, which is not the state a reader on a phone meets).
    const slowPath = path.join(tmp, 'slow.mp4');
    await ff(['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=8', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-b:v', '1800k', slowPath]);
    const clipBytes = fs.readFileSync(slowPath);
    const clipReqs = [];
    const clipServer2 = clipServer = http.createServer((req, res) => {
      if (!String(req.url).startsWith('/clip.mp4')) { res.writeHead(404); res.end(); return; }
      clipReqs.push({ range: req.headers.range || null, at: Date.now() });
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(clipBytes.length), 'Cache-Control': 'no-store' });
      // The head goes out at once; the rest (metadata included: this file is not
      // faststart) waits a beat, so the box has settled by the time it lands.
      res.write(clipBytes.subarray(0, 2048));
      setTimeout(() => { try { res.end(clipBytes.subarray(2048)); } catch {} }, 2500);
    });
    await new Promise((res) => clipServer2.listen(CLIP_PORT, '127.0.0.1', res));
    const clipUrl = `http://127.0.0.1:${CLIP_PORT}/clip.mp4`;

    // Seeded straight into the database: the WS message path is rate-limited to
    // a dozen per window, and this fixture only has to exist.
    const db = new Client({ ...pg, database: TEST_DB });
    await db.connect();
    const uid = (await db.query('SELECT id FROM users WHERE username = $1', ['scrollprobe'])).rows[0].id;
    const lines = ['first line of the message', 'a second line that makes the row taller', 'and a third for good measure'];
    // `imgAt` are 1-based message numbers carrying an UNSHAPED picture: w/h NULL
    // is "no measured shape" — the state every upload from before the shape
    // record is in — so the client renders the 4:3 placeholder and the box grows
    // when the bytes land.
    const seedChannel = async (chId, count, imgAt, baseMs, vidAt = [], vidFor = (i) => (i % 2 ? land : port)) => {
      for (let i = 1; i <= count; i++) {
        const mid = 'seed' + chId.slice(0, 4) + '-' + i;
        const content = (imgAt.includes(i) || vidAt.includes(i)) ? `media ${i}` : `message ${i}\n${lines[i % lines.length]}`;
        await db.query('INSERT INTO messages (id, server_id, channel_id, user_id, content, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
          [mid, serverId, chId, uid, content, baseMs + i * 1000]);
        if (imgAt.includes(i)) {
          const up = i % 2 ? wide : tall;
          await db.query('INSERT INTO attachments (id, message_id, url, filename, mime, size, kind, created_at, spoiler, w, h) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,NULL,NULL)',
            ['att' + chId.slice(0, 4) + '-' + i, mid, up.url, up.name, 'image/png', up.size, 'image', baseMs + i * 1000]);
        } else if (vidAt.includes(i)) {
          const up = vidFor(i);
          await db.query('INSERT INTO attachments (id, message_id, url, filename, mime, size, kind, created_at, spoiler, w, h) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,NULL,NULL)',
            ['att' + chId.slice(0, 4) + '-' + i, mid, up.url, up.name, 'video/mp4', up.size, 'video', baseMs + i * 1000]);
        }
      }
    };
    // [1]'s channel: 120 messages, so the newest page is 41..120, with the
    // pictures and videos INSIDE it and far enough above the bottom that the
    // browser's lazy-loading margin has not reached them when the channel opens.
    const t0 = Date.now() - 300000;
    await seedChannel(channelId, 120, [60, 80], t0, [65, 85]);
    // [2]'s channel: 100 messages (newest page 21..100) with the pictures OLDER
    // than the loaded window, so they arrive in the page a scroll-up prepends.
    const ch2 = (await api('POST', `/api/servers/${serverId}/channels`, { name: 'older', type: 'text' }, token)).channel.id;
    await seedChannel(ch2, 100, [5, 8], t0);
    // [3]'s channel: a single unshaped clip in the middle of a text channel —
    // no pictures, no paging near the bottom, nothing else that can move.
    const ch3 = (await api('POST', `/api/servers/${serverId}/channels`, { name: 'clip', type: 'text' }, token)).channel.id;
    await seedChannel(ch3, 40, [], t0, [25], () => ({ url: clipUrl, name: 'clip.mp4', size: clipBytes.length }));
    await db.end();

    // ---------- Chrome + CDP ----------
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
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        pageErrors.push((m.params.args || []).map((a) => a.value || a.description).join(' '));
      }
    });
    const send2 = (method, params = {}) => new Promise((res, rej) => {
      const i = ++msgId;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evaluate = async (expression) => {
      const r = await send2('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
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
    const wheel = async (deltaY, times = 1) => {
      const r = await evaluate(`(() => { const b = document.getElementById('messages').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
      for (let i = 0; i < times; i++) {
        await send2('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'none', buttons: 0 });
        await send2('Input.dispatchMouseEvent', { type: 'mouseWheel', x: r.x, y: r.y, deltaX: 0, deltaY, button: 'none', buttons: 0 });
        await sleep(220);
      }
    };

    const INSTRUMENT = `(() => {
      const box = document.getElementById('messages');
      window.__ev = [];
      const now = () => Math.round(performance.now());
      if (!window.__hooked) {
        window.__hooked = true;
        const st = setScrollTop;
        setScrollTop = function (b, v, intent) {
          let stack = ''; try { stack = (new Error().stack || '').split('\\n').slice(2, 5).map((s) => s.trim()).join(' <- '); } catch {}
          window.__ev.push({ t: now(), k: 'setScrollTop', from: b && Math.round(b.scrollTop), v: Math.round(v), intent, stack });
          return st(b, v, intent);
        };
        const rm = renderMessages;
        renderMessages = function (f) { window.__ev.push({ t: now(), k: 'renderMessages', force: !!f }); return rm(f); };
        if (typeof anchorBottom === 'function') {
          const ab = anchorBottom;
          anchorBottom = function (b) { window.__ev.push({ t: now(), k: 'anchorBottom' }); return ab(b); };
        }
        const mp = maybeLoadOlderMessages;
        maybeLoadOlderMessages = function (b) { window.__ev.push({ t: now(), k: 'maybeLoadOlder', top: b && Math.round(b.scrollTop) }); return mp(b); };
        new MutationObserver((recs) => {
          let adds = 0, rems = 0;
          for (const r of recs) { adds += r.addedNodes.length; rems += r.removedNodes.length; }
          window.__ev.push({ t: now(), k: 'mut', recs: recs.length, adds, rems });
        }).observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
      }
      // The reader's line: the topmost message they can see, tracked by its id
      // so a rebuild that replaces the node still measures the same message.
      window.__line = function (mid) {
        const el = box.querySelector('[data-mid="' + CSS.escape(mid) + '"]');
        if (!el) return null;
        return Math.round((el.getBoundingClientRect().top - box.getBoundingClientRect().top) * 100) / 100;
      };
      window.__topMsg = function () {
        const btop = box.getBoundingClientRect().top;
        for (const el of box.querySelectorAll('.msg')) {
          const r = el.getBoundingClientRect();
          if (r.bottom > btop + 1) return el.dataset.mid || null;
        }
        return null;
      };
      window.__start = function (mid2) {
        window.__samples = [];
        window.__t0 = performance.now();
        const mid = window.__topMsg();
        window.__mid = mid;
        window.__mid2 = mid2 || null;
        const tick = () => {
          const imgs = box.querySelectorAll('img.att-img');
          let pendingImgs = 0;
          for (const im of imgs) if (!im.complete || !im.naturalWidth) pendingImgs++;
          const vids = [...box.querySelectorAll('video.att-vid')];
          const line2 = window.__mid2 ? window.__line(window.__mid2) : null;
          window.__samples.push({
            t: Math.round(performance.now() - window.__t0), top: Math.round(box.scrollTop * 10) / 10,
            line: window.__line(mid), k: null, sh: box.scrollHeight, at: box.dataset.atBottom || null,
            n: box.querySelectorAll('.msg').length, pend: pendingImgs,
            vp: vids.filter((v) => v.readyState < 1).length,
            vh: vids.map((v) => Math.round((v.closest('.att-wrap') || v).getBoundingClientRect().height)).join('/'),
            line2, span: (line2 == null || window.__line(mid) == null) ? null : Math.round((line2 - window.__line(mid)) * 10) / 10,
            bar: !!box.querySelector(':scope > .hist-top'),
          });
          const s = window.__samples[window.__samples.length - 1];
          if (s.line != null) s.k = Math.round((s.line + s.top) * 10) / 10;
          if (performance.now() - window.__t0 < 20000) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      };
      window.__stop = function () {
        const out = { samples: window.__samples, mid: window.__mid, ev: window.__ev, origin: window.__t0 };
        return out;
      };
      window.__geom = function () {
        return { top: Math.round(box.scrollTop), sh: box.scrollHeight, ch: box.clientHeight,
                 max: box.scrollHeight - box.clientHeight, n: box.querySelectorAll('.msg').length,
                 at: box.dataset.atBottom || null };
      };
      return true;
    })()`;

    await send2('Page.enable');
    await send2('Runtime.enable');
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    const loaded = await waitFor(`typeof boot === 'function'`);
    if (!loaded) {
      await sleep(1000);
      console.log('  DEBUG page: ' + JSON.stringify(await evaluate(`({ href: location.href, ready: document.readyState,
        title: document.title, boot: typeof boot, bodyLen: document.body ? document.body.innerHTML.length : -1,
        bodyStart: document.body ? document.body.innerHTML.slice(0, 300) : null })`)));
    }
    check(!!loaded, 'the app loads');
    await evaluate(`localStorage.setItem('cf_token', ${JSON.stringify(token)}); localStorage.setItem('cf_sid', ${JSON.stringify(reg.sid)})`);
    await send2('Page.reload');
    const signedIn = await waitFor(`typeof S !== 'undefined' && S.me && S.me.username === 'scrollprobe'`, 15000);
    if (!signedIn) console.log('  DEBUG boot: ' + JSON.stringify(await evaluate(`({ me: typeof S !== 'undefined' && S.me ? { u: S.me.username } : null,
      auth: (document.querySelector('#view-auth') || {}).className, main: (document.querySelector('#view-main') || {}).className })`)));
    check(!!signedIn, 'boots signed in');
    const opened = await evaluate(`(async () => {
      await refreshServers(${JSON.stringify(serverId)});
      if (S.ws) S.ws.send(JSON.stringify({ t: 'subscribe' }));
      await selectServer(${JSON.stringify(serverId)});
      await selectChannel(${JSON.stringify(channelId)});
      return { cid: S.channelId, n: document.querySelectorAll('#messages .msg').length };
    })()`);
    check(opened.cid === channelId && opened.n > 60, 'the channel is open with its newest page', opened);

    await evaluate(INSTRUMENT);
    // Let the open settle (the bottom hold), then measure the reader's own
    // scrolling. Nothing else is happening in this channel: no socket traffic,
    // no rebuild — just a wheel and whatever the list does about it.
    await sleep(2500);
    const before = await evaluate(`(() => {
      const box = document.getElementById('messages');
      const imgs = [...box.querySelectorAll('img.att-img')];
      return { geom: { top: Math.round(box.scrollTop), max: box.scrollHeight - box.clientHeight },
               atts: imgs.map((im) => ({ fb: im.dataset.fbName, complete: im.complete, nat: im.naturalWidth,
                 wrapH: Math.round((im.closest('.att-wrap') || { getBoundingClientRect: () => ({ height: -1 }) }).getBoundingClientRect().height) })) };
    })()`);
    console.log('  seeded geometry: ' + JSON.stringify(before));
    await evaluate(`__ev = []`);

    console.log('\n[1] scrolling up far enough to meet the unshaped pictures');
    await evaluate(`__start()`);
    await wheel(-NOTCH, 20);
    await sleep(2000);           // let late media land and settle
    const run = await evaluate(`__stop()`);
    const g = await evaluate(`__geom()`);
    const atts = await evaluate(`(() => [...document.querySelectorAll('#messages img.att-img')].map((im) => ({
      fb: im.dataset.fbName, complete: im.complete, nat: im.naturalWidth,
      wrapH: Math.round((im.closest('.att-wrap') || { getBoundingClientRect: () => ({ height: -1 }) }).getBoundingClientRect().height) })))()`);
    console.log('  geometry after: ' + JSON.stringify(g));
    console.log('  pictures: ' + JSON.stringify(atts));
    check(pageErrors.length === 0, 'no uncaught page errors', pageErrors.slice(0, 2));

    // ---- what the samples say ----
    // Two different things can move under a reader who is scrolling up:
    //  - `shove`: the VISIBLE line moved while the scroll position did not —
    //    content above them grew and nothing compensated, so older messages
    //    slide into view. This is the reader's "it glitches me upwards".
    //  - `cancel`: the scroll position moved the other way while the line stood
    //    still — the browser anchored the growth, so the gesture was undone
    //    (visually stable, but the reader loses the ground they scrolled).
    const analyse = (run, label) => {
      const s = run.samples.filter((x) => x.k != null);
      const events = [];
      const slides = [];
      for (let i = 1; i < s.length; i++) {
        // `span` is the content distance between two pinned messages, one at the
        // top of the viewport and one inside it. Scrolling cannot change it —
        // only a box between them changing size can — so a jump in `span` IS
        // the reader's "the messages slid", and it is the case the browser's own
        // anchoring cannot cover (the node it pins is the one that grew).
        if (s[i].span != null && s[i - 1].span != null) {
          const dspan = Math.round((s[i].span - s[i - 1].span) * 10) / 10;
          if (Math.abs(dspan) > 1.5) slides.push({ t: s[i].t, dspan, top: s[i].top, sh: s[i].sh, vp: s[i].vp, vh: s[i].vh });
        }
        const dk = Math.round((s[i].k - s[i - 1].k) * 10) / 10;
        if (Math.abs(dk) <= 1.5) continue;
        const dtop = Math.round((s[i].top - s[i - 1].top) * 10) / 10;
        const dline = Math.round(((s[i].line || 0) - (s[i - 1].line || 0)) * 10) / 10;
        events.push({ t: s[i].t, dk, dtop, dline, top: s[i].top, sh: s[i].sh, pend: s[i].pend,
          kind: Math.abs(dline) > 1.5 ? 'shove' : 'cancel' });
      }
      const shoves = events.filter((e) => e.kind === 'shove');
      const cancels = events.filter((e) => e.kind === 'cancel');
      const worstShove = shoves.reduce((m, e) => Math.max(m, Math.abs(e.dline)), 0);
      const lost = cancels.reduce((m, e) => m + Math.max(0, e.dtop), 0);
      const worstSlide = slides.reduce((m, e) => Math.max(m, Math.abs(e.dspan)), 0);
      console.log(`  ${label}: ${s.length} frames, slides ${slides.length} (worst ${worstSlide}px), ` +
        `shoves ${shoves.length} (worst ${worstShove}px), cancelled scroll ${lost}px, ` +
        `k drift ${Math.round((s[s.length - 1].k - s[0].k) * 10) / 10}px`);
      for (const e of slides.slice(0, 2)) {
        const idx = s.findIndex((x) => x.t === e.t);
        const win = s.slice(Math.max(0, idx - 3), idx + 3)
          .map((x) => `${x.t}:top${x.top}/span${x.span}/sh${x.sh}/vp${x.vp}/vh${x.vh}`);
        console.log('  --- slide ' + JSON.stringify(e) + '\n      ' + win.join('\n      '));
      }
      for (const e of events.slice(0, 3)) {
        const idx = s.findIndex((x) => x.t === e.t);
        const win = s.slice(Math.max(0, idx - 4), idx + 4)
          .map((x) => `${x.t}:top${x.top}/line${x.line}/k${x.k}/sh${x.sh}/pend${x.pend}/vp${x.vp}/vh${x.vh}`);
        console.log('  --- ' + JSON.stringify(e) + '\n      ' + win.join('\n      '));
      }
      const interesting = run.ev.filter((e) => e.k === 'setScrollTop' || e.k === 'renderMessages' || e.k === 'anchorBottom');
      if (interesting.length) console.log('  app scroll/render calls: ' + JSON.stringify(interesting.slice(0, 6)));
      return { s, events, shoves, cancels, slides, worstShove, worstSlide, lost };
    };
    const a1 = analyse(run, '[1] wheel through unshaped pictures');
    check(pageErrors.length === 0, 'no uncaught page errors', pageErrors.slice(0, 2));
    check(a1.shoves.length === 0, '[1] nothing slid the visible line out from under the reader',
      { shoves: a1.shoves.slice(0, 4) });

    // ---------------------------------------------------------------------
    // The path that DOES write scrollTop: an upward scroll near the top asks
    // for an older page, the page is spliced in ABOVE the reader with an anchor
    // correction, and the pictures it brought (also unshaped) land right after —
    // in the frames where the app has just moved the scroll itself.
    console.log('\n[2] a page load while the reader scrolls up (pictures land in the new page)');
    await evaluate(`(async () => {
      await selectChannel(${JSON.stringify(ch2)});
    })()`);
    await waitFor(`document.querySelectorAll('#messages .msg').length > 60`, 15000);
    await evaluate(`__ev = []; __hooked = true`);
    await sleep(1200);
    const before2 = await evaluate(`(() => {
      const box = document.getElementById('messages');
      const imgs = [...box.querySelectorAll('img.att-img')];
      return { top: Math.round(box.scrollTop), max: box.scrollHeight - box.clientHeight,
               atts: imgs.length, pending: imgs.filter((i) => !i.complete).length };
    })()`);
    console.log('  opened: ' + JSON.stringify(before2));
    // Park the reader inside the band that asks for older messages — through the
    // app's own placement, the way a restored position is put back, so the
    // bottom hold lets go instead of re-pinning them — then scroll up for real
    // so the request goes out mid-gesture.
    await evaluate(`(() => {
      const box = document.getElementById('messages');
      setScrollTop(box, 900, '0');
      box._userScrollAt = Date.now(); box._userUp = true;
    })()`);
    await sleep(400);           // let the open settle: what is measured is the load
    await evaluate(`__ev = []`);
    const refs2 = await evaluate(`(() => {
      const box = document.getElementById('messages');
      const btop = box.getBoundingClientRect().top;
      let below = null;
      for (const el of box.querySelectorAll('.msg')) {
        const r = el.getBoundingClientRect();
        if (r.top - btop > 420 && r.bottom > btop) { below = el.dataset.mid; break; }
      }
      return { top: window.__topMsg(), below };
    })()`);
    await evaluate(`__start(${JSON.stringify(refs2.below)})`);
    await wheel(-NOTCH, 3);
    await sleep(2500);
    const run2 = await evaluate(`__stop()`);
    const g2 = await evaluate(`__geom()`);
    const atts2 = await evaluate(`(() => [...document.querySelectorAll('#messages img.att-img')].map((im) => ({
      fb: im.dataset.fbName, complete: im.complete, nat: im.naturalWidth,
      wrapH: Math.round((im.closest('.att-wrap') || { getBoundingClientRect: () => ({ height: -1 }) }).getBoundingClientRect().height) })))()`);
    console.log('  after: ' + JSON.stringify(g2) + ' pictures ' + JSON.stringify(atts2));
    const a2 = analyse(run2, '[2] page load mid-gesture');
    const loaded2 = await evaluate(`S.messages.get(${JSON.stringify(ch2)}).length`);
    check(loaded2 > 80, 'the older page was loaded', { n: loaded2 });
    check(a2.shoves.length === 0 && a2.slides.length === 0,
      '[2] the page load did not move the messages under the reader',
      { shoves: a2.shoves.slice(0, 4), slides: a2.slides.slice(0, 4) });

    // ---------------------------------------------------------------------
    // A video's box is the browser's default 300x150 until the metadata lands,
    // and nothing in the markup reserves it (the server records no shape for a
    // video: att-dims marks every non-image as "nothing to reserve"). Chromium's
    // scroll anchoring keeps the TOPMOST visible node still — so when the clip
    // that node holds grows, everything under the reader slides, and the
    // browser cannot compensate for it. Throttle the link so the metadata lands
    // while the reader sits on the clip.
    console.log('\n[3] a video\'s metadata landing under a scrolled-up reader');
    await evaluate(`(async () => { await selectChannel(${JSON.stringify(ch3)}); })()`);
    await waitFor(`document.querySelectorAll('#messages .msg').length >= 40`, 20000);
    // The clip's bytes are held by our own server, so its box is still the
    // element's default (300x150) whatever the reader does.
    await waitFor(`!!document.querySelector('#messages video.att-vid')`, 10000);
    const vidBefore = await evaluate(`(() => {
      const box = document.getElementById('messages');
      const v = box.querySelector('video.att-vid');
      const wrap = v && v.closest('.att-wrap');
      return { top: Math.round(box.scrollTop), max: box.scrollHeight - box.clientHeight,
               ready: v ? v.readyState : -1, vw: v ? v.videoWidth : 0,
               wrapH: wrap ? Math.round(wrap.getBoundingClientRect().height) : -1 };
    })()`);
    console.log('  clip while its metadata is out: ' + JSON.stringify(vidBefore));
    // Park the clip at the TOP of the viewport: the one placement anchoring
    // cannot protect, because the growing node IS the anchor.
    const refs = await evaluate(`(() => {
      const box = document.getElementById('messages');
      const v = box.querySelector('video.att-vid');
      const msg = v.closest('.msg');
      box.dataset.atBottom = '0';
      box.scrollTop = Math.max(0, msg.offsetTop - 8);
      box._lastTop = box.scrollTop;
      const btop = box.getBoundingClientRect().top;
      let below = null;
      for (const el of box.querySelectorAll('.msg')) {
        const r = el.getBoundingClientRect();
        if (r.top - btop > 480 && r.bottom > btop) { below = el.dataset.mid; break; }
      }
      return { clip: msg.dataset.mid, below };
    })()`);
    console.log('  references: ' + JSON.stringify(refs));
    await sleep(150);
    await evaluate(`__start(${JSON.stringify(refs.below)})`);
    // The rest of the clip (and its metadata) arrives ~2.5s in.
    await waitFor(`(() => { const v = document.querySelector('#messages video.att-vid'); return v && v.readyState >= 1 && v.videoWidth > 0; })()`, 30000);
    await sleep(1500);
    const run3 = await evaluate(`__stop()`);
    const vidAfter = await evaluate(`(() => {
      const v = document.querySelector('#messages video.att-vid');
      const wrap = v && v.closest('.att-wrap');
      return { ready: v ? v.readyState : -1, vw: v ? v.videoWidth : 0,
               wrapH: wrap ? Math.round(wrap.getBoundingClientRect().height) : -1 };
    })()`);
    console.log('  clip after: ' + JSON.stringify(vidAfter) + ' requests ' + JSON.stringify(clipReqs));
    const a3 = analyse(run3, '[3] clip metadata under the reader');
    check(vidAfter.wrapH !== vidBefore.wrapH, 'the clip\'s box really did change size (nothing reserved it)',
      { before: vidBefore, after: vidAfter });
    check(a3.slides.length === 0, '[3] the messages under the reader did not slide when the clip\'s box changed',
      { slides: a3.slides.slice(0, 4) });

    // ---------------------------------------------------------------------
    // Coming back DOWN: a reader who stops short of the bottom must be left
    // there. `markBottomState` calls anything within 200px of the bottom "at
    // the bottom", and the scroll watcher then re-pins the box to the very
    // bottom on the next event — so a deliberate stop 100px up is thrown away.
    console.log('\n[4] scrolling back down and stopping short of the bottom');
    const geom4 = await evaluate(`(() => {
      const box = document.getElementById('messages');
      setScrollTop(box, 0, '0');
      return { max: box.scrollHeight - box.clientHeight };
    })()`);
    // Park 700px above the bottom, then wheel down five notches (600px): the
    // reader ends ~100px short of it and stops.
    await evaluate(`(() => { const box = document.getElementById('messages'); setScrollTop(box, Math.max(0, ${geom4.max} - 700), '0'); })()`);
    await sleep(400);
    await evaluate(`__ev = []`);
    await evaluate(`__start()`);
    const before4 = await evaluate(`__geom()`);
    await wheel(NOTCH, 5);
    const mid4 = await evaluate(`__geom()`);
    await sleep(2000);           // nothing else happens: no input, no new messages
    const after4 = await evaluate(`__geom()`);
    // How far the reader was from the bottom when their wheel stopped, and
    // where they are after a beat with no input at all.
    const shortOf = (g) => g.max - g.top;
    console.log('  before ' + JSON.stringify(before4) + ' after wheel ' + JSON.stringify(mid4) +
      ' settled ' + JSON.stringify(after4));
    check(shortOf(mid4) > 40, 'the wheel really did stop short of the bottom', { shortOf: shortOf(mid4) });
    check(shortOf(after4) > 40, '[4] a reader who stopped short of the bottom was left there',
      { shortOfWhenTheyStopped: shortOf(mid4), shortOfAfter: shortOf(after4),
        calls: (await evaluate(`__ev`)).filter((e) => e.k === 'setScrollTop').slice(0, 6) });
    // The state that matters is the pin: while they rest short of the bottom,
    // ANY scroll event can arrive with no input behind it (the browser's own
    // anchoring under late media, a clamp, the tail of a flick). If the band
    // handed the pin back, that event is read as "hold the bottom" and the
    // reader is snapped the rest of the way down.
    const at4 = await evaluate(`document.getElementById('messages').dataset.atBottom`);
    await evaluate(`(() => { const box = document.getElementById('messages'); box.scrollTop = box.scrollTop - 6; })()`);
    await sleep(600);
    const after4b = await evaluate(`__geom()`);
    console.log('  after a stray 6px scroll: ' + JSON.stringify(after4b) + ' (pin was ' + at4 + ')');
    check(at4 !== '1', '[4] resting short of the bottom is not "on the bottom"', { pin: at4 });
    check(shortOf(after4b) > 40, '[4] and a stray scroll there does not snap them to it',
      { shortOfAfter: shortOf(after4b),
        calls: (await evaluate(`__ev`)).filter((e) => e.k === 'setScrollTop').slice(-4) });

    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) { console.log(failures.map((f) => '  - ' + f).join('\n')); process.exitCode = 1; }
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome && chrome.kill(); } catch {}
    try { child && child.kill(); } catch {}
    try { clipServer && clipServer.close(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  process.exit(process.exitCode || 0);
}

main().catch((e) => { console.error('[test] crashed:', (e && e.message) || e); process.exit(1); });
