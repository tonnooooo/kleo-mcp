/**
 * Shot pictures for the cartoon and realistic Kleo styles (Keou style "picture", docs/PICTURE-STYLE.md).
 *
 * POST /internal/jobs/:id/images (worker secret, empty body) → {"images": {"<pictureId>": "<signed /dl url>"}, "missing": [pictureIds]}
 *
 * - One picture per SHOT, keyed by its picture id `<sceneId>-s<n>` (keou-contract.ts pictureScenes flattens the
 *   storyboard in scene → shot order), generated once with Workers AI (env.AI) and stored under
 *   renders/<job>/img/<pictureId>.png|jpg (storage.ts putFile + db.ts setFile). A second call reuses what job_files lists.
 * - Model per style: vars IMAGE_MODEL_CARTOON / IMAGE_MODEL_REALISTIC (defaults below); the style suffix is appended here.
 * - Portrait (768x1344) or landscape (1344x768) by job format, for the models that accept a size (FLUX.1 schnell is square only).
 * - Two caps: MAX_PICTURES(duration) (24 for a Short, 48 for a long video) bounds the whole video, then IMAGE_SERVER_MAX
 *   (10, and 0 leaves every picture to the GPU) bounds what the SERVER draws, spread evenly over that list
 *   (pickImageScenes); everything else is answered as "missing" and drawn by the GPU worker. One attempt per picture (an
 *   "images.error" audit row marks the ones already tried) — except a transient failure (quota 4006, rate limit, 5xx, or
 *   a store hiccup after a successful draw), which only holds the picture back for TRANSIENT_RETRY_MIN so a later call
 *   still draws it. Failures, quota exhaustion and a missing AI binding are never fatal: the shot lands in "missing"
 *   and the engine paints an accent gradient.
 * - Dev/test hook: IMAGE_FIXTURE=1 → a deterministic placeholder PNG per picture id (flat colour from the id + a diagonal
 *   stripe), encoded here with CompressionStream("deflate"); no AI call.
 *
 * Only imports modules that are plain TypeScript with type-only dependencies, so test/images.test.mjs can load it
 * under Node's type stripping without bundling.
 */
import type { Env } from "./env";
import type { Job } from "./db";
import { setFile, listFiles, audit } from "./db.ts";
import { putFile } from "./storage.ts";
import { hmacHex, int, minutesSince } from "./util.ts";
import { kleoStyleOf, pictureScenes, PICTURE_STYLES, MAX_PICTURES, type KleoStyle } from "./keou-contract.ts";

/** The whole-video cap lives in the contract (the guide and the worker read the same rule); re-exported for the endpoint's callers. */
export { MAX_PICTURES };

/** Defaults (developers.cloudflare.com/workers-ai/models, pricing Sept 2026; 1,000 neurons = $0.011):
 *  cartoon   @cf/black-forest-labs/flux-1-schnell  4.8 neurons per 512² tile + 9.6 per step → 1024² at 4 steps ≈ 58 neurons (≈ $0.0006) per picture; square only.
 *  realistic @cf/leonardo/phoenix-1.0              530 neurons per 512² tile + 10 per step → 768x1344 at 20 steps ≈ 2,300 neurons (≈ $0.025) per picture.
 *  Cheaper realistic alternative: @cf/bytedance/stable-diffusion-xl-lightning (listed at $0.00 per step, beta). */
