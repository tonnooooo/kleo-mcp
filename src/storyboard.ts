/**
 * Storyboard generator: turns a Kleo job (template, prompt, duration, format, language, voice)
 * into a valid Keou storyboard with Workers AI, validated by keou-contract.ts.
 *
 * - Model: env.AI_MODEL, default @cf/meta/llama-3.3-70b-instruct-fp8-fast (JSON mode, free tier).
 * - One retry that feeds the validation errors back; then it throws with the errors.
 * - Test hook: env.STORYBOARD_FIXTURE === "example" or no AI binding → the cinema example, adapted (cartoon: picture style, shots).
 * - Kleo styles: params.style (cartoon | realistic | cyber | stickman; pickKleoStyle() when the client gave none). cartoon and
 *   realistic are "picture" projects: every scene cuts between 2–4 full-screen shots, each with its own image_prompt
 *   (the server draws the pictures, images.ts), no beats and no icons; cyber is the plain Keou look of the template;
 *   stickman is Keou's stickman (story scenes, 9:16 only). See docs/PICTURE-STYLE.md.
 */
import type { Env } from "./env";
import type { Job, JobParams } from "./db";
import { TEMPLATES, findTemplate, narrativeFor, sceneSplit, creditsFor, samePrice, filmedStoryboard, finishForProduct, productOf, type Family, type Product } from "./templates.ts";
import {
  validateStoryboard, defaultVoice, wordBudget, type Storyboard, type Format, type KleoStyle,
  KINDS, BEAT_KINDS, BEAT_ICONS, BEAT_FX, CINEMA_ACCENTS, VISUALS, FORBIDDEN_FIELDS,
  KLEO_STYLES, PICTURE_STYLES, FILM_LOOKS, type FilmLook, IMAGE_PROMPT_MAX, kleoStyleOf, STORY_ACTS, STORY_CAST, STORY_PROPS, STORY_FX, STORY_ACCENTS,
  SHOTS_PER_SCENE, SHOT_CAPTION_MAX, SHOT_HL_MAX, SHOT_AT_MAX, IMAGE_PROMPT_MIN, CLOSING_BUTTON_MAX,
  SHOT_ID_SUFFIX_RE, quotesVoice, SHOTS_MIN_CINEMA, shotRangeText, narrationOf, anchorShots,
} from "./keou-contract.ts";
/**
 * The direction: the art direction of ONE film, decided before a single scene exists. It is the step this planner
 * never had — it went straight from the user's sentence to a list of scenes, so the style came from a keyword match,
 * the world of the video was never written down, nothing said what must NOT appear, and no colour meant anything.
 */
import {
  directionProblems, missingFacts, sectionOfScene, enliven, screenTextProblems, notEnglish, D as DL,
  type Direction, type Section,
} from "./direction.ts";
// The shot grammar: the ten story kinds and the one preset table that turns a kind into a camera move.
// src/shot-grammar.ts is mirrored by worker/keou/shot_grammar.py; nothing here restates what that table says.
import {
  SHOT_KINDS, presetFor, durationFor, moveClassOf, directionOf, isLoud, resolveKind, LOUD_MAX_PER_WINDOW, LOUD_WINDOW_S,
  type ShotKind,
} from "./shot-grammar.ts";
// The treatment: the request expanded into a film by a producer, before the direction. Its words, shape, repair and
// variation live in src/treatment.ts; this file owns only the call (the model, the price, the retry).
import {
  MASTER_PROMPT, treatmentPrompt, treatmentSchema, repairTreatment, treatmentProblems, treatmentBlock, treatmentOf, variationFor,
  type Treatment,
} from "./treatment.ts";
// The layer (src/graphics.ts): the treatment decides it, the scenes fill it in, the storyboard carries it.
import { graphicsBlock, sceneHudSchema, repairGraphics, repairSceneHud, repairCards, type Graphics } from "./graphics.ts";
/** The layer this film is planned with: the treatment's, and only over a filmed picture. */
const layerOf = (plan: Plan, treatment?: Treatment | null): Graphics | null => (plan.style === "picture" && treatment?.graphics) ? treatment.graphics : null;
import cinemaExample from "../worker/keou/examples/short-relay-cinema/project.json" with { type: "json" };
import {
  EXPLAINER_GUIDANCE, EXPLAINER_WORDS, checkExplainer, explainerRules, explainerSceneSchema, lengthOf,
  repairExplainer, repairExplainerScene, sketchAccent,
} from "./explainer-plan.ts";

export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
/** USD per million tokens (developers.cloudflare.com/workers-ai/platform/pricing, Sept 2026); 1 neuron = $0.000011. */
const PRICES: Record<string, { in: number; out: number }> = {
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { in: 0.293, out: 2.253 },
  "@cf/meta/llama-4-scout-17b-16e-instruct": { in: 0.27, out: 0.85 },
  "@cf/openai/gpt-oss-120b": { in: 0.35, out: 0.75 },
  "@cf/openai/gpt-oss-20b": { in: 0.2, out: 0.3 },
  "@cf/qwen/qwen3-30b-a3b-fp8": { in: 0.051, out: 0.335 },
};

export type PlanJob = Pick<Job, "id" | "template" | "prompt" | "params">;
export interface Usage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
export interface PlanResult {
  storyboard: Storyboard;
  model: string;
  attempts: number;
  ms: number;
  usage: Usage;
  est_neurons: number | null;
  words: number;
  scenes: number;
  fixture: boolean;
  /** Problems found on each rejected attempt (diagnostics). */
  history: string[][];
  /** The Kleo style of the storyboard. */
  style: KleoStyle;
  /** The art direction the film was planned under, or null when the model could not produce a valid one. */
  direction: Direction | null;
  /** The treatment the film was planned under (written here, or handed in through params.treatment), or null. */
  treatment: Treatment | null;
  /** Facts the user asked for that the finished narration still does not say. Empty is the normal case. */
  missing_facts: string[];
  /**
   * A sentence for the USER when the direction wanted a look the job was not priced for, or null. It is not an
   * error and the video is fine; it is the difference between "you got the second choice" and "you got the second
   * choice and nobody told you". Whoever surfaces a job's progress owes the user this line.
   */
  blocked_upgrade: string | null;
}

/** Errors that say nothing about the storyboard: quota, rate limit, upstream outage. The job should wait, not fail. */
export const isTransientAiError = (e: unknown): boolean => /4006|daily free allocation|429|rate limit|too many requests|5\d\d\b|ECONNRESET|fetch failed|capacity|overloaded/i.test(String(e));

export class StoryboardError extends Error {
  errors: string[];
  /** The last normalised (but invalid) storyboard, for debugging. */
  draft: unknown;
  constructor(message: string, errors: string[], draft?: unknown) { super(message); this.errors = errors; this.draft = draft; }
}
/**
 * PLANNING IS BOUNDED. One model call may take MODEL_CALL_TIMEOUT_MS, one planning attempt PLAN_BUDGET_MS in all;
 * past either the attempt fails like any other (the orchestrator retries it once) instead of hanging. On 19 September
 * 2026 a 15-second animatic sat thirteen minutes in planning: its first attempt left no trace at all — no audit row,
 * no error — which is what an invocation cut off from outside looks like, and the plan lock then held the second
 * attempt back for the ten minutes of its own TTL. A normal attempt is 7 calls and about a minute (job gt_ad2musq5:
 * 54 s); the budget is four times that, so it only ever cuts a call that is not answering.
 */
export const MODEL_CALL_TIMEOUT_MS = 90_000;
export const PLAN_BUDGET_MS = 4 * 60_000;
/** Thrown by the planner's own clock, never by the model: every stage lets it through instead of retrying on it. */
export class PlanBudgetError extends StoryboardError {}
/** The promise, or an error after `ms` — the timer is cleared either way, so a Worker never keeps a dead timer alive. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clock = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms); });
  return Promise.race([p, clock]).finally(() => { if (timer !== null) clearTimeout(timer); });
}

/* ------------------------------------------------------------------ shot grammar */

/**
 * SHOT GRAMMAR, planner side. A shot says what it is FOR, in story terms; Kleo owns the camera. Nobody — not the
 * planner, not the client model, not this file — writes a camera move by hand, which is why the old in/out/left/right
 * "motion" is gone from everything the picture style emits.
 *
 * The preset table itself (kind → move, duration window, motion strength, vendor prompt suffix with its negatives,
 * text anchor, reserved trajectory) lives in ONE place in two languages: src/shot-grammar.ts and
 * worker/keou/shot_grammar.py, proven identical by a test. Everything below reads that table and never restates it.
 */
const moveFor = (kind: ShotKind) => presetFor(kind).move;
const classFor = (kind: ShotKind) => moveClassOf(moveFor(kind));
const loudFor = (kind: ShotKind) => isLoud(moveFor(kind));
/** Screen direction of a kind's move, or null when the move has none (a push, a crane, a hold). */
const dirFor = (kind: ShotKind) => { const d = directionOf(moveFor(kind)); return d === "none" ? null : d; };
/** The scale a kind frames at, for the "never twice at the same scale on the same subject" rule. */
const scaleFor = (kind: ShotKind) => presetFor(kind).scale;

/**
 * Kinds the repair path may reach for, cheapest first: one per move class, then a static hold as the genuine last
 * resort. STILL is the only class that can break a LATERAL → wide-PUSH sandwich, and a picture that holds still is
 * never wrong to look at — but it is last, so a shot only lands on it when no moving kind fits the rules.
 */
const QUIET_KINDS: readonly ShotKind[] = ["detail", "face", "establish", "reveal", "action", "static_forced"];
/** The rotation a missing shot_kind falls back to: VERTICAL → PUSH → LATERAL → PUSH, so no class ever repeats. */
const SHOT_KIND_ROTATION: readonly ShotKind[] = ["establish", "face", "detail", "reveal"];
/** The neutral lateral (track_alongside): where a scene's screen direction is already set the other way. */
const NEUTRAL_LATERAL: ShotKind = "action";

/**
 * Writes shot_kind on every shot of a picture-style storyboard and keeps the sequence shootable, so the model (or
 * the fixture, or a client-written storyboard) rarely hands the renderer a plan the validator has to refuse.
 *
 * Order of authority: the routing rule wins over everything (resolveKind), then the kind the author actually wrote,
 * then the rule for a missing one — the first shot of the VIDEO is the hook, the last shot of the video is the
 * closing, anything else takes the next kind of the rotation. Then the sequencing rules are repaired in place: no
 * two consecutive shots of the same move class, no two adjacent loud moves and no more loud moves than the budget,
 * no two consecutive shots of one scene at the same scale, one screen direction per scene.
 *
 * The one thing it does NOT repair is two adjacent shots that BOTH trip the routing rule: a forced static hold is
 * never overruled (moving a picture of hands is the exact bug this grammar exists to kill), so the pair is left
 * standing and the validator asks for a different picture — which is what the generator's retry loop is for.
 */
export function assignShotKinds(scenes: Record<string, unknown>[], format: string): void {
  const slots: { shot: Record<string, unknown>; scene: number }[] = [];
  scenes.forEach((s, i) => { if (Array.isArray(s.shots)) for (const sh of s.shots) if (isObj(sh)) slots.push({ shot: sh, scene: i }); });
  if (!slots.length) return;
  const kinds: ShotKind[] = [];
  const sameScene = (a: number, b: number) => slots[a] !== undefined && slots[b] !== undefined && slots[a].scene === slots[b].scene;
  /** True when a shot of `kind` at `at` may not sit beside `other`: same move class, or same scale inside one scene. */
  const collides = (kind: ShotKind, at: number, other: number) =>
    kinds[other] !== undefined && (classFor(kind) === classFor(kinds[other]) || (sameScene(at, other) && scaleFor(kind) === scaleFor(kinds[other])));
  /**
   * A quiet kind that collides with neither neighbour of shot `i`. The move class is the rule a viewer sees, so it
   * comes first: when nothing satisfies the scale rule too, the class-safe pick stands and the validator (which the
   * generator feeds back to the model) asks for a different picture.
   */
  const calmAt = (i: number): ShotKind => {
    const fits = QUIET_KINDS.filter((k) => classFor(k) !== classFor(kinds[i - 1]) && (kinds[i + 1] === undefined || classFor(k) !== classFor(kinds[i + 1])));
    return fits.find((k) => !collides(k, i, i - 1) && !collides(k, i, i + 1)) ?? fits[0] ?? "static_forced";
  };

  let turn = 0;
  slots.forEach((slot, i) => {
    const prompt = typeof slot.shot.image_prompt === "string" ? slot.shot.image_prompt : "";
    let k: ShotKind;
    if (inSet(slot.shot.shot_kind, SHOT_KINDS)) k = slot.shot.shot_kind as ShotKind;
    else if (i === 0) k = "hook";
    else if (i === slots.length - 1) k = "closing"; // only the LAST picture of the video closes it
    else {
      k = SHOT_KIND_ROTATION[turn % SHOT_KIND_ROTATION.length];
      for (let n = 0; n < SHOT_KIND_ROTATION.length && collides(k, i, i - 1); n++) k = SHOT_KIND_ROTATION[++turn % SHOT_KIND_ROTATION.length];
      turn++;
    }
    kinds.push(resolveKind(k, prompt)); // the routing rule has the last word
  });

  /**
   * No two consecutive shots of the same move class or scale, and no two adjacent loud moves. A forced static hold
   * gives way to nothing, and the hook that opens the video gives way to nothing either: when one of those is the
   * offender it is its neighbour that moves. The closing is preferred, not pinned — it keeps its pull-out whenever
   * the shot before it can move instead, and gives it up when that shot is the hook.
   */
  const fixPairs = (): boolean => {
    let changed = false;
    for (let i = 1; i < kinds.length; i++) {
      if (kinds[i] === "static_forced" && kinds[i - 1] === "static_forced") continue; // both pinned: only a new picture fixes it
      if (!collides(kinds[i], i, i - 1) && !(loudFor(kinds[i]) && loudFor(kinds[i - 1]))) continue;
      const at = kinds[i] !== "static_forced" && kinds[i] !== "closing" ? i
        : i - 1 > 0 && kinds[i - 1] !== "static_forced" ? i - 1
        : kinds[i] !== "static_forced" ? i : -1;
      if (at < 0) continue;
      const k = calmAt(at);
      if (k !== kinds[at]) { kinds[at] = k; changed = true; }
    }
    return changed;
  };
  /**
   * At most LOUD_MAX_PER_WINDOW loud moves inside any LOUD_WINDOW_S. The timeline is built the way the contract
   * builds it — every shot lasts the middle of its kind's window for this format — so the planner and the validator
   * are reading the same clock, and the third loud move of a window becomes quiet.
   */
  const fixLoudBudget = (): boolean => {
    let changed = false;
    for (let guard = 0; guard <= kinds.length; guard++) {
      const starts: number[] = [];
      let t = 0;
      for (const k of kinds) { const w = durationFor(k, format); starts.push(t); t += (w.min + w.max) / 2; }
      const loudIdx = kinds.map((_, i) => i).filter((i) => loudFor(kinds[i]));
      let over = -1;
      for (let a = 0; a < loudIdx.length && over < 0; a++) {
        const win = loudIdx.slice(a).filter((i) => starts[i] < starts[loudIdx[a]] + LOUD_WINDOW_S);
        if (win.length > LOUD_MAX_PER_WINDOW) over = win[LOUD_MAX_PER_WINDOW];
      }
      if (over < 0) return changed;
      kinds[over] = calmAt(over); // QUIET_KINDS holds no loud move, so each round removes one and this terminates
      changed = true;
    }
    return changed;
  };
  /** Screen direction stays consistent inside a scene: a second lateral that pulls the other way turns neutral. */
  const fixDirection = (): boolean => {
    let changed = false;
    const dir = new Map<number, "left" | "right">();
    kinds.forEach((k, i) => {
      const d = dirFor(k);
      if (!d) return;
      const had = dir.get(slots[i].scene);
      if (!had) dir.set(slots[i].scene, d);
      else if (had !== d && kinds[i] !== NEUTRAL_LATERAL) { kinds[i] = NEUTRAL_LATERAL; changed = true; } // still LATERAL: the class alternation holds
    });
    return changed;
  };
  // Repair until the sequence stops moving: fixing one shot can re-open the pair beside it, and a kind changed for
  // one rule can break another. Bounded — a plan no rule can satisfy is the validator's to report and the
  // generator's to feed back to the model, which is what the retry loop is for.
  for (let pass = 0; pass < 6; pass++) if (![fixPairs(), fixLoudBudget(), fixDirection()].some(Boolean)) break;
  kinds.forEach((k, i) => { slots[i].shot.shot_kind = k; });
}

/* ------------------------------------------------------------------ template briefs */

type StyleId = "cinema" | "editorial" | "technical" | "illustrated" | "stickman" | "picture" | "sketch";
interface Brief { style: StyleId; wordsPerScene: [number, number]; guidance: string }

