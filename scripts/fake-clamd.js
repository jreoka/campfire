#!/usr/bin/env node
// scripts/fake-clamd.js
//
// A stand-in for a real `clamd`: it speaks the same wire protocol (see the
// header of clamav.js) in-process, so the upload pipeline can be exercised end
// to end on any machine — no ClamAV install, no container, and no dependence on
// whether a signature has been published for whatever a test uploads.
//
// Used two ways:
//
//   * in-process, by the tests that boot a server (they start it on an
//     ephemeral port and hand the app CLAMAV_HOST/CLAMAV_PORT):
//
//       const fake = require('./fake-clamd');
//       const srv = await fake.start();          // { port, close() }
//
//   * standalone, as a daemon on a fixed port, for poking at the app by hand:
//
//       node scripts/fake-clamd.js 3310
//
// What it decides, in order:
//   1. FAKE_CLAMAV_VERDICT forces a verdict (clean | malware | error)
//   2. the bytes contain the malware marker        -> FOUND (see MARKER below)
//   3. the bytes contain the EICAR test string     -> FOUND Eicar-Signature
//   4. otherwise                                   -> OK
//
// The marker is CONTENT, never a file name: the whole point of the upload
// pipeline is that a renamed extension buys an attacker nothing, and a stand-in
// that keyed on the name would quietly stop testing that.
//
// Env:
//   FAKE_CLAMAV_DELAY_MS   pause before answering a scan (default 0). A real
//                          ClamAV scan is milliseconds, too fast to observe the
//                          `pending` state; a test sets this to make the
//                          transition deterministic.
//   FAKE_CLAMAV_VERDICT    clean | malware | error — force it, ignore content.
//                          `error` is the "INSTREAM size limit exceeded" shape:
//                          the daemon answered, and the answer is not a verdict.
//   FAKE_CLAMAV_VERSION    what VERSION reports (default a plausible 1.4 line).
//   FAKE_CLAMAV_NO_VERSION =1 answers VERSION with a line parseVersion cannot
//                          read, so the engine-identity probe must refuse it.
//   FAKE_CLAMAV_LOG        append one JSON line per answered scan
//                          ({"reply","size","command"}) — how a test asserts
//                          WHICH bytes reached the scanner, and how many times,
//                          without guessing from timing.
'use strict';

const fs = require('fs');
const net = require('net');

const MARKER = 'FAKE-CLAMAV-MALWARE-MARKER';
// Assembled from fragments, never one literal: this repository should not
// contain a contiguous EICAR signature that a checkout-time AV scan would
// quarantine.
const EICAR_MARK = 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE';

const DEFAULT_VERSION = 'ClamAV 1.4.6/28122/Sun Sep 13 06:26:25 2026';

function config() {
  const env = process.env;
  return {
    delay: Math.max(0, parseInt(env.FAKE_CLAMAV_DELAY_MS || '0', 10) || 0),
    forced: String(env.FAKE_CLAMAV_VERDICT || '').toLowerCase(),
    version: env.FAKE_CLAMAV_VERSION || DEFAULT_VERSION,
    noVersion: env.FAKE_CLAMAV_NO_VERSION === '1',
    log: env.FAKE_CLAMAV_LOG || '',
  };
}

function note(entry) {
  const cfg = config();
  if (!cfg.log) return;
  try { fs.appendFileSync(cfg.log, JSON.stringify(entry) + '\n'); } catch {}
}

// The verdict for one streamed body.
function judge(buf) {
  const cfg = config();
  if (cfg.forced === 'malware') return { reply: 'stream: Fake-ClamAV-Test-Signature FOUND', found: true, size: buf.length };
  if (cfg.forced === 'error') return { reply: 'INSTREAM size limit exceeded. ERROR', found: false, size: buf.length };
  if (cfg.forced === 'clean') return { reply: 'stream: OK', found: false, size: buf.length };
  const text = buf.toString('latin1');
  if (text.includes(MARKER)) return { reply: 'stream: Fake-ClamAV-Test-Signature FOUND', found: true, size: buf.length };
  if (text.includes(EICAR_MARK)) return { reply: 'stream: Eicar-Signature FOUND', found: true, size: buf.length };
  return { reply: 'stream: OK', found: false, size: buf.length };
}

// One connection's worth of protocol. `z`-prefixed commands are what clamd
// itself documents ("z" = NUL-terminated reply); plain names are accepted too,
// because that is what a hand-written client (or a person with nc) sends.
function handle(sock) {
  let buf = Buffer.alloc(0);
  let mode = null; // null = reading a command, 'instream' = reading a body
  let body = [];

  const send = (s) => { try { sock.write(s + '\0'); } catch {} };

  sock.on('error', () => {});
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (mode === 'instream') {
        if (buf.length < 4) return;
        const n = buf.readUInt32BE(0);
        if (n === 0) {
          buf = buf.subarray(4);
          mode = null;
          const all = Buffer.concat(body);
          body = [];
          const finish = () => {
            const v = judge(all);
            note({ command: 'INSTREAM', size: v.size, reply: v.reply });
            send(v.reply);
          };
          // A real daemon takes real time; a test wants the pending state to be
          // observable, so the pause is before the answer, not before the read.
          if (config().delay) setTimeout(finish, config().delay); else finish();
          continue;
        }
        if (buf.length < 4 + n) return;
        body.push(buf.subarray(4, 4 + n));
        buf = buf.subarray(4 + n);
        continue;
      }
      const z = buf.indexOf(0);
      if (z < 0) return;
      const cmd = buf.subarray(0, z).toString('latin1').trim();
      buf = buf.subarray(z + 1);
      const name = cmd.replace(/^z/i, '').toUpperCase();
      if (name === 'PING') { send('PONG'); continue; }
      if (name === 'VERSION') {
        send(config().noVersion ? 'not a clamav version line' : config().version);
        continue;
      }
      if (name === 'RELOAD') { send('RELOADING'); continue; }
      if (name === 'INSTREAM') { mode = 'instream'; body = []; continue; }
      send('UNKNOWN COMMAND');
    }
  });
}

let servers = [];

// Start a stand-in daemon. Port 0 (the default) asks the OS for a free one,
// which is what the tests want: several suites run at once and none of them
// should collide with a real clamd or with each other.
function start(opts) {
  const port = (opts && opts.port) || 0;
  return new Promise((resolve, reject) => {
    const server = net.createServer(handle);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      servers.push(server);
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => { server.close(() => r()); try { server.unref(); } catch {} }),
      });
    });
  });
}

function closeAll() {
  const all = servers;
  servers = [];
  return Promise.all(all.map((s) => new Promise((r) => s.close(() => r()))));
}

module.exports = { start, closeAll, judge, MARKER, EICAR_MARK };

// Standalone: node scripts/fake-clamd.js [port]
if (require.main === module) {
  const port = parseInt(process.argv[2] || '3310', 10) || 3310;
  start({ port }).then((s) => {
    console.log('[fake-clamd] listening on 127.0.0.1:' + s.port + ' — CLAMAV_HOST=127.0.0.1 CLAMAV_PORT=' + s.port);
  }).catch((e) => { console.error('[fake-clamd] failed to listen:', e.message); process.exit(1); });
}
