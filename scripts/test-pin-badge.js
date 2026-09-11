// Pin button badge: "new pins" memory (see AGENTS.md).
//
// The complaint: the pin icon wore a purple count of the conversation's pins
// that never went away, so it read as unread notifications that could not be
// cleared. It is now a hint that this account has not looked at the pins in
// THIS conversation: opening the panel — or pinning something yourself —
// remembers what it held (localStorage cache, mirrored on the server so the
// memory follows the account across devices), the badge drops to 0, and it
// stays dropped across reloads until a pin you have not seen appears.
//
// No bundler and no exports here, so this drives the REAL helpers by extracting
// them from public/js/pins.js and running them against stub globals.
//
// Offline (no database, no browser required).
//
// Usage: node scripts/test-pin-badge.js
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

const src = fs.readFileSync(path.join(ROOT, 'public/js/pins.js'), 'utf8');
function slice(from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block in public/js/pins.js'); process.exit(1); }
  return src.slice(a, b);
}

// ---- stub globals the helpers lean on -------------------------------------
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
let panel = { open: false, list: false };
global.document = { querySelector: () => (panel.list ? {} : null) };
global.$ = () => ({ classList: { contains: () => !panel.open } });
global.S = { me: { id: 'me' }, pinIds: new Set(), pinIdsCtx: null, pinsCtx: null };

// sameCtx lives just above the pin-seen block and pinsPanelOpen calls it, so
// the extraction has to start there.
const code = slice('function sameCtx(a, b)', '// Per-conversation scroll memory');
// Strict mode gives eval its own scope, so hand the functions back explicitly.
const {
  pinSeenIds, pinSeenWrite, markPinsSeen, rememberPinsSeen,
  pinsPanelOpen, unseenPinCount, pinSeenCtxKey, PIN_SEEN_MAX, PIN_SEEN_TTL,
  applyPinSeenRemote, pinSeenFlush,
} = eval(code + '\n;({ pinSeenIds, pinSeenWrite, markPinsSeen, rememberPinsSeen, pinsPanelOpen, unseenPinCount, pinSeenCtxKey, PIN_SEEN_MAX, PIN_SEEN_TTL, applyPinSeenRemote, pinSeenFlush })');

const chan = (id, serverId = 's1') => ({ kind: 'server', id, serverId });
const dm = (id) => ({ kind: 'dm', id });
// What refreshPinsCount/renderPinsList do: the fetched ids become the current
// conversation's pin list.
function currentPins(ctx, ids) {
  S.pinIds = new Set(ids);
  S.pinIdsCtx = pinSeenCtxKey(ctx);
}
const unseenFor = (ctx, ids) => { currentPins(ctx, ids); return unseenPinCount(ctx); };

console.log('\n[1] a fresh conversation shows its pins as new');
check(unseenFor(chan('c1'), ['p1', 'p2']) === 2, 'two pins I have never looked at → 2');

console.log('\n[2] opening the panel clears it — and it stays cleared');
rememberPinsSeen(chan('c1'), S.pinIds);          // renderPinsList does this on open
check(unseenPinCount(chan('c1')) === 0, 'badge gone after opening the panel');
check(pinSeenIds(chan('c1')).has('p1') && pinSeenIds(chan('c1')).has('p2'), 'both ids remembered');
check(unseenFor(chan('c1'), ['p1', 'p2']) === 0, 'still gone after coming back (survives reload)');

console.log('\n[3] a pin I have not seen brings it back');
check(unseenFor(chan('c1'), ['p3', 'p1', 'p2']) === 1, 'someone pinned a new message → 1');
markPinsSeen(chan('c1'), ['p3']);                // I pinned p3 myself
check(unseenPinCount(chan('c1')) === 0, 'pinning it myself is not news to me');
// Everything got unpinned: the memory goes with the list, so a later re-pin of
// the same message is news again.
rememberPinsSeen(chan('c1'), []);
currentPins(chan('c1'), []);
check(unseenPinCount(chan('c1')) === 0 && pinSeenIds(chan('c1')).size === 0, 'the memory is dropped when the list empties');
check(unseenFor(chan('c1'), ['p1']) === 1, 'a re-pinned message is news again');

