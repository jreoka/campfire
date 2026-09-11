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
                     # pins, compose, story-edit, stories, viewonce, pickers,
                     # settings, security, final
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
  `node scripts/test-friends-voice.js` covers the Active Now IN VOICE rail
  against a throwaway database: the friend-scoped `friends-voice` push, joinable
  rooms carrying server/channel vs nameless unreachable ones, invisible friends
  hidden, DM calls visible only to thread members, and the map following
  join/leave/mod-disconnect/channel-delete/server-eviction.
  `node scripts/test-stories.js` covers stories end-to-end against the dev
  server (audiences, view receipts, delete, 24h reaper) and restarts the dev
  server for the boot-reaper check. It expects the dev Postgres and a
  `JWT_SECRET`-equivalent `.env` (see Running it).
  `node scripts/test-story-start.js` covers where a story tap lands, offline
  (it runs the real `storyStartIndex` pulled out of `stories.js`): in a server,
  a person's row opens that person's first item instead of the tray's oldest
  post, a server row opens its first unseen item, and friend trays keep
  starting at the top.
  `node scripts/test-server-story-chip.js` covers the server sidebar Stories
  row's trailing chip, offline (it runs the real `serverStoryChip` pulled out of
  `stories.js`): an accent "N new" (unseen items) while something waits, a muted
  "SEEN" once everything is watched — never the bare grey author count that read
  as "1 unread" — and no chip at all when the only live post is mine.
  `node scripts/test-status-bubble.js` covers the custom status as a
  thought bubble beside the avatar (offline; it runs the real
  `statusBubbleHTML` pulled out of `pickers.js`): other people only get a bubble
  once they set something (whitespace-only counts as unset), my own card always
  keeps one ("Set a status" placeholder that opens the editor, plus a clear
  button once set), the expiry note only ever shows on my card and never for a
  lapsed timer, the text is escaped, and the old body section
  (`statusEditHTML`/`uc-statusbox`) is gone while the bubble still renders in the
  avatar row.
  `node scripts/test-mobile-nav-mebar.js` covers two surfaces in headless Chrome
  (skips without Chrome): the phone nav is a whole page — it covers the viewport
  edge to edge, the chat behind it is unreachable by hit test, it carries its own
  ✕, and it is off-screen while closed (the scrim, its CSS and its handler are
  gone) — and the me bar's click target is only the avatar + name: the
  mute/deafen/settings buttons are outside it with real dead space between, a
  hit test in that gap lands on the bar (and clicking it opens nothing), the
  avatar/name opens the card, and only the target reads as clickable.
  `node scripts/test-sidebar-banner-edge.js` covers the sidebar-banner ramp in
  headless Chrome (skips without Chrome): the real `paintSidebarBanner` paints a
  white banner at three device scale factors and the row's left edge must stay
  dark while the picture is still visibly painted, plus the recipe assertions
  (`no-repeat`, box-sized ramps) and that all three surfaces (me bar, member
  rows, DM rows) go through the helper instead of re-inlining the old
  cover/repeat style. The harness keeps a "vintage" row with the old recipe so
  it proves it can still reproduce the light edge.
  `node scripts/test-presence-widget.js` covers the presence switcher that now
  lives on your own user card as a vertical menu (offline; it runs the real
  `presenceWidgetHTML`, `statusLineHTML`, `presenceDurationSel`, `choosePresence`
  and `wirePresenceWidget` pulled out of `pickers.js`): it opens as just your
  current status (one collapsed row that doubles as the card's readout, and only
  for your own card — everyone else keeps the plain status line), opening it
  cascades the four states with the current one marked and Online offering no
  timer cascade, picking a state cascades its timer ladder underneath that row
  (with the live timer's nearest step marked and Forever when there is none, plus
  the "Until 3:55 PM" wall-clock note — `fmtUntil`, not a countdown), picking a
  span collapses the menu back to the readout while the card stays open, each row
  is wired to those semantics (a timer row converts its span to a future epoch —
  posting the raw span is a 400 `bad_expiry` the setter swallows, which is how
  DND could stick with no time shown — and applies the state it hangs off rather
  than the live status, re-picking your current state never clears a live timer,
  switching state carries it over, Online drops it, Forever keeps the state), and
  the menu renders in place with the card re-clamped after it grows. It also
  drives the real idle/`poke` block out of `final.js`: activity clears the idle
  auto-away but never a hand-picked one (the marker is per account in storage, so
  a reload keeps an idle Away revertible), and a timed Away keeps its own revert.
  Note the timer labels are the full "For 15 Minutes … Forever" ladder, straight
  from Discord's menu.
  `node scripts/test-user-card-actions.js` covers the card's action tabs, the
  me bar's missing server tag and the avatar-as-story-button (offline for the tab
  builders — it runs the real `ucTabHTML`/`UC_ICONS` out of `pickers.js` and
  `friendBtnHTML` out of `home.js` — then headless Chrome for the real `paintMe`
  and `paintUserCardStory`, skipping without Chrome): the tab rows are icon +
  label, full width and computed `flex-direction: column`, danger/primary are
  tinted, every action id is built through `ucTabHTML` (no `.btn small` pills
  left), the friend button takes the tab shape while the profile screen keeps its
  pill, the me bar renders the name with a tag-returning `tagHTML` stubbed (so a
  regression shows up), clicking the story avatar opens that user's story and
  closes the card (Enter too), a seen story is still labelled "(seen)", no story
  leaves the pfp a plain picture, and your own card never becomes a button.
  `node scripts/test-pin-badge.js` covers the pin button's badge offline (it
  runs the real helpers pulled out of `pins.js` against stub globals): a pin is
  "new" until this account opens the panel in that conversation, pinning
  something yourself is never news, the memory is per account / per channel / per
  DM and survives a reload, an emptied pin list drops it, the store is capped
  (60 conversations, 90-day TTL), the server copy is merged in without un-reading
  anything, local reads are POSTed (coalesced) and a memory the server never
  received is pushed back.
  `node scripts/test-pin-badge-browser.js` drives the real page the same way
  (`test-drafts-browser.js`'s harness, second account joins by invite and pins
  over plain HTTP) and proves the badge lifecycle end to end: no badge for a pin
  I made, "1" for a pin someone else made (still there after a reload), gone
  after opening the panel, still gone after another reload. It also proves the
  cross-device memory: a browser with no localStorage pulls the server copy
  (1 new, not 3) and a read made elsewhere clears the badge here live, over the
  `pin-seen` push, with no reload. Skips when Postgres or Chrome is missing.
  `node scripts/test-pin-seen-sync.js` covers that server side against a
  throwaway database: the same account can read its memory back, its other
  sockets get the `pin-seen` push, other accounts hear nothing, an emptied list
  deletes the row, ids are deduped/capped and contexts and auth are validated,
  and the table stays bounded (200 conversations per account).
  `node scripts/test-games-manager.js` covers Settings → Games' server routes
  against a throwaway database: the manager payload (totals, per-game level +
  streak, live game), ignore / un-ignore one game by name, an ignored game that
  has no stats staying listed and being recoverable, removing playtime leaving
  detection and the ignore list alone, a watcher beacon re-tracking a game whose
  record was wiped, "remove all playtime" keeping the ignore list, "track all
  again" clearing it, and name validation + auth on every route.
  `node scripts/test-games-tab-browser.js` drives the real tab in headless
  Chrome (same harness as `test-drafts-browser.js`) and proves the UI offers
  those controls: the summary/chips/rows render, the row menu toggles
  Ignored → Track again, an ignored game with no playtime is listed, search
  filters in place, tracking by name works, "Remove all playtime" wipes stats
  but never the ignore list, and the state survives a reload. Writes
  `campfire-games-tab.png` to the temp dir. Skips when Postgres or Chrome is
  missing.
  `node scripts/test-mobile-home-nav.js` drives the real page in headless Chrome
  at a phone viewport against a throwaway database and pins that behavior: the
  campfire Home button tapped with a real touch keeps the nav page up (still
  slid in, chat behind it unreachable) while landing on Home with no
  conversation selected, and the clear is synchronous so the DM that was open is
  not left painted under the page while the roster refreshes are in flight —
  plus Home from inside a server leaves the home lists, with a DM row in the
  panel to pick, and picking it closes the page and opens that DM (the ✕ still
  closes too). Skips when Postgres or Chrome is missing.
  `node scripts/test-group-dm-settings.js` covers group chat settings. The
  offline half slices the real `dmMenuItems` out of `home.js` (a group row
  offers Edit group chat / Add members / Leave, a 1:1 row keeps Close DM and
  nothing else), the real `tagHTML` out of `core.js` (`tagHTML(u, true)` renders
  a decorative pill with no `data-tag-sid`/role/tabindex, which is what the DM
  sidebar passes so the tag cannot steal the tap into its server mini-panel),
  and that `actions.js` routes a coarse-pointer hold on `[data-dmthread]` to
  `openDmSheet` and the stylesheet opts `.server-btn,.chan,.dmrow,.member` out
  of text selection. It also pins group removal: `canRemoveGroupMember`
  (actions.js) is the one rule — creator only, never yourself, never the
  creator, never a 1:1 — `groupRemoveTabHTML` (pickers.js) turns it into the
  card's danger Remove tab, the row-menu item goes through the same predicate,
  and the card only looks the open thread up in home view. Against a throwaway
  database the `PATCH /api/dms/:tid` route is pinned: members rename/describe, a
  non-member gets 404, a 1:1 gets `not_group`, a blank body gets
  `nothing_to_update`, a blank name falls back to "Group chat", name caps at 40
  and description at 300 after trim + newline squash, and every member gets the
  live `dm-threads-changed`. The
  `POST /api/dms/:tid/members/:uid/remove` route is pinned the same way:
  auth 401, a non-creator member gets `creator_only`, the creator cannot remove
  themselves (`cannot_remove`), a stranger and a second attempt get
  `not_member`, a 1:1 gets `not_group`, and a real removal pushes
  `removed-from-dm` to the removed member, drops the group from their list and
  posts the "was removed" system line. Skips the API half when Postgres is down.
  `node scripts/test-group-dm-browser.js` drives the real page in headless
  Chrome at a phone viewport with real touch events against a throwaway
  database (skips without Postgres or Chrome): a long-press on a group row
  opens the `.sheet` headed by the group name with Edit group chat and never
  the desktop `#ctx-menu`, the row opens the settings modal prefilled, saving
  repaints the sidebar row, the open header name and the description as the
  topic line; a 1:1 row gets the sheet too (Close DM, no group settings); the
  hold selects no text (`user-select:none` on the rows); and clicking the plain
  tag in a DM row opens the conversation without opening `#tagcard`. It also
  removes a member for real: the member row's right-click menu and the user
  card both carry Remove for the group creator, the card shows no server
  Kick/Ban in a group, clicking it confirms first, closes the card, and the
  member really leaves the group (sidebar repaints, system line lands in chat).
  Writes `campfire-group-dm-sheet.png` and `campfire-group-dm-card.png` to the
  temp dir.
  `node scripts/test-anow-strip.js` covers the phone's Active Now strip in
  headless Chrome at a phone viewport with injected friends: the strip sits
  under Stories and above DIRECT MESSAGES, one tile per online friend (the one
  in a room first), the row really scrolls horizontally, only a reachable voice
  room offers Join, it disappears when nobody is online, it stays out of the
  way on desktop (where `#members` is the rail), and it stays fed while a DM is
  open. Writes phone/desktop screenshots to the temp dir. Skips when Postgres
  or Chrome is missing.
  `node scripts/test-mobile-landscape.js` covers the phone held sideways, the
  one gate on the whole landscape fix: every mobile @media block in styles.css
  must carry `(max-width:700px), (max-height:560px) and (pointer:coarse)` (the
  members drawer, the full-page nav, settings/profile sheets), no module may
  decide layout on the raw 700px width query any more, and in headless Chrome
  over CDP (touch emulation is what makes `pointer:coarse` true) the shell at
  852x393 / 667x375 / 915x412 must be Discord's three-pane shape — the server
  rail + channel sidebar are persistent columns on the left, the chat takes the
  rest of the width beside them, the portrait full-page nav (`body.nav-open`) is
  inert there (it must move nothing), and the chat ☰ / nav ✕ are hidden — with
  the members panel an off-screen right drawer (never a static column), header
  buttons unclipped and non-overlapping, every bottom sheet/modal/profile
  fitting the short viewport, and the story composer's tool rail clearing the
  caption slot and the Retake/Next bar. It also fills the sidebar with more
  channels than fit and proves the list scrolls (with a sticky server header)
  while the me bar stays pinned on screen — it used to be pushed off the bottom.
  It also pins that the auth screen
  scrolls to its Log in button in landscape (it used to sit below a 393px
  viewport with nothing able to scroll) and that portrait keeps the full-page
  nav (chat full width) while a short *desktop* window (fine pointer) keeps the
  desktop shell. Skips without Chrome.
  `node scripts/test-viewonce.js` covers view-once messages against the same
