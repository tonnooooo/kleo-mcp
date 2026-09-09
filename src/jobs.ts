import type { Env } from "./env";
import { type Job, type JobParams, type User, countOpenForUser, debitCredits, creditCredits, insertJob, updateJob, audit, getUserJob, listFiles } from "./db";
import { findTemplate, creditsFor, etaFor, type Format } from "./templates";
import { rid, nowIso, int, hmacHex } from "./util";
import { getBackend } from "./backends";
import { validateStoryboard } from "./keou-contract";

export class JobError extends Error {}

export interface CreateInput {
  template: string;
  prompt: string;
  duration_s?: number;
  format?: Format;
  language?: string;
  voice?: string;
  notify_email?: string;
  /** Optional client-authored Keou storyboard (see keou-contract.ts); validated here, stored as JSON. */
  storyboard?: unknown;
}

/** Minimal safety gate before any GPU money is spent. Replace with a real moderation API before opening to the public. */
const BLOCKED = [/\b(child|kid|minor|underage|preteen|loli)\w*\b[^.]{0,60}\b(sex|nude|naked|porn|erotic)/i, /\b(sex|nude|naked|porn|erotic)\w*\b[^.]{0,60}\b(child|kid|minor|underage|preteen)/i];
export function moderationBlocks(text: string): boolean {
  return BLOCKED.some((re) => re.test(text));
}

export async function createJob(env: Env, user: User, input: CreateInput): Promise<Job> {
  const t = findTemplate(input.template);
  if (!t) throw new JobError(`Unknown template "${input.template}". Call list_templates to see the valid ids.`);
  const format = (input.format ?? t.formats[0]) as Format;
  if (!t.formats.includes(format)) throw new JobError(`Template "${t.id}" supports ${t.formats.join(" or ")}, not ${format}.`);
  const duration = Math.round(input.duration_s ?? t.defaultSeconds);
  if (duration < t.minSeconds || duration > t.maxSeconds)
    throw new JobError(`Template "${t.id}" renders ${t.minSeconds}–${t.maxSeconds} seconds; ${duration} is out of range. Pick another duration or template.`);
  const prompt = input.prompt.trim();
  if (prompt.length < 8) throw new JobError("The prompt is too short. Describe the video: topic, angle, tone, anything that must appear.");
  if (prompt.length > 4000) throw new JobError("The prompt is too long (max 4000 characters).");
  if (moderationBlocks(prompt)) throw new JobError("This request violates the content policy and was not started.");
  const voice = input.voice ?? null;
  if (voice && !t.voices.includes(voice)) throw new JobError(`Unknown voice "${voice}". Available: ${t.voices.join(", ")}.`);
  const language = input.language ?? "en";
  let storyboard: string | null = null;
  if (input.storyboard !== undefined && input.storyboard !== null) {
    const r = validateStoryboard(input.storyboard, { format, language });
    if (!r.ok) throw new JobError(`The storyboard was refused (${r.errors.length} problem${r.errors.length > 1 ? "s" : ""}, fix them and call again; nothing was charged):\n- ${r.errors.join("\n- ")}`);
    storyboard = JSON.stringify(r.storyboard);
  }

  const maxOpen = int(env.MAX_JOBS_PER_USER, 2);
  const open = await countOpenForUser(env, user.id);
  if (open >= maxOpen) throw new JobError(`You already have ${open} video${open > 1 ? "s" : ""} in progress (limit ${maxOpen}). Wait for one to finish or cancel it with cancel_job.`);

  const credits = creditsFor(duration);
  if (!(await debitCredits(env, user.id, credits)))
    throw new JobError(`Not enough credits: this video costs ${credits}, you have ${user.credits}. Ask for more credits at the address in the footer of the site.`);

  const params: JobParams = { duration_s: duration, format, language, voice };
  const job: Job = {
    id: rid("gt", 8), user_id: user.id, template: t.id, prompt, params: JSON.stringify(params),
    state: "queued", track: null, percent: 0, eta_min: etaFor(duration), credits,
    backend: null, instance_id: null, instance_meta: null, worker_secret: rid("wk", 32), attempts: 0,
    error: null, notify_email: input.notify_email ?? null, created_at: nowIso(), started_at: null, finished_at: null,
    expires_at: null, purged_at: null, cost_usd: null,
    storyboard, plan_attempts: 0, plan_error: null,
  };
  await insertJob(env, job);
  await audit(env, user.id, job.id, "job.created", { template: t.id, credits, duration, format, storyboard: storyboard ? "client" : "auto" });
  return job;
}

export async function cancelJob(env: Env, user: User, jobId: string): Promise<{ job: Job; refunded: number }> {
  const job = await getUserJob(env, user.id, jobId);
  if (!job) throw new JobError(`No job "${jobId}" on this account.`);
  if (!["queued", "starting", "rendering", "finishing"].includes(job.state)) throw new JobError(`Job ${job.id} is already ${job.state}.`);
  const refunded = job.state === "queued" ? job.credits : Math.floor((job.credits * (100 - job.percent)) / 100);
  if (job.state !== "queued") {
    try { await getBackend(env).destroy(env, job); } catch (e) { await audit(env, user.id, job.id, "backend.destroy.error", String(e)); }
  }
  await updateJob(env, job.id, { state: "cancelled", finished_at: nowIso(), error: "cancelled by user" });
  if (refunded > 0) await creditCredits(env, user.id, refunded);
  await audit(env, user.id, job.id, "job.cancelled", { refunded });
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

export async function resultLinks(env: Env, base: string, job: Job): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await listFiles(env, job.id)) {
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
