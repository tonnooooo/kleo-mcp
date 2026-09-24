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
 * Only imports plain TypeScript modules (with .ts extensions) and type-only dependencies, so the tests load it under
 * Node's type stripping (src/refs.ts included: it is written the same way).
 */
import type { Env } from "./env";
import type { Job, JobParams } from "./db";
import { audit, setFile, listFiles, updateJobParams } from "./db.ts";
import { putFile, getFile } from "./storage.ts";
import { int, num, nowIso, minutesSince } from "./util.ts";
import { pictureScenes, directionOf, kleoStyleOf, MAX_PICTURES } from "./keou-contract.ts";
import { headNoun, headNounIn, PRONOUN_HINTS, type Direction } from "./direction.ts";
import { specOf, castById, fullLook, itemById, visualChecks, norm, type RequestSpec, type SpecItem, type VisualCheck } from "./spec.ts";
import { judgeImage, mimeOf, type VisionImage } from "./vision.ts";
import { readImageResult, sniffImage, imageFileName, IMAGE_NAME_RE, fnv1a, isTransientError, isQuotaError, isTransientStoreError } from "./images.ts";
import { refImage, REF_HANDLE_RE } from "./refs.ts";

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
/** The escalation model for the last try, or null when STILL_MODEL_STRONG is "none" (or the same model as STILL_MODEL). */
export const strongStillModel = (env: Pick<Env, "STILL_MODEL" | "STILL_MODEL_STRONG">): string | null => {
  const m = (env.STILL_MODEL_STRONG ?? "").trim() || DEFAULT_STRONG_STILL_MODEL;
  return /^(none|off|-)$/i.test(m) || m === stillModel(env) ? null : m;
};
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
export interface StillRef { label: string; image: VisionImage }
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
export interface StillTry { seed: number; score: number; failed: string[]; /** Set when the try was drawn by the escalation model. */ model?: string }
export interface StillResult { bytes: Uint8Array; score: number; mustFailed: number; failed: string[]; tries: StillTry[]; judged?: boolean; /** The ids of every check the still was judged by (the report reads it). */ checks?: string[] }

interface AiRunner { run(model: string, inputs: Record<string, unknown>): Promise<unknown> }

