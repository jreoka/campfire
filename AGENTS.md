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
  clamav.js           # the ClamAV daemon client: the clamd wire protocol over TCP
                     # (VERSION/PING/INSTREAM), streaming scans, and the startup
                     # probe (engine identity + EICAR detection)
  virus-scan.js      # ClamAV-backed scanning + gated serving, the engine
                     # GENERATION every verdict is recorded against, and the
                     # scan -> compress -> scan slot (+ inline media compression)
  bucket-scan.js     # whole-bucket malware sweep: adopts stored objects the
                     # engine generation running now has not judged and feeds
                     # them to the scan queue (ungated, so it can only ever
                     # remove malware)
  media-compress.js  # ffmpeg re-encode of over-large media: single-pass in the scan slot,
                     # the flag-driven queue (chat/DM/stories), the bucket reconciler
                     # (profile media + anything the flags never saw), and the key ledger
  image-size.js      # intrinsic size from an image's own header (JPEG/PNG/GIF/WebP/BMP)
  att-dims.js        # backfill measuring media posted before the shape record existed
                     # (newest-first, bounded per tick, leader-locked)
  package.json       # deps (express, ws, jsonwebtoken, bcryptjs, cookie-parser)
  Dockerfile         # node:22-alpine; the scanner is a CONTAINER (compose
                     # `clamav`), not something built or installed here
  scripts/fake-clamd.js    # stand-in clamd (real wire protocol, in-process):
                     # the pipeline/browser tests' scanner
  scripts/verify-clamav.js # acceptance check against the REAL daemon/container
  scripts/test-virus-scan.js # offline unit tests for the scan module
  docker-compose.yml # db + clamav + campfire, ./data + clamdb volumes,
                     # requires JWT_SECRET in .env
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
                     # pins, compose, story-edit, stories, viewonce, pickers,
                     # settings, security, final, native (the native shell: back
                     # navigation, edge-swipe, press feedback — see below)
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
tray icon (open app / current game / start-on-login toggle / start-minimized
toggle / quit), autostart (Task Scheduler / LaunchAgent / XDG entry; the entry
passes `--autostart`, and such a launch stays tray-only while "Start minimized"
is on — the pref lives in `settings.json` in the app data dir), an unread-dot
badge (tray icon corner + Windows taskbar overlay + macOS dock badge, fed by the
site's `paintNotifBadge` through `set_unread_count`), and game detection
(sysinfo process polling matched against
Discord's detectable-games DB — Windows-only filter before, now per-OS:
win32 `.exe` / darwin `.app`-stripped / linux bare names — beaconed to
`POST /api/watcher/status` every ~10–30 s while a game runs). Detection is
richest on Windows (Discord's DB barely covers macOS/Linux). The Android app
is the full Campfire experience incl. voice (mic/camera runtime permissions
declared in the manifest); no tray/watcher on mobile — that Rust code is
`#[cfg(desktop)]`-gated, entry via `campfire_lib::run()` (`src/lib.rs`, thin
`src/main.rs` shim for desktop).

- **Frontend bridge:** the webview loads the remote site, so the site only sees
  `window.__TAURI__` when `app.withGlobalTauri` is true, and Tauri refuses
  remote-origin access to the app's own commands unless
  `capabilities/default.json` grants their permission. Both halves were missing
  until now, which silently killed every `invoke()` in `public/` (start-on-login,
  external links, Go Live game picker). App-command permissions are autogenerated
  by `build.rs`'s `AppManifest::commands` list (`permissions/autogenerated/`,
  committed) and granted by identifier (`allow-set-unread-count`) in the
  capability. Adding an app command means adding it to `build.rs`, the
  capability, and the frontend caller's `.catch(() => {})`.

- **Notifications:** one payload per notification, built by the server
  (`pushToUser`), delivered three ways: Web Push in a browser, a native push
  socket (`/ws/push`) for the Android app, and the page's own `notify` command on
  desktop — no desktop WebView implements the Notification API. The socket
  fan-out runs BEFORE the `userVisible` gate (web push keeps it via
  `{ webPush: !(await userVisible(uid)) }`; a phone in a pocket must still ring)
  and is NOT a chat session: never in `live_sessions`, so the phone stays offline
  in presence and the socket's own visibility report is the only suppression —
  and it is a **lease** (`VISIBILITY_TTL_MS`, 75s), not a latch, because a latch
  is only as reliable as the single frame that set it: lose the matching
  `visible:false` and that device's notifications are skipped forever, silently.
  The shell re-asserts its window state every ~25s
  (`PushService.VISIBILITY_EVERY_MS`) to keep the lease alive. Beware the
  reconnect trap in `PushService.connect()`: it cancels the socket it replaces
  and OkHttp reports a cancelled call as `onFailure`, so an unguarded listener
  reconnects three seconds later, forever — a listener that may only reconnect
  for the connection generation it was opened with. `/ws`
  and `/ws/push` share ONE `server.on('upgrade')` dispatcher — ws's `path` option
  aborts the other path with a 400. Android is `gen/android/.../PushService.kt`
  (OkHttp socket + notifications, `stopWithTask="false"`,
  `foregroundServiceType="specialUse"` — dataSync is capped at 6h/day on Android
  15), driven by the `CampfireNative` JS interface (`PushBridge.kt`, installed in
  `MainActivity.onWebViewCreate`) from `public/js/final.js`; a tapped
  notification parks its url on the activity and `window.__cfDeepLink` routes it
  through `handleDeepLinkQuery` (auth.js).

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
- **The message list has one rhythm, and it is measured**: within a group every
  line is `.35rem` from the one above it (`.msg.grouped`'s own padding plus the
  list's flex gap), and a new group clears the previous group by the head row's
  `.45rem` padding. The group's FIRST follow-up used to be the exception (11.2px
  while the rest were 5.6px, reported) — it is pulled up by the head's padding
  minus the follow-up's (`.msg:not(.grouped) + .msg.grouped{margin-top:-.35rem}`),
  a padding-only number so `#thread-replies` (which groups replies too and has no
  flex gap) lands right as well. The head's own box is deliberately NOT reshaped:
  its padding is also its hover pill. `scripts/test-msg-group-gap.js` measures
  both containers at both breakpoints.

## Data-safety contract (owner directive)

The owner will iterate on features **without ever losing persistent data**.
- Code and data are separate: Postgres data lives in the `pgdata` Docker
  volume, media in the OVH object-storage bucket `campfire` (Cloudflare R2
  `campfire-media` until 2026-09-14). Never `rm -rf data`, never
  drop the database, never delete the volume or the bucket, never write
  destructive one-offs without explicit confirmation. Twice-daily off-site
  snapshots (database + every Secret) go to a **Cloudflare R2 bucket**,
  `campfire-backup`, written by `backup.js` — runbook
  `deploy/ovh/README.md`. Nothing writes to a media bucket's `backups/`
  prefix any more.
  **Media is deliberately NOT in the backup** (owner decision): a snapshot
  carries a media *inventory* (key + size), never the bytes, because mirroring
  the media bucket under `blobs/` doubled what the account stored inside the
  SAME Cloudflare account that held the media — no vendor separation, so it
  could not survive losing that account, and it bought nothing but the bill.
  Consequence, stated plainly: **no backup can return a media byte.** The dump +
  Secrets are the doomsday copy; `--restore-media` is an audit that
  names what is unaccounted for, not a restore. `scripts/purge-backup-blobs.js` deleted the old
  mirror (dry-run first); `prune()` in `backup.js` reaps whatever is left.
  **Secrets are captured as the app's environment**, which is what keeps a
  snapshot self-contained on a host with no Kubernetes API: `docker-compose.yml`
  passes the host's `.env` to the container with `env_file`, so `collectSecrets()`
  records every environment variable verbatim (minus the image's runtime noise —
  `PATH`, `HOSTNAME`, container ids) and, when running in-cluster, the k8s Secret
  objects as well. `--fetch` writes `restored.env` beside `secrets.json`, so a
  rebuild starts from the settings the app actually ran with. Values are never
  logged — the snapshot's log line prints names, and that file is
  plaintext-equivalent, exactly as the k8s Secret capture always was.
  **Vendor separation is back** (2026-09-14): media lives in **OVHcloud** object
  storage and the snapshots in **Cloudflare R2**, so losing either account no
  longer takes the other with it — which is the split `r2.js` was built for. The
  remaining risk is narrower and worth stating just as plainly: **the media has
  exactly one live copy**, because a snapshot records an inventory and never the
  bytes. The R2 bucket `campfire-media` still holds a complete second copy (that
  is why deleting it is the last step of the OVH migration, not the first); once
  it is gone, a second copy means mirroring the OVH bucket somewhere else
  (`rclone sync` to B2/Storj, or another provider's bucket) if the media is worth
  more than the storage it costs to duplicate.
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

## Current state

Live at https://campfire.dill.moe — **one OVHcloud VPS** (`40.160.90.108`,
2 vCPU / 4 GB, Ubuntu 26.04) running Docker Compose, fronted by a **Cloudflare
Tunnel** (outbound-only, so no inbound 80/443 and no certificates to renew),
with coturn on the host network for TURN and **ClamAV in its own `clamav`
container for upload scanning** (signatures in the `clamdb` volume; the app is a
TCP client of it — see below). Media lives in
**OVHcloud object storage**; the doomsday backups are still in Cloudflare R2.
Runbook: **`deploy/ovh/README.md`**. See **Deployment** below for how to ship.

**Migrated off Hetzner on 2026-09-14** (cost; the OVH box is smaller — 2 vCPU /
4 GB vs CX33's 4 vCPU / 8 GB — and the stack's own limits are `1.5g` app +
`1.5g` clamav + `1g` db, so the headroom is thinner). The move was
db-dump-and-restore plus a tunnel
connector swap; **no DNS change was needed for `campfire.dill.moe`**, because
that name points at Cloudflare and the connector moved, not the record. Only
`turn.dill.moe` (a DNS-only A record) had to be repointed. **The old Hetzner VPS
was deleted outright** once the move was verified, so there is no retired host to
worry about rejoining the tunnel, and no rollback host. What that costs: the
one-off pre-migration pg_dump that lived on it is gone (it was redundant - the
running database held the same data - but it is not recoverable now). The durable
recovery path is unchanged and vendor-separated: the OVH media bucket plus the
Cloudflare R2 snapshots below, restorable onto a fresh host with
`deploy/ovh/provision.sh` and `deploy/ovh/README.md`.

**The app is replica-safe and ready to scale past one node** (owner requirement:
it must load-balance across nodes when the deployment grows). Scale-out is a
replica count, not a rewrite. Every fan-out (chat, DMs, presence, typing,
WebRTC signalling, voice rosters, admin presence) crosses replicas through the
Postgres bus in `bus.js`; periodic work is leader-locked via `db.LOCKS`; shared
state lives in Postgres (never a per-process `Map` — the watcher beacons were the
last offender and now live in `watcher_beacons`); media is in the object store,
so no replica needs another's filesystem. Acceptance test:
`node scripts/test-multi-replica.js`.
Two rules learned from this: a rolling update runs **two builds at once**, so
"is there a newer release?" is decided by a cluster-wide **release generation**
(`app_releases`, claimed idempotently at boot, sent as `gen` on `/api/version`
and the WS `hello`) and never by the content-hash fingerprint, which reads as a
change in either direction; and **nothing reloads the page for the reader** — a
new build raises a banner at the top of the shell with an Update button
(`#update-banner`, `body.ub-open` makes every full-height surface pay for its
height).

**The app runs with `VIRUS_SCAN=1` and `MEDIA_COMPRESS` on.** Scanning is
**ClamAV in its own container** (`clamav/clamav`, the `clamav` service in the BASE
`docker-compose.yml`, named volume `clamdb` for the signature database) — a
signature engine is a database on disk plus a downloader on a schedule
(freshclam, which the image runs) plus a daemon holding the parsed database in
RAM, so none of it belongs in the app's image or its process. **Its tag floats
(`clamav/clamav:latest`) and the host keeps it current itself**:
`deploy/ovh/update-images.sh` + `campfire-images.timer` pull it every 30 minutes,
recreate only when the image actually moved, and keep the update only if the new
container is healthy AND `scripts/verify-clamav.js` passes inside the app
container (a daemon whose database failed to load answers OK to everything —
worse than no scanner because it is believed) — then RESTART the app, because
`virus-scan.js` caches the engine generation it stamps on every verdict and
`bucket-scan.js` compares stored rows against that same cached value, so a swap
underneath a running app would keep stamping the OLD generation and suppress the
re-sweep a new engine is supposed to trigger. A failed update retags the previous
image back into place and holds the refused digest in
`/var/lib/campfire/hold/clamav` so the timer does not retry it every 30 minutes.
An engine version bump is therefore an unattended full re-verification of the
stored tree; a daily signature bump deliberately is not. The app is a client:
`clamav.js` speaks the daemon's TCP protocol directly (VERSION / PING / INSTREAM)
so there is no ClamAV client dependency, and every upload is **streamed** to the
daemon in length-prefixed chunks. That is why the two containers share no volume:
the daemon never needs to see a path in the app's filesystem, and a 50 MB upload
is never staged to disk on its way to being judged. `CLAMAV_HOST`/`CLAMAV_PORT`
point at it (default `clamav:3310`); the port is deliberately never published to
the host, because clamd over TCP is unauthenticated. `StreamMaxLength` must stay
above `MAX_FILE_MB` (the compose file sets 64M/64M/256M for StreamMaxLength /
MaxFileSize / MaxScanSize) or the daemon refuses a big upload instead of judging
it — and a refusal is an **error, not a clean verdict**, so uploads would fail
open instead of being served unscanned. Memory is the constraint on this host: a
loaded clamd holds **~1.0 GiB resident** (measured; the database files are only
~170 MB) and a 50 MB stream scan moves that by ~10 MB, which is why the scanner's
compose limit is 1500m and the app's own came down from 2g to 1500m.
The slot is still a real **scan -> compress -> scan** pipeline and only the last
clean verdict is published — clients still see exactly one `pending -> final`
transition, and a file a running player already holds is never swapped
underneath it. Prove the daemon rather than assuming it:
`node scripts/verify-clamav.js` (run it in the app container) checks that it
answers and names its ClamAV version, how old the signature database is, that
**EICAR is detected** — a daemon whose database failed to load answers OK to
everything, which is worse than no scanner because it is believed — that a
harmless body is cleared so it is not always-guilty, that a full-size 50 MB body
is accepted through INSTREAM, and that the app's own file path returns the same
detection. The app's startup probe asks the same EICAR question
(`CLAMAV_VERIFY_EICAR=1`) and **refuses** a daemon that does not detect it, so a
broken database is a loud fail-open with an admin line rather than a silent one.
There is no "band" to reason about any more: ClamAV reports a signature or
nothing, so a verdict is `clean` or `infected` and the old suspicious-band
machinery (`scanVerdict`/`scanScore`, `attWarnHTML`) is gone. Nested content (archives, OLE/CFB, PDF, disk images) is ClamAV's own
business now — it is what its signatures are written against — so the app has no
container/parser code at all.
**Verdicts are recorded against the ENGINE GENERATION that made them**
(`engine` = `clamav/1.4.6`, from the daemon's own VERSION line), never against the
word "ClamAV" and never against the signature revision. That single rule is what
makes an engine swap self-healing: `bucket-scan.js` closes the hole the upload
path cannot by listing the stored tree and queueing the keys the generation
running NOW has not judged — the era scanning was off, files from before any
engine, and **everything the previous machine-learned engine cleared**. The row IS
the ledger, so a key this generation already judged is never re-queued and a pass
is bounded by what is genuinely unjudged; an `infected` key is never touched (its
bytes are gone and the row is the record the chat card reads); a row in `error` is
retried, but only while the engine is answering, so a broken engine cannot turn
every pass into the same pile of failures — and a pass with **no** generation to
compare against is skipped outright rather than adopting the whole bucket on a
guess. Adopted keys are queued **ungated** (`gated = 0`), which is the
load-bearing part: `effectiveStatus` reports a pending ungated row as `clean`, so
a background verdict can only ever REMOVE malware — it can never 421/423 a file a
reader can already fetch, or blink a chat card back to "Processing". An upload's
own row keeps `gated = 1`, because that promise is about bytes nobody has been
handed yet. Leader-locked, `BUCKET_SCAN_*` env, `backups/` and `thumbs/` never
listed, admin routes `POST /api/admin/scan/run[?dry=1]` and the Media tab's two
buttons. A signature UPDATE deliberately does not change the generation: a daily
database bump re-scanning the whole bucket would be an unbounded job for no
security gain, and new uploads are judged by the current database anyway.
**"Scan info"** is the reader's side of it: every attachment rendering carries
`data-att-id`, and the row the message menu merges in from it opens a read-only panel
(`GET /api/attachments/:aid/scan`, membership-checked exactly like the message it
hangs off) showing the STORED verdict — words, tone, when, the engine generation,
the signature revision, the signature that matched, and why the file was removed
or kept. It reads no bytes,
which is the point: an infected file's bytes are gone and explaining that is the
whole job. The verdict is never recomputed, so the panel can never disagree with
what actually happened to the file, and the engine generation is shown rather than
hidden because it is the ledger mark: a verdict from an older generation says so,
which is exactly what the background sweep is about to re-judge. The panel's
`.hb-*` class names are retained from its predecessor (they are generic panel
styling — do not rename them to "scan" in the stylesheet without a reason).
Coverage is the whole media tree: chat/DM attachments and **stories**
through the flag-driven queue, and **profile media** (avatars, banners, sidebar
banners, server icons, custom emoji, webhook avatars, the profile picker's
history) through the same compressor, which lists the bucket hourly
(`MEDIA_SWEEP_EVERY_MS`) and settles a fresh profile upload within a second of
it landing. A per-key ledger (`media_compress_keys`) is what keeps any of that
from being re-encoded twice. It attempts **any size, any type the image's
ffmpeg can decode** (no floor; `MEDIA_COMPRESS_MIN_KB` restores one).
**Playability outranks size for the formats Apple cannot open** (owner request:
"audio messages must be heard on Mac/iPhone/iPad"). A voice message is Opus in
WebM — that is what `MediaRecorder` gives Chrome, Android and desktop Firefox —
and no Apple product can put WebM/Opus in an `<audio>` element before Safari
17.4 (2024-03), has ever played Ogg, or can demux WebM/Matroska/AVI video;
Web Audio's `decodeAudioData` still refuses both, so the player's waveform fell
back to a flat track there too. So `planFor` routes every Opus/Vorbis input
(and every non-`mp4`/`m4v`/`mov` video container) to **AAC in MP4** / **MP4**
with `normalize: true`, and `shouldPublish` publishes a normalized conversion at
**any size** — a re-encode of efficient Opus to AAC 128k is usually BIGGER, and
that is the accepted price (the HEIC rule is the other `normalize` case).
MP3/AAC/WAV/FLAC audio and MP4/MOV video keep the ordinary 8% rule. Everything
ends in the two audio formats every Apple product has always played, which is
why **no pipeline produces Opus any more** (`buildArgs('ogg'|'webaudio')` throws
on purpose — `scripts/test-compress-types.js` asserts that, and asserts a
generated Opus note comes out AAC-in-MP4 with `moov` before `mdat`, because iOS
will not start a progressive read without `+faststart`). The switch is also a
one-time `oncePolicy('apple-playable')` migration: it re-queues the stored rows
whose extension is in that set (`compressed = 0`) and drops their ledger
verdicts, so media uploaded before the rule is converted too — the objects
themselves are only replaced when the queue republishes them under a new key.
`MAX_FILE_MB=50`, because S3 mode buffers every
upload in RAM, and `VIRUS_SCAN_CONCURRENCY=4` + `MEDIA_COMPRESS_CONCURRENCY=2`
let a burst of uploads compress in parallel (one niced single-threaded ffmpeg
each, memory-guarded against the container's limit) instead of one file per 2s
breather. Two, not more (owner request) — a request the 4-core box now honours
with room to spare, where the single-vCPU node did not.

**Uploads live in OVHcloud object storage** (bucket `campfire`), not on disk — so
a replica needs no shared filesystem, and because media kept on a host filesystem
is media no replica and no backup can see. `backup.js` records a media inventory
(key + size) and never the bytes — see the
data-safety contract. **Moved off Cloudflare R2 on 2026-09-14** (`scripts/migrate-r2-to-ovh.js`):
360 objects / 265.8 MiB, copied with the source bucket only ever read from, every
destination key verified by size, and 32 objects re-downloaded from both stores
and compared byte-for-byte — the store is addressed by KEY, so no database row
and no cached URL changed. Live config: `S3_ENDPOINT=https://s3.us-east-va.io.cloud.ovh.us`,
`S3_REGION=us-east-va`, `S3_BUCKET=campfire`, `S3_FORCE_PATH_STYLE=1` (OVH answers
path-style; verified, along with virtual-host, in `scripts/migrate-r2-to-ovh.js`'s
probe ancestor). The old R2 bucket `campfire-media` still holds a complete copy and
is the rollback target; its settings are archived at
`/root/r2-media-settings.before-ovh.env` on the host. Two consequences worth
knowing: **backups taken before the move name the R2 bucket in their manifest**, so
a restore from one of those describes media in a bucket the app no longer reads
(the inventory is a description, not a copy — nothing was lost, but read the
`source.bucket` field before trusting an old manifest); and `r2.js`/`R2_*` are
**unchanged** — backups still go to the separate Cloudflare `campfire-backup`
bucket, deliberately a different vendor from the media so getting one wrong cannot
break the other. Addressing style is a property of the endpoint, not a preference
— **Hetzner Object Storage answers only virtual-host**, R2 and OVH both answer
path-style — which is what `S3_FORCE_PATH_STYLE` exists for. Config
and secrets live in `/opt/campfire/app/.env` on the host, mode 600 and
gitignored; `deploy/ovh/README.md` has the cluster-Secret → env mapping.

Shipped: auth, servers/invites, text channels, voice rooms (mesh WebRTC, sidebar
occupants + VAD rings), uploads, emoji (Emojibase set + custom + Klipy GIFs whose
per-account favorites are written from a picker tile OR from the star on a GIF
somebody posted in chat — a picker post carries the Klipy identity on the
attachment (`cleanGifMeta`/`attFavHTML`), and a GIF posted before that existed is
keyed on a hash of its own md.gif url, so both resolve to one row),
replies/threads/reactions/edits/mentions/markdown, presence + statuses, user
cards, tabbed settings, rail folders + DnD, B&W theme, ctx menus, a deploy
banner (never a forced reload),
TOTP 2FA + passkeys + sessions, notification inbox, link previews (server-side
OpenGraph/oEmbed unfurl → cached card with thumbnail, SSRF-guarded), stories
(24h photo/video posts with an in-app camera, friend + server audiences,
thumbnails cropped into the rings), view-once messages (one view, then one
replay that has to be STARTED within 30s of it — `VIEWONCE_REPLAY_SECONDS`; per
friend DMs, media gated until opened and deleted after use).
The story camera is a Snapchat-style composer: tap the shutter for a photo, hold
it to record (release to stop), pinch to zoom the viewfinder (the capture crops
to what you saw, and a zoomed recording is composited so it matches), double-tap
the picture to flip, no Retake button at all (owner request: the flow is
shoot → preview → next, and `storyRetake()` survives only as the fallback for a
capture whose encode produced no bytes), text-only stories on a picked gradient,
and markup over the shot — draggable/rotatable/scalable text and emoji stickers plus freehand
drawing with colours and undo, all rendered over the media by the viewer and by
the view-once player (the markup travels with the post, not in the pixels).
**The camera is asked for 1080p with a 720p `min` FLOOR** (`storyGetCamStream`,
after "the camera looks really bad in the composer"): the stage is portrait on a
phone and the frame is `object-fit:cover` into it, so a 720p landscape stream
(what touch devices used to get) left a ~405x720 slice of real pixels to fill a
1080x1920 screen — and a bare `ideal` with no floor lets an engine answer 640x480
and say nothing, which is the silent version of the same complaint. A camera that
cannot meet the floor is retried as a plain 720p `ideal`; a refused permission is
NOT retried, because a second ask cannot answer differently. The recording is
handed an explicit `videoBitsPerSecond` (~0.15 bits/pixel/frame, capped at 5 Mbps
so the 60s maximum take stays under the 50 MB upload ceiling) — the engine's own
~2.5 Mbps default was the last thing squeezing a take — and the MP4 fallback
names H.264 **High** profile, because Safari's default for a bare `video/mp4` is
Baseline.
A URL typed into a story is handled in one of two ways, and the difference is
whether the author put it on the picture or in the caption. On a **sticker** the
URL is REPLACED BY the card itself (`storyTextHTML`, embeds.js): a sticker is
display text at 8.5% of the picture's height, where a raw URL is a ladder of
characters, and the card is the thing worth looking at — words around the link
keep their line and the card lands under them, a sticker that is nothing but a
URL IS the card, and a sticker is the markup item, so the card travels with it
(scaled, rotated, positioned) into the viewer and into the view-once player.
There is deliberately **no card at the bottom of a story**: an earlier cut put
one in a `#sv-links` bar under the caption and the owner asked for it in place
instead. In a **caption** (prose, not markup) the URL stays a hyperlink
(`linkifyHTML`). The card is always the compact unfurl card and never a player —
an iframe (Spotify, X, a Twitch player), a 16:9 YouTube facade or a full-size
image would cover the picture the reader opened — one card per story, and it is
asked for with `keep` so a page the unfurl had nothing for still shows its little
card with the site on it instead of vanishing the way a chat stub does.
**A YouTube link is the case that proved scraping is not enough**: a watch page
is megabytes of inline JSON and its og: tags never survive `UNFURL_MAX_HTML`, so
the unfurl answered nothing and the card sat there saying "youtube.com". So the
server asks a provider's own **oEmbed endpoint directly** when it knows one
(`directOembed` in unfurl.js, before any page is fetched — YouTube's answers with
the title, channel and thumbnail in one small JSON response), and the client
seeds the poster frame from `i.ytimg.com` in `linkCardHTML` so the video card
looks like a video card *before* any unfurl lands (the same CDN URL chat's
facade already loads, and it survives `UNFURL=0`, where a card needs no fetch).
Three traps found doing it, all about absolutely positioned boxes:
`.ov-item` and `.sv-cap`/`.vo-cap` set `left` with `right:auto`, so each was laid
out in the space to its RIGHT — a sticker at x:0.5 and a 200-character caption on
a 390px phone wrapped at HALF the picture's width (the sticker's URL came out as
a ten-line ladder running off the shot, the caption at ~195px), and
`width:max-content` before the `max-width` is the fix in both. And the sticker's
display type (outline `text-shadow`, weight 800) leaks into a card built inside
it, so `.ov-item .embed` resets both — sized in `em` off the sticker's font with
a px floor (`max(.3em,10px)`), because a landscape phone's stage is short and a
proportional-only card became a thumbnail of a thumbnail. The composer asks for
the same markup so the preview matches the post, with the card dead there
(`.ov-editable .ov-item a{pointer-events:none}`) so the drag keeps owning the
sticker. `scripts/test-story-links.js` + `test-story-links-browser.js` cover it.
A story sent to an individual friend is delivered as a view-once DM instead of
a tray entry (`POST /api/dm/viewonce` with `storyId` re-files the story's bytes
under the gated `viewonce/` prefix), and picks alongside a broadcast audience
get both. Stories carry quick reactions: the viewer's rail sits under the stage
(`#sv-react`, a fixed emoji set mirroring the server allowlist) and each tap adds
another copy of that emoji up to 4 (`story_reactions` holds a `count` per
(account, emoji)), a copy of the emoji floats up out of the button (`.sv-float`
in `#sv-floats`) with a haptic tick, and a tap on a maxed-out emoji takes that
set back — the button's badge is the tap count. The float lane is
`pointer-events:none` or it would eat every tap on the rail. Opening someone
else's story replays the reactions already on it (a staggered burst, capped);
your own story shows read-only count chips and never replays at you, and under
the views button each viewer row carries the emoji they sent (×N). The author
sees the per-viewer detail; everyone else only ever gets aggregate counts, and
the live `story-reaction` push carries the full tally (idempotent to apply) plus
the view count. Reactions are user content, so the emoji here are intentional
(the rail's own chrome is text/SVG). Message reports: right-click / long-press → **Report message** (red,
last item; never your own) files it with a snapshot of the text, media
references and where it happened, pushes every site admin live, drops an inbox
entry, and puts a badge on the console's Reports tab + rail shield; admins
search/filter the queue and dismiss, delete the message, disable the author,
delete + disable, or ban from the server (one decision closes every open report
on that message). Menus are content-aware: an attachment carries its own identity
(`data-att-id` + the `data-fb-*` media pair, painted by `attMeta` in
messages.js on EVERY rendering — the `.att-wrap`, the audio player, the text
preview, the plain file card, and the `scan-block` card standing in for a
pending or removed file; `data-fb-size` rides with them so a rendering built
from the identity alone can still show a size), and those rows ride in the MESSAGE's own menu rather
than in a menu of their own, SCOPED BY THE POINTER: `msgAttItems` (actions.js)
reads the identity of the element under the pointer and turns THAT one file into
Copy image / Save image / Copy image link / Open image link for media (a browser
cannot put video bytes on the clipboard, so that flavour is never offered), Save
file / Copy link for the rest, and **Scan info** on all of them, pushed between
the content actions and Mark unread. A press on the message's own pixels — its
text, its padding, the hover bar's `⋯` — carries NO file rows at all: the old
behaviour attached every file's heading + rows wherever the menu was opened, so a
post of five photos buried the message actions under five identical "Save image"
blocks (reported), and the rendering the reader pointed at is the more precise
target anyway. The heading (`.ctx-head`, a caption, not a row) survives for
exactly what it was written for: a message carrying MORE than the one file being
acted on, where "Save image" would otherwise be indistinguishable from a sibling
the message is showing right above it. Because the rows live behind the pointer,
EVERY rendering has to be a hold target — the plain file card is an
`<a data-att-id>`, which is why the long-press guard skips
`a:not([data-att-id])` rather than every link (an ordinary link is still the
browser's). So `ctxFor` resolves the `[data-mid]` message branch FIRST
and only falls back to `attMenuItems` for media with no message around it (a
pinned message's media in the pins panel, which has no message menu to merge
into) — the same order in the long-press handler, which opens `openMsgSheet(mid,
el)` for anything inside a message. `attFromEl` reads the identity and the
same `a:not([data-att-id])` exemption in the contextmenu guard is what lets a file
card through without taking the browser's own link menu away from ordinary links.
A file whose bytes were removed (`infected`) or are not published yet
(`pending`) offers ONLY "Scan info", because there is nothing left to save.
The message menu adds Mark unread,
Bookmark message and Create reminder… beside Copy text, and View reactions
whenever the message has any. Mark unread moves the WATERMARK
(`channel_reads`/`dm_members.last_read_at`) to one millisecond before the
message, so `POST /api/messages/:mid/unread` (one route, both surfaces,
membership-checked) makes it the first unread one and pushes `chan-unread` /
`dm-unread` to the account's other devices. Bookmarks (`bookmarks`) and
reminders (`reminders`) both snapshot nothing they do not need: a bookmark keeps
author + text + where + media URLs captured at save time, so it still reads after
the author deletes the message, and a reminder hangs off a message or nothing at
all. `fireDueReminders` is leader-locked (`db.LOCKS.reminders`, 20s tick) and
claims each row with `UPDATE … WHERE fired_at IS NULL` before pushing, so a
handover or a restart can never ring twice. The bell is now the **Inbox**
(an envelope, `#btn-notifs`): Notifications / Reminders / Bookmarks tabs, each
with its own search box — every list is fetched on open, and typing only
repaints the list (never the shell) so the field keeps focus. Lists show their
media: a bookmark's pictures render as tiles (`inboxMediaHTML`/`wireInboxMedia`,
local uploads through the same derived preview the chat paints, a video as a
play tile until `whenVideoPoster` lands, a tap opening the lightbox on the
ORIGINAL) and a mention carries the message's first non-spoilered image/video
(`notifications.media_url`/`media_kind`, filled once per fan-out in
`notifyMentions`) — a spoilered attachment is deliberately never thumbnailed,
because the veil is the reader's choice and a list they did not open must not
make it for them. `#ctx-menu` is capped
(`max-height:min(72vh,560px)`, `overflow-y:auto`) so a long menu scrolls instead
of running off the screen; the phone `#sheet` is a flex column whose
`.sheet-rows` is the only scroll region, and `sheetDragExpand` (final.js) makes
it TALLER by dragging its handle/header up — the gesture, not a scrollbar — with
`.sheet-tall` (94vh) holding the decision after release. The pin button's "N new" badge is a per-account memory
(`pin_seen`) mirrored server-side and pushed over `pin-seen`, so reading a
conversation's pins on the phone clears the badge on the desktop too; the phone
Home tab mirrors the Active Now rail as a horizontal tile scroller under
Stories (`#anow-strip`, `home.js`), since `#members` is a drawer Home never
opens there. The sidebar's **Stories** row is a destination, not a modal: it
opens the story center (`#stories-page`) in the main panel — your story as a
wide hero card with post count, views, reaction tallies, hours left and a "See
who watched" row (the same panel the viewer's views button opens), then a wall
of portrait cards per person (unseen first, then the ones you have watched),
then a strip of the servers you share; with nothing live anywhere it is one
welcome panel with the how-it-works tips, never a hero *and* an empty card. The
old horizontal strip at the top of Friends is gone, and the server sidebar's
Stories row keeps its compact sheet (that one is scoped to one server and is a
quick look). Settings → Games is a full game-activity manager — search,
per-game Ignore / Track again / Remove playtime, an ignore list that outlives a
game's stats (an ignored game with its record deleted used to vanish, which is
exactly how a game "stopped being tracked" with no way back), and a
track-by-name way back for anything not listed. Group chats carry settings
(name + description, `PATCH /api/dms/:tid`, members-only) reached from the
DM/group row's right-click or long-press menu; the description paints as the
chat header's topic line. A mobile long-press on a DM/group row opens that
slide-up sheet (never the desktop popup), and the row's server tag is rendered
`tagHTML(u, true)` — decorative, so the tap always opens the conversation
instead of the tag's server mini-panel. Removing someone from a group is the
creator's alone and sits on **both** surfaces — the member row's right-click /
long-press menu and the member's user card (a danger `Remove` tab, like a
server's Kick, via `groupRemoveTabHTML`) — behind one shared predicate
(`canRemoveGroupMember`), with the server re-checking `creator_only`. Groups
stay remove-only: no ban.
DM unread is server state, never a per-tab tally: `dm_members.last_read_at`
(stamped by `POST /api/dms/:tid/read`, which the client fires when a thread opens
and when a message lands in the one already open) and `/api/dms` returns each
thread's `unread`, so the unread-sender avatars under the campfire (`#dm-rail`)
come back after a reload — including the one a deploy's Update banner leads to —
and reading a DM on the phone clears the desktop (`dm-read`).
A row that was never read starts at `joined_at`, so being added to an old group
chat doesn't light up its history, and own/system messages never count.
Channel notifications are a count, not a dot: a server with unread channels
shows the number in a red corner circle on its rail icon (`paintServerBadge`
writes it into `data-unread`, and the CSS renders it with
`content:attr(data-unread)` so a pill can never be empty), and a **collapsed**
folder shows the sum for its servers — `paintFolderBadge`/`folderUnreadCount`
in `servers.js`. Opening the folder hides the folder's circle (CSS,
`.folder-btn.open`) and the servers inside paint their own through the same
helper, so retracting without reading restores it untouched. The live path is
`paintServerUnread`, which repaints every copy of the button AND the folder that
holds it — a server inside a closed folder has no button of its own. Both menus
(the server ctx menu / sheet and the folder's desktop flyout / touch sheet)
carry **Mark all as read** through `markServerRead`/`markFolderRead` gated on
there being something to clear.
Channel unread is **server state** too — the twin of DM unread — because as a
localStorage map fed only by live pushes it left no trace of anything that
arrived while the app was closed (the owner's "opened the app and nothing looked
unread"). `channel_reads` holds one `last_read_at` per (account, channel),
`GET /api/unread` answers which text channels have an unseen message, and
`POST /api/channels/:chId/read` / `POST /api/servers/:id/read` stamp it and push
`chan-read` to the account. `markChannelRead` (servers.js) is the only writer —
opening a channel, a message landing in the open one, a foregrounded tab —
`syncChanUnread` replaces `S.chanUnread` with the server's answer at boot, and
`refreshUnreadState()` re-reads channels + DMs + inbox on a foregrounded tab and
on a socket RECONNECT, the two moments pushes were missed. Rules: someone else's
message (any `user_id` not mine), never a system line, never a thread reply; no
row falls back to `joined_at`, and leaving a server forgets the watermark. The
first boot with the table seeds every membership caught up (`tableExists`,
one-shot) or an upgrade would light up all history. `paintAppBadge()`
(security.js) is the app ICON — unread DMs + channels + inbox through
`navigator.setAppBadge`/`clearAppBadge` (installed PWA, dock badges in
Chrome/Edge) and Tauri `set_unread_count` (desktop tray/taskbar/dock).
Detail per change lives in `git log` — don't duplicate it here.

## Deployment (owner directive)

**Every change must be deployed to the live production instance** — never stop
at local edits. Finish each task end-to-end: edit → verify → commit → push →
deploy → confirm the live site serves the change. **You always have standing
permission to commit, push, and deploy to production — never ask for it first,
and never pause to confirm a deploy.** The owner granted that up front, for
every task, in this file.
- Local repo commits to `origin/main` (`https://github.com/jreoka/campfire`).
- Production is **one OVHcloud VPS** (`40.160.90.108`), running Docker
  Compose from `/opt/campfire/app`:
  `ssh root@40.160.90.108`, then `cd /opt/campfire/app && git pull && docker
  compose -f docker-compose.yml -f deploy/ovh/docker-compose.ovh.yml up
  -d --build`. Full runbook: **`deploy/ovh/README.md`** (renamed from
  `deploy/hetzner/` on 2026-09-14, and the overlay from
  `docker-compose.hetzner.yml` to `docker-compose.ovh.yml`, so the names describe
  the provider that is actually running). The overlay is provider-agnostic —
  cloudflared + coturn — and is what a fresh host of any vendor would use.
- **SSH on that host is key-only.** `PasswordAuthentication no` lives in the MAIN
  `/etc/ssh/sshd_config`, not in a drop-in: on Ubuntu 26.04 / OpenSSH 10.2p1 the
  first value OpenSSH obtains wins, and `sshd_config.d/50-cloud-init.conf` ships
  `PasswordAuthentication yes` and sorts first, so nothing later could override
  it. That file is now `no`. Confirm with `sshd -T | grep -i passwordauth`.
- **ufw alone does not contain Docker's published ports.** Measured on this host:
  `-p 8888:80` listened on `0.0.0.0:8888` with no ufw rule for it and answered
  from the public internet. `/usr/local/sbin/docker-user-firewall.sh` (run by
  `docker-user-firewall.service` on every docker start and by its `.timer` after
  boot, since Docker flushes `DOCKER-USER`) drops that traffic. The app itself
  publishes on `127.0.0.1` (`BIND=127.0.0.1`), so the tunnel is unaffected — but
  the rules are what keep a future `-p` from being public by accident. Note the
  Docker-docs `--ctstate RELATED,ESTABLISHED` snippet does NOT match container
  reply traffic here; the working shape is `-s 172.16.0.0/12` then conntrack then
  DROP, and a destination-subnet accept must never be added (DNAT rewrites inbound
  connections to the container's own subnet before FORWARD sees them, which
  silently re-opens every published port).
- Production builds its own image on the host from its own checkout, and the
  repo **publishes no container image anywhere** — the old GHCR workflow is gone
  (nothing ever pulled it, and a private package nothing consumes is just a
  second, staler copy of the app to keep track of). `docker compose up -d
  --build` on the host is the only build that matters.
- Env-only changes need **no rebuild**: edit `/opt/campfire/app/.env` (mode 600)
  and `up -d --force-recreate campfire`.
- **The scanner updates itself** — the one image on this host that is not the
  app's own build. `campfire-images.timer` (units in `deploy/ovh/systemd/`,
  installed by `provision.sh`; script `deploy/ovh/update-images.sh`) pulls
  `clamav/clamav:latest` every 30 minutes and recreates that ONE service, only
  when the image ID actually moved. An update is kept only if the new container
  is healthy AND `scripts/verify-clamav.js` passes inside the app container, and
  the app is then RESTARTED so it re-probes the engine generation it stamps on
  every verdict (see §Current state — without that restart the swap is silent and
  the bucket re-sweep never fires). A failed update retags the previous image
  back, holds the refused digest in `/var/lib/campfire/hold/clamav`, and shows up
  in `systemctl --failed` / `journalctl -u campfire-images`. `CLAMAV_TAG=1.4` in
  `.env` (then `up -d --force-recreate clamav`) freezes or rolls the engine back.
- Confirm the deploy: `curl https://campfire.dill.moe/api/version` (the
  fingerprint changes) and `docker compose ps` → everything Up, `db` healthy —
  and on the FIRST deploy that brings the scanner up, `clamav` sits **unhealthy
  for a few minutes** while it downloads ~300 MB of signatures into the `clamdb`
  volume, which is expected (the app runs and fails open meanwhile). Confirm the
  engine itself with `docker compose exec campfire node scripts/verify-clamav.js`
  — it scans, and it refuses a daemon whose database did not load — and read the
  app's own startup line in `docker compose logs campfire`:
  `ClamAV engine ready (clamav:3310 — 1.4.6, signatures 28122 ...)`. The daily
  bucket sweep then re-judges the whole stored tree (every row still carries the
  previous engine's generation), which is the migration.
- Postgres is the `pgdata` Docker volume on that host. Never delete it and never
  `docker compose down -v` — that destroys the database. The data-safety contract
  below applies unchanged.
- Backups are **off-site in Cloudflare R2** (`r2.js`, `R2_*` env), never in the
  media bucket: 12-hourly snapshots of the pg_dump, the secrets the app runs with
  and a media **inventory**, newest `R2_BACKUP_KEEP` (2) retained.
  Version-2 manifests say `media.included: false` and list key + size per
  object; no snapshot stores media bytes. The blob-era `blobs/` mirror (the
  whole media bucket, deduplicated) doubled the account's storage for no
  recovery benefit — it lived in the SAME Cloudflare account as the media, so it
  had no vendor separation either — and `scripts/purge-backup-blobs.js` deleted
  it (dry-run first, then `--write`); `prune()` reaps any residue. Restore with
  `node scripts/restore-from-r2.js` (`--list` / `--show` / `--fetch`);
  `--restore-media` is now an inventory audit that names the keys the media
  bucket no longer has and copies only what a pre-change snapshot still holds as
  a blob. `R2_*` is deliberately separate from `S3_*`: getting the backup
  destination wrong must not be able to break media serving, or the reverse.
- The pod runs as the `campfire` ServiceAccount, which has a namespace-scoped
  read-only Role on Secrets — that is how an in-cluster snapshot gets the Secret
  objects behind `JWT_SECRET` and the tunnel token. On the Compose host there is
  no API to ask, so the **environment capture** carries them instead: compose
  passes the host's `.env` to the container with `env_file`, so `secrets.json`
  holds every variable the app runs with, plus a `restored.env` written by
  `--fetch`. Either way the R2 bucket is as sensitive as the host or cluster:
  `secrets.json` is plaintext-equivalent and contains the R2 keys themselves.
- Voice/TURN: coturn runs on the VPS host network (`network_mode: host`; 3478/udp+tcp,
  3479/tcp, relay 49160-49200/udp) so it binds the public IP directly.
  `turn.dill.moe` is a **DNS-only** A record to `40.160.90.108` — Cloudflare's
  proxy does not carry UDP, so TURN can never use the tunnel. Test it with
  `turnutils_uclient -y` from inside the coturn container. This is the one record
  that has to be repointed when the host moves.
- Two facts about object stores, both measured against endpoints this app has
  used: an object store is not S3-shaped by default (aws-sdk v3 sends a
  streaming Body as a chunked PUT with a checksum trailer, and not every store
  accepts that — `storage.js` and `r2.js` buffer the body, which also pins
  ContentLength so a short read can never be stored as a whole object); and
  addressing style belongs to the ENDPOINT, not to taste (Hetzner Object Storage
  answers only virtual-host; R2 and OVH both answer path-style), which is what
  `S3_FORCE_PATH_STYLE` exists for. Measured on the live OVH bucket: path-style
  works, and the media has since moved there — see §Current state.

Non-obvious rules (learned the hard way): uploads must live on the
persistent volume (never the image layer); new uploads get `?v=` cache keys;
missing `/uploads/*` must 404 (never SPA fallback); navigations are
network-first. The instance owner's
account (`jreoka`, exported as `db.OWNER_USERNAME`) is untouchable by every
other site admin: `blockedByOwnerLock()` 403s `owner_protected` on each
account route (edit, password, disable, demote, delete, forced logout, 2FA
reset, profile media, server kick) and on the account-level report actions
(disable / delete+disable / ban — moderating the message itself stays allowed).
The panel just mirrors it off `ownerAccount` in the admin payloads: that row is
greyed out with its buttons disabled **for everyone, the owner included** (the
owner manages their account from Settings → Profile / Account), and the same
flag hides Kick/Make-owner in the member lists and Disable/Ban on a report
card for that author. Any new admin route that changes an account must call the
same guard. **Closing an account is a 7-day grace period, never an instant
purge**, wherever the request comes from (the account's own Settings → Account,
the console's Delete, or anywhere else that will grow one):
`requestAccountDeletion` disables the row and signs every session out at once, so
the person is gone from the app immediately, and the ROW is deleted only once
`deletion_scheduled_at` has passed — by the leader-locked `purgeDueAccounts`
(`db.LOCKS.accountPurge`, run at boot and on a slow tick, each account under its
own `db.withKeyLock` so a restore landing in the same instant either wins the row
or is refused, never both). Until the deadline `POST
/api/admin/users/:id/restore` puts the account back, and it is a REAL restore
because nothing is torn down first: memberships, messages, DMs, stories, 2FA and
profile media are all still there. `deletion_prev_disabled` is what makes it
honest — scheduling forces `disabled = 1`, and a restore puts back whatever the
flag was before, so an account an admin had disabled for abuse does not come back
enabled by the act of undoing a deletion. Enabling through `PATCH` also cancels a
pending deletion, or a purge would fire under an account somebody just revived.
Both sign-in (`refuseClosedAccount`) and `authRequired` answer
`pending_deletion` with the deadline rather than the generic `account_disabled`,
and the console mirrors all of it: a `Pending deletion` filter, a `DELETES IN
Nd` badge, the requester and the deadline on the row, Restore in place of Delete,
and a `Pending deletion` card in the overview. The window length is ONE constant
(`ACCOUNT_DELETE_GRACE_DAYS`, default 7) served to the client as
`/api/config.deleteGraceDays`, because the copy that promises the number and the
sweep that acts on it must not be able to disagree. Presence is
server-scoped **and** friend-scoped: a friend with no shared server would
otherwise look permanently offline (see `notifyFriends`/`presenceForUsers` in
`server.js`) — any new presence surface must respect both. The avatar-corner
phone indicator is presence's one **derived** fact, and it is a lease, not a
latch: `live_sessions.visible_at` records when a socket last said its page was
in front, the client re-asserts that every ~25s while it really is
(`public/js/socket.js`), and `phonesFromRows` (server.js) decides per account —
a phone claiming a live lease wins, a fresh DESKTOP beats a phone whose claim
lapsed, and a phone that merely went quiet still counts while nothing else is
renewing (a locked phone is not a phone that stopped existing). "Any live phone
socket" was the first rule and it read as ON MOBILE for minutes after its owner
had moved to a desktop, so do not go back to it. Which value the clients were
last TOLD lives in `users.mobile_flag`, and `announceMobile` pushes only a real
change (one compare-and-set, so replicas cannot double-push); because a lease
must be able to expire with no frame from anyone, the leader-locked
`reconcileReplicaState` pass re-derives every online account on a clock — and
that pass is also the only thing that can announce the users of a replica that
DIED, since a crash runs no close handler. Every status flip carries the phone
flag with it (`user-status` frames have `mobile`), because going invisible tells
friends `user-offline` — which drops the glyph with the status — and without the
flag on the frame back there was nothing to restore it. And the automatic
Online → Away → Online behaviour keys off `users.presence_auto`, not a
per-browser marker: only the IDLE clock's Away may be silently undone by
activity, that is a property of the ACCOUNT (picking Away on the phone must not
be undone by a mouse move on the desktop), the client's flip says
`presenceAuto:true` and every plain status write clears it. The clock itself is a
wall-time stamp read by a slow tick, never one long `setTimeout` — a throttled or
suspended tab never fires it, and a fired timeout is not re-armed when a timed
Away lapses back to Online. A device that is NOT in front yields: the flip
carries `presenceVisible`, and the server drops the whole request while any
socket of that account holds a page-in-front lease (`anyoneInFront`), so a phone
in a pocket cannot read its owner away while the desktop is in use — the two
clocks would fight, amber/green/amber every few minutes. A hidden device with
nothing in front is still free to flip (the background tab whose owner walked
off).
Friends' voice
activity (`friends-voice`, the Active Now IN VOICE rail) is friend-scoped too:
it is derived from `voiceRooms`, so any path that adds/removes a socket there
must go through `leaveVoice`/`pushFriendsVoice` or the rail shows ghosts. View-once media
lives under `viewonce/` (never `files/`): that prefix is served only with a
signed ticket from `POST /api/dm/:mid/viewonce/open` (a story sent to an
individual friend is copied into `viewonce/` for the same gate), so nothing can
fetch it before the recipient opens the message. The replay is a WINDOW, not a
lifetime: `view_once_replay_until` (set by `/viewonce/consume`, deadline
`VIEWONCE_REPLAY_MS`) is when the replay must be STARTED — reads mask a lapsed
window as `consumed` (as the status sweep masks expired statuses), `/viewonce/open`
answers `replay_expired`, and `reapExpiredViewOnce` collects the bytes a whole
ticket lifetime later so a replay that began in the last second keeps its media.
The client's card runs the same countdown off `replayUntil` (`voTick`), so both
sides of a DM watch the same clock without a push. Async discipline:
never pass an async callback to map/filter/forEach when results are used
synchronously (use for..of or Promise.all); background timers go through
safeInterval so rejections log instead of crashing. Composer text is never
lost to a reload: every conversation's half-written message lives in a
per-account draft store (`core.js`: `draftSoon`/`flushDrafts`/
`applyComposerDraft`), so any new composer or chat switch must call
`flushDrafts()` before the context changes and `applyComposerDraft()` after it,
and clear the draft when the message goes out. Attachments and their uploads are
per conversation too (`messages.js`: `pendingByCtx`/`syncPendingAttsCtx`,
re-synced by `renderComposerMeta`) — an upload card only paints in the chat it
was started in, and its finished file lands THERE. **The thread bar is the chat
bar's own version** (`#thread-composer`, mirroring `#composer` id for id:
`tbtn-*`/`in-thread`, its own `#thread-attach-preview` + `#thread-upload-list`,
its own `+` menu): the two are on screen at once, so a composer is never "the
open conversation" — the chat bar stages on `draftCtx()`, the thread bar on
`threadAttCtx()` ('t:<rootId>', the key its draft already used), and one
`renderComposerMeta()`/`renderUploads()` repaints BOTH from their own contexts.
Pickers carry the bar they were opened from (`openPicker(..., input)`,
`pickerBar()`), the three completions (`@` / `#` / `:emoji:`) are registered
per field, and `paintComposerSend()` paints both keys. A voice message, poll,
view-once or story is deliberately absent there: those flows are channel-scoped. An upload that is never
answered must FAIL visibly, never shimmer: the watchdog (`messages.js`) is armed
from `xhr.send()` — not from a progress event, which a dead transfer may never
send — and its ceiling drops to 90s once the body is out, because a phone that
slept or a half-open connection leaves the XHR pending with no event at all
(`sweepStalledUploads()` re-judges it when the page is foregrounded again, and
`storage.js`'s S3 client needs `throwOnRequestTimeout` — a bare `requestTimeout`
only warns — so a silent object store cannot hold the route open either). The
upload card's two stages hand over in order, and the FIRST one finishes leaving
before the second appears: the chip — not just its **Spoiler** toggle — is
withheld until THAT FILE's card is gone. `xhr.onload` parks the answered
attachment on the upload entry (`u.att`/`u.attHere`) instead of filing it, and
`removeUpload` files it and repaints the composer the moment the departing card
leaves `#upload-list`; gating on `activeUploadCount` instead was wrong twice
(the card the server has already answered sits there in its green `done` state
for a 650ms exit, so the chip and its toggle appeared under a card that was still
the thing being looked at). `uploadHeldOnStage(att)` is the test — per
ATTACHMENT, never the list as a whole: gating on "is any card up there" made the
first finished photo wait for every other green bar when several are picked at
once (reported), so `removeUpload` now repaints unconditionally and only the
attachment whose own card is still standing waits. Anything that reads
`S.pendingAtts` for the composer must go through `renderComposerMeta`'s
combined view (it appends the `attHere` held ones) or a chip will be missing.
**The composer's file picker takes several files at once** (`#in-attach` is
`multiple`): the change handler applies the same 5-per-message cap a drop or
paste does, off one `room` calculation, so an over-full pick is one toast.
And a text-ish attachment — source, script, config, markup, log — embeds as a
**code box** (`textFileHTML`), not a plain file card: detection is mime, then
whole file name, then extension (so `Dockerfile`, `.env` and `.ps1` all land in
it), the BYTES get the last word over a text misdetection, and Expand/Collapse
grows the SAME box in place (per-URL state that survives a repaint) with Copy and
the download chip on it. The bottom fade is a MEASUREMENT, so a file the box
holds entirely is never faded. Tests: `test-attach-picker.js`, `test-code-card.js`.
**The drop zone refuses drags that STARTED in this window** (`messages.js`):
Chrome hands a dragged `<img>` over as a temporary FILE, so dragging a photo out
of a message and letting go over the composer read as a file drop and attached
the picture again. `dragstart` at capture marks the gesture, the mark survives
dragging in and out of the page (only `dragend`, a drop, or a `dragleave` with no
`relatedTarget` clears it) and `dragHasFiles` refuses a marked drag — that is the
browser-independent guarantee, and `img,video{-webkit-user-drag:none}` plus
`draggable="false"` on `.att-img`/`.att-vid`/`.embed-img`/`.embed-vid`/`.el-img`
stops the drag starting at all in the first place. The trade, on purpose:
dragging media out to the desktop is gone; Save image / the download chip do
that. `scripts/test-composer-drop.js` drives the real sliced block in Chrome.
The typing strip above the
composer always keeps its slot (`--strip-h`, one text line, transparent, text
fades) — hiding it resizes `#messages` and shoves the conversation up/down.
`#messages` pays for that slot by giving up its bottom padding, and anything
anchored to the composer top stacks `var(--strip-h)` on `var(--composer-h)`.
The thread panel has the same strip for the same reason (`#thread-typing-bar`,
`#thread-typing`): a reply being written in a thread is not somebody writing a
channel message, so `typing` frames carry their `threadRoot` (the server checks
it is a real message in that channel and drops it otherwise — never downgrading
it to channel typing), the client keeps a separate `threadTypingNames` map, and
the two strips never light each other up.
Attachment cards live in that gap (`#attach-preview` for finished chips,
`#upload-list` for in-flight cards), so with a card on screen the composer
shrinks its top padding to `.55rem` (`#chat:has(#attach-preview:not(.hidden))
#composer`), and the thread panel mirrors it. `.9rem` on top of the strip read as
"quite far from the message box" (reported); `.25rem` then read as the two
stages — the upload card and the chip with its Spoiler toggle — sitting ON the
field (reported the other way), so the gap is now a real one, and the strip
keeps its height so nothing below the cards moves. Two traps found doing it: **padding cannot go negative**
(`calc(.9rem - var(--strip-h))` clamps to 0, so an overlap has to be a negative
MARGIN, not padding), and **`~` inside `:has()` looks FORWARD only** —
`#composer:has(~ #attach-preview)` passes `CSS.supports` yet matched nothing in
Chrome 152, because `#attach-preview` sits ABOVE `#composer` in the shell
(`index.html` line 242 vs 255), so the rule silently did nothing. `:has(+ x)` /
`:has(~ x)` do work in every engine here (measured: `.msg:has(+ .msg.grouped)`
matched every head with a follow-up under it); the shell's ordering was the
trap, not the combinator, so key such a rule on the direction the DOM actually
has — or, when the ordering could change, on descendants of a shared ancestor.
`scripts/test-attachment-gap.js` measures the real gap
on BOTH bars at both breakpoints.
**A scrolled-up reader's line is held by the app, never left to the browser**
(`armLineGuard`, messages.js): the last message whose top is still inside the
viewport is the reference, and a layout change that moves it on screen is undone
with `setScrollTop` — measured, never predicted, which is what keeps it from
doubling up with native scroll anchoring (where the engine already held the line
there is nothing left to restore). The reader's own scrolling re-baselines the
reference, and every `setScrollTop` does too, so a placement is never fought; the
bottom pin keeps ownership of a reader who is ON the live bottom. This is the
reader's "when I scroll up a couple of messages it glitches me upwards" — the
messages themselves slide, older or newer content appearing without them
scrolling. Chromium's anchoring does not cover it: it only promises that the
topmost node it picks keeps its POSITION, so when that node is the one that GROWS
— a clip's metadata landing, and a video is the one attachment whose size is
never recorded (`uploadDims`), so its box is the element's default 300x150 until
then — everything below it slides and nothing compensates (measured: 86px with
the scroll offset untouched). WebKit has no scroll anchoring at all, so there
every change above the viewport slides them. The same guard absorbs the paging
status row's insert and removal (a real row, 29px above the reader, taken back
out after the page's anchor correction), a reaction bar or link embed appearing
under their eye, and an unshaped picture's bytes. `scripts/test-scroll-up-hold.js`
boots the real app and drives it in Chrome to prove it: it fails without the
guard, with the slide measured in pixels.
Being NEAR the live bottom is not being ON it (`AT_BOTTOM_PX`, `markBottomState`):
the 200px band only ever KEEPS a pin that already exists (a picture landing above
a reader who is following the tail must not strand them), while promoting a
reader to the pin takes them actually arriving — a wheel notch or a flick lands a
few px short of the clamp, and that is still the bottom. Handing the pin out from
the band is the "scrolling down nearly to the bottom glitches you to the bottom"
half of the same report: the pin was set 200px early, and the next scroll event
of the reader's own gesture (or a stray one from the browser's anchoring under
late media) was read as "hold the bottom" and finished the scroll for them.
Every sidebar banner (the me bar, member rows, DM rows) is painted through
`paintSidebarBanner` in `servers.js` — never inline the gradient again. Those
rows are fractional-width, and `background-size: cover` with the default
`background-repeat: repeat` on a right-anchored picture leaves a sub-pixel
tiling seam at the LEFT edge that lands on a whole device pixel at dpr 1: a
light 1px line down the left of the slot. Keep the layers `no-repeat` and the
two ramps at `100% 100%`. The phone layout is not a width: it is
`(max-width:700px), (max-height:560px) and (pointer:coarse)` — a phone held
sideways is 850+px wide but only ~390px tall, and keying on width alone dropped
landscape onto the desktop three-pane shell (static rail + chat list + members
column, the chat crushed into ~320px). Every mobile @media block in
styles.css spells that condition out and every JS layout decision goes through
`phoneLayout()` in `core.js` (which is the same condition in one place) — use
those, and re-run `scripts/test-mobile-landscape.js`. In **portrait** the server
rail + chat list is a whole page
(`body.nav-open`), not a drawer over the chat: it covers the viewport, has no
scrim, and closes from its own ✕, a channel/DM row, or the Friends/Stories nav
rows — a server tap and the campfire Home button deliberately keep it open so a
channel or conversation can be picked (`#btn-home` only swaps the chat list over
to the home lists; closing it there dropped the reader into the DM that happened
to be open behind the page). A phone held **sideways** is the exception that
`test-mobile-landscape.js` protects: the short-touch condition still applies
there, but a later `@media (max-height:560px) and (pointer:coarse)` block resets
`#left{display:contents}` and
`#left #sidebar{width:min(260px,38vw)!important;flex:0 0 auto!important}` (the
mobile nav block's `flex:1` must be beaten), so the rail + channel sidebar become
persistent columns with the chat beside them — Discord's landscape shape. The
members panel stays a right drawer, and `#btn-menu` / `#btn-nav-close` are hidden
because there is nothing left to overlay; `body.nav-open` is inert there. Never
re-add the full-page nav to landscape, and never key this on width alone.
The members bar is the ONE surface with a breakpoint of its own, and it is
deliberate: below 900px it is a drawer over the chat and above it a static 244px
column, so `MEMBERS_MQ`/`membersDrawerLayout()` in `core.js` is that same 900px
condition (never `phoneLayout()`, which is narrower). One header button drives
both — ui.js routes by layout — and only the column shape collapses, as a
remembered preference (`cf_members_collapsed`); the drawer's open/close is
transient, a remembered collapse is shelved in drawer shape, and the stylesheet's
`body.members-collapsed #members{display:flex}` override is the belt to that
brace. `scripts/test-members-collapse.js` owns all of it.
`#server-ui` is the sidebar's one scroll region (`#home-ui` already was): its
list scrolls under a sticky `#server-header` so a server with more channels than
fit never pushes the me bar off the bottom.
Home's main panel shows one of two no-conversation pages — the Friends feed or
the story center — and they are switched in exactly one place,
`paintHomePanel()` (pins.js): `S.homePanel` is the state, `renderDmBlank()`
routes through it and follows with the nav highlight (`#btn-friends` vs
`#btn-stories`) and the header name, `openHome()` defaults it to `friends`
(`opts.panel` is how a caller asks for the other tab), and `#btn-stories`
runs `showStoriesPanel()`. Every path that hides `#friends-page` must hide
`#stories-page` with it (openServerView, selectDmThread, openCallView,
closeCallView, leaveVoice) — a panel left painted under a channel or a call is
exactly the bug `test-story-center.js` looks for.
The campfire Home button is `openHomeTab()` (settings.js wires it; home.js
defines it): it passes the per-account `cf_home_tab_<uid>` memory from
`readHomeTab()` (core.js) to `openHome({panel, dm})`, so Home comes back to the
DM/group or the Friends/Stories tab you were last on instead of the empty feed.
`rememberHomeTab()` is written by `selectDmThread`, `showFriendsPanel`,
`showStoriesPanel` and cleared by Close DM / Leave chat / a thread that vanished
or was removed — never by leaving Home for a server, which is the whole point.
The restore is the BUTTON's alone: every internal "jump into Home" (a
notification, a DM row, a share target) still calls `openHome()` with nothing
and picks its own conversation right after, so don't make `openHome()` restore
by default. It also runs synchronously inside the click (the blank, then
`selectDmThread(dm, {keepNav: true})` before the roster refreshes) and
`keepNav` is what stops the restore from closing the phone nav page Home
deliberately keeps up.
The me bar's only click target is `#me-open` (the avatar + name), which outlines
itself on hover; the space around mute/deafen/settings is dead, and it never
shows your own active server tag (`paintMe` used to insert one — other people's
rows still carry theirs). On someone else's card — and on their full profile
screen — the picture IS the story button: `paintStoryAvatar` (via
`paintUserCardStory` / `paintProfileStory`) rings it, drops the cropped thumb in
and makes the avatar itself the click/Enter target, and there is no separate
"Watch story" button to re-add on either surface. The profile screen reuses one
`#pf-avatar` element for every profile, so the affordance has to be cleared when
that person has no live story. The story viewer's own header is one real
`<button id="sv-who">` (picture + name + sub): clicking the poster opens *their*
profile — `svClose()` first, because `#profile-backdrop` sits under
`#story-view` in the stack — and `openProfileScreen(uid, fallback)` takes the
story's author object for a poster who is in no loaded roster. That card's
actions are a vertical tab list, not a wrapped row of pills:
build new ones with `ucTabHTML(id, icon, label, ' primary'|' danger')` (`UC_ICONS`
in `pickers.js`, inline SVG — no emoji), and the container is `.uc-tabs`; the
voice-call controls keep the older `.uc-actions` pill row. `friendBtnHTML` takes a
base class + icon flag so the same button serves both the tab list and the plain
profile-screen pill. On a phone tapping the me bar opens that card as a
full-height `.sheet` that slides up from the bottom (`openOwnCard` adds the class
and clears the popup's inline geometry, so `#usercard.sheet` owns it and
`clampUserCard()` must keep bailing on a sheet); desktop keeps the
bottom-anchored popup. The card's closer is a document-level click listener, so
it runs after whatever row opened the card in the SAME click — and with a friend
list refreshed in the last 30s (`ensureFriends()` no-ops) the card is already
painted by then, so a surface that opened one on click looked dead: the Active
Now rail, a 1:1 DM's header name, a ctx-menu "View profile". `openUserCard` now
stamps the click it was asked for (a capture-phase counter, `ucClickSeq`, read
before its first await) and `final.js`'s closer consults `ucOpenedByThisClick()`
— so a new surface that opens a card on click is covered by stamping, never by
being added to the closer's selector list. `.sv-stage` must stay
`touch-action:none` — the story
viewer's swipe-down-to-close rides on raw pointer events, and `pan-y` let the
browser claim the drag and cancel them — and that gesture moves `#story-view`
itself (bars/head/foot travel with the picture, then the overlay slides off the
bottom), never just the stage. A long-press opens its sheet/popup under a finger
that is still down: `suppressHoverFromTouch()` (actions.js) puts `body.touch-hold`
on for anything opened within 1.5s of a touch so the row under that finger does
not paint its `:hover` background as if it were chosen, and every hover a
sheet/ctx menu can paint needs its `body.touch-hold …:hover` override — a new
row style without one is what test-touch-hold-hover.js fails on. Mobile panels
dismiss with `swipeDownToClose()` (final.js): touch events, not pointer events,
because the panel body is a scroll container and a pointer drag at the top is an
overscroll pan the browser cancels; it only engages from the top of the scroller,
and swallows the click the drag would otherwise land on the row underneath. Every
sweepable panel on the phone is wired to it, including the ctx/message `#sheet`,
which is built fresh on each open — so the shared swallow window lives on the
function object (`swipeDownToClose.swallowUntil`, guarded by one document
listener) rather than as a module-level `let`, or wiring a new sheet would add a
document listener per open and the offline `test-swipe-dismiss.js` slice (which
starts at `function swipeDownToClose(`) would not see the variable at all.

