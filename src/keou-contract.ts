/**
 * TypeScript mirror of worker/keou/contract.py validate(), restricted to *storyboards*:
 * a full Keou project object without `id`, `script_file`, `music_quiet` and without any
 * scene of kind `image` (no assets can travel with a job). Enums are copied verbatim from
 * contract.py; keep the two files in sync. Error wording follows contract.py so a worker-side
 * failure and a server-side failure read the same.
 *
 * Kleo additions on top of the Keou project (the worker strips them before writing project.json):
 *   - top-level "kleo_style": cartoon | realistic | cyber | stickman (default cyber = the Keou look, no pictures);
 *   - style "picture" (docs/PICTURE-STYLE.md): the cartoon/realistic look. Each scene cuts between several full-screen
 *     pictures ("shots"), like a short documentary: no beats, no icons, no HUD. One shot = one generated picture,
 *     identified by `<sceneId>-s<n>`; the old per-scene "image_prompt" is accepted as shorthand for a single shot and
 *     normalised away here, so what is stored (and what the engine sees) always carries shots.
 * Clients never set scene.image or shot.image themselves: the server generates the pictures and the worker attaches them.
 *   - shot fields "covers", "cast", "action" (24 September 2026, AUTHORING_SHOT_FIELDS): what a shot shows of the
 *     user's request spec, who is in it, what moves in it. Server-side only: stripForWorker() removes them (and a
 *     top-level "spec") where src/internal.ts hands the storyboard to the worker.
 *
 * Shot grammar (src/shot-grammar.ts): a shot says what it is FOR — `shot_kind` in story terms — and the preset table
 * turns that into a camera move, a duration window, a motion strength and a prompt suffix. Nobody writes camera
 * language by hand any more: the old `motion` field is kept as a deprecated alias so storyboards written before the
 * grammar keep rendering, and its four names are normalised to the grammar's moves on the way in. This validator is
 * where the sequencing rules are ENFORCED — a run of shots that all push in, two loud moves in a row, a picture full
 * of hands under a moving camera — because everything downstream of here is paid for on a rented GPU.
 */

/**
 * The grammar itself lives in src/shot-grammar.ts (mirrored by worker/keou/shot_grammar.py): the ten kinds, the preset
 * table and the sequencing rules as pure functions. This file is where those rules become job-blocking errors, and it
 * is the only place that names the grammar's exports. The ".ts" extension is required: node --test loads this module
 * directly (type stripping, no bundler resolution).
 */
import {
  SHOT_KINDS,
  SHOT_GRAMMAR,
  durationFor,
  presetFor,
  staticHoldReason,
  checkOneMovePerShot,
  checkDurations,
  checkLoudBudget,
  checkMoveClassAlternation,
  checkScaleRepetition,
  checkScreenDirection,
  LOUD_MAX_PER_WINDOW,
  LOUD_WINDOW_S,
  MAX_SHOT_S,
  type Move,
  type PlanShot,
  type ShotKind,
  type StaticHoldCategory,
} from "./shot-grammar.ts";
export { SHOT_KINDS, SHOT_GRAMMAR, durationFor, LOUD_MAX_PER_WINDOW, LOUD_WINDOW_S, MAX_SHOT_S, MAX_PERSON_SHOT_S } from "./shot-grammar.ts";
export type { Move, ShotKind } from "./shot-grammar.ts";
/**
 * The direction (src/direction.ts): the art direction of ONE film — what the user asked for, the world it is drawn in,
 * what must never appear, and the colour law. It is a leaf module on purpose: it imports nothing from here, so this
 * file can import it without a cycle, and it takes the accent list as an argument instead of reaching for it.
 */
import { directionProblems, sectionOfScene, missingFacts, forbiddenInPrompts, notEnglish, foreignPictureFields, spokenFacts, D as DL, type Direction, type Section } from "./direction.ts";
export { directionProblems, sectionOfScene, missingFacts, forbiddenInPrompts, pictureContext, negativeFor, conformity, notEnglish, foreignPictureFields, lightsPictures, spokenFacts, motionHint, GENRES, D as DIRECTION_LIMITS } from "./direction.ts";
export type { Direction, Section, CastMember, CastRef, Genre, Conformity } from "./direction.ts";
/**
 * The request spec (src/spec.ts, 24 September 2026): the user's request taken apart into checkable items. A leaf
 * module with no imports, so the contract can read it without a cycle: trimShots() protects the only shot that shows
 * a must item, and fidelityWarnings() runs the deterministic coverage check on a storyboard that carries its spec.
 */
import { coverage, specOf, type RequestSpec } from "./spec.ts";
// The layer (src/graphics.ts): what is drawn over the film, decided per film by its treatment. The validator holds
// a storyboard to the grammar exactly as it holds it to the direction; the engine's hud.js draws only that grammar.
import { graphicsProblems, repairGraphics, sceneHudProblems, cardProblems, type Graphics } from "./graphics.ts";
export { graphicsProblems, repairGraphics, graphicsOf, sceneHudProblems, repairSceneHud, cardProblems, repairCards, graphicsBlock, sceneHudSchema, isNoLayer, LAYER_METHOD, HUD_KINDS, LINE_STATES, GL as GRAPHICS_LIMITS } from "./graphics.ts";
export type { Graphics, HudElement, SceneHud, Card } from "./graphics.ts";

export const STYLES = ["editorial", "technical", "illustrated", "terminal", "stickman", "cinema", "picture", "sketch"] as const;
export const KINDS = ["hero", "list", "compare", "steps", "metric", "image", "quote", "closing", "story", "cinema", "sketch"] as const;
export const BEAT_KINDS = ["icon", "type", "terminal", "steps", "people", "bars", "timeline", "dialog", "cta", "split", "grid"] as const;
export const BEAT_ICONS = ["coffee", "desk", "hoodie", "keyboard", "hand", "bug", "alarm", "shield", "radar", "car", "keyfob", "house", "amplifier", "pouch", "lock", "timer", "check", "cross", "figure", "thief", "phone", "wave", "clock"] as const;
export const BEAT_FX = ["lit", "dead", "key", "open", "drive", "alarm", "point", "run", "think"] as const;
export const CINEMA_ACCENTS = ["green", "cyan", "red", "amber"] as const;
/**
 * The explainer (Kleo style "explainer", Keou style "sketch"): hand-drawn white marker line art on
 * pure black, ONE accent per section and never two in a frame, a camera that only ever pushes in,
 * and burned-in karaoke captions as the only text. These six lists mirror worker/keou/contract.py
 * exactly; test/explainer-contract.test.mjs fails the build if they ever drift, because a drift is
 * a job that validates here, rents a GPU, and dies there with the credit already spent.
 */
export const SKETCH_ACCENTS = ["red", "blue", "green", "yellow", "white"] as const;
/** The alphabet the explainer draws with: the hotel film's nineteen, then what every other subject needs. */
export const SKETCH_ART = ["figure", "hand", "keycard", "door", "reader", "phone", "corridor", "tag", "room", "writer", "blank",
  "crowbar", "bell", "hotels", "globe", "face", "intruder", "footprints", "suitcase", "crowd", "handshake",
  "eye", "brain", "robot", "laptop", "server", "router", "camera", "chip", "usb", "car", "lock", "key",
  "shield", "bug", "fingerprint", "envelope", "signal", "chart", "graph", "folder", "cloud", "code", "scale",
  "warning", "question", "city", "coin", "clock", "calendar", "box", "book", "rocket", "bulb", "magnifier",
  "gear", "chain", "tree", "satellite"] as const;
/**
 * How far each drawing reaches BELOW its own centre, in design pixels at size 1, measured by running
 * every builder against a context that records where it puts ink (scripts/sketch-extent.mjs). It is what
 * makes the caption safe area a fact rather than a guess: a tag is 53 pixels tall and a figure is 246, so
 * one rule for both is either useless or wrong. The five at 0 are backdrops — the space the other
 * drawings stand in — and the caption is meant to sit over them.
 */
export const SKETCH_DROP: Record<string, number> = {
  figure: 335, hand: 242, keycard: 237, door: 399, reader: 374, phone: 392, corridor: 0, tag: 53, room: 0,
  writer: 254, blank: 0, crowbar: 334, bell: 399, hotels: 0, globe: 413, face: 400, intruder: 349,
  footprints: 361, suitcase: 245, crowd: 152, handshake: 168, eye: 220, brain: 336, robot: 368, laptop: 220,
  server: 356, router: 210, camera: 0, chip: 331, usb: 156, car: 155, lock: 370, key: 161, shield: 367,
  bug: 315, fingerprint: 356, envelope: 296, signal: 365, chart: 239, graph: 303, folder: 284, cloud: 220,
  code: 276, scale: 371, warning: 289, question: 328, city: 0, coin: 300, clock: 400, calendar: 342,
  box: 350, book: 250, rocket: 401, bulb: 308, magnifier: 334, gear: 348, chain: 126, tree: 358,
  satellite: 390,
};
export const SKETCH_MOODS = ["worried", "scared", "calm"] as const;
export const SKETCH_MOTION = ["turn", "slide", "rise", "tap", "shake", "walk", "pulse", "drift"] as const;
export const SKETCH_ENTER = ["whip", "cut"] as const;
export const SKETCH_EXIT = ["flare", "cut"] as const;
export const STORY_ACTS = ["idle", "explain", "point-up", "shrug", "think", "alarm", "hold", "drop", "wave", "walk", "run", "crouch"] as const;
export const STORY_CAST = ["hero", "thief", "thief2"] as const;
export const STORY_PROPS = ["keyfob", "car", "house", "amplifier", "pouch", "timer", "bar", "check"] as const;
export const STORY_FX = ["drive-off", "relay", "relay-fail", "signal", "drop"] as const;
export const STORY_ACCENTS = ["green", "red", "amber"] as const;
export const VISUALS = ["focus", "network", "cycle", "spark", "globe", "check", "growth"] as const;
export const BASE_MOTION = ["galaxy", "orbit-compare", "voice-signal", "ai-network", "data-flow"] as const;
export const ESCAPE_MOTION = ["timeline-track", "package-server", "sandbox-grid", "swarm-board", "cluster-intrusion", "kill-chain", "flag-grid", "defense-side", "paper-grader", "terminal-quote"] as const;
export const MOTION = [...BASE_MOTION, ...ESCAPE_MOTION] as const;
export const LABELLED_MOTION = ["voice-signal", "ai-network", "data-flow", ...ESCAPE_MOTION] as const;
/** Kokoro voices per language. Italian (lang_code 'i') is supported by kokoro 0.9.4 (requirements.txt). */
export const VOICES: Record<string, readonly string[]> = {
  fr: ["ff_siwis"],
  en: ["af_heart", "am_michael", "bf_emma"],
  it: ["if_sara", "im_nicola"],
};
export const LANGUAGES = Object.keys(VOICES);
export const FORMATS = ["9:16", "16:9"] as const;
/** Kleo visual styles. cartoon/realistic cut between generated pictures (Keou style "picture"); cyber is the plain Keou look; stickman is Keou's stickman. */
export const KLEO_STYLES = ["cartoon", "realistic", "animation", "cyber", "stickman", "explainer"] as const;
export type KleoStyle = (typeof KLEO_STYLES)[number];
/** Styles whose shots get a generated picture; they are exactly the styles that use the Keou style "picture". */
export const PICTURE_STYLES: readonly KleoStyle[] = ["cartoon", "realistic", "animation"];
/** The looks a film is sold in (14 September 2026): filmed, or drawn as a 2D animated film. Both are "picture" projects whose stills kie.ai animates. */
export const FILM_LOOKS = ["realistic", "animation"] as const;
export type FilmLook = (typeof FILM_LOOKS)[number];
export const IMAGE_PROMPT_MAX = 240;
/**
 * The deprecated shot field: `motion` named the camera move by hand, and when it was missing the engine picked a
 * direction from a hash of the scene id — arbitrary movement, which is what the shot grammar replaces. The four old
 * names are still accepted, silently, and normalised to the grammar's moves here, so a stored storyboard never carries
 * "in" again and validating it a second time changes nothing.
 */
