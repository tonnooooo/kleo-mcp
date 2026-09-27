-- 27 September 2026: LAUNCH CODES (src/launch.ts). A code posted on one channel unlocks ONE free film of at most
-- 15 seconds, even for an account that never paid, and records the channel for attribution.
--  · launch_codes: code, the channel it attributes to, max_uses (30), uses (counted inside the redeeming batch),
--    credits (NULL = the price of the trial film, read from the tariff at redemption), active (0 switches it off).
--  · redemptions: one row per account and never more (user_id is the PRIMARY KEY), whatever the code; `nonce` ties
--    the use and the credits to THIS insert; film_job is the one job that holds the trial film (a failed or
--    cancelled holder gives it back by itself).
-- Mirrors the entries in src/schema.ts STATEMENTS: the two must stay identical.
CREATE TABLE IF NOT EXISTS launch_codes (
  code       TEXT PRIMARY KEY,
  channel    TEXT NOT NULL,
  max_uses   INTEGER NOT NULL DEFAULT 30,
  uses       INTEGER NOT NULL DEFAULT 0,
  credits    INTEGER,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS redemptions (
  user_id  TEXT PRIMARY KEY,
  code     TEXT NOT NULL,
  channel  TEXT NOT NULL,
  credits  INTEGER NOT NULL,
  nonce    TEXT NOT NULL,
  film_job TEXT,
  at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS redemptions_at ON redemptions(at);
INSERT OR IGNORE INTO launch_codes (code, channel) VALUES
  ('PRODUCTHUNT', 'producthunt'), ('HN', 'hn'), ('REDDIT', 'reddit'), ('X', 'x'), ('TIKTOK', 'tiktok');
