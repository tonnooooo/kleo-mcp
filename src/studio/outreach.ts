/**
 * KLEO STUDIO — OUTREACH (27 October 2026, the owner: "vorrei che la mia gmail facesse questa cosa ogni notte … sparsa
 * senza destare troppo sospetto per spam o ban … in automatico, senza l'uso di claude"; then "finiscilo, perfezionalo,
 * dobbiamo avere infinità di clienti").
 *
 * Kleo writes, on its own, a short personal first e-mail to businesses whose work is short-form video (social media,
 * UGC and paid-social agencies, TikTok Shop and e-commerce creative studios), and two follow-ups in the same thread when
 * nobody answers. It reads the replies itself, stops at the first one, answers a "yes" by itself with a personal link
 * whose sign-up gets free trial credits, tells the owner about every real answer, and never writes again to anyone who
 * said no or whose address bounced. The scout (src/studio/scout.ts) finds new businesses every day.
 *
 * THE RULES IT KEEPS (New Zealand's Unsolicited Electronic Messages Act 2007, CAN-SPAM, CASL, the UK's PECR, Australia's
 * Spam Act): only addresses a business publishes on its own website for business contact, relevant to its work (the
 * "deemed / inferred / implied consent" those laws allow), each with the page where it was seen (source_url); never a
 * bought list; the sender named with a way to reach it, a working unsubscribe link and "reply no", honoured
 * at once. Prospects wait for the owner's approval unless the owner chose to approve the scout's finds automatically.
 * Countries: US, CA, GB, AU, NZ only.
 *
 * HOW IT SENDS: from real mailboxes through SMTP (src/studio/mailbox.ts) on domains of their own — never Cloudflare Email
 * Sending (transactional mail only) and never kleooai.com or Gmail. As many mailboxes as the owner adds (outreach_senders),
 * each with its own warm-up (5 a day the first three days, then 10, 15, 25, up to its maximum), one e-mail every 7 to 14
 * minutes at most, only Monday to Friday, 9:00 to 16:30 where the business is. A prospect keeps the mailbox that wrote
 * to it first, so its thread stays in one place.
 *
 * IT LEARNS: the first e-mail has a few versions (VARIANTS); each new prospect gets one picked by Thompson sampling on
 * the replies so far, so the version that gets answered more is sent more.
 *
 * POSTAL ADDRESS: CAN-SPAM (US) and CASL (Canada) want a postal address in every commercial e-mail; New Zealand's, the
 * UK's and Australia's laws want the sender identified and reachable, which the footer's name, website and e-mail do.
 * Without a postal address in the settings, Kleo writes only to the UK, Australia and New Zealand; US and Canadian
 * businesses wait, approved, until one is added.
 *
 * THE SWITCH is studio_meta 'outreach_mode' ('on' | 'off'); turning it on needs a mailbox with its password, the postal
 * address and approved prospects. Settings: 'outreach_settings' (JSON). Each mailbox password is sealed in its own row.
 */
import type { StudioEnv } from "./env.ts";
import type { Env } from "../env";
import { audit } from "../db.ts";
import { escapeHtml, hmacHex, safeEqual } from "../util.ts";
import { last4, openKey, sealKey } from "../key-overrides.ts";
import { mailOwner } from "./providers.ts";
import { buildMime, imapFetch, imapLogin, smtpSend, smtpTrouble, socketDial, type Dial, type Incoming } from "./mailbox.ts";
import { StudioError } from "./generate.ts";

const asEnv = (env: StudioEnv): Env => env as unknown as Env;
const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
const APP = "https://app.kleooai.com";
export const COUNTRIES = ["US", "CA", "GB", "AU", "NZ"] as const;
export const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// ── settings ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Settings {
  /** The postal address the e-mails carry (CAN-SPAM, CASL); without one, US and Canadian businesses wait. */
  postal: string;
  /** Credits a business gets when it signs up through its personal link (0: none offered). */
  trialCredits: number;
  /** Answer a "yes" by itself with the personal link. */
  autoReply: boolean;
  /** The scout's finds go straight to "approved" instead of waiting for the owner. */
  autoApprove: boolean;
  /** The scout looks for new businesses (src/studio/scout.ts), at most scoutDaily searches a UTC day. */
  scoutOn: boolean;
  scoutDaily: number;
}
export const DEFAULT_SETTINGS: Settings = { postal: "", trialCredits: 20, autoReply: true, autoApprove: false, scoutOn: false, scoutDaily: 30 };

export async function meta(env: StudioEnv, key: string): Promise<string | null> {
  return (await env.DB.prepare("SELECT value FROM studio_meta WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
}
export async function setMeta(env: StudioEnv, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO studio_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}
export async function settingsOf(env: StudioEnv): Promise<Settings> {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse((await meta(env, "outreach_settings")) ?? "{}") }; } catch { return { ...DEFAULT_SETTINGS }; }
}

// ── the mailboxes ────────────────────────────────────────────────────────────────────────────────────────────────

export interface SenderRow {
  id: string; from_name: string; from_addr: string; user: string; smtp_host: string; smtp_port: number; imap_host: string; imap_port: number;
  daily_max: number; sealed_pass: string | null; pass_last4: string | null; status: string; paused_reason: string | null; paused_at: string | null;
  imap_state: string | null; checked_at: string | null; next_send_at: string | null; created_at: string;
}
const passName = (id: string) => `OUTREACH_SENDER:${id}`;
async function passOf(env: StudioEnv, s: SenderRow): Promise<string> {
  if (!s.sealed_pass) return "";
  try { return await openKey(env.INTERNAL_SECRET, passName(s.id), s.sealed_pass); } catch { return ""; }
}
export async function senders(env: StudioEnv): Promise<SenderRow[]> {
  return (await env.DB.prepare("SELECT * FROM outreach_senders ORDER BY created_at, id").all<SenderRow>()).results ?? [];
}

export interface Readiness { senders: number; postal: boolean; approved: number; sendable: number; ok: boolean }
/** The countries whose law wants a postal address in a commercial e-mail. */
export const POSTAL_COUNTRIES = ["US", "CA"];
export const hasPostal = (s: { postal: string }): boolean => s.postal.trim().length >= 10;
/** The most searches a day the scout may make: one per turn, a turn every minute. */
export const SCOUT_MAX_DAILY = 1440;
export async function readiness(env: StudioEnv): Promise<Readiness> {
  const ready = (await senders(env)).filter((s) => s.status !== "off" && s.sealed_pass).length;
  const approved = Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM outreach_prospects WHERE status IN ('approved', 'active')").first<{ n: number }>())?.n ?? 0);
  const postal = hasPostal(await settingsOf(env));
  // What can be written to now: every approved business, or without a postal address only those outside the US and Canada.
  const sendable = postal ? approved : Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM outreach_prospects WHERE status IN ('approved', 'active')
      AND country NOT IN (${POSTAL_COUNTRIES.map(() => "?").join(",")})`).bind(...POSTAL_COUNTRIES).first<{ n: number }>())?.n ?? 0);
  return { senders: ready, postal, approved, sendable, ok: ready > 0 && sendable > 0 };
}

/**
 * The daily number for a mailbox's n-th day of sending (day 1 = its first): a new mailbox earns trust slowly. Since
 * 27 October 2026 (the owner: "inviane il più possibile") the ramp goes on in steps of ten a week to its maximum (60 by
 * default) instead of jumping from 25 to it on day 22.
 */
export function warmupQuota(day: number, max: number): number {
  const q = day <= 3 ? 5 : day <= 7 ? 10 : day <= 14 ? 15 : day <= 21 ? 25 : day <= 28 ? 35 : day <= 35 ? 45 : max;
  return Math.max(0, Math.min(q, max));
}

// ── time where the business is ───────────────────────────────────────────────────────────────────────────────────

const US_WEST = ["CA", "WA", "OR", "NV"], US_MOUNTAIN = ["CO", "UT", "NM", "ID", "MT", "WY"], US_CENTRAL = ["TX", "IL", "MN", "WI", "MO", "TN", "LA", "OK", "KS", "NE", "IA", "AR", "MS", "AL", "SD", "ND"];
export function zoneFor(country: string | null, region: string | null): string {
  const c = (country ?? "").toUpperCase(), r = (region ?? "").toUpperCase().trim();
  if (c === "US") return r === "AZ" ? "America/Phoenix" : r === "HI" ? "Pacific/Honolulu" : US_WEST.includes(r) ? "America/Los_Angeles" : US_MOUNTAIN.includes(r) ? "America/Denver" : US_CENTRAL.includes(r) ? "America/Chicago" : "America/New_York";
  if (c === "CA") return r === "BC" ? "America/Vancouver" : r === "AB" ? "America/Edmonton" : r === "SK" ? "America/Regina" : r === "MB" ? "America/Winnipeg" : ["NS", "NB", "PE"].includes(r) ? "America/Halifax" : r === "NL" ? "America/St_Johns" : "America/Toronto";
  if (c === "AU") return r === "WA" ? "Australia/Perth" : r === "SA" ? "Australia/Adelaide" : r === "QLD" ? "Australia/Brisbane" : r === "NT" ? "Australia/Darwin" : r === "VIC" ? "Australia/Melbourne" : "Australia/Sydney";
  if (c === "NZ") return "Pacific/Auckland";
  if (c === "GB") return "Europe/London";
  return "UTC";
}
function localParts(ms: number, zone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { day, minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")) };
}
/** Monday to Friday, 9:00 to 16:30 where the business is. */
export function businessTime(ms: number, zone: string): boolean {
  const p = localParts(ms, zone);
  return p.day >= 1 && p.day <= 5 && p.minutes >= 9 * 60 && p.minutes < 16 * 60 + 30;
}
/** `days` business days after `fromMs`, at a time between 9:30 and 15:30 there (`jitter` 0..1 picks it). */
export function afterBusinessDays(fromMs: number, days: number, zone: string, jitter: number): number {
  let t = fromMs, left = days;
  while (left > 0) { t += 86_400_000; const d = localParts(t, zone).day; if (d >= 1 && d <= 5) left--; }
  const p = localParts(t, zone);
  t += (9 * 60 + 30 - p.minutes) * 60_000;
  return Math.floor(t + jitter * 6 * 3_600_000);
}

const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const MONTH_KEYS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DATE_RE = new RegExp([
  `\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
  `\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH_RE}(?:,?\\s+(\\d{4}))?\\b`,
  "\\b(\\d{4})-(\\d{2})-(\\d{2})\\b",
  "\\b(\\d{1,2})/(\\d{1,2})(?:/(\\d{2}|\\d{4}))?\\b",
  "\\b(sun|mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?)day\\b",
  "\\b(tomorrow)\\b",
].join("|"), "gi");
/** Words that put a date at the end of an absence: "until 6 Nov", "back on Monday", "26 Oct - 6 Nov". */
const BACK_ANCHOR = /\b(?:until|till?|back|return(?:s|ing)?|reopen(?:s|ing)?|resum(?:e|es|ing)|through|thru|to)\b|[-–—]\s*$/i;
const BACK_MAX_DAYS = 120;
/** The day an out-of-office reply says its writer is back, where the business is: the latest date named right after
 *  "until", "back", "return", "to" or a range's dash, numbers read day/month outside the US and Canada. Null when
 *  none is named, or when it is not within 120 days of the reply. */
