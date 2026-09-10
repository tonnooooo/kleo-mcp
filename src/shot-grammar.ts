/**
 * Kleo SHOT GRAMMAR — the story-to-camera table (part one of the motion rebuild, 2026-09-10).
 *
 * Why this file exists: a shot used to carry `motion` ("in" | "out" | "left" | "right") and, when that was absent,
 * the engine picked a pan direction from a hash of the scene id. Movement chosen by a hash is movement that means
 * nothing, and it reads as a screensaver — "images with zoom", not video. The fix is a separation of concerns:
 *
 *     the planner and the client model say what a shot is FOR (`shot_kind`, in story terms);
 *     this table says what the camera does about it.
 *
 * Nobody upstream of this file writes camera language by hand. There are exactly ten kinds, and each one resolves to
 * one move, a duration window, a motion strength, a prompt suffix in the vendor dialect (with explicit negatives,
 * because an image-to-video model will happily give you a pull-back when you asked for a push-in), a text anchor
 * (where the caption sits so the words never fight the move) and a reserved `trajectory` field.
 *
 * This file is mirrored, value for value, by worker/keou/shot_grammar.py; test/shot-grammar.test.mjs parses both and
 * fails if they drift (the same trick test/keou-contract.test.mjs plays on src/mcp.ts and worker/test_kleo_pictures.py
 * plays on prewarm_models.py). Keys are snake_case on purpose: this is a data table shared with Python and with the
 * storyboard JSON dialect (image_prompt, kleo_style, …), not idiomatic TypeScript.
 */

// ---------------------------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------------------------

/** The ten story kinds. A planner writes one of these; it never writes a move. */
export const SHOT_KINDS = [
  "hook",
  "establish",
  "face",
  "detail",
  "detail_orbit",
  "action",
  "reveal",
  "tension",
  "closing",
  "static_forced",
] as const;
export type ShotKind = (typeof SHOT_KINDS)[number];

/**
 * Move classes. Two consecutive shots of the same class read as one long shot with a cut in it, which is the exact
 * failure the owner named, so the sequencing rules forbid it.
 */
export const MOVE_CLASSES = ["PUSH", "LATERAL", "VERTICAL", "STILL"] as const;
export type MoveClass = (typeof MOVE_CLASSES)[number];

