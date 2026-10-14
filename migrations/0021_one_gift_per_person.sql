-- 15 October 2026, one gift per person (src/abuse.ts). Apply BEFORE deploying either Worker: the MCP Worker's
-- ensureSchema (src/schema.ts) adds these columns itself and swallows "duplicate column", this file does not.
-- users.gift: the free credits the account was opened with (0 = none). Every account opened so far counts as gifted,
-- so an address that already had its gift waits out the window like any other.
ALTER TABLE users ADD COLUMN gift INTEGER NOT NULL DEFAULT 0;
UPDATE users SET gift = 1 WHERE ip_hash IS NOT NULL;
-- users.email_canon: the inbox behind the address (src/abuse.ts canonicalEmail): one inbox, one account.
ALTER TABLE users ADD COLUMN email_canon TEXT;
UPDATE users SET email_canon = lower(email) WHERE email NOT LIKE '%.invalid';
CREATE INDEX IF NOT EXISTS users_email_canon ON users(email_canon);
-- Addresses (their fingerprint, users.ip_hash) that may not open accounts or generate for free until `until`.
CREATE TABLE IF NOT EXISTS blocked_addresses (
  ip_hash TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  until TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
