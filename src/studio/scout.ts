/**
 * THE SCOUT (27 October 2026, the owner: "dobbiamo avere infinità di clienti"): Kleo finds new businesses for its outreach
 * (src/studio/outreach.ts) every day, on its own, without Claude.
 *
 * One web search at a time (Cloudflare's Web Search API through the AI binding, Ceramic, $0.25 per 1,000 searches,
 * billed to the account's AI Gateway credits), at most `scoutDaily` a UTC day spread evenly over it (up to 1,440, one a
 * minute; the owner asked for 240 and then 800 on 27 October), walking through every pairing of a kind of business (TikTok agency, UGC agency, …) and one of 323
 * cities of the US, Canada, the UK, Australia and New Zealand, then again with other wordings. Without a postal address
 * in the settings only the UK, Australian and New Zealand cities are searched: the US and Canada would only wait.
 * Searching pauses (the allowance kept) while 600 websites wait to be read, or while 1,000 businesses per mailbox wait for
 * their first e-mail: more finds than the mailboxes can write to would only grow old. Each new website it returns is
 * queued once (outreach_seen) and up to eight are checked per turn, Workers AI reading at most three a day per allowed
 * search (a guard on the Cloudflare bill):
 *  - its home page and its contact or about page are read like a visitor reads them;
 *  - a business address must be there as visible text, on the business's own domain (never a free mailbox, never one
 *    hidden from robots, never a mailto: alone), a role address (hello@, info@ …) preferred;
 *  - a site that says it refuses unsolicited messages or sales pitches is left alone, and so is one that never mentions
 *    video, social media, TikTok, Reels, UGC or content (no Workers AI spent on it);
 *  - Workers AI decides whether the business makes short-form or social video for clients (or sells online with video
 *    ads), whether it is small enough (under about 200 people), where it is, and writes the first line of the e-mail
 *    from what the site says.
 * What passes becomes a prospect with the page where the address was seen: "new" for the owner to approve, or
 * "approved" when the owner chose that. Everything else is remembered with its reason, so no site is read twice.
 */
import type { StudioEnv } from "./env.ts";
import { AI_MODEL, COUNTRIES, FREEMAIL, POSTAL_COUNTRIES, addProspects, goodOpener, hasPostal, meta, pageText, setMeta, type Settings } from "./outreach.ts";

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

