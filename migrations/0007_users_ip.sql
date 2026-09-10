-- The per-address signup cap used to be counted with a LIKE over the audit table's JSON detail: one scan of every
-- audit row written today, on every single sign-in, and a read that could not be fused with the INSERT it guarded.
-- With the column, the cap is one indexed count INSIDE the INSERT (src/db.ts createUserIfUnderCaps), so a burst of
-- simultaneous sign-ups can no longer slip past it.
-- Only a fingerprint is stored: HMAC(INTERNAL_SECRET, address). The address itself never reaches the database, and
-- the value is useless anywhere else because the secret is not shared.
-- Mirrors the ["users", "ip_hash", "TEXT"] entry of schema.ts ensureColumns. Apply BEFORE deploying a Worker that
-- carries it; both are idempotent-safe only in that order (ensureColumns swallows "duplicate column", this does not).
ALTER TABLE users ADD COLUMN ip_hash TEXT;

-- Both daily caps read (ip_hash, created_at) together; without the index every sign-up scans the whole users table.
CREATE INDEX IF NOT EXISTS users_ip_created ON users(ip_hash, created_at);
