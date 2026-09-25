import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "./env";
import type { User, Job, JobParams } from "./db";
import { getUserJob, getUser, recentJobsForUser, countOpenForUser, countAuditTodayForUser, GPU_ONLY_WAIT, hasPaid, listFiles } from "./db";
import { isFlagActive } from "./schema";
import { writeTreatment, writeSpec } from "./storyboard.ts";
import { treatmentText, treatmentMethodText, variationFor } from "./treatment.ts";
import { specMethodText, specText, specOf, itemById, visualChecks, specModeWhy, MODE_RULE, REF_ROLES, type RequestSpec } from "./spec.ts";
import { resolveRefs, makeUploadToken, fetchRefBytes, refHandle, refMeta, ingestRef, RefError, REF_HANDLE_RE, UPLOAD_MAX_FILES, UPLOAD_TTL_S, type ResolvedRef, type RefInput } from "./refs.ts";
import { getFile } from "./storage";
import { ACTIVE_TEMPLATE, PUBLIC_TEMPLATES as TEMPLATES, PUBLIC_TEMPLATE_IDS as ACTIVE_TEMPLATE_IDS, findTemplate, creditsFor, creditsForProduct, filmCredits, freeCreditsFor, tariffSentence, MIN_FILM_CREDITS, SECONDS_PER_CREDIT, PRODUCTS, ANIMATIC_CREDITS, ANIMATIC_MAX_S, FILM_STYLE, productOf, aiUpscaleCredits, aiUpscaleRule, aiUpscaleOn, MODELS, modelsSentence } from "./templates";
import { PACKS, sellingAvailable } from "./stripe";
import { createJob, cancelJob, jobView, resultLinks, JobError, FILE_NAMES } from "./jobs";
import { accountUrl, makeHandle } from "./accounts";
import { audit } from "./db";
import { FORMATS, FILM_LOOKS, wordBudget, shotRangeText, pictureScenes } from "./keou-contract";
import { musicNote, clipFloorFor, footageConfig } from "./footage";
import { guideText } from "./guide.ts";
import { int, publicText } from "./util";
import { adaptPrompt, adaptivePromptText, durationFrom, lookFromText, aiUpscaleAnswer } from "./adaptive.ts";

/**
 * Languages a job can be created in. The engine ships more Kokoro voices (keou-contract VOICES still knows fr),
 * but kleo_create_video only accepts these and the validator demands storyboard.language === job language: the
 * guide must never offer a language this tool cannot take, or the model writes a storyboard that is rejected.
 */
const JOB_LANGUAGES = ["en", "it"] as const;
/** "2-4" / "1-2": the shot count Kleo really enforces, from the contract, so no two texts can quote different numbers. */
const shotRange = shotRangeText;

const INSTRUCTIONS = `This server is Kleo (the kleo_* tools): the video studio the user connected. Kleo makes narrated videos in one of two looks, realistic (cinematic live action) or animation (a 2D animated film) — one narrator; MUSIC (an instrumental track under the voice) and burned-in SUBTITLES are options the user is ALWAYS asked about and gets only when they say yes; no other on-screen text; one clean dissolve between acts per 25 seconds — 4K 60 fps, 16:9 for YouTube or 9:16 for a Short, as TWO PRODUCTS from the same treatment and storyboard: the FILM (every shot a generated clip, 15 seconds to 5 minutes, priced by length, made only for accounts that have bought a credit pack, because Kleo pays for every second of clip) and the ANIMATIC (the same drawn frames with the camera moving over each one, the same narrator and layer, no generated clip; ${ANIMATIC_CREDITS} credits flat, 15 to ${ANIMATIC_MAX_S} seconds, open to every account — the free credits pay for one). kleo_adapt_prompt asks the user which of the two they want, quoting the prices for their account (an account that has not bought a pack is offered the animatic in so many words): pass their answer as product — never call an animatic a film, never make one without saying which it is. When the user mentions Kleo, a video, a film, a Short or a YouTube clip, use these tools; never answer from memory.
ORDER OF CALLS: 1) kleo_adapt_prompt with the user's request, FIRST, before anything else: it reads the request against Kleo's intake — subject, length, format, look, product (film or animatic, with the prices the intake quotes), for a film the optional AI UPSCALE (Real-ESRGAN + RIFE, a sharper picture for many extra credits; the default is the classic 4K 60 fps, and the credits come back if the finish cannot apply it), music, subtitles and the LANGUAGE of the narration (English or Italian; "no preference" means English) (required: music, subtitles and the language are asked EVERY time, and "no" is an answer); audience, tone, what must appear (optional) — and answers with the questions for whatever the request does not say. Ask the user ALL of them in ONE message, in the user's language, wait for the answers, and call it again with them (duration_s, format, style, product, ai_upscale, music, subtitles, language, audience, tone, must_keep; an AI upscale question left unanswered is "no"). The film's language is their answer to the language question, never the language they write to you in. Never pick a subject, a length, a format, a look, the product, music, subtitles or the language for them: what the request does not say is asked, not assumed. When the user delegates the subject ("stupiscimi", "surprise me"), the tool says so: propose 3-5 concrete subjects in one message and let them pick — never ask the same question again, never render before they pick. 2) Once it answers ready_to_render, the same tool hands YOU two methods. FIRST the SPEC: the user's request taken apart into the requirements the film is checked against — who is in it and exactly how they look, where, what happens and in which order, what must be seen, read or said, what must never appear — extraction, not creativity: every item quotes the user's own words. THEN the producer's method, and you write the TREATMENT under the spec (logline, angle, opening image, acts, ending, look, pacing, narrator, the layer, the decisions you took): when the user described their film, it is THEIR film — their characters as described, their events in their order — and you add only what they left open. Show the user in ONE message what Kleo understood (the spec read back as a short list), the logline and the decisions, and wait for their yes or their corrections. 3) kleo_storyboard_guide, then write the storyboard yourself under that treatment (every shot lists the spec items it shows in "covers" and the characters in it in "cast"): this is where the film's quality is made, and Kleo's own planner is the fallback, not the standard. 4) kleo_create_video with the prompt (unchanged), the length, the format, the product, the AI upscale answer and the language the user chose, the spec, the treatment, the references, the storyboard and — when the user corrected what Kleo understood — their corrections in their own words as "corrections". 5) kleo_wait_for_video again and again until it returns the links, then hand them over.
PICTURES: when the user attaches or links images (a person, a pet, an object, a place, a style they like), Kleo draws the characters and things FROM those pictures. Pass https links as "references" to kleo_adapt_prompt; for pictures attached to the chat, call kleo_upload_link, give the user the link, and when they say they uploaded, call kleo_adapt_prompt again with references [{upload: "<token>"}]. Describe every attached picture in the spec as well (the character's "look"), and pass the returned handles to kleo_create_video as "references".
DELIVERY RULE: the user expects the finished video in this same conversation. After kleo_create_video, call kleo_wait_for_video repeatedly (each call waits up to about a minute and returns progress) until it returns the MP4 and thumbnail links. Tell the user once that the render is running and the estimated minutes — the eta_min the server returns, never your own guess — and do not ask "shall I keep waiting?". Never invent progress, files or links: only repeat what these tools return. Call the video by its number (for example "video gt_ab12cd34"), not "job".`;

const ok = (data: unknown, text?: string) => ({
  content: [{ type: "text" as const, text: text ?? JSON.stringify(data, null, 2) }],
  structuredContent: data as Record<string, unknown>,
});
const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });

async function guarded<T>(fn: () => Promise<T>): Promise<T | ReturnType<typeof fail>> {
  try { return await fn(); }
  catch (e) { if (e instanceof JobError || e instanceof RefError) return fail(e.message); throw e; }
}

/* ------------------------------------------------------------------ reference pictures and the fidelity report */

/** The zod shape of one reference picture on kleo_adapt_prompt (src/refs.ts RefInput). */
const referenceSchema = z.object({
  url: z.string().max(2000).optional().describe("A public https:// link to the picture (PNG, JPEG or WebP, up to 12 MB)."),
  upload: z.string().max(400).optional().describe("The token of a kleo_upload_link link the user uploaded pictures through: every picture uploaded there is taken."),
  handle: z.string().regex(REF_HANDLE_RE).optional().describe("A handle (kref_…) this tool or the upload page returned earlier."),
  role: z.enum(REF_ROLES).optional().describe("What the picture is for: character (draw this person/animal/creature), object, place, or style (imitate the look)."),
  name: z.string().max(60).optional().describe("The character's name, when the picture is of a character (\"Mara\", \"my dog Pepe\")."),
  note: z.string().max(300).optional().describe("What the user said about the picture, in their words."),
});