const clean = (s: unknown): string => String(s ?? "").trim().replace(/\s+/g, " ");
const sentence = (s: unknown): string => { const t = clean(s).replace(/[.;,:\s]+$/, ""); return t ? `${t}.` : ""; };
const cut = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max).replace(/\s+\S*$/, "")}`);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

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
  must: true,
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
    ...texts.map((t) => sentence(`Written clearly and legibly in the picture, spelled exactly as given: ${t.text}`)),
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

/**
 * One FLUX.2 draw. The Workers AI binding takes these models as a MULTIPART body (Cloudflare's own example: a
 * FormData with prompt, width, height and input_image_0..3, turned into a stream and its content type through a
 * Request, then env.AI.run(model, { multipart: { body, contentType } })); the answer is {image: base64}. Throws on a
 * missing binding, a timeout, or an answer that is not a PNG/JPEG.
 */
export async function drawImage(env: Pick<Env, "AI">, model: string, prompt: string, size: { width: number; height: number }, refs: VisionImage[], seed: number): Promise<Uint8Array> {
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
  return bytes;
}

/* ------------------------------------------------------------------ draw, judge, redraw */

/**
 * `until` (24 September 2026): a wall-clock time (ms) after which no REDRAW starts — the best try so far is kept. The
 * first try always runs. It is what bounds the work a cron tick still has in flight at its deadline: without it a
 * still that started just before the deadline could run all its tries (draws of up to 90 s, judgements of up to 60 s
 * per call) and outlive the tick's lock, so the next tick paid for the same picture again.
 *
 * `escalateOn` (24 September 2026): whether the failed musts of the last judged try are ones the strong model draws
 * better — a look, an identity, a written text (strongDrawsBetter). Unset, any failed must escalates.
 */
interface JudgedOptions { attempts: number; pass: number; seedBase: number; model: string; strongModel?: string | null; size: { width: number; height: number }; until?: number; escalateOn?: (failedMusts: VisualCheck[]) => boolean }

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
 */
async function drawJudged(env: Pick<Env, "AI" | "VISION_MODEL">, refs0: StillRef[], compile: (feedback: string[], refs: StillRef[]) => { prompt: string; checks: VisualCheck[] }, feedbackOf: (failed: VisualCheck[]) => string[], o: JudgedOptions): Promise<StillResult> {
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
  for (let k = 0; k < budget; k++) {
    if (best && o.until !== undefined && Date.now() >= o.until) break; // out of time: the best try stands
    const seed = (o.seedBase + k) % 2_147_483_647;
    let c = compile(feedback, refs);
    let bytes: Uint8Array;
    // The last try of a still that failed a must on every try so far goes to the stronger (dearer) model — only when
    // the must it failed last is one that model draws better.
    const escalate = !!o.strongModel && k > 0 && k === budget - 1 && !!best && best.mustFailed > 0 && lastMustFailed.length > 0 && (o.escalateOn ? o.escalateOn(lastMustFailed) : true);
    const model = escalate ? o.strongModel! : o.model;
    try {
      try { bytes = await drawImage(env, model, c.prompt, o.size, refs.map((r) => r.image), seed); }
      catch (e) {
        if (isFlaggedError(e) || !refs.length || isTransientError(e)) throw e;
        refs = [];
        c = compile(feedback, refs);
        bytes = await drawImage(env, model, c.prompt, o.size, [], seed);
      }
    } catch (e) {
      if (isFlaggedError(e)) {
        // A flagged draw is a failed try, not a lost still: the next seed is drawn.
        lastFlag = e; flaggedRun++;
        tries.push({ seed, score: 0, failed: ["flagged"], ...(escalate ? { model } : {}) });
        // Two in a row: the rest go without the reference images, and a still with no picture yet gets that one try
        // even past its budget (one with a picture already keeps it rather than pay beyond its tries).
        if (flaggedRun >= 2 && refs.length && !droppedForFlag) { refs = []; droppedForFlag = true; if (!best) budget = Math.max(budget, k + 2); }
        continue;
      }
      if (best) break; // a picture already exists: keep it rather than lose the shot to a failed redraw
      throw e;
    }
    flaggedRun = 0;
    const j = await judgeImage(env, { bytes, mime: mimeOf(bytes) }, c.checks, refs);
    const judged = !c.checks.length || c.checks.some((ch) => j.answers[ch.id] !== "?");
    if (!judged) {
      tries.push({ seed, score: 0, failed: ["unjudged"] });
      if (!best) return { bytes, score: 0, mustFailed: 0, failed: ["unjudged"], tries, judged: false };
      break;
    }
    tries.push({ seed, score: round3(j.score), failed: j.failed.map((f) => f.id), ...(escalate ? { model } : {}) });
    const cand: Best = { bytes, score: j.score, mustFailed: j.mustFailed, failed: j.failed };
    if (!best || better(cand, best)) best = cand;
    if (j.mustFailed === 0) break; // (a): no failed must, no redraw, whatever the soft answers
    lastMustFailed = j.failed.filter((f) => f.must);
    feedback = feedbackOf([...lastMustFailed, ...j.failed.filter((f) => !f.must)]);
  }
  if (!best) throw lastFlag ?? new Error("no still was drawn");
  return { bytes: best.bytes, score: round3(best.score), mustFailed: best.mustFailed, failed: best.failed.map((f) => f.id), tries, judged: true, checks: compile([], refs).checks.map((c) => c.id) };
}

/**
 * Tries per still: 2 by default since 24 September 2026 (was 3). With the unprovable musts gone (src/spec.ts
 * visualChecks) and a must-free try kept at once, a still needs a second try only when it truly missed a look, a
 * face, a word, its style or an exclusion; the fidelity bench's third try was nearly always a third answer to a
 * question no frame could settle, drawn on 9B.
 */
const attemptsOf = (env: Pick<Env, "STILL_ATTEMPTS">, given?: number): number => Math.max(1, Math.min(6, given ?? int(env.STILL_ATTEMPTS, 2)));
const passOf = (env: Pick<Env, "STILL_PASS">, given?: number): number => Math.max(0, Math.min(1, given ?? num(env.STILL_PASS, 0.85)));

/** One still, drawn and judged against its checks, redrawn with the failures named while a must fails and tries remain. */
export async function drawStill(env: Pick<Env, "AI" | "VISION_MODEL" | "STILL_MODEL" | "STILL_MODEL_STRONG" | "STILL_ATTEMPTS" | "STILL_PASS">, input: StillInput, opts: { attempts?: number; pass?: number; seedBase?: number; model?: string; until?: number } = {}): Promise<StillResult> {
  const size = STILL_SIZES[input.format === "16:9" ? "16:9" : "9:16"];
  return drawJudged(env, input.refs, (feedback, refs) => compileStill({ ...input, refs }, feedback), (failed) => feedbackFor(failed, input.spec, input.look), {
    attempts: attemptsOf(env, opts.attempts), pass: passOf(env, opts.pass), seedBase: opts.seedBase ?? fnv1a(input.shot.id) % 1_000_000,
    model: opts.model ?? stillModel(env), strongModel: opts.model ? null : strongStillModel(env), size, until: opts.until,
    escalateOn: (failed) => strongDrawsBetter(failed, input.spec),
  });
}

/**
 * THE CHARACTER SHEET: one full figure of a cast member, front view, plain background — the picture every later shot
 * of them is drawn FROM. From the user's own image when they gave one ("the same person as in reference image 1"),
 * otherwise from the full look alone. Judged against the character's look (attribute by attribute when the spec has
 * look items), so a sheet that draws the wrong hair does not become the reference for twenty wrong shots.
 */
export async function drawCastSheet(env: Pick<Env, "AI" | "VISION_MODEL" | "STILL_MODEL" | "STILL_MODEL_STRONG" | "STILL_ATTEMPTS" | "STILL_PASS">, spec: RequestSpec | null, cast: { id: string; name: string; look: string }, look: StillLook, userRef: VisionImage | null, opts: { attempts?: number; pass?: number; seedBase?: number; model?: string; until?: number } = {}): Promise<{ bytes: Uint8Array; score: number }> {
  const inSpec = !!(spec && castById(spec, cast.id));
  const fl = clean((inSpec && spec ? fullLook(spec, cast.id) : "") || cast.look);
  const member: StillCastMember = { id: inSpec ? cast.id : null, name: cast.name, look: fl };
  const checks = inSpec && spec ? visualChecks(spec, { covers: [], cast: [cast.id] }, look) : [styleCheck(look), castCheck(member), noTextCheck];
  const refs: StillRef[] = userRef ? [{ label: `${cast.name}, the user's own picture`, image: userRef }] : [];
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
    model: opts.model ?? stillModel(env), strongModel: opts.model ? null : strongStillModel(env), size: SHEET_SIZE, until: opts.until,
    escalateOn: (failed) => strongDrawsBetter(failed, inSpec ? spec : null),
  });
  return { bytes: r.bytes, score: r.score };
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
  if (st?.state === "drawing") return !(st.at && minutesSince(st.at) > STILLS_GIVE_UP_MIN);
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
const safeId = (s: string): string => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
export const castSheetKey = (jobId: string, castId: string): string => `renders/${jobId}/cast/${safeId(castId) || "x"}.jpg`;
/** Every cast-sheet key a job can have (purged with the job: sheets are not job_files, so the file list does not know them). */
export function castSheetKeys(job: Pick<Job, "id" | "params" | "storyboard">): string[] {
  return castMembersOf(specOf(paramsOf(job)), directionOf(storyboardOf(job))).map((m) => castSheetKey(job.id, m.id));
}

