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
import { debitCredits, refundCredits, getUser, hasPaid, audit, countAuditTodayForUser } from "../db.ts";
import { publicText, rid } from "../util.ts";
import { clampFreeResolution, clipCostUsd, clipCredits, freeModels, freeResolutions, modelByKey, normalizeSettings, taskInput, DEFAULT_MARGIN, type ClipSettings } from "./models.ts";
import { withPreset } from "./presets.ts";
import { planTool, toolByKey, toolCredits, toneText, ToolRefusal, type Media, type Plan, type ToolKey } from "./tools.ts";
import { mediaInfo } from "./media.ts";
import { refreshFilm } from "./films.ts";
import { freeImageModels, imageCostUsd, imageCredits, imageModelByKey, imageTaskInput, normalizeImageSettings, type ImageSettings } from "./image-models.ts";
import {
  addUpload, getGeneration, insertGeneration, moveGeneration, markChecked, runningCount, studioSpentTodayUsd, uploadsOf,
  type GenerationRow, type Slot,
} from "./store.ts";
import { signPath } from "./session.ts";
import { addressBlocked } from "../abuse.ts";

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
  /** A camera or effect preset (presets.ts), added to a video prompt. */
  preset?: string | null;
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
  const kind = g.kind === "image" || g.kind === "tool" || g.kind === "film" ? g.kind : "video";
  let progress: unknown = null;
  if (kind === "film") { try { progress = JSON.parse(g.usage ?? "null"); } catch { /* none yet */ } }
  const slots = parseSlots(g);
  return {
    id: g.id, kind, model: g.model,
    modelName: (kind === "image" ? imageModelByKey(g.model)?.name : kind === "tool" ? toolByKey(g.model)?.name : kind === "film" ? (g.model === "kleo-animatic" ? "Kleo Animatic" : "Kleo Film") : modelByKey(g.model)?.name) ?? g.model,
    settings, prompt: g.prompt, images, credits: g.credits,
    status: g.status === "submitting" || g.status === "saving" ? "running" : g.status,
    error: g.error, refunded: !!g.refunded, chatId: g.chat_id, messageId: g.message_id,
    video: (kind === "video" || kind === "film") && g.status === "done" ? `/media/${g.id}.mp4` : null,
    progress,
    // Every finished picture is also an upload, so it can be animated or used as a reference with one tap.
    outputs: kind !== "video" && kind !== "film" ? slots.filter((x) => x.status === "done" && x.upload).map((x) => ({ upload: x.upload, url: `/media/u/${x.upload}`, type: x.type ?? "image" })) : [],
    count: kind === "image" ? (slots.length || Number((settings as { count?: number }).count ?? 1)) : kind === "tool" ? Math.max(1, slots.filter((x) => x.task !== null || x.status !== "done").length) : 1,
    output: kind === "tool" ? (settings as { output?: string }).output ?? "video" : kind === "film" ? "video" : kind,
    createdAt: g.created_at, finishedAt: g.finished_at,
  };
}