/** Screen direction carried by a move. "none" = the move has no left/right component (a push, a crane, a hold). */
export const DIRECTIONS = ["left", "right", "none"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** Shot scale, widest to tightest. Used by the "never twice at the same scale on the same subject" rule. */
export const SCALES = ["wide", "medium", "close", "extreme_close"] as const;
export type Scale = (typeof SCALES)[number];

/** Where the caption sits on the frame, so the big words never sit under the part of the picture that is moving most. */
export const TEXT_ANCHORS = ["top", "center", "lower_third", "bottom"] as const;
export type TextAnchor = (typeof TEXT_ANCHORS)[number];

export interface MoveSpec {
  /** Move class, for the alternation rule. */
  class: MoveClass;
  /** Screen direction, for the "direction stays consistent inside a scene" rule. */
  direction: Direction;
  /** A loud move: attention-grabbing, cheap when rare and exhausting when not. Budgeted by the sequencing rules. */
  loud: boolean;
}

/**
 * Every move the grammar knows. Nine are reachable from a shot kind today; `track_left`, `orbit_right` and `crane_up`
 * are the mirrors a planner needs when a scene's screen direction is already set the other way, and `whip_pan` is
 * listed because it is loud and the budget rule has to know that even before a kind uses it.
 */
export const MOVES = {
  crash_zoom_in: { class: "PUSH", direction: "none", loud: true },
  push_in: { class: "PUSH", direction: "none", loud: false },
  push_in_dutch: { class: "PUSH", direction: "none", loud: true },
  pull_out: { class: "PUSH", direction: "none", loud: false },
  track_right: { class: "LATERAL", direction: "right", loud: false },
  track_left: { class: "LATERAL", direction: "left", loud: false },
  track_alongside: { class: "LATERAL", direction: "right", loud: false },
  orbit_left: { class: "LATERAL", direction: "left", loud: true },
  orbit_right: { class: "LATERAL", direction: "right", loud: true },
  whip_pan: { class: "LATERAL", direction: "right", loud: true },
  crane_down: { class: "VERTICAL", direction: "none", loud: false },
  crane_up: { class: "VERTICAL", direction: "none", loud: false },
  static_hold: { class: "STILL", direction: "none", loud: false },
} as const;
export type Move = keyof typeof MOVES;

/** The loud moves, spelled out. Kept as its own list so the budget rule reads as a rule and not as a query. */
export const LOUD_MOVES = ["crash_zoom_in", "push_in_dutch", "orbit_left", "orbit_right", "whip_pan"] as const;

/**
 * Goes on the end of every shot prompt, whatever the kind. "no zoom" is deliberate and is not a contradiction with
 * crash_zoom_in: the move suffix asks for a physical camera move, and this line tells the model not to add a digital
 * zoom of its own on top of it.
 */
export const UNIVERSAL_NEGATIVE =
  "no morphing, no extra fingers, no warping faces, no floating objects, no camera shake beyond the specified move, no zoom, no text, no watermark, no logo";

export interface ShotPreset {
  /** The one move this kind resolves to. One move. Never a list. */
  move: Move;
  /** Duration window in seconds, for 16:9. See durationFor() for the 9:16 numbers. */
  min_s: number;
  max_s: number;
  /** Motion strength, 0 (locked off) to 1 (violent). What the image-to-video vendor gets as its motion scale. */
  strength: number;
  /** Shot scale, for the repetition rule. */
  scale: Scale;
  /** Where the caption sits. */
  text_anchor: TextAnchor;
  /** The vendor-dialect camera instruction, negatives included. Assembled by promptFor(). */
  suffix: string;
  /**
   * RESERVED, always null. When real camera conditioning lands (a per-frame path handed to the model instead of a
   * sentence), it goes here. Nothing reads it today; the test asserts it stays null so nobody starts depending on it.
   */
  trajectory: readonly number[] | null;
}

/** The table. Ten kinds, one move each. */
export const SHOT_GRAMMAR: Record<ShotKind, ShotPreset> = {
  hook: {
    move: "crash_zoom_in",
    min_s: 1.6,
    max_s: 2.2,
    strength: 0.85,
    scale: "close",
    text_anchor: "center",
    suffix:
      "camera crashes in fast toward the subject, one single continuous crash zoom in, framing tightens hard and settles, NOT a dolly out, NOT a pull-back, NOT a pan, subject stays centered",
    trajectory: null,
  },
  establish: {
    move: "crane_down",
    min_s: 3.5,
    max_s: 4.5,
    strength: 0.35,
    scale: "wide",
    text_anchor: "top",
    suffix:
      "camera cranes smoothly downward from high above the scene, one single continuous descent, the horizon rises through frame, NOT a crane up, NOT a tilt up, NOT a push in, no lateral drift",
    trajectory: null,
  },
  face: {
    move: "push_in",
    min_s: 2.5,
    max_s: 3.5,
    strength: 0.25,
    scale: "close",
    text_anchor: "lower_third",
    suffix:
      "camera pushes in slowly on the face, one single continuous slow dolly in, eyeline steady, NOT a dolly out, NOT a pull-back, NOT a zoom snap, no head turn, no change of expression",
    trajectory: null,
  },
  detail: {
    move: "track_right",
    min_s: 2.0,
    max_s: 3.0,
    strength: 0.3,
    scale: "extreme_close",
    text_anchor: "bottom",
    suffix:
      "camera tracks laterally to the right at a steady pace, one single continuous move, parallax across the foreground, NOT a track left, NOT a push in, NOT a pull-back, the subject stays in frame",
    trajectory: null,
  },
  detail_orbit: {
    move: "orbit_left",
    min_s: 2.5,
    max_s: 3.5,
    strength: 0.45,
    scale: "close",
    text_anchor: "bottom",
    suffix:
      "camera orbits left around the object on a fixed radius, one single continuous arc, NOT an orbit right, NOT a push in, NOT a pull-back, the object itself does not rotate or deform",
    trajectory: null,
  },
  action: {
    move: "track_alongside",
    min_s: 2.0,
    max_s: 3.0,
    strength: 0.55,
    scale: "medium",
    text_anchor: "lower_third",
    suffix:
      "camera tracks alongside the moving subject at matching speed, one single continuous move, the subject held at the same point of frame, NOT a static shot, NOT a push in, NOT a pull-back, the background streaks past",
    trajectory: null,
  },
  reveal: {
    move: "pull_out",
    min_s: 2.8,
    max_s: 3.8,
    strength: 0.4,
    scale: "wide",
    text_anchor: "center",
    suffix:
      "camera pulls back steadily to reveal the wider scene, one single continuous dolly out, more of the world enters frame, NOT a push in, NOT a crash zoom, NOT a pan, subject stays centered",
    trajectory: null,
  },
  tension: {
    move: "push_in_dutch",
    min_s: 2.2,
    max_s: 3.0,
    strength: 0.6,
    scale: "medium",
    text_anchor: "top",
    suffix:
      "camera pushes in slowly while the horizon tilts into a dutch angle, one single continuous move, the tilt settles by the end, NOT a dolly out, NOT a pull-back, NOT a level frame, no handheld shake",
    trajectory: null,
  },
  closing: {
    move: "pull_out",
    min_s: 3.0,
    max_s: 4.0,
    strength: 0.15,
    scale: "wide",
    text_anchor: "center",
    suffix:
      "camera drifts back very slowly, a barely perceptible dolly out, one single continuous move, the frame settles and holds, NOT a push in, NOT a crash zoom, NOT a pan",
    trajectory: null,
  },
  static_forced: {
    move: "static_hold",
    min_s: 2.0,
    max_s: 3.0,
    strength: 0.0,
    scale: "medium",
    text_anchor: "lower_third",
    suffix:
      "locked off camera on a tripod, the frame does not move at all, NOT a push in, NOT a pull-back, NOT a pan, NOT a zoom, no drift, no handheld float, only the subject moves",
    trajectory: null,
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------------------------------------------

/** A 9:16 shot runs at 0.7x the 16:9 window: a vertical viewer's thumb is the competition, not the story. */
export const PORTRAIT_FACTOR = 0.7;
/** …and no 9:16 shot goes past this, whatever the factor produces. */
export const PORTRAIT_MAX_S = 3.0;

export interface DurationWindow {
  min: number;
  max: number;
}

/** Round half up to two decimals, the same way on both sides of the mirror (Python rounds half to even, so it floors). */
const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * The duration window for a kind in a format. 16:9 uses the table as written; 9:16 multiplies by 0.7 and caps at 3.0 s.
 * The cap is what bites: `establish` is 3.5–4.5 s wide, and vertical only ever gets 2.45–3.0 s of it.
 */
export function durationFor(kind: ShotKind, format: string): DurationWindow {
  const p = presetFor(kind);
  if (format !== "9:16") return { min: round2(p.min_s), max: round2(p.max_s) };
  return {
    min: round2(Math.min(p.min_s * PORTRAIT_FACTOR, PORTRAIT_MAX_S)),
    max: round2(Math.min(p.max_s * PORTRAIT_FACTOR, PORTRAIT_MAX_S)),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------------------------------

/** The row for a kind. Throws on an unknown kind: a typo in a shot_kind must not silently become a default move. */
export function presetFor(kind: string): ShotPreset {
  const p = (SHOT_GRAMMAR as Record<string, ShotPreset>)[kind];
  if (!p) throw new Error(`unknown shot_kind '${kind}' (one of ${SHOT_KINDS.join(", ")})`);
  return p;
}

export const moveClassOf = (move: string): MoveClass | null => (MOVES as Record<string, MoveSpec>)[move]?.class ?? null;
export const directionOf = (move: string): Direction | null => (MOVES as Record<string, MoveSpec>)[move]?.direction ?? null;
export const isLoud = (move: string): boolean => (LOUD_MOVES as readonly string[]).includes(move);

/** Whitespace collapsed, trailing punctuation dropped, so the join below never produces ".." or ", .". */
function cleanSubject(imagePrompt: unknown): string {
  const s = String(imagePrompt ?? "").split(/\s+/).join(" ").trim();
  return s.replace(/[\s,;.:]+$/, "");
}

/** `<subject>. <camera suffix, negatives included>. <universal negative>` — what the image-to-video vendor is sent. */
export function promptFor(kind: ShotKind, imagePrompt: string): string {
  return [cleanSubject(imagePrompt), presetFor(kind).suffix, UNIVERSAL_NEGATIVE].filter((s) => s.length > 0).join(". ");
}

// ---------------------------------------------------------------------------------------------------------------
// Routing: static_forced
// ---------------------------------------------------------------------------------------------------------------

/**
 * static_forced is a ROUTING RULE, not a taste. Four categories break under any camera move — the model reinvents the
 * geometry every frame and you get melting fingers, a crowd that boils, signage that turns into runes, and a machine
 * whose parts swap places. When a prompt lands in one of them the camera locks off, and no kind overrides that.
 *
 * The triggers are plain lowercase phrases, matched on whole words, so the Python mirror can hold the identical list
 * and the two implementations cannot drift into different regexes.
 */
export const STATIC_HOLD_CATEGORIES = ["hands", "people", "signage", "mechanism"] as const;
export type StaticHoldCategory = (typeof STATIC_HOLD_CATEGORIES)[number];

/** How each category reads in an error message: "this picture shows <phrase>, which breaks under a moving camera". */
export const STATIC_HOLD_REASON: Record<StaticHoldCategory, string> = {
  hands: "hands at work",
  people: "a crowd, or two people interacting",
  signage: "legible signage",
  mechanism: "a mechanism with moving parts",
};

export const STATIC_HOLD_TRIGGERS: Record<StaticHoldCategory, readonly string[]> = {
  // visible hands doing something. Deliberately absent, though every one of them is a hands verb in a kitchen:
  // pouring, cutting, slicing, carving, peeling, stirring, folding, threading, hammering, shuffling, palm.
  // Landscapes use all of them too ("a motorway cutting through the desert", "paint peeling", "palm trees"), and a
  // false lock-off is the disease this whole file exists to cure. A missed hand shot costs one wobbly shot; a
  // trigger that fires on scenery costs every shot in the video.
  hands: [
    "hand", "hands", "finger", "fingers", "fingertips", "knuckles", "gloved", "fist", "fists",
    "holding", "holds", "handing", "reaching for", "gripping", "grips", "grasping", "typing", "writing",
    "chopping", "kneading", "assembling", "sewing", "knitting", "soldering", "unscrewing", "screwing",
    "tying", "dealing cards", "pressing a button", "counting coins", "polishing", "sharpening",
  ],
  // a crowd, or two people interacting
  people: [
    "crowd", "crowds", "crowded", "throng", "mob", "audience", "spectators", "onlookers", "bystanders",
    "queue", "marketplace", "market square", "rally", "protest", "parade", "congregation", "stadium crowd", "packed stadium",
    "group of people", "lots of people", "many people", "dozens of people", "a sea of people",
    "two people", "two men", "two women", "two figures", "two workers", "two soldiers", "two children",
    "two friends", "two hooded figures", "handshake", "shaking hands", "shakes hands", "talking to",
    "speaking to", "arguing", "facing each other", "face to face", "conversation", "interview",
    "hugging", "embracing", "kissing", "fighting", "wrestling", "greeting", "whispering to",
  ],
  // legible signage
  signage: [
    "sign", "signs", "signage", "signpost", "street sign", "road sign", "billboard", "banner", "poster",
    "placard", "marquee", "menu board", "whiteboard", "blackboard", "chalkboard", "notice", "plaque",
    "headline", "newspaper", "magazine cover", "book page", "open book", "label", "labelled", "labeled",
    "lettering", "graffiti", "neon sign", "license plate", "number plate", "handwritten note", "document",
    "contract", "subtitles", "engraved text", "screen showing text",
  ],
  // a mechanism with moving parts
  mechanism: [
    "gear", "gears", "cog", "cogs", "cogwheel", "machinery", "machine", "engine", "piston", "pistons",
    "turbine", "conveyor", "conveyor belt", "clockwork", "mechanism", "pulley", "crankshaft", "camshaft",
    "flywheel", "sprocket", "chain drive", "propeller", "rotor", "spinning blades", "printing press",
    "loom", "windmill", "watermill", "assembly line", "robotic arm", "moving parts", "drill bit",
    "saw blade", "escalator", "treadmill", "clock mechanism",
  ],
};

/** Words that mean a person is on screen: their shots get the tighter 4.0 s ceiling. */
export const PERSON_WORDS = [
  "man", "men", "woman", "women", "person", "people", "boy", "boys", "girl", "girls", "child", "children",
  "kid", "kids", "face", "faces", "portrait", "figure", "figures", "silhouette", "crowd", "hands", "hand",
  "eyes", "worker", "workers", "soldier", "soldiers", "captain", "pirate", "pirates", "sailor", "sailors",
  "scientist", "doctor", "nurse", "teacher", "student", "driver", "rider", "athlete", "dancer", "climber",
  "hiker", "guard", "thief", "he", "she", "his", "her", "their",
] as const;

/** Kinds that are about a person whatever the prompt says. */
export const PERSON_KINDS = ["face", "action"] as const;

/** Letters and single spaces only, with a space at each end, so a phrase test is a whole-word test. */
function haystack(text: unknown): string {
  return ` ${String(text ?? "").toLowerCase().replace(/[^a-z]+/g, " ").trim()} `;
}
const hasPhrase = (hay: string, phrase: string): boolean => hay.includes(` ${phrase} `);

/** The category that forces a static hold, or null. First match wins, in STATIC_HOLD_CATEGORIES order. */
export function staticHoldReason(imagePrompt: string): StaticHoldCategory | null {
  const hay = haystack(imagePrompt);
  for (const cat of STATIC_HOLD_CATEGORIES) {
    for (const phrase of STATIC_HOLD_TRIGGERS[cat]) if (hasPhrase(hay, phrase)) return cat;
  }
  return null;
}

export const needsStaticHold = (imagePrompt: string): boolean => staticHoldReason(imagePrompt) !== null;

export function impliesPerson(imagePrompt: string): boolean {
  const hay = haystack(imagePrompt);
  return (PERSON_WORDS as readonly string[]).some((w) => hasPhrase(hay, w));
}

/** The kind a shot actually gets: the routing rule wins over whatever the planner asked for. */
export function resolveKind(kind: ShotKind, imagePrompt: string): ShotKind {
  return needsStaticHold(imagePrompt) ? "static_forced" : kind;
}

// ---------------------------------------------------------------------------------------------------------------
// Sequencing rules — pure functions, every one of them a FAILURE and not a warning
// ---------------------------------------------------------------------------------------------------------------

/** No shot runs past this, ever. */
export const MAX_SHOT_S = 5.0;
/** …and no shot with a person in it runs past this. A held face is where morphing shows up first. */
export const MAX_PERSON_SHOT_S = 4.0;
/** At most this many loud moves inside any window of LOUD_WINDOW_S seconds. */
export const LOUD_MAX_PER_WINDOW = 2;
export const LOUD_WINDOW_S = 40.0;

export interface PlanShot {
  scene_id?: string;
  kind?: string;
  /** unknown, not string: half the point of the first rule is to catch a planner that wrote a list of moves. */
  move?: unknown;
  duration_s?: number;
  scale?: string;
  /** Who or what the shot is of. Two shots of the same subject may not repeat a scale; without it the rule stands down. */
  subject?: string;
  image_prompt?: string;
}

/** 5 → "5", 4.25 → "4.25". Same output as the Python mirror's '%g'. */
const num = (v: number): string => String(round2(v));

/** RULE 1 — one move per shot, never a list. */
export function checkOneMovePerShot(shots: readonly PlanShot[]): string[] {
  const errors: string[] = [];
  shots.forEach((sh, i) => {
    const at = `shot ${i + 1}`;
    const m = sh.move;
    if (Array.isArray(m)) {
      errors.push(`${at}: move must be one move, never a list (got ${m.length})`);
      return;
    }
    if (typeof m !== "string" || !m.trim()) {
      errors.push(`${at}: move is required and must be a move name`);
      return;
    }
    if (/[,+/]| then | and /i.test(m)) {
      errors.push(`${at}: move must be one move, never a list ('${m}')`);
      return;
    }
    if (!(m in MOVES)) errors.push(`${at}: unknown move '${m}' (one of ${Object.keys(MOVES).join(", ")})`);
  });
  return errors;
}

/** RULE 2 — 5.0 s ceiling on anything, 4.0 s when a person is implied. */
export function checkDurations(shots: readonly PlanShot[]): string[] {
  const errors: string[] = [];
  shots.forEach((sh, i) => {
    const at = `shot ${i + 1}`;
    const d = sh.duration_s;
    if (typeof d !== "number" || !Number.isFinite(d) || d <= 0) {
      errors.push(`${at}: duration_s is required and must be a positive number`);
      return;
    }
    if (d > MAX_SHOT_S) {
      errors.push(`${at}: duration ${num(d)}s is over the ${num(MAX_SHOT_S)}s maximum`);
      return;
    }
    const person = (PERSON_KINDS as readonly string[]).includes(String(sh.kind)) || impliesPerson(String(sh.image_prompt ?? ""));
    if (person && d > MAX_PERSON_SHOT_S)
      errors.push(`${at}: duration ${num(d)}s is over the ${num(MAX_PERSON_SHOT_S)}s maximum for a shot with a person in it`);
  });
  return errors;
}

/** Start time of each shot, from the durations (a missing or bad duration counts as 0). */
function startTimes(shots: readonly PlanShot[]): number[] {
  const starts: number[] = [];
  let t = 0;
  for (const sh of shots) {
    starts.push(t);
    const d = sh.duration_s;
    t += typeof d === "number" && Number.isFinite(d) && d > 0 ? d : 0;
  }
  return starts;
}

/** RULE 3 — at most 2 loud moves per 40 s, and never two in a row. */
export function checkLoudBudget(shots: readonly PlanShot[]): string[] {
  const errors: string[] = [];
  const loud = shots.map((sh) => typeof sh.move === "string" && isLoud(sh.move));
  for (let i = 1; i < shots.length; i++)
    if (loud[i] && loud[i - 1])
      errors.push(`shot ${i + 1}: loud move '${String(shots[i].move)}' is adjacent to the loud move at shot ${i}`);
  const starts = startTimes(shots);
  const idx = shots.map((_, i) => i).filter((i) => loud[i]);
  const flagged = new Set<number>();
  for (let a = 0; a < idx.length; a++) {
    const window: number[] = [];
    for (let b = a; b < idx.length && starts[idx[b]] < starts[idx[a]] + LOUD_WINDOW_S; b++) window.push(idx[b]);
    if (window.length > LOUD_MAX_PER_WINDOW) {
      const third = window[LOUD_MAX_PER_WINDOW];
      if (!flagged.has(third)) {
        flagged.add(third);
        errors.push(
          `shot ${third + 1}: more than ${LOUD_MAX_PER_WINDOW} loud moves within ${num(LOUD_WINDOW_S)}s (shots ${window.map((i) => i + 1).join(", ")})`,
        );
      }
    }
  }
  return errors;
}

/** RULE 4 — never two consecutive shots of the same move class. */
export function checkMoveClassAlternation(shots: readonly PlanShot[]): string[] {
  const errors: string[] = [];
  for (let i = 1; i < shots.length; i++) {
    const a = typeof shots[i - 1].move === "string" ? moveClassOf(shots[i - 1].move as string) : null;
    const b = typeof shots[i].move === "string" ? moveClassOf(shots[i].move as string) : null;
    if (a && b && a === b) errors.push(`shot ${i + 1}: move class ${b} repeats shot ${i} ('${String(shots[i - 1].move)}' then '${String(shots[i].move)}')`);
  }
  return errors;
}

/** RULE 5 — never two consecutive shots at the same scale on the same subject. */
export function checkScaleRepetition(shots: readonly PlanShot[]): string[] {
  const errors: string[] = [];
  const subj = (sh: PlanShot): string => String(sh.subject ?? "").trim().toLowerCase();
  const scaleOf = (sh: PlanShot): string => String(sh.scale ?? (sh.kind && (SHOT_GRAMMAR as Record<string, ShotPreset>)[sh.kind] ? presetFor(sh.kind).scale : "")).trim();
  for (let i = 1; i < shots.length; i++) {
    const sa = subj(shots[i - 1]);
    const sb = subj(shots[i]);
    if (!sa || !sb || sa !== sb) continue; // different subjects, or a plan that does not name them: the rule stands down
    const ka = scaleOf(shots[i - 1]);
    const kb = scaleOf(shots[i]);
    if (ka && kb && ka === kb) errors.push(`shot ${i + 1}: scale '${kb}' repeats shot ${i} on the same subject '${sb}'`);
  }
  return errors;
}

/** RULE 6 — screen direction stays consistent inside a scene. */
export function checkScreenDirection(shots: readonly PlanShot[]): string[] {
  const errors: string[] = [];
  const seen = new Map<string, { dir: Direction; at: number }>();
  shots.forEach((sh, i) => {
    const scene = String(sh.scene_id ?? "").trim();
    if (!scene || typeof sh.move !== "string") return;
    const d = directionOf(sh.move);
    if (!d || d === "none") return;
    const prev = seen.get(scene);
    if (!prev) seen.set(scene, { dir: d, at: i });
    else if (prev.dir !== d)
      errors.push(`shot ${i + 1}: screen direction flips inside scene '${scene}' (${prev.dir} at shot ${prev.at + 1}, ${d} here)`);
  });
  return errors;
}

/** Every sequencing rule, in order. Empty array = the plan is shootable. */
export function checkSequence(shots: readonly PlanShot[]): string[] {
  return [
    ...checkOneMovePerShot(shots),
    ...checkDurations(shots),
    ...checkLoudBudget(shots),
    ...checkMoveClassAlternation(shots),
    ...checkScaleRepetition(shots),
    ...checkScreenDirection(shots),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// The names the validator reads
//
// src/keou-contract.ts documents the surface it expects from this module and imports exactly these. They are thin
// readings of the table above, kept short and total: a kind always has a move, a move always has a class. The
// helpers the brief named (durationFor, promptFor, needsStaticHold, staticHoldReason, the check* rules) stay as
// they are; these are the same facts under the names the validator calls them by.
// ---------------------------------------------------------------------------------------------------------------

export type ShotMove = Move;

/** The camera move a kind resolves to. */
export const moveOf = (kind: ShotKind): ShotMove => presetFor(kind).move;

/** The scale a kind frames at. */
export const shotScale = (kind: ShotKind): Scale => presetFor(kind).scale;

/** The kind's window as a tuple, format factor and cap already applied. */
export function durationRange(kind: ShotKind, format: string): [number, number] {
  const w = durationFor(kind, format);
  return [w.min, w.max];
}

export const moveClass = (move: ShotMove): MoveClass => MOVES[move].class;
export const isLoudMove = (move: ShotMove): boolean => isLoud(move);

/** The move's screen direction, or null when it has none — a push, a crane and a hold never set a scene's direction. */
export function screenDirection(move: ShotMove): "left" | "right" | null {
  const d = MOVES[move].direction;
  return d === "left" || d === "right" ? d : null;
}

/** Why this picture breaks under a moving camera, as a phrase for an error message, or null. */
export function forcesStatic(imagePrompt: string): string | null {
  const cat = staticHoldReason(imagePrompt);
  return cat ? STATIC_HOLD_REASON[cat] : null;
}
