// The story center: Home → Stories is a full page, not a strip.
//
// Owner ask: drop the story widget above the Friends list, and turn the
// sidebar's Stories row into a real story area — your story with its numbers,
// then everyone else's, in the main panel like a chat area.
//
// Offline: the rail and its tile helper are gone from the markup and the module,
// the Stories row opens the page (the server sidebar's row keeps its compact
// sheet), `renderDmBlank` routes through `paintHomePanel` so the header, the nav
// highlight and the two panels always agree, and every path that hides the
// Friends panel hides the story page with it.
//
// Headless Chrome (skips without it): the REAL `renderStoriesPage` (sliced out
// of public/js/stories.js) against the REAL `#stories-page` markup and
// stylesheet — the hero carries your post count, views, reactions and hours
// left and opens your story; one portrait card per person, unseen ones first
// under their own heading, each opening that person; a server strip; a clean
// empty state when nothing is live; and the wall really is a multi-column grid
// on a desktop-width panel. Writes campfire-story-center.png to the temp dir.
//
// Usage: node scripts/test-story-center.js

'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9361', 10);
const E2E_DB = 'campfire_story_center_e2e';
const E2E_PORT = parseInt(process.env.TEST_PORT || '3431', 10);
const E2E_CDP_PORT = parseInt(process.env.TEST_CDP_PORT2 || '9362', 10);

