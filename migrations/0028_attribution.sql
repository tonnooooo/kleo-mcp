-- 25 October 2026: WHERE ACCOUNTS COME FROM (src/studio/attribution.ts, the admin console's Sources page).
--
-- user_attribution: one row per account opened in Kleo Studio, written when it is created, from the first-touch cookie
-- __Host-kleo_src (seven days, no identifier): the channel (instagram, tiktok, x, youtube, google, chatgpt, site, dm,
-- other, direct, untracked …), whether it was only guessed from the in-app browser, the short link, the utm tags and
-- ?src=, the referring host (never the full address), the landing path (never its query), the in-app browser, and when
-- the browser first came.
--
-- short_links: app.kleooai.com/r/<code>, made by the owner in the console: a network, the post or video it is for, and the
-- page it opens. short_link_clicks: clicks per link per day (robots never counted).
--
-- first_visits: first visits of a browser to the app per day, channel and link. Totals only: no account, no address.
--
-- studio_meta: when tracking began; accounts older than that are "unknown (before tracking)" in the console.
--
-- Mirrors ATTRIBUTION_SCHEMA in src/studio/attribution.ts, which Kleo Studio creates on first use (src/studio/store.ts).
CREATE TABLE IF NOT EXISTS user_attribution (
  user_id       TEXT PRIMARY KEY,
  channel       TEXT NOT NULL,
  guessed       INTEGER NOT NULL DEFAULT 0,
  link_code     TEXT,
  utm_source    TEXT,
  utm_medium    TEXT,
  utm_campaign  TEXT,
  utm_content   TEXT,
  src           TEXT,
  ref_host      TEXT,
  landing       TEXT,
  in_app        TEXT,
  first_seen_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS user_attribution_created ON user_attribution (created_at);
CREATE INDEX IF NOT EXISTS user_attribution_link ON user_attribution (link_code);
CREATE TABLE IF NOT EXISTS short_links (
  code       TEXT PRIMARY KEY,
  channel    TEXT NOT NULL,              -- instagram | tiktok | x | youtube | dm | other
  label      TEXT NOT NULL,              -- the bio, post or video it is for
  target     TEXT NOT NULL DEFAULT '/',  -- the app page it opens
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT,
  archived_at TEXT
);
CREATE TABLE IF NOT EXISTS short_link_clicks (
  code   TEXT NOT NULL,
  day    TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (code, day)
);
CREATE TABLE IF NOT EXISTS first_visits (
  day       TEXT NOT NULL,
  channel   TEXT NOT NULL,
  link_code TEXT NOT NULL DEFAULT '',
  guessed   INTEGER NOT NULL DEFAULT 0,
  n         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, channel, link_code, guessed)
);
CREATE TABLE IF NOT EXISTS studio_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO studio_meta (key, value) VALUES ('attribution_since', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
