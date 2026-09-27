-- 27 September 2026: ATTRIBUTION AND THE FUNNEL (src/growth.ts).
--  · users.src: the channel an account came through (?src= on the connector address), written once at sign-up or by
--    the first MCP calls of its first day.
--  · page_hits: the site's page views, AGGREGATED per UTC day (GET/POST /b): path, referrer host, utm_source, language
--    and country, with a count. No IP, no cookie, no user id is ever stored.
-- Mirrors schema.ts (COLUMNS, COLUMN_INDEXES, STATEMENTS). Apply BEFORE deploying the Worker that carries it.
ALTER TABLE users ADD COLUMN src TEXT;
CREATE INDEX IF NOT EXISTS users_created ON users(created_at);
CREATE TABLE IF NOT EXISTS page_hits (
  day     TEXT NOT NULL,              -- YYYY-MM-DD, UTC
  path    TEXT NOT NULL,
  ref     TEXT NOT NULL DEFAULT '',   -- the referrer's host only
  source  TEXT NOT NULL DEFAULT '',   -- utm_source
  lang    TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',   -- from Cloudflare's header, two letters
  n       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path, ref, source, lang, country)
);
