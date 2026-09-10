import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "./env";
import type { User, Job } from "./db";
import { getUserJob, getUser, recentJobsForUser, countOpenForUser } from "./db";
import { TEMPLATES, TEMPLATE_IDS, findTemplate, creditsFor } from "./templates";
import { createJob, cancelJob, jobView, resultLinks, JobError, FILE_NAMES } from "./jobs";
import { audit } from "./db";
import { STYLES, KINDS, BEAT_KINDS, BEAT_ICONS, BEAT_FX, CINEMA_ACCENTS, STORY_ACTS, STORY_CAST, STORY_PROPS, STORY_FX, VISUALS, MOTION, VOICES, KLEO_STYLES, IMAGE_PROMPT_MAX } from "./keou-contract";
import { int } from "./util";

const INSTRUCTIONS = `This server is Kleo (the kleo_* tools): the video studio the user connected. It is not kie-mcp or any other product. Kleo renders YouTube videos and Shorts (4K, 60 fps) from a template and a prompt. When the user mentions Kleo, a video, a Short or a YouTube clip, use these tools; never answer from memory.
DELIVERY RULE: the user expects the finished video in this same conversation, without coming back later. After kleo_create_video, call kleo_wait_for_video repeatedly (each call waits up to 50 seconds and returns progress) until it returns the download links, then hand them over. Tell the user once that the render is running and the estimated time; do not ask "shall I keep waiting?"; keep calling until done unless the user says stop.
Order of calls: 1) kleo_list_templates if the user has not named a template (Shorts → viral-short unless the content is clearly a Reddit story, a quote or a list of facts). 2) kleo_storyboard_guide once per conversation, then write an original storyboard for this conversation (hook, scenes, narration, visuals, and for the cartoon/realistic styles a picture description per scene) and pass it as the "storyboard" argument of kleo_create_video; if you skip it, Kleo plans a more generic storyboard from the prompt. Every video has a visual style (cartoon, realistic, cyber or stickman): pass "style" when the user has a preference, otherwise Kleo picks one from the topic. 3) kleo_create_video: it returns at once with a video number (job_id) and an estimate in minutes. 4) kleo_get_job when the user asks how it is going. 5) kleo_get_result for the download links once it is done.
Rendering runs on a GPU in the background: a Short usually takes about 10–20 minutes, long videos longer. The estimate to quote is the eta_min the server returns, never your own guess; never block or loop waiting. Never invent progress, files or links: only repeat what these tools return. Call the video by its number (for example "video gt_ab12cd34"), not "job".`;

const ok = (data: unknown, text?: string) => ({
  content: [{ type: "text" as const, text: text ?? JSON.stringify(data, null, 2) }],
  structuredContent: data as Record<string, unknown>,
});
const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });

async function guarded<T>(fn: () => Promise<T>): Promise<T | ReturnType<typeof fail>> {
  try { return await fn(); }
  catch (e) { if (e instanceof JobError) return fail(e.message); throw e; }
}

/** "1 credit" / "3 credits", "1 minute" / "20 minutes". */
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** "17 September 2026" from an ISO timestamp (falls back to the date part). */
function niceDate(iso: string | null | undefined): string {
  if (!iso) return "later";
  try { return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }); }
  catch { return iso.slice(0, 10); }
}
/** "Short" for vertical videos, "video" otherwise. */
const kindOf = (format: string | null | undefined) => (format === "9:16" ? "Short" : "video");
const templateName = (id: string) => findTemplate(id)?.name ?? id;
const TRACK_LABEL: Record<string, string> = {
  script: "writing the script", voice: "recording the narration", clips: "drawing the scenes", edit: "editing", finishing: "finishing up",
};
const trackLabel = (track: string | null) => (track && TRACK_LABEL[track]) || "working";
const noSuchVideo = (id: string) =>
  new JobError(`There is no video number "${id}" on this account. Check the number, or call kleo_get_job without a number to see your recent videos.`);


