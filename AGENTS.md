# AGENTS.md — Campfire contributor context

Read this file at the start of every session. It contains everything needed
to work on this project without prior conversation history.

## What this is

**Campfire** — a simple, single-container, self-hosted chat + voice app
(Mattermost / Steam-chat alternative). Users create "servers" (guilds),
share invite codes/links, chat in text channels, and talk in voice rooms.
Mobile-friendly PWA. Repo: `https://github.com/jreoka/campfire`.

## Stack & key decisions

- **Backend:** Node ≥22, Express 4, `ws` (WebSocket), `jsonwebtoken`, `bcryptjs`,
  `cookie-parser`. No build step, no native modules, no Redis/Postgres.
- **Database:** SQLite via Node's **built-in `node:sqlite`** (`db.js` wraps
  `DatabaseSync` in a small better-sqlite3-compatible API: `prepare().get/all/run`,
  `exec`, `transaction`). Chosen deliberately so `npm install` needs no build
  tools and the Docker image stays tiny. **Do not switch to better-sqlite3.**
- **Frontend:** vanilla HTML/CSS/JS in `public/` (`index.html`, `styles.css`,
  `js/*.js` modules loaded in order via plain script tags). No framework, no
  bundler. Served by Express static.
- **Realtime:** one WebSocket endpoint (`/ws?token=JWT`) handles live chat,
  typing indicators, presence, and WebRTC signaling.
- **Voice:** WebRTC **mesh (P2P)** — fine for 2–8 people, zero server CPU cost.
  STUN defaults to Google's public server; TURN configurable via env for
  strict NATs (`TURN_URL/USER/PASS` → `/api/config` → `iceServers`).
- **Auth:** username+password, JWT (30d) in `localStorage` + `Authorization: Bearer`.
  First user just signs up; no admin seeding needed.
- **PWA:** `manifest.webmanifest` + `service-worker.js` (app-shell cache).
  In-app install buttons were **deliberately removed** per owner request —
  install happens via the browser menu. Do not re-add them.
- **Windows app:** dedicated Tauri v2 wrapper in `app/` (WebView2, loads the
  live site). Tray icon, start-on-login, game detection. Not part of the
  Docker deploy — built and released via GitHub Actions.

## Project structure

```
campfire/
  server.js          # Express API + WebSocket server (chat, presence, voice signaling)
  db.js              # SQLite wrapper + schema (CREATE TABLE IF NOT EXISTS)
  package.json       # deps (express, ws, jsonwebtoken, bcryptjs, cookie-parser)
  Dockerfile         # node:22-alpine, no build tools needed
  docker-compose.yml # one service, ./data volume, requires JWT_SECRET in .env
  .env.example       # template (copy to .env)
  app/               # Windows Tauri app (Tauri v2, WebView2) — release-built on
                     # GitHub Actions, not in the Docker deploy
  scripts/gen-icons.js  # zero-dep PNG icon generator (runs in Docker build)
  scripts/gen-ico.js    # syncs app icon with the web favicon
  public/
    index.html       # SPA shell (auth view + main view + modals)
    styles.css       # flat professional dark UI (see design rules below)
    js/              # SPA modules (ordered classic scripts): core, auth, noise,
                     # servers, messages, socket, ui, voice, actions, rail, home,
                     # pins, compose, pickers, settings, security, final
    vendor/rnnoise/  # RNNoise wasm + worklet (mic noise suppression) vendored
    manifest.webmanifest
    service-worker.js   # bump CACHE ('campfire-vN') on every frontend change
    icons/           # generated PNGs (committed so static serving works w/o build)
  data/              # SQLite db lives here — NEVER delete, gitignored
```

## App (`./app`)

Native wrapper around the web app: Tauri v2 loading
`https://campfire.dill.moe`, so updates flow through the normal PWA
auto-update. Ships for **Windows, macOS, Linux, and Android** — one GitHub
Release holds every platform bundle (`.github/workflows/app-release.yml`;
trigger via `workflow_dispatch`, version auto-increments as
`app-v<ver>-<short-hash>`, or push a tag like `app-v0.2.0`).

