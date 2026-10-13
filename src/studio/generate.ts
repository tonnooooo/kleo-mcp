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
import { freeImageModels, imageCostUsd, imageCredits, imageModelByKey, imageTaskInput, normalizeImageSettings, type ImageSettings } from "./image-models.ts";
import {
  addUpload, getGeneration, insertGeneration, moveGeneration, markChecked, runningCount, studioSpentTodayUsd, uploadsOf,
  type GenerationRow, type Slot,
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
/** Minutes a set of pictures may stay with the provider. */
export const IMAGE_TIMEOUT_MIN = 15;
/** How long a provider may keep fetching a person's picture through its signed link. */
const IMAGE_LINK_TTL_S = 6 * 3600;

export interface CreateRequest {
  kind?: "video" | "image";
  prompt: string;
  settings: Partial<Record<keyof ClipSettings | keyof ImageSettings, unknown>>;
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
  const kind = g.kind === "image" ? "image" : "video";
  const slots = parseSlots(g);
  return {
    id: g.id, kind, model: g.model, modelName: (kind === "image" ? imageModelByKey(g.model)?.name : modelByKey(g.model)?.name) ?? g.model,
    settings, prompt: g.prompt, images, credits: g.credits,
    status: g.status === "submitting" || g.status === "saving" ? "running" : g.status,
    error: g.error, refunded: !!g.refunded, chatId: g.chat_id, messageId: g.message_id,
    video: kind === "video" && g.status === "done" ? `/media/${g.id}.mp4` : null,
    // Every finished picture is also an upload, so it can be animated or used as a reference with one tap.
    outputs: kind === "image" ? slots.filter((x) => x.status === "done" && x.upload).map((x) => ({ upload: x.upload, url: `/media/u/${x.upload}` })) : [],
    count: kind === "image" ? (slots.length || Number((settings as { count?: number }).count ?? 1)) : 1,
    createdAt: g.created_at, finishedAt: g.finished_at,
  };
}

export function parseSlots(g: Pick<GenerationRow, "slots">): Slot[] {
  try { const v = JSON.parse(g.slots ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}

/**
 * The checks every order passes, in order, before any money moves, then the debit itself. Answers the new
 * generation's id. `freeOk` = the model is open to accounts that never paid.
 */
async function charge(env: StudioEnv, userId: string, o: { freeOk: boolean; lockedMessage: string; credits: number; usd: number; noun: string }): Promise<string> {
  const user = await getUser(asEnv(env), userId);
  if (!user) throw new StudioError("Please sign in again.", 401, "signin");
  if (!o.freeOk && !(await hasPaid(asEnv(env), userId))) throw new StudioError(o.lockedMessage, 402, "locked");
  const maxRunning = Math.max(1, num(env.STUDIO_MAX_RUNNING, 3));
  if ((await runningCount(env, userId)) >= maxRunning) {
    throw new StudioError(`You already have ${maxRunning} things generating. Wait for one to finish.`, 429, "busy");
  }
  const budget = num(env.STUDIO_DAILY_BUDGET_USD, 30);
  if ((await studioSpentTodayUsd(env)) + o.usd > budget) {
    await audit(asEnv(env), userId, null, "studio.budget", { usd: o.usd, budget });
    throw new StudioError("Kleo Studio is at full capacity today. Please try again tomorrow — nothing was charged.", 503, "capacity");
  }
  if (user.credits < o.credits) throw new StudioError(`This ${o.noun} costs ${o.credits} credits and you have ${user.credits}.`, 402, "credits");
  const id = rid("g", 12);
  if (!(await debitCredits(asEnv(env), userId, o.credits, id))) throw new StudioError(`This ${o.noun} costs ${o.credits} credits and you have fewer.`, 402, "credits");
  return id;
}

/** The sentence a person reads when the provider refused an order. */
function refusal(e: unknown, noun: string): string {
  if (e instanceof KieError && e.status === 402) return "Our generation engine is being recharged. Your credits are back — please try again in a little while.";
  return `The ${noun} model refused this request: ${publicText(e instanceof Error ? e.message : String(e)).replace(/^.*?→ \d+: /, "")}`;
}

export async function createGeneration(env: StudioEnv, userId: string, req: CreateRequest, origin: string): Promise<GenerationRow> {
  if (req.kind === "image") return createImageGeneration(env, userId, req, origin);
  const prompt = (req.prompt ?? "").trim();
  const uploads = await uploadsOf(env, userId, req.imageIds ?? []);
  if (!prompt && !uploads.length) throw new StudioError("Write what you want to see, or add a picture.");
  if (prompt.length > 4000) throw new StudioError("That prompt is too long. Keep it under 4000 characters.");
  const s = normalizeSettings(req.settings ?? {}, uploads.length);
  const model = modelByKey(s.model)!;

  const free = freeModels(env.STUDIO_FREE_MODELS);
  const credits = clipCredits(s, marginOf(env));
  const usd = clipCostUsd(s);
  const id = await charge(env, userId, {
    freeOk: free.includes(s.model), credits, usd, noun: "video",
    lockedMessage: `${model.name} unlocks with your first credit pack. Free credits work with ${free.map((k) => modelByKey(k)!.name).join(", ")}.`,
  });
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
    await failGeneration(env, id, refusal(e, "video"), { provider: String(e instanceof Error ? e.message : e).slice(0, 300) });
  }
  return (await getGeneration(env, id))!;
}

/** 1, 2 or 4 pictures: one provider task each. The person's attached pictures are references. */
async function createImageGeneration(env: StudioEnv, userId: string, req: CreateRequest, origin: string): Promise<GenerationRow> {
  const prompt = (req.prompt ?? "").trim();
  if (!prompt) throw new StudioError("Describe the picture you want.");
  if (prompt.length > 4000) throw new StudioError("That prompt is too long. Keep it under 4000 characters.");
  const uploads = await uploadsOf(env, userId, req.imageIds ?? []);
  const s = normalizeImageSettings(req.settings ?? {});
  const model = imageModelByKey(s.model)!;
  const free = freeImageModels(env.STUDIO_FREE_IMAGE_MODELS);
  const credits = imageCredits(s, marginOf(env));
  const usd = imageCostUsd(s);
  const id = await charge(env, userId, {
    freeOk: free.includes(s.model), credits, usd, noun: s.count > 1 ? "set of pictures" : "picture",
    lockedMessage: `${model.name} unlocks with your first credit pack. Free credits work with ${free.map((k) => imageModelByKey(k)!.name).join(", ")}.`,
  });
  try {
    await insertGeneration(env, { id, userId, chatId: req.chatId ?? null, messageId: req.messageId ?? null, model: s.model, settings: s, prompt, images: uploads.map((u) => `/media/u/${u.id}`), credits, estUsd: usd, kind: "image" });
  } catch (e) {
    await refundCredits(asEnv(env), userId, credits, id, "studio.insert_failed");
    throw e;
  }
  await audit(asEnv(env), userId, id, "studio.create", { kind: "image", model: s.model, settings: s, credits, usd });
  const links = await Promise.all(uploads.map(async (u) => `${origin}${await signPath(env.INTERNAL_SECRET, `/media/u/${u.id}`, IMAGE_LINK_TTL_S)}`));
  const input = imageTaskInput(s, prompt, links);
  const slots: Slot[] = [];
  let firstError: unknown = null;
  for (let i = 0; i < s.count; i++) {
    try {
      const t = await ephone<{ id?: string }>(env, "POST", "/v1/task/submit", { model: model.ephoneModel, input }, { timeoutMs: 30_000, routing: model.routing });
      if (!t.id) throw new KieError("ephone.ai answered no task id", 502, true);
      slots.push({ task: String(t.id), status: "running" });
    } catch (e) {
      firstError ??= e;
      slots.push({ task: null, status: "failed", error: publicText(e instanceof Error ? e.message : String(e)).slice(0, 200) });
      // An empty balance refuses every other picture too: stop asking.
      if (e instanceof KieError && e.status === 402) { while (slots.length < s.count) slots.push({ task: null, status: "failed", error: "balance" }); break; }
    }
  }
  if (!slots.some((x) => x.status === "running")) {
    await failGeneration(env, id, refusal(firstError, "image"), { provider: String(firstError instanceof Error ? firstError.message : firstError).slice(0, 300) });
  } else {
    await moveGeneration(env, id, ["submitting"], "running", { task_id: slots.find((x) => x.task)!.task, slots: JSON.stringify(slots) });
    await audit(asEnv(env), userId, id, "studio.submitted", { tasks: slots.map((x) => x.task), model: model.ephoneModel });
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
  if (g.kind === "image") return refreshImages(env, g, ageMin);
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

/** Result links of a finished picture task: https links, or data: URIs some image models answer with. */
export function imageOutputs(t: EphoneTask): string[] {
  const out = Array.isArray(t.outputs) ? t.outputs : [];
  return out.filter((u): u is string => typeof u === "string" && (/^https?:\/\//.test(u) || /^data:image\//.test(u)));
}

/**
 * One pass over a set of pictures. The set is held in "saving" during the pass (compare-and-set), so two polls never
 * save the same picture twice; a pass that dies leaves it to the "saving" rescue in refreshGeneration.
 */
async function refreshImages(env: StudioEnv, g: GenerationRow, ageMin: number): Promise<GenerationRow> {
  if (!(await moveGeneration(env, g.id, ["running"], "saving"))) return (await getGeneration(env, g.id))!;
  const slots = parseSlots(g);
  const model = imageModelByKey(g.model);
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (slot.status !== "running" || !slot.task) continue;
    if (ageMin > IMAGE_TIMEOUT_MIN) { slot.status = "failed"; slot.error = "timeout"; continue; }
    let t: EphoneTask;
    try { t = await ephone<EphoneTask>(env, "GET", `/v1/task/${encodeURIComponent(slot.task)}`, undefined, { timeoutMs: 15_000, routing: model?.routing }); } catch { continue; }
    const status = String(t.status ?? "").toLowerCase();
    if (status === "failed" || status === "failure" || status === "cancelled") { slot.status = "failed"; slot.error = publicText(ephoneFailure(t)).slice(0, 200); continue; }
    if (status !== "completed" && status !== "succeeded" && status !== "success") continue;
    const url = imageOutputs(t)[0];
    if (!url) { slot.status = "failed"; slot.error = "no picture"; continue; }
    try {
      const { key, type, size } = await saveImage(env, g, i, url);
      const upload = rid("up", 12);
      await addUpload(env, { id: upload, userId: g.user_id, key, contentType: type, size, width: null, height: null });
      slot.status = "done"; slot.key = key; slot.upload = upload;
    } catch { /* the next pass downloads again */ }
  }
  const json = JSON.stringify(slots);
  if (slots.some((x) => x.status === "running")) {
    await moveGeneration(env, g.id, ["saving"], "running", { slots: json });
    return (await getGeneration(env, g.id))!;
  }
  const done = slots.filter((x) => x.status === "done");
  if (!done.length) {
    await moveGeneration(env, g.id, ["saving"], "running", { slots: json });
    const why = slots.find((x) => x.error && x.error !== "timeout" && x.error !== "balance")?.error;
    await failGeneration(env, g.id, why ? `The image model could not make this one: ${why}. Your credits are back.` : "The image model took too long. Your credits are back.", { stage: "images" });
    return (await getGeneration(env, g.id))!;
  }
  // Some pictures failed: the share of credits they stood for goes back (rounded down).
  const back = Math.floor((g.credits * (slots.length - done.length)) / slots.length);
  if (await moveGeneration(env, g.id, ["saving"], "done", { slots: json, file_key: done[0].key ?? null, refunded: back > 0 ? 1 : 0 })) {
    if (back > 0) await refundCredits(asEnv(env), g.user_id, back, g.id, "studio.images_partial");
    await audit(asEnv(env), g.user_id, g.id, "studio.done", { kind: "image", pictures: done.length, of: slots.length, refunded: back });
  }
  return (await getGeneration(env, g.id))!;
}

async function saveImage(env: StudioEnv, g: GenerationRow, i: number, url: string): Promise<{ key: string; type: string; size: number }> {
  let bytes: Uint8Array;
  let type: string;
  const data = /^data:(image\/[a-z+.-]+);base64,(.*)$/i.exec(url);
  if (data) {
    type = data[1];
    bytes = Uint8Array.from(atob(data[2]), (c) => c.charCodeAt(0));
  } else {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`picture download answered ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
    type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  }
  if (bytes.byteLength < 200) throw new Error("picture download was empty");
  if (!/^image\//.test(type)) type = bytes[0] === 0x89 ? "image/png" : bytes[0] === 0x52 ? "image/webp" : "image/jpeg";
  const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
  const key = `studio/${g.user_id}/${g.id}/${i}.${ext}`;
  await env.RENDERS.put(key, bytes, { httpMetadata: { contentType: type } });
  return { key, type, size: bytes.byteLength };
}