/** The pictures as the spec writer and the assistant read them: one line each. */
const refsBlock = (refs: ResolvedRef[]): string => refs.length
  ? `\n\nREFERENCE PICTURES KLEO HOLDS FOR THIS FILM (put each in the spec's "refs" with its handle, and what it shows into the character's "look" or the item's "text"; pass the handles to kleo_create_video as "references"):\n${refs.map((r) => `- ${r.handle}${r.role ? ` (${r.role}${r.name ? `: ${r.name}` : ""})` : r.name ? ` (${r.name})` : ""}: ${r.description || "Kleo's vision model could not describe it — describe it yourself from what the user showed you"}`).join("\n")}`
  : "";
const refsData = (refs: ResolvedRef[]) => refs.map((r) => ({ handle: r.handle, role: r.role, name: r.name, description: r.description }));

export interface FidelitySummary {
  /** Requirements (spec items, or a character's look) at least one picture was asked about. */
  checked: number;
  /** Of those, the ones some picture showed. */
  kept: number;
  misses: { id: string; text: string }[];
  pictures: number;
  /** The plan judge's score (src/fidelity.ts), when the report carries one. */
  plan_score: number | null;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const listOf = (x: unknown): unknown[] => (Array.isArray(x) ? x : isObj(x) ? Object.values(x) : []);
const idOf = (x: unknown): string => (typeof x === "string" ? x : isObj(x) && typeof x.id === "string" ? x.id : "");

/**
 * The fidelity report (renders/<job>/fidelity.json, written by src/stills.ts) as one line the user can read: how many
 * of the things they asked for were checked on the pictures and found, and which were not. Tolerant of the report's
 * shape on purpose — it is written by another stage and read long after — so it reads either an explicit `summary`
 * ({checked, kept|passed, misses}) or, per picture under `stills` (array or map), the checks asked (`checks`, or the
 * keys of `answers`) and the ones that `failed` (ids or check objects). The film-wide style question and the "no
 * stray text" question are not the user's requirements and are not counted. Null when there is nothing to say.
 */
export function summarizeFidelity(report: unknown, spec: RequestSpec | null, checksOf?: (pictureId: string) => string[] | null): FidelitySummary | null {
  if (!isObj(report)) return null;
  const label = (id: string): string => {
    if (id.startsWith("cast:")) { const c = spec?.cast.find((x) => x.id === id.slice(5)); return c ? `${c.name} looking as described` : id; }
    return (spec && itemById(spec, id)?.text) || id;
  };
  const keyOf = (id: string) => id.replace(/^exclude:/, "");
  // The identity question (24 September 2026, src/stills.ts checksFor: "the same individual as the reference image of
  // Mara") compares a still with Kleo's own character sheet: a check of Kleo's consistency, not one of the user's
  // requirements, so it is not counted either (the user's words about Mara are her look items, counted as such).
  const counted = (id: string) => !!id && id !== "style" && id !== "no-text" && id !== "logic" && !id.startsWith("identity:");
  const plan = isObj(report.plan) && typeof report.plan.score === "number" ? report.plan.score : null;
  const s = report.summary;
  if (isObj(s) && typeof s.checked === "number" && (typeof s.kept === "number" || typeof s.passed === "number")) {
    const misses = listOf(s.misses).map((m) => { const id = idOf(m); return { id, text: isObj(m) && typeof m.text === "string" ? m.text : label(keyOf(id)) }; }).filter((m) => m.id);
    return { checked: s.checked, kept: (typeof s.kept === "number" ? s.kept : s.passed) as number, misses, pictures: typeof s.pictures === "number" ? s.pictures : listOf(report.stills).length, plan_score: plan };
  }
  // Per picture: its id (the map's key, or its own "id"), the checks it was asked, the ones that failed. A picture the
  // judge never saw (judged: false) proves nothing either way and is left out.
  const entries: [string, Record<string, unknown>][] = Array.isArray(report.stills)
    ? report.stills.filter(isObj).map((st) => [typeof st.id === "string" ? st.id : "", st])
    : isObj(report.stills) ? Object.entries(report.stills).filter((e): e is [string, Record<string, unknown>] => isObj(e[1])) : [];
  const stills = entries.filter(([, st]) => st.judged !== false);
  const checked = new Set<string>(), shown = new Set<string>();
  // AN EXCLUSION HOLDS ON EVERY PICTURE (24 September 2026). "Some picture shows it" is the rule for what the user
  // asked to SEE; for what they asked NOT to see ("no dogs") it read one still with a dog among nine without as kept,
  // and the report said "misses: none". An exclusion failed on any judged picture is a miss, whatever the others say.
  const excluded = new Set(spec?.items.filter((i) => i.kind === "exclude").map((i) => i.id) ?? []);
  const violated = new Set<string>();
  for (const [pid, st] of stills) {
    const failedRaw = listOf(st.failed).map(idOf).filter(counted);
    for (const id of failedRaw) if (id.startsWith("exclude:") || excluded.has(id)) violated.add(keyOf(id));
    const failed = new Set(failedRaw.map(keyOf));
    const listed = listOf(st.checks).map(idOf);
    const answered = Object.keys(isObj(st.answers) ? st.answers : {});
    // The stills engine records what FAILED; what was ASKED is recomputed from the spec and the shot, the same
    // questions src/spec.ts visualChecks gave the judge.
    const asked = listed.length ? listed : answered.length ? answered : (pid && checksOf?.(pid)) || [];
    const ids = asked.filter(counted).map(keyOf);
    for (const id of ids) { checked.add(id); if (!failed.has(id)) shown.add(id); }
    for (const id of failed) checked.add(id);
  }
  for (const id of violated) shown.delete(id);
  if (!checked.size) return plan === null ? null : { checked: 0, kept: 0, misses: [], pictures: stills.length, plan_score: plan };
  const misses = [...checked].filter((id) => !shown.has(id)).map((id) => ({ id, text: label(id) }));
  return { checked: checked.size, kept: shown.size, misses, pictures: stills.length, plan_score: plan };
}

/** The line kleo_get_result adds: "Fidelity: 7 of 8 requirements checked on the pictures; misses: R4 (…)". */
export const fidelityLine = (f: FidelitySummary): string => f.checked
  ? `Fidelity: ${f.kept} of ${f.checked} requirements checked on the pictures; misses: ${f.misses.length ? f.misses.map((m) => `${m.id} (${m.text})`).join("; ") : "none"}.${f.misses.length ? " Tell the user plainly which of the things they asked for the pictures do not show." : ""}`
  : `Fidelity: the plan was judged against the request (score ${Math.round((f.plan_score ?? 0) * 100)}%); no picture was checked.`;

async function fidelityOf(env: Env, job: Job): Promise<FidelitySummary | null> {
  try {
    const file = (await listFiles(env, job.id)).find((f) => f.name === "fidelity.json");
    if (!file) return null;
    const got = await getFile(env, file.key, null);
    if (!got) return null;
    const report = JSON.parse(await new Response(got.body as BodyInit).text()) as unknown;
    let spec: RequestSpec | null = null;
    let look: "realistic" | "animation" = "realistic";
    try { const p = JSON.parse(job.params) as JobParams; spec = specOf(p); if (p.style === "animation") look = "animation"; } catch { /* a job without a spec still has a report */ }
    let shots = new Map<string, { covers: string[]; cast: string[] }>();
    try { if (job.storyboard) shots = new Map(pictureScenes(JSON.parse(job.storyboard)).map((p) => [p.id, { covers: p.covers, cast: p.cast }])); } catch { /* no storyboard: only what the report lists */ }
    const checksOf = (pid: string): string[] | null => { const sh = shots.get(pid); return sh ? visualChecks(spec, sh, look).map((c) => c.id) : null; };
    return summarizeFidelity(report, spec, checksOf);
  } catch { return null; }   // the report is a courtesy: a broken one never stands between the user and the links
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
  script: "writing the script", voice: "recording the narration", music: "adding the music", clips: "drawing the scenes", film: "finishing the film", edit: "editing", finishing: "finishing up",
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


/**
 * The AI upscale of a finished film, in words and as data: "applied", or "not applied" with the reason and the credits
 * given back (src/orchestrator.ts recordAiUpscale wrote it on the row when the finish box reported). Null for a job
 * that was not sold the option.
 */
export function upscaleOf(job: Pick<Job, "params">): { line: string; data: { applied: boolean; refunded: number; reason: string | null } } | null {
  let p: JobParams;
  try { p = JSON.parse(job.params) as JobParams; } catch { return null; }
  if (!p.ai_upscale) return null;
  const r = p.ai_upscale_result;
  if (!r) return { line: "AI upscale: its report has not reached Kleo; if it was not applied, its credits are given back.", data: { applied: false, refunded: 0, reason: "no report yet" } };
  if (r.applied) return { line: `AI upscale: applied (Real-ESRGAN + RIFE on all ${plural(r.parts, "shot")}).`, data: { applied: true, refunded: 0, reason: null } };
  return { line: `AI upscale: not applied (${r.reason ?? "the finish could not run it"})${r.refunded > 0 ? `, ${plural(r.refunded, "credit")} refunded` : ""}; the film is in the classic 4K 60 fps. Tell the user.`, data: { applied: false, refunded: r.refunded, reason: r.reason } };
}

/** Download links for a finished job, as data + human text (shared by kleo_get_result and kleo_wait_for_video). */
async function resultPayload(env: Env, base: string, job: Job) {
  const view = jobView(job);
  const what = view.product === "animatic" ? `${kindOf(view.format)} (animatic)` : kindOf(view.format);
  const links = await resultLinks(env, base, job);
  const label: Record<string, string> = { video_url: "Video (MP4)", thumbnail_url: "Thumbnail" };
  const order = ["video_url", "thumbnail_url"];
  const sim = job.backend === "mock" ? "\nNOTE: this video was rendered in SIMULATED mode: the MP4 is a 1-second placeholder, not a real video." : "";
  // The music the user asked for, when it is not on the film (footage.ts musicNote): said here, where the links are.
  const music = await musicNote(env, job);
  // THE FIDELITY REPORT (24 September 2026): what the pictures were checked for and what they did not show, said
  // where the links are, so the user hears about a miss from Kleo and not by finding it in the video.
  const fidelity = await fidelityOf(env, job);
  // THE AI UPSCALE (25 September 2026): what the finish did with the option the user paid for, and the refund if not.
  const upscale = upscaleOf(job);
  const text = `Your ${what} ${job.id} is ready. The links work until ${niceDate(job.expires_at)}:\n` +
    Object.entries(links).sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)).map(([k, v]) => `${label[k] ?? k.replace("_url", "")}: ${v}`).join("\n") + sim + (music ? `\n${music}` : "") + (fidelity ? `\n${fidelityLine(fidelity)}` : "") + (upscale ? `\n${upscale.line}` : "");
  return { data: { job_id: job.id, state: "done", expires_at: job.expires_at, mode: job.backend === "mock" ? "simulated" : "gpu", ...(music ? { music_missing: true } : {}), ...(fidelity ? { fidelity } : {}), ...(upscale ? { ai_upscale: upscale.data } : {}), ...links }, text };
}


