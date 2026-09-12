// The story shutter must answer the tap, not the JPEG encoder.
//
// The bug: on Android the flash fired instantly and then the user stared at a
// live camera for ~5s before the shot appeared. Blink does not encode
// canvas.toBlob on a thread there — canvas_async_blob_creator picks the
// idle-periods implementation when IS_ANDROID, so the JPEG is encoded on the
// main thread between other work. Waiting for that callback before switching to
// the preview step is the whole delay.
//
// The fix shows the captured pixels immediately (the capture canvas itself,
// `.sc-freeze`) with Next held at "Saving…", releases the camera, and hands
// over to the encoded blob when it lands. This test drives the real page in
// headless Chrome with a fake camera and asserts that hand-off: the shot is on
// screen in the same frame as the tap, and it is a real image/jpeg blob (not a
// stand-in that never resolves) once the encoder calls back. It also covers the
// race the old code had no answer for — a reset while the encode is in flight
// (storyRetake(), which the failed-encode fallback still calls) must not
// resurrect the stale shot. The composer no longer offers a Retake button at
// all, so the reset is driven as the function the app itself calls.
//
// Boots a real server against a throwaway database and drives Chrome over the
// DevTools protocol (no puppeteer — plain CDP over ws, same harness as
// scripts/test-drafts-browser.js).
//
// Skips (exit 0) when Postgres or Chrome is unavailable, or when this Chrome
// has no fake video device (no getUserMedia frames → nothing to test).
//
// Usage: node scripts/test-story-camera.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_storycam_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3418', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9335', 10);

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-storycam-e2e-'));
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
        JWT_SECRET: 'test-storycam-secret',
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

    // ---- Chrome + CDP (fake camera: no hardware, real MediaStream frames) ----
    const profile = path.join(tmp, 'chrome');
    chrome = spawn(chromePath, [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=900,700', 'about:blank',
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
        await sleep(100);
      }
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    check(!!(await waitFor(`typeof boot === 'function'`)), 'the app loads');

    console.log('\n[1] sign in');
    const reg = await evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'snapper', displayName: 'Snapper', password: 'passw0rd!x' }) });
      const d = await r.json();
      store.token = d.token; store.sid = d.sid;
      return { ok: !!d.token };
    })()`);
    check(!!reg.ok, 'registered an account');
    await send('Page.reload');
    check(!!(await waitFor(`S.me && S.me.username === 'snapper'`)), 'boots signed in');

    console.log('\n[2] open the camera');
    const opened = await evaluate(`(async () => {
      await openStoryComposer();
      const t0 = performance.now();
      while (performance.now() - t0 < 12000) {
        if (sc && sc.camFailed) return { camFailed: true };
        if (sc && sc.camReady) return { camReady: true, w: document.querySelector('#sc-cam').videoWidth };
        await new Promise((r) => setTimeout(r, 100));
      }
      return { timeout: true, step: sc && sc.step, camReady: !!(sc && sc.camReady), camFailed: !!(sc && sc.camFailed) };
    })()`);
    if (opened.camFailed || opened.timeout) return skip('no fake camera frames in this Chrome/OS (' + JSON.stringify(opened) + ')');
    check(opened.camReady && opened.w > 0, 'the fake camera paints a frame', opened);
    // The Retake button is gone (owner request): the preview bar carries Next
    // alone, and nothing in the composer wires a retake any more. storyRetake()
    // itself stays — a capture that encodes to nothing falls back to it.
    const bar = await evaluate(`(() => ({
      retake: !!document.querySelector('#sc-retake'),
      barButtons: [...document.querySelectorAll('#sc-bar button')].map((b) => b.textContent.trim()),
      wiring: typeof storyRetake,
    }))()`);
    check(bar.retake === false && bar.barButtons.join('|') === 'Next',
      'the preview bar has no Retake button, just Next', bar);
    check(bar.wiring === 'function', 'while storyRetake() stays for the failed-encode fallback', bar);

    console.log('\n[3] the shutter answers the tap, not the encoder');
    const shot = await evaluate(`(() => {
      const stage = document.querySelector('#story-compose .sc-stage');
      const btn = document.querySelector('#sc-shutter');
      const t0 = performance.now();
      btn.click();
      // Everything here is synchronous with the tap: this is what the user sees
      // before any JPEG work has been awaited.
      const freeze = stage.querySelector('.sc-freeze');
      const next = document.querySelector('#sc-next');
      return {
        ms: performance.now() - t0,
        frozen: !!freeze,
        freezeIsCaptureCanvas: freeze === scCapCanvas,
        freezePainted: !!freeze && freeze.width > 1 && freeze.height > 1,
        nextDisabled: next.disabled,
        nextLabel: next.textContent,
        camReleased: sc.stream === null,
        step: sc.step,
        blobYet: !!sc.blob,
        promise: !!sc.encodePromise,
        encoderWorker: !!storyEncoder(),
      };
    })()`);
    check(shot.ms < 120, 'the tap is served inside one frame', { ms: Math.round(shot.ms) });
    check(shot.frozen && shot.freezeIsCaptureCanvas, 'the captured frame is on screen immediately', shot);
    check(shot.freezePainted, 'the stand-in is a real painted canvas', shot);
    check(shot.camReleased, 'the camera is released while the encode runs', shot);
    check(shot.step === 'preview', 'the preview step is up', shot);
    // The reader is never parked on a disabled "Saving…": the frozen frame is
    // the preview, and the encode is waited for once, at Post (storyPostNow).
    check(!shot.nextDisabled && shot.nextLabel === 'Next', 'Next is live immediately', shot);
    check(!shot.blobYet && shot.promise, 'and the bytes are still encoding behind it', shot);
    check(shot.encoderWorker, 'the JPEG is encoded off the main thread (worker + OffscreenCanvas)', shot);

    console.log('\n[4] the encode lands behind it');
    const done = await waitFor(`!sc.pendingShot && sc.blob ? {
        label: document.querySelector('#sc-next').textContent,
        kind: sc.kind,
        type: (sc.blob && sc.blob.type) || '',
        size: (sc.blob && sc.blob.size) || 0,
        freezeGone: !document.querySelector('.sc-stage .sc-freeze'),
        shotVisible: !document.querySelector('#sc-shot').classList.contains('hidden'),
        shotSrc: (document.querySelector('#sc-shot').src || '').slice(0, 5),
        camHidden: document.querySelector('#sc-cam').classList.contains('hidden'),
        pending: !!sc.pendingShot,
      } : false`, 20000);
    check(!!done, 'the preview finishes resolving', done);
    if (done) {
      check(done.kind === 'image' && done.type === 'image/jpeg' && done.size > 1000,
        'a real JPEG is behind the preview', done);
      check(done.freezeGone && done.shotVisible && done.shotSrc === 'blob:', 'the stand-in hands over to the decoded shot', done);
      check(done.camHidden && !done.pending, 'the camera stays released', done);
      check(done.label === 'Next', 'Next is live once the shot exists', done);
    }

    console.log('\n[5] a reset during the encode must not resurrect the shot');
    const race = await evaluate(`(async () => {
      const wait = (fn, ms) => new Promise((res) => {
        const t0 = performance.now();
        (function tick() {
          if (fn()) return res(true);
          if (performance.now() - t0 > ms) return res(false);
          setTimeout(tick, 50);
        })();
      });
      storyRetake();                                          // back to the camera
      const backToCam = await wait(() => sc && sc.camReady, 12000);
      if (!backToCam) return { backToCam: false };
      document.querySelector('#sc-shutter').click();          // encode in flight…
      storyRetake();                                          // …and a reset mid-flight
      const shortly = { step: sc.step, blob: !!sc.blob, freeze: !!document.querySelector('.sc-stage .sc-freeze') };
      await new Promise((r) => setTimeout(r, 2500));          // let the stale encode land
      return {
        backToCam: true, shortly,
        step: sc.step, blob: !!sc.blob, kind: sc.kind,
        shotSrc: document.querySelector('#sc-shot').src || '',
        freeze: !!document.querySelector('.sc-stage .sc-freeze'),
        nextLabel: document.querySelector('#sc-next').textContent,
        nextDisabled: document.querySelector('#sc-next').disabled,
        shutterEnabled: !document.querySelector('#sc-shutter').disabled,
      };
    })()`);
    check(!!race.backToCam, 'the camera comes back after the reset', race);
    if (race.backToCam) {
      check(race.shortly.step === 'capture' && !race.shortly.freeze, 'the reset drops the pending stand-in at once', race.shortly);
      check(race.step === 'capture' && !race.blob && !race.kind, 'the stale encode is discarded, not shown', race);
      check(!race.shotSrc, 'no ghost shot is left on the preview element', race);
      check(!race.nextDisabled, 'Next is reset for the next shot', race);
      check(race.shutterEnabled, 'the shutter is usable again (the stale callback did not pin it)', race);
    }

    console.log('\n[6] a second shot still previews');
    await waitFor(`sc && sc.camReady`, 12000);
    const second = await evaluate(`(async () => {
      document.querySelector('#sc-shutter').click();
      const t0 = performance.now();
      while (performance.now() - t0 < 20000) {
        if (!sc.pendingShot && sc.blob && sc.kind === 'image') {
          return { ok: true, type: sc.blob.type, size: sc.blob.size, label: document.querySelector('#sc-next').textContent };
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return { ok: false, step: sc.step, pending: !!sc.pendingShot, blob: !!sc.blob };
    })()`);
    check(second.ok && second.type === 'image/jpeg' && second.size > 1000, 'back-to-back captures keep working', second);

    console.log('\n[7] posting before the bytes land waits for them, then posts');
    const posted = await evaluate(`(async () => {
      const wait = (fn, ms) => new Promise((res) => {
        const t0 = performance.now();
        (function tick() {
          if (fn()) return res(true);
          if (performance.now() - t0 > ms) return res(false);
          setTimeout(tick, 50);
        })();
      });
      storyRetake();
      if (!(await wait(() => sc && sc.camReady, 12000))) return { camReady: false };
      document.querySelector('#sc-shutter').click();
      const raced = { blobYet: !!sc.blob, step: sc.step, nextLabel: document.querySelector('#sc-next').textContent };
      storySetStep('audience');                    // the reader moves on at once
      const p = storyPostNow();                    // …and posts while encoding
      const during = { label: document.querySelector('#sc-post').textContent };
      await p;
      return { camReady: true, raced, during, closed: sc === null, mine: storyLive(storyData.mine && storyData.mine.items).length };
    })()`, 60000);
    check(!!posted.camReady, 'the camera is back for one more shot', posted);
    if (posted.camReady) {
      check(!posted.raced.blobYet && posted.raced.nextLabel === 'Next', 'the shot was still encoding when Next was tapped', posted.raced);
      check(posted.during.label === 'Saving…', 'Post says what it is waiting for', posted.during);
      check(posted.closed && posted.mine > 0, 'the story posted once the bytes existed', posted);
    }

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
