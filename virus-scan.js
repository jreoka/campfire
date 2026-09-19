// Virus scanning for uploads (ClamAV): every stored file is judged by content,
// and a verdict can only ever REMOVE malware — it never holds a file back.
//
// Why scan everything, not just .exe: beyond blocking obviously dangerous
// types, anyone can rename malware.exe to photo.jpg, share it, and tell
// people to rename it back after downloading. Content sniffing by
// extension is theater — so every uploaded file is scanned by content.
//
// Why ClamAV (https://www.clamav.net), in its own container: it is the
// reference open-source signature engine, and a signature engine is only worth
// running with current signatures — a database to hold, a downloader on a
// schedule, and a daemon that keeps the database loaded in RAM. That is a
// service, so it is a sibling `clamav/clamav` container (see docker-compose.yml)
// and this app is a client of it over TCP. Nothing about that database belongs in
// the app's image or its process, and nothing about the app's filesystem needs to
// be visible to the daemon: uploads are STREAMED to it with `INSTREAM` (see
// clamav.js), so a scan costs no staging copy and needs no shared volume.
//
// Flow:
// - /api/upload (and every image uploader) stores the bytes, then
//   queueFileScan(key) records a `pending` row in file_scans.
// - The worker below STREAMS those bytes into clamd (from disk, or straight
//   from the object store — neither is ever staged) a few files at a time.
// - THE UPLOAD IS SERVED THE MOMENT IT LANDS. A pending row is not a gate:
//   `effectiveStatus` reports it as clean, so the file the sender attached is
//   the file the reader gets and the verdict follows behind them. That is the
//   whole posture — an upload used to be held back until a scan AND an ffmpeg
//   pass had both finished, which is the "Processing file" card this module no
//   longer produces. /uploads/* still refuses an INFECTED key (410, its bytes
//   are deleted), which is the only thing the gate is for now.
// - `infected` deletes the bytes immediately (S3 + local) but keeps the
//   message + attachment row so the chat shows a greyed-out warning, and the
//   message is re-broadcast so the card flips without a refresh.
// - COMPRESSION IS NOT PART OF THIS MODULE. Making bytes smaller is
//   media-compress.js's business, entirely out of band: the scheduled bucket
//   sweep for anything ordinary, and its compatibility queue for the formats a
//   reader's platform cannot open at all. Nothing about an upload waits for
//   either of them, and no part of this pipeline calls the compressor.
// - On every verdict change the server re-broadcasts the affected messages
//   (hooked via setScanHooks) so an infected card turns into the warning —
//   and so a message whose bytes the compressor republished under a new key
//   learns the new URL.
//
// Verdicts are recorded against the ENGINE THAT MADE THEM (`engine`, e.g.
// `clamav/1.4.6`) rather than against "ClamAV" as a word. That column is the
// bucket sweep's ledger (bucket-scan.js): a row whose engine is not the engine
// running now — an upload from before the swap, or from a ClamAV generation
// before this one — is exactly what a background pass re-judges. Upgrading
// ClamAV is therefore what re-verifies the stored tree, with no migration step
// and no flag to remember. Signature UPDATES within one generation are
// deliberately not a new generation: a daily database bump re-scanning every
// stored object would be an unbounded job for no security gain, and every new
// upload is judged by the current database anyway.
//
// Failure posture is fail-OPEN with loud logs + admin visibility: without
// working AV (no clamd in local dev, a daemon that cannot load its database)
// uploads must keep working, never wedge in `pending` forever.
//
// Env:
//   VIRUS_SCAN=0             disable scanning entirely. With no scanner there
//                            are no verdicts at all: every upload is recorded
//                            `clean` as it lands and nothing is ever refused
//                            (compression is unaffected either way — it is a
//                            separate, background concern).
//   CLAMAV_HOST              clamd host (default `clamav`, the compose service)
//   CLAMAV_PORT              clamd TCP port (default 3310)
//   CLAMAV_TIMEOUT_MS        base per-file scan timeout in ms (default 120000,
//                            plus the file's own size; capped at 10 minutes)
//   CLAMAV_VERIFY_EICAR=1    the probe also proves the daemon detects the EICAR
//                            test string (set in the Docker image)
//   VIRUS_SCAN_CONCURRENCY   scan slots (default 3, max 10)
'use strict';

const fs = require('fs');
const path = require('path');

const db = require('./db');
const storage = require('./storage');
const clamav = require('./clamav');

