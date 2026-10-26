-- 27 October 2026: KLEO STUDIO'S WELCOME E-MAILS (src/studio/onboarding.ts, the admin console's Emails page).
--
-- studio_mail: one row per account in a series — "welcome" (accounts opened after the e-mails were switched on: seven
-- e-mails, one a day) or "comeback" (accounts of the 30 days before that never paid: two e-mails). The step it is on,
-- when the next one is due (in the person's daytime, tz), whether it stopped and why, whether the rescue e-mail went.
-- studio_mail_log: every send, live or the owner's preview, with Cloudflare's message id or its refusal.
-- mail_suppress: addresses never to write to again (unsubscribed, bounced), shared with the outreach engine.
--
-- The switch lives in studio_meta: 'onboarding_mode' ('on' | 'off'), 'onboarding_on_since', 'onboarding_comeback'.
-- Mirrors ONBOARDING_SCHEMA in src/studio/mail-schema.ts, which Kleo Studio creates on first use (src/studio/store.ts).
CREATE TABLE IF NOT EXISTS studio_mail (
  user_id     TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  track       TEXT NOT NULL,
  step        INTEGER NOT NULL DEFAULT 0,
  next_at     TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  stop_reason TEXT,
  rescued     INTEGER NOT NULL DEFAULT 0,
  attempts    INTEGER NOT NULL DEFAULT 0,
  tz          TEXT,
  started_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS studio_mail_due ON studio_mail (status, next_at);
CREATE TABLE IF NOT EXISTS studio_mail_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT,
  email      TEXT NOT NULL,
  mail       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  error      TEXT,
  message_id TEXT,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS studio_mail_log_at ON studio_mail_log (at);
CREATE INDEX IF NOT EXISTS studio_mail_log_user ON studio_mail_log (user_id, at);
CREATE TABLE IF NOT EXISTS mail_suppress (
  email  TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