export const SHOT_MOTION = ["in", "out", "left", "right"] as const;
export const MOTION_ALIASES: Record<(typeof SHOT_MOTION)[number], Move> = { in: "push_in", out: "pull_out", left: "track_left", right: "track_right" };
/** The moves `motion` may already hold (what the aliases normalise to). Everything else is said with shot_kind. */
export const MOTION_MOVES: readonly Move[] = Object.values(MOTION_ALIASES);
/** Motion strength a shot may ask for; the preset table carries the default for each kind. */
export const SHOT_STRENGTH_MIN = 0;
export const SHOT_STRENGTH_MAX = 1.0;
export const IMAGE_PROMPT_MIN = 2;
export const SHOT_CAPTION_MAX = 40;
export const SHOT_HL_MAX = 20;
export const SHOT_AT_MAX = 24;
/**
 * Everything a shot may carry, mirroring contract.py SHOT_FIELDS with image_prompt where the engine has the
 * worker-attached `image`. contract.py refuses a shot with any other key, and it only runs once the GPU is rented
 * and the pictures are drawn: whatever the server lets through here is paid for before the engine throws it out.
 * contract.py's `cut` is the box's own (the whole second a bought clip begins at: worker/kleo_worker.py
 * fit_to_clips), never a storyboard's, so it is refused here like any unknown key.
 */
export const SHOT_FIELDS = ["image_prompt", "caption", "hl", "at", "shot_kind", "strength", "dur", "motion"] as const;
/**
 * THE AUTHORING FIELDS (24 September 2026, the fidelity engine): what a shot says about the USER'S REQUEST, read only
 * on the server and removed before the storyboard reaches the worker (stripForWorker, called where src/internal.ts
 * hands it over — worker/keou/contract.py refuses any shot key outside its SHOT_FIELDS, and it would refuse these on a
 * GPU that has already been paid for).
 *   - covers: the spec item ids this shot SHOWS ("R3", "R7"). The coverage check (src/spec.ts coverage) counts them,
 *     the vision judge asks one question per id about the drawn still, and trimShots() never drops the only shot
 *     that covers a must item.
 *   - cast:   the characters IN THE PICTURE, by spec cast id ("c1") or by the direction's cast name. castFor() uses it
 *     before it guesses from the prompt's words, and the stills engine passes those characters' sheets as references.
 *   - action: what moves or happens during the shot, in English, for the clip model (the still is drawn from
 *     image_prompt alone; the movement no longer rides on it — src/direction.ts motionHint()).
 * They are not in SHOT_FIELDS, which stays the mirror of what the engine accepts.
 */
export const AUTHORING_SHOT_FIELDS = ["covers", "cast", "action"] as const;
export const SHOT_ACTION_MAX = 240;
export const SHOT_COVERS_MAX = 12;
/** One entry of covers or cast: a spec id ("R12", "c3") or a cast name, at most the direction's name length. */
export const SHOT_TAG_MAX = DL.cast.name;
/** Characters one picture can name in its cast: the direction's own ceiling. */
export const SHOT_CAST_MAX = DL.cast.max;
/**
 * Shots per scene: a cinema scene cuts up to four times, a closing shows one picture (two at most).
 * The contract's floor stays 1 because worker/keou/contract.py has the same floor and the two must not drift; the
 * floor a NEW storyboard is actually held to is SHOTS_MIN_CINEMA, enforced by qualityProblems() on the server alone.
 */
export const SHOTS_PER_SCENE: Record<"cinema" | "closing", [number, number]> = { cinema: [1, 4], closing: [1, 2] };
/** The real floor for a cinema scene, server-side. One picture per narrated line is a slideshow; two is a cut. */
export const SHOTS_MIN_CINEMA = 2;
/**
 * THE SHOTS A LINE CAN CARRY (22 September 2026). The first real film of the day (gt_378ce9xp, 15 s) was planned as
 * twelve shots, eleven of them about one second long: every one billed by kie.ai at its four-second minimum (0.26 $),
 * 3.25 $ of clips for fifteen seconds of film — five times the tariff's assumption — and a cut every second that
 * nobody reads. A shot is about three seconds of voice at the least, so a line of `words` words (2.7 a second)
 * carries at most floor(words / 7) shots, one to four (floor, not round: the verification film gt_nyhb8aj9 gave an
 * eleven-word line two shots of 1.4 s, each still a four-second clip); and the two-picture floor holds only for a
 * line long enough for two (14 words, about five seconds). SHOTS_WORDS_PER_SHOT is the one number.
 */
export const SHOTS_WORDS_PER_SHOT = 7;
export const SHOTS_MIN_WORDS_FOR_TWO = 14;
/**
 * THE CLIP FLOOR (25 September 2026). On the API road every shot is a clip bought at the model's shortest length
 * (4 s on Seedance 2.5 and MiniMax H3) whatever the film keeps of it, so a shot of two seconds pays for four. With a
 * floor of `floorS` seconds a shot carries at least that much voice: floorS × 2.45 words a second × 1.1 (the voice's
 * speed), never fewer than the seven of the local road — eleven words for a 4-second floor. 0 is the local road and
 * the animatic, where nothing is bought per shot: the seven-word rule, unchanged.
 */
export const clipWordsPerShot = (floorS = 0): number => (floorS > 0 ? Math.max(SHOTS_WORDS_PER_SHOT, Math.ceil(floorS * FILM_WPS * 1.1)) : SHOTS_WORDS_PER_SHOT);
/**
 * THE TWO SPEECH RATES (25 September 2026). FILM_WPS is what the planner budgets with: 2.45 words a second of FILM at
 * voice speed 1.0 (2.7 at the planner's 1.1), pauses included — the rate wordBudget, speedFor and clipWordsPerShot
 * share (recalibrated 22 September, see wordBudget). KOKORO_WPS is the voice itself, measured on the real Kokoro
 * lines of gt_t2cxm2md (25 September, speed 1.0): 27 words spoken in 8.19 s (7 words in 2.19 s, 13 in 3.71 s, 7 in
 * 2.29 s) — 3.3 words a second of speech, no pause. The two agree on the clip floor: eleven words at 1.1 are 3.03 s of
 * speech, which with the scene's own pause fills a 4-second clip inside the worker's 1-second pad limit
 * (worker/kleo_worker.py FIT_MAX_PAD); seven words are 1.9 s, and the box has to leave that clip to the old cut — the
 * film that came out 11.2 s long for 15 asked.
 */
export const FILM_WPS = 2.45;
export const KOKORO_WPS = 3.3;
/** Seconds a line of `words` words takes to SAY at Kokoro speed `speed` (KOKORO_WPS; no pause counted). */
export const spokenSeconds = (words: number, speed = 1): number => Math.max(0, Number(words) || 0) / (KOKORO_WPS * (speed > 0 ? speed : 1));
export function shotBudget(words: number, floorS = 0): { min: number; max: number } {
  const w = Math.max(0, Number(words) || 0);
  const per = clipWordsPerShot(floorS);
  return { min: w >= 2 * per ? SHOTS_MIN_CINEMA : 1, max: Math.max(1, Math.min(SHOTS_PER_SCENE.cinema[1], Math.floor(w / per))) };
}
const voiceWords = (s: unknown): number => (isObj(s) && typeof s.voice === "string" ? s.voice.trim().split(/\s+/).filter(Boolean).length : 0);
/** The spec ids a shot claims in `covers`, whatever the shot is. */
const coversOf = (sh: unknown): string[] => (isObj(sh) && Array.isArray(sh.covers) ? sh.covers.filter((x): x is string => typeof x === "string") : []);
/**
 * Every cinema scene keeps at most the shots its line can carry (shotBudget): the last touch on a storyboard before it
 * is stored, on both roads into the queue, because the planner writes the shot count it is told and not the one the
 * seconds allow. Returns the number of shots dropped.
 *
 * WHICH shots go (24 September 2026). It used to keep the first ones and drop the rest blindly — and the rest were
 * often the point: the second shot of a scene is where the user's "close-up of her hands on the letter" was, and it
 * was cut for being second. With a spec, a shot that is the ONLY one covering a must item is never dropped; the shots
 * that cover no must item go first (from the end of the scene), then the ones whose items another shot also shows.
 * When every shot left is the sole witness of something the user asked for, the scene keeps them all, over budget:
 * a scene a second too dense is a smaller fault than a film without the thing it was ordered for. Without a spec the
 * order is the old one — the last shots go first.
 *
 * `floorS` is the job's clip floor (shotBudget): the same number qualityProblems() is given, so the floor that trims a
 * scene and the one that asks for a second picture can never disagree and send a storyboard round a refusal loop.
 */
export function trimShots(sb: { scenes?: unknown }, spec?: RequestSpec | null, floorS = 0): number {
  const scenes = Array.isArray(sb.scenes) ? (sb.scenes as unknown[]) : [];
  const must = new Set((spec?.items ?? []).filter((i) => i && i.must).map((i) => i.id));
  // How many shots of the whole film claim each must item: a shot is the sole witness when its item's count is 1.
  const count = new Map<string, number>();
  for (const s of scenes) if (isObj(s) && Array.isArray(s.shots)) for (const sh of s.shots) for (const id of new Set(coversOf(sh))) if (must.has(id)) count.set(id, (count.get(id) ?? 0) + 1);
  const claims = (sh: unknown) => coversOf(sh).some((id) => must.has(id));
  const sole = (sh: unknown) => coversOf(sh).some((id) => must.has(id) && (count.get(id) ?? 0) <= 1);
  let dropped = 0;
  for (const s of scenes) {
    // A closing keeps its two pictures on the local road; with a clip floor each of them is a paid clip, and it is held
    // to the line's budget like any other scene (25 September 2026).
    if (!isObj(s) || (s.kind === "closing" && !(floorS > 0)) || !Array.isArray(s.shots)) continue;
    const shots = s.shots as unknown[];
    let over = shots.length - shotBudget(voiceWords(s), floorS).max;
    if (over <= 0) continue;
    // Pass 0: the shots that claim no must item. Pass 1: the ones whose must items another shot also shows. Each pass
    // walks from the end of the scene, so without a spec (nothing claims anything) this is exactly the old order.
    for (const pass of [0, 1] as const) {
      for (let i = shots.length - 1; i >= 0 && over > 0; i--) {
        const sh = shots[i];
        if (pass === 0 ? claims(sh) : sole(sh)) continue;
        for (const id of new Set(coversOf(sh))) if (must.has(id)) count.set(id, (count.get(id) ?? 1) - 1);
        shots.splice(i, 1); over--; dropped++;
      }
    }
    // The first picture opens the scene and may not carry "at": when the old first shot went, the new one loses its anchor.
    if (isObj(shots[0]) && "at" in shots[0]) delete shots[0].at;
  }
  return dropped;
}
/**
 * THE LAST RESORT FOR A LINE TOO SHORT FOR ITS CLIP (25 September 2026). On the API road every scene is at least one
 * clip bought at the floor, and a line under clipWordsPerShot(floorS) words cannot fill it: the box leaves that scene
 * to the old cut (worker/kleo_worker.py FIT_PAD), buys four seconds and shows two (gt_t2cxm2md: lines of 7, 13 and 7
 * words, 12 s of clips for an 11.2 s film asked as 15). The planner asks for the missing words first, with their exact
 * number; what is still short after that is JOINED to a neighbour here, never padded: the two lines are said as one,
 * in their order, word for word (so a user's dictated script stays exactly theirs), the two scenes' pictures become
 * one scene's, and one clip fewer is bought. Nothing is invented and nothing is dropped from the voice.
 *
 * Which pair: the thinnest line first, joined to the neighbour that makes the shorter line. The joined scene keeps the
 * id, chapter, accent, title, layer state and cards of the one with more words (its section keeps the scene; the
 * other section gives one up and disappears when it had only that one), the transition INTO the pair, and the kind of
 * the second (a closing stays the closing). A join the direction's colour law would refuse — two neighbouring
 * sections left with one accent — is not made; the next candidate is tried. A film never goes under two scenes (the
 * contract's floor). The joined scene's pictures are then held to its line's budget (trimShots, the spec's sole
 * witnesses kept) and to the kind's ceiling. `onMerge(at, keepFirst)` is told every join — scenes `at` and `at + 1`
 * became one at `at` — so a caller can join whatever it keeps in parallel (the planner's outline). Returns one line
 * per join, for the history. 0 is the local road and the animatic: nothing is bought per shot, nothing is joined.
 */
