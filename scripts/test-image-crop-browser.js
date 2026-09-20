// The profile-media crop stage, in a real browser (see AGENTS.md verification
// conventions).
//
// scripts/test-image-crop.js proves the transform arithmetic, the encoder, and
// that the wiring exists. This proves the STAGE: the real public/js/crop.js, the
// real stylesheet and the real layer markup out of index.html, driven in headless
// Chrome with the two calls the module makes (uploadImage / api) stubbed and the
// rectangles captured.
//
// What it is here to catch, in order of how quietly it would break:
//   - the window is the shape of the surface and the picture COVERS it (a
//     background that does not cover shows bare stage, and a wrong aspect means
//     the preview lies about the result);
//   - a drag moves the framing and stops at the picture's edge, and a zoom keeps
//     the point under the cursor — driven through real pointer events;
//   - the message box under the stage shows the SAME source rectangle as the
//     window (it is the crop, not a second look at the original);
//   - Save posts the rectangle to the right endpoint, as multipart for a picked
//     file and as JSON for a Klipy URL, and the rectangle is inside the picture;
//   - a GIF is left as a background layer, so it is STILL ANIMATING while you
//     frame it — proved by two screenshots a few frames apart differing on the
//     stage, with a still picture as the control that must NOT differ (a canvas
//     flattening it, or a frozen frame, fails this and nothing else).
//
// Skips (exit 0) when Chrome is unavailable; the animation half also skips
// without ffmpeg (it uses a generated GIF, never a fixture).
//
// Usage: node scripts/test-image-crop-browser.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9347', 10);

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

