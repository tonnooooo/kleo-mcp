-- What each provider can still spend, and when the owner was last told (src/studio/providers.ts, 23 October 2026).
-- Kleo Studio creates it on first use (src/studio/store.ts STUDIO_SCHEMA); this file keeps the record.
CREATE TABLE IF NOT EXISTS provider_status (
  provider TEXT PRIMARY KEY, balance_usd REAL, balance_at TEXT, source TEXT, short_until TEXT, checked_at TEXT,
  alert_level TEXT, alerted_at TEXT);
