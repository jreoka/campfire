// Postgres via node-postgres (pg). Async API mirroring the old SQLite wrapper:
//   (await db.prepare(sql).get(...args)) -> row object | undefined
//   (await db.prepare(sql).all(...args)) -> row objects []
//   (await db.prepare(sql).run(...args)) -> { changes }
//   await db.exec(sql)                  (multi-statement, no params)
//   await db.transaction(async () => {...})  (single connection via ALS)
// Placeholders: both `?` (positional) and `@name` (single object arg) are
// accepted and translated to $1, $2, ... Quoted string literals are left
// alone. All former INTEGER columns are BIGINT, parsed back to JS numbers.
const { Pool, types } = require('pg');
const { AsyncLocalStorage } = require('node:async_hooks');

types.setTypeParser(20, (v) => (v === null || v === undefined ? null : parseInt(v, 10))); // int8 -> number

// Connection: DATABASE_URL wins; otherwise libpq-style PG* parts (the same
// names pg_dump reads, so backup.js reuses pgEnv() verbatim).
function pgEnv() {
  return {
    PGHOST: process.env.PGHOST || 'localhost',
    PGPORT: process.env.PGPORT || '5432',
    PGDATABASE: process.env.PGDATABASE || 'campfire',
    PGUSER: process.env.PGUSER || 'campfire',
    PGPASSWORD: process.env.PGPASSWORD || '',
  };
}
function poolConfig() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  const e = pgEnv();
  return { host: e.PGHOST, port: parseInt(e.PGPORT, 10) || 5432, database: e.PGDATABASE, user: e.PGUSER, password: e.PGPASSWORD };
}
const pool = new Pool({ ...poolConfig(), max: parseInt(process.env.PG_POOL_MAX || '10', 10) || 10 });
pool.on('error', (e) => console.error('[pg] pool error:', (e && e.message) || e));

// The instance owner's account. Single source of truth: the boot-time
// auto-admin below and server.js's "other admins may not touch this account"
// guard both key off this username.
const OWNER_USERNAME = 'jreoka';

// Active transaction client (if any) — db.transaction() pins one connection
// here so every query inside the callback shares it.
const als = new AsyncLocalStorage();
const runner = () => als.getStore() || pool;

// Rewrite `?` / `@name` placeholders to $n, skipping 'quoted literals'.
// Returns { text, names } where names[i] is the @name for $i+1 or null.
function translate(sql) {
  let out = '';
  let n = 0;
  const names = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2;
          else break;
        } else j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '?') {
      n++;
      out += '$' + n;
      names.push(null);
      i++;
      continue;
    }
    if (ch === '@') {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1));
      if (m) {
        n++;
        out += '$' + n;
        names.push(m[0]);
        i += 1 + m[0].length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return { text: out, names };
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v);
}

function bindParams(names, args) {
  const named = names.filter((x) => x !== null);
  if (named.length) {
    if (names.some((x) => x === null)) throw new Error('mixed ? and @name placeholders');
    const obj = args.length === 1 && isObj(args[0]) ? args[0] : {};
    return names.map((x) => obj[x]);
  }
  return args;
}

const db = {
  exec: async (sql) => {
    await runner().query(sql);
  },
  prepare: (sql) => {
    const { text, names } = translate(sql);
    return {
      get: async (...args) => {
        const { rows } = await runner().query(text, bindParams(names, args));
        const r = rows[0];
        return r === undefined ? undefined : { ...r };
      },
      all: async (...args) => {
        const { rows } = await runner().query(text, bindParams(names, args));
        return rows.map((r) => ({ ...r }));
      },
      run: async (...args) => {
        const res = await runner().query(text, bindParams(names, args));
        return { changes: res.rowCount ?? 0 };
      },
    };
  },
  transaction: async (fn, ...args) => {
    if (als.getStore()) return fn(...args); // nested: join the outer tx
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await als.run(client, () => fn(...args));
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      client.release();
    }
  },
};

