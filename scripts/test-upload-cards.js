// Composer upload cards: they belong to the conversation they were started in,
// and "every byte sent" must not read as a stuck upload.
//
// Two reported bugs:
//   1. "while the image is uploading if i switch servers the upload progress
//      moves servers with me" — the cards (and the finished attachment) lived in
//      one global list, so a half-uploaded file followed the reader into the next
//      server and became a chip in the WRONG conversation, one Enter away from
//      being posted there.
//   2. "an upload stuck at 99%" — the bar was capped at 99% until the server
//      answered, and the browser reports the whole body as sent long before the
//      response (last ACKs, the bucket write, the scan/compress slot). A frozen
//      99% reads as a hang; the card now goes indeterminate and says "Finishing…",
//      with a stall ceiling that turns a response that never comes into a normal
//      Retry-able failure.
//   3. "why does part of it only show in the thumbnail next to that file symbol"
//      — a video card is born with a placeholder glyph (its poster frame is
//      captured asynchronously off a temp <video>), and the frame was inserted
//      BESIDE that glyph: two flex children in a 36px tile meant the picture was
//      shrunk into a cover-cropped sliver next to a file icon. The frame now
//      replaces the glyph, and the CSS takes it out of flow so no sibling can
//      squeeze it. See [2c] + [9].
//
// Runs the REAL upload block sliced out of public/js/messages.js in headless
// Chrome against a fake XMLHttpRequest, and checks the wiring statically. Skips
// (exit 0) without Chrome.
//
// Usage: node scripts/test-upload-cards.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
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

