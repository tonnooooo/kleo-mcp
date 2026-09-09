-- Kleo MCP: initial schema (D1 / SQLite)
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  credits       INTEGER NOT NULL DEFAULT 0,
  plan          TEXT NOT NULL DEFAULT 'trial',
  invite_code   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at  TEXT
);

CREATE TABLE IF NOT EXISTS invites (
  code      TEXT PRIMARY KEY,
  credits   INTEGER NOT NULL DEFAULT 3,
  max_uses  INTEGER NOT NULL DEFAULT 1,
  uses      INTEGER NOT NULL DEFAULT 0,
  note      TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  template       TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  params         TEXT NOT NULL,              -- JSON: duration_s, format, language, voice
  state          TEXT NOT NULL,              -- queued|starting|rendering|finishing|done|failed|cancelled
  track          TEXT,                       -- script|voice|clips|edit|finishing
  percent        INTEGER NOT NULL DEFAULT 0,
  eta_min        INTEGER,
  credits        INTEGER NOT NULL,
  backend        TEXT,
  instance_id    TEXT,
  instance_meta  TEXT,
  worker_secret  TEXT NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  notify_email   TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at     TEXT,
  finished_at    TEXT,
  expires_at     TEXT,
  purged_at      TEXT,
  cost_usd       REAL
);
CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state);
CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id, created_at);

CREATE TABLE IF NOT EXISTS job_files (
  job_id        TEXT NOT NULL REFERENCES jobs(id),
  name          TEXT NOT NULL,
  key           TEXT NOT NULL,
  size          INTEGER NOT NULL DEFAULT 0,
  content_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
  PRIMARY KEY (job_id, name)
);

CREATE TABLE IF NOT EXISTS audit (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id  TEXT,
  job_id   TEXT,
  event    TEXT NOT NULL,
  detail   TEXT
);

-- Seed: one shared beta code (50 uses, 3 credits each). Add personal codes with:
--   npx wrangler d1 execute kleo-db --remote --command "INSERT INTO invites (code,credits,max_uses,note) VALUES ('CRISTIANO-1',5,1,'Cristiano')"
INSERT OR IGNORE INTO invites (code, credits, max_uses, note) VALUES ('KLEO-BETA', 3, 50, 'shared beta code');
