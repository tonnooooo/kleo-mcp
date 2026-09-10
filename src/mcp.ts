import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "./env";
import type { User, Job } from "./db";
import { getUserJob, getUser, recentJobsForUser, countOpenForUser, GPU_ONLY_WAIT } from "./db";
import { TEMPLATES, TEMPLATE_IDS, findTemplate, creditsFor } from "./templates";
import { createJob, cancelJob, jobView, resultLinks, JobError, FILE_NAMES } from "./jobs";
import { audit } from "./db";
import { STYLES, KINDS, BEAT_KINDS, BEAT_ICONS, BEAT_FX, CINEMA_ACCENTS, STORY_ACTS, STORY_CAST, STORY_PROPS, STORY_FX, VISUALS, VOICES, KLEO_STYLES, IMAGE_PROMPT_MAX, SHOT_CAPTION_MAX, SHOT_HL_MAX, SHOT_AT_MAX, CLOSING_BUTTON_MAX, MAX_PICTURES, SHOTS_PER_SCENE } from "./keou-contract";
import { SHOT_KINDS } from "./shot-grammar";
import { int } from "./util";

/**
 * Languages a job can be created in. The engine ships more Kokoro voices (keou-contract VOICES still knows fr),
 * but kleo_create_video only accepts these and the validator demands storyboard.language === job language: the
 * guide must never offer a language this tool cannot take, or the model writes a storyboard that is rejected.
 */
const JOB_LANGUAGES = ["en", "it"] as const;
/** "1-4" / "1-2": the shot count the validator enforces, so the guide can never drift from SHOTS_PER_SCENE. */
const shotRange = (kind: "cinema" | "closing") => SHOTS_PER_SCENE[kind].join("-");

const INSTRUCTIONS = `This server is Kleo (the kleo_* tools): the video studio the user connected. It is not kie-mcp or any other product. Kleo renders YouTube videos and Shorts (4K, 60 fps) from a template and a prompt. When the user mentions Kleo, a video, a Short or a YouTube clip, use these tools; never answer from memory.
DELIVERY RULE: the user expects the finished video in this same conversation, without coming back later. After kleo_create_video, call kleo_wait_for_video repeatedly (each call waits up to 50 seconds and returns progress) until it returns the download links, then hand them over. Tell the user once that the render is running and the estimated time; do not ask "shall I keep waiting?"; keep calling until done unless the user says stop.
Order of calls: 1) kleo_list_templates if the user has not named a template (Shorts → viral-short unless the content is clearly a Reddit story, a quote or a list of facts). 2) kleo_storyboard_guide once per conversation, then write an original storyboard for this conversation (hook, scenes, narration, visuals, and for the cartoon/realistic styles the "shots": ${shotRange("cinema")} pictures per scene, each described in one sentence) and pass it as the "storyboard" argument of kleo_create_video; if you skip it, Kleo plans a more generic storyboard from the prompt. Every video has a visual style (cartoon, realistic, cyber or stickman): pass "style" when the user has a preference, otherwise Kleo picks one from the topic. 3) kleo_create_video: it returns at once with a video number (job_id) and an estimate in minutes. 4) kleo_get_job when the user asks how it is going. 5) kleo_get_result for the download links once it is done.
Rendering runs on a GPU in the background: a Short usually takes about 15–25 minutes (the rented machine downloads the renderer first), long videos longer. The estimate to quote is the eta_min the server returns, never your own guess; never block or loop waiting. Never invent progress, files or links: only repeat what these tools return. Call the video by its number (for example "video gt_ab12cd34"), not "job".`;

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
/**
 * A cartoon / realistic job draws every picture on a GPU, so the free GitHub Actions pool never claims it
 * (POOL_SKIP in db.ts). When no GPU can be rented the orchestrator leaves GPU_ONLY_WAIT on `error`, the one field a
 * queued job shows, so the job can say why it is not moving; reserveJob clears it the moment a GPU is reserved.
 */