export function mergeThinScenes(sb: { scenes?: unknown; direction?: unknown; style?: unknown }, floorS = 0, opts: { spec?: RequestSpec | null; onMerge?: (at: number, keepFirst: boolean) => void } = {}): string[] {
  if (!(floorS > 0) || !Array.isArray(sb.scenes) || ("style" in sb && sb.style !== undefined && sb.style !== "picture")) return [];
  const scenes = sb.scenes as unknown[];
  const per = clipWordsPerShot(floorS);
  const notes: string[] = [];
  const dir = isObj(sb.direction) && Array.isArray(sb.direction.sections) ? (sb.direction as { sections: Section[] }) : null;
  const voiceOf = (s: Record<string, unknown>): string => (typeof s.voice === "string" ? s.voice.trim() : "");
  for (let guard = 0; guard < 240 && scenes.length > 2; guard++) {
    const pairs: { k: number; thin: number; words: number }[] = [];
    for (let k = 0; k + 1 < scenes.length; k++) {
      const a = scenes[k], b = scenes[k + 1];
      if (!isObj(a) || !isObj(b)) continue;
      const wa = voiceWords(a), wb = voiceWords(b);
      if (wa >= per && wb >= per) continue;
      pairs.push({ k, thin: Math.min(wa, wb), words: wa + wb });
    }
    pairs.sort((x, y) => x.thin - y.thin || x.words - y.words || x.k - y.k);
    let joined = false;
    for (const { k } of pairs) {
      const a = scenes[k] as Record<string, unknown>, b = scenes[k + 1] as Record<string, unknown>;
      const keepFirst = voiceWords(a) >= voiceWords(b);
      // The sections after the join: the section of the scene that is not kept gives up one scene.
      let sections: Section[] | null = null;
      if (dir) {
        const owner: number[] = [];
        dir.sections.forEach((s, j) => { for (let n = 0; n < (Number(s?.scenes) || 0); n++) owner.push(j); });
        if (owner.length === scenes.length) {
          const loser = owner[k] === owner[k + 1] ? owner[k] : owner[keepFirst ? k + 1 : k];
          sections = dir.sections.map((s, j) => (j === loser ? { ...s, scenes: s.scenes - 1 } : { ...s })).filter((s) => s.scenes > 0);
          if (sections.length < DL.sections.min || sections.some((s, j) => j > 0 && s.accent === sections![j - 1].accent)) continue;
        }
      }
      const keep = keepFirst ? a : b;
      const va = voiceOf(a), vb = voiceOf(b);
      const voice = `${va}${va && !/[.!?…"'»)\]]$/.test(va) ? "." : ""}${va && vb ? " " : ""}${vb}`;
      // The second line's first picture now cuts on its first words: the shortest run of them that the first line
      // does not already say, so the cut cannot land early.
      const bw = vb.split(/\s+/).filter(Boolean);
      const runs = [1, 2, 3, 4].filter((n) => n <= bw.length).map((n) => bw.slice(0, n).join(" ")).filter((r) => r.length <= SHOT_AT_MAX);
      const at = runs.find((r) => !va.toLowerCase().includes(r.toLowerCase())) ?? runs[runs.length - 1] ?? "";
      const shotsA = Array.isArray(a.shots) ? (a.shots as unknown[]).map((x) => (isObj(x) ? { ...x } : x)) : [];
      const shotsB = Array.isArray(b.shots) ? (b.shots as unknown[]).map((x) => (isObj(x) ? { ...x } : x)) : [];
      if (isObj(shotsB[0])) { if (at) (shotsB[0] as Record<string, unknown>).at = at; else delete (shotsB[0] as Record<string, unknown>).at; }
      const merged: Record<string, unknown> = { ...keep, kind: b.kind, voice, shots: [...shotsA, ...shotsB] };
      if (typeof b.hold === "number") merged.hold = b.hold; else delete merged.hold;
      if (a.transition !== undefined) merged.transition = a.transition; else delete merged.transition;
      if (b.kind === "closing") { for (const f of ["button", "detail"]) { if (f in b) merged[f] = b[f]; else delete merged[f]; } }
      else { delete merged.button; delete merged.detail; }
      trimShots({ scenes: [merged] }, opts.spec ?? null, floorS);
      const cap = SHOTS_PER_SCENE[merged.kind === "closing" ? "closing" : "cinema"][1];
      if (Array.isArray(merged.shots) && merged.shots.length > cap) merged.shots = (merged.shots as unknown[]).slice(0, cap);
      if (Array.isArray(merged.shots) && isObj(merged.shots[0])) delete (merged.shots[0] as Record<string, unknown>).at;
      scenes.splice(k, 2, merged);
      if (dir && sections) dir.sections = sections;
      opts.onMerge?.(k, keepFirst);
      notes.push(`scenes ${k + 1} and ${k + 2} ("${String(a.id)}", ${voiceWords(a)} words; "${String(b.id)}", ${voiceWords(b)} words) were joined into one line of ${voiceWords(merged)} words: a line under ${per} words cannot fill a ${floorS}-second clip`);
      joined = true;
      break;
    }
    if (!joined) break;
  }
  return notes;
}
/** The shot range the guide, the planner and the website all quote, so the three can never say three different things. */
export const shotRangeText = (kind: "cinema" | "closing"): string =>
  kind === "closing" ? `${SHOTS_PER_SCENE.closing[0]}-${SHOTS_PER_SCENE.closing[1]}` : `${SHOTS_MIN_CINEMA}-${SHOTS_PER_SCENE.cinema[1]}`;
export const CLOSING_BUTTON_MAX = 24;
/** Scene ids may not end with the shot suffix: picture ids are `<sceneId>-s<n>` and must stay unambiguous. */
export const SHOT_ID_SUFFIX_RE = /-s\d+$/;
/**
 * Pictures a video may carry in total (server + worker): 24 for a Short, 48 for a long video. Defined here so the
 * server (images.ts, re-exported there), the guide and the tests all read the same number.
 */
export const MAX_PICTURES = (duration_s: number): number => (duration_s <= 90 ? 24 : 48);
export const WIDTHS: Record<string, readonly number[]> = { "9:16": [540, 1080, 2160], "16:9": [960, 1920, 3840] };

/** Fields a storyboard must not carry (the worker adds them) and the scene kind it cannot use. */
export const FORBIDDEN_FIELDS = ["id", "script_file", "music_quiet"] as const;
export const FORBIDDEN_KINDS = ["image"] as const;
export const FORBIDDEN_SCENE_FIELDS = ["image", "image_credit", "motion", "motion_labels", "motion_text", "motion_date", "motion_count", "motion_total", "motion_stage"] as const;

export type Format = (typeof FORMATS)[number];
export type Storyboard = Record<string, unknown> & { scenes: Record<string, unknown>[] };

/** The Kleo style of a storyboard: explicit kleo_style, else stickman/cartoon for a stickman/picture project, else cyber. */
export function kleoStyleOf(sb: unknown): KleoStyle {
  const c = (typeof sb === "object" && sb !== null ? sb : {}) as Record<string, unknown>;
  if ((KLEO_STYLES as readonly string[]).includes(c.kleo_style as string)) return c.kleo_style as KleoStyle;
  if (c.style === "stickman") return "stickman";
  if (c.style === "sketch") return "explainer";
  return c.style === "picture" ? "cartoon" : "cyber";
}
/**
 * Every picture of a storyboard, flattened in scene → shot order: `{ id: "<sceneId>-s<n>", image_prompt }`.
 * Only the styles that draw pictures (cartoon/realistic) have any; a cyber or stickman storyboard returns [].
 * A scene-level image_prompt without shots (old format, not yet normalised) counts as the single shot 1.
 */
export interface PictureScene {
  id: string;
  image_prompt: string;
  accent: string | null;
  /** The shot's kind as written (or as the validator resolved it), null when it has none. */
  shot_kind: string | null;
  /** The authoring fields (AUTHORING_SHOT_FIELDS), always present: empty lists and null when the shot has none. */
  covers: string[];
  cast: string[];
  action: string | null;
}
export function pictureScenes(sb: unknown): PictureScene[] {
  const c = (typeof sb === "object" && sb !== null ? sb : {}) as Record<string, unknown>;
  if (!PICTURE_STYLES.includes(kleoStyleOf(c)) || !Array.isArray(c.scenes)) return [];
  return (c.scenes as unknown[]).flatMap((s) => {
    const sc = (typeof s === "object" && s !== null ? s : {}) as Record<string, unknown>;
    if (typeof sc.id !== "string" || !sc.id) return [];
    // The scene's accent travels with its pictures: the colour law only exists for the viewer once the accent
    // reaches the image model, and until now it stopped at the caption furniture.
    const accent = typeof sc.accent === "string" && (CINEMA_ACCENTS as readonly string[]).includes(sc.accent) ? sc.accent : null;
    const shots = Array.isArray(sc.shots) ? (sc.shots as unknown[]) : typeof sc.image_prompt === "string" ? [{ image_prompt: sc.image_prompt }] : [];
    return shots.flatMap((sh, i) => {
      const o = (typeof sh === "object" && sh !== null ? sh : {}) as Record<string, unknown>;
      const p = typeof o.image_prompt === "string" ? o.image_prompt.trim() : "";
      if (!p) return []; // a shot without a prompt keeps its index: ids follow the shot number
      const tags = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : []);
      const action = typeof o.action === "string" && o.action.trim() ? o.action.trim() : null;
      return [{ id: `${sc.id}-s${i + 1}`, image_prompt: p, accent, shot_kind: typeof o.shot_kind === "string" ? o.shot_kind : null, covers: tags(o.covers), cast: tags(o.cast), action }];
    });
  });
}

/** The direction a storyboard carries, or null. Storyboards written before the direction existed simply have none. */
export function directionOf(sb: unknown): Direction | null {
  const c = (typeof sb === "object" && sb !== null ? sb : {}) as Record<string, unknown>;
  const d = c.direction;
  return isObj(d) && typeof d.subject === "string" ? (d as unknown as Direction) : null;
}

/**
 * The narration of a storyboard, joined. The fidelity gate (missingFacts) reads this: it is the only text a viewer
 * actually hears, so it is the only text that can prove the video says what the user asked for.
 */
export function narrationOf(sb: unknown): string {
  const c = (typeof sb === "object" && sb !== null ? sb : {}) as Record<string, unknown>;
  if (!Array.isArray(c.scenes)) return "";
  return (c.scenes as unknown[]).map((s) => (isObj(s) && typeof s.voice === "string" ? s.voice : "")).filter(Boolean).join(" ");
}
export interface ValidateOptions {
  format: Format;
  language: string;
  /** The job's clip floor in seconds (shotBudget): 0, the default, on the local road and for the animatic. */
  clipFloorS?: number;
  /** Maximum number of errors collected (default 10). */
  maxErrors?: number;
  /**
   * Refuse a storyboard that carries no direction. OFF by default, and on only for a storyboard an assistant wrote
   * (src/jobs.ts): the planner writes its own direction in phase 0 and validates the draft several times on the way
   * there, so the same rule would refuse Kleo's own half-built work.
   *
   * It exists because the guide promises it. `kleo_storyboard_guide` says "THE DIRECTION — write this FIRST, before
   * a single scene" and then "Kleo enforces it"; without this flag that sentence was false on the one path it was
   * written for, and an assistant that skipped the block got a film with no colour law, no fidelity gate and no
   * forbidden list, silently, for the same money. The refusal costs nothing — no model call, no GPU, no credit —
   * and the message says what to add, so the assistant fixes it in the same conversation.
   */
  requireDirection?: boolean;
}
/**
 * The result always carries the NORMALISED object, whether or not it is legal: validation and normalisation are the
 * same pass (a scene-level image_prompt becomes shots[0], a deprecated motion becomes a move, a missing anchor is
 * chosen), and a caller that has to report on a rejected draft needs to see what the draft became. `ok` says whether
 * it may be rendered; `storyboard` and `normalised` are the same object under two names, honestly typed.
 */