console.log('\n[4] per conversation, never leaking across channels or DMs');
check(unseenFor(chan('c9'), ['x1']) === 1, 'another channel starts fresh');
rememberPinsSeen(chan('c9'), ['x1']);
check(unseenFor(dm('t9'), ['x1']) === 1, 'the same id in a DM is still new (context is part of the key)');
rememberPinsSeen(dm('t9'), ['x1']);
check(unseenFor(chan('c9'), ['x1']) === 0, 'channel memory kept');
check(unseenFor(dm('t9'), ['x1']) === 0, 'DM memory kept, independently');
// The server id is part of the channel key, so identical channel ids in two
// servers cannot share a memory.
check(unseenFor(chan('c9', 's9'), ['x1']) === 1, 'same channelId in another server → new');

console.log('\n[5] per account (like the composer drafts)');
check(unseenFor(chan('c1'), ['p1']) === 1, 'back to the c1 memory from [3]');
rememberPinsSeen(chan('c1'), ['p1']);            // read it as me
check(unseenPinCount(chan('c1')) === 0, 'read as me → 0');
S.me = { id: 'someone-else' };
check(unseenPinCount(chan('c1')) === 1, 'another account has its own (empty) memory');
pinSeenWrite(chan('c1'), ['p1']);                // ...which writes under its own key
check([...store.keys()].includes('cf_pinseen_someone-else'), 'the other account writes its own store');
S.me = { id: 'me' };
check(unseenPinCount(chan('c1')) === 0, 'and switching back finds the original one');

console.log('\n[6] stale ids and stale contexts');
S.pinIds = new Set(['p9']);                      // not fetched for this ctx
S.pinIdsCtx = pinSeenCtxKey(chan('c2'));
check(unseenPinCount(chan('c1')) === 0, 'ids fetched for another conversation never badge');
S.pinIdsCtx = null;
check(unseenPinCount(chan('c1')) === 0 && unseenPinCount(null) === 0, 'no ctx / unset ctx → 0 (no crash)');

console.log('\n[7] the store stays bounded');
for (let i = 0; i < PIN_SEEN_MAX + 5; i++) pinSeenWrite(chan('bulk' + i), ['b' + i]);
check(pinSeenIds(chan('bulk' + (PIN_SEEN_MAX + 4))).size === 1 && pinSeenIds(chan('bulk0')).size === 0,
  'only the newest ' + PIN_SEEN_MAX + ' conversations are kept');
// TTL: an entry older than PIN_SEEN_TTL is pruned by the next write.
const all = JSON.parse(localStorage.getItem('cf_pinseen_me'));
all['d:stale'] = { ids: ['z1'], at: Date.now() - PIN_SEEN_TTL - 1000 };
localStorage.setItem('cf_pinseen_me', JSON.stringify(all));
pinSeenWrite(chan('c1'), ['p1']);
check(pinSeenIds(dm('stale')).size === 0, 'expired conversations are pruned');

console.log('\n[8] a live re-fetch with the panel open does not light the badge');
panel = { open: true, list: true };
S.pinsCtx = chan('c1');
check(pinsPanelOpen(chan('c1')) === true, 'the panel counts as open for its own conversation');
check(pinsPanelOpen(chan('c2')) === false, 'a different conversation is not on screen');
panel.open = false;
check(pinsPanelOpen(chan('c1')) === false, 'a closed modal is not open (S.pinsCtx lingers after Close)');
panel = { open: true, list: false };
check(pinsPanelOpen(chan('c1')) === false, 'a modal showing something else is not the pin panel');