const CINEMA_RULES = `Scenes are "cinema" (last one "closing"). Each scene: chapter (e.g. "01 HOOK", "02 THE TWIST", ≤32 chars), accent (red for threat/tension, green for the fix/win, cyan for neutral explanation, amber for warnings), title (≤90, short lockup line), hl (ONE word taken from the title, ≤24), voice (one narrated line), hold 0.2 (0.4 on the last scene), beats: 4–8 hero visuals of DIFFERENT kinds.
Beat shapes (ICON = one icon name from the enum, FX = one fx from the enum, WORDS = 1–3 consecutive words copied EXACTLY, same spelling and case, from that scene's voice; "?" marks optional keys):
{"kind":"type","text":"2-4 UPPERCASE WORDS ≤40","hl":"ONE WORD OF text ≤20","slam":true,"icon":ICON,"at"?:WORDS}
{"kind":"icon","name":ICON,"fx"?:FX,"size"?:0.6,"label"?:"≤24","at":WORDS}
{"kind":"split","items":[ICON,ICON],"fx"?:FX,"label"?:"≤24","at":WORDS}   (cause → effect)
{"kind":"grid","items":[ICON,ICON,ICON],"label"?:"≤24","at":WORDS}   (2–3 related objects)
{"kind":"steps","items":["≤14","≤14","≤14"],"lit"?:2,"at":WORDS}   (2–4 steps)
{"kind":"people","total":10,"lit":8,"label"?:"≤32","at":WORDS}   (x out of y, max 12)
{"kind":"bars","labels":["≤14","≤14"],"values":[850,722],"at":WORDS}   (1–4 integer values)
{"kind":"timeline","labels":["≤14","≤14","≤14"],"icons"?:[ICON,ICON,ICON],"at":WORDS}   (2–4 labels, one icon per label)
{"kind":"dialog","text":"≤32","count"?:3,"at":WORDS}   (a question card, count 1–5)
{"kind":"terminal","lines":["≤48","≤48"],"label"?:"≤16","at":WORDS}   (1–4 fake command lines)
{"kind":"cta","label"?:"≤24","toggles"?:["≤14","≤14"]}   (closing scene only)
The first beat of the hook scene is a slammed "type" beat. Every other beat carries "at", anchors in reading order. Icons: figure = the viewer, thief = the villain, phone/car/house/keyfob/pouch/timer/clock/wave/lock/shield/check/cross/bug/radar/alarm/hand/keyboard/desk/coffee/hoodie/amplifier are the only objects you can draw, so choose the closest metaphor. The closing scene keeps beats (a "type" beat with the loop question and a "cta" beat) plus a "detail" line ≤110.`;

/** The picture style (cartoon/realistic): scenes are runs of full-screen pictures cut on the narration, no beats, no icons. */
const SHOT_RULES = `Scenes are "cinema" (last one "closing"). Each scene: chapter (e.g. "01 THE CAPTAIN", ≤32), accent (red for threat/tension, green for the fix/win, cyan for neutral explanation, amber for warnings), title (≤90, the line shown on the first shot), hl (ONE word taken from the title, ≤24), voice (one narrated line), hold 0.2 (0.4 on the last scene), and "shots": 2–4 pictures for a cinema scene, 1 for the closing. The video is nothing but these pictures, cut like a short documentary: there are no icons, no cards and no beats.
Shot shape ("?" marks optional keys; WORDS = 1–4 consecutive words copied EXACTLY, same spelling, from that scene's voice):
{"image_prompt":"one sentence ≤${IMAGE_PROMPT_MAX} chars describing the picture","caption"?:"2–5 BIG WORDS ≤${SHOT_CAPTION_MAX}","hl"?:"ONE WORD OF caption ≤${SHOT_HL_MAX}","at"?:WORDS,"shot_kind"?:"${SHOT_KINDS.join("|")}"}
The FIRST shot of a scene starts with the scene and must NOT carry "at"; every other shot carries "at": the picture cuts when that word is spoken, so spread the anchors over the line in reading order. A caption is optional and rare: 2–5 strong words on the shot that carries the key idea (the first shot falls back to the scene title). The closing scene has ONE shot and may carry "button" (≤${CLOSING_BUTTON_MAX}, e.g. "Follow", default "Subscribe").
"shot_kind" says what the shot is FOR. NEVER write a camera move, a zoom, a pan or any other direction: Kleo owns the camera and picks the move from the kind. hook = the opening jolt, first shot of the video. establish = where we are. face = one face or animal carrying the feeling. detail = one object, close. detail_orbit = one object worth circling. action = something moving through the frame. reveal = the frame opens on the answer. tension = the moment before it goes wrong. closing = the last picture of the video. static_forced = the picture must NOT move (visible hands doing something, a crowd, readable signs or writing, a mechanism with moving parts, two people interacting) — those break under any move, so pin them. Leave shot_kind out and Kleo chooses it.`;

const PICTURE_RULES: Record<"cartoon" | "realistic" | "animation", string> = {
  cartoon: `PICTURES: this is a CARTOON video, so every "image_prompt" describes a flat vector cartoon illustration: concrete subjects and setting from the story (pirates → a beach, sand, a ship at anchor; space → a rocket, a station, planets), the SAME characters described the same way in every shot (hair, clothes, colours), bright simple shapes, one clear action per picture, a clear mood. Consecutive shots of one scene show the same place from a new angle or the next moment of the action. Never mention text, letters, numbers, logos, captions or the style itself; never name real people.`,
  realistic: `PICTURES: this is a REALISTIC video, so every "image_prompt" describes a cinematic photograph: the concrete subject and place (a rocket on the pad at dawn, a control room, a mountain road in rain), the lens feel, the light and the mood, the SAME subject described the same way in every shot, one clear action per picture. Consecutive shots of one scene show the same place from a new angle or the next moment. Never mention text, letters, numbers, logos or captions; never name or depict real people.`,
  animation: `PICTURES: this is an ANIMATED film, so every "image_prompt" describes one frame of a 2D animated feature: a painted background with depth, drawn characters designed once (build, face, hair, clothes, colours) and described the same way in every shot, clean linework, cel colour, one clear action per picture, the light and the mood painted rather than photographed. Consecutive shots of one scene show the same place from a new angle or the next moment. Never mention text, letters, numbers, logos, captions or the word "cartoon"; never name or depict real people; nothing photographic.`,
};

const STICKMAN_RULES = `Scenes are "story" (last one "closing"): a hand-drawn stickman acts out the narration, one situation per scene.
Scene shape ("?" marks optional keys; use these exact enum strings, nothing else):
{"id":"01-hook","kind":"story","act":"idle|explain|point-up|shrug|think|alarm|hold|drop|wave|walk|run|crouch","cast":["hero"] or ["hero","thief"] or ["hero","thief","thief2"],"props"?:[up to 3 distinct of ${STORY_PROPS.join(", ")}],"fx"?:"${STORY_FX.join("|")}","accent":"green|red|amber","bubble"?:"≤40 chars the character says","hl"?:"ONE word of the title ≤24","title":"≤90 short lockup line","voice":"one narrated sentence","hold"?:0.2}
hero = the viewer, thief/thief2 = villains; acts follow the narration (alarm when something goes wrong, explain/point-up when teaching, shrug for doubt, run/walk for movement, hold/drop with a prop). Accent red for danger, amber for warnings, green for the fix. The closing scene is {"id":"…","kind":"closing","title":"…","voice":"…","bubble"?:"≤40","hl"?:"≤24","hold":0.4} with the loop question or the call to action.`;

const EDITORIAL_RULES = `Every scene: id (unique slug), kind, eyebrow (UPPERCASE section label ≤40), title (≤90, a punchy on-screen line, not the narration), voice (the narration, ≤350 characters, 2–4 spoken sentences), optional hold 0.65–1.2 (1.8 on the closing).
Scene shapes ("?" marks optional keys; do not add other keys):
{"id":"01-hook","kind":"hero","eyebrow":"…","title":"…","voice":"…","visual":"focus|network|cycle|spark|globe|check|growth"}
{"id":"…","kind":"list","eyebrow":"…","title":"…","voice":"…","items":["≤42","≤42","≤42"]}   (exactly 3 items)
{"id":"…","kind":"steps","eyebrow":"…","title":"…","voice":"…","items":["≤42","≤42","≤42"]}   (exactly 3 steps, in order)
{"id":"…","kind":"compare","eyebrow":"…","title":"…","voice":"…","items":["≤42","≤42"]}   (exactly 2 sides)
{"id":"…","kind":"metric","eyebrow":"…","title":"…","voice":"…","value":"26,000","unit":"light-years from Earth","animate_value":true}   (value ≤12 chars; animate_value only when value starts with a plain number)
{"id":"…","kind":"quote","eyebrow":"…","title":"…","voice":"…","quote":"≤120"}
{"id":"…","kind":"closing","eyebrow":"…","title":"…","voice":"…","button":"≤40","hold":1.8}   (last scene only; "button" OR "detail" ≤110, never both)
Optional on any scene: "source":"≤80" (outlet or organisation), "detail":"≤110". Items mirror what the narration says.`;

/**
 * THE BRIEFS ARE DERIVED, NOT WRITTEN. Until 11 September 2026 this was a second table: the structure of a
 * video lived here, in the template description the assistant reads, and in the guide — and the day a look's
 * rhythm changed it had to be remembered in three places. src/templates.ts is the one place now; this reads
 * it. A template that names no family falls back the way it always did.
 */
const briefOf = (template: string): Brief => {
  const f: Family = narrativeFor(template);
  return { style: f.keouStyle as StyleId, wordsPerScene: f.wordsPerScene, guidance: f.guidance };
};
const BRIEFS: Record<string, Brief> = Object.fromEntries(TEMPLATES.map((t) => [t.id, briefOf(t.id)]));


/** Keou style for a Kleo template and format in the cyber look (cinema is portrait-first; 16:9 motivational falls back to editorial). */
export function styleFor(template: string, format: Format): StyleId {
  const b = BRIEFS[template] ?? BRIEFS.explainer;
  if (b.style === "cinema" && format === "16:9" && template !== "cinematic-trailer") return "editorial";
  return b.style;
}

/** Keou style for a Kleo style: cartoon/realistic are the "picture" style, the stickman has its own, cyber keeps the template's look. */
export function keouStyleFor(kleo: KleoStyle, template: string, format: Format): StyleId {
  if (kleo === "stickman") return "stickman";
  if (kleo === "explainer") return "sketch";
  if (PICTURE_STYLES.includes(kleo)) return "picture";
  return styleFor(template, format);
}

/**
 * THE FALLBACK THAT PICKS THE LOOK WHEN NO MODEL DOES.
 *
 * This is not the main decision — the direction (src/direction.ts, step zero of the planner) reads the request and
 * says which look it wants and why. This runs when there is no model to ask: createJob calls it the moment a client
 * sends a prompt with no style and no storyboard, and that answer decides real things (whether the job needs a GPU
 * at all, what it costs). So it has to be honest on its own.
 *
 * MEASURED BEFORE THIS WAS WRITTEN (scripts/adaptation.mjs, 28 ordinary requests, run 34494645061):
 *   68% of requests never moved the answer at all — they landed on the default "cartoon" whatever they said, and
 *   the 68% accuracy was explained entirely by that default being lucky. When the words really did decide, they were
 *   right 6 times out of 9. Every one of the three word lists was ENGLISH ONLY, so an Italian request — the language
 *   of this product's first users — could not trigger a single rule.
 *
 * Three things changed, and each one is a rule you can argue with rather than an accident:
 *   1. IT COUNTS, it does not stop at the first hit. "The history of hacking told as a bedtime story" used to be
 *      cyber, because "hacking" was tested before "story": one word beat three.
 *   2. IT SPEAKS ITALIAN. The same vocabularies in both languages, because a request is not less of a request for
 *      being written in the language the owner speaks.
 *   3. THE TEMPLATE IS A STATED PRIOR, not a silent default. When the words say nothing, the answer comes from the
 *      template and says so, instead of pretending "cartoon" was a decision.
 *
 * The vocabularies are written from what each look IS FOR, not from the requests in the measurement corpus: tuning
 * them against the corpus would make the number grade itself.
 */
type Look = Extract<KleoStyle, "cartoon" | "realistic" | "cyber">;

/** Drawn: stories, characters, history, anything a person pictures rather than photographs. */
const CARTOON_WORDS = /\b(stor(?:y|ies)|tale|fairy|kids?|children|child|bedtime|cartoon|animated|pirates?|dragons?|knights?|castle|princess|wizard|monster|animals?|cats?|dogs?|dinosaurs?|space|rocket|planet|history|historical|ancient|medieval|legend|myth|fable|adventure|treasure|island|jungle|magic|funny|joke|humou?r|mistakes?|habits?|advice|tips?|lesson|imagine|once upon|storia|storie|racconta(?:re|no)?|racconto|favola|fiaba|leggenda|mito|bambin[io]|ragazz[io]|buonanotte|cartone|pirat[ai]|dragh?[oi]|cavalier[ei]|castello|principessa|mago|mostro|animal[ei]|gatt[oi]|can[ei]|dinosaur[oi]|spazio|razzo|pianeta|storico|antico|medievale|avventura|tesoro|isola|giungla|magia|divertente|ironia|scherzo|errori?|abitudin[ei]|consigli?|lezione|immagina)\b/gi;

/** Photographed: things that exist and can be filmed — places, products, news, sport, food. */
const REALISTIC_WORDS = /\b(product|review|unboxing|specs?|price|buy|brand|camera|laptop|headphones|phone|drone|gadget|smartphone|car|cars|bike|watch|sneakers?|restaurant|hotel|city|cities|street|beach|mountain|travel|trip|visit|weekend|itinerary|destination|landscape|nature|photograph|news|headline|election|economy|market|stocks?|inflation|company|ceo|launch|sport|match|championship|recipe|cooking|food|fitness|workout|gym|real estate|apartment|train|flight|airport|museum|what to see|what to eat|sources?|prodotto|recensione|prezzo|comprare|marca|fotocamera|portatile|cuffie|telefono|drone|auto|macchina|bici|orologio|scarpe|ristorante|albergo|citt[àa]|strada|spiaggia|montagna|viaggio|viaggiare|visitare|itinerario|meta|paesaggio|natura|fotografia|notizie?|titolo|elezioni|economia|mercato|azioni|inflazione|azienda|lancio|partita|campionato|ricetta|cucina|cibo|palestra|allenamento|immobiliare|appartamento|treno|volo|aeroporto|museo|cosa vedere|cosa mangiare|font[ei])\b/gi;

/** Diagrammed: how something invisible works — systems, security, abstractions. */
const CYBER_WORDS = /\b(cyber|security|hacker|hacking|malware|phishing|scam(?:mer)?s?|ransomware|password|vpn|encryption|encrypted|crypto(?:currency)?|bitcoin|blockchain|ai|artificial intelligence|machine learning|llm|chatgpt|neural|algorithm|software|coding|programming|developer|javascript|python|linux|database|server|network|wifi|bluetooth|data breach|privacy|surveillance|protocol|api|firewall|two.factor|sicurezza|informatica|hacker|violazion[ei]|truffa|truffe|riscatto|password|crittografia|criptat[oi]|intelligenza artificiale|apprendimento automatico|algoritmo|programmazione|sviluppatore|banca dati|rete|protocollo|firewall|privacy|sorveglianza|autenticazione)\b/gi;

const VOCAB: Record<Look, RegExp> = { cartoon: CARTOON_WORDS, realistic: REALISTIC_WORDS, cyber: CYBER_WORDS };

/**
 * What a template already tells us about the look, and how hard it argues.
 *
 * STRONG means the template names its subject matter: an explainer explains a mechanism, a product review reviews a
 * thing, a news roundup reports. There the words of one request have to beat the template by a clear margin before
 * they overturn it, because a single incidental noun ("phone", in a request about battery life) is not an argument
 * against a choice the user already made.
 *
 * WEAK means the template is a FORMAT, not a subject: a Short, a countdown, a trailer say how long and how fast, not
 * what about. There any evidence in the words wins, because the template is guessing too.
 */
const TEMPLATE_PRIOR: Record<string, { look: Look; strong: boolean }> = {
  "product-review": { look: "realistic", strong: true },
  "weekly-news": { look: "realistic", strong: true },
  "story-documentary": { look: "realistic", strong: true },
  "explainer": { look: "cyber", strong: true },
  "viral-short": { look: "cartoon", strong: false },
  "did-you-know": { look: "cartoon", strong: false },
  "reddit-story": { look: "cartoon", strong: false },
  "motivational": { look: "cartoon", strong: false },
  "top-10": { look: "cartoon", strong: false },
  "cinematic-trailer": { look: "cartoon", strong: false },
};
/** A look must beat a STRONG template by this many distinct terms before it overturns it. */
const STRONG_MARGIN = 2;
const EXPLAINER_TEMPLATES = new Set(["explainer-short", "explainer-long"]);

/** Distinct terms of a vocabulary the request uses. Distinct, so one word repeated is not an argument. */
function score(text: string, re: RegExp): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(re)) seen.add(m[0].toLowerCase());
  return [...seen];
}

export interface StylePick {
  style: KleoStyle;
  /** One sentence a person can disagree with: which words decided, or that the words decided nothing. */
  why: string;
  /** The terms each look found, so the decision can be argued with rather than trusted. */
  hits: Record<Look, string[]>;
  /**
   * True only when the REQUEST decided. False when the answer came from the template because the words settled
   * nothing, or because a near-tie had to be broken.
   *
   * Measured on 27 requests written by two other sessions: 13 of them named no subject at all, and the whole set
   * scored 26%. A guess that presents itself as a decision is the bug; a guess that says so is a conversation — the
   * assistant reads it, tells the user, and the user corrects it before anything is rented.
   */
  confident: boolean;
}

