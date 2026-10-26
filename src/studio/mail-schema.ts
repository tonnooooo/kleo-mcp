/**
 * The tables of Kleo Studio's welcome e-mails (src/studio/onboarding.ts) and the shared stop list, apart so src/studio/store.ts
 * can create them on first use without importing the e-mail code. migrations/0029_onboarding.sql holds the same SQL.
 */
const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

export const ONBOARDING_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS studio_mail (
    user_id TEXT PRIMARY KEY, email TEXT NOT NULL, track TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0, next_at TEXT,
    status TEXT NOT NULL DEFAULT 'active', stop_reason TEXT, rescued INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
    tz TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT ${NOW})`,
  `CREATE INDEX IF NOT EXISTS studio_mail_due ON studio_mail (status, next_at)`,
  `CREATE TABLE IF NOT EXISTS studio_mail_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, email TEXT NOT NULL, mail TEXT NOT NULL, kind TEXT NOT NULL,
    ok INTEGER NOT NULL, error TEXT, message_id TEXT, at TEXT NOT NULL DEFAULT ${NOW})`,
  `CREATE INDEX IF NOT EXISTS studio_mail_log_at ON studio_mail_log (at)`,
  `CREATE INDEX IF NOT EXISTS studio_mail_log_user ON studio_mail_log (user_id, at)`,
  // One row per address that must not be written to again, whatever wrote to it (welcome e-mails or outreach).
  `CREATE TABLE IF NOT EXISTS mail_suppress (email TEXT PRIMARY KEY, reason TEXT NOT NULL, source TEXT NOT NULL, at TEXT NOT NULL DEFAULT ${NOW})`,
];
