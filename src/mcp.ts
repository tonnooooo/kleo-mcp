import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "./env";
import type { User } from "./db";
import { getUserJob, getUser, recentJobsForUser } from "./db";
import { TEMPLATES, TEMPLATE_IDS } from "./templates";
import { createJob, cancelJob, jobView, resultLinks, JobError, FILE_NAMES } from "./jobs";
import { audit } from "./db";
import { STYLES, KINDS, BEAT_KINDS, BEAT_ICONS, BEAT_FX, CINEMA_ACCENTS, STORY_ACTS, STORY_CAST, STORY_PROPS, STORY_FX, VISUALS, MOTION, VOICES } from "./keou-contract";
import { creditsFor } from "./templates";

const INSTRUCTIONS = `This server is Kleo (kleo_* tools), the video studio the user connected. It is not kie-mcp or any other product. Kleo renders YouTube videos and Shorts (4K, 60 fps) from a template and a prompt. When the user mentions Kleo, a video, a Short, or a YouTube clip, use these tools instead of answering from memory.
Preferred flow for the best, most original videos: call kleo_storyboard_guide once, write a storyboard tailored to this conversation (hook, scenes, narration, visuals), then pass it as the "storyboard" argument of kleo_create_video. If you skip the storyboard, Kleo plans one from the prompt itself (fine, but more generic).
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


  server.registerTool("kleo_storyboard_guide", {
    title: "Storyboard guide (write your own video)",
    description: "Returns the storyboard format Kleo renders (styles, scene kinds, beats, icons, effects, voices, limits, rules) with two short examples, so you can write an original storyboard for kleo_create_video instead of letting Kleo plan a generic one. Call it once per conversation.",
    inputSchema: z.object({ template: z.enum(TEMPLATE_IDS).optional().describe("Template you intend to use; tailors the tips."), duration_s: z.number().int().min(15).max(900).optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ template, duration_s }) => {
    const t = TEMPLATES.find((x) => x.id === template) ?? null;
    const dur = duration_s ?? t?.defaultSeconds ?? 45;
    const words = Math.round(dur * 2.3);
    const scenes = dur <= 90 ? "4-8" : dur <= 300 ? "10-20" : "18-30";
    const text = `KLEO STORYBOARD GUIDE (engine: Keou, canvas motion design, 60 fps, local TTS)
Target: ${dur}s → about ${words} narrated words in ${scenes} scenes (speed 1.1). Every scene's "voice" is narrated by TTS and drives the timing; visuals are drawn per scene.

TOP-LEVEL OBJECT (no id, no script_file, no music_quiet, no image scenes):
{ "schema_version": 1, "editorial_status": "ready", "title": "<=120 chars", "brand": "Kleo or the channel name <=28",
  "style": one of ${JSON.stringify(STYLES)}, "format": "9:16" | "16:9", "language": "en" | "it" | "fr",
  "voice": en: af_heart|am_michael|bf_emma · it: if_sara|im_nicola · fr: ff_siwis, "speed": 0.8-1.3 (use 1.1), "music": "bed" | "none",
  "max_duration": ${Math.round(dur * 1.6)}, "description": "<=180", "tags": ["..."], "scenes": [...] }

STYLES: "cinema" (portrait-first, punchy Shorts: each scene has 1-8 beats = hero visuals cut on the narration), "stickman" (9:16 only, a hand-drawn character acting the story: scenes of kind "story"), "editorial" / "illustrated" / "technical" / "terminal" (landscape-friendly, one composition per scene: hero, list, compare, steps, metric, quote, closing).

CINEMA SCENE: { "id": "01-hook", "kind": "cinema", "chapter": "01 HOOK <=32", "accent": ${JSON.stringify(CINEMA_ACCENTS)}, "title": "<=90", "hl": "<=24 word highlighted", "voice": "1-3 sentences <=350 chars", "beats": [ ... 1-8 ... ], "hold": 0.15-3 }
 BEATS (each may carry "at": "<=24 chars quoted verbatim from this scene's voice", to sync the cut):
  {"kind":"type","text":"<=40 BIG TEXT","hl":"<=20","slam":true,"icon":<icon>,"fx":<fx>}   big typographic card
  {"kind":"icon","name":<icon>,"label":"<=24","fx":<fx>,"size":0.3-1}                       one hero icon
  {"kind":"split","items":[<icon>,<icon>],"label":"<=24"} · {"kind":"grid","items":[2-3 icons]}
  {"kind":"steps","items":["<=14","<=14","<=14"],"lit":1} · {"kind":"timeline","labels":["<=14"x2-4],"icons":[...]}
  {"kind":"bars","labels":["<=14"x1-4],"values":[ints 0-1000000]} · {"kind":"people","total":0-12,"lit":0-12,"label":"<=32"}
  {"kind":"terminal","lines":["<=48"x1-4],"label":"<=16"} · {"kind":"dialog","text":"<=32","count":1-5} · {"kind":"cta","label":"<=24","toggles":["<=14"x1-3]}
 ICONS: ${JSON.stringify(BEAT_ICONS)}  FX: ${JSON.stringify(BEAT_FX)}
 The icon set is small and tech-flavoured: use them as metaphors (radar=search, shield=safety, timer=time, figure/thief=people, wave=signal, house/car=places) and lean on "type" beats with strong words for everything else.

