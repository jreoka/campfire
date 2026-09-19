// Editing a message: Save/Cancel have to act on the spot, and the resume splash.
//
// Two reports, one file, because both are the same class of bug — a client that
// decided "nothing needs repainting" about something the reader is looking at:
//
// [1] "the save and cancel buttons don't appear to do anything until you refresh
//     the page and find the save button worked apparently". saveEdit() cleared
//     S.editing but never repainted, and the only repaint left was the socket's
//     message-updated echo — which was itself gated off for any message whose row
//     is on screen ("the patch already applied it", the patch reasoned, though a
//     patch of ATTACHMENTS cannot carry edited text). So the edit box stayed up
//     with the old words behind it. Cancel then looked dead too, because clearing
//     S.editing had already disarmed it (`if (!S.editing) return`).
//
//     The real functions are extracted and driven here: the case bodies out of
//     socket.js's onWS, and repaintEditHosts/startEdit/cancelEdit/saveEdit out of
//     pickers.js, over stubs for the renderer and the API. No Postgres, no
//     browser — the decisions under test are all in the client.
//
// [2] "on the android mobile app every time I open the app it shows the campfire
//     connection screen for a few seconds". Android suspends the process (and the
//     socket) while the app is in the background, so the drop happens while
//     nobody is looking — but the overlay was armed anyway, and the reader got
//     the splash as the first thing on the way back, every time. The overlay
//     block out of socket.js is extracted and driven: hidden pages raise nothing,
//     a resume reconnects at once instead of waiting out the 2.5s backoff, and a
//     documented protective case (a visibly dropped socket) still covers the app.
//
// Usage: node scripts/test-message-edit.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}

const socketSrc = fs.readFileSync(path.join(ROOT, 'public/js/socket.js'), 'utf8');
const pickersSrc = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');

// ---------- extraction ----------
// One `case 'x': { … }` body out of onWS's switch, as a plain function. The
// trailing `break` belongs to the switch, so it cannot come along.
function caseBody(src, name, next) {
  const head = `case '${name}': {`;
  const a = src.indexOf(head);
  if (a < 0) { console.error(`[test] could not locate ${head} in socket.js`); process.exit(1); }
  const b = src.indexOf(`case '${next}'`, a + head.length);
  if (b < 0) { console.error(`[test] could not locate the end of the ${name} case`); process.exit(1); }
  let body = src.slice(a + head.length, b);
  const tail = body.match(/break;\s*\}\s*$/);
  if (!tail) { console.error(`[test] the ${name} case does not end the way this test expects`); process.exit(1); }
  body = body.slice(0, body.length - tail[0].length);
  if (/\bbreak\b/.test(body)) { console.error(`[test] a stray break in the ${name} case body`); process.exit(1); }
  return body;
}
const upSrc = caseBody(socketSrc, 'message-updated', 'reaction-update');
const dmUpSrc = caseBody(socketSrc, 'dm-updated', 'dm-deleted');
if (!/renderMessages/.test(upSrc) || !/renderDmMessages/.test(dmUpSrc)) {
  console.error('[test] the extracted case bodies look wrong');
  process.exit(1);
}
// The overlay block, verbatim: from its banner to the auth-dead handler.
const ovA = socketSrc.indexOf('// ---------- connection overlay');
const ovB = socketSrc.indexOf('// Auth was revoked server-side');
if (ovA < 0 || ovB < 0 || ovB <= ovA) { console.error('[test] could not locate the connection-overlay block in socket.js'); process.exit(1); }
const overlaySrc = socketSrc.slice(ovA, ovB);
if (!/function armConnSoon/.test(overlaySrc) || !/RESUMED_SOCKET_IDLE_MS/.test(overlaySrc)) {
  console.error('[test] the extracted overlay block is incomplete');
  process.exit(1);
}
// The edit box's own controls and the save path, verbatim.
const edA = pickersSrc.indexOf('function repaintEditHosts(');
const edB = pickersSrc.indexOf('// Edit box: Enter saves the edit');
if (edA < 0 || edB < 0 || edB <= edA) { console.error('[test] could not locate the edit block in pickers.js'); process.exit(1); }
const editSrc = pickersSrc.slice(edA, edB);
for (const fn of ['function repaintEditHosts', 'function startEdit', 'function cancelEdit', 'async function saveEdit']) {
  if (!editSrc.includes(fn)) { console.error(`[test] the extracted edit block is missing ${fn}`); process.exit(1); }
}

