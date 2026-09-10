# 🔥 Campfire — self-hosted chat + voice

A tiny **Mattermost / Steam-chat alternative** you can host in one Docker container:

- 🛖 **Servers** (guilds) with invite codes — create one, share the code/link, friends join
- 💬 **Text channels** with live chat, history, typing indicators, presence
- 🔊 **Voice rooms** — click to join, talk in-browser (WebRTC, no app needed)
- 🤖 **Channel webhooks** — per-channel bot URLs with their own name + avatar (channel menu → Webhooks)
- 📲 **PWA installable** — friends can "Add to Home Screen" on iPhone/Android and use it like a native app
- 🗄️ **SQLite, zero deps to run** — data lives in one `./data` volume

Stack: Node 22 + Express + `ws` + built-in `node:sqlite`, vanilla-JS frontend. No build step, no native modules, no Redis, no Postgres.

---

## 1. Host it (2 minutes)

**Requirements:** Docker + Docker Compose on anything (VPS, home server, Raspberry Pi, old laptop).

```bash
git clone <this-repo> campfire && cd campfire
cp .env.example .env
# edit .env and set a long random JWT_SECRET:
#   openssl rand -base64 32
docker compose up -d --build
```

Open `http://your-server:3000`, sign up the first account, hit **＋ → Create** a server, then **🎟️ Invite** to get the code/link.

### Reverse proxy (recommended for PWA + voice)

PWA install and microphone access **require HTTPS** (except `localhost`). Put Campfire behind Caddy / Nginx / Traefik with TLS, e.g. `https://chat.example.com` → `http://localhost:3000`. WebSocket (`/ws`) must be proxied too — default configs handle it.

<details><summary>Caddy example</summary>

```
chat.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

</details>

<details><summary>Nginx example</summary>

```nginx
server {
    listen 443 ssl; server_name chat.example.com;
    # ... ssl certs ...
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

</details>

### Option B: full production stack (app + automatic HTTPS, Docker only)

If the host has Docker and a domain pointed at it, this repo ships a
production overlay with Caddy fetching your TLS certificate automatically:

```bash
git clone https://github.com/jreoka/campfire.git && cd campfire
cp .env.example .env
# edit .env: JWT_SECRET=$(openssl rand -base64 32), DOMAIN=chat.example.com, BIND=127.0.0.1
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Open `https://your-domain` — done. Ports 80 and 443 must be reachable for the
certificate challenge.

## 2. Friends join on their phones 📲

1. Send them `https://your-server` + the **invite code** (or the full `?invite=CODE` link).
2. They open it, **Sign up**, enter the code via **＋**.
3. **Install the app:**
   - **Android (Chrome):** menu ⋮ → *Install app / Add to Home Screen*
   - **iPhone (Safari):** Share → *Add to Home Screen*
4. Grant **microphone** permission when joining a voice room.

## 3. Voice notes 🔊

- Voice is **peer-to-peer mesh WebRTC**: perfect for 2–8 friends, no server CPU cost. (Mesh gets heavy past ~8 people.)
- Uses Google's public STUN server by default — works on LAN and most home internet.
- **If friends can't hear each other across networks** (strict NAT), run [coturn](https://github.com/coturn/coturn) and set `TURN_URL / TURN_USER / TURN_PASS` in `.env`, then `docker compose up -d`.

## 4. Without Docker (dev)

```bash
npm install
node scripts/gen-icons.js
JWT_SECRET=dev DB_PATH=./data/campfire.db node server.js
# → http://localhost:3000
```

## 5. Data & backup

Everything persistent lives in `./data/`: `campfire.db` (all chat history,
accounts, servers) plus `uploads/` (attached files, avatars, banners, icons,
emoji). Uploads are stored next to the database on purpose — never next to
the code, which is wiped on every rebuild. Alternatively set `S3_*` in
`.env` (see `.env.example`) to keep media in S3-compatible storage such as
Cloudflare R2 instead of on disk — URLs stay the same, and existing files
move over with `node scripts/migrate-uploads-to-r2.js [--delete]`. Back it
all up by copying the folder while the container is stopped:

```bash
docker compose stop && cp -r data data-backup && docker compose start
```

To reset: `docker compose down && rm -rf data && docker compose up -d`.

When `S3_*` is configured, the database additionally backs itself up to
the top-level `backups/` folder in the bucket: a gzipped snapshot at
00:00 and 12:00 server-local time every day (plus a catch-up run after
boot when the newest backup is stale), keeping the newest 10 dumps
(`BACKUP_KEEP` overrides). Snapshots are taken online — no restart or
downtime. The `backups/` prefix is never served over HTTP, so dump URLs
can't be guessed or fetched; restore one with any S3 client, e.g.:

```bash
aws --endpoint-url https://<account-id>.r2.cloudflarestorage.com \
  s3 cp s3://campfire/backups/campfire-<stamp>.db.gz - | gunzip > campfire.db
```

## 7. Windows desktop app

`app/` is a small Tauri (WebView2) wrapper of the web app — tray icon, start-on-login, and automatic game detection. While a game is running it shows "Playing …" next to your name (separate from your custom status) and logs playtime, which drives per-game levels and day-streaks shown on profile cards. Builds ship via GitHub Releases (`.github/workflows/app-windows.yml`). See `app/README.md`.

Enjoy the campfire. 🔥
