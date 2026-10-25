/**
 * KLEO STUDIO — WHERE ACCOUNTS COME FROM (25 October 2026, the owner: which social network, which post or video and which
 * link brought each new account; until today every Studio sign-up was only `users.src = 'studio'`).
 *
 * First touch, first party, nothing sent anywhere else:
 *  - THE FIRST VISIT. The first time a browser opens a page of the app (a page load, not a script or a picture) or a
 *    short link, the Worker reads where it came from: utm_source, utm_medium, utm_campaign, utm_content, ?src=, the short
 *    link's code, the referring host (never the full address), the landing path (never its query) and the in-app browser
 *    named in the user agent. It keeps that in one cookie, __Host-kleo_src: seven days, HttpOnly, this host only, no
 *    identifier in it. SameSite=Lax, so it comes back with Google's redirect to /auth/google/callback.
 *  - THE GUESS. Instagram's and TikTok's in-app browsers often send no referrer at all. With no tag and no referrer, the
 *    channel is guessed from the in-app browser's name ("Instagram", "musical_ly", "BytedanceWebview", "FBAN" …) and the
 *    row says it is a guess.
 *  - THE ACCOUNT. When the browser opens a new account (src/studio/auth.ts newAccount), the cookie becomes its one
 *    user_attribution row, and the cookie is cleared. An account opened with no cookie gets a row too ("untracked"), so a
 *    missing row means an account that did not come through the app (or came before tracking began, studio_meta).
 *  - THE COUNTS. First visits are counted per day, channel and link (first_visits) and short-link clicks per day and link
 *    (short_link_clicks): totals only, no account, no address, nothing that tells two people apart.
 *  - SHORT LINKS. app.kleooai.com/r/<code> counts the click, tags the visit and sends the browser on to the link's page with
 *    utm tags. The owner makes them in the admin console (src/studio/admin.ts, Sources).
 * A browser that signals Global Privacy Control or Do Not Track gets no cookie and is not counted as a first visit; its
 * account row says "untracked". Robots and link previews are never counted. The privacy page (kleo-site privacy.html)
 * describes the cookie and the counts.
 */
import type { StudioEnv } from "./env.ts";

export const SOURCE_COOKIE = "__Host-kleo_src";
export const SOURCE_DAYS = 7;
export const SHORT_LINK_PATH = /^\/r\/([A-Za-z0-9-]{1,40})\/?$/;
/** The networks a short link can be made for. */
export const LINK_CHANNELS = ["instagram", "tiktok", "x", "youtube", "dm", "other"] as const;
export type LinkChannel = (typeof LINK_CHANNELS)[number];
export const CODE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
/** The tables (migrations/0028_attribution.sql holds the same statements), created with Studio's own on first use. */
export const ATTRIBUTION_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS user_attribution (
    user_id TEXT PRIMARY KEY, channel TEXT NOT NULL, guessed INTEGER NOT NULL DEFAULT 0, link_code TEXT,
    utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, src TEXT, ref_host TEXT, landing TEXT, in_app TEXT,
    first_seen_at TEXT, created_at TEXT NOT NULL DEFAULT ${NOW})`,
  `CREATE INDEX IF NOT EXISTS user_attribution_created ON user_attribution (created_at)`,
  `CREATE INDEX IF NOT EXISTS user_attribution_link ON user_attribution (link_code)`,
  `CREATE TABLE IF NOT EXISTS short_links (
    code TEXT PRIMARY KEY, channel TEXT NOT NULL, label TEXT NOT NULL, target TEXT NOT NULL DEFAULT '/',
    created_at TEXT NOT NULL DEFAULT ${NOW}, created_by TEXT, archived_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS short_link_clicks (code TEXT NOT NULL, day TEXT NOT NULL, clicks INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (code, day))`,
  `CREATE TABLE IF NOT EXISTS first_visits (
    day TEXT NOT NULL, channel TEXT NOT NULL, link_code TEXT NOT NULL DEFAULT '', guessed INTEGER NOT NULL DEFAULT 0, n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, channel, link_code, guessed))`,
  // When tracking began: accounts older than this are "unknown (before tracking)" in the console.
  `CREATE TABLE IF NOT EXISTS studio_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `INSERT OR IGNORE INTO studio_meta (key, value) VALUES ('attribution_since', ${NOW})`,
];

/** Where one browser came from, as the cookie keeps it. */
export interface Touch {
  channel: string;
  guessed: boolean;
  link: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  src: string | null;
  ref: string | null;
  landing: string | null;
  app: string | null;
  /** First seen, seconds since 1970. */
  at: number;
}

