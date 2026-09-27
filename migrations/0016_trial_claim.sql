-- 27 September 2026: WHEN THE LAUNCH-CODE FILM WAS CLAIMED (src/launch.ts CLAIM_FREE). redemptions.film_at is the time
-- redemptions.film_job was set. A claim whose job row does not exist yet holds the trial (a second call from the same
-- account, arriving between the claim and the insert, must not take it over); one that still names no job row after
-- TRIAL_CLAIM_STALE_MIN minutes was left by a crash and lapses.
-- Mirrors schema.ts (COLUMNS). Apply BEFORE deploying the Worker that carries it.
ALTER TABLE redemptions ADD COLUMN film_at TEXT;