STICKMAN SCENE: { "id", "kind": "story", "act": ${JSON.stringify(STORY_ACTS)}, "cast": ["hero", +"thief"|"thief2"], "props": [<=3 of ${JSON.stringify(STORY_PROPS)}], "fx": ${JSON.stringify(STORY_FX)}, "accent": green|red|amber, "bubble": "<=40 speech bubble", "hl": "<=24", "title", "voice" }

EDITORIAL/ILLUSTRATED/TECHNICAL/TERMINAL SCENES: { "id", "kind": hero|list|compare|steps|metric|quote|closing, "eyebrow": "<=40", "title": "<=90", "detail": "<=110", "voice": "<=350", "visual": ${JSON.stringify(VISUALS)}, "hold": 0.65 }
  list/steps: "items": [3 x <=42] · compare: "items": [2] · metric: "value": "<=12", "unit": "<=45", "animate_value": true (value must start with a number) · quote: "quote": "<=120", "source": "<=80" · terminal style may add "terminal_lines": [1-3 x <=48] · closing: "button": "<=40" OR "detail".
  Motion backgrounds (optional, kind "image" is NOT allowed; use "motion" only on... skip motion unless you know the engine): ${JSON.stringify(MOTION)}.

RULES THE VALIDATOR ENFORCES: 2-240 scenes; unique slug ids [a-z0-9-]; last scene kind "closing"; cinema style only cinema/closing scenes; stickman only story/closing and 9:16; beat "at" must appear verbatim (case-insensitive) in that scene's voice; voice legal for language; total narration must fit max_duration (never exceed ~${Math.round(words * 1.25)} words for ${dur}s).

CREATIVE DIRECTION: open with a hook in the first sentence; vary accents per scene; alternate beat kinds (type → icon → steps → dialog...); one idea per scene; end with a clear closing (question, promise or CTA). Do not copy the examples; adapt tone and vocabulary to the user's topic and audience.

EXAMPLE A (cinema Short, 45s, en):
{"schema_version":1,"editorial_status":"ready","title":"The Island That Was Never on Any Map","brand":"Kleo","style":"cinema","format":"9:16","language":"en","voice":"am_michael","speed":1.1,"music":"bed","max_duration":72,"scenes":[
 {"id":"01-hook","kind":"cinema","chapter":"01 HOOK","accent":"red","title":"not on any map","hl":"map","voice":"In 1743, a pirate crew found an island that was not on any map. Three days later, it was gone.","beats":[{"kind":"type","text":"NOT ON ANY MAP","hl":"MAP","slam":true,"at":"not on any map"},{"kind":"icon","name":"radar","fx":"alarm","label":"day 3","at":"three days later"}]},
 {"id":"02-crew","kind":"cinema","chapter":"02 THE CREW","accent":"amber","title":"forty men","hl":"forty","voice":"Forty men rowed ashore. Only nine came back, and none of them agreed on what they saw.","beats":[{"kind":"people","total":12,"lit":3,"label":"9 of 40 returned","at":"only nine"},{"kind":"dialog","text":"What did you see?","count":3,"at":"none of them agreed"}]},
 {"id":"03-closing","kind":"closing","chapter":"03 END","accent":"cyan","title":"Follow for part two","voice":"Was it a mirage, a trick of the tide, or something the sea wanted to keep? Follow for part two.","beats":[{"kind":"cta","label":"PART TWO","toggles":["follow","share"],"at":"follow"}]}]}

EXAMPLE B (editorial long-form scene, 16:9, en):
{"id":"04-why-it-matters","kind":"steps","eyebrow":"WHY IT MATTERS","title":"Three things the map got wrong","detail":"Latitude, currents, and pride.","items":["Latitude was guessed","Currents were ignored","Nobody admitted it"],"visual":"network","voice":"The map got three things wrong. Latitude was guessed. Currents were ignored. And nobody wanted to admit it.","hold":0.8}
`;
    return ok({ guide: text, template: t?.id ?? null, duration_s: dur, words_target: words, credits: creditsFor(dur) }, text);
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
