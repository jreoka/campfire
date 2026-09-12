// Restore from the off-site R2 backups written by backup.js.
//
//   node scripts/restore-from-r2.js --list
//   node scripts/restore-from-r2.js --show [stamp]
//   node scripts/restore-from-r2.js --fetch [stamp] [--out DIR] [--with-media]
//   node scripts/restore-from-r2.js --restore-media [stamp] [--write]
//
// Needs both sets of credentials, because it reads the backup bucket and (for
// media) writes the media bucket:
//   R2_ENDPOINT R2_BUCKET R2_REGION R2_ACCESS_KEY R2_SECRET_KEY   (backup, read)
//   S3_ENDPOINT S3_BUCKET S3_REGION S3_ACCESS_KEY S3_SECRET_KEY   (media, write)
//
// Restoring the DATABASE is deliberately not automated here. `pg_restore
// --clean` drops and recreates tables in a live database, and the data-safety
// contract says destructive operations get done deliberately, by hand, with the
// command in front of you. --fetch downloads the dump and prints the exact
// commands instead.
//
// Media restore is a copy: it writes objects into the media bucket and never
// deletes anything, so it is safe to re-run. Dry-run by default.
const fs = require('fs');
const path = require('path');
const r2 = require('../r2');
const storage = require('../storage');

const SNAP = 'snapshots/';
const BLOBS = 'blobs/';

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return (!v || v.startsWith('--')) ? true : v;
}

function human(n) {
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + 'MB';
  return (n / 1073741824).toFixed(2) + 'GB';
}

async function snapshotStamps() {
  const objs = await r2.list(SNAP);
  const dirs = new Map();
  for (const o of objs) {
    const rest = o.key.slice(SNAP.length);
    const s = rest.split('/')[0];
    if (!s) continue;
    if (!dirs.has(s)) dirs.set(s, []);
    dirs.get(s).push(o);
  }
  const complete = [];
  for (const [s, list] of dirs) {
    if (list.some((o) => o.key === SNAP + s + '/manifest.json')) complete.push(s);
  }
  complete.sort();
  return complete;
}

async function readManifest(stamp) {
  const buf = await r2.getBuffer(SNAP + stamp + '/manifest.json');
  return JSON.parse(buf.toString('utf8'));
}