async function readStored(env: Env, key: string): Promise<VisionImage | null> {
  try {
    const f = await getFile(env, key, null);
    if (!f) return null;
    const bytes = new Uint8Array(await new Response(f.body as BodyInit).arrayBuffer());
    return sniffImage(bytes) ? { bytes, mime: mimeOf(bytes) } : null;
  } catch { return null; }
}

/** One of the user's images, by the handle or the spec's ref id (src/refs.ts); null when it is gone or unreadable. */
async function userImage(env: Env, userId: string, spec: RequestSpec | null, ref: string): Promise<VisionImage | null> {
  const handle = spec?.refs.find((r) => r.id === ref || r.handle === ref)?.handle ?? ref;
  if (!REF_HANDLE_RE.test(handle)) return null;
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
  const rowsOf = async (event: "stills.error" | "stills.sheet"): Promise<{ detail: string | null }[]> => {
    try { return (await env.DB.prepare(`SELECT detail FROM audit WHERE job_id = ? AND event = '${event}'`).bind(jobId).all<{ detail: string | null }>()).results ?? []; }
    catch { return []; } // an unreadable audit only costs a retry
  };
  for (const r of await rowsOf("stills.error")) { try { const d = JSON.parse(r.detail ?? "{}") as { picture?: string; transient?: boolean }; if (d.picture && !d.transient) pictures.add(d.picture); } catch { /* ignore */ } }
  for (const r of await rowsOf("stills.sheet")) { try { const d = JSON.parse(r.detail ?? "{}") as { cast?: string; error?: string; transient?: boolean }; if (d.cast && d.error && !d.transient) sheets.add(d.cast); } catch { /* ignore */ } }
  return { pictures, sheets };
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
  if (isTransientError(e)) return "pause";
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
  await updateJobParams(env, job.id, { stills: { state: "drawing", at, drawn, total, pauses, note: note.slice(0, 300) } });
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
 */
export async function drawJobStills(env: Env, job: JobLike, opts: { deadline: number; stop?: () => boolean }): Promise<{ state: "drawing" | "done" | "failed"; drawn: number; total: number }> {
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
  const setState = async (state: "drawing" | "done" | "failed", note?: string) => {
    await updateJobParams(env, job.id, { stills: { state, at: state === "drawing" ? startedAt : nowIso(), drawn: countDrawn(), total, ...(prev?.pauses ? { pauses: prev.pauses } : {}), ...(note ? { note: note.slice(0, 300) } : {}) } });
    return { state, drawn: countDrawn(), total };
  };
  // A transient error: this tick stops, the next one carries on from what is stored, and the pause is counted.
  const pause = (note: string) => pauseStills(env, { id: job.id, user_id: job.user_id, params: JSON.stringify({ stills: { ...(prev ?? {}), state: "drawing", at: startedAt } }) }, note, { drawn: countDrawn(), total });
  const skip = await givenUp(env, job.id);
  const todo = pics.filter((p) => !stored.has(p.id) && !skip.pictures.has(p.id));
  if (!todo.length) return setState("done");
  if (prev?.state !== "drawing") await setState("drawing");
  const late = () => Date.now() > opts.deadline - EST_STILL_MS || !!opts.stop?.();

  // 1. THE SHEETS. What a tick drew is written to fidelity.json before it can return: a tick that ran out of time
  //    between two sheets used to drop the report of the sheets it had drawn, and the next tick found them on R2 and
  //    skipped them without reporting them (24 September 2026).
  const sheets = new Map<string, VisionImage>();
  const sheetReport: Record<string, unknown> = {};
  const flushSheets = async () => { if (Object.keys(sheetReport).length) await mergeFidelity(env, job, { sheets: sheetReport }); };
  for (const m of castMembersOf(spec, direction)) {
    const key = castSheetKey(job.id, m.id);
    const have = await readStored(env, key);
    if (have) { sheets.set(norm(m.name), have); continue; }
    if (skip.sheets.has(m.id)) continue; // refused for good on an earlier tick: this character is drawn from the words
    if (late()) { await flushSheets(); return setState("drawing"); }
    const userRef = m.ref ? await userImage(env, job.user_id, spec, m.ref) : null;
    let r: { bytes: Uint8Array; score: number };
    try {
      r = await drawCastSheet(env, spec, m, look, userRef, { seedBase: fnv1a(`${job.id}/cast/${m.id}`) % 1_000_000, until: opts.deadline });
    } catch (e) {
      const msg = String(e).slice(0, 300);
      const transient = isTransientError(e);
      await audit(env, job.user_id, job.id, "stills.sheet", { cast: m.id, name: m.name, error: msg, transient });
      if (transient) {
        await flushSheets();
        return stillsErrorVerdict(e) === "failed" ? setState("failed", `sheet of ${m.name}: ${msg}`) : pause(`sheet of ${m.name}: ${msg}`);
      }
      continue; // a sheet the model refuses leaves that character without a reference; the shots are still drawn from the words
    }
    try {
      await putFile(env, key, r.bytes, sniffImage(r.bytes) === "png" ? "image/png" : "image/jpeg");
    } catch (e) {
      // The sheet is drawn and paid for: a store that did not keep it is a hiccup unless it plainly says otherwise.
      await flushSheets();
      const msg = `storing the sheet of ${m.name}: ${String(e).slice(0, 260)}`;
      await audit(env, job.user_id, job.id, "stills.store_error", { cast: m.id, error: msg });
      return isTransientStoreError(e) ? pause(msg) : setState("failed", msg);
    }
    sheets.set(norm(m.name), { bytes: r.bytes, mime: mimeOf(r.bytes) });
    sheetReport[m.id] = { name: m.name, score: r.score, user_ref: !!userRef };
    await audit(env, job.user_id, job.id, "stills.sheet", { cast: m.id, name: m.name, score: r.score, user_ref: !!userRef });
  }

  // 2. THE STILLS.
  const refCache = new Map<string, VisionImage | null>();
  const extraRefs = async (pic: StillShot): Promise<StillRef[]> => {
    if (!spec) return [];
    const out: StillRef[] = [];
    for (const r of spec.refs) {
      if (r.role === "character") continue;
      const wanted = r.role === "style" || (r.for ? (pic.covers ?? []).includes(r.for) : r.role === "place");
      if (!wanted) continue;
      if (!refCache.has(r.handle)) refCache.set(r.handle, await userImage(env, job.user_id, spec, r.handle));
      const img = refCache.get(r.handle);
      if (img) out.push({ label: `the ${r.role}${r.description ? ` (${clean(r.description).slice(0, 160)})` : ""}`, image: img });
    }
    return out;
  };
  const stillReport: Record<string, unknown> = {};
  const queue = [...todo];
  // The first error that stops this tick's drawing: "pause" (the next tick carries on) or "failed" (the GPU draws the
  // rest). A "failed" outranks a "pause" met by another worker in the same tick.
  let stopped: { verdict: "pause" | "failed"; note: string } | null = null;
  const halt = (verdict: "pause" | "failed", note: string) => { if (!stopped || (verdict === "failed" && stopped.verdict === "pause")) stopped = { verdict, note }; };
  const worker = async () => {
    while (queue.length && !stopped && !late()) {
      const pic = queue.shift()!;
      const cast = stillCast(pic, spec, direction);
      const refs: StillRef[] = [];
      for (const m of cast) { const img = sheets.get(norm(m.name)); if (img && refs.length < MAX_INPUT_IMAGES) refs.push({ label: m.name, image: img }); }
      for (const r of await extraRefs(pic)) if (refs.length < MAX_INPUT_IMAGES) refs.push(r);
      let r: StillResult;
      try {
        r = await drawStill(env, { shot: pic, spec, direction, look, format, visual, refs }, { seedBase: fnv1a(`${job.id}/${pic.id}`) % 1_000_000, until: opts.deadline });
      } catch (e) {
        const msg = String(e).slice(0, 300);
        const transient = isTransientError(e);
        if (transient) { halt(stillsErrorVerdict(e), msg); queue.unshift(pic); }
        await audit(env, job.user_id, job.id, "stills.error", { picture: pic.id, error: msg, transient });
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
      } catch (e) {
        const msg = `storing ${pic.id}: ${String(e).slice(0, 260)}`;
        halt(isTransientStoreError(e) ? "pause" : "failed", msg);
        queue.unshift(pic);
        await audit(env, job.user_id, job.id, "stills.store_error", { picture: pic.id, error: msg });
        continue;
      }
      stillReport[pic.id] = { score: r.score, mustFailed: r.mustFailed, failed: r.failed, checks: r.checks ?? [], tries: r.tries, refs: refs.map((x) => x.label), judged: r.judged !== false };
      await audit(env, job.user_id, job.id, "stills.judge", { picture: pic.id, tries: r.tries.length, score: r.score, must_failed: r.mustFailed, failed: r.failed, refs: refs.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(STILLS_CONCURRENCY, todo.length) }, () => worker()));

  const model = stillModel(env);
  await mergeFidelity(env, job, { stills: stillReport, ...(Object.keys(sheetReport).length ? { sheets: sheetReport } : {}) }, (rep) => {
    const all = Object.values((rep.stills ?? {}) as Record<string, { score?: number; mustFailed?: number }>);
    const scores = all.map((s) => Number(s.score)).filter((n) => Number.isFinite(n));
    return {
      pictures: total, drawn: countDrawn(), model, at: nowIso(),
      mean_score: scores.length ? round3(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      must_failed_pictures: all.filter((s) => (s.mustFailed ?? 0) > 0).length,
    };
  });
  const halted = stopped as { verdict: "pause" | "failed"; note: string } | null;
  if (halted?.verdict === "failed") return setState("failed", halted.note);
  if (halted) return pause(halted.note);
  if (queue.length) return setState("drawing");
  await audit(env, job.user_id, job.id, "stills.done", { drawn: countDrawn(), total, model });
  return setState("done");
}
