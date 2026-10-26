/**
 * KLEO STUDIO — OUTREACH (27 October 2026, the owner: "vorrei che la mia gmail facesse questa cosa ogni notte … sparsa
 * senza destare troppo sospetto per spam o ban … in automatico, senza l'uso di claude").
 *
 * Kleo writes, on its own, a short personal first e-mail to businesses whose work is short-form video (social media,
 * UGC and paid-social agencies, TikTok Shop and e-commerce creative studios), and two follow-ups in the same thread when
 * nobody answers. It reads the replies itself, stops at the first one, tells the owner when someone is interested, and
 * never writes again to anyone who said no or whose address bounced.
 *
 * THE RULES IT KEEPS (New Zealand's Unsolicited Electronic Messages Act 2007, CAN-SPAM, CASL, the UK's PECR, Australia's
 * Spam Act): only addresses a business publishes on its own website for business contact, relevant to its work (the
 * "deemed / implied consent" every one of those laws allows), each with the page where it was seen (source_url); never
 * a bought or harvested list; the sender named, the postal address in every e-mail, a working unsubscribe link and
 * "reply no", honoured at once. Every prospect waits for the owner's approval before its first e-mail. Countries:
 * US, CA, GB, AU, NZ only (the EU's rules for this are stricter).
 *
 * HOW IT SENDS: from a real mailbox through SMTP (src/studio/mailbox.ts) — a separate domain and Google Workspace or
 * any provider with SMTP+IMAP and an app password — never through Cloudflare Email Sending (transactional mail only)
 * and never from kleooai@gmail.com. Warm-up: 5 a day the first three days, then 10, 15, 25, up to the owner's maximum
 * (default 40); one e-mail every 7 to 14 minutes at most; only Monday to Friday, 9:00 to 16:30 where the business is.
 *
 * THE SWITCH is studio_meta 'outreach_mode' ('on' | 'off'); turning it on needs the sender, its password, the postal
 * address and approved prospects. The mailbox password is sealed in key_overrides (OUTREACH_SMTP_PASS).
 */
import type { StudioEnv } from "./env.ts";
import type { Env } from "../env";
import { audit } from "../db.ts";
import { escapeHtml, hmacHex, safeEqual } from "../util.ts";
import { forgetKeys, last4, sealKey } from "../key-overrides.ts";
import { mailOwner } from "./providers.ts";
import { buildMime, imapFetch, imapLogin, smtpSend, smtpTrouble, socketDial, type Dial, type Incoming } from "./mailbox.ts";
import { StudioError } from "./generate.ts";

const asEnv = (env: StudioEnv): Env => env as unknown as Env;
const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
const APP = "https://app.kleooai.com";
export const COUNTRIES = ["US", "CA", "GB", "AU", "NZ"] as const;
const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// ── settings ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Sender {
  fromName: string; fromAddr: string; user: string;
  smtpHost: string; smtpPort: number; imapHost: string; imapPort: number;
  postal: string; dailyMax: number;
}
const EMPTY_SENDER: Sender = { fromName: "Leonardo", fromAddr: "", user: "", smtpHost: "smtp.gmail.com", smtpPort: 465, imapHost: "imap.gmail.com", imapPort: 993, postal: "", dailyMax: 40 };

