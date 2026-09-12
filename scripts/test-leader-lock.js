// Leader election across replicas: N separate processes race for ONE
// advisory-lock job key, and exactly one may win.
//
// This is the guarantee behind objective item 3 — migrations, reapers, sweeps
// and pg_dump each running exactly once cluster-wide. The lock primitive is
// Postgres' pg_try_advisory_lock, so the winner holds it for the duration and
// every loser must observe { ran: false } and skip the job rather than queue
// behind it. A per-process guard would let all N run, which is the bug this
// design removes: three replicas would each dump the same database nightly.
//
// Skips (exit 0) when Postgres is unreachable, like the rest of the suite.
const { spawn } = require('node:child_process');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const db = require('../db');

const PROBE = path.join(__dirname, 'lock-probe.js');
const PROBES = 4;
const HOLD_MS = 2500;

function run(key) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [PROBE, String(key), String(HOLD_MS)], {
      cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

(async () => {
  try { await db.prepare('SELECT 1 AS ok').get(); }
  catch (e) { console.log('SKIP: Postgres unavailable —', (e && e.message) || e); process.exit(0); }

  let fail = 0;
  const check = (name, cond, detail) => {
    console.log((cond ? 'ok   ' : 'FAIL ') + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail)));
    if (!cond) fail++;
  };

  // A key from the real LOCKS table, so this exercises the actual job locks.
  const key = db.LOCKS.backups;
  console.log(`[leader] ${PROBES} replicas racing for LOCKS.backups (${key}), winner holds ${HOLD_MS}ms`);

  const results = await Promise.all(Array.from({ length: PROBES }, () => run(key)));
  const won = results.filter((r) => r.out === 'RAN=true').length;
  const lost = results.filter((r) => r.out === 'RAN=false').length;
  for (const r of results) {
    if (r.err) console.log('  stderr: ' + r.err.split('\n').slice(0, 3).join(' | '));
  }

  check('every probe exited cleanly', results.every((r) => r.code === 0), results.map((r) => r.code));
  check(`exactly one replica won the job (got ${won})`, won === 1, { won, lost });
  check(`the other ${PROBES - 1} skipped instead of queueing (got ${lost})`, lost === PROBES - 1, { won, lost });

  // …and the lock is released afterwards, so the NEXT run can win again.
  const after = await run(key);
  check('the lock is free again after the winner finishes', after.out === 'RAN=true', after.out);

  await db.closePool();
  console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
})();
