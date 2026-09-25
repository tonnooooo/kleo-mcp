import type { Env } from "./env";
import { type Job, type JobParams, type JobState, type User, OPEN_STATES, countOpenForUser, countJobsTodayForUser, addJobCost, debitCredits, refundCredits, insertJob, transitionJob, audit, getUserJob, listFiles, hasPaid, recentJobsForUser } from "./db";
import { accountUrl } from "./accounts";
import { findTemplate, affordableGuess, creditsFor, creditsForProduct, etaFor, animaticEtaFor, normalizeVoice, voiceSpellings, isVideoStyle, videoModelIsGated, isPublicTemplate, FILM_TEMPLATE_ID, FILM_LONG_TEMPLATE_ID, filmTemplateFor, ACTIVE_TEMPLATE, PRODUCTS, ANIMATIC_CREDITS, ANIMATIC_MAX_S, filmedStoryboard, finishForProduct, productOf, type Format, type Product } from "./templates";
import { footageBackendFor, footageConfig, kiePreflight, clipFloorFor } from "./footage";
import { rid, nowIso, int, hmacHex } from "./util";
import { isFlagActive } from "./schema";
import { backendFor } from "./backends";
import { validateStoryboard, kleoStyleOf, pictureScenes, narrationOf, MAX_PICTURES, wordBudget, speedFor, trimShots, KLEO_STYLES, FILM_LOOKS, type KleoStyle, type FilmLook } from "./keou-contract";
import { treatmentProblems, repairTreatment, variationFor, faithfulVariation, applySoundOptions, musicOf, type Treatment, type SoundOptions } from "./treatment.ts";
import { denyInPictures } from "./storyboard";
import { musicAnswer, subtitlesAnswer, lookFromText } from "./adaptive.ts";
import { repairGraphics } from "./graphics.ts";
import { specProblems, repairSpec, coverage, specModeWhy, MODE_RULE, type RequestSpec } from "./spec.ts";
import { resolveRefs, refsOf, RefError, REF_HANDLE_RE } from "./refs.ts";

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
  /**
   * THE TWO OPTIONS THE USER IS ALWAYS ASKED (22 September 2026). `music`: what they answered — "no" in any spelling
   * means none; "yes" or a kind (a mood, a genre) means an instrumental track under the narration, the treatment's
   * own brief first, their words otherwise. `subtitles`: true for burned-in cinema subtitles, false for none.
   * Either left out means the question was not asked on this road, and the treatment stands as written.
   */
  music?: string | null;
  subtitles?: boolean | string | null;
  /**
   * THE SPEC (24 September 2026, src/spec.ts): the request taken apart into checkable requirements, written by the
   * assistant under kleo_adapt_prompt's method. Refused in words when it is not one (a quote the user never wrote, a
   * look with no character, a reference Kleo does not hold); stored repaired in params.spec, and the planner plans
   * under it. Absent: the planner writes one.
   */
  spec?: unknown;
  /** The user's reference pictures: handles (kref_…) or the token of an upload link (src/refs.ts). */
  references?: string[];
  /** The intake's optional answers, kept for the planner (they used to stop at kleo_adapt_prompt). */
  must_keep?: string | null;
  audience?: string | null;
  tone?: string | null;
  /**
   * The user's corrections after the read-back of the spec (24 September 2026), in their own words ("add my dog Pepe
   * with a red collar"). The prompt stays the user's first request, unchanged; a spec item added by a correction quotes
   * this, and it is kept with the answers for the planner.
   */
  corrections?: string | null;
}

/**
 * The references a job carries, resolved to the handles this account holds: a kref handle is looked up, anything
 * else is read as an upload-link token and expanded to what was uploaded through it. Every refusal is a JobError that
 * says nothing was charged. With no references it touches nothing (no R2 needed).
 */
