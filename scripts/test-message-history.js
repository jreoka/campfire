// Older messages load when the reader scrolls back (see AGENTS.md conventions).
//
// The complaint: you can only scroll up so far in a channel before it stops —
// and the cause was not a limit anywhere on the server (it already pages on
// `?before=`), it was that the CLIENT never asked for a second page. Opening a
// conversation fetched the newest 80 and that was the whole conversation as far
// as the UI was concerned. The fix has to keep that: nobody wants the entire
// archive pushed at them on open, and the newest 80 must stay the only thing a
// reader who never scrolls up pays for.
//
// This drives the REAL paging block out of public/js/messages.js (sliced, with
// a fake DOM and a fake api) and checks the contract:
//   - opening a conversation asks for nothing but its newest page
//   - an upward scroll near the top asks the server for the page OLDER than the
//     oldest message on screen, on the right endpoint for a channel and for a DM
//   - the page is spliced in ABOVE the reader with their scroll place held, and
//     the oldest loaded message stays the cursor
//   - a short page means the beginning of the conversation and stops the paging
//     (no request), while a full one keeps the door open
//   - a failed page leaves a retry instead of a dead end, and does not silently
//     retry on every scroll event
//   - opening a conversation that was already paged back through keeps that
//     history and fills in the tail behind it, instead of pruning it away
//
// Offline (no Chrome, no database).
//
// Usage: node scripts/test-message-history.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}

// ---------- the real paging block, sliced out of messages.js ----------
const messages = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
const START = '// ---------- history paging: older messages on demand ----------';
const END = 'function replyPreviewOf(m) {';
const pagingSrc = messages.slice(messages.indexOf(START), messages.indexOf(END));
check(pagingSrc.length > 4000, 'the paging block is present in messages.js');

// The scroll-intent test needs the direction bookkeeping the watcher keeps, and
// that baseline is written by setScrollTop — so the real one is asserted by
// source (below) and mirrored by the harness's placement function.
const setScrollSrc = messages.slice(messages.indexOf('function setScrollTop('), messages.indexOf('function watchBottomState('));
check(/_lastTop/.test(setScrollSrc), 'setScrollTop keeps the direction baseline our own placements must not fake');