/** The look, and why. `pickKleoStyle` keeps the old signature for callers that only want the answer. */
export function pickKleoStyleWhy(template: string, prompt: string): StylePick {
  const text = prompt.slice(0, 1500);
  const empty: Record<Look, string[]> = { cartoon: [], realistic: [], cyber: [] };
  if (EXPLAINER_TEMPLATES.has(template))
    return { style: "explainer", why: "the template is the explainer, so there is nothing to guess", hits: empty, confident: true };

  const hits: Record<Look, string[]> = {
    cartoon: score(text, VOCAB.cartoon), realistic: score(text, VOCAB.realistic), cyber: score(text, VOCAB.cyber),
  };
  const p = TEMPLATE_PRIOR[template] ?? { look: "cartoon" as Look, strong: false };
  const looks: Look[] = ["cartoon", "realistic", "cyber"];
  const best = looks.reduce((a, b) => (hits[b].length > hits[a].length ? b : a), p.look);
  const lead = hits[best].length - hits[p.look].length;

  if (hits[best].length === 0)
    return { style: p.look, why: `nothing in the request names a subject, so the ${template} template decides: ${p.look}`, hits, confident: false };
  if (best === p.look)
    return { style: best, why: `the request says ${hits[best].slice(0, 4).join(", ")}`, hits, confident: true };
  if (p.strong && lead < STRONG_MARGIN)
    return { style: p.look, why: `${best} is only ${lead} term${lead === 1 ? "" : "s"} ahead (${hits[best].slice(0, 3).join(", ")}), and the ${template} template is explicit about its subject: ${p.look}`, hits, confident: false };
  return { style: best, why: `the request says ${hits[best].slice(0, 4).join(", ")}, ahead of ${p.look} by ${lead}`, hits, confident: lead >= 2 };
}

/**
 * The Kleo look when the client picked none. Counting, bilingual, and template-aware; never stickman, which is only
 * ever chosen on request.
 */
export function pickKleoStyle(template: string, prompt: string): KleoStyle {
  return pickKleoStyleWhy(template, prompt).style;
}

function sceneRange(words: number, wps: [number, number]): [number, number] {
  const lo = Math.max(4, Math.ceil(words / wps[1]));
  const hi = Math.min(60, Math.max(lo + 1, Math.round(words / wps[0])));
  return [lo, hi];
}

/* ------------------------------------------------------------------ prompt */

interface Plan { style: StyleId; kleo: KleoStyle; pictures: boolean; product: Product; brief: Brief; format: Format; language: string; voice: string; duration: number; speed: number; words: ReturnType<typeof wordBudget>; scenes: [number, number]; maxDuration: number; chunk: number }

/**
 * `chosen` is the look the DIRECTION picked after reading the request. It only applies when the client did not name a
 * style itself: the user's own choice always wins, and the keyword fallback is what is left when there is no model.
 */
export function planFor(job: PlanJob, chosen?: KleoStyle | null): Plan {
  const p = JSON.parse(job.params) as JobParams;
  const format = p.format;
  // THE LOOK OWNS THE LANGUAGE, THE TEMPLATE OWNS THE LENGTH. Since step zero may now choose the drawn
  // explainer for a request that came in on any template, the brief has to follow the LOOK when the two
  // disagree — otherwise a film planned as "sketch" is written to the viral-short brief: a 10-18 word
  // window instead of 8-14, and guidance describing beats and a closing scene that this look does not have.
  // Only the drawn look needs this: cartoon and realistic share the cinema scene shapes, sketch does not.
  const templateBrief = BRIEFS[job.template] ?? BRIEFS.explainer;
  // NAMING A STYLE IS A DECISION; NOT NAMING ONE IS A BET. A decision is honoured whatever it costs. A bet is exactly
  // what the direction exists to improve on, so it yields — and until this line it could not: createJob writes
  // params.style on every job, guessed or chosen, and this took p.style over `chosen` in every case. The look the
  // direction read out of the request was computed and then thrown away, on every job that has ever run.
  const named = (KLEO_STYLES as readonly string[]).includes(p.style ?? "") && !p.style_guessed;
  // ONE LOOK (13 September 2026): every new job is realistic, and neither the direction's choice nor the keyword
  // guess can move it. A row that carries another style — an old job, or an internal test of the planner's
  // families — is still planned in its own look, so nothing already made becomes unreadable.
  const kleo: KleoStyle = named
    ? (p.style as KleoStyle)
    : (KLEO_STYLES as readonly string[]).includes(p.style ?? "") ? (p.style as KleoStyle)
    : "realistic";
  void chosen;
  const style = keouStyleFor(kleo, job.template, format);
  const brief = style === "sketch" && templateBrief.style !== "sketch"
    ? briefOf(p.duration_s <= 90 ? "explainer-short" : "explainer-long")
    : templateBrief;
  const speed = 1.1;
  const words = wordBudget(p.duration_s, speed);
  // Cinema/picture/stickman scenes carry one spoken line each in Shorts; long videos in those styles use longer lines so the scene count stays sane.
  const perLine: [number, number] = p.duration_s > 120 ? [35, 50] : [10, 18];
  const shortLine = style === "cinema" || style === "picture" || style === "stickman";
  // The explainer's line length is the style's own, at both lengths: it is what the caption rhythm was calibrated on.
  const wps: [number, number] = style === "sketch" ? EXPLAINER_WORDS[lengthOf(p.duration_s)]
    : shortLine ? (brief.style === "cinema" && p.duration_s <= 120 ? brief.wordsPerScene : perLine)
    : (brief.style === "cinema" ? [25, 40] : brief.wordsPerScene);
  return {
    style, kleo, pictures: PICTURE_STYLES.includes(kleo), product: productOf(p), brief, format, language: p.language, voice: defaultVoice(p.language, job.template, p.voice), duration: p.duration_s, speed, words,
    scenes: sceneRange(words.target, wps), maxDuration: Math.min(1800, Math.max(5, Math.round(p.duration_s * 1.6))),
    chunk: style === "cinema" || style === "picture" ? 4 : style === "sketch" ? 4 : 5, // scenes per model call: keeps every call under ~2k output tokens (Workers AI times out on long generations)
  };
}

const LANG_NAMES: Record<string, string> = { en: "English", it: "Italian", fr: "French" };
const list = (a: readonly string[]) => a.join(", ");
const editorialKinds = () => KINDS.filter((k) => !["image", "story", "cinema"].includes(k));

function systemPrompt(plan: Plan): string {
  const kinds = plan.style === "cinema" || plan.style === "picture" ? "cinema, closing" : plan.style === "stickman" ? "story, closing" : plan.style === "sketch" ? "sketch" : list(editorialKinds());
  const lang = LANG_NAMES[plan.language] ?? plan.language;
  const rules = plan.style === "picture" ? SHOT_RULES : plan.style === "cinema" ? CINEMA_RULES : plan.style === "stickman" ? STICKMAN_RULES
    : plan.style === "sketch" ? explainerRules(plan.format, plan.duration) : EDITORIAL_RULES;
  const pictures = plan.style === "picture" ? `\n${PICTURE_RULES[plan.kleo as keyof typeof PICTURE_RULES]}` : "";
  const enums = plan.style === "picture"
    ? `shot kinds: ${list(SHOT_KINDS)}. accents: ${list(CINEMA_ACCENTS)}.`
    : plan.style === "stickman"
    ? `acts: ${list(STORY_ACTS)}. cast: ${list(STORY_CAST)}. props: ${list(STORY_PROPS)}. fx: ${list(STORY_FX)}. accents: ${list(STORY_ACCENTS)}.`
    : `beat kinds: ${list(BEAT_KINDS)}. icons: ${list(BEAT_ICONS)}. fx: ${list(BEAT_FX)}. accents: ${list(CINEMA_ACCENTS)}. visuals: ${list(VISUALS)}.`;
  return `You are Kleo's storyboard writer for the Keou motion-design renderer. You output ONE JSON object and nothing else: no prose, no markdown fences, standard JSON with double-quoted keys and strings (never single quotes, never Python dict syntax).
The video is a Keou project in the "${plan.style}" style (Kleo look: ${plan.kleo}), ${plan.format}, ${plan.duration} seconds, narrated in ${lang} by a text-to-speech voice.
Allowed scene kinds for this style: ${kinds}. The LAST scene of the video must have kind "closing".
${rules}${pictures}
Enums (use these exact strings, nothing else): ${enums}
Never use scene kind "image", never reference files or URLs. Scene ids are unique lowercase slugs like "01-hook". Text limits are hard limits, count characters. Narration and all on-screen text are in ${lang}; enum values stay in English.${plan.style === "picture" ? ` EVERY "image_prompt" IS WRITTEN IN ENGLISH whatever the narration's language: the picture model reads English only, and a prompt in ${lang} is drawn wrong.` : ""} Write the narration as spoken language: no emojis, no hashtags, no URLs, no stage directions. Do not invent quotes from real people.`;
}

/**
 * The request as every stage sees it — and, when the film has one, the treatment under it. `full` adds the prose
 * for the two stages that shape the film (direction, outline); the scene chunks get the structured block only.
 */
function contextBlock(job: PlanJob, plan: Plan, treatment?: Treatment | null, full = false): string {
  const t = findTemplate(job.template);
  return `TEMPLATE: ${t?.name ?? job.template} (${job.template}). BRIEF: ${plan.brief.guidance}
USER REQUEST (the video is about this; keep every fact, name and constraint from it):
"""${job.prompt.trim()}"""${treatment ? `\n${treatmentBlock(treatment, full)}` : ""}`;
}

/* ------------------------------------------------------------------ the direction: step zero of the reasoning */

/**
 * The direction call. It runs BEFORE the outline and it is the only stage that reads the user's request as a request
 * rather than as raw material: what they asked for, who it is for, what they said that must survive into the finished
 * narration, what world the film is drawn in, what must never appear in it, and which colour owns which stretch.
 *
 * It also picks the look, in words and with a reason. That decision used to be three regular expressions over the
 * first 1,500 characters of the prompt, in fixed precedence, falling back to cartoon: "the history of hacking, told as
 * a bedtime story" matched CYBER_WORDS and came back as dark motion design with no pictures at all, and nothing
 * anywhere recorded that a choice had been made.
 */
/**
 * THE SHAPE OF THE FILM, TAKEN FROM THE TEMPLATE INSTEAD OF ASKED FOR.
 *
 * The direction used to make the model invent how many sections a film has, what colour each one wears and how the
 * scenes divide between them — and then repairDirection patched the arithmetic when the counts did not add up, which
 * they often did not. That was a retry spent on sums, and sums are not what a model is for.
 *
 * src/templates.ts now holds the narrative shape of every template (narrativeFor) and divides the scenes between its
 * sections without ever leaving one empty (sceneSplit, measured at 3, 6, 12, 30 and 60 scenes on all twelve
 * templates). So the shape arrives already correct and the model is asked only the part that depends on the SUBJECT:
 * what this section is called in this story, and what its colour stands for here.
 *
 * The two rules the direction is validated against — the sections tile the film, and no two neighbours share an
 * accent — hold by construction: every family's weights add to 1 and no family repeats an accent side by side.
 */
export function sectionSkeleton(template: string, scenes: number): { name: string; role: string; accent: string; scenes: number }[] {
  const f: Family = narrativeFor(template);
  // A FILM SHORTER THAN ITS OWN SHAPE. sceneSplit gives every section at least one scene, so a five-section family
  // asked for three scenes returns five — it cannot tile, and the direction built on it would be refused. When there
  // are not enough scenes to go round, the film uses fewer sections: the FIRST and the LAST always survive (the hook
  // and the ending are the two a viewer actually feels), and the widest of the middle ones fill whatever is left.
  // Dropping from the end instead — which is what a plain truncation does — takes the closing, the one part the
  // planner does not know is load-bearing.
  let sections = f.sections;
  if (scenes < sections.length) {
    const middle = sections.slice(1, -1)
      .map((sec, i) => ({ sec, i: i + 1 }))
      .sort((a, b) => b.sec.weight - a.sec.weight)
      .slice(0, Math.max(0, scenes - 2))
      .sort((a, b) => a.i - b.i)
      .map((x) => x.sec);
    sections = scenes <= 1 ? [sections[0]] : [sections[0], ...middle, sections[sections.length - 1]];
  }
  const trimmed: Family = { ...f, sections };
  const split = sceneSplit(trimmed, scenes);
  return sections.map((sec, i) => ({ name: sec.name, role: sec.role, accent: sec.accent, scenes: split[i] ?? 1 }));
}

/* Exported for scripts/direction-measure, the bench that asks the real model to choose a look and counts how often
   it is right. Nothing else imports these three, and nothing about them changed to make them exportable: a number
   measured on a copy of the prompt is a number about the copy. */
export function directionPrompt(job: PlanJob, plan: Plan, treatment?: Treatment | null): string {
  const t = findTemplate(job.template);
  const scenes = Math.max(plan.scenes[0], Math.min(plan.scenes[1], Math.round((plan.scenes[0] + plan.scenes[1]) / 2)));
  const skeleton = sectionSkeleton(job.template, scenes);
  const lang = LANG_NAMES[plan.language] ?? plan.language;
  // With a treatment, the direction is no longer the first reader of the request: the angle, the world and the
  // narrator have been decided, and the direction writes the cast, the objects and the exclusions INSIDE them.
  const under = treatment ? `\n${treatmentBlock(treatment, true)}\nThe direction is written UNDER this treatment: its subject is the treatment's angle, its world is the treatment's visual language, its tone is the narrator's register, and its sections are the treatment's acts fitted to the shape below.\n` : "";
  return `USER REQUEST (read it as a request, not as raw material):
"""${job.prompt.trim()}"""
TEMPLATE: ${t?.name ?? job.template}. LENGTH: ${plan.duration} seconds, about ${scenes} scenes, narrated in ${lang}.
${under}
TASK: write the DIRECTION of this one film, before any scene exists. Return one JSON object:

{"style":"cartoon|realistic|animation|cyber|explainer|stickman","why":"<=90 chars, why that look fits THIS request",
 "direction":{
  "subject":"<=${DL.subject}, the one thing the video is about, in the user's own terms",
  "goal":"<=${DL.goal}, what the viewer should understand or feel by the end",
  "audience":"<=${DL.audience}, who is watching",
  "tone":"<=${DL.tone}, e.g. calm and factual / playful / ominous",
  "must_keep":[up to ${DL.mustKeep.max} strings <=${DL.mustKeep.len}: facts, names, numbers and constraints COPIED FROM THE REQUEST that the finished narration must still say. Use [] if the request states none. Never invent one.],
  "world":"<=${DL.world}, the place, period and material everything is drawn in — one sentence a picture can be built from",
  "cast":[up to ${DL.cast.max} {"name":"<=${DL.cast.name}, how the narration refers to them","look":"<=${DL.cast.look}, the ONE description reused word for word in every picture that shows them"}],
  "objects":[${DL.objects.min}-${DL.objects.max} strings <=${DL.objects.len}: the object vocabulary of THIS film and nothing else — pirates: beach, sand, chest, red-sailed ship; space: rocket, launch pad, orbital station],
  "forbidden":[${DL.forbidden.min}-${DL.forbidden.max} strings <=${DL.forbidden.len}: what must NEVER appear. Name the things a picture generator adds by habit and the things that belong to a DIFFERENT subject than this one],
  "sections":[${skeleton.length} objects, ONE PER SECTION BELOW, in the same order: {"name":"<=${DL.sections.name} UPPERCASE, the section's name FOR THIS FILM","means":"<=${DL.sections.means}, what its colour stands for in this story"}]}}

THE SHAPE OF THIS FILM IS ALREADY DECIDED — you write what goes in it, not how many parts it has:
${skeleton.map((x, i) => `  ${i + 1}. ${x.name} · ${x.scenes} scene${x.scenes === 1 ? "" : "s"} · accent ${x.accent} — ${x.role}`).join("\n")}
Return exactly ${skeleton.length} sections, in that order. The scene counts and the colours are not yours to choose: they come from the ${t?.name ?? job.template} shape and they already add up to ${scenes}. Give each one the name it deserves in THIS story and say what its colour stands for here.

RULES
- must_keep is quoted from the request. If the user wrote "5 mistakes", "in Naples", "for beginners" or a number, it goes in must_keep and the narration must still contain it.
- Do not invent sections, drop them or reorder them: the shape above is the one this kind of film has. Colour means a new part of the story, nothing else.
- forbidden is what makes a film its own. A pirate film forbids modern objects, wifi symbols, phones, screens and logos; a film about a city forbids the objects of every other city. Write it for THIS video.
- CHOOSE THE STYLE BY THE SHAPE OF THE ANSWER THE REQUEST IS ASKING FOR, never by its topic. The same subject can want two different looks, so asking "is this about security" answers nothing.
  · cartoon — the answer is a STORY with people in it, told in order: someone did something and here is what happened. Kids, history, animals, travel, tales.
  · realistic — the answer is a PLACE or a THING you could photograph: products, cities, news events, sport, a documentary about something that exists.
  · animation — the answer wants to be DRAWN as a 2D animated film: a fairy tale, a talking animal, a world that does not exist, the inside of something no camera enters, or the user asked for animation, a cartoon or anime by name.
  · cyber — the answer has STRUCTURE TO DIAGRAM: a flow with steps, a comparison of two things, a list, a set of numbers. Icons and big type, no pictures at all.
  · explainer — the answer is ONE IDEA TAKEN APART until the viewer believes something different at the end: one mechanism, one object, one misconception, and nothing to list or compare. Hand-drawn line art where every spoken phrase has its own literal drawing. The words "explain", "why", "how" in a request do NOT choose it — most requests for cyber and realistic say "explain" too. What chooses it is that the answer is a single thing and the viewer's belief about it changes.
  · stickman — only if the user asked for a stickman by name.
  THE LINE BETWEEN cyber AND explainer IS THE ONE THAT MATTERS, and it is not the subject and not the verb. Ask: does the answer have PARTS? A flow from one named thing to the next, a breakdown into shares or percentages, several items, two things compared, a set of steps or numbers — that is cyber, whatever the request calls it. "Show how our data goes from the app to the servers to third parties" is cyber: three named parts and a flow between them. "Break down how much of a phone bill is the network" is cyber: shares of a whole. "The five costliest cyberattacks in history" is cyber: five items with figures. "Explain what a VPN is to my mother" is explainer: one thing, no parts, and she ends up believing something new. And a photographable subject with no mechanism in it — bread going mouldy, choosing a mattress, a place, a product — is realistic even when the request says "explain why". Decide which of these the request looks like before you decide anything else about it.
- Everything you write here is in ${lang} except the enum values (style, accent) and THE PICTURE FIELDS — "world", every cast "name" and "look", "objects" and "forbidden" — which are written in ENGLISH whatever the film speaks: they are pasted into every picture prompt, and the picture model reads English only ("la pasticcera" becomes "the pastry chef").`;
}

