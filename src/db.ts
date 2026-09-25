import type { RequestSpec } from "./spec.ts";
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
  /** Which of the two render phases the job is in: "gen" (GPU) or "finish" (cheap CPU box). See migration 0010. */
  phase?: "gen" | "finish" | null;
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
  /**
   * True when NOBODY named the look: not the caller, not the storyboard. It is a guess, and the planner is allowed
   * to overturn it once the direction has actually read the request — which it could not do while every job carried
   * a style indistinguishable from one the user chose. Naming a style is a decision and is never overturned.
   */
  style_guessed?: boolean;
  /**
   * The style Kleo would have GUESSED, when that guess was replaced because it costs more than the cheapest.
   * Present only on that path, and only so the answer can say it out loud: a substitution nobody mentions hands
   * the user a different video from the one the system understood, with no way to find out why.
   */
  style_capped_from?: string;
  /**
   * The treatment the caller wrote or approved through kleo_adapt_prompt (src/treatment.ts). When present the
   * planner plans under it instead of writing its own: the user saw this film, so this is the film that gets made.
   */
  treatment?: Record<string, unknown>;
  /**
   * What is being made (src/templates.ts Product, 15 September 2026): "film" — every shot filmed by kie.ai, paid
   * accounts only — or "animatic" — the same stills with the camera over them and no generated clip, 5 credits flat.
   * Absent on every row made before that day, which means film.
   */
  product?: "film" | "animatic";
  /**
   * THE TWO OPTIONS THE USER IS ALWAYS ASKED (22 September 2026). `music`: the composer's brief for an instrumental
   * track under the narration, or null when the user said no; absent on rows made before that day (= none).
   * `subtitles`: true when the user asked for burned-in cinema subtitles, false when they said no; absent = the
   * treatment's own layer decides, as before.
   */
  music?: string | null;
  subtitles?: boolean;
  /**
   * THE SPEC (24 September 2026, src/spec.ts): the user's request taken apart into checkable requirements, written by
   * the assistant through kleo_adapt_prompt or by the server's planner. Everything after it is planned under it and
   * checked against it. Absent on rows made before that day and on calls without one (the planner writes it then).
   */
  spec?: RequestSpec;
  /** Handles of the reference images the user gave (src/refs.ts), in the order given. */
  refs?: string[];
  /**
   * The clip floor in seconds (src/footage.ts clipFloorFor, 25 September 2026): every shot of a film on the API road
   * carries at least this much voice, because each is a clip billed at the model's shortest length. Absent = 0.
   */
  clip_floor_s?: number;
  /**
   * THE AI UPSCALE (25 September 2026, src/templates.ts aiUpscaleCredits): true when the user said yes in the intake and
   * paid `ai_upscale_credits` on top of the film (they are part of job.credits). Absent on every other job. The
   * finish box's report is kept in `ai_upscale_result` (src/orchestrator.ts settleAiUpscale): applied, or not applied
   * and the extra credits refunded.
   */
  ai_upscale?: boolean;
  ai_upscale_credits?: number;
  ai_upscale_result?: { applied: boolean; parts: number; upscaled: number; model: string | null; gpu: string | null; reason: string | null; refunded: number; at: string };
  /** The intake's optional answers, as the user gave them: they used to die between kleo_adapt_prompt and the planner. */
  brief?: { audience?: string | null; tone?: string | null; must_keep?: string | null; /** The user's corrections after the read-back, in their words. */ corrections?: string | null };
  /** Where the server-drawn stills are (src/stills.ts): drawing, done, or failed (the rented GPU draws them then). */
  stills?: {
    state: "drawing" | "done" | "failed"; at: string; drawn?: number; total?: number; note?: string;
    /** Ticks that stopped on a transient Workers AI or store error and left the drawing to the next tick (24 September 2026). */
    pauses?: number;
    /** The road the pictures are drawn on ("workers-ai", "kie", "openrouter"): an external one gets a longer give-up (25 September 2026). */
    road?: string;
  };
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

/**
 * Credits a purchase, exactly once, whatever Stripe does.
 *
 * Stripe says out loud that its fulfilment function "may be called multiple times, even concurrently, for the same
 * Checkout Session", and the Dashboard can resend an event by hand for days. So the guard cannot be a SELECT
 * followed by an UPDATE — two simultaneous deliveries both read "not there yet" and both credit, which is 200
 * credits for one 40 EUR payment. The guard has to be the database constraint itself.
 *
 * Two statements, one D1 batch (which is a transaction), and the ORDER MATTERS: the UPDATE goes first, because its
 * NOT EXISTS has to read the payments table before the INSERT beside it fills it in. And the INSERT is OR IGNORE,
 * never a plain INSERT: a duplicate is a NORMAL event here, and letting it throw would answer 500, which Stripe
 * reads as failure — it would retry for three days and then switch the endpoint off. A harmless duplicate would
 * have killed the only way anybody can pay.
 *
 * Returns true when this call is the one that credited; false when the purchase was already recorded. An orphan
 * payment (userId null: the client_reference_id matched no account) still writes its row, because money that
 * arrived has to be written down even when nobody can be credited for it.
 */
