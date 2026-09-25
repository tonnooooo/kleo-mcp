/**
 * THE STILLS ENGINE (24 September 2026, the fidelity engine): the server draws every still of a film itself, with
 * FLUX.2 [klein] 9B on Workers AI, has each one looked at by a vision model against the user's spec, and draws it
 * again when it does not show what was asked — BEFORE any GPU is rented.
 *
 * WHY. Until today the stills were drawn on the rented GPU by an SDXL model that reads 77 CLIP tokens: the scene text
 * was cut to 150 characters, a character's look to 110, and nobody ever looked at the result. Measured on 18
 * production jobs (9-22 September): a brunette in a red apron replaced the blonde pastry chef in lilac, a man's face
 * appeared in a film whose only character was a hand, the hero wore the villain's clothes — and each of those
 * pictures went on to become a paid kie.ai clip. The owner's verdict: "it does not follow the images".
 *
 * WHAT CHANGED, and what was measured before choosing it (24 September, probes on the production account):
 *   - FLUX.2 [klein] 9B reads a long prompt (an LLM text encoder, not CLIP): the whole look of every character, the
 *     place, the treatment's visual sentence and the exact words of a sign fit, with nothing cut. 3-5 s per picture at
 *     768x1344, readable text, strong adherence.
 *   - It takes up to four REFERENCE IMAGES (input_image_0..3). Passing a character's earlier picture as
 *     input_image_0 gave perfect identity across shots — the one thing no prompt had ever achieved. So each cast
 *     member first gets a CHARACTER SHEET (drawn from their full look, or from the user's own photo when they gave
 *     one), and every shot that shows them is drawn with their sheet as a reference.
 *   - Every still is JUDGED (src/vision.ts, llama-4-scout: 8/8 right on a trap question set, 2.6 s) with one yes/no
 *     question per requirement the shot claims (src/spec.ts visualChecks), plus one identity question per character
 *     drawn from a sheet. A failed must sends the picture back with the failure written FIRST in its prompt ("It is
 *     essential that: …") and a new seed, up to STILL_ATTEMPTS (2); the first try with no failed must is the still,
 *     whatever its soft answers; otherwise the best try is kept (fewest failed musts, then the score) and every
 *     verdict lands in fidelity.json.
 *
 * WHERE IT RUNS. In the orchestrator's cron (drawJobStills, bounded per tick, resumed on the next one), before the
 * job may rent a GPU; the worker's POST /internal/jobs/:id/images then answers with the stored pictures (src/images.ts)
 * and draws on the GPU, the legacy way, only what is still missing. A transient error (a 429, a 5xx, a timeout, a
 * store hiccup) only PAUSES the drawing until the next tick (stillsErrorVerdict); the daily quota, a bug, or twenty
 * minutes gone marks params.stills "failed" and the GPU draws the rest: a job is never stranded by this engine.
 *
 * WHICH MODEL DRAWS (25 September 2026). The owner decided the stills must reach Higgsfield quality, and klein-4B does
 * not. Measured the same day: Nano Banana Pro (Google Gemini 3 Pro Image) through OpenRouter drew a clean, story-true
 * two-character frame from the two character sheets, 768x1376 in 23 s for 0.138 $; kie.ai sells the same model for
 * 0.09 $. So the model id now names its ROAD (drawImage): "@cf/…" is Workers AI as before, "openrouter:<vendor/model>"
 * is OpenRouter's chat completions, "kie:<model>" is kie.ai's jobs API (references as signed public links, since kie.ai
 * takes URLs, not bytes). The vision judge stays on Workers AI whatever draws. A provider that refuses for MONEY (no
 * credit, unauthorized, payment required, no key) never costs a film its pictures: the job falls back to
 * STILL_MODEL_FALLBACK (klein-4B) for the rest of its drawing, with a "stills.fallback" audit row; a 429, a 5xx or a
 * timeout keeps the pause semantics above. What every still cost is summed into "stills.done" (usd).
 *
 * Only imports plain TypeScript modules (with .ts extensions) and type-only dependencies, so the tests load it under
 * Node's type stripping (src/refs.ts included: it is written the same way).
 */
import type { Env } from "./env";
import type { Job, JobParams } from "./db";
import { audit, setFile, listFiles, updateJobParams } from "./db.ts";
import { putFile, getFile } from "./storage.ts";
import { int, num, nowIso, minutesSince, hmacHex, base64ToBytes } from "./util.ts";
import { pictureScenes, directionOf, kleoStyleOf, MAX_PICTURES } from "./keou-contract.ts";
import { headNoun, headNounIn, PRONOUN_HINTS, type Direction } from "./direction.ts";
import { specOf, castById, fullLook, itemById, visualChecks, norm, type RequestSpec, type SpecItem, type VisualCheck } from "./spec.ts";
import { judgeImage, mimeOf, toBase64, type VisionImage } from "./vision.ts";
import { readImageResult, sniffImage, imageFileName, IMAGE_NAME_RE, fnv1a, isTransientError, isQuotaError, isTransientStoreError } from "./images.ts";
import { refImage, refFileKey, readBodyCapped, REF_HANDLE_RE } from "./refs.ts";
import { kie, KIE_CREATE, KIE_RECORD, KieError, isNoCredit, kieResultUrls, USD_PER_KIE_CREDIT, type KieRecord } from "./kie.ts";
import { ephoneBase, EPHONE_NO_MONEY_RE } from "./ephone.ts";

/* ------------------------------------------------------------------ constants */

export type StillLook = "realistic" | "animation";
export type StillFormat = "9:16" | "16:9";

/**
 * THE PRICE OF A STILL (24 September 2026, the owner: "a radical change, but spending no more than now"). Workers AI
 * bills FLUX.2 klein 9B at $0.015 for the first megapixel; klein 4B at $0.000287 per output 512x512 tile — a 896x1600
 * still is 8 tiles, $0.0023, seven times less. Measured on the pastry chef the same day: 4B drew the blonde bun, the
 * lilac apron and a clean "SORPRESA" at the first try and kept her face from a reference image; it was weaker than 9B
 * on a busy composition (two children for "three friends", no finger on the lips) — exactly what the vision judge
 * catches. So 4B draws every try, and 9B draws only the LAST try of a still whose earlier tries all failed a must —
 * and, since the fidelity bench of the same day, only when the must it failed is one 9B draws better: a look, the
 * identity against a character sheet, or a written text (drawJudged).
 */
export const DEFAULT_STILL_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
export const DEFAULT_STRONG_STILL_MODEL = "@cf/black-forest-labs/flux-2-klein-9b";
export const stillModel = (env: Pick<Env, "STILL_MODEL">): string => (env.STILL_MODEL ?? "").trim() || DEFAULT_STILL_MODEL;
/**
 * The escalation model for the last try, or null when STILL_MODEL_STRONG is "none" (or the same model as STILL_MODEL).
 * Unset, it is klein-9B only when STILL_MODEL is a Workers AI model (25 September 2026): the ladder exists because
 * klein-4B is weak, and nothing on Workers AI draws better than Nano Banana Pro — a last try "escalated" from it to
 * klein-9B would be a step down, paid for.
 */
export const strongStillModel = (env: Pick<Env, "STILL_MODEL" | "STILL_MODEL_STRONG">): string | null => {
  const main = stillModel(env);
  const m = (env.STILL_MODEL_STRONG ?? "").trim() || (stillProviderOf(main).provider === "workers-ai" ? DEFAULT_STRONG_STILL_MODEL : "none");
  return /^(none|off|-)$/i.test(m) || m === main ? null : m;
};
/** The model a job falls back to after a refusal for money (STILL_MODEL_FALLBACK, default klein-4B), or null when it is "none". */
export const fallbackStillModel = (env: Pick<Env, "STILL_MODEL_FALLBACK">): string | null => {
  const m = (env.STILL_MODEL_FALLBACK ?? "").trim() || DEFAULT_STILL_MODEL;
  return /^(none|off|-)$/i.test(m) ? null : m;
};

/**
 * THE ROAD A MODEL ID NAMES (25 September 2026): "openrouter:<vendor/model>" is OpenRouter's chat completions,
 * "kie:<model>" is kie.ai's jobs API, and anything else — "@cf/…" above all — is Workers AI, as every id was before.
 */
export type StillProvider = "workers-ai" | "openrouter" | "kie" | "ephone";
export function stillProviderOf(model: string): { provider: StillProvider; id: string } {
  const m = String(model ?? "").trim();
  if (/^openrouter:/i.test(m)) return { provider: "openrouter", id: m.slice("openrouter:".length).trim() };
  if (/^ephone:/i.test(m)) return { provider: "ephone", id: m.slice("ephone:".length).trim() };
  if (/^kie:/i.test(m)) return { provider: "kie", id: m.slice("kie:".length).trim() };
  return { provider: "workers-ai", id: m };
}
/** Where an "openrouter:…" model is drawn when neither IMAGE_API_URL nor PLAN_API_URL says otherwise. */
export const DEFAULT_IMAGE_API_URL = "https://openrouter.ai/api/v1";

/** The resolution tier a Gemini-class model is asked for: "2K" for a still (896x1600 and up), "1K" for a sheet (768x1024). */
export type ImageTier = "1K" | "2K" | "4K";
export const imageTierOf = (size: { width: number; height: number }): ImageTier => {
  const long = Math.max(size.width, size.height);
  return long <= 1024 ? "1K" : long <= 2048 ? "2K" : "4K";
};
const ASPECTS: [string, number][] = [["9:16", 9 / 16], ["16:9", 16 / 9], ["3:4", 3 / 4], ["4:3", 4 / 3], ["2:3", 2 / 3], ["3:2", 3 / 2], ["1:1", 1]];
/** The named aspect ratio nearest to a size (every one listed is in both kie.ai's and OpenRouter's lists): 896x1600 is "9:16", a 768x1024 sheet "3:4". */
export function aspectRatioOf(size: { width: number; height: number }): string {
  const r = size.width / size.height;
  return ASPECTS.reduce((best, a) => (Math.abs(Math.log(a[1] / r)) < Math.abs(Math.log(best[1] / r)) ? a : best))[0];
}

/**
 * WHAT ONE DRAW COSTS when the provider does not say (25 September 2026), so the owner can read what each film's
 * pictures cost ("stills.done" usd). A provider-reported figure always wins over this table: OpenRouter's usage.cost,
 * kie.ai's creditsConsumed. The figures: kie.ai nano-banana-pro 0.09 $ at 1K and 2K (kie.ai's model page); OpenRouter
 * google/gemini-3-pro-image-preview 0.138 $ (usage.cost measured on the 25th, 1K — Google bills 2K the same output
 * tokens); kie.ai nano-banana-2 0.04 $ at 1K, 0.06 $ at 2K; Workers AI klein-4B 0.000287 $ per 512x512 output tile
 * (0.0023 $ for a 896x1600 still); klein-9B about 0.016 $. Null for a model this table does not know (counted as 0).
 */
export function stillPriceUsd(model: string, size: { width: number; height: number }): number | null {
  const { provider, id } = stillProviderOf(model);
  const tier = imageTierOf(size);
  if (provider === "kie") return id === "nano-banana-pro" ? 0.09 : id === "nano-banana-2" ? (tier === "1K" ? 0.04 : 0.06) : null;
  // ePhone AI, gemini-official-cheap group (ratio 0.53), 1K, 25 September 2026: Nano Banana Pro 1,120 image tokens at
  // $120/M plus ~440 reasoning and text tokens at $12/M ≈ $0.14 x 0.53; Nano Banana 2 (gemini-3.1-flash-image) 1,120 at $60/M x 0.53.
  if (provider === "ephone") return /gemini-3-pro-image/.test(id) ? 0.074 : /gemini-3\.1-flash-image/.test(id) ? 0.036 : null;
  if (provider === "openrouter") return /gemini-3-pro-image/.test(id) ? 0.138 : null;
  if (/flux-2-klein-4b/.test(id)) return round4(Math.ceil(size.width / 512) * Math.ceil(size.height / 512) * 0.000287);
  if (/flux-2-klein-9b/.test(id)) return 0.016;
  return null;
}
/**
 * The size a still is drawn at: about 1.4 megapixels, multiples of 16, inside the 256-1920 px FLUX.2 accepts on
 * Workers AI (developers.cloudflare.com changelog of FLUX.2, 25 November 2025). The measured probe ran 768x1344 in
 * 3-5 s; this is the same aspect with 40% more pixels, because the still is the first frame of a 2K kie.ai clip and
 * every pixel it lacks is one the clip model has to invent.
 */
export const STILL_SIZES: Record<StillFormat, { width: number; height: number }> = {
  "9:16": { width: 896, height: 1600 },
  "16:9": { width: 1600, height: 896 },
};
/** A character sheet: portrait, a full figure. It is later passed back as a reference, which the model downscales. */
export const SHEET_SIZE = { width: 768, height: 1024 } as const;
/** FLUX.2 on Workers AI takes at most four input images (input_image_0..3). */
export const MAX_INPUT_IMAGES = 4;
/** FLUX.2 reads long prompts, but a prompt is a priority list: past this the least important parts are shortened. */
export const STILL_PROMPT_MAX = 1800;
/** Tries per sheet: a sheet is one plain figure, it rarely needs a third. */
export const SHEET_ATTEMPTS = 2;
/** Pictures drawn at once for one job. */
export const STILLS_CONCURRENCY = 3;
/** What one still may take (two tries of a draw and a judgement): nothing new starts closer than this to a deadline. */
export const EST_STILL_MS = 20_000;
/** Minutes of drawing after which the engine gives up on a job and lets the rented GPU draw the rest. */
export const STILLS_GIVE_UP_MIN = 20;
const DRAW_TIMEOUT_MS = 90_000;

/**
 * THE PACE OF AN EXTERNAL ROAD (25 September 2026, review of the Nano Banana switch). Everything above was tuned for
 * klein on Workers AI: 3-5 s a draw, so a tick of 45 s drew a dozen pictures, and twenty minutes was a generous
 * give-up. Nano Banana Pro takes 20-60 s a picture on kie.ai (23 s measured on OpenRouter), and with those constants
 * a tick started three stills, a redraw almost never fitted, sheets went one per tick, and a 24-picture film met the
 * give-up with its last stills drawn by the GPU's SDXL. On an external road the picture is drawn on the provider's
 * machines and the Worker only waits, so: six at a time, a tick window of STILLS_EXTERNAL_MS (the cron may run long,
 * as planning does), a still counted at a minute, and a give-up that grows with the film (stillsGiveUpMin).
 */
export const STILLS_CONCURRENCY_EXTERNAL = 6;
export const EST_STILL_MS_EXTERNAL = 60_000;
export const STILLS_EXTERNAL_MS = 150_000;
/** The road a model id names is external (kie.ai, OpenRouter): the slow pace above applies. */
export const isExternalStillModel = (model: string): boolean => stillProviderOf(model).provider !== "workers-ai";
/**
 * The give-up of a job's drawing, in minutes: STILLS_GIVE_UP_MIN on Workers AI; on an external road ten minutes plus
 * three per wave of STILLS_CONCURRENCY_EXTERNAL pictures (a 30 s Short of 15 pictures stays at 20, a 90 s film of 48
 * gets 34). `road` and `total` are what params.stills recorded.
 */
