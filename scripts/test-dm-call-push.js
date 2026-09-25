// Incoming 1:1 DM calls buzz the phone, not just open tabs.
// Asserts, against the real pushDmCallIncoming extracted from server.js with
// stubbed deps:
//   [1] a 1:1 voice call pushes once: caller name title, "Incoming voice call"
//       body, dm-call:<thread> tag, /?dm=<thread> url, requireInteraction
//   [2] a video call says "Incoming video call"
//   [3] group DMs never push (no lighting up everyone's phone)
//   [4] muted recipients are skipped
//   [5] a recipient who's already looking gets webPush suppressed (the in-app
//       banner covers them) — the payload still goes to pushToUser so native
//       push sockets on their other devices ring
//   [6] the voice-join handler actually calls it on first-join (wasEmpty)
// Usage: node scripts/test-dm-call-push.js
'use strict';
const fs = require('fs');
const path = require('path');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`ok   [${name}]`); }
  else { failures.push(name); console.log(`FAIL [${name}]${detail ? ' — ' + detail : ''}`); }
}

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const grab = (re, what) => {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + what);
  return m[0];
};

// ---- stubs (assigned before the extracted code runs) ----
const calls = [];            // pushToUser calls: { uid, payload, opts }
const muted = new Set();     // uids with the DM muted
const visible = new Set();   // uids with a visible page
async function notifMode(uid, scopes) { return muted.has(uid) ? 'muted' : 'all'; }
async function userVisible(uid) { return visible.has(uid); }
async function pushToUser(uid, payload, opts) { calls.push({ uid, payload, opts }); }

const block = [
  grab(/function displayOf\(u\) \{.*?\}/, 'displayOf'),
  grab(/async function pushDmCallIncoming[\s\S]*?^}/m, 'pushDmCallIncoming'),
].join('\n');
const fn = new Function('notifMode', 'userVisible', 'pushToUser',
  `${block}\nreturn pushDmCallIncoming;`)(notifMode, userVisible, pushToUser);
const pushDmCallIncoming = fn;

const caller = { userId: 'u1', username: 'cross', display_name: 'Cross', avatar_url: 'https://x/y.png' };
const thread = { id: 't1', is_group: 0 };

(async () => {
  // [1] 1:1 voice call -> one push with the call payload
  calls.length = 0;
  await pushDmCallIncoming(thread, caller, false, ['u2']);
  check('voice-push-once', calls.length === 1, `calls=${calls.length}`);
  const p = calls[0] && calls[0].payload;
  check('voice-title', p && p.title === 'Cross', `title=${p && p.title}`);
  check('voice-body', p && p.body === 'Incoming voice call', `body=${p && p.body}`);
  check('voice-tag', p && p.tag === 'dm-call:t1', `tag=${p && p.tag}`);
  check('voice-url', p && p.url === '/?dm=t1', `url=${p && p.url}`);
  check('voice-sticky', p && p.requireInteraction === true, 'requireInteraction missing');
  check('voice-icon', p && p.icon === 'https://x/y.png', `icon=${p && p.icon}`);
  check('voice-webpush', calls[0].opts && calls[0].opts.webPush === true, `webPush=${calls[0].opts && calls[0].opts.webPush}`);

  // [2] video call wording
  calls.length = 0;
  await pushDmCallIncoming(thread, caller, true, ['u2']);
  check('video-body', calls.length === 1 && calls[0].payload.body === 'Incoming video call',
    `body=${calls[0] && calls[0].payload.body}`);

  // [3] group DM -> silence
  calls.length = 0;
  await pushDmCallIncoming({ id: 'g1', is_group: 1 }, caller, false, ['u2', 'u3']);
  check('group-silent', calls.length === 0, `calls=${calls.length}`);

  // [4] muted recipient skipped
  calls.length = 0; muted.add('u2');
  await pushDmCallIncoming(thread, caller, false, ['u2']);
  check('muted-silent', calls.length === 0, `calls=${calls.length}`);
  muted.delete('u2');

  // [5] visible recipient: still fan out (native sockets ring), web push off
  calls.length = 0; visible.add('u2');
  await pushDmCallIncoming(thread, caller, false, ['u2']);
  check('visible-fanout', calls.length === 1, `calls=${calls.length}`);
  check('visible-webpush-off', calls.length === 1 && calls[0].opts.webPush === false,
    `webPush=${calls[0] && calls[0].opts.webPush}`);
  visible.delete('u2');

  // [6] wiring: voice-join calls it when the room was empty
  check('wired-wasEmpty',
    /if \(wasEmpty\) \{[\s\S]*?await pushDmCallIncoming\(t, me, !!msg\.video, others\);/.test(src),
    'pushDmCallIncoming not called in wasEmpty block');

  if (failures.length) { console.error(`\n${failures.length} FAILURES: ${failures.join(', ')}`); process.exit(1); }
  console.log(`\n${passed} passed`);
})();