// A real PNG, generated (no fixtures): a flat colour, so the two screenshots the
// animation check compares cannot differ for any reason but the picture moving.
function pngBytes(w, h, rgb) {
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
const dataUrl = (mime, buf) => `data:${mime};base64,` + buf.toString('base64');

// The real layer markup, sliced out of index.html between its own comment and
// the next element — the page under test must be the shipped one.
function cropMarkup() {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const a = html.indexOf('<div id="crop-backdrop"');
  const b = html.indexOf('<!-- create-story chooser');
  if (a < 0 || b < 0 || b < a) throw new Error('the crop layer markup is gone from index.html');
  return html.slice(a, b).trimEnd();
}

function pageHtml(cropSource) {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<style>${fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8')}</style>
</head><body>
${cropMarkup()}
<script>
// The two calls crop.js makes, captured instead of sent; everything else the
// module touches is the real thing.
const $ = (s) => document.querySelector(s);
window.__toasts = [];
window.__calls = [];
window.__done = null;
function toast(m) { window.__toasts.push(String(m)); }
function prettyError(e) { return String((e && e.message) || e || ''); }
async function uploadImage(url, file, fields) {
  window.__calls.push({ url, via: 'multipart', name: file && file.name, fields: fields || null });
  return { user: { id: 'u1', avatar_url: '/uploads/avatars/cropped.webp' } };
}
async function api(url, opts) {
  window.__calls.push({ url, via: 'json', body: JSON.parse((opts && opts.body) || '{}') });
  return { user: { id: 'u1', avatar_url: '/uploads/avatars/cropped.webp' } };
}
// The geometry the stage resolved and the source rectangle each box is really
// showing, read back out of the two background layers — that pair is the whole
// contract between this module and the stylesheet. The natural size comes from
// the module's own state (cropState is a script-scope binding, so an evaluated
// expression can still see it) rather than from this test's assumptions.
window.__view = () => {
  const stage = document.querySelector('#crop-stage');
  const prev = document.querySelector('#crop-preview');
  const num = (s, i) => {
    const m = String(s || '').match(/(-?[\\d.]+)px/g) || [];
    return m[i] === undefined ? NaN : parseFloat(m[i]);
  };
  const st = (typeof cropState !== 'undefined' && cropState) ? cropState : null;
  const natW = st ? st.natW : 0, natH = st ? st.natH : 0;
  const sw = num(stage.style.backgroundSize, 0), sh = num(stage.style.backgroundSize, 1);
  const sx = num(stage.style.backgroundPosition, 0), sy = num(stage.style.backgroundPosition, 1);
  const pw = num(prev.style.backgroundSize, 0), ph = num(prev.style.backgroundSize, 1);
  const px = num(prev.style.backgroundPosition, 0), py = num(prev.style.backgroundPosition, 1);
  const srcOf = (dw, dh, ox, oy, boxW, boxH) => {
    const kx = natW / dw, ky = natH / dh;
    return { x: -ox * kx, y: -oy * ky, w: boxW * kx, h: boxH * ky };
  };
  return {
    open: !document.querySelector('#crop-backdrop').classList.contains('hidden'),
    saveDisabled: document.querySelector('#crop-save').disabled,
    natW, natH,
    winW: stage.clientWidth, winH: stage.clientHeight,
    styleW: parseFloat(stage.style.width), styleH: parseFloat(stage.style.height),
    stage: { size: stage.style.backgroundSize, pos: stage.style.backgroundPosition, sw, sh, sx, sy },
    preview: { w: prev.clientWidth, h: prev.clientHeight, size: prev.style.backgroundSize, pos: prev.style.backgroundPosition, pw, ph, px, py },
    stageRect: srcOf(sw, sh, sx, sy, stage.clientWidth, stage.clientHeight),
    previewRect: srcOf(pw, ph, px, py, prev.clientWidth, prev.clientHeight),
    moduleRect: st && st.view ? cropViewRect(st.view) : null,
    zoom: Number(document.querySelector('#crop-zoom').value),
    title: document.querySelector('#crop-title').textContent,
    bg: getComputedStyle(stage).backgroundImage.slice(0, 40),
  };
};
// A drag through the real handlers: synthetic pointer events, since the module
// reads nothing but clientX/clientY and the element's own rect.
window.__drag = (dx, dy) => {
  const stage = document.querySelector('#crop-stage');
  const box = stage.getBoundingClientRect();
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  const mk = (type, x, y) => new PointerEvent(type, { pointerId: 7, clientX: x, clientY: y, bubbles: true, cancelable: true });
  stage.dispatchEvent(mk('pointerdown', cx, cy));
  stage.dispatchEvent(mk('pointermove', cx + dx, cy + dy));
  stage.dispatchEvent(mk('pointerup', cx + dx, cy + dy));
};
window.__zoomTo = (v) => {
  const z = document.querySelector('#crop-zoom');
  z.value = String(v);
  z.dispatchEvent(new Event('input', { bubbles: true }));
};
window.__file = (b64, name, mime) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: mime });
};
</script>
<script>${cropSource}</script>
</body></html>`;
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  // A 3:1 picture (so a 3:1 window shows all of it) and a portrait one.
  const widePng = pngBytes(1200, 400, [220, 40, 40]);
  const wideUrl = dataUrl('image/png', widePng);
  const tallUrl = dataUrl('image/png', pngBytes(400, 1200, [40, 200, 90]));

  // A real animated GIF, two flat frames, for the "it is still moving" half.
  let gifUrl = null;
  const ff = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (ff && ff.status === 0) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-crop-br-'));
    const out = path.join(tmp, 'two.gif');
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0xdd2222:s=240x240:r=6:d=0.17',
      '-f', 'lavfi', '-i', 'color=c=0x2233dd:s=240x240:r=6:d=0.17',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[out]', '-map', '[out]', '-loop', '0', out], { stdio: 'ignore' });
    if (r.status === 0 && fs.existsSync(out)) gifUrl = dataUrl('image/gif', fs.readFileSync(out));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-crop-page-'));
  const file = path.join(dir, 'crop.html');
  fs.writeFileSync(file, pageHtml(fs.readFileSync(path.join(ROOT, 'public/js/crop.js'), 'utf8')));

  let chrome = null, ws = null;
  try {
    chrome = spawn(chromePath, [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(dir, 'chrome')}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
      '--hide-scrollbars', '--window-size=900,800', 'about:blank',
    ], { stdio: 'ignore' });
    let ver = null;
    for (let i = 0; i < 80 && !ver; i++) {
      try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch {}
      if (!ver) await sleep(250);
    }
    if (!ver) return skip('Chrome did not expose the DevTools port');
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
    const waitFor = async (expr, ms = 8000) => {
      const t0 = Date.now();
      for (;;) {
        try { const v = await evaluate(`(() => { try { return ${expr} } catch (e) { return false } })()`); if (v) return v; } catch {}
        if (Date.now() - t0 > ms) return null;
        await sleep(120);
      }
    };
    const shot = async () => (await send('Page.captureScreenshot', { format: 'png' })).data;
    // Open a stage on a real picture and wait for it to be ready to save.
    const open = async (kind, src) => {
      await evaluate(`openCropStage({ kind: ${JSON.stringify(kind)}, ${src}, onDone: (d) => { window.__done = d; } })`);
      const ready = await waitFor(`!document.querySelector('#crop-save').disabled`);
      if (!ready) throw new Error('the stage never became ready (' + kind + ')');
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'file:///' + file.replace(/\\/g, '/') });
    check(!!(await waitFor(`typeof openCropStage === 'function' && !!document.querySelector('#crop-stage')`)),
      'the real crop.js and the real layer markup are on the page');

    console.log('\n[1] the window is the surface\'s shape, and the picture covers it');
    await open('banner', `url: ${JSON.stringify(wideUrl)}`);
    let v = await evaluate('window.__view()');
    check(v.open, 'the stage is on screen');
    check(v.natW === 1200 && v.natH === 400, 'the picture\'s own size was measured', { natW: v.natW, natH: v.natH });
    check(Math.abs(v.winW / v.winH - 3) < 0.02, 'a banner window is 3:1', { winW: v.winW, winH: v.winH });
    check(v.winW === v.styleW && v.winH === v.styleH, 'and the painted box is the box the module measured', { styleW: v.styleW, winW: v.winW });
    check(v.stage.sw >= v.winW - 0.5 && v.stage.sh >= v.winH - 0.5, 'the picture covers the window', v.stage);
    check(Math.abs(v.stage.sw - v.winW) < 0.5 || Math.abs(v.stage.sh - v.winH) < 0.5,
      'and is fitted by exactly one edge (no stray margin)', v.stage);
    // A window is a whole number of pixels, so a 3:1 picture in it is the whole
    // picture give or take the pixel the odd height rounds away.
    check(Math.abs(v.stageRect.w - 1200) < 4 && Math.abs(v.stageRect.h - 400) < 4,
      'a 3:1 picture in a 3:1 window is essentially the whole picture', v.stageRect);
    check(Math.abs(v.moduleRect.w - v.stageRect.w) < 1 && Math.abs(v.moduleRect.x - v.stageRect.x) < 1,
      'and the rectangle the module would send is the one on screen', { module: v.moduleRect, painted: v.stageRect });
    check(Math.abs(v.previewRect.w - v.stageRect.w) < 2 && Math.abs(v.previewRect.x - v.stageRect.x) < 2
      && Math.abs(v.previewRect.h - v.stageRect.h) < 2,
      'the preview under the window shows the same crop', { p: v.previewRect, s: v.stageRect });
    check(v.title === 'Crop banner', 'with the surface\'s own title', v.title);

    console.log('\n[2] a portrait picture in that window frames a band, not the whole thing');
    await open('banner', `url: ${JSON.stringify(tallUrl)}`);
    v = await evaluate('window.__view()');
    check(v.natW === 400 && v.natH === 1200, 'a 400x1200 picture', { natW: v.natW, natH: v.natH });
    check(Math.abs(v.stageRect.w - 400) < 2 && Math.abs(v.stageRect.h - 133) < 3,
      'is framed as a 400x133 band', v.stageRect);
    check(v.stageRect.y >= 0 && v.stageRect.y + v.stageRect.h <= 1200, 'inside the picture', v.stageRect);
    // Dragging UP reveals the lower part; dragging DOWN from the centre is
    // already clamped (the picture is centred to begin with).
    await evaluate('window.__drag(0, -60)');
    const dragged = await evaluate('window.__view()');
    check(dragged.stageRect.y > v.stageRect.y, 'a drag moves which part of the picture is framed',
      { before: v.stageRect.y, after: dragged.stageRect.y });
    await evaluate('window.__drag(0, 9999)');
    const clamped = await evaluate('window.__view()');
    check(Math.abs(clamped.stageRect.y) < 2, 'and a drag past the top edge stops there', clamped.stageRect);
    await evaluate('window.__drag(0, -9999)');
    const clamped2 = await evaluate('window.__view()');
    check(clamped2.stageRect.y + clamped2.stageRect.h <= 1201 && Math.abs((clamped2.stageRect.y + clamped2.stageRect.h) - 1200) < 3,
      'and the other way stops at the bottom', clamped2.stageRect);

    console.log('\n[3] zoom is anchored on the middle of the window');
    await open('banner', `url: ${JSON.stringify(wideUrl)}`);
    const before = await evaluate('window.__view()');
    check(before.zoom === 1, 'it opens at the cover fit', before.zoom);
    await evaluate('window.__zoomTo(2)');
    const zoomed = await evaluate('window.__view()');
    check(Math.abs(zoomed.zoom - 2) < 0.01, 'the slider zooms to 2x', zoomed.zoom);
    check(zoomed.stage.sw > before.stage.sw * 1.9, 'the picture really is twice as big', { was: before.stage.sw, now: zoomed.stage.sw });
    check(Math.abs(zoomed.stageRect.w - before.stageRect.w / 2) < 2, 'so the frame is half as wide', { was: before.stageRect.w, now: zoomed.stageRect.w });
    const cBefore = before.stageRect.x + before.stageRect.w / 2;
    const cAfter = zoomed.stageRect.x + zoomed.stageRect.w / 2;
    check(Math.abs(cBefore - cAfter) < 3, 'and it zoomed about the middle of the window', { cBefore, cAfter });
    await evaluate('window.__zoomTo(1)');
    const unzoomed = await evaluate('window.__view()');
    check(Math.abs(unzoomed.stageRect.x - before.stageRect.x) < 3 && Math.abs(unzoomed.stageRect.w - before.stageRect.w) < 3,
      'and zooming back out returns to the same framing', { before: before.stageRect, after: unzoomed.stageRect });

    console.log('\n[4] the shapes: avatar is square, sidebar is a row');
    await open('avatar', `url: ${JSON.stringify(wideUrl)}`);
    v = await evaluate('window.__view()');
    check(Math.abs(v.winW - v.winH) <= 1, 'an avatar window is square', { winW: v.winW, winH: v.winH });
    check(Math.abs(v.preview.w - v.preview.h) <= 1, 'and its preview is a square (worn as a circle)', v.preview);
    await open('sidebar', `url: ${JSON.stringify(wideUrl)}`);
    v = await evaluate('window.__view()');
    check(Math.abs(v.winW / v.winH - 6) < 0.06, 'a sidebar banner window is 6:1', { winW: v.winW, winH: v.winH });
    check(v.preview.w >= 200, 'and its preview is wide enough to read a row', v.preview);

    console.log('\n[5] Save posts the frame it framed (a remote source goes up as a URL)');
    await evaluate('window.__calls = []; window.__done = null');
    await open('avatar', `url: ${JSON.stringify(wideUrl)}`);
    await evaluate('window.__zoomTo(2); window.__drag(-40, 0)');
    const framed = await evaluate('window.__view()');
    await evaluate(`document.querySelector('#crop-save').click()`);
    check(!!(await waitFor('window.__calls.length > 0')), 'Save posted');
    const call = await evaluate('window.__calls[0]');
    check(call.url === '/api/me/avatar/crop', 'to the surface\'s own crop route', call.url);
    check(call.via === 'json' && typeof call.body.url === 'string',
      'a Klipy source is posted as a URL (the server fetches it, because a canvas cannot read a cross-origin GIF back out)', call);
    const body = call.body;
    check(['x', 'y', 'w', 'h'].every((k) => Number.isInteger(body[k]) && body[k] >= 0), 'with an integer rectangle', body);
    check(Math.abs(body.x - framed.stageRect.x) <= 1 && Math.abs(body.y - framed.stageRect.y) <= 1
      && Math.abs(body.w - framed.stageRect.w) <= 1 && Math.abs(body.h - framed.stageRect.h) <= 1,
      'matching exactly what the window was showing', { sent: body, shown: framed.stageRect });
    check(body.x + body.w <= framed.natW && body.y + body.h <= framed.natH, 'and inside the picture', { body, nat: [framed.natW, framed.natH] });
    check(!!(await waitFor('window.__done && window.__done.user')), 'the caller got the saved user back');
    check(!(await evaluate('window.__view().open')), 'and the stage closed itself');
    check((await evaluate('window.__toasts')).length === 0, 'with no error toast');

    console.log('\n[6] a picked file goes up as bytes, with the same rectangle');
    await evaluate('window.__calls = []');
    await evaluate(`(() => {
      const f = window.__file(${JSON.stringify(widePng.toString('base64'))}, 'face.png', 'image/png');
      openCropStage({ kind: 'sidebar', file: f });
    })()`);
    check(!!(await waitFor(`!document.querySelector('#crop-save').disabled`)), 'the picked file loaded');
    const framedFile = await evaluate('window.__view()');
    await evaluate(`document.querySelector('#crop-save').click()`);
    check(!!(await waitFor('window.__calls.length > 0')), 'Save posted the file');
    const callFile = await evaluate('window.__calls[0]');
    check(callFile.via === 'multipart' && callFile.name === 'face.png', 'as multipart with the picked file', callFile);
    check(callFile.url === '/api/me/sidebar/crop', 'to the sidebar route', callFile.url);
    check(['x', 'y', 'w', 'h'].every((k) => k in (callFile.fields || {})), 'carrying the rectangle as parts', callFile.fields);
    check(['x', 'y', 'w', 'h'].every((k) => Number.isInteger(Number(callFile.fields[k]))), 'as integers', callFile.fields);
    check(Math.abs(Number(callFile.fields.w) - framedFile.stageRect.w) <= 1, 'matching the window', { sent: callFile.fields, shown: framedFile.stageRect });

    console.log('\n[7] Cancel and a backdrop click close without saving');
    await evaluate('window.__calls = []');
    await open('avatar', `url: ${JSON.stringify(wideUrl)}`);
    await evaluate(`document.querySelector('#crop-cancel').click()`);
    check(!(await evaluate('window.__view().open')), 'Cancel closed it');
    check((await evaluate('window.__calls')).length === 0, 'and posted nothing');
    await open('avatar', `url: ${JSON.stringify(wideUrl)}`);
    await evaluate(`document.querySelector('#crop-backdrop').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    check(!(await evaluate('window.__view().open')), 'a click on the backdrop closed it too');
    // One stage at a time: a second open replaces the first.
    await evaluate(`openCropStage({ kind: 'avatar', url: ${JSON.stringify(wideUrl)} }); openCropStage({ kind: 'banner', url: ${JSON.stringify(wideUrl)} })`);
    await waitFor(`!document.querySelector('#crop-save').disabled`);
    check((await evaluate('window.__view().title')) === 'Crop banner', 'opening a second stage replaces the first');

    console.log('\n[8] a GIF is a live background layer, so it keeps moving while you frame it');
    if (!gifUrl) {
      console.log('  NOTE no ffmpeg on PATH — skipping the animation check');
    } else {
      await open('avatar', `url: ${JSON.stringify(gifUrl)}`);
      const bg = await evaluate('window.__view().bg');
      check(/data:image\/gif/.test(bg), 'the stage paints the GIF itself (not a canvas)', bg);
      // Two screenshots a few frames apart: an animated background changes, a
      // frozen one (or a canvas that drew frame one) cannot.
      const g1 = await shot();
      await sleep(500);
      const g2 = await shot();
      check(g1 !== g2, 'the picture on the stage really is still animating');
      await open('avatar', `url: ${JSON.stringify(wideUrl)}`);
      const s1 = await shot();
      await sleep(500);
      const s2 = await shot();
      check(s1 === s2, 'while a still picture holds perfectly still (the control)');
      await evaluate('closeCropStage()');
    }

    check(pageErrors.length === 0, 'no page errors along the way', pageErrors.slice(0, 3));
  } finally {
    try { if (ws) ws.close(); } catch {}
    try { if (chrome) chrome.kill(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

main().catch((e) => { console.log('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
