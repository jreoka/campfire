// Names that are not ASCII have to survive the whole way from a multipart
// upload to the line a reader sees — in chat, in DMs, and in the rows that were
// written before the parser was told which charset it was looking at.
//
// THE BUG THIS PINS DOWN: multer/busboy decoded a multipart filename with its
// own default charset, and the WHATWG label it uses for that ("latin1") means
// WINDOWS-1252, not ISO-8859-1 — while every browser serialises the name as the
// name's UTF-8 bytes, because the HTML spec requires it. So "中文" was stored as
// "ä¸æ–‡" and rendered as a ladder of accents: the reported symptom was a video
// titled "Jax - à®…à®°à®¾à®ªà¯à¯à®ªà¯ [2099826296784293888].mp4".
//
// Phase 1 (live path): upload and post names in Chinese, Japanese, Korean,
// Arabic, Devanagari, Cyrillic and emoji, and assert the EXACT round trip
// through /api/upload -> the message a client reads back -> the row in the
// database, in a channel and in a DM.
// Phase 2 (the rows already written): rewrite those rows to the old mangled
// spelling, clear the one-shot marker, restart the server, and assert the boot
// repair recovers every one of them — while leaving an honest Latin-1 name
// ("Café.txt", which the old parser stored correctly and the repair must not
// "fix") and a plain ASCII name exactly as they were. The same pass covers the
// compressor's job log (the Admin → Media list the report came from), and the
// admin report card repairs the name it prints from its snapshot without
// rewriting the snapshot itself.
//
// Requirements: Postgres reachable (docker compose up -d db). Skips (exit 0)
// with a message when it is not.
//
// Usage: node scripts/test-upload-names.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_names_test';
const PORT = parseInt(process.env.TEST_PORT || '3431', 10);
const REPAIR_MARKER = 'attachment_names_repaired';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function skip(why) {
  console.log('[test] skipped: ' + why);
  process.exit(0);
}

// Exactly what the old parser did to the bytes: read the name's UTF-8 bytes as
// windows-1252. Written out here rather than imported from filename-repair.js so
// the assertion cannot agree with the code under test by construction.
const mangle = (s) => new TextDecoder('latin1').decode(Buffer.from(s, 'utf8'));

const NAMES = [
  '中文-日本語-한국어-العربية-हिन्दी-🎬 [2099826296784293888].mp4',
  '日本語のタイトル.mp4',
  '한국어 제목.mp4',
  'عنوان عربي.mp4',
  'Привет-мир.txt',
  'Café-résumé.txt', // honest Latin-1: the old parser got this one right
  'report-2024.txt',
];
const DM_NAME = NAMES[0];

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

// The multipart body a browser builds: the filename rides in the part header as
// the name's UTF-8 bytes (FormData/Blob does exactly this).
async function upload(name, token) {
  const fd = new FormData();
  fd.append('file', new Blob(['hello from a non-ASCII test\r\n'], { type: 'text/plain' }), name);
  const res = await fetch(`http://127.0.0.1:${PORT}/api/upload`, {
    method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('upload -> ' + res.status + ' ' + JSON.stringify(j));
  return j;
}

function connectWs(token) {
  return new Promise((resolve, reject) => {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
    ws.on('error', reject);
    ws.on('message', (raw) => { try { events.push(JSON.parse(raw.toString())); } catch {} });
    ws.on('open', () => resolve({
      events,
      send: (o) => ws.send(JSON.stringify(o)),
      close: () => { try { ws.close(); } catch {} },
    }));
  });
}

async function waitFor(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(120);
  }
}

async function waitForHttp(p, ms) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); if (r.ok) return true; } catch {}
    if (Date.now() - t0 > ms) return false;
    await sleep(200);
  }
}