// ---------- [1] the socket cases ----------
// The one decision each case makes: does this update rebuild the message's row,
// or does the in-place attachment patch stand in for it?
function caseHarness(body, { thread = null } = {}) {
  const calls = { renderMessages: 0, renderThread: 0, renderDmMessages: 0, refreshDms: 0 };
  const state = {
    list: [],
    S: { channelId: 'c1', view: 'server', dmThreadId: null, histMode: null, thread },
    onScreen: false,
  };
  const fn = new Function(
    'm', 'S', 'msgById', 'updateMsgInCaches', 'patchMessageAttachmentsInList', 'messageAttachmentsOnScreen',
    'renderMessages', 'renderThread', 'renderDmMessages', 'refreshDms', 'threadLastFromMsg',
    body + '\n'
  );
  return {
    state, calls,
    push(msg) { state.list.push(msg); return msg; },
    cached(id) { return state.list.find((x) => x.id === id) || null; },
    run(m) {
      fn(
        m, state.S,
        (id) => state.list.find((x) => x.id === id) || null,
        (id, f) => { const x = state.list.find((v) => v.id === id); if (x) f(x); },
        // The real patch: it takes the message when there are attachments to
        // move, and its return value is deliberately NOT the repaint gate.
        (id, next) => !!(next && (next.attachments || []).length),
        () => state.onScreen,
        () => { calls.renderMessages++; },
        () => { calls.renderThread++; },
        () => { calls.renderDmMessages++; },
        () => { calls.refreshDms++; },
        (x) => ({ id: x.id })
      );
    },
  };
}
const pic = (v) => ({ id: 'a1', kind: 'image', url: '/uploads/files/pic.jpg?v=' + v, name: 'pic.jpg', scan: 'clean', w: 10, h: 10 });
const channelEdit = (content) => ({
  t: 'message-updated', channelId: 'c1',
  message: { id: 'm1', channelId: 'c1', content, attachments: [], user: { id: 'u1' } },
});

console.log('\n[1a] an edit repaints the message that is on screen');
{
  const h = caseHarness(upSrc);
  h.push({ id: 'm1', channelId: 'c1', content: 'before', attachments: [], user: { id: 'u1' } });
  h.state.onScreen = true;
  h.run(channelEdit('after'));
  check(h.cached('m1').content === 'after', 'the model carries the new text');
  check(h.calls.renderMessages === 1, 'the list rebuilds, so the new words are painted', h.calls);
  check(h.calls.renderThread === 0, 'and no thread panel is touched when none is open', h.calls);
}
{
  // The same edit on a message that HAS an attachment: this is the case the
  // attachment patch cannot carry, and the one that made Save look dead.
  const h = caseHarness(upSrc);
  h.push({ id: 'm1', channelId: 'c1', content: 'before', attachments: [pic(1)], user: { id: 'u1' } });
  h.state.onScreen = true;
  h.run(channelEdit('after'));
  check(h.cached('m1').content === 'after', 'an edited message with an attachment still takes the new text');
  check(h.calls.renderMessages === 1, 'and is rebuilt (the attachment patch cannot carry text)', h.calls);
}
{
  // An edit to the row shown inside the open thread panel is its own copy of the
  // markup, so it needs its own rebuild.
  const thread = { rootId: 'root', root: null, replies: [{ id: 'm1' }] };
  const h = caseHarness(upSrc, { thread });
  h.push({ id: 'm1', channelId: 'c1', content: 'before', attachments: [], user: { id: 'u1' } });
  h.state.onScreen = true;
  h.run(channelEdit('after'));
  check(h.calls.renderThread === 1, 'an edit to a reply rebuilds the open thread panel', h.calls);
}