const now = () => Date.now();
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads');
const SCANNING = process.env.VIRUS_SCAN !== '0';

const KICK_MS = 500;
const IDLE_MS = 10000;
const MAX_ATTEMPTS = 3;
// I/O timeouts: every awaited network call below is bounded. An unbounded
// S3 stall once wedged a slot forever (claim held, row at attempts=0,
// small image "stuck on scanning" on an otherwise idle box).
const S3_HEAD_TIMEOUT_MS = 30000;
const S3_GET_TIMEOUT_MS = 30000;
const S3_DELETE_TIMEOUT_MS = 30000;
// Watchdog: a slot holding a claim longer than this (max scan timeout +
// headroom) is presumed wedged — release the claim + count an attempt so
// another slot retries. The dangling op, if it ever lands, is idempotent.
const SLOT_TIMEOUT_MS = 12 * 60 * 1000;
// Parallel scan slots. Each slot holds one connection to clamd and streams one
// file through it; the daemon's own MaxThreads (see the compose file) is the
// ceiling on how many it can serve, so this stays well under it. Memory per slot
// is one 64 KiB chunk in flight (nothing is buffered whole), which is why this
// can be a handful rather than a queue of one.
const _conc = parseInt(process.env.VIRUS_SCAN_CONCURRENCY || '3', 10);
const CONCURRENCY = Math.min(10, Math.max(1, Number.isFinite(_conc) ? _conc : 3));
// How long a broken engine waits before it is probed again. A transient
// failure (a daemon reloading its database, an OOM kill) must not turn scanning
// off for the lifetime of the process.
const ENGINE_RETRY_MS = 30000;

const log = (...a) => console.log('[virusscan]', ...a);
const warn = (...a) => console.warn('[virusscan]', ...a);

let started = false;
let ready = false; // tables exist; worker loop may run
let active = 0; // scans currently in flight (<= CONCURRENCY)
const claimed = new Set(); // keys held by in-flight slots (single process)
const claimAt = new Map(); // key -> claim timestamp (watchdog)
let timer = null;
let lastStuckWarn = 0;
let noEngine = false; // clamd not reachable — fail open
let engineFailed = false; // reachable but unusable — fail open, loudly
let engineStarting = false;
let engineReady = false;
let engineIdentity = null; // 'clamav/1.4.6' — the ledger mark written on every verdict
let engineInfo = null; // { engine, db, dbDate, raw } — the admin line's detail
let lastProbeAt = 0;
let loggedNoEngine = false;
const hooks = { onScanChange: null };
const stats = {
  startedAt: 0, ticks: 0, scanned: 0, clean: 0, infected: 0, errors: 0,
  lastTickAt: 0, lastScan: null, lastError: null,
};

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
  // Who holds the row right now. Claiming used to be an in-process Set, which
  // was only safe because a single process drove a single loop — on more than
  // one replica every pod would claim the same key (guarded migrations, so an
  // existing database picks these up in place).
  await db.exec('ALTER TABLE file_scans ADD COLUMN IF NOT EXISTS claimed_by TEXT');
  await db.exec('ALTER TABLE file_scans ADD COLUMN IF NOT EXISTS claimed_at BIGINT');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_file_scans_claim ON file_scans(status, claimed_at)');
  // What the ENGINE said, kept so a verdict can be explained later instead of
  // being a status with no reasoning behind it (the attachment menu's "Scan
  // info" reads these; a status alone cannot say what was found or by which
  // engine generation).
  await db.exec("ALTER TABLE file_scans ADD COLUMN IF NOT EXISTS verdict TEXT");
  await db.exec('ALTER TABLE file_scans ADD COLUMN IF NOT EXISTS score REAL');
  await db.exec("ALTER TABLE file_scans ADD COLUMN IF NOT EXISTS evidence TEXT NOT NULL DEFAULT ''");
  // The engine generation ('clamav/1.4.6'), never the word "ClamAV": this column
  // is the bucket sweep's ledger marker, and a generation change is what makes
  // the stored tree get re-judged (see the header).
  await db.exec("ALTER TABLE file_scans ADD COLUMN IF NOT EXISTS engine TEXT NOT NULL DEFAULT ''");
  // Legacy column, kept so an existing database upgrades in place and so a
  // replica still running the previous build reads a row the way that build
  // expects. It is written 0 by every queue in THIS build (nothing holds a file
  // back while a verdict is in flight — see effectiveStatus) and nothing here
  // reads it any more.
  await db.exec('ALTER TABLE file_scans ADD COLUMN IF NOT EXISTS gated INTEGER NOT NULL DEFAULT 1');
  ready = true;
}

