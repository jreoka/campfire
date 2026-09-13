// Remove the legacy media mirror from the backup bucket.
//
//   node scripts/purge-backup-blobs.js                     # dry run: report only
//   node scripts/purge-backup-blobs.js --write             # delete blobs the media bucket still has
//   node scripts/purge-backup-blobs.js --write --orphans   # ...and the ones it does not
//   node scripts/purge-backup-blobs.js --json              # machine-readable report, implies dry run
//
// WHY THIS EXISTS
//   backup.js used to mirror the whole media bucket into this bucket under
//   blobs/<key>, deduplicated across snapshots. It doubled what the Cloudflare
//   account stored, in the SAME account that held the media it copied, so it
//   could not survive losing that account and it bought nothing but the bill.
//   New snapshots carry a media inventory and no bytes (see backup.js), and
//   prune() reaps whatever blobs are left -- but the first pass is a large,
//   irreversible delete, so it lives in a script you run on purpose, and it is
//   dry-run by default.
//
// WHAT IS SAFE TO DELETE
//   A blob whose key is still in the media bucket is a COPY: the live object is
//   the original and this changes nothing about serving it.
//   A blob whose key is NOT in the media bucket is the only copy of bytes the
//   app has already removed -- reaped view-once media, a file the scanner
//   deleted, an original media-compress replaced, a message deleted when the
//   bytes went with it. Those are listed and SKIPPED unless --orphans is passed,
//   because "get my storage back" and "destroy the last copy of a file" are
//   different decisions and only one of them is reversible.
//
// Needs both credential sets: reads the backup bucket (R2_*), reads the media
// bucket (S3_*) to verify a copy exists.
const r2 = require('../r2');
const storage = require('../storage');

const BLOBS = 'blobs/';
const SAMPLE = 20;

function human(n) {
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + 'MB';
  return (n / 1073741824).toFixed(2) + 'GB';
}

async function main() {
  const write = process.argv.includes('--write');
  const withOrphans = process.argv.includes('--orphans');
  const asJson = process.argv.includes('--json');

  if (!r2.r2Enabled()) {
    console.error('R2_* env is not configured; this reads the backup bucket.');
    process.exit(1);
  }

  const blobs = await r2.list(BLOBS);
  if (!blobs.length) {
    console.log(`No ${BLOBS} objects in ${r2.BUCKET} -- the backup bucket already stores snapshots only.`);
    return;
  }
  const totalBytes = blobs.reduce((n, b) => n + (b.size || 0), 0);

  // The live media bucket decides which blobs are copies. Without it every blob
  // looks like an orphan, which is exactly the case that must NOT be guessed at.
  let live = null;
  if (storage.s3Enabled()) {
    live = new Set((await storage.s3List('')).map((o) => o.key));
  } else {
    console.warn('S3_* env is not configured: cannot verify a blob against the media bucket.');
    console.warn('Every blob will be treated as an orphan -- pass --orphans to delete them anyway.');
  }

  const covered = [];
  const orphans = [];
  for (const b of blobs) {
    (live && live.has(b.key.slice(BLOBS.length)) ? covered : orphans).push(b);
  }
  const bytesOf = (list) => list.reduce((n, b) => n + (b.size || 0), 0);

  const doomed = withOrphans ? covered.concat(orphans) : covered;
  const report = {
    bucket: r2.BUCKET,
    blobs: blobs.length,
    blobsBytes: totalBytes,
    covered: covered.length,
    coveredBytes: bytesOf(covered),
    orphans: orphans.length,
    orphanBytes: bytesOf(orphans),
    mediaVerified: Boolean(live),
    deleting: doomed.length,
    deletingBytes: bytesOf(doomed),
    write,
    withOrphans,
  };

  if (asJson) {
    console.log(JSON.stringify({ ...report, orphanKeys: orphans.slice(0, 200).map((b) => b.key) }, null, 2));
    return;
  }

  console.log(`${BLOBS} in ${r2.BUCKET}: ${blobs.length} object(s), ${human(totalBytes)}`);
  console.log(`  copies still in the media bucket : ${covered.length}  (${human(bytesOf(covered))}) -- safe to delete`);
  console.log(`  only copy (gone from media)      : ${orphans.length}  (${human(bytesOf(orphans))})` +
    (orphans.length ? ' -- kept unless --orphans' : ''));
  for (const b of orphans.slice(0, SAMPLE)) console.log(`      ${b.key.slice(BLOBS.length)} (${human(b.size || 0)})`);
  if (orphans.length > SAMPLE) console.log(`      ...and ${orphans.length - SAMPLE} more`);

  if (!write) {
    console.log(`\nDry run. Re-run with --write to delete ${doomed.length} object(s) (${human(bytesOf(doomed))}), ` +
      'or --write --orphans to take the rest too.');
    return;
  }
  if (!doomed.length) {
    console.log('\nNothing to delete. Pass --orphans to remove the ones the media bucket no longer has.');
    return;
  }

  const deleted = await r2.delMany(doomed.map((b) => b.key));
  console.log(`\nDeleted ${deleted} object(s), freeing ${human(bytesOf(doomed))}.`);
  if (!withOrphans && orphans.length) {
    console.log(`${orphans.length} orphan(s) (${human(bytesOf(orphans))}) left in place -- their bytes exist nowhere else.`);
  }
  const left = await r2.list(BLOBS);
  console.log(left.length
    ? `${left.length} object(s) remain under ${BLOBS}.`
    : `${BLOBS} is now empty: the backup bucket holds snapshots only.`);
}

main().catch((e) => {
  console.error('failed:', (e && e.message) || e);
  process.exit(1);
});
