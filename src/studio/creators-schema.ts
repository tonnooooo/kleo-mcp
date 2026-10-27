/**
 * KLEO STUDIO — KLEO CREATORS' TABLES (28 October 2026; migrations/0033_creators.sql holds the same statements for the
 * record). Pure statements and one read, with no import of the rest of the Studio, so src/studio/store.ts and
 * src/studio/generate.ts can use them without an import cycle. The program itself is src/studio/creators.ts.
 */
import type { StudioEnv } from "./env.ts";

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

export const CREATORS_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS creators (
    user_id TEXT PRIMARY KEY, status TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'creator',
    platform TEXT NOT NULL, handle TEXT NOT NULL, handle_key TEXT NOT NULL, profile_url TEXT NOT NULL,
    name TEXT, country TEXT, followers INTEGER, best_views INTEGER, account_since TEXT, ai_posts INTEGER, username_changes INTEGER,
    best_url TEXT, about TEXT, flags TEXT, bio_code TEXT NOT NULL, bio_seen_at TEXT, link_code TEXT,
    terms_version TEXT NOT NULL, terms_at TEXT NOT NULL, payout_pref TEXT NOT NULL DEFAULT 'credits', payout_email TEXT,
    invited INTEGER NOT NULL DEFAULT 0, applied_at TEXT NOT NULL DEFAULT ${NOW}, decided_at TEXT, decided_by TEXT, refuse_reason TEXT,
    approved_at TEXT, level_since TEXT, misses INTEGER NOT NULL DEFAULT 0, comp_until TEXT, ended_at TEXT, end_reason TEXT, notes TEXT,
    updated_at TEXT NOT NULL DEFAULT ${NOW})`,
  `CREATE UNIQUE INDEX IF NOT EXISTS creators_handle ON creators (platform, handle_key)`,
  `CREATE INDEX IF NOT EXISTS creators_status ON creators (status, applied_at)`,
  `CREATE INDEX IF NOT EXISTS creators_link ON creators (link_code)`,
  `CREATE TABLE IF NOT EXISTS creator_posts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT NOT NULL, url_key TEXT NOT NULL, generation_id TEXT, month TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', views INTEGER, bonus INTEGER NOT NULL DEFAULT 0, reason TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW}, checked_at TEXT, checked_by TEXT)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS creator_posts_url ON creator_posts (url_key)`,
  `CREATE INDEX IF NOT EXISTS creator_posts_user ON creator_posts (user_id, month)`,
  `CREATE INDEX IF NOT EXISTS creator_posts_status ON creator_posts (status, created_at)`,
  `CREATE TABLE IF NOT EXISTS creator_credits (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, amount INTEGER NOT NULL, left_amount INTEGER NOT NULL,
    granted_at TEXT NOT NULL DEFAULT ${NOW}, expires_at TEXT NOT NULL, expired_at TEXT, taken INTEGER NOT NULL DEFAULT 0, note TEXT)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS creator_credits_ref ON creator_credits (user_id, kind, ref)`,
  `CREATE INDEX IF NOT EXISTS creator_credits_live ON creator_credits (expired_at, expires_at)`,
  `CREATE TABLE IF NOT EXISTS creator_commissions (
    session_id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, buyer_id TEXT NOT NULL, paid_at TEXT NOT NULL, amount_cent INTEGER NOT NULL,
    net_cent INTEGER NOT NULL, rate_bp INTEGER NOT NULL, commission_cent INTEGER NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL,
    hold_until TEXT NOT NULL, credits INTEGER NOT NULL DEFAULT 0, payout_id TEXT, reason TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW}, settled_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS creator_commissions_creator ON creator_commissions (creator_id, status)`,
  `CREATE TABLE IF NOT EXISTS creator_payouts (
    id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, cents INTEGER NOT NULL, method TEXT NOT NULL, ref TEXT,
    at TEXT NOT NULL DEFAULT ${NOW}, by_admin TEXT)`,
  `CREATE INDEX IF NOT EXISTS creator_payouts_creator ON creator_payouts (creator_id, at)`,
];
export const CREATORS_COLUMNS: string[] = [
  "ALTER TABLE users ADD COLUMN program_credits INTEGER NOT NULL DEFAULT 0",
];
export const PROGRAM_TRIGGER = "users_program_credits_spent";
/** Made after the column above exists (store.ts ensureStudioSchema); a database that refuses it keeps every grant. */
export const CREATORS_TRIGGER = `CREATE TRIGGER IF NOT EXISTS ${PROGRAM_TRIGGER} AFTER UPDATE OF credits ON users
  WHEN NEW.credits < OLD.credits AND OLD.program_credits > 0
  BEGIN UPDATE users SET program_credits = MAX(0, program_credits - (OLD.credits - NEW.credits)) WHERE id = NEW.id; END`;

/** Whether the program gives this account a plan right now (the Pro partner level). generate.ts hasActivePlan reads it. */
export async function compPlanActive(env: StudioEnv, userId: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT comp_until FROM creators WHERE user_id = ? AND status = 'active'").bind(userId).first<{ comp_until: string | null }>().catch(() => null);
  return !!r?.comp_until && Date.parse(r.comp_until) > Date.now();
}
