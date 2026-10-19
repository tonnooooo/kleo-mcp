-- 19 October 2026: one account everywhere (src/connect.ts). An anonymous connector account merged into a real
-- Kleo account points at it; the assistant's existing grant then acts on the real account (src/index.ts).
ALTER TABLE users ADD COLUMN merged_into TEXT;
