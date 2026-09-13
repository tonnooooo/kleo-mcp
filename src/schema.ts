import type { Env } from "./env";

/**
 * Idempotent schema bootstrap, so the Worker also runs where migrations cannot be applied
 * (temporary accounts, fresh databases). Mirrors migrations/0001_init.sql + the locks table.
 */
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT, credits INTEGER NOT NULL DEFAULT 0, plan TEXT NOT NULL DEFAULT 'trial', invite_code TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), last_seen_at TEXT)`,
  // Codes are a GIFT now, never a gate: a row here adds credits on top of the free ones to whoever types it in the
  // optional field of the sign-in page. Nothing is seeded, so no code exists until the owner writes one himself.
  `CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, credits INTEGER NOT NULL DEFAULT 3, max_uses INTEGER NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0, note TEXT)`,
  `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), template TEXT NOT NULL, prompt TEXT NOT NULL, params TEXT NOT NULL, state TEXT NOT NULL, track TEXT, percent INTEGER NOT NULL DEFAULT 0, eta_min INTEGER, credits INTEGER NOT NULL, backend TEXT, instance_id TEXT, instance_meta TEXT, worker_secret TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, notify_email TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), started_at TEXT, finished_at TEXT, expires_at TEXT, purged_at TEXT, cost_usd REAL)`,
  `CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state)`,
  `CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS job_files (job_id TEXT NOT NULL REFERENCES jobs(id), name TEXT NOT NULL, key TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, content_type TEXT NOT NULL DEFAULT 'application/octet-stream', PRIMARY KEY (job_id, name))`,
  `CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), user_id TEXT, job_id TEXT, event TEXT NOT NULL, detail TEXT)`,
  `CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, until TEXT NOT NULL)`,
  // One successful payment per row. The Stripe Checkout Session id is the PRIMARY KEY, and that key is the whole
  // idempotency: Stripe redelivers an event until it gets a 200 and retries for days, so without it a slow webhook
  // or a lost answer credits the same purchase again and again.
  //
  // Two column choices that look wrong and are not:
  //  · user_id is NULLABLE and carries no REFERENCES. A payment whose client_reference_id matches no account is
  //    still a payment somebody made: it has to be written down, or the money exists and the record does not.
  //  · payment_intent is the only handle a refund or a dispute arrives with — those events carry a CHARGE, never
  //    the session — so without it, tracing a chargeback back to an account is not hard, it is impossible.
  `CREATE TABLE IF NOT EXISTS payments (session_id TEXT PRIMARY KEY, user_id TEXT, credits INTEGER NOT NULL DEFAULT 0, amount_cent INTEGER NOT NULL, currency TEXT NOT NULL, email TEXT, payment_intent TEXT, status TEXT NOT NULL DEFAULT 'paid', country TEXT, event_id TEXT, event_type TEXT, raw_ref TEXT, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
  `CREATE INDEX IF NOT EXISTS payments_user ON payments(user_id, at)`,
  `CREATE INDEX IF NOT EXISTS payments_pi ON payments(payment_intent)`,
];

/** Columns added after 0001 (mirrors migrations/0003_storyboard.sql + 0004_last_report.sql — one migration per column,
 *  in the same order as here). SQLite has no ADD COLUMN IF NOT EXISTS. */
const COLUMNS: [table: string, column: string, definition: string][] = [
  ["jobs", "storyboard", "TEXT"],
  ["jobs", "plan_attempts", "INTEGER NOT NULL DEFAULT 0"],
  ["jobs", "plan_error", "TEXT"],
  // Last time the worker on the instance said anything. The start timeout measures silence from here, not wall
  // clock since the GPU was rented: pulling a 15 GB image plus drawing 24 pictures keeps a healthy job under 8%
  // (state "starting") for well over fifteen minutes.
  ["jobs", "last_report_at", "TEXT"],
  // When the job entered the QUEUE (reset on every requeue), so the queue-wait reaper measures the wait for a GPU
  // and not the age of the job — a requeued job would otherwise be failed at once for a wait it never made.
  ["jobs", "queued_at", "TEXT"],
  // HMAC of the address a new account was opened from — never the address itself. It is what the daily per-address
  // cap counts, inside the INSERT that creates the account (src/db.ts createUserIfUnderCaps).
  ["users", "ip_hash", "TEXT"],
  // Machines already tried for THIS job, so a retry moves host instead of renting the one that just failed: the
  // requeue clears instance_id and instance_meta, which is exactly the memory the next attempt needed.
  ["jobs", "tried_machines", "TEXT"],
  ["jobs", "phase", "TEXT NOT NULL DEFAULT 'gen'"],   // gen (GPU: frames + clips) | finish (cheap box: track, voice, upload)
];

/** Indexes over columns from COLUMNS. They belong here and NOT in STATEMENTS: that batch runs before the ALTERs, so
 *  an index naming a column added above would fail on every request against a database that predates it. */
const COLUMN_INDEXES = [
  "CREATE INDEX IF NOT EXISTS users_ip_created ON users(ip_hash, created_at)",
];

async function ensureColumns(env: Env): Promise<void> {
  for (const [table, column, definition] of COLUMNS) {
    try {
      await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    } catch (e) {
      if (!/duplicate column/i.test(String(e))) throw e;
    }
  }
  for (const sql of COLUMN_INDEXES) await env.DB.prepare(sql).run();
}

let ready: Promise<void> | null = null;

export function ensureSchema(env: Env): Promise<void> {
  if (!ready) {
    ready = env.DB.batch(STATEMENTS.map((s) => env.DB.prepare(s))).then(() => ensureColumns(env)).catch((e) => { ready = null; throw e; });
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
/** Keeps a lock for `seconds` more (used to pause planning after a quota error). */
export const holdLock = (env: Env, name: string, seconds: number) =>
  env.DB.prepare("UPDATE locks SET until = ? WHERE name = ?").bind(new Date(Date.now() + seconds * 1000).toISOString(), name).run();
export const releaseLock = (env: Env, name: string) =>
  env.DB.prepare("UPDATE locks SET until = '1970-01-01T00:00:00Z' WHERE name = ?").bind(name).run();

/** A named time flag in the locks table (e.g. "plan_pause"): set for N seconds, then check. */
export async function setFlagUntil(env: Env, name: string, seconds: number): Promise<void> {
  const until = new Date(Date.now() + seconds * 1000).toISOString();
  await env.DB.prepare("INSERT OR IGNORE INTO locks (name, until) VALUES (?, '1970-01-01T00:00:00Z')").bind(name).run();
  await env.DB.prepare("UPDATE locks SET until = ? WHERE name = ?").bind(until, name).run();
}
export async function isFlagActive(env: Env, name: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT until FROM locks WHERE name = ? AND until > strftime('%Y-%m-%dT%H:%M:%fZ','now')").bind(name).first<{ until: string }>();
  return !!r;
}