export function backOn(text: string, receivedMs: number, zone: string, country: string | null): { ms: number; label: string } | null {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(receivedMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const today = Date.UTC(get("year"), get("month") - 1, get("day"));
  const monthFirst = ["US", "CA"].includes((country ?? "").toUpperCase());
  let best: number | null = null;
  for (const x of text.matchAll(DATE_RE)) {
    const before = text.slice(Math.max(0, x.index - 30), x.index).split(/[.!?]\s|\n/).at(-1) ?? "";
    if (!BACK_ANCHOR.test(before)) continue;
    let day: number | null = null;
    const ymd = (y: number | null, m: number, d: number): number | null => {
      if (m < 0 || m > 11 || d < 1 || d > 31) return null;
      const full = y === null ? new Date(today).getUTCFullYear() : y < 100 ? 2000 + y : y;
      let t = Date.UTC(full, m, d);
      if (new Date(t).getUTCDate() !== d) return null;
      if (y === null && t < today) t = Date.UTC(full + 1, m, d);
      return t;
    };
    const month = (s: string) => MONTH_KEYS.indexOf(s.slice(0, 3).toLowerCase());
    if (x[1]) day = ymd(x[3] ? Number(x[3]) : null, month(x[1]), Number(x[2]));
    else if (x[4]) day = ymd(x[6] ? Number(x[6]) : null, month(x[5]), Number(x[4]));
    else if (x[7]) day = ymd(Number(x[7]), Number(x[8]) - 1, Number(x[9]));
    else if (x[10]) {
      const a = Number(x[10]), b = Number(x[11]), y = x[12] ? Number(x[12]) : null;
      day = monthFirst ? ymd(y, a - 1, b) ?? ymd(y, b - 1, a) : ymd(y, b - 1, a) ?? ymd(y, a - 1, b);
    } else if (x[13]) {
      const want = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(x[13].slice(0, 3).toLowerCase());
      day = today + (((want - new Date(today).getUTCDay() + 7) % 7) || 7) * 86_400_000;
    } else if (x[14]) day = today + 86_400_000;
    if (day !== null && day >= today && day <= today + BACK_MAX_DAYS * 86_400_000 && (best === null || day > best)) best = day;
  }
  if (best === null) return null;
  // An instant on that day where the business is: noon UTC, moved back a day where noon UTC is already tomorrow there.
  let ms = best + 12 * 3_600_000;
  const there = new Intl.DateTimeFormat("en-US", { timeZone: zone, day: "numeric" }).format(new Date(ms));
  if (Number(there) !== new Date(best).getUTCDate()) ms -= 86_400_000;
  const d = new Date(best);
  return { ms, label: `${d.getUTCDate()} ${MONTH_KEYS[d.getUTCMonth()].replace(/^./, (c) => c.toUpperCase())} ${d.getUTCFullYear()}` };
}

// ── the prospects ────────────────────────────────────────────────────────────────────────────────────────────────

export interface Prospect {
  id: string; email: string; domain: string; company: string; website: string | null; country: string; region: string | null; city: string | null;
  type: string | null; contact_name: string | null; source_url: string; opener: string | null; fit_reason: string | null; status: string; step: number;
  next_at: string | null; tz: string | null; thread_id: string | null; subject: string | null; batch: string | null;
  sender_id: string | null; variant: string | null; link_code: string | null; converted_user: string | null; reply_class: string | null;
}

const EMAIL_RE = /^[^\s@<>"',;]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
export const FREEMAIL = /@(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|me|mac|aol|proton|protonmail|gmx|mail|yandex|zoho|bigpond|xtra)\./i;
const rid = (prefix: string, n = 8): string => `${prefix}_${[...crypto.getRandomValues(new Uint8Array(n))].map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("")}`;

export interface ProspectInput {
  company?: unknown; website?: unknown; email?: unknown; email_source_url?: unknown; source_url?: unknown; country?: unknown; state?: unknown; region?: unknown; city?: unknown;
  type?: unknown; size_hint?: unknown; contact_first_name?: unknown; contact_name?: unknown; contact_role?: unknown; email_kind?: unknown; fit_reason?: unknown; evidence?: unknown; opener?: unknown;
}
const str = (v: unknown, max = 400): string | null => { const s = String(v ?? "").trim(); return s ? s.slice(0, max) : null; };

/** Why a prospect cannot be added, or null. The rules above, checked again on the way in. */
export function prospectProblem(p: ProspectInput): string | null {
  const email = String(p.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return "not an e-mail address";
  if (FREEMAIL.test(email)) return "a free mailbox, not a business address";
  if (!str(p.company)) return "no company name";
  const src = String(p.email_source_url ?? p.source_url ?? "");
  if (!/^https:\/\/[^\s]+\.[^\s]+/.test(src)) return "no https page where the address is published";
  if (!COUNTRIES.includes(String(p.country ?? "").toUpperCase() as (typeof COUNTRIES)[number])) return "country not in US, CA, GB, AU, NZ";
  return null;
}

/** Adds prospects ("new", or "approved" when asked); an address already known, or one that said no, is skipped. */
export async function addProspects(env: StudioEnv, list: ProspectInput[], batch: string, status: "new" | "approved" = "new"): Promise<{ added: number; skipped: { email: string; why: string }[] }> {
  const skipped: { email: string; why: string }[] = [];
  let added = 0;
  for (const p of list) {
    const email = String(p.email ?? "").trim().toLowerCase();
    const bad = prospectProblem(p);
    if (bad) { skipped.push({ email, why: bad }); continue; }
    if (await env.DB.prepare("SELECT 1 AS one FROM mail_suppress WHERE email = ?").bind(email).first()) { skipped.push({ email, why: "said no before" }); continue; }
    const country = String(p.country).toUpperCase();
    const region = str(p.state ?? p.region, 40);
    const r = await env.DB.prepare(`INSERT OR IGNORE INTO outreach_prospects (id, email, domain, company, website, country, region, city, type, size_hint, contact_name,
        contact_role, email_kind, source_url, fit_reason, evidence, opener, batch, status, approved_at, tz) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(rid("p"), email, email.split("@")[1], str(p.company, 120), str(p.website, 300), country, region, str(p.city, 80), str(p.type, 40), str(p.size_hint, 20),
        str(p.contact_first_name ?? p.contact_name, 60), str(p.contact_role, 80), str(p.email_kind, 10), str(p.email_source_url ?? p.source_url, 500),
        str(p.fit_reason, 400), str(p.evidence, 300), str(p.opener, 300), batch.slice(0, 40), status, status === "approved" ? new Date().toISOString() : null, zoneFor(country, region)).run();
    if ((r.meta.changes ?? 0) === 1) added++; else skipped.push({ email, why: "already in the list" });
  }
  return { added, skipped };
}

/** "a,b,"c, d"" → cells; the first line names the columns. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((x) => x.trim()));
  if (!head) return [];
  const keys = head.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

// ── the words ────────────────────────────────────────────────────────────────────────────────────────────────────

const PHRASE: Record<string, string> = {
  "social-media-agency": "social agencies", "short-form-video-agency": "short-form studios", "ugc-agency": "UGC studios",
  "paid-social-creative": "performance creative teams", "video-production": "video teams", "ecommerce-creative": "e-commerce creative teams",
  "tiktok-shop-agency": "TikTok Shop teams", "creative-agency": "creative agencies",
};
const hostOf = (url: string | null): string => { try { return new URL(String(url)).hostname.replace(/^www\./, ""); } catch { return "your website"; } };
const firstOf = (name: string | null): string | null => { const w = (name ?? "").trim().split(/\s+/)[0]; return w && /^\p{L}[\p{L}'’-]{0,23}$/u.test(w) ? w : null; };
const phraseOf = (p: Prospect): string => PHRASE[p.type ?? ""] ?? "teams like yours";
/** The business's name as a person says it, without its legal ending ("2MAG LTD" is 2MAG), and its possessive. */
export const nameOf = (p: { company: string }): string =>
  p.company.replace(/[\s,]+(pty\.?\s+ltd\.?|pty\.?\s+limited|ltd\.?|limited|l\.?l\.?c\.?|inc\.?|llp|plc|gmbh)$/i, "").trim() || p.company;
const nameOfs = (p: { company: string }): string => { const n = nameOf(p); return /s$/i.test(n) ? `${n}'` : `${n}'s`; };
/** "Hi Maya," with a first name, else "Hi Bright Reels team," (27 October 2026, the owner: "Hi {azienda} team"). */
const hiOf = (p: Prospect): string => `Hi ${firstOf(p.contact_name) ?? `${nameOf(p)} team`},`;

/**
 * The versions of the first e-mail Kleo tries against each other (subject and pitch; the opener is the business's own).
 * 27 October 2026, the owner approved the rewrite: one hook (ten hooks for a client, each in a few minutes, before the
 * shoot), no list of features, one question. The first versions (a, b, c) were retired after four e-mails; a business
 * written to with one of them keeps its subject, and its follow-ups are the ones below.
 */
const ASK = (credits: number) => credits ? "Want me to set your team up with free credits to try it on a real brief this week?" : "Would that be useful for your team?";
/** Why Kleo, in one line (27 October 2026, the owner: the cheapest on the market, the same quality or better). */
const WHY = "It runs the same top video models as the big platforms, like Seedance, Veo and Kling, at some of the lowest prices on the market.";
export const VARIANTS: { id: string; name: string; subject: (p: Prospect) => string; pitch: (p: Prospect, credits: number) => string[] }[] = [
  { id: "d", name: "Ten hooks before the shoot", subject: (p) => `10 hooks for ${nameOfs(p)} next client`, pitch: (_p, credits) => [
    "That's the kind of work Kleo (kleooai.com) is built for: type one line or drop in one product photo and you get a vertical clip for TikTok, Reels or Shorts in a few minutes.",
    "So a client's next campaign can start with ten hooks to test, before anyone books a shoot.",
    WHY, ASK(credits)] },
  { id: "e", name: "Show the client first", subject: (p) => `Hooks for ${nameOfs(p)} clients, before the shoot`, pitch: (_p, credits) => [
    "Kleo (kleooai.com) turns one line or one product photo into a vertical video in a few minutes, so you can show a client ten hook options on the first call instead of a moodboard.",
    "The ones that win get the real shoot; the rest cost you minutes, not a shoot day.",
    WHY, ASK(credits)] },
  { id: "f", name: "Ten hooks in an afternoon", subject: (p) => `Testing more hooks at ${nameOf(p)}`, pitch: (p, credits) => [
    "With Kleo (kleooai.com) your team types one line or drops in one photo and gets a vertical clip for TikTok, Reels or Shorts in a few minutes.",
    `For ${phraseOf(p)}, that's ten hooks to test for a client in an afternoon, without booking a shoot.`,
    WHY, ASK(credits)] },
];
export const variantById = (id: string | null) => VARIANTS.find((v) => v.id === id) ?? VARIANTS[0];

export interface Written { subject: string; text: string; html: string }
/** link: the business's personal sign-up link, which the second e-mail carries (it brings the trial credits). */
export interface Signature { fromName: string; postal: string; credits: number; link?: string | null }

/**
 * An e-mail is a list of parts written out twice: as plain text and as HTML (27 October 2026, the owner: a bare
 * app.kleooai.com address "sembra scam"; then "fai il bottone pulito, bella grafica professionale", the logo where I
 * judge best). The first e-mail reads like a person's note: words only, no image, so a new domain's first contact stays
 * out of the filters. The second e-mail and the answer to a yes carry the offer as a card (the Kleo icon, the business's
 * name, what the link gives, one button) and why teams pick Kleo; the signature is words only (the icon already shows
 * as the sender's photo and in the card). Tables and inline styles, so Gmail, Apple Mail
 * and Outlook draw the same thing; no tracking; addresses sit behind words.
 */
interface Offer { title: string; line: string; text: string; button: string; url: string }
type Part = string | { offer: Offer } | { list: string[]; title: string } | { sign: string };
interface Foot { why: string; stopUrl: string; who: string }
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
/** Kleo's icon (the golden play mark on black), from the public media bucket: the app host forbids embedding its files elsewhere. */
const ICON = "https://media.kleooai.com/email/kleo-icon-192.png";
/** A paragraph as HTML: "Kleo (kleooai.com)" becomes the word Kleo linking there; line breaks stay. */
const inlineHtml = (s: string): string => escapeHtml(s).replace(/Kleo \(kleooai\.com\)/g, '<a href="https://kleooai.com" style="color:#111111">Kleo</a>').replace(/\n/g, "<br>");
const icon = (size: number): string => `<img src="${ICON}" width="${size}" height="${size}" alt="Kleo" style="display:block;width:${size}px;height:${size}px;border:0;border-radius:${Math.round(size / 4)}px">`;
/** A button every client draws the same (a table cell, not a styled link alone). */
const buttonHtml = (label: string, url: string): string =>
  `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate"><tr><td bgcolor="#111111" style="background:#111111;border-radius:12px">` +
  `<a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 24px;font-family:${FONT};font-size:16px;font-weight:600;line-height:20px;color:#ffffff;text-decoration:none;border-radius:12px">${escapeHtml(label)}&nbsp;&rarr;</a></td></tr></table>`;
function partText(x: Part): string {
  if (typeof x === "string") return x;
  if ("offer" in x) return `${x.offer.title}\n${x.offer.text}\n${x.offer.button}: ${x.offer.url}`;
  if ("list" in x) return `${x.title}\n${x.list.map((li) => `- ${li}`).join("\n")}`;
  return `${x.sign}\nFounder, Kleo`;
}
function partHtml(x: Part): string {
  if (typeof x === "string") return `<p style="margin:0 0 16px">${inlineHtml(x)}</p>`;
  if ("offer" in x) {
    const o = x.offer;
    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:6px 0 22px;border-collapse:separate"><tr><td bgcolor="#F6F5F2" style="background:#F6F5F2;border:1px solid #ECEAE4;border-radius:16px;padding:22px 22px 24px">
<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td valign="middle" style="padding:0 12px 0 0">${icon(40)}</td>
<td valign="middle"><div style="font-size:17px;font-weight:600;line-height:22px;color:#111111">${escapeHtml(o.title)}</div><div style="font-size:15px;line-height:20px;color:#6b6b6b">${escapeHtml(o.line)}</div></td></tr></table>
<p style="margin:16px 0 18px;font-size:16px;line-height:1.55;color:#111111">${escapeHtml(o.text)}</p>
${buttonHtml(o.button, o.url)}
</td></tr></table>`;
  }
  if ("list" in x) return `<p style="margin:4px 0 8px;font-weight:600">${escapeHtml(x.title)}</p>
<ul style="margin:0 0 18px;padding:0 0 0 20px">${x.list.map((li) => `<li style="margin:0 0 8px">${inlineHtml(li)}</li>`).join("")}</ul>`;
  return `<p style="margin:0 0 16px"><span style="font-weight:600">${escapeHtml(x.sign)}</span><br><span style="color:#6b6b6b">Founder, <a href="https://kleooai.com" style="color:#6b6b6b;text-decoration:none">Kleo</a> · AI video studio</span></p>`;
}
function asText(parts: Part[], foot: Foot | null): string {
  return [...parts.map(partText), ...(foot ? [`--\n${foot.why} If it isn't relevant, reply "no" or open ${foot.stopUrl} and I won't write again.\n${foot.who}`] : [])].join("\n\n");
}
function asHtml(parts: Part[], foot: Foot | null): string {
  const tail = foot ? `\n<p style="margin:26px 0 0;padding-top:14px;border-top:1px solid #ECEAE4;font-size:14px;line-height:1.5;color:#8a8a8a">${escapeHtml(foot.why)} If it isn't relevant, reply "no" or <a href="${escapeHtml(foot.stopUrl)}" style="color:#8a8a8a">unsubscribe here</a> and I won't write again.<br>${escapeHtml(foot.who)}</p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head>
<body style="margin:0;padding:0;background:#ffffff"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="left" style="padding:8px 4px">
<div style="max-width:560px;font-family:${FONT};font-size:16px;line-height:1.55;color:#111111">
${parts.map(partHtml).join("\n")}${tail}
</div></td></tr></table></body></html>`;
}
/**
 * Who Kleo is and why a business would buy it (27 October 2026, the owner: the cheapest on the market with the same
 * quality or better; from an MCP connector to a chat, building its own models, always adding new things; simple, clear).
 * "Some of the lowest prices" rather than "the cheapest": a public claim has to stand up.
 */
const WHY_LIST: Part = { title: "Why teams pick Kleo", list: [
  "Top quality for less: the same video models the big platforms use (Seedance, Veo, Kling), at some of the lowest prices on the market.",
  "Simple and clear: one chat for video, pictures, voice and music, with ready-made viral templates.",
  "Always growing: Kleo started as a connector inside Claude, became a full studio in a chat, and we're now building our own AI models, with new tools all the time.",
] };
/** The offer card: the business's own link, what it gives, one button. */
const offerFor = (p: Prospect, s: Signature, url: string, after: string): Offer => ({
  title: `Kleo for ${nameOf(p)}`, line: "AI video for TikTok, Reels and Shorts", url, button: s.credits ? "Try Kleo free" : "Try Kleo",
  text: s.credits
    ? `Sign up through this link in about a minute (Google or e-mail, no card needed) and ${s.credits} free credits land on the account ${after}, enough for a few test clips.`
    : "Sign up through this link in about a minute (Google or e-mail, no card needed) and try it on a real brief.",
});

/**
 * The three e-mails of the sequence, for one prospect. Short, no tracking. The first asks for a reply (no link but the
 * word Kleo); the second carries the business's personal link in the offer card, so a curious reader signs up without
 * writing back; the third closes the thread. The footer names Kleo and New Zealand (27 October 2026: Kanaky Tech is no
 * longer part of it), and the postal address once there is one.
 */
export function writeStep(p: Prospect, step: number, s: Signature, unsubscribeUrl: string): Written {
  const name = s.fromName || "Leonardo";
  const hi = hiOf(p);
  const foot: Foot = {
    why: `You're getting this one-off business e-mail because ${p.email} is listed on ${hostOf(p.source_url)}.`, stopUrl: unsubscribeUrl,
    who: s.postal.trim() ? `Kleo, ${s.postal.trim()} · kleooai.com` : "Kleo · New Zealand · kleooai.com · hello@kleooai.com",
  };
  const mail = (subject: string, parts: Part[]): Written => ({ subject, text: asText(parts, foot), html: asHtml(parts, foot) });
  const v = variantById(p.variant);
  const subject0 = p.subject || v.subject(p);
  const opener = (p.opener ?? "").trim() || `I came across ${nameOf(p)} while looking at ${PHRASE[p.type ?? ""] ?? "studios that make short-form video"}${p.city ? ` in ${p.city}` : ""}.`;
  if (step === 0) return mail(subject0, [hi, opener, ...v.pitch(p, s.credits), { sign: name }]);
  if (step === 1) return mail(`Re: ${subject0}`, [hi, ...(s.link ? [
    `Easier than a call: I've set up ${nameOfs(p)} own link to try Kleo.`,
    { offer: offerFor(p, s, s.link, "within a few minutes") },
    WHY_LIST,
  ] : [
    "A quick follow-up with something you can judge in ten seconds: app.kleooai.com/explore has clips made entirely in Kleo, each from one line or one photo.",
    s.credits ? `If a free trial for ${nameOf(p)} sounds useful, reply "yes" and I'll send it over.` : `If it sounds useful for ${nameOf(p)}, reply "yes" and I'll send the details.`,
  ]), { sign: name }]);
  return mail(`Re: ${subject0}`, [hi,
    `I'll stop here so I don't crowd your inbox. If short-form video ever becomes the bottleneck at ${nameOf(p)}, a reply to this e-mail still reaches me.`,
    "Thanks,", { sign: name }]);
}

/** Kleo's own answer to a "yes": the personal link in the offer card, and the signature with the icon. */
export function yesMail(p: Prospect, s: Signature, link: string): { text: string; html: string } {
  const parts: Part[] = [hiOf(p),
    `Great, here's ${nameOfs(p)} own link to Kleo.`,
    { offer: offerFor(p, s, link, "by themselves") },
    WHY_LIST,
    "If anything is unclear, just reply here.",
    { sign: s.fromName || "Leonardo" }];
  return { text: asText(parts, null), html: asHtml(parts, null) };
}
export const writeYes = (p: Prospect, s: Signature, link: string): string => yesMail(p, s, link).text;

// ── choosing the version: Thompson sampling on the replies so far ────────────────────────────────────────────────

function gamma(k: number, rnd: () => number): number {
  if (k < 1) return gamma(k + 1, rnd) * Math.pow(Math.max(rnd(), 1e-12), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 200; i++) {
    // Box–Muller from two uniforms.
    const n = Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
    const v = Math.pow(1 + c * n, 3);
    if (v <= 0) continue;
    const u = Math.max(rnd(), 1e-12);
    if (Math.log(u) < 0.5 * n * n + d - d * v + d * Math.log(v)) return d * v;
  }
  return k;
}
const betaSample = (a: number, b: number, rnd: () => number): number => { const x = gamma(a, rnd), y = gamma(b, rnd); return x / (x + y); };

export interface VariantStat { id: string; name: string; sent: number; answered: number }
export async function variantStats(env: StudioEnv): Promise<VariantStat[]> {
  const rows = (await env.DB.prepare(`SELECT variant, COUNT(*) AS sent, SUM(CASE WHEN reply_class IN ('interested', 'question') OR converted_user IS NOT NULL THEN 1 ELSE 0 END) AS answered
      FROM outreach_prospects WHERE step > 0 AND variant IS NOT NULL GROUP BY variant`).all<{ variant: string; sent: number; answered: number }>()).results ?? [];
  return VARIANTS.map((v) => { const r = rows.find((x) => x.variant === v.id); return { id: v.id, name: v.name, sent: Number(r?.sent ?? 0), answered: Number(r?.answered ?? 0) }; });
}
export function pickVariant(stats: VariantStat[], rnd: () => number): string {
  let best = stats[0]?.id ?? "a", top = -1;
  for (const s of stats) { const x = betaSample(1 + s.answered, 1 + Math.max(0, s.sent - s.answered), rnd); if (x > top) { top = x; best = s.id; } }
  return best;
}

// ── the unsubscribe link (on the app's host, so it works whatever domain the mailbox has) ────────────────────────

const outSig = async (env: StudioEnv, id: string): Promise<string> => (await hmacHex(env.INTERNAL_SECRET, `kleo-outreach-stop:${id}`)).slice(0, 32);
export async function outreachStopLink(env: StudioEnv, id: string): Promise<string> { return `${APP}/email/out?p=${encodeURIComponent(id)}&s=${await outSig(env, id)}`; }

async function stopProspect(env: StudioEnv, id: string, email: string, reason: string, suppressIt: boolean): Promise<void> {
  await env.DB.prepare(`UPDATE outreach_prospects SET status = ?, stop_reason = ?, next_at = NULL, updated_at = ${NOW} WHERE id = ?`)
    .bind(reason === "bounce" ? "bounced" : "stopped", reason, id).run();
  if (suppressIt) await env.DB.prepare("INSERT OR IGNORE INTO mail_suppress (email, reason, source) VALUES (?, ?, 'outreach')").bind(email, reason === "bounce" ? "bounce" : "unsubscribe").run();
}

/** GET asks (mail scanners open links), POST stops: the page's button or the mail client's one-click button. */
export async function handleOutreachStop(env: StudioEnv, request: Request, url: URL): Promise<Response> {
  const page = (title: string, text: string, form = "", status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} · Kleo</title>
<style>body{margin:0;background:#fff;color:#111;font:17px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px 16px;box-sizing:border-box}main{width:min(440px,100%)}h1{font-size:24px;margin:0 0 10px}p{margin:0 0 20px;color:#444}button{font:600 17px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#111;color:#fff;border:0;border-radius:999px;padding:14px 24px;cursor:pointer}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${form}</main></body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
  const id = url.searchParams.get("p") ?? "";
  const sig = url.searchParams.get("s") ?? "";
  if (!/^p_[a-z0-9]{6,20}$/.test(id) || !safeEqual(sig, await outSig(env, id))) return page("This link is not valid", "Reply \"no\" to the e-mail and Kleo won't write again.", "", 400);
  const p = await env.DB.prepare("SELECT id, email FROM outreach_prospects WHERE id = ?").bind(id).first<{ id: string; email: string }>();
  if (request.method === "POST") {
    if (p) await stopProspect(env, p.id, p.email, "unsubscribe", true);
    await audit(asEnv(env), null, null, "outreach.unsubscribe", { prospect: id });
    return page("You won't hear from Kleo again", "Your address is off the list for good. Sorry for the interruption.");
  }
  return page("Stop e-mails from Kleo?", "One click and Kleo never writes to this address again.",
    `<form method="post" action="/email/out?p=${encodeURIComponent(id)}&amp;s=${escapeHtml(sig)}"><button type="submit">Stop the e-mails</button></form>`);
}

// ── sending ──────────────────────────────────────────────────────────────────────────────────────────────────────

async function hasMx(domain: string): Promise<boolean> {
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, { headers: { accept: "application/dns-json" } });
    const j = await r.json() as { Status?: number; Answer?: { type: number }[] };
    return j.Status === 0 && !!j.Answer?.some((a) => a.type === 15);
  } catch { return true; } // the DNS check failing is not the address's fault
}

const messageId = (s: SenderRow): string => `<${Date.now().toString(36)}.${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("")}@${s.from_addr.split("@")[1] ?? "kleooai.com"}>`;
const smtpOf = async (env: StudioEnv, s: SenderRow) => ({ host: s.smtp_host, port: s.smtp_port, user: s.user, pass: await passOf(env, s) });

export interface OutreachDeps { dial?: Dial; random?: () => number }

async function threadRefs(env: StudioEnv, p: Prospect): Promise<string[]> {
  return p.thread_id ? ((await env.DB.prepare("SELECT message_id FROM outreach_log WHERE prospect_id = ? AND ok = 1 AND message_id IS NOT NULL ORDER BY id").bind(p.id).all<{ message_id: string }>()).results ?? []).map((r) => r.message_id) : [];
}

/** Sends one step to one prospect from one mailbox; the bookkeeping that follows depends on how it went. */
async function sendTo(env: StudioEnv, s: SenderRow, p: Prospect, set: Settings, nowMs: number, deps: OutreachDeps): Promise<"sent" | "address" | "sender" | "later"> {
  const rnd = deps.random ?? Math.random;
  // The second e-mail carries the business's personal link (made now, kept for its answer to a yes).
  const sig = { fromName: s.from_name, postal: set.postal, credits: set.trialCredits, link: p.step === 1 ? await linkFor(env, p) : null };
  if (p.step === 0 && !p.variant) p.variant = pickVariant(await variantStats(env), rnd);
  const stop = await outreachStopLink(env, p.id);
  const w = writeStep(p, p.step, sig, stop);
  const mid = messageId(s);
  const refs = await threadRefs(env, p);
  const raw = buildMime({ fromName: s.from_name, fromAddr: s.from_addr, to: p.email, subject: w.subject, text: w.text, html: w.html, messageId: mid,
    inReplyTo: refs.at(-1) ?? null, references: refs, unsubscribeUrl: stop, unsubscribeMailto: s.from_addr, date: new Date(nowMs) });
  try {
    await smtpSend(deps.dial ?? socketDial, await smtpOf(env, s), { from: s.from_addr, to: p.email, raw });
  } catch (e) {
    const why = smtpTrouble(e);
    await env.DB.prepare("INSERT INTO outreach_log (prospect_id, email, step, ok, error, sender_id, at) VALUES (?, ?, ?, 0, ?, ?, ?)")
      .bind(p.id, p.email, p.step, String((e as Error)?.message ?? e).slice(0, 300), s.id, new Date(nowMs).toISOString()).run();
    if (why === "address") await stopProspect(env, p.id, p.email, "bounce", true);
    return why;
  }
  await env.DB.prepare("INSERT INTO outreach_log (prospect_id, email, step, ok, message_id, sender_id, at) VALUES (?, ?, ?, 1, ?, ?, ?)")
    .bind(p.id, p.email, p.step, mid, s.id, new Date(nowMs).toISOString()).run();
  const zone = p.tz ?? zoneFor(p.country, p.region);
  const next = p.step === 0 ? afterBusinessDays(nowMs, 3, zone, rnd()) : p.step === 1 ? afterBusinessDays(nowMs, 5, zone, rnd()) : null;
  await env.DB.prepare(`UPDATE outreach_prospects SET step = ?, status = ?, next_at = ?, thread_id = COALESCE(thread_id, ?), subject = COALESCE(subject, ?),
      sender_id = ?, variant = COALESCE(variant, ?), last_sent_at = ?, updated_at = ${NOW} WHERE id = ?`)
    .bind(p.step + 1, next === null ? "done" : "active", next === null ? null : new Date(next).toISOString(), mid, w.subject, s.id, p.variant, new Date(nowMs).toISOString(), p.id).run();
  return "sent";
}

async function sentInLastDay(env: StudioEnv, senderId: string, nowMs: number): Promise<number> {
  return Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM outreach_log WHERE ok = 1 AND sender_id = ? AND at >= ?").bind(senderId, new Date(nowMs - 86_400_000).toISOString()).first<{ n: number }>())?.n ?? 0);
}
/** Which warm-up day a mailbox is on (1 = the first day it sent anything). */
async function warmupDay(env: StudioEnv, senderId: string, nowMs: number): Promise<number> {
  const first = await env.DB.prepare("SELECT MIN(at) AS at FROM outreach_log WHERE ok = 1 AND sender_id = ?").bind(senderId).first<{ at: string | null }>();
  return first?.at ? Math.floor((nowMs - Date.parse(first.at)) / 86_400_000) + 1 : 1;
}
const quotaOf = async (env: StudioEnv, s: SenderRow, nowMs: number) => warmupQuota(await warmupDay(env, s.id, nowMs), Math.max(1, Math.min(Number(s.daily_max) || 60, 60)));

export interface OutreachTick { sent: number; replies: number; converted: number; paused?: string }

/**
 * The cron's turn (every 5 minutes): trial credits for businesses that signed up through their link, each mailbox's
 * replies every quarter of an hour, then at most one e-mail per mailbox. The scout runs on its own (scout.ts).
 */
export async function outreachTick(env: StudioEnv, nowMs = Date.now(), deps: OutreachDeps = {}): Promise<OutreachTick> {
  const out: OutreachTick = { sent: 0, replies: 0, converted: 0 };
  const set = await settingsOf(env);
  // Sign-ups through a personal link get their trial credits even when outreach is off again.
  try { out.converted = await grantTrials(env, set, nowMs); } catch (e) { console.error("outreach trials", e instanceof Error ? e.message : e); }
  if ((await meta(env, "outreach_mode")) !== "on") return out;
  const list = (await senders(env)).filter((s) => s.status !== "off" && s.sealed_pass);
  if (!list.length) return { ...out, paused: "setup" };
  for (const s of list) {
    if (nowMs - (Date.parse(s.checked_at ?? "") || 0) >= 14 * 60_000) {
      try { out.replies += await checkReplies(env, s, set, nowMs, deps); } catch (e) { console.error("outreach imap", s.from_addr, e instanceof Error ? e.message : e); }
    }
    // A refused sign-in is often Google's passing hiccup (27 October 2026: one 535 between good sends, the next try at
    // once fine): the first refusal waits 30 minutes, the second 2 hours, then 6.
    const fails = Number((await meta(env, `sender_fails_${s.id}`)) ?? 0);
    if (s.status === "paused" && nowMs - (Date.parse(s.paused_at ?? "") || 0) < ([0, 30, 120][fails] ?? 360) * 60_000) { out.paused = "sender"; continue; }
    if (nowMs < (Date.parse(s.next_send_at ?? "") || 0)) continue;
    if ((await sentInLastDay(env, s.id, nowMs)) >= (await quotaOf(env, s, nowMs))) { out.paused ??= "quota"; continue; }
    const p = await pickNext(env, s, nowMs, hasPostal(set));
    if (!p) continue;
    if (p.step === 0) {
      if (await env.DB.prepare("SELECT 1 AS one FROM mail_suppress WHERE email = ?").bind(p.email).first()) { await stopProspect(env, p.id, p.email, "suppressed", false); continue; }
      if (!(await hasMx(p.domain))) { await env.DB.prepare(`UPDATE outreach_prospects SET status = 'invalid', stop_reason = 'no MX', updated_at = ${NOW} WHERE id = ?`).bind(p.id).run(); continue; }
      if (!p.opener?.trim()) {
        const line = await writeOpener(env, p);
        if (line) { p.opener = line; await env.DB.prepare(`UPDATE outreach_prospects SET opener = ?, updated_at = ${NOW} WHERE id = ?`).bind(line, p.id).run(); }
      }
    }
    const r = await sendTo(env, s, p, set, nowMs, deps);
    const rnd = deps.random ?? Math.random;
    if (r === "sent") {
      out.sent++;
      await env.DB.prepare(`UPDATE outreach_senders SET next_send_at = ?, status = 'active', paused_reason = NULL, paused_at = NULL WHERE id = ?`)
        .bind(new Date(nowMs + (7 + rnd() * 7) * 60_000).toISOString(), s.id).run();
      if (fails) await env.DB.prepare("DELETE FROM studio_meta WHERE key = ?").bind(`sender_fails_${s.id}`).run();
    } else if (r === "sender") {
      const last = await env.DB.prepare("SELECT error FROM outreach_log WHERE ok = 0 AND sender_id = ? ORDER BY id DESC LIMIT 1").bind(s.id).first<{ error: string }>();
      await setMeta(env, `sender_fails_${s.id}`, String(fails + 1));
      await env.DB.prepare("UPDATE outreach_senders SET status = 'paused', paused_reason = ?, paused_at = ? WHERE id = ?").bind(last?.error ?? "refused", new Date(nowMs).toISOString(), s.id).run();
      // The owner hears when it is not a hiccup: the second refusal in a row, once.
      if (fails + 1 === 2) await mailOwner(env, `Kleo outreach: ${s.from_addr} refused to send`, `The outreach mailbox ${s.from_addr} refused Kleo's sign-in or sender twice in a row:\n\n${last?.error ?? ""}\n\nKleo tries it again every 6 hours; the other mailboxes go on. Check its app password in the admin console (Outreach, Mailboxes).`, nowMs);
      out.paused = "sender";
    } else if (r === "later") {
      await env.DB.prepare("UPDATE outreach_senders SET next_send_at = ? WHERE id = ?").bind(new Date(nowMs + 30 * 60_000).toISOString(), s.id).run();
    }
  }
  return out;
}

/** This mailbox's follow-up that is due first, else the next approved prospect nobody has written to; business time only. */
async function pickNext(env: StudioEnv, s: SenderRow, nowMs: number, postal: boolean): Promise<Prospect | null> {
  const now = new Date(nowMs).toISOString();
  const due = (await env.DB.prepare("SELECT * FROM outreach_prospects WHERE status = 'active' AND sender_id = ? AND next_at <= ? ORDER BY next_at LIMIT 40").bind(s.id, now).all<Prospect>()).results ?? [];
  const f = due.find((p) => businessTime(nowMs, p.tz ?? zoneFor(p.country, p.region)));
  if (f) return f;
  // Not written to yet: nobody's, this mailbox's (a send that failed), or a mailbox's that is no longer sending.
  const free = `status = 'approved' AND step = 0 AND (sender_id IS NULL OR sender_id = ? OR sender_id NOT IN (SELECT id FROM outreach_senders WHERE status = 'active'))${postal ? "" : ` AND country NOT IN (${POSTAL_COUNTRIES.map((c) => `'${c}'`).join(", ")})`}`;
  const fresh = (await env.DB.prepare(`SELECT * FROM outreach_prospects WHERE ${free} ORDER BY approved_at, added_at, rowid LIMIT 80`).bind(s.id).all<Prospect>()).results ?? [];
  for (const p of fresh) {
    if (!businessTime(nowMs, p.tz ?? zoneFor(p.country, p.region))) continue;
    // Never two people at one business on the same day.
    const busy = await env.DB.prepare("SELECT 1 AS one FROM outreach_prospects WHERE domain = ? AND id != ? AND last_sent_at >= ?").bind(p.domain, p.id, new Date(nowMs - 86_400_000).toISOString()).first();
    if (busy) continue;
    // Claim it for this mailbox (another mailbox in the same tick takes the next one).
    const claimed = await env.DB.prepare(`UPDATE outreach_prospects SET sender_id = ? WHERE id = ? AND ${free}`).bind(s.id, p.id, s.id).run();
    if ((claimed.meta.changes ?? 0) === 1) return { ...p, sender_id: s.id };
  }
  return null;
}

// ── trial credits for the businesses that sign up through their link ──────────────────────────────────────────────

async function grantTrials(env: StudioEnv, set: Settings, nowMs: number): Promise<number> {
  const rows = (await env.DB.prepare(`SELECT p.id, p.company, p.email, p.link_code, a.user_id FROM outreach_prospects p JOIN user_attribution a ON a.link_code = p.link_code
      WHERE p.link_code IS NOT NULL AND p.converted_user IS NULL ORDER BY a.created_at LIMIT 20`).all<{ id: string; company: string; email: string; link_code: string; user_id: string }>()).results ?? [];
  let n = 0;
  for (const r of rows) {
    // One account per business: the first that signs up through the link.
    const mark = await env.DB.prepare(`UPDATE outreach_prospects SET converted_user = ?, converted_at = ?, updated_at = ${NOW} WHERE id = ? AND converted_user IS NULL`).bind(r.user_id, new Date(nowMs).toISOString(), r.id).run();
    if ((mark.meta.changes ?? 0) !== 1) continue;
    const credits = Math.max(0, Math.min(200, Math.floor(set.trialCredits)));
    if (credits) await env.DB.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").bind(credits, r.user_id).run();
    await audit(asEnv(env), r.user_id, null, "outreach.trial", { prospect: r.id, credits });
    await mailOwner(env, `Kleo outreach: ${r.company} signed up`, `${r.company} (${r.email}) opened a Kleo account through its personal link${credits ? `, and ${credits} trial credits were added to it` : ""}.\n\nAccount: ${r.user_id} (admin console, Users).`, nowMs);
    n++;
  }
  return n;
}

/** The personal link of a business: a hidden short link (Sources leaves it out) that opens the app and tags the sign-up. */
async function linkFor(env: StudioEnv, p: Prospect): Promise<string> {
  if (p.link_code) return `${APP}/r/${p.link_code}`;
  const slug = p.company.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 18) || "kleo";
  const code = `${slug}-${rid("x", 4).slice(2)}`.replace(/-+/g, "-");
  await env.DB.prepare(`INSERT INTO short_links (code, channel, label, target, created_by, archived_at) VALUES (?, 'other', ?, '/', 'outreach', ${NOW})`)
    .bind(code, `Outreach: ${p.company}`.slice(0, 80)).run();
  await env.DB.prepare(`UPDATE outreach_prospects SET link_code = ?, updated_at = ${NOW} WHERE id = ?`).bind(code, p.id).run();
  return `${APP}/r/${code}`;
}

// ── the replies ──────────────────────────────────────────────────────────────────────────────────────────────────

export type ReplyClass = "interested" | "question" | "not_interested" | "unsubscribe" | "out_of_office" | "wrong_person" | "bounce" | "other";
const BOUNCE_FROM = /mailer-daemon|postmaster|mail delivery (subsystem|system)/i;
const BOUNCE_SUBJECT = /undeliverable|delivery status notification|failure notice|returned mail|delivery has failed|could not be delivered|address not found/i;

/** The rules first (cheap and certain); Workers AI only for the rest. */
export function ruleClass(m: Pick<Incoming, "from" | "fromName" | "subject" | "autoSubmitted" | "text">): ReplyClass | null {
  if (BOUNCE_FROM.test(`${m.from} ${m.fromName}`) || BOUNCE_SUBJECT.test(m.subject)) return "bounce";
  if (/auto-replied|auto-generated/i.test(m.autoSubmitted ?? "") || /out of (the )?office|automatic reply|auto.?reply|on (annual )?leave|away until|on vacation/i.test(m.subject)) return "out_of_office";
  const t = m.text.trim().toLowerCase();
  if (/^(no|nope|no thanks|no thank you|not interested|stop|unsubscribe|remove)[.!]?\s*$/i.test(t) || /\b(unsubscribe|remove (me|us)|take (me|us) off|stop (e-?mailing|contacting)|do not (contact|e-?mail)|don't (contact|e-?mail))\b/i.test(t)) return "unsubscribe";
  if (/^(yes|yes please|yes!|sure|interested|sounds good|send it over|please do)[.!]?\s*$/i.test(t)) return "interested";
  return null;
}

async function aiClass(env: StudioEnv, m: Incoming, p: Prospect): Promise<{ cls: ReplyClass; summary: string }> {
  const fallback = { cls: "other" as ReplyClass, summary: m.text.slice(0, 200) };
  if (!env.AI) return fallback;
  try {
    const r = await env.AI.run(AI_MODEL as never, {
      messages: [
        { role: "system", content: "You sort replies to a short sales e-mail from Kleo, an AI video app, sent to a business. Answer only with JSON: {\"class\": one of \"interested\", \"question\", \"not_interested\", \"unsubscribe\", \"out_of_office\", \"wrong_person\", \"other\", \"summary\": one plain English sentence of what they said}. interested = wants to try it, says yes, asks for the link or the free credits; question = asks something before deciding; not_interested = declines politely; unsubscribe = asks not to be e-mailed again; wrong_person = says someone else handles it or they left." },
        { role: "user", content: `Business: ${p.company}\nSubject: ${m.subject}\nReply:\n${m.text.slice(0, 2500)}` },
      ],
      max_tokens: 160, temperature: 0,
    } as never) as { response?: unknown };
    const txt = typeof r?.response === "string" ? r.response : JSON.stringify(r?.response ?? "");
    const j = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1)) as { class?: string; summary?: string };
    const cls = (["interested", "question", "not_interested", "unsubscribe", "out_of_office", "wrong_person", "other"] as const).find((c) => c === j.class) ?? "other";
    return { cls, summary: String(j.summary ?? "").slice(0, 300) || fallback.summary };
  } catch { return fallback; }
}

/** The prospect a message answers: by the thread first, then the address, then one contacted business at that domain. */
async function prospectFor(env: StudioEnv, m: Incoming): Promise<Prospect | null> {
  const ids = [m.inReplyTo, ...m.references].filter((x): x is string => !!x);
  for (const id of ids) {
    const p = await env.DB.prepare("SELECT p.* FROM outreach_log l JOIN outreach_prospects p ON p.id = l.prospect_id WHERE l.message_id = ? LIMIT 1").bind(id.trim()).first<Prospect>();
    if (p) return p;
  }
  const byAddr = await env.DB.prepare("SELECT * FROM outreach_prospects WHERE email = ? AND step > 0").bind(m.from).first<Prospect>();
  if (byAddr) return byAddr;
  const domain = m.from.split("@")[1] ?? "";
  if (!domain || FREEMAIL.test(m.from)) return null;
  const same = (await env.DB.prepare("SELECT * FROM outreach_prospects WHERE domain = ? AND step > 0").bind(domain).all<Prospect>()).results ?? [];
  return same.length === 1 ? same[0] : null;
}

export async function checkReplies(env: StudioEnv, s: SenderRow, set: Settings, nowMs: number, deps: OutreachDeps = {}): Promise<number> {
  let state: { uidValidity: number | null; lastUid: number } = { uidValidity: null, lastUid: 0 };
  try { state = { uidValidity: null, lastUid: 0, ...JSON.parse(s.imap_state ?? "{}") }; } catch { /* first time */ }
  const got = await imapFetch(deps.dial ?? socketDial, { host: s.imap_host, port: s.imap_port, user: s.user, pass: await passOf(env, s) },
    { uidValidity: state.uidValidity, afterUid: state.lastUid, days: 14 }, new Date(nowMs));
  let handled = 0;
  for (const m of got.messages) {
    if (m.from === s.from_addr.toLowerCase()) continue;
    const rule = ruleClass(m);
    if (rule === "bounce") {
      const named = new Set([...m.failedRecipients, ...(m.text.match(/[^\s<>"'():;,]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []).map((x) => x.toLowerCase())]);
      for (const email of named) {
        const p = await env.DB.prepare("SELECT * FROM outreach_prospects WHERE email = ? AND step > 0").bind(email).first<Prospect>();
        if (p) { await stopProspect(env, p.id, p.email, "bounce", true); await saveReply(env, p, m, "bounce", "The address bounced.", nowMs); handled++; }
      }
      continue;
    }
    const p = await prospectFor(env, m);
    if (!p) continue;
    if (await env.DB.prepare("SELECT 1 AS one FROM outreach_replies WHERE prospect_id = ? AND uid = ?").bind(p.id, m.uid).first()) continue;
    const { cls, summary: said } = rule ? { cls: rule, summary: rule === "out_of_office" ? "Automatic out-of-office reply." : m.text.slice(0, 200) } : await aiClass(env, m, p);
    const zone = p.tz ?? zoneFor(p.country, p.region);
    const back = cls === "out_of_office" ? backOn(`${m.subject}\n${m.text}`, Date.parse(m.date ?? "") || nowMs, zone, p.country) : null;
    const summary = back ? `${said.replace(/\.$/, "")}; back on ${back.label}.` : said;
    await saveReply(env, p, m, cls, summary, nowMs);
    handled++;
    if (cls === "out_of_office") {
      // The next e-mail waits for the business day after the one they say they are back, or a week when they name none.
      const after = back ? afterBusinessDays(back.ms, 1, zone, (deps.random ?? Math.random)()) : nowMs + 7 * 86_400_000;
      await env.DB.prepare(`UPDATE outreach_prospects SET next_at = ?, updated_at = ${NOW} WHERE id = ? AND status = 'active'`)
        .bind(new Date(Math.max(Date.parse(p.next_at ?? "") || 0, after)).toISOString(), p.id).run();
      continue;
    }
    if (cls === "unsubscribe" || cls === "not_interested") { await stopProspect(env, p.id, p.email, cls, true); continue; }
    if (cls === "wrong_person") { await stopProspect(env, p.id, p.email, "wrong_person", false); continue; }
    await env.DB.prepare(`UPDATE outreach_prospects SET status = 'replied', next_at = NULL, replied_at = ?, reply_class = ?, reply_summary = ?, updated_at = ${NOW} WHERE id = ?`)
      .bind(new Date(nowMs).toISOString(), cls, summary, p.id).run();
    // A "yes": Kleo answers by itself, in the same thread, with the business's personal link.
    let answered = "";
    if (cls === "interested" && set.autoReply) {
      try {
        const link = await linkFor(env, p);
        const refs = await threadRefs(env, p);
        const all = [...refs, ...(m.messageId ? [m.messageId] : [])];
        const raw = buildMime({ fromName: s.from_name, fromAddr: s.from_addr, to: m.from || p.email, subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject || p.subject || p.company}`,
          ...yesMail(p, { fromName: s.from_name, postal: set.postal, credits: set.trialCredits }, link), messageId: messageId(s), inReplyTo: m.messageId ?? refs.at(-1) ?? null, references: all, date: new Date(nowMs) });
        await smtpSend(deps.dial ?? socketDial, await smtpOf(env, s), { from: s.from_addr, to: m.from || p.email, raw });
        await env.DB.prepare("INSERT INTO outreach_log (prospect_id, email, step, ok, sender_id, at) VALUES (?, ?, 9, 1, ?, ?)").bind(p.id, m.from || p.email, s.id, new Date(nowMs).toISOString()).run();
        answered = `Kleo already answered with their personal link (${link})${set.trialCredits ? `; their account gets ${set.trialCredits} trial credits when they sign up through it` : ""}. You'll get an e-mail when they do.`;
      } catch (e) { answered = `Kleo could not send their link (${(e as Error).message}): answer them yourself.`; }
    }
    await mailOwner(env, `Kleo outreach: ${p.company} replied (${cls.replace("_", " ")})`,
      `${p.company} (${m.from}) answered Kleo's e-mail.\n\nWhat they said, in one line: ${summary}\n\nTheir reply:\n${m.text.slice(0, 1500)}\n\n${answered || `Answer them from ${s.from_addr}: the thread is there. Kleo will not write to them again on its own.`}`, nowMs);
  }
  await env.DB.prepare("UPDATE outreach_senders SET imap_state = ?, checked_at = ? WHERE id = ?").bind(JSON.stringify({ uidValidity: got.uidValidity, lastUid: got.lastUid }), new Date(nowMs).toISOString(), s.id).run();
  return handled;
}

async function saveReply(env: StudioEnv, p: Prospect, m: Incoming, cls: string, summary: string, nowMs: number): Promise<void> {
  await env.DB.prepare("INSERT INTO outreach_replies (prospect_id, from_addr, subject, text, class, summary, uid, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(p.id, m.from, m.subject.slice(0, 200), m.text.slice(0, 4000), cls, summary.slice(0, 300), m.uid, new Date(nowMs).toISOString()).run();
}

// ── openers for prospects added without one (Workers AI reads their home page) ───────────────────────────────────

export const pageText = (html: string): string => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

/** One sentence about something real on the business's site, or null when Workers AI can't write a good one. */
/**
 * A first line fit to send: one sentence ending in a full stop, short, no hype, no address, and spoken to the business
 * ("Saw that you…", "Noticed your…"). 27 October 2026: the scout's model wrote "Saw they scale 150+ D2C brands" and
 * "Saw TikTok Shop Services in their offerings" with no full stop; a line about the business in the third person is
 * refused, and the e-mail writes a new one when it goes.
 */
export function goodOpener(line: unknown): string | null {
  let s = String(line ?? "").trim().replace(/^["'“]|["'”]$/g, "").split("\n")[0].trim();
  if (s && !/[.?]$/.test(s)) s = `${s.replace(/[,;:\s]+$/, "")}.`;
  return s.length > 20 && s.length < 220 && s.split(/\s+/).length <= 30 && !/!|https?:|www\.|love your|impressive|amazing|awesome/i.test(s)
    && !/\b(they|they're|their|theirs|them)\b/i.test(s) ? s : null;
}

export async function writeOpener(env: StudioEnv, p: Pick<Prospect, "company" | "website">, text?: string): Promise<string | null> {
  if (!env.AI) return null;
  let page = text ?? "";
  if (!page && p.website) {
    try {
      const r = await fetch(p.website, { headers: { "user-agent": "Mozilla/5.0 (compatible; KleoBot/1.0; +https://kleooai.com)" }, signal: AbortSignal.timeout(8000) });
      page = pageText(await r.text()).slice(0, 3500);
    } catch { return null; }
  }
  if (page.length < 200) return null;
  try {
    const r = await env.AI.run(AI_MODEL as never, {
      messages: [
        { role: "system", content: "Write the first line of a short, personal business e-mail to this company, from the founder of an AI video app. One sentence, at most 25 words, ending with a full stop, about something specific and real on their website (a service, a niche they serve, a named client or project), starting with \"Saw\" or \"Noticed\". Speak to them directly: \"you\" and \"your\", never \"they\", \"their\" or \"them\" (for example: Saw that you make UGC ads for skincare brands in Leeds.). No flattery, no exclamation marks, no emoji, nothing you cannot see in the text. Answer with the sentence only." },
        { role: "user", content: `Company: ${p.company}\nWebsite text:\n${page.slice(0, 3500)}` },
      ],
      max_tokens: 80, temperature: 0.3,
    } as never) as { response?: unknown };
    return goodOpener(r?.response);
  } catch { return null; }
}

// ── the admin console's side (routed from src/studio/admin.ts) ───────────────────────────────────────────────────

export async function outreachOverview(env: StudioEnv, nowMs = Date.now()): Promise<unknown> {
  const set = await settingsOf(env);
  const ready = await readiness(env);
  const counts = Object.fromEntries(((await env.DB.prepare("SELECT status, COUNT(*) AS n FROM outreach_prospects GROUP BY status").all<{ status: string; n: number }>()).results ?? []).map((r) => [r.status, r.n]));
  const one = async (sql: string, ...a: unknown[]) => Number((await env.DB.prepare(sql).bind(...a).first<{ n: number }>())?.n ?? 0);
  const mailboxes = [];
  for (const s of await senders(env)) {
    const day = await warmupDay(env, s.id, nowMs);
    mailboxes.push({ id: s.id, fromName: s.from_name, fromAddr: s.from_addr, user: s.user, smtpHost: s.smtp_host, smtpPort: s.smtp_port, imapHost: s.imap_host, imapPort: s.imap_port,
      dailyMax: s.daily_max, passwordEnds: s.pass_last4, status: s.status, pausedReason: s.paused_reason, checkedAt: s.checked_at,
      warmupDay: day, quota: warmupQuota(day, Math.max(1, Math.min(Number(s.daily_max) || 60, 60))), sentLastDay: await sentInLastDay(env, s.id, nowMs) });
  }
  const replies = (await env.DB.prepare(`SELECT r.prospect_id, r.from_addr, r.subject, r.class, r.summary, r.at, p.company FROM outreach_replies r
      LEFT JOIN outreach_prospects p ON p.id = r.prospect_id ORDER BY r.id DESC LIMIT 30`).all()).results ?? [];
  const sends = (await env.DB.prepare(`SELECT l.prospect_id, l.email, l.step, l.ok, l.error, l.at, p.company, s.from_addr AS sender FROM outreach_log l
      LEFT JOIN outreach_prospects p ON p.id = l.prospect_id LEFT JOIN outreach_senders s ON s.id = l.sender_id ORDER BY l.id DESC LIMIT 30`).all()).results ?? [];
  return {
    on: (await meta(env, "outreach_mode")) === "on", settings: set, ready, mailboxes, counts,
    contacted: await one("SELECT COUNT(DISTINCT prospect_id) AS n FROM outreach_log WHERE ok = 1 AND step = 0"),
    replied: await one("SELECT COUNT(DISTINCT prospect_id) AS n FROM outreach_replies WHERE class NOT IN ('bounce', 'out_of_office')"),
    signedUp: await one("SELECT COUNT(*) AS n FROM outreach_prospects WHERE converted_user IS NOT NULL"),
    paying: await one("SELECT COUNT(DISTINCT p.converted_user) AS n FROM outreach_prospects p JOIN payments y ON y.user_id = p.converted_user AND y.status = 'paid' AND y.amount_cent > 0"),
    variants: await variantStats(env), replies, sends, countries: COUNTRIES,
    scout: {
      today: Number((await meta(env, `scout_day_${new Date(nowMs).toISOString().slice(0, 10)}`)) ?? 0),
      queued: await one("SELECT COUNT(*) AS n FROM outreach_seen WHERE status = 'queued'"),
      checked: await one("SELECT COUNT(*) AS n FROM outreach_seen WHERE status != 'queued'"),
      added: await one("SELECT COUNT(*) AS n FROM outreach_prospects WHERE batch LIKE 'scout%'"),
      addedWeek: await one("SELECT COUNT(*) AS n FROM outreach_prospects WHERE batch LIKE 'scout%' AND added_at >= ?", new Date(nowMs - 7 * 86_400_000).toISOString()),
      lastError: await meta(env, "scout_error"),
      paused: await meta(env, "scout_paused"),
    },
  };
}

export async function listProspects(env: StudioEnv, url: URL): Promise<unknown> {
  const status = url.searchParams.get("status") ?? "";
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const where: string[] = [], args: unknown[] = [];
  if (status) { where.push("status = ?"); args.push(status); }
  if (q) { where.push("(LOWER(company) LIKE ? OR email LIKE ? OR LOWER(city) LIKE ?)"); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const sql = `SELECT id, email, company, website, country, region, city, type, contact_name, source_url, opener, fit_reason, status, stop_reason, step, next_at, batch,
      reply_class, reply_summary, variant, converted_user, added_at, last_sent_at FROM outreach_prospects ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY added_at DESC, company LIMIT 60 OFFSET ?`;
  const rows = (await env.DB.prepare(sql).bind(...args, offset).all()).results ?? [];
  return { prospects: rows, more: rows.length === 60 };
}

export async function previewFor(env: StudioEnv, url: URL): Promise<unknown> {
  const p = await env.DB.prepare("SELECT * FROM outreach_prospects WHERE id = ?").bind(url.searchParams.get("id") ?? "").first<Prospect>();
  if (!p) throw new StudioError("No such prospect.", 404, "not_found");
  const set = await settingsOf(env);
  const s = (await senders(env))[0];
  // The personal link is made only when the second e-mail goes; the preview shows where it will be.
  const personal = `${APP}/r/${p.link_code ?? "their-link"}`;
  const sig = { fromName: s?.from_name || "Leonardo", postal: set.postal, credits: set.trialCredits, link: personal };
  const link = await outreachStopLink(env, p.id);
  const versions = p.variant && VARIANTS.some((v) => v.id === p.variant) ? [p.variant] : VARIANTS.map((v) => v.id);
  return {
    prospect: { id: p.id, company: p.company, email: p.email, variant: p.variant },
    first: versions.map((v) => ({ variant: v, name: variantById(v).name, ...writeStep({ ...p, variant: v, step: 0 }, 0, sig, link) })),
    followUps: [1, 2].map((i) => writeStep(p, i, sig, link)),
    yes: writeYes(p, sig, personal),
  };
}

/** Approve, reject or reset one prospect; "approve-new" approves every one still waiting. */
export async function prospectAction(env: StudioEnv, adminId: string, id: string, action: string): Promise<unknown> {
  const now = new Date().toISOString();
  if (action === "approve-new") {
    const r = await env.DB.prepare(`UPDATE outreach_prospects SET status = 'approved', approved_at = ?, updated_at = ${NOW} WHERE status = 'new'`).bind(now).run();
    await audit(asEnv(env), adminId, null, "admin.outreach_approve_all", { n: r.meta.changes ?? 0 });
    return { ok: true, approved: r.meta.changes ?? 0 };
  }
  const set = action === "approve" ? "status = 'approved', approved_at = ?" : action === "reject" ? "status = 'rejected', approved_at = ?" : action === "reset" ? "status = 'new', approved_at = ?" : null;
  if (!set) throw new StudioError("Unknown action.", 400, "action");
  const r = await env.DB.prepare(`UPDATE outreach_prospects SET ${set}, updated_at = ${NOW} WHERE id = ? AND status IN ('new', 'approved', 'rejected') AND step = 0`).bind(now, id).run();
  if (!(r.meta.changes ?? 0)) throw new StudioError("This prospect has already been written to; it can't change now.", 409, "busy");
  return { ok: true };
}

const hostName = (v: unknown, d: string): string => { const h = String(v ?? d).trim().toLowerCase(); if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) throw new StudioError(`"${h}" isn't a server name.`, 400, "host"); return h; };
const portOf = (v: unknown, d: number): number => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 65536 ? n : d; };

/**
 * Adds or changes one mailbox. With a password (new, or changed), sending and reading must both sign in before
 * anything is kept; the password is sealed in the row, bound to its id.
 */
export async function saveSender(env: StudioEnv, adminId: string, b: Record<string, unknown>, deps: OutreachDeps = {}): Promise<unknown> {
  const id = String(b.id ?? "").trim();
  const cur = id ? await env.DB.prepare("SELECT * FROM outreach_senders WHERE id = ?").bind(id).first<SenderRow>() : null;
  if (id && !cur) throw new StudioError("No such mailbox.", 404, "not_found");
  const fromAddr = String(b.fromAddr ?? cur?.from_addr ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(fromAddr)) throw new StudioError("The sender address doesn't look right.", 400, "from");
  if (/@kleooai\.com$/i.test(fromAddr) || FREEMAIL.test(fromAddr)) throw new StudioError("Use a mailbox on its own domain, never kleooai.com or a Gmail, Outlook or other free address: if that mailbox ever gets a bad name, Kleo's own e-mail stays clean.", 400, "from_domain");
  const row = {
    from_name: String(b.fromName ?? cur?.from_name ?? "Leonardo").trim().slice(0, 60) || "Leonardo",
    from_addr: fromAddr,
    user: String(b.user ?? "").trim() || cur?.user || fromAddr,
    smtp_host: hostName(b.smtpHost, cur?.smtp_host ?? "smtp.gmail.com"), smtp_port: portOf(b.smtpPort, cur?.smtp_port ?? 465),
    imap_host: hostName(b.imapHost, cur?.imap_host ?? "imap.gmail.com"), imap_port: portOf(b.imapPort, cur?.imap_port ?? 993),
    daily_max: Math.max(5, Math.min(60, Number(b.dailyMax ?? cur?.daily_max ?? 60) || 60)),
  };
  const newPass = String(b.password ?? "").replace(/\s+/g, "");
  const pass = newPass || (cur ? await passOf(env, cur) : "");
  if (!pass) throw new StudioError("Add the mailbox's app password.", 400, "password");
  const dial = deps.dial ?? socketDial;
  try { await smtpSend(dial, { host: row.smtp_host, port: row.smtp_port, user: row.user, pass }); }
  catch (e) { throw new StudioError(`Sending didn't sign in: ${(e as Error).message}. Nothing was saved.`, 400, "smtp"); }
  try { await imapLogin(dial, { host: row.imap_host, port: row.imap_port, user: row.user, pass }); }
  catch (e) { throw new StudioError(`Reading replies didn't sign in: ${(e as Error).message}. Nothing was saved.`, 400, "imap"); }
  const sid = cur?.id ?? rid("s", 6);
  const sealed = await sealKey(env.INTERNAL_SECRET, passName(sid), pass);
  if (cur) {
    await env.DB.prepare(`UPDATE outreach_senders SET from_name = ?, from_addr = ?, user = ?, smtp_host = ?, smtp_port = ?, imap_host = ?, imap_port = ?, daily_max = ?,
        sealed_pass = ?, pass_last4 = ?, status = 'active', paused_reason = NULL, paused_at = NULL WHERE id = ?`)
      .bind(row.from_name, row.from_addr, row.user, row.smtp_host, row.smtp_port, row.imap_host, row.imap_port, row.daily_max, sealed, last4(pass), sid).run();
  } else {
    try {
      await env.DB.prepare(`INSERT INTO outreach_senders (id, from_name, from_addr, user, smtp_host, smtp_port, imap_host, imap_port, daily_max, sealed_pass, pass_last4, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`)
        .bind(sid, row.from_name, row.from_addr, row.user, row.smtp_host, row.smtp_port, row.imap_host, row.imap_port, row.daily_max, sealed, last4(pass)).run();
    } catch { throw new StudioError("That mailbox is already in the list.", 409, "exists"); }
  }
  await audit(asEnv(env), adminId, null, "admin.outreach_sender", { id: sid, from: row.from_addr, smtp: row.smtp_host, password: newPass ? last4(newPass) : null });
  return { ok: true, id: sid };
}

/** A mailbox off (its prospects stay with it and wait) or on again; "remove" only when it never sent anything. */
export async function senderAction(env: StudioEnv, adminId: string, id: string, action: string): Promise<unknown> {
  if (action === "remove") {
    const used = await env.DB.prepare("SELECT 1 AS one FROM outreach_log WHERE sender_id = ? LIMIT 1").bind(id).first();
    if (used) throw new StudioError("This mailbox has threads going; switch it off instead, so their replies are still read.", 409, "busy");
    await env.DB.prepare("DELETE FROM outreach_senders WHERE id = ?").bind(id).run();
  } else if (action === "off" || action === "on") {
    await env.DB.prepare("UPDATE outreach_senders SET status = ?, paused_reason = NULL, paused_at = NULL WHERE id = ?").bind(action === "off" ? "off" : "active", id).run();
  } else throw new StudioError("Unknown action.", 400, "action");
  await audit(asEnv(env), adminId, null, "admin.outreach_sender_action", { id, action });
  return { ok: true };
}

export async function saveSettings(env: StudioEnv, adminId: string, b: Record<string, unknown>): Promise<Settings> {
  const cur = await settingsOf(env);
  const next: Settings = {
    postal: b.postal === undefined ? cur.postal : String(b.postal).trim().slice(0, 200),
    trialCredits: b.trialCredits === undefined ? cur.trialCredits : Math.max(0, Math.min(200, Math.floor(Number(b.trialCredits) || 0))),
    autoReply: b.autoReply === undefined ? cur.autoReply : b.autoReply === true,
    autoApprove: b.autoApprove === undefined ? cur.autoApprove : b.autoApprove === true,
    scoutOn: b.scoutOn === undefined ? cur.scoutOn : b.scoutOn === true,
    scoutDaily: b.scoutDaily === undefined ? cur.scoutDaily : Math.max(5, Math.min(SCOUT_MAX_DAILY, Math.floor(Number(b.scoutDaily) || 30))),
  };
  await setMeta(env, "outreach_settings", JSON.stringify(next));
  await audit(asEnv(env), adminId, null, "admin.outreach_settings", { ...next, postal: next.postal ? "set" : "" });
  return next;
}

export async function setOutreachMode(env: StudioEnv, adminId: string, on: boolean): Promise<unknown> {
  if (on) {
    const r = await readiness(env);
    if (!r.ok) throw new StudioError(!r.senders ? "Add a mailbox first." : r.approved && !r.postal ? "Every approved business is in the US or Canada: add the postal address first, their law wants it in every e-mail." : "Approve some businesses first.", 400, "not_ready");
  }
  await setMeta(env, "outreach_mode", on ? "on" : "off");
  await audit(asEnv(env), adminId, null, "admin.outreach_mode", { on });
  return { ok: true, on };
}

/** The first e-mail for a sample prospect, through one real mailbox, to that mailbox itself. */
/** A sample first e-mail from a mailbox, to the mailbox itself or to an address the owner names (to see it as a business would). */
export async function sendOutreachTest(env: StudioEnv, senderId: string | null, deps: OutreachDeps = {}, toAddr: string | null = null, step = 0): Promise<unknown> {
  const list = await senders(env);
  const s = list.find((x) => x.id === senderId) ?? list[0];
  if (!s?.sealed_pass) throw new StudioError("Add a mailbox first.", 400, "not_ready");
  const set = await settingsOf(env);
  const p = await env.DB.prepare("SELECT * FROM outreach_prospects WHERE status IN ('new', 'approved') ORDER BY RANDOM() LIMIT 1").first<Prospect>();
  const sample: Prospect = p ?? { id: "p_sample", email: s.from_addr, domain: "", company: "Sample Agency", website: null, country: "US", region: null, city: "Austin", type: "social-media-agency",
    contact_name: "Sam", source_url: "https://example.com/contact", opener: null, fit_reason: null, status: "new", step: 0, next_at: null, tz: null, thread_id: null, subject: null, batch: null,
    sender_id: null, variant: null, link_code: null, converted_user: null, reply_class: null };
  // Which e-mail of the sequence (0, 1 or 2); the second's button opens the app, and the stop link belongs to no
  // business, so the owner can click everything in a test without touching a real one.
  const n = [0, 1, 2].includes(step) ? step : 0;
  const w = writeStep({ ...sample, variant: sample.variant ?? pickVariant(await variantStats(env), deps.random ?? Math.random), subject: null }, n,
    { fromName: s.from_name, postal: set.postal, credits: set.trialCredits, link: `${APP}/` }, await outreachStopLink(env, "p_testmail"));
  const to = toAddr && /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[a-z]{2,}$/i.test(toAddr.trim()) ? toAddr.trim().toLowerCase() : s.from_addr;
  const raw = buildMime({ fromName: s.from_name, fromAddr: s.from_addr, to, subject: `[Test, as ${sample.company} would get it] ${w.subject}`, text: w.text, html: w.html, messageId: messageId(s) });
  await smtpSend(deps.dial ?? socketDial, await smtpOf(env, s), { from: s.from_addr, to, raw });
  return { ok: true, to };
}
