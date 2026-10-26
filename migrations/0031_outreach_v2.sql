-- 27 October 2026: OUTREACH v2 (src/studio/outreach.ts, src/studio/scout.ts).
--
-- outreach_senders: every mailbox Kleo sends from, with its own warm-up, pause and IMAP position; its app password is
-- sealed in the row (AES-GCM under INTERNAL_SECRET, bound to the row's id).
-- outreach_seen: every website the scout looked at, with what it found, so none is read twice.
-- outreach_prospects gains the mailbox that writes to it, the version of the first e-mail it got, its personal link and
-- the account that signed up through it; outreach_log the mailbox of each send.
-- Mirrors OUTREACH_SCHEMA and OUTREACH_COLUMNS in src/studio/mail-schema.ts, which Kleo Studio applies on first use.
CREATE TABLE IF NOT EXISTS outreach_senders (
  id            TEXT PRIMARY KEY,
  from_name     TEXT NOT NULL,
  from_addr     TEXT NOT NULL UNIQUE,
  user          TEXT NOT NULL,
  smtp_host     TEXT NOT NULL,
  smtp_port     INTEGER NOT NULL,
  imap_host     TEXT NOT NULL,
  imap_port     INTEGER NOT NULL,
  daily_max     INTEGER NOT NULL DEFAULT 40,
  sealed_pass   TEXT,
  pass_last4    TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  paused_reason TEXT,
  paused_at     TEXT,
  imap_state    TEXT,
  checked_at    TEXT,
  next_send_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS outreach_seen (
  domain TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  result TEXT,
  url    TEXT,
  hint   TEXT,
  at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS outreach_seen_status ON outreach_seen (status, at);
ALTER TABLE outreach_prospects ADD COLUMN sender_id TEXT;
ALTER TABLE outreach_prospects ADD COLUMN variant TEXT;
ALTER TABLE outreach_prospects ADD COLUMN link_code TEXT;
ALTER TABLE outreach_prospects ADD COLUMN converted_user TEXT;
ALTER TABLE outreach_prospects ADD COLUMN converted_at TEXT;
ALTER TABLE outreach_log ADD COLUMN sender_id TEXT;
