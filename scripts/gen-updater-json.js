// Builds the Tauri updater manifest (latest.json) from the release artifacts.
//
// Usage:
//   node scripts/gen-updater-json.js --version 0.3.14 --tag app-v0.3.14-abcdef \
//       --bundles bundles [--notes "..."] > latest.json
//
// The `bundles` dir is where the release job downloads the per-platform
// artifacts (bundles/campfire-windows, bundles/campfire-macos,
// bundles/campfire-linux). Each platform needs its updater payload plus the
// .sig file the Tauri CLI generated during the signed build:
//
//   windows-x86_64 -> *-setup.exe (+ .sig)        NSIS installer
//   darwin-aarch64  -> *.app.tar.gz (+ .sig)      macOS app bundle tarball
//   linux-x86_64    -> *.AppImage (+ .sig)        AppImage
//
// The portable campfire.exe, the MSI, the DMG and the DEB are NOT updater
// payloads: the updater only knows how to install the three above. Any
// missing payload or signature is a hard failure — a release must never
// publish a latest.json that points at files that don't exist.
'use strict';

const fs = require('fs');
const path = require('path');

function fail(msg) {
  console.error('gen-updater-json: ' + msg);
  process.exit(1);
}

function walk(dir, out) {
  out = out || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// Find the updater payload for one platform: the first file matching `match`
// that is not itself a .sig, plus its adjacent .sig file.
function findPayload(root, label, match) {
  if (!fs.existsSync(root)) fail('missing artifact dir for ' + label + ': ' + root);
  const files = walk(root);
  const payload = files.find((f) => match(f) && !f.endsWith('.sig'));
  if (!payload) fail('no updater payload for ' + label + ' under ' + root);
  const sigPath = payload + '.sig';
  if (!fs.existsSync(sigPath)) fail('missing signature for ' + label + ': ' + sigPath);
  const signature = fs.readFileSync(sigPath, 'utf8').trim();
  if (!signature) fail('empty signature for ' + label + ': ' + sigPath);
  return { file: path.basename(payload), signature };
}

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    out[key] = argv[i + 1];
  }
  return out;
}

const { version, tag, bundles, notes } = args();
if (!version) fail('--version is required');
if (!tag) fail('--tag is required');
if (!bundles) fail('--bundles is required');

const base = 'https://github.com/jreoka/campfire/releases/download/' + tag + '/';
const url = (file) => base + encodeURIComponent(file);

const win = findPayload(path.join(bundles, 'campfire-windows'), 'windows-x86_64', (f) =>
  f.endsWith('-setup.exe'),
);
const mac = findPayload(path.join(bundles, 'campfire-macos'), 'darwin-aarch64', (f) =>
  f.endsWith('.app.tar.gz'),
);
const lin = findPayload(path.join(bundles, 'campfire-linux'), 'linux-x86_64', (f) =>
  f.endsWith('.AppImage'),
);

const manifest = {
  version,
  notes: notes || '',
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': { signature: win.signature, url: url(win.file) },
    'darwin-aarch64': { signature: mac.signature, url: url(mac.file) },
    'linux-x86_64': { signature: lin.signature, url: url(lin.file) },
  },
};

console.log(JSON.stringify(manifest, null, 2));
