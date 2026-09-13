import type { Env } from "./env";
import type { Job, JobParams } from "./db";
// ".ts" on purpose: storyboard.ts imports this file and is loaded straight from source by the test runner
// (node type stripping), whose resolver has no extension search. Wrangler bundles either form.
import { int } from "./util.ts";

export type Format = "16:9" | "9:16";

export interface Template {
  id: string;
  name: string;
  formats: Format[];
  minSeconds: number;
  maxSeconds: number;
  defaultSeconds: number;
  description: string;
  voices: string[];
  /** The narrative language this template speaks, from FAMILIES. */
  family: string;
  /**
   * ONLY what the format forces. If an override rewrites more than three fields it is not a template any
   * more, it is a family nobody has written down yet — and narrativeFor's own test refuses it.
   */
  override?: Partial<Pick<Family, "sections" | "wordsPerScene" | "shotSeconds" | "closing" | "guidance" | "tone" | "keouStyle">>;
}

/* ------------------------------------------------------------------ the narrative shape */

/**
 * One stretch of a film. `weight` is its share of the running time, so the same shape works at forty
 * seconds and at eight minutes without a second table.
 */
export interface Section {
  /** What the section is called on screen and in the outline, e.g. "01 THE HOOK". */
  name: string;
  /** What this stretch is FOR — the sentence the planner hands the model for these scenes. */
  role: string;
  /** The colour the direction gives it. The looks translate it into their own palettes. */
  accent: "red" | "green" | "cyan" | "amber";
  /** Share of the film, 0-1. A family's weights add up to 1. */
  weight: number;
}

/**
 * A FAMILY is the narrative language: what the film is made of, in what order, with what tone, and
 * what the last scene owes the viewer. A TEMPLATE is a family at a length and in a frame.
 *
 * The split is not tidiness. Before it, the structure of a video lived in three places — the template
 * description the assistant reads, the brief in the planner, and the guide — and the day the explainer's
 * rhythm changed it had to be remembered in all three. Here it is written once. `explainer-short` and
 * `explainer-long` are the first pair to prove it: same language, different length, one definition.
 */
export interface Family {
  id: string;
  /** The Keou engine style it is drawn in. src/storyboard.ts maps this to the look. */
  keouStyle: "cinema" | "editorial" | "technical" | "illustrated" | "stickman" | "picture" | "sketch";
  /** How it should sound, in the words the model reads. */
  tone: string;
  /** The brief: what this kind of film is, in the order it is written. */
  guidance: string;
  /** The film, in order. Weights add up to 1. */
  sections: Section[];
  /** Narration words in one scene: the low and high the planner budgets against. */
  wordsPerScene: [number, number];
  /** How long one shot or drawing may hold the frame, in seconds. */
  shotSeconds: number;
  /**
   * What the last scene is. "closing-scene" is a real closing card; "loop" sends the viewer back to the
   * start with a question; "act" hands them one thing to do; "title" ends on the title itself.
   */
  closing: "closing-scene" | "loop" | "act" | "title";
}

/** Where the hook is and where it turns, read off the weights: the first section and the first non-hook one. */
export const hookOf = (f: Family): Section => f.sections[0];
export const turnOf = (f: Family): Section => f.sections[Math.min(1, f.sections.length - 1)];

/** A countdown is the segmented language with its middle section named for what it counts. */
const COUNTDOWN: Section[] = [
  { name: "01 THE LIST", role: "What is being counted and why these ten", accent: "cyan", weight: 0.1 },
  { name: "02 THE COUNTDOWN", role: "One entry per scene, from the last to the second, the number spoken", accent: "amber", weight: 0.7 },
  { name: "03 NUMBER ONE", role: "The first place, given the longest scene of the film", accent: "red", weight: 0.2 },
];

/** Five minutes of the drawn language is a chain of small reveals, not one reveal stretched. */
const LONG_DRAWN =
  "A long explainer built as a chain of small reveals: the claim, the object, how it actually works step by step, the " +
  "moment it goes wrong, what it cost, what changed, and what the viewer does about it. Every section ends on a " +
  "sentence that makes the next one necessary. Plain language; a term is defined the first time it is used.";

/** The same sixty-second arc, but every scene is a fact that stands on its own. */
const DID_YOU_KNOW =
  "One striking fact per scene, each a self-contained sentence with a concrete number or comparison, escalating to the " +
  "most surprising one last. Open with a question or 'did you know'; never explain a fact across two scenes.";

