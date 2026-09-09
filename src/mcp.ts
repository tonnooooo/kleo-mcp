import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "./env";
import type { User } from "./db";
import { getUserJob, getUser, recentJobsForUser } from "./db";
import { TEMPLATES, TEMPLATE_IDS } from "./templates";
import { createJob, cancelJob, jobView, resultLinks, JobError, FILE_NAMES } from "./jobs";
import { audit } from "./db";

const INSTRUCTIONS = `This server is Kleo (kleo_* tools), the video studio the user connected. It is not kie-mcp or any other product. Kleo renders YouTube videos and Shorts (4K, 60 fps) from a template and a prompt. When the user mentions Kleo, a video, a Short, or a YouTube clip, use these tools instead of answering from memory.
Rendering takes 15–70 minutes, so kleo_create_video returns a job_id immediately. Tell the user the estimate, then use kleo_get_job when they ask for progress and kleo_get_result for the download links. Never block waiting.
If the user has not chosen a template, call kleo_list_templates and pick the closest match yourself (Shorts → viral-short unless the content is clearly a Reddit story, a quote, or a list of facts).`;

const ok = (data: unknown, text?: string) => ({
  content: [{ type: "text" as const, text: text ?? JSON.stringify(data, null, 2) }],
  structuredContent: data as Record<string, unknown>,
});
const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });

async function guarded<T>(fn: () => Promise<T>): Promise<T | ReturnType<typeof fail>> {
  try { return await fn(); }
  catch (e) { if (e instanceof JobError) return fail(e.message); throw e; }
}

