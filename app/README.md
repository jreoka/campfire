# Campfire desktop app (Windows)

Native Windows wrapper around the Campfire web app. Built with **Tauri v2**
(WebView2 — no bundled Chromium):

- **WebView** loads `https://campfire.dill.moe` (the real app; updates flow
  through the normal PWA auto-update).
- **Tray icon** — left-click toggles the window open/closed (right-click menu:
  open app, current game, start-on-login toggle, quit).
- **Start on login** — Task Scheduler entry via `tauri-plugin-autostart`;
  when launched from autostart the window stays hidden (tray only).
- **Game detection** — polls running process names (sysinfo) and matches them
  against Discord's public detectable-games DB
  (`https://discord.com/api/v10/applications/detectable`, fetched once, cached
  in the app data dir, refreshed every 7 days). While a game is detected it
  beacons `{game, ts}` to `POST /api/watcher/status` every ~10–30 s; the server
  sets your "Playing …" state and logs playtime for levels/streaks shown on
  profiles.

## Requirements

- Windows 10/11 with WebView2 (preinstalled on current systems)
- Node 22+ and a Rust toolchain (stable) for building

## Build

```bash
cd app
npm install
npm run build
```

Outputs:

- `src-tauri/target/release/bundle/nsis/Campfire_0.1.0_x64-setup.exe` — installer
- `src-tauri/target/release/bundle/msi/Campfire_0.1.0_x64_en-US.msi`
- `src-tauri/target/release/campfire.exe` — portable single exe

## Releases

`.github/workflows/app-windows.yml` builds on a GitHub Actions Windows runner
and publishes the bundles to a GitHub Release.
Trigger manually via workflow_dispatch — the version auto-increments from the
latest `app-v*` tag (pick patch/minor/major, or pass an explicit version) and
the release is tagged `app-v<version>-<short-hash>` (e.g. `app-v0.1.3-a3f9c2`)
so every build is pinned to its commit —
or push a tag like `app-v0.1.0` to release that exact version.

## Notes

- The installer is **not code-signed** (no certificate configured); Windows
  SmartScreen will show a warning on first run.
- Game detection needs you signed in on the app window (the watcher reads the
  `cf_token` from the webview's localStorage and authenticates its beacons).
- Non-Steam launchers/UWP games may be missed (process-name matching); the
  Discord DB covers most installed titles.
