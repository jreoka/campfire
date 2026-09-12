// Minimal stand-in for a REMOTE clamd, for verifying CLAM_HOST.
// Answers the readiness PING and the INSTREAM scan protocol — just enough for
// the app to talk to a clamd that lives somewhere else (its own pod/Service),
// which is the configuration a multi-replica deployment wants.
//
// Usage: node scripts/fake-clamd.js [port]
// Prints "LISTENING <port>" once it is accepting connections.
const net = require('node:net');

const port = parseInt(process.argv[2] || '3399', 10);
let scans = 0;

const server = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // PING is line-oriented and constant.
    if (buf.length >= 5 && buf.slice(0, 5).toString() === 'PING\n') {
      buf = buf.slice(5);
      sock.write('PONG\n');
      return;
    }
    // zINSTREAM: NUL-terminated command, then 4-byte length + payload chunks,
    // terminated by a zero-length chunk.
    if (buf.length >= 10 && buf.slice(0, 10).toString() === 'zINSTREAM\0') {
      for (;;) {
        if (buf.length < 14) return; // need the first length prefix
        const len = buf.readUInt32BE(10);
        if (len === 0) {
          scans++;
          buf = buf.slice(14);
          sock.write('stream: OK\0');
          return;
        }
        if (buf.length < 14 + len) return; // wait for the whole chunk
        buf = buf.slice(14 + len);
      }
    }
  });
  sock.on('error', () => {});
});

server.listen(port, '0.0.0.0', () => console.log('LISTENING ' + port));
process.on('SIGTERM', () => { console.log('scans=' + scans); process.exit(0); });
