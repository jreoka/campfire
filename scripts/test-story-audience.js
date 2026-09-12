// Stories can no longer be posted to everyone on the instance.
//
// Owner ask: keep friends, whole servers and specific friends — drop the
// instance-wide option. The composer's picker loses the row, the client stops
// sending it, and the server refuses to create one (an old cached client that
// still asks gets a loud 400 instead of being silently re-targeted at friends).
// Reading stays intact on both sides: a row posted before this change keeps
// reaching its viewers until its 24h run out, instead of vanishing early.
//
// Offline: the REAL `normStoryAudiences` is sliced out of server.js and run
// against the shapes a client can send (including the two legacy ones), plus
// static checks on the post route, the client's post body and the picker. Then
// the REAL `renderStoryAudience` is sliced out of public/js/stories.js and
// driven against the real `#sc-pick` markup and stylesheet in headless Chrome
// (skips without Chrome): the menu lists friends, servers and specific friends
// and does not contain an "Everyone" row at all.
//
// Usage: node scripts/test-story-audience.js

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
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}
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

const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const stories = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');
const auth = fs.readFileSync(path.join(ROOT, 'public/js/auth.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

// ---------- the real audience normalizer ----------
const normCode = slice(server, 'function normStoryAudiences(body) {', '\nasync function storyShares(');
// eslint-disable-next-line no-eval
const { normStoryAudiences } = eval(normCode + '\n;({ normStoryAudiences })');

// ---------- the real audience menu ----------
const menuSrc = slice(stories, 'function renderStoryAudience() {', '\nfunction storyProgress(pct) {');
if (!/function renderStoryAudience/.test(menuSrc)) {
  console.error('[test] the extracted renderStoryAudience block is incomplete');
  process.exit(1);
}
const svgSrc = slice(stories, 'const svSvg = {', '};') + '};';
const countSrc = slice(stories, 'function storyAudCount() {', 'function renderStoryAudience() {');

function pageHtml() {
  const pick = (/<div class="sc-pick hidden" id="sc-pick">[\s\S]*?<div id="sc-pick-list" class="sc-pick-list"><\/div>/.exec(index) || [''])[0];
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css"></head><body>
${pick}
<script>
window.$ = (s) => document.querySelector(s);
window.paintAvatar = () => {};
window.S = { friends: { friends: [{ id: 'f1', display_name: 'Ada', username: 'ada' }, { id: 'f2', display_name: 'Bo', username: 'bo' }] },
  servers: [{ id: 's1', name: 'Studio' }, { id: 's2', name: 'Treehouse' }] };
window.sc = { audFriends: true, audServers: ['s1'], audUsers: ['f2'], vo: false, voIds: [] };
${svgSrc}
${countSrc}
${menuSrc}
try {
const out = {};
renderStoryAudience(); // the composer paints the menu when the step opens
out.rows = [...document.querySelectorAll('#sc-pick-list .sc-pick-row')].map((b) => ({
  name: (b.querySelector('.sc-pick-name') || {}).textContent || '',
  sub: (b.querySelector('.sc-pick-sub') || {}).textContent || '',
  on: b.classList.contains('on'),
  pressed: b.getAttribute('aria-pressed'),
}));
out.sections = [...document.querySelectorAll('#sc-pick-list .sc-pick-sec')].map((e) => e.textContent);
out.text = document.getElementById('sc-pick-list').textContent;
out.hasCheck = [...document.querySelectorAll('#sc-pick-list .sc-pick-row')].every((b) => !!b.querySelector('.sc-pick-check svg'));
// Toggling "All friends" flips that row and nothing else.
const allFriends = [...document.querySelectorAll('.sc-pick-row')].find((b) => /All friends/.test(b.textContent));
allFriends.click();
out.afterToggle = {
  audFriends: window.sc.audFriends,
  rows: [...document.querySelectorAll('#sc-pick-list .sc-pick-row')].map((b) => b.classList.contains('on')),
};
allFriends.click();
out.restored = window.sc.audFriends;
// Discarding "All friends" + both servers leaves only the private friend → the
// post is a view-once DM, never an instance-wide broadcast.
window.sc.audFriends = false; window.sc.audServers = []; window.sc.audUsers = ['f2'];
document.title = JSON.stringify(out);
} catch (e) { document.title = JSON.stringify({ error: String((e && e.message) || e) }); }
</script></body></html>`;
}

function main() {
  console.log('\n[1] the server refuses to create an instance-wide post');
  const everyone = normStoryAudiences({ friends: false, everyone: true, servers: [], users: [] });
  check(!everyone.everyone && !everyone.friends && !everyone.servers.length && !everyone.users.length, 'everyone:true yields no audience (→ 400 pick_audience)', everyone);
  const legacyEveryone = normStoryAudiences({ audience: 'everyone' });
  check(!legacyEveryone.friends && !legacyEveryone.servers.length && !legacyEveryone.users.length, 'the oldest single-target shape yields none either', legacyEveryone);
  check(!('everyone' in everyone), 'the normalizer has no everyone field left at all', Object.keys(everyone));

  console.log('\n[2] the audiences that stay');
  const f = normStoryAudiences({ friends: true });
  check(f.friends === true && !f.servers.length, 'friends', f);
  const s = normStoryAudiences({ friends: true, servers: ['s1', 's1', 's2'], users: [] });
  check(s.friends && s.servers.join(',') === 's1,s2', 'friends + servers, deduped', s);
  const u = normStoryAudiences({ users: ['u1', 'u1'] });
  check(u.users.length === 1 && !u.friends && !u.servers.length, 'specific friends only (no implicit friends broadcast)', u);
  const empty = normStoryAudiences({ friends: false, servers: [], users: [] });
  check(!empty.friends && !empty.servers.length && !empty.users.length, 'nothing picked → nothing (→ 400)', empty);
  // The legacy shapes an older client may still send must keep working.
  check(normStoryAudiences({ audience: 'friends' }).friends === true, 'legacy audience:"friends" still means friends');
  check(normStoryAudiences({ audience: 'server', serverId: 's9' }).servers.join(',') === 's9', 'legacy audience:"server" + serverId still works');
  check(normStoryAudiences({}).friends === true, 'an empty legacy body still defaults to friends');
  // …but a body that names audiences and picks none must NOT fall back.
  const named = normStoryAudiences({ friends: false, servers: [], users: [], audience: 'friends' });
  check(!named.friends, 'a modern body with nothing selected never falls back to friends', named);

  console.log('\n[3] the route and the client agree');
  check(/if \(!aud\.friends && !servers\.length && !users\.length\) return res\.status\(400\)\.json\(\{ error: 'pick_audience' \}\)/.test(server), 'the post route 400s when no audience survives');
  check(!/aud\.everyone/.test(server), 'the post route no longer reads an everyone flag');
  check(!/insShare\.run\(uid\(\), id, 'everyone'/.test(server), 'and writes no everyone share row');
  check(/normStoryAudiences/.test(server) && !/out\.everyone/.test(server), 'the normalizer dropped the field');
  check(/pick_audience: 'Pick who can see it/.test(auth), 'the client explains that 400 in words');
  check(!/audEveryone/.test(stories), 'the composer has no everyone state left');
  check(!/everyone: !!st\.audEven/.test(stories) && !/everyone:/.test(slice(stories, 'const r = await api(\'/api/stories\'', 'story = r.story')), 'and sends no everyone key when posting');
  check(/sc\.audFriends \? 1 : 0\) \+ \(sc\.audServers \|\| \[\]\)\.length \+ \(sc\.audUsers \|\| \[\]\)\.length/.test(stories), 'the audience count sums friends + servers + friends only');
  check(/return !!\(sc && \(sc\.audFriends \|\| \(sc\.audServers \|\| \[\]\)\.length\)\)/.test(stories), '"broadcast vs private DM" ignores everyone too');

  console.log('\n[4] posts from before this change still read back');
  check(/storyData = \{ mine: null, friends: \[\], everyone: \[\], servers: \[\] \}/.test(stories), 'the client still takes an everyone tray from the API');
  check(/add\(storyData\.everyone, false\)/.test(stories), 'and merges it into the people-based rail');
  check(/conds\.push\("a\.kind = 'everyone'"\)/.test(server), 'the server still selects everyone rows');
  check(/if \(a\.kind === 'everyone'\) return true; \/\/ legacy instance-wide row/.test(server), 'visibility still understands the kind');
  check(/shared\.everyone\) bits\.push\('Everyone'\)/.test(stories), 'an old post still says who could see it');

  const chrome = findChrome();
  if (!chrome) {
    console.log('\n[test] SKIP browser half: no Chrome/Edge found (set CHROME_PATH)');
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-story-aud-'));
    try {
      const htmlPath = path.join(dir, 'page.html');
      fs.writeFileSync(htmlPath, pageHtml());
      const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
        '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=420,760',
        '--virtual-time-budget=2500', '--dump-dom', 'file:///' + htmlPath.replace(/\\/g, '/')],
        { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
      if (!m) {
        check(false, 'the audience-menu harness ran', { status: r.status });
      } else {
        const out = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
        console.log('\n[5] the menu itself (headless Chrome)');
        if (out.error) {
          check(false, 'the audience-menu harness ran', out.error);
        } else {
        check(out.sections.join('|') === 'AUDIENCE|SERVERS|SEND PRIVATELY', 'the sections are audience / servers / private friends', out.sections);
        check(out.rows.map((x) => x.name).join('|') === 'All friends|Studio|Treehouse|Ada|Bo', 'and the rows are exactly friends, the servers, and the friends list', out.rows.map((x) => x.name));
        check(!out.rows.some((r) => r.name === 'Everyone' || /Any account on this Campfire/.test(r.sub)), 'no row offers the instance-wide audience', out.rows);
        check(out.rows[0].on && out.rows[0].pressed === 'true' && out.rows[3].on === false, 'the rows reflect what is picked', out.rows.map((x) => x.on));
        check(out.hasCheck, 'every row keeps its tick');
        check(out.afterToggle.audFriends === false && out.afterToggle.rows[0] === false && out.afterToggle.rows[1] === true, 'tapping All friends turns just that row off', out.afterToggle);
        check(out.restored === true, 'and tapping it again turns it back on');
        check(/'Everyone in this server'|'Any account/.test(stories) && /'Everyone in this server'/.test(stories), 'the server rows still read "Everyone in this server" (room scope, not a broadcast)');
        }
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
}

main();
