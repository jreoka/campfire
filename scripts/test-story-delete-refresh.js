// Deleting your last story clears the sidebar's Stories row at once — and a
// /api/stories answer that was already in flight cannot put it back.
//
// The complaint: post a story, delete it, and the Home sidebar's Stories row
// still wore the poster's avatar (the row paints `storyUserTrays()[0] || the
// first server tray`) until a full page reload.
//
// The window is real and it is a race: `loadStories()` coalesces into the
// request already sitting in `storyFetch`, so the refresh a delete schedules can
// end up awaiting an answer that was requested BEFORE the delete and therefore
// still carries the deleted story. Nothing local can tell that payload apart
// from a fresh one, so the sidebar re-painted what had just been deleted, and
// only a reload (which starts from an empty in-flight slot) fixed it.
//
// This drives the REAL loadStories/scheduleStoryRefresh/storyRemoved/
// renderHomeStories out of public/js/stories.js in headless Chrome against the
// REAL markup for the Stories row, with an /api/stories that answers 400ms
// late: the test deletes 50ms in, so the first answer is definitively stale.
//
// Skips (exit 0) when Chrome is unavailable.
//
// Usage: node scripts/test-story-delete-refresh.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9372', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }
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

const src = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');
function slice(from, to) {
  const a = src.indexOf(from); const b = src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block in public/js/stories.js'); process.exit(1); }
  return src.slice(a, b);
}
// Every piece renderHomeStories() leans on, verbatim from the module.
const parts = {
  svg: slice('const svSvg = {', '\n// Trays as the API returns them'),
  live: slice('function storyLive(items)', '\nfunction storyUserTrays'),
  trays: slice('function storyUserTrays()', '\nfunction storyTrayFor'),
  counts: slice('function storyHomeCounts()', '\nfunction storyAgo'),
  misc: slice('function serverTrayUnseen(t)', '\nfunction storyAgo'),
  ago: slice('function storyAgo(ts)', '\n// ---------- data ----------'),
  data: slice('// ---------- data ----------', '\nfunction markStorySeen'),
  home: slice('function renderHomeStories()', '\n// ---------- rings on other people\'s rows ----------'),
};
// The row itself (public/index.html), so the test paints the real thing.
const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
function rowMarkup() {
  const a = index.indexOf('<div id="stories-nav-wrap">');
  const b = index.indexOf('<div id="anow-strip"', a);
  if (a < 0 || b < 0) { console.error('[test] could not find the Stories row in public/index.html'); process.exit(1); }
  return index.slice(a, b);
}

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
</head><body>
<div id="sidebar">${rowMarkup()}</div>
<script>
function $(s) { return document.querySelector(s); }
// core.js's paintAvatar, cut down to the part the row's assertion reads (the
// face it would paint). The real one is covered by its own tests.
window.S = { me: { id: 'me', username: 'me', display_name: 'Jordan' } };
function paintAvatar(el, u) { el.innerHTML = ''; el.dataset.painted = (u && (u.display_name || u.username)) || '?'; }
// The face branch is the DOM it paints; core.js's paintAvatar also empties the
// element, so 'no img and no marker' is 'nothing was painted here'.
const FRESH = { mine: null, friends: [], everyone: [], servers: [] };
// A stand-in /api/stories: every call answers 400ms later with whatever
// window.__next held when it was ASKED — the shape of a response that started
// before a mutation.
let calls = 0;
function api(url) {
  calls++;
  const body = window.__next || FRESH;
  return new Promise((res) => setTimeout(() => res(JSON.parse(JSON.stringify(body))), 400));
}
// The module-level state the sliced functions close over (public/js/stories.js
// declares these just above the data block).
let storyData = { mine: null, friends: [], everyone: [], servers: [] };
let storyFetch = null;
let storyRefreshT = null;
${parts.svg}
${parts.live}
${parts.trays}
${parts.counts}
${parts.misc}
${parts.ago}
${parts.data}
${parts.home}
window.__calls = () => calls;
window.__sidebar = () => {
  const av = document.getElementById('stories-nav-av');
  return {
    // The row's own invariant: an avatar face, or the camera mark, never both.
    painted: av.dataset.painted || null,
    // What the row actually SHOWS: the face (an <img>), the mark (an <svg> from
    // renderHomeStories' camera fallback), or nothing at all.
    img: !!av.querySelector('img'),
    camera: !!av.querySelector('svg'),
    sub: document.getElementById('stories-nav-sub').textContent,
    badge: document.getElementById('stories-nav-count').textContent,
    hidden: document.getElementById('stories-nav-count').classList.contains('hidden'),
  };
};
window.__setStory = () => {
  const me = { id: 'me', display_name: 'Jordan', username: 'me' };
  // storyView() (server.js) stamps every item with its author, which is what
  // makes the row paint a face rather than a bare mark.
  const s = { id: 's1', kind: 'image', url: 'x.png', created_at: Date.now(), expires_at: Date.now() + 72000e3, seen: true, views: 0, reactions: [], author: me };
  // A story I posted: the server puts it in the "mine" tray, and a server tray I
  // share carries my own item too (server trays include mine) — that tray is
  // what the row paints its avatar from.
  const tray = { server: { id: 'srv1', name: 'Studio', icon_url: null }, items: [s], unseen: 0, latest: s.created_at, mine: 1 };
  window.__next = { mine: { items: [s] }, friends: [], everyone: [], servers: [tray] };
  storyData = JSON.parse(JSON.stringify(window.__next));
  renderHomeStories();
};
</script>
</body></html>`;
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-storydelete-'));
  const htmlPath = path.join(dir, 'page.html');
  fs.writeFileSync(htmlPath, pageHtml());

  const child = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=900,700'], { stdio: 'ignore' });

  let ws;
  try {
    let info = null;
    for (let i = 0; i < 60 && !info; i++) {
      try { info = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); } catch { await sleep(250); }
    }
    if (!info) return skip('Chrome never opened its DevTools port');

    ws = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 128 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0; const pending = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const call = (method, params, sessionId) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
      ws.send(JSON.stringify({ id: i, sessionId, method, params }));
    });
    const targetId = (await call('Target.createTarget', { url: 'about:blank' })).targetId;
    const sessionId = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    const sess = (m, p) => call(m, p, sessionId);
    const evaluate = async (expression) => {
      const r = await sess('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'page error');
      return r.result.value;
    };

    await sess('Page.enable');
    await sess('Runtime.enable');
    await sess('Page.navigate', { url: 'file:///' + htmlPath.replace(/\\/g, '/') });
    await sleep(800);
    if (!(await evaluate('typeof renderHomeStories === "function" && typeof loadStories === "function"'))) {
      console.error('[test] the extracted story-data / sidebar code did not evaluate in the page');
      process.exit(1);
    }

    console.log('\n[1] a live story paints the row, and its delete clears it');
    const before = await evaluate('window.__setStory(); window.__sidebar()');
    check(before.painted === 'Jordan' && !before.camera, 'the row paints the poster\'s face once the story is live', before);
    check(before.sub !== 'No stories yet — be the first', 'and its label speaks about the live story', before.sub);
    // The delete path itself, with no fetch in flight: local state is dropped
    // and the row repaints from it.
    await evaluate('storyRemoved("s1"); window.__next = null');
    const afterLocal = await evaluate('window.__sidebar()');
    check(!afterLocal.img && afterLocal.camera, 'deleting the story clears the avatar at once (the mark is back)', afterLocal);
    check(afterLocal.camera, 'and the row falls back to the camera mark', afterLocal);
    check(/No stories yet/.test(afterLocal.sub), 'with the empty label back', afterLocal.sub);
    check(afterLocal.hidden, 'and no badge', afterLocal);

    console.log('\n[2] a /api/stories answer from BEFORE the delete cannot resurrect it');
    const race = await evaluate(`(async () => {
      window.__setStory();
      const painted = window.__sidebar();
      loadStories();                                    // in flight, carries the story
      await new Promise((r) => setTimeout(r, 50));
      storyRemoved('s1');                               // the user deletes inside that window
      window.__next = null;                             // the server would answer fresh now
      scheduleStoryRefresh(300);                        // the delete's own refresh
      const mid = window.__sidebar();
      await new Promise((r) => setTimeout(r, 1200));    // both answers have landed by now
      return { painted, mid, after: window.__sidebar(), mine: !!storyData.mine, servers: storyData.servers.length, calls: window.__calls() };
    })()`);
    check(!race.after.img && race.after.camera, 'the row does not repaint the deleted story\'s avatar', race.after);
    check(race.after.camera, 'it keeps the camera fallback', race.after);
    check(/No stories yet/.test(race.after.sub) && race.after.hidden,
      'and the sidebar keeps saying nothing is live (this is what used to need a reload)', race.after);
    check(!race.mine && race.servers === 0, 'and the stale payload never replaced the live state', race);
    check(race.calls >= 2, 'the delete asked the server again instead of reusing the old answer', race);

    console.log('\n[3] a fresh answer still lands (the guard is not a latch)');
    const fresh = await evaluate(`(async () => {
      window.__next = null;
      await loadStories(true);
      const empty = window.__sidebar();
      window.__setStory();
      window.__next = { mine: null, friends: [], everyone: [], servers: [] };
      await loadStories(true);
      return { empty, after: window.__sidebar() };
    })()`);
    check(!fresh.empty.img && fresh.empty.camera, 'a fresh empty answer clears the row', fresh.empty);
    // A later mutation on the server (someone else posts) still reaches the row:
    // the generation guard must only drop answers older than the last mutation.
    const later = await evaluate(`(async () => {
      const friend = { id: 'f1', display_name: 'Ada', username: 'ada' };
      const s = { id: 's9', kind: 'image', url: 'y.png', created_at: Date.now(), expires_at: Date.now() + 72000e3, seen: false, views: 0, reactions: [], author: friend };
      window.__next = { mine: null, friends: [{ user: friend, items: [s], unseen: 1, latest: s.created_at }], everyone: [], servers: [] };
      await loadStories(true);
      renderStorySurfaces();
      return window.__sidebar();
    })()`);
    check(later.painted === 'Ada', 'and the next live story paints again (the guard is per-mutation)', later);
    check(later.badge === '1' && !later.hidden, 'with its unseen badge', later);
  } catch (e) {
    console.error('[test] ' + (e && e.message));
    process.exit(1);
  } finally {
    try { ws && ws.close(); } catch {}
    try { child.kill(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}
main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