/**
 * `warnings` are the problems that do NOT refuse the storyboard: the rhythm of the shots (src/shot-grammar.ts rules 3-6)
 * and a picture prompt written in the narration's language instead of English. The planner feeds them back to the
 * model once and then keeps the scenes; a client is told them and the job is created. They used to be errors, and a
 * story about a pastry chef — hands at work in every shot, so every shot a forced static hold, so every pair a
 * "STILL repeats" refusal no shot_kind could fix — died twice in planning on 19 September 2026, thirteen minutes each.
 */
export type ValidateResult =
  | { ok: true; storyboard: Storyboard; warnings: string[] }
  | { ok: false; errors: string[]; normalised: unknown; warnings: string[] };

const MAX_ERRORS = 10;
class TooMany extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const printable = (s: string) => ![...s].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
const sorted = (list: readonly string[]) => `[${[...list].sort().map((x) => `'${x}'`).join(", ")}]`;
const subset = (items: unknown[], set: readonly string[]) => items.every((x) => typeof x === "string" && (set as readonly string[]).includes(x));
/** The engine's word key (engine/picture.js `key`): lowercase, everything but a-z0-9%$ dropped. */
const wordKey = (w: string) => w.toLowerCase().replace(/[^a-z0-9%$]/g, "");
/** A text as the engine reads it: whitespace-separated words, keyed, empties dropped (engine/picture.js shotStarts). */
const wordsOf = (s: string) => s.split(/\s+/).map(wordKey).filter(Boolean);
/**
 * True when `at` quotes the scene voice the way *both* engine checks read it, so an accepted cut is really anchored:
 *   - picture.js shotStarts() keys the shot's words and the aligned s.words and looks for the shot's words as a
 *     contiguous run of the scene's. A fragment that is not a whole word ("orty pirate", "he st") matches no run,
 *     so the cut silently falls back to the even split — the picture lands on nothing in particular.
 *   - contract.py (like the cinema-beat rule it reuses) keeps a raw substring test on the lowercased voice, and it
 *     runs on the GPU after the pictures are paid for, so a quote it would reject must never leave the server.
 * Both are required: neither implies the other ("hello world" is whole words of "Hello, world" but not a substring).
 */
export const quotesVoice = (at: string, voice: string): boolean => {
  const toks = wordsOf(at), said = wordsOf(voice);
  if (!toks.length || !voice.toLowerCase().includes(at.toLowerCase())) return false;
  for (let i = 0; i + toks.length <= said.length; i++) if (toks.every((tk, m) => said[i + m] === tk)) return true;
  return false;
};

/** Seconds as the model wrote them: 2.45, not 2.4500000000000003. */
const secs = (n: number) => String(Math.round(n * 100) / 100);
/** The deprecated field says, in its own error message, what to write instead. */
const motionHelp = () =>
  `motion is deprecated: it names the camera move by hand (${sorted(SHOT_MOTION)} normalise to ` +
  `${MOTION_MOVES.join(", ")}). Say what the shot is FOR with shot_kind — one of ${sorted(SHOT_KINDS)} — and the ` +
  `shot grammar picks the move`;
/** Why a picture is held still, in words a model can act on (the grammar answers with a category). */
const STATIC_WHY: Record<StaticHoldCategory, string> = {
  hands: "hands doing something",
  people: "a crowd, or two people interacting",
  signage: "signage the viewer can read",
  mechanism: "a mechanism with moving parts",
};

/** One shot as the sequencing rules read it: the grammar's PlanShot, plus the label this file reports it under. */
type SeqShot = PlanShot & { label: string | null };

class Collector {
  errors: string[] = [];
  /** Problems worth fixing that do not refuse the storyboard (ValidateResult.warnings). Never counted against `max`. */
  warnings: string[] = [];
  private max: number;
  constructor(max: number) { this.max = max; }
  add(msg: string): void {
    this.errors.push(msg);
    if (this.errors.length >= this.max) throw new TooMany();
  }
  warn(msg: string): void { this.warnings.push(msg); }
  /** contract.py text(): required non-blank string up to `maximum` chars. Returns true when valid. */
  text(value: unknown, label: string, maximum = 180): value is string {
    if (typeof value !== "string" || !value.trim() || value.length > maximum) {
      this.add(`${label}: required text, maximum ${maximum} characters`);
      return false;
    }
    return true;
  }
  finite(value: unknown, low: number, high: number, label: string): boolean {
    if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high) {
      this.add(`${label}: expected a number between ${low} and ${high}`);
      return false;
    }
    return true;
  }
}

/**
 * One explainer scene, mirroring worker/keou/contract.py. This is the only gate that runs BEFORE a
 * GPU is rented and a credit is spent, so every rule the Python enforces has to be here too.
 */
function validateSketchScene(c: Record<string, unknown>, s: Record<string, unknown>, label: string, e: Collector): void {
  if (c.style !== "sketch") { e.add(`${label}: explainer scenes need the explainer style`); return }
  // The art is authored in the frame's own pixels, so the bounds follow the format.
  const [fw, fh] = c.format === "9:16" ? [1080, 1920] : [1920, 1080];
  if (!(SKETCH_ACCENTS as readonly string[]).includes((s.accent ?? "white") as string)) e.add(`${label}: accent must be one of ${sorted(SKETCH_ACCENTS)}`);
  if (!(SKETCH_ENTER as readonly string[]).includes((s.enter ?? "cut") as string)) e.add(`${label}: enter must be one of ${sorted(SKETCH_ENTER)}`);
  if (!(SKETCH_EXIT as readonly string[]).includes((s.exit ?? "cut") as string)) e.add(`${label}: exit must be one of ${sorted(SKETCH_EXIT)}`);
  const shot = (s.shot ?? {}) as Record<string, unknown>;
  if (!isObj(shot)) { e.add(`${label}: shot must be an object`); return }
  const zoom = (shot.zoom ?? [1, 1.2]) as unknown;
  if (!Array.isArray(zoom) || zoom.length !== 2) e.add(`${label}: shot zoom needs a start and an end`);
  else {
    for (const z of zoom) e.finite(z, .5, 4, `${label} zoom`);
    // Not taste: qa.py fails a master with a second of identical frames, and a camera that does
    // not move produces exactly that.
    if (typeof zoom[0] === "number" && typeof zoom[1] === "number" && zoom[1] <= zoom[0])
      e.add(`${label}: the camera never stops pushing in - zoom must increase`);
  }
  const focus = (shot.focus ?? [fw / 2, fh / 2]) as unknown;
  if (!Array.isArray(focus) || focus.length !== 2) e.add(`${label}: shot focus needs x and y`);
  else { e.finite(focus[0], 0, fw, `${label} focus x`); e.finite(focus[1], 0, fh, `${label} focus y`) }
  const art = s.art;
  if (!Array.isArray(art) || art.length < 1 || art.length > 8) { e.add(`${label}: art must list one to eight drawn elements`); return }
  const voice = typeof s.voice === "string" ? s.voice : "";
  art.forEach((raw, j) => {
    const el = `${label} art ${j + 1}`;
    if (!isObj(raw)) { e.add(`${el}: must be an object`); return }
    const a = raw as Record<string, unknown>;
    if (!(SKETCH_ART as readonly string[]).includes(a.name as string)) e.add(`${el}: name must be one of ${sorted(SKETCH_ART)}`);
    // A cue is either a fraction of the shot or the words it must land on. The engine matches the
    // words on a folded character stream, so quote them the way they are actually spoken.
    for (const key of ["at", "until"] as const) {
      const v = a[key];
      if (typeof v === "string") {
        if (e.text(v, `${el} ${key}`, 32) && !quotesVoice(v, voice)) e.add(`${el}: ${key} must quote words from this scene's voice`);
      } else if (v !== undefined) {
        if (key === "at") e.finite(v, 0, .95, `${el} at`);
        else {
          e.finite(v, .05, 1, `${el} until`);
          const at = a.at;
          if (typeof at !== "string" && typeof v === "number" && typeof (at ?? 0) === "number" && v <= ((at as number) ?? 0)) e.add(`${el}: until must come after at`);
        }
      }
    }
    if ("motion" in a && !(SKETCH_MOTION as readonly string[]).includes(a.motion as string)) e.add(`${el}: motion must be one of ${sorted(SKETCH_MOTION)}`);
    if ("motion_over" in a) e.finite(a.motion_over, .1, 4, `${el} motion_over`);
    if ("drawn" in a && typeof a.drawn !== "boolean") e.add(`${el}: drawn must be a boolean`);
    if ("x" in a) e.finite(a.x, -fw * .4, fw * 1.4, `${el} x`);
    if ("y" in a) {
      e.finite(a.y, -fh * .25, fh * 1.25, `${el} y`);
      // THE CAPTION OWNS THE BOTTOM OF THE FRAME. It is burned in at 81.8 % of the height and is the only
      // text in the film, so a drawing that sits under it is a drawing the viewer reads words through.
      // SKETCH_DROP says how far this particular drawing actually reaches below its centre. Its outer edge
      // may pass under the band — a panel, a skyline and a corridor all do, and a thin line under a word
      // costs nothing — but its BODY may not, and half the reach is where an edge becomes a body.
      const drop = (SKETCH_DROP[a.name as string] ?? 250) * (typeof a.size === "number" && a.size > 0 ? a.size : 1) * .75;
      if (typeof a.y === "number" && a.y + drop > fh * .78)
        e.add(`${el}: y ${a.y} puts ${a.name} behind the caption, which is burned in at 78-86% of the frame; at this size keep y at or under ${Math.round(fh * .78 - drop)}`);
    }
    if ("size" in a) e.finite(a.size, .1, 6, `${el} size`);
    for (const key of ["tint", "led", "beam", "chip", "no_col"] as const)
      if (key in a && !(SKETCH_ACCENTS as readonly string[]).includes(a[key] as string)) e.add(`${el}: ${key} must be one of ${sorted(SKETCH_ACCENTS)}`);
    if ("mood" in a && !(SKETCH_MOODS as readonly string[]).includes(a.mood as string)) e.add(`${el}: mood must be one of ${sorted(SKETCH_MOODS)}`);
    if ("count" in a && (typeof a.count !== "number" || !Number.isInteger(a.count) || a.count < 1 || a.count > 12)) e.add(`${el}: count must be 1-12`);
    for (const flag of ["no", "sweat", "xray", "flash", "flip", "leader"] as const)
      if (flag in a && typeof a[flag] !== "boolean") e.add(`${el}: ${flag} must be a boolean`);
    if ("text" in a) e.text(a.text, `${el} text`, 24);
    for (const key of ["open", "open_to"] as const) if (key in a) e.finite(a[key], 0, 1, `${el} ${key}`);
    if ("swing_over" in a) e.finite(a.swing_over, .2, 3, `${el} swing_over`);
    if ("reach" in a) {
      if (!Array.isArray(a.reach) || a.reach.length !== 2) e.add(`${el}: reach needs x and y`);
      else for (const v of a.reach) e.finite(v, -600, 600, `${el} reach`);
    }
  });
}