export const FAMILIES: Record<string, Family> = {
  /* ---------------------------------------------------------------- the sixty-second arc */
  "short-hook": {
    id: "short-hook", keouStyle: "cinema", tone: "Direct and fast, second person, no introduction",
    guidance:
      "A Short: the hook is the first sentence and it takes something away from the viewer (a surprising claim, a " +
      "number, a fear), then the reveal, then the proof, then the fix or the twist, and a last line that sends them " +
      "back to the start. Short punchy sentences, one narrated line per scene, no sign-off.",
    sections: [
      { name: "01 THE HOOK", role: "Take something the viewer believes and remove it, in one sentence", accent: "red", weight: 0.15 },
      { name: "02 THE REVEAL", role: "Show what is actually going on, with the thing itself on screen", accent: "amber", weight: 0.3 },
      { name: "03 THE PROOF", role: "One concrete fact, number or demonstration that settles it", accent: "cyan", weight: 0.3 },
      { name: "04 THE TURN", role: "The fix, the cost, or the twist the viewer did not expect", accent: "green", weight: 0.25 },
    ],
    wordsPerScene: [10, 18], shotSeconds: 2.5, closing: "loop",
  },
  /* ---------------------------------------------------------------- one person telling it */
  confession: {
    id: "confession", keouStyle: "cinema", tone: "First person, plain, as if told to a friend",
    guidance:
      "A story told in first person: the setup, the tension rising, the turning point, the payoff, and a one-line " +
      "reaction at the end. Keep the narrator's own voice and the details from the prompt; things people said become " +
      "short quoted lines.",
    sections: [
      { name: "01 THE SETUP", role: "Who, where, and what was normal until now", accent: "cyan", weight: 0.2 },
      { name: "02 IT BUILDS", role: "The pressure rising, one step at a time", accent: "amber", weight: 0.3 },
      { name: "03 THE TWIST", role: "The moment it changes, said plainly", accent: "red", weight: 0.25 },
      { name: "04 THE PAYOFF", role: "What happened after, and what it cost", accent: "green", weight: 0.25 },
    ],
    wordsPerScene: [12, 18], shotSeconds: 2.6, closing: "loop",
  },
  /* ---------------------------------------------------------------- lines that build */
  build: {
    id: "build", keouStyle: "cinema", tone: "Warm, second person, one idea per line",
    guidance:
      "Short declarative lines that build on each other, addressed to one person as 'you', one memorable quote-like " +
      "line per scene, ending on something to do today. Never a list, never advice in the abstract.",
    sections: [
      { name: "01 WHERE YOU ARE", role: "Name the situation the viewer is actually in", accent: "amber", weight: 0.25 },
      { name: "02 WHY IT HOLDS", role: "The reason it has not changed yet, without blame", accent: "red", weight: 0.25 },
      { name: "03 THE SHIFT", role: "The one thing that moves it", accent: "cyan", weight: 0.25 },
      { name: "04 TODAY", role: "The smallest version of it they can do today", accent: "green", weight: 0.25 },
    ],
    wordsPerScene: [10, 16], shotSeconds: 2.8, closing: "act",
  },
  /* ---------------------------------------------------------------- stakes to a title */
  trailer: {
    id: "trailer", keouStyle: "cinema", tone: "Terse and ominous, never explanatory",
    guidance:
      "A trailer: terse lines, stakes escalating scene by scene, chapter cards, the title revealed near the end, and " +
      "exactly one line after it. Nothing is ever explained.",
    sections: [
      { name: "01 THE CALM", role: "The world before, in two or three images", accent: "cyan", weight: 0.25 },
      { name: "02 THE CRACK", role: "The first sign that it will not hold", accent: "amber", weight: 0.25 },
      { name: "03 THE STAKES", role: "What is lost if it goes wrong, escalating", accent: "red", weight: 0.3 },
      { name: "04 THE TITLE", role: "The title itself, then one line after it", accent: "green", weight: 0.2 },
    ],
    wordsPerScene: [8, 14], shotSeconds: 2.2, closing: "title",
  },
  /* ---------------------------------------------------------------- a subject with chapters */
  chaptered: {
    id: "chaptered", keouStyle: "editorial", tone: "Calm and factual; say 'about' when a number is approximate",
    guidance:
      "A calm long-form piece: a cold open on a striking question or scene, the context, then chapters in order, dates " +
      "and numbers stated as figures, a human quote where there is one, the consequences, and a reflective close. " +
      "Every chapter ends on a sentence that makes the next one necessary.",
    sections: [
      { name: "01 COLD OPEN", role: "One striking question, scene or number, before any context", accent: "red", weight: 0.12 },
      { name: "02 THE GROUND", role: "What the viewer needs to know to follow the rest", accent: "cyan", weight: 0.23 },
      { name: "03 HOW IT WORKS", role: "The mechanism, step by step, in the order it happens", accent: "amber", weight: 0.35 },
      { name: "04 WHAT IT COST", role: "The consequence, in people, money or time", accent: "red", weight: 0.18 },
      { name: "05 WHERE IT LEAVES US", role: "What changed, and what the viewer does with it", accent: "green", weight: 0.12 },
    ],
    wordsPerScene: [30, 45], shotSeconds: 4, closing: "closing-scene",
  },
  /* ---------------------------------------------------------------- independent segments */
  segmented: {
    id: "segmented", keouStyle: "editorial", tone: "Hard, factual, neutral",
    guidance:
      "A run of independent segments, each opening on its own headline and cutting hard to the next. Every segment " +
      "carries one figure or one source; the segments do not refer to each other.",
    sections: [
      { name: "01 THE OPENING", role: "What this edition covers, in one sentence", accent: "cyan", weight: 0.12 },
      { name: "02 THE SEGMENTS", role: "Each item in turn: headline, the one figure, why it matters", accent: "amber", weight: 0.76 },
      { name: "03 NEXT", role: "What to watch after this", accent: "green", weight: 0.12 },
    ],
    wordsPerScene: [30, 45], shotSeconds: 3.5, closing: "closing-scene",
  },
  /* ---------------------------------------------------------------- a claim, then a verdict */
  verdict: {
    id: "verdict", keouStyle: "illustrated", tone: "Balanced and concrete, no marketing language",
    guidance:
      "What it is and who it is for, then one claim per scene with the evidence for it, the case against, the obvious " +
      "alternative side by side, and the verdict last as a single figure with two words of judgement.",
    sections: [
      { name: "01 WHAT IT IS", role: "The thing and who it is for, without adjectives", accent: "cyan", weight: 0.2 },
      { name: "02 WHAT IS GOOD", role: "One claim per scene, each with its evidence", accent: "green", weight: 0.3 },
      { name: "03 WHAT IS NOT", role: "The case against, stated as plainly as the case for", accent: "red", weight: 0.25 },
      { name: "04 THE VERDICT", role: "Against the obvious alternative, then the score", accent: "amber", weight: 0.25 },
    ],
    wordsPerScene: [30, 45], shotSeconds: 4, closing: "closing-scene",
  },
  /* ---------------------------------------------------------------- the drawn explainer */
  drawn: {
    id: "drawn", keouStyle: "sketch", tone: "Plain and certain; define a term the first time and never again",
    guidance:
      "An explainer that opens on the thing itself: the first line says something the viewer believes is safe and takes " +
      "it away, the second shows the object, the middle is the method in three moves, and the last line hands the viewer " +
      "the one thing they can do. No introduction, no 'in this video', no sign-off.",
    sections: [
      { name: "01 THE CLAIM", role: "Take away something the viewer thinks is safe, with the object on screen", accent: "red", weight: 0.2 },
      { name: "02 THE OBJECT", role: "Show the thing itself and what it really is", accent: "cyan", weight: 0.25 },
      { name: "03 THE METHOD", role: "How it actually works, one move per scene", accent: "amber", weight: 0.35 },
      { name: "04 WHAT YOU DO", role: "The one thing the viewer can act on", accent: "green", weight: 0.2 },
    ],
    wordsPerScene: [8, 14], shotSeconds: 2.0, closing: "act",
  },
};

