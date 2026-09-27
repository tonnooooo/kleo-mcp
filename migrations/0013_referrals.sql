-- 27 September 2026: REFERRALS (src/referral.ts). Every account has a referral code (made the first time it is shown,
-- users.referral_code, unique); an account opened through one is linked to its referrer (users.referred_by, set once,
-- never to itself). When the referred account makes its FIRST REAL PAYMENT (a Stripe row with an amount), the referrer
-- gets 10 credits and the referred 5 on top of that first pack: one row in `referrals` per referred account, so never
-- twice, and never for a grant (a tester row has no amount and no webhook). A dispute of that payment takes both back.
-- Mirrors schema.ts (COLUMNS, COLUMN_INDEXES, STATEMENTS). Apply BEFORE deploying the Worker that carries it: the
-- Worker's ensureColumns swallows "duplicate column", this file does not.
ALTER TABLE users ADD COLUMN referral_code TEXT;
ALTER TABLE users ADD COLUMN referred_by TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code ON users(referral_code);
CREATE INDEX IF NOT EXISTS users_referred_by ON users(referred_by);
CREATE TABLE IF NOT EXISTS referrals (
  referred_id      TEXT PRIMARY KEY,
  referrer_id      TEXT NOT NULL,
  session_id       TEXT NOT NULL,               -- the Stripe session of the first payment
  referrer_credits INTEGER NOT NULL,
  referred_credits INTEGER NOT NULL,
  nonce            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'paid', -- paid | disputed (the credits taken back)
  at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals(referrer_id, at);
CREATE INDEX IF NOT EXISTS referrals_session ON referrals(session_id);
