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
import { FILM_LOOKS, directionOf, type FilmLook } from "./keou-contract.ts";
import { isAnimatic } from "./templates.ts";
import { specOf, itemById, type RequestSpec, type SpecItem } from "./spec.ts";
import { stillCast, stillShotsOf, stillModel, stillProviderOf, stillPriceUsd, STILL_SIZES, SHEET_SIZE } from "./stills.ts";
import { KIE_BASE, KIE_CREATE, KIE_RECORD, KIE_CREDIT, USD_PER_KIE_CREDIT, KieError, kie, isNoCredit, kieResultUrls, type KieRecord } from "./kie.ts";
import { ephone, ephoneBalanceUsd, ephoneOutputs, ephoneFailure, type EphoneTask } from "./ephone.ts";

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
export interface KieModel {
  model: string; usdPerSecond: number; usdPerClip?: Record<number, number>; seconds: { min: number; max: number } | number[]; note: string; verified: boolean;
  /** Where the clip is bought (25 September 2026): kie.ai (unset) or ePhone AI (src/ephone.ts). */
  provider?: "kie" | "ephone";
  /** The resolution asked for, where the model's name does not say it. */
  resolution?: string;
}
/** The road a model's clips are bought on. */
export const clipProviderOf = (spec: Pick<KieModel, "provider">): "kie" | "ephone" => spec.provider ?? "kie";
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
  // ePhone AI (25 September 2026, the owner's pick): Seedance 2.5 on the official ByteDance channel. The price is a
  // token price — 70 CNY per million output tokens at 480p/720p without a reference video, times the ByteDance group
  // ratio 0.9, with tokens = width x height x fps x seconds / 1024 (480x864 at 24 fps: 9,720 a second; 720x1280:
  // 21,600) and 7 CNY a dollar — so these per-second figures are estimates the first real clip checks (usage.output_tokens).
  "seedance-2.5-480p": { provider: "ephone", model: "doubao-seedance-2-5-260628", resolution: "480p", usdPerSecond: 0.0875, seconds: { min: 4, max: 30 }, verified: false,
                      note: "ByteDance Seedance 2.5 through ePhone AI (official channel), 480p, about 0.0875 $/s (kie.ai: 0.14). First frame conditioning, whole seconds 4-30. 480p is upscaled 4.5x per side to 4K on the box (Lanczos): soft. Not yet exercised." },
  "seedance-2.5-720p": { provider: "ephone", model: "doubao-seedance-2-5-260628", resolution: "720p", usdPerSecond: 0.194, seconds: { min: 4, max: 30 }, verified: false,
                      note: "ByteDance Seedance 2.5 through ePhone AI (official channel), 720p, about 0.194 $/s (kie.ai: 0.315). Not yet exercised." },
};
export const DEFAULT_KIE_MODEL = "minimax-h3";

// The kie.ai client (the endpoints, KieError, the call itself, the no-credit test) lives in src/kie.ts since 25
// September 2026, so the stills engine can draw through it too; every name this module used to export still is.
export { KIE_BASE, KIE_CREATE, KIE_RECORD, KIE_CREDIT, USD_PER_KIE_CREDIT, KieError, isNoCredit };

/* ------------------------------------------------------------------ the decision */

/** The whole-video cap of the test phase: a film longer than this takes the local road, whatever the switch says. */
export const DEFAULT_KIE_MAX_VIDEO_S = 20;

/**
 * Which road a filmed job takes. Pure, so vast.ts (the machine to rent), internal.ts (the job spec the box reads)
 * and jobs.ts (the token check) cannot disagree: the same env and the same job give the same answer everywhere.
 * `override` is the admin route's live setting (footageConfig), read once by the caller.
 */
