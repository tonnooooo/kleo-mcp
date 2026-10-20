/**
 * KLEO STUDIO — VIRAL TEMPLATES (20 October 2026, the owner: "fare esattamente gli stessi video" as ausar.ai).
 *
 * A template is a viral clip Kleo keeps (the "fixed video") with one to three seats. The person uploads a photo per
 * seat; Wan 3.0 video edit swaps each photo into its seat and keeps everything else: the room, the camera, every
 * movement and its timing, and the clip's own sound. This is the recipe ausar.ai's people-swap templates run, read
 * from its public pages on 19 October 2026: one shot, `alibaba/wan-3.0-prime/video-edit` on WaveSpeed, the photos as
 * reference images, and a long structured prompt (cast and seats, exact likeness, nothing of the original people,
 * the motion second by second, the scene, the style). Kleo uses the standard Wan 3.0 edit, which its sellers describe
 * as the same quality, slower and a third cheaper.
 *
 * What passes: photos of people, the customer's own face or a film character played by an actor. Disney and Pixar
 * renders are refused (WALL-E, EVE and the Captain were flagged on 19 October; Thomas Shelby went through on the 20th).
 *
 * PRICE (WaveSpeed's list, checked with its own price quote on 19 October 2026): the source clip's seconds, rounded up
 * and capped at 15, plus the output's seconds (the same length), at $0.05 / $0.10 / $0.20 a second for 480p / 720p /
 * 1080p. "You Talking Bout Me?" (14 s) costs $1.40 / $2.80 / $5.60.
 *
 * THE CATALOG (20 October 2026, the owner: "prendile tutte"): You Talking Bout Me, written here seat by seat, then the
 * templates imported from ausar.ai with their own fixed prompts (./trends-catalog.ts).
 *
 * Pure module (no Env, no fetch), so the tests import it directly under Node's type stripping.
 */

import { IMPORTED_TRENDS } from "./trends-catalog.ts";

export type TrendQuality = "480p" | "720p" | "1080p";

export interface TrendSeat {
  /** The upload field of this seat: person1, person2, … */
  key: string;
  /** The seat in two or three words, under its photo box on the page. */
  label: string;
  /** Who sits there, in a few words, for a template with its own fixed prompt (the imported ones). */
  hint?: string;
  /** Where the person sits, as the page and the prompt name it (templates whose prompt Kleo writes per seat). */
  where?: string;
  /** What the original person wears or carries, so nothing of it survives. */
  original?: string;
  /** What this seat does in the clip, second by second. */
  motion?: string;
  /** Seat colour on the page's seat guide. */
  color: string;
  /** Where the seat is on the guide picture, in percent of its width and height (when it was measured). */
  at?: [number, number];
}

export interface Trend {
  /** The app key: "trend-<slug>". */
  key: `trend-${string}`;
  name: string;
  blurb: string;
  tint: string;
  /** The fixed clip, public (WaveSpeed fetches it). */
  baseUrl: string;
  /** Its length in seconds. */
  baseSeconds: number;
  /** The clip looping on the app's card (its first 6 s at up to 1080p, with its "-p.mp4" → ".jpg" poster). */
  preview: string;
  /** A still of the fixed clip, with the seats marked on it by the page. */
  guide: string;
  seats: TrendSeat[];
  /** The room and the camera, to keep identical (templates whose prompt Kleo writes per seat). */
  scene?: string;
  /**
   * A fixed edit instruction ("Image 1", "Image 2", "Video 1"): the imported templates (./trends-catalog.ts). Every seat
   * then needs its photo, as on ausar.ai; without one, Kleo writes the prompt for the seats that have one (trendPrompt).
   */
  prompt?: string;
}

/** One imported template as the catalog stores it (./trends-catalog.ts). */
export interface CatalogTrend { slug: string; name: string; blurb: string; tint: string; seconds: number; seats: { key: string; label: string; hint: string; color: string }[]; prompt: string }

export const TRENDS_MEDIA = "https://media.kleooai.com/app/templates";
/** Every seat needs a photo when the template brings its own prompt. */
export const trendNeedsAllSeats = (t: Pick<Trend, "prompt">): boolean => !!t.prompt;
/** WaveSpeed's Wan 3.0 video edit: dollars per billed second (source + output). */
export const WAN30_EDIT_USD_PER_S: Record<TrendQuality, number> = { "480p": 0.05, "720p": 0.10, "1080p": 0.20 };
export const WAN30_EDIT_MODEL = "alibaba/wan-3.0/video-edit";
export const TREND_QUALITIES: TrendQuality[] = ["480p", "720p", "1080p"];
export const DEFAULT_TREND_QUALITY: TrendQuality = "720p";