function validateBeats(c: Record<string, unknown>, s: Record<string, unknown>, label: string, e: Collector): void {
  if (c.style !== "cinema") { e.add(`${label}: cinema scenes need the cinema style`); return; }
  const beats = s.beats;
  if (!Array.isArray(beats) || beats.length < 1 || beats.length > 8) { e.add(`${label}: beats must list one to eight hero visuals`); return; }
  const voice = typeof s.voice === "string" ? s.voice.toLowerCase() : "";
  beats.forEach((b: unknown, j: number) => {
    const bl = `${label} beat ${j + 1}`;
    if (!isObj(b) || !(BEAT_KINDS as readonly string[]).includes(b.kind as string)) { e.add(`${bl}: kind must be one of ${sorted(BEAT_KINDS)}`); return; }
    const k = b.kind as string;
    if ("at" in b) {
      if (e.text(b.at, `${bl} at`, 24) && !voice.includes((b.at as string).toLowerCase())) e.add(`${bl}: at must quote words from this scene's voice`);
    }
    if ("label" in b && ["icon", "split", "grid"].includes(k)) e.text(b.label, `${bl} label`, 24);
    if (k === "split" || k === "grid") {
      const items = b.items;
      const [lo, hi] = k === "split" ? [2, 2] : [2, 3];
      if (!Array.isArray(items) || items.length < lo || items.length > hi || !subset(items, BEAT_ICONS)) e.add(`${bl}: ${k} needs ${lo}-${hi} icon names`);
      if ("fx" in b && !(BEAT_FX as readonly string[]).includes(b.fx as string)) e.add(`${bl}: unknown fx`);
    }
    if (k === "icon") {
      if (!(BEAT_ICONS as readonly string[]).includes(b.name as string)) e.add(`${bl}: icon name must be one of ${sorted(BEAT_ICONS)}`);
      if ("fx" in b && !(BEAT_FX as readonly string[]).includes(b.fx as string)) e.add(`${bl}: unknown icon fx`);
      if ("size" in b) e.finite(b.size, 0.3, 1.0, `${bl} size`);
    }
    if (k === "type") {
      e.text(b.text, `${bl} text`, 40);
      if ("slam" in b && !isBool(b.slam)) e.add(`${bl}: slam must be a boolean`);
      if ("hl" in b) e.text(b.hl, `${bl} hl`, 20);
      if ("icon" in b && !(BEAT_ICONS as readonly string[]).includes(b.icon as string)) e.add(`${bl}: icon must be one of ${sorted(BEAT_ICONS)}`);
      if ("fx" in b && !(BEAT_FX as readonly string[]).includes(b.fx as string)) e.add(`${bl}: unknown type fx`);
    }
    if (k === "terminal") {
      const lines = b.lines;
      if (!Array.isArray(lines) || lines.length < 1 || lines.length > 4) e.add(`${bl}: terminal needs 1-4 lines`);
      else for (const ln of lines) { if (e.text(ln, `${bl} line`, 48) && !printable(ln)) e.add(`${bl}: lines must be printable`); }
      if ("label" in b) e.text(b.label, `${bl} label`, 16);
    }
    if (k === "steps") {
      const items = b.items;
      if (!Array.isArray(items) || items.length < 2 || items.length > 4) e.add(`${bl}: steps need 2-4 items`);
      else {
        for (const it of items) e.text(it, `${bl} item`, 14);
        if ("lit" in b && (!isInt(b.lit) || b.lit < 0 || b.lit > items.length)) e.add(`${bl}: lit out of range`);
      }
    }
    if (k === "people") {
      let okNums = true;
      for (const key of ["total", "lit"]) {
        const v = b[key];
        if (!isInt(v) || v < 0 || v > 12) { e.add(`${bl}: ${key} must be 0-12`); okNums = false; }
      }
      if (okNums && (b.lit as number) > (b.total as number)) e.add(`${bl}: lit exceeds total`);
      if ("label" in b) e.text(b.label, `${bl} label`, 32);
    }
    if (k === "bars") {
      const labels = b.labels, values = b.values;
      if (!Array.isArray(labels) || !Array.isArray(values) || labels.length < 1 || labels.length > 4 || labels.length !== values.length) e.add(`${bl}: bars need 1-4 labels with matching values`);
      else {
        for (const lb of labels) e.text(lb, `${bl} label`, 14);
        for (const v of values) if (!isInt(v) || v < 0 || v > 1000000) { e.add(`${bl}: values must be integers 0-1000000`); break; }
      }
    }
    if (k === "timeline") {
      const labels = b.labels;
      if (!Array.isArray(labels) || labels.length < 2 || labels.length > 4) e.add(`${bl}: timeline needs 2-4 labels`);
      else {
        for (const lb of labels) e.text(lb, `${bl} label`, 14);
        if ("icons" in b && (!Array.isArray(b.icons) || b.icons.length !== labels.length || !subset(b.icons, BEAT_ICONS))) e.add(`${bl}: icons must name one icon per label`);
      }
    }
    if (k === "dialog") {
      e.text(b.text, `${bl} text`, 32);
      if ("count" in b && (!isInt(b.count) || b.count < 1 || b.count > 5)) e.add(`${bl}: count must be 1-5`);
    }
    if (k === "cta") {
      if ("label" in b) e.text(b.label, `${bl} label`, 24);
      if ("toggles" in b) {
        if (!Array.isArray(b.toggles) || b.toggles.length < 1 || b.toggles.length > 3) e.add(`${bl}: 1-3 toggles`);
        else for (const tg of b.toggles) e.text(tg, `${bl} toggle`, 14);
      }
    }
  });
  if ("chapter" in s) e.text(s.chapter, `${label} chapter`, 32);
  if ("accent" in s && !(CINEMA_ACCENTS as readonly string[]).includes(s.accent as string)) e.add(`${label}: accent must be green, cyan, red or amber`);
  if ("hl" in s) e.text(s.hl, `${label} hl`, 24);
}

/**
 * A legal `at` for the n-th of `count` shots: an unbroken run of whole words, quoted verbatim from this scene's own
 * voice, that no other shot has taken, starting near where that cut falls in the line. Null when the line is too
 * short or too odd to yield one.
 */
function anchorAt(voice: string, index: number, count: number, taken: Set<string>): string | null {
  const spans: { from: number; to: number }[] = [];
  const re = /\S+/g;
  for (let m = re.exec(voice); m; m = re.exec(voice)) spans.push({ from: m.index, to: m.index + m[0].length });
  if (spans.length < 2) return null;
  const want = Math.min(spans.length - 1, Math.max(1, Math.round((index * spans.length) / Math.max(count, 1))));
  const order: number[] = [];
  for (let d = 0; d < spans.length; d++) {
    if (want + d < spans.length) order.push(want + d);
    if (d && want - d >= 1) order.push(want - d);   // never the very first word: a cut there is the scene opening
  }
  for (const i of order) for (const n of [2, 1]) {
    const last = spans[i + n - 1];
    if (!last) continue;
    const at = voice.slice(spans[i].from, last.to);
    if (at.length <= SHOT_AT_MAX && !taken.has(at.toLowerCase()) && quotesVoice(at, voice)) return at;
  }
  return null;
}

/**
 * EVERY CUT AFTER THE FIRST LANDS ON A WORD THE VIEWER HEARS. `at` used to be optional and a missing one was silent:
 * the picture then changed NEAR the right words instead of ON them, by arithmetic, while the product promised the
 * opposite. Choosing the anchor is mechanical — like choosing the camera move — so Kleo chooses it rather than
 * demanding it: anchors the author wrote and the contract accepted are kept untouched, only the gaps are filled.
 * A scene whose line is too short to yield one is the author's problem, and qualityProblems() says so.
 */
export function anchorShots(scene: Record<string, unknown>): void {
  const voice = typeof scene.voice === "string" ? scene.voice : "";
  const shots = Array.isArray(scene.shots) ? (scene.shots as unknown[]) : [];
  if (!voice || shots.length < 2) return;
  const taken = new Set<string>();
  for (const sh of shots) if (isObj(sh) && typeof sh.at === "string") taken.add(sh.at.toLowerCase());
  shots.forEach((sh, i) => {
    if (!i || !isObj(sh) || (typeof sh.at === "string" && sh.at.trim())) return;
    const at = anchorAt(voice, i, shots.length, taken);
    if (at) { sh.at = at; taken.add(at.toLowerCase()); }
  });
}

/** A shot's covers or cast: a list of at most `max` short non-blank strings. One message per list, naming what it is for. */
function tagList(v: unknown, label: string, max: number, what: string, e: Collector): void {
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === "string" && x.trim() && x.length <= SHOT_TAG_MAX && printable(x)))
    e.add(`${label}: a list of at most ${max} short strings (each <=${SHOT_TAG_MAX} characters) — ${what}`);
}

/**
 * Picture style: a scene is a run of full-screen pictures ("shots") cut on the narration. No beats, no icons.
 * Folds the old shorthand (a scene-level image_prompt) into shots[0], so what the caller stores and what the engine
 * receives never carries a scene-level image_prompt. It writes into the COPY validateStoryboard made, never into the
 * caller's own object.
 */