export const directionSchema = (): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  required: ["style", "direction"],
  properties: {
    style: { type: "string", enum: [...KLEO_STYLES] },
    why: str,
    direction: {
      type: "object",
      additionalProperties: false,
      required: ["subject", "goal", "audience", "tone", "must_keep", "world", "cast", "objects", "forbidden", "sections"],
      properties: {
        subject: str, goal: str, audience: str, tone: str, world: str,
        must_keep: strArr, objects: strArr, forbidden: strArr,
        cast: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "look"], properties: { name: str, look: str } } },
        // No accent and no scene count: those come from the template's shape, so the model cannot get them wrong.
        sections: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["name", "means"], properties: { name: str, means: str } },
        },
      },
    },
  },
});

/**
 * The model's answer, fitted to the contract's limits — and married to the shape the template already decided.
 *
 * What this no longer does is arithmetic. It used to drop sections, move scenes between them and swap accents around
 * until the counts tiled the film, because the model had been asked to invent all of that and regularly did not add
 * up. The skeleton arrives correct now, so the only thing left is to take the name and the meaning the model wrote
 * for each section and put them on it. A model that returns too few sections gets the skeleton's own names for the
 * rest; one that returns too many has the extras ignored.
 */
function repairDirection(raw: unknown, template: string, scenes: number): Direction | null {
  if (!isObj(raw)) return null;
  const cut = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
  const cutList = (v: unknown, max: number, len: number): string[] => {
    const seen = new Set<string>();
    return strs(v, 10_000).map((x) => cut(x, len)).filter((x) => { const k = x.toLowerCase(); if (!x || seen.has(k)) return false; seen.add(k); return true; }).slice(0, max);
  };
  const written = (Array.isArray(raw.sections) ? raw.sections : []).filter(isObj);
  const sections: Section[] = sectionSkeleton(template, scenes).map((bone, i) => {
    const w = written[i] ?? {};
    return {
      name: cut(w.name, DL.sections.name) || bone.name,
      means: cut(w.means, DL.sections.means) || bone.role.slice(0, DL.sections.means),
      accent: bone.accent,
      scenes: bone.scenes,
    };
  });
  const d: Direction = {
    subject: cut(raw.subject, DL.subject), goal: cut(raw.goal, DL.goal), audience: cut(raw.audience, DL.audience),
    tone: cut(raw.tone, DL.tone), world: cut(raw.world, DL.world),
    must_keep: cutList(raw.must_keep, DL.mustKeep.max, DL.mustKeep.len),
    objects: cutList(raw.objects, DL.objects.max, DL.objects.len),
    forbidden: cutList(raw.forbidden, DL.forbidden.max, DL.forbidden.len),
    cast: (Array.isArray(raw.cast) ? raw.cast : []).filter(isObj).slice(0, DL.cast.max)
      .map((m) => ({ name: cut(m.name, DL.cast.name), look: cut(m.look, DL.cast.look) })).filter((m) => m.name && m.look),
    sections,
  };
  return directionProblems(d, { accents: CINEMA_ACCENTS, scenes }).length ? null : d;
}

/** The direction as the block every later prompt carries: this is what keeps twelve pictures inside one film. */
function directionBlock(d: Direction): string {
  return `DIRECTION OF THIS FILM (decided already; obey it, do not restate it and do not contradict it):
Subject: ${d.subject}
Goal: ${d.goal}   Audience: ${d.audience}   Tone: ${d.tone}
World (everything is drawn here): ${d.world}
${d.cast.length ? `Cast, described the SAME WAY every time they appear:\n${d.cast.map((m) => `  - ${m.name}: ${m.look}`).join("\n")}\n` : ""}Objects this film may show: ${d.objects.join(", ")}
NEVER show: ${d.forbidden.join(", ")}
${d.must_keep.length ? `The narration MUST still say all of this, in the viewer's hearing:\n${d.must_keep.map((f) => `  - ${f}`).join("\n")}` : ""}`;
}

/**
 * The scene an unplaced fact belongs to: the one whose summary shares the most content words with it, never the
 * closing (a fact stated for the first time in the sign-off is a fact the video never really made). Ties go to the
 * earliest scene, so a forgotten fact lands early enough to be built on rather than tacked on.
 */
function bestSceneFor(fact: string, outline: OutlineEntry[]): number {
  const wordsOf = (t: string) => new Set((t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 3));
  const want = wordsOf(fact);
  let best = 0, bestScore = -1;
  outline.forEach((e, i) => {
    if (e.kind === "closing" && outline.length > 1) return;
    let score = 0;
    for (const w of wordsOf(`${e.summary} ${e.label}`)) if (want.has(w)) score++;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return best;
}

/** Outline entry: what the model plans for one scene before writing it. */
interface OutlineEntry { id: string; kind: string; label: string; accent?: string; summary: string; words: number; keeps: number[] }

function outlinePrompt(job: PlanJob, plan: Plan, n: number, d: Direction | null, treatment?: Treatment | null): string {
  const perScene = Math.round(plan.words.target / n);
  const cin = plan.style === "cinema" || plan.style === "picture", stick = plan.style === "stickman", sk = plan.style === "sketch";
  const kind = cin ? "cinema" : stick ? "story" : sk ? "sketch" : "<kind>";
  const label = cin ? "chapter ≤32 like 01 HOOK" : stick ? "situation ≤32 like 01 THE SETUP" : sk ? "section ≤32 like 01 THE CARD" : "UPPERCASE eyebrow ≤40";
  // With a direction the accent is NOT the model's to choose: the sections already own the colours, and the outline is
  // told which scene sits in which section. Colour that follows the mood of whoever wrote the scene is decoration;
  // colour that follows the structure of the film is something a viewer can actually read.
  const owners = d ? sectionOfScene(d.sections, n) : [];
  const sectionMap = d
    ? `\nSECTIONS (fixed; every scene wears its section's accent, and you do not choose accents):\n${owners.map((s, i) => `  scene ${i + 1}: ${s?.name ?? "—"} · accent ${s?.accent ?? "green"} (${s?.means ?? ""})`).join("\n")}`
    : "";
  const keeps = d?.must_keep.length
    ? `\nFACTS TO PLACE (from the user's own request; every one must be said out loud somewhere in the video):\n${d.must_keep.map((f, i) => `  [${i}] ${f}`).join("\n")}\nGive each scene a "keeps" array with the indexes of the facts THAT scene will state. Every index must appear on exactly one scene.`
    : "";
  return `${contextBlock(job, plan, treatment, true)}${d ? `\n${directionBlock(d)}` : ""}${sectionMap}${keeps}
TASK: plan the whole video as an outline of exactly ${n} scenes, in order.${treatment ? " The outline follows the treatment's acts in order: the opening image is scene 1, each act gets scenes in proportion to its seconds, and the last scene is the treatment's ending." : ""} The narration will total about ${plan.words.target} words (${perScene} per scene on average; the hook and the closing may be shorter, key scenes longer). Return {"title":"<video title ≤120>","description":"<YouTube description, one paragraph>","tags":["…"],"scenes":[{"id":"01-slug","kind":"${kind}","label":"<${label}>",${cin ? '"accent":"<accent>",' : ""}"summary":"<what this scene says, ≤25 words>","words":<narration words for this scene>${d?.must_keep.length ? ',"keeps":[<fact indexes>]' : ""}}, …]}.
${cin ? `Chapters group scenes (several scenes may share a chapter label)${d ? "; copy each scene's accent from the section table above" : "; accents follow the mood"}.` : stick ? "Each scene is one situation the stickman can act out." : sk ? "Every scene is one drawn moment, and each one has to make the next one necessary." : "Vary the kinds: never more than two of the same kind in a row, at least four different kinds overall; use metric for numbers, compare for two-sided points, steps/list for three-part points, quote for a memorable line, hero for openings and transitions."} ${sk ? "There is NO closing scene: the film ends on its last drawing, so the last scene is the payoff itself." : `The last scene has kind "closing".`} The first scene is the hook.`;
}

function chunkPrompt(job: PlanJob, plan: Plan, outline: OutlineEntry[], from: number, to: number, prevVoice: string | null, feedback?: string[], d?: Direction | null, treatment?: Treatment | null): string {
  const entries = outline.slice(from, to);
  const words = entries.reduce((n, e) => n + e.words, 0);
  const total = outline.length;
  // The facts these particular scenes are on the hook for. Handing a chunk the whole list would invite it to say
  // everything twice; handing it none is how a fact quietly disappears between two chunks and nobody notices.
  const owed = d?.must_keep.length ? [...new Set(entries.flatMap((e) => e.keeps))].filter((i) => i >= 0 && i < d.must_keep.length) : [];
  const pic = plan.style === "picture";
  const cin = plan.style === "cinema" || pic, stick = plan.style === "stickman", sk = plan.style === "sketch";
  const lineWords = plan.duration > 120 ? "35–50" : "10–18";
  const how = pic ? `Each voice line is ${plan.duration > 120 ? "two or three spoken sentences" : "one spoken sentence"} of ${lineWords} words; every scene needs ${shotRangeText("cinema")} shots (the closing exactly one), each with its own "image_prompt"; every shot after the first carries "at" with words copied from its own voice line. One picture per scene is refused: a still held for a whole line is a slideshow.`
    : cin ? `Each voice line is ${plan.duration > 120 ? "two or three spoken sentences" : "one spoken sentence"} of ${lineWords} words; every scene needs 4–8 beats of different kinds, each anchored with "at" to words of its own voice line.`
    : sk ? `Each voice line is ONE spoken sentence of ${EXPLAINER_WORDS[lengthOf(plan.duration)].join("-")} words; every scene needs 2-8 drawings, each with an "at" quoting words from its OWN line, and the last of them must land in the second half of that line. One phrase, one drawing, and the drawing is literally what the words say.`
    : stick ? `Each voice line is one spoken sentence of ${lineWords} words; every scene has an act, a cast with hero, an accent and a title; add a bubble when the character says something.`
    : "Fill the kind-specific fields exactly as the shapes show: list/steps need 3 items, compare 2 items, metric needs value and unit, quote needs quote, hero needs visual.";
  const layer = layerOf(plan, treatment);
  const layerAsk = layer
    ? `\n${graphicsBlock(layer)}\nEvery scene you write carries "hud": [${layer.hud.map((h) => h.kind === "line" ? `{"id":"${h.id}","state":"<one of the line states>"}` : h.kind === "readout" ? `{"id":"${h.id}","values":[${h.rows.map((r) => `"<${r}>"`).join(",")}]}` : `{"id":"${h.id}","value":"<one short line>"}`).join(", ")}] — the state or the values of each element AT THIS SCENE, changing only when the story changes them — and "cards": [] or one card {"at":"<words copied from this scene's voice>","text":"<the figure or date, <=28 chars>"} when a number in this scene must be read, not only heard.`
    : "";
  let msg = `${contextBlock(job, plan, treatment)}${layerAsk}${d ? `\n${directionBlock(d)}` : ""}${owed.length ? `\nTHESE SCENES OWE THESE FACTS — say each one out loud in a "voice" line:\n${owed.map((i) => `  - ${d!.must_keep[i]}`).join("\n")}` : ""}
VIDEO OUTLINE (${total} scenes; you write scenes ${from + 1}–${to} now):
${outline.map((e, i) => `${i + 1}. [${e.id}] ${e.kind} · ${e.label}${e.accent ? ` · ${e.accent}` : ""} — ${e.summary} (${e.words} words)`).join("\n")}
${prevVoice ? `The previous scene ended with this narration, continue naturally from it: "${prevVoice}"` : "This is the start of the video."}
TASK: write scenes ${from + 1}–${to} in full, in order, keeping their ids, kinds${cin ? ", chapters (as \"chapter\") and accents" : stick ? " and titles" : sk ? " and accents" : " and eyebrows"} from the outline. Their narration together totals about ${words} words (${entries.map((e) => `${e.id}: ${e.words}`).join(", ")}). ${how}${pic ? ` Each "image_prompt" is one sentence, ≤${IMAGE_PROMPT_MAX} characters, with no text in the picture${plan.language !== "en" ? ", WRITTEN IN ENGLISH (only the voice is in the narration's language)" : ""}.` : ""}
Return {"scenes":[…]} with exactly ${entries.length} scene objects and nothing else.`;
  if (feedback?.length) msg += `\n\nYOUR PREVIOUS ANSWER WAS REJECTED by the validator with these problems (scene numbers count within the scenes you returned, "beat n" counts inside that scene). Fix every one of them and return all ${entries.length} scenes again:\n- ${feedback.join("\n- ")}`;
  return msg;
}

/** JSON schemas for response_format (kept flat: no oneOf, so constrained decoding stays cheap). */
const str = { type: "string" };
const strArr = { type: "array", items: str };

/** Every property the contract knows, closed with additionalProperties:false (open objects let the grammar accept
 * garbled keys). Junk the model puts in irrelevant properties is removed per kind by normalizeStoryboard. */
function sceneSchema(plan: Plan, layer: Graphics | null = null): Record<string, unknown> {
  if (plan.style === "sketch") return explainerSceneSchema();
  if (plan.style === "picture") {
    const shot = {
      type: "object",
      properties: { image_prompt: str, caption: str, hl: str, at: str, shot_kind: { type: "string", enum: [...SHOT_KINDS] } },
      required: ["image_prompt"],
      additionalProperties: false,
    };
    return {
      type: "object",
      properties: {
        id: str, kind: { type: "string", enum: ["cinema", "closing"] }, chapter: str, accent: { type: "string", enum: [...CINEMA_ACCENTS] },
        title: str, hl: str, voice: str, hold: { type: "number" }, shots: { type: "array", items: shot }, button: str,
        // The layer's per-scene fields exist in the schema only when the film has a layer: a grammar that offers
        // "hud" to a film with no elements decodes into states for nothing.
        ...(layer ? sceneHudSchema(layer) : {}),
      },
      required: ["id", "kind", "chapter", "accent", "title", "hl", "voice", "shots", ...(layer ? ["hud", "cards"] : [])],
      additionalProperties: false,
    };
  }
  if (plan.style === "cinema") {
    const beat = {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...BEAT_KINDS] }, at: str, name: { type: "string", enum: [...BEAT_ICONS] }, fx: { type: "string", enum: [...BEAT_FX] },
        size: { type: "number" }, label: str, text: str, hl: str, slam: { type: "boolean" }, icon: { type: "string", enum: [...BEAT_ICONS] },
        lines: strArr, items: strArr, lit: { type: "integer" }, total: { type: "integer" }, labels: strArr, values: { type: "array", items: { type: "integer" } },
        icons: { type: "array", items: { type: "string", enum: [...BEAT_ICONS] } }, count: { type: "integer" }, toggles: strArr,
      },
      required: ["kind"],
      additionalProperties: false,
    };
    return {
      type: "object",
      properties: {
        id: str, kind: { type: "string", enum: ["cinema", "closing"] }, chapter: str, accent: { type: "string", enum: [...CINEMA_ACCENTS] },
        title: str, hl: str, voice: str, hold: { type: "number" }, beats: { type: "array", items: beat }, detail: str,
      },
      required: ["id", "kind", "chapter", "accent", "title", "hl", "voice", "beats"],
      additionalProperties: false,
    };
  }
  if (plan.style === "stickman") {
    return {
      type: "object",
      properties: {
        id: str, kind: { type: "string", enum: ["story", "closing"] }, act: { type: "string", enum: [...STORY_ACTS] },
        cast: { type: "array", items: { type: "string", enum: [...STORY_CAST] } }, props: { type: "array", items: { type: "string", enum: [...STORY_PROPS] } },
        fx: { type: "string", enum: [...STORY_FX] }, accent: { type: "string", enum: [...STORY_ACCENTS] }, bubble: str, hl: str, title: str, voice: str, hold: { type: "number" },
      },
      required: ["id", "kind", "act", "cast", "accent", "title", "voice"],
      additionalProperties: false,
    };
  }
  return {
    type: "object",
    properties: {
      id: str, kind: { type: "string", enum: editorialKinds() }, eyebrow: str, title: str, voice: str, visual: { type: "string", enum: [...VISUALS] },
      items: strArr, value: str, unit: str, animate_value: { type: "boolean" }, quote: str, detail: str, source: str, button: str, hold: { type: "number" },
    },
    required: ["id", "kind", "eyebrow", "title", "voice"],
    additionalProperties: false,
  };
}

