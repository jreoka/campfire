const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const webpush = require('web-push');
const db = require('./db');

const PORT = parseInt(process.env.PORT || '3000', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (JWT_SECRET === 'dev-secret-change-me') {
  console.warn('[campfire] WARNING: using default JWT_SECRET. Set JWT_SECRET env var in production!');
}
const ORIGIN = process.env.ORIGIN || ''; // e.g. https://chat.example.com (used for hints only)
const KLIPY_KEY = process.env.KLIPY_KEY || '';

// ---------- app version (powers client auto-update) ----------
// Content hash of backend + frontend: changes exactly when a deploy changes code.
const APP_VERSION = (() => {
  try {
    const h = crypto.createHash('sha1');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : [p];
    });
    for (const f of [path.join(__dirname, 'server.js'), path.join(__dirname, 'db.js'), path.join(__dirname, 'package.json'), ...walk(path.join(__dirname, 'public'))]) {
      try { h.update(fs.readFileSync(f)); } catch {}
    }
    return h.digest('hex').slice(0, 12);
  } catch { return 'dev'; }
})();

// ---------- uploads ----------
// Uploads live next to the database (persistent volume), never next to the code
// (container image layers are ephemeral and wiped on every rebuild).
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(db.DB_PATH), 'uploads');
const MAX_FILE_BYTES = parseInt(process.env.MAX_FILE_MB || '25', 10) * 1024 * 1024;
const MAX_IMG_BYTES = 8 * 1024 * 1024;
const IMG_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const FILE_MIMES = [...IMG_MIMES, 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'application/pdf', 'text/plain', 'text/markdown', 'application/zip'];
const EXT_BY_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'application/pdf': '.pdf', 'text/plain': '.txt', 'text/markdown': '.md', 'application/zip': '.zip' };
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
function uploader(sub, mimes, maxBytes) {
  const dir = path.join(UPLOAD_DIR, sub);
  fs.mkdirSync(dir, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: dir,
      filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + (EXT_BY_MIME[file.mimetype] || '.bin')),
    }),
    limits: { fileSize: maxBytes, files: 1 },
    fileFilter: (req, file, cb) => cb(null, mimes.includes(file.mimetype)),
  });
}
const upFile = uploader('files', FILE_MIMES, MAX_FILE_BYTES);
const upImg = uploader('avatars', IMG_MIMES, MAX_IMG_BYTES);
const upBanner = uploader('banners', IMG_MIMES, MAX_IMG_BYTES);
const upSidebar = uploader('sidebar', IMG_MIMES, MAX_IMG_BYTES);
const upIcon = uploader('icons', IMG_MIMES, MAX_IMG_BYTES);
const upEmoji = uploader('emoji', IMG_MIMES, 4 * 1024 * 1024);
function uploadUrl(sub, file) { return `/uploads/${sub}/${file.filename}?v=${Date.now().toString(36)}`; }
function deleteUploaded(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  const clean = String(url).split('?')[0];
  const p = path.join(UPLOAD_DIR, clean.slice('/uploads/'.length));
  if (path.resolve(p).startsWith(path.resolve(UPLOAD_DIR))) fs.unlink(p, () => {});
}

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.setHeader('Service-Worker-Allowed', '/');
  next();
});
// Pin shell asset URLs to the code fingerprint: a freshly loaded page can never
// mix with stale cached JS/CSS from a previous deploy (different query = different key).
app.get(['/', '/index.html'], (req, res, next) => {
  fs.readFile(path.join(__dirname, 'public', 'index.html'), 'utf8', (err, html) => {
    if (err) return next();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html.replace(/(src|href)="(\/(?:app\.js|styles\.css))"/g, `$1="$2?v=${APP_VERSION}"`));
  });
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/uploads', express.static(UPLOAD_DIR, {
  dotfiles: 'deny', index: false, maxAge: '7d',
  setHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!/\.(png|jpe?g|gif|webp|mp4|webm|mp3|ogg|wav)$/i.test(filePath)) {
      res.setHeader('Content-Disposition', 'attachment');
    }
  },
}));
// Missing uploads must 404 (never fall through to the SPA shell — an HTML page
// served as an image breaks <img> rendering in confusing ways).
app.use('/uploads', (req, res) => res.status(404).json({ error: 'not_found' }));

// ---------- helpers ----------
const uid = () => crypto.randomUUID();
const now = () => Date.now();
const COLORS = ['#5865f2', '#3ba55d', '#ed4245', '#faa81a', '#9b59b6', '#1abc9c', '#e91e63', '#00b0f4'];
const pickColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];

function makeInvite() {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
}
function signToken(user) {
  return jwt.sign({ sub: user.id, u: user.username }, JWT_SECRET, { expiresIn: '30d' });
}
function getTokenFromReq(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  if (req.cookies && req.cookies.cf_token) return req.cookies.cf_token;
  return null;
}
function authRequired(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) return res.status(401).json({ error: 'not_logged_in' });
  try {
    const p = jwt.verify(token, JWT_SECRET);
    const user = db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(p.sub);
    if (!user) return res.status(401).json({ error: 'user_gone' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'bad_token' });
  }
}
function isMember(serverId, userId) {
  return !!db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
}
function serverRoles(sid) {
  return db.prepare('SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC, created_at ASC').all(sid);
}
function isAdmin(sid, uid) {
  const s = getServer(sid);
  if (!s) return false;
  if (s.owner_id === uid) return true;
  return !!db.prepare('SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.server_id = ? AND mr.user_id = ? AND r.admin = 1 LIMIT 1').get(sid, uid);
}
function getServer(serverId) {
  return db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
}
function serverView(serverId) {
  const s = getServer(serverId);
  if (!s) return null;
  const channels = db.prepare("SELECT * FROM channels WHERE server_id = ? ORDER BY type DESC, position ASC, created_at ASC").all(serverId);
  const members = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_color, u.avatar_url, u.banner_url, u.sidebar_banner_url,
           u.status, u.status_text, u.name_color, u.name_gradient,
           CASE WHEN u.id = s.owner_id THEN 'owner' ELSE 'member' END as role
    FROM server_members m JOIN users u ON u.id = m.user_id JOIN servers s ON s.id = m.server_id
    WHERE m.server_id = ? ORDER BY u.display_name COLLATE NOCASE ASC
  `).all(serverId);
  const roleByUser = new Map();
  for (const r of db.prepare('SELECT user_id, role_id FROM member_roles WHERE server_id = ?').all(serverId)) {
    if (!roleByUser.has(r.user_id)) roleByUser.set(r.user_id, []);
    roleByUser.get(r.user_id).push(r.role_id);
  }
  for (const m of members) m.roleIds = roleByUser.get(m.id) || [];
  const roles = serverRoles(serverId);
  return { ...s, channels, members, roles };
}
function publicUser(u) {
  if (!u) return { id: null, username: 'deleted', display_name: 'deleted user', avatar_color: '#555' };
  return {
    id: u.id, username: u.username, display_name: u.display_name, avatar_color: u.avatar_color || '#5865f2',
    avatar_url: u.avatar_url || null, banner_url: u.banner_url || null,
    sidebar_banner_url: u.sidebar_banner_url || null,
    status: u.status || 'online', status_text: u.status_text || '',
    name_color: u.name_color || '', name_gradient: u.name_gradient || '',
    created_at: u.created_at || null,
  };
}
const USER_COLS = 'id, username, display_name, avatar_color, avatar_url, banner_url, sidebar_banner_url, status, status_text, name_color, name_gradient, created_at';

// simple in-memory rate limit for posting messages: 10 msgs / 10s per user
const rl = new Map();
const slowTs = new Map(); // `${channelId}:${userId}` -> last accepted post (slow mode)
function slowBlocked(channelId, userId, secs) {
  if (!secs) return 0;
  const k = channelId + ':' + userId;
  const wait = Math.ceil(((slowTs.get(k) || 0) + secs * 1000 - Date.now()) / 1000);
  if (wait > 0) return wait;
  slowTs.set(k, Date.now());
  return 0;
}
function rateOk(userId) {
  const t = Date.now();
  const arr = (rl.get(userId) || []).filter((x) => t - x < 10000);
  if (arr.length >= 12) return false;
  arr.push(t);
  rl.set(userId, arr);
  return true;
}

// ---------- API ----------
// Client auto-update fingerprint: changes whenever deployed code changes.
app.get('/api/version', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ version: APP_VERSION });
});
app.get('/api/config', (req, res) => {
  const iceServers = [{ urls: process.env.STUN_URL || 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USER || undefined,
      credential: process.env.TURN_PASS || undefined,
    });
  }
  res.json({ iceServers, origin: ORIGIN, turnstileSiteKey: process.env.TURNSTILE_SITEKEY || null });
});

// ---------- Cloudflare Turnstile (login/signup captcha) ----------
// Secret lives in TURNSTILE_SECRET env (never committed). When unset (dev),
// verification is skipped so local register/login keep working.
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '';
if (!TURNSTILE_SECRET) console.warn('[auth] TURNSTILE_SECRET not set — captcha verification disabled');
async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) return true;
  if (!token || typeof token !== 'string') return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json().catch(() => ({}));
    return j.success === true;
  } catch { return false; }
}

app.post('/api/register', async (req, res) => {
  const tsToken = req.body?.turnstile;
  if (!(await verifyTurnstile(tsToken, req.ip))) return res.status(403).json({ error: tsToken ? 'captcha_failed' : 'captcha_required' });
  let { username, password, displayName } = req.body || {};
  username = String(username || '').trim().toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 24);
  displayName = String(displayName || username || '').trim().slice(0, 32);
  password = String(password || '');
  if (!username || username.length < 2) return res.status(400).json({ error: 'bad_username (2-24 chars, a-z 0-9 _ .)' });
  if (password.length < 4) return res.status(400).json({ error: 'password too short (min 4)' });
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'username_taken' });
  const hash = await bcrypt.hash(password, 10);
  const user = { id: uid(), username, display_name: displayName || username, password_hash: hash, avatar_color: pickColor(), created_at: now() };
  db.prepare('INSERT INTO users (id, username, display_name, password_hash, avatar_color, created_at) VALUES (@id,@username,@display_name,@password_hash,@avatar_color,@created_at)').run(user);
  const token = signToken(user);
  res.cookie('cf_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
  res.json({ token, user: publicUser({ id: user.id, username, display_name: user.display_name, avatar_color: user.avatar_color }) });
});

app.post('/api/login', async (req, res) => {
  const tsToken = req.body?.turnstile;
  if (!(await verifyTurnstile(tsToken, req.ip))) return res.status(403).json({ error: tsToken ? 'captcha_failed' : 'captcha_required' });
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim().toLowerCase());
  if (!u) return res.status(401).json({ error: 'invalid_login' });
  const ok = await bcrypt.compare(String(password || ''), u.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid_login' });
  const token = signToken(u);
  res.cookie('cf_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
  res.json({ token, user: publicUser(u) });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('cf_token');
  res.json({ ok: true });
});

app.get('/api/me', authRequired, (req, res) => res.json({ user: publicUser(req.user) }));

app.get('/api/servers', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT s.* FROM servers s JOIN server_members m ON m.server_id = s.id
    WHERE m.user_id = ? ORDER BY s.created_at ASC
  `).all(req.user.id);
  res.json({ servers: rows });
});

app.post('/api/servers', authRequired, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 48);
  if (!name) return res.status(400).json({ error: 'name_required' });
  const s = { id: uid(), name, owner_id: req.user.id, invite_code: makeInvite(), created_at: now() };
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO servers (id,name,owner_id,invite_code,created_at) VALUES (@id,@name,@owner_id,@invite_code,@created_at)').run(s);
    const maxP = db.prepare('SELECT COALESCE(MAX(position),-1) m FROM server_members WHERE user_id = ?').get(req.user.id).m;
    db.prepare('INSERT INTO server_members (server_id,user_id,joined_at,position) VALUES (?,?,?,?)').run(s.id, req.user.id, now(), maxP + 1);
    const mk = (n, type, pos) => db.prepare("INSERT INTO channels (id,server_id,name,type,position,created_by,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(uid(), s.id, n, type, pos, req.user.id, now());
    mk('general', 'text', 0);
    mk('Lobby', 'voice', 0);
  });
  tx();
  res.json({ server: serverView(s.id) });
});

app.get('/api/invite/:code', (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE invite_code = ?').get(String(req.params.code || '').trim());
  if (!s) return res.status(404).json({ error: 'bad_invite' });
  const memberCount = db.prepare('SELECT COUNT(*) c FROM server_members WHERE server_id = ?').get(s.id).c;
  res.json({ name: s.name, description: s.description || '', banner_url: s.banner_url || null, icon_url: s.icon_url || null, memberCount });
});
app.post('/api/servers/join', authRequired, (req, res) => {
  const code = String(req.body?.inviteCode || req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'code_required' });
  const s = db.prepare('SELECT * FROM servers WHERE invite_code = ?').get(code);
  if (!s) return res.status(404).json({ error: 'bad_invite' });
  if (isBanned(s.id, req.user.id)) return res.status(403).json({ error: 'banned' });
  if (!isMember(s.id, req.user.id)) {
    const maxP = db.prepare('SELECT COALESCE(MAX(position),-1) m FROM server_members WHERE user_id = ?').get(req.user.id).m;
    db.prepare('INSERT INTO server_members (server_id,user_id,joined_at,position) VALUES (?,?,?,?)').run(s.id, req.user.id, now(), maxP + 1);
    postServerSys(s.id, `${displayOf(req.user)} joined the server`);
  }
  res.json({ server: serverView(s.id) });
});