// ── reading a visit ────────────────────────────────────────────────────────────────────────────────────────────────

/** A tag as stored: lower case, letters, digits and a few signs, at most 80 characters. */
export function tag(v: unknown, max = 80): string | null {
  if (typeof v !== "string") return null;
  const t = v.toLowerCase().replace(/[^a-z0-9._~+@: -]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
  return t || null;
}
/** A host as stored: lower case, without "www.". */
export function hostTag(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.toLowerCase().replace(/^www\./, "").slice(0, 100);
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(t) ? t : null;
}
/** A path as stored: the path alone (a query can carry anything, a reset token included), at most 120 characters. */
export function pathTag(v: unknown): string | null {
  if (typeof v !== "string" || !v.startsWith("/")) return null;
  const t = v.split(/[?#]/)[0].replace(/[^A-Za-z0-9/._~-]/g, "").slice(0, 120);
  return t || "/";
}
const codeTag = (v: unknown): string | null => (typeof v === "string" && CODE_RE.test(v.toLowerCase()) ? v.toLowerCase() : null);

/** Referring hosts and the network each one stands for: the host itself or any host under it. */
const REF_HOSTS: [string, string][] = [
  ["instagram.com", "instagram"], ["ig.me", "instagram"],
  ["tiktok.com", "tiktok"], ["tiktokv.com", "tiktok"], ["tiktokcdn.com", "tiktok"],
  ["t.co", "x"], ["x.com", "x"], ["twitter.com", "x"],
  ["youtube.com", "youtube"], ["youtu.be", "youtube"], ["youtube-nocookie.com", "youtube"],
  ["facebook.com", "facebook"], ["fb.com", "facebook"], ["fb.me", "facebook"], ["messenger.com", "facebook"],
  ["threads.net", "threads"], ["threads.com", "threads"],
  ["reddit.com", "reddit"], ["redd.it", "reddit"],
  ["linkedin.com", "linkedin"], ["lnkd.in", "linkedin"],
  ["pinterest.com", "pinterest"], ["pin.it", "pinterest"],
  ["snapchat.com", "snapchat"],
  ["whatsapp.com", "whatsapp"], ["wa.me", "whatsapp"],
  ["t.me", "telegram"], ["telegram.org", "telegram"], ["telegram.me", "telegram"],
  ["discord.com", "discord"], ["discord.gg", "discord"],
  ["linktr.ee", "linktree"],
  ["chatgpt.com", "chatgpt"], ["chat.openai.com", "chatgpt"], ["openai.com", "chatgpt"],
  ["perplexity.ai", "perplexity"], ["claude.ai", "claude"], ["gemini.google.com", "gemini"], ["copilot.microsoft.com", "copilot"],
  ["producthunt.com", "producthunt"], ["news.ycombinator.com", "hn"], ["github.com", "github"],
  ["bing.com", "bing"], ["duckduckgo.com", "duckduckgo"], ["search.yahoo.com", "yahoo"], ["ecosia.org", "ecosia"], ["search.brave.com", "brave"],
  ["kleooai.com", "site"],
];
/** Hosts a sign-in or a payment comes back from: the person was already here, so they are not where a visit came from. */
const ROUND_TRIP_HOSTS = ["accounts.google.com", "accounts.youtube.com", "appleid.apple.com", "login.microsoftonline.com", "login.live.com",
  "checkout.stripe.com", "billing.stripe.com", "pay.stripe.com", "js.stripe.com", "hooks.stripe.com", "paypal.com", "challenges.cloudflare.com"];

const under = (host: string, base: string) => host === base || host.endsWith(`.${base}`);

/** The network a referring host stands for, "other" for one Kleo does not know. */
export function channelOfHost(host: string): string {
  for (const [base, ch] of REF_HOSTS) if (under(host, base)) return ch;
  if (/(^|\.)google\.[a-z.]+$/.test(host)) return "google";
  return "other";
}

const SOURCE_NAMES: Record<string, string> = {
  ig: "instagram", insta: "instagram", instagram: "instagram",
  tt: "tiktok", tiktok: "tiktok", "tik-tok": "tiktok", musically: "tiktok",
  x: "x", twitter: "x", tw: "x",
  yt: "youtube", youtube: "youtube", shorts: "youtube",
  fb: "facebook", facebook: "facebook", meta: "facebook",
  threads: "threads", reddit: "reddit", linkedin: "linkedin", pinterest: "pinterest", snapchat: "snapchat",
  whatsapp: "whatsapp", telegram: "telegram", discord: "discord", linktree: "linktree",
  chatgpt: "chatgpt", openai: "chatgpt", perplexity: "perplexity", claude: "claude", gemini: "gemini", copilot: "copilot",
  producthunt: "producthunt", ph: "producthunt", "product-hunt": "producthunt", hn: "hn", hackernews: "hn", github: "github",
  google: "google", bing: "bing", duckduckgo: "duckduckgo",
  email: "email", newsletter: "email", mail: "email",
  dm: "dm", dms: "dm",
  site: "site", kleo: "site", kleooai: "site", web: "site", website: "site", mcp: "site",
};
/** The network a utm_source or ?src= names: a known name, a host, or "other". */
export function channelOfSource(source: string): string {
  const s = source.toLowerCase().trim().replace(/^www\./, "");
  if (SOURCE_NAMES[s]) return SOURCE_NAMES[s];
  const host = hostTag(s);
  if (host && host.includes(".")) return channelOfHost(host);
  return "other";
}

/** Every channel a touch can name. */
const KNOWN_CHANNELS = new Set<string>(["direct", "other", "google", "line", ...LINK_CHANNELS, ...REF_HOSTS.map(([, c]) => c), ...Object.values(SOURCE_NAMES)]);

/** In-app browsers and the app each one belongs to (Instagram first: its user agent can carry Facebook's tokens too). */
const IN_APP: [RegExp, string][] = [
  [/\bInstagram\b/i, "instagram"],
  [/musical_ly|BytedanceWebview|\bTikTok\b|trill_|aweme/i, "tiktok"],
  [/\bBarcelona\b/, "threads"],
  [/FBAN|FBAV|FB_IAB|FBIOS|FB4A/, "facebook"],
  [/\bTwitter(?:Android)?\b/i, "x"],
  [/\bSnapchat\b/i, "snapchat"],
  [/LinkedInApp/i, "linkedin"],
  [/\bPinterest\b/i, "pinterest"],
  [/\bLine\/\d/, "line"],
  [/\bDiscord\/\d/i, "discord"],
  [/com\.google\.ios\.youtube|\bYouTube\/\d/i, "youtube"],
];
/** The app whose in-app browser this is, or null for an ordinary browser. */
export function inAppOf(ua: string | null): string | null {
  if (!ua) return null;
  for (const [re, app] of IN_APP) if (re.test(ua)) return app;
  return null;
}

/** Robots, link previews and scripts: never counted, never tagged. An empty user agent is one too. */
export const BOT_UA = /bot\b|bot\/|bots\b|crawl|spider|slurp|facebookexternalhit|facebookcatalog|meta-externalagent|embedly|preview|validator|curl\/|wget|python|httpx|axios|node-fetch|undici|go-http|java\/|okhttp|headless|lighthouse|pagespeed|uptime|pingdom|scrapy|whatsapp\/|skypeuripreview|bytespider|ahrefs|semrush|petalbot|yandex|baidu|applebot|googleother|google-inspectiontool/i;
export const isBot = (ua: string | null): boolean => !ua || ua.length < 20 || BOT_UA.test(ua);

/** A browser that asked not to be tracked (Global Privacy Control or Do Not Track). */
export const privateBrowser = (request: Request): boolean =>
  request.headers.get("sec-gpc") === "1" || request.headers.get("dnt") === "1";

/** A page load of the browser itself (not a script, a picture, a prefetch or a fetch from the page). */
export function pageLoad(request: Request): boolean {
  if (request.method !== "GET") return false;
  const purpose = `${request.headers.get("sec-purpose") ?? ""} ${request.headers.get("purpose") ?? ""}`;
  if (/prefetch|prerender/i.test(purpose)) return false;
  const dest = request.headers.get("sec-fetch-dest");
  if (dest) return dest === "document";
  return /text\/html/i.test(request.headers.get("accept") ?? "");
}

export interface LinkRow { code: string; channel: string; label: string; target: string; archived_at?: string | null }

/** The utm tags a short link puts on its page. */
export const linkUtm = (link: Pick<LinkRow, "code" | "channel">) =>
  ({ utm_source: link.channel, utm_medium: link.channel === "dm" ? "dm" : "social", utm_campaign: link.code });

/** Where this visit came from: a short link, its tags, its referrer, or the in-app browser it was opened in. */
export function touchOf(request: Request, url: URL, link: LinkRow | null = null, now = Date.now()): Touch {
  const q = url.searchParams;
  const ua = request.headers.get("user-agent");
  const app = inAppOf(ua);
  let ref: string | null = null;
  try {
    const r = request.headers.get("referer");
    const host = r ? hostTag(new URL(r).hostname) : null;
    if (host && host !== hostTag(url.hostname) && !ROUND_TRIP_HOSTS.some((h) => under(host, h))) ref = host;
  } catch { /* no usable referrer */ }
  const utm = link ? linkUtm(link) : null;
  const t: Touch = {
    channel: "direct", guessed: false, link: link ? link.code : null,
    utmSource: tag(utm?.utm_source ?? q.get("utm_source")), utmMedium: tag(utm?.utm_medium ?? q.get("utm_medium")),
    utmCampaign: tag(utm?.utm_campaign ?? q.get("utm_campaign")), utmContent: tag(link ? null : q.get("utm_content")),
    src: tag(link ? null : q.get("src") ?? q.get("ref")), ref, landing: pathTag(link ? link.target : url.pathname), app, at: Math.floor(now / 1000),
  };
  // A page opened from a short link's tags without the link itself (cookie lost on the way, or the person moved from
  // Instagram's browser to Safari with the address): the campaign names the code.
  if (!t.link && t.utmMedium && /^(social|dm)$/.test(t.utmMedium)) t.link = codeTag(t.utmCampaign);
  const source = t.utmSource ?? t.src;
  if (link) t.channel = link.channel;
  else if (source) t.channel = channelOfSource(source);
  else if (ref) t.channel = channelOfHost(ref);
  else if (app) { t.channel = app; t.guessed = true; }
  return t;
}

// ── the cookie ─────────────────────────────────────────────────────────────────────────────────────────────────────

const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

export function touchCookie(t: Touch): string {
  const v = b64url(JSON.stringify({ c: t.channel, g: t.guessed ? 1 : 0, l: t.link, us: t.utmSource, um: t.utmMedium, uc: t.utmCampaign, ut: t.utmContent, s: t.src, r: t.ref, p: t.landing, a: t.app, t: t.at }));
  return `${SOURCE_COOKIE}=${v}; Path=/; Max-Age=${SOURCE_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}
export const clearTouchCookie = (): string => `${SOURCE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
export const hasTouchCookie = (request: Request): boolean => cookieValue(request.headers.get("cookie"), SOURCE_COOKIE) !== null;

/** The touch the browser's cookie holds, every field checked again (a cookie is whatever the browser sends). */
export function readTouch(request: Request): Touch | null {
  const raw = cookieValue(request.headers.get("cookie"), SOURCE_COOKIE);
  if (!raw || raw.length > 1500) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(unb64url(raw)); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const named = tag(o.c, 24);
  if (!named) return null;
  // A channel Kleo never writes is "other": a cookie is whatever the browser sends.
  const channel = KNOWN_CHANNELS.has(named) ? named : "other";
  const at = Number(o.t);
  return {
    channel, guessed: o.g === 1, link: codeTag(o.l), utmSource: tag(o.us), utmMedium: tag(o.um), utmCampaign: tag(o.uc), utmContent: tag(o.ut),
    src: tag(o.s), ref: hostTag(o.r), landing: pathTag(o.p), app: tag(o.a, 24), at: Number.isFinite(at) && at > 0 ? Math.floor(at) : 0,
  };
}

/** The Studio session cookie's name (session.ts): someone signed in already has an account. */
const SIGNED_IN = /(?:^|;\s*)__Host-kleo_studio=[^;]+/;

/**
 * The first visit of a browser to a page of the app: answers the cookie to set, or null when this visit is not a first
 * one (a cookie already, signed in, a robot, a private browser, not a page load). Counts it in first_visits on the side.
 */
export function firstVisit(env: StudioEnv, request: Request, url: URL, ctx: ExecutionContext, link: LinkRow | null = null): string | null {
  if (!link && !pageLoad(request)) return null;
  if (hasTouchCookie(request) || SIGNED_IN.test(request.headers.get("cookie") ?? "")) return null;
  if (isBot(request.headers.get("user-agent")) || privateBrowser(request)) return null;
  const t = touchOf(request, url, link);
  ctx.waitUntil(countFirstVisit(env, t));
  return touchCookie(t);
}

async function countFirstVisit(env: StudioEnv, t: Touch): Promise<void> {
  try {
    await env.DB.prepare(`INSERT INTO first_visits (day, channel, link_code, guessed, n) VALUES (?, ?, ?, ?, 1)
        ON CONFLICT (day, channel, link_code, guessed) DO UPDATE SET n = n + 1`)
      .bind(new Date(t.at * 1000).toISOString().slice(0, 10), t.channel, t.link ?? "", t.guessed ? 1 : 0).run();
  } catch (e) {
    console.error("studio first visit", e instanceof Error ? e.message : e);
  }
}

// ── short links ────────────────────────────────────────────────────────────────────────────────────────────────────

export async function getLink(env: StudioEnv, code: string): Promise<LinkRow | null> {
  const c = codeTag(code);
  if (!c) return null;
  return env.DB.prepare("SELECT code, channel, label, target, archived_at FROM short_links WHERE code = ?").bind(c).first<LinkRow>();
}

/** The page a short link opens, with its utm tags (its own query kept). */
export function linkDestination(link: LinkRow, origin: string): string {
  const to = new URL(link.target || "/", origin);
  if (to.origin !== origin) return `${origin}/`;
  for (const [k, v] of Object.entries(linkUtm(link))) to.searchParams.set(k, v);
  return to.pathname + to.search;
}

/**
 * /r/<code>: counts the click (people only), tags a first visit, and sends the browser to the link's page. An unknown
 * code opens the app's home. An archived link still works: a post keeps its link for ever.
 */
export async function shortLink(env: StudioEnv, request: Request, url: URL, code: string, ctx: ExecutionContext): Promise<Response> {
  const headers = new Headers({ "cache-control": "no-store", "x-robots-tag": "noindex" });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers });
  const link = await getLink(env, code).catch(() => null);
  if (!link) { headers.set("location", "/"); return new Response(null, { status: 302, headers }); }
  headers.set("location", linkDestination(link, url.origin));
  const ua = request.headers.get("user-agent");
  if (request.method === "GET" && !isBot(ua) && !/prefetch|prerender/i.test(`${request.headers.get("sec-purpose") ?? ""} ${request.headers.get("purpose") ?? ""}`)) {
    ctx.waitUntil(env.DB.prepare(`INSERT INTO short_link_clicks (code, day, clicks) VALUES (?, ?, 1) ON CONFLICT (code, day) DO UPDATE SET clicks = clicks + 1`)
      .bind(link.code, new Date().toISOString().slice(0, 10)).run().catch((e) => console.error("studio link click", e instanceof Error ? e.message : e)));
    const cookie = firstVisit(env, request, url, ctx, link);
    if (cookie) headers.append("set-cookie", cookie);
  }
  return new Response(null, { status: 302, headers });
}

// ── the account's row ──────────────────────────────────────────────────────────────────────────────────────────────

/** What a sign-up request knows about where the browser came from. */
export interface Arrival { touch: Touch | null; private: boolean; app: string | null; hadCookie: boolean }
export const arrivalOf = (request: Request): Arrival => ({
  touch: readTouch(request), private: privateBrowser(request), app: inAppOf(request.headers.get("user-agent")), hadCookie: hasTouchCookie(request),
});

/**
 * Writes the new account's one row; never throws (an account is never refused over this). With no cookie: a guess from
 * the in-app browser the account was opened in, or "untracked". A link code is kept only when the link exists.
 */
export async function recordAttribution(env: StudioEnv, userId: string, a: Arrival | null | undefined): Promise<void> {
  try {
    let t = a?.touch ?? null;
    if (!t && a && !a.private && a.app) t = { ...EMPTY, channel: a.app, guessed: true, app: a.app };
    if (!t) t = { ...EMPTY, channel: "untracked", app: a?.app ?? null };
    await env.DB.prepare(`INSERT OR IGNORE INTO user_attribution (user_id, channel, guessed, link_code, utm_source, utm_medium, utm_campaign, utm_content,
        src, ref_host, landing, in_app, first_seen_at)
      VALUES (?1, ?2, ?3, (SELECT code FROM short_links WHERE code = ?4), ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`)
      .bind(userId, t.channel, t.guessed ? 1 : 0, t.link, t.utmSource, t.utmMedium, t.utmCampaign, t.utmContent, t.src, t.ref, t.landing, t.app,
        t.at ? new Date(t.at * 1000).toISOString() : null).run();
  } catch (e) {
    console.error("studio attribution", e instanceof Error ? e.message : e);
  }
}
const EMPTY: Touch = { channel: "untracked", guessed: false, link: null, utmSource: null, utmMedium: null, utmCampaign: null, utmContent: null, src: null, ref: null, landing: null, app: null, at: 0 };