// GPU_ONLY_WAIT is the PREFIX of the recorded error (the orchestrator appends the last real failure after it),
// so this has to be startsWith: an equality test silently never matches and the explanation never reaches the user.
const gpuOnlyWait = (job: Job) => job.state === "queued" && typeof job.error === "string" && job.error.startsWith(GPU_ONLY_WAIT);
/** The one explanation both kleo_get_job and kleo_wait_for_video give for a stranded picture job. */
const gpuWaitText = (what: string) =>
  `This style draws its own pictures, and pictures can only be drawn on a GPU, so the free renderers cannot take this one. No GPU is free right now, so your ${what} is simply waiting its turn: it starts on its own as soon as one comes free, and the wait costs nothing extra. If you would rather not wait, kleo_cancel_job gives the credits back.`;
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
    description: "Step 2 (recommended). Returns the storyboard format Kleo renders (visual styles: cartoon, realistic, cyber, stickman; scene kinds, the picture shots of the cartoon/realistic looks, beats and icons for cyber, voices, limits, rules) with full examples, so you can write an original storyboard tailored to the user and pass it to kleo_create_video. Call it once per conversation, before kleo_create_video. Without a storyboard Kleo plans a more generic one from the prompt.",
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
  "style": one of ${JSON.stringify(STYLES)}, "format": "9:16" | "16:9", "language": ${JOB_LANGUAGES.map((l) => `"${l}"`).join(" | ")},
  "voice": ${JOB_LANGUAGES.map((l) => `${l}: ${(VOICES[l] ?? []).join("|")}`).join(" · ")}, "speed": 0.8-1.3 (use 1.1), "music": "bed" | "none",
  "max_duration": ${Math.round(dur * 1.6)}, "description": "<=180", "tags": ["..."], "scenes": [...] }
"format" and "language" are NOT free choices: they must equal the "format" and "language" you pass to kleo_create_video (the validator rejects a storyboard that disagrees), and "voice" must be one of that language's voices above. A job is ${JOB_LANGUAGES.join(" or ")} only: never write a storyboard in any other language.

KLEO STYLES ("kleo_style", always set it; it must match the Keou "style"):
 "cartoon": the story told in flat vector illustrations generated from your descriptions (pirates → beaches, sand, ships; space → rockets, stations), full screen, cut on the narration. Stories, kids, travel, animals, history, fun facts. Needs style "picture" (9:16 or 16:9).
 "realistic": the same shape with cinematic photo-look pictures. Products, places, news, sport, documentaries. Needs style "picture".
 "cyber": the plain Keou motion-design look (dark background, glowing icons, big type), no pictures. Tech, security, AI, code. Works with any Keou style except "picture" and "stickman".
 "stickman": a hand-drawn stickman acting the story (Keou style "stickman", scenes of kind "story", 9:16 only). Only when the user asks for it.
KEOU STYLES: "picture" (cartoon/realistic: nothing but full-screen pictures cut on the narration, like a short documentary; no icons, no beats), "cinema" (cyber, portrait-first: each scene has 1-8 beats = hero visuals cut on the narration), "stickman" (9:16 only, scenes of kind "story"), "editorial" / "illustrated" / "technical" / "terminal" (landscape-friendly, one composition per scene: hero, list, compare, steps, metric, quote, closing; cyber only).

