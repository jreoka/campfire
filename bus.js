// Cross-replica event bus, built on Postgres LISTEN/NOTIFY plus an outbox.
//
// WHY AN OUTBOX INSTEAD OF NOTIFY PAYLOADS
// NOTIFY payloads are capped at ~8000 bytes and several Campfire events
// (story reaction tallies, message fan-outs) can exceed that. So the row IS
// the event and NOTIFY carries only the row id. Subscribers keep a monotonic
// cursor and read every row with `id > cursor`, which makes delivery
// self-healing: a dropped connection, a slow consumer, or a pod that starts
// mid-stream all converge on the same query. NOTIFY is only a wake-up signal,
// never the data path. A cheap interval poll backs it up, so a missed NOTIFY
// costs latency, never correctness.
//
// THE DELIVERY CONTRACT (load-bearing — read before adding a subscriber)
//   Publishers deliver to their OWN sockets. The bus delivers each event to
//   every OTHER replica only. Subscribers must therefore send exclusively to
//   sockets local to this process.
//   This is what keeps single-replica behavior byte-for-byte identical: with
//   one pod the bus writes a row and delivers nothing. It is also what lets
//   the existing synchronous fan-out helpers (broadcastToServer,
//   notifyFriends) stay synchronous — they deliver locally as they always
//   have, then publish for everyone else.
//
// ORDERING
// Postgres sequences are allocated before commit, so two concurrent publishers
// can commit out of id order and a cursor that has already advanced past a
// lower id would never see it. `drain()` therefore re-scans a short window
// behind the cursor and uses a bounded `seen` set to make that idempotent.
//
// REPLICA REGISTRY
// `bus_replicas` carries a heartbeat per running replica. It answers the one
// question a starting replica cannot answer alone: "am I the only one?"
// One-shot boot actions that clear cluster-wide state (the stale
// playing_game / streaming_game sweep) are only safe on a LONE replica — on a
// rolling update they would wipe live state that a peer is still serving.
//
// ENV
//   BUS=0               disable entirely (single-replica debugging)
//   BUS_RETAIN_MS       event retention before the leader sweeps (default 10 min)
//   BUS_POLL_MS         fallback poll interval (default 1000)
//   BUS_HEARTBEAT_MS    replica heartbeat interval (default 10000)
//   POD_NAME            replica identity for `origin` (falls back to hostname)
const os = require('node:os');
const crypto = require('node:crypto');
const db = require('./db');

const ENABLED = process.env.BUS !== '0';
const CHANNEL = 'campfire_bus';
const RETAIN_MS = Math.max(60000, parseInt(process.env.BUS_RETAIN_MS || '600000', 10) || 600000);
const POLL_MS = Math.max(200, parseInt(process.env.BUS_POLL_MS || '1000', 10) || 1000);
const HEARTBEAT_MS = Math.max(2000, parseInt(process.env.BUS_HEARTBEAT_MS || '10000', 10) || 10000);
const PEER_STALE_MS = Math.max(HEARTBEAT_MS * 3, 30000);
const BATCH = 200;
const OVERLAP = 200;   // how far behind the cursor to re-scan for late commits
const SEEN_MAX = 2000; // bounded dedupe ring

// Stable per-process identity: tags every event with its origin (so the
// publishing replica can skip its own) and lets /healthz report which replica
// answered.
const POD_ID = (process.env.POD_NAME || process.env.HOSTNAME || os.hostname() || 'pod')
  + ':' + crypto.randomBytes(3).toString('hex');
const STARTED_AT = Date.now();

const handlers = new Map(); // topic -> Set<handler>
const seen = new Set();
const seenOrder = [];
let cursor = 0;
let listenClient = null;
let reconnectTimer = null;
let pollTimer = null;
let sweepTimer = null;
let heartbeatTimer = null;
let draining = false;
let drainAgain = false;
let started = false;
let stopping = false;
let published = 0;
let dispatched = 0;
let lastPeers = [];

function subscribe(topic, fn) {
  if (!handlers.has(topic)) handlers.set(topic, new Set());
  handlers.get(topic).add(fn);
  return () => { const s = handlers.get(topic); if (s) s.delete(fn); };
}

