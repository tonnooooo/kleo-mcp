/**
 * The tables of Kleo Studio's welcome e-mails (src/studio/onboarding.ts), its outreach e-mails (src/studio/outreach.ts)
 * and the shared stop list, apart so src/studio/store.ts can create them on first use without importing the e-mail code.
 * migrations/0029_onboarding.sql and 0030_outreach.sql hold the same SQL.
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

/**
 * The outreach e-mails (src/studio/outreach.ts): the businesses Kleo may write to, each with the page where its address
 * is published; every send; every reply read from the mailbox. migrations/0030_outreach.sql holds the same SQL.
 */
export const OUTREACH_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS outreach_prospects (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, domain TEXT NOT NULL, company TEXT NOT NULL, website TEXT, country TEXT NOT NULL,
    region TEXT, city TEXT, type TEXT, size_hint TEXT, contact_name TEXT, contact_role TEXT, email_kind TEXT, source_url TEXT NOT NULL,
    fit_reason TEXT, evidence TEXT, opener TEXT, batch TEXT, status TEXT NOT NULL DEFAULT 'new', stop_reason TEXT, step INTEGER NOT NULL DEFAULT 0,
    next_at TEXT, tz TEXT, thread_id TEXT, subject TEXT, added_at TEXT NOT NULL DEFAULT ${NOW}, approved_at TEXT, last_sent_at TEXT,
    replied_at TEXT, reply_class TEXT, reply_summary TEXT, updated_at TEXT NOT NULL DEFAULT ${NOW})`,
  `CREATE INDEX IF NOT EXISTS outreach_prospects_due ON outreach_prospects (status, next_at)`,
  `CREATE INDEX IF NOT EXISTS outreach_prospects_domain ON outreach_prospects (domain)`,
  `CREATE TABLE IF NOT EXISTS outreach_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, prospect_id TEXT NOT NULL, email TEXT NOT NULL, step INTEGER NOT NULL, ok INTEGER NOT NULL,
    error TEXT, message_id TEXT, at TEXT NOT NULL DEFAULT ${NOW})`,
  `CREATE INDEX IF NOT EXISTS outreach_log_at ON outreach_log (at)`,
  `CREATE INDEX IF NOT EXISTS outreach_log_msg ON outreach_log (message_id)`,
  `CREATE TABLE IF NOT EXISTS outreach_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT, prospect_id TEXT, from_addr TEXT NOT NULL, subject TEXT, text TEXT, class TEXT NOT NULL,
    summary TEXT, uid INTEGER, at TEXT NOT NULL DEFAULT ${NOW})`,
  `CREATE INDEX IF NOT EXISTS outreach_replies_prospect ON outreach_replies (prospect_id, uid)`,
  // 27 October 2026, outreach v2 (migrations/0031_outreach_v2.sql): the mailboxes Kleo sends from (each password sealed,
  // bound to the row's id), and every website the scout has looked at, so none is read twice.
  `CREATE TABLE IF NOT EXISTS outreach_senders (
    id TEXT PRIMARY KEY, from_name TEXT NOT NULL, from_addr TEXT NOT NULL UNIQUE, user TEXT NOT NULL, smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL,
    imap_host TEXT NOT NULL, imap_port INTEGER NOT NULL, daily_max INTEGER NOT NULL DEFAULT 40, sealed_pass TEXT, pass_last4 TEXT,
    status TEXT NOT NULL DEFAULT 'active', paused_reason TEXT, paused_at TEXT, imap_state TEXT, checked_at TEXT, next_send_at TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW})`,
  `CREATE TABLE IF NOT EXISTS outreach_seen (domain TEXT PRIMARY KEY, status TEXT NOT NULL, result TEXT, url TEXT, hint TEXT, at TEXT NOT NULL DEFAULT ${NOW})`,
  `CREATE INDEX IF NOT EXISTS outreach_seen_status ON outreach_seen (status, at)`,
];

/**
 * The payment e-mails (src/studio/receipts.ts, migrations/0032_receipts.sql): one row per payment that got its e-mail
 * (or was skipped, with why), so none gets two.
 */
export const RECEIPTS_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS studio_receipts (
    session_id TEXT PRIMARY KEY, user_id TEXT, kind TEXT NOT NULL, email TEXT, ok INTEGER NOT NULL, error TEXT, at TEXT NOT NULL DEFAULT ${NOW})`,
];

/** Columns added to the outreach tables after they first went live (migrations/0031_outreach_v2.sql). */
export const OUTREACH_COLUMNS: string[] = [
  "ALTER TABLE outreach_prospects ADD COLUMN sender_id TEXT",
  "ALTER TABLE outreach_prospects ADD COLUMN variant TEXT",
  "ALTER TABLE outreach_prospects ADD COLUMN link_code TEXT",
  "ALTER TABLE outreach_prospects ADD COLUMN converted_user TEXT",
  "ALTER TABLE outreach_prospects ADD COLUMN converted_at TEXT",
  "ALTER TABLE outreach_log ADD COLUMN sender_id TEXT",
];
