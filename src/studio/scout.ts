/**
 * THE SCOUT (27 October 2026, the owner: "dobbiamo avere infinità di clienti"): Kleo finds new businesses for its outreach
 * (src/studio/outreach.ts) every day, on its own, without Claude.
 *
 * One web search at a time (Cloudflare's Web Search API through the AI binding, Ceramic, $0.25 per 1,000 searches,
 * billed to the account's AI Gateway credits), at most `scoutDaily` a UTC day, walking through every pairing of a kind
 * of business (TikTok agency, UGC agency, …) and a city of the US, Canada, the UK, Australia and New Zealand. Each new
 * website it returns is queued once (outreach_seen) and checked a few per tick:
 *  - its home page and its contact or about page are read like a visitor reads them;
 *  - a business address must be there as visible text, on the business's own domain (never a free mailbox, never one
 *    hidden from robots, never a mailto: alone), a role address (hello@, info@ …) preferred;
 *  - a site that says it refuses unsolicited messages or sales pitches is left alone;
 *  - Workers AI decides whether the business makes short-form or social video for clients (or sells online with video
 *    ads), whether it is small enough (under about 200 people), where it is, and writes the first line of the e-mail
 *    from what the site says.
 * What passes becomes a prospect with the page where the address was seen: "new" for the owner to approve, or
 * "approved" when the owner chose that. Everything else is remembered with its reason, so no site is read twice.
 */
import type { StudioEnv } from "./env.ts";
import { AI_MODEL, COUNTRIES, FREEMAIL, addProspects, goodOpener, meta, pageText, setMeta, type Settings } from "./outreach.ts";

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

