-- 14 October 2026, security pass.
-- users.key_version: a Kleo key (src/accounts.ts makeHandle) can be retired; version 0 keeps every existing key valid.
-- users.studio_epoch: every Kleo Studio session carries the account's epoch; bumping it signs the account out everywhere.
ALTER TABLE users ADD COLUMN key_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN studio_epoch INTEGER NOT NULL DEFAULT 0;