function validateShots(s: Record<string, unknown>, label: string, kind: "cinema" | "closing", e: Collector, fmt: Format, seq: SeqShot[], language = "en"): void {
  if ("beats" in s) e.add(`${label}: beats belong to the cinema style; the picture style cuts between "shots" instead`);
  if (typeof s.image_prompt === "string" && !("shots" in s)) { s.shots = [{ image_prompt: s.image_prompt.trim() }]; delete s.image_prompt; }
  else if ("image_prompt" in s) { e.add(`${label}: put the picture on a shot ("shots": [{"image_prompt": "…"}]), not on the scene`); delete s.image_prompt; }
  const [lo, hi] = SHOTS_PER_SCENE[kind];
  const shots = s.shots;
  if (!Array.isArray(shots) || shots.length < lo || shots.length > hi) { e.add(`${label}: shots must list ${lo}–${hi} full-screen pictures`); return; }
  const voice = typeof s.voice === "string" ? s.voice.toLowerCase() : "";
  const sceneId = typeof s.id === "string" && s.id ? s.id : label;
  anchorShots(s);   // fills only the gaps; an `at` the author wrote is validated below exactly as before
  shots.forEach((sh: unknown, j: number) => {
    const sl = `${label} shot ${j + 1}`;
    if (!isObj(sh)) { e.add(`${sl}: must be an object`); return; }
    if ("image" in sh) e.add(`${sl}: image is not allowed in a storyboard (describe the picture in image_prompt instead; Kleo generates it)`);
    if ("clip" in sh) e.add(`${sl}: clip is not allowed in a storyboard (Kleo generates the video track on the GPU and attaches it there)`);
    // contract.py: `unknown = set(shot) - SHOT_FIELDS` → same wording, same sorted list. A stray "note" or "seed"
    // costs a whole rendered job otherwise. `image` keeps the dedicated message above.
    const unknown = Object.keys(sh).filter((k) => k !== "image" && k !== "clip" && !(SHOT_FIELDS as readonly string[]).includes(k) && !(AUTHORING_SHOT_FIELDS as readonly string[]).includes(k));
    if (unknown.length) e.add(`${sl}: unknown shot fields ${sorted(unknown)}`);
    // The authoring fields: optional (every storyboard written before 24 September 2026 has none, and a shot with
    // nobody in it has no cast), null read as absent and dropped from the stored copy, a wrong type refused.
    for (const f of AUTHORING_SHOT_FIELDS) {
      const v = sh[f];
      if (f in sh && (v === null || v === undefined || (f === "action" && typeof v === "string" && !v.trim()))) delete sh[f];
    }
    if ("covers" in sh) tagList(sh.covers, `${sl} covers`, SHOT_COVERS_MAX, 'the spec item ids this shot shows ("R1", "R2"…)', e);
    if ("cast" in sh) tagList(sh.cast, `${sl} cast`, SHOT_CAST_MAX, 'the characters in this picture, by spec cast id ("c1") or by their cast name', e);
    if ("action" in sh) e.text(sh.action, `${sl} action`, SHOT_ACTION_MAX);
    if (e.text(sh.image_prompt, `${sl} image_prompt`, IMAGE_PROMPT_MAX) && (sh.image_prompt as string).trim().length < IMAGE_PROMPT_MIN)
      e.add(`${sl} image_prompt: required text, minimum ${IMAGE_PROMPT_MIN} characters`);
    if ("caption" in sh) e.text(sh.caption, `${sl} caption`, SHOT_CAPTION_MAX);
    if ("hl" in sh) e.text(sh.hl, `${sl} hl`, SHOT_HL_MAX);
    if ("at" in sh) {
      if (j === 0) e.add(`${sl}: the first shot opens the scene, it cannot carry at`);
      else if (e.text(sh.at, `${sl} at`, SHOT_AT_MAX) && !quotesVoice(sh.at as string, voice)) e.add(`${sl}: at must quote words from this scene's voice`);
    }
    // The shot grammar: shot_kind says what the shot is FOR, the preset table turns it into a camera move.
    let shotKind: ShotKind | null = null;
    if ("shot_kind" in sh) {
      if (Array.isArray(sh.shot_kind)) e.add(`${sl}: one move per shot — shot_kind names a single kind, never a list of them`);
      else if (!(SHOT_KINDS as readonly string[]).includes(sh.shot_kind as string)) e.add(`${sl}: shot_kind must be one of ${sorted(SHOT_KINDS)}`);
      else shotKind = sh.shot_kind as ShotKind;
    }
    let preset = shotKind ? presetFor(shotKind) : null;
    if ("motion" in sh) {
      const raw = sh.motion;
      const normalised =
        typeof raw === "string" && raw in MOTION_ALIASES ? MOTION_ALIASES[raw as (typeof SHOT_MOTION)[number]]
        : typeof raw === "string" && (MOTION_MOVES as readonly string[]).includes(raw) ? (raw as Move)
        : null;
      // A motion that already equals the kind's move is this validator's own resolution coming back through a second
      // pass (a storyboard is validated again after the planner repairs it, and again when it is read back), not an
      // author naming the move twice. Only a CONTRADICTION is worth an error.
      if (preset && raw !== preset.move)
        e.add(`${sl}: a shot names its move once — shot_kind ${shotKind} already asks for ${preset.move}, so drop motion (${motionHelp()})`);
      else if (preset) { /* our own resolved move, left as it is */ }
      else if (Array.isArray(raw)) e.add(`${sl}: one move per shot — motion names a single move, never a list of them (${motionHelp()})`);
      else if (!normalised) e.add(`${sl}: ${motionHelp()}`);
      if (normalised && !preset) sh.motion = normalised; // legacy spelling accepted silently, normalised away
    }
    if ("strength" in sh) e.finite(sh.strength, SHOT_STRENGTH_MIN, SHOT_STRENGTH_MAX, `${sl} strength`);
    const prompt = typeof sh.image_prompt === "string" ? sh.image_prompt : "";
    // THE PICTURE IS DESCRIBED IN ENGLISH WHATEVER THE FILM SPEAKS. Every model the GPU draws with reads its prompt
    // through an English text encoder; an Italian sentence reaches it as noise, and "capelli biondi corti, grembiule
    // lilla" was drawn as brown curls and a red apron (job gt_ad2musq5, 19 September 2026). A warning, not a refusal:
    // the planner translates what the model would not (storyboard.ts), and a client is told and asked to rewrite.
    if (prompt && language !== "en" && notEnglish(prompt))
      e.warn(`${sl}: image_prompt must be in English (the picture model reads English only; only the narration is in ${language})`);
    // Repaired, never refused: the author asked for a picture of hands at work, and the answer to that is a locked
    // frame, not an error message. It has to happen BEFORE the duration window is read, because the repair changes the
    // kind and therefore how long the shot may run. Refusing here also made two such shots in a row unsatisfiable: the
    // only legal kind for both was static_forced, and the alternation rule then forbade the pair.
    if (prompt && staticHoldReason(prompt) && shotKind !== "static_forced") {
      shotKind = "static_forced";
      preset = presetFor(shotKind);
      sh.shot_kind = shotKind;
    }
    const window = shotKind ? durationFor(shotKind, fmt) : null;
    let duration = window ? (window.min + window.max) / 2 : 0;
    if ("dur" in sh) {
      const n = typeof sh.dur === "number" && Number.isFinite(sh.dur) ? sh.dur : null;
      if (n !== null) duration = n;
      if (!window) e.add(`${sl}: dur needs shot_kind — the kind is what says how long the shot may run`);
      // A duration past the hard ceiling is a sequencing failure and is reported below, in the grammar's own words.
      else if ((n === null || n < window.min || n > window.max) && !(n !== null && n > MAX_SHOT_S))
        e.add(`${sl} dur: a ${shotKind} shot runs ${secs(window.min)}–${secs(window.max)} s in ${fmt}; write a duration inside that window, or drop dur and let the kind decide`);
    }
    // The routing rule, not a taste: hands at work, a crowd, legible signage or a mechanism all come apart under a
    // moving camera. The kind has to say so, because the picture the vendor is sent is built from it.
    // Only the shots that speak the grammar are sequenced; a legacy shot is a gap that breaks the run in two.
    // One table, one resolution: from here on the storyboard carries the concrete move, so the worker, contract.py and
    // the engine never need a copy of the grammar (and cannot drift from it).
    if (shotKind && preset) {
      sh.motion = preset.move;
      if (typeof sh.strength !== "number") sh.strength = preset.strength;   // the engine scales the move by this
    }
    seq.push(
      shotKind && preset
        ? { label: sl, scene_id: sceneId, kind: shotKind, move: preset.move, duration_s: duration, scale: preset.scale, subject: sceneId, image_prompt: prompt }
        : { label: null },
    );
  });
  if ("chapter" in s) e.text(s.chapter, `${label} chapter`, 32);
  if ("accent" in s && !(CINEMA_ACCENTS as readonly string[]).includes(s.accent as string)) e.add(`${label}: accent must be green, cyan, red or amber`);
  if ("hl" in s) e.text(s.hl, `${label} hl`, 24);
}

/**
 * The sequencing rules. Every one of them lives in src/shot-grammar.ts as a pure function over a list of shots; this
 * is where their answers become problems, relabelled ("shot 4" → "scene 2 shot 1") and finished with the one thing a
 * pure rule cannot know: what the model should change.
 *
 * Only the rules that protect the RENDER are errors (`blocking`): a move that is a list, a shot that runs past the
 * ceiling a generated clip melts at. The RHYTHM rules — alternating move classes, not repeating a scale, holding
 * screen direction, spending the loud moves sparingly — are warnings: the planner repairs them itself
 * (storyboard.ts assignShotKinds), feeds what is left back to the model once, and then keeps the scenes. They were
 * errors until 19 September 2026, and refusing on them produced storyboards with no legal answer at all: two shots
 * that both show hands at work are both forced to a static hold, the pair is then "move class STILL repeats", and the
 * only fix on offer is to stop showing the hands the user asked for. A story about a pastry chef failed twice that
 * way, four planning attempts, thirteen minutes of waiting, and the user's credits went back and forth.
 *
 * The grammar only judges the shots that speak it. A shot still written the old way (bare `motion`, or nothing at
 * all) is a gap: it breaks the run in two and the rules are applied to each side on its own, so a storyboard written
 * before the grammar keeps rendering exactly as it did. "The same subject" is the scene — one scene is one run of
 * pictures on one thing — so the scale and direction rules compare inside a scene, while the move class and the loud
 * budget run across the cut as well.
 */
// Only the rules that protect the RENDER stay job-blocking: a shot that runs too long is where a generated clip melts.
// Rhythm — alternating move classes, not repeating a scale, holding screen direction, spending the loud moves sparingly —
// is the planner's job to get right (src/storyboard.ts repairs it) and not a reason to refuse a video someone is waiting
// for. Refusing on rhythm also produced storyboards with no legal answer at all.
const SEQUENCE_RULES: { check: (shots: PlanShot[]) => string[]; fix: (msg: string) => string; blocking?: boolean }[] = [
  { blocking: true, check: checkOneMovePerShot, fix: () => `name the shot once with shot_kind — one of ${sorted(SHOT_KINDS)} — and let the grammar pick the move` },
  { blocking: true, check: checkDurations, fix: () => "shorten dur, or cut the shot in two" },
  {
    check: checkLoudBudget,
    fix: (msg) => (/adjacent/.test(msg) ? "put a quiet shot between them" : `keep ${LOUD_MAX_PER_WINDOW} loud moves per ${secs(LOUD_WINDOW_S)} s and let the rest be quiet`),
  },
  { check: checkMoveClassAlternation, fix: () => "change one of the two shot_kinds so the class alternates (PUSH / LATERAL / VERTICAL / STILL)" },
  { check: checkScaleRepetition, fix: () => "change shot_kind so the cut changes the scale" },
  { check: checkScreenDirection, fix: () => "keep one direction inside a scene: flip the shot, not the camera" },
];

/** "shot 4: …" and "(shots 1, 3, 4)" as the rules number them → the labels this file reports errors under. */
const relabel = (msg: string, labels: string[]): string =>
  // One pass, both shapes: a label contains the word "shot", so a second pass would relabel its own output.
  msg.replace(/\bshots? \d+(?:, \d+)*\b/g, (m) => {
    const list = m.slice(m.startsWith("shots ") ? 6 : 5).split(", ");
    return list.map((n) => labels[Number(n) - 1] ?? `shot ${n}`).join(", ");
  });

function validateSequence(seq: SeqShot[], e: Collector): void {
  // Split at the legacy shots: what is left is the runs the grammar can read, each still in screen order.
  const runs: SeqShot[][] = [[]];
  for (const sh of seq) { if (sh.label) runs[runs.length - 1].push(sh); else runs.push([]); }
  for (const run of runs) {
    if (run.length < 1) continue;
    const labels = run.map((sh) => sh.label as string);
    const shots: PlanShot[] = run.map(({ label: _label, ...plan }) => plan);
    // Two forced static holds in a row are the routing rule's own answer to two pictures of hands, a crowd, signage
    // or a mechanism: nothing about the pair is a mistake, so no rule is quoted about it. (Rule messages start with
    // the 1-based index of the SECOND shot of the pair, before relabel() renames them.)
    const forcedPair = new Set<number>();
    for (let i = 1; i < shots.length; i++) if (shots[i].kind === "static_forced" && shots[i - 1].kind === "static_forced") forcedPair.add(i + 1);
    for (const { check, fix, blocking } of SEQUENCE_RULES) for (const msg of check(shots)) {
      if (!blocking && forcedPair.has(Number(/^shot (\d+):/.exec(msg)?.[1]))) continue;
      const text = `${relabel(msg, labels)} — ${fix(msg)}`;
      if (blocking) e.add(text); else e.warn(text);
    }
  }
}

