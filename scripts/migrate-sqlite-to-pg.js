// One-shot SQLite -> Postgres migration (run once during the PG move).
//
// Reads every table from the SQLite file at SQLITE_PATH (default
// ./data/campfire.db) and bulk-loads it into Postgres (DATABASE_URL or
// PG* env, same as the app). Only columns present on BOTH sides are
// copied, so legacy columns die quietly. Foreign keys are bypassed for
// the load via session_replication_role, then counts are verified.
//
// Refuses to run against a non-empty target unless MIGRATE_OVERWRITE=1
// (which truncates first). The SQLite file is only ever READ.
//
// Usage (inside the app container, which has both node:sqlite and pg):
//   SQLITE_PATH=/data/campfire.db node scripts/migrate-sqlite-to-pg.js
const { DatabaseSync } = require('node:sqlite');
const { Pool, types } = require('pg');

types.setTypeParser(20, (v) => (v === null || v === undefined ? null : parseInt(v, 10)));

const SRC = process.env.SQLITE_PATH || './data/campfire.db';
const OVERWRITE = process.env.MIGRATE_OVERWRITE === '1';
const BATCH = 500;
// Leftover artifacts that must never be pumped.
const SKIP_TABLES = new Set(['servers_new']);

function poolConfig() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  return {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10) || 5432,
    database: process.env.PGDATABASE || 'campfire',
    user: process.env.PGUSER || 'campfire',
    password: process.env.PGPASSWORD || '',
  };
}

const clean = (v) => (typeof v === 'bigint' ? Number(v) : v);

(async () => {
  const src = new DatabaseSync(SRC, { readOnly: true });
  const pool = new Pool(poolConfig());
  const pg = await pool.connect();
  try {
    const tables = src.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).all().map((r) => r.name).filter((t) => !SKIP_TABLES.has(t));
    console.log(`[migrate] source: ${SRC} (${tables.length} tables)`);

    const pgTables = new Set(
      (await pg.query('SELECT tablename FROM pg_tables WHERE schemaname = current_schema()')).rows.map((r) => r.tablename)
    );
    for (const t of tables) {
      if (!pgTables.has(t)) throw new Error(`target missing table ${t} — boot the app first so initDb creates the schema`);
    }

    const users = await pg.query('SELECT COUNT(*) c FROM users');
    if (Number(users.rows[0].c) > 0 && !OVERWRITE) {
      throw new Error('target database is not empty — refusing (set MIGRATE_OVERWRITE=1 to truncate and reload)');
    }

    await pg.query('BEGIN');
    try {
      await pg.query("SET LOCAL session_replication_role = 'replica'");
      if (OVERWRITE) {
        for (const t of tables) await pg.query(`TRUNCATE "${t}" CASCADE`);
        console.log('[migrate] truncated target tables');
      }
      let total = 0;
      for (const t of tables) {
        const srcCols = src.prepare(`PRAGMA table_info("${t.replace(/"/g, '""')}")`).all().map((c) => c.name);
        const pgCols = (await pg.query(
          'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1', [t]
        )).rows.map((r) => r.column_name);
        const cols = srcCols.filter((c) => pgCols.includes(c));
        const skipped = srcCols.filter((c) => !pgCols.includes(c));
        if (skipped.length) console.log(`[migrate] ${t}: skipping legacy columns ${skipped.join(', ')}`);
        const n = src.prepare(`SELECT COUNT(*) c FROM "${t.replace(/"/g, '""')}"`).get().c;
        if (!n) { console.log(`[migrate] ${t}: 0 rows`); continue; }
        const colList = cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ');
        let done = 0;
        while (done < n) {
          const rows = src.prepare(`SELECT ${colList} FROM "${t.replace(/"/g, '""')}" LIMIT ${BATCH} OFFSET ${done}`).all();
          const vals = [];
          const ph = rows.map((r) => {
            const start = vals.length + 1;
            for (const c of cols) vals.push(clean(r[c]));
            return `(${cols.map((_, i) => `$${start + i}`).join(', ')})`;
          }).join(', ');
          await pg.query(`INSERT INTO "${t}" (${colList}) VALUES ${ph}`, vals);
          done += rows.length;
        }
        total += n;
        console.log(`[migrate] ${t}: ${n} rows`);
      }
      await pg.query('COMMIT');
      console.log(`[migrate] loaded ${total} rows total`);
    } catch (e) {
      try { await pg.query('ROLLBACK'); } catch {}
      throw e;
    }

    // Verify counts match on both sides.
    let ok = true;
    for (const t of tables) {
      const a = src.prepare(`SELECT COUNT(*) c FROM "${t.replace(/"/g, '""')}"`).get().c;
      const b = Number((await pg.query(`SELECT COUNT(*) c FROM "${t}"`)).rows[0].c);
      if (a !== b) { ok = false; console.error(`[migrate] COUNT MISMATCH ${t}: sqlite=${a} pg=${b}`); }
    }
    if (!ok) throw new Error('verification failed');
    console.log('[migrate] verification passed — all table counts match');
  } finally {
    try { src.close(); } catch {}
    pg.release();
    await pool.end();
  }
})().catch((e) => { console.error('[migrate] FAILED:', (e && e.message) || e); process.exit(1); });
