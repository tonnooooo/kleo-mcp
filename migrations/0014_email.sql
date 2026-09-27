-- 27 September 2026: THE OPTIONAL, VERIFIED EMAIL (src/email.ts). users.email stays the synthetic anonymous address;
-- contact_email is the one the owner may add on the account page, verified by a mailed link
-- (contact_email_verified_at). Verifying gives 3 credits once per account AND once per address: email_bonus has the
-- address as PRIMARY KEY and the account UNIQUE, and `nonce` ties the credits to THIS insert.
-- Mirrors schema.ts (COLUMNS, STATEMENTS). Apply BEFORE deploying the Worker that carries it.
ALTER TABLE users ADD COLUMN contact_email TEXT;
ALTER TABLE users ADD COLUMN contact_email_verified_at TEXT;
CREATE TABLE IF NOT EXISTS email_bonus (
  email   TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  credits INTEGER NOT NULL,
  nonce   TEXT NOT NULL,
  at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