console.log('\n[1b] a scan verdict still patches in place (the reason the gate exists)');
{
  const h = caseHarness(upSrc);
  h.push({ id: 'm1', channelId: 'c1', content: 'same words', attachments: [pic(1)], user: { id: 'u1' } });
  h.state.onScreen = true;
  // The verdict: identical text, new bytes — the picture must not blink back
  // through its placeholder, so this one is NOT allowed to rebuild the list.
  h.run({ t: 'message-updated', channelId: 'c1', message: { id: 'm1', channelId: 'c1', content: 'same words', attachments: [pic(2)], user: { id: 'u1' } } });
  check(h.calls.renderMessages === 0, 'a verdict on an on-screen message does not rebuild the list', h.calls);
  check(h.cached('m1').attachments[0].url.endsWith('v=2'), 'the final bytes still land in the model');
}
{
  const h = caseHarness(upSrc);
  h.push({ id: 'm1', channelId: 'c1', content: 'same words', attachments: [], user: { id: 'u1' } });
  h.state.onScreen = false;
  h.run({ t: 'message-updated', channelId: 'c1', message: { id: 'm1', channelId: 'c1', content: 'same words', attachments: [], user: { id: 'u1' } } });
  check(h.calls.renderMessages === 1, 'a message with no row on screen has nothing to patch, so the list is rebuilt as before', h.calls);
}
{
  const h = caseHarness(upSrc);
  h.push({ id: 'm1', channelId: 'c1', content: 'before', attachments: [], user: { id: 'u1' } });
  h.state.onScreen = false;
  h.run(channelEdit('after'));
  check(h.calls.renderMessages === 1, 'an edit to a message scrolled away still refreshes the list it is cached in', h.calls);
}
{
  const h = caseHarness(upSrc);
  h.push({ id: 'm1', channelId: 'other', content: 'before', attachments: [], user: { id: 'u1' } });
  h.state.onScreen = true;
  h.run({ t: 'message-updated', channelId: 'other', message: { id: 'm1', channelId: 'other', content: 'after', attachments: [], user: { id: 'u1' } } });
  check(h.calls.renderMessages === 0, 'an edit in another channel does not repaint the open one');
}

console.log('\n[1c] the DM twin behaves the same way');
{
  const h = caseHarness(dmUpSrc);
  h.state.S = { channelId: null, view: 'home', dmThreadId: 't1', histMode: null, thread: null };
  h.push({ id: 'm1', threadId: 't1', content: 'before', attachments: [pic(1)], user: { id: 'u1' } });
  h.state.onScreen = true;
  h.run({ t: 'dm-updated', message: { id: 'm1', threadId: 't1', content: 'after', attachments: [pic(1)], user: { id: 'u1' } } });
  check(h.calls.renderDmMessages === 1, 'an edited DM rebuilds the open conversation', h.calls);
  check(h.calls.refreshDms === 1, 'and the sidebar row is re-read (its preview is a snapshot)');
}
{
  const h = caseHarness(dmUpSrc);
  h.state.S = { channelId: null, view: 'home', dmThreadId: 't1', histMode: null, thread: null };
  h.push({ id: 'm1', threadId: 't1', content: 'same words', attachments: [pic(1)], user: { id: 'u1' } });
  h.state.onScreen = true;
  h.run({ t: 'dm-updated', message: { id: 'm1', threadId: 't1', content: 'same words', attachments: [pic(2)], user: { id: 'u1' } } });
  check(h.calls.renderDmMessages === 0, 'a DM verdict still patches in place', h.calls);
}