**The phone's chat header is the spare one.** Search, notifications, active
threads, pins and the members drawer all move into the `#btn-chat-more` ⋯ sheet
on a phone (styles.css hides the rails, `ui.js` builds the sheet from those same
buttons — including a DM's voice/video call buttons staying on top), so a server
channel reads `☰ #channel ⋯` there. The sheet carries each button's own badge
into its row label, and `#chat-more-count` mirrors the unread-notification count
onto the ⋯ button, because the bell it used to sit on is one of the hidden rails.
A 1:1 DM's header name is a control: `paintHeaderNameTap` marks the header
(`.dm-name-tap`) only for a 1:1, and tapping the name or its `@` opens that
person's card — as the full-height bottom sheet (`userCardAsSheet` via
`openUserCard(..., { sheet })`) on a phone, the popup on desktop. The members
drawer, being a right-hand panel rather than a full-screen page, leaves by a
right-swipe (`swipeRightToClose`) or by a tap outside it — and that tap is
swallowed in the capture phase, so it can no longer reach the message or control
underneath (the header stays exempt, and so does the ⋯ `#sheet`: on a phone that
sheet IS the header — its Members row is how the drawer opens, and reading that
click as "outside" closed the drawer again in the same tick).

**The native shell (`public/js/native.js`) is the phone's navigation contract.**
On a touch device the first touch arms one sentinel history entry
(`cfArm`/`cfBackWanted` — coarse pointers only, so a desktop browser's back
button is never hijacked); a back press pops it, closes exactly ONE thing, and
re-arms, and `CF_BACK_LAYERS` decides what that one thing is, topmost first.
Adding an overlay means adding a layer whose `open()` reads live DOM state and
whose `close()` is the app's OWN closer (back must leave the same state behind
as ✕). Two rules are load-bearing and both were learned by breaking them:
`cfShown()` takes an element **or a selector** (the layer loop wraps every
predicate in try/catch, so a predicate that throws is indistinguishable from
"closed" — nine overlays were silently un-backable that way), and
`test-native-back.js` fails if any layer's `open()` throws, so a typo shows up
as a test failure instead of a dead overlay. Below the overlays come the nav page
and then the conversation → list step (`cfBack`); at the root the shell stops
re-arming, so back leaves the app the way it does in a native app. The same
module owns the edge-swipe (`#left` tracks the finger; `nav-dragging` kills its
transition mid-drag) and the two platform affordances CSS cannot do alone: the
no-op `touchstart` listener that makes `:active` work in Mobile Safari, and the
`html.standalone` / `html.wrapper-app` flags (set by the head script before
first paint, so the installed app can be styled with no flash).