// ---------- public intake ----------

// Record an upload for the worker to judge. The row goes to `pending` and is
// UNGATED: the bytes are already being served, so the verdict that comes back
// can only ever remove them (see effectiveStatus). Without a scanner there is no
// verdict to record and nothing to ask, so nothing is written at all — an
// unknown key is clean everywhere (see scanStatus).
//
// (`gated` is written explicitly as 0 rather than left to the column default of
// 1: during a rolling update an older replica is still running the code that
// read it, and it must not start holding this upload back. Nothing in THIS
// build reads the column — the Scan info panel is the only place it survives.)
async function queueFileScan(key) {
  if (!key) return 'clean';
  try { await ensureTables(); } catch {}
  if (!SCANNING) return 'clean';
  try {
    // On conflict `gated` only ever moves toward "not gated" — a key queued by
    // an older build (or before the column existed) is not held back either.
    await db.prepare(`INSERT INTO file_scans (key,status,attempts,error,created_at,scanned_at,gated)
      VALUES (?,'pending',0,'',?,NULL,0) ON CONFLICT(key) DO UPDATE SET
      status = CASE WHEN file_scans.status = 'infected' THEN 'infected' ELSE 'pending' END,
      attempts = 0, error = '', scanned_at = NULL,
      verdict = NULL, score = NULL, evidence = '', engine = '',
      gated = 0`).run(key, now());
  } catch (e) {
    warn('queue failed for ' + key + ': ' + String((e && e.message) || e).slice(0, 120));
    return 'clean'; // fail open: never wedge an upload on a DB hiccup
  }
  kickVirusScan();
  return 'clean';
}

// What serving and the clients are told. A `pending` row is CLEAN as far as
// anyone is concerned: the bytes are served, the chat card is the real file, and
// only an actual detection changes anything. Nothing holds a file back while a
// verdict is in flight — that promise was the old gate, and it is gone.
function effectiveStatus(status) {
  if (!status) return 'clean';
  if (status === 'pending') return 'clean';
  return status;
}

// Single status; unknown keys (non-chat prefixes, uploads from before the
// feature) are `clean` — only rows say otherwise.
async function scanStatus(key) {
  if (!key || !SCANNING) return 'clean';
  try {
    const r = await db.prepare('SELECT status, gated FROM file_scans WHERE key = ?').get(key);
    return r ? effectiveStatus(r.status) : 'clean';
  } catch { return 'clean'; }
}

// Batch version for message hydration (one query per page, not per file).
async function scanInfoMap(keys) {
  const out = new Map();
  const uniq = [...new Set((keys || []).filter(Boolean))];
  if (!uniq.length || !SCANNING) return out;
  try {
    const ph = uniq.map(() => '?').join(',');
    const rows = await db.prepare(`SELECT key, status, gated FROM file_scans WHERE key IN (${ph})`).all(...uniq);
    for (const r of rows) out.set(r.key, { status: effectiveStatus(r.status) });
  } catch {}
  return out;
}

// The effective status alone, for callers that only gate on it.
async function scanStatusMap(keys) {
  const out = new Map();
  for (const [k, v] of await scanInfoMap(keys)) out.set(k, v.status);
  return out;
}

// The RAW record, for the "Scan info" panel: the effective status hides the
// fact that a re-scan is queued, and hides `attempts`/`error` entirely, and this
// view exists to show the reader exactly that.
async function scanDetail(key) {
  if (!key) return null;
  try { await ensureTables(); } catch {}
  try {
    return await db.prepare(`SELECT key, status, attempts, error, created_at, scanned_at,
      verdict, score, evidence, engine FROM file_scans WHERE key = ?`).get(key) || null;
  } catch { return null; }
}

// Whether the /uploads gate enforces verdicts at all: it does whenever a scanner
// is configured, because an infected key's bytes are deleted and a direct link
// has to be told why. It never holds a pending file back — see effectiveStatus.
function scanGating() {
  return SCANNING;
}

function setScanHooks(h) {
  if (h && typeof h.onScanChange === 'function') hooks.onScanChange = h.onScanChange;
}

async function emitChange(key, status) {
  if (!hooks.onScanChange) return;
  try { await hooks.onScanChange(key, status); }
  catch (e) { warn('onScanChange failed: ' + String((e && e.message) || e).slice(0, 160)); }
}

// ---------- the ClamAV engine ----------

