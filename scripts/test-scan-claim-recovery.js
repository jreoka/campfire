// A scan slot's claim is a LEASE held in file_scans (claimed_by / claimed_at),
// and the only thing that ever expired it was a clock: SLOT_TIMEOUT_MS, twelve
// minutes, because a slot that is merely SLOW has to keep its row. A slot whose
// POD is gone never releases anything, though — the process died holding the
// claim — so a restart or a deploy that caught a file mid-scan left its row
// `pending` for up to twelve more minutes. That was reported as "if the server
// reboots while a file is processing sometimes it can say processing forever":
// the reader was looking at a "Processing file" card, and the file was unservable
// until the lease aged out. (The card is gone — a verdict is a background
// judgement now and the bytes are served either way — but the row still has to
// be handed back, or the verdict the feature exists to produce is delayed by
// twelve minutes.)
//
// Seen live before this existed: an `.mp4` uploaded 503ms before a deploy, its
// claim left by the container the deploy replaced, still `pending` at 9 and 11
// minutes while the worker logged `stalled? pending=1 ... active=0 claimed=0`
// once a minute, and released only when the lease finally aged out.
//
// The fix releases a claim whose owner is not in the replica registry
// (bus_replicas + PEER_STALE_MS — the same liveness idiom reconcileReplicaState
// uses for voice occupancy and live sessions). Two halves prove it:
//
//   [1] the RULE, against a real database: a claim left by a pod that is gone —
//       no registry row, or one that stopped heartbeating — is handed back; a
//       claim held by a LIVE peer, and one held by this process, are NOT. That
//       second half is the safety property a rolling update depends on.
//   [2] the PROMISE, end to end: a real server, a slow stand-in clamd, an upload
//       caught mid-scan, a restart, and the row judged within seconds — where
//       the old behaviour needed twelve minutes.
//
// Needs Postgres (docker compose up -d db); skips (exit 0) without it.
//
// Usage: node scripts/test-scan-claim-recovery.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const fake = require(path.join(__dirname, 'fake-clamd'));

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_claim_recovery';
const PORT = parseInt(process.env.TEST_PORT || '3413', 10);
const DAEMON_PORT = parseInt(process.env.TEST_CLAMAV_PORT || '3414', 10);
// Long enough that the kill lands while the scan is genuinely in flight, short
// enough that the recovery scan after the restart is quick.
const SCAN_DELAY_MS = 6000;
// The old behaviour could not recover for SLOT_TIMEOUT_MS (12 minutes). This is
// the whole point of the test: recovery has to happen FAR inside that, so the
// budget is generous for a slow box and still nowhere near the lease.
const RECOVER_BUDGET_MS = 45000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(name, cond, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }

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
async function api(method, p, body, token) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(j)}`);
  return j;
}
async function uploadFile(filePath, name, mime, token) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(filePath)], { type: mime }), name);
  const res = await fetch(`http://127.0.0.1:${PORT}/api/upload`, {
    method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('upload -> ' + res.status + ' ' + JSON.stringify(j));
  return j;
}
async function waitFor(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch {}
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(200);
  }
}
async function waitForHttp(p, ms) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); if (r.ok) return true; } catch {}
    if (Date.now() - t0 > ms) return false;
    await sleep(250);
  }
}

// ---------- [1] the rule, against a real database ----------
// The module resolves its database from the environment at load, so the test
// database is picked by reloading it — the same trick test-virus-scan.js uses to
// re-point the daemon.
function loadAgainst(pg, database) {
  process.env.PGHOST = pg.host;
  process.env.PGPORT = String(pg.port);
  process.env.PGUSER = pg.user;
  process.env.PGPASSWORD = pg.password;
  process.env.PGDATABASE = database;
  for (const m of ['db', 'bus', 'virus-scan']) delete require.cache[require.resolve(path.join(ROOT, m))];
  return { db: require(path.join(ROOT, 'db')), vs: require(path.join(ROOT, 'virus-scan')), bus: require(path.join(ROOT, 'bus')) };
}