/** The kinds of business, as a person would search for them. */
export const SEGMENTS = [
  "TikTok marketing agency", "UGC agency", "short form video agency", "social media video agency", "paid social creative agency",
  "TikTok Shop agency", "Instagram Reels agency", "social media content agency", "video ad creative studio", "influencer and UGC content studio",
];
/** Cities (with their state or province) in the five countries the outreach may write to. */
export const PLACES: [string, string, string][] = [
  ["New York", "NY", "US"], ["Los Angeles", "CA", "US"], ["Chicago", "IL", "US"], ["Houston", "TX", "US"], ["Phoenix", "AZ", "US"], ["Philadelphia", "PA", "US"],
  ["San Antonio", "TX", "US"], ["San Diego", "CA", "US"], ["Dallas", "TX", "US"], ["Austin", "TX", "US"], ["Jacksonville", "FL", "US"], ["San Jose", "CA", "US"],
  ["Columbus", "OH", "US"], ["Charlotte", "NC", "US"], ["Indianapolis", "IN", "US"], ["San Francisco", "CA", "US"], ["Seattle", "WA", "US"], ["Denver", "CO", "US"],
  ["Nashville", "TN", "US"], ["Washington", "DC", "US"], ["Boston", "MA", "US"], ["Las Vegas", "NV", "US"], ["Portland", "OR", "US"], ["Detroit", "MI", "US"],
  ["Atlanta", "GA", "US"], ["Miami", "FL", "US"], ["Minneapolis", "MN", "US"], ["Tampa", "FL", "US"], ["Orlando", "FL", "US"], ["Salt Lake City", "UT", "US"],
  ["Raleigh", "NC", "US"], ["Kansas City", "MO", "US"], ["St. Louis", "MO", "US"], ["Pittsburgh", "PA", "US"], ["Cincinnati", "OH", "US"], ["Cleveland", "OH", "US"],
  ["Milwaukee", "WI", "US"], ["Sacramento", "CA", "US"], ["Scottsdale", "AZ", "US"], ["Boise", "ID", "US"], ["Richmond", "VA", "US"], ["Baltimore", "MD", "US"],
  ["New Orleans", "LA", "US"], ["Oklahoma City", "OK", "US"], ["Louisville", "KY", "US"], ["Memphis", "TN", "US"], ["Brooklyn", "NY", "US"], ["Fort Lauderdale", "FL", "US"],
  ["Toronto", "ON", "CA"], ["Vancouver", "BC", "CA"], ["Montreal", "QC", "CA"], ["Calgary", "AB", "CA"], ["Edmonton", "AB", "CA"], ["Ottawa", "ON", "CA"],
  ["Winnipeg", "MB", "CA"], ["Halifax", "NS", "CA"], ["Victoria", "BC", "CA"], ["Mississauga", "ON", "CA"], ["Hamilton", "ON", "CA"], ["Kelowna", "BC", "CA"],
  ["London", "", "GB"], ["Manchester", "", "GB"], ["Birmingham", "", "GB"], ["Leeds", "", "GB"], ["Glasgow", "", "GB"], ["Edinburgh", "", "GB"],
  ["Bristol", "", "GB"], ["Liverpool", "", "GB"], ["Newcastle", "", "GB"], ["Sheffield", "", "GB"], ["Nottingham", "", "GB"], ["Brighton", "", "GB"],
  ["Cardiff", "", "GB"], ["Belfast", "", "GB"], ["Leicester", "", "GB"], ["Southampton", "", "GB"],
  ["Sydney", "NSW", "AU"], ["Melbourne", "VIC", "AU"], ["Brisbane", "QLD", "AU"], ["Perth", "WA", "AU"], ["Adelaide", "SA", "AU"], ["Gold Coast", "QLD", "AU"],
  ["Canberra", "ACT", "AU"], ["Newcastle NSW", "NSW", "AU"], ["Hobart", "TAS", "AU"], ["Sunshine Coast", "QLD", "AU"],
  ["Auckland", "", "NZ"], ["Wellington", "", "NZ"], ["Christchurch", "", "NZ"], ["Hamilton NZ", "", "NZ"], ["Tauranga", "", "NZ"], ["Dunedin", "", "NZ"], ["Queenstown", "", "NZ"],
];
/** The n-th search of the endless walk: every kind in every city, then again with another wording. */
export function queryAt(n: number): { q: string; city: string; region: string; country: string } {
  const per = SEGMENTS.length * PLACES.length;
  const round = Math.floor(n / per), i = n % per;
  const [city, region, country] = PLACES[Math.floor(i / SEGMENTS.length)];
  const seg = SEGMENTS[i % SEGMENTS.length];
  const wording = ["", " contact", " small", " independent", " boutique"][round % 5];
  const where = country === "GB" ? `${city} UK` : country === "NZ" ? `${city.replace(/ NZ$/, "")} New Zealand` : country === "AU" ? `${city.replace(/ NSW$/, "")} Australia` : country === "CA" ? `${city} Canada` : `${city} ${region}`;
  return { q: `${seg}${wording} ${where}`.replace(/\s+/g, " ").trim(), city: city.replace(/ (NZ|NSW)$/, ""), region, country };
}

/** Sites that are never a small agency's own (directories, networks, platforms, marketplaces, news). */
const NOT_A_BUSINESS = /(^|\.)(linkedin|facebook|instagram|tiktok|youtube|twitter|x|pinterest|reddit|medium|wikipedia|clutch|sortlist|designrush|goodfirms|upwork|fiverr|yelp|glassdoor|indeed|crunchbase|bark|thumbtack|agencyspotter|themanifest|digitalagencynetwork|webtonic|hubspot|semrush|forbes|businessinsider|nytimes|google|apple|amazon|shopify|wix|squarespace|wordpress|godaddy|behance|dribbble|vimeo|trustpilot|g2|capterra|yellowpages|hellodarwin|expertise|topagencies|agencyvista|sprout|hootsuite|later|canva|adobe|substack|eventbrite|meetup|gov|edu)\.[a-z.]+$/i;
const ROLE = /^(hello|hi|hey|info|contact|studio|team|work|projects|newbusiness|new\.business|business|enquiries|inquiries|enquiry|inquiry|sales|start|talk|create|office|admin|general|connect)@/i;
const SKIP_ADDR = /^(no-?reply|donotreply|privacy|careers|jobs|hiring|recruit|hr|legal|abuse|postmaster|webmaster|unsubscribe|billing|accounts|invoices|press|media|support|help|dpo|gdpr|example|name|your|email|user)@/i;
const REFUSE = /\b(no unsolicited|unsolicited (e-?mails?|messages?|solicitations?|offers?|pitches) (are|will) not|we do not accept (unsolicited|sales)|no (sales )?solicitations|no vendor (pitches|solicitations|enquiries|inquiries)|please do not (send|contact).{0,40}(sales|solicit|pitch|vendor))/i;