function outlineSchema(plan: Plan, facts = 0): Record<string, unknown> {
  const cin = plan.style === "cinema" || plan.style === "picture"; // both plan chapters and accents, scene kinds cinema/closing
  const entry: Record<string, unknown> = {
    type: "object",
    properties: {
      id: str, kind: { type: "string", enum: cin ? ["cinema", "closing"] : plan.style === "stickman" ? ["story", "closing"] : plan.style === "sketch" ? ["sketch"] : editorialKinds() }, label: str,
      ...(cin ? { accent: { type: "string", enum: [...CINEMA_ACCENTS] } } : {}), summary: str, words: { type: "integer" },
      // "keeps" only exists when the direction listed facts to place: an empty enum is not a schema a grammar can decode.
      ...(facts ? { keeps: { type: "array", items: { type: "integer" } } } : {}),
    },
    required: ["id", "kind", "label", "summary", "words", ...(cin ? ["accent"] : [])],
    additionalProperties: false,
  };
  return {
    type: "object",
    properties: { title: str, description: str, tags: strArr, scenes: { type: "array", items: entry } },
    required: ["title", "description", "scenes"],
    additionalProperties: false,
  };
}

const chunkSchema = (plan: Plan, layer: Graphics | null = null): Record<string, unknown> => ({
  type: "object", properties: { scenes: { type: "array", items: sceneSchema(plan, layer) } }, required: ["scenes"], additionalProperties: false,
});

/* ------------------------------------------------------------------ normalisation */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Drops null/empty values (JSON mode emits them for optional keys), trims strings, recursively. */
function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clean).filter((x) => x !== undefined);
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [rawKey, val] of Object.entries(v)) {
      const k = rawKey.trim().replace(/\?$/, ""); // models sometimes emit "at " or "label?" as keys
      const c = clean(val);
      if (!k || c === undefined || c === null || c === "" || (Array.isArray(c) && c.length === 0)) continue;
      out[k] = c;
    }
    return out;
  }
  if (typeof v === "string") { const s = v.trim(); return s === "" ? undefined : s; }
  return v;
}

const slug = (s: unknown, i: number) => {
  const base = typeof s === "string" ? s.toLowerCase().normalize("NFD").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") : "";
  return base || `s${i + 1}`;
};

/** Closest drawable icon for names the models like to invent; anything else drops the beat. */
const ICON_SYNONYMS: Record<string, string> = {
  battery: "phone", charger: "phone", power: "phone", smartphone: "phone", mobile: "phone", app: "phone", screen: "phone",
  cold: "wave", snow: "wave", ice: "wave", winter: "wave", signal: "wave", wifi: "wave", bluetooth: "wave", sound: "wave", voice: "wave",
  temperature: "timer", heat: "alarm", fire: "alarm", warning: "alarm", alert: "alarm", danger: "alarm", siren: "alarm", bell: "alarm",
  error: "cross", fail: "cross", failure: "cross", wrong: "cross", no: "cross", stop: "cross", success: "check", ok: "check", yes: "check", done: "check", growth: "check", chart: "check", graph: "check", trophy: "check", star: "check",
  time: "clock", hour: "clock", calendar: "clock", speed: "timer", stopwatch: "timer", hourglass: "timer",
  network: "radar", science: "radar", lab: "radar", chemistry: "radar", scan: "radar", search: "radar", satellite: "radar", globe: "radar", world: "radar",
  server: "desk", computer: "keyboard", laptop: "keyboard", code: "keyboard", key: "keyfob", password: "lock", padlock: "lock", secure: "shield", security: "shield", protect: "shield",
  door: "house", home: "house", building: "house", office: "desk", money: "pouch", cash: "pouch", wallet: "pouch", bag: "pouch", box: "pouch",
  person: "figure", user: "figure", people: "figure", man: "figure", woman: "figure", you: "figure", brain: "figure", idea: "figure", question: "figure",
  hacker: "thief", scammer: "thief", attacker: "thief", criminal: "thief", virus: "bug", malware: "bug", glitch: "bug",
  vehicle: "car", truck: "car", road: "car", cup: "coffee", mug: "coffee", finger: "hand", touch: "hand", click: "hand", jacket: "hoodie", amp: "amplifier", speaker: "amplifier", radio: "amplifier",
};
const iconFor = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const k = v.trim().toLowerCase();
  if ((BEAT_ICONS as readonly string[]).includes(k)) return k;
  return ICON_SYNONYMS[k] ?? ICON_SYNONYMS[k.replace(/s$/, "")] ?? null;
};
const inSet = (v: unknown, set: readonly string[]) => typeof v === "string" && set.includes(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const strs = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "" && x.length <= max) : []);
/** Cuts narration at a sentence boundary so it fits the contract (350 chars) instead of failing the whole plan. */
function fitVoice(v: string, max = 350): string {
  if (v.length <= max) return v;
  const head = v.slice(0, max);
  const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.lastIndexOf(".\n"));
  return cut > max * 0.4 ? head.slice(0, cut + 1) : head.slice(0, head.lastIndexOf(" ")) + ".";
}
const BEAT_KEYS: Record<string, string[]> = {
  icon: ["name", "fx", "size", "label", "at"], type: ["text", "hl", "slam", "icon", "fx", "at", "mono"], terminal: ["lines", "label", "enter", "at"],
  steps: ["items", "lit", "at"], people: ["total", "lit", "label", "last", "at"], bars: ["labels", "values", "at"], timeline: ["labels", "icons", "at"],
  dialog: ["text", "count", "at"], cta: ["label", "toggles", "at"], split: ["items", "fx", "label", "at"], grid: ["items", "label", "at"],
};
const SCENE_KEYS: Record<string, string[]> = { list: ["items"], steps: ["items"], compare: ["items"], metric: ["value", "unit", "animate_value"], quote: ["quote"], closing: ["button"] };
const KIND_ONLY_KEYS = ["items", "value", "unit", "animate_value", "quote", "button"];

/** Keeps only what the contract reads for this beat kind and drops beats missing their required fields. */
function repairBeat(b: Record<string, unknown>, voice: string): Record<string, unknown> | null {
  const k = typeof b.kind === "string" ? b.kind.toLowerCase() : "";
  const keys = BEAT_KEYS[k];
  if (!keys) return null;
  const out: Record<string, unknown> = { kind: k };
  for (const key of keys) if (key in b) out[key] = b[key];
  if (k === "icon") { const n = iconFor(out.name ?? b.icon); if (!n) return null; out.name = n; }
  if (k === "type") {
    if (typeof out.text !== "string") return null;
    let text = out.text;
    if (text.length > 40) text = text.slice(0, 40).replace(/\s+\S*$/, "") || text.slice(0, 40);
    out.text = text;
    if (typeof out.hl !== "string" || out.hl.length > 20 || !text.toLowerCase().includes(out.hl.toLowerCase())) delete out.hl;
    if ("icon" in out) { const n = iconFor(out.icon); if (n) out.icon = n; else delete out.icon; }
    if ("slam" in out && typeof out.slam !== "boolean") out.slam = Boolean(out.slam);
    if ("mono" in out && typeof out.mono !== "boolean") delete out.mono;
  }
  if (k === "terminal") {
    const lines = strs(out.lines, 48).filter(printableStr).slice(0, 4);
    if (!lines.length) return null;
    out.lines = lines;
    if (typeof out.label !== "string" || out.label.length > 16) delete out.label;
    if ("enter" in out && typeof out.enter !== "boolean") delete out.enter;
  }
  if (k === "steps") {
    const items = strs(out.items, 14).slice(0, 4);
    if (items.length < 2) return null;
    out.items = items;
    if (!isInt(out.lit) || out.lit < 0 || out.lit > items.length) delete out.lit;
  }
  if (k === "people") {
    if (!isInt(out.total)) return null;
    const total = Math.min(12, Math.max(0, out.total));
    out.total = total;
    out.lit = isInt(out.lit) ? Math.min(total, Math.max(0, out.lit)) : total;
    if (typeof out.label !== "string" || out.label.length > 32) delete out.label;
    if ("last" in out && typeof out.last !== "boolean") delete out.last;
  }
  if (k === "bars") {
    const labels = strs(out.labels, 14).slice(0, 4);
    const values = Array.isArray(out.values) ? out.values.map((v) => (typeof v === "number" ? Math.round(Math.min(1000000, Math.max(0, v))) : NaN)) : [];
    if (!labels.length || labels.length !== values.length || values.some((v) => !Number.isFinite(v))) return null;
    out.labels = labels; out.values = values;
  }
  if (k === "timeline") {
    const labels = strs(out.labels, 14).slice(0, 4);
    if (labels.length < 2) return null;
    out.labels = labels;
    const icons = Array.isArray(out.icons) ? out.icons.map(iconFor) : null;
    if (icons && icons.length === labels.length && icons.every(Boolean)) out.icons = icons; else delete out.icons;
  }
  if (k === "dialog") {
    if (typeof out.text !== "string") return null;
    if (out.text.length > 32) out.text = out.text.slice(0, 32).replace(/\s+\S*$/, "") || out.text.slice(0, 32);
    if (!isInt(out.count) || out.count < 1 || out.count > 5) delete out.count;
  }
  if (k === "cta") {
    if (typeof out.label !== "string" || out.label.length > 24) delete out.label;
    const t = strs(out.toggles, 14).slice(0, 3);
    if (t.length) out.toggles = t; else delete out.toggles;
  }
  if (k === "split" || k === "grid") {
    const items = (Array.isArray(out.items) ? out.items : []).map(iconFor).filter((x): x is string => !!x);
    if (items.length < 2) return null;
    out.items = items.slice(0, k === "split" ? 2 : 3);
  }
  if ((k === "icon" || k === "split" || k === "grid") && (typeof out.label !== "string" || out.label.length > 24)) delete out.label;
  if ("fx" in out && !inSet(out.fx, BEAT_FX)) delete out.fx;
  if ("size" in out && (typeof out.size !== "number" || out.size < 0.3 || out.size > 1)) delete out.size;
  if (typeof out.at === "string" && (out.at.length > 24 || !voice.includes(out.at.toLowerCase()))) delete out.at;
  return out;
}
const printableStr = (x: string) => ![...x].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);

/** Cuts a prompt to the contract's length at a word boundary (a half word reads worse than a short prompt). */
const fitPrompt = (p: string): string => (p.length <= IMAGE_PROMPT_MAX ? p : p.slice(0, IMAGE_PROMPT_MAX).replace(/\s+\S*$/, "").trim() || p.slice(0, IMAGE_PROMPT_MAX));

/**
 * Keeps only what the picture style reads on a shot and drops shots without a usable image_prompt.
 * `first` shots may not carry "at" (they open the scene), an "at" that is not in the voice is dropped like a beat's,
 * and an "hl" that does not colour a word of this shot's caption is meaningless, so it goes too.
 */
function repairShot(sh: Record<string, unknown>, voice: string, first: boolean): Record<string, unknown> | null {
  const written = typeof sh.image_prompt === "string" ? fitPrompt(sh.image_prompt.trim()) : "";
  if (written.length < IMAGE_PROMPT_MIN) return null;
  // NOTHING IN THE FRAME MAY BE DEAD. A picture with no subject doing anything comes back frozen once the shot is a
  // generated clip and not a photograph — measured at 0.03 px of movement on an RTX 6000 Ada, which is a still image
  // with a timestamp. So a still description has one movement added to it, built from what it already shows. It is
  // repaired and not refused, for the same reason the camera is: a refusal costs a round trip, a repair costs nothing.
  const prompt = enliven(written, IMAGE_PROMPT_MAX);
  const out: Record<string, unknown> = { image_prompt: prompt };
  if (typeof sh.caption === "string" && sh.caption.trim() && sh.caption.length <= SHOT_CAPTION_MAX && printableStr(sh.caption)) out.caption = sh.caption.trim();
  if (typeof sh.hl === "string" && sh.hl.trim() && sh.hl.length <= SHOT_HL_MAX && typeof out.caption === "string" && String(out.caption).toLowerCase().includes(sh.hl.trim().toLowerCase())) out.hl = sh.hl.trim();
  // The cut has to be whole words of the narration (quotesVoice, the way engine/picture.js aligns a shot): a fragment
  // ("ver came") anchors nothing and the validator rejects it, so it is dropped here rather than costing a round trip.
  const at = typeof sh.at === "string" ? sh.at.trim() : "";
  if (!first && at && at.length <= SHOT_AT_MAX && quotesVoice(at, voice)) out.at = at;
  // The author writes what the shot is FOR, never how the camera moves: a hand-written "motion" (in/out/left/right)
  // is dropped without comment, and only a kind of the shot grammar survives. assignShotKinds fills in the rest.
  if (inSet(sh.shot_kind, SHOT_KINDS)) out.shot_kind = sh.shot_kind;
  return out;
}