**Interaction rules that make it feel native, and where they live.**
- Press states: every row/control reacts on touch-DOWN via `:active`
  (background one tonal step up; icon buttons also scale to .92). A new
  interactive row belongs in the "Native feel → press states" selector lists or
  it will feel dead under the thumb.
- Tap targets: small controls grow an invisible `::after` hit box to
  `var(--tap)` (44px) under `@media (pointer:coarse)` instead of changing size —
  resizing would re-flow the phone header and break the landscape three-pane fit.
  Only controls that are already in flow get `position:relative` there; an
  absolutely-positioned one (`#stories-nav-add`, the GIF star, the history ✕)
  already contains its own `::after`, and switching it to relative drops it out
  of its pinned corner. `test-native-back.js` asserts the boxes stay clear of
  each other. List rows (`.chan`, `.dmrow`, …) do get a real 44px `min-height`
  on a phone: that is the density change a thumb needs.
- **Hover rules live in ONE `@media (hover:hover)` block at the bottom of
  `styles.css`.** A tap leaves the browser's synthetic `:hover` stuck on the
  last thing touched, which reads as "that control is still selected" — the
  single most web-looking artefact on a phone. A new hover rule that only
  decorates goes in that block; anything that HIDES something until hover (an
  action bar, a row's ✕) instead needs a `@media (hover:none)` rule near its
  base so it is shown unconditionally on touch.
- Motion: drawers/sheets use `var(--t-drawer)`/`var(--t-sheet)` with
  `var(--ease-native)` (decelerating — `ease` reads as a web transition).
  `convoSwapPulse()` (core.js) fades `#messages` on a real conversation change
  only; firing it on every re-render would flicker the chat.
- Empty states are hairline `--line-soft` surfaces, never dashed borders: a
  dashed outline reads as an unfinished placeholder.
- The Home list has ONE trailing column: `.6rem` from the sidebar's edge, which
  is where the Stories row's ＋ is pinned and where every `.dmrow`'s own ✕ sits
  (the row's padding). Any new trailing action in that list — a section header's
  button, a row's control — has to land there too, or it sits visibly out of
  column with the ones above it. `.chan-group-label` carries `.95rem` of right
  padding for its text, so a label that also holds a trailing button needs
  `.chan-group-label.row-between{padding-right:.6rem}`. `test-story-add-entry.js`
  measures both ＋s and fails on any drift.
- The **server** sidebar's Stories row puts its accent ＋ in that same trailing
  column, because it is the same action in the same visual column one list over.
  It is a SIBLING of the row (a `div[role=button]` row cannot hold a button),
  pinned by `#srv-stories .ss-add` inside `.srv-stories-wrap`, and the row pays
  for the slot with `padding-right:2.7rem`. The wrapper must span the sidebar's
  FULL content width: it is the ＋'s containing block, so putting the row's own
  `.45rem` side margin back on the wrapper silently pulls the ＋ 7.2px short of
  Home's and the two lists read out of line again (that margin now lives on
  `.srv-stories` itself). `test-story-sidebar-conn-browser.js` measures the pair
  and fails on any drift.
- The sidebar **voice bar** (`#voice-bar`, the mute/deafen/camera/share widget
  above the me bar) carries a connection chip (`#voice-conn`, `paintVoiceStatus`
  in `voice.js`): Connected in the app green, Connecting…/Reconnecting… in
  amber, Disconnected in red, with the bar's border and the `.live-dot` taking
  the same class. It is driven by the REAL mesh — `voiceConnInfo` reads every
  `RTCPeerConnection.connectionState` plus `S.ws.readyState`, so a peer whose
  link failed keeps the bar amber until it recovers (which is why
  `onconnectionstatechange` retries `renegotiate` instead of tearing the peer
  down: a torn-down peer made the readout green over someone whose audio was
  dead). `#voice-chan-name` must keep its ellipsis or a long room name pushes
  the chip out of the bar.
- The composer field is its own surface (`--field`/`--field-line`, one tonal
  step above the bar), never `--inset` — that is the app's LOGIN-input well and
  it read as a hole punched in the chat. `#in-message` (the transparent
  textarea that owns the caret) and `#in-render` (the backdrop you actually
  see) must keep IDENTICAL padding at every breakpoint or the caret drifts off
  the glyphs; only the surface lives on the backdrop. The leading `+` and the
  tool rail ride the BOTTOM of the box (`#composer` is `align-items:flex-end`)
  so a box grown to several lines keeps every control on one bar, and the `+` is
  32px — small enough to fit its field — with its thumb target coming from a
  `::after` hit box like every other small phone control. The send key reads the
  box (`paintComposerSend`, core.js): muted and disabled when there is nothing
  to send, accent the moment there is. It stays cosmetic — `requestSubmit()`
  still fires with the key disabled, which is how the empty-box draft tests
  exercise the submit path. Repaint it from whatever changes the box: input,
  `renderComposerMeta`, the submit path, and `applyComposerDraft` (every
  channel / DM / thread switch).
Settings is responsive in two shapes:
desktop keeps the side rail, a phone (`max-width:700px`) gets a menu of section
rows (`.settings.menu`) and picking one shows that section alone
(`.settings.section`) with `#settings-back` + `#settings-close-detail` in a
`.set-mhead-detail`; `setSettingsView()` drives those classes, `openSettings()`
with no argument opens the menu (a caller-named tab goes straight to it), and the
rail's own `#settings-close` is mobile-hidden. Your own card's
status is a cascading vertical menu (`presenceWidgetHTML` in `pickers.js`): it
starts as just your current status (that row IS the card's readout on your own
card), opening it lists the states, and picking one cascades that state's timer
underneath its row — the open/cascaded state lives in the module-level
`presenceMenu` and is reset when the card opens, and `refreshOwnPresence`
re-renders the menu in place (never the card) so the open menu survives a status
change. Anything inside the card that replaces its own DOM during a click is why
the card closer decides with `clickInPath()` (composedPath, captured at dispatch)
instead of `e.target.closest('#usercard')`: the in-place swap detaches the node
that was clicked, and a plain `closest()` then reads that click as "outside" and
closes the card the instant you tap your status.
The bottom-pin state (`#messages`/`#thread-replies` `dataset.atBottom`) flips
only on real input (wheel/touch/drag/key) — never on a bare scroll event.
Browsers fire those for their own reasons (reload scroll restore, layout
clamping when the viewport shrinks, native scroll anchoring under late media)
and reading them as "the reader scrolled up" is what stranded pinned views
mid-history after a refresh; the container must also be observed by the stick
ResizeObserver, or a shrunken viewport silently leaves the reader short of the
bottom. The other half of that rule is just as load-bearing: input that IS the
reader's leaves the pin OFF, at any distance. A reader's own upward movement
demotes it immediately (`box._userUpAt`), the 200px near-bottom band may not
hand it back while the box is still travelling up, and `nearLiveBottom()` — the
one predicate every repaint, append, prune and resize asks — treats an explicit
'0' as final until they come back down. One wheel notch is ~100–120px, so
without that a reader who nudged up still counted as pinned and the next resize
(a lazy picture landing above, a reaction bar appearing, a scan card flipping
into its picture) put them back at the bottom: they could never get more than a
notch away, so they could never leave. Two traps found fixing it. **Native
scroll anchoring rewrites `scrollTop`**, so a notch UP can reach the scroll
handler looking exactly like a move DOWN — the direction of the reader's input
(`wheel` deltaY, touch Y travel, recorded by `noteUser`) is what counts, not
only the position delta. And the ResizeObserver must skip a box the reader has
driven input into since our last placement while it is off the bottom, because
a growth can land in the SAME frame as the notch and the scroll event that
demotes them has not run yet.
The story composer is one control, not a mode switch: the shutter takes a photo
on a tap and records while held (220 ms arming; the click path stays for
keyboard and is ignored right after a pointer gesture), a two-finger pinch
zooms (ctrl+wheel on desktop), and a double-tap on the picture flips the
camera. The viewfinder is `object-fit:cover` and zoom is a CSS transform on the
`<video>`; `storyDrawFrame` replays the same numbers into the captured frame,
and a recording that would not match what the preview shows is composited
through a canvas (`storyRecordStream`/`storyNeedsComposite`) rather than
recording the raw sensor stream. Never let those two drift: the shot must be the
rectangle that was on screen.
Story markup (text/emoji/drawing) is a JSON list on the post
(`stories.overlays`, and `dm_messages.viewonce_overlays` for the private
view-once copy a story makes) rendered by `public/js/story-edit.js` in the
composer, the viewer and the view-once player — never baked into the bytes, so
it stays crisp and a video keeps its markup across its whole play. Overlay
coordinates are normalized to the MEDIA's content box (`ovFitLayer`/
`ovContentRect`), so the same numbers land in the same place on a phone capture
and a letterboxed desktop preview; anything that changes that box (rotate,
resize, a tool sheet) must re-fit through `ovRefit`. The layer must stay laid
out while it is editable (`ov-empty` is only for read-only layers) — a
display:none layer measures 0 and the first pen stroke paints into a 1x1
canvas. The client caps and trims the list before sending (`ovSanitize`, 24 KB)
and the server validates it again; the post body is `express.json`, so an
untrimmed stroke list is a 413, not a story.
The story ring has two independent states and they must not be conflated:
`.st-ring.seen` is the ring's own colour (accent while something waits, hairline
once it has been watched) and applies to everyone including your own tile, while
`.st-ring.muted` desaturates the photo and only ever means "you have already
watched someone else's story". Your own story is never muted — you cannot watch
your own post, and greying it turned a flat-coloured text-only story into a dead
grey disc in the rail. Anything pinned above a tool sheet (the colour row, the
tool rail) pays for the sheet's height through `--sheet-h`, and the colour row
switches its dock with `.sheet-open` — stacking the caption slot on top of the
sheet is what shoved the background swatches up near the middle of the screen.
Background swatches are gradient TILES, not circles: the same ramp clipped to a
disk reads as a tilted square shoved inside it. A horizontally scrollable row
clips vertically too (overflow-x:auto drags overflow-y with it), so a swatch row
needs vertical padding or the selected swatch's highlight ring is sliced off.
Ring thumbnails carry the post's markup (`storyThumbWithMarkup` composites the
same overlay list over the media, fitted with `cover` because that is how the
ring crops) — without it a text-only story previews as a bare gradient. A story
posted seconds ago is not servable yet (the /uploads gate answers 423 until the
scan verdict lands), which an `<img>` reads as an error: `storyThumbRetry` gives
it two tries before falling back to the avatar.
Story audiences are friends / whole servers / specific friends only. The
instance-wide `everyone` target was removed on the owner's request: the composer
has no row for it, `normStoryAudiences` (server.js) no longer produces it, and a
client that still asks for it gets a 400 `pick_audience` rather than being
silently re-targeted at friends. The READ side stays on purpose —
`storyVisibleTo`, the tray query, `storyAudienceIds`, the notify fan-out and the
client's `storyData.everyone` merge still understand the kind — so a row posted
before the change keeps reaching its viewers until its 24h expires. Delete that
half only together with a migration for any live `story_audiences` rows.

