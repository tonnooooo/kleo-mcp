import type { Env } from "./env";
import { type Job, type JobState, ACTIVE_STATES, OPEN_STATES, GPU_ONLY_WAIT, PLAN_WAIT, unexplainedUnplannedJobs, activeJobs, queuedJobs, queuedPictureJobs, staleQueuedJobs, jobInstances, unplannedJobs, claimPlanAttempt, countRunning, runningPaidJobs, spentTodayUsd, addJobCost, rememberTriedMachine, updateJob, transitionJob, audit, refundCredits, expiredJobs, listFiles, deleteFiles, setFile, getJob, reserveJob, unreserveJob } from "./db";
import { backendFor, getBackend } from "./backends";
import { vastStatus, GONE, vastCredit, listKleoInstances, destroyInstance } from "./backends/vast";
import { int, num, nowIso, minutesSince, secondsSince, addDays, base64ToBytes, rid } from "./util";
import { TINY_MP4_B64 } from "./assets";
import { resultLinks, FILE_NAMES } from "./jobs";
import { jobTimeoutMin, renderSilenceMin, filmedJob } from "./templates";
import { sellingOpen, SELLING_PAUSE } from "./stripe";
import { notifyDone } from "./notify";
import { putFile, deleteFile } from "./storage";
import { acquireLock, releaseLock, holdLock, setFlagUntil, isFlagActive } from "./schema";
import { acquireOwnedLock, renewOwnedLock, releaseOwnedLock } from "./db";
import { poolWaitingJobs } from "./db";
import { generateStoryboard, StoryboardError, isTransientAiError } from "./storyboard";
import { updateJobParams } from "./db";
import { specOf, type RequestSpec } from "./spec";
import { drawJobStills, stillsEngineOn, stillsHold, stillsStateOf, mergeFidelity, castSheetKeys, stillsErrorVerdict, pauseStills, STILLS_GIVE_UP_MIN } from "./stills";
import { purgeOldRefs } from "./refs.ts";

/** Jobs whose stills one cron tick draws, at most, and how long each may take (they run side by side). */
const STILLS_JOBS_PER_TICK = 2;
/**
 * The drawing window of one tick, INSIDE the one-minute cron period (24 September 2026). It was 70 s: with the stills
 * in flight at the deadline and the fidelity.json write, a tick that drew held the lock for 75-110 s, so the next cron
 * found it held and skipped, and the engine drew in one minute of every two while the give-up clock (wall time) ran
 * on. Now new stills start until 25 s in (deadline - EST_STILL_MS), no redraw starts past 45 s (drawJudged's `until`),
 * and a typical tick is over before the next cron takes the lock.
 */
export const STILLS_JOB_MS = 45_000;
/**
 * The stills lock is OWNED (src/db.ts acquireOwnedLock) and kept alive by a heartbeat while the tick draws: a short
 * lease renewed every STILLS_HEARTBEAT_MS, instead of one long guess of the worst case. A slow Workers AI can no
 * longer outlive the lock (it used to expire mid-draw and let the next tick pay for the same pictures again), a tick
 * whose invocation dies frees the job within STILLS_LOCK_S, and a tick only ever releases its own lock.
 */
export const STILLS_LOCK_S = 90;
const STILLS_HEARTBEAT_MS = 20_000;

/** What the planner's fidelity judge returns (src/fidelity.ts PlanFidelity), as far as this module reads it. */
interface PlanFidelityLike { verdicts?: { id: string; status: string; shots?: string[]; note?: string }[]; inventions?: string[]; score?: number; judge?: string; coverage?: unknown }

const MAX_ATTEMPTS = 3;
/** Storyboard generation attempts per job (each one may call the model twice). */
const MAX_PLAN_ATTEMPTS = 2;
/**
 * After a Workers AI quota/outage error, planning pauses this long and then tries again. The retry is what makes it
 * correct: the comment here used to say the free allocation resets at 00:00 UTC, and that is NOT what the API does.
 * Measured on 11 September 2026: the allocation was exhausted the evening before and a call at 00:15 UTC still came
 * back "4006: you have used up your daily free allocation of 10,000 neurons". So nobody here knows the reset hour,
 * and no code may depend on knowing it — which this one does not, because it just asks again every quarter hour.
 * A refused call costs no neurons and answers in milliseconds, so asking is free.
 */
