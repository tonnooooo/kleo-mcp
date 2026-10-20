-- 20 October 2026: Kleo Studio. An account may choose to have a video Seedance refuses for copyright made on Wan 3.0
-- by itself, for the same credits (src/studio/generate.ts switchToWan). The Worker also adds it at runtime
-- (src/studio/store.ts STUDIO_COLUMNS).
ALTER TABLE users ADD COLUMN studio_auto_wan INTEGER NOT NULL DEFAULT 0;
