/**
 * THE APIMART CLIENT (20 October 2026). ePhone ran out of credit and Kleo Studio stopped generating. The owner chose a
 * backup per model: the cheapest provider that is not ePhone, used only where it costs the same as ePhone or less
 * (kleo\PROVIDER_COSTS.md, section 6). For most of those models that is APIMart (apimart.ai), a reseller with one
 * async task API for video, pictures and music:
 *
 *   POST /v1/videos/generations | /v1/images/generations | /v1/music/…   {model, …}  →  {code: 200, data: [{task_id, status: "submitted"}]}
 *   GET  /v1/tasks/<task_id>                                                       →  {code: 200, data: {status, result, error, cost}}
 *
 * (docs.apimart.ai, read 20 October 2026.) An error answers {error: {message, type, code}} or {code, message}; an empty
 * balance becomes status 402 like ePhone's (src/ephone.ts), so a refused order says "being recharged" and gives the
 * credits back. A task is read into the same shape as an ePhone task (status, outputs, error), so one poll loop reads
 * every provider.
 *
 * Only imports types and a strip-friendly module, so its tests load it under Node's type stripping.
 */
import { KieError } from "./kie.ts";

export const APIMART_URL = "https://api.apimart.ai";
/** APIMart's words for an empty balance (and the RixAPI-style ones it may pass through). */
export const APIMART_NO_MONEY_RE = /insufficient[ _]?(?:user[ _])?(?:quota|balance|credits?)|not enough (?:quota|balance|credits?)|quota is not enough|余额不足|额度不足|预扣费额度失败|top ?up/i;

/** A task read like an ePhone one: completed with outputs, failed with its reason, or still running. */
export interface ApimartTask { id?: string; status?: string; outputs?: string[]; error?: unknown; cost?: number | null }

type Env = { APIMART_API_KEY?: string };

export async function apimart<T>(env: Env, method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
  const key = (env.APIMART_API_KEY ?? "").trim();
  if (!key) throw new KieError("APIMART_API_KEY is not set", 0, false);
  const res = await fetch(`${APIMART_URL}${path}`, {
    method,
    headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${key}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: Record<string, unknown> | null = null;
  try { const x = JSON.parse(text) as unknown; data = x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null; } catch { /* read below */ }
  const err = data && data.error && typeof data.error === "object" ? (data.error as Record<string, unknown>) : null;
  const code = Number(data?.code ?? 200);
  if (!res.ok || !data || err || (Number.isFinite(code) && code !== 200 && code !== 0)) {
    const said = String(err?.message ?? data?.message ?? data?.msg ?? text).replace(/\s+/g, " ").slice(0, 240);
    const money = res.status === 402 || APIMART_NO_MONEY_RE.test(said) || APIMART_NO_MONEY_RE.test(String(err?.code ?? err?.type ?? ""));
    throw new KieError(`apimart.ai ${method} ${path} → ${res.status}: ${said}`, money ? 402 : res.status, !money && (res.status === 429 || res.status >= 500));
  }
  return data as T;
}

/** Starts one task on `path` (/v1/videos/generations, /v1/images/generations…); answers its id. */
export async function apimartSubmit(env: Env, path: string, body: Record<string, unknown>): Promise<string> {
  const r = await apimart<{ data?: unknown }>(env, "POST", path, body);
  const d = Array.isArray(r.data) ? r.data[0] : r.data;
  const id = d && typeof d === "object" ? (d as Record<string, unknown>).task_id ?? (d as Record<string, unknown>).id : null;
  if (!id) throw new KieError("apimart.ai answered no task id", 502, true);
  return String(id);
}

/** Every https link (or data: URI) inside a task's result, in order: pictures, videos, songs. */
export function apimartOutputs(result: unknown): string[] {
  const out: string[] = [];
  const walk = (o: unknown): void => {
    if (typeof o === "string") { if (/^https?:\/\//.test(o) || /^data:(image|video|audio)\//.test(o)) out.push(o); return; }
    if (Array.isArray(o)) { for (const v of o) walk(v); return; }
    if (o && typeof o === "object") for (const v of Object.values(o as Record<string, unknown>)) walk(v);
  };
  walk(result);
  return [...new Set(out)];
}

/** Songs and sounds (Suno) are read at their own address: Kleo keeps their ids as "music:<id>". */
export const MUSIC_PREFIX = "music:";

/** One task's state, read as an ePhone task. */
export async function apimartTask(env: Env, id: string): Promise<ApimartTask> {
  const music = id.startsWith(MUSIC_PREFIX);
  const raw = music ? id.slice(MUSIC_PREFIX.length) : id;
  const r = await apimart<{ data?: Record<string, unknown> }>(env, "GET", `/v1/${music ? "music/" : ""}tasks/${encodeURIComponent(raw)}`, undefined, 15_000);
  return readApimartTask(r.data ?? {}, raw);
}

/** The pure part of apimartTask (tested on its own). */
export function readApimartTask(d: Record<string, unknown>, id = ""): ApimartTask {
  const s = String(d.status ?? "").toLowerCase();
  const status = s === "completed" || s === "succeeded" || s === "success" ? "completed"
    : s === "failed" || s === "failure" || s === "error" || s === "cancelled" || s === "canceled" ? "failed" : "in_progress";
  const e = d.error;
  const error = status !== "failed" ? null
    : (e && typeof e === "object" ? String((e as Record<string, unknown>).message ?? JSON.stringify(e)) : String(e || d.fail_reason || d.message || "apimart.ai reported a failure"));
  const cost = Number(d.cost ?? d.credits_cost);
  const result = (d.result ?? d.output ?? d.outputs) as unknown;
  // A song's result also links its cover picture and a video: only the sound files are its outputs.
  const music = result && typeof result === "object" && Array.isArray((result as Record<string, unknown>).music) ? (result as { music: Record<string, unknown>[] }).music : null;
  const outputs = status !== "completed" ? [] : music ? music.map((m) => m?.audio_url).filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)) : apimartOutputs(result);
  return { id: String(d.task_id ?? d.id ?? id), status, outputs, error, cost: Number.isFinite(cost) ? cost : null };
}