/** The kinds of business, as a person would search for them. */
export const SEGMENTS = [
  "TikTok marketing agency", "UGC agency", "short form video agency", "social media video agency", "paid social creative agency",
  "TikTok Shop agency", "Instagram Reels agency", "social media content agency", "video ad creative studio", "influencer and UGC content studio",
  "video marketing agency", "content creation agency", "TikTok ads agency", "performance creative agency", "influencer marketing agency",
  "social media management agency", "YouTube Shorts agency", "ecommerce video agency", "creator marketing agency", "brand video production company",
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
  ["Fort Worth", "TX", "US"], ["El Paso", "TX", "US"], ["Plano", "TX", "US"], ["Frisco", "TX", "US"], ["Irving", "TX", "US"], ["Arlington", "TX", "US"],
  ["Corpus Christi", "TX", "US"], ["Lubbock", "TX", "US"], ["McAllen", "TX", "US"], ["The Woodlands", "TX", "US"], ["Albuquerque", "NM", "US"], ["Santa Fe", "NM", "US"],
  ["Tucson", "AZ", "US"], ["Mesa", "AZ", "US"], ["Tempe", "AZ", "US"], ["Chandler", "AZ", "US"], ["Fresno", "CA", "US"], ["Long Beach", "CA", "US"],
  ["Oakland", "CA", "US"], ["Irvine", "CA", "US"], ["Santa Monica", "CA", "US"], ["Pasadena", "CA", "US"], ["Newport Beach", "CA", "US"], ["Santa Barbara", "CA", "US"],
  ["Riverside", "CA", "US"], ["Bakersfield", "CA", "US"], ["Palm Springs", "CA", "US"], ["San Luis Obispo", "CA", "US"], ["Santa Cruz", "CA", "US"], ["Berkeley", "CA", "US"],
  ["Palo Alto", "CA", "US"], ["Burbank", "CA", "US"], ["Culver City", "CA", "US"], ["Hollywood", "CA", "US"], ["Honolulu", "HI", "US"], ["Anchorage", "AK", "US"],
  ["Spokane", "WA", "US"], ["Tacoma", "WA", "US"], ["Bellevue", "WA", "US"], ["Eugene", "OR", "US"], ["Bend", "OR", "US"], ["Reno", "NV", "US"],
  ["Henderson", "NV", "US"], ["Provo", "UT", "US"], ["Lehi", "UT", "US"], ["Colorado Springs", "CO", "US"], ["Boulder", "CO", "US"], ["Fort Collins", "CO", "US"],
  ["Bozeman", "MT", "US"], ["Missoula", "MT", "US"], ["Omaha", "NE", "US"], ["Lincoln", "NE", "US"], ["Wichita", "KS", "US"], ["Tulsa", "OK", "US"],
  ["Little Rock", "AR", "US"], ["Birmingham", "AL", "US"], ["Huntsville", "AL", "US"], ["Jackson", "MS", "US"], ["Baton Rouge", "LA", "US"], ["Knoxville", "TN", "US"],
  ["Chattanooga", "TN", "US"], ["Lexington", "KY", "US"], ["Dayton", "OH", "US"], ["Toledo", "OH", "US"], ["Akron", "OH", "US"], ["Grand Rapids", "MI", "US"],
  ["Ann Arbor", "MI", "US"], ["Madison", "WI", "US"], ["Des Moines", "IA", "US"], ["Saint Paul", "MN", "US"], ["Fargo", "ND", "US"], ["Sioux Falls", "SD", "US"],
  ["Buffalo", "NY", "US"], ["Rochester", "NY", "US"], ["Albany", "NY", "US"], ["Syracuse", "NY", "US"], ["Long Island", "NY", "US"], ["White Plains", "NY", "US"],
  ["Queens", "NY", "US"], ["Jersey City", "NJ", "US"], ["Newark", "NJ", "US"], ["Hoboken", "NJ", "US"], ["Princeton", "NJ", "US"], ["Stamford", "CT", "US"],
  ["Hartford", "CT", "US"], ["New Haven", "CT", "US"], ["Providence", "RI", "US"], ["Worcester", "MA", "US"], ["Cambridge", "MA", "US"], ["Portland", "ME", "US"],
  ["Burlington", "VT", "US"], ["Manchester", "NH", "US"], ["Wilmington", "DE", "US"], ["Arlington", "VA", "US"], ["Alexandria", "VA", "US"], ["Virginia Beach", "VA", "US"],
  ["Norfolk", "VA", "US"], ["Durham", "NC", "US"], ["Greensboro", "NC", "US"], ["Asheville", "NC", "US"], ["Wilmington", "NC", "US"], ["Charleston", "SC", "US"],
  ["Columbia", "SC", "US"], ["Greenville", "SC", "US"], ["Savannah", "GA", "US"], ["Augusta", "GA", "US"], ["St. Petersburg", "FL", "US"], ["West Palm Beach", "FL", "US"],
  ["Boca Raton", "FL", "US"], ["Naples", "FL", "US"], ["Sarasota", "FL", "US"], ["Fort Myers", "FL", "US"], ["Tallahassee", "FL", "US"], ["Gainesville", "FL", "US"],
  ["Pensacola", "FL", "US"], ["Miami Beach", "FL", "US"], ["Harrisburg", "PA", "US"], ["Allentown", "PA", "US"], ["Lancaster", "PA", "US"], ["Fort Wayne", "IN", "US"],
  ["Bloomington", "IN", "US"], ["Evansville", "IN", "US"], ["Springfield", "MO", "US"], ["Columbia", "MO", "US"],
  ["Toronto", "ON", "CA"], ["Vancouver", "BC", "CA"], ["Montreal", "QC", "CA"], ["Calgary", "AB", "CA"], ["Edmonton", "AB", "CA"], ["Ottawa", "ON", "CA"],
  ["Winnipeg", "MB", "CA"], ["Halifax", "NS", "CA"], ["Victoria", "BC", "CA"], ["Mississauga", "ON", "CA"], ["Hamilton", "ON", "CA"], ["Kelowna", "BC", "CA"],
  ["Quebec City", "QC", "CA"], ["Laval", "QC", "CA"], ["Gatineau", "QC", "CA"], ["London", "ON", "CA"], ["Kitchener", "ON", "CA"], ["Waterloo", "ON", "CA"],
  ["Markham", "ON", "CA"], ["Vaughan", "ON", "CA"], ["Oakville", "ON", "CA"], ["Burlington", "ON", "CA"], ["Barrie", "ON", "CA"], ["Guelph", "ON", "CA"],
  ["Kingston", "ON", "CA"], ["Windsor", "ON", "CA"], ["Saskatoon", "SK", "CA"], ["Regina", "SK", "CA"], ["Surrey", "BC", "CA"], ["Burnaby", "BC", "CA"],
  ["Richmond", "BC", "CA"], ["Abbotsford", "BC", "CA"], ["Nanaimo", "BC", "CA"], ["Kamloops", "BC", "CA"], ["Whistler", "BC", "CA"], ["Red Deer", "AB", "CA"],
  ["Lethbridge", "AB", "CA"], ["St. John's", "NL", "CA"], ["Moncton", "NB", "CA"], ["Fredericton", "NB", "CA"], ["Charlottetown", "PE", "CA"],
  ["London", "", "GB"], ["Manchester", "", "GB"], ["Birmingham", "", "GB"], ["Leeds", "", "GB"], ["Glasgow", "", "GB"], ["Edinburgh", "", "GB"],
  ["Bristol", "", "GB"], ["Liverpool", "", "GB"], ["Newcastle", "", "GB"], ["Sheffield", "", "GB"], ["Nottingham", "", "GB"], ["Brighton", "", "GB"],
  ["Cardiff", "", "GB"], ["Belfast", "", "GB"], ["Leicester", "", "GB"], ["Southampton", "", "GB"],
  ["Oxford", "", "GB"], ["Cambridge", "", "GB"], ["Reading", "", "GB"], ["Milton Keynes", "", "GB"], ["Bournemouth", "", "GB"], ["Portsmouth", "", "GB"],
  ["Plymouth", "", "GB"], ["Exeter", "", "GB"], ["Bath", "", "GB"], ["York", "", "GB"], ["Hull", "", "GB"], ["Bradford", "", "GB"],
  ["Coventry", "", "GB"], ["Derby", "", "GB"], ["Stoke-on-Trent", "", "GB"], ["Wolverhampton", "", "GB"], ["Norwich", "", "GB"], ["Ipswich", "", "GB"],
  ["Swansea", "", "GB"], ["Aberdeen", "", "GB"], ["Dundee", "", "GB"], ["Inverness", "", "GB"], ["Middlesbrough", "", "GB"], ["Sunderland", "", "GB"],
  ["Preston", "", "GB"], ["Blackpool", "", "GB"], ["Bolton", "", "GB"], ["Warrington", "", "GB"], ["Chester", "", "GB"], ["Cheltenham", "", "GB"],
  ["Gloucester", "", "GB"], ["Swindon", "", "GB"], ["Northampton", "", "GB"], ["Peterborough", "", "GB"], ["Luton", "", "GB"], ["Watford", "", "GB"],
  ["Guildford", "", "GB"], ["Canterbury", "", "GB"], ["Maidstone", "", "GB"], ["Chelmsford", "", "GB"], ["Colchester", "", "GB"], ["Southend-on-Sea", "", "GB"],
  ["Shoreditch", "", "GB"], ["Harrogate", "", "GB"], ["Lincoln", "", "GB"], ["Huddersfield", "", "GB"], ["Wakefield", "", "GB"], ["Derry", "", "GB"],
  ["Sydney", "NSW", "AU"], ["Melbourne", "VIC", "AU"], ["Brisbane", "QLD", "AU"], ["Perth", "WA", "AU"], ["Adelaide", "SA", "AU"], ["Gold Coast", "QLD", "AU"],
  ["Canberra", "ACT", "AU"], ["Newcastle NSW", "NSW", "AU"], ["Hobart", "TAS", "AU"], ["Sunshine Coast", "QLD", "AU"],
  ["Geelong", "VIC", "AU"], ["Wollongong", "NSW", "AU"], ["Townsville", "QLD", "AU"], ["Cairns", "QLD", "AU"], ["Toowoomba", "QLD", "AU"], ["Darwin", "NT", "AU"],
  ["Launceston", "TAS", "AU"], ["Ballarat", "VIC", "AU"], ["Bendigo", "VIC", "AU"], ["Albury", "NSW", "AU"], ["Byron Bay", "NSW", "AU"], ["Parramatta", "NSW", "AU"],
  ["Fremantle", "WA", "AU"], ["Mandurah", "WA", "AU"], ["Central Coast", "NSW", "AU"], ["Noosa", "QLD", "AU"],
  ["Auckland", "", "NZ"], ["Wellington", "", "NZ"], ["Christchurch", "", "NZ"], ["Hamilton NZ", "", "NZ"], ["Tauranga", "", "NZ"], ["Dunedin", "", "NZ"], ["Queenstown", "", "NZ"],
  ["Napier", "", "NZ"], ["Hastings", "", "NZ"], ["Nelson", "", "NZ"], ["Palmerston North", "", "NZ"], ["New Plymouth", "", "NZ"], ["Rotorua", "", "NZ"],
  ["Whangarei", "", "NZ"], ["Invercargill", "", "NZ"], ["Wanaka", "", "NZ"], ["Gisborne", "", "NZ"], ["Whanganui", "", "NZ"], ["Blenheim", "", "NZ"], ["Timaru", "", "NZ"],
];
/** The two walks: the countries whose law needs no postal address, and the US and Canada, searched once one is set. */
export const WALKS = {
  intl: PLACES.filter((p) => !POSTAL_COUNTRIES.includes(p[2])),
  na: PLACES.filter((p) => POSTAL_COUNTRIES.includes(p[2])),
};
/** The n-th search of an endless walk through these places: every kind in every city, then again with another wording. */
export function queryAt(n: number, places = PLACES): { q: string; city: string; region: string; country: string } {
  const per = SEGMENTS.length * places.length;
  const round = Math.floor(n / per), i = n % per;
  const [city, region, country] = places[Math.floor(i / SEGMENTS.length)];
  const seg = SEGMENTS[i % SEGMENTS.length];
  const wording = ["", " contact", " small", " independent", " boutique"][round % 5];
  const where = country === "GB" ? `${city} UK` : country === "NZ" ? `${city.replace(/ NZ$/, "")} New Zealand` : country === "AU" ? `${city.replace(/ NSW$/, "")} Australia` : country === "CA" ? `${city} Canada` : `${city} ${region}`;
  return { q: `${seg}${wording} ${where}`.replace(/\s+/g, " ").trim(), city: city.replace(/ (NZ|NSW)$/, ""), region, country };
}