export const DEFAULT_IMAGE_MODELS: Record<"cartoon" | "realistic", string> = {
  cartoon: "@cf/black-forest-labs/flux-1-schnell",
  realistic: "@cf/leonardo/phoenix-1.0",
};
export const STYLE_SUFFIX: Record<"cartoon" | "realistic", string> = {
  cartoon: "flat vector cartoon illustration, bold clean outlines, vivid warm colors, simple shapes, no text, no letters",
  realistic: "cinematic photograph, 35mm lens, dramatic natural light, high detail, no text",
};
export const NEGATIVE_PROMPT = "text, letters, words, watermark, logo, signature, caption, subtitles, blurry, deformed";
/** Pictures the server itself draws per job (env IMAGE_SERVER_MAX); the worker draws the rest on the GPU. */
export const DEFAULT_SERVER_MAX = 10;
/** Signed picture links stay valid this long (the worker downloads them right away). */
const LINK_TTL_S = 6 * 60 * 60;
/** A transient failure (quota exhausted, rate limit, gateway hiccup) holds a picture back only this long. It is not the
 *  picture's one attempt: the model never saw a problem with THIS prompt, it said "not now", so a later call must draw
 *  it once the allocation is back instead of leaving one shot grey for the life of the video. Long enough that a worker
 *  retrying in a tight loop cannot burn the quota again and again. */
const TRANSIENT_RETRY_MIN = 10;

export type ImageFormat = "9:16" | "16:9";
export const sizeFor = (format: string): { width: number; height: number } => (format === "16:9" ? { width: 1344, height: 768 } : { width: 768, height: 1344 });
/** FLUX.1 [schnell] only takes prompt/steps/seed (1024² output); every other hosted model accepts width/height. */
export const acceptsSize = (model: string): boolean => !/flux-1-schnell/.test(model);
/** A picture is stored under its picture id: `img/<sceneId>-s<n>.png` (scene id ≤ 50 chars + "-s<n>" → 56 covers it). */
export const imageFileName = (pictureId: string, ext: "png" | "jpg") => `img/${pictureId}.${ext}`;
/** The ONE name rule for pictures: the store side writes it, dl.ts serves exactly what matches it. Two copies of this
 *  regex used to disagree on the length, so long scene ids were signed here and answered 404 there. */
export const IMAGE_NAME_RE = /^img\/[a-z0-9-]{1,56}\.(png|jpg)$/;

/** Picks up to `max` of the pictures the video asks for, spread evenly over it (never only the first ones). */
export function pickImageScenes<T>(scenes: T[], max: number): T[] {
  if (max <= 0) return [];
  if (scenes.length <= max) return scenes;
  if (max === 1) return [scenes[0]];
  const out: T[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i * (scenes.length - 1)) / (max - 1));
    if (!seen.has(idx)) { seen.add(idx); out.push(scenes[idx]); }
  }
  return out;
}