const registrable = (host: string): string => {
  const h = host.toLowerCase().replace(/^www\./, "");
  const parts = h.split(".");
  const two = /\.(co|com|org|net|ac|gov)\.(uk|au|nz)$/.test(h);
  return parts.slice(two ? -3 : -2).join(".");
};
const decodeEntities = (s: string): string => s.replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&commat;/gi, "@").replace(/&period;/gi, ".").replace(/&amp;/g, "&");

/** The business addresses a reader of the page can see, on the site's own domain, the role ones first. */
export function visibleAddresses(html: string, siteHost: string): string[] {
  const text = pageText(decodeEntities(html));
  const site = registrable(siteHost);
  const found = new Set((text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []).map((e) => e.toLowerCase().replace(/[.]+$/, "")));
  const own = [...found].filter((e) => !FREEMAIL.test(e) && !SKIP_ADDR.test(e) && registrable(e.split("@")[1]) === site && !/\.(png|jpe?g|gif|svg|webp)$/.test(e));
  return own.sort((a, b) => Number(ROLE.test(b)) - Number(ROLE.test(a)));
}

/** A same-site page whose link says contact or about (absolute https URL), at most two. */
export function contactPages(html: string, base: URL): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const label = `${m[1]} ${pageText(m[2])}`.toLowerCase();
    if (!/contact|get in touch|talk to us|work with us|about|let'?s talk|enquir|inquir/.test(label)) continue;
    try {
      const u = new URL(m[1], base);
      if (u.protocol === "https:" && registrable(u.hostname) === registrable(base.hostname) && !out.includes(u.href) && u.href !== base.href) out.push(u.href.split("#")[0]);
    } catch { /* not a link */ }
    if (out.length >= 2) break;
  }
  return out;
}

const TLD_COUNTRY: [RegExp, string][] = [[/\.(co\.uk|uk)$/, "GB"], [/\.(com\.au|au)$/, "AU"], [/\.(co\.nz|nz)$/, "NZ"], [/\.ca$/, "CA"], [/\.us$/, "US"]];
const tldCountry = (host: string): string | null => TLD_COUNTRY.find(([re]) => re.test(host))?.[1] ?? null;

export interface ScoutDeps {
  search?: (q: string) => Promise<{ url: string; title?: string }[]>;
  fetchPage?: (url: string) => Promise<string | null>;
}

async function defaultSearch(env: StudioEnv, q: string): Promise<{ url: string; title?: string }[]> {
  const ai = env.AI as unknown as { websearch?(o: Record<string, unknown>): Promise<Response> } | undefined;
  if (!ai?.websearch) throw new Error("Web Search is not available on this Worker's AI binding.");
  const r = await ai.websearch({ gatewayId: "default", query: q, provider: "ceramic", limit: 10 });
  const j = await r.json() as { items?: { url: string; title?: string }[]; ok?: boolean; error?: { message?: string } };
  if (!r.ok || j.ok === false) throw new Error(j.error?.message ?? `Web Search answered ${r.status}`);
  return j.items ?? [];
}
async function defaultFetch(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; KleoBot/1.0; +https://kleooai.com)", accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(9000) });
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("html")) return null;
    return (await r.text()).slice(0, 400_000);
  } catch { return null; }
}