console.log('\n[9] the wired call sites');
check(/if \(!pinned\) markPinsSeen\(ctx, \[mid\]\);/.test(src), 'togglePin marks my own pin as seen');
check(/if \(sameCtx\(pinsCtx\(\), ctx\)\) \{ markPinsSeen\(ctx, \[mid\]\); paintPinsBtn\(\); \}/.test(src), 'jumpToPin marks the message it lands on as seen');
check(/rememberPinsSeen\(ctx, S\.pinIds\);\s*\n\s*paintPinsBtn\(\);/.test(src), 'renderPinsList remembers what it showed');
check(/if \(pinsPanelOpen\(ctx\)\) rememberPinsSeen\(ctx, S\.pinIds\);/.test(src), 'refreshPinsCount skips the badge while the panel is open');
check(/const unseen = unseenPinCount\(ctx\);/.test(src), 'paintPinsBtn badges unseen pins, not the total');
check(!/b\.textContent = S\.pinCount > 0/.test(src), 'the old always-on total count is gone');

(async () => {
console.log('\n[10] the account\'s shared copy is folded in (cross-device)');
store.delete('cf_pinseen_me');
applyPinSeenRemote({ 's:s1:c1': { ids: ['p1', 'p2'], at: Date.now() } });
check(unseenFor(chan('c1'), ['p1', 'p2']) === 0, 'pins read on another device are already seen here');
check(unseenFor(chan('c1'), ['p1', 'p2', 'p3']) === 1, 'a pin nobody has read still badges');
rememberPinsSeen(dm('keep'), ['k1']);
// Union, never replace: an older server copy must not un-read a local read
// (ids are never reused, so a stale id cannot hide a genuinely new pin).
rememberPinsSeen(chan('c1'), ['p1', 'p2', 'p3']);
applyPinSeenRemote({ 's:s1:c1': { ids: ['p1'], at: Date.now() - 5000 } });
check(unseenPinCount(chan('c1')) === 0, 'merging keeps what this device already read');
check(pinSeenIds(dm('keep')).has('k1'), 'other conversations in the store are untouched');

console.log('\n[11] a local read is pushed to the shared copy');
store.delete('cf_pinseen_me');
const pushed = [];
global.api = async (p, opts) => { pushed.push({ p, body: JSON.parse(opts.body) }); return {}; };
applyPinSeenRemote({ 'd:t9': { ids: ['r1'], at: Date.now() } });
await pinSeenFlush();
check(pushed.length === 0, 'folding in the server copy does not echo it back');
markPinsSeen(dm('t9'), ['r2']);
check(pushed.length === 0, 'the write is queued, not sent on every panel row');
await pinSeenFlush();
check(pushed.length === 1 && pushed[0].p === '/api/pins/seen' && pushed[0].body.ctx === 'd:t9', 'a local read POSTs its ids for that conversation');
check(pushed[0] && pushed[0].body.ids.includes('r1') && pushed[0].body.ids.includes('r2'), 'the pushed list is the whole memory, not just the new id');
// Opening the panel walks every id (remember) and then re-fetches (mark): the
// burst must collapse into one request per conversation.
pushed.length = 0;
for (let i = 0; i < 5; i++) markPinsSeen(chan('c1'), ['x' + i]);
markPinsSeen(dm('t9'), ['r3']);
await pinSeenFlush();
check(pushed.length === 2, 'a burst of writes collapses to one request per conversation');

console.log('\n[12] a read the server never got is pushed back');
store.delete('cf_pinseen_me');
pushed.length = 0;
rememberPinsSeen(chan('c1'), ['solo1']);   // the write itself reaches the server here
await pinSeenFlush();
pushed.length = 0;
applyPinSeenRemote({});                    // ...but pretend it never did
await pinSeenFlush();
check(pushed.length === 1 && pushed[0].body.ctx === 's:s1:c1' && pushed[0].body.ids.join(',') === 'solo1', 'a conversation only this device knows about is pushed on the next pull', pushed);
pushed.length = 0;
applyPinSeenRemote({ 's:s1:c1': { ids: ['solo1'], at: Date.now() } });
await pinSeenFlush();
check(pushed.length === 0, 'and once both copies agree nothing more is sent');
delete global.api;

console.log('\n' + (failures.length ? failures.length + ' FAILED, ' + passed + ' passed' : 'all ' + passed + ' checks passed'));
process.exit(failures.length ? 1 : 0);
})();