/* ------------------------------------------------------------------ the pictures, metered */

/** Vision descriptions of reference pictures one account may cause per UTC day; env REFS_MAX_PER_DAY overrides it. */
export const REFS_MAX_PER_DAY = 30;
/** Upload links one account may mint per UTC day (each takes UPLOAD_MAX_FILES pictures); env UPLOAD_LINKS_MAX_PER_DAY. */
export const UPLOAD_LINKS_MAX_PER_DAY = 10;
/** A numeric setting the Env type does not declare yet (the caps above), read the same way as the others. */
const envInt = (env: Env, key: string, d: number): number => int((env as unknown as Record<string, string | undefined>)[key], d);
const asRole = (x: unknown): RefInput["role"] => ((REF_ROLES as readonly string[]).includes(String(x)) ? (x as RefInput["role"]) : null);

/**
 * THE PICTURES, METERED (24 September 2026). kleo_adapt_prompt takes pictures on every call, before any cap, and every
 * https link was fetched and — whenever the role passed differed from the stored one — described again by the paid
 * vision model. Eight entries of the SAME link with roles character/style/character/… deduplicated to one handle, so
 * the per-film limit never fired, and each call still cost eight fetches of up to 12 MB and eight vision calls, as
 * often as any free account cared to repeat it. Now, before anything reaches src/refs.ts:
 *   - the entries are merged: one link, one upload token or one handle is taken once per call, its first role kept;
 *   - each link is fetched once and named by its bytes (the same SHA-256 handle refs.ts gives it), so a second link
 *     to the same picture is the same picture, and a picture this account already holds, with the description it
 *     needs, is taken in without a vision call;
 *   - every vision call — a new picture, or a known one asked in a new role — is one "refs.describe" audit row, and an
 *     account gets REFS_MAX_PER_DAY of them a day: past it a NEW picture is refused in words (nothing is charged), and
 *     a known one keeps the description it has.
 * Upload tokens and handles are only looked up (no fetch, no vision), exactly as before.
 */
