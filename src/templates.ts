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
}

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
    description: "Calm narration across chapters, one drawn picture per shot and a camera that drifts slowly over it. History, science, true stories.", voices: EN_IT },
  { id: "top-10", name: "Top 10", formats: ["16:9"], minSeconds: 360, maxSeconds: 600, defaultSeconds: 420,
    description: "A countdown: one entry per scene, its number spoken and picked out in the caption, hard cuts between entries.", voices: EN_IT },
  { id: "viral-short", name: "Viral Short", formats: ["9:16"], minSeconds: 30, maxSeconds: 60, defaultSeconds: 45,
    description: "Hook in the first two seconds, big word-by-word captions, a cut every 2–3 seconds. The default for any Short.", voices: EN_IT },
  { id: "reddit-story", name: "Reddit Story", formats: ["9:16"], minSeconds: 45, maxSeconds: 90, defaultSeconds: 60,
    description: "The post read aloud as a story, a picture per shot cut on the words, big captions. Paste the post text in the prompt.", voices: EN_IT },
  { id: "motivational", name: "Motivational", formats: ["9:16", "16:9"], minSeconds: 30, maxSeconds: 90, defaultSeconds: 60,
    description: "One line held per scene, a picture drawn for each and the camera pushing slowly in, music underneath throughout.", voices: EN_IT },
  { id: "explainer", name: "Explainer / Tutorial", formats: ["16:9"], minSeconds: 240, maxSeconds: 480, defaultSeconds: 300,
    description: "One idea per scene, built in the order the voice explains it, with a recap at the end.", voices: EN_IT },
  { id: "weekly-news", name: "Weekly News", formats: ["16:9"], minSeconds: 180, maxSeconds: 300, defaultSeconds: 240,
    description: "Four stories, each opening on its headline, hard cuts between segments.", voices: EN_IT },
  { id: "cinematic-trailer", name: "Cinematic Trailer", formats: ["16:9"], minSeconds: 60, maxSeconds: 90, defaultSeconds: 75,
    description: "Short scenes, a beat of silence before the last line, and the title held at the end.", voices: EN_IT },
  { id: "product-review", name: "Product Review", formats: ["16:9"], minSeconds: 240, maxSeconds: 360, defaultSeconds: 300,
    description: "The product in every shot, one claim per scene, and the verdict last.", voices: EN_IT },
  // The explainer look (kleo_style "explainer"): one drawing per phrase, karaoke captions, a camera
  // that only pushes in. Two rows because the two lengths are different films: a Short is one idea
  // told in under a minute — past that people stop following — and a video is a subject with chapters.
  { id: "explainer-short", name: "Explainer Short (drawn)", formats: ["9:16"], minSeconds: 20, maxSeconds: 60, defaultSeconds: 45,
    description: "Hand-drawn white line art on black. One picture for every phrase, a hard hook in the first second, karaoke captions. Under a minute on purpose.", voices: EN_IT },
  { id: "explainer-long", name: "Explainer Video (drawn)", formats: ["16:9"], minSeconds: 180, maxSeconds: 480, defaultSeconds: 300,
    description: "The same drawn look across a full subject: chapters, one picture per phrase, and a camera that never stops moving. Landscape.", voices: EN_IT },
  { id: "did-you-know", name: "Did You Know", formats: ["9:16"], minSeconds: 20, maxSeconds: 40, defaultSeconds: 30,
    description: "One fact per scene, karaoke captions, the image changes on every sentence.", voices: EN_IT },
];

export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id) as [string, ...string[]];
export const findTemplate = (id: string): Template | undefined => TEMPLATES.find((t) => t.id === id);

/**
 * What one credit buys is NOT the same in every style, because what a style costs on a rented GPU differs by an
 * order of magnitude. Measured 10-11 September 2026 on an RTX 4090: a 40 s Short whose shots are still pictures
 * costs $0.067 of rental; the same Short with generated motion costs about $0.50, because every shot is roughly two
 * minutes of card. Selling both for one credit means the second is sold at a seventh of its price — and, worse, the
 * two free credits a new account is given would then buy a full dollar of GPU, which is the entire daily budget
 * (DAILY_GPU_BUDGET_USD) spent by one stranger.
 *
 * So the multiplier follows the dollar. Every style that draws still pictures, or draws itself live, is 1.
 * A style that generates motion is 7, which also puts it out of reach of the free credits by construction — the
 * same thing that already keeps long videos out of the free tier.
 *
 * 7 is the TYPICAL cost, not the ceiling: measured 11 September, about a quarter of generated clips come back frozen
 * and have to be regenerated with another seed, and the generator gives up after two attempts per shot. So the worst
 * case is three times the base, around 10 credits' worth of GPU, and the price is charged up front at the typical
 * figure. What bounds the bad day is not the price list but DAILY_GPU_BUDGET_USD, which is exactly what it is for.
 */
export const STYLE_CREDITS: Record<string, number> = {
  cartoon: 1,     // AI pictures + Ken Burns
  realistic: 1,   // idem, cinematic look — becomes ~7 the day its shots are generated video, not pictures
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
export const VIDEO: Machine = { minVramGb: 32, minComputeCap: 800, maxDph: 0.90 };

export const STYLE_MACHINE: Record<string, Machine> = {
  cartoon: PICTURES,    // Stable Diffusion 1.5, about 6 GB
  realistic: PICTURES,  // becomes VIDEO the day Wan 2.2 draws its shots
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

export function jobTimeoutMin(env: Env, job: Pick<Job, "params">): number {
  let seconds = 0;
  try { seconds = (JSON.parse(job.params) as JobParams).duration_s; } catch { /* an unreadable row just gets the flat value */ }
  return Math.max(int(env.JOB_TIMEOUT_MIN, 60), etaFor(seconds) + int(env.LOADING_TIMEOUT_MIN, 35));
}