/** Deterministic repairs that never change the story: forced job fields, slugs, anchors, holds, xor button/detail. */
export function normalizeStoryboard(raw: unknown, plan: Plan): unknown {
  const c = clean(raw);
  if (!isObj(c)) return c;
  for (const f of FORBIDDEN_FIELDS) delete c[f];
  c.schema_version = 1;
  c.editorial_status = "ready";
  c.format = plan.format;
  c.language = plan.language;
  c.voice = plan.voice;
  c.speed = plan.speed;
  if (c.music !== "none") c.music = "bed";
  c.max_duration = plan.maxDuration;
  delete c.width; delete c.fps; delete c.brand;
  c.style = plan.style;
  c.kleo_style = plan.kleo;
  // The layer: kept only over a filmed picture and only when it is a layer; a film with one takes no music bed.
  if (isObj(c.graphics)) {
    const layer = plan.style === "picture" ? repairGraphics(c.graphics) : null;
    if (layer) { c.graphics = layer; c.music = "none"; } else delete c.graphics;
  } else delete c.graphics;
  // THE FOURTH SIDE OF ONE DECISION. templates.ts already decides what a style costs, what card it needs and how
  // many may run at once; this is where the storyboard asks the worker to go and FILM the shots instead of drawing
  // one picture and moving a window over it. It is derived from that same table, never from a second list, so the
  // day realistic becomes VIDEO there it starts asking to be filmed here on its own and cannot be forgotten.
  // Declaring it is a request and never a promise: the worker takes the backdrop straight off again if even one
  // shot will not film, and delivers the stills instead.
  // The deletion is not tidiness. Without it a storyboard that arrived with `backdrop: "video"` already on it would
  // be filmed at the price of a style that is not, which is a seven-credit render sold for one.
  // The product is the third term (15 September): an animatic is the same plan, drawn, and never asks to be filmed.
  if (filmedStoryboard(plan.kleo, plan.style, plan.product)) c.backdrop = "video";
  else delete c.backdrop;
  // THE COLOUR LAW IS ARITHMETIC, SO IT IS REPAIRED, NOT REFUSED. Every scene wears the accent of the section it sits
  // in; a model that wrote a different one is corrected here rather than bounced back, because a retry spent on
  // copying a colour out of a table is a retry not spent on the story. The validator still refuses a mismatch, which
  // is what catches a CLIENT-written storyboard: there the author chose both, and a mismatch is a real contradiction.
  const colourLaw = plan.style === "picture" || plan.style === "cinema" || plan.style === "sketch";
  if (colourLaw && isObj(c.direction) && Array.isArray((c.direction as Record<string, unknown>).sections) && Array.isArray(c.scenes)) {
    const sections = (c.direction as unknown as Direction).sections;
    sectionOfScene(sections, (c.scenes as unknown[]).length).forEach((sec, i) => {
      const scene = (c.scenes as Record<string, unknown>[])[i];
      // The explainer draws with five colours and the direction plans in the cinema four: map, do not copy.
      if (sec && isObj(scene) && "accent" in scene) scene.accent = plan.style === "sketch" ? sketchAccent(sec.accent) : sec.accent;
    });
  }
  if (typeof c.title === "string" && c.title.length > 120) c.title = c.title.slice(0, 117) + "…";
  if (Array.isArray(c.scenes)) {
    const seen = new Set<string>();
    c.scenes = c.scenes.filter(isObj).map((s, i) => {
      let id = slug(s.id, i).slice(0, 50);
      // "-s" followed by a number is reserved for the picture ids ("<sceneId>-s1"), so a model id like "part-s2"
      // would fail the contract: rename it instead of spending a round trip on it.
      if (SHOT_ID_SUFFIX_RE.test(id)) id = id.replace(SHOT_ID_SUFFIX_RE, (m) => `-p${m.slice(2)}`);
      if (seen.has(id)) id = `${id.slice(0, 44)}-${i + 1}`;
      seen.add(id);
      s.id = id;
      if (typeof s.hold === "number") s.hold = Math.min(3, Math.max(plan.style === "sketch" ? 0.05 : 0.15, s.hold)); else delete s.hold;
      if (s.kind === "closing" && s.button && s.detail) delete s.detail;
      if (typeof s.voice === "string") s.voice = fitVoice(s.voice);
      if (typeof s.eyebrow === "string" && s.eyebrow.length > 40) s.eyebrow = s.eyebrow.slice(0, 40).trim();
      if (typeof s.chapter === "string" && s.chapter.length > 32) s.chapter = s.chapter.slice(0, 32).trim();
      if (typeof s.source === "string" && s.source.length > 80) delete s.source;
      if (typeof s.detail === "string" && s.detail.length > 110) delete s.detail;
      if (typeof s.hl === "string" && s.hl.length > 24) delete s.hl;
      if ("visual" in s && !inSet(s.visual, VISUALS)) delete s.visual;
      if ("accent" in s && plan.style !== "sketch" && !inSet(s.accent, plan.style === "stickman" ? STORY_ACCENTS : CINEMA_ACCENTS)) delete s.accent;
      // Pictures: the picture style keeps shots (and only shots), every other style keeps none (image is never accepted from a model).
      delete s.image; delete s.image_credit;
      // The explainer is repaired in one place, in src/explainer-plan.ts, and skips every branch below: it shares no
      // field with the other looks — no chapter, no title, no beats, no shots, and no closing scene at all.
      if (plan.style === "sketch") return repairExplainerScene(s, plan.format);
      if (plan.style === "picture") {
        delete s.beats; delete s.eyebrow; delete s.visual; delete s.detail; delete s.source;
        for (const key of KIND_ONLY_KEYS) if (key !== "button") delete s[key];
        // validateShots also reads chapter and hl: a blank one, or a number the model wrote there, is dropped rather than failing the scene.
        for (const key of ["chapter", "hl"]) if (key in s && (typeof s[key] !== "string" || !(s[key] as string).trim())) delete s[key];
        if (s.kind !== "closing") { s.kind = "cinema"; delete s.button; }
        else if (typeof s.button !== "string" || !s.button.trim() || s.button.length > CLOSING_BUTTON_MAX) delete s.button;
        if (typeof s.title === "string" && s.title.length > 90) s.title = s.title.slice(0, 90).replace(/\s+\S*$/, "").trim() || s.title.slice(0, 90);
        const spoken = typeof s.voice === "string" ? s.voice.toLowerCase() : "";
        const raw = Array.isArray(s.shots) ? s.shots : typeof s.image_prompt === "string" ? [{ image_prompt: s.image_prompt }] : []; // old format: one picture per scene
        delete s.image_prompt;
        const shots = raw.filter(isObj).map((sh, i) => repairShot(sh, spoken, i === 0)).filter((x): x is Record<string, unknown> => !!x).slice(0, SHOTS_PER_SCENE[s.kind === "closing" ? "closing" : "cinema"][1]);
        if (shots.length) delete shots[0].at; // a dropped first shot must not promote its "at" to the opening one
        // Last resort so the scene still renders: the title becomes the picture. The validator asks the model for real shots first.
        else if (typeof s.title === "string" && s.title.trim().length >= IMAGE_PROMPT_MIN) shots.push({ image_prompt: fitPrompt(s.title.trim()) });
        s.shots = shots;
        // Every cut lands on a spoken word, including the ones whose anchor the author quoted wrongly and repairShot
        // dropped. Filling them here is what makes the rule affordable: the alternative was a retry per bad quote.
        anchorShots(s);
        // The layer's per-scene fields, fitted to the film's own elements; without a layer they cannot exist.
        const layer = isObj(c.graphics) ? repairGraphics(c.graphics) : null;
        if (layer) {
          const hud = repairSceneHud(layer, s.hud); if (Object.keys(hud).length) s.hud = hud; else delete s.hud;
          const cards = repairCards(s.cards, spoken); if (cards.length) s.cards = cards; else delete s.cards;
        } else { delete s.hud; delete s.cards; }
      } else {
        delete s.shots; delete s.image_prompt; // only the picture style draws pictures, and it keeps them on its shots
      }
      if (plan.style === "stickman") {
        delete s.beats; delete s.chapter; delete s.eyebrow; delete s.visual;
        for (const key of KIND_ONLY_KEYS) delete s[key];
        if (s.kind !== "closing") s.kind = "story";
        if (s.kind === "story") {
          if (!inSet(s.act, STORY_ACTS)) delete s.act;
          const cast = (Array.isArray(s.cast) ? s.cast : []).filter((x): x is string => inSet(x, STORY_CAST));
          s.cast = ["hero", ...[...new Set(cast)].filter((x) => x !== "hero")].slice(0, 3);
          const props = [...new Set((Array.isArray(s.props) ? s.props : []).filter((x): x is string => inSet(x, STORY_PROPS)))].slice(0, 3);
          if (props.length) s.props = props; else delete s.props;
          if ("fx" in s && !inSet(s.fx, STORY_FX)) delete s.fx;
        } else { delete s.act; delete s.cast; delete s.props; delete s.fx; }
        if (typeof s.bubble !== "string" || s.bubble.length > 40 || !printableStr(s.bubble)) delete s.bubble;
        if (typeof s.hl !== "string" || s.hl.length > 24 || !printableStr(s.hl)) delete s.hl;
        if (typeof s.title === "string" && s.title.length > 90) s.title = s.title.slice(0, 90).replace(/\s+\S*$/, "").trim() || s.title.slice(0, 90);
      } else if (plan.style !== "cinema" && plan.style !== "picture") {
        const keep = SCENE_KEYS[s.kind as string] ?? [];
        for (const key of KIND_ONLY_KEYS) if (!keep.includes(key) && key in s) delete s[key];
        if (s.kind === "metric" && s.animate_value === true && !/^\d+(?:,\d{3})*(?:\.\d+)?[^\d]*$/.test(String(s.value ?? ""))) delete s.animate_value;
        if (s.kind === "metric" && "animate_value" in s && typeof s.animate_value !== "boolean") delete s.animate_value;
        delete s.beats;
        if (typeof s.title === "string" && s.title.length > 90) s.title = s.title.slice(0, 90).replace(/\s+\S*$/, "").trim() || s.title.slice(0, 90);
        const downgrade = () => { s.kind = "hero"; for (const key of KIND_ONLY_KEYS) delete s[key]; };
        if (s.kind === "list" || s.kind === "steps" || s.kind === "compare") {
          const n = s.kind === "compare" ? 2 : 3;
          const items = strs(s.items, 42);
          if (items.length >= n) s.items = items.slice(0, n); else downgrade();
        } else if (s.kind === "metric") {
          if (typeof s.value === "string" && s.value.length <= 12 && typeof s.unit === "string" && s.unit.length <= 45) { /* ok */ } else downgrade();
        } else if (s.kind === "quote") {
          if (typeof s.quote !== "string" || s.quote.length > 120) { if (typeof s.title === "string" && s.title.length <= 120) s.quote = s.title; else downgrade(); }
        }
      }
      const voice = typeof s.voice === "string" ? s.voice.toLowerCase() : "";
      if (Array.isArray(s.beats)) {
        const beats = s.beats.filter(isObj).map((b) => repairBeat(b, voice)).filter((b): b is Record<string, unknown> => !!b).slice(0, 8);
        s.beats = beats.length || typeof s.title !== "string" ? beats : [{ kind: "type", text: s.title.slice(0, 40), slam: true }];
      }
      return s;
    });
    // No closing at all: the last scene becomes the closing (content kept).
    const scenes = c.scenes as Record<string, unknown>[];
    if (plan.style === "sketch") repairExplainer(scenes, plan.format, plan.language);
    else if (scenes.length && !scenes.some((s) => s.kind === "closing")) {
      const last = scenes[scenes.length - 1];
      last.kind = "closing";
      for (const k of ["items", "value", "unit", "quote", "animate_value", "visual", "act", "cast", "props", "fx"]) delete last[k];
      if (plan.style !== "cinema") delete last.beats;
      if (plan.style === "picture" && Array.isArray(last.shots)) last.shots = last.shots.slice(0, SHOTS_PER_SCENE.closing[1]); // a closing shows one picture, two at most
    }
    // Last, once the shots of every scene are final: the shot grammar over the whole video.
    if (plan.style === "picture") assignShotKinds(scenes, plan.format);
  }
  return c;
}

export const countWords = (sb: unknown): number =>
  isObj(sb) && Array.isArray(sb.scenes) ? sb.scenes.reduce((n: number, s) => n + (isObj(s) && typeof s.voice === "string" ? s.voice.split(/\s+/).filter(Boolean).length : 0), 0) : 0;

/* ------------------------------------------------------------------ model call */

interface AiRunner { run(model: string, inputs: Record<string, unknown>): Promise<unknown> }

function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { throw new Error(`the model returned broken JSON (${String(e).slice(0, 80)}): …${t.slice(Math.max(0, t.length - 160))}`); }
  }
  throw new Error(`the model did not return JSON: ${t.slice(0, 200)}`);
}

/**
 * One model call. 0.3 is the temperature of everything that must be a valid document (the direction, the outline,
 * the scenes); the treatment call passes its own, because a treatment written at 0.3 is the same treatment every
 * time, and being different every time is half of what it is for.
 */
export async function callModel(env: Env, model: string, messages: { role: string; content: string }[], schema: Record<string, unknown>, maxTokens: number, temperature = 0.3, timeoutMs = MODEL_CALL_TIMEOUT_MS): Promise<{ raw: unknown; usage: Usage }> {
  const ai = env.AI as unknown as AiRunner;
  const base = { messages, max_tokens: maxTokens, temperature };
  let res: unknown;
  try {
    res = await withTimeout(ai.run(model, { ...base, response_format: { type: "json_schema", json_schema: schema } }), timeoutMs, `model call (${model})`);
  } catch (e) {
    // Models without JSON mode (or a schema the grammar engine rejects): plain call, lenient parse.
    if (!/json|schema|response_format|unsupported|invalid/i.test(String(e))) throw e;
    res = await withTimeout(ai.run(model, base), timeoutMs, `model call (${model})`);
  }
  const r = isObj(res) ? res : {};
  const usage = (isObj(r.usage) ? r.usage : {}) as Usage;
  let raw: unknown = r.response;
  // Chat-completions shaped models: gpt-oss-120b on Workers AI answers {choices:[{message:{content}}]} (measured
  // 13 September with a JSON schema; ten treatments came back "not a JSON object" because this branch was missing).
  if (raw === undefined && Array.isArray(r.choices)) {
    const msg = (r.choices[0] as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined;
    if (typeof msg?.content === "string") raw = msg.content;
  }
  if (raw === undefined && Array.isArray(r.output)) { // Responses-API shaped models (gpt-oss)
    const msg = (r.output as Record<string, unknown>[]).find((o) => o.type === "message");
    const content = Array.isArray(msg?.content) ? (msg!.content as Record<string, unknown>[]).find((x) => typeof x.text === "string") : null;
    raw = content?.text;
  }
  if (typeof raw === "string") raw = extractJson(raw);
  return { raw, usage };
}

/* ------------------------------------------------------------------ the English pass */

/** The translator's own system prompt: a JSON object and nothing else, like every other stage. */
export const TRANSLATOR_SYSTEM = `You translate the art direction of a film into plain English for an image generator. You output ONE JSON object and nothing else: no prose, no markdown fences, standard JSON with double-quoted keys and strings.`;

/** The picture fields of a direction, to be returned in English with the same shape (same array lengths and order). */
export function englishFieldsPrompt(d: Direction, language: string): string {
  const fields = { world: d.world, cast: (d.cast ?? []).map((m) => ({ name: m.name, look: m.look })), objects: d.objects ?? [], forbidden: d.forbidden ?? [] };
  return `These fields of a film's art direction are pasted into the prompts of an image generator that reads English only. They may be written in ${LANG_NAMES[language] ?? language} or already in English.
${JSON.stringify(fields)}
TASK: return the same object with every value in natural English: "world" as one sentence, each cast "name" as the English way of naming that character (e.g. "la pasticcera" → "the pastry chef"), each cast "look" as a plain visual description, "objects" and "forbidden" as English nouns. Keep a value that is already English exactly as it is. Keep every array the same length and order, add nothing, explain nothing.`;
}
export const englishFieldsSchema = (): Record<string, unknown> => ({
  type: "object", additionalProperties: false,
  properties: {
    world: { type: "string" },
    cast: { type: "array", items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, look: { type: "string" } }, required: ["name", "look"] } },
    objects: { type: "array", items: { type: "string" } },
    forbidden: { type: "array", items: { type: "string" } },
  },
  required: ["world", "cast", "objects", "forbidden"],
});
/**
 * Writes the translated picture fields into the direction, field by field, keeping what it had wherever the answer
 * is missing, empty, not English after all, or of another length. Exported for the test; pure apart from `d`.
 */
export function applyEnglishFields(d: Direction, raw: unknown): void {
  if (!isObj(raw)) return;
  const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() && !notEnglish(v) ? v.trim().slice(0, max) : null);
  const list = (v: unknown, was: readonly string[], len: number): string[] | null => {
    if (!Array.isArray(v) || v.length !== was.length) return null;
    const out = v.map((x, i) => text(x, len) ?? was[i]);
    return out;
  };
  const world = text(raw.world, DL.world); if (world) d.world = world;
  const cast: unknown[] = Array.isArray(raw.cast) ? raw.cast : [];
  if (Array.isArray(raw.cast) && cast.length === (d.cast ?? []).length)
    d.cast = (d.cast ?? []).map((m, i) => { const c: Record<string, unknown> = isObj(cast[i]) ? (cast[i] as Record<string, unknown>) : {}; return { name: text(c.name, DL.cast.name) ?? m.name, look: text(c.look, DL.cast.look) ?? m.look }; });
  const objects = list(raw.objects, d.objects ?? [], DL.objects.len); if (objects) d.objects = objects;
  const forbidden = list(raw.forbidden, d.forbidden ?? [], DL.forbidden.len); if (forbidden) d.forbidden = forbidden;
}

/** The picture prompts a chunk wrote in the narration's language, to come back in English, one for one. */
export function englishPromptsPrompt(prompts: readonly string[], language: string): string {
  return `These are descriptions of pictures for an image generator that reads English only. They are written in ${LANG_NAMES[language] ?? language}.
${JSON.stringify({ prompts })}
TASK: return {"prompts":[…]} with each description translated into natural English, one sentence each, same meaning, same order, exactly ${prompts.length} strings. Keep a description that is already English exactly as it is. Translate the words, never the picture: add nothing, drop nothing, no text or letters in the picture.`;
}
export const englishPromptsSchema = (): Record<string, unknown> => ({ type: "object", additionalProperties: false, properties: { prompts: { type: "array", items: { type: "string" } } }, required: ["prompts"] });

/* ------------------------------------------------------------------ fixture */

/**
 * Shots for the fixture's scenes (the cinema example short-relay-cinema, turned into a picture-style storyboard), so
 * local runs with IMAGE_FIXTURE=1 exercise several pictures per scene. The second shot's cut ("at") is derived from
 * the scene's own voice line at build time, so the fixture can never quote a word the example no longer says.
 */
const FIXTURE_SHOTS: Record<string, { image_prompt: string; caption?: string; hl?: string; shot_kind?: ShotKind }[]> = {
  "01-gone": [
    { image_prompt: "A quiet suburban driveway at dawn, an empty parking spot with tyre marks on the wet tarmac, a house with one kitchen window lit", caption: "THE CAR IS GONE", hl: "GONE", shot_kind: "hook" },
    { image_prompt: "A car key lying on a wooden kitchen bench next to a fruit bowl, seen from close by, warm morning light through the window", shot_kind: "detail" },
  ],
  "02-relay": [
    // Two people interacting with a prop: the routing rule pins this one whatever it says here.
    { image_prompt: "Two hooded figures at night on a quiet street, one crouching by a front door holding a small boxy amplifier with a short antenna", shot_kind: "tension" },
    { image_prompt: "A close view of the small boxy amplifier left on a dark doorstep, a faint blue arc of signal bending towards the house behind it", shot_kind: "detail" },
  ],
  "03-believes": [
    { image_prompt: "A sleek modern car in a driveway at night, its headlights switching on by themselves, the dark house reflected in the windscreen", shot_kind: "establish" },
    { image_prompt: "The same car pulling away down an empty street at night, red tail lights, the driveway left empty behind it", shot_kind: "action" },
  ],
  "04-test": [
    { image_prompt: "A long row of shiny new cars in a bright test hall, orange cones on the floor, clean industrial light from above", caption: "850 CARS TESTED", hl: "850", shot_kind: "establish" },
    { image_prompt: "A single car alone under a bright overhead lamp in the empty test hall, orange cones around it, cold neutral light", shot_kind: "detail" },
  ],
  "05-fix": [
    { image_prompt: "A small dark fabric pouch on a wooden kitchen bench, a car key dropping into it, soft daylight from the side", caption: "DROP THE KEY IN", hl: "KEY", shot_kind: "reveal" },
    { image_prompt: "The closed pouch on the bench with the key inside, the house quiet around it, calm warm light", shot_kind: "detail" },
  ],
  "06-loop": [
    { image_prompt: "A wide car park at sunset seen from above, rows of cars of many colours, one empty lane leading out, calm warm sky", shot_kind: "closing" },
  ],
};
/**
 * A verbatim run of whole words from a voice line: a legal "at" anchor for the fixture's later shots.
 * It starts on a word boundary (a slice by character can begin mid-word, and "ver came" anchors no cut) and the
 * result is checked with the contract's own quotesVoice, so the fixture can only ever carry an anchor the engine
 * and the validator both accept. Nothing fits (a very short or wordless line) → null, and the shot simply keeps
 * no "at", which is legal on every shot but the first.
 */
