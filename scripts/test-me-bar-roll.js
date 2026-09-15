// The me bar's sub-line: what it says, and the hover roll that reveals my handle.
//
// The requests:
//   - the line under my name says what I am doing — streaming, my custom status,
//     the game I am playing — or, failing all three, my presence WORD ("Online",
//     "Away", "Do not disturb", "Invisible"), so it is never blank;
//   - hovering the avatar+name+status area rolls that line UP to my handle, with
//     no @ in front of it, and leaving rolls it back DOWN;
//   - it is hover-only (a touch screen would leave the handle stuck on the bar);
//   - and the roll never nudges the bar: the drum window is the same height as
//     the line it replaces, and the text sits inside it uncut.
//
// Chrome is needed for the browser half; it skips without it.
//
// Usage: node scripts/test-me-bar-roll.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_me_bar_roll_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3448', 10);
const BASE = `http://127.0.0.1:${PORT}`;
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
  const c = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return c.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
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

// ---------- the wiring, offline ----------
const servers = fs.readFileSync(path.join(ROOT, 'public/js/servers.js'), 'utf8');
const messages = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

console.log('\n[0] the wiring');
check(/const STATUS_TEXT = \{ online: 'Online'/.test(core), 'the presence words live in core.js (painted before the later files parse)');
check(!/const STATUS_TEXT/.test(pickers) && /STATUS_TEXT\[st\]/.test(pickers), 'and the status picker reads that one copy');
check(/STATUS_TEXT\[st\] \|\| 'Online'/.test(servers), 'the me bar falls back to my presence word');
check(/streaming \? \('Streaming ' \+ S\.me\.streaming_game\)/.test(servers) && /!off && S\.me\.status_text/.test(servers) && /'Playing ' \+ S\.me\.playing_game/.test(servers),
  'streaming, then custom status, then the game — all still ahead of it');
check(/function paintMeSub\(rollDir\)/.test(servers) && /rollValue\(sub, cur, want, rollDir === 'down' \? 'down' : 'up', 'wide'\)/.test(servers),
  'one painter decides what the line says and how it gets there');
check(/meSubState\.hover \? meHandleText\(\) : meSubState\.status/.test(servers), 'hovering swaps in the handle');
check(/function meHandleText\(\) \{ return \(S\.me && S\.me\.username\) \|\| ''; \}/.test(servers),
  'and the handle is the plain username (no @)');
check(/matchMedia\('\(hover:hover\)'\)\.matches/.test(servers), 'wired only where hover exists (never a stuck handle on touch)');
check(/function rollValue\(el, from, to, dir, extra\)/.test(messages) && /function rollReactionCount\(el, from, to, dir\) \{ rollValue/.test(messages),
  'the reaction count and the me bar share one roll');
check(/function rollShownText\(el\)/.test(messages) && /parseInt\(rollShownText\(el\), 10\)/.test(messages),
  'and one reader for "what is it showing right now"');
check(/\.rc-roll\.wide\{height:1\.35em;line-height:1\.35em\}/.test(css), 'the text-sized window exists');
check(/#me-card \.mstatus\{[^}]*line-height:1\.35\}/.test(css),
  'and the resting sub-line is the same height, so a roll cannot nudge the bar');

async function main() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-mebar-'));
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
        JWT_SECRET: 'test-me-bar-roll',
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
      try { up = (await fetch(BASE + '/api/config')).ok; } catch {}
      if (!up) await sleep(250);
    }
    if (!up) throw new Error('server did not come up\n' + serverLog.slice(-3000));

    const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9357', 10);
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
    let msgId = 0; const pending = new Map(); const pageErrors = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id); pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
      }
    });
    const send = (method, params = {}) => new Promise((res, rej) => { const i = ++msgId; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
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
    await send('Page.enable');
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(1500);

    const who = await evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'mebaruser', displayName: 'Me Bar', password: 'passw0rd!x' }) });
      const d = await r.json(); store.token = d.token; store.sid = d.sid; return { ok: !!d.token };
    })()`);
    check(!!who.ok, 'registered an account');
    await send('Page.reload');
    check(!!(await waitFor(`S.me && S.me.username === 'mebaruser'`)), 'boots signed in');

    console.log('\n[1] what the line says');
    const base = await evaluate(`(() => { const s = document.querySelector('#me-sub'); return { text: s.textContent, display: getComputedStyle(s).display, hover: matchMedia('(hover:hover)').matches, username: S.me.username, status: S.me.status } })()`);
    check(base.text === 'Online' && base.display !== 'none', 'a fresh account says Online (the presence word, not a blank line)', base);
    check(base.hover === true, 'the browser reports hover (the wiring is live here)', base);
    const withStatus = await evaluate(`(() => { S.me.status_text = 'Heads down'; paintMe(); const s = document.querySelector('#me-sub'); return { text: s.textContent, cls: s.className, rolled: !!s.querySelector('.rc-roll'), pending: (s.querySelector('.rc-new') || {}).textContent } })()`);
    check(withStatus.rolled === true && withStatus.pending === 'Heads down',
      'a custom status replaces the presence word — and it rolls in, it is a change', withStatus);
    await sleep(600);
    check((await evaluate(`document.querySelector('#me-sub').textContent`)) === 'Heads down', 'settling on the custom status');
    const away = await evaluate(`(() => { S.me.status_text = ''; S.me.status = 'dnd'; paintMe(); const s = document.querySelector('#me-sub'); return { rolled: !!s.querySelector('.rc-roll'), pending: (s.querySelector('.rc-new') || {}).textContent } })()`);
    check(away.rolled === true && away.pending === 'Do not disturb', 'and with no custom status, a change of presence rolls the new word in', away);
    await sleep(400);
    const afterAway = await evaluate(`(() => { const s = document.querySelector('#me-sub'); return { text: s.textContent, rolled: !!s.querySelector('.rc-roll') } })()`);
    check(afterAway.text === 'Do not disturb' && !afterAway.rolled, 'which settles back to plain text', afterAway);

    console.log('\n[2] the hover reveal');
    const geom = await evaluate(`(() => {
      const s = document.querySelector('#me-sub');
      const cv = document.createElement('canvas').getContext('2d');
      const cs = getComputedStyle(s);
      cv.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
      // A status can carry descenders ("Playing Among Us", "busy, brb"), so the
      // worst case that matters is a line of letters with them.
      const worst = cv.measureText('jgpqy');
      const W = parseFloat(cs.height);
      const T = worst.fontBoundingBoxAscent + worst.fontBoundingBoxDescent;
      const baseline = (W - T) / 2 + worst.fontBoundingBoxAscent;
      // The box this replaced: the same element at line-height:normal.
      const prev = s.style.lineHeight;
      s.style.lineHeight = 'normal';
      const naturalH = s.getBoundingClientRect().height;
      s.style.lineHeight = prev;
      return { W: +W.toFixed(2), naturalH: +naturalH.toFixed(2), lineH: cs.lineHeight, restH: +s.getBoundingClientRect().height.toFixed(2),
        inkTop: +(baseline - worst.actualBoundingBoxAscent).toFixed(2),
        inkBottom: +(baseline + worst.actualBoundingBoxDescent).toFixed(2) };
    })()`);
    check(Math.abs(geom.W - geom.restH) <= 0.6, 'the drum window is the height of the line it replaces', geom);
    check(geom.inkTop >= 0 && geom.inkBottom <= geom.W, 'and a descender-bearing status line sits inside it uncut', geom);
    check(geom.W >= geom.naturalH - 0.1, 'the window is no shorter than the line box it replaced', geom);

    await evaluate(`(() => {
      window.__rolls = [];
      const s = document.querySelector('#me-sub');
      new MutationObserver((muts) => {
        for (const m of muts) for (const n of (m.addedNodes || [])) {
          if (n.nodeType !== 1 || !n.classList || !n.classList.contains('rc-roll')) continue;
          const o = n.querySelector('.rc-old'), nw = n.querySelector('.rc-new');
          const wr = n.getBoundingClientRect();
          const rec = { cls: n.className, from: o.textContent, to: nw.textContent,
            gap: +((nw.getBoundingClientRect().top - wr.top) - (o.getBoundingClientRect().top - wr.top)).toFixed(2), wrapH: +wr.height.toFixed(2) };
          requestAnimationFrame(() => requestAnimationFrame(() => {
            rec.anims = [...o.getAnimations(), ...nw.getAnimations()].map((a) => a.animationName + ':' + a.playState);
            window.__rolls.push(rec);
          }));
        }
      }).observe(document.body, { childList: true, subtree: true });
      return true;
    })()`);
    const cardH = await evaluate(`+document.querySelector('#me-card').getBoundingClientRect().height.toFixed(2)`);
    const hover = await evaluate(`(() => {
      const open = document.querySelector('#me-open');
      open.dispatchEvent(new MouseEvent('mouseenter'));
      const s = document.querySelector('#me-sub');
      return { text: s.textContent, hasRoll: !!s.querySelector('.rc-roll'), pending: (s.querySelector('.rc-new') || {}).textContent, title: s.title };
    })()`);
    check(hover.hasRoll === true && hover.pending === 'mebaruser', 'hovering rolls my handle in', hover);
    check(hover.text.indexOf('@') === -1, 'with no @ in front of it', hover.text);
    const midH = await evaluate(`+document.querySelector('#me-card').getBoundingClientRect().height.toFixed(2)`);
    check(Math.abs(midH - cardH) <= 0.6, 'the bar does not change height while it rolls', { rest: cardH, rolling: midH });
    await sleep(600);
    const settled = await evaluate(`(() => { const s = document.querySelector('#me-sub'); return { text: s.textContent, rolled: !!s.querySelector('.rc-roll'), title: s.title } })()`);
    check(settled.text === 'mebaruser' && !settled.rolled, 'and settles on the handle', settled);

    const back = await evaluate(`(() => {
      document.querySelector('#me-open').dispatchEvent(new MouseEvent('mouseleave'));
      const s = document.querySelector('#me-sub');
      return { hasRoll: !!s.querySelector('.rc-roll'), from: (s.querySelector('.rc-old') || {}).textContent, cls: (s.querySelector('.rc-roll') || {}).className };
    })()`);
    check(back.hasRoll === true && back.from === 'mebaruser' && /down/.test(String(back.cls)), 'leaving rolls it back the way it came', back);
    await sleep(600);
    const restored = await evaluate(`(() => { const s = document.querySelector('#me-sub'); return { text: s.textContent, rolled: !!s.querySelector('.rc-roll') } })()`);
    check(restored.text === 'Do not disturb' && !restored.rolled, 'and the status line is back', restored);

    const rolls = await evaluate(`window.__rolls`);
    check(rolls.length === 2, 'exactly two rolls for the hover and the leave', rolls);
    const [rollUp, rollDown] = rolls;
    check(!!rollUp && rollUp.from === 'Do not disturb' && rollUp.to === 'mebaruser' && !/down/.test(rollUp.cls), 'the reveal rolled upwards', rollUp);
    check(!!rollDown && rollDown.from === 'mebaruser' && rollDown.to === 'Do not disturb' && /down/.test(rollDown.cls), 'the restore rolled downwards', rollDown);
    for (const r of [rollUp, rollDown]) {
      check(!!r && Math.abs(Math.abs(r.gap) - r.wrapH) <= 0.6, 'the two lines stay one cell apart (a rigid strip)', r);
      check(!!r && r.anims.every((a) => a.endsWith(':running')), 'with both halves animating', r && r.anims);
    }
    check(pageErrors.length === 0, 'no uncaught page errors', pageErrors.slice(0, 3));
  } finally {
    try { if (ws) ws.close(); } catch {}
    try { if (chrome) chrome.kill(); } catch {}
    try { if (child) child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? `${failures.length} FAILED, ${passed} passed` : `all ${passed} checks passed`));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

main().catch((e) => { console.error('[test] ' + ((e && e.stack) || e)); process.exit(1); });