const EN_IT = ["narrator-en-m", "narrator-en-f", "narrator-it-m", "narrator-it-f"];

/**
 * The storyboard guide names the voices the engine actually speaks with (Kokoro ids: am_michael, af_heart, …), and a
 * model that has just read the guide naturally passes one of those to kleo_create_video as well. Refusing it there
 * ("There is no voice called af_heart") is a pointless wall between two of our own names for the same voice, so the
 * tool accepts either spelling and normalises to the friendly one.
 */
const KOKORO_TO_FRIENDLY: Record<string, string> = {
  am_michael: "narrator-en-m", bf_emma: "narrator-en-f", af_heart: "narrator-en-f",
  im_nicola: "narrator-it-m", if_sara: "narrator-it-f",
};

/** The friendly voice id for whatever the caller wrote: a friendly id passes through, a Kokoro id is translated. */
export function normalizeVoice(voice: string | null | undefined): string | null {
  if (!voice) return null;
  const v = String(voice).trim();
  return KOKORO_TO_FRIENDLY[v] ?? v;
}

/** Every spelling a caller may legitimately use, for the "available voices" message. */
export const voiceSpellings = (friendly: readonly string[]): string[] =>
  [...friendly, ...Object.entries(KOKORO_TO_FRIENDLY).filter(([, f]) => friendly.includes(f)).map(([k]) => k)];

/**
 * Una descrizione entra nel contesto dell'assistente (kleo_list_templates) e diventa quello che l'assistente
 * PROMETTE all'utente prima ancora che il render parta. Quindi puo' descrivere il CONTENUTO — quante idee per
 * scena, che ritmo, che tono — ma non un componente che il motore non disegna. Fino all'11 settembre 2026 qui
 * c'erano "cinematic clips", "continuous footage", "slow-motion imagery" (Kleo non ha un solo fotogramma di
 * repertorio: disegna immagini), "2.39:1 letterbox", "orchestral score", "lower thirds", "post card on top",
 * "pros and cons on the sides": nessuna di quelle parole esiste in worker/keou/. L'utente le leggeva in chat e
 * poi non le vedeva nel video.
 */
