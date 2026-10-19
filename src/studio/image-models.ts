/**
 * KLEO STUDIO — THE IMAGE MODELS (13 October 2026).
 *
 * The owner left the choice open (his own Vast box or a provider's credits). Studio uses ePhone's unified task API,
 * the same road as the videos: an image arrives in 5-30 seconds with no machine to boot, so it fits a chat, and a
 * Vast backend can be added later behind the same catalog. One generation makes 1, 2 or 4 pictures; each picture is
 * one provider task (a "slot").
 *
 * THE PRICES (ePhone price list, 13 October 2026; CNY at 7 per dollar):
 *   Nano Banana Pro   gemini-3-pro-image       $120 per 1M image tokens; 1K/2K = 1120 tokens, 4K = 2000   × 0.53
 *   Nano Banana 2     gemini-3.1-flash-image   $60 per 1M; 1K 1120, 2K 1680, 4K 2520 tokens                × 0.53
 *   Nano Banana 2.1   gemini-nano-banana-2.1   $30 per 1M; 1K 1120, 2K 1680, 4K 3780 tokens, + its thinking   × 0.53
 *                     ($7.50 per 1M output; about 1,000 tokens allowed for). Added 18 October 2026, marked New.
 *   Seedream 5.0      doubao-seedream-5-0      ¥0.22 per picture                                          × 0.9
 *   FLUX.2 Pro        flux-2-pro               $0.03 first megapixel (+$0.015 each further one)           × 0.53
 * Gemini and FLUX are routed to the official_cheap channel only, like Veo, so the figures above hold.
 *
 * Pure module, imported directly by the tests.
 */
import { CREDIT_USD, DEFAULT_MARGIN } from "./models.ts";

export type ImageModelKey = "nano-banana-pro" | "nano-banana-2.1" | "nano-banana-2" | "seedream-5" | "flux-2-pro";
export type ImageQuality = "1K" | "2K" | "4K";

export interface ImageModel {
  key: ImageModelKey;
  name: string;
  blurb: string;
  badge?: string;
  ephoneModel: string;
  /** Dollars per picture, per quality. */
  usd: Partial<Record<ImageQuality, number>>;
  qualities: ImageQuality[];
  defaultQuality: ImageQuality;
  aspects: string[];
  /** Most reference pictures it takes. */
  maxReferences: number;
  routing?: Record<string, string>;
  /** Gemini: which spelling of the quality field goes first ("tier" = 1K/2K/4K, else medium/high/max). */
  qualityFirst?: "tier" | "word";
  /** The provider's schema has no output_format: send none. */
  noFormat?: boolean;
}

const CHEAP = { "X-Provider-Order": "official_cheap", "X-Provider-Only": "true" };
const r4 = (n: number): number => Math.round(n * 10_000) / 10_000;
const COMMON = ["1:1", "4:5", "3:4", "2:3", "9:16", "4:3", "3:2", "16:9", "21:9"];

