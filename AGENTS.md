# AGENTS.md — Campfire contributor context

Read this file at the start of every session. It contains everything needed
to work on this project without prior conversation history.

## What this is

**Campfire** — a simple, single-container, self-hosted chat + voice app
(Mattermost / Steam-chat alternative). Users create "servers" (guilds),
share invite codes/links, chat in text channels, and talk in voice rooms.
Mobile-friendly PWA. Repo: `https://github.com/jreoka/campfire`.

## Stack & key decisions

- **Backend:** Node ≥22, Express 4 (+ `express-async-errors`: Express 4 drops
  async handler rejections, so this forwards them), `ws` (WebSocket),
  `jsonwebtoken`, `bcryptjs`, `cookie-parser`, `pg` (async Postgres driver).
  No build step, no native modules, no Redis/Postgres-embedded.
- **Database:** Postgres 18 (Docker `db` service, `pgdata` volume).
  `db.js` wraps `node-postgres` in an async `prepare().get/all/run` +
  `exec` + `transaction` API supporting both `?` and `@name` placeholders
  (`@name` is translated to `$n`; quoted literals are left alone).
  Transactions pin one pooled connection via AsyncLocalStorage, so existing
  `db.transaction(async () => {...})` bodies stay atomic. Former INTEGER
  columns are BIGINT (parsed back to JS numbers); 0/1 flag columns stay
  ints so `=== 0` checks keep working. `COLLATE NOCASE` is gone — use
  `lower(x)` comparisons/ordering instead.
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
  server.js          # Express API + WebSocket server (all async; chat, presence, voice signaling)
  db.js              # Postgres wrapper + schema (initDb: CREATE TABLE IF NOT EXISTS + guarded migrations)
  unfurl.js          # link previews: server-side OpenGraph/oEmbed unfurl, SSRF-guarded fetch,
                     # Postgres cache, signed thumbnail proxy (/api/unfurl, /api/unfurl/img)
  virus-scan.js      # ClamAV scanning + gated serving (+ inline media compression per upload)
  media-compress.js  # ffmpeg re-encode of over-large media: single-pass in the scan slot,
                     # plus the sweeper that drains anything the pipeline missed
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
    embeds.js        # link embeds: known providers client-side, generic link cards via /api/unfurl
    js/              # SPA modules (ordered classic scripts): core, auth, noise,
                     # servers, messages, socket, ui, voice, actions, rail, home,
                     # pins, compose, stories, viewonce, pickers, settings,
                     # security, final
    vendor/rnnoise/  # RNNoise wasm + worklet (mic noise suppression) vendored
    manifest.webmanifest
    service-worker.js   # bump CACHE ('campfire-vN') on every frontend change
    icons/           # generated PNGs (committed so static serving works w/o build)
  data/              # local uploads live here — NEVER delete, gitignored
                   # (the database itself is in the pgdata Docker volume)
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

