// Server settings -> the Leave zone: leaving a server asks first.
//
// The follow-up to the group-chat leave confirmation: a server's Leave was
// still a bare button. One press deleted your membership for good, and getting
// back in needs a fresh invite — there is no server directory to walk back in
// through — and it silently clears whatever tag you wore from that server.
//
// Drives the REAL danger-zone block sliced out of renderServerTab (security.js)
// against the REAL modal markup (index.html) and the REAL openModal /
// openConfirmModal / cancelModal (ui.js) in headless Chrome, so the dialog being
// asserted is the dialog a person gets: a member's Leave server opens it and
// calls NOTHING; Cancel changes nothing at all; the dialog's own Leave is what
// posts /leave, closes the panel, re-subscribes the socket and refreshes the
// rail. The owner's half is guarded in the same run — Delete server still opens
// the typed-name dialog (never this one), its OK stays blocked until the name
// matches, and it still DELETEs the server rather than leaving it. A refused
// /leave is checked too: it toasts and closes nothing, rather than pretending
// you left.
//
// Usage: node scripts/test-server-leave-confirm.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

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

const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const security = fs.readFileSync(path.join(ROOT, 'public/js/security.js'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'public/js/ui.js'), 'utf8');

const modalMarkup = index.slice(index.indexOf('<!-- modals -->'), index.indexOf('<!-- create-story chooser'));
// The real dialog layer: openModal / cancelModal / the three click wirings /
// openConfirmModal — everything a confirm needs, and nothing else.
const uiSrc = ui.slice(ui.indexOf('let modalOkFn = null;'), ui.indexOf('// Promise-based text-input dialog.'));
// The real danger zone, exactly as renderServerTab builds it (closes over
// `owner`, `d` and `cur`, which the page hands in). Anchored INSIDE
// renderServerTab: security.js has a second, unrelated danger zone (Settings →
// Account's Close account), and it spells its wrapper the same way.
const rst = security.indexOf('function renderServerTab() {');
const dangerSrc = security.slice(
  security.indexOf("  const dz = document.createElement('div'); dz.className = 'danger-zone';", rst),
  security.indexOf('  if (scroller) scroller.scrollTop = keepScroll;', rst));
