/**
 * KLEO STUDIO — WHEN A PROVIDER RUNS OUT OF MONEY (23 October 2026).
 *
 * The night of 22 October a customer paid 340 EUR and 14 of his 18 clips failed: ePhone's balance was gone
 * ("预扣费额度失败, 用户剩余额度: ＄1.08"). The day before, a Lite subscriber's ten templates had failed the same way on
 * WaveSpeed ("Insufficient credits"). Every one was charged, sent, refused within seconds and refunded: a failed card
 * each time, and nobody told the owner. His words: "i clienti non devono avere questo tipo di errori".
 *
 * Kleo now keeps what each provider can still spend (table provider_status):
 *  - WaveSpeed and APIMart say it for free; the cron reads them every few minutes (refreshBalances).
 *  - ePhone does not tell an API key its balance, but its refusal does ("用户剩余额度: ＄1.08"). That figure counts for
 *    SHORT_MIN minutes after the refusal, lowered by every order placed meanwhile (spent).
 * An order no route can pay for is refused BEFORE the charge (canTake, in generate.ts gate): a plain sentence, no card,
 * nothing charged. The owner gets one e-mail per provider and level every ALERT_EVERY_H hours (alertOwner), with the
 * balance and a signed link that opens orders again the moment he has topped up (resumeProvider).
 *
 * Nothing here may stop an order by accident: a status that cannot be read, or a balance Kleo does not know, lets the
 * order go to the provider as before.
 */
import type { StudioEnv } from "./env.ts";
import type { Env } from "../env.ts";
import { audit } from "../db.ts";
import { signPath } from "./session.ts";
import { ephoneBalanceUsd } from "../ephone.ts";

export type Provider = "ephone" | "wavespeed" | "apimart";
export const PROVIDERS: Provider[] = ["ephone", "wavespeed", "apimart"];
export const PROVIDER_NAMES: Record<Provider, string> = { ephone: "ePhone", wavespeed: "WaveSpeed", apimart: "APIMart" };
const SITES: Record<Provider, string> = { ephone: "https://api.ephone.ai", wavespeed: "https://wavespeed.ai", apimart: "https://apimart.ai" };

/** Minutes an ePhone refusal's figure counts; after that the next order finds out again. */
export const SHORT_MIN = 30;
/** Minutes a balance read from an API counts. */
export const API_FRESH_MIN = 15;
/** Minutes between two balance reads (ePhone answers only for a token with a quota limit, so it is asked less often). */
const REFRESH_MIN: Record<Provider, number> = { ephone: 30, wavespeed: 5, apimart: 5 };
/**
 * What a provider holds back before it starts an order, as a multiple of Kleo's price. ePhone pre-charges its own
 * estimate: 1.36 $ for a Seedance 2.5 clip Kleo priced at 1.29 $, 2.44 $ for one priced at 1.55 $ (22 October). WaveSpeed
 * and APIMart charge their list price.
 */
export const PRECHARGE: Record<Provider, number> = { ephone: 1.6, wavespeed: 1.0, apimart: 1.1 };
/** Below this many dollars the owner is told to top up (STUDIO_PROVIDER_LOW_USD="wavespeed:20,apimart:5" overrides). */
const LOW_USD: Record<Provider, number> = { ephone: 10, wavespeed: 10, apimart: 5 };
export const ALERT_EVERY_H = 6;

export const PROVIDER_STATUS_SCHEMA = `CREATE TABLE IF NOT EXISTS provider_status (
    provider TEXT PRIMARY KEY, balance_usd REAL, balance_at TEXT, source TEXT, short_until TEXT, checked_at TEXT,
    alert_level TEXT, alerted_at TEXT)`;

