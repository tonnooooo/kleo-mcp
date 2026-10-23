-- 23 October 2026: THE ADMIN CONSOLE (src/studio/admin.ts, app.kleooai.com/admin).
--
-- studio_ips: where a person was when they signed up, signed in, connected an assistant or opened a payment: the raw
-- address, its fingerprint (the same HMAC as users.ip_hash, so it finds blocked_addresses rows and twin accounts), and
-- what Cloudflare says about it (request.cf: country, region, city, network). Rows older than IP_RETENTION_DAYS (90)
-- are deleted by the Studio cron (src/studio/ips.ts pruneIps). The privacy page says so.
--
-- users.blocked_at / blocked_reason: an account the owner closed from the console. Studio refuses its sessions and
-- sign-ins; the block also renews its Kleo key, which disconnects every assistant connected with the old one.
--
-- The two audit indexes keep the console's user timeline and failure list off a full scan of the audit table, which
-- the MCP cron grows by one row a minute.
--
-- Mirrors STUDIO_SCHEMA and STUDIO_COLUMNS in src/studio/store.ts, which create the same things on first use.
CREATE TABLE IF NOT EXISTS studio_ips (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  event   TEXT NOT NULL,              -- signup | signin | connect | pay
  ip      TEXT,
  ip_hash TEXT,
  country TEXT,
  region  TEXT,
  city    TEXT,
  asn     INTEGER,
  as_org  TEXT,
  ua      TEXT
);
CREATE INDEX IF NOT EXISTS studio_ips_user ON studio_ips (user_id, at);
CREATE INDEX IF NOT EXISTS studio_ips_at ON studio_ips (at);
CREATE INDEX IF NOT EXISTS studio_ips_ip ON studio_ips (ip);
-- studio_admin: the console's second factor (src/studio/admin-auth.ts): the TOTP secret sealed with AES-GCM under a key
-- derived from INTERNAL_SECRET, the ten recovery codes as keyed hashes, the console's session epoch ("sign the console out
-- everywhere"), the count of wrong codes and the lock they cause, and the last code step used (a code works once).
-- Deleting a row resets that account's second factor: the next visit to /admin sets it up again (docs/ADMIN-SECURITY.md).
CREATE TABLE IF NOT EXISTS studio_admin (
  user_id       TEXT PRIMARY KEY,
  secret        TEXT,
  pending       TEXT,
  pending_at    TEXT,
  enrolled_at   TEXT,
  recovery      TEXT,
  session_epoch INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  last_step     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS audit_user ON audit (user_id, id);
CREATE INDEX IF NOT EXISTS audit_job ON audit (job_id);
ALTER TABLE users ADD COLUMN blocked_at TEXT;
ALTER TABLE users ADD COLUMN blocked_reason TEXT;