function fixtureAnchor(voice: unknown): string | null {
  if (typeof voice !== "string") return null;
  const words: { from: number; to: number }[] = [];
  const re = /\S+/g;
  for (let m = re.exec(voice); m; m = re.exec(voice)) words.push({ from: m.index, to: m.index + m[0].length });
  if (words.length < 2) return null;
  const mid = Math.floor(words.length / 2);
  const order = words.map((_, i) => i);
  // Prefer the second half (the cut lands late in the line), then walk back towards the start; two words, else one.
  const starts = order.slice(mid).concat(order.slice(0, mid).reverse());
  for (const i of starts) {
    for (const n of [2, 1]) {
      const last = words[i + n - 1];
      if (!last) continue;
      const at = voice.slice(words[i].from, last.to);
      if (at.length <= SHOT_AT_MAX && quotesVoice(at, voice)) return at;
    }
  }
  return null;
}

/** The cinema example adapted to a job's format/language/voice (local dev and tests; never calls AI). Cartoon look: picture style with shots. */
/**
 * The direction of the fixture film (relay car theft, six scenes). `must_keep` is deliberately empty: the fixture must
 * stay valid whatever the example's narration says, and the fidelity gate is proven by its own unit tests instead.
 * The last section absorbs any scene the example gains or loses, so this never has to be edited in two places.
 */
const FIXTURE_DIRECTION = (scenes: number): Direction => {
  const sections: Section[] = [
    { name: "01 THE LOSS", accent: "red", means: "what was taken", scenes: 1 },
    { name: "02 THE METHOD", accent: "cyan", means: "how it is done", scenes: 2 },
    { name: "03 THE PROOF", accent: "amber", means: "how often it works", scenes: 1 },
    { name: "04 THE FIX", accent: "green", means: "what stops it", scenes: Math.max(1, scenes - 4) },
  ];
  return {
    subject: "Keyless car theft by signal relay, and the pouch that stops it",
    goal: "The viewer understands that the car believes the key is close, and puts their key in a pouch tonight",
    audience: "Ordinary car owners with a keyless car",
    tone: "Calm and factual, never alarmist",
    must_keep: [],
    world: "A quiet suburban street at night and a plain kitchen at dawn, ordinary houses, ordinary cars, cold blue night light and warm morning light",
    cast: [],
    objects: ["car key", "signal pouch", "driveway", "front door", "relay amplifier", "kitchen bench", "parked car", "test hall"],
    forbidden: ["wifi symbol", "lock icon", "shield icon", "computer screen", "hacker in a hood at a laptop", "text or numbers in the picture", "brand logo", "real person"],
    sections,
  };
};

export function fixtureStoryboard(job: PlanJob): Storyboard {
  const p = JSON.parse(job.params) as JobParams;
  const sb = structuredClone(cinemaExample) as Record<string, unknown>;
  for (const f of FORBIDDEN_FIELDS) delete sb[f];
  delete sb.width; delete sb.fps; delete sb.brand;
  const kleo: KleoStyle = p.style === "realistic" || p.style === "animation" || p.style === "cyber" ? p.style : "cartoon"; // the example is a cinema project: stickman cannot be faked
  sb.kleo_style = kleo;
  const pictures = PICTURE_STYLES.includes(kleo);
  if (pictures) sb.style = "picture";
  // Same rule as the planned path, so the fixture cannot quietly describe a different product from the real one.
  if (pictures && filmedStoryboard(kleo, "picture", productOf(p))) sb.backdrop = "video";
  else delete sb.backdrop;
  for (const s of sb.scenes as Record<string, unknown>[]) {
    delete s.image; delete s.image_credit;
    if (!pictures) continue;
    // The picture style has no beats and no icons: the scene is the run of its shots.
    delete s.beats; delete s.detail;
    const planned = FIXTURE_SHOTS[String(s.id)] ?? [{ image_prompt: `A simple scene about ${String(s.title ?? "the story")}, no text` }];
    const at = fixtureAnchor(s.voice);
    s.shots = planned.slice(0, SHOTS_PER_SCENE[s.kind === "closing" ? "closing" : "cinema"][1]).map((sh, i) => (i && at ? { ...sh, at } : { ...sh }));
    if (s.kind === "closing") s.button = "Subscribe";
  }
  // The fixture carries a direction too, so every path that uses it exercises the colour law and the picture context
  // rather than testing a shape production never sees. The sections tile the example's six scenes exactly, and each
  // scene's accent is overwritten from its section: that is the law, applied, not described.
  const direction = FIXTURE_DIRECTION((sb.scenes as unknown[]).length);
  sb.direction = direction;
  sectionOfScene(direction.sections, (sb.scenes as unknown[]).length).forEach((sec, i) => {
    const scene = (sb.scenes as Record<string, unknown>[])[i];
    if (sec && scene && "accent" in scene) scene.accent = sec.accent;
  });
  sb.format = p.format;
  sb.language = p.language;
  sb.voice = defaultVoice(p.language, job.template, p.voice);
  sb.speed = 1.1;
  sb.music = "bed";
  sb.max_duration = Math.min(1800, Math.max(5, Math.round(p.duration_s * 1.6)));
  sb.description = `${String(sb.description)}\n\n(fixture storyboard for job ${job.id}: ${job.prompt.slice(0, 80)})`;
  // The hand-written kinds above go through the same grammar as a generated one: the routing rule pins the two
  // hooded figures to a static hold, and the sequencing rules are proven on the fixture every time it is built.
  if (pictures) assignShotKinds(sb.scenes as Record<string, unknown>[], p.format);
  const r = validateStoryboard(sb, { format: p.format, language: p.language });
  if (!r.ok) throw new StoryboardError("fixture storyboard is invalid: " + r.errors.join("; "), r.errors);
  return finishForProduct(r.storyboard as unknown as Record<string, unknown>, productOf(p)) as unknown as Storyboard;
}

/* ------------------------------------------------------------------ entry point */

export function useFixture(env: Env): boolean {
  return env.STORYBOARD_FIXTURE === "example" || !env.AI;
}

/** A temporary closing so a chunk of scenes can be validated as a project on its own. */
const TEMP_CLOSING = (plan: Plan): Record<string, unknown> =>
  plan.style === "picture"
    ? { id: "zz-temp-closing", kind: "closing", chapter: "99 END", accent: "green", title: "end", hl: "end", voice: "the end", shots: [{ image_prompt: "an empty stage at the end of the story" }] }
    : plan.style === "cinema"
    ? { id: "zz-temp-closing", kind: "closing", chapter: "99 END", accent: "green", title: "end", hl: "end", voice: "the end", beats: [{ kind: "cta" }] }
    : plan.style === "sketch"
    ? { id: "zz-temp-closing", kind: "sketch", accent: "white", voice: "and that is the end of it.", shot: { zoom: [1, 1.2], focus: [540, 860] }, art: [{ name: "blank", drawn: true }] }
    : { id: "zz-temp-closing", kind: "closing", title: "end", voice: "the end" };

function header(plan: Plan, outline: { title?: unknown; description?: unknown; tags?: unknown }, direction?: Direction | null, treatment?: Treatment | null): Record<string, unknown> {
  return {
    schema_version: 1, editorial_status: "ready", title: outline.title, description: outline.description, tags: outline.tags,
    style: plan.style, kleo_style: plan.kleo, format: plan.format, language: plan.language, voice: plan.voice, speed: plan.speed, music: "bed", max_duration: plan.maxDuration,
    // The direction travels with the storyboard: the picture prompts read it (src/images.ts), the validator holds the
    // scenes to it, and the worker passes it through untouched, so a render can only ever ignore it, never trip on it.
    ...(direction ? { direction } : {}),
    // So does the treatment: it is how a finished video can be read back to the film it was meant to be.
    ...(treatment ? { treatment } : {}),
    // And the layer the treatment decided, when the film is a picture to draw it over. A film with a layer goes
    // through the engine's mix (worker film_overlay), which would put the old music bed under the narration: none.
    ...(layerOf(plan, treatment) ? { graphics: layerOf(plan, treatment), music: "none" } : {}),
  };
}

export interface GenerateOptions { model?: string }

/**
 * Outline first (title, description, one entry per scene), then the scenes in chunks of 4–5, each chunk
 * validated on its own and retried (up to 3 tries) with the validator's feedback; the assembled project is validated last.
 */