const PLAN_PAUSE_SECONDS = 15 * 60;
/** Minutes between two Vast orphan sweeps: one full instance listing each, so not every tick. */
const SWEEP_MIN = 10;

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
    try { pause = await planOne(env, stats); } finally {
      if (pause) { await holdLock(env, "plan", pause); await setFlagUntil(env, "plan_pause", pause); await explainPlanWait(env); }
      else { await releaseLock(env, "plan"); }
    }
  }
  // The stills of planned jobs, before any GPU is rented for them (src/stills.ts). Cron only, like planning: a
  // fetch-triggered tick runs under waitUntil, which may be cut short in the middle of a paid draw.
  if (opts.plan) {
    try { await drawStills(env); } catch (e) { await audit(env, null, null, "stills.tick.error", String(e).slice(0, 300)); }
  }
  // Longer than tickInner can plausibly run: every active job costs a Vast round trip or two, and a lock that expires
  // mid-tick lets a second tick rent GPUs against the same `running` count (the per-rental re-read below is the belt).
  if (!(await acquireLock(env, "tick", 120))) return { ...stats, skipped: true };
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
      // THE SPEC AND THE FIDELITY OF THE PLAN (24 September 2026). When the planner wrote the spec itself (the call
      // carried none), it is kept on the job in the same write as the storyboard: the stills engine judges every
      // picture against it, the clip prompts read its looks, and a re-plan must not write a second, different one.
      const fx = r as typeof r & { spec?: RequestSpec | null; fidelity?: PlanFidelityLike | null };
      let params: Record<string, unknown> = {};
      try { params = JSON.parse(job.params) as Record<string, unknown>; } catch { /* unreadable params: nothing to add the spec to */ }
      const keepSpec = !!fx.spec && !specOf(params) && Object.keys(params).length > 0;
      // Planning takes minutes: the job may have been cancelled meanwhile, and a cancelled job must stay cancelled.
      if (!(await transitionJob(env, job.id, ["queued"], { storyboard: JSON.stringify(r.storyboard), plan_error: null, ...(keepSpec ? { params: JSON.stringify({ ...params, spec: fx.spec }) } : {}) }))) {
        await audit(env, job.user_id, job.id, "job.plan.ignored", { reason: "job is no longer queued" });
        continue;
      }
      await audit(env, job.user_id, job.id, "job.planned", { model: r.model, attempt: attempts, model_calls: r.attempts, ms: r.ms, usage: r.usage, est_neurons: r.est_neurons, words: r.words, scenes: r.scenes, fixture: r.fixture });
      if (fx.fidelity) await recordPlanFidelity(env, job, fx.fidelity);
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

/**
 * The plan's fidelity verdict (src/fidelity.ts: per MUST item kept / paraphrased / lost / contradicted, plus the
 * inventions that change the film) goes to the job's fidelity.json — the report the finished video is read back
 * against — and to one audit row, so the owner can count, job by job, what the planner still drops. Best effort: a
 * report that cannot be written never un-plans a job.
 */
async function recordPlanFidelity(env: Env, job: Job, f: PlanFidelityLike): Promise<void> {
  const verdicts = Array.isArray(f.verdicts) ? f.verdicts : [];
  const of = (s: string) => verdicts.filter((v) => v.status === s).map((v) => v.id);
  try {
    await mergeFidelity(env, job, { plan: { score: f.score ?? null, judge: f.judge ?? null, verdicts, inventions: f.inventions ?? [], coverage: f.coverage ?? null, at: nowIso() } });
  } catch (e) { await audit(env, job.user_id, job.id, "job.fidelity.error", String(e).slice(0, 300)); }
  await audit(env, job.user_id, job.id, "job.fidelity", { score: f.score ?? null, judge: f.judge ?? null, lost: of("lost"), contradicted: of("contradicted"), inventions: (f.inventions ?? []).slice(0, 10) });
}

/**
 * THE STILLS STEP (24 September 2026, src/stills.ts): the queued, planned jobs of the two film looks get their stills
 * drawn and judged on the server BEFORE the dispatcher may rent them a GPU (stillsHold). At most STILLS_JOBS_PER_TICK
 * jobs, side by side, STILLS_JOB_MS each, under an owned lock of their own (heartbeat-renewed) so an overlapping cron
 * never draws the same job twice; what does not fit is resumed on the next tick. A job drawing for more than
 * STILLS_GIVE_UP_MIN is marked "failed" here, which lets the GPU draw what is missing the legacy way: the engine may
 * make a film more faithful, never strand it. A throw out of drawJobStills (a D1 or R2 hiccup) PAUSES the job's
 * drawing like a transient model error does (stillsErrorVerdict); only a bug fails it at once.
 *
 * THE OWNER'S PAUSE SWITCHES hold here too. "paused" and "budget_pause" stop every rental and "paused_all" stops the
 * free pool as well (/internal/admin/pause: "stops the spending", "nothing renders at all"); this step spends Workers
 * AI on FLUX.2 and the vision judge for every queued film — including the one whose content made the owner press the
 * emergency switch — so it stops under any of the three. Until 24 September it ran on regardless, every minute.
 */