PICTURE SCENE (cartoon and realistic; the whole video is these pictures: no beats, no icons, no cards):
{ "id": "01-hook", "kind": "cinema", "chapter": "01 THE CAPTAIN <=32", "accent": ${JSON.stringify(CINEMA_ACCENTS)}, "title": "<=90, the line shown on the first picture", "hl": "<=24, one word of the title", "voice": "1-3 sentences <=350 chars", "hold": 0.15-3, "shots": [${shotRange("cinema")} pictures, 2-3 is the usual rhythm; a closing scene takes ${shotRange("closing")}, normally 1] }
 SHOT: {"image_prompt":"<=${IMAGE_PROMPT_MAX} chars, ONE sentence describing the picture","caption":"2-5 BIG WORDS <=${SHOT_CAPTION_MAX}","hl":"ONE WORD OF caption <=${SHOT_HL_MAX}","at":"<=${SHOT_AT_MAX} chars, an unbroken run of whole words copied from this scene's voice (see below)","shot_kind":${JSON.stringify(SHOT_KINDS)}} — only "image_prompt" is required, and a shot carries no other key.
 - image_prompt: concrete subject, place, action, light and mood; the SAME characters described the same way in every shot (hair, clothes, colours); consecutive shots of one scene show the next moment or a new angle of the same place. NO text, letters, numbers, logos or captions inside the picture, and no real people.
 - the first shot opens the scene and must NOT carry "at"; every other shot cuts when its "at" words are spoken, so place the anchors along the line in reading order. An "at" must be an unbroken piece of that scene's "voice", copied character for character (punctuation included) AND landing on whole words: from "only one cabin boy swam back to shore" take "swam back" — never a fragment ("wam bac"), never a paraphrase ("he swam"), and never a jump across punctuation ("1720 Captain" when the line reads "In 1720, Captain Mara"). Case does not matter.
 - "caption" is optional and rare: 2-5 strong words on the shot that carries the idea (the first shot falls back to the scene title).
 SHOT KINDS ("shot_kind"): you say what the shot is FOR, Kleo picks the camera move from it. NEVER write a camera move, a zoom, a pan or a direction anywhere in a storyboard - naming the move by hand is refused.
  hook = the opening jolt, the first shot of the video · establish = where we are · face = one face or one animal carrying the feeling · detail = one object, close · detail_orbit = one object worth circling · action = something moving through the frame · reveal = the frame opens on the answer the line just gave · tension = the moment before it goes wrong · closing = the last picture of the video
  static_forced = the picture must NOT move. Use it whenever the shot shows visible hands doing something, a crowd, readable signs or writing, a mechanism with moving parts, or two people interacting: those four break under any camera move, so Kleo forces this kind when it recognises them - and it refuses two such pictures in a row, so give the next shot a different subject.
  Leave "shot_kind" out and Kleo picks one. Two shots in a row never get the same sort of move, and the loud kinds (hook, tension, detail_orbit) stay rare and never touch, so do not put "hook" or "tension" on every shot.
 - the closing scene: kind "closing" (the last scene always is), ${shotRange("closing")} shots — one is the norm — and "button" (<=${CLOSING_BUTTON_MAX}, default "Subscribe") OR a "detail" line (<=110), never both.
 Kleo draws a picture for every shot you write, so keep the total sensible for the length (about ${MAX_PICTURES(dur)} for a video of this length): never set scene.image or shot.image, and never write "image_prompt" on the scene itself. Each picture is named "<scene id>-s<shot number>", so a scene id must not itself end in "-s" and a number.

CINEMA SCENE (cyber only): { "id": "01-hook", "kind": "cinema", "chapter": "01 HOOK <=32", "accent": ${JSON.stringify(CINEMA_ACCENTS)}, "title": "<=90", "hl": "<=24 word highlighted", "voice": "1-3 sentences <=350 chars", "beats": [ ... 1-8 ... ], "hold": 0.15-3 }
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
  No scene ever carries "motion" (nor "image", "image_credit" or any other motion_* field): the engine's motion backgrounds cannot be requested from a storyboard, and kind "image" is not allowed either.

RULES THE VALIDATOR ENFORCES: 2-240 scenes; unique slug ids [a-z0-9-] that must not end with "-s" + a number (reserved for pictures); last scene kind "closing"; every scene needs "title" and "voice"; picture style: only cinema/closing scenes, ${shotRange("cinema")} shots each (closing ${shotRange("closing")}), "beats" forbidden, image_prompt 2-${IMAGE_PROMPT_MAX} chars on every shot; cinema style only cinema/closing scenes; stickman only story/closing and 9:16; kleo_style cartoon/realistic need style "picture", kleo_style stickman needs style "stickman"; scene.image, scene.motion (and motion_*) and shot.image forbidden; "at" (beat or shot) must be an unbroken run of that scene's voice, copied verbatim (case-insensitive, punctuation included) and landing on whole words, and never sits on the first shot; a shot carries only image_prompt, caption, hl, at and shot_kind (a hand-written camera move is refused); format and language must equal the job's; voice legal for that language; total narration must fit max_duration (never exceed ~${Math.round(words * 1.25)} words for ${dur}s).