// The engine generation every verdict is recorded against. `clamav/<version>`,
// deliberately not the signature database revision: a new ClamAV is what
// re-verifies the stored tree (bucket-scan.js), while a daily signature bump
// must not turn into a nightly full-bucket rescan.
function identityFor(info) {
  const engine = (info && info.engine) || '';
  return engine ? 'clamav/' + engine : '';
}

async function ensureEngine() {
  if (engineReady || engineStarting) return;
  if (now() - lastProbeAt < ENGINE_RETRY_MS) return;
  lastProbeAt = now();
  engineStarting = true;
  try {
    const probe = await clamav.probe();
    if (!probe.ok) {
      if (probe.why === 'clamav_unreachable') {
        noEngine = true;
        engineFailed = false;
        if (!loggedNoEngine) {
          loggedNoEngine = true;
          warn('ClamAV not reachable at ' + clamav.host() + ':' + clamav.port()
            + ' — uploads fail open as clean until the clamav service is up (see docker-compose.yml)');
        }
      } else {
        noEngine = false;
        engineFailed = true;
        warn('ClamAV unusable (' + probe.why + ') — uploads fail open, admin alerted');
      }
      return;
    }
    engineInfo = { engine: probe.engine, db: probe.db, dbDate: probe.dbDate };
    engineIdentity = identityFor(probe);
    engineReady = true;
    engineFailed = false;
    noEngine = false;
    log('ClamAV engine ready (' + clamav.host() + ':' + clamav.port() + ' — ' + probe.engine
      + ', signatures ' + probe.db + ' ' + probe.dbDate
      + (clamav.eicarVerification() ? ', EICAR detected' : '') + ')');
    kickVirusScan();
  } catch (e) {
    engineFailed = true;
    warn('engine probe failed (' + String((e && e.message) || e).slice(0, 120) + ') — uploads fail open, admin alerted');
  } finally {
    engineStarting = false;
  }
}

// The verdict, built from the daemon's own answer. ClamAV has exactly two
// outcomes — a signature matched, or nothing did — so there is no middle band to
// carry: `clean: false` is a detection, and `signature` is the name of the
// signature that matched, which is the finding worth storing.
//   { clean: true,  detail }                  nothing found
//   { clean: false, signature, detail }       a detection
// Throws on anything that means "the engine did not answer" (see clamav.js).
// Callers reach it through scanStream(), which is what guarantees the engine
// identity exists first.
async function verdictFor(stream, opts) {
  const res = await clamav.scanStream(stream, opts);
  const detail = {
    verdict: res.clean ? 'clean' : 'malicious',
    signature: res.signature || null,
    bytes: res.bytes,
    db: engineInfo && engineInfo.db ? engineInfo.db : null,
  };
  if (res.clean) return { clean: true, detail };
  return { clean: false, signature: res.signature || 'malware', detail };
}

// Test-only: put the module in the state a successful probe leaves it in, so a
// unit test can exercise the verdict path with no database (startVirusScan is
// what normally probes, and it owns a migration this module's other tests do not
// need). Never called by the app.
function setEngineForTest(info) {
  engineInfo = { engine: info.engine, db: info.db, dbDate: info.dbDate };
  engineIdentity = identityFor(engineInfo);
  engineReady = true;
  engineFailed = false;
  noEngine = false;
}

// The label stored in the row's `error` column: what the chat card and the
// admin panel show in one line. Names the engine, because a verdict is only
// meaningful with the engine that produced it.
function virusLabel(signature) {
  return ('ClamAV: ' + String(signature || 'malware')).slice(0, 120);
}

// Flatten a verdict into the row's columns. The engine generation is written on
// every verdict — it is the bucket sweep's ledger mark (see the header).
function detailFor(v) {
  const d = (v && v.detail) || {};
  const lines = [];
  if (d.signature) lines.push('signature: ' + d.signature);
  if (d.db) lines.push('signatures: ' + d.db);
  if (Number.isFinite(d.bytes)) lines.push('bytes scanned: ' + d.bytes);
  return {
    verdict: String(d.verdict || 'clean').slice(0, 20),
    score: null,
    evidence: lines.join('\n').slice(0, 600),
    engine: String(engineIdentity || '').slice(0, 120),
  };
}

// ---------- file access ----------