/** Sites that are never a small agency's own (directories, networks, platforms, marketplaces, news). */
const NOT_A_BUSINESS = /(^|\.)(linkedin|facebook|instagram|tiktok|youtube|twitter|x|pinterest|reddit|medium|wikipedia|clutch|sortlist|designrush|goodfirms|upwork|fiverr|yelp|glassdoor|indeed|crunchbase|bark|thumbtack|agencyspotter|themanifest|digitalagencynetwork|webtonic|hubspot|semrush|forbes|businessinsider|nytimes|google|apple|amazon|shopify|wix|squarespace|wordpress|godaddy|behance|dribbble|vimeo|trustpilot|g2|capterra|yellowpages|hellodarwin|expertise|topagencies|agencyvista|sprout|hootsuite|later|canva|adobe|substack|eventbrite|meetup|gov|edu)\.[a-z.]+$/i;
const ROLE = /^(hello|hi|hey|info|contact|studio|team|work|projects|newbusiness|new\.business|newbiz|business|enquiries|inquiries|enquiry|inquiry|sales|start|talk|letstalk|create|office|admin|general|connect|brands?|welcome|(the)?crew|growth|partners|partnerships|collabs?|bookings?|production|marketing|agency)@/i;
const SKIP_ADDR = /^(no-?reply|donotreply|privacy|careers|jobs|hiring|recruit|hr|legal|abuse|postmaster|webmaster|unsubscribe|billing|accounts|invoices|press|media|support|help|dpo|gdpr|example|name|your|email|user)@/i;
/** A site that never says any of these does no video or social media work: not worth Workers AI's reading. */
const VIDEO_WORK = /\b(video|videos|tiktok|reels?|ugc|shorts|short-form|social media|socials|paid social|influencers?|creators?|content creat\w*|branded content|social content)\b/i;
/**
 * Whether a UK site shows it is a company: a name followed by Ltd, Limited, LLP or plc ("OK COOL LTD", not "limited
 * budgets"), a company number, "registered in England", Companies House.
 */
