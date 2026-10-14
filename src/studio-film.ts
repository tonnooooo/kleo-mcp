/**
 * KLEO FILMS FROM KLEO STUDIO (14 October 2026). The owner: the chat on kleooai.com and Kleo must be ONE thing — the
 * MCP server stays, but the chat comes first. So the Studio agent can order the same film the MCP tool
 * kleo_create_video orders (treatment, storyboard, narration, Seedance footage, 4K 60 fps), through this Worker, with
 * the same prices, the same two-products rule (a film for accounts that paid, the animatic for everyone) and the same
 * open-jobs limit. Studio calls it over a service binding (wrangler.studio.jsonc "MCP"), never from the internet:
 *
 *   POST /internal/studio/film/quote  {userId, duration_s, style?, product?}           → prices and what is allowed
 *   POST /internal/studio/film        {userId, prompt, duration_s, format, style, product, music, subtitles, language}
 *                                                                                       → the job (jobView) or a refusal
 * Both: Authorization: Bearer <INTERNAL_SECRET>. Studio reads the job's progress and files straight from the shared
 * D1 database and R2 bucket afterwards.
 *
 * ONLY OVER THE BINDING (14 October 2026, the security review). The route used to answer anybody on the internet who
 * held the secret, at https://mcp.kleooai.com/internal/studio/... — and a request there can debit any account by its
 * id. Studio's binding always calls https://kleo-mcp/... (src/studio/films.ts), a host name no public DNS name can
 * carry to this Worker, so any other host answers a plain 404, BEFORE the secret is looked at: the public door gives
 * no hint that a route lives here, and a leaked secret no longer orders films through THIS route. It is one door, not
 * the whole risk: INTERNAL_SECRET still signs every Kleo key (src/accounts.ts makeHandle) and every Studio session
 * (src/studio/session.ts) and opens /internal/admin/*, so whoever holds it can still act as any account by other
 * roads. It stays the one secret to guard; splitting it (a binding secret, separate signing keys) is its own change.
 */
import type { Env } from "./env";
import { getUser, hasPaid, countOpenForUser } from "./db";
import { json, safeEqual, int } from "./util";
import { createJob, jobView, JobError } from "./jobs";
import { ACTIVE_TEMPLATE, ANIMATIC_MAX_S, animaticCredits, creditsForProduct } from "./templates";

/** The host name Studio's service binding calls this Worker by (src/studio/films.ts mcp()). */
export const STUDIO_BINDING_HOST = "kleo-mcp";

export async function handleStudioFilm(request: Request, env: Env): Promise<Response> {
  if (new URL(request.url).hostname !== STUDIO_BINDING_HOST) return json({ error: "not found" }, 404);
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.INTERNAL_SECRET || !token || !safeEqual(token, env.INTERNAL_SECRET)) return json({ error: "unauthorized" }, 401);
  if (request.method !== "POST") return json({ error: "method" }, 405);
  const path = new URL(request.url).pathname;
  let b: Record<string, unknown>;
  try { b = (await request.json()) as Record<string, unknown>; } catch { return json({ error: "Bad request." }, 400); }
  const user = await getUser(env, String(b.userId ?? ""));
  if (!user) return json({ error: "Please sign in again." }, 401);
  const t = ACTIVE_TEMPLATE;
  const duration = Math.round(Number(b.duration_s ?? t.defaultSeconds));
  // A length that is not a number ("abc", NaN, Infinity) is refused here, before any price or range check (14 October
  // 2026, the security review): NaN compares false with everything, so it slipped past `< min` and `> max` alike and
  // reached the price as NaN credits.
  if (!Number.isFinite(duration)) return json({ error: "The length must be a number of seconds. Nothing was charged.", code: "refused" }, 400);
  const product = b.product === "animatic" ? "animatic" : "film";
  const style = b.style === "animation" ? "animation" : "realistic";
  const paid = await hasPaid(env, user.id);

  if (path === "/internal/studio/film/quote") {
    const filmOk = duration >= t.minSeconds && duration <= t.maxSeconds;
    const aniLen = Math.min(Math.max(duration, t.minSeconds), ANIMATIC_MAX_S);
    return json({
      film: { credits: creditsForProduct(duration, style, "film"), allowed: paid && filmOk, min_s: t.minSeconds, max_s: t.maxSeconds },
      animatic: { credits: animaticCredits(aniLen), allowed: true, max_s: ANIMATIC_MAX_S },
      has_paid: paid, credits: user.credits,
      credits_for_choice: product === "animatic" ? animaticCredits(Math.min(duration, ANIMATIC_MAX_S)) : creditsForProduct(duration, style, "film"),
    });
  }

  if (path === "/internal/studio/film") {
    const prompt = String(b.prompt ?? "").trim();
    if (prompt.length < 8) return json({ error: "Tell Kleo what the film is about (a sentence or two)." }, 400);
    const cost = creditsForProduct(duration, style, product);
    if (user.credits < cost) return json({ error: `This ${product} costs ${cost} credits and you have ${user.credits}. Nothing was charged.`, code: "credits" }, 402);
    const open = await countOpenForUser(env, user.id);
    const maxOpen = int(env.MAX_JOBS_PER_USER, 2);
    if (open >= maxOpen) return json({ error: `You already have ${open} films in progress (the limit is ${maxOpen}). Wait for one to finish.`, code: "busy" }, 429);
    try {
      const job = await createJob(env, user, {
        template: t.id, prompt, duration_s: duration,
        format: b.format === "9:16" ? "9:16" : "16:9",
        language: b.language === "it" ? "it" : "en",
        style, product,
        music: typeof b.music === "string" ? b.music.slice(0, 200) : b.music === true ? "yes" : "no",
        subtitles: b.subtitles === true || b.subtitles === "yes",
      } as Parameters<typeof createJob>[2]);
      const fresh = await getUser(env, user.id);
      return json({ job: jobView(job), credits_left: fresh?.credits ?? 0 });
    } catch (e) {
      if (e instanceof JobError) {
        const msg = e.message;
        const locked = /paid|credit pack|bought/i.test(msg) && product === "film";
        return json({ error: msg, code: locked ? "locked" : "refused" }, locked ? 402 : 400);
      }
      throw e;
    }
  }
  return json({ error: "not found" }, 404);
}
