-- 27 October 2026: KLEO'S OUTREACH E-MAILS (src/studio/outreach.ts, the admin console's Outreach page).
--
-- outreach_prospects: a business Kleo may write to — published business address only, with the page where it was seen
-- (source_url), in US, CA, GB, AU or NZ, waiting for the owner's approval ('new' → 'approved'), then 'active' through the
-- three e-mails, and 'done', 'replied', 'stopped', 'bounced', 'invalid' or 'rejected'.
-- outreach_log: every send through the mailbox's SMTP, with the Message-ID the replies point back to.
-- outreach_replies: every reply read from the mailbox's inbox (IMAP), with its class and a one-line summary.
-- Settings live in studio_meta ('outreach_mode', 'outreach_sender', 'outreach_imap', …); the mailbox's app password is
-- sealed in key_overrides (OUTREACH_SMTP_PASS). Addresses that said no go to mail_suppress (0029).
-- Mirrors OUTREACH_SCHEMA in src/studio/mail-schema.ts, which Kleo Studio creates on first use (src/studio/store.ts).
CREATE TABLE IF NOT EXISTS outreach_prospects (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  domain        TEXT NOT NULL,
  company       TEXT NOT NULL,
  website       TEXT,
  country       TEXT NOT NULL,
  region        TEXT,
  city          TEXT,
  type          TEXT,
  size_hint     TEXT,
  contact_name  TEXT,
  contact_role  TEXT,
  email_kind    TEXT,
  source_url    TEXT NOT NULL,
  fit_reason    TEXT,
  evidence      TEXT,
  opener        TEXT,
  batch         TEXT,
  status        TEXT NOT NULL DEFAULT 'new',
  stop_reason   TEXT,
  step          INTEGER NOT NULL DEFAULT 0,
  next_at       TEXT,
  tz            TEXT,
  thread_id     TEXT,
  subject       TEXT,
  added_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  approved_at   TEXT,
  last_sent_at  TEXT,
  replied_at    TEXT,
  reply_class   TEXT,
  reply_summary TEXT,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS outreach_prospects_due ON outreach_prospects (status, next_at);
CREATE INDEX IF NOT EXISTS outreach_prospects_domain ON outreach_prospects (domain);
CREATE TABLE IF NOT EXISTS outreach_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id TEXT NOT NULL,
  email       TEXT NOT NULL,
  step        INTEGER NOT NULL,
  ok          INTEGER NOT NULL,
  error       TEXT,
  message_id  TEXT,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS outreach_log_at ON outreach_log (at);
CREATE INDEX IF NOT EXISTS outreach_log_msg ON outreach_log (message_id);
CREATE TABLE IF NOT EXISTS outreach_replies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id TEXT,
  from_addr   TEXT NOT NULL,
  subject     TEXT,
  text        TEXT,
  class       TEXT NOT NULL,
  summary     TEXT,
  uid         INTEGER,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS outreach_replies_prospect ON outreach_replies (prospect_id, uid);