export async function creditPurchase(env: Env, p: {
  sessionId: string; userId: string | null; credits: number; cents: number; currency: string;
  email: string | null; paymentIntent: string | null; eventId: string | null; eventType: string | null;
  country: string | null; rawRef: string | null;
}): Promise<boolean> {
  const rows = await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET credits = credits + ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM payments WHERE session_id = ?)`,
    ).bind(p.credits, p.userId ?? "", p.sessionId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO payments (session_id, user_id, credits, amount_cent, currency, email, payment_intent, event_id, event_type, country, raw_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(p.sessionId, p.userId, p.userId ? p.credits : 0, p.cents, p.currency, p.email, p.paymentIntent, p.eventId, p.eventType, p.country, p.rawRef),
  ]);
  // The INSERT is the authority on "was this the first time", not the UPDATE: an orphan payment credits nobody and
  // still has to be recorded exactly once.
  const first = (rows[1]?.meta.changes ?? 0) === 1;
  if (first) {
    await audit(env, p.userId, null, "credits.purchased", {
      credits: p.userId ? p.credits : 0, amount_cent: p.cents, currency: p.currency,
      session: p.sessionId, payment_intent: p.paymentIntent, orphan: !p.userId,
      balance: p.userId ? await balanceOf(env, p.userId) : null,
    });
  }
  return first;
}

/**
 * Takes back the credits of a purchase that was charged back. Unlike debitCredits this is NOT conditional on the
 * balance being enough, and it is allowed to go negative on purpose: the money is already gone from the Stripe
 * balance, plus a fee, and the alternative — refusing because the credits were already spent — would be paying for
 * the same purchase twice. A negative balance is an honest record, and every spend path already refuses to start a
 * video without enough credits, so it blocks nothing else.
 */
export async function takeBackCredits(env: Env, userId: string, amount: number, sessionId: string): Promise<void> {
  if (amount <= 0) return;
  await env.DB.prepare("UPDATE users SET credits = credits - ? WHERE id = ?").bind(amount, userId).run();
  await audit(env, userId, null, "credits.chargeback", { amount, session: sessionId, balance: await balanceOf(env, userId) });
}

/** The account a refund or a dispute belongs to. Those events carry a CHARGE, so the payment intent is the only way back. */
export const paymentByIntent = (env: Env, paymentIntent: string) =>
  env.DB.prepare("SELECT * FROM payments WHERE payment_intent = ?").bind(paymentIntent).first<{ session_id: string; user_id: string | null; credits: number; status: string }>();

/** Marks what happened to a payment afterwards ("refunded", "disputed"). Never touches the balance by itself. */
export const setPaymentStatus = (env: Env, sessionId: string, status: string) =>
  env.DB.prepare("UPDATE payments SET status = ? WHERE session_id = ?").bind(status, sessionId).run();

/**
 * Whether this account has ever PAID: one Stripe payment on record that still stands (a refund or a dispute takes
 * it back). This is what opens the FILM (src/templates.ts, the two products of 15 September 2026): the clips are
 * bought from kie.ai with the owner's money, so gifted credits, bonus rows and balances typed in by hand may buy an
 * animatic and nothing filmed. A tester is let in the same way a customer is — one row in `payments` — never by a
 * flag on the user: `INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, status, raw_ref)
 * VALUES ('manual_<who>_<date>', '<user id>', 0, 0, 'eur', 'paid', 'tester')`, and the audit trail keeps its shape.
 */
export const hasPaid = async (env: Env, userId: string): Promise<boolean> =>
  !!(await env.DB.prepare("SELECT 1 AS one FROM payments WHERE user_id = ? AND status = 'paid' LIMIT 1").bind(userId).first<{ one: number }>());

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
/** Audit rows of one event for one user in this UTC day: the counter behind per-account daily caps that are not jobs. */
export async function countAuditTodayForUser(env: Env, userId: string, event: string): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM audit WHERE user_id = ? AND event = ? AND at >= strftime('%Y-%m-%dT00:00:00.000Z','now')"
  ).bind(userId, event).first<{ n: number }>();
  return r?.n ?? 0;
}
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
/**
 * The jobs whose files are purged now: a DONE job once its links expired (expires_at), and — since 24 September 2026 —
 * a job that ended without a film too. The stills engine draws up to 48 stills, six character sheets (from the user's
 * own photo when there is one) and fidelity.json while the job is still QUEUED, before any GPU; a job cancelled while
 * it waited, or failed (no GPU in time, a start error), never reached "done", so this query never returned it and those
 * objects — likeness sheets of real people included — stayed on R2 for ever. A FAILED job keeps its files for the
 * same RESULT_TTL_DAYS as a finished one (counted from finished_at): the owner's /internal/admin/retry re-queues a film
 * that failed in its finish phase with the clips and music it already paid for, and that needs them. A CANCELLED job
 * is kept `cancelledGraceMin` only: nothing reads its files again, the grace just lets a worker that was still
 * uploading when the user cancelled finish before the files are listed (a file written after the purge would be kept
 * for ever, purged_at is set once).
 */
export async function expiredJobs(env: Env, limit = 20, opts: { ttlDays?: number; cancelledGraceMin?: number } = {}): Promise<Job[]> {
  const ttlDays = Math.max(1, Number.isFinite(opts.ttlDays) ? Number(opts.ttlDays) : 7);
  const graceMin = Math.max(0, Number.isFinite(opts.cancelledGraceMin) ? Number(opts.cancelledGraceMin) : 60);
  const failedBefore = new Date(Date.now() - ttlDays * 86_400_000).toISOString();
  const cancelledBefore = new Date(Date.now() - graceMin * 60_000).toISOString();
  return (await env.DB.prepare(
    `SELECT * FROM jobs WHERE purged_at IS NULL AND (
       (state = 'done' AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       OR (state = 'failed' AND finished_at IS NOT NULL AND finished_at < ?)
       OR (state = 'cancelled' AND COALESCE(finished_at, created_at) < ?)
     ) LIMIT ?`
  ).bind(failedBefore, cancelledBefore, limit).all<Job>()).results;
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
 * SQL for "this job already carries the wait explanation": the explanation is the START of `error`. Without this
 * filter queuedPictureJobs kept handing back the same first twenty explained jobs and every job past them stayed
 * silent forever; explaining is one-shot, so the already-explained belong out of the page.
 *
 * NOT `error LIKE ?` with the sentence plus "%". D1 refuses any LIKE pattern longer than 50 bytes ("LIKE or GLOB
 * pattern too complex", measured 12 September: 40 bytes pass, 60 fail) and this sentence is 110. SQLite evaluates
 * the LIKE only when `error` is not NULL, so the query worked exactly once — while the job had no error yet — and
 * from the tick after, once the explanation was written, every tick died with cron.error at this line: 445 of them
 * in two days, and everything after explainGpuWait in the tick (the pool runners) never ran. instr() has no limit.
 */
const GPU_WAIT_EXPLAINED = "instr(error, ?) = 1";
const gpuWaitPattern = GPU_ONLY_WAIT;

/**
 * Left on `error` when a job cannot even be PLANNED: Kleo writes the storyboard with Workers AI, whose free daily
 * allowance runs out, and a job with no storyboard is never given a GPU. Until today that job simply sat at
 * "queued, 0%, about 18 minutes" for ever, while the reason was sitting in plan_error where no user can see it.
 * A status that repeats a promise it cannot keep is worse than an error: the person keeps waiting.
 *
 * It used to say the allowance "comes back after midnight UTC". Measured on 11 September 2026: exhausted the evening
 * before, still refused at 00:15 UTC. A user told "after midnight" who is still waiting at 01:00 has been lied to
 * by the status line — which is the exact thing this sentence exists to stop.
 */
export const PLAN_WAIT =
  "waiting: Kleo cannot write the storyboard itself right now, because its daily free AI allowance is used up (it comes back within a day; the exact hour is not published and was measured to NOT be midnight UTC). Nothing else is wrong, and no GPU is running. Two ways out, both immediate: your assistant can write the storyboard itself with kleo_storyboard_guide and call kleo_create_video again passing it — that path never needs Kleo's AI and costs the same — or cancel this one with kleo_cancel_job and get the credits straight back";

const PLAN_WAIT_EXPLAINED = "instr(error, ?) = 1"; // same reason as GPU_WAIT_EXPLAINED: 530 bytes, LIKE would refuse it
const planWaitPattern = PLAN_WAIT;

/**
 * Queued jobs with no storyboard that have not been told why yet. Oldest first, and only while planning is actually
 * paused — a job waiting its normal turn in the planner is not stuck and must not be told that it is.
 */
export async function unexplainedUnplannedJobs(env: Env, limit = 20): Promise<Job[]> {
  return (await env.DB.prepare(
    `SELECT * FROM jobs WHERE state = 'queued' AND storyboard IS NULL AND NOT (error IS NOT NULL AND ${PLAN_WAIT_EXPLAINED}) ORDER BY created_at LIMIT ?`,
  ).bind(planWaitPattern, limit).all<Job>()).results;
}

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

/**
 * Merges `patch` into a job's params (shallow: a key of the patch replaces the whole key of the params) and returns
 * the params as written, or null when the job does not exist (24 September 2026, the fidelity engine: the stills
 * engine writes params.stills on every tick it draws, the planner params.spec once).
 *
 * A compare-and-set on the params text, retried three times: two writers of the SAME row (the cron drawing stills and
 * the worker's POST /images asking for the ones still missing) must not erase each other's key with a stale copy of
 * the rest. A write that loses three times in a row is dropped — params.stills is a progress note, and the next tick
 * writes it again.
 */
export async function updateJobParams(env: Env, id: string, patch: Partial<JobParams>): Promise<JobParams | null> {
  for (let i = 0; i < 3; i++) {
    const row = await env.DB.prepare("SELECT params FROM jobs WHERE id = ?").bind(id).first<{ params: string }>();
    if (!row) return null;
    let cur: Record<string, unknown> = {};
    try { const p = JSON.parse(row.params) as unknown; if (p && typeof p === "object" && !Array.isArray(p)) cur = p as Record<string, unknown>; } catch { /* unreadable params: rewritten from the patch */ }
    const next = { ...cur, ...patch } as JobParams;
    const r = await env.DB.prepare("UPDATE jobs SET params = ? WHERE id = ? AND params = ?").bind(JSON.stringify(next), id, row.params).run();
    if ((r.meta.changes ?? 0) === 1) return next;
  }
  return null;
}

/**
 * AN OWNED LOCK (24 September 2026, the stills engine). The plain lock of src/schema.ts (acquireLock/releaseLock) has
 * no owner: its release sets `until` to 1970 whoever holds it. For the stills lock that was a real double draw: a tick
 * whose Workers AI answered slowly was still drawing when its lock expired, the next cron took the lock and — the first
 * tick's pictures not stored yet — paid for the same pictures again, and when the first tick finished its release freed
 * the SECOND tick's lock, so a third could enter too.
 *
 * The locks table has two columns (name, until) and its schema is not this module's, so the owner rides in `until`
 * itself: "<ISO expiry>~<owner token>". The ISO part keeps the table's one rule working unchanged — `until < now` is
 * a string comparison, and the suffix only decides a tie inside the same millisecond (as "not expired yet"). Every
 * write of an owner is a compare-and-set on its own token: renew extends only a lock this owner still holds, release
 * frees only that one, and both answer whether they did.
 */
export interface OwnedLock { name: string; owner: string }
const LOCK_OWNER_SEP = "~";
const lockUntil = (seconds: number, owner: string): string => `${new Date(Date.now() + seconds * 1000).toISOString()}${LOCK_OWNER_SEP}${owner}`;
const lockSuffix = (owner: string): string => `${LOCK_OWNER_SEP}${owner}`;
export async function acquireOwnedLock(env: Env, name: string, seconds: number, owner: string = crypto.randomUUID()): Promise<OwnedLock | null> {
  await env.DB.prepare("INSERT OR IGNORE INTO locks (name, until) VALUES (?, '1970-01-01T00:00:00Z')").bind(name).run();
  const r = await env.DB.prepare("UPDATE locks SET until = ? WHERE name = ? AND until < strftime('%Y-%m-%dT%H:%M:%fZ','now')").bind(lockUntil(seconds, owner), name).run();
  return (r.meta.changes ?? 0) === 1 ? { name, owner } : null;
}
/**
 * Extends the lock by `seconds` from now, only while `lock.owner` still holds it; false when it was lost. A lock that
 * expired but that nobody took since still carries this owner's token and is renewed: the compare-and-set is on the
 * token, so a tick that took it in between has already overwritten the token and this renew changes nothing.
 */
export async function renewOwnedLock(env: Env, lock: OwnedLock, seconds: number): Promise<boolean> {
  const suffix = lockSuffix(lock.owner);
  const r = await env.DB.prepare("UPDATE locks SET until = ? WHERE name = ? AND substr(until, -?) = ?").bind(lockUntil(seconds, lock.owner), lock.name, suffix.length, suffix).run();
  return (r.meta.changes ?? 0) === 1;
}
/** Frees the lock only when `lock.owner` still holds it: a lock another tick took after this one expired is left alone. */
export async function releaseOwnedLock(env: Env, lock: OwnedLock): Promise<boolean> {
  const suffix = lockSuffix(lock.owner);
  const r = await env.DB.prepare("UPDATE locks SET until = '1970-01-01T00:00:00Z' WHERE name = ? AND substr(until, -?) = ?").bind(lock.name, suffix.length, suffix).run();
  return (r.meta.changes ?? 0) === 1;
}
