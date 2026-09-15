// The composer's file picker takes SEVERAL files at once.
//
// The complaint was simply "right now you can only select one". The input is
// the easy half; the half worth pinning is what the change handler does with a
// multi-file selection, because the whole composer is built around a cap of 5
// attachments per message and a naive `files.forEach(uploadAndAttach)` would
// toast the cap once per extra file (or, worse, start uploads the send would
// then drop). So this drives the REAL handler sliced out of
// public/js/messages.js in headless Chrome with a real multi-file FileList and
// checks the arithmetic, the toast, and the focus handover.
//
// Skips (exit 0) when Chrome is unavailable.
//
// Usage: node scripts/test-attach-picker.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
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

// The real block, sliced: the attach button's click + the input's change and
// cancel handlers, up to the next function.
function pickerSource() {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
  const a = src.indexOf("$('#btn-attach').onclick");
  const b = src.indexOf('function composerTargetReady()');
  if (a < 0 || b < 0 || b <= a) {
    console.error('[test] could not find the attach-picker block in public/js/messages.js');
    process.exit(1);
  }
  return src.slice(a, b);
}

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="chat"><form id="composer">
  <button type="button" id="btn-attach"></button>
  <input id="in-attach" type="file" multiple class="hidden" />
  <textarea id="in-message"></textarea>
</form>
<form id="thread-composer">
  <button type="button" id="tbtn-attach"></button>
  <input id="in-thread-attach" type="file" multiple class="hidden" />
  <textarea id="in-thread"></textarea>