export function stillsGiveUpMin(st: { road?: string; total?: number } | null | undefined): number {
  if (!st?.road || st.road === "workers-ai") return STILLS_GIVE_UP_MIN;
  return Math.max(STILLS_GIVE_UP_MIN, 10 + 3 * Math.ceil((st.total ?? 0) / STILLS_CONCURRENCY_EXTERNAL));
}

/**
 * THE MONEY CAPS OF THE KIE.AI PICTURES (25 September 2026). Every kie.ai task a still creates is written down as a
 * "stills.task" audit row with its price (see KieLedger), and no task is created past either cap: STILLS_JOB_MAX_USD
 * per film (default 5 $: a 30 s Short with redraws is about 2 $) and STILLS_DAILY_USD per UTC day across every film
 * (default 10 $). Past a cap the job's pictures move to STILL_MODEL_FALLBACK, like after a refusal for money, so a
 * runaway loop or a queue of free animatics can never empty the kie.ai balance the paid films' clips are bought from.
 * The clips keep their own ceiling (DAILY_FOOTAGE_BUDGET_USD, src/footage.ts), which counts the pictures' dollars too.
 * Since 26 September 2026 both caps bound EVERY external road — a chat draw on ePhone AI or OpenRouter is booked on the
 * same rows (drawBooked) — and only Workers AI, paid in neurons, stays outside them.
 */
export const STILLS_JOB_MAX_USD = 5;
export const STILLS_DAILY_USD = 10;
/** A kie.ai task younger than this is collected on a later tick instead of paying for a new one (results live 24 h). */
export const KIE_TASK_RESUME_MIN = 20;

/**
 * The framing each shot kind asks for (src/shot-grammar.ts SHOT_KINDS), as the opening words of the prompt: a picture
 * model weighs the start most, and "extreme close-up of the object" is the difference between a detail shot and one
 * more wide view of the room.
 */
export const FRAMING: Record<string, string> = {
  hook: "Striking close shot, the subject large in the frame",
  establish: "Wide establishing shot of the whole place",
  face: "Close-up on the character's face",
  detail: "Extreme close-up of the object, filling the frame",
  detail_orbit: "Extreme close-up of the object, seen from a slight angle",
  action: "Medium shot of the action, the whole gesture in the frame",
  reveal: "Medium-wide shot revealing the subject in its surroundings",
  tension: "Tight close shot, the frame closing in on the subject",
  closing: "Wide, quiet final frame with space around the subject",
  static_forced: "Medium shot, still and composed",
};
export const DEFAULT_FRAMING = "Cinematic medium shot";

/** What the picture must look like, per look: said as what it IS (the style check asks the same thing back). */
export const STYLE_SENTENCE: Record<StillLook, string> = {
  realistic: "A real cinematic photograph, shot on a 35mm lens in natural light, sharp focus on the subject, real skin and fabric texture, high detail, not a drawing, not a 3D render.",
  animation: "A frame from a 2D animated feature film: hand-painted background, clean expressive character design, clean linework, cel shading, rich colour, cinematic composition, not a photograph, not a 3D render.",
};
export const NO_TEXT_SENTENCE = "There is no text, lettering, caption or watermark anywhere in the picture.";
/**
 * THE PICTURE MUST MAKE SENSE (24 September 2026). The owner, on the first new-engine still of the pastry chef: good,
 * "but some things make no sense, like the whisk on a cake that is already finished". Said to the drawing model, and
 * asked of the judge on every still (one more question in the same call, so it costs nothing).
 */
export const LOGIC_SENTENCE = "Everything is physically and logically plausible: every tool and object is used for its real purpose at the right moment of the action, nothing floats, merges or contradicts what is happening.";
const logicCheck: VisualCheck = { id: "logic", question: "Does everything in the image make physical and logical sense (every tool used for its real purpose at the right moment, every action possible, nothing floating or merged)?", expect: "yes", must: true };

/* ------------------------------------------------------------------ shapes */

export interface StillShot { id: string; image_prompt: string; shot_kind?: string | null; covers?: string[]; cast?: string[]; action?: string | null }
/**
 * A reference image: its bytes (what Workers AI, OpenRouter and the judge are given), and — since 25 September 2026 —
 * a signed public `url` of the same file, for a provider that takes links, not bytes (kie.ai). drawJobStills signs
 * one for every sheet, user picture and style anchor; a reference without one is not passed to such a provider.
 */
export interface StillRef { label: string; image: VisionImage; url?: string | null }
export interface StillInput {
  shot: StillShot;
  spec: RequestSpec | null;
  direction: Direction | null;
  look: StillLook;
  format: StillFormat;
  /** The treatment's visual-language sentence, when the film has one. */
  visual?: string | null;
  /** Reference images, in the order they are passed to the model: "reference image 1" is refs[0]. */
  refs: StillRef[];
}
export interface StillCastMember { id: string | null; name: string; look: string }
/** One try of a still: the check ids it failed, or ["flagged"] (Workers AI refused the output) / ["unjudged"] (the judge was silent). */
export interface StillTry { seed: number; score: number; failed: string[]; /** Set when the try was drawn by the escalation model, or by any model once the job fell back. */ model?: string; /** What the draw cost, in dollars (25 September 2026). */ usd?: number }
export interface StillResult { bytes: Uint8Array; score: number; mustFailed: number; failed: string[]; tries: StillTry[]; judged?: boolean; /** The ids of every check the still was judged by (the report reads it). */ checks?: string[]; /** Dollars spent on every try of this still (25 September 2026). */ usd?: number }

interface AiRunner { run(model: string, inputs: Record<string, unknown>): Promise<unknown> }