app.get('/api/servers/:id', authRequired, (req, res) => {
  if (!isMember(req.params.id, req.user.id)) return res.status(403).json({ error: 'not_member' });
  res.json({ server: serverView(req.params.id) });
});

app.post('/api/servers/:id/channels', authRequired, (req, res) => {
  const { id } = req.params;
  if (!isMember(id, req.user.id)) return res.status(403).json({ error: 'not_member' });
  const s = getServer(id);
  if (!s || !isAdmin(id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  const name = String(req.body?.name || '').trim().replace(/\s+/g, '-').slice(0, 32);
  const type = req.body?.type === 'voice' ? 'voice' : 'text';
  if (!name) return res.status(400).json({ error: 'name_required' });
  const count = db.prepare('SELECT COUNT(*) c FROM channels WHERE server_id = ?').get(id).c;
  const ch = { id: uid(), server_id: id, name, type, position: count, created_by: req.user.id, created_at: now() };
  db.prepare('INSERT INTO channels (id,server_id,name,type,position,created_by,created_at) VALUES (@id,@server_id,@name,@type,@position,@created_by,@created_at)').run(ch);
  broadcastToServer(id, { t: 'channel-new', channel: ch });
  res.json({ channel: ch });
});

app.delete('/api/servers/:id/channels/:chId', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isAdmin(s.id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  const ch = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(req.params.chId, req.params.id);
  if (!ch) return res.status(404).json({ error: 'no_channel' });
  const n = db.prepare('SELECT COUNT(*) c FROM channels WHERE server_id = ?').get(s.id).c;
  if (n <= 1) return res.status(400).json({ error: 'cannot_delete_last_channel' });
  db.prepare('DELETE FROM channels WHERE id = ?').run(ch.id);
  // kick voice occupants out
  const key = s.id + ':' + ch.id;
  for (const c of voiceRooms.get(key) || []) {
    c.voice = null;
    safeSend(c, { t: 'voice-kicked', serverId: s.id, channelId: ch.id });
  }
  voiceRooms.delete(key);
  broadcastToServer(s.id, { t: 'channel-deleted', channelId: ch.id, serverId: s.id });
  res.json({ ok: true });
});

app.patch('/api/servers/:id/channels/:chId', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isAdmin(s.id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  const ch = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(req.params.chId, s.id);
  if (!ch) return res.status(404).json({ error: 'no_channel' });
  const sets = [], params = [];
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim().replace(/\s+/g, '-').slice(0, 32);
    if (!name) return res.status(400).json({ error: 'name_required' });
    sets.push('name = ?'); params.push(name);
  }
  if (req.body?.description !== undefined) {
    sets.push('description = ?'); params.push(String(req.body.description).slice(0, 200));
  }
  if (req.body?.slowmode !== undefined) {
    const sm = Number(req.body.slowmode);
    sets.push('slowmode = ?'); params.push([0, 5, 10, 30, 60, 300].includes(sm) ? sm : 0);
  }
  if (sets.length) {
    params.push(ch.id);
    db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }
  broadcastToServer(s.id, { t: 'server-updated', server: serverView(s.id) });
  res.json({ ok: true });
});

app.post('/api/servers/:id/leave', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (s.owner_id === req.user.id) return res.status(400).json({ error: 'owner_cannot_leave_delete_instead' });
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(s.id, req.user.id);
  postServerSys(s.id, `${displayOf(req.user)} left the server`);
  broadcastToServer(s.id, { t: 'member-left', serverId: s.id, userId: req.user.id });
  res.json({ ok: true });
});

app.delete('/api/servers/:id', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (s.owner_id !== req.user.id) return res.status(403).json({ error: 'owner_only' });
  db.prepare('DELETE FROM servers WHERE id = ?').run(s.id);
  broadcastToServer(s.id, { t: 'server-deleted', serverId: s.id });
  res.json({ ok: true });
});

app.post('/api/servers/:id/invite/reset', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isAdmin(s.id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  const code = makeInvite();
  db.prepare('UPDATE servers SET invite_code = ? WHERE id = ?').run(code, s.id);
  broadcastToServer(s.id, { t: 'invite-updated', serverId: s.id, invite_code: code });
  res.json({ invite_code: code });
});

// Invite friends to a server by picking them: each gets a DM with the invite link.
// Only existing friends can be picked (DMs require friendship).
app.post('/api/servers/:id/invite-friends', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isMember(s.id, req.user.id)) return res.status(403).json({ error: 'not_member' });
  const ids = [...new Set((req.body?.userIds || []).map(String))].filter((v) => v !== req.user.id).slice(0, 20);
  if (!ids.length) return res.status(400).json({ error: 'no_users' });
  const link = `${ORIGIN}/?invite=${s.invite_code}`;
  let sent = 0;
  for (const oid of ids) {
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(oid)) continue;
    if (!areFriends(req.user.id, oid)) continue;
    if (isMember(s.id, oid)) continue;
    // reuse the existing 1:1 thread or create one
    let tid = null;
    const mine = db.prepare('SELECT thread_id FROM dm_members WHERE user_id = ?').all(req.user.id).map((r) => r.thread_id);
    for (const x of mine) {
      const gt = db.prepare('SELECT * FROM dm_threads WHERE id = ? AND (is_group IS NULL OR is_group = 0)').get(x);
      if (!gt) continue;
      const mems = db.prepare('SELECT user_id FROM dm_members WHERE thread_id = ?').all(x).map((r) => r.user_id);
      if (mems.length === 2 && mems.includes(oid)) { tid = x; break; }
    }
    if (!tid) {
      tid = uid();
      db.transaction(() => {
        db.prepare('INSERT INTO dm_threads (id,name,is_group,created_by,created_at) VALUES (?,?,?,?,?)').run(tid, '', 0, req.user.id, now());
        db.prepare('INSERT INTO dm_members (thread_id,user_id,joined_at) VALUES (?,?,?)').run(tid, req.user.id, now());
        db.prepare('INSERT INTO dm_members (thread_id,user_id,joined_at) VALUES (?,?,?)').run(tid, oid, now());
      })();
    }
    db.prepare('UPDATE dm_members SET hidden = 0 WHERE thread_id = ?').run(tid);
    const mid = uid();
    db.prepare('INSERT INTO dm_messages (id,thread_id,user_id,content,created_at) VALUES (?,?,?,?,?)')
      .run(mid, tid, req.user.id, `Join my server "${s.name}"! ${link}`, now());
    dmNotify(tid, { t: 'dm-new', message: fullDm(mid, null) });
    notifyUser(oid, { t: 'dm-threads-changed' });
    sent++;
  }
  res.json({ sent });
});

app.post('/api/servers/:id/members/:uid/kick', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isAdmin(s.id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  const target = String(req.params.uid);
  if (target === s.owner_id) return res.status(400).json({ error: 'cannot_kick_owner' });
  if (target !== req.user.id && isAdmin(s.id, target) && s.owner_id !== req.user.id) return res.status(403).json({ error: 'cannot_kick_admin' });
  if (!isMember(s.id, target)) return res.status(404).json({ error: 'not_member' });
  const u = publicUser(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(target));
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(s.id, target);
  postServerSys(s.id, `${displayOf(u)} was kicked`);
  broadcastToServer(s.id, { t: 'member-left', serverId: s.id, userId: target });
  evictFromServer(s.id, target);
  notifyUser(target, { t: 'removed-from-server', serverId: s.id, reason: 'kicked' });
  res.json({ ok: true });
});

app.post('/api/servers/:id/members/:uid/ban', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isAdmin(s.id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  const target = String(req.params.uid);
  if (target === s.owner_id) return res.status(400).json({ error: 'cannot_kick_owner' });
  if (target !== req.user.id && isAdmin(s.id, target) && s.owner_id !== req.user.id) return res.status(403).json({ error: 'cannot_kick_admin' });
  if (!isMember(s.id, target)) return res.status(404).json({ error: 'not_member' });
  const reason = String(req.body?.reason || '').trim().slice(0, 140);
  const u = publicUser(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(target));
  db.transaction(() => {
    db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(s.id, target);
    db.prepare('INSERT OR IGNORE INTO server_bans (server_id,user_id,reason,created_at) VALUES (?,?,?,?)').run(s.id, target, reason, now());
  })();
  postServerSys(s.id, `${displayOf(u)} was banned`);
  broadcastToServer(s.id, { t: 'member-left', serverId: s.id, userId: target });
  evictFromServer(s.id, target);
  notifyUser(target, { t: 'removed-from-server', serverId: s.id, reason: 'banned' });
  res.json({ ok: true });
});

app.get('/api/servers/:id/bans', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isAdmin(s.id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  const rows = db.prepare('SELECT user_id, reason, created_at FROM server_bans WHERE server_id = ? ORDER BY created_at DESC').all(s.id);
  const bans = rows.map((r) => {
    const u = publicUser(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(r.user_id));
    return { ...u, reason: r.reason || '', banned_at: r.created_at };
  });
  res.json({ bans });
});

app.delete('/api/servers/:id/bans/:uid', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isAdmin(s.id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  const target = String(req.params.uid);
  db.prepare('DELETE FROM server_bans WHERE server_id = ? AND user_id = ?').run(s.id, target);
  const u = publicUser(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(target));
  postServerSys(s.id, `${displayOf(u)} was unbanned`);
  res.json({ ok: true });
});

