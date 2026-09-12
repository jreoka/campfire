// Child process for scripts/test-bus.js: stands in for ONE replica.
// Starts the bus, subscribes, publishes one event of its own, and reports
// everything it receives. Exits on its own so the parent never signals it.
const bus = require('../bus');

const me = process.argv[2] || 'X';
const holdMs = parseInt(process.argv[3] || '2500', 10);

(async () => {
  await bus.start();
  bus.subscribe('probe', (p) => {
    console.log(`GOT ${p && p.from} self=${(p && p.from) === me}`);
  });
  // Give the peer replica time to establish its LISTEN before publishing.
  await new Promise((r) => setTimeout(r, 900));
  await bus.publish('probe', { from: me, seq: 1 });
  console.log(`PUBLISHED ${me}`);
  await new Promise((r) => setTimeout(r, holdMs));
  await bus.flush();
  console.log(`DONE ${me} ${JSON.stringify(bus.stats())}`);
  await bus.stop();
  process.exit(0);
})().catch((e) => { console.error('PROBE FAILED', (e && e.stack) || e); process.exit(1); });
