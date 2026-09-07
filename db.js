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
addColumn('servers', 'icon_url', 'TEXT');
addColumn('messages', 'reply_to_id', 'TEXT');
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
`);

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