// ---------- schema (CREATE TABLE IF NOT EXISTS + guarded migrations) ----------
// INTEGER affinity from the SQLite era is BIGINT here (parsed to numbers
// above); flag columns stay 0/1 ints so `=== 0` checks keep working.
async function columnExists(table, col) {
  const r = await pool.query(
    'SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2',
    [table, col]
  );
  return r.rowCount > 0;
}
async function addColumn(table, col, def) {
  if (!(await columnExists(table, col))) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

async function initDb() {
  await db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_color TEXT NOT NULL DEFAULT '#5865f2',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS server_members (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at BIGINT NOT NULL,
  PRIMARY KEY (server_id, user_id)
);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text','voice')),
  position BIGINT NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id, position);
CREATE INDEX IF NOT EXISTS idx_members_user ON server_members(user_id);
`);

  // ---------- guarded migrations (never wipe data; additive only) ----------
  await addColumn('users', 'status', "TEXT NOT NULL DEFAULT 'online'");
  await addColumn('users', 'status_text', "TEXT NOT NULL DEFAULT ''");
  await addColumn('users', 'status_expires_at', 'BIGINT');
  await addColumn('users', 'presence_expires_at', 'BIGINT');
  await addColumn('users', 'avatar_url', 'TEXT');
  await addColumn('users', 'streaming_game', 'TEXT');
  await addColumn('users', 'banner_url', 'TEXT');
  await addColumn('users', 'sidebar_banner_url', 'TEXT');
  await addColumn('servers', 'icon_url', 'TEXT');
  await addColumn('servers', 'tag', 'TEXT');
  await addColumn('servers', 'tag_emoji', 'TEXT');
  await addColumn('users', 'active_tag_server_id', 'TEXT');
  await addColumn('users', 'active_tag', 'TEXT');
  await addColumn('messages', 'reply_to_id', 'TEXT');
  await addColumn('messages', 'sys', 'TEXT');
  await addColumn('messages', 'thread_root_id', 'TEXT');
  await addColumn('messages', 'edited_at', 'BIGINT');
  await db.exec(`
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size BIGINT NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'file',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS custom_emoji (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (server_id, name)
);
CREATE INDEX IF NOT EXISTS idx_reactions_msg ON message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_msg ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_root_id);
CREATE TABLE IF NOT EXISTS thread_unfollows (
  thread_root_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (thread_root_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_thread_unfollows_user ON thread_unfollows(user_id);
CREATE TABLE IF NOT EXISTS media_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('avatar','banner')),
  url TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_history_user ON media_history(user_id, kind, created_at);
CREATE TABLE IF NOT EXISTS friendships (
  user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted')),
  action_by TEXT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);
CREATE TABLE IF NOT EXISTS dm_threads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  is_group BIGINT NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS dm_members (
  thread_id TEXT NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at BIGINT NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);
CREATE TABLE IF NOT EXISTS dm_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  reply_to_id TEXT,
  edited_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS dm_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size BIGINT NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'file',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS dm_reactions (
  message_id TEXT NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_dm_messages_thread ON dm_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dm_members_user ON dm_members(user_id);
CREATE TABLE IF NOT EXISTS server_folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#5865f2',
  position BIGINT NOT NULL DEFAULT 0,
  open BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS server_bans (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  PRIMARY KEY (server_id, user_id)
);
-- Legacy, unused: group-chat bans were removed (groups use remove-only).
-- Kept so databases upgrade in place; no code reads/writes it.
CREATE TABLE IF NOT EXISTS dm_bans (
  thread_id TEXT NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);
CREATE TABLE IF NOT EXISTS message_pins (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL PRIMARY KEY,
  pinned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS dm_pins (
  thread_id TEXT NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL PRIMARY KEY,
  pinned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL
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
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS poll_options (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  position BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (poll_id, user_id) -- single choice: one vote per user per poll
);
CREATE TABLE IF NOT EXISTS server_invites (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  code TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT,
  max_uses BIGINT,
  uses BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invites_server ON server_invites(server_id);
-- Resolved game artwork (Steam capsule URLs + curated overrides), keyed by
-- normalized lowercase game name. url NULL = looked up, nothing confident found.
CREATE TABLE IF NOT EXISTS game_icons (
  game TEXT PRIMARY KEY,
  url TEXT,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS blocks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, blocked_id),
  CHECK (user_id != blocked_id)
);
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '',
  hoist BIGINT NOT NULL DEFAULT 0,
  admin BIGINT NOT NULL DEFAULT 0,
  position BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
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
  created_at BIGINT NOT NULL,
  PRIMARY KEY (endpoint)
);
CREATE TABLE IF NOT EXISTS notif_prefs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('all','mentions','muted')),
  PRIMARY KEY (user_id, scope)
);
-- Which pins this account has already looked at, per conversation (the pin
-- button's "new" badge). Mirrored server-side so the memory follows the
-- account across devices; the client keeps localStorage as its paint cache.
-- ctx is the client's conversation key: 's:<serverId>:<channelId>' / 'd:<threadId>'.
CREATE TABLE IF NOT EXISTS pin_seen (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ctx TEXT NOT NULL,
  ids TEXT NOT NULL DEFAULT '[]',
  at BIGINT NOT NULL,
  PRIMARY KEY (user_id, ctx)
);
`);
  await addColumn('dm_messages', 'sys', 'TEXT');
  await addColumn('dm_members', 'hidden', 'BIGINT NOT NULL DEFAULT 0');
  await addColumn('dm_members', 'pinned', 'BIGINT NOT NULL DEFAULT 0');
  await addColumn('messages', 'fwd_from', 'TEXT');
  await addColumn('dm_messages', 'fwd_from', 'TEXT');
  await addColumn('channels', 'slowmode', 'BIGINT NOT NULL DEFAULT 0');
  await addColumn('channels', 'nsfw', 'BIGINT NOT NULL DEFAULT 0');
  await addColumn('channels', 'description', "TEXT NOT NULL DEFAULT ''");
  await addColumn('servers', 'banner_url', 'TEXT');
  await addColumn('servers', 'description', "TEXT NOT NULL DEFAULT ''");
  await addColumn('users', 'name_color', "TEXT NOT NULL DEFAULT ''");
  await addColumn('users', 'name_gradient', "TEXT NOT NULL DEFAULT ''");
  await addColumn('users', 'card_color', "TEXT NOT NULL DEFAULT ''");
  await addColumn('users', 'card_gradient', "TEXT NOT NULL DEFAULT ''");
  await addColumn('users', 'avatar_decoration', "TEXT NOT NULL DEFAULT ''");
  await addColumn('users', 'bio', "TEXT NOT NULL DEFAULT ''");
  await addColumn('users', 'totp_secret', 'TEXT');
  await addColumn('users', 'totp_enabled', 'BIGINT NOT NULL DEFAULT 0');
  await addColumn('users', 'token_valid_after', 'BIGINT NOT NULL DEFAULT 0');
  await db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  last_seen BIGINT NOT NULL,
  revoked BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS totp_backups (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  created_at BIGINT NOT NULL,
  last_used BIGINT NOT NULL DEFAULT 0
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
  created_at BIGINT NOT NULL,
  read_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_notifs_user ON notifications(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS gif_favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  thumb TEXT NOT NULL DEFAULT '',
  gif TEXT NOT NULL,
  mp4 TEXT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_gif_favorites_user ON gif_favorites(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS user_games (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game TEXT NOT NULL,
  total_ms BIGINT NOT NULL DEFAULT 0,
  first_seen_ms BIGINT,
  last_seen_ms BIGINT,
  PRIMARY KEY (user_id, game)
);
CREATE INDEX IF NOT EXISTS idx_user_games_user ON user_games(user_id);
CREATE TABLE IF NOT EXISTS game_days (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game TEXT NOT NULL,
  day TEXT NOT NULL,
  ms BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, game, day)
);
CREATE INDEX IF NOT EXISTS idx_game_days_user ON game_days(user_id, day);
`);
  await addColumn('users', 'playing_game', 'TEXT');
  await addColumn('users', 'game_enabled', 'BIGINT NOT NULL DEFAULT 1');
  await addColumn('users', 'game_exclusions', "TEXT NOT NULL DEFAULT '[]'");
  await addColumn('attachments', 'spoiler', 'BIGINT NOT NULL DEFAULT 0');
  await addColumn('dm_attachments', 'spoiler', 'BIGINT NOT NULL DEFAULT 0');
  await addColumn('server_members', 'position', 'BIGINT NOT NULL DEFAULT 0');
  await addColumn('server_members', 'folder_id', 'TEXT');
  await addColumn('users', 'is_admin', 'BIGINT NOT NULL DEFAULT 0');
  await addColumn('users', 'disabled', 'BIGINT NOT NULL DEFAULT 0');
  await addColumn('users', 'tz_offset', 'BIGINT');
  await addColumn('users', 'nsfw_ok', 'BIGINT NOT NULL DEFAULT 0');
  await addColumn('users', 'theme', "TEXT NOT NULL DEFAULT ''");
  await db.exec(`
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  token TEXT UNIQUE NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhooks_channel ON webhooks(channel_id);
-- Link previews (unfurl.js): one row per linked URL. id is a truncated
-- sha256 of url so long URLs can't overflow a btree key; ok is 0 for a
-- fetch that found nothing (negative-cached briefly, not forever).
CREATE TABLE IF NOT EXISTS link_embeds (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  ok BIGINT NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  fetched_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_link_embeds_fetched ON link_embeds(fetched_at);
-- Stories (Snapchat-style): one row per photo/video post that friends (or the
-- members of one server) can watch for 24 hours. The media itself is a normal
-- chat upload under files/, so the existing scan + compression pipeline
-- covers it; expiry deletes the row and the bytes. story_views powers the
-- seen/unseen ring and the viewer list on your own story.
CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  audience TEXT NOT NULL DEFAULT 'friends',
  server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'image/jpeg',
  kind TEXT NOT NULL DEFAULT 'image',
  caption TEXT NOT NULL DEFAULT '',
  duration_ms BIGINT NOT NULL DEFAULT 5000,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_user ON stories(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stories_server ON stories(server_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stories_expires ON stories(expires_at);
CREATE TABLE IF NOT EXISTS story_views (
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at BIGINT NOT NULL,
  PRIMARY KEY (story_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_story_views_story ON story_views(story_id);
-- Who each story is shared with, one row per audience. A post can target
-- several at once (friends + a couple of servers), so visibility is read from
-- here — the legacy stories.audience/server_id columns are backfilled below
-- and then left alone. kind: 'friends' | 'everyone' | 'server'.
CREATE TABLE IF NOT EXISTS story_audiences (
  id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_story_audiences_uniq ON story_audiences (story_id, kind, COALESCE(server_id, ''));
CREATE INDEX IF NOT EXISTS idx_story_audiences_server ON story_audiences (server_id);
`);
  // One-time backfill: stories posted before audiences were a list keep their
  // original single target. Idempotent (skips stories that already have rows).
  try {
    await db.exec(`
INSERT INTO story_audiences (id, story_id, kind, server_id, created_at)
SELECT 'legacy-' || s.id, s.id,
  CASE WHEN s.audience = 'server' THEN 'server' ELSE 'friends' END,
  CASE WHEN s.audience = 'server' THEN s.server_id ELSE NULL END,
  s.created_at
FROM stories s
WHERE (s.audience = 'server' OR s.audience = 'friends')
  AND NOT EXISTS (SELECT 1 FROM story_audiences a WHERE a.story_id = s.id)`);
  } catch (e) { console.warn('[db] story audience backfill skipped:', (e && e.message) || e); }
  // Individual-friend story shares reuse the audience rows with kind 'user'
  // (the audience picker can target specific friends instead of all of them).
  await addColumn('story_audiences', 'user_id', 'TEXT');
  // The old unique index keyed on (story, kind, server) would collapse several
  // individual recipients into one row; widen it to include the user.
  try {
    await db.exec('DROP INDEX IF EXISTS idx_story_audiences_uniq');
    await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_story_audiences_uniq ON story_audiences (story_id, kind, COALESCE(server_id, ''), COALESCE(user_id, ''))");
  } catch (e) { console.warn('[db] story audience index rebuild skipped:', (e && e.message) || e); }
  // A DM that answers a story carries the story id so clients can label it
  // (the media itself is copied into the DM at reply time).
  await addColumn('dm_messages', 'story_id', 'TEXT');
  // View-once messages: media that stays gated until the recipient opens it
  // (state: 'unopened' | 'replayable' | 'consumed'), with one replay allowed.
  // Unopened items never expire; the bytes go when the view is used up.
  await addColumn('dm_messages', 'view_once', 'BIGINT NOT NULL DEFAULT 0');
  await addColumn('dm_messages', 'view_once_state', "TEXT NOT NULL DEFAULT ''");
  await addColumn('dm_messages', 'view_once_replays', 'BIGINT NOT NULL DEFAULT 1');
  await addColumn('messages', 'webhook_id', 'TEXT');
  await addColumn('messages', 'webhook_name', 'TEXT');
  await addColumn('messages', 'webhook_avatar', 'TEXT');
  // Inbox entries that point at a report (kind 'report'): resolving the
  // report clears them, so no stale "new report" row outlives the case.
  await addColumn('notifications', 'report_id', 'TEXT');
  await db.exec(`
-- Message reports: any member who can read a message can flag it for the
-- site admins. The row keeps a snapshot (author, text, media, where) so the
-- report stays reviewable after the message or the author is gone — never
-- copy the bytes, just the reference. status: open | resolved | dismissed;
-- action records what the admin did. A partial unique index stops the same
-- person filing the same message twice while a report is still open.
CREATE TABLE IF NOT EXISTS message_reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'server',
  server_id TEXT,
  channel_id TEXT,
  thread_id TEXT,
  message_id TEXT NOT NULL,
  author_id TEXT,
  author_name TEXT NOT NULL DEFAULT '',
  author_username TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL DEFAULT '{}',
  reason TEXT NOT NULL DEFAULT 'other',
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  action TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON message_reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_message ON message_reports(message_id);
CREATE INDEX IF NOT EXISTS idx_reports_author ON message_reports(author_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_one_open ON message_reports(reporter_id, message_id) WHERE status = 'open';
`);
  // Site owner is always an admin (idempotent; runs on every boot so fresh
  // installs and existing databases both converge without manual SQL).
  try { await db.exec(`UPDATE users SET is_admin = 1 WHERE username = '${OWNER_USERNAME}'`); } catch {}
  // status_text cap lowered to 64: trim any legacy longer values (idempotent)
  try { await db.exec('UPDATE users SET status_text = substr(status_text, 1, 64) WHERE length(status_text) > 64'); } catch {}
}

async function closePool() {
  try { await pool.end(); } catch {}
}

module.exports = db;
module.exports.initDb = initDb;
module.exports.closePool = closePool;
module.exports.pgEnv = pgEnv;
module.exports.OWNER_USERNAME = OWNER_USERNAME;