export function footageBackendFor(env: Pick<Env, "KIE_API_KEY" | "EPHONE_API_KEY" | "KLEO_FOOTAGE_BACKEND" | "KLEO_FOOTAGE_MODEL" | "KIE_MAX_VIDEO_S">, job: Pick<Job, "params">, override: FootageOverride | null = null): FootageBackend {
  const wanted = (override?.backend ?? env.KLEO_FOOTAGE_BACKEND ?? "").trim().toLowerCase();
  if (wanted !== "kie") return "local";
  // The key of the road the model is bought on ("kie" is the name of the API road, whichever provider sells the clip).
  const key = clipProviderOf(kieModelFor(env, override).spec) === "ephone" ? env.EPHONE_API_KEY : env.KIE_API_KEY;
  if (!(key && key.trim())) return "local";
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
 * are the storyboard's when the caller wrote one, else the planner's density on the API road: one shot per clip floor
 * (the model's shortest clip, PREFLIGHT_SHOT_S at the least), never more than the storyboard cap. Until 25 September
 * it assumed a shot every 2.5 s and never fewer than six, the density of the films before the clip floor: a 15 s film
 * on Seedance was pre-flighted at 24 billed seconds (30 with the margin) for the 16 it buys, and could be refused on a
 * balance that pays it;
 * each clip covers the average shot through the same clipSecondsFor/clipCostUsd as the order itself, and the total
 * carries PREFLIGHT_MARGIN because the voice decides the real cut times and some shots are billed a whole second
 * more (the 15 s film of 15 September: average 1.82 $, order 1.885 $). A pre-flight that passes a film the box then
 * cannot pay for is the rental this exists to prevent; one that refuses a marginal balance costs nothing, and the
 * exact gate is still requestFootage on the box. Four films rented a card, drew their frames and voiced their
 * script on 15 September before learning kie.ai held 0.07 $: this is the number that lets createJob say so first.
 */
export function plannedFilmUsd(env: Env, cfg: FootageOverride | null, seconds: number, shots: number | null, maxShots: number): { usd: number; shots: number; model: string } {
  const { name, spec } = kieModelFor(env, cfg);
  const n = shots && shots > 0 ? shots : Math.max(1, Math.min(maxShots, Math.ceil(seconds / Math.max(PREFLIGHT_SHOT_S, clipMinSeconds(spec)))));
  const each = clipCostUsd(spec, clipSecondsFor(spec, seconds / n));
  return { usd: Math.round(each * n * PREFLIGHT_MARGIN * 1000) / 1000, shots: n, model: name };
}
export const PREFLIGHT_SHOT_S = 2.5;

/** The shortest clip a model films: a shot shorter than this is still bought, and billed, this long. */
export const clipMinSeconds = (spec: Pick<KieModel, "seconds">): number => (Array.isArray(spec.seconds) ? Math.min(...spec.seconds) : spec.seconds.min);

/**
 * THE CLIP LENGTHS THE BOX MAY ORDER (25 September 2026), in the job spec's "footage": the worker cuts every scene of
 * a film on the API road to whole clips of these lengths and fits the voice to them (worker/kleo_worker.py
 * fit_to_clips), so each clip is ordered at exactly its shot's length and laid in full. A range model sends its
 * bounds; a model that films a few lengths only (Veo, Gemini) sends them too, because a range cannot say "4, 6 or 8".
 */
export function clipLengthsSpec(spec: Pick<KieModel, "seconds">): { clip_min_s: number; clip_max_s: number; clip_seconds?: number[] } {
  if (Array.isArray(spec.seconds)) {
    const listed = [...spec.seconds].sort((a, b) => a - b);
    return { clip_min_s: listed[0], clip_max_s: listed[listed.length - 1], clip_seconds: listed };
  }
  return { clip_min_s: spec.seconds.min, clip_max_s: spec.seconds.max };
}

/**
 * THE CLIP FLOOR OF A JOB (25 September 2026): the seconds every shot carries at the least, so the planner writes no
 * shot shorter than the clip it is billed as. A film on the API road has its model's shortest clip; the animatic and
 * the local road have none (0), and keep the seven-word rule of 22 September (src/keou-contract.ts shotBudget).
 */
export function clipFloorFor(env: Pick<Env, "KIE_API_KEY" | "EPHONE_API_KEY" | "KLEO_FOOTAGE_BACKEND" | "KLEO_FOOTAGE_MODEL" | "KIE_MAX_VIDEO_S">, job: { product?: string | null; duration_s: number }, cfg: FootageOverride | null = null): number {
  if (job.product !== "film") return 0;
  if (footageBackendFor(env, { params: JSON.stringify({ duration_s: job.duration_s }) }, cfg) !== "kie") return 0;
  return clipMinSeconds(kieModelFor(env, cfg).spec);
}
export const PREFLIGHT_MARGIN = 1.25;

/**
 * WHAT A FILM'S PICTURES WILL COST ON KIE.AI (25 September 2026): 0 unless STILL_MODEL draws there (Nano Banana Pro
 * since that day); otherwise one still per shot and three character sheets, times 1.3 for the redraws the vision
 * judge asks for (the fidelity bench: about one still in three is drawn twice). The pictures are bought from the same
 * kie.ai balance as the clips and BEFORE them, so a balance that pays the clips alone would see the film stop at its
 * first clip: the pre-flight asks for both.
 */
export const PREFLIGHT_SHEETS = 3;
export const PREFLIGHT_STILL_REDRAWS = 1.3;
export function plannedStillsUsd(env: Pick<Env, "STILL_MODEL">, pictures: number): number {
  const model = stillModel(env);
  if (stillProviderOf(model).provider !== "kie") return 0;
  const each = stillPriceUsd(model, STILL_SIZES["9:16"]) ?? 0, sheet = stillPriceUsd(model, SHEET_SIZE) ?? 0;
  return Math.round((Math.max(0, pictures) * each + PREFLIGHT_SHEETS * sheet) * PREFLIGHT_STILL_REDRAWS * 1000) / 1000;
}

/**
 * The pre-flight of a film: can kie.ai pay for it right now? `null` when kie.ai did not answer (a monitoring call
 * never refuses a film: the order gate in requestFootage decides then), otherwise the balance and the plan so the
 * caller can refuse in numbers. Six seconds at most, like kieBalanceUsd.
 */
export async function kiePreflight(env: Env, seconds: number, shots: number | null, maxShots: number): Promise<{ ok: boolean; reason: "balance" | "budget" | null; balance_usd: number | null; planned_usd: number; spent_today_usd: number; budget_usd: number; shots: number; model: string; stills_usd?: number }> {
  const cfg = await footageConfig(env);
  const plan = plannedFilmUsd(env, cfg, seconds, shots, maxShots);
  // The same two gates the order itself will meet on the box (requestFootage): today's ceiling first, then the account.
  const budget = num(env.DAILY_FOOTAGE_BUDGET_USD, 5);
  const spent = await footageSpentTodayUsd(env);
  if (spent + plan.usd > budget) return { ok: false, reason: "budget", balance_usd: null, planned_usd: plan.usd, spent_today_usd: spent, budget_usd: budget, shots: plan.shots, model: plan.model };
  // The account pays the pictures too when they are drawn on kie.ai (plannedStillsUsd); today's ceiling above is the
  // clips' own (the pictures have theirs: STILLS_JOB_MAX_USD, STILLS_DAILY_USD in src/stills.ts).
  const stills = plannedStillsUsd(env, plan.shots);
  // Clips bought on ePhone AI are paid from that account; the pictures (on kie.ai) then have a balance of their own,
  // and an empty one only moves them to klein-4B (src/stills.ts), it never stops the film.
  if (clipProviderOf(kieModelFor(env, cfg).spec) === "ephone") {
    const balance = await ephoneBalanceUsd(env);
    const ok = balance === null || balance >= plan.usd;
    return { ok, reason: ok ? null : "balance", balance_usd: balance, planned_usd: plan.usd, spent_today_usd: spent, budget_usd: budget, shots: plan.shots, model: plan.model };
  }
  const balance = await kieBalanceUsd(env);
  const ok = balance === null || balance >= plan.usd + stills;
  return { ok, reason: ok ? null : "balance", balance_usd: balance, planned_usd: plan.usd, spent_today_usd: spent, budget_usd: budget, shots: plan.shots, model: plan.model, ...(stills > 0 ? { stills_usd: stills } : {}) };
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

/**
 * The camera sentence of one shot: its move in plain words, and a calm pace for a gentle shot. The pace used to read
 * "Gentle, slow motion of the camera." — and a video model reads "slow motion" as SLOW-MO (24 September 2026, the
 * fidelity review): people moving underwater in a shot that only wanted a steady camera. It now says what it means.
 */
export function cameraSentence(shot: { motion?: string | null; strength?: number | null }): string {
  const move = KIE_MOVES[String(shot.motion ?? "")] ?? KIE_MOVES.push_in;
  const pace = typeof shot.strength === "number" && shot.strength < 0.4 ? " The camera moves slowly and steadily." : "";
  return `${move.charAt(0).toUpperCase()}${move.slice(1)}.${pace}`;
}

/** subject first, then the camera, then the look — the order every model reads with the most weight at the front. */
export function kiePrompt(shot: { image_prompt: string; motion?: string | null; strength?: number | null }, look: FilmLook = "realistic"): string {
  const subject = String(shot.image_prompt ?? "").trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "");
  return `${subject}. ${cameraSentence(shot)} ${KIE_LOOKS[look]}`.replace(/\s+/g, " ").trim();
}

/**
 * THE CLIP PROMPT, composed from the STORED storyboard (24 September 2026, the fidelity engine). The box sends only
 * the shot's image_prompt and its camera, and that is all the clip model ever read: not what happens during the shot,
 * not who the characters are, not where. Now the server finds the shot by its picture id in job.storyboard and writes:
 *   1. what MOVES during the shot — the planner's `action` (the image_prompt when the shot has none): the first frame
 *      already shows the picture, the clip model needs the motion;
 *   2. every character in it with their full look (the spec's, uncut), so a turn of the head keeps the face;
 *   3. the place (the direction's world, or the spec's place items the shot covers);
 *   4. the camera sentence, then the look paragraph — minus its "No text" when the shot carries a text the user asked
 *      to be read on screen, which the clip must keep, not erase.
 * A shot that is not in the stored storyboard (a box that sends one the server never planned) keeps kiePrompt.
 */
export function clipPrompt(shot: { id: string; image_prompt: string; motion?: string | null; strength?: number | null }, look: FilmLook, stored: { storyboard: unknown; spec: RequestSpec | null } | null): string {
  const pic = stored ? stillShotsOf(stored.storyboard).find((p) => p.id === shot.id) : undefined;
  if (!pic || !stored) return kiePrompt(shot, look);
  const spec = stored.spec;
  const direction = directionOf(stored.storyboard);
  const tidy = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ").replace(/[.;,\s]+$/, "");
  const covered = spec ? (pic.covers ?? []).map((id) => itemById(spec, id)).filter((x): x is SpecItem => !!x) : [];
  const what = tidy(pic.action || pic.image_prompt || shot.image_prompt);
  const cast = stillCast(pic, spec, direction).map((m) => `${tidy(m.name)}: ${tidy(m.look)}`);
  const place = tidy(direction?.world) || covered.filter((i) => i.kind === "place").map((i) => tidy(i.text)).join("; ");
  const keepsText = covered.some((i) => i.kind === "text");
  const lookText = keepsText ? KIE_LOOKS[look].replace(/\s*No text, no captions, no logos\.?/i, "") : KIE_LOOKS[look];
  return [what, ...cast, place ? `Setting: ${place}` : ""].filter(Boolean).map((s) => `${s}.`).concat([cameraSentence(shot), lookText]).join(" ").replace(/\s+/g, " ").trim();
}

/**
 * THE SEEDANCE PROMPT (25 September 2026). Seedance 2.5 on ePhone AI is given the shot's first frame, so the picture —
 * who is there, what they wear, where — is already said; what it lacks is what HAPPENS, when, and how the camera moves.
 * clipPrompt was written for the kie.ai models and re-describes the frame (every look, the setting) and ends on a look
 * paragraph with "35mm" and "shallow depth of field", which Seedance reads as a second picture to morph towards. This
 * prompt follows ByteDance's own guidance for image-to-video, in four parts, 350-900 characters, never over 1990:
 *   1. MOTION: "Continue from the first frame: <action>." — the planner's action, or a motion that fits the shot's kind,
 *      never the image prompt again; the characters in the frame are named, not re-described;
 *   2. TIMING: the action inside the part of the clip the film keeps (0s-<used>s), and a settle after it when the clip
 *      is longer than the shot, so the cut never lands mid-gesture;
 *   3. CAMERA: exactly one move, in the words Seedance's examples use; the word "fast" never (it reads as sped-up);
 *   4. STYLE AND CONSTRAINTS as positive words: the look of the frame, one continuous shot at real-time speed, stable
 *      faces and hands, and no lettering — unless the shot keeps a text the user asked for.
 * Without a first frame (a still that failed to upload) the call is text-to-video, and the picture is described as
 * clipPrompt describes it: the image, every look in full, the setting.
 */
export const SEEDANCE_MOVES: Record<string, string> = {
  push_in: "slow push-in toward the subject",
  crash_zoom_in: "sudden push-in that snaps to a close-up",
  push_in_dutch: "slow push-in while the horizon tilts a few degrees",
  pull_out: "slow pull-out, more of the place entering the frame",
  track_left: "smooth tracking shot moving to the left",
  track_right: "smooth tracking shot moving to the right",
  track_alongside: "smooth tracking shot alongside the subject, at its pace",
  orbit_left: "slow arc around the subject to the left",
  orbit_right: "slow arc around the subject to the right",
  crane_down: "slow crane down from above to eye level",
  crane_up: "slow crane up, the ground falling away",
  whip_pan: "quick whip pan to the right that settles",
  static_hold: "locked off on a tripod, only the scene moves",
};
/** What moves in a shot the planner gave no action, by what the shot is for (src/shot-grammar.ts SHOT_KINDS). */
export const SEEDANCE_KIND_MOTION: Record<string, string> = {
  hook: "the moment is already under way: the subject moves with intent and the scene around it reacts",
  establish: "the place is alive: the light shifts, the air and small things move, people go about their business in the distance",
  face: "the face moves subtly: a breath, the eyes shift, a small change of expression",
  detail: "hands touch and handle the object with small, precise movements while the light plays on it",
  detail_orbit: "the object stays still while the light glides slowly over its surface",
  action: "the action carries on: the subject moves through it with natural weight and momentum",
  reveal: "the subject moves and what was hidden behind it comes into view",
  tension: "a held stillness with small nervous movements: a breath, a glance, fingers tightening",
  closing: "the movement slows to a quiet stop and the moment is held",
  static_forced: "the scene holds still with only small natural movements",
  default: "the scene comes alive with natural movement that carries on from what the frame shows",
};
export const SEEDANCE_STYLE: Record<FilmLook, string> = {
  realistic: "Style: live-action film look, natural light, real textures, subtle film grain; keep the first frame's composition, faces, costumes and colours.",
  animation: "Style: 2D hand-drawn animation, cel colour, clean linework, exactly the first frame's drawn style and character designs, nothing photographic, no 3D render.",
};
/** The same looks with no first frame to keep (text-to-video). */
const SEEDANCE_STYLE_T2V: Record<FilmLook, string> = {
  realistic: "Style: live-action film look, natural light, real textures, subtle film grain.",
  animation: "Style: 2D hand-drawn animation, cel colour, clean linework, consistent character designs, nothing photographic, no 3D render.",
};
/**
 * The shot's action without "fast" (rule 3 above), which reaches it from Kleo's own motion hint ("the mist drifting
 * fast across the frame", direction.ts ENLIVEN) and from the guide: after a verb it becomes "steadily", before a noun
 * or a participle it goes ("a fast car" is "a car", "fast-moving clouds" are "moving clouds").
 */
const VERB_BEFORE_FAST_RE = /(?:ing|ed|es|s)$|^(?:move|go|run|drift|flow|spin|turn|fall|blow|rush|walk|ride|swim|fly|roll|race)$/i;
export const unhurried = (s: string): string =>
  s.replace(/(\S+\s+)?\b(?:very\s+)?fast(?:er|est)?\b(-|\s*)/gi, (_m, prev: string | undefined, after: string) =>
    prev && VERB_BEFORE_FAST_RE.test(prev.trim()) ? `${prev}steadily${after === "-" ? " " : after}` : prev ?? "").replace(/\s+/g, " ").trim();

/** Seedance's prompt limit on ePhone AI is 2000 characters; the prompt stays under it with room to spare. */
export const SEEDANCE_PROMPT_MAX = 1990;

export function seedancePrompt(
  shot: { id: string; image_prompt: string; motion?: string | null; strength?: number | null },
  look: FilmLook,
  stored: { storyboard: unknown; spec: RequestSpec | null } | null,
  opts: { clipSeconds: number; usedSeconds: number; keepsText: boolean; hasFrame: boolean },
): string {
  const tidy = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ").replace(/[.;,\s]+$/, "");
  const pic = stored ? stillShotsOf(stored.storyboard).find((p) => p.id === shot.id) : undefined;
  const spec = stored?.spec ?? null;
  const direction = stored ? directionOf(stored.storyboard) : null;
  const cast = pic ? stillCast(pic, spec, direction) : [];
  const covered = spec && pic ? (pic.covers ?? []).map((id) => itemById(spec, id)).filter((x): x is SpecItem => !!x) : [];
  const action = unhurried(tidy(pic?.action)) || SEEDANCE_KIND_MOTION[pic?.shot_kind ?? ""] || SEEDANCE_KIND_MOTION.default;
  const secs = (n: number) => `${Math.round(n * 10) / 10}s`;
  const used = Math.min(opts.usedSeconds, opts.clipSeconds);
  // What is on screen and what moves (parts 1), then how it is timed, shot and looked at (parts 2-4).
  const head: string[] = [];
  if (opts.hasFrame) {
    head.push(`Continue from the first frame: ${action}.`);
    const names = cast.map((m) => tidy(m.name)).filter(Boolean);
    if (names.length) head.push(`${names.join(" and ")} ${names.length > 1 ? "stay" : "stays"} exactly as in the first frame.`);
  } else {
    // Text-to-video: nothing on screen yet, so the picture is described, looks and all (as clipPrompt does).
    head.push(`${tidy(pic?.image_prompt || shot.image_prompt)}.`, `${action.charAt(0).toUpperCase()}${action.slice(1)}.`);
    for (const m of cast) head.push(`${tidy(m.name)}: ${tidy(m.look).slice(0, 300)}.`);
    const place = tidy(direction?.world) || covered.filter((i) => i.kind === "place").map((i) => tidy(i.text)).join("; ");
    if (place) head.push(`Setting: ${place}.`);
  }
  const lettering = opts.keepsText ? covered.find((i) => i.kind === "text") : undefined;
  const tail = [
    opts.clipSeconds - used >= 0.3
      ? `Timing: 0s-${secs(used)} the action above; ${secs(used)}-${secs(opts.clipSeconds)} the motion settles and the move carries on gently.`
      : `Timing: 0s-${secs(opts.clipSeconds)} the action above, in one continuous movement.`,
    `Camera: ${SEEDANCE_MOVES[String(shot.motion ?? "")] ?? SEEDANCE_MOVES.push_in}.`,
    (opts.hasFrame ? SEEDANCE_STYLE : SEEDANCE_STYLE_T2V)[look],
    `One continuous shot at natural real-time speed, no slow motion; faces, hands and bodies stay stable, no morphing; ${lettering ? `the lettering on ${tidy(lettering.text)} stays exactly as in the first frame` : opts.keepsText ? "the lettering on screen stays exactly as it is" : "no text, subtitles, logos or watermark"}.`,
  ].join(" ");
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  let first = flat(head.join(" "));
  // Over the limit (only a text-to-video prompt with long looks gets near it): what is on screen is shortened, never
  // the timing, the camera or the constraints.
  const room = SEEDANCE_PROMPT_MAX - flat(tail).length - 1;
  if (first.length > room) first = `${first.slice(0, room - 1).replace(/\s+\S*$/, "").replace(/[.;,:\s]+$/, "")}.`;
  return `${first} ${flat(tail)}`;
}

/** Whether a model is asked in Seedance's words (seedancePrompt) rather than the kie.ai models' (clipPrompt). */
export const usesSeedancePrompt = (name: string, spec: KieModel): boolean => clipProviderOf(spec) === "ephone" || name.startsWith("seedance");

/**
 * Whether the stored shot carries a text the user asked to be READ on screen (a spec item of kind "text" among its
 * covers) — the same question clipPrompt asks before it drops its "No text" sentence. requestFootage asks it again
 * for the NEGATIVE prompt (24 September 2026): on the Wan road kieInput always sent KIE_NEGATIVES, whose first words
 * are "text, letters, … subtitles", so the positive prompt said keep the sign and the negative said erase it, and the
 * shop sign the still was drawn with dissolved during the clip.
 */
export function clipKeepsText(shotId: string, stored: { storyboard: unknown; spec: RequestSpec | null } | null): boolean {
  const spec = stored?.spec;
  if (!stored || !spec) return false;
  const pic = stillShotsOf(stored.storyboard).find((p) => p.id === shotId);
  return !!pic && (pic.covers ?? []).some((id) => itemById(spec, id)?.kind === "text");
}

/** The negative prompt of a look, minus the words that ban lettering when the shot must keep a text on screen (watermark and logo stay banned). */
export function kieNegativeFor(look: FilmLook, keepsText = false): string {
  const neg = KIE_NEGATIVES[look];
  if (!keepsText) return neg;
  return neg.split(",").map((t) => t.trim()).filter((t) => t && !/^(?:text|letters|subtitles|captions?)$/i.test(t)).join(", ");
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

/* ------------------------------------------------------------------ kie.ai client (src/kie.ts) */

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
export function noCreditSentence(ordered: number, wanted: number, provider: "kie" | "ephone" = "kie"): string {
  const who = provider === "ephone" ? "ePhone AI" : "kie.ai";
  return `${who} balance is empty: ${ordered} of ${wanted} shots could be ordered before it ran out. Top up the ${who} account and ask for the video again; this video was not made and its credits are refunded`;
}

/**
 * The `input` of an ePhone AI video task (25 September 2026; the Seedance 2.5 API tab on platform.ephone.ai):
 *   doubao-seedance-2-5-260628  prompt (≤ 2000 chars), first_frame (URL), duration (int 4-30), resolution
 *                                480p|720p|1080p, aspect_ratio, generate_audio, watermark
 * Audio off (the narration is Kleo's), no watermark. Without a still the call is text-to-video, which Seedance allows.
 */
export function ephoneInput(name: string, spec: KieModel, p: { prompt: string; imageUrl: string | null; seconds: number; format: string }): Record<string, unknown> {
  // With a first frame Seedance 2.5 takes only aspect_ratio "adaptive" (the frame's own ratio): "9:16" was refused on
  // the first real task, 25 September 2026 ("首帧/首尾帧任务仅支持 ratio=adaptive"). The still is drawn in the film's format.
  const aspect = p.imageUrl ? "adaptive" : p.format === "16:9" ? "16:9" : "9:16";
  return { prompt: p.prompt.slice(0, 2000), ...(p.imageUrl ? { first_frame: p.imageUrl } : {}), duration: clipSecondsFor(spec, p.seconds), resolution: spec.resolution ?? "720p", aspect_ratio: aspect, generate_audio: false, watermark: false };
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
export function kieInput(name: string, spec: KieModel, p: { prompt: string; imageUrl: string | null; seconds: number; format: string; seed: number; look?: FilmLook; keepsText?: boolean }): Record<string, unknown> {
  const aspect = p.format === "16:9" ? "16:9" : "9:16";
  const duration = clipSecondsFor(spec, p.seconds);
  if (name.startsWith("kling-3.0")) {
    const mode = name.endsWith("-std") ? "std" : name.endsWith("-4k") ? "4K" : "pro";
    return { prompt: p.prompt, ...(p.imageUrl ? { image_urls: [p.imageUrl] } : {}), duration: String(duration), aspect_ratio: aspect, mode, sound: false, multi_shots: false };
  }
  if (name.startsWith("kling-v3-turbo")) return { prompt: p.prompt, ...(p.imageUrl ? { image_urls: [p.imageUrl] } : {}), duration: String(duration), resolution: "1080p" };
  if (name.startsWith("veo")) return { prompt: p.prompt, ...(p.imageUrl ? { image_urls: [p.imageUrl], generation_type: "FIRST_AND_LAST_FRAMES_2_VIDEO" } : { generation_type: "TEXT_2_VIDEO" }), aspect_ratio: aspect, resolution: "1080p", duration };
  if (name.startsWith("wan")) return { prompt: p.prompt, negative_prompt: kieNegativeFor(p.look ?? "realistic", !!p.keepsText), ...(p.imageUrl ? { first_frame_url: p.imageUrl } : {}), resolution: "1080p", duration, seed: p.seed, prompt_extend: false, watermark: false };
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
  const provider = clipProviderOf(spec);
  if (fresh.length) {
    const balance = provider === "ephone" ? await ephoneBalanceUsd(env) : await kieBalanceUsd(env);
    if (balance !== null && balance < planned) {
      await audit(env, job.user_id, job.id, "footage.no_credit", { balance_usd: balance, planned_usd: Math.round(planned * 1000) / 1000, model: name, provider, ordered: 0, wanted: fresh.length });
      return { status: 402, reply: { error: noCreditSentence(0, fresh.length, provider), no_credit: true, balance_usd: balance, planned_usd: Math.round(planned * 1000) / 1000 } };
    }
  }
  const exp = Math.floor(Date.now() / 1000) + 6 * 60 * 60;
  // The stored storyboard and spec the clip prompts are written from (clipPrompt); a job without one keeps kiePrompt.
  let stored: { storyboard: unknown; spec: RequestSpec | null } | null = null;
  try { if (job.storyboard) stored = { storyboard: JSON.parse(job.storyboard) as unknown, spec: specOf(JSON.parse(job.params)) }; } catch { stored = null; }
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
    const keepsText = clipKeepsText(s.id, stored);
    const prompt = usesSeedancePrompt(name, spec)
      ? seedancePrompt(s, look, stored, { clipSeconds, usedSeconds: seconds, keepsText, hasFrame: !!imageUrl })
      : clipPrompt(s, look, stored);
    // The row goes in BEFORE the call, with no task id: a second request while the first is in flight orders nothing twice.
    // A refused row from an earlier request is reset in place instead (same key, new price, no error).
    if (retryable(have.get(s.id))) await updateRow(env, job.id, s.id, { state: "queued", model: name, seconds, cost_usd: cost, error: null });
    else await env.DB.prepare("INSERT OR IGNORE INTO footage (job_id, shot_id, model, state, seconds, cost_usd, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)")
      .bind(job.id, s.id, name, seconds, cost, nowIso()).run();
    try {
      let taskId: string | undefined;
      if (provider === "ephone") {
        const r = await ephone<{ id?: string }>(env, "POST", "/v1/task/submit", { model: spec.model, input: ephoneInput(name, spec, { prompt, imageUrl, seconds, format }) });
        taskId = typeof r?.id === "string" && r.id ? r.id : undefined;
        if (!taskId) throw new KieError("ephone.ai answered without a task id", 0, false);
      } else {
        const r = await kie<{ taskId?: string }>(env, "POST", KIE_CREATE, { model: spec.model, input: kieInput(name, spec, { prompt, imageUrl, seconds, format, seed: seedFor(s.id), look, keepsText }) });
        taskId = r?.taskId;
        if (!taskId) throw new KieError("kie.ai answered without a taskId", 0, false);
      }
      await updateRow(env, job.id, s.id, { task_id: taskId, state: "generating" });
      await audit(env, job.user_id, job.id, "footage.task", { shot: s.id, model: name, provider, task: taskId, clip_s: clipSeconds, want_s: seconds, usd: cost, still: !!imageUrl });
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
    await audit(env, job.user_id, job.id, "footage.no_credit", { model: name, provider, ordered, wanted: fresh.length });
    return { status: 402, reply: { ...reply.reply, ordered, no_credit: true, error: noCreditSentence(ordered, fresh.length, provider) } };
  }
  return { status: 200, reply: { ...reply.reply, ordered } };
}

/**
 * GET /footage: asks kie.ai about every generating shot, downloads the finished ones to R2 (one download per clip,
 * ever: the row's `key` says it is there), and answers the worker's view. `poll` false skips the network (right
 * after creation nothing is ready yet).
 */
export async function footageStatus(env: Env, job: Job, poll = true): Promise<{ status: number; reply: Record<string, unknown> }> {
  const rows = await footageRows(env, job.id);
  if (poll) for (const row of rows) {
    if (row.state !== "generating" || !row.task_id || row.shot_id === MUSIC_ID) continue;
    try {
      if (clipProviderOf(KIE_MODELS[row.model] ?? {}) === "ephone") {
        const t = await ephone<EphoneTask>(env, "GET", `/v1/task/${encodeURIComponent(row.task_id)}`);
        const st = String(t?.status ?? "").toLowerCase();
        if (st === "completed") {
          const urls = ephoneOutputs(t);
          if (!urls.length) throw new KieError("ephone.ai task completed without an output url", 0, false);
          await downloadClip(env, job, row, urls[0]);
          if (t.usage) await audit(env, job.user_id, job.id, "footage.usage", { shot: row.shot_id, task: row.task_id, usage: t.usage });
        } else if (st === "failed") {
          const msg = ephoneFailure(t);
          await updateRow(env, job.id, row.shot_id, { state: "failed", error: msg });
          await audit(env, job.user_id, job.id, "footage.failed", { shot: row.shot_id, task: row.task_id, error: msg });
        } else if (minutesSinceIso(row.created_at) > 30) {
          await updateRow(env, job.id, row.shot_id, { state: "failed", error: `still ${st || "pending"} after 30 minutes` });
          await audit(env, job.user_id, job.id, "footage.failed", { shot: row.shot_id, task: row.task_id, error: "timeout" });
        }
        continue;
      }
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
  // The music row (MUSIC_ID, below) is a task like the others for the money, but not a clip: the box's lists never see it.
  const now = (await footageRows(env, job.id)).filter((r) => r.shot_id !== MUSIC_ID);
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

const resultUrls = kieResultUrls;
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

/* ------------------------------------------------------------------ the music track (22 September 2026) */

/**
 * THE USER'S MUSIC. When they said yes (src/adaptive.ts asks every time), the treatment carries a one-line brief for
 * the composer and the storyboard says `music: "track"`; the box asks for the track here, waits, and ducks it under
 * the narration (kleo_worker.py fetch_music). The composer is Suno through kie.ai's unified API — the same
 * createTask / recordInfo pair the clips use, model "ai-music-api/generate", read off its pricing page: 12 kie
 * credits = $0.06 a request, whatever the length, two tracks back (the first is used). Exercised once for real on
 * 22 September (task 03d4a341…): 22 seconds to a 38.4 s instrumental, the answer's resultJson is Suno's own shape —
 * {"code":200,"data":[{"audio_url":…,"duration":38.4,…},{…}]} — not the clips' {"resultUrls":[…]}; audioUrls reads both. One row in the footage table
 * under the shot id MUSIC_ID, so today's ceiling (DAILY_FOOTAGE_BUDGET_USD) counts the dollar the moment it is
 * committed, exactly like a clip; it is left out of the clip lists the box reads.
 *
 * Refusals are soft: a film is never lost for its music. No key, KLEO_MUSIC=off, the ceiling, an empty account —
 * the route answers 409/402 and the box makes the film without the track (and says so in its log).
 */
export const MUSIC_ID = "music";
export const MUSIC_MODEL = "ai-music-api/generate";
export const MUSIC_USD = 0.06;
/** Suno V6: `duration` is accepted only with V5_5, V6, V6_WILD or V6_MINI (the API said so on 22 September: code 422 on V5). */
export const DEFAULT_MUSIC_VERSION = "V6";
export const musicKey = (jobId: string) => `renders/${jobId}/music.mp3`;

/**
 * Where the track is bought (25 September 2026): kie.ai (default) or ePhone AI (KLEO_MUSIC_PROVIDER "ephone": Suno
 * through ePhone's unified task API, model "suno/music", $0.08 x 0.8 = $0.064 a call).
 */
export const musicProviderOf = (env: Pick<Env, "KLEO_MUSIC_PROVIDER">): "kie" | "ephone" => ((env.KLEO_MUSIC_PROVIDER ?? "").trim().toLowerCase() === "ephone" ? "ephone" : "kie");
export const EPHONE_MUSIC_MODEL = "suno/music";
export const EPHONE_MUSIC_USD = 0.064;
export function musicOn(env: Pick<Env, "KIE_API_KEY" | "EPHONE_API_KEY" | "KLEO_MUSIC" | "KLEO_MUSIC_PROVIDER">): boolean {
  const key = musicProviderOf(env) === "ephone" ? env.EPHONE_API_KEY : env.KIE_API_KEY;
  return !!(key && key.trim()) && (env.KLEO_MUSIC ?? "").trim().toLowerCase() !== "off";
}
/**
 * The input of Suno on ePhone AI (docs.rixapi.com guides/suno-quickstart, 25 September 2026): the description mode —
 * one line for the composer, instrumental — since the custom mode needs lyrics. The line carries the brief and what a
 * score under a voice must be; Suno caps it, so it is kept short.
 */
export function ephoneMusicInput(req: MusicRequest): Record<string, unknown> {
  const brief = String(req.brief ?? "").trim().replace(/\s+/g, " ").slice(0, 200) || "a quiet instrumental bed under a narration";
  return { mv: "chirp-v6", custom: false, instrumental: true, gpt_description_prompt: `${brief}. Instrumental film score under a narrator, no vocals, steady dynamics.`.slice(0, 390) };
}
/** The audio URL of a finished ePhone Suno task: the first output that looks like audio, else the first output. */
export function ephoneAudioUrl(outputs: string[]): string | null {
  return outputs.find((u) => /\.(mp3|m4a|wav|ogg|aac)(\?|$)/i.test(u)) ?? outputs.find((u) => !/\.(png|jpe?g|webp)(\?|$)/i.test(u)) ?? null;
}
export const musicVersion = (env: Pick<Env, "KIE_MUSIC_VERSION">): string => (env.KIE_MUSIC_VERSION ?? "").trim() || DEFAULT_MUSIC_VERSION;

/** What the box sends: the brief the treatment wrote, the film's length and its title (Suno wants one in custom mode). */
export interface MusicRequest { brief: string; seconds: number; title?: string }

/** The `input` of the generate call: custom mode (a style and a title, no lyrics), instrumental, a length that covers the film. */
export function musicInput(req: MusicRequest, version: string): Record<string, unknown> {
  const brief = String(req.brief ?? "").trim().replace(/\s+/g, " ").slice(0, 900) || "a quiet instrumental bed under a narration";
  const seconds = Math.max(15, Math.min(360, Math.round(Number(req.seconds) || 30) + 8));
  const title = String(req.title ?? "").trim().replace(/\s+/g, " ").slice(0, 72) || "Kleo film score";
  return {
    custom_mode: true, instrumental: true, model: version,
    // The words a composer reads: the brief, then what a score under a voice must be. No vocals is said twice
    // (the flag and the words): a track with a singer under a narrator is a ruined film.
    style: `${brief}. Instrumental score for a narrated short film: no vocals, no lyrics, no drops, leaves room for a speaking voice, steady dynamics, cinematic.`,
    title, negative_tags: "vocals, lyrics, singing, rap, choir, spoken word, drum solo",
    duration: seconds,
  };
}

/**
 * POST /music: one task, once. Idempotent on the row (a second call while the first is in flight orders nothing).
 * 409 when the road is closed (no key, switched off), 402 when the money says no; 200 with the row's state otherwise.
 */
export async function requestMusic(env: Env, job: Job, req: MusicRequest): Promise<{ status: number; reply: Record<string, unknown> }> {
  if (!musicOn(env)) return { status: 409, reply: { error: "music is not available on this server (no key for its provider, or KLEO_MUSIC=off)", state: "off" } };
  const provider = musicProviderOf(env);
  const brief = String(req.brief ?? "").trim();
  if (!brief) return { status: 400, reply: { error: "a music request carries the composer's brief" } };
  const have = (await footageRows(env, job.id)).find((r) => r.shot_id === MUSIC_ID);
  if (have && !(have.state === "failed" && !have.task_id)) return musicStatus(env, job, false);
  const version = musicVersion(env);
  const model = provider === "ephone" ? EPHONE_MUSIC_MODEL : `suno-${version.toLowerCase()}`;
  const trackUsd = provider === "ephone" ? EPHONE_MUSIC_USD : MUSIC_USD;
  const budget = num(env.DAILY_FOOTAGE_BUDGET_USD, 5);
  const spent = await footageSpentTodayUsd(env);
  if (spent + trackUsd > budget) {
    await audit(env, job.user_id, job.id, "music.budget", { spent_usd: spent, planned_usd: trackUsd, budget_usd: budget });
    return { status: 402, reply: { error: `today's kie.ai budget is spent ($${spent.toFixed(2)} committed + $${trackUsd.toFixed(2)} for the track > $${budget.toFixed(2)})`, state: "failed" } };
  }
  const balance = provider === "ephone" ? await ephoneBalanceUsd(env) : await kieBalanceUsd(env);
  if (balance !== null && balance < trackUsd) {
    await audit(env, job.user_id, job.id, "music.no_credit", { balance_usd: balance, planned_usd: MUSIC_USD });
    return { status: 402, reply: { error: `kie.ai balance ($${balance.toFixed(2)}) does not cover the track ($${MUSIC_USD.toFixed(2)})`, state: "failed", no_credit: true } };
  }
  const seconds = Math.max(1, Math.min(360, Number(req.seconds) || 30));
  if (have) await updateRow(env, job.id, MUSIC_ID, { state: "queued", model, seconds, cost_usd: trackUsd, error: null });
  else await env.DB.prepare("INSERT OR IGNORE INTO footage (job_id, shot_id, model, state, seconds, cost_usd, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)")
    .bind(job.id, MUSIC_ID, model, seconds, trackUsd, nowIso()).run();
  try {
    let taskId: string | undefined;
    if (provider === "ephone") {
      const r = await ephone<{ id?: string }>(env, "POST", "/v1/task/submit", { model: EPHONE_MUSIC_MODEL, input: ephoneMusicInput(req) });
      taskId = typeof r?.id === "string" && r.id ? r.id : undefined;
      if (!taskId) throw new KieError("ephone.ai answered without a task id", 0, false);
    } else {
      const r = await kie<{ taskId?: string }>(env, "POST", KIE_CREATE, { model: MUSIC_MODEL, input: musicInput({ ...req, seconds }, version) });
      taskId = r?.taskId;
      if (!taskId) throw new KieError("kie.ai answered without a taskId", 0, false);
    }
    await updateRow(env, job.id, MUSIC_ID, { task_id: taskId, state: "generating" });
    await audit(env, job.user_id, job.id, "music.task", { model, provider, task: taskId, seconds, usd: trackUsd, brief: brief.slice(0, 200) });
  } catch (e) {
    const msg = String(e).slice(0, 300);
    await updateRow(env, job.id, MUSIC_ID, { state: "failed", error: msg, cost_usd: 0 });
    await audit(env, job.user_id, job.id, "music.task.error", { model, error: msg });
    return { status: isNoCredit(e) ? 402 : 502, reply: { error: msg, state: "failed", ...(isNoCredit(e) ? { no_credit: true } : {}) } };
  }
  return musicStatus(env, job, false);
}

/**
 * GET /music: asks kie.ai about the task when it is still generating, copies the finished track to R2 once, and
 * answers {state, url?}: `url` is the route the box downloads it from (/internal/jobs/:id/music/file), never kie.ai's
 * own link (which expires and is not the box's to know).
 */
export async function musicStatus(env: Env, job: Job, poll = true): Promise<{ status: number; reply: Record<string, unknown> }> {
  let row = (await footageRows(env, job.id)).find((r) => r.shot_id === MUSIC_ID);
  if (!row) return { status: 404, reply: { state: "none", error: "no track was ordered for this video" } };
  if (poll && row.state === "generating" && row.task_id) {
    try {
      if (row.model === EPHONE_MUSIC_MODEL) {
        const t = await ephone<EphoneTask>(env, "GET", `/v1/task/${encodeURIComponent(row.task_id)}`);
        const st = String(t?.status ?? "").toLowerCase();
        if (st === "completed") {
          const url = ephoneAudioUrl(ephoneOutputs(t));
          if (!url) throw new KieError("ephone.ai music task completed without an audio url", 0, false);
          await downloadMusic(env, job, row, url);
        } else if (st === "failed") {
          const msg = ephoneFailure(t);
          await updateRow(env, job.id, MUSIC_ID, { state: "failed", error: msg });
          await audit(env, job.user_id, job.id, "music.failed", { task: row.task_id, error: msg });
        } else if (minutesSinceIso(row.created_at) > 15) {
          await updateRow(env, job.id, MUSIC_ID, { state: "failed", error: `still ${st || "pending"} after 15 minutes` });
          await audit(env, job.user_id, job.id, "music.failed", { task: row.task_id, error: "timeout" });
        }
        row = (await footageRows(env, job.id)).find((r) => r.shot_id === MUSIC_ID) ?? row;
        return { status: 200, reply: { state: row.state, model: row.model, cost_usd: row.cost_usd, ...(row.error ? { error: row.error } : {}), ...(row.state === "ready" ? { url: `/internal/jobs/${job.id}/music/file` } : {}) } };
      }
      const rec = await kie<KieRecord>(env, "GET", `${KIE_RECORD}?taskId=${encodeURIComponent(row.task_id)}`);
      const state = String(rec?.state ?? "").toLowerCase();
      if (state === "success") {
        const urls = audioUrls(rec);
        if (!urls.length) throw new KieError("task succeeded without a result url", 0, false);
        await downloadMusic(env, job, row, urls[0]);
      } else if (state === "fail" || state === "failed" || state === "error") {
        const msg = `${rec.failCode ?? ""} ${rec.failMsg ?? "kie.ai reported a failure"}`.trim().slice(0, 300);
        await updateRow(env, job.id, MUSIC_ID, { state: "failed", error: msg });
        await audit(env, job.user_id, job.id, "music.failed", { task: row.task_id, error: msg });
      } else if (minutesSinceIso(row.created_at) > 15) {
        await updateRow(env, job.id, MUSIC_ID, { state: "failed", error: `still ${state || "pending"} after 15 minutes` });
        await audit(env, job.user_id, job.id, "music.failed", { task: row.task_id, error: "timeout" });
      }
    } catch (e) {
      const msg = String(e).slice(0, 300);
      if (e instanceof KieError && !e.retryable && e.status !== 0) await updateRow(env, job.id, MUSIC_ID, { state: "failed", error: msg });
      await audit(env, job.user_id, job.id, "music.poll.error", { error: msg });
    }
    row = (await footageRows(env, job.id)).find((r) => r.shot_id === MUSIC_ID) ?? row;
  }
  return { status: 200, reply: { state: row.state, model: row.model, cost_usd: row.cost_usd, ...(row.error ? { error: row.error } : {}), ...(row.state === "ready" ? { url: `/internal/jobs/${job.id}/music/file` } : {}) } };
}

const MUSIC_MAX_BYTES = 40 * 1024 * 1024;

/** The track URLs of a finished music task: Suno's data[].audio_url (the shape measured), or the clips' resultUrls. */
export function audioUrls(rec: KieRecord & { response?: unknown }): string[] {
  const fromResult = resultUrls(rec);
  if (fromResult.length) return fromResult;
  let rj: unknown = rec.resultJson;
  if (typeof rj === "string") { try { rj = JSON.parse(rj); } catch { rj = null; } }
  const lists = [rj, rec.response].map((x) => (x && typeof x === "object" ? (x as { data?: unknown }).data : undefined));
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    const urls = list.map((t) => (t && typeof t === "object" ? (t as { audio_url?: unknown }).audio_url : undefined)).filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u));
    if (urls.length) return urls;
  }
  return [];
}

/** The finished track, from kie.ai's (temporary) URL to R2 under the job, once. An mp3 or an mp4/m4a container is accepted. */
async function downloadMusic(env: Env, job: Job, row: FootageRow, url: string): Promise<void> {
  const res = await fetch(url, { headers: { "user-agent": "kleo-mcp/1.0" } });
  if (!res.ok) throw new KieError(`track download → ${res.status}`, res.status, res.status >= 500 || res.status === 429);
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 1024 || buf.byteLength > MUSIC_MAX_BYTES) throw new KieError(`track download is ${buf.byteLength} bytes`, 0, false);
  const head = new Uint8Array(buf.slice(0, 12));
  const isMp3 = (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
  const isMp4 = new TextDecoder().decode(buf.slice(4, 8)) === "ftyp";
  if (!isMp3 && !isMp4) throw new KieError("track download is not an audio file", 0, false);
  const key = musicKey(job.id);
  const size = await putFile(env, key, buf, isMp3 ? "audio/mpeg" : "audio/mp4");
  await updateRow(env, job.id, MUSIC_ID, { state: "ready", key, result_url: url });
  await audit(env, job.user_id, job.id, "music.ready", { task: row.task_id, bytes: size });
}

/**
 * WHAT THE USER IS TOLD ABOUT THEIR MUSIC (22 September 2026). The fifth probe of the day (gt_tr4hfj5r) was ordered
 * with music, kie.ai's balance was $0.02, the route refused softly as designed — and the finished video was handed
 * over as if nothing had happened: silence between the sentences and no sentence about it anywhere the user could
 * read. A film without the music it asked for is a film with a defect the user must hear about, in words that say
 * whose action it is (the owner's: top up kie.ai). Null when no music was asked, or it is on the film.
 */
export async function musicNote(env: Env, job: Pick<Job, "id" | "params">): Promise<string | null> {
  let asked: unknown = undefined;
  try { asked = (JSON.parse(job.params) as { music?: unknown }).music; } catch { return null; }
  if (!asked) return null;
  const row = (await footageRows(env, job.id)).find((r) => r.shot_id === MUSIC_ID);
  if (row?.state === "ready") return null;
  const why = row?.error ? `: ${row.error.replace(/\s+/g, " ").slice(0, 160)}` : row ? ` (the track was ${row.state})` : " (the track could not be ordered: kie.ai's balance was empty or the service was off)";
  return `NOTE: the music the user asked for is NOT on this video${why}. Tell them so plainly; the rest of the video is as ordered. The operator has been logged (the fix is on Kleo's side: a kie.ai top-up), and they can ask for the video again later with the music.`;
}