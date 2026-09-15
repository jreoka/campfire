// The quick reaction strips: five emojis, the ones THIS account actually reacts
// with.
//
// The complaint: "have the long press/hover menu quick reaction emojis be the
// most used or most recently used ones whatever its supposed to be". Two things
// were wrong with the old `cf_freq` ranking:
//
//   1. It counted emojis INSERTED INTO MESSAGES as well as reactions, so what
//      somebody chats with (😀😀😀) outranked what they react with — and the
//      strips are reaction buttons.
//   2. The hover bar's strip is baked into each message's markup at render time
//      and nothing repainted it, so even a ranking that HAD moved (the phone's
//      long-press sheet reads it fresh on every open) left the hover menu
//      offering the five it had, until something re-rendered the chat. That is
//      the half a person actually sees while hovering.
//
// Equal counts now go to whichever was used most recently, the old numeric shape
// of `cf_freq` still reads, and a strip already on screen is repainted the moment
// the ranking moves.
//
// Three parts:
//   [A] the wiring, statically: one builder for the strip, the repaint, the
//       reaction path calling it, the composer picker NOT feeding the list;
//   [B] the real ranking, sliced out of actions.js and run against a fake
//       localStorage (counts, recency, the old shape, the 40-row cap);
//   [C] a real server + headless Chrome: react with something new and the hover
//       bar under the pointer changes without a re-render, the long-press sheet
//       offers the same five, and typing emojis moves neither.
//
// Usage: node scripts/test-quick-reactions.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_quickreact_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3453', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9343', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); }

const actions = fs.readFileSync(path.join(ROOT, 'public/js/actions.js'), 'utf8');
const messages = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT, 'public/service-worker.js'), 'utf8');

const RANK_START = 'function freqN(v) {';
const RANK_END = 'let ctxEl = null;';
function rankSource() {
  const a = actions.indexOf(RANK_START);
  const b = a < 0 ? -1 : actions.indexOf(RANK_END, a);
  if (a < 0 || b < 0) { console.error('[test] could not slice the ranking out of actions.js'); process.exit(1); }
  return actions.slice(a, b);
}
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}

// The real ranking, with a localStorage and a clock the test owns.
function makeRanker(store = {}) {
  const ls = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  const clock = { t: 1000 };
  // A Date whose now() the test moves (bumpFreq stamps `at` from it).
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [clock.t])); }
    static now() { return clock.t; }
  }
  const run = new Function('localStorage', 'Date',
    rankSource() + '\nreturn { topReactions, bumpFreq, freqN, freqAt, QUICK_REACTIONS };');
  const api = run(ls, FakeDate);
  return { ...api, store, clock, ls };
}