CREATIVE DIRECTION: open with a hook in the first sentence; vary accents per scene; alternate beat kinds (type → icon → steps → dialog...); one idea per scene; end with a clear closing (question, promise or CTA). In the picture style, give each scene ${shotRange("cinema")} shots (2-3 is the usual rhythm): each shot is the next moment or a new angle, with the same characters throughout. Do not copy the examples; adapt tone and vocabulary to the user's topic and audience.

EXAMPLE A (cartoon picture Short, 9:16, 40s, en):
{"schema_version":1,"editorial_status":"ready","title":"The Treasure Nobody Ever Came Back For","brand":"Kleo","kleo_style":"cartoon","style":"picture","format":"9:16","language":"en","voice":"am_michael","speed":1.1,"music":"bed","max_duration":64,"scenes":[
 {"id":"01-hook","kind":"cinema","chapter":"01 THE CAPTAIN","accent":"red","title":"she never came back","hl":"never","voice":"In 1720, Captain Mara buried her treasure on Skull Beach. She never came back for it.","hold":0.2,"shots":[
  {"image_prompt":"A pirate captain with a red bandana and a long dark braid burying a wooden chest on a golden beach at sunset, palm trees, her red-sailed ship anchored in the bay","caption":"SHE NEVER CAME BACK","hl":"NEVER","shot_kind":"hook"},
  {"image_prompt":"The same pirate captain in her red bandana walking away along the shoreline at dusk, deep footprints in the wet sand, the beach empty behind her","at":"never came back","shot_kind":"action"}]},
 {"id":"02-storm","kind":"cinema","chapter":"02 THE STORM","accent":"amber","title":"three days later","hl":"three","voice":"Three days later a storm took her ship, and only one cabin boy swam back to shore.","hold":0.2,"shots":[
  {"image_prompt":"The red-sailed pirate ship tossed by huge black waves at night, lightning splitting the sky, torn sails, rain across the deck","caption":"THREE DAYS LATER","hl":"THREE","shot_kind":"tension"},
  {"image_prompt":"A young cabin boy in a striped shirt clinging to a broken plank in the dark water, the ship going down behind him","at":"one cabin boy","shot_kind":"establish"},
  {"image_prompt":"The same cabin boy lying exhausted on an empty beach at dawn, calm turquoise water, palm trees, soft pink sky","at":"swam back","shot_kind":"face"}]},
 {"id":"03-map","kind":"cinema","chapter":"03 THE MAP","accent":"green","title":"the same beach","hl":"same","voice":"He drew the map a hundred times, and every single copy pointed to the same beach.","hold":0.2,"shots":[
  {"image_prompt":"An old sailor with a white beard leaning over a worn treasure map spread on a table in a lantern-lit ship cabin, a green parrot perched beside him","caption":"A HUNDRED COPIES","hl":"HUNDRED","shot_kind":"establish"},
  {"image_prompt":"Close view of the worn map in warm candlelight, a black cross inked on a curved beach with three palm trees","at":"the same beach","shot_kind":"static_forced"}]},
 {"id":"04-closing","kind":"closing","chapter":"04 SKULL BEACH","accent":"cyan","title":"Is the gold still there?","hl":"still","voice":"So is the gold still there? Follow, and next time we dig up Skull Beach.","button":"Follow","hold":0.4,"shots":[
  {"image_prompt":"A half-buried wooden chest spilling gold coins into golden sand at dawn, a shovel stuck in the sand beside it, palm trees, calm sea","shot_kind":"closing"}]}]}

