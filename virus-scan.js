// Virus scanning for uploads (ClamAV) + gated serving until clean.
//
// Why scan everything, not just .exe: beyond blocking obviously dangerous
// types, anyone can rename malware.exe to photo.jpg, share it, and tell
// people to rename it back after downloading. Content sniffing by
// extension is theater — so every uploaded file is scanned by content.
//
// Flow:
// - /api/upload (and every image uploader) stores the bytes, then
//   queueFileScan(key) records a `pending` row in file_scans.
// - The worker below streams the bytes (local disk or S3, never fully
//   buffered) into clamd over TCP INSTREAM, one file at a time.
// - /uploads/* refuses to serve files/ keys until the row is `clean`
//   (423 while pending, 410 once an infected file is deleted). Message
//   attachments carry the row status, so chat renders a scanning /
//   infected state instead of the file (see attachmentHTML).
// - `infected` deletes the bytes immediately (S3 + local) but keeps the
//   message + attachment row so the chat shows a greyed-out warning.
// - On every verdict change the server re-broadcasts the affected
//   messages (hooked via setScanHooks) so scanning cards flip to the
//   real file without a refresh.
//
// ClamAV supervision (single-container friendly): on boot the worker
// downloads signature DBs with freshclam (persisted in CLAM_DB_DIR, so
// it's a one-time cost), starts clamd, and streams scans to it. No new
// npm deps — INSTREAM is a few lines over node:net.
//
// Failure posture is fail-OPEN with loud logs + admin visibility: without
// working AV (binaries missing in local dev, dead daemon) uploads must
// keep working, never wedge in `pending` forever.
//
// Env:
//   VIRUS_SCAN=0      disable entirely (uploads record `clean` immediately)
//   CLAM_DB_DIR       signature/config dir (default /data/clamav when
//                     writable, else next to the upload dir)
//   CLAM_PORT         clamd TCP port on loopback (default 3310)
'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execFile } = require('child_process');

const db = require('./db');
const storage = require('./storage');

const now = () => Date.now();
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads');
const ENABLED = process.env.VIRUS_SCAN !== '0';
const CLAM_PORT = Math.max(1, parseInt(process.env.CLAM_PORT || '3310', 10) || 3310);
const MAX_FILE_BYTES = parseInt(process.env.MAX_FILE_MB || '100', 10) * 1024 * 1024;
const KICK_MS = 500;
const IDLE_MS = 10000;
const MAX_ATTEMPTS = 3;

const log = (...a) => console.log('[virusscan]', ...a);
const warn = (...a) => console.warn('[virusscan]', ...a);

let started = false;
let ready = false; // tables exist; worker loop may run
let busy = false;
let timer = null;
let noEngine = false; // binaries missing — fail open
let engineFailed = false; // freshclam/clamd broken — fail open, loudly
let engineStarting = false;
let clamdReady = false;
let lastSpawnAttempt = 0;
let loggedNoEngine = false;
const hooks = { onScanChange: null };
const stats = {
  startedAt: 0, ticks: 0, scanned: 0, clean: 0, infected: 0, errors: 0,
  lastTickAt: 0, lastScan: null, lastError: null,
};

function defaultDbDir() {
  const cands = [process.env.CLAM_DB_DIR, '/data/clamav'].filter(Boolean);
  for (const c of cands) {
    try { fs.mkdirSync(c, { recursive: true }); fs.accessSync(c, fs.constants.W_OK); return c; } catch {}
  }
  const fb = path.join(path.dirname(UPLOAD_DIR), 'clamav');
  fs.mkdirSync(fb, { recursive: true });
  return fb;
}
let DBDIR = null;
const dbDir = () => (DBDIR = DBDIR || defaultDbDir());

async function ensureTables() {
  await db.exec(`CREATE TABLE IF NOT EXISTS file_scans (
  key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts BIGINT NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  scanned_at BIGINT
)`);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_file_scans_status ON file_scans(status, created_at)');
  ready = true;
}

// ---------- public intake ----------

