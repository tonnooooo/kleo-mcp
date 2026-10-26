-- 27 October 2026: KLEO STUDIO'S PAYMENT E-MAILS (src/studio/receipts.ts).
--
-- studio_receipts: one row per payment that got its e-mail (a pack, a plan started, a plan renewed), or was skipped
-- with the reason, so none gets two. The switch is studio_meta 'receipts_mode' (missing = on); 'receipts_since' is the
-- moment they began, so older payments never get one.
-- Mirrors RECEIPTS_SCHEMA in src/studio/mail-schema.ts, which Kleo Studio creates on first use (src/studio/store.ts).
CREATE TABLE IF NOT EXISTS studio_receipts (
  session_id TEXT PRIMARY KEY,
  user_id    TEXT,
  kind       TEXT NOT NULL,
  email      TEXT,
  ok         INTEGER NOT NULL,
  error      TEXT,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
