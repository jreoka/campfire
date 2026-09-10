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
const { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } = require('@simplewebauthn/server');
const db = require('./db');
const storage = require('./storage');

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

// One-time flatten: threads are 1 level deep — re-parent any reply-of-a-reply
// onto the ultimate root. Idempotent (matches 0 rows when clean), so it runs
// on every boot and also repairs databases written by older clients.
try {
  // Replies whose root was deleted before root-delete cascaded are unreachable
  // (history hides non-roots, thread fetch 404s without the root) — drop them.
  const orphans = db.prepare(`SELECT id FROM messages WHERE thread_root_id IS NOT NULL
    AND thread_root_id NOT IN (SELECT id FROM messages)`).all().map((r) => r.id);
  if (orphans.length) {
    const ph = orphans.map(() => '?').join(',');
    try { db.prepare(`DELETE FROM message_pins WHERE message_id IN (${ph})`).run(...orphans); } catch {}
    db.prepare(`DELETE FROM messages WHERE id IN (${ph})`).run(...orphans);
    console.log(`[campfire] removed ${orphans.length} orphaned thread ${orphans.length === 1 ? 'reply' : 'replies'}`);
  }
  let moved = 0;
  for (let i = 0; i < 10; i++) {
    const r = db.prepare(`UPDATE messages SET thread_root_id =
      (SELECT p.thread_root_id FROM messages p WHERE p.id = messages.thread_root_id)
      WHERE thread_root_id IN (SELECT id FROM messages WHERE thread_root_id IS NOT NULL)`).run();
    if (!r.changes) break;
    moved += r.changes;
  }
  if (moved) console.log(`[campfire] flattened ${moved} nested thread ${moved === 1 ? 'reply' : 'replies'} to 1 level`);
} catch {}

// ---------- uploads ----------
// Uploads live next to the database (persistent volume), never next to the code
// (container image layers are ephemeral and wiped on every rebuild).
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(db.DB_PATH), 'uploads');
const MAX_FILE_BYTES = parseInt(process.env.MAX_FILE_MB || '100', 10) * 1024 * 1024;
const MAX_IMG_BYTES = 8 * 1024 * 1024;
const IMG_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
// General chat uploads accept ANY file type (images, audio incl. flac, video,
// docs, archives, executables, ...). Only avatar/emoji/banner/icon uploaders
// stay image-only. Served files default to Content-Disposition: attachment
// except common inline-playable image/audio/video extensions (see the
// /uploads static handlers below), so exotic types download safely instead
// of rendering in-browser.
// CODE_TEXT_EXTS: used to label extension-sent code/text with an empty or
// generic MIME type as text/plain (see /api/upload below).
const CODE_TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'json', 'py', 'pyw', 'rb', 'java', 'c', 'h', 'hpp', 'cpp', 'cc', 'cs', 'go', 'rs', 'php', 'swift', 'kt', 'kts', 'scala', 'sh', 'bash', 'zsh', 'sql', 'html', 'htm', 'css', 'scss', 'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'csv', 'tsv', 'log', 'diff', 'patch', 'vue', 'svelte', 'lua', 'dart']);
const EXT_BY_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/webm': '.webm', 'audio/mp4': '.m4a', 'application/pdf': '.pdf', 'text/plain': '.txt', 'text/markdown': '.md', 'application/zip': '.zip' };
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// Extension for a stored upload: known MIME map first, then the original
// extension when it's filesystem-safe (any alnum ext, so arbitrary file
// types keep their type), else .bin.
function extForUpload(file) {
  if (EXT_BY_MIME[file.mimetype]) return EXT_BY_MIME[file.mimetype];
  const e = path.extname(String(file.originalname || '')).toLowerCase().slice(1);
  return /^[a-z0-9]{1,10}$/.test(e) ? '.' + e : '.bin';
}
function uploader(sub, mimes, maxBytes, allowCodeExt = false) {
  // S3 mode buffers in memory and uploads to the bucket in persistUpload()
  // (same filename scheme, same URL shape); otherwise files land on disk.
  const store = storage.s3Enabled()
    ? multer.memoryStorage()
    : multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(UPLOAD_DIR, sub);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + extForUpload(file)),
    });
  const mw = multer({
    storage: store,
    limits: { fileSize: maxBytes, files: 1 },
    fileFilter: (req, file, cb) => {
      if (!mimes) return cb(null, true); // general uploader: any file type
      if (mimes.includes(file.mimetype)) return cb(null, true);
      if (allowCodeExt && CODE_TEXT_EXTS.has(path.extname(String(file.originalname || '')).toLowerCase().slice(1))) return cb(null, true);
      cb(null, false);
    },
  });
  mw._sub = sub;
  return mw;
}
// After multer: in S3 mode push the buffer to the bucket and assign the
// filename multer would have used on disk. Local mode is already on disk.
async function persistUpload(sub, file) {
  if (!file || !storage.s3Enabled()) return;
  const filename = crypto.randomBytes(16).toString('hex') + extForUpload(file);
  await storage.s3Put(`${sub}/${filename}`, file.buffer, file.mimetype);
  file.filename = filename;
}
const upFile = uploader('files', null, MAX_FILE_BYTES, true);
const upImg = uploader('avatars', IMG_MIMES, MAX_IMG_BYTES);
const upBanner = uploader('banners', IMG_MIMES, MAX_IMG_BYTES);
const upSidebar = uploader('sidebar', IMG_MIMES, MAX_IMG_BYTES);
const upIcon = uploader('icons', IMG_MIMES, MAX_IMG_BYTES);
const upEmoji = uploader('emoji', IMG_MIMES, 4 * 1024 * 1024);
function uploadUrl(sub, file) { return `/uploads/${sub}/${file.filename}?v=${Date.now().toString(36)}`; }
function deleteUploaded(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  const clean = String(url).split('?')[0];
  if (storage.s3Enabled()) {
    const key = storage.s3KeyFromUrl(clean);
    if (key) storage.s3Delete(key);
  }
  // Always attempt the local unlink too: harmless when absent, and covers
  // files still on disk from before an S3 migration.
  const p = path.join(UPLOAD_DIR, clean.slice('/uploads/'.length));
  if (path.resolve(p).startsWith(path.resolve(UPLOAD_DIR))) fs.unlink(p, () => {});
}

if (storage.s3Enabled()) console.log('[campfire] media storage: S3 bucket ' + (process.env.S3_BUCKET || ''));
else console.log('[campfire] media storage: local disk ' + UPLOAD_DIR);

const app = express();
app.set('trust proxy', 1);
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
    // The shell carries per-deploy asset pins: never let it go stale.
    res.setHeader('Cache-Control', 'no-store');
    res.send(html.replace(/(src|href)="(\/(?:js\/[a-z0-9_-]+\.js|embeds\.js|styles\.css))"/g, `$1="$2?v=${APP_VERSION}"`));
  });
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/uploads', express.static(UPLOAD_DIR, {
  dotfiles: 'deny', index: false, maxAge: '7d',
  setHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!/\.(png|jpe?g|gif|webp|avif|mp4|m4v|mov|webm|mp3|m4a|ogg|oga|opus|wav|flac)$/i.test(filePath)) {
      res.setHeader('Content-Disposition', 'attachment');
    }
  },
}));
// S3 mode: serve bucket objects at the same /uploads/* paths. Local static
// above still wins for any file left on disk; misses fall through here.
if (storage.s3Enabled()) {
  app.use('/uploads', async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const key = storage.s3KeyFromUrl('/uploads' + req.path);
    if (!key) return next();
    let data;
    try {
      const range = req.headers.range && /^bytes=\d*-\d*$/.test(req.headers.range) ? req.headers.range : undefined;
      data = await storage.s3Get(key, range);
    } catch (err) {
      const code = err?.$metadata?.httpStatusCode;
      if (code === 404 || code === 403 || err?.name === 'NoSuchKey') return next();
      if (code === 416) return res.status(416).end();
      return res.status(502).json({ error: 'storage_failed' });
    }
    try {
      res.setHeader('Content-Type', data.ContentType || storage.mimeForFilename(key));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'public, max-age=604800');
      res.setHeader('Accept-Ranges', 'bytes');
      if (data.ETag) res.setHeader('ETag', data.ETag);
      if (data.LastModified) res.setHeader('Last-Modified', data.LastModified.toUTCString());
      if (!/\.(png|jpe?g|gif|webp|avif|mp4|m4v|mov|webm|mp3|m4a|ogg|oga|opus|wav|flac)$/i.test(key)) {
        res.setHeader('Content-Disposition', 'attachment');
      }
      if (data.$metadata?.httpStatusCode === 206 && data.ContentRange) {
        res.status(206);
        res.setHeader('Content-Range', data.ContentRange);
      }
      if (data.ContentLength !== undefined) res.setHeader('Content-Length', data.ContentLength);
      if (req.method === 'HEAD' || !data.Body) return res.end();
      data.Body.on('error', () => { try { res.destroy(); } catch {} });
      data.Body.pipe(res);
    } catch { try { res.destroy(); } catch {} }
  });
}
// Missing uploads must 404 (never fall through to the SPA shell — an HTML page
// served as an image breaks <img> rendering in confusing ways).
app.use('/uploads', (req, res) => res.status(404).json({ error: 'not_found' }));

// ---------- helpers ----------
const uid = () => crypto.randomUUID();
const now = () => Date.now();
const COLORS = ['#5865f2', '#3ba55d', '#ed4245', '#faa81a', '#9b59b6', '#1abc9c', '#e91e63', '#00b0f4'];
// Deterministic per-account fallback color (no custom picker): same hash as
// the client's avatarColorFor(), keyed on the stable account id.
const colorForId = (id) => {
  const s = String(id || '');
  if (!s) return COLORS[0];
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return COLORS[(h >>> 0) % COLORS.length];
};
const pickColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];
// Server tags: short (max 4 chars) labels guild admins can offer; members may
// show one after their name everywhere. Whitespace is stripped; '' clears.
function cleanTag(t) {
  return Array.from(String(t ?? '').replace(/\s/g, '')).slice(0, 4).join('');
}
// Tag emoji: one standard unicode emoji (first grapheme, must be pictographic).
// Custom :shortcode: emoji and plain text are rejected ('' = none).
function cleanTagEmoji(t) {
  const s = String(t ?? '').replace(/\s/g, '');
  if (!s) return '';
  let g = '';
  try {
    const it = new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)[Symbol.iterator]();
    const first = it.next();
    g = first.done ? '' : first.value.segment;
  } catch { g = Array.from(s)[0] || ''; }
  return g && /\p{Extended_Pictographic}/u.test(g) ? g : '';
}
// Push a user's fresh profile to every connected client that can see them.
function clearTagSelection(userId, serverId) {
  db.prepare('UPDATE users SET active_tag_server_id = NULL, active_tag = NULL WHERE id = ? AND active_tag_server_id = ?').run(userId, serverId);
}