dev server: the media gate (unsigned/tampered tickets), per-friend DMs, the
  one-replay lifecycle, and that unopened items never expire.
  `node scripts/test-admin-stats.js` covers the site-admin Overview numbers
  against a throwaway database: distinct-user Online count vs sessions (two
  tabs are one person), invisible users excluded, and the live
  `admin-presence` WS push that keeps the panel current without a refresh.
  `node scripts/test-reports.js` covers message reports end-to-end against a
  throwaway database: members-only reporting (never your own message, once
  while open), the snapshot surviving the message's deletion, admin-only
  access, search/counts, the live `report-new`/`report-updated` pushes and the
  inbox entry, one decision closing every open report on the same message, and
  the delete / delete+disable / disable / ban / dismiss actions.
  `node scripts/test-owner-protection.js` covers the owner lock against a
  throwaway database: a second site admin gets `owner_protected` from every
  account route and from the account-level report actions, the owner still
  manages their own account and other users, and ordinary users are unaffected.
  `node scripts/test-composer-drafts.js` covers the composer draft store
  offline (it runs the real functions pulled out of `core.js`): per-conversation
  keys, filing a keystroke under the conversation it was typed in, sends
  clearing the draft even mid-debounce, TTL/cap pruning and per-account
  isolation. `node scripts/test-drafts-browser.js` drives the real page in
  headless Chrome over CDP against a throwaway database and proves typing
  survives a reload (the auto-updater's exact path) in channels and DMs, that
  conversations keep their own drafts, and that a sent message leaves none.
  Skips when Postgres or Chrome is missing.
  `node scripts/test-composer-preview.js` covers the composer's markdown
  backdrop offline (it runs the real `renderRich` out of `core.js`): in
  `{plain:true}` mode stripping the tags off the preview gives back the
  escaped source text character for character (that is what keeps the
  textarea's caret sitting in the text it looks like it is in — the backdrop
  used to drop `**`/`||`/backticks, which drifted the caret left), markdown
  delimiters stay in the flow (dimmed), message rendering is unchanged, and
  the `#in-render` rules stay metric-neutral (no padding/size/weight/font
  changes — `.spoiler` and `<code>` have to override the generic rules).
  `node scripts/test-friend-click.js` drives the same harness and counts
  `openUserCard` calls: a friend row under All/Online opens the DM and nothing
  else (the row carries `data-uid` for the story ring, and the global
  `[data-uid]` click delegate in `pickers.js` used to stack the card on top),
  the row's Message / More → View profile affordances still work, and a
  pending request row or voice occupant opens exactly one card. Rows that own
  their click declare it with `data-ownclick` — give that attribute to any new
  `data-uid` row with its own click handler, or the delegate will fire too.
  `node scripts/test-story-camera.js` drives the same harness with Chrome's
  fake camera (`--use-fake-device-for-media-stream`) and proves the story
  shutter answers the tap instead of the JPEG encoder: the captured frame is on
  screen in the same frame as the click (`.sc-freeze` = the capture canvas, the
  camera released, Next live immediately), a real `image/jpeg` blob takes over
  once the encoder answers, Retake during an in-flight encode discards the
  stale shot instead of resurrecting it, and posting before the bytes land
  waits for them (Post says "Saving…") and then posts. Skips when Chrome has no
  fake video device. Re-run it after touching the story composer's capture or
  encode path.
  `node scripts/test-story-overlays.js` covers the story-markup model offline
  (it runs the real `ovSanitize`/`ovParse`/`ovContentRect` out of
  `public/js/story-edit.js` and the real `storyDestDims`/`storyDrawFrame` out of
  `public/js/stories.js`, with a recording canvas for the framing math): junk
  items dropped and every number clamped, the text/item/point caps, the payload
  budget (a stroke is dropped before text is, so a post never 413s), the
  normalized-coordinate round trip, and that the capture crops exactly the
  rectangle the cover-fitted preview showed (cover + zoom + pan, pan included
  in the crop). Plus static wiring checks (the four overlay layers, the tool
  markup, `story-edit.js` in the SW shell, no leftover `.sc-mode`).
  `node scripts/test-story-markup-browser.js` drives the real composer end to
  end (same harness + fake camera) and pins the overhaul: the viewfinder covers
  the stage, a two-finger pinch lands at ~2x with the preview transformed to
  match (and `storyNeedsComposite()` true, so what is recorded is what was
  seen), double-tap flips the camera, holding the shutter records and releasing
  it finishes a real video, markup on an empty shot draws on the first stroke,
  text paints as you type and stays centred, undo drops a stroke, a sticker
  drags and a tap on empty space deselects, the post carries the markup through
  the server (which caps/drops what a hostile client sends) and the viewer
  re-renders it over the picture, a text-only story generates a background that
  does not re-shape when the swatch changes, and a story sent to one friend
  keeps its markup in the one-shot player, and that the rail's ring thumbnail
  composites a story's markup (a text-only story used to preview as a bare
  gradient) — including the 423 retry a just-uploaded story needs. Writes
  campfire-story-edit.png / campfire-story-view.png / campfire-story-text.png to
  the temp dir. Skips when Postgres, Chrome or the fake camera is missing.
  Re-run it after touching the composer, the markup renderer or the story
  routes.
  `node scripts/test-story-ring.js` covers the rail ring's cookie-cutter
  thumbnail (offline; runs the real `storyRing()` extracted from `stories.js`,
  plus the overlay model inlined from `story-edit.js`, against the real
  `styles.css` in headless Chrome, skipping when Chrome is missing). It
  screenshots the ring at four device scale factors, at both ring sizes (the
  rail's 58px, the stories sheet's 44px) and in all three states (unwatched /
  watched / your own), asserting no pixel of the avatar behind it survives
  around the photo's edge, that the ring stroke and its gap are still there (so
  "cover the whole ring" can't pass), that the photo is centred, and which
  states are desaturated: only a watched story that isn't yours is muted, because
  greying your own post made a flat-coloured (text-only) story read as a broken
  thumbnail. Re-run it after touching `.st-ring`/`.st-thumb`; Blink flooring the
  avatar's 2.5px border to whole device pixels, and the seen thumbnail's filtered
  layer edge, are what makes the old face peek through — do not reintroduce the
  face behind a live thumbnail.
  `node scripts/test-story-swipe.js` covers swipe-down-to-close in the story
  viewer (offline; runs the real tap-zone + swipe wiring sliced out of
  `stories.js` against the real `#story-view` markup and `styles.css` in headless
  Chrome, skipping without Chrome): `.sv-stage` must compute `touch-action:none`
  (it was `pan-y`, which handed the drag to the scroller and cancelled the
  pointer stream, so the swipe never landed), a downward drag closes whether it
  starts on the picture or on a stage-covering tap zone, and that same drag must
  not step the story (the zones fire on any pointerup unless movement is
  treated as a swipe). The drag moves the WHOLE `#story-view` overlay — bars,
  header (✕/sound/more) and footer travel with the picture 1:1 — and then it
  carries on to `translateY(100%)` off the bottom before the viewer tears down
  (the pending teardown holds the viewer instance, so a close+reopen mid-slide
  can't close the new one). It also pins the rest of the gesture set: short and
  sideways drags neither close nor step (and spring back), plain taps still step
  forward/back, press-and-hold pauses and resumes without stepping, and a quick
  flick never pauses.
  `node scripts/test-swipe-dismiss.js` covers swipe-down-to-dismiss for the
  mobile panels (offline; runs the real `swipeDownToClose` sliced out of
  `final.js` against the real `#profile-backdrop` markup and `styles.css` in
  headless Chrome with real TouchEvents, skipping without Chrome): the profile
  page and the me-bar `.sheet` card follow the finger and close past the
  threshold (the class is only honoured while the card IS a sheet), a drag that
  starts below the top of the scroller or travels upward is left to the scroller
  (`touchmove` is not preventDefaulted), a short drag springs back, and the
  synthetic click a drag produces is swallowed so the row under the finger never
  also fires. Touch events, not pointer events, are the point: the panel body is
  a scroll container, so a pointer drag at the top is an overscroll pan the
  browser cancels. `closeProfileScreen`/`closeUserCard` must clear the inline
  `transform`/`transition`/`animation` the drag leaves behind, or the next open
  skips its entry animation.
  `node scripts/test-video-placeholder.js` covers the video attachment's
  loading state (headless Chrome + a generated mp4, skipping when Chrome or
  ffmpeg is missing; it runs the real `attachmentHTML` video branch and the
  real poster block pulled out of `messages.js` against the real
  `styles.css`): until the captured poster frame lands the element is hidden
  behind `.att-vid-load` (a dark panel with `.att-spin`), the overlay covers
  the video's box exactly and a centre tap lands on it rather than the
  browser's grey play-button placeholder, a captured frame reveals the video
  with a `data:` poster, a failed capture (404) still reveals it instead of
  leaving a stuck spinner, and tapping the overlay on a slow video reveals it
  immediately — the spinner doubles as the play affordance it replaced. Keep
  `revealVideoShell` on both exits of `ensureVideoPoster` or a failed capture
  parks on the spinner forever.
  `node scripts/test-lightbox.js` covers the photo lightbox (headless Chrome,
  skipping without Chrome; it runs the real lightbox block pulled out of
  `pickers.js` against the real `#lightbox` markup and `styles.css`): the
  Download/Close controls live in `#lb-bar`, a fixed safe-area row, so they stay
  fully inside the viewport and hit-testable for tall/wide/square photos on
  phone portrait, phone landscape and desktop (the bug: an unsafetied corner
  anchor on a tall photo sat off the top of the screen); the photo never
  overflows the stage; a single mouse click toggles zoom while touch keeps
  double-tap, and pinch also zooms (panning a zoomed photo does not close it); a
  downward drag past the threshold dismisses the viewer while a
  short drag springs back; a tap on the backdrop or Close closes, a tap on the
  photo does not, and tapping Download does not; and closing/reopening resets the
  zoom.
  `node scripts/test-chan-unread.js` covers unread channel dots (offline; runs
  the real helpers sliced out of `servers.js` against a fake DOM +
  localStorage, then checks the render/socket wiring and stylesheet statically):
  a background message marks its channel and the server's rail icon, the memory
  is per account and survives a reload (and another account never inherits it),
  the store is capped and forgets marks past its TTL, opening a channel clears
  it (and a hidden-tab message on the open channel clears when the tab returns),
  and the row repaints in place.
  `node scripts/test-touch-hold-hover.js` covers the "one row looks already
  selected" bug when a long-press slides its sheet up under a finger that is
  still down (offline; runs the real `suppressHoverFromTouch`/
  `noteTouchStart`/`noteTouchMove` out of `actions.js` against a fake classList
  and clock): nothing is suppressed for a menu that was not opened out of a
  recent touch (`openCtx`/`openCtxSheet`/`openMsgSheet` all call it, so a
  desktop right-click keeps its hover feedback), the class goes on for a
  touch-opened menu and comes off on the next touch or a real move, and the
  stylesheet neutralizes every `:hover` such a menu can paint under
  `body.touch-hold` — the last check sweeps the sheet/ctx hover rules, so a new
  row added without a guard fails the test instead of glowing.
  `node scripts/test-mobile-settings-sheet.js` covers the phone's settings
  master/detail and the me-bar card sheet (offline static checks plus headless
  Chrome at a phone and a desktop viewport, skipping without Chrome — note
  headless clamps the layout viewport to 500px, so the phone case runs at 500).
  It drives the real `openOwnCard` (`security.js`) and the real settings view
  helpers (`settings.js`) against the real `index.html` markup + `styles.css`:
  on a phone the open card carries `.sheet`, with the popup's inline geometry
  cleared so the CSS wins, pinned bottom/full-height/edge-to-edge with a rounded
  top; on desktop there is no sheet class and the 300px popup stays
  bottom-anchored. Settings opens on the menu (rail rows visible, body and
  detail header hidden, rail close hidden), a section row shows it alone with
  back on the left half and close on the right half (and the header fits, so the
  close is never clipped), back returns to the menu, the detail title comes off
  the row label, and the view classes are inert on desktop.
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
The story camera is a Snapchat-style composer: tap the shutter for a photo, hold
it to record (release to stop), pinch to zoom the viewfinder (the capture crops
to what you saw, and a zoomed recording is composited so it matches), double-tap
the picture to flip, text-only stories on a picked gradient, and markup over the
shot — draggable/rotatable/scalable text and emoji stickers plus freehand
drawing with colours and undo, all rendered over the media by the viewer and by
the view-once player (the markup travels with the post, not in the pixels).
A story sent to an individual friend is delivered as a view-once DM instead of
a tray entry (`POST /api/dm/viewonce` with `storyId` re-files the story's bytes
under the gated `viewonce/` prefix), and picks alongside a broadcast audience
get both. Message reports: right-click / long-press → **Report message** (red,
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
opens there. Settings → Games is a full game-activity manager — search,
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
The me bar's only click target is `#me-open` (the avatar + name), which outlines
itself on hover; the space around mute/deafen/settings is dead, and it never
shows your own active server tag (`paintMe` used to insert one — other people's
rows still carry theirs). On someone else's card the picture IS the story button:
`paintUserCardStory` rings it, drops the cropped thumb in and makes the avatar
itself the click/Enter target — there is no separate "Watch story" button to
re-add. That card's actions are a vertical tab list, not a wrapped row of pills:
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
and swallows the click the drag would otherwise land on the row underneath.
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