</form></div>
<script>
// ---- the app's globals, stubbed (the sliced block only touches these) ----
const calls = { attach: [], toasts: [], focus: 0, focusThread: 0, pickerOpened: 0, lastCtx: null };
window.__calls = calls;
window.S = { pendingAtts: [] };
window.__running = 0;
function $(sel) { return document.querySelector(sel); }
function toast(msg) { calls.toasts.push(msg); }
function composerTargetReady() { return window.__ready !== false; }
function activeUploadCount() { return window.__running; }
function attsCtxNow() { return 'ctx'; }
// The thread bar's own staging: its context, its list (the real ones key on the
// open thread — see threadAttCtx/threadAtts in messages.js).
function threadAttCtx() { return window.__threadClosed ? null : 't:root1'; }
function threadAtts() { return (window.__threadList = window.__threadList || []); }
function uploadAndAttach(f, ctx) { calls.attach.push(f && f.name); calls.lastCtx = ctx || null; }
document.querySelector('#in-message').addEventListener('focus', () => { calls.focus++; });
document.querySelector('#in-thread').addEventListener('focus', () => { calls.focusThread++; });
document.querySelector('#in-attach').addEventListener('click', () => { calls.pickerOpened++; });
${pickerSource()}
// ---- the harness the checks drive ----
window.__pick = (names) => {
  const inp = document.querySelector('#in-attach');
  const dt = new DataTransfer();
  names.forEach((n, i) => dt.items.add(new File(['x'.repeat(4 + i)], n, { type: 'text/plain' })));
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  return { files: inp.files.length, value: inp.value };
};
window.__pickThread = (names) => {
  const inp = document.querySelector('#in-thread-attach');
  const dt = new DataTransfer();
  names.forEach((n, i) => dt.items.add(new File(['x'.repeat(4 + i)], n, { type: 'text/plain' })));
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  return { files: inp.files.length, value: inp.value };
};
window.__reset = () => {
  window.__calls.attach.length = 0;
  window.__calls.toasts.length = 0;
  window.__calls.focus = 0;
  window.__calls.focusThread = 0;
  window.__calls.lastCtx = null;
  window.S.pendingAtts = [];
  window.__running = 0;
  window.__ready = true;
  window.__threadList = [];
  window.__threadClosed = false;
  // Focus only fires on a CHANGE of focus, so a case that starts with the box
  // already focused would see nothing.
  document.querySelector('#in-message').blur();
  document.querySelector('#in-thread').blur();
};
</script>
</body></html>`;
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-picker-'));
  const htmlPath = path.join(dir, 'picker.html');
  fs.writeFileSync(htmlPath, pageHtml());

  const child = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
    '--window-size=900,700', 'about:blank'], { stdio: 'ignore' });

  let ws;
  try {
    let info = null;
    for (let i = 0; i < 60 && !info; i++) {
      try { info = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); } catch { await sleep(250); }
    }
    if (!info) return skip('Chrome never opened its DevTools port');
    ws = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0;
    const pending = new Map();
    const pageErrors = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params?.exceptionDetails?.exception?.description || 'error');
    });
    const call = (method, params, sessionId) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
      ws.send(JSON.stringify({ id: i, sessionId, method, params }));
    });
    const targetId = (await call('Target.createTarget', { url: 'about:blank' })).targetId;
    const sessionId = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    const sess = (m, p) => call(m, p, sessionId);
    const evaluate = async (expression) => {
      const r = await sess('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'page error');
      return r.result.value;
    };

    await sess('Page.enable');
    await sess('Runtime.enable');
    await sess('Page.navigate', { url: 'file:///' + htmlPath.replace(/\\/g, '/') });
    await sleep(800);
    if (!(await evaluate('typeof window.__pick === "function"'))) {
      console.error('[test] the sliced attach-picker block did not evaluate in the page');
      process.exit(1);
    }

    console.log('\n[1] the input itself takes several files');
    {
      const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
      check(/<input id="in-attach" type="file" multiple class="hidden" \/>/.test(html),
        'the composer input is `multiple`', null);
      const other = html.match(/<input id="[a-z-]*file[a-z-]*" type="file"[^>]*>/g) || [];
      check(other.every((t) => !/multiple/.test(t)),
        'the single-purpose pickers (avatar, banner, story camera) are left alone', other);
    }

    console.log('\n[2] a multi-file selection starts one upload per file');
    {
      const r = await evaluate(`(() => {
        window.__reset();
        const out = window.__pick(['a.txt', 'b.js', 'c.md']);
        return { out, attach: window.__calls.attach.slice(), toasts: window.__calls.toasts.slice(), focus: window.__calls.focus };
      })()`);
      check(r.attach.length === 3, 'all three files are attached', r);
      check(r.attach.join(',') === 'a.txt,b.js,c.md', 'in the order they were picked', r);
      check(r.toasts.length === 0, 'with nothing toasted at the reader', r);
      check(r.out.value === '' && r.out.files === 0, 'and the input is cleared so the same file can be picked again', r);
      check(r.focus === 1, 'the composer takes focus back for Enter-to-send', r);
    }

    console.log('\n[3] the 5-per-message cap is applied once, not once per file');
    {
      const r = await evaluate(`(() => {
        window.__reset();
        const out = window.__pick(['1', '2', '3', '4', '5', '6', '7', '8']);
        return { out, attach: window.__calls.attach.slice(), toasts: window.__calls.toasts.slice() };
      })()`);
      check(r.attach.length === 5, 'only the first five start', r);
      check(r.toasts.length === 1, 'the cap is explained exactly once', r);
      check(/max 5 attachments per message/i.test(r.toasts[0] || ''), 'and the toast names the cap', r);
    }
    {
      const r = await evaluate(`(() => {
        window.__reset();
        window.S.pendingAtts = [{}, {}, {}];   // three chips already staged
        window.__running = 1;                   // one upload in flight
        const out = window.__pick(['x.txt', 'y.txt', 'z.txt']);
        return { out, attach: window.__calls.attach.slice(), toasts: window.__calls.toasts.slice() };
      })()`);
      check(r.attach.length === 1 && r.attach[0] === 'x.txt', 'with room for one, one starts (not three)', r);
      check(r.toasts.length === 1 && /1 of 3/.test(r.toasts[0] || ''), 'and the toast says how many made it', r);
    }
    {
      const r = await evaluate(`(() => {
        window.__reset();
        window.S.pendingAtts = [{}, {}, {}, {}, {}]; // already full
        const out = window.__pick(['late.txt']);
        return { out, attach: window.__calls.attach.slice(), toasts: window.__calls.toasts.slice() };
      })()`);
      check(r.attach.length === 0, 'with the message already full, nothing starts', r);
      check(r.toasts.length === 1 && /max 5/i.test(r.toasts[0] || ''), 'and the reader is told why', r);
    }

    console.log('\n[4] no conversation open: one toast, no uploads');
    {
      const r = await evaluate(`(() => {
        window.__reset();
        window.__ready = false;
        window.__pick(['a.txt', 'b.txt']);
        const out = { attach: window.__calls.attach.slice(), toasts: window.__calls.toasts.slice(), focus: window.__calls.focus };
        window.__ready = true;
        return out;
      })()`);
      check(r.attach.length === 0, 'nothing is uploaded', r);
      check(r.toasts.length === 1 && /pick a chat first/i.test(r.toasts[0] || ''), 'one toast, not one per file', r);
      check(r.focus === 1, 'and focus still comes back', r);
    }

    console.log('\n[5] the attach button opens the picker');
    {
      const r = await evaluate(`(() => {
        document.querySelector('#btn-attach').click();
        return window.__calls.pickerOpened;
      })()`);
      check(r === 1, 'the button still opens the picker', r);
    }

    console.log('\n[6] the thread bar has its own picker, staging on its own thread');
    {
      const r = await evaluate(`(() => {
        window.__reset();
        const out = window.__pickThread(['t1.txt', 't2.txt']);
        return { out, attach: window.__calls.attach.slice(), ctx: window.__calls.lastCtx,
          toasts: window.__calls.toasts.slice(), focus: window.__calls.focusThread,
          chatChips: window.S.pendingAtts.length, threadList: window.__threadList.length };
      })()`);
      check(r.attach.join(',') === 't1.txt,t2.txt', 'the reply bar takes its own multi-file pick', r);
      check(r.ctx === 't:root1', 'and hands every file the THREAD\'s context, never the channel\'s', r);
      check(r.chatChips === 0, 'so the chat composer beside it is left alone', r);
      check(r.out.value === '' && r.out.files === 0, 'and the input clears for a second pick', r);
      check(r.focus === 1, 'focus comes back to the reply box for Enter-to-send', r);
    }
    {
      const r = await evaluate(`(() => {
        window.__reset();
        window.__threadClosed = true;   // the panel closed while the dialog was open
        window.__pickThread(['late.txt']);
        const out = { attach: window.__calls.attach.slice(), toasts: window.__calls.toasts.slice() };
        window.__threadClosed = false;
        return out;
      })()`);
      check(r.attach.length === 0 && r.toasts.length === 1 && /closed/i.test(r.toasts[0] || ''),
        'a thread that closed mid-dialog is named, not silently swallowed', r);
    }

    check(pageErrors.length === 0, 'no uncaught page errors through the whole run', pageErrors.slice(0, 3));
  } catch (e) {
    console.error('[test] ' + (e && e.message));
    process.exit(1);
  } finally {
    try { ws && ws.close(); } catch {}
    try { child.kill(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

main();
