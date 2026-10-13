/**
 * KLEO STUDIO — ONE CLIP, FROM CREDITS TO A STORED VIDEO.
 *
 *   create   check the settings, the plan and the budget → debit the credits → write the row (status submitting)
 *            → POST /v1/task/submit → status running (or failed + refund)
 *   refresh  GET /v1/task/{id} → completed: save the video to R2 (status saving → done)
 *                               failed / timed out: failed + refund
 *
 * The page refreshes a clip it is showing; the cron (src/studio/index.ts) refreshes the rest every minute, so a clip
 * finishes and is saved even after the person closed the tab. Every state change is a compare-and-set
 * (store.ts moveGeneration), so a refund is paid once and a video is saved once, whoever gets there first.
 *
 * Money rules (the same as the films'): the credits move first, the order follows; a refusal or a failure gives
 * them back; the provider bills only finished videos. An account that never paid may use only the free models
 * (models.ts freeModels).
 */
import type { StudioEnv } from "./env.ts";
import type { Env } from "../env";
import { ephone, ephoneOutputs, ephoneFailure, type EphoneTask } from "../ephone.ts";
import { KieError } from "../kie.ts";
import { debitCredits, refundCredits, getUser, hasPaid, audit } from "../db.ts";
import { publicText, rid } from "../util.ts";
import { clipCostUsd, clipCredits, freeModels, modelByKey, normalizeSettings, taskInput, DEFAULT_MARGIN, type ClipSettings } from "./models.ts";
import {
  getGeneration, insertGeneration, moveGeneration, markChecked, runningCount, studioSpentTodayUsd, uploadsOf,
  type GenerationRow,
} from "./store.ts";
import { signPath } from "./session.ts";

/** A refusal the page shows as it is (no provider names in it). */
export class StudioError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = "refused") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const asEnv = (env: StudioEnv): Env => env as unknown as Env;
const num = (v: string | undefined, d: number): number => { const n = parseFloat(v ?? ""); return Number.isFinite(n) ? n : d; };
export const marginOf = (env: StudioEnv): number => Math.max(1, num(env.STUDIO_MARGIN, DEFAULT_MARGIN));

/** Minutes a clip may stay with the provider before it is called failed and refunded. */
export const GENERATION_TIMEOUT_MIN = 45;
/** How long a provider may keep fetching a person's picture through its signed link. */
const IMAGE_LINK_TTL_S = 6 * 3600;

export interface CreateRequest {
  prompt: string;
  settings: Partial<Record<keyof ClipSettings, unknown>>;
  imageIds: string[];
  chatId?: string | null;
  messageId?: string | null;
}

/** What the page receives about one clip. */
export function publicGeneration(g: GenerationRow): Record<string, unknown> {
  let settings: unknown = {};
  try { settings = JSON.parse(g.settings); } catch { /* keep {} */ }
  let images: string[] = [];
  try { images = JSON.parse(g.images ?? "[]"); } catch { /* keep [] */ }
  return {
    id: g.id, model: g.model, modelName: modelByKey(g.model)?.name ?? g.model, settings, prompt: g.prompt,
    images, credits: g.credits, status: g.status === "submitting" || g.status === "saving" ? "running" : g.status,
    error: g.error, refunded: !!g.refunded, chatId: g.chat_id, messageId: g.message_id,
    video: g.status === "done" ? `/media/${g.id}.mp4` : null,
    createdAt: g.created_at, finishedAt: g.finished_at,
  };
}