// ---------- roles ----------
const ROLE_COLOR = /^#[0-9a-fA-F]{6}$/;
app.post('/api/servers/:id/roles', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isAdmin(s.id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  const name = String(req.body?.name || '').trim().slice(0, 32);
  if (!name) return res.status(400).json({ error: 'name_required' });
  const color = ROLE_COLOR.test(String(req.body?.color || '')) ? String(req.body.color) : '';
  const maxP = db.prepare('SELECT COALESCE(MAX(position),-1) m FROM roles WHERE server_id = ?').get(s.id).m;
  const r = { id: uid(), server_id: s.id, name, color, hoist: 0, admin: 0, position: maxP + 1, created_at: now() };
  db.prepare('INSERT INTO roles (id,server_id,name,color,hoist,admin,position,created_at) VALUES (@id,@server_id,@name,@color,@hoist,@admin,@position,@created_at)').run(r);
  broadcastToServer(s.id, { t: 'server-updated', server: serverView(s.id) });
  res.json({ role: r });
});
app.patch('/api/servers/:id/roles/:rid', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isAdmin(s.id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  const r = db.prepare('SELECT * FROM roles WHERE id = ? AND server_id = ?').get(req.params.rid, s.id);
  if (!r) return res.status(404).json({ error: 'no_role' });
  const sets = [], params = [];
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim().slice(0, 32);
    if (!name) return res.status(400).json({ error: 'name_required' });
    sets.push('name = ?'); params.push(name);
  }
  if (req.body?.color !== undefined) {
    const color = String(req.body.color);
    if (color && !ROLE_COLOR.test(color)) return res.status(400).json({ error: 'bad_color' });
    sets.push('color = ?'); params.push(color || '');
  }
  if (req.body?.hoist !== undefined) { sets.push('hoist = ?'); params.push(req.body.hoist ? 1 : 0); }
  if (req.body?.admin !== undefined) {
    if (req.body.admin && s.owner_id !== req.user.id) return res.status(403).json({ error: 'owner_only' });
    sets.push('admin = ?'); params.push(req.body.admin ? 1 : 0);
  }
  if (sets.length) {
    params.push(r.id);
    db.prepare(`UPDATE roles SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }
  broadcastToServer(s.id, { t: 'server-updated', server: serverView(s.id) });
  res.json({ ok: true });
});
app.delete('/api/servers/:id/roles/:rid', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isAdmin(s.id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  db.prepare('DELETE FROM roles WHERE id = ? AND server_id = ?').run(req.params.rid, s.id);
  broadcastToServer(s.id, { t: 'server-updated', server: serverView(s.id) });
  res.json({ ok: true });
});
app.post('/api/servers/:id/roles/:rid/members', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isAdmin(s.id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  const r = db.prepare('SELECT * FROM roles WHERE id = ? AND server_id = ?').get(req.params.rid, s.id);
  if (!r) return res.status(404).json({ error: 'no_role' });
  const target = String(req.body?.userId || '');
  if (!isMember(s.id, target) || target === s.owner_id) return res.status(400).json({ error: 'bad_member' });
  db.prepare('INSERT OR IGNORE INTO member_roles (server_id,user_id,role_id) VALUES (?,?,?)').run(s.id, target, r.id);
  broadcastToServer(s.id, { t: 'server-updated', server: serverView(s.id) });
  res.json({ ok: true });
});
app.delete('/api/servers/:id/roles/:rid/members/:uid', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isAdmin(s.id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  db.prepare('DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?').run(s.id, String(req.params.uid), req.params.rid);
  broadcastToServer(s.id, { t: 'server-updated', server: serverView(s.id) });
  res.json({ ok: true });
});

app.post('/api/servers/:id/banner', authRequired, imgSingle(upBanner), (req, res) => {
  const s = getServer(req.params.id);
  if (!s) { deleteUploaded(uploadUrl('banners', req.file)); return res.status(404).json({ error: 'no_server' }); }
  if (!isAdmin(s.id, req.user.id)) { deleteUploaded(uploadUrl('banners', req.file)); return res.status(403).json({ error: 'owner_only' }); }
  const url = uploadUrl('banners', req.file);
  deleteUploaded(s.banner_url);
  db.prepare('UPDATE servers SET banner_url = ? WHERE id = ?').run(url, s.id);
  broadcastToServer(s.id, { t: 'server-updated', server: serverView(s.id) });
  res.json({ server: serverView(s.id) });
});
app.delete('/api/servers/:id/banner', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isAdmin(s.id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  deleteUploaded(s.banner_url);
  db.prepare('UPDATE servers SET banner_url = NULL WHERE id = ?').run(s.id);
  broadcastToServer(s.id, { t: 'server-updated', server: serverView(s.id) });
  res.json({ server: serverView(s.id) });
});

app.get('/api/servers/:id/channels/:chId/messages', authRequired, (req, res) => {
  const { id, chId } = req.params;
  if (!isMember(id, req.user.id)) return res.status(403).json({ error: 'not_member' });
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
  const around = String(req.query.around || '');
  if (around) {
    // context window around one message (for jump-to-pin): half older, half newer
    const target = db.prepare('SELECT * FROM messages WHERE id = ? AND server_id = ? AND channel_id = ? AND thread_root_id IS NULL').get(around, id, chId);
    if (!target) return res.status(404).json({ error: 'no_message' });
    const half = Math.floor(limit / 2);
    const older = db.prepare('SELECT id FROM messages WHERE server_id = ? AND channel_id = ? AND thread_root_id IS NULL AND created_at <= ? ORDER BY created_at DESC LIMIT ?').all(id, chId, target.created_at, half + 1).map((r) => r.id);
    const seen = new Set(older);
    const newer = db.prepare('SELECT id FROM messages WHERE server_id = ? AND channel_id = ? AND thread_root_id IS NULL AND created_at > ? ORDER BY created_at ASC LIMIT ?').all(id, chId, target.created_at, Math.max(0, limit - older.length)).map((r) => r.id).filter((x) => !seen.has(x));
    const msgs = [...older, ...newer].map((x) => fullMessage(x, req.user.id)).filter(Boolean)
      .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
    return res.json({ messages: msgs });
  }
  const before = parseInt(req.query.before || String(Date.now() + 1), 10);
  const rows = db.prepare(`
    SELECT m.*, u.username, u.display_name, u.avatar_color, u.avatar_url,
           p.content AS p_content, pu.display_name AS p_name
    FROM messages m LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN messages p ON p.id = m.reply_to_id
    LEFT JOIN users pu ON pu.id = p.user_id
    WHERE m.server_id = ? AND m.channel_id = ? AND m.thread_root_id IS NULL AND m.created_at < ?
    ORDER BY m.created_at DESC LIMIT ?
  `).all(id, chId, before, limit);
  res.json({ messages: hydrateMessages(rows.reverse(), req.user.id) });
});

app.delete('/api/messages/:mid', authRequired, (req, res) => {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.mid);
  if (!m) return res.status(404).json({ error: 'no_message' });
  const s = getServer(m.server_id);
  const canDelete = m.user_id === req.user.id || (s && isAdmin(s.id, req.user.id));
  if (!canDelete) return res.status(403).json({ error: 'forbidden' });
  db.prepare('DELETE FROM messages WHERE id = ?').run(m.id);
  if (db.prepare('DELETE FROM message_pins WHERE message_id = ?').run(m.id).changes) {
    broadcastToServer(m.server_id, { t: 'pins-changed', serverId: m.server_id, channelId: m.channel_id });
  }
  broadcastToServer(m.server_id, { t: 'message-deleted', serverId: m.server_id, channelId: m.channel_id, messageId: m.id });
  res.json({ ok: true });
});

// ---------- pinned messages (server channels) ----------
function pinInfo(pinRow) {
  const u = pinRow.pinned_by ? db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(pinRow.pinned_by) : null;
  return { pinned_at: pinRow.created_at, pinned_by: u ? { id: u.id, display_name: u.display_name, username: u.username } : null };
}
app.get('/api/servers/:id/channels/:chId/pins', authRequired, (req, res) => {
  const { id, chId } = req.params;
  if (!isMember(id, req.user.id)) return res.status(403).json({ error: 'not_member' });
  const rows = db.prepare('SELECT * FROM message_pins WHERE server_id = ? AND channel_id = ? ORDER BY created_at DESC LIMIT 50').all(id, chId);
  const pins = [];
  for (const p of rows) {
    const full = fullMessage(p.message_id, req.user.id);
    if (full) pins.push({ ...full, ...pinInfo(p) });
  }
  res.json({ pins });
});
app.post('/api/servers/:id/channels/:chId/pins', authRequired, (req, res) => {
  const { id, chId } = req.params;
  if (!isMember(id, req.user.id)) return res.status(403).json({ error: 'not_member' });
  const mid = String(req.body?.messageId || '');
  const m = db.prepare('SELECT * FROM messages WHERE id = ? AND server_id = ? AND channel_id = ? AND thread_root_id IS NULL').get(mid, id, chId);
  if (!m) return res.status(404).json({ error: 'no_message' });
  if (db.prepare('SELECT 1 FROM message_pins WHERE message_id = ?').get(mid)) return res.status(409).json({ error: 'already_pinned' });
  db.prepare('INSERT INTO message_pins (server_id,channel_id,message_id,pinned_by,created_at) VALUES (?,?,?,?,?)').run(id, chId, mid, req.user.id, now());
  broadcastToServer(id, { t: 'pins-changed', serverId: id, channelId: chId });
  res.json({ ok: true });
});
app.delete('/api/servers/:id/channels/:chId/pins/:mid', authRequired, (req, res) => {
  const { id, chId, mid } = req.params;
  if (!isMember(id, req.user.id)) return res.status(403).json({ error: 'not_member' });
  const p = db.prepare('SELECT * FROM message_pins WHERE message_id = ? AND server_id = ? AND channel_id = ?').get(mid, id, chId);
  if (!p) return res.status(404).json({ error: 'not_pinned' });
  if (p.pinned_by !== req.user.id && !isAdmin(id, req.user.id)) return res.status(403).json({ error: 'forbidden' });
  db.prepare('DELETE FROM message_pins WHERE message_id = ?').run(mid);
  broadcastToServer(id, { t: 'pins-changed', serverId: id, channelId: chId });
  res.json({ ok: true });
});

// ---------- uploads ----------
app.post('/api/upload', authRequired, (req, res, next) => {
  upFile.single('file')(req, res, (err) => {
    if (err) return res.status(413).json({ error: 'file_too_large (max ' + Math.round(MAX_FILE_BYTES / 1048576) + 'MB)' });
    next();
  });
}, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'bad_file (images, mp4/webm, mp3, pdf, txt, zip)' });
  const mt = req.file.mimetype;
  const kind = mt.startsWith('image/') ? 'image' : mt.startsWith('video/') ? 'video' : mt.startsWith('audio/') ? 'audio' : 'file';
  res.json({ url: uploadUrl('files', req.file), name: String(req.file.originalname || 'file').slice(0, 120), mime: mt, size: req.file.size, kind });
});

// image upload middleware: rejects non-images / oversize with a clean 400/413
function imgSingle(up) {
  return (req, res, next) => up.single('file')(req, res, (err) => {
    if (err) return res.status(413).json({ error: 'image_too_large' });
    if (!req.file) return res.status(400).json({ error: 'bad_image (png, jpg, gif incl. animated, webp)' });
    next();
  });
}
function freshUser(id) {
  return publicUser(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id));
}
function recordMedia(userId, kind, url) {
  if (!url) return;
  db.prepare('INSERT INTO media_history (id,user_id,kind,url,created_at) VALUES (?,?,?,?,?)')
    .run(uid(), userId, kind, url, now());
  db.prepare(`DELETE FROM media_history WHERE user_id = ? AND kind = ? AND id NOT IN
    (SELECT id FROM media_history WHERE user_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 8)`)
    .run(userId, kind, userId, kind);
}
function mediaHist(userId, kind) {
  return db.prepare('SELECT id,url,created_at FROM media_history WHERE user_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 8').all(userId, kind);
}

// ---------- profile ----------
app.post('/api/me/avatar', authRequired, imgSingle(upImg), (req, res) => {
  const url = uploadUrl('avatars', req.file);
  deleteUploaded(req.user.avatar_url);
  db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(url, req.user.id);
  recordMedia(req.user.id, 'avatar', url);
  const u = freshUser(req.user.id);
  broadcastUserUpdate(u);
  res.json({ user: u });
});
app.delete('/api/me/avatar', authRequired, (req, res) => {
  deleteUploaded(req.user.avatar_url);
  db.prepare('UPDATE users SET avatar_url = NULL WHERE id = ?').run(req.user.id);
  const u = freshUser(req.user.id);
  broadcastUserUpdate(u);
  res.json({ user: u });
});
app.post('/api/me/banner', authRequired, imgSingle(upBanner), (req, res) => {
  const url = uploadUrl('banners', req.file);
  deleteUploaded(req.user.banner_url);
  db.prepare('UPDATE users SET banner_url = ? WHERE id = ?').run(url, req.user.id);
  recordMedia(req.user.id, 'banner', url);
  const u = freshUser(req.user.id);
  broadcastUserUpdate(u);
  res.json({ user: u });
});
app.delete('/api/me/banner', authRequired, (req, res) => {
  deleteUploaded(req.user.banner_url);
  db.prepare('UPDATE users SET banner_url = NULL WHERE id = ?').run(req.user.id);
  const u = freshUser(req.user.id);
  broadcastUserUpdate(u);
  res.json({ user: u });
});

const STATUSES = ['online', 'away', 'dnd', 'invisible'];
app.patch('/api/me', authRequired, (req, res) => {
  const { displayName, status, statusText } = req.body || {};
  const sets = [], vals = [];
  if (displayName !== undefined) {
    const d = String(displayName).trim().slice(0, 32);
    if (!d) return res.status(400).json({ error: 'display_name_required' });
    sets.push('display_name = ?'); vals.push(d);
  }
  if (status !== undefined) {
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'bad_status' });
    sets.push('status = ?'); vals.push(status);
  }
  if (statusText !== undefined) {
    sets.push('status_text = ?'); vals.push(String(statusText).slice(0, 64));
  }
  if (req.body?.nameColor !== undefined) {
    const c = String(req.body.nameColor);
    if (c && !/^#[0-9a-fA-F]{6}$/.test(c)) return res.status(400).json({ error: 'bad_color' });
    sets.push('name_color = ?'); vals.push(c || '');
  }
  if (req.body?.nameGradient !== undefined) {
    const c = String(req.body.nameGradient);
    if (c && !/^#[0-9a-fA-F]{6}$/.test(c)) return res.status(400).json({ error: 'bad_color' });
    sets.push('name_gradient = ?'); vals.push(c || '');
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
  vals.push(req.user.id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  const u = freshUser(req.user.id);
  broadcastUserUpdate(u);
  for (const sid of [...clients].filter((c) => c.meta && c.meta.userId === u.id).flatMap((c) => [...c.meta.servers])) {
    broadcastToServer(sid, { t: 'user-status', serverId: sid, userId: u.id, status: u.status });
  }
  // sync live sockets' presence state
  for (const c of clients) if (c.meta && c.meta.userId === u.id) c.meta.status = u.status;
  res.json({ user: u });
});
// set avatar/banner from a URL (e.g. a Klipy GIF) instead of an upload
function setProfileUrl(req, res, col, kind, record = true) {
  const url = String(req.body?.url || '').trim().slice(0, 500);
  if (!/^https:\/\//.test(url)) return res.status(400).json({ error: 'bad_url (https only)' });
  deleteUploaded(req.user[col]);
  db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(url, req.user.id);
  if (record) recordMedia(req.user.id, kind, url);
  const u = freshUser(req.user.id);
  broadcastUserUpdate(u);
  res.json({ user: u, history: record ? mediaHist(req.user.id, kind) : [] });
}
app.post('/api/me/avatar/url', authRequired, (req, res) => setProfileUrl(req, res, 'avatar_url', 'avatar'));
app.post('/api/me/banner/url', authRequired, (req, res) => setProfileUrl(req, res, 'banner_url', 'banner'));
app.post('/api/me/sidebar-banner', authRequired, imgSingle(upSidebar), (req, res) => {
  const url = uploadUrl('sidebar', req.file);
  deleteUploaded(req.user.sidebar_banner_url);
  db.prepare('UPDATE users SET sidebar_banner_url = ? WHERE id = ?').run(url, req.user.id);
  const u = freshUser(req.user.id);
  broadcastUserUpdate(u);
  res.json({ user: u });
});
app.delete('/api/me/sidebar-banner', authRequired, (req, res) => {
  deleteUploaded(req.user.sidebar_banner_url);
  db.prepare('UPDATE users SET sidebar_banner_url = NULL WHERE id = ?').run(req.user.id);
  const u = freshUser(req.user.id);
  broadcastUserUpdate(u);
  res.json({ user: u });
});
app.post('/api/me/sidebar-banner/url', authRequired, (req, res) => setProfileUrl(req, res, 'sidebar_banner_url', 'sidebar', false));
app.get('/api/me/media-history', authRequired, (req, res) => {
  res.json({ avatar: mediaHist(req.user.id, 'avatar'), banner: mediaHist(req.user.id, 'banner') });
});
app.delete('/api/me/media-history/:hid', authRequired, (req, res) => {
  const row = db.prepare('SELECT * FROM media_history WHERE id = ? AND user_id = ?').get(req.params.hid, req.user.id);
  if (!row) return res.status(404).json({ error: 'no_entry' });
  db.prepare('DELETE FROM media_history WHERE id = ?').run(row.id);
  res.json({ ok: true });
});
app.post('/api/me/password', authRequired, async (req, res) => {
  const { current, next } = req.body || {};
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!await bcrypt.compare(String(current || ''), row.password_hash)) return res.status(401).json({ error: 'wrong_password' });
  if (String(next || '').length < 4) return res.status(400).json({ error: 'password too short (min 4)' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(String(next), 10), req.user.id);
  res.json({ ok: true });
});

// ---------- server layout (rail order + folders, per user) ----------
app.get('/api/me/layout', authRequired, (req, res) => {
  const folders = db.prepare('SELECT id,name,color,position,open FROM server_folders WHERE user_id = ? ORDER BY position ASC').all(req.user.id);
  const order = db.prepare('SELECT server_id,folder_id,position FROM server_members WHERE user_id = ?').all(req.user.id);
  res.json({ folders, order });
});
app.put('/api/me/layout', authRequired, (req, res) => {
  const { servers, folders } = req.body || {};
  if (!Array.isArray(servers) || !Array.isArray(folders)) return res.status(400).json({ error: 'bad_layout' });
  if (servers.length > 200 || folders.length > 50) return res.status(400).json({ error: 'layout_too_big' });
  const myServers = new Set(db.prepare('SELECT server_id FROM server_members WHERE user_id = ?').all(req.user.id).map((r) => r.server_id));
  const tx = db.transaction(() => {
    const seen = new Set();
    for (const f of folders) {
      if (!f || typeof f.id !== 'string' || !f.id || f.id.length > 64) continue;
      const name = String(f.name || '').trim().slice(0, 32) || 'Folder';
      const color = /^#[0-9a-fA-F]{6}$/.test(f.color || '') ? f.color : '#5865f2';
      const open = f.open === false ? 0 : 1;
      const position = Math.max(0, Math.min(500, parseInt(f.position, 10) || 0));
      const ex = db.prepare('SELECT id FROM server_folders WHERE id = ? AND user_id = ?').get(f.id, req.user.id);
      if (ex) db.prepare('UPDATE server_folders SET name=?,color=?,position=?,open=? WHERE id=?').run(name, color, position, open, f.id);
      else db.prepare('INSERT INTO server_folders (id,user_id,name,color,position,open,created_at) VALUES (?,?,?,?,?,?,?)').run(f.id, req.user.id, name, color, position, open, now());
      seen.add(f.id);
    }
    if (seen.size) db.prepare(`DELETE FROM server_folders WHERE user_id = ? AND id NOT IN (${[...seen].map(() => '?').join(',')})`).run(req.user.id, ...[...seen]);
    else db.prepare('DELETE FROM server_folders WHERE user_id = ?').run(req.user.id);
    db.prepare('UPDATE server_members SET folder_id = NULL WHERE user_id = ? AND folder_id IS NOT NULL AND folder_id NOT IN (SELECT id FROM server_folders WHERE user_id = ?)').run(req.user.id, req.user.id);
    const upd = db.prepare('UPDATE server_members SET folder_id = ?, position = ? WHERE user_id = ? AND server_id = ?');
    for (const s of servers) {
      if (!s || !myServers.has(s.id)) continue;
      const fid = (typeof s.folderId === 'string' && seen.has(s.folderId)) ? s.folderId : null;
      upd.run(fid, Math.max(0, Math.min(500, parseInt(s.position, 10) || 0)), req.user.id, s.id);
    }
  });
  try { tx(); } catch { return res.status(400).json({ error: 'bad_layout' }); }
  res.json({ ok: true });
});

// ---------- server profile ----------
app.patch('/api/servers/:id', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isAdmin(s.id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  const name = String(req.body?.name || '').trim().slice(0, 48);
  if (!name) return res.status(400).json({ error: 'name_required' });
  const sets = ['name = ?'], params = [name];
  if (req.body?.description !== undefined) { sets.push('description = ?'); params.push(String(req.body.description).slice(0, 200)); }
  params.push(s.id);
  db.prepare(`UPDATE servers SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  broadcastToServer(s.id, { t: 'server-updated', server: serverView(s.id) });
  res.json({ server: serverView(s.id) });
});
app.post('/api/servers/:id/icon', authRequired, imgSingle(upIcon), (req, res) => {
  const s = getServer(req.params.id);
  if (!s) { deleteUploaded(uploadUrl('icons', req.file)); return res.status(404).json({ error: 'no_server' }); }
  if (!isAdmin(s.id, req.user.id)) { deleteUploaded(uploadUrl('icons', req.file)); return res.status(403).json({ error: 'owner_only' }); }
  const url = uploadUrl('icons', req.file);
  deleteUploaded(s.icon_url);
  db.prepare('UPDATE servers SET icon_url = ? WHERE id = ?').run(url, s.id);
  broadcastToServer(s.id, { t: 'server-updated', server: serverView(s.id) });
  res.json({ server: serverView(s.id) });
});
app.delete('/api/servers/:id/icon', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isAdmin(s.id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  deleteUploaded(s.icon_url);
  db.prepare('UPDATE servers SET icon_url = NULL WHERE id = ?').run(s.id);
  broadcastToServer(s.id, { t: 'server-updated', server: serverView(s.id) });
  res.json({ server: serverView(s.id) });
});

// ---------- custom emoji ----------
const EMOJI_NAME = /^[a-z0-9_+-]{2,32}$/;
function serverEmojiNames(serverId) {
  return new Set(db.prepare('SELECT name FROM custom_emoji WHERE server_id = ?').all(serverId).map((r) => r.name));
}
app.get('/api/servers/:id/emoji', authRequired, (req, res) => {
  if (!isMember(req.params.id, req.user.id)) return res.status(403).json({ error: 'not_member' });
  res.json({ emoji: db.prepare('SELECT name, url FROM custom_emoji WHERE server_id = ? ORDER BY name ASC').all(req.params.id) });
});
app.post('/api/servers/:id/emoji', authRequired, imgSingle(upEmoji), (req, res) => {
  const s = getServer(req.params.id);
  const name = String(req.body?.name || '').trim().toLowerCase();
  if (!s || !isMember(s.id, req.user.id)) { deleteUploaded(uploadUrl('emoji', req.file)); return res.status(403).json({ error: 'not_member' }); }
  if (!EMOJI_NAME.test(name)) { deleteUploaded(uploadUrl('emoji', req.file)); return res.status(400).json({ error: 'bad_emoji_name (2-32 chars: a-z 0-9 _ + -)' }); }
  const url = uploadUrl('emoji', req.file);
  try {
    db.prepare('INSERT INTO custom_emoji (id, server_id, name, url, created_by, created_at) VALUES (?,?,?,?,?,?)')
      .run(uid(), s.id, name, url, req.user.id, now());
  } catch { deleteUploaded(url); return res.status(409).json({ error: 'emoji_name_taken' }); }
  const list = db.prepare('SELECT name, url FROM custom_emoji WHERE server_id = ? ORDER BY name ASC').all(s.id);
  broadcastToServer(s.id, { t: 'emoji-updated', serverId: s.id, emoji: list });
  res.json({ emoji: list });
});
app.delete('/api/servers/:id/emoji/:name', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isAdmin(s.id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  const row = db.prepare('SELECT * FROM custom_emoji WHERE server_id = ? AND name = ?').get(s.id, req.params.name);
  if (!row) return res.status(404).json({ error: 'no_emoji' });
  db.prepare('DELETE FROM custom_emoji WHERE id = ?').run(row.id);
  deleteUploaded(row.url);
  const list = db.prepare('SELECT name, url FROM custom_emoji WHERE server_id = ? ORDER BY name ASC').all(s.id);
  broadcastToServer(s.id, { t: 'emoji-updated', serverId: s.id, emoji: list });
  res.json({ emoji: list });
});

// ---------- reactions ----------
function validReaction(e, names) {
  if (typeof e !== 'string' || !e) return false;
  if (e.startsWith(':') && e.endsWith(':') && e.length > 2) {
    return EMOJI_NAME.test(e.slice(1, -1)) && names.has(e.slice(1, -1));
  }
  if (/[:<>"'&]/.test(e)) return false;
  const len = [...e].length;
  return len >= 1 && e.length <= 24;
}
function getMsg(mid) { return db.prepare('SELECT * FROM messages WHERE id = ?').get(mid); }
app.post('/api/messages/:mid/reactions', authRequired, (req, res) => {
  const m = getMsg(req.params.mid);
  if (!m) return res.status(404).json({ error: 'no_message' });
  if (!isMember(m.server_id, req.user.id)) return res.status(403).json({ error: 'not_member' });
  const emoji = String(req.body?.emoji || '');
  if (!validReaction(emoji, serverEmojiNames(m.server_id))) return res.status(400).json({ error: 'bad_emoji' });
  const ex = db.prepare('SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(m.id, req.user.id, emoji);
  if (ex) db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(m.id, req.user.id, emoji);
  else db.prepare('INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,?)').run(m.id, req.user.id, emoji, now());
  broadcastToServer(m.server_id, { t: 'reaction-update', serverId: m.server_id, channelId: m.channel_id, messageId: m.id, reactions: reactionTally(m.id, null) });
  res.json({ reactions: reactionTally(m.id, req.user.id) });
});

// ---------- edit + fetch single message ----------
app.patch('/api/messages/:mid', authRequired, (req, res) => {
  const m = getMsg(req.params.mid);
  if (!m) return res.status(404).json({ error: 'no_message' });
  if (m.user_id !== req.user.id) return res.status(403).json({ error: 'only_your_own' });
  const content = String(req.body?.content || '').trim().slice(0, 5000);
  if (!content) return res.status(400).json({ error: 'empty_message' });
  db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(content, now(), m.id);
  const full = hydrateMessages([db.prepare(`
    SELECT m.*, u.username, u.display_name, u.avatar_color, u.avatar_url,
           p.content AS p_content, pu.display_name AS p_name
    FROM messages m LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN messages p ON p.id = m.reply_to_id
    LEFT JOIN users pu ON pu.id = p.user_id
    WHERE m.id = ?
  `).get(m.id)], req.user.id)[0];
  broadcastToServer(m.server_id, { t: 'message-updated', serverId: m.server_id, channelId: m.channel_id, message: full });
  res.json({ message: full });
});
app.get('/api/messages/:mid', authRequired, (req, res) => {
  const m = getMsg(req.params.mid);
  if (!m) return res.status(404).json({ error: 'no_message' });
  if (!isMember(m.server_id, req.user.id)) return res.status(403).json({ error: 'not_member' });
  const full = hydrateMessages([db.prepare(`
    SELECT m.*, u.username, u.display_name, u.avatar_color, u.avatar_url,
           p.content AS p_content, pu.display_name AS p_name
    FROM messages m LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN messages p ON p.id = m.reply_to_id
    LEFT JOIN users pu ON pu.id = p.user_id
    WHERE m.id = ?
  `).get(m.id)], req.user.id)[0];
  res.json({ message: full });
});

// ---------- threads ----------
app.get('/api/servers/:id/channels/:chId/threads/:rootId', authRequired, (req, res) => {
  const { id, chId, rootId } = req.params;
  if (!isMember(id, req.user.id)) return res.status(403).json({ error: 'not_member' });
  const root = db.prepare('SELECT * FROM messages WHERE id = ? AND server_id = ? AND channel_id = ?').get(rootId, id, chId);
  if (!root) return res.status(404).json({ error: 'no_thread' });
  const rows = db.prepare(`
    SELECT m.*, u.username, u.display_name, u.avatar_color, u.avatar_url,
           p.content AS p_content, pu.display_name AS p_name
    FROM messages m LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN messages p ON p.id = m.reply_to_id
    LEFT JOIN users pu ON pu.id = p.user_id
    WHERE m.thread_root_id = ? ORDER BY m.created_at ASC LIMIT 200
  `).all(rootId);
  const hydRoot = hydrateMessages([db.prepare(`
    SELECT m.*, u.username, u.display_name, u.avatar_color, u.avatar_url,
           p.content AS p_content, pu.display_name AS p_name
    FROM messages m LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN messages p ON p.id = m.reply_to_id
    LEFT JOIN users pu ON pu.id = p.user_id
    WHERE m.id = ?
  `).get(rootId)], req.user.id)[0];
  res.json({ root: hydRoot, replies: hydrateMessages(rows, req.user.id) });
});

// ---------- friends + DMs ----------
function friendRow(a, b) {
  const [x, y] = a < b ? [a, b] : [b, a];
  return db.prepare('SELECT * FROM friendships WHERE user_a = ? AND user_b = ?').get(x, y);
}
function areFriends(a, b) {
  const f = friendRow(a, b);
  return !!(f && f.status === 'accepted');
}
function notifyUser(userId, obj) {
  for (const c of clients) if (c.meta && c.meta.userId === userId) safeSend(c, obj);
}
function dmThreadFor(userId, threadId) {
  if (!threadId) return null;
  const t = db.prepare('SELECT * FROM dm_threads WHERE id = ?').get(threadId);
  if (!t) return null;
  return db.prepare('SELECT 1 FROM dm_members WHERE thread_id = ? AND user_id = ?').get(threadId, userId) ? t : null;
}
function dmThreadView(t) {
  const members = db.prepare(`SELECT ${USER_COLS} FROM users WHERE id IN (SELECT user_id FROM dm_members WHERE thread_id = ?)`).all(t.id).map(publicUser);
  const last = db.prepare('SELECT m.content, m.created_at, u.display_name AS dname FROM dm_messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.thread_id = ? ORDER BY m.created_at DESC LIMIT 1').get(t.id);
  return {
    id: t.id, name: t.name, isGroup: !!t.is_group, created_by: t.created_by || null, created_at: t.created_at, members,
    last: last ? { content: last.content, created_at: last.created_at, author: last.dname || '?' } : null,
  };
}
function dmNotify(threadId, obj) {
  const mems = db.prepare('SELECT user_id FROM dm_members WHERE thread_id = ?').all(threadId).map((r) => r.user_id);
  for (const uid of mems) notifyUser(uid, obj);
}
// Fully erase a DM thread and everything in it. Called whenever a thread is
// left with zero members (last leave, remove, or ban) — explicit deletes so
// no messages/attachments/reactions/pins dangle even if FK cascades lag.
function deleteDmThread(threadId) {
  db.transaction(() => {
    db.prepare('DELETE FROM dm_attachments WHERE message_id IN (SELECT id FROM dm_messages WHERE thread_id = ?)').run(threadId);
    db.prepare('DELETE FROM dm_reactions WHERE message_id IN (SELECT id FROM dm_messages WHERE thread_id = ?)').run(threadId);
    db.prepare('DELETE FROM dm_pins WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM dm_messages WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM dm_bans WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM dm_members WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM dm_threads WHERE id = ?').run(threadId);
  })();
}
function maybeDeleteEmptyDmThread(threadId) {
  if (!db.prepare('SELECT COUNT(*) c FROM dm_members WHERE thread_id = ?').get(threadId).c) deleteDmThread(threadId);
}
function firstTextChannel(serverId) {
  return db.prepare("SELECT * FROM channels WHERE server_id = ? AND type = 'text' ORDER BY position ASC, created_at ASC LIMIT 1").get(serverId);
}
function postServerSys(serverId, text) {
  const ch = firstTextChannel(serverId);
  if (!ch) return;
  const mid = uid();
  db.prepare('INSERT INTO messages (id,server_id,channel_id,user_id,content,sys,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(mid, serverId, ch.id, null, String(text).slice(0, 200), 'info', now());
  broadcastToServer(serverId, { t: 'message-new', serverId, channelId: ch.id, message: fullMessage(mid, null) });
}
function postDmSys(threadId, text) {
  const mid = uid();
  db.prepare('INSERT INTO dm_messages (id,thread_id,user_id,content,sys,created_at) VALUES (?,?,?,?,?,?)')
    .run(mid, threadId, null, String(text).slice(0, 200), 'info', now());
  dmNotify(threadId, { t: 'dm-new', message: fullDm(mid, null) });
}
function isBanned(serverId, userId) {
  return !!db.prepare('SELECT 1 FROM server_bans WHERE server_id = ? AND user_id = ?').get(serverId, userId);
}
function dmBanned(threadId, userId) {
  return !!db.prepare('SELECT 1 FROM dm_bans WHERE thread_id = ? AND user_id = ?').get(threadId, userId);
}
function displayOf(u) { return (u && (u.display_name || u.username)) || 'Someone'; }

// ---------- push notifications (Web Push) ----------
function metaGet(k) { try { return db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value || null; } catch { return null; } }
function metaSet(k, v) { db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)').run(k, v); }
let VAPID_PUBLIC = process.env.VAPID_PUBLIC || metaGet('vapid_public');
let VAPID_PRIVATE = process.env.VAPID_PRIVATE || metaGet('vapid_private');
if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  const keys = webpush.generateVAPIDKeys();
  VAPID_PUBLIC = keys.publicKey; VAPID_PRIVATE = keys.privateKey;
  if (!process.env.VAPID_PUBLIC) { metaSet('vapid_public', VAPID_PUBLIC); metaSet('vapid_private', VAPID_PRIVATE); }
}
webpush.setVapidDetails(process.env.PUSH_SUBJECT || 'mailto:notifications@localhost', VAPID_PUBLIC, VAPID_PRIVATE);
function userLive(uid) {
  for (const c of clients) if (c.meta && c.meta.userId === uid) return true;
  return false;
}
function notifMode(uid, scopes) {
  let rows = [];
  try { rows = db.prepare('SELECT scope, mode FROM notif_prefs WHERE user_id = ?').all(uid); } catch {}
  const map = new Map(rows.map((r) => [r.scope, r.mode]));
  for (const s of scopes) if (map.has(s)) return map.get(s);
  return map.get('global') || 'all';
}
function pushToUser(uid, payload) {
  let subs = [];
  try { subs = db.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?').all(uid); } catch { return; }
  for (const s of subs) {
    webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload)).catch((err) => {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        try { db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(s.endpoint); } catch {}
      }
    });
  }
}
function mentionsName(content, username) {
  try {
    return new RegExp('(^|[\\s(])@' + String(username).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(String(content || ''));
  } catch { return false; }
}
function notifyServerMessage(serverId, channelId, author, content) {
  const text = String(content || '').trim();
  if (!text) return;
  let mems = [];
  try { mems = db.prepare('SELECT user_id FROM server_members WHERE server_id = ? AND user_id != ?').all(serverId, author.userId).map((r) => r.user_id); } catch { return; }
  if (!mems.length) return;
  const live = new Set([...clients].filter((c) => c.meta).map((c) => c.meta.userId));
  const cands = mems.filter((id) => !live.has(id));
  if (!cands.length) return;
  let prefs = [], names = new Map();
  try {
    const ph = cands.map(() => '?').join(',');
    prefs = db.prepare(`SELECT user_id, scope, mode FROM notif_prefs WHERE user_id IN (${ph})`).all(...cands);
    for (const u of db.prepare(`SELECT id, username FROM users WHERE id IN (${ph})`).all(...cands)) names.set(u.id, u.username);
  } catch {}
  const byUser = new Map();
  for (const p of prefs) {
    if (!byUser.has(p.user_id)) byUser.set(p.user_id, new Map());
    byUser.get(p.user_id).set(p.scope, p.mode);
  }
  const ch = db.prepare('SELECT name FROM channels WHERE id = ?').get(channelId);
  const s = getServer(serverId);
  for (const uid of cands) {
    const pm = byUser.get(uid) || new Map();
    const mode = pm.get(`c:${channelId}`) || pm.get(`s:${serverId}`) || pm.get('global') || 'all';
    if (mode === 'muted') continue;
    if (mode === 'mentions' && !mentionsName(text, names.get(uid))) continue;
    pushToUser(uid, {
      title: `#${(ch && ch.name) || 'chat'} · ${s ? s.name : ''}`,
      body: `${displayOf(author)}: ${text}`.slice(0, 160),
      icon: author.avatar_url || '/icons/icon-192.png',
      tag: `ch:${channelId}`,
      url: `/?server=${serverId}&channel=${channelId}`,
    });
  }
}
function notifyDmMessage(thread, author, content) {
  const text = String(content || '').trim();
  if (!text) return;
  let mems = [];
  try { mems = db.prepare('SELECT user_id FROM dm_members WHERE thread_id = ? AND user_id != ?').all(thread.id, author.userId).map((r) => r.user_id); } catch { return; }
  const live = new Set([...clients].filter((c) => c.meta).map((c) => c.meta.userId));
  for (const uid of mems) {
    if (live.has(uid)) continue;
    if (notifMode(uid, [`dm:${thread.id}`, 'global']) === 'muted') continue;
    pushToUser(uid, {
      title: thread.is_group ? (thread.name || 'Group chat') : `${displayOf(author)} (DM)`,
      body: thread.is_group ? `${displayOf(author)}: ${text}`.slice(0, 160) : text.slice(0, 160),
      icon: author.avatar_url || '/icons/icon-192.png',
      tag: `dm:${thread.id}`,
      url: `/?dm=${thread.id}`,
    });
  }
}
// drop a user's live sockets from a server (membership gone): stop server
// broadcasts + pull them out of its voice rooms
function evictFromServer(serverId, userId) {
  for (const c of clients) {
    if (!c.meta || c.meta.userId !== userId) continue;
    c.meta.servers?.delete(serverId);
  }
  for (const [key, set] of voiceRooms) {
    const [srv, ch] = key.split(':');
    if (srv !== serverId) continue;
    for (const c of [...set]) {
      if (c.meta && c.meta.userId === userId) {
        set.delete(c);
        c.voice = null;
        safeSend(c, { t: 'voice-kicked', serverId, channelId: ch });
      }
    }
    if (set.size === 0) voiceRooms.delete(key);
  }
}
const DM_JOIN = `SELECT m.*, u.username, u.display_name, u.avatar_color, u.avatar_url,
  p.content AS p_content, pu.display_name AS p_name
  FROM dm_messages m LEFT JOIN users u ON u.id = m.user_id
  LEFT JOIN dm_messages p ON p.id = m.reply_to_id LEFT JOIN users pu ON pu.id = p.user_id`;
function hydrateDm(rows, meId) {
  const ids = rows.map((r) => r.id);
  const attBy = {}, reactBy = {};
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    for (const a of db.prepare(`SELECT * FROM dm_attachments WHERE message_id IN (${ph}) ORDER BY created_at ASC`).all(...ids)) {
      (attBy[a.message_id] = attBy[a.message_id] || []).push({ url: a.url, name: a.filename, mime: a.mime, size: a.size, kind: a.kind });
    }
    for (const r of db.prepare(`SELECT message_id, emoji, user_id FROM dm_reactions WHERE message_id IN (${ph})`).all(...ids)) {
      const t = (reactBy[r.message_id] = reactBy[r.message_id] || {});
      const e = (t[r.emoji] = t[r.emoji] || { emoji: r.emoji, count: 0, users: [] });
      e.count++; e.users.push(r.user_id);
    }
  }
  return rows.map((r) => ({
    id: r.id, threadId: r.thread_id, content: r.content, created_at: r.created_at,
    sys: r.sys || null,
    fwdFrom: r.fwd_from || null,
    replyTo: r.reply_to_id ? { id: r.reply_to_id, author: r.p_name || '?', snippet: String(r.p_content || '').slice(0, 140) } : null,
    threadCount: 0, edited: !!r.edited_at, _dm: true,
    attachments: attBy[r.id] || [],
    reactions: Object.values(reactBy[r.id] || {}).map((t) => ({ emoji: t.emoji, count: t.count, me: t.users.includes(meId) })),
    user: r.user_id ? publicUser({ id: r.user_id, username: r.username, display_name: r.display_name, avatar_color: r.avatar_color, avatar_url: r.avatar_url }) : null,
  }));
}
function fullDm(mid, meId) {
  const row = db.prepare(`${DM_JOIN} WHERE m.id = ?`).get(mid);
  return row ? hydrateDm([row], meId)[0] : null;
}
function cleanAttachments(atts) {
  const out = [];
  for (const a of (Array.isArray(atts) ? atts.slice(0, 5) : [])) {
    const url = String(a?.url || '');
    const isLocal = url.startsWith('/uploads/files/');
    const isRemoteImg = a?.kind === 'image' && /^https:\/\//.test(url);
    if (!isLocal && !isRemoteImg) continue;
    const mime = String(a?.mime || 'application/octet-stream').slice(0, 80);
    out.push({
      url, name: String(a?.name || 'file').slice(0, 120), mime,
      size: Math.max(0, Math.min(parseInt(a?.size || 0, 10) || 0, 100 * 1024 * 1024)),
      kind: isLocal ? (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file') : 'image',
    });
  }
  return out;
}
app.get('/api/users/search', authRequired, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 24);
  if (q.length < 2) return res.json({ users: [] });
  const rows = db.prepare(`SELECT ${USER_COLS} FROM users WHERE (username LIKE ? OR display_name LIKE ?) AND id != ? LIMIT 8`).all(q + '%', q + '%', req.user.id);
  res.json({ users: rows.map(publicUser) });
});
app.get('/api/friends', authRequired, (req, res) => {
  const rows = db.prepare('SELECT * FROM friendships WHERE user_a = ? OR user_b = ?').all(req.user.id, req.user.id);
  const ids = rows.map((f) => (f.user_a === req.user.id ? f.user_b : f.user_a));
  const blockedIds = db.prepare('SELECT blocked_id FROM blocks WHERE user_id = ?').all(req.user.id).map((r) => r.blocked_id);
  const allIds = [...new Set([...ids, ...blockedIds])];
  const byId = new Map(allIds.length
    ? db.prepare(`SELECT ${USER_COLS} FROM users WHERE id IN (${allIds.map(() => '?').join(',')})`).all(...allIds).map((u) => [u.id, publicUser(u)])
    : []);
  const friends = [], pin = [], pout = [];
  for (const f of rows) {
    const u = byId.get(f.user_a === req.user.id ? f.user_b : f.user_a);
    if (!u) continue;
    if (f.status === 'accepted') friends.push(u);
    else if (f.action_by === req.user.id) pout.push(u);
    else pin.push(u);
  }
  const blocked = blockedIds.map((id) => byId.get(id)).filter(Boolean);
  res.json({ friends, pendingIn: pin, pendingOut: pout, blocked });
});
app.post('/api/friends', authRequired, (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const target = db.prepare(`SELECT ${USER_COLS} FROM users WHERE username = ?`).get(username);
  if (!target || target.id === req.user.id) return res.status(404).json({ error: 'user_not_found' });
  if (db.prepare('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?').get(target.id, req.user.id)) return res.status(404).json({ error: 'user_not_found' });
  if (db.prepare('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?').get(req.user.id, target.id)) return res.status(403).json({ error: 'unblock_first' });
  if (friendRow(req.user.id, target.id)) return res.status(409).json({ error: 'already_added' });
  const [x, y] = req.user.id < target.id ? [req.user.id, target.id] : [target.id, req.user.id];
  db.prepare('INSERT INTO friendships (user_a,user_b,status,action_by,created_at) VALUES (?,?,?,?,?)').run(x, y, 'pending', req.user.id, now());
  notifyUser(target.id, { t: 'friends-changed' });
  res.json({ ok: true });
});
app.post('/api/friends/:oid/accept', authRequired, (req, res) => {
  const f = friendRow(req.user.id, req.params.oid);
  if (!f || f.status !== 'pending' || f.action_by === req.user.id) return res.status(404).json({ error: 'no_request' });
  if (db.prepare('SELECT 1 FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)').get(req.user.id, req.params.oid, req.params.oid, req.user.id)) return res.status(404).json({ error: 'no_request' });
  db.prepare('UPDATE friendships SET status = ? WHERE user_a = ? AND user_b = ?').run('accepted', f.user_a, f.user_b);
  notifyUser(req.params.oid, { t: 'friends-changed' });
  notifyUser(req.user.id, { t: 'friends-changed' });
  res.json({ ok: true });
});
app.delete('/api/friends/:oid', authRequired, (req, res) => {
  const f = friendRow(req.user.id, req.params.oid);
  if (!f) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?').run(f.user_a, f.user_b);
  notifyUser(req.params.oid, { t: 'friends-changed' });
  res.json({ ok: true });
});
app.post('/api/blocks', authRequired, (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(String(req.body?.userId || ''));
  if (!target || target.id === req.user.id) return res.status(404).json({ error: 'user_not_found' });
  const f = friendRow(req.user.id, target.id);
  db.transaction(() => {
    if (f) db.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?').run(f.user_a, f.user_b);
    db.prepare('INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?,?,?)').run(req.user.id, target.id, now());
  })();
  notifyUser(req.user.id, { t: 'friends-changed' });
  notifyUser(target.id, { t: 'friends-changed' });
  res.json({ ok: true });
});
app.delete('/api/blocks/:oid', authRequired, (req, res) => {
  db.prepare('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?').run(req.user.id, String(req.params.oid));
  notifyUser(req.user.id, { t: 'friends-changed' });
  res.json({ ok: true });
});

// ---------- push subscriptions + notification prefs ----------
const NOTIF_MODES = ['all', 'mentions', 'muted'];
app.get('/api/push/config', authRequired, (req, res) => res.json({ publicKey: VAPID_PUBLIC }));
app.post('/api/push/subscribe', authRequired, (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'bad_subscription' });
  db.prepare('INSERT OR REPLACE INTO push_subs (user_id,endpoint,p256dh,auth,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.id, String(endpoint).slice(0, 500), String(keys.p256dh), String(keys.auth), now());
  res.json({ ok: true });
});
app.delete('/api/push/unsubscribe', authRequired, (req, res) => {
  const ep = String(req.body?.endpoint || '');
  if (ep) db.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?').run(req.user.id, ep);
  res.json({ ok: true });
});
app.get('/api/notifs/prefs', authRequired, (req, res) => {
  const rows = db.prepare('SELECT scope, mode FROM notif_prefs WHERE user_id = ?').all(req.user.id);
  const prefs = {};
  for (const r of rows) prefs[r.scope] = r.mode;
  res.json({ prefs });
});
app.put('/api/notifs/prefs', authRequired, (req, res) => {
  const scope = String(req.body?.scope || '');
  const mode = String(req.body?.mode || '');
  if (!['all', 'mentions', 'muted', 'inherit'].includes(mode)) return res.status(400).json({ error: 'bad_mode' });
  const m = /^([sc]):(.+)$/.exec(scope);
  if (scope !== 'global' && !m) {
    const dm = /^dm:(.+)$/.exec(scope);
    if (!dm || !dmThreadFor(req.user.id, dm[1])) return res.status(404).json({ error: 'no_thread' });
  } else if (m) {
    if (m[1] === 's') { if (!isMember(m[2], req.user.id)) return res.status(403).json({ error: 'not_member' }); }
    else {
      const ch = db.prepare('SELECT server_id FROM channels WHERE id = ?').get(m[2]);
      if (!ch || !isMember(ch.server_id, req.user.id)) return res.status(404).json({ error: 'no_channel' });
    }
  }
  if (mode === 'inherit' || scope === 'global' && mode === 'inherit') db.prepare('DELETE FROM notif_prefs WHERE user_id = ? AND scope = ?').run(req.user.id, scope);
  else db.prepare('INSERT OR REPLACE INTO notif_prefs (user_id,scope,mode) VALUES (?,?,?)').run(req.user.id, scope, mode);
  res.json({ ok: true });
});
app.get('/api/dms', authRequired, (req, res) => {
  const ids = db.prepare('SELECT thread_id FROM dm_members WHERE user_id = ? AND (hidden IS NULL OR hidden = 0)').all(req.user.id).map((r) => r.thread_id);
  const out = [];
  for (const id of ids) {
    const t = db.prepare('SELECT * FROM dm_threads WHERE id = ?').get(id);
    if (t) out.push(dmThreadView(t));
  }
  res.json({ threads: out });
});
app.post('/api/dms', authRequired, (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(String(req.body?.userId || ''));
  if (!target || target.id === req.user.id) return res.status(404).json({ error: 'user_not_found' });
  if (!areFriends(req.user.id, target.id)) return res.status(403).json({ error: 'add_friend_first' });
  const mine = db.prepare('SELECT thread_id FROM dm_members WHERE user_id = ?').all(req.user.id).map((r) => r.thread_id);
  for (const tid of mine) {
    const t = db.prepare('SELECT * FROM dm_threads WHERE id = ? AND (is_group IS NULL OR is_group = 0)').get(tid);
    if (!t) continue;
    const mems = db.prepare('SELECT user_id FROM dm_members WHERE thread_id = ?').all(tid).map((r) => r.user_id);
    if (mems.length === 2 && mems.includes(target.id)) {
      db.prepare('UPDATE dm_members SET hidden = 0 WHERE thread_id = ? AND user_id = ?').run(tid, req.user.id);
      return res.json({ thread: dmThreadView(t) });
    }
  }
  const id = uid();
  db.transaction(() => {
    db.prepare('INSERT INTO dm_threads (id,name,is_group,created_by,created_at) VALUES (?,?,?,?,?)').run(id, '', 0, req.user.id, now());
    db.prepare('INSERT INTO dm_members (thread_id,user_id,joined_at) VALUES (?,?,?)').run(id, req.user.id, now());
    db.prepare('INSERT INTO dm_members (thread_id,user_id,joined_at) VALUES (?,?,?)').run(id, target.id, now());
  })();
  notifyUser(target.id, { t: 'dm-threads-changed' });
  res.json({ thread: dmThreadView(db.prepare('SELECT * FROM dm_threads WHERE id = ?').get(id)) });
});
app.post('/api/dms/group', authRequired, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40) || 'Group chat';
  const ids = [...new Set((req.body?.userIds || []).map(String))].filter((v) => v !== req.user.id).slice(0, 9);
  for (const oid of ids) {
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(oid)) return res.status(404).json({ error: 'user_not_found' });
    if (!areFriends(req.user.id, oid)) return res.status(403).json({ error: 'add_friend_first' });
  }
  const id = uid();
  db.transaction(() => {
    db.prepare('INSERT INTO dm_threads (id,name,is_group,created_by,created_at) VALUES (?,?,?,?,?)').run(id, name, 1, req.user.id, now());
    db.prepare('INSERT INTO dm_members (thread_id,user_id,joined_at) VALUES (?,?,?)').run(id, req.user.id, now());
    for (const oid of ids) db.prepare('INSERT INTO dm_members (thread_id,user_id,joined_at) VALUES (?,?,?)').run(id, oid, now());
  })();
  for (const oid of ids) notifyUser(oid, { t: 'dm-threads-changed' });
  res.json({ thread: dmThreadView(db.prepare('SELECT * FROM dm_threads WHERE id = ?').get(id)) });
});
app.post('/api/dms/:tid/members', authRequired, (req, res) => {
  const t = dmThreadFor(req.user.id, req.params.tid);
  if (!t) return res.status(404).json({ error: 'no_thread' });
  const oid = String(req.body?.userId || '');
  if (oid === req.user.id || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(oid)) return res.status(404).json({ error: 'user_not_found' });
  if (!areFriends(req.user.id, oid)) return res.status(403).json({ error: 'add_friend_first' });
  if (dmBanned(t.id, oid)) return res.status(403).json({ error: 'banned_from_group' });
  db.prepare('INSERT OR IGNORE INTO dm_members (thread_id,user_id,joined_at) VALUES (?,?,?)').run(t.id, oid, now());
  if (!t.is_group) db.prepare('UPDATE dm_threads SET is_group = 1 WHERE id = ?').run(t.id);
  dmNotify(t.id, { t: 'dm-threads-changed' });
  res.json({ ok: true });
});
app.post('/api/dms/:tid/leave', authRequired, (req, res) => {
  const t = dmThreadFor(req.user.id, req.params.tid);
  if (!t) return res.status(404).json({ error: 'no_thread' });
  db.prepare('DELETE FROM dm_members WHERE thread_id = ? AND user_id = ?').run(t.id, req.user.id);
  postDmSys(t.id, `${displayOf(req.user)} left ${t.is_group ? 'the group' : 'the chat'}`);
  dmNotify(t.id, { t: 'dm-threads-changed' });
  maybeDeleteEmptyDmThread(t.id);
  res.json({ ok: true });
});
// Dismiss a DM from your list (per-user hide; membership kept, peer not notified).
// Reappears on new messages or when reopened via POST /api/dms or /open.
app.post('/api/dms/:tid/close', authRequired, (req, res) => {
  const t = dmThreadFor(req.user.id, req.params.tid);
  if (!t) return res.status(404).json({ error: 'no_thread' });
  db.prepare('UPDATE dm_members SET hidden = 1 WHERE thread_id = ? AND user_id = ?').run(t.id, req.user.id);
  notifyUser(req.user.id, { t: 'dm-threads-changed' });
  res.json({ ok: true });
});
app.post('/api/dms/:tid/open', authRequired, (req, res) => {
  const t = dmThreadFor(req.user.id, req.params.tid);
  if (!t) return res.status(404).json({ error: 'no_thread' });
  db.prepare('UPDATE dm_members SET hidden = 0 WHERE thread_id = ? AND user_id = ?').run(t.id, req.user.id);
  res.json({ thread: dmThreadView(t) });
});

