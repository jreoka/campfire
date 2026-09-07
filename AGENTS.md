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
  `app.js`). No framework, no bundler. Served by Express static.
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

## Project structure

```
campfire/
  server.js          # Express API + WebSocket server (chat, presence, voice signaling)
  db.js              # SQLite wrapper + schema (CREATE TABLE IF NOT EXISTS)
  package.json       # deps (express, ws, jsonwebtoken, bcryptjs, cookie-parser)
  Dockerfile         # node:22-alpine, no build tools needed
  docker-compose.yml # one service, ./data volume, requires JWT_SECRET in .env
  .env.example       # template (copy to .env)
  scripts/gen-icons.js  # zero-dep PNG icon generator (runs in Docker build)
  public/
    index.html       # SPA shell (auth view + main view + modals)
    styles.css       # flat professional dark UI (see design rules below)
    app.js           # SPA: auth, servers/channels, WS client, WebRTC mesh, modals
    manifest.webmanifest
    service-worker.js   # bump CACHE ('campfire-vN') on every frontend change
    icons/           # generated PNGs (committed so static serving works w/o build)
  data/              # SQLite db lives here — NEVER delete, gitignored
```

## Design language (owner directive)

**Flat, polished, professional. Never "AI-coded" looking.** Rules:
- Solid colors only (`#1e1f22` base, `#2b2d31` panels, `#17181c` rail, `#33363c`
  hairlines, `#5865f2` accent). **No gradients, no box-shadows, no translucency**
  on surfaces (modal scrim `rgba(0,0,0,.65)` is the only exception).
- 6–8px radii, borderless solid buttons with darker hover states, inputs get
  accent border on focus.
- **No emoji in the UI.** Use inline SVG or plain text labels
  (`Invite`, `···`, `Join voice`, `Mute`/`Unmute`, `muted` tag). Toast copy is
  plain text, no emoji. (Server/channel names are user content — leave alone.)

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

## Status / history (as of 2026-09-07)

- [x] v1 built: auth, servers, invites, text channels, history, typing, presence,
      voice rooms (mesh), PWA shell, Dockerfile + compose, README.
- [x] Verified: local E2E pass + `docker build` + container smoke test
      (API, manifest, icons, register all 200).
- [x] UI pass 1: flat professional redesign (was gradient/shadow), de-emojified.
- [x] Removed in-app PWA install buttons.
- [x] Deployed to https://campfire.dill.moe (DigitalOcean Ubuntu 26.04, Docker 29 +
      Caddy auto-HTTPS via docker-compose.prod.yml, UFW 22/80/443, app on
      loopback :3000). Local test db migrated to /opt/campfire/data. Server .env
      JWT_SECRET matches local .env so existing login tokens kept working.
      Deploy flow: `git pull` in /opt/campfire, then compose up with prod overlay.
- [x] v2 convenience drop (2026-09-07): file uploads (/data/uploads, images/video/audio/files),
      unicode + custom server emoji, Klipy GIF picker (KLIPY_KEY in server .env only,
      proxied via /api/gifs/*), replies w/ quotes + jump, threads side panel,
      emoji reactions + quick react, message editing, presence (online/away/dnd/
      invisible + auto-away + custom status text), hover user cards w/ banners,
      tabbed settings (Profile/Account/Server), animated GIF avatars/banners/icons,
      @mentions + autocomplete + highlight, markdown-lite, image lightbox,
      drag-drop/paste uploads, server icons. E2E-verified incl. live Klipy search.
- [x] v2.1 (2026-09-07): real emoji dataset (Emojibase, 1914 emoji, keyword search,
      built to public/emoji.json via `npm run build:emoji`, lazy-loaded in picker),
      animated GIF thumbnails in picker (xs.gif renditions).
- [x] Upload hardening + live-update fixes (2026-09-07): root-caused crushed server
      icon to uploads living in ephemeral image storage — moved UPLOAD_DIR next to
      DB_PATH (persistent volume), verified files survive rebuilds. Missing uploads
      now 404 (never SPA HTML). Client degrades gracefully (avatars→initials,
      icons→letter, images→file card, dead custom emoji→`:name:` text). Thread reply
      counts re-render live even with the thread panel open. Deploy auto-update:
      server fingerprints code at boot (`/api/version`), clients poll + show a
      Refresh toast (voice-aware, drafts preserved); SW notifies tabs on activate.
- [x] Discord-style voice sidebar (2026-09-07): occupants render under their voice
      channel (avatar + name + muted mic icon, click opens user card) instead of a
      grid above chat. Green VAD rings: each client analyses its own mic and
      broadcasts speech state, so everyone sees who is talking in every room.
      Mute forces speaking off server-side.
      icon to uploads living in ephemeral image storage — moved UPLOAD_DIR next to
      DB_PATH (persistent volume), verified files survive rebuilds. Missing uploads
      now 404 (never SPA HTML). Client degrades gracefully (avatars→initials,
      icons→letter, images→file card, dead custom emoji→`:name:` text). Thread reply
      counts re-render live even with the thread panel open. Deploy auto-update:
      server fingerprints code at boot (`/api/version`), clients poll + show a
      Refresh toast (voice-aware, drafts preserved); SW notifies tabs on activate.
- [ ] NEXT: iterate on features/polish per owner feedback on the live site.
- Open ideas (not requested yet): DMs, file/image sharing, push notifications,
  moderation roles beyond owner.
