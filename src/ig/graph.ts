/**
 * KLEO INSTAGRAM PUBLISHER — THE INSTAGRAM API CALLS, through either of Meta's two roads to the same endpoints:
 *  - Instagram API with Instagram Login (graph.instagram.com): a token that starts with "IG", renewed every 7 days;
 *  - Instagram API with Facebook Login (graph.facebook.com): a token that starts with "EAA". The Worker uses a system
 *    user's token from the business portfolio "Kleo", which never expires. Since 30 Oct 2026 this is the road in use:
 *    Meta's "API setup with Unified login" page fails for us server-side (code 1675030), so no Instagram Login token
 *    can be made.
 * The token decides the road (loginOf); the container, its status_code and media_publish are the same on both.
 *
 * The token travels in the Authorization header, as in Meta's own curl examples, never in a URL. If Meta ever answers
 * as if a call carried no token or an unreadable one (codes 104, 2500 and 190), the call is made once more with
 * access_token as a parameter, the older documented form; when that works, this isolate keeps the form. A call that
 * Meta refused this way never ran, so repeating it (a media_publish too) cannot do anything twice. Token renewal
 * (refresh_access_token) is documented only with the parameter, so it always uses it. Nothing here logs or stores a
 * token: every error is rebuilt from Meta's own message with the token taken out.
 */

export const GRAPH_HOST = "https://graph.instagram.com";
export const FACEBOOK_HOST = "https://graph.facebook.com";
export type Login = "instagram" | "facebook";
/** Facebook Login tokens (user, Page and system-user tokens) start with "EAA"; Instagram Login tokens with "IG". */
export const loginOf = (token: string): Login => (token.trim().startsWith("EAA") ? "facebook" : "instagram");
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export class GraphError extends Error {
  status: number;
  code: number | null;
  subcode: number | null;
  /** Meta's answer never arrived (network, timeout, 5xx): the call may or may not have happened. */
  uncertain: boolean;
  constructor(message: string, status: number, code: number | null, subcode: number | null, uncertain: boolean) {
    super(message);
    this.name = "GraphError";
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.uncertain = uncertain;
  }
}

export interface Graph {
  get<T>(path: string, query?: Record<string, string>): Promise<T>;
  post<T>(path: string, body: Record<string, unknown>): Promise<T>;
}

/** Every copy of a secret in a text replaced, so that no message, event or e-mail can carry it. */
export function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[token]");
  return out;
}

const NO_TOKEN_CODES = new Set([104, 190, 2500]);
let headerWorks = true;

interface MetaError { message?: string; code?: number; error_subcode?: number; error_user_title?: string; error_user_msg?: string }

/**
 * A client bound to one token, on graph.instagram.com unless `host` says otherwise. `path` is versioned ("me",
 * "<IG_ID>/media") unless it starts with "/" ("/refresh_access_token", unversioned in Meta's documentation).
 */
