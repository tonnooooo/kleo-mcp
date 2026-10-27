-- 28 October 2026: KLEO CREATORS (src/studio/creators.ts). "Pay until you prove it": creators are paying customers
-- first; Kleo gives more only for posts that really went out, and a free plan only when the people a creator brought
-- in pay for it. Program rules: kleo\marketing\creators\PROGRAM.md; agreement: kleooai.com/creators/agreement.html.
--
-- creators: one row per applicant (application, checks, level, short link, payout choice); creator_posts: every post a
-- creator sent, with its day-7 views and bonus; creator_credits: every grant of program credits (90 days each);
-- creator_commissions: one row per payment of somebody who came through a creator's link; creator_payouts: cash sent.
-- users.program_credits: the part of the balance that came from the program and is not spent yet; the trigger takes
-- every decrease of users.credits off it first.
-- Mirrors CREATORS_SCHEMA / CREATORS_COLUMNS / CREATORS_TRIGGER, which Kleo Studio creates on first use (src/studio/store.ts).
CREATE TABLE IF NOT EXISTS creators (
  user_id TEXT PRIMARY KEY, status TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'creator',
  platform TEXT NOT NULL, handle TEXT NOT NULL, handle_key TEXT NOT NULL, profile_url TEXT NOT NULL,
  name TEXT, country TEXT, followers INTEGER, best_views INTEGER, account_since TEXT, ai_posts INTEGER, username_changes INTEGER,
  best_url TEXT, about TEXT, flags TEXT, bio_code TEXT NOT NULL, bio_seen_at TEXT, link_code TEXT,
  terms_version TEXT NOT NULL, terms_at TEXT NOT NULL, payout_pref TEXT NOT NULL DEFAULT 'credits', payout_email TEXT,
  invited INTEGER NOT NULL DEFAULT 0, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), decided_at TEXT, decided_by TEXT, refuse_reason TEXT,
  approved_at TEXT, level_since TEXT, misses INTEGER NOT NULL DEFAULT 0, comp_until TEXT, ended_at TEXT, end_reason TEXT, notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS creators_handle ON creators (platform, handle_key);
CREATE INDEX IF NOT EXISTS creators_status ON creators (status, applied_at);
CREATE INDEX IF NOT EXISTS creators_link ON creators (link_code);
CREATE TABLE IF NOT EXISTS creator_posts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT NOT NULL, url_key TEXT NOT NULL, generation_id TEXT, month TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', views INTEGER, bonus INTEGER NOT NULL DEFAULT 0, reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), checked_at TEXT, checked_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS creator_posts_url ON creator_posts (url_key);
CREATE INDEX IF NOT EXISTS creator_posts_user ON creator_posts (user_id, month);
CREATE INDEX IF NOT EXISTS creator_posts_status ON creator_posts (status, created_at);
CREATE TABLE IF NOT EXISTS creator_credits (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, amount INTEGER NOT NULL, left_amount INTEGER NOT NULL,
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), expires_at TEXT NOT NULL, expired_at TEXT, taken INTEGER NOT NULL DEFAULT 0, note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS creator_credits_ref ON creator_credits (user_id, kind, ref);
CREATE INDEX IF NOT EXISTS creator_credits_live ON creator_credits (expired_at, expires_at);
CREATE TABLE IF NOT EXISTS creator_commissions (
  session_id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, buyer_id TEXT NOT NULL, paid_at TEXT NOT NULL, amount_cent INTEGER NOT NULL,
  net_cent INTEGER NOT NULL, rate_bp INTEGER NOT NULL, commission_cent INTEGER NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL,
  hold_until TEXT NOT NULL, credits INTEGER NOT NULL DEFAULT 0, payout_id TEXT, reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), settled_at TEXT
);
CREATE INDEX IF NOT EXISTS creator_commissions_creator ON creator_commissions (creator_id, status);
CREATE TABLE IF NOT EXISTS creator_payouts (
  id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, cents INTEGER NOT NULL, method TEXT NOT NULL, ref TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), by_admin TEXT
);
CREATE INDEX IF NOT EXISTS creator_payouts_creator ON creator_payouts (creator_id, at);
ALTER TABLE users ADD COLUMN program_credits INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER IF NOT EXISTS users_program_credits_spent AFTER UPDATE OF credits ON users
  WHEN NEW.credits < OLD.credits AND OLD.program_credits > 0
  BEGIN UPDATE users SET program_credits = MAX(0, program_credits - (OLD.credits - NEW.credits)) WHERE id = NEW.id; END;
