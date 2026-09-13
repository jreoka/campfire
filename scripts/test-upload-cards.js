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
const servers = fs.readFileSync(path.join(ROOT, 'public/js/servers.js'), 'utf8');
const pins = fs.readFileSync(path.join(ROOT, 'public/js/pins.js'), 'utf8');
const auth = fs.readFileSync(path.join(ROOT, 'public/js/auth.js'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

// The real block: the per-conversation attachment store through removeUpload.
const UP_START = messages.indexOf('// ---------- attachments belong to a conversation ----------');
const UP_END = messages.indexOf("$('#btn-attach').onclick", UP_START);
if (UP_START < 0 || UP_END < 0) {
  console.error('[test] could not locate the upload block in public/js/messages.js');
  process.exit(1);
}
const upSource = messages.slice(UP_START, UP_END);
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

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;font:14px system-ui}</style></head><body>
<div id="composer">${uploadListMarkup}<div id="attach-preview"></div></div>
<script>
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
window.__toasts = [];
function toast(t) { window.__toasts.push(String(t)); }
function fmtSize(n) { return Math.max(0, Math.round((Number(n) || 0) / 1024)) + ' KB'; }
function prettyError(e) { const m = { network_error: 'Network error', upload_timeout: 'The server stopped responding — try again.' }; return m[e] || String(e).replace(/_/g, ' '); }
const attPreviews = new Map();
function setAttPreview(url, src) { attPreviews.set(url, { src: src }); return true; }
function whenVideoPoster(url, cb) { if (cb) cb(null); }
function $(sel) { return document.querySelector(sel); }
window.__metaRenders = 0;
function renderComposerMeta() { window.__metaRenders++; }
// The composer "has a conversation" whenever the page says so.
function composerTargetReady() { return !!window.__ready; }
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
${upSource}
window.__S = S;
window.__entry = (ctx) => S.uploads.find((u) => u.ctx === ctx) || null;
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
window.__cards = () => document.querySelectorAll('#upload-list .up-card').length;
window.__hidden = () => document.querySelector('#upload-list').classList.contains('hidden');
window.__upload = (name, size) => {
  const f = new File([new Uint8Array(8)], name, { type: 'application/octet-stream' });
  Object.defineProperty(f, 'size', { value: size || 2048 });
  uploadAndAttach(f);
  return S.uploads.length;
};
window.__progress = (ctx, loaded, total) => { window.__entry(ctx).xhr.upload.onprogress({ lengthComputable: true, loaded, total }); };
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
  check(/ctx: attsCtxNow\(\)/.test(upSource), 'each upload records the conversation it started in');
  check(/const home = here \? S\.pendingAtts : attsListFor\(u\.ctx\)/.test(upSource),
    'a finished upload is filed where it was started, not where the reader is now');
  check(/activeUploadCount\(ctx\)/.test(upSource) && /activeUploadCount\(attsCtxNow\(\)\)/.test(upSource),
    'the 5-per-message cap counts that conversation\'s uploads');
  check(/if \(!composerTargetReady\(\)\) \{ toast\('Pick a chat first, then attach'\); return; \}/.test(upSource),
    'an attachment with no conversation to belong to is refused up front');
  check(/typeof pendingByCtx !== 'undefined' \? pendingByCtx\.values\(\) : \[\]/.test(messages),
    'a parked attachment keeps its thumbnail alive (pruneAttPreviews knows about the store)');

  console.log('\n[2] "every byte sent" is not "done"');
  check(/const sent = u\.total > 0 && u\.loaded >= u\.total;/.test(upSource), 'the card knows when the body is out');
  check(/if \(u\.indet \|\| sent\) \{ pct\.textContent = '…'; fill\.classList\.add\('indet'\); \}/.test(upSource),
    'and goes indeterminate instead of freezing at 99%');
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

  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-upcards-'));
  const srv = http.createServer((req, res) => {
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
    check(!!card && card.pct === '…' && card.indet, 'body out: the bar goes indeterminate (never a frozen 99%)', card);
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
    check(/s:s1:c1/.test(parked) && /a\.jpg/.test(parked), 'it is parked under the conversation it was started in', parked);
    check((await ev('window.__cards()')) === 0, 'and no card appears in the wrong chat');
    await sleep(700); // the done card lingers 650ms, then removes itself
    check((await ev('window.__S.uploads.length')) === 0, 'the finished upload leaves the queue', await ev('window.__S.uploads.length'));
    await ev("window.__switchTo('s1', 'c1')");
    await sleep(30);
    check((await ev('JSON.stringify(window.__atts())')).indexOf('a.jpg') !== -1, 'coming back, the attachment is waiting', await ev('JSON.stringify(window.__atts())'));
    parked = await ev('JSON.stringify(window.__parked())');
    check(!/s:s1:c1/.test(parked), 'and it is no longer parked', parked);

    console.log('\n[6] two conversations upload at the same time without mixing');
    await ev("window.__upload('mine.jpg', 1024)");
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
    check(!!card && card.indet && card.pct === '…', 'with its progress where it was left', card);
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
