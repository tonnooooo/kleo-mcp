import type { Env } from "./env";
import { type Job, type JobParams, type JobState, type User, OPEN_STATES, countOpenForUser, countJobsTodayForUser, addJobCost, debitCredits, refundCredits, insertJob, transitionJob, audit, getUserJob, listFiles } from "./db";
import { accountUrl } from "./accounts";
import { findTemplate, creditsFor, etaFor, normalizeVoice, voiceSpellings, type Format } from "./templates";
import { rid, nowIso, int, hmacHex } from "./util";
import { isFlagActive } from "./schema";
import { backendFor } from "./backends";
import { validateStoryboard, kleoStyleOf, KLEO_STYLES, type KleoStyle } from "./keou-contract";
import { pickKleoStyle } from "./storyboard";

/** An error whose message is shown to the user as-is: plain English, always says whether something was charged. */
export class JobError extends Error {}

export interface CreateInput {
  template: string;
  prompt: string;
  duration_s?: number;
  format?: Format;
  language?: string;
  voice?: string;
  notify_email?: string;
  /** Kleo visual style (cartoon | realistic | cyber | stickman). Omitted: the storyboard's kleo_style, else the planner picks one from the prompt. */
  style?: string;
  /** Optional client-authored Keou storyboard (see keou-contract.ts); validated here, stored as JSON. */
  storyboard?: unknown;
}

/** Minimal safety gate before any GPU money is spent. Replace with a real moderation API before opening to the public. */
const BLOCKED = [/\b(child|kid|minor|underage|preteen|loli)\w*\b[^.]{0,60}\b(sex|nude|naked|porn|erotic)/i, /\b(sex|nude|naked|porn|erotic)\w*\b[^.]{0,60}\b(child|kid|minor|underage|preteen)/i];
export function moderationBlocks(text: string): boolean {
  return BLOCKED.some((re) => re.test(text));
}

/** "1 credit" / "3 credits". */
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** "Short" for vertical videos, "video" otherwise. */
export const kindOf = (format: string | null | undefined): "Short" | "video" => (format === "9:16" ? "Short" : "video");
const capital = (s: string) => s[0].toUpperCase() + s.slice(1);
const formatWords = (f: Format) => (f === "9:16" ? "9:16 Shorts" : "16:9 videos");

/**
 * Credits given back when a job is cancelled. Nothing was rendered before the GPU reports its first real
 * progress, so `queued` and `starting` give everything back; while rendering the refund follows the work
 * left, rounded to the nearest credit (a 1-credit Short cancelled below 50% is free, above it costs the credit).
 */
export function refundFor(credits: number, state: JobState, percent: number): number {
  if (credits <= 0) return 0;
  if (state === "queued" || state === "starting") return credits;
  const pct = Math.max(0, Math.min(100, percent));
  return Math.max(0, Math.min(credits, Math.round((credits * (100 - pct)) / 100)));
}

