-- When the job entered the queue (reset on every requeue), so QUEUE_MAX_WAIT_MIN measures the wait for a GPU and
-- not the age of the job: a video that rendered for an hour, failed and was requeued must not be killed on the spot
-- with "no GPU was free in time" (src/orchestrator.ts, src/db.ts staleQueuedJobs).
-- Mirrors the ["jobs", "queued_at", "TEXT"] entry of schema.ts ensureColumns. Apply BEFORE deploying a Worker that
-- carries it; both are idempotent-safe only in that order (ensureColumns swallows "duplicate column", this does not).
ALTER TABLE jobs ADD COLUMN queued_at TEXT;