// Record a fresh upload for scanning. When scanning is disabled the row
// goes straight to `clean` so every downstream reader stays uniform.
// Media-compress re-queues keys it rewrote (new bytes need a new verdict)
// via the same function — existing `infected` rows are never resurrected.
async function queueFileScan(key) {
  if (!key) return 'clean';
  try { await ensureTables(); } catch {}
  if (!ENABLED) {
    try {
      await db.prepare(`INSERT INTO file_scans (key,status,attempts,error,created_at,scanned_at)
        VALUES (?,'clean',0,'',?,?) ON CONFLICT(key) DO NOTHING`).run(key, now(), now());
    } catch {}
    return 'clean';
  }
  try {
    await db.prepare(`INSERT INTO file_scans (key,status,attempts,error,created_at,scanned_at)
      VALUES (?,'pending',0,'',?,NULL) ON CONFLICT(key) DO UPDATE SET
      status = CASE WHEN file_scans.status = 'infected' THEN 'infected' ELSE 'pending' END,
      attempts = 0, error = '', scanned_at = NULL`).run(key, now());
  } catch (e) {
    warn('queue failed for ' + key + ': ' + String((e && e.message) || e).slice(0, 120));
    return 'clean'; // fail open: never wedge an upload on a DB hiccup
  }
  kickVirusScan();
  return 'pending';
}

async function dropScan(key) {
  if (!key) return;
  try { await db.prepare('DELETE FROM file_scans WHERE key = ?').run(key); } catch {}
}

// Single status; unknown keys (pre-feature uploads, non-chat prefixes)
// are `clean` — only rows say otherwise.
async function scanStatus(key) {
  if (!key || !ENABLED) return 'clean';
  try {
    const r = await db.prepare('SELECT status FROM file_scans WHERE key = ?').get(key);
    return (r && r.status) || 'clean';
  } catch { return 'clean'; }
}

// Batch version for message hydration (one query per page, not per file).
async function scanStatusMap(keys) {
  const out = new Map();
  const uniq = [...new Set((keys || []).filter(Boolean))];
  if (!uniq.length || !ENABLED) return out;
  try {
    const ph = uniq.map(() => '?').join(',');
    const rows = await db.prepare(`SELECT key, status FROM file_scans WHERE key IN (${ph})`).all(...uniq);
    for (const r of rows) out.set(r.key, r.status || 'clean');
  } catch {}
  return out;
}

// Whether the /uploads gate should enforce verdicts at all.
function scanGating() {
  return ENABLED;
}

function setScanHooks(h) {
  if (h && typeof h.onScanChange === 'function') hooks.onScanChange = h.onScanChange;
}

async function emitChange(key, status) {
  if (!hooks.onScanChange) return;
  try { await hooks.onScanChange(key, status); }
  catch (e) { warn('onScanChange failed: ' + String((e && e.message) || e).slice(0, 160)); }
}

// ---------- clamd supervision ----------

function haveBinaries() {
  try {
    const r = spawnSync('sh', ['-c', 'command -v clamd && command -v freshclam'], { stdio: 'ignore', timeout: 5000 });
    return !!(r && r.status === 0);
  } catch { return false; }
}

async function hasDbFiles() {
  try {
    const files = await fs.promises.readdir(dbDir());
    return files.some((f) => /\.(cvd|cld)$/.test(f));
  } catch { return false; }
}

function writeConfs() {
  const dir = dbDir();
  const mb = Math.max(150, Math.ceil(MAX_FILE_BYTES / 1048576) + 50);
  fs.writeFileSync(path.join(dir, 'freshclam.conf'),
    `DatabaseDirectory ${dir}\nDatabaseMirror database.clamav.net\nChecks 4\nLogTime yes\n`);
  fs.writeFileSync(path.join(dir, 'clamd.conf'),
    `DatabaseDirectory ${dir}\nTCPSocket ${CLAM_PORT}\nTCPAddr 127.0.0.1\n` +
    `MaxScanSize ${mb}M\nMaxFileSize ${mb}M\nStreamMaxLength ${mb}M\nMaxDirectoryRecursion 10\n`);
}

function runFreshclam() {
  const conf = path.join(dbDir(), 'freshclam.conf');
  return new Promise((resolve) => {
    execFile('freshclam', ['--config-file=' + conf, '--stdout'], { timeout: 30 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 },
      (err) => resolve(!err));
  });
}