export const TEMPLATES: Template[] = [
  { id: "story-documentary", name: "Story / Documentary", formats: ["16:9"], minSeconds: 300, maxSeconds: 720, defaultSeconds: 480,
    description: "Calm narration across chapters, one drawn picture per shot and a camera that drifts slowly over it. History, science, true stories.", voices: EN_IT,
    family: "chaptered" },
  { id: "top-10", name: "Top 10", formats: ["16:9"], minSeconds: 360, maxSeconds: 600, defaultSeconds: 420,
    description: "A countdown: one entry per scene, its number spoken and picked out in the caption, hard cuts between entries.", voices: EN_IT,
    // A countdown is the segmented language, but drawn: every entry is a thing you can see.
    family: "segmented", override: { sections: COUNTDOWN, keouStyle: "illustrated" } },
  { id: "viral-short", name: "Viral Short", formats: ["9:16"], minSeconds: 30, maxSeconds: 60, defaultSeconds: 45,
    description: "Hook in the first two seconds, big word-by-word captions, a cut every 2–3 seconds. The default for any Short.", voices: EN_IT,
    family: "short-hook" },
  { id: "reddit-story", name: "Reddit Story", formats: ["9:16"], minSeconds: 45, maxSeconds: 90, defaultSeconds: 60,
    description: "The post read aloud as a story, a picture per shot cut on the words, big captions. Paste the post text in the prompt.", voices: EN_IT,
    family: "confession" },
  { id: "motivational", name: "Motivational", formats: ["9:16", "16:9"], minSeconds: 30, maxSeconds: 90, defaultSeconds: 60,
    description: "One line held per scene, a picture drawn for each and the camera pushing slowly in, music underneath throughout.", voices: EN_IT,
    family: "build" },
  { id: "explainer", name: "Explainer / Tutorial", formats: ["16:9"], minSeconds: 240, maxSeconds: 480, defaultSeconds: 300,
    description: "One idea per scene, built in the order the voice explains it, with a recap at the end.", voices: EN_IT,
    // The cyber tutorial: the chaptered language drawn as motion design instead of pictures.
    family: "chaptered", override: { keouStyle: "technical" } },
  { id: "weekly-news", name: "Weekly News", formats: ["16:9"], minSeconds: 180, maxSeconds: 300, defaultSeconds: 240,
    description: "Four stories, each opening on its headline, hard cuts between segments.", voices: EN_IT,
    family: "segmented" },
  { id: "cinematic-trailer", name: "Cinematic Trailer", formats: ["16:9"], minSeconds: 60, maxSeconds: 90, defaultSeconds: 75,
    description: "Short scenes, a beat of silence before the last line, and the title held at the end.", voices: EN_IT,
    family: "trailer" },
  { id: "product-review", name: "Product Review", formats: ["16:9"], minSeconds: 240, maxSeconds: 360, defaultSeconds: 300,
    description: "The product in every shot, one claim per scene, and the verdict last.", voices: EN_IT,
    family: "verdict" },
  // The explainer look (kleo_style "explainer"): one drawing per phrase, karaoke captions, a camera
  // that only pushes in. Two rows because the two lengths are different films: a Short is one idea
  // told in under a minute — past that people stop following — and a video is a subject with chapters.
  { id: "explainer-short", name: "Cyber Explainer Short (drawn)", formats: ["9:16"], minSeconds: 20, maxSeconds: 60, defaultSeconds: 45,
    description: "Hand-drawn white line art on black. One picture for every phrase, a hard hook in the first second, karaoke captions. Under a minute on purpose.", voices: EN_IT,
    family: "drawn" },
  { id: "explainer-long", name: "Cyber Explainer Video (drawn)", formats: ["16:9"], minSeconds: 180, maxSeconds: 480, defaultSeconds: 300,
    description: "The same drawn look across a full subject: chapters, one picture per phrase, and a camera that never stops moving. Landscape.", voices: EN_IT,
    // Same language, five minutes instead of forty seconds: only what the length forces changes.
    family: "drawn", override: { wordsPerScene: [12, 20], shotSeconds: 2.6, guidance: LONG_DRAWN } },
  // THE ONE PUBLIC TEMPLATE. A film: short, 9:16 or 16:9, chaptered narration, every shot filmed. Length is the
  // user's; the planner decides the scenes from it (see BRIEFS / FAMILIES: the "chaptered" language, which handles
  // both a thirty-second piece and five minutes).
  { id: "film", name: "Film", formats: ["16:9", "9:16"], minSeconds: 15, maxSeconds: 90, defaultSeconds: 30,
    description: "A realistic film under ninety seconds: a hook in the first two seconds, every shot generated as moving footage from its own frame, narrated, no captions, no music, 4K 60 fps. Say what it is about and how long; Kleo decides the shots.", voices: EN_IT,
    family: "short-hook" },
  { id: "film-long", name: "Film (long)", formats: ["16:9", "9:16"], minSeconds: 90, maxSeconds: 300, defaultSeconds: 120,
    description: "The same film in chapters, from a minute and a half to five minutes. Chosen on its own when the length asks for it.", voices: EN_IT,
    family: "chaptered" },
  { id: "did-you-know", name: "Did You Know", formats: ["9:16"], minSeconds: 20, maxSeconds: 40, defaultSeconds: 30,
    description: "One fact per scene, karaoke captions, the image changes on every sentence.", voices: EN_IT,
    family: "short-hook", override: { wordsPerScene: [10, 16], guidance: DID_YOU_KNOW } },
];

