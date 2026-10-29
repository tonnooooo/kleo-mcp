/**
 * KLEO STUDIO — THE VIDEO MODELS (13 October 2026).
 *
 * Kleo Studio is the consumer web app: a signed-in person chats with Kleo, attaches pictures and spends the same
 * credits the MCP server sells to generate single clips. Every model below is bought through ePhone AI's unified
 * async task API (POST /v1/task/submit, GET /v1/task/{id}; src/ephone.ts), the only provider Kleo uses since
 * 25 September 2026.
 *
 * THE PRICES were read from ePhone's public price list (GET https://platform.ephone.ai/api/pricing) on 13 October
 * 2026: the official per-second list price times the ratio of the channel group Kleo is routed to.
 *   Seedance 2.5        480p ¥0.67/s · 720p ¥1.51/s · 1080p ¥3.74/s   group bytedance ×0.9
 *   Seedance 2.0        480p ¥0.46/s · 720p ¥0.99/s · 1080p ¥2.48/s   group bytedance ×0.9
 *   Seedance 2.0 Fast   480p ¥0.37/s · 720p ¥0.80/s                   group bytedance ×0.9
 *   Veo 3.1             720p/1080p $0.40/s                           group gemini-official-cheap ×0.53
 *   Veo 3.1 Fast        720p/1080p $0.15/s                           group gemini-official-cheap ×0.53
 *   Kling 3.0 Omni      720p ¥0.9/s · 1080p ¥1.2/s (with a reference video, no sound)   group kling ×0.8
 *                       (19 October 2026: only for "copy this video's motion" — see videoRole "motion")
 *   Wan 3.0             480P ¥0.3/s · 720P ¥0.6/s · 1080P ¥1.2/s, with or without sound   group alibaba ×0.8
 *                       (29 October 2026, wan3.0-video, read from GET https://api.ephone.ai/api/pricing)
 * CNY is converted at 7 per dollar, a little under the market rate, so every figure here is an upper side.
 * Veo is routed to the official_cheap channel ONLY (see `routing`): the price below assumes it, and a Veo order that
 * found no such channel fails and is refunded instead of silently costing twice as much.
 *
 * THE CREDITS. One Kleo credit sells for 0.40-0.50 EUR (the packs in src/stripe.ts: 10 for 5 EUR, 35 for 15, 100 for
 * 40). A clip costs ceil(dollars × STUDIO_MARGIN / CREDIT_USD) credits, never less than one. CREDIT_USD is the value
 * of a credit in the biggest pack after Stripe's fee; the margin keeps a clip at roughly 1.6× its cost, the same
 * band the films are sold in (1.5-1.9×, 14 September 2026).
 *
 * Pure module (no Env, no fetch), so the tests import it directly under Node's type stripping.
 */

export type ModelKey = "seedance-2.5" | "seedance-2.0" | "seedance-2.0-fast" | "wan-3.0" | "veo-3.1" | "veo-3.1-fast" | "kling-3-omni";
export type Resolution = "480p" | "720p" | "1080p";
export type ImageRole = "first_frame" | "reference" | "none";
/**
 * What an attached video clip is for: guide the new clip (Seedance omni reference), be edited, be continued — or
 * "motion" (19 October 2026): with exactly one picture, the clip starts on the picture and moves the way the video
 * moves (its camera, its subject's motion, its pacing) while everything seen comes from the picture. Seedance cannot
 * take a first frame next to a reference video and copied the video's place instead; Kling 3.0 Omni can
 * (first_frame + feature_video).
 */
export type VideoRole = "reference" | "edit" | "extend" | "motion" | "none";

export interface StudioModel {
  key: ModelKey;
  /** What the person reads. */
  name: string;
  /** One line under the name in the picker. */
  blurb: string;
  /** Badge in the picker ("Best", "Cheapest", "Max quality"). */
  badge?: string;
  family: "seedance" | "veo" | "kling" | "wan";
  /** ePhone model id. */
  ephoneModel: string;
  /** Dollars per output second, per resolution (already times the channel ratio). */
  usdPerSecond: Partial<Record<Resolution, number>>;
  /** Seedance's lower rate when a reference video is attached (billed on reference + output seconds, 9 s minimum). */
  usdPerSecondRef?: Partial<Record<Resolution, number>>;
  /** Reference clips (video, audio) it takes; 0 = none. */
  maxRefVideos?: number;
  /** Longest total of reference video seconds. */
  maxRefVideoSeconds?: number;
  durations: number[];
  defaultDuration: number;
  resolutions: Resolution[];
  defaultResolution: Resolution;
  aspects: string[];
  /** Most reference pictures the model takes (0 = none). */
  maxReferences: number;
  /** ePhone channel routing headers for this model (src/ephone.ts EPHONE_ROUTING is the default). */
  routing?: Record<string, string>;
  /** The owner's own mark-up on top of the margin, per resolution (1 when absent). */
  creditFactor?: Partial<Record<Resolution, number>>;
  /** Used only for one job (Kling: a picture moving like a video); never offered in the model picker. */
  motionOnly?: boolean;
}

