/**
 * THE EYES (24 September 2026): a vision model on Workers AI that looks at a picture and answers yes/no questions
 * about it, or describes it.
 *
 * Until this module Kleo never looked at what it drew. A still was accepted when its file was not empty: the brunette
 * in a red apron who replaced the blonde pastry chef in lilac, the man's face in a film whose only character was a
 * hand, the hero in the villain's clothes — all were delivered, and QA_PASS said so. Now every still is asked, one
 * atomic question per requirement it claims (src/spec.ts visualChecks), and a picture that fails a must is drawn again
 * with the failure named in its prompt (src/stills.ts).
 *
 * Measured on 24 September on a FLUX.2 klein still of the pastry chef (eight questions, one of them a trap — "three
 * tiers" on a two-tier cake): llama-4-scout answered all eight right in 2.6 s for about 2,100 tokens (≈ $0.0006);
 * gemma-4-26b and qwen3.8-27b reason first and ran out of tokens at 400 before answering. So the default is scout, with
 * the reasoning models usable through VISION_MODEL given room.
 *
 * Only imports plain TypeScript with type-only dependencies, so tests load it under Node's type stripping.
 */
import type { Env } from "./env";
import type { VisualCheck } from "./spec.ts";

export const DEFAULT_VISION_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
/** Questions asked in one call: enough for a shot with three characters, few enough that the answer stays one short object. */
export const QUESTIONS_PER_CALL = 14;
const VISION_TIMEOUT_MS = 60_000;

export interface VisionImage { bytes: Uint8Array; mime?: "image/png" | "image/jpeg" | "image/webp" }
interface AiRunner { run(model: string, inputs: Record<string, unknown>): Promise<unknown> }

export const visionModel = (env: Pick<Env, "VISION_MODEL">): string => env.VISION_MODEL || DEFAULT_VISION_MODEL;

/** Base64 of bytes without a Buffer (Workers and Node both have btoa); chunked so a 1 MB picture does not blow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(bin);
}
/** The mime type from the magic bytes: PNG, JPEG or WebP; JPEG when it cannot tell (the models read it anyway). */
export function mimeOf(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return "image/jpeg";
}
const dataUrl = (img: VisionImage) => `data:${img.mime ?? mimeOf(img.bytes)};base64,${toBase64(img.bytes)}`;

