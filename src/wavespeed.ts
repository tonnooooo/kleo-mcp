/**
 * THE WAVESPEED CLIENT (20 October 2026). Kleo Studio's viral templates (src/studio/trends.ts) run on WaveSpeed AI,
 * the provider behind ausar.ai: its route to Alibaba's Wan 3.0 video edit swaps people into a clip and keeps the
 * scene, the moves and the sound. The owner's test on 20 October (Thomas Shelby into "You Talking Bout Me?", 480p)
 * came out clean. ePhone's own Wan 3.0 route refused the same kind of request at the door.
 *
 *   POST /api/v3/<model slug>                {…inputs}   →  {code: 200, data: {id, status: "created"}}
 *   GET  /api/v3/predictions/<id>/result                 →  {code: 200, data: {id, status: created|processing|completed|failed, outputs[], error}}
 *
 * (wavespeed.ai/docs, read 19-20 October 2026.) An error answers {code: 4xx, message}: "Insufficient credits. Please
 * top up your account to continue." is the empty balance, and becomes status 402 like ePhone's (src/ephone.ts), so a
 * refused order says "being recharged" and gives the credits back.
 *
 * Only imports types and a strip-friendly module, so its tests load it under Node's type stripping.
 */
import { KieError } from "./kie.ts";

export const WAVESPEED_URL = "https://api.wavespeed.ai";
/** WaveSpeed's words for an empty balance. */
export const WAVESPEED_NO_MONEY_RE = /insufficient (?:credits|balance)|top up your account/i;

/** What a prediction answers (the fields Kleo reads): the same shape as an ePhone task, so one poll loop reads both. */
export interface WavespeedTask { id?: string; status?: string; outputs?: unknown; error?: unknown }

export async function wavespeed<T>(env: { WAVESPEED_API_KEY?: string }, method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
  const key = (env.WAVESPEED_API_KEY ?? "").trim();
  if (!key) throw new KieError("WAVESPEED_API_KEY is not set", 0, false);
  const res = await fetch(`${WAVESPEED_URL}${path}`, {
    method,
    headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${key}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: Record<string, unknown> | null = null;
  try { const x = JSON.parse(text) as unknown; data = x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null; } catch { /* read below */ }
  const code = Number(data?.code ?? res.status);
  if (!res.ok || !data || (code && code !== 200)) {
    const said = String(data?.message ?? text).replace(/\s+/g, " ").slice(0, 240);
    const money = res.status === 402 || WAVESPEED_NO_MONEY_RE.test(said);
    throw new KieError(`wavespeed.ai ${method} ${path} → ${res.status}: ${said}`, money ? 402 : res.status, !money && (res.status === 429 || res.status >= 500));
  }
  return (data.data ?? {}) as T;
}

/** Starts one prediction; answers its id. */
export async function wavespeedSubmit(env: { WAVESPEED_API_KEY?: string }, model: string, input: Record<string, unknown>): Promise<string> {
  const d = await wavespeed<{ id?: string }>(env, "POST", `/api/v3/${model}`, input);
  if (!d.id) throw new KieError("wavespeed.ai answered no prediction id", 502, true);
  return String(d.id);
}

/** One prediction's state, read as an ePhone task: completed with outputs, failed with its reason, or still running. */
export async function wavespeedTask(env: { WAVESPEED_API_KEY?: string }, id: string): Promise<WavespeedTask> {
  const d = await wavespeed<WavespeedTask>(env, "GET", `/api/v3/predictions/${encodeURIComponent(id)}/result`, undefined, 15_000);
  const status = String(d.status ?? "").toLowerCase();
  return { id: d.id ?? id, status: status === "created" || status === "processing" ? "in_progress" : status, outputs: d.outputs, error: d.error || null };
}