app.post('/api/dms/:tid/members/:uid/remove', authRequired, (req, res) => {
  const t = dmThreadFor(req.user.id, req.params.tid);
  if (!t) return res.status(404).json({ error: 'no_thread' });
  if (!t.is_group) return res.status(400).json({ error: 'not_group' });
  if (t.created_by !== req.user.id) return res.status(403).json({ error: 'creator_only' });
  const target = String(req.params.uid);
  if (target === req.user.id || target === t.created_by) return res.status(400).json({ error: 'cannot_remove' });
  if (!db.prepare('SELECT 1 FROM dm_members WHERE thread_id = ? AND user_id = ?').get(t.id, target)) return res.status(404).json({ error: 'not_member' });
  const u = publicUser(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(target));
  db.prepare('DELETE FROM dm_members WHERE thread_id = ? AND user_id = ?').run(t.id, target);
  postDmSys(t.id, `${displayOf(u)} was removed`);
  dmNotify(t.id, { t: 'dm-threads-changed' });
  notifyUser(target, { t: 'removed-from-dm', threadId: t.id });
  maybeDeleteEmptyDmThread(t.id);
  res.json({ ok: true });
});

app.post('/api/dms/:tid/members/:uid/ban', authRequired, (req, res) => {
  const t = dmThreadFor(req.user.id, req.params.tid);
  if (!t) return res.status(404).json({ error: 'no_thread' });
  if (!t.is_group) return res.status(400).json({ error: 'not_group' });
  if (t.created_by !== req.user.id) return res.status(403).json({ error: 'creator_only' });
  const target = String(req.params.uid);
  if (target === req.user.id || target === t.created_by) return res.status(400).json({ error: 'cannot_remove' });
  if (!db.prepare('SELECT 1 FROM dm_members WHERE thread_id = ? AND user_id = ?').get(t.id, target)) return res.status(404).json({ error: 'not_member' });
  const u = publicUser(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(target));
  db.transaction(() => {
    db.prepare('DELETE FROM dm_members WHERE thread_id = ? AND user_id = ?').run(t.id, target);
    db.prepare('INSERT OR IGNORE INTO dm_bans (thread_id,user_id,created_at) VALUES (?,?,?)').run(t.id, target, now());
  })();
  postDmSys(t.id, `${displayOf(u)} was banned`);
  dmNotify(t.id, { t: 'dm-threads-changed' });
  notifyUser(target, { t: 'removed-from-dm', threadId: t.id });
  maybeDeleteEmptyDmThread(t.id);
  res.json({ ok: true });
});