const UK_SUFFIX = /[A-Z][A-Za-z0-9&.'’-]*\s+(?:Ltd\.?|LTD|Limited|LIMITED|LLP|PLC|plc)\b(\s+[A-Za-z]+)?/g;
const NOT_A_SUFFIX = /^\s+(budgets?|time|editions?|offers?|availability|spaces?|places?|numbers?|stock|runs?|resources?|access|capacity)$/i;
const UK_REGISTERED = /\bcompany (no\.?|number|reg(istration)?( no\.?| number)?)\s*[:.]?\s*[A-Z]{0,2}\d{6,8}\b|\b(registered|incorporated) in (england|scotland|wales|northern ireland)\b|\bcompanies house\b/i;
export function ukCompany(text: string): boolean {
  for (const m of text.matchAll(UK_SUFFIX)) if (!NOT_A_SUFFIX.test(m[1] ?? "")) return true;
  return UK_REGISTERED.test(text);
}
/** A same-site privacy, terms or legal page (where a UK company names itself), or null. */
function legalPage(html: string, base: URL): string | null {
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
    if (!/privacy|terms|legal|imprint/i.test(`${m[1]} ${pageText(m[2])}`)) continue;
    try { const u = new URL(m[1], base); if (u.protocol === "https:" && registrable(u.hostname) === registrable(base.hostname)) return u.href.split("#")[0]; } catch { /* not a link */ }
  }
  return null;
}
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
/** Workers AI's country as a two-letter code: it says "UK" for Great Britain (seen live on 27 October), or a name. */
const COUNTRY_NAMES: Record<string, string> = {
  UK: "GB", GBR: "GB", "UNITED KINGDOM": "GB", "GREAT BRITAIN": "GB", ENGLAND: "GB", SCOTLAND: "GB", WALES: "GB", "NORTHERN IRELAND": "GB",
  USA: "US", "UNITED STATES": "US", "UNITED STATES OF AMERICA": "US", CAN: "CA", CANADA: "CA", AUS: "AU", AUSTRALIA: "AU", NZL: "NZ", "NEW ZEALAND": "NZ",
};
export const isoCountry = (c: unknown): string => { const s = String(c ?? "").trim().toUpperCase(); return COUNTRY_NAMES[s] ?? s; };

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
/** How many queued websites one turn reads at most, and for how long. */
const CHECKS_PER_TURN = 8, CHECK_BUDGET_MS = 30_000;
/** Searching waits while this many websites are queued, or this many businesses per mailbox wait for their first e-mail. */
const QUEUE_MAX = 600, WAITING_PER_MAILBOX = 1000;
/** Workers AI reads at most this many websites a day per search allowed (a guard on the Cloudflare bill). */
const JUDGES_PER_SEARCH = 3;