NEXT: iterate per owner feedback on the live site.

## Verification conventions

- **`node --check <file>` after every JS edit.**
- **Tests:** the per-test catalogue lives in **`docs/TESTING.md`** — one
  entry per `scripts/test-*.js`: exactly what it covers, what it skips on,
  and which source files to re-run it after. It is long on purpose, so read
  the entries for the area you are touching instead of loading it every time.
- **Upload pipeline E2E:** `node scripts/test-upload-pipeline.js` (needs ffmpeg
  + the dev Postgres, skips otherwise) boots a real server against a throwaway
  database with a slow STAND-IN clamd (`scripts/fake-clamd.js`, handed to the
  app as `CLAMAV_HOST`/`CLAMAV_PORT`) and asserts the single-transition compression flow
  for the scan-integrated path plus the detection path (a flagged upload is
  deleted, its row goes `infected`, the gate answers 410, and the message is
  re-broadcast as blocked), then **restarts it with `VIRUS_SCAN=0`** to
  assert the compression-only shape (gated candidate -> one
  transition with no engine, immediate serving for non-candidates, and a
  sweeper rewrite landing on a fresh key with the old bytes untouched), and
  finally covers **story media** and the **bucket reconciliation** (a dry pass
  lists candidates and changes nothing; a real pass repoints a flagless
  avatar to a smaller object; an unreferenced object and a pasted-link-only
  object come back byte-identical; a second pass finds nothing left, which is
  the ledger doing its job). Re-run it after touching `virus-scan.js`,
  `clamav.js`, `media-compress.js`, `storage-sweep.js`, or the upload routes.
  What the scanner was ASKED is read from the stand-in's own log
  (`FAKE_CLAMAV_LOG`) — the candidate's byte count is the tell, since the
  original and the compressor's output are different sizes — and because the
  stand-in speaks the real protocol in-process, the test needs no ClamAV, no
  container and no signature database, and behaves the same in PowerShell and
  Git Bash.