export function parseSlots(g: Pick<GenerationRow, "slots">): Slot[] {
  try { const v = JSON.parse(g.slots ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}

type Gate = { freeOk: boolean; lockedMessage: string; credits: number; usd: number; noun: string };

/**
 * The checks every order passes, in order, before any money moves (and before any paid work, such as speech).
 * TWO DAILY POOLS (14 October 2026): accounts that never paid draw on their own, smaller STUDIO_FREE_DAILY_BUDGET_USD,
 * so a crowd of throwaway accounts spending free credits can never fill the day for paying customers.
 */
async function gate(env: StudioEnv, userId: string, o: Gate): Promise<void> {
  const user = await getUser(asEnv(env), userId);
  if (!user) throw new StudioError("Please sign in again.", 401, "signin");
  const paid = await hasPaid(asEnv(env), userId);
  if (!o.freeOk && !paid) throw new StudioError(o.lockedMessage, 402, "locked");
  const maxRunning = Math.max(1, num(env.STUDIO_MAX_RUNNING, 3));
  if ((await runningCount(env, userId)) >= maxRunning) {
    throw new StudioError(`You already have ${maxRunning} things generating. Wait for one to finish.`, 429, "busy");
  }
  const budget = num(env.STUDIO_DAILY_BUDGET_USD, 30);
  if ((await studioSpentTodayUsd(env)) + o.usd > budget) {
    await audit(asEnv(env), userId, null, "studio.budget", { usd: o.usd, budget });
    throw new StudioError("Kleo is at full capacity today. Please try again tomorrow — nothing was charged.", 503, "capacity");
  }
  if (!paid) {
    // ONE GIFT PER PERSON (15 October 2026, src/abuse.ts): the never-paid accounts of a blocked address stop here, and
    // all the never-paid accounts opened from one address share STUDIO_FREE_PER_ADDRESS_DAY_USD a day — ten throwaway
    // accounts spend what one would.
    const ipHash = (user as unknown as { ip_hash?: string | null }).ip_hash ?? null;
    if (await addressBlocked(env, ipHash)) {
      await audit(asEnv(env), userId, null, "studio.address_blocked", { usd: o.usd });
      throw new StudioError("Free generations are paused for this account. A credit pack unlocks everything — nothing was charged.", 403, "address_blocked");
    }
    if (ipHash) {
      const perAddress = num(env.STUDIO_FREE_PER_ADDRESS_DAY_USD, 2);
      const spent = await env.DB.prepare(`SELECT COALESCE(SUM(g.est_usd), 0) AS usd FROM studio_generations g JOIN users u ON u.id = g.user_id
          WHERE u.ip_hash = ? AND g.status != 'failed' AND g.created_at >= strftime('%Y-%m-%dT00:00:00.000Z','now')
            AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.user_id = g.user_id AND p.status = 'paid')`).bind(ipHash).first<{ usd: number }>();
      if (Number(spent?.usd ?? 0) + o.usd > perAddress) {
        await audit(asEnv(env), userId, null, "studio.free_address", { usd: o.usd, spent: Number(spent?.usd ?? 0), cap: perAddress });
        throw new StudioError("You've used today's free generations. Come back tomorrow, or buy a pack to keep going — nothing was charged.", 429, "free_address");
      }
    }
    const free = num(env.STUDIO_FREE_DAILY_BUDGET_USD, 8);
    if ((await studioSpentTodayUsd(env, { unpaidOnly: true })) + o.usd > free) {
      await audit(asEnv(env), userId, null, "studio.free_budget", { usd: o.usd, budget: free });
      throw new StudioError("Free generations are full for today. Come back tomorrow, or buy a pack to skip the queue — nothing was charged.", 503, "free_capacity");
    }
  }
  if (user.credits < o.credits) throw new StudioError(`This ${o.noun} costs ${o.credits} credits and you have ${user.credits}.`, 402, "credits");
}

/** The gate, then the debit itself. Answers the new generation's id. `freeOk` = open to accounts that never paid. */
async function charge(env: StudioEnv, userId: string, o: Gate): Promise<string> {
  await gate(env, userId, o);
  const id = rid("g", 12);
  if (!(await debitCredits(asEnv(env), userId, o.credits, id))) throw new StudioError(`This ${o.noun} costs ${o.credits} credits and you have fewer.`, 402, "credits");
  return id;
}

/**
 * Deletes one finished or failed creation for good (14 October 2026, the owner: "metti l'opzione che posso eliminare
 * le immagini o video creati"): the row, the files Kleo made for it (the clip, every picture or sound of its slots, and
 * their upload rows), never the person's own reference uploads. One still generating is refused: its credits were
 * spent and the result is on its way. Shared links to it stop working with the file.
 */
export async function deleteGeneration(env: StudioEnv, userId: string, g: GenerationRow): Promise<void> {
  if (g.user_id !== userId) throw new StudioError("Not found.", 404);
  if (g.status !== "done" && g.status !== "failed") throw new StudioError("It's still being made. Wait for it to finish, then delete it.", 409, "busy");
  const slots = parseSlots(g);
  const made = slots.map((x) => x.upload).filter((x): x is string => !!x);
  const keys = new Set<string>([g.file_key, ...slots.map((x) => x.key)].filter((k): k is string => !!k && k.startsWith(`studio/${userId}/`)));
  if (made.length) {
    // Only uploads Kleo made (never under the person's own up/ prefix, where references live).
    const rows = (await env.DB.prepare(`SELECT id, key FROM studio_uploads WHERE user_id = ? AND id IN (${made.map(() => "?").join(",")})`).bind(userId, ...made).all<{ id: string; key: string }>()).results;
    const mine = rows.filter((r) => !r.key.startsWith(`studio/${userId}/up/`));
    for (const r of mine) keys.add(r.key);
    if (mine.length) await env.DB.prepare(`DELETE FROM studio_uploads WHERE user_id = ? AND id IN (${mine.map(() => "?").join(",")})`).bind(userId, ...mine.map((r) => r.id)).run();
  }
  if (keys.size) await env.RENDERS.delete([...keys]);
  await env.DB.prepare("DELETE FROM studio_generations WHERE id = ? AND user_id = ?").bind(g.id, userId).run();
  await audit(asEnv(env), userId, g.id, "studio.deleted", { kind: g.kind, files: keys.size });
}

/** The sentence a person reads when the provider refused an order. */
function refusal(e: unknown, noun: string): string {
  if (e instanceof KieError && e.status === 402) return "Our generation engine is being recharged. Your credits are back — please try again in a little while.";
  return `The ${noun} model refused this request: ${publicText(e instanceof Error ? e.message : String(e)).replace(/^.*?→ \d+: /, "")}`;
}

export async function createGeneration(env: StudioEnv, userId: string, req: CreateRequest, origin: string): Promise<GenerationRow> {
  if (req.kind === "image") return createImageGeneration(env, userId, req, origin);
  const prompt = withPreset((req.prompt ?? "").trim(), req.preset);
  const all = await uploadsOf(env, userId, req.imageIds ?? []);
  const pictures = all.filter((u) => (u.kind ?? "image") === "image");
  const videos = all.filter((u) => u.kind === "video");
  const sounds = all.filter((u) => u.kind === "audio");
  if (!prompt && !all.length) throw new StudioError("Write what you want to see, or add a picture.");
  if (prompt.length > 4000) throw new StudioError("That prompt is too long. Keep it under 4000 characters.");
  const videoSeconds = videos.reduce((a, v) => a + (v.duration ?? 0), 0);
  let s = normalizeSettings(req.settings ?? {}, pictures.length, { images: pictures.length, videos: videos.length, audios: sounds.length, videoSeconds });
  const model = modelByKey(s.model)!;
  if (videos.some((v) => !v.duration || v.duration < 2)) throw new StudioError("Each video clip must be at least 2 seconds long (MP4 or MOV).");
  if (videoSeconds > (model.maxRefVideoSeconds ?? 0) + 0.5) throw new StudioError(`Video clips can add up to ${model.maxRefVideoSeconds} seconds with ${model.name}. Yours are ${Math.round(videoSeconds)} s.`);
  if (sounds.some((a) => !a.duration || a.duration < 2 || a.duration > 15.5)) throw new StudioError("Each sound clip must be 2–15 seconds long (MP3 or WAV).");

  const free = freeModels(env.STUDIO_FREE_MODELS);
  const freeRes = freeResolutions(env.STUDIO_FREE_RESOLUTIONS);
  const modelFree = free.includes(s.model);
  // An order that names no resolution gets the model's default, which a free account may not use: it gets its own.
  if (!(req.settings as Record<string, unknown> | undefined)?.resolution && modelFree && !freeRes.includes(s.resolution) && !(await hasPaid(asEnv(env), userId))) {
    s = clampFreeResolution(s, freeRes);
  }
  const credits = clipCredits(s, marginOf(env), videoSeconds);
  const usd = clipCostUsd(s, videoSeconds);
  const id = await charge(env, userId, {
    freeOk: modelFree && freeRes.includes(s.resolution), credits, usd, noun: "video",
    lockedMessage: modelFree
      ? `${s.resolution} unlocks with your first credit pack. Free credits make ${freeRes.join(" and ")} videos.`
      : `${model.name} unlocks with your first credit pack. Free credits work with ${free.map((k) => modelByKey(k)!.name).join(", ")}.`,
  });
  const imagePaths = all.map((u) => `/media/u/${u.id}`);
  try {
    await insertGeneration(env, { id, userId, chatId: req.chatId ?? null, messageId: req.messageId ?? null, model: s.model, settings: { ...s, preset: req.preset ?? null }, prompt, images: imagePaths, credits, estUsd: usd });
  } catch (e) {
    await refundCredits(asEnv(env), userId, credits, id, "studio.insert_failed");
    throw e;
  }
  await audit(asEnv(env), userId, id, "studio.create", { model: s.model, settings: s, credits, usd });

  // The provider fetches the pictures and clips through short signed links on this same host.
  const link = async (u: { id: string }) => `${origin}${await signPath(env.INTERNAL_SECRET, `/media/u/${u.id}`, IMAGE_LINK_TTL_S)}`;
  const links = await Promise.all(pictures.map(link));
  const clipLinks = { videos: await Promise.all(videos.map(link)), audios: await Promise.all(sounds.map(link)) };
  try {
    const t = await ephone<{ id?: string }>(env, "POST", "/v1/task/submit",
      { model: model.ephoneModel, input: taskInput(s, prompt || "Bring this picture to life with natural, cinematic motion.", links, await safetyId(env, userId), clipLinks) },
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
    // A film row is the exception: Studio never debited it (the MCP Worker did, and refunds a failed job itself), so
    // it is closed WITHOUT a refund — refunding here would hand out credits nobody paid.
    if (ageMin > 5 && g.kind === "film") {
      await moveGeneration(env, g.id, ["submitting"], "failed", { error: "Kleo lost track of this film. If it was charged, write to hello@kleooai.com.", refunded: 1 });
      await audit(asEnv(env), g.user_id, g.id, "studio.film_lost", {});
    } else if (ageMin > 5) await failGeneration(env, g.id, "The video could not be started. Your credits are back.", { stage: "submit" });
    return (await getGeneration(env, g.id))!;
  }
  if (g.status === "saving") {
    // Another call is saving the video; if it died half way, take the job back after a few minutes.
    if (g.updated_at && (Date.now() - Date.parse(g.updated_at)) / 60_000 > 4) await moveGeneration(env, g.id, ["saving"], "running");
    return (await getGeneration(env, g.id))!;
  }
  if (g.kind === "film") return refreshFilm(env, g);
  if (g.kind === "image" || g.kind === "tool") return refreshImages(env, g, ageMin);
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

/**
 * One pass over a set of pictures. The set is held in "saving" during the pass (compare-and-set), so two polls never
 * save the same picture twice; a pass that dies leaves it to the "saving" rescue in refreshGeneration.
 */
async function refreshImages(env: StudioEnv, g: GenerationRow, ageMin: number): Promise<GenerationRow> {
  if (!(await moveGeneration(env, g.id, ["running"], "saving"))) return (await getGeneration(env, g.id))!;
  const slots = parseSlots(g);
  const routing = g.kind === "tool" ? undefined : imageModelByKey(g.model)?.routing;
  const timeout = g.kind === "tool" ? GENERATION_TIMEOUT_MIN : IMAGE_TIMEOUT_MIN;
  const extra: Slot[] = [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (slot.status !== "running" || !slot.task) continue;
    if (ageMin > timeout) { slot.status = "failed"; slot.error = "timeout"; continue; }
    let t: EphoneTask;
    try { t = await ephone<EphoneTask>(env, "GET", `/v1/task/${encodeURIComponent(slot.task)}`, undefined, { timeoutMs: 15_000, routing: slot.model ? toolRouting(slot.model) : routing }); } catch { continue; }
    const status = String(t.status ?? "").toLowerCase();
    if (status === "failed" || status === "failure" || status === "cancelled") { slot.status = "failed"; slot.error = publicText(ephoneFailure(t)).slice(0, 200); continue; }
    if (status !== "completed" && status !== "succeeded" && status !== "success") continue;
    const want = slot.type ?? "image";
    const urls = mediaOutputs(t).filter((u) => kindOfUrl(u) === want || kindOfUrl(u) === null);
    if (!urls.length) { slot.status = "failed"; slot.error = "no result"; continue; }
    try {
      // Suno answers two songs (and their covers): every result of the wanted kind becomes its own picture/clip.
      const saved: { key: string; upload: string; type: Slot["type"] }[] = [];
      for (const [n, url] of urls.slice(0, want === "audio" ? 2 : 1).entries()) {
        const out = await saveOutput(env, g, n === 0 ? `${i}` : `${i}-${n}`, url);
        if (out.kind !== want) continue;
        const upload = rid("up", 12);
        await addUpload(env, { id: upload, userId: g.user_id, key: out.key, contentType: out.type, size: out.size, width: out.width, height: out.height, kind: out.kind, duration: out.duration });
        saved.push({ key: out.key, upload, type: out.kind });
      }
      if (!saved.length) { slot.status = "failed"; slot.error = "no result"; continue; }
      Object.assign(slot, { status: "done", key: saved[0].key, upload: saved[0].upload, type: saved[0].type });
      for (const x of saved.slice(1)) extra.push({ task: null, status: "done", key: x.key, upload: x.upload, type: x.type });
    } catch { /* the next pass downloads again */ }
  }
  slots.push(...extra);
  const json = JSON.stringify(slots);
  if (slots.some((x) => x.status === "running")) {
    await moveGeneration(env, g.id, ["saving"], "running", { slots: json });
    return (await getGeneration(env, g.id))!;
  }
  const done = slots.filter((x) => x.status === "done");
  if (!done.length) {
    await moveGeneration(env, g.id, ["saving"], "running", { slots: json });
    const why = slots.find((x) => x.error && x.error !== "timeout" && x.error !== "balance")?.error;
    const noun = g.kind === "tool" ? "model" : "image model";
    await failGeneration(env, g.id, why ? `The ${noun} could not make this one: ${why}. Your credits are back.` : `The ${noun} took too long. Your credits are back.`, { stage: g.kind });
    return (await getGeneration(env, g.id))!;
  }
  // Some pictures failed: the share of credits they stood for goes back (rounded down).
  // (Extra results of one task, like Suno's second song, are a bonus, not a share.)
  const ordered = slots.filter((x) => x.task !== null || x.status !== "done" || !extra.includes(x));
  const back = Math.floor((g.credits * ordered.filter((x) => x.status === "failed").length) / Math.max(1, ordered.length));
  if (await moveGeneration(env, g.id, ["saving"], "done", { slots: json, file_key: done[0].key ?? null, refunded: back > 0 ? 1 : 0 })) {
    if (back > 0) await refundCredits(asEnv(env), g.user_id, back, g.id, "studio.images_partial");
    await audit(asEnv(env), g.user_id, g.id, "studio.done", { kind: "image", pictures: done.length, of: slots.length, refunded: back });
  }
  return (await getGeneration(env, g.id))!;
}

/** Result links of a finished task: https links and data: URIs, of any media. */
export function mediaOutputs(t: EphoneTask): string[] {
  const out = Array.isArray(t.outputs) ? t.outputs : [];
  return out.filter((u): u is string => typeof u === "string" && (/^https?:\/\//.test(u) || /^data:(image|video|audio)\//.test(u)));
}
/** The kind a result link announces by its extension or data type, or null when it does not say. */
export function kindOfUrl(u: string): "image" | "video" | "audio" | null {
  const d = /^data:(image|video|audio)\//.exec(u);
  if (d) return d[1] as "image" | "video" | "audio";
  const ext = /\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(u)?.[1]?.toLowerCase();
  if (!ext) return null;
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "image";
  if (["mp4", "mov", "webm"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(ext)) return "audio";
  return null;
}
const TOOL_ROUTED = new Set(["gemini-3-pro-image", "flux-tools/vto-v1", "flux-tools/video-edit-v1", "flux-tools/video-upscale-v1"]);
const toolRouting = (model: string) => (TOOL_ROUTED.has(model) ? { "X-Provider-Order": "official_cheap", "X-Provider-Only": "true" } : undefined);

/** Downloads one result into R2 and says what it is (by its bytes). */
async function saveOutput(env: StudioEnv, g: GenerationRow, name: string, url: string) {
  let bytes: Uint8Array;
  const data = /^data:[a-z]+\/[a-z0-9+.-]+;base64,(.*)$/i.exec(url);
  if (data) bytes = Uint8Array.from(atob(data[1]), (c) => c.charCodeAt(0));
  else {
    const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    if (!res.ok) throw new Error(`result download answered ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  if (bytes.byteLength < 200) throw new Error("result download was empty");
  const info = mediaInfo(bytes) ?? { kind: "image" as const, type: "image/jpeg", ext: "jpg", duration: null, width: null, height: null };
  const key = `studio/${g.user_id}/${g.id}/${name}.${info.ext}`;
  await env.RENDERS.put(key, bytes, { httpMetadata: { contentType: info.type } });
  return { key, type: info.type, size: bytes.byteLength, kind: info.kind, duration: info.duration, width: info.width, height: info.height };
}

// ── Apps ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Tools a never-paid account may use (STUDIO_FREE_TOOLS; default the cheap picture and sound ones). */
export function freeTools(list: string | undefined): ToolKey[] {
  const raw = (list ?? "face-swap,outfit-swap,voice,music,sfx").trim();
  if (raw === "*") return ["face-swap", "video-face-swap", "talking-photo", "lipsync", "motion-control", "outfit-swap", "video-edit", "video-upscale", "voice", "music", "sfx"];
  return raw.split(",").map((x) => x.trim()).filter((k): k is ToolKey => !!toolByKey(k));
}

/** Speech through the OpenAI-compatible endpoint (a WAV, so its length is exact). */
export async function speak(env: StudioEnv, sp: NonNullable<Plan["speech"]>): Promise<Uint8Array> {
  const key = (env.EPHONE_API_KEY ?? "").trim();
  if (!key) throw new KieError("EPHONE_API_KEY is not set", 0, false);
  const base = (env.EPHONE_API_URL ?? "").trim().replace(/\/+$/, "") || "https://api.ephone.ai";
  const res = await fetch(`${base}/v1/audio/speech`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "X-Provider-Order": "official_cheap,official", "X-Provider-Only": "true" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", input: sp.text, voice: sp.voice, instructions: toneText(sp.tone), response_format: "wav" }),
    signal: AbortSignal.timeout(60_000),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!res.ok || bytes.byteLength < 100) {
    const said = new TextDecoder().decode(bytes.slice(0, 300));
    const money = res.status === 402 || /quota|余额|额度|balance/i.test(said);
    throw new KieError(`ephone.ai POST /v1/audio/speech → ${res.status}: ${said}`, money ? 402 : res.status, res.status >= 500);
  }
  return bytes;
}

export interface ToolRequest { tool: string; inputs: Record<string, string>; consent?: boolean; chatId?: string | null }

/** How many spoken clips an account may have refused after they were made, per UTC day, before no more is made. */
export const SPEECH_REFUSED_PER_DAY = 5;
/** A spoken clip whose order was then refused: deleted with its upload row, and the refusal written down. */
async function forgetSpeech(env: StudioEnv, userId: string, spoken: { id: string; key: string; seconds: number | null }, why: unknown): Promise<void> {
  try { await env.RENDERS.delete(spoken.key); } catch { /* the row goes all the same: nothing links to the object */ }
  await env.DB.prepare("DELETE FROM studio_uploads WHERE id = ? AND user_id = ?").bind(spoken.id, userId).run();
  await audit(asEnv(env), userId, null, "studio.speech_refused", { seconds: spoken.seconds, why: why instanceof StudioError ? why.code : "error" });
}

/** Runs one app: reads the attached files, speaks the words if any, prices, charges, orders. */
export async function runTool(env: StudioEnv, userId: string, req: ToolRequest, origin: string): Promise<GenerationRow> {
  const tool = toolByKey(req.tool);
  if (!tool) throw new StudioError("That app doesn't exist.", 404);
  if (tool.consent && req.consent !== true) throw new StudioError("Please confirm you have the right to use this person's face.", 400, "consent");
  const inputs: Record<string, string> = {};
  for (const f of tool.fields) if (req.inputs?.[f.key] !== undefined) inputs[f.key] = String(req.inputs[f.key]).slice(0, f.maxLength ?? 200);
  const fileFields = tool.fields.filter((f) => f.kind === "image" || f.kind === "video" || f.kind === "audio");
  const rows = await uploadsOf(env, userId, fileFields.map((f) => inputs[f.key]).filter(Boolean));
  const link = async (id: string) => `${origin}${await signPath(env.INTERNAL_SECRET, `/media/u/${id}`, IMAGE_LINK_TTL_S)}`;
  const media: Record<string, Media | undefined> = {};
  for (const f of fileFields) {
    const u = rows.find((r) => r.id === inputs[f.key]);
    if (u) media[f.key] = { id: u.id, url: await link(u.id), kind: u.kind ?? "image", seconds: u.duration ?? null, width: u.width, height: u.height, type: u.content_type ?? "" };
  }
  let plan: Plan;
  try { plan = planTool(tool.key, inputs, media); } catch (e) { if (e instanceof ToolRefusal) throw new StudioError(e.message); throw e; }

  // Words to speak become a sound clip first: its exact length prices the talking video, and for a voiceover it IS
  // the result. Speech is made before the charge, so the order first passes every check the charge will make, on the
  // price estimated from the script (an empty or locked account cannot make Kleo speak for free in a loop).
  const free = freeTools(env.STUDIO_FREE_TOOLS);
  const gateFor = (p: Plan): Gate => ({ freeOk: free.includes(tool.key), credits: toolCredits(p.usd, marginOf(env)), usd: p.usd, noun: tool.name.toLowerCase(), lockedMessage: `${tool.name} unlocks with your first credit pack.` });
  let spoken: { id: string; key: string; size: number; seconds: number | null } | null = null;
  if (plan.speech) {
    await gate(env, userId, gateFor(plan));
    // Speech that was made and then refused (longer than the estimate, or dearer than the credits once timed) is paid
    // for and never charged (14 October 2026, the review's second pass): a few a day are honest mistakes, a loop is
    // not, so past SPEECH_REFUSED_PER_DAY no more is made for the account until tomorrow.
    if ((await countAuditTodayForUser(asEnv(env), userId, "studio.speech_refused")) >= SPEECH_REFUSED_PER_DAY)
      throw new StudioError("Too many voice attempts were refused today. Shorten the words, or try again tomorrow — nothing was charged.", 429, "speech_limit");
    let wav: Uint8Array;
    try { wav = await speak(env, plan.speech); } catch (e) {
      const money = e instanceof KieError && e.status === 402;
      throw new StudioError(money ? "Our generation engine is being recharged. Please try again in a little while — nothing was charged." : "The voice model couldn't read that. Try different words — nothing was charged.", 502, "speech");
    }
    const info = mediaInfo(wav);
    // Kleo's speech is not one of the person's own uploads: kept outside their up/ prefix, so the upload allowance
    // (src/studio/index.ts) never counts it.
    const id = rid("up", 12), key = `studio/${userId}/speech/${id}.wav`;
    await env.RENDERS.put(key, wav, { httpMetadata: { contentType: "audio/wav" } });
    await addUpload(env, { id, userId, key, contentType: "audio/wav", size: wav.byteLength, width: null, height: null, kind: "audio", duration: info?.duration ?? null });
    spoken = { id, key, size: wav.byteLength, seconds: info?.duration ?? null };
  }

  let credits: number, id: string;
  try {
    if (spoken && (tool.key === "talking-photo" || tool.key === "lipsync")) {
      if (spoken.seconds && spoken.seconds > 60.5) throw new StudioError("That's more than a minute of speech. Shorten the words.");
      media.audio = { id: spoken.id, url: await link(spoken.id), kind: "audio", seconds: spoken.seconds, width: null, height: null, type: "audio/wav" };
      try { plan = planTool(tool.key, { ...inputs, source: "audio" }, media); } catch (e) { if (e instanceof ToolRefusal) throw new StudioError(e.message); throw e; }
      plan.usd += 0.01;
    }
    credits = toolCredits(plan.usd, marginOf(env));
    id = await charge(env, userId, gateFor(plan));
  } catch (e) {
    // Refused after the voice was made: the clip and its row go (nobody can use them), and the refusal is counted.
    if (spoken) await forgetSpeech(env, userId, spoken, e);
    throw e;
  }
  const prompt = String(inputs.script ?? inputs.prompt ?? "").trim() || plan.summary;
  const settings = { tool: tool.key, summary: plan.summary, output: plan.output, inputs: Object.fromEntries(Object.entries(inputs).filter(([k]) => !fileFields.some((f) => f.key === k))) };
  try {
    await insertGeneration(env, { id, userId, chatId: req.chatId ?? null, messageId: null, model: tool.key, settings, prompt, images: Object.values(media).filter(Boolean).map((m) => `/media/u/${m!.id}`), credits, estUsd: plan.usd, kind: "tool" });
  } catch (e) {
    await refundCredits(asEnv(env), userId, credits, id, "studio.insert_failed");
    throw e;
  }
  await audit(asEnv(env), userId, id, "studio.create", { kind: "tool", tool: tool.key, credits, usd: plan.usd, consent: tool.consent ? true : undefined });

  if (!plan.tasks.length && spoken) {
    // A voiceover is finished the moment it is spoken.
    const slots: Slot[] = [{ task: null, status: "done", key: spoken.key, upload: spoken.id, type: "audio" }];
    await moveGeneration(env, id, ["submitting"], "done", { slots: JSON.stringify(slots), file_key: spoken.key });
    return (await getGeneration(env, id))!;
  }
  const slots: Slot[] = [];
  let firstError: unknown = null;
  for (const task of plan.tasks) {
    try {
      const input = JSON.parse(JSON.stringify(task.input).split("{{speech}}").join(media.audio?.url ?? ""));
      const t = await ephone<{ id?: string }>(env, "POST", "/v1/task/submit", { model: task.model, input }, { timeoutMs: 30_000, routing: task.routing });
      if (!t.id) throw new KieError("ephone.ai answered no task id", 502, true);
      slots.push({ task: String(t.id), status: "running", type: task.output, model: task.model });
    } catch (e) {
      firstError ??= e;
      slots.push({ task: null, status: "failed", type: task.output, error: publicText(e instanceof Error ? e.message : String(e)).slice(0, 200) });
    }
  }
  if (!slots.some((x) => x.status === "running")) {
    await failGeneration(env, id, refusal(firstError, tool.output === "image" ? "image" : tool.output === "audio" ? "audio" : "video"), { provider: String(firstError instanceof Error ? firstError.message : firstError).slice(0, 300) });
  } else {
    await moveGeneration(env, id, ["submitting"], "running", { task_id: slots.find((x) => x.task)!.task, slots: JSON.stringify(slots) });
    await audit(asEnv(env), userId, id, "studio.submitted", { tasks: slots.map((x) => x.task), tool: tool.key });
  }
  return (await getGeneration(env, id))!;
}
