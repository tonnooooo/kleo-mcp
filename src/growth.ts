import type { Env } from "./env";
import { audit } from "./db.ts";
import { normalizeChannel } from "./launch.ts";

/**
 * ATTRIBUTION AND THE FUNNEL (27 September 2026, the owner: "attract people and make them stay" — and know which
 * channel does it). Three pieces, none of which knows who a visitor is:
 *
 *  1. The connector address takes ?src=<channel> (https://mcp.kleooai.com/mcp?src=producthunt). The sign-in page reads
 *     it from the OAuth `resource` the client sends (src/auth.ts connectionHints), and a new account's first MCP calls
 *     carry it too (src/index.ts): users.src, written once. A launch code's channel (redemptions.channel) and a
 *     referral (users.referred_by) attribute an account that came without one. kleo_account shows none of it.
 *  2. GET or POST /b — a first-party page counter for the site: p=<path>, r=<referrer host>, s=<utm_source>, l=<lang>,
 *     plus the country Cloudflare puts on the request. Stored AGGREGATED per UTC day (page_hits: one row per day,
 *     path, referrer host, source, language and country, with a count). No IP, no cookie, no user id, no user agent.
 *  3. GET /internal/admin/growth (Bearer INTERNAL_SECRET): the funnel per day and per source — visits, sign-ups, first
 *     video, first film, launch-code redemptions, payments, referral rewards.
 *
 * The site's snippet (one line, no cookie; utm_source is the channel name the launch posts use):
 *   <script>try{const u=new URL(location.href),r=document.referrer?new URL(document.referrer).hostname:"";
 *   navigator.sendBeacon("https://mcp.kleooai.com/b?"+new URLSearchParams({p:u.pathname,r,s:u.searchParams.get("utm_source")||"",l:(navigator.language||"").slice(0,2)}))}catch(e){}</script>
 */

/** Distinct page_hits rows one UTC day may add; past it every new combination is counted under "(other)". */
export const HITS_ROWS_PER_DAY = 5000;
/** Hosts that are Kleo itself: a visit from one page of the site to another has no referrer worth keeping. */
const OWN_HOSTS = /(^|\.)kleooai\.com$|(^|\.)kleo-mcp\.[a-z0-9-]+\.workers\.dev$/;