- Smoke test API: `curl localhost:3000/api/config`, register/login flow.
- E2E (register → create server → invite-join → WS live message → history →
  channel create/delete → voice-join signaling) was verified passing; re-run an
  equivalent check after touching `server.js` or the WS protocol.
- **Bump `service-worker.js` CACHE version on any `public/` change** or clients
  keep stale cached shells.
- **A `flex:1` column needs `align-self:stretch`, not just `min-width:0`.** In a
  flex container with `align-items:flex-start` (server settings `.srvset-wrap`),
  a child's CROSS size is fit-content, so one nowrap child — an invite URL in
  `.srvset-content` — widened the mobile COLUMN past its pane and pushed the
  row's Copy/Rename/Revoke buttons off the right of the phone. `align-self:stretch`
  pins the column to the pane and the URL ellipsises;
  `scripts/test-server-invite-row.js` measures it at phone/narrow/desktop widths.
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
  file to the malware scanner and to HTTP at the same time.
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
  itself (`processMedia` -> `media-compress.processUpload`), hands the candidate
  output to the scanner (streamed in from the compressor's own temp file — the
  daemon takes a stream, so the candidate is never published to disk first), and
  only commits it once that verdict is clean. So
  clients see exactly one `pending -> final` transition and a playing file is
  never swapped out from under a running player. Never hand unscanned bytes to
  ffmpeg or publish unscanned output.