export async function createGeneration(env: StudioEnv, userId: string, req: CreateRequest, origin: string): Promise<GenerationRow> {
  const prompt = (req.prompt ?? "").trim();
  const uploads = await uploadsOf(env, userId, req.imageIds ?? []);
  if (!prompt && !uploads.length) throw new StudioError("Write what you want to see, or add a picture.");
  if (prompt.length > 4000) throw new StudioError("That prompt is too long. Keep it under 4000 characters.");
  const s = normalizeSettings(req.settings ?? {}, uploads.length);
  const model = modelByKey(s.model)!;

  const user = await getUser(asEnv(env), userId);
  if (!user) throw new StudioError("Please sign in again.", 401, "signin");
  const paid = await hasPaid(asEnv(env), userId);
  if (!paid && !freeModels(env.STUDIO_FREE_MODELS).includes(s.model)) {
    throw new StudioError(`${model.name} unlocks with your first credit pack. Free credits work with ${freeModels(env.STUDIO_FREE_MODELS).map((k) => modelByKey(k)!.name).join(", ")}.`, 402, "locked");
  }
  const maxRunning = Math.max(1, num(env.STUDIO_MAX_RUNNING, 3));
  if ((await runningCount(env, userId)) >= maxRunning) {
    throw new StudioError(`You already have ${maxRunning} videos generating. Wait for one to finish.`, 429, "busy");
  }
  const credits = clipCredits(s, marginOf(env));
  const usd = clipCostUsd(s);
  const budget = num(env.STUDIO_DAILY_BUDGET_USD, 30);
  if ((await studioSpentTodayUsd(env)) + usd > budget) {
    await audit(asEnv(env), userId, null, "studio.budget", { usd, budget });
    throw new StudioError("Kleo Studio is at full capacity today. Please try again tomorrow — nothing was charged.", 503, "capacity");
  }
  if (user.credits < credits) {
    throw new StudioError(`This video costs ${credits} credits and you have ${user.credits}.`, 402, "credits");
  }

  const id = rid("g", 12);
  if (!(await debitCredits(asEnv(env), userId, credits, id))) {
    throw new StudioError(`This video costs ${credits} credits and you have fewer.`, 402, "credits");
  }
  const imagePaths = uploads.map((u) => `/media/u/${u.id}`);
  try {
    await insertGeneration(env, { id, userId, chatId: req.chatId ?? null, messageId: req.messageId ?? null, model: s.model, settings: s, prompt, images: imagePaths, credits, estUsd: usd });
  } catch (e) {
    await refundCredits(asEnv(env), userId, credits, id, "studio.insert_failed");
    throw e;
  }
  await audit(asEnv(env), userId, id, "studio.create", { model: s.model, settings: s, credits, usd });

  // The provider fetches the pictures through short signed links on this same host.
  const links = await Promise.all(uploads.map(async (u) => `${origin}${await signPath(env.INTERNAL_SECRET, `/media/u/${u.id}`, IMAGE_LINK_TTL_S)}`));
  try {
    const t = await ephone<{ id?: string }>(env, "POST", "/v1/task/submit",
      { model: model.ephoneModel, input: taskInput(s, prompt || "Bring this picture to life with natural, cinematic motion.", links, await safetyId(env, userId)) },
      { timeoutMs: 30_000, routing: model.routing });
    if (!t.id) throw new KieError("ephone.ai answered no task id", 502, true);
    await moveGeneration(env, id, ["submitting"], "running", { task_id: String(t.id) });
    await audit(asEnv(env), userId, id, "studio.submitted", { task: t.id, model: model.ephoneModel });
  } catch (e) {
    const money = e instanceof KieError && e.status === 402;
    const why = money
      ? "Our video engine is being recharged. Your credits are back — please try again in a little while."
      : `The video model refused this request: ${publicText(e instanceof Error ? e.message : String(e)).replace(/^.*?→ \d+: /, "")}`;
    await failGeneration(env, id, why, { provider: String(e instanceof Error ? e.message : e).slice(0, 300) });
  }
  return (await getGeneration(env, id))!;
}

/** The end-user id the provider may use for abuse attribution: a hash, never the account id itself. */
async function safetyId(env: StudioEnv, userId: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.INTERNAL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`studio-safety:${userId}`)));
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Marks a clip failed and gives its credits back — once, whoever calls first. */
export async function failGeneration(env: StudioEnv, id: string, why: string, detail: Record<string, unknown> = {}): Promise<void> {
  const g = await getGeneration(env, id);
  if (!g) return;
  if (!(await moveGeneration(env, id, ["submitting", "running", "saving"], "failed", { error: why.slice(0, 400), refunded: 1 }))) return;
  await refundCredits(asEnv(env), g.user_id, g.credits, id, "studio.failed");
  await audit(asEnv(env), g.user_id, id, "studio.failed", { why, ...detail });
}

/**
 * Brings one clip up to date with the provider. Cheap to call often: it asks the provider at most every
 * `minGapS` seconds per clip.
 */
