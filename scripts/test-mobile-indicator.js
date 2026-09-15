// The avatar-corner status indicator becomes a phone when its owner is on a
// phone.
//
// The request: "make the status indicator circle the one in the corner of
// profile pics across the app appear as a little green/yellow/red phone icon
// instead of a dot if the user is active on their mobile device."
//
// So the dot keeps its status colour (green online / amber away / red dnd) and
// gains a phone knocked out of it. Two halves have to hold for that to be true
// anywhere in the app:
//
//   1. the SERVER knows a socket is a phone (`/ws?device=mobile` -> a
//      live_sessions row -> `mobile` maps on every presence roster and a
//      `user-mobile` push when a phone socket goes away) AND which of the
//      account's devices is in front (`visible_at`, a lease the client renews
//      every ~25s) — "any live phone socket" read as ON A PHONE for minutes
//      after its owner had moved to a desktop, and
//   2. every avatar-corner dot in the client is painted through the ONE helper
//      that reads that map (dotHTML) — a row that inlines its own
//      `<span class="status-dot …">` would silently stay a dot.
//
// Static checks run everywhere; the pixel checks need Chrome/Edge (the mask is
// what actually paints the glyph, and only a browser can say it resolved), and
// the protocol checks need Postgres (they drive two real sockets against a
// throwaway database and give up quietly without it).
//
// Usage: node scripts/test-mobile-indicator.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { decodePNG } = require('./png-util.js');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_mobile_ind';
const PORT = parseInt(process.env.TEST_PORT || '3427', 10);
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
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
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

