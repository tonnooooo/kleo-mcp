/**
 * KLEO STUDIO — FINDING THE ADDRESS OF A PAST SIGN-IN (23 October 2026).
 *
 * Accounts opened before src/studio/ips.ts left no address in D1, only users.ip_hash. Cloudflare still has the
 * requests: GraphQL Analytics, httpRequestsAdaptiveGroups on the kleooai.com zone, read in a window of five seconds
 * either side of an audit row (user.created, pay.session, …). The request the event came from is picked by its path
 * (a Google sign-up is GET /auth/google/callback, a payment POST /api/pay/session); the other rows of the window are
 * shown with it, so the owner sees whose browser it was.
 *
 * What Cloudflare refuses or limits: `clientAsn` is not allowed on this plan (asking for it fails the whole query),
 * and the API's rate budget is small, so the console asks once per tap and never in a loop. Requests the Worker makes
 * itself (oauth2.googleapis.com, Cloudflare's own 2a06:98c0::/29 addresses) are left out.
 */
export const KLEO_ZONE = "8debd68bde1fd261514f4d54e249c08c";
const HOSTS = ["app.kleooai.com", "kleooai.com", "www.kleooai.com", "mcp.kleooai.com"];
const WINDOW_MS = 5000;

export interface LoggedRequest {
  at: string; ip: string; country: string | null; host: string; method: string; path: string; status: number | null; ua: string | null; count: number; match: boolean;
}

/** The request paths an audit event comes from (a path ending in "*" is a prefix). */
export function pathsFor(event: string, detail: string | null): string[] {
  if (event === "pay.session") return ["/api/pay/session"];
  if (event === "studio.key_signin") return ["/api/auth/key"];
  if (event === "studio.reset_done") return ["/api/auth/reset"];
  if (event === "studio.login_linked") return ["/auth/*"];
  if (event === "oauth.granted") return ["/authorize*"];
  if (event === "user.created") return /"via":"studio"/.test(detail ?? "") ? ["/auth/*/callback", "/api/auth/signup"] : ["/authorize*", "/mcp*"];
  return ["/api/*", "/auth/*"];
}

const matches = (path: string, patterns: string[]): boolean =>
  patterns.some((p) => (p.includes("*") ? new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^?]*")}$`).test(path) : path === p));

/** Cloudflare's own addresses (Workers' outgoing requests). */
const cloudflareOwn = (ip: string): boolean => /^2a06:98c[0-7]:/i.test(ip);

const QUERY = `query ($zone: String!, $from: Time!, $to: Time!, $hosts: [String!]) { viewer { zones(filter: {zoneTag: $zone}) {
  httpRequestsAdaptiveGroups(limit: 100, filter: {datetime_geq: $from, datetime_leq: $to, clientRequestHTTPHost_in: $hosts}, orderBy: [datetime_ASC]) {
    count dimensions { datetime clientIP clientCountryName clientRequestHTTPHost clientRequestPath clientRequestHTTPMethodName userAgent edgeResponseStatus }
  } } } }`;

export async function lookupRequests(token: string, zone: string, atIso: string, patterns: string[]): Promise<{ rows: LoggedRequest[]; best: LoggedRequest | null }> {
  const at = Date.parse(atIso.endsWith("Z") ? atIso : `${atIso}Z`);
  if (!Number.isFinite(at)) throw new Error("That time is not readable.");
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { zone, hosts: HOSTS, from: new Date(at - WINDOW_MS).toISOString(), to: new Date(at + WINDOW_MS).toISOString() } }),
    signal: AbortSignal.timeout(12_000),
  });
  const j = (await r.json().catch(() => null)) as { data?: any; errors?: { message?: string }[] } | null;
  if (!r.ok || !j || j.errors?.length) throw new Error(`Cloudflare refused the lookup: ${j?.errors?.[0]?.message ?? `status ${r.status}`}`.slice(0, 240));
  const groups: any[] = j.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups ?? [];
  const rows: LoggedRequest[] = groups
    .map((g) => ({
      at: String(g.dimensions?.datetime ?? ""), ip: String(g.dimensions?.clientIP ?? ""), country: g.dimensions?.clientCountryName ?? null,
      host: String(g.dimensions?.clientRequestHTTPHost ?? ""), method: String(g.dimensions?.clientRequestHTTPMethodName ?? ""),
      path: String(g.dimensions?.clientRequestPath ?? ""), status: Number(g.dimensions?.edgeResponseStatus) || null,
      ua: g.dimensions?.userAgent ? String(g.dimensions.userAgent).slice(0, 200) : null, count: Number(g.count) || 1, match: false,
    }))
    .filter((x) => x.ip && !cloudflareOwn(x.ip));
  for (const x of rows) x.match = matches(x.path, patterns);
  // The matching request nearest the event; without one, the address with the most app requests in the window.
  const near = (x: LoggedRequest) => Math.abs(Date.parse(x.at) - at);
  const hit = rows.filter((x) => x.match).sort((a, b) => near(a) - near(b))[0] ?? null;
  let best: LoggedRequest | null = hit;
  if (!best) {
    const n = new Map<string, number>();
    for (const x of rows) if (x.host !== "media.kleooai.com") n.set(x.ip, (n.get(x.ip) ?? 0) + x.count);
    const top = [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    best = top ? rows.find((x) => x.ip === top) ?? null : null;
  }
  return { rows, best };
}
