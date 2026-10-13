-- 13 October 2026: KLEO STUDIO, the consumer web app (src/studio/, Worker "kleo-studio"). Its own tables next to
-- users / payments / audit, so a Studio account is a Kleo account with the same credits.
-- Mirrors src/studio/store.ts (STUDIO_SCHEMA), which also creates them on first use; nothing else changes.
CREATE TABLE IF NOT EXISTS studio_logins (
  provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT, secret TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), last_login_at TEXT, PRIMARY KEY (provider, subject));
CREATE INDEX IF NOT EXISTS studio_logins_user ON studio_logins (user_id);
CREATE TABLE IF NOT EXISTS studio_chats (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), deleted_at TEXT);
CREATE INDEX IF NOT EXISTS studio_chats_user ON studio_chats (user_id, updated_at);
CREATE TABLE IF NOT EXISTS studio_messages (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT, data TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE INDEX IF NOT EXISTS studio_messages_chat ON studio_messages (chat_id, created_at);
CREATE TABLE IF NOT EXISTS studio_uploads (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, key TEXT NOT NULL, content_type TEXT, size INTEGER,
  width INTEGER, height INTEGER, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE INDEX IF NOT EXISTS studio_uploads_user ON studio_uploads (user_id, created_at);
CREATE TABLE IF NOT EXISTS studio_generations (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT, message_id TEXT, model TEXT NOT NULL,
  settings TEXT NOT NULL, prompt TEXT NOT NULL, images TEXT, credits INTEGER NOT NULL, est_usd REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL, task_id TEXT, error TEXT, file_key TEXT, size INTEGER, usage TEXT, refunded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), checked_at TEXT, finished_at TEXT);
CREATE INDEX IF NOT EXISTS studio_generations_user ON studio_generations (user_id, created_at);
CREATE INDEX IF NOT EXISTS studio_generations_status ON studio_generations (status, checked_at);
