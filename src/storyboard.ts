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
import { findTemplate } from "./templates.ts";
import {
  validateStoryboard, defaultVoice, wordBudget, type Storyboard, type Format, type KleoStyle,
  KINDS, BEAT_KINDS, BEAT_ICONS, BEAT_FX, CINEMA_ACCENTS, VISUALS, FORBIDDEN_FIELDS,
  KLEO_STYLES, PICTURE_STYLES, IMAGE_PROMPT_MAX, kleoStyleOf, STORY_ACTS, STORY_CAST, STORY_PROPS, STORY_FX, STORY_ACCENTS,
  SHOTS_PER_SCENE, SHOT_CAPTION_MAX, SHOT_HL_MAX, SHOT_AT_MAX, IMAGE_PROMPT_MIN, CLOSING_BUTTON_MAX,
  SHOT_ID_SUFFIX_RE, quotesVoice, SHOTS_MIN_CINEMA, shotRangeText, narrationOf, anchorShots,
} from "./keou-contract.ts";
/**
 * The direction: the art direction of ONE film, decided before a single scene exists. It is the step this planner
 * never had — it went straight from the user's sentence to a list of scenes, so the style came from a keyword match,
 * the world of the video was never written down, nothing said what must NOT appear, and no colour meant anything.
 */
import {
  directionProblems, missingFacts, sectionOfScene, enliven, D as DL,
  type Direction, type Section,
} from "./direction.ts";
// The shot grammar: the ten story kinds and the one preset table that turns a kind into a camera move.
// src/shot-grammar.ts is mirrored by worker/keou/shot_grammar.py; nothing here restates what that table says.
import {
  SHOT_KINDS, presetFor, durationFor, moveClassOf, directionOf, isLoud, resolveKind, LOUD_MAX_PER_WINDOW, LOUD_WINDOW_S,
  type ShotKind,
} from "./shot-grammar.ts";
import cinemaExample from "../worker/keou/examples/short-relay-cinema/project.json" with { type: "json" };

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
  /** Facts the user asked for that the finished narration still does not say. Empty is the normal case. */
  missing_facts: string[];
}

/** Errors that say nothing about the storyboard: quota, rate limit, upstream outage. The job should wait, not fail. */
export const isTransientAiError = (e: unknown): boolean => /4006|daily free allocation|429|rate limit|too many requests|5\d\d\b|ECONNRESET|fetch failed|capacity|overloaded/i.test(String(e));