/** Download links for a finished job, as data + human text (shared by kleo_get_result and kleo_wait_for_video). */
async function resultPayload(env: Env, base: string, job: Job) {
  const what = kindOf(jobView(job).format);
  const links = await resultLinks(env, base, job);
  const label: Record<string, string> = { video_url: "Video (MP4)", subtitles_url: "Subtitles (.srt)", thumbnail_url: "Thumbnail" };
  const order = ["video_url", "subtitles_url", "thumbnail_url"];
  const sim = job.backend === "mock" ? "\nNOTE: this video was rendered in SIMULATED mode: the MP4 is a 1-second placeholder, not a real video." : "";
  const text = `Your ${what} ${job.id} is ready. The links work until ${niceDate(job.expires_at)}:\n` +
    Object.entries(links).sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)).map(([k, v]) => `${label[k] ?? k.replace("_url", "")}: ${v}`).join("\n") + sim;
  return { data: { job_id: job.id, state: "done", expires_at: job.expires_at, mode: job.backend === "mock" ? "simulated" : "gpu", ...links }, text };
}


/** Which assistant is calling, from the MCP clientInfo envelope (2026 protocol) or the HTTP user agent, and how long one wait call may safely last there. */
function detectClient(ctx: unknown): { name: string; waitS: number; ua: string } {
  const c = ctx as { http?: { req?: Request }; mcpReq?: { _meta?: Record<string, unknown> } } | undefined;
  const ua = c?.http?.req?.headers.get("user-agent") ?? "";
  const info = c?.mcpReq?._meta?.["io.modelcontextprotocol/clientInfo"] as { name?: string } | undefined;
  const n = String(info?.name ?? "").toLowerCase(), u = ua.toLowerCase();
  const has = (...k: string[]) => k.some((x) => n.includes(x) || u.includes(x));
  if (has("claude-code", "claude code")) return { name: "claude-code", waitS: 110, ua };   // auto-backgrounds after 2 min, no cap
  if (has("opencode")) return { name: "opencode", waitS: 300, ua };                         // execution timeout 12 h
  if (has("cursor")) return { name: "cursor", waitS: 50, ua };                              // 60 s hard limit
  if (has("chatgpt", "openai")) return { name: "chatgpt", waitS: 45, ua };                  // 60 s hard limit
  if (has("grok", "xai", "x.ai")) return { name: "grok", waitS: 45, ua };                   // undocumented, assume 60 s
  if (has("claude", "anthropic")) return { name: "claude", waitS: 170, ua };                // 300 s documented, ~10-20 calls per turn
  return { name: n || "unknown", waitS: 45, ua };
}

