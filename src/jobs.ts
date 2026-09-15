import type { Env } from "./env";
import { type Job, type JobParams, type JobState, type User, OPEN_STATES, countOpenForUser, countJobsTodayForUser, addJobCost, debitCredits, refundCredits, insertJob, transitionJob, audit, getUserJob, listFiles, hasPaid } from "./db";
import { accountUrl } from "./accounts";
import { findTemplate, affordableGuess, creditsFor, creditsForProduct, etaFor, animaticEtaFor, normalizeVoice, voiceSpellings, isVideoStyle, videoModelIsGated, isPublicTemplate, FILM_TEMPLATE_ID, FILM_LONG_TEMPLATE_ID, filmTemplateFor, ACTIVE_TEMPLATE, PRODUCTS, ANIMATIC_CREDITS, ANIMATIC_MAX_S, filmedStoryboard, finishForProduct, type Format, type Product } from "./templates";
import { footageBackendFor, footageConfig, kiePreflight } from "./footage";
import { rid, nowIso, int, hmacHex } from "./util";
import { isFlagActive } from "./schema";
import { backendFor } from "./backends";
import { validateStoryboard, kleoStyleOf, pictureScenes, narrationOf, MAX_PICTURES, wordBudget, KLEO_STYLES, FILM_LOOKS, type KleoStyle, type FilmLook } from "./keou-contract";
import { treatmentProblems, repairTreatment, variationFor } from "./treatment.ts";

/** An error whose message is shown to the user as-is: plain English, always says whether something was charged. */
export class JobError extends Error {}

export interface CreateInput {
  template: string;
  prompt: string;
  duration_s?: number;
  format?: Format;
  language?: string;
  voice?: string;
  notify_email?: string;
  /** Kleo has two looks, "realistic" and "animation"; anything else is refused. Optional. */
  style?: string;
  /**
   * "film" (default: every shot filmed by kie.ai, for accounts that have paid) or "animatic" (the same stills with
   * the camera over them, no generated clip, ANIMATIC_CREDITS flat, up to ANIMATIC_MAX_S seconds, open to every
   * account). See templates.ts, the two products of 15 September 2026.
   */
  product?: string;
  /** Optional client-authored Keou storyboard (see keou-contract.ts); validated here, stored as JSON. */
  storyboard?: unknown;
  /**
   * Optional treatment (src/treatment.ts), the object kleo_adapt_prompt returned, possibly edited by the user.
   * Checked here in words; the planner then plans under it instead of writing its own.
   */
  treatment?: unknown;
}

/** Minimal safety gate before any GPU money is spent. Replace with a real moderation API before opening to the public. */
const BLOCKED = [/\b(child|kid|minor|underage|preteen|loli)\w*\b[^.]{0,60}\b(sex|nude|naked|porn|erotic)/i, /\b(sex|nude|naked|porn|erotic)\w*\b[^.]{0,60}\b(child|kid|minor|underage|preteen)/i];
export function moderationBlocks(text: string): boolean {
  return BLOCKED.some((re) => re.test(text));
}

/** "1 credit" / "3 credits". */
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** "Short" for vertical videos, "video" otherwise. */
export const kindOf = (format: string | null | undefined): "Short" | "video" => (format === "9:16" ? "Short" : "video");
const capital = (s: string) => s[0].toUpperCase() + s.slice(1);
const formatWords = (f: Format) => (f === "9:16" ? "9:16 Shorts" : "16:9 videos");

/**
 * Credits given back when a job is cancelled. Nothing was rendered before the GPU reports its first real
 * progress, so `queued` and `starting` give everything back; while rendering the refund follows the work
 * left, rounded to the nearest credit (a 1-credit Short cancelled below 50% is free, above it costs the credit).
 */
export function refundFor(credits: number, state: JobState, percent: number): number {
  if (credits <= 0) return 0;
  if (state === "queued" || state === "starting") return credits;
  const pct = Math.max(0, Math.min(100, percent));
  return Math.max(0, Math.min(credits, Math.round((credits * (100 - pct)) / 100)));
}