- **The slot is not only a scan slot.** `virus-scan`'s worker runs whenever
  scanning **or** compression is on (`slotOn()`), and the serving gate
  (`scanGating`) is tied to the same predicate. With `VIRUS_SCAN=0` it becomes a
  compress-and-publish slot: `processRow` never touches the engine, calls
  `processMedia(key, null)` (no candidate scan to ask for) and marks the row
  clean, which is what lifts the 423. Which uploads wait for it is the upload
  route's call — `queueFileScan(key, {compress: media-compress.isCandidate(...)})`
  — so a file the compressor would never rewrite (a zip, a PDF, an SVG) is
  `clean` immediately, exactly as it is with compression off. Keep those two
  halves in step: gating a file the slot would never settle parks it at 423.
  There is **no size floor**: any size is attempted (the 8% rule is what stops a
  pointless rewrite), so the non-candidates are non-media, not small media.
  `MEDIA_COMPRESS_MIN_KB` restores a flat floor. Coverage is every type the box
  can decode — `planFor` sends any other image through a deferred `still` plan
  that `resolvePlan` settles against the bytes (a **PNG becomes WebP q82** by
  owner decision, alpha preserved, falling back to lossless PNG when libwebp is
  missing; an opaque BMP/TIFF/AVIF/JXL goes to JPEG; a multi-frame file is left
  alone rather than flattened), any video container to
  MP4, any audio codec to MP3/AAC/Opus; SVG stays out on purpose (vector, so a
  raster re-encode degrades instead of shrinks).
  **HEIC/HEIF is the one family the box cannot decode itself.** Alpine's ffmpeg
  is built without libheif, so there is no HEIF demuxer in the image — and no
  Windows browser or viewer can read those bytes either, which left an iPhone
  photo as a download nobody could open (reported). The Dockerfile installs
  `libheif-tools`; `planFor` routes `.heic`/`.heif` (by name, by MIME, or the
  `-sequence` variants) to the `heif` pipeline, and `encodeCandidate` decodes
  through `heif-convert` into a throwaway JPEG before running the ordinary still
  encode on it (2048px cap, q3). The still box is a CAP now
  (`min(2048,iw)`), so a 512px HEIC is never blown up to 2048 — that was the
  old `scale=2048:2048` behaviour, hidden for ordinary images by the 8% rule.
  That plan carries `normalize: true`, and it is the ONE case where
  `shouldPublish` ignores the 8% rule: viewability, not size, is the point, so a
  larger JPEG is published over an original nothing can open. A format change
  also carries the row with it — `kind` follows the new MIME (a HEIC that
  arrived as `application/octet-stream` was filed as a `file`, which the
  candidate query then never looked at) and the display name's extension is
  rewritten (`nameWithExt`), because a `.heic` name over JPEG bytes still picks
  the wrong Windows handler on download. `/api/upload` reads a `.heic`/`.heif`
  name as its MIME when the browser sent none, which is what makes that upload
  an image candidate at all. Missing `heif-convert` is a loud boot line, a null
  plan and a `getMediaStats().heifConvert` of false — never a silent failure.
  A browser that cannot paint a picture still degrades it to a real file card
  (see `attFileCardHTML`), so an unconverted HEIC is a downloadable card rather
  than an outlined box around a filename.