/**
 * The scout's turn (every minute while it is on): one search while the allowance so far today lasts (the day's searches
 * spread evenly over it) and nothing asks it to wait, then up to eight queued sites checked. Returns what it did, for
 * the tests and the logs.
 */
export async function scoutTick(env: StudioEnv, set: Settings, nowMs = Date.now(), deps: ScoutDeps = {}): Promise<{ searched: number; checked: number; added: number }> {
  const out = { searched: 0, checked: 0, added: 0 };
  if (!set.scoutOn) return out;
  const dayKey = `scout_day_${today(nowMs)}`;
  const done = Number((await meta(env, dayKey)) ?? 0);
  const minute = Math.floor((nowMs % 86_400_000) / 60_000);
  const allowed = Math.min(set.scoutDaily, Math.ceil((set.scoutDaily * (minute + 1)) / 1440));
  const postal = hasPostal(set);
  const pause = done < allowed ? await pauseReason(env, postal) : null;
  if (pause) await setMeta(env, "scout_paused", pause);
  else if (done < allowed) {
    await env.DB.prepare("DELETE FROM studio_meta WHERE key = 'scout_paused'").run();
    const a = Number((await meta(env, "scout_cursor_intl")) ?? 0), b = Number((await meta(env, "scout_cursor_na")) ?? 0);
    // With a postal address both walks run, each in proportion to its number of cities; without one, only the first.
    const walk = postal && b * WALKS.intl.length < a * WALKS.na.length ? "na" : "intl";
    const cursorKey = `scout_cursor_${walk}`, n = walk === "na" ? b : a;
    const q = queryAt(n, WALKS[walk]);
    await setMeta(env, cursorKey, String(n + 1));
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
      await setMeta(env, cursorKey, String(n));
      await setMeta(env, "scout_error", `${new Date(nowMs).toISOString()} ${(e as Error).message}`.slice(0, 300));
    }
  }
  const started = Date.now(), judges = set.scoutDaily * JUDGES_PER_SEARCH;
  const queued = (await env.DB.prepare("SELECT domain, url, hint FROM outreach_seen WHERE status = 'queued' ORDER BY at LIMIT ?").bind(CHECKS_PER_TURN)
    .all<{ domain: string; url: string; hint: string | null }>()).results ?? [];
  for (const site of queued) {
    // Today's Workers AI readings spent, or this turn long enough: the rest wait in the queue.
    if (Date.now() - started > CHECK_BUDGET_MS || Number((await meta(env, `scout_judged_${today(nowMs)}`)) ?? 0) >= judges) break;
    out.checked++;
    const result = await checkSite(env, set, site, nowMs, deps).catch((e) => `error: ${(e as Error).message}`.slice(0, 120));
    if (result === "added") out.added++;
    await env.DB.prepare(`UPDATE outreach_seen SET status = 'checked', result = ?, at = ${NOW} WHERE domain = ?`).bind(result, site.domain).run();
  }
  return out;
}