// ---------- [A] the wiring ----------
function wiringChecks() {
  console.log('\n[A1] one builder for the strip, fed by the ranking');
  check(/function quickReactHTML\(e\)/.test(messages) && /function quickReactsHTML\(\)/.test(messages),
    'the strip has ONE builder (so a repaint and a fresh render cannot disagree)');
  check(/return topReactions\(\)\.map\(quickReactHTML\)\.join\(''\)/.test(messages)
    && /inner \+= '<div class="msg-actions">' \+ quickReactsHTML\(\) \+ '<\/div>';/.test(messages),
    'both the builder and the hover bar call it');
  check(/function topReactions\(\)/.test(actions), 'and the ranking is actions.js topReactions');
  check((messages.match(/quickReactsHTML\(\)/g) || []).length === 2,
    'the inline copy of the strip is gone (built once, used twice)', (messages.match(/quickReactsHTML\(\)/g) || []).length);

  console.log('\n[A2] a strip already on screen is repainted when the ranking moves');
  const paint = slice(messages, 'function paintQuickReacts() {', 'function messageEl(');
  check(/document\.querySelectorAll\('\.msg-actions'\)/.test(paint), 'it walks the bars that are up', paint.trim());
  check(/button\[data-emoji\]/.test(paint) && /insertAdjacentHTML\('afterbegin', html\)/.test(paint),
    'swapping only the quick buttons (More / Reply / menu stay put)');
  check(/if \(bumpFreq\(emoji\)\) \{ try \{ paintQuickReacts\(\); \} catch \{\} \}/.test(pickers),
    'and the reaction path calls it exactly when the ranking changed — not on every click');
  check(/return topReactions\(\)\.join\('\\u0000'\) !== before;/.test(actions),
    'which is what bumpFreq now reports');

  console.log('\n[A3] only REACTIONS feed it');
  check(/if \(bumpFreq\(emoji\)\)/.test(pickers) && (pickers.match(/bumpFreq\(/g) || []).length === 1,
    'the reaction toggle is the one caller', (pickers.match(/bumpFreq\(/g) || []).length);
  check(!/else \{ bumpFreq\(e\); insertAtCursor/.test(pickers) && /else insertAtCursor\(\$\('#in-message'\), e\);/.test(pickers),
    'inserting an emoji into a message no longer counts as reacting with it');
  check(/for \(const e of topReactions\(\)\)/.test(actions),
    'the long-press sheet reads the same ranking (it always did — every open)');

  console.log('\n[A4] the ranking itself');
  check(/function freqN\(v\)/.test(actions) && /function freqAt\(v\)/.test(actions),
    'a row is { n, at }, read through two helpers');
  check(/typeof v === 'number' \? v : \(\(v && \+v\.n\) \|\| 0\)/.test(actions),
    'and a bare number — the older shape — still reads as a count (no history lost on upgrade)');
  check(/\.sort\(\(a, b\) => \(freqN\(b\[1\]\) - freqN\(a\[1\]\)\) \|\| \(freqAt\(b\[1\]\) - freqAt\(a\[1\]\)\)\)/.test(actions),
    'most reacted-with first, then most recently used');
  check(/const QUICK_REACTIONS = \['👍', '❤️', '😂', '😮', '😢'\];/.test(actions),
    'the defaults are one named list (a fresh account still gets five)');
  check(/\.filter\(\(\[, v\]\) => freqN\(v\) > 0\)/.test(actions),
    'a zero-count row can never outrank anything');
  check(/const CACHE = 'campfire-v\d+'/.test(sw), 'the shell cache is versioned');
}

// ---------- [B] the real ranking, run ----------
function rankingChecks() {
  console.log('\n[B1] a fresh account gets the defaults, in order');
  const r = makeRanker();
  check(JSON.stringify(r.topReactions()) === JSON.stringify(['👍', '❤️', '😂', '😮', '😢']),
    'the five defaults', r.topReactions());

  console.log('\n[B2] what you react with climbs the strip');
  const r2 = makeRanker();
  r2.clock.t = 5000; r2.bumpFreq('🔥');
  check(r2.topReactions()[0] === '🔥', 'one new reaction takes the first slot', r2.topReactions());
  check(r2.topReactions().length === 5, 'and the strip is still five');
  r2.bumpFreq('🔥');
  r2.bumpFreq('🎉');
  check(r2.topReactions().slice(0, 2).join(' ') === '🔥 🎉', 'counts rank it', r2.topReactions());

  console.log('\n[B3] equal counts go to the most recent');
  const r3 = makeRanker();
  r3.clock.t = 1000; r3.bumpFreq('🦆');
  r3.clock.t = 9000; r3.bumpFreq('🌶️');
  check(r3.topReactions().indexOf('🌶️') < r3.topReactions().indexOf('🦆'),
    'the one used later wins the tie (it is what the person just reached for)', r3.topReactions());
  r3.clock.t = 10000; r3.bumpFreq('🦆');
  check(r3.topReactions()[0] === '🦆' && r3.topReactions()[1] === '🌶️',
    'and once it is used again, it leads again', r3.topReactions());

  console.log('\n[B4] usage still beats recency');
  const r4 = makeRanker();
  r4.clock.t = 1000; r4.bumpFreq('🔥'); r4.bumpFreq('🔥');
  r4.clock.t = 99999; r4.bumpFreq('🦆');
  check(r4.topReactions().slice(0, 2).join(' ') === '🔥 🦆',
    'twice-used-old still outranks once-used-new', r4.topReactions());

  console.log('\n[B5] the older cf_freq shape reads');
  const r5 = makeRanker({ cf_freq: JSON.stringify({ '🔥': 4, '🎉': 2 }) });
  check(r5.topReactions().slice(0, 2).join(' ') === '🔥 🎉',
    'a browser upgrading from counts-only keeps its history (and its order)', r5.topReactions());
  check(r5.bumpFreq('🎉') === false && r5.freqN(JSON.parse(r5.store.cf_freq)['🎉']) === 3,
    'and the next reaction over it rewrites that row in the new shape without losing the count',
    JSON.parse(r5.store.cf_freq));
  check(JSON.stringify(r5.topReactions().slice(0, 2)) === JSON.stringify(['🔥', '🎉']), 'still ranked by count', r5.topReactions());

  console.log('\n[B6] it reports a change only when the strip actually moved');
  const r6 = makeRanker();
  check(r6.bumpFreq('🔥') === true, 'a NEW reaction moves the strip');
  check(r6.bumpFreq('🔥') === false, 'using it again in the same place does not (no repaint per click)');
  check(r6.bumpFreq('🎉') === true, 'but a new emoji entering the five does', r6.topReactions());
  const stable = makeRanker();
  stable.bumpFreq('🔥'); stable.bumpFreq('🔥'); stable.bumpFreq('🔥');
  check(stable.bumpFreq('👍') === false,
    'reacting with an emoji already in the strip, in its place, is not a change (no repaint per click)',
    stable.topReactions());
  check(stable.bumpFreq('') === false && stable.bumpFreq(null) === false && stable.bumpFreq(7) === false,
    'and junk is ignored outright');

  console.log('\n[B7] custom emoji ride along, and the map stays bounded');
  const r7 = makeRanker();
  r7.clock.t = 100; r7.bumpFreq(':partyparrot:');
  check(r7.topReactions()[0] === ':partyparrot:', 'a custom :shortcode: is a reaction like any other', r7.topReactions());
  for (let i = 0; i < 60; i++) { r7.clock.t += 1000; r7.bumpFreq('e' + i); }
  const map = JSON.parse(r7.store.cf_freq);
  check(Object.keys(map).length === 40, 'the store is capped at 40 rows', Object.keys(map).length);
  check(!(':partyparrot:' in map) && !('e19' in map) && 'e20' in map && 'e59' in map,
    'what falls off is the least used, oldest first — the ranking read backwards',
    { keys: Object.keys(map).length, first: Object.keys(map)[0], last: Object.keys(map).pop() });
  const heavy = makeRanker();
  heavy.clock.t = 1; heavy.bumpFreq('🔥'); heavy.bumpFreq('🔥'); heavy.bumpFreq('🔥');
  for (let i = 0; i < 60; i++) { heavy.clock.t += 1000; heavy.bumpFreq('x' + i); }
  check('🔥' in JSON.parse(heavy.store.cf_freq),
    'and what was used most is never the thing pruned', Object.keys(JSON.parse(heavy.store.cf_freq)).length);
  check(heavy.topReactions()[0] === '🔥', 'so it still leads the strip');
}

// ---------- [C] a real browser ----------
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

async function browserChecks(chromePath) {
  const envFile = readEnvFile();
  const pg = {
    host: process.env.PGHOST || envFile.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || envFile.POSTGRES_USER || 'campfire',
    password: process.env.PGPASSWORD || envFile.POSTGRES_PASSWORD || '',
  };
  const admin = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
  try { await admin.connect(); }
  catch (e) { return skip('Postgres unreachable (' + ((e && e.message) || e) + ') — docker compose up -d db'); }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-quickreact-'));
  let child = null, chrome = null, ws = null;
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();

    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        PGHOST: pg.host, PGPORT: String(pg.port), PGUSER: pg.user, PGPASSWORD: pg.password, PGDATABASE: TEST_DB,
        JWT_SECRET: 'test-quick-reactions',
        UPLOAD_DIR: path.join(tmp, 'uploads'),
        UNFURL: '0', VIRUS_SCAN: '0', MEDIA_COMPRESS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${PORT}/api/config`)).ok; } catch {}
      if (!up) await sleep(250);
    }
    if (!up) throw new Error('server did not come up\n' + serverLog.slice(-3000));

    chrome = spawn(chromePath, [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(tmp, 'chrome')}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
      '--window-size=1200,900', 'about:blank',
    ], { stdio: 'ignore' });
    let ver = null;
    for (let i = 0; i < 80 && !ver; i++) {
      try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch {}
      if (!ver) await sleep(250);
    }
    if (!ver) throw new Error('Chrome did not expose the DevTools port');

    const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

    let msgId = 0;
    const pending = new Map();
    const pageErrors = [];
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
    // The strip as it is actually painted, per surface.
    const strip = (sel) => evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((b) => b.dataset.emoji)`);

    await send('Page.enable');
    await send('Runtime.enable');
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    check(!!(await waitFor(`typeof topReactions === 'function'`)), 'the app loads');

    console.log('\n[C1] sign in, open a channel, post a message');
    const reg = await evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'quickreact', displayName: 'Quick React', password: 'passw0rd!x' }) });
      const d = await r.json();
      store.token = d.token; store.sid = d.sid;
      return { ok: !!d.token };
    })()`);
    check(!!reg.ok, 'registered an account');
    await send('Page.reload');
    check(!!(await waitFor(`S.me && S.me.username === 'quickreact'`)), 'boots signed in');
    const srv = await evaluate(`(async () => {
      const r = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: 'React Lab' }) });
      await refreshServers(r.server.id);
      if (S.ws) S.ws.send(JSON.stringify({ t: 'subscribe' }));
      await selectServer(r.server.id);
      await new Promise((res) => setTimeout(res, 200));
      sendChat('react to me');
      return { cid: S.channelId };
    })()`);
    const mid = await waitFor(`(() => { const els = [...document.querySelectorAll('#messages .msg[data-mid]')]; return els.length ? els[els.length - 1].dataset.mid : null })()`);
    check(!!srv.cid && !!mid, 'a channel and a message', { srv, mid });

    console.log('\n[C2] the hover bar opens on the defaults');
    const sel = '#messages .msg[data-mid="' + mid + '"]';
    check(!!(await waitFor(`document.querySelectorAll(${JSON.stringify(sel)} + ' .msg-actions button[data-emoji]').length === 5`)),
      'the hover bar is painted', mid);
    const hover = () => strip(sel + ' .msg-actions button[data-emoji]');
    check(JSON.stringify(await hover()) === JSON.stringify(['👍', '❤️', '😂', '😮', '😢']),
      'a fresh account hovers five defaults', await hover());

    console.log('\n[C3] reacting with a new emoji moves the bar UNDER THE POINTER, with no re-render');
    const after = await evaluate(`(async () => {
      const sel = ${JSON.stringify(sel)};
      const before = [...document.querySelectorAll(sel + ' .msg-actions button[data-emoji]')].map((b) => b.dataset.emoji);
      const node = document.querySelector(sel);
      await toggleReaction(${JSON.stringify(mid)}, '🔥');
      await new Promise((r) => setTimeout(r, 250));
      const now = [...document.querySelectorAll(sel + ' .msg-actions button[data-emoji]')].map((b) => b.dataset.emoji);
      return { before, now, sameNode: document.querySelector(sel) === node, top: topReactions(), freq: localStorage.getItem('cf_freq') };
    })()`);
    check(after.now[0] === '🔥', 'the emoji just reacted with takes the first slot, live', after);
    check(after.sameNode === true, 'the message was never re-rendered to make that happen (the reader\'s place is kept)', after);
    check(after.now.length === 5 && after.now.includes('👍'), 'and the strip is still five, defaults filling the rest', after.now);
    check(/^\{".*":\{"n":1,"at":\d+\}\}$/.test(String(after.freq)), 'stored as { n, at }', after.freq);

    console.log('\n[C4] the long-press sheet offers the same five');
    const sheet = await evaluate(`(() => {
      openMsgSheet(${JSON.stringify(mid)}, document.querySelector(${JSON.stringify(sel)}));
      const out = [...document.querySelectorAll('.sheet-reacts button')].map((b) => b.textContent.trim());
      closeMsgSheet(true);
      return out;
    })()`);
    check(sheet[0] === '🔥' && sheet.length === 5, 'the phone sheet agrees with the hover bar', sheet);
    check(JSON.stringify(sheet) === JSON.stringify(after.now), 'exactly — one list, two surfaces', { sheet, bar: after.now });

    console.log('\n[C5] typing emojis into a message moves nothing');
    const typed = await evaluate(`(async () => {
      const before = topReactions();
      for (const e of ['😀', '😀', '😀', '😀', '😀', '🎃', '🎃']) { S.picker = null; pickEmoji(e); }
      await new Promise((r) => setTimeout(r, 200));
      return { before, after: topReactions(), freq: localStorage.getItem('cf_freq') };
    })()`);
    check(JSON.stringify(typed.before) === JSON.stringify(typed.after),
      'a chat full of 😀 is text, not a reaction: the strips do not change', typed);
    check(!/😀/.test(String(typed.freq)) && !/🎃/.test(String(typed.freq)),
      'and none of it is even recorded', typed.freq);

    console.log('\n[C6] a quick button still reacts, in place');
    const again = await evaluate(`(async () => {
      const sel = ${JSON.stringify(sel)};
      const node = document.querySelector(sel);
      node.querySelector('.msg-actions button[data-emoji="👍"]').click();
      await new Promise((r) => setTimeout(r, 350));
      const m = msgById(${JSON.stringify(mid)});
      const pills = [...node.querySelectorAll('.reactions .reaction')].map((b) => b.dataset.emoji);
      return { sameNode: document.querySelector(sel) === node, model: (m.reactions || []).map((r) => r.emoji), pills, top: topReactions() };
    })()`);
    check(again.model.includes('👍') && again.sameNode === true,
      'clicking a quick button adds that reaction without re-rendering the message', again);
    check(again.pills.includes('👍'), 'and its pill appears in place', again.pills);

    check(pageErrors.length === 0, 'no uncaught page errors', pageErrors.slice(0, 3));
    if (pageErrors.length) console.log('  page errors: ' + JSON.stringify(pageErrors.slice(0, 5)));
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome && chrome.kill(); } catch {}
    try { child && child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  wiringChecks();
  rankingChecks();
  const chrome = findChrome();
  if (!chrome) skip('no Chrome/Edge found (set CHROME_PATH) — the live-strip half (C) did not run');
  else await browserChecks(chrome);

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
}

main().catch((e) => { console.error('[test] crashed:', (e && e.message) || e); process.exit(1); });