EXAMPLE B (realistic picture Short, 9:16, 40s, en):
{"schema_version":1,"editorial_status":"ready","title":"The Last Night Train Across the Alps","brand":"Kleo","kleo_style":"realistic","style":"picture","format":"9:16","language":"en","voice":"bf_emma","speed":1.1,"music":"bed","max_duration":64,"scenes":[
 {"id":"01-platform","kind":"cinema","chapter":"01 THE PLATFORM","accent":"cyan","title":"nobody was waiting","hl":"nobody","voice":"At ten past midnight the platform was empty, and the night train was already boarding.","hold":0.2,"shots":[
  {"image_prompt":"An empty station platform at midnight, wet concrete reflecting cold blue lamps, a long sleeper train waiting with its windows lit","caption":"TEN PAST MIDNIGHT","hl":"MIDNIGHT","shot_kind":"hook"},
  {"image_prompt":"A conductor in a dark uniform walking along the platform beside the lit sleeper train, warm yellow light from the windows, cold breath in the air","at":"already boarding","shot_kind":"action"}]},
 {"id":"02-cabin","kind":"cinema","chapter":"02 THE CABIN","accent":"amber","title":"two metres of Europe","hl":"metres","voice":"A sleeper cabin is two metres of Europe: a narrow bed, a folding sink, and a window that never stops moving.","hold":0.2,"shots":[
  {"image_prompt":"A narrow sleeper cabin at night, a made bed under a warm reading lamp, a small folding metal sink, shallow depth of field","shot_kind":"establish"},
  {"image_prompt":"The view through the same cabin window at night, dark mountains and scattered village lights streaking past the cold glass","at":"never stops moving","shot_kind":"detail"}]},
 {"id":"03-closing","kind":"closing","chapter":"03 SUNRISE","accent":"green","title":"You wake up in the mountains","hl":"mountains","voice":"You fall asleep in a city and wake up in the mountains. Follow for part two.","button":"Follow","hold":0.4,"shots":[
  {"image_prompt":"Sunrise over snowy alpine peaks seen from a moving train window, warm gold light on the rock, soft mist filling the valley below","shot_kind":"closing"}]}]}