const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const servers = fs.readFileSync(path.join(ROOT, 'public/js/servers.js'), 'utf8');
const home = fs.readFileSync(path.join(ROOT, 'public/js/home.js'), 'utf8');
const socket = fs.readFileSync(path.join(ROOT, 'public/js/socket.js'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const db = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');

// The real helpers, run with stub globals (no bundler and no exports here).
const DOT_SRC = slice(servers, 'function isOff(st)', '// ---------- game activity badge');

function dotHelpers(presenceMobile, me, isMobile) {
  const code = 'var S = ' + JSON.stringify({ me, presenceMobile }) + ';\n'
    + 'function deviceIsMobile() { return ' + (isMobile ? 'true' : 'false') + '; }\n'
    + DOT_SRC + '\n;({ dotHTML, onMobileNow, dotOf, isOff })';
  return eval(code);
}
const DOT_ON = '<span class="status-dot online"></span>';
const DOT_PHONE = '<span class="status-dot online phone" title="On mobile"></span>';

// The real device classification, with a fake navigator.
const DEVICE_SRC = slice(core, 'function deviceIsMobile() {', '// ---------- conversation swap');
function deviceFor(nav) {
  return new Function('navigator', DEVICE_SRC + '\n;return deviceIsMobile();')(nav);
}

function pageHtml() {
  const color = [
    '.member .avwrap,.dmrow .avwrap{position:relative;width:28px;height:28px;flex-shrink:0}',
    '.anow-tile .avwrap{position:relative;width:40px;height:40px;flex:0 0 auto}',
    '#me-card .avwrap{position:relative;width:32px;height:32px}',
  ].join('\n');
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css">
<style>
  html,body{margin:0;background:var(--panel)}
  ${color}
  .harness{display:flex;align-items:flex-start;gap:30px;padding:30px}
  .box{display:flex;flex-direction:column;align-items:center;gap:6px}
  .avwrap .avatar{width:100%;height:100%;background:#5865f2}
</style></head><body>
<div class="harness"></div>
<script>
const S = { me: { id: 'me' }, presenceMobile: { remote: 1 } };
function deviceIsMobile() { return false; }
${DOT_SRC}
// One box per real context the corner dot lives in, plus the two controls that
// must NOT get a phone: no flag, and a flag on someone who is offline.
const CASES = [
  ['member-plain',   'member',    'other',  'online'],
  ['member-phone',   'member',    'remote', 'online'],
  ['dmrow-phone',    'dmrow',     'remote', 'away'],
  ['anow-phone',     'anow-tile', 'remote', 'dnd'],
  ['me-phone',       'me-card',   'remote', 'online'],
  ['stream-phone',   'member',    'remote', 'streaming'],
  ['offline-flag',   'member',    'remote', 'offline'],
];
// 'me' answers from the DEVICE as well as the roster; this page is a desktop,
// so the flag itself has to carry it.
S.presenceMobile.me = 1;
const host = document.querySelector('.harness');
for (const [key, ctx, uid, dot] of CASES) {
  const box = document.createElement('div');
  box.className = 'box';
  const inner = '<span class="avwrap st-' + dot + '"><span class="avatar"></span>'
    + dotHTML(uid, dot) + '</span>';
  if (ctx === 'me-card') box.innerHTML = '<div id="me-card">' + inner + '</div>';
  else box.innerHTML = '<div class="' + ctx + '">' + inner + '</div>';
  host.appendChild(box);
  const dotEl = box.querySelector('.status-dot');
  dotEl.dataset.key = key;
  const cs = getComputedStyle(dotEl);
  const af = getComputedStyle(dotEl, '::after');
  const r = dotEl.getBoundingClientRect();
  box.dataset.probe = JSON.stringify({
    key,
    cls: dotEl.className,
    title: dotEl.title,
    bg: cs.backgroundColor,
    w: cs.width, h: cs.height, radius: cs.borderTopLeftRadius,
    shadow: cs.boxShadow,
    mask: af.maskImage || af.webkitMaskImage || '',
    maskSize: af.maskSize || af.webkitMaskSize || '',
    maskPos: af.maskPosition || af.webkitMaskPosition || '',
    afBg: af.backgroundColor,
    afW: af.width, afH: af.height,
    x: r.left, y: r.top, rw: r.width, rh: r.height,
  });
}
window.__out = { dpr: devicePixelRatio, boxes: [...document.querySelectorAll('.box')].map((b) => JSON.parse(b.dataset.probe)) };
document.title = JSON.stringify(window.__out);
</script></body></html>`;
}

function shot(chrome, html, dpr, dir) {
  const p = path.join(dir, 'p.html');
  fs.writeFileSync(p, html);
  const png = path.join(dir, 'ind-' + dpr + '.png');
  const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof-' + dpr),
    '--force-device-scale-factor=' + dpr, '--window-size=760,180',
    '--virtual-time-budget=2500', '--screenshot=' + png, '--dump-dom', 'file:///' + p.replace(/\\/g, '/')],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
  if (!m) return { err: 'no title, status ' + r.status };
  const out = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  out.png = fs.existsSync(png) ? decodePNG(png) : null;
  return out;
}

// ---------- the live protocol (throwaway database; skips without Postgres) ----------
// The static half can only prove the shape of the code. This drives two real
// sockets: one desktop that watches, and one that claims to be a phone, and
// then closes while a desktop socket of the SAME account is still open — which
// is the case that decides between "mobile: 0" and "offline".
async function protocolPhase() {
  let Client, WebSocket;
  try { ({ Client } = require('pg')); WebSocket = require('ws'); }
  catch (e) { console.log('\n[7] live-protocol checks SKIPPED — ' + ((e && e.message) || e)); return; }
  const envFile = readEnvFile();
  const pg = {
    host: process.env.PGHOST || envFile.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || envFile.POSTGRES_USER || 'campfire',
    password: process.env.PGPASSWORD || envFile.POSTGRES_PASSWORD || '',
  };
  const admin = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
  try { await admin.connect(); }
  catch (e) {
    console.log('\n[7] live-protocol checks SKIPPED — Postgres unreachable (' + ((e && e.message) || e) + ')');
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-mobile-e2e-'));
  let child = null, db = null;
  const sockets = [];
  const req = async (method, p, { token, body } = {}) => {
    const r = await fetch(BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(d)}`);
    return d;
  };
  const open = (token, device) => new Promise((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}` + (device ? '&device=' + device : ''));
    w.events = [];
    w.on('message', (raw) => { try { w.events.push(JSON.parse(raw.toString())); } catch {} });
    w.once('open', () => res(w));
    w.once('error', rej);
  });
  const waitFor = async (fn, ms = 5000) => {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try { v = fn(); } catch {}
      if (v) return v;
      if (Date.now() - t0 > ms) return null;
      await sleep(100);
    }
  };
  const rosterFor = (w, sid) => [...w.events].reverse()
    .find((e) => e.t === 'presence' && (sid ? e.serverId === sid : !e.serverId));
  const pushFor = (w, t, uid) => [...w.events].reverse().find((e) => e.t === t && (!uid || e.userId === uid));
  const devicesOf = async (uid) => {
    const r = await db.query('SELECT device FROM live_sessions WHERE user_id = $1 ORDER BY device', [uid]);
    return r.rows.map((x) => x.device);
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
        JWT_SECRET: 'test-mobile-ind-secret', UPLOAD_DIR: path.join(tmp, 'uploads'),
        // The lease-expiry check watches the leader-locked reconcile pass move a
        // flag that no frame can move, so it must not wait out the 30s cadence.
        RECONCILE_EVERY_MS: '1500',
        // Same for the timed-status sweep: a lapse has to be watchable without
        // waiting out the production minute.
        STATUS_SWEEP_EVERY_MS: '1000',
        VIRUS_SCAN: '0', MEDIA_COMPRESS: '0', UNFURL: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try { up = (await fetch(BASE + '/api/config')).ok; } catch {}
      if (!up) await sleep(250);
    }
    if (!up) throw new Error('server did not come up\n' + log.slice(-2000));

    console.log('\n[7] the live protocol: a phone socket is a phone, and stops being one');
    const reg = async (username, displayName) => req('POST', '/api/register', { body: { username, displayName, password: 'passw0rd!x' } });
    const alf = await reg('alf', 'Alf');
    const bee = await reg('bee', 'Bee');
    const cal = await reg('cal', 'Cal');
    const made = await req('POST', '/api/servers', { token: alf.token, body: { name: 'Mobile Lab' } });
    const sid = made.server.id;
    await req('POST', '/api/servers/join', { token: bee.token, body: { inviteCode: made.invite.code } });
    db = new Client({ ...pg, database: TEST_DB });
    await db.connect();

    // Alf watches from a desktop.
    const a = await open(alf.token);
    sockets.push(a);
    a.send(JSON.stringify({ t: 'subscribe' }));
    await sleep(400);

    // Bee opens the app on a phone.
    const phone = await open(bee.token, 'mobile');
    sockets.push(phone);
    phone.send(JSON.stringify({ t: 'subscribe' }));
    const ann = await waitFor(() => { const e = pushFor(a, 'user-online', bee.user.id); return e && e.mobile === 1 ? e : null; });
    check(!!ann, 'user-online reaches the watcher with mobile:1', ann && { mobile: ann.mobile });
    a.send(JSON.stringify({ t: 'subscribe' }));
    const ros = await waitFor(() => { const e = rosterFor(a, sid); return e && e.online && e.online[bee.user.id] ? e : null; });
    check(!!ros && ros.mobile && ros.mobile[bee.user.id] === 1, 'and the server roster carries the phone beside the status', ros && ros.mobile);
    check(!!ros && ros.online[bee.user.id] === 'online', 'with the ordinary status untouched', ros && ros.online[bee.user.id]);
    check(!!ros && !ros.mobile[alf.user.id], 'a desktop socket is not one', ros && ros.mobile);

    check(JSON.stringify(await devicesOf(bee.user.id)) === '["mobile"]',
      'live_sessions.device really holds it (the migration ran)', await devicesOf(bee.user.id));

    // A claim the server does not recognise must not reach the column.
    const tab = await open(cal.token, 'tablet');
    sockets.push(tab);
    tab.send(JSON.stringify({ t: 'subscribe' }));
    await sleep(400);
    check(JSON.stringify(await devicesOf(cal.user.id)) === '[""]',
      'an unrecognised device claim is refused, not stored', await devicesOf(cal.user.id));

    // A socket that dies INSIDE the handshake — before the server has even
    // attached its close handler — must not leave a registry row behind. With
    // the phone indicator such a zombie row would keep painting a phone on
    // someone who is not on one, for as long as the replica lives.
    const dee = await reg('dee', 'Dee');
    const doomed = await open(dee.token, 'mobile');
    sockets.push(doomed);
    doomed.close();
    await sleep(1500);
    check((await devicesOf(dee.user.id)).length === 0,
      'a socket that dies mid-handshake leaves no row (no zombie phone)', await devicesOf(dee.user.id));

    // Friend-scoped, not just server-scoped: a friend you share no server with
    // sees the phone too (that is the roster with no serverId).
    await db.query('INSERT INTO friendships (user_a, user_b, status, action_by, created_at) VALUES ($1,$2,$3,$4,$5)',
      [alf.user.id < bee.user.id ? alf.user.id : bee.user.id, alf.user.id < bee.user.id ? bee.user.id : alf.user.id, 'accepted', alf.user.id, Date.now()]);
    a.send(JSON.stringify({ t: 'subscribe' }));
    const friendRos = await waitFor(() => { const e = rosterFor(a, null); return e && e.online && e.online[bee.user.id] ? e : null; });
    check(!!friendRos && friendRos.mobile && friendRos.mobile[bee.user.id] === 1,
      'the friend roster carries it too (a friend with no shared server)', friendRos && friendRos.mobile);

    // Second Bee socket, desktop: the flag belongs to the ACCOUNT.
    const desk = await open(bee.token);
    sockets.push(desk);
    desk.send(JSON.stringify({ t: 'subscribe' }));
    const ann2 = await waitFor(() => { const e = pushFor(a, 'user-online', bee.user.id); return e && e.mobile === 1 ? e : null; });
    check(!!ann2, 'a desktop socket arriving does not clear the account\'s phone flag', ann2 && { mobile: ann2.mobile });

    // …and closing that desktop socket changes nothing about it.
    const beforeCount = a.events.filter((e) => e.t === 'user-mobile').length;
    desk.close();
    await sleep(900);
    check(a.events.filter((e) => e.t === 'user-mobile').length === beforeCount,
      'a desktop socket closing says nothing about the phone (no needless push)',
      a.events.filter((e) => e.t === 'user-mobile').map((e) => e.mobile));
    check(!a.events.some((e) => e.t === 'user-offline' && e.userId === bee.user.id),
      'and Bee is not reported offline while the phone socket is still live');

    // Now: a phone socket closing while a desktop socket holds the account open.
    const desk2 = await open(bee.token);
    sockets.push(desk2);
    desk2.send(JSON.stringify({ t: 'subscribe' }));
    await sleep(400);
    phone.close();
    const off = await waitFor(() => { const e = pushFor(a, 'user-mobile', bee.user.id); return e && e.mobile === 0 ? e : null; });
    check(!!off, 'the phone going away pushes user-mobile:0', off && { mobile: off.mobile });
    check(!a.events.some((e) => e.t === 'user-offline' && e.userId === bee.user.id),
      'and NOT offline — the desktop socket still holds the account', a.events.filter((e) => e.t === 'user-offline').map((e) => e.userId));
    check(JSON.stringify(await devicesOf(bee.user.id)) === '[""]', 'the reaped phone row is gone from the registry', await devicesOf(bee.user.id));

    // ---- the lease: which device is IN FRONT decides, and it can lapse ----
    // Driven by the account's own second socket (the observer), so it needs no
    // friendship and no other account: a client is exactly as good a witness of
    // "they moved to the desktop" as anybody else.
    console.log('\n[7b] the page-in-front lease decides the flag');
    const eve = await reg('eve', 'Eve');
    await req('POST', '/api/servers/join', { token: eve.token, body: { inviteCode: made.invite.code } });
    const lastMobile = (w) => [...w.events].reverse().find((e) => e.t === 'user-mobile' && e.userId === eve.user.id);
    const edesk = await open(eve.token);
    sockets.push(edesk);
    edesk.send(JSON.stringify({ t: 'subscribe' }));
    await sleep(300);
    edesk.send(JSON.stringify({ t: 'visibility', visible: true })); // the desktop is in front
    await sleep(400);
    const ephone = await open(eve.token, 'mobile');
    sockets.push(ephone);
    ephone.send(JSON.stringify({ t: 'subscribe' }));
    ephone.send(JSON.stringify({ t: 'visibility', visible: true })); // the phone is in hand
    const lm1 = await waitFor(() => { const e = lastMobile(edesk); return e && e.mobile === 1 ? e : null; });
    check(!!lm1, 'a phone that reports its page in front is announced as mobile', lastMobile(edesk) || null);

    // The reported bug, end to end: the phone is put down (its page goes
    // hidden) and the desktop keeps being used.
    ephone.send(JSON.stringify({ t: 'visibility', visible: false }));
    const lm0 = await waitFor(() => { const e = lastMobile(edesk); return e && e.mobile === 0 ? e : null; });
    check(!!lm0, 'the phone going to the background hands the indicator back to the desktop at once', lastMobile(edesk) || null);
    check(JSON.stringify(await devicesOf(eve.user.id)) === '["","mobile"]',
      'the phone socket is still live and registered — only the claim moved', await devicesOf(eve.user.id));

    // A phone that never reports hidden (app paused, screen off, the visibility
    // frame lost) is the case no frame can cover: its claim has to lapse on a
    // CLOCK. Age its lease in the registry and let the reconcile pass find it —
    // no frame arrives from the phone, and the desktop's own renewal alone could
    // not tell that anything had changed.
    ephone.send(JSON.stringify({ t: 'visibility', visible: true }));
    await waitFor(() => { const e = lastMobile(edesk); return e && e.mobile === 1 ? e : null; });
    await db.query("UPDATE live_sessions SET visible_at = $1 WHERE user_id = $2 AND device = 'mobile'",
      [Date.now() - 10 * 60 * 1000, eve.user.id]);
    const swept = await waitFor(() => { const e = lastMobile(edesk); return e && e.mobile === 0 ? e : null; }, 20000);
    check(!!swept, 'a phone that went quiet without reporting hidden loses the flag on the sweep', lastMobile(edesk) || null);
    // (int8 arrives as a string on this raw client — the app's own wrapper is
    // what parses it back to a number.)
    check(Number((await db.query('SELECT mobile_flag FROM users WHERE id = $1', [eve.user.id])).rows[0].mobile_flag) === 0,
      'and the registry of what clients were told moved with it');

    // Locked in a pocket with nothing else in front is still a phone — the
    // fallback that keeps the indicator from blinking off on a screen lock.
    edesk.send(JSON.stringify({ t: 'visibility', visible: false }));
    const lmBack = await waitFor(() => { const e = lastMobile(edesk); return e && e.mobile === 1 ? e : null; });
    check(!!lmBack, 'with no device in front, the live phone socket counts again', lastMobile(edesk) || null);
    // …and the desktop coming back to the front takes it away without any frame
    // from the phone at all.
    edesk.send(JSON.stringify({ t: 'visibility', visible: true }));
    const lmOff = await waitFor(() => { const e = lastMobile(edesk); return e && e.mobile === 0 ? e : null; });
    check(!!lmOff, 'and the desktop being used takes the indicator back on its own renewal', lastMobile(edesk) || null);

    // ---- the other half of presence: online → Away → Online ----
    // Two things the account has to get right, and both are visible here:
    //   * WHERE an untimed Away came from. Only the idle clock's may be silently
    //     undone by activity, on ANY of the account's devices — a per-browser
    //     localStorage marker let a mouse move on the desktop undo an Away the
    //     user had just picked on the phone.
    //   * a TIMED state lapsing back to Online reaching every audience. Friends
    //     with no shared server were skipped entirely, so a friend who went
    //     invisible (told 'user-offline') stayed a grey dot forever.
    console.log('\n[7c] the idle auto-away is account state, and its lapse is announced');
    const ivy = await reg('ivy', 'Ivy');
    await req('POST', '/api/servers/join', { token: ivy.token, body: { inviteCode: made.invite.code } });
    await db.query('INSERT INTO friendships (user_a, user_b, status, action_by, created_at) VALUES ($1,$2,$3,$4,$5)',
      [alf.user.id < ivy.user.id ? alf.user.id : ivy.user.id, alf.user.id < ivy.user.id ? ivy.user.id : alf.user.id, 'accepted', alf.user.id, Date.now()]);
    a.send(JSON.stringify({ t: 'subscribe' }));
    await sleep(300);

    const setPresence = async (token, body) => (await req('PATCH', '/api/me', { token, body })).user;
    const autoOf = (u) => Number(u.presence_auto);
    let got = await setPresence(ivy.token, { status: 'away', presenceAuto: true });
    check(got.status === 'away' && autoOf(got) === 1,
      'the idle flip records WHERE the Away came from (account state, so every device agrees)', { status: got.status, auto: got.presence_auto });
    check(autoOf((await req('GET', '/api/me', { token: ivy.token })).user) === 1, 'and it is durable — a reload reads the same answer');
    got = await setPresence(ivy.token, { status: 'away' });
    check(autoOf(got) === 0, 'picking the SAME state by hand clears it (the Away is the user\'s from now on)', got.presence_auto);
    await setPresence(ivy.token, { status: 'away', presenceAuto: true });
    got = await setPresence(ivy.token, { status: 'online' });
    check(autoOf(got) === 0, 'and any other status clears it too', got.presence_auto);
    got = await setPresence(ivy.token, { status: 'away', presenceExpiresAt: Date.now() + 3600e3, presenceAuto: true });
    check(autoOf(got) === 0, 'a timed Away is never the idle clock\'s — it owns its own revert', got.presence_auto);

    // Two clocks, one account: a phone in a pocket (hidden) must not read its
    // owner away while the desktop is plainly being used — the desktop's next
    // mouse move would drag them straight back, on a loop nobody can read. A
    // hidden device whose account has NOTHING in front is still allowed to flip:
    // that is the single backgrounded tab whose owner walked off.
    console.log('\n[7c2] a hidden device\'s clock yields to a device that is in front');
    const idesk = await open(ivy.token);
    sockets.push(idesk);
    idesk.send(JSON.stringify({ t: 'subscribe' }));
    idesk.send(JSON.stringify({ t: 'visibility', visible: true }));
    await sleep(400);
    await setPresence(ivy.token, { status: 'online', presenceAuto: false });
    let hidden = await setPresence(ivy.token, { status: 'away', presenceAuto: true, presenceVisible: false });
    check(hidden.status === 'online' && autoOf(hidden) === 0,
      'a hidden device cannot move the account away while the desktop holds a page-in-front lease', { status: hidden.status, auto: hidden.presence_auto });
    hidden = await setPresence(ivy.token, { status: 'away', presenceAuto: true, presenceVisible: true });
    check(hidden.status === 'away' && autoOf(hidden) === 1, 'the device that IS in front still can', { status: hidden.status, auto: hidden.presence_auto });
    await setPresence(ivy.token, { status: 'online' });
    idesk.close();
    await sleep(300);
    hidden = await setPresence(ivy.token, { status: 'away', presenceAuto: true, presenceVisible: false });
    check(hidden.status === 'away' && autoOf(hidden) === 1,
      'and once nothing is in front, the hidden device flips the account again (the walked-away background tab)', { status: hidden.status, auto: hidden.presence_auto });
    await setPresence(ivy.token, { status: 'online' });

    // Invisible with a 1.5s timer: friends hear 'user-offline' at once, and the
    // lapse has to be announced to the SAME audience.
    let at = a.events.length;
    await setPresence(ivy.token, { status: 'invisible', presenceExpiresAt: Date.now() + 1500 });
    check(await waitFor(() => a.events.slice(at).find((e) => e.t === 'user-offline' && e.userId === ivy.user.id), 6000),
      'going invisible reads as offline to a friend');
    at = a.events.length;
    const lap = await waitFor(() => a.events.slice(at).find((e) => e.t === 'user-status' && e.userId === ivy.user.id && e.status === 'online' && !e.serverId), 20000);
    check(!!lap, 'the timed invisible LAPSING reaches the friend-scoped audience (no shared server needed)', lap || null);

    console.log('\n[7d] a status frame carries the phone flag, so invisible→visible gets its glyph back');
    const iphone = await open(ivy.token, 'mobile');
    sockets.push(iphone);
    iphone.send(JSON.stringify({ t: 'subscribe' }));
    iphone.send(JSON.stringify({ t: 'visibility', visible: true }));
    await waitFor(() => { const e = [...a.events].reverse().find((x) => x.t === 'user-online' && x.userId === ivy.user.id); return e && e.mobile === 1 ? e : null; });
    at = a.events.length;
    await setPresence(ivy.token, { status: 'invisible' });
    check(await waitFor(() => a.events.slice(at).find((e) => e.t === 'user-offline' && e.userId === ivy.user.id), 6000),
      'invisible tells friends offline — which is what drops the phone glyph with the status');
    at = a.events.length;
    await setPresence(ivy.token, { status: 'online' });
    const restored = await waitFor(() => a.events.slice(at).find((e) => e.t === 'user-status' && e.userId === ivy.user.id && e.status === 'online' && e.mobile === 1));
    check(!!restored, 'coming back online RESTORES it on the status frame (before, no frame carried the flag and the glyph never returned)', restored || null);
    check(Number((await db.query('SELECT mobile_flag FROM users WHERE id = $1', [ivy.user.id])).rows[0].mobile_flag) === 1,
      'and what clients were told is recorded with it');
  } catch (e) {
    check(false, 'the protocol harness ran', (e && e.message) || e);
  } finally {
    for (const w of sockets) { try { w.close(); } catch {} }
    try { db && await db.end(); } catch {}
    try { child && child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  console.log('\n[1] dotHTML is the one place the corner dot is written');
  const helpers = dotHelpers({ remote: 1 }, { id: 'me' }, false);
  check(helpers.dotHTML('remote', 'online') === DOT_PHONE, 'a live phone session → the phone dot', helpers.dotHTML('remote', 'online'));
  check(helpers.dotHTML('other', 'online') === DOT_ON, 'everyone else keeps the plain dot', helpers.dotHTML('other', 'online'));
  check(helpers.dotHTML('remote', 'offline') === '<span class="status-dot offline"></span>',
    'a stale flag never draws a phone on someone offline', helpers.dotHTML('remote', 'offline'));
  check(helpers.dotHTML(null, 'online') === DOT_ON, 'no id → no phone', helpers.dotHTML(null, 'online'));
  check(helpers.dotHTML('remote', 'streaming') === '<span class="status-dot streaming phone" title="On mobile"></span>',
    'the phone rides the streaming (purple) colour too — the shape says phone, the colour says status');
  check(helpers.dotHTML('remote', 'dnd') === '<span class="status-dot dnd phone" title="On mobile"></span>', 'and red for dnd');
  const selfPhone = dotHelpers({}, { id: 'me' }, true);
  check(selfPhone.dotHTML('me', 'online') === DOT_PHONE, 'my own indicator is a phone on a phone (own device counts)');
  const selfDesk = dotHelpers({ me: 1 }, { id: 'me' }, false);
  check(selfDesk.dotHTML('me', 'online') === DOT_PHONE, 'and on a desktop when the server says my account is on one too');
  const selfBoth = dotHelpers({}, { id: 'me' }, false);
  check(selfBoth.dotHTML('me', 'online') === DOT_ON, 'plain desktop, no phone socket → plain dot');

  // Every avatar-corner dot in the app must come through the helper.
  const inlineDots = (src, name) => {
    const hits = src.match(/<span class="status-dot \$\{[^}]*\}"><\/span>/g) || [];
    check(hits.length === 0, name + ' builds no avatar dot inline (all through dotHTML)', hits);
  };
  inlineDots(home, 'home.js');
  inlineDots(slice(servers, 'function memberRowEl(', 'function memberSort('), 'servers.js');
  check((home.match(/dotHTML\(/g) || []).length === 5, 'all five friend/DM/Active-Now rows go through it', (home.match(/dotHTML\(/g) || []).length);
  check(/dotHTML\(m\.id, dot\)/.test(servers), 'and so does the member row');
  check(/const meMobile = dot !== 'offline' && onMobileNow\(S\.me\.id\);/.test(servers) && /meDot\.className = 'status-dot ' \+ dot \+ \(meMobile \? ' phone' : ''\)/.test(servers),
    'the me bar paints the same class on its own dot');

  console.log('\n[2] it is the DEVICE that is classified, never the window');
  check(deviceFor({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/152 Mobile Safari/537.36' }) === true,
    'an Android phone is mobile');
  check(deviceFor({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' }) === true,
    'an iPhone is mobile');
  check(deviceFor({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', maxTouchPoints: 5 }) === true,
    'an iPad reporting itself as a Macintosh is caught by the touchscreen');
  check(deviceFor({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36', maxTouchPoints: 0 }) === false,
    'a desktop browser is not');
  check(deviceFor({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', maxTouchPoints: 0 }) === false,
    'a Mac without a touchscreen is not');
  check(deviceFor({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/152 Safari/537.36', maxTouchPoints: 0, userAgentData: { mobile: true } }) === true,
    'userAgentData.mobile is honoured where the UA string alone is ambiguous');
  check(deviceFor({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/152 Safari/537.36', maxTouchPoints: 0, userAgentData: { mobile: false } }) === false,
    'and a desktop UA that reports mobile:false stays a desktop');
  check(!/matchMedia|innerWidth|phoneLayout/.test(DEVICE_SRC),
    'the classifier never looks at the viewport — a narrow desktop window is not a phone');

  console.log('\n[3] the server carries the flag');
  check(/device TEXT NOT NULL DEFAULT ''/.test(db) && /addColumn\('live_sessions', 'device'/.test(db),
    'live_sessions.device is a guarded migration (existing databases upgrade in place)');
  check(/visible_at BIGINT NOT NULL DEFAULT 0/.test(db) && /addColumn\('live_sessions', 'visible_at'/.test(db),
    'and so is live_sessions.visible_at, the page-in-front lease');
  check(/url\.searchParams\.get\('device'\) === 'mobile' \? 'mobile' : ''/.test(server),
    'socketAuth whitelists the claim instead of trusting the query string');
  check(/return \{ u, p, device \};/.test(server), 'and hands it to the connection');
  check(/device: auth\.device \|\| ''/.test(server), 'which puts it on the socket meta');
  check(/device = EXCLUDED\.device/.test(server), 'every presence upsert carries it (visibility frames included)');
  check(/async function mobileUsersFor\(ids\)/.test(server) && /async function mobileForServer\(serverId\)/.test(server)
    && /async function userOnMobile\(userId\)/.test(server),
    'three readers over the SAME registry: friend roster, server roster, one user');
  check(/for \(const uid of phonesFromRows\(rows\)\) out\[uid\] = 1;/.test(server)
    && (server.match(/SELECT user_id, device, visible_at FROM live_sessions/g) || []).length >= 1
    && /SELECT s\.user_id, s\.device, s\.visible_at FROM live_sessions s/.test(server),
    'and all three resolve it in one place, from device + the lease (replica-safe, one query per roster)');
  check(/await presenceUpsert\(ws, \{ lease: true \}\);\r?\n\s*await announceMobile\(me\.userId, me\.servers\);/.test(server),
    'a visibility frame refreshes the lease and announces any move it made');
  check(/UPDATE users SET mobile_flag = \? WHERE id = \? AND mobile_flag <> \? RETURNING id/.test(server),
    'and the announcement is a compare-and-set against what clients were last told (only a real change is pushed)');
  check(/await writeMobileFlag\(me\.userId, onPhone\);/.test(server),
    'a connect records the flag its user-online already announced, so no redundant frame follows');
  check(/const live = await db\.prepare\(\s*`SELECT s\.user_id, s\.device, s\.visible_at, u\.mobile_flag/.test(server)
    && /if \(was !== \(onPhone\.has\(uid\) \? 1 : 0\)\) await announceMobile\(uid\);/.test(server),
    'and the leader-locked reconcile pass lets a lease EXPIRE — a quiet device sends no frame for anyone to react to');
  check(/const leaseAt = opts && opts\.lease \? \(m\.visible \? Date\.now\(\) : 0\) : null;/.test(server)
    && /visible_at = COALESCE\(\?, live_sessions\.visible_at\)/.test(server),
    'the lease is only written by an explicit visibility frame (the connect-time default cannot claim it)');
  check(/await presenceUpsert\(ws\);\r?\n\s*if \(ws\.readyState !== 1\)/.test(server),
    'and a connect registers its row WITHOUT one');
  check(/t: 'presence', serverId: sid, online: await presenceFor\(sid, me\.userId\), mobile: await mobileForServer\(sid\)/.test(server),
    'the server roster ships a mobile map beside the status map');
  check(/t: 'presence', online: await presenceForUsers\(ids, userId\), mobile: await mobileUsersFor\(ids\)/.test(server)
    && /t: 'presence', online: await presenceForUsers\(me\.friends, me\.userId\), mobile: await mobileUsersFor\(me\.friends\)/.test(server),
    'and so does every friend roster (a friend you share no server with still gets the phone)');
  check(/const onPhone = \(await userOnMobile\(me\.userId\)\) \? 1 : 0;/.test(server)
    && /userId: me\.userId, status: me\.status \|\| 'online', mobile: onPhone/.test(server),
    'user-online announces it once per account, not once per server');
  check(/await announceMobile\(ws\.meta\.userId, ws\.meta\.servers\);\r?\n\s*await pushAdminPresence\(\);/.test(server),
    'EVERY socket close re-derives the phone flag — closing the desktop hands the account back to a pocketed phone that is still live');
  check(!/device === 'mobile'\) await announceMobile/.test(server), 'and no longer only a phone\'s own close (which left that hand-back to the sweep)');
  check(/const anywhere = !!\(await db\.prepare\('SELECT 1 AS ok FROM live_sessions WHERE user_id = \? LIMIT 1'\)\.get\(ws\.meta\.userId\)\);/.test(server)
    && !/const stillLive = \[\.\.\.clients\]\.some/.test(server),
    'liveness on close is a CLUSTER read (live_sessions), not this replica\'s socket set — a phone on pod A closing used to declare a desktop on pod B offline');
  check(/const alive = !!\(await db\.prepare\('SELECT 1 AS ok FROM live_sessions WHERE user_id = \? LIMIT 1'\)\.get\(uid\)\);/.test(server)
    && /if \(!alive\) \{/.test(server) && /notifyFriends\(uid, \{ t: 'user-offline', userId: uid \}\)/.test(server),
    'a replica that died runs no close handler, so the sweep that reaps its rows announces those users offline');
  check(/t: 'user-status', serverId: sid, userId: u\.id, status: u\.status, mobile: onPhone/.test(server)
    && /notifyFriends\(u\.id, \{ t: 'user-status', userId: u\.id, status: u\.status, mobile: onPhone \}\)/.test(server),
    'every status frame carries the phone flag (going invisible dropped the glyph, and nothing ever restored it)');
  check(/if \(typeof m\.mobile === 'number'\) \{ if \(m\.mobile\) S\.presenceMobile\[m\.userId\] = 1; else delete S\.presenceMobile\[m\.userId\]; \}/.test(socket),
    'and the client applies it on a status frame');
  check(/notifyFriends\(id, \{ t: 'user-status', userId: id, status: 'online', mobile: onPhone \}\)/.test(server),
    'a timed Away/invisible LAPSING tells friends too — the no-shared-server audience was skipped entirely, so an invisible friend stayed a grey dot');
  check(/UPDATE users SET status = 'online', presence_expires_at = NULL, presence_auto = 0 WHERE/.test(server),
    'and the lapse clears the idle-Away marker with the status');
  check(/if \(await userInVoice\(id\)\) \{ try \{ await pushFriendsVoice\(id\); \} catch \{\} \}/.test(server),
    'an invisible user in a voice room comes back onto the Active Now rail with their status');
  check(/const sids = \(await db\.prepare\('SELECT server_id FROM server_members WHERE user_id = \?'\)\.all\(id\)\)\.map\(\(r\) => r\.server_id\);/.test(server),
    'the sweep names its audience from the DATABASE — the leader runs it, and the lapsed user\'s devices may all be on a peer');
  check(/async function announceMobile\(userId, servers\)/.test(server)
    && /mobile: onPhone \}\);/.test(slice(server, 'async function announceMobile(', '// Send a payload to every live socket')),
    'and every path that can move it — that close, a visibility frame, a reaped replica — goes through ONE announcer');
  check(/if \(ws\.readyState !== 1\) earlyCleanup\(\);/.test(server) && /const earlyCleanup = \(\) => \{ clients\.delete\(ws\); presenceForget\(ws\)/.test(server),
    'and a socket that dies inside the handshake is deregistered too (its readyState is re-read after the insert)');
  check(/new Set\(gone\.map\(\(r\) => r\.user_id\)\)/.test(server) && /await announceMobile\(uid, sids\);/.test(server),
    'and the dead-replica reconciler clears phone flags it reaped');

  console.log('\n[3b] the rule: the device in FRONT, not any live phone socket');
  const PHONES_SRC = slice(server, 'const MOBILE_LEASE_MS', 'async function mobileUsersFor(ids)');
  const phones = new Function('rows', 'nowMs', PHONES_SRC + '\n;return phonesFromRows(rows, nowMs);');
  const NOW = 1_700_000_000_000;
  const row = (user_id, device, bornMs) => ({ user_id, device, visible_at: NOW - bornMs });
  const onPhone = (rows) => phones(rows, NOW).has('u');
  // This is the reported bug, in one line: a phone whose last page-in-front
  // report is minutes old must NOT keep painting a phone over a desktop that is
  // renewing its own claim right now.
  check(onPhone([row('u', 'mobile', 4 * 60e3), row('u', '', 0)]) === false,
    'a desktop in front beats a phone that went quiet minutes ago');
  check(onPhone([row('u', 'mobile', 0), row('u', '', 0)]) === true,
    'but a phone in front wins over a desktop (it is the device being held)');
  check(onPhone([row('u', 'mobile', 0), row('u', '', 9 * 60e3)]) === true,
    'a fresh phone beats a desktop whose claim lapsed');
  check(onPhone([row('u', 'mobile', 20 * 60e3)]) === true,
    'a phone that went quiet with nothing else renewing still counts (locked in a pocket is still a phone)');
  check(onPhone([row('u', '', 0), row('u', 'mobile', 20 * 60e3)]) === false,
    'which is the whole point: the desktop being used takes the indicator back');
  check(onPhone([row('u', '', 4 * 60e3)]) === false, 'a desktop that went quiet is not a phone');
  check(onPhone([row('u', 'mobile', 20 * 60e3), row('u', '', 0)]) === false,
    'rows of one user are aggregated, not decided by the first one seen');
  check(phones([row('u', 'mobile', 0), row('v', '', 0)], NOW).has('v') === false,
    'and one user\'s phone never marks another as one');  check(/MOBILE_LEASE_MS = Math\.max\(1000, parseInt\(process\.env\.MOBILE_LEASE_MS/.test(server)
    && /75 \* 1000/.test(server),
    'the lease window is 75s — three missed renewals of the client\'s 25s timer');

  console.log('\n[4] the client applies it');
  check(/&device=mobile/.test(socket) && /const dev = deviceIsMobile\(\) \? '&device=mobile' : '';/.test(socket),
    'connectWS claims the device once, at connect');
  check(/presenceMobile: \{\}/.test(core), 'S.presenceMobile is part of the client state');
  check(/for \(const id of Object\.keys\(on\)\) \{ if \(mob\[id\]\) S\.presenceMobile\[id\] = 1; else delete S\.presenceMobile\[id\]; \}/.test(socket),
    'a roster REPLACES the flag for every id in it (a phone glyph cannot outlive its session)');
  check(/if \(m\.mobile\) S\.presenceMobile\[m\.userId\] = 1; else delete S\.presenceMobile\[m\.userId\];/.test(socket),
    'user-online carries it too');
  check(/case 'user-mobile':/.test(socket), 'and user-mobile is handled on its own');
  check(/case 'user-offline':\s*\n\s*delete S\.presenceAll\[m\.userId\];\s*\n\s*delete S\.presenceMobile\[m\.userId\];/.test(socket),
    'going offline drops the phone flag with the status');
  check(/repaintFriendsIfVisible\(\)/.test(slice(socket, "case 'user-mobile':", "case 'user-offline':")),
    'the live path repaints the rows it changes (friends list + member list)');
  check(/setInterval\(\(\) => \{\s*try \{ if \(document\.visibilityState === 'visible'\) sendVisibility\(\); \} catch \{\}\s*\}, 25000\)/.test(socket),
    'and the page renews its own "in front" lease on a timer (a latch would strand the indicator on a lost frame)');
  check(/document\.addEventListener\('visibilitychange', sendVisibility\)/.test(socket),
    'while a hidden page clears its claim at once through the existing listener');

  console.log('\n[5] the CSS paints it');
  check(/--phone-glyph:url\("data:image\/svg\+xml,/.test(css), 'the phone glyph is one mask shape');
  const rule = /\.avwrap \.status-dot\.phone::after\{([^}]*)\}/.exec(css);
  check(!!rule, 'the phone dot has its own ::after rule');
  if (rule) {
    check(/mask:var\(--phone-glyph\)/.test(rule[1]) && /-webkit-mask:var\(--phone-glyph\)/.test(rule[1]),
      'which masks that shape (both prefixes — the Android shell is WebKit)');
    check(/background:var\(--panel\)/.test(rule[1]),
      'the knockout is the surrounding surface, so it reads as a hole in the disc in every theme');
    check(/position:absolute;inset:0/.test(rule[1]), 'and rides the dot itself, not the avatar');
  }
  check(!/\.avwrap \.status-dot\.phone\{/.test(css),
    'the rule does not touch the dot itself — its status colour, size and halo are untouched (the halo is what keeps it readable over a picture)');

  const chrome = findChrome();
  if (!chrome) console.log('[test] pixel checks SKIPPED — no Chrome/Edge found (set CHROME_PATH)');
  else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-mobile-ind-'));
    try {
    console.log('\n[6] a browser really paints the glyph (headless Chrome)');
    for (const dpr of [1, 3]) {
      const out = shot(chrome, pageHtml(), dpr, dir);
      if (out.err) { check(false, 'the dpr ' + dpr + ' harness ran', out.err); continue; }
      const box = (k) => out.boxes.find((b) => b.key === k);
      const plain = box('member-plain'), phone = box('member-phone');
      check(plain.cls === 'status-dot online', 'dpr ' + dpr + ' — the control is a plain dot', plain.cls);
      check(phone.cls === 'status-dot online phone' && phone.title === 'On mobile',
        'dpr ' + dpr + ' — the flagged row is the phone dot', { cls: phone.cls, title: phone.title });
      check(phone.bg === plain.bg, 'dpr ' + dpr + ' — same status colour underneath (green stays green)', { phone: phone.bg, plain: plain.bg });
      check(phone.w === plain.w && phone.h === plain.h && phone.radius === plain.radius,
        'dpr ' + dpr + ' — same size and round shape (nothing reflows)', { phone: [phone.w, phone.h], plain: [plain.w, plain.h] });
      check(phone.shadow === plain.shadow, 'dpr ' + dpr + ' — the halo that separates it from the avatar is intact');
      const isGlyph = /url\(/.test(phone.mask) && /svg/.test(phone.mask);
      check(isGlyph, 'dpr ' + dpr + ' — the mask resolved to the phone glyph (not dropped)', phone.mask.slice(0, 60));
      check(!/url\(/.test(plain.mask), 'dpr ' + dpr + ' — and the control has no mask at all', plain.mask);
      check(/80%/.test(phone.maskSize), 'dpr ' + dpr + ' — at the height it was designed for', phone.maskSize);
      check(/rgb\(13, 18, 28\)/.test(phone.afBg) || /rgb\(13, 18, 28\)/.test(phone.afBg.replace(/\s/g, ' ')),
        'dpr ' + dpr + ' — the knockout is painted in the panel colour', phone.afBg);
      check(phone.afW === phone.w && phone.afH === phone.h, 'dpr ' + dpr + ' — it covers exactly the dot', { af: [phone.afW, phone.afH], dot: [phone.w, phone.h] });

      // Every context the corner dot lives in must have got it, in the dot.
      for (const k of ['dmrow-phone', 'anow-phone', 'me-phone', 'stream-phone']) {
        const b = box(k);
        check(/phone/.test(b.cls) && /url\(/.test(b.mask) && /svg/.test(b.mask), 'dpr ' + dpr + ' — ' + k + ' is a phone too', { cls: b.cls, mask: /svg/.test(b.mask) });
      }
      const off = box('offline-flag');
      check(!/phone/.test(off.cls) && !/url\(/.test(off.mask), 'dpr ' + dpr + ' — the offline row is left alone', { cls: off.cls });

      if (!out.png) { check(false, 'dpr ' + dpr + ' — a screenshot to sample', 'none'); continue; }
      const img = out.png;
      const px = (x, y) => { const i = (Math.round(y) * img.w + Math.round(x)) * 4; return [img.px[i], img.px[i + 1], img.px[i + 2]]; };
      const near = (p, [r, g, b], tol) => Math.abs(p[0] - r) <= tol && Math.abs(p[1] - g) <= tol && Math.abs(p[2] - b) <= tol;
      const GREEN = [52, 211, 153];
      // The central 60% of the border box is inside the disc at every corner
      // (radius 50%), so it holds nothing but the status colour and the glyph.
      // The knockout is counted as "darker than the disc", not "exactly the
      // panel colour": a ~1px stroke at dpr 1 is almost all antialiasing, and
      // demanding pure pixels there would fail on a glyph that renders fine.
      const scan = (b) => {
        let knock = 0, disc = 0, n = 0;
        for (let fy = 0.2; fy <= 0.8; fy += 0.02) {
          for (let fx = 0.2; fx <= 0.8; fx += 0.02) {
            const p = px((b.x + b.rw * fx) * dpr, (b.y + b.rh * fy) * dpr);
            n++;
            if (near(p, GREEN, 45)) disc++;
            else if (p[1] < 150) knock++; // green's own channel is 211; the panel's is 18
          }
        }
        return { n, knock, disc };
      };
      const cs = scan(plain), ps = scan(phone);
      check(cs.knock === 0 && cs.disc / cs.n > 0.9, 'dpr ' + dpr + ' — the control is a solid disc of its status colour', cs);
      check(ps.knock / ps.n > 0.06, 'dpr ' + dpr + ' — the phone dot has the glyph knocked out of it', ps);
      check(ps.disc / ps.n > 0.4, 'dpr ' + dpr + ' — and is still mostly its status colour', ps);
      check(ps.knock > cs.knock * 4, 'dpr ' + dpr + ' — the difference really is the knockout', { plain: cs.knock, phone: ps.knock });
    }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  await protocolPhase();

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
}

main().catch((e) => { console.error('[test] crashed:', (e && e.message) || e); process.exit(1); });