const CNY = 1 / 7;
const BYTEDANCE = 0.9;
const GEMINI_CHEAP = 0.53;
const KLING = 0.8;
const ALIBABA = 0.8;
const r4 = (n: number): number => Math.round(n * 10_000) / 10_000;

export const MODELS: StudioModel[] = [
  {
    key: "seedance-2.5", name: "Seedance 2.5", blurb: "Best all-round motion, with sound", badge: "Best",
    family: "seedance", ephoneModel: "doubao-seedance-2-5-260628",
    usdPerSecond: { "480p": r4(0.67 * BYTEDANCE * CNY), "720p": r4(1.51 * BYTEDANCE * CNY), "1080p": r4(3.74 * BYTEDANCE * CNY) },
    usdPerSecondRef: { "480p": r4(0.40 * BYTEDANCE * CNY), "720p": r4(0.91 * BYTEDANCE * CNY), "1080p": r4(2.24 * BYTEDANCE * CNY) },
    maxRefVideos: 10, maxRefVideoSeconds: 30,
    durations: [5, 10, 15], defaultDuration: 5, resolutions: ["480p", "720p", "1080p"], defaultResolution: "720p",
    aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], maxReferences: 9,
  },
  {
    key: "seedance-2.0", name: "Seedance 2.0", blurb: "Great quality for less",
    family: "seedance", ephoneModel: "doubao-seedance-2-0-260128",
    usdPerSecond: { "480p": r4(0.46 * BYTEDANCE * CNY), "720p": r4(0.99 * BYTEDANCE * CNY), "1080p": r4(2.48 * BYTEDANCE * CNY) },
    usdPerSecondRef: { "480p": r4(0.28 * BYTEDANCE * CNY), "720p": r4(0.60 * BYTEDANCE * CNY), "1080p": r4(1.51 * BYTEDANCE * CNY) },
    maxRefVideos: 3, maxRefVideoSeconds: 15,
    durations: [5, 10, 15], defaultDuration: 5, resolutions: ["480p", "720p", "1080p"], defaultResolution: "720p",
    aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], maxReferences: 9,
  },
  {
    // 29 October 2026: no longer the cheapest (Wan 3.0 costs less at every resolution), so its badge went to Wan 3.0.
    key: "seedance-2.0-fast", name: "Seedance 2.0 Fast", blurb: "Quick and light, great for drafts",
    family: "seedance", ephoneModel: "doubao-seedance-2-0-fast-260128",
    usdPerSecond: { "480p": r4(0.37 * BYTEDANCE * CNY), "720p": r4(0.80 * BYTEDANCE * CNY) },
    usdPerSecondRef: { "480p": r4(0.22 * BYTEDANCE * CNY), "720p": r4(0.48 * BYTEDANCE * CNY) },
    maxRefVideos: 3, maxRefVideoSeconds: 15,
    durations: [5, 10, 15], defaultDuration: 5, resolutions: ["480p", "720p"], defaultResolution: "720p",
    aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], maxReferences: 9,
    // 15 October 2026, the owner: "Seedance 2.0 Fast mettimi 2 crediti invece di uno su 480p". 480p doubles (5 s = 2,
    // 10 s = 4, 15 s = 6) and 720p goes up by half (3, 6, 9), so 720p still costs more than 480p.
    creditFactor: { "480p": 2, "720p": 1.5 },
  },
  {
    // 29 October 2026, the owner: "Aggiungi Wan a Kleo". Alibaba's Wan 3.0 on ePhone, in the picker like the others:
    // text, a first frame or up to 10 reference pictures, with sound. ePhone takes 2-30 s; the picker offers Seedance's
    // lengths. WaveSpeed sells the same model about 38% dearer, so it is no backup (backups.ts): it stays the road of
    // the copyright second chance below, which a Wan clip never gets.
    key: "wan-3.0", name: "Wan 3.0", blurb: "Lifelike motion with sound, for less", badge: "Cheapest",
    family: "wan", ephoneModel: "wan3.0-video",
    usdPerSecond: { "480p": r4(0.3 * ALIBABA * CNY), "720p": r4(0.6 * ALIBABA * CNY), "1080p": r4(1.2 * ALIBABA * CNY) },
    durations: [5, 10, 15], defaultDuration: 5, resolutions: ["480p", "720p", "1080p"], defaultResolution: "720p",
    aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], maxReferences: 10,
  },
  {
    key: "veo-3.1", name: "Google Veo 3.1", blurb: "Maximum quality, cinematic, native audio", badge: "Max quality",
    family: "veo", ephoneModel: "veo-3.1-generate-preview",
    usdPerSecond: { "720p": r4(0.40 * GEMINI_CHEAP), "1080p": r4(0.40 * GEMINI_CHEAP) },
    durations: [4, 6, 8], defaultDuration: 8, resolutions: ["720p", "1080p"], defaultResolution: "1080p",
    aspects: ["16:9", "9:16"], maxReferences: 3,
    routing: { "X-Provider-Order": "official_cheap", "X-Provider-Only": "true" },
  },
  {
    key: "veo-3.1-fast", name: "Veo 3.1 Fast", blurb: "The Veo look, faster and cheaper",
    family: "veo", ephoneModel: "veo-3.1-fast-generate-preview",
    usdPerSecond: { "720p": r4(0.15 * GEMINI_CHEAP), "1080p": r4(0.15 * GEMINI_CHEAP) },
    durations: [4, 6, 8], defaultDuration: 8, resolutions: ["720p", "1080p"], defaultResolution: "1080p",
    aspects: ["16:9", "9:16"], maxReferences: 3,
    routing: { "X-Provider-Order": "official_cheap", "X-Provider-Only": "true" },
  },
  {
    key: "kling-3-omni", name: "Kling 3.0", blurb: "Your picture, moving like your video", badge: "Motion",
    family: "kling", ephoneModel: "kling-3.0-omni/omni-video",
    usdPerSecond: { "720p": r4(0.9 * KLING * CNY), "1080p": r4(1.2 * KLING * CNY) },
    maxRefVideos: 1, maxRefVideoSeconds: 15,
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], defaultDuration: 5, resolutions: ["720p", "1080p"], defaultResolution: "1080p",
    aspects: ["16:9", "9:16", "1:1"], maxReferences: 1, motionOnly: true,
  },
];

