/**
 * Footage over an API: the clips of a filmed video come from kie.ai (https://kie.ai, one API in front of Kling, Veo,
 * Wan, Seedance...) instead of a model on the rented card. 13 September 2026.
 *
 * WHAT MOVES AND WHAT STAYS. Only the filming moves. The rented box still draws the reference frames, voices the
 * script and asks the engine when each shot cuts (that is what decides how long every clip must be); then, instead of
 * loading a 22B model on an 80 GB card, it uploads the frames here, asks for the clips, waits and downloads them. The
 * track, the narration and the 4K 60 fps finish are the same code as before (worker/kleo_video.py build_footage).
 * So a "filmed" job on the kie road rents the PICTURES box (16 GB, $0.40/h) and not the video card ($1.5-2.6/h).
 *
 * THE KEY NEVER LEAVES THIS WORKER. KIE_API_KEY is a Cloudflare secret; the box only ever sees its own job secret.
 * The reference frames reach kie.ai through the same signed /dl links the pictures already use (dl.ts).
 *
 * WHO PAYS WHAT. Every task is priced from KIE_MODELS at creation and written to the `footage` table; the daily gate
 * (DAILY_FOOTAGE_BUDGET_USD) sums today's rows BEFORE creating new ones, so the ceiling counts money the moment it is
 * committed, not when the clip lands. A refusal here fails the film with a clear sentence and no clip is ordered.
 *
 * Worker-facing routes (all under the job secret, see internal.ts):
 *   PUT  /internal/jobs/:id/stills/:pictureId.png   the shot's reference frame (also .jpg / .webp)
 *   POST /internal/jobs/:id/footage   {shots:[{id, image_prompt, motion, strength, seconds, still}], look, format}
 *                                     → creates one kie.ai task per shot that has none yet; idempotent
 *   GET  /internal/jobs/:id/footage   → polls kie.ai for the pending ones, stores finished clips on R2, answers
 *                                     {clips:{id:state}, ready:[id], pending:[id], failed:{id:why}, model}
 *   GET  /internal/jobs/:id/clips/:shotId   the clip, streamed from R2
 * Admin (INTERNAL_SECRET): GET/POST /internal/admin/footage  {backend?, model?}  — switch or model without a deploy.
 *
 * Only imports plain TypeScript with type-only dependencies, so test/footage.test.mjs loads it under Node's type
 * stripping without bundling.
 */
import type { Env } from "./env";
import type { Job, JobParams } from "./db";
import { audit, hasPaid } from "./db.ts";
import { putFile } from "./storage.ts";
import { hmacHex, int, num, nowIso } from "./util.ts";
import { FILM_LOOKS, type FilmLook } from "./keou-contract.ts";
import { isAnimatic } from "./templates.ts";

/* ------------------------------------------------------------------ models and prices */

export type FootageBackend = "kie" | "local";

/**
 * The kie.ai models Kleo knows how to ask, keyed by the short name the config and the admin route use. `model` is the
 * identifier kie.ai's unified jobs API takes (read from docs.kie.ai, page by page, not assumed); `seconds` is what the
 * model accepts for one clip — a range of whole seconds, or a fixed list — and a shot is filmed at the shortest length
 * that covers it, then trimmed on the box.
 *
 * PRICES ARE THE REAL ONES, read on 13 September 2026 from kie.ai's own price list (the HTML page refuses fetchers,
 * its API does not: `POST https://api.kie.ai/client/v1/model-pricing/page {"pageNum":1,"pageSize":100}` with an
 * `origin: https://kie.ai` header; 1 credit = $0.005). Image-to-video rows, audio off. Two shapes: most models bill
 * `usdPerSecond`; Gemini and Veo bill PER CLIP whatever its length (`usdPerClip`, keyed by the clip seconds, and
 * `usdPerSecond` is then the dearest per-second equivalent, the shortest clip, so the admin view stays comparable).
 * The daily budget gate prices a task from these columns — an estimate below the truth lets it spend past the ceiling,
 * which is exactly what the first table (guessed from summer comparisons) did: Seedance sat at 0.08 against 0.51.
 *
 * Why MiniMax H3 is the default (analysis of 13 September, docs/FOOTAGE-KIE.md §4): third of the world in the blind
 * image-to-video arena (Artificial Analysis, no audio: 1351), above Kling 3.0 pro (1302), Veo 3.1 (1304) and Wan 2.7
 * (1275); native 2K, so the box's 4K upscale starts from twice Kling's pixels; 0.065 $/s against Kling's 0.09.
 */