async function ensureTable() {
  // Serialized against every other replica's DDL (and initDb) by the migrate
  // lock: concurrent CREATE TABLE IF NOT EXISTS on a cold cluster can still
  // race on pg_class and fail one of the callers.
  await db.withLockWait(db.LOCKS.migrate, async () => {
    try {
      await db.exec(`CREATE TABLE IF NOT EXISTS bus_events (
        id BIGSERIAL PRIMARY KEY,
        topic TEXT NOT NULL,
        payload JSONB NOT NULL,
        origin TEXT NOT NULL,
        created_at BIGINT NOT NULL
      )`);
    } catch (e) {
      const ok = await db.prepare("SELECT to_regclass('public.bus_events') AS t").get();
      if (!ok || !ok.t) throw e; // not a race — surface the real failure
    }
    await db.exec('CREATE INDEX IF NOT EXISTS idx_bus_events_created ON bus_events(created_at)');
    await db.exec(`CREATE TABLE IF NOT EXISTS bus_replicas (
      pod_id TEXT PRIMARY KEY,
      started_at BIGINT NOT NULL,
      last_seen BIGINT NOT NULL
    )`);
    await db.exec('CREATE INDEX IF NOT EXISTS idx_bus_replicas_seen ON bus_replicas(last_seen)');
  });
}

// Publish one event. Deliberately routed through db.prepare so that when the
// caller is inside db.transaction() this joins that transaction — Postgres
// queues NOTIFY until commit, so other replicas only hear about a write that
// actually committed.
async function publish(topic, payload) {
  if (!ENABLED || !started) return 0;
  const row = await db.prepare(
    `WITH ins AS (
       INSERT INTO bus_events (topic, payload, origin, created_at)
       VALUES (?, ?::jsonb, ?, ?)
       RETURNING id
     )
     SELECT id, pg_notify(?, id::text) FROM ins`
  ).get(topic, JSON.stringify(payload === undefined ? null : payload), POD_ID, Date.now(), CHANNEL);
  published++;
  return row ? Number(row.id) : 0;
}

function markSeen(id) {
  if (seen.has(id)) return false;
  seen.add(id);
  seenOrder.push(id);
  if (seenOrder.length > SEEN_MAX) seen.delete(seenOrder.shift());
  return true;
}

async function dispatch(ev) {
  const id = Number(ev.id);
  if (!markSeen(id)) return;
  if (ev.origin === POD_ID) return; // already delivered locally by the publisher
  const set = handlers.get(ev.topic);
  if (!set || !set.size) return;
  for (const fn of set) {
    try { await fn(ev.payload, ev.topic); dispatched++; }
    catch (e) { console.error(`[bus] handler for ${ev.topic} failed:`, (e && e.message) || e); }
  }
}

async function drain() {
  if (draining || stopping || !started) return;
  draining = true;
  try {
    let maxId = cursor;
    for (;;) {
      const rows = await db.prepare(
        'SELECT id, topic, payload, origin FROM bus_events WHERE id > ? ORDER BY id LIMIT ?'
      ).all(maxId, BATCH);
      for (const ev of rows) {
        const id = Number(ev.id);
        if (id > maxId) maxId = id;
        await dispatch(ev);
      }
      if (rows.length < BATCH) break;
    }
    cursor = maxId;
    // Rescue pass: catch a lower id that committed after we advanced past it.
    const back = await db.prepare(
      'SELECT id, topic, payload, origin FROM bus_events WHERE id <= ? AND id > ? ORDER BY id'
    ).all(cursor, Math.max(0, cursor - OVERLAP));
    for (const ev of back) await dispatch(ev);
  } finally {
    draining = false;
    if (drainAgain) { drainAgain = false; scheduleDrain(); }
  }
}

function scheduleDrain() {
  if (draining) { drainAgain = true; return; }
  drain().catch((e) => console.error('[bus] drain failed:', (e && e.message) || e));
}

// One dedicated connection is held open for the life of the process to hold
// LISTEN. It is not returned to the pool while listening, so a pool of size N
// effectively offers N-1 connections to the rest of the app.
async function connectListener() {
  if (stopping) return;
  let client;
  try {
    client = await db.rawPool().connect();
  } catch (e) {
    console.error('[bus] listener connect failed:', (e && e.message) || e);
    scheduleReconnect();
    return;
  }
  listenClient = client;
  let dead = false;
  const onDead = (why) => {
    if (dead) return;
    dead = true;
    if (listenClient === client) listenClient = null;
    console.error(`[bus] listener ${why} — falling back to polling`);
    try { client.release(); } catch {}
    scheduleReconnect();
  };
  client.on('notification', () => scheduleDrain());
  client.on('error', (e) => onDead(`error: ${(e && e.message) || e}`));
  client.on('end', () => onDead('closed'));
  try {
    await client.query(`LISTEN ${CHANNEL}`);
  } catch (e) {
    console.error('[bus] LISTEN failed:', (e && e.message) || e);
    onDead('failed to LISTEN');
  }
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectListener().catch((e) => console.error('[bus] listener reconnect failed:', (e && e.message) || e));
  }, 1000);
  try { reconnectTimer.unref(); } catch {}
}