export function buildServer(env: Env, user: User, base: string): McpServer {
  const simulated = env.RENDER_BACKEND === "mock";
  const modeNote = simulated
    ? "IMPORTANT: Kleo is running in SIMULATED mode (test). Renders finish in about a minute and the files are small placeholders (a 1-second test MP4, a sample subtitle file, a plain thumbnail), not real videos. Tell the user this every time they create a video or get the links. "
    : "";
  const server = new McpServer({ name: "Kleo", version: "0.1.0" }, { instructions: modeNote + INSTRUCTIONS });

  server.registerTool("kleo_list_templates", {
    title: "List video templates",
    description: "Step 1. Lists the templates Kleo can render (id, name, format, length range, voices) and the credits left on the account. Call it when the user has not named a template, then pick the closest match yourself. Prices: 1 credit per Short (up to 90 seconds), 3 credits up to 5 minutes, +1 credit per extra minute.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const fresh = (await getUser(env, user.id)) ?? user;
    const templates = TEMPLATES.map((t) => ({
      id: t.id, name: t.name, formats: t.formats, duration_s: { min: t.minSeconds, max: t.maxSeconds, default: t.defaultSeconds },
      credits: creditsFor(t.defaultSeconds), voices: t.voices, description: t.description,
    }));
    const lines = TEMPLATES.map((t) => {
      const shape = t.formats.map((f) => (f === "9:16" ? "Short (9:16)" : "YouTube video (16:9)")).join(" or ");
      return `- ${t.name} (id: ${t.id}): ${shape}, ${t.minSeconds}–${t.maxSeconds} seconds, ${plural(creditsFor(t.defaultSeconds), "credit")}. ${t.description}`;
    });
    return ok(
      { templates, credits_available: fresh.credits, pricing: "1 credit per Short (up to 90 seconds), 3 credits up to 5 minutes, +1 credit per extra minute" },
      `Kleo has ${TEMPLATES.length} templates. You have ${plural(fresh.credits, "credit")} left.\n${lines.join("\n")}\nPrices: 1 credit per Short (up to 90 seconds), 3 credits up to 5 minutes, +1 credit per extra minute.`,
    );
  });


  server.registerTool("kleo_storyboard_guide", {
    title: "Storyboard guide (write your own video)",
    description: "Step 2 (recommended). Returns the storyboard format Kleo renders (visual styles: cartoon, realistic, cyber, stickman; scene kinds, beats, icons, effects, picture descriptions, voices, limits, rules) with two short examples, so you can write an original storyboard tailored to the user and pass it to kleo_create_video. Call it once per conversation, before kleo_create_video. Without a storyboard Kleo plans a more generic one from the prompt.",
    inputSchema: z.object({
      template: z.enum(TEMPLATE_IDS).optional().describe("The template you intend to use; tailors the target length."),
      duration_s: z.number().int().min(15).max(900).optional().describe("Target length in seconds, if the user chose one."),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ template, duration_s }) => {
    const t = TEMPLATES.find((x) => x.id === template) ?? null;
    const dur = duration_s ?? t?.defaultSeconds ?? 45;
    const words = Math.round(dur * 2.3);
    const scenes = dur <= 90 ? "4-8" : dur <= 300 ? "10-20" : "18-30";
    const text = `KLEO STORYBOARD GUIDE (engine: Keou, canvas motion design, 60 fps, local TTS)
Target: ${dur}s → about ${words} narrated words in ${scenes} scenes (speed 1.1). Every scene's "voice" is narrated by TTS and drives the timing; visuals are drawn per scene.

TOP-LEVEL OBJECT (no id, no script_file, no music_quiet, no image scenes, never scene.image):
{ "schema_version": 1, "editorial_status": "ready", "title": "<=120 chars", "brand": "Kleo or the channel name <=28", "kleo_style": one of ${JSON.stringify(KLEO_STYLES)},
  "style": one of ${JSON.stringify(STYLES)}, "format": "9:16" | "16:9", "language": "en" | "it" | "fr",
  "voice": en: af_heart|am_michael|bf_emma · it: if_sara|im_nicola · fr: ff_siwis, "speed": 0.8-1.3 (use 1.1), "music": "bed" | "none",
  "max_duration": ${Math.round(dur * 1.6)}, "description": "<=180", "tags": ["..."], "scenes": [...] }

KLEO STYLES ("kleo_style", always set it; it must match the Keou "style"):
 "cartoon": flat vector illustrations generated for each scene from your description (pirates → beach, sand, ships; space → rockets, stations), drawn full-screen behind the beats. Stories, kids, travel, animals, history, fun facts. Needs style "cinema" (9:16 or 16:9).
 "realistic": a cinematic photo look, one generated picture per scene. Products, places, news, sport, documentaries. Needs style "cinema".
 "cyber": the plain Keou motion-design look (dark background, glowing icons, big type), no pictures. Tech, security, AI, code. Works with any Keou style except stickman.
 "stickman": a hand-drawn stickman acting the story (Keou style "stickman", scenes of kind "story", 9:16 only). Only when the user asks for it.
 cartoon/realistic: EVERY scene (closing included) carries "image_prompt" (<=${IMAGE_PROMPT_MAX} chars): one sentence with concrete subjects and setting, the same characters described the same way in every scene, mood and light; NO text, letters, logos or captions in the picture, no real people. Kleo generates the pictures (up to 10 per video, spread over the scenes); never set scene.image.
KEOU STYLES: "cinema" (portrait-first, punchy: each scene has 1-8 beats = hero visuals cut on the narration; also used for 16:9 cartoon/realistic videos), "stickman" (9:16 only, scenes of kind "story"), "editorial" / "illustrated" / "technical" / "terminal" (landscape-friendly, one composition per scene: hero, list, compare, steps, metric, quote, closing; cyber only).

CINEMA SCENE: { "id": "01-hook", "kind": "cinema", "chapter": "01 HOOK <=32", "accent": ${JSON.stringify(CINEMA_ACCENTS)}, "title": "<=90", "hl": "<=24 word highlighted", "voice": "1-3 sentences <=350 chars", "image_prompt": "<=${IMAGE_PROMPT_MAX} (cartoon/realistic)", "beats": [ ... 1-8 ... ], "hold": 0.15-3 }
 BEATS (each may carry "at": "<=24 chars quoted verbatim from this scene's voice", to sync the cut):
  {"kind":"type","text":"<=40 BIG TEXT","hl":"<=20","slam":true,"icon":<icon>,"fx":<fx>}   big typographic card
  {"kind":"icon","name":<icon>,"label":"<=24","fx":<fx>,"size":0.3-1}                       one hero icon
  {"kind":"split","items":[<icon>,<icon>],"label":"<=24"} · {"kind":"grid","items":[2-3 icons]}
  {"kind":"steps","items":["<=14","<=14","<=14"],"lit":1} · {"kind":"timeline","labels":["<=14"x2-4],"icons":[...]}
  {"kind":"bars","labels":["<=14"x1-4],"values":[ints 0-1000000]} · {"kind":"people","total":0-12,"lit":0-12,"label":"<=32"}
  {"kind":"terminal","lines":["<=48"x1-4],"label":"<=16"} · {"kind":"dialog","text":"<=32","count":1-5} · {"kind":"cta","label":"<=24","toggles":["<=14"x1-3]}
 ICONS: ${JSON.stringify(BEAT_ICONS)}  FX: ${JSON.stringify(BEAT_FX)}
 The icon set is small and tech-flavoured: use them as metaphors (radar=search, shield=safety, timer=time, figure/thief=people, wave=signal, house/car=places) and lean on "type" beats with strong words for everything else.
 cartoon/realistic: the picture already shows the people and the place, so do NOT use figure/person/thief icons (Kleo replaces them with words) and keep 2-4 beats per scene so the picture breathes: "type" beats with 2-4 strong words, timeline, steps, people counts, bars, metric-like numbers. Icons only as small metaphors on type beats (check, cross, alarm, timer, lock, map-like ones).

STICKMAN SCENE: { "id", "kind": "story", "act": ${JSON.stringify(STORY_ACTS)}, "cast": ["hero", +"thief"|"thief2"], "props": [<=3 of ${JSON.stringify(STORY_PROPS)}], "fx": ${JSON.stringify(STORY_FX)}, "accent": green|red|amber, "bubble": "<=40 speech bubble", "hl": "<=24", "title", "voice" }

EDITORIAL/ILLUSTRATED/TECHNICAL/TERMINAL SCENES: { "id", "kind": hero|list|compare|steps|metric|quote|closing, "eyebrow": "<=40", "title": "<=90", "detail": "<=110", "voice": "<=350", "visual": ${JSON.stringify(VISUALS)}, "hold": 0.65 }
  list/steps: "items": [3 x <=42] · compare: "items": [2] · metric: "value": "<=12", "unit": "<=45", "animate_value": true (value must start with a number) · quote: "quote": "<=120", "source": "<=80" · terminal style may add "terminal_lines": [1-3 x <=48] · closing: "button": "<=40" OR "detail".
  Motion backgrounds (optional, kind "image" is NOT allowed; skip "motion" unless you know the engine): ${JSON.stringify(MOTION)}.

RULES THE VALIDATOR ENFORCES: 2-240 scenes; unique slug ids [a-z0-9-]; last scene kind "closing"; cinema style only cinema/closing scenes; stickman only story/closing and 9:16; kleo_style cartoon/realistic need style "cinema", kleo_style stickman needs style "stickman"; image_prompt <=${IMAGE_PROMPT_MAX} chars, scene.image forbidden; beat "at" must appear verbatim (case-insensitive) in that scene's voice; voice legal for language; total narration must fit max_duration (never exceed ~${Math.round(words * 1.25)} words for ${dur}s).

CREATIVE DIRECTION: open with a hook in the first sentence; vary accents per scene; alternate beat kinds (type → icon → steps → dialog...); one idea per scene; end with a clear closing (question, promise or CTA). Pictures should change setting or moment from scene to scene while keeping the same characters. Do not copy the examples; adapt tone and vocabulary to the user's topic and audience.

EXAMPLE A (cartoon cinema Short, 45s, en; one image_prompt per scene):
{"schema_version":1,"editorial_status":"ready","title":"The Island That Was Never on Any Map","brand":"Kleo","kleo_style":"cartoon","style":"cinema","format":"9:16","language":"en","voice":"am_michael","speed":1.1,"music":"bed","max_duration":72,"scenes":[
 {"id":"01-hook","kind":"cinema","chapter":"01 HOOK","accent":"red","title":"not on any map","hl":"map","voice":"In 1743, a pirate crew found an island that was not on any map. Three days later, it was gone.","image_prompt":"A wooden pirate ship with red sails at anchor in a turquoise bay, a small green island with palm trees under a stormy purple sky","beats":[{"kind":"type","text":"NOT ON ANY MAP","hl":"MAP","slam":true,"at":"not on any map"},{"kind":"icon","name":"radar","fx":"alarm","label":"day 3","at":"three days later"}]},
 {"id":"02-crew","kind":"cinema","chapter":"02 THE CREW","accent":"amber","title":"forty men","hl":"forty","voice":"Forty men rowed ashore. Only nine came back, and none of them agreed on what they saw.","image_prompt":"Pirates in striped shirts and bandanas rowing longboats onto a golden beach at dawn, the same red-sailed ship waiting behind them","beats":[{"kind":"people","total":12,"lit":3,"label":"9 of 40 returned","at":"only nine"},{"kind":"dialog","text":"What did you see?","count":3,"at":"none of them agreed"}]},
 {"id":"03-closing","kind":"closing","chapter":"03 END","accent":"cyan","title":"Follow for part two","voice":"Was it a mirage, a trick of the tide, or something the sea wanted to keep? Follow for part two.","image_prompt":"Empty open sea at sunset seen from the deck of the red-sailed pirate ship, calm orange water, a faint outline of an island fading in the haze","beats":[{"kind":"cta","label":"PART TWO","toggles":["follow","share"],"at":"follow"}]}]}

EXAMPLE B (editorial long-form scene, 16:9, en):
{"id":"04-why-it-matters","kind":"steps","eyebrow":"WHY IT MATTERS","title":"Three things the map got wrong","detail":"Latitude, currents, and pride.","items":["Latitude was guessed","Currents were ignored","Nobody admitted it"],"visual":"network","voice":"The map got three things wrong. Latitude was guessed. Currents were ignored. And nobody wanted to admit it.","hold":0.8}
`;
    return ok({ guide: text, template: t?.id ?? null, duration_s: dur, words_target: words, credits: creditsFor(dur), styles: [...KLEO_STYLES] }, text);
  });

  server.registerTool("kleo_create_video", {
    title: "Create a video",
    description: "Step 3. Starts rendering a video or Short from a template, a prompt and a visual style (cartoon, realistic, cyber or stickman; plus your storyboard from kleo_storyboard_guide, if you wrote one). Returns at once with the video number (job_id), the estimated minutes (eta_min) and the credits used; the render runs on a GPU in the background. Tell the user the number and the estimate, then offer to check progress with kleo_get_job. If the tool returns an error, nothing was charged: fix what it says and call again.",
    inputSchema: z.object({
      template: z.string().optional().describe(`Required. Template id from kleo_list_templates: ${TEMPLATE_IDS.join(", ")}.`),
      prompt: z.string().describe("What the video is about, in the user's words (8 to 4000 characters): topic, angle, facts, names, tone, anything that must appear on screen."),
      duration_s: z.number().optional().describe("Target length in seconds. Defaults to the template default and must stay inside the template's range."),
      format: z.enum(["16:9", "9:16"]).optional().describe("16:9 for YouTube videos, 9:16 for Shorts. Defaults to the template's first format."),
      language: z.enum(["en", "it"]).default("en").describe("Voice and caption language."),
      voice: z.string().optional().describe("Voice id from kleo_list_templates. Optional."),
      style: z.enum(KLEO_STYLES).optional().describe("Visual style. cartoon: flat vector illustrations generated for the topic, drawn behind every scene (stories, kids, travel, animals, history). realistic: cinematic photo-look pictures generated for every scene (products, places, news). cyber: Kleo's motion-design look with glowing icons and big type, no pictures (tech, security, AI). stickman: a hand-drawn stickman acting the story, 9:16 Shorts only. Omit it and Kleo picks one from the topic (never stickman)."),
      notify_email: z.string().email().optional().describe("Optional: email the download links when the render finishes."),
      storyboard: z.looseObject({}).optional().describe("Optional but recommended: the storyboard you wrote following kleo_storyboard_guide (a Keou project object without id, script_file, music_quiet or image scenes). When omitted, Kleo plans one from the prompt. Checked before anything is charged; on error the tool lists the problems so you can fix them and call again."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args) => guarded(async () => {
    if (!args.template) throw new JobError("Choose a template first: call kleo_list_templates and pass its id as \"template\" (for a Short, viral-short is the usual choice). Nothing was charged.");
    const t = findTemplate(args.template);
    if (!t) throw new JobError(`There is no template called "${args.template}". Call kleo_list_templates and use one of these ids: ${TEMPLATE_IDS.join(", ")}. Nothing was charged.`);
    const fresh = (await getUser(env, user.id)) ?? user;
    const duration = Math.round(args.duration_s ?? t.defaultSeconds);
    const cost = creditsFor(duration);
    if (duration >= t.minSeconds && duration <= t.maxSeconds && fresh.credits < cost)
      throw new JobError(`Not enough credits: this ${kindOf(args.format ?? t.formats[0])} costs ${plural(cost, "credit")} and you have ${plural(fresh.credits, "credit")}. Ask the Kleo team for more credits. Nothing was charged.`);
    const maxOpen = int(env.MAX_JOBS_PER_USER, 2);
    const open = await countOpenForUser(env, user.id);
    if (open >= maxOpen)
      throw new JobError(`You already have ${plural(open, "video")} in progress, and the limit is ${maxOpen} at a time. Wait for one to finish (kleo_get_job) or cancel one with kleo_cancel_job. Nothing was charged.`);
    const job = await createJob(env, fresh, { ...args, template: t.id });
    const view = jobView(job);
    const what = kindOf(view.format);
    const sim = simulated ? " SIMULATED MODE: this is a test render; it finishes in about a minute and the files are placeholders, not a real video." : "";
    const eta = simulated ? "about a minute" : `about ${plural(job.eta_min ?? 0, "minute")}`;
    const styleNote = view.style ? ` Style: ${view.style}${args.style || (args.storyboard as Record<string, unknown> | undefined)?.kleo_style ? "" : " (picked from the topic)"}.` : "";
    const summary = `Your ${what} is in the queue. Video number: ${job.id}. Template: ${t.name}, ${view.format}, ${view.duration_s} seconds.${styleNote} It should be ready in ${eta}. ${plural(job.credits, "credit")} used, ${plural(fresh.credits - job.credits, "credit")} left. Check progress any time with kleo_get_job.${sim}`;
    return ok({ ...view, credits_left: fresh.credits - job.credits, mode: simulated ? "simulated" : "gpu", message: summary }, summary);
  }));

  const statusLine = (job: Job): string => {
    const view = jobView(job);
    const what = kindOf(view.format);
    switch (job.state) {
      case "done": return `Your ${what} ${job.id} is ready. Call kleo_get_result for the download links.`;
      case "failed": return `Sorry, ${what} ${job.id} could not be rendered. Your ${plural(job.credits, "credit")} ${job.credits === 1 ? "was" : "were"} given back. Please try again; if it happens again, tell the Kleo team.${job.error ? ` (Technical detail: ${job.error})` : ""}`;
      case "cancelled": return `${what[0].toUpperCase() + what.slice(1)} ${job.id} was cancelled.`;
      case "queued": return `Your ${what} ${job.id} is in the queue, waiting for a free GPU. Once it starts it takes ${simulated ? "about a minute" : `about ${plural(job.eta_min ?? 0, "minute")}`}.`;
      default: return `Your ${what} ${job.id} is ${job.percent}% done (${trackLabel(job.track)}). ${simulated ? "Less than a minute to go." : `About ${plural(Math.max(1, job.eta_min ?? 1), "minute")} to go.`}`;
    }
  };

  server.registerTool("kleo_get_job", {
    title: "Check progress",
    description: "Step 4. Progress of a video: state (queued, starting, rendering, finishing, done, failed, cancelled), what it is doing now, percent done and minutes left (eta_min). Use it for a one-off status check; to wait until the video is ready use kleo_wait_for_video instead. When the state is done, call kleo_get_result. Without a job_id it lists the account's recent videos.",
    inputSchema: z.object({ job_id: z.string().optional().describe("The video number returned by kleo_create_video (for example gt_ab12cd34). Omit to list recent videos.") }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ job_id }) => guarded(async () => {
    if (!job_id) {
      const jobs = await recentJobsForUser(env, user.id, 10);
      const lines = jobs.map((j) => {
        const v = jobView(j);
        const status = j.state === "done" ? `ready (links valid until ${niceDate(j.expires_at)})`
          : j.state === "failed" ? "failed (credits given back)"
          : j.state === "cancelled" ? "cancelled"
          : j.state === "queued" ? "waiting in the queue"
          : `${j.percent}% done`;
        return `- ${j.id}: ${v.duration_s}-second ${kindOf(v.format)}, template "${templateName(j.template)}", ${status}`;
      });
      return ok({ jobs: jobs.map(jobView) }, jobs.length ? `Your recent videos:\n${lines.join("\n")}` : "No videos on this account yet. Create one with kleo_create_video.");
    }
    const job = await getUserJob(env, user.id, job_id);
    if (!job) throw noSuchVideo(job_id);
    return ok(jobView(job), statusLine(job));
  }));


  server.registerTool("kleo_wait_for_video", {
    title: "Wait for the video (keeps the chat working until it is ready)",
    description: "Step 4b. Waits up to max_wait_s seconds (default 50) for a video and returns either the download links (when done) or its progress. THIS IS HOW YOU DELIVER A VIDEO WITHOUT ASKING THE USER TO COME BACK: after kleo_create_video, call kleo_wait_for_video again and again, one call after the other, until it returns the links (a Short usually needs 15–25 calls, a long video more). Do not stop after a few calls and do not ask the user whether to continue; only stop if the user asks you to, or if the result says the video failed or was cancelled. Say once that the render is running and how long it should take, then keep calling silently and finally hand over the links.",
    inputSchema: z.object({
      job_id: z.string().optional().describe("The video number from kleo_create_video. Omit to wait for your most recent video."),
      max_wait_s: z.number().int().min(10).max(600).optional().describe("How long this call may wait before reporting progress, in seconds. Leave it empty: Kleo picks a safe value for your client (45 s for ChatGPT and Grok, 170 s for Claude, 5 minutes for OpenCode)."),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ job_id, max_wait_s }, ctx) => guarded(async () => {
    let job = job_id ? await getUserJob(env, user.id, job_id) : (await recentJobsForUser(env, user.id, 1))[0];
    if (!job) throw job_id ? noSuchVideo(job_id) : new JobError("No videos on this account yet. Create one with kleo_create_video.");
    const signal = ctx?.mcpReq?.signal;
    const client = detectClient(ctx);
    const waitS = Math.min(600, Math.max(10, max_wait_s ?? client.waitS));
    const started = Date.now();
    const deadline = started + waitS * 1000;
    const progressToken = (ctx?.mcpReq?._meta as Record<string, unknown> | undefined)?.progressToken as string | number | undefined;
    const finished = (j: Job) => j.state === "done" || j.state === "failed" || j.state === "cancelled";
    void audit(env, user.id, job.id, "wait.call", { client: client.name, ua: client.ua.slice(0, 80), wait_s: waitS, state: job.state, percent: job.percent });
    let tickN = 0;
    while (!finished(job) && Date.now() < deadline && !signal?.aborted) {
      await new Promise((r) => setTimeout(r, 5000));
      job = (await getUserJob(env, user.id, job.id)) ?? job;
      tickN++;
      if (progressToken !== undefined && ctx?.mcpReq?.notify) {
        try {
          await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken, progress: tickN, message: job.state === "queued" ? "waiting for a renderer" : `${job.percent}% · ${trackLabel(job.track)}` } });
        } catch { /* client may not accept progress */ }
      }
    }
    const what = kindOf(jobView(job).format);
    if (job.state === "done") {
      const r = await resultPayload(env, base, job);
      return ok(r.data, r.text);
    }
    if (job.state === "failed") return ok({ ...jobView(job), next: "stop" }, `Sorry, ${what} ${job.id} could not be rendered: ${job.error ?? "unknown error"}. Your credits were given back. You can try again with kleo_create_video.`);
    if (job.state === "cancelled") return ok({ ...jobView(job), next: "stop" }, `${what[0].toUpperCase() + what.slice(1)} ${job.id} was cancelled.`);
    const eta = job.eta_min ? ` About ${plural(job.eta_min, "minute")} to go.` : "";
    const where = job.state === "queued" ? "waiting for a renderer" : `${job.percent}% done (${trackLabel(job.track)})`;
    return ok({ ...jobView(job), next: "call kleo_wait_for_video again" }, `Still rendering: ${what} ${job.id} is ${where}.${eta} Call kleo_wait_for_video again now to keep waiting; the links will come back from that call as soon as it is ready.`);
  }));

  server.registerTool("kleo_get_result", {
    title: "Get download links",
    description: "Step 5. Download links for a finished video: the MP4, the subtitles (.srt) and the thumbnail. Only works when kleo_get_job says the state is done. Links stop working after 7 days. Share them with the user exactly as returned, as plain URLs; never make up a link.",
    inputSchema: z.object({ job_id: z.string().describe("The video number returned by kleo_create_video.") }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ job_id }) => guarded(async () => {
    const job = await getUserJob(env, user.id, job_id);
    if (!job) throw noSuchVideo(job_id);
    const what = kindOf(jobView(job).format);
    if (job.state === "cancelled") throw new JobError(`${what[0].toUpperCase() + what.slice(1)} ${job.id} was cancelled, so there are no files. Create it again with kleo_create_video if you want it.`);
    if (job.state === "failed") throw new JobError(`Sorry, ${what} ${job.id} could not be rendered, so there are no files. Your credits were given back. Please try again.`);
    if (job.state !== "done") throw new JobError(`Your ${what} ${job.id} is not ready yet: ${job.state === "queued" ? "it is waiting in the queue" : `${job.percent}% done (${trackLabel(job.track)})`}. Check again later with kleo_get_job.`);
    if (job.purged_at) throw new JobError(`The files of ${what} ${job.id} expired on ${niceDate(job.expires_at)} and were deleted. Files are kept for 7 days; create the video again if you need it.`);
    const r = await resultPayload(env, base, job);
    return ok(r.data, r.text);
  }));

  server.registerTool("kleo_generate_thumbnail", {
    title: "Generate thumbnails (coming soon)",
    description: "Not available yet in this beta: every finished video already comes with a thumbnail (see kleo_get_result). Calling this only records the request and returns a notice; do not promise extra thumbnails to the user.",
    inputSchema: z.object({
      job_id: z.string().optional().describe("A finished video to take frames from."),
      prompt: z.string().max(500).optional().describe("Or describe the thumbnail you want."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ job_id, prompt }) => guarded(async () => {
    if (!job_id && !prompt) throw new JobError("Tell me which video (its number) or describe the thumbnail you want.");
    await audit(env, user.id, job_id ?? null, "thumbnail.requested", { prompt });
    throw new JobError("Extra thumbnails are not available yet in this beta. Every finished video already comes with one thumbnail: call kleo_get_result to get its link.");
  }));

  server.registerTool("kleo_cancel_job", {
    title: "Cancel a video",
    description: "Cancels a video that is waiting or rendering. The credits are given back in full if it had not started, otherwise in proportion to the work left. A finished, failed or already cancelled video cannot be cancelled.",
    inputSchema: z.object({ job_id: z.string().describe("The video number returned by kleo_create_video.") }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ job_id }) => guarded(async () => {
    const fresh = (await getUser(env, user.id)) ?? user;
    const existing = await getUserJob(env, user.id, job_id);
    if (!existing) throw noSuchVideo(job_id);
    const what = kindOf(jobView(existing).format);
    const Cap = what[0].toUpperCase() + what.slice(1);
    if (existing.state === "done") throw new JobError(`${Cap} ${existing.id} is already finished, so there is nothing to cancel. Call kleo_get_result for the download links.`);
    if (existing.state === "cancelled") throw new JobError(`${Cap} ${existing.id} was already cancelled.`);
    if (existing.state === "failed") throw new JobError(`${Cap} ${existing.id} had already failed and its credits were given back; there is nothing to cancel.`);
    const { job, refunded } = await cancelJob(env, fresh, job_id);
    const back = refunded > 0 ? `${plural(refunded, "credit")} given back.` : "No credits given back, because the render was almost finished.";
    return ok({ job_id: job.id, state: "cancelled", refunded, credits_left: fresh.credits + refunded }, `${Cap} ${job.id} was cancelled. ${back} You now have ${plural(fresh.credits + refunded, "credit")}.`);
  }));

  return server;
}

export const FILE_KINDS = FILE_NAMES;

/** Builds a per-request stateless MCP handler bound to the authenticated user. */
export function mcpHandlerFor(env: Env, user: User, base: string) {
  return createMcpHandler(() => buildServer(env, user, base), { legacy: "stateless" });
}
