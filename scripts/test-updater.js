// Pins the desktop auto-updater wiring: plugin registration, the background
// check loop, the tray item, the tauri.conf.json updater config, the signed
// release workflow, and the latest.json manifest generator.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name); }
}

const libSrc = read('app/src-tauri/src/lib.rs');
const cargo = read('app/src-tauri/Cargo.toml');
const conf = JSON.parse(read('app/src-tauri/tauri.conf.json'));
const workflow = read('.github/workflows/app-release.yml');

// --- Rust: plugins registered (desktop only) ---
ok(libSrc.includes('.plugin(tauri_plugin_updater::Builder::new().build())'),
  'updater plugin is registered');
ok(libSrc.includes('.plugin(tauri_plugin_dialog::init())'),
  'dialog plugin is registered');
// The registrations sit in the #[cfg(desktop)] builder chain, after the
// notification plugin and before .manage — never in the mobile build.
ok(/\.plugin\(tauri_plugin_notification::init\(\)\)[\s\S]{0,600}\.plugin\(tauri_plugin_updater::Builder::new\(\)\.build\(\)\)/.test(libSrc),
  'updater registration is in the desktop builder chain');

// --- Rust: background checker ---
ok(libSrc.includes('fn spawn_update_checker(app: &AppHandle)'),
  'spawn_update_checker exists');
ok(libSrc.includes('spawn_update_checker(&app);'),
  'setup spawns the update checker');
ok(/std::thread::sleep\(std::time::Duration::from_secs\(30\)\)[\s\S]{0,200}let mut offered/.test(libSrc),
  'checker waits ~30s after launch before the first check');
ok(libSrc.includes('6 * 3600'), 'checker re-checks every six hours');
ok(libSrc.includes('tauri_plugin_updater::UpdaterExt'), 'checker uses UpdaterExt');
ok(libSrc.includes('.updater()'), 'checker builds an updater from the app handle');
ok(libSrc.includes('.check()'), 'checker checks the release manifest');
ok(libSrc.includes('update.download('), 'checker downloads before prompting');
ok(libSrc.includes('update.install(bytes)'), 'checker installs the downloaded bytes');
ok(libSrc.includes('app.restart()'), 'checker restarts into the installed update');
ok(libSrc.includes('MessageDialogButtons::OkCancelCustom'),
  'prompt offers Restart now / Later');
ok(libSrc.includes('blocking_show()'), 'prompt uses a blocking native dialog');
ok(libSrc.includes('already offered this version this session'),
  'checker does not re-offer the same version in one session');

// --- Rust: tray "Check for updates" ---
ok(libSrc.includes('"check_updates", "Check for updates"'),
  'tray menu has a Check for updates item');
ok(/let items: \[&dyn IsMenuItem<R>; 8\]/.test(libSrc),
  'tray menu item count updated for the new item');
ok(libSrc.includes('"check_updates" =>'), 'tray menu event handles check_updates');

// --- Cargo: desktop-only deps ---
const desktopDeps = cargo.split('[target.\'cfg(not(any(target_os = "android", target_os = "ios")))\'.dependencies]')[1] || '';
ok(desktopDeps.includes('tauri-plugin-updater = "2"'),
  'tauri-plugin-updater is a desktop-only dependency');
ok(desktopDeps.includes('tauri-plugin-dialog = "2"'),
  'tauri-plugin-dialog is a desktop-only dependency');
const commonDeps = cargo.split('[target.')[0];
ok(!commonDeps.includes('tauri-plugin-updater'),
  'updater is not in the common (mobile) dependencies');

// --- tauri.conf.json: updater config ---
const u = conf.plugins && conf.plugins.updater;
ok(!!u, 'tauri.conf.json has plugins.updater');
ok(u && u.active === true, 'updater is active');
ok(u && u.dialog === false, 'built-in JS updater dialog is off (Rust owns the UX)');
ok(u && u.endpoints && u.endpoints.some((e) => e.includes('releases/latest/download/latest.json')),
  'endpoint points at the GitHub release manifest');
