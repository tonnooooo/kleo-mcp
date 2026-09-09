-- Storyboard planning (src/storyboard.ts): the Keou project generated before a GPU is rented.
-- Apply BEFORE deploying a Worker that carries schema.ts ensureColumns; both are idempotent-safe
-- only in that order (ensureColumns swallows "duplicate column", this migration does not).
ALTER TABLE jobs ADD COLUMN storyboard TEXT;                              -- JSON, see src/keou-contract.ts
ALTER TABLE jobs ADD COLUMN plan_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN plan_error TEXT;
