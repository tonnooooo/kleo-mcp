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
import { wavespeedSubmit, wavespeedTask, wavespeedUpload } from "../wavespeed.ts";
import { apimartSubmit, apimartTask, MUSIC_PREFIX } from "../apimart.ts";
import { backupRoutes, withinBudget, type BackupProvider } from "./backups.ts";
import { KieError } from "../kie.ts";
import { debitCredits, refundCredits, getUser, hasPaid, audit, countAuditTodayForUser } from "../db.ts";
import { publicText, rid } from "../util.ts";
import { clampFreeResolution, clipCostUsd, clipCredits, freeModels, freeResolutions, modelByKey, normalizeSettings, taskInput, wanCostUsd, wanOffered, wanOrder, DEFAULT_MARGIN, WAN_KEY, WAN_NAME, type ClipSettings } from "./models.ts";
import { presetByKey, withPreset } from "./presets.ts";
import { planTool, toolByKey, toolCredits, toneText, ToolRefusal, TOOLS, type Media, type Plan, type ToolKey } from "./tools.ts";
import { mediaInfo } from "./media.ts";
import { refreshFilm } from "./films.ts";
import { alternativeFor, freeImageModels, imageAlternatives, imageCostUsd, imageCredits, imageModelByKey, imageModelOfProvider, imageTaskInput, isQualityRefusal, normalizeImageSettings, otherQualitySpelling, pausedImageModels, type ImageSettings } from "./image-models.ts";
import {
  addUpload, autoWanOn, getGeneration, insertGeneration, moveGeneration, markChecked, runningCount, settleWanOffer, studioSpentTodayUsd, uploadsOf,
  type GenerationRow, type GenStatus, type Slot, type UploadRow,
} from "./store.ts";
import { signPath } from "./session.ts";
import { addressBlocked } from "../abuse.ts";
import { toEnglish } from "./translate.ts";

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

/**
 * ePhone first, then the backup (20 October 2026, src/studio/backups.ts). An order moves to the backup only when ePhone
 * cannot take it: an empty balance (402), a rate limit or an outage (429, 5xx), no key, or no answer at all. Never for a
 * refusal of the request itself (the backup sells the same model and would refuse it too), and never after a timeout
 * (ePhone may have taken that order). STUDIO_BACKUPS = "off" keeps every order on ePhone.
 */
export function switchesToBackup(e: unknown): boolean {
  if (e instanceof KieError) return e.status === 402 || e.status === 429 || e.status >= 500 || (e.status === 0 && /API_KEY is not set/.test(e.message));
  const name = e instanceof Error ? e.name : "";
  return name !== "TimeoutError" && name !== "AbortError";
}
const backupKey = (env: StudioEnv, p: BackupProvider): boolean => !!(p === "apimart" ? env.APIMART_API_KEY : env.WAVESPEED_API_KEY)?.trim();

/** Where an order went: its task id, and the provider holding it when that is not ePhone. */
export interface Placed { task: string; provider?: BackupProvider }

/**
 * Starts one task: on ePhone, or (when ePhone cannot take it) on the model's backup. `who` names the account and the
 * generation for the audit; `budgetUsd` is what Kleo priced the order at, and a backup dearer than that is skipped.
 * Throws what the last provider tried answered (ePhone's own error when there is no backup).
 */
export async function placeTask(env: StudioEnv, model: string, input: Record<string, unknown>, routing: Record<string, string> | undefined, who?: { userId: string; genId: string }, budgetUsd?: number | null): Promise<Placed> {
  try {
    const t = await ephone<{ id?: string }>(env, "POST", "/v1/task/submit", { model, input }, { timeoutMs: 30_000, routing });
    if (!t.id) throw new KieError("ephone.ai answered no task id", 502, true);
    return { task: String(t.id) };
  } catch (e) {
    if ((env.STUDIO_BACKUPS ?? "").trim() === "off" || !switchesToBackup(e)) throw e;
    let last: unknown = e;
    for (const r of withinBudget(backupRoutes(model, input), budgetUsd)) {
      if (!backupKey(env, r.provider)) continue;
      try {
        const id = r.provider === "apimart" ? await apimartSubmit(env, r.path, r.body) : await wavespeedSubmit(env, r.path, r.body);
        if (who) await audit(asEnv(env), who.userId, who.genId, "studio.backup", { from: model, to: `${r.provider}:${r.model}`, usd: r.usd, why: String(e instanceof Error ? e.message : e).slice(0, 200) });
        return { task: r.music ? `${MUSIC_PREFIX}${id}` : id, provider: r.provider };
      } catch (e2) {
        last = e2;
        if (!switchesToBackup(e2)) break;
      }
    }
    throw last;
  }
}

