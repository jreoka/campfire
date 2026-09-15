// The text/code attachment box: every text-ish file embeds as a code card that
// expands and collapses IN PLACE, with Copy and Download on it.
//
// The owner's ask was "text files or scripts or code files of all types embed
// into a box that can be expanded or collapsed with some buttons like the option
// to download". Two things are easy to get wrong and are what this pins:
//
//   - DETECTION. An extension list alone misses `Dockerfile`, `.env`, `README`
//     and anything the server labels `text/*`, so those land in the plain file
//     card instead of the box. And a list that is too eager swallows a .zip.
//   - the TOGGLE's own state. The body, `aria-expanded` and the label have to
//     move together, or the button reads "Collapse" over a 12-line preview.
//
// It drives the REAL block sliced out of public/js/messages.js in headless
// Chrome, with the real stylesheet inlined so the collapsed/expanded heights are
// measured rather than assumed. Skips (exit 0) when Chrome is unavailable.
//
// Usage: node scripts/test-code-card.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9346', 10);
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

// The real block, sliced: the whole text/code preview section, up to the next
// function in the file.
function codeSource() {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
  const a = src.indexOf('// ---------- text/code file previews');
  const b = src.indexOf('function fmtClock(s)');
  if (a < 0 || b < 0 || b <= a) {
    console.error('[test] could not find the text/code preview block in public/js/messages.js');
    process.exit(1);
  }
  return src.slice(a, b);
}

// Long enough that the preview really is a prefix: 40 numbered lines.
const FILE_TEXT = Array.from({ length: 40 }, (_, i) => 'const line' + (i + 1) + ' = ' + i + ';').join('\n');

