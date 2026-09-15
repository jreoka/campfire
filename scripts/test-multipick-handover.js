// Several files picked at ONCE hand over ONE AT A TIME.
//
// The report: "when uploading multiple images it waits for every upload to
// complete before showing the spoiler mark stage … for multiple photos it waits
// for every green bar upload before showing the spoiler menu for photos that
// already finished uploading".
//
// The composer has two stages — the progress card, then the chip with its
// Spoiler toggle — and the handover used to be gated on the LIST ("is any card
// still on stage?"), so the first photo's chip and toggle were withheld until
// the last card left. The gate has to be per-ATTACHMENT.
//
// This drives the REAL app in headless Chrome against a REAL server: three
// photos are put into `#in-attach` in one pick (which also exercises the
// multi-file picker end to end), the uplink is throttled so the three transfers
// genuinely overlap, and the DOM is sampled every 20ms through both stages. What
// it asserts is the TIMELINE, which is the only place this bug is visible:
// a Spoiler toggle must appear while cards are still on the stage.
//
// Skips (exit 0) without Chrome or Postgres. Usage: node scripts/test-multipick-handover.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_test_multipick';
const PORT = parseInt(process.env.TEST_PORT || '3471', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9471', 10);
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-multipick-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });

  let child = null, ws = null, chrome = null;
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
        JWT_SECRET: 'multipick-handover-secret',
        UPLOAD_DIR: uploads,
        // Neither stage-2 gate is what this test is about: with no scanner and no
        // compressor the answer is just "the bytes landed", so the ONLY reason the
        // three uploads finish at different times is the throttled uplink below.
        VIRUS_SCAN: '0',
        MEDIA_COMPRESS: '0',
        BUCKET_SCAN_FIRST_MS: '3600000',
        UNFURL: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    const fail = (msg) => { throw new Error(msg + '\n--- server log ---\n' + serverLog.slice(-3000)); };
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${PORT}/api/config`)).ok; } catch {}
      if (!up) await sleep(250);
    }
    if (!up) return fail('server did not come up');

    chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + path.join(tmp, 'chrome'), '--no-first-run', '--no-default-browser-check',
      '--window-size=1000,800', 'about:blank'], { stdio: 'ignore' });
    let info = null;
    for (let i = 0; i < 60 && !info; i++) {
      try { info = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); } catch { await sleep(250); }
    }
    if (!info) return skip('Chrome never opened its DevTools port');
    ws = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0;
    const pending = new Map();
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
    const ev = async (expression) => {
      const r = await sess('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'page error');
      return r.result.value;
    };
    await sess('Page.enable');
    await sess('Runtime.enable');
    await sess('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(1500);

    await ev(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'multipick', displayName: 'Multi Pick', password: 'passw0rd!x' }) });
      const d = await r.json();
      store.token = d.token; store.sid = d.sid;
      return true;
    })()`);
    await sess('Page.reload');
    await sleep(1200);
    const ready = await ev(`(async () => {
      for (let i = 0; i < 60 && !(S.me && S.me.username === 'multipick'); i++) await new Promise((r) => setTimeout(r, 100));
      if (!S.me) return false;
      const r = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: 'Pick Lab' }) });
      await refreshServers(r.server.id);
      if (S.ws) S.ws.send(JSON.stringify({ t: 'subscribe' }));
      await selectServer(r.server.id);
      return !!(S.serverId && S.channelId);
    })()`);
    if (ready !== true) return fail('never booted signed in with a channel open');

    console.log('\n[1] three photos put into #in-attach in ONE pick');
    // Throttle the uplink so the three transfers genuinely overlap (40KB / 160KB
    // / 320KB land roughly a second apart). Without it a localhost burst answers
    // all three inside one sampling frame and only the final state is visible.
    await sess('Network.enable');
    await sess('Network.emulateNetworkConditions', {
      offline: false, latency: 10, downloadThroughput: -1, uploadThroughput: 160 * 1024,
    });
    const picked = await ev(`(() => {
      // A real PNG header, so the server sees image/png and the chip is media.
      const png = [137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137];
      const sizes = [40 * 1024, 160 * 1024, 320 * 1024];
      const files = sizes.map((n, i) => {
        const bytes = new Uint8Array(n);
        bytes.set(png, 0);
        return new File([bytes], 'photo' + (i + 1) + '.png', { type: 'image/png' });
      });
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      const inp = document.querySelector('#in-attach');
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return { multiple: inp.multiple === true, started: S.uploads.length, cleared: inp.value === '' };
    })()`);
    check(picked.multiple, 'the picker input is multi-select', picked);
    check(picked.started === 3, 'one pick starts all three uploads', picked);
    check(picked.cleared, 'and the input is cleared for the next pick', picked);

    console.log('\n[2] the two stages, sampled from the DOM every 20ms');
    await ev(`(() => {
      window.__samples = [];
      const tick = () => {
        const cards = document.querySelectorAll('#upload-list .up-card').length;
        const chips = [...document.querySelectorAll('#attach-preview .att-chip')];
        window.__samples.push({
          t: performance.now(), cards, chips: chips.length,
          spoil: chips.filter((c) => c.querySelector('button[title="Mark as spoiler"]')).length,
          names: chips.map((c) => { const n = c.querySelector('.chip-name'); return n ? n.textContent : ''; }),
        });
      };
      tick();
      window.__iv = setInterval(tick, 20);
      return true;
    })()`);
    let settled = false;
    for (let i = 0; i < 240 && !settled; i++) {
      settled = await ev(`(() => !S.uploads.length
        && !document.querySelectorAll('#upload-list .up-card').length
        && document.querySelectorAll('#attach-preview .att-chip').length === 3)()`);
      if (!settled) await sleep(50);
    }
    // One last authoritative look, taken WITH the interval's own clock, so the
    // final handover cannot fall between the last sample and this read.
    const final = await ev(`(() => {
      clearInterval(window.__iv);
      const cards = document.querySelectorAll('#upload-list .up-card').length;
      const chips = [...document.querySelectorAll('#attach-preview .att-chip')];
      return {
        samples: window.__samples, t: performance.now(), cards, chips: chips.length,
        spoil: chips.filter((c) => c.querySelector('button[title="Mark as spoiler"]')).length,
      };
    })()`);
    const samples = final.samples;

    // The timeline, printed only where it CHANGES — the evidence this test is for.
    {
      let prev = '';
      const t0 = samples.length ? samples[0].t : 0;
      for (const s of samples) {
        const key = s.cards + '|' + s.chips + '|' + s.spoil;
        if (key !== prev) {
          console.log('   t+' + (s.t - t0).toFixed(0) + 'ms  cards=' + s.cards
            + ' chips=' + s.chips + ' withSpoiler=' + s.spoil + '  [' + s.names.join(', ') + ']');
          prev = key;
        }
      }
      console.log('   t+' + (final.t - t0).toFixed(0) + 'ms  cards=' + final.cards
        + ' chips=' + final.chips + ' withSpoiler=' + final.spoil + '  (final)');
    }

    check(settled === true, 'all three uploads settled into chips');
    check(samples.length > 10, 'the sampler saw the run', samples.length);
    const firstSpoil = samples.find((s) => s.spoil >= 1);
    const lastSpoil = [...samples].reverse().find((s) => s.spoil >= 3)
      || (final.spoil >= 3 ? { t: final.t } : null);
    check(!!firstSpoil, 'a Spoiler toggle appeared at all');
    check(!!firstSpoil && firstSpoil.cards >= 1,
      'it appeared while another upload was STILL on the stage (the reported bug)', firstSpoil);
    check(!!firstSpoil && !!lastSpoil && (lastSpoil.t - firstSpoil.t) > 400,
      'and the three handovers were spread out, not one instant',
      { first: firstSpoil && Math.round(firstSpoil.t), last: lastSpoil && Math.round(lastSpoil.t) });
    check(final.cards === 0 && final.chips === 3 && final.spoil === 3,
      'all three ended as chips WITH their Spoiler toggles, stage empty', final);

    console.log('\n[3] a spoiler set on one chip stays on that file');
    const spoil = await ev(`(async () => {
      [...document.querySelectorAll('#attach-preview .att-chip')][0]
        .querySelector('button[title="Mark as spoiler"]').click();
      await new Promise((r) => setTimeout(r, 60));
      const chips = [...document.querySelectorAll('#attach-preview .att-chip')];
      return {
        on: chips.filter((c) => c.querySelector('button[title="Mark as spoiler"]').classList.contains('on')).length,
        subs: chips.map((c) => c.querySelector('.chip-sub').textContent),
      };
    })()`);
    check(spoil.on === 1, 'exactly one chip is marked', spoil);
    check(spoil.subs.some((s) => /Spoiler/.test(s)), 'and its readout says so', spoil.subs);
  } catch (e) {
    console.error('[test] ' + (e && e.message));
    process.exit(1);
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome && chrome.kill(); } catch {}
    try { child && child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

main();
