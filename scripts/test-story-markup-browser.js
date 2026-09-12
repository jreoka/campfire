// The story camera overhaul, end to end: tap vs hold, pinch zoom, double-tap
// flip, text/emoji/drawing markup, text-only stories — and the markup surviving
// the round trip through the server into the viewer.
//
// The complaint this came from: the composer was a bare viewfinder with a
// Photo/Video toggle. It now behaves like a real camera app (one shutter, hold
// to record, pinch to zoom, double-tap to flip) and the shot can be drawn on
// before it is sent. The load-bearing part is the overlay list: it is edited in
// the composer against the MEDIA's content box, sent as JSON, validated by the
// server, and re-rendered by the story viewer (and by the view-once player for
// a copy sent to one friend) — so this test drives the real page, posts a real
// story, and reads the markup back off the API and off the viewer's DOM.
//
// Boots a real server against a throwaway database and drives Chrome over the
// DevTools protocol (same harness as scripts/test-story-camera.js).
//
// Skips (exit 0) when Postgres or Chrome is unavailable, or when this Chrome
// has no fake camera.
//
// Usage: node scripts/test-story-markup-browser.js
// Writes campfire-story-edit.png (the markup step) and campfire-story-view.png
// (the viewer showing the posted markup) to the temp dir.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_storymarkup_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3419', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9336', 10);

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-storymarkup-e2e-'));
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
        JWT_SECRET: 'test-storymarkup-secret',
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

    const profile = path.join(tmp, 'chrome');
    chrome = spawn(chromePath, [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=900,860', 'about:blank',
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
    const evaluate = async (expression, awaitPromise = true) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
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
    // Screenshots of the two surfaces under test, into the temp dir.
    const shot = async (name) => {
      try {
        const r = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(os.tmpdir(), name), Buffer.from(r.data, 'base64'));
      } catch {}
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    check(!!(await waitFor(`typeof boot === 'function'`)), 'the app loads');

    console.log('\n[1] sign in and open the camera');
    const reg = await evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'snapper', displayName: 'Snapper', password: 'passw0rd!x' }) });
      const d = await r.json();
      store.token = d.token; store.sid = d.sid;
      return { ok: !!d.token };
    })()`);
    check(!!reg.ok, 'registered an account');
    await send('Page.reload');
    check(!!(await waitFor(`S.me && S.me.username === 'snapper'`)), 'boots signed in');

    // Synthetic pointer events: our handlers do not check isTrusted, and this
    // is the only way to describe a pinch or a hold from a script.
    await evaluate(`window.__pt = (el, type, id, x, y) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: y,
      bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    })); true`);

    const opened = await evaluate(`(async () => {
      await openStoryComposer();
      const t0 = performance.now();
      while (performance.now() - t0 < 12000) {
        if (sc && sc.camFailed) return { camFailed: true };
        if (sc && sc.camReady) return { camReady: true, w: document.querySelector('#sc-cam').videoWidth };
        await new Promise((r) => setTimeout(r, 100));
      }
      return { timeout: true };
    })()`);
    if (opened.camFailed || opened.timeout) return skip('no fake camera frames in this Chrome/OS (' + JSON.stringify(opened) + ')');
    check(opened.camReady && opened.w > 0, 'the fake camera paints a frame', opened);
    const cover = await evaluate(`(() => {
      const cam = document.querySelector('#sc-cam');
      const stage = document.querySelector('#sc-stage');
      const fit = getComputedStyle(cam).objectFit;
      const cr = cam.getBoundingClientRect(), sr = stage.getBoundingClientRect();
      return { fit, fills: Math.abs(cr.width - sr.width) < 2 && Math.abs(cr.height - sr.height) < 2,
               hint: !!document.querySelector('#sc-holdhint'), textBtn: !!document.querySelector('#sc-textonly'),
               modes: document.querySelectorAll('.sc-mode').length };
    })()`);
    check(cover.fit === 'cover', 'the viewfinder covers the stage instead of letterboxing', cover);
    check(cover.fills, 'the camera element fills the stage', cover);
    check(cover.hint && cover.textBtn, 'the eye-level affordances are there (hold hint + text-only)', cover);
    check(cover.modes === 0, 'the Photo/Video mode toggle is gone', cover);

    console.log('\n[2] pinch to zoom, and the crop follows the preview');
    const zoom = await evaluate(`(() => {
      const s = document.querySelector('#sc-stage');
      const r = s.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const before = sc.zoom;
      __pt(s, 'pointerdown', 1, cx - 60, cy);
      __pt(s, 'pointerdown', 2, cx + 60, cy);
      __pt(s, 'pointermove', 1, cx - 120, cy);
      __pt(s, 'pointermove', 2, cx + 120, cy);
      __pt(s, 'pointerup', 1, cx - 120, cy);
      __pt(s, 'pointerup', 2, cx + 120, cy);
      const tf = document.querySelector('#sc-cam').style.transform || '';
      return { before, after: sc.zoom, ox: sc.ox, tf, composite: storyNeedsComposite(), stage: scStage() && !!scStage() };
    })()`);
    check(zoom.before === 1, 'the camera starts at 1x', zoom);
    check(Math.abs(zoom.after - 2) < 0.15, 'a 2x pinch lands at ~2x', zoom);
    check(tfIncludes(zoom.tf, 'scale(2'), 'the preview is transformed to match', zoom.tf);
    check(zoom.composite, 'a zoomed recording has to be composited (the sensor frame is not what you see)', zoom);

    console.log('\n[3] double-tap flips the camera');
    const flip = await evaluate(`(async () => {
      const s = document.querySelector('#sc-stage');
      const r = s.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const before = sc.facing;
      __pt(s, 'pointerdown', 1, x, y); __pt(s, 'pointerup', 1, x, y);
      __pt(s, 'pointerdown', 1, x, y); __pt(s, 'pointerup', 1, x, y);
      const t0 = performance.now();
      while (performance.now() - t0 < 8000 && sc.facing === before) await new Promise((r) => setTimeout(r, 60));
      const t1 = performance.now();
      while (performance.now() - t1 < 8000 && !sc.camReady) await new Promise((r) => setTimeout(r, 60));
      return { before, after: sc.facing, zoom: sc.zoom, ready: sc.camReady };
    })()`, true);
    check(flip.after === 'environment', 'two quick taps flip to the back camera', flip);
    check(flip.zoom === 1, 'flipping resets the zoom', flip);
    check(flip.ready, 'the flipped camera comes back up', flip);

    console.log('\n[4] hold the shutter to record, release to stop');
    const rec = await evaluate(`(async () => {
      const b = document.querySelector('#sc-shutter');
      __pt(b, 'pointerdown', 1, 0, 0);
      await new Promise((r) => setTimeout(r, 400));
      const started = { rec: !!sc.rec, recClass: b.classList.contains('rec'), timer: !document.querySelector('#sc-rec-time').classList.contains('hidden') };
      await new Promise((r) => setTimeout(r, 1600));
      __pt(b, 'pointerup', 1, 0, 0);
      const t0 = performance.now();
      while (performance.now() - t0 < 20000 && sc && (sc.rec || sc.pendingShot || !sc.blob)) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return { started, step: sc && sc.step, kind: sc && sc.kind, size: (sc && sc.blob && sc.blob.size) || 0,
               type: (sc && sc.blob && sc.blob.type) || '', recClass: b.classList.contains('rec'),
               composite: !!(sc && sc.comp === null) };
    })()`, true);
    check(rec.started.rec, 'holding the shutter starts a recording', rec.started);
    check(rec.started.recClass && rec.started.timer, 'the shutter goes red and the timer runs', rec.started);
    check(rec.kind === 'video' && rec.size > 1000, 'releasing it finishes a real video blob', rec);
    check(rec.step === 'preview', 'and lands on the preview step', rec);
    check(!rec.recClass, 'the shutter comes back', rec);

    console.log('\n[5] the pen works on a shot that has no markup yet');
    const firstPen = await evaluate(`(() => {
      document.querySelector('#sc-tool-draw').click();
      const lay = document.querySelector('#sc-ov');
      const r = lay.getBoundingClientRect();
      const p = (t, x, y) => __pt(lay, t, 1, r.left + r.width * x, r.top + r.height * y);
      p('pointerdown', 0.2, 0.3);
      for (let i = 1; i <= 6; i++) p('pointermove', 0.2 + i * 0.07, 0.3 + i * 0.04);
      p('pointerup', 0.62, 0.54);
      const cv = lay.querySelector('canvas.ov-draw');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let painted = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
      const out = { strokes: sc.ovs.filter((o) => o.t === 'draw').length, painted, w: cv.width, h: cv.height };
      document.querySelector('#sc-tool-undo').click();
      document.querySelector('#sc-tool-draw').click();
      out.afterUndo = sc.ovs.length;
      return out;
    })()`);
    check(firstPen.w > 20 && firstPen.h > 20, 'the pen layer has a real canvas even with nothing on the shot', firstPen);
    check(firstPen.strokes === 1 && firstPen.painted > 100, 'and the first stroke paints on it', firstPen);
    check(firstPen.afterUndo === 0, 'undo empties it again', firstPen);

    console.log('\n[6] markup: text, an emoji sticker and a drawing');
    const markup = await evaluate(`(async () => {
      document.querySelector('#sc-retake').click();
      const t0 = performance.now();
      while (performance.now() - t0 < 12000 && !(sc && sc.camReady)) await new Promise((r) => setTimeout(r, 80));
      document.querySelector('#sc-shutter').click();
      const t1 = performance.now();
      while (performance.now() - t1 < 20000 && (sc.pendingShot || !sc.blob)) await new Promise((r) => setTimeout(r, 80));
      // Text: the editor writes straight onto the picture as you type.
      document.querySelector('#sc-tool-text').click();
      const sheetUp = !document.querySelector('#sc-textedit').classList.contains('hidden');
      const inp = document.querySelector('#sc-te-input');
      inp.value = 'hello campfire';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      const live = document.querySelector('#sc-ov .ov-text');
      const whileTyping = { text: live && live.textContent, inLayer: !!live };
      document.querySelector('#sc-te-done').click();
      const layerBox = document.querySelector('#sc-ov').getBoundingClientRect();
      const itemBox = document.querySelector('#sc-ov .ov-text').getBoundingClientRect();
      const centred = Math.abs((itemBox.left + itemBox.width / 2) - (layerBox.left + layerBox.width / 2)) < 8;
      // Emoji: a sticker, dropped in the middle.
      document.querySelector('#sc-tool-emoji').click();
      const gridUp = !document.querySelector('#sc-emoji').classList.contains('hidden');
      const first = document.querySelector('#sc-emoji-grid button');
      const sticker = first && first.textContent;
      first.click();
      document.querySelector('#sc-emoji-close').click();
      // Drawing: freehand, in the layer's own coordinates.
      document.querySelector('#sc-tool-draw').click();
      const drawOn = sc.draw && !document.querySelector('#sc-colors').classList.contains('hidden');
      const lay = document.querySelector('#sc-ov');
      const r = lay.getBoundingClientRect();
      const p = (type, id, fx, fy) => __pt(lay, type, id, r.left + r.width * fx, r.top + r.height * fy);
      p('pointerdown', 1, 0.15, 0.15);
      for (let i = 1; i <= 10; i++) p('pointermove', 1, 0.15 + i * 0.06, 0.15 + i * 0.05);
      p('pointerup', 1, 0.75, 0.65);
      const strokes = sc.ovs.filter((o) => o.t === 'draw');
      const beforeUndo = strokes.length;
      document.querySelector('#sc-tool-undo').click();
      const afterUndo = sc.ovs.filter((o) => o.t === 'draw').length;
      p('pointerdown', 1, 0.2, 0.6);
      for (let i = 1; i <= 8; i++) p('pointermove', 1, 0.2 + i * 0.06, 0.6 - i * 0.03);
      p('pointerup', 1, 0.68, 0.36);
      document.querySelector('#sc-tool-draw').click();
      const canvas = document.querySelector('#sc-ov canvas.ov-draw');
      const ctx = canvas.getContext('2d');
      const px = ctx.getImageData(Math.round(canvas.width * 0.3), Math.round(canvas.height * 0.55), 1, 1).data;
      return {
        sheetUp, whileTyping, centred, gridUp, sticker, drawOn, beforeUndo, afterUndo,
        kinds: sc.ovs.map((o) => o.t), drawPts: (sc.ovs.find((o) => o.t === 'draw') || {}).p ? sc.ovs.find((o) => o.t === 'draw').p.length : 0,
        painted: px[3] > 0, layerItems: document.querySelectorAll('#sc-ov .ov-item').length,
      };
    })()`, true);
    check(markup.sheetUp, 'the text tool opens an editor', markup);
    check(markup.whileTyping.inLayer && markup.whileTyping.text === 'hello campfire', 'the text paints on the picture as you type', markup.whileTyping);
    check(markup.centred, 'a new text sticker lands in the middle of the picture', markup);
    check(markup.gridUp && markup.sticker, 'the emoji sheet offers stickers', markup);
    check(markup.drawOn, 'the pen mode shows its colours', markup);
    check(markup.beforeUndo === 1 && markup.afterUndo === 0, 'undo drops the last stroke', markup);
    check(markup.drawPts > 4, 'the drawn stroke is a real point list', markup);
    check(markup.painted, 'the stroke is actually painted on the overlay canvas', markup);
    check(markup.kinds.filter((k) => k === 'draw').length === 1 && markup.kinds.includes('text') && markup.kinds.includes('emoji'),
      'the shot carries text + emoji + a stroke', markup.kinds);
    await shot('campfire-story-edit.png');

    console.log('\n[7] a sticker drags, and the text on the picture stays where it was put');
    const drag = await evaluate(`(() => {
      const lay = document.querySelector('#sc-ov');
      const el = document.querySelector('#sc-ov .ov-item');
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      // Which item answers is the hit test's business (they can overlap); the
      // check is that the one that was grabbed is the one that moved.
      __pt(lay, 'pointerdown', 1, cx, cy);
      const i = sc.sel;
      const before = { x: sc.ovs[i].x, y: sc.ovs[i].y };
      __pt(lay, 'pointermove', 1, cx + 60, cy + 40);
      __pt(lay, 'pointerup', 1, cx + 60, cy + 40);
      const after = { x: sc.ovs[i].x, y: sc.ovs[i].y };
      const selected = sc.sel === i && document.querySelector('.ov-item.ov-sel') !== null;
      const br = lay.getBoundingClientRect();
      __pt(lay, 'pointerdown', 1, br.left + 3, br.top + 3);
      __pt(lay, 'pointerup', 1, br.left + 3, br.top + 3);
      const deselected = document.querySelector('#sc-ov .ov-item.ov-sel') === null;
      return { i, before, after, selected, deselected, delHidden: document.querySelector('#sc-tool-del').classList.contains('hidden') };
    })()`);
    check(drag.after.x > drag.before.x + 0.05 && drag.after.y > drag.before.y + 0.03, 'dragging moves the sticker with the finger', drag);
    check(drag.selected, 'and it is selected while it moves', drag);
    check(drag.deselected && drag.delHidden, 'a tap on empty space deselects', drag);

    console.log('\n[8] post it, and the markup survives the server');
    const posted = await evaluate(`(async () => {
      document.querySelector('#sc-next').click();
      const post = document.querySelector('#sc-post');
      post.click();
      const t0 = performance.now();
      while (performance.now() - t0 < 30000 && sc) await new Promise((r) => setTimeout(r, 100));
      return { closed: sc === null, postLabel: post.textContent };
    })()`, true);
    check(posted.closed, 'the story posts and the composer closes', posted);
    const api = await evaluate(`(async () => {
      const d = await api('/api/stories');
      const mine = (d.mine && d.mine.items) || [];
      const it = mine[0] || null;
      return it ? { n: it.overlays.length, kinds: it.overlays.map((o) => o.t), text: (it.overlays.find((o) => o.t === 'text') || {}).text,
                    emoji: (it.overlays.find((o) => o.t === 'emoji') || {}).e, pts: (it.overlays.find((o) => o.t === 'draw') || {}).p.length } : { n: 0 };
    })()`);
    check(api.n === 3 && api.text === 'hello campfire', 'the server stored the markup', api);
    check(api.pts > 4, 'including the drawing', api);
    await new Promise((r) => setTimeout(r, 3300)); // the anti-flood gap
    const bad = await evaluate(`(async () => {
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR4nGNgGAWDHjAyMDD8J1czIyMjA1KQEUwGAGZ3A0FyYw0eAAAAAElFTkSuQmCC'), (c) => c.charCodeAt(0));
      const f = new FormData();
      f.append('file', new Blob([png], { type: 'image/png' }), 'x.png');
      const up = await fetch('/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + store.token }, body: f });
      const u = await up.json();
      const r = await fetch('/api/stories', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + store.token }, body: JSON.stringify({ url: u.url, mime: u.mime, overlays: [{ t: 'text', text: 'x'.repeat(900), x: 99, y: -99, r: 900 }, { t: 'nope' }, { t: 'draw', p: Array.from({ length: 2000 }, () => [0.5, 0.5]) }] }) });
      const d = await r.json();
      if (!d.story) return { error: d.error, status: r.status };
      const t = d.story.overlays.find((o) => o.t === 'text') || {};
      const draw = d.story.overlays.find((o) => o.t === 'draw') || {};
      return { n: d.story.overlays.length, len: (t.text || '').length, x: t.x, y: t.y, r: t.r, pts: (draw.p || []).length };
    })()`);
    check(bad.n === 2, 'the server drops unknown item types', bad);
    check(bad.len === 200, 'caps a long text', bad);
    check(bad.x <= 1.5 && bad.y >= -0.5 && Math.abs(bad.r) <= 360, 'and clamps coordinates/rotation it was lied to about', bad);
    check(bad.pts > 0 && bad.pts <= 300, 'and caps a stroke\'s points', bad);

    console.log('\n[9] the viewer renders it over the story');
    const viewed = await evaluate(`(async () => {
      await loadStories();
      openStoryViewer({ kind: 'mine' });
      const t0 = performance.now();
      while (performance.now() - t0 < 10000) {
        if (document.querySelector('#sv-ov .ov-text')) break;
        await new Promise((r) => setTimeout(r, 80));
      }
      const layer = document.querySelector('#sv-ov');
      const img = document.querySelector('#sv-img');
      const stage = document.querySelector('#sv-stage');
      const lr = layer.getBoundingClientRect();
      const ir = img.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      const cv = document.querySelector('#sv-ov canvas.ov-draw');
      let painted = false;
      if (cv) { const c = cv.getContext('2d'); const d = c.getImageData(Math.round(cv.width * 0.3), Math.round(cv.height * 0.55), 1, 1).data; painted = d[3] > 0; }
      return {
        text: (document.querySelector('#sv-ov .ov-text') || {}).textContent || '',
        emoji: !!document.querySelector('#sv-ov .ov-emoji'),
        items: document.querySelectorAll('#sv-ov .ov-item').length,
        painted,
        layerOverPicture: Math.abs(lr.left - ir.left) < 2 && Math.abs(lr.top - ir.top) < 2 && Math.abs(lr.width - ir.width) < 2,
        inside: lr.left >= sr.left - 2 && lr.right <= sr.right + 2,
      };
    })()`, true);
    check(viewed.text === 'hello campfire', 'the viewer shows the text', viewed);
    check(viewed.emoji && viewed.items === 2, 'and the sticker', viewed);
    check(viewed.painted, 'and the drawing', viewed);
    check(viewed.layerOverPicture && viewed.inside, 'the markup is anchored to the picture, not the screen', viewed);
    await shot('campfire-story-view.png');
    await evaluate(`svClose(); true`);

    console.log('\n[10] a text-only story, with a background to choose');
    const textOnly = await evaluate(`(async () => {
      const open = await openStoryComposer();
      const stage = document.querySelector('#sc-stage');
      const before = { w: stage.clientWidth, h: stage.clientHeight };
      document.querySelector('#sc-textonly').click();
      const t0 = performance.now();
      while (performance.now() - t0 < 15000 && !(sc && sc.step === 'preview' && sc.blob)) await new Promise((r) => setTimeout(r, 80));
      const shot = document.querySelector('#sc-shot');
      const swatches = document.querySelectorAll('#sc-colors .sc-swatch').length;
      const kb = sc.blob ? Math.round(sc.blob.size / 1024) : 0;
      const textSheet = !document.querySelector('#sc-textedit').classList.contains('hidden');
      const firstUrl = sc.previewUrl;
      // The selected text colour scales past its own box, and a horizontally
      // scrollable row clips vertically too (overflow-x:auto drags overflow-y
      // with it): the white highlight ring used to be sliced off along the top.
      const colorRow = document.querySelector('#sc-te-colors');
      const colorSw = [...colorRow.querySelectorAll('.sc-swatch')];
      colorSw[3].click();
      const cOn = colorRow.querySelector('.sc-swatch.on');
      const cr = colorRow.getBoundingClientRect();
      const co = cOn.getBoundingClientRect();
      const clip = {
        idx: [...colorRow.querySelectorAll('.sc-swatch')].indexOf(cOn),
        aboveTop: +(cr.top - co.top).toFixed(2),
        belowBottom: +(co.bottom - cr.bottom).toFixed(2),
        overflowY: getComputedStyle(colorRow).overflowY,
        ring: getComputedStyle(cOn).borderTopColor,
      };
      // With the text sheet up, the background row has to still be reachable:
      // it used to sit *behind* the sheet, so you had to tap Done before a
      // background could be picked at all.
      const reach = (() => {
        const row = document.querySelector('#sc-colors');
        const sws = [...row.querySelectorAll('.sc-swatch')];
        const sheetTop = document.querySelector('#sc-textedit').getBoundingClientRect().top;
        const hit = (el) => {
          const r = el.getBoundingClientRect();
          const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return t === el || (t && t.closest && t.closest('.sc-swatch') === el);
        };
        return {
          count: sws.length,
          tiles: row.querySelectorAll('.sc-swatch.tile').length,
          radius: getComputedStyle(sws[0]).borderTopLeftRadius,
          overSheet: sws.filter((s) => s.getBoundingClientRect().bottom > sheetTop).length,
          firstHittable: hit(sws[0]),
          lastHittable: hit(sws[sws.length - 1]),
          sheetOpen: !document.querySelector('#sc-textedit').classList.contains('hidden'),
        };
      })();
      const inp = document.querySelector('#sc-te-input');
      inp.value = 'purple vibes';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sc-te-done').click();
      const textItems = sc.ovs.filter((o) => o.t === 'text').length;
      const firstImg = new Image();
      firstImg.src = firstUrl;
      await new Promise((res) => { firstImg.onload = res; firstImg.onerror = res; });
      const beforeImage = { w: firstImg.naturalWidth, h: firstImg.naturalHeight };
      if (swatches > 2) document.querySelectorAll('#sc-colors .sc-swatch')[2].click();
      const t1 = performance.now();
      while (performance.now() - t1 < 10000 && sc.previewUrl === firstUrl) await new Promise((r) => setTimeout(r, 60));
      const img = new Image();
      img.src = sc.previewUrl;
      await new Promise((res) => { img.onload = res; img.onerror = res; });
      return {
        textOnly: sc.textOnly, kind: sc.kind, kb, type: sc.blob.type, textSheet, swatches, reach, clip, textItems,
        bg: sc.textBg, changed: sc.previewUrl !== firstUrl, sawShot: !shot.classList.contains('hidden'),
        w: img.naturalWidth, h: img.naturalHeight, first: beforeImage,
        stageW: before.w, stageH: before.h,
      };
    })()`, true);
    check(textOnly.textOnly && textOnly.kind === 'image', 'a text-only story needs no camera', textOnly);
    check(textOnly.type === 'image/jpeg' && textOnly.kb > 0, 'it has real bytes behind it', textOnly);
    check(textOnly.swatches >= 6, 'there are backgrounds to choose from', textOnly);
    check(textOnly.reach.sheetOpen && textOnly.reach.tiles === textOnly.reach.count,
      'the backgrounds are gradient tiles, not a ramp clipped into a circle', textOnly.reach);
    check(textOnly.reach.radius !== '50%', 'so they are not circles', textOnly.reach);
    check(textOnly.reach.overSheet === 0 && textOnly.reach.firstHittable && textOnly.reach.lastHittable,
      'and the row is not buried under the text sheet', textOnly.reach);
    check(textOnly.clip.idx === 3 && textOnly.clip.aboveTop <= 0 && textOnly.clip.belowBottom <= 0,
      'a picked colour keeps its whole highlight ring', textOnly.clip);
    check(textOnly.changed && textOnly.bg === 2, 'picking one repaints the background', textOnly);
    check(textOnly.textSheet && textOnly.sawShot, 'and the text editor opens on it', textOnly);
    check(textOnly.w === textOnly.first.w && textOnly.h === textOnly.first.h,
      'and the picture keeps its shape, so the markup does not slide', { first: textOnly.first, after: { w: textOnly.w, h: textOnly.h } });
    check(textOnly.textItems === 1, 'the typed text is a markup item on the story', textOnly);
    await shot('campfire-story-text.png');

    console.log('\n[11] the rail ring previews what a text-only story actually says');
    // The server refuses a second story inside STORY_MIN_GAP_MS (3 s); the
    // sections above can easily finish inside that.
    await sleep(3400);
    const textOnlyPosted = await evaluate(`(async () => {
      document.querySelector('#sc-next').click();
      document.querySelector('#sc-post').click();
      const t0 = performance.now();
      let sawLabel = '';
      while (performance.now() - t0 < 30000 && sc) { await new Promise((r) => setTimeout(r, 100)); if (!sawLabel) sawLabel = document.querySelector('#sc-post').textContent; }
      return { closed: sc === null, label: sawLabel, postLabel: document.querySelector('#sc-post').textContent,
               disabled: document.querySelector('#sc-post').disabled, step: sc && sc.step,
               toast: (document.querySelector('#toast') || {}).textContent || '',
               overlayKinds: sc ? sc.ovs.map((o) => o.t) : null };
    })()`, true);
    check(textOnlyPosted.closed, 'the text-only story posts', textOnlyPosted);
    const ringShot = await evaluate(`(async () => {
      const d = await api('/api/stories');
      const items = (d.mine && d.mine.items) || [];
      const it = items.find((i) => (i.overlays || []).some((o) => o.t === 'text' && o.text === 'purple vibes'));
      if (!it) return { error: 'no_text_only_story', seen: items.map((i) => (i.overlays || []).map((o) => o.text)) };
      // A story posted seconds ago may still be unservable: the /uploads gate
      // answers 423 until the scan verdict lands, which an <img> reads as an
      // error. That is exactly what the thumbnail retry is for, so note what
      // the first request saw and give the retry time to come back.
      const firstStatus = await (await fetch(it.url)).status;
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:4px;top:4px;width:58px;height:58px;z-index:9999';
      document.body.appendChild(host);
      host.appendChild(storyRing(S.me, false, [it]));
      await new Promise((r) => setTimeout(r, 2600));
      const wrap = host.querySelector('.st-thumb-ov');
      const layer = wrap && wrap.querySelector('.ov-layer');
      const media = wrap && wrap.querySelector('.st-thumb-media');
      const txt = host.querySelector('.ov-text');
      const lr = layer && layer.getBoundingClientRect();
      const mr = media && media.getBoundingClientRect();
      const out = {
        firstStatus,
        wrapper: !!wrap,
        loaded: !!media && media.naturalWidth > 0,
        text: txt ? txt.textContent : '',
        items: host.querySelectorAll('.ov-item').length,
        textPx: txt ? Math.round(parseFloat(getComputedStyle(txt).fontSize)) : 0,
        thumbPx: wrap ? Math.round(wrap.getBoundingClientRect().width) : 0,
        // cover: the layer covers the whole circle and overhangs on one axis,
        // staying centred on the photo.
        covers: !!lr && !!mr && lr.width >= mr.width - 0.5 && lr.height >= mr.height - 0.5,
        overflows: !!lr && !!mr && (lr.width > mr.width + 1 || lr.height > mr.height + 1),
        centred: !!lr && !!mr
          && Math.abs((lr.left + lr.width / 2) - (mr.left + mr.width / 2)) <= 1
          && Math.abs((lr.top + lr.height / 2) - (mr.top + mr.height / 2)) <= 1,
      };
      host.remove();
      return out;
    })()`, true);
    check(ringShot.wrapper && ringShot.loaded, 'a story with markup gets the composited ring thumbnail', ringShot);
    check(ringShot.text === 'purple vibes', 'the ring shows the text, not just the background', ringShot);
    check(ringShot.items === 1 && ringShot.textPx >= 3 && ringShot.thumbPx > 40, 'sized to the ring', ringShot);
    check(ringShot.covers && ringShot.overflows && ringShot.centred,
      'laid over the background the way the ring crops it (cover, centred)', ringShot);

    console.log('\n[12] a story sent privately keeps its markup in the one-shot player');
    const vonce = await evaluate(`(async () => {
      if (sc) closeStoryComposer(); // never inherit a composer from a failure above
      // A second account, befriended, so the story can be delivered as the
      // gated view-once copy the server re-files under viewonce/.
      const b = await api('/api/register', { method: 'POST', body: JSON.stringify({ username: 'pal', displayName: 'Pal', password: 'passw0rd!y' }) });
      const bToken = b.token, bId = b.user.id;
      const mineId = S.me.id;
      await api('/api/friends', { method: 'POST', body: JSON.stringify({ username: 'pal' }) });
      const acc = await fetch('/api/friends/' + mineId + '/accept', { method: 'POST', headers: { Authorization: 'Bearer ' + bToken } });
      if (!acc.ok) return { error: 'friend_accept_' + acc.status };
      // Compose a normal markup story, then send it to that one friend.
      await openStoryComposer();
      let t0 = performance.now();
      while (performance.now() - t0 < 12000 && !(sc && sc.camReady)) await new Promise((r) => setTimeout(r, 80));
      document.querySelector('#sc-shutter').click();
      t0 = performance.now();
      while (performance.now() - t0 < 20000 && (sc.pendingShot || !sc.blob)) await new Promise((r) => setTimeout(r, 80));
      document.querySelector('#sc-tool-text').click();
      const inp = document.querySelector('#sc-te-input');
      inp.value = 'for your eyes';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sc-te-done').click();
      sc.audFriends = false; sc.audServers = []; sc.audUsers = [bId];
      renderStoryAudience();
      storySetStep('audience');
      storyPostNow();
      t0 = performance.now();
      while (performance.now() - t0 < 30000 && sc) await new Promise((r) => setTimeout(r, 100));
      // Now look at it as the recipient.
      store.token = bToken;
      const dms = await api('/api/dms');
      let mid = null;
      for (const t of (dms.threads || [])) {
        const ms = await api('/api/dms/' + t.id + '/messages?limit=20');
        const m = (ms.messages || []).find((x) => x.viewOnce && x.viewOnce.state === 'unopened');
        if (m) { mid = m.id; break; }
      }
      if (!mid) return { error: 'no_viewonce_in_dms' };
      await openViewOnce(mid);
      t0 = performance.now();
      while (performance.now() - t0 < 10000 && !document.querySelector('#vo-ov .ov-text')) await new Promise((r) => setTimeout(r, 80));
      const layer = document.querySelector('#vo-ov');
      const media = document.querySelector('#vo-stage > img, #vo-stage > video');
      const lr = layer.getBoundingClientRect(), mr = media.getBoundingClientRect();
      return {
        text: (document.querySelector('#vo-ov .ov-text') || {}).textContent || '',
        items: document.querySelectorAll('#vo-ov .ov-item').length,
        overPicture: Math.abs(lr.left - mr.left) < 2 && Math.abs(lr.top - mr.top) < 2 && Math.abs(lr.width - mr.width) < 2,
      };
    })()`, true);
    check(vonce.text === 'for your eyes', 'the view-once player renders the story\'s text', vonce);
    check(vonce.items === 1, 'with the right markup', vonce);
    check(vonce.overPicture, 'laid over the one-shot media', vonce);

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

function tfIncludes(tf, needle) { return String(tf || '').includes(needle); }

main().catch((e) => { console.error('[test] crashed:', (e && e.message) || e); process.exit(1); });