// Did the name come back exactly as it went in? The detail line prints both
// spellings so a failure is readable (and shows the mangling when it happens).
function sameName(label, got, want) {
  check(label, got === want, got === want ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-names-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });

  let child = null, serverLog = '';
  const baseEnv = {
    ...process.env,
    PORT: String(PORT),
    PGHOST: pg.host, PGPORT: String(pg.port), PGUSER: pg.user, PGPASSWORD: pg.password, PGDATABASE: TEST_DB,
    JWT_SECRET: 'test-upload-names-secret',
    UPLOAD_DIR: uploads,
    VIRUS_SCAN: '0',        // no scanner: the name is the subject, not the bytes
    // Compression stays ON: the third copy of a stored name is the compressor's
    // own job log (Admin → Media prints it), and that table only exists when the
    // worker has created it. Nothing here is compressible — the uploads are text.
    UNFURL: '0',
  };
  function startServer() {
    serverLog = '';
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    return child;
  }
  function stopServer() {
    return new Promise((resolve) => {
      const c = child;
      if (!c) return resolve();
      child = null;
      c.once('exit', () => resolve());
      try { c.kill(); } catch { return resolve(); }
      setTimeout(resolve, 15000);
    });
  }

  let db = null;
  const fail = (msg) => { throw new Error(msg + '\n--- server log ---\n' + serverLog.slice(-4000)); };

  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();

    startServer();
    if (!(await waitForHttp('/api/config', 30000))) return fail('server did not come up');
    db = new Client({ ...pg, database: TEST_DB });
    db.on('error', () => {});
    await db.connect();

    const a = await api('POST', '/api/register', { username: 'namecheck', password: 'test1234', displayName: 'Name Check' });
    const b = await api('POST', '/api/register', { username: 'namecheck2', password: 'test1234', displayName: 'Name Check 2' });
    const token = a.token;
    const srv = await api('POST', '/api/servers', { name: 'Names' }, token);
    const channelId = srv.server.channels.find((c) => c.type === 'text').id;
    const thread = (await api('POST', '/api/dms', { userId: b.user.id }, token)).thread;

    // ---- phase 1: the live path ----
    console.log('[test] uploading and posting non-ASCII names');
    const conn = await connectWs(token);
    await waitFor(() => conn.events.some((e) => e.t === 'hello'), 5000);

    const posted = [];
    for (const name of NAMES) {
      const up = await upload(name, token);
      sameName('upload returns the name byte-for-byte: ' + name.slice(0, 28), up.name, name);
      conn.events.length = 0;
      conn.send({
        t: 'message', serverId: srv.server.id, channelId, content: '',
        attachments: [{ url: up.url, name: up.name, mime: up.mime, size: up.size, kind: up.kind }],
      });
      const created = await waitFor(() => conn.events.find((e) => e.t === 'message-new'), 8000);
      if (!created) return fail('no message-new for ' + name);
      sameName('broadcast carries the name: ' + name.slice(0, 28), created.message.attachments[0]?.name, name);
      posted.push({ name, mid: created.message.id, aid: created.message.attachments[0]?.id });
    }

    // The text itself, in the same scripts: a message body must round-trip too,
    // or the chat is only half-fixed.
    const TEXT = '中文 日本語 한국어 العربية हिन्दी Привет 🎉 — مركّب';
    conn.events.length = 0;
    conn.send({ t: 'message', serverId: srv.server.id, channelId, content: TEXT });
    const textMsg = await waitFor(() => conn.events.find((e) => e.t === 'message-new'), 8000);
    if (!textMsg) return fail('no message-new for the multi-script body');
    sameName('broadcast carries the message text', textMsg.message.content, TEXT);

    // DM path (its own table, its own insert).
    conn.events.length = 0;
    const dmUp = await upload(DM_NAME, token);
    conn.send({
      t: 'dm', threadId: thread.id, content: '',
      attachments: [{ url: dmUp.url, name: dmUp.name, mime: dmUp.mime, size: dmUp.size, kind: dmUp.kind }],
    });
    const dmNew = await waitFor(() => conn.events.find((e) => e.t === 'dm-new'), 8000);
    if (!dmNew) return fail('no dm-new for the DM attachment');
    sameName('DM broadcast carries the name', dmNew.message.attachments[0]?.name, DM_NAME);

    // Read back through the API: what the history renderer gets, i.e. the DB row
    // rather than the frame that happened to be in flight.
    const history = (await api('GET', `/api/servers/${srv.server.id}/channels/${channelId}/messages`, undefined, token)).messages;
    const byId = new Map(history.map((m) => [m.id, m]));
    for (const p of posted) sameName('history row carries the name: ' + p.name.slice(0, 28), byId.get(p.mid)?.attachments[0]?.name, p.name);
    sameName('history row carries the multi-script text', [...byId.values()].find((m) => m.content === TEXT)?.content, TEXT);
    const dmHistory = (await api('GET', `/api/dms/${thread.id}/messages`, undefined, token)).messages;
    sameName('DM history row carries the name', dmHistory.find((m) => m.id === dmNew.message.id)?.attachments[0]?.name, DM_NAME);

    // ---- phase 2: the rows written before the fix ----
    // Rewrite them into the old mangled spelling, add one honest Latin-1 name the
    // repair must leave alone, and clear the one-shot marker so the boot repair
    // runs again on the next start.
    console.log('[test] rewriting rows to the old mangled spelling and restarting');
    const clients = new Client({ ...pg, database: TEST_DB });
    clients.on('error', () => {});
    await clients.connect();
    let mangled = 0;
    for (const p of posted) {
      const row = (await clients.query('SELECT filename FROM attachments WHERE id = $1', [p.aid])).rows[0];
      if (!row) return fail('no attachment row for ' + p.name);
      const bad = mangle(row.filename);
      if (bad !== row.filename) mangled++;
      await clients.query('UPDATE attachments SET filename = $1 WHERE id = $2', [bad, p.aid]);
    }
    // An honest cp1252 name — exactly what the old parser stored when a client
    // really did send Latin-1 bytes, and indistinguishable from a correct UTF-8
    // row. The repair must not touch it.
    const honest = 'Café-notes.txt';
    const honestId = 'att-honest-latin1';
    await clients.query(
      'INSERT INTO attachments (id,message_id,url,filename,mime,size,kind,spoiler,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [honestId, posted[0].mid, '/uploads/files/honest-latin1.txt', honest, 'text/plain', 12, 'file', 0, Date.now()]
    );
    // The compressor's job log — the row Admin → Media prints, which is where the
    // reported screenshot came from ("video · 36.4 MB → 2.4 MB (-93%)") — and a
    // report snapshot, taken while the rows still read as cp1252 (the report card
    // prints those names, but the record itself must not be rewritten).
    let logTable = false;
    for (let i = 0; i < 40 && !logTable; i++) {
      logTable = (await clients.query("SELECT to_regclass('media_compress_log') AS t")).rows[0].t !== null;
      if (!logTable) await sleep(250);
    }
    check('the compressor created its job log (the Admin → Media list)', logTable);
    await clients.query(
      `INSERT INTO media_compress_log (id,tbl,url,filename,kind,pipeline,result,orig_size,new_size,error,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      ['job-mojibake', 'attachments', dmUp.url, mangle(DM_NAME), 'video', 'mp4', 'compressed', 38170419, 2512345, '', Date.now()]
    );
    await clients.query('UPDATE users SET is_admin = 1 WHERE username = $1', ['namecheck']);
    // The DM row too — its own table, and the report below snapshots it while it
    // still reads as cp1252.
    await clients.query('UPDATE dm_attachments SET filename = $1 WHERE message_id = $2', [mangle(DM_NAME), dmNew.message.id]);
    const filed = await api('POST', '/api/reports', { messageId: dmNew.message.id, kind: 'dm', reason: 'spam' }, b.token);
    check('a report captured the DM attachment while it read as cp1252', !!filed.id);
    await clients.query('DELETE FROM meta WHERE key = $1', [REPAIR_MARKER]);
    await clients.end();
    check('phase 2 mangled the non-ASCII rows', mangled === NAMES.filter((n) => mangle(n) !== n).length, 'mangled=' + mangled);

    await stopServer();
    startServer();
    if (!(await waitForHttp('/api/config', 30000))) return fail('server did not come back up after the rewrite');
    check('boot log reports the repair', /repaired \d+ mojibake attachment name/.test(serverLog), serverLog.match(/.*mojibake.*/)?.[0] || 'no repair line');

    const after = (await api('GET', `/api/servers/${srv.server.id}/channels/${channelId}/messages`, undefined, token)).messages;
    const afterById = new Map(after.map((m) => [m.id, m]));
    for (const p of posted) sameName('repaired row reads back as uploaded: ' + p.name.slice(0, 28), afterById.get(p.mid)?.attachments[0]?.name, p.name);
    const honestBack = afterById.get(posted[0].mid)?.attachments.find((x) => x.id === honestId)?.name;
    sameName('an honest Latin-1 name is not "repaired"', honestBack, honest);
    const dmAfter = (await api('GET', `/api/dms/${thread.id}/messages`, undefined, token)).messages;
    sameName('repaired DM row reads back as uploaded', dmAfter.find((m) => m.id === dmNew.message.id)?.attachments[0]?.name, DM_NAME);

    // The compressor's log is what Admin → Media prints, so it is repaired too.
    const jobs = (await api('GET', '/api/admin/media/recent?limit=50', undefined, token)).jobs || [];
    const job = jobs.find((j) => j.url === dmUp.url);
    sameName('the Media list prints the repaired name', job && job.filename, DM_NAME);

    // The report card reads the snapshot: repaired for display, record untouched.
    const queue = (await api('GET', '/api/admin/reports?status=open', undefined, token)).reports || [];
    const rep = queue.find((r) => r.id === filed.id);
    sameName('the report card prints the repaired name', rep && rep.snapshot?.message?.media?.[0]?.name, DM_NAME);

    const db2 = new Client({ ...pg, database: TEST_DB });
    db2.on('error', () => {});
    await db2.connect();
    const markerRow = (await db2.query('SELECT value FROM meta WHERE key = $1', [REPAIR_MARKER])).rows[0];
    check('the repair is one-shot (marker written)', !!markerRow, 'marker missing');
    const mangledSql = "filename LIKE '%Ã%' OR filename LIKE '%ä¸%'";
    const leftA = (await db2.query(`SELECT count(*)::int AS n FROM attachments WHERE ${mangledSql}`)).rows[0];
    const leftD = (await db2.query(`SELECT count(*)::int AS n FROM dm_attachments WHERE ${mangledSql}`)).rows[0];
    const leftL = (await db2.query(`SELECT count(*)::int AS n FROM media_compress_log WHERE ${mangledSql}`)).rows[0];
    check('no mangled attachment name survives', leftA.n === 0, 'still mangled: ' + leftA.n);
    check('no mangled DM name survives', leftD.n === 0, 'still mangled: ' + leftD.n);
    check('no mangled Media-list name survives', leftL.n === 0, 'still mangled: ' + leftL.n);
    // The report's own record keeps the spelling it was filed with: only the card
    // is repaired, never the moderation record.
    const rawSnap = (await db2.query('SELECT snapshot FROM message_reports WHERE id = $1', [filed.id])).rows[0]?.snapshot || '';
    check('the report snapshot itself is left as filed', rawSnap.includes(mangle(DM_NAME)), 'snapshot was rewritten');
    await db2.end();
    conn.close();
  } finally {
    try { if (db) await db.end(); } catch {}
    await stopServer();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n[test] ${passed} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

main().catch((e) => { console.error('[test] error:', (e && e.stack) || e); process.exit(1); });
