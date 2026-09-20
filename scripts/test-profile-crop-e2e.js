// Setting an avatar / banner / member-list banner, end to end (see AGENTS.md
// verification conventions).
//
// The other two crop tests prove the arithmetic (test-image-crop.js), the
// encoder and the wiring, and the stage in isolation
// (test-image-crop-browser.js). This one drives the WHOLE thing the way a person
// does: a real server, a real database and a real browser, opening Settings ->
// Profile and handing the file input a real file, then clicking Save, and then
// reading back the BYTES the site now serves for that account.
//
// It is here to catch what only the whole path can:
//   - the crop route answers and repoints the column (a 400 from the multipart,
//     a missing route, a bad SQL identifier — all invisible to the unit tests);
//   - an ANIMATED GIF comes back out of the pipeline still animated (the whole
//     reason the encode is ffmpeg and not a canvas), and is still a .gif;
//   - a still comes back a real WebP at the shape that was framed, in the right
//     sub-directory for the surface;
//   - the three surfaces each land in their own column, and the frame the stage
//     showed is the frame that got stored.
//
// Skips (exit 0) without Chrome, Postgres or ffmpeg.
//
// Usage: node scripts/test-profile-crop-e2e.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_crop_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3417', 10);
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
// A real PNG, generated: a solid colour, so "did the crop resize it" is a
// question about its header rather than about how it looks.
function pngBytes(w, h, rgb) {
  const zlib = require('zlib');
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (w * 3 + 1);
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3] = rgb[0];
      raw[off + 2 + x * 3] = rgb[1];
      raw[off + 3 + x * 3] = rgb[2];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');
  const ff = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (!ff || ff.status !== 0) return skip('ffmpeg not found on PATH');

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-crop-e2e-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  // The two files this test hands to the real file inputs.
  const pngPath = path.join(tmp, 'wide.png');
  fs.writeFileSync(pngPath, pngBytes(1200, 400, [230, 60, 60]));
  const gifPath = path.join(tmp, 'anim.gif');
  const madeGif = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0xdd2222:s=200x120:r=8:d=0.25',
    '-f', 'lavfi', '-i', 'color=c=0x2233dd:s=200x120:r=8:d=0.25',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[out]', '-map', '[out]', '-loop', '0', gifPath], { stdio: 'ignore' });
  if (madeGif.status !== 0) return skip('could not generate the animated GIF fixture');

  const { dimsFromBuffer } = require(path.join(ROOT, 'image-size.js'));
  const { isAnimatedImage } = require(path.join(ROOT, 'image-crop.js'));

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
        JWT_SECRET: 'test-crop-secret',
        UPLOAD_DIR: uploads,
        UNFURL: '0',
        VIRUS_SCAN: '0',
        MEDIA_COMPRESS: '0',
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
        await sleep(150);
      }
    };
    // Hand a real file to a real <input type=file>, exactly as the picker does.
    const setInputFile = async (sel, filePath) => {
      const { result } = await send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(sel)})` });
      await send('DOM.setFileInputFiles', { files: [filePath], objectId: result.objectId });
    };
    // One full pass through the UI: open Settings -> Profile, pick a file, frame
    // it, save it. Returns the user the page ended up with.
    const cropVia = async (inputSel, filePath) => {
      await evaluate(`(async () => { openSettings(); return true; })()`);
      await setInputFile(inputSel, filePath);
      const opened = await waitFor(`!document.querySelector('#crop-backdrop').classList.contains('hidden')
        && !document.querySelector('#crop-save').disabled`, 15000);
      if (!opened) throw new Error('the crop stage did not open for ' + inputSel);
      const framed = await evaluate('cropViewRect(cropState.view)');
      await evaluate(`document.querySelector('#crop-save').click()`);
      const urls = await waitFor(`(() => {
        const el = document.querySelector('#crop-backdrop');
        if (!el.classList.contains('hidden') || !S.me) return null;
        return (S.me.avatar_url || '') + '|' + (S.me.banner_url || '') + '|' + (S.me.sidebar_banner_url || '');
      })()`, 20000);
      if (urls === null) {
        const why = await evaluate(`document.querySelector('#toast') ? document.querySelector('#toast').textContent : 'no toast'`);
        throw new Error('the crop never saved (' + inputSel + '): ' + why);
      }
      return { framed, urls };
    };
    const fetchBytes = async (url) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${url}`);
      return { status: r.status, type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) };
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('DOM.enable');
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    if (!(await waitFor(`typeof boot === 'function'`))) return fail('the app did not load');

    console.log('\n[0] an account');
    const reg = await evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'framed', displayName: 'Framed', password: 'passw0rd!x' }) });
      const d = await r.json();
      store.token = d.token; store.sid = d.sid;
      return { ok: !!d.token };
    })()`);
    check(!!reg.ok, 'registered and signed in');
    await send('Page.reload');
    check(!!(await waitFor(`S.me && S.me.username === 'framed'`)), 'the app boots signed in');

    console.log('\n[1] an avatar: pick a file, frame it, save');
    let r1 = await cropVia('#set-avatar-file', pngPath);
    check(r1.urls.includes('/uploads/avatars/'), 'the avatar column points at a stored avatar', r1.urls);
    const avatarUrl = r1.urls.split('|')[0];
    check(/\.webp\?/.test(avatarUrl), 'stored as WebP (a still is not re-encoded as a GIF)', avatarUrl);
    check(avatarUrl !== '', 'and it is not empty', avatarUrl);
    let got = await fetchBytes(avatarUrl);
    check(got.status === 200, 'the stored picture is served', got.status);
    check(got.type === 'image/webp', 'as WebP', got.type);
    let dims = dimsFromBuffer(got.buf);
    check(dims && Math.abs(dims.w - dims.h) <= 1, 'square, because the avatar window is square', dims);
    check(dims && Math.abs(dims.w - r1.framed.w) <= 2, 'and exactly the frame the stage showed', { stored: dims, framed: r1.framed });
    check(r1.framed.w > 200, 'which really was a crop (not a 1px accident)', r1.framed);

    console.log('\n[2] a banner: the framed band, in the banner sub-directory');
    let r2 = await cropVia('#set-banner-file', pngPath);
    check(r2.urls.split('|')[1].includes('/uploads/banners/'), 'the banner column points at a stored banner', r2.urls);
    const bannerUrl = r2.urls.split('|')[1];
    got = await fetchBytes(bannerUrl);
    dims = dimsFromBuffer(got.buf);
    check(got.status === 200 && got.type === 'image/webp', 'served as WebP', { s: got.status, t: got.type });
    check(dims && Math.abs(dims.w / dims.h - 3) < 0.05, 'the banner is the 3:1 shape of its window', dims);
    check(dims && Math.abs(dims.w - r2.framed.w) <= 2, 'and the frame the stage showed', { stored: dims, framed: r2.framed });

    console.log('\n[3] an ANIMATED GIF avatar stays an animated GIF');
    let r3 = await cropVia('#set-avatar-file', gifPath);
    const gifUrl = r3.urls.split('|')[0];
    check(gifUrl !== avatarUrl, 'the avatar was replaced', gifUrl);
    check(/\.gif\?/.test(gifUrl), 'stored with a .gif name (the picker uses GIFs, and the file stays one)', gifUrl);
    got = await fetchBytes(gifUrl);
    check(got.status === 200 && got.type === 'image/gif', 'served as a GIF', { s: got.status, t: got.type });
    check(isAnimatedImage(got.buf, 'image/gif') === true, 'and the bytes are STILL ANIMATED after the crop');
    dims = dimsFromBuffer(got.buf);
    check(dims && Math.abs(dims.w - r3.framed.w) <= 2 && Math.abs(dims.h - r3.framed.h) <= 2,
      'at the frame the stage showed', { stored: dims, framed: r3.framed });
    // The square window on a 200x120 source frames the middle band of it, so the
    // stored picture is square and no wider than the source: a crop, proved by
    // the bytes rather than by the request.
    check(dims && Math.abs(dims.w - dims.h) <= 1 && dims.w <= 200 && dims.h <= 120,
      'a square frame cut out of a 200x120 animation', dims);

    console.log('\n[4] the member list banner lands in its own column');
    const r4 = await cropVia('#set-sidebar-file', pngPath);
    const sideUrl = r4.urls.split('|')[2];
    check(sideUrl.includes('/uploads/sidebar/'), 'stored under sidebar/', sideUrl);
    got = await fetchBytes(sideUrl);
    dims = dimsFromBuffer(got.buf);
    check(dims && Math.abs(dims.w / dims.h - 6) < 0.1, 'with the 6:1 shape of a member row', dims);
    check(r4.urls.split('|')[0] === gifUrl, 'and the avatar was left alone', r4.urls);

    console.log('\n[5] a history dot re-frames what it re-uses');
    // The dots under the avatar are "set this one again", and setting one of
    // these pictures means framing it — including an entry stored before the
    // stage existed. It hands over a /uploads url, which the crop route will not
    // fetch itself (https only), so the page reads the bytes back first: this is
    // the half that would silently 400 if that were forgotten.
    const avatarBefore = await evaluate(`(async () => { openSettings(); await new Promise((r) => setTimeout(r, 400)); return S.me.avatar_url || ''; })()`);
    const dots = await evaluate(`document.querySelectorAll('#set-avatar-hist .hist-dot').length`);
    check(dots > 0, 'the avatar has history to re-use', { dots });
    await evaluate(`document.querySelector('#set-avatar-hist .hist-dot').click()`);
    const dotOpen = await waitFor(`!document.querySelector('#crop-backdrop').classList.contains('hidden')
      && !document.querySelector('#crop-save').disabled`, 15000);
    check(!!dotOpen, 'clicking a dot opens the crop stage');
    const dotFramed = await evaluate('cropViewRect(cropState.view)');
    await evaluate(`document.querySelector('#crop-save').click()`);
    const avatarAfter = await waitFor(`S.me && S.me.avatar_url && S.me.avatar_url !== ${JSON.stringify(avatarBefore)}
      ? S.me.avatar_url : null`, 20000);
    check(!!avatarAfter, 'and saving frames it into a new file', avatarAfter);
    got = await fetchBytes(avatarAfter);
    dims = dimsFromBuffer(got.buf);
    check(got.status === 200, 'the re-framed picture is served', got.status);
    check(dims && Math.abs(dims.w - dotFramed.w) <= 2 && Math.abs(dims.h - dotFramed.h) <= 2,
      'at the frame the stage showed', { stored: dims, framed: dotFramed });

    console.log('\n[6] the guards');
    // A rectangle of nonsense is a 400, not a 500 and not a stored picture.
    const bad = await evaluate(`(async () => {
      const fd = new FormData();
      fd.append('file', new File([new Uint8Array(64)], 'x.png', { type: 'image/png' }));
      fd.append('x', 'a'); fd.append('y', '0'); fd.append('w', '10'); fd.append('h', '10');
      const r = await fetch('/api/me/avatar/crop', { method: 'POST', headers: { Authorization: 'Bearer ' + store.token }, body: fd });
      return { status: r.status, body: await r.text() };
    })()`);
    check(bad.status === 422 || bad.status === 400, 'bytes that are not an image are refused cleanly', bad);
    const httpUrl = await evaluate(`(async () => {
      const r = await api('/api/me/avatar/crop', { method: 'POST', body: JSON.stringify({ url: 'http://example.test/a.gif', x: 0, y: 0, w: 10, h: 10 }) }).then(() => 0).catch((e) => String(e.message));
      return r;
    })()`);
    check(/bad_source|400/.test(String(httpUrl)), 'a non-https remote source is refused', httpUrl);
    const unauth = await fetch(`http://127.0.0.1:${PORT}/api/me/avatar/crop`, { method: 'POST' });
    check(unauth.status === 401, 'the route needs a session', unauth.status);
    const otherUser = await evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'nosy', displayName: 'Nosy', password: 'passw0rd!x' }) });
      const d = await r.json();
      const fd = new FormData();
      fd.append('file', new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' }));
      const rr = await fetch('/api/admin/users/' + S.me.id + '/avatar/crop', { method: 'POST', headers: { Authorization: 'Bearer ' + d.token }, body: fd });
      return rr.status;
    })()`);
    check(otherUser === 403, 'and the admin route is admin-only', otherUser);

    check(pageErrors.length === 0, 'no uncaught page errors', pageErrors.slice(0, 3));
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

main().catch((e) => { console.error('[test] crashed: ' + ((e && e.stack) || e)); process.exit(1); });