Desktop (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux) has:
tray icon (open app / current game / start-on-login toggle / quit), autostart
(Task Scheduler / LaunchAgent / XDG entry; `--autostart` launch stays
tray-only), and game detection (sysinfo process polling matched against
Discord's detectable-games DB — Windows-only filter before, now per-OS:
win32 `.exe` / darwin `.app`-stripped / linux bare names — beaconed to
`POST /api/watcher/status` every ~10–30 s while a game runs). Detection is
richest on Windows (Discord's DB barely covers macOS/Linux). The Android app
is the full Campfire experience incl. voice (mic/camera runtime permissions
declared in the manifest); no tray/watcher on mobile — that Rust code is
`#[cfg(desktop)]`-gated, entry via `campfire_lib::run()` (`src/lib.rs`, thin
`src/main.rs` shim for desktop).

- **Icons:** `src-tauri/icons/` generated via `npx tauri icon
  public/icons/campfire-logo.png`, then `node scripts/gen-ico.js` so
  `icon.ico` stays identical to the web favicon (`public/favicon.ico`) —
  one source of truth.
- **Android signing:** upload keystore lives OUTSIDE the repo
  (`~/.campfire-android/`, back it up — losing it bricks updates for existing
  installs); base64 + passwords are the `ANDROID_KEY_*` GitHub secrets,
  `keystore.properties` is gitignored and written by CI. `gen/android/` (the
  Android project, incl. manifest permissions + release signing config) IS
  committed; its `build/` outputs are ignored.
- **No console window (Windows):** `main.rs` carries
  `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`
  so release builds are GUI-subsystem. Without it a terminal opens beside
  the app every launch.
- **Versioning:** semver in the release tag is stamped into
  `tauri.conf.json`/`Cargo.toml`/`package.json` at build time
  (`scripts/stamp-app-version.js`, no commit); Android's versionCode derives
  from it. `main` keeps a placeholder version.
- **Local builds:** `cd app && npm install && npm run build` → bundles under
  `src-tauri/target/release/bundle/` (+ portable binary). Android needs JDK
  17+, SDK + NDK r26, android Rust targets:
  `npx tauri android build --apk --target aarch64 --target armv7 --target x86_64`
  (signed only with a local `keystore.properties`; debug APKs need none).
- **Not signed:** Windows/macOS bundles are unsigned (SmartScreen warning /
  right-click → Open on macOS). Proper macOS dist needs an Apple cert + CI
  notarization. `app/README.md` has details.

## Design language (owner directive)

**Flat, polished, professional. Never "AI-coded" looking.** Refined dark-navy theme:
- Deep-navy surfaces (no gradients, no shadows — elevation is tonal steps).
  Hairline `--line` dividers; borderless tonal cards; pill buttons/chips/inputs;
  generous rounded corners; soft color-matched avatar glow.
- Indigo-blue primary (`--accent:#5b6cff`) with white text on filled buttons.
  Toast is an inverse snackbar. Indigo accent drives active states, mentions,
  links, and the FAB-style add-server button.
- Semantic colors only where they carry meaning: green (online/speaking/live),
  amber (away), red (danger/DND/muted). User-chosen colors (avatars, folders,
  banners) and user content stay as-is.
- **No emoji in UI chrome** (use SVG/text: `Invite`, `···`, `Mute`, `↩`, `⋯`).
  Exceptions, both user-driven content: message text/reactions, and the hover
  bar's most-used emoji. Toast copy is plain text, no emoji.

## Data-safety contract (owner directive)

The owner will iterate on features **without ever losing persistent data**.
- Code and data are separate: everything lives in `data/campfire.db`.
  Never `rm -rf data`, never delete the db, never write destructive one-offs
  without explicit confirmation.
- Schema changes must be **guarded migrations** (`CREATE TABLE IF NOT EXISTS`,
  `ALTER TABLE ... ADD COLUMN` only when the column is missing) so existing
  databases upgrade in place and fresh installs still work.
- Restarts/rebuilds must never wipe data. The `./data` Docker volume is permanent.

## Running it

```bash
cd campfire
npm install
cp .env.example .env   # set a long random JWT_SECRET
# dev (frontend edits apply on refresh, backend edits need restart):
JWT_SECRET=... PORT=3000 DB_PATH=./data/campfire.db node server.js
# prod:
docker compose up -d --build   # → http://host:3000
```

**Production requires HTTPS** (PWA install + microphone need secure context
except on localhost). Standard deploy: Caddy/Nginx/Traefik with TLS in front,
proxying `/` and upgrading `/ws`. See README for Caddy/Nginx snippets.

## Verification conventions

- `node --check <file>` after every JS edit.
- Smoke test API: `curl localhost:3000/api/config`, register/login flow.
- E2E (register → create server → invite-join → WS live message → history →
  channel create/delete → voice-join signaling) was verified passing; re-run an
  equivalent check after touching `server.js` or the WS protocol.
- **Bump `service-worker.js` CACHE version on any `public/` change** or clients
  keep stale cached shells.
- Static-only changes need no server restart (Express serves from disk).

## Environment notes (this dev machine)

- Windows + Git Bash. Each tool call is a fresh shell; `&`-backgrounded
  processes **persist** across calls. Logs to files (e.g. `/tmp/*.log`).
- Kill a stray server via `netstat -ano | grep :PORT` + `taskkill //PID <pid> //F`.
- `node` here is v26; Docker Desktop available (`docker build`/`docker run` verified).

## Current state

Live at https://campfire.dill.moe (DigitalOcean Ubuntu, Docker + Caddy
auto-HTTPS via `docker-compose.prod.yml`, UFW 22/80/443). Deploy: `git pull`
in /opt/campfire, `docker compose -f docker-compose.yml -f docker-compose.prod.yml
up -d --build`. Secrets live in server + local `.env` (never committed).

Shipped: auth, servers/invites, text channels, voice rooms (mesh WebRTC, sidebar
occupants + VAD rings), uploads, emoji (Emojibase set + custom + Klipy GIFs),
replies/threads/reactions/edits/mentions/markdown, presence + statuses, user
cards, tabbed settings, rail folders + DnD, B&W theme, ctx menus, auto-update,
TOTP 2FA + passkeys + sessions, notification inbox.
Detail per change lives in `git log` — don't duplicate it here.

## Deployment (owner directive)

**Every change must be deployed to the live production instance** — never stop
at local edits. Finish each task end-to-end: edit → verify → commit → push →
deploy → confirm the live site serves the change.
- Local repo commits to `origin/main` (`https://github.com/jreoka/campfire`).
- Production VPS is reachable via SSH key: `ssh root@campfire.dill.moe`, app lives
  in `/opt/campfire`. Deploy there with:
  `git pull` then `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`.
- After deploying, confirm the live site responds (e.g. `curl https://campfire.dill.moe/api/config`).

Non-obvious rules (learned the hard way): uploads must live next to the DB on
the persistent volume (never the image layer); new uploads get `?v=` cache keys;
missing `/uploads/*` must 404 (never SPA fallback); bump the SW `CACHE` version
on every `public/` change; navigations are network-first.

NEXT: iterate per owner feedback on the live site.
- Open ideas (not requested yet): DMs, push notifications, moderation roles
  beyond owner. (File/image sharing + custom emoji/GIFs already shipped.)
