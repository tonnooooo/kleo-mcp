import type { Env } from "./env";
import type { Job, JobParams } from "./db";
// ".ts" on purpose: storyboard.ts imports this file and is loaded straight from source by the test runner
// (node type stripping), whose resolver has no extension search. Wrangler bundles either form.
import { int, num } from "./util.ts";
import { placeTransitions } from "./transitions.ts";

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
    description: "A film, realistic or animated, under ninety seconds: a hook in the first two seconds, every shot generated as moving footage by Seedance 2.5 from its own frame drawn by Nano Banana Pro (the film) or that frame with a camera move over it (the animatic, 5 credits, up to 60 s), narrated, music and burned-in subtitles only when the user asks, 4K 60 fps. Say what it is about and how long; Kleo decides the shots.", voices: EN_IT,
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
 * THE PRODUCT HAS ONE TEMPLATE AND TWO LOOKS (the owner's reset of 13 September 2026; animation added on the 14th): a film, realistic or animated, 16:9 or 9:16,
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
  description: "Adaptive film, realistic or animated: shot-by-shot direction, real motion clips generated by Seedance 2.5 from frames drawn by Nano Banana Pro, continuity, narration; music and burned-in subtitles when the user asks.", voices: EN_IT, family: "chaptered",
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
  // Since the reset of 13 September there is ONE product, the realistic film, and since 14 September its price is
  // set by LENGTH alone (filmBase below). The multipliers stay at 1 so the old looks, should one ever be rendered
  // again, are charged as a film and never below it: a picture Short at 1 credit was the loophole this closes.
  cartoon: 1,
  realistic: 1,   // FILMED: a reference frame per shot, animated by kie.ai (MiniMax H3) under the narration
  animation: 1,   // FILMED the same way, in the drawn look (14 September): the price is the length's
  cyber: 1,
  stickman: 1,
  explainer: 1,
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
 *
 * The neural finish (worker/kleo_sr.py: Real-ESRGAN + RIFE 4.25) is an OPTION since the owner's decision of 25
 * September 2026, asked in the intake and paid for (aiUpscaleCredits below): only a film whose user said yes rents
 * FINISH_SR for its finish box and gets KLEO_SR "auto"; every other film finishes the classic way (Lanczos +
 * minterpolate) on any card, as before.
 */
export const FINISH: Machine = { minVramGb: 0, minComputeCap: 0, maxDph: 0.12 };

/**
 * The finish box of a film with the AI upscale: 8 GB of Turing or newer (the image's torch has no kernels below
 * compute 7.5, and SR + RIFE need the memory). The search stays cheapest first with 16 or more cores, and the price
 * ceiling really applied is max(VAST_MAX_DPH, maxDph) — VAST_MAX_DPH (1.00) in production, not the 0.12 written here.
 * A box that still cannot run it finishes the classic way, and the upscale's credits go back (refundAiUpscale, src/orchestrator.ts).
 */
export const FINISH_SR: Machine = { minVramGb: 8, minComputeCap: 750, maxDph: 0.12 };

/** True when the model's weights are gated on Hugging Face and the worker needs a token to fetch them. */
export const videoModelIsGated = (modelId: string | undefined): boolean => /ltx/i.test(modelId ?? "");

/** Disk the box needs for the model: LTX-2.5 is 72 GB of weights on top of the 15 GB image and the film. */
export const videoDiskGb = (modelId: string | undefined, base: number): number => Math.max(base, /ltx/i.test(modelId ?? "") ? 150 : base);

export const STYLE_MACHINE: Record<string, Machine> = {
  cartoon: PICTURES,    // Stable Diffusion 1.5, about 6 GB
  realistic: VIDEO,     // since 13 September: Wan 2.2 films its shots (worker/kleo_worker.py render_film)
  animation: VIDEO,     // since 14 September: the same road, the stills drawn as animation frames
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

/**
 * THE TARIFF, 14 September 2026: one credit buys two seconds of film, ten credits at least.
 *
 * Why length and nothing else: the film's real cost is per second — about 0.13 $ of kie.ai clips a second (fifteen
 * MiniMax H3 shots at their 4 s minimum for a 30 s Short = 3.90 $), plus a few cents of GPU. The old ladder
 * (7 credits up to 90 s) sold a 90 s film for 3.50 EUR that cost 11 $ to make, and the free tier gave one away to
 * every stranger. At 0.40-0.50 EUR a credit (the packs in stripe.ts) this rule returns 1.5-1.9x the cost at every
 * length (test/style-price.test.mjs guards 1.4x on the cheapest credit), and the floor of ten is exactly the smallest
 * pack: 5 EUR buys a 20-second film, nothing buys one for free.
 *   20 s = 10 · 30 s = 15 · 60 s = 30 · 90 s = 45 · 5 min = 150
 */
export const SECONDS_PER_CREDIT = 2;
export const MIN_FILM_CREDITS = 10;
export const filmBase = (seconds: number): number =>
  Math.max(MIN_FILM_CREDITS, Math.ceil(Math.max(0, Number(seconds) || 0) / SECONDS_PER_CREDIT));
/** Credits for a video of this length in this look: the film base times the look's multiplier (1 for every look today). */
export const creditsFor = (seconds: number, style?: string | null): number => filmBase(seconds) * priceOf(style);

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
  `1 credit buys ${SECONDS_PER_CREDIT} seconds of film, ${MIN_FILM_CREDITS} credits minimum: ${filmCredits(30)} credits for a 30-second Short, ${filmCredits(60)} for a minute, ${filmCredits(300)} for five minutes; an animatic of the same storyboard (the drawn frames with camera moves and the narration, no generated clip, up to ${ANIMATIC_MAX_S} seconds) costs ${ANIMATIC_CREDITS} credits flat`;

/**
 * THE MODELS, BY NAME (26 September 2026, the owner: "add Seedance 2.5 and Nano Banana Pro"). What makes a film, said
 * the same way wherever a user or their assistant reads it: the moving footage, the frames and character sheets, the
 * music, the voices. The gateway the requests travel through is never named in these texts (src/util.ts publicText);
 * the privacy page names it, as a processor.
 */
export const MODELS = { footage: "ByteDance Seedance 2.5", frames: "Google Nano Banana Pro", music: "Suno", voices: "Kokoro" } as const;
export const modelsSentence = (): string =>
  `A film's moving footage is generated by ${MODELS.footage}; the frames and the character sheets (from the user's own photos when they give some) are drawn by ${MODELS.frames}, and a vision model checks every picture against the request before anything is filmed; the music is composed by ${MODELS.music} and the narration voiced by ${MODELS.voices}`;

/**
 * THE TWO PRODUCTS, 15 September 2026. The owner's rule that day: the clips are bought from kie.ai with his money, so
 * a FILM is made only for an account that has actually paid (src/db.ts hasPaid: one Stripe payment on record),
 * never with the free credits, a bonus row or a balance typed in by hand — his own test account included. And the
 * free tier still has to make something: the ANIMATIC is the same treatment, direction, storyboard and stills, the
 * camera moving over each frame (worker/keou/engine/picture.js kenBurns) under the same layer and narration, at 4K
 * 60 fps — everything but the generated motion, so nothing of it is bought from kie.ai. It costs ANIMATIC_CREDITS
 * flat, under the sign-up gift on purpose (test/style-price.test.mjs pins gift ≥ animatic < shortest film), and it
 * doubles as the preview of the film: same storyboard, then the film at the film's price.
 *
 * The product is a job PARAMETER (JobParams.product), not a template: the template is what owns the length and the
 * brief, and an "animatic" template id would fall to BRIEFS.explainer in planFor. Absent means film, so every row
 * made before this day reads as what it was.
 */
export type Product = "film" | "animatic";
export const PRODUCTS = ["film", "animatic"] as const;
export const ANIMATIC_CREDITS = 5;
/** The longest animatic: it is a preview and a free-tier product, not a five-minute film drawn on the cheap. */
export const ANIMATIC_MAX_S = 60;
export const productOf = (p: { product?: string } | null | undefined): Product => (p?.product === "animatic" ? "animatic" : "film");
export const isAnimatic = (p: { product?: string } | null | undefined): boolean => productOf(p) === "animatic";
/** What a job costs: the film's tariff, or the animatic's flat price. The ONE place a product's price is decided. */
export const creditsForProduct = (seconds: number, style: string | null | undefined, product: Product | string | null | undefined): number =>
  product === "animatic" ? ANIMATIC_CREDITS : creditsFor(seconds, style);
/**
 * THE AI UPSCALE, AN OPTION THAT COSTS (the owner's decision of 25 September 2026, after the A/B probe on an RTX 3060:
 * Real-ESRGAN + RIFE 4.25 made the track 4.6x sharper for 1.29x the flicker and 1.4 more minutes per 15 s of film).
 * The classic 4K 60 fps finish stays the default; the upscale is asked in the intake, for the film only, and adds
 *   max(AI_UPSCALE_MIN_CREDITS, ceil(film credits x AI_UPSCALE_FACTOR))
 * to the film's price — with the defaults (5, 1.0) the film costs double: 15 s = 10 + 10, 30 s = 15 + 15, 60 s = 30 + 30.
 * The extra is refunded automatically when the finish could not upscale every shot (refundAiUpscale, src/orchestrator.ts).
 */
export const AI_UPSCALE_MIN_CREDITS = 5;
export const AI_UPSCALE_FACTOR = 1.0;
type UpscaleEnv = { AI_UPSCALE_MIN_CREDITS?: string; AI_UPSCALE_FACTOR?: string; KLEO_SR?: string };
const upscaleKnobs = (env: UpscaleEnv) => ({
  min: Math.max(0, int(env.AI_UPSCALE_MIN_CREDITS, AI_UPSCALE_MIN_CREDITS)),
  factor: Math.max(0, num(env.AI_UPSCALE_FACTOR, AI_UPSCALE_FACTOR)),
});
/** The extra credits of the AI upscale on a film that costs `filmCredits`. */
export function aiUpscaleCredits(filmCredits: number, env: UpscaleEnv = {}): number {
  const { min, factor } = upscaleKnobs(env);
  return Math.max(min, Math.ceil(Math.max(0, filmCredits) * factor - 1e-9));
}
/** The rule in words, for when the length (and so the exact number) is not known yet. */
export function aiUpscaleRule(env: UpscaleEnv = {}): { en: string; it: string } {
  const { min, factor } = upscaleKnobs(env);
  if (factor === 1) return { en: `as many credits again as the film, at least ${min}`, it: `tanti crediti quanti ne costa il film, almeno ${min}` };
  return { en: `${factor}x the film's credits, at least ${min}`, it: `${factor} volte i crediti del film, almeno ${min}` };
}
/** The kill switch: KLEO_SR "off" on the Worker (a var or a secret, no deploy) switches the option off for everybody. */
export const aiUpscaleOn = (env: UpscaleEnv): boolean => !/^(?:off|0|false|no)$/i.test((env.KLEO_SR ?? "").trim());
/** Whether this job was sold the AI upscale (JobParams.ai_upscale). */
export function aiUpscaleJob(job: Pick<Job, "params">): boolean {
  try { return (JSON.parse(job.params) as JobParams).ai_upscale === true; } catch { return false; }
}
/**
 * What the finish box said about the upscale (the `sr` of its /done call, worker/kleo_video.py LAST_SR), read as a
 * verdict: applied only when every part with a clip went through Real-ESRGAN (a model is named). Anything else — no report, no card, the
 * benchmark over budget, the breaker, one part on the classic chain, KLEO_SR off on the box — is "not applied".
 */
export interface AiUpscaleVerdict { applied: boolean; parts: number; upscaled: number; model: string | null; gpu: string | null; reason: string | null }
export function aiUpscaleVerdict(sr: unknown): AiUpscaleVerdict {
  const o = sr && typeof sr === "object" && !Array.isArray(sr) ? (sr as Record<string, unknown>) : null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
  if (!o) return { applied: false, parts: 0, upscaled: 0, model: null, gpu: null, reason: "the finish box sent no report of the upscale" };
  const parts = n(o.parts), model = s(o.model);
  // No upscaler named (factor 1: RIFE only, the clips already near 4K; an older box says "no upscaler") is not the
  // Real-ESRGAN pass the user paid for, even when every part went through the GPU (review, 25 September 2026).
  const esrgan = model !== null && !/^no upscaler$/i.test(model);
  const upscaled = esrgan ? Math.min(parts, n(o.applied)) : 0;
  const applied = parts > 0 && upscaled === parts;
  const reason = applied ? null : s(o.reason) ?? (parts === 0 ? "no shot had a clip to upscale"
    : !esrgan ? "the clips are already near 4K: no Real-ESRGAN pass, RIFE only" : `${upscaled} of ${parts} shots were upscaled`);
  return { applied, parts, upscaled, model, gpu: s(o.gpu), reason };
}

/**
 * Whether a storyboard asks to be FILMED (backdrop "video" → the worker orders the clips) or drawn (no backdrop → the
 * stills with the camera over them). Three places used to compute it from the look alone; the product is the third
 * term, and this is the one function all three call so an animatic can never be filmed by one of them.
 */
export const filmedStoryboard = (kleo: string | null | undefined, style: string | null | undefined, product: Product | string | null | undefined): boolean =>
  isVideoStyle(kleo) && style === "picture" && product !== "animatic";
/**
 * What the worker draws over an animatic when its storyboard carries no layer: a layer with NOTHING on it. Without
 * one, picture.js draws the picture look of before the 13 September reset — fitted words on the first shot, karaoke
 * subtitles, a veil, the chapter pill, a closing button — and run.py mixes a music bed: the product the owner sent
 * back four times. With any `graphics` object the engine draws the layer and only the layer (picture.js "A film with
 * a LAYER draws that layer and nothing of the picture look"), and an empty hud draws nothing. The validators delete
 * an empty layer as "no layer" on purpose, so this is put on AFTER the last validation, by finishForProduct, and
 * worker/keou/contract.py accepts it (0-3 hud elements).
 */
export const BARE_LAYER = { accent: "#ffffff", subtitles: "none", chapters: "none", hud: [] as never[] };
/**
 * The camera an animatic gives a shot the grammar LOCKED OFF. `static_forced` (hands at work, a crowd, signage, a
 * mechanism) resolves to `static_hold` at strength 0 because those subjects come apart when a VIDEO model moves the
 * camera — a rule about the clip generator, which an animatic never calls. Over a still, a locked-off camera is a
 * frozen frame: the engine's QA (worker/keou/qa.py) refuses a second of identical frames and the whole render dies.
 * So the animatic drifts instead: a push in at ANIMATIC_DRIFT of the engine's 10 % zoom — about 3 % over the shot,
 * enough for every sampled frame to differ, not enough to read as a move.
 */
export const ANIMATIC_DRIFT = { motion: "push_in", strength: 0.35 } as const;
/**
 * The last touch on a storyboard before it is stored. For BOTH products, when the film's length is known: the
 * dissolves between acts (src/transitions.ts, 22 September 2026). For the animatic: no music BED (the user's track,
 * "track", stays), a layer that draws nothing when it has none, and no locked-off shot.
 */
export function finishForProduct<T extends Record<string, unknown>>(sb: T, product: Product | string | null | undefined, duration_s?: number | null): T {
  if (duration_s && duration_s > 0) placeTransitions(sb as { scenes?: unknown }, duration_s);
  if (product !== "animatic") return sb;
  const c = sb as Record<string, unknown>;
  if (c.music !== "track") c.music = "none";
  if (!(c.graphics && typeof c.graphics === "object" && !Array.isArray(c.graphics))) c.graphics = { ...BARE_LAYER, hud: [] };
  if (Array.isArray(c.scenes)) for (const s of c.scenes as Record<string, unknown>[]) {
    if (!s || !Array.isArray(s.shots)) continue;
    for (const sh of s.shots as Record<string, unknown>[]) {
      if (sh && sh.motion === "static_hold") { sh.motion = ANIMATIC_DRIFT.motion; sh.strength = ANIMATIC_DRIFT.strength; }
    }
  }
  return sb;
}
/** Minutes an animatic takes on the pictures card: the still model's download and its frames (the two XL checkpoints
 *  are not baked in the image), the voice pass and the 4K 60 fps render — no clip to wait for. ~13 min at 15 s, ~20 at 60. */
export const animaticEtaFor = (seconds: number): number => Math.max(12, Math.round(10 + seconds / 6));

/**
 * THE SIGN-UP GIFT, 14 September 2026: FREE_CREDITS (wrangler.jsonc, 7) credits on a brand-new account — and the
 * shortest film costs MIN_FILM_CREDITS (10). That gap is the owner's decision, not an oversight: the free tier
 * exists (0 EUR, nothing to type) but it cannot buy a kie.ai film by itself; the smallest pack (5 EUR, 10 credits)
 * takes it to 17, a 30-second Short. The earlier FREE_FILMS (a film count turned into credits at the film's price)
 * is gone: it was built to keep the gift equal to a film, which is the one thing it must no longer be.
 * test/style-price.test.mjs pins both facts: gift < film, gift + smallest pack ≥ a 30 s Short.
 */
export const freeCreditsFor = (env: { FREE_CREDITS?: string }): number => Math.max(0, int(env.FREE_CREDITS, 0));

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
 * Whether this job's shots get FILMED — a video look AND the film product. The animatic of a realistic or animated
 * storyboard is drawn, so it takes the pictures card, never counts as a generated-video render, and orders no clip:
 * every place that used to ask isVideoStyle(styleOfJob(job)) about a JOB asks this instead.
 */
export function filmedJob(job: Pick<Job, "params">): boolean {
  try { const p = JSON.parse(job.params) as JobParams; return isVideoStyle(p.style) && !isAnimatic(p); } catch { return false; }
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