/**
 * "This storyboard asks for more work than it was priced for."
 *
 * A PRICE rule, deliberately not a contract rule: validateStoryboard answers "is this written correctly", and a
 * correctly written storyboard can still ask for ten times the GPU of the length it is charged on. The price is
 * creditsFor(duration, style) — two numbers — while the bill is set by how many pictures get drawn and how long the
 * voice actually speaks, and neither of those was bounded anywhere for a storyboard written by the caller:
 * MAX_PICTURES only ever sliced the list the SERVER draws (images.ts), and wordBudget was only ever advice.
 * With IMAGE_SERVER_MAX=0 every picture is drawn by the rented GPU, so a 1-credit Short could ask for hundreds.
 *
 * It runs BEFORE the debit and throws, so nothing is charged; and it says the number asked, the number allowed and
 * the way out, because a refusal that does not say how to pass is a dead end with an explanation on it.
 */
export function overPaidFor(sb: unknown, duration: number): string[] {
  const out: string[] = [];
  const pictures = pictureScenes(sb).length;
  const maxPictures = MAX_PICTURES(duration);
  if (pictures > maxPictures)
    out.push(`This storyboard asks for ${pictures} pictures and a ${duration}-second video allows ${maxPictures}. ` +
      `Give some scenes fewer shots, or ask for a longer video. Nothing was charged.`);
  const words = narrationOf(sb).trim().split(/\s+/).filter(Boolean).length;
  const maxWords = wordBudget(duration).max;
  if (words > maxWords)
    out.push(`This storyboard has ${words} words of narration and a ${duration}-second video fits about ${maxWords}. ` +
      `The voice decides how long the video really is, so this one would run far past the length it was priced on: ` +
      `shorten the narration, or ask for a longer video. Nothing was charged.`);
  return out;
}

