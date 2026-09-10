import type { Env } from "./env";

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  credits: number;
  plan: string;
  invite_code: string | null;
  created_at: string;
  last_seen_at: string | null;
}

export type JobState = "queued" | "starting" | "rendering" | "finishing" | "done" | "failed" | "cancelled";
export const ACTIVE_STATES: JobState[] = ["starting", "rendering", "finishing"];
export const OPEN_STATES: JobState[] = ["queued", ...ACTIVE_STATES];

export interface Job {
  id: string;
  user_id: string;
  template: string;
  prompt: string;
  params: string;
  state: JobState;
  track: string | null;
  percent: number;
  eta_min: number | null;
  credits: number;
  backend: string | null;
  instance_id: string | null;
  instance_meta: string | null;
  worker_secret: string;
  attempts: number;
  error: string | null;
  notify_email: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  expires_at: string | null;
  purged_at: string | null;
  cost_usd: number | null;
  /** ISO time of the last worker progress report; null until the worker speaks. */
  last_report_at?: string | null;
  /** ISO time the job entered the QUEUE, reset on every requeue; null on rows created before the column existed. */
  queued_at?: string | null;
  /** JSON array of machine keys already tried for this job ("m:<machine_id>" / "o:<offer_id>"); see migration 0008. */
  tried_machines?: string | null;
  storyboard: string | null; // JSON: Keou project without id/script_file/music_quiet/image scenes (see keou-contract.ts)
  plan_attempts: number;
  plan_error: string | null;
}

export interface JobParams {
  duration_s: number;
  format: "16:9" | "9:16";
  language: string;
  voice: string | null;
  /** Kleo visual style (keou-contract.ts KLEO_STYLES); absent on jobs created before styles existed (= cyber). */
  style?: string;
}

export interface JobFile {
  job_id: string;
  name: string;
  key: string;
  size: number;
  content_type: string;
}

export interface Invite {
  code: string;
  credits: number;
  max_uses: number;
  uses: number;
  note: string | null;
}

const inList = (states: JobState[]) => states.map((s) => `'${s}'`).join(",");

export const getUser = (env: Env, id: string) => env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();
/**
 * Nothing calls this today (accounts are anonymous: users.email holds a synthetic <id>@anon.kleo.invalid address).
 * It is kept on purpose as the seam for a real identity later — a Google sign-in, or the address Stripe collects:
 * that identity must be written onto the EXISTING row, keeping the same users.id, the same credits and the same
 * history. Creating a parallel account instead would 401 every client already connected to the old id.
 */
export const getUserByEmail = (env: Env, email: string) =>
  env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email.toLowerCase()).first<User>();

export async function createUser(env: Env, u: { id: string; email: string; credits: number; inviteCode?: string | null }): Promise<User> {
  await env.DB.prepare("INSERT INTO users (id, email, credits, invite_code) VALUES (?, ?, ?, ?)")
    .bind(u.id, u.email.toLowerCase(), u.credits, u.inviteCode ?? null).run();
  return (await getUser(env, u.id))!;
}
/** Accounts created since midnight UTC. created_at is ISO text, so the comparison is safely lexicographic. */
export async function countUsersCreatedToday(env: Env): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at >= strftime('%Y-%m-%dT00:00:00.000Z','now')").first<{ n: number }>();
  return r?.n ?? 0;
}
/** Accounts created today from one hashed address (users.ip_hash, never an address). */
export async function countUsersCreatedTodayForIp(env: Env, ipHash: string): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE ip_hash = ? AND created_at >= strftime('%Y-%m-%dT00:00:00.000Z','now')",
  ).bind(ipHash).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Why an account was not created, so the page can say the true thing: the day is over, or this address has had its share. */
export type CapVerdict = "created" | "day_full" | "address_full";