export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id) as [string, ...string[]];

/**
 * THE PRODUCT HAS ONE TEMPLATE AND ONE LOOK (the owner's reset of 13 September 2026): a realistic film, 16:9 or 9:16,
 * filmed shot by shot under the narration. The table above still holds the narrative families the planner uses
 * internally (and the rows old jobs were made with), but none of them is offered, accepted or guessed any more.
 * `film` is what kleo_list_templates lists and what kleo_create_video takes; it is also the default when the
 * template is omitted. The adapt-prompt planner that replaces the families lands in a later step.
 */
export const FILM_TEMPLATE_ID = "film";
/** Legacy id retained only so old database rows can still be read. New requests always use `film`. */
export const FILM_LONG_TEMPLATE_ID = "film-long";
export const PUBLIC_TEMPLATE_IDS = [FILM_TEMPLATE_ID] as [string];
/**
 * ONE public template, TWO internal rows. The user sees "film" and says a length; the length picks the row the
 * planner shapes the film with — the short arc (hook first) up to ninety seconds, chapters beyond. A job row keeps
 * the internal id it was planned with, which is why both ids stay public for createJob and for old rows.
 */
export const filmTemplateFor = (seconds: number | undefined | null): string =>
  typeof seconds === "number" && seconds > 90 ? FILM_LONG_TEMPLATE_ID : FILM_TEMPLATE_ID;
export const ACTIVE_TEMPLATE: Template = {
  id: FILM_TEMPLATE_ID, name: "Realistic Film", formats: ["16:9", "9:16"], minSeconds: 15, maxSeconds: 300, defaultSeconds: 60,
  description: "Adaptive realistic film: shot-by-shot direction, real motion clips, continuity, narration only, no music or subtitles.", voices: EN_IT, family: "chaptered",
};
export const PUBLIC_TEMPLATES: Template[] = [ACTIVE_TEMPLATE];
export const isPublicTemplate = (id: string | undefined | null): boolean => id === FILM_TEMPLATE_ID || id === FILM_LONG_TEMPLATE_ID;
export const findTemplate = (id: string): Template | undefined => TEMPLATES.find((t) => t.id === id);

/**
 * The narrative shape of one template: its family with its overrides applied. This is the ONE place the
 * planner, the guide and the site may read the structure of a video from — src/storyboard.ts builds its
 * briefs from it, so a change to the rhythm of a look is a change in one file.
 */
export function narrativeFor(templateId: string): Family {
  const t = findTemplate(templateId);
  const base = FAMILIES[t?.family ?? ""] ?? FAMILIES["short-hook"];
  return t?.override ? { ...base, ...t.override } : base;
}

/** How many scenes a section owns, given the film's total. Never zero: a section with no scene is not a section. */
export function sceneSplit(f: Family, scenes: number): number[] {
  const raw = f.sections.map((s) => s.weight * scenes);
  const out = raw.map((n) => Math.max(1, Math.round(n)));
  // Rounding up every short section can overshoot; take the difference off the widest one, which can afford it.
  let drift = out.reduce((a, b) => a + b, 0) - scenes;
  while (drift !== 0) {
    const i = drift > 0 ? out.indexOf(Math.max(...out)) : out.indexOf(Math.min(...out));
    if (drift > 0 && out[i] <= 1) break;
    out[i] += drift > 0 ? -1 : 1;
    drift += drift > 0 ? -1 : 1;
  }
  return out;
}