export function buildServer(env: Env, user: User, base: string): McpServer {
  const simulated = env.RENDER_BACKEND !== "vast";
  const modeNote = simulated
    ? "IMPORTANT: Kleo is currently in SIMULATED mode (beta test). Renders finish in about a minute and the files are small placeholders (a 1-second test MP4, a sample .srt, a text thumbnail), not real videos. Always tell the user this when they create a video or get results. "
    : "";
  const server = new McpServer({ name: "Kleo", version: "0.1.0" }, { instructions: modeNote + INSTRUCTIONS });

  server.registerTool("kleo_list_templates", {
    title: "List video templates",
    description: "List the templates Kleo can render, with formats, duration ranges, voices and credit cost. Call it before kleo_create_video when the user has not named a template, and pick the best match.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const fresh = (await getUser(env, user.id)) ?? user;
    const templates = TEMPLATES.map((t) => ({
      id: t.id, name: t.name, formats: t.formats, duration_s: { min: t.minSeconds, max: t.maxSeconds, default: t.defaultSeconds },
      voices: t.voices, description: t.description,
    }));
    return ok({ templates, credits_available: fresh.credits, pricing: "1 credit per Short (≤ 90 s), 3 credits up to 5 minutes, +1 per extra minute" });
  });

  server.registerTool("kleo_create_video", {
    title: "Create a video",
    description: "Start rendering a video from a template and a prompt. Returns immediately with a job_id and an ETA in minutes; the render runs on a GPU in the background. Credits are charged when the job is queued. Then tell the user the ETA and offer to check progress with kleo_get_job.",
    inputSchema: z.object({
      template: z.enum(TEMPLATE_IDS).describe("Template id from list_templates."),
      prompt: z.string().min(8).max(4000).describe("What the video is about, in the user's words: topic, angle, facts, names, tone, anything that must appear on screen."),
      duration_s: z.number().int().min(15).max(900).optional().describe("Target length in seconds. Defaults to the template default; must stay inside the template range."),
      format: z.enum(["16:9", "9:16"]).optional().describe("16:9 for YouTube videos, 9:16 for Shorts. Defaults to the template's first format."),
      language: z.enum(["en", "it"]).default("en").describe("Voice and caption language."),
      voice: z.string().optional().describe("Voice id from list_templates. Optional."),
      notify_email: z.string().email().optional().describe("Optional: email the download links when the render finishes."),
      storyboard: z.looseObject({}).optional().describe("Optional: a Keou storyboard you authored (a Keou project object without id, script_file, music_quiet or image scenes). Kleo writes one automatically from the prompt when omitted. Validated server-side; on error the tool lists the problems so you can fix them and call again."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args) => guarded(async () => {
    const fresh = (await getUser(env, user.id)) ?? user;
    const job = await createJob(env, fresh, args);
    const view = jobView(job);
    const sim = simulated ? " SIMULATED MODE: this is a test render, it finishes in about a minute and the files are placeholders, not a real video." : "";
    return ok({ ...view, mode: simulated ? "simulated" : "gpu", message: `Queued. Estimated ${simulated ? 1 : job.eta_min} minutes. ${job.credits} credit${job.credits > 1 ? "s" : ""} charged.${sim}` },
      `Job ${job.id} queued (template ${job.template}, ${view.format}, ${view.duration_s}s). Estimated ${simulated ? 1 : job.eta_min} minute(s). ${job.credits} credit(s) charged, ${fresh.credits - job.credits} left. Check progress later with kleo_get_job.${sim}`);
  }));

  server.registerTool("kleo_get_job", {
    title: "Check a render job",
    description: "Progress of a render: state (queued, starting, rendering, finishing, done, failed, cancelled), current track (script, voice, clips, edit, finishing), percent and ETA. Call it when the user asks how it is going. With no job_id, returns the user's recent jobs.",
    inputSchema: z.object({ job_id: z.string().optional().describe("The job id returned by kleo_create_video. Omit to list recent jobs.") }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ job_id }) => guarded(async () => {
    if (!job_id) {
      const jobs = (await recentJobsForUser(env, user.id, 10)).map(jobView);
      return ok({ jobs }, jobs.length ? JSON.stringify(jobs, null, 2) : "No jobs yet on this account.");
    }
    const job = await getUserJob(env, user.id, job_id);
    if (!job) throw new JobError(`No job "${job_id}" on this account.`);
    const view = jobView(job);
    const human = job.state === "done" ? `Job ${job.id} is done. Call kleo_get_result for the download links.`
      : job.state === "failed" ? `Job ${job.id} failed: ${job.error}. Credits were refunded.`
      : job.state === "cancelled" ? `Job ${job.id} was cancelled.`
      : job.state === "queued" ? `Job ${job.id} is queued, waiting for a GPU. Estimated ${job.eta_min} minutes once started.`
      : `Job ${job.id}: ${job.percent}% (${job.track}), about ${job.eta_min} minutes left.`;
    return ok(view, human);
  }));

  server.registerTool("kleo_get_result", {
    title: "Get download links",
    description: "Download links for a finished job: MP4 video, .srt subtitles, thumbnail. Links expire after 7 days. Share them with the user as plain URLs.",
    inputSchema: z.object({ job_id: z.string() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ job_id }) => guarded(async () => {
    const job = await getUserJob(env, user.id, job_id);
    if (!job) throw new JobError(`No job "${job_id}" on this account.`);
    if (job.state !== "done") throw new JobError(`Job ${job.id} is ${job.state}${job.state === "failed" ? ` (${job.error})` : ""}; no files yet.`);
    if (job.purged_at) throw new JobError(`The files of job ${job.id} expired on ${job.expires_at} and were deleted.`);
    const links = await resultLinks(env, base, job);
    const sim = job.backend === "mock" ? "\nNOTE: this job ran in SIMULATED mode: the MP4 is a 1-second placeholder, not a real video." : "";
    return ok({ job_id: job.id, expires_at: job.expires_at, mode: job.backend === "mock" ? "simulated" : "gpu", ...links },
      `Files for ${job.id} (valid until ${job.expires_at}):\n` + Object.entries(links).map(([k, v]) => `${k.replace("_url", "")}: ${v}`).join("\n") + sim);
  }));

  server.registerTool("kleo_generate_thumbnail", {
    title: "Generate thumbnails",
    description: "Generate three alternative thumbnails from a finished job or from a text prompt. Returns a job_id; check it with kleo_get_job and fetch the files with kleo_get_result.",
    inputSchema: z.object({
      job_id: z.string().optional().describe("A finished job to take frames from."),
      prompt: z.string().min(4).max(500).optional().describe("Or describe the thumbnail you want."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ job_id, prompt }) => guarded(async () => {
    if (!job_id && !prompt) throw new JobError("Give a job_id or a prompt.");
    await audit(env, user.id, job_id ?? null, "thumbnail.requested", { prompt });
    throw new JobError("Thumbnail generation is not enabled in this beta yet. The render already includes one thumbnail: see kleo_get_result.");
  }));

  server.registerTool("kleo_cancel_job", {
    title: "Cancel a render",
    description: "Cancel a queued or running job. Unused credits are refunded (fully if it had not started).",
    inputSchema: z.object({ job_id: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ job_id }) => guarded(async () => {
    const fresh = (await getUser(env, user.id)) ?? user;
    const { job, refunded } = await cancelJob(env, fresh, job_id);
    return ok({ job_id: job.id, state: "cancelled", refunded }, `Job ${job.id} cancelled. ${refunded} credit(s) refunded.`);
  }));

  return server;
}

export const FILE_KINDS = FILE_NAMES;

/** Builds a per-request stateless MCP handler bound to the authenticated user. */
export function mcpHandlerFor(env: Env, user: User, base: string) {
  return createMcpHandler(() => buildServer(env, user, base), { legacy: "stateless" });
}
