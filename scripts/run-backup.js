// Take an off-site snapshot NOW instead of waiting for the 00:00/12:00 slot.
//
//   node scripts/run-backup.js [reason]
//
// It calls the same backup.runBackup() the scheduler calls, so it takes the same
// cluster-wide lock: a manual run can never race a scheduled one, and a second
// replica asking at the same moment skips with "another replica holds the backup
// lock". Retention runs at the end of a successful snapshot exactly as it does on
// the schedule, so this cannot leave more than R2_BACKUP_KEEP behind.
//
// Useful after a change to backup.js (prove the new shape by taking one), after
// restoring, and before trusting a restore: an untested backup is a hope.
const backup = require('../backup');

const reason = process.argv[2] || 'manual';

backup.runBackup(reason)
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('backup failed:', (e && e.message) || e);
    process.exit(1);
  });
