-- BEV Cloud schema. Safe to run repeatedly.
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('reminder', 'watch', 'check', 'briefing')),
  title TEXT NOT NULL,
  -- What to do / look for, in the user's words.
  instructions TEXT NOT NULL DEFAULT '',
  url TEXT,
  -- "daily 08:00", "every 30m", "weekly mon 09:00"…; NULL = once.
  repeat TEXT,
  next_run INTEGER,            -- epoch ms; NULL = not scheduled
  urgent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'paused')),
  -- 'cloud' runs here; 'pc' needs the desktop app (files, games, PC stats).
  runs_on TEXT NOT NULL DEFAULT 'cloud' CHECK (runs_on IN ('cloud', 'pc')),
  last_run INTEGER,
  last_result TEXT,
  snapshot_hash TEXT,
  snapshot TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_due ON tasks (status, next_run);

-- Recent Telegram conversation, so BEV remembers the thread.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Reports BEV sent (for briefings and "what did I miss?").
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  text TEXT NOT NULL,
  urgent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