/**
 * What one credit buys is NOT the same in every style, because what a style costs on a rented GPU differs by an
 * order of magnitude. Measured 10-11 September 2026 on an RTX 4090: a 40 s Short whose shots are still pictures
 * costs $0.067 of rental; the same Short with generated motion costs about $0.50, because every shot is roughly two
 * minutes of card. Selling both for one credit means the second is sold at a seventh of its price — and, worse, the
 * two free credits a new account is given would then buy a full dollar of GPU, which is the entire daily budget
 * (DAILY_GPU_BUDGET_USD) spent by one stranger.
 *
 * So the multiplier follows the dollar. Every style that draws still pictures, or draws itself live, is 1.
 * A style that generates motion is 7, which — while cartoon was still sold — also put it out of reach of the two
 * free credits by construction, the same thing that already kept long videos out of the free tier.
 *
 * Since the reset of 13 September the film is the ONLY product, so FREE_CREDITS has to be read against THIS number
 * and not against the old 1-credit Short. At 2 it bought nothing: a stranger was told "start free, 2 Shorts
 * included", could not render (7 > 2) and was told by kleo_account that card payments were closed — while the
 * account page was already selling packs. Found 13 September 12:28Z on a friend's account, zero videos made.
 * FREE_CREDITS is now one film (7); test/style-price.test.mjs reads wrangler.jsonc and fails if the free tier ever
 * stops affording a film again.
 *
 * 7 is the TYPICAL cost, not the ceiling. A generated clip sometimes comes back frozen and has to be redrawn with
 * another seed, and the generator gives up after two attempts per shot, so the worst case is three times the base —
 * around 10 credits' worth of GPU. How often that happens was first put at a quarter of clips, from isolated trials;
 * on the first real film (eight 16:9 shots, 28 minutes of generation, 11 September) it was one shot in eight, 12%.
 * So the typical figure holds and 7 is the price, charged up front; 10 stays the number to reason about for a bad
 * day. What actually bounds a bad day is not the price list but DAILY_GPU_BUDGET_USD, which is exactly its job.
 */
export const STYLE_CREDITS: Record<string, number> = {
  cartoon: 1,     // AI pictures + Ken Burns
  realistic: 7,   // FILMED since 13 September: a reference frame per shot, animated by Wan 2.2, under the narration
  cyber: 1,       // no pictures at all, drawn live by the engine
  stickman: 1,    // idem
  explainer: 1,   // one drawing per phrase
};

/**
 * What machine a style needs, which is a different question from what it costs and has to be asked separately:
 * a style can be cheap to sell and impossible to render on the card the renter happens to pick.
 *
 * Measured 11 September 2026 by the session that owns the render chain, on real rentals and not from a datasheet:
 *   · 24 GB (RTX PRO 4000 Blackwell): Wan 2.2 TI2V-5B dies with OutOfMemory at 1280x704 / 49 frames — and it dies
 *     at the FIRST shot, after the rental and the 15 GB image pull have already been paid for.
 *   · 48 GB (RTX 6000 Ada): comfortable, about 125 s per 2-second clip.
 *   · 32 GB but compute capability 7.0 (Tesla V100): has the memory and is the WRONG card — no bf16 tensor cores,
 *     no flash attention, several times slower. Memory alone is not a floor; the architecture is the other half.
 * Hence 32 GB as the honest floor for generated video (5090, L40S, A6000, 6000 Ada, A100 all clear it) and 8.0 as
 * the compute floor everywhere: Ampere or newer.
 *
 * The renter used to ask for `gpu_name: { eq: "RTX 4090" }`. That is wrong at the root, not merely too narrow — the
 * name is not the constraint (modified 4090s with 48 GB exist, and a V100 passes any name test you write for it).
 * The numbers are the constraint, and Vast filters on them directly: gpu_ram in MB, compute_cap as cc x 100.
 */
export interface Machine { minVramGb: number; minComputeCap: number; maxDph: number }

/** The profile every style takes today: no generated video anywhere, so nothing needs a big card. */
const PICTURES: Machine = { minVramGb: 16, minComputeCap: 800, maxDph: 0.40 };

/**
 * The profile a style takes the day its shots become generated video. It is NOT wired to anything yet, on purpose:
 * the render chain is not finished, and until it is, realistic stays on still pictures and risks nothing.
 * Turning it on is one line here — realistic: VIDEO — and it must happen in the SAME commit as its price in
 * STYLE_CREDITS (7) and as the engine change, because the three are the same decision seen from three sides.
 */
export const VIDEO: Machine = { minVramGb: 32, minComputeCap: 800, maxDph: 1.20 };   // Wan 2.2 5B: 1.20 was the owner's ceiling, and where the ≥32 GB market sat on 13 September

