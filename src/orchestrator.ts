import type { Env } from "./env";
import { type Job, type JobState, activeJobs, queuedJobs, unplannedJobs, claimPlanAttempt, countRunning, updateJob, audit, creditCredits, expiredJobs, listFiles, deleteFiles, setFile, getJob } from "./db";
import { backendFor, getBackend } from "./backends";
import { int, nowIso, minutesSince, secondsSince, addDays, base64ToBytes } from "./util";
import { TINY_MP4_B64 } from "./assets";
import { resultLinks, FILE_NAMES } from "./jobs";
import { notifyDone } from "./notify";
import { putFile, deleteFile } from "./storage";
import { acquireLock, releaseLock, holdLock } from "./schema";
import { generateStoryboard, StoryboardError, isTransientAiError } from "./storyboard";

const MAX_ATTEMPTS = 3;
/** Storyboard generation attempts per job (each one may call the model twice). */
const MAX_PLAN_ATTEMPTS = 2;
/** After a Workers AI quota/outage error, planning pauses this long (the daily free allocation resets at 00:00 UTC). */
const PLAN_PAUSE_SECONDS = 15 * 60;

type Stats = { planned: number; started: number; advanced: number; failed: number; purged: number };

/**
 * Runs every minute (cron) and also on demand in dev via /__scheduled. Every step is idempotent.
 * `plan` (cron only): storyboard generation takes 1–5 min of model time (outline + chunks), so it runs under its own lock and
 * never from a fetch-triggered waitUntil, which could be cut short and burn a planning attempt.
 */
export async function tick(env: Env, opts: { plan?: boolean } = {}): Promise<Stats & { skipped?: boolean }> {
  const stats: Stats = { planned: 0, started: 0, advanced: 0, failed: 0, purged: 0 };
  if (opts.plan && (await acquireLock(env, "plan", 600))) {
    let pause = 0;
    try { pause = await planOne(env, stats); } finally { await (pause ? holdLock(env, "plan", pause) : releaseLock(env, "plan")); }
  }
  if (!(await acquireLock(env, "tick", 50))) return { ...stats, skipped: true };
  try {
    return await tickInner(env, stats);
  } finally {
    await releaseLock(env, "tick");
  }
}

/**
 * Every queued job gets a storyboard before any GPU money is spent. One job per tick; the attempt is claimed atomically.
 * Returns the number of seconds planning should pause (quota exhausted, upstream down): those errors give the attempt back.
 */
async function planOne(env: Env, stats: Stats): Promise<number> {
  for (const job of await unplannedJobs(env, 1, MAX_PLAN_ATTEMPTS)) {
    if (!(await claimPlanAttempt(env, job.id, job.plan_attempts))) continue;
    const attempts = job.plan_attempts + 1;
    try {
      const r = await generateStoryboard(env, job);
      await updateJob(env, job.id, { storyboard: JSON.stringify(r.storyboard), plan_error: null });
      await audit(env, job.user_id, job.id, "job.planned", { model: r.model, attempt: attempts, model_calls: r.attempts, ms: r.ms, usage: r.usage, est_neurons: r.est_neurons, words: r.words, scenes: r.scenes, fixture: r.fixture });
      stats.planned++;
    } catch (e) {
      const msg = (e instanceof StoryboardError ? e.errors.join("; ") : String(e)).slice(0, 2000);
      if (!(e instanceof StoryboardError) && isTransientAiError(e)) {
        await updateJob(env, job.id, { plan_attempts: job.plan_attempts, plan_error: `waiting for Workers AI: ${msg.slice(0, 300)}` });
        await audit(env, job.user_id, job.id, "job.plan.paused", { error: msg, pause_s: PLAN_PAUSE_SECONDS });
        return PLAN_PAUSE_SECONDS;
      }
      await audit(env, job.user_id, job.id, "job.plan.error", { attempt: attempts, error: msg });
      if (attempts >= MAX_PLAN_ATTEMPTS) {
        await failJob(env, { ...job, plan_attempts: attempts }, `could not plan the video: ${msg.slice(0, 600)}`, false);
        stats.failed++;
      } else {
        await updateJob(env, job.id, { plan_error: msg });
      }
    }
  }
  return 0;
}

