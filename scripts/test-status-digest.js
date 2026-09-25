// Friend custom-status notifications: quiet by design.
// Asserts, against the real functions extracted from server.js with stubbed deps:
//   [1] a status change sends one push (no inbox entry — the notif center stays clean)
//   [2] the status path never touches pushInbox at all
//   [3] one friend spamming status edits pings a viewer once (cooldown), latest text wins
//   [4] several friends changing status at once collapses into a single digest push
//   [5] muted viewers are skipped
//   [6] empty status text notifies nobody
//   [7] viewers who blocked the changer are skipped
// Usage: node scripts/test-status-digest.js
'use strict';
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`ok   [${name}]`); }
  else { failures.push(name); console.log(`FAIL [${name}]${detail ? ' — ' + detail : ''}`); }
}

// ---- extract the real implementation from server.js ----
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const grab = (re, what) => {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + what);
  return m[0];
};
let block = [
  grab(/const STATUS_PUSH_COOLDOWN_MS = .*?;/, 'cooldown const'),
  grab(/const STATUS_DIGEST_MS = .*?;/, 'digest const'),
  grab(/const statusDigests = .*?;/, 'digest map'),
  grab(/async function notifyFriendStatus[\s\S]*?^}/m, 'notifyFriendStatus'),
  grab(/async function flushFriendStatusDigest[\s\S]*?^}/m, 'flushFriendStatusDigest'),
].join('\n');
// shrink the windows so the test runs fast (cooldown 150ms, digest 100ms)
block = block.replace('6 * 3600e3', '150').replace('5 * 60e3', '100');

// ---- stubs ----
const pushes = [];
const friendsOf = { u1: ['v1', 'v2'], u2: ['v1'], u3: ['v1'], u4: ['v1'] };
const muted = new Set();
const blockedPairs = new Set();
const rlMap = new Map();
const db = {
  prepare(sql) {
    if (sql.includes('FROM friendships')) return { all: async (changerId) => (friendsOf[changerId] || []).map((uid) => ({ uid })) };
    if (sql.includes('FROM blocks')) return { get: async (uid, changerId) => (blockedPairs.has(uid + ':' + changerId) ? { 1: 1 } : undefined) };
    throw new Error('unexpected SQL: ' + sql);
  },
};
const notifMode = async (uid) => (muted.has(uid) ? 'muted' : 'all');
const rateHit = async (bucket, limit, windowMs) => { // fixed-window, mirrors server.js semantics
  const t = Date.now();
  let e = rlMap.get(bucket);
  if (!e || e.resetAt <= t) e = { count: 0, resetAt: t + windowMs };
  e.count += 1;
  rlMap.set(bucket, e);
  return e.count > limit ? { ok: false, retryAfter: 1 } : { ok: true, retryAfter: 0 };
};
const pushToUser = async (uid, payload, opts) => { pushes.push({ uid, payload, opts }); };
const userVisible = async () => false;
const displayOf = (u) => u.display_name || u.username;
const pushInbox = async () => { throw new Error('pushInbox must never be called for status updates'); };

const factory = new Function('db', 'notifMode', 'rateHit', 'pushToUser', 'userVisible', 'displayOf', 'pushInbox',
  block + '\nreturn { notifyFriendStatus, statusDigests };');
const { notifyFriendStatus, statusDigests } = factory(db, notifMode, rateHit, pushToUser, userVisible, displayOf, pushInbox);

const changer = (id, name) => ({ id, display_name: name, username: name.toLowerCase(), avatar_url: null });
function reset() { pushes.length = 0; rlMap.clear(); statusDigests.clear(); muted.clear(); blockedPairs.clear(); }

(async () => {
  // [1] single change -> one push per viewer, correct shape (u1's friends: v1, v2)
  reset();
  await notifyFriendStatus(changer('u1', 'Cross'), 'In a meeting');
  await sleep(250);
  check('1-single-push', pushes.length === 2, `pushes=${pushes.length}`);
  const p1 = pushes.find((p) => p.uid === 'v1');
  check('1-title', p1?.payload.title === 'Your friend Cross', pushes[0]?.payload.title);
  check('1-body', p1?.payload.body === 'Updated their status to: In a meeting', pushes[0]?.payload.body);
  check('1-tag', p1?.payload.tag === 'status-digest', pushes[0]?.payload.tag);
  check('1-url', p1?.payload.url === '/?friends=1', pushes[0]?.payload.url);
  check('1-webpush', p1?.opts?.webPush === true, JSON.stringify(pushes[0]?.opts));

  // [2] the status path never writes to the notification center
  check('2-no-inbox', !block.includes('pushInbox'), 'pushInbox referenced in status block');

  // [3] spammy changer -> one ping, latest text
  reset();
  await notifyFriendStatus(changer('u1', 'Cross'), 'edit one');
  await notifyFriendStatus(changer('u1', 'Cross'), 'edit two');
  await notifyFriendStatus(changer('u1', 'Cross'), 'edit three');
  await sleep(250);
  const v1pushes = pushes.filter((p) => p.uid === 'v1');
  check('3-cooldown-one-ping', v1pushes.length === 1, `pushes=${v1pushes.length}`);
  check('3-latest-text', v1pushes[0]?.payload.body === 'Updated their status to: edit three', v1pushes[0]?.payload.body);

  // [4] many friends at once -> one digest push
  reset();
  await notifyFriendStatus(changer('u2', 'Sam'), 'gaming');
  await notifyFriendStatus(changer('u3', 'Alex'), 'lunch');
  await notifyFriendStatus(changer('u4', 'Jo'), 'afk');
  await sleep(250);
  const dv = pushes.filter((p) => p.uid === 'v1');
  check('4-digest-one-push', dv.length === 1, `pushes=${dv.length}`);
  check('4-digest-title', dv[0]?.payload.title === '3 friends updated their status', dv[0]?.payload.title);
  check('4-digest-body', /Sam: gaming/.test(dv[0]?.payload.body || ''), dv[0]?.payload.body);

  // [5] muted viewer skipped
  reset();
  muted.add('v2');
  await notifyFriendStatus(changer('u1', 'Cross'), 'hello');
  await sleep(250);
  check('5-muted-skipped', pushes.length === 1 && pushes[0].uid === 'v1', JSON.stringify(pushes.map((p) => p.uid)));

  // [6] empty text -> nobody
  reset();
  await notifyFriendStatus(changer('u1', 'Cross'), '   ');
  await sleep(250);
  check('6-empty-no-push', pushes.length === 0, `pushes=${pushes.length}`);

  // [7] blocker skipped
  reset();
  blockedPairs.add('v1:u1');
  await notifyFriendStatus(changer('u1', 'Cross'), 'hello');
  await sleep(250);
  check('7-blocked-skipped', pushes.every((p) => p.uid !== 'v1'), JSON.stringify(pushes.map((p) => p.uid)));

  // [8] change after the cooldown expires pings again ("sometimes", not never)
  reset();
  await notifyFriendStatus(changer('u1', 'Cross'), 'morning');
  await sleep(250); // digest flushes -> ping 1
  await sleep(200); // cooldown (150ms stubbed) expires
  await notifyFriendStatus(changer('u1', 'Cross'), 'evening');
  await sleep(250); // digest flushes -> ping 2
  const v1p8 = pushes.filter((p) => p.uid === 'v1');
  check('8-cooldown-expiry-repings', v1p8.length === 2, `pushes=${v1p8.length}`);
  check('8-second-text', v1p8[1]?.payload.body === 'Updated their status to: evening', v1p8[1]?.payload.body);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