export const IMAGE_MODELS: ImageModel[] = [
  {
    key: "nano-banana-pro", name: "Nano Banana Pro", blurb: "Google's best: text, faces, edits", badge: "Best",
    ephoneModel: "gemini-3-pro-image",
    usd: { "1K": r4(1120 * 120e-6 * 0.53), "2K": r4(1120 * 120e-6 * 0.53), "4K": r4(2000 * 120e-6 * 0.53) },
    qualities: ["1K", "2K", "4K"], defaultQuality: "2K", aspects: COMMON, maxReferences: 14, routing: CHEAP,
  },
  {
    key: "nano-banana-2.1", name: "Nano Banana 2.1", blurb: "Google's newest: sharper, better text and faces", badge: "New",
    ephoneModel: "gemini-nano-banana-2.1",
    usd: { "1K": r4((1120 * 30e-6 + 0.0075) * 0.53), "2K": r4((1680 * 30e-6 + 0.0075) * 0.53), "4K": r4((3780 * 30e-6 + 0.0075) * 0.53) },
    qualities: ["1K", "2K", "4K"], defaultQuality: "2K", aspects: COMMON, maxReferences: 14, routing: CHEAP, qualityFirst: "tier", noFormat: true,
  },
  {
    key: "nano-banana-2", name: "Nano Banana 2", blurb: "Fast Google model, great value",
    ephoneModel: "gemini-3.1-flash-image",
    usd: { "1K": r4(1120 * 60e-6 * 0.53), "2K": r4(1680 * 60e-6 * 0.53), "4K": r4(2520 * 60e-6 * 0.53) },
    qualities: ["1K", "2K", "4K"], defaultQuality: "2K", aspects: COMMON, maxReferences: 14, routing: CHEAP,
  },
  {
    key: "seedream-5", name: "Seedream 5.0", blurb: "ByteDance, sharp and detailed", badge: "Cheapest",
    ephoneModel: "doubao-seedream-5-0-260128",
    usd: { "2K": r4(0.22 * 0.9 / 7) },
    qualities: ["2K"], defaultQuality: "2K", aspects: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"], maxReferences: 14,
  },
  {
    key: "flux-2-pro", name: "FLUX.2 Pro", blurb: "Photoreal, natural light",
    ephoneModel: "flux-2-pro",
    usd: { "1K": r4(0.03 * 0.53) },
    qualities: ["1K"], defaultQuality: "1K", aspects: COMMON, maxReferences: 8, routing: CHEAP,
  },
];

export const DEFAULT_IMAGE_MODEL: ImageModelKey = "nano-banana-2";

/**
 * PAUSED MODELS (15 October 2026). ePhone's Gemini image channel took orders, billed them and then could not hand the
 * pictures back ("invalid channel id"), after rejecting the documented quality tiers. A model listed in
 * STUDIO_PAUSED_IMAGE_MODELS stays in the picker, marked paused, takes no order (nothing is charged), and the default
 * moves to the first model that works. Remove it from the list to bring it back.
 */
export function pausedImageModels(list: string | undefined): ImageModelKey[] {
  return (list ?? "").split(",").map((s) => s.trim()).filter((k): k is ImageModelKey => !!imageModelByKey(k));
}
export function defaultImageModel(paused: ImageModelKey[]): ImageModelKey {
  if (!paused.includes(DEFAULT_IMAGE_MODEL)) return DEFAULT_IMAGE_MODEL;
  return (["flux-2-pro", "seedream-5", "nano-banana-2.1", "nano-banana-pro", "nano-banana-2"] as ImageModelKey[]).find((k) => !paused.includes(k)) ?? DEFAULT_IMAGE_MODEL;
}
/** The image model behind a provider model id (an app's task), or null. */
export const imageModelOfProvider = (ephoneModel: string): ImageModelKey | null => IMAGE_MODELS.find((m) => m.ephoneModel === ephoneModel)?.key ?? null;
/**
 * Gemini's quality field (15 October 2026): ePhone's gateway now takes auto|low|medium|high|xhigh|max, not the 1K/2K/4K
 * its own schema still lists. Our tiers map onto it.
 */
export const GEMINI_QUALITY: Record<ImageQuality, string> = { "1K": "medium", "2K": "high", "4K": "max" };
/**
 * The two spellings have each been refused at some point (the schema says 1K/2K/4K, the gateway took only
 * medium/high/max on 15 October). The first try uses the model's `qualityFirst`; a refusal that names the quality field
 * is retried once with the other spelling (src/studio/generate.ts), so a change on ePhone's side costs nobody a picture.
 */
export function geminiQuality(m: ImageModel, q: ImageQuality, other = false): string {
  const tier = (m.qualityFirst === "tier") !== other;
  return tier ? q : GEMINI_QUALITY[q] ?? "high";
}
export const isQualityRefusal = (message: string): boolean => /quality/i.test(message);
/** The other spelling of a Gemini quality value ("max" ↔ "4K"…), for the one retry a refusal earns (apps too). */
export function otherQualitySpelling(q: string): string {
  const pairs: Record<string, string> = { medium: "1K", high: "2K", max: "4K", "1K": "medium", "2K": "high", "4K": "max" };
  return pairs[q] ?? q;
}
export const IMAGE_COUNTS = [1, 2, 4];
export const imageModelByKey = (key: string | null | undefined): ImageModel | null => IMAGE_MODELS.find((m) => m.key === key) ?? null;

