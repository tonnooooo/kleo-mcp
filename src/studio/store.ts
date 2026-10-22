/**
 * KLEO STUDIO — ITS TABLES. They live in the MCP server's D1 database next to `users`, `payments` and `audit`, and
 * are created here on first use (CREATE … IF NOT EXISTS, once per isolate), the same way src/schema.ts creates the
 * server's. migrations/0017_studio.sql holds the same statements for the record.
 *
 *   studio_logins       how a person signs in: provider 'password' (subject = e-mail) or 'google' (subject = sub)
 *   studio_chats        one conversation
 *   studio_messages     one line of it (role user|assistant; `data` holds attachments, a proposal or a clip id)
 *   studio_uploads      a picture a person attached
 *   studio_generations  one clip: settings, credits, provider task, state, stored file
 */
import type { StudioEnv } from "./env.ts";
import { PROVIDER_STATUS_SCHEMA } from "./providers.ts";

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
export const STUDIO_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS studio_logins (
    provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT, secret TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW}, last_login_at TEXT, PRIMARY KEY (provider, subject))`,
  `CREATE INDEX IF NOT EXISTS studio_logins_user ON studio_logins (user_id)`,
  `CREATE TABLE IF NOT EXISTS studio_chats (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW}, updated_at TEXT NOT NULL DEFAULT ${NOW}, deleted_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS studio_chats_user ON studio_chats (user_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS studio_messages (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT, data TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW})`,
  `CREATE INDEX IF NOT EXISTS studio_messages_chat ON studio_messages (chat_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS studio_uploads (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, key TEXT NOT NULL, content_type TEXT, size INTEGER,
    width INTEGER, height INTEGER, created_at TEXT NOT NULL DEFAULT ${NOW})`,
  `CREATE INDEX IF NOT EXISTS studio_uploads_user ON studio_uploads (user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS studio_generations (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT, message_id TEXT, model TEXT NOT NULL,
    settings TEXT NOT NULL, prompt TEXT NOT NULL, images TEXT, credits INTEGER NOT NULL, est_usd REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL, task_id TEXT, error TEXT, file_key TEXT, size INTEGER, usage TEXT, refunded INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT ${NOW}, updated_at TEXT NOT NULL DEFAULT ${NOW}, checked_at TEXT, finished_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS studio_generations_user ON studio_generations (user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS studio_generations_status ON studio_generations (status, checked_at)`,
  // What each provider can still spend, and when the owner was last told (src/studio/providers.ts, 23 October 2026).
  PROVIDER_STATUS_SCHEMA,
];

/**
 * THE ADMIN CONSOLE (migrations/0026_studio_admin.sql, 23 October 2026): where people sign in from (src/studio/ips.ts),
 * kept 90 days, created with the tables above.
 */
export const STUDIO_ADMIN_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS studio_ips (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, at TEXT NOT NULL DEFAULT ${NOW}, event TEXT NOT NULL,
    ip TEXT, ip_hash TEXT, country TEXT, region TEXT, city TEXT, asn INTEGER, as_org TEXT, ua TEXT)`,
  `CREATE INDEX IF NOT EXISTS studio_ips_user ON studio_ips (user_id, at)`,
  `CREATE INDEX IF NOT EXISTS studio_ips_at ON studio_ips (at)`,
  `CREATE INDEX IF NOT EXISTS studio_ips_ip ON studio_ips (ip)`,
];

/**
 * The admin console's indexes on the MCP server's audit table (its user timeline and its failure list), made once per
 * isolate after the tables above. Best effort: the audit table is the MCP server's, and a database without it (a test's)
 * simply goes without them.
 */
export const STUDIO_AUDIT_INDEXES: string[] = [
  `CREATE INDEX IF NOT EXISTS audit_user ON audit (user_id, id)`,
  `CREATE INDEX IF NOT EXISTS audit_job ON audit (job_id)`,
];

/**
 * Columns added after the tables first went live (migrations/0018_studio_images.sql): images made one generation of
 * several pictures, each its own provider task ("slots").
 */
export const STUDIO_COLUMNS: string[] = [
  "ALTER TABLE studio_generations ADD COLUMN kind TEXT NOT NULL DEFAULT 'video'",
  "ALTER TABLE studio_generations ADD COLUMN slots TEXT",
  // migrations/0019_studio_media.sql: uploads may be video or sound clips, with their length read by the Worker.
  "ALTER TABLE studio_uploads ADD COLUMN kind TEXT NOT NULL DEFAULT 'image'",
  "ALTER TABLE studio_uploads ADD COLUMN duration REAL",
  // migrations/0020_security.sql: revocable Kleo keys and sessions.
  "ALTER TABLE users ADD COLUMN key_version INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN studio_epoch INTEGER NOT NULL DEFAULT 0",
  // migrations/0024_studio_auto_wan.sql: the account's "switch to Wan 3.0 by itself" choice (generate.ts switchToWan).
  "ALTER TABLE users ADD COLUMN studio_auto_wan INTEGER NOT NULL DEFAULT 0",
  // migrations/0026_studio_admin.sql: an account the owner closed from the console (src/studio/admin.ts).
  "ALTER TABLE users ADD COLUMN blocked_at TEXT",
  "ALTER TABLE users ADD COLUMN blocked_reason TEXT",
];

/** Whether the account chose to have copyright refusals made on Wan 3.0 by themselves. */
export const autoWanOn = async (env: StudioEnv, userId: string): Promise<boolean> =>
  !!(await env.DB.prepare("SELECT studio_auto_wan AS on_ FROM users WHERE id = ?").bind(userId).first<{ on_: number }>())?.on_;
export const setAutoWan = (env: StudioEnv, userId: string, on: boolean) =>
  env.DB.prepare("UPDATE users SET studio_auto_wan = ? WHERE id = ?").bind(on ? 1 : 0, userId).run();

/**
 * Whether this isolate has checked the tables. A FLAG, never a promise shared between requests (20 October 2026): the
 * check used to be one promise kept for the isolate, and a promise started by one request never settles once that
 * request is gone (its I/O is cancelled with it). Every later /api/ call on the isolate then waited on it for ever,
 * with no CPU, until the browser gave up: the app stayed on its logo on the owner's computer while his phone, on another
 * isolate, worked. Now each request runs its own check until one has passed; two first requests may both run it, and
 * every statement in it is idempotent.
 */
let schemaChecked = false;
export async function ensureStudioSchema(env: StudioEnv): Promise<void> {
  if (schemaChecked) return;
  await env.DB.batch([...STUDIO_SCHEMA, ...STUDIO_ADMIN_SCHEMA].map((s) => env.DB.prepare(s)));
  try { await env.DB.batch(STUDIO_AUDIT_INDEXES.map((s) => env.DB.prepare(s))); } catch { /* no audit table here */ }
  for (const sql of await missingColumns(env, STUDIO_COLUMNS)) {
    try { await env.DB.prepare(sql).run(); } catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
  }
  schemaChecked = true;
}

/**
 * The ALTERs whose column is not there yet, read in one batch of pragma_table_info queries instead of trying every
 * ALTER on every new isolate (seven round trips to D1, each answered "duplicate column"). Any trouble reading the
 * columns answers all of them, and the ALTERs say for themselves which already exist.
 */
async function missingColumns(env: StudioEnv, alters: string[]): Promise<string[]> {
  const parsed = alters.map((sql) => ({ sql, m: /^ALTER TABLE (\w+) ADD COLUMN (\w+)/i.exec(sql) }));
  const tables = [...new Set(parsed.map((p) => p.m?.[1]).filter((t): t is string => !!t))];
  try {
    const rows = await env.DB.batch(tables.map((t) => env.DB.prepare("SELECT name FROM pragma_table_info(?)").bind(t)));
    const have = new Map(tables.map((t, i) => [t, new Set(((rows[i] as { results?: { name: string }[] })?.results ?? []).map((r) => r.name))]));
    return parsed.filter((p) => !p.m || !have.get(p.m[1])?.has(p.m[2])).map((p) => p.sql);
  } catch {
    return alters;
  }
}

export interface LoginRow { provider: string; subject: string; user_id: string; email: string | null; secret: string | null }
export interface ChatRow { id: string; user_id: string; title: string | null; created_at: string; updated_at: string }
export interface MessageRow { id: string; chat_id: string; user_id: string; role: "user" | "assistant"; text: string | null; data: string | null; created_at: string }
export interface UploadRow { id: string; user_id: string; key: string; content_type: string | null; size: number | null; width: number | null; height: number | null; created_at: string; kind?: "image" | "video" | "audio"; duration?: number | null }
export type GenStatus = "submitting" | "running" | "saving" | "done" | "failed";
export interface GenerationRow {
  id: string; user_id: string; chat_id: string | null; message_id: string | null; model: string; settings: string;
  prompt: string; images: string | null; credits: number; est_usd: number; status: GenStatus; task_id: string | null;
  error: string | null; file_key: string | null; size: number | null; usage: string | null; refunded: number;
  created_at: string; updated_at: string; checked_at: string | null; finished_at: string | null;
  kind: "video" | "image" | "tool" | "film"; slots: string | null;
}
/** One picture of an image generation: its provider task and, once saved, its file and its upload id. */
export interface Slot {
  task: string | null; status: "running" | "done" | "failed"; key?: string; upload?: string; error?: string; type?: "image" | "video" | "audio"; model?: string;
  /** The provider holding `task`: ePhone when absent; WaveSpeed for the viral templates; APIMart or WaveSpeed when the
   *  order went to a backup (src/studio/backups.ts). */
  provider?: "wavespeed" | "apimart";
  /** The task to start when this one finishes ("{{prev}}" in its input = this task's result link); see generate.ts. */
  then?: { model: string; input: Record<string, unknown>; output: "image" | "video" | "audio"; routing?: Record<string, string> };
  /** Second tries on FLUX 3 when the provider refuses this picture (src/studio/image-models.ts imageAlternatives). */
  alts?: { model: string; input: Record<string, unknown>; when: "refusal" | "protected" }[];
}

export const getLogin = (env: StudioEnv, provider: string, subject: string) =>
  env.DB.prepare("SELECT * FROM studio_logins WHERE provider = ? AND subject = ?").bind(provider, subject).first<LoginRow>();
export const loginsOf = async (env: StudioEnv, userId: string) =>
  (await env.DB.prepare("SELECT provider, subject, email FROM studio_logins WHERE user_id = ?").bind(userId).all<LoginRow>()).results;
/** Adds a sign-in method; false when that e-mail or Google account already belongs to somebody. */
export async function addLogin(env: StudioEnv, l: { provider: string; subject: string; userId: string; email: string | null; secret: string | null }): Promise<boolean> {
  const r = await env.DB.prepare("INSERT OR IGNORE INTO studio_logins (provider, subject, user_id, email, secret) VALUES (?, ?, ?, ?, ?)")
    .bind(l.provider, l.subject, l.userId, l.email, l.secret).run();
  return (r.meta.changes ?? 0) === 1;
}
export const touchLogin = (env: StudioEnv, provider: string, subject: string) =>
  env.DB.prepare(`UPDATE studio_logins SET last_login_at = ${NOW} WHERE provider = ? AND subject = ?`).bind(provider, subject).run();

export const listChats = async (env: StudioEnv, userId: string, limit = 50) =>
  (await env.DB.prepare("SELECT id, title, created_at, updated_at FROM studio_chats WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?")
    .bind(userId, limit).all<ChatRow>()).results;
export const getChat = (env: StudioEnv, userId: string, id: string) =>
  env.DB.prepare("SELECT * FROM studio_chats WHERE id = ? AND user_id = ? AND deleted_at IS NULL").bind(id, userId).first<ChatRow>();
export const createChat = (env: StudioEnv, id: string, userId: string, title: string) =>
  env.DB.prepare("INSERT INTO studio_chats (id, user_id, title) VALUES (?, ?, ?)").bind(id, userId, title.slice(0, 80)).run();
export const touchChat = (env: StudioEnv, id: string) =>
  env.DB.prepare(`UPDATE studio_chats SET updated_at = ${NOW} WHERE id = ?`).bind(id).run();
export const renameChat = (env: StudioEnv, userId: string, id: string, title: string) =>
  env.DB.prepare("UPDATE studio_chats SET title = ? WHERE id = ? AND user_id = ?").bind(title.slice(0, 80), id, userId).run();
export const deleteChat = (env: StudioEnv, userId: string, id: string) =>
  env.DB.prepare(`UPDATE studio_chats SET deleted_at = ${NOW} WHERE id = ? AND user_id = ?`).bind(id, userId).run();

export const listMessages = async (env: StudioEnv, chatId: string, limit = 200) =>
  (await env.DB.prepare("SELECT * FROM (SELECT * FROM studio_messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC")
    .bind(chatId, limit).all<MessageRow>()).results;
export const addMessage = (env: StudioEnv, m: { id: string; chatId: string; userId: string; role: "user" | "assistant"; text: string | null; data: unknown }) =>
  env.DB.prepare("INSERT INTO studio_messages (id, chat_id, user_id, role, text, data) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(m.id, m.chatId, m.userId, m.role, m.text, m.data === undefined || m.data === null ? null : JSON.stringify(m.data)).run();
export const getMessage = (env: StudioEnv, userId: string, id: string) =>
  env.DB.prepare("SELECT * FROM studio_messages WHERE id = ? AND user_id = ?").bind(id, userId).first<MessageRow>();
export const setMessageData = (env: StudioEnv, id: string, data: unknown) =>
  env.DB.prepare("UPDATE studio_messages SET data = ? WHERE id = ?").bind(JSON.stringify(data), id).run();
/** Agent messages this account sent since midnight UTC (the daily chat cap). */
export async function agentMessagesToday(env: StudioEnv, userId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM studio_messages WHERE user_id = ? AND role = 'user' AND created_at >= strftime('%Y-%m-%dT00:00:00.000Z','now')")
    .bind(userId).first<{ n: number }>();
  return r?.n ?? 0;
}

export const addUpload = (env: StudioEnv, u: { id: string; userId: string; key: string; contentType: string; size: number; width: number | null; height: number | null; kind?: "image" | "video" | "audio"; duration?: number | null }) =>
  env.DB.prepare("INSERT INTO studio_uploads (id, user_id, key, content_type, size, width, height, kind, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(u.id, u.userId, u.key, u.contentType, u.size, u.width, u.height, u.kind ?? "image", u.duration ?? null).run();
export const getUpload = (env: StudioEnv, id: string) =>
  env.DB.prepare("SELECT * FROM studio_uploads WHERE id = ?").bind(id).first<UploadRow>();
/** The uploads of one account among `ids`, in the order asked (unknown or foreign ids are dropped). */
export async function uploadsOf(env: StudioEnv, userId: string, ids: string[]): Promise<UploadRow[]> {
  const clean = [...new Set(ids.filter((i) => /^up_[a-z0-9]{6,20}$/.test(i)))].slice(0, 12);
  if (!clean.length) return [];
  const rows = (await env.DB.prepare(`SELECT * FROM studio_uploads WHERE user_id = ? AND id IN (${clean.map(() => "?").join(",")})`)
    .bind(userId, ...clean).all<UploadRow>()).results;
  return clean.map((id) => rows.find((r) => r.id === id)).filter((r): r is UploadRow => !!r);
}

export const getGeneration = (env: StudioEnv, id: string) =>
  env.DB.prepare("SELECT * FROM studio_generations WHERE id = ?").bind(id).first<GenerationRow>();
export async function listGenerations(env: StudioEnv, userId: string, limit = 60, before?: string, filter: { model?: string; kind?: string } = {}) {
  const where = ["user_id = ?"], args: (string | number)[] = [userId];
  if (before) { where.push("created_at < ?"); args.push(before); }
  if (filter.model) { where.push("model = ?"); args.push(filter.model); }
  if (filter.kind) { where.push("kind = ?"); args.push(filter.kind); }
  return (await env.DB.prepare(`SELECT * FROM studio_generations WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
    .bind(...args, limit).all<GenerationRow>()).results;
}
export async function runningCount(env: StudioEnv, userId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM studio_generations WHERE user_id = ? AND status IN ('submitting','running','saving')").bind(userId).first<{ n: number }>();
  return r?.n ?? 0;
}
/** Provider dollars committed since midnight UTC by clips that did not fail (the daily budget). */
/** Today's provider spend (UTC day); `unpaidOnly` counts only accounts with no payment on record (the free pool). */
export async function studioSpentTodayUsd(env: StudioEnv, o: { unpaidOnly?: boolean } = {}): Promise<number> {
  const unpaid = o.unpaidOnly ? " AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.user_id = g.user_id AND p.status = 'paid')" : "";
  // The owner's admin accounts (generate.ts isAdmin) never fill the day for customers.
  const admins = JSON.stringify((env.STUDIO_ADMINS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const r = await env.DB.prepare(`SELECT COALESCE(SUM(g.est_usd), 0) AS usd FROM studio_generations g WHERE g.status != 'failed' AND g.created_at >= strftime('%Y-%m-%dT00:00:00.000Z','now')${unpaid}
      AND g.user_id NOT IN (SELECT value FROM json_each(?))`).bind(admins)
    .first<{ usd: number }>();
  return r?.usd ?? 0;
}
export const insertGeneration = (env: StudioEnv, g: { id: string; userId: string; chatId: string | null; messageId: string | null; model: string; settings: unknown; prompt: string; images: string[]; credits: number; estUsd: number; kind?: "video" | "image" | "tool" | "film" }) =>
  env.DB.prepare(`INSERT INTO studio_generations (id, user_id, chat_id, message_id, model, settings, prompt, images, credits, est_usd, status, checked_at, kind)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitting', ${NOW}, ?)`)
    .bind(g.id, g.userId, g.chatId, g.messageId, g.model, JSON.stringify(g.settings), g.prompt, JSON.stringify(g.images), g.credits, g.estUsd, g.kind ?? "video").run();
/**
 * Settles one offer on a refused creation (generate.ts): "wan" = make the clip again on Wan 3.0 (retryOnWan), "rewrite" =
 * make it again with its names turned into descriptions (retryDescribed). `settings.<field>` becomes the new creation's
 * id, or "declined". One compare-and-set, so two taps can never start two: false when it was settled already. `null`
 * reopens it (the new creation could not even be written down).
 */
export async function settleOffer(env: StudioEnv, id: string, userId: string, field: "wan" | "rewrite", value: string | null): Promise<boolean> {
  const path = `$.${field}`;
  const r = value === null
    ? await env.DB.prepare(`UPDATE studio_generations SET settings = json_remove(settings, ?), updated_at = ${NOW} WHERE id = ? AND user_id = ?`).bind(path, id, userId).run()
    : await env.DB.prepare(`UPDATE studio_generations SET settings = json_set(settings, ?, ?), updated_at = ${NOW}
        WHERE id = ? AND user_id = ? AND status = 'failed' AND json_extract(settings, ?) IS NULL`).bind(path, value, id, userId, path).run();
  return (r.meta.changes ?? 0) === 1;
}
/**
 * Moves a clip from one of `from` to `to`, writing `fields` with it, as ONE compare-and-set: the caller learns
 * whether IT made the move. Two polls racing on the same finished task cannot both save it, and a refund is paid
 * only by the call that moved the clip to failed.
 */
export async function moveGeneration(env: StudioEnv, id: string, from: GenStatus[], to: GenStatus, fields: Record<string, string | number | null> = {}): Promise<boolean> {
  const keys = Object.keys(fields);
  const sets = [`status = ?`, `updated_at = ${NOW}`, ...keys.map((k) => `${k} = ?`)];
  if (to === "done" || to === "failed") sets.push(`finished_at = ${NOW}`);
  const r = await env.DB.prepare(`UPDATE studio_generations SET ${sets.join(", ")} WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`)
    .bind(to, ...keys.map((k) => fields[k]), id, ...from).run();
  return (r.meta.changes ?? 0) === 1;
}
export const markChecked = (env: StudioEnv, id: string) =>
  env.DB.prepare(`UPDATE studio_generations SET checked_at = ${NOW} WHERE id = ?`).bind(id).run();
/** Clips the cron should look at: still in flight and not looked at for `seconds`. */
export const staleGenerations = async (env: StudioEnv, seconds: number, limit = 25) =>
  (await env.DB.prepare(`SELECT * FROM studio_generations WHERE status IN ('submitting','running','saving')
      AND (checked_at IS NULL OR checked_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)) ORDER BY checked_at ASC LIMIT ?`)
    .bind(`-${seconds} seconds`, limit).all<GenerationRow>()).results;