/**
 * Creates the account ONLY while both daily caps still allow it, as ONE statement: the counts live in the INSERT's
 * own WHERE, so there is no window between checking and writing. Checking first and inserting after — which is what
 * this replaced — lets a burst of simultaneous sign-ups all read "24 so far" and all get in.
 * A cap that was hit is reported by counting again afterwards; that second read is only there to choose the wording,
 * and being a moment stale cannot let anybody in.
 */
export async function createUserIfUnderCaps(
  env: Env,
  u: { id: string; email: string; credits: number; inviteCode?: string | null; ipHash: string | null },
  caps: { perDay: number; perAddressDay: number },
): Promise<{ verdict: CapVerdict; user?: User }> {
  const midnight = "strftime('%Y-%m-%dT00:00:00.000Z','now')";
  // The address clause is skipped for a request that arrives without one (local dev, an odd proxy): a missing
  // fingerprint must not become a free pass past the day cap, nor a wall in front of an honest visitor.
  const r = await env.DB.prepare(
    `INSERT INTO users (id, email, credits, invite_code, ip_hash)
     SELECT ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM users WHERE created_at >= ${midnight}) < ?
       AND (? IS NULL OR (SELECT COUNT(*) FROM users WHERE ip_hash = ? AND created_at >= ${midnight}) < ?)`,
  ).bind(u.id, u.email.toLowerCase(), u.credits, u.inviteCode ?? null, u.ipHash,
         caps.perDay, u.ipHash, u.ipHash, caps.perAddressDay).run();
  if ((r.meta.changes ?? 0) === 1) return { verdict: "created", user: (await getUser(env, u.id))! };
  const today = await countUsersCreatedToday(env);
  return { verdict: today >= caps.perDay ? "day_full" : "address_full" };
}
/**
 * Credits a gift code onto an account that already exists, at most once in its life: the UPDATE applies only while
 * invite_code is still empty, so a code cannot be re-typed on every reconnection to milk the same gift.
 */
export async function applyBonusToUser(env: Env, userId: string, code: string, credits: number): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE users SET credits = credits + ?, invite_code = ? WHERE id = ? AND invite_code IS NULL")
    .bind(credits, code, userId).run();
  return (r.meta.changes ?? 0) === 1;
}
export const touchUser = (env: Env, id: string) =>
  env.DB.prepare("UPDATE users SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").bind(id).run();

/**
 * Credit movements. Every one of them lands in the audit table as `credits.debit` / `credits.refund`
 * (amount, resulting balance, job, reason), so the owner can always reconstruct a user's balance.
 */
/** Atomic debit: succeeds only if the user has enough credits (single UPDATE, no read-then-write race). */
export async function debitCredits(env: Env, userId: string, amount: number, jobId: string | null = null): Promise<boolean> {
  if (amount <= 0) return true;
  const r = await env.DB.prepare("UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ?").bind(amount, userId, amount).run();
  if ((r.meta.changes ?? 0) !== 1) return false;
  await audit(env, userId, jobId, "credits.debit", { amount, balance: await balanceOf(env, userId) });
  return true;
}
/** Gives credits back (cancel, failure, rollback). Returns the amount actually refunded (0 for nothing). */
export async function refundCredits(env: Env, userId: string, amount: number, jobId: string | null, reason: string): Promise<number> {
  if (amount <= 0) return 0;
  await env.DB.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").bind(amount, userId).run();
  await audit(env, userId, jobId, "credits.refund", { amount, reason, balance: await balanceOf(env, userId) });
  return amount;
}
async function balanceOf(env: Env, userId: string): Promise<number | null> {
  const r = await env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(userId).first<{ credits: number }>();
  return r?.credits ?? null;
}

export const getInvite = (env: Env, code: string) => env.DB.prepare("SELECT * FROM invites WHERE code = ?").bind(code).first<Invite>();
export const useInvite = (env: Env, code: string) =>
  env.DB.prepare("UPDATE invites SET uses = uses + 1 WHERE code = ? AND uses < max_uses").bind(code).run();