// ---------- [2] saveEdit / cancelEdit ----------
// The real buttons' code, over a stub API and stub renderers. `resolve` hands the
// test the moment the PATCH answers, so "before the server replied" is testable.
function editHarness({ patchOk = true, dm = false, serverMessage = null } = {}) {
  const S = { editing: 'm1', editRemovals: new Set(), channelId: 'c1', view: 'server', dmThreadId: null, thread: null };
  const list = [{ id: 'm1', content: 'before', edited: false, attachments: [{ id: 'a1' }], _dm: dm, user: { id: 'u1' } }];
  const calls = { api: [], renders: 0, dmRenders: 0, threadRenders: 0, toasts: [] };
  let settle = null;
  const box = { value: 'after', selectionStart: 0, focus() {} };
  const api = (url, opts) => {
    calls.api.push({ url, opts });
    return new Promise((res, rej) => { settle = { res, rej }; });
  };
  const fn = new Function(
    'S', '$', 'document', 'api', 'toast', 'prettyError', 'msgById', 'updateMsgInCaches',
    'renderMessages', 'renderDmMessages', 'renderThread', 'setTimeout',
    editSrc + '\nreturn { repaintEditHosts, startEdit, cancelEdit, saveEdit };'
  )(
    S,
    (sel) => (sel === '#edit-area' ? box : { focus() {}, addEventListener() {}, value: '' }),
    { addEventListener: () => {} },
    api,
    (t) => { calls.toasts.push(t); },
    (e) => String(e),
    (id) => list.find((x) => x.id === id) || null,
    (id, f) => { const x = list.find((v) => v.id === id); if (x) f(x); },
    () => { calls.renders++; },
    () => { calls.dmRenders++; },
    () => { calls.threadRenders++; },
    (f) => { f(); return 0; }
  );
  return {
    S, list, calls, box, api: fn,
    cached: () => list.find((x) => x.id === 'm1'),
    answer(server) {
      if (!settle) throw new Error('saveEdit never called the API');
      if (patchOk) settle.res({ message: server || { id: 'm1', content: 'after', edited: true, attachments: [{ id: 'a1' }] } });
      else settle.rej(new Error('http_500'));
    },
    pending: () => !!settle,
  };
}

async function editTests() {
  console.log('\n[2a] Save paints the edit and takes the box down before the server answers');
  {
    const h = editHarness();
    const p = h.api.saveEdit('m1');
    check(h.S.editing === null, 'the edit is closed immediately (messageEl only builds the box while S.editing matches)');
    check(h.cached().content === 'after', 'the cached message carries the new text on the spot', h.cached().content);
    check(h.cached().edited === true, 'and is marked edited');
    check(h.calls.renders === 1, 'the list is repainted at once — this is what makes Save feel like a button', h.calls);
    check(h.calls.api.length === 1 && h.calls.api[0].url === '/api/messages/m1' && h.calls.api[0].opts.method === 'PATCH',
      'the PATCH went to the channel route', h.calls.api);
    h.answer();
    await p;
    check(h.calls.renders === 2, 'and again when the server\'s own copy lands', h.calls);
    check(h.cached().content === 'after', 'which agrees with what was typed');
  }
  console.log('\n[2b] Cancel closes the box and puts the old words back');
  {
    const h = editHarness();
    h.api.startEdit('m1');
    check(h.S.editing === 'm1' && h.calls.renders === 1, 'Edit opens the box and paints it', h.calls);
    h.api.cancelEdit();
    check(h.S.editing === null, 'Cancel disarms the edit');
    check(h.calls.renders === 2, 'and repaints, so the box is gone');
    // The reported sequence: Save first, then Cancel. Cancel is a no-op once
    // S.editing is clear — which only reads as a dead button when Save left the
    // box on screen, which is exactly what [2a] prevents.
    const h2 = editHarness();
    h2.api.startEdit('m1');
    const p = h2.api.saveEdit('m1');
    const beforeCancel = h2.calls.renders;
    h2.api.cancelEdit();
    check(h2.S.editing === null && h2.calls.renders === beforeCancel,
      'a Cancel after Save changes nothing — the box is already gone');
    h2.answer();
    await p;
  }
  console.log('\n[2c] a failed edit is rolled back, not silently kept');
  {
    const h = editHarness({ patchOk: false });
    const p = h.api.saveEdit('m1');
    check(h.cached().content === 'after', 'the optimistic paint happens first');
    h.answer();
    await p;
    check(h.cached().content === 'before', 'the old text is restored when the PATCH fails', h.cached().content);
    check(h.cached().edited === false, 'and the edited marker with it');
    check(h.calls.toasts.length === 1 && /Edit failed/.test(h.calls.toasts[0]), 'the reader is told why', h.calls.toasts);
    check(h.calls.renders === 2, 'the rollback is painted too', h.calls);
  }
  console.log('\n[2d] a DM edit PATCHes the DM route (and never the channel one)');
  {
    const h = editHarness({ dm: true });
    const p = h.api.saveEdit('m1');
    check(h.calls.api[0].url === '/api/dms/messages/m1', 'the DM route is used', h.calls.api[0].url);
    h.answer();
    await p;
  }
  console.log('\n[2e] removing an attachment on the way through');
  {
    const h = editHarness();
    h.S.editRemovals = new Set(['a1']);
    const p = h.api.saveEdit('m1');
    check((h.cached().attachments || []).length === 0, 'the dropped attachment leaves the cached message');
    check(h.calls.api[0].opts.body.includes('"removeAttachments":["a1"]'), 'and rides the PATCH body', h.calls.api[0].opts.body);
    h.answer();
    await p;
  }
  console.log('\n[2f] an empty box is not an edit');
  {
    const h = editHarness();
    h.box.value = '   ';
    const p = h.api.saveEdit('m1');
    check(!h.pending(), 'no request is sent for whitespace only');
    check(h.S.editing === 'm1' && h.calls.renders === 0, 'and the box is left alone so the reader can carry on', h.calls);
    await p;
  }
}