export const DEFAULT_MODEL: ModelKey = "seedance-2.5";
export const modelByKey = (key: string | null | undefined): StudioModel | null => MODELS.find((m) => m.key === key) ?? null;

/** Value of one credit in dollars (100 credits for 40 EUR, about 46 $, less Stripe's fee). */
export const CREDIT_USD = 0.44;
/** What a clip is sold at over its cost. */
export const DEFAULT_MARGIN = 1.6;

/**
 * THE VIDEO PRICE FACTOR (25 October 2026, the owner: "alza il costo dei template e delle creazioni video … da 6 crediti
 * per 480p fai 10, stessa cosa con le altre risoluzioni"). Every video clip, and every template run (src/studio/tools.ts),
 * costs its credits from the margin above times this factor, rounded up: 6 becomes 10, 3 becomes 5, 11 becomes 19.
 * The apps that make a video take it too (tools.ts toolFactor). Pictures, sounds and Kleo films keep their price. It is STUDIO_VIDEO_FACTOR in wrangler.studio.jsonc,
 * written as a fraction ("5/3") so that 6 × 5/3 is exactly 10; unset, malformed, under 1 or over 10 means no change.
 */
export function videoFactor(raw: string | undefined): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?\s*$/.exec(raw ?? "");
  if (!m) return 1;
  const f = Number(m[1]) / (m[2] ? Number(m[2]) : 1);
  return Number.isFinite(f) && f >= 1 && f <= 10 ? f : 1;
}
/** Credits times the video factor, rounded up (the small epsilon keeps 6 × 5/3 at 10, not 11). */
export const raiseCredits = (credits: number, factor = 1): number =>
  (factor === 1 ? credits : Math.max(1, Math.ceil(credits * factor - 1e-9)));

