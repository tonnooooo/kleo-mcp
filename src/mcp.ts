import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "./env";
import type { User, Job, JobParams } from "./db";
import { getUserJob, getUser, recentJobsForUser, countOpenForUser, countAuditTodayForUser, GPU_ONLY_WAIT } from "./db";
import { isFlagActive } from "./schema";
import { writeTreatment } from "./storyboard.ts";
import { treatmentText } from "./treatment.ts";
import { ACTIVE_TEMPLATE, PUBLIC_TEMPLATES as TEMPLATES, PUBLIC_TEMPLATE_IDS as ACTIVE_TEMPLATE_IDS, findTemplate, creditsFor } from "./templates";
import { createJob, cancelJob, jobView, resultLinks, JobError, FILE_NAMES } from "./jobs";
import { accountUrl, makeHandle } from "./accounts";
import { audit } from "./db";
import { FORMATS, wordBudget, shotRangeText } from "./keou-contract";
import { guideText } from "./guide.ts";
import { int } from "./util";
import { adaptPrompt, adaptivePromptText } from "./adaptive.ts";

/**
 * Languages a job can be created in. The engine ships more Kokoro voices (keou-contract VOICES still knows fr),
 * but kleo_create_video only accepts these and the validator demands storyboard.language === job language: the
 * guide must never offer a language this tool cannot take, or the model writes a storyboard that is rejected.
 */
const JOB_LANGUAGES = ["en", "it"] as const;
/** "2-4" / "1-2": the shot count Kleo really enforces, from the contract, so no two texts can quote different numbers. */
const shotRange = shotRangeText;