const messages = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
const styles = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const servers = fs.readFileSync(path.join(ROOT, 'public/js/servers.js'), 'utf8');
const pins = fs.readFileSync(path.join(ROOT, 'public/js/pins.js'), 'utf8');
const auth = fs.readFileSync(path.join(ROOT, 'public/js/auth.js'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// The real block: the per-conversation attachment store through removeUpload.
const UP_START = messages.indexOf('// ---------- attachments belong to a conversation ----------');
const UP_END = messages.indexOf("$('#btn-attach').onclick", UP_START);
const META_START = messages.indexOf('const CHIP_IMG_ICON');
if (UP_START < 0 || UP_END < 0 || META_START < 0) {
  console.error('[test] could not locate the upload block in public/js/messages.js');
  process.exit(1);
}
// Through removeUpload (the progress cards) …
const upSource = messages.slice(UP_START, UP_END);
// … and, ahead of it, attChipHTML + renderComposerMeta so the chip and the card
// can be observed in ONE page (that pairing is the reported bug).
const metaSource = messages.slice(META_START, UP_START);
if (!/function syncPendingAttsCtx/.test(upSource) || !/function startUpload/.test(upSource) || !/function removeUpload/.test(upSource)) {
  console.error('[test] the extracted block is incomplete');
  process.exit(1);
}
const uploadListMarkup = (() => {
  const a = index.indexOf('<div id="upload-list"');
  if (a < 0) return '<div id="upload-list"></div>';
  const b = index.indexOf('</div>', index.indexOf('>', a));
  return index.slice(a, b + 6);
})();
const attachPreviewMarkup = (() => {
  const a = index.indexOf('<div id="attach-preview"');
  if (a < 0) return '<div id="attach-preview"></div>';
  const b = index.indexOf('</div>', index.indexOf('>', a));
  return index.slice(a, b + 6);
})();

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/styles.css">
<style>body{margin:0;font:14px system-ui}</style></head><body>
<div id="composer">${attachPreviewMarkup}${uploadListMarkup}</div>
<script>
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
window.__toasts = [];
function toast(t) { window.__toasts.push(String(t)); }
function fmtSize(n) { return Math.max(0, Math.round((Number(n) || 0) / 1024)) + ' KB'; }
function prettyError(e) { const m = { network_error: 'Network error', upload_timeout: 'The server stopped responding — try again.' }; return m[e] || String(e).replace(/_/g, ' '); }
const attPreviews = new Map();
function setAttPreview(url, src) { attPreviews.set(url, { src: src }); return true; }
function whenVideoPoster(url, cb) { if (cb) window.__posters.push(cb); }
// A video's frame capture is ASYNC in the real app (a temp <video> loads, seeks,
// then paints a canvas), so the stubbed one HOLDS its callback: the card is
// already on screen with the glyph it was born with when the frame lands — the
// exact shape of the reported thumbnail bug. window.__firePosters lands it.
window.__posters = [];
window.__firePosters = (shot) => { const list = window.__posters.splice(0); list.forEach((fn) => fn(shot)); };
function $(sel) { return document.querySelector(sel); }
window.__metaRenders = 0;
// The composer "has a conversation" whenever the page says so.
function composerTargetReady() { return !!window.__ready; }
// The per-message attachment cap is the SERVER's number, read back from
// /api/config (maxAttsFor in core.js); the app's version lives there, so the stub
// only has to answer the same question.
function maxAttsFor() { return window.__maxAtts || 10; }
// renderComposerMeta's own helpers (the app's versions live in servers.js /
// core.js); nothing here changes what the meta block itself does.
function msgAuthor() { return { display_name: 'someone' }; }
function replyPreviewOf() { return 'x'; }
function syncComposerRender() {}
function paintComposerSend() {}
function pruneAttPreviews() {}
function releaseAttPreview() {}
function attPreviewSrc(a) { const hit = attPreviews.get(a.url); return hit ? hit.src : (a.kind === 'image' && a.scan !== 'pending' && a.scan !== 'infected' ? a.url : ''); }
const store = { token: 'test' };
const S = { view: 'server', serverId: 's1', channelId: 'c1', dmThreadId: null, dms: [], uploads: [], pendingAtts: [], maxUploadMb: 50 };
// The same key shape core.js uses ('s:<serverId>:<channelId>' / 'd:<threadId>').
function draftCtx() {
  if (S.view === 'home') return S.dmThreadId ? 'd:' + S.dmThreadId : null;
  return S.serverId && S.channelId ? 's:' + S.serverId + ':' + S.channelId : null;
}
// Fake XHR: the test drives progress/load by hand, per upload entry.
class FakeXHR {
  constructor() { this.upload = {}; this.status = 0; this.responseText = ''; }
  open() {}
  setRequestHeader() {}
  send() { this.sent = true; }
  abort() { this.aborted = true; if (this.onabort) this.onabort(); }
}
window.XMLHttpRequest = FakeXHR;
${metaSource}
${upSource}
window.__S = S;
window.__entry = (ctx) => S.uploads.find((u) => u.ctx === ctx) || null;
// By name, so a case can drive ONE of several uploads sharing a conversation.
window.__entryNamed = (name) => S.uploads.find((u) => u.name === name) || null;
window.__finishNamed = (name, body, status) => {
  const x = window.__entryNamed(name).xhr;
  x.status = status || 200; x.responseText = JSON.stringify(body); x.onload();
};
window.__ctx = () => pendingCtxKey;
window.__parked = () => { const o = {}; for (const [k, v] of pendingByCtx) o[k] = v.map((a) => a.url); return o; };
window.__card = () => {
  const el = document.querySelector('#upload-list .up-card');
  if (!el) return null;
  return {
    name: el.querySelector('.up-name').textContent,
    pct: el.querySelector('.up-pct').textContent,
    sub: el.querySelector('.up-sub').textContent,
    indet: el.querySelector('.up-fill').classList.contains('indet'),
    done: el.classList.contains('done'),
    failed: el.classList.contains('failed'),
  };
};
window.__cardDone = () => {
  const el = document.querySelector('#upload-list .up-card');
  return !!(el && el.classList.contains('done'));
};
// The chip and its Spoiler toggle: the "second stage" the reports are about.
// The chips and their Spoiler toggles: the "second stage" the reports are about.
window.__chips = () => [...document.querySelectorAll('#attach-preview .att-chip')].map((el) => ({
  name: (el.querySelector('.chip-name') || {}).textContent || '',
  spoiler: !!el.querySelector('button[title="Mark as spoiler"]'),
  buttons: [...el.querySelectorAll('button')].map((b) => b.textContent.trim()),
}));
window.__chip = () => window.__chips()[0] || null;
window.__cards = () => document.querySelectorAll('#upload-list .up-card').length;
// The card's icon tile: what is IN it and how much of the 36px tile the picture
// actually takes. Both halves mattered in the report — a leftover glyph sat
// beside the frame and the flex row shrank the frame to make room for it.
window.__cardIcon = (name) => {
  const cards = [...document.querySelectorAll('#upload-list .up-card')];
  const card = name ? cards.find((c) => (c.querySelector('.up-name') || {}).textContent === name) : cards[0];
  if (!card) return null;
  const ic = card.querySelector('.up-ic');
  if (!ic) return null;
  const img = ic.querySelector('img');
  const r = img ? img.getBoundingClientRect() : null;
  const b = ic.getBoundingClientRect();
  return {
    imgs: ic.querySelectorAll('img').length,
    svgs: ic.querySelectorAll('svg').length,
    imgW: r ? Math.round(r.width) : 0,
    imgH: r ? Math.round(r.height) : 0,
    boxW: Math.round(b.width),
    boxH: Math.round(b.height),
  };
};
window.__hidden = () => document.querySelector('#upload-list').classList.contains('hidden');
window.__upload = (name, size, mime) => {
  const f = new File([new Uint8Array(8)], name, { type: mime || 'application/octet-stream' });
  Object.defineProperty(f, 'size', { value: size || 2048 });
  uploadAndAttach(f);
  return S.uploads.length;
};
window.__progress = (ctx, loaded, total) => { window.__entry(ctx).xhr.upload.onprogress({ lengthComputable: true, loaded, total }); };
window.__attachStart = (name, size, mime) => {
  window.__ready = true;
  const n = window.__upload(name, size, mime);
  if (S.uploads.length !== n) throw new Error('upload rejected: ' + (window.__toasts.slice(-1)[0] || '?'));
  // The real app repaints the composer meta from the XHR's progress events; a
  // fake XHR sends none, so ask for the repaint the card's first frame triggers.
  renderComposerMeta();
  return n;
};
window.__finish = (ctx, body, status) => { const x = window.__entry(ctx).xhr; x.status = status || 200; x.responseText = JSON.stringify(body); x.onload(); };
window.__fail = (ctx, why) => { failUpload(window.__entry(ctx), why); };
window.__switchTo = (serverId, channelId) => { S.view = 'server'; S.serverId = serverId; S.channelId = channelId; syncPendingAttsCtx(); };
window.__switchHome = () => { S.view = 'home'; S.dmThreadId = null; S.serverId = null; S.channelId = null; syncPendingAttsCtx(); };
window.__watchArmed = (ctx) => !!(window.__entry(ctx) && window.__entry(ctx).watch);
window.__stall = () => UPLOAD_ANSWER_MS;
window.__atts = () => (S.pendingAtts || []).map((a) => a.url);
</script>
</body></html>`;
}

async function main() {
  console.log('\n[0] the store is the composer\'s single source of truth');
  check(/const pendingByCtx = new Map\(\)/.test(upSource), 'attachments are parked per conversation, like drafts');
  check(/pendingByCtx\.set\(pendingCtxKey, S\.pendingAtts\.slice\(\)\)/.test(upSource),
    'the outgoing list is filed under the conversation it belongs to');
  check(/const saved = ctx \? pendingByCtx\.get\(ctx\) : null;[\s\S]{0,80}pendingByCtx\.delete\(ctx\)/.test(upSource),
    'and the incoming one is adopted (the parked copy goes with it)');
  check(/function renderComposerMeta\(\) \{\s*syncPendingAttsCtx\(\);/.test(messages),
    'every composer repaint re-syncs the context (so a switcher cannot forget)');
  check(/function renderDmBlank\(\) \{[\s\S]{0,260}syncPendingAttsCtx\(\);/.test(pins),
    'leaving a conversation (Home / Close DM / thread gone) parks it too');
  check(/applyComposerDraft\(\);[\s\S]{0,400}syncPendingAttsCtx\(\);[\s\S]{0,140}renderUploads\(\);/.test(servers),
    'selectChannel syncs explicitly (it repaints the draft, not the composer meta)');
  check(/syncPendingAttsCtx\(\); \/\/ the open channel's attachments stay with it/.test(servers),
    'selectServer parks the outgoing channel instead of wiping it');
  check(/S\.replyTo = null; S\.editing = null;\s*syncPendingAttsCtx\(\); \/\/ and this DM's own attachments/.test(pins),
    'selectDmThread does the same for a DM');
  check(!/S\.pendingAtts = \[\]; S\.editing = null;/.test(servers + pins), 'no switcher wipes the list outright any more');

  console.log('\n[1] the card belongs to the conversation that is open');
  check(/u\.ctx == null \? pendingCtxKey == null : u\.ctx === pendingCtxKey/.test(upSource),
    'renderUploads paints only the open conversation\'s uploads');
  check(/const target = ctx \|\| attsCtxNow\(\);/.test(upSource) && /ctx: target,/.test(upSource),
    'each upload records the conversation it started in (the caller names it — the chat bar its own, the thread bar its thread)');
  check(/const home = u\.attHere \? S\.pendingAtts : attsListFor\(u\.ctx\)/.test(upSource),
    'a finished upload is filed where it was started, not where the reader is now');
  check(/activeUploadCount\(ctx\)/.test(upSource) && /activeUploadCount\(target\)/.test(upSource),
    'the per-message cap counts that conversation\'s uploads');
  check(/>= maxAttsFor\(\)\) \{ toast\(maxAttsToast\(\)\)/.test(upSource),
    'and the number it counts against is the server\'s (maxAttsFor, read back from /api/config), never a literal');

  console.log('\n[0b] one number owns the per-message cap, and it is ten');
  check(/const MAX_ATTACHMENTS = Math\.max\(1, parseInt\(process\.env\.MAX_ATTACHMENTS \|\| '10', 10\) \|\| 10\);/.test(serverSrc),
    'the server owns it (MAX_ATTACHMENTS, 10 by default, env-tunable)');
  check((serverSrc.match(/slice\(0, MAX_ATTACHMENTS\)/g) || []).length === 5,
    'and every send path truncates to it (channel message, DM, both attachment-drop routes, the webhook)',
    (serverSrc.match(/slice\(0, MAX_ATTACHMENTS\)/g) || []).length);
  check(/maxAttachments: MAX_ATTACHMENTS/.test(serverSrc) && /maxAttachments: 10/.test(core),
    'the client carries the same number as its default and takes the server\'s at boot');
  check((auth.match(/if \(cfg\??\.maxAttachments\)/g) || []).length === 2,
    'both boot paths take it (the pre-login config fetch and the one after)');
  check(/function maxAttsFor\(\)/.test(core) && /function maxAttsToast\(\)/.test(core) &&
    /'Max ' \+ maxAttsFor\(\) \+ ' attachments per message'/.test(core),
    'and one helper answers "how many" and one writes the toast, so no message can state a different number');
  check(!/attachments\.slice\(0, 5\)|>= 5\) \{ toast\('Max 5/.test(serverSrc + messages),
    'nothing is left hard-coded at the old five');
  check(/if \(!composerTargetReady\(\)\) \{ toast\('Pick a chat first, then attach'\); return; \}/.test(upSource),
    'an attachment with no conversation to belong to is refused up front');
  check(/typeof pendingByCtx !== 'undefined' \? pendingByCtx\.values\(\) : \[\]/.test(messages),
    'a parked attachment keeps its thumbnail alive (pruneAttPreviews knows about the store)');

  console.log('\n[2] "every byte sent" is not "done"');
  check(/const sent = u\.total > 0 && u\.loaded >= u\.total;/.test(upSource), 'the card knows when the body is out');
  check(/if \(u\.indet \|\| sent\) \{ pct\.textContent = ''; fill\.classList\.add\('indet'\); \}/.test(upSource),
    'and goes indeterminate instead of freezing at 99% (leaving the % cell EMPTY — a bare "…" beside the ✕ read as a menu button)');

  console.log('\n[2b] the chip stage for a file starts when ITS card stage is over');
  check(/function uploadHeldOnStage\(att\) \{[\s\S]{0,220}u\.att === att && u\.attHere && uploadCardEl\(u\.id\)/.test(messages),
    'the stage test is THIS attachment\'s own card still standing in #upload-list (DOM, not just "still uploading")');
  check(/const staged = held \? \[\.\.\.list, \.\.\.\(S\.uploads \|\| \[\]\)\.filter\(\(u\) => u\.att && u\.attHere\)\.map\(\(u\) => u\.att\)\] : list;/.test(messages),
    'the composer paints the finished attachments its exiting cards are still holding (the chat bar\'s row does; a thread reply\'s row is handed its files directly)');
  check(/u\.att = data;\s*$[\s\S]{0,80}u\.attHere = here;/m.test(messages),
    'xhr.onload parks the answered attachment on the upload entry instead of filing it');
  check(/if \(u && u\.att\) \{[\s\S]{0,200}home\.push\(u\.att\);/.test(messages),
    'and removeUpload — the moment the card leaves — files it in the conversation it started in');
  check(!/uploadsInFlight/.test(messages),
    'it must NOT key on activeUploadCount: the answered card sits on screen in its green done state for the 650ms exit, so counting in-flight uploads let the next stage appear under it');
  check(/if \(\(a\.kind === 'image' \|\| a\.kind === 'video'\) && !uploadHeldOnStage\(a\)\) \{/.test(messages),
    'a Spoiler toggle is withheld only while ITS OWN card is still on stage');
  check(!/attCardOnStage/.test(messages),
    'never by the list as a whole: that gate made the first finished photo wait for every other green bar (reported)');
  check(!/if \(hadCards && !attCardOnStage\(\)\) renderComposerMeta\(\)/.test(messages)
    && /renderUploads\(\);\s*\/\/ Repaint every time[\s\S]{0,320}renderComposerMeta\(\);/.test(messages),
    'removeUpload repaints the composer every time, not only when its card emptied the list');
  check(/setTimeout\(\(\) => removeUpload\(u\.id\), 650\)/.test(messages),
    'the green done card holds the stage for its ~650ms exit before the chip owns it');
  check(/sent \? ' · Finishing…' : ' · Uploading…'/.test(upSource), 'with a readout that says what it is waiting for');
  check(/const UPLOAD_ANSWER_MS = 90 \* 1000;/.test(upSource) && /const UPLOAD_IDLE_MS = 60 \* 1000;/.test(upSource)
    && /armUploadWatchdog\(u\)/.test(upSource),
    'a response that never comes has a ceiling');
  check(/try \{ xhr\.send\(fd\); \} catch \(err\) \{ failUpload\(u, err && err\.message\); return; \}[\s\S]{0,400}armUploadWatchdog\(u\);/.test(upSource),
    'armed from the send, so a transfer that never reports progress still has one');
  check(/if \(u\.total > 0 && u\.loaded >= u\.total && !u\.sentAt\) u\.sentAt = Date\.now\(\);/.test(upSource),
    'and "every byte handed over" switches to the shorter answer ceiling');
  check(/clearTimeout\(u\.watch\); u\.watch = null;/.test(upSource), 'and cleared on every exit (load/error/abort/fail/remove)');
  check(/upload_timeout: 'The server stopped responding/.test(auth), 'the timeout has a human message');

  console.log('\n[2c] a video card\'s frame REPLACES the glyph it was born with');
  // Reported: "why does part of it only show in the thumbnail next to that file
  // symbol" — a video card is created while the poster frame is still being
  // captured, so it is born with the placeholder glyph; the frame then arrived
  // BESIDE it. Two icons in a 36px flex tile meant the picture was shrunk (and
  // cover-cropped) into whatever was left.
  check(/const ph = ic\.querySelector\('svg'\);\s*if \(ph\) ph\.remove\(\);/.test(upSource),
    'the placeholder glyph is removed when the poster lands, not left beside it');
  check(upSource.indexOf("if (ph) ph.remove();") < upSource.indexOf("ic.insertAdjacentHTML('afterbegin'"),
    'removed BEFORE the frame goes in');
  check(/function paintUploadIcon\(u\) \{[\s\S]{0,400}if \(img\) \{ img\.src = u\.thumb; return; \}/.test(upSource),
    'and an already-painted frame is just re-pointed (one icon per card, always)');
  check(/\.up-ic img\{position:absolute;inset:0;width:100%;height:100%;object-fit:cover\}/.test(styles),
    'the frame is out of flow, so no sibling can squeeze it out of the tile');

  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-upcards-'));
  const srv = http.createServer((req, res) => {
    // The real stylesheet: the tile's geometry is half of the reported bug.
    if (/^\/styles\.css/.test(req.url || '')) {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end(styles);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml());
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
    '--window-size=520,760', 'about:blank'], { stdio: 'ignore' });

  let ws = null;
  try {
    let info = null;
    for (let i = 0; i < 60 && !info; i++) {
      try { info = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); } catch { await sleep(250); }
    }
    if (!info) return skip('Chrome never opened its DevTools port');
    ws = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0; const pending = new Map();
    ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const call = (method, params, sessionId) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
      ws.send(JSON.stringify({ id: i, sessionId, method, params }));
    });
    const targetId = (await call('Target.createTarget', { url: 'about:blank' })).targetId;
    const sessionId = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    const sess = (m, p) => call(m, p, sessionId);
    const ev = async (expression) => {
      const r = await sess('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'page error');
      return r.result.value;
    };
    await sess('Page.enable');
    await sess('Runtime.enable');
    await sess('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
    await sleep(400);
    if (!(await ev('typeof window.__upload === "function"'))) {
      console.error('[test] the extracted upload code did not evaluate in the page');
      process.exit(1);
    }
    await ev('window.__ready = true');

    console.log('\n[3] an upload in this conversation paints here, 0% → 50% → "Finishing…"');
    await ev("window.__upload('photo.jpg', 2048)");
    await sleep(30);
    check(await ev('window.__ctx()') === 's:s1:c1', 'the open conversation owns the composer', await ev('window.__ctx()'));
    let card = await ev('window.__card()');
    check(!!card && card.name === 'photo.jpg', 'the card is in the list', card);
    check(!!card && card.pct === '0%' && !card.indet, 'at 0%, determinate', card);
    check((await ev('window.__hidden()')) === false, 'the list is shown');
    await ev("window.__progress('s:s1:c1', 1024, 2048)");
    card = await ev('window.__card()');
    check(!!card && card.pct === '50%' && !card.indet, 'half way: 50%, still determinate', card);
    check(!!card && /Uploading/.test(card.sub), 'and it says Uploading', card && card.sub);
    await ev("window.__progress('s:s1:c1', 2048, 2048)");
    card = await ev('window.__card()');
    check(!!card && card.pct === '' && card.indet, 'body out: the bar goes indeterminate, with no "…" readout (never a frozen 99%)', card);
    check(!!card && card.sub.indexOf('Finishing') !== -1, 'and the readout says Finishing', card && card.sub);
    check((await ev("window.__watchArmed('s:s1:c1')")) === true, 'with the stall ceiling armed');
    check((await ev('window.__stall()')) === 90000, 'at 90 seconds — the server answers in milliseconds, so that is a lost response');

    console.log('\n[4] switching servers does not carry the upload over');
    await ev("window.__switchTo('s2', 'c9')");
    await sleep(30);
    check((await ev('window.__cards()')) === 0, 'the card is gone from the other server');
    check((await ev('window.__hidden()')) === true, 'and the list hides itself');
    check((await ev('window.__ctx()')) === 's:s2:c9', 'the composer belongs to the new conversation now', await ev('window.__ctx()'));
    check((await ev('JSON.stringify(window.__atts())')) === '[]', 'and it holds none of the other chat\'s attachments');

    console.log('\n[5] the finished attachment lands in the conversation it was started in');
    await ev(`window.__finish('s:s1:c1', { url: '/uploads/files/a.jpg', name: 'photo.jpg', mime: 'image/jpeg', size: 2048, kind: 'image', scan: 'clean' })`);
    await sleep(30);
    check((await ev('JSON.stringify(window.__atts())')) === '[]', 'it does NOT become a chip in the chat the reader moved to');
    let parked = await ev('JSON.stringify(window.__parked())');
    check(!/a\.jpg/.test(parked),
      'and it is not filed yet either — its card is still on stage in that chat, exiting', parked);
    check((await ev('window.__cards()')) === 0, 'and no card appears in the wrong chat');
    await sleep(700); // the done card lingers 650ms, then removes itself and files the attachment
    check((await ev('window.__S.uploads.length')) === 0, 'the finished upload leaves the queue', await ev('window.__S.uploads.length'));
    parked = await ev('JSON.stringify(window.__parked())');
    check(/s:s1:c1/.test(parked) && /a\.jpg/.test(parked),
      'once its card has exited, it is parked under the conversation it was started in', parked);
    await ev("window.__switchTo('s1', 'c1')");
    await sleep(30);
    check((await ev('JSON.stringify(window.__atts())')).indexOf('a.jpg') !== -1, 'coming back, the attachment is waiting', await ev('JSON.stringify(window.__atts())'));
    parked = await ev('JSON.stringify(window.__parked())');
    check(!/s:s1:c1/.test(parked), 'and it is no longer parked', parked);

    console.log('\n[5b] a finished chip owns its stage even while another file uploads');
    await ev('window.__attachStart("pic.jpg", 4096, "image/png")');
    await sleep(30);
    let chips = await ev('window.__chips()');
    check(chips.length === 1 && chips[0].name === 'photo.jpg' && chips[0].spoiler === true,
      'a chip whose card is long gone keeps its Spoiler toggle while a NEW file uploads', chips);
    check((await ev('window.__cardDone()')) === false, 'the new file is still working on its card');
    await ev(`window.__finish('s:s1:c1', { url: '/uploads/files/b.png', name: 'pic.jpg', mime: 'image/png', size: 4096, kind: 'image', scan: 'clean' })`);
    await sleep(40);
    chips = await ev('window.__chips()');
    check(chips.length === 1,
      'the moment it answers, NO second chip appears under its own green card', chips);
    check((await ev('window.__cardDone()')) === true, 'the finished card is on screen in its done state');
    check((await ev('window.__cards()')) === 1, 'and it has not left the list yet');
    await sleep(750); // the done card holds the stage ~650ms, then removes itself
    chips = await ev('window.__chips()');
    check(chips.length === 2 && chips[1].name === 'pic.jpg',
      'once its own card is gone, its chip finally arrives', chips);
    check(chips.every((c) => c.spoiler === true),
      'with the Spoiler toggle on both chips, the previous one included', chips);
    check((await ev('window.__cards()')) === 0, 'and no card left above them');

    console.log('\n[5c] several photos hand over one at a time — the reported case');
    // The report: "when uploading multiple images it waits for every upload to
    // complete before showing the spoiler mark stage". Two photos in flight at
    // once, the FIRST answered while the second is still going.
    await ev('window.__attachStart("one.jpg", 1024, "image/jpeg")');
    await ev('window.__attachStart("two.jpg", 1024, "image/jpeg")');
    await sleep(30);
    check((await ev('window.__cards()')) === 2, 'two photos are on the upload stage at once');
    chips = await ev('window.__chips()');
    check(chips.length === 2 && !chips.some((c) => /one|two/.test(c.name)),
      'and neither has a chip yet — each is holding its own', chips);
    await ev(`window.__finishNamed('one.jpg', { url: '/uploads/files/one.jpg', name: 'one.jpg', mime: 'image/jpeg', size: 1024, kind: 'image', scan: 'clean' })`);
    await sleep(40);
    let names = (await ev('window.__chips()')).map((c) => c.name);
    check(!names.includes('one.jpg'), 'the answered photo still waits for its OWN 650ms green exit', names);
    check((await ev('window.__cards()')) === 2, 'both cards are on stage — one done, one still uploading');
    await sleep(750); // its exit — while two.jpg is STILL uploading
    chips = await ev('window.__chips()');
    names = chips.map((c) => c.name);
    const one = chips.find((c) => c.name === 'one.jpg');
    check(names.includes('one.jpg') && names.includes('photo.jpg') && names.includes('pic.jpg'),
      'the finished photo hands over WITHOUT waiting for the other upload', chips);
    check(!!one && one.spoiler === true, 'and it already offers its Spoiler toggle', one);
    check(!names.includes('two.jpg'), 'while the photo that has not answered still has no chip', names);
    check((await ev('window.__cards()')) === 1, 'only the unfinished card is left on stage');
    await ev(`window.__finishNamed('two.jpg', { url: '/uploads/files/two.jpg', name: 'two.jpg', mime: 'image/jpeg', size: 1024, kind: 'image', scan: 'clean' })`);
    await sleep(750);
    chips = await ev('window.__chips()');
    check(chips.length === 4 && chips.every((c) => c.spoiler === true),
      'and the second follows on its own, every chip offering its toggle', chips);

    console.log('\n[6] two conversations upload at the same time without mixing');    await ev("window.__upload('mine.jpg', 1024)");
    await sleep(20);
    await ev("window.__switchTo('s2', 'c9')");
    await ev("window.__upload('theirs.jpg', 1024)");
    await sleep(20);
    check((await ev('window.__cards()')) === 1, 'the open conversation shows exactly its own card');
    card = await ev('window.__card()');
    check(!!card && card.name === 'theirs.jpg', 'and it is theirs', card);
    await ev("window.__progress('s:s2:c9', 512, 1024)");
    await ev("window.__switchTo('s1', 'c1')");
    await sleep(20);
    card = await ev('window.__card()');
    check((await ev('window.__cards()')) === 1 && !!card && card.name === 'mine.jpg', 'switching back shows this chat\'s card again', card);
    await ev("window.__progress('s:s1:c1', 1024, 1024)");
    card = await ev('window.__card()');
    check(!!card && card.indet && card.pct === '', 'with its progress where it was left', card);
    check((await ev("window.__progress('s:s1:c1', 1024, 1024), window.__watchArmed('s:s1:c1')")) === true, 'and its own stall ceiling');

    console.log('\n[7] a stalled request fails cleanly, with a Retry');
    await ev("window.__fail('s:s1:c1', 'upload_timeout')");
    card = await ev('window.__card()');
    check(!!card && card.failed, 'the card is marked failed', card);
    check(!!card && /respond/i.test(card.sub), 'with the human message, not a raw code', card && card.sub);
    check((await ev('window.__toasts.some((t) => /Upload failed/.test(t))')) === true, 'and a toast', await ev('JSON.stringify(window.__toasts)'));
    check((await ev("window.__watchArmed('s:s1:c1')")) === false, 'the ceiling is disarmed');
    check((await ev('window.__cards()')) === 1, 'the other conversation\'s upload is untouched');

    console.log('\n[8] leaving for Home parks everything and shows nothing');
    await ev('window.__switchHome()');
    await sleep(20);
    check((await ev('window.__cards()')) === 0, 'no cards on Home');
    check((await ev('window.__ctx()')) === null, 'no conversation owns the composer');
    const before = await ev('window.__S.uploads.length');
    await ev('window.__ready = false');
    await ev("window.__upload('nowhere.jpg', 1024)");
    check((await ev('window.__S.uploads.length')) === before, 'an attach with no conversation is refused (no orphan upload)');
    check((await ev('window.__toasts.some((t) => /Pick a chat first, then attach/.test(t))')) === true, 'with the reason', await ev('JSON.stringify(window.__toasts)'));

    console.log('\n[9] a video\'s frame takes over the tile its placeholder glyph held');
    await ev("window.__switchTo('s1', 'c1')");
    await ev('window.__ready = true');
    await ev("window.__upload('clip.mp4', 4096, 'video/mp4')");
    await sleep(30);
    let icon = await ev("window.__cardIcon('clip.mp4')");
    check(!!icon && icon.imgs === 0 && icon.svgs === 1,
      'while the frame is still being captured the card shows its placeholder glyph', icon);
    await ev("window.__firePosters('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ==')");
    await sleep(40);
    icon = await ev("window.__cardIcon('clip.mp4')");
    check(!!icon && icon.imgs === 1 && icon.svgs === 0,
      'the frame REPLACES it — one icon in the tile, never the picture beside a file symbol', icon);
    check(!!icon && icon.imgW === icon.boxW && icon.imgH === icon.boxH && icon.boxW === 36,
      'and it fills the whole 36px tile instead of being shrunk to make room (the reported sliver)', icon);
  } catch (e) {
    console.error('[test] ' + (e && e.stack || e));
    process.exit(1);
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome.kill(); } catch {}
    try { srv.close(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