const today = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The scout's turn (every 5 minutes while it is on): one search while today's allowance lasts, then up to three queued
 * sites checked. Returns what it did, for the tests and the logs.
 */
export async function scoutTick(env: StudioEnv, set: Settings, nowMs = Date.now(), deps: ScoutDeps = {}): Promise<{ searched: number; checked: number; added: number }> {
  const out = { searched: 0, checked: 0, added: 0 };
  if (!set.scoutOn) return out;
  const dayKey = `scout_day_${today(nowMs)}`;
  const done = Number((await meta(env, dayKey)) ?? 0);
  if (done < set.scoutDaily) {
    const n = Number((await meta(env, "scout_cursor")) ?? 0);
    const q = queryAt(n);
    await setMeta(env, "scout_cursor", String(n + 1));
    await setMeta(env, dayKey, String(done + 1));
    try {
      const items = await (deps.search ? deps.search(q.q) : defaultSearch(env, q.q));
      out.searched = 1;
      await env.DB.prepare("DELETE FROM studio_meta WHERE key = 'scout_error'").run();
      for (const it of items) {
        let host: string;
        try { const u = new URL(it.url); if (u.protocol !== "https:" && u.protocol !== "http:") continue; host = u.hostname.toLowerCase(); } catch { continue; }
        const domain = registrable(host);
        if (NOT_A_BUSINESS.test(domain)) continue;
        if (await env.DB.prepare("SELECT 1 AS one FROM outreach_prospects WHERE domain = ? OR domain LIKE ?").bind(domain, `%.${domain}`).first()) continue;
        await env.DB.prepare(`INSERT OR IGNORE INTO outreach_seen (domain, status, url, hint, at) VALUES (?, 'queued', ?, ?, ${NOW})`)
          .bind(domain, `https://${host}/`, JSON.stringify({ city: q.city, region: q.region, country: q.country, title: it.title ?? null })).run();
      }
    } catch (e) {
      // Out of AI Gateway credits, or Web Search down: today's allowance is not spent on errors.
      await setMeta(env, dayKey, String(done));
      await setMeta(env, "scout_cursor", String(n));
      await setMeta(env, "scout_error", `${new Date(nowMs).toISOString()} ${(e as Error).message}`.slice(0, 300));
    }
  }
  const queued = (await env.DB.prepare("SELECT domain, url, hint FROM outreach_seen WHERE status = 'queued' ORDER BY at LIMIT 3").all<{ domain: string; url: string; hint: string | null }>()).results ?? [];
  for (const site of queued) {
    out.checked++;
    const result = await checkSite(env, set, site, nowMs, deps).catch((e) => `error: ${(e as Error).message}`.slice(0, 120));
    if (result === "added") out.added++;
    await env.DB.prepare(`UPDATE outreach_seen SET status = 'checked', result = ?, at = ${NOW} WHERE domain = ?`).bind(result, site.domain).run();
  }
  return out;
}

interface Verdict { fit?: boolean; company?: string; type?: string; size?: string; country?: string | null; region?: string | null; city?: string | null; reason?: string; opener?: string }
const TYPES = ["social-media-agency", "short-form-video-agency", "ugc-agency", "paid-social-creative", "video-production", "ecommerce-creative", "tiktok-shop-agency", "creative-agency"];