export interface KieModel { model: string; usdPerSecond: number; usdPerClip?: Record<number, number>; seconds: { min: number; max: number } | number[]; note: string; verified: boolean }
export const KIE_MODELS: Record<string, KieModel> = {
  "minimax-h3":     { model: "minimax-h3/image-to-video", usdPerSecond: 0.065, seconds: { min: 4, max: 15 }, verified: false,
                      note: "MiniMax H3 image-to-video, 2K: the default since 13 September — arena rank 3 (Elo 1351), native 2K, 0.065 $/s. First frame conditioning, whole seconds 4-15. Not yet exercised end to end." },
  "minimax-h3-768p": { model: "minimax-h3/image-to-video", usdPerSecond: 0.04, seconds: { min: 4, max: 15 }, verified: false,
                      note: "MiniMax H3 at 768P: the same model, 0.04 $/s, fewer pixels for the 4K upscale." },
  "gemini-omni-flash": { model: "google/gemini-omni-flash-1-1", usdPerSecond: 0.07875, usdPerClip: { 4: 0.315, 6: 0.42, 8: 0.525, 10: 0.63 }, seconds: [4, 6, 8, 10], verified: false,
                      note: "Google Gemini Omni Flash 1.1, 1080p: arena rank 1 (Elo 1365). Billed per clip (0.315 $ for 4 s ... 0.63 $ for 10 s), so long shots are the better deal. First frame conditioning. Not yet exercised." },
  "gemini-omni-flash-4k": { model: "google/gemini-omni-flash-1-1", usdPerSecond: 0.18375, usdPerClip: { 4: 0.735, 6: 0.84, 8: 0.945, 10: 1.05 }, seconds: [4, 6, 8, 10], verified: false,
                      note: "Gemini Omni Flash 1.1 at native 4K: the cheapest native-4K clip on the list (0.735 $ for 4 s ... 1.05 $ for 10 s). For hero shots if the upscaled 4K does not convince." },
  "kling-3.0":      { model: "kling-3.0/video", usdPerSecond: 0.09, seconds: { min: 3, max: 15 }, verified: true,
                      note: "Kling 3.0, mode pro (1920x1080 / 1080x1920), 0.09 $/s: the verified fallback — strong, faithful camera moves, any length 3-15 s; arena rank 15 (Elo 1302)." },
  "kling-3.0-std":  { model: "kling-3.0/video", usdPerSecond: 0.07, seconds: { min: 3, max: 15 }, verified: true,
                      note: "Kling 3.0, mode std (1280x720), 0.07 $/s: the same model, cheaper, less pixel for the 4K upscale." },
  "kling-3.0-4k":   { model: "kling-3.0/video", usdPerSecond: 0.335, seconds: { min: 3, max: 15 }, verified: true,
                      note: "Kling 3.0, mode 4K (3840x2160), 0.335 $/s: native delivery size, no upscale; 3.7x the pro price." },
  "kling-v3-turbo": { model: "kling/v3-turbo-image-to-video", usdPerSecond: 0.1125, seconds: { min: 3, max: 15 }, verified: true,
                      note: "Kling 3.0 turbo image-to-video, 1080p, 0.1125 $/s: faster than pro, not cheaper." },
  "veo-3.1":        { model: "veo-3-1", usdPerSecond: 0.31875, usdPerClip: { 4: 1.275, 6: 1.275, 8: 1.275 }, seconds: [4, 6, 8], verified: false,
                      note: "Google Veo 3.1 through the jobs API (model veo-3-1, generation_type FIRST_AND_LAST_FRAMES_2_VIDEO with one frame). Billed per clip; which tier this route bills is unknown, so the gate counts the Quality one (1.275 $ a clip; Fast is 0.325, Lite 0.175). Strict safety filter; the route has not been exercised yet." },
  "wan-2.7":        { model: "wan/2-7-image-to-video", usdPerSecond: 0.12, seconds: { min: 2, max: 15 }, verified: true,
                      note: "Wan 2.7, 1080p, 0.12 $/s, first-frame conditioning, negative prompt and seed. Arena rank 15 (Elo 1275), dearer than Kling pro." },
  "seedance-2.0":   { model: "bytedance/seedance-2", usdPerSecond: 0.51, seconds: { min: 4, max: 15 }, verified: true,
                      note: "ByteDance Seedance 2.0, 1080p image-to-video, 0.51 $/s on kie.ai (720p is 0.205): fluid with people, arena rank 4 at 720p (Elo 1342), but 5.7x the price of Kling pro here. Keep for comparisons, not for production." },
};
export const DEFAULT_KIE_MODEL = "minimax-h3";

/** The kie.ai unified API (docs.kie.ai/market/common): one endpoint creates a task for any market model, one reads it. */
export const KIE_BASE = "https://api.kie.ai";
export const KIE_CREATE = `${KIE_BASE}/api/v1/jobs/createTask`;
export const KIE_RECORD = `${KIE_BASE}/api/v1/jobs/recordInfo`;
/** GET: the account's remaining credits as a bare number in `data` (docs.kie.ai/common-api/get-account-credits); 1 credit = 0.005 $. */
export const KIE_CREDIT = `${KIE_BASE}/api/v1/chat/credit`;
export const USD_PER_KIE_CREDIT = 0.005;

/* ------------------------------------------------------------------ the decision */

/** The whole-video cap of the test phase: a film longer than this takes the local road, whatever the switch says. */
export const DEFAULT_KIE_MAX_VIDEO_S = 20;

/**
 * Which road a filmed job takes. Pure, so vast.ts (the machine to rent), internal.ts (the job spec the box reads)
 * and jobs.ts (the token check) cannot disagree: the same env and the same job give the same answer everywhere.
 * `override` is the admin route's live setting (footageConfig), read once by the caller.
 */