// Announce this replica and drop rows for replicas that stopped heartbeating
// (a crashed pod must not look alive forever, or every later boot would think
// it has a peer and skip its one-shot reconciliation).
async function heartbeat() {
  const now = Date.now();
  try {
    await db.prepare(
      `INSERT INTO bus_replicas (pod_id, started_at, last_seen) VALUES (?, ?, ?)
       ON CONFLICT (pod_id) DO UPDATE SET last_seen = EXCLUDED.last_seen`
    ).run(POD_ID, STARTED_AT, now);
    await db.prepare('DELETE FROM bus_replicas WHERE last_seen < ?').run(now - PEER_STALE_MS);
  } catch (e) {
    console.error('[bus] heartbeat failed:', (e && e.message) || e);
  }
}

// Other replicas seen inside the staleness window. A lone replica may clear
// cluster-wide state on boot; one starting beside a live peer must not.
async function liveReplicas() {
  try {
    const rows = await db.prepare(
      'SELECT pod_id, started_at, last_seen FROM bus_replicas WHERE pod_id <> ? AND last_seen >= ?'
    ).all(POD_ID, Date.now() - PEER_STALE_MS);
    lastPeers = rows;
    return rows;
  } catch { return []; }
}

// Retire events every live cursor has passed. Leader-only: the lock means one
// replica does the delete and the others skip it.
async function sweep() {
  const cutoff = Date.now() - RETAIN_MS;
  try {
    await db.withLock(db.LOCKS.busSweep, async () => {
      await db.prepare('DELETE FROM bus_events WHERE created_at < ?').run(cutoff);
    });
  } catch (e) {
    console.error('[bus] sweep failed:', (e && e.message) || e);
  }
}

async function start() {
  if (!ENABLED) {
    console.log('[bus] disabled (BUS=0) — single-replica mode, no cross-replica delivery');
    return;
  }
  await ensureTable();
  const max = await db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM bus_events').get();
  cursor = Number(max && max.m) || 0;
  // Seed the rescue window as seen: a fresh process must not replay history it
  // never had sockets for.
  if (cursor > 0) {
    const seed = await db.prepare(
      'SELECT id FROM bus_events WHERE id <= ? AND id > ?'
    ).all(cursor, Math.max(0, cursor - OVERLAP));
    for (const r of seed) markSeen(Number(r.id));
  }
  started = true;
  await connectListener();
  await heartbeat();
  heartbeatTimer = setInterval(() => heartbeat(), HEARTBEAT_MS);
  try { heartbeatTimer.unref(); } catch {}
  pollTimer = setInterval(() => scheduleDrain(), POLL_MS);
  try { pollTimer.unref(); } catch {}
  sweepTimer = setInterval(() => sweep(), Math.max(RETAIN_MS, 60000));
  try { sweepTimer.unref(); } catch {}
  console.log(`[bus] listening as ${POD_ID} (cursor=${cursor}, poll=${POLL_MS}ms)`);
}

async function stop() {
  stopping = true;
  started = false;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  // Retire our own row so the next boot of a replacement replica does not see
  // a ghost peer and skip its one-shot reconciliation.
  try { await db.prepare('DELETE FROM bus_replicas WHERE pod_id = ?').run(POD_ID); } catch {}
  const c = listenClient;
  listenClient = null;
  if (c) {
    try { await c.query(`UNLISTEN ${CHANNEL}`); } catch {}
    try { c.release(); } catch {}
  }
}

// Wait for any in-flight drain to settle. Used by tests and shutdown.
async function flush() {
  for (let i = 0; i < 50 && draining; i++) await new Promise((r) => setTimeout(r, 20));
}

function stats() {
  return {
    enabled: ENABLED, started, pod: POD_ID, cursor, published, dispatched,
    listeners: listenClient ? 1 : 0,
    peers: lastPeers.map((p) => p.pod_id),
    startedAt: STARTED_AT,
  };
}

module.exports = {
  POD_ID, CHANNEL, PEER_STALE_MS,
  start, stop, publish, subscribe, flush, stats, liveReplicas,
  isShared: () => ENABLED && started && !!listenClient,
};
