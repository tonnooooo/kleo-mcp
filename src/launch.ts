import type { Env } from "./env";
import type { Job, JobParams } from "./db";
import { audit } from "./db.ts";
import { filmCredits, MIN_FILM_SECONDS } from "./templates.ts";
import { rid } from "./util.ts";

/**
 * LAUNCH CODES (27 September 2026, the owner: "fai strategia per attirare la gente e farla restare"; zero users, zero
 * revenue). A code posted on one channel — PRODUCTHUNT, HN, REDDIT, X, TIKTOK, and whatever the owner adds — unlocks
 * ONE free film of at most TRIAL_FILM_MAX_S seconds, even for an account that never paid: the one thing a stranger
 * could not try before, because a film is bought from the clip provider with the owner's money.
 *
 * The rules, each enforced by the database and not by a read followed by a write:
 *  · a code has max_uses (30 by default) and `uses` is counted inside the same batch that records the redemption;
 *  · ONE redemption per account, whatever the code (redemptions.user_id is the primary key);
 *  · the redemption grants the credits of the trial film (launch_codes.credits, or filmCredits(TRIAL_FILM_MAX_S) when
 *    NULL: the tariff decides, not a number copied into a table) and records the channel, which is the attribution;
 *  · the film it opens is claimed by ONE job at a time (redemptions.film_job, film_at): a trial job that failed or was
 *    cancelled BEFORE any clip was ordered for it gives the trial back by itself; a queued, running or delivered one
 *    holds it for good, and so does a failed or cancelled one whose clips were bought (the owner's money is spent: a
 *    cancel at 58% must not buy a second round of clips). A claim whose job row was never written (the debit refused,
 *    the insert failed) is released by createJob, and one left behind by a crash lapses after TRIAL_CLAIM_STALE_MIN;
 *  · the film is the credits the code added: it is open while the account still has them (the price of the trial
 *    film), so a code whose credits went on animatics never reads "open" to a film the debit would then refuse.
 * The gates that read it: createJob (src/jobs.ts), requestFootage (src/footage.ts) and, through createJob, the
 * pre-flight — which runs before the claim, so a film refused for capacity never holds the trial.
 */

/** The longest film a launch code opens: the shortest film there is (10 credits = 15 seconds). */
export const TRIAL_FILM_MAX_S = MIN_FILM_SECONDS;
/** Uses per code when the owner does not say otherwise. */
export const LAUNCH_CODE_MAX_USES = 30;
/** The codes seeded by migrations/0012_launch_codes.sql and src/schema.ts, with the channel each one attributes to. */
export const LAUNCH_CODES: readonly { code: string; channel: string }[] = [
  { code: "PRODUCTHUNT", channel: "producthunt" },
  { code: "HN", channel: "hn" },
  { code: "REDDIT", channel: "reddit" },
  { code: "X", channel: "x" },
  { code: "TIKTOK", channel: "tiktok" },
];

/** A code as typed, made comparable: upper case, no spaces; null when it cannot be a code at all. */
export function normalizeCode(raw: unknown): string | null {
  const c = String(raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
  return /^[A-Z0-9_-]{1,32}$/.test(c) ? c : null;
}
/** A channel name as stored: lower case, [a-z0-9_.-], at most 32 characters; null when nothing is left. */
export function normalizeChannel(raw: unknown): string | null {
  const c = String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 32);
  return c || null;
}

export interface LaunchCode { code: string; channel: string; max_uses: number; uses: number; credits: number | null; active: number }
export interface Redemption { user_id: string; code: string; channel: string; credits: number; film_job: string | null; film_at: string | null; at: string }

export const getLaunchCode = (env: Env, code: string) =>
  env.DB.prepare("SELECT * FROM launch_codes WHERE code = ?").bind(code).first<LaunchCode>();
export const redemptionOf = (env: Env, userId: string) =>
  env.DB.prepare("SELECT * FROM redemptions WHERE user_id = ?").bind(userId).first<Redemption>();