/** The settings of one clip after they were checked against the model. */
export interface ClipSettings {
  model: ModelKey;
  duration: number;
  resolution: Resolution;
  aspect: string;
  audio: boolean;
  imageRole: ImageRole;
  /** Only with attached video clips (Seedance). Older rows have none: read as "none". */
  videoRole?: VideoRole;
}

/** What is attached to a clip, by kind (pictures, video clips, sound clips) and the total seconds of the clips. */
export interface RefCounts { images: number; videos: number; audios: number; videoSeconds: number }
export const noRefs = (images = 0): RefCounts => ({ images, videos: 0, audios: 0, videoSeconds: 0 });

/** Closest allowed value (ties go to the larger one). */
function nearest(values: number[], want: number): number {
  return values.reduce((best, v) => (Math.abs(v - want) < Math.abs(best - want) || (Math.abs(v - want) === Math.abs(best - want) && v > best) ? v : best), values[0]);
}

/**
 * Whatever the page or the agent asked, made valid for the model: an unknown model becomes the default one, a
 * duration snaps to the nearest one the model offers, a resolution or an aspect it does not offer becomes its
 * default. Never throws: a clip is always priced on the settings that will actually be sent.
 */
export function normalizeSettings(raw: Partial<Record<keyof ClipSettings, unknown>>, imageCount: number, refs: RefCounts = noRefs(imageCount)): ClipSettings {
  let m = modelByKey(String(raw.model ?? "")) ?? modelByKey(DEFAULT_MODEL)!;
  // "Move my picture like this video": one picture, one video, no sound clip — Kling 3.0 Omni, whatever was picked.
  const motion = raw.videoRole === "motion" && imageCount === 1 && refs.videos === 1 && refs.audios === 0;
  if (motion) m = modelByKey("kling-3-omni")!;
  else if (m.motionOnly) m = modelByKey(DEFAULT_MODEL)!;
  // Video and sound clips are a Seedance feature; editing or extending a clip is Seedance 2.5's; a sound clip
  // alone (no picture, no video) only 2.5 accepts.
  const clips = refs.videos + refs.audios > 0;
  const wantsRole = raw.videoRole === "edit" || raw.videoRole === "extend";
  if (!motion) {
    if (clips && m.family !== "seedance") m = modelByKey("seedance-2.5")!;
    if (refs.videos > 0 && wantsRole) m = modelByKey("seedance-2.5")!;
    if (refs.audios > 0 && refs.videos === 0 && imageCount === 0) m = modelByKey("seedance-2.5")!;
    if (refs.videos > (m.maxRefVideos ?? 0)) m = modelByKey("seedance-2.5")!;
  }
  const d = Number(raw.duration);
  const duration = Number.isFinite(d) && d > 0 ? nearest(m.durations, d) : m.defaultDuration;
  const resolution = m.resolutions.includes(raw.resolution as Resolution) ? (raw.resolution as Resolution) : m.defaultResolution;
  const aspect = m.aspects.includes(String(raw.aspect)) ? String(raw.aspect) : "16:9";
  // The copy is exactly as long as the clip it copies (19 October 2026, the first live test): a 3.8 s clip asked for
  // 5 s, and Kling ran out of movement and started it again — the car landed back on the ice after taking off.
  if (motion) {
    const fit = refs.videoSeconds > 0 ? Math.max(3, Math.min(15, Math.round(refs.videoSeconds))) : duration;
    return { model: m.key, duration: fit, resolution, aspect, audio: false, imageRole: "first_frame", videoRole: "motion" };
  }
  let imageRole: ImageRole = raw.imageRole === "reference" || raw.imageRole === "first_frame" ? (raw.imageRole as ImageRole) : imageCount === 1 ? "first_frame" : "reference";
  if (imageCount === 0) imageRole = "none";
  // One picture can be the opening frame; more than one can only guide the look.
  if (imageCount > 1 && imageRole === "first_frame") imageRole = "reference";
  if (imageRole === "reference" && m.maxReferences === 0) imageRole = "first_frame";
  // Omni reference mode (clips attached) cannot take a first frame: the pictures guide the look instead.
  if (clips && imageRole === "first_frame") imageRole = "reference";
  const videoRole: VideoRole = refs.videos === 0 ? "none" : wantsRole ? (raw.videoRole as VideoRole) : "reference";
  return { model: m.key, duration, resolution, aspect, audio: raw.audio === false ? false : true, imageRole, videoRole };
}