export async function drawStills(env: Env): Promise<void> {
  if (!env.AI || (env.STILLS_ENGINE ?? "").trim().toLowerCase() === "legacy") return;
  for (const flag of ["paused_all", "paused", "budget_pause"]) if (await isFlagActive(env, flag)) return;
  const todo: Job[] = [];
  for (const job of await queuedJobs(env, 20)) {
    if (job.phase === "finish" || !stillsEngineOn(env, job)) continue;
    const st = stillsStateOf(job);
    if (st?.state === "done" || st?.state === "failed") continue;
    if (st?.state === "drawing" && st.at && minutesSince(st.at) > STILLS_GIVE_UP_MIN) {
      await updateJobParams(env, job.id, { stills: { ...st, state: "failed", at: nowIso(), note: `gave up after ${STILLS_GIVE_UP_MIN} minutes of drawing; the GPU draws the rest` } });
      await audit(env, job.user_id, job.id, "stills.gave_up", { minutes: Math.round(minutesSince(st.at)), drawn: st.drawn ?? null, total: st.total ?? null });
      continue;
    }
    todo.push(job);
  }
  if (!todo.length) return;
  const lock = await acquireOwnedLock(env, "stills", STILLS_LOCK_S);
  if (!lock) return;
  let lost = false;
  const heartbeat = setInterval(() => {
    renewOwnedLock(env, lock, STILLS_LOCK_S).then((held) => { if (!held) lost = true; }, () => { /* a failed renewal is retried on the next beat */ });
  }, STILLS_HEARTBEAT_MS);
  try {
    const deadline = Date.now() + STILLS_JOB_MS;
    await Promise.all(todo.slice(0, STILLS_JOBS_PER_TICK).map(async (job) => {
      try {
        const r = await drawJobStills(env, job, { deadline, stop: () => lost });
        if (r.state !== "drawing") await audit(env, job.user_id, job.id, "stills.state", r);
      } catch (e) {
        const msg = String(e).slice(0, 300);
        const fresh = (await getJob(env, job.id).catch(() => null)) ?? job;
        if (stillsErrorVerdict(e) === "pause") { await pauseStills(env, fresh, msg); return; }
        await updateJobParams(env, job.id, { stills: { ...(stillsStateOf(fresh) ?? {}), state: "failed", at: nowIso(), note: msg } });
        await audit(env, job.user_id, job.id, "stills.state", { state: "failed", error: msg });
      }
    }));
  } finally {
    clearInterval(heartbeat);
    await releaseOwnedLock(env, lock);
  }
}

