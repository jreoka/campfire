// Stamps the release version into the Tauri app manifests at CI build time
// (no commit — avoids push loops). Usage: node scripts/stamp-app-version.js X.Y.Z
// The Android versionCode derives from this semver automatically
// (major*1000000 + minor*1000 + patch), so it must stay valid semver.
const fs = require('fs');

const v = process.argv[2];
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(v || '')) {
  console.error('usage: node scripts/stamp-app-version.js X.Y.Z');
  process.exit(1);
}

const confPath = 'app/src-tauri/tauri.conf.json';
const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
conf.version = v;
fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');

const cargoPath = 'app/src-tauri/Cargo.toml';
const cargo = fs.readFileSync(cargoPath, 'utf8').replace(/^version = ".*"/m, `version = "${v}"`);
fs.writeFileSync(cargoPath, cargo);

const pkgPath = 'app/package.json';
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = v;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

console.log(`stamped app version ${v}`);