EXAMPLE C (editorial long-form scene, 16:9, en, cyber):
{"id":"04-why-it-matters","kind":"steps","eyebrow":"WHY IT MATTERS","title":"Three things the map got wrong","detail":"Latitude, currents, and pride.","items":["Latitude was guessed","Currents were ignored","Nobody admitted it"],"visual":"network","voice":"The map got three things wrong. Latitude was guessed. Currents were ignored. And nobody wanted to admit it.","hold":0.8}
`;
    return ok({ guide: text, template: t?.id ?? null, duration_s: dur, words_target: words, credits: creditsFor(dur), styles: [...KLEO_STYLES] }, text);
  });

  server.registerTool("kleo_create_video", {
    title: "Create a video",
    description: "Step 3. Starts rendering a video or Short from a template, a prompt and a visual style (cartoon or realistic pictures, cyber or stickman; plus your storyboard from kleo_storyboard_guide, if you wrote one). Returns at once with the video number (job_id), the estimated minutes (eta_min) and the credits used; the render runs on a GPU in the background. Tell the user the number and the estimate, then offer to check progress with kleo_get_job. If the tool returns an error, nothing was charged: fix what it says and call again.",
    inputSchema: z.object({
      template: z.string().optional().describe(`Required. Template id from kleo_list_templates: ${TEMPLATE_IDS.join(", ")}.`),
      prompt: z.string().describe("What the video is about, in the user's words (8 to 4000 characters): topic, angle, facts, names, tone, anything that must appear on screen."),
      duration_s: z.number().optional().describe("Target length in seconds. Defaults to the template default and must stay inside the template's range."),
      format: z.enum(["16:9", "9:16"]).optional().describe("16:9 for YouTube videos, 9:16 for Shorts. Defaults to the template's first format."),
      language: z.enum(JOB_LANGUAGES).default("en").describe("Voice and caption language. A storyboard you pass must declare this same language."),
      voice: z.string().optional().describe("Voice id from kleo_list_templates (narrator-en-m, narrator-en-f, narrator-it-m, narrator-it-f). The engine ids used inside a storyboard (am_michael, af_heart, bf_emma, im_nicola, if_sara) are accepted too. Optional."),
      style: z.enum(KLEO_STYLES).optional().describe("What the viewer sees. cartoon: illustrated full-screen shots drawn for the topic and cut on the narration — pirates get beaches and ships, space gets rockets and stations (stories, kids, travel, animals, history). realistic: the same, with cinematic photo shots (products, places, news, sport). cyber: the dark motion-design look with glowing icons and big type, no pictures (tech, security, AI, code). stickman: a hand-drawn stickman acting the story, 9:16 Shorts only. Omit it and Kleo picks one from the topic (never stickman)."),
      notify_email: z.string().email().optional().describe("Optional: email the download links when the render finishes."),
      storyboard: z.looseObject({}).optional().describe("Optional but recommended: the storyboard you wrote following kleo_storyboard_guide (a Keou project object without id, script_file, music_quiet or image scenes). Its format and language must equal the ones you pass here, and its voice must belong to that language. When omitted, Kleo plans one from the prompt. Checked before anything is charged; on error the tool lists the problems so you can fix them and call again."),
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
    const summary = `Your ${what} is in the queue. Video number: ${job.id}. Template: ${t.name}, ${view.format}, ${view.duration_s} seconds.${styleNote} It should be ready in ${eta}. ${plural(job.credits, "credit")} used, ${plural(fresh.credits - job.credits, "credit")} left. NEXT STEP, do it now: call kleo_wait_for_video with job_id "${job.id}", and when it answers that the video is still rendering call it again, and again, until it answers that the video is ready. Do not end your turn and do not ask the user anything in between: they are waiting for the finished video in this conversation.${sim}`;
    return ok({ ...view, credits_left: fresh.credits - job.credits, mode: simulated ? "simulated" : "gpu", message: summary }, summary);
  }));

  const statusLine = (job: Job): string => {
    const view = jobView(job);
    const what = kindOf(view.format);
    switch (job.state) {
      case "done": return `Your ${what} ${job.id} is ready. Call kleo_get_result for the download links.`;
      case "failed": return `Sorry, ${what} ${job.id} could not be rendered. Your ${plural(job.credits, "credit")} ${job.credits === 1 ? "was" : "were"} given back. Please try again; if it happens again, tell the Kleo team.${job.error ? ` (Technical detail: ${job.error})` : ""}`;
      case "cancelled": return `${what[0].toUpperCase() + what.slice(1)} ${job.id} was cancelled.`;
      case "queued": {
        const takes = `Once it starts it takes ${simulated ? "about a minute" : `about ${plural(job.eta_min ?? 0, "minute")}`}.`;
        return gpuOnlyWait(job)
          ? `Your ${what} ${job.id} is in the queue and has not started yet. ${gpuWaitText(what)} ${takes}`
          : `Your ${what} ${job.id} is in the queue, waiting for a free GPU. ${takes}`;
      }
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
          : j.state === "queued" ? (gpuOnlyWait(j) ? "waiting for a free GPU (this style draws its pictures on one)" : "waiting in the queue")
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
          await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken, progress: tickN, message: job.state === "queued" ? (gpuOnlyWait(job) ? "waiting for a GPU (this style draws its pictures on one)" : "waiting for a renderer") : `${job.percent}% · ${trackLabel(job.track)}` } });
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
    const again = "Call kleo_wait_for_video again now to keep waiting; the links will come back from that call as soon as it is ready.";
    if (gpuOnlyWait(job))
      return ok({ ...jobView(job), next: "call kleo_wait_for_video again" }, `Still waiting: ${what} ${job.id} has not started yet. ${gpuWaitText(what)} ${again}`);
    const eta = job.eta_min ? ` About ${plural(job.eta_min, "minute")} to go.` : "";
    const where = job.state === "queued" ? "waiting for a renderer" : `${job.percent}% done (${trackLabel(job.track)})`;
    return ok({ ...jobView(job), next: "call kleo_wait_for_video again" }, `Still rendering: ${what} ${job.id} is ${where}.${eta} ${again}`);
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
    if (job.state !== "done") throw new JobError(`Your ${what} ${job.id} is not ready yet: ${job.state === "queued" ? (gpuOnlyWait(job) ? "it is waiting for a free GPU, because this style draws every picture on one. Nothing extra is charged while it waits" : "it is waiting in the queue") : `${job.percent}% done (${trackLabel(job.track)})`}. Check again later with kleo_get_job.`);
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
