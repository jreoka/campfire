// End-to-end check of the derived chat-image previews (thumbs/).
//
// The feature: a chat image renders a derived 640px WebP preview
// (/uploads/thumbs/files/<name>.<ext>.webp) instead of the full upload, because
// one photo is 10-30x its own preview and a channel's backlog is mostly
// pictures — the slow-link open. media-compress.js mints a preview on the first
// request behind the shared encode lock (never making the request wait for the
// whole encode), server.js serves it like any other upload, storage-sweep.js
// must never treat it as an orphan, and deleting the message takes it along.
//
// This boots a real server against a throwaway database in the shape the
// cluster runs (VIRUS_SCAN=0, compression on) and asserts all of that against
// real bytes, real ffmpeg and a real bucket tree:
//   - a preview is minted on demand, is a real WebP, is far smaller than the
//     upload, and is served from disk afterwards;
//   - anything that is not a derived chat-image preview is refused (a missing
//     source, a non-image, and — importantly — a viewonce/ key, which is gated
//     behind a ticket and must have no side door);
//   - a source smaller than the preview box is never upscaled;
//   - the orphan sweep's listing does not include previews (a planted
//     unreferenced file is a victim, the preview is not);
//   - deleting the message removes the upload AND its preview.
//
// Requirements: ffmpeg on PATH and Postgres reachable (docker compose up -d db).
// Skips (exit 0) with a message when either is missing.
//
// Usage: node scripts/test-image-previews-e2e.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_thumbs_e2e';
const PORT = parseInt(process.env.TEST_PORT || '3421', 10);

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
  const res = await fetch(`http://127.0.0.1:${PORT}/api/upload`, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd });
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
    ws.on('open', () => resolve({ events, send: (o) => ws.send(JSON.stringify(o)), close: () => { try { ws.close(); } catch {} } }));
  });
}

async function waitFor(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
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

const ffmpeg = (args) => { const r = spawnSync('ffmpeg', args, { stdio: 'ignore' }); return r && r.status === 0; };
const probeSize = (p) => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', p], { encoding: 'utf8' });
  const m = /^(\d+),(\d+)/.exec(String((r && r.stdout) || '').trim());
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
};