ok(u && typeof u.pubkey === 'string' && u.pubkey.length > 50 && !/YOUR_|PLACEHOLDER/i.test(u.pubkey),
  'pubkey is a real key, not a placeholder');
ok(u && u.windows && u.windows.installMode === 'passive',
  'Windows updates install passively (no installer wizard)');

// --- workflow: signing + signed artifacts + manifest ---
const signingEnvs = (workflow.match(/TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/g) || []).length;
ok(signingEnvs === 3, 'signing key is passed to all three desktop builds (found ' + signingEnvs + ')');
ok(workflow.includes('bundle/nsis/*.exe.sig'), 'windows uploads the NSIS signature');
ok(workflow.includes('bundle/macos/*.tar.gz*'), 'macos uploads the updater tarball + signature');
ok(workflow.includes('bundle/appimage/*.AppImage.sig'), 'linux uploads the AppImage signature');
ok(workflow.includes('actions/checkout@v4\n      - uses: actions/download-artifact@v4'),
  'release job checks out the repo (for the manifest script)');
ok(workflow.includes('scripts/gen-updater-json.js'), 'release job builds latest.json');
ok(/files: \|[\s\S]*?latest\.json/.test(workflow), 'latest.json is published on the release');

// --- gen-updater-json.js: fixture test ---
(function fixtureTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-fixture-'));
  const tag = 'app-v9.9.9-deadbee';
  const files = {
    'campfire-windows/nsis/deep/Campfire_9.9.9_x64-setup.exe': 'fake-exe',
    'campfire-macos/macos/Campfire_9.9.9_aarch64.app.tar.gz': 'fake-tgz',
    'campfire-linux/appimage/campfire_9.9.9_amd64.AppImage': 'fake-appimage',
  };
  const sigs = {};
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
    const sig = 'SIG-FOR-' + path.basename(full);
    fs.writeFileSync(full + '.sig', sig + '\n');
    sigs[path.basename(full)] = sig;
  }
  const out = execFileSync('node', [
    path.join(ROOT, 'scripts/gen-updater-json.js'),
    '--version', '9.9.9', '--tag', tag, '--bundles', dir, '--notes', 'notes here',
  ], { encoding: 'utf8' });
  const m = JSON.parse(out);
  ok(m.version === '9.9.9', 'manifest carries the release version');
  ok(m.notes === 'notes here', 'manifest carries the notes');
  ok(typeof m.pub_date === 'string' && !isNaN(Date.parse(m.pub_date)), 'manifest has a pub_date');
  const plats = Object.keys(m.platforms).sort();
  ok(JSON.stringify(plats) === JSON.stringify(['darwin-aarch64', 'linux-x86_64', 'windows-x86_64']),
    'manifest has all three desktop platforms');
  ok(m.platforms['windows-x86_64'].signature === sigs['Campfire_9.9.9_x64-setup.exe'],
    'windows signature matches the .sig file');
  ok(m.platforms['darwin-aarch64'].signature === sigs['Campfire_9.9.9_aarch64.app.tar.gz'],
    'macos signature matches the .sig file');
  ok(m.platforms['linux-x86_64'].signature === sigs['campfire_9.9.9_amd64.AppImage'],
    'linux signature matches the .sig file');
  for (const p of plats) {
    ok(m.platforms[p].url.startsWith('https://github.com/jreoka/campfire/releases/download/' + tag + '/'),
      'platform ' + p + ' url points at the release tag');
  }
  // Missing signature must fail loudly, not publish a broken manifest.
  fs.unlinkSync(path.join(dir, 'campfire-linux/appimage/campfire_9.9.9_amd64.AppImage.sig'));
  let failed = false;
  try {
    execFileSync('node', [
      path.join(ROOT, 'scripts/gen-updater-json.js'),
      '--version', '9.9.9', '--tag', tag, '--bundles', dir,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { failed = true; }
  ok(failed, 'manifest generation fails when a signature is missing');
  fs.rmSync(dir, { recursive: true, force: true });
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
