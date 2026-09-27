// A DM row must not advertise a call that has ended (see AGENTS.md
// verification conventions).
//
// The complaint: leave a 1:1 call you were the last one in, and the sidebar row
// for that conversation keeps its green "1 in call — open to join" line and its
// in-call border, inviting you to rejoin a call that nobody is in. It never
// clears, and clicking Join lands you alone in a room you just left.
//
// The row's count was `dmCallPeers(t.id).length || t.callCount || 0`, and both
// halves of that are wrong in the same place. `dmCallPeers` reads the LIVE
// roster in S.voiceOccupancy, which is correct — but that map deletes a room
// once it empties (dmPeerLeft), so "the call is over" and "this client never
// heard of that room" both read as length 0. Length 0 then fell through to
// `t.callCount`, which is the /api/dms SNAPSHOT — the count from before the
// call you just left. The fallback was not idle code: it is what paints the
// badge in the window between boot's /api/dms and the subscribe-time
// voice-peers frames, which is exactly why it was tempting to keep.
//
// So the fix is not "drop the fallback" (that trades a stale count for a ghost
// badge on every load) but "know the difference between zero and unknown":
// `dmCallCount` consults the snapshot only while this client has no live answer
// for the thread, and every frame that reports a DM roster — including an empty
// one, a peer leaving, the call ending, and your own leave that drained the
// room — records that the answer is now known.
//
// [A] runs the REAL dmCallCount out of voice.js, against the REAL occupancy
// helpers, in a fresh vm realm with a minimal S. No browser and no server: the
// bug is pure state bookkeeping, and the thing that regressed it was a missing
// fact, not a wrong branch.
//
// Usage: node scripts/test-dm-call-count-stale.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}

const voiceSrc = fs.readFileSync(path.join(ROOT, 'public/js/voice.js'), 'utf8');
const homeSrc = fs.readFileSync(path.join(ROOT, 'public/js/home.js'), 'utf8');
const serversSrc = fs.readFileSync(path.join(ROOT, 'public/js/servers.js'), 'utf8');
const socketSrc = fs.readFileSync(path.join(ROOT, 'public/js/socket.js'), 'utf8');

// The DM-call block, sliced out of the real file. Everything under test lives
// in one contiguous run, so it is taken as written rather than re-implemented —
// a test that re-derives the rule is a test of the test.
const block = (() => {
  const a = voiceSrc.indexOf('// ---------- DM calls');
  const b = voiceSrc.indexOf("$('#ic-accept').onclick");
  if (a < 0 || b < 0) { console.error('[test] could not find the DM-call block in voice.js'); process.exit(1); }
  return voiceSrc.slice(a, b);
})();

// A realm holding just the state these functions touch, plus a context with the
// three maps the block expects. Nothing else from the app is needed, and not
// wanting it is the point: the count must depend on occupancy knowledge alone.
function makeClient(seed) {
  const ctx = {
    S: {
      me: { id: 'me', display_name: 'Me' },
      dms: [],
      voice: null,
      voiceOccupancy: new Map(),
      voiceSince: new Map(),
    },
    console,
    JSON, Math, Date, Set, Map, Array, Object, Number, String, Boolean,
    // The slice wires buttons and repaints panes; the count logic under test
    // reads none of it, so it is stubbed rather than stood up in a real DOM.
    $: () => ({ classList: { add() {}, remove() {} } }),
    renderDmLists: () => {}, renderDmMembers: () => {},
    sfx: { ring() {}, join() {}, leave() {} },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block, ctx, { filename: 'voice.js#dm-calls' });
  if (seed) vm.runInContext(seed, ctx, { filename: 'seed' });
  return ctx;
}
const run = (ctx, expr) => vm.runInContext(expr, ctx);
const count = (ctx, tid) => run(ctx, `dmCallCount(${JSON.stringify(tid)}, null)`);

console.log('\n[A] the real dmCallCount, in a fresh realm');
{
  // A thread whose /api/dms snapshot said one person was in a call — the state
  // a client is in the instant it opens a conversation somebody is already
  // calling. No live roster yet, so the snapshot is the only answer there is.
  const ctx = makeClient(`
    S.dms = [{ id: 'T1', callCount: 1 }];
    S.voiceOccupancy.set('dm:T1', [{ id: 'other' }]);
    S.voiceSince.set('dm:T1', 1);
    dmOccAnswered('T1'); // the voice-peers frame that put the roster there
  `);
  check(count(ctx, 'T1') === 1, 'a roster this client was told about is counted live', count(ctx, 'T1'));
  check(run(ctx, `dmCallCount('T1', { callCount: 9 })`) === 1,
    'and it beats a stale snapshot that disagrees', run(ctx, `dmCallCount('T1', { callCount: 9 })`));
}