// ---------- a small fake DOM ----------
const HEIGHT = 60;
function el(cls, attrs = {}) {
  const e = {
    className: cls, textContent: '', dataset: { ...attrs }, children: [], parent: null,
    classList: {
      add: (c) => { if (!e.classList.contains(c)) e.className = (e.className + ' ' + c).trim(); },
      remove: (c) => { e.className = e.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
      contains: (c) => e.className.split(/\s+/).includes(c),
      toggle: (c, on) => { if (on) e.classList.add(c); else e.classList.remove(c); },
    },
    get firstChild() { return e.children[0] || null; },
    get firstElementChild() { return e.children[0] || null; },
    get nextElementSibling() {
      if (!e.parent) return null;
      const i = e.parent.children.indexOf(e);
      return i < 0 ? null : (e.parent.children[i + 1] || null);
    },
    insertBefore(node, ref) {
      if (!node) return node;
      const at = ref ? e.children.indexOf(ref) : -1;
      if (at < 0) e.children.push(node);
      else e.children.splice(at, 0, node);
      node.parent = e;
      return node;
    },
    appendChild(node) { return e.insertBefore(node, null); },
    remove() {
      if (!e.parent) return;
      const i = e.parent.children.indexOf(e);
      if (i >= 0) e.parent.children.splice(i, 1);
      e.parent = null;
    },
    replaceWith(node) {
      if (!e.parent) return;
      const i = e.parent.children.indexOf(e);
      if (i >= 0) e.parent.children.splice(i, 1, node);
      node.parent = e.parent;
      e.parent = null;
    },
    getBoundingClientRect() {
      const top = (e._offset || 0) - (e._box ? e._box.scrollTop : 0);
      const h = e._box ? HEIGHT : (e._offset != null ? HEIGHT : HEIGHT);
      return { top, bottom: top + h, height: h, left: 0 };
    },
    querySelector: (sel) => find(e, sel),
  };
  return e;
}
function walk(node, out = []) {
  for (const c of node.children) { out.push(c); walk(c, out); }
  return out;
}
function find(root, sel) {
  const all = walk(root);
  const mid = /\[data-mid="(.*)"\]/.exec(sel);
  if (mid) return all.find((n) => n.dataset && n.dataset.mid === mid[1]) || null;
  const cls = sel.replace(/^:scope\s*>\s*/, '');
  if (!cls.startsWith('.')) return null;
  const name = cls.slice(1);
  return all.find((n) => n.classList && n.classList.contains(name)) || null;
}

// ---------- the harness ----------
function harness() {
  const box = el('messages');
  box._box = box;
  box.clientHeight = 400;
  box.scrollTop = 0;
  box.scrollHeight = 0;
  box.scrollTo = () => {};
  const document = {
    querySelector: (sel) => (sel === '#messages' ? box : null),
    createElement: (tag) => el(tag),
  };
  // The app's own selector helper (core.js) — the paging block uses it to reach
  // #messages, so a fake DOM without it would fail the status row invisibly.
  const $ = (sel) => document.querySelector(sel);
  const calls = [];
  let reply = { messages: [] };
  let fail = false;
  const api = async (url) => {
    calls.push(url);
    if (fail) throw new Error('network');
    return reply;
  };
  const S = { view: 'server', serverId: 'srv1', channelId: 'ch1', dmThreadId: null, histMode: null,
    messages: new Map(), dmMessages: new Map() };
  // Enough of the message model for the paging block: messageEl records which
  // ids were painted (and it is what readds the nodes to the box), fmtDay groups
  // them, shouldGroup is the real 5-minute rule.
  const painted = [];
  const fmtDay = (ts) => 'd' + Math.floor(ts / 100000);
  const shouldGroup = (prev, m) => !!prev && (m.created_at - prev.created_at) <= 300000
    && !(prev.sys || m.sys) && (prev.user ? prev.user.id : null) === (m.user ? m.user.id : null);
  const messageEl = (m, opts = {}) => {
    const node = el('msg' + (opts.grouped ? ' grouped' : ''), { mid: m.id });
    for (const n of walk(box)) if (n.dataset.counted === m.id) return node; // no double-paint
    node.dataset.counted = m.id;
    painted.push(m.id);
    return node;
  };
  const captureListAnchor = (b) => {
    const btop = b.getBoundingClientRect().top;
    for (const n of walk(b)) {
      if (!n.classList.contains('msg')) continue;
      const r = n.getBoundingClientRect();
      if (r.bottom > btop + 1) return { mid: n.dataset.mid || null, off: r.top - btop };
    }
    return null;
  };
  const setScrollTop = (b, v, intent) => { b.scrollTop = v; b._lastTop = b.scrollTop; if (intent) b.dataset.atBottom = intent; };
  const ctx = { box, document, $, api, S, fmtDay, shouldGroup, messageEl, captureListAnchor, setScrollTop, painted };
  const fn = new Function('__ctx', `
    const { box, document, $, api, S, fmtDay, shouldGroup, messageEl, captureListAnchor, setScrollTop, painted } = __ctx;
    ${pagingSrc}
    return { histState, histStateFor, historyKey, historyKeyFor, resetHistoryTop, historyAfterTail,
             historyExtendedWindow, markHistoryExtended, paintHistoryTop, renderHistoryTopBar,
             maybeLoadOlderMessages, loadOlderMessages, prependOlderMessages, HIST_PAGE };
  `);
  const apiFns = fn(ctx);
  return {
    box, calls, S, painted, HIST_PAGE: apiFns.HIST_PAGE,
    fn: apiFns,
    setReply: (r) => { reply = r; },
    setFail: (v) => { fail = v; },
    // Repaint the box from the cached array, the way renderMessages does, so the
    // tests can assert on the real DOM the paging code sees.
    paint(msgs) {
      box.children = [];
      let lastDay = '';
      let prev = null;
      for (const m of msgs) {
        const d = fmtDay(m.created_at);
        if (d !== lastDay) { lastDay = d; prev = null; const node = el('day'); node.textContent = d; box.appendChild(node); }
        box.appendChild(messageEl(m, { grouped: shouldGroup(prev, m) }));
        prev = m;
      }
      this.layout();
    },
    // Heights: every message is HEIGHT tall, days 20, so scroll geometry is exact.
    layout() {
      let off = 0;
      for (const n of walk(box)) {
        n._offset = off;
        off += n.classList.contains('day') ? 20 : HEIGHT;
      }
      box.scrollHeight = off;
    },
    msgNode: (mid) => find(box, '[data-mid="' + mid + '"]'),
    bar: () => find(box, '.hist-top'),
    ids: () => walk(box).filter((n) => n.classList.contains('msg')).map((n) => n.dataset.mid),
  };
}
const page = (from, n, base = 1000) => Array.from({ length: n }, (_, i) => ({
  id: 'm' + (base + from + i), created_at: base + from + i, user: { id: 'u1' }, content: 'x',
}));

(async () => {
// ---------- 1. opening a conversation asks for nothing but its newest page ----
console.log('\n[1] a conversation opens on its newest page and asks for nothing older');
{
  const h = harness();
  const tail = page(0, 80);
  h.S.messages.set('ch1', tail);
  h.paint(tail);
  h.fn.historyAfterTail(h.fn.historyKey(), tail, tail, tail, { msgs: tail });
  // 80 messages are ~4800px: this is a reader far down inside the loaded page
  // (the band that asks for more is the top ~1000px of it).
  h.box.scrollTop = 3000;
  await h.fn.maybeLoadOlderMessages(h.box);
  check(h.calls.length === 0, 'a scroll well inside the loaded page fetches nothing', h.calls);
  check(h.bar() === null, 'and nothing is painted at the head of the list');
}

// ---------- 2. scrolling to the top asks for the page older than the oldest --
console.log('\n[2] reaching the top asks the server for the page older than the oldest message');
{
  const h = harness();
  const tail = page(80, 80);
  h.S.messages.set('ch1', tail);
  h.paint(tail);
  h.fn.historyAfterTail(h.fn.historyKey(), tail, tail, tail, { msgs: tail });
  h.fn.histStateFor(h.fn.historyKey()).done = false;
  h.box.scrollTop = 40;
  const anchorBefore = h.fn.HIST_PAGE && null;
  const older = page(0, 80);
  h.setReply({ messages: older });
  // Hold the reader's place: the topmost visible message and its offset.
  const before = walk(h.box).filter((n) => n.classList.contains('msg'))[0];
  const offBefore = before.getBoundingClientRect().top - h.box.getBoundingClientRect().top;
  await h.fn.loadOlderMessages(h.box);
  check(h.calls.length === 1, 'exactly one page request went out', h.calls);
  check(h.calls[0] === '/api/servers/srv1/channels/ch1/messages?limit=80&before=1080',
    'it asked for messages older than the oldest one loaded', h.calls[0]);
  check(h.S.messages.get('ch1').length === 160, 'the loaded conversation doubled in length',
    h.S.messages.get('ch1').length);
  check(h.S.messages.get('ch1')[0].id === 'm1000', 'the older page is now the head of the array');
  check(h.fn.histStateFor(h.fn.historyKey()).done === false, 'a FULL page keeps the door open for the next pull');
  check(h.ids()[0] === 'm1000' && h.ids().length === 160, 'and the older messages are painted above the old head', h.ids().slice(0, 2));
  const offAfter = before.getBoundingClientRect().top - h.box.getBoundingClientRect().top;
  check(Math.abs(offAfter - offBefore) < 0.5,
    'the line under the reader did not move (scroll place held)', { offBefore, offAfter });
  check(h.bar() === null, 'a successful page clears the status row');
  check(h.painted.filter((id) => id === 'm1080').length === 1, 'no message is painted twice');
  void anchorBefore;
}

// ---------- 3. what the reader already paged back through survives a reopen ---
console.log('\n[3] reopening a conversation keeps the history it already loaded');
{
  const h = harness();
  const loaded = page(0, 160); // paged back once already
  h.S.messages.set('ch1', loaded);
  h.paint(loaded);
  // The server's fresh tail: newer messages arrived while away.
  const fresh = page(160, 80); // 1160..1239
  const out = h.fn.historyAfterTail(h.fn.historyKey(), fresh, loaded, fresh, { msgs: loaded });
  check(out.extended === true, 'the loaded history is recognised as older than the fresh page');
  check(out.list.length === 240, 'the fresh tail is merged BEHIND it rather than replacing it', out.list.length);
  check(out.list[0].id === 'm1000' && out.list[out.list.length - 1].id === 'm1239',
    'the merged list runs from the oldest loaded message to the newest arrival');
  check(new Set(out.list.map((m) => m.id)).size === out.list.length, 'with no duplicates');
}

// ---------- 4. the beginning of a conversation is a full stop -----------------
console.log('\n[4] a short page means the beginning, and paging stops there');
{
  const h = harness();
  const tail = page(12, 80);
  h.S.messages.set('ch1', tail);
  h.paint(tail);
  h.fn.historyAfterTail(h.fn.historyKey(), tail, tail, tail, { msgs: tail });
  h.setReply({ messages: page(0, 12) }); // the whole rest of the conversation
  h.box.scrollTop = 40;
  await h.fn.loadOlderMessages(h.box);
  check(h.calls.length === 1, 'the first pull went out');
  check(h.S.messages.get('ch1').length === 92, 'and the remainder was added');
  check(h.fn.histStateFor(h.fn.historyKey()).done === true, 'a short page marks the conversation fully loaded');
  h.box.scrollTop = 10;
  await h.fn.maybeLoadOlderMessages(h.box);
  check(h.calls.length === 1, 'scrolling up again asks for nothing more — there is nothing more');
}

// ---------- 5. the reader's own movement is what asks -------------------------
console.log('\n[5] only the reader scrolling up (not the list growing) asks for a page');
check(new RegExp("const top = box\\.scrollTop;\\s*\\n\\s*const up = box\\._lastTop != null && top < box\\._lastTop - 2;").test(messages),
  'the watcher compares against the last position placed or observed');
check(/if \(up && userDrove\(\)\) \{ try \{ if \(typeof maybeLoadOlderMessages === 'function'\)/.test(messages),
  'and only a reader-driven upward move may ask for older messages');
check(/S\.histMode\) return;/.test(pagingSrc), 'a pin/quote context window is left alone (the jump pill owns the way back)');

// ---------- 6. a failure is a retry, never a silent dead end ------------------
console.log('\n[6] a failed page leaves a retry instead of a dead end');
{
  const h = harness();
  const tail = page(80, 80);
  h.S.messages.set('ch1', tail);
  h.paint(tail);
  h.fn.historyAfterTail(h.fn.historyKey(), tail, tail, tail, { msgs: tail });
  h.setFail(true);
  h.box.scrollTop = 40;
  await h.fn.loadOlderMessages(h.box);
  check(h.calls.length === 1, 'the request was attempted');
  const bar = h.bar();
  check(!!bar, 'the status row is visible');
  check(/retry/.test(bar ? bar.textContent : ''), 'and it offers the retry', bar && bar.textContent);
  h.box.scrollTop = 30;
  await h.fn.maybeLoadOlderMessages(h.box);
  check(h.calls.length === 1, 'a further scroll does NOT silently hammer the endpoint');
  h.setFail(false);
  h.setReply({ messages: page(0, 20) });
  await h.fn.loadOlderMessages(h.box);
  check(h.calls.length === 2, 'the retry itself goes out');
  check(h.S.messages.get('ch1').length === 100, 'and lands its page');
  check(h.bar() === null, 'clearing the failure takes the row away');
}

// ---------- 7. a DM pages on its own endpoint ---------------------------------
console.log('\n[7] DMs page the same way, on the DM endpoint');
{
  const h = harness();
  h.S.view = 'home';
  h.S.dmThreadId = 't1';
  const tail = page(80, 80);
  h.S.dmMessages.set('t1', tail);
  h.paint(tail);
  h.fn.historyAfterTail(h.fn.historyKey(), tail, tail, tail, { msgs: tail });
  h.setReply({ messages: page(0, 30) });
  h.box.scrollTop = 35;
  await h.fn.loadOlderMessages(h.box);
  check(h.calls[0] === '/api/dms/t1/messages?limit=80&before=1080', 'the DM cursor hit /api/dms/:tid/messages', h.calls[0]);
  check(h.S.dmMessages.get('t1').length === 110, 'and the DM history grew');
  check(h.S.dmMessages.get('t1')[0].id === 'm1000', 'with the older page at its head');
}

// ---------- 8. moving on mid-flight cannot land in the wrong conversation ----
console.log('\n[8] a page that lands after the reader moved on is dropped');
{
  const h = harness();
  const tail = page(80, 80);
  h.S.messages.set('ch1', tail);
  h.paint(tail);
  h.fn.historyAfterTail(h.fn.historyKey(), tail, tail, tail, { msgs: tail });
  h.setReply({ messages: page(0, 80) });
  h.box.scrollTop = 40;
  const p = h.fn.loadOlderMessages(h.box);
  h.S.channelId = 'ch2'; // the reader switched channels while the page was in flight
  await p;
  check(h.S.messages.get('ch1').length === 80, 'the stale page was never spliced into the old conversation');
  check(h.ids().length === 80, 'and nothing was painted into the list the reader left');
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exitCode = 1; }
})();
