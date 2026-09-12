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
                     # the flag-driven queue (chat/DM/stories), the bucket reconciler
                     # (profile media + anything the flags never saw), and the key ledger
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
  Twice-daily off-site snapshots (database + every media object + the cluster's
  Secrets) go to a **Cloudflare R2** bucket, deliberately not the media bucket —
  see `deploy/civo/README.md` §4. Nothing writes to the media bucket's
  `backups/` prefix any more.
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

Live at https://campfire.dill.moe — a **Civo Kubernetes cluster**, namespace
`campfire`. One Civo Small node (1 vCPU / 2 GiB, ~1.14 GiB allocatable) exposed
by a **Cloudflare Tunnel** (no LoadBalancer — it would cost more than the node),
Postgres 18 on a `civo-volume` PVC, coturn in-cluster via `hostNetwork`.
Manifests + runbook: `deploy/civo/`. See **Deployment** below for how to ship.

**The app runs with `VIRUS_SCAN=0` and `MEDIA_COMPRESS` on.** clamd needs ~1 GB
and the node has ~1.14 GiB allocatable, so AV scanning is off. Compression does
NOT depend on it: the `virus-scan` slot runs with no engine as a
compress-and-publish slot, so an upload the compressor would rewrite waits
(gated, "Processing file") until its encode lands and clients still get exactly
one `pending -> final` transition. What it will never touch is served the moment
it lands. Coverage is the whole media tree: chat/DM attachments and **stories**
through the flag-driven queue, and **profile media** (avatars, banners, sidebar
banners, server icons, custom emoji, webhook avatars, the profile picker's
history) through the same compressor, which lists the bucket hourly
(`MEDIA_SWEEP_EVERY_MS`) and settles a fresh profile upload within a second of
it landing. A per-key ledger (`media_compress_keys`) is what keeps any of that
from being re-encoded twice. `MAX_FILE_MB=50`, because S3 mode buffers every
upload in RAM, and `VIRUS_SCAN_CONCURRENCY=1` keeps one download + one ffmpeg in
flight on a box this small. To get scanning back, run one clamd anywhere and set
`CLAM_HOST` — that is config, not code.

**Uploads live in the Civo object store** (`objectstore.nyc1.civo.com`, bucket
`campfire`, path-style addressing), not on disk — so replicas need no shared
filesystem. Secrets are Kubernetes secrets (`campfire-db`, `campfire-secrets`,
`campfire-s3`, `campfire-r2`, `campfire-registry`, `campfire-tunnel`), never
committed.

Shipped: auth, servers/invites, text channels, voice rooms (mesh WebRTC, sidebar
occupants + VAD rings), uploads, emoji (Emojibase set + custom + Klipy GIFs),
replies/threads/reactions/edits/mentions/markdown, presence + statuses, user
cards, tabbed settings, rail folders + DnD, B&W theme, ctx menus, auto-update,
TOTP 2FA + passkeys + sessions, notification inbox, link previews (server-side
OpenGraph/oEmbed unfurl → cached card with thumbnail, SSRF-guarded), stories
(24h photo/video posts with an in-app camera, friend + server audiences,
thumbnails cropped into the rings), view-once messages (one view +
one replay, per-friend DMs, media gated until opened and deleted after use).
The story camera is a Snapchat-style composer: tap the shutter for a photo, hold
it to record (release to stop), pinch to zoom the viewfinder (the capture crops
to what you saw, and a zoomed recording is composited so it matches), double-tap
the picture to flip, no Retake button at all (owner request: the flow is
shoot → preview → next, and `storyRetake()` survives only as the fallback for a
capture whose encode produced no bytes), text-only stories on a picked gradient,
and markup over the shot — draggable/rotatable/scalable text and emoji stickers plus freehand
drawing with colours and undo, all rendered over the media by the viewer and by
the view-once player (the markup travels with the post, not in the pixels).
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
on that message). The pin button's "N new" badge is a per-account memory
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
come back after a reload — including the one the auto-updater fires seconds
after a deploy — and reading a DM on the phone clears the desktop (`dm-read`).
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
there being something to clear; those marks are this account's localStorage
memory, so clearing never talks to the server.
Detail per change lives in `git log` — don't duplicate it here.