const clip = (s: string, n: number) => s.slice(0, n);
/** The path of a page, without query or fragment; "/" when there is nothing usable. */
export function cleanPath(raw: unknown): string {
  let p = String(raw ?? "").trim();
  try { if (/^https?:\/\//i.test(p)) p = new URL(p).pathname; } catch { p = ""; }
  p = p.split(/[?#]/)[0].replace(/[^A-Za-z0-9/_.~-]/g, "");
  if (!p.startsWith("/")) p = `/${p}`;
  return clip(p.replace(/\/{2,}/g, "/"), 100) || "/";
}
/** The host of a referrer, lower case and without "www."; "" for none, for Kleo's own pages and for rubbish. */
export function cleanHost(raw: unknown): string {
  let h = String(raw ?? "").trim().toLowerCase();
  try { if (/^[a-z][a-z0-9+.-]*:\/\//.test(h)) h = new URL(h).hostname; } catch { return ""; }
  h = h.split(/[/:?#]/)[0].replace(/^www\./, "");
  if (!/^[a-z0-9.-]{1,80}$/.test(h) || !h.includes(".")) return "";
  return OWN_HOSTS.test(h) ? "" : h;
}
export const cleanSource = (raw: unknown): string => normalizeChannel(raw) ?? "";
/** The primary language subtag: "it" out of "it-IT", "" when there is none. */
export function cleanLang(raw: unknown): string {
  const m = /^([a-z]{2,3})(?:[-_]|$)/.exec(String(raw ?? "").trim().toLowerCase());
  return m ? m[1] : "";
}
export const cleanCountry = (raw: unknown): string => {
  const c = String(raw ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== "XX" && c !== "T1" ? c : "";
};

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "cache-control": "no-store" };

/**
 * GET|POST /b — counts one page view, aggregated. The fields come from the query string, or from a POST body
 * (sendBeacon's text/plain: a query string or a JSON object). Always 204: a counter never breaks the page it is on.
 */
export async function handleBeacon(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "GET" && request.method !== "POST") return new Response(null, { status: 405, headers: CORS });
  const url = new URL(request.url);
  const f = new URLSearchParams(url.search);
  if (request.method === "POST") {
    try {
      const body = (await request.text()).slice(0, 2000).trim();
      if (body.startsWith("{")) for (const [k, v] of Object.entries(JSON.parse(body) as Record<string, unknown>)) f.set(k, String(v ?? ""));
      else if (body) for (const [k, v] of new URLSearchParams(body)) f.set(k, v);
    } catch { /* a body we cannot read counts what the query string says */ }
  }
  const cf = (request as Request & { cf?: { country?: string } }).cf;
  const hit = {
    day: new Date().toISOString().slice(0, 10),
    path: cleanPath(f.get("p")), ref: cleanHost(f.get("r")), source: cleanSource(f.get("s")), lang: cleanLang(f.get("l")),
    country: cleanCountry(cf?.country ?? request.headers.get("cf-ipcountry")),
  };
  try { await countHit(env, hit); } catch { /* never an error page for a counter */ }
  return new Response(null, { status: 204, headers: CORS });
}

type Hit = { day: string; path: string; ref: string; source: string; lang: string; country: string };
/** One more view in its day's row; a new row only while the day has room, else the view goes to "(other)". */
export async function countHit(env: Env, h: Hit): Promise<void> {
  const bump = (x: Hit) => env.DB.prepare("UPDATE page_hits SET n = n + 1 WHERE day = ? AND path = ? AND ref = ? AND source = ? AND lang = ? AND country = ?")
    .bind(x.day, x.path, x.ref, x.source, x.lang, x.country).run();
  if (((await bump(h)).meta.changes ?? 0) === 1) return;
  const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM page_hits WHERE day = ?").bind(h.day).first<{ n: number }>();
  const x: Hit = (rows?.n ?? 0) < HITS_ROWS_PER_DAY ? h : { day: h.day, path: "(other)", ref: "", source: "", lang: "", country: "" };
  await env.DB.prepare(
    `INSERT INTO page_hits (day, path, ref, source, lang, country, n) VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(day, path, ref, source, lang, country) DO UPDATE SET n = n + 1`,
  ).bind(x.day, x.path, x.ref, x.source, x.lang, x.country).run();
}

/**
 * The channel a new account came through, written once (the sign-in page, or the first MCP calls of its first day).
 * Returns true when THIS call wrote it.
 */
export async function recordSignupSource(env: Env, userId: string, raw: unknown, via: string): Promise<boolean> {
  const src = normalizeChannel(raw);
  if (!src) return false;
  const r = await env.DB.prepare("UPDATE users SET src = ? WHERE id = ? AND src IS NULL").bind(src, userId).run();
  if ((r.meta.changes ?? 0) !== 1) return false;
  await audit(env, userId, null, "user.src", { src, via });
  return true;
}

/** An account's source, in SQL: the channel it came through, else its launch code's, else a referral, else direct. */
const SOURCE_OF = (u: string, rd: string) =>
  `COALESCE(${u}.src, ${rd}.channel, CASE WHEN ${u}.referred_by IS NOT NULL THEN 'referral' END, 'direct')`;

export interface FunnelRow { visits: number; signups: number; first_videos: number; first_films: number; redemptions: number; payments: number; payment_cents: number; referrals: number }
const EMPTY = (): FunnelRow => ({ visits: 0, signups: 0, first_videos: 0, first_films: 0, redemptions: 0, payments: 0, payment_cents: 0, referrals: 0 });

/**
 * The funnel since `days` UTC days ago (today included): per day, per source, per day and source, and the top pages
 * and referrers of the window. Visits are attributed to utm_source, else the referrer's host, else "direct"; the other
 * steps to the account's source (SOURCE_OF). Use the same names for utm_source and ?src= and the two line up.
 */
export async function growthReport(env: Env, days = 30): Promise<Record<string, unknown>> {
  const n = Math.max(1, Math.min(365, Math.round(days) || 30));
  const since = new Date(Date.now() - (n - 1) * 86400_000).toISOString().slice(0, 10);
  const all = async <T>(sql: string, ...args: unknown[]) => ((await env.DB.prepare(sql).bind(...args).all<T>()).results ?? []);
  type R = { day: string; source: string; n: number; cents?: number };
  const src = SOURCE_OF("u", "rd");
  const join = "JOIN users u ON u.id = x.user_id LEFT JOIN redemptions rd ON rd.user_id = u.id";
  const steps: [keyof FunnelRow, R[]][] = [
    ["visits", await all<R>(`SELECT day, COALESCE(NULLIF(source, ''), NULLIF(ref, ''), 'direct') AS source, SUM(n) AS n FROM page_hits WHERE day >= ? GROUP BY 1, 2`, since)],
    ["signups", await all<R>(`SELECT substr(x.created_at, 1, 10) AS day, ${src} AS source, COUNT(*) AS n FROM (SELECT id AS user_id, created_at FROM users) x ${join} WHERE x.created_at >= ? GROUP BY 1, 2`, since)],
    ["first_videos", await all<R>(`SELECT substr(x.first, 1, 10) AS day, ${src} AS source, COUNT(*) AS n FROM (SELECT user_id, MIN(created_at) AS first FROM jobs GROUP BY user_id) x ${join} WHERE x.first >= ? GROUP BY 1, 2`, since)],
    ["first_films", await all<R>(`SELECT substr(x.first, 1, 10) AS day, ${src} AS source, COUNT(*) AS n FROM (SELECT user_id, MIN(created_at) AS first FROM jobs WHERE COALESCE(json_extract(params, '$.product'), 'film') = 'film' GROUP BY user_id) x ${join} WHERE x.first >= ? GROUP BY 1, 2`, since)],
    ["redemptions", await all<R>(`SELECT substr(at, 1, 10) AS day, channel AS source, COUNT(*) AS n FROM redemptions WHERE at >= ? GROUP BY 1, 2`, since)],
    ["payments", await all<R>(`SELECT substr(x.at, 1, 10) AS day, ${src} AS source, COUNT(*) AS n, SUM(x.amount_cent) AS cents FROM payments x ${join} WHERE x.status = 'paid' AND x.amount_cent > 0 AND x.at >= ? GROUP BY 1, 2`, since)],
    ["referrals", await all<R>(`SELECT substr(x.at, 1, 10) AS day, ${src} AS source, COUNT(*) AS n FROM (SELECT referred_id AS user_id, at FROM referrals WHERE status = 'paid') x ${join} WHERE x.at >= ? GROUP BY 1, 2`, since)],
  ];
  const byDay = new Map<string, FunnelRow>(), bySource = new Map<string, FunnelRow>(), byBoth = new Map<string, FunnelRow & { day: string; source: string }>();
  const totals = EMPTY();
  for (const [key, rows] of steps) for (const r of rows) {
    const count = Number(r.n) || 0, cents = Number(r.cents) || 0;
    const both = `${r.day}|${r.source}`;
    if (!byDay.has(r.day)) byDay.set(r.day, EMPTY());
    if (!bySource.has(r.source)) bySource.set(r.source, EMPTY());
    if (!byBoth.has(both)) byBoth.set(both, { day: r.day, source: r.source, ...EMPTY() });
    for (const row of [byDay.get(r.day)!, bySource.get(r.source)!, byBoth.get(both)!, totals]) {
      row[key] += count;
      if (key === "payments") row.payment_cents += cents;
    }
  }
  const top = async (col: "path" | "ref") => (await all<{ k: string; n: number }>(`SELECT ${col} AS k, SUM(n) AS n FROM page_hits WHERE day >= ? AND ${col} != '' GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, since)).map((r) => ({ [col === "path" ? "path" : "referrer"]: r.k, visits: Number(r.n) }));
  return {
    since, days: n, totals,
    by_day: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, row]) => ({ day, ...row })),
    by_source: [...bySource.entries()].sort(([, a], [, b]) => b.signups - a.signups || b.visits - a.visits).map(([source, row]) => ({ source, ...row })),
    by_day_source: [...byBoth.values()].sort((a, b) => a.day.localeCompare(b.day) || a.source.localeCompare(b.source)),
    top_pages: await top("path"),
    top_referrers: await top("ref"),
  };
}
