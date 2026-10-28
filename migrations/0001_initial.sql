PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS processes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL CHECK (state IN ('running', 'paused', 'stopped')),
  created_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  created_seq INTEGER NOT NULL,
  CHECK (
    (state = 'stopped' AND ended_at IS NOT NULL) OR
    (state IN ('running', 'paused') AND ended_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_processes_user_seq
  ON processes(user_id, created_seq DESC);
CREATE INDEX IF NOT EXISTS idx_processes_user_state
  ON processes(user_id, state);

CREATE TABLE IF NOT EXISTS intervals (
  id TEXT PRIMARY KEY,
  process_id TEXT NOT NULL REFERENCES processes(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_intervals_process
  ON intervals(process_id, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_interval_per_process
  ON intervals(process_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS user_state (
  user_id TEXT PRIMARY KEY,
  active_process_id TEXT,
  stack_json TEXT NOT NULL DEFAULT '[]',
  next_seq INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