const INSTRUCTIONS = `This server is Kleo (the kleo_* tools): the video studio the user connected. Kleo makes one kind of video: a realistic film — every shot generated as moving footage, one narrator, no music, no captions, no on-screen text — 4K 60 fps, 16:9 for YouTube or 9:16 for a Short, 15 seconds to 5 minutes. When the user mentions Kleo, a video, a film, a Short or a YouTube clip, use these tools; never answer from memory.
ORDER OF CALLS: 1) If the user has not said what the video is about, ask them and wait; never pick a subject for them. Infer 16:9 unless they ask for a Short or a vertical video. 2) kleo_adapt_prompt with their request: it returns the TREATMENT of the film Kleo will make (logline, angle, opening image, acts, ending, look, pacing, narrator) and the decisions it took that the user did not ask for. Tell the user the logline and those decisions in one or two sentences; if they want changes, edit the treatment's fields. If it asks for the length or the subject, ask the user and call it again. 3) kleo_create_video with the prompt, the length, the format and the treatment object. 4) kleo_wait_for_video again and again until it returns the links, then hand them over.
DELIVERY RULE: the user expects the finished video in this same conversation. After kleo_create_video, call kleo_wait_for_video repeatedly (each call waits up to about a minute and returns progress) until it returns the MP4 and thumbnail links. Tell the user once that the render is running and the estimated minutes — the eta_min the server returns, never your own guess — and do not ask "shall I keep waiting?". Never invent progress, files or links: only repeat what these tools return. Call the video by its number (for example "video gt_ab12cd34"), not "job".`;

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
  const label: Record<string, string> = { video_url: "Video (MP4)", thumbnail_url: "Thumbnail" };
  const order = ["video_url", "thumbnail_url"];
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

  server.registerTool("kleo_adapt_prompt", {
    title: "Adapt a video request into the film's treatment",
    description: "Step 1 (recommended). Turns the user's request into the TREATMENT of the film: Kleo's producer reads the request, keeps every fact in it, and decides the angle, the opening image, the acts with their seconds, the ending, the visual language, the pacing, the narrator's register and the recurring motifs — and lists every decision it took that the user did not ask for. Two identical requests get two different treatments on purpose. It reads language, length and format off the request first and asks only for what is missing (the subject, the length) before spending anything. Nothing is charged and no GPU is rented; it spends a little of Kleo's daily planning quota, so call it once per video. Then tell the user the logline and the decisions, and pass the returned \"treatment\" object — unchanged, or edited as the user asked — to kleo_create_video. Without it Kleo writes a treatment itself while planning, and the user never sees it first.",
    inputSchema: z.object({
      prompt: z.string().min(1).max(4000).describe("The user's request in their own words."),
      duration_s: z.number().int().min(15).max(300).optional().describe("Length in seconds, when the user said one or agreed one with you. Read off the request when omitted; asked for when it is nowhere."),
      format: z.enum(FORMATS).optional().describe("16:9 for YouTube/film, 9:16 for vertical Shorts. Read off the request when omitted (16:9 unless it says Short, vertical, TikTok or Reel)."),
      language: z.enum(JOB_LANGUAGES).optional().describe("Language of the narration; detected from the request when omitted."),
      audience: z.string().max(160).optional(),
      tone: z.string().max(160).optional(),
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ prompt, duration_s, format, language, audience, tone }) => guarded(async () => {
    const brief = adaptPrompt(prompt, { duration_s, format, audience, tone });
    const base = { workflow: ACTIVE_TEMPLATE.id, style: "realistic", brief };
    // Missing subject or length: ask, spend nothing. The questions are the tool's answer.
    if (brief.questions.length || brief.duration_s === null) return ok({ ...base, treatment: null, ready_to_render: false }, adaptivePromptText(brief));
    const t = ACTIVE_TEMPLATE;
    if (brief.duration_s < t.minSeconds || brief.duration_s > t.maxSeconds)
      throw new JobError(`Kleo makes films of ${t.minSeconds} to ${t.maxSeconds} seconds; ${brief.duration_s} seconds is outside that range. Agree a length in range with the user and call again. Nothing was charged.`);
    const lang = language ?? brief.language;
    // Each treatment is a model call on the free planning quota, so an account gets a day's worth and no more:
    // past it the video is still possible, and the planner writes the treatment itself when it plans.
    const cap = int(env.ADAPT_MAX_PER_DAY, 12);
    const used = await countAuditTodayForUser(env, user.id, "treatment.adapt");
    const fallback = "You can still make the video: call kleo_create_video with the prompt and Kleo writes the treatment itself while planning it.";
    if (used >= cap) throw new JobError(`This account has asked for ${plural(used, "treatment")} today, and the limit is ${cap} a day while Kleo is in beta. ${fallback} Nothing was charged.`);
    if (await isFlagActive(env, "plan_pause"))
      return ok({ ...base, treatment: null, ready_to_render: true, note: "planning quota exhausted" }, `${adaptivePromptText(brief)}\n\nKleo cannot write the treatment right now: it has used up today's free planning. ${fallback}`);
    const r = await writeTreatment(env, { prompt: prompt.trim(), duration_s: brief.duration_s, format: brief.format, language: lang });
    void audit(env, user.id, null, "treatment.adapt", { model: r.model, attempts: r.attempts, ms: r.ms, usage: r.usage, est_neurons: r.est_neurons, ok: !!r.treatment, transient: r.transient, history: r.history.slice(0, 3), variation: r.treatment?.variation ?? null });
    if (!r.treatment)
      return ok({ ...base, treatment: null, ready_to_render: true, note: r.transient ? "model unavailable" : "no valid treatment in two attempts", problems: r.history },
        `${adaptivePromptText(brief)}\n\nKleo could not write the treatment just now (${r.transient ? "its planning model did not answer" : "two attempts came back incomplete"}). ${fallback} Or call this tool once more.`);
    return ok({ ...base, treatment: r.treatment, ready_to_render: true, next: 'Show the user the logline and the decisions; then call kleo_create_video with prompt, duration_s, format, language and this same object as "treatment".' },
      `${adaptivePromptText(brief)}\n\n${treatmentText(r.treatment)}`);
  }));


  server.registerTool("kleo_list_templates", {
    title: "List active workflow",
    description: "Lists the only active workflow: Realistic Film, adaptive shot-by-shot planning, real motion clips, 16:9 or 9:16, no music and no subtitles.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const fresh = (await getUser(env, user.id)) ?? user;
    const activeTemplate = ACTIVE_TEMPLATE;
    const templates = [activeTemplate].map((t) => ({
      id: t.id, name: t.name, formats: t.formats, duration_s: { min: t.minSeconds, max: t.maxSeconds, default: t.defaultSeconds },
      credits: creditsFor(t.defaultSeconds), voices: t.voices, description: t.description,
    }));
    const lines = [activeTemplate].map((t) => {
      const shape = t.formats.map((f) => (f === "9:16" ? "Short (9:16)" : "YouTube video (16:9)")).join(" or ");
      return `- ${t.name} (id: ${t.id}): ${shape}, ${t.minSeconds}–${t.maxSeconds} seconds, ${plural(creditsFor(t.defaultSeconds), "credit")}. ${t.description}`;
    });
    return ok(
      { templates, credits_available: fresh.credits, pricing: "1 credit per Short (up to 90 seconds), 3 credits up to 5 minutes, +1 credit per extra minute", account_url: await accountUrl(env, user.id, base) },
      `Kleo has one active workflow (realistic-film). You have ${plural(fresh.credits, "credit")} left. Ask for the subject, duration and format when they are missing; then call kleo_adapt_prompt before creating the video.\n${lines.join("\n")}\nPrices: 7 credits per film up to 90 seconds; longer films scale with the duration.`,
    );
  });


  server.registerTool("kleo_storyboard_guide", {
    title: "Storyboard guide (write your own video)",
    description: "Step 2 (recommended). Returns how to write a storyboard Kleo renders, in the order it should be written: first the DIRECTION of the film (subject, goal, audience, tone, the facts from the request that the narration must still say, the world it is drawn in, what must never appear, and one accent colour per section), then the scene and shot shapes, the limits Kleo enforces before anything is billed, and one worked example. Kleo has one look: a realistic film, every shot generated as moving footage from its own frame. Call it once per conversation, before kleo_create_video. Without a storyboard Kleo plans a more generic one from the prompt.",
    inputSchema: z.object({
      template: z.literal(ACTIVE_TEMPLATE.id).optional().describe("Optional: Kleo uses the only active workflow, film."),
      duration_s: z.number().int().min(15).max(900).optional().describe("Target length in seconds, if the user chose one."),
      style: z.enum(["realistic"]).optional().describe("Kleo has one look: realistic — a film whose every shot is generated footage from its own frame, under the narration. Omit it or pass \"realistic\"."),
      format: z.enum(FORMATS).optional().describe("The frame the video will be in. The explainer authors its drawings in the frame's own pixels, so its guide prints different coordinates for 9:16 and 16:9; the template's own format is used when this is omitted."),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ template, duration_s, style, format }) => {
    const t = template === ACTIVE_TEMPLATE.id ? ACTIVE_TEMPLATE : null;
    const dur = duration_s ?? t?.defaultSeconds ?? 45;
    // The explainer writes coordinates, so the guide has to know the frame before it prints them: a storyboard
    // authored against 1080x1920 and rendered at 1920x1080 puts every drawing off the page.
    const fmt = format ?? t?.formats[0] ?? "9:16";
    const words = wordBudget(dur, 1.1).target;
    // The guide is built in src/guide.ts from the contract\u2019s own constants, so the numbers it prints are the numbers
    // the validator enforces \u2014 the shot range used to be 1-4 here, 2-4 in the planner and "two to four" on the website.
    const text = guideText({ template: ACTIVE_TEMPLATE.id, templateName: ACTIVE_TEMPLATE.name, duration_s: dur, style: "realistic", languages: JOB_LANGUAGES, format: fmt });
    // The guide is where an assistant is most likely to start inventing: it has just been handed the shape of a
    // storyboard and nothing to put in it. So the sentence that leaves with it is the one that says whose idea it
    // has to be — a model follows the last instruction it read far more reliably than a tool description.
    const askFirst = "\n\nBEFORE YOU WRITE THIS: the subject has to come from the user, not from you. If they have not "
      + "said what the video is about, ask them now and wait for the answer. If they gave you a subject, however short, "
      + "that is enough — write the storyboard and do not interrogate them.";
      return ok({ guide: text, template: t?.id ?? ACTIVE_TEMPLATE.id, duration_s: dur, format: fmt, words_target: words, credits: creditsFor(dur, "realistic"), styles: ["realistic"], style: "realistic" }, text + askFirst);
  });

  server.registerTool("kleo_create_video", {
    title: "Create a video",
    description: "Step 3. ASK FIRST, THEN CALL. Do not call this until the user has said, in their own words, what the video should be about. If the subject is YOUR idea and not theirs — you suggested a topic, or you filled a vague request in with your own guess — stop and ask them, and wait for the answer. A render spends a credit they cannot get back once it starts and takes about twenty minutes, so a video nobody asked for is not a fast answer, it is a wasted one. When their request is short but clear (\"a Short about pirates\"), that is enough: do not interrogate them. When it is missing the subject entirely, ask for the subject and nothing else. Starts rendering a realistic film — every shot generated as moving footage from its own frame, narrated, no captions, no music, 4K 60 fps — from a prompt, a length and a format (plus your storyboard from kleo_storyboard_guide, if you wrote one). It costs 7 credits up to 90 seconds and takes 25-35 minutes on a rented GPU. Returns at once with the video number (job_id), the estimated minutes (eta_min) and the credits used; the render runs on a GPU in the background. Tell the user the number and the estimate, then offer to check progress with kleo_get_job. If the tool returns an error, nothing was charged: fix what it says and call again.",
    inputSchema: z.object({
      template: z.string().optional().describe(`Optional; the only one is "film" (a realistic film, 16:9 for YouTube or 9:16 for Shorts, 15 to 300 seconds). Omit it.`),
      prompt: z.string().describe("What the video is about, IN THE USER'S OWN WORDS (8 to 4000 characters): topic, angle, facts, names, tone, anything that must appear on screen. If you are about to write this field out of an idea of your own, that is the sign to ask them instead: the credit and the twenty minutes are theirs, so the subject has to be theirs too."),
      duration_s: z.number().optional().describe("Target length in seconds. Defaults to the template default and must stay inside the template's range."),
      format: z.enum(["16:9", "9:16"]).optional().describe("16:9 for YouTube videos, 9:16 for Shorts. Defaults to the template's first format."),
      language: z.enum(JOB_LANGUAGES).default("en").describe("Voice and caption language. A storyboard you pass must declare this same language."),
      voice: z.string().optional().describe("Voice id from kleo_list_templates (narrator-en-m, narrator-en-f, narrator-it-m, narrator-it-f). The engine ids used inside a storyboard (am_michael, af_heart, bf_emma, im_nicola, if_sara) are accepted too. Optional."),
      style: z.enum(["realistic"]).optional().describe("Kleo has one look: realistic — a cinematic film, every shot generated as moving footage from its own frame, narrated, no captions and no music. Omit it or pass \"realistic\"."),
      notify_email: z.string().email().optional().describe("Optional: email the download links when the render finishes."),
      treatment: z.looseObject({}).optional().describe("The treatment object kleo_adapt_prompt returned for this request, unchanged or edited as the user asked (logline, angle, device, opening, ending, acts, visual, pacing, narrator, motifs, decisions, prose, variation). Kleo plans the direction and every scene under it. Checked before anything is charged; on error the tool lists the problems. Omit it and Kleo writes a treatment itself while planning — the user just never sees it first."),
      storyboard: z.looseObject({}).optional().describe("Optional but recommended: the storyboard you wrote following kleo_storyboard_guide (a Keou project object without id, script_file, music_quiet or image scenes). IT MUST INCLUDE THE \"direction\" BLOCK the guide asks for first — a storyboard without one is refused, because the direction is what keeps a character the same person across shots and gives every scene the colour of its section. Its format and language must equal the ones you pass here, and its voice must belong to that language. When omitted entirely, Kleo plans the whole storyboard, direction included, from the prompt. Checked before anything is charged; on error the tool lists the problems so you can fix them and call again."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args) => guarded(async () => {
    if (!args.template) args.template = ACTIVE_TEMPLATE.id;
    const fresh = (await getUser(env, user.id)) ?? user;
    const t = ACTIVE_TEMPLATE;
    const duration = Math.round(args.duration_s ?? t.defaultSeconds);
    // Priced on the style the caller NAMED. When none is named, createJob picks one from the topic and debits that
    // price instead, so this figure is an early courtesy ("you cannot afford this"), never the charge itself: the
    // authoritative debit is one conditional UPDATE in createJob, and it refuses with its own accurate message.
    const cost = creditsFor(duration, "realistic");
    if (duration >= t.minSeconds && duration <= t.maxSeconds && fresh.credits < cost)
      throw new JobError(`Not enough credits: this ${kindOf(args.format ?? t.formats[0])} costs ${plural(cost, "credit")} and you have ${plural(fresh.credits, "credit")}. Nothing was charged. Your account and how to get more: ${await accountUrl(env, user.id, base)}`);
    const maxOpen = int(env.MAX_JOBS_PER_USER, 2);
    const open = await countOpenForUser(env, user.id);
    if (open >= maxOpen)
      throw new JobError(`You already have ${plural(open, "video")} in progress, and the limit is ${maxOpen} at a time. Wait for one to finish (kleo_get_job) or cancel one with kleo_cancel_job. Nothing was charged.`);
    const job = await createJob(env, fresh, { ...args, template: t.id });
    const view = jobView(job);
    const what = kindOf(view.format);
    const sim = simulated ? " SIMULATED MODE: this is a test render; it finishes in about a minute and the files are placeholders, not a real video." : "";
    const eta = simulated ? "about a minute" : `about ${plural(job.eta_min ?? 0, "minute")}`;
    // WHEN KLEO GUESSED THE LOOK, IT SAYS SO. Measured on 27 requests written by two other sessions: 13 named no
    // subject the word lists know, and the whole set scored 26%. A guess that presents itself as a decision is the
    // bug — the user sees a video in the wrong look and cannot tell why. A guess that admits it is a conversation:
    // the assistant reads this line, tells the user, and the user fixes it while the credits can still come back.
    const styleNote = " Style: realistic cinematic.";
    // A guessed look that was replaced because it costs more has to be SAID: the user would otherwise receive a
    // different video from the one Kleo understood, with nothing anywhere explaining why. Naming the style is always
    // honoured, so the way to get it is one argument, and the sentence says which one.
    const jp = JSON.parse(job.params) as JobParams;
    const cappedNote = jp.style_capped_from
      ? ` Kleo would have chosen the "${jp.style_capped_from}" look for this, but it costs ${plural(creditsFor(view.duration_s, jp.style_capped_from), "credit")} instead of ${plural(job.credits, "credit")}, and Kleo never spends the dearer ones on a guess: it used "${jp.style}". Ask again with style: "${jp.style_capped_from}" if that is the one you want.`
      : "";
    // Which film is being made has to be said: the one the user read about, or one Kleo will write on its own.
    const logline = typeof jp.treatment?.logline === "string" ? jp.treatment.logline : null;
    const treatNote = logline ? ` Planned under your treatment: "${logline}".` : " Kleo writes the film's treatment itself while planning (call kleo_adapt_prompt first next time to show it to the user before rendering).";
    const summary = `Your ${what} is in the queue. Video number: ${job.id}.${cappedNote} Template: ${t.name}, ${view.format}, ${view.duration_s} seconds.${styleNote}${treatNote} It should be ready in ${eta}. ${plural(job.credits, "credit")} used, ${plural(fresh.credits - job.credits, "credit")} left. NEXT STEP, do it now: call kleo_wait_for_video with job_id "${job.id}", and when it answers that the video is still rendering call it again, and again, until it answers that the video is ready. Do not end your turn and do not ask the user anything in between: they are waiting for the finished video in this conversation.${sim}`;
    return ok({ ...view, credits_left: fresh.credits - job.credits, mode: simulated ? "simulated" : "gpu", message: summary }, summary);
  }));

  const statusLine = (job: Job): string => {
    const view = jobView(job);
    const what = kindOf(view.format);
    switch (job.state) {
      case "done": return `Your ${what} ${job.id} is ready. Call kleo_get_result for the download links.`;
      case "failed": return `Sorry, ${what} ${job.id} could not be rendered. Your ${plural(job.credits, "credit")} ${job.credits === 1 ? "was" : "were"} given back. Please try again; if it fails a second time, try a shorter video or another template.${job.error ? ` (Technical detail: ${job.error})` : ""}`;
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
    description: "Step 5. Download links for a finished realistic film: the MP4 and thumbnail. No subtitles or music are delivered.",
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

  server.registerTool("kleo_account", {
    title: "Account and credits",
    description: "The credits left on this account, the link to its page, and the \"Kleo key\" that carries the same account (and the same credits) to another browser or another computer. Call it when the user asks how many credits they have, how to get more, or how to use Kleo somewhere else. Give them account_url as a plain link: it opens a read-only page (balance, prices, where to write) and cannot sign anybody in. Show account_key only if they ask for it, because anyone who has it can take the account over and spend its credits.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const fresh = (await getUser(env, user.id)) ?? user;
    const url = await accountUrl(env, user.id, base);
    const data = {
      credits_available: fresh.credits,
      free_tier: `${int(env.FREE_CREDITS, 2)} Shorts, no signup`,
      account_key: await makeHandle(env, user.id),
      account_url: url,
      payments_open: false,
    };
    return ok(data, `You have ${plural(fresh.credits, "credit")} (1 credit = 1 Short of up to 90 seconds). Card payments are not open yet: Kleo is free while it is in beta. Your account page, which also shows the key that carries this account to another browser: ${url}`);
  });

  return server;
}

export const FILE_KINDS = FILE_NAMES;

/** Builds a per-request stateless MCP handler bound to the authenticated user. */
export function mcpHandlerFor(env: Env, user: User, base: string) {
  return createMcpHandler(() => buildServer(env, user, base), { legacy: "stateless" });
}