/**
 * Adds a machine to the list this job has already tried. Append-only and idempotent: the list is a PREFERENCE the
 * renter reads, never a gate, so a duplicate costs nothing and a lost write only means one repeated attempt.
 */
export async function rememberTriedMachine(env: Env, jobId: string, key: string): Promise<void> {
  const row = await env.DB.prepare("SELECT tried_machines FROM jobs WHERE id = ?").bind(jobId).first<{ tried_machines: string | null }>();
  let tried: string[] = [];
  try { tried = JSON.parse(row?.tried_machines ?? "[]") as string[]; } catch { tried = []; }
  if (!Array.isArray(tried)) tried = [];
  if (tried.includes(key)) return;
  tried.push(key);
  await env.DB.prepare("UPDATE jobs SET tried_machines = ? WHERE id = ?").bind(JSON.stringify(tried.slice(-10)), jobId).run();
}

/** The machines this job has already been given and did not finish on. */
export function triedMachines(job: Pick<Job, "tried_machines">): string[] {
  try {
    const v = JSON.parse(job.tried_machines ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

export const getJob = (env: Env, id: string) => env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<Job>();
export const getUserJob = (env: Env, userId: string, id: string) =>
  env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").bind(id, userId).first<Job>();

export async function countOpenForUser(env: Env, userId: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND state IN (${inList(OPEN_STATES)})`).bind(userId).first<{ n: number }>();
  return r?.n ?? 0;
}
/**
 * Videos this account has STARTED since midnight UTC (countOpenForUser only sees the concurrent ones).
 * Failed and cancelled videos are NOT counted: their credits were given back, and a limit that counted them would
 * lock a user out of the day with credits they cannot spend — exactly the two failures a first visit is likeliest to hit.
 */
export async function countJobsTodayForUser(env: Env, userId: string): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND created_at >= strftime('%Y-%m-%dT00:00:00.000Z','now') AND state NOT IN ('failed','cancelled')"
  ).bind(userId).first<{ n: number }>();
  return r?.n ?? 0;
}
/**
 * GPU dollars written down against jobs of this UTC day. A finished job is dated by finished_at; a job that failed
 * a rental and went back to the queue has no finished_at yet, so it is dated by created_at — its rental still cost
 * money and the day's ceiling has to see it. Still an undercount: a GPU running right now has written nothing at all
 * (the orchestrator adds the in-flight term on top), and a job created before midnight that fails after it is missed.
 */
export async function spentTodayUsd(env: Env): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COALESCE(SUM(cost_usd),0) AS s FROM jobs WHERE COALESCE(finished_at, created_at) >= strftime('%Y-%m-%dT00:00:00.000Z','now')"
  ).first<{ s: number }>();
  return r?.s ?? 0;
}
export async function countRunning(env: Env): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE state IN (${inList(ACTIVE_STATES)})`).first<{ n: number }>();
  return r?.n ?? 0;
}
/**
 * The jobs holding a PAID GPU right now. Only these may be priced into the daily budget: a job claimed by a free
 * GitHub runner is 'starting' with backend 'pool' and costs nothing, so counting it would shut the paid path down
 * over money that was never committed (and audit a budget.paused the owner cannot reconcile with his Vast balance).
 */
export async function runningPaidJobs(env: Env): Promise<Job[]> {
  return (await env.DB.prepare(`SELECT * FROM jobs WHERE state IN (${inList(ACTIVE_STATES)}) AND backend = 'vast'`).all<Job>()).results;
}
/** Queued jobs that already have a storyboard: the only ones a GPU may be started for. */
export async function queuedJobs(env: Env, limit: number): Promise<Job[]> {
  if (limit <= 0) return [];
  return (await env.DB.prepare("SELECT * FROM jobs WHERE state = 'queued' AND storyboard IS NOT NULL ORDER BY created_at LIMIT ?").bind(limit).all<Job>()).results;
}
export async function unplannedJobs(env: Env, limit: number, maxAttempts: number): Promise<Job[]> {
  if (limit <= 0) return [];
  return (await env.DB.prepare("SELECT * FROM jobs WHERE state = 'queued' AND storyboard IS NULL AND plan_attempts < ? ORDER BY created_at LIMIT ?").bind(maxAttempts, limit).all<Job>()).results;
}
/** Atomically claims one planning attempt (so two overlapping ticks never plan the same job twice). */
export async function claimPlanAttempt(env: Env, id: string, expectedAttempts: number): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE jobs SET plan_attempts = plan_attempts + 1 WHERE id = ? AND plan_attempts = ? AND state = 'queued' AND storyboard IS NULL").bind(id, expectedAttempts).run();
  return (r.meta.changes ?? 0) === 1;
}
/**
 * Jobs still queued after `minutes`: nothing ever times out a queued job, so without this they wait for ever.
 * The clock is queued_at, not created_at: a job that rendered for an hour, failed and was legitimately requeued
 * would otherwise be killed on the spot with "no GPU was free in time", throwing away the retries it still had.
 * (COALESCE covers rows written before the column existed.)
 */
export async function staleQueuedJobs(env: Env, minutes: number, limit = 20): Promise<Job[]> {
  const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();
  return (await env.DB.prepare("SELECT * FROM jobs WHERE state = 'queued' AND COALESCE(queued_at, created_at) < ? ORDER BY created_at LIMIT ?").bind(cutoff, limit).all<Job>()).results;
}
export async function activeJobs(env: Env): Promise<Job[]> {
  return (await env.DB.prepare(`SELECT * FROM jobs WHERE state IN (${inList(ACTIVE_STATES)}) ORDER BY started_at`).all<Job>()).results;
}
export async function recentJobsForUser(env: Env, userId: string, limit = 10): Promise<Job[]> {
  return (await env.DB.prepare("SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").bind(userId, limit).all<Job>()).results;
}
export async function expiredJobs(env: Env, limit = 20): Promise<Job[]> {
  return (await env.DB.prepare(
    "SELECT * FROM jobs WHERE state = 'done' AND purged_at IS NULL AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now') LIMIT ?"
  ).bind(limit).all<Job>()).results;
}

export async function insertJob(env: Env, j: Job): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO jobs (id, user_id, template, prompt, params, state, percent, eta_min, credits, worker_secret, notify_email, created_at, queued_at, storyboard, plan_attempts, plan_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(j.id, j.user_id, j.template, j.prompt, j.params, j.state, j.percent, j.eta_min, j.credits, j.worker_secret, j.notify_email, j.created_at, j.queued_at ?? j.created_at, j.storyboard, j.plan_attempts, j.plan_error).run();
}

/**
 * Adds what one rental cost to the job's bill. One UPDATE, so nothing is lost between a read and a write, and it
 * ACCUMULATES: a job may rent up to MAX_ATTEMPTS times, and every one of those rentals is real money the daily
 * ceiling has to see — not only the rental of the attempt that happened to succeed.
 */
export const addJobCost = (env: Env, id: string, usd: number) =>
  env.DB.prepare("UPDATE jobs SET cost_usd = COALESCE(cost_usd, 0) + ? WHERE id = ?").bind(usd, id).run();

export async function updateJob(env: Env, id: string, fields: Partial<Job>): Promise<void> {
  const keys = Object.keys(fields) as (keyof Job)[];
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => fields[k] as unknown);
  await env.DB.prepare(`UPDATE jobs SET ${sets} WHERE id = ?`).bind(...values, id).run();
}
/**
 * Atomic state transition: applies `fields` only if the job is still in one of the `from` states.
 * Returns false when someone else moved the job first (cancelled, finished, failed...): the caller
 * must then skip every side effect tied to the transition (refund, e-mail, audit of the new state).
 * This single check is what makes refunds happen once and keeps the worker callbacks idempotent.
 */