export async function createJob(env: Env, user: User, input: CreateInput): Promise<Job> {
  const t = findTemplate(input.template);
  if (!t) throw new JobError(`There is no template called "${input.template}". Call kleo_list_templates for the valid ids. Nothing was charged.`);
  const format = (input.format ?? t.formats[0]) as Format;
  if (!t.formats.includes(format))
    throw new JobError(`The "${t.name}" template only makes ${formatWords(t.formats[0])}, not ${formatWords(format)}. Pick ${t.formats[0]} or another template. Nothing was charged.`);
  const duration = Math.round(input.duration_s ?? t.defaultSeconds);
  if (duration < t.minSeconds || duration > t.maxSeconds)
    throw new JobError(`The "${t.name}" template makes videos of ${t.minSeconds} to ${t.maxSeconds} seconds; ${duration} seconds is outside that range. Choose a length in range or another template. Nothing was charged.`);
  const prompt = input.prompt.trim();
  if (prompt.length < 8) throw new JobError("The description is too short (at least 8 characters). Say what the video is about: topic, angle, tone, anything that must appear on screen. Nothing was charged.");
  if (prompt.length > 4000) throw new JobError(`The description is too long (${prompt.length} characters, the maximum is 4000). Shorten it and call again. Nothing was charged.`);
  if (moderationBlocks(prompt)) throw new JobError("This request goes against the content policy, so the video was not started. Nothing was charged.");
  const voice = normalizeVoice(input.voice);   // a Kokoro id from the storyboard guide is the same voice, not an error
  if (voice && !t.voices.includes(voice)) throw new JobError(`There is no voice called "${input.voice}". Available voices: ${voiceSpellings(t.voices).join(", ")}. Nothing was charged.`);
  const language = input.language ?? "en";
  if (input.style !== undefined && !(KLEO_STYLES as readonly string[]).includes(input.style))
    throw new JobError(`There is no style called "${input.style}". Pick one of cartoon, realistic, cyber or stickman. Nothing was charged.`);
  let style = input.style as KleoStyle | undefined;
  if (style === "stickman" && format !== "9:16")
    throw new JobError("The stickman style makes 9:16 Shorts only. Use format 9:16, or pick cartoon, realistic or cyber for a 16:9 video. Nothing was charged.");
  let storyboard: string | null = null;
  if (input.storyboard !== undefined && input.storyboard !== null) {
    const sbIn = input.storyboard;
    if (typeof sbIn === "object" && !Array.isArray(sbIn)) {
      const sb = sbIn as Record<string, unknown>;
      if (style && "kleo_style" in sb && sb.kleo_style !== style)
        throw new JobError(`The style argument says "${style}" but the storyboard's kleo_style says "${String(sb.kleo_style)}". Make them agree (or drop one of them). Nothing was charged.`);
      if (style && !("kleo_style" in sb)) sb.kleo_style = style;
    }
    const r = validateStoryboard(sbIn, { format, language });
    if (!r.ok) {
      const n = r.errors.length;
      throw new JobError(`The storyboard has ${plural(n, "problem")} (nothing was charged). Fix ${n === 1 ? "it" : "them"} and call kleo_create_video again:\n- ${r.errors.join("\n- ")}`);
    }
    storyboard = JSON.stringify(r.storyboard);
    style = kleoStyleOf(r.storyboard);
  }
  if (!style) style = pickKleoStyle(t.id, prompt);

  if (!input.storyboard && (await isFlagActive(env, "plan_pause")))
    throw new JobError("Kleo cannot write the storyboard itself right now: it has used up today's free planning. You can still make the video, and it costs the same: call kleo_storyboard_guide, write the storyboard yourself, then call kleo_create_video again with the storyboard argument. Nothing was charged.");
  const maxOpen = int(env.MAX_JOBS_PER_USER, 2);
  const open = await countOpenForUser(env, user.id);
  if (open >= maxOpen)
    throw new JobError(`You already have ${plural(open, "video")} in progress, and the limit is ${maxOpen} at a time. Wait for one to finish (kleo_get_job) or cancel one with kleo_cancel_job. Nothing was charged.`);
  // The limit above only counts videos running AT ONCE, so it lets one account queue as fast as jobs finish.
  const maxPerDay = int(env.MAX_JOBS_PER_DAY, 2);
  const today = await countJobsTodayForUser(env, user.id);
  if (today >= maxPerDay)
    throw new JobError(`You have already started ${plural(today, "video")} today, and the limit is ${maxPerDay} a day while Kleo is in beta. Come back tomorrow. Nothing was charged.`);

  const credits = creditsFor(duration);
  const jobId = rid("gt", 8);
  // The debit is one conditional UPDATE: it either takes the credits for this job or does nothing.
  if (!(await debitCredits(env, user.id, credits, jobId)))
    throw new JobError(`Not enough credits: this ${kindOf(format)} costs ${plural(credits, "credit")} and you have ${plural(Math.max(0, user.credits), "credit")}. Nothing was charged. Your account and how to get more: ${await accountUrl(env, user.id)}`);

  const params: JobParams = { duration_s: duration, format, language, voice, style };
  const job: Job = {
    id: jobId, user_id: user.id, template: t.id, prompt, params: JSON.stringify(params),
    state: "queued", track: null, percent: 0, eta_min: etaFor(duration), credits,
    backend: null, instance_id: null, instance_meta: null, worker_secret: rid("wk", 32), attempts: 0,
    error: null, notify_email: input.notify_email ?? null, created_at: nowIso(), started_at: null, finished_at: null,
    expires_at: null, purged_at: null, cost_usd: null,
    storyboard, plan_attempts: 0, plan_error: null,
  };
  try {
    await insertJob(env, job);
  } catch (e) {
    // The row never existed, so the credits go straight back: a user is never charged for a video that was not created.
    await refundCredits(env, user.id, credits, jobId, "job could not be saved");
    await audit(env, user.id, jobId, "job.create.error", String(e).slice(0, 500));
    throw new JobError("Kleo could not save the video request. Nothing was charged; please try again in a moment.");
  }
  await audit(env, user.id, job.id, "job.created", { template: t.id, credits, duration, format, style, storyboard: storyboard ? "client" : "auto" });
  return job;
}