const fromCatalog = (c: CatalogTrend): Trend => ({
  key: `trend-${c.slug}`, name: c.name, blurb: c.blurb, tint: c.tint,
  baseUrl: `${TRENDS_MEDIA}/${c.slug}/base.mp4`, baseSeconds: c.seconds,
  preview: `${TRENDS_MEDIA}/${c.slug}/preview3-p.mp4`, guide: `${TRENDS_MEDIA}/${c.slug}/guide.jpg`,
  seats: c.seats, prompt: c.prompt,
});

export const TRENDS: Trend[] = [
  {
    key: "trend-you-talking-bout-me", name: "You Talking Bout Me?", blurb: "Put up to three friends in this viral clip", tint: "#bf5af2",
    baseUrl: `${TRENDS_MEDIA}/you-talking-bout-me/base.mp4`, baseSeconds: 14,
    preview: `${TRENDS_MEDIA}/you-talking-bout-me/preview3-p.mp4`, guide: `${TRENDS_MEDIA}/you-talking-bout-me/guide.jpg`,
    scene: "Same counter with the white tabletop, phones and small objects on it, wooden wall panel with the \"SHAPED BY TRADITION\" lettering, red-and-white striped flag, dark ceiling lights, screens and the \"RULES\" sign in the background. Same low handheld camera angle, same slight shake and movement, same framing, focus and depth of field, same warm indoor lighting.",
    seats: [
      { key: "person1", label: "Front, right", where: "in the FRONT on the right, closest to the camera, large in the frame, talking and laughing the most",
        original: "no black cap, no black T-shirt, no diamond chain, no iced-out watch",
        motion: "0-4s leans toward the camera, talking and smiling widely, then laughing; 4-6s turns away, laughs and covers the mouth with a hand; 6-9s gestures with an open hand while talking to the person in the middle; 9-11s laughs and turns the head away, a hand at the face; 11-14s leans out of the frame on the right, then points toward the people at the counter",
        color: "#bf5af2", at: [72, 62] },
      { key: "person2", label: "Middle", where: "in the MIDDLE, sitting at the counter between the front person and the far person, watching and reacting, talking near the end",
        original: "no grey printed T-shirt, no braids",
        motion: "sits at the counter watching the front person, reacting with the face and raising a hand at about 3s; looks over at the front person while he talks; 11-14s talks, gesturing with both hands at the chest",
        color: "#0a84ff", at: [47, 80] },
      { key: "person3", label: "Far left", where: "FURTHEST from the camera, on the left, sitting at the counter and mostly looking down at a phone",
        original: "no red patterned shirt, no blond twisted hair",
        motion: "sits at the counter, looking down at a phone in the hands most of the time, glancing up briefly",
        color: "#30d158", at: [34, 80] },
    ],
  },
  ...IMPORTED_TRENDS.map(fromCatalog),
];

export const trendByKey = (key: string | null | undefined): Trend | null => TRENDS.find((t) => t.key === key) ?? null;
export const isTrendKey = (key: string | null | undefined): boolean => !!trendByKey(key);

/** Seconds WaveSpeed bills for one run: the source rounded up and capped at 15, plus an output just as long. */
export function trendBilledSeconds(t: Pick<Trend, "baseSeconds">): number {
  const source = Math.min(15, Math.max(1, Math.ceil(t.baseSeconds - 1e-6)));
  return source * 2;
}
export const trendQuality = (q: string | undefined): TrendQuality => (TREND_QUALITIES.includes(q as TrendQuality) ? (q as TrendQuality) : DEFAULT_TREND_QUALITY);
export function trendCostUsd(t: Pick<Trend, "baseSeconds">, q: TrendQuality): number {
  return Math.round(trendBilledSeconds(t) * WAN30_EDIT_USD_PER_S[q] * 1000) / 1000;
}

const ORDINAL = ["Image 1", "Image 2", "Image 3"];

/**
 * The edit instruction for the seats that have a photo, in seat order (Image 1 is the first filled seat). A seat
 * without a photo keeps its original person. The structure is the one that came out clean on 20 October 2026.
 */
