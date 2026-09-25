/**
 * THE ePhone AI CLIENT (25 September 2026). The owner found ePhone AI (platform.ephone.ai, PULSE AI SINGAPORE PTE.
 * LTD., a RixAPI deployment) and decided to film through it: Seedance 2.5 there costs about 0.0875 $/s at 480p and
 * 0.194 at 720p, against kie.ai's 0.14 and 0.315. Its video models sit behind one unified async API — the same shape
 * kie.ai's jobs API has, so the footage road (src/footage.ts) only chooses which client to call:
 *
 *   POST /v1/task/submit  {model, input}   →  {id, status: "queued"}
 *   GET  /v1/task/{id}                     →  {id, status: queued|in_progress|completed|failed, outputs[], error, usage}
 *
 * (docs.rixapi.com/docs/en/guides/task.md, read 25 September 2026; the Seedance 2.5 `input` fields from the model's
 * API tab on platform.ephone.ai: prompt ≤ 2000 chars, first_frame URL, duration 4-30, resolution 480p|720p|1080p,
 * aspect_ratio, generate_audio, watermark).
 *
 * THE CHANNELS. ePhone mixes providers per model: "official" (direct connections), "official_cheap" and "mix" — and
 * its own "about" page says the default routing includes reverse-engineered channels. Every call here asks for the
 * official channels only (X-Provider-Order: official, X-Provider-Only: true): a user's pictures never go through a
 * reverse-engineered channel, and a model with no official channel fails loudly instead of silently.
 *
 * THE ERRORS reuse KieError (src/kie.ts), so the footage road's retry and refusal rules stay one set: a 429 or a 5xx
 * is retryable; an empty balance — HTTP 402, or the 403 "quota is not enough" RixAPI answers (docs: "403: insufficient
 * account balance or insufficient permissions") — becomes status 402, which isNoCredit and the stills engine's
 * fallbackReason read as money. A 403 for anything else (a model that needs identity verification) is a plain refusal.
 *
 * Only imports types and a strip-friendly module, so its tests load it under Node's type stripping.
 */
import type { Env } from "./env";
import { KieError } from "./kie.ts";

export const DEFAULT_EPHONE_URL = "https://api.ephone.ai";
export const ephoneBase = (env: Pick<Env, "EPHONE_API_URL">): string => (env.EPHONE_API_URL ?? "").trim().replace(/\/+$/, "") || DEFAULT_EPHONE_URL;
/** Official channels only, no fallback to the cheaper mixed or reverse-engineered ones (docs: guides/provider.md). */
export const EPHONE_ROUTING: Record<string, string> = { "X-Provider-Order": "official", "X-Provider-Only": "true" };
/** RixAPI's words for an empty balance (it answers them with HTTP 403). */
export const EPHONE_NO_MONEY_RE = /quota is not enough|not enough (?:quota|balance)|insufficient (?:user |token |account )?(?:quota|balance)|额度不足|余额不足/i;

/** What GET /v1/task/{id} answers (the fields Kleo reads). */
export interface EphoneTask { id?: string; status?: string; outputs?: unknown; error?: unknown; usage?: { type?: string; seconds?: number; output_tokens?: number; total_tokens?: number } }

/** One call to ePhone's API, answering its JSON body. `timeoutMs` bounds the whole call. */
export async function ephone<T>(env: Pick<Env, "EPHONE_API_KEY" | "EPHONE_API_URL">, method: "GET" | "POST", path: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
  const key = (env.EPHONE_API_KEY ?? "").trim();
  if (!key) throw new KieError("EPHONE_API_KEY is not set", 0, false);
  const res = await fetch(`${ephoneBase(env)}${path}`, {
    method,
    headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${key}`, ...EPHONE_ROUTING },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  });
  const text = await res.text();
  let data: Record<string, unknown> | null = null;
  try { const x = JSON.parse(text) as unknown; data = x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null; } catch { /* read below */ }
  const err = data && data.error && typeof data.error === "object" ? (data.error as Record<string, unknown>) : null;
  if (!res.ok || err) {
    const said = String(err?.message ?? data?.message ?? text).replace(/\s+/g, " ").slice(0, 240);
    const money = res.status === 402 || EPHONE_NO_MONEY_RE.test(said);
    const status = money ? 402 : res.status;
    throw new KieError(`ephone.ai ${method} ${path} → ${res.status}: ${said}`, status, !money && (res.status === 429 || res.status >= 500));
  }
  if (!data) throw new KieError(`ephone.ai ${method} ${path} → ${res.status}: unreadable body ${text.slice(0, 120)}`, res.status, true);
  return data as T;
}

/** The result URLs of a finished task (`outputs`), https only. */
export function ephoneOutputs(t: EphoneTask): string[] {
  return Array.isArray(t.outputs) ? t.outputs.filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)) : [];
}
/** The reason of a failed task, as a short line. */
export const ephoneFailure = (t: EphoneTask): string => String(t.error ?? "ephone.ai reported a failure").replace(/\s+/g, " ").slice(0, 240);

/**
 * What the account can still spend, in dollars, or null when ePhone did not say — a monitoring call never stops a
 * film. Read through the OpenAI-compatible billing pair RixAPI serves to an API key: subscription.hard_limit_usd (the
 * quota) minus usage.total_usage (cents). An unlimited or unreadable answer is null. NOT YET VERIFIED against the live
 * API (25 September 2026): the first test with the owner's key checks it against the console's balance.
 */
export async function ephoneBalanceUsd(env: Pick<Env, "EPHONE_API_KEY" | "EPHONE_API_URL">): Promise<number | null> {
  if (!(env.EPHONE_API_KEY ?? "").trim()) return null;
  try {
    const [sub, use] = await Promise.all([
      ephone<{ hard_limit_usd?: unknown }>(env, "GET", "/v1/dashboard/billing/subscription", undefined, { timeoutMs: 6000 }),
      ephone<{ total_usage?: unknown }>(env, "GET", "/v1/dashboard/billing/usage", undefined, { timeoutMs: 6000 }),
    ]);
    const limit = Number(sub.hard_limit_usd), used = Number(use.total_usage);
    if (!Number.isFinite(limit) || !Number.isFinite(used) || limit <= 0 || limit >= 1e7) return null;
    return Math.round(Math.max(0, limit - used / 100) * 1000) / 1000;
  } catch { return null; }
}
