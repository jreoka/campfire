# Campfire app (Windows, macOS, Linux, Android)

Native wrapper around the Campfire web app. Built with **Tauri v2**:

- **WebView** loads `https://campfire.dill.moe` (the real app; updates flow
  through the normal PWA auto-update).
- **Desktop** (Windows/macOS/Linux) — WebView2 on Windows (preinstalled),
  WKWebView on macOS (built in), WebKitGTK on Linux:
  - **Tray icon** — left-click toggles the window open/closed (right-click menu:
    open app, current game, start-on-login toggle, quit). On GNOME there is no
    system tray by default (needs an extension); KDE and others are fine.
  - **Start on login** — Task Scheduler entry on Windows, LaunchAgent on macOS,
    XDG autostart entry on Linux; `--autostart` launches stay tray-only.
  - **Game detection** — polls running process names (sysinfo) and matches them
    against Discord's public detectable-games DB
    (`https://discord.com/api/v10/applications/detectable`, fetched once, cached
    in the app data dir, refreshed every 7 days). Foldered DB entries require a
    full-path match and shared bare exe names are discounted, so generic
    runtimes/tools (`gh.exe`, `java.exe`) never hallucinate games that aren't
    installed. While a game is detected it
    beacons `{game, ts}` to `POST /api/watcher/status` every ~10–30 s; the server
    sets your "Playing …" state and logs playtime for levels/streaks shown on
    profiles. Richest on Windows — Discord's DB has ~11k Windows entries but
    only a few dozen macOS ones and a handful for Linux, so detection outside
    Windows is best-effort.
- **Android** — same web app in a native shell (full Campfire experience
  including voice; no tray/watcher/autostart — mobile has none). Needs
  Android 7+. Microphone/camera permissions are requested in-app when voice
  or video calls run.

## Requirements

- Node 22+ and a Rust toolchain (stable) for building
- Linux builds additionally need WebKitGTK + friends:
  `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`
- Android builds need a JDK 17+, the Android SDK (+ NDK r26), and the
  `aarch64-linux-android`, `armv7-linux-androideabi`, `x86_64-linux-android`
  Rust targets. Copy `app/src-tauri/gen/android/keystore.properties` handling
  from `.github/workflows/app-release.yml` for signed local builds; unsigned
  `assembleDebug` APKs work without any key.

## Build

```bash
cd app
npm install
npm run build            # desktop bundle for the current OS
npx tauri android build --apk   # signed APK (needs keystore.properties, see above)
```

Desktop outputs land under `src-tauri/target/release/bundle/` (`nsis`/`msi` on
Windows, `dmg` on macOS, `deb`/`AppImage` on Linux) plus a portable binary at
`src-tauri/target/release/campfire[.exe]`. The Android APK lands at
`src-tauri/gen/android/app/build/outputs/apk/universal/release/`.

## Releases

`.github/workflows/app-release.yml` builds all four platforms and publishes
every bundle to one GitHub Release. Trigger manually via workflow_dispatch —
the version auto-increments from the latest `app-v*` tag (pick patch/minor/major,
or pass an explicit version) and the release is tagged `app-v<version>-<short-hash>`
(e.g. `app-v0.2.0-a3f9c2`) so every build is pinned to its commit — or push a
tag like `app-v0.2.0` to release that exact version. The semver in the tag is
stamped into `tauri.conf.json`/`Cargo.toml`/`package.json` at build time (Android's
versionCode derives from it); `main` keeps a placeholder version.

## Signing

- Windows and macOS builds are **not code-signed** (no certificates configured):
  expect a SmartScreen warning on Windows and a right-click → Open on first
  macOS launch. Proper macOS distribution needs an Apple Developer cert ($99/yr)
  + notarization wired into CI.
- Android APKs **are signed** with the project's upload keystore. The keystore
  itself lives outside the repo (`~/.campfire-android/` on the dev machine —
  **back it up**; losing it means existing installs can't update in place) and
  its base64 + passwords are GitHub secrets (`ANDROID_KEY_BASE64`,
  `ANDROID_KEY_PASSWORD`, `ANDROID_KEY_ALIAS`). `keystore.properties` is
  gitignored and written by CI at release time.

## Icons

`src-tauri/icons/` is generated from `public/icons/campfire-logo.png` via
`npx tauri icon <png>` (gives `icon.icns`, PNGs, `icon.ico`). Afterwards re-run
`node scripts/gen-ico.js` so `icon.ico` stays byte-identical to the web favicon
(`public/favicon.ico`) — one source of truth — and re-run
`node scripts/gen-android-icons.js` from the repo root so the APK launcher
icons are re-derived zoomed out to the adaptive-icon safe zone (`tauri icon`
emits the foregrounds full-bleed, which the launcher circle clips).

## Notes

- Game detection needs you signed in on the app window (the watcher reads the
  `cf_token` from the webview's localStorage and authenticates its beacons).
- Non-Steam launchers/UWP games may be missed (process-name matching); the
  Discord DB covers most installed titles on Windows.