export async function createJob(env: Env, user: User, input: CreateInput): Promise<Job> {
  // The public template is "film", 15 to 300 seconds; the length decides which internal row plans it (the short
  // arc or the chapters). The range is checked on the PUBLIC template first, so the message names the range the
  // user was offered, not the row's half of it.
  const active = ACTIVE_TEMPLATE;
  const asked = input.duration_s ?? active.defaultSeconds;
  if ((!input.template || input.template === FILM_TEMPLATE_ID) && (asked < active.minSeconds || asked > active.maxSeconds))
    throw new JobError(`Kleo makes films of ${active.minSeconds} to ${active.maxSeconds} seconds; ${Math.round(asked)} seconds is outside that range. Choose a length in range. Nothing was charged.`);
  const t = findTemplate(!input.template || input.template === FILM_TEMPLATE_ID ? filmTemplateFor(asked) : input.template);
  if (!t) throw new JobError(`There is no template called "${input.template}". Call kleo_list_templates for the valid ids. Nothing was charged.`);
  // One product (13 September 2026): the film. The old templates stay readable for the rows made with them and
  // for the planner's families, but a new video is not made with them.
  if (!isPublicTemplate(t.id)) throw new JobError(`Kleo makes one kind of video now: a film, realistic or animated, 16:9 or 9:16 ("${FILM_TEMPLATE_ID}" up to 90 seconds, "${FILM_LONG_TEMPLATE_ID}" up to 300). Omit the template and say the length. Nothing was charged.`);
  const format = (input.format ?? t.formats[0]) as Format;
  if (!t.formats.includes(format))
    throw new JobError(`The "${t.name}" template only makes ${formatWords(t.formats[0])}, not ${formatWords(format)}. Pick ${t.formats[0]} or another template. Nothing was charged.`);
  const duration = Math.round(input.duration_s ?? t.defaultSeconds);
  if (duration < t.minSeconds || duration > t.maxSeconds)
    throw new JobError(`The "${t.name}" template makes videos of ${t.minSeconds} to ${t.maxSeconds} seconds; ${duration} seconds is outside that range. Choose a length in range or another template. Nothing was charged.`);
  // THE TWO PRODUCTS (15 September 2026, templates.ts). The film is filmed by kie.ai with the owner's money, so it is
  // made only for an account with a payment on record; everyone else — the free credits, a bonus, a balance typed in
  // by hand, the owner's own test account — is offered the animatic, in words, before anything is charged.
  if (input.product !== undefined && !(PRODUCTS as readonly string[]).includes(input.product))
    throw new JobError(`Kleo makes two things: a "film" (every shot filmed) and an "animatic" (the same frames with the camera moving over them, ${plural(ANIMATIC_CREDITS, "credit")} flat). Pass product: "film" or "animatic", or omit it for the film. Nothing was charged.`);
  const product: Product = input.product === "animatic" ? "animatic" : "film";
  if (product === "animatic" && duration > ANIMATIC_MAX_S)
    throw new JobError(`An animatic is at most ${ANIMATIC_MAX_S} seconds long (${duration} asked): it is the preview of a film, not the film. Ask for ${ANIMATIC_MAX_S} seconds or less, or order the film itself. Nothing was charged.`);
  if (product === "film" && !(await hasPaid(env, user.id)))
    throw new JobError(`A film is made only for accounts that have bought a credit pack: its shots are generated clips that Kleo pays for per second, and the credits on this account were not paid for (a gift, a bonus or a test balance). Two ways on: call again with product: "animatic" — the same storyboard as drawn frames with the camera moving over them, narrated, 4K 60 fps, ${plural(ANIMATIC_CREDITS, "credit")} for up to ${ANIMATIC_MAX_S} seconds — or buy any pack (from 5 EUR) on the account page and the film opens: ${await accountUrl(env, user.id)}. Nothing was charged.`);
  const prompt = input.prompt.trim();
  if (prompt.length < 8) throw new JobError("The description is too short (at least 8 characters). Say what the video is about: topic, angle, tone, anything that must appear on screen. Nothing was charged.");
  if (prompt.length > 4000) throw new JobError(`The description is too long (${prompt.length} characters, the maximum is 4000). Shorten it and call again. Nothing was charged.`);
  if (moderationBlocks(prompt)) throw new JobError("This request goes against the content policy, so the video was not started. Nothing was charged.");
  const voice = normalizeVoice(input.voice);   // a Kokoro id from the storyboard guide is the same voice, not an error
  if (voice && !t.voices.includes(voice)) throw new JobError(`There is no voice called "${input.voice}". Available voices: ${voiceSpellings(t.voices).join(", ")}. Nothing was charged.`);
  const language = input.language ?? "en";
  // Two looks (14 September 2026): realistic or animation, filmed the same way. Any other name is refused in
  // words. When none is named, the treatment's own "look" decides (step 0 of the method), then the storyboard's
  // kleo_style, and failing both, realistic.
  if (input.style !== undefined && !(FILM_LOOKS as readonly string[]).includes(input.style))
    throw new JobError(`Kleo has two looks: "realistic" (a filmed, cinematic video) and "animation" (a 2D animated film). Omit "style" or pass one of them. Nothing was charged.`);
  const asLook = (x: unknown): FilmLook | null => ((FILM_LOOKS as readonly string[]).includes(String(x)) ? (x as FilmLook) : null);
  const field = (o: unknown, k: string): unknown => (o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>)[k] : undefined);
  const look: FilmLook = (input.style as FilmLook | undefined) ?? asLook(field(input.treatment, "look")) ?? asLook(field(input.storyboard, "kleo_style")) ?? "realistic";
  let style: KleoStyle | undefined = look;
  let cappedFrom: string | null = null; // set only when a guessed look was replaced by a cheaper one
  let storyboard: string | null = null;
  if (input.storyboard !== undefined && input.storyboard !== null) {
    const sbIn = input.storyboard;
    if (typeof sbIn === "object" && !Array.isArray(sbIn)) {
      const sb = sbIn as Record<string, unknown>;
      if ("kleo_style" in sb && sb.kleo_style !== look)
        throw new JobError(`The film's look is "${look}", but the storyboard's kleo_style says "${String(sb.kleo_style)}". Write the storyboard for the look you pass as style (realistic or animation), or omit kleo_style. Nothing was charged.`);
      sb.kleo_style = look;
    }
    // requireDirection only here: this is the assistant's storyboard, and the guide already told it to write the
    // direction first. The planner (src/storyboard.ts) validates its own drafts with the flag off, because it is
    // still building the direction when the first of those calls happens.
    const r = validateStoryboard(sbIn, { format, language, requireDirection: true });
    if (!r.ok) {
      const n = r.errors.length;
      throw new JobError(`The storyboard has ${plural(n, "problem")} (nothing was charged). Fix ${n === 1 ? "it" : "them"} and call kleo_create_video again:\n- ${r.errors.join("\n- ")}`);
    }
    const overpaid = overPaidFor(r.storyboard, duration);
    if (overpaid.length) throw new JobError(overpaid.join("\n"));
    style = kleoStyleOf(r.storyboard);
    // Whether the shots get FILMED is the plan's decision (the machine table), never the caller's: the validator
    // strips any backdrop the storyboard arrived with, and until 13 September nothing put it back on this path —
    // the planner's own drafts got it in normalizeStoryboard, a client's storyboard did not. A realistic job paid
    // seven credits, the worker saw no backdrop and drew the stills with the graphics on top: the old product at
    // the new price. Same rule as storyboard.ts:1036, on the other road into the queue.
    const filmed = filmedStoryboard(style, String((r.storyboard as Record<string, unknown>).style ?? ""), product);
    if (filmed) (r.storyboard as Record<string, unknown>).backdrop = "video";
    else delete (r.storyboard as Record<string, unknown>).backdrop;
    storyboard = JSON.stringify(finishForProduct(r.storyboard as Record<string, unknown>, product));
  }
  // The treatment the caller saw and approved. Refused in words when it is not one (a missing field, acts that do
  // not add up), before anything is charged; kept exactly, so the film the user read about is the film planned.
  let treatment: Record<string, unknown> | null = null;
  if (input.treatment !== undefined && input.treatment !== null) {
    const problems = treatmentProblems(input.treatment, duration, language, { look });
    if (problems.length)
      throw new JobError(`The treatment has ${plural(problems.length, "problem")} (nothing was charged). Fix ${problems.length === 1 ? "it" : "them"} and call kleo_create_video again, or leave the treatment out and Kleo writes one:\n- ${problems.join("\n- ")}`);
    const tIn = input.treatment as Record<string, unknown>;
    const fitted = repairTreatment(tIn, duration, variationFor(typeof tIn.variation === "string" ? tIn.variation : ""), language, { look });
    treatment = fitted as unknown as Record<string, unknown>;
    // With a client storyboard the planner never runs, so the treatment is attached to the storyboard here: it is
    // how the finished video can be read back to the film it was meant to be, on either road into the queue.
    if (storyboard) storyboard = JSON.stringify({ ...(JSON.parse(storyboard) as Record<string, unknown>), treatment });
  }
  // No guess and no cap any more: there is one look, and its price is its price.
  const styleGuessed = false;

  if (!input.storyboard && (await isFlagActive(env, "plan_pause")))
    throw new JobError("Kleo cannot write the storyboard itself right now: it has used up today's free planning. You can still make the video, and it costs the same: call kleo_storyboard_guide, write the storyboard yourself, then call kleo_create_video again with the storyboard argument. Nothing was charged.");
  // A filmed style needs the generator's weights on the box. When the configured model is gated on Hugging Face
  // and no token is configured, the download would fail after the card was rented and paid for — so the job is
  // refused here, in words that say what is missing, and nothing is charged.
  // On the kie.ai road (footage.ts) no weights are fetched, so the token is not needed: the same decision the
  // renter will make, taken here on the same params, so a job is never refused for a token it will not use.
  const onKie = footageBackendFor(env, { params: JSON.stringify({ duration_s: duration, format, language, voice, style }) }, await footageConfig(env)) === "kie";
  if (product === "film" && isVideoStyle(style) && !onKie && videoModelIsGated(env.KLEO_VIDEO_MODEL) && !(env.HF_TOKEN && env.HF_TOKEN.trim()))
    throw new JobError(`Kleo's video model (${env.KLEO_VIDEO_MODEL}) needs a Hugging Face token that is not configured on the server yet. Nothing was charged; try again later.`);
  const maxOpen = int(env.MAX_JOBS_PER_USER, 2);
  const open = await countOpenForUser(env, user.id);
  if (open >= maxOpen)
    throw new JobError(`You already have ${plural(open, "video")} in progress, and the limit is ${maxOpen} at a time. Wait for one to finish (kleo_get_job) or cancel one with kleo_cancel_job. Nothing was charged.`);
  // The limit above only counts videos running AT ONCE, so it lets one account queue as fast as jobs finish.
  const maxPerDay = int(env.MAX_JOBS_PER_DAY, 2);
  const today = await countJobsTodayForUser(env, user.id);
  if (today >= maxPerDay)
    throw new JobError(`You have already started ${plural(today, "video")} today, and the limit is ${maxPerDay} a day while Kleo is in beta. Come back tomorrow. Nothing was charged.`);

  // THE PRE-FLIGHT OF A FILM. kie.ai bills the clips to the owner's prepaid account; when that account cannot pay
  // this film the box would rent a card, draw the frames, voice the script and only then be refused (four films did
  // exactly that on 15 September, twenty minutes and four rentals to learn one number). So the balance is read HERE,
  // against the film's planned cost, and the refusal names the animatic. kie.ai's silence never refuses.
  if (product === "film" && onKie) {
    const shots = storyboard ? pictureScenes(JSON.parse(storyboard)).length : null;
    const pre = await kiePreflight(env, duration, shots, MAX_PICTURES(duration));
    if (!pre.ok) {
      await audit(env, user.id, null, "footage.preflight", { balance_usd: pre.balance_usd, planned_usd: pre.planned_usd, shots: pre.shots, model: pre.model, duration, owner_action: "top up kie.ai" });
      throw new JobError(`Kleo cannot film right now: the account it buys the clips from is empty (it holds $${(pre.balance_usd ?? 0).toFixed(2)} and this film needs about $${pre.planned_usd.toFixed(2)} of clips), and the owner has been alerted. Nothing was charged. Meanwhile the animatic of the same storyboard can be made — call again with product: "animatic" (${plural(ANIMATIC_CREDITS, "credit")}, up to ${ANIMATIC_MAX_S} seconds) — or ask for the film again later.`);
    }
  }
  const credits = creditsForProduct(duration, style, product); // the product first, then the length and the look
  const jobId = rid("gt", 8);
  // The debit is one conditional UPDATE: it either takes the credits for this job or does nothing.
  if (!(await debitCredits(env, user.id, credits, jobId)))
    throw new JobError(`Not enough credits: this ${kindOf(format)} costs ${plural(credits, "credit")} and you have ${plural(Math.max(0, user.credits), "credit")}. Nothing was charged. Your account and how to get more: ${await accountUrl(env, user.id)}`);

  const params: JobParams = { duration_s: duration, format, language, voice, style, ...(product === "animatic" ? { product } : {}), ...(styleGuessed ? { style_guessed: true } : {}), ...(cappedFrom ? { style_capped_from: cappedFrom } : {}), ...(treatment ? { treatment } : {}) };
  const job: Job = {
    id: jobId, user_id: user.id, template: t.id, prompt, params: JSON.stringify(params),
    state: "queued", track: null, percent: 0, eta_min: product === "animatic" ? animaticEtaFor(duration) : etaFor(duration), credits,
    backend: null, instance_id: null, instance_meta: null, worker_secret: rid("wk", 32), attempts: 0,
    error: null, notify_email: input.notify_email ?? null, created_at: nowIso(), started_at: null, finished_at: null,
    expires_at: null, purged_at: null, cost_usd: null,
    storyboard, plan_attempts: 0, plan_error: null,
  };
  try {
    await insertJob(env, job);
  } catch (e) {
    // The row never existed, so the credits go straight back: a user is never charged for a video that was not created.
    await refundCredits(env, user.id, credits, jobId, "job could not be saved");
    await audit(env, user.id, jobId, "job.create.error", String(e).slice(0, 500));
    throw new JobError("Kleo could not save the video request. Nothing was charged; please try again in a moment.");
  }
  await audit(env, user.id, job.id, "job.created", { template: t.id, product, credits, duration, format, style, storyboard: storyboard ? "client" : "auto", treatment: treatment ? "client" : "auto" });
  return job;
}