## Deployment (owner directive)

**Every change must be deployed to the live production instance** — never stop
at local edits. Finish each task end-to-end: edit → verify → commit → push →
deploy → confirm the live site serves the change.
- Local repo commits to `origin/main` (`https://github.com/jreoka/campfire`).
- Production is the **Civo Kubernetes cluster**, namespace `campfire`. **There is
  no SSH deploy and no `docker compose` in production any more** — the OVH VPS,
  its `docker-compose.prod.yml` and its Caddy setup were retired in the
  migration. The VPS's S3 bucket was deleted too; do not go looking for it.
- Access: `kubectl -n campfire get pods`. **Gotcha:** Civo's kubeconfig puts the
  leaf certificate *and* `k3s-client-ca` in `client-certificate-data`, and k3s
  v1.36 rejects a CA in the client chain with `tls: error decoding message` —
  kubectl then fails on every version. Keep only the leaf in that field.
- Code ships as an **image**, not a git pull. `.github/workflows/container.yml`
  builds and pushes `ghcr.io/jreoka/campfire:sha-<short>` to GHCR on any push to
  `main` touching app files. Packages are private, so the pod pulls via the
  `campfire-registry` imagePullSecret. Then:
  `kubectl -n campfire set image deploy/campfire campfire=ghcr.io/jreoka/campfire:sha-<short>`
  (or edit `deploy/civo/campfire.yaml` and `kubectl apply -f deploy/civo/campfire.yaml`).
- Env-only changes need **no rebuild**: patch the Deployment or its Secret and
  `kubectl -n campfire rollout restart deploy/campfire`.
- Confirm the deploy: `curl https://campfire.dill.moe/api/version` (fingerprint
  changes) and `kubectl -n campfire get pods` → all `1/1 Running`.
- Postgres is a `civo-volume` PVC; media is the Civo bucket. Both survive pod
  restarts. Never delete the PVC or the bucket — the data-safety contract below
  applies unchanged.
- Backups are **off-site in Cloudflare R2** (`r2.js`, `R2_*` env), never in the
  media bucket: 12-hourly snapshots of the pg_dump, every media object and every
  Secret in the namespace, newest `R2_BACKUP_KEEP` (2) retained. Media is stored
  once under `blobs/` and shared between snapshots, so a second snapshot of an
  unchanged bucket uploads nothing. Restore with
  `node scripts/restore-from-r2.js` (`--list` / `--show` / `--fetch` /
  `--restore-media`). `R2_*` is deliberately separate from `S3_*`: getting the
  backup destination wrong must not be able to break media serving, or the
  reverse.
- The pod runs as the `campfire` ServiceAccount, which has a namespace-scoped
  read-only Role on Secrets — that is how a snapshot includes `JWT_SECRET` and
  the tunnel token. The R2 bucket is therefore as sensitive as the cluster:
  `secrets.json` is plaintext-equivalent and contains the R2 keys themselves.
- Voice/TURN: coturn runs in-cluster (`hostNetwork`; 3478/udp+tcp, 3479/tcp,
  relay 49160-49200/udp). `turn.dill.moe` is a **DNS-only** A record to the node
  IP — Cloudflare's proxy does not carry UDP, so TURN can never use the tunnel.
- Two habits worth keeping: an object store is not S3-shaped by default (Civo's
  store rejects the chunked/checksum-trailer PUT that aws-sdk v3 sends for a
  streaming Body — buffer the body), and `<bucket>.<endpoint>` virtual-host
  addressing does not resolve there (use `forcePathStyle`).

