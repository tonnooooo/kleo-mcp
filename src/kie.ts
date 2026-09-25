/**
 * THE kie.ai CLIENT (25 September 2026): the unified jobs API every kie.ai model sits behind — one endpoint creates a
 * task, one reads it — and the account's balance, in one module both of its users import.
 *
 * WHY A MODULE OF ITS OWN. Until today only the footage road (src/footage.ts: the clips, the music) spoke to kie.ai,
 * and this code lived there. On 25 September the owner decided the stills must reach Higgsfield quality, and the
 * stills engine (src/stills.ts) learned to draw with Nano Banana Pro through the same createTask / recordInfo pair.
 * The stills engine is loaded by its tests under Node's TYPE STRIPPING, which refuses TypeScript that needs a
 * transform — and KieError was written with parameter properties (`constructor(…, public status: number, …)`), which
 * is exactly such syntax, so footage.ts could not be imported there. The client moved here, written strip-friendly
 * (plain class fields), and footage.ts re-exports every name it used to own: nothing that imported it changes.
 *
 * Only imports types, so any module (and any test) can load it as it is.
 */
import type { Env } from "./env";

/** The kie.ai unified API (docs.kie.ai/market/common): one endpoint creates a task for any market model, one reads it. */
export const KIE_BASE = "https://api.kie.ai";
export const KIE_CREATE = `${KIE_BASE}/api/v1/jobs/createTask`;
export const KIE_RECORD = `${KIE_BASE}/api/v1/jobs/recordInfo`;
/** GET: the account's remaining credits as a bare number in `data` (docs.kie.ai/common-api/get-account-credits); 1 credit = 0.005 $. */
export const KIE_CREDIT = `${KIE_BASE}/api/v1/chat/credit`;
export const USD_PER_KIE_CREDIT = 0.005;

export class KieError extends Error {
  status: number;
  retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "KieError";
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * One call to the unified API, answering its `data`. `timeoutMs` bounds the whole call (the stills engine polls inside
 * a cron tick and must never hang on one request); the footage road passes none, as before.
 */
export async function kie<T>(env: Pick<Env, "KIE_API_KEY">, method: "GET" | "POST", url: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
  if (!env.KIE_API_KEY) throw new KieError("KIE_API_KEY is not set", 0, false);
  const res = await fetch(url, {
    method,
    headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${env.KIE_API_KEY.trim()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  });
  const text = await res.text();
  let data: { code?: number; msg?: string; message?: string; data?: T } = {};
  try { data = JSON.parse(text); } catch { throw new KieError(`kie.ai ${method} ${url} → ${res.status}: unreadable body ${text.slice(0, 120)}${notNow(res.status)}`, res.status, kieRetryable(res.status)); }
  if (!res.ok) throw new KieError(`kie.ai ${method} ${url} → ${res.status}: ${(data.msg ?? data.message ?? text).toString().slice(0, 200)}${notNow(res.status)}`, res.status, kieRetryable(res.status));
  // The unified API answers HTTP 200 with its own code: 200 is fine, 402 is no credits, 4xx is our request, 5xx is
  // theirs. A body that carries `data` is trusted whatever the code says (the doc's own example shows 505 + success).
  if (typeof data.code === "number" && data.code !== 200 && !(data.data && typeof data.data === "object")) throw new KieError(`kie.ai ${method} ${url} → code ${data.code}: ${(data.msg ?? "").slice(0, 200)}${notNow(data.code)}`, data.code, kieRetryable(data.code));
  return data.data as T;
}

/**
 * Which kie.ai answers are "not now" (25 September 2026, docs.kie.ai/market/common error codes): 429 (rate limit),
 * every 5xx but 505, 408 ("service timeout") and 455 ("service unavailable", maintenance). 505 is "feature disabled",
 * which no retry cures. 408 and 455 carry no word a generic reader (src/images.ts isTransientError) takes for "not
 * now", so the message says it: a still that meets one pauses its job instead of being given up for good.
 */
export const kieRetryable = (status: number): boolean => status === 429 || status === 408 || status === 455 || (status >= 500 && status !== 505);
const notNow = (status: number): string => (status === 408 || status === 455 ? " (temporarily unavailable)" : "");

/**
 * kie.ai's own words for an empty account. The unified API documents HTTP 200 + code 402; on 13 September 2026 it
 * answered code 500 with "Credits insufficient : Your current balance isn't enough to run this request" instead
 * (job gt_sw48sch9, 13 tasks in, 3 refused). Both mean the same thing and neither is worth a second try.
 */
export function isNoCredit(e: unknown): boolean {
  if (!(e instanceof KieError)) return false;
  // 433: a sub-key's own spending limit is reached (docs.kie.ai error codes) — the same wall for this server's key.
  return e.status === 402 || e.status === 433 || /credits? insufficient|insufficient credits?|balance isn.t enough|not enough (credits?|balance)|top up|usage exceeded/i.test(e.message);
}

/** What kie.ai's recordInfo answers for one task (the fields Kleo reads; the rest is ignored). state is one of
 *  waiting | queuing | generating | success | fail; resultJson is a JSON STRING {"resultUrls":[...]}; the urls expire
 *  after about 24 hours, which is why a result is copied to R2 the moment it is seen. `creditsConsumed` is what the
 *  task cost (docs.kie.ai/market/common/get-task-detail, read 25 September 2026), in credits of 0.005 $. */
export interface KieRecord { taskId?: string; state?: string; resultJson?: string | { resultUrls?: string[] }; failCode?: string | number; failMsg?: string; costTime?: number; creditsConsumed?: number | string }

/** The result URLs of a finished task: resultJson.resultUrls, whether resultJson came as a string or an object. */
export function kieResultUrls(rec: KieRecord): string[] {
  let rj: unknown = rec.resultJson;
  if (typeof rj === "string") { try { rj = JSON.parse(rj); } catch { rj = null; } }
  const urls = (rj as { resultUrls?: unknown } | null)?.resultUrls;
  return Array.isArray(urls) ? urls.filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)) : [];
}