async function tickInner(env: Env, stats: Stats) {
  for (const job of await activeJobs(env)) {
    // Per job, never a flat number: the timeout has to cover the ETA this very video was quoted (templates.ts).
    const timeoutMin = jobTimeoutMin(env, job);
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
      // Measured from the worker's last word, not from the rental: a healthy picture job spends the image pull plus the
      // whole picture phase under 8% (state "starting"), which is far more than fifteen minutes of wall clock.
      const startTimeoutMin = int(env.START_TIMEOUT_MIN, 15);
      const loadingRetryMin = int(env.LOADING_RETRY_MIN, 14);
      const lastWord = job.last_report_at || job.started_at;
      const startingFor = job.started_at ? minutesSince(job.started_at) : 0;
      // Two different questions, and the slow-host one has to be asked FIRST: a machine that is still pulling the image
      // is not silent because the worker broke, it is silent because it has nothing yet. Some hosts crawl or sit on
      // "Retrying in 1 second" for twenty paid minutes; another machine would have started long ago. So a job whose
      // worker has still not spoken after LOADING_RETRY_MIN moves hosts (that is what a retry is for), before the
      // silence rule can apply.
      if (job.state === "starting" && job.backend === "vast" && !job.last_report_at
          && startingFor > loadingRetryMin && job.attempts < MAX_ATTEMPTS) {
        // Vast's own actual_status is NOT consulted here, on purpose. A state is the provider's opinion; silence is a
        // fact. `!job.last_report_at` after LOADING_RETRY_MIN already says everything: the worker announces itself as
        // its first act, a healthy boot reaches running in about a minute and the longest pull measured is 3.5, so
        // nothing is legitimately still loading fourteen minutes in. Asking anyway could only ever BLOCK the right
        // move — a dead worker on a host reporting anything but "loading" would have been left to rot until the
        // timeout, and the field was measured flickering running -> loading -> running inside a single minute.
        await audit(env, job.user_id, job.id, "vast.never_started", { minutes: Math.round(startingFor), instance: job.instance_id });
        // NOT "still downloading": the download was measured at about three minutes, four separate times. What this
        // machine is doing is unknown — the boot chain itself was proved sound on eight hosts — so the message says
        // the fact (it never started) instead of a cause we no longer believe.
        await failJob(env, job, `the rented machine never started the renderer, ${Math.round(startingFor)} min after it was rented; trying another one`, true);
        stats.failed++;
        continue;
      }
      // The same question once the render is under way, and until today nobody asked it: the silence rule below was
      // gated on state "starting", so a worker that wedged at 40% held a paid GPU until the wall clock ran out — and
      // the wall clock is the one thing that cannot tell a dead render from a slow one. Silence can. This is the half
      // that pays for the headroom jobTimeoutMin now gives a healthy render.
      // WHAT THIS NUMBER IS RACING, because it is invisible from here: "silence" means last_report_at, which is only
      // written when the worker POSTs progress (internal.ts), which happens when it parses a line out of the engine's
      // stdout — and between frames that line is FRAME, emitted every N frames by worker/keou (another file, another
      // language, another author). At 1080p that was ~90 seconds; at 3840x2160 the same N is minutes. Anyone lowering
      // this number is racing that cadence, and a healthy render that loses the race is killed and requeued — the very
      // bug this sensor exists to prevent, coming back through the other door. There is a test on the engine side
      // holding the two together; do not move this one without reading it.
      const renderSilence = renderSilenceMin(env, job);
      if (job.state !== "starting" && job.last_report_at && minutesSince(job.last_report_at) > renderSilence) {
        const quiet = Math.round(minutesSince(job.last_report_at));
        await audit(env, job.user_id, job.id, "worker.silent", { minutes: quiet, percent: job.percent, state: job.state });
        await failJob(env, job, `the worker stopped reporting ${quiet} min ago, at ${job.percent}%`, true);
        stats.failed++;
        continue;
      }
      // A worker that never reports (boot failure, a wedged container) must not hold a paid GPU for the whole job timeout.
      if (job.state === "starting" && lastWord && minutesSince(lastWord) > startTimeoutMin) {
        // Out of retries, or a slow pull we have decided to sit out: never past LOADING_TIMEOUT_MIN.
        const loadingTimeoutMin = int(env.LOADING_TIMEOUT_MIN, 35);
        const st = job.backend === "vast" ? await vastStatus(env, job) : null;
        if (st === "loading" && startingFor <= loadingTimeoutMin) { // GONE never waits: there is nothing left to wait for
          await audit(env, job.user_id, job.id, "vast.still_loading", { minutes: Math.round(startingFor) });
        } else {
          const quiet = Math.round(minutesSince(lastWord));
          await failJob(env, job, job.last_report_at
            ? `the worker went quiet ${quiet} min ago (instance status: ${st ?? "unknown"})`
            : `worker never started within ${quiet} min (instance status: ${st ?? "unknown"})`, true);
          stats.failed++;
          continue;
        }
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
  const providerDown = backend.name === "vast" && (await isFlagActive(env, "vast_unavailable"));
  // "paused" is the switch the owner presses from his phone (/internal/admin/pause); "budget_pause" is the money wall.
  // Both are read exactly where vast_unavailable is read, so pressing either really does stop GPU rentals.
  const paused = await isFlagActive(env, "paused");
  const overBudget = backend.name === "vast" && !paused && (await budgetGate(env, running));
  if (backend.name === "vast") await guardSelling(env);
  const noGpu = providerDown || paused || overBudget;
  if (backend.name !== "pool" && !noGpu) for (const job of await queuedJobs(env, max - running)) {
    // Re-read, per rental and not per tick: the tick lock can expire under a slow Vast, and a second tick that
    // read the same `running` would rent up to `max` GPUs of its own — twice the hourly ceiling the owner was promised.
    if ((await countRunning(env)) >= max) break;
    // The server is still drawing this film's stills (src/stills.ts): renting now would have the GPU draw worse copies
    // of pictures that are seconds away. The hold ends when they are done or failed, or after STILLS_GIVE_UP_MIN.
    if (stillsHold(env, job)) continue;
    // At most MAX_CONCURRENT_VIDEO_GPUS generated-video renders at once, whatever `max` allows. Those are both the
    // dearest cards and the ones whose bill triples when clips come back frozen and have to be regenerated, so two
    // of them overlapping is the one way this can empty the balance with nobody watching. `continue`, not `break`:
    // an ordinary job further down the queue is cheap and must not be held hostage by a video one at the front.
    if (filmedJob(job) && job.phase !== "finish" && (await runningVideoJobs(env)) >= int(env.MAX_CONCURRENT_VIDEO_GPUS, 1)) continue;
    if (!(await reserveJob(env, job.id, backend.name))) continue; // a pool runner took it first
    try {
      const r = await backend.start(env, job);
      // Renting takes seconds; if the user cancelled in between, the job is no longer "starting" and the GPU must go straight back.
      const attached = await transitionJob(env, job.id, ["starting"], {
        instance_id: r.instanceId, instance_meta: JSON.stringify(r.meta ?? {}), attempts: job.attempts + 1,
      });
      if (!attached) {
        const orphan = { ...job, backend: backend.name, instance_id: r.instanceId };
        try { await backend.destroy(env, orphan); } catch (e) { await audit(env, job.user_id, job.id, "backend.destroy.error", String(e)); }
        await audit(env, job.user_id, job.id, "job.started.orphan", { backend: backend.name, instance: r.instanceId, note: "job left the queue while the GPU was being rented; GPU released" });
        continue;
      }
      await audit(env, job.user_id, job.id, "job.started", { backend: backend.name, instance: r.instanceId, meta: r.meta });
      stats.started++;
    } catch (e) {
      const msg = String(e);
      if (backend.name === "vast" && /insufficient_credit|lacks credit|no Vast\.ai offer/i.test(msg)) {
        // The provider, not the job, is the problem: hand the job back untouched and let pool runners take it.
        const pauseMin = int(env.VAST_RETRY_MIN, 30);
        await setFlagUntil(env, "vast_unavailable", pauseMin * 60);
        await unreserveJob(env, job.id);
        await audit(env, job.user_id, job.id, "vast.unavailable", { error: msg.slice(0, 200), pause_min: pauseMin });
        break;
      }
      const attempts = job.attempts + 1;
      await audit(env, job.user_id, job.id, "job.start.error", { attempt: attempts, error: msg });
      await unreserveJob(env, job.id);
      if (attempts >= MAX_ATTEMPTS) {
        await failJob(env, { ...job, attempts, state: "queued" }, `could not start a GPU: ${msg}`, false);
        stats.failed++;
      } else {
        await updateJob(env, job.id, { attempts, error: msg });
      }
    }
  }

  const poolOnly = noGpu || backend.name === "pool";
  if (poolOnly) await explainGpuWait(env, providerDown ? "vast_unavailable" : paused ? "paused" : overBudget ? "budget_pause" : "pool_backend");
  // The free GitHub runners cost nothing, so a pause of the MONEY must not stop them: they keep draining the queue.
  // "paused_all" is the other reason to press the switch — a prompt that must not be rendered at all — and that one
  // does stop them (handlePoolClaim refuses too, so a runner already awake gets nothing either).
  if (!(await isFlagActive(env, "paused_all"))) await dispatchPoolRunner(env, poolOnly);
  await sweepVastOrphans(env);

  // Nothing else ever times out a QUEUED job (the timeout above needs started_at), so on a day the budget runs out
  // every user would sit at their concurrency limit for ever with the credits already taken. Refund and let go.
  const queueMaxWait = int(env.QUEUE_MAX_WAIT_MIN, 180);
  for (const job of await staleQueuedJobs(env, queueMaxWait)) {
    // A job with no storyboard never even asked for a GPU: it was the planner (Workers AI quota, plan_pause) that
    // held it. Saying "no GPU was free" there sends both the user and the owner looking at Vast for a quota outage.
    await failJob(env, job, job.storyboard
      ? `no GPU was free in time (waited ${queueMaxWait} min)`
      : `Kleo could not write the storyboard for this video in time (waited ${queueMaxWait} min); its planning quota was exhausted`, false);
    stats.failed++;
  }

  // Done jobs past their links, failed jobs past the same TTL, cancelled jobs after an hour (src/db.ts expiredJobs):
  // the stills engine writes stills, character sheets and fidelity.json while a job is still queued, so a job that
  // never finished has files to purge too (24 September 2026).
  for (const job of await expiredJobs(env, 20, { ttlDays: int(env.RESULT_TTL_DAYS, 7) })) {
    for (const f of await listFiles(env, job.id)) await deleteFile(env, f.key);
    // The character sheets are not job files (they must not show up among the user's links): purged by their keys.
    for (const k of castSheetKeys(job)) { try { await deleteFile(env, k); } catch { /* a sheet that is not there */ } }
    await deleteFiles(env, job.id);
    await updateJob(env, job.id, { purged_at: nowIso() });
    stats.purged++;
  }
  // The users' reference pictures (src/refs.ts) are kept REF_TTL_DAYS after their last use; the pass throttles itself
  // to once every six hours, and a store hiccup never fails the tick.
  try { await purgeOldRefs(env, Date.now()); } catch (e) { await audit(env, null, null, "refs.purge.error", String(e).slice(0, 300)); }
  return stats;
}

/**
 * GPU dollars this UTC day: what the jobs of today have already been charged, PLUS what the PAID machines running
 * right now have committed. The second term is not optional. jobs.cost_usd is written when a rental ends (finishJob,
 * failJob, cancelJob), so a plain SUM reads 0.00 while two GPUs burn and the gate would let the queue drain the whole
 * balance before the first bill lands. Each running job is priced at the worst case it can still reach: the price cap
 * for its own timeout — which is per job (templates.ts), because a long video is allowed to run twice as long as a Short.
 * Only backend 'vast' is counted: a job on the free GitHub pool commits nothing, and pricing it would pause the paid
 * path over money that was never spent.
 *
 * THE NUMBER IS AN ESTIMATE. The price cap is an upper bound, so a cheap host makes it pessimistic; a rental whose
 * cost estimate could not be read from Vast still writes nothing. It bounds the damage, it is not an account
 * statement — the Vast.ai balance is.
 */
/** The machine a job is on right now, as the key the renter excludes by (instance_meta, written at rental). */
function machineKeyOf(job: Job): string | null {
  try {
    const m = JSON.parse(job.instance_meta ?? "{}") as { key?: string; machine?: number | null; offer?: number };
    if (typeof m.key === "string" && m.key) return m.key;
    if (typeof m.machine === "number") return `m:${m.machine}`;
    return typeof m.offer === "number" ? `o:${m.offer}` : null;
  } catch { return null; }
}

/** Generated-video renders on a paid GPU right now (their style is what says so, src/templates.ts). */
async function runningVideoJobs(env: Env): Promise<number> {
  // A job in its finish phase holds a cent-an-hour box, not a video card: it does not count against the limit.
  return (await runningPaidJobs(env)).filter((j) => filmedJob(j) && j.phase !== "finish").length;
}

/**
 * The GPU phase is over: the worker packed frames, clips, voice and timings into gen.tgz on R2 and is about to
 * destroy its card. Release the card (its cost is booked), and put the job back in the queue in phase "finish",
 * where the next tick rents the cheapest box that runs ffmpeg. The attempt counters start again: the expensive
 * part succeeded, and a finish box that fails must not burn the GPU's retries. Returns whether it applied.
 */
export async function handoverToFinish(env: Env, job: Job): Promise<boolean> {
  await releaseGpu(env, job);
  const ok = await transitionJob(env, job.id, ACTIVE_STATES, {
    state: "queued", phase: "finish", backend: null, instance_id: null, instance_meta: null, started_at: null, queued_at: nowIso(),
    attempts: 0, tried_machines: null, percent: 60, track: "clips", error: null, worker_secret: rid("wk", 32),
  });
  await audit(env, job.user_id, job.id, ok ? "job.phase.finish" : "job.phase.finish.ignored", { note: ok ? "GPU released; a finish box will lay the track" : "job was no longer active" });
  return ok;
}

export async function budgetSpentUsd(env: Env): Promise<number> {
  const cap = num(env.VAST_MAX_DPH, 0.4);
  let committed = 0;
  for (const job of await runningPaidJobs(env)) committed += rentedDph(job, cap) * (jobTimeoutMin(env, job) / 60);
  return (await spentTodayUsd(env)) + committed;
}

/**
 * What a rental really costs per hour: the price its offer was taken at (instance_meta, written by the backend the
 * moment the machine is rented), falling back to the cap while no machine has been chosen yet.
 *
 * Pricing every running job at VAST_MAX_DPH was harmless while one cap fitted every job — every card was an RTX 4090
 * around $0.30-0.40. It stops being harmless the day a style needs a dearer card: raising the cap to fit it would
 * make the phantom bill of two idle-but-running jobs exceed DAILY_GPU_BUDGET_USD before a single video finished, and
 * Kleo would pause itself permanently on money it had not spent. The commitment stays deliberately pessimistic in
 * the other direction — the FULL timeout, not the minutes elapsed — because that is what a rental can still cost.
 */
function rentedDph(job: Job, cap: number): number {
  try {
    const dph = (JSON.parse(job.instance_meta ?? "{}") as { dph?: number }).dph;
    return typeof dph === "number" && dph > 0 ? dph : cap;
  } catch {
    return cap; // an unreadable meta is not a reason to under-count money
  }
}

/**
 * True when no more GPUs may be rented today. Once tripped the pause lasts an hour, even if the spend estimate
 * falls back below the line when the running jobs end: the queue is meant to drain slowly, not to bounce.
 */
async function budgetGate(env: Env, running: number): Promise<boolean> {
  if (await isFlagActive(env, "budget_pause")) return true;
  const budget = num(env.DAILY_GPU_BUDGET_USD, 1);
  const spend = await budgetSpentUsd(env);
  if (spend < budget) return false;
  await setFlagUntil(env, "budget_pause", 3600);
  await audit(env, null, null, "budget.paused", { estimate_usd: Math.round(spend * 1000) / 1000, budget_usd: budget, running, pause_min: 60 });
  return true;
}

/**
 * A cartoon / realistic job is rendered from AI pictures, which need a GPU, so the free GitHub Actions pool never
 * claims it (POOL_SKIP in db.ts is right about that). When the pool is the only way in — Vast is down or is not the
 * backend at all — such a job would sit in "queued" saying nothing until the user gives up or the job times out.
 * The reason goes on `error`, the one queued-job field the job view exposes, and is audited once per wait so the
 * owner can see how long a style was stranded. reserveJob clears `error` the moment a GPU is really reserved.
 *
 * A job that already failed to start carries a real error there ("could not start a GPU: no offer matches..."), which
 * says far more than the generic wait: that error is KEPT, quoted after the explanation, never overwritten. Keeping
 * GPU_ONLY_WAIT as the prefix is what makes the composed message recognisable — queuedPictureJobs filters on exactly
 * that prefix in SQL, so a job is explained once and the query never wastes its page on jobs already explained. If a
 * later start attempt overwrites `error` with a new failure, the job comes back here once and is explained again,
 * this time quoting the new failure: one audit line per piece of news, not one per minute.
 */
/**
 * Says out loud why a job is not moving when the planner is paused. Same shape as explainGpuWait: written once into
 * `error`, which is the one field a queued job's status shows, so kleo_get_job and kleo_wait_for_video repeat it
 * instead of repeating an ETA that nothing is working towards.
 */
/**
 * Closes the shop when there is nothing to sell. Not the payments — the BUTTONS. The balance is read once per tick
 * and the pause is raised for fifteen minutes and renewed while the money stays low, so it clears itself within a
 * quarter of an hour of a top-up with nobody pressing anything. A balance that cannot be read (null) changes
 * nothing: one Vast hiccup must not close the shop.
 */
async function guardSelling(env: Env): Promise<void> {
  if (!sellingOpen(env)) return; // nothing to guard
  const credit = await vastCredit(env);
  if (credit === null) return;
  const floor = num(env.VAST_MIN_BALANCE_TO_SELL, 1);
  const paused = await isFlagActive(env, SELLING_PAUSE);
  if (credit < floor) {
    await setFlagUntil(env, SELLING_PAUSE, 15 * 60);
    if (!paused) await audit(env, null, null, "selling.paused", { credit, floor });
  } else if (paused) {
    // Released here, not left to expire: on 15 September the flag lingered for a quarter of an hour after the top-up
    // and this line wrote "resumed" on every tick of it — twenty-three rows for one event.
    await releaseLock(env, SELLING_PAUSE);
    await audit(env, null, null, "selling.resumed", { credit, floor });
  }
}

async function explainPlanWait(env: Env): Promise<void> {
  for (const job of await unexplainedUnplannedJobs(env)) {
    const previous = job.error?.trim();
    const message = previous ? `${PLAN_WAIT} (last attempt: ${previous.slice(0, 300)})` : PLAN_WAIT;
    if (!(await transitionJob(env, job.id, ["queued"], { error: message, eta_min: null }, { error: job.error }))) continue;
    await audit(env, job.user_id, job.id, "job.waiting_for_planner", {
      queued_min: Math.round(minutesSince(job.created_at)), plan_attempts: job.plan_attempts, plan_error: job.plan_error?.slice(0, 200) ?? null,
    });
  }
}

async function explainGpuWait(env: Env, reason: string): Promise<void> {
  for (const job of await queuedPictureJobs(env)) {
    const previous = job.error?.trim();
    const message = previous ? `${GPU_ONLY_WAIT} (last attempt: ${previous.slice(0, 400)})` : GPU_ONLY_WAIT;
    // Guarded on the error we read, so a start error landing between the read and the write is never lost.
    if (!(await transitionJob(env, job.id, ["queued"], { error: message }, { error: job.error }))) continue;
    await audit(env, job.user_id, job.id, "job.waiting_for_gpu", { reason, style: (JSON.parse(job.params) as { style?: string }).style ?? null, queued_min: Math.round(minutesSince(job.created_at)), previous_error: previous ?? null });
  }
}

/**
 * Safety net for GPUs nobody owns any more. Every instance is labelled "kleo-<job id>" (vast.ts), so the label says
 * which job paid for it: an instance whose job is over, or whose job now holds a different instance, is money burning
 * for nothing — a create whose answer was lost and could not be adopted, or a destroy that failed. Instances labelled
 * for a job this database has never heard of belong to another deployment sharing the Vast account: never touched.
 */
export async function sweepVastOrphans(env: Env): Promise<number> {
  if (!env.VAST_API_KEY) return 0; // no key, no instances of ours (and no way to look)
  if (await isFlagActive(env, "vast_sweep")) return 0;
  await setFlagUntil(env, "vast_sweep", SWEEP_MIN * 60);
  let destroyed = 0;
  try {
    const instances = await listKleoInstances(env);
    if (!instances.length) return 0;
    const jobs = await jobInstances(env, [...new Set(instances.map((i) => i.jobId))]);
    for (const inst of instances) {
      const job = jobs.get(inst.jobId);
      if (!job) continue; // foreign deployment
      // A job whose rental is IN FLIGHT has no instance_id yet: leave it alone, start() itself adopts what it created.
      // "In flight" means 'starting' and nothing else. reserveJob moves queued → starting BEFORE backend.start is ever
      // called, so a job sitting in 'queued' cannot legitimately own a live instance: an instance labelled for one is a
      // create whose answer was lost, or a requeue that left its GPU behind — money burning with nobody watching.
      const inFlight = ACTIVE_STATES.includes(job.state);
      if (inFlight && (!job.instance_id || job.instance_id === String(inst.id))) continue;
      try {
        await destroyInstance(env, inst.id);
        destroyed++;
        await audit(env, null, inst.jobId, "vast.orphan.swept", { instance: inst.id, status: inst.status, dph: inst.dph, job_state: job.state, kept: inFlight ? job.instance_id : null });
      } catch (e) {
        await audit(env, null, inst.jobId, "vast.orphan.sweep.error", { instance: inst.id, error: String(e).slice(0, 200) });
      }
    }
  } catch (e) {
    await audit(env, null, null, "vast.orphan.sweep.error", String(e).slice(0, 200));
  }
  return destroyed;
}

/**
 * Tears the GPU down AND writes down what that rental cost. destroy() already asks Vast for start_date and dph_total;
 * every failure path used to throw that number away, so the daily budget was blind to any rental that did not end in a
 * finished video — a day of failed renders, or of cancels while "starting", read $0.00 and the ceiling could never trip.
 * Best effort by design: a destroy that throws must never stop a job from being failed, cancelled or finished.
 */
async function releaseGpu(env: Env, job: Job): Promise<void> {
  let est: number | undefined;
  try { est = await backendFor(env, job.backend).destroy(env, job); }
  catch (e) { await audit(env, job.user_id, job.id, "backend.destroy.error", String(e)); }
  if (typeof est === "number" && est > 0) await addJobCost(env, job.id, est);
}

/**
 * Marks a job failed (or requeues it) and always tears the GPU down. Idempotent: the state change is one
 * atomic transition from an open state, so a job that was already cancelled, finished or failed by another
 * path is left alone and, above all, is not refunded a second time. Returns what happened.
 */
export async function failJob(env: Env, job: Job, reason: string, retry: boolean): Promise<"requeued" | "failed" | "ignored"> {
  await releaseGpu(env, job);
  if (retry && job.attempts < MAX_ATTEMPTS) {
    // Back to the queue with a fresh worker secret: the old GPU (possibly still alive) can no longer report on this job.
    // queued_at restarts here, so the queue-wait reaper measures the new wait and not the age of the job.
    // Remember the machine BEFORE the row forgets it: the very next line clears instance_id and instance_meta, and
    // that is exactly the information the next attempt needs in order not to rent the same host again.
    const failedKey = machineKeyOf(job);
    if (failedKey) await rememberTriedMachine(env, job.id, failedKey);
    const requeued = await transitionJob(env, job.id, OPEN_STATES, {
      // last_report_at goes too: it is the OLD worker's last word, and the next attempt's box was being killed as
      // "quiet for 25 minutes" before it had finished booting (13 September, gt_d2td9fb9, attempts 2 and 3).
      state: "queued", backend: null, instance_id: null, instance_meta: null, started_at: null, last_report_at: null, queued_at: nowIso(), percent: 0, track: null, error: reason, worker_secret: rid("wk", 32),
    });
    if (!requeued) { await audit(env, job.user_id, job.id, "job.requeue.ignored", { reason, note: "job was no longer open" }); return "ignored"; }
    await audit(env, job.user_id, job.id, "job.requeued", { reason, attempts: job.attempts });
    return "requeued";
  }
  const failed = await transitionJob(env, job.id, OPEN_STATES, { state: "failed", finished_at: nowIso(), error: reason, percent: job.percent });
  if (!failed) { await audit(env, job.user_id, job.id, "job.fail.ignored", { reason, note: "job was no longer open (already cancelled, done or failed)" }); return "ignored"; }
  const refunded = await refundCredits(env, job.user_id, job.credits, job.id, `failed: ${reason.slice(0, 120)}`);
  await audit(env, job.user_id, job.id, "job.failed", { reason, refunded });
  return "failed";
}

/**
 * Marks a job done, releases the GPU, emails the links. Called by the worker callback and by the mock.
 * Idempotent: a second "done", or a "done" after a cancel/failure, changes nothing. Returns whether it applied.
 */
export async function finishJob(env: Env, job: Job, costUsd: number | null): Promise<boolean> {
  const finished = nowIso();
  const expires = addDays(finished, int(env.RESULT_TTL_DAYS, 7));
  const done = await transitionJob(env, job.id, OPEN_STATES, { state: "done", percent: 100, track: null, eta_min: 0, finished_at: finished, expires_at: expires, error: null });
  if (!done) { await audit(env, job.user_id, job.id, "job.done.ignored", { note: "job was no longer open (already done, cancelled or failed)" }); return false; }
  // The worker's figure is a convenience; the server's own (start_date x dph_total, straight from the Vast API) is the
  // trustworthy one — the worker runs on a machine rented from a stranger who has root on it and could report 0 for
  // every render. Take the larger of the two, so a reported 0 can never erase the estimate.
  let est: number | undefined;
  try { est = await backendFor(env, job.backend).destroy(env, job); }
  catch (e) { await audit(env, job.user_id, job.id, "backend.destroy.error", String(e)); }
  const cost = Math.max(costUsd ?? 0, est ?? 0);
  if (cost > 0) await addJobCost(env, job.id, cost);
  const fresh = (await getJob(env, job.id))!;
  await audit(env, job.user_id, job.id, "job.done", { cost_usd: fresh.cost_usd, worker_said: costUsd, vast_said: est ?? null });
  try { await notifyDone(env, fresh, await resultLinks(env, env.PUBLIC_URL, fresh)); } catch (e) { await audit(env, job.user_id, job.id, "notify.error", String(e)); }
  return true;
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
    // Only while still active: a job cancelled between the read and this write must not come back to life.
    await transitionJob(env, job.id, ACTIVE_STATES, { percent, track, state, eta_min: Math.max(1, Math.ceil(((100 - percent) / 100) * (job.eta_min ?? 25))) });
    return;
  }
  const p = JSON.parse(job.params) as { duration_s: number; format: string };
  const prefix = `renders/${job.id}/`;
  const video = base64ToBytes(TINY_MP4_B64);
  const files: { name: string; type: string; body: Uint8Array | string }[] = [
    { name: FILE_NAMES.video.name, type: FILE_NAMES.video.type, body: video },
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

/**
 * GitHub's own 5-minute schedule for render-pool.yml is unreliable (often delayed or skipped), so when a planned job is
 * waiting for the pool we start a runner ourselves through the GitHub API (workflow_dispatch), at most once every 4 minutes.
 * Needs the GITHUB_TOKEN secret (fine-grained token, repo kleo-mcp, Actions: read and write). Without it, only the schedule runs.
 */
async function dispatchPoolRunner(env: Env, poolMode: boolean): Promise<void> {
  if (!env.GITHUB_TOKEN) return;
  const waiting = await poolWaitingJobs(env, poolMode ? 0 : int(env.POOL_AFTER_MIN, 3));
  if (!waiting) return;
  if (await isFlagActive(env, "pool_dispatch")) return;
  await setFlagUntil(env, "pool_dispatch", 4 * 60);
  const repo = env.GITHUB_REPO ?? "tonnooooo/kleo-mcp";
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/render-pool.yml/dispatches`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "kleo-mcp/1.0", "x-github-api-version": "2022-11-28" },
      body: JSON.stringify({ ref: "main" }),
    });
    await audit(env, null, null, r.status === 204 ? "pool.dispatched" : "pool.dispatch.error", { status: r.status, waiting, body: r.status === 204 ? undefined : (await r.text()).slice(0, 200) });
  } catch (e) {
    await audit(env, null, null, "pool.dispatch.error", String(e).slice(0, 200));
  }
}