/** One task's state from whichever provider holds it, read as an ePhone task. */
export async function readTask(env: StudioEnv, task: string, provider: BackupProvider | undefined, routing?: Record<string, string>): Promise<EphoneTask> {
  if (provider === "apimart") return apimartTask(env, task);
  if (provider === "wavespeed") return wavespeedTask(env, task);
  return ephone<EphoneTask>(env, "GET", `/v1/task/${encodeURIComponent(task)}`, undefined, { timeoutMs: 15_000, routing });
}

/** A clip's task id names its provider when that is not ePhone ("apimart:<id>"), so the poll knows where to ask. */
export const clipTaskId = (p: Placed): string => (p.provider ? `${p.provider}:${p.task}` : p.task);
export function clipTask(taskId: string): Placed {
  const m = /^(apimart|wavespeed):(.+)$/.exec(taskId);
  return m ? { provider: m[1] as BackupProvider, task: m[2] } : { task: taskId };
}

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
  // A picture its own model refused and FLUX 3 made says so (the card names the model that drew it).
  const madeBy = kind === "image" ? imageModelOfProvider(slots.find((x) => x.status === "done" && x.model)?.model ?? "") : null;
  const offer = kind === "video" ? wanOfferOf(g, settings as Partial<ClipSettings>) : null;
  return {
    id: g.id, kind, model: g.model,
    modelName: (kind === "image" ? imageModelByKey(madeBy ?? g.model)?.name : kind === "tool" ? toolByKey(g.model)?.name : kind === "film" ? (g.model === "kleo-animatic" ? "Kleo Animatic" : "Kleo Film") : g.model === WAN_KEY ? WAN_NAME : modelByKey(g.model)?.name) ?? g.model,
    settings, prompt: g.prompt, images, credits: g.credits,
    status: g.status === "submitting" || g.status === "saving" ? "running" : g.status,
    // A clip with an offer says which model refused it; the page puts the offer right under it.
    error: offer ? `${offer.from} won't make this one: it recognised characters, people or music protected by copyright. Your credits are back.`
      : remadeOnWan(g, settings) ? `${modelByKey(g.model)?.name ?? "The video model"} won't make this one: it recognised characters, people or music protected by copyright. Your credits are back, and you sent it to ${WAN_NAME}.` : g.error,
    offer, refunded: !!g.refunded, chatId: g.chat_id, messageId: g.message_id,
    // A clip the automatic switch moved to Wan 3.0 names the model that refused it.
    switchedFrom: kind === "video" && g.model === WAN_KEY && (settings as { auto?: boolean }).auto ? modelByKey((settings as { from?: string }).from)?.name ?? null : null,
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
 * THE OWNER'S ADMIN ACCOUNT (15 October 2026, "un account admin con accesso illimitato a tutti i modelli, per me").
 * STUDIO_ADMINS lists account ids. An admin passes every gate but "sign in" and a generous running cap: every model,
 * resolution and app, no free pools, no daily budget, no address limits, and a balance that cannot run out (the account
 * carries a tester payment and a large credit balance, so the MCP film paths treat it the same). Its spend is left out
 * of the daily budgets, so the owner's own tests never close the day for customers.
 */
export const adminIds = (env: StudioEnv): string[] => (env.STUDIO_ADMINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
export const isAdmin = (env: StudioEnv, userId: string): boolean => adminIds(env).includes(userId);

/**
 * The checks every order passes, in order, before any money moves (and before any paid work, such as speech).
 * TWO DAILY POOLS (14 October 2026): accounts that never paid draw on their own, smaller STUDIO_FREE_DAILY_BUDGET_USD,
 * so a crowd of throwaway accounts spending free credits can never fill the day for paying customers.
 */
async function gate(env: StudioEnv, userId: string, o: Gate): Promise<void> {
  const user = await getUser(asEnv(env), userId);
  if (!user) throw new StudioError("Please sign in again.", 401, "signin");
  if (isAdmin(env, userId)) {
    if ((await runningCount(env, userId)) >= 12) throw new StudioError("You already have 12 things generating. Wait for one to finish.", 429, "busy");
    return;
  }
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
  // A provider's rate limit (WaveSpeed answers 429 when too many runs start at once) is a busy minute, not a refusal.
  if (e instanceof KieError && e.status === 429) return `The ${noun} model is busy right now. Your credits are back — please try again in a minute.`;
  const why = e instanceof Error ? e.message : String(e);
  if (isCopyrightRefusal(why)) return copyrightText(`${noun} model`);
  return `The ${noun} model refused this request: ${publicText(why).replace(/^.*?→ \d+: /, "")}`;
}

/**
 * A copyright refusal, told plainly (19 October 2026: the owner's first customer met Seedance's "the output video may
 * be related to copyright restrictions" three times, with a 50-character request id running off her phone's screen).
 */
// WaveSpeed's words for the same refusal (19 October 2026, Pixar characters in a viral template): "Content flagged as
// potentially sensitive". Alibaba's own, through ePhone: "IPInfringementSuspect". ePhone answers some errors in Chinese
// (20 October 2026, "资源同步失败" for a picture too small): 版权 is "copyright".
export const isCopyrightRefusal = (why: string): boolean => /copyright|protected content|intellectual property|IPInfringement|flagged as potentially sensitive|版权/i.test(why);
const copyrightText = (noun: string): string =>
  `The ${noun} won't make this one: it recognised characters, people or music protected by copyright, from a film, a show or a song. Your credits are back. Try your own characters, and leave out their pictures and names.`;
/** What a failed generation says: the copyright sentence, or the provider's reason in neutral words. */
export function failureText(noun: string, why: string): string {
  if (isCopyrightRefusal(why)) return copyrightText(noun);
  return `The ${noun} could not make this one: ${publicText(why).replace(/[.\s]+$/, "")}. Your credits are back.`;
}

/**
 * The offer a refused clip carries (models.ts WAN_KEY): a Seedance clip refused for copyright, its credits given back,
 * neither made again nor declined yet. The same credits it cost buy the second try. Null for every other clip.
 */
export function wanOfferOf(g: GenerationRow, settings: Partial<ClipSettings> & { wan?: unknown; clips?: number }): { model: string; name: string; from: string; credits: number } | null {
  if (g.status !== "failed" || !g.refunded || settings.wan || !isCopyrightRefusal(g.error ?? "") || !wanOffered(settings)) return null;
  return { model: WAN_KEY, name: WAN_NAME, from: modelByKey(g.model)?.name ?? "This model", credits: g.credits };
}

/** A refused clip whose offer was taken: settings.wan holds the new clip's id. */
const remadeOnWan = (g: GenerationRow, settings: unknown): boolean => g.status === "failed" && /^g_/.test(String((settings as { wan?: unknown }).wan ?? ""));

/**
 * "Use Wan 3.0" (20 October 2026, the owner: "metti un avviso… usa Wan 3.0 / no grazie, in modo tale da non perdere il
 * cliente"). The refused clip is made again on WaveSpeed's Wan 3.0 with everything it asked for, as a new clip charged
 * the same credits (the refused one gave them back). The offer is settled first, so it is taken once.
 */
export async function retryOnWan(env: StudioEnv, userId: string, g: GenerationRow, origin: string): Promise<GenerationRow> {
  let s: ClipSettings & { preset?: string | null; wan?: unknown };
  try { s = JSON.parse(g.settings); } catch { s = {} as ClipSettings; }
  if (g.user_id !== userId) throw new StudioError("Not found.", 404);
  if (!wanOfferOf(g, s)) throw new StudioError(`This video can't be made again with ${WAN_NAME}.`, 409, "no_offer");
  if (!wanReady(env)) throw new StudioError(`${WAN_NAME} isn't available right now. Try again later — nothing was charged.`, 503, "unavailable");
  const rows = await clipPictures(env, g);
  if (!rows) throw new StudioError("A picture or clip this video was made from was deleted, so it can't be made again. Add it again on the Video page.", 409, "gone");

  const usd = wanCostUsd(s);
  const free = freeModels(env.STUDIO_FREE_MODELS), freeRes = freeResolutions(env.STUDIO_FREE_RESOLUTIONS);
  const id = await charge(env, userId, {
    freeOk: free.includes(s.model) && freeRes.includes(s.resolution), credits: g.credits, usd, noun: "video",
    lockedMessage: `${s.resolution} unlocks with your first credit pack.`,
  });
  if (!(await settleWanOffer(env, g.id, userId, id))) {
    await refundCredits(asEnv(env), userId, g.credits, id, "studio.wan_twice");
    throw new StudioError(`This video is already being made with ${WAN_NAME}.`, 409, "busy");
  }
  const { wan: _settled, ...asked } = s;
  try {
    await insertGeneration(env, { id, userId, chatId: g.chat_id, messageId: g.message_id, model: WAN_KEY, settings: { ...asked, model: WAN_KEY, from: g.id }, prompt: g.prompt, images: rows.map((r) => `/media/u/${r.id}`), credits: g.credits, estUsd: usd });
  } catch (e) {
    await refundCredits(asEnv(env), userId, g.credits, id, "studio.insert_failed");
    await settleWanOffer(env, g.id, userId, null);
    throw e;
  }
  await audit(asEnv(env), userId, id, "studio.create", { model: WAN_KEY, from: g.id, settings: asked, credits: g.credits, usd });
  try {
    const w = await startWan(env, s, await wanPrompt(env, g.prompt, s.preset), rows, origin);
    await moveGeneration(env, id, ["submitting"], "running", { task_id: w.taskId });
    await audit(asEnv(env), userId, id, "studio.submitted", { task: w.taskId, model: w.slug, provider: "wavespeed" });
    await audit(asEnv(env), userId, g.id, "studio.wan_retry", { to: id, model: w.slug, usd });
  } catch (e) {
    await failGeneration(env, id, refusal(e, "video"), { provider: String(e instanceof Error ? e.message : e).slice(0, 300) });
  }
  return (await getGeneration(env, id))!;
}

/** "No thanks": the offer goes away for good (the refused clip stays, with its credits back). */
export async function declineWan(env: StudioEnv, userId: string, g: GenerationRow): Promise<GenerationRow> {
  if (g.user_id !== userId) throw new StudioError("Not found.", 404);
  let s: Partial<ClipSettings> = {};
  try { s = JSON.parse(g.settings); } catch { /* no offer */ }
  if (!wanOfferOf(g, s)) return g;
  if (await settleWanOffer(env, g.id, userId, "declined")) await audit(asEnv(env), userId, g.id, "studio.wan_declined", {});
  return (await getGeneration(env, g.id))!;
}

const wanReady = (env: StudioEnv): boolean => !!(env.WAVESPEED_API_KEY ?? "").trim();
/** Studio's own address when no request is at hand (the cron): the provider fetches signed links on it. */
const studioOrigin = (env: StudioEnv): string => (env.STUDIO_URL ?? "").trim().replace(/\/+$/, "") || `https://${(env.CANONICAL_HOST ?? "").trim() || "app.kleooai.com"}`;

/** The pictures a clip was made from, in their order; null when the person deleted one since. */
async function clipPictures(env: StudioEnv, g: GenerationRow): Promise<UploadRow[] | null> {
  let paths: string[] = [];
  try { paths = JSON.parse(g.images ?? "[]"); } catch { /* none */ }
  const ids = paths.map((p) => /^\/media\/u\/(up_[a-z0-9]+)$/.exec(p)?.[1] ?? "");
  const found = await uploadsOf(env, g.user_id, ids);
  const rows = ids.map((id) => found.find((r) => r.id === id));
  return rows.every((r): r is UploadRow => !!r && (r.kind ?? "image") === "image") ? rows : null;
}

/** A clip's words for Wan, as the first try sent them: the person's words in English, the camera preset after them. */
async function wanPrompt(env: StudioEnv, prompt: string, presetKey: string | null | undefined): Promise<string> {
  const preset = presetByKey(presetKey)?.text;
  const own = (preset ? prompt.replace(preset, "") : prompt).trim();
  return own ? withPreset(await toEnglish(env, own, "video"), presetKey) : preset ?? "";
}

/**
 * Starts a clip on Wan 3.0 and answers its task id. The pictures go into WaveSpeed's own storage first (as the viral
 * templates' photos do), each on a signed link of Studio's when it cannot be copied.
 */
async function startWan(env: StudioEnv, s: ClipSettings, english: string, pictures: UploadRow[], origin: string): Promise<{ taskId: string; slug: string }> {
  const links = await Promise.all(pictures.map(async (r) => (await copyToWavespeed(env, r)) ?? `${origin}${await signPath(env.INTERNAL_SECRET, `/media/u/${r.id}`, IMAGE_LINK_TTL_S)}`));
  const order = wanOrder(s, english, links);
  const task = await wavespeedSubmit(env, order.slug, order.body);
  return { taskId: clipTaskId({ task, provider: "wavespeed" }), slug: order.slug };
}

/**
 * THE AUTOMATIC SWITCH (20 October 2026, the owner: "metti una spunta, abilita cambio automatico, durante l'avviso").
 * An account that ticked it (users.studio_auto_wan) never sees the offer: a Seedance clip refused for copyright goes on
 * by itself on Wan 3.0, in the same card, for the credits already paid (Wan costs less), whether the refusal came when
 * the order went out or when the video was checked. Once per clip: the row's model becomes Wan 3.0. False when the clip
 * does not qualify or Wan could not be started; the clip then fails as before, its credits back and the offer on it.
 */
async function switchToWan(env: StudioEnv, g: GenerationRow, s: ClipSettings & { preset?: string | null; clips?: number }, why: string, from: GenStatus, start: () => Promise<{ taskId: string; slug: string }>): Promise<boolean> {
  if (!isCopyrightRefusal(why) || !wanOffered(s) || !wanReady(env) || !(await autoWanOn(env, g.user_id))) return false;
  // The poll holds the clip while it switches, so two polls never start two clips.
  if (from === "running" && !(await moveGeneration(env, g.id, ["running"], "saving"))) return true;
  const held: GenStatus = from === "running" ? "saving" : from;
  try {
    const w = await start();
    if (!(await moveGeneration(env, g.id, [held], "running", { task_id: w.taskId, model: WAN_KEY, settings: JSON.stringify({ ...s, model: WAN_KEY, from: s.model, auto: true }) }))) return true;
    await audit(asEnv(env), g.user_id, g.id, "studio.wan_auto", { from: s.model, to: w.slug, task: w.taskId, usd: wanCostUsd(s), why: why.slice(0, 200) });
    return true;
  } catch (e) {
    if (held === "saving") await moveGeneration(env, g.id, ["saving"], "running");
    await audit(asEnv(env), g.user_id, g.id, "studio.wan_auto_failed", { error: String(e instanceof Error ? e.message : e).slice(0, 200) });
    return false;
  }
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
  // The video and sound clips it came with are counted, so a refusal is never sent to Wan 3.0 without them.
  const stored = { ...s, preset: req.preset ?? null, ...(videos.length + sounds.length ? { clips: videos.length + sounds.length } : {}) };
  try {
    await insertGeneration(env, { id, userId, chatId: req.chatId ?? null, messageId: req.messageId ?? null, model: s.model, settings: stored, prompt, images: imagePaths, credits, estUsd: usd });
  } catch (e) {
    await refundCredits(asEnv(env), userId, credits, id, "studio.insert_failed");
    throw e;
  }
  await audit(asEnv(env), userId, id, "studio.create", { model: s.model, settings: s, credits, usd });

  // The provider fetches the pictures and clips through short signed links on this same host.
  const link = async (u: { id: string }) => `${origin}${await signPath(env.INTERNAL_SECRET, `/media/u/${u.id}`, IMAGE_LINK_TTL_S)}`;
  const links = await Promise.all(pictures.map(link));
  const clipLinks = { videos: await Promise.all(videos.map(link)), audios: await Promise.all(sounds.map(link)) };
  let english = "";
  try {
    // Any language in, English to the model (./translate.ts); the card keeps the person's own words.
    english = prompt ? withPreset(await toEnglish(env, (req.prompt ?? "").trim(), "video"), req.preset) : "Bring this picture to life with natural, cinematic motion.";
    const input = taskInput(s, english, links, await safetyId(env, userId), clipLinks);
    const placed = await placeTask(env, model.ephoneModel, input, model.routing, { userId, genId: id }, usd);
    await moveGeneration(env, id, ["submitting"], "running", { task_id: clipTaskId(placed) });
    await audit(asEnv(env), userId, id, "studio.submitted", { task: placed.task, model: model.ephoneModel, provider: placed.provider ?? "ephone" });
  } catch (e) {
    const why = String(e instanceof Error ? e.message : e);
    const row = (await getGeneration(env, id))!;
    if (!(await switchToWan(env, row, stored, why, "submitting", () => startWan(env, s, english, pictures, origin)))) {
      await failGeneration(env, id, refusal(e, "video"), { provider: why.slice(0, 300) });
    }
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
  if (pausedImageModels(env.STUDIO_PAUSED_IMAGE_MODELS).includes(s.model)) {
    throw new StudioError(`${model.name} is paused for a little while: its provider is having trouble. Use FLUX.2 Pro or Seedream 5.0 — nothing was charged.`, 503, "paused");
  }
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
  const english = await toEnglish(env, prompt, "image");
  let input = imageTaskInput(s, english, links);
  // A refusal of a well-known character (Google, ByteDance, OpenAI, BFL) is made again on FLUX 3 for the same credits.
  const alts = imageAlternatives(s, english, links);
  let otherTried = false;
  const slots: Slot[] = [];
  let firstError: unknown = null;
  for (let i = 0; i < s.count; i++) {
    try {
      let t: Placed;
      let slot: Slot = { task: null, status: "running", ...(alts.length ? { alts } : {}) };
      const who = { userId, genId: id };
      try {
        t = await placeTask(env, model.ephoneModel, input, model.routing, who, usd / s.count);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        const alt = alternativeFor(alts, why);
        if (alt && !(e instanceof KieError && e.status === 402)) {
          // Refused at the door (the prompt or a reference): straight to the second try.
          t = await placeTask(env, alt.model, alt.input, toolRouting(alt.model), who);
          slot = { ...slot, model: alt.model, alts: alts.slice(alts.indexOf(alt) + 1) };
          await audit(asEnv(env), userId, id, "studio.fallback", { from: model.ephoneModel, to: alt.model, when: alt.when, why: why.slice(0, 200) });
        } else {
          // Gemini's quality field has two spellings and ePhone has refused each at some point: one retry with the other.
          if (otherTried || !model.key.startsWith("nano-banana") || !isQualityRefusal(why)) throw e;
          otherTried = true;
          input = imageTaskInput(s, english, links, true);
          t = await placeTask(env, model.ephoneModel, input, model.routing, who, usd / s.count);
        }
      }
      slots.push({ ...slot, task: t.task, ...(t.provider ? { provider: t.provider } : {}) });
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
    await audit(asEnv(env), userId, id, "studio.submitted", { tasks: slots.map((x) => x.task), model: model.ephoneModel, providers: slots.map((x) => x.provider ?? "ephone") });
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
  // A clip the automatic switch moved to Wan 3.0 part way gets a second allowance of time (a clip made again on Wan
  // after "Use Wan 3.0" is a new row, with its own clock).
  if (ageMin > GENERATION_TIMEOUT_MIN * (g.model === WAN_KEY && /"auto":true/.test(g.settings) ? 2 : 1)) {
    await failGeneration(env, g.id, "The video model took too long. Your credits are back.", { stage: "timeout", minutes: Math.round(ageMin) });
    return (await getGeneration(env, g.id))!;
  }
  const model = modelByKey(g.model);
  const held = clipTask(g.task_id);
  let t: EphoneTask;
  try {
    t = await readTask(env, held.task, held.provider, model?.routing);
  } catch (e) {
    // A failed status read is not a failed video: try again on the next refresh.
    return g;
  }
  const status = String(t.status ?? "").toLowerCase();
  if (status === "failed" || status === "failure" || status === "cancelled") {
    const why = ephoneFailure(t);
    let s: ClipSettings & { preset?: string | null } = {} as ClipSettings;
    try { s = JSON.parse(g.settings); } catch { /* no switch */ }
    const switched = await switchToWan(env, g, s, why, "running", async () => {
      const pictures = await clipPictures(env, g);
      if (!pictures) throw new Error("a picture of the clip was deleted");
      return startWan(env, s, await wanPrompt(env, g.prompt, s.preset), pictures, studioOrigin(env));
    });
    if (!switched) await failGeneration(env, g.id, failureText("video model", why), { stage: "provider", usage: t.usage ?? null, provider: why.slice(0, 300) });
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
 * A refused picture's second try (src/studio/image-models.ts imageAlternatives): the slot runs on with the new task.
 * False when the refusal earns none, or the second try could not be started (the slot then fails as before).
 */
async function secondTry(env: StudioEnv, g: GenerationRow, slot: Slot, why: string): Promise<boolean> {
  const alt = g.kind === "image" ? alternativeFor(slot.alts, why) : null;
  if (!alt) return false;
  const from = slot.model ?? imageModelByKey(g.model)?.ephoneModel ?? g.model;
  slot.alts = (slot.alts ?? []).slice((slot.alts ?? []).indexOf(alt) + 1);
  try {
    const t = await placeTask(env, alt.model, alt.input, toolRouting(alt.model), { userId: g.user_id, genId: g.id });
    Object.assign(slot, { task: t.task, model: alt.model, status: "running" });
    if (t.provider) slot.provider = t.provider; else delete slot.provider;
    await audit(asEnv(env), g.user_id, g.id, "studio.fallback", { from, to: alt.model, when: alt.when, why: why.slice(0, 200) });
    return true;
  } catch {
    return false;
  }
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
    try {
      t = await readTask(env, slot.task, slot.provider, slot.model ? toolRouting(slot.model) : routing);
    } catch { continue; }
    const status = String(t.status ?? "").toLowerCase();
    if (status === "failed" || status === "failure" || status === "cancelled") {
      const why = ephoneFailure(t);
      if (!(await secondTry(env, g, slot, why))) { slot.status = "failed"; slot.error = publicText(why).slice(0, 200); }
      continue;
    }
    if (status !== "completed" && status !== "succeeded" && status !== "success") continue;
    const want = slot.type ?? "image";
    const urls = mediaOutputs(t).filter((u) => kindOfUrl(u) === want || kindOfUrl(u) === null);
    if (!urls.length) {
      if (!(await secondTry(env, g, slot, "no image generated in response"))) { slot.status = "failed"; slot.error = "no result"; }
      continue;
    }
    // A first step (Character Swap's redrawn first frame) starts the second with its result, and the slot runs on.
    if (slot.then) {
      const next = slot.then;
      delete slot.then;
      try {
        const input = JSON.parse(JSON.stringify(next.input).split("{{prev}}").join(urls[0]));
        const t2 = await placeTask(env, next.model, input, next.routing, { userId: g.user_id, genId: g.id }, g.est_usd);
        Object.assign(slot, { task: t2.task, model: next.model, type: next.output, status: "running" });
        if (t2.provider) slot.provider = t2.provider; else delete slot.provider;
        await audit(asEnv(env), g.user_id, g.id, "studio.next_step", { task: t2.task, model: next.model, provider: t2.provider ?? "ephone" });
      } catch (e) {
        slot.status = "failed";
        slot.error = publicText(e instanceof Error ? e.message : String(e)).slice(0, 200);
      }
      continue;
    }
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
    await failGeneration(env, g.id, why ? failureText(noun, why) : `The ${noun} took too long. Your credits are back.`, { stage: g.kind });
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
const TOOL_ROUTED = new Set(["gemini-3-pro-image", "flux-tools/vto-v1", "flux-tools/video-edit-v1", "flux-tools/video-upscale-v1", "flux-2-pro", "flux-3-image", "gpt-image-2.5-sunburst", "aleph2/video-to-video"]);
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
  // Every app (the list once written out here had missed the two Character Swaps, so a paying account saw them locked).
  if (raw === "*") return TOOLS.map((t) => t.key);
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

/**
 * A template's photos, copied into WaveSpeed's own storage before the run (20 October 2026): the model then reads them
 * from there instead of fetching Kleo's signed links. A photo that cannot be copied keeps its signed link.
 */
async function rehostForWavespeed(env: StudioEnv, urls: string[], media: Record<string, Media | undefined>, rows: { id: string; key: string; content_type: string | null }[]): Promise<string[]> {
  return Promise.all(urls.map(async (url) => {
    const m = Object.values(media).find((x) => x?.url === url);
    const row = m ? rows.find((r) => r.id === m.id) : undefined;
    return (row && (await copyToWavespeed(env, row))) || url;
  }));
}
/** One of the person's pictures copied into WaveSpeed's storage: its download link, or null when it could not be copied. */
async function copyToWavespeed(env: StudioEnv, row: { id: string; key: string; content_type: string | null }): Promise<string | null> {
  try {
    const obj = await env.RENDERS.get(row.key);
    if (!obj) return null;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const type = row.content_type || obj.httpMetadata?.contentType || "image/jpeg";
    const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
    return await wavespeedUpload(env, bytes, `${row.id}.${ext}`, type);
  } catch {
    return null;
  }
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
  // An app's description of what to make or change is read in English by its model; words to SPEAK and song
  // descriptions are not touched (a song asked for in Italian may well be sung in Italian).
  const kind = ({ "video-edit": "edit", "motion-control": "video", "character-swap": "edit", "photo-character-swap": "image", sfx: "sound" } as const)[tool.key as "video-edit" | "motion-control" | "character-swap" | "photo-character-swap" | "sfx"];
  if (kind && inputs.prompt) inputs.prompt = (await toEnglish(env, inputs.prompt, kind)).slice(0, tool.fields.find((f) => f.key === "prompt")?.maxLength ?? 1000);
  let plan: Plan;
  try { plan = planTool(tool.key, inputs, media); } catch (e) { if (e instanceof ToolRefusal) throw new StudioError(e.message); throw e; }
  // An app that runs on a paused picture model (Face Swap on Nano Banana Pro) is paused with it, before any charge.
  const pausedImages = pausedImageModels(env.STUDIO_PAUSED_IMAGE_MODELS);
  if (plan.tasks.some((t) => { const k = imageModelOfProvider(t.model); return !!k && pausedImages.includes(k); })) {
    throw new StudioError(`${tool.name} is paused for a little while: its provider is having trouble. Try again later — nothing was charged.`, 503, "paused");
  }

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
      const fill = (o: unknown) => JSON.parse(JSON.stringify(o).split("{{speech}}").join(media.audio?.url ?? ""));
      const input = fill(task.input);
      if (task.provider === "wavespeed") {
        if (Array.isArray(input.reference_images)) input.reference_images = await rehostForWavespeed(env, input.reference_images as string[], media, rows);
        slots.push({ task: await wavespeedSubmit(env, task.model, input), status: "running", type: task.output, model: task.model, provider: "wavespeed" });
        continue;
      }
      let t: Placed;
      const who = { userId, genId: id };
      try {
        t = await placeTask(env, task.model, input, task.routing, who, plan.usd);
      } catch (e) {
        // A Gemini app (Face Swap, Photo Character Swap) whose quality spelling ePhone refuses gets one retry with the other.
        if (!task.model.startsWith("gemini-") || typeof input.quality !== "string" || !isQualityRefusal(e instanceof Error ? e.message : String(e))) throw e;
        input.quality = otherQualitySpelling(input.quality);
        t = await placeTask(env, task.model, input, task.routing, who, plan.usd);
      }
      slots.push({ task: t.task, status: "running", type: task.output, model: task.model, ...(t.provider ? { provider: t.provider } : {}),
        ...(task.then ? { then: { model: task.then.model, input: fill(task.then.input), output: task.then.output, routing: task.then.routing } } : {}) });
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