export class StoryboardError extends Error {
  errors: string[];
  /** The last normalised (but invalid) storyboard, for debugging. */
  draft: unknown;
  constructor(message: string, errors: string[], draft?: unknown) { super(message); this.errors = errors; this.draft = draft; }
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

type StyleId = "cinema" | "editorial" | "technical" | "illustrated" | "stickman" | "picture";
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

const PICTURE_RULES: Record<"cartoon" | "realistic", string> = {
  cartoon: `PICTURES: this is a CARTOON video, so every "image_prompt" describes a flat vector cartoon illustration: concrete subjects and setting from the story (pirates → a beach, sand, a ship at anchor; space → a rocket, a station, planets), the SAME characters described the same way in every shot (hair, clothes, colours), bright simple shapes, one clear action per picture, a clear mood. Consecutive shots of one scene show the same place from a new angle or the next moment of the action. Never mention text, letters, numbers, logos, captions or the style itself; never name real people.`,
  realistic: `PICTURES: this is a REALISTIC video, so every "image_prompt" describes a cinematic photograph: the concrete subject and place (a rocket on the pad at dawn, a control room, a mountain road in rain), the lens feel, the light and the mood, the SAME subject described the same way in every shot, one clear action per picture. Consecutive shots of one scene show the same place from a new angle or the next moment. Never mention text, letters, numbers, logos or captions; never name or depict real people.`,
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

const BRIEFS: Record<string, Brief> = {
  "viral-short": { style: "cinema", wordsPerScene: [10, 18], guidance: "A viral Short: hook in the first sentence (a surprising claim, a number, a fear), then the reveal, the proof, the fix or twist, and a loop question at the end that sends the viewer back to the start. Short punchy sentences, one narrated line per scene." },
  "did-you-know": { style: "cinema", wordsPerScene: [10, 16], guidance: "A 'did you know' Short: one striking fact per scene, each fact a self-contained sentence with a concrete number or comparison, escalating to the most surprising one. Open with 'Did you know' or a question." },
  "reddit-story": { style: "cinema", wordsPerScene: [12, 18], guidance: "A narrated Reddit-style story told in first person: setup, rising tension, the turning point, the payoff, a one-line reaction at the end. Keep the poster's voice and details from the prompt; chapters like '01 THE SETUP', '02 THE TWIST'. Use dialog beats for things people said (≤32 chars) and figure/thief/phone/house/car icons for characters and objects." },
  "motivational": { style: "cinema", wordsPerScene: [10, 16], guidance: "A motivational piece: short declarative lines that build, a personal 'you' address, one memorable quote-like line per scene, ending on a call to act today. Accent amber/green. Type beats carry the key words in caps." },
  "cinematic-trailer": { style: "cinema", wordsPerScene: [8, 14], guidance: "A cinematic trailer: terse ominous lines, escalating stakes, chapter cards like '01 THE CALM', a title reveal near the end (a slammed type beat with the title), one last line after it. Mostly type and icon beats, red/amber accents." },
  "story-documentary": { style: "editorial", wordsPerScene: [30, 45], guidance: "A calm documentary: cold open with a striking question or scene, context, chronological chapters (eyebrow = chapter name, e.g. 'CHAPTER 2 · THE CROSSING'), dates and numbers as metric scenes, a human quote as a quote scene, consequences, and a reflective closing. Facts must be accurate and specific; say 'about' when a number is approximate." },
  "weekly-news": { style: "editorial", wordsPerScene: [30, 45], guidance: "A weekly news roundup with FOUR stories: for each story 2–4 scenes (a hero with eyebrow 'STORY 1 · <TOPIC>', then a metric/list/compare/quote scene with the key figure), and a 'source' field (≤80, the outlet or organisation) on at least one scene per story. Hard, factual, neutral tone; finish with a short 'what to watch next week' closing." },
  "explainer": { style: "technical", wordsPerScene: [30, 45], guidance: "An explainer/tutorial: the question, why it matters, the concept built step by step (steps scenes with 3 items that mirror the narration), a comparison (compare scene), one or two concrete numbers (metric scenes), common mistakes (list scene), and a recap list scene right before the closing. Clear plain language, define every term once." },
  "top-10": { style: "illustrated", wordsPerScene: [30, 45], guidance: "A countdown from #10 to #1: an intro scene, then ONE scene per entry with eyebrow '#10', '#9' … '#1' and the entry name in the title; alternate scene kinds (hero, metric for a number, compare, list, quote) so consecutive entries look different; the #1 gets the longest narration; closing asks the viewer for their own #1." },
  "product-review": { style: "illustrated", wordsPerScene: [30, 45], guidance: "A product review: what it is and who it is for, design, key specs as metric scenes, a pros list, a cons list, a compare scene versus the obvious alternative, a final score as a metric (value like '8.5', unit '/ 10 · <verdict in two words>'), and a closing with the verdict as button text. Balanced, concrete, no marketing fluff." },
};

/** Keou style for a Kleo template and format in the cyber look (cinema is portrait-first; 16:9 motivational falls back to editorial). */
export function styleFor(template: string, format: Format): StyleId {
  const b = BRIEFS[template] ?? BRIEFS.explainer;
  if (b.style === "cinema" && format === "16:9" && template !== "cinematic-trailer") return "editorial";
  return b.style;
}

/** Keou style for a Kleo style: cartoon/realistic are the "picture" style, the stickman has its own, cyber keeps the template's look. */
export function keouStyleFor(kleo: KleoStyle, template: string, format: Format): StyleId {
  if (kleo === "stickman") return "stickman";
  if (kleo === "cartoon" || kleo === "realistic") return "picture";
  return styleFor(template, format);
}

const CYBER_WORDS = /\b(cyber|security|hacker|hacking|malware|phishing|scam(?:mer)?s?|ransomware|password|vpn|encryption|crypto(?:currency)?|bitcoin|blockchain|\bai\b|artificial intelligence|machine learning|llm|chatgpt|neural|algorithm|software|coding|programming|developer|javascript|python|linux|database|cloud|startup|tech|gadget|smartphone|app|api|server|network|wifi|bluetooth|data breach|privacy|surveillance|drone|robot|quantum|computer|gpu|chip|semiconductor|keyless|relay attack)\b/i;
const REALISTIC_WORDS = /\b(product|review|unboxing|specs?|price|buy|brand|camera|laptop|headphones|car|cars|bike|watch|sneakers?|restaurant|hotel|city|cities|street|beach|mountain|travel guide|itinerary|destination|landscape|nature|photograph|news|headline|election|economy|market|stocks?|inflation|company|ceo|launch|sport|match|championship|recipe|cooking|food|fitness|workout|real estate|apartment)\b/i;
const CARTOON_WORDS = /\b(story|stories|tale|fairy|kids?|children|bedtime|cartoon|animated|pirates?|dragons?|knights?|castle|princess|wizard|monster|animals?|cats?|dogs?|dinosaurs?|space|rocket|planet|history|ancient|medieval|legend|myth|fable|adventure|treasure|island|jungle|ocean|magic|school|funny|joke)\b/i;
const REALISTIC_TEMPLATES = new Set(["product-review", "weekly-news"]);
const CYBER_TEMPLATES = new Set(["explainer"]);

/**
 * The Kleo style when the client picked none: cyber for tech/security/AI topics, realistic for products, places and news,
 * cartoon for stories, kids, travel, animals and history; otherwise the template's natural look. Never stickman (on request only).
 */
export function pickKleoStyle(template: string, prompt: string): KleoStyle {
  const text = prompt.slice(0, 1500);
  if (CYBER_WORDS.test(text)) return "cyber";
  if (CARTOON_WORDS.test(text)) return "cartoon";
  if (REALISTIC_WORDS.test(text)) return "realistic";
  if (REALISTIC_TEMPLATES.has(template)) return "realistic";
  if (CYBER_TEMPLATES.has(template)) return "cyber";
  return "cartoon";
}

function sceneRange(words: number, wps: [number, number]): [number, number] {
  const lo = Math.max(4, Math.ceil(words / wps[1]));
  const hi = Math.min(60, Math.max(lo + 1, Math.round(words / wps[0])));
  return [lo, hi];
}

/* ------------------------------------------------------------------ prompt */

interface Plan { style: StyleId; kleo: KleoStyle; pictures: boolean; brief: Brief; format: Format; language: string; voice: string; duration: number; speed: number; words: ReturnType<typeof wordBudget>; scenes: [number, number]; maxDuration: number; chunk: number }

/**
 * `chosen` is the look the DIRECTION picked after reading the request. It only applies when the client did not name a
 * style itself: the user's own choice always wins, and the keyword fallback is what is left when there is no model.
 */
export function planFor(job: PlanJob, chosen?: KleoStyle | null): Plan {
  const p = JSON.parse(job.params) as JobParams;
  const format = p.format;
  const brief = BRIEFS[job.template] ?? BRIEFS.explainer;
  const kleo: KleoStyle = (KLEO_STYLES as readonly string[]).includes(p.style ?? "")
    ? (p.style as KleoStyle)
    : chosen && (KLEO_STYLES as readonly string[]).includes(chosen) ? chosen : pickKleoStyle(job.template, job.prompt);
  const style = keouStyleFor(kleo, job.template, format);
  const speed = 1.1;
  const words = wordBudget(p.duration_s, speed);
  // Cinema/picture/stickman scenes carry one spoken line each in Shorts; long videos in those styles use longer lines so the scene count stays sane.
  const perLine: [number, number] = p.duration_s > 120 ? [35, 50] : [10, 18];
  const shortLine = style === "cinema" || style === "picture" || style === "stickman";
  const wps: [number, number] = shortLine ? (brief.style === "cinema" && p.duration_s <= 120 ? brief.wordsPerScene : perLine) : (brief.style === "cinema" ? [25, 40] : brief.wordsPerScene);
  return {
    style, kleo, pictures: PICTURE_STYLES.includes(kleo), brief, format, language: p.language, voice: defaultVoice(p.language, job.template, p.voice), duration: p.duration_s, speed, words,
    scenes: sceneRange(words.target, wps), maxDuration: Math.min(1800, Math.max(5, Math.round(p.duration_s * 1.6))),
    chunk: style === "cinema" || style === "picture" ? 4 : 5, // scenes per model call: keeps every call under ~2k output tokens (Workers AI times out on long generations)
  };
}

const LANG_NAMES: Record<string, string> = { en: "English", it: "Italian", fr: "French" };
const list = (a: readonly string[]) => a.join(", ");
const editorialKinds = () => KINDS.filter((k) => !["image", "story", "cinema"].includes(k));

function systemPrompt(plan: Plan): string {
  const kinds = plan.style === "cinema" || plan.style === "picture" ? "cinema, closing" : plan.style === "stickman" ? "story, closing" : list(editorialKinds());
  const lang = LANG_NAMES[plan.language] ?? plan.language;
  const rules = plan.style === "picture" ? SHOT_RULES : plan.style === "cinema" ? CINEMA_RULES : plan.style === "stickman" ? STICKMAN_RULES : EDITORIAL_RULES;
  const pictures = plan.style === "picture" ? `\n${PICTURE_RULES[plan.kleo as "cartoon" | "realistic"]}` : "";
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
Never use scene kind "image", never reference files or URLs. Scene ids are unique lowercase slugs like "01-hook". Text limits are hard limits, count characters. Narration and all on-screen text are in ${lang}; enum values stay in English. Write the narration as spoken language: no emojis, no hashtags, no URLs, no stage directions. Do not invent quotes from real people.`;
}

function contextBlock(job: PlanJob, plan: Plan): string {
  const t = findTemplate(job.template);
  return `TEMPLATE: ${t?.name ?? job.template} (${job.template}). BRIEF: ${plan.brief.guidance}
USER REQUEST (the video is about this; keep every fact, name and constraint from it):
"""${job.prompt.trim()}"""`;
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
function directionPrompt(job: PlanJob, plan: Plan): string {
  const t = findTemplate(job.template);
  const scenes = Math.max(plan.scenes[0], Math.min(plan.scenes[1], Math.round((plan.scenes[0] + plan.scenes[1]) / 2)));
  const lang = LANG_NAMES[plan.language] ?? plan.language;
  return `USER REQUEST (read it as a request, not as raw material):
"""${job.prompt.trim()}"""
TEMPLATE: ${t?.name ?? job.template}. LENGTH: ${plan.duration} seconds, about ${scenes} scenes, narrated in ${lang}.

TASK: write the DIRECTION of this one film, before any scene exists. Return one JSON object:

{"style":"cartoon|realistic|cyber|stickman","why":"<=90 chars, why that look fits THIS request",
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
  "sections":[${DL.sections.min}-${DL.sections.max} {"name":"<=${DL.sections.name} UPPERCASE narrative name","accent":"${list(CINEMA_ACCENTS)}","means":"<=${DL.sections.means}, what the colour means here","scenes":<whole number>}]}}

RULES
- must_keep is quoted from the request. If the user wrote "5 mistakes", "in Naples", "for beginners" or a number, it goes in must_keep and the narration must still contain it.
- The sections tile the film in order and their "scenes" must add up to exactly ${scenes}. Two sections in a row never share an accent: a new part of the story takes a new colour, and that is the only thing colour is allowed to mean.
- forbidden is what makes a film its own. A pirate film forbids modern objects, wifi symbols, phones, screens and logos; a film about a city forbids the objects of every other city. Write it for THIS video.
- Choose the style from the request, not from a keyword: cartoon = drawn stories, kids, history, animals, travel; realistic = products, places, news, sport, documentary; cyber = motion design with no pictures at all, only for tech and security topics that want diagrams rather than scenes; stickman = only if the user asked for a stickman.
- Everything you write here is in ${lang} except the enum values (style, accent), which stay in English.`;
}

const directionSchema = (): Record<string, unknown> => ({
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
        sections: {
          type: "array",
          items: {
            type: "object", additionalProperties: false, required: ["name", "accent", "means", "scenes"],
            properties: { name: str, accent: { type: "string", enum: [...CINEMA_ACCENTS] }, means: str, scenes: { type: "integer" } },
          },
        },
      },
    },
  },
});

/** Trim a direction to the contract's limits instead of failing on a model that ran three characters long. */
function repairDirection(raw: unknown, scenes: number): Direction | null {
  if (!isObj(raw)) return null;
  const cut = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
  const cutList = (v: unknown, max: number, len: number): string[] => {
    const seen = new Set<string>();
    return strs(v, 10_000).map((s) => cut(s, len)).filter((s) => { const k = s.toLowerCase(); if (!s || seen.has(k)) return false; seen.add(k); return true; }).slice(0, max);
  };
  const sections: Section[] = (Array.isArray(raw.sections) ? raw.sections : []).filter(isObj).slice(0, DL.sections.max).map((s) => ({
    name: cut(s.name, DL.sections.name), means: cut(s.means, DL.sections.means),
    accent: inSet(s.accent, CINEMA_ACCENTS) ? (s.accent as string) : CINEMA_ACCENTS[0],
    scenes: isInt(s.scenes) && s.scenes > 0 ? s.scenes : 1,
  })).filter((s) => s.name && s.means);
  // Two sections in a row must not share an accent, and the counts must tile the film exactly. Both are repaired here
  // rather than bounced back to the model: they are arithmetic, and a retry spent on arithmetic is a retry not spent
  // on the story. The last section absorbs the remainder, which is where a closing scene belongs anyway.
  sections.forEach((s, i) => {
    if (i && s.accent === sections[i - 1].accent) s.accent = CINEMA_ACCENTS.find((a) => a !== sections[i - 1].accent && a !== sections[i + 1]?.accent) ?? CINEMA_ACCENTS.find((a) => a !== sections[i - 1].accent)!;
  });
  if (sections.length) {
    let total = sections.reduce((a, s) => a + s.scenes, 0);
    while (total > scenes && sections.length) {
      const big = sections.reduce((best, s, i) => (s.scenes > sections[best].scenes ? i : best), 0);
      if (sections[big].scenes <= 1) { const gone = sections.pop()!; total -= gone.scenes; continue; }
      sections[big].scenes--; total--;
    }
    if (total < scenes && sections.length) sections[sections.length - 1].scenes += scenes - total;
  }
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

function outlinePrompt(job: PlanJob, plan: Plan, n: number, d: Direction | null): string {
  const perScene = Math.round(plan.words.target / n);
  const cin = plan.style === "cinema" || plan.style === "picture", stick = plan.style === "stickman";
  const kind = cin ? "cinema" : stick ? "story" : "<kind>";
  const label = cin ? "chapter ≤32 like 01 HOOK" : stick ? "situation ≤32 like 01 THE SETUP" : "UPPERCASE eyebrow ≤40";
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
  return `${contextBlock(job, plan)}${d ? `\n${directionBlock(d)}` : ""}${sectionMap}${keeps}
TASK: plan the whole video as an outline of exactly ${n} scenes, in order. The narration will total about ${plan.words.target} words (${perScene} per scene on average; the hook and the closing may be shorter, key scenes longer). Return {"title":"<video title ≤120>","description":"<YouTube description, one paragraph>","tags":["…"],"scenes":[{"id":"01-slug","kind":"${kind}","label":"<${label}>",${cin ? '"accent":"<accent>",' : ""}"summary":"<what this scene says, ≤25 words>","words":<narration words for this scene>${d?.must_keep.length ? ',"keeps":[<fact indexes>]' : ""}}, …]}.
${cin ? `Chapters group scenes (several scenes may share a chapter label)${d ? "; copy each scene's accent from the section table above" : "; accents follow the mood"}.` : stick ? "Each scene is one situation the stickman can act out." : "Vary the kinds: never more than two of the same kind in a row, at least four different kinds overall; use metric for numbers, compare for two-sided points, steps/list for three-part points, quote for a memorable line, hero for openings and transitions."} The last scene has kind "closing". The first scene is the hook.`;
}

function chunkPrompt(job: PlanJob, plan: Plan, outline: OutlineEntry[], from: number, to: number, prevVoice: string | null, feedback?: string[], d?: Direction | null): string {
  const entries = outline.slice(from, to);
  const words = entries.reduce((n, e) => n + e.words, 0);
  const total = outline.length;
  // The facts these particular scenes are on the hook for. Handing a chunk the whole list would invite it to say
  // everything twice; handing it none is how a fact quietly disappears between two chunks and nobody notices.
  const owed = d?.must_keep.length ? [...new Set(entries.flatMap((e) => e.keeps))].filter((i) => i >= 0 && i < d.must_keep.length) : [];
  const pic = plan.style === "picture";
  const cin = plan.style === "cinema" || pic, stick = plan.style === "stickman";
  const lineWords = plan.duration > 120 ? "35–50" : "10–18";
  const how = pic ? `Each voice line is ${plan.duration > 120 ? "two or three spoken sentences" : "one spoken sentence"} of ${lineWords} words; every scene needs ${shotRangeText("cinema")} shots (the closing exactly one), each with its own "image_prompt"; every shot after the first carries "at" with words copied from its own voice line. One picture per scene is refused: a still held for a whole line is a slideshow.`
    : cin ? `Each voice line is ${plan.duration > 120 ? "two or three spoken sentences" : "one spoken sentence"} of ${lineWords} words; every scene needs 4–8 beats of different kinds, each anchored with "at" to words of its own voice line.`
    : stick ? `Each voice line is one spoken sentence of ${lineWords} words; every scene has an act, a cast with hero, an accent and a title; add a bubble when the character says something.`
    : "Fill the kind-specific fields exactly as the shapes show: list/steps need 3 items, compare 2 items, metric needs value and unit, quote needs quote, hero needs visual.";
  let msg = `${contextBlock(job, plan)}${d ? `\n${directionBlock(d)}` : ""}${owed.length ? `\nTHESE SCENES OWE THESE FACTS — say each one out loud in a "voice" line:\n${owed.map((i) => `  - ${d!.must_keep[i]}`).join("\n")}` : ""}
VIDEO OUTLINE (${total} scenes; you write scenes ${from + 1}–${to} now):
${outline.map((e, i) => `${i + 1}. [${e.id}] ${e.kind} · ${e.label}${e.accent ? ` · ${e.accent}` : ""} — ${e.summary} (${e.words} words)`).join("\n")}
${prevVoice ? `The previous scene ended with this narration, continue naturally from it: "${prevVoice}"` : "This is the start of the video."}
TASK: write scenes ${from + 1}–${to} in full, in order, keeping their ids, kinds${cin ? ", chapters (as \"chapter\") and accents" : stick ? " and titles" : " and eyebrows"} from the outline. Their narration together totals about ${words} words (${entries.map((e) => `${e.id}: ${e.words}`).join(", ")}). ${how}${pic ? ` Each "image_prompt" is one sentence, ≤${IMAGE_PROMPT_MAX} characters, with no text in the picture.` : ""}
Return {"scenes":[…]} with exactly ${entries.length} scene objects and nothing else.`;
  if (feedback?.length) msg += `\n\nYOUR PREVIOUS ANSWER WAS REJECTED by the validator with these problems (scene numbers count within the scenes you returned, "beat n" counts inside that scene). Fix every one of them and return all ${entries.length} scenes again:\n- ${feedback.join("\n- ")}`;
  return msg;
}

/** JSON schemas for response_format (kept flat: no oneOf, so constrained decoding stays cheap). */
const str = { type: "string" };
const strArr = { type: "array", items: str };

/** Every property the contract knows, closed with additionalProperties:false (open objects let the grammar accept
 * garbled keys). Junk the model puts in irrelevant properties is removed per kind by normalizeStoryboard. */
function sceneSchema(plan: Plan): Record<string, unknown> {
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
      },
      required: ["id", "kind", "chapter", "accent", "title", "hl", "voice", "shots"],
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
      id: str, kind: { type: "string", enum: cin ? ["cinema", "closing"] : plan.style === "stickman" ? ["story", "closing"] : editorialKinds() }, label: str,
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

const chunkSchema = (plan: Plan): Record<string, unknown> => ({
  type: "object", properties: { scenes: { type: "array", items: sceneSchema(plan) } }, required: ["scenes"], additionalProperties: false,
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
  // THE COLOUR LAW IS ARITHMETIC, SO IT IS REPAIRED, NOT REFUSED. Every scene wears the accent of the section it sits
  // in; a model that wrote a different one is corrected here rather than bounced back, because a retry spent on
  // copying a colour out of a table is a retry not spent on the story. The validator still refuses a mismatch, which
  // is what catches a CLIENT-written storyboard: there the author chose both, and a mismatch is a real contradiction.
  const colourLaw = plan.style === "picture" || plan.style === "cinema";
  if (colourLaw && isObj(c.direction) && Array.isArray((c.direction as Record<string, unknown>).sections) && Array.isArray(c.scenes)) {
    const sections = (c.direction as unknown as Direction).sections;
    sectionOfScene(sections, (c.scenes as unknown[]).length).forEach((sec, i) => {
      const scene = (c.scenes as Record<string, unknown>[])[i];
      if (sec && isObj(scene) && "accent" in scene) scene.accent = sec.accent;
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
      if (typeof s.hold === "number") s.hold = Math.min(3, Math.max(0.15, s.hold)); else delete s.hold;
      if (s.kind === "closing" && s.button && s.detail) delete s.detail;
      if (typeof s.voice === "string") s.voice = fitVoice(s.voice);
      if (typeof s.eyebrow === "string" && s.eyebrow.length > 40) s.eyebrow = s.eyebrow.slice(0, 40).trim();
      if (typeof s.chapter === "string" && s.chapter.length > 32) s.chapter = s.chapter.slice(0, 32).trim();
      if (typeof s.source === "string" && s.source.length > 80) delete s.source;
      if (typeof s.detail === "string" && s.detail.length > 110) delete s.detail;
      if (typeof s.hl === "string" && s.hl.length > 24) delete s.hl;
      if ("visual" in s && !inSet(s.visual, VISUALS)) delete s.visual;
      if ("accent" in s && !inSet(s.accent, plan.style === "stickman" ? STORY_ACCENTS : CINEMA_ACCENTS)) delete s.accent;
      // Pictures: the picture style keeps shots (and only shots), every other style keeps none (image is never accepted from a model).
      delete s.image; delete s.image_credit;
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
    if (scenes.length && !scenes.some((s) => s.kind === "closing")) {
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

async function callModel(env: Env, model: string, messages: { role: string; content: string }[], schema: Record<string, unknown>, maxTokens: number): Promise<{ raw: unknown; usage: Usage }> {
  const ai = env.AI as unknown as AiRunner;
  const base = { messages, max_tokens: maxTokens, temperature: 0.3 };
  let res: unknown;
  try {
    res = await ai.run(model, { ...base, response_format: { type: "json_schema", json_schema: schema } });
  } catch (e) {
    // Models without JSON mode (or a schema the grammar engine rejects): plain call, lenient parse.
    if (!/json|schema|response_format|unsupported|invalid/i.test(String(e))) throw e;
    res = await ai.run(model, base);
  }
  const r = isObj(res) ? res : {};
  const usage = (isObj(r.usage) ? r.usage : {}) as Usage;
  let raw: unknown = r.response;
  if (raw === undefined && Array.isArray(r.output)) { // Responses-API shaped models (gpt-oss)
    const msg = (r.output as Record<string, unknown>[]).find((o) => o.type === "message");
    const content = Array.isArray(msg?.content) ? (msg!.content as Record<string, unknown>[]).find((x) => typeof x.text === "string") : null;
    raw = content?.text;
  }
  if (typeof raw === "string") raw = extractJson(raw);
  return { raw, usage };
}

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
  const kleo: KleoStyle = p.style === "realistic" || p.style === "cyber" ? p.style : "cartoon"; // the example is a cinema project: stickman cannot be faked
  sb.kleo_style = kleo;
  const pictures = PICTURE_STYLES.includes(kleo);
  if (pictures) sb.style = "picture";
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
  return r.storyboard;
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
    : { id: "zz-temp-closing", kind: "closing", title: "end", voice: "the end" };

function header(plan: Plan, outline: { title?: unknown; description?: unknown; tags?: unknown }, direction?: Direction | null): Record<string, unknown> {
  return {
    schema_version: 1, editorial_status: "ready", title: outline.title, description: outline.description, tags: outline.tags,
    style: plan.style, kleo_style: plan.kleo, format: plan.format, language: plan.language, voice: plan.voice, speed: plan.speed, music: "bed", max_duration: plan.maxDuration,
    // The direction travels with the storyboard: the picture prompts read it (src/images.ts), the validator holds the
    // scenes to it, and the worker passes it through untouched, so a render can only ever ignore it, never trip on it.
    ...(direction ? { direction } : {}),
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
    return { storyboard: sb, model: "fixture", attempts: 0, ms: Date.now() - t0, usage: {}, est_neurons: 0, words: countWords(sb), scenes: sb.scenes.length, fixture: true, history: [], style: kleoStyleOf(sb), direction: (sb as { direction?: Direction }).direction ?? null, missing_facts: [] };
  }
  const model = opts.model || env.AI_MODEL || DEFAULT_MODEL;
  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const history: string[][] = [];
  let calls = 0;
  // The system prompt is rebuilt whenever the plan changes, because the direction is allowed to change the look and
  // the system prompt is where the look's rules live: a cartoon storyboard written under the cyber rules is garbage.
  let system = systemPrompt(plan);
  const call = async (user: string, schema: Record<string, unknown>, maxTokens: number) => {
    calls++;
    const out = await callModel(env, model, [{ role: "system", content: system }, { role: "user", content: user }], schema, maxTokens);
    usage.prompt_tokens! += out.usage.prompt_tokens ?? 0; usage.completion_tokens! += out.usage.completion_tokens ?? 0; usage.total_tokens! += out.usage.total_tokens ?? 0;
    return out.raw;
  };
  const fail = (errors: string[], draft?: unknown): never => { throw new StoryboardError(`storyboard invalid (${model}, ${calls} calls): ${errors.join("; ")}`, errors, draft); };
  let transient: unknown = null; // the last quota/outage error: reported instead of a storyboard problem

  // 0. THE DIRECTION. One call, before anything exists, that reads the request as a request: subject, goal, audience,
  //    tone, the facts that must survive, the world the film is drawn in, what must never appear, and which colour
  //    owns which stretch of the story. It also picks the look and says why. A film planned without it is what Kleo
  //    used to make: a list of scenes with nothing holding them together.
  //    It is allowed to fail. A direction is a large improvement, not a precondition — when the model cannot produce a
  //    valid one in two tries the planner carries on exactly as it did before, and the video still ships.
  let direction: Direction | null = null;
  const sceneGuess = Math.max(plan.scenes[0], Math.min(plan.scenes[1], Math.round((plan.scenes[0] + plan.scenes[1]) / 2)));
  for (let attempt = 1; attempt <= 2 && !direction; attempt++) {
    let raw: unknown;
    try { raw = clean(await call(directionPrompt(job, plan), directionSchema(), 900)); }
    catch (e) { history.push([`direction: model call failed: ${String(e).slice(0, 200)}`]); if (isTransientAiError(e)) { transient = e; break; } continue; }
    const o = isObj(raw) ? raw : {};
    const d = repairDirection(o.direction, sceneGuess);
    if (!d) { history.push([`direction: rejected (${directionProblems(isObj(o.direction) ? o.direction : {}, { accents: CINEMA_ACCENTS, scenes: sceneGuess }).slice(0, 3).join("; ")})`]); continue; }
    direction = d;
    // The look the direction chose, unless the client named one: planFor() keeps the user's choice above everything.
    const wanted = inSet(o.style, KLEO_STYLES) ? (o.style as KleoStyle) : null;
    if (wanted && wanted !== plan.kleo) { plan = planFor(job, wanted); system = systemPrompt(plan); }
  }
  if (transient) throw transient;

  // 1. Outline
  const n = sceneGuess;
  let outline: OutlineEntry[] = [];
  let meta: { title?: unknown; description?: unknown; tags?: unknown } = {};
  for (let attempt = 1; attempt <= 2 && !outline.length; attempt++) {
    let raw: unknown;
    try { raw = clean(await call(outlinePrompt(job, plan, n, direction), outlineSchema(plan, direction?.must_keep.length ?? 0), 400 + n * 90)); }
    catch (e) { history.push([`outline: model call failed: ${String(e).slice(0, 200)}`]); if (isTransientAiError(e)) { transient = e; break; } continue; }
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
    outline.forEach((e, i) => { if (e.kind === "closing" && i < outline.length - 1) e.kind = plan.style === "cinema" || plan.style === "picture" ? "cinema" : "hero"; });
    outline[outline.length - 1].kind = "closing";
    // Scale the per-scene word plan to the budget.
    const sum = outline.reduce((a, e) => a + e.words, 0) || 1;
    outline.forEach((e) => { e.words = Math.max(5, Math.round((e.words * plan.words.target) / sum)); });
    meta = { title: o.title, description: o.description, tags: o.tags };
  }
  if (transient) throw transient;
  if (!outline.length) fail(history.flat());

  // 2. Scenes, chunk by chunk
  const scenes: Record<string, unknown>[] = [];
  const head = header(plan, meta, direction);
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
      try { raw = await call(chunkPrompt(job, plan, outline, from, to, prevVoice, feedback, direction), chunkSchema(plan), 400 + maxTokens); }
      catch (e) { history.push([`scenes ${from + 1}–${to}: model call failed: ${String(e).slice(0, 200)}`]); if (isTransientAiError(e)) throw e; feedback = undefined; continue; }
      const got = isObj(raw) && Array.isArray(raw.scenes) ? raw.scenes.filter(isObj) : [];
      // Validated in context (the scenes accepted so far + this chunk + a temporary closing unless it is the last chunk);
      // error labels are remapped so "scene n" counts within the scenes the model just returned.
      const temp = normalizeStoryboard({ ...chunkHead, scenes: [...structuredClone(scenes), ...got, ...(isLast ? [] : [TEMP_CLOSING(plan)])] }, plan) as Record<string, unknown>;
      lastDraft = temp;
      const problems: string[] = [];
      if (got.length !== to - from) problems.push(`expected exactly ${to - from} scenes, got ${got.length}`);
      const r = validateStoryboard(temp, { format: plan.format, language: plan.language });
      if (!r.ok) problems.push(...r.errors.map((m) => m.replace(/^scene (\d+)/, (_, n) => `scene ${Number(n) - scenes.length}`)).filter((m) => !/^scene (-\d+|0)\b/.test(m)));
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
      if (plan.style === "picture") {
        // A cinema scene that ends up with one picture holds it for the whole line: ask for the missing cuts once.
        const thin = chunkScenes.map((s, i) => (s.kind !== "closing" && (!Array.isArray(s.shots) || s.shots.length < 2) ? i + 1 : 0)).filter(Boolean);
        if (thin.length) problems.push(`scene${thin.length > 1 ? "s" : ""} ${thin.join(", ")}: only one picture; every scene needs 2–4 "shots", each with its own "image_prompt", and every shot after the first anchored with "at" to words of that scene's voice`);
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
      if (r.ok && got.length === to - from && (attempt >= 2 || !problems.length)) { accepted = chunkScenes; break; }
      history.push(problems);
      feedback = problems;
    }
    if (!accepted) fail(history[history.length - 1] ?? ["no scenes"], lastDraft);
    scenes.push(...accepted!);
  }

  // 3. Assemble and validate the whole project once more (ids are re-deduplicated across chunks).
  const sb = normalizeStoryboard({ ...head, scenes }, plan);
  const r = validateStoryboard(sb, { format: plan.format, language: plan.language });
  if (!r.ok) fail(r.errors, sb);
  const price = PRICES[model];
  const est = price ? Math.round((((usage.prompt_tokens ?? 0) * price.in + (usage.completion_tokens ?? 0) * price.out) / 1e6) / 0.000011) : null;
  const ok = r as { ok: true; storyboard: Storyboard };
  // What the finished plan still does not say. It is reported, never hidden: the owner accepts declared uncertainty
  // and refuses the hidden kind, and this is the one number that says whether the video is about what was asked.
  const missing = direction ? missingFacts(direction.must_keep, narrationOf(ok.storyboard)) : [];
  if (missing.length) history.push(missing.map((f) => `narration never says "${f}"`));
  return { storyboard: ok.storyboard, model, attempts: calls, ms: Date.now() - t0, usage, est_neurons: est, words: countWords(ok.storyboard), scenes: ok.storyboard.scenes.length, fixture: false, history, style: plan.kleo, direction, missing_facts: missing };
}
