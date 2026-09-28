// Web Push on iPhone: the server sent the payload, Apple's push service refused
// it, and the settings screen said "Test push sent" anyway.
//
// The bug this covers: the VAPID `sub` claim defaulted to
// `mailto:notifications@localhost`, and Apple's push service (web.push.apple.com)
// answers a localhost subject with `403 BadJwtToken` on EVERY send. So an
// iPhone could subscribe, allow the permission prompt, be told the test push was
// sent — and never show anything, for as long as the account existed. Only
// 404/410 were ever pruned, so the healthy subscription sat in push_subs being
// rejected forever, and the only trace was a bare "403" in the container log
// with nothing to point at the subject.
//
// What this asserts:
//   [1] the subject is never a localhost address (Apple rejects those outright)
//   [2] with no PUSH_SUBJECT it falls back to the deployment's own site URL,
//       which is a real https: address — not a mailto: at nobody's domain
//   [3] an explicit PUSH_SUBJECT still wins, and still cannot smuggle a
//       localhost back into the handshake
//   [4] a 403 is NOT pruned (the device is fine, the config was not) while
//       404/410 still are
//   [5] a 403 is reported in words, not as a bare status code
//   [6] /api/push/test reports the SEND's fate — "no subscription" and
//       "the push service refused it" are two different answers
//   [7] the client no longer claims success unconditionally
//
// Offline where it can be: the subject resolver is run for real against a real
// child process, and the rest is source-level. Usage: node scripts/test-push-vapid-subject.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}

// The real resolver, lifted out of server.js and run in a child process with a
// chosen environment. server.js cannot be required here (it opens a port and
// wants a database), so the function body is sliced from the real source and
// evaluated for real — a test that hard-codes its own copy of the logic would
// pass against a bug it does not have.
function resolverSource() {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = server.indexOf('function vapidSubject() {');
  if (start < 0) throw new Error('vapidSubject() is missing from server.js');
  const end = server.indexOf('\nlet VAPID_SUBJECT', start);
  if (end < 0) throw new Error('vapidSubject() has no terminator in server.js');
  return 'const ORIGIN = process.env.ORIGIN || "";\nconst console_ = console;\n'
    + server.slice(start, end)
    + '\nprocess.stdout.write(vapidSubject());';
}

function runSubject(env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', resolverSource()], { env: { ...process.env, ...env } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ subject: out.trim(), err, code }));
  });
}

(async () => {
  console.log('[1] the real vapidSubject() resolver');
  let r = await runSubject({ PUSH_SUBJECT: '', DOMAIN: 'campfire.dill.moe', ORIGIN: '' });
  check(r.subject === 'https://campfire.dill.moe', 'no PUSH_SUBJECT falls back to the site URL', r.subject);

  r = await runSubject({ PUSH_SUBJECT: '', DOMAIN: '', ORIGIN: 'https://chat.example.com/' });
  check(r.subject === 'https://chat.example.com', 'ORIGIN is used (and its scheme/trailing slash stripped) when DOMAIN is empty', r.subject);

  r = await runSubject({ PUSH_SUBJECT: 'mailto:me@example.com', DOMAIN: 'campfire.dill.moe', ORIGIN: '' });
  check(r.subject === 'mailto:me@example.com', 'an explicit PUSH_SUBJECT still wins', r.subject);

  console.log('\n[2] a localhost subject can never reach Apple');
  for (const bad of ['https://localhost', 'https://localhost:3000', 'https://127.0.0.1', 'https://[::1]/']) {
    r = await runSubject({ PUSH_SUBJECT: bad, DOMAIN: 'campfire.dill.moe', ORIGIN: '' });
    check(!/localhost|127\.0\.0\.1|\[::1\]/.test(r.subject) || /^mailto:/.test(r.subject),
      'rejected: ' + bad, r.subject);
  }
  r = await runSubject({ PUSH_SUBJECT: 'https://localhost', DOMAIN: 'campfire.dill.moe', ORIGIN: '' });
  check(/mail[mn]to|subject/i.test(r.err), 'the operator is told why it was overridden', r.err.split('\n')[0]);

  console.log('\n[3] the server wires the resolver and reports the subject');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  check(/VAPID_SUBJECT = vapidSubject\(\)/.test(server), 'initPushKeys() uses the resolver');
  check(/webpush\.setVapidDetails\(VAPID_SUBJECT,/.test(server), 'the resolved subject is what signs the JWT');
  check(!/setVapidDetails\(process\.env\.PUSH_SUBJECT \|\| 'mailto:notifications@localhost'/.test(server),
    'the old localhost default is gone');
  check(/console\.log\('\[push\] web push subject /.test(server), 'the subject is logged at boot (so a bad one is visible)');

  console.log('\n[4] a 403 is not mistaken for a dead subscription');
  const pushToUser = server.slice(server.indexOf('async function pushToUser('), server.indexOf('function reEsc('));
  const prune = pushToUser.match(/if \(code === 404 \|\| code === 410\)[\s\S]{0,200}?run\(s\.endpoint\)/);
  check(!!prune, '404/410 is still pruned');
  check(!/BadJwtToken[\s\S]{0,240}DELETE FROM push_subs/.test(pushToUser),
    'a 403/BadJwtToken does NOT delete the subscription (the device is fine; the config was not)');
  check(/BadJwtToken[\s\S]{0,300}PUSH_SUBJECT/.test(pushToUser),
    'a 403 is logged in words, naming the subject — not a bare "403"');
  check(/return \{ delivered: sockets \+ results\.length - errors\.length, failed: errors\.length/.test(pushToUser),
    'pushToUser returns what the send actually did');

  console.log('\n[5] /api/push/test reports the send, not the request');
  const testRoute = server.slice(server.indexOf("app.post('/api/push/test'"), server.indexOf("app.get('/api/notifs/prefs'"));
  check(/const r = await pushToUser\(/.test(testRoute), 'the route waits for the fan-out');
  check(!/res\.json\(\{ ok: true \}\);/.test(testRoute), 'it no longer answers ok:true unconditionally');
  check(/reason: 'not_subscribed'/.test(testRoute), '"nothing is subscribed here" is its own answer');
  check(/reason: 'rejected'/.test(testRoute) && /status\(502\)/.test(testRoute),
    'a refused push is a failure, not a success');

  console.log('\n[6] the client stops claiming success');
  const settings = fs.readFileSync(path.join(ROOT, 'public/js/settings.js'), 'utf8');
  check(/async function pushTestReport\(\)/.test(settings), 'one place decides what the button may say');
  check(!/toast\('Test push sent'\)[\s\S]{0,80}catch \{ toast\('Test failed'\) \}/.test(settings),
    'the unconditional "sent" toast is gone');
  check(/body\.error === 'not_subscribed'/.test(settings), 'the client explains an unsubscribed device');
  check(/errors\[0\]\.detail/.test(settings), 'the client shows the server\'s explanation');
  const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
  check(/err\.body = data;/.test(core), 'api() carries the parsed body on the error (the detail was being dropped)');
  check(/err\.body = data;/.test(core) && /const body = \(e && e\.body\)/.test(settings),
    'and the caller reads it from where it actually is');

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  process.exit(0);
})();