function withTimeout(p, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label || 'io_timeout')), ms);
    try { t.unref(); } catch {}
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// The bytes for one key, as a STREAM the daemon can be fed — nothing is ever
// staged to disk for a scan, which is the point of INSTREAM (see the clamav.js
// header): the object store's own body is piped through, and a local file is
// read where it lies.
// Returns { stream, size, where, close } or null when the bytes are already gone.
// Genuinely-missing objects (NoSuchKey) fall through to null (the row is
// dropped); any other storage failure THROWS so the row retries with
// attempts++ instead of being mistaken for gone (an error is fail-open but
// stays visible, a wrong null would silently skip the scan).
async function openBytes(key) {
  const isGone = (e) => {
    const code = e?.$metadata?.httpStatusCode;
    return code === 404 || code === 403 || e?.name === 'NoSuchKey' || e?.name === 'NotFound';
  };
  if (storage.s3Enabled()) {
    let head = null;
    try {
      head = await withTimeout(storage.s3Head(key), S3_HEAD_TIMEOUT_MS, 's3head_timeout');
    } catch (e) {
      if (!isGone(e)) throw e;
    }
    if (head) {
      let data = null;
      try {
        data = await withTimeout(storage.s3Get(key), S3_GET_TIMEOUT_MS, 's3get_timeout');
      } catch (e) {
        if (!isGone(e)) throw e;
      }
      if (data && data.Body) {
        return { stream: data.Body, size: Number(head.ContentLength) || 0, where: 's3', close: () => { try { data.Body.destroy(); } catch {} } };
      }
      if (data && !data.Body) return null;
      // head ok but get failed-gone: fall through to disk before giving up.
    }
  }
  const p = path.join(UPLOAD_DIR, key);
  if (!path.resolve(p).startsWith(path.resolve(UPLOAD_DIR))) return null;
  let st = null;
  try {
    st = await fs.promises.stat(p);
  } catch { return null; }
  if (!st.isFile()) return null;
  const stream = fs.createReadStream(p);
  return { stream, size: st.size, where: 'disk', close: () => { try { stream.destroy(); } catch {} } };
}

async function deleteBytes(key) {
  if (!key) return;
  if (storage.s3Enabled()) {
    try { await withTimeout(storage.s3DeleteNow(key), S3_DELETE_TIMEOUT_MS, 's3delete_timeout'); } catch {}
  }
  const p = path.join(UPLOAD_DIR, key);
  if (path.resolve(p).startsWith(path.resolve(UPLOAD_DIR))) {
    try { await fs.promises.unlink(p); } catch {}
  }
}

// Judge one stream. Throws when the engine did not answer (the caller's retry
// path); returns a verdict otherwise. The engine being ready is normally
// guaranteed by the caller — this re-check is the safety net for any other
// entry point, and it goes through the same state machine so a successful
// probe here leaves the module consistent rather than half-initialised.
async function scanStream(src, opts) {
  if (!engineReady) {
    await ensureEngine();
    if (!engineReady) throw new Error(noEngine ? 'clamav_unreachable' : 'clamav_unavailable');
  }
  const label = (opts && opts.label) || 'upload';
  if (!engineIdentity) {
    // A verdict must be marked with the engine that made it or the bucket
    // sweep would re-queue it forever; the probe is the only source of that.
    await ensureEngine();
    if (!engineIdentity) throw new Error('clamav_unavailable');
  }
  return verdictFor(src.stream, { size: src.size, label });
}

// ---------- worker ----------

async function markRow(key, status, error, detail) {
  const d = detail || {};
  try {
    await db.prepare(`UPDATE file_scans SET status = ?, attempts = attempts + 1, error = ?, scanned_at = ?,
        verdict = ?, score = ?, evidence = ?, engine = ? WHERE key = ?`)
      .run(status, String(error || '').slice(0, 200), now(),
        d.verdict ? String(d.verdict).slice(0, 20) : null,
        Number.isFinite(d.score) ? d.score : null,
        String(d.evidence || '').slice(0, 600),
        String(d.engine || '').slice(0, 120), key);
  } catch {}
}

async function tick() {
  if (!SCANNING || !ready) return 'deferred';
  if (active >= CONCURRENCY) return 'busy';
  const row = await claimRow();
  if (!row) return 'idle';
  active++;
  stats.ticks++;
  stats.lastTickAt = now();
  processRow(row).then(
    (hint) => schedule(hint === 'later' ? 5000 : 400), // freed slot refills fast
    (e) => { warn('scan failed: ' + String((e && e.message) || e).slice(0, 160)); schedule(1000); }
  ).finally(() => { active--; });
  return 'more';
}

