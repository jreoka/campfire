// Is the change actually LIVE? Compares the bytes the deployed site serves for
// the files the pasted-picture change lives in against the working tree, so a
// deploy that half-landed (a stale container, a CDN copy, a commit that was
// never pulled) cannot pass for a working feature.
//
//   node scripts/check-pasted-picture-live.js [https://campfire.dill.moe]
//
// Only reads. The site's /api/version fingerprint is the cache-buster index.html
// uses for its <script> tags, and it is asked for in the same breath, so a
// mismatch names the served version and this checkout's HEAD together — enough
// to tell "stale deploy" from "uncommitted edit". Exits 1 on any difference.
//
// The rendered result needs a real account to look at, and registration is
// captcha-walled, so this is the strongest check available without one: it
// proves the exact source that passed scripts/test-image-link-text.js is the
// exact source a browser is running. Run that test too.
'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');

const BASE = (process.argv[2] || 'https://campfire.dill.moe').replace(/\/+$/, '');
const FILES = ['public/embeds.js', 'public/js/core.js', 'public/js/messages.js'];

let failed = 0;
let version = '';
const check = (cond, name, detail) => {
  if (cond) console.log('  ok   ' + name);
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);

(async () => {
  console.log('\n[live] ' + BASE);
  const served = {};
  try {
    version = (await (await fetch(BASE + '/api/version')).json()).version;
  } catch (e) {
    console.log('  FAIL the site did not answer /api/version — ' + e.message);
    return finish();
  }
  check(!!version, 'the site answers with a build fingerprint', version);

  for (const f of FILES) {
    const url = BASE + '/' + f.replace(/^public\//, '') + '?v=' + version;
    let body;
    try { body = Buffer.from(await (await fetch(url)).arrayBuffer()); }
    catch (e) { check(false, 'fetched ' + f, e.message); continue; }
    served[f] = body;
    let local = null;
    try { local = require('fs').readFileSync(f); } catch {}
    check(!!local && sha(local) === sha(body),
      'served bytes are this checkout’s ' + f,
      local ? 'served ' + sha(body) + ' vs local ' + sha(local) : 'no local file');
  }

  // The rule the change is built on, read out of the SERVED file, not the
  // working tree: one predicate, shared by the embed pass and the text pass.
  const embeds = served['public/embeds.js'] ? served['public/embeds.js'].toString() : '';
  const core = served['public/js/core.js'] ? served['public/js/core.js'].toString() : '';
  const msgs = served['public/js/messages.js'] ? served['public/js/messages.js'].toString() : '';
  check(/function isDirectImageUrl\(/.test(embeds) && /isDirectImageUrl\(url\)/.test(embeds),
    'LIVE embeds.js carries the shared picture rule');
  check(/data-fb-img=/.test(embeds), 'LIVE embeds.js marks the picture with its URL');
  check(/isDirectImageUrl/.test(core) && /data-fb-img-text/.test(core),
    'LIVE core.js drops the anchor and marks the text it dropped it from');
  check(/function keepEmbedFor\(/.test(msgs) && /addEventListener\('error'/.test(msgs),
    'LIVE messages.js builds the card and hands the link back when the picture is dead');
  finish();
})();

function finish() {
  let head = 'unknown';
  try { head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { /* a checkout is not required to read the site */ }
  console.log('  (served fingerprint ' + (version || '?') + ', this checkout ' + head + ')');
  console.log('\n' + (failed ? 'FAILED (' + failed + ')' : 'the change is live'));
  process.exit(failed ? 1 : 0);
}