// ---------- [3] the connection overlay on a resume ----------
// The real overlay block over a stub document/navigator, so a backgrounded app,
// a dropped socket and a resume can be played out in order.
function overlayHarness({ hidden = false, onLine = true, token = 'tok', mainView = true } = {}) {
  const cls = new Set(['hidden']);
  const overlay = {
    classList: {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      contains: (c) => cls.has(c),
      toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); },
    },
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    offsetWidth: 0,
  };
  const main = {
    classList: {
      contains: (c) => c === 'hidden' && !mainView,
    },
  };
  const handlers = {};
  const timers = new Map();
  let nextTimer = 1;
  const doc = {
    hidden,
    visibilityState: hidden ? 'hidden' : 'visible',
    getElementById: (id) => (id === 'conn-overlay' ? overlay : (id === 'view-main' ? main : null)),
    addEventListener: (t, fn) => { handlers[t] = fn; },
  };
  const nav = { onLine };
  const S = { ws: null, lastWsMsg: Date.now() };
  const calls = { connect: 0, hide: 0 };
  const api = new Function(
    'document', 'navigator', 'store', 'S', 'WebSocket', 'setTimeout', 'clearTimeout', 'connectWS',
    overlaySrc + '\nreturn { showConn, hideConn, armConnSoon, connVisible: () => connVisible };'
  )(
    doc, nav, { token }, S,
    { OPEN: 1, CONNECTING: 0, CLOSED: 3 },
    (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    (id) => { timers.delete(id); },
    () => { calls.connect++; }
  );
  return {
    S, calls, overlay, api, doc,
    shown: () => cls.has('show'),
    timers,
    // The pending fn/timeout pair the code scheduled (null when it scheduled none).
    due: () => { for (const [, t] of timers) return t; return null; },
    runDue() { const t = this.due(); if (t) { timers.clear(); t.fn(); } },
    hide() { doc.hidden = true; doc.visibilityState = 'hidden'; handlers.visibilitychange(); },
    // The page coming back to the front (what the phone does on resume).
    resume() { doc.hidden = false; doc.visibilityState = 'visible'; handlers.visibilitychange(); },
    hasResume: () => typeof handlers.visibilitychange === 'function',
  };
}