/** Dollars the provider charges for one clip (an upper estimate: list price × channel ratio, CNY at 7). */
export function clipCostUsd(s: ClipSettings, refVideoSeconds = 0): number {
  const m = modelByKey(s.model)!;
  if (refVideoSeconds > 0 && m.usdPerSecondRef) {
    // Billed on the reference seconds plus the output, never under 9 s; an edit comes out as long as its source.
    const out = s.videoRole === "edit" ? refVideoSeconds : s.duration;
    const perS = m.usdPerSecondRef[s.resolution] ?? Math.max(...Object.values(m.usdPerSecondRef).map(Number));
    return Math.round(perS * Math.max(9, refVideoSeconds + out) * 1000) / 1000;
  }
  const perS = m.usdPerSecond[s.resolution] ?? Math.max(...Object.values(m.usdPerSecond).map(Number));
  return Math.round(perS * s.duration * 1000) / 1000;
}

/** Credits one clip costs the person. */
export function clipCredits(s: ClipSettings, margin = DEFAULT_MARGIN, refVideoSeconds = 0, video = 1): number {
  const factor = modelByKey(s.model)?.creditFactor?.[s.resolution] ?? 1;
  return raiseCredits(Math.max(1, Math.ceil((clipCostUsd(s, refVideoSeconds) * margin * factor) / CREDIT_USD - 1e-9)), video);
}

/**
 * The resolutions an account that never paid may use (15 October 2026, the owner: a 5-second 720p clip of Seedance 2.0
 * Fast costs about $0.52 and the gift paid for two of them; free credits now make 480p, the rest unlocks with a pack).
 * STUDIO_FREE_RESOLUTIONS: comma separated, or "*" for all.
 */
export function freeResolutions(list: string | undefined): Resolution[] {
  const raw = (list ?? "480p").trim();
  const all: Resolution[] = ["480p", "720p", "1080p"];
  if (raw === "*") return all;
  const out = raw.split(",").map((s) => s.trim()).filter((r): r is Resolution => (all as string[]).includes(r));
  return out.length ? out : ["480p"];
}

/** A free account's choice brought inside what it may use: the first resolution of the model it is allowed. */
export function clampFreeResolution(s: ClipSettings, free: Resolution[]): ClipSettings {
  if (free.includes(s.resolution)) return s;
  const ok = modelByKey(s.model)?.resolutions.find((r) => free.includes(r));
  return ok ? { ...s, resolution: ok } : s;
}

/**
 * Which models an account that never paid may use. The owner's rule of 15 September 2026: the provider is paid
 * with the owner's money, so gifted credits must not buy the expensive models. Free accounts get the cheapest one;
 * the first pack unlocks the rest. `list` is the STUDIO_FREE_MODELS var: comma separated keys, or "*" for all.
 */
export function freeModels(list: string | undefined): ModelKey[] {
  const raw = (list ?? "seedance-2.0-fast").trim();
  if (raw === "*") return MODELS.map((m) => m.key);
  return raw.split(",").map((s) => s.trim()).filter((k): k is ModelKey => !!modelByKey(k));
}

/**
 * The `input` of POST /v1/task/submit for one clip (schemas from the price list's task_input_schema, 13 Oct 2026).
 *   Seedance: text-to-video {prompt}, image-to-video {first_frame (+ prompt), aspect "adaptive"} or omni reference
 *             {reference_images[]}; duration 4-15 (2.5: 4-30); generate_audio; watermark false.
 *   Veo:      {prompt, images[1] first frame | reference_images[≤3], aspect 16:9|9:16, resolution, duration 4|6|8}.
 *   Wan 3.0:  (read 29 October 2026) two modes that never mix: {first_frame, prompt, …} or {prompt, reference_images[≤10],
 *             …}; resolution 480P|720P|1080P in capitals, ratio, duration 2-30, audio, watermark. No other field is
 *             allowed (additionalProperties false), so no safety identifier.
 * `images` are absolute URLs the provider can fetch (signed links to the person's uploads).
 */