async function judge(env: StudioEnv, domain: string, text: string): Promise<Verdict | null> {
  if (!env.AI) return null;
  const r = await env.AI.run(AI_MODEL as never, {
    messages: [
      { role: "system", content: `You qualify businesses for a short sales e-mail from Kleo, an AI app that makes vertical videos (TikTok, Reels, Shorts) from a prompt or a photo. Read the website text and answer only with JSON:
{"fit": true|false, "company": "the business's name", "type": one of ${JSON.stringify(TYPES)}, "size": "solo"|"2-10"|"11-50"|"51-200"|"200+"|"unknown", "country": two-letter ISO code of the business's office or null, "region": state or province code (US, CA, AU) or null, "city": city or null, "reason": "max 20 words: what on the site makes AI short-form video relevant", "opener": "one sentence, max 25 words, starting with Saw or Noticed, about something specific and real on the site (a service, a niche, a named client or project); no flattery, no exclamation marks"}
fit is true only if the business itself makes or manages social media video, short-form video, UGC or video ads for clients, or is a TikTok Shop / e-commerce creative agency. fit is false for SEO-only, web-design-only, PR-only, software companies, marketplaces, directories, job boards, news, schools, freelancers' portfolios without a business, adult, gambling, crypto, cannabis or political work. Use only what the text says.` },
      { role: "user", content: `Website: ${domain}\n\n${text.slice(0, 6000)}` },
    ],
    max_tokens: 300, temperature: 0,
  } as never) as { response?: unknown };
  const txt = typeof r?.response === "string" ? r.response : JSON.stringify(r?.response ?? "");
  try { return JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1)) as Verdict; } catch { return null; }
}

async function checkSite(env: StudioEnv, set: Settings, site: { domain: string; url: string; hint: string | null }, nowMs: number, deps: ScoutDeps): Promise<string> {
  const fetchPage = deps.fetchPage ?? defaultFetch;
  const home = await fetchPage(site.url);
  if (!home) return "did not load";
  const base = new URL(site.url);
  const pages: { url: string; html: string }[] = [{ url: site.url, html: home }];
  for (const u of contactPages(home, base)) { const h = await fetchPage(u); if (h) pages.push({ url: u, html: h }); }
  const all = pages.map((p) => pageText(decodeEntities(p.html))).join("\n");
  if (REFUSE.test(all)) return "refuses unsolicited messages";
  let email: string | null = null, source = "";
  for (const p of pages) { const a = visibleAddresses(p.html, base.hostname)[0]; if (a && (!email || (ROLE.test(a) && !ROLE.test(email)))) { email = a; source = p.url; } }
  if (!email) return "no visible business address";
  const v = await judge(env, site.domain, pages.map((p) => `[${p.url}]\n${pageText(decodeEntities(p.html)).slice(0, 3000)}`).join("\n\n"));
  if (!v) return "no verdict";
  if (!v.fit) return `not a fit: ${String(v.reason ?? "").slice(0, 80)}`;
  if (v.size === "200+") return "too big";
  let hint: { city?: string; region?: string; country?: string } = {};
  try { hint = JSON.parse(site.hint ?? "{}"); } catch { /* none */ }
  const tld = tldCountry(base.hostname);
  const country = String(v.country ?? tld ?? hint.country ?? "").toUpperCase();
  if (!COUNTRIES.includes(country as (typeof COUNTRIES)[number])) return `country ${country || "unknown"}`;
  if (tld && tld !== country) return `country unclear (${tld} site, ${country} office)`;
  // Canada's privacy law treats a person's own address as personal information: role addresses only there.
  if (country === "CA" && !ROLE.test(email)) return "a person's address in Canada";
  const opener = goodOpener(v.opener);
  const r = await addProspects(env, [{
    company: String(v.company || site.domain).slice(0, 120), website: `https://${base.hostname}`, email, email_source_url: source, country,
    state: v.region ?? (country === hint.country ? hint.region : null), city: v.city ?? (country === hint.country ? hint.city : null),
    type: TYPES.includes(String(v.type)) ? v.type : "creative-agency", size_hint: v.size ?? "unknown", email_kind: ROLE.test(email) ? "role" : "person",
    fit_reason: String(v.reason ?? "").slice(0, 300), evidence: String(v.reason ?? "").slice(0, 300), opener,
  }], `scout-${today(nowMs)}`, set.autoApprove ? "approved" : "new");
  return r.added ? "added" : `skipped: ${r.skipped[0]?.why ?? "?"}`;
}