export async function refreshGeneration(env: StudioEnv, g: GenerationRow, minGapS = 4): Promise<GenerationRow> {
  if (g.status === "done" || g.status === "failed") return g;
  const ageMin = (Date.now() - Date.parse(g.created_at + (g.created_at.endsWith("Z") ? "" : "Z"))) / 60_000;
  if (g.checked_at && (Date.now() - Date.parse(g.checked_at)) / 1000 < minGapS) return g;
  await markChecked(env, g.id);

  if (g.status === "submitting") {
    // The request that debited the credits died before the order went out (or the order is still on its way).
    if (ageMin > 5) await failGeneration(env, g.id, "The video could not be started. Your credits are back.", { stage: "submit" });
    return (await getGeneration(env, g.id))!;
  }
  if (g.status === "saving") {
    // Another call is saving the video; if it died half way, take the job back after a few minutes.
    if (g.updated_at && (Date.now() - Date.parse(g.updated_at)) / 60_000 > 4) await moveGeneration(env, g.id, ["saving"], "running");
    return (await getGeneration(env, g.id))!;
  }
  if (!g.task_id) return g;
  if (ageMin > GENERATION_TIMEOUT_MIN) {
    await failGeneration(env, g.id, "The video model took too long. Your credits are back.", { stage: "timeout", minutes: Math.round(ageMin) });
    return (await getGeneration(env, g.id))!;
  }
  const model = modelByKey(g.model);
  let t: EphoneTask;
  try {
    t = await ephone<EphoneTask>(env, "GET", `/v1/task/${encodeURIComponent(g.task_id)}`, undefined, { timeoutMs: 15_000, routing: model?.routing });
  } catch (e) {
    // A failed status read is not a failed video: try again on the next refresh.
    return g;
  }
  const status = String(t.status ?? "").toLowerCase();
  if (status === "failed" || status === "failure" || status === "cancelled") {
    await failGeneration(env, g.id, `The video model could not make this one: ${publicText(ephoneFailure(t))}. Your credits are back.`, { stage: "provider", usage: t.usage ?? null });
    return (await getGeneration(env, g.id))!;
  }
  if (status !== "completed" && status !== "succeeded" && status !== "success") return (await getGeneration(env, g.id))!;
  const url = ephoneOutputs(t).find((u) => !/\.(png|jpe?g|webp)(\?|$)/i.test(u)) ?? ephoneOutputs(t)[0];
  if (!url) {
    await failGeneration(env, g.id, "The video model finished without a video. Your credits are back.", { stage: "no_output" });
    return (await getGeneration(env, g.id))!;
  }
  if (!(await moveGeneration(env, g.id, ["running"], "saving", { usage: t.usage ? JSON.stringify(t.usage) : null }))) return (await getGeneration(env, g.id))!;
  try {
    const { key, size } = await saveVideo(env, g, url);
    await moveGeneration(env, g.id, ["saving"], "done", { file_key: key, size });
    await audit(asEnv(env), g.user_id, g.id, "studio.done", { size, usage: t.usage ?? null });
  } catch (e) {
    // Put it back: the next refresh downloads again (the provider keeps its link for days).
    await moveGeneration(env, g.id, ["saving"], "running");
    await audit(asEnv(env), g.user_id, g.id, "studio.save_failed", { error: String(e instanceof Error ? e.message : e).slice(0, 300) });
  }
  return (await getGeneration(env, g.id))!;
}

/** Copies the provider's video into R2 (its own links expire). Streams when the size is known. */
async function saveVideo(env: StudioEnv, g: GenerationRow, url: string): Promise<{ key: string; size: number }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!res.ok || !res.body) throw new Error(`video download answered ${res.status}`);
  const key = `studio/${g.user_id}/${g.id}.mp4`;
  const len = Number(res.headers.get("content-length") ?? 0);
  const type = /video\/(mp4|quicktime)/.test(res.headers.get("content-type") ?? "") ? res.headers.get("content-type")! : "video/mp4";
  let size: number;
  if (len > 0) {
    const fixed = new FixedLengthStream(len);
    const [obj] = await Promise.all([env.RENDERS.put(key, fixed.readable, { httpMetadata: { contentType: type } }), res.body.pipeTo(fixed.writable)]);
    size = obj?.size ?? len;
  } else {
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 1000) throw new Error("video download was empty");
    size = (await env.RENDERS.put(key, buf, { httpMetadata: { contentType: type } }))?.size ?? buf.byteLength;
  }
  return { key, size };
}
