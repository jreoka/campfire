// The composer's drop zone — and the one drag it must refuse.
//
// The complaint: a photo already posted in chat could be clicked, dragged and
// dropped back on the window, and it arrived as a brand-new attachment. The
// reason it was possible is not obvious: Chrome hands a dragged <img> over as a
// temporary FILE, so the drop zone's "does this drag carry files?" test (which
// is what keeps a stray drop from navigating the tab to the file and wiping a
// half-typed message) answered yes.
//
// So the guard has to be about where the drag STARTED, not what it carries. This
// drives the REAL drag/drop block sliced out of public/js/messages.js in headless
// Chrome — real document, real DragEvents, a real DataTransfer carrying a real
// File — and asks what the listeners did with it: whether the drop was accepted
// (preventDefault, which is what makes the browser treat it as ours), whether the
// drop overlay came up, and whether the file reached uploadAndAttach.
//
// Skips (exit 0) when Chrome is unavailable.
//
// Usage: node scripts/test-composer-drop.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9342', 10);
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

// The real block, sliced: from the drag-and-drop comment to the composer's own
// submit handler, which is the next thing in the file.
function dropSource() {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
  const a = src.indexOf('// drag-and-drop files anywhere in the app window');
  const b = src.indexOf("$('#composer').addEventListener('submit'");
  if (a < 0 || b < 0 || b <= a) {
    console.error('[test] could not find the drag-and-drop block in public/js/messages.js');
    process.exit(1);
  }
  return src.slice(a, b);
}

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head><body>
<div id="chat"><div id="composer"><input id="in-message" /></div></div>
<div id="in-message-2"></div>
<script>
// ---- the app's globals, stubbed (the sliced block only touches these) ----
const calls = { attach: [], toasts: [], focus: 0 };
window.__calls = calls;
function $(sel) { return document.querySelector(sel); }
function toast(msg) { calls.toasts.push(msg); }
function composerTargetReady() { return true; }
function uploadAndAttach(f) { calls.attach.push(f && f.name); }
document.querySelector('#in-message').addEventListener('focus', () => { calls.focus++; });
${dropSource()}
// ---- the harness the checks drive ----
// A drag carrying one real File, exactly what Chrome hands over for a dragged
// <img> (a temp file with the picture's bytes behind it).
window.__fileDrag = (name) => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/png' }));
  return dt;
};
window.__textDrag = () => {
  const dt = new DataTransfer();
  dt.setData('text/plain', 'just some selected text');
  return dt;
};
// One whole gesture: optional dragstart, then enter/over/drop, then dragend.
const fire = (target, type, dt) => {
  const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
  target.dispatchEvent(ev);
  return ev;
};
window.__gesture = (opts) => {
  calls.attach.length = 0; calls.toasts.length = 0; calls.focus = 0;
  const dt = opts.kind === 'text' ? window.__textDrag() : window.__fileDrag(opts.name || 'photo.png');
  let startEv = null;
  if (opts.internal) startEv = fire(document.querySelector(opts.from || '#chat'), 'dragstart', dt);
  const enter = fire(document, 'dragenter', dt);
  const over = fire(document, 'dragover', dt);
  const dropping = document.querySelector('#chat').classList.contains('dropping');
  const drop = fire(document, 'drop', dt);
  if (opts.endDrag !== false) fire(document.querySelector(opts.from || '#chat'), 'dragend', dt);
  return {
    startEv: !!startEv, enterPrevented: enter.defaultPrevented, overPrevented: over.defaultPrevented,
    dropping, dropPrevented: drop.defaultPrevented, attached: calls.attach.slice(),
    toasts: calls.toasts.slice(), focused: calls.focus, dropEffect: dt.dropEffect,
  };
};
// Leaving the window mid-drag (relatedTarget null) has to clear the mark.
window.__leaveWindow = (dt) => {
  const ev = new DragEvent('dragleave', { bubbles: true, cancelable: true, relatedTarget: null });
  Object.defineProperty(ev, 'dataTransfer', { value: dt });
  document.dispatchEvent(ev);
};
</script>
</body></html>`;
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-drop-'));
  const htmlPath = path.join(dir, 'drop.html');
  fs.writeFileSync(htmlPath, pageHtml());

  const child = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=900,600', 'about:blank'], { stdio: 'ignore' });

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
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
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
    if (!(await evaluate('typeof window.__gesture === "function"'))) {
      console.error('[test] the sliced drop block did not evaluate in the page');
      process.exit(1);
    }

    console.log('\n[1] a file dropped from outside is still an attachment');
    {
      const g = await evaluate('window.__gesture({ internal: false })');
      check(g.enterPrevented && g.overPrevented, 'the drag is claimed (no tab-navigating drop)', g);
      check(g.dropping, 'the drop overlay comes up', g);
      check(g.overPrevented && g.dropEffect !== '', 'the cursor says copy', g);
      check(g.dropPrevented, 'the drop is accepted', g);
      check(g.attached.length === 1 && g.attached[0] === 'photo.png', 'the file reaches uploadAndAttach', g);
      check(g.focused === 1, 'and the composer takes focus back', g);
      check(!(await evaluate('document.querySelector("#chat").classList.contains("dropping")')),
        'the overlay is gone again afterwards', null);
    }
    {
      const g = await evaluate('window.__gesture({ internal: false, kind: "text" })');
      check(!g.enterPrevented && !g.dropPrevented && !g.dropping, 'dragging text (no files) is left alone', g);
      check(g.attached.length === 0, 'and attaches nothing', g);
    }

    console.log('\n[2] a drag that started in the app is never a file drop');
    {
      // The reported gesture: grab the picture in a message (dragstart fires on
      // it) and let go over the composer. Chrome still says "Files".
      const g = await evaluate('window.__gesture({ internal: true, from: "#chat" })');
      check(g.startEv, 'the gesture starts on an element in the page', g);
      check(!g.enterPrevented && !g.overPrevented, 'the drop zone does not claim it', g);
      check(!g.dropping, 'and the "drop to attach" overlay never appears', g);
      check(!g.dropPrevented, 'the drop is refused (the browser keeps its own behaviour)', g);
      check(g.attached.length === 0, 'nothing is uploaded', g);
      check(g.toasts.length === 0, 'and nothing is toasted at the reader', g);
    }
    {
      // A real drag of an <img> element, not a synthetic one: the browser fires
      // dragstart on the image itself and it bubbles to the document listener.
      const g = await evaluate(`(() => {
        const img = document.createElement('img');
        img.src = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="100%" height="100%" fill="#345"/></svg>');
        img.id = 'posted-photo';
        img.className = 'att-img';
        document.querySelector('#chat').appendChild(img);
        const dt = window.__fileDrag('posted-photo.png');
        const start = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt });
        img.dispatchEvent(start);
        const enter = new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt });
        document.dispatchEvent(enter);
        const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
        document.dispatchEvent(drop);
        img.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
        const out = { enterPrevented: enter.defaultPrevented, dropPrevented: drop.defaultPrevented, attached: window.__calls.attach.slice() };
        img.remove();
        return out;
      })()`);
      check(!g.enterPrevented && !g.dropPrevented, 'the same gesture on a real <img> is refused', g);
      check(g.attached.length === 0, 'with nothing attached', g);
    }
    {
      // The mark must not be sticky: a real file drop right after an internal
      // drag still has to work.
      await evaluate('window.__gesture({ internal: true, from: "#chat" })');
      const g = await evaluate('window.__gesture({ internal: false })');
      check(g.dropPrevented && g.attached.length === 1, 'a file drop after an internal drag still attaches', g);
    }
    {
      // ...even if the internal drag was abandoned by dragging out of the window
      // and dragend never landed (an embedded WebView can lose it).
      const g = await evaluate(`(() => {
        const dt = window.__fileDrag('x.png');
        document.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        window.__leaveWindow(dt);
        const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
        window.__calls.attach.length = 0;
        document.dispatchEvent(drop);
        return { dropPrevented: drop.defaultPrevented, attached: window.__calls.attach.slice() };
      })()`);
      check(g.dropPrevented && g.attached.length === 1, 'leaving the window clears the mark', g);
    }

    console.log('\n[3] the media the app renders is not a drag source');
    {
      const js = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
      const embeds = fs.readFileSync(path.join(ROOT, 'public/embeds.js'), 'utf8');
      const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
      check(/<img class="att-img" draggable="false"/.test(js), 'a chat picture is marked undraggable', null);
      check(/<video class="att-vid" draggable="false"/.test(js), 'so is a chat video', null);
      check(/<img class="embed-img" draggable="false"/.test(embeds), 'and an inline image embed', null);
      check(/<video class="embed-vid" draggable="false"/.test(embeds), 'and an inline video embed', null);
      check(/<img class="el-img" draggable="false"/.test(embeds), 'and a link card thumbnail', null);
      check(/img,video\{-webkit-user-drag:none\}/.test(css), 'and none of them starts a drag at all (Blink/WebKit)', null);
      check(/document\.addEventListener\('dragstart', \(\) => \{ draggedInApp = true; \}, true\)/.test(js),
        'the drop zone marks a drag that began in this window', null);
      check(/const dragHasFiles = \(e\) => !draggedInApp && /.test(js), 'and refuses it as a file drop', null);
    }
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
main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
