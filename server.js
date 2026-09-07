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
function getServer(serverId) {
  return db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
}
function serverView(serverId) {
  const s = getServer(serverId);
  if (!s) return null;
  const channels = db.prepare("SELECT * FROM channels WHERE server_id = ? ORDER BY type DESC, position ASC, created_at ASC").all(serverId);
  const members = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_color, u.avatar_url, u.banner_url,
           u.status, u.status_text,
           CASE WHEN u.id = s.owner_id THEN 'owner' ELSE 'member' END as role
    FROM server_members m JOIN users u ON u.id = m.user_id JOIN servers s ON s.id = m.server_id
    WHERE m.server_id = ? ORDER BY u.display_name COLLATE NOCASE ASC
  `).all(serverId);
  return { ...s, channels, members };
}
function publicUser(u) {
  if (!u) return { id: null, username: 'deleted', display_name: 'deleted user', avatar_color: '#555' };
  return {
    id: u.id, username: u.username, display_name: u.display_name, avatar_color: u.avatar_color || '#5865f2',
    avatar_url: u.avatar_url || null, banner_url: u.banner_url || null,
    status: u.status || 'online', status_text: u.status_text || '',
    created_at: u.created_at || null,
  };
}
const USER_COLS = 'id, username, display_name, avatar_color, avatar_url, banner_url, status, status_text, created_at';

// simple in-memory rate limit for posting messages: 10 msgs / 10s per user
const rl = new Map();
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
  res.json({ iceServers, origin: ORIGIN });
});

app.post('/api/register', async (req, res) => {
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

app.post('/api/servers/join', authRequired, (req, res) => {
  const code = String(req.body?.inviteCode || req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'code_required' });
  const s = db.prepare('SELECT * FROM servers WHERE invite_code = ?').get(code);
  if (!s) return res.status(404).json({ error: 'bad_invite' });
  if (!isMember(s.id, req.user.id)) {
    const maxP = db.prepare('SELECT COALESCE(MAX(position),-1) m FROM server_members WHERE user_id = ?').get(req.user.id).m;
    db.prepare('INSERT INTO server_members (server_id,user_id,joined_at,position) VALUES (?,?,?,?)').run(s.id, req.user.id, now(), maxP + 1);
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
  if (s.owner_id !== req.user.id) return res.status(403).json({ error: 'owner_only' });
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

app.post('/api/servers/:id/leave', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (s.owner_id === req.user.id) return res.status(400).json({ error: 'owner_cannot_leave_delete_instead' });
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(s.id, req.user.id);
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
  if (s.owner_id !== req.user.id) return res.status(403).json({ error: 'owner_only' });
  const code = makeInvite();
  db.prepare('UPDATE servers SET invite_code = ? WHERE id = ?').run(code, s.id);
  broadcastToServer(s.id, { t: 'invite-updated', serverId: s.id, invite_code: code });
  res.json({ invite_code: code });
});

app.get('/api/servers/:id/channels/:chId/messages', authRequired, (req, res) => {
  const { id, chId } = req.params;
  if (!isMember(id, req.user.id)) return res.status(403).json({ error: 'not_member' });
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
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
  const canDelete = m.user_id === req.user.id || (s && s.owner_id === req.user.id);
  if (!canDelete) return res.status(403).json({ error: 'forbidden' });
  db.prepare('DELETE FROM messages WHERE id = ?').run(m.id);
  broadcastToServer(m.server_id, { t: 'message-deleted', serverId: m.server_id, channelId: m.channel_id, messageId: m.id });
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
function setProfileUrl(req, res, col, kind) {
  const url = String(req.body?.url || '').trim().slice(0, 500);
  if (!/^https:\/\//.test(url)) return res.status(400).json({ error: 'bad_url (https only)' });
  deleteUploaded(req.user[col]);
  db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(url, req.user.id);
  recordMedia(req.user.id, kind, url);
  const u = freshUser(req.user.id);
  broadcastUserUpdate(u);
  res.json({ user: u, history: mediaHist(req.user.id, kind) });
}
app.post('/api/me/avatar/url', authRequired, (req, res) => setProfileUrl(req, res, 'avatar_url', 'avatar'));
app.post('/api/me/banner/url', authRequired, (req, res) => setProfileUrl(req, res, 'banner_url', 'banner'));
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
  if (s.owner_id !== req.user.id) return res.status(403).json({ error: 'owner_only' });
  const name = String(req.body?.name || '').trim().slice(0, 48);
  if (!name) return res.status(400).json({ error: 'name_required' });
  db.prepare('UPDATE servers SET name = ? WHERE id = ?').run(name, s.id);
  broadcastToServer(s.id, { t: 'server-updated', server: serverView(s.id) });
  res.json({ server: serverView(s.id) });
});
app.post('/api/servers/:id/icon', authRequired, imgSingle(upIcon), (req, res) => {
  const s = getServer(req.params.id);
  if (!s) { deleteUploaded(uploadUrl('icons', req.file)); return res.status(404).json({ error: 'no_server' }); }
  if (s.owner_id !== req.user.id) { deleteUploaded(uploadUrl('icons', req.file)); return res.status(403).json({ error: 'owner_only' }); }
  const url = uploadUrl('icons', req.file);
  deleteUploaded(s.icon_url);
  db.prepare('UPDATE servers SET icon_url = ? WHERE id = ?').run(url, s.id);
  broadcastToServer(s.id, { t: 'server-updated', server: serverView(s.id) });
  res.json({ server: serverView(s.id) });
});
app.delete('/api/servers/:id/icon', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (s.owner_id !== req.user.id) return res.status(403).json({ error: 'owner_only' });
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
  if (s.owner_id !== req.user.id) return res.status(403).json({ error: 'owner_only' });
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
  const content = String(req.body?.content || '').trim().slice(0, 2000);
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
      const content = String(msg.content || '').trim().slice(0, 2000);
      const replyTo = String(msg.replyTo || '') || null;
      const threadRoot = String(msg.threadRoot || '') || null;
      const atts = Array.isArray(msg.attachments) ? msg.attachments.slice(0, 5) : [];
      if ((!content && !atts.length) || !serverId || !channelId) return;
      if (!me.servers.has(serverId) || !isMember(serverId, me.userId)) return;
      const ch = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(channelId, serverId);
      if (!ch || ch.type !== 'text') return;
      if (!rateOk(me.userId)) { safeSend(ws, { t: 'error', error: 'slow_down' }); return; }
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
      db.prepare('INSERT INTO messages (id,server_id,channel_id,user_id,content,reply_to_id,thread_root_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(mid, serverId, channelId, me.userId, content, replyTo, threadRoot, now());
      const insAtt = db.prepare('INSERT INTO attachments (id,message_id,url,filename,mime,size,kind,created_at) VALUES (?,?,?,?,?,?,?,?)');
      for (const a of cleanAtts) insAtt.run(uid(), mid, a.url, a.name, a.mime, a.size, a.kind, now());
      const full = fullMessage(mid, null);
      broadcastToServer(serverId, { t: 'message-new', serverId, channelId, message: full });
      return;
    }

    if (msg.t === 'typing') {
      const { serverId } = msg;
      if (serverId && me.servers.has(serverId)) {
        broadcastToServer(serverId, { t: 'typing', serverId, channelId: msg.channelId, userId: me.userId, display_name: me.display_name }, ws);
      }
      return;
    }

    if (msg.t === 'voice-join') {
      const serverId = String(msg.serverId || '');
      const channelId = String(msg.channelId || '');
      if (!me.servers.has(serverId) || !isMember(serverId, me.userId)) return;
      const ch = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(channelId, serverId);
      if (!ch || ch.type !== 'voice') return;
      if (me.voice) leaveVoice(ws);
      me.voice = { serverId, channelId, muted: false };
      const key = voiceKey(serverId, channelId);
      if (!voiceRooms.has(key)) voiceRooms.set(key, new Set());
      voiceRooms.get(key).add(ws);
      // tell joiner full peer list
      safeSend(ws, { t: 'voice-peers', serverId, channelId, peers: voicePeersPayload(key) });
      // tell others someone joined
      broadcastToServer(serverId, {
        t: 'voice-peer-joined', serverId, channelId,
        peer: { id: me.userId, username: me.username, display_name: me.display_name, avatar_color: me.avatar_color, avatar_url: me.avatar_url || null, muted: false, speaking: false },
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
      if (typeof msg.speaking === 'boolean') me.voice.speaking = msg.speaking;
      if (me.voice.muted) me.voice.speaking = false;
      broadcastToServer(me.voice.serverId, {
        t: 'voice-state', serverId: me.voice.serverId, channelId: me.voice.channelId,
        userId: me.userId, muted: me.voice.muted, speaking: !!me.voice.speaking,
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