async function jobRefs(env: Env, userId: string, refs: readonly string[] | undefined, specHandles: readonly string[]): Promise<string[]> {
  const inputs = (refs ?? []).map((r) => String(r).trim()).filter(Boolean).map((r) => (REF_HANDLE_RE.test(r) ? { handle: r } : { upload: r }));
  try {
    const resolved = inputs.length ? (await resolveRefs(env, userId, inputs)).map((r) => r.handle) : [];
    // A handle the spec names but the call forgot to list is still the user's picture when this account holds it.
    const extra = specHandles.filter((h) => REF_HANDLE_RE.test(h) && !resolved.includes(h));
    const held = extra.length ? (await refsOf(env, userId, extra, { skipMissing: true })).map((r) => r.handle) : [];
    return [...resolved, ...held];
  } catch (e) {
    if (e instanceof RefError) throw new JobError(e.message);
    throw e;
  }
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
  // One template, two products (13 and 15 September 2026): the film, and the animatic of the same storyboard. The old
  // templates stay readable for the rows made with them and for the planner's families, but a new video is not made with them.
  if (!isPublicTemplate(t.id)) throw new JobError(`Kleo has one template, "${FILM_TEMPLATE_ID}" (realistic or animated, 16:9 or 9:16, 15 to 300 seconds; "${FILM_LONG_TEMPLATE_ID}" is the same over 90), in two products: the film and, with product: "animatic", the animatic (${plural(ANIMATIC_CREDITS, "credit")}, up to ${ANIMATIC_MAX_S} seconds). Omit the template and say the length. Nothing was charged.`);
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
  const paid = await hasPaid(env, user.id);
  // Every way out named below is one THIS account can take: an animatic is offered with its length cap when the film
  // asked is longer than it, and "order the film" only to an account the film is open to.
  const animaticWayOut = `call again with product: "animatic"${duration > ANIMATIC_MAX_S ? ` and a length of at most ${ANIMATIC_MAX_S} seconds` : ""} (${plural(ANIMATIC_CREDITS, "credit")} flat)`;
  if (product === "animatic" && duration > ANIMATIC_MAX_S)
    throw new JobError(`An animatic is at most ${ANIMATIC_MAX_S} seconds long (${duration} asked): it is the preview of a film, not the film. Ask for ${ANIMATIC_MAX_S} seconds or less${paid ? ", or order the film itself" : `, or buy any pack (from 5 EUR) on the account page and order the film: ${await accountUrl(env, user.id)}`}. Nothing was charged.`);
  if (product === "film" && !paid)
    throw new JobError(`A film is made only for accounts that have bought a credit pack: its shots are generated clips that Kleo pays for per second, and the credits on this account were not paid for (a gift, a bonus or a test balance). Two ways on: ${animaticWayOut} — the same storyboard as drawn frames with the camera moving over them, narrated, 4K 60 fps, up to ${ANIMATIC_MAX_S} seconds — or buy any pack (from 5 EUR) on the account page and the film opens: ${await accountUrl(env, user.id)}. Nothing was charged.`);
  const prompt = input.prompt.trim();
  if (prompt.length < 8) throw new JobError("The description is too short (at least 8 characters). Say what the video is about: topic, angle, tone, anything that must appear on screen. Nothing was charged.");
  if (prompt.length > 4000) throw new JobError(`The description is too long (${prompt.length} characters, the maximum is 4000). Shorten it and call again. Nothing was charged.`);
  if (moderationBlocks(prompt)) throw new JobError("This request goes against the content policy, so the video was not started. Nothing was charged.");
  const voice = normalizeVoice(input.voice);   // a Kokoro id from the storyboard guide is the same voice, not an error
  if (voice && !t.voices.includes(voice)) throw new JobError(`There is no voice called "${input.voice}". Available voices: ${voiceSpellings(t.voices).join(", ")}. Nothing was charged.`);
  const language = input.language ?? "en";
  const field = (o: unknown, k: string): unknown => (o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>)[k] : undefined);
  // THE INTAKE'S OPTIONAL ANSWERS, THE PICTURES AND THE SPEC (24 September 2026). The answers are part of what the
  // user said, so a spec item may quote them as well as the prompt; the pictures are resolved to the handles this
  // account holds; the spec is checked in words — an item whose quote the user never wrote is an invention — and
  // stored repaired, so the planner and every check after it read the same requirements the user approved.
  const said = (v: string | null | undefined, max = 400) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : null);
  const answers = { must_keep: said(input.must_keep), audience: said(input.audience), tone: said(input.tone) };
  // THE USER'S CORRECTIONS (24 September 2026). kleo_adapt_prompt tells the assistant to read the spec back and wait
  // for "their yes or their corrections", then to pass the prompt unchanged — so a correction that ADDED something
  // ("add my dog Pepe with a red collar") became an item whose quote was nowhere in what Kleo had, and the job was
  // refused. The corrections now travel in their own argument, in the user's words, and count as what the user said.
  // They are the user's words like the prompt, so the same safety gate reads them.
  const corrections = said(input.corrections, 1000);
  if (corrections && moderationBlocks(corrections)) throw new JobError("This request goes against the content policy, so the video was not started. Nothing was charged.");
  const requestText = [prompt, answers.must_keep, answers.audience, answers.tone, corrections].filter(Boolean).join("\n");
  const specRefs = field(input.spec, "refs");
  const specHandles = Array.isArray(specRefs) ? specRefs.map((r) => String(field(r, "handle") ?? "")).filter(Boolean) : [];
  let refHandles = await jobRefs(env, user.id, input.references, specHandles);
  let spec: RequestSpec | null = null;
  if (input.spec !== undefined && input.spec !== null) {
    const problems = specProblems(input.spec, requestText, { handles: refHandles });
    if (problems.length)
      throw new JobError(`The spec has ${plural(problems.length, "problem")} (nothing was charged). Fix ${problems.length === 1 ? "it" : "them"} and call kleo_create_video again, or leave the spec out and Kleo writes one:\n- ${problems.join("\n- ")}`);
    spec = repairSpec(input.spec, requestText, { handles: refHandles });
    if (!spec) throw new JobError("The spec lists nothing the user asked for: every item must quote the user's own words from the prompt, their answers or their corrections. Write it again under kleo_adapt_prompt's method, or leave it out and Kleo writes one. Nothing was charged.");
  }
  // FAITHFUL, OPEN, OR NOT KNOWN (24 September 2026). With no spec this is undefined, not false: a treatment sent
  // without a spec — a client that writes only the treatment, or an assistant that followed the spec refusal's own
  // advice to "leave the spec out" and kept its faithful, as-told treatment — was refused a second time for the device
  // kleo_adapt_prompt had told it to use. Only a spec that says OPEN refuses "as-told"; without one the treatment's own
  // device says which it is (src/treatment.ts treatmentProblems reads undefined that way).
  const faithful: boolean | undefined = spec ? spec.mode === "faithful" : undefined;
  // Two looks (14 September 2026): realistic or animation, filmed the same way. Any other name is refused in
  // words. When none is named, the treatment's own "look" decides (step 0 of the method), then the storyboard's
  // kleo_style, then — since 24 September — the request's own words ("un cartone animato…" sent straight here used to
  // become a live-action film), and failing all of them, realistic. The request's words count only when they name the
  // look without ambiguity (src/adaptive.ts lookFrom): "a realistic documentary about Pixar" and "a horse-drawn
  // carriage" named animation for a day, and a request that names both looks is realistic here, as it always was.
  if (input.style !== undefined && !(FILM_LOOKS as readonly string[]).includes(input.style))
    throw new JobError(`Kleo has two looks: "realistic" (a filmed, cinematic video) and "animation" (a 2D animated film). Omit "style" or pass one of them. Nothing was charged.`);
  const asLook = (x: unknown): FilmLook | null => ((FILM_LOOKS as readonly string[]).includes(String(x)) ? (x as FilmLook) : null);
  const look: FilmLook = (input.style as FilmLook | undefined) ?? asLook(field(input.treatment, "look")) ?? asLook(field(input.storyboard, "kleo_style")) ?? lookFromText(prompt) ?? "realistic";
  let style: KleoStyle | undefined = look;
  let cappedFrom: string | null = null; // set only when a guessed look was replaced by a cheaper one
  // THE ROAD, BEFORE THE STORYBOARD (25 September 2026): on the API road every shot is a clip billed at the model's
  // shortest length, so a client storyboard is trimmed and judged with that floor (clip_floor_s), the same one the
  // planner writes to. The road depends on the length alone (footageBackendFor), so it is known this early.
  const footageCfg = await footageConfig(env);
  const onKie = footageBackendFor(env, { params: JSON.stringify({ duration_s: duration, format, language, voice, style: look }) }, footageCfg) === "kie";
  const clipFloor = clipFloorFor(env, { product, duration_s: duration }, footageCfg);
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
    const r = validateStoryboard(sbIn, { format, language, requireDirection: true, clipFloorS: clipFloor });
    if (!r.ok) {
      const n = r.errors.length;
      throw new JobError(`The storyboard has ${plural(n, "problem")} (nothing was charged). Fix ${n === 1 ? "it" : "them"} and call kleo_create_video again:\n- ${r.errors.join("\n- ")}`);
    }
    // A picture described in the narration's language is a warning for the planner (it translates) and a refusal
    // here: the assistant that wrote this storyboard can rewrite the prompts, and the pictures would be drawn wrong.
    // A promise the storyboard breaks to itself — a must_keep fact the narration never says — is a warning for the
    // planner (it reports what is left) and a refusal here: this author wrote both halves and can fix one.
    const broken = r.warnings.filter((w) => /must_keep says/.test(w));
    if (broken.length)
      throw new JobError(`The storyboard has ${plural(broken.length, "problem")} (nothing was charged): it contradicts its own direction. Fix ${broken.length === 1 ? "it" : "them"} and call kleo_create_video again:\n- ${broken.join("\n- ")}`);
    const english = r.warnings.filter((w) => /must be in English/.test(w));
    if (english.length)
      throw new JobError(`The storyboard has ${plural(english.length, "problem")} (nothing was charged): the picture model reads English only, so every image_prompt and the direction's world, cast names and looks, objects and forbidden terms are written in English — only the narration (voice, title, chapter) stays in ${language}. Fix ${english.length === 1 ? "it" : "them"} and call kleo_create_video again:\n- ${english.join("\n- ")}`);
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
    const finished = finishForProduct(r.storyboard as Record<string, unknown>, product, duration);
    // No more shots than a line's seconds can carry (keou-contract.ts shotBudget, with the job's clip floor) — and never
    // the only shot that shows something the spec asks for.
    trimShots(finished, spec, clipFloor);
    // THE SPEC AGAINST THE STORYBOARD, deterministic (src/spec.ts coverage): every must item claimed by a shot's
    // "covers", every line said, the user's events in the user's order, no unknown item or character. A warning in
    // the planner (it repairs); a refusal here, like the must_keep promise above: this author wrote both and can fix
    // either before anything is charged.
    if (spec) {
      const cov = coverage(spec, finished);
      if (cov.problems.length)
        throw new JobError(`The storyboard does not show everything the spec asks for: ${plural(cov.problems.length, "problem")} (nothing was charged). Fix ${cov.problems.length === 1 ? "it" : "them"} — each shot lists the spec items it shows in "covers" and the characters in it in "cast" — and call kleo_create_video again:\n- ${cov.problems.join("\n- ")}`);
    }
    // The voice's speed follows the words the storyboard carries (keou-contract.ts speedFor), on this road too.
    finished.speed = speedFor(narrationOf(finished).trim().split(/\s+/).filter(Boolean).length, duration);
    storyboard = JSON.stringify(finished);
    // (the treatment's denials join its forbidden list below, once the treatment itself is known)
  }
  // THE USER'S TWO ANSWERS (22 September 2026), read once here and applied to everything below: the treatment (its
  // music brief and its layer's subtitles), a client storyboard (its music and its graphics) and the job's params, so
  // the planner and the worker read the same answer the user gave in the chat.
  // An explicit null is the tool's own spelling of "no music" (the schema says so); undefined means not asked.
  const musicIn = input.music === null ? { wanted: false, brief: null } : musicAnswer(input.music);
  const subsIn = subtitlesAnswer(input.subtitles);
  const sound: SoundOptions = { music: musicIn, subtitles: subsIn };
  // The treatment the caller saw and approved. Refused in words when it is not one (a missing field, acts that do
  // not add up), before anything is charged; kept exactly, so the film the user read about is the film planned.
  let treatment: Record<string, unknown> | null = null;
  if (input.treatment !== undefined && input.treatment !== null) {
    // FAITHFUL (the user described their film): no drawn device, and the angle is the point of the user's own story,
    // so the rule that an angle must not merely restate the request does not apply (src/treatment.ts).
    const problems = treatmentProblems(input.treatment, duration, language, { look, faithful });
    // THE MODE WAS RE-DECIDED (25 September 2026): the writer called its spec FAITHFUL, Kleo's rule made it OPEN, and the
    // as-told treatment written for the claim is refused. The refusal says why, and which draw to write under instead,
    // so the assistant fixes it in one round trip rather than guessing.
    const claimed = field(input.spec, "mode");
    const redecided = spec && claimed !== spec.mode && problems.some((p) => p.startsWith('device: "as-told"'))
      ? (() => { const d = variationFor(prompt); return `\nKleo re-decided the spec ${spec.mode.toUpperCase()} (${specModeWhy(spec, requestText).why}), by its rule: ${MODE_RULE}. Write the treatment under a drawn device instead — "variation": "${d.key}" (device "${d.device}", opening "${d.opening}") — or, if the user did tell their own story, put it in the spec.`; })()
      : "";
    if (problems.length)
      throw new JobError(`The treatment has ${plural(problems.length, "problem")} (nothing was charged). Fix ${problems.length === 1 ? "it" : "them"} and call kleo_create_video again, or leave the treatment out and Kleo writes one:\n- ${problems.join("\n- ")}${redecided}`);
    const tIn = input.treatment as Record<string, unknown>;
    // No spec: the treatment says which it is, the same reading as the readback (treatment.ts treatmentOf).
    const asTold = faithful ?? (tIn.device === "as-told" || String(tIn.variation ?? "").startsWith("as-told"));
    const fitted = repairTreatment(tIn, duration, asTold ? faithfulVariation() : variationFor(typeof tIn.variation === "string" ? tIn.variation : ""), language, { look, faithful: asTold });
    treatment = (fitted ? applySoundOptions(fitted, sound) : fitted) as unknown as Record<string, unknown>;
    // With a client storyboard the planner never runs, so the treatment is attached to the storyboard here: it is
    // how the finished video can be read back to the film it was meant to be, on either road into the queue.
    if (storyboard) { const withT = { ...(JSON.parse(storyboard) as Record<string, unknown>), treatment }; denyInPictures(withT, treatment as unknown as Treatment); storyboard = JSON.stringify(withT); }
  }
  // The same two answers on a client storyboard, which the planner never touches: its music and its subtitles are
  // the user's, whatever the assistant wrote at the top of it.
  if (storyboard) {
    const sb = JSON.parse(storyboard) as Record<string, unknown>;
    const brief = musicIn ? (musicIn.wanted ? (musicOf((treatment as Treatment | null)?.music) ?? musicIn.brief ?? "a quiet instrumental bed that fits the film's mood, under the narration") : null) : undefined;
    if (brief !== undefined) { if (brief) { sb.music = "track"; sb.music_brief = brief; } else { sb.music = "none"; delete sb.music_brief; } }
    if (subsIn === true) sb.graphics = repairGraphics({ accent: "#ffffff", chapters: "none", hud: [], ...((sb.graphics as Record<string, unknown> | undefined) ?? {}), subtitles: "cinema" });
    else if (subsIn === false && sb.graphics) { const g = repairGraphics({ ...(sb.graphics as Record<string, unknown>), subtitles: "none" }); if (g) sb.graphics = g; else if (product === "animatic") sb.graphics = { accent: "#ffffff", subtitles: "none", chapters: "none", hud: [] }; else delete sb.graphics; }
    storyboard = JSON.stringify(sb);
  }
  // A RETRY KEEPS ITS TREATMENT. The assistant that wrote a treatment through kleo_adapt_prompt does not always hand
  // it in again when it retries a video that failed: on 19 September 2026 the third attempt at one animatic arrived
  // with no treatment, the planner wrote its own, flat one, and the user got a film she had never read the logline
  // of. When the same account asks for the same words again within three hours, in the same length, language and
  // look, the treatment of that earlier job is planned under — unless the caller brought one, or a storyboard.
  let treatmentFrom: string | null = null;
  if (!treatment && !storyboard) {
    const since = Date.now() - 3 * 3600_000;
    for (const prev of await recentJobsForUser(env, user.id, 8)) {
      if (Date.parse(prev.created_at) < since || prev.prompt.trim() !== prompt) continue;
      let pp: JobParams; try { pp = JSON.parse(prev.params) as JobParams; } catch { continue; }
      if (!pp.treatment || pp.duration_s !== duration || pp.language !== language || pp.style !== look) continue;
      treatment = pp.treatment; treatmentFrom = prev.id;
      // The spec and the pictures of that attempt travel with its treatment: the retry is the same film.
      if (!spec && pp.spec) spec = pp.spec;
      if (!refHandles.length && pp.refs?.length) refHandles = pp.refs;
      break;
    }
  }
  // No guess and no cap any more: the look is named or read off the treatment/storyboard, and its price is its price
  // (the product decides the flat animatic price, creditsForProduct).
  const styleGuessed = false;

  if (!input.storyboard && (await isFlagActive(env, "plan_pause")))
    throw new JobError("Kleo cannot write the storyboard itself right now: it has used up today's free planning. You can still make the video, and it costs the same: call kleo_storyboard_guide, write the storyboard yourself, then call kleo_create_video again with the storyboard argument. Nothing was charged.");
  // A filmed style needs the generator's weights on the box. When the configured model is gated on Hugging Face
  // and no token is configured, the download would fail after the card was rented and paid for — so the job is
  // refused here, in words that say what is missing, and nothing is charged.
  // On the kie.ai road (footage.ts) no weights are fetched, so the token is not needed: the same decision the
  // renter will make, taken here on the same params, so a job is never refused for a token it will not use.
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
      await audit(env, user.id, null, "footage.preflight", { balance_usd: pre.balance_usd, planned_usd: pre.planned_usd, stills_usd: pre.stills_usd ?? 0, spent_today_usd: pre.spent_today_usd, budget_usd: pre.budget_usd, shots: pre.shots, model: pre.model, duration, owner_action: pre.reason === "budget" ? "raise DAILY_FOOTAGE_BUDGET_USD or wait for tomorrow" : "top up kie.ai" });
      const why = pre.reason === "budget"
        ? `today's filming budget is used up ($${pre.spent_today_usd.toFixed(2)} of $${pre.budget_usd.toFixed(2)} committed, and this film needs about $${pre.planned_usd.toFixed(2)} of clips)`
        : `the account it buys the clips from is empty (it holds $${(pre.balance_usd ?? 0).toFixed(2)} and this film needs about $${(pre.planned_usd + (pre.stills_usd ?? 0)).toFixed(2)} of ${pre.stills_usd ? "clips and pictures" : "clips"})`;
      throw new JobError(`Kleo cannot film right now: ${why}. The request has been logged for the operator. Nothing was charged. Meanwhile the animatic of the same storyboard can be made — ${animaticWayOut}, the drawn frames with the camera moving over them — or ask for the film again later.`);
    }
  }
  const credits = creditsForProduct(duration, style, product); // the product first, then the length and the look
  const jobId = rid("gt", 8);
  // The debit is one conditional UPDATE: it either takes the credits for this job or does nothing.
  if (!(await debitCredits(env, user.id, credits, jobId)))
    throw new JobError(`Not enough credits: this ${product === "animatic" ? "animatic" : kindOf(format)} costs ${plural(credits, "credit")} and you have ${plural(Math.max(0, user.credits), "credit")}. Nothing was charged.${product === "film" && user.credits >= ANIMATIC_CREDITS ? ` The animatic of the same storyboard costs ${plural(ANIMATIC_CREDITS, "credit")}: ${animaticWayOut}.` : ""} Your account and how to get more: ${await accountUrl(env, user.id)}`);

  // The two answers travel on the row: the planner reads them when it writes its own treatment, the worker reads the
  // storyboard they shaped. A "yes" to music with no brief yet gets the treatment's brief, or the user's own words.
  // The corrections ride with the answers (params.brief.corrections) so the planner's own spec writer can quote them
  // when the caller brought no spec (src/spec.ts specPrompt takes them).
  const brief: NonNullable<JobParams["brief"]> & { corrections?: string } = { ...answers, ...(corrections ? { corrections } : {}) };
  const musicParam = musicIn === null ? undefined : musicIn.wanted ? (musicOf((treatment as Treatment | null)?.music) ?? musicIn.brief ?? "a quiet instrumental bed that fits the film's mood, under the narration") : null;
  const params: JobParams = { duration_s: duration, format, language, voice, style, ...(product === "animatic" ? { product } : {}), ...(styleGuessed ? { style_guessed: true } : {}), ...(cappedFrom ? { style_capped_from: cappedFrom } : {}), ...(treatment ? { treatment } : {}), ...(musicParam !== undefined ? { music: musicParam } : {}), ...(subsIn !== null ? { subtitles: subsIn } : {}),
    ...(spec ? { spec } : {}), ...(refHandles.length ? { refs: refHandles } : {}), ...(answers.must_keep || answers.audience || answers.tone || corrections ? { brief } : {}),
    ...(clipFloor > 0 ? { clip_floor_s: clipFloor } : {}) };
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
  // language_defaulted (25 September 2026): the caller named no narration language and English was assumed; the intake
  // asks it, so these rows count the callers that went round it.
  await audit(env, user.id, job.id, "job.created", { template: t.id, product, credits, duration, format, style, storyboard: storyboard ? "client" : "auto", treatment: treatment ? (treatmentFrom ? "reused" : "client") : "auto", ...(treatmentFrom ? { treatment_from: treatmentFrom } : {}), spec: spec ? spec.mode : null, refs: refHandles.length, ...(input.language === undefined ? { language_defaulted: true } : {}) });
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
    if (f.name === "fidelity.json") continue; // read and summarised in words by kleo_get_result, not handed over as a file
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
    product: productOf(p), // "film" or "animatic" (15 September): the finished video is called by what it is
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
