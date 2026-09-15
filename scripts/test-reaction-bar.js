// The reaction bar: how many DIFFERENT emoji one message may carry, and the
// count roll that has to survive the socket echo.
//
// The requests:
//   - one message carries at most REACTION_KINDS_MAX different emoji, enforced
//     by the server on BOTH message kinds (channel and DM) whatever the client
//     does;
//   - piling onto an emoji the message already carries is always allowed, even
//     at the cap (the cap is on KINDS, never on how many people may agree);
//   - taking your own reaction back frees a slot for a new kind;
//   - the client refuses a new kind at the cap WITHOUT a request and says why;
//   - adding to an existing reaction ROLLS its number up (an odometer tick), and
//     that roll survives the server's own echo of the reaction just made. This
//     is the whole point of patching the bar pill by pill: the echo used to
//     rebuild the bar and tear down the animation that had just started, so the
//     number appeared to jump.
//
// Postgres is needed for [A] (offline wiring + the server rules), Chrome for
// [B] (the roll, in the real app). Either half skips on its own.
//
// Usage: node scripts/test-reaction-bar.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_reaction_bar_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3444', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const KINDS = 20;
// Distinct, unambiguous, and outside the quick-reaction defaults so nothing the
// client bakes into a hover bar can collide with them.
const POOL = [...'🍎🍐🍊🍋🍌🍉🍇🍓🫐🍒🍑🥭🍍🥥🥝🍅🥑🥦🌽🥕🥔🧄🧅🍄🥜🌰🍞🥐🥖🧀🍗🍖🌭🍔🍟🍕🥚🍳'];

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const messages = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const auth = fs.readFileSync(path.join(ROOT, 'public/js/auth.js'), 'utf8');

console.log('\n[0] the wiring');
check(/const REACTION_KINDS_MAX = \d+;/.test(serverSrc) && /REACTION_KINDS_MAX = 20/.test(serverSrc),
  'one constant owns the cap');
