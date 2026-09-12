// Cross-replica bus test: two separate PROCESSES (two "replicas") against one
// Postgres, asserting the delivery contract documented at the top of bus.js:
//
//   - an event published by replica A reaches replica B
//   - an event published by replica B reaches replica A
//   - neither replica receives its OWN event (the publisher already delivered
//     to its own sockets synchronously — this is what keeps single-replica
//     behavior identical)
//   - each replica receives each remote event exactly once
//
// Skips (exit 0) when Postgres is unreachable, like the rest of the suite.
const { spawn } = require('node:child_process');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const db = require('../db');

const PROBE = path.join(__dirname, 'bus-probe.js');

function run(tag) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [PROBE, tag, '2500'], {
      cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => resolve({ tag, code, out, err }));
  });
}

(async () => {
  try { await db.prepare('SELECT 1 AS ok').get(); }
  catch (e) { console.log('SKIP: Postgres unavailable —', (e && e.message) || e); process.exit(0); }

  // Create the bus table up front so the two probes never race on first DDL.
  const bus = require('../bus');
  await bus.start();
  await bus.stop();

  const [a, b] = await Promise.all([run('A'), run('B')]);
  let fail = 0;
  const check = (name, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + name); if (!cond) fail++; };

  console.log('--- replica A ---\n' + a.out.trim());
  console.log('--- replica B ---\n' + b.out.trim());
  for (const p of [a, b]) if (p.err.trim()) console.log(`--- ${p.tag} stderr ---\n` + p.err.trim());

  check('both probes exited cleanly', a.code === 0 && b.code === 0);
  check('both probes published', /PUBLISHED A/.test(a.out) && /PUBLISHED B/.test(b.out));
  check("A received B's event", /GOT B self=false/.test(a.out));
  check("B received A's event", /GOT A self=false/.test(b.out));
  check('A did NOT receive its own event', !/GOT A self=true/.test(a.out));
  check('B did NOT receive its own event', !/GOT B self=true/.test(b.out));
  check('A received exactly one event', (a.out.match(/GOT /g) || []).length === 1);
  check('B received exactly one event', (b.out.match(/GOT /g) || []).length === 1);

  await db.closePool();
  console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
})();
