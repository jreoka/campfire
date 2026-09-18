// The voice stage's layout: does a call FIT, or does it scroll?
//
// Measured in a real browser against the REAL stylesheet and the REAL voice.js
// (script-tagged into the probe page with the app's own `$()` and state stubbed),
// so what is asserted is the shipped code, not a copy of it.
//
// The bug this pins: `#stage` used to be `max-height:46dvh; overflow-y:auto`, and
// the tile grid is the only thing inside it. A grid that is itself a scroll
// container is not sized by its content, so `.vtile`'s aspect-ratio was dropped
// and ONE tile came out as tall as it was wide (646px at 1149px wide) inside a
// 251px box — the split view (chat + call, which never opened the full call view)
// therefore showed a scrollbar with a single person in the call, which is exactly
// the report. What must hold now:
//   - one tile: the stage is exactly as tall as that tile, and NOTHING scrolls;
//   - a full room: the tiles stop fitting, and the grid — never the stage — is
//     what scrolls;
//   - the full call view: unchanged (fills the pane, still no scrollbar when the
//     tiles fit).
//
//   node scripts/test-voice-stage-fit.js
//   node scripts/test-voice-stage-fit.js --shot out.png
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SHOT = (() => {
  const i = process.argv.indexOf('--shot');
  return i >= 0 ? process.argv[i + 1] : null;
})();

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

const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

// ---------- offline checks ----------
console.log('\n[1] the cap lives on the grid, not on the stage');
check(/#stage-grid\{[^}]*max-height:calc\(46dvh - \(var\(--stage-pad\) \* 2\)\)/.test(css),
  '#stage-grid carries the 46dvh cap (a grid whose height IS content-driven)');
check(/#stage\{--stage-pad:\.65rem[^}]*\}/.test(css),
  '--stage-pad is declared once, on the stage, for the stylesheet and for fitStage');
check(/#stage\{[^}]*padding:var\(--stage-pad\)/.test(css),
  'and the stage pads itself with it');
check(/#stage\{[^}]*overflow-y:auto/.test(css) === false,
  '#stage is never itself a scroll container (the bug: a grid scroll box is not sized by its contents)');
check(/#stage\{[^}]*max-height/.test(css) === false,
  'and nothing caps the stage box itself');
check(/#stage-grid\{[^}]*align-items:start/.test(css),
  'tiles align to the start of their row instead of stretching to fill it (16:9 survives)');
check(/#stage-grid\{[^}]*align-content:start/.test(css),
  'and rows pack from the top rather than being spread over the box');
check(/#chat\.call-open #stage-grid\{[^}]*max-height:none/.test(css),
  'the full call view leaves the cap to the flex column (max-height:none)');
check(/#stage-grid\.has-room\{overflow-y:auto\}/.test(css),
  'the grid scrolls only when it is given .has-room');