- **Icons:** `public/icons/campfire-logo.png` is the single source of truth,
  rendered from the in-app animated fire's vectors via `node
  scripts/render-logo.js` (also writes `favicon-32.png` + `favicon.ico`).
  `src-tauri/icons/` generated via `npx tauri icon
  public/icons/campfire-logo.png`, then `node scripts/gen-ico.js` so
  `icon.ico` stays identical to the web favicon (`public/favicon.ico`) —
  one source of truth. Then `node scripts/gen-android-icons.js` to re-derive
  the APK launcher foregrounds zoomed out to the adaptive-icon safe zone
  (`tauri icon` emits them full-bleed, so the launcher circle clips the mark).
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
- Code and data are separate: Postgres data lives in the `pgdata` Docker
  volume, uploads in `./data`. Never `rm -rf data`, never drop the
  database, never write destructive one-offs without explicit confirmation.
  Nightly `pg_dump` snapshots also land in S3 `backups/` (see README §5).
- Schema changes must be **guarded migrations** (`CREATE TABLE IF NOT EXISTS`,
  `ALTER TABLE ... ADD COLUMN` only when the column is missing — see
  `columnExists`/`addColumn` in `db.js`) so existing databases upgrade in
  place and fresh installs still work.
- Restarts/rebuilds must never wipe data. The `pgdata` + `./data` Docker
  volumes are permanent (`docker compose down -v` destroys the db — never
  run that in production).

## Running it

```bash
cd campfire
npm install
cp .env.example .env   # set JWT_SECRET + POSTGRES_PASSWORD (alphanumeric)
# dev (frontend edits apply on refresh, backend edits need restart):
docker compose up -d db   # Postgres 18 on localhost:5432
JWT_SECRET=... PGHOST=localhost PGUSER=campfire PGPASSWORD=... PGDATABASE=campfire PORT=3000 node server.js
# prod:
docker compose up -d --build   # → http://host:3000
```

**Production requires HTTPS** (PWA install + microphone need secure context
except on localhost). Standard deploy: Caddy/Nginx/Traefik with TLS in front,
proxying `/` and upgrading `/ws`. See README for Caddy/Nginx snippets.

## Verification conventions

- **`node --check <file>` after every JS edit.**
- **Tests:** `node scripts/test-unfurl.js [--live]` covers the link-preview parser
  and the SSRF guard (offline by default; `--live` also fetches real pages and
  proves a 302 to a link-local address is refused).
  `node scripts/test-stories.js` covers stories end-to-end against the dev
  server (audiences, view receipts, delete, 24h reaper) and restarts the dev
  server for the boot-reaper check. It expects the dev Postgres and a
  `JWT_SECRET`-equivalent `.env` (see Running it).
  `node scripts/test-viewonce.js` covers view-once messages against the same
dev server: the media gate (unsigned/tampered tickets), per-friend DMs, the
  one-replay lifecycle, and that unopened items never expire.
- **Upload pipeline E2E:** `node scripts/test-upload-pipeline.js` (needs ffmpeg
  + the dev Postgres, skips otherwise) boots a real server against a throwaway
  database with a fake clamd and asserts the single-transition compression flow
  for both the scan-integrated path and the sweeper fallback. Re-run it after
  touching `virus-scan.js`, `media-compress.js`, or the upload routes.
- Smoke test API: `curl localhost:3000/api/config`, register/login flow.
- E2E (register → create server → invite-join → WS live message → history →
  channel create/delete → voice-join signaling) was verified passing; re-run an
  equivalent check after touching `server.js` or the WS protocol.
- **Bump `service-worker.js` CACHE version on any `public/` change** or clients
  keep stale cached shells.
- Static-only changes need no server restart (Express serves from disk).

## Upload pipeline hazards (learned the hard way)

Background workers touch the same uploaded bytes, so ordering and atomicity
are load-bearing:

- **`child_process.execFile` defaults to `encoding: 'utf8'`.** Decoding raw RGB
  frames as UTF-8 silently corrupts them (measured: 686180 "chars" instead of
  786432 bytes). Always pass `encoding: 'buffer'` for binary stdout —
  `execFileSync` defaults to buffer, which is why the sync path in the tests
  never showed the bug.
- **Never rewrite an upload in place.** `media-compress.replaceBytes` writes a
  sibling temp file and `rename()`s over the target. `copyFile()` exposes a torn
  file to clamd and to HTTP at the same time.
- **S3 mode buffers uploads in memory** (`multer.memoryStorage`) before the
  bucket PUT, so `MAX_FILE_MB` (default 200) is also a per-upload RAM budget on
  the box. Scanning and compression stream; multer does not. The composer reads
  the cap from `/api/config` (`maxUploadMb`) — never hardcode it in `public/`.
- **Bucket keys are top-level** (`files/`, `avatars/`, `banners/`, `emoji/`,
  `icons/`, `sidebar/`) — there is no shared `uploads/` prefix, so anything
  listing the bucket must list `''` and skip `backups/` explicitly (DB dumps;
  never served, never swept). `storage.storageStats()` powers the admin Media
  tab's Storage card (`/api/admin/media/storage`, 10-min cache, `?refresh=1` to
  force); the sweep has a `?dry=1` mode that reports victims without deleting.
- **Compression is scan -> compress -> scan, and only the last verdict gets
  published.** On a clean verdict the `virus-scan` slot compresses the file
  itself (`processMedia` -> `media-compress.processUpload`), streams the
  candidate output into clamd (a local temp file — never re-downloaded), and
  only commits it once that verdict is clean. So clients see exactly one
  `pending -> final` transition and a playing file is never swapped out from
  under a running player. `media-compress`'s sweeper is the fallback for
  anything the pipeline missed (scanning off/unavailable, the pre-existing
  backlog, a failed candidate scan) and still re-queues `virus-scan` after
  rewriting. Never hand unscanned bytes to ffmpeg or publish unscanned output.
- **One ffmpeg at a time, process-wide.** The sweeper and the scan pipeline
  share `withCompressLock`/the `inflight` key set; the sweeper skips keys with a
  pass in flight and `virus-scan`'s `reapStuckClaims` leaves a claim alone while
  `media-compress.isCompressing(key)` is true (a slot parked in a long encode is
  not a stuck slot).
- Scan keys are the storage key (`files/<hex>.png`), derived from the URL — NOT
  the `attachments.id` uid. They are not interchangeable.
- The virus serving gate only covers `files/` (chat attachments); profile media
  (avatars, banners, emoji, icons) is scanned but not gated.

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
TOTP 2FA + passkeys + sessions, notification inbox, link previews (server-side
OpenGraph/oEmbed unfurl → cached card with thumbnail, SSRF-guarded), stories
(24h photo/video posts with an in-app camera, friend + server + everyone
audiences, thumbnails cropped into the rings), view-once messages (one view +
one replay, per-friend DMs, media gated until opened and deleted after use).
A story sent to an individual friend is delivered as a view-once DM instead of
a tray entry (`POST /api/dm/viewonce` with `storyId` re-files the story's bytes
under the gated `viewonce/` prefix), and picks alongside a broadcast audience
get both.
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

Non-obvious rules (learned the hard way): uploads must live on the
persistent volume (never the image layer); new uploads get `?v=` cache keys;
missing `/uploads/*` must 404 (never SPA fallback); bump the SW `CACHE` version
on every `public/` change; navigations are network-first. Presence is
server-scoped **and** friend-scoped: a friend with no shared server would
otherwise look permanently offline (see `notifyFriends`/`presenceForUsers` in
`server.js`) — any new presence surface must respect both. View-once media
lives under `viewonce/` (never `files/`): that prefix is served only with a
signed ticket from `POST /api/dm/:mid/viewonce/open` (a story sent to an
individual friend is copied into `viewonce/` for the same gate), so nothing can
fetch it before the recipient opens the message. Async discipline:
never pass an async callback to map/filter/forEach when results are used
synchronously (use for..of or Promise.all); background timers go through
safeInterval so rejections log instead of crashing.

NEXT: iterate per owner feedback on the live site.

## Illegal content

There is **no automated illegal-content detection in this build**. Hash matching
(`csam-scan.js`/`pdq.js`, Admin → Safety) was removed on the owner's request; it
is in `git log` if it ever needs to come back (the `csam_*` tables and the
users.locked_at column are intentionally left in existing databases rather than
dropped).

If illegal material turns up on an instance anyway, the operator's duties are
their own: providers that obtain actual knowledge of CSAM must report it (in the
US, the NCMEC CyberTipline — 18 U.S.C. § 2258A) and preserve the material.
Preserving evidence by hand means copying the file somewhere off the served
tree before deleting the message. Do not re-add automated matching without the
same care the old code took: never preview suspected material in an admin UI,
and keep any hash list out of `./data`.

- Open ideas (not requested yet): DMs, push notifications, moderation roles
  beyond owner. (File/image sharing + custom emoji/GIFs already shipped.)
