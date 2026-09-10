-- The last time the worker on the instance said anything (src/internal.ts progress → src/orchestrator.ts start
-- timeout, which measures silence from here and not wall clock since the GPU was rented).
-- Mirrors the ["jobs", "last_report_at", "TEXT"] entry of schema.ts ensureColumns. Apply BEFORE deploying a Worker
-- that carries it; both are idempotent-safe only in that order (ensureColumns swallows "duplicate column", this
-- migration does not).
ALTER TABLE jobs ADD COLUMN last_report_at TEXT;
