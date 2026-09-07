const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const db = require('./db');

const PORT = parseInt(process.env.PORT || '3000', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (JWT_SECRET === 'dev-secret-change-me') {
  console.warn('[campfire] WARNING: using default JWT_SECRET. Set JWT_SECRET env var in production!');
}
const ORIGIN = process.env.ORIGIN || ''; // e.g. https://chat.example.com (used for hints only)

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.setHeader('Service-Worker-Allowed', '/');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

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
    const user = db.prepare('SELECT id, username, display_name, avatar_color, created_at FROM users WHERE id = ?').get(p.sub);
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
    SELECT u.id, u.username, u.display_name, u.avatar_color,
           CASE WHEN u.id = s.owner_id THEN 'owner' ELSE 'member' END as role
    FROM server_members m JOIN users u ON u.id = m.user_id JOIN servers s ON s.id = m.server_id
    WHERE m.server_id = ? ORDER BY u.display_name COLLATE NOCASE ASC
  `).all(serverId);
  return { ...s, channels, members };
}
function publicUser(u) {
  if (!u) return { id: null, username: 'deleted', display_name: 'deleted user', avatar_color: '#555' };
  return { id: u.id, username: u.username, display_name: u.display_name, avatar_color: u.avatar_color };
}

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
    db.prepare('INSERT INTO server_members (server_id,user_id,joined_at) VALUES (?,?,?)').run(s.id, req.user.id, now());
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
    db.prepare('INSERT OR IGNORE INTO server_members (server_id,user_id,joined_at) VALUES (?,?,?)').run(s.id, req.user.id, now());
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
    SELECT m.*, u.username, u.display_name, u.avatar_color
    FROM messages m LEFT JOIN users u ON u.id = m.user_id
    WHERE m.server_id = ? AND m.channel_id = ? AND m.created_at < ?
    ORDER BY m.created_at DESC LIMIT ?
  `).all(id, chId, before, limit);
  res.json({ messages: rows.reverse().map(fmtMsg) });
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

function fmtMsg(r) {
  return {
    id: r.id, serverId: r.server_id, channelId: r.channel_id,
    content: r.content, created_at: r.created_at,
    user: r.user_id ? { id: r.user_id, username: r.username, display_name: r.display_name, avatar_color: r.avatar_color } : null,
  };
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
    muted: !!(ws.meta.voice && ws.meta.voice.muted),
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
    // send updated list to remaining occupants
    const peers = voicePeersPayload(key);
    for (const other of voiceRooms.get(key) || []) safeSend(other, { t: 'voice-peers', serverId: v.serverId, channelId: v.channelId, peers });
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token') || '';
  let p;
  try { p = jwt.verify(token, JWT_SECRET); } catch { ws.close(4401, 'bad token'); return; }
  const u = db.prepare('SELECT id, username, display_name, avatar_color FROM users WHERE id = ?').get(p.sub);
  if (!u) { ws.close(4401, 'no user'); return; }
  const memberRows = db.prepare('SELECT server_id FROM server_members WHERE user_id = ?').all(u.id);
  ws.meta = {
    userId: u.id, username: u.username, display_name: u.display_name, avatar_color: u.avatar_color,
    servers: new Set(memberRows.map((r) => r.server_id)),
    voice: null,
  };
  clients.add(ws);
  safeSend(ws, { t: 'hello', user: publicUser(u) });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const me = ws.meta;
    if (!me) return;

    if (msg.t === 'subscribe') {
      // refresh memberships
      const rows = db.prepare('SELECT server_id FROM server_members WHERE user_id = ?').all(me.userId);
      me.servers = new Set(rows.map((r) => r.server_id));
      // send presence roster per server
      for (const sid of me.servers) {
        const online = [...clients].filter((c) => c.meta && c.meta.servers.has(sid)).map((c) => c.meta.userId);
        safeSend(ws, { t: 'presence', serverId: sid, online });
      }
      // announce online to others
      for (const sid of me.servers) broadcastToServer(sid, { t: 'user-online', serverId: sid, userId: me.userId }, ws);
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
      if (!content || !serverId || !channelId) return;
      if (!me.servers.has(serverId) || !isMember(serverId, me.userId)) return;
      const ch = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(channelId, serverId);
      if (!ch || ch.type !== 'text') return;
      if (!rateOk(me.userId)) { safeSend(ws, { t: 'error', error: 'slow_down' }); return; }
      const m = { id: uid(), server_id: serverId, channel_id: channelId, user_id: me.userId, content, created_at: now() };
      db.prepare('INSERT INTO messages (id,server_id,channel_id,user_id,content,created_at) VALUES (@id,@server_id,@channel_id,@user_id,@content,@created_at)').run(m);
      broadcastToServer(serverId, {
        t: 'message-new', serverId, channelId,
        message: { id: m.id, serverId, channelId, content, created_at: m.created_at, user: publicUser({ id: me.userId, username: me.username, display_name: me.display_name, avatar_color: me.avatar_color }) },
      });
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
        peer: { id: me.userId, username: me.username, display_name: me.display_name, avatar_color: me.avatar_color, muted: false },
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
      broadcastToServer(me.voice.serverId, {
        t: 'voice-state', serverId: me.voice.serverId, channelId: me.voice.channelId,
        userId: me.userId, muted: me.voice.muted,
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