// This replica's identity, used to record who holds a claim. Shares bus.js's
// POD_ID so it lines up with bus_replicas (the liveness table everything else
// reconciles against).
let _podId = null;
function podId() {
  if (!_podId) { try { _podId = require('./bus').POD_ID; } catch { _podId = process.env.HOSTNAME || 'pod'; } }
  return _podId;
}

// Claim the oldest claimable pending row ATOMICALLY IN THE DATABASE.
// The in-process Set this replaced was only safe with one process driving one
// loop: with two replicas both would claim the same key and scan the same bytes
// twice, doubling the work against a daemon whose threads are the real ceiling.
// FOR UPDATE SKIP LOCKED makes concurrent claimers step over each other's rows
// instead of colliding.
// A claim older than SLOT_TIMEOUT_MS is reclaimable, so a crashed replica's rows
// come back on their own.
async function claimRow() {
  let row = null;
  try {
    row = await db.prepare(
      `UPDATE file_scans SET claimed_by = ?, claimed_at = ?
        WHERE key = (
          SELECT key FROM file_scans
           WHERE status = 'pending'
             AND (claimed_at IS NULL OR claimed_at < ?)
           ORDER BY created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING key, attempts`
    ).get(podId(), now(), now() - SLOT_TIMEOUT_MS);
  } catch (e) {
    warn('claim failed: ' + String((e && e.message) || e).slice(0, 160));
    return null;
  }
  if (!row || !row.key) return null;
  claimed.add(row.key);       // local bookkeeping for the stall log
  claimAt.set(row.key, now());
  return row;
}

// Release claims stuck longer than SLOT_TIMEOUT_MS (wedged I/O the per-call
// timeouts somehow missed). The row stays pending for retry and the attempt
// counter still bounds a permanently broken file. Read from the DATABASE, so a
// claim held by a replica that died is released too — the in-process map could
// only ever see its own. A slot only ever streams bytes into clamd, so a claim
// older than the lease is genuinely stuck (the compressor no longer runs inside
// this worker — see the header).
async function reapStuckClaims() {
  let rows = [];
  try {
    rows = await db.prepare(
      "SELECT key FROM file_scans WHERE status = 'pending' AND claimed_at IS NOT NULL AND claimed_at < ?"
    ).all(now() - SLOT_TIMEOUT_MS);
  } catch (e) {
    warn('claim reap read failed: ' + String((e && e.message) || e).slice(0, 160));
    return;
  }
  for (const r of rows) {
    claimAt.delete(r.key);
    claimed.delete(r.key);
    warn('slot watchdog: released stuck claim on ' + r.key);
    try { await db.prepare('UPDATE file_scans SET attempts = attempts + 1, claimed_by = NULL, claimed_at = NULL WHERE key = ?').run(r.key); } catch {}
  }
}

// A claim is a LEASE, and the watchdog above only ever expires one on a clock
// because a slot that is merely SLOW has to keep its row. A slot whose POD is
// gone will never release anything, though: the process died holding the claim
// and `claimRow` refuses to hand that row to anyone else until the lease ages
// out. So a restart or a deploy that caught a file mid-scan left its row
// `pending` for up to twelve more minutes — no longer a card the reader stares
// at (the bytes are served either way now), but twelve minutes without the
// verdict the whole feature exists to produce.
//
// The replica registry already answers "is that pod still alive?" —
// bus_replicas + PEER_STALE_MS, the same idiom reconcileReplicaState uses to
// reap voice occupancy and live sessions — so a claim whose owner is not in it
// is released at once and the next tick picks the row up. A rolling update is
// unaffected: a peer that is still heartbeating keeps every claim it holds, and
// so does this process. A graceful stop deletes the row on the way out (see
// bus.stop), which is why a deploy recovers immediately; a replica that CRASHED
// is recognised once its heartbeat goes stale, so recovery is bounded by
// PEER_STALE_MS rather than by the slot lease.
//
// `attempts` is deliberately NOT bumped, unlike the stalled-slot watchdog: a
// restart is not the file's fault, and counting it would let two ordinary
// deploys push a perfectly good upload to MAX_ATTEMPTS and mark it `error`.
async function releaseDeadClaims() {
  let owners = [];
  try {
    owners = await db.prepare(
      "SELECT DISTINCT claimed_by FROM file_scans WHERE status = 'pending' AND claimed_by IS NOT NULL"
    ).all();
  } catch (e) {
    warn('claim liveness read failed: ' + String((e && e.message) || e).slice(0, 160));
    return;
  }
  if (!owners.length) return;
  const live = new Set([podId()]);
  try {
    const bus = require('./bus');
    // With the registry off there is no second replica to be confused about
    // (BUS=0 is single-replica by contract, see bus.js), so every claim that is
    // not this process's belongs to a predecessor that is gone.
    if (bus.stats().enabled) for (const p of await bus.liveReplicas()) live.add(p.pod_id);
  } catch {}
  for (const o of owners) {
    if (!o.claimed_by || live.has(o.claimed_by)) continue;
    try {
      // RETURNING, so the log line can say how many rows actually moved. Nothing
      // local is touched: `claimed`/`claimAt` only ever hold THIS process's own
      // claims, and a claim that is not ours is never in them.
      const freed = await db.prepare(
        "UPDATE file_scans SET claimed_by = NULL, claimed_at = NULL WHERE status = 'pending' AND claimed_by = ? RETURNING key"
      ).all(o.claimed_by);
      if (freed.length) {
        warn(`released ${freed.length} claim(s) left by a replica that is gone (${o.claimed_by}): ` + freed.map((r) => r.key).join(', '));
      }
    } catch (e) {
      warn('claim release failed: ' + String((e && e.message) || e).slice(0, 160));
    }
  }
}