export interface ImageSettings { model: ImageModelKey; aspect: string; quality: ImageQuality; count: number }

export function normalizeImageSettings(raw: Partial<Record<keyof ImageSettings, unknown>>): ImageSettings {
  const m = imageModelByKey(String(raw.model ?? "")) ?? imageModelByKey(DEFAULT_IMAGE_MODEL)!;
  const aspect = m.aspects.includes(String(raw.aspect)) ? String(raw.aspect) : m.aspects.includes("1:1") ? "1:1" : m.aspects[0];
  const quality = m.qualities.includes(raw.quality as ImageQuality) ? (raw.quality as ImageQuality) : m.defaultQuality;
  const n = Number(raw.count);
  const count = IMAGE_COUNTS.includes(n) ? n : 1;
  return { model: m.key, aspect, quality, count };
}

export function imageCostUsd(s: ImageSettings): number {
  const m = imageModelByKey(s.model)!;
  return Math.round((m.usd[s.quality] ?? Math.max(...Object.values(m.usd).map(Number))) * s.count * 1000) / 1000;
}

export function imageCredits(s: ImageSettings, margin = DEFAULT_MARGIN): number {
  return Math.max(1, Math.ceil((imageCostUsd(s) * margin) / CREDIT_USD - 1e-9));
}

/** Image models a never-paid account may use (STUDIO_FREE_IMAGE_MODELS; default all but Nano Banana Pro). */
export function freeImageModels(list: string | undefined): ImageModelKey[] {
  const raw = (list ?? "nano-banana-2.1,nano-banana-2,seedream-5,flux-2-pro").trim();
  if (raw === "*") return IMAGE_MODELS.map((m) => m.key);
  return raw.split(",").map((s) => s.trim()).filter((k): k is ImageModelKey => !!imageModelByKey(k));
}

/** The `input` of one picture's task (schemas from the price list, 13 October 2026). */
export function imageTaskInput(s: ImageSettings, prompt: string, refs: string[], otherQuality = false): Record<string, unknown> {
  const m = imageModelByKey(s.model)!;
  const text = prompt.trim().slice(0, 4000);
  const images = refs.slice(0, m.maxReferences);
  if (m.key === "seedream-5") {
    const size: Record<string, string> = { "1:1": "2048x2048", "4:3": "2304x1728", "3:4": "1728x2304", "16:9": "2560x1440", "9:16": "1440x2560", "3:2": "2496x1664", "2:3": "1664x2496", "21:9": "3024x1296" };
    return { prompt: text, size: size[s.aspect] ?? "2K", n: 1, force_single: true, watermark: false, output_format: "jpeg", ...(images.length ? { images } : {}) };
  }
  if (m.key === "flux-2-pro") return { prompt: text, aspect_ratio: s.aspect, output_format: "jpeg", ...(images.length ? { images } : {}) };
  return { prompt: text, aspect_ratio: s.aspect, quality: geminiQuality(m, s.quality, otherQuality), ...(m.noFormat ? {} : { output_format: "jpeg" }), ...(images.length ? { images } : {}) };
}

export function publicImageCatalog(margin = DEFAULT_MARGIN, free: ImageModelKey[] = [], paused: ImageModelKey[] = []): unknown[] {
  return IMAGE_MODELS.map((m) => ({
    key: m.key, name: m.name, blurb: m.blurb, badge: m.badge ?? null, qualities: m.qualities, defaultQuality: m.defaultQuality, paused: paused.includes(m.key),
    aspects: m.aspects, maxReferences: m.maxReferences, free: free.includes(m.key), counts: IMAGE_COUNTS,
    prices: Object.fromEntries(m.qualities.map((q) => [q, Object.fromEntries(IMAGE_COUNTS.map((c) => [c, imageCredits({ model: m.key, aspect: "1:1", quality: q, count: c }, margin)]))])),
  }));
}