function validateInner(input: unknown, opts: ValidateOptions, e: Collector): void {
  if (!isObj(input)) { e.add("storyboard must be a JSON object"); return; }
  const c = input;
  for (const f of FORBIDDEN_FIELDS) if (f in c) e.add(`${f} must not be part of a storyboard (the worker sets it)`);
  if (c.schema_version !== 1) e.add("schema_version must be 1");
  if (c.editorial_status !== "ready") e.add("editorial_status must be ready");
  e.text(c.title, "title", 120);
  if ("brand" in c) e.text(c.brand, "brand", 28);
  if (!(STYLES as readonly string[]).includes(c.style as string)) e.add(`style must be one of ${sorted(STYLES)}`);
  // THE BACKDROP IS A PROPERTY OF THE PAGE, NOT OF A SHOT. Transparent mode changes how the canvas is created,
  // and the canvas is created once when the page loads — so it cannot be switched on for shot four and off for
  // shot five. Refused outside the picture style on purpose: no other style has a video track to lie over, and
  // the explainer must not be able to fall into it by accident. Mirrors worker/keou/contract.py.
  if ("backdrop" in c) {
    if (c.backdrop !== "video") e.add(`backdrop must be 'video'`);
    else if (c.style !== "picture") e.add(`backdrop belongs to the picture style only`);
  }
  if (!(FORMATS as readonly string[]).includes(c.format as string) || ("fps" in c && c.fps !== 30 && c.fps !== 60)) e.add("format: 9:16 or 16:9; fps: 30 or 60");
  else if (c.format !== opts.format) e.add(`format must be ${opts.format} for this job, not ${String(c.format)}`);
  // Kleo style ⇔ Keou style. cartoon/realistic are the "picture" style (shots); stickman is Keou's stickman (9:16 only).
  const kleo = "kleo_style" in c ? c.kleo_style : undefined;
  if (kleo !== undefined && !(KLEO_STYLES as readonly string[]).includes(kleo as string)) e.add(`kleo_style must be one of ${sorted(KLEO_STYLES)}`);
  else if (kleo === "stickman" && c.format !== "9:16") e.add("The stickman style makes 9:16 Shorts only: use format 9:16, or pick another style (cartoon, realistic or cyber) for 16:9");
  else if (kleo === "stickman" && c.style !== "stickman") e.add(`kleo_style stickman needs the Keou style "stickman" (story scenes), not "${String(c.style)}"`);
  else if (PICTURE_STYLES.includes(kleo as KleoStyle) && c.style !== "picture") e.add(`kleo_style ${kleo} needs the Keou style "picture" (full-screen shots cut on the narration), not "${String(c.style)}"`);
  else if (kleo === "cyber" && c.style === "stickman") e.add('kleo_style cyber does not draw the stickman: set kleo_style to "stickman" or change the style');
  if (c.style === "picture" && !PICTURE_STYLES.includes(kleo as KleoStyle))
    e.add(`the Keou style "picture" is the cartoon/realistic/animation look: set kleo_style to one of ${PICTURE_STYLES.join(", ")}${kleo === undefined ? "" : `, not "${String(kleo)}"`}`);
  if (c.style === "stickman" && c.format !== "9:16" && kleo !== "stickman") e.add("The stickman style is laid out for 9:16 only");
  if ("width" in c && !(WIDTHS[c.format as string] ?? []).includes(c.width as number)) e.add("Invalid width for aspect ratio");
  const voices = VOICES[c.language as string];
  // Name the voices that would work: "Unsupported language/voice combination" sends the model round the loop guessing.
  if (!voices || !voices.includes(c.voice as string))
    e.add(`voice "${String(c.voice)}" does not speak ${String(c.language)}. Use one of ${(voices ?? []).join(", ") || sorted(LANGUAGES)}`);
  else if (c.language !== opts.language) e.add(`language must be ${opts.language} for this job, not ${String(c.language)}`);
  e.finite(c.speed ?? 1, 0.8, 1.3, "speed");
  // "track" (22 September 2026): an instrumental track the worker orders from kie.ai, described by `music_brief`.
  if ("music" in c && c.music !== "bed" && c.music !== "none" && c.music !== "track") e.add("music must be bed, none or track");
  if ("music_brief" in c && c.music_brief !== undefined && c.music_brief !== null) e.text(c.music_brief, "music_brief", 300);
  e.finite(c.max_duration ?? 600, 5, 1800, "max_duration");
  // BEFORE the scene check on purpose. A storyboard with malformed scenes would otherwise return here and hide the
  // missing direction, so the assistant would learn about it only on the second call — two round trips for one
  // storyboard, and the second one after it had already rewritten the scenes.
  if (opts.requireDirection && !("direction" in c))
    e.add('direction is required: call kleo_storyboard_guide and write the DIRECTION block first (subject, goal, audience, tone, must_keep, world, cast, objects, forbidden, sections). It is what keeps a character the same person across shots and gives every scene the colour of its section.');
  // THE LAYER. Optional, and only over a filmed picture (there is nothing else for it to be drawn over); when it is
  // there, the scenes are held to it below: a state for an element that does not exist is a typo the engine would
  // draw as nothing, silently, on a machine that has been paid for.
  let graphics: Graphics | null = null;
  if ("graphics" in c && c.graphics !== null && c.graphics !== undefined) {
    if (c.style !== "picture") e.add("graphics: the layer is drawn over a filmed picture only (the picture style)");
    for (const p of graphicsProblems(c.graphics)) e.add(p);
    graphics = repairGraphics(c.graphics);
    if (graphics) c.graphics = graphics; else if (!graphicsProblems(c.graphics).length) delete c.graphics;   // a layer with nothing on it is no layer
  }
  const scenes = c.scenes;
  if (!Array.isArray(scenes) || scenes.length < 2 || scenes.length > 240) { e.add("A project needs 2–240 scenes"); return; }
  // The direction is optional for the planner's own drafts, but a storyboard that carries one is held to it: the
  // sections must tile the film and every scene must wear the colour of its section.
  // Checking it here, on the free Worker, is the whole point — a colour law discovered on a rented GPU is a colour
  // law nobody enforced.
  const direction = "direction" in c ? c.direction : undefined;
  if (direction !== undefined) {
    for (const p of directionProblems(direction, { accents: CINEMA_ACCENTS, scenes: scenes.length })) e.add(p);
    // The fields of the direction that are PASTED INTO PICTURE PROMPTS — the world, the cast's names and looks, the
    // objects, the forbidden list that becomes the negative prompt — are English whatever the narration speaks, for
    // the reason the image_prompt check above gives. The story fields (subject, goal, must_keep…) stay in the film's language.
    if (opts.language !== "en" && isObj(direction))
      for (const f of foreignPictureFields(direction as Partial<Direction>)) e.warn(`direction.${f} must be in English: it is pasted into every picture prompt, and the picture model reads English only`);
    const sections = isObj(direction) && Array.isArray(direction.sections) ? (direction.sections as Section[]) : [];
    // The colour law is written in CINEMA_ACCENTS, which are the accents of the picture and cinema looks. The
    // stickman has its own smaller palette (STORY_ACCENTS), so a section accent must never be pressed onto it.
    if (sections.length && (c.style === "picture" || c.style === "cinema")) {
      const owner = sectionOfScene(sections, scenes.length);
      scenes.forEach((s, i) => {
        const want = owner[i]?.accent;
        if (!isObj(s) || !want || !("accent" in s)) return;
        if (s.accent !== want) e.add(`scene ${i + 1}: accent "${String(s.accent)}" but it is in section "${owner[i]?.name}", which owns "${want}" — one accent per section`);
      });
    }
  }
  const ids = new Set<string>();
  const seq: SeqShot[] = [];
  const fmt: Format = (FORMATS as readonly string[]).includes(c.format as string) ? (c.format as Format) : opts.format;
  scenes.forEach((s: unknown, i: number) => {
    const label = `scene ${i + 1}`;
    if (!isObj(s)) { e.add(`${label}: must be an object`); return; }
    if (e.text(s.id, `${label} id`, 50)) {
      if (!/^[a-z0-9-]+$/.test(s.id) || ids.has(s.id)) e.add("Scene IDs must be unique slugs");
      else if (SHOT_ID_SUFFIX_RE.test(s.id)) e.add(`${label} id: "-s" followed by a number is reserved for picture ids (${s.id}-s1, …); rename the scene`);
      ids.add(s.id);
    }
    const kind = s.kind as string;
    if (!(KINDS as readonly string[]).includes(kind)) { e.add(`${label}: unknown composition`); return; }
    if ((FORBIDDEN_KINDS as readonly string[]).includes(kind)) e.add(`${label}: image scenes are not allowed in a storyboard (no assets); use another composition`);
    for (const f of FORBIDDEN_SCENE_FIELDS) if (f in s) e.add(`${label}: ${f} is not allowed in a storyboard${f === "image" ? " (describe the picture in image_prompt instead; Kleo generates it)" : ""}`);
    // The dissolve between two acts (src/transitions.ts): one word on the incoming scene, and the first scene has nothing to dissolve from.
    if ("transition" in s && s.transition !== undefined) {
      if (s.transition !== "cut" && s.transition !== "dissolve") e.add(`${label}: transition must be "cut" or "dissolve"`);
      else if (i === 0 && s.transition === "dissolve") e.add(`${label}: the first scene cannot dissolve in (nothing comes before it)`);
    }
    if (c.style === "picture") {
      if (kind !== "cinema" && kind !== "closing") e.add(`${label}: the picture style only draws cinema and closing scenes`);
      else validateShots(s, label, kind, e, fmt, seq, opts.language);
      // What this scene says to the layer. Refused against the film's own elements, never against a template.
      if (graphics) {
        for (const p of sceneHudProblems(graphics, s.hud, label)) e.add(p);
        for (const p of cardProblems(s.cards, typeof s.voice === "string" ? s.voice : "", label)) e.add(p);
      } else if ("hud" in s || "cards" in s) e.add(`${label}: hud and cards belong to a film with a layer — add "graphics" at the top of the storyboard first, or drop them`);
    } else {
      if ("shots" in s) e.add(`${label}: shots need the picture style (kleo_style cartoon or realistic)`);
      if ("image_prompt" in s) e.text(s.image_prompt, `${label} image_prompt`, IMAGE_PROMPT_MAX);
    }
    if (c.style === "cinema" && kind !== "cinema" && kind !== "closing") e.add(`${label}: the cinema style only draws cinema and closing scenes`);
    if (c.style !== "picture" && (kind === "cinema" || (kind === "closing" && c.style === "cinema" && "beats" in s))) validateBeats(c, s, label, e);
    if (kind === "closing" && c.style === "cinema") {
      if ("chapter" in s) e.text(s.chapter, `${label} chapter`, 32);
      if ("accent" in s && !(CINEMA_ACCENTS as readonly string[]).includes(s.accent as string)) e.add(`${label}: accent must be green, cyan, red or amber`);
    }
    if (c.style === "sketch" && kind !== "sketch") e.add(`${label}: the explainer style only draws explainer scenes`);
    if (kind === "sketch") validateSketchScene(c, s, label, e);
    if (c.style === "stickman" && kind !== "story" && kind !== "closing") e.add(`${label}: the stickman style only draws story and closing scenes`);
    if (kind === "story") {
      if (c.style !== "stickman") e.add(`${label}: story scenes need the stickman style`);
      if (!(STORY_ACTS as readonly string[]).includes((s.act ?? "idle") as string)) e.add(`${label}: act must be one of ${sorted(STORY_ACTS)}`);
      const cast = s.cast ?? ["hero"];
      if (!Array.isArray(cast) || cast.length < 1 || cast.length > 3 || !subset(cast, STORY_CAST) || !cast.includes("hero")) e.add(`${label}: cast must list hero and at most thief, thief2`);
      const props = s.props ?? [];
      if (!Array.isArray(props) || props.length > 3 || !subset(props, STORY_PROPS) || new Set(props).size !== props.length) e.add(`${label}: props must be up to three distinct names from ${sorted(STORY_PROPS)}`);
      if ("fx" in s && !(STORY_FX as readonly string[]).includes(s.fx as string)) e.add(`${label}: fx must be one of ${sorted(STORY_FX)}`);
      if ("accent" in s && !(STORY_ACCENTS as readonly string[]).includes(s.accent as string)) e.add(`${label}: accent must be green, red or amber`);
      for (const [key, limit] of [["bubble", 40], ["hl", 24]] as const) {
        if (key in s && e.text(s[key], `${label} ${key}`, limit) && !printable(s[key] as string)) e.add(`${label}: ${key} must be single-line printable text`);
      }
    }
    if (kind === "closing" && c.style === "stickman") {
      for (const [key, limit] of [["bubble", 40], ["hl", 24]] as const) if (key in s) e.text(s[key], `${label} ${key}`, limit);
    }
    e.text(s.voice, `${label} voice`, 350);
    // The explainer draws no title: its captions are the only text on screen.
    if (kind === "sketch") { if ("title" in s) e.text(s.title, `${label} title`, 90); } else e.text(s.title, `${label} title`, 90);
    // The picture style paints the closing button inside a pill: it is shorter than the editorial one.
    for (const [key, limit] of [["eyebrow", 40], ["detail", 110], ["source", 80], ["button", c.style === "picture" ? CLOSING_BUTTON_MAX : 40]] as const) if (key in s) e.text(s[key], `${label} ${key}`, limit);
    if (!(VISUALS as readonly string[]).includes((s.visual ?? "focus") as string)) e.add(`${label}: unknown visual`);
    if (kind === "steps" || kind === "list" || kind === "compare") {
      const items = s.items;
      const n = kind === "compare" ? 2 : 3;
      if (!Array.isArray(items) || items.length !== n) e.add(`${label}: ${n} items required`);
      else for (const item of items) e.text(item, `${label} item`, 42);
    }
    if ("terminal_lines" in s) {
      const tl = s.terminal_lines;
      if (c.style !== "terminal" || !Array.isArray(tl) || tl.length < 1 || tl.length > 3) e.add(`${label}: terminal_lines requires terminal style and 1–3 lines`);
      else for (const item of tl) { if (e.text(item, `${label} terminal line`, 48) && !printable(item)) e.add(`${label}: terminal lines must be single-line printable text`); }
    }
    if ("animate_value" in s) {
      if (kind !== "metric" || !isBool(s.animate_value)) e.add(`${label}: animate_value must be a metric boolean`);
      else if (s.animate_value && !/^\d+(?:,\d{3})*(?:\.\d+)?[^\d]*$/.test(String(s.value ?? ""))) e.add(`${label}: animated value needs an English-formatted numeric prefix`);
    }
    if (kind === "metric") { e.text(s.value, `${label} value`, 12); e.text(s.unit, `${label} unit`, 45); }
    if (kind === "quote") e.text(s.quote, `${label} quote`, 120);
    if (kind === "closing" && s.button && s.detail) e.add(`${label}: use either a closing button or a detail line`);
    // The explainer does not pause: it ends a scene on the word and cuts.
    e.finite(s.hold ?? 0.65, kind === "sketch" ? 0.05 : 0.15, 3, `${label} hold`);
  });
  if (seq.length) validateSequence(seq, e);
  const last = scenes[scenes.length - 1];
  // The explainer ends on its last drawn frame: no end card, no logo, no subscribe.
  if (c.style !== "sketch" && (!isObj(last) || last.kind !== "closing")) e.add("Last scene must be a closing");
}