function makeInvite() {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
}
function sessionDeviceName(req) {
  const d = String(req.body?.device || '').trim().slice(0, 32);
  if (d) return d;
  const ua = String(req.get('user-agent') || '');
  if (/mobile|android|iphone|ipad/i.test(ua)) return 'Phone';
  if (/macintosh/i.test(ua)) return 'Mac';
  if (/windows/i.test(ua)) return 'Windows';
  if (/linux/i.test(ua)) return 'Linux';
  return '';
}
function newSession(userId, req, name) {
  const sid = uid();
  db.prepare('INSERT INTO sessions (id,user_id,name,ip,user_agent,created_at,last_seen,revoked) VALUES (?,?,?,?,?,?,?,0)')
    .run(sid, userId, String(name ?? sessionDeviceName(req)).slice(0, 32), String(req.ip || '').slice(0, 64), String(req.get('user-agent') || '').slice(0, 300), now(), now());
  return sid;
}
function signSession(user, sid) {
  return jwt.sign({ sub: user.id, u: user.username, sid }, JWT_SECRET, { expiresIn: '30d' });
}
const sessTouch = new Map(); // sid -> last last_seen write (throttles per-request DB writes)
function touchSession(sid) {
  const t = now();
  if (t - (sessTouch.get(sid) || 0) < 5 * 60e3) return;
  sessTouch.set(sid, t);
  try { db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(t, sid); } catch {}
}
// TOTP (RFC 6238, SHA-1, 30s, 6 digits) — dependency-free.
const B32ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) {
  let out = '', bits = 0, val = 0;
  for (const byte of buf) { val = (val << 8) | byte; bits += 8; while (bits >= 5) { out += B32ABC[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32ABC[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(s) {
  const clean = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  const bytes = [];
  let bits = 0, val = 0;
  for (const ch of clean) { val = (val << 5) | B32ABC.indexOf(ch); bits += 5; if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(bytes);
}
function totpAt(secretB32, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1000000)).padStart(6, '0');
}
function verifyTotp(secretB32, code) {
  const c = String(code || '').replace(/\D/g, '');
  if (!/^[0-9]{6}$/.test(c) || !secretB32) return false;
  const ctr = Math.floor(now() / 30000);
  return c === totpAt(secretB32, ctr - 1) || c === totpAt(secretB32, ctr) || c === totpAt(secretB32, ctr + 1);
}
function newBackupCodes() {
  const codes = [];
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < 10; i++) {
    let c = '';
    const r = crypto.randomBytes(8);
    for (const b of r) c += abc[b % abc.length];
    codes.push(c);
  }
  const hashes = codes.map((c) => crypto.createHash('sha256').update(c).digest('hex'));
  return { codes, hashes };
}
const twofaFails = new Map(); // userId -> {n, until} — brute-force brake for 2FA codes
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
    if (user.disabled) return res.status(403).json({ error: 'account_disabled' });
    // 2s grace: JWT iat is second-precision while token_valid_after is ms —
    // without it a token minted in the same second as a reset looks older.
    // Precise kills come from the sessions-table revocation below.
    if ((p.iat || 0) * 1000 < (user.token_valid_after || 0) - 2000) return res.status(401).json({ error: 'bad_token' });
    if (p.sid) {
      const s = db.prepare('SELECT id,user_id,revoked FROM sessions WHERE id = ?').get(p.sid);
      if (!s || s.user_id !== user.id || s.revoked) return res.status(401).json({ error: 'bad_token' });
      touchSession(p.sid);
    }
    req.user = user;
    req.sessionId = p.sid || null;
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
           u.status, u.status_text, u.status_expires_at, u.playing_game, u.streaming_game, u.bio, u.name_color, u.name_gradient,
           u.created_at, u.is_admin, u.active_tag, u.active_tag_server_id,
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
// Custom-status expiry: timestamps are ms epochs (null/0 = never). Reads mask
// already-expired text instantly; the periodic sweep below scrubs the DB
// and broadcasts the change so every client re-renders.
function statusExpiryRaw(u) {
  const ts = Math.floor(Number(u && u.status_expires_at));
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}
function statusExpiryVisible(u) {
  const ts = statusExpiryRaw(u);
  return ts && ts > Date.now() ? ts : null;
}
function statusTextVisible(u) {
  if (!u || !u.status_text) return '';
  const ts = statusExpiryRaw(u);
  return ts && ts <= Date.now() ? '' : u.status_text;
}
// Presence revert timer: ms epoch while a timed away/dnd/invisible is pending
// (null once lapsed or never set). Clients show a countdown from this.
function presenceExpiryVisible(u) {
  const ts = Math.floor(Number(u && u.presence_expires_at));
  return Number.isFinite(ts) && ts > Date.now() ? ts : null;
}
function sweepExpiredStatuses() {
  const t = now();
  let ids = [];
  try { ids = db.prepare('SELECT id FROM users WHERE status_expires_at IS NOT NULL AND status_expires_at <= ?').all(t).map((r) => r.id); } catch {}
  if (ids.length) {
    try { db.prepare('UPDATE users SET status_text = ?, status_expires_at = NULL WHERE status_expires_at IS NOT NULL AND status_expires_at <= ?').run('', t); } catch {}
    for (const id of ids) { try { broadcastUserUpdate(freshUser(id)); } catch {} }
  }
  // Timed away/dnd/invisible lapses back to online (drives dots everywhere).
  let pids = [];
  try { pids = db.prepare('SELECT id FROM users WHERE presence_expires_at IS NOT NULL AND presence_expires_at <= ?').all(t).map((r) => r.id); } catch {}
  if (!pids.length) return;
  try { db.prepare("UPDATE users SET status = 'online', presence_expires_at = NULL WHERE presence_expires_at IS NOT NULL AND presence_expires_at <= ?").run(t); } catch {}
  for (const id of pids) {
    try {
      const u = freshUser(id);
      broadcastUserUpdate(u);
      for (const sid of [...clients].filter((c) => c.meta && c.meta.userId === id).flatMap((c) => [...c.meta.servers])) {
        broadcastToServer(sid, { t: 'user-status', serverId: sid, userId: id, status: 'online' });
      }
      for (const c of clients) if (c.meta && c.meta.userId === id) c.meta.status = 'online';
    } catch {}
  }
}
function publicUser(u) {
  if (!u) return { id: null, username: 'deleted', display_name: 'deleted user', avatar_color: '#555' };
  return {
    id: u.id, username: u.username, display_name: u.display_name, avatar_color: u.avatar_color || '#5865f2',
    avatar_url: u.avatar_url || null, banner_url: u.banner_url || null,
    sidebar_banner_url: u.sidebar_banner_url || null,
    status: u.status || 'online', status_text: statusTextVisible(u), status_expires_at: statusExpiryVisible(u), presence_expires_at: presenceExpiryVisible(u), playing_game: u.playing_game || null, streaming_game: u.streaming_game || null, bio: u.bio || '',
    name_color: u.name_color || '', name_gradient: u.name_gradient || '',
    active_tag: u.active_tag || null, active_tag_server_id: u.active_tag_server_id || null,
    created_at: u.created_at || null,
    game_enabled: u.game_enabled === undefined ? 1 : u.game_enabled,
    nsfw_ok: !!u.nsfw_ok,
    game_exclusions: u.game_exclusions || '[]',
    // '' = never set: clients resolve it to 'dark' locally. Stored (not just
    // localStorage) so the theme follows the account cross-device.
    theme: ['dark', 'light', 'dracula', 'oled'].includes(u.theme) ? u.theme : '',
    is_admin: !!u.is_admin,
    disabled: !!u.disabled,
  };
}
function requireSiteAdmin(req, res, next) {
  if (!req.user.is_admin) return res.status(403).json({ error: 'admin_only' });
  next();
}
const USER_COLS = 'id, username, display_name, avatar_color, avatar_url, banner_url, sidebar_banner_url, status, status_text, status_expires_at, presence_expires_at, playing_game, streaming_game, bio, name_color, name_gradient, active_tag_server_id, active_tag, token_valid_after, totp_enabled, created_at, game_enabled, game_exclusions, is_admin, disabled, tz_offset, nsfw_ok, theme';

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
    // Log the Cloudflare reason (timeout-or-duplicate, invalid-input-secret,
    // hostname-mismatch, ...) — without it every failure is an undiagnosable
    // "captcha_failed" and users just see an ever-resetting widget.
    if (j.success !== true) console.warn('[auth] turnstile reject:', ((j['error-codes'] || []).join(',') || 'unknown'), 'ip=', ip || '?');
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
  const newId = uid();
  const user = { id: newId, username, display_name: displayName || username, password_hash: hash, avatar_color: colorForId(newId), created_at: now() };
  db.prepare('INSERT INTO users (id, username, display_name, password_hash, avatar_color, created_at) VALUES (@id,@username,@display_name,@password_hash,@avatar_color,@created_at)').run(user);
  // Site owner is always an admin (also enforced by a boot-time UPDATE in db.js
  // for pre-existing databases).
  if (username === 'jreoka') db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
  const sid = newSession(user.id, req);
  const token = signSession(user, sid);
  res.cookie('cf_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
  res.json({ token, sid, user: publicUser({ id: user.id, username, display_name: user.display_name, avatar_color: user.avatar_color }) });
});

app.post('/api/login', async (req, res) => {
  const tsToken = req.body?.turnstile;
  if (!(await verifyTurnstile(tsToken, req.ip))) return res.status(403).json({ error: tsToken ? 'captcha_failed' : 'captcha_required' });
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim().toLowerCase());
  if (!u) return res.status(401).json({ error: 'invalid_login' });
  if (u.disabled) return res.status(403).json({ error: 'account_disabled' });
  const ok = await bcrypt.compare(String(password || ''), u.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid_login' });
  if (u.totp_enabled) {
    const tmp = jwt.sign({ sub: u.id, purpose: '2fa-pre' }, JWT_SECRET, { expiresIn: '5m' });
    return res.json({ need2fa: true, tmp });
  }
  const sid = newSession(u.id, req);
  const token = signSession(u, sid);
  res.cookie('cf_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
  res.json({ token, sid, user: publicUser(u) });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('cf_token');
  res.json({ ok: true });
});

// ---------- sessions ----------
function closeSessionSockets(userId, sid) {
  for (const c of clients) {
    if (c.meta && c.meta.userId === userId && (!sid || c.meta.sid === sid)) { try { c.close(4401, 'session revoked'); } catch {} }
  }
}
app.get('/api/sessions', authRequired, (req, res) => {
  const rows = db.prepare('SELECT id,name,ip,user_agent,created_at,last_seen FROM sessions WHERE user_id = ? AND revoked = 0 ORDER BY last_seen DESC').all(req.user.id);
  res.json({ sessions: rows.map((s) => ({ ...s, current: s.id === req.sessionId })) });
});
app.patch('/api/sessions/:id', authRequired, (req, res) => {
  const s = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!s || s.revoked) return res.status(404).json({ error: 'no_session' });
  const name = String(req.body?.name ?? '').trim().slice(0, 32);
  db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, s.id);
  res.json({ ok: true });
});
app.delete('/api/sessions/others', authRequired, (req, res) => {
  const rows = db.prepare('SELECT id FROM sessions WHERE user_id = ? AND revoked = 0').all(req.user.id);
  for (const r of rows) {
    if (r.id === req.sessionId) continue;
    db.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').run(r.id);
    closeSessionSockets(req.user.id, r.id);
  }
  res.json({ ok: true });
});
app.delete('/api/sessions/current', authRequired, (req, res) => {
  if (req.sessionId) { db.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').run(req.sessionId); closeSessionSockets(req.user.id, req.sessionId); }
  res.clearCookie('cf_token');
  res.json({ ok: true });
});
app.delete('/api/sessions/:id', authRequired, (req, res) => {
  const s = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!s) return res.status(404).json({ error: 'no_session' });
  db.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').run(s.id);
  closeSessionSockets(req.user.id, s.id);
  res.json({ ok: true, current: s.id === req.sessionId });
});

// ---------- two-factor (TOTP + backup codes) ----------
app.get('/api/2fa/status', authRequired, (req, res) => {
  res.json({ enabled: !!req.user.totp_enabled });
});
app.post('/api/2fa/setup', authRequired, (req, res) => {
  if (req.user.totp_enabled) return res.status(400).json({ error: 'already_enabled' });
  const secret = b32encode(crypto.randomBytes(20));
  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, req.user.id);
  res.json({ secret, otpauth_url: `otpauth://totp/Campfire:${encodeURIComponent(req.user.username)}?secret=${secret}&issuer=Campfire` });
});
app.post('/api/2fa/enable', authRequired, (req, res) => {
  const u = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (!u || u.totp_enabled) return res.status(400).json({ error: 'bad_state' });
  if (!u.totp_secret || !verifyTotp(u.totp_secret, req.body?.code)) return res.status(400).json({ error: 'bad_code' });
  const { codes, hashes } = newBackupCodes();
  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(req.user.id);
  db.prepare('DELETE FROM totp_backups WHERE user_id = ?').run(req.user.id);
  const ins = db.prepare('INSERT INTO totp_backups (user_id, code_hash, created_at) VALUES (?,?,?)');
  for (const h of hashes) ins.run(req.user.id, h, now());
  res.json({ ok: true, backupCodes: codes });
});
// A code may be a TOTP or an unused backup code (single-use).
function check2faCode(uid, secret, code) {
  const c = String(code || '').trim().toUpperCase().replace(/[\s-]/g, '');
  if (!c) return false;
  const f = twofaFails.get(uid);
  if (f && f.until > now()) return false;
  const fail = () => {
    const e = twofaFails.get(uid) || { n: 0, until: 0 };
    e.n += 1;
    if (e.n >= 10) { e.until = now() + 60e3; e.n = 0; }
    twofaFails.set(uid, e);
  };
  if (secret && verifyTotp(secret, c)) { twofaFails.delete(uid); return true; }
  const h = crypto.createHash('sha256').update(c).digest('hex');
  const row = db.prepare('SELECT code_hash FROM totp_backups WHERE user_id = ? AND code_hash = ?').get(uid, h);
  if (row) { db.prepare('DELETE FROM totp_backups WHERE user_id = ? AND code_hash = ?').run(uid, h); twofaFails.delete(uid); return true; }
  fail();
  return false;
}
app.post('/api/2fa/disable', authRequired, (req, res) => {
  const u = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (!u || !u.totp_enabled || !check2faCode(req.user.id, u.totp_secret, req.body?.code)) return res.status(400).json({ error: 'bad_code' });
  db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?').run(req.user.id);
  db.prepare('DELETE FROM totp_backups WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});
app.post('/api/2fa/backup-codes/regenerate', authRequired, (req, res) => {
  const u = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (!u || !u.totp_enabled || !check2faCode(req.user.id, u.totp_secret, req.body?.code)) return res.status(400).json({ error: 'bad_code' });
  const { codes, hashes } = newBackupCodes();
  db.prepare('DELETE FROM totp_backups WHERE user_id = ?').run(req.user.id);
  const ins = db.prepare('INSERT INTO totp_backups (user_id, code_hash, created_at) VALUES (?,?,?)');
  for (const h of hashes) ins.run(req.user.id, h, now());
  res.json({ ok: true, backupCodes: codes });
});
app.post('/api/login/2fa', async (req, res) => {
  let p;
  try { p = jwt.verify(String(req.body?.tmp || ''), JWT_SECRET); } catch { return res.status(401).json({ error: 'bad_token' }); }
  if (!p || p.purpose !== '2fa-pre') return res.status(401).json({ error: 'bad_token' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(p.sub);
  if (!u) return res.status(401).json({ error: 'invalid_login' });
  if (u.disabled) return res.status(403).json({ error: 'account_disabled' });
  if (!u.totp_enabled) return res.status(400).json({ error: 'not_enabled' });
  if (!check2faCode(u.id, u.totp_secret, req.body?.code)) {
    const f = twofaFails.get(u.id);
    if (f && f.until > now()) return res.status(429).json({ error: 'slow_down' });
    return res.status(401).json({ error: 'bad_code' });
  }
  const sid = newSession(u.id, req);
  const token = signSession(u, sid);
  res.cookie('cf_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
  res.json({ token, sid, user: publicUser(u) });
});

// ---------- passkeys (WebAuthn) ----------
const wac = new Map(); // stateId -> {type:'reg'|'auth', userId?, challenge, expires}
setInterval(() => { const t = now(); for (const [k, v] of wac) if (v.expires < t) wac.delete(k); }, 60e3);
function webauthnRp(req) { return req.hostname; }
function webauthnOrigin(req) { return `${req.protocol}://${req.get('host')}`; }
app.post('/api/passkeys/register/options', authRequired, async (req, res) => {
  try {
    const existing = db.prepare('SELECT credential_id FROM passkeys WHERE user_id = ?').all(req.user.id);
    const options = await generateRegistrationOptions({
      rpName: 'Campfire', rpID: webauthnRp(req),
      userID: Buffer.from(req.user.id),
      userName: req.user.username, userDisplayName: req.user.display_name || req.user.username,
      attestationType: 'none',
      excludeCredentials: existing.map((r) => ({ id: r.credential_id })),
    });
    const stateId = uid();
    wac.set(stateId, { type: 'reg', userId: req.user.id, challenge: options.challenge, expires: now() + 5 * 60e3 });
    res.json({ stateId, options });
  } catch { res.status(500).json({ error: 'webauthn_failed' }); }
});
app.post('/api/passkeys/register/verify', authRequired, async (req, res) => {
  try {
    const sid0 = String(req.body?.stateId || '');
    const st = wac.get(sid0);
    if (!st || st.type !== 'reg' || st.userId !== req.user.id) return res.status(400).json({ error: 'bad_state' });
    wac.delete(sid0);
    const v = await verifyRegistrationResponse({
      response: req.body?.attResp, expectedChallenge: st.challenge,
      expectedOrigin: webauthnOrigin(req), expectedRPID: webauthnRp(req),
    });
    if (!v.verified || !v.registrationInfo) return res.status(400).json({ error: 'verify_failed' });
    const { credential } = v.registrationInfo;
    const name = String(req.body?.name || 'Passkey').trim().slice(0, 32) || 'Passkey';
    const id = uid();
    db.prepare('INSERT INTO passkeys (id,user_id,name,credential_id,public_key,counter,transports,created_at,last_used) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, req.user.id, name, credential.id, Buffer.from(credential.publicKey).toString('base64'), credential.counter || 0, JSON.stringify(req.body?.attResp?.response?.transports || []), now(), 0);
    res.json({ ok: true, passkey: { id, name } });
  } catch (err) {
    if (String(err?.code || '').includes('UNIQUE') || String(err?.message || '').includes('UNIQUE')) return res.status(409).json({ error: 'already_added' });
    res.status(400).json({ error: 'verify_failed' });
  }
});
app.get('/api/passkeys', authRequired, (req, res) => {
  const rows = db.prepare('SELECT id,name,credential_id,created_at,last_used FROM passkeys WHERE user_id = ? ORDER BY created_at ASC').all(req.user.id);
  res.json({ passkeys: rows });
});
app.patch('/api/passkeys/:id', authRequired, (req, res) => {
  const r = db.prepare('SELECT * FROM passkeys WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!r) return res.status(404).json({ error: 'no_passkey' });
  const name = String(req.body?.name ?? '').trim().slice(0, 32) || 'Passkey';
  db.prepare('UPDATE passkeys SET name = ? WHERE id = ?').run(name, r.id);
  res.json({ ok: true });
});
app.delete('/api/passkeys/:id', authRequired, (req, res) => {
  db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});
app.post('/api/passkeys/login/options', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim().toLowerCase();
    let allow = [], userId = null;
    if (username) {
      const u = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (!u) return res.status(404).json({ error: 'user_not_found' });
      userId = u.id;
      allow = db.prepare('SELECT credential_id FROM passkeys WHERE user_id = ?').all(u.id).map((r) => ({ id: r.credential_id }));
      if (!allow.length) return res.status(404).json({ error: 'no_passkeys' });
    }
    const options = await generateAuthenticationOptions({ rpID: webauthnRp(req), allowCredentials: allow.length ? allow : undefined, userVerification: 'preferred' });
    const stateId = uid();
    wac.set(stateId, { type: 'auth', userId, challenge: options.challenge, expires: now() + 5 * 60e3 });
    res.json({ stateId, options });
  } catch { res.status(500).json({ error: 'webauthn_failed' }); }
});
app.post('/api/passkeys/login/verify', async (req, res) => {
  try {
    const sid0 = String(req.body?.stateId || '');
    const st = wac.get(sid0);
    if (!st || st.type !== 'auth') return res.status(400).json({ error: 'bad_state' });
    wac.delete(sid0);
    const authResp = req.body?.authResp;
    const credId = String(authResp?.id || '');
    if (!credId) return res.status(400).json({ error: 'verify_failed' });
    const row = db.prepare('SELECT * FROM passkeys WHERE credential_id = ?').get(credId);
    if (!row || (st.userId && row.user_id !== st.userId)) return res.status(400).json({ error: 'verify_failed' });
    const uh = authResp?.response?.userHandle;
    if (uh && Buffer.from(uh, 'base64url').toString() !== row.user_id) return res.status(400).json({ error: 'verify_failed' });
    const v = await verifyAuthenticationResponse({
      response: authResp, expectedChallenge: st.challenge,
      expectedOrigin: webauthnOrigin(req), expectedRPID: webauthnRp(req),
      credential: { id: row.credential_id, publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64')), counter: row.counter, transports: JSON.parse(row.transports || '[]') },
    });
    if (!v.verified) return res.status(401).json({ error: 'verify_failed' });
    db.prepare('UPDATE passkeys SET counter = ?, last_used = ? WHERE id = ?').run(v.authenticationInfo.newCounter, now(), row.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!u) return res.status(401).json({ error: 'invalid_login' });
    if (u.disabled) return res.status(403).json({ error: 'account_disabled' });
    const sid = newSession(u.id, req);
    const token = signSession(u, sid);
    res.cookie('cf_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
    res.json({ token, sid, user: publicUser(u) });
  } catch { res.status(400).json({ error: 'verify_failed' }); }
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
  const s = { id: uid(), name, owner_id: req.user.id, created_at: now() };
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO servers (id,name,owner_id,created_at) VALUES (@id,@name,@owner_id,@created_at)').run(s);
    const maxP = db.prepare('SELECT COALESCE(MAX(position),-1) m FROM server_members WHERE user_id = ?').get(req.user.id).m;
    db.prepare('INSERT INTO server_members (server_id,user_id,joined_at,position) VALUES (?,?,?,?)').run(s.id, req.user.id, now(), maxP + 1);
    const mk = (n, type, pos) => db.prepare("INSERT INTO channels (id,server_id,name,type,position,created_by,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(uid(), s.id, n, type, pos, req.user.id, now());
    mk('general', 'text', 0);
    mk('Lobby', 'voice', 0);
  });
  tx();
  // Every server starts with one revocable starter link so there is
  // something to share right away (it lives in the managed list like any
  // other link — there is no permanent code anymore).
  const firstCode = mintInviteCode();
  let first = null;
  if (firstCode) {
    first = { id: uid(), server_id: s.id, code: firstCode, label: 'Server invite', created_by: req.user.id, created_at: now(), expires_at: null, max_uses: null, uses: 0 };
    db.prepare('INSERT INTO server_invites (id,server_id,code,label,created_by,created_at,expires_at,max_uses,uses) VALUES (@id,@server_id,@code,@label,@created_by,@created_at,@expires_at,@max_uses,@uses)').run(first);
    first = invitePublic(first);
  }
  res.json({ server: serverView(s.id), invite: first });
});

// ---------- server invite links ----------
// All invites are named rows in server_invites with optional use limits /
// expiry. There is no permanent per-server code; revoked/expired links die.
function invitePublic(inv) {
  const t = now();
  return {
    id: inv.id, code: inv.code, label: inv.label || '',
    created_by: inv.created_by || null, created_at: inv.created_at,
    expires_at: inv.expires_at ?? null, max_uses: inv.max_uses ?? null, uses: inv.uses || 0,
    expired: !!(inv.expires_at && inv.expires_at <= t),
    exhausted: !!(inv.max_uses && (inv.uses || 0) >= inv.max_uses),
  };
}
function resolveInvite(code) {
  code = String(code || '').trim();
  if (!code) return null;
  const inv = db.prepare('SELECT * FROM server_invites WHERE code = ?').get(code);
  if (!inv) return null;
  return { invite: inv, server: getServer(inv.server_id) };
}
function mintInviteCode() {
  for (let i = 0; i < 12; i++) {
    const c = makeInvite();
    if (!db.prepare('SELECT 1 FROM server_invites WHERE code = ?').get(c)) return c;
  }
  return null;
}
app.get('/api/invite/:code', (req, res) => {
  const hit = resolveInvite(req.params.code);
  if (!hit || !hit.server) return res.status(404).json({ error: 'bad_invite' });
  const pub = invitePublic(hit.invite);
  if (pub.expired) return res.status(410).json({ error: 'invite_expired' });
  if (pub.exhausted) return res.status(410).json({ error: 'invite_exhausted' });
  const s = hit.server;
  const memberCount = db.prepare('SELECT COUNT(*) c FROM server_members WHERE server_id = ?').get(s.id).c;
  res.json({ name: s.name, description: s.description || '', banner_url: s.banner_url || null, icon_url: s.icon_url || null, memberCount });
});
app.post('/api/servers/join', authRequired, (req, res) => {
  const code = String(req.body?.inviteCode || req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'code_required' });
  const hit = resolveInvite(code);
  if (!hit || !hit.server) return res.status(404).json({ error: 'bad_invite' });
  const s = hit.server;
  if (isBanned(s.id, req.user.id)) return res.status(403).json({ error: 'banned' });
  if (!isMember(s.id, req.user.id)) {
    const pub = invitePublic(hit.invite);
    if (pub.expired) return res.status(410).json({ error: 'invite_expired' });
    if (pub.exhausted) return res.status(410).json({ error: 'invite_exhausted' });
    db.transaction(() => {
      const maxP = db.prepare('SELECT COALESCE(MAX(position),-1) m FROM server_members WHERE user_id = ?').get(req.user.id).m;
      db.prepare('INSERT INTO server_members (server_id,user_id,joined_at,position) VALUES (?,?,?,?)').run(s.id, req.user.id, now(), maxP + 1);
      db.prepare('UPDATE server_invites SET uses = uses + 1 WHERE id = ?').run(hit.invite.id);
    })();
    postServerSys(s.id, `${displayOf(req.user)} joined the server`);
    // Live roster for everyone already here (the joiner refetches via refreshServers).
    broadcastToServer(s.id, { t: 'server-updated', server: serverView(s.id) });
  }
  res.json({ server: serverView(s.id) });
});

app.get('/api/servers/:id', authRequired, (req, res) => {
  if (!isMember(req.params.id, req.user.id)) return res.status(403).json({ error: 'not_member' });
  res.json({ server: serverView(req.params.id) });
});
// Tag-card preview: tags are visible app-wide, so any logged-in user can
// resolve one to the server's banner, name, icon and description.
app.get('/api/servers/:id/preview', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  res.json({ server: { id: s.id, name: s.name, description: s.description || '', icon_url: s.icon_url || null, banner_url: s.banner_url || null, tag: s.tag || null, tag_emoji: s.tag_emoji || null } });
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

// Reorder channels within their type group (text / voice order separately).
app.put('/api/servers/:id/channels/order', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isAdmin(s.id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  const order = Array.isArray(req.body?.order) ? req.body.order.map(String) : null;
  if (!order || !order.length || order.length > 200) return res.status(400).json({ error: 'bad_order' });
  const rows = db.prepare('SELECT id, type FROM channels WHERE server_id = ?').all(s.id);
  const byId = new Map(rows.map((r) => [r.id, r.type]));
  if (new Set(order).size !== order.length || order.some((id) => !byId.has(id))) return res.status(400).json({ error: 'bad_order' });
  const seen = new Set(order);
  const grouped = { text: [], voice: [] };
  for (const id of order) grouped[byId.get(id)].push(id);
  for (const r of rows) if (!seen.has(r.id)) grouped[r.type].push(r.id);
  const upd = db.prepare('UPDATE channels SET position = ? WHERE id = ?');
  for (const t of ['text', 'voice']) grouped[t].forEach((id, i) => upd.run(i, id));
  broadcastToServer(s.id, { t: 'server-updated', server: serverView(s.id) });
  res.json({ ok: true });
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
    if (c.meta) c.meta.voice = null;
    syncStreaming(c);
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
  if (req.body?.nsfw !== undefined) {
    sets.push('nsfw = ?'); params.push(req.body.nsfw ? 1 : 0);
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
  clearTagSelection(req.user.id, s.id);
  try { const fu = freshUser(req.user.id); broadcastUserUpdate(fu); notifyUser(req.user.id, { t: 'user-updated', user: fu }); } catch {}
  postServerSys(s.id, `${displayOf(req.user)} left the server`);
  broadcastToServer(s.id, { t: 'member-left', serverId: s.id, userId: req.user.id });
  res.json({ ok: true });
});

app.delete('/api/servers/:id', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (s.owner_id !== req.user.id) return res.status(403).json({ error: 'owner_only' });
  let affected = [];
  try { affected = db.prepare('SELECT id FROM users WHERE active_tag_server_id = ?').all(s.id).map((r) => r.id); } catch {}
  db.prepare('UPDATE users SET active_tag_server_id = NULL, active_tag = NULL WHERE active_tag_server_id = ?').run(s.id);
  db.prepare('DELETE FROM servers WHERE id = ?').run(s.id);
  for (const uid of affected) { try { const fu = freshUser(uid); broadcastUserUpdate(fu); notifyUser(uid, { t: 'user-updated', user: fu }); } catch {} }
  broadcastToServer(s.id, { t: 'server-deleted', serverId: s.id });
  res.json({ ok: true });
});

app.post('/api/servers/:id/invite/reset', authRequired, (req, res) => {
  return res.status(410).json({ error: 'no_main_invite' });
});

// Named extra invite links with optional use limits / expiry (admins only).
app.get('/api/servers/:id/invites', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isAdmin(s.id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  const rows = db.prepare('SELECT * FROM server_invites WHERE server_id = ? ORDER BY created_at ASC').all(s.id);
  res.json({ invites: rows.map(invitePublic) });
});
app.post('/api/servers/:id/invites', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isAdmin(s.id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  const label = String(req.body?.label || '').trim().slice(0, 32);
  let maxUses = null;
  if (req.body?.maxUses !== undefined && req.body.maxUses !== null && String(req.body.maxUses).trim() !== '') {
    maxUses = parseInt(req.body.maxUses, 10);
    if (!Number.isFinite(maxUses) || maxUses < 1 || maxUses > 100000) return res.status(400).json({ error: 'bad_limit' });
  }
  let expiresAt = null;
  if (req.body?.expiresIn !== undefined && req.body.expiresIn !== null && String(req.body.expiresIn).trim() !== '') {
    const secs = parseInt(req.body.expiresIn, 10);
    if (!Number.isFinite(secs) || secs < 60 || secs > 366 * 86400) return res.status(400).json({ error: 'bad_expiry' });
    expiresAt = now() + secs * 1000;
  } else if (req.body?.expiresAt !== undefined && req.body.expiresAt !== null && String(req.body.expiresAt).trim() !== '') {
    expiresAt = parseInt(req.body.expiresAt, 10);
    if (!Number.isFinite(expiresAt) || expiresAt <= now() || expiresAt > now() + 366 * 86400 * 1000) return res.status(400).json({ error: 'bad_expiry' });
  }
  const n = db.prepare('SELECT COUNT(*) c FROM server_invites WHERE server_id = ?').get(s.id).c;
  if (n >= 50) return res.status(400).json({ error: 'too_many_invites' });
  const code = mintInviteCode();
  if (!code) return res.status(500).json({ error: 'invite_failed' });
  const inv = { id: uid(), server_id: s.id, code, label, created_by: req.user.id, created_at: now(), expires_at: expiresAt, max_uses: maxUses, uses: 0 };
  db.prepare('INSERT INTO server_invites (id,server_id,code,label,created_by,created_at,expires_at,max_uses,uses) VALUES (@id,@server_id,@code,@label,@created_by,@created_at,@expires_at,@max_uses,@uses)').run(inv);
  broadcastToServer(s.id, { t: 'invites-changed', serverId: s.id });
  res.json({ invite: invitePublic(inv) });
});
app.patch('/api/servers/:id/invites/:iid', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isAdmin(s.id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  const inv = db.prepare('SELECT * FROM server_invites WHERE id = ? AND server_id = ?').get(req.params.iid, s.id);
  if (!inv) return res.status(404).json({ error: 'no_invite' });
  const label = String(req.body?.label ?? '').trim().slice(0, 32);
  db.prepare('UPDATE server_invites SET label = ? WHERE id = ?').run(label, inv.id);
  broadcastToServer(s.id, { t: 'invites-changed', serverId: s.id });
  res.json({ invite: invitePublic({ ...inv, label }) });
});
app.delete('/api/servers/:id/invites/:iid', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isAdmin(s.id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  const inv = db.prepare('SELECT * FROM server_invites WHERE id = ? AND server_id = ?').get(req.params.iid, s.id);
  if (!inv) return res.status(404).json({ error: 'no_invite' });
  db.prepare('DELETE FROM server_invites WHERE id = ?').run(inv.id);
  broadcastToServer(s.id, { t: 'invites-changed', serverId: s.id });
  res.json({ ok: true });
});

// Invite friends to a server by picking them: each gets a DM with an invite link.
// Only existing friends can be picked (DMs require friendship). One batch link
// is minted (good for exactly the picked friends) and shared with all of them.
app.post('/api/servers/:id/invite-friends', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isMember(s.id, req.user.id)) return res.status(403).json({ error: 'not_member' });
  const ids = [...new Set((req.body?.userIds || []).map(String))].filter((v) => v !== req.user.id).slice(0, 20);
  const targets = ids.filter((oid) => db.prepare('SELECT 1 FROM users WHERE id = ?').get(oid) && areFriends(req.user.id, oid) && !isMember(s.id, oid));
  if (!targets.length) return res.status(400).json({ error: 'no_users' });
  if (db.prepare('SELECT COUNT(*) c FROM server_invites WHERE server_id = ?').get(s.id).c >= 50) return res.status(400).json({ error: 'too_many_invites' });
  const code = mintInviteCode();
  if (!code) return res.status(500).json({ error: 'invite_failed' });
  db.prepare('INSERT INTO server_invites (id,server_id,code,label,created_by,created_at,expires_at,max_uses,uses) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(uid(), s.id, code, 'Shared via DM', req.user.id, now(), null, targets.length, 0);
  broadcastToServer(s.id, { t: 'invites-changed', serverId: s.id });
  const link = `${ORIGIN}/invite/${code}`;
  let sent = 0;
  for (const oid of targets) {
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
  clearTagSelection(target, s.id);
  try { const fu = freshUser(target); broadcastUserUpdate(fu); notifyUser(target, { t: 'user-updated', user: fu }); } catch {}
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
  clearTagSelection(target, s.id);
  try { const fu = freshUser(target); broadcastUserUpdate(fu); notifyUser(target, { t: 'user-updated', user: fu }); } catch {}
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
app.post('/api/servers/:id/roles/:rid/move', authRequired, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  if (!isAdmin(s.id, req.user.id)) return res.status(403).json({ error: 'owner_only' });
  // Display order is position DESC (index 0 = top role): up swaps with the
  // neighbor above, down with the one below. Hoisted member groups and top
  // role name colors all follow this order.
  const dir = req.body?.dir === 'down' ? 1 : -1;
  const roles = db.prepare('SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC, created_at ASC').all(s.id);
  const i = roles.findIndex((r) => r.id === req.params.rid);
  if (i < 0) return res.status(404).json({ error: 'no_role' });
  db.transaction(() => {
    // Normalize first so legacy duplicate positions can't misbehave, then swap.
    roles.forEach((r, k) => db.prepare('UPDATE roles SET position = ? WHERE id = ?').run(roles.length - k, r.id));
    const j = i + dir;
    if (j >= 0 && j < roles.length) {
      db.prepare('UPDATE roles SET position = ? WHERE id = ?').run(roles.length - j, roles[i].id);
      db.prepare('UPDATE roles SET position = ? WHERE id = ?').run(roles.length - i, roles[j].id);
    }
  })();
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
  if (!isMember(s.id, target) || (target === s.owner_id && req.user.id !== s.owner_id)) return res.status(400).json({ error: 'bad_member' });
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

// NSFW channels: members must confirm they are 18+ once per account before
// reading. The flag lives on the user row so every device unlocks together.
function nsfwBlocked(chId, serverId, user) {
  if (user && user.nsfw_ok) return false;
  try {
    const ch = db.prepare('SELECT nsfw FROM channels WHERE id = ? AND server_id = ?').get(chId, serverId);
    return !!(ch && ch.nsfw);
  } catch { return false; }
}
app.post('/api/me/nsfw-confirm', authRequired, (req, res) => {
  db.prepare('UPDATE users SET nsfw_ok = 1 WHERE id = ?').run(req.user.id);
  const u = freshUser(req.user.id);
  try { broadcastUserUpdate(u); } catch {}
  res.json({ user: u });
});
app.get('/api/servers/:id/channels/:chId/messages', authRequired, (req, res) => {
  const { id, chId } = req.params;
  if (!isMember(id, req.user.id)) return res.status(403).json({ error: 'not_member' });
  if (nsfwBlocked(chId, id, req.user)) return res.status(403).json({ error: 'nsfw_confirm_required' });
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

// Unified quick-find: message text across every server channel + DM thread
// the caller can read. Powers the header chat finder (MESSAGES section).
// Thread replies are excluded — jump-to-context only supports top-level
// channel messages (same constraint as jump-to-pin). NSFW channels stay
// hidden until the account confirms 18+ (same rule as history loads).
app.get('/api/search', authRequired, (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q.length < 2) return res.json({ results: [] });
  const lim = Math.min(parseInt(req.query.limit || '20', 10) || 20, 30);
  const pat = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  const me = req.user.id;
  let nsfwOk = 0;
  try { nsfwOk = db.prepare('SELECT nsfw_ok FROM users WHERE id = ?').get(me)?.nsfw_ok ? 1 : 0; } catch {}
  const out = [];
  try {
    const srows = db.prepare(`
      SELECT m.*, u.username, u.display_name, u.avatar_color, u.avatar_url,
             p.content AS p_content, pu.display_name AS p_name
      FROM messages m
      JOIN channels ch ON ch.id = m.channel_id
      JOIN server_members sm ON sm.server_id = m.server_id AND sm.user_id = ?
      LEFT JOIN users u ON u.id = m.user_id
      LEFT JOIN messages p ON p.id = m.reply_to_id
      LEFT JOIN users pu ON pu.id = p.user_id
      WHERE m.thread_root_id IS NULL AND m.sys IS NULL
        AND (ch.nsfw = 0 OR ? = 1)
        AND m.content LIKE ? ESCAPE '\\'
      ORDER BY m.created_at DESC LIMIT ?
    `).all(me, nsfwOk, pat, lim);
    const smsgs = hydrateMessages(srows, me);
    const sids = [...new Set(srows.map((r) => r.server_id))];
    const cids = [...new Set(srows.map((r) => r.channel_id))];
    const snames = {}, cnames = {};
    if (sids.length) {
      const ph = sids.map(() => '?').join(',');
      for (const r of db.prepare(`SELECT id, name FROM servers WHERE id IN (${ph})`).all(...sids)) snames[r.id] = r.name;
    }
    if (cids.length) {
      const ph = cids.map(() => '?').join(',');
      for (const r of db.prepare(`SELECT id, name FROM channels WHERE id IN (${ph})`).all(...cids)) cnames[r.id] = r.name;
    }
    smsgs.forEach((msg, i) => out.push({
      kind: 'server', message: msg,
      serverName: snames[srows[i].server_id] || 'Server',
      channelName: cnames[srows[i].channel_id] || 'chat',
    }));
  } catch {}
  try {
    const drows = db.prepare(`${DM_JOIN}
      JOIN dm_members dmm ON dmm.thread_id = m.thread_id AND dmm.user_id = ?
      WHERE m.sys IS NULL AND m.content LIKE ? ESCAPE '\\'
      ORDER BY m.created_at DESC LIMIT ?
    `).all(me, pat, lim);
    const dmsgs = hydrateDm(drows, me);
    dmsgs.forEach((msg, i) => {
      const t = db.prepare('SELECT * FROM dm_threads WHERE id = ?').get(drows[i].thread_id);
      let title = 'Direct message';
      if (t) {
        if (t.is_group) title = t.name || 'Group chat';
        else {
          const peer = db.prepare(`SELECT ${USER_COLS} FROM users WHERE id IN (SELECT user_id FROM dm_members WHERE thread_id = ? AND user_id != ?) LIMIT 1`).get(t.id, me);
          title = (peer && peer.display_name) || 'Direct message';
        }
      }
      out.push({ kind: 'dm', message: msg, threadTitle: title });
    });
  } catch {}
  out.sort((a, b) => b.message.created_at - a.message.created_at || (a.message.id < b.message.id ? -1 : 1));
  res.json({ results: out.slice(0, lim) });
});

app.delete('/api/messages/:mid', authRequired, (req, res) => {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.mid);
  if (!m) return res.status(404).json({ error: 'no_message' });
  const s = getServer(m.server_id);
  const canDelete = m.user_id === req.user.id || (s && isAdmin(s.id, req.user.id));
  if (!canDelete) return res.status(403).json({ error: 'forbidden' });
  // Deleting a thread root removes its replies too (threads are 1 level deep).
  let pinsChanged = false;
  let kidIds = [];
  if (!m.thread_root_id) {
    kidIds = db.prepare('SELECT id FROM messages WHERE thread_root_id = ?').all(m.id).map((r) => r.id);
    if (kidIds.length) {
      const ph = kidIds.map(() => '?').join(',');
      if (db.prepare(`DELETE FROM message_pins WHERE message_id IN (${ph})`).run(...kidIds).changes) pinsChanged = true;
      db.prepare('DELETE FROM messages WHERE thread_root_id = ?').run(m.id);
    }
  }
  db.prepare('DELETE FROM messages WHERE id = ?').run(m.id);
  deletePollsFor('server', kidIds.length ? [m.id, ...kidIds] : [m.id]);
  if (db.prepare('DELETE FROM message_pins WHERE message_id = ?').run(m.id).changes) pinsChanged = true;
  if (pinsChanged) {
    broadcastToServer(m.server_id, { t: 'pins-changed', serverId: m.server_id, channelId: m.channel_id });
  }
  broadcastToServer(m.server_id, { t: 'message-deleted', serverId: m.server_id, channelId: m.channel_id, messageId: m.id, threadRoot: m.thread_root_id || null });
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
  if (nsfwBlocked(chId, id, req.user)) return res.status(403).json({ error: 'nsfw_confirm_required' });
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
  const sysMid = uid();
  db.prepare('INSERT INTO messages (id,server_id,channel_id,user_id,content,sys,created_at) VALUES (?,?,?,?,?,?,?)').run(sysMid, id, chId, null, `${displayOf(req.user)} pinned a message`.slice(0, 200), 'info', now());
  broadcastToServer(id, { t: 'message-new', serverId: id, channelId: chId, message: fullMessage(sysMid, null) });
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
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'bad_file (no file received)' });
  try { await persistUpload('files', req.file); }
  catch { return res.status(500).json({ error: 'storage_failed' }); }
  let mt = req.file.mimetype;
  // Extension-accepted code/text with an empty or generic MIME reads as text.
  if ((!mt || mt === 'application/octet-stream') && CODE_TEXT_EXTS.has(path.extname(String(req.file.originalname || '')).toLowerCase().slice(1))) mt = 'text/plain';
  const kind = mt.startsWith('image/') ? 'image' : mt.startsWith('video/') ? 'video' : mt.startsWith('audio/') ? 'audio' : 'file';
  res.json({ url: uploadUrl('files', req.file), name: String(req.file.originalname || 'file').slice(0, 120), mime: mt, size: req.file.size, kind });
});

// image upload middleware: rejects non-images / oversize with a clean 400/413
function imgSingle(up) {
  return (req, res, next) => up.single('file')(req, res, async (err) => {
    if (err) return res.status(413).json({ error: 'image_too_large' });
    if (!req.file) return res.status(400).json({ error: 'bad_image (png, jpg, gif incl. animated, webp)' });
    try { await persistUpload(up._sub, req.file); }
    catch { return res.status(500).json({ error: 'storage_failed' }); }
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
  // Custom-status expiry (ms epoch; null/0/'' = never, max 30 days out).
  // Changing the text resets any timer unless a new expiry rides along;
  // empty text never carries an expiry.
  let finalExp = undefined; // undefined = leave the column alone
  if (statusText !== undefined && String(statusText).slice(0, 64) !== (req.user.status_text || '')) finalExp = null;
  if (req.body?.statusExpiresAt !== undefined) {
    const v = req.body.statusExpiresAt;
    if (v === null || v === 0 || v === '') finalExp = null;
    else {
      const ts = Math.floor(Number(v));
      if (!Number.isFinite(ts) || ts <= now() || ts > now() + 30 * 864e5) return res.status(400).json({ error: 'bad_expiry' });
      finalExp = ts;
    }
  }
  const finalText = statusText !== undefined ? String(statusText).slice(0, 64) : (req.user.status_text || '');
  if (!finalText) finalExp = null;
  if (finalExp !== undefined) { sets.push('status_expires_at = ?'); vals.push(finalExp); }
  // Presence revert timer (ms epoch; null/0/'' = stay until changed, max 30 days).
  // Only away/dnd/invisible carry one — online never does. Explicitly picking
  // a new presence clears any pending timer unless a fresh one rides along;
  // resaving the same presence (e.g. profile edits) leaves it untouched.
  let finalPresence = undefined; // undefined = leave the column alone
  const finalStatus = status !== undefined ? status : (req.user.status || 'online');
  if (finalStatus === 'online') finalPresence = null;
  else if (status !== undefined && status !== req.user.status) finalPresence = null;
  if (req.body?.presenceExpiresAt !== undefined) {
    const v = req.body.presenceExpiresAt;
    if (v === null || v === 0 || v === '') finalPresence = null;
    else {
      const ts = Math.floor(Number(v));
      if (!Number.isFinite(ts) || ts <= now() || ts > now() + 30 * 864e5) return res.status(400).json({ error: 'bad_expiry' });
      finalPresence = ts;
    }
  }
  if (finalStatus === 'online') finalPresence = null;
  if (finalPresence !== undefined) { sets.push('presence_expires_at = ?'); vals.push(finalPresence); }
  if (req.body?.bio !== undefined) {
    sets.push('bio = ?'); vals.push(squashBreaks(req.body.bio).trim().slice(0, 300));
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
  if (req.body?.tagServerId !== undefined) {
    const tid = req.body.tagServerId === null || req.body.tagServerId === '' ? null : String(req.body.tagServerId);
    if (!tid) { sets.push('active_tag_server_id = NULL'); sets.push('active_tag = NULL'); }
    else {
      const srv = getServer(tid);
      if (!srv) return res.status(404).json({ error: 'no_server' });
      if (!isMember(srv.id, req.user.id)) return res.status(403).json({ error: 'not_member' });
      if (!srv.tag && !srv.tag_emoji) return res.status(400).json({ error: 'no_tag' });
      sets.push('active_tag_server_id = ?'); vals.push(srv.id);
      sets.push('active_tag = ?'); vals.push((srv.tag_emoji || '') + (srv.tag || ''));
    }
  }
  if (req.body?.gameEnabled !== undefined) {
    sets.push('game_enabled = ?'); vals.push(req.body.gameEnabled ? 1 : 0);
  }
  if (req.body?.gameExclusions !== undefined) {
    const arr = Array.isArray(req.body.gameExclusions) ? req.body.gameExclusions : [];
    const clean = [...new Set(arr.map((x) => String(x).trim()).filter((x) => GAME_RE.test(x)))].slice(0, 200);
    sets.push('game_exclusions = ?'); vals.push(JSON.stringify(clean));
  }
  if (req.body?.theme !== undefined) {
    const th = String(req.body.theme);
    if (!['dark', 'light', 'dracula', 'oled'].includes(th)) return res.status(400).json({ error: 'bad_theme' });
    sets.push('theme = ?'); vals.push(th);
  }
  // Player-local timezone (minutes east of UTC) for streak day bucketing.
  // Reported by the web client on boot and by the desktop watcher per
  // beacon; only written when it actually changed.
  if (req.body?.tzOffset !== undefined) {
    const tz = parseTz(req.body.tzOffset);
    if (tz === null) return res.status(400).json({ error: 'bad_tz' });
    if (tz !== userTz(req.user)) { sets.push('tz_offset = ?'); vals.push(tz); }
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
  vals.push(req.user.id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  // Disabling game activity or ignoring the currently-played game takes
  // effect immediately instead of lingering until the next watcher beacon.
  try {
    const cur = db.prepare('SELECT playing_game, game_enabled, game_exclusions FROM users WHERE id = ?').get(req.user.id);
    if (cur?.playing_game) {
      let excluded = false;
      try { excluded = new Set(JSON.parse(cur.game_exclusions || '[]')).has(cur.playing_game); } catch {}
      if (cur.game_enabled === 0 || excluded) db.prepare('UPDATE users SET playing_game = NULL WHERE id = ?').run(req.user.id);
    }
  } catch {}
  const u = freshUser(req.user.id);
  // Theme-only saves stay silent: no user-update broadcast (nothing other
  // clients render), no presence fan-out — just the PATCH response.
  if (!(sets.length === 1 && sets[0] === 'theme = ?')) {
  broadcastUserUpdate(u);
  for (const sid of [...clients].filter((c) => c.meta && c.meta.userId === u.id).flatMap((c) => [...c.meta.servers])) {
    broadcastToServer(sid, { t: 'user-status', serverId: sid, userId: u.id, status: u.status });
  }
  // sync live sockets' presence state
  for (const c of clients) if (c.meta && c.meta.userId === u.id) c.meta.status = u.status;
  }
  res.json({ user: u });
});
// ---------- game activity watcher (Windows desktop app beacon) ----------
// playing_game is kept separate from status_text: the watcher sets it and logs
// playtime; custom status is untouched. Heartbeats {game|null, ts} every ~5-30s;
// time is credited in capped increments so gaps/clock skew can't inflate totals.
const GAME_RE = /^[\p{L}\p{N} .(),&+'\-:]{2,48}$/u;
const BEACON_CAP_MS = 15 * 60 * 1000;
const lastBeacon = new Map(); // userId -> { ts, game|null }
const BEACON_STALE_MS = 90 * 1000;
function utcDay(ts) { return new Date(ts).toISOString().slice(0, 10); }
// Timezone-aware calendar days for streaks. The watcher (and web client)
// report tz as minutes east of UTC (JS: -getTimezoneOffset()); days are
// bucketed in the player's local calendar, so a session crossing UTC
// midnight (e.g. 7-8 PM ET = 23:00-00:00 UTC) stays ONE day instead of
// minting a bogus 2-day streak. Unknown tz falls back to UTC.
function parseTz(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < -720 || n > 840) return null;
  return n;
}
function userTz(u) {
  if (u == null) return 0;
  const raw = (typeof u === 'object') ? u.tz_offset : u;
  if (raw === null || raw === undefined || raw === '') return 0;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.max(-720, Math.min(840, n)) : 0;
}
function localDay(ts, tzMin) { return utcDay(Number(ts) + userTz(tzMin) * 60000); }
// Level = 1 + number of playtime thresholds passed (minutes): 1h, 3h, 8h, 20h, 40h, 80h, 160h, 320h, 640h, 1280h, 2560h
const LEVEL_MIN = [0, 60, 180, 480, 1200, 2400, 4800, 9600, 19200, 38400, 76800, 153600];
function levelForMs(ms) {
  const min = ms / 60000;
  let l = 1;
  for (let i = 1; i < LEVEL_MIN.length; i++) if (min >= LEVEL_MIN[i]) l = i + 1;
  return l;
}
function creditPlay(userId, game, ms, ts, tzMin) {
  if (ms <= 0) return;
  const day = localDay(ts, tzMin);
  db.prepare(`INSERT INTO game_days (user_id, game, day, ms) VALUES (?,?,?,?)
    ON CONFLICT(user_id, game, day) DO UPDATE SET ms = ms + excluded.ms`).run(userId, game, day, ms);
  db.prepare(`INSERT INTO user_games (user_id, game, total_ms, first_seen_ms, last_seen_ms) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id, game) DO UPDATE SET total_ms = total_ms + excluded.total_ms,
    last_seen_ms = excluded.last_seen_ms,
    first_seen_ms = MIN(first_seen_ms, excluded.first_seen_ms)`).run(userId, game, ms, ts, ts);
}
// Streaks from the day log (player-local calendar days). Current streak
// only counts if the most recent play day is today or yesterday; best is
// the longest run in the log.
function dayStreak(userId, where, params, tzMin) {
  const rows = db.prepare(`SELECT day FROM game_days WHERE user_id = ? ${where} GROUP BY day ORDER BY day DESC LIMIT 400`).all(...params);
  const days = rows.map((r) => r.day);
  if (!days.length) return { streak: 0, best: 0 };
  const set = new Set(days);
  const prevDay = (d) => utcDay(Date.parse(d) - 86400000);
  let streak = 0;
  const latest = days[0];
  const today = localDay(Date.now(), tzMin);
  if (latest === today || latest === prevDay(today)) {
    let d = latest;
    while (set.has(d)) { streak++; d = prevDay(d); }
  }
  let best = 1, run = 1;
  for (let i = 1; i < days.length; i++) {
    if (prevDay(days[i - 1]) === days[i]) { run++; best = Math.max(best, run); }
    else run = 1;
  }
  return { streak, best };
}
// ---------- game artwork (Steam capsule art, cached in game_icons) ----------
// Non-Steam titles can't be found by search, so a small curated override map
// covers the biggest ones. Add more as `normalized name: image URL`.
const GAME_ICON_OVERRIDES = {
  minecraft: 'https://minecraft.wiki/images/Grass_Block_JE7_BE6.png',
};
const gameIconMem = new Map(); // normalized name -> url|null (process cache)
function normGame(s) {
  return String(s || '').toLowerCase().replace(/[®™©]/g, '').replace(/\s+/g, ' ').trim();
}
async function resolveGameIcon(game) {
  const key = normGame(game);
  if (!key) return null;
  if (gameIconMem.has(key)) return gameIconMem.get(key);
  if (GAME_ICON_OVERRIDES[key]) {
    gameIconMem.set(key, GAME_ICON_OVERRIDES[key]);
    return GAME_ICON_OVERRIDES[key];
  }
  try {
    const row = db.prepare('SELECT url, updated_at FROM game_icons WHERE game = ?').get(key);
    if (row && (row.url || Date.now() - row.updated_at < 7 * 864e5)) {
      gameIconMem.set(key, row.url || null);
      return row.url || null;
    }
  } catch {}
  let url = null;
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch('https://store.steampowered.com/api/storesearch/?term=' + encodeURIComponent(game) + '&l=en&cc=US', { signal: ctl.signal });
    clearTimeout(to);
    const j = await r.json();
    const items = j?.items || [];
    // Strict match only — a near-miss logo is worse than the letter tile.
    // Single-result prefix match covers "Game" vs "Game: Subtitle" listings.
    const hit = items.find((it) => normGame(it.name) === key)
      || (items.length === 1 && (normGame(items[0].name).startsWith(key) || key.startsWith(normGame(items[0].name))) ? items[0] : null);
    if (hit && hit.id) url = `https://cdn.cloudflare.steamstatic.com/steam/apps/${hit.id}/capsule_184x69.jpg`;
  } catch {}
  try {
    db.prepare(`INSERT INTO game_icons (game, url, updated_at) VALUES (?,?,?)
      ON CONFLICT(game) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at`).run(key, url, Date.now());
  } catch {}
  gameIconMem.set(key, url);
  return url;
}
async function withGameIcons(games) {
  await Promise.all((games || []).map(async (g) => {
    try { g.icon_url = await resolveGameIcon(g.game); } catch { g.icon_url = null; }
  }));
  return games;
}
async function gamingFor(userId) {
  const u = db.prepare('SELECT game_enabled, game_exclusions, playing_game, tz_offset FROM users WHERE id = ?').get(userId);
  const tz = userTz(u);
  const exclusions = new Set(JSON.parse(u?.game_exclusions || '[]'));
  const games = db.prepare('SELECT game, total_ms, first_seen_ms, last_seen_ms FROM user_games WHERE user_id = ? ORDER BY total_ms DESC').all(userId);
  const out = games
    .filter((g) => !exclusions.has(g.game))
    .map((g) => {
      const s = dayStreak(userId, 'AND game = ?', [userId, g.game], tz);
      return { game: g.game, total_ms: g.total_ms, level: levelForMs(g.total_ms), streak: s.streak, best_streak: s.best, last_seen_ms: g.last_seen_ms };
    });
  const total_ms = out.reduce((a, g) => a + g.total_ms, 0);
  const s = dayStreak(userId, '', [userId], tz);
  // Authoritative live status: playing_game, not recency of last_seen_ms
  // (which stays fresh for minutes after quitting and made cards claim
  // "Playing X" after the game closed). Null when disabled/excluded.
  let now_playing = (u?.game_enabled !== 0 && u?.playing_game) ? u.playing_game : null;
  if (now_playing && exclusions.has(now_playing)) now_playing = null;
  const top = out.slice(0, 10);
  await withGameIcons(top);
  return { total_ms, level: levelForMs(total_ms), streak: s.streak, best_streak: s.best, now_playing, games: top };
}
app.post('/api/watcher/status', authRequired, (req, res) => {
  const raw = req.body || {};
  const rawGame = raw.game == null ? null : String(raw.game).trim();
  if (rawGame && !GAME_RE.test(rawGame)) return res.status(400).json({ error: 'bad_game' });
  const now = Date.now();
  const ts = Math.max(now - 60 * 60 * 1000, Math.min(now + 5 * 60 * 1000, Number(raw.ts) || now));
  const u = req.user;
  // Watcher-reported local timezone (minutes east of UTC) keeps streak
  // days on the player's calendar instead of UTC. Persisted when changed
  // so the web client on the same machine and future beacons agree.
  let tz = userTz(u);
  if (raw.tz !== undefined) {
    const ptz = parseTz(raw.tz);
    if (ptz === null) return res.status(400).json({ error: 'bad_tz' });
    tz = ptz;
    if (ptz !== userTz(u)) {
      try { db.prepare('UPDATE users SET tz_offset = ? WHERE id = ?').run(ptz, u.id); } catch {}
    }
  }
  const exclusions = new Set(JSON.parse(u.game_exclusions || '[]'));
  const enabled = u.game_enabled !== 0;
  const game = (enabled && rawGame && !exclusions.has(rawGame)) ? rawGame : null;
  const prev = freshUser(u.id).playing_game;
  const last = lastBeacon.get(u.id);
  if (last && last.game === game) {
    if (game) creditPlay(u.id, game, Math.min(ts - last.ts, BEACON_CAP_MS), ts, tz);
  } else if (last && last.game) {
    creditPlay(u.id, last.game, Math.min(now - last.ts, BEACON_CAP_MS), last.ts, tz);
  }
  if (game && prev !== game) {
    db.prepare('UPDATE users SET playing_game = ? WHERE id = ?').run(game, u.id);
  } else if (!game && prev) {
    db.prepare('UPDATE users SET playing_game = NULL WHERE id = ?').run(u.id);
  }
  lastBeacon.set(u.id, { ts, game });
  const u2 = freshUser(u.id);
  broadcastUserUpdate(u2);
  res.json({ ok: true, playing_game: u2.playing_game });
});
app.delete('/api/watcher/status', authRequired, (req, res) => {
  lastBeacon.set(req.user.id, { ts: Date.now(), game: null });
  db.prepare('UPDATE users SET playing_game = NULL WHERE id = ?').run(req.user.id);
  const u2 = freshUser(req.user.id);
  broadcastUserUpdate(u2);
  res.json({ ok: true, playing_game: null });
});
app.get('/api/users/:username/gaming', authRequired, async (req, res) => {
  const t = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(req.params.username);
  if (!t) return res.status(404).json({ error: 'no_user' });
  res.json(await gamingFor(t.id));
});
app.get('/api/me/gaming', authRequired, async (req, res) => res.json(await gamingFor(req.user.id)));
app.get('/api/me/games', authRequired, async (req, res) => {
  const games = db.prepare('SELECT game, total_ms, first_seen_ms, last_seen_ms FROM user_games WHERE user_id = ? ORDER BY total_ms DESC').all(req.user.id);
  const exclusions = new Set(JSON.parse(req.user.game_exclusions || '[]'));
  const rows = games.map((g) => ({ ...g, excluded: exclusions.has(g.game) }));
  await withGameIcons(rows);
  res.json({
    enabled: req.user.game_enabled !== 0,
    exclusions: [...exclusions],
    games: rows,
  });
});
// Resolved artwork for one game (memory + DB cached, strict Steam match).
// Feeds the Discord-style game badges in member rows (controller icon
// until art resolves). Same upstream exposure as profile game cards.
app.get('/api/games/icon', authRequired, async (req, res) => {
  const game = String(req.query.game || '').trim().slice(0, 80);
  if (!game) return res.status(400).json({ error: 'game_required' });
  try { res.json({ game, url: await resolveGameIcon(game) }); }
  catch { res.json({ game, url: null }); }
});
app.delete('/api/me/games/:game', authRequired, (req, res) => {
  const game = String(req.params.game).trim();
  if (!game || !GAME_RE.test(game)) return res.status(400).json({ error: 'bad_game' });
  db.prepare('DELETE FROM user_games WHERE user_id = ? AND game = ?').run(req.user.id, game);
  db.prepare('DELETE FROM game_days WHERE user_id = ? AND game = ?').run(req.user.id, game);
  if (freshUser(req.user.id).playing_game === game) {
    db.prepare('UPDATE users SET playing_game = NULL WHERE id = ?').run(req.user.id);
    const u2 = freshUser(req.user.id);
    broadcastUserUpdate(u2);
  }
  res.json({ ok: true });
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
// Folders: server_folders rows (id/name/color/position/open) plus each
// server_members.folder_id + position. Positions are global rail indexes so
// unfiled servers and folders interleave; inside a folder, servers order by
// their position too.
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

// ---------- site admin (is_admin users only) ----------
// Full control over users and servers (guilds): stats, search/rename/disable,
// password resets, forced logouts, deletes, moderation and broadcasts.
function adminUserView(u) {
  const base = publicUser(u);
  let serverCount = 0, messageCount = 0, dmCount = 0;
  try {
    serverCount = db.prepare('SELECT COUNT(*) c FROM server_members WHERE user_id = ?').get(u.id).c;
    messageCount = db.prepare('SELECT COUNT(*) c FROM messages WHERE user_id = ?').get(u.id).c;
    dmCount = db.prepare('SELECT COUNT(*) c FROM dm_messages WHERE user_id = ?').get(u.id).c;
  } catch {}
  return { ...base, is_admin: !!u.is_admin, disabled: !!u.disabled, has2fa: !!u.totp_enabled, serverCount, messageCount, dmCount };
}
app.get('/api/admin/stats', authRequired, requireSiteAdmin, (req, res) => {
  const count = (sql, ...a) => { try { return db.prepare(sql).get(...a).c; } catch { return 0; } };
  const weekAgo = now() - 7 * 864e5;
  res.json({
    users: count('SELECT COUNT(*) c FROM users'),
    admins: count('SELECT COUNT(*) c FROM users WHERE is_admin = 1'),
    disabled: count('SELECT COUNT(*) c FROM users WHERE disabled = 1'),
    newWeek: count('SELECT COUNT(*) c FROM users WHERE created_at > ?', weekAgo),
    servers: count('SELECT COUNT(*) c FROM servers'),
    channels: count('SELECT COUNT(*) c FROM channels'),
    messages: count('SELECT COUNT(*) c FROM messages'),
    dmMessages: count('SELECT COUNT(*) c FROM dm_messages'),
    online: clients.size,
  });
});
app.get('/api/admin/users', authRequired, requireSiteAdmin, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const filter = String(req.query.filter || 'all');
  const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
  const conds = [], params = [];
  if (q) { conds.push('(username LIKE ? OR display_name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (filter === 'admins') conds.push('is_admin = 1');
  if (filter === 'disabled') conds.push('disabled = 1');
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM users ${where}`).get(...params).c;
  const rows = db.prepare(`SELECT * FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ users: rows.map(adminUserView), total });
});
app.get('/api/admin/users/:id', authRequired, requireSiteAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'no_user' });
  res.json({ user: adminUserView(u) });
});
app.patch('/api/admin/users/:id', authRequired, requireSiteAdmin, async (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'no_user' });
  const self = target.id === req.user.id;
  const sets = [], params = [];
  if (req.body?.displayName !== undefined) {
    const d = String(req.body.displayName).trim().slice(0, 32);
    if (!d) return res.status(400).json({ error: 'name_required' });
    sets.push('display_name = ?'); params.push(d);
  }
  if (req.body?.avatarColor !== undefined) {
    const c = String(req.body.avatarColor);
    if (c && !/^#[0-9a-fA-F]{6}$/.test(c)) return res.status(400).json({ error: 'bad_color' });
    sets.push('avatar_color = ?'); params.push(c || '#5865f2');
  }
  if (req.body?.bio !== undefined) { sets.push('bio = ?'); params.push(squashBreaks(String(req.body.bio)).slice(0, 300)); }
  if (req.body?.disabled !== undefined) {
    if (self && req.body.disabled) return res.status(400).json({ error: 'cannot_disable_self' });
    sets.push('disabled = ?'); params.push(req.body.disabled ? 1 : 0);
  }
  if (req.body?.is_admin !== undefined) {
    if (self && !req.body.is_admin) return res.status(400).json({ error: 'cannot_demote_self' });
    sets.push('is_admin = ?'); params.push(req.body.is_admin ? 1 : 0);
  }
  if (req.body?.password !== undefined && String(req.body.password).length) {
    if (String(req.body.password).length < 4) return res.status(400).json({ error: 'password too short (min 4)' });
    sets.push('password_hash = ?'); params.push(await bcrypt.hash(String(req.body.password), 10));
    sets.push('token_valid_after = ?'); params.push(now());
    db.prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ?').run(target.id);
    closeSessionSockets(target.id, null);
  }
  if (sets.length) { params.push(target.id); db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params); }
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(target.id);
  if (fresh.disabled) {
    db.prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ?').run(target.id);
    closeSessionSockets(target.id, null);
  }
  broadcastUserUpdate(fresh);
  res.json({ user: adminUserView(fresh) });
});
app.delete('/api/admin/users/:id', authRequired, requireSiteAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'no_user' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'cannot_delete_self' });
  const serverIds = db.prepare('SELECT server_id FROM server_members WHERE user_id = ?').all(target.id).map((r) => r.server_id);
  db.prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ?').run(target.id);
  closeSessionSockets(target.id, null);
  evictFromServerAll(target.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  for (const sid of serverIds) {
    broadcastToServer(sid, { t: 'member-left', serverId: sid, userId: target.id });
    const v = serverView(sid);
    if (v) broadcastToServer(sid, { t: 'server-updated', server: v });
  }
  res.json({ ok: true });
});
function evictFromServerAll(userId) {
  for (const c of clients) {
    if (!c.meta || c.meta.userId !== userId) continue;
    c.meta.servers = new Set();
    if (c.meta.voice) leaveVoice(c, true);
  }
}
app.post('/api/admin/users/:id/sessions/revoke', authRequired, requireSiteAdmin, (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'no_user' });
  db.prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ?').run(target.id);
  db.prepare('UPDATE users SET token_valid_after = ? WHERE id = ?').run(now(), target.id);
  closeSessionSockets(target.id, null);
  res.json({ ok: true });
});
// Site admin: strip 2FA (TOTP + backup codes) so a locked-out user can log
// in with just their password again. Never usable on yourself — use your
// own Settings -> 2FA flow for that.
app.post('/api/admin/users/:id/2fa/disable', authRequired, requireSiteAdmin, (req, res) => {
  const target = db.prepare('SELECT id, totp_enabled FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'no_user' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'cannot_reset_own_2fa' });
  if (!target.totp_enabled) return res.status(400).json({ error: '2fa_not_enabled' });
  db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?').run(target.id);
  db.prepare('DELETE FROM totp_backups WHERE user_id = ?').run(target.id);
  res.json({ ok: true });
});
// Site admin: set/remove any user's avatar, banner and member-list
// (sidebar) banner. Mirrors the /api/me/* handlers, minus membership.
function adminTargetUser(req, res) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) { res.status(404).json({ error: 'no_user' }); return null; }
  return u;
}
function adminSetUserMedia(req, res, col, sub, kind) {
  const u = adminTargetUser(req, res);
  if (!u) { deleteUploaded(uploadUrl(sub, req.file)); return; }
  const url = uploadUrl(sub, req.file);
  deleteUploaded(u[col]);
  db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(url, u.id);
  if (kind) recordMedia(u.id, kind, url);
  broadcastUserUpdate(freshUser(u.id));
  res.json({ user: adminUserView(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
}
function adminClearUserMedia(req, res, col) {
  const u = adminTargetUser(req, res);
  if (!u) return;
  deleteUploaded(u[col]);
  db.prepare(`UPDATE users SET ${col} = NULL WHERE id = ?`).run(u.id);
  broadcastUserUpdate(freshUser(u.id));
  res.json({ user: adminUserView(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
}
app.post('/api/admin/users/:id/avatar', authRequired, requireSiteAdmin, imgSingle(upImg), (req, res) => adminSetUserMedia(req, res, 'avatar_url', 'avatars', 'avatar'));
app.delete('/api/admin/users/:id/avatar', authRequired, requireSiteAdmin, (req, res) => adminClearUserMedia(req, res, 'avatar_url'));
app.post('/api/admin/users/:id/banner', authRequired, requireSiteAdmin, imgSingle(upBanner), (req, res) => adminSetUserMedia(req, res, 'banner_url', 'banners', 'banner'));
app.delete('/api/admin/users/:id/banner', authRequired, requireSiteAdmin, (req, res) => adminClearUserMedia(req, res, 'banner_url'));
app.post('/api/admin/users/:id/sidebar-banner', authRequired, requireSiteAdmin, imgSingle(upSidebar), (req, res) => adminSetUserMedia(req, res, 'sidebar_banner_url', 'sidebar', null));
app.delete('/api/admin/users/:id/sidebar-banner', authRequired, requireSiteAdmin, (req, res) => adminClearUserMedia(req, res, 'sidebar_banner_url'));
// Site admin: set/remove any server's icon and banner. Mirrors the
// per-server handlers, minus membership.
app.post('/api/admin/servers/:id/icon', authRequired, requireSiteAdmin, imgSingle(upIcon), (req, res) => {
  const s = getServer(req.params.id);
  if (!s) { deleteUploaded(uploadUrl('icons', req.file)); return res.status(404).json({ error: 'no_server' }); }
  const url = uploadUrl('icons', req.file);
  deleteUploaded(s.icon_url);
  db.prepare('UPDATE servers SET icon_url = ? WHERE id = ?').run(url, s.id);
  broadcastToServer(s.id, { t: 'server-updated', server: serverView(s.id) });
  res.json({ server: adminServerById(s.id) });
});
app.delete('/api/admin/servers/:id/icon', authRequired, requireSiteAdmin, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  deleteUploaded(s.icon_url);
  db.prepare('UPDATE servers SET icon_url = NULL WHERE id = ?').run(s.id);
  broadcastToServer(s.id, { t: 'server-updated', server: serverView(s.id) });
  res.json({ server: adminServerById(s.id) });
});
app.post('/api/admin/servers/:id/banner', authRequired, requireSiteAdmin, imgSingle(upBanner), (req, res) => {
  const s = getServer(req.params.id);
  if (!s) { deleteUploaded(uploadUrl('banners', req.file)); return res.status(404).json({ error: 'no_server' }); }
  const url = uploadUrl('banners', req.file);
  deleteUploaded(s.banner_url);
  db.prepare('UPDATE servers SET banner_url = ? WHERE id = ?').run(url, s.id);
  broadcastToServer(s.id, { t: 'server-updated', server: serverView(s.id) });
  res.json({ server: adminServerById(s.id) });
});
app.delete('/api/admin/servers/:id/banner', authRequired, requireSiteAdmin, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  deleteUploaded(s.banner_url);
  db.prepare('UPDATE servers SET banner_url = NULL WHERE id = ?').run(s.id);
  broadcastToServer(s.id, { t: 'server-updated', server: serverView(s.id) });
  res.json({ server: adminServerById(s.id) });
});
function adminServerById(id) {
  const row = db.prepare('SELECT s.*, u.username AS owner_username FROM servers s LEFT JOIN users u ON u.id = s.owner_id WHERE s.id = ?').get(id);
  return row ? adminServerSummary(row) : null;
}
function adminServerSummary(s) {
  return {
    id: s.id, name: s.name, description: s.description || '', icon_url: s.icon_url || null,
    banner_url: s.banner_url || null, owner_id: s.owner_id,
    owner_username: s.owner_username || '?', created_at: s.created_at,
    memberCount: db.prepare('SELECT COUNT(*) c FROM server_members WHERE server_id = ?').get(s.id).c,
    channelCount: db.prepare('SELECT COUNT(*) c FROM channels WHERE server_id = ?').get(s.id).c,
    messageCount: db.prepare('SELECT COUNT(*) c FROM messages WHERE server_id = ?').get(s.id).c,
    inviteCount: db.prepare('SELECT COUNT(*) c FROM server_invites WHERE server_id = ?').get(s.id).c,
  };
}
app.get('/api/admin/servers', authRequired, requireSiteAdmin, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
  const where = q ? 'WHERE LOWER(s.name) LIKE ?' : '';
  const params = q ? [`%${q}%`] : [];
  const total = db.prepare(`SELECT COUNT(*) c FROM servers s ${where}`).get(...params).c;
  const rows = db.prepare(`SELECT s.*, u.username AS owner_username FROM servers s LEFT JOIN users u ON u.id = s.owner_id ${where} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ servers: rows.map(adminServerSummary), total });
});
app.patch('/api/admin/servers/:id', authRequired, requireSiteAdmin, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  const sets = [], params = [];
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim().slice(0, 48);
    if (!name) return res.status(400).json({ error: 'name_required' });
    sets.push('name = ?'); params.push(name);
  }
  if (req.body?.description !== undefined) { sets.push('description = ?'); params.push(String(req.body.description).slice(0, 200)); }
  if (req.body?.owner_id !== undefined) {
    const oid = String(req.body.owner_id);
    const nu = db.prepare('SELECT id FROM users WHERE id = ?').get(oid);
    if (!nu) return res.status(404).json({ error: 'no_user' });
    if (!isMember(s.id, oid)) db.prepare('INSERT OR IGNORE INTO server_members (server_id,user_id,joined_at,position) VALUES (?,?,?,?)').run(s.id, oid, now(), 0);
    sets.push('owner_id = ?'); params.push(oid);
  }
  if (sets.length) { params.push(s.id); db.prepare(`UPDATE servers SET ${sets.join(', ')} WHERE id = ?`).run(...params); }
  broadcastToServer(s.id, { t: 'server-updated', server: serverView(s.id) });
  res.json({ server: serverView(s.id) });
});
app.delete('/api/admin/servers/:id', authRequired, requireSiteAdmin, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  db.prepare('DELETE FROM servers WHERE id = ?').run(s.id);
  broadcastToServer(s.id, { t: 'server-deleted', serverId: s.id });
  res.json({ ok: true });
});
app.post('/api/admin/servers/:id/invite/reset', authRequired, requireSiteAdmin, (req, res) => {
  return res.status(410).json({ error: 'no_main_invite' });
});
app.get('/api/admin/servers/:id/members', authRequired, requireSiteAdmin, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  const members = db.prepare(`
    SELECT u.*, CASE WHEN u.id = s.owner_id THEN 'owner' ELSE 'member' END as role
    FROM server_members m JOIN users u ON u.id = m.user_id JOIN servers s ON s.id = m.server_id
    WHERE m.server_id = ? ORDER BY u.display_name COLLATE NOCASE ASC
  `).all(s.id).map(adminUserView);
  res.json({ members });
});
app.delete('/api/admin/servers/:id/members/:uid', authRequired, requireSiteAdmin, (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_server' });
  const target = String(req.params.uid);
  if (target === s.owner_id) return res.status(400).json({ error: 'cannot_kick_owner' });
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(s.id, target);
  broadcastToServer(s.id, { t: 'member-left', serverId: s.id, userId: target });
  evictFromServer(s.id, target);
  notifyUser(target, { t: 'removed-from-server', serverId: s.id, reason: 'kicked' });
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
  if (req.body?.tag !== undefined || req.body?.tagEmoji !== undefined) {
    const tag = req.body?.tag !== undefined ? cleanTag(req.body.tag) : (s.tag || '');
    const emoji = req.body?.tagEmoji !== undefined ? cleanTagEmoji(req.body.tagEmoji) : (s.tag_emoji || '');
    const full = (emoji || '') + (tag || '');
    sets.push('tag = ?'); params.push(tag || null);
    sets.push('tag_emoji = ?'); params.push(emoji || null);
    // Keep every displayed tag in sync: members showing this server's tag
    // follow renames, and lose it when the tag is cleared (their selection
    // is kept, so it comes back if a new tag is set).
    db.prepare('UPDATE users SET active_tag = ? WHERE active_tag_server_id = ?').run(full || null, s.id);
    try {
      const affected = db.prepare('SELECT id FROM users WHERE active_tag_server_id = ?').all(s.id);
      for (const r of affected) { try { broadcastUserUpdate(freshUser(r.id)); } catch {} }
    } catch {}
  }
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
// Cross-server custom emoji: every custom emoji from every server the user
// has joined, grouped by server. This is what lets a joined server's
// emojis be used/rendered anywhere (any channel, any DM).
function userCustomEmojiNames(userId) {
  return new Set(db.prepare(`
    SELECT se.name FROM custom_emoji se
    JOIN server_members m ON m.server_id = se.server_id
    WHERE m.user_id = ?
  `).all(userId).map((r) => r.name));
}
app.get('/api/emojis', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.name AS server_name, se.name AS emoji_name, se.url
    FROM server_members m
    JOIN servers s ON s.id = m.server_id
    JOIN custom_emoji se ON se.server_id = m.server_id
    WHERE m.user_id = ?
    ORDER BY s.name COLLATE NOCASE ASC, se.name COLLATE NOCASE ASC
  `).all(req.user.id);
  const servers = [], byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.id)) { const s = { id: r.id, name: r.server_name, emoji: [] }; byId.set(r.id, s); servers.push(s); }
    byId.get(r.id).emoji.push({ name: r.emoji_name, url: r.url });
  }
  res.json({ servers });
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
  const names = serverEmojiNames(m.server_id);
  // custom emojis from any server the user has joined are valid reactions
  for (const n of userCustomEmojiNames(req.user.id)) names.add(n);
  if (!validReaction(emoji, names)) return res.status(400).json({ error: 'bad_emoji' });
  const ex = db.prepare('SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(m.id, req.user.id, emoji);
  if (ex) db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(m.id, req.user.id, emoji);
  else db.prepare('INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,?)').run(m.id, req.user.id, emoji, now());
  broadcastToServer(m.server_id, { t: 'reaction-update', serverId: m.server_id, channelId: m.channel_id, messageId: m.id, reactions: reactionTally(m.id, null) });
  res.json({ reactions: reactionTally(m.id, req.user.id) });
});
// Detailed per-emoji reactor list (powers hover tooltips + the View-reactions
// modal). Stable order: earliest reaction first. Caps each emoji at 100
// users so a viral message can't blow up the payload.
function reactionUsersById(ids) {
  const map = new Map();
  const uniq = [...new Set(ids)];
  if (!uniq.length) return map;
  const ph = uniq.map(() => '?').join(',');
  try {
    for (const u of db.prepare(`SELECT ${USER_COLS} FROM users WHERE id IN (${ph})`).all(...uniq)) map.set(u.id, publicUser(u));
  } catch {}
  return map;
}
function detailedReactions(table, messageId, meId) {
  const rows = db.prepare(`SELECT emoji, user_id, created_at FROM ${table} WHERE message_id = ? ORDER BY created_at ASC`).all(messageId);
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.emoji)) groups.set(r.emoji, []);
    const arr = groups.get(r.emoji);
    if (arr.length < 100) arr.push(r.user_id);
  }
  const byId = reactionUsersById(rows.map((r) => r.user_id));
  const out = [];
  for (const [emoji, uids] of groups) {
    const users = uids.map((id) => byId.get(id) || { id, username: 'deleted', display_name: 'deleted user', avatar_color: '#555', avatar_url: null });
    out.push({ emoji, count: rows.filter((r) => r.emoji === emoji).length, me: uids.includes(meId) || rows.some((r) => r.emoji === emoji && r.user_id === meId), users });
  }
  return out;
}
app.get('/api/messages/:mid/reactions', authRequired, (req, res) => {
  const m = getMsg(req.params.mid);
  if (!m) return res.status(404).json({ error: 'no_message' });
  if (!isMember(m.server_id, req.user.id)) return res.status(403).json({ error: 'not_member' });
  res.json({ reactions: detailedReactions('message_reactions', m.id, req.user.id) });
});