/** The message for a job that cannot be cancelled because it is already over. */
export function notCancellable(job: Job): JobError {
  const what = kindOf((JSON.parse(job.params) as JobParams).format);
  if (job.state === "done") return new JobError(`${capital(what)} ${job.id} is already finished, so there is nothing to cancel. Call kleo_get_result for the download links.`);
  if (job.state === "cancelled") return new JobError(`${capital(what)} ${job.id} was already cancelled.`);
  return new JobError(`${capital(what)} ${job.id} had already failed and its credits were given back; there is nothing to cancel.`);
}

/**
 * Cancels a queued or running job and refunds refundFor(). The cancel is one atomic transition, so a job that
 * finishes or fails in the same instant is refunded by exactly one of the two paths, never both.
 */
export async function cancelJob(env: Env, user: User, jobId: string): Promise<{ job: Job; refunded: number }> {
  const job = await getUserJob(env, user.id, jobId);
  if (!job) throw new JobError(`There is no video number "${jobId}" on this account. Check the number, or call kleo_get_job without a number to see your recent videos.`);
  if (!OPEN_STATES.includes(job.state)) throw notCancellable(job);
  const refund = refundFor(job.credits, job.state, job.percent);
  const moved = await transitionJob(env, job.id, OPEN_STATES, { state: "cancelled", finished_at: nowIso(), error: "cancelled by user" });
  if (!moved) throw notCancellable((await getUserJob(env, user.id, jobId)) ?? job);
  // Whatever GPU the job holds is released now; the orchestrator never rents one for a cancelled job (see tick()).
  if (job.instance_id) {
    try {
      // A cancel is a rental that ENDED: those minutes are already on the Vast bill, and this job will never reach
      // "done" to write a cost of its own, so without this line the daily ceiling never sees cancelled renders at all.
      const est = await backendFor(env, job.backend).destroy(env, job);
      if (typeof est === "number" && est > 0) await addJobCost(env, job.id, est);
    } catch (e) { await audit(env, user.id, job.id, "backend.destroy.error", String(e)); }
  }
  const refunded = await refundCredits(env, user.id, refund, job.id, `cancelled at ${job.percent}% (${job.state})`);
  await audit(env, user.id, job.id, "job.cancelled", { refunded, percent: job.percent, state_before: job.state });
  return { job: { ...job, state: "cancelled" }, refunded };
}

