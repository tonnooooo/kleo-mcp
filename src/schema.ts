import type { Env } from "./env";

/**
 * Idempotent schema bootstrap, so the Worker also runs where migrations cannot be applied
 * (temporary accounts, fresh databases). Mirrors migrations/0001_init.sql + the locks table.
 */
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT, credits INTEGER NOT NULL DEFAULT 0, plan TEXT NOT NULL DEFAULT 'trial', invite_code TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), last_seen_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, credits INTEGER NOT NULL DEFAULT 3, max_uses INTEGER NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0, note TEXT)`,
  `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), template TEXT NOT NULL, prompt TEXT NOT NULL, params TEXT NOT NULL, state TEXT NOT NULL, track TEXT, percent INTEGER NOT NULL DEFAULT 0, eta_min INTEGER, credits INTEGER NOT NULL, backend TEXT, instance_id TEXT, instance_meta TEXT, worker_secret TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, notify_email TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), started_at TEXT, finished_at TEXT, expires_at TEXT, purged_at TEXT, cost_usd REAL)`,
  `CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state)`,
  `CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS job_files (job_id TEXT NOT NULL REFERENCES jobs(id), name TEXT NOT NULL, key TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, content_type TEXT NOT NULL DEFAULT 'application/octet-stream', PRIMARY KEY (job_id, name))`,
  `CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), user_id TEXT, job_id TEXT, event TEXT NOT NULL, detail TEXT)`,
  `CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, until TEXT NOT NULL)`,
  `INSERT OR IGNORE INTO invites (code, credits, max_uses, note) VALUES ('KLEO-BETA', 3, 50, 'shared beta code')`,
];

let ready: Promise<void> | null = null;

export function ensureSchema(env: Env): Promise<void> {
  if (!ready) {
    ready = env.DB.batch(STATEMENTS.map((s) => env.DB.prepare(s))).then(() => undefined).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** Atomic, time-limited lock in D1 (used to avoid two orchestrator ticks running at once). */
export async function acquireLock(env: Env, name: string, seconds: number): Promise<boolean> {
  const until = new Date(Date.now() + seconds * 1000).toISOString();
  await env.DB.prepare("INSERT OR IGNORE INTO locks (name, until) VALUES (?, '1970-01-01T00:00:00Z')").bind(name).run();
  const r = await env.DB.prepare("UPDATE locks SET until = ? WHERE name = ? AND until < strftime('%Y-%m-%dT%H:%M:%fZ','now')").bind(until, name).run();
  return (r.meta.changes ?? 0) === 1;
}
export const releaseLock = (env: Env, name: string) =>
  env.DB.prepare("UPDATE locks SET until = '1970-01-01T00:00:00Z' WHERE name = ?").bind(name).run();