// ---------- edit + fetch single message ----------
app.patch('/api/messages/:mid', authRequired, (req, res) => {
  const m = getMsg(req.params.mid);
  if (!m) return res.status(404).json({ error: 'no_message' });
  if (m.user_id !== req.user.id) return res.status(403).json({ error: 'only_your_own' });
  const content = squashBreaks(String(req.body?.content || '')).trim().slice(0, 5000);
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

// Active threads: threads the caller is part of (wrote the root or a reply)
// with reply activity in the last 4 days — quieter threads drop off.
// Powers the header Threads panel. Capped at 50, newest activity first.
app.get('/api/threads/active', authRequired, (req, res) => {
  const me = req.user.id;
  const cutoff = now() - 4 * 86400 * 1000;
  const q = String(req.query.q || '').trim().slice(0, 80);
  const pat = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  let nsfwOk = 0;
  try { nsfwOk = db.prepare('SELECT nsfw_ok FROM users WHERE id = ?').get(me)?.nsfw_ok ? 1 : 0; } catch {}
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT r.id AS root_id, MAX(a.created_at) AS last_activity, COUNT(a.id) AS reply_count
      FROM messages r
      JOIN messages a ON a.thread_root_id = r.id
      JOIN server_members sm ON sm.server_id = r.server_id AND sm.user_id = ?
      JOIN channels ch ON ch.id = r.channel_id
      JOIN servers s ON s.id = r.server_id
      WHERE r.thread_root_id IS NULL
        AND (r.user_id = ? OR EXISTS (SELECT 1 FROM messages m2 WHERE m2.thread_root_id = r.id AND m2.user_id = ?))
        AND NOT EXISTS (SELECT 1 FROM thread_unfollows u WHERE u.thread_root_id = r.id AND u.user_id = ?)
        ${q ? `AND (r.content LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m3 WHERE m3.thread_root_id = r.id AND m3.content LIKE ? ESCAPE '\\') OR ch.name LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')` : ''}
      GROUP BY r.id
      HAVING MAX(a.created_at) >= ?
      ORDER BY last_activity DESC
      LIMIT 50
    `).all(...(q ? [me, me, me, me, pat, pat, pat, pat, cutoff] : [me, me, me, me, cutoff]));
  } catch { rows = []; }
  const snip = (m) => {
    const t = String(m?.content || '').trim();
    if (t) return t.slice(0, 140);
    const n = (m?.attachments || []).length;
    if (n) return n === 1 ? 'sent an attachment' : `sent ${n} attachments`;
    if (m?.poll) return 'sent a poll';
    return '';
  };
  const out = [];
  for (const row of rows) {
    const root = fullMessage(row.root_id, me);
    if (!root) continue;
    try {
      const ch = db.prepare('SELECT nsfw FROM channels WHERE id = ?').get(root.channelId);
      if (ch && ch.nsfw && !nsfwOk) continue; // same 18+ rule as history/search
    } catch {}
    let serverName = '', channelName = '';
    try { serverName = db.prepare('SELECT name FROM servers WHERE id = ?').get(root.serverId)?.name || ''; } catch {}
    try { channelName = db.prepare('SELECT name FROM channels WHERE id = ?').get(root.channelId)?.name || ''; } catch {}
    let lastRow = null;
    try {
      lastRow = db.prepare(`
        SELECT m.*, u.username, u.display_name, u.avatar_color, u.avatar_url,
               p.content AS p_content, pu.display_name AS p_name
        FROM messages m LEFT JOIN users u ON u.id = m.user_id
        LEFT JOIN messages p ON p.id = m.reply_to_id
        LEFT JOIN users pu ON pu.id = p.user_id
        WHERE m.thread_root_id = ? ORDER BY m.created_at DESC LIMIT 1
      `).get(row.root_id);
    } catch {}
    const last = lastRow ? hydrateMessages([lastRow], me)[0] : null;
    let parts = [];
    try {
      parts = db.prepare(`
        SELECT u.display_name d, u.username u, u.avatar_color c, u.avatar_url a, MAX(m.created_at) t
        FROM messages m JOIN users u ON u.id = m.user_id
        WHERE (m.id = ? OR m.thread_root_id = ?) AND m.user_id IS NOT NULL
        GROUP BY m.user_id ORDER BY t DESC LIMIT 4
      `).all(row.root_id, row.root_id).map((p) => ({ name: p.d || p.u || '?', color: p.c || null, avatar: p.a || null }));
    } catch {}
    out.push({
      rootId: row.root_id, serverId: root.serverId, serverName, channelId: root.channelId, channelName,
      replyCount: row.reply_count, lastActivity: row.last_activity,
      root: { author: root.user ? (root.user.display_name || root.user.username) : '?', snippet: snip(root), createdAt: root.created_at },
      last: last ? { author: last.user ? (last.user.display_name || last.user.username) : '?', snippet: snip(last), createdAt: last.created_at } : null,
      participants: parts,
    });
  }
  res.json({ threads: out });
});

// Unfollow a thread: hides it from your Active threads list.
// Posting in the thread again re-follows it automatically.
app.post('/api/threads/:rootId/unfollow', authRequired, (req, res) => {
  const root = db.prepare('SELECT server_id FROM messages WHERE id = ? AND thread_root_id IS NULL').get(req.params.rootId);
  if (!root || !isMember(root.server_id, req.user.id)) return res.status(404).json({ error: 'no_thread' });
  db.prepare('INSERT OR IGNORE INTO thread_unfollows (thread_root_id, user_id, created_at) VALUES (?,?,?)').run(req.params.rootId, req.user.id, now());
  res.json({ ok: true });
});
app.delete('/api/threads/:rootId/unfollow', authRequired, (req, res) => {
  db.prepare('DELETE FROM thread_unfollows WHERE thread_root_id = ? AND user_id = ?').run(req.params.rootId, req.user.id);
  res.json({ ok: true });
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
// Does the user have a live socket with their page visible/focused? Only then do
// we suppress the OS push (so backgrounded/closed mobile apps still get pings).
function userVisible(uid) {
  for (const c of clients) if (c.meta && c.meta.userId === uid && c.meta.visible) return true;
  return false;
}
function dmThreadFor(userId, threadId) {
  if (!threadId) return null;
  const t = db.prepare('SELECT * FROM dm_threads WHERE id = ?').get(threadId);
  if (!t) return null;
  return db.prepare('SELECT 1 FROM dm_members WHERE thread_id = ? AND user_id = ?').get(threadId, userId) ? t : null;
}
function dmThreadView(t, userId) {
  const members = db.prepare(`SELECT ${USER_COLS} FROM users WHERE id IN (SELECT user_id FROM dm_members WHERE thread_id = ?)`).all(t.id).map(publicUser);
  const last = db.prepare('SELECT m.content, m.created_at, u.display_name AS dname FROM dm_messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.thread_id = ? ORDER BY m.created_at DESC LIMIT 1').get(t.id);
  let pinned = false;
  if (userId) {
    try { pinned = !!db.prepare('SELECT pinned FROM dm_members WHERE thread_id = ? AND user_id = ?').get(t.id, userId)?.pinned; } catch {}
  }
  return {
    id: t.id, name: t.name, isGroup: !!t.is_group, created_by: t.created_by || null, created_at: t.created_at, members,
    pinned,
    last: last ? { content: last.content, created_at: last.created_at, author: last.dname || '?' } : null,
  };
}
function dmNotify(threadId, obj) {
  const mems = db.prepare('SELECT user_id FROM dm_members WHERE thread_id = ?').all(threadId).map((r) => r.user_id);
  for (const uid of mems) notifyUser(uid, obj);
}
// Fully erase a DM thread and everything in it. Called whenever a thread is
// left with zero members (last leave or remove) — explicit deletes so
// no messages/attachments/reactions/pins dangle even if FK cascades lag.
function deleteDmThread(threadId) {
  deletePollsFor('dm', db.prepare('SELECT id FROM dm_messages WHERE thread_id = ?').all(threadId).map((r) => r.id));
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
function displayOf(u) { return (u && (u.display_name || u.username)) || 'Someone'; }
// Collapse blank-line spam (3+ newlines -> 2) so walls of empty lines can't flood chat/bios.
function squashBreaks(s) { return String(s || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n'); }

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
      console.error('[push]', uid, (err && (err.statusCode || err.message)) || 'error');
    });
  }
}
function mentionsName(content, username) {
  try {
    return new RegExp('(^|[\\s(])@' + String(username).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(String(content || ''));
  } catch { return false; }
}
function unreadNotifs(uid) {
  try { return db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read_at IS NULL').get(uid).c; } catch { return 0; }
}
function pushInbox(userId, n) {
  try {
    db.prepare('INSERT INTO notifications (id,user_id,kind,title,body,server_id,channel_id,message_id,thread_id,created_at,read_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(uid(), userId, n.kind || 'mention', String(n.title || '').slice(0, 120), String(n.body || '').slice(0, 300), n.server_id || null, n.channel_id || null, n.message_id || null, n.thread_id || null, now(), null);
    db.prepare('DELETE FROM notifications WHERE user_id = ? AND id NOT IN (SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 200)').run(userId, userId);
    notifyUser(userId, { t: 'notif-new', unread: unreadNotifs(userId) });
  } catch {}
}
app.get('/api/notifs/inbox', authRequired, (req, res) => {
  const items = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 60').all(req.user.id);
  res.json({ items, unread: unreadNotifs(req.user.id) });
});
app.put('/api/notifs/read', authRequired, (req, res) => {
  if (req.body?.all) db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), req.user.id);
  else if (Array.isArray(req.body?.ids) && req.body.ids.length) {
    const ids = req.body.ids.slice(0, 100).map(String);
    db.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`).run(now(), req.user.id, ...ids);
  }
  res.json({ unread: unreadNotifs(req.user.id) });
});
app.delete('/api/notifs/:id', authRequired, (req, res) => {
  const id = String(req.params.id || '');
  try { db.prepare('DELETE FROM notifications WHERE user_id = ? AND id = ?').run(req.user.id, id); } catch {}
  res.json({ unread: unreadNotifs(req.user.id) });
});
function notifyServerMessage(serverId, channelId, author, content, messageId) {
  const text = String(content || '').trim();
  if (!text) return;
  let mems = [];
  try { mems = db.prepare('SELECT user_id FROM server_members WHERE server_id = ? AND user_id != ?').all(serverId, author.userId).map((r) => r.user_id); } catch { return; }
  if (!mems.length) return;
  const cands = mems;
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
    const isMention = mentionsName(text, names.get(uid));
    if (mode === 'mentions' && !isMention) continue;
    const title = `#${(ch && ch.name) || 'chat'} · ${s ? s.name : ''}`;
    const body = `${displayOf(author)}: ${text}`.slice(0, 160);
    // Notification center is for mentions + major events only — plain new
    // messages never land in the inbox, even on 'All messages' (that scope
    // still controls the OS/push ping below).
    if (isMention) pushInbox(uid, { kind: 'mention', title, body, server_id: serverId, channel_id: channelId, message_id: messageId || null });
    if (userVisible(uid)) continue;
    pushToUser(uid, {
      title,
      body,
      icon: author.avatar_url || '/icons/icon-192.png',
      tag: `ch:${channelId}`,
      url: `/?server=${serverId}&channel=${channelId}`,
    });
  }
}
function notifyDmMessage(thread, author, content, messageId) {
  const text = String(content || '').trim();
  if (!text) return;
  let mems = [];
  try { mems = db.prepare('SELECT user_id FROM dm_members WHERE thread_id = ? AND user_id != ?').all(thread.id, author.userId).map((r) => r.user_id); } catch { return; }
  for (const uid of mems) {
    if (notifMode(uid, [`dm:${thread.id}`, 'global']) === 'muted') continue;
    const title = thread.is_group ? (thread.name || 'Group chat') : `${displayOf(author)} (DM)`;
    const body = thread.is_group ? `${displayOf(author)}: ${text}`.slice(0, 160) : text.slice(0, 160);
    // DMs stay out of the notification inbox (mentions + major events only) —
    // visible tabs badge via dm-new, hidden/closed devices still get a push below.
    if (userVisible(uid)) continue;
    pushToUser(uid, {
      title,
      body,
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
  const attBy = {}, reactBy = {}, parentAttBy = {};
  const pollBy = pollsForMessages('dm', ids);
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    for (const a of db.prepare(`SELECT * FROM dm_attachments WHERE message_id IN (${ph}) ORDER BY created_at ASC`).all(...ids)) {
      (attBy[a.message_id] = attBy[a.message_id] || []).push({ url: a.url, name: a.filename, mime: a.mime, size: a.size, kind: a.kind, spoiler: !!a.spoiler });
    }
    for (const r of db.prepare(`SELECT message_id, emoji, user_id FROM dm_reactions WHERE message_id IN (${ph})`).all(...ids)) {
      const t = (reactBy[r.message_id] = reactBy[r.message_id] || {});
      const e = (t[r.emoji] = t[r.emoji] || { emoji: r.emoji, count: 0, users: [] });
      e.count++; e.users.push(r.user_id);
    }
    const parentIds = [...new Set(rows.filter((r) => r.reply_to_id && !String(r.p_content || '').trim()).map((r) => r.reply_to_id))];
    if (parentIds.length) {
      const pph = parentIds.map(() => '?').join(',');
      for (const a of db.prepare(`SELECT message_id FROM dm_attachments WHERE message_id IN (${pph})`).all(...parentIds)) {
        parentAttBy[a.message_id] = (parentAttBy[a.message_id] || 0) + 1;
      }
    }
  }
  return patchAttachmentSnippets(rows.map((r) => ({
    id: r.id, threadId: r.thread_id, content: r.content, created_at: r.created_at,
    sys: r.sys || null,
    fwdFrom: r.fwd_from || null,
    replyTo: r.reply_to_id ? (r.p_content != null ? { id: r.reply_to_id, author: r.p_name || 'deleted', snippet: String(r.p_content).slice(0, 140) } : { id: r.reply_to_id, author: 'deleted', snippet: '', deleted: true }) : null,
    threadCount: 0, edited: !!r.edited_at, _dm: true,
    attachments: attBy[r.id] || [],
    poll: pollBy[r.id] || null,
    reactions: Object.values(reactBy[r.id] || {}).map((t) => ({ emoji: t.emoji, count: t.count, me: t.users.includes(meId), users: t.users })),
    user: r.user_id ? publicUser({ id: r.user_id, username: r.username, display_name: r.display_name, avatar_color: r.avatar_color, avatar_url: r.avatar_url }) : null,
  })), parentAttBy);
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
      spoiler: a?.spoiler ? 1 : 0,
    });
  }
  return out;
}
// ---------- polls (single-choice, live-tallying) ----------
function normalizePollOptions(v) {
  const raw = Array.isArray(v?.options) ? v.options : [];
  const labels = [...new Set(raw.map((s) => String(s || '').trim().slice(0, 60)).filter(Boolean))].slice(0, 8);
  return labels.length >= 2 ? labels : null;
}
function createPoll(kind, ctx, messageId, userId, question, labels) {
  const pid = uid();
  db.transaction(() => {
    db.prepare('INSERT INTO polls (id,kind,server_id,channel_id,thread_id,message_id,question,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(pid, kind, ctx.serverId || null, ctx.channelId || null, ctx.threadId || null, messageId, String(question).slice(0, 200), userId, now());
    const ins = db.prepare('INSERT INTO poll_options (id,poll_id,label,position) VALUES (?,?,?,?)');
    labels.forEach((l, i) => ins.run(uid(), pid, l, i));
  })();
  return pid;
}
function assemblePoll(p, opts, votes) {
  const byOpt = {};
  for (const o of opts) byOpt[o.id] = { id: o.id, label: o.label, votes: 0, voters: [] };
  for (const v of votes) if (byOpt[v.option_id]) { byOpt[v.option_id].votes++; byOpt[v.option_id].voters.push(v.user_id); }
  return { id: p.id, question: p.question, createdBy: p.created_by, createdAt: p.created_at, total: votes.length, options: opts.map((o) => byOpt[o.id]) };
}
// Batched: one poll payload per message id (messages without polls cost one shared query).
function pollsForMessages(kind, ids) {
  const out = {};
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  const polls = db.prepare(`SELECT * FROM polls WHERE kind = ? AND message_id IN (${ph})`).all(kind, ...ids);
  if (!polls.length) return out;
  const pids = polls.map((p) => p.id);
  const pph = pids.map(() => '?').join(',');
  const opts = db.prepare(`SELECT * FROM poll_options WHERE poll_id IN (${pph}) ORDER BY position ASC`).all(...pids);
  const votes = db.prepare(`SELECT poll_id, option_id, user_id FROM poll_votes WHERE poll_id IN (${pph})`).all(...pids);
  for (const p of polls) {
    out[p.message_id] = assemblePoll(p, opts.filter((o) => o.poll_id === p.id), votes.filter((v) => v.poll_id === p.id));
  }
  return out;
}
function deletePollsFor(kind, messageIds) {
  if (!messageIds.length) return;
  const ph = messageIds.map(() => '?').join(',');
  const pids = db.prepare(`SELECT id FROM polls WHERE kind = ? AND message_id IN (${ph})`).all(kind, ...messageIds).map((r) => r.id);
  if (!pids.length) return;
  const pph = pids.map(() => '?').join(',');
  db.prepare(`DELETE FROM poll_votes WHERE poll_id IN (${pph})`).run(...pids);
  db.prepare(`DELETE FROM poll_options WHERE poll_id IN (${pph})`).run(...pids);
  db.prepare(`DELETE FROM polls WHERE id IN (${pph})`).run(...pids);
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
  pushInbox(target.id, { kind: 'friend', title: 'Friend request', body: `${displayOf(req.user)} sent you a friend request` });
  res.json({ ok: true });
});
app.post('/api/friends/:oid/accept', authRequired, (req, res) => {
  const f = friendRow(req.user.id, req.params.oid);
  if (!f || f.status !== 'pending' || f.action_by === req.user.id) return res.status(404).json({ error: 'no_request' });
  if (db.prepare('SELECT 1 FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)').get(req.user.id, req.params.oid, req.params.oid, req.user.id)) return res.status(404).json({ error: 'no_request' });
  db.prepare('UPDATE friendships SET status = ? WHERE user_a = ? AND user_b = ?').run('accepted', f.user_a, f.user_b);
  notifyUser(req.params.oid, { t: 'friends-changed' });
  notifyUser(req.user.id, { t: 'friends-changed' });
  pushInbox(req.params.oid, { kind: 'friend', title: 'Friend request accepted', body: `${displayOf(req.user)} accepted your friend request` });
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
app.post('/api/push/test', authRequired, (req, res) => {
  pushToUser(req.user.id, { title: 'Campfire', body: 'Test push — delivery works!', tag: 'campfire-test', url: '/' });
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
    if (!t) continue;
    const v = dmThreadView(t, req.user.id);
    try { v.callCount = (voiceRooms.get(dmVoiceKey(id)) || new Set()).size; } catch { v.callCount = 0; }
    out.push(v);
  }
  res.json({ threads: out });
});
app.post('/api/dms', authRequired, (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(String(req.body?.userId || ''));
  if (!target || target.id === req.user.id) return res.status(404).json({ error: 'user_not_found' });
  // No friendship required for 1:1 DMs — but blocks still apply both ways.
  if (db.prepare('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?').get(target.id, req.user.id)) return res.status(404).json({ error: 'user_not_found' });
  if (db.prepare('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?').get(req.user.id, target.id)) return res.status(403).json({ error: 'unblock_first' });
  const mine = db.prepare('SELECT thread_id FROM dm_members WHERE user_id = ?').all(req.user.id).map((r) => r.thread_id);
  for (const tid of mine) {
    const t = db.prepare('SELECT * FROM dm_threads WHERE id = ? AND (is_group IS NULL OR is_group = 0)').get(tid);
    if (!t) continue;
    const mems = db.prepare('SELECT user_id FROM dm_members WHERE thread_id = ?').all(tid).map((r) => r.user_id);
    if (mems.length === 2 && mems.includes(target.id)) {
      db.prepare('UPDATE dm_members SET hidden = 0 WHERE thread_id = ? AND user_id = ?').run(tid, req.user.id);
      notifyUser(req.user.id, { t: 'dm-threads-changed' });
      return res.json({ thread: dmThreadView(t, req.user.id) });
    }
  }
  const id = uid();
  db.transaction(() => {
    db.prepare('INSERT INTO dm_threads (id,name,is_group,created_by,created_at) VALUES (?,?,?,?,?)').run(id, '', 0, req.user.id, now());
    db.prepare('INSERT INTO dm_members (thread_id,user_id,joined_at) VALUES (?,?,?)').run(id, req.user.id, now());
    db.prepare('INSERT INTO dm_members (thread_id,user_id,joined_at) VALUES (?,?,?)').run(id, target.id, now());
  })();
  notifyUser(target.id, { t: 'dm-threads-changed' });
  notifyUser(req.user.id, { t: 'dm-threads-changed' });
  res.json({ thread: dmThreadView(db.prepare('SELECT * FROM dm_threads WHERE id = ?').get(id), req.user.id) });
});
// Group chats fit 9 friends + creator (GROUP_MAX total).
const GROUP_MAX = 10;
app.post('/api/dms/group', authRequired, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40) || 'Group chat';
  const ids = [...new Set((req.body?.userIds || []).map(String))].filter((v) => v !== req.user.id);
  if (ids.length > GROUP_MAX - 1) return res.status(400).json({ error: 'group_full' });
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
  notifyUser(req.user.id, { t: 'dm-threads-changed' });
  res.json({ thread: dmThreadView(db.prepare('SELECT * FROM dm_threads WHERE id = ?').get(id), req.user.id) });
});
app.post('/api/dms/:tid/members', authRequired, (req, res) => {
  const t = dmThreadFor(req.user.id, req.params.tid);
  if (!t) return res.status(404).json({ error: 'no_thread' });
  const oid = String(req.body?.userId || '');
  if (oid === req.user.id || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(oid)) return res.status(404).json({ error: 'user_not_found' });
  if (!areFriends(req.user.id, oid)) return res.status(403).json({ error: 'add_friend_first' });
  if (db.prepare('SELECT 1 FROM dm_members WHERE thread_id = ? AND user_id = ?').get(t.id, oid)) return res.json({ ok: true });
  if (db.prepare('SELECT COUNT(*) c FROM dm_members WHERE thread_id = ?').get(t.id).c >= GROUP_MAX) return res.status(400).json({ error: 'group_full' });
  db.prepare('INSERT OR IGNORE INTO dm_members (thread_id,user_id,joined_at) VALUES (?,?,?)').run(t.id, oid, now());
  if (!t.is_group) db.prepare('UPDATE dm_threads SET is_group = 1 WHERE id = ?').run(t.id);
  dmNotify(t.id, { t: 'dm-threads-changed' });
  res.json({ ok: true });
});
app.post('/api/dms/:tid/leave', authRequired, (req, res) => {
  const t = dmThreadFor(req.user.id, req.params.tid);
  if (!t) return res.status(404).json({ error: 'no_thread' });
  // Direct (1:1) DMs can't be left — leaving is groups-only.
  if (!t.is_group) return res.status(400).json({ error: 'not_group' });
  db.prepare('DELETE FROM dm_members WHERE thread_id = ? AND user_id = ?').run(t.id, req.user.id);
  evictFromDmCall(t.id, req.user.id);
  postDmSys(t.id, `${displayOf(req.user)} left ${t.is_group ? 'the group' : 'the chat'}`);
  dmNotify(t.id, { t: 'dm-threads-changed' });
  // dmNotify no longer reaches the leaver (membership already deleted) —
  // tell their other devices directly so no stale room lingers anywhere.
  notifyUser(req.user.id, { t: 'dm-threads-changed' });
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
  notifyUser(req.user.id, { t: 'dm-threads-changed' });
  res.json({ thread: dmThreadView(t, req.user.id) });
});