// Returns 'done' (slot refills immediately) or 'later' (back off: engine
// unavailable, nothing to do until ensureEngine finishes).
// NOTE: every return path below runs through the outer finally — early
// returns must never bypass claim release (that wedged rows at
// attempts=0 with an idle box: claimed but no live slot).
async function processRow(row) {
  try {
  // Fail-open paths: no engine (local dev) marks clean; a broken engine
  // marks `error` (served, but visible in admin) — never wedge uploads. A
  // broken engine is re-probed on the retry interval, so a transient failure
  // recovers instead of leaving scanning off for the life of the process.
  if (noEngine) {
    // Re-probe on the retry interval: bringing the clamav service up starts
    // scanning without a restart, and the probe is throttled so a dev box
    // without a daemon is not opening a socket per upload.
    ensureEngine().catch(() => {});
    await markRow(row.key, 'clean', '');
    stats.scanned++; stats.clean++;
    stats.lastScan = { key: row.key, result: 'clean', at: now() };
    await emitChange(row.key, 'clean');
    return 'done';
  }
  if (engineFailed) {
    ensureEngine().catch(() => {});
    await markRow(row.key, 'error', 'engine_unavailable');
    stats.scanned++; stats.errors++;
    stats.lastError = { key: row.key, error: 'engine_unavailable', at: now() };
    await emitChange(row.key, 'error');
    return 'done';
  }
  if (!engineReady) {
    ensureEngine().catch(() => {});
    return 'later';
  }
  let src = null;
  try {
    src = await openBytes(row.key);
    if (!src) {
      // Bytes already gone (deleted message, sweep) — nothing to judge.
      try { await db.prepare('DELETE FROM file_scans WHERE key = ?').run(row.key); } catch {}
      return 'done';
    }
    const verdict = await scanStream(src, { label: row.key });
    stats.scanned++;
    if (verdict.clean) {
      // The verdict describes the bytes that are already being served: this
      // module never rewrites an upload (see the header), so the key it was
      // asked about is the key it publishes for.
      await markRow(row.key, 'clean', '', detailFor(verdict));
      stats.clean++;
      stats.lastScan = { key: row.key, result: 'clean', at: now() };
      await emitChange(row.key, 'clean');
      log('clean: ' + row.key);
    } else {
      const virus = virusLabel(verdict.signature);
      await markRow(row.key, 'infected', virus, detailFor(verdict));
      stats.infected++;
      stats.lastScan = { key: row.key, result: 'infected:' + virus, at: now() };
      await deleteBytes(row.key);
      warn('INFECTED (' + virus + '): deleted bytes for ' + row.key);
      await emitChange(row.key, 'infected');
    }
    return 'done';
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
    if (/clamav_unavailable|clamav_unreachable|clamav_connect|clamav_timeout/.test(err)) {
      engineReady = false;
      ensureEngine().catch(() => {});
    }
    return 'done';
  } finally {
    if (src) { try { src.close(); } catch {} }
  }
  } finally {
    claimed.delete(row.key);
    claimAt.delete(row.key);
    // Hand the row back so another replica (or a later tick here) can take it.
    try { await db.prepare('UPDATE file_scans SET claimed_by = NULL, claimed_at = NULL WHERE key = ?').run(row.key); } catch {}
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
  try {
    try { await reapStuckClaims(); } catch {}
    // ...and hand back anything a replica that is GONE was holding, so a restart
    // mid-scan recovers in seconds instead of waiting out the slot lease.
    try { await releaseDeadClaims(); } catch {}
    // Fill every free slot (each 'more' claimed one row into a slot).
    let claimedAny = false;
    for (let i = 0; i < CONCURRENCY; i++) {
      st = await tick();
      if (st === 'more') claimedAny = true;
      else break;
    }
    // Audible when work sits unclaimed: pending rows with zero progress
    // used to fail completely silently (throttled so the log stays clean).
    if (!claimedAny && active === 0 && now() - lastStuckWarn > 60000) {
      try {
        const r = await db.prepare("SELECT COUNT(*) c FROM file_scans WHERE status = 'pending'").get();
        if (Number(r && r.c) > 0) {
          lastStuckWarn = now();
          warn(`stalled? pending=${r.c} ready=${ready} engineFailed=${engineFailed} noEngine=${noEngine} engineReady=${engineReady} active=${active} claimed=${claimed.size}`);
        }
      } catch {}
    }
  }
  catch (e) { warn('tick failed: ' + String((e && e.message) || e).slice(0, 200)); st = 'idle'; }
  schedule(st === 'more' ? 500 : st === 'busy' || st === 'deferred' ? 5000 : IDLE_MS);
}

function kickVirusScan() {
  if (!started || !SCANNING || !ready || active >= CONCURRENCY) return;
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
  return {
    enabled: SCANNING, scanning: SCANNING,
    engine: !SCANNING ? 'off' : noEngine ? 'none' : engineFailed ? 'failed' : engineReady ? 'ready' : 'starting',
    engineReady, engineIdentity, engineInfo,
    engineHost: clamav.host() + ':' + clamav.port(),
    eicarVerified: clamav.eicarVerification(),
    counts,
    concurrency: CONCURRENCY, active, busy: active > 0,
    stuck: [...claimAt].map(([key, at]) => ({ key, ageMs: now() - at })).filter((x) => x.ageMs > 60000),
    startedAt: stats.startedAt, ticks: stats.ticks,
    scanned: stats.scanned, clean: stats.clean, infected: stats.infected,
    errors: stats.errors,
    lastTickAt: stats.lastTickAt, lastScan: stats.lastScan, lastError: stats.lastError,
  };
}

function startVirusScan() {
  if (started) return;
  started = true;
  // No scanner: there is no verdict to ask for, so nothing is queued (see
  // queueFileScan) and this worker has nothing to do. Uploads are served the
  // moment they land, exactly as they are with a scanner — they are simply
  // never judged.
  if (!SCANNING) { log('disabled (VIRUS_SCAN=0) — uploads are served as they land, unscanned'); return; }
  ensureTables().then(() => {
    stats.startedAt = now();
    log('worker on (ClamAV at ' + clamav.host() + ':' + clamav.port() + ', streaming with INSTREAM; verdicts are background — they never hold a file back)');
    schedule(2000);
    ensureEngine().catch(() => {});
  }).catch((e) => warn('migration failed: ' + String((e && e.message) || e).slice(0, 200)));
}

module.exports = {
  startVirusScan, kickVirusScan, queueFileScan,
  scanStatus, scanStatusMap, scanInfoMap, scanGating, setScanHooks, getScanStats,
  scanDetail, effectiveStatus,
  scanningEnabled: () => SCANNING,
  // The engine generation running right now ('clamav/1.4.6'), for callers that
  // need to say whether a stored verdict came from this engine or an earlier one
  // (the Scan info panel). Cheap: it is the identity the last probe recorded.
  engineNow: () => engineIdentity,
  emitScanChange: emitChange,
  // exported for unit tests (the ClamAV client, the identity it records, and the
  // object-store path, which is the shape production runs and the local test
  // server does not):
  _openBytes: openBytes, _probeEngine: () => clamav.probe(), _identityFor: identityFor,
  _virusLabel: virusLabel, _detailFor: detailFor,
  _scanStream: scanStream, _setEngineForTest: setEngineForTest,
  // exported for tests: the dead-replica claim release and the claim query, so a
  // test can prove recovery without waiting out a twelve-minute lease.
  _releaseDeadClaims: releaseDeadClaims, _claimRow: claimRow, _podId: podId,
  _ensureTables: ensureTables,
};