const memberBranch = security.slice(security.indexOf('    if (!owner) {', rst), security.indexOf('    openModal(`Delete "', rst));

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>*{animation:none!important;transition:none!important}
html,body{margin:0}</style></head><body>
${modalMarkup}
<script>
window.__calls = [];
window.__apiFail = false;
window.S = { ws: { send: (m) => __calls.push('ws:' + m) } };
window.$ = (s) => document.querySelector(s);
window.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
window.toast = (m) => __calls.push('toast:' + m);
window.prettyError = (e) => String((e && e.message) || e);
window.closeServerSettings = () => __calls.push('closeServerSettings');
window.refreshServers = () => __calls.push('refreshServers');
window.api = async (u, o) => {
  __calls.push('api:' + u + ' ' + ((o && o.method) || 'GET'));
  if (__apiFail) throw new Error('boom');
  return { ok: true };
};
${uiSrc}
const D = { id: 's1', name: 'Campfire Test' };
// The real block, with the three things it closes over (owner, d, cur) handed in.
function buildDanger(owner, d, cur) {
${dangerSrc}
  return lb;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = () => !document.querySelector('#modal-backdrop').classList.contains('hidden');
const el = (s) => document.querySelector(s);
const finish = (o) => { document.title = JSON.stringify(o).replace(/</g, '\\u003c'); };
window.onerror = (m, s, l) => finish({ err: 'onerror: ' + m + ' @' + l });
// A throw inside an async click handler is an unhandled REJECTION, which
// window.onerror never sees — without this a broken page just reports nothing.
window.onunhandledrejection = (e) => { window.__rej.push(String((e.reason && e.reason.message) || e.reason) + ' | ' + String((e.reason && e.reason.stack) || '').split(String.fromCharCode(10)).slice(0, 3).join(' ~ ')); };
window.__rej = [];
(async () => {
  const out = {};
  out.probe = { confirm: typeof openConfirmModal, modal: typeof openModal, cancel: typeof cancelModal };
  try {
    // ---- a member: Leave server asks first ----
    const cur = document.createElement('div');
    document.body.appendChild(cur);
    const lb = buildDanger(false, D, cur);
    out.member = { label: lb.textContent, heading: cur.querySelector('h4').textContent, cls: lb.className };
    lb.click();
    await sleep(40);
    out.asked = {
      open: open(),
      title: el('#modal-title').textContent,
      ok: el('#modal-ok').textContent,
      cancel: el('#modal-close').textContent,
      okDanger: el('#modal-ok').classList.contains('danger'),
      body: el('#modal-body').textContent,
      calls: __calls.slice(),
    };
    el('#modal-close').click();
    await sleep(40);
    out.declined = { open: open(), calls: __calls.slice() };
    lb.click();
    await sleep(40);
    el('#modal-ok').click();
    await sleep(80);
    out.confirmed = { open: open(), calls: __calls.slice() };

    // ---- a refused leave: it says so and closes nothing ----
    __calls.length = 0;
    __apiFail = true;
    lb.click();
    await sleep(40);
    el('#modal-ok').click();
    await sleep(80);
    out.failed = { calls: __calls.slice() };
    __apiFail = false;

    // ---- the owner: Delete server is untouched ----
    const cur2 = document.createElement('div');
    document.body.appendChild(cur2);
    __calls.length = 0;
    const ob = buildDanger(true, D, cur2);
    out.owner = { label: ob.textContent, heading: cur2.querySelector('h4').textContent };
    ob.click();
    await sleep(40);
    out.ownerModal = {
      open: open(),
      title: el('#modal-title').textContent,
      ok: el('#modal-ok').textContent,
      body: el('#modal-body').textContent,
      blocked: el('#modal-ok').disabled,
      calls: __calls.slice(),
    };
    const inp = el('#m-del-name');
    out.ownerModal.hasInput = !!inp;
    if (inp) {
      inp.value = 'Campfire Test';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      out.ownerReady = !el('#modal-ok').disabled;
      el('#modal-ok').click();
      await sleep(80);
      out.ownerConfirmed = { open: open(), calls: __calls.slice() };
    } else {
      out.ownerReady = false;
      out.ownerConfirmed = { open: open(), calls: __calls.slice() };
    }
    out.rejections = window.__rej.slice();
    finish(out);
  } catch (e) { finish({ err: 'threw: ' + ((e && e.message) || e) + ' | ' + String((e && e.stack) || '').split(String.fromCharCode(10)).slice(0, 3).join(' ~ ') }); }})();
</script></body></html>`;
}

function run(chrome, html) {
  const dir = process.env.CF_TEST_DEBUG ? path.join(os.tmpdir(), 'cf-srvleave-debug') : fs.mkdtempSync(path.join(os.tmpdir(), 'cf-srvleave-'));
  try {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'page.html');
    fs.writeFileSync(p, html);
    const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=1280,900',
      '--virtual-time-budget=4000', '--dump-dom', 'file:///' + p.replace(/\\/g, '/')],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    if (process.env.CF_TEST_DEBUG) {
      fs.writeFileSync(path.join(dir, 'stdout.html'), r.stdout || '');
      fs.writeFileSync(path.join(dir, 'stderr.txt'), (r.stderr || '') + '\nstatus=' + r.status);
      console.log('[debug] wrote ' + dir);
    }
    const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
    if (!m) return { err: 'no title, status ' + r.status + ' ' + (r.stderr || '').slice(-400) };
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  } finally {
    if (!process.env.CF_TEST_DEBUG) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  }
}

function main() {
  // The source half runs everywhere, so the guarantee survives a box with no
  // Chrome: the ask is first, and the old one-press leave is gone.
  console.log('\n[0] the wiring asks before it leaves');
  check(!!memberBranch, 'sliced the member branch out of renderServerTab');
  const asked = memberBranch.indexOf('openConfirmModal({');
  const guarded = memberBranch.indexOf('if (!ok) return;');
  const posted = memberBranch.indexOf('api(`/api/servers/${d.id}/leave`');
  check(asked >= 0 && guarded > asked && posted > guarded,
    'Leave server opens the confirmation, and only a confirm reaches /leave', { asked, guarded, posted });
  check(!/if \(!owner\) \{\s*try \{\s*await api\(`\/api\/servers\/\$\{d\.id\}\/leave`/.test(security),
    'the old one-press leave is gone');
  check(/openModal\(`Delete "\$\{d\.name\}"\?`/.test(security) && /id="m-del-name"/.test(security),
    'and the owner still gets the typed-name Delete, not this dialog');
  check(!!uiSrc && !!dangerSrc && !!modalMarkup, 'sliced the dialog layer, the danger zone and the modal markup');

  const chrome = findChrome();
  if (!chrome) return skip('no Chrome/Edge found — set CHROME_PATH');
  const out = run(chrome, pageHtml());
  if (out.err) { check(false, 'the harness ran', out.err); return; }
  if (process.env.CF_TEST_DEBUG || (out.rejections || []).length) {
    console.log('  [debug] probe=' + JSON.stringify(out.probe));
    for (const r of out.rejections || []) console.log('  [debug] unhandled rejection: ' + r);
  }

  console.log('\n[1] a member: Leave server asks first');
  check(out.member.label === 'Leave server' && out.member.heading === 'Leave',
    'a non-owner still gets a danger Leave server button under a Leave heading', out.member);
  check(out.asked.open, 'pressing it opens a dialog', out.asked);
  check(out.asked.title === 'Leave "Campfire Test"?', 'named for the server', out.asked.title);
  check(out.asked.ok === 'Leave' && out.asked.cancel === 'Cancel' && out.asked.okDanger,
    'with a danger Leave button and a Cancel beside it', { ok: out.asked.ok, cancel: out.asked.cancel, danger: out.asked.okDanger });
  check(/disappears from your list/.test(out.asked.body) && /fresh invite/.test(out.asked.body) && /tag you wore/.test(out.asked.body),
    'and saying what leaving really does (list, invite, tag)', out.asked.body);
  check(out.asked.calls.length === 0, 'nothing at all has happened while the dialog is up', out.asked.calls);

  console.log('\n[2] Cancel changes nothing at all');
  check(!out.declined.open, 'the dialog closes');
  check(out.declined.calls.length === 0, 'and no request, no repaint, no subscribe went out', out.declined.calls);

  console.log('\n[3] the dialog\'s own Leave is what leaves');
  check(out.confirmed.calls[0] === 'api:/api/servers/s1/leave POST',
    'confirming posts /leave for this server', out.confirmed.calls);
  check(out.confirmed.calls.includes('closeServerSettings'), 'the settings panel closes', out.confirmed.calls);
  check(out.confirmed.calls.includes('ws:{"t":"subscribe"}'), 'the socket re-subscribes', out.confirmed.calls);
  check(out.confirmed.calls.includes('refreshServers'), 'and the rail refreshes', out.confirmed.calls);
  check(!out.confirmed.open, 'the dialog is gone behind it', out.confirmed.open);

  console.log('\n[4] a refused leave says so and closes nothing');
  check(out.failed.calls[0] === 'api:/api/servers/s1/leave POST', 'the request is attempted', out.failed.calls);
  check(!out.failed.calls.includes('closeServerSettings'), 'the panel is NOT closed as if you had left', out.failed.calls);
  check(out.failed.calls.some((c) => c.startsWith('toast:Failed: boom')), 'and it reports the failure', out.failed.calls);

  console.log('\n[5] the owner\'s Delete server is untouched');
  check(out.owner.label === 'Delete server' && out.owner.heading === 'Danger zone',
    'an owner still gets Delete server under a Danger zone heading', out.owner);
  check(out.ownerModal.open && out.ownerModal.title === 'Delete "Campfire Test"?' && out.ownerModal.ok === 'Delete',
    'which opens the typed-name dialog, never the Leave one', out.ownerModal);
  check(/deleted forever/.test(out.ownerModal.body) && /Server name/.test(out.ownerModal.body) && out.ownerModal.hasInput,
    'with its own warning and the name field', { body: out.ownerModal.body, hasInput: out.ownerModal.hasInput });
  check(out.ownerModal.blocked && out.ownerModal.calls.length === 0, 'blocked until the name is typed, still calling nothing', out.ownerModal);
  check(out.ownerReady, 'typing the exact name unlocks it');
  check(out.ownerConfirmed.calls[0] === 'api:/api/servers/s1 DELETE',
    'and it DELETEs the server rather than leaving it', out.ownerConfirmed.calls);
  check(!out.ownerConfirmed.calls.some((c) => c.includes('/leave')), 'the leave route is never touched here', out.ownerConfirmed.calls);

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
}

main();