// ---------- the browser half ----------
const CDP_PORT = 9600 + Math.floor(Math.random() * 300);
let chrome = null, ws = null, msgId = 0;
const pending = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function frameHtml() {
  const voiceSrc = 'file:///' + path.join(ROOT, 'public/js/voice.js').replace(/\\/g, '/');
  const cssHref = 'file:///' + path.join(ROOT, 'public/styles.css').replace(/\\/g, '/');
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="${cssHref}">
<style>
  html,body{height:100%;margin:0}
  #app{height:100%;display:flex}
  #view-main{display:flex;height:100%;flex:1;min-height:0;overflow:hidden}
  #chat{flex:1;min-height:0}
  #chat-header{padding:.6rem .9rem;border-bottom:1px solid var(--line-soft)}
  #messages{flex:1;min-height:0;overflow-y:auto;padding:1rem}
  #composer{min-height:64px}
  /* Stand-ins for what the app paints around the call: the sidebar's call bar and
     the floating bar. Only their presence matters here. */
  #voice-bar,#voice-fab,#incoming-call{display:none}
</style></head><body>
<div id="app"><section id="view-main"><div id="left" style="width:280px"></div><main id="chat">
  <header id="chat-header"><strong># general</strong></header>
  <div id="stage" class="hidden">
    <div id="stage-head" class="hidden"><span class="live-badge">LIVE</span><strong id="stage-name">voice</strong><span id="stage-sub" class="muted"></span><span class="spacer"></span><button id="sc-min" class="icon-btn" style="display:inline-block">v</button></div>
    <div id="stage-grid"></div>
    <div id="stage-controls" class="hidden">
      <button id="cv-mute" class="vb-btn big" title="Mute"></button>
      <button id="cv-deafen" class="vb-btn big" title="Deafen"></button>
      <button id="cv-camera" class="vb-btn big" title="Camera"></button>
      <button id="cv-share" class="vb-btn big" title="Go Live"></button>
      <button id="cv-leave" class="vb-btn big danger" title="Disconnect"></button>
    </div>
  </div>
  <div id="messages"><div class="msg"><span class="text">No messages yet — say hello</span></div></div>
  <div id="composer"><textarea id="msg-input"></textarea></div>
  <div id="typing-bar"></div>
  <button id="jump-present" class="hidden"></button>
  <div id="voice-fab" class="hidden"><b id="vf-name">voice</b><button id="vf-mute"></button><button id="vf-deafen"></button><button id="vf-camera"></button><button id="vf-share"></button><button id="vf-leave"></button></div>
</main></section></div>
<div id="voice-bar" class="hidden"><span id="voice-status"><span class="live-dot"></span><b id="voice-chan-name">voice</b></span><span id="voice-conn"></span><button id="btn-mute"></button><button id="btn-deafen"></button><button id="btn-camera"></button><button id="btn-share"></button><button id="btn-voice-leave"></button><button id="me-mute"></button><button id="me-deafen"></button></div>
<div id="attach-preview" class="hidden"></div><div id="mention-pop" class="hidden"></div><div id="chan-pop" class="hidden"></div>
<div id="friends-page" class="hidden"></div><div id="stories-page" class="hidden"></div>
<div id="incoming-call" class="hidden"><b id="ic-title"></b><span id="ic-sub"></span><button id="ic-accept"></button><button id="ic-decline"></button></div>
<button id="btn-call-voice"></button><button id="btn-call-video"></button>
<script>
// ---------- the app's own plumbing, stubbed ----------
const S = {
  me: { id: 'me-id', display_name: 'Cross', username: 'cross', avatar_color: '#5b6cff', avatar_url: null, active_tag: null },
  voice: null, callOpen: false, voiceOccupancy: new Map(), voiceSince: new Map(),
  view: 'server', dmThreadId: null, dms: [], servers: [], serverDetail: null, updateReady: false,
  streaming: new Map(), voiceVolumes: new Map(),
};
function $(sel) { return typeof sel === 'string' ? document.querySelector(sel) : sel; }
function $$(sel) { return [...document.querySelectorAll(sel)]; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function tagHTML() { return ''; }
function paintAvatar(el) { el.textContent = 'C'; }
function liveVideoTracks(ms) { return (ms && ms.getVideoTracks ? ms.getVideoTracks() : []) || []; }
function mediaPrefs() { return { ec: true, agc: true, micId: null, quality: '720p', fps: 30 }; }
function fmtVoiceTime(ms) { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function toast() {}
function renderChannels() {} function renderDmLists() {} function renderDmMembers() {} function renderDmBlank() {}
function renderComposerMeta() {} function paintDmCallButtons() {} function paintUpdateBanner() {}
function paintVoiceControls() {} function paintMe() {} function stopSpeakingMonitor() {} function startSpeakingMonitor() {}
function updateCallHeadStub() {}
window.__errs = [];
window.addEventListener('error', (e) => window.__errs.push(String((e && e.message) || e)));
</script>
<script src="${voiceSrc}"></script>
<script>
// ---------- the harness ----------
// A real (tiny) video MediaStream: paintTile hands it to <video>.srcObject, which
// refuses anything that is not a MediaStream, so a stub object will not do.
function fakeCam() {
  if (window.__camStream) return window.__camStream;
  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  const g = c.getContext('2d');
  g.fillStyle = '#334'; g.fillRect(0, 0, 16, 16);
  window.__camStream = c.captureStream(1);
  return window.__camStream;
}
function newCall(kind, opts) {
  opts = opts || {};
  const voice = {
    kind: kind || 'dm', threadId: 't1', serverId: 's1', channelId: 'c1',
    stream: null, micStream: null, noise: null,
    camStream: opts.camera ? fakeCam() : null, screenStream: null,
    pcs: new Map(), senders: new Map(), muted: false, deafened: false, serverMuted: false,
    cameraOn: !!opts.camera, sharing: !!opts.sharing, streamName: null,
    quality: '720p', fps: 30, speaking: false,
    audioEls: new Map(), screenAudioEls: new Map(), remoteAudio: new Map(), remoteScreenAudio: new Map(),
    remoteVideo: new Map(), trackMeta: new Map(), tiles: new Map(),
  };
  S.voice = voice;
  S.callOpen = false;
  document.getElementById('chat').classList.remove('call-open');
  const key = kind === 'dm' ? 'dm:t1' : 's1:c1';
  const occ = [{ id: 'me-id', display_name: 'Cross', username: 'cross', muted: false, deafened: false, camera: !!opts.camera, sharing: false, speaking: false }];
  for (let i = 0; i < (opts.peers || 0); i++) {
    const pid = 'peer' + i;
    occ.push({ id: pid, display_name: 'Peer ' + i, username: 'peer' + i, muted: false, deafened: false, camera: true, sharing: false, speaking: false });
    const rv = { camera: fakeCam(), screen: null };
    voice.remoteVideo.set(pid, rv);
  }
  S.voiceOccupancy.set(key, occ);
  S.voiceSince.set(key, Date.now());
  return voice;
}
// Render the stage exactly as the app does — renderStage() then, for the call
// view, openCallView() (which is what re-measures with the head/controls shown).
function paint(opts) {
  opts = opts || {};
  const grid = document.getElementById('stage-grid');
  grid.innerHTML = '';
  if (S.voice && S.voice.tiles) S.voice.tiles.clear();
  if (opts.callOpen) openCallView();
  else renderStage();
}
function clearCall() {
  const grid = document.getElementById('stage-grid');
  S.voice = null; S.callOpen = false;
  document.getElementById('chat').classList.remove('call-open');
  grid.innerHTML = ''; grid.removeAttribute('style'); grid.classList.remove('has-room');
  document.getElementById('stage').classList.add('hidden');
}
const box = (el) => { const b = el.getBoundingClientRect(); return { w:+b.width.toFixed(2), h:+b.height.toFixed(2), t:+b.top.toFixed(2), b:+b.bottom.toFixed(2) }; };
window.__report = function () {
  if (window.__errs.length) return { errs: window.__errs.slice() };
  const chat = document.getElementById('chat'), stage = document.getElementById('stage'),
    grid = document.getElementById('stage-grid'), msgs = document.getElementById('messages');
  const tiles = [...grid.children];
  return {
    vw: innerWidth, vh: innerHeight,
    callOpen: !!S.callOpen,
    tiles: tiles.length,
    stage: box(stage), grid: box(grid), msgs: box(msgs),
    gridRectH: +grid.getBoundingClientRect().height.toFixed(2),
    tile0: tiles[0] ? box(tiles[0]) : null,
    tileBoxes: tiles.map(box),
    stageScroll: stage.scrollHeight - stage.clientHeight,
    gridScroll: grid.scrollHeight - grid.clientHeight,
    hasRoom: grid.classList.contains('has-room'),
    gridInlineH: grid.style.maxHeight || '',
    cols: getComputedStyle(grid).gridTemplateColumns,
    gridDisplay: getComputedStyle(grid).display,
    tileAspect: tiles[0] ? getComputedStyle(tiles[0]).aspectRatio : '',
    tileVisible: tiles[0] ? box(tiles[0]).h > 40 : false,
    stageVisible: !stage.classList.contains('hidden'),
    chatOverflow: chat.scrollHeight - chat.clientHeight,
  };
};
window.__case = function (spec) {
  clearCall();
  if (spec.call) {
    newCall(spec.kind || 'dm', { peers: spec.peers || 0, camera: spec.camera !== false, sharing: !!spec.sharing });
    paint({ callOpen: !!spec.callOpen });
  }
  return JSON.parse(JSON.stringify(window.__report()));
};
</script></body></html>`;
}

function send(method, params = {}) {
  return new Promise((res, rej) => {
    const i = ++msgId;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function startChrome() {
  const crypto = require('node:crypto');
  const WebSocket = require('ws');
  chrome = spawn(findChrome(), [
    '--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(os.tmpdir(), 'cf-stage-' + crypto.randomBytes(4).toString('hex')),
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
    '--allow-file-access-from-files', '--window-size=1400,1000', 'about:blank',
  ], { stdio: 'ignore' });
  let ver = null;
  for (let i = 0; i < 80 && !ver; i++) {
    try { ver = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); } catch {}
    if (!ver) await sleep(250);
  }
  if (!ver) throw new Error('Chrome did not expose the DevTools port');
  const target = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
    }
  });
  await send('Page.enable');
  await send('Runtime.enable');
}

async function loadFrame(w, h, dpr) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-stage-'));
  const file = path.join(dir, 'frame.html');
  fs.writeFileSync(file, frameHtml());
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr || 1, mobile: false });
  await send('Page.navigate', { url: 'file:///' + file.replace(/\\/g, '/') });
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    try { if (await evaluate('!!window.__case && document.readyState === "complete"')) break; } catch {}
  }
  const loaded = await evaluate('typeof fitStage');
  if (loaded !== 'function') throw new Error('public/js/voice.js did not load in the probe page (got ' + loaded + ')');
  const pageErrs = await evaluate('JSON.stringify(window.__errs)');
  if (pageErrs !== '[]') throw new Error('the probe page threw on load: ' + pageErrs);
  return file;
}

function stopChrome() {
  try { ws && ws.close(); } catch {}
  try { chrome && chrome.kill(); } catch {}
}

async function main() {
  if (!findChrome()) return skip('no Chrome/Edge found (set CHROME_PATH)');
  await startChrome();

  const caseAt = async (spec) => {
    const r = await evaluate('window.__case(' + JSON.stringify(spec) + ')');
    return r;
  };

  // ---- the reported case: one person, split view (chat + call, call view closed)
  console.log('\n[2] one person in the call, split view (1170x546): it fits');
  await loadFrame(1170, 546, 1);
  const solo = await caseAt({ call: true, peers: 0, callOpen: false, camera: true });
  if (solo.errs) throw new Error('page threw: ' + solo.errs[0]);
  check(solo.tiles === 1, 'one tile is rendered for the one person', { tiles: solo.tiles });
  check(solo.stageVisible, 'the stage is up');
  check(solo.stageScroll <= 1.5, 'the STAGE does not scroll (the report)', { over: solo.stageScroll });
  check(solo.gridScroll <= 1.5, 'and neither does the grid', { over: solo.gridScroll });
  check(!solo.hasRoom, 'the grid is not marked scrollable', { hasRoom: solo.hasRoom });
  check(solo.chatOverflow === 0, 'and the chat column is not pushed into overflow either', { over: solo.chatOverflow });
  check(solo.tile0.h > 40, 'the tile really drew', { h: solo.tile0.h });
  const wantTileH = solo.tile0.w * 9 / 16;
  check(Math.abs(solo.tile0.h - wantTileH) < 1.5, 'the tile keeps 16:9 (it was stretched to fill the old scroll box)',
    { w: solo.tile0.w, h: solo.tile0.h, want: +wantTileH.toFixed(1) });
  const stageChrome = 0.65 * 16 * 2 + 1; // the stage's own padding, twice, plus its hairline
  check(Math.abs(solo.stage.h - (solo.tile0.h + stageChrome)) < 3,
    'the stage is exactly its tile plus its own padding — it sizes to the call', { stage: solo.stage.h, tile: solo.tile0.h });
  check(solo.msgs.h > 0, 'and the chat below still has its room', { msgs: solo.msgs.h });
  const cap = 546 * 0.46;
  check(solo.tile0.h <= cap + 1, 'the tile respects the 46dvh cap rather than the pane width', { h: solo.tile0.h, cap: +(cap - stageChrome).toFixed(1) });

  if (SHOT) {
    const png = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT, Buffer.from(png.data, 'base64'));
    console.log('  .... screenshot written to ' + SHOT);
  }

  // ---- the same call on a tall window must not grow a bar either
  console.log('\n[3] one person, tall window (1440x1000): still a fit');
  await loadFrame(1440, 1000, 1);
  const tall = await caseAt({ call: true, peers: 0, callOpen: false, camera: true });
  check(tall.stageScroll <= 1.5 && tall.gridScroll <= 1.5 && !tall.hasRoom, 'nothing scrolls at 1440x1000',
    { stage: tall.stageScroll, grid: tall.gridScroll, hasRoom: tall.hasRoom });
  check(Math.abs(tall.tile0.h - tall.tile0.w * 9 / 16) < 1.5, 'the tile is 16:9 there too', { w: tall.tile0.w, h: tall.tile0.h });

  // ---- a few people: still fits, more columns
  console.log('\n[4] three people, split view (1170x730): still fits');
  await loadFrame(1170, 730, 1);
  const trio = await caseAt({ call: true, peers: 2, callOpen: false, camera: true });
  check(trio.tiles === 3, 'three tiles', { tiles: trio.tiles });
  check(trio.gridScroll === 0 && !trio.hasRoom, 'three tiles fit without a bar', { over: trio.gridScroll });
  check(trio.tileBoxes.every((b, i) => Math.abs(b.h - b.w * 9 / 16) < 1.5, true) &&
    trio.tileBoxes.every((b) => Math.abs(b.h - b.w * 9 / 16) < 1.5),
    'every tile keeps 16:9', trio.tileBoxes.map((b) => ({ w: b.w, h: b.h })));

  // ---- a full room: the GRID scrolls, and the stage still does not
  console.log('\n[5] a full room (40 people, 900x420): the grid scrolls, the stage does not');
  await loadFrame(900, 420, 1);
  const room = await caseAt({ call: true, peers: 39, callOpen: false, camera: true });
  check(room.tiles === 40, 'forty tiles', { tiles: room.tiles });
  check(room.hasRoom && room.gridScroll > 0, 'the grid scrolls', { over: room.gridScroll, cols: room.cols });
  check(room.stageScroll === 0, 'and the stage still does not (the bar belongs to the grid)',
    { over: room.stageScroll });
  const roomCols = room.cols.split(' ').length;
  check(room.tileBoxes.every((b) => b.w >= 140 - 1), 'the tiles hold the 140px floor instead of shrinking away',
    { min: Math.min(...room.tileBoxes.map((b) => b.w)).toFixed(1), cols: roomCols });
  check(roomCols > 1, 'and it is a grid, not one long column', { cols: roomCols });
  check(room.gridRectH <= 420 * 0.46 + 1, 'the grid is held to the 46dvh cap', { grid: room.gridRectH });

  // ---- the full call view is unchanged
  console.log('\n[6] the full call view (1170x730): fills the pane, still no bar for one tile');
  await loadFrame(1170, 730, 1);
  const full = await caseAt({ call: true, peers: 0, callOpen: true, camera: true });
  check(full.callOpen, 'the call view is open');
  check(full.stageScroll === 0 && full.gridScroll === 0, 'one tile fits the call view with no bar',
    { stage: full.stageScroll, grid: full.gridScroll });
  check(full.stage.h > 730 * 0.6, 'and the stage takes the pane, as the full view should', { stage: full.stage.h });
  check(Math.abs(full.tile0.h - full.tile0.w * 9 / 16) < 1.5, 'the tile is 16:9 in the call view', { w: full.tile0.w, h: full.tile0.h });

  // ---- a full call view room: the grid scrolls, the stage does not
  console.log('\n[7] a full call view room (40 people, short window 1170x400): the grid scrolls, the stage does not');
  await loadFrame(1170, 400, 1);
  const fullRoom = await caseAt({ call: true, peers: 39, callOpen: true, camera: true });
  check(fullRoom.tiles === 40, 'forty tiles', { tiles: fullRoom.tiles });
  check(fullRoom.gridScroll > 0 && fullRoom.stageScroll === 0, 'same rule in the call view',
    { grid: fullRoom.gridScroll, stage: fullRoom.stageScroll });

  // ---- audio-only call (no camera): the stage opens with the avatar tile
  console.log('\n[8] a voice call with the camera off: one avatar tile, still no bar');
  await loadFrame(1170, 546, 1);
  const audioOnly = await caseAt({ call: true, peers: 0, callOpen: true, camera: false });
  check(audioOnly.tiles === 1 && audioOnly.stageVisible, 'the self tile is there with no camera',
    { tiles: audioOnly.tiles, visible: audioOnly.stageVisible });
  check(audioOnly.stageScroll === 0 && !audioOnly.hasRoom, 'and nothing scrolls', { over: audioOnly.stageScroll });

  // ---- resizing must not leave a stale bar behind
  console.log('\n[9] resizing a single-tile call back and forth leaves no stale scrollbar');
  // The cap fitStage() measures against, from the frame's own numbers: `46dvh`
  // less the stage's padding, less the one pixel of slack against the browser's
  // fractional tile height.
  const capOf = (r) => r.vh * 0.46 - 2 * 0.65 * 16 - 1;
  await loadFrame(1440, 900, 1);
  const big = await caseAt({ call: true, peers: 0, callOpen: false, camera: true });
  check(big.stageScroll === 0 && !big.hasRoom, 'nothing scrolls at 1440x900', { over: big.stageScroll });
  check(big.gridRectH <= capOf(big) + 1 && big.gridRectH >= capOf(big) - 1 && big.gridInlineH !== '',
    'and the grid is capped at that room', { rect: big.gridRectH, inline: big.gridInlineH, want: +capOf(big).toFixed(1) });
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 420, deviceScaleFactor: 1, mobile: false });
  await sleep(200);
  await evaluate('fitStage()');
  const shrunk = JSON.parse(JSON.stringify(await evaluate('window.__report()')));
  check(shrunk.stageScroll === 0 && shrunk.gridScroll <= 1.5 && !shrunk.hasRoom,
    'still a fit after shrinking (fitStage re-runs on resize)', { over: shrunk.stageScroll, hasRoom: shrunk.hasRoom, grid: shrunk.gridScroll });
  check(Math.abs(shrunk.tile0.h - shrunk.tile0.w * 9 / 16) < 1.5, 'and still 16:9', { w: shrunk.tile0.w, h: shrunk.tile0.h });
  check(shrunk.gridRectH <= capOf(shrunk) + 1 && shrunk.gridRectH >= capOf(shrunk) - 1,
    'and the cap followed the window down', { rect: shrunk.gridRectH, want: +capOf(shrunk).toFixed(1), vh: shrunk.vh });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(200);
  await evaluate('fitStage()');
  const back = JSON.parse(JSON.stringify(await evaluate('window.__report()')));
  check(back.stageScroll === 0 && !back.hasRoom && Math.abs(back.gridRectH - capOf(back)) <= 1,
    'and after growing back, with the cap following the window again',
    { rect: back.gridRectH, over: back.stageScroll, want: +capOf(back).toFixed(1), vh: back.vh });

  // ---- the shell's VISIBLE height (`--vvh`, what the phone keyboard publishes)
  console.log('\n[10] a phone with the keyboard up: the cap follows --vvh, and still fits');
  await loadFrame(390, 780, 3);
  const withKeys = JSON.parse(JSON.stringify(await evaluate(`(() => {
    document.documentElement.style.setProperty('--vvh', '320px');
    const r = window.__case({ call: true, peers: 0, callOpen: false, camera: true });
    document.documentElement.style.removeProperty('--vvh');
    return r;
  })()`)));
  check(withKeys.stageScroll <= 1.5 && !withKeys.hasRoom,
    'nothing scrolls with the shell compressed', { over: withKeys.stageScroll, hasRoom: withKeys.hasRoom });
  check(Math.abs(withKeys.tile0.h - withKeys.tile0.w * 9 / 16) < 1.5, 'the tile is 16:9 there too',
    { w: withKeys.tile0.w, h: withKeys.tile0.h });
  check(withKeys.stage.h <= 320 * 0.46 + 1, 'and the stage is capped by --vvh, not by the window',
    { stage: withKeys.stage.h, cap: +(320 * 0.46).toFixed(1) });
}

const done = Promise.resolve().then(main).finally(stopChrome);
done.then(() => {
  console.log('\n' + (failures.length ? failures.length + ' FAILED, ' + passed + ' passed' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
  process.exit(0);
}).catch((e) => {
  stopChrome();
  console.error('\n[test] ERROR: ' + ((e && e.message) || e));
  process.exit(1);
});
