/**
 * KLEO STUDIO — THE ADMIN CONSOLE'S PROVIDERS AND KEYS (23 October 2026).
 *
 * Which Worker secrets are set (names only: a value never leaves the Worker) and what each provider account has left:
 *   WaveSpeed  GET https://api.wavespeed.ai/api/v3/balance          { data: { balance } } in dollars
 *   APIMart    GET https://api.apimart.ai/v1/user/balance           remain_balance, in dollars
 *   ePhone     its API key cannot read the balance. Every order it refuses for money answers 403
 *              "预扣费额度失败, 用户剩余额度: ＄1.086812, 需要预扣费额度: ＄1.355940" (the pre-charge failed, the account has
 *              $1.09 left), and Studio writes that answer into the audit row of the failed creation: the newest one is
 *              the last balance anybody saw.
 * Reading a balance costs nothing at either provider.
 */
import type { StudioEnv } from "./env.ts";

/** The Worker secrets the console reports on, with what each one is for. */
export const SECRET_NAMES: [string, string][] = [
  ["INTERNAL_SECRET", "Signs sessions, links and Kleo keys"],
  ["EPHONE_API_KEY", "ePhone: every video, picture and app, and the chat agent"],
  ["WAVESPEED_API_KEY", "WaveSpeed: viral templates and backups"],
  ["APIMART_API_KEY", "APIMart: backup of most models"],
  ["STRIPE_SECRET_KEY", "Stripe: Apple Pay and Google Pay inside the app"],
  ["RESEND_API_KEY", "Password reset e-mails"],
  ["GOOGLE_CLIENT_ID", "Sign in with Google"],
  ["GOOGLE_CLIENT_SECRET", "Sign in with Google"],
  ["MICROSOFT_CLIENT_ID", "Sign in with Microsoft"],
  ["MICROSOFT_CLIENT_SECRET", "Sign in with Microsoft"],
  ["APPLE_CLIENT_ID", "Sign in with Apple"],
  ["APPLE_TEAM_ID", "Sign in with Apple"],
  ["APPLE_KEY_ID", "Sign in with Apple"],
  ["APPLE_PRIVATE_KEY", "Sign in with Apple"],
  ["TURNSTILE_SECRET", "The bot check on sign-up"],
  ["CF_ANALYTICS_TOKEN", "Finds the address of past sign-ins in Cloudflare's logs"],
];

export function secretStatus(env: StudioEnv): { name: string; purpose: string; set: boolean }[] {
  const e = env as unknown as Record<string, unknown>;
  return SECRET_NAMES.map(([name, purpose]) => ({ name, purpose, set: typeof e[name] === "string" && (e[name] as string).length > 0 }));
}

export interface Balance { provider: string; name: string; usd: number | null; at: string | null; source: "live" | "last_refusal" | "none"; error?: string }

/** The first number found under `key`, however deep the answer nests it. */
export function findNumber(o: unknown, key: string, depth = 0): number | null {
  if (!o || typeof o !== "object" || depth > 4) return null;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (k === key && v !== null && v !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  for (const v of Object.values(o as Record<string, unknown>)) {
    const n = findNumber(v, key, depth + 1);
    if (n !== null) return n;
  }
  return null;
}

async function liveBalance(provider: string, name: string, url: string, key: string | undefined, field: string): Promise<Balance> {
  const at = new Date().toISOString();
  if (!key) return { provider, name, usd: null, at: null, source: "none", error: "No key set" };
  try {
    const r = await fetch(url, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    const body = await r.json().catch(() => null);
    if (!r.ok) return { provider, name, usd: null, at, source: "live", error: `The provider answered ${r.status}` };
    const usd = findNumber(body, field);
    return usd === null ? { provider, name, usd: null, at, source: "live", error: "The answer had no balance in it" } : { provider, name, usd, at, source: "live" };
  } catch (e) {
    return { provider, name, usd: null, at, source: "live", error: e instanceof Error && e.name === "TimeoutError" ? "The provider did not answer in 8 seconds" : "The provider could not be reached" };
  }
}

/** The dollar amount in an ePhone refusal ("用户剩余额度: ＄1.086812"), or null. */
export function ephoneLeft(text: string): number | null {
  const m = /剩余额度\s*[:：]\s*[＄$]\s*(-?\d+(?:\.\d+)?)/.exec(text);
  return m ? Number(m[1]) : null;
}

/** ePhone's balance as its last refusal said it (the newest audit row that quotes it). */
export async function ephoneBalance(env: StudioEnv): Promise<Balance> {
  const base = { provider: "ephone", name: "ePhone" };
  try {
    // Only the newest rows: the audit table grows by one row a minute and the answer is almost always among them.
    const r = await env.DB.prepare(`SELECT at, detail FROM audit WHERE id > (SELECT COALESCE(MAX(id), 0) - 200000 FROM audit)
        AND detail LIKE '%剩余额度%' ORDER BY id DESC LIMIT 1`).first<{ at: string; detail: string }>();
    const usd = r ? ephoneLeft(r.detail) : null;
    return usd === null ? { ...base, usd: null, at: null, source: "none", error: "No refusal has said it yet" } : { ...base, usd, at: r!.at, source: "last_refusal" };
  } catch {
    return { ...base, usd: null, at: null, source: "none", error: "The audit could not be read" };
  }
}

export async function balances(env: StudioEnv): Promise<Balance[]> {
  return Promise.all([
    ephoneBalance(env),
    liveBalance("wavespeed", "WaveSpeed", "https://api.wavespeed.ai/api/v3/balance", env.WAVESPEED_API_KEY, "balance"),
    liveBalance("apimart", "APIMart", "https://api.apimart.ai/v1/user/balance", env.APIMART_API_KEY, "remain_balance"),
  ]);
}