- **A verdict belongs to the policy that produced it.** When a policy widens
  (the size floor went away; PNG stopped being lossless-only), the ledger rows
  it produced have to be handed back to the bucket scan — but exactly once, or
  every boot would re-queue the whole bucket and undo the ledger's purpose.
  `oncePolicy(name, fn)` (migration-time, remembered in `media_compress_meta`)
  is how that is done; the PNG one deletes `kept/no_saving` verdicts on `.png`
  keys. Add a new `oncePolicy` call rather than a bare DELETE in `ensureColumns`.
- **What the sweeper touches is already visible, so it republishes on a NEW
  key.** The queue's `processRow` passes `{visible: true}`, and
  `compressLocked` then mints a fresh key for every commit (`freshKey = !sameFormat
  || visible`): the row (attachment, DM, or story) gets the new url, the client
  repaints from the emitted `message-updated`, and the old key is left for the
  orphan sweep. Nothing is ever rewritten behind a URL someone may be streaming.
  Only the slot keeps the key, because it compresses before anything can fetch
  the bytes. That is also the safety net for the one race the slot cannot close —
  the slot can settle an upload before the message insert creates its
  attachment row (then the file is served uncompressed and upgraded seconds
  later, under a new key, instead of being swapped).
- **The queue is flag-driven, so a scheduled pass lists the bucket.**
  `compressed = 0` on `attachments`/`dm_attachments`/`stories` is the whole
  queue: a table nobody gave a flag to (profile media — avatars, banners,
  sidebar banners, server icons, custom emoji, webhook avatars, the picker's
  `media_history`), an object only a pasted link mentions, and anything an older
  build left behind are all invisible to it. `reconcileBucket()`
  (`MEDIA_SWEEP_EVERY_MS`, hourly on the cluster, leader-locked) lists the
  bucket, and for every object that is referenced, past
  `MEDIA_SWEEP_MIN_AGE_MS`, and **absent from the key ledger** it either runs the
  row path (a flag table points at it) or `compressStandalone` (repoint the
  referencing columns). A profile upload also kicks its own key
  (`kickProfileMedia`), so a new avatar settles in about a second. Two things it
  deliberately does NOT do: compress an unreferenced object (the orphan sweep
  owns those bytes), or repoint an object whose only reference is message text —
  that object is reported as `skippedText` and left byte-for-byte alone, because
  a pasted link has to keep resolving and nothing gets to edit what someone
  typed.