export function taskInput(s: ClipSettings, prompt: string, images: string[], safetyId?: string, clips: { videos: string[]; audios: string[] } = { videos: [], audios: [] }): Record<string, unknown> {
  const m = modelByKey(s.model)!;
  const text = prompt.trim().slice(0, 2000);
  if (m.family === "kling") {
    // Kling 3.0 Omni: the picture is the first frame, the video a "feature video" (its camera and pacing), one shot.
    // The same test: the car tumbled and bent as it flew. The prompt now pins one continuous take that ends with the
    // reference, and a subject that keeps its shape (Kling reads the negative part from the same text).
    const guard = " One continuous take that ends exactly where the reference video ends: no cut, no jump back, no repeated action, no reset."
      + " The subject keeps its exact shape, size, proportions and design in every frame; it never bends, melts, morphs or breaks apart."
      + " Avoid: cuts, looping, deformation, extra vehicles or people, text.";
    const contents: Record<string, unknown>[] = [{ type: "prompt", text: (text + guard).slice(0, 2500) }];
    if (images[0]) contents.push({ type: "first_frame", url: images[0] });
    if (clips.videos[0]) contents.push({ type: "feature_video", url: clips.videos[0] });
    return { contents, settings: { resolution: s.resolution, aspect_ratio: s.aspect, duration: s.duration, audio: "off", multi_shot: false } };
  }
  if (m.family === "veo") {
    const input: Record<string, unknown> = {
      prompt: text, aspect_ratio: s.aspect === "9:16" ? "9:16" : "16:9", resolution: s.resolution,
      duration: s.duration, generate_audio: s.audio, person_generation: "allow_adult",
    };
    if (images.length && s.imageRole === "first_frame") input.images = [images[0]];
    else if (images.length && s.imageRole === "reference") input.reference_images = images.slice(0, m.maxReferences);
    return input;
  }
  if (m.family === "wan") {
    // ePhone's price rules match '480P' and '720P' exactly, on the request it builds from this input (as its Seedance
    // rules read the content[] it builds); any other spelling would be billed at the 1080P rate.
    const input: Record<string, unknown> = {
      prompt: text, resolution: s.resolution.toUpperCase(), ratio: s.aspect, duration: s.duration, audio: s.audio, watermark: false,
    };
    if (images.length && s.imageRole === "first_frame") {
      input.first_frame = images[0];
      // "adaptive" keeps the picture's own shape, as Seedance does with a first frame.
      input.ratio = "adaptive";
    } else if (images.length && s.imageRole === "reference") input.reference_images = images.slice(0, m.maxReferences);
    return input;
  }
  const input: Record<string, unknown> = {
    prompt: text, duration: s.duration, resolution: s.resolution, generate_audio: s.audio, watermark: false,
    aspect_ratio: s.aspect,
  };
  if (clips.videos.length || clips.audios.length) {
    // Omni reference: pictures, video clips and sound clips together ("image 1", "video 1", "audio 1" in the prompt).
    if (images.length) input.reference_images = images.slice(0, m.maxReferences);
    if (clips.videos.length) input.reference_videos = clips.videos.slice(0, m.maxRefVideos ?? 0);
    if (clips.audios.length) input.reference_audio = clips.audios.slice(0, m.key === "seedance-2.5" ? 10 : 3);
    if (m.key === "seedance-2.5") input.omni_reference_task_type = s.videoRole === "edit" || s.videoRole === "extend" ? s.videoRole : clips.videos.length ? "reference" : "auto";
    if (s.videoRole === "edit") { input.aspect_ratio = "adaptive"; input.duration = -1; }
    if (s.videoRole === "extend") input.aspect_ratio = "adaptive";
  } else if (images.length && s.imageRole === "first_frame") {
    input.first_frame = images[0];
    // Seedance 2.5 refuses any other ratio with a first frame: the clip keeps the picture's own shape.
    input.aspect_ratio = "adaptive";
  } else if (images.length && s.imageRole === "reference") {
    input.reference_images = images.slice(0, m.maxReferences);
  }
  if (safetyId) input.safety_identifier = safetyId.slice(0, 64);
  return input;
}

/**
 * THE PICTURES SEEDANCE TAKES (20 October 2026). ByteDance refuses a first frame or a reference picture whose sides are
 * not 300-6000 px, or whose sides differ by more than 2.5 times (ePhone's task_input_schema for every Seedance model:
 * "aspect ratio 0.4-2.5, 300-6000px per side", read 20 October 2026). It said so only after the order went out, as
 * "资源同步失败 … InvalidParameter.HeightTooSmall": a customer's five clips from 387x297 pictures all failed that way.
 * Pictures uploaded since are enlarged by the page (app.js fitPicture); this check stops an older one before any charge.
 * Wan 3.0 states looser limits of its own (29 October 2026: 240-8000 px per side, sides within 8:1). The other models
 * state no such limit, so their pictures pass.
 */