/** Why searching waits now (the allowance kept), or null: enough websites to read, or enough businesses to write to. */
async function pauseReason(env: StudioEnv, postal: boolean): Promise<string | null> {
  const count = async (sql: string, ...a: unknown[]) => Number((await env.DB.prepare(sql).bind(...a).first<{ n: number }>())?.n ?? 0);
  const queued = await count("SELECT COUNT(*) AS n FROM outreach_seen WHERE status = 'queued'");
  if (queued >= QUEUE_MAX) return `${queued} websites are waiting to be read`;
  const boxes = await count("SELECT COUNT(*) AS n FROM outreach_senders WHERE status = 'active'");
  const waiting = await count(`SELECT COUNT(*) AS n FROM outreach_prospects WHERE status IN ('new', 'approved') AND step = 0
    ${postal ? "" : `AND country NOT IN (${POSTAL_COUNTRIES.map(() => "?").join(", ")})`}`, ...(postal ? [] : POSTAL_COUNTRIES));
  if (waiting >= WAITING_PER_MAILBOX * Math.max(1, boxes)) return `${waiting} businesses already wait for their first e-mail; another mailbox would write to them sooner`;
  return null;
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
  if (!VIDEO_WORK.test(all)) return "no video or social media work on the site";
  let email: string | null = null, source = "";
  for (const p of pages) { const a = visibleAddresses(p.html, base.hostname)[0]; if (a && (!email || (ROLE.test(a) && !ROLE.test(email)))) { email = a; source = p.url; } }
  if (!email) return "no visible business address";
  const judgedKey = `scout_judged_${today(nowMs)}`;
  await setMeta(env, judgedKey, String(Number((await meta(env, judgedKey)) ?? 0) + 1));
  const v = await judge(env, site.domain, pages.map((p) => `[${p.url}]\n${pageText(decodeEntities(p.html)).slice(0, 3000)}`).join("\n\n"));
  if (!v) return "no verdict";
  if (!v.fit) return `not a fit: ${String(v.reason ?? "").slice(0, 80)}`;
  if (v.size === "200+") return "too big";
  let hint: { city?: string; region?: string; country?: string } = {};
  try { hint = JSON.parse(site.hint ?? "{}"); } catch { /* none */ }
  const tld = tldCountry(base.hostname);
  const country = isoCountry(v.country ?? tld ?? hint.country);
  if (!COUNTRIES.includes(country as (typeof COUNTRIES)[number])) return `country ${country || "unknown"}`;
  if (tld && tld !== country) return `country unclear (${tld} site, ${country} office)`;
  // Canada's privacy law treats a person's own address as personal information: role addresses only there.
  if (country === "CA" && !ROLE.test(email)) return "a person's address in Canada";
  // The UK's PECR wants consent before marketing e-mail to a sole trader or a partnership, not to a company: a person's
  // address only where the site shows a limited company (27 October 2026).
  if (country === "GB" && !ROLE.test(email) && !ukCompany(all)) {
    const legal = legalPage(home, base), page = legal ? await fetchPage(legal) : null;
    if (!page || !ukCompany(pageText(decodeEntities(page)))) return "a person's address at a UK business that may be a sole trader";
  }
  const opener = goodOpener(v.opener);
  const r = await addProspects(env, [{
    company: String(v.company || site.domain).slice(0, 120), website: `https://${base.hostname}`, email, email_source_url: source, country,
    state: v.region ?? (country === hint.country ? hint.region : null), city: v.city ?? (country === hint.country ? hint.city : null),
    type: TYPES.includes(String(v.type)) ? v.type : "creative-agency", size_hint: v.size ?? "unknown", email_kind: ROLE.test(email) ? "role" : "person",
    fit_reason: String(v.reason ?? "").slice(0, 300), evidence: String(v.reason ?? "").slice(0, 300), opener,
  }], `scout-${today(nowMs)}`, set.autoApprove ? "approved" : "new");
  return r.added ? "added" : `skipped: ${r.skipped[0]?.why ?? "?"}`;
}