const clean = (s: unknown): string => String(s ?? "").trim().replace(/\s+/g, " ");
const sentence = (s: unknown): string => { const t = clean(s).replace(/[.;,:\s]+$/, ""); return t ? `${t}.` : ""; };
const cut = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max).replace(/\s+\S*$/, "")}`);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * The shots of a storyboard as the stills engine reads them: pictureScenes (id, image_prompt) plus the authoring
 * fields the planner fills since 24 September (shot_kind, covers, cast, action). Read defensively: a storyboard stored
 * before those fields existed simply has none of them.
 */
export function stillShotsOf(sb: unknown): StillShot[] {
  return pictureScenes(sb).map((p) => {
    const x = p as typeof p & Partial<{ shot_kind: string | null; covers: string[]; cast: string[]; action: string | null }>;
    return {
      id: p.id, image_prompt: p.image_prompt,
      shot_kind: typeof x.shot_kind === "string" ? x.shot_kind : null,
      covers: Array.isArray(x.covers) ? x.covers.map(String) : [],
      cast: Array.isArray(x.cast) ? x.cast.map(String) : [],
      action: typeof x.action === "string" && x.action.trim() ? x.action.trim() : null,
    };
  });
}

/* ------------------------------------------------------------------ who is in the picture */

/**
 * The characters one shot shows, each with the full look the picture must draw. The shot's own `cast` first (spec
 * cast ids or names, then the direction's cast by name), plus the owner of any "look" item it covers; only when the
 * shot names nobody, the prompt is read for names — the same rule as direction.ts castFor (whole name, or a head noun
 * no other character shares; a lone character is also "she"/"he"), kept here so the engine does not depend on that
 * function's signature while the planner reshapes it. A spec character is always drawn from the spec's look (the
 * user's words, every look item folded in), never from the direction's shorter paraphrase.
 */
export function stillCast(shot: Pick<StillShot, "image_prompt" | "covers" | "cast">, spec: RequestSpec | null, direction: Direction | null): StillCastMember[] {
  const out: StillCastMember[] = [];
  const add = (m: StillCastMember) => { if (m.name.trim() && !out.some((x) => norm(x.name) === norm(m.name))) out.push(m); };
  const specMember = (id: string): StillCastMember | null => {
    const c = spec ? castById(spec, id) : undefined;
    return c && spec ? { id: c.id, name: c.name, look: fullLook(spec, c.id) || c.look } : null;
  };
  const dcast = direction?.cast ?? [];
  const explicit = [...(shot.cast ?? [])];
  if (spec) for (const id of shot.covers ?? []) { const it = itemById(spec, id); if (it?.kind === "look" && it.who) explicit.push(it.who); }
  for (const c of explicit) {
    const s = specMember(c);
    if (s) { add(s); continue; }
    const d = dcast.find((m) => norm(m.name) === norm(c));
    if (d) add(specMember(d.name) ?? { id: null, name: d.name, look: d.look });
  }
  if (out.length) return out;
  const prompt = String(shot.image_prompt ?? "");
  const match = (pool: StillCastMember[]): StillCastMember[] => {
    const lower = prompt.toLowerCase();
    const heads = pool.map((m) => headNoun(m.name));
    const unique = (i: number) => heads[i] !== "" && heads.filter((h) => h === heads[i]).length === 1;
    const named = pool.filter((m, i) => m.name.trim() && (lower.includes(m.name.trim().toLowerCase()) || (unique(i) && headNounIn(m.name, prompt))));
    if (named.length || pool.length !== 1) return named;
    return PRONOUN_HINTS.test(prompt) ? [pool[0]] : [];
  };
  const fromSpec = spec ? match(spec.cast.map((c) => specMember(c.id)!).filter(Boolean)) : [];
  for (const m of fromSpec) add(m);
  if (!out.length) for (const m of match(dcast.map((d) => ({ id: null, name: d.name, look: d.look })))) add(specMember(m.name) ?? m);
  return out;
}

/* ------------------------------------------------------------------ the prompt */

const styleCheck = (look: StillLook): VisualCheck => visualChecks(null, {}, look)[0];
const noTextCheck: VisualCheck = { id: "no-text", question: "Is there any written text, lettering, caption or watermark in the image?", expect: "no", must: false };
const castCheck = (m: StillCastMember): VisualCheck => ({ id: `cast:${m.id ?? norm(m.name).replace(/ /g, "-")}`, question: `Is there a character matching this description: ${m.look}?`, expect: "yes", must: true });
const stripNegation = (t: string): string => clean(t).replace(/^(?:no|never|without|not|nothing like)\s+/i, "").replace(/[.\s]+$/, "");
/**
 * THE IDENTITY QUESTION (24 September 2026): whether the character in the still is the same individual as the sheet
 * it was drawn from. It is what replaced "Does the image show this: the pastry chef?" — a role no frame can prove,
 * failed on every pastry still of the fidelity bench although the woman in the lilac apron was there (src/spec.ts
 * visualChecks). The judge already sees the reference images after the picture, labelled with the characters' names
 * (src/vision.ts judgeImage), so the comparison costs no extra call. With one referenced character the question is
 * about "the main character"; with two or more it asks whether ANY character matches the named sheet, or the second
 * character's question would fail on a picture whose main character is, rightly, the first.
 */
const identityQuestionPrefix = "the same individual as the reference image of";
const identityCheck = (m: StillCastMember, among: number): VisualCheck => ({
  id: `identity:${m.id ?? norm(m.name).replace(/ /g, "-")}`,
  question: among > 1
    ? `Does the first image show a character who is ${identityQuestionPrefix} ${m.name} (same face, hair and clothes)?`
    : `Is the main character in the first image ${identityQuestionPrefix} ${m.name} (same face, hair and clothes)?`,
  expect: "yes",
  // A must only when one character is drawn from a sheet: with two, the judge mixes them up (probe gt_62bvh7ay,
  // 24 September 2026: "not the same individual" on stills that matched both sheets exactly).
  must: among <= 1,
});

/**
 * The checks one still is judged by: the spec's (src/spec.ts visualChecks), plus the direction's characters the spec
 * does not know, plus one identity question per character drawn from a sheet (a reference whose label is their name,
 * as drawJobStills passes them). A reference dropped on the way (a refused or flagged input image) takes its identity
 * question with it: compileStill is called again with the references actually passed.
 */
function checksFor(input: StillInput, cast: StillCastMember[]): VisualCheck[] {
  const { shot, spec, look } = input;
  const ids = [...(shot.cast ?? []), ...cast.map((m) => m.id).filter((x): x is string => !!x)];
  const checks = visualChecks(spec, { covers: shot.covers ?? [], cast: ids }, look);
  for (const m of cast) if (!m.id || !spec) checks.push(castCheck(m));
  const drawnFrom = cast.filter((m) => input.refs.some((r) => norm(r.label) === norm(m.name)));
  for (const m of drawnFrom) checks.push(identityCheck(m, drawnFrom.length));
  // Without a spec, a picture whose sentence quotes words to be read ("a sign reading 'OPEN 24H'") is not held to
  // "no text": the bench's smoke run redrew exactly that sign twice for failing it (24 September 2026).
  if (!spec && !/["“”«»]|\b(?:reading|reads|says|labelled|labeled|titled|written)\b/i.test(shot.image_prompt)) checks.push(noTextCheck);
  checks.push(logicCheck);
  const seen = new Set<string>();
  return checks.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

/**
 * A failed check turned into what the picture MUST do, in positive words: "the chef's apron is lilac", not "the
 * apron was not lilac". These go first in the next try's prompt, after "It is essential that:".
 */
export function feedbackFor(failed: readonly VisualCheck[], spec: RequestSpec | null, look: StillLook): string[] {
  return failed.map((c) => {
    if (c.id === "style") return look === "animation" ? "the picture is a drawn 2D animation frame, not a photograph and not a 3D render" : "the picture is a real photograph, not a drawing, a painting or a 3D render";
    if (c.id === "no-text") return "there is no text, lettering, caption or watermark anywhere";
    if (c.id === "logic") return "everything in the picture makes physical and logical sense: every tool is used for its real purpose at the right moment (no whisk on a cake that is already finished), every action is possible, nothing floats or merges";
    if (c.id.startsWith("identity:")) {
      const name = c.question.split(`${identityQuestionPrefix} `)[1]?.replace(/\s*\(same face.*$/, "") || "the character";
      return `${name} is exactly the same person as in their reference image, with the same face, the same hair and the same clothes`;
    }
    if (c.id.startsWith("exclude:")) {
      const it = spec ? itemById(spec, c.id.slice(8)) : undefined;
      return `none of this is visible anywhere: ${stripNegation(it?.text ?? c.question.replace(/^Does the image show any of this:\s*/i, "").replace(/\?$/, ""))}`;
    }
    if (c.id.startsWith("cast:")) {
      const m = spec ? castById(spec, c.id.slice(5)) : undefined;
      return m && spec ? `${m.name} looks exactly like this: ${fullLook(spec, m.id)}` : `the character looks exactly like this: ${c.question.replace(/^Is there a character matching this description:\s*/i, "").replace(/\?$/, "")}`;
    }
    const it = spec ? itemById(spec, c.id) : undefined;
    if (it?.kind === "text") return `these words are written clearly and legibly, spelled exactly: ${it.text.replace(/[.\s]+$/, "")}`;
    if (it?.kind === "style") return `the picture is in this style: ${it.text.replace(/[.\s]+$/, "")}`;
    if (it) return `the picture clearly shows ${it.text.replace(/[.\s]+$/, "")}`;
    return `the picture clearly shows ${c.question.replace(/^(?:Does the image show this|Is the image in this style|Could this image be a moment of this):\s*/i, "").replace(/^Does the image show\s+/i, "").replace(/\?$/, "")}`;
  }).filter(Boolean);
}

/**
 * THE PROMPT COMPILER. One still, as a long structured English prompt, most important first:
 *   1. what an earlier try got wrong ("It is essential that: …"), when there was one;
 *   2. the framing the shot kind asks for, and the frame's orientation;
 *   3. the author's image_prompt;
 *   4. every character in it, "NAME (reference image N): full look" — the user's words, uncut;
 *   5. the other reference images (a place, an object, a style the user gave);
 *   6. the place (the direction's world), the treatment's visual sentence;
 *   7. the exact words of every on-screen text the shot must carry;
 *   8. the look's style sentence and the spec's style items;
 *   9. "no text anywhere" unless the shot carries a text, and "without …" for everything the user excluded.
 * Past STILL_PROMPT_MAX the visual sentence, the world and the looks are shortened in that order, never the feedback,
 * the framing or the author's sentence. Returns the prompt, the size, and the yes/no checks the result is judged by.
 */
export function compileStill(input: StillInput, feedback: string[] = []): { prompt: string; width: number; height: number; checks: VisualCheck[] } {
  const { shot, spec, direction, look } = input;
  const format: StillFormat = input.format === "16:9" ? "16:9" : "9:16";
  const size = STILL_SIZES[format];
  const cast = stillCast(shot, spec, direction);
  const refIndex = (label: string) => input.refs.findIndex((r) => norm(r.label) === norm(label));
  const covered = spec ? (shot.covers ?? []).map((id) => itemById(spec, id)).filter((x): x is SpecItem => !!x) : [];
  const texts = covered.filter((i) => i.kind === "text");
  const castNames = new Set(cast.map((m) => norm(m.name)));
  const otherRefs = input.refs.map((r, i) => ({ r, i })).filter(({ r }) => !castNames.has(norm(r.label)));
  const world = clean(direction?.world) || (spec ? covered.filter((i) => i.kind === "place").map((i) => i.text).join("; ") : "");
  const styleItems = spec ? spec.items.filter((i) => i.kind === "style" && i.must).map((i) => i.text.replace(/[.\s]+$/, "")) : [];
  const excludes = [
    ...(spec ? spec.items.filter((i) => i.kind === "exclude").map((i) => stripNegation(i.text)) : []),
    ...(direction?.forbidden ?? []).slice(0, 6).map(stripNegation),
  ].filter(Boolean);
  const kind = String(shot.shot_kind ?? "");

  const build = (lim: { look: number; world: number; visual: number }): string => [
    feedback.length ? `It is essential that: ${feedback.map((f) => f.replace(/[.\s]+$/, "")).join("; ")}.` : "",
    `${FRAMING[kind] ?? DEFAULT_FRAMING}, ${format === "16:9" ? "horizontal 16:9 frame" : "vertical 9:16 frame"}.`,
    sentence(shot.image_prompt),
    ...cast.map((m) => { const k = refIndex(m.name); return sentence(`${m.name}${k >= 0 ? ` (reference image ${k + 1})` : ""}: ${cut(clean(m.look), lim.look)}`); }),
    ...otherRefs.map(({ r, i }) => sentence(`As in reference image ${i + 1}: ${clean(r.label)}`)),
    world && lim.world > 0 ? sentence(`Setting: ${cut(world, lim.world)}`) : "",
    input.visual && lim.visual > 0 ? sentence(`Visual language: ${cut(clean(input.visual), lim.visual)}`) : "",
    // The words sit ON something (probe gt_62bvh7ay: "SURPRISE" floated in the air beside the friend instead of being
    // written on the note he holds).
    ...texts.map((t) => sentence(`Written clearly and legibly ON an object in the scene (a note, a sign, a label, a cake, a screen), spelled exactly as given, never floating in the air: ${t.text}`)),
    STYLE_SENTENCE[look],
    LOGIC_SENTENCE,
    styleItems.length ? sentence(`Style: ${styleItems.join("; ")}`) : "",
    texts.length ? "" : NO_TEXT_SENTENCE,
    excludes.length ? sentence(`Without ${excludes.join(", without ")}`) : "",
  ].filter(Boolean).join(" ");

  const stages = [
    { look: 420, world: 300, visual: 420 },
    { look: 420, world: 200, visual: 200 },
    { look: 300, world: 160, visual: 0 },
    { look: 220, world: 120, visual: 0 },
    { look: 160, world: 0, visual: 0 },
  ];
  let prompt = "";
  for (const s of stages) { prompt = build(s); if (prompt.length <= STILL_PROMPT_MAX) break; }
  if (prompt.length > STILL_PROMPT_MAX) prompt = prompt.slice(0, STILL_PROMPT_MAX);
  return { prompt, width: size.width, height: size.height, checks: checksFor(input, cast) };
}

/* ------------------------------------------------------------------ the model call */

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); })]); }
  finally { if (t) clearTimeout(t); }
}

/** What a draw needs of the environment: the Workers AI binding, and the keys of the two external roads. */
export type DrawEnv = Pick<Env, "AI" | "IMAGE_API_URL" | "IMAGE_API_KEY" | "PLAN_API_URL" | "PLAN_API_KEY" | "KIE_API_KEY" | "EPHONE_API_KEY" | "EPHONE_API_URL">;
/** A reference as a draw takes it: the bytes, and a public URL when one was signed (kie.ai takes nothing else). */
export interface DrawRef extends VisionImage { url?: string | null }
/** One picture drawn: its bytes, what it cost, and whether that figure came from the provider (else stillPriceUsd). */
export interface DrawnImage { bytes: Uint8Array; usd: number; reported: boolean }

/**
 * An external road's refusal, with the HTTP (or unified-API) status it came with — which is what fallbackReason reads
 * for money — and the dollars the provider billed for it when it said (a text-only answer is still billed tokens).
 * The status is written into the message too, so isTransientError reads a 429 or a 5xx as "not now", as for Workers AI.
 * Plain class fields, no parameter properties: the tests load this module under Node's type stripping.
 */
export class StillDrawError extends Error {
  status: number;
  provider: StillProvider;
  usd: number;
  constructor(message: string, status: number, provider: StillProvider, usd = 0) {
    super(message);
    this.name = "StillDrawError";
    this.status = status;
    this.provider = provider;
    this.usd = usd;
  }
}

/**
 * WHETHER A REFUSAL IS ABOUT MONEY (25 September 2026), and which: "no credit" (HTTP or kie.ai code 402, or kie.ai's
 * own "Credits insufficient" sentence, which came back as code 500 on 13 September — src/kie.ts isNoCredit),
 * "unauthorized" (401/403, or no key configured for the road), "model unavailable" (OpenRouter's 404: the model id is
 * not served). Such a refusal will not change within the minutes a film waits, so the job falls back
 * (STILL_MODEL_FALLBACK) instead of pausing on it or giving the picture up. Null for anything else: a 429, a 5xx and a
 * timeout keep the pause semantics (stillsErrorVerdict), a refusal of the prompt keeps the retry-without-references.
 */
export function fallbackReason(e: unknown): "no credit" | "unauthorized" | "model unavailable" | "budget" | null {
  // A cap of this server (STILLS_JOB_MAX_USD, STILLS_DAILY_USD): the provider was never asked.
  if (e instanceof StillDrawError && e.status === 402 && /stills budget/.test(e.message)) return "budget";
  if (isTaskFailure(e)) return null; // a task that ran and failed is about the picture, never the account
  if (isNoCredit(e)) return "no credit";
  const status = e instanceof KieError || e instanceof StillDrawError ? e.status : 0;
  if (status === 402) return "no credit";
  // OpenRouter answers 403 for an input its moderation refused: that is the picture's problem (flagged), not the key's.
  if (e instanceof StillDrawError && status === 403 && isFlaggedError(e)) return null;
  if (status === 401 || status === 403) return "unauthorized";
  if (e instanceof StillDrawError && status === 404) return "model unavailable";
  if (e instanceof KieError && status === 505) return "model unavailable"; // kie.ai: "feature disabled"
  if (e instanceof KieError && /KIE_API_KEY is not set/.test(e.message)) return "unauthorized";
  return e instanceof KieError || e instanceof StillDrawError ? (/insufficient (?:credits?|balance|funds)|payment required|credits? insufficient/i.test(e.message) ? "no credit" : null) : null;
}

/**
 * A kie.ai task that RAN and failed (state "fail"; 25 September 2026). Its failMsg is free text — "internal error
 * 500", "generation timed out" — which the generic reader of "not now" (src/images.ts isTransientError) would take for
 * a pause; and a paused picture resumes the SAME task on the next tick (KieLedger), reads the same failure, and pauses
 * again until the give-up. So a failed task is never transient here: it is a failed try, and the next seed is drawn.
 */
export const isTaskFailure = (e: unknown): boolean => !!e && typeof e === "object" && (e as { taskFailed?: unknown }).taskFailed === true;
/** "Not now" for this engine: isTransientError, except a kie.ai task that ran and failed (isTaskFailure). */
export const isTransientStillError = (e: unknown): boolean => !isTaskFailure(e) && isTransientError(e);

/** The dollars an error says were spent before it (StillDrawError.usd, or what drawJudged attached), else 0. */
export const spentOn = (e: unknown): number => {
  const u = e && typeof e === "object" ? (e as { usd?: unknown }).usd : undefined;
  return typeof u === "number" && Number.isFinite(u) && u > 0 ? u : 0;
};

/**
 * ONE DRAW, on the road its model id names (25 September 2026; see stillProviderOf):
 *   - "@cf/…" (and any id without a prefix): Workers AI, as before — below;
 *   - "openrouter:<vendor/model>": OpenRouter's chat completions (drawOpenRouter);
 *   - "kie:<model>": kie.ai's createTask, then recordInfo every few seconds (drawKie).
 * Every road answers a PNG or JPEG with what it cost, and throws on a refusal: fallbackReason says whether it was
 * about money, isTransientError whether it was "not now", isFlaggedError whether the picture itself was refused.
 * `until` is the caller's deadline (drawJudged's): only the kie.ai road, which waits on a task, reads it.
 *
 * WORKERS AI. The binding takes the FLUX.2 models as a MULTIPART body (Cloudflare's own example: a FormData with
 * prompt, width, height and input_image_0..3, turned into a stream and its content type through a Request, then
 * env.AI.run(model, { multipart: { body, contentType } })); the answer is {image: base64}. Throws on a missing binding,
 * a timeout, or an answer that is not a PNG/JPEG.
 */
export async function drawImage(env: DrawEnv, model: string, prompt: string, size: { width: number; height: number }, refs: DrawRef[], seed: number, opts: { until?: number; ledger?: { key: string; book: KieLedger } } = {}): Promise<DrawnImage> {
  const road = stillProviderOf(model);
  if (road.provider === "openrouter") return drawBooked(model, "openrouter", size, opts.ledger, () => drawOpenRouter(env, model, road.id, prompt, size, refs, seed));
  if (road.provider === "ephone") return drawBooked(model, "ephone", size, opts.ledger, () => drawOpenRouter(env, model, road.id, prompt, size, refs, seed, EPHONE_ROAD));
  if (road.provider === "kie") return drawKie(env, model, road.id, prompt, size, refs, opts.until, opts.ledger);
  const ai = env.AI as unknown as AiRunner | undefined;
  if (!ai) throw new Error("no Workers AI binding (env.AI)");
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", String(size.width));
  form.append("height", String(size.height));
  form.append("seed", String(Math.abs(Math.round(seed)) % 2_147_483_647));
  refs.slice(0, MAX_INPUT_IMAGES).forEach((img, i) => {
    const type = img.mime ?? mimeOf(img.bytes);
    const copy = img.bytes.buffer.slice(img.bytes.byteOffset, img.bytes.byteOffset + img.bytes.byteLength) as ArrayBuffer;
    form.append(`input_image_${i}`, new Blob([copy], { type }), `ref${i}.${type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg"}`);
  });
  const req = new Request("http://kleo.internal/still", { method: "POST", body: form });
  const res = await withTimeout(ai.run(model, { multipart: { body: req.body, contentType: req.headers.get("content-type") ?? "multipart/form-data" } }), DRAW_TIMEOUT_MS, `still draw (${model})`);
  const bytes = await readImageResult(res);
  if (!sniffImage(bytes)) throw new Error(`model returned ${bytes.length} bytes that are neither PNG nor JPEG`);
  return { bytes, usd: stillPriceUsd(model, size) ?? 0, reported: false };
}

/**
 * THE MONEY CAPS ON THE CHAT ROADS (26 September 2026, the owner's cost report). Until today STILLS_JOB_MAX_USD and
 * STILLS_DAILY_USD bounded the kie.ai road only: a film drawing on ePhone AI (Nano Banana Pro, production since 25
 * September) or on OpenRouter spent without a ceiling. Now every paid chat draw is booked on the same ledger (KieLedger)
 * the kie.ai tasks use: the cap is checked and reserved BEFORE the call (`refuse`: past it the draw throws the same
 * "stills budget" refusal, fallbackReason reads "budget" and the job moves to STILL_MODEL_FALLBACK), and what the call
 * cost is written down after it as a "stills.task" row with no task id (nothing to collect: a chat answer is the
 * picture). A refusal that says what it cost is booked at that; a call that may have been billed without answering (a
 * timeout, a dropped connection) at the table's price, like kie.ai's lost createTask. No ledger: the draw as before.
 */
async function drawBooked(model: string, provider: StillProvider, size: { width: number; height: number }, ledger: { key: string; book: KieLedger } | undefined, draw: () => Promise<DrawnImage>): Promise<DrawnImage> {
  if (!ledger) return draw();
  const price = stillPriceUsd(model, size) ?? 0;
  const no = ledger.book.refuse(price);
  if (no) throw new StillDrawError(`still draw (${model}): stills budget: ${no}`, 402, provider);
  const book = async (usd: number) => {
    if (usd > 0) { try { await ledger.book.created(ledger.key, "", model, round4(usd)); } catch { /* the reservation of this call still holds it */ } }
  };
  let r: DrawnImage;
  try { r = await draw(); }
  catch (e) {
    await book(spentOn(e) || (!(e instanceof StillDrawError) && isTransientError(e) ? price : 0));
    throw e;
  }
  await book(r.usd);
  return r;
}