export async function transitionJob(env: Env, id: string, from: JobState[], fields: Partial<Job>, expect: Partial<Job> = {}): Promise<boolean> {
  const keys = Object.keys(fields) as (keyof Job)[];
  if (!keys.length || !from.length) return false;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => fields[k] as unknown);
  // Optional compare-and-set on top of the state guard: the caller read a field and only wants the write if nobody
  // changed it in between (an `expect` value of null or undefined means "was still empty").
  const guards: string[] = [];
  const guardValues: unknown[] = [];
  for (const k of Object.keys(expect) as (keyof Job)[]) {
    const v = expect[k] as unknown;
    if (v === null || v === undefined) guards.push(`${k} IS NULL`);
    else { guards.push(`${k} = ?`); guardValues.push(v); }
  }
  const r = await env.DB.prepare(`UPDATE jobs SET ${sets} WHERE id = ? AND state IN (${inList(from)})${guards.map((g) => ` AND ${g}`).join("")}`)
    .bind(...values, id, ...guardValues).run();
  return (r.meta.changes ?? 0) === 1;
}

export const audit = (env: Env, userId: string | null, jobId: string | null, event: string, detail?: unknown) =>
  env.DB.prepare("INSERT INTO audit (user_id, job_id, event, detail) VALUES (?, ?, ?, ?)")
    .bind(userId, jobId, event, detail === undefined ? null : JSON.stringify(detail)).run();