export async function meteredRefs(env: Env, userId: string, inputs: readonly RefInput[]): Promise<ResolvedRef[]> {
  const merged = new Map<string, RefInput>();
  inputs.forEach((x, i) => {
    const key = x.url ? `url:${x.url.trim()}` : x.upload ? `upload:${x.upload.trim()}` : x.handle ? `handle:${x.handle.trim()}` : `none:${i}`;
    const had = merged.get(key);
    merged.set(key, had ? { ...had, role: had.role ?? x.role ?? null, name: had.name ?? x.name ?? null, note: had.note ?? x.note ?? null } : x);
  });
  const cap = envInt(env, "REFS_MAX_PER_DAY", REFS_MAX_PER_DAY);
  let used: number | null = null;
  const out: RefInput[] = [];
  const fetched = new Set<string>();
  for (const x of merged.values()) {
    if (!x.url) { out.push(x); continue; }
    const { bytes } = await fetchRefBytes(x.url);   // every failure is a RefError in words
    const handle = await refHandle(bytes);
    const role = asRole(x.role);
    const keep: RefInput = { handle, role, name: x.name ?? null, note: x.note ?? null };
    if (fetched.has(handle)) { out.push(keep); continue; }   // two links, one picture: resolveRefs merges the two
    fetched.add(handle);
    const known = await refMeta(env, userId, handle);
    const needsVision = !known || !known.description || (role !== null && role !== known.role);
    if (needsVision) {
      used ??= await countAuditTodayForUser(env, userId, "refs.describe");
      if (used >= cap) {
        if (!known) throw new RefError(`This account has had ${plural(used, "picture")} described today, and the limit is ${cap} a day while Kleo is in beta. Pass the handles (kref_…) Kleo already returned for the pictures it holds, or add new pictures tomorrow. Nothing was charged.`);
        out.push(keep);   // a picture Kleo holds keeps the description it has
        continue;
      }
      used++;
      await audit(env, userId, null, "refs.describe", { handle, role, known: !!known });
    }
    // The bytes already fetched are handed over, so the link is fetched once; with no vision call needed, ingestRef
    // only refreshes the sidecar (the name and the note the user gave now).
    await ingestRef(env, userId, { bytes, role, name: x.name ?? null, note: x.note ?? null });
    out.push(keep);
  }
  return resolveRefs(env, userId, out);
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
    title: "Adapt a video request into the film's spec and treatment",
    description: "Step 1 (recommended). Reads the user's request against Kleo's intake and asks for what is missing — the film or the animatic (with this account's prices) and the narration's language (English or Italian) among it; once nothing is, turns it into the SPEC (the request taken apart into the requirements the finished film is checked against: who is in it and exactly how they look, where, what happens in which order, what must be seen, read or said, what must never appear — every item quoting the user) and then the TREATMENT of the film written under it (logline, angle, opening image, acts with their seconds, ending, visual language, pacing, narrator, motifs), listing every decision Kleo took that the user did not ask for. When the user described their film, the film is theirs: their characters as described, their events in their order. Takes the user's reference pictures (https links, or an upload token from kleo_upload_link) and answers with their handles and what they show. Nothing is charged and no GPU is rented. Then show the user what Kleo understood, the logline and the decisions, and pass the \"spec\" and the \"treatment\" — unchanged, or corrected as the user asked — to kleo_create_video.",
    inputSchema: z.object({
      prompt: z.string().min(1).max(4000).describe("The user's request in their own words."),
      duration_s: z.number().int().min(15).max(300).optional().describe("Length in seconds. Read off the request when its words say it; otherwise the tool asks the user for it — pass their answer here, never a guess."),
      format: z.enum(FORMATS).optional().describe("16:9 for YouTube/landscape, 9:16 for a Short/TikTok/Reel. Read off the request when its words say it; otherwise the tool asks the user for it — pass their answer here, never a guess."),
      language: z.string().max(40).optional().describe("The user's answer to the question about the narration's language, in their words (\"en\", \"English\", \"italiano\"…): Kleo narrates in English or Italian, and \"whatever\" / \"no preference\" means English. Asked every time the request does not say it: pass their answer, never a guess, and never the language they write to you in."),
      product: z.enum(PRODUCTS).optional().describe(`The user's answer to the question film or animatic, which the tool asks with this account's prices: "film" (every shot a generated clip, for accounts that have bought a pack) or "animatic" (the drawn frames with camera moves, ${ANIMATIC_CREDITS} credits flat, up to ${ANIMATIC_MAX_S} seconds). Never a guess.`),
      ai_upscale: z.string().max(80).optional().describe("The user's answer to the AI upscale question, in their words (\"yes\" / \"no\"): asked for a film only, with its price in extra credits. Only a clear yes buys it; \"no\", \"whatever\" or no answer means the classic 4K 60 fps finish. Never a guess."),
      audience: z.string().max(160).optional().describe("Who the video is for, when the user said it."),
      tone: z.string().max(160).optional().describe("The tone the user asked for, when they said it."),
      must_keep: z.string().max(400).optional().describe("What the user said must appear (names, numbers, places, a message) or must not, when they answered that question."),
      style: z.enum(FILM_LOOKS).optional().describe("The look: \"realistic\" (filmed, cinematic) or \"animation\" (a 2D animated film). Read off the request when its words say it; otherwise the tool asks the user for it — pass their answer here."),
      music: z.string().max(200).optional().describe("The user's answer about music, in their words: \"no\" (in any spelling) for none; \"yes\", or the kind they want (a mood, a genre, an instrument), for an instrumental track under the narration. Asked every time; pass their answer, never a guess."),
      subtitles: z.enum(["yes", "no"]).optional().describe("The user's answer about burned-in subtitles: \"yes\" for thin cinema subtitles in the video, \"no\" for none (an .srt file is delivered either way). Asked every time; pass their answer, never a guess."),
      references: z.array(referenceSchema).max(8).optional().describe("The pictures the user gave for this film, each with ONE of: url (a public https link), upload (the token of a kleo_upload_link link they uploaded through), handle (kref_… returned earlier); plus role and name when the user said what it shows. Kleo draws the characters, objects and places FROM these pictures."),
      author: z.enum(["assistant", "server"]).default("assistant").describe("Who writes the spec and the treatment. \"assistant\" (default): Kleo hands YOU the two methods and you write them — you are a far stronger writer than Kleo's own planning model, and it costs nothing. \"server\": Kleo's model writes them (use only if you cannot write JSON yourself)."),
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ prompt, duration_s, format, language, audience, tone, must_keep, style, music, subtitles, product, ai_upscale, references, author }) => guarded(async () => {
    // THE PRODUCT IS ASKED WITH THE PRICES (25 September 2026): film or animatic is one of the intake's questions, and
    // it quotes what each costs this user, so the account is read first. D1 reads only: nothing is written or charged.
    const paid = await hasPaid(env, user.id);
    const fresh = (await getUser(env, user.id)) ?? user;
    const said = prompt.trim().replace(/\s+/g, " ");
    const lengthAsked = duration_s ?? durationFrom(said);
    const filmPrice = lengthAsked ? creditsForProduct(lengthAsked, style ?? lookFromText(said) ?? FILM_STYLE, "film") : null;
    // THE AI UPSCALE (25 September 2026): offered with its price unless the Worker's KLEO_SR switches it off.
    const upscaleOffered = aiUpscaleOn(env);
    const upscalePrice = upscaleOffered && filmPrice ? aiUpscaleCredits(filmPrice, env) : null;
    const account = { paid, credits: fresh.credits, filmCredits: filmPrice, animaticCredits: ANIMATIC_CREDITS, animaticMaxS: ANIMATIC_MAX_S, tariff: tariffSentence(),
      ...(upscaleOffered ? { aiUpscale: { credits: upscalePrice, rule: aiUpscaleRule(env) } } : {}) };
    const brief = adaptPrompt(prompt, { duration_s, format, audience, tone, must_keep, look: style ?? null, music, subtitles, language, product, ai_upscale, account });
    // The two answers, as the method and the server's model read them (src/treatment.ts SoundOptions).
    const sound = { music: brief.music, subtitles: brief.subtitles };
    const look = style ?? brief.look;   // the user's answer on the call, or read off the request
    // THE PICTURES (24 September 2026, src/refs.ts): taken in on every call, so the handles and what the vision model
    // saw come back with the intake questions too, and a broken link is said before anything else is asked.
    // Metered (meteredRefs above): this runs before every cap, so it carries its own.
    const refs = references?.length ? await meteredRefs(env, user.id, references) : [];
    if (refs.length) void audit(env, user.id, null, "refs.adapt", { handles: refs.map((r) => r.handle), described: refs.filter((r) => r.description).length });
    const head = { workflow: ACTIVE_TEMPLATE.id, style: look, brief, has_paid: paid, product: brief.product, ai_upscale: brief.ai_upscale, prices: { film: filmPrice, animatic: ANIMATIC_CREDITS, ...(upscaleOffered ? { ai_upscale: upscalePrice } : {}) }, account_url: await accountUrl(env, user.id, base), ...(refs.length ? { references: refsData(refs) } : {}) };
    // THE INTAKE (14 September): a required item the request does not say — subject, length, format, look, and since
    // 25 September the product and the narration's language — is asked, never guessed. The questions are the tool's
    // answer, and nothing is spent.
    const fmt = brief.format, dur = brief.duration_s;
    if (brief.questions.length || dur === null || fmt === null || look === null || brief.language === null || brief.product === null || (brief.product === "film" && upscaleOffered && brief.ai_upscale === null)) return ok({ ...head, treatment: null, ready_to_render: false, questions: brief.questions, optional_questions: brief.optional_questions }, `${adaptivePromptText(brief)}${refsBlock(refs)}`);
    const t = ACTIVE_TEMPLATE;
    const maxS = brief.product === "animatic" ? ANIMATIC_MAX_S : t.maxSeconds;
    if (dur < t.minSeconds || dur > maxS)
      throw new JobError(`Kleo makes ${brief.product === "animatic" ? "animatics" : "films"} of ${t.minSeconds} to ${maxS} seconds; ${dur} seconds is outside that range. Agree a length in range with the user and call again. Nothing was charged.`);
    // The narration's language is the user's answer (the intake asked it), never the language of the chat.
    const lang = brief.language, chosen = brief.product;
    // What kleo_create_video is told about the upscale: the user's answer, and what it adds to this film.
    const upscaleYes = chosen === "film" && brief.ai_upscale === true;
    // The read-back says the upscale and its price to the USER before anything is debited (review, 25 September 2026:
    // a length given only on the second round never had the exact number put in front of them).
    const upscaleReadBack = upscaleYes && upscalePrice ? `, and, in the same message, the AI upscale they chose and its price: "AI upscale: yes, +${upscalePrice} credits, ${(filmPrice ?? 0) + upscalePrice} in all (the ${upscalePrice} come back if the finish cannot apply it)"` : "";
    const upscaleArg = chosen === "film" && upscaleOffered ? `, ai_upscale: "${upscaleYes ? "yes" : "no"}"${upscaleYes && upscalePrice ? ` (the user's AI upscale: +${upscalePrice} credits, ${(filmPrice ?? 0) + upscalePrice} in all)` : ""}` : "";
    // On the API road every shot is a paid clip of at least the model's shortest length: the treatment is told so.
    const clipFloorS = clipFloorFor(env, { product: chosen, duration_s: dur }, await footageConfig(env));
    // The intake's optional answers travel to kleo_create_video by name: until 24 September they died here, and the
    // planner never read who the film was for or what had to be in it.
    const answers = { ...(audience?.trim() ? { audience: audience.trim() } : {}), ...(tone?.trim() ? { tone: tone.trim() } : {}), ...(brief.must_keep ? { must_keep: brief.must_keep } : {}) };
    const handles = refs.map((r) => r.handle);
    const passOn = `${handles.length ? `, references ${JSON.stringify(handles)}` : ""}${Object.keys(answers).length ? `, and the user's answers ${Object.entries(answers).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")}` : ""}`;
    // THE FREE ROAD (14 September): the assistant's own model writes the treatment under the method. Measured on
    // whole films, the server's 17B model wrote checklists, platitudes and diagrams; the model reading this tool is
    // usually a frontier one. Nothing is spent, and kleo_create_video checks what comes back. Since 24 September the
    // SPEC comes first: the requirements are extracted before anybody is creative with them.
    if (author !== "server") {
      const v = variationFor(crypto.randomUUID());
      const specMethod = specMethodText({ prompt: prompt.trim(), language: lang, refs: refs.map((r) => ({ handle: r.handle, description: r.description || null })) });
      const answerLines = [
        brief.must_keep ? `- must appear, or must never appear: "${brief.must_keep}"` : "",
        audience ? `- the film is for: "${audience.trim()}"` : "",
        tone ? `- the tone: "${tone.trim()}"` : "",
      ].filter(Boolean);
      const answersText = answerLines.length ? `\nTHE USER ALSO ANSWERED (items may quote these answers too, word for word):\n${answerLines.join("\n")}` : "";
      const method = treatmentMethodText({ prompt: prompt.trim(), duration_s: dur, format: fmt, language: lang, look, sound, specPending: true, clipFloorS }, v);
      void audit(env, user.id, null, "treatment.method", { variation: v.key, duration_s: dur, format: fmt, language: lang, product: chosen, look, music: brief.music?.wanted ?? null, subtitles: brief.subtitles, refs: handles.length, spec_method: true });
      return ok({ ...head, language: lang, treatment: null, spec: null, author: "assistant", variation: v.key, ready_to_render: true, ...answers,
        next: `STEP A: write the SPEC, following the spec method in the text (extraction: every item quotes the user). STEP B: write the TREATMENT under it, following the producer's method. The spec is ${MODE_RULE}; Kleo re-decides the mode by this rule. When it is FAITHFUL, tell the story the user's way — their characters as described, their events in their order — set the treatment's "variation" to "as-told/as-asked", and put everything you added in "decisions". THEN, in ONE message in the user's language, show them what Kleo understood (the spec read back as a short list: the characters and how they look, where, what happens in order, what must be seen or said, what is left to Kleo), the logline and the decisions${upscaleReadBack}, and wait for their yes or their corrections. If they correct or add something, change the spec and the treatment as they say (an item they added quotes their correction) and keep their words for "corrections". Only then call kleo_create_video with prompt (the user's words, unchanged), duration_s, format, language: "${lang}" (the narration language the user chose, not the language of the chat), product: "${chosen}"${upscaleArg}, style (the look the treatment names), music and subtitles (the user's answers, as you passed them here), the object as "spec", the object as "treatment"${passOn}, and — when they corrected anything — "corrections" (their corrections, word for word). If you cannot write them, call this tool again with author: "server".` },
        `${adaptivePromptText(brief)}${refsBlock(refs)}\n\n${specMethod}${answersText}\n\nSTEP B — THEN THE TREATMENT, UNDER THE SPEC YOU JUST WROTE. ${method}`);
    }
    // Each treatment is a model call on the free planning quota, so an account gets a day's worth and no more:
    // past it the video is still possible, and the planner writes the treatment itself when it plans.
    const cap = int(env.ADAPT_MAX_PER_DAY, 12);
    const used = await countAuditTodayForUser(env, user.id, "treatment.adapt");
    const fallback = "You can still make the video: call kleo_create_video with the prompt and Kleo writes the treatment itself while planning it.";
    if (used >= cap) throw new JobError(`This account has asked for ${plural(used, "treatment")} today, and the limit is ${cap} a day while Kleo is in beta. ${fallback} Nothing was charged.`);
    if (await isFlagActive(env, "plan_pause"))
      return ok({ ...head, language: lang, treatment: null, ready_to_render: true, note: "planning quota exhausted" }, `${adaptivePromptText(brief)}${refsBlock(refs)}\n\nKleo cannot write the treatment right now: it has used up today's free planning. ${fallback}`);
    // THE SERVER'S ROAD: the spec first (temperature 0, extraction), then the treatment written under it. A spec that
    // could not be written leaves the treatment to be written as before — the video is never blocked on it.
    let spec: RequestSpec | null = null;
    try {
      const sr = await writeSpec(env, { prompt: prompt.trim(), language: lang, must_keep: brief.must_keep, audience: audience?.trim() || null, tone: tone?.trim() || null, refs: refs.map((r) => ({ handle: r.handle, description: r.description || null, role: r.role, name: r.name })) });
      spec = sr.spec;
      const request = [prompt.trim(), brief.must_keep, audience?.trim(), tone?.trim()].filter(Boolean).join("\n");
      void audit(env, user.id, null, "spec.adapt", { model: sr.model, attempts: sr.attempts, ms: sr.ms, ok: !!sr.spec, transient: sr.transient, mode: sr.spec?.mode ?? null, why: sr.spec ? specModeWhy(sr.spec, request).why : null, items: sr.spec?.items.length ?? 0, history: sr.history.slice(0, 3) });
    } catch (e) {
      void audit(env, user.id, null, "spec.adapt", { ok: false, error: String(e).slice(0, 200) });
    }
    const r = await writeTreatment(env, { prompt: prompt.trim(), duration_s: dur, format: fmt, language: lang, look, sound, spec, clipFloorS });
    void audit(env, user.id, null, "treatment.adapt", { language: lang, product: chosen, model: r.model, attempts: r.attempts, ms: r.ms, usage: r.usage, est_neurons: r.est_neurons, ok: !!r.treatment, transient: r.transient, history: r.history.slice(0, 3), variation: r.treatment?.variation ?? null, spec: spec ? spec.mode : null });
    const understood = spec ? `\n\n${specText(spec)}` : "";
    if (!r.treatment)
      return ok({ ...head, language: lang, treatment: null, spec, ready_to_render: true, ...answers, note: r.transient ? "model unavailable" : "no valid treatment in two attempts", problems: r.history },
        `${adaptivePromptText(brief)}${refsBlock(refs)}${understood}\n\nKleo could not write the treatment just now (${r.transient ? "its planning model did not answer" : "two attempts came back incomplete"}). ${fallback} Or call this tool once more.`);
    return ok({ ...head, language: lang, style: r.treatment.look, spec, spec_text: spec ? specText(spec) : null, treatment: r.treatment, ready_to_render: true, ...answers,
      next: `Show the user, in ONE message, what Kleo understood${spec ? " (the spec above, as a short list)" : ""}, the logline and the decisions${upscaleReadBack}, and wait for their yes or their corrections; then call kleo_create_video with prompt (unchanged), duration_s, format, language: "${lang}" (the narration language the user chose, not the language of the chat), product: "${chosen}"${upscaleArg}, style (this treatment's "look"), music and subtitles (the user's answers)${spec ? ', this same "spec" (corrected as they asked: an item they added quotes their correction)' : ""} and this same object as "treatment"${passOn}, and — when they corrected anything — "corrections" (their corrections, word for word).` },
      `${adaptivePromptText(brief)}${refsBlock(refs)}${understood}\n\n${treatmentText(r.treatment)}`);
  }));

  server.registerTool("kleo_upload_link", {
    title: "Get a link where the user uploads pictures",
    description: `When the user attached pictures to the chat (or says they have photos) of a person, a pet, an object, a place or a style Kleo should draw from, call this and give them the link: they open it on their device, drop the pictures in (PNG, JPEG or WebP, up to 12 MB each, ${UPLOAD_MAX_FILES} per link; the link lasts 48 hours) and come back. When they say they uploaded, call kleo_adapt_prompt again with references [{upload: "<token>", role, name}] — Kleo takes every picture uploaded there, describes it, and draws the characters from it. Pictures on the web can be passed directly as references [{url: "https://…"}] instead. Nothing is charged.`,
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  }, async () => guarded(async () => {
    // Each link takes UPLOAD_MAX_FILES new pictures, and each picture is a vision call: links are counted too (24
    // September 2026), so the number of pictures an account can have described is bounded on this road as well.
    const linkCap = envInt(env, "UPLOAD_LINKS_MAX_PER_DAY", UPLOAD_LINKS_MAX_PER_DAY);
    const links = await countAuditTodayForUser(env, user.id, "refs.upload_link");
    if (links >= linkCap) throw new JobError(`This account has asked for ${plural(links, "upload link")} today, and the limit is ${linkCap} a day while Kleo is in beta. Use a link you already gave the user (it lasts 48 hours), or pass the pictures as https:// links. Nothing was charged.`);
    const { token, expires_at } = await makeUploadToken(env, user.id);
    const url = `${base}/upload/${token}`;
    await audit(env, user.id, null, "refs.upload_link", { expires_at });   // awaited: the row is the day's counter
    return ok({ upload_url: url, token, expires_at, max_images: UPLOAD_MAX_FILES, ttl_hours: UPLOAD_TTL_S / 3600, next: `Give the user this link now: ${url} — tell them to open it, add the pictures, and tell you when they are done. Then call kleo_adapt_prompt again with references [{upload: "${token}"}] (add role and name when they said what a picture shows).` },
      `Upload link for the user's pictures (valid 48 hours, up to ${UPLOAD_MAX_FILES} pictures, PNG/JPEG/WebP up to 12 MB each): ${url}\nGive it to the user as a plain link and ask them to say when they have uploaded. Then call kleo_adapt_prompt again with references [{upload: "${token}"}] — plus role (character, object, place, style) and name when they told you what a picture shows. Until then, describe the pictures you can see in the spec yourself.`);
  }));


  server.registerTool("kleo_list_templates", {
    title: "List the template and the two products",
    description: `Lists Kleo's one template, film (realistic or animation look, 16:9 or 9:16, 15-300 s), and its two products: the film (every shot a generated clip — moving footage by ByteDance Seedance 2.5 from a frame drawn by Google Nano Banana Pro — priced by length, for accounts that have bought a credit pack) and the animatic (the same drawn frames with camera moves, ${ANIMATIC_CREDITS} credits flat, up to ${ANIMATIC_MAX_S} s, every account). Music and burned-in subtitles are options in both: the user is always asked and gets them only when they say yes.`,
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const fresh = (await getUser(env, user.id)) ?? user;
    const activeTemplate = ACTIVE_TEMPLATE;
    const templates = [activeTemplate].map((t) => ({
      id: t.id, name: t.name, formats: t.formats, duration_s: { min: t.minSeconds, max: t.maxSeconds, default: t.defaultSeconds },
      credits: creditsFor(t.defaultSeconds, "realistic"), animatic_credits: ANIMATIC_CREDITS, animatic_max_s: ANIMATIC_MAX_S, voices: t.voices, description: t.description,
    }));
    const pricing = tariffSentence();
    const lines = [activeTemplate].map((t) => {
      const shape = t.formats.map((f) => (f === "9:16" ? "Short (9:16)" : "YouTube video (16:9)")).join(" or ");
      return `- ${t.name} (id: ${t.id}): ${shape}, ${t.minSeconds}–${t.maxSeconds} seconds, ${plural(creditsFor(t.defaultSeconds, "realistic"), "credit")}. ${t.description}`;
    });
    return ok(
      // The prices are the ones creditsFor charges, read from it: this line used to quote the pre-film tariff (one
      // credit a Short) next to a description that said seven.
      { templates, credits_available: fresh.credits, pricing, models: MODELS, account_url: await accountUrl(env, user.id, base) },
      `Kleo has one template (film) in two looks, realistic and animation, and two products from the same storyboard: the film (every shot a generated clip; accounts that have bought a pack) and the animatic (the drawn frames with camera moves, ${plural(ANIMATIC_CREDITS, "credit")} flat, up to ${ANIMATIC_MAX_S} s; every account). You have ${plural(fresh.credits, "credit")} left. Call kleo_adapt_prompt with the user's request before creating the video: its intake asks, in one message, whatever the request does not say (subject, length, format, look, film or animatic with the prices, music, subtitles, the narration's language).\n${lines.join("\n")}\nPrices: ${pricing}.\nModels: ${modelsSentence()}.`,
    );
  });


  server.registerTool("kleo_storyboard_guide", {
    title: "Storyboard guide (write your own video)",
    description: "Step 2 (recommended). Returns how to write a storyboard Kleo renders, in the order it should be written: first the DIRECTION of the film (subject, goal, audience, tone, the facts from the request that the narration must still say, the world it is drawn in, what must never appear, and one accent colour per section), then the scene and shot shapes, the limits Kleo enforces before anything is billed, and one worked example. Kleo has two looks, realistic and animation; in both every shot starts as one frame drawn in that look — in the film it becomes a generated clip, in the animatic the camera moves over the frame — so the same storyboard serves both products. Call it once per conversation, before kleo_create_video. Without a storyboard Kleo plans a more generic one from the prompt.",
    inputSchema: z.object({
      template: z.literal(ACTIVE_TEMPLATE.id).optional().describe("Optional: Kleo uses the only active workflow, film."),
      duration_s: z.number().int().min(15).max(900).optional().describe("Target length in seconds, if the user chose one."),
      style: z.enum(FILM_LOOKS).optional().describe("The look: \"realistic\" (filmed) or \"animation\" (a 2D animated film); in both every shot is generated footage from its own frame, under the narration. Realistic when omitted."),
      format: z.enum(FORMATS).optional().describe("The frame the video will be in. The explainer authors its drawings in the frame's own pixels, so its guide prints different coordinates for 9:16 and 16:9; the template's own format is used when this is omitted."),
      product: z.enum(PRODUCTS).optional().describe("The product the user chose (film or animatic): a film's pictures become paid clips, and the guide says how many a line can carry. Film when omitted."),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ template, duration_s, style, format, product }) => {
    const look = style ?? "realistic";
    const t = template === ACTIVE_TEMPLATE.id ? ACTIVE_TEMPLATE : null;
    const dur = duration_s ?? t?.defaultSeconds ?? 45;
    // The explainer writes coordinates, so the guide has to know the frame before it prints them: a storyboard
    // authored against 1080x1920 and rendered at 1920x1080 puts every drawing off the page.
    const fmt = format ?? t?.formats[0] ?? "9:16";
    const words = wordBudget(dur, 1.1).target;
    // The guide is built in src/guide.ts from the contract\u2019s own constants, so the numbers it prints are the numbers
    // the validator enforces \u2014 the shot range used to be 1-4 here, 2-4 in the planner and "two to four" on the website.
    // The road decides how many pictures a line can carry (src/footage.ts clipFloorFor), as it does at kleo_create_video.
    const clipFloorS = clipFloorFor(env, { product: product ?? "film", duration_s: dur }, await footageConfig(env));
    const text = guideText({ template: ACTIVE_TEMPLATE.id, templateName: ACTIVE_TEMPLATE.name, duration_s: dur, style: look, languages: JOB_LANGUAGES, format: fmt, clipFloorS });
    // The guide is where an assistant is most likely to start inventing: it has just been handed the shape of a
    // storyboard and nothing to put in it. So the sentence that leaves with it is the one that says whose idea it
    // has to be — a model follows the last instruction it read far more reliably than a tool description.
    const askFirst = "\n\nBEFORE YOU WRITE THIS: the subject has to come from the user, not from you. If they have not "
      + "said what the video is about, ask them now and wait for the answer. If they gave you a subject, however short, "
      + "that is enough — write the storyboard and do not interrogate them.";
      return ok({ guide: text, template: t?.id ?? ACTIVE_TEMPLATE.id, duration_s: dur, format: fmt, words_target: words, credits: creditsFor(dur, look), animatic_credits: ANIMATIC_CREDITS, animatic_max_s: ANIMATIC_MAX_S, styles: [...FILM_LOOKS], style: look }, text + askFirst);
  });

  server.registerTool("kleo_create_video", {
    title: "Create a video",
    description: `Step 3. ASK FIRST, THEN CALL. Do not call this until the user has said, in their own words, what the video should be about. If the subject is YOUR idea and not theirs — you suggested a topic, or you filled a vague request in with your own guess — stop and ask them, and wait for the answer. A render spends a credit they cannot get back once it starts and takes about twenty minutes, so a video nobody asked for is not a fast answer, it is a wasted one. When their request is short but clear (\"a Short about pirates\"), that is enough: do not interrogate them. When it is missing the subject entirely, ask for the subject and nothing else. Starts rendering, in the chosen look (realistic or animation), either the FILM — every shot generated as moving footage from its own frame, narrated, 4K 60 fps; for accounts that have bought a credit pack (kleo_account → has_paid) — or the ANIMATIC of the same storyboard (product: "animatic": the drawn frames with the camera moving over each one, same narrator and layer, no generated clip; ${ANIMATIC_CREDITS} credits flat, up to ${ANIMATIC_MAX_S} seconds, every account) — from a prompt, a length, a format and the user's two answers about music and subtitles (plus your storyboard from kleo_storyboard_guide, if you wrote one). The price follows the length for a film (${tariffSentence()}); the tool answers with the exact credits before anything is charged, and a render takes 25-35 minutes on a rented GPU (an animatic fifteen to twenty). Returns at once with the video number (job_id), the estimated minutes (eta_min) and the credits used; the render runs on a GPU in the background. Tell the user the number and the estimate, then offer to check progress with kleo_get_job. Pass the "spec" and the "treatment" the user approved, the handles of their reference pictures as "references", their must_keep / audience / tone answers, and their "corrections" after the read-back in their own words when they gave any: the film is planned under the spec and every picture is checked against it. If the tool returns an error, nothing was charged: fix what it says and call again.`,
    inputSchema: z.object({
      template: z.string().optional().describe(`Optional; the only one is "film" (realistic or animated, 16:9 for YouTube or 9:16 for Shorts; 15 to 300 seconds for a film, 15 to ${ANIMATIC_MAX_S} for an animatic). Omit it.`),
      prompt: z.string().describe("What the video is about, IN THE USER'S OWN WORDS (8 to 4000 characters): topic, angle, facts, names, tone, anything that must appear on screen. If you are about to write this field out of an idea of your own, that is the sign to ask them instead: the credit and the twenty minutes are theirs, so the subject has to be theirs too."),
      duration_s: z.number().int().min(15).max(300).describe("Length in seconds, as the user said or answered it (kleo_adapt_prompt asks when the request does not say). Required: Kleo never picks a length for the user."),
      format: z.enum(["16:9", "9:16"]).describe("16:9 for YouTube/landscape, 9:16 for a Short/TikTok/Reel, as the user said or answered it. Required: Kleo never picks a frame for the user."),
      language: z.enum(JOB_LANGUAGES).default("en").describe("Voice and caption language: the narration language the user chose, as kleo_adapt_prompt's \"language\" returned it (the intake asks it; never the language of the chat). A storyboard you pass must declare this same language."),
      voice: z.string().optional().describe("Voice id from kleo_list_templates (narrator-en-m, narrator-en-f, narrator-it-m, narrator-it-f). The engine ids used inside a storyboard (am_michael, af_heart, bf_emma, im_nicola, if_sara) are accepted too. Optional."),
      style: z.enum(FILM_LOOKS).optional().describe("The look: \"realistic\" (cinematic live action) or \"animation\" (a 2D animated film); both narrated; every shot starts as one frame drawn in that look — a generated clip in the film, a camera move over the frame in the animatic. Pass the treatment's \"look\"; when omitted the treatment decides, and realistic when nothing says."),
      music: z.string().max(200).nullable().optional().describe("The user's answer about music, exactly as you passed it to kleo_adapt_prompt: \"no\" (or null) for none; \"yes\" or the kind they want for an instrumental track under the narration (the treatment's \"music\" brief is used when it has one). Kleo has the track composed by Suno and ducks it under the voice."),
      subtitles: z.union([z.boolean(), z.enum(["yes", "no"])]).optional().describe("The user's answer about burned-in subtitles: true/\"yes\" for thin cinema subtitles in the picture, false/\"no\" for none. An .srt file is delivered either way."),
      product: z.enum(PRODUCTS).optional().describe(`The product the user chose in the intake (kleo_adapt_prompt asks it, with the prices): pass it. What to make from the storyboard: "film" (default; every shot a generated clip, priced by length, for accounts that have bought a credit pack) or "animatic" (the same drawn frames with the camera moving over each one, the same narrator and layer, 4K 60 fps, no generated clip; ${ANIMATIC_CREDITS} credits flat, up to ${ANIMATIC_MAX_S} seconds, every account). Say which one you are ordering to the user before you call.`),
      ai_upscale: z.union([z.boolean(), z.string().max(80)]).optional().describe("The user's answer to the AI upscale question kleo_adapt_prompt asked (film only): \"yes\" for Real-ESRGAN + RIFE on every shot, at the extra credits the intake quoted (refunded automatically if the finish cannot apply it); \"no\", or omitted, for the classic 4K 60 fps finish."),
      notify_email: z.string().email().optional().describe("Optional: email the download links when the render finishes."),
      spec: z.looseObject({}).optional().describe("The SPEC you wrote under kleo_adapt_prompt's spec method (or the one it returned), corrected as the user asked: {v:1, mode, summary, cast, items, refs, open, narration, script}. Every item's \"quote\" must be the user's own words from the prompt, from their must_keep/audience/tone answers, or from their \"corrections\" after the read-back (pass those too). Checked before anything is charged; the film is planned under it and every picture is checked against it."),
      references: z.array(z.string().max(400)).max(8).optional().describe("The user's reference pictures: the handles (kref_…) kleo_adapt_prompt returned, or the token of a kleo_upload_link link they uploaded through. Kleo draws the characters from them."),
      must_keep: z.string().max(400).optional().describe("The user's answer to \"what must appear, or must not\", as passed to kleo_adapt_prompt."),
      audience: z.string().max(160).optional().describe("Who the film is for, as the user said it."),
      tone: z.string().max(160).optional().describe("The tone the user asked for."),
      corrections: z.string().max(1000).optional().describe("The user's corrections after you read back what Kleo understood, IN THEIR OWN WORDS (\"add my dog Pepe with a red collar\", \"she has red hair, not blonde\"). The prompt stays their first request, unchanged; a spec item added by a correction quotes these words. Omit it when they simply said yes."),
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
    const base0 = creditsForProduct(duration, args.style ?? "realistic", args.product);
    const cost = base0 + (args.product !== "animatic" && aiUpscaleAnswer(args.ai_upscale) === true && aiUpscaleOn(env) ? aiUpscaleCredits(base0, env) : 0);
    if (duration >= t.minSeconds && duration <= t.maxSeconds && fresh.credits < cost)
      throw new JobError(`Not enough credits: this ${args.product === "animatic" ? "animatic" : kindOf(args.format ?? t.formats[0])} costs ${plural(cost, "credit")} and you have ${plural(fresh.credits, "credit")}. Nothing was charged.${args.product !== "animatic" && fresh.credits >= ANIMATIC_CREDITS ? ` The animatic of the same storyboard costs ${plural(ANIMATIC_CREDITS, "credit")}: call again with product: "animatic"${duration > ANIMATIC_MAX_S ? ` and a length of at most ${ANIMATIC_MAX_S} seconds` : ""}.` : ""} Your account and how to get more: ${await accountUrl(env, user.id, base)}`);
    const maxOpen = int(env.MAX_JOBS_PER_USER, 2);
    const open = await countOpenForUser(env, user.id);
    if (open >= maxOpen)
      throw new JobError(`You already have ${plural(open, "video")} in progress, and the limit is ${maxOpen} at a time. Wait for one to finish (kleo_get_job) or cancel one with kleo_cancel_job. Nothing was charged.`);
    // The length is passed as computed here, so the courtesy check above and the debit below price the same film.
    const job = await createJob(env, fresh, { ...args, template: t.id, duration_s: duration });
    const view = jobView(job);
    const what = kindOf(view.format);
    const sim = simulated ? " SIMULATED MODE: this is a test render; it finishes in about a minute and the files are placeholders, not a real video." : "";
    const eta = simulated ? "about a minute" : `about ${plural(job.eta_min ?? 0, "minute")}`;
    // WHEN KLEO GUESSED THE LOOK, IT SAYS SO. Measured on 27 requests written by two other sessions: 13 named no
    // subject the word lists know, and the whole set scored 26%. A guess that presents itself as a decision is the
    // bug — the user sees a video in the wrong look and cannot tell why. A guess that admits it is a conversation:
    // the assistant reads this line, tells the user, and the user fixes it while the credits can still come back.
    const styleNote = view.style === "animation" ? " Look: animation, a 2D animated film." : " Look: realistic cinematic.";
    const productNote = productOf(JSON.parse(job.params) as JobParams) === "animatic" ? " This is the ANIMATIC: the drawn frames with the camera moving over them, narrated, no generated clip — say so to the user." : "";
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
    // The spec and the pictures, said back: the user should hear that what they described is what will be checked.
    const spec = specOf(jp);
    const specNote = spec ? ` Kleo will check the film against your ${plural(spec.items.filter((i) => i.must).length, "requirement")} (${spec.mode === "faithful" ? "your film, as you described it" : "a subject Kleo develops"}).` : "";
    const refsNote = jp.refs?.length ? ` It draws from ${plural(jp.refs.length, "reference picture")}.` : "";
    // The AI upscale, said with its price when the user answered the question (25 September 2026).
    const upscaleNote = jp.ai_upscale
      ? ` AI upscale: yes, Real-ESRGAN + RIFE on every shot, ${plural(jp.ai_upscale_credits ?? 0, "credit")} of the ${plural(job.credits, "credit")} (given back automatically if the finish cannot apply it).`
      : args.ai_upscale !== undefined && productOf(jp) === "film" ? " AI upscale: no, the classic 4K 60 fps finish." : "";
    const summary = `Your ${what} is in the queue. Video number: ${job.id}.${cappedNote} Template: ${t.name}, ${view.format}, ${view.duration_s} seconds.${styleNote}${productNote}${treatNote}${specNote}${refsNote}${upscaleNote} It should be ready in ${eta}. ${plural(job.credits, "credit")} used, ${plural(fresh.credits - job.credits, "credit")} left. NEXT STEP, do it now: call kleo_wait_for_video with job_id "${job.id}", and when it answers that the video is still rendering call it again, and again, until it answers that the video is ready. Do not end your turn and do not ask the user anything in between: they are waiting for the finished video in this conversation.${sim}`;
    return ok({ ...view, credits_left: fresh.credits - job.credits, mode: simulated ? "simulated" : "gpu", message: summary }, summary);
  }));

  const statusLine = (job: Job): string => {
    const view = jobView(job);
    const what = kindOf(view.format);
    switch (job.state) {
      case "done": return `Your ${what} ${job.id} is ready. Call kleo_get_result for the download links.`;
      case "failed": return `Sorry, ${what} ${job.id} could not be rendered. Your ${plural(job.credits, "credit")} ${job.credits === 1 ? "was" : "were"} given back. Please try again; if it fails a second time, try a shorter video or another template.${job.error ? ` (Technical detail: ${publicText(job.error)})` : ""}`;
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
        return `- ${j.id}: ${v.duration_s}-second ${kindOf(v.format)}, ${v.product === "animatic" ? "animatic" : "film"}, template "${templateName(j.template)}", ${status}`;
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
    if (job.state === "failed") return ok({ ...jobView(job), next: "stop" }, `Sorry, ${what} ${job.id} could not be rendered: ${publicText(job.error ?? "unknown error")}. Your credits were given back. You can try again with kleo_create_video.`);
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
    description: "Step 5. Download links for a finished video (film or animatic): the MP4, the thumbnail and the subtitles as an .srt file (burned-in subtitles and the music track, when the user asked for them, are inside the MP4), and, when the pictures were checked against the user's request, one line saying how many of the things they asked for the pictures show and which they miss.",
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
    description: "The credits left on this account, whether it can order a FILM (has_paid: films are for accounts that have bought a pack; every account can order the animatic), the link to its page, and the \"Kleo key\" that carries the same account (and the same credits) to another browser or another computer. Call it before the first kleo_create_video of a conversation and when the user asks how many credits they have, how to get more, or how to use Kleo somewhere else. Give them account_url as a plain link: it opens a read-only page (balance, prices, where to write) and cannot sign anybody in. Show account_key only if they ask for it, because anyone who has it can take the account over and spend its credits.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const fresh = (await getUser(env, user.id)) ?? user;
    const url = await accountUrl(env, user.id, base);
    // Every number here is read from where it is charged or sold, never written by hand: this tool used to say
    // "1 credit = 1 Short" and "card payments are not open yet" for a day after the film became the only product
    // at 7 credits and the account page had started selling packs. A new account with its free credits was told it
    // could neither render nor buy, and an assistant repeated it word for word.
    const free = freeCreditsFor(env);
    const open = await sellingAvailable(env);
    const cheapest = PACKS[0];
    // THE TWO PRODUCTS (15 September): a film is filmed by kie.ai on the owner's money and is opened by one payment on
    // record; the animatic is for everyone. Said here, once, so the assistant offers what this account can have.
    const paid = await hasPaid(env, user.id);
    // The AI upscale (25 September 2026): a film's option at extra credits, unless the Worker switched it off.
    const upscaleOffered = aiUpscaleOn(env);
    const upscaleSentence = upscaleOffered
      ? ` A film can have the optional AI upscale (Real-ESRGAN + RIFE, a sharper picture): ${aiUpscaleRule(env).en} (${aiUpscaleCredits(filmCredits(30), env)} for a 30-second Short), given back if the finish cannot apply it; the intake asks.`
      : "";
    const data = {
      credits_available: fresh.credits,
      has_paid: paid,
      can_order_film: paid,
      animatic_credits: ANIMATIC_CREDITS,
      animatic_max_s: ANIMATIC_MAX_S,
      products: paid
        ? `film (priced by length) and animatic (${ANIMATIC_CREDITS} credits flat, up to ${ANIMATIC_MAX_S} s)`
        : `animatic only (${ANIMATIC_CREDITS} credits flat, up to ${ANIMATIC_MAX_S} s): the film opens after any credit pack is bought`,
      film_credits: filmCredits(), // the template's default length (30 s)
      ai_upscale: upscaleOffered
        ? { available: true, rule: aiUpscaleRule(env).en, credits_30s: aiUpscaleCredits(filmCredits(30), env), credits_60s: aiUpscaleCredits(filmCredits(60), env) }
        : { available: false },
      seconds_per_credit: SECONDS_PER_CREDIT,
      min_film_credits: MIN_FILM_CREDITS,
      pricing: tariffSentence(),
      free_tier: free > 0
        ? `${plural(free, "credit")} on sign-up, no signup form; they buy an animatic (${ANIMATIC_CREDITS} credits, up to ${ANIMATIC_MAX_S} s), and the shortest film is ${MIN_FILM_CREDITS} credits and needs a pack (from ${cheapest.label}: ${free} + ${cheapest.credits} = ${free + cheapest.credits} credits, a 30-second Short)`
        : "no free credits: connecting is free, every video is paid (no subscription, credit packs only)",
      account_key: await makeHandle(env, user.id),
      account_url: url,
      payments_open: open,
      models: MODELS,
    };
    const enough = fresh.credits >= MIN_FILM_CREDITS ? "" : ` That is not enough for a film yet (the shortest is ${MIN_FILM_CREDITS} credits)${fresh.credits >= ANIMATIC_CREDITS ? `, but it pays for an animatic (${ANIMATIC_CREDITS})` : ""}.`;
    const films = paid
      ? " This account has bought a pack, so it can order films and animatics."
      : ` This account has not bought a pack yet, so it can order the ANIMATIC (${plural(ANIMATIC_CREDITS, "credit")}, up to ${ANIMATIC_MAX_S} seconds: the drawn frames with the camera moving over them, narrated) but not a film — the film opens with any pack, because its clips are generated at Kleo's expense.`;
    const buy = open
      ? `Credit packs are on the account page, paid through Stripe (from ${cheapest.label} for ${cheapest.credits} credits; one payment, nothing renews)`
      : `Card payments are paused right now; the account page says when they reopen`;
    return ok(data, `You have ${plural(fresh.credits, "credit")}. ${tariffSentence()}.${enough}${films}${paid ? upscaleSentence : ""} ${buy}. Your account page, which also shows the key that carries this account to another browser: ${url}`);
  });

  return server;
}

export const FILE_KINDS = FILE_NAMES;

/** Builds a per-request stateless MCP handler bound to the authenticated user. */
export function mcpHandlerFor(env: Env, user: User, base: string) {
  return createMcpHandler(() => buildServer(env, user, base), { legacy: "stateless" });
}
