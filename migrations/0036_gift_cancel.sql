-- 30 October 2026: CANCEL A GIFT (src/studio/admin.ts cancelGift, the console's "Cancel gift" on an account's Gifts card).
--
-- studio_gifts gains when the console cancelled a gift (cancelled_at; seen_at is set with it, so the app never shows the
-- pop-up) and how many credits came back (cancelled_credits: the gift's credits, or less when the balance was lower).
-- The credits themselves move through an admin.credits audit row carrying the gift's id, like Take credits away.
--
-- SQLite has no ADD COLUMN IF NOT EXISTS, so this file can't be made safe to run twice. A live database needs no step:
-- Kleo Studio adds the two columns itself on first use (STUDIO_COLUMNS in src/studio/store.ts, which skips a column that
-- is already there). A new database gets them here, after 0035. If `wrangler d1 migrations apply` ever runs on a database
-- the Worker already updated, it stops at this file on "duplicate column": mark the file applied by hand (DEPLOY.md)
-- instead of editing it.
ALTER TABLE studio_gifts ADD COLUMN cancelled_at TEXT;
ALTER TABLE studio_gifts ADD COLUMN cancelled_credits INTEGER;
