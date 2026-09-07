# 🔥 Campfire — self-hosted chat + voice

A tiny **Mattermost / Steam-chat alternative** you can host in one Docker container:

- 🛖 **Servers** (guilds) with invite codes — create one, share the code/link, friends join
- 💬 **Text channels** with live chat, history, typing indicators, presence
- 🔊 **Voice rooms** — click to join, talk in-browser (WebRTC, no app needed)
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

## 6. What it does / doesn't do

✅ accounts, servers, invite codes/links, text channels, persistent history, live typing + presence, voice rooms with mute + speaking ring, mobile-friendly PWA
🚫 no DMs yet, no file uploads, no push notifications when closed, no moderation roles beyond owner (delete channel/server). All easy to add — the code is ~10k lines total, start in `server.js` + `public/js/`.

Enjoy the campfire. 🔥
