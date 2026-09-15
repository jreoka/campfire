// ClamAV: the malware engine, spoken to over the network.
//
// Why a CONTAINER again, after a scanner that was one binary inside the app
// image: ClamAV is a signature engine, and a signature engine is only worth
// anything if the signatures are current — that is a database to hold, a
// downloader on a schedule, and a daemon to keep it loaded in RAM. None of that
// belongs in the app's process or its image, so it lives in a sibling
// `clamav/clamav` container and this app talks to `clamd` over TCP.
//
// The protocol is small enough to speak directly, and doing so keeps the app
// free of any ClamAV client dependency:
//
//   VERSION\0                     -> "ClamAV 1.4.6/28122/Sun Sep 13 ..."
//   PING\0                        -> "PONG"
//   INSTREAM\0 then the file      -> "stream: OK" / "stream: <Signature> FOUND"
//
// INSTREAM is the command that matters, and the reason nothing needs a shared
// volume: the file is STREAMED into the daemon, in length-prefixed chunks, so a
// 50 MB upload never lands on the app's disk on its way to being judged and the
// daemon — which cannot see the app's filesystem anyway — never has to. Two
// consequences worth stating: `StreamMaxLength` must be raised above the app's
// own upload cap (see the compose file, which sets it to 128M for a 50 MB cap),
// and the daemon's answer is authoritative for the bytes that were streamed.
//
// Failure posture belongs to the CALLER (virus-scan.js decides fail-open policy);
// this module only refuses to lie: a socket that never answered, a daemon that
// said ERROR, or a timeout all throw, and only an explicit "OK"/"FOUND" becomes a
// verdict. Silence must never read as clean.
//
// Env:
//   CLAMAV_HOST        clamd host (default: the compose service name `clamav`)
//   CLAMAV_PORT        clamd TCP port (default 3310)
//   CLAMAV_TIMEOUT_MS  base scan timeout in ms, plus the file's own size
//                      (default 120000, capped at 10 minutes)
//   CLAMAV_VERIFY_EICAR=1  the startup probe also scans the EICAR test string
//                      and refuses a daemon that does not detect it. On by
//                      default in the Docker image (see the Dockerfile), off in
//                      the tests, whose stand-in daemon answers the signatures
//                      it was told to.
'use strict';

const fs = require('fs');
const net = require('net');
const { Readable } = require('stream');

const HOST = process.env.CLAMAV_HOST || 'clamav';
const PORT = parseInt(process.env.CLAMAV_PORT || '3310', 10) || 3310;
const TIMEOUT_BASE_MS = Math.max(1000, parseInt(process.env.CLAMAV_TIMEOUT_MS || '120000', 10) || 120000);
const VERIFY_EICAR = process.env.CLAMAV_VERIFY_EICAR === '1';

// The EICAR anti-virus test string, assembled from fragments so this repository
// never contains it as one contiguous literal (a checkout-time AV scan would
// quarantine the file and take the whole test suite with it).
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!', '$H+H*'].join('');

// How long the daemon may take to answer one command. A scan's own budget is
// sized to the file (see scanTimeoutFor); these bound the small commands.
const TALK_TIMEOUT_MS = 15000;
const CHUNK = 64 * 1024;

const log = (...a) => console.log('[clamav]', ...a);

// Headroom over the daemon's own per-file time: the timeouts below bound the
// SOCKET, not the scan, so they must not fire first on a slow-but-working file.
function scanTimeoutFor(size) {
  return Math.min(600000, TIMEOUT_BASE_MS + (Number(size) || 0));
}

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

// One command per connection, which is the daemon's own model (a reply is not
// tagged with which command it belongs to, so pipelining answers is ambiguous).
function connect(timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: HOST, port: PORT });
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; try { sock.destroy(); } catch {} reject(e); } };
    sock.setTimeout(0);
    sock.once('error', (e) => fail(new Error('clamav_connect:' + String((e && e.code) || (e && e.message) || e))));
    sock.once('connect', () => {
      if (settled) return;
      settled = true;
      sock.setTimeout(timeoutMs || TALK_TIMEOUT_MS, () => {
        try { sock.destroy(); } catch {}
        sock.emit('clamav-timeout');
      });
      resolve(sock);
    });
  });
}

// Read until the daemon's NUL terminator. Replies are small (a signature name,
// a version line), so they are accumulated as a string; INSTREAM's data goes the
// other way entirely.
function readReply(sock) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const done = (fn, v) => { sock.off('data', onData); sock.off('error', onErr); sock.off('clamav-timeout', onTimeout); fn(v); };
    const onData = (d) => {
      buf += d.toString('utf8');
      const i = buf.indexOf('\0');
      if (i >= 0) done(resolve, buf.slice(0, i));
    };
    const onErr = (e) => done(reject, new Error('clamav_io:' + String((e && e.code) || (e && e.message) || e)));
    const onTimeout = () => done(reject, new Error('clamav_timeout'));
    sock.on('data', onData);
    sock.on('error', onErr);
    sock.on('clamav-timeout', onTimeout);
  });
}

// A write that respects the socket's own backpressure: without this a 50 MB
// stream would be queued in this process's memory as fast as the source can
// produce it, which is the whole cost INSTREAM exists to avoid.
function writeBackpressured(sock, buf) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { sock.off('error', onErr); reject(new Error('clamav_io:' + String((e && e.message) || e))); };
    sock.once('error', onErr);
    const go = () => { sock.off('error', onErr); resolve(); };
    if (sock.write(buf)) return go();
    sock.once('drain', go);
  });
}