function overlayTests() {
  console.log('\n[3a] a socket that dies while the app is in the background covers nothing');
  {
    const h = overlayHarness();
    check(h.hasResume(), 'the overlay block owns the resume handler');
    h.hide();
    h.api.armConnSoon();           // ws.onclose, with the app in the background
    check(h.due() === null, 'no splash is scheduled while hidden', h.due());
    check(!h.shown(), 'and nothing is shown');
    h.api.showConn();              // the off-line / watchdog paths, same page
    check(!h.shown(), 'even a direct showConn refuses while hidden');
    // ...and the way back is an immediate reconnect, not the 2.5s backoff.
    h.S.ws = null;
    h.resume();
    check(h.calls.connect === 1, 'a resume with no socket reconnects at once', h.calls);
    check(!h.shown(), 'and the reader never sees the campfire at all');
  }
  console.log('\n[3b] a resume does not churn a socket that is alive and talking');
  {
    const h = overlayHarness();
    h.hide();
    h.S.ws = { readyState: 1 };
    h.S.lastWsMsg = Date.now() - 500; // it heard something just before the switch
    h.resume();
    check(h.calls.connect === 0, 'an open, recently-chatty socket is left alone', h.calls);
  }
  console.log('\n[3c] a socket that slept through the background is replaced');
  {
    // Android suspends the network under the WebView and a half-open socket never
    // fires onclose: it still reads OPEN, so waiting on the watchdog is a silent
    // ~9s of stale content. Past the point a healthy socket is ever quiet, drop it.
    const h = overlayHarness();
    h.hide();
    h.S.ws = { readyState: 1 };
    h.S.lastWsMsg = Date.now() - 60000;
    h.resume();
    check(h.calls.connect === 1, 'an OPEN-but-silent socket is reconnected on resume', h.calls);
  }
  console.log('\n[3d] the protective case still holds: a drop in front of a reader');
  {
    const h = overlayHarness();
    h.api.showConn();
    check(h.shown(), 'offline/an unreachable server still covers the app while it is being read');
    const h2 = overlayHarness();
    h2.api.armConnSoon();
    const t = h2.due();
    check(t && t.ms === 1200, 'a dropped socket still gets the boot grace before the splash', t && t.ms);
    h2.runDue();
    check(h2.shown(), 'and then the splash is up until the socket returns');
    h2.api.hideConn();
    check(!h2.shown(), 'a reconnect lifts it');
  }
  console.log('\n[3e] the resume paths that must NOT reconnect');
  {
    const h = overlayHarness({ hidden: true });
    h.hide();
    h.S.ws = { readyState: 0 }; // already on its way up
    h.resume();
    check(h.calls.connect === 0, 'a socket already CONNECTING is not restarted', h.calls);
    const t = h.due();
    check(t && t.ms === 1200, 'it gets the grace window instead of an instant splash', t && t.ms);
  }
  {
    const h = overlayHarness({ hidden: true, token: '' });
    h.hide();
    h.resume();
    check(h.calls.connect === 0, 'nothing is reconnected with no saved session', h.calls);
    const h2 = overlayHarness({ onLine: false });
    h2.hide();
    h2.S.ws = null;
    h2.resume();
    check(h2.calls.connect === 0 && h2.shown(), 'offline resumes show the splash and do not spin a socket', { calls: h2.calls, shown: h2.shown() });
  }
  console.log('\n[3f] the whole reported sequence raises no splash at any point');
  {
    const h = overlayHarness();
    h.S.ws = { readyState: 1 };
    h.S.lastWsMsg = Date.now();
    let everShown = h.shown();
    h.hide();                     // the user switches away; Android freezes it
    h.api.armConnSoon();          // the socket's onclose lands behind the freeze
    everShown = everShown || h.shown();
    h.S.ws = null;
    h.resume();                   // ...and back, socket gone
    everShown = everShown || h.shown();
    check(h.calls.connect === 1 && !everShown, 'reconnect only, never the campfire', { connect: h.calls.connect, everShown });
    h.api.hideConn();             // the fresh socket's onopen
    check(!h.shown(), 'and the app is up as usual');
  }
}

async function main() {
  await editTests();
  overlayTests();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => '  - ' + f).join('\n')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('[test] crashed:', (e && e.message) || e); process.exit(1); });