Non-obvious rules (learned the hard way): uploads must live on the
persistent volume (never the image layer); new uploads get `?v=` cache keys;
missing `/uploads/*` must 404 (never SPA fallback); bump the SW `CACHE` version
on every `public/` change; navigations are network-first. The instance owner's
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
same guard. Presence is
server-scoped **and** friend-scoped: a friend with no shared server would
otherwise look permanently offline (see `notifyFriends`/`presenceForUsers` in
`server.js`) — any new presence surface must respect both. Friends' voice
activity (`friends-voice`, the Active Now IN VOICE rail) is friend-scoped too:
it is derived from `voiceRooms`, so any path that adds/removes a socket there
must go through `leaveVoice`/`pushFriendsVoice` or the rail shows ghosts. View-once media
lives under `viewonce/` (never `files/`): that prefix is served only with a
signed ticket from `POST /api/dm/:mid/viewonce/open` (a story sent to an
individual friend is copied into `viewonce/` for the same gate), so nothing can
fetch it before the recipient opens the message. Async discipline:
never pass an async callback to map/filter/forEach when results are used
synchronously (use for..of or Promise.all); background timers go through
safeInterval so rejections log instead of crashing. Composer text is never
lost to a reload: every conversation's half-written message lives in a
per-account draft store (`core.js`: `draftSoon`/`flushDrafts`/
`applyComposerDraft`), so any new composer or chat switch must call
`flushDrafts()` before the context changes and `applyComposerDraft()` after it,
and clear the draft when the message actually goes out. The typing strip above the
composer always keeps its slot (`--strip-h`, one text line, transparent, text
fades) — hiding it resizes `#messages` and shoves the conversation up/down.
`#messages` pays for that slot by giving up its bottom padding, and anything
anchored to the composer top stacks `var(--strip-h)` on `var(--composer-h)`.
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
bottom-anchored popup. `.sv-stage` must stay `touch-action:none` — the story
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
bottom.
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
  database with a fake clamd and asserts the single-transition compression flow
  for the scan-integrated path, then **restarts it with `VIRUS_SCAN=0`** to
  assert the compression-only shape the cluster runs (gated candidate -> one
  transition with no clamd, immediate serving for non-candidates, and a
  sweeper rewrite landing on a fresh key with the old bytes untouched), and
  finally covers **story media** and the **bucket reconciliation** (a dry pass
  lists candidates and changes nothing; a real pass repoints a flagless
  avatar to a smaller object; an unreferenced object and a pasted-link-only
  object come back byte-identical; a second pass finds nothing left, which is
  the ledger doing its job). Re-run it after touching `virus-scan.js`,
  `media-compress.js`, `storage-sweep.js`, or the upload routes.
  On Windows run it from Git Bash: its `haveBinaries()` probe shells out to `sh`,
  which a PowerShell session has no PATH entry for, and the scan-mode phase then
  silently exercises the no-engine path instead.
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
  under a running player. Never hand unscanned bytes to ffmpeg or publish
  unscanned output.
- **The slot is not only a scan slot.** `virus-scan`'s worker runs whenever
  scanning **or** compression is on (`slotOn()`), and the serving gate
  (`scanGating`) is tied to the same predicate. With `VIRUS_SCAN=0` it becomes a
  compress-and-publish slot: `processRow` skips every clamd path, calls
  `processMedia(key, null)` (no candidate scan to ask for) and marks the row
  clean, which is what lifts the 423. Which uploads wait for it is the upload
  route's call — `queueFileScan(key, {compress: media-compress.isCandidate(...)})`
  — so a file the compressor would never rewrite (a zip, a 100 KB screenshot) is
  `clean` immediately, exactly as it is with compression off. Keep those two
  halves in step: gating a file the slot would never settle parks it at 423.
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
  bucket, and for every object that is referenced, above the size floor, past
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
  serve this role, it is a rolling 300-row panel feed. Without the ledger a scan
  would re-encode every object every pass, and re-encoding an already-compressed
  photo costs quality, not just CPU. It is seeded at migration time from the
  existing `compressed = 1` rows so the first pass after an upgrade does not
  re-encode the whole chat history. A transient failure is deliberately NOT
  recorded, so a later pass can retry the object.
- **One ffmpeg at a time, process-wide.** The sweeper and the scan pipeline
  share `withCompressLock`/the `inflight` key set; the sweeper skips keys with a
  pass in flight and `virus-scan`'s `reapStuckClaims` leaves a claim alone while
  `media-compress.isCompressing(key)` is true (a slot parked in a long encode is
  not a stuck slot).
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

- Open ideas (not requested yet): DMs, push notifications, moderation roles
  beyond owner. (File/image sharing + custom emoji/GIFs already shipped.)