export const FILE_NAMES: Record<string, { name: string; type: string }> = {
  video: { name: "video.mp4", type: "video/mp4" },
  subtitles: { name: "subtitles.srt", type: "application/x-subrip" },
  thumbnail: { name: "thumbnail.jpg", type: "image/jpeg" },
};

export async function signedDownloadUrl(env: Env, base: string, job: Job, fileName: string): Promise<string> {
  const exp = Math.floor(new Date(job.expires_at ?? nowIso()).getTime() / 1000);
  const sig = await hmacHex(env.INTERNAL_SECRET, `${job.id}/${fileName}/${exp}`);
  return `${base}/dl/${job.id}/${encodeURIComponent(fileName)}?exp=${exp}&sig=${sig}`;
}

/** Scene pictures (img/<sceneId>.png|jpg) are worker inputs, not deliverables: they never appear in the user's links. */
export const isSceneImage = (name: string): boolean => name.startsWith("img/");

export async function resultLinks(env: Env, base: string, job: Job): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await listFiles(env, job.id)) {
    if (f.name === "log.txt" || f.name === "gen.tgz") continue; // the worker log and the GPU phase's bundle: not for users
    if (isSceneImage(f.name)) continue;
    const key = f.name.replace(/\.[a-z0-9]+$/i, "") + "_url";
    out[key] = await signedDownloadUrl(env, base, job, f.name);
  }
  return out;
}

export function jobView(job: Job) {
  const p = JSON.parse(job.params) as JobParams;
  return {
    job_id: job.id,
    state: job.state,
    template: job.template,
    format: p.format,
    duration_s: p.duration_s,
    style: p.style ?? null,
    track: job.track,
    percent: job.percent,
    eta_min: job.state === "done" || job.state === "failed" || job.state === "cancelled" ? 0 : job.eta_min,
    credits: job.credits,
    created_at: job.created_at,
    finished_at: job.finished_at,
    expires_at: job.expires_at,
    error: job.error,
  };
}