async function ruleChecks(pg) {
  const { db, vs, bus } = loadAgainst(pg, TEST_DB);
  await vs._ensureTables();
  // The registry table the liveness rule reads. Same shape bus.js creates.
  await db.exec(`CREATE TABLE IF NOT EXISTS bus_replicas (
    pod_id TEXT PRIMARY KEY,
    started_at BIGINT NOT NULL,
    last_seen BIGINT NOT NULL
  )`);
  const me = vs._podId();
  const t = Date.now();
  const put = (key, owner, at) => db.prepare(
    'INSERT INTO file_scans (key,status,attempts,error,created_at,gated,claimed_by,claimed_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(key, 'pending', 0, '', t, 1, owner, at || t);
  // Four rows, oldest first (claimRow takes the oldest claimable):
  await put('files/a-dead.bin', 'dead-pod:111111');       // no registry row at all — a graceful stop deleted it
  await put('files/b-live.bin', 'live-peer:222222');      // a peer that is heartbeating right now
  await put('files/c-mine.bin', me);                      // this process, mid-scan
  await put('files/d-crashed.bin', 'crashed-pod:333333'); // a peer that stopped heartbeating
  await db.prepare('INSERT INTO bus_replicas (pod_id, started_at, last_seen) VALUES (?,?,?)').run('live-peer:222222', t - 60000, t);
  await db.prepare('INSERT INTO bus_replicas (pod_id, started_at, last_seen) VALUES (?,?,?)').run('crashed-pod:333333', t - 600000, t - bus.PEER_STALE_MS - 5000);

  const ownerOf = async (key) => ((await db.prepare('SELECT claimed_by FROM file_scans WHERE key = ?').get(key)) || {}).claimed_by || null;

  await vs._releaseDeadClaims();

  check('a claim left by a pod with no registry row is handed back', (await ownerOf('files/a-dead.bin')) === null, await ownerOf('files/a-dead.bin'));
  check('a claim left by a pod that stopped heartbeating is handed back', (await ownerOf('files/d-crashed.bin')) === null, await ownerOf('files/d-crashed.bin'));
  check('a LIVE peer keeps its claim (a rolling update is untouched)', (await ownerOf('files/b-live.bin')) === 'live-peer:222222', await ownerOf('files/b-live.bin'));
  check('and this process keeps its own claim', (await ownerOf('files/c-mine.bin')) === me, await ownerOf('files/c-mine.bin'));

  // The released rows are claimable RIGHT NOW — no twelve-minute wait. claimRow
  // orders by created_at, so asking it four times covers every pending row.
  const got = [];
  for (let i = 0; i < 4; i++) {
    const r = await vs._claimRow();
    if (!r || !r.key) break;
    got.push(r.key);
  }
  check('the released rows are claimed immediately', got.includes('files/a-dead.bin') && got.includes('files/d-crashed.bin'), got);
  check('the live peer\'s row is left alone', !got.includes('files/b-live.bin'), got);
  check('and so is our own in-flight row', !got.includes('files/c-mine.bin'), got);

  await db.prepare('UPDATE file_scans SET claimed_by = NULL, claimed_at = NULL').run();
  await db.prepare('DELETE FROM file_scans').run();
  await db.prepare('DELETE FROM bus_replicas').run();
  try { await db.closePool(); } catch {}
}

// ---------- [2] the promise: a restart mid-scan recovers in seconds ----------
async function restartChecks(pg) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-claim-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  const file = path.join(tmp, 'notes.txt');
  fs.writeFileSync(file, 'an upload caught mid-scan by a restart\n');

  process.env.FAKE_CLAMAV_DELAY_MS = String(SCAN_DELAY_MS);
  const daemon = await fake.start({ port: DAEMON_PORT });
  let child = null;
  let serverLog = '';
  const env = {
    ...process.env,
    PORT: String(PORT),
    PGHOST: pg.host, PGPORT: String(pg.port), PGUSER: pg.user, PGPASSWORD: pg.password, PGDATABASE: TEST_DB,
    JWT_SECRET: 'test-claim-recovery-secret',
    UPLOAD_DIR: uploads,
    VIRUS_SCAN: '1',
    MEDIA_COMPRESS: '0', // the scan alone is the work here
    CLAMAV_HOST: '127.0.0.1',
    CLAMAV_PORT: String(daemon.port),
    DRAIN_WAIT_MS: '0',
    UNFURL: '0',
  };
  function start() {
    serverLog = '';
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
  }
  // A restart the way a deploy does it: SIGTERM, drain, exit. The process is
  // gone while its scan is still parked in the stand-in daemon, which is exactly
  // the state the report is about.
  function stop() {
    return new Promise((resolve) => {
      const c = child;
      if (!c) return resolve();
      child = null;
      c.once('exit', () => resolve());
      try { c.kill(); } catch { return resolve(); }
      setTimeout(resolve, 20000);
    });
  }

  let db = null;
  try {
    start();
    if (!(await waitForHttp('/api/config', 30000))) throw new Error('server did not come up\n' + serverLog.slice(-2000));
    const reg = await api('POST', '/api/register', { username: 'claimtest', password: 'test1234', displayName: 'Claim Test' });
    const token = reg.token;

    db = new Client({ ...pg, database: TEST_DB });
    await db.connect();
    const rowFor = async (key) => (await db.query('SELECT status, claimed_by, attempts FROM file_scans WHERE key = $1', [key])).rows[0] || null;

    const up = await uploadFile(file, 'notes.txt', 'text/plain', token);
    const key = up.url.split('?')[0].replace('/uploads/', '');
    // A verdict is a background judgement (see virus-scan.js): the upload is
    // served the moment it lands, and the row is what is left waiting.
    check('the upload is served as it lands', up.scan === 'clean', 'scan=' + up.scan);
    const servedEarly = await fetch(`http://127.0.0.1:${PORT}/uploads/${key}`);
    check('...with its bytes, while the scanner is still judging it', servedEarly.status === 200, 'status=' + servedEarly.status);

    const claimed = await waitFor(async () => {
      const r = await rowFor(key);
      return r && r.claimed_by ? r : null;
    }, 15000);
    check('a slot has claimed it and is mid-scan', !!claimed, claimed);
    const deadPod = claimed ? claimed.claimed_by : null;

    await stop();
    const afterKill = await rowFor(key);
    check('the restart leaves the claim behind — nobody released it', !!afterKill && afterKill.claimed_by === deadPod,
      afterKill && { status: afterKill.status, claimed_by: afterKill.claimed_by });

    start();
    if (!(await waitForHttp('/api/config', 30000))) throw new Error('server did not come back\n' + serverLog.slice(-2000));
    const t0 = Date.now();
    const clean = await waitFor(async () => {
      const r = await rowFor(key);
      return r && r.status === 'clean' ? r : null;
    }, RECOVER_BUDGET_MS);
    const took = Date.now() - t0;
    check('the row is judged again without waiting out the lease', !!clean, { status: clean && clean.status, ms: took });
    check('...and it is nowhere near the twelve-minute lease', took < RECOVER_BUDGET_MS, took + 'ms');
    check('the new pod did the work, not the dead one', !!clean && clean.claimed_by === null, clean && clean.claimed_by);

    const served = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${PORT}/uploads/${key}`);
      return r.status === 200 ? r : null;
    }, 10000);
    check('and the bytes were served the whole way through', !!served, served && served.status);
    check('and the app said why it could', /left by a replica that is gone/.test(serverLog),
      (serverLog.match(/\[virusscan\].*/g) || []).slice(-3));
  } finally {
    try { await stop(); } catch {}
    try { db && await db.end(); } catch {}
    try { daemon && daemon.close(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

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
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally { try { await admin.end(); } catch {} }

  try {
    console.log('\n[1] a claim whose owner is gone is handed back');
    await ruleChecks(pg);
    console.log('\n[2] an upload caught mid-scan by a restart recovers in seconds');
    await restartChecks(pg);
  } catch (e) {
    console.error('[test] ' + ((e && e.stack) || e));
    process.exit(1);
  }

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
}

main().catch((e) => { console.error('[test] ' + ((e && e.stack) || e)); process.exit(1); });