export function graphClient(token: string, version: string, fetcher: Fetcher, opts: { tokenInQuery?: boolean; timeoutMs?: number; host?: string } = {}): Graph {
  const host = opts.host ?? GRAPH_HOST;
  const call = async <T>(method: "GET" | "POST", path: string, params: Record<string, unknown>, asParam: boolean): Promise<T> => {
    const url = new URL(path.startsWith("/") ? `${host}${path}` : `${host}/${version}/${path}`);
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (method === "GET") {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
      if (asParam) url.searchParams.set("access_token", token);
    } else {
      headers["content-type"] = "application/json";
      body = JSON.stringify(asParam ? { ...params, access_token: token } : params);
    }
    if (!asParam) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await fetcher(url.toString(), { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
    } catch (e) {
      throw new GraphError(`Instagram did not answer (${redact(e instanceof Error ? e.message : String(e), [token])})`, 0, null, null, true);
    }
    const text = await res.text().catch(() => "");
    let parsed: { error?: MetaError } | null = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (res.ok && parsed && typeof parsed === "object" && !parsed.error) return parsed as unknown as T;
    const err = parsed?.error;
    if (err && !asParam && NO_TOKEN_CODES.has(Number(err.code))) {
      // Throws Meta's answer to the parameter form when that fails too (a token that is really refused).
      const answer = await call<T>(method, path, params, true);
      headerWorks = false;
      return answer;
    }
    const uncertain = res.status >= 500 || res.status === 0;
    if (err) {
      const what = [err.error_user_title, err.error_user_msg || err.message].filter(Boolean).join(": ") || "error";
      const code = Number.isFinite(Number(err.code)) ? Number(err.code) : null;
      const sub = Number.isFinite(Number(err.error_subcode)) ? Number(err.error_subcode) : null;
      throw new GraphError(redact(`${what} (code ${code ?? "?"}${sub ? `/${sub}` : ""})`, [token]), res.status, code, sub, uncertain);
    }
    throw new GraphError(`Instagram answered HTTP ${res.status}`, res.status, null, null, uncertain);
  };
  const asParam = () => opts.tokenInQuery === true || !headerWorks;
  return {
    get: <T>(p: string, query: Record<string, string> = {}) => call<T>("GET", p, query, asParam()),
    post: <T>(p: string, body: Record<string, unknown>) => call<T>("POST", p, body, asParam()),
  };
}

export interface Me { userId: string; username: string; accountType: string | null }

/** The account the token belongs to; user_id is the <IG_ID> the publishing endpoints take. */
export async function whoAmI(g: Graph): Promise<Me> {
  type Row = { user_id?: string | number; id?: string | number; username?: string; account_type?: string };
  let r: Row & { data?: Row[] };
  try {
    r = await g.get<Row & { data?: Row[] }>("me", { fields: "user_id,username,account_type" });
  } catch (e) {
    // A field Meta does not know (code 100) must not stop publishing: account_type is only a check.
    if (!(e instanceof GraphError) || e.code !== 100) throw e;
    r = await g.get<Row & { data?: Row[] }>("me", { fields: "user_id,username" });
  }
  const row: Row = Array.isArray(r.data) && r.data[0] ? r.data[0] : r;
  const userId = String(row.user_id ?? "");
  if (!/^\d{5,25}$/.test(userId) || !row.username) throw new GraphError("Instagram did not say which account the token is for", 200, null, null, false);
  return { userId, username: String(row.username), accountType: row.account_type ? String(row.account_type) : null };
}

/**
 * The account behind IG_USER_ID, for a Facebook Login token: such a token has no Instagram "me" (a system user's /me is
 * the system user), so the ID comes from the Worker's settings and Meta says whose it is.
 */
export async function igUser(g: Graph, igId: string): Promise<Me> {
  const r = await g.get<{ id?: string | number; username?: string }>(igId, { fields: "id,username" });
  if (String(r.id ?? "") !== igId || !r.username) throw new GraphError(`Instagram did not say which account ${igId} is`, 200, null, null, false);
  return { userId: igId, username: String(r.username), accountType: null };
}

export interface Quota { usage: number; total: number }
/** Meta's moving 24-hour publishing quota (GET /<IG_ID>/content_publishing_limit). */
export async function publishingQuota(g: Graph, igId: string): Promise<Quota> {
  const r = await g.get<{ data?: { quota_usage?: number; config?: { quota_total?: number } }[] }>(`${igId}/content_publishing_limit`, { fields: "quota_usage,config" });
  const d = r.data?.[0];
  // Meta's pages say 100 and 50 posts a day in different places; without a number the lower one holds.
  return { usage: Number(d?.quota_usage ?? 0), total: Number(d?.config?.quota_total ?? 50) };
}

/** Instagram writes "2026-10-31T00:30:05+0000". */
export const igTime = (s: string | undefined): number => (s ? Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) : NaN);

export interface RecentMedia { id: string; ms: number; permalink: string | null }
/** The account's last posts, whoever published them (the app, the web, this Worker). */
export async function recentMedia(g: Graph, igId: string, limit = 10): Promise<RecentMedia[]> {
  const r = await g.get<{ data?: { id: string | number; timestamp?: string; permalink?: string }[] }>(`${igId}/media`, { fields: "id,timestamp,permalink", limit: String(limit) });
  return (r.data ?? []).map((m) => ({ id: String(m.id), ms: igTime(m.timestamp), permalink: m.permalink ?? null })).filter((m) => Number.isFinite(m.ms));
}

/** A new long-lived token (60 days) for one that is at least 24 hours old and not expired. */
export async function refreshToken(token: string, fetcher: Fetcher): Promise<{ token: string; expiresIn: number }> {
  const r = await graphClient(token, "", fetcher, { tokenInQuery: true })
    .get<{ access_token?: string; expires_in?: number }>("/refresh_access_token", { grant_type: "ig_refresh_token" });
  if (!r.access_token || !(Number(r.expires_in) > 0)) throw new GraphError("Instagram renewed nothing", 200, null, null, false);
  return { token: r.access_token, expiresIn: Number(r.expires_in) };
}