// Pin a DM / group chat to the top of your list (per-user; syncs to all your
// devices via dm-threads-changed). Pinning also unhides a dismissed chat.
app.post('/api/dms/:tid/pin', authRequired, (req, res) => {
  const t = dmThreadFor(req.user.id, req.params.tid);
  if (!t) return res.status(404).json({ error: 'no_thread' });
  db.prepare('UPDATE dm_members SET pinned = 1, hidden = 0 WHERE thread_id = ? AND user_id = ?').run(t.id, req.user.id);
  notifyUser(req.user.id, { t: 'dm-threads-changed' });
  res.json({ ok: true });
});
app.post('/api/dms/:tid/unpin', authRequired, (req, res) => {
  const t = dmThreadFor(req.user.id, req.params.tid);
  if (!t) return res.status(404).json({ error: 'no_thread' });
  db.prepare('UPDATE dm_members SET pinned = 0 WHERE thread_id = ? AND user_id = ?').run(t.id, req.user.id);
  notifyUser(req.user.id, { t: 'dm-threads-changed' });
  res.json({ ok: true });
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
  evictFromDmCall(t.id, target);
  postDmSys(t.id, `${displayOf(u)} was removed`);
  dmNotify(t.id, { t: 'dm-threads-changed' });
  notifyUser(target, { t: 'removed-from-dm', threadId: t.id });
  maybeDeleteEmptyDmThread(t.id);
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
  const content = squashBreaks(String(req.body?.content || '')).trim().slice(0, 5000);
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
  deletePollsFor('dm', [m.id]);
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
  // same rules as channel reactions; DMs have no server, so any custom
  // emoji from a server the user has joined is valid
  if (!validReaction(emoji, userCustomEmojiNames(req.user.id))) return res.status(400).json({ error: 'bad_emoji' });
  const ex = db.prepare('SELECT 1 FROM dm_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(m.id, req.user.id, emoji);
  if (ex) db.prepare('DELETE FROM dm_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(m.id, req.user.id, emoji);
  else db.prepare('INSERT INTO dm_reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,?)').run(m.id, req.user.id, emoji, now());
  const tally = db.prepare('SELECT emoji, user_id FROM dm_reactions WHERE message_id = ?').all(m.id);
  const t = {};
  for (const r of tally) { const e = (t[r.emoji] = t[r.emoji] || { emoji: r.emoji, count: 0, users: [] }); e.count++; e.users.push(r.user_id); }
  const out = Object.values(t);
  dmNotify(m.thread_id, { t: 'dm-reaction', threadId: m.thread_id, messageId: m.id, reactions: out });
  res.json({ reactions: out.map((e) => ({ emoji: e.emoji, count: e.count, me: e.users.includes(req.user.id), users: e.users })) });
});
app.get('/api/dms/messages/:mid/reactions', authRequired, (req, res) => {
  const m = dmMsg(req.params.mid);
  if (!m || !dmThreadFor(req.user.id, m.thread_id)) return res.status(404).json({ error: 'no_message' });
  res.json({ reactions: detailedReactions('dm_reactions', m.id, req.user.id) });
});
// ---------- polls: vote (single choice per user; tap again to retract) ----------
app.post('/api/polls/:id/vote', authRequired, (req, res) => {
  const p = db.prepare('SELECT * FROM polls WHERE id = ?').get(String(req.params.id || ''));
  if (!p) return res.status(404).json({ error: 'no_poll' });
  if (p.kind === 'server') {
    if (!isMember(p.server_id, req.user.id)) return res.status(403).json({ error: 'not_member' });
  } else if (!dmThreadFor(req.user.id, p.thread_id)) return res.status(403).json({ error: 'not_member' });
  const opt = db.prepare('SELECT * FROM poll_options WHERE id = ? AND poll_id = ?').get(String(req.body?.optionId || ''), p.id);
  if (!opt) return res.status(400).json({ error: 'bad_option' });
  const cur = db.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?').get(p.id, req.user.id);
  if (cur && cur.option_id === opt.id) db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?').run(p.id, req.user.id);
  else db.prepare('INSERT OR REPLACE INTO poll_votes (poll_id,option_id,user_id,created_at) VALUES (?,?,?,?)').run(p.id, opt.id, req.user.id, now());
  // Push the refreshed tally through the normal message-update fanout.
  if (p.kind === 'server') {
    broadcastToServer(p.server_id, { t: 'message-updated', serverId: p.server_id, channelId: p.channel_id, message: fullMessage(p.message_id, req.user.id) });
  } else {
    dmNotify(p.thread_id, { t: 'dm-updated', message: fullDm(p.message_id, req.user.id) });
  }
  res.json({ ok: true });
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

// ---------- GIF favorites (per-user, synced across devices) ----------
// Klipy slugs can contain uppercase letters (e.g. 'goatplaybanjo-chat-4--ksp3BOGTL')
const GIF_FAV_SLUG_RE = /^[a-z0-9_-]{1,80}$/i;
const isHttpUrl = (u) => /^https?:\/\//i.test(String(u || ''));
app.get('/api/me/gif-favorites', authRequired, (req, res) => {
  res.json({ favorites: db.prepare(
    `SELECT slug, title, thumb, gif, mp4, created_at
     FROM gif_favorites WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`
  ).all(req.user.id) });
});
app.post('/api/me/gif-favorites', authRequired, (req, res) => {
  const b = req.body || {};
  const slug = String(b.slug || '').trim();
  const gif = String(b.gif || '').trim();
  if (!GIF_FAV_SLUG_RE.test(slug) || !isHttpUrl(gif)) return res.status(400).json({ error: 'bad_favorite' });
  const title = String(b.title || '').trim().slice(0, 120);
  const thumb = isHttpUrl(b.thumb) ? String(b.thumb) : gif;
  const mp4 = isHttpUrl(b.mp4) ? String(b.mp4) : null;
  db.prepare(
    `INSERT OR REPLACE INTO gif_favorites (user_id, slug, title, thumb, gif, mp4, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(req.user.id, slug, title, thumb, gif, mp4, now());
  res.json({ slug, title, thumb, gif, mp4, created_at: now() });
});
app.delete('/api/me/gif-favorites/:slug', authRequired, (req, res) => {
  const slug = String(req.params.slug || '').trim();
  if (!GIF_FAV_SLUG_RE.test(slug)) return res.status(400).json({ error: 'bad_favorite' });
  db.prepare(`DELETE FROM gif_favorites WHERE user_id = ? AND slug = ?`).run(req.user.id, slug);
  res.json({ ok: true });
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
    replyTo: r.reply_to_id ? (r.p_content != null ? { id: r.reply_to_id, author: r.p_name || 'deleted', snippet: String(r.p_content).slice(0, 140) } : { id: r.reply_to_id, author: 'deleted', snippet: '', deleted: true }) : null,
    threadRoot: r.thread_root_id || null,
    sys: r.sys || null,
    fwdFrom: r.fwd_from || null,
    threadCount: 0, edited: !!r.edited_at,
    attachments: [], reactions: [],
    user: r.user_id ? publicUser({ id: r.user_id, username: r.username, display_name: r.display_name, avatar_color: r.avatar_color, avatar_url: r.avatar_url }) : null,
  };
}
// Batch-load attachments, reaction tallies, and reply counts for a page of messages.
// Reply quotes on attachment-only parents read 'sent an attachment' instead
// of rendering an empty quote. Both hydrates batch-load parent attachment
// counts and run their output through this.
function patchAttachmentSnippets(out, parentAttBy) {
  for (const m of out) {
    if (m.replyTo && !m.replyTo.deleted && !String(m.replyTo.snippet || '').trim()) {
      const n = parentAttBy[m.replyTo.id] || 0;
      if (n > 0) m.replyTo.snippet = n === 1 ? 'sent an attachment' : `sent ${n} attachments`;
    }
  }
  return out;
}
function hydrateMessages(rows, meId) {
  const ids = rows.map((r) => r.id);
  const attBy = {}, reactBy = {}, countBy = {}, parentAttBy = {};
  const pollBy = pollsForMessages('server', ids);
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    for (const a of db.prepare(`SELECT * FROM attachments WHERE message_id IN (${ph}) ORDER BY created_at ASC`).all(...ids)) {
      (attBy[a.message_id] = attBy[a.message_id] || []).push({ url: a.url, name: a.filename, mime: a.mime, size: a.size, kind: a.kind, spoiler: !!a.spoiler });
    }
    for (const r of db.prepare(`SELECT message_id, emoji, user_id FROM message_reactions WHERE message_id IN (${ph})`).all(...ids)) {
      const t = (reactBy[r.message_id] = reactBy[r.message_id] || {});
      const e = (t[r.emoji] = t[r.emoji] || { emoji: r.emoji, count: 0, users: [] });
      e.count++; e.users.push(r.user_id);
    }
    for (const c of db.prepare(`SELECT thread_root_id r, COUNT(*) c FROM messages WHERE thread_root_id IN (${ph}) GROUP BY thread_root_id`).all(...ids)) {
      countBy[c.r] = c.c;
    }
    const parentIds = [...new Set(rows.filter((r) => r.reply_to_id && !String(r.p_content || '').trim()).map((r) => r.reply_to_id))];
    if (parentIds.length) {
      const pph = parentIds.map(() => '?').join(',');
      for (const a of db.prepare(`SELECT message_id FROM attachments WHERE message_id IN (${pph})`).all(...parentIds)) {
        parentAttBy[a.message_id] = (parentAttBy[a.message_id] || 0) + 1;
      }
    }
  }
  return patchAttachmentSnippets(rows.map((r) => {
    const m = fmtMsg(r);
    m.attachments = attBy[r.id] || [];
    m.poll = pollBy[r.id] || null;
    const tally = Object.values(reactBy[r.id] || {});
    m.reactions = tally.map((t) => ({ emoji: t.emoji, count: t.count, me: t.users.includes(meId), users: t.users }));
    m.threadCount = countBy[r.id] || 0;
    return m;
  }), parentAttBy);
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

/** ws.meta = { userId, username, display_name, avatar_color, servers:Set, voice:{kind:'server'|'dm',serverId,channelId,threadId,muted,...}|null } */
const clients = new Set();
const voiceRooms = new Map(); // key `${serverId}:${channelId}` (servers) or `dm:${threadId}` (DM calls) -> Set<ws>

function safeSend(ws, obj) {
  if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} }
}
function broadcastToServer(serverId, obj, except) {
  for (const ws of clients) {
    if (ws.meta && ws.meta.servers.has(serverId) && ws !== except) safeSend(ws, obj);
  }
}
function voiceKey(s, c) { return s + ':' + c; }
function dmVoiceKey(tid) { return 'dm:' + tid; }
function voiceKeyOf(v) { return v.kind === 'dm' ? dmVoiceKey(v.threadId) : voiceKey(v.serverId, v.channelId); }
function voicePeersPayload(key) {
  const set = voiceRooms.get(key) || new Set();
  return [...set].map((ws) => ({
    id: ws.meta.userId,
    username: ws.meta.username,
    display_name: ws.meta.display_name,
    avatar_color: ws.meta.avatar_color,
    active_tag: ws.meta.active_tag || null,
    avatar_url: ws.meta.avatar_url || null,
    muted: !!(ws.meta.voice && ws.meta.voice.muted),
    speaking: !!(ws.meta.voice && ws.meta.voice.speaking),
    deafened: !!(ws.meta.voice && ws.meta.voice.deafened),
    camera: !!(ws.meta.voice && ws.meta.voice.camera),
    sharing: !!(ws.meta.voice && ws.meta.voice.sharing),
    serverMuted: !!(ws.meta.voice && ws.meta.voice.serverMuted),
    streamName: (ws.meta.voice && ws.meta.voice.streamName) || null,
  }));
}
function findWsInVoice(key, userId) {
  for (const ws of voiceRooms.get(key) || []) {
    if (ws.meta.userId === userId) return ws;
  }
  return null;
}
// Streaming presence: while a user shares (Go Live), their profile carries
// streaming_game so friends see a purple Streaming status + Active Now entry.
// Only writes + broadcasts on actual change (voice-state fires constantly).
function syncStreaming(ws) {
  const me = ws && ws.meta;
  if (!me) return;
  const v = me.voice;
  const now = v && v.sharing ? (v.streamName || 'Screen') : null;
  if (me.streaming === now) return;
  me.streaming = now;
  try { db.prepare('UPDATE users SET streaming_game = ? WHERE id = ?').run(now, me.userId); } catch {}
  const u2 = freshUser(me.userId);
  if (u2 && u2.id) broadcastUserUpdate(u2);
}
function leaveVoice(ws, notify = true) {
  const v = ws.meta && ws.meta.voice;
  if (!v) return;
  const key = voiceKeyOf(v);
  const set = voiceRooms.get(key);
  if (set) {
    set.delete(ws);
    if (set.size === 0) voiceRooms.delete(key);
  }
  ws.meta.voice = null;
  syncStreaming(ws);
  if (!notify) return;
  if (v.kind === 'dm') {
    dmNotify(v.threadId, { t: 'voice-peer-left', threadId: v.threadId, userId: ws.meta.userId });
    afterDmVoiceChange(v.threadId);
    return;
  }
  broadcastToServer(v.serverId, { t: 'voice-peer-left', serverId: v.serverId, channelId: v.channelId, userId: ws.meta.userId });
  // send updated list to remaining occupants… and to the leaver too,
  // otherwise their own sidebar keeps showing them until a refresh
  const peers = voicePeersPayload(key);
  for (const other of voiceRooms.get(key) || []) safeSend(other, { t: 'voice-peers', serverId: v.serverId, channelId: v.channelId, peers });
  safeSend(ws, { t: 'voice-peers', serverId: v.serverId, channelId: v.channelId, peers });
}
// Push fresh DM-call occupancy to every thread member (drives in-call
// badges + join buttons). When the room drains, the call is over.
function afterDmVoiceChange(threadId) {
  const key = dmVoiceKey(threadId);
  const peers = voicePeersPayload(key);
  const mems = new Set(db.prepare('SELECT user_id FROM dm_members WHERE thread_id = ?').all(threadId).map((r) => r.user_id));
  for (const c of clients) {
    if (c.meta && mems.has(c.meta.userId)) safeSend(c, { t: 'voice-peers', threadId, peers });
  }
  if (!peers.length) {
    voiceRooms.delete(key);
    for (const c of clients) {
      if (c.meta && mems.has(c.meta.userId)) safeSend(c, { t: 'dm-call-ended', threadId });
    }
  }
}
// Pull one user out of a DM call (group remove/ban/leave). Their client
// drops its peer connections via voice-kicked, like server voice eviction.
function evictFromDmCall(threadId, userId) {
  const key = dmVoiceKey(threadId);
  const set = voiceRooms.get(key);
  if (!set) return;
  for (const c of [...set]) {
    if (c.meta && c.meta.userId === userId) {
      set.delete(c);
      c.meta.voice = null;
      syncStreaming(c);
      safeSend(c, { t: 'voice-kicked', threadId });
    }
  }
  afterDmVoiceChange(threadId);
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true; // protocol-level heartbeat (see interval below)
  ws.on('pong', () => { ws.isAlive = true; });
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token') || '';
  let p;
  try { p = jwt.verify(token, JWT_SECRET); } catch { ws.close(4401, 'bad token'); return; }
  const u = db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(p.sub);
  if (!u) { ws.close(4401, 'no user'); return; }
  if (u.disabled) { ws.close(4401, 'disabled'); return; }
  if ((p.iat || 0) * 1000 < (u.token_valid_after || 0) - 2000) { ws.close(4401, 'bad token'); return; }
  if (p.sid) {
    const s = db.prepare('SELECT id,user_id,revoked FROM sessions WHERE id = ?').get(p.sid);
    if (!s || s.user_id !== u.id || s.revoked) { ws.close(4401, 'bad token'); return; }
  }
  const memberRows = db.prepare('SELECT server_id FROM server_members WHERE user_id = ?').all(u.id);
  ws.meta = {
    userId: u.id, username: u.username, display_name: u.display_name, avatar_color: u.avatar_color,
    active_tag: u.active_tag || null,
    avatar_url: u.avatar_url || null, status: u.status || 'online', sid: p.sid || null,
    servers: new Set(memberRows.map((r) => r.server_id)),
    voice: null,
    streaming: null,
    visible: true,
  };
  clients.add(ws);
  safeSend(ws, { t: 'hello', user: publicUser(u), version: APP_VERSION });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const me = ws.meta;
    if (!me) return;

    if (msg.t === 'visibility') { me.visible = msg.visible !== false; return; }
    if (msg.t === 'ping') { safeSend(ws, { t: 'pong' }); return; } // client liveness probe

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
        if (key.startsWith('dm:')) continue;
        const [srv] = key.split(':');
        if (me.servers.has(srv)) {
          const [, ch] = key.split(':');
          safeSend(ws, { t: 'voice-peers', serverId: srv, channelId: ch, peers: voicePeersPayload(key) });
        }
      }
      // …and for my DM calls (drives in-call badges after reloads)
      for (const [key, set] of voiceRooms) {
        if (!key.startsWith('dm:')) continue;
        const tid = key.slice(3);
        if (dmThreadFor(me.userId, tid)) safeSend(ws, { t: 'voice-peers', threadId: tid, peers: voicePeersPayload(key) });
      }
      return;
    }

    if (msg.t === 'message') {
      const serverId = String(msg.serverId || '');
      const channelId = String(msg.channelId || '');
      const content = squashBreaks(String(msg.content || '')).trim().slice(0, 5000);
      const replyTo = String(msg.replyTo || '') || null;
      let threadRoot = String(msg.threadRoot || '') || null;
      const atts = Array.isArray(msg.attachments) ? msg.attachments.slice(0, 5) : [];
      const pollOpts = normalizePollOptions(msg.poll);
      if ((!content && !atts.length && !pollOpts) || !serverId || !channelId) return;
      if (!me.servers.has(serverId) || !isMember(serverId, me.userId)) return;
      const ch = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(channelId, serverId);
      if (!ch || ch.type !== 'text') return;
      if (!rateOk(me.userId)) { safeSend(ws, { t: 'error', error: 'slow_down' }); return; }
      if (ch.slowmode > 0 && !isAdmin(serverId, me.userId)) {
        const wait = slowBlocked(channelId, me.userId, ch.slowmode);
        if (wait > 0) { safeSend(ws, { t: 'error', error: 'slow_mode', retryAfter: wait }); return; }
      }
      if (replyTo) {
        const pr = db.prepare('SELECT channel_id FROM messages WHERE id = ? AND server_id = ?').get(replyTo, serverId);
        if (!pr || pr.channel_id !== channelId) return;
      }
      if (threadRoot) {
        const rr = db.prepare('SELECT channel_id, thread_root_id FROM messages WHERE id = ? AND server_id = ?').get(threadRoot, serverId);
        if (!rr || rr.channel_id !== channelId) return;
        // Threads are 1 level deep: a reply-to-a-reply lands on the ultimate root.
        if (rr.thread_root_id) threadRoot = rr.thread_root_id;
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
        cleanAtts.push({ url, name: String(a?.name || 'file').slice(0, 120), mime, size: Math.max(0, Math.min(parseInt(a?.size || 0, 10) || 0, 100 * 1024 * 1024)), kind, spoiler: a?.spoiler ? 1 : 0 });
      }
      if (!content && !cleanAtts.length && !pollOpts) return;
      const mid = uid();
      const fwdFrom = String(msg.fwdFrom || '').trim().slice(0, 64) || null;
      db.prepare('INSERT INTO messages (id,server_id,channel_id,user_id,content,reply_to_id,thread_root_id,fwd_from,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(mid, serverId, channelId, me.userId, content, replyTo, threadRoot, fwdFrom, now());
      // Posting in a thread re-follows it (undoes an unfollow from the Threads panel).
      if (threadRoot) { try { db.prepare('DELETE FROM thread_unfollows WHERE thread_root_id = ? AND user_id = ?').run(threadRoot, me.userId); } catch {} }
      const insAtt = db.prepare('INSERT INTO attachments (id,message_id,url,filename,mime,size,kind,spoiler,created_at) VALUES (?,?,?,?,?,?,?,?,?)');
      for (const a of cleanAtts) insAtt.run(uid(), mid, a.url, a.name, a.mime, a.size, a.kind, a.spoiler || 0, now());
      if (pollOpts) {
        if (!content) return; // a poll needs its question as the message text
        createPoll('server', { serverId, channelId }, mid, me.userId, content, pollOpts);
      }
      const full = fullMessage(mid, null);
      broadcastToServer(serverId, { t: 'message-new', serverId, channelId, message: full });
      notifyServerMessage(serverId, channelId, me, content, mid);
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
      const content = squashBreaks(String(msg.content || '')).trim().slice(0, 5000);
      const replyTo = String(msg.replyTo || '') || null;
      const cleanAtts = cleanAttachments(msg.attachments);
      const pollOpts = normalizePollOptions(msg.poll);
      if (!content && !cleanAtts.length && !pollOpts) return;
      if (!rateOk(me.userId)) { safeSend(ws, { t: 'error', error: 'slow_down' }); return; }
      if (replyTo && !db.prepare('SELECT id FROM dm_messages WHERE id = ? AND thread_id = ?').get(replyTo, threadId)) return;
      const mid = uid();
      const fwdFrom = String(msg.fwdFrom || '').trim().slice(0, 64) || null;
      db.prepare('INSERT INTO dm_messages (id,thread_id,user_id,content,reply_to_id,fwd_from,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(mid, threadId, me.userId, content, replyTo, fwdFrom, now());
      db.prepare('UPDATE dm_members SET hidden = 0 WHERE thread_id = ?').run(threadId);
      const insAtt = db.prepare('INSERT INTO dm_attachments (id,message_id,url,filename,mime,size,kind,spoiler,created_at) VALUES (?,?,?,?,?,?,?,?,?)');
      for (const a of cleanAtts) insAtt.run(uid(), mid, a.url, a.name, a.mime, a.size, a.kind, a.spoiler || 0, now());
      if (pollOpts) {
        if (!content) return; // a poll needs its question as the message text
        createPoll('dm', { threadId }, mid, me.userId, content, pollOpts);
      }
      dmNotify(threadId, { t: 'dm-new', message: fullDm(mid, null) });
      notifyDmMessage(t, me, content, mid);
      return;
    }

    if (msg.t === 'dm-typing') {
      const t = dmThreadFor(me.userId, String(msg.threadId || ''));
      if (!t) return;
      const mems = db.prepare('SELECT user_id FROM dm_members WHERE thread_id = ? AND user_id != ?').all(t.id, me.userId).map((r) => r.user_id);
      for (const uid of mems) notifyUser(uid, { t: 'dm-typing', threadId: t.id, userId: me.userId, display_name: me.display_name });
      return;
    }

    if (msg.t === 'voice-join' && msg.threadId) {
      // DM call (1:1 or group): the thread itself is the room.
      const threadId = String(msg.threadId || '');
      const t = dmThreadFor(me.userId, threadId);
      if (!t) return;
      if (me.voice) leaveVoice(ws);
      me.voice = { kind: 'dm', threadId, muted: false, deafened: false, camera: false, sharing: false };
      const key = dmVoiceKey(threadId);
      const wasEmpty = !(voiceRooms.get(key) && voiceRooms.get(key).size);
      if (!voiceRooms.has(key)) voiceRooms.set(key, new Set());
      voiceRooms.get(key).add(ws);
      const peers = voicePeersPayload(key);
      safeSend(ws, { t: 'voice-peers', threadId, peers });
      const others = db.prepare('SELECT user_id FROM dm_members WHERE thread_id = ? AND user_id != ?').all(threadId, me.userId).map((r) => r.user_id);
      const mePeer = { id: me.userId, username: me.username, display_name: me.display_name, avatar_color: me.avatar_color, active_tag: me.active_tag || null, avatar_url: me.avatar_url || null, muted: false, speaking: false, deafened: false, camera: false, sharing: false, serverMuted: false, streamName: null };
      for (const uid of others) {
        notifyUser(uid, { t: 'voice-peer-joined', threadId, peer: mePeer });
        notifyUser(uid, { t: 'voice-peers', threadId, peers });
      }
      // First one in rings everyone else (caller info drives the incoming banner).
      if (wasEmpty) {
        for (const uid of others) {
          notifyUser(uid, { t: 'dm-call-incoming', threadId, video: !!msg.video,
            caller: { id: me.userId, username: me.username, display_name: me.display_name, avatar_color: me.avatar_color, active_tag: me.active_tag || null, avatar_url: me.avatar_url || null } });
        }
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
      me.voice = { kind: 'server', serverId, channelId, muted: false, deafened: false, camera: false, sharing: false };
      const key = voiceKey(serverId, channelId);
      if (!voiceRooms.has(key)) voiceRooms.set(key, new Set());
      voiceRooms.get(key).add(ws);
      // tell joiner full peer list
      safeSend(ws, { t: 'voice-peers', serverId, channelId, peers: voicePeersPayload(key) });
      // tell others someone joined
      broadcastToServer(serverId, {
        t: 'voice-peer-joined', serverId, channelId,
        peer: { id: me.userId, username: me.username, display_name: me.display_name, avatar_color: me.avatar_color, active_tag: me.active_tag || null, avatar_url: me.avatar_url || null, muted: false, speaking: false, deafened: false, camera: false, sharing: false, serverMuted: false, streamName: null },
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
      me.voice.streamName = typeof msg.streamName === 'string' ? (msg.streamName.slice(0, 60) || null) : null;
      if (!me.voice.sharing) me.voice.streamName = null;
      if (typeof msg.speaking === 'boolean') me.voice.speaking = msg.speaking;
      if (me.voice.muted || me.voice.deafened) me.voice.speaking = false;
      syncStreaming(ws);
      if (me.voice.kind === 'dm') {
        dmNotify(me.voice.threadId, {
          t: 'voice-state', threadId: me.voice.threadId,
          userId: me.userId, muted: me.voice.muted, speaking: !!me.voice.speaking,
          deafened: me.voice.deafened, camera: me.voice.camera, sharing: me.voice.sharing,
          serverMuted: !!me.voice.serverMuted, streamName: me.voice.streamName,
        });
        return;
      }
      broadcastToServer(me.voice.serverId, {
        t: 'voice-state', serverId: me.voice.serverId, channelId: me.voice.channelId,
        userId: me.userId, muted: me.voice.muted, speaking: !!me.voice.speaking,
        deafened: me.voice.deafened, camera: me.voice.camera, sharing: me.voice.sharing,
        serverMuted: !!me.voice.serverMuted, streamName: me.voice.streamName,
      });
      return;
    }

    // Voice moderation: server/channel admins (or a group-call creator) can
    // server-mute/unmute or disconnect someone from a voice room. The target's
    // client enforces the mute (and can't self-unmute until cleared).
    if (msg.t === 'voice-mod') {
      const targetId = String(msg.targetId || '');
      const action = msg.action; // 'mute' | 'unmute' | 'disconnect'
      if (!targetId || !['mute', 'unmute', 'disconnect'].includes(action) || targetId === me.userId) return;
      const modTargets = (key) => [...(voiceRooms.get(key) || [])].filter((c) => c.meta && c.meta.userId === targetId);
      const modStateOf = (c) => ({
        muted: !!c.meta.voice.muted, speaking: false,
        deafened: !!c.meta.voice.deafened, camera: !!c.meta.voice.camera, sharing: !!c.meta.voice.sharing,
        serverMuted: !!c.meta.voice.serverMuted, streamName: c.meta.voice.streamName || null,
      });
      if (msg.threadId) {
        const threadId = String(msg.threadId || '');
        const t = dmThreadFor(me.userId, threadId);
        if (!t || t.created_by !== me.userId) return;
        const key = dmVoiceKey(threadId);
        const targets = modTargets(key);
        if (!targets.length) return;
        if (action === 'disconnect') {
          for (const c of targets) {
            voiceRooms.get(key).delete(c);
            c.meta.voice = null;
            syncStreaming(c);
            safeSend(c, { t: 'voice-kicked', threadId, reason: 'mod' });
          }
          afterDmVoiceChange(threadId);
          return;
        }
        for (const c of targets) {
          if (action === 'mute') { c.meta.voice.muted = true; c.meta.voice.serverMuted = true; c.meta.voice.speaking = false; }
          else { c.meta.voice.serverMuted = false; }
          safeSend(c, { t: 'voice-mod', threadId, action: action === 'mute' ? 'muted' : 'unmuted' });
        }
        dmNotify(threadId, { t: 'voice-state', threadId, userId: targetId, ...modStateOf(targets[0]) });
        return;
      }
      const serverId = String(msg.serverId || '');
      const channelId = String(msg.channelId || '');
      if (!serverId || !channelId || !isMember(serverId, me.userId) || !isAdmin(serverId, me.userId)) return;
      const key = voiceKey(serverId, channelId);
      const targets = modTargets(key);
      if (!targets.length) return;
      if (action === 'disconnect') {
        for (const c of targets) {
          voiceRooms.get(key).delete(c);
          c.meta.voice = null;
          syncStreaming(c);
          safeSend(c, { t: 'voice-kicked', serverId, channelId, reason: 'mod' });
        }
        broadcastToServer(serverId, { t: 'voice-peer-left', serverId, channelId, userId: targetId });
        const peers = voicePeersPayload(key);
        broadcastToServer(serverId, { t: 'voice-peers', serverId, channelId, peers });
        return;
      }
      for (const c of targets) {
        if (action === 'mute') { c.meta.voice.muted = true; c.meta.voice.serverMuted = true; c.meta.voice.speaking = false; }
        else { c.meta.voice.serverMuted = false; }
        safeSend(c, { t: 'voice-mod', serverId, channelId, action: action === 'mute' ? 'muted' : 'unmuted' });
      }
      broadcastToServer(serverId, { t: 'voice-state', serverId, channelId, userId: targetId, ...modStateOf(targets[0]) });
      return;
    }

    if (msg.t === 'voice-signal') {
      if (!me.voice) return;
      const key = voiceKeyOf(me.voice);
      const target = findWsInVoice(key, String(msg.to || ''));
      if (!target) return;
      const out = { t: 'voice-signal', from: me.userId, data: msg.data };
      if (me.voice.kind === 'dm') out.threadId = me.voice.threadId;
      else { out.serverId = me.voice.serverId; out.channelId = me.voice.channelId; }
      safeSend(target, out);
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

// Protocol-level heartbeat: browsers auto-answer ping with pong, so a socket
// whose TCP died silently (phone sleep, pulled cable, dead NAT binding)
// stops responding and gets terminated here — the client sees onclose and
// runs its normal reconnect + full-screen connecting overlay flow instead
// of sitting on a stale, half-open socket that looks alive but is dead.
const wsHeartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);
try { wsHeartbeat.unref(); } catch {}

// SPA fallback (after API + static)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'), { headers: { 'Cache-Control': 'no-store' } });
});

// Clear stale playing_game on startup (watchers will re-beacon within 30s)
db.prepare('UPDATE users SET playing_game = NULL WHERE playing_game IS NOT NULL').run();
// Streaming never survives a restart (voice rooms don't either).
try { db.prepare('UPDATE users SET streaming_game = NULL WHERE streaming_game IS NOT NULL').run(); } catch {}
// Expired custom statuses clear within a minute (reads mask them instantly).
sweepExpiredStatuses();
setInterval(sweepExpiredStatuses, 60 * 1000);

// Watcher stale-beacon cleanup: no heartbeat for 90s (3 missed 30s beats)
// means the watcher died without a goodbye — assume stopped playing.
setInterval(() => {
  const stale = Date.now() - BEACON_STALE_MS;
  for (const [userId, beacon] of lastBeacon.entries()) {
    if (beacon.ts < stale && beacon.game) {
      db.prepare('UPDATE users SET playing_game = NULL WHERE id = ?').run(userId);
      lastBeacon.set(userId, { ts: Date.now(), game: null });
      const u2 = freshUser(userId);
      if (u2 && u2.id) broadcastUserUpdate(u2);
    }
  }
}, 30 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[campfire] listening on :${PORT}  db=${process.env.DB_PATH || 'data/campfire.db'}`);
});