check(/reactionSlotFree\('message_reactions', 'messages'/.test(serverSrc) && /reactionSlotFree\('dm_reactions', 'dm_messages'/.test(serverSrc),
  'both routes go through the same slot check, each with its own table');
check(/maxReactions: REACTION_KINDS_MAX/.test(serverSrc), 'and the client is told the number by /api/config');
check(/maxReactions: 20/.test(core) && (core.match(/maxReactions/g) || []).length >= 1, 'the client carries it as a default');
check((auth.match(/if \(cfg\??\.maxReactions\)/g) || []).length === 2, 'both boot paths take the server\'s number');
check(/too_many_reactions/.test(serverSrc), 'a new kind past the cap is refused, not silently dropped');
// The roll's two load-bearing pieces: the pending number is what "did it grow?"
// is asked against, and the bar is patched pill by pill (the `;` keeps this
// honest against the comment that names the call it must not make).
check(/function pillCount\(b\)/.test(messages) && /querySelector\('\.rc-new'\)/.test(messages),
  'the count reads the pending copy while a roll is running');
check(/function patchMessageReactions/.test(messages) && !/cur\.replaceWith\(next\);/.test(messages),
  'the bar is never rebuilt wholesale (that is what killed the roll)');
check(/b\.classList\.toggle\('me'/.test(messages.slice(messages.indexOf('function patchMessageReactions'))),
  'an existing pill is updated in place');

async function main() {
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-rx-bar-'));
  let child = null;
  let db = null;
  const bearer = (t) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
  const post = async (p, tok, body) => {
    const r = await fetch(BASE + p, { method: 'POST', headers: bearer(tok), body: JSON.stringify(body || {}) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  const get = async (p, tok) => {
    const r = await fetch(BASE + p, { headers: bearer(tok) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };

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
        JWT_SECRET: 'test-reaction-bar',
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

    // ---------- [A] the cap, server-side ----------
    console.log('\n[A1] a channel message');
    const reg = async (username) => (await (await fetch(BASE + '/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, displayName: username, password: 'passw0rd!x' }),
    })).json());
    const alice = await reg('rxbaralice');
    const bob = await reg('rxbarbob');
    check(!!alice.token && !!bob.token, 'two accounts', { a: !!alice.token, b: !!bob.token });

    const made = await post('/api/servers', alice.token, { name: 'Bar Lab' });
    const srv = made.data.server;
    const chan = (srv?.channels || []).find((c) => c.type === 'text');
    check(!!srv?.id && !!chan?.id, 'a server with a text channel', { sid: srv?.id, cid: chan?.id });
    check(!!made.data.invite?.code, 'and an invite code to bring Bob in');
    const joined = await post('/api/servers/join', bob.token, { inviteCode: made.data.invite.code });
    check(joined.status === 200 && !!joined.data.server, 'Bob joins', joined.status);

    // A message, over the same socket frame the composer sends.
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(alice.token)}`, { perMessageDeflate: false });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.send(JSON.stringify({ t: 'subscribe' }));
    await sleep(150);
    ws.send(JSON.stringify({ t: 'message', serverId: srv.id, channelId: chan.id, content: 'tick tock', attachments: [], replyTo: null, threadRoot: null }));
    let mid = null;
    for (let i = 0; i < 40 && !mid; i++) {
      await sleep(150);
      const h = await get(`/api/servers/${srv.id}/channels/${chan.id}/messages?limit=10`, alice.token);
      const list = Array.isArray(h.data) ? h.data : (h.data.messages || []);
      if (list.length) mid = list[list.length - 1].id;
    }
    ws.close();
    check(!!mid, 'the message landed', mid);

    const react = (tok, id, emoji) => post(`/api/messages/${id}/reactions`, tok, { emoji });
    console.log('\n[A2] the cap is on KINDS');
    let last = null;
    for (let i = 0; i < KINDS; i++) last = await react(bob.token, mid, POOL[i]);
    check(last.status === 200, `${KINDS} different emoji all land`, last.status);
    const with20 = await get(`/api/servers/${srv.id}/channels/${chan.id}/messages?limit=10`, alice.token);
    const list20 = Array.isArray(with20.data) ? with20.data : (with20.data.messages || []);
    const kinds20 = list20.find((m) => m.id === mid)?.reactions?.length;
    check(kinds20 === KINDS, `the message carries exactly ${KINDS} kinds`, { kinds: kinds20 });

    const over = await react(bob.token, mid, POOL[KINDS]);
    check(over.status === 409 && over.data.error === 'too_many_reactions' && over.data.max === KINDS,
      `the ${KINDS + 1}th different emoji is refused with the number`, { status: over.status, body: over.data });

    const pile = await react(alice.token, mid, POOL[0]);
    const pileRow = (pile.data.reactions || []).find((r) => r.emoji === POOL[0]);
    check(pile.status === 200 && pileRow && pileRow.count === 2,
      'at the cap, a second person may still pile onto an existing emoji', { status: pile.status, row: pileRow });

    const off = await react(bob.token, mid, POOL[1]);
    check(off.status === 200 && !(off.data.reactions || []).some((r) => r.emoji === POOL[1]),
      'taking my own reaction back still works at the cap', { status: off.status });
    const reuse = await react(bob.token, mid, POOL[KINDS]);
    check(reuse.status === 200, 'and it frees the slot for the emoji that was refused', { status: reuse.status });

    console.log('\n[A3] the same rule on a DM');
    // A 1:1 DM needs no friendship (a group would: "add_friend_first").
    const dmThread = await post('/api/dms', alice.token, { userId: bob.user.id });
    const tid = dmThread.data.thread?.id;
    check(!!tid, 'a DM between the two', { status: dmThread.status, tid });
    const dws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(alice.token)}`, { perMessageDeflate: false });
    await new Promise((res, rej) => { dws.once('open', res); dws.once('error', rej); });
    dws.send(JSON.stringify({ t: 'subscribe' }));
    await sleep(150);
    dws.send(JSON.stringify({ t: 'dm', threadId: tid, content: 'dm tick tock', attachments: [], replyTo: null }));
    let dmid = null;
    for (let i = 0; i < 40 && !dmid; i++) {
      await sleep(150);
      const h = await get(`/api/dms/${tid}/messages?limit=10`, alice.token);
      const dl = Array.isArray(h.data) ? h.data : (h.data.messages || []);
      if (dl.length) dmid = dl[dl.length - 1].id;
    }
    dws.close();
    check(!!dmid, 'the DM message landed', dmid);
    let dlast = null;
    for (let i = 0; i < KINDS && dmid; i++) dlast = await post(`/api/dms/messages/${dmid}/reactions`, bob.token, { emoji: POOL[i] });
    const dover = await post(`/api/dms/messages/${dmid}/reactions`, bob.token, { emoji: POOL[KINDS] });
    check(dover.status === 409 && dover.data.error === 'too_many_reactions',
      'the DM route caps at the same number', { status: dover.status, body: dover.data });

    // ---------- [B] the roll, in the real app ----------
    const chromePath = findChrome();
    if (!chromePath) {
      console.log('\n[B] skipped: no Chrome/Edge found (set CHROME_PATH)');
    } else {
      console.log('\n[B] the count roll in a real browser');
      const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9353', 10);
      const chrome = spawn(chromePath, [
        '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(tmp, 'chrome')}`,
        '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
        '--window-size=1200,900', 'about:blank',
      ], { stdio: 'ignore' });
      let cws = null;
      try {
        let ver = null;
        for (let i = 0; i < 80 && !ver; i++) {
          try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch {}
          if (!ver) await sleep(250);
        }
        if (!ver) throw new Error('Chrome did not expose the DevTools port');
        const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
        cws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
        await new Promise((res, rej) => { cws.once('open', res); cws.once('error', rej); });
        let msgId = 0; const pending = new Map(); const pageErrors = [];
        cws.on('message', (raw) => {
          const m = JSON.parse(raw.toString());
          if (m.id && pending.has(m.id)) {
            const { res, rej } = pending.get(m.id); pending.delete(m.id);
            if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
          } else if (m.method === 'Runtime.exceptionThrown') {
            pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
          }
        });
        const send = (method, params = {}) => new Promise((res, rej) => { const i = ++msgId; pending.set(i, { res, rej }); cws.send(JSON.stringify({ id: i, method, params })); });
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
          const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'rxbarviewer', displayName: 'Viewer', password: 'passw0rd!x' }) });
          const d = await r.json(); store.token = d.token; store.sid = d.sid; return { ok: !!d.token, token: d.token, uid: d.user && d.user.id };
        })()`);
        await send('Page.reload');
        await sleep(2500);
        check(!!(await waitFor(`S.me && S.me.username === 'rxbarviewer'`)), 'the viewer signs in');

        const set = await evaluate(`(async () => {
          const r = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: 'Roll Lab' }) });
          await refreshServers(r.server.id);
          if (S.ws) S.ws.send(JSON.stringify({ t: 'subscribe' }));
          await selectServer(r.server.id);
          await new Promise((res) => setTimeout(res, 400));
          sendChat('tick tock');
          const inv = await api('/api/servers/' + r.server.id + '/invites', { method: 'POST', body: JSON.stringify({}) });
          return { sid: r.server.id, code: inv.invite.code };
        })()`);
        const vmid = await waitFor(`(() => { const e = [...document.querySelectorAll('#messages .msg[data-mid]')]; return e.length ? e[e.length - 1].dataset.mid : null })()`);
        check(!!set.sid && !!vmid, 'a channel and a message to react to', { set, vmid });

        const third = await reg('rxbarcarol');
        await post('/api/servers/join', third.token, { inviteCode: set.code });
        const first = await post(`/api/messages/${vmid}/reactions`, third.token, { emoji: '🎉' });
        check(first.status === 200, 'somebody else starts the pill', first.status);
        const pillSel = `#messages .msg[data-mid="${vmid}"] .reaction[data-emoji="🎉"]`;
        check(!!(await waitFor(`document.querySelector(${JSON.stringify(pillSel)})`)), 'the pill is on screen');

        const rolled = await evaluate(`(async () => {
          const pill = document.querySelector(${JSON.stringify(pillSel)});
          const same = (a, b) => a === b;
          pill.click();
          await new Promise((r) => setTimeout(r, 40));
          const p1 = document.querySelector(${JSON.stringify(pillSel)});
          const mid40 = { present: !!p1.querySelector('.rc-roll'), sameNode: same(p1, pill),
            old: (p1.querySelector('.rc-old') || {}).textContent, next: (p1.querySelector('.rc-new') || {}).textContent,
            anim: (p1.querySelector('.rc-old') && p1.querySelector('.rc-old').getAnimations) ? p1.querySelector('.rc-old').getAnimations().map((a) => a.playState) : [] };
          await new Promise((r) => setTimeout(r, 900));
          const p2 = document.querySelector(${JSON.stringify(pillSel)});
          return { mid40, end: { present: !!p2.querySelector('.rc-roll'), text: (p2.querySelector('.rcount') || {}).textContent,
            sameNode: same(p2, pill), me: p2.classList.contains('me'), title: p2.title } };
        })()`);
        check(rolled.mid40.present === true, 'the number is rolling while the echo lands', rolled.mid40);
        check(rolled.mid40.anim.includes('running'), 'and the animation is really running', rolled.mid40.anim);
        check(rolled.mid40.sameNode === true && rolled.end.sameNode === true,
          'the pill is never replaced under it (the animation keeps its node)', { mid: rolled.mid40.sameNode, end: rolled.end.sameNode });
        check(rolled.end.present === false && rolled.end.text === '2', 'then it settles on the new count', rolled.end);
        check(rolled.end.me === true && /Viewer/.test(rolled.end.title || ''),
          'and the pill knows I am on it, with the tooltip updated', { me: rolled.end.me, title: rolled.end.title });

        // The drum's geometry, measured rather than eyeballed: the window hugs
        // the digits (a full line-height window leaves a hole between the two
        // halves), the ink fits inside it at rest, and the two copies stay
        // exactly one cell apart for the whole roll — a rigid strip, which is
        // what "odometer" means. Two easing curves moving the halves at
        // different rates is what made it look like it morphed.
        const drum = await evaluate(`(() => {
          const count = document.querySelector(${JSON.stringify(pillSel)} + ' .rcount');
          const cv = document.createElement('canvas').getContext('2d');
          const cs = getComputedStyle(count);
          cv.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
          const m = cv.measureText('9');
          const box = count.getBoundingClientRect();
          const W = parseFloat(cs.height);
          const T = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
          const baseline = (W - T) / 2 + m.fontBoundingBoxAscent;
          return { W: +W.toFixed(2), ink: +m.actualBoundingBoxAscent.toFixed(2), color: cs.color,
            inkTop: +(baseline - m.actualBoundingBoxAscent).toFixed(2), inkBottom: +baseline.toFixed(2),
            restH: +box.height.toFixed(2), lineH: cs.lineHeight, fontSize: cs.fontSize };
        })()`);
        check(drum.W < parseFloat(drum.fontSize) * 1.1, 'the drum window is tighter than a full line box', drum);
        check(drum.inkTop >= 0 && drum.inkBottom <= drum.W, 'and the digits sit inside it uncut', drum);

        // UP (somebody else adds) then DOWN (they take it back), watched by a
        // MutationObserver so the transient roll cannot be missed.
        await evaluate(`(() => {
          window.__rolls = [];
          new MutationObserver((muts) => {
            for (const m of muts) for (const n of (m.addedNodes || [])) {
              if (n.nodeType !== 1) continue;
              const wrap = n.classList && n.classList.contains('rc-roll') ? n : (n.querySelector ? n.querySelector('.rc-roll') : null);
              if (!wrap || wrap.dataset.logged) continue;
              wrap.dataset.logged = '1';
              const o = wrap.querySelector('.rc-old'), nw = wrap.querySelector('.rc-new');
              const wr = wrap.getBoundingClientRect();
              const rec = { cls: wrap.className, wrapH: +wr.height.toFixed(2),
                gap: +((nw.getBoundingClientRect().top - wr.top) - (o.getBoundingClientRect().top - wr.top)).toFixed(2),
                from: o.textContent, to: nw.textContent };
              requestAnimationFrame(() => requestAnimationFrame(() => {
                rec.anims = [...o.getAnimations(), ...nw.getAnimations()].map((a) => a.animationName + ':' + a.playState);
                window.__rolls.push(rec);
              }));
            }
          }).observe(document.body, { childList: true, subtree: true });
          return true;
        })()`);
        const heartSel = `#messages .msg[data-mid="${vmid}"] .reaction[data-emoji="❤️"]`;
        await post(`/api/messages/${vmid}/reactions`, third.token, { emoji: '❤️' });
        check(!!(await waitFor(`document.querySelector(${JSON.stringify(heartSel)})`)), 'a heart pill appears (no roll yet — it is new)');
        // My own reaction, through the real click path: the local patch rolls it
        // and the socket echo a few ms later must not cut that short.
        await evaluate(`toggleReaction(${JSON.stringify(vmid)}, '❤️')`);
        check(!!(await waitFor(`(() => { const p = document.querySelector(${JSON.stringify(heartSel)}); return p && (p.querySelector('.rcount') || {}).textContent === '2' })()`)),
          'a second person on it rolls it up to 2');
        await sleep(400);
        await post(`/api/messages/${vmid}/reactions`, third.token, { emoji: '❤️' });
        check(!!(await waitFor(`(() => { const p = document.querySelector(${JSON.stringify(heartSel)}); return p && (p.querySelector('.rcount') || {}).textContent === '1' })()`)),
          'and taking one back rolls it down to 1');
        await sleep(400);

        const rolls = await evaluate(`window.__rolls`);
        check(rolls.length === 2, 'both changes rolled (the removal did not just snap)', rolls);
        const [up, down] = rolls;
        check(!!up && up.cls === 'rc-roll' && up.from === '1' && up.to === '2', 'the addition rolled upwards', up);
        check(!!down && down.cls === 'rc-roll down' && down.from === '2' && down.to === '1', 'the removal rolled downwards', down);
        for (const r of [up, down]) {
          check(!!r && Math.abs(Math.abs(r.gap) - r.wrapH) <= 0.6, 'the two digits stay exactly one cell apart (a rigid strip)', r);
          check(!!r && r.anims.every((a) => a.endsWith(':running')), 'with both halves animating', r && r.anims);
        }

        const refused = await evaluate(`(async () => {
          const m = msgById(${JSON.stringify(vmid)});
          const max = Number(S.maxReactions) || 20;
          const have = new Set((m.reactions || []).map((r) => r.emoji));
          const pool = ${JSON.stringify(POOL)}.filter((e) => !have.has(e));
          const tok = ${JSON.stringify(third.token)};
          for (const e of pool.slice(0, max - have.size)) {
            await fetch('/api/messages/' + m.id + '/reactions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ emoji: e }) });
          }
          const fresh = await api('/api/servers/' + S.serverId + '/channels/' + S.channelId + '/messages?limit=5');
          const list = Array.isArray(fresh) ? fresh : (fresh.messages || []);
          const now = (list.find((x) => x.id === m.id) || {}).reactions || [];
          updateMsgInCaches(m.id, (x) => { x.reactions = now; });
          patchMessageReactions(m.id, document.querySelector('#messages'));
          let calls = 0; const realApi = window.api; const realToast = window.toast;
          const said = [];
          window.api = async (...a) => { calls++; return realApi(...a); };
          window.toast = (t) => { said.push(t); };
          await toggleReaction(m.id, '🦄');
          window.api = realApi; window.toast = realToast;
          return { kinds: now.length, max, calls, toast: said[0] || null };
        })()`);
        check(refused.kinds === refused.max, 'the bar is filled to the cap', refused);
        check(refused.calls === 0 && /different reactions/.test(String(refused.toast)),
          'the client refuses a new kind without a request, and says why', refused);
        check(pageErrors.length === 0, 'no uncaught page errors', pageErrors.slice(0, 3));
      } finally {
        try { if (cws) cws.close(); } catch {}
        try { chrome.kill(); } catch {}
      }
    }
  } finally {
    try { if (child) child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? `${failures.length} FAILED, ${passed} passed` : `all ${passed} checks passed`));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

main().catch((e) => { console.error('[test] ' + ((e && e.stack) || e)); process.exit(1); });