/** The video profile for a given model id: LTX-2.5 (22B, bf16) wants an 80 GB card, and those start near $1.9/h. */
export function videoMachineFor(modelId: string | undefined, over: { minVramGb?: string; maxDph?: string } = {}): Machine {
  const ltx = /ltx/i.test(modelId ?? "");
  const base: Machine = ltx ? { minVramGb: 80, minComputeCap: 800, maxDph: 2.60 } : VIDEO;
  const vram = Number(over.minVramGb), dph = Number(over.maxDph);
  return { ...base, minVramGb: Number.isFinite(vram) && vram > 0 ? vram : base.minVramGb, maxDph: Number.isFinite(dph) && dph > 0 ? dph : base.maxDph };
}

/**
 * The box for the FINISH phase of a filmed video: no model, no picture, only ffmpeg on the clips the GPU made —
 * the 60 fps 4K track, the narration, the checks, the upload. Any card will do; what matters is cores and price.
 * Ten to twelve minutes a film at these prices is a cent, against a third of the GPU bill it replaces.
 */
export const FINISH: Machine = { minVramGb: 0, minComputeCap: 0, maxDph: 0.12 };

/** True when the model's weights are gated on Hugging Face and the worker needs a token to fetch them. */
export const videoModelIsGated = (modelId: string | undefined): boolean => /ltx/i.test(modelId ?? "");

/** Disk the box needs for the model: LTX-2.5 is 72 GB of weights on top of the 15 GB image and the film. */
export const videoDiskGb = (modelId: string | undefined, base: number): number => Math.max(base, /ltx/i.test(modelId ?? "") ? 150 : base);

export const STYLE_MACHINE: Record<string, Machine> = {
  cartoon: PICTURES,    // Stable Diffusion 1.5, about 6 GB
  realistic: VIDEO,     // since 13 September: Wan 2.2 films its shots (worker/kleo_worker.py render_film)
  cyber: PICTURES,      // draws itself live, no model at all
  stickman: PICTURES,
  explainer: PICTURES,
};

/**
 * A style whose machine costs more than the ordinary one is a generated-video style, and at most
 * MAX_CONCURRENT_VIDEO_GPUS of them may run at once. Two of those at the same time is the only way this can quietly
 * empty the balance: they are the dearest cards AND the ones whose cost triples when clips come back frozen.
 * Deriving it from the table rather than from a second list means flipping one entry to VIDEO moves the price, the
 * machine and the concurrency limit together, and none of the three can be forgotten on its own.
 */
export const isVideoStyle = (style: string | null | undefined): boolean =>
  !!style && (STYLE_MACHINE[style]?.minVramGb ?? 0) > PICTURES.minVramGb;

/**
 * ONE RULE, SAID ONCE: **a guess never changes the price.**
 *
 * It has two halves that live in two different files, and both derive from STYLE_CREDITS rather than from a list of
 * their own — that is the whole point. createJob (src/jobs.ts) uses affordableGuess at CREATION: a look nobody
 * asked for cannot cost more than the cheapest. generateStoryboard (src/storyboard.ts) uses samePrice at PLANNING:
 * the direction may refine a guessed look, but only inside the price already paid.
 *
 * The asymmetry is deliberate and worth keeping in mind: naming a style is a DECISION and is always honoured,
 * whatever it costs. Not naming one is a bet — and bets are not paid for with somebody else's credits. The style
 * planner's own accuracy was measured at 35% on 11 September 2026, so the bet is wrong two times out of three.
 */

/** The dearest look Kleo may pick BY ITSELF: the guess when it is affordable, otherwise the cheapest style there is. */
export function affordableGuess(style: string, duration: number): string {
  const cheapest = Object.keys(STYLE_CREDITS).reduce((a, b) => (creditsFor(duration, b) < creditsFor(duration, a) ? b : a), style);
  return creditsFor(duration, style) <= creditsFor(duration, cheapest) ? style : cheapest;
}

/** True when two looks cost the same, which is the only condition under which a guess may be refined into another. */
export const samePrice = (a: string, b: string, duration: number): boolean =>
  creditsFor(duration, a) === creditsFor(duration, b);

/** The machine this job needs. An unknown style gets the ordinary profile: the price table is what punishes a
 *  missing entry, and refusing to rent anything at all would take the whole service down instead. */
export const machineFor = (style: string | null | undefined): Machine =>
  (style && STYLE_MACHINE[style]) || PICTURES;

/**
 * A style nobody priced is charged at the DEAREST price we know, never the cheapest. Forgetting an entry above is
 * then loud and free (a user says "why did this cost 7 credits?") instead of silent and expensive (the owner pays
 * for every render of it). test/style-price.test.mjs fails outright if a KLEO_STYLES entry has no price here.
 */
const priceOf = (style: string | null | undefined): number =>
  style ? STYLE_CREDITS[style] ?? Math.max(...Object.values(STYLE_CREDITS)) : 1;

/** Credits: 1 for a Short (≤ 90 s), 3 for up to 5 minutes, +1 per extra minute — times what the style costs. */
export const creditsFor = (seconds: number, style?: string | null): number =>
  (seconds <= 90 ? 1 : seconds <= 300 ? 3 : 3 + Math.ceil((seconds - 300) / 60)) * priceOf(style);