export type RedeemResult =
  | { ok: true; code: string; channel: string; credits: number; balance: number | null }
  | { ok: false; reason: "invalid" | "unknown" | "used_up" | "already"; message: string };

/**
 * Redeems a launch code for an account, exactly once, whatever arrives at the same time. Three statements in ONE
 * batch (a transaction): the redemption row is inserted only while the code is active and has uses left, and the
 * primary key refuses a second one for the account; the use and the credits follow only if THAT row (its nonce) exists.
 */
export async function redeemLaunchCode(env: Env, userId: string, raw: unknown): Promise<RedeemResult> {
  const code = normalizeCode(raw);
  if (!code) return { ok: false, reason: "invalid", message: "That is not a launch code: codes are letters and digits, like PRODUCTHUNT. Nothing was changed." };
  const nonce = rid("rd", 12);
  const trialCredits = filmCredits(TRIAL_FILM_MAX_S);
  const rows = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO redemptions (user_id, code, channel, credits, nonce)
       SELECT ?, code, channel, COALESCE(credits, ?), ? FROM launch_codes WHERE code = ? AND active = 1 AND uses < max_uses`,
    ).bind(userId, trialCredits, nonce, code),
    env.DB.prepare("UPDATE launch_codes SET uses = uses + 1 WHERE code = ? AND EXISTS (SELECT 1 FROM redemptions WHERE user_id = ? AND nonce = ?)")
      .bind(code, userId, nonce),
    env.DB.prepare(
      `UPDATE users SET credits = credits + (SELECT credits FROM redemptions WHERE user_id = ? AND nonce = ?)
       WHERE id = ? AND EXISTS (SELECT 1 FROM redemptions WHERE user_id = ? AND nonce = ?)`,
    ).bind(userId, nonce, userId, userId, nonce),
  ]);
  if ((rows[0]?.meta.changes ?? 0) === 1) {
    const r = await redemptionOf(env, userId);
    const balance = (await env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(userId).first<{ credits: number }>())?.credits ?? null;
    await audit(env, userId, null, "launch.redeemed", { code, channel: r?.channel ?? null, amount: r?.credits ?? 0, balance });
    return { ok: true, code, channel: r?.channel ?? "", credits: r?.credits ?? 0, balance };
  }
  // Nothing was written: say which of the three it was (a read after the fact only chooses the words).
  const had = await redemptionOf(env, userId);
  const row = await getLaunchCode(env, code);
  const why: RedeemResult = had
    ? { ok: false, reason: "already", message: `This account has already used a launch code (${had.code}): one per account. Nothing was changed.` }
    : !row || !row.active
      ? { ok: false, reason: "unknown", message: `There is no launch code "${code}". Check the spelling, or ask where you found it. Nothing was changed.` }
      : { ok: false, reason: "used_up", message: `The launch code ${code} has been used ${row.max_uses} times, which is all it had. Nothing was changed.` };
  await audit(env, userId, null, "launch.refused", { code, reason: why.reason });
  return why;
}

/** Minutes after which a claim that names no job row (a crash between the claim and the insert) no longer holds. */
export const TRIAL_CLAIM_STALE_MIN = 10;

/**
 * The claim is FREE — no job holds the trial film — in SQL, over the redemptions row: no claim yet; or the claiming job
 * failed or was cancelled and no clip was ever ordered for it (a footage row counts unless kie.ai refused it before
 * giving it a task, which is never billed); or the claim names no job row at all and is older than
 * TRIAL_CLAIM_STALE_MIN. A claim whose job row is not written YET is not free: that is the moment a second call from the
 * same account arrives in (an assistant retrying after a client timeout), and it must not take the trial over.
 * trialOf and claimTrial read this one predicate, so the page, the texts and the gate never disagree.
 */
const CLAIM_FREE = `(redemptions.film_job IS NULL
  OR EXISTS (SELECT 1 FROM jobs WHERE jobs.id = redemptions.film_job AND jobs.state IN ('failed', 'cancelled')
             AND NOT EXISTS (SELECT 1 FROM footage WHERE footage.job_id = jobs.id AND NOT (footage.state = 'failed' AND footage.task_id IS NULL)))
  OR (NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id = redemptions.film_job)
      AND (redemptions.film_at IS NULL OR redemptions.film_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${TRIAL_CLAIM_STALE_MIN} minutes'))))`;

/**
 * What the account's launch code still offers. `available`: no job holds the trial film AND the account still has the
 * credits the code added for it (the film's price); `held_by`: the job that holds it (made, in the making, or failed
 * after its clips were bought); `credits_short`: how many credits the free film lacks because they were spent on
 * something else (0 otherwise).
 */
export interface TrialState { code: string; channel: string; available: boolean; max_s: number; held_by: string | null; price: number; credits_short: number }
export async function trialOf(env: Env, userId: string): Promise<TrialState | null> {
  const r = await env.DB.prepare(
    `SELECT redemptions.code, redemptions.channel, redemptions.film_job, ${CLAIM_FREE} AS free,
            (SELECT credits FROM users WHERE users.id = redemptions.user_id) AS balance
     FROM redemptions WHERE user_id = ?`,
  ).bind(userId).first<{ code: string; channel: string; film_job: string | null; free: number; balance: number | null }>();
  if (!r) return null;
  const price = filmCredits(TRIAL_FILM_MAX_S);
  const held = !r.free && !!r.film_job;
  const short = held ? 0 : Math.max(0, price - (r.balance ?? 0));
  return { code: r.code, channel: r.channel, available: !held && short === 0, max_s: TRIAL_FILM_MAX_S, held_by: held ? r.film_job : null, price, credits_short: short };
}

/**
 * Claims the trial film for one job, atomically: the redemption's film_job is set only while the claim is free
 * (CLAIM_FREE), so of two calls at once only one takes it, whichever order the rows are written in. The caller that
 * then fails to write its job row gives the claim back with releaseTrial.
 */
export async function claimTrial(env: Env, userId: string, jobId: string): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE redemptions SET film_job = ?, film_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ? AND ${CLAIM_FREE}`,
  ).bind(jobId, userId).run();
  return (r.meta.changes ?? 0) === 1;
}

/** Gives back a claim whose job was never written (the debit refused, the insert failed): only if it is still this job's. */
export async function releaseTrial(env: Env, userId: string, jobId: string): Promise<void> {
  await env.DB.prepare("UPDATE redemptions SET film_job = NULL, film_at = NULL WHERE user_id = ? AND film_job = ?").bind(userId, jobId).run();
}

/** True when this job is the account's launch-code film: marked so, no longer than the trial, and the claim is its. */
export async function trialHolds(env: Env, job: Pick<Job, "id" | "user_id" | "params">): Promise<boolean> {
  let p: JobParams;
  try { p = JSON.parse(job.params) as JobParams; } catch { return false; }
  if (p.trial !== true || (p.duration_s ?? Infinity) > TRIAL_FILM_MAX_S) return false;
  const r = await redemptionOf(env, job.user_id);
  return !!r && r.film_job === job.id;
}

/** Adds a code, or changes one (the owner's admin route): uses are never reset by an update. */
export async function upsertLaunchCode(env: Env, c: { code: string; channel: string; max_uses?: number; credits?: number | null; active?: boolean }): Promise<LaunchCode | null> {
  await env.DB.prepare(
    `INSERT INTO launch_codes (code, channel, max_uses, credits, active) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET channel = excluded.channel, max_uses = excluded.max_uses, credits = excluded.credits, active = excluded.active`,
  ).bind(c.code, c.channel, Math.max(0, Math.round(c.max_uses ?? LAUNCH_CODE_MAX_USES)), c.credits ?? null, c.active === false ? 0 : 1).run();
  return getLaunchCode(env, c.code);
}
export async function listLaunchCodes(env: Env): Promise<LaunchCode[]> {
  return (await env.DB.prepare("SELECT * FROM launch_codes ORDER BY code").all<LaunchCode>()).results ?? [];
}