/* ------------------------------------------------------------------ tiny PNG encoder (fixture) */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const be32 = (n: number): Uint8Array => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);
function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  body.set(ascii(type), 0); body.set(data, 4);
  const out = new Uint8Array(12 + data.length);
  out.set(be32(data.length), 0); out.set(body, 4); out.set(be32(crc32(body)), 8 + data.length);
  return out;
}
async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate"); // zlib-wrapped deflate, as PNG wants
  const compressed = new Blob([raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}
/** Encodes an 8-bit RGB PNG; `rgb(x, y)` returns the pixel colour. */
export async function encodePng(width: number, height: number, rgb: (x: number, y: number) => [number, number, number]): Promise<Uint8Array> {
  const stride = width * 3 + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgb(x, y);
      const o = row + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(be32(width), 0); ihdr.set(be32(height), 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit, RGB, deflate, no filter, no interlace
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", await deflate(raw)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
/** FNV-1a hash of a string (deterministic colour per picture id). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
/** Placeholder picture for IMAGE_FIXTURE=1: a flat colour from the picture id and one pale diagonal stripe (so motion is visible). */
export function placeholderPng(pictureId: string, width: number, height: number): Promise<Uint8Array> {
  const h = fnv1a(pictureId);
  const base = hslToRgb(h % 360, 0.55, 0.42);
  const stripe = hslToRgb((h % 360 + 30) % 360, 0.6, 0.72);
  const band = Math.max(24, Math.round(Math.min(width, height) / 6));
  return encodePng(width, height, (x, y) => (Math.abs(x - y * (width / height)) < band ? stripe : base));
}

/* ------------------------------------------------------------------ Workers AI */

interface AiRunner { run(model: string, inputs: Record<string, unknown>): Promise<unknown> }
/** What this module itself throws about the ANSWER rather than about the service: the bytes are not a picture. Such a
 *  message carries a byte count, and a byte count is not a status code — "model returned 429 bytes that are neither
 *  PNG nor JPEG" (or a 4006-byte blob) used to read as "rate limited"/"quota", so a model that reliably answers junk
 *  was retried for the life of the video instead of spending the picture's one attempt. Checked before any number is. */
const PAYLOAD_ERROR_RE = /neither PNG nor JPEG|unexpected image model response/i;
/** A number is an HTTP status only when nothing says it is a quantity: "429 Too Many Requests", "AiError: 503", "got
 *  500" — never "… 500 bytes", "500 ms", "500 px". The four-digit AiError codes (3010, 5006, …) never match at all,
 *  \b sees to that; they are genuine model errors. */
const HTTP_STATUS_RE = /\b(?:429|5\d\d)\b(?!\s*(?:bytes?|kb|kib|mb|mib|ms|s|px|pixels?|chars?|tokens?|neurons?)\b)/i;
const TRANSIENT_WORDS_RE = /rate.?limit|too many requests|timed? ?out|fetch failed|network error|temporarily/i;
export const isQuotaError = (e: unknown): boolean => {
  const s = String(e);
  return !PAYLOAD_ERROR_RE.test(s) && /\b4006\b|daily free allocation|neurons/i.test(s);
};
/** "Not now" rather than "not this picture": quota exhaustion, a rate limit, a 5xx or a dropped fetch. Such a failure
 *  does not spend the picture's single attempt (see TRANSIENT_RETRY_MIN); a model error about the prompt itself, or an
 *  answer that is not a picture at all, does. */
export const isTransientError = (e: unknown): boolean => {
  const s = String(e);
  if (PAYLOAD_ERROR_RE.test(s)) return false;
  return isQuotaError(s) || HTTP_STATUS_RE.test(s) || TRANSIENT_WORDS_RE.test(s);
};
/** The same question for the WRITE that follows a successful draw (R2/D1/KV). The picture is already drawn and paid
 *  for, so the default here is the other way round: anything that could be a hiccup (a lost connection, an internal
 *  error, a 5xx from R2) must not burn the attempt of a picture the model already produced. Only a failure that will
 *  give the same answer next time — the file cannot fit where files go, or the store is not configured at all —
 *  counts once, exactly like a model error about the prompt. */
// Narrow on purpose: a bare \bTypeError\b or \bbinding\b also matches a genuinely transient message such as
// "TypeError: Network connection lost" (Workers wraps socket failures that way) or an R2 5xx that happens to
// mention the binding, and marking those permanent is exactly the loss this predicate exists to prevent.
const PERMANENT_STORE_RE = /too large for KV|configure an R2 bucket|no (?:R2|KV) binding|is not a function|of undefined|of null|Cannot read propert/i;
export const isTransientStoreError = (e: unknown): boolean => !PERMANENT_STORE_RE.test(String(e));

/** Reads whatever the model returned (binary stream, bytes, or {image: base64}) as bytes. */
export async function readImageResult(res: unknown): Promise<Uint8Array> {
  if (res instanceof ReadableStream) return new Uint8Array(await new Response(res).arrayBuffer());
  if (res instanceof ArrayBuffer) return new Uint8Array(res);
  if (res instanceof Uint8Array) return res;
  if (res instanceof Blob) return new Uint8Array(await res.arrayBuffer());
  const r = (typeof res === "object" && res !== null ? res : {}) as Record<string, unknown>;
  const b64 = typeof r.image === "string" ? r.image : typeof r.image_b64 === "string" ? r.image_b64 : Array.isArray(r.images) && typeof r.images[0] === "string" ? r.images[0] : null;
  if (!b64) throw new Error(`unexpected image model response (${typeof res}${res && typeof res === "object" ? ": " + Object.keys(r).join(",") : ""})`);
  const bin = atob(b64.replace(/^data:image\/\w+;base64,/, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
/** Picture format from the magic bytes; anything else is refused (the engine loads PNG/JPEG only). */
export function sniffImage(bytes: Uint8Array): "png" | "jpg" | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return null;
}
export function modelFor(env: Env, style: KleoStyle): string {
  return (style === "realistic" ? env.IMAGE_MODEL_REALISTIC : env.IMAGE_MODEL_CARTOON) || DEFAULT_IMAGE_MODELS[style === "realistic" ? "realistic" : "cartoon"];
}
export function fullPrompt(style: KleoStyle, imagePrompt: string): string {
  return `${imagePrompt.trim().replace(/[.\s]+$/, "")}. ${STYLE_SUFFIX[style === "realistic" ? "realistic" : "cartoon"]}`;
}
export function modelInputs(model: string, style: KleoStyle, imagePrompt: string, format: string, seed: number): Record<string, unknown> {
  const inputs: Record<string, unknown> = { prompt: fullPrompt(style, imagePrompt) };
  // FLUX.1 [schnell] rejects any extra property (AiError 5006 on "seed"): send only prompt + steps.
  if (!acceptsSize(model)) { inputs.steps = 4; return inputs; }
  Object.assign(inputs, sizeFor(format), { negative_prompt: NEGATIVE_PROMPT });
  if (/stable-diffusion|dreamshaper/.test(model)) inputs.seed = seed; // only SD-family models document a seed input
  if (/phoenix|lucid-origin/.test(model)) Object.assign(inputs, { num_steps: 20, guidance: style === "realistic" ? 4 : 5 });
  else if (/stable-diffusion|dreamshaper/.test(model)) Object.assign(inputs, { num_steps: 20, guidance: 7.5 });
  return inputs;
}

/* ------------------------------------------------------------------ endpoint logic */

export interface ImagesResult { images: Record<string, string>; missing: string[]; generated: number; reused: number; fixture: boolean }

async function signedImageUrl(env: Env, base: string, jobId: string, name: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL_S;
  const sig = await hmacHex(env.INTERNAL_SECRET, `${jobId}/${name}/${exp}`);
  return `${base}/dl/${jobId}/${encodeURIComponent(name)}?exp=${exp}&sig=${sig}`;
}

/** Generates (or reuses) the pictures of a job and answers the worker. Never throws on AI problems. */
export async function generateJobImages(env: Env, job: Job, base: string): Promise<ImagesResult> {
  const sb = job.storyboard ? (JSON.parse(job.storyboard) as unknown) : null;
  const style = kleoStyleOf(sb);
  const params = JSON.parse(job.params) as { format?: string; duration_s?: number };
  const format = params.format ?? "9:16";
  const result: ImagesResult = { images: {}, missing: [], generated: 0, reused: 0, fixture: env.IMAGE_FIXTURE === "1" };
  if (!PICTURE_STYLES.includes(style)) return result;
  // The video's own cap first (a 40 s Short never carries more than 24 pictures), then what the server may draw itself.
  const wanted = pictureScenes(sb).slice(0, MAX_PICTURES(params.duration_s ?? 60));
  if (!wanted.length) return result;
  // int() keeps a configured 0 (a `|| DEFAULT_SERVER_MAX` turned it back into 10, so no operator could switch
  // server-side drawing off and leave every picture to the GPU worker); only an unset/unparsable value defaults.
  const max = Math.max(0, Math.min(40, int(env.IMAGE_SERVER_MAX ?? env.IMAGE_MAX_PER_JOB, DEFAULT_SERVER_MAX)));
  const chosen = pickImageScenes(wanted, max);
  const chosenIds = new Set(chosen.map((s) => s.id));
  for (const s of wanted) if (!chosenIds.has(s.id)) result.missing.push(s.id);

  const existing = new Map((await listFiles(env, job.id)).filter((f) => IMAGE_NAME_RE.test(f.name)).map((f) => [f.name.slice(4).replace(/\.(png|jpg)$/, ""), f.name]));
  const tried = new Set<string>();
  try {
    const rows = (await env.DB.prepare("SELECT detail, at FROM audit WHERE job_id = ? AND event = 'images.error'").bind(job.id).all<{ detail: string | null; at: string | null }>()).results;
    for (const r of rows) {
      try {
        const d = JSON.parse(r.detail ?? "{}") as { picture?: string; scene?: string; quota?: boolean; transient?: boolean };
        const id = d.picture ?? d.scene;
        if (!id) continue;
        // A transient row (quota is the usual one) expires: past the cool-off the picture is fair game again. An
        // unreadable timestamp keeps it held back — better one grey shot than a loop hammering an exhausted quota.
        const age = minutesSince(r.at ?? "");
        if ((d.transient || d.quota) && Number.isFinite(age) && age > TRANSIENT_RETRY_MIN) continue;
        tried.add(id);
      } catch { /* ignore */ }
    }
  } catch { /* an unreadable audit table only costs a retry */ }

  const model = modelFor(env, style);
  const ai = env.AI as unknown as AiRunner | undefined;
  let quotaHit = false;
  for (const pic of chosen) {
    const have = existing.get(pic.id);
    if (have) { result.images[pic.id] = await signedImageUrl(env, base, job.id, have); result.reused++; continue; }
    if (tried.has(pic.id) || quotaHit) { result.missing.push(pic.id); continue; }
    let bytes: Uint8Array | null = null;
    let ext: "png" | "jpg" = "png";
    try {
      if (result.fixture) {
        const { width, height } = sizeFor(format);
        bytes = await placeholderPng(pic.id, width, height);
      } else {
        if (!ai) throw new Error("no Workers AI binding (env.AI)");
        const res = await ai.run(model, modelInputs(model, style, pic.image_prompt, format, fnv1a(`${job.id}/${pic.id}`) % 1_000_000));
        bytes = await readImageResult(res);
        const kind = sniffImage(bytes);
        if (!kind) throw new Error(`model returned ${bytes.length} bytes that are neither PNG nor JPEG`);
        ext = kind;
      }
    } catch (e) {
      const msg = String(e).slice(0, 400);
      const quota = isQuotaError(e);
      if (quota) quotaHit = true; // the rest of this call is hopeless: skip it without paying for more failures
      // `transient` is what the next call reads back: it decides whether this row spent the picture's one attempt.
      await audit(env, job.user_id, job.id, "images.error", { picture: pic.id, model: result.fixture ? "fixture" : model, error: msg, quota, transient: isTransientError(e) });
      result.missing.push(pic.id);
      continue;
    }
    try {
      const name = imageFileName(pic.id, ext);
      const key = `renders/${job.id}/${name}`;
      const ctype = ext === "png" ? "image/png" : "image/jpeg";
      const size = await putFile(env, key, bytes, ctype);
      await setFile(env, { job_id: job.id, name, key, size, content_type: ctype });
      result.images[pic.id] = await signedImageUrl(env, base, job.id, name);
      result.generated++;
    } catch (e) {
      // The picture exists and was paid for; only the write failed. A hiccup in R2/D1/KV must not spend its one
      // attempt (a permanent grey shot for a two-second outage), so the row carries the same `transient` flag the
      // model branch writes — a store failure that will repeat (too large for KV, no store configured) counts once.
      await audit(env, job.user_id, job.id, "images.error", {
        picture: pic.id, model: result.fixture ? "fixture" : model, error: `store: ${String(e).slice(0, 300)}`,
        quota: false, transient: isTransientStoreError(e),
      });
      result.missing.push(pic.id);
    }
  }
  await audit(env, job.user_id, job.id, "images.generated", { style, model: result.fixture ? "fixture" : model, generated: result.generated, reused: result.reused, missing: result.missing.length, quota: quotaHit });
  return result;
}