/** The message for a job that cannot be cancelled because it is already over. */
export function notCancellable(job: Job): JobError {
  const what = kindOf((JSON.parse(job.params) as JobParams).format);
  if (job.state === "done") return new JobError(`${capital(what)} ${job.id} is already finished, so there is nothing to cancel. Call kleo_get_result for the download links.`);
  if (job.state === "cancelled") return new JobError(`${capital(what)} ${job.id} was already cancelled.`);
  return new JobError(`${capital(what)} ${job.id} had already failed and its credits were given back; there is nothing to cancel.`);
}

/**
 * Cancels a queued or running job and refunds refundFor(). The cancel is one atomic transition, so a job that
 * finishes or fails in the same instant is refunded by exactly one of the two paths, never both.
 */
export async function cancelJob(env: Env, user: User, jobId: string): Promise<{ job: Job; refunded: number }> {
  const job = await getUserJob(env, user.id, jobId);
  if (!job) throw new JobError(`There is no video number "${jobId}" on this account. Check the number, or call kleo_get_job without a number to see your recent videos.`);
  if (!OPEN_STATES.includes(job.state)) throw notCancellable(job);
  const refund = refundFor(job.credits, job.state, job.percent);
  const moved = await transitionJob(env, job.id, OPEN_STATES, { state: "cancelled", finished_at: nowIso(), error: "cancelled by user" });
  if (!moved) throw notCancellable((await getUserJob(env, user.id, jobId)) ?? job);
  // Whatever GPU the job holds is released now; the orchestrator never rents one for a cancelled job (see tick()).
  if (job.instance_id) {
    try {
      // A cancel is a rental that ENDED: those minutes are already on the Vast bill, and this job will never reach
      // "done" to write a cost of its own, so without this line the daily ceiling never sees cancelled renders at all.
      const est = await backendFor(env, job.backend).destroy(env, job);
      if (typeof est === "number" && est > 0) await addJobCost(env, job.id, est);
    } catch (e) { await audit(env, user.id, job.id, "backend.destroy.error", String(e)); }
  }
  const refunded = await refundCredits(env, user.id, refund, job.id, `cancelled at ${job.percent}% (${job.state})`);
  await audit(env, user.id, job.id, "job.cancelled", { refunded, percent: job.percent, state_before: job.state });
  return { job: { ...job, state: "cancelled" }, refunded };
}

export const FILE_NAMES: Record<string, { name: string; type: string }> = {
  video: { name: "video.mp4", type: "video/mp4" },
  subtitles: { name: "subtitles.srt", type: "application/x-subrip" },
  thumbnail: { name: "thumbnail.jpg", type: "image/jpeg" },
};

export async function signedDownloadUrl(env: Env, base: string, job: Job, fileName: string): Promise<string> {
  const exp = Math.floor(new Date(job.expires_at ?? nowIso()).getTime() / 1000);
  const sig = await hmacHex(env.INTERNAL_SECRET, `${job.id}/${fileName}/${exp}`);
  return `${base}/dl/${job.id}/${encodeURIComponent(fileName)}?exp=${exp}&sig=${sig}`;
}

/** Scene pictures (img/<sceneId>.png|jpg) are worker inputs, not deliverables: they never appear in the user's links. */
export const isSceneImage = (name: string): boolean => name.startsWith("img/");

export async function resultLinks(env: Env, base: string, job: Job): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await listFiles(env, job.id)) {
    if (f.name === "log.txt") continue; // technical worker log: not for users
    if (isSceneImage(f.name)) continue;
    const key = f.name.replace(/\.[a-z0-9]+$/i, "") + "_url";
    out[key] = await signedDownloadUrl(env, base, job, f.name);
  }
  return out;
}

export function jobView(job: Job) {
  const p = JSON.parse(job.params) as JobParams;
  return {
    job_id: job.id,
    state: job.state,
    template: job.template,
    format: p.format,
    duration_s: p.duration_s,
    style: p.style ?? null,
    track: job.track,
    percent: job.percent,
    eta_min: job.state === "done" || job.state === "failed" || job.state === "cancelled" ? 0 : job.eta_min,
    credits: job.credits,
    created_at: job.created_at,
    finished_at: job.finished_at,
    expires_at: job.expires_at,
    error: job.error,
  };
}
