// A snapshot stores the database, the Secrets and a media INVENTORY -- never a
// second copy of the media bucket.
//
// Offline: db, storage, r2 and pg_dump are all stubbed, so nothing here touches
// Postgres or the network. What it pins down is the shape that made the account
// pay for the media twice:
//   * no key is ever written under blobs/ (the mirror the old design kept);
//   * the manifest says media.included === false and carries a key+size
//     inventory instead of objects with bytes/hashes;
//   * the inventory leaves out the media bucket's legacy backups/ prefix;
//   * prune deletes only the oldest snapshot directories -- and reaps any
//     blobs/ residue, because nothing reads a blob to restore anything;
//   * a failed run rolls back its own partial objects instead of leaving an
//     orphan directory holding a retention slot.
// It also pins the secrets half: the environment goes in (that IS the host .env
// on Compose), with the image's runtime noise left out.
const fs = require('node:fs');
const crypto = require('node:crypto');

process.env.R2_BACKUP_KEEP = '2';
// The values a snapshot has to carry, and the noise it must not.
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.POSTGRES_PASSWORD = 'test-db-password';
process.env.MAX_FILE_MB = '50';

// pg_dump stand-in: backup.js shells out for the dump, so the fake writes the
// file it is handed and reports success.
const cp = require('node:child_process');
const FAKE_DUMP = Buffer.from('not really a pg_dump\n');
cp.execFile = (cmd, args, opts, cb) => {
  try { fs.writeFileSync(args[2], FAKE_DUMP); } catch (e) { if (cb) cb(e); return; }
  if (cb) cb(null, '', '');
};

const db = require('../db');
db.withLock = async (key, fn) => ({ ran: true, value: await fn() });

const storage = require('../storage');
const LIVE = [
  { key: 'files/a.png', size: 10 },
  { key: 'files/b.mp4', size: 2048 },
  { key: 'backups/20250101T000000Z/campfire.dump', size: 999 },
];
storage.s3List = async () => LIVE.map((o) => ({ ...o }));
storage.S3_BUCKET = 'campfire-media';

// One in-memory backup bucket: every r2 call goes here.
const r2 = require('../r2');
const store = new Map();
const written = [];
r2.r2Enabled = () => true;
r2.put = async (key, buf) => { store.set(key, Buffer.from(buf)); written.push(key); };
r2.getBuffer = async (key) => {
  if (!store.has(key)) throw new Error('NoSuchKey: ' + key);
  return store.get(key);
};
r2.list = async (prefix) => [...store.entries()]
  .filter(([k]) => !prefix || k.startsWith(prefix))
  .map(([k, v]) => ({ key: k, size: v.length, modified: null }));
r2.del = async (key) => { store.delete(key); };
r2.delMany = async (keys) => {
  let n = 0;
  for (const k of keys) { if (store.delete(k)) n++; }
  return n;
};
r2.BUCKET = 'campfire-backup';

const backup = require('../backup');

let fail = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail)));
  if (!cond) fail++;
};
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const keys = () => [...store.keys()].sort();

// A snapshot the blob-era code wrote: a manifest with a top-level objects list,
// sitting next to the blob it referenced.
function seedLegacy(stamp) {
  store.set(`snapshots/${stamp}/db/campfire.dump`, Buffer.from('old dump'));
  store.set(`snapshots/${stamp}/secrets/secrets.json`, Buffer.from('{}'));
  store.set(`snapshots/${stamp}/manifest.json`, Buffer.from(JSON.stringify({
    version: 1, stamp, created: new Date().toISOString(), objects: [{ key: 'files/a.png', size: 10, sha256: 'x', reused: true }],
  })));
}

(async () => {
  // 1. a run that fails after the dump was written leaves NOTHING behind
  const realPut = r2.put;
  r2.put = async (key, buf) => {
    if (key.endsWith('/manifest.json')) throw new Error('boom');
    return realPut(key, buf);
  };
  await backup.runBackup('test-fail');
  r2.put = realPut;
  check('a failed run rolls back its own partial objects', store.size === 0, keys());

  // 2. a real run: database + secrets + inventory, no media copy
  seedLegacy('20200101T000000Z');
  seedLegacy('20200102T000000Z');
  store.set('blobs/files/a.png', Buffer.from('legacy blob'));
  store.set('blobs/files/gone.png', Buffer.from('legacy blob, gone from media'));

  written.length = 0;
  await backup.runBackup('test');

  check('nothing is written outside snapshots/', written.every((k) => k.startsWith('snapshots/')), written);
  check('no blobs/ key is ever written', !written.some((k) => k.startsWith('blobs/')), written);
  check('no blobs/ object survives the run', !keys().some((k) => k.startsWith('blobs/')), keys());

  const manifestKey = written.find((k) => k.endsWith('/manifest.json'));
  const m = JSON.parse(store.get(manifestKey).toString('utf8'));
  const stamp = manifestKey.split('/')[1];

  check('the manifest is version 2', m.version === 2, m.version);
  check('the snapshot declares media is not included', m.media && m.media.included === false, m.media && m.media.included);
  check('there is no blob-era top-level objects list', m.objects === undefined, m.objects && m.objects.length);
  check('the inventory is key + size only',
    JSON.stringify(m.media.inventory) === JSON.stringify([{ key: 'files/a.png', size: 10 }, { key: 'files/b.mp4', size: 2048 }]),
    m.media.inventory);
  check('the legacy media backups/ prefix is left out of the inventory',
    !m.media.inventory.some((o) => o.key.startsWith('/') || o.key.startsWith('backups/')), m.media.inventory.map((o) => o.key));
  check('the media totals match the inventory', m.media.objects === 2 && m.media.bytes === 2058, m.media);
  check('the dump is recorded with its length and sha256',
    m.database.size === FAKE_DUMP.length && m.database.sha256 === sha256(FAKE_DUMP), m.database);
  check('the environment is in the snapshot, so a rebuild has its secrets',
    m.secrets && m.secrets.env >= 2, m.secrets);
  const secrets = JSON.parse(store.get(`snapshots/${stamp}/secrets/secrets.json`).toString('utf8'));
  check('the values are stored verbatim',
    secrets.env.JWT_SECRET === 'test-jwt-secret' && secrets.env.POSTGRES_PASSWORD === 'test-db-password',
    Object.keys(secrets.env));
  check('the plain config is captured too, not only passwords', secrets.env.MAX_FILE_MB === '50', secrets.env.MAX_FILE_MB);
  check('runtime noise is left out of the environment capture',
    !('PATH' in secrets.env) && !('HOSTNAME' in secrets.env), Object.keys(secrets.env).slice(0, 8));
  check('no warning is raised when secrets were captured',
    Array.isArray(m.warnings) && m.warnings.length === 0, m.warnings);
  check('the database dump and its manifest are in the same directory',
    store.has(`snapshots/${stamp}/db/campfire.dump`) && store.has(manifestKey), keys());

  // 3. retention: newest KEEP snapshots, oldest directory gone, orphans gone
  check('retention kept the newest two snapshots',
    keys().some((k) => k.startsWith('snapshots/20200102T000000Z/')) && keys().some((k) => k.startsWith(`snapshots/${stamp}/`)),
    keys());
  check('retention removed the oldest snapshot directory',
    !keys().some((k) => k.startsWith('snapshots/20200101T000000Z/')), keys());

  console.log(fail ? `\n${fail} check(s) FAILED` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('failed:', (e && e.message) || e);
  process.exit(1);
});
