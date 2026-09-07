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

**Flat, polished, professional. Never "AI-coded" looking.** Google Material 3 dark theme:
- Tonal green surfaces (no gradients, no shadows — elevation is tonal steps).
  Hairline `outline-variant` dividers between sections; borderless tonal cards,
  pill buttons/chips/inputs, 28px dialogs, expressive radii.
- Primary buttons invert per M3 (light green bg, dark text). Toast is an inverse
  snackbar (light bg, dark text). FAB-style add-server button.
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
cards, tabbed settings, rail folders + DnD, B&W theme, ctx menus, auto-update.
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