export function footageBackendFor(env: Pick<Env, "KIE_API_KEY" | "KLEO_FOOTAGE_BACKEND" | "KIE_MAX_VIDEO_S">, job: Pick<Job, "params">, override: FootageOverride | null = null): FootageBackend {
  const wanted = (override?.backend ?? env.KLEO_FOOTAGE_BACKEND ?? "").trim().toLowerCase();
  if (wanted !== "kie") return "local";
  if (!(env.KIE_API_KEY && env.KIE_API_KEY.trim())) return "local";
  let seconds = 0;
  try { seconds = Number((JSON.parse(job.params) as JobParams).duration_s) || 0; } catch { /* unreadable params: the cap decides */ }
  const cap = int(env.KIE_MAX_VIDEO_S, DEFAULT_KIE_MAX_VIDEO_S);
  return cap > 0 && seconds > cap ? "local" : "kie";
}

/** The model a job films with: the admin override, then the config, then the default; unknown names fall back. */
export function kieModelFor(env: Pick<Env, "KLEO_FOOTAGE_MODEL">, override: FootageOverride | null = null): { name: string; spec: KieModel } {
  const name = (override?.model ?? env.KLEO_FOOTAGE_MODEL ?? DEFAULT_KIE_MODEL).trim();
  const spec = KIE_MODELS[name];
  return spec ? { name, spec } : { name: DEFAULT_KIE_MODEL, spec: KIE_MODELS[DEFAULT_KIE_MODEL] };
}

/** The clip length a model films for a shot of `seconds`: the shortest whole length it offers that covers the shot
 *  (a shot of 3.2 s is a 4 s clip on a range model, an 8 s one on Veo), clamped to what the model accepts. */
export function clipSecondsFor(spec: KieModel, seconds: number): number {
  const want = Math.ceil(Math.max(0.5, seconds) - 0.05);
  if (Array.isArray(spec.seconds)) return spec.seconds.find((d) => d >= want) ?? spec.seconds[spec.seconds.length - 1];
  return Math.min(spec.seconds.max, Math.max(spec.seconds.min, want));
}

/** What one clip costs: the per-clip figure when the model bills that way, else seconds times the rate. A clip length
 *  the per-clip table does not list (it cannot happen after clipSecondsFor, but the gate must never under-count) is
 *  charged at the dearest listed clip. */
export function clipCostUsd(spec: KieModel, clipSeconds: number): number {
  const perClip = spec.usdPerClip;
  const usd = perClip ? (perClip[clipSeconds] ?? Math.max(...Object.values(perClip))) : spec.usdPerSecond * clipSeconds;
  return Math.round(usd * 10000) / 10000;
}

/**
 * What a film of `seconds` will cost in clips BEFORE anything exists of it — an UPPER bound, on purpose. The shots
 * are the storyboard's when the caller wrote one, else the planner's Short density (a shot every PREFLIGHT_SHOT_S,
 * never fewer than six, never more than the storyboard cap: the audited 30 s Short was 15 shots, a 60 s film 10);
 * each clip covers the average shot through the same clipSecondsFor/clipCostUsd as the order itself, and the total
 * carries PREFLIGHT_MARGIN because the voice decides the real cut times and some shots are billed a whole second
 * more (the 15 s film of 15 September: average 1.82 $, order 1.885 $). A pre-flight that passes a film the box then
 * cannot pay for is the rental this exists to prevent; one that refuses a marginal balance costs nothing, and the
 * exact gate is still requestFootage on the box. Four films rented a card, drew their frames and voiced their
 * script on 15 September before learning kie.ai held 0.07 $: this is the number that lets createJob say so first.
 */
export function plannedFilmUsd(env: Env, cfg: FootageOverride | null, seconds: number, shots: number | null, maxShots: number): { usd: number; shots: number; model: string } {
  const { name, spec } = kieModelFor(env, cfg);
  const n = shots && shots > 0 ? shots : Math.min(maxShots, Math.max(6, Math.ceil(seconds / PREFLIGHT_SHOT_S)));
  const each = clipCostUsd(spec, clipSecondsFor(spec, seconds / n));
  return { usd: Math.round(each * n * PREFLIGHT_MARGIN * 1000) / 1000, shots: n, model: name };
}
export const PREFLIGHT_SHOT_S = 2.5;
export const PREFLIGHT_MARGIN = 1.25;

/**
 * The pre-flight of a film: can kie.ai pay for it right now? `null` when kie.ai did not answer (a monitoring call
 * never refuses a film: the order gate in requestFootage decides then), otherwise the balance and the plan so the
 * caller can refuse in numbers. Six seconds at most, like kieBalanceUsd.
 */
export async function kiePreflight(env: Env, seconds: number, shots: number | null, maxShots: number): Promise<{ ok: boolean; reason: "balance" | "budget" | null; balance_usd: number | null; planned_usd: number; spent_today_usd: number; budget_usd: number; shots: number; model: string }> {
  const cfg = await footageConfig(env);
  const plan = plannedFilmUsd(env, cfg, seconds, shots, maxShots);
  // The same two gates the order itself will meet on the box (requestFootage): today's ceiling first, then the account.
  const budget = num(env.DAILY_FOOTAGE_BUDGET_USD, 5);
  const spent = await footageSpentTodayUsd(env);
  if (spent + plan.usd > budget) return { ok: false, reason: "budget", balance_usd: null, planned_usd: plan.usd, spent_today_usd: spent, budget_usd: budget, shots: plan.shots, model: plan.model };
  const balance = await kieBalanceUsd(env);
  const ok = balance === null || balance >= plan.usd;
  return { ok, reason: ok ? null : "balance", balance_usd: balance, planned_usd: plan.usd, spent_today_usd: spent, budget_usd: budget, shots: plan.shots, model: plan.model };
}