console.log('\n[B] an UNKNOWN thread still falls back to the snapshot');
{
  // No voice-peers frame has arrived for this thread yet. The snapshot is the
  // whole point of `callCount`: dropping it would flash "no call" on every load,
  // before the subscribe reply lands.
  const ctx = makeClient(`
    S.dms = [{ id: 'T1', callCount: 2 }];
  `);
  check(count(ctx, 'T1') === 0, 'with no roster at all the live answer is zero', count(ctx, 'T1'));
  check(run(ctx, `dmCallCount('T1', { callCount: 2 })`) === 2,
    'but an unanswered thread reads its snapshot — that is the load-time badge', run(ctx, `dmCallCount('T1', { callCount: 2 })`));
  check(run(ctx, `dmCallCount('T2', { callCount: 3 })`) === 3,
    'including a thread this client has never had a roster for', run(ctx, `dmCallCount('T2', { callCount: 3 })`));
  check(run(ctx, `dmCallCount('T3', null)`) === 0, 'and a missing snapshot is simply zero', run(ctx, `dmCallCount('T3', null)`));
}

console.log('\n[C] leaving a call you were the last one in clears the row');
{
  // The reported case. Snapshot says 1 (this client joined while it was the only
  // one there, and /api/dms answered before the join). dmPeerLeft drained the
  // room, which DELETES the key — the state the old `|| t.callCount` read as
  // "no live data" and therefore answered from the snapshot.
  const ctx = makeClient(`
    S.dms = [{ id: 'T1', callCount: 1 }];
    S.voiceOccupancy.set('dm:T1', [{ id: 'me' }]);
    S.voiceSince.set('dm:T1', 1);
    dmOccAnswered('T1'); // the roster that arrived on join
  `);
  check(count(ctx, 'T1') === 1, 'to begin with the row is in the call', count(ctx, 'T1'));
  run(ctx, `dmPeerLeft('T1', 'me')`);
  check(!run(ctx, `S.voiceOccupancy.has('dm:T1')`),
    'the roster key is gone, exactly as before — an empty room leaves no trace', run(ctx, `S.voiceOccupancy.has('dm:T1')`));
  check(count(ctx, 'T1') === 0, 'but the count is still zero, NOT the snapshot', count(ctx, 'T1'));
  check(run(ctx, `dmCallCount('T1', { callCount: 1 })`) === 0,
    'the row reads empty with the pre-join snapshot handed to it explicitly', run(ctx, `dmCallCount('T1', { callCount: 1 })`));
  check(run(ctx, `S.voiceSince.has('dm:T1')`) === false, 'and the call timer is gone too', run(ctx, `S.voiceSince.has('dm:T1')`));
}

console.log('\n[D] the other three ways a DM roster gets answered');
{
  // Someone joins.
  const joined = makeClient(`
    S.dms = [{ id: 'T1', callCount: 0 }];
  `);
  run(joined, `dmPeerJoined('T1', { id: 'other', display_name: 'Other' })`);
  check(count(joined, 'T1') === 1, 'a peer joining counts immediately', count(joined, 'T1'));
  check(run(joined, `S.voiceSince.has('dm:T1')`) === true, 'and starts the call timer', run(joined, `S.voiceSince.has('dm:T1')`));

  // A peer joins, then leaves: back to zero, and the snapshot said zero anyway —
  // so assert against a snapshot that would resurrect a wrong number.
  const churn = makeClient(`
    S.dms = [{ id: 'T1', callCount: 4 }];
  `);
  run(churn, `dmPeerJoined('T1', { id: 'a' })`);
  run(churn, `dmPeerLeft('T1', 'a')`);
  check(count(churn, 'T1') === 0, 'a peer leaving drains the room to zero', count(churn, 'T1'));
  check(run(churn, `dmCallCount('T1', { callCount: 4 })`) === 0, 'not back to the snapshot', run(churn, `dmCallCount('T1', { callCount: 4 })`));

  // The server announces the end of the call (afterDmVoiceChange, when the room
  // drains). This one never had a roster at all — the row was showing the
  // snapshot, and "the call is over" is exactly the answer that retires it.
  const ended = makeClient(`
    S.dms = [{ id: 'T1', callCount: 2 }];
  `);
  run(ended, `onDmCallEnded('T1')`);
  check(count(ended, 'T1') === 0, 'a call that ends clears the row', count(ended, 'T1'));
  check(run(ended, `dmCallCount('T1', { callCount: 2 })`) === 0, 'against a snapshot of two', run(ended, `dmCallCount('T1', { callCount: 2 })`));
}