function pageHtml() {
  const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
  return `<!doctype html><html><head><meta charset="utf-8">
<style>${css}</style>
</head><body>
<div id="messages"></div>
<script>
// ---- the app's globals, stubbed (the sliced block only touches these) ----
const calls = { toasts: [], copied: [] };
window.__calls = calls;
window.__text = ${JSON.stringify(FILE_TEXT)};
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]); }
function fmtSize(n) { return Math.max(1, Math.round((n || 0) / 1024)) + ' KB'; }
function attMeta(a, kind) {
  return ' data-att-id="' + esc((a && a.id) || '') + '" data-fb-url="' + esc((a && a.url) || '')
    + '" data-fb-name="' + esc((a && a.name) || '') + '" data-fb-kind="' + esc(kind || (a && a.kind) || 'file') + '"';
}
function attDl(a) { return '<a class="att-dl" href="' + esc(a.url) + '" download="' + esc(a.name) + '" target="_blank" rel="noopener" title="Download">DL</a>'; }
function toast(msg) { calls.toasts.push(msg); }
function setScrollTop(box, v) { box.scrollTop = v; }
window.__texts = {};
window.fetch = (u) => Promise.resolve({ ok: true, text: () => Promise.resolve(window.__texts[u] != null ? window.__texts[u] : window.__text) });
try {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: (t) => { calls.copied.push(t); return Promise.resolve(); } },
    configurable: true,
  });
} catch {}
${codeSource()}
// ---- the harness the checks drive ----
window.__att = (over) => Object.assign({
  kind: 'file', url: '/uploads/files/script.js', name: 'script.js', size: 900, mime: 'text/javascript', id: 'att1',
}, over || {});
// textFileHTML is the entry point the chat itself uses.
window.__card = (over) => {
  const box = document.getElementById('messages');
  box.insertAdjacentHTML('beforeend', textFileHTML(window.__att(over)));
  return box.lastElementChild;
};
window.__settle = () => new Promise((r) => setTimeout(r, 80));
// The open state and the fetched text are per-URL and deliberately outlive a
// render, so a case that wants a cold card has to say so.
window.__resetText = () => { txtExpanded.clear(); txtCache.clear(); document.getElementById('messages').innerHTML = ''; };
window.__body = (card) => card.querySelector('.txt-prev').textContent;
window.__label = (card) => card.querySelector('[data-act="expand-file"]').querySelector('.txt-lbl').textContent;
window.__expanded = (card) => card.querySelector('[data-act="expand-file"]').getAttribute('aria-expanded');
window.__maxH = (card) => getComputedStyle(card.querySelector('.txt-prev')).maxHeight;
</script>
</body></html>`;
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-codecard-'));
  const htmlPath = path.join(dir, 'code.html');
  fs.writeFileSync(htmlPath, pageHtml());

  const child = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
    '--window-size=900,1000', 'about:blank'], { stdio: 'ignore' });

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
    const pageErrors = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params?.exceptionDetails?.exception?.description || 'error');
    });
    await sess('Page.navigate', { url: 'file:///' + htmlPath.replace(/\\/g, '/') });
    await sleep(900);
    if (!(await evaluate('typeof window.__card === "function"'))) {
      console.error('[test] the sliced text/code block did not evaluate in the page');
      process.exit(1);
    }

    console.log('\n[1] which files become a code box');
    {
      const d = await evaluate(`(() => {
        const att = (name, mime, size) => textPreviewable({ name, mime: mime || '', size: size == null ? 400 : size });
        return {
          js: att('app.js', 'text/javascript'),
          docker: att('Dockerfile', ''),                 // no extension at all
          env: att('.env', ''),                           // dot-file, extension "env"
          readme: att('README', ''),
          plist: att('Info.plist', ''),
          ps1: att('deploy.ps1', ''),
          graphql: att('schema.graphql', ''),
          plainMime: att('notes', 'text/plain'),          // mime alone is enough
          yamlMime: att('x.bin', 'application/yaml'),     // ...or a known text-ish mime
          zip: att('archive.zip', 'application/zip'),
          exe: att('setup.exe', 'application/octet-stream'),
          key: att('presentation.key', ''),
          huge: att('bundle.js', 'text/javascript', 900 * 1024),
        };
      })()`);
      check(d.js && d.docker && d.env && d.readme, 'source, an extension-less Dockerfile, a .env and a bare README all embed', d);
      check(d.plist && d.ps1 && d.graphql, 'so do config formats, PowerShell and GraphQL schemas', d);
      check(d.plainMime && d.yamlMime, 'a text/* mime — or a known text-ish one — is enough on its own', d);
      check(!d.zip && !d.exe && !d.key, 'a zip, an exe and a .key deck stay plain download cards', d);
      check(!d.huge, 'and an oversized text file is a download, not a preview', d);
    }

    console.log('\n[2] the card starts collapsed, with its buttons');
    {
      const card = await evaluate(`(() => {
        const c = window.__card();
        return {
          cls: c.className,
          hasDl: !!c.querySelector('.txt-head .att-dl'),
          hasExpand: !!c.querySelector('[data-act="expand-file"]'),
          hasCopy: !!c.querySelector('[data-act="copy-file"]'),
          expanded: window.__expanded(c),
          label: window.__label(c),
          body: window.__body(c).split('\\n').length,
          attached: c.getAttribute('data-att-id'),
        };
      })()`);
      check(!/\bopen\b/.test(card.cls), 'it renders collapsed', card.cls);
      check(card.hasDl, 'the download chip is on the header', card);
      check(card.hasExpand && card.expanded === 'false' && card.label === 'Expand', 'an Expand toggle, reporting its state', card);
      check(card.hasCopy, 'and a Copy button', card);
      check(card.attached === 'att1', 'the card still carries the attachment identity the menus read', card);

      // The fade is the "there is more" signal, so it must NOT show on a file
      // the box holds entirely — it would dim real lines and lie.
      const short = await evaluate(`(async () => {
        window.__texts['/uploads/files/short.md'] = 'a\\nb\\nc';
        const c = window.__card({ url: '/uploads/files/short.md', name: 'short.md', mime: 'text/markdown' });
        await window.__settle();
        return { cls: c.className, lines: window.__body(c).split('\\n').length, fade: getComputedStyle(c.querySelector('.txt-body'), '::after').opacity };
      })()`);
      check(!/clipped/.test(short.cls) && parseFloat(short.fade) === 0,
        'a file the box holds entirely gets no "there is more" fade', short);

      // An extension means different things in different places, and a server
      // can label anything text/*: the BYTES get the last word.
      const bin = await evaluate(`(async () => {
        window.__texts['/uploads/files/blob.txt'] = 'PK\\u0000\\u0000binary\\u0000junk';
        const c = window.__card({ url: '/uploads/files/blob.txt', name: 'blob.txt', mime: 'text/plain' });
        await window.__settle();
        return { body: window.__body(c), cls: c.className };
      })()`);
      check(/Preview unavailable/.test(bin.body), 'a binary that claims to be text says so instead of painting mojibake', bin);
    }

    console.log('\n[3] expand grows the SAME box in place');
    {
      const r = await evaluate(`(async () => {
        window.__resetText();
        const box = document.getElementById('messages');
        const c = window.__card();
        await window.__settle();
        const before = { h: c.querySelector('.txt-prev').getBoundingClientRect().height, max: window.__maxH(c), lines: window.__body(c).split('\\n').length };
        const fadeBefore = getComputedStyle(c.querySelector('.txt-body'), '::after').opacity;
        const clippedBefore = /clipped/.test(c.className);
        expandTextFile(c.querySelector('[data-act="expand-file"]'));
        await window.__settle();
        const after = { h: c.querySelector('.txt-prev').getBoundingClientRect().height, max: window.__maxH(c), lines: window.__body(c).split('\\n').length };
        const fadeAfter = getComputedStyle(c.querySelector('.txt-body'), '::after').opacity;
        return {
          before, after, fadeBefore, fadeAfter,
          still: box.querySelectorAll('.txtfile').length,
          inPlace: c.isConnected,
          clippedBefore,
          clippedAfter: /clipped/.test(c.className),
          expanded: window.__expanded(c), label: window.__label(c), cls: c.className,
        };
      })()`);
      check(r.before.lines === 12, 'collapsed, the box shows the opening 12 lines', r.before);
      check(r.after.lines === 40, 'expanded, it shows the whole file', r.after);
      check(r.inPlace && r.still === 1, 'in the same box — no modal, no second node', r);
      check(parseFloat(r.after.max) > parseFloat(r.before.max), 'the code area grows past its collapsed cap', r);
      check(parseFloat(r.fadeAfter) < parseFloat(r.fadeBefore), 'and the "there is more" fade lifts', r);
      check(/open/.test(r.cls) && r.expanded === 'true' && r.label === 'Collapse', 'the toggle reports the open state', r);
      check(r.clippedBefore && !r.clippedAfter, 'and the "there is more" fade is a measurement, not decoration', r);
    }

    console.log('\n[4] collapse puts it back');
    {
      const r = await evaluate(`(async () => {
        window.__resetText();
        const box = document.getElementById('messages');
        const c = window.__card();
        await window.__settle();
        const btn = c.querySelector('[data-act="expand-file"]');
        expandTextFile(btn); await window.__settle();
        const openMax = window.__maxH(c);
        expandTextFile(btn); await window.__settle();
        return {
          openMax, max: window.__maxH(c), lines: window.__body(c).split('\\n').length,
          cls: c.className, expanded: window.__expanded(c), label: window.__label(c),
          cards: box.querySelectorAll('.txtfile').length,
        };
      })()`);
      check(r.lines === 12 && parseFloat(r.max) < parseFloat(r.openMax), 'it shrinks back to the preview', r);
      check(!/open/.test(r.cls) && r.expanded === 'false' && r.label === 'Expand', 'and the toggle says so', r);
      check(r.cards === 1, 'still one card', r);
    }

    console.log('\n[5] Copy copies the WHOLE file, and the box reopens as the reader left it');
    {
      const r = await evaluate(`(async () => {
        window.__resetText();
        const box = document.getElementById('messages');
        window.__calls.copied.length = 0;
        window.__calls.toasts.length = 0;
        // A card the reader never expanded: Copy must still fetch and copy all of it.
        const c = window.__card();
        await window.__settle();
        copyTextFile(c.querySelector('[data-act="copy-file"]'));
        await window.__settle();
        const lines = (window.__calls.copied[0] || '').split('\\n').length;
        // ...measured BEFORE the box is opened below: the point is that copying
        // a collapsed card does not expand it under the reader.
        const afterCopy = window.__body(c).split('\\n').length;
        // Now expand it and re-render (an edit, a live message) — the box must
        // come back open, not silently collapsed under the reader.
        expandTextFile(c.querySelector('[data-act="expand-file"]'));
        await window.__settle();
        const again = window.__card();
        await window.__settle();
        return {
          lines, afterCopy,
          toast: window.__calls.toasts.slice(),
          againOpen: /open/.test(again.className), againLabel: window.__label(again),
          againBody: window.__body(again).split('\\n').length,
        };
      })()`);
      check(r.lines === 40, 'Copy on a collapsed card copies the whole file, not the preview', r);
      check(r.toast.includes('Copied'), 'and says so', r);
      check(r.afterCopy === 12, 'copying does not expand the box under the reader', r);
      check(r.againOpen && r.againLabel === 'Collapse' && r.againBody === 40,
        'a re-render of an expanded card comes back expanded', r);
    }

    console.log('\n[6] the buttons are wired, and the stylesheet carries the box');
    {
      const js = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
      const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
      const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
      check(/data-act="expand-file"/.test(js) && /data-act="copy-file"/.test(js), 'both buttons carry the acts the click router reads', null);
      check(/act === 'expand-file'\) expandTextFile\(actEl\)/.test(pickers), 'the router expands', null);
      check(/act === 'copy-file'\) copyTextFile\(actEl\)/.test(pickers), 'and copies', null);
      check(/\.txtfile\{/.test(css) && /\.txtfile\.open \.txt-prev\{/.test(css), 'the stylesheet has the box and its open state', null);
      check(/\.txt-body::after\{[^}]*linear-gradient/.test(css), 'with the collapsed fade', null);
      check(!/\.txt-full/.test(css) && !/\.txt-full/.test(js), 'the old modal viewer is gone with its styles', null);
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
