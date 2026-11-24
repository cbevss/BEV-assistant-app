-- BEV Accounts. Memories are end-to-end encrypted: `vaults.data` and
-- `items.ct` are ciphertext (and wrapped keys) the server cannot read.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  avatar TEXT,
  created_at INTEGER NOT NULL
);

-- Sign-in in progress: the browser is at Discord.
CREATE TABLE IF NOT EXISTS pending_logins (
  id TEXT PRIMARY KEY,
  redirect TEXT NOT NULL,
  app_state TEXT NOT NULL,
  challenge TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- One-time codes handed back to the app after Discord approved (PKCE-bound).
CREATE TABLE IF NOT EXISTS login_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  challenge TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Signed-in devices. Only a hash of each token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- The user's data key, wrapped by their passphrase and by their recovery key.
CREATE TABLE IF NOT EXISTS vaults (
  user_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Encrypted records (memories, notes, profile). `id` is an opaque hash chosen
-- by the client, so the server doesn't learn memory names either.
CREATE TABLE IF NOT EXISTS items (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  seq INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  iv TEXT NOT NULL DEFAULT '',
  ct TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS items_seq ON items(user_id, seq);

-- Per-user change counter: each write gets the next number, so a device can
-- ask for "everything after N".
CREATE TABLE IF NOT EXISTS counters (
  user_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL
);

-- Phone control: messages between the user's phone and their PC, encrypted
-- on the devices with a key derived from the account's data key. The server
-- only relays ciphertext. dir is 'to_pc' or 'to_phone'; big marks screenshots.
CREATE TABLE IF NOT EXISTS phone_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  dir TEXT NOT NULL,
  iv TEXT NOT NULL,
  ct TEXT NOT NULL,
  big INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS phone_messages_user ON phone_messages(user_id, dir, id);

-- When the user's PC last checked for phone messages (shown on the phone).
CREATE TABLE IF NOT EXISTS phone_presence (
  user_id TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL
);

-- Live screen: the newest encrypted frame of the user's screen (one row per
-- user, overwritten), and until when the phone wants frames.
CREATE TABLE IF NOT EXISTS phone_frames (
  user_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  iv TEXT NOT NULL,
  ct TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS phone_live (
  user_id TEXT PRIMARY KEY,
  until INTEGER NOT NULL,
  display TEXT NOT NULL DEFAULT 'current'
);

-- Live screen as real video (WebRTC): the PC and phone swap their connection details here.
-- Sealed with the phone key like everything else, so the server can't read or change them.
CREATE TABLE IF NOT EXISTS phone_rtc (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  to_side TEXT NOT NULL,
  iv TEXT NOT NULL,
  ct TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS phone_rtc_user ON phone_rtc (user_id, to_side, id);