// What a streamed body turned out to be. The signature name is kept verbatim
// (ClamAV's own signatures, e.g. `Eicar-Signature`, `Win.Trojan.Agent-1234`),
// because it is the only part of the verdict that says anything specific.
function parseScanReply(reply) {
  const text = String(reply || '').trim();
  const found = /^stream:\s*(.+?)\s+FOUND$/i.exec(text);
  if (found) return { clean: false, signature: found[1].slice(0, 120), raw: text.slice(0, 200) };
  if (/^stream:\s*OK$/i.test(text)) return { clean: true, signature: null, raw: text.slice(0, 200) };
  // Everything else is the daemon refusing to answer: "INSTREAM size limit
  // exceeded", "UNKNOWN COMMAND", "ERROR". Not a verdict — it must throw, or a
  // file nobody judged would be published as clean.
  throw new Error('clamav_unreadable:' + text.slice(0, 120));
}

// Scan a readable stream. `size` only sizes the timeout; the bytes are what
// count. The stream is destroyed on every exit path so an abandoned upload
// cannot leave an S3 body or a file descriptor open.
async function scanStream(stream, opts) {
  const size = Number((opts && opts.size) || 0) || 0;
  const timeout = (opts && opts.timeoutMs) || scanTimeoutFor(size);
  const sock = await connect(Math.min(60000, timeout));
  const label = (opts && opts.label) || 'stream';
  try {
    const replyP = readReply(sock);
    await writeBackpressured(sock, Buffer.from('zINSTREAM\0', 'latin1'));
    let sent = 0;
    for await (const piece of stream) {
      const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
      for (let i = 0; i < buf.length; i += CHUNK) {
        const part = buf.subarray(i, Math.min(i + CHUNK, buf.length));
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length, 0);
        await writeBackpressured(sock, len);
        await writeBackpressured(sock, part);
        sent += part.length;
      }
    }
    // The zero-length chunk is what tells the daemon the body is complete; a
    // stream that ends without it leaves the scan hanging until the timeout.
    await writeBackpressured(sock, Buffer.from([0, 0, 0, 0]));
    const reply = await withTimeout(replyP, timeout, 'clamav_timeout');
    const v = parseScanReply(reply);
    log(`scan ${label}: ${v.clean ? 'clean' : 'FOUND ' + v.signature} (${sent} bytes streamed)`);
    return { ...v, bytes: sent, scannedAt: Date.now() };
  } finally {
    try { sock.destroy(); } catch {}
    try { if (typeof stream.destroy === 'function' && !stream.destroyed) stream.destroy(); } catch {}
  }
}

// Scan a file on local disk by streaming it in. The daemon never sees a path.
async function scanFile(filePath, opts) {
  let st = null;
  try { st = await fs.promises.stat(filePath); } catch { return null; }
  return scanStream(fs.createReadStream(filePath), { ...(opts || {}), size: st.size, label: (opts && opts.label) || filePath });
}

// A small command with a NUL-terminated reply.
async function talk(command, timeoutMs) {
  const sock = await connect(timeoutMs);
  try {
    const replyP = readReply(sock);
    await writeBackpressured(sock, Buffer.from(command + '\0', 'latin1'));
    const reply = await withTimeout(replyP, timeoutMs || TALK_TIMEOUT_MS, 'clamav_timeout');
    return String(reply).trim();
  } finally {
    try { sock.destroy(); } catch {}
  }
}

const ping = () => talk('zPING');
const version = () => talk('zVERSION');
// Tell a daemon that reloaded its database to re-read it. Unused by the app
// (the daemon watches its own database directory, see the compose file); kept
// exported so an operator tool can ask a running daemon to reload.
const reload = () => talk('zRELOAD');

// "ClamAV 1.4.6/28122/Sun Sep 13 06:26:25 2026" -> its three parts. The middle
// field is the signature database revision, which is what an operator wants to
// see when asking "are these signatures current?" — and what makes a stale
// deployment visible instead of silent.
function parseVersion(raw) {
  const text = String(raw || '').trim();
  const m = /^ClamAV\s+(\S+)\/(\d+)\/(.+)$/.exec(text);
  if (!m) return null;
  return { engine: m[1], db: m[2], dbDate: m[3].trim(), raw: text.slice(0, 160) };
}

// The engine, asked by USING it. Two questions, because they prove different
// things: VERSION says which ClamAV and which signatures are loaded (and is the
// identity every verdict is recorded against), and a real INSTREAM scan of the
// EICAR string says the daemon actually matches signatures rather than merely
// being up. A daemon that answers OK to EICAR is a scanner that detects nothing,
// which is worse than no scanner — it is believed — so that is refused rather
// than logged.
async function probe() {
  let raw = '';
  try {
    raw = await version();
  } catch (e) {
    const why = String((e && e.message) || e);
    return { ok: false, why: /clamav_connect/.test(why) ? 'clamav_unreachable' : why };
  }
  const info = parseVersion(raw);
  if (!info) return { ok: false, why: 'no_version_reported' };
  if (VERIFY_EICAR) {
    try {
      const v = await scanStream(Readable.from([Buffer.from(EICAR + '\n')]), { size: EICAR.length + 1, label: 'eicar-probe', timeoutMs: 30000 });
      if (v.clean) return { ok: false, why: 'eicar_not_detected' };
    } catch (e) {
      return { ok: false, why: String((e && e.message) || e).slice(0, 120) };
    }
  } else {
    try { await ping(); } catch (e) { return { ok: false, why: String((e && e.message) || e).slice(0, 120) }; }
  }
  return { ok: true, ...info };
}

module.exports = {
  scanStream, scanFile, probe, parseScanReply, parseVersion,
  ping, version, reload, scanTimeoutFor,
  EICAR,
  host: () => HOST,
  port: () => PORT,
  eicarVerification: () => VERIFY_EICAR,
};