export const SEEDANCE_PICTURE = { minSide: 300, maxSide: 6000, maxRatio: 2.5 };
export const WAN_PICTURE = { minSide: 240, maxSide: 8000, maxRatio: 8 };
const PICTURE_LIMITS: Partial<Record<StudioModel["family"], typeof SEEDANCE_PICTURE>> = { seedance: SEEDANCE_PICTURE, wan: WAN_PICTURE };
/** Why `model` cannot take a picture of w×h pixels, as the sentence the person reads; null when it can (or the size is unknown). */
export function pictureProblem(modelName: string, family: StudioModel["family"], w: number | null | undefined, h: number | null | undefined): string | null {
  const limits = PICTURE_LIMITS[family];
  if (!limits || !w || !h || w <= 0 || h <= 0) return null;
  const { minSide, maxSide, maxRatio } = limits;
  // The shape first: a long, thin picture cannot be fixed by enlarging it.
  if (Math.max(w, h) / Math.min(w, h) > maxRatio + 1e-9) return `A picture is too tall or too wide for ${modelName} (${w}×${h} px): one side can be at most ${maxRatio} times the other. Crop it and add it again — nothing was charged.`;
  if (Math.min(w, h) < minSide) return `A picture is too small for ${modelName} (${w}×${h} px): it needs at least ${minSide} px on each side. Add it again and Kleo will enlarge it — nothing was charged.`;
  if (Math.max(w, h) > maxSide) return `A picture is too big for ${modelName} (${w}×${h} px): it takes at most ${maxSide} px on each side. Add it again and Kleo will shrink it — nothing was charged.`;
  return null;
}

/**
 * WAN 3.0, THE SECOND CHANCE AFTER A COPYRIGHT REFUSAL (20 October 2026).
 *
 * The owner's first customer had a KPop Demon Hunters clip refused by Seedance three times. ByteDance checks copyright
 * on its own servers, so every reseller of Seedance refuses the same clip. WaveSpeed's Alibaba Wan 3.0 route
 * (alibaba/wan-3.0/image-to-video, NOT the "-spicy" routes, which undress people unasked) animated the official poster
 * with Rumi, Mira and Zoey named in the prompt, clean, on 20 October.
 *
 * So a Seedance clip refused for copyright offers the person one more try on Wan 3.0, with the same prompt, pictures,
 * length, resolution, shape and sound, for the same credits the refused clip cost (they were given back). The person
 * chooses: "Use Wan 3.0" or "No thanks" (the owner, 20 October: "in modo tale da non perdere il cliente").
 *
 * Since 29 October 2026 Wan 3.0 is also a model of its own in the picker (MODELS, on ePhone). This second chance stays
 * on WaveSpeed: ePhone's Wan goes through Alibaba's own content check, which refused a famous face on 21 October
 * ("Green net check rejected image"), and WaveSpeed's does not. Both kinds of clip are stored under WAN_KEY; a second
 * chance has `from` in its settings and a "wavespeed:" task id, and is priced with wanCostUsd.
 *
 * Prices from WaveSpeed's price API (POST /api/v3/model/price, our account's 5% discount), 20 October 2026: $0.0475,
 * $0.095 and $0.19 a second at 480p, 720p and 1080p, with or without sound and whatever the input. Seedance on ePhone
 * costs $0.0476-$0.481 a second, so the same credits always cover it.
 *
 *   no picture          alibaba/wan-3.0/text-to-video       {prompt, aspect_ratio, duration, resolution, generate_audio}
 *   a first frame       alibaba/wan-3.0/image-to-video      {image, prompt, duration, resolution, generate_audio}
 *                                                           (no aspect: the clip keeps the picture's shape, as on Seedance)
 *   reference pictures  alibaba/wan-3.0/reference-to-video  {reference_images ≤ 10, prompt, aspect_ratio, …}
 *
 * Clips made with video or sound clips attached (Seedance's omni reference, edit, extend) get no offer.
 */
export const WAN_KEY = "wan-3.0";
export const WAN_NAME = "Wan 3.0";
const WAN_USD_PER_S: Record<Resolution, number> = { "480p": 0.0475, "720p": 0.095, "1080p": 0.19 };
const WAN_ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4"];

/** True when a clip with these settings may be made again on Wan 3.0. `clips`: the video and sound clips it was made with. */
export function wanOffered(s: Partial<ClipSettings> & { clips?: number }): boolean {
  const m = modelByKey(s.model);
  return !!m && m.family === "seedance" && (s.videoRole ?? "none") === "none" && !s.clips && !!s.resolution && !!WAN_USD_PER_S[s.resolution] && !!s.duration && s.duration >= 2 && s.duration <= 30;
}

