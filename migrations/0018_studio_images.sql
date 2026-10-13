-- 13 October 2026: KLEO STUDIO IMAGES. A generation is a video clip or a set of 1-4 pictures; each picture is its own
-- provider task, kept in `slots` (JSON: task, status, stored key, upload id, error).
-- Mirrors src/studio/store.ts (STUDIO_COLUMNS), which also adds them on first use.
ALTER TABLE studio_generations ADD COLUMN kind TEXT NOT NULL DEFAULT 'video';
ALTER TABLE studio_generations ADD COLUMN slots TEXT;
