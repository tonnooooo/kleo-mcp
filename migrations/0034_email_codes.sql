-- Sign in with an e-mail code (src/studio/auth.ts, 30 October 2026). Kleo Studio creates this table on first use
-- (src/studio/store.ts STUDIO_SCHEMA, from src/studio/mail-schema.ts EMAIL_CODE_SCHEMA); this file keeps the same SQL.
-- One row per inbox (canonicalEmail): the address the code went to, only the code's HMAC, when it stops working (ms),
-- its wrong tries, the sends of the current hour, and the wrong tries of the day across codes.
CREATE TABLE IF NOT EXISTS studio_email_codes (
  inbox TEXT PRIMARY KEY, address TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL, window_start INTEGER NOT NULL,
  window_sends INTEGER NOT NULL DEFAULT 1, fail_day TEXT, fails INTEGER NOT NULL DEFAULT 0);