/* ------------------------------------------------------------------ live override (no deploy) */

export interface FootageOverride { backend?: "kie" | "local"; model?: string; set_at?: string }
const OVERRIDE_KEY = "config:footage";

/** The admin route's setting, kept in KV so a test can switch model between two videos without a deploy. */
export async function footageConfig(env: Env): Promise<FootageOverride | null> {
  try {
    const raw = await env.OAUTH_KV.get(OVERRIDE_KEY);
    return raw ? (JSON.parse(raw) as FootageOverride) : null;
  } catch { return null; }
}
export async function setFootageConfig(env: Env, o: FootageOverride | null): Promise<void> {
  if (!o) { await env.OAUTH_KV.delete(OVERRIDE_KEY); return; }
  await env.OAUTH_KV.put(OVERRIDE_KEY, JSON.stringify({ ...o, set_at: nowIso() }));
}

/* ------------------------------------------------------------------ the prompt */

/**
 * The camera, in plain words. kleo_video.py MOVES speaks LTX's dialect with negations; the hosted models read a
 * shorter sentence better, and Kling in particular follows "the camera ..." phrasing closely. Same ten moves the
 * shot grammar resolves to (src/shot-grammar.ts).
 */
export const KIE_MOVES: Record<string, string> = {
  crash_zoom_in: "the camera rushes forward toward the subject in a fast dolly and stops hard",
  push_in: "the camera pushes slowly forward toward the subject, still moving as the shot ends",
  push_in_dutch: "the camera pushes slowly forward while the horizon tilts a few degrees",
  pull_out: "the camera pulls slowly backward, more of the place entering the frame",
  track_left: "the camera tracks sideways to the left at a steady speed, foreground passing faster than background",
  track_right: "the camera tracks sideways to the right at a steady speed, foreground passing faster than background",
  track_alongside: "the camera travels alongside the subject at its own speed",
  orbit_left: "the camera arcs around the subject to the left",
  orbit_right: "the camera arcs around the subject to the right",
  crane_down: "the camera cranes slowly down from above toward eye level",
  crane_up: "the camera cranes slowly upward, the ground falling away",
  whip_pan: "the camera whips sideways in a fast blurred pan and settles",
  static_hold: "the camera is locked off on a tripod; only the scene moves",
};
// SHARP AND CONCRETE (the owner's direction of 14 September): the look asks the clip model for one plane in sharp
// focus and real surface texture, and the negative names the two looks a generated clip drifts into — the soft
// out-of-focus wash and the glossy CGI render.
export const KIE_LOOK = "Cinematic live-action film, 35mm, shallow depth of field with the subject in sharp focus, natural light, fine real surface texture, realistic physics, subtle film grain. No text, no captions, no logos.";
export const KIE_NEGATIVE = "text, letters, watermark, logo, subtitles, blurry, soft focus, out of focus, cgi, 3d render, plastic, oversmooth, low quality, deformed, morphing, extra fingers, static image, frozen, slideshow";
/** The look per film (14 September): the animated film asks the clip model for drawn motion and bans the photograph instead of the drawing. */
export const KIE_LOOKS: Record<FilmLook, string> = {
  realistic: KIE_LOOK,
  animation: "2D animated feature film, hand-drawn character animation over painted backgrounds, clean consistent linework, flat cel colour, the characters and the world exactly as drawn in the frame, smooth animated motion. No text, no captions, no logos.",
};
export const KIE_NEGATIVES: Record<FilmLook, string> = {
  realistic: KIE_NEGATIVE,
  animation: "text, letters, watermark, logo, subtitles, blurry, photograph, photorealistic, live action, real skin, 3d render, cgi, low quality, deformed, morphing, extra fingers, static image, frozen, slideshow",
};
export const filmLookOf = (x: unknown): FilmLook => ((FILM_LOOKS as readonly string[]).includes(String(x)) ? (x as FilmLook) : "realistic");

/** subject first, then the camera, then the look — the order every model reads with the most weight at the front. */
export function kiePrompt(shot: { image_prompt: string; motion?: string | null; strength?: number | null }, look: FilmLook = "realistic"): string {
  const subject = String(shot.image_prompt ?? "").trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "");
  const move = KIE_MOVES[String(shot.motion ?? "")] ?? KIE_MOVES.push_in;
  const pace = typeof shot.strength === "number" && shot.strength < 0.4 ? " Gentle, slow motion of the camera." : "";
  return `${subject}. ${move.charAt(0).toUpperCase()}${move.slice(1)}.${pace} ${KIE_LOOKS[look]}`.replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ rows */

export interface FootageRow { job_id: string; shot_id: string; model: string; task_id: string | null; state: "queued" | "generating" | "ready" | "failed"; seconds: number; cost_usd: number; result_url: string | null; key: string | null; error: string | null; created_at: string; updated_at: string | null }

