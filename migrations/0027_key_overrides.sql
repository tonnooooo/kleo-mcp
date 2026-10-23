-- API keys the owner changed from the admin console (src/key-overrides.ts, src/studio/admin-keys.ts, 23 October 2026).
-- sealed: AES-GCM under a key derived from INTERNAL_SECRET, the key's name bound in; last4: what the console shows.
-- Kleo Studio creates it on first use (src/studio/store.ts STUDIO_SCHEMA); this file keeps the record.
CREATE TABLE IF NOT EXISTS key_overrides (
  name TEXT PRIMARY KEY, sealed TEXT NOT NULL, last4 TEXT NOT NULL, set_at TEXT NOT NULL, set_by TEXT);