- **`media_compress_keys` is the ledger, and the bucket scan depends on it.**
  One row per storage key the compressor reached a terminal verdict on
  (`compressed` or `kept` — examined and declined); `media_compress_log` cannot
  serve this role, it is a rolling panel feed. Without the ledger a scan
  would re-encode every object every pass, and re-encoding an already-compressed
  photo costs quality, not just CPU. It is seeded at migration time from the
  existing `compressed = 1` rows so the first pass after an upgrade does not
  re-encode the whole chat history. A transient failure is deliberately NOT
  recorded, so a later pass can retry the object.
- **`MEDIA_COMPRESS_CONCURRENCY` encodes at a time, process-wide (default 1).**
  The sweeper, the scan pipeline and the bucket scan all share
  `withCompressLock` (a semaphore, once a plain mutex) and the `inflight` key
  set; the cluster runs 2. Nothing else may spin up an encode of its own —
  adding a path that does would break the one accounting that the memory guard
  and the CPU promise both rest on. `MEDIA_COMPRESS_SLOT_MB` (default 192) makes
  every encode past the first wait until the cgroup actually has that much free,
  because the failure mode of a burst of large videos is the kernel OOM-killing
  the biggest process in the pod — which is not always ffmpeg. The guard reads
  `/sys/fs/cgroup/memory.{max,current}`, is disabled when there is no cgroup to
  read, and never blocks the *first* encode (a queue that will not start cannot
  drain). `MEDIA_COMPRESS_BATCH` (default 1, max 16) is how many rows one tick
  feeds in parallel; it is not the limit — the semaphore is.
- **The queue's tick fans out (`Promise.all`), so a row must be safe to run
  next to another one.** Per-key work is claimed by `inflight` + the DB
  `withKeyLock`, and each job writes its own temp files, so two rows never touch
  the same bytes; a row that throws is caught per row, not per tick.
- **One ffmpeg per file, `-threads 1`, nice 19.** The trick: parallel work
  across files (concurrency), never inside one encode — the box has 1 vCPU, so
  thread count is what keeps the app responsive. `virus-scan`'s
  `reapStuckClaims` leaves a claim alone while `media-compress.isCompressing(key)`
  is true (a slot parked in a long encode is not a stuck slot).
- Scan keys are the storage key (`files/<hex>.png`), derived from the URL — NOT
  the `attachments.id` uid. They are not interchangeable.
- The virus serving gate only covers `files/` (chat attachments); profile media
  (avatars, banners, emoji, icons) is scanned but not gated — which is why its
  compression has to happen after publication (the bucket scan / profile kick),
  under a new key, instead of in the slot.
- **`canvas.toBlob` is not background work on Android.** Blink's
  `canvas_async_blob_creator` encodes on the main thread during idle slices
  whenever `IS_ANDROID`, so a shutter that waits for that callback looks hung
  for seconds — and a busy renderer (camera teardown, the audience list, an
  animating spinner) can starve those slices for tens of seconds: the reported
  "saving takes ~15s". Two rules follow. (1) Encode off the main thread —
  `storyJpegBlob` hands the pixels to a worker with an `OffscreenCanvas`
  (`convertToBlob`), which has no idle scheduling to wait for, and falls back to
  `toBlob` — and the picked-file path falls back to the original file. (2)
  Never gate the flow on the encode: the story composer paints the frozen
  canvas (`.sc-freeze`) over the camera slot, releases the camera, and leaves
  Next live; `storyPostNow` is the one place that waits for `sc.encodePromise`,
  at the last tap, showing "Saving…" on the Post button. Stamp each shot with a
  sequence (`sc.shotSeq`) so a slow encode can't resurrect a retaken shot, and
  keep `storyRevealPreview` from yanking the reader back a step when the bytes
  land mid-audience-pick.
- **A chat image renders a derived 640px WebP preview, not its own bytes**
  (`thumbKeyFor`/`thumbSourceKey`): only `files/` is eligible (`viewonce/` is
  ticket-gated), minting shares `withCompressLock` and never holds a request, and
  the sweep must never list `thumbs/`.

## Environment notes (this dev machine)

- Windows + Git Bash. Each tool call is a fresh shell; `&`-backgrounded
  processes **persist** across calls. Logs to files (e.g. `/tmp/*.log`).
- Kill a stray server via `netstat -ano | grep :PORT` + `taskkill //PID <pid> //F`.
- `node` here is v26; Docker Desktop available (`docker build`/`docker run` verified).

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

- Open ideas: moderation roles beyond owner.
