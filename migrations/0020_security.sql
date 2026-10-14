-- 14 October 2026, security pass.
-- users.key_version: a Kleo key (src/accounts.ts makeHandle) can be retired; version 0 keeps every existing key valid.
-- users.studio_epoch: every Kleo Studio session carries the account's epoch; bumping it signs the account out everywhere.
-- Mirrors src/studio/store.ts (STUDIO_COLUMNS). Apply BEFORE deploying either Worker (kleo-mcp or kleo-studio): Studio's
-- ensureStudioSchema adds these two columns itself and swallows "duplicate column", this file does not, so a Studio that
-- served one request first would make this migration fail and block every migration after it.
ALTER TABLE users ADD COLUMN key_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN studio_epoch INTEGER NOT NULL DEFAULT 0;