async function main() {
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (!probe || probe.status !== 0) return skip('ffmpeg not found on PATH');

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-thumbs-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  const big = path.join(tmp, 'photo.jpg');
  const tiny = path.join(tmp, 'tiny.png');
  if (!ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'nullsrc=s=2400x1600,geq=random(1)*255:128:128', '-frames:v', '1', '-q:v', '1', big])
    || !ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x334155:s=64x64', '-frames:v', '1', tiny])) {
    return skip('ffmpeg could not generate test media');
  }

  let child = null, db = null, conn = null;
  let serverLog = '';
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
        JWT_SECRET: 'test-image-previews-secret',
        UPLOAD_DIR: uploads,
        // The no-scanner shape: VIRUS_SCAN off, compression on, so the upload is
        // gated only until the compressor publishes it.
        VIRUS_SCAN: '0',
        MEDIA_COMPRESS: '1',
        MEDIA_COMPRESS_ACTIVE_MS: '250',
        MEDIA_COMPRESS_EVERY_MS: '5000',
        // The bucket scan would queue the preview backfill; leave it out of this
        // run so the on-request path is what is measured.
        MEDIA_BUCKET_SWEEP: '0',
        // Grace 0 so a DRY sweep lists everything eligible (nothing is deleted).
        ORPHAN_SWEEP: '1',
        ORPHAN_GRACE_H: '0',
        UNFURL: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    const fail = (msg) => { throw new Error(msg + '\n--- server log ---\n' + serverLog.slice(-4000)); };

    if (!(await waitForHttp('/api/config', 30000))) return fail('server did not come up');

    const reg = await api('POST', '/api/register', { username: 'thumbtest', password: 'test1234', displayName: 'Thumb Test' });
    const token = reg.token;
    const srv = await api('POST', '/api/servers', { name: 'Previews' }, token);
    const channelId = srv.server.channels.find((c) => c.type === 'text').id;
    db = new Client({ ...pg, database: TEST_DB });
    await db.connect();

    // Upload + post + wait for the compression slot to publish the final bytes.
    conn = await connectWs(token);
    await waitFor(() => conn.events.some((e) => e.t === 'hello'), 5000);
    async function postImage(filePath, name, mime) {
      const up = await uploadFile(filePath, name, mime, token);
      conn.send({ t: 'message', serverId: srv.server.id, channelId, content: '', attachments: [{ url: up.url, name: up.name, mime: up.mime, size: up.size, kind: up.kind }] });
      const created = await waitFor(() => conn.events.find((e) => e.t === 'message-new' && e.message.attachments[0].url === up.url), 8000);
      if (!created) fail('message-new never arrived for ' + name);
      const mid = created.message.id;
      const done = await waitFor(() => {
        const u = conn.events.filter((e) => e.t === 'message-updated' && e.message.id === mid).pop();
        return u && u.message.attachments[0] && u.message.attachments[0].scan === 'clean' ? u.message : null;
      }, 60000);
      if (!done) fail('the upload never settled for ' + name);
      return { mid, att: done.attachments[0], up };
    }

    console.log('\n[1] a preview is minted on the first request and served from then on');
    const a = await postImage(big, 'photo.jpg', 'image/jpeg');
    const aKey = a.att.url.split('?')[0].replace('/uploads/', '');
    const aThumbKey = 'thumbs/' + aKey + '.webp';
    const aThumbUrl = '/uploads/' + aThumbKey;
    const r1 = await fetch(`http://127.0.0.1:${PORT}${aThumbUrl}`);
    const b1 = Buffer.from(await r1.arrayBuffer());
    check('the minted preview answers 200', r1.status === 200, r1.status);
    check('as an image/webp', String(r1.headers.get('content-type') || '').includes('image/webp'), r1.headers.get('content-type'));
    check('with real WebP bytes', b1.length > 12 && b1.toString('latin1', 0, 4) === 'RIFF' && b1.toString('latin1', 8, 12) === 'WEBP', b1.slice(0, 12).toString('latin1'));
    const srcSize = fs.statSync(path.join(uploads, aKey)).size;
    check('and it is a small fraction of the upload', b1.length < srcSize * 0.25, { preview: b1.length, upload: srcSize });
    check('it is on disk under the derived key', fs.existsSync(path.join(uploads, aThumbKey)), aThumbKey);
    const r2 = await fetch(`http://127.0.0.1:${PORT}${aThumbUrl}`);
    const b2 = Buffer.from(await r2.arrayBuffer());
    check('a second request is served from the stored object', r2.status === 200 && b2.equals(b1));
    check('the upload itself is untouched', fs.statSync(path.join(uploads, aKey)).size === srcSize);

    console.log('\n[2] only a real derived chat-image preview exists');
    const miss = await fetch(`http://127.0.0.1:${PORT}/uploads/thumbs/files/does-not-exist.jpg.webp`);
    check('a preview of a missing upload 404s', miss.status === 404, miss.status);
    check('and is not cached (the next open must be able to get the real one)', /no-store/.test(String(miss.headers.get('cache-control') || '')), miss.headers.get('cache-control'));
    // The gate that matters: view-once bytes are locked behind a ticket, so a
    // preview of one must not be constructible.
    const voTry = await fetch(`http://127.0.0.1:${PORT}/uploads/thumbs/viewonce/secret.jpg.webp`);
    check('a viewonce/ key has no preview side door', voTry.status === 404, voTry.status);
    const mp4Try = await fetch(`http://127.0.0.1:${PORT}/uploads/thumbs/files/clip.mp4.webp`);
    check('nor does a video', mp4Try.status === 404, mp4Try.status);
    const pngTry = await fetch(`http://127.0.0.1:${PORT}/uploads/thumbs/files/notes.txt.webp`);
    check('nor a non-image', pngTry.status === 404, pngTry.status);

    console.log('\n[3] a source smaller than the preview box is never upscaled');
    const t = await postImage(tiny, 'tiny.png', 'image/png');
    const tKey = t.att.url.split('?')[0].replace('/uploads/', '');
    const tThumbUrl = `/uploads/thumbs/${tKey}.webp`;
    const r3 = await fetch(`http://127.0.0.1:${PORT}${tThumbUrl}`);
    check('the small source still gets a preview', r3.status === 200, r3.status);
    const tOut = path.join(tmp, 'probe-thumb.webp');
    fs.writeFileSync(tOut, Buffer.from(await r3.arrayBuffer()));
    const dim = probeSize(tOut);
    check('and it is not blown up past the source', !!dim && dim.w <= 64 && dim.h <= 64, dim);
    check('and it is no bigger than the source', fs.statSync(tOut).size <= fs.statSync(path.join(uploads, tKey)).size, { preview: fs.statSync(tOut).size, upload: fs.statSync(path.join(uploads, tKey)).size });

    console.log('\n[4] the orphan sweep never lists a preview');
    const orphanKey = 'files/planted-orphan-9f3a.jpg';
    fs.copyFileSync(big, path.join(uploads, orphanKey));
    // The sweep routes are site-admin only; this account is the whole instance.
    await db.query('UPDATE users SET is_admin = 1 WHERE id = $1', [reg.user.id]);
    const dry = await api('POST', '/api/admin/sweep/run?dry=1', undefined, token);
    const victims = (dry.result && dry.result.victims) || [];
    check('the dry sweep reports the planted unreferenced file', victims.some((v) => v.key === orphanKey), victims.map((v) => v.key));
    check('and does not report any derived preview', !victims.some((v) => String(v.key).startsWith('thumbs/')), victims.filter((v) => String(v.key).startsWith('thumbs/')).map((v) => v.key));
    await db.query('UPDATE users SET is_admin = 0 WHERE id = $1', [reg.user.id]);

    console.log('\n[5] deleting the message takes the upload and its preview');
    await api('DELETE', '/api/messages/' + a.mid, undefined, token);
    const gone = await waitFor(() => !fs.existsSync(path.join(uploads, aKey)) && !fs.existsSync(path.join(uploads, aThumbKey)), 10000);
    check('both objects are gone', gone, { upload: fs.existsSync(path.join(uploads, aKey)), preview: fs.existsSync(path.join(uploads, aThumbKey)) });

    await db.end();
    db = null;
  } catch (e) {
    console.log('--- server log tail ---\n' + serverLog.split('\n').slice(-40).join('\n'));
    throw e;
  } finally {
    try { conn && conn.close(); } catch {}
    try { if (db) await db.end(); } catch {}
    try { if (child) child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    try {
      const drop = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
      await drop.connect();
      await drop.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      await drop.end();
    } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