console.log('\n[E] the answer is per-thread, not global');
{
  // The point of a Set keyed by thread: knowing T1 is empty says nothing about
  // T2, which may still be showing a snapshot nobody has spoken for yet. A
  // single global "we have data" flag would silence T2's badge.
  const ctx = makeClient(`
    S.dms = [{ id: 'T1', callCount: 1 }, { id: 'T2', callCount: 3 }];
  `);
  run(ctx, `dmPeerJoined('T1', { id: 'other' })`);
  run(ctx, `dmPeerLeft('T1', 'other')`);
  check(count(ctx, 'T1') === 0, 'T1 drained', count(ctx, 'T1'));
  check(run(ctx, `dmCallCount('T2', { callCount: 3 })`) === 3,
    'T2 still reads its own untouched snapshot', run(ctx, `dmCallCount('T2', { callCount: 3 })`));
  run(ctx, `dmPeerJoined('T2', { id: 'a' })`);
  run(ctx, `dmPeerJoined('T2', { id: 'b' })`);
  check(count(ctx, 'T2') === 2, 'and once T2 gets a roster, the live count takes over', count(ctx, 'T2'));
}

console.log('\n[F] the wiring: both consumers ask the one question');
{
  // Two surfaces paint this count from the same predicate. Leaving one on the
  // old expression would keep the ghost alive wherever it was left.
  check(/const callN = dmCallCount\(t\.id, t\);/.test(homeSrc),
    'the DM row reads dmCallCount (not the roster || snapshot fallback)');
  check(!/dmCallPeers\(t\.id\)\.length \|\| t\.callCount/.test(homeSrc),
    'the old || t.callCount fallback is gone from the row');
  const strip = (() => {
    const a = serversSrc.indexOf('function renderDmMembers');
    // To the next top-level function whatever it is named — the body is what
    // matters, and guessing a name here would silently slice to nothing.
    const rest = a < 0 ? '' : serversSrc.slice(a + 1);
    const m = rest.match(/\nfunction /);
    return a < 0 || !m ? '' : serversSrc.slice(a, a + 1 + m.index);
  })();
  check(strip.length > 0 && /dmCallCount\(t\.id, t\)/.test(strip),
    'the member pane\'s join strip asks the same question');
  check(strip.length > 0 && !/callPeers\.length\}/.test(strip),
    'and counts the answer, not the roster length');

  // Every route by which a DM roster can arrive must record the answer,
  // including the empty one. A missed case is a bug that only shows on that
  // path, so the list is checked rather than trusted.
  const routes = [
    ['the subscribe-time voice-peers frame', socketSrc, /if \(m\.threadId\) \{[\s\S]{0,700}?dmOccAnswered\(m\.threadId\);/],
    ['a peer leaving (voice-peer-left)', socketSrc, /case 'voice-peer-left':[\s\S]{0,400}?dmPeerLeft\(m\.threadId, m\.userId\);/],
    ['a peer joining (voice-peer-joined)', socketSrc, /case 'voice-peer-joined':[\s\S]{0,400}?dmPeerJoined\(m\.threadId, m\.peer\);/],
    ['the call ending (dm-call-ended)', socketSrc, /case 'dm-call-ended':[\s\S]{0,120}?onDmCallEnded\(m\.threadId\);/],
  ];
  for (const [name, src, re] of routes) check(re.test(src), name + ' converges on the roster helpers');
  check(/if \(occ\.length\) S\.voiceOccupancy\.set\(key, occ\);[\s\S]{0,200}?dmOccAnswered\(threadId\);/.test(voiceSrc),
    'dmPeerLeft records the answer even on the branch that DELETES the key (the reported case)');
  check(/if \(!S\.voiceSince\.has\(key\)\) S\.voiceSince\.set\(key, Date\.now\(\)\);[\s\S]{0,120}?dmOccAnswered\(threadId\);/.test(voiceSrc),
    'dmPeerJoined records it on the join path too');
  check(/if \(leftDmThread\) dmOccAnswered\(leftDmThread\);/.test(voiceSrc),
    'leaving a DM call records it — captured before S.voice is nulled');

  // The subscribe frame is the one that makes callCount redundant in the first
  // place; if it stopped arriving, the fallback would be the only signal and
  // the Set would be empty forever (silently, which is the old bug again).
  check(/for \(const \[key, set\] of voiceRooms\) \{\s*if \(!key\.startsWith\('dm:'\)\) continue;[\s\S]{0,400}?\{ t: 'voice-peers', threadId: tid/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')),
    'the server still sends a DM voice-peers frame on subscribe (the snapshot\'s replacement)');
}

console.log('\n' + (failures.length ? failures.length + ' FAILED, ' + passed + ' passed' : 'all ' + passed + ' checks passed'));
process.exit(failures.length ? 1 : 0);