function pingClamd(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const t = setTimeout(() => { try { sock.destroy(); } catch {} finish(false); }, timeoutMs || 5000);
    const sock = net.createConnection({ host: '127.0.0.1', port: CLAM_PORT });
    let buf = '';
    sock.on('connect', () => sock.write('PING\n'));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.includes('PONG')) { clearTimeout(t); try { sock.destroy(); } catch {} finish(true); }
    });
    sock.on('error', () => { clearTimeout(t); finish(false); });
    sock.on('close', () => { clearTimeout(t); finish(false); });
  });
}

// Minimal clamd INSTREAM client (no deps): zINSTREAM + length-prefixed
// chunks + zero terminator, single-line verdict back.
function clamdScanStream(source, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const sock = net.createConnection({ host: '127.0.0.1', port: CLAM_PORT });
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch {} fn(arg); };
    const timer = setTimeout(() => finish(reject, new Error('clamd_timeout')), timeoutMs);
    let resp = '';
    sock.on('connect', () => {
      try { sock.write(Buffer.concat([Buffer.from('zINSTREAM'), Buffer.from([0])])); } catch (e) { finish(reject, e); return; }
      source.on('data', (chunk) => {
        if (done) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!buf.length) return;
        const head = Buffer.alloc(4);
        head.writeUInt32BE(buf.length, 0);
        if (!sock.write(Buffer.concat([head, buf]))) { try { source.pause(); } catch {} }
      });
      sock.on('drain', () => { try { source.resume(); } catch {} });
      source.once('end', () => { if (!done) { try { sock.write(Buffer.alloc(4)); } catch {} } });
      source.once('error', (e) => finish(reject, e));
    });
    sock.on('data', (d) => {
      resp += d.toString('utf8');
      // clamd z-commands terminate the verdict with NUL (no newline).
      if (!resp.includes('\n') && !resp.includes('\0')) return;
      const line = resp.replace(/\0/g, '').trim();
      const found = line.match(/^stream:\s*(.+?)\s+FOUND$/);
      if (/OK$/.test(line)) finish(resolve, { clean: true });
      else if (found) finish(resolve, { clean: false, virus: found[1].slice(0, 120) });
      else finish(reject, new Error('clamd_bad_response:' + line.slice(0, 120)));
    });
    sock.on('error', (e) => finish(reject, e));
    sock.on('close', () => { if (!done) finish(reject, new Error('clamd_closed')); });
  });
}