function readEnvFile() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const stories = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');
const pins = fs.readFileSync(path.join(ROOT, 'public/js/pins.js'), 'utf8');
const home = fs.readFileSync(path.join(ROOT, 'public/js/home.js'), 'utf8');
const voice = fs.readFileSync(path.join(ROOT, 'public/js/voice.js'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

const centerSrc = slice(stories, '// ---------- story center (Home → Stories) ----------', '\n// ---------- server sidebar row + Home sidebar entry ----------');
const svgSrc = slice(stories, 'const svSvg = {', '};') + '};';
const agoSrc = slice(stories, 'function storyAgo(ts) {', '\n// ---------- data ----------');
if (!/function renderStoriesPage/.test(centerSrc) || !/function spHero/.test(centerSrc) || !/function spCard/.test(centerSrc)) {
  console.error('[test] the extracted story-center block is incomplete');
  process.exit(1);
}
const pageMarkup = slice(index, '<div id="stories-page" class="hidden">', '<div id="stage"');

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style>
<style>html,body{margin:0;background:var(--bg)}#chat{width:900px;height:760px;display:flex;flex-direction:column}</style>
</head><body><div id="chat">
${pageMarkup.replace('class="hidden"', '')}
<script>
window.$ = (s) => document.querySelector(s);
window.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
window.S = { me: { id: 'me', username: 'me', display_name: 'Jordan' }, homePanel: 'stories' };
window.paintAvatar = (el, u) => { el.classList.add('avatar'); el.dataset.who = (u && (u.display_name || u.username)) || '?'; };
// Stand-ins for the pieces the center leans on (each covered by its own test).
window.storyThumbEl = (it, cls) => {
  if (!it) return null;
  const img = document.createElement('img');
  img.className = cls || 'st-thumb';
  img.dataset.kind = it.kind || 'image';
  img.src = it.url;
  return img;
};
window.storyThumbItem = (items) => (items || [])[items.length - 1] || null;
window.openStoryViewer = (o) => { window.__calls.push(['viewer', o]); };
window.openStoryComposer = (o) => { window.__calls.push(['composer', o]); };
window.__calls = [];
window.api = () => Promise.resolve({ viewers: [{ id: 'v1', display_name: 'Ada' }, { id: 'v2', display_name: 'Bo' }, { id: 'v3', display_name: 'Cy' }] });
window.storyViewersModal = (it) => { window.__calls.push(['viewers', it.id]); return Promise.resolve(true); };
${svgSrc}
${agoSrc}
${centerSrc}
let storyData = { mine: null, friends: [], everyone: [], servers: [] };
const storyLive = (items) => (items || []).filter((s) => s.expires_at > Date.now());
const now = Date.now();
function item(o) { return Object.assign({ id: 's' + Math.random().toString(36).slice(2, 7), kind: 'image', url: 'x.png', created_at: now - 3600e3, expires_at: now + 72000e3, seen: false, views: 0, reactions: [] }, o); }
function user(id, name) { return { id, username: id, display_name: name, avatar_color: '#5865f2' }; }
// Trays look like storyUserTrays() output, id included (the card opens by it).
function mkTray(u, items, unseen, latest) { return { id: u.id, user: u, items, unseen, latest }; }
window.__seed = function (scenario) {
  storyData = { mine: null, friends: [], everyone: [], servers: [] };
  if (scenario === 'full') {
    storyData.mine = { items: [item({ views: 7 }), item({ views: 5, created_at: now - 600e3, expires_at: now + 80000e3, reactions: [{ emoji: '🔥', count: 2 }] })] };
    storyData.friends = [
      mkTray(user('f1', 'Ada'), [item({}), item({ created_at: now - 2400e3 })], 2, now - 2400e3),
      mkTray(user('f2', 'Bo'), [item({ seen: true })], 0, now - 5400e3),
      mkTray(user('f3', 'Cy'), [item({ seen: true })], 0, now - 9000e3),
    ];
    storyData.servers = [{ server: { id: 'srv1', name: 'Studio', icon_url: null }, items: [item({})], unseen: 1, latest: now - 1200e3, mine: 0 }];
  } else if (scenario === 'seen') {
    storyData.friends = [mkTray(user('f2', 'Bo'), [item({ seen: true })], 0, now - 5400e3)];
  } else if (scenario === 'empty') {
    storyData.mine = null;
  }
  window.storyData = storyData;
  window.storyUserTrays = () => storyData.friends;
  window.serverTrayUnseen = (t) => (t && t.unseen) || 0;
  renderStoriesPage();
};
window.__out = function () {
  const page = document.getElementById('stories-page');
  const hero = page.querySelector('.sp-hero');
  const cards = [...page.querySelectorAll('.sp-card')];
  const sections = [...page.querySelectorAll('.sp-sec')].map((e) => e.textContent);
  const grid = page.querySelector('.sp-grid');
  const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0;
  const cr = cards[0] ? cards[0].getBoundingClientRect() : null;
  const cs = cards[0] ? getComputedStyle(cards[0]) : null;
  return {
    sub: (document.getElementById('sp-sub') || {}).textContent || '',
    hero: hero ? {
      title: (hero.querySelector('.sp-hero-title') || {}).textContent,
      sub: (hero.querySelector('.sp-hero-sub') || {}).textContent,
      chips: [...hero.querySelectorAll('.sp-chip')].map((c) => c.textContent.trim()),
      hasMedia: !!hero.querySelector('.sp-hero-media'),
      btns: [...hero.querySelectorAll('.sp-hero-btns button')].map((b) => b.textContent),
      h: Math.round(hero.getBoundingClientRect().height),
      empty: hero.classList.contains('sp-hero-empty'),
    } : null,
    sections,
    cards: cards.map((c) => ({
      name: (c.querySelector('.sp-card-name') || {}).textContent,
      new: (c.querySelector('.sp-card-new') || {}).textContent || '',
      ago: (c.querySelector('.sp-card-ago') || {}).textContent,
      seen: c.classList.contains('seen'),
      hasMedia: !!c.querySelector('.sp-card-media'),
    })),
    cols,
    portrait: cr && cs ? { ratio: Math.round((cr.height / cr.width) * 100) / 100, radius: cs.borderRadius } : null,
    servers: [...page.querySelectorAll('.sp-srv')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim()),
    empty: !!page.querySelector('.sp-empty'),
    note: (page.querySelector('.sp-note') || {}).textContent || '',
    heroViewers: (() => { const v = page.querySelector('.sp-hero-viewers'); return v ? { hidden: v.classList.contains('hidden'), text: v.textContent, avs: v.querySelectorAll('.avatar').length } : null; })(),
  };
};
</script></body></html>`;
}

async function e2e() {
  const envFile = readEnvFile();
  const pg = {
    host: process.env.PGHOST || envFile.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || envFile.POSTGRES_USER || 'campfire',
    password: process.env.PGPASSWORD || envFile.POSTGRES_PASSWORD || '',
  };
  const admin = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
  try { await admin.connect(); }
  catch { console.log('\n[test] SKIP app half: Postgres unreachable — docker compose up -d db'); return; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-story-center-e2e-'));
  const uploads = path.join(dir, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  let child = null, chrome = null, ws = null;
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${E2E_DB}`);
    await admin.end();
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(E2E_PORT),
        PGHOST: pg.host, PGPORT: String(pg.port), PGUSER: pg.user, PGPASSWORD: pg.password, PGDATABASE: E2E_DB,
        JWT_SECRET: 'test-story-center-secret', UPLOAD_DIR: uploads, UNFURL: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${E2E_PORT}/api/config`)).ok; } catch {}
      if (!up) await sleep(250);
    }
    if (!up) throw new Error('server did not come up\n' + serverLog.slice(-1500));

    chrome = spawn(findChrome(), ['--headless=new', `--remote-debugging-port=${E2E_CDP_PORT}`, '--user-data-dir=' + path.join(dir, 'chrome'),
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--window-size=1100,860', 'about:blank'], { stdio: 'ignore' });
    let ver = null;
    for (let i = 0; i < 80 && !ver; i++) {
      try { ver = await (await fetch(`http://127.0.0.1:${E2E_CDP_PORT}/json/version`)).json(); } catch {}
      if (!ver) await sleep(250);
    }
    if (!ver) throw new Error('Chrome did not expose the DevTools port');
    const target = await (await fetch(`http://127.0.0.1:${E2E_CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    let msgId = 0; const pending = new Map(); const pageErrors = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
      }
    });
    const send = (method, params = {}) => new Promise((res, rej) => {
      const i = ++msgId;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const waitFor = async (expr, ms = 20000) => {
      const t0 = Date.now();
      for (;;) {
        try { const v = await evaluate(`(() => { try { return ${expr} } catch (e) { return false } })()`); if (v) return v; } catch {}
        if (Date.now() - t0 > ms) return null;
        await sleep(200);
      }
    };
    const shot = async (name) => {
      try {
        const r = await send('Page.captureScreenshot', { format: 'png' });
        const p = path.join(os.tmpdir(), name);
        fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
        return p;
      } catch { return null; }
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 860, deviceScaleFactor: 2, mobile: false });
    await evaluate(`location.href = 'http://127.0.0.1:${E2E_PORT}/'`);
    if (!(await waitFor(`typeof boot === 'function'`))) throw new Error('the app did not load');
    await evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sc', displayName: 'Story Center', password: 'passw0rd!x' }) });
      const d = await r.json();
      store.token = d.token; store.sid = d.sid;
    })()`);
    await send('Page.reload');
    if (!(await waitFor(`S.me && S.me.username === 'sc'`))) throw new Error('the app did not boot signed in');
    if (!(await evaluate(`(async () => { await openHome(); return S.view === 'home'; })()`))) throw new Error('Home did not open');

    console.log('\n[9] the real app: the Stories row opens the page');
    await evaluate(`document.getElementById('btn-stories').click()`);
    check(!!(await waitFor(`!document.getElementById('stories-page').classList.contains('hidden')`)), 'the story page opens');
    let state = await evaluate(`(() => ({
      panel: S.homePanel,
      view: S.view,
      friends: !document.getElementById('friends-page').classList.contains('hidden'),
      title: document.getElementById('chan-name').textContent,
      storiesActive: document.getElementById('btn-stories').classList.contains('active'),
      friendsActive: document.getElementById('btn-friends').classList.contains('active'),
      rail: !!document.getElementById('story-rail'),
      navSub: document.getElementById('stories-nav-sub').textContent,
      empty: !!document.querySelector('#sp-body .sp-empty'),
      emptyText: (document.querySelector('#sp-body .sp-empty-title') || {}).textContent,
    }))()`);
    check(state.panel === 'stories' && state.view === 'home', 'the Home panel switches to stories', state);
    check(!state.friends && state.title === 'Stories', 'the Friends feed gives way and the header follows', state);
    check(state.storiesActive && !state.friendsActive, 'the sidebar highlight moves to the Stories row', state);
    check(state.rail === false, 'the old rail is not in the live DOM at all', state);
    check(state.navSub.length > 0, 'the sidebar row still carries its one-line summary', state.navSub);
    check(state.empty && state.emptyText === 'No stories right now', 'with nothing live the page shows its empty state', state);
    const deskShot = await shot('campfire-story-center-app.png');
    if (deskShot) console.log('  (wrote ' + deskShot + ')');

    console.log('\n[10] cards on the real page, and back to Friends');
    await evaluate(`(() => {
      const now = Date.now();
      const u = { id: 'u1', username: 'ada', display_name: 'Ada', avatar_color: '#5865f2' };
      storyData.friends = [{ id: 'u1', user: u, unseen: 2, latest: now - 60e3, items: [
        { id: 'st1', kind: 'image', url: '/icons/campfire-logo.png', created_at: now - 60e3, expires_at: now + 3600e3, seen: false, views: 0, reactions: [] },
        { id: 'st2', kind: 'image', url: '/icons/campfire-logo.png', created_at: now - 120e3, expires_at: now + 3600e3, seen: false, views: 0, reactions: [] },
      ] }];
      renderStoriesPage();
      return true;
    })()`);
    state = await evaluate(`(() => {
      const card = document.querySelector('#sp-body .sp-card');
      const calls = [];
      const real = openStoryViewer;
      openStoryViewer = (o) => calls.push(o);
      card.click();
      openStoryViewer = real;
      return { name: card.querySelector('.sp-card-name').textContent, badge: card.querySelector('.sp-card-new').textContent, calls };
    })()`);
    check(state.name === 'Ada' && state.badge === '2', 'a real card renders with its unseen badge', state);
    check(state.calls.length === 1 && state.calls[0].kind === 'user' && state.calls[0].userId === 'u1', 'and opens that person\'s story', state.calls);
    await evaluate(`showFriendsPanel()`);
    state = await evaluate(`(() => ({
      panel: S.homePanel,
      friends: !document.getElementById('friends-page').classList.contains('hidden'),
      stories: !document.getElementById('stories-page').classList.contains('hidden'),
      title: document.getElementById('chan-name').textContent,
      friendsActive: document.getElementById('btn-friends').classList.contains('active'),
    }))()`);
    check(state.panel === 'friends' && state.friends && !state.stories && state.title === 'Friends' && state.friendsActive,
      'the Friends row takes it back', state);
    await evaluate(`document.getElementById('btn-home').click()`);
    await sleep(400);
    check(await evaluate(`S.homePanel === 'friends' && !document.getElementById('friends-page').classList.contains('hidden')`),
      'and the campfire Home button comes back to the Friends tab it was left on');

    console.log('\n[11] a phone-width story page');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 820, deviceScaleFactor: 2, mobile: true });
    await evaluate(`document.getElementById('btn-stories').click()`);
    await waitFor(`!document.getElementById('stories-page').classList.contains('hidden')`);
    await sleep(300);
    const phoneShot = await shot('campfire-story-center-app-phone.png');
    if (phoneShot) console.log('  (wrote ' + phoneShot + ')');
    const fit = await evaluate(`(() => { const p = document.getElementById('stories-page'); return { page: p.scrollWidth, client: p.clientWidth }; })()`);
    check(fit.page <= fit.client + 1, 'the real page does not scroll sideways on a phone', fit);
    // The phone nav page covers the chat: tapping Stories must close it and land
    // on the page (same contract the Friends row has).
    const nav = await evaluate(`(async () => {
      document.body.classList.add('nav-open');
      document.getElementById('btn-stories').click();
      await new Promise((r) => setTimeout(r, 300));
      return { navOpen: document.body.classList.contains('nav-open'), stories: !document.getElementById('stories-page').classList.contains('hidden') };
    })()`);
    check(!nav.navOpen && nav.stories, 'tapping Stories in the phone nav closes it and shows the page', nav);
    check(!pageErrors.length, 'no uncaught page errors', pageErrors.slice(0, 3));
  } catch (e) {
    console.error('[test] ' + ((e && e.stack) || e));
    failures.push('app half threw: ' + ((e && e.message) || e));
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome && chrome.kill(); } catch {}
    try { child && child.kill(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  console.log('\n[1] the strip is gone, the page is a destination');
  check(!/id="story-rail"/.test(index), 'the story rail above the friend list is gone from the markup');
  check(!/#story-rail\{/.test(css), 'and its stylesheet rules are gone');
  check(!/function renderStoryRail|function storyTile/.test(stories), 'the rail renderer and its tile helper are gone from the module');
  check(!/renderStoryRail\(\)/.test(stories), 'nothing calls them any more');
  check(/<div id="stories-page" class="hidden">/.test(index), 'the story center is its own panel');
  check(/id="sp-body"/.test(index) && /id="sp-sub"/.test(index) && /id="sp-post"/.test(index), 'with a body, a summary line and a post button');
  check(/\$\('#btn-stories'\)\.onclick = \(\) => showStoriesPanel\(\)/.test(stories), 'the sidebar Stories row opens the page');
  check(/openStoriesSheet\(\{ serverId: S\.serverId/.test(stories), 'the server sidebar row still opens its compact sheet');
  check(/async function showStoriesPanel\(\)/.test(stories) && /S\.homePanel = 'stories';/.test(stories), 'showStoriesPanel switches the Home panel');
  check(/\$\('#sp-post'\)\.onclick = \(\) => createStory\(\{\}\)/.test(stories), 'the page\'s post button starts a post (friends audience; createStory picks camera vs chooser)');

  console.log('\n[2] the panel switch is one place');
  check(/homePanel: 'friends'/.test(core), 'S carries which Home panel is showing');
  check(/function paintHomePanel\(\)/.test(pins), 'paintHomePanel owns the toggle');
  check(/\$\('#friends-page'\)\.classList\.toggle\('hidden', stories\)/.test(pins) && /\$\('#stories-page'\)\.classList\.toggle\('hidden', !stories\)/.test(pins), 'it shows exactly one of the two');
  check(/paintHomePanel\(\);\r?\n\s*document\.querySelectorAll\('#home-ui \.dmrow'\)/.test(pins), 'renderDmBlank routes through it');
  check(/\$\(stories \? '#btn-stories' : '#btn-friends'\)\?\.classList\.add\('active'\)/.test(pins), 'the nav row highlight follows the panel');
  check(/\$\('#chan-name'\)\.textContent = stories \? 'Stories' : 'Friends'/.test(pins), 'and so does the header name');
  check(/S\.homePanel = opts\.panel === 'stories' \? 'stories' : 'friends';/.test(home), 'Home\'s own default panel is Friends (the campfire button passes the remembered tab instead)');
  check(/function showFriendsPanel\(\) \{\r?\n  if \(S\.view !== 'home'\) \{ openHome\(\{ panel: 'friends', dm: null \}\); return; \}/.test(home), 'the Friends row sets it before switching views');
  // Every path that hides the Friends panel must hide the story page with it.
  for (const [name, src] of [['openServerView', home], ['selectDmThread', pins], ['openCallView', voice], ['leaveVoice', voice], ['closeCallView', voice]]) {
    const showFriends = /\$\('#friends-page'\)\.classList\.add\('hidden'\);/.test(src);
    check(!showFriends || /\$\('#stories-page'\)\.classList\.add\('hidden'\);/.test(src), name + ' hides the story page alongside Friends', null);
  }
  const hidePairs = (src) => (src.match(/\$\('#friends-page'\)\.classList\.add\('hidden'\);[\s\S]{0,40}\$\('#stories-page'\)\.classList\.add\('hidden'\);/g) || []).length;
  check(hidePairs(pins) >= 1 && hidePairs(home) >= 1, 'the two panels travel as a pair', { pins: hidePairs(pins), home: hidePairs(home) });

  console.log('\n[3] nothing else still points at the rail');
  check(!/#story-rail/.test(index + stories + css), 'no rail id left anywhere in the frontend');
  check(!/sp-note|Stories last 24 hours/.test(index + stories + css),
    'the old "Stories last 24 hours…" footer note is gone from the markup, module and stylesheet');
  check(/#stories-page\{[^}]*overflow-y:auto/.test(css), 'the page scrolls like the Friends feed (.css)');

  const chrome = findChrome();
  if (!chrome) return skip('no Chrome/Edge found (set CHROME_PATH)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-story-center-'));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml());
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const chromeProc = spawn(chrome, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=980,820', 'about:blank'], { stdio: 'ignore' });

  let ws;
  try {
    let info = null;
    for (let i = 0; i < 60 && !info; i++) {
      try { info = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); } catch { await sleep(250); }
    }
    if (!info) return skip('Chrome never opened its DevTools port');
    ws = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
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
    await sess('Emulation.setDeviceMetricsOverride', { width: 980, height: 820, deviceScaleFactor: 2, mobile: false });
    await sess('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
    await sleep(500);
    if (!(await evaluate('typeof window.__seed === "function"'))) {
      console.error('[test] the extracted story-center code did not evaluate in the page');
      process.exit(1);
    }

    console.log('\n[4] your story leads the page');
    await evaluate('window.__seed("full")');
    await sleep(120);
    let out = await evaluate('window.__out()');
    check(out.sub === '2 new stories from 1 person', 'the summary counts what is waiting', out.sub);
    check(!!out.hero && !out.hero.empty, 'the hero is the full card when you have a live story', out.hero);
    check(out.hero.title === 'Your story' && /2 posts/.test(out.hero.sub) && /h left/.test(out.hero.chips.join(' ')), 'titled, with post count and hours left', { sub: out.hero.sub, chips: out.hero.chips });
    check(out.hero.chips.some((c) => /12 views/.test(c)), 'views are summed across your live posts', out.hero.chips);
    check(out.hero.chips.some((c) => /reactions/.test(c)) && out.hero.chips.some((c) => /🔥/.test(c)), 'and reactions show with their emoji', out.hero.chips);
    check(out.hero.hasMedia, 'the hero wears your latest frame');
    check(out.hero.h > 120, 'it is a real card, not a strip', out.hero.h);
    check(out.hero.btns.join('|') === 'Watch|Add', 'with Watch and Add', out.hero.btns);
    check(out.heroViewers && !out.heroViewers.hidden && out.heroViewers.avs === 3 && /See who watched/.test(out.heroViewers.text),
      'and who watched lands in from the viewers route', out.heroViewers);

    console.log('\n[5] everyone else, unseen first');
    check(out.sections.join('|') === 'New stories|Already watched|Servers', 'the page is sectioned', out.sections);
    check(out.cards.length === 3, 'one card per person', out.cards.length);
    check(out.cards[0].name === 'Ada' && out.cards[0].new === '2' && !out.cards[0].seen, 'the unseen friend leads, badged with the count', out.cards[0]);
    check(out.cards[0].hasMedia && /ago$/.test(out.cards[0].ago), 'each card carries their frame and how long ago', out.cards[0]);
    check(out.cards.filter((c) => c.seen).length === 2, 'watched ones are marked seen (they grey out)', out.cards);
    check(out.servers.length === 1 && /Studio/.test(out.servers[0]) && /1 new/.test(out.servers[0]), 'the server strip carries the server and its count', out.servers);
    check(out.cols >= 3, 'the wall is a multi-column grid on a desktop panel', { cols: out.cols });
    check(out.portrait && out.portrait.ratio > 1.2, 'the cards are portrait, like a story', out.portrait);
    check(out.note === '', 'and there is no footer note under the wall', out.note);

    const shot = (await sess('Page.captureScreenshot', { format: 'png' })).data;
    const shotPath = path.join(os.tmpdir(), 'campfire-story-center.png');
    fs.writeFileSync(shotPath, Buffer.from(shot, 'base64'));
    console.log('  (wrote ' + shotPath + ')');

    console.log('\n[6] what a tap does');
    await evaluate('window.__calls.length = 0; document.querySelector(".sp-card").click()');
    await evaluate('document.querySelector(".sp-hero-btns .primary").click()');
    await evaluate('document.querySelector(".sp-card-who") && document.querySelector(".sp-hero-viewers").click()');
    let calls = await evaluate('window.__calls');
    check(calls[0][0] === 'viewer' && calls[0][1].kind === 'user' && calls[0][1].userId === 'f1', 'a card opens that person\'s story', calls[0]);
    check(calls[1][0] === 'viewer' && calls[1][1].kind === 'mine', 'Watch opens your own story', calls[1]);
    check(calls[2][0] === 'viewers', 'the viewer row opens the same "who watched" panel', calls[2]);

    console.log('\n[7] only your own story, and nothing at all');
    await evaluate('window.__calls.length = 0; window.__seed("seen")');
    await sleep(80);
    out = await evaluate('window.__out()');
    check(out.sections.join('|') === 'Already watched', 'a watched-only friend gets the watched heading', out.sections);
    check(out.cards.length === 1 && out.cards[0].seen && out.cards[0].new === '', 'with no "new" badge', out.cards);
    check(out.sub === '1 person with live stories' && !(await evaluate('document.getElementById("sp-sub").classList.contains("hidden")')), 'and the summary says so', out.sub);
    await evaluate('window.__seed("empty")');
    await sleep(80);
    out = await evaluate('window.__out()');
    check(out.empty && !out.hero && out.cards.length === 0 && out.sections.length === 0,
      'nothing live → one welcome panel instead of a hero plus an empty card', { empty: out.empty, hero: out.hero, sections: out.sections });
    const welcome = await evaluate(`(() => { const b = document.querySelector('#sp-body .sp-empty'); return b ? { title: b.querySelector('.sp-empty-title').textContent, tips: [...b.querySelectorAll('.sp-tip')].map((e) => e.textContent), btn: (b.querySelector('.btn') || {}).textContent } : null; })()`);
    check(!!welcome && welcome.title === 'No stories right now' && welcome.tips.length === 3 && welcome.btn === 'Post a story',
      'with the how-it-works tips and one way in', welcome);
    check(out.sub === '' && (await evaluate('document.getElementById("sp-sub").classList.contains("hidden")')),
      'the header says nothing at all — no "nothing live" line', out.sub);

    console.log('\n[8] it fits a phone');
    await sess('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
    await evaluate('document.getElementById("chat").style.width = "390px"');
    await evaluate('window.__seed("full")');
    await sleep(140);
    out = await evaluate('window.__out()');
    const fit = await evaluate(`(() => { const p = document.getElementById('stories-page'); const h = document.querySelector('.sp-hero-in');
      return { page: p.scrollWidth, client: p.clientWidth, doc: document.documentElement.scrollWidth, win: window.innerWidth,
        heroW: Math.round(h.getBoundingClientRect().width), heroRight: Math.round(h.getBoundingClientRect().right), heroOverflow: h.scrollWidth - h.clientWidth }; })()`);
    check(out.cols === 2, 'the wall drops to two columns on a phone', { cols: out.cols });
    check(fit.page <= fit.client + 1 && fit.doc <= fit.win + 1, 'the page never scrolls sideways', fit);
    check(fit.heroOverflow <= 1 && fit.heroRight <= 390, 'the hero wraps instead of running off the screen', fit);
    const phoneShot = (await sess('Page.captureScreenshot', { format: 'png' })).data;
    const phonePath = path.join(os.tmpdir(), 'campfire-story-center-phone.png');
    fs.writeFileSync(phonePath, Buffer.from(phoneShot, 'base64'));
    console.log('  (wrote ' + phonePath + ')');
  } catch (e) {
    console.error('[test] ' + ((e && e.stack) || e));
    failures.push('browser half threw: ' + ((e && e.message) || e));
  } finally {
    try { ws && ws.close(); } catch {}
    try { chromeProc.kill(); } catch {}
    try { server.close(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log('');
}

main()
  .then(() => e2e())
  .then(() => {
    if (failures.length) {
      console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
      for (const f of failures) console.log('  - ' + f);
      process.exit(1);
    }
    console.log(`All ${passed} checks passed.`);
    process.exit(0);
  })
  .catch((e) => { console.error('[test] ' + ((e && e.stack) || e)); process.exit(1); });