export interface StatusRow {
  provider: string; balance_usd: number | null; balance_at: string | null; source: "api" | "refusal" | null;
  short_until: string | null; checked_at: string | null; alert_level: "low" | "empty" | null; alerted_at: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();
const asEnv = (env: StudioEnv): Env => env as unknown as Env;
const statusOf = (env: StudioEnv, p: Provider) => env.DB.prepare("SELECT * FROM provider_status WHERE provider = ?").bind(p).first<StatusRow>();

export function lowUsd(env: Pick<StudioEnv, "STUDIO_PROVIDER_LOW_USD">, p: Provider): number {
  for (const part of (env.STUDIO_PROVIDER_LOW_USD ?? "").split(",")) {
    const [k, v] = part.split(":").map((s) => s.trim());
    if (k === p && Number.isFinite(Number(v))) return Number(v);
  }
  return LOW_USD[p];
}

/** What ePhone's refusal says the account still holds ("用户剩余额度: ＄0.279880"), or null. */
export function leftInRefusal(message: string): number | null {
  const m = /剩余额度\s*[:：]\s*[＄$]?\s*(-?\d+(?:\.\d+)?)/.exec(message);
  return m ? Math.max(0, Number(m[1])) : null;
}

/** What the provider can spend now as far as Kleo knows, or null when it does not know (then nothing is refused). */
export function spendable(r: StatusRow | null, nowMs: number): number | null {
  if (!r || r.balance_usd === null || !r.balance_at) return null;
  if (r.source === "api") return nowMs - Date.parse(r.balance_at) <= API_FRESH_MIN * 60_000 ? r.balance_usd : null;
  return r.short_until && Date.parse(r.short_until) > nowMs ? r.balance_usd : null;
}

/** Whether `p` can take an order Kleo priced at `usd`. Never throws: an unreadable status lets the order go. */
export async function canTake(env: StudioEnv, p: Provider, usd: number, nowMs = Date.now()): Promise<boolean> {
  try {
    const left = spendable(await statusOf(env, p), nowMs);
    return left === null || usd * PRECHARGE[p] <= left + 1e-9;
  } catch { return true; }
}

/** One way an order can go: the provider, and what it costs there. */
export interface Route { provider: Provider; usd: number }
/** An order can go when any of its routes can take it (ePhone first, then its backups: generate.ts placeTask). */
export async function anyRouteReady(env: StudioEnv, routes: Route[], nowMs = Date.now()): Promise<boolean> {
  for (const r of routes) if (await canTake(env, r.provider, r.usd, nowMs)) return true;
  return routes.length === 0;
}

/** The sentence a person reads instead of a failed card. */
export const pausedText = (name: string): string =>
  `${name} is unavailable for a little while: its engine is being recharged. Nothing was charged. Try another model, or come back soon.`;

/** An order went out on `p`: what Kleo knows it holds goes down by what the order costs. */
export async function spent(env: StudioEnv, p: Provider, usd: number | null | undefined): Promise<void> {
  if (!usd || usd <= 0) return;
  try {
    await env.DB.prepare("UPDATE provider_status SET balance_usd = MAX(0, balance_usd - ?) WHERE provider = ? AND balance_usd IS NOT NULL").bind(usd, p).run();
  } catch { /* a bookkeeping miss never fails an order */ }
}

/**
 * `p` refused an order for money. What it said it holds is kept (0 when it does not say), the next orders it cannot pay
 * for stop before the charge, and the owner is told. Never throws: the order's own failure path goes on as before.
 */
export async function noteNoMoney(env: StudioEnv, p: Provider, message: string, nowMs = Date.now()): Promise<void> {
  try {
    const left = leftInRefusal(message) ?? 0;
    await env.DB.prepare(`INSERT INTO provider_status (provider, balance_usd, balance_at, source, short_until) VALUES (?, ?, ?, 'refusal', ?)
        ON CONFLICT(provider) DO UPDATE SET balance_usd = excluded.balance_usd, balance_at = excluded.balance_at, source = 'refusal', short_until = excluded.short_until`)
      .bind(p, left, iso(nowMs), iso(nowMs + SHORT_MIN * 60_000)).run();
    await audit(asEnv(env), null, null, "provider.no_money", { provider: p, left, said: message.slice(0, 200) });
    await alertOwner(env, p, "empty", left, nowMs);
  } catch (e) { console.error("provider status", p, e instanceof Error ? e.message : e); }
}

/** The dollars a provider says it holds, or null (no key, no answer, or ePhone's "unlimited" token). */
export async function readBalance(env: StudioEnv, p: Provider): Promise<number | null> {
  try {
    if (p === "ephone") return await ephoneBalanceUsd(env);
    const key = (p === "wavespeed" ? env.WAVESPEED_API_KEY : env.APIMART_API_KEY)?.trim();
    if (!key) return null;
    const url = p === "wavespeed" ? "https://api.wavespeed.ai/api/v3/balance" : "https://api.apimart.ai/v1/user/balance";
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const d = (await res.json()) as { data?: { balance?: unknown }; remain_balance?: unknown };
    const n = Number(p === "wavespeed" ? d.data?.balance : d.remain_balance);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch { return null; }
}

/**
 * The cron's part: reads each provider's balance when it is due, writes it down, ends a pause the balance no longer
 * justifies, and tells the owner when it is low. Answers the balances read this time.
 */
export async function refreshBalances(env: StudioEnv, nowMs = Date.now()): Promise<Partial<Record<Provider, number>>> {
  const read: Partial<Record<Provider, number>> = {};
  for (const p of PROVIDERS) {
    try {
      const r = await statusOf(env, p);
      if (r?.checked_at && nowMs - Date.parse(r.checked_at) < REFRESH_MIN[p] * 60_000) continue;
      const bal = await readBalance(env, p);
      if (bal === null) {
        await env.DB.prepare(`INSERT INTO provider_status (provider, checked_at) VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET checked_at = excluded.checked_at`).bind(p, iso(nowMs)).run();
        continue;
      }
      read[p] = bal;
      await env.DB.prepare(`INSERT INTO provider_status (provider, balance_usd, balance_at, source, short_until, checked_at) VALUES (?, ?, ?, 'api', NULL, ?)
          ON CONFLICT(provider) DO UPDATE SET balance_usd = excluded.balance_usd, balance_at = excluded.balance_at, source = 'api', short_until = NULL, checked_at = excluded.checked_at`)
        .bind(p, bal, iso(nowMs), iso(nowMs)).run();
      if (bal < lowUsd(env, p)) await alertOwner(env, p, bal < 1 ? "empty" : "low", bal, nowMs);
      else await env.DB.prepare("UPDATE provider_status SET alert_level = NULL, alerted_at = NULL WHERE provider = ?").bind(p).run();
    } catch (e) { console.error("provider balance", p, e instanceof Error ? e.message : e); }
  }
  return read;
}

/**
 * Tells the owner, at most once per provider and level every ALERT_EVERY_H hours ("empty" after "low" goes out at
 * once). The claim is one conditional UPDATE, so two requests refused at the same moment send one e-mail.
 */
export async function alertOwner(env: StudioEnv, p: Provider, level: "low" | "empty", balance: number | null, nowMs = Date.now()): Promise<boolean> {
  await env.DB.prepare("INSERT OR IGNORE INTO provider_status (provider) VALUES (?)").bind(p).run();
  const claimed = await env.DB.prepare(`UPDATE provider_status SET alert_level = ?, alerted_at = ?
      WHERE provider = ? AND (alerted_at IS NULL OR alerted_at < ? OR (alert_level = 'low' AND ? = 'empty'))`)
    .bind(level, iso(nowMs), p, iso(nowMs - ALERT_EVERY_H * 3600_000), level).run();
  if ((claimed.meta?.changes ?? 0) !== 1) return false;
  const name = PROVIDER_NAMES[p];
  const origin = (env.STUDIO_URL ?? "https://app.kleooai.com").replace(/\/$/, "");
  const resume = origin + (await signPath(env.INTERNAL_SECRET, `/api/provider-resume/${p}`, 3 * 86_400, nowMs));
  const money = balance === null ? "unknown" : `$${balance.toFixed(2)}`;
  const subject = level === "empty" ? `Kleo: ${name} is out of money, orders on it are paused` : `Kleo: ${name} is running low (${money})`;
  const text = [
    level === "empty"
      ? `${name} is out of money: it holds ${money}. Orders it cannot pay for now stop before the charge, and customers read "unavailable for a little while".`
      : `${name} holds ${money}, under the $${lowUsd(env, p)} warning line. Orders still run; top it up before it runs out.`,
    "",
    `Top up: ${SITES[p]}`,
    level === "empty" ? `When it's topped up, open this link to resume orders at once (otherwise they resume by themselves within ${p === "ephone" ? SHORT_MIN : REFRESH_MIN[p]} minutes):` : "",
    level === "empty" ? resume : "",
    "",
    `Sent by Kleo Studio at ${iso(nowMs)} (UTC). One e-mail per provider every ${ALERT_EVERY_H} hours.`,
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
  const sent = await mailOwner(env, subject, text, nowMs);
  await audit(asEnv(env), null, null, "provider.alert", { provider: p, level, balance, mailed: sent });
  return true;
}

/** The address alerts come from: any address of the kleooai.com zone, where Email Routing is on. */
export const ALERT_FROM = "alerts@kleooai.com";
/** Plain-text e-mail in the shape Cloudflare's send_email accepts (RFC 5322, a Message-ID, CRLF lines). */
export function ownerMime(from: string, to: string, subject: string, text: string, nowMs: number): string {
  const id = `${nowMs.toString(36)}.${Math.random().toString(36).slice(2, 10)}@kleooai.com`;
  return [
    `From: Kleo alerts <${from}>`, `To: ${to}`, `Subject: ${subject.replace(/[\r\n]+/g, " ")}`, `Message-ID: <${id}>`,
    `Date: ${new Date(nowMs).toUTCString()}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit",
    "", text.replace(/\r?\n/g, "\r\n"),
  ].join("\r\n");
}

/**
 * Sends the owner an e-mail through the OWNER_MAIL send_email binding (wrangler.studio.jsonc), whose destination is the
 * one address verified in Email Routing (kleooai@gmail.com). False when the binding is missing or the send fails: an
 * alert that cannot go out is still in the audit.
 */
export async function mailOwner(env: StudioEnv, subject: string, text: string, nowMs = Date.now()): Promise<boolean> {
  const mail = env.OWNER_MAIL;
  if (!mail) return false;
  try {
    const to = (env.OWNER_MAIL_TO ?? "kleooai@gmail.com").trim();
    const { EmailMessage } = await import("cloudflare:email");
    await mail.send(new EmailMessage(ALERT_FROM, to, ownerMime(ALERT_FROM, to, subject, text, nowMs)));
    return true;
  } catch (e) {
    console.error("owner mail", e instanceof Error ? e.message : e);
    return false;
  }
}

/** The owner's "it's topped up" link: the pause ends at once, and the next alert may go out again. */
export async function resumeProvider(env: StudioEnv, p: Provider): Promise<void> {
  await env.DB.prepare(`UPDATE provider_status SET balance_usd = NULL, balance_at = NULL, source = NULL, short_until = NULL, checked_at = NULL,
      alert_level = NULL, alerted_at = NULL WHERE provider = ?`).bind(p).run();
  await audit(asEnv(env), null, null, "provider.resumed", { provider: p });
}

/**
 * GET shows a page with one button and POST does it: mail scanners open links in e-mails, and a GET that resumed would
 * end a pause before the owner had topped anything up. The signature in the link is the authorisation.
 */
export async function handleProviderResume(env: StudioEnv, request: Request, url: URL, p: Provider, signed: boolean): Promise<Response> {
  const page = (body: string, status = 200) => new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kleo</title><body>${body}</body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  const name = PROVIDER_NAMES[p];
  if (!signed) return page("<h1>This link has expired.</h1><p>Orders resume by themselves once the balance is back.</p>", 403);
  if (request.method === "POST") {
    await resumeProvider(env, p);
    return page(`<h1>${name} is open again.</h1><p>Customers can order on it now. If it is still empty, Kleo pauses it again and writes to you.</p>`);
  }
  return page(`<h1>Resume ${name}?</h1><p>Do this once you have topped it up.</p>
<form method="post" action="${url.pathname}${url.search}"><button type="submit">Resume orders on ${name}</button></form>`);
}