async function waitPong(tries) {
  for (let i = 0; i < (tries || 60); i++) {
    if (await pingClamd(3000)) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function ensureChain() {
  if (clamdReady || engineStarting) return;
  if (Date.now() - lastSpawnAttempt < 60000) return;
  lastSpawnAttempt = Date.now();
  engineStarting = true;
  try {
    writeConfs();
    // freshclam/clamd drop to the clamav user (UID 100:GID 101) — a
    // root-owned DB dir fails their writability check, so hand it over.
    // Best-effort: dev machines without that user just skip this.
    try { spawnSync('chown', ['-R', '100:101', dbDir()], { stdio: 'ignore', timeout: 15000 }); } catch {}
    if (!(await hasDbFiles())) {
      log('downloading ClamAV signature databases (one-time, a few minutes)…');
      const ok = await runFreshclam();
      if (!ok) warn('freshclam failed (network?) — will retry on next upload; uploads stay usable');
      try { spawnSync('chown', ['-R', '100:101', dbDir()], { stdio: 'ignore', timeout: 15000 }); } catch {}
    }
    if (!(await hasDbFiles())) throw new Error('no_signature_dbs');
    await new Promise((resolve) => {
      try {
        const child = spawn('clamd', ['--config-file=' + path.join(dbDir(), 'clamd.conf')],
          { stdio: 'ignore', detached: false });
        child.on('error', () => resolve());
        setTimeout(resolve, 3000);
        try { child.unref(); } catch {}
      } catch { resolve(); }
    });
    if (await waitPong(45)) {
      clamdReady = true;
      engineFailed = false;
      log('ClamAV engine ready (clamd on 127.0.0.1:' + CLAM_PORT + ')');
      kickVirusScan();
    } else {
      throw new Error('clamd_unreachable');
    }
  } catch (e) {
    engineFailed = true;
    warn('engine failed to start (' + String((e && e.message) || e).slice(0, 120) + ') — uploads fail open, admin alerted');
  } finally {
    engineStarting = false;
  }
}

// ---------- file access ----------

async function openFileStream(key) {
  // Returns {stream, size} or null when the bytes are already gone.
  if (storage.s3Enabled()) {
    try {
      const head = await storage.s3Head(key).catch(() => null);
      if (!head) {
        // Fall through to disk: covers files still local from before an S3 migration.
      } else {
        const data = await storage.s3Get(key);
        if (data && data.Body) return { stream: data.Body, size: Number(head.ContentLength) || 0 };
      }
    } catch { /* try disk below */ }
  }
  const p = path.join(UPLOAD_DIR, key);
  if (!path.resolve(p).startsWith(path.resolve(UPLOAD_DIR))) return null;
  try {
    const st = await fs.promises.stat(p);
    if (!st.isFile()) return null;
    return { stream: fs.createReadStream(p), size: st.size };
  } catch { return null; }
}

async function deleteBytes(key) {
  if (!key) return;
  if (storage.s3Enabled()) {
    try { await storage.s3DeleteNow(key); } catch {}
  }
  const p = path.join(UPLOAD_DIR, key);
  if (path.resolve(p).startsWith(path.resolve(UPLOAD_DIR))) {
    try { await fs.promises.unlink(p); } catch {}
  }
}

// ---------- worker ----------

async function markRow(key, status, error) {
  try {
    await db.prepare('UPDATE file_scans SET status = ?, attempts = attempts + 1, error = ?, scanned_at = ? WHERE key = ?')
      .run(status, String(error || '').slice(0, 200), now(), key);
  } catch {}
}

async function tick() {
  if (!ENABLED || !ready) return 'deferred';
  if (busy) return 'busy';
  let row = null;
  try {
    row = await db.prepare("SELECT key, attempts FROM file_scans WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1").get();
  } catch (e) {
    warn('queue read failed: ' + String((e && e.message) || e).slice(0, 160));
    return 'idle';
  }
  if (!row) return 'idle';
  // Fail-open paths: no engine (local dev) marks clean; a broken engine
  // marks `error` (served, but visible in admin) — never wedge uploads.
  if (noEngine) {
    await markRow(row.key, 'clean', '');
    stats.scanned++; stats.clean++;
    stats.lastScan = { key: row.key, result: 'clean', at: now() };
    await emitChange(row.key, 'clean');
    return 'more';
  }
  if (engineFailed) {
    await markRow(row.key, 'error', 'engine_unavailable');
    stats.scanned++; stats.errors++;
    stats.lastError = { key: row.key, error: 'engine_unavailable', at: now() };
    await emitChange(row.key, 'error');
    return 'more';
  }
  if (!clamdReady) {
    ensureChain().catch(() => {});
    return 'deferred';
  }
  if (!(await pingClamd(3000))) {
    clamdReady = false;
    ensureChain().catch(() => {});
    return 'deferred';
  }
  busy = true;
  stats.ticks++;
  stats.lastTickAt = now();
  try {
    const opened = await openFileStream(row.key);
    if (!opened) {
      // Bytes already gone (deleted message, sweep) — nothing to gate.
      try { await db.prepare('DELETE FROM file_scans WHERE key = ?').run(row.key); } catch {}
      return 'more';
    }
    const timeoutMs = Math.min(600000, 120000 + (Number(opened.size) || 0));
    let verdict;
    try {
      verdict = await clamdScanStream(opened.stream, timeoutMs);
    } catch (e) {
      try { opened.stream.destroy(); } catch {}
      throw e;
    }
    stats.scanned++;
    if (verdict.clean) {
      await markRow(row.key, 'clean', '');
      stats.clean++;
      stats.lastScan = { key: row.key, result: 'clean', at: now() };
      await emitChange(row.key, 'clean');
      log('clean: ' + row.key);
    } else {
      const virus = String(verdict.virus || 'malware').slice(0, 120);
      await markRow(row.key, 'infected', virus);
      stats.infected++;
      stats.lastScan = { key: row.key, result: 'infected:' + virus, at: now() };
      await deleteBytes(row.key);
      warn('INFECTED (' + virus + '): deleted bytes for ' + row.key);
      await emitChange(row.key, 'infected');
    }
    return 'more';
  } catch (e) {
    const err = String((e && e.message) || e).slice(0, 160);
    stats.errors++;
    stats.lastError = { key: row.key, error: err, at: now() };
    warn('scan failed for ' + row.key + ': ' + err);
    if ((Number(row.attempts) || 0) + 1 >= MAX_ATTEMPTS) {
      await markRow(row.key, 'error', err); // fail open after retries
      await emitChange(row.key, 'error');
    } else {
      try { await db.prepare('UPDATE file_scans SET attempts = attempts + 1, error = ? WHERE key = ?').run(err, row.key); } catch {}
    }
    if (/ECONNREFUSED|clamd_closed|clamd_timeout/.test(err)) { clamdReady = false; ensureChain().catch(() => {}); }
    return 'more';
  } finally {
    busy = false;
  }
}

function schedule(ms) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(loop, ms);
  try { timer.unref(); } catch {}
}

async function loop() {
  timer = null;
  let st = 'idle';
  try { st = await tick(); }
  catch (e) { warn('tick failed: ' + String((e && e.message) || e).slice(0, 200)); st = 'idle'; }
  schedule(st === 'more' ? 500 : st === 'busy' || st === 'deferred' ? 5000 : IDLE_MS);
}

function kickVirusScan() {
  if (!started || !ENABLED || !ready || busy) return;
  schedule(KICK_MS);
}

async function getScanStats() {
  const counts = { pending: 0, clean: 0, infected: 0, error: 0 };
  try {
    const rows = await db.prepare('SELECT status, COUNT(*) c FROM file_scans GROUP BY status').all();
    for (const r of rows) {
      if (counts[r.status] !== undefined) counts[r.status] = Number(r.c) || 0;
    }
  } catch {}
  let dbAgeMs = null, dbPresent = false;
  try {
    const files = await fs.promises.readdir(dbDir());
    const dbs = files.filter((f) => /\.(cvd|cld)$/.test(f));
    dbPresent = dbs.length > 0;
    if (dbPresent) {
      let newest = 0;
      for (const f of dbs) {
        try { const st = await fs.promises.stat(path.join(dbDir(), f)); newest = Math.max(newest, st.mtimeMs); } catch {}
      }
      if (newest) dbAgeMs = Date.now() - newest;
    }
  } catch {}
  return {
    enabled: ENABLED, engine: !ENABLED ? 'off' : noEngine ? 'none' : engineFailed ? 'failed' : clamdReady ? 'ready' : 'starting',
    clamdReady, dbPresent, dbAgeMs, counts,
    startedAt: stats.startedAt, ticks: stats.ticks,
    scanned: stats.scanned, clean: stats.clean, infected: stats.infected, errors: stats.errors,
    lastTickAt: stats.lastTickAt, lastScan: stats.lastScan, lastError: stats.lastError,
  };
}

function startVirusScan() {
  if (started) return;
  started = true;
  if (!ENABLED) { log('disabled (VIRUS_SCAN=0) — uploads marked clean'); return; }
  ensureTables().then(() => {
    stats.startedAt = now();
    if (!haveBinaries()) {
      noEngine = true;
      if (!loggedNoEngine) { loggedNoEngine = true; warn('clamd/freshclam not found — uploads fail open as clean (install clamav-daemon for real scanning)'); }
      schedule(2000);
      return;
    }
    log('worker on (clamd at 127.0.0.1:' + CLAM_PORT + ', signatures in ' + dbDir() + ')');
    schedule(2000);
    ensureChain().catch(() => {});
    // Signature refresh: one-shot freshclam runs exit after updating;
    // clamd picks the new DBs up on its own SelfCheck.
    const t = setInterval(() => {
      if (clamdReady || engineFailed) {
        runFreshclam().then((ok) => { if (!ok) warn('scheduled freshclam run failed'); });
      }
    }, 6 * 3600 * 1000);
    try { t.unref(); } catch {}
  }).catch((e) => warn('migration failed: ' + String((e && e.message) || e).slice(0, 200)));
}

module.exports = {
  startVirusScan, kickVirusScan, queueFileScan, dropScan,
  scanStatus, scanStatusMap, scanGating, setScanHooks, getScanStats,
  // exported for unit tests (fake clamd server):
  _clamdScanStream: clamdScanStream, _pingClamd: pingClamd,
};