/** A fetch that did not answer, in the words isTransientError reads as "not now": a timeout, or a network error. */
function roadError(model: string, e: unknown, ms: number): Error {
  const s = `${(e as { name?: unknown } | null)?.name ?? ""} ${String(e)}`;
  return /abort|timeout/i.test(s) ? new Error(`still draw (${model}) timed out after ${ms} ms`) : new Error(`still draw (${model}): network error: ${String(e).slice(0, 200)}`);
}
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
/** A finished picture never weighs more than this (a 2K PNG is 6-8 MB); past it the download is refused, not read. */
const IMAGE_MAX_BYTES = 40 * 1024 * 1024;
const IMAGE_DOWNLOAD_MS = 30_000;

/** The bytes of a picture a road answered: a data: URL decoded, or an https URL downloaded (bounded in time and size). */
async function pictureBytes(model: string, url: string): Promise<Uint8Array> {
  const d = /^data:image\/[a-z0-9.+-]+;base64,(.*)$/is.exec(url);
  if (d) return base64ToBytes(d[1].replace(/\s+/g, ""));
  let res: Response;
  try { res = await fetch(url, { headers: { "user-agent": "kleo-mcp/1.0" }, signal: AbortSignal.timeout(IMAGE_DOWNLOAD_MS) }); }
  catch (e) { throw roadError(model, e, IMAGE_DOWNLOAD_MS); }
  // A plain Error, not a StillDrawError: a 403 on an expired result link is not the account's money.
  if (!res.ok) { try { await res.body?.cancel(); } catch { /* dropped */ } throw new Error(`still draw (${model}): the picture's download answered HTTP ${res.status}`); }
  let bytes: Uint8Array | null;
  try { bytes = await readBodyCapped(res.body, IMAGE_MAX_BYTES); } catch (e) { throw roadError(model, e, IMAGE_DOWNLOAD_MS); }
  if (!bytes) throw new Error(`still draw (${model}): the picture is larger than ${IMAGE_MAX_BYTES} bytes`);
  return bytes;
}

/**
 * Where OpenRouter put the picture in a chat answer: message.images[].image_url.url (the shape measured on 25
 * September 2026, a data:image/png;base64 URL), else an image part of message.content, else a data URL written into
 * the text. Null when the answer carries no picture at all (a refusal in words).
 */
export function openRouterImageUrl(message: Record<string, unknown>): string | null {
  const pick = (x: unknown): string | null => {
    const o = obj(x);
    const u = typeof o.image_url === "string" ? o.image_url : obj(o.image_url).url ?? o.url;
    if (typeof u === "string" && /^(?:data:image\/|https:\/\/)/i.test(u)) return u;
    return typeof o.b64_json === "string" && o.b64_json ? `data:image/png;base64,${o.b64_json}` : null;
  };
  for (const list of [message.images, message.content]) if (Array.isArray(list)) for (const x of list) { const u = pick(x); if (u) return u; }
  if (typeof message.content === "string") { const m = /data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+/.exec(message.content); if (m) return m[0]; }
  return null;
}

/**
 * THE OPENROUTER ROAD (25 September 2026): one chat completion with modalities ["image","text"], the prompt first and
 * the references after it as data: URLs (in the order compileStill numbers them: "reference image 1" is the first),
 * image_config.aspect_ratio from the size, and for a Gemini model image_config.image_size "1K" (the tier measured;
 * a 2K PNG would travel inline to the judge and to every later draw). Measured that day with google/gemini-3-pro-image-preview (Nano Banana Pro): 23 s, 768x1376 at 1K,
 * usage.cost 0.138 $, the picture in choices[0].message.images[0].image_url.url. Base URL IMAGE_API_URL, then
 * PLAN_API_URL, then OpenRouter's; key IMAGE_API_KEY, then PLAN_API_KEY (the same headers the planner sends).
 * An answer with no picture is a refusal ("flagged": drawJudged draws the next seed, and after two drops the
 * references, which is what a model that will not draw a real person's photo needs).
 */
/**
 * THE ePhone AI ROAD (25 September 2026, the owner: "do everything with ePhone"): the same OpenAI-compatible chat
 * completion as OpenRouter's, on ePhone's base URL with EPHONE_API_KEY, routed to the "official_cheap" provider first
 * (the gemini-official-cheap group, ratio 0.53: Nano Banana Pro ≈ $0.074 at 1K against kie.ai's $0.09), then the
 * official one. Measured the same day: 18 s, a 1376x768 JPEG for aspect 16:9 at 1K, returned as a data: URL inside
 * message.content (openRouterImageUrl reads it); usage carries tokens, not dollars, so the price table counts.
 */