export async function footageRows(env: Env, jobId: string): Promise<FootageRow[]> {
  const r = await env.DB.prepare("SELECT * FROM footage WHERE job_id = ? ORDER BY shot_id").bind(jobId).all<FootageRow>();
  return r.results ?? [];
}
async function updateRow(env: Env, jobId: string, shotId: string, fields: Partial<FootageRow>): Promise<void> {
  const keys = Object.keys(fields) as (keyof FootageRow)[];
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  await env.DB.prepare(`UPDATE footage SET ${sets}, updated_at = ? WHERE job_id = ? AND shot_id = ?`)
    .bind(...keys.map((k) => fields[k] as unknown), nowIso(), jobId, shotId).run();
}
/** Estimated kie.ai dollars committed today (UTC), from the rows written at task creation. */
export async function footageSpentTodayUsd(env: Env): Promise<number> {
  const r = await env.DB.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM footage WHERE created_at >= strftime('%Y-%m-%dT00:00:00Z','now') AND task_id IS NOT NULL").first<{ usd: number }>();
  return Number(r?.usd ?? 0);
}

/** A shot id is a picture id: `<sceneId>-s<n>` (kleo_worker.py PICTURE_ID). */
export const SHOT_ID_RE = /^[a-z0-9-]{1,56}$/;
export const STILL_NAME_RE = /^[a-z0-9-]{1,56}\.(png|jpg|webp)$/;
export const clipKey = (jobId: string, shotId: string) => `renders/${jobId}/clips/${shotId}.mp4`;

/* ------------------------------------------------------------------ kie.ai client */

export class KieError extends Error {
  constructor(message: string, public status: number, public retryable: boolean) { super(message); this.name = "KieError"; }
}