async function tickInner(env: Env, stats: Stats) {
  const timeoutMin = int(env.JOB_TIMEOUT_MIN, 120);

  for (const job of await activeJobs(env)) {
    try {
      if (job.backend === "mock") {
        await advanceMock(env, job);
        stats.advanced++;
        continue;
      }
      if (job.started_at && minutesSince(job.started_at) > timeoutMin) {
        await failJob(env, job, `timeout after ${timeoutMin} min`, true);
        stats.failed++;
        continue;
      }
      // A worker that never reports (image pull stuck, boot failure) must not hold a paid GPU for the whole timeout.
      const startTimeoutMin = int(env.START_TIMEOUT_MIN, 15);
      if (job.state === "starting" && job.started_at && minutesSince(job.started_at) > startTimeoutMin) {
        await failJob(env, job, `worker never started within ${startTimeoutMin} min (image pull or boot problem)`, true);
        stats.failed++;
        continue;
      }
      const backend = backendFor(env, job.backend);
      if (backend.poll && job.state !== "finishing") {
        const st = await backend.poll(env, job);
        if (st === "gone") {
          await failJob(env, job, "GPU instance disappeared", true);
          stats.failed++;
        }
      }
    } catch (e) {
      await audit(env, job.user_id, job.id, "tick.error", String(e));
    }
  }

  const running = await countRunning(env);
  const max = int(env.MAX_CONCURRENT_GPUS, 5);
  const backend = getBackend(env);
  for (const job of await queuedJobs(env, max - running)) {
    try {
      const r = await backend.start(env, job);
      await updateJob(env, job.id, {
        state: "starting", backend: backend.name, instance_id: r.instanceId, instance_meta: JSON.stringify(r.meta ?? {}),
        started_at: nowIso(), attempts: job.attempts + 1, track: "script", error: null,
      });
      await audit(env, job.user_id, job.id, "job.started", { backend: backend.name, instance: r.instanceId, meta: r.meta });
      stats.started++;
    } catch (e) {
      const attempts = job.attempts + 1;
      await audit(env, job.user_id, job.id, "job.start.error", { attempt: attempts, error: String(e) });
      if (attempts >= MAX_ATTEMPTS) {
        await failJob(env, { ...job, attempts }, `could not start a GPU: ${String(e)}`, false);
        stats.failed++;
      } else {
        await updateJob(env, job.id, { attempts, error: String(e) });
      }
    }
  }

  for (const job of await expiredJobs(env)) {
    for (const f of await listFiles(env, job.id)) await deleteFile(env, f.key);
    await deleteFiles(env, job.id);
    await updateJob(env, job.id, { purged_at: nowIso() });
    stats.purged++;
  }
  return stats;
}

/** Marks a job failed (or requeues it) and always tears the GPU down. */
export async function failJob(env: Env, job: Job, reason: string, retry: boolean): Promise<void> {
  try { await backendFor(env, job.backend).destroy(env, job); } catch (e) { await audit(env, job.user_id, job.id, "backend.destroy.error", String(e)); }
  if (retry && job.attempts < MAX_ATTEMPTS) {
    await updateJob(env, job.id, { state: "queued", instance_id: null, instance_meta: null, started_at: null, percent: 0, track: null, error: reason });
    await audit(env, job.user_id, job.id, "job.requeued", { reason, attempts: job.attempts });
    return;
  }
  await updateJob(env, job.id, { state: "failed", finished_at: nowIso(), error: reason, percent: job.percent });
  await creditCredits(env, job.user_id, job.credits);
  await audit(env, job.user_id, job.id, "job.failed", { reason, refunded: job.credits });
}

