// Composer drafts (see AGENTS.md verification conventions).
//
// The complaint: a server deploy / auto-update reload wiped whatever was being
// typed. The composer now keeps a per-conversation draft in localStorage (see
// the "composer drafts" block in public/js/core.js) so a reload brings the text
// back with the chat, sends clear it, and switching chats files it under the
// conversation it was typed in.
//
// There is no bundler and no exports here, so this drives the REAL functions by
// extracting that block from core.js and running it with stubs — no DOM needed.
//
// Offline (no database required).
//
// Usage: node scripts/test-composer-drafts.js
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

const src = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const start = src.indexOf('/* ---------- composer drafts ----------');
// The block runs to the end of the file (applyComposerDraft is last) today;
// fall back to an explicit end marker if anything is appended after it.
const endMark = src.indexOf('function readMemView', start + 1);
const end = endMark > 0 ? endMark : src.length;
if (start < 0) {
  console.error('[test] could not find the composer-drafts block in public/js/core.js');
  process.exit(1);
}
const code = src.slice(start, end);

// ---- stubs the extracted code leans on ----
const ls = new Map();
global.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
};
global.S = { me: { id: 'u1' }, view: 'server', serverId: null, channelId: null, dmThreadId: null, thread: null };
const box = { main: { id: 'in-message', value: '' }, thr: { id: 'in-thread', value: '' } };
global.$ = (sel) => (sel === '#in-message' ? box.main : sel === '#in-thread' ? box.thr : null);
global.syncComposerRender = () => {};
global.composerAutoGrow = () => {};
// Strict mode gives eval its own scope, so hand the functions back explicitly.
const { draftSoon, flushDrafts, draftClear, draftCtx, draftCtxForEl, draftThreadCtx, draftGet, draftSet, applyComposerDraft } = eval(
  code + '\n;({ draftSoon, flushDrafts, draftClear, draftCtx, draftCtxForEl, draftThreadCtx, draftGet, draftSet, applyComposerDraft })');

const raw = () => JSON.parse(ls.get('cf_drafts_u1') || '{}');
const type = (el, text) => { el.value = text; draftSoon(el, el === box.thr ? draftThreadCtx() : draftCtx()); };
const enterServer = (s, c) => { S.view = 'server'; S.serverId = s; S.channelId = c; S.dmThreadId = null; };
const enterDm = (id) => { S.view = 'home'; S.dmThreadId = id; };

console.log('\n[1] typing survives a reload');
enterServer('srv', 'c1');
type(box.main, 'half a thought');
flushDrafts();                            // what beforeunload does on reload
check(raw()['s:srv:c1'].t === 'half a thought', 'the text is stored under the conversation it was typed in', raw());
box.main.value = '';                      // fresh page load
applyComposerDraft();
check(box.main.value === 'half a thought', 'reloading paints it back into the composer', box.main.value);

console.log('\n[2] switching chats files text where it belongs');
box.main.value = 'for general';
type(box.main, 'for general');
S.channelId = 'c2';                       // switch before the debounce fires
flushDrafts();
check(raw()['s:srv:c1'].t === 'for general', 'a keystroke from the moment before the switch still lands on the old channel', raw()['s:srv:c1']);
box.main.value = '';
applyComposerDraft();
check(box.main.value === '', 'the next channel opens empty, not with the previous channel\'s text');
type(box.main, 'for random');
flushDrafts();
S.channelId = 'c1';
applyComposerDraft();
check(box.main.value === 'for general', 'coming back restores that channel\'s own draft', box.main.value);
S.channelId = 'c2';
applyComposerDraft();
check(box.main.value === 'for random', 'and the other channel kept its own', box.main.value);

console.log('\n[3] sending does not leave a ghost draft');
box.main.value = 'bye';
type(box.main, 'bye');
draftClear(draftCtx());                   // the submit handler
box.main.value = '';
flushDrafts();                            // the debounced write must be dead
applyComposerDraft();
check(!raw()['s:srv:c2'], 'a message typed and sent within the debounce leaves no draft', raw());
check(box.main.value === '', 'the composer stays empty for the next visit');

console.log('\n[4] channels, DMs and thread replies are separate');
enterDm('dm1');
type(box.main, 'in a DM');
flushDrafts();
check(raw()['d:dm1'].t === 'in a DM', 'DMs have their own draft');
S.thread = { rootId: 'root1' };
type(box.thr, 'in a thread');
flushDrafts();
check(raw()['t:root1'].t === 'in a thread', 'thread replies have their own draft');
S.thread = null;
enterServer('srv', 'c1');
box.main.value = 'z';
box.thr.value = '';
S.thread = { rootId: 'root1' };
applyComposerDraft();
check(box.thr.value === 'in a thread', 'opening that thread brings the reply back', box.thr.value);
enterDm('dm2');
applyComposerDraft();
check(box.main.value === '', 'a different DM does not inherit the other one\'s text');

console.log('\n[5] the store stays small and per account');
box.main.value = '';
S.thread = null;
enterServer('srv', 'c1');
const all = raw();
all['s:old:x'] = { t: 'stale', at: Date.now() - 40 * 864e5 };
ls.set('cf_drafts_u1', JSON.stringify(all));
draftSet('s:srv:c9', 'fresh');
check(!raw()['s:old:x'], 'drafts older than the TTL are dropped on the next write');
for (let i = 0; i < 60; i++) draftSet('s:srv:c' + i, 'text ' + i);
check(Object.keys(raw()).length === 40, 'at most 40 conversations are kept', Object.keys(raw()).length);
check(!!raw()['s:srv:c59'] && !raw()['s:srv:c0'], 'the newest ones win');
S.me = { id: 'u2' };
check(draftGet('s:srv:c1') === '' && !ls.get('cf_drafts_u2'), 'another account sees none of it');
S.me = { id: 'u1' };

console.log('\n[6] programmatic inserts count as typing');
// insertAtCursor() writes .value directly (no 'input' event), which is why it
// calls draftSoon itself — this mimics that call.
enterServer('srv', 'c5');
box.main.value = 'nice :fire:';
draftSoon(box.main, draftCtxForEl(box.main));
flushDrafts();
check(raw()['s:srv:c5'].t === 'nice :fire:', 'an emoji/mention insertion is drafted too', raw()['s:srv:c5']);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => '  - ' + f).join('\n')); process.exit(1); }
process.exit(0);
