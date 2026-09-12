// Child process for scripts/test-leader-lock.js: stands in for one replica and
// races for a leader-elected job lock. Warms the pool first so every probe
// reaches the lock within a few milliseconds of the others.
const db = require('../db');

const key = parseInt(process.argv[2], 10);
const holdMs = parseInt(process.argv[3] || '2500', 10);

(async () => {
  await db.prepare('SELECT 1 AS ok').get(); // warm the connection
  const r = await db.withLock(key, async () => {
    await new Promise((res) => setTimeout(res, holdMs));
    return 'ran';
  });
  console.log(`RAN=${r.ran}`);
  await db.closePool();
  process.exit(0);
})().catch((e) => { console.error('LOCK PROBE FAILED', (e && e.stack) || e); process.exit(1); });