/** What WaveSpeed charges for the clip on Wan 3.0. */
export const wanCostUsd = (s: ClipSettings): number => Math.round((WAN_USD_PER_S[s.resolution] ?? WAN_USD_PER_S["1080p"]) * s.duration * 10_000) / 10_000;
/** Credits for the clip on Wan 3.0 at WaveSpeed's price, worked out as every clip's are (clipCredits). */
export const wanCredits = (s: ClipSettings, margin = DEFAULT_MARGIN, video = 1): number =>
  raiseCredits(Math.max(1, Math.ceil((wanCostUsd(s) * margin) / CREDIT_USD - 1e-9)), video);

/**
 * WHERE A BUSY CLIP GOES (29 October 2026, the owner: "non deve più accadere, così abbiamo perso un cliente"; see
 * src/studio/generate.ts busyClipRetry). A clip its provider dropped for its own reasons, even after Kleo's unseen
 * retry, is offered one tap on a model that is working and never dearer than what the busy clip was priced at
 * (`budgetUsd`):
 *   a Seedance clip   Wan 3.0 on WaveSpeed: another provider and another maker, cheaper at every resolution, with the
 *                     same prompt, pictures, length, resolution, shape and sound (wanOffered, as after a copyright refusal);
 *   a Veo 3.1 clip    Veo 3.1 Fast, with the same settings.
 * Null for every other clip: Veo 3.1 Fast and Kling's motion copy have nothing cheaper that makes the same clip, and a
 * clip already on Wan 3.0 has nowhere else to go. For Wan the settings stay the busy clip's (wanOrder reads them).
 */
export function busySwitchClip(s: ClipSettings & { clips?: number }, budgetUsd: number): { model: string; settings: ClipSettings } | null {
  const m = modelByKey(s.model);
  const within = (usd: number): boolean => usd <= budgetUsd * 1.01 + 1e-9;
  if (m?.family === "seedance" && wanOffered(s) && within(wanCostUsd(s))) return { model: WAN_KEY, settings: s };
  if (m?.key === "veo-3.1") {
    const fast: ClipSettings = { ...s, model: "veo-3.1-fast" };
    return within(clipCostUsd(fast)) ? { model: fast.model, settings: fast } : null;
  }
  return null;
}

/** The WaveSpeed order for the clip on Wan 3.0: its model slug and its inputs. `images` are links WaveSpeed can fetch. */
export function wanOrder(s: ClipSettings, prompt: string, images: string[]): { slug: string; body: Record<string, unknown> } {
  const base = { prompt: prompt.trim().slice(0, 2000) || "Bring this picture to life with natural, cinematic motion.", duration: s.duration, resolution: s.resolution, generate_audio: s.audio !== false };
  const aspect = WAN_ASPECTS.includes(s.aspect) ? s.aspect : s.aspect === "9:21" ? "9:16" : "16:9";
  if (images.length && s.imageRole === "first_frame") return { slug: "alibaba/wan-3.0/image-to-video", body: { ...base, image: images[0] } };
  if (images.length) return { slug: "alibaba/wan-3.0/reference-to-video", body: { ...base, reference_images: images.slice(0, 10), aspect_ratio: aspect } };
  return { slug: "alibaba/wan-3.0/text-to-video", body: { ...base, aspect_ratio: aspect } };
}

/** The catalog the page draws its picker from (no provider names, no costs in dollars). */
export function publicCatalog(margin = DEFAULT_MARGIN, free: ModelKey[] = [], video = 1): unknown[] {
  return MODELS.map((m) => ({
    key: m.key, name: m.name, blurb: m.blurb, badge: m.badge ?? null, family: m.family, motionOnly: !!m.motionOnly,
    durations: m.durations, defaultDuration: m.defaultDuration, resolutions: m.resolutions,
    defaultResolution: m.defaultResolution, aspects: m.aspects, maxReferences: m.maxReferences,
    free: free.includes(m.key),
    // Credits for every duration × resolution, so the page prices a clip without a round trip.
    prices: Object.fromEntries(m.resolutions.map((res) => [res, Object.fromEntries(m.durations.map((d) => [d, clipCredits({ model: m.key, duration: d, resolution: res, aspect: "16:9", audio: true, imageRole: "none" }, margin, 0, video)]))])),
  }));
}
