-- 30 October 2026: A GIFT FROM THE KLEO TEAM (src/studio/gifts.ts, the admin console's "Gift credits").
--
-- studio_gifts: one row per gift. The credits went in at once through the console's audited credit change (an
-- admin.credits audit row that carries the gift's id); the row keeps the reason (the audit log's, never shown to the
-- person), the message the person reads (optional), the admin who sent it, whether the e-mail was asked for and what
-- came of it (mail_status sent | failed | skipped, mail_to, mail_error, mailed_at), and when the app showed it
-- (seen_at; NULL = the next load after sign-in shows it, once).
-- Mirrors the studio_gifts statements of STUDIO_SCHEMA in src/studio/store.ts, which Kleo Studio runs on first use.
CREATE TABLE IF NOT EXISTS studio_gifts (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  credits     INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  message     TEXT,
  by_admin    TEXT NOT NULL,
  mail        INTEGER NOT NULL DEFAULT 0,
  mail_status TEXT,
  mail_to     TEXT,
  mail_error  TEXT,
  mailed_at   TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  seen_at     TEXT
);
CREATE INDEX IF NOT EXISTS studio_gifts_user ON studio_gifts (user_id, seen_at);