/** The text of a chat answer in any of the shapes Workers AI returns (response string/object, choices, output). */
export function answerText(res: unknown): string {
  const r = (res && typeof res === "object" ? res : {}) as Record<string, unknown>;
  if (typeof r.response === "string") return r.response;
  if (r.response && typeof r.response === "object") return JSON.stringify(r.response);
  if (Array.isArray(r.choices)) {
    const msg = (r.choices[0] as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined;
    if (typeof msg?.content === "string" && msg.content.trim()) return msg.content;
  }
  if (r.result && typeof r.result === "object") return answerText(r.result);
  return "";
}
/** The first JSON object in a text (fences, prose around it and trailing commas tolerated), or null. */
export function firstJson(text: string): Record<string, unknown> | null {
  const s = text.replace(/```(?:json)?/gi, "");
  const a = s.indexOf("{");
  if (a < 0) return null;
  let depth = 0;
  for (let i = a; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) {
      try { return JSON.parse(s.slice(a, i + 1).replace(/,\s*([}\]])/g, "$1")) as Record<string, unknown>; } catch { return null; }
    }
  }
  return null;
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); })]); }
  finally { if (t) clearTimeout(t); }
}

/** One vision call: the images first (in the order given), then the text. Returns the answer's text. */
export async function askVision(env: Pick<Env, "AI" | "VISION_MODEL">, images: VisionImage[], prompt: string, opts: { model?: string; maxTokens?: number } = {}): Promise<{ text: string; model: string; ms: number }> {
  const ai = env.AI as unknown as AiRunner | undefined;
  if (!ai) throw new Error("no Workers AI binding (env.AI)");
  const model = opts.model ?? visionModel(env);
  const content: Record<string, unknown>[] = [{ type: "text", text: prompt }, ...images.map((img) => ({ type: "image_url", image_url: { url: dataUrl(img) } }))];
  const t0 = Date.now();
  const res = await withTimeout(ai.run(model, { messages: [{ role: "user", content }], max_tokens: opts.maxTokens ?? 500, temperature: 0 }), VISION_TIMEOUT_MS, `vision call (${model})`);
  return { text: answerText(res), model, ms: Date.now() - t0 };
}

export interface JudgeResult {
  /** check id → "yes" | "no" | "?" (no answer). */
  answers: Record<string, "yes" | "no" | "?">;
  failed: VisualCheck[];
  /** Weighted pass rate, 0-1: a must check weighs 2, an unanswered one counts as failed. */
  score: number;
  /** Must checks that failed. */
  mustFailed: number;
  model: string;
  ms: number;
}

export function scoreAnswers(checks: readonly VisualCheck[], answers: Record<string, "yes" | "no" | "?">): { failed: VisualCheck[]; score: number; mustFailed: number } {
  let total = 0, got = 0, mustFailed = 0;
  const failed: VisualCheck[] = [];
  for (const c of checks) {
    const w = c.must ? 2 : 1;
    total += w;
    if (answers[c.id] === c.expect) got += w;
    else { failed.push(c); if (c.must) mustFailed++; }
  }
  return { failed, score: total ? got / total : 1, mustFailed };
}

const yesNo = (v: unknown): "yes" | "no" | "?" => {
  const s = String(v ?? "").trim().toLowerCase();
  return /^(yes|y|true|si|sì)\b/.test(s) ? "yes" : /^(no|n|false)\b/.test(s) ? "no" : "?";
};

/**
 * THE JUDGE. Asks every check about one picture, QUESTIONS_PER_CALL at a time, and scores the answers. `refs` are
 * reference pictures (a character sheet, the user's photo) shown AFTER the picture, for the identity questions; their
 * labels are the names the questions use ("reference image 1 shows Mara").
 */
export async function judgeImage(env: Pick<Env, "AI" | "VISION_MODEL">, image: VisionImage, checks: readonly VisualCheck[], refs: { label: string; image: VisionImage }[] = [], opts: { model?: string } = {}): Promise<JudgeResult> {
  const answers: Record<string, "yes" | "no" | "?"> = {};
  let ms = 0, model = opts.model ?? visionModel(env);
  const all = [...checks];
  for (let i = 0; i < all.length; i += QUESTIONS_PER_CALL) {
    const part = all.slice(i, i + QUESTIONS_PER_CALL);
    const keyOf = (j: number) => `q${j + 1}`;
    const refLine = refs.length ? `\nThe FIRST image is the picture to judge. ${refs.map((r, k) => `Image ${k + 2} is a reference: ${r.label}.`).join(" ")} Judge only the first image; use the references only to compare identity when a question asks.` : "";
    const prompt = `Look at the picture and answer each question strictly "yes" or "no", judging only what is actually visible. If something is only partly true, answer "no".${refLine}
Answer as ONE JSON object {${part.map((_, j) => `"${keyOf(j)}":"yes"|"no"`).join(",")}} and nothing else.
${part.map((c, j) => `${keyOf(j)}: ${c.question}`).join("\n")}`;
    try {
      const r = await askVision(env, [image, ...refs.map((x) => x.image)], prompt, { model: opts.model, maxTokens: 60 + 12 * part.length });
      ms += r.ms; model = r.model;
      const j = firstJson(r.text) ?? {};
      part.forEach((c, k) => { answers[c.id] = yesNo(j[keyOf(k)]); });
    } catch {
      part.forEach((c) => { answers[c.id] = "?"; });
    }
  }
  return { answers, ...scoreAnswers(checks, answers), model, ms };
}

/**
 * THE DESCRIPTION of a reference image the user gave: what a painter needs to draw the same character, object or place
 * again. Written once, when the image arrives (src/refs.ts), and folded into the spec.
 */
export async function describeImage(env: Pick<Env, "AI" | "VISION_MODEL">, image: VisionImage, role: "character" | "object" | "place" | "style" | null = null): Promise<string> {
  const what = role === "character"
    ? "Describe the main person or creature so an illustrator could draw exactly them again: apparent age, build, skin tone, face shape, hair (colour, length, style), eyes, facial hair, clothes (garments, colours, patterns), accessories, anything distinctive."
    : role === "object"
    ? "Describe the main object so an illustrator could draw exactly it again: kind, shape, proportions, materials, colours, markings, distinctive details."
    : role === "place"
    ? "Describe the place so an illustrator could draw it again: kind of place, architecture or landscape, materials, colours, light, time of day, distinctive details."
    : role === "style"
    ? "Describe the visual STYLE of the image so an illustrator could imitate it: medium (photo, 2D animation, 3D, painting), line, shading, palette, lighting, mood. Do not describe the content."
    : "Describe the image precisely: who or what is in it, how they look (colours, clothes, shapes), and the place.";
  const r = await askVision(env, [image], `${what} Write plain English, one paragraph, at most 90 words, facts only, no opinions.`, { maxTokens: 220 });
  return r.text.replace(/\s+/g, " ").trim().slice(0, 600);
}