async function meta(env: StudioEnv, key: string): Promise<string | null> {
  return (await env.DB.prepare("SELECT value FROM studio_meta WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
}
async function setMeta(env: StudioEnv, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO studio_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}
export async function senderOf(env: StudioEnv): Promise<Sender> {
  try { return { ...EMPTY_SENDER, ...JSON.parse((await meta(env, "outreach_sender")) ?? "{}") }; } catch { return { ...EMPTY_SENDER }; }
}
const passOf = (env: StudioEnv): string => String((env as unknown as Record<string, unknown>).OUTREACH_SMTP_PASS ?? "").replace(/\s+/g, "");

export interface Readiness { sender: boolean; password: boolean; postal: boolean; approved: number; ok: boolean }
export async function readiness(env: StudioEnv): Promise<Readiness> {
  const s = await senderOf(env);
  const approved = Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM outreach_prospects WHERE status IN ('approved', 'active')").first<{ n: number }>())?.n ?? 0);
  const r = { sender: !!(s.fromAddr && s.user && s.smtpHost && s.imapHost), password: !!passOf(env), postal: s.postal.trim().length >= 10, approved };
  return { ...r, ok: r.sender && r.password && r.postal && approved > 0 };
}

/** The daily number for the n-th day of sending (day 1 = the first): a new mailbox earns trust slowly. */
export function warmupQuota(day: number, max: number): number {
  const q = day <= 3 ? 5 : day <= 7 ? 10 : day <= 14 ? 15 : day <= 21 ? 25 : max;
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
  // Walk to 9:30 that day, then add the jitter.
  const p = localParts(t, zone);
  t += (9 * 60 + 30 - p.minutes) * 60_000;
  return Math.floor(t + jitter * 6 * 3_600_000);
}

// ── the prospects ────────────────────────────────────────────────────────────────────────────────────────────────

export interface Prospect {
  id: string; email: string; domain: string; company: string; website: string | null; country: string; region: string | null; city: string | null;
  type: string | null; contact_name: string | null; source_url: string; opener: string | null; fit_reason: string | null; status: string; step: number;
  next_at: string | null; tz: string | null; thread_id: string | null; subject: string | null; batch: string | null;
}

const EMAIL_RE = /^[^\s@<>"',;]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const FREEMAIL = /@(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|me|mac|aol|proton|protonmail|gmx|mail|yandex|zoho|bigpond|xtra)\./i;
const pid = (): string => `p_${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("")}`;

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

/** Adds prospects as "new" (waiting for the owner's approval); an address already known, or stopped, is skipped. */
export async function addProspects(env: StudioEnv, list: ProspectInput[], batch: string): Promise<{ added: number; skipped: { email: string; why: string }[] }> {
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
        contact_role, email_kind, source_url, fit_reason, evidence, opener, batch, status, tz) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`)
      .bind(pid(), email, email.split("@")[1], str(p.company, 120), str(p.website, 300), country, region, str(p.city, 80), str(p.type, 40), str(p.size_hint, 20),
        str(p.contact_first_name ?? p.contact_name, 60), str(p.contact_role, 80), str(p.email_kind, 10), str(p.email_source_url ?? p.source_url, 500),
        str(p.fit_reason, 400), str(p.evidence, 300), str(p.opener, 300), batch.slice(0, 40), zoneFor(country, region)).run();
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

export interface Written { subject: string; text: string }

/** The three e-mails of the sequence, for one prospect. Plain text, short, no tracking, one link in the first. */
export function writeStep(p: Prospect, step: number, s: Sender, unsubscribeUrl: string): Written {
  const hi = `Hi ${firstOf(p.contact_name) ?? "there"},`;
  const sign = `${s.fromName || "Leonardo"}\nFounder, Kleo`;
  const footer = `--\nYou're getting this one-off business e-mail because ${p.email} is listed on ${hostOf(p.source_url)}. If it isn't relevant, reply "no" or open ${unsubscribeUrl} and I won't write again.\nKleo, ${s.postal.trim()}`;
  const subject0 = p.subject || `Short-form video for ${p.company}`;
  const opener = (p.opener ?? "").trim() || `I came across ${p.company} while looking at ${PHRASE[p.type ?? ""] ?? "studios that make short-form video"}${p.city ? ` in ${p.city}` : ""}.`;
  if (step === 0) return { subject: subject0, text: [hi, opener,
    "I'm Leonardo, and I build Kleo (kleooai.com): an AI video studio in a chat. Type an idea or drop in one photo and you get vertical clips for TikTok, Reels and Shorts, with trend templates, face and outfit swap, voiceover and music in the same place.",
    `For ${PHRASE[p.type ?? ""] ?? "teams like yours"} it means testing ten hooks for a client in an afternoon instead of booking a shoot.`,
    "Would it help if I set your team up with free credits to try it on a real brief?",
    sign, footer].join("\n\n") };
  if (step === 1) return { subject: `Re: ${subject0}`, text: [hi,
    "A quick follow-up with something you can judge in ten seconds: app.kleooai.com/explore has clips made entirely in Kleo, each from one line or one photo.",
    `If a free trial for ${p.company} sounds useful, reply "yes" and I'll set it up today.`,
    sign, footer].join("\n\n") };
  return { subject: `Re: ${subject0}`, text: [hi,
    `I'll stop here so I don't crowd your inbox. If short-form video ever becomes the bottleneck at ${p.company}, a reply to this e-mail still reaches me.`,
    `Thanks,\n${s.fromName || "Leonardo"}`, footer].join("\n\n") };
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

const messageId = (s: Sender): string => `<${Date.now().toString(36)}.${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("")}@${s.fromAddr.split("@")[1] ?? "kleooai.com"}>`;

export interface OutreachDeps { dial?: Dial; random?: () => number }

/** Sends one step to one prospect; the bookkeeping that follows depends on how it went. */
async function sendTo(env: StudioEnv, p: Prospect, s: Sender, nowMs: number, deps: OutreachDeps): Promise<"sent" | "address" | "sender" | "later"> {
  const rnd = deps.random ?? Math.random;
  const w = writeStep(p, p.step, s, await outreachStopLink(env, p.id));
  const mid = messageId(s);
  const refs = p.thread_id ? ((await env.DB.prepare("SELECT message_id FROM outreach_log WHERE prospect_id = ? AND ok = 1 AND message_id IS NOT NULL ORDER BY id").bind(p.id).all<{ message_id: string }>()).results ?? []).map((r) => r.message_id) : [];
  const raw = buildMime({ fromName: s.fromName, fromAddr: s.fromAddr, to: p.email, subject: w.subject, text: w.text, messageId: mid,
    inReplyTo: refs.at(-1) ?? null, references: refs, unsubscribeUrl: await outreachStopLink(env, p.id), unsubscribeMailto: s.fromAddr, date: new Date(nowMs) });
  try {
    await smtpSend(deps.dial ?? socketDial, { host: s.smtpHost, port: s.smtpPort, user: s.user, pass: passOf(env) }, { from: s.fromAddr, to: p.email, raw });
  } catch (e) {
    const why = smtpTrouble(e);
    await env.DB.prepare("INSERT INTO outreach_log (prospect_id, email, step, ok, error, at) VALUES (?, ?, ?, 0, ?, ?)").bind(p.id, p.email, p.step, String((e as Error)?.message ?? e).slice(0, 300), new Date(nowMs).toISOString()).run();
    if (why === "address") await stopProspect(env, p.id, p.email, "bounce", true);
    return why;
  }
  await env.DB.prepare("INSERT INTO outreach_log (prospect_id, email, step, ok, message_id, at) VALUES (?, ?, ?, 1, ?, ?)").bind(p.id, p.email, p.step, mid, new Date(nowMs).toISOString()).run();
  const zone = p.tz ?? zoneFor(p.country, p.region);
  const next = p.step === 0 ? afterBusinessDays(nowMs, 3, zone, rnd()) : p.step === 1 ? afterBusinessDays(nowMs, 5, zone, rnd()) : null;
  await env.DB.prepare(`UPDATE outreach_prospects SET step = ?, status = ?, next_at = ?, thread_id = COALESCE(thread_id, ?), subject = COALESCE(subject, ?),
      last_sent_at = ?, updated_at = ${NOW} WHERE id = ?`)
    .bind(p.step + 1, next === null ? "done" : "active", next === null ? null : new Date(next).toISOString(), mid, w.subject, new Date(nowMs).toISOString(), p.id).run();
  return "sent";
}

async function sentInLastDay(env: StudioEnv, nowMs: number): Promise<number> {
  return Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM outreach_log WHERE ok = 1 AND at >= ?").bind(new Date(nowMs - 86_400_000).toISOString()).first<{ n: number }>())?.n ?? 0);
}

/** Which warm-up day it is (1 = the first day anything was sent). */
async function warmupDay(env: StudioEnv, nowMs: number): Promise<number> {
  const first = await env.DB.prepare("SELECT MIN(at) AS at FROM outreach_log WHERE ok = 1").first<{ at: string | null }>();
  return first?.at ? Math.floor((nowMs - Date.parse(first.at)) / 86_400_000) + 1 : 1;
}

export interface OutreachTick { sent: number; replies: number; paused?: string }

/** The cron's turn (every 5 minutes): read the replies every quarter of an hour, then send at most one e-mail. */
export async function outreachTick(env: StudioEnv, nowMs = Date.now(), deps: OutreachDeps = {}): Promise<OutreachTick> {
  const out: OutreachTick = { sent: 0, replies: 0 };
  if ((await meta(env, "outreach_mode")) !== "on") return out;
  const ready = await readiness(env);
  if (!ready.sender || !ready.password || !ready.postal) return { ...out, paused: "setup" };
  const s = await senderOf(env);
  const lastCheck = Date.parse((await meta(env, "outreach_checked_at")) ?? "") || 0;
  if (nowMs - lastCheck >= 14 * 60_000) {
    try { out.replies = await checkReplies(env, s, nowMs, deps); } catch (e) { console.error("outreach imap", e instanceof Error ? e.message : e); }
  }
  if ((await meta(env, "outreach_paused")) && nowMs - (Date.parse((await meta(env, "outreach_paused_at")) ?? "") || 0) < 6 * 3_600_000) return { ...out, paused: "sender" };
  const nextSend = Date.parse((await meta(env, "outreach_next_send")) ?? "") || 0;
  if (nowMs < nextSend) return out;
  const quota = warmupQuota(await warmupDay(env, nowMs), Math.max(1, Math.min(Number(s.dailyMax) || 40, 60)));
  if ((await sentInLastDay(env, nowMs)) >= quota) return { ...out, paused: "quota" };
  const p = await pickNext(env, nowMs);
  if (!p) return out;
  if (p.step === 0) {
    if (await env.DB.prepare("SELECT 1 AS one FROM mail_suppress WHERE email = ?").bind(p.email).first()) { await stopProspect(env, p.id, p.email, "suppressed", false); return out; }
    if (!(await hasMx(p.domain))) { await env.DB.prepare(`UPDATE outreach_prospects SET status = 'invalid', stop_reason = 'no MX', updated_at = ${NOW} WHERE id = ?`).bind(p.id).run(); return out; }
    // Added without a first line (a CSV from the console): Workers AI writes one from the business's home page.
    if (!p.opener?.trim()) {
      const line = await writeOpener(env, p);
      if (line) { p.opener = line; await env.DB.prepare(`UPDATE outreach_prospects SET opener = ?, updated_at = ${NOW} WHERE id = ?`).bind(line, p.id).run(); }
    }
  }
  const r = await sendTo(env, p, s, nowMs, deps);
  const rnd = deps.random ?? Math.random;
  if (r === "sent") {
    out.sent = 1;
    await setMeta(env, "outreach_next_send", new Date(nowMs + (7 + rnd() * 7) * 60_000).toISOString());
    await env.DB.prepare("DELETE FROM studio_meta WHERE key IN ('outreach_paused', 'outreach_paused_at')").run();
  } else if (r === "sender") {
    await setMeta(env, "outreach_paused", "sender"); await setMeta(env, "outreach_paused_at", new Date(nowMs).toISOString());
    const last = await env.DB.prepare("SELECT error FROM outreach_log WHERE ok = 0 ORDER BY id DESC LIMIT 1").first<{ error: string }>();
    await mailOwner(env, "Kleo outreach is paused: the mailbox refused to send", `The outreach mailbox ${s.fromAddr} refused Kleo's sign-in or sender:\n\n${last?.error ?? ""}\n\nKleo tries again in 6 hours. Check the app password in the admin console (Outreach, Sender).`, nowMs);
    out.paused = "sender";
  } else if (r === "later") {
    await setMeta(env, "outreach_next_send", new Date(nowMs + 30 * 60_000).toISOString());
  }
  return out;
}

/** A follow-up that is due first, else the next approved prospect; only where it is business time now. */
async function pickNext(env: StudioEnv, nowMs: number): Promise<Prospect | null> {
  const now = new Date(nowMs).toISOString();
  const due = (await env.DB.prepare("SELECT * FROM outreach_prospects WHERE status = 'active' AND next_at <= ? ORDER BY next_at LIMIT 40").bind(now).all<Prospect>()).results ?? [];
  const f = due.find((p) => businessTime(nowMs, p.tz ?? zoneFor(p.country, p.region)));
  if (f) return f;
  const fresh = (await env.DB.prepare("SELECT * FROM outreach_prospects WHERE status = 'approved' ORDER BY approved_at, added_at, rowid LIMIT 80").all<Prospect>()).results ?? [];
  for (const p of fresh) {
    if (!businessTime(nowMs, p.tz ?? zoneFor(p.country, p.region))) continue;
    // Never two people at one business on the same day.
    const busy = await env.DB.prepare("SELECT 1 AS one FROM outreach_prospects WHERE domain = ? AND id != ? AND last_sent_at >= ?").bind(p.domain, p.id, new Date(nowMs - 86_400_000).toISOString()).first();
    if (!busy) return p;
  }
  return null;
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
  if (/^(yes|yes please|sure|interested|sounds good)[.!]?\s*$/i.test(t)) return "interested";
  return null;
}

async function aiClass(env: StudioEnv, m: Incoming, p: Prospect): Promise<{ cls: ReplyClass; summary: string }> {
  const fallback = { cls: "other" as ReplyClass, summary: m.text.slice(0, 200) };
  if (!env.AI) return fallback;
  try {
    const r = await env.AI.run(AI_MODEL as never, {
      messages: [
        { role: "system", content: "You sort replies to a short sales e-mail from Kleo, an AI video app, sent to a business. Answer only with JSON: {\"class\": one of \"interested\", \"question\", \"not_interested\", \"unsubscribe\", \"out_of_office\", \"wrong_person\", \"other\", \"summary\": one plain English sentence of what they said}. interested = wants to try or talk; question = asks something before deciding; not_interested = declines politely; unsubscribe = asks not to be e-mailed again; wrong_person = says someone else handles it or they left." },
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

export async function checkReplies(env: StudioEnv, s: Sender, nowMs: number, deps: OutreachDeps = {}): Promise<number> {
  let state: { uidValidity: number | null; lastUid: number } = { uidValidity: null, lastUid: 0 };
  try { state = { uidValidity: null, lastUid: 0, ...JSON.parse((await meta(env, "outreach_imap")) ?? "{}") }; } catch { /* first time */ }
  const got = await imapFetch(deps.dial ?? socketDial, { host: s.imapHost, port: s.imapPort, user: s.user, pass: passOf(env) },
    { uidValidity: state.uidValidity, afterUid: state.lastUid, days: 14 }, new Date(nowMs));
  let handled = 0;
  for (const m of got.messages) {
    if (m.from === s.fromAddr.toLowerCase()) continue;
    // A bounce names the address it could not reach; any prospect named in it is done.
    const rule = ruleClass(m);
    if (rule === "bounce") {
      const named = new Set([...m.failedRecipients, ...(m.text.match(/[^\s<>"'():;,]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []).map((x) => x.toLowerCase())]);
      for (const email of named) {
        const p = await env.DB.prepare("SELECT * FROM outreach_prospects WHERE email = ? AND step > 0").bind(email).first<Prospect>();
        if (p) { await stopProspect(env, p.id, p.email, "bounce", true); await saveReply(env, p, m, "bounce", "The address bounced."); handled++; }
      }
      continue;
    }
    const p = await prospectFor(env, m);
    if (!p) continue;
    if (await env.DB.prepare("SELECT 1 AS one FROM outreach_replies WHERE prospect_id = ? AND uid = ?").bind(p.id, m.uid).first()) continue;
    const { cls, summary } = rule ? { cls: rule, summary: rule === "out_of_office" ? "Automatic out-of-office reply." : m.text.slice(0, 200) } : await aiClass(env, m, p);
    await saveReply(env, p, m, cls, summary);
    handled++;
    if (cls === "out_of_office") {
      await env.DB.prepare(`UPDATE outreach_prospects SET next_at = ?, updated_at = ${NOW} WHERE id = ? AND status = 'active'`)
        .bind(new Date(Math.max(Date.parse(p.next_at ?? "") || 0, nowMs + 7 * 86_400_000)).toISOString(), p.id).run();
    } else if (cls === "unsubscribe" || cls === "not_interested") {
      await stopProspect(env, p.id, p.email, cls, true);
    } else if (cls === "wrong_person") {
      await stopProspect(env, p.id, p.email, "wrong_person", false);
    } else {
      await env.DB.prepare(`UPDATE outreach_prospects SET status = 'replied', next_at = NULL, replied_at = ?, reply_class = ?, reply_summary = ?, updated_at = ${NOW} WHERE id = ?`)
        .bind(new Date(nowMs).toISOString(), cls, summary, p.id).run();
      await mailOwner(env, `Kleo outreach: ${p.company} replied (${cls.replace("_", " ")})`,
        `${p.company} (${m.from}) answered Kleo's e-mail.\n\nWhat they said, in one line: ${summary}\n\nTheir reply:\n${m.text.slice(0, 1500)}\n\nAnswer them from the outreach mailbox, ${s.fromAddr}: the thread is there. Kleo will not write to them again on its own.\n\nTo give their team free credits, open their account in the admin console once they sign up.`, nowMs);
    }
  }
  await setMeta(env, "outreach_imap", JSON.stringify({ uidValidity: got.uidValidity, lastUid: got.lastUid }));
  await setMeta(env, "outreach_checked_at", new Date(nowMs).toISOString());
  return handled;
}

async function saveReply(env: StudioEnv, p: Prospect, m: Incoming, cls: string, summary: string): Promise<void> {
  await env.DB.prepare("INSERT INTO outreach_replies (prospect_id, from_addr, subject, text, class, summary, uid) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(p.id, m.from, m.subject.slice(0, 200), m.text.slice(0, 4000), cls, summary.slice(0, 300), m.uid).run();
}

// ── openers for prospects added without one (Workers AI reads their home page) ───────────────────────────────────

export async function writeOpener(env: StudioEnv, p: Prospect): Promise<string | null> {
  if (!env.AI || !p.website) return null;
  let page = "";
  try {
    const r = await fetch(p.website, { headers: { "user-agent": "Mozilla/5.0 (compatible; KleoBot/1.0; +https://kleooai.com)" }, signal: AbortSignal.timeout(8000) });
    page = (await r.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 3500);
  } catch { return null; }
  if (page.length < 200) return null;
  try {
    const r = await env.AI.run(AI_MODEL as never, {
      messages: [
        { role: "system", content: "Write the first line of a short, personal business e-mail to this company, from the founder of an AI video app. One sentence, at most 25 words, about something specific and real on their website (a service, a niche they serve, a named client or project). No flattery, no exclamation marks, no emoji, nothing you cannot see in the text. Answer with the sentence only." },
        { role: "user", content: `Company: ${p.company}\nWebsite text:\n${page}` },
      ],
      max_tokens: 80, temperature: 0.3,
    } as never) as { response?: unknown };
    const line = String(r?.response ?? "").trim().replace(/^["']|["']$/g, "").split("\n")[0];
    return line.length > 20 && line.length < 220 && !/!|https?:/.test(line) ? line : null;
  } catch { return null; }
}

// ── the admin console's side (routed from src/studio/admin.ts) ───────────────────────────────────────────────────

export async function outreachOverview(env: StudioEnv, nowMs = Date.now()): Promise<unknown> {
  const s = await senderOf(env);
  const ready = await readiness(env);
  const counts = Object.fromEntries(((await env.DB.prepare("SELECT status, COUNT(*) AS n FROM outreach_prospects GROUP BY status").all<{ status: string; n: number }>()).results ?? []).map((r) => [r.status, r.n]));
  const day = await warmupDay(env, nowMs);
  const sent = await sentInLastDay(env, nowMs);
  const total = Number((await env.DB.prepare("SELECT COUNT(DISTINCT prospect_id) AS n FROM outreach_log WHERE ok = 1").first<{ n: number }>())?.n ?? 0);
  const replied = Number((await env.DB.prepare("SELECT COUNT(DISTINCT prospect_id) AS n FROM outreach_replies WHERE class NOT IN ('bounce', 'out_of_office')").first<{ n: number }>())?.n ?? 0);
  const replies = (await env.DB.prepare(`SELECT r.prospect_id, r.from_addr, r.subject, r.class, r.summary, r.at, p.company FROM outreach_replies r
      LEFT JOIN outreach_prospects p ON p.id = r.prospect_id ORDER BY r.id DESC LIMIT 30`).all()).results ?? [];
  const sends = (await env.DB.prepare(`SELECT l.prospect_id, l.email, l.step, l.ok, l.error, l.at, p.company FROM outreach_log l
      LEFT JOIN outreach_prospects p ON p.id = l.prospect_id ORDER BY l.id DESC LIMIT 30`).all()).results ?? [];
  return {
    on: (await meta(env, "outreach_mode")) === "on", paused: await meta(env, "outreach_paused"),
    sender: { ...s, hasPassword: !!passOf(env), passwordEnds: passOf(env) ? last4(passOf(env)) : null }, ready,
    warmup: { day, quota: warmupQuota(day, Math.max(1, Math.min(Number(s.dailyMax) || 40, 60))), sentLastDay: sent },
    counts, contacted: total, replied, replies, sends, countries: COUNTRIES,
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
      reply_class, reply_summary, added_at, last_sent_at FROM outreach_prospects ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY added_at DESC, company LIMIT 60 OFFSET ?`;
  const rows = (await env.DB.prepare(sql).bind(...args, offset).all()).results ?? [];
  return { prospects: rows, more: rows.length === 60 };
}

export async function previewFor(env: StudioEnv, url: URL): Promise<unknown> {
  const p = await env.DB.prepare("SELECT * FROM outreach_prospects WHERE id = ?").bind(url.searchParams.get("id") ?? "").first<Prospect>();
  if (!p) throw new StudioError("No such prospect.", 404, "not_found");
  const s = await senderOf(env);
  const sample = { ...s, postal: s.postal || "[your postal address goes here]", fromName: s.fromName || "Leonardo" };
  const link = await outreachStopLink(env, p.id);
  return { prospect: { id: p.id, company: p.company, email: p.email }, steps: [0, 1, 2].map((i) => writeStep({ ...p, step: i }, i, sample, link)) };
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
  const r = await env.DB.prepare(`UPDATE outreach_prospects SET ${set}, updated_at = ${NOW} WHERE id = ? AND status IN ('new', 'approved', 'rejected')`).bind(now, id).run();
  if (!(r.meta.changes ?? 0)) throw new StudioError("This prospect has already been written to; it can't change now.", 409, "busy");
  return { ok: true };
}

/** Saves the sender; with a new password, both halves (SMTP and IMAP) must sign in before anything is kept. */
export async function saveSender(env: StudioEnv, adminId: string, b: Record<string, unknown>, deps: OutreachDeps = {}): Promise<unknown> {
  const cur = await senderOf(env);
  const port = (v: unknown, d: number) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 65536 ? n : d; };
  const host = (v: unknown, d: string) => { const h = String(v ?? d).trim().toLowerCase(); if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) throw new StudioError(`"${h}" isn't a server name.`, 400, "host"); return h; };
  const next: Sender = {
    fromName: String(b.fromName ?? cur.fromName).trim().slice(0, 60) || "Leonardo",
    fromAddr: String(b.fromAddr ?? cur.fromAddr).trim().toLowerCase(),
    user: String(b.user ?? "").trim() || String(b.fromAddr ?? cur.fromAddr).trim() || cur.user,
    smtpHost: host(b.smtpHost, cur.smtpHost), smtpPort: port(b.smtpPort, cur.smtpPort),
    imapHost: host(b.imapHost, cur.imapHost), imapPort: port(b.imapPort, cur.imapPort),
    postal: String(b.postal ?? cur.postal).trim().slice(0, 200),
    dailyMax: Math.max(5, Math.min(60, Number(b.dailyMax ?? cur.dailyMax) || 40)),
  };
  if (!EMAIL_RE.test(next.fromAddr)) throw new StudioError("The sender address doesn't look right.", 400, "from");
  if (/@kleooai\.com$|@gmail\.com$/i.test(next.fromAddr)) throw new StudioError("Use the outreach mailbox on its own domain, never kleooai.com or a Gmail address: if that mailbox ever gets a bad name, Kleo's own e-mail stays clean.", 400, "from_domain");
  const newPass = String(b.password ?? "").replace(/\s+/g, "");
  const pass = newPass || passOf(env);
  if (pass) {
    const dial = deps.dial ?? socketDial;
    try { await smtpSend(dial, { host: next.smtpHost, port: next.smtpPort, user: next.user, pass }); }
    catch (e) { throw new StudioError(`Sending didn't sign in: ${(e as Error).message}. Nothing was saved.`, 400, "smtp"); }
    try { await imapLogin(dial, { host: next.imapHost, port: next.imapPort, user: next.user, pass }); }
    catch (e) { throw new StudioError(`Reading replies didn't sign in: ${(e as Error).message}. Nothing was saved.`, 400, "imap"); }
  }
  await setMeta(env, "outreach_sender", JSON.stringify(next));
  if (newPass) {
    await env.DB.prepare(`INSERT INTO key_overrides (name, sealed, last4, set_at, set_by) VALUES ('OUTREACH_SMTP_PASS', ?, ?, ${NOW}, ?)
        ON CONFLICT(name) DO UPDATE SET sealed = excluded.sealed, last4 = excluded.last4, set_at = excluded.set_at, set_by = excluded.set_by`)
      .bind(await sealKey(env.INTERNAL_SECRET, "OUTREACH_SMTP_PASS", newPass), last4(newPass), adminId).run();
    forgetKeys();
  }
  await env.DB.prepare("DELETE FROM studio_meta WHERE key IN ('outreach_paused', 'outreach_paused_at')").run();
  await audit(asEnv(env), adminId, null, "admin.outreach_sender", { from: next.fromAddr, smtp: next.smtpHost, password: newPass ? last4(newPass) : null });
  return { ok: true, tested: !!pass };
}

export async function setOutreachMode(env: StudioEnv, adminId: string, on: boolean): Promise<unknown> {
  if (on) {
    const r = await readiness(env);
    if (!r.ok) throw new StudioError(!r.sender ? "Set the sender first." : !r.password ? "Add the mailbox's app password first." : !r.postal ? "Add the postal address first: the law wants it in every e-mail." : "Approve some prospects first.", 400, "not_ready");
  }
  await setMeta(env, "outreach_mode", on ? "on" : "off");
  await audit(asEnv(env), adminId, null, "admin.outreach_mode", { on });
  return { ok: true, on };
}

/** The first e-mail for a sample prospect, through the real mailbox, to the sender's own address. */
export async function sendOutreachTest(env: StudioEnv, deps: OutreachDeps = {}): Promise<unknown> {
  const s = await senderOf(env);
  if (!s.fromAddr || !passOf(env)) throw new StudioError("Set the sender and its app password first.", 400, "not_ready");
  const p = await env.DB.prepare("SELECT * FROM outreach_prospects WHERE status IN ('new', 'approved') ORDER BY RANDOM() LIMIT 1").first<Prospect>();
  const sample: Prospect = p ?? { id: "p_sample", email: s.fromAddr, domain: "", company: "Sample Agency", website: null, country: "US", region: null, city: "Austin", type: "social-media-agency",
    contact_name: "Sam", source_url: "https://example.com/contact", opener: null, fit_reason: null, status: "new", step: 0, next_at: null, tz: null, thread_id: null, subject: null, batch: null };
  const w = writeStep({ ...sample, email: sample.email }, 0, { ...s, postal: s.postal || "[postal address]" }, await outreachStopLink(env, sample.id));
  const raw = buildMime({ fromName: s.fromName, fromAddr: s.fromAddr, to: s.fromAddr, subject: `[Test, as ${sample.company} would get it] ${w.subject}`, text: w.text, messageId: messageId(s) });
  await smtpSend(deps.dial ?? socketDial, { host: s.smtpHost, port: s.smtpPort, user: s.user, pass: passOf(env) }, { from: s.fromAddr, to: s.fromAddr, raw });
  return { ok: true, to: s.fromAddr };
}