/** Marks a job done, releases the GPU, emails the links. Called by the worker callback and by the mock. */
export async function finishJob(env: Env, job: Job, costUsd: number | null): Promise<void> {
  const finished = nowIso();
  const expires = addDays(finished, int(env.RESULT_TTL_DAYS, 7));
  let cost = costUsd;
  try { const est = await backendFor(env, job.backend).destroy(env, job); if (cost == null && typeof est === "number") cost = est; }
  catch (e) { await audit(env, job.user_id, job.id, "backend.destroy.error", String(e)); }
  await updateJob(env, job.id, { state: "done", percent: 100, track: null, eta_min: 0, finished_at: finished, expires_at: expires, cost_usd: cost, error: null });
  await audit(env, job.user_id, job.id, "job.done", { cost_usd: cost });
  const fresh = (await getJob(env, job.id))!;
  try { await notifyDone(env, fresh, await resultLinks(env, env.PUBLIC_URL, fresh)); } catch (e) { await audit(env, job.user_id, job.id, "notify.error", String(e)); }
}

export function trackFor(percent: number): { track: string; state: JobState } {
  if (percent < 8) return { track: "script", state: "starting" };
  if (percent < 16) return { track: "voice", state: "rendering" };
  if (percent < 64) return { track: "clips", state: "rendering" };
  if (percent < 78) return { track: "edit", state: "rendering" };
  return { track: "finishing", state: "finishing" };
}

/** Mock progress: completes in MOCK_TOTAL_SECONDS (default 60) and writes real placeholder files to R2. */
async function advanceMock(env: Env, job: Job): Promise<void> {
  const total = Math.max(5, int(env.MOCK_TOTAL_SECONDS, 60));
  const elapsed = job.started_at ? secondsSince(job.started_at) : 0;
  const percent = Math.min(100, Math.floor((elapsed / total) * 100));
  if (percent < 100) {
    const { track, state } = trackFor(percent);
    await updateJob(env, job.id, { percent, track, state, eta_min: Math.max(1, Math.ceil(((100 - percent) / 100) * (job.eta_min ?? 25))) });
    return;
  }
  const p = JSON.parse(job.params) as { duration_s: number; format: string };
  const prefix = `renders/${job.id}/`;
  const video = base64ToBytes(TINY_MP4_B64);
  const srt = `1\n00:00:00,000 --> 00:00:04,000\n${job.prompt.slice(0, 80)}\n\n2\n00:00:04,000 --> 00:00:08,000\n(mock render · ${job.template} · ${p.format} · ${p.duration_s}s)\n`;
  const files: { name: string; type: string; body: Uint8Array | string }[] = [
    { name: FILE_NAMES.video.name, type: FILE_NAMES.video.type, body: video },
    { name: FILE_NAMES.subtitles.name, type: FILE_NAMES.subtitles.type, body: srt },
    { name: "thumbnail.svg", type: "image/svg+xml", body: mockThumb(job.template, job.prompt) },
  ];
  for (const f of files) {
    const size = await putFile(env, prefix + f.name, f.body, f.type);
    await setFile(env, { job_id: job.id, name: f.name, key: prefix + f.name, size, content_type: f.type });
  }
  await finishJob(env, job, 0);
}

function mockThumb(template: string, prompt: string): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720"><rect width="1280" height="720" fill="#0F1216"/><rect x="60" y="60" width="1160" height="600" rx="24" fill="none" stroke="#F3B53F" stroke-width="6" stroke-dasharray="18 12"/><text x="640" y="330" font-family="Helvetica,Arial,sans-serif" font-size="64" font-weight="700" fill="#ECEAE4" text-anchor="middle">${esc(template)}</text><text x="640" y="410" font-family="Helvetica,Arial,sans-serif" font-size="30" fill="#B9BEC8" text-anchor="middle">${esc(prompt.slice(0, 70))}</text><text x="640" y="600" font-family="monospace" font-size="24" fill="#F3B53F" text-anchor="middle">mock render · Kleo</text></svg>`;
}
