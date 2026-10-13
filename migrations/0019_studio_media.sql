-- 14 October 2026: KLEO STUDIO MEDIA. Uploads may be video or sound clips (Apps, Seedance reference clips); the Worker
-- reads their length itself (src/studio/media.ts). Mirrors src/studio/store.ts (STUDIO_COLUMNS).
ALTER TABLE studio_uploads ADD COLUMN kind TEXT NOT NULL DEFAULT 'image';
ALTER TABLE studio_uploads ADD COLUMN duration REAL;