async function kie<T>(env: Env, method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
  if (!env.KIE_API_KEY) throw new KieError("KIE_API_KEY is not set", 0, false);
  const res = await fetch(url, {
    method,
    headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${env.KIE_API_KEY.trim()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: { code?: number; msg?: string; message?: string; data?: T } = {};
  try { data = JSON.parse(text); } catch { throw new KieError(`kie.ai ${method} ${url} → ${res.status}: unreadable body ${text.slice(0, 120)}`, res.status, res.status >= 500); }
  if (!res.ok) throw new KieError(`kie.ai ${method} ${url} → ${res.status}: ${(data.msg ?? data.message ?? text).toString().slice(0, 200)}`, res.status, res.status === 429 || res.status >= 500);
  // The unified API answers HTTP 200 with its own code: 200 is fine, 402 is no credits, 4xx is our request, 5xx is
  // theirs. A body that carries `data` is trusted whatever the code says (the doc's own example shows 505 + success).
  if (typeof data.code === "number" && data.code !== 200 && !(data.data && typeof data.data === "object")) throw new KieError(`kie.ai ${method} ${url} → code ${data.code}: ${(data.msg ?? "").slice(0, 200)}`, data.code, data.code >= 500 || data.code === 429);
  return data.data as T;
}

/**
 * kie.ai's own words for an empty account. The unified API documents HTTP 200 + code 402; on 13 September 2026 it
 * answered code 500 with "Credits insufficient : Your current balance isn't enough to run this request" instead
 * (job gt_sw48sch9, 13 tasks in, 3 refused). Both mean the same thing and neither is worth a second try.
 */
export function isNoCredit(e: unknown): boolean {
  if (!(e instanceof KieError)) return false;
  return e.status === 402 || /credits? insufficient|insufficient credits?|balance isn.t enough|not enough (credits?|balance)|top up/i.test(e.message);
}

/**
 * What the account can still spend, in dollars, or null when kie.ai did not say (network, a changed endpoint, a bad
 * key): a monitoring call must never be the thing that stops a film, so null means "go ahead and let createTask
 * decide". Six seconds at most: this sits in front of every order.
 */
export async function kieBalanceUsd(env: Env): Promise<number | null> {
  if (!env.KIE_API_KEY) return null;
  try {
    const res = await fetch(KIE_CREDIT, { headers: { accept: "application/json", authorization: `Bearer ${env.KIE_API_KEY.trim()}` }, signal: AbortSignal.timeout(6000) });
    const data = (await res.json().catch(() => null)) as { code?: number; data?: unknown } | null;
    if (!res.ok || !data || data.code !== 200 || typeof data.data !== "number" || !Number.isFinite(data.data)) return null;
    return Math.round(data.data * USD_PER_KIE_CREDIT * 1000) / 1000;
  } catch { return null; }
}

/** The sentence the user reads when kie.ai has no money left. Plain, and it says what happens to their credits. */
export function noCreditSentence(ordered: number, wanted: number): string {
  return `kie.ai balance is empty: ${ordered} of ${wanted} shots could be ordered before it ran out. Top up the kie.ai account and ask for the video again; this video was not made and its credits are refunded`;
}

/**
 * The `input` the unified API takes, per model family — the dialects differ and each is read off its own doc page:
 *  kling-3.0/video           prompt, image_urls[], duration "3".."15" (string), aspect_ratio, mode std|pro|4K, sound
 *  kling/v3-turbo-image-to-video  prompt, image_urls[], duration (string), resolution 720p|1080p
 *  veo-3-1                   prompt, image_urls[], generation_type, aspect_ratio, resolution, duration 4|6|8
 *  wan/2-7-image-to-video    prompt, negative_prompt, first_frame_url, resolution, duration (int), seed
 *  bytedance/seedance-2      prompt, first_frame_url, duration (int), aspect_ratio, resolution, generate_audio
 *  minimax-h3/image-to-video prompt (≤7000 chars), first_frame_url | last_frame_url (one required), duration (int 4-15), resolution 768P|2K
 *  google/gemini-omni-flash-1-1  prompt, first_frame_url, duration 4|6|8|10 (int), resolution 360p|720p|1080p|4k, aspect_ratio 16:9|9:16
 * Audio is always off: the narration is Kleo's. Without a still the same call becomes text-to-video where the model
 * allows it (Kling, Veo) — the box always sends one, this is the fallback for a still that failed to upload. MiniMax
 * has no text-to-video on this model id: without a still the input carries no frame and kie.ai refuses the task, which
 * is the right outcome (a clip without its reference frame is not the shot that was planned).
 */
export function kieInput(name: string, spec: KieModel, p: { prompt: string; imageUrl: string | null; seconds: number; format: string; seed: number; look?: FilmLook }): Record<string, unknown> {
  const aspect = p.format === "16:9" ? "16:9" : "9:16";
  const duration = clipSecondsFor(spec, p.seconds);
  if (name.startsWith("kling-3.0")) {
    const mode = name.endsWith("-std") ? "std" : name.endsWith("-4k") ? "4K" : "pro";
    return { prompt: p.prompt, ...(p.imageUrl ? { image_urls: [p.imageUrl] } : {}), duration: String(duration), aspect_ratio: aspect, mode, sound: false, multi_shots: false };
  }
  if (name.startsWith("kling-v3-turbo")) return { prompt: p.prompt, ...(p.imageUrl ? { image_urls: [p.imageUrl] } : {}), duration: String(duration), resolution: "1080p" };
  if (name.startsWith("veo")) return { prompt: p.prompt, ...(p.imageUrl ? { image_urls: [p.imageUrl], generation_type: "FIRST_AND_LAST_FRAMES_2_VIDEO" } : { generation_type: "TEXT_2_VIDEO" }), aspect_ratio: aspect, resolution: "1080p", duration };
  if (name.startsWith("wan")) return { prompt: p.prompt, negative_prompt: KIE_NEGATIVES[p.look ?? "realistic"], ...(p.imageUrl ? { first_frame_url: p.imageUrl } : {}), resolution: "1080p", duration, seed: p.seed, prompt_extend: false, watermark: false };
  if (name.startsWith("seedance")) return { prompt: p.prompt, ...(p.imageUrl ? { first_frame_url: p.imageUrl } : {}), duration, aspect_ratio: aspect, resolution: "1080p", generate_audio: false };
  if (name.startsWith("minimax")) return { prompt: p.prompt.slice(0, 7000), ...(p.imageUrl ? { first_frame_url: p.imageUrl } : {}), duration, resolution: name.endsWith("-768p") ? "768P" : "2K" };
  if (name.startsWith("gemini")) return { prompt: p.prompt, ...(p.imageUrl ? { first_frame_url: p.imageUrl } : {}), duration, resolution: name.endsWith("-4k") ? "4k" : "1080p", aspect_ratio: aspect };
  return { prompt: p.prompt, ...(p.imageUrl ? { image_urls: [p.imageUrl] } : {}), duration: String(duration), aspect_ratio: aspect };
}

/** Deterministic seed from the shot id, as kleo_video.py seed_for does: the same shot asks for the same clip. */
export function seedFor(shotId: string): number {
  let h = 2166136261;
  for (let i = 0; i < shotId.length; i++) { h ^= shotId.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h % 2147483647;
}

export interface ShotRequest { id: string; image_prompt: string; motion?: string | null; strength?: number | null; seconds: number; still?: string | null }

/**
 * POST /footage: one task per shot that has no row yet. Answers the same shape as GET so the worker has one parser.
 * Budget first: the sum of today's committed rows plus this request must stay under the ceiling, or nothing is ordered.
 */
export async function requestFootage(env: Env, job: Job, base: string, body: { shots: ShotRequest[]; look?: string; format?: string }): Promise<{ status: number; reply: Record<string, unknown> }> {
  const cfg = await footageConfig(env);
  if (footageBackendFor(env, job, cfg) !== "kie") return { status: 409, reply: { error: "this job does not film through kie.ai (switch off, no key, or the video is longer than KIE_MAX_VIDEO_S)" } };
  // An animatic is drawn, never filmed: whatever a box asks, no clip is bought for it (templates.ts, the two products).
  try { if (isAnimatic(JSON.parse(job.params) as JobParams)) return { status: 409, reply: { error: "this job is an animatic: it is drawn from its frames and orders no clip" } }; } catch { /* unreadable params: the film rules apply */ }
  // The paid rule holds on this road too (a film queued before the rule, or created by any other road): the clips
  // are the owner's money, and a 402 here fails the job at once with the sentence and refunds it (internal.ts).
  if (!(await hasPaid(env, job.user_id))) {
    await audit(env, job.user_id, job.id, "footage.unpaid", { note: "film for an account with no payment on record; refused before any task" });
    return { status: 402, reply: { error: "this film is for accounts that have bought a credit pack, and this account has not: no clip was ordered and the credits are refunded. The animatic of the same storyboard (product: \"animatic\") is open to every account", unpaid: true } };
  }
  const { name, spec } = kieModelFor(env, cfg);
  const format = body.format === "16:9" ? "16:9" : "9:16";
  // The look the worker read off the project, or the job's own style: the clip prompt and the negative follow it.
  let look: FilmLook = filmLookOf(body.look);
  if (!body.look) { try { look = filmLookOf((JSON.parse(job.params) as JobParams).style); } catch { /* unreadable params: realistic */ } }
  const shots = (Array.isArray(body.shots) ? body.shots : []).filter((s) => s && typeof s === "object" && SHOT_ID_RE.test(String(s.id ?? "")) && String(s.image_prompt ?? "").trim());
  if (!shots.length) return { status: 400, reply: { error: "no shots to film" } };
  if (shots.length > 40) return { status: 400, reply: { error: `${shots.length} shots is more than one film may ask for (40)` } };
  const have = new Map((await footageRows(env, job.id)).map((r) => [r.shot_id, r]));
  // Fresh: no row yet, or a row that failed BEFORE kie.ai gave it a task (refused, never billed). Ordering that one
  // again is how a topped-up account rescues a film that ran out of money halfway through the previous request.
  const retryable = (r: FootageRow | undefined) => !!r && r.state === "failed" && !r.task_id;
  const fresh = shots.filter((s) => !have.has(s.id) || retryable(have.get(s.id)));
  const budget = num(env.DAILY_FOOTAGE_BUDGET_USD, 5);
  const planned = fresh.reduce((a, s) => a + clipCostUsd(spec, clipSecondsFor(spec, Number(s.seconds) || 3)), 0);
  const spent = await footageSpentTodayUsd(env);
  if (fresh.length && spent + planned > budget) {
    await audit(env, job.user_id, job.id, "footage.budget", { spent_usd: spent, planned_usd: planned, budget_usd: budget, model: name });
    return { status: 402, reply: { error: `today's kie.ai budget is spent ($${spent.toFixed(2)} committed + $${planned.toFixed(2)} for this film > $${budget.toFixed(2)}, DAILY_FOOTAGE_BUDGET_USD)` } };
  }
  // The account itself, before the first task: kie.ai bills per task, so a film that runs out of money on shot 14
  // has paid for 13 clips it will never use (13 September, 3.38 $). Silence from the balance call does not refuse.
  if (fresh.length) {
    const balance = await kieBalanceUsd(env);
    if (balance !== null && balance < planned) {
      await audit(env, job.user_id, job.id, "footage.no_credit", { balance_usd: balance, planned_usd: Math.round(planned * 1000) / 1000, model: name, ordered: 0, wanted: fresh.length });
      return { status: 402, reply: { error: noCreditSentence(0, fresh.length), no_credit: true, balance_usd: balance, planned_usd: Math.round(planned * 1000) / 1000 } };
    }
  }
  const exp = Math.floor(Date.now() / 1000) + 6 * 60 * 60;
  let ordered = 0, outOfCredit = false;
  for (const s of fresh) {
    const seconds = Math.max(1, Math.min(30, Number(s.seconds) || 3));
    const clipSeconds = clipSecondsFor(spec, seconds);
    const cost = clipCostUsd(spec, clipSeconds);
    let imageUrl: string | null = null;
    if (typeof s.still === "string" && STILL_NAME_RE.test(s.still)) {
      const stillName = `img/${s.still}`;
      imageUrl = `${base}/dl/${job.id}/${encodeURIComponent(stillName)}?exp=${exp}&sig=${await hmacHex(env.INTERNAL_SECRET, `${job.id}/${stillName}/${exp}`)}`;
    }
    const prompt = kiePrompt(s, look);
    // The row goes in BEFORE the call, with no task id: a second request while the first is in flight orders nothing twice.
    // A refused row from an earlier request is reset in place instead (same key, new price, no error).
    if (retryable(have.get(s.id))) await updateRow(env, job.id, s.id, { state: "queued", model: name, seconds, cost_usd: cost, error: null });
    else await env.DB.prepare("INSERT OR IGNORE INTO footage (job_id, shot_id, model, state, seconds, cost_usd, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)")
      .bind(job.id, s.id, name, seconds, cost, nowIso()).run();
    try {
      const r = await kie<{ taskId?: string }>(env, "POST", KIE_CREATE, { model: spec.model, input: kieInput(name, spec, { prompt, imageUrl, seconds, format, seed: seedFor(s.id), look }) });
      if (!r?.taskId) throw new KieError("kie.ai answered without a taskId", 0, false);
      await updateRow(env, job.id, s.id, { task_id: r.taskId, state: "generating" });
      await audit(env, job.user_id, job.id, "footage.task", { shot: s.id, model: name, task: r.taskId, clip_s: clipSeconds, want_s: seconds, usd: cost, still: !!imageUrl });
      ordered++;
    } catch (e) {
      const msg = String(e).slice(0, 300);
      await updateRow(env, job.id, s.id, { state: "failed", error: msg, cost_usd: 0 });
      await audit(env, job.user_id, job.id, "footage.task.error", { shot: s.id, model: name, error: msg });
      // No money left: every further task would be refused the same way, and every clip already ordered is money
      // spent on a film that cannot be finished. Stop here; the shots after this one get no row, so a later request
      // (after a top-up) orders them and the refused one afresh.
      if (isNoCredit(e)) { outOfCredit = true; break; }
    }
  }
  const reply = await footageStatus(env, job, false);
  if (outOfCredit) {
    await audit(env, job.user_id, job.id, "footage.no_credit", { model: name, ordered, wanted: fresh.length });
    return { status: 402, reply: { ...reply.reply, ordered, no_credit: true, error: noCreditSentence(ordered, fresh.length) } };
  }
  return { status: 200, reply: { ...reply.reply, ordered } };
}

/** What kie.ai's recordInfo answers for one task (the fields Kleo reads; the rest is ignored). state is one of
 *  waiting | queuing | generating | success | fail; resultJson is a JSON STRING {"resultUrls":[...]}; the urls expire
 *  after about 24 hours, which is why the clip is copied to R2 the moment it is seen. */
interface KieRecord { taskId?: string; state?: string; resultJson?: string | { resultUrls?: string[] }; failCode?: string | number; failMsg?: string; costTime?: number }

/**
 * GET /footage: asks kie.ai about every generating shot, downloads the finished ones to R2 (one download per clip,
 * ever: the row's `key` says it is there), and answers the worker's view. `poll` false skips the network (right
 * after creation nothing is ready yet).
 */
export async function footageStatus(env: Env, job: Job, poll = true): Promise<{ status: number; reply: Record<string, unknown> }> {
  const rows = await footageRows(env, job.id);
  if (poll) for (const row of rows) {
    if (row.state !== "generating" || !row.task_id) continue;
    try {
      const rec = await kie<KieRecord>(env, "GET", `${KIE_RECORD}?taskId=${encodeURIComponent(row.task_id)}`);
      const state = String(rec?.state ?? "").toLowerCase();
      if (state === "success") {
        const urls = resultUrls(rec);
        if (!urls.length) throw new KieError("task succeeded without a result url", 0, false);
        await downloadClip(env, job, row, urls[0]);
      } else if (state === "fail" || state === "failed" || state === "error") {
        const msg = `${rec.failCode ?? ""} ${rec.failMsg ?? "kie.ai reported a failure"}`.trim().slice(0, 300);
        await updateRow(env, job.id, row.shot_id, { state: "failed", error: msg });
        await audit(env, job.user_id, job.id, "footage.failed", { shot: row.shot_id, task: row.task_id, error: msg });
      } else if (minutesSinceIso(row.created_at) > 30) {
        await updateRow(env, job.id, row.shot_id, { state: "failed", error: `still ${state || "pending"} after 30 minutes` });
        await audit(env, job.user_id, job.id, "footage.failed", { shot: row.shot_id, task: row.task_id, error: "timeout" });
      }
    } catch (e) {
      const msg = String(e).slice(0, 300);
      // A transient error (network, 5xx, 429) leaves the row generating: the next poll asks again. A definite one fails it.
      if (e instanceof KieError && !e.retryable && e.status !== 0) await updateRow(env, job.id, row.shot_id, { state: "failed", error: msg });
      await audit(env, job.user_id, job.id, "footage.poll.error", { shot: row.shot_id, error: msg });
    }
  }
  const now = await footageRows(env, job.id);
  const cfg = await footageConfig(env);
  return { status: 200, reply: {
    model: now[0]?.model ?? kieModelFor(env, cfg).name,
    clips: Object.fromEntries(now.map((r) => [r.shot_id, r.state])),
    ready: now.filter((r) => r.state === "ready").map((r) => r.shot_id),
    pending: now.filter((r) => r.state === "queued" || r.state === "generating").map((r) => r.shot_id),
    failed: Object.fromEntries(now.filter((r) => r.state === "failed").map((r) => [r.shot_id, r.error ?? "failed"])),
    cost_usd: Math.round(now.reduce((a, r) => a + (r.cost_usd || 0), 0) * 1000) / 1000,
  } };
}

function resultUrls(rec: KieRecord): string[] {
  let rj: unknown = rec.resultJson;
  if (typeof rj === "string") { try { rj = JSON.parse(rj); } catch { rj = null; } }
  const urls = (rj as { resultUrls?: unknown } | null)?.resultUrls;
  return Array.isArray(urls) ? urls.filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)) : [];
}
const minutesSinceIso = (iso: string): number => (Date.now() - new Date(iso).getTime()) / 60_000;

const CLIP_MAX_BYTES = 400 * 1024 * 1024;

/** The finished clip, from kie.ai's (temporary) URL to R2 under the job, once. */
async function downloadClip(env: Env, job: Job, row: FootageRow, url: string): Promise<void> {
  const res = await fetch(url, { headers: { "user-agent": "kleo-mcp/1.0" } });
  if (!res.ok) throw new KieError(`clip download → ${res.status}`, res.status, res.status >= 500 || res.status === 429);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > CLIP_MAX_BYTES) throw new KieError(`clip is ${len} bytes, over the ${CLIP_MAX_BYTES} limit`, 0, false);
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 1024 || new TextDecoder().decode(buf.slice(4, 8)) !== "ftyp") throw new KieError(`clip download is not an mp4 (${buf.byteLength} bytes)`, 0, false);
  const key = clipKey(job.id, row.shot_id);
  const size = await putFile(env, key, buf, "video/mp4");
  await updateRow(env, job.id, row.shot_id, { state: "ready", key, result_url: url });
  await audit(env, job.user_id, job.id, "footage.ready", { shot: row.shot_id, task: row.task_id, bytes: size });
}
