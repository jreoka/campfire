// SQLite via Node's built-in node:sqlite (no native deps, no build tools).
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'campfire.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const raw = new DatabaseSync(DB_PATH);
raw.exec('PRAGMA journal_mode = WAL');
raw.exec('PRAGMA foreign_keys = ON');

raw.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_color TEXT NOT NULL DEFAULT '#5865f2',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS server_members (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text','voice')),
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id, position);
CREATE INDEX IF NOT EXISTS idx_members_user ON server_members(user_id);
`);

// ---------- guarded migrations (never wipe data; additive only) ----------
function columnExists(table, col) {
  return raw.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}
function addColumn(table, col, def) {
  if (!columnExists(table, col)) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('users', 'status', "TEXT NOT NULL DEFAULT 'online'");
addColumn('users', 'status_text', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'avatar_url', 'TEXT');
addColumn('users', 'banner_url', 'TEXT');
addColumn('users', 'sidebar_banner_url', 'TEXT');
addColumn('servers', 'icon_url', 'TEXT');
addColumn('messages', 'reply_to_id', 'TEXT');
addColumn('messages', 'sys', 'TEXT');
addColumn('messages', 'thread_root_id', 'TEXT');
addColumn('messages', 'edited_at', 'INTEGER');
raw.exec(`
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'file',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS custom_emoji (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (server_id, name)
);
CREATE INDEX IF NOT EXISTS idx_reactions_msg ON message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_msg ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_root_id);
CREATE TABLE IF NOT EXISTS media_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('avatar','banner')),
  url TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_history_user ON media_history(user_id, kind, created_at);
CREATE TABLE IF NOT EXISTS friendships (
  user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted')),
  action_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);
CREATE TABLE IF NOT EXISTS dm_threads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  is_group INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dm_members (
  thread_id TEXT NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);
CREATE TABLE IF NOT EXISTS dm_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  reply_to_id TEXT,
  edited_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dm_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'file',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dm_reactions (
  message_id TEXT NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_dm_messages_thread ON dm_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dm_members_user ON dm_members(user_id);
CREATE TABLE IF NOT EXISTS server_folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#5865f2',
  position INTEGER NOT NULL DEFAULT 0,
  open INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS server_bans (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);
CREATE TABLE IF NOT EXISTS dm_bans (
  thread_id TEXT NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);
CREATE TABLE IF NOT EXISTS message_pins (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL PRIMARY KEY,
  pinned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dm_pins (
  thread_id TEXT NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL PRIMARY KEY,
  pinned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS polls (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL, -- 'server' | 'dm'
  server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES dm_threads(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  question TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS poll_options (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (poll_id, user_id) -- single choice: one vote per user per poll
);
CREATE TABLE IF NOT EXISTS blocks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, blocked_id),
  CHECK (user_id != blocked_id)
);
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '',
  hoist INTEGER NOT NULL DEFAULT 0,
  admin INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS member_roles (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (server_id, user_id, role_id)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (endpoint)
);
CREATE TABLE IF NOT EXISTS notif_prefs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('all','mentions','muted')),
  PRIMARY KEY (user_id, scope)
);
`);
addColumn('dm_messages', 'sys', 'TEXT');
addColumn('dm_members', 'hidden', 'INTEGER NOT NULL DEFAULT 0');
addColumn('messages', 'fwd_from', 'TEXT');
addColumn('dm_messages', 'fwd_from', 'TEXT');
addColumn('channels', 'slowmode', 'INTEGER NOT NULL DEFAULT 0');
addColumn('channels', 'description', "TEXT NOT NULL DEFAULT ''");
addColumn('servers', 'banner_url', 'TEXT');
addColumn('servers', 'description', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'name_color', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'name_gradient', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'bio', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'totp_secret', 'TEXT');
addColumn('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'token_valid_after', 'INTEGER NOT NULL DEFAULT 0');
// Gaming profile: playing_game is kept separate from status_text; user_games + game_days
// log playtime and per-day totals for levels/streaks on profiles.
raw.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS totp_backups (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'mention',
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  server_id TEXT,
  channel_id TEXT,
  message_id TEXT,
  thread_id TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notifs_user ON notifications(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS gif_favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  thumb TEXT NOT NULL DEFAULT '',
  gif TEXT NOT NULL,
  mp4 TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_gif_favorites_user ON gif_favorites(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS user_games (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game TEXT NOT NULL,
  total_ms INTEGER NOT NULL DEFAULT 0,
  first_seen_ms INTEGER,
  last_seen_ms INTEGER,
  PRIMARY KEY (user_id, game)
);
CREATE INDEX IF NOT EXISTS idx_user_games_user ON user_games(user_id);
CREATE TABLE IF NOT EXISTS game_days (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game TEXT NOT NULL,
  day TEXT NOT NULL,
  ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, game, day)
);
CREATE INDEX IF NOT EXISTS idx_game_days_user ON game_days(user_id, day);
`);
addColumn('users', 'playing_game', 'TEXT');
addColumn('users', 'game_enabled', 'INTEGER NOT NULL DEFAULT 1');
addColumn('users', 'game_exclusions', "TEXT NOT NULL DEFAULT '[]'");
addColumn('attachments', 'spoiler', 'INTEGER NOT NULL DEFAULT 0');
addColumn('dm_attachments', 'spoiler', 'INTEGER NOT NULL DEFAULT 0');
addColumn('server_members', 'position', 'INTEGER NOT NULL DEFAULT 0');
addColumn('server_members', 'folder_id', 'TEXT');
addColumn('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'disabled', 'INTEGER NOT NULL DEFAULT 0');
// Site owner is always an admin (idempotent; runs on every boot so fresh
// installs and existing databases both converge without manual SQL).
try { raw.exec("UPDATE users SET is_admin = 1 WHERE username = 'jreoka'"); } catch {}
// status_text cap lowered to 64: trim any legacy longer values (idempotent)
try { raw.exec('UPDATE users SET status_text = substr(status_text, 1, 64) WHERE length(status_text) > 64'); } catch {}

// Minimal better-sqlite3-compatible wrapper around DatabaseSync.
const db = {
  exec: (sql) => raw.exec(sql),
  prepare: (sql) => {
    const stmt = raw.prepare(sql);
    return {
      get: (...args) => {
        const r = stmt.get(...normalizeArgs(args));
        return r === undefined ? undefined : { ...r };
      },
      all: (...args) => (stmt.all(...normalizeArgs(args)) || []).map((r) => ({ ...r })),
      run: (...args) => stmt.run(...normalizeArgs(args)),
    };
  },
  transaction: (fn) => (...args) => {
    raw.exec('BEGIN');
    try {
      const out = fn(...args);
      raw.exec('COMMIT');
      return out;
    } catch (e) {
      try { raw.exec('ROLLBACK'); } catch {}
      throw e;
    }
  },
};

function normalizeArgs(args) {
  // better-sqlite3 allows run(obj) / get(a,b) — DatabaseSync accepts the same shapes.
  if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0]) && !Buffer.isBuffer(args[0])) {
    return [args[0]];
  }
  return args;
}

module.exports = db;
// Single source of truth for the database location (used for sibling paths like uploads).
module.exports.DB_PATH = DB_PATH;