export async function generateStoryboard(env: Env, job: PlanJob, opts: GenerateOptions = {}): Promise<PlanResult> {
  const t0 = Date.now();
  let plan = planFor(job);
  if (useFixture(env)) {
    const sb = fixtureStoryboard(job);
    return { storyboard: sb, model: "fixture", attempts: 0, ms: Date.now() - t0, usage: {}, est_neurons: 0, words: countWords(sb), scenes: sb.scenes.length, fixture: true, history: [], style: kleoStyleOf(sb), direction: (sb as { direction?: Direction }).direction ?? null, treatment: null, missing_facts: [], blocked_upgrade: null };
  }
  const model = opts.model || env.AI_MODEL || DEFAULT_MODEL;
  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const history: string[][] = [];
  let calls = 0;
  // The system prompt is rebuilt whenever the plan changes, because the direction is allowed to change the look and
  // the system prompt is where the look's rules live: a cartoon storyboard written under the cyber rules is garbage.
  let system = systemPrompt(plan);
  const deadline = t0 + PLAN_BUDGET_MS;
  const call = async (user: string, schema: Record<string, unknown>, maxTokens: number, over: { system?: string; temperature?: number; model?: string } = {}) => {
    const left = deadline - Date.now();
    if (left < 5_000) throw new PlanBudgetError(`planning ran past its ${PLAN_BUDGET_MS / 60_000}-minute budget after ${calls} model calls`, [`planning took longer than ${PLAN_BUDGET_MS / 60_000} minutes (${calls} model calls): the planning model is slow right now, and the attempt is retried`]);
    calls++;
    const out = await callModel(env, over.model ?? model, [{ role: "system", content: over.system ?? system }, { role: "user", content: user }], schema, maxTokens, over.temperature, Math.min(MODEL_CALL_TIMEOUT_MS, left));
    usage.prompt_tokens! += out.usage.prompt_tokens ?? 0; usage.completion_tokens! += out.usage.completion_tokens ?? 0; usage.total_tokens! += out.usage.total_tokens ?? 0;
    return out.raw;
  };
  const fail = (errors: string[], draft?: unknown): never => { throw new StoryboardError(`storyboard invalid (${model}, ${calls} calls): ${errors.join("; ")}`, errors, draft); };
  let transient: unknown = null; // the last quota/outage error: reported instead of a storyboard problem

  // -1. THE TREATMENT. Before the direction, before anything: the request expanded into the film a producer would
  //     make of it (src/treatment.ts). A caller that wrote or approved one through kleo_adapt_prompt hands it in as
  //     params.treatment and it is used as it is — the user saw THAT film, so that is the film that gets planned.
  //     Otherwise it is written here, at a temperature that lets two identical requests come out as two films, under
  //     a draw taken from the job id. Like the direction it is allowed to fail: a film without a treatment is what
  //     Kleo made until 14 September, not a broken film.
  let treatment: Treatment | null = treatmentOf(JSON.parse(job.params));
  // The look the job was made in: the treatment is written for it, and refused if it names the other one.
  const planLook: FilmLook | null = (FILM_LOOKS as readonly string[]).includes(plan.kleo) ? (plan.kleo as FilmLook) : null;
  if (!treatment) {
    const v = variationFor(job.id);
    let feedback: string[] | undefined;
    for (let attempt = 1; attempt <= 2 && !treatment; attempt++) {
      let raw: unknown;
      try { raw = clean(await call(treatmentPrompt({ prompt: job.prompt, duration_s: plan.duration, format: plan.format, language: plan.language, look: planLook }, v, feedback), treatmentSchema(), TREATMENT_MAX_TOKENS, { system: MASTER_PROMPT, temperature: TREATMENT_TEMPERATURE, model: env.TREATMENT_MODEL || undefined })); }
      catch (e) { if (e instanceof PlanBudgetError) throw e; history.push([`treatment: model call failed: ${String(e).slice(0, 200)}`]); if (isTransientAiError(e)) { transient = e; break; } continue; }
      // The second answer is held to the lenient rule: a short prose is asked to be fixed once, then kept.
      const t = repairTreatment(raw, plan.duration, v, plan.language, { lenient: attempt > 1, look: planLook });
      if (!t) { feedback = treatmentProblems(raw, plan.duration, plan.language, { look: planLook }); history.push([`treatment: rejected (${feedback.slice(0, 3).join("; ")})`]); continue; }
      treatment = t;
    }
    if (transient) throw transient;
  }

  // 0. THE DIRECTION. One call, before anything exists, that reads the request as a request: subject, goal, audience,
  //    tone, the facts that must survive, the world the film is drawn in, what must never appear, and which colour
  //    owns which stretch of the story. It also picks the look and says why. A film planned without it is what Kleo
  //    used to make: a list of scenes with nothing holding them together.
  //    It is allowed to fail. A direction is a large improvement, not a precondition — when the model cannot produce a
  //    valid one in two tries the planner carries on exactly as it did before, and the video still ships.
  let direction: Direction | null = null;
  /** Set when the direction wanted a dearer look than the job was priced for: the user is told, never substituted in silence. */
  let blockedUpgrade: string | null = null;
  // The explainer plans at the FEWEST scenes its budget allows. The midpoint left every line at the very
  // bottom of the 8-14 word window, and a model that is one word short of the bottom writes a caption
  // instead of a sentence — measured, on the real model: ten scenes for ninety-two words produced lines of
  // three and four words. Fewer scenes hand each line the top of the window.
  const sceneGuess = plan.style === "sketch"
    ? plan.scenes[0]
    : Math.max(plan.scenes[0], Math.min(plan.scenes[1], Math.round((plan.scenes[0] + plan.scenes[1]) / 2)));
  for (let attempt = 1; attempt <= 2 && !direction; attempt++) {
    let raw: unknown;
    try { raw = clean(await call(directionPrompt(job, plan, treatment), directionSchema(), 900)); }
    catch (e) { if (e instanceof PlanBudgetError) throw e; history.push([`direction: model call failed: ${String(e).slice(0, 200)}`]); if (isTransientAiError(e)) { transient = e; break; } continue; }
    const o = isObj(raw) ? raw : {};
    const d = repairDirection(o.direction, job.template, sceneGuess);
    if (!d) { history.push([`direction: rejected (${directionProblems(isObj(o.direction) ? o.direction : {}, { accents: CINEMA_ACCENTS, scenes: sceneGuess }).slice(0, 3).join("; ")})`]); continue; }
    direction = d;
    // The look the direction chose, unless the client named one: planFor() keeps the user's choice above everything.
    // The look the direction chose, unless the client named one — and never at a different price. The job was
    // charged at createJob on the look guessed then; every style costs the same today, but realistic becomes seven
    // times dearer the day its shots are generated video, and a silent switch across that line would either bill a
    // user for a video they did not ask for or hand out a dollar of GPU for one credit.
    const wanted = inSet(o.style, KLEO_STYLES) ? (o.style as KleoStyle) : null;
    if (wanted && wanted !== plan.kleo) {
      if (samePrice(wanted, plan.kleo, plan.duration)) { plan = planFor(job, wanted); system = systemPrompt(plan); }
      else {
        // NEVER A MUTE SUBSTITUTION, in either direction. Refusing the upgrade saves the money and loses the video:
        // the viewer gets the second-best look and is never told a better one existed. So the refusal speaks, and it
        // speaks in the user's terms — what it would have chosen, what that costs, and the one word that gets it.
        const asked = creditsFor(plan.duration, wanted), paid = creditsFor(plan.duration, plan.kleo);
        blockedUpgrade = `Kleo would have used the "${wanted}" look for this, but it costs ${asked} credits instead of ${paid}, and the video was already charged at ${paid}. It is being made as "${plan.kleo}". To get "${wanted}", cancel with kleo_cancel_job and ask again with style: "${wanted}".`;
        history.push([blockedUpgrade]);
      }
    }
  }
  if (transient) throw transient;

  // 0b. THE PICTURE FIELDS OF THE DIRECTION ARE ENGLISH. The world, the cast's names and looks, the objects and the
  //     forbidden list are pasted into every picture prompt and the negative prompt, and every model the GPU draws
  //     with reads English only: a look written in Italian was drawn as another woman (job gt_ad2musq5, 19 September
  //     2026). The direction prompt asks for English; this call makes sure of it on every non-English film, at
  //     temperature 0, and a field that comes back empty or too long keeps what it had. The cast NAME is translated
  //     too, because it is what castFor() looks for inside the (English) picture prompts.
  if (direction && plan.style === "picture" && plan.language !== "en") {
    try { applyEnglishFields(direction, clean(await call(englishFieldsPrompt(direction, plan.language), englishFieldsSchema(), 700, { system: TRANSLATOR_SYSTEM, temperature: 0 }))); }
    catch (e) { if (e instanceof PlanBudgetError) throw e; history.push([`english pass (direction): ${String(e).slice(0, 200)}`]); }
  }

  // 1. Outline
  const n = sceneGuess;
  let outline: OutlineEntry[] = [];
  let meta: { title?: unknown; description?: unknown; tags?: unknown } = {};
  for (let attempt = 1; attempt <= 2 && !outline.length; attempt++) {
    let raw: unknown;
    try { raw = clean(await call(outlinePrompt(job, plan, n, direction, treatment), outlineSchema(plan, direction?.must_keep.length ?? 0), 400 + n * 90)); }
    catch (e) { if (e instanceof PlanBudgetError) throw e; history.push([`outline: model call failed: ${String(e).slice(0, 200)}`]); if (isTransientAiError(e)) { transient = e; break; } continue; }
    const o = isObj(raw) ? raw : {};
    const entries = Array.isArray(o.scenes) ? o.scenes.filter(isObj) : [];
    if (entries.length < 2 || typeof o.title !== "string") { history.push([`outline: expected ${n} scenes and a title, got ${entries.length} scenes`]); continue; }
    const seen = new Set<string>();
    outline = entries.map((e, i) => {
      let id = slug(e.id, i).slice(0, 50); if (seen.has(id)) id = `${id}-${i + 1}`; seen.add(id);
      const words = typeof e.words === "number" && e.words > 3 ? Math.round(e.words) : Math.round(plan.words.target / entries.length);
      const keeps = Array.isArray(e.keeps) ? e.keeps.filter(isInt).filter((k) => k >= 0 && k < (direction?.must_keep.length ?? 0)) : [];
      return { id, kind: typeof e.kind === "string" ? e.kind : "hero", label: typeof e.label === "string" ? e.label.slice(0, plan.style === "cinema" || plan.style === "picture" ? 32 : 40) : `PART ${i + 1}`, accent: typeof e.accent === "string" ? e.accent : undefined, summary: typeof e.summary === "string" ? e.summary : "", words, keeps };
    });
    // A fact the outline forgot to hand to anyone is handed to the scene whose summary is closest to it, and failing
    // that to the first scene that is not the closing. An unassigned fact is a fact the chunk prompts never ask for,
    // and it is exactly the silent way a video stops being about what the user wrote.
    if (direction?.must_keep.length) {
      const taken = new Set(outline.flatMap((e) => e.keeps));
      direction.must_keep.forEach((fact, idx) => {
        if (taken.has(idx)) return;
        const target = bestSceneFor(fact, outline);
        outline[target].keeps.push(idx);
      });
    }
    const bodyKind = plan.style === "cinema" || plan.style === "picture" ? "cinema" : plan.style === "sketch" ? "sketch" : "hero";
    outline.forEach((e, i) => { if (e.kind === "closing" && (plan.style === "sketch" || i < outline.length - 1)) e.kind = bodyKind; });
    if (plan.style !== "sketch") outline[outline.length - 1].kind = "closing";
    // Scale the per-scene word plan to the budget.
    const sum = outline.reduce((a, e) => a + e.words, 0) || 1;
    outline.forEach((e) => { e.words = Math.max(5, Math.round((e.words * plan.words.target) / sum)); });
    meta = { title: o.title, description: o.description, tags: o.tags };
  }
  if (transient) throw transient;
  if (!outline.length) fail(history.flat());

  // 2. Scenes, chunk by chunk
  const scenes: Record<string, unknown>[] = [];
  const head = header(plan, meta, direction, treatment);
  // A chunk is validated as a project of its own, so it holds only some of the scenes — and the direction's sections
  // are sized for the WHOLE film. Handing it the direction would fail every chunk on "the sections cover N scenes but
  // the video has M". The colour law is applied and checked once, on the assembled storyboard, where it means something.
  const chunkHead: Record<string, unknown> = { ...head };
  delete chunkHead.direction;
  const chunkSize = Math.ceil(outline.length / Math.ceil(outline.length / plan.chunk)); // even chunks: no 1-scene tail
  for (let from = 0; from < outline.length; from += chunkSize) {
    const to = Math.min(outline.length, from + chunkSize);
    const isLast = to === outline.length;
    const prevVoice = scenes.length ? String(scenes[scenes.length - 1].voice ?? "") : null;
    let feedback: string[] | undefined;
    let accepted: Record<string, unknown>[] | null = null;
    let lastDraft: unknown;
    for (let attempt = 1; attempt <= 3 && !accepted; attempt++) {
      let raw: unknown;
      const maxTokens = plan.style === "cinema" ? 700 * (to - from) : plan.style === "picture" ? 600 * (to - from) : 350 * (to - from);
      try { raw = await call(chunkPrompt(job, plan, outline, from, to, prevVoice, feedback, direction, treatment), chunkSchema(plan, layerOf(plan, treatment)), 400 + maxTokens); }
      catch (e) { if (e instanceof PlanBudgetError) throw e; history.push([`scenes ${from + 1}–${to}: model call failed: ${String(e).slice(0, 200)}`]); if (isTransientAiError(e)) throw e; feedback = undefined; continue; }
      const got = isObj(raw) && Array.isArray(raw.scenes) ? raw.scenes.filter(isObj) : [];
      // Validated in context (the scenes accepted so far + this chunk + a temporary closing unless it is the last chunk);
      // error labels are remapped so "scene n" counts within the scenes the model just returned.
      const draft = normalizeStoryboard({ ...chunkHead, scenes: [...structuredClone(scenes), ...got, ...(isLast ? [] : [TEMP_CLOSING(plan)])] }, plan) as Record<string, unknown>;
      const problems: string[] = [];
      if (got.length !== to - from) problems.push(`expected exactly ${to - from} scenes, got ${got.length}`);
      const r = validateStoryboard(draft, { format: plan.format, language: plan.language });
      const local = (m: string) => m.replace(/^scene (\d+)/, (_, n) => `scene ${Number(n) - scenes.length}`);
      const ofThisChunk = (m: string) => !/^scene (-\d+|0)\b/.test(m);
      if (!r.ok) problems.push(...r.errors.map(local).filter(ofThisChunk));
      // The validator's warnings (rhythm, a picture prompt not in English) are soft problems: asked to be fixed once,
      // then the valid chunk is kept — a video someone is waiting for is never refused on them.
      problems.push(...r.warnings.map(local).filter(ofThisChunk));
      // The scenes this chunk contributes, read from what the VALIDATOR normalised — not from the object handed to
      // it. validateStoryboard no longer writes into its input, so the shots it repaired (the anchors it chose, a
      // scene-level prompt folded into shots[0]) exist only in what it returns. Reading `draft` here would keep the
      // unrepaired draft, and the scenes accepted into the film would quietly differ from the ones it approved.
      const temp = (r.ok ? r.storyboard : r.normalised) as Record<string, unknown>;
      lastDraft = temp;
      const chunkScenes = (temp.scenes as Record<string, unknown>[]).slice(scenes.length, isLast ? undefined : -1);
      const want = outline.slice(from, to).reduce((a, e) => a + e.words, 0);
      const words = countWords({ scenes: chunkScenes });
      if (words < want * 0.55) problems.push(`the narration of these scenes is far too short: ${words} words, it must total about ${want}`);
      if (words > want * 1.6) problems.push(`the narration of these scenes is far too long: ${words} words, it must total about ${want}`);
      // Fidelity, chunk by chunk. The validator can prove a chunk is well-formed; only this can prove it is still
      // about what the user asked for. Checking it here rather than at the end means the fix costs one retry of four
      // scenes instead of a whole re-plan — and a fact that has already slipped through two chunks never comes back.
      if (direction?.must_keep.length) {
        const owed = [...new Set(outline.slice(from, to).flatMap((e) => e.keeps))].map((i) => direction!.must_keep[i]).filter(Boolean);
        const lost = missingFacts(owed, chunkScenes.map((x) => String(x.voice ?? "")).join(" "));
        for (const f of lost) problems.push(`the narration of these scenes never says "${f}", which the user asked for: put it in a "voice" line, in words the viewer will hear`);
      }
      // THE RULES ARE FUNCTIONS, NOT ADVICE. A hook and "keep it entertaining" written into a prompt are ignored by
      // every model that has ever read them, because nothing measures whether they happened. checkExplainer measures
      // it on the scenes that came back, and what it finds is what the next attempt is asked to fix — in its words.
      if (plan.style === "sketch") {
        repairExplainer(chunkScenes, plan.format, plan.language);
        for (const v of checkExplainer(chunkScenes, { duration: plan.duration, language: plan.language })) problems.push(v.message);
      }
      if (plan.style === "picture") {
        // A cinema scene that ends up with one picture holds it for the whole line: ask for the missing cuts once.
        const thin = chunkScenes.map((s, i) => (s.kind !== "closing" && (!Array.isArray(s.shots) || s.shots.length < 2) ? i + 1 : 0)).filter(Boolean);
        if (thin.length) problems.push(`scene${thin.length > 1 ? "s" : ""} ${thin.join(", ")}: only one picture; every scene needs 2–4 "shots", each with its own "image_prompt", and every shot after the first anchored with "at" to words of that scene's voice`);
        // A picture asked to draw a diagram, a screen with words or a quoted caption is sent back once: the layer
        // is where numbers and words live; the picture shows a real place, object or person (measured 14 September).
        const drawn = chunkScenes.flatMap((s, i) => (Array.isArray(s.shots) ? s.shots : []).map((sh, j) => ({ id: `scene ${i + 1} shot ${j + 1}`, image_prompt: String((sh as Record<string, unknown>).image_prompt ?? "") })));
        for (const hit of screenTextProblems(drawn)) problems.push(`${hit.id}: asks the picture to draw "${hit.term}" — no diagrams, charts, screens with words or quoted captions in a picture (numbers and words belong to the layer); describe a real place, object or person instead`);
      } else if (plan.style === "cinema") {
        const thin = chunkScenes.map((s, i) => (!Array.isArray(s.beats) || s.beats.length < 3 ? i + 1 : 0)).filter(Boolean);
        if (thin.length) problems.push(`scene${thin.length > 1 ? "s" : ""} ${thin.join(", ")}: only 1–2 beats; every scene needs 4–8 beats of different kinds, each anchored with "at"`);
      } else if (plan.style !== "stickman") {
        got.forEach((g, i) => {
          const k = chunkScenes[i]?.kind;
          if (typeof g.kind === "string" && k && g.kind !== k) problems.push(`scene ${i + 1}: kind "${g.kind}" was missing its fields (${SCENE_KEYS[g.kind]?.join(", ") ?? "see the shapes"}) and was downgraded to hero; fill them in`);
        });
      }
      // Contract errors always retry; soft problems retry once, then the valid chunk is kept.
      // A rule that is measured and then overruled is a rule the model learns to ignore. Every other look
      // takes the second answer to keep the retry budget for real errors; the explainer spends all three,
      // because its problems are exactly the ones that decide whether the film holds a viewer.
      const patient = plan.style === "sketch" ? 3 : 2;
      if (r.ok && got.length === to - from && (attempt >= patient || !problems.length)) { accepted = chunkScenes; break; }
      history.push(problems);
      feedback = problems;
    }
    if (!accepted) fail(history[history.length - 1] ?? ["no scenes"], lastDraft);
    scenes.push(...accepted!);
  }

  // 2b. THE PICTURES SPEAK ENGLISH. Whatever prompt the chunks still wrote in the narration's language is translated
  //     here, all of them in one call, before the plan is assembled: the routing rule (hands, a crowd… → a locked
  //     frame) and the forbidden-term check read English words, so they run on the translated text below, and the
  //     move the validator had resolved on the old text is dropped so it is resolved again on the new one.
  if (plan.style === "picture" && plan.language !== "en") {
    const slots: { shot: Record<string, unknown>; text: string }[] = [];
    for (const sc of scenes) if (Array.isArray(sc.shots)) for (const sh of sc.shots) if (isObj(sh) && typeof sh.image_prompt === "string" && notEnglish(sh.image_prompt)) slots.push({ shot: sh, text: sh.image_prompt });
    if (slots.length) {
      try {
        const raw = clean(await call(englishPromptsPrompt(slots.map((x) => x.text), plan.language), englishPromptsSchema(), 100 + 120 * slots.length, { system: TRANSLATOR_SYSTEM, temperature: 0 }));
        const got = isObj(raw) && Array.isArray(raw.prompts) ? raw.prompts : [];
        if (got.length !== slots.length) history.push([`english pass (pictures): expected ${slots.length} prompts, got ${got.length}`]);
        else slots.forEach((x, i) => {
          const t = got[i];
          if (typeof t !== "string" || t.trim().length < IMAGE_PROMPT_MIN || notEnglish(t)) return;
          x.shot.image_prompt = fitPrompt(t.trim());
          delete x.shot.motion; delete x.shot.strength;
        });
      } catch (e) { if (e instanceof PlanBudgetError) throw e; history.push([`english pass (pictures): ${String(e).slice(0, 200)}`]); }
    }
  }

  // 3. Assemble and validate the whole project once more (ids are re-deduplicated across chunks).
  const sb = normalizeStoryboard({ ...head, scenes }, plan);
  const r = validateStoryboard(sb, { format: plan.format, language: plan.language });
  if (!r.ok) fail(r.errors, sb);
  if (r.warnings.length) history.push(r.warnings.map((w) => `warning: ${w}`));
  const price = PRICES[model];
  const est = price ? Math.round((((usage.prompt_tokens ?? 0) * price.in + (usage.completion_tokens ?? 0) * price.out) / 1e6) / 0.000011) : null;
  const ok = r as { ok: true; storyboard: Storyboard };
  // What the finished plan still does not say. It is reported, never hidden: the owner accepts declared uncertainty
  // and refuses the hidden kind, and this is the one number that says whether the video is about what was asked.
  const missing = direction ? missingFacts(direction.must_keep, narrationOf(ok.storyboard)) : [];
  if (missing.length) history.push(missing.map((f) => `narration never says "${f}"`));
  // The product's last touch goes on AFTER the validation above: an animatic's empty layer is exactly what the
  // validator deletes as "no layer", and it has to reach the worker (templates.ts finishForProduct).
  return { storyboard: finishForProduct(ok.storyboard as unknown as Record<string, unknown>, plan.product) as unknown as Storyboard, model, attempts: calls, ms: Date.now() - t0, usage, est_neurons: est, words: countWords(ok.storyboard), scenes: ok.storyboard.scenes.length, fixture: false, history, style: plan.kleo, direction, treatment, missing_facts: missing, blocked_upgrade: blockedUpgrade };
}

/* ------------------------------------------------------------------ the treatment on its own */

/** The treatment call's own knobs: hot enough to differ, bounded enough to stay a document. */
export const TREATMENT_TEMPERATURE = 0.85;
export const TREATMENT_MAX_TOKENS = 1800;

export interface TreatmentResult {
  treatment: Treatment | null;
  model: string;
  attempts: number;
  ms: number;
  usage: Usage;
  est_neurons: number | null;
  /** Why an attempt was rejected, or why the call failed; empty when the first answer was a treatment. */
  history: string[];
  /** True when the model could not be reached (quota, outage): the caller should say so, not retry. */
  transient: boolean;
}

/**
 * The treatment alone, for kleo_adapt_prompt: the same call the planner makes at step -1, without a job. `seed`
 * decides the draw; a random one is right when no job exists yet, because the treatment then travels with the job
 * and the planner never draws again. Never throws on a model problem: the tool has to answer either way.
 */
export async function writeTreatment(env: Env, input: { prompt: string; duration_s: number; format: Format; language: string; look?: FilmLook | null }, opts: { seed?: string; model?: string } = {}): Promise<TreatmentResult> {
  const t0 = Date.now();
  const model = opts.model || env.TREATMENT_MODEL || env.AI_MODEL || DEFAULT_MODEL;
  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const history: string[] = [];
  const v = variationFor(opts.seed ?? crypto.randomUUID());
  let treatment: Treatment | null = null;
  let attempts = 0;
  let transient = false;
  let feedback: string[] | undefined;
  if (!env.AI) return { treatment: null, model, attempts, ms: 0, usage, est_neurons: 0, history: ["no AI binding"], transient: true };
  for (let attempt = 1; attempt <= 2 && !treatment; attempt++) {
    attempts++;
    let raw: unknown;
    try {
      const out = await callModel(env, model, [{ role: "system", content: MASTER_PROMPT }, { role: "user", content: treatmentPrompt(input, v, feedback) }], treatmentSchema(), TREATMENT_MAX_TOKENS, TREATMENT_TEMPERATURE);
      usage.prompt_tokens! += out.usage.prompt_tokens ?? 0; usage.completion_tokens! += out.usage.completion_tokens ?? 0; usage.total_tokens! += out.usage.total_tokens ?? 0;
      raw = clean(out.raw);
    } catch (e) {
      history.push(`model call failed: ${String(e).slice(0, 200)}`);
      if (isTransientAiError(e)) { transient = true; break; }
      continue;
    }
    const t = repairTreatment(raw, input.duration_s, v, input.language, { lenient: attempt > 1, look: input.look ?? null });
    if (!t) { feedback = treatmentProblems(raw, input.duration_s, input.language, { look: input.look ?? null }); history.push(`rejected: ${feedback.slice(0, 4).join("; ")}`); continue; }
    treatment = t;
  }
  const price = PRICES[model];
  const est = price ? Math.round((((usage.prompt_tokens ?? 0) * price.in + (usage.completion_tokens ?? 0) * price.out) / 1e6) / 0.000011) : null;
  return { treatment, model, attempts, ms: Date.now() - t0, usage, est_neurons: est, history, transient };
}