/**
 * Validates a storyboard for a job. Collects up to 10 problems; never throws on bad input.
 * In style "picture" it also normalises in place: a scene-level image_prompt becomes shots[0] and a deprecated
 * motion name becomes the grammar's move, so the returned storyboard is what gets stored and handed to the worker
 * (no scene-level image_prompt survives, and no "in"/"out"/"left"/"right"). Validating that result again returns it
 * unchanged: normalising is idempotent, and the sequencing rules read the shots that carry shot_kind.
 */
export function validateStoryboard(sb: unknown, opts: ValidateOptions): ValidateResult {
  // THE INPUT IS NEVER TOUCHED. This function normalises as it validates, and it used to do that in place and hand
  // the caller back the very object it was given — so every caller silently depended on a side effect. That is the
  // class of bug that produces tests which pass one at a time and fail together, and a caller that validates twice
  // to be safe gets a different answer the second time. It works on a copy now, and the copy is what comes out.
  const draft = clone(sb);
  const e = new Collector(opts.maxErrors ?? MAX_ERRORS);
  try { validateInner(draft, opts, e); if (!e.errors.length) { for (const p of qualityProblems(draft, opts.clipFloorS ?? 0)) e.add(p); for (const w of fidelityWarnings(draft)) e.warn(w); } } catch (err) { if (!(err instanceof TooMany)) throw err; }
  if (e.errors.length) return { ok: false, errors: e.errors, normalised: draft, warnings: e.warnings };
  return { ok: true, storyboard: draft as Storyboard, warnings: e.warnings };
}

/** A deep copy that survives a storyboard's shapes (plain objects, arrays, strings, numbers, booleans, null). */
function clone<T>(v: T): T {
  if (typeof structuredClone === "function") return structuredClone(v);
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/**
 * The storyboard as the WORKER receives it: a deep copy without the server's authoring fields — covers, cast and
 * action on every shot (AUTHORING_SHOT_FIELDS) and a top-level "spec". worker/keou/contract.py closes the shot field
 * set and refuses a job whose shot carries anything else, on a GPU that is already rented; the worker itself only
 * strips image_prompt, shot_kind and dur. A scene's own "cast" (the stickman's STORY_CAST) is an engine field and is
 * left alone: only shots lose theirs. The stored storyboard (jobs.storyboard) keeps everything; this runs where
 * src/internal.ts hands it over.
 */
export function stripForWorker<T>(sb: T): T {
  const out = clone(sb);
  if (!isObj(out)) return out;
  delete out.spec;
  if (Array.isArray(out.scenes))
    for (const s of out.scenes as unknown[])
      if (isObj(s) && Array.isArray(s.shots))
        for (const sh of s.shots as unknown[]) if (isObj(sh)) for (const f of AUTHORING_SHOT_FIELDS) delete sh[f];
  return out;
}

/**
 * The two rules that separate a video from a slideshow. They live HERE and not in worker/keou/contract.py on purpose:
 * the server may be stricter than the worker (nothing reaches a rented GPU that the GPU would then refuse), never the
 * other way round, so tightening here costs nothing and no python change can fall out of step with it.
 *
 *  1. A CINEMA SCENE SHOWS AT LEAST TWO PICTURES. The contract's shot range was [1,4] while the planner's rules said
 *     "2-4" and the website promised "two to four": a storyboard with one picture per scene passed, was billed, and
 *     came back as one still held for a whole narrated line — "non sono neanche dei video, sono semplicemente delle
 *     immagini con lo zoom". The closing scene is exempt: it is meant to rest on one picture.
 *  2. EVERY PICTURE AFTER THE FIRST CUTS ON A SPOKEN WORD. `at` was optional, and a missing one was silent: the cut
 *     then fell by arithmetic, near the right words instead of on them. The product promise is the opposite — "Kleo
 *     times the cut to a word you actually hear" — so a shot without an anchor is now a problem, not a default.
 */
/**
 * The fidelity gate as WARNINGS: every must_keep fact the narration never says. It was an error until 20 September
 * 2026, and a whole Star Wars Short planned by gpt-oss died at the final assembly on "abandoned temple", a phrase the
 * viewer would not have missed. The planner feeds these back chunk by chunk (storyboard.ts) and reports what is left
 * as missing_facts; kleo_create_video refuses a client storyboard on them (jobs.ts), because that author can fix it.
 */
export function fidelityWarnings(sb: unknown): string[] {
  const c = (typeof sb === "object" && sb !== null ? sb : {}) as Record<string, unknown>;
  const out: string[] = [];
  const d = directionOf(c);
  // Only the facts a narrator can SAY (24 September 2026): a look kept in must_keep is proven by the pictures, and
  // holding the narration to it is what made a film open on "capelli biondi raccolti, grembiule lilla" read aloud.
  if (d) for (const fact of missingFacts(spokenFacts(d.must_keep ?? [], Array.isArray(d.cast) ? d.cast : []), narrationOf(c)))
    out.push(`direction.must_keep says "${fact}" but the narration never says it: put it in a scene's "voice", in the words the viewer will hear.`);
  // A storyboard that carries the user's spec is held to it the same way: what the shots claim (covers), what the
  // narration says, the order of the events. Warnings, like must_keep — the planner feeds them back and the semantic
  // judge (src/fidelity.ts) decides what is really missing.
  const spec = specOf(c);
  if (spec) for (const p of coverage(spec, c).problems) out.push(`spec: ${p}`);
  return out;
}

/** `floorS`: the job's clip floor, as trimShots() is given it (shotBudget). */
export function qualityProblems(sb: unknown, floorS = 0): string[] {
  const c = (typeof sb === "object" && sb !== null ? sb : {}) as Record<string, unknown>;
  const out: string[] = [];
  // 3. THE STORYBOARD KEEPS ITS OWN PROMISES. Whoever wrote the direction wrote the narration and the pictures too, so
  //    a fact listed in must_keep that the narration never says, or a picture that draws something the direction
  //    forbids, is a contradiction inside one document — the cheapest kind of error to catch and the most damaging to
  //    leave (it is how a wifi icon ended up in a pirate storm). Both checks are free and neither needs the GPU.
  const d = directionOf(c);
  if (d) {
    for (const hit of forbiddenInPrompts(d.forbidden ?? [], pictureScenes(c)))
      out.push(`picture ${hit.id}: its image_prompt asks for "${hit.term}", which direction.forbidden rules out of this video.`);
  }
  if (c.style !== "picture" || !Array.isArray(c.scenes)) return out;
  (c.scenes as unknown[]).forEach((s, i) => {
    if (!isObj(s) || !Array.isArray(s.shots)) return;
    const label = `scene ${i + 1}${typeof s.id === "string" ? ` (${s.id})` : ""}`;
    const shots = s.shots as unknown[];
    if (s.kind !== "closing" && shots.length < shotBudget(voiceWords(s), floorS).min)
      out.push(`${label}: ${shots.length} picture${shots.length === 1 ? "" : "s"}, a scene needs at least ${SHOTS_MIN_CINEMA} — one picture held for a whole line is a slideshow, not a video. Split the line into ${SHOTS_MIN_CINEMA} moments and give each its own image_prompt and "at".`);
    shots.forEach((sh, n) => {
      if (n === 0 || !isObj(sh)) return;
      if (typeof sh.at !== "string" || !sh.at.trim())
        out.push(`${label} shot ${n + 1}: needs "at" — words copied from this scene's voice, so the cut lands on them as they are spoken.`);
    });
  });
  return out;
}

/** Kleo voice ids (templates.ts) → Kokoro voices. */
const KLEO_VOICES: Record<string, string> = { "narrator-en-m": "am_michael", "narrator-en-f": "af_heart", "narrator-it-m": "im_nicola", "narrator-it-f": "if_sara" };

/** Default Kokoro voice for a language and template; accepts a Kleo voice id or a Kokoro voice id as the preference. */
export function defaultVoice(language: string, templateId?: string, preferred?: string | null): string {
  const voices = VOICES[language] ?? VOICES.en;
  if (preferred) {
    const mapped = KLEO_VOICES[preferred] ?? preferred;
    if (voices.includes(mapped)) return mapped;
    // A voice of another language: keep the gender, switch the language.
    const male = /^(narrator-\w+-m|[a-z]m_)/.test(preferred);
    const byGender = voices.find((v) => (v[1] === "m") === male);
    if (byGender) return byGender;
  }
  const t = templateId ?? "";
  if (language === "en") {
    if (["viral-short", "reddit-story", "did-you-know", "cinematic-trailer", "motivational"].includes(t)) return "am_michael";
    if (t === "story-documentary") return "bf_emma";
    return "af_heart";
  }
  if (language === "it") return ["viral-short", "reddit-story", "did-you-know", "cinematic-trailer", "motivational"].includes(t) ? "im_nicola" : "if_sara";
  return voices[0];
}

/**
 * Words of narration a duration can carry: ≈2.7 words/s at speed 1.1 (≈2.45 w/s at speed 1). Recalibrated on
 * 22 September 2026, when prepare.py stopped keeping Kokoro's silent edges: at the old 2.3 w/s the same 30-second
 * order that had run 39 s with the padding ran 25.9 s without it (gt_z6v5w35q, 6 scenes), while 89 words had run
 * 32.9 s (gt_hxed87em) — 2.7 words a second of FILM, pauses included, on both.
 */
export function wordBudget(duration_s: number, speed = 1.1): { target: number; min: number; max: number; wordsPerSecond: number } {
  const wps = FILM_WPS * speed;
  const target = Math.round(duration_s * wps);
  return { target, min: Math.round(target * 0.8), max: Math.round(target * 1.1), wordsPerSecond: Math.round(wps * 100) / 100 };
}

/**
 * THE SPEED SERVO (22 September 2026). The planner is told the word budget and writes past it anyway: the fourth
 * probe of the day (gt_b2campbw) got 99 words for a 30-second order whose target was 81, and ran 35.6 s. The voice
 * decides how long the film really is, so the voice's speed is set from the words the storyboard actually carries:
 * the speed at which they fit the length, never slower than 1.0 (a film that is a little short is better than a
 * narrator who drags) and never faster than 1.3 (the contract's ceiling, and Kokoro's limit of clarity). At 1.3 a
 * 99-word 30-second film runs about 31 s instead of 36.
 */
export function speedFor(words: number, duration_s: number): number {
  if (!(words > 0) || !(duration_s > 0)) return 1.1;
  const speed = words / (FILM_WPS * duration_s);
  return Math.round(Math.min(1.3, Math.max(1.0, speed)) * 100) / 100;
}