interface ChatRoad { provider: StillProvider; base: (env: DrawEnv) => string; key: (env: DrawEnv) => string; headers: Record<string, string>; keyName: string }
const EPHONE_ROAD: ChatRoad = {
  provider: "ephone", base: (env) => `${ephoneBase(env)}/v1`, key: (env) => (env.EPHONE_API_KEY ?? "").trim(),
  headers: { "X-Provider-Order": "official_cheap,official" }, keyName: "EPHONE_API_KEY",
};
async function drawOpenRouter(env: DrawEnv, model: string, id: string, prompt: string, size: { width: number; height: number }, refs: DrawRef[], seed: number, road?: ChatRoad): Promise<DrawnImage> {
  const provider: StillProvider = road?.provider ?? "openrouter";
  const key = road ? road.key(env) : (env.IMAGE_API_KEY || env.PLAN_API_KEY || "").trim();
  if (!key) throw new StillDrawError(`still draw (${model}): no ${road ? road.keyName : "IMAGE_API_KEY (nor PLAN_API_KEY)"} is set`, 401, provider);
  const base = road ? road.base(env) : (env.IMAGE_API_URL || env.PLAN_API_URL || DEFAULT_IMAGE_API_URL).trim().replace(/\/+$/, "");
  const body = {
    model: id,
    modalities: ["image", "text"],
    // 1K for every Gemini picture (25 September 2026): the one size measured (768x1376, 0.138 $), already the still's
    // size; a 2K PNG is 6-8 MB, sent back inline to the judge and to every later draw as a data: URL.
    image_config: { aspect_ratio: aspectRatioOf(size), ...(/gemini/i.test(id) ? { image_size: "1K" } : {}) },
    messages: [{ role: "user", content: [
      { type: "text", text: prompt },
      ...refs.slice(0, MAX_INPUT_IMAGES).map((r) => ({ type: "image_url", image_url: { url: `data:${r.mime ?? mimeOf(r.bytes)};base64,${toBase64(r.bytes)}` } })),
    ] }],
    seed: Math.abs(Math.round(seed)) % 2_147_483_647,
  };
  let res: Response, text: string;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "HTTP-Referer": "https://mcp.kleooai.com", "X-Title": "Kleo", ...(road?.headers ?? {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(DRAW_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (e) { throw roadError(model, e, DRAW_TIMEOUT_MS); }
  let j: Record<string, unknown> | null = null;
  try { j = obj(JSON.parse(text)); } catch { /* read below */ }
  const cost = typeof obj(j?.usage).cost === "number" && Number.isFinite(obj(j?.usage).cost) ? (obj(j?.usage).cost as number) : null;
  const err = obj(j?.error);
  if (!res.ok || !j || Object.keys(err).length) {
    // A 200 with an error object carries its own code (OpenRouter's 402 arrives that way too); an unreadable 200 is a
    // gateway hiccup, answered as one.
    let status = !res.ok ? res.status : Number(err.code) || (j ? res.status : 502);
    const say = String(err.message ?? (j ? JSON.stringify(j) : text)).replace(/\s+/g, " ").slice(0, 240);
    // ePhone's empty account ("insufficient_user_quota", HTTP 403) is money, not a refused key.
    if (EPHONE_NO_MONEY_RE.test(say) || EPHONE_NO_MONEY_RE.test(String(err.code ?? ""))) status = 402;
    // A 403 for moderated input is a refused picture (the next seed, then no references), not a refused key.
    const flag = status === 403 && /moderat|flagged|safety/i.test(say) && !/flagged/i.test(say) ? " (flagged)" : "";
    throw new StillDrawError(`still draw (${model}) → ${provider} ${status}: ${say}${flag}`, status, provider, cost ?? 0);
  }
  const choice = obj(Array.isArray(j.choices) ? j.choices[0] : null);
  const message = obj(choice.message);
  const url = openRouterImageUrl(message);
  if (!url) {
    const said = typeof message.content === "string" ? message.content.replace(/\s+/g, " ").slice(0, 200) : "";
    throw new StillDrawError(`still draw (${model}) answered without a picture, refused or flagged (finish_reason ${String(choice.finish_reason ?? "?")}): ${said}`, 200, provider, cost ?? 0);
  }
  const bytes = await pictureBytes(model, url);
  if (!sniffImage(bytes)) throw new Error(`model returned ${bytes.length} bytes that are neither PNG nor JPEG`);
  return { bytes, usd: cost ?? stillPriceUsd(model, size) ?? 0, reported: cost !== null };
}

/**
 * How the kie.ai road waits on a task (25 September 2026): a first look after `firstMs` (Nano Banana Pro is never
 * done sooner, and every look is a subrequest of the cron's budget), then one every `everyMs`, for at least `minMs` —
 * the DRAW_TIMEOUT_MS every other road gets — and at most `maxMs`, stretched between the two as far as the caller's
 * deadline (`until`) allows. A task still running at the end is not lost: the ledger (KieLedger) collects it on the
 * next tick. Mutable for the tests only.
 */
export const KIE_STILL_POLL = { firstMs: 10_000, everyMs: 4_000, minMs: DRAW_TIMEOUT_MS, maxMs: 150_000 };
/** One createTask or recordInfo call may take this long before it counts as a timeout. */
const KIE_CALL_MS = 20_000;
/** kie.ai's words for a picture its filters refused: marked "(flagged)" so drawJudged draws the next seed. */
const KIE_FLAG_RE = /safety|policy|sensitive|nsfw|flagged|prohibited|violat|inappropriate|moderat/i;
/** kie.ai's words for a task that could not read its reference images: the one failure a draw without them may cure. */
export const KIE_REFS_TROUBLE_RE = /image_input|input image|image url|reference|download|fetch|unreachable|could not (?:load|read|open|access)|invalid (?:image|url)/i;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * THE LEDGER OF KIE.AI TASKS (25 September 2026, review of the Nano Banana switch). A kie.ai task is paid for when it
 * is CREATED, and a picture may outlive the window a tick waits for it (a slow queue, a tick that ends). Without a
 * record the next tick drew that picture again from scratch: a second task, a second payment, the first one thrown
 * away. So every task is written down the moment kie.ai answers its id ("stills.task": the draw's key, the task id,
 * the price), and a draw with the same key — the same picture, model, seed and prompt — collects that task instead of
 * creating a new one, for KIE_TASK_RESUME_MIN. The same rows are the money caps: `refuse` says why one more task would
 * cross STILLS_JOB_MAX_USD or STILLS_DAILY_USD, and the draw then falls back like after a refusal for money.
 */
export interface KieLedger {
  /** The task created for this key less than KIE_TASK_RESUME_MIN ago, or null. */
  find(key: string): string | null;
  /** Why one more task of `usd` may not be created (a cap), or null when it may. */
  refuse(usd: number): string | null;
  /** Writes a created task down (its audit row, and the running sums of the caps). */
  created(key: string, task: string, model: string, usd: number): Promise<void>;
}

/**
 * The `input` of a kie.ai image task (docs.kie.ai/market/google/pro-image-to-image and …/nanobanana2, read 25
 * September 2026): nano-banana-pro and nano-banana-2 take prompt (≤ 10,000 / 20,000 chars), image_input (URLs, up to
 * 8 / 14), aspect_ratio, resolution 1K|2K|4K and output_format png|jpg; nano-banana-2-lite takes image_urls and no
 * resolution. JPEG on purpose: a 2K PNG is 6-8 MB, and every still also goes to the vision judge (and back as a
 * reference) inline; a 2K JPEG is a fraction of that, with no visible loss for the first frame of a clip.
 */
export function kieStillInput(id: string, p: { prompt: string; urls: string[]; size: { width: number; height: number } }): Record<string, unknown> {
  const aspect = aspectRatioOf(p.size);
  if (/-lite$/.test(id)) return { prompt: p.prompt, image_urls: p.urls, aspect_ratio: aspect };
  return { prompt: p.prompt.slice(0, 10_000), image_input: p.urls, aspect_ratio: aspect, resolution: imageTierOf(p.size), output_format: "jpg" };
}

/**
 * THE KIE.AI ROAD (25 September 2026): createTask (or, when the ledger holds a task for this very draw, that task),
 * then recordInfo — a first look after KIE_STILL_POLL.firstMs, then every everyMs — until "success" (the picture
 * downloaded from resultJson.resultUrls[0], its cost read off creditsConsumed at 0.005 $ a credit) or "fail".
 *
 * What each ending means to the job:
 *   - success: the picture and what it cost; a task collected from an earlier tick costs 0 here (its price was counted
 *     when that tick gave up waiting on it);
 *   - fail: a failed TRY (isTaskFailure), never a pause and never the account: the next seed is drawn; marked
 *     "(flagged)" when kie.ai names a policy; its code is written as [code_N], which no reader takes for an HTTP 5xx;
 *   - out of time, or a result that could not be fetched: a pause ("temporarily"/"timed out"), carrying the price of a
 *     task created here — the next tick collects the same task through the ledger, it does not buy another;
 *   - a recordInfo hiccup (a 429, a 5xx, a 404 or 422 before the task is visible, a dropped connection) is asked again
 *     within the window: the task is paid for either way.
 *
 * THE REFERENCES reach kie.ai only as public links: image_input takes "file URLs, not file content". drawJobStills
 * signs one for every sheet, user picture and style anchor (signedFileUrl, through /dl). A reference with bytes only —
 * the pure drawStill / drawCastSheet road the tests and the fidelity bench use — is simply not passed; drawJudged
 * leaves it out of the prompt and of the identity checks as well (usableRefs), so the prompt never names an image the
 * model does not get.
 */
async function drawKie(env: DrawEnv, model: string, id: string, prompt: string, size: { width: number; height: number }, refs: DrawRef[], until?: number, ledger?: { key: string; book: KieLedger }): Promise<DrawnImage> {
  if (!(env.KIE_API_KEY ?? "").trim()) throw new StillDrawError(`still draw (${model}): KIE_API_KEY is not set`, 401, "kie");
  const urls = refs.map((r) => r.url).filter((u): u is string => typeof u === "string" && /^https:\/\//i.test(u)).slice(0, MAX_INPUT_IMAGES);
  const price = stillPriceUsd(model, size) ?? 0;
  const t0 = Date.now();
  let taskId = ledger ? ledger.book.find(ledger.key) : null;
  const resumed = !!taskId;
  if (!taskId) {
    const no = ledger ? ledger.book.refuse(price) : null;
    if (no) throw new StillDrawError(`still draw (${model}): stills budget: ${no}`, 402, "kie");
    let created: { taskId?: string } | undefined;
    try { created = await kie<{ taskId?: string }>(env, "POST", KIE_CREATE, { model: id, input: kieStillInput(id, { prompt, urls, size }) }, { timeoutMs: KIE_CALL_MS }); }
    catch (e) {
      // A createTask that timed out may have created (and billed) a task whose id never came back: counted as spent.
      if (!(e instanceof KieError) && isTransientError(e)) {
        if (ledger) { try { await ledger.book.created(`${ledger.key}#lost`, "", model, price); } catch { /* the cap of this call still holds it */ } }
        throw withSpend(roadError(model, e, KIE_CALL_MS), price);
      }
      throw e;
    }
    taskId = created?.taskId ?? null;
    if (!taskId) throw new KieError(`still draw (${model}): kie.ai answered without a taskId`, 0, false);
    if (ledger) { try { await ledger.book.created(ledger.key, taskId, model, price); } catch { /* a lost row only loses the resume */ } }
  }
  // The price of a task created here, carried by every error after it (a task collected from an earlier tick was
  // counted when that tick gave up on it).
  const owed = resumed ? 0 : price;
  const paused = (why: string): Error => withSpend(new Error(`still draw (${model}): kie.ai task ${taskId} ${why}, temporarily`), owed) as Error;
  const stopAt = Math.min(t0 + KIE_STILL_POLL.maxMs, Math.max(until ?? 0, t0 + KIE_STILL_POLL.minMs));
  let state = "";
  for (let look = 0; ; look++) {
    const wait = Math.min(look === 0 ? KIE_STILL_POLL.firstMs : KIE_STILL_POLL.everyMs, stopAt - Date.now());
    if (wait <= 0) break;
    await sleep(wait);
    let rec: KieRecord;
    try { rec = await kie<KieRecord>(env, "GET", `${KIE_RECORD}?taskId=${encodeURIComponent(taskId)}`, undefined, { timeoutMs: KIE_CALL_MS }); }
    catch (e) {
      if ((e instanceof KieError && (e.retryable || e.status === 404 || e.status === 422)) || (!(e instanceof KieError) && isTransientError(e))) continue;
      throw withSpend(e, owed);
    }
    state = String(rec?.state ?? "").toLowerCase();
    if (state === "success") {
      const results = kieResultUrls(rec);
      if (!results.length) throw paused("succeeded without a result url");
      let bytes: Uint8Array;
      try { bytes = await pictureBytes(model, results[0]); }
      catch (e) { throw paused(`succeeded, but its picture could not be fetched (${String(e).slice(0, 160)})`); }
      if (!sniffImage(bytes)) throw paused(`succeeded, but its result is ${bytes.length} bytes that are neither PNG nor JPEG`);
      const credits = Number(rec.creditsConsumed);
      const reported = Number.isFinite(credits) && credits > 0;
      if (resumed) return { bytes, usd: 0, reported: false };
      return { bytes, usd: reported ? round4(credits * USD_PER_KIE_CREDIT) : price, reported };
    }
    if (state === "fail" || state === "failed" || state === "error") {
      const code = String(rec.failCode ?? "").replace(/[^0-9A-Za-z_-]/g, "").slice(0, 12);
      const why = String(rec.failMsg ?? "kie.ai reported a failure").replace(/\s+/g, " ").trim().slice(0, 240);
      const err = new KieError(`still draw (${model}): kie.ai task ${taskId} failed${code ? ` [code_${code}]` : ""}: ${why}${KIE_FLAG_RE.test(why) ? " (flagged)" : ""}`, 0, false);
      throw Object.assign(err, { taskFailed: true });
    }
  }
  throw withSpend(new Error(`still draw (${model}) timed out after ${Date.now() - t0} ms (kie.ai task ${taskId} still ${state || "pending"})`), owed);
}

/* ------------------------------------------------------------------ the route: which model, and what after a refusal for money */

/**
 * THE ROUTE of a job's pictures (25 September 2026): the model every try draws with, the escalation model of the last
 * try, and what replaces a model whose provider refused for money. One object is shared by every sheet and still of a
 * drawJobStills call (three draws run at once), so the first refusal switches the whole job and the others follow;
 * the switch is an audit row, and the next tick replays those rows before it draws (the rest of the job stays on the
 * fallback, it does not ask the empty account again on every tick). `ladder` is the escalation the fallback model
 * brings with it (klein-4B → klein-9B, unless STILL_MODEL_STRONG says otherwise). A route built for a forced model
 * (the bench's opts.model) has no fallback: a model under comparison is never swapped silently.
 */
export interface StillRoute {
  model: string;
  strong: string | null;
  fallback: string | null;
  ladder: string | null;
  /** Providers that refused for money in this job: never asked again. */
  dead: StillProvider[];
  /** The switches made, in order. */
  switches: { from: string; to: string; reason: string; error: string }[];
  /** Called once per switch (drawJobStills writes the "stills.fallback" audit row). */
  onFallback?: (f: { from: string; to: string; reason: string; error: string }) => unknown;
  /** kie.ai tasks that ran and failed in a row across the job's draws (a success resets it): see TASK_FAILS_TO_FALL_BACK. */
  taskFails?: number;
}
/**
 * A kie.ai OUTAGE (25 September 2026, second review): tasks that run and fail one after the other ("internal error",
 * "overloaded") are not about any one picture. Each is a failed try, and a still whose every try failed was given up
 * for good — the GPU's SDXL drew it. After this many task failures in a row, across the job, the route falls back
 * (switchRoute, "model unavailable") and the try is drawn again on STILL_MODEL_FALLBACK.
 */
export const TASK_FAILS_TO_FALL_BACK = 2;
export function stillRoute(env: Pick<Env, "STILL_MODEL" | "STILL_MODEL_STRONG" | "STILL_MODEL_FALLBACK">, opts: { model?: string } = {}): StillRoute {
  if (opts.model) return { model: opts.model, strong: null, fallback: null, ladder: null, dead: [], switches: [] };
  const fallback = fallbackStillModel(env);
  return {
    model: stillModel(env), strong: strongStillModel(env), fallback,
    ladder: fallback ? strongStillModel({ STILL_MODEL: fallback, STILL_MODEL_STRONG: env.STILL_MODEL_STRONG }) : null,
    dead: [], switches: [],
  };
}

/**
 * Switches a route away from the provider of `failed` after a refusal for money, and answers the model to draw the
 * failed try with now (null: no fallback — the error stands). The replacement is STILL_MODEL_FALLBACK, or klein-4B
 * when the fallback sits on the same dead provider; an escalation model on that provider is dropped (and the fallback's
 * own ladder takes its place). Idempotent: a second refusal from the same provider (another draw of the same tick, or
 * the replay of the audit on the next tick) changes nothing more and writes no second row. `silent` replays.
 */
export async function switchRoute(route: StillRoute, failed: string, asStrong: boolean, reason: string, error: unknown, opts: { silent?: boolean } = {}): Promise<string | null> {
  if (!route.fallback) return null;
  const provider = stillProviderOf(failed).provider;
  const first = !route.dead.includes(provider);
  if (first) route.dead.push(provider);
  const alive = (m: string | null): m is string => !!m && !route.dead.includes(stillProviderOf(m).provider);
  const pick = [route.fallback, DEFAULT_STILL_MODEL].find(alive) ?? null;
  if (!pick) return null;
  if (!alive(route.model)) route.model = pick;
  if (route.strong && !alive(route.strong)) route.strong = null;
  if (!route.strong && route.model === pick && alive(route.ladder) && route.ladder !== pick) route.strong = route.ladder;
  const to = asStrong ? route.strong ?? route.model : route.model;
  if (first) {
    const f = { from: failed, to, reason, error: String(error ?? "").slice(0, 300) };
    route.switches.push(f);
    if (!opts.silent && route.onFallback) { try { await route.onFallback(f); } catch { /* an audit row never costs a picture */ } }
  }
  return to;
}

/** The references a model can be given: all of them, except on kie.ai, which takes only the ones with a public link. */
const usableRefs = (model: string, refs: StillRef[]): StillRef[] =>
  stillProviderOf(model).provider === "kie" ? refs.filter((r) => typeof r.url === "string" && /^https:\/\//i.test(r.url)) : refs;
const drawRefOf = (r: StillRef): DrawRef => ({ bytes: r.image.bytes, mime: r.image.mime, url: r.url ?? null });

/* ------------------------------------------------------------------ draw, judge, redraw */

/**
 * `until` (24 September 2026): a wall-clock time (ms) after which no REDRAW starts — the best try so far is kept. The
 * first try always runs. It is what bounds the work a cron tick still has in flight at its deadline: without it a
 * still that started just before the deadline could run all its tries (draws of up to 90 s, judgements of up to 60 s
 * per call) and outlive the tick's lock, so the next tick paid for the same picture again.
 *
 * `escalateOn` (24 September 2026): whether the failed musts of the last judged try are ones the strong model draws
 * better — a look, an identity, a written text (strongDrawsBetter). Unset, any failed must escalates.
 *
 * `route` (25 September 2026): the model and the escalation model, read afresh before every try, and switched by a
 * refusal for money (switchRoute) — for this still and, the route being shared, for every other one of the job.
 */
interface JudgedOptions { attempts: number; pass: number; seedBase: number; route: StillRoute; size: { width: number; height: number }; until?: number; escalateOn?: (failedMusts: VisualCheck[]) => boolean; /** What is drawn (a picture id, "sheet/<cast>"): part of a kie.ai task's ledger key. */ label?: string; ledger?: KieLedger }
/** Everything drawJudged, drawStill and drawCastSheet read of the environment. */
export type StillEnv = DrawEnv & Pick<Env, "VISION_MODEL" | "STILL_MODEL" | "STILL_MODEL_STRONG" | "STILL_MODEL_FALLBACK" | "STILL_ATTEMPTS" | "STILL_PASS">;
/** Attaches the dollars spent so far to an error that ends a still, so the audit row of the loss still counts them. */
const withSpend = (e: unknown, usd: number): unknown => {
  if (usd > 0 && e && typeof e === "object") { try { (e as { usd?: number }).usd = round4(usd); } catch { /* a frozen error only loses the figure */ } }
  return e;
};

/** A draw Workers AI refused as flagged ("AiError: 3030: Your output has been flagged. Please choose another prompt / input image combination"). */
export const isFlaggedError = (e: unknown): boolean => /flagged|\b3030\b/i.test(String(e));

/**
 * What the strong model (klein-9B) draws better than the cheap one, measured on the pastry chef the 24th: the exact
 * look of a character, the same face as a reference, and legible words. A picture that failed its style, an exclusion
 * or a place is redrawn on the cheap model: 9B is not better at those, only seven times dearer.
 */
function strongDrawsBetter(failed: readonly VisualCheck[], spec: RequestSpec | null): boolean {
  return failed.some((c) => c.id.startsWith("identity:") || c.id.startsWith("cast:") || (!!spec && ["look", "text"].includes(itemById(spec, c.id)?.kind ?? "")));
}

/**
 * The loop both a still and a sheet go through: draw (seed seedBase + k), judge, stop at the first try with no failed
 * must, otherwise write the failures (the musts first) into the next prompt; keep the best try. A model that refuses
 * the reference images (anything but a transient error or a flagged output) is asked once more WITHOUT them, and the
 * tries after that go without too — a still without its reference is still better than no still. When the judge
 * could not answer at all (every answer "?"), the first picture is kept as it is: redrawing blind only spends the quota.
 *
 * WHAT A REDRAW IS BOUGHT FOR (24 September 2026). The fidelity bench (4 cases, 35 stills) found almost every still
 * drawn three times and its last try sent to klein-9B — 7 of 7 on the pastry chef, ≈ $0.027 a still against the
 * owner's $0.003-0.005 — for three reasons fixed here and in src/spec.ts visualChecks:
 *   (a) a still whose musts all passed was still redrawn when its weighted score was under STILL_PASS (0.85): a soft
 *       miss (a story beat, "warm pastel colours", a stray letter) bought a whole draw. Now the first try with no
 *       failed must IS the still, whatever its score; STILL_PASS only breaks ties when the best of several failed
 *       tries is chosen (a try at or above it beats one below it with as many failed musts, then the higher score).
 *   (b) the last try escalated to 9B whatever the must was. Now only when the failed musts include a look, an identity
 *       question or a written text (`escalateOn`): a failed style or exclusion is redrawn on 4B.
 *   (c) a draw Workers AI refused as FLAGGED (code 3030, a warrior with a sword) lost the whole still as an error,
 *       though another seed usually passes. Now a flagged answer counts as a failed try and the next seed is drawn;
 *       after two flagged answers in a row the next try goes once WITHOUT the reference images (the refusal names "the
 *       prompt / input image combination") — granted even when the tries are spent, to a still with no picture yet;
 *       only when every try is flagged does the still fail as before (the error thrown, drawJobStills gives the
 *       picture up).
 *
 * WHAT A REFUSAL FOR MONEY DOES (25 September 2026). An external road that answers "no credit", "unauthorized" or "no
 * such model" (fallbackReason) is switched away from for the rest of the job (switchRoute) and the SAME try is drawn
 * again at once on the fallback model, same seed, same prompt: the refusal costs a picture nothing but a second call.
 * The prompt and the judge get only the references the model is actually given (usableRefs: kie.ai takes links, so a
 * reference without one is left out of both), and every try carries what it cost; the still's `usd` is their sum.
 */
async function drawJudged(env: StillEnv, refs0: StillRef[], compile: (feedback: string[], refs: StillRef[]) => { prompt: string; checks: VisualCheck[] }, feedbackOf: (failed: VisualCheck[]) => string[], o: JudgedOptions): Promise<StillResult> {
  const route = o.route;
  let refs = refs0.slice(0, MAX_INPUT_IMAGES);
  let feedback: string[] = [];
  type Best = { bytes: Uint8Array; score: number; mustFailed: number; failed: VisualCheck[] };
  let best: Best | null = null;
  const better = (a: Best, b: Best): boolean => {
    if (a.mustFailed !== b.mustFailed) return a.mustFailed < b.mustFailed;
    const pa = a.score >= o.pass, pb = b.score >= o.pass;
    return pa !== pb ? pa : a.score > b.score;
  };
  const tries: StillTry[] = [];
  let lastMustFailed: VisualCheck[] = [];
  let flaggedRun = 0, lastFlag: unknown = null, droppedForFlag = false;
  let budget = o.attempts;
  let spent = 0;
  // The references the last draw was given: the checks the result reports are the ones that could be asked of it.
  let lastRefs = usableRefs(route.model, refs);
  for (let k = 0; k < budget; k++) {
    if (best && o.until !== undefined && Date.now() >= o.until) break; // out of time: the best try stands
    const seed = (o.seedBase + k) % 2_147_483_647;
    // The last try of a still that failed a must on every try so far goes to the stronger (dearer) model — only when
    // the must it failed last is one that model draws better.
    const escalate = !!route.strong && k > 0 && k === budget - 1 && !!best && best.mustFailed > 0 && lastMustFailed.length > 0 && (o.escalateOn ? o.escalateOn(lastMustFailed) : true);
    let model = escalate ? route.strong! : route.model;
    // The ledger key of a paid draw: this picture, this model, this seed, this exact prompt (a later tick that draws
    // the same try again collects the kie.ai task an earlier tick paid for). Every external road is booked against the
    // money caps since 26 September 2026 (the chat roads, ePhone AI and OpenRouter, too): only Workers AI is not.
    const ledgerFor = (m: string, prompt: string) => (o.ledger && isExternalStillModel(m) ? { key: `${o.label ?? "still"}#${m}#${seed}#${fnv1a(prompt).toString(36)}`, book: o.ledger } : undefined);
    let drawn = usableRefs(model, refs);
    let c = compile(feedback, drawn);
    // One draw on model `m`: with the references it can take, then once without them when it refuses them (anything
    // but a flagged output, a transient error or a refusal for money, which a missing reference does not cure).
    const drawOn = async (m: string): Promise<DrawnImage> => {
      drawn = usableRefs(m, refs);
      c = compile(feedback, drawn);
      try { return await drawImage(env, m, c.prompt, o.size, drawn.map(drawRefOf), seed, { until: o.until, ledger: ledgerFor(m, c.prompt) }); }
      catch (e) {
        if (isFlaggedError(e) || !drawn.length || isTransientStillError(e) || fallbackReason(e)) throw e;
        // A kie.ai task that ran and failed is redrawn without the references only when it says it could not read them.
        if (isTaskFailure(e) && !KIE_REFS_TROUBLE_RE.test(String(e))) throw e;
        spent += spentOn(e);
        refs = []; drawn = [];
        c = compile(feedback, drawn);
        return await drawImage(env, m, c.prompt, o.size, [], seed, { until: o.until, ledger: ledgerFor(m, c.prompt) });
      }
    };
    let d: DrawnImage;
    try {
      for (let hop = 0; ; hop++) {
        try { d = await drawOn(model); break; }
        catch (e) {
          // A refusal for money: the job moves to the fallback and this very try is drawn there (three hops at most:
          // one per road).
          const why = hop < 3 ? fallbackReason(e) : null;
          const next = why ? await switchRoute(route, model, escalate, why, e) : null;
          if (!next) throw e;
          spent += spentOn(e);
          model = next;
        }
      }
    } catch (e) {
      spent += spentOn(e);
      if (isFlaggedError(e) || isTaskFailure(e)) {
        // A flagged draw — or a kie.ai task that ran and failed — is a failed try, not a lost still: the next seed is drawn.
        lastFlag = e; flaggedRun++;
        tries.push({ seed, score: 0, failed: [isFlaggedError(e) ? "flagged" : "task failed"], ...(escalate || route.switches.length ? { model } : {}) });
        // Task failures in a row across the job (not a policy refusal): the provider is struggling, the job falls back,
        // and a still with no picture yet gets one more try there.
        if (isTaskFailure(e) && !isFlaggedError(e)) {
          route.taskFails = (route.taskFails ?? 0) + 1;
          if (route.taskFails >= TASK_FAILS_TO_FALL_BACK && route.fallback && (await switchRoute(route, model, escalate, "model unavailable", e))) {
            route.taskFails = 0;
            if (!best) budget = Math.max(budget, k + 2);
            continue;
          }
        }
        // Two in a row: the rest go without the reference images, and a still with no picture yet gets that one try
        // even past its budget (one with a picture already keeps it rather than pay beyond its tries).
        if (flaggedRun >= 2 && refs.length && !droppedForFlag) { refs = []; droppedForFlag = true; if (!best) budget = Math.max(budget, k + 2); }
        continue;
      }
      if (best) break; // a picture already exists: keep it rather than lose the shot to a failed redraw
      throw withSpend(e, spent);
    }
    flaggedRun = 0;
    if (stillProviderOf(model).provider === "kie") route.taskFails = 0;
    spent += d.usd;
    lastRefs = drawn;
    const bytes = d.bytes;
    const tag = { ...(escalate || route.switches.length ? { model } : {}), usd: round4(d.usd) };
    const j = await judgeImage(env, { bytes, mime: mimeOf(bytes) }, c.checks, drawn);
    const judged = !c.checks.length || c.checks.some((ch) => j.answers[ch.id] !== "?");
    if (!judged) {
      tries.push({ seed, score: 0, failed: ["unjudged"], ...tag });
      if (!best) return { bytes, score: 0, mustFailed: 0, failed: ["unjudged"], tries, judged: false, usd: round4(spent) };
      break;
    }
    tries.push({ seed, score: round3(j.score), failed: j.failed.map((f) => f.id), ...tag });
    const cand: Best = { bytes, score: j.score, mustFailed: j.mustFailed, failed: j.failed };
    if (!best || better(cand, best)) best = cand;
    if (j.mustFailed === 0) break; // (a): no failed must, no redraw, whatever the soft answers
    lastMustFailed = j.failed.filter((f) => f.must);
    feedback = feedbackOf([...lastMustFailed, ...j.failed.filter((f) => !f.must)]);
  }
  if (!best) throw withSpend(lastFlag ?? new Error("no still was drawn"), spent);
  return { bytes: best.bytes, score: round3(best.score), mustFailed: best.mustFailed, failed: best.failed.map((f) => f.id), tries, judged: true, checks: compile([], lastRefs.filter((r) => refs.includes(r))).checks.map((c) => c.id), usd: round4(spent) };
}

/**
 * Tries per still: 2 by default since 24 September 2026 (was 3). With the unprovable musts gone (src/spec.ts
 * visualChecks) and a must-free try kept at once, a still needs a second try only when it truly missed a look, a
 * face, a word, its style or an exclusion; the fidelity bench's third try was nearly always a third answer to a
 * question no frame could settle, drawn on 9B.
 */
const attemptsOf = (env: Pick<Env, "STILL_ATTEMPTS">, given?: number): number => Math.max(1, Math.min(6, given ?? int(env.STILL_ATTEMPTS, 2)));
const passOf = (env: Pick<Env, "STILL_PASS">, given?: number): number => Math.max(0, Math.min(1, given ?? num(env.STILL_PASS, 0.85)));

/**
 * What drawStill and drawCastSheet take besides the input. `model` forces one model (the bench: no escalation, no
 * fallback); `route` is the job's shared route (drawJobStills), which wins over both the env and `model`.
 */
export interface DrawOptions { attempts?: number; pass?: number; seedBase?: number; model?: string; until?: number; route?: StillRoute; /** The job's kie.ai task ledger (drawJobStills): resume and money caps. */ ledger?: KieLedger }

/** One still, drawn and judged against its checks, redrawn with the failures named while a must fails and tries remain. */
export async function drawStill(env: StillEnv, input: StillInput, opts: DrawOptions = {}): Promise<StillResult> {
  const size = STILL_SIZES[input.format === "16:9" ? "16:9" : "9:16"];
  return drawJudged(env, input.refs, (feedback, refs) => compileStill({ ...input, refs }, feedback), (failed) => feedbackFor(failed, input.spec, input.look), {
    attempts: attemptsOf(env, opts.attempts), pass: passOf(env, opts.pass), seedBase: opts.seedBase ?? fnv1a(input.shot.id) % 1_000_000,
    route: opts.route ?? stillRoute(env, { model: opts.model }), size, until: opts.until,
    escalateOn: (failed) => strongDrawsBetter(failed, input.spec), label: input.shot.id, ledger: opts.ledger,
  });
}

/**
 * THE CHARACTER SHEET: one full figure of a cast member, front view, plain background — the picture every later shot
 * of them is drawn FROM. From the user's own image when they gave one ("the same person as in reference image 1"),
 * otherwise from the full look alone. Judged against the character's look (attribute by attribute when the spec has
 * look items), so a sheet that draws the wrong hair does not become the reference for twenty wrong shots.
 * `userRef.url` is the signed link of the user's photo, for a road that takes links (kie.ai); `usd` what the sheet cost.
 */
export async function drawCastSheet(env: StillEnv, spec: RequestSpec | null, cast: { id: string; name: string; look: string }, look: StillLook, userRef: (VisionImage & { url?: string | null }) | null, opts: DrawOptions = {}): Promise<{ bytes: Uint8Array; score: number; usd: number }> {
  const inSpec = !!(spec && castById(spec, cast.id));
  const fl = clean((inSpec && spec ? fullLook(spec, cast.id) : "") || cast.look);
  const member: StillCastMember = { id: inSpec ? cast.id : null, name: cast.name, look: fl };
  const checks = inSpec && spec ? visualChecks(spec, { covers: [], cast: [cast.id] }, look) : [styleCheck(look), castCheck(member), noTextCheck];
  const refs: StillRef[] = userRef ? [{ label: `${cast.name}, the user's own picture`, image: { bytes: userRef.bytes, mime: userRef.mime }, url: userRef.url ?? null }] : [];
  const compile = (feedback: string[], r: StillRef[]) => ({
    prompt: [
      feedback.length ? `It is essential that: ${feedback.map((f) => f.replace(/[.\s]+$/, "")).join("; ")}.` : "",
      r.length ? sentence(`Character reference sheet of ${cast.name}, the same person as in reference image 1: ${fl}`) : sentence(`Character reference sheet of ${cast.name}: ${fl}`),
      "Full figure, front view, neutral pose, plain light background, even light.",
      STYLE_SENTENCE[look],
      NO_TEXT_SENTENCE,
    ].filter(Boolean).join(" ").slice(0, STILL_PROMPT_MAX),
    checks,
  });
  const r = await drawJudged(env, refs, compile, (failed) => feedbackFor(failed, spec, look), {
    attempts: Math.min(attemptsOf(env, opts.attempts ?? SHEET_ATTEMPTS), 4), pass: passOf(env, opts.pass), seedBase: opts.seedBase ?? fnv1a(`sheet/${cast.id}`) % 1_000_000,
    route: opts.route ?? stillRoute(env, { model: opts.model }), size: SHEET_SIZE, until: opts.until,
    escalateOn: (failed) => strongDrawsBetter(failed, inSpec ? spec : null), label: `sheet/${cast.id}`, ledger: opts.ledger,
  });
  return { bytes: r.bytes, score: r.score, usd: r.usd ?? 0 };
}

/* ------------------------------------------------------------------ the job */

type JobLike = Pick<Job, "id" | "user_id" | "params" | "storyboard"> & Partial<Pick<Job, "phase" | "queued_at" | "created_at">>;

const paramsOf = (job: Pick<Job, "params">): JobParams => { try { return JSON.parse(job.params) as JobParams; } catch { return {} as JobParams; } };
const storyboardOf = (job: Pick<Job, "storyboard">): Record<string, unknown> | null => {
  if (!job.storyboard) return null;
  try { const sb = JSON.parse(job.storyboard) as unknown; return sb && typeof sb === "object" ? (sb as Record<string, unknown>) : null; } catch { return null; }
};
export const stillsStateOf = (job: Pick<Job, "params">): JobParams["stills"] | null => paramsOf(job).stills ?? null;

/**
 * Whether this job's stills are drawn by the server engine: STILLS_ENGINE is not "legacy", a Workers AI binding
 * exists (and the dev fixture is off), the film is one of the two film looks, and there is a storyboard to draw.
 * Cartoon, cyber, stickman and explainer jobs are untouched.
 */
export function stillsEngineOn(env: Pick<Env, "STILLS_ENGINE" | "AI" | "IMAGE_FIXTURE">, job: Pick<Job, "storyboard">): boolean {
  if ((env.STILLS_ENGINE ?? "").trim().toLowerCase() === "legacy") return false;
  if (!env.AI || env.IMAGE_FIXTURE === "1") return false;
  const sb = storyboardOf(job);
  if (!sb) return false;
  const style = kleoStyleOf(sb);
  return style === "realistic" || style === "animation";
}

/**
 * Whether the GPU must still WAIT for this job's stills: the engine is on, the job is in its first phase, and the
 * stills are neither done nor failed. A job whose drawing started more than STILLS_GIVE_UP_MIN ago no longer waits
 * (the rented GPU draws what is missing): the engine may make a film better, never late for ever.
 */
export function stillsHold(env: Pick<Env, "STILLS_ENGINE" | "AI" | "IMAGE_FIXTURE">, job: JobLike): boolean {
  if (job.phase === "finish" || !stillsEngineOn(env, job)) return false;
  const st = stillsStateOf(job);
  if (st?.state === "done" || st?.state === "failed") return false;
  if (st?.state === "drawing") return !(st.at && minutesSince(st.at) > stillsGiveUpMin(st));
  return true;
}

/** The cast members a film draws sheets for: the spec's, then the direction's characters the spec does not have; six at most. */
function castMembersOf(spec: RequestSpec | null, direction: Direction | null): { id: string; name: string; look: string; ref: string | null }[] {
  const out: { id: string; name: string; look: string; ref: string | null }[] = [];
  if (spec) for (const c of spec.cast) {
    const ref = c.ref ?? spec.refs.find((r) => r.role === "character" && r.for === c.id)?.handle ?? null;
    out.push({ id: safeId(c.id), name: c.name, look: fullLook(spec, c.id) || c.look, ref });
  }
  for (const m of direction?.cast ?? []) {
    if (out.some((x) => norm(x.name) === norm(m.name))) continue;
    out.push({ id: `d-${safeId(norm(m.name).replace(/ /g, "-")) || String(out.length + 1)}`, name: m.name, look: m.look, ref: null });
  }
  return out.slice(0, 6);
}
// Idempotent (25 September 2026): the dashes are trimmed again after the cut, so safeId(safeId(x)) === safeId(x) — a
// 33-character id cut on a dash used to give a sheet link (ref/cast/<id>) whose key no longer matched the stored sheet.
const safeId = (s: string): string => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
export const castSheetKey = (jobId: string, castId: string): string => `renders/${jobId}/cast/${safeId(castId) || "x"}.jpg`;
/** Every cast-sheet key a job can have (purged with the job: sheets are not job_files, so the file list does not know them). */
export function castSheetKeys(job: Pick<Job, "id" | "params" | "storyboard">): string[] {
  return castMembersOf(specOf(paramsOf(job)), directionOf(storyboardOf(job))).map((m) => castSheetKey(job.id, m.id));
}

/**
 * REFERENCE LINKS (25 September 2026). kie.ai's image models take their references as public URLs, never as bytes,
 * so the pictures a still is drawn from must be reachable from outside for a few minutes: the character sheets
 * (renders/<job>/cast/<id>.jpg), the user's own pictures (refs/<user>/<handle>.<ext>) and the film's style anchor (its
 * first still, an ordinary img/ job file). They go out through the same signed, time-limited /dl links the pictures
 * already use (src/dl.ts, HMAC with INTERNAL_SECRET over job/name/expiry) under two extra names — "ref/cast/<id>.jpg"
 * and "ref/<kref_…>" — which dl.ts resolves here to the stored key: a sheet under the job's own prefix, a picture under
 * the job OWNER's refs prefix, nothing else. Neither is a job file, so neither ever reaches the user's result links.
 */
export const REFERENCE_LINK_RE = /^ref\/(?:cast\/([a-z0-9-]{1,32})\.jpg|(kref_[0-9a-f]{8}))$/;
export const sheetLinkName = (castId: string): string => `ref/cast/${safeId(castId) || "x"}.jpg`;
export const userRefLinkName = (handle: string): string => `ref/${handle}`;
/** How long a reference link lives: kie.ai fetches it within seconds of the task; each tick signs its own. */
export const REFERENCE_LINK_TTL_S = 2 * 60 * 60;
/** The stored key a reference link names, or null (dl.ts answers 404 then). */
export async function referenceLinkKey(env: Pick<Env, "RENDERS">, job: Pick<Job, "id" | "user_id">, name: string): Promise<string | null> {
  const m = REFERENCE_LINK_RE.exec(name);
  if (!m) return null;
  if (m[1]) return castSheetKey(job.id, m[1]);
  return m[2] ? refFileKey(env, job.user_id, m[2]) : null;
}
/**
 * A signed https /dl link to one of a job's files (an img/ picture, or a reference name above), or null when this
 * server has no public https address (a dev or test server kie.ai could not reach anyway) or no signing secret.
 */
export async function signedFileUrl(env: Pick<Env, "PUBLIC_URL" | "INTERNAL_SECRET">, jobId: string, name: string, ttlS = REFERENCE_LINK_TTL_S): Promise<string | null> {
  const base = String(env.PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(base) || !env.INTERNAL_SECRET) return null;
  const exp = Math.floor(Date.now() / 1000) + ttlS;
  return `${base}/dl/${jobId}/${encodeURIComponent(name)}?exp=${exp}&sig=${await hmacHex(env.INTERNAL_SECRET, `${jobId}/${name}/${exp}`)}`;
}

async function readStored(env: Env, key: string): Promise<VisionImage | null> {
  try {
    const f = await getFile(env, key, null);
    if (!f) return null;
    const bytes = new Uint8Array(await new Response(f.body as BodyInit).arrayBuffer());
    return sniffImage(bytes) ? { bytes, mime: mimeOf(bytes) } : null;
  } catch { return null; }
}

/** The handle of one of the user's images, from the handle itself or the spec's ref id; null when it is not one. */
function userRefHandle(spec: RequestSpec | null, ref: string): string | null {
  const handle = spec?.refs.find((r) => r.id === ref || r.handle === ref)?.handle ?? ref;
  return REF_HANDLE_RE.test(handle) ? handle : null;
}
/** One of the user's images, by the handle or the spec's ref id (src/refs.ts); null when it is gone or unreadable. */
async function userImage(env: Env, userId: string, spec: RequestSpec | null, ref: string): Promise<VisionImage | null> {
  const handle = userRefHandle(spec, ref);
  if (!handle) return null;
  try { return await refImage(env, userId, handle); } catch { return null; }
}

/** The treatment's visual-language sentence, from the storyboard the planner stored. */
function treatmentVisual(sb: Record<string, unknown> | null): string | null {
  const t = sb?.treatment;
  return t && typeof t === "object" && typeof (t as { visual?: unknown }).visual === "string" ? clean((t as { visual: string }).visual) || null : null;
}

/**
 * Merges one section into renders/<job>/fidelity.json (the report of how faithful the film is: the plan's verdicts,
 * every still's judgement, the sheets, a summary) and lists it in job_files as "fidelity.json". Read-merge-write:
 * `stills` and `sheets` merge per key, every other section replaces its predecessor. `summarize` computes the summary
 * from the merged report.
 */
export async function mergeFidelity(env: Env, job: Pick<Job, "id">, patch: { plan?: unknown; stills?: Record<string, unknown>; sheets?: Record<string, unknown>; summary?: unknown }, summarize?: (report: Record<string, unknown>) => unknown): Promise<Record<string, unknown>> {
  const key = `renders/${job.id}/fidelity.json`;
  let cur: Record<string, unknown> = {};
  try {
    const f = await getFile(env, key, null);
    if (f) { const x = JSON.parse(await new Response(f.body as BodyInit).text()) as unknown; if (x && typeof x === "object" && !Array.isArray(x)) cur = x as Record<string, unknown>; }
  } catch { /* an unreadable report is rewritten from this patch */ }
  const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
  const next: Record<string, unknown> = { ...cur, v: 1 };
  if (patch.plan !== undefined) next.plan = patch.plan;
  if (patch.stills) next.stills = { ...obj(cur.stills), ...patch.stills };
  if (patch.sheets) next.sheets = { ...obj(cur.sheets), ...patch.sheets };
  if (patch.summary !== undefined) next.summary = patch.summary;
  if (summarize) next.summary = summarize(next);
  const body = JSON.stringify(next);
  const size = await putFile(env, key, body, "application/json");
  await setFile(env, { job_id: job.id, name: "fidelity.json", key, size, content_type: "application/json" });
  return next;
}

/** The pictures of a job already stored (img/<pictureId>.png|jpg in job_files), by picture id. */
export async function storedPictures(env: Env, jobId: string): Promise<Map<string, string>> {
  return new Map((await listFiles(env, jobId)).filter((f) => IMAGE_NAME_RE.test(f.name)).map((f) => [f.name.slice(4).replace(/\.(png|jpg)$/, ""), f.name]));
}

/**
 * What the engine gave up on for good: pictures whose draw failed for a reason that will not change (a model error
 * about the prompt), never retried; and — since 24 September 2026 — character SHEETS the model refused the same way.
 * A refused sheet used to leave no mark: its audit row names a cast member, not a picture, so every later tick (and
 * every worker /images call) read the sheet as missing and asked the model again, with the same seed and the same
 * prompt, for the same refusal. Now a "stills.sheet" row with an error that is not transient marks it, and it is
 * skipped like a refused picture: that character's shots are drawn from the words alone.
 */
async function givenUp(env: Env, jobId: string): Promise<{ pictures: Set<string>; sheets: Set<string> }> {
  const pictures = new Set<string>(), sheets = new Set<string>();
  for (const d of await auditDetails(env, jobId, "stills.error")) if (typeof d.picture === "string" && d.picture && !d.transient) pictures.add(d.picture);
  for (const d of await auditDetails(env, jobId, "stills.sheet")) if (typeof d.cast === "string" && d.cast && d.error && !d.transient) sheets.add(d.cast);
  return { pictures, sheets };
}

/** The engine's own audit events a job's rows are read back from (a fixed list: the name goes into the SQL as written). */
type StillsEvent = "stills.error" | "stills.sheet" | "stills.judge" | "stills.store_error" | "stills.fallback" | "stills.task";
/** The parsed details of one event's audit rows for a job; [] when the audit cannot be read (that only costs a retry). */
async function auditDetails(env: Env, jobId: string, event: StillsEvent): Promise<Record<string, unknown>[]> {
  let rows: { detail: string | null }[];
  try { rows = (await env.DB.prepare(`SELECT detail FROM audit WHERE job_id = ? AND event = '${event}'`).bind(jobId).all<{ detail: string | null }>()).results ?? []; }
  catch { return []; }
  return rows.map((r) => { try { return obj(JSON.parse(r.detail ?? "{}")); } catch { return {}; } });
}

/**
 * WHAT A JOB'S PICTURES COST so far (25 September 2026), in dollars: the `usd` of every sheet, still, refused still
 * and still drawn but not stored, across every tick — read back from the audit rows, which is the one record that
 * survives the ticks. It is what "stills.done" and fidelity.json's summary report.
 */
async function stillsSpentUsd(env: Env, jobId: string): Promise<number> {
  let usd = 0;
  for (const ev of ["stills.sheet", "stills.judge", "stills.error", "stills.store_error"] as const) {
    for (const d of await auditDetails(env, jobId, ev)) if (typeof d.usd === "number" && Number.isFinite(d.usd)) usd += d.usd;
  }
  return round4(usd);
}

/**
 * A job's ledger of paid pictures (KieLedger): its "stills.task" rows (the kie.ai tasks to collect, and what the
 * film's pictures have spent on every external road since 26 September 2026) and the day's sum across every job. A
 * cap is checked AND reserved in one step (`refuse`), so the six draws of a tick cannot all pass the same last dollar;
 * a reservation whose createTask then fails stays counted for the rest of the call, which only errs on the careful side.
 */
async function jobLedger(env: Env, job: Pick<Job, "id" | "user_id">, minJobCap = 0): Promise<KieLedger> {
  const tasks = new Map<string, { task: string; at: number }>();
  let jobUsd = 0;
  for (const d of await auditDetails(env, job.id, "stills.task")) {
    if (typeof d.key !== "string" || typeof d.task !== "string") continue;
    const at = Date.parse(String(d.at ?? ""));
    tasks.set(d.key, { task: d.task, at: Number.isFinite(at) ? at : 0 });
    if (typeof d.usd === "number" && Number.isFinite(d.usd)) jobUsd += d.usd;
  }
  let dayUsd = 0;
  try {
    const r = await env.DB.prepare("SELECT COALESCE(SUM(json_extract(detail, '$.usd')), 0) AS usd FROM audit WHERE event = 'stills.task' AND at >= strftime('%Y-%m-%dT00:00:00.000Z','now')").first<{ usd: number }>();
    dayUsd = Number(r?.usd ?? 0) || 0;
  } catch { /* an unreadable sum: the film's own cap still holds */ }
  const jobCap = Math.max(num(env.STILLS_JOB_MAX_USD, STILLS_JOB_MAX_USD), minJobCap), dayCap = num(env.STILLS_DAILY_USD, STILLS_DAILY_USD);
  return {
    find: (key) => { const t = tasks.get(key); return t?.task && Date.now() - t.at < KIE_TASK_RESUME_MIN * 60_000 ? t.task : null; },
    refuse: (usd) => {
      if (jobUsd + usd > jobCap + 1e-9) return `this film's pictures have spent $${jobUsd.toFixed(2)} (STILLS_JOB_MAX_USD $${jobCap.toFixed(2)})`;
      if (dayUsd + usd > dayCap + 1e-9) return `today's pictures have spent $${dayUsd.toFixed(2)} (STILLS_DAILY_USD $${dayCap.toFixed(2)})`;
      jobUsd += usd; dayUsd += usd;
      return null;
    },
    created: async (key, task, model, usd) => {
      tasks.set(key, { task, at: Date.now() });
      await audit(env, job.user_id, job.id, "stills.task", { key, task, model, usd, at: nowIso() });
    },
  };
}

/**
 * THE VERDICT ON AN ERROR of the engine (24 September 2026): "pause" — the drawing stops for this tick and the next
 * tick carries on, the job still counted as drawing (and the GPU still waiting, up to STILLS_GIVE_UP_MIN) — or
 * "failed" — the engine is done with this job and the rented GPU draws what is missing the legacy way.
 *
 * Until today every transient error failed the job's engine for good: one "3040: Capacity temporarily exceeded", one
 * 90 s draw timeout, one R2 hiccup on picture 7 of 48, and the 41 others were drawn by the 77-token SDXL on the GPU —
 * although the next cron minute would have worked. Now only two things fail it: the daily quota (a 4006 answer does
 * not change within the minutes a GPU may wait, so waiting would only make the film late), and an error that is
 * plainly a bug in the code (src/images.ts PERMANENT_STORE_RE: "is not a function", "of undefined", a missing
 * binding), which no retry fixes. Everything else — a 429, a 5xx, a timeout, a dropped connection, a store write —
 * pauses, is counted in params.stills.pauses, and is bounded by the twenty-minute give-up.
 */
export function stillsErrorVerdict(e: unknown): "pause" | "failed" {
  if (isQuotaError(e)) return "failed";
  if (isTransientStillError(e)) return "pause";
  return isTransientStoreError(e) ? "pause" : "failed";
}

/**
 * Writes a pause into params.stills: still "drawing", the start of the drawing kept (the give-up clock runs from it,
 * so pauses never make the GPU wait longer than STILLS_GIVE_UP_MIN), one more pause counted, the error as the note;
 * plus a "stills.paused" audit row. The orchestrator uses it too, for a throw out of drawJobStills.
 */
export async function pauseStills(env: Env, job: Pick<Job, "id" | "user_id" | "params">, note: string, progress: { drawn?: number; total?: number } = {}): Promise<{ state: "drawing"; drawn: number; total: number }> {
  const prev = stillsStateOf(job);
  const at = prev?.state === "drawing" && prev.at ? prev.at : nowIso();
  const pauses = (prev?.pauses ?? 0) + 1;
  const drawn = progress.drawn ?? prev?.drawn ?? 0, total = progress.total ?? prev?.total ?? 0;
  // The road is kept: it sets the give-up (stillsGiveUpMin), and a pause must not shorten it to the Workers AI one.
  await updateJobParams(env, job.id, { stills: { state: "drawing", at, drawn, total, pauses, note: note.slice(0, 300), ...(prev?.road ? { road: prev.road } : {}) } });
  await audit(env, job.user_id, job.id, "stills.paused", { pauses, error: note.slice(0, 300), drawn, total });
  return { state: "drawing", drawn, total };
}

/**
 * DRAWS A JOB'S STILLS, as far as `deadline` allows, and says where it stands: "done" (every picture stored or given
 * up on), "drawing" (resume on the next tick — also after a transient error, see stillsErrorVerdict), "failed" (the
 * daily quota, or a bug: the rented GPU draws the rest). The character sheets first (reused from R2 when a previous
 * tick drew them), then every picture not stored yet, STILLS_CONCURRENCY at a time, each with the sheets of the
 * characters it shows as reference images. Every picture is stored under the same img/<pictureId> name the GPU's
 * pictures use (so /images and /dl serve it unchanged), every judgement is an audit row and a line of fidelity.json,
 * and params.stills says the state for the dispatcher. No redraw starts past `deadline` (JudgedOptions.until), and
 * `stop` (the cron's lock heartbeat) ends the drawing early when the tick lost its lock: another tick draws this job
 * now. Never throws on a model problem.
 *
 * Since 25 September 2026 every sheet and still of the call draws through ONE route (stillRoute): the model the env
 * names, switched to STILL_MODEL_FALLBACK at the first refusal for money with a "stills.fallback" audit row, which the
 * next tick replays before it draws. Every reference carries a signed link (signedFileUrl) for a road that takes links,
 * and every sheet, still and loss carries its `usd`; "stills.done" says what the job's pictures cost in all.
 */
export async function drawJobStills(env: Env, job: JobLike, opts: { deadline: number; stop?: () => boolean; stretch?: boolean }): Promise<{ state: "drawing" | "done" | "failed"; drawn: number; total: number }> {
  const params = paramsOf(job);
  const sb = storyboardOf(job);
  if (!sb || !stillsEngineOn(env, job)) return { state: "failed", drawn: 0, total: 0 };
  const look = kleoStyleOf(sb) as StillLook;
  const format: StillFormat = params.format === "16:9" ? "16:9" : "9:16";
  const spec = specOf(params);
  const direction = directionOf(sb);
  const visual = treatmentVisual(sb);
  const pics = stillShotsOf(sb).slice(0, MAX_PICTURES(params.duration_s ?? 60)).filter((p) => IMAGE_NAME_RE.test(imageFileName(p.id, "jpg")));
  const total = pics.length;
  const prev = params.stills;
  const startedAt = prev?.state === "drawing" && prev.at ? prev.at : nowIso();
  const stored = await storedPictures(env, job.id);
  const countDrawn = () => pics.filter((p) => stored.has(p.id)).length;
  let road: StillProvider = stillProviderOf(stillModel(env)).provider;
  const setState = async (state: "drawing" | "done" | "failed", note?: string) => {
    await updateJobParams(env, job.id, { stills: { state, at: state === "drawing" ? startedAt : nowIso(), drawn: countDrawn(), total, road, ...(prev?.pauses ? { pauses: prev.pauses } : {}), ...(note ? { note: note.slice(0, 300) } : {}) } });
    return { state, drawn: countDrawn(), total };
  };
  // A transient error: this tick stops, the next one carries on from what is stored, and the pause is counted.
  const pause = (note: string) => pauseStills(env, { id: job.id, user_id: job.user_id, params: JSON.stringify({ stills: { ...(prev ?? {}), state: "drawing", at: startedAt, road } }) }, note, { drawn: countDrawn(), total });
  const skip = await givenUp(env, job.id);
  const todo = pics.filter((p) => !stored.has(p.id) && !skip.pictures.has(p.id));
  if (!todo.length) return setState("done");

  // 0. THE ROUTE (25 September 2026): what draws, shared by every draw of this call; a fallback an earlier tick made
  //    (its "stills.fallback" row) holds for the rest of the job, so an empty account is not asked again every minute.
  const route = stillRoute(env);
  for (const f of await auditDetails(env, job.id, "stills.fallback")) {
    if (typeof f.from === "string" && f.from) await switchRoute(route, f.from, false, String(f.reason ?? "an earlier tick"), f.error ?? "", { silent: true });
  }
  route.onFallback = (f) => audit(env, job.user_id, job.id, "stills.fallback", f);
  road = stillProviderOf(route.model).provider;
  // Once external, the give-up stays external: a fallback to klein halfway must not cut the film's time back to 20
  // minutes measured from its first picture (second review, 25 September 2026).
  if (road === "workers-ai" && prev?.road && prev.road !== "workers-ai") road = prev.road as StillProvider;
  if (prev?.state !== "drawing" || prev.road !== road) await setState("drawing");
  // THE PACE (25 September 2026): an external road draws six at a time, counts a still at a minute, and — when the
  // caller allows it (the cron's `stretch`) — takes STILLS_EXTERNAL_MS instead of the Workers AI window.
  const external = isExternalStillModel(route.model);
  // Never past the job's give-up: another cron invocation marks it failed then and the GPU draws the rest.
  const giveUpAt = Date.parse(startedAt) + stillsGiveUpMin({ road, total }) * 60_000;
  const deadline = external && opts.stretch ? Math.max(opts.deadline, Math.min(Date.now() + STILLS_EXTERNAL_MS, giveUpAt)) : opts.deadline;
  const est = external ? EST_STILL_MS_EXTERNAL : EST_STILL_MS;
  const concurrency = external ? STILLS_CONCURRENCY_EXTERNAL : STILLS_CONCURRENCY;
  const late = () => Date.now() > deadline - est || !!opts.stop?.();
  // The ledger: the kie.ai tasks earlier ticks paid for (collected, not bought again) and the money caps, which bound
  // every external road since 26 September 2026 (ePhone AI and OpenRouter too: drawBooked), not kie.ai alone.
  // The film's own cap is at least every picture and sheet drawn twice (a film over 90 s has 48 pictures: about 9 $).
  const paidModel = [route.model, route.strong].find((m): m is string => !!m && isExternalStillModel(m));
  const ledger = paidModel ? await jobLedger(env, job, round3((total + castMembersOf(spec, direction).length) * 2 * (stillPriceUsd(paidModel, STILL_SIZES[format]) ?? 0))) : undefined;
  const link = (name: string) => signedFileUrl(env, job.id, name);
  type Linked = VisionImage & { url: string | null };

  // 1. THE SHEETS, `concurrency` at a time since 25 September 2026 (one after the other, a Nano Banana tick drew one
  //    sheet). The stills start only when every sheet is stored or given up. What a tick drew is written to
  //    fidelity.json before it can return: a tick that ran out of time between two sheets used to drop the report of
  //    the sheets it had drawn, and the next tick found them on R2 and skipped them without reporting them (24 September).
  const sheets = new Map<string, Linked>();
  const sheetReport: Record<string, unknown> = {};
  const flushSheets = async () => { if (Object.keys(sheetReport).length) await mergeFidelity(env, job, { sheets: sheetReport }); };
  const sheetQueue: ReturnType<typeof castMembersOf> = [];
  for (const m of castMembersOf(spec, direction)) {
    const have = await readStored(env, castSheetKey(job.id, m.id));
    if (have) { sheets.set(norm(m.name), { ...have, url: await link(sheetLinkName(m.id)) }); continue; }
    if (!skip.sheets.has(m.id)) sheetQueue.push(m); // one refused for good on an earlier tick: that character is drawn from the words
  }
  let sheetStop: { verdict: "pause" | "failed"; note: string } | null = null;
  const sheetHalt = (verdict: "pause" | "failed", note: string) => { if (!sheetStop || (verdict === "failed" && sheetStop.verdict === "pause")) sheetStop = { verdict, note }; };
  const drawSheet = async (m: ReturnType<typeof castMembersOf>[number]): Promise<void> => {
    const photo = m.ref ? await userImage(env, job.user_id, spec, m.ref) : null;
    const photoHandle = m.ref ? userRefHandle(spec, m.ref) : null;
    const userRef = photo ? { ...photo, url: photoHandle ? await link(userRefLinkName(photoHandle)) : null } : null;
    let r: { bytes: Uint8Array; score: number; usd: number };
    try {
      r = await drawCastSheet(env, spec, m, look, userRef, { seedBase: fnv1a(`${job.id}/cast/${m.id}`) % 1_000_000, until: deadline, route, ledger });
    } catch (e) {
      const msg = String(e).slice(0, 300);
      const transient = isTransientStillError(e);
      await audit(env, job.user_id, job.id, "stills.sheet", { cast: m.id, name: m.name, error: msg, transient, usd: round4(spentOn(e)) });
      if (transient) sheetHalt(stillsErrorVerdict(e), `sheet of ${m.name}: ${msg}`);
      return; // a sheet the model refuses leaves that character without a reference; the shots are still drawn from the words
    }
    try {
      await putFile(env, castSheetKey(job.id, m.id), r.bytes, sniffImage(r.bytes) === "png" ? "image/png" : "image/jpeg");
    } catch (e) {
      // The sheet is drawn and paid for: a store that did not keep it is a hiccup unless it plainly says otherwise.
      const msg = `storing the sheet of ${m.name}: ${String(e).slice(0, 260)}`;
      await audit(env, job.user_id, job.id, "stills.store_error", { cast: m.id, error: msg, usd: r.usd });
      sheetHalt(isTransientStoreError(e) ? "pause" : "failed", msg);
      return;
    }
    sheets.set(norm(m.name), { bytes: r.bytes, mime: mimeOf(r.bytes), url: await link(sheetLinkName(m.id)) });
    sheetReport[m.id] = { name: m.name, score: r.score, user_ref: !!userRef, usd: r.usd };
    await audit(env, job.user_id, job.id, "stills.sheet", { cast: m.id, name: m.name, score: r.score, user_ref: !!userRef, usd: r.usd });
  };
  const sheetWorker = async () => { while (sheetQueue.length && !sheetStop && !late()) await drawSheet(sheetQueue.shift()!); };
  await Promise.all(Array.from({ length: Math.min(concurrency, sheetQueue.length) }, () => sheetWorker()));
  const sheetHalted = sheetStop as { verdict: "pause" | "failed"; note: string } | null;
  if (sheetHalted || sheetQueue.length) {
    await flushSheets();
    if (sheetHalted?.verdict === "failed") return setState("failed", sheetHalted.note);
    return sheetHalted ? pause(sheetHalted.note) : setState("drawing");
  }

  // 2. THE STILLS.
  const refCache = new Map<string, Linked | null>();
  const extraRefs = async (pic: StillShot): Promise<StillRef[]> => {
    if (!spec) return [];
    const out: StillRef[] = [];
    for (const r of spec.refs) {
      if (r.role === "character") continue;
      const wanted = r.role === "style" || (r.for ? (pic.covers ?? []).includes(r.for) : r.role === "place");
      if (!wanted) continue;
      if (!refCache.has(r.handle)) {
        const img = await userImage(env, job.user_id, spec, r.handle);
        const handle = userRefHandle(spec, r.handle);
        refCache.set(r.handle, img ? { ...img, url: handle ? await link(userRefLinkName(handle)) : null } : null);
      }
      const img = refCache.get(r.handle);
      if (img) out.push({ label: `the ${r.role}${r.description ? ` (${clean(r.description).slice(0, 160)})` : ""}`, image: { bytes: img.bytes, mime: img.mime }, url: img.url });
    }
    return out;
  };
  const stillReport: Record<string, unknown> = {};
  const queue = [...todo];
  // THE STYLE ANCHOR (24 September 2026, probe gt_62bvh7ay): seven stills of one film came back in two drawing styles —
  // watercolour for some, flat cel for others — from the same style sentence. The first still of the film is passed to
  // every later one as a reference for its line, shading and palette. It is drawn alone first when nothing is stored
  // yet; on a later tick it is read back from the store.
  const firstId = pics[0]?.id;
  const anchorName = firstId ? stored.get(firstId) : undefined;
  const anchorRead = anchorName ? await readStored(env, `renders/${job.id}/${anchorName}`) : null;
  let anchor: Linked | null = anchorRead && anchorName ? { ...anchorRead, url: await link(anchorName) } : null;
  const ANCHOR_LABEL = "the drawing style of this film: match its line, shading, texture and palette exactly, never its content or composition";
  // The first error that stops this tick's drawing: "pause" (the next tick carries on) or "failed" (the GPU draws the
  // rest). A "failed" outranks a "pause" met by another worker in the same tick.
  let stopped: { verdict: "pause" | "failed"; note: string } | null = null;
  const halt = (verdict: "pause" | "failed", note: string) => { if (!stopped || (verdict === "failed" && stopped.verdict === "pause")) stopped = { verdict, note }; };
  const worker = async () => {
    while (queue.length && !stopped && !late()) {
      const pic = queue.shift()!;
      const cast = stillCast(pic, spec, direction);
      const refs: StillRef[] = [];
      const asRef = (label: string, img: Linked): StillRef => ({ label, image: { bytes: img.bytes, mime: img.mime }, url: img.url });
      for (const m of cast) { const img = sheets.get(norm(m.name)); if (img && refs.length < MAX_INPUT_IMAGES) refs.push(asRef(m.name, img)); }
      for (const r of await extraRefs(pic)) if (refs.length < MAX_INPUT_IMAGES) refs.push(r);
      if (anchor && pic.id !== firstId && refs.length < MAX_INPUT_IMAGES) refs.push(asRef(ANCHOR_LABEL, anchor));
      let r: StillResult;
      try {
        r = await drawStill(env, { shot: pic, spec, direction, look, format, visual, refs }, { seedBase: fnv1a(`${job.id}/${pic.id}`) % 1_000_000, until: deadline, route, ledger });
      } catch (e) {
        const msg = String(e).slice(0, 300);
        const transient = isTransientStillError(e);
        if (transient) { halt(stillsErrorVerdict(e), msg); queue.unshift(pic); }
        await audit(env, job.user_id, job.id, "stills.error", { picture: pic.id, error: msg, transient, usd: round4(spentOn(e)) });
        continue;
      }
      // The picture is drawn and paid for: a store that fails to keep it pauses the drawing (the next tick draws it
      // again, same seed); it is never a picture given up for good, which only a model refusal is.
      try {
        const ext = sniffImage(r.bytes) ?? "jpg";
        const name = imageFileName(pic.id, ext);
        const key = `renders/${job.id}/${name}`;
        const ctype = ext === "png" ? "image/png" : "image/jpeg";
        const size = await putFile(env, key, r.bytes, ctype);
        await setFile(env, { job_id: job.id, name, key, size, content_type: ctype });
        stored.set(pic.id, name);
        if (pic.id === firstId && !anchor) anchor = { bytes: r.bytes, mime: mimeOf(r.bytes), url: await link(name) };
      } catch (e) {
        const msg = `storing ${pic.id}: ${String(e).slice(0, 260)}`;
        halt(isTransientStoreError(e) ? "pause" : "failed", msg);
        queue.unshift(pic);
        await audit(env, job.user_id, job.id, "stills.store_error", { picture: pic.id, error: msg, usd: r.usd ?? 0 });
        continue;
      }
      stillReport[pic.id] = { score: r.score, mustFailed: r.mustFailed, failed: r.failed, checks: r.checks ?? [], tries: r.tries, refs: refs.map((x) => x.label), judged: r.judged !== false, usd: r.usd ?? 0 };
      await audit(env, job.user_id, job.id, "stills.judge", { picture: pic.id, tries: r.tries.length, score: r.score, must_failed: r.mustFailed, failed: r.failed, refs: refs.length, usd: r.usd ?? 0 });
    }
  };
  // The first still alone, so that every other one can be drawn in its style; then the rest, `concurrency` at a time.
  if (!anchor && queue[0]?.id === firstId) { const one = [queue.shift()!]; const rest = queue.splice(0); queue.push(...one); await worker(); queue.push(...rest); }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));

  // What drew (the route's model: the fallback once there was one), and what the job's pictures cost so far.
  const model = route.model;
  const fallback = route.switches.map((s) => ({ from: s.from, to: s.to, reason: s.reason }));
  const usd = await stillsSpentUsd(env, job.id);
  await mergeFidelity(env, job, { stills: stillReport, ...(Object.keys(sheetReport).length ? { sheets: sheetReport } : {}) }, (rep) => {
    const all = Object.values((rep.stills ?? {}) as Record<string, { score?: number; mustFailed?: number }>);
    const scores = all.map((s) => Number(s.score)).filter((n) => Number.isFinite(n));
    return {
      pictures: total, drawn: countDrawn(), model, at: nowIso(), usd, ...(fallback.length ? { fallback } : {}),
      mean_score: scores.length ? round3(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      must_failed_pictures: all.filter((s) => (s.mustFailed ?? 0) > 0).length,
    };
  });
  const halted = stopped as { verdict: "pause" | "failed"; note: string } | null;
  if (halted?.verdict === "failed") return setState("failed", halted.note);
  if (halted) return pause(halted.note);
  if (queue.length) return setState("drawing");
  await audit(env, job.user_id, job.id, "stills.done", { drawn: countDrawn(), total, model, usd, ...(fallback.length ? { fallback } : {}) });
  return setState("done");
}