export const setFile = (env: Env, f: JobFile) =>
  env.DB.prepare("INSERT OR REPLACE INTO job_files (job_id, name, key, size, content_type) VALUES (?, ?, ?, ?, ?)")
    .bind(f.job_id, f.name, f.key, f.size, f.content_type).run();
export async function listFiles(env: Env, jobId: string): Promise<JobFile[]> {
  return (await env.DB.prepare("SELECT * FROM job_files WHERE job_id = ?").bind(jobId).all<JobFile>()).results;
}
export const deleteFiles = (env: Env, jobId: string) => env.DB.prepare("DELETE FROM job_files WHERE job_id = ?").bind(jobId).run();

/** Atomic queued → starting transition; false if someone else took the job first. */
export async function reserveJob(env: Env, id: string, backend: string): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE jobs SET state = 'starting', backend = ?, started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), track = 'script', error = NULL WHERE id = ? AND state = 'queued'").bind(backend, id).run();
  return (r.meta.changes ?? 0) === 1;
}
/** Gives a reserved job back to the queue without burning an attempt (used when the provider itself is unavailable). */
export const unreserveJob = (env: Env, id: string) =>
  env.DB.prepare("UPDATE jobs SET state = 'queued', backend = NULL, instance_id = NULL, instance_meta = NULL, started_at = NULL, track = NULL WHERE id = ? AND state = 'starting' AND instance_id IS NULL").bind(id).run();
/** Hands the oldest planned queued job (queued for at least minQueuedMin minutes) to a pool runner. */
/**
 * The free pool runs on GitHub Actions: no GPU, so it cannot draw the scene pictures a cartoon / realistic
 * storyboard is made of (the server draws at most IMAGE_SERVER_MAX of them, a Short needs up to 24). A picture
 * job rendered there would come out as a slideshow of empty gradients, so the pool never takes one: it waits
 * for a real GPU instead. The tell is the stored storyboard's Keou style, which the validator normalises to
 * "picture" for every cartoon / realistic job; cyber and stickman jobs still use the free runners.
 */
const PICTURE_JOB = "COALESCE(json_extract(storyboard, '$.style'), '') = 'picture'";
const POOL_SKIP = `NOT (${PICTURE_JOB})`;