function age(created) {
  const ms = Date.now() - new Date(created).getTime();
  const h = Math.floor(ms / 3600000);
  if (h < 1) return Math.floor(ms / 60000) + 'm ago';
  if (h < 48) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

// The dump is what a rebuild actually needs, so keep the default listing
// focused on it rather than on the blob inventory.
function summarise(m) {
  const lines = [];
  lines.push(`  stamp      ${m.stamp}   (${m.created}, ${age(m.created)})`);
  lines.push(`  reason     ${m.reason}`);
  lines.push(`  database   ${m.database ? human(m.database.size) + '  sha256 ' + String(m.database.sha256).slice(0, 16) + '…' : 'MISSING'}`);
  lines.push(`  secrets    ${m.secrets ? m.secrets.count + ' object(s)' : 'NOT INCLUDED'}`);
  lines.push(`  media      ${m.source ? m.source.objects + ' object(s), ' + human(m.source.bytes) : '?'}`);
  if (m.warnings && m.warnings.length) {
    for (const w of m.warnings) lines.push(`  WARNING    ${w}`);
  }
  return lines.join('\n');
}

async function main() {
  const stampArg = arg('stamp', null);
  const out = arg('out', null);
  const write = Boolean(arg('write', false));

  if (!r2.r2Enabled()) {
    console.error('R2_* env is not configured; this reads the backup bucket.');
    process.exit(1);
  }

  const stamps = await snapshotStamps();
  if (!stamps.length) {
    console.error('No complete snapshot found in ' + (r2.BUCKET || 'the backup bucket') + '.');
    process.exit(1);
  }
  const newest = stamps[stamps.length - 1];

  if (process.argv.includes('--list') || process.argv.length <= 2) {
    console.log(`Backups in ${r2.BUCKET}:`);
    for (const s of stamps.slice().reverse()) {
      const m = await readManifest(s);
      console.log(`  ${s}  ${age(m.created).padEnd(9)} db ${human(m.database ? m.database.size : 0).padEnd(7)} ` +
        `secrets ${m.secrets ? m.secrets.count : 'NO'}  media ${m.source ? m.source.objects : '?'} obj` +
        (s === newest ? '   <- newest' : ''));
    }
    console.log(`\n${stamps.length} snapshot(s). Next step: --show [stamp]`);
    return;
  }

  const stamp = typeof stampArg === 'string' ? stampArg : newest;
  if (!stamps.includes(stamp)) {
    console.error(`No such snapshot: ${stamp}\nAvailable: ${stamps.join(', ')}`);
    process.exit(1);
  }
  const m = await readManifest(stamp);

  if (process.argv.includes('--show')) {
    console.log(summarise(m));
    return;
  }

  if (process.argv.includes('--fetch')) {
    const dir = typeof out === 'string' ? out : path.join(process.cwd(), 'campfire-restore-' + stamp);
    fs.mkdirSync(dir, { recursive: true });

    const dumpName = 'campfire.dump';
    const dump = await r2.getBuffer(m.database.key);
    fs.writeFileSync(path.join(dir, dumpName), dump);
    console.log(`saved ${path.join(dir, dumpName)} (${human(dump.length)})`);

    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
    if (m.secrets) {
      const sec = await r2.getBuffer(m.secrets.key);
      fs.writeFileSync(path.join(dir, 'secrets.json'), sec);
      console.log(`saved ${path.join(dir, 'secrets.json')} (${m.secrets.count} secret(s))`);
    }

    if (arg('with-media', false)) {
      const mediaDir = path.join(dir, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });
      let n = 0, bytes = 0;
      for (const o of m.objects || []) {
        const buf = await r2.getBuffer(BLOBS + o.key);
        const dest = path.join(mediaDir, o.key);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf);
        n++; bytes += buf.length;
      }
      console.log(`saved ${n} media object(s) (${human(bytes)}) under ${mediaDir}`);
    }

    console.log(`
Next steps (run these deliberately):

  # 1. database
  kubectl -n campfire cp ${path.join(dir, dumpName)} db-0:/tmp/restore.dump
  kubectl -n campfire exec -it db-0 -- pg_restore -U campfire -d campfire --clean --if-exists /tmp/restore.dump
  kubectl -n campfire exec -it db-0 -- rm -f /tmp/restore.dump
  #    then clear the runtime tables so the first boot is unambiguous:
  kubectl -n campfire exec db-0 -- psql -U campfire -d campfire -c \\
    "TRUNCATE bus_replicas, bus_events, live_sessions, voice_occupants, rate_limits, webauthn_challenges;"

  # 2. media (re-run the backup bucket into the media bucket)
  node scripts/restore-from-r2.js --restore-media ${stamp} --write

  # 3. secrets: compare secrets.json against the cluster before applying, and
  #    remember that replacing JWT_SECRET logs every user out.
  kubectl -n campfire get secret campfire-secrets -o jsonpath='{.data.JWT_SECRET}' | base64 -d`);
    return;
  }

  if (process.argv.includes('--restore-media')) {
    if (!storage.s3Enabled()) {
      console.error('S3_* env is not configured; this writes the media bucket.');
      process.exit(1);
    }
    const target = new Set((await storage.s3List('')).map((o) => o.key));
    let done = 0, skipped = 0, bytes = 0, ignored = 0;
    for (const o of m.objects || []) {
      // Never resurrect the media bucket's backups/ prefix. It is not media, and
      // backups deliberately live in R2 only -- a snapshot taken before that
      // prefix was emptied still lists those keys.
      if (o.key === 'backups' || o.key.startsWith(storage.BACKUP_PREFIX)) { ignored++; continue; }
      // Copy, never delete: an object already present is left exactly as it is.
      if (target.has(o.key)) { skipped++; continue; }
      const buf = await r2.getBuffer(BLOBS + o.key);
      if (!write) {
        console.log(`  would write ${o.key} (${human(buf.length)})`);
      } else {
        // Content type comes from the key's extension, not from the blob store.
        // Served uploads must keep a renderable type or browsers download them
        // instead of displaying them.
        await storage.s3Put(o.key, buf, storage.mimeForFilename(o.key));
      }
      done++; bytes += buf.length;
    }
    if (ignored) console.log(`ignored ${ignored} key(s) under ${storage.BACKUP_PREFIX} (backups live in R2, not here)`);
    console.log(`${write ? 'wrote' : 'would write'} ${done} object(s) (${human(bytes)}), ${skipped} already present in the media bucket`);
    if (!write) console.log('dry run -- re-run with --write to actually restore');
    return;
  }

  console.error('Nothing to do. Use --list, --show, --fetch or --restore-media.');
  process.exit(1);
}

main().catch((e) => {
  console.error('failed:', (e && e.message) || e);
  process.exit(1);
});