app.get('/api/dms/:tid/bans', authRequired, (req, res) => {
  const t = dmThreadFor(req.user.id, req.params.tid);
  if (!t) return res.status(404).json({ error: 'no_thread' });
  if (t.created_by !== req.user.id) return res.status(403).json({ error: 'creator_only' });
  const rows = db.prepare('SELECT user_id, created_at FROM dm_bans WHERE thread_id = ? ORDER BY created_at DESC').all(t.id);
  const bans = rows.map((r) => {
    const u = publicUser(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(r.user_id));
    return { ...u, banned_at: r.created_at };
  });
  res.json({ bans });
});

app.delete('/api/dms/:tid/bans/:uid', authRequired, (req, res) => {
  const t = dmThreadFor(req.user.id, req.params.tid);
  if (!t) return res.status(404).json({ error: 'no_thread' });
  if (t.created_by !== req.user.id) return res.status(403).json({ error: 'creator_only' });
  db.prepare('DELETE FROM dm_bans WHERE thread_id = ? AND user_id = ?').run(t.id, String(req.params.uid));
  res.json({ ok: true });
});
app.get('/api/dms/:tid/messages', authRequired, (req, res) => {
  const t = dmThreadFor(req.user.id, req.params.tid);
  if (!t) return res.status(404).json({ error: 'no_thread' });
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
  const around = String(req.query.around || '');
  if (around) {
    // context window around one message (for jump-to-pin): half older, half newer
    const target = db.prepare('SELECT * FROM dm_messages WHERE id = ? AND thread_id = ?').get(around, t.id);
    if (!target) return res.status(404).json({ error: 'no_message' });
    const half = Math.floor(limit / 2);
    const older = db.prepare('SELECT id FROM dm_messages WHERE thread_id = ? AND created_at <= ? ORDER BY created_at DESC LIMIT ?').all(t.id, target.created_at, half + 1).map((r) => r.id);
    const seen = new Set(older);
    const newer = db.prepare('SELECT id FROM dm_messages WHERE thread_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT ?').all(t.id, target.created_at, Math.max(0, limit - older.length)).map((r) => r.id).filter((x) => !seen.has(x));
    const msgs = [...older, ...newer].map((x) => fullDm(x, req.user.id)).filter(Boolean)
      .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
    return res.json({ messages: msgs });
  }
  const before = parseInt(req.query.before || String(Date.now() + 1), 10);
  const rows = db.prepare(`${DM_JOIN} WHERE m.thread_id = ? AND m.created_at < ? ORDER BY m.created_at DESC LIMIT ?`).all(t.id, before, limit);
  res.json({ messages: hydrateDm(rows.reverse(), req.user.id) });
});
function dmMsg(mid) { return db.prepare('SELECT * FROM dm_messages WHERE id = ?').get(mid); }
app.patch('/api/dms/messages/:mid', authRequired, (req, res) => {
  const m = dmMsg(req.params.mid);
  if (!m || !dmThreadFor(req.user.id, m.thread_id)) return res.status(404).json({ error: 'no_message' });
  if (m.user_id !== req.user.id) return res.status(403).json({ error: 'only_your_own' });
  const content = String(req.body?.content || '').trim().slice(0, 5000);
  if (!content) return res.status(400).json({ error: 'empty_message' });
  db.prepare('UPDATE dm_messages SET content = ?, edited_at = ? WHERE id = ?').run(content, now(), m.id);
  const full = fullDm(m.id, req.user.id);
  dmNotify(m.thread_id, { t: 'dm-updated', message: full });
  res.json({ message: full });
});
app.delete('/api/dms/messages/:mid', authRequired, (req, res) => {
  const m = dmMsg(req.params.mid);
  if (!m || !dmThreadFor(req.user.id, m.thread_id)) return res.status(404).json({ error: 'no_message' });
  if (m.user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  db.prepare('DELETE FROM dm_messages WHERE id = ?').run(m.id);
  if (db.prepare('DELETE FROM dm_pins WHERE message_id = ?').run(m.id).changes) {
    dmNotify(m.thread_id, { t: 'dm-pins-changed', threadId: m.thread_id });
  }
  dmNotify(m.thread_id, { t: 'dm-deleted', threadId: m.thread_id, messageId: m.id });
  res.json({ ok: true });
});

// ---------- pinned messages (DM threads: 1:1 and groups) ----------
app.get('/api/dms/:tid/pins', authRequired, (req, res) => {
  const t = dmThreadFor(req.user.id, req.params.tid);
  if (!t) return res.status(404).json({ error: 'no_thread' });
  const rows = db.prepare('SELECT * FROM dm_pins WHERE thread_id = ? ORDER BY created_at DESC LIMIT 50').all(t.id);
  const pins = [];
  for (const p of rows) {
    const full = fullDm(p.message_id, req.user.id);
    if (full) pins.push({ ...full, ...pinInfo(p) });
  }
  res.json({ pins });
});
app.post('/api/dms/:tid/pins', authRequired, (req, res) => {
  const t = dmThreadFor(req.user.id, req.params.tid);
  if (!t) return res.status(404).json({ error: 'no_thread' });
  const mid = String(req.body?.messageId || '');
  const m = db.prepare('SELECT * FROM dm_messages WHERE id = ? AND thread_id = ?').get(mid, t.id);
  if (!m) return res.status(404).json({ error: 'no_message' });
  if (db.prepare('SELECT 1 FROM dm_pins WHERE message_id = ?').get(mid)) return res.status(409).json({ error: 'already_pinned' });
  db.prepare('INSERT INTO dm_pins (thread_id,message_id,pinned_by,created_at) VALUES (?,?,?,?)').run(t.id, mid, req.user.id, now());
  dmNotify(t.id, { t: 'dm-pins-changed', threadId: t.id });
  res.json({ ok: true });
});
app.delete('/api/dms/:tid/pins/:mid', authRequired, (req, res) => {
  const t = dmThreadFor(req.user.id, req.params.tid);
  if (!t) return res.status(404).json({ error: 'no_thread' });
  const p = db.prepare('SELECT * FROM dm_pins WHERE message_id = ? AND thread_id = ?').get(req.params.mid, t.id);
  if (!p) return res.status(404).json({ error: 'not_pinned' });
  db.prepare('DELETE FROM dm_pins WHERE message_id = ?').run(req.params.mid);
  dmNotify(t.id, { t: 'dm-pins-changed', threadId: t.id });
  res.json({ ok: true });
});
app.post('/api/dms/messages/:mid/reactions', authRequired, (req, res) => {
  const m = dmMsg(req.params.mid);
  if (!m || !dmThreadFor(req.user.id, m.thread_id)) return res.status(404).json({ error: 'no_message' });
  const emoji = String(req.body?.emoji || '');
  if (!emoji || /[:<>"'&]/.test(emoji) || [...emoji].length < 1 || emoji.length > 24) return res.status(400).json({ error: 'bad_emoji' });
  const ex = db.prepare('SELECT 1 FROM dm_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(m.id, req.user.id, emoji);
  if (ex) db.prepare('DELETE FROM dm_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(m.id, req.user.id, emoji);
  else db.prepare('INSERT INTO dm_reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,?)').run(m.id, req.user.id, emoji, now());
  const tally = db.prepare('SELECT emoji, user_id FROM dm_reactions WHERE message_id = ?').all(m.id);
  const t = {};
  for (const r of tally) { const e = (t[r.emoji] = t[r.emoji] || { emoji: r.emoji, count: 0, users: [] }); e.count++; e.users.push(r.user_id); }
  const out = Object.values(t);
  dmNotify(m.thread_id, { t: 'dm-reaction', threadId: m.thread_id, messageId: m.id, reactions: out });
  res.json({ reactions: out.map((e) => ({ emoji: e.emoji, count: e.count, me: e.users.includes(req.user.id) })) });
});

// ---------- GIF search (Klipy, key stays server-side) ----------
function normGif(it) {
  const f = it.file || {}, md = f.md || {}, sm = f.sm || {}, xs = f.xs || {};
  return {
    title: it.title || '', slug: it.slug || '',
    gif: (md.gif || {}).url || null, mp4: (md.mp4 || {}).url || null,
    thumb: (xs.gif || sm.gif || md.gif || {}).url || null,
    preview: (xs.jpg || xs.webp || md.jpg || {}).url || it.blur_preview || null,
    w: (md.gif || {}).width || null, h: (md.gif || {}).height || null,
  };
}
async function klipyFetch(kind, params) {
  const url = `https://api.klipy.com/api/v1/${KLIPY_KEY}/gifs/${kind}?` + new URLSearchParams({ perPage: '24', contentFilter: 'medium', ...params });
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('gif_upstream_' + r.status);
  const j = await r.json();
  return (j.data?.data || []).map(normGif).filter((g) => g.gif);
}
app.get('/api/gifs/search', authRequired, async (req, res) => {
  if (!KLIPY_KEY) return res.status(501).json({ error: 'gif_not_configured (set KLIPY_KEY)' });
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (!q) return res.status(400).json({ error: 'query_required' });
  try { res.json({ gifs: await klipyFetch('search', { q }) }); }
  catch { res.status(502).json({ error: 'gif_upstream' }); }
});
app.get('/api/gifs/trending', authRequired, async (req, res) => {
  if (!KLIPY_KEY) return res.status(501).json({ error: 'gif_not_configured (set KLIPY_KEY)' });
  try { res.json({ gifs: await klipyFetch('trending', {}) }); }
  catch { res.status(502).json({ error: 'gif_upstream' }); }
});

function fullMessage(id, meId) {
  const row = db.prepare(`
    SELECT m.*, u.username, u.display_name, u.avatar_color, u.avatar_url,
           p.content AS p_content, pu.display_name AS p_name
    FROM messages m LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN messages p ON p.id = m.reply_to_id
    LEFT JOIN users pu ON pu.id = p.user_id
    WHERE m.id = ?
  `).get(id);
  return row ? hydrateMessages([row], meId)[0] : null;
}
function presenceFor(serverId, forUserId) {
  const map = {};
  for (const c of clients) {
    if (!c.meta || !c.meta.servers.has(serverId)) continue;
    if ((c.meta.status || 'online') === 'invisible' && c.meta.userId !== forUserId) continue;
    map[c.meta.userId] = c.meta.status || 'online';
  }
  return map;
}
function fmtMsg(r) {
  return {
    id: r.id, serverId: r.server_id, channelId: r.channel_id,
    content: r.content, created_at: r.created_at,
    replyTo: r.reply_to_id ? { id: r.reply_to_id, author: r.p_name || 'deleted', snippet: String(r.p_content || '').slice(0, 140) } : null,
    threadRoot: r.thread_root_id || null,
    sys: r.sys || null,
    fwdFrom: r.fwd_from || null,
    threadCount: 0, edited: !!r.edited_at,
    attachments: [], reactions: [],
    user: r.user_id ? publicUser({ id: r.user_id, username: r.username, display_name: r.display_name, avatar_color: r.avatar_color, avatar_url: r.avatar_url }) : null,
  };
}
// Batch-load attachments, reaction tallies, and reply counts for a page of messages.
function hydrateMessages(rows, meId) {
  const ids = rows.map((r) => r.id);
  const attBy = {}, reactBy = {}, countBy = {};
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    for (const a of db.prepare(`SELECT * FROM attachments WHERE message_id IN (${ph}) ORDER BY created_at ASC`).all(...ids)) {
      (attBy[a.message_id] = attBy[a.message_id] || []).push({ url: a.url, name: a.filename, mime: a.mime, size: a.size, kind: a.kind });
    }
    for (const r of db.prepare(`SELECT message_id, emoji, user_id FROM message_reactions WHERE message_id IN (${ph})`).all(...ids)) {
      const t = (reactBy[r.message_id] = reactBy[r.message_id] || {});
      const e = (t[r.emoji] = t[r.emoji] || { emoji: r.emoji, count: 0, users: [] });
      e.count++; e.users.push(r.user_id);
    }
    for (const c of db.prepare(`SELECT thread_root_id r, COUNT(*) c FROM messages WHERE thread_root_id IN (${ph}) GROUP BY thread_root_id`).all(...ids)) {
      countBy[c.r] = c.c;
    }
  }
  return rows.map((r) => {
    const m = fmtMsg(r);
    m.attachments = attBy[r.id] || [];
    const tally = Object.values(reactBy[r.id] || {});
    m.reactions = tally.map((t) => ({ emoji: t.emoji, count: t.count, me: t.users.includes(meId) }));
    m.threadCount = countBy[r.id] || 0;
    return m;
  });
}
function reactionTally(messageId, meId) {
  const rows = db.prepare('SELECT emoji, user_id FROM message_reactions WHERE message_id = ?').all(messageId);
  const t = {};
  for (const r of rows) {
    const e = (t[r.emoji] = t[r.emoji] || { emoji: r.emoji, count: 0, users: [] });
    e.count++; e.users.push(r.user_id);
  }
  return Object.values(t).map((e) => ({ emoji: e.emoji, count: e.count, me: e.users.includes(meId), users: e.users }));
}
function broadcastUserUpdate(user) {
  const rows = db.prepare('SELECT server_id FROM server_members WHERE user_id = ?').all(user.id);
  for (const r of rows) broadcastToServer(r.server_id, { t: 'user-updated', user });
}

// ---------- WebSocket (live chat + presence + voice signaling) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** ws.meta = { userId, username, display_name, avatar_color, servers:Set, voice:{serverId,channelId,muted}|null } */
const clients = new Set();
const voiceRooms = new Map(); // key `${serverId}:${channelId}` -> Set<ws>

function safeSend(ws, obj) {
  if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} }
}
function broadcastToServer(serverId, obj, except) {
  for (const ws of clients) {
    if (ws.meta && ws.meta.servers.has(serverId) && ws !== except) safeSend(ws, obj);
  }
}
function voiceKey(s, c) { return s + ':' + c; }
function voicePeersPayload(key) {
  const set = voiceRooms.get(key) || new Set();
  return [...set].map((ws) => ({
    id: ws.meta.userId,
    username: ws.meta.username,
    display_name: ws.meta.display_name,
    avatar_color: ws.meta.avatar_color,
    avatar_url: ws.meta.avatar_url || null,
    muted: !!(ws.meta.voice && ws.meta.voice.muted),
    speaking: !!(ws.meta.voice && ws.meta.voice.speaking),
    deafened: !!(ws.meta.voice && ws.meta.voice.deafened),
    camera: !!(ws.meta.voice && ws.meta.voice.camera),
    sharing: !!(ws.meta.voice && ws.meta.voice.sharing),
  }));
}
function findWsInVoice(key, userId) {
  for (const ws of voiceRooms.get(key) || []) {
    if (ws.meta.userId === userId) return ws;
  }
  return null;
}
function leaveVoice(ws, notify = true) {
  const v = ws.meta && ws.meta.voice;
  if (!v) return;
  const key = voiceKey(v.serverId, v.channelId);
  const set = voiceRooms.get(key);
  if (set) {
    set.delete(ws);
    if (set.size === 0) voiceRooms.delete(key);
  }
  ws.meta.voice = null;
  if (notify) {
    broadcastToServer(v.serverId, { t: 'voice-peer-left', serverId: v.serverId, channelId: v.channelId, userId: ws.meta.userId });
    // send updated list to remaining occupants… and to the leaver too,
    // otherwise their own sidebar keeps showing them until a refresh
    const peers = voicePeersPayload(key);
    for (const other of voiceRooms.get(key) || []) safeSend(other, { t: 'voice-peers', serverId: v.serverId, channelId: v.channelId, peers });
    safeSend(ws, { t: 'voice-peers', serverId: v.serverId, channelId: v.channelId, peers });
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token') || '';
  let p;
  try { p = jwt.verify(token, JWT_SECRET); } catch { ws.close(4401, 'bad token'); return; }
  const u = db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(p.sub);
  if (!u) { ws.close(4401, 'no user'); return; }
  const memberRows = db.prepare('SELECT server_id FROM server_members WHERE user_id = ?').all(u.id);
  ws.meta = {
    userId: u.id, username: u.username, display_name: u.display_name, avatar_color: u.avatar_color,
    avatar_url: u.avatar_url || null, status: u.status || 'online',
    servers: new Set(memberRows.map((r) => r.server_id)),
    voice: null,
  };
  clients.add(ws);
  safeSend(ws, { t: 'hello', user: publicUser(u), version: APP_VERSION });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const me = ws.meta;
    if (!me) return;

    if (msg.t === 'subscribe') {
      // refresh memberships
      const rows = db.prepare('SELECT server_id FROM server_members WHERE user_id = ?').all(me.userId);
      me.servers = new Set(rows.map((r) => r.server_id));
      // send presence roster per server (invisible users hidden from others)
      for (const sid of me.servers) {
        safeSend(ws, { t: 'presence', serverId: sid, online: presenceFor(sid, me.userId) });
      }
      // announce online to others (unless invisible)
      if ((me.status || 'online') !== 'invisible') {
        for (const sid of me.servers) broadcastToServer(sid, { t: 'user-online', serverId: sid, userId: me.userId, status: me.status || 'online' }, ws);
      }
      // send current voice occupancy for my servers
      for (const [key, set] of voiceRooms) {
        const [srv] = key.split(':');
        if (me.servers.has(srv)) {
          const [, ch] = key.split(':');
          safeSend(ws, { t: 'voice-peers', serverId: srv, channelId: ch, peers: voicePeersPayload(key) });
        }
      }
      return;
    }

    if (msg.t === 'message') {
      const serverId = String(msg.serverId || '');
      const channelId = String(msg.channelId || '');
      const content = String(msg.content || '').trim().slice(0, 5000);
      const replyTo = String(msg.replyTo || '') || null;
      const threadRoot = String(msg.threadRoot || '') || null;
      const atts = Array.isArray(msg.attachments) ? msg.attachments.slice(0, 5) : [];
      if ((!content && !atts.length) || !serverId || !channelId) return;
      if (!me.servers.has(serverId) || !isMember(serverId, me.userId)) return;
      const ch = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(channelId, serverId);
      if (!ch || ch.type !== 'text') return;
      if (!rateOk(me.userId)) { safeSend(ws, { t: 'error', error: 'slow_down' }); return; }
      if (ch.slowmode > 0) {
        const srv = getServer(serverId);
        if (srv && srv.owner_id !== me.userId) {
          const wait = slowBlocked(channelId, me.userId, ch.slowmode);
          if (wait > 0) { safeSend(ws, { t: 'error', error: 'slow_mode', retryAfter: wait }); return; }
        }
      }
      if (replyTo) {
        const pr = db.prepare('SELECT channel_id FROM messages WHERE id = ? AND server_id = ?').get(replyTo, serverId);
        if (!pr || pr.channel_id !== channelId) return;
      }
      if (threadRoot) {
        const rr = db.prepare('SELECT channel_id FROM messages WHERE id = ? AND server_id = ?').get(threadRoot, serverId);
        if (!rr || rr.channel_id !== channelId) return;
      }
      const cleanAtts = [];
      for (const a of atts) {
        const url = String(a?.url || '');
        const isLocal = url.startsWith('/uploads/files/');
        const isRemoteImg = a?.kind === 'image' && /^https:\/\//.test(url);
        if (!isLocal && !isRemoteImg) continue;
        const mime = String(a?.mime || 'application/octet-stream').slice(0, 80);
        const kind = isLocal
          ? (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file')
          : 'image';
        cleanAtts.push({ url, name: String(a?.name || 'file').slice(0, 120), mime, size: Math.max(0, Math.min(parseInt(a?.size || 0, 10) || 0, 100 * 1024 * 1024)), kind });
      }
      if (!content && !cleanAtts.length) return;
      const mid = uid();
      const fwdFrom = String(msg.fwdFrom || '').trim().slice(0, 64) || null;
      db.prepare('INSERT INTO messages (id,server_id,channel_id,user_id,content,reply_to_id,thread_root_id,fwd_from,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(mid, serverId, channelId, me.userId, content, replyTo, threadRoot, fwdFrom, now());
      const insAtt = db.prepare('INSERT INTO attachments (id,message_id,url,filename,mime,size,kind,created_at) VALUES (?,?,?,?,?,?,?,?)');
      for (const a of cleanAtts) insAtt.run(uid(), mid, a.url, a.name, a.mime, a.size, a.kind, now());
      const full = fullMessage(mid, null);
      broadcastToServer(serverId, { t: 'message-new', serverId, channelId, message: full });
      notifyServerMessage(serverId, channelId, me, content);
      return;
    }

    if (msg.t === 'typing') {
      const { serverId } = msg;
      if (serverId && me.servers.has(serverId)) {
        broadcastToServer(serverId, { t: 'typing', serverId, channelId: msg.channelId, userId: me.userId, display_name: me.display_name }, ws);
      }
      return;
    }

    if (msg.t === 'dm') {
      const threadId = String(msg.threadId || '');
      const t = dmThreadFor(me.userId, threadId);
      if (!t) return;
      const content = String(msg.content || '').trim().slice(0, 5000);
      const replyTo = String(msg.replyTo || '') || null;
      const cleanAtts = cleanAttachments(msg.attachments);
      if (!content && !cleanAtts.length) return;
      if (!rateOk(me.userId)) { safeSend(ws, { t: 'error', error: 'slow_down' }); return; }
      if (replyTo && !db.prepare('SELECT id FROM dm_messages WHERE id = ? AND thread_id = ?').get(replyTo, threadId)) return;
      const mid = uid();
      const fwdFrom = String(msg.fwdFrom || '').trim().slice(0, 64) || null;
      db.prepare('INSERT INTO dm_messages (id,thread_id,user_id,content,reply_to_id,fwd_from,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(mid, threadId, me.userId, content, replyTo, fwdFrom, now());
      db.prepare('UPDATE dm_members SET hidden = 0 WHERE thread_id = ?').run(threadId);
      const insAtt = db.prepare('INSERT INTO dm_attachments (id,message_id,url,filename,mime,size,kind,created_at) VALUES (?,?,?,?,?,?,?,?)');
      for (const a of cleanAtts) insAtt.run(uid(), mid, a.url, a.name, a.mime, a.size, a.kind, now());
      dmNotify(threadId, { t: 'dm-new', message: fullDm(mid, null) });
      notifyDmMessage(t, me, content);
      return;
    }

    if (msg.t === 'dm-typing') {
      const t = dmThreadFor(me.userId, String(msg.threadId || ''));
      if (!t) return;
      const mems = db.prepare('SELECT user_id FROM dm_members WHERE thread_id = ? AND user_id != ?').all(t.id, me.userId).map((r) => r.user_id);
      for (const uid of mems) notifyUser(uid, { t: 'dm-typing', threadId: t.id, userId: me.userId, display_name: me.display_name });
      return;
    }

    if (msg.t === 'voice-join') {
      const serverId = String(msg.serverId || '');
      const channelId = String(msg.channelId || '');
      if (!me.servers.has(serverId) || !isMember(serverId, me.userId)) return;
      const ch = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(channelId, serverId);
      if (!ch || ch.type !== 'voice') return;
      if (me.voice) leaveVoice(ws);
      me.voice = { serverId, channelId, muted: false, deafened: false, camera: false, sharing: false };
      const key = voiceKey(serverId, channelId);
      if (!voiceRooms.has(key)) voiceRooms.set(key, new Set());
      voiceRooms.get(key).add(ws);
      // tell joiner full peer list
      safeSend(ws, { t: 'voice-peers', serverId, channelId, peers: voicePeersPayload(key) });
      // tell others someone joined
      broadcastToServer(serverId, {
        t: 'voice-peer-joined', serverId, channelId,
        peer: { id: me.userId, username: me.username, display_name: me.display_name, avatar_color: me.avatar_color, avatar_url: me.avatar_url || null, muted: false, speaking: false, deafened: false, camera: false, sharing: false },
      }, ws);
      // also broadcast updated occupancy to whole server (for channel user counts)
      broadcastToServer(serverId, { t: 'voice-peers', serverId, channelId, peers: voicePeersPayload(key) }, ws);
      return;
    }

    if (msg.t === 'voice-leave') {
      leaveVoice(ws);
      return;
    }

    if (msg.t === 'voice-state') {
      if (!me.voice) return;
      me.voice.muted = !!msg.muted;
      me.voice.deafened = !!msg.deafened;
      me.voice.camera = !!msg.camera;
      me.voice.sharing = !!msg.sharing;
      if (typeof msg.speaking === 'boolean') me.voice.speaking = msg.speaking;
      if (me.voice.muted || me.voice.deafened) me.voice.speaking = false;
      broadcastToServer(me.voice.serverId, {
        t: 'voice-state', serverId: me.voice.serverId, channelId: me.voice.channelId,
        userId: me.userId, muted: me.voice.muted, speaking: !!me.voice.speaking,
        deafened: me.voice.deafened, camera: me.voice.camera, sharing: me.voice.sharing,
      });
      return;
    }

    if (msg.t === 'voice-signal') {
      if (!me.voice) return;
      const key = voiceKey(me.voice.serverId, me.voice.channelId);
      const target = findWsInVoice(key, String(msg.to || ''));
      if (!target) return;
      safeSend(target, { t: 'voice-signal', serverId: me.voice.serverId, channelId: me.voice.channelId, from: me.userId, data: msg.data });
      return;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (ws.meta) {
      if (ws.meta.voice) leaveVoice(ws);
      for (const sid of ws.meta.servers || []) {
        // only broadcast offline if no other socket for this user still in server
        const stillOn = [...clients].some((c) => c.meta && c.meta.userId === ws.meta.userId && c.meta.servers.has(sid));
        if (!stillOn) broadcastToServer(sid, { t: 'user-offline', serverId: sid, userId: ws.meta.userId });
      }
    }
  });
});

// SPA fallback (after API + static)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[campfire] listening on :${PORT}  db=${process.env.DB_PATH || 'data/campfire.db'}`);
});