/** The one look the product sells (the reset of 13 September); every price quoted to a user is this style's. */
export const FILM_STYLE = "realistic";
/** What a film of this length costs; with no length, the template's default. */
export const filmCredits = (seconds: number = ACTIVE_TEMPLATE.defaultSeconds): number => creditsFor(seconds, FILM_STYLE);
/**
 * The tariff in one sentence, computed from creditsFor itself, so the sign-in page, the account page and the tools
 * all quote the price that is actually charged. Three hand-written copies of it said "1 credit = 1 Short" for a
 * day after the film became the only product at 7.
 */
export const tariffSentence = (): string =>
  `${filmCredits(90)} credits per film up to 90 seconds, ${filmCredits(300)} up to 5 minutes, +${filmCredits(360) - filmCredits(300)} per extra minute`;

/** Rough wall-clock estimate on one RTX 4090 at 4K 60 fps: ~25 min for a Short, ~12 min per minute of long-form. */
export const etaFor = (seconds: number): number => (seconds <= 90 ? 18 : Math.max(30, Math.round((seconds / 60) * 10)));

/**
 * Minutes a rented GPU may live for THIS job, counted from the rental (jobs.started_at), and the same number the
 * container's own watchdog gets. JOB_TIMEOUT_MIN is a FLOOR, never a ceiling: 60 is right for a Short (23 minutes
 * measured) but etaFor(480) promises the user 80 minutes for a default long video, and a timeout below the ETA the
 * server itself quoted can only ever kill a healthy render — three times over, since failJob requeues it.
 * The image pull happens inside the same clock (started_at is the rental, not the first frame), so the pull we
 * already agree to wait for (LOADING_TIMEOUT_MIN) is part of the budget too.
 */
/** The Kleo style stored on a job, or null for a row written before styles existed / an unreadable one. */
export function styleOfJob(job: Pick<Job, "params">): string | null {
  try { return (JSON.parse(job.params) as JobParams).style ?? null; } catch { return null; }
}

/**
 * How long a RUNNING render may legitimately say nothing, which is not one number: it grows with the video.
 *
 * Silence means last_report_at, written only when the worker parses a line out of the engine's stdout. Between
 * frames that is FRAME, often enough to be safe. But AFTER the last frame the master is decoded four times over,
 * and every one of those passes is mute: two ffprobe -count_frames, one ffmpeg blackdetect, and the small preview
 * that decodes at 4K to re-encode at 540px. The mux itself is not the problem — it is -c:v copy and fast.
 *
 * Those four passes scale with the length of the video, so the silence they produce does too. A Short keeps the
 * tight limit — 27 of the 29 jobs ever made are Shorts, and a tenth of a minute per pass is nothing — and only
 * what runs longer buys the room it actually needs. Raising the floor for everybody instead would buy patience for
 * workers that are genuinely dead, which is paying in money for what a line of log should cost.
 *
 * This is a STOPGAP and should be read as one. The cure is to make those passes speak (`ffmpeg -progress pipe:1`,
 * and a decoding ffmpeg instead of a mute ffprobe for the frame count); the estimate of how long they take is not
 * measured on a rented machine yet, only reasoned about. Until it is, the room here is generous on purpose.
 */
export function renderSilenceMin(env: Env, job: Pick<Job, "params">): number {
  const base = int(env.RENDER_SILENCE_MIN, 20);
  let seconds = 0;
  try { seconds = (JSON.parse(job.params) as JobParams).duration_s; } catch { /* unreadable rows keep the floor */ }
  // Nothing extra up to a Short; past that, three minutes of tolerated silence per minute of video.
  return base + Math.round((Math.max(0, seconds - 90) / 60) * 3);
}

export function jobTimeoutMin(env: Env, job: Pick<Job, "params">): number {
  let seconds = 0;
  try { seconds = (JSON.parse(job.params) as JobParams).duration_s; } catch { /* an unreadable row just gets the flat value */ }
  // etaFor is an ESTIMATE, and a timeout set to an estimate kills every render the estimate was optimistic about.
  // It is also an estimate that was calibrated at 1920 wide and is now asked about 3840, so the half it can be wrong
  // by is the half that matters. Hence the headroom: the quote stays what the user is told, the limit is half again
  // as much. It is not generosity — nothing else stops a render once it is under way, and the thing that catches a
  // worker that has actually died is silence (orchestrator.ts RENDER_SILENCE_MIN), which is a sensor, not a clock.
  return Math.max(int(env.JOB_TIMEOUT_MIN, 60), Math.round(etaFor(seconds) * 1.5) + int(env.LOADING_TIMEOUT_MIN, 35));
}