export function trendPrompt(t: Trend, filled: string[]): string {
  const seats = t.seats.filter((s) => filled.includes(s.key));
  const kept = t.seats.filter((s) => !filled.includes(s.key));
  const img = (s: TrendSeat) => ORDINAL[seats.indexOf(s)];
  const one = seats.length === 1;
  const who = one ? `the person from ${img(seats[0])}` : `the people from ${seats.map(img).join(", ").replace(/, ([^,]*)$/, " and $1")}`;
  const lines: string[] = [];
  lines.push(`Recreate Video 1 exactly, frame for frame, with a new cast: ${one ? "one person is" : `${seats.length} people are`} replaced by ${who}. Everything else stays identical to Video 1${kept.length ? ", including the other people" : ""}.`);
  lines.push("", "CAST (identification only, nothing of the original look is kept)");
  for (const s of seats) lines.push(`- ${img(s)} replaces the person ${s.where ?? ""}.`);
  for (const s of kept) lines.push(`- The person ${s.where ?? ""} stays exactly as in Video 1: the same face, hair, clothes and movements.`);
  lines.push("This mapping is fixed for the whole video. Each new person appears exactly once per frame, only in their own seat. No swapping, no merging, no sharing faces, hair or clothes.");
  lines.push("", "EXACT LIKENESS - THE MOST IMPORTANT RULE",
    "Each new person must look IDENTICAL to their reference image, as if they were really filmed in this scene. Copy everything 1:1 and change nothing:",
    "- FACE: the exact face shape, bone structure, eyes, eye colour, eyebrows, nose, lips, ears, jawline, marks and facial hair.",
    "- SKIN: the exact skin tone and skin texture.",
    "- HAIR: the exact hairstyle, length, colour and hairline.",
    "- BODY: the exact age, build and proportions.",
    "- OUTFIT: the exact garments, colours, patterns, fabrics and fit; parts not visible in the reference are completed in the same style.",
    "- ACCESSORIES: the exact headwear, glasses, jewellery and watches of the reference, and only those.",
    "- LOOK: if the reference is a real photo, the person is photorealistic; a stylised reference keeps its own style.",
    "Nothing is beautified, smoothed, simplified, recoloured or reinterpreted. Each new person looks exactly like their reference in every frame, also in close-ups, when laughing, when covering the face and when turned away.");
  lines.push("", "NOTHING FROM THE ORIGINAL PEOPLE");
  lines.push(`${seats.map((s) => s.original).filter(Boolean).join("; ")}; no original faces. The replaced people are only invisible motion and performance guides.`);
  lines.push("", "MOTION AND PERFORMANCE",
    "Every new person copies the exact movements, gestures, head turns, facial expressions, lip movement and timing of the person they replace, frame-accurately, adapted naturally to their own body:");
  for (const s of seats) if (s.motion) lines.push(`- ${img(s)}: ${s.motion}.`);
  lines.push("All lips move in perfect sync with the original speech and laughter, with natural expressions and eye movement.");
  lines.push("", "IDENTITY LOCK",
    "Each new person keeps exactly the same face, hair and outfit from the first frame to the last, also when partly out of frame, turned away or out of focus. No morphing, no drift back to the original people.");
  lines.push("", "NO NEW PEOPLE", "The number of people stays exactly the same, and no new people appear anywhere.");
  lines.push("", "SCENE AND CAMERA", `Identical to Video 1. ${t.scene ?? ""} One continuous shot, no cuts. No new objects, no new text.`.replace("  ", " "));
  lines.push("", "STYLE",
    "Natural handheld footage, looking like it was really filmed there. Each new person is lit naturally by the room's light with matching shadows. Anatomically correct hands with five fingers. No beauty filter, no skin smoothing, no over-sharpening, no face flicker, no morphing, no distorted faces in the background.");
  return lines.join("\n");
}

/** The WaveSpeed input of one run. `photos` are the filled seats' links, in seat order (all of them for a fixed prompt). */
export function trendTaskInput(t: Trend, filled: string[], photos: string[], q: TrendQuality): Record<string, unknown> {
  return {
    prompt: t.prompt ?? trendPrompt(t, filled), video: t.baseUrl, reference_images: photos.slice(0, t.seats.length), resolution: q,
    // false keeps the clip's own sound on the result (WaveSpeed: "the source audio track is preserved").
    generate_audio: false, enable_prompt_expansion: false, seed: -1,
  };
}