/**
 * Left on `error` (the only queued-job field the job view shows) when a picture job can do nothing but wait: the
 * free pool will never claim it and the GPU provider is unavailable. Written by the orchestrator, cleared by
 * reserveJob the moment a GPU is actually reserved. It is always the START of `error`: a real start error is kept
 * after it (see explainGpuWait), and `GPU_WAIT_EXPLAINED` below recognises the whole family by that prefix.
 */
export const GPU_ONLY_WAIT = "waiting for a free GPU: this visual style draws every picture on a GPU, so the free pool cannot render it";

/**
 * SQL for "this job already carries the wait explanation". The message contains no LIKE wildcard (% or _), so it is
 * its own pattern. Without this filter queuedPictureJobs kept handing back the same first twenty explained jobs and
 * every job past them stayed silent forever; explaining is one-shot, so the already-explained belong out of the page.
 */
const GPU_WAIT_EXPLAINED = "error LIKE ?";
const gpuWaitPattern = `${GPU_ONLY_WAIT}%`;

/**
 * Queued planned jobs the pool will never take (cartoon / realistic) and that have not been told why yet: they can
 * only wait for a GPU. Oldest first, so the longest-stranded job is explained first.
 */
export async function queuedPictureJobs(env: Env, limit = 20): Promise<Job[]> {
  return (await env.DB.prepare(
    `SELECT * FROM jobs WHERE state = 'queued' AND storyboard IS NOT NULL AND ${PICTURE_JOB} AND NOT (error IS NOT NULL AND ${GPU_WAIT_EXPLAINED}) ORDER BY created_at LIMIT ?`,
  ).bind(gpuWaitPattern, limit).all<Job>()).results;
}

/**
 * State and known instance of the given jobs, keyed by id. Vast labels carry the job id ("kleo-<id>"), so this is
 * what turns a list of live instances into "whose is this, and is it still wanted?" for the orphan sweep.
 */
export async function jobInstances(env: Env, ids: string[]): Promise<Map<string, { state: JobState; instance_id: string | null }>> {
  const out = new Map<string, { state: JobState; instance_id: string | null }>();
  for (let i = 0; i < ids.length; i += 50) { // D1 caps the number of bound parameters; ids come from an instance listing
    const chunk = ids.slice(i, i + 50);
    const rows = (await env.DB.prepare(`SELECT id, state, instance_id FROM jobs WHERE id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk).all<{ id: string; state: JobState; instance_id: string | null }>()).results;
    for (const r of rows) out.set(r.id, { state: r.state, instance_id: r.instance_id });
  }
  return out;
}

export async function claimQueuedJob(env: Env, instanceId: string, minQueuedMin: number): Promise<Job | null> {
  const cutoff = new Date(Date.now() - minQueuedMin * 60_000).toISOString();
  const rows = (await env.DB.prepare(`SELECT id FROM jobs WHERE state = 'queued' AND storyboard IS NOT NULL AND created_at <= ? AND ${POOL_SKIP} ORDER BY created_at LIMIT 5`).bind(cutoff).all<{ id: string }>()).results;
  for (const r of rows) {
    const u = await env.DB.prepare("UPDATE jobs SET state = 'starting', backend = 'pool', instance_id = ?, instance_meta = ?, started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), attempts = attempts + 1, track = 'script', error = NULL WHERE id = ? AND state = 'queued'")
      .bind(instanceId, JSON.stringify({ pool: true, runner: instanceId }), r.id).run();
    if ((u.meta.changes ?? 0) === 1) return await getJob(env, r.id);
  }
  return null;
}

/** How many planned jobs have been waiting in the queue for at least minQueuedMin minutes (pool demand). */
export async function poolWaitingJobs(env: Env, minQueuedMin: number): Promise<number> {
  const cutoff = new Date(Date.now() - minQueuedMin * 60_000).toISOString();
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE state = 'queued' AND storyboard IS NOT NULL AND created_at <= ? AND ${POOL_SKIP}`).bind(cutoff).first<{ n: number }>();
  return r?.n ?? 0;
}
