/**
 * KLEO STUDIO — THE ADMIN CONSOLE'S PROVIDERS AND KEYS (23 October 2026).
 *
 * Which Worker secrets are set (names only: a value never leaves the Worker), and what each provider account has left.
 * The balances come from src/studio/providers.ts, the provider alarm's own bookkeeping:
 *   - readBalance asks the provider now (WaveSpeed and APIMart for free; ePhone only for a token with a quota limit);
 *   - provider_status keeps the last figure the cron read or ePhone's last refusal said ("用户剩余额度: ＄1.08"), and
 *     whether orders on it are paused;
 *   - with neither, the newest audit row quoting an ePhone refusal is the last balance anybody saw.
 */
import type { StudioEnv } from "./env.ts";
import { PROVIDERS, PROVIDER_NAMES, SHORT_MIN, leftInRefusal, readBalance, spendable, type Provider, type StatusRow } from "./providers.ts";

/** The Worker secrets the console reports on, with what each one is for. */
export const SECRET_NAMES: [string, string][] = [
  ["INTERNAL_SECRET", "Signs sessions, links and Kleo keys, and seals the admin code"],
  ["EPHONE_API_KEY", "ePhone: every video, picture and app, and the chat agent"],
  ["EPHONE_ADMIN_KEY", "ePhone admin key, read only (account:read): reads the account's balance live"],
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
  const set = SECRET_NAMES.map(([name, purpose]) => ({ name, purpose, set: typeof e[name] === "string" && (e[name] as string).length > 0 }));
  // A binding, not a secret, but the owner's alerts depend on it.
  set.push({ name: "OWNER_MAIL", purpose: "E-mails to the owner: provider alerts and admin sign-ins", set: !!env.OWNER_MAIL });
  return set;
}

/**
 * `stale`: a figure from a refusal older than providers.ts SHORT_MIN. It is what the provider held THEN, not now (on
 * 23 October the console showed ePhone at $1.09 three hours after the owner had topped it up to $10), so the page shows
 * it as history, never as the balance.
 */
export interface Balance {
  provider: Provider; name: string; usd: number | null; at: string | null; source: "live" | "last_read" | "last_refusal" | "none";
  paused: boolean; stale?: boolean; error?: string;
}

/** What ePhone's newest refusal in the audit said it held, or null. */
async function lastRefusal(env: StudioEnv): Promise<{ usd: number; at: string } | null> {
  // Only the newest rows: the audit table grows by one row a minute and the answer is almost always among them.
  const r = await env.DB.prepare(`SELECT at, detail FROM audit WHERE id > (SELECT COALESCE(MAX(id), 0) - 200000 FROM audit)
      AND detail LIKE '%剩余额度%' ORDER BY id DESC LIMIT 1`).first<{ at: string; detail: string }>().catch(() => null);
  const usd = r ? leftInRefusal(r.detail) : null;
  return usd === null ? null : { usd, at: r!.at };
}

export async function balances(env: StudioEnv, nowMs = Date.now()): Promise<Balance[]> {
  const rows = new Map<string, StatusRow>();
  try {
    for (const r of (await env.DB.prepare("SELECT * FROM provider_status").all<StatusRow>()).results) rows.set(r.provider, r);
  } catch { /* no table yet: live reads only */ }
  return Promise.all(PROVIDERS.map(async (p): Promise<Balance> => {
    const row = rows.get(p) ?? null;
    // Orders on it stop while what Kleo knows it holds is zero (providers.ts canTake).
    const paused = spendable(row, nowMs) === 0;
    const base = { provider: p, name: PROVIDER_NAMES[p], paused };
    const live = await readBalance(env, p);
    if (live !== null) return { ...base, usd: live, at: new Date(nowMs).toISOString(), source: "live" };
    const old = (at: string) => nowMs - Date.parse(at.endsWith("Z") ? at : `${at}Z`) > SHORT_MIN * 60_000;
    if (row?.balance_usd !== null && row?.balance_usd !== undefined && row.balance_at) {
      const refusal = row.source === "refusal";
      return { ...base, usd: row.balance_usd, at: row.balance_at, source: refusal ? "last_refusal" : "last_read", ...(refusal && old(row.balance_at) ? { stale: true } : {}) };
    }
    if (p === "ephone") {
      const r = await lastRefusal(env);
      if (r) return { ...base, usd: r.usd, at: r.at, source: "last_refusal", ...(old(r.at) ? { stale: true } : {}) };
    }
    const key = p === "ephone" ? env.EPHONE_API_KEY : p === "wavespeed" ? env.WAVESPEED_API_KEY : env.APIMART_API_KEY;
    return { ...base, usd: null, at: null, source: "none", error: !key ? "No key set" : p === "ephone" ? "Its key can't read the balance, and no refusal has said it yet" : "The provider did not answer" };
  }));
}
