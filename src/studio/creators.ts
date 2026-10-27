/**
 * KLEO STUDIO — KLEO CREATORS (28 October 2026, the owner: "un contratto … per far favorire agli altri di kleo …
 * esattamente come fa higgsfield", then "uno non può entrare a caso, sai quanti scammer ci sono … se li facciamo pagare
 * è meglio"). The program's rules are kleo\marketing\creators\PROGRAM.md and the agreement kleooai.com/creators/agreement.html.
 *
 * PAY UNTIL YOU PROVE IT. Every creator is a paying customer first: applying needs a running paid plan (Lite or higher),
 * the owner reviews every application by hand, and the social account is proved with a code placed in its bio. Kleo
 * gives more only for posts that really went out (the owner reads each one's views at day 7), and a free plan only at
 * the top level, when the people a creator brought in pay for it.
 *
 *   creators             one row per applicant: the application, the checks, the level, the link, the payout choice
 *   creator_posts        every post a creator sent: its link, its month, the views read at day 7, the bonus it earned
 *   creator_credits      every grant of PROGRAM CREDITS: the +50% of a month, a view bonus, a commission taken as credits,
 *                        a level's monthly credits; each expires 90 days after it was granted
 *   creator_commissions  one row per payment made by somebody who opened their account through a creator's link
 *   creator_payouts      the cash the owner sent a creator, with its reference
 *
 * PROGRAM CREDITS ARE SPENT FIRST. They are ordinary credits (users.credits) and also counted in users.program_credits.
 * A trigger takes every decrease of users.credits off program_credits first, so it is always the part of the balance
 * that came from the program and is not yet spent. At expiry only what is left of a grant goes, never a purchased credit.
 * Without the trigger (a database that refused it) nothing ever expires.
 *
 * MONEY. Commission is a share of what a referred person paid, net of an estimate of Stripe's fee, for 12 months after
 * that person's sign-up. Taken as credits it is paid at once, at 1.5x its value in pack credits; taken as cash it waits
 * 60 days (refunds and chargebacks), and the owner pays it by PayPal or Wise from 50 EUR. A refund or a dispute takes
 * back what that payment earned. A buyer who shares an address, a sign-in place or an inbox with the creator earns nothing.
 *
 * THE MONTH (creatorsTick, hourly): on the 1st, each level's monthly credits (Partner: Starter's 50 on top of the paid
 * plan's own; Pro partner: a Pro plan at no charge, 110 credits); on the 8th, last month is judged: enough posts gives the
 * +50%, a full month without them moves the creator one level down, and two in a row end the place in the program.
 */
import type { StudioEnv } from "./env.ts";
import type { Env } from "../env";
import { audit } from "../db.ts";
import { rid } from "../util.ts";
import { StudioError, isAdmin } from "./generate.ts";
import { CODE_RE } from "./attribution.ts";
import { PROGRAM_TRIGGER } from "./creators-schema.ts";
export { CREATORS_COLUMNS, CREATORS_SCHEMA, CREATORS_TRIGGER, PROGRAM_TRIGGER, compPlanActive } from "./creators-schema.ts";

const asEnv = (env: StudioEnv): Env => env as unknown as Env;
const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
/** The app's own address, for a creator's /r/ link (the same rule as admin.ts linkBase). */
const linkBase = (env: StudioEnv): string => `https://${(env.CANONICAL_HOST ?? "").trim() || "app.kleooai.com"}`;

// ── the rules, in one place ───────────────────────────────────────────────────────────────────────────────────────

export const TERMS_VERSION = "2026-10-28";
export const AGREEMENT_URL = "https://kleooai.com/creators/agreement.html";

export type Level = "creator" | "partner" | "pro";
export const LEVELS: Record<Level, { name: string; posts: number; rateBp: number; boost: number; monthly: number; comp: boolean }> = {
  // posts: eligible posts a month; rateBp: commission in basis points; boost: share of the month's base credits added in a
  // month with the posts; monthly: credits a level grants each month (Partner: Starter's 50 in all, the plan's own counted).
  creator: { name: "Creator", posts: 2, rateBp: 2500, boost: 0.5, monthly: 0, comp: false },
  partner: { name: "Partner", posts: 4, rateBp: 3000, boost: 0.5, monthly: 50, comp: false },
  pro: { name: "Pro partner", posts: 4, rateBp: 3500, boost: 0, monthly: 110, comp: true },
};
export const LEVEL_KEYS = Object.keys(LEVELS) as Level[];
export const isLevel = (v: unknown): v is Level => LEVEL_KEYS.includes(v as Level);

/** View bonuses read at day 7, highest first: [views reached, credits]. */
export const VIEW_BONUSES: [number, number][] = [[100_000, 80], [50_000, 40], [10_000, 15]];
export const BONUS_CAP_MONTH = 150;
export const PROGRAM_DAYS = 90;
export const HOLD_DAYS = 60;
export const MIN_CASH_CENT = 5000;
export const COMMISSION_MONTHS = 12;
/** What one credit is worth when commission is taken as credits: the smallest pack, 10 credits for 5 EUR. */
export const CREDIT_CENT = 50;
export const CREDIT_MULTIPLIER = 1.5;
/** Stripe's fee, estimated (2.9% + 30 cents): commission is paid on what reached Kleo, not on the sticker price. */
export const netOf = (cents: number): number => Math.max(0, cents - Math.round(cents * 0.029) - 30);
export const JUDGE_DAY = 8;
export const MAX_PENDING_POSTS = 12;

/** The entry thresholds (PROGRAM.md, entry rules). */
export const ENTRY = { minFollowers: 1000, orViews: 10_000, minAccountMonths: 6, minAiPosts: 9, maxUsernameChanges: 2 };

export type Platform = "instagram" | "tiktok" | "youtube" | "x";
export const PLATFORMS: Record<Platform, { name: string; hosts: RegExp; profile: (h: string) => string }> = {
  instagram: { name: "Instagram", hosts: /(^|\.)instagram\.com$/i, profile: (h) => `https://www.instagram.com/${h}/` },
  tiktok: { name: "TikTok", hosts: /(^|\.)tiktok\.com$/i, profile: (h) => `https://www.tiktok.com/@${h}` },
  youtube: { name: "YouTube", hosts: /(^|\.)(youtube\.com|youtu\.be)$/i, profile: (h) => `https://www.youtube.com/@${h}` },
  x: { name: "X", hosts: /(^|\.)(x\.com|twitter\.com)$/i, profile: (h) => `https://x.com/${h}` },
};
const isPlatform = (v: unknown): v is Platform => typeof v === "string" && v in PLATFORMS;

/** The bonus a post's day-7 views earn, before the monthly cap. */
export function bonusFor(views: number): number {
  for (const [at, credits] of VIEW_BONUSES) if (views >= at) return credits;
  return 0;
}
/** "2026-10" for a moment, in UTC. */
export const monthOf = (ms: number): string => iso(ms).slice(0, 7);
/** The first moment of a month ("2026-10") and of the one after it. */
export const monthStart = (m: string): number => Date.parse(`${m}-01T00:00:00.000Z`);
export const nextMonth = (m: string): string => { const d = new Date(monthStart(m)); d.setUTCMonth(d.getUTCMonth() + 1); return monthOf(d.getTime()); };
export const prevMonth = (m: string): string => { const d = new Date(monthStart(m)); d.setUTCMonth(d.getUTCMonth() - 1); return monthOf(d.getTime()); };

/** A handle as people type it ("@Kleo.Ai", a profile link) reduced to the name itself. */
export function cleanHandle(platform: Platform, raw: unknown): string {
  let s = String(raw ?? "").trim();
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      if (!PLATFORMS[platform].hosts.test(u.hostname)) return "";
      s = u.pathname.split("/").filter(Boolean)[0] ?? "";
    }
  } catch { return ""; }
  s = s.replace(/^@+/, "").trim();
  return /^[A-Za-z0-9._-]{2,40}$/.test(s) ? s : "";
}

/** A post's address, checked against the creator's network, and its key (no query, no trailing slash, lower case). */
export function postAddress(platform: Platform, raw: unknown): { url: string; key: string } | null {
  let u: URL;
  try { u = new URL(String(raw ?? "").trim()); } catch { return null; }
  if (u.protocol !== "https:" || !PLATFORMS[platform].hosts.test(u.hostname) || u.pathname.length < 3) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|vm|vt)\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  // A YouTube watch link keeps its video id; every other query (tracking tags) goes.
  const v = host.endsWith("youtube.com") && path === "/watch" ? u.searchParams.get("v") : null;
  const url = `https://${u.hostname}${u.pathname}${v ? `?v=${v}` : ""}`.slice(0, 400);
  return { url, key: `${host}${path}${v ? `?v=${v}` : ""}`.toLowerCase().slice(0, 400) };
}

/** Why an application is refused at once by the entry thresholds, or [] when it passes them. Public wording. */
export function entryProblems(a: { followers: number; bestViews: number; accountSince: string; aiPosts: number; usernameChanges: number }, nowMs = Date.now()): string[] {
  const out: string[] = [];
  if (a.followers < ENTRY.minFollowers && a.bestViews < ENTRY.orViews) out.push(`The account needs ${ENTRY.minFollowers.toLocaleString("en-GB")} followers, or a post with ${ENTRY.orViews.toLocaleString("en-GB")} views.`);
  const since = Date.parse(`${a.accountSince}-01T00:00:00.000Z`);
  const months = Number.isFinite(since) ? (nowMs - since) / (30.44 * DAY_MS) : 0;
  if (months < ENTRY.minAccountMonths) out.push(`The account needs to be at least ${ENTRY.minAccountMonths} months old.`);
  if (a.aiPosts < ENTRY.minAiPosts) out.push(`The account needs at least ${ENTRY.minAiPosts} posts of your own AI work.`);
  if (a.usernameChanges > ENTRY.maxUsernameChanges) out.push(`Accounts that changed their username more than ${ENTRY.maxUsernameChanges} times can't join.`);
  return out;
}

// ── tables ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CreatorRow {
  user_id: string; status: "applied" | "refused" | "active" | "paused" | "ended" | "banned"; level: Level;
  platform: Platform; handle: string; handle_key: string; profile_url: string;
  name: string | null; country: string | null; followers: number | null; best_views: number | null; account_since: string | null;
  ai_posts: number | null; username_changes: number | null; best_url: string | null; about: string | null; flags: string | null;
  bio_code: string; bio_seen_at: string | null; link_code: string | null; terms_version: string; terms_at: string;
  payout_pref: "credits" | "cash"; payout_email: string | null; invited: number; applied_at: string; decided_at: string | null;
  decided_by: string | null; refuse_reason: string | null; approved_at: string | null; level_since: string | null; misses: number;
  comp_until: string | null; ended_at: string | null; end_reason: string | null; notes: string | null; updated_at: string;
}

const creatorOf = (env: StudioEnv, userId: string) =>
  env.DB.prepare("SELECT * FROM creators WHERE user_id = ?").bind(userId).first<CreatorRow>();

/** A running PAID plan (Stripe), not the one the program gives. */
export async function paidPlanOf(env: StudioEnv, userId: string): Promise<{ plan: string; credits: number } | null> {
  const r = await env.DB.prepare("SELECT plan, plan_credits, plan_until FROM users WHERE id = ?").bind(userId)
    .first<{ plan: string | null; plan_credits: number | null; plan_until: string | null }>().catch(() => null);
  if (!r?.plan || r.plan === "trial" || !r.plan_until || Date.parse(r.plan_until) <= Date.now()) return null;
  return { plan: r.plan, credits: Number(r.plan_credits) || 0 };
}
// ── program credits ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Grants program credits once per (account, kind, ref): the lot row and the balance move in one batch, and the balance
 * moves only when the lot was new. Returns the credits granted (0 when that grant was already made).
 */
export async function grantProgram(env: StudioEnv, userId: string, kind: string, ref: string, amount: number, note: string, nowMs = Date.now()): Promise<number> {
  const n = Math.max(0, Math.floor(amount));
  if (!n) return 0;
  const id = rid("cc", 12);
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO creator_credits (id, user_id, kind, ref, amount, left_amount, granted_at, expires_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, userId, kind, ref, n, n, iso(nowMs), iso(nowMs + PROGRAM_DAYS * DAY_MS), note.slice(0, 200)),
    env.DB.prepare("UPDATE users SET credits = credits + ?, program_credits = program_credits + ? WHERE id = ? AND EXISTS (SELECT 1 FROM creator_credits WHERE id = ?)")
      .bind(n, n, userId, id),
  ]);
  const made = await env.DB.prepare("SELECT 1 AS one FROM creator_credits WHERE id = ?").bind(id).first();
  if (!made) return 0;
  await audit(asEnv(env), userId, null, "creator.credits", { kind, ref, credits: n, note, expires: iso(nowMs + PROGRAM_DAYS * DAY_MS) });
  return n;
}

/**
 * What is left of each live grant, spent first-to-expire-first: the account's program_credits say how many program
 * credits are unspent, and the grants are drawn down in order of expiry until they add up to it.
 */
async function settleLots(env: StudioEnv, userId: string): Promise<void> {
  const left = (await env.DB.prepare("SELECT program_credits AS p FROM users WHERE id = ?").bind(userId).first<{ p: number }>())?.p ?? 0;
  const lots = (await env.DB.prepare("SELECT id, left_amount FROM creator_credits WHERE user_id = ? AND expired_at IS NULL AND left_amount > 0 ORDER BY expires_at, granted_at")
    .bind(userId).all<{ id: string; left_amount: number }>()).results;
  let spent = Math.max(0, lots.reduce((a, l) => a + l.left_amount, 0) - Math.max(0, left));
  for (const l of lots) {
    if (spent <= 0) break;
    const take = Math.min(l.left_amount, spent);
    spent -= take;
    await env.DB.prepare("UPDATE creator_credits SET left_amount = left_amount - ? WHERE id = ?").bind(take, l.id).run();
  }
}

/** Takes back what is left of one grant (a refunded commission, a banned creator), never more than the balance. */
async function takeBackLot(env: StudioEnv, lotId: string, why: string): Promise<number> {
  const lot = await env.DB.prepare("SELECT user_id, left_amount FROM creator_credits WHERE id = ? AND expired_at IS NULL").bind(lotId).first<{ user_id: string; left_amount: number }>();
  if (!lot) return 0;
  await settleLots(env, lot.user_id);
  const fresh = await env.DB.prepare("SELECT left_amount FROM creator_credits WHERE id = ?").bind(lotId).first<{ left_amount: number }>();
  const n = Math.max(0, fresh?.left_amount ?? 0);
  // The trigger takes the decrease off program_credits.
  if (n) await env.DB.prepare("UPDATE users SET credits = MAX(0, credits - ?) WHERE id = ?").bind(n, lot.user_id).run();
  await env.DB.prepare(`UPDATE creator_credits SET left_amount = 0, taken = taken + ?, expired_at = ${NOW}, note = COALESCE(note, '') || ? WHERE id = ?`).bind(n, ` · taken back: ${why}`.slice(0, 120), lotId).run();
  if (n) await audit(asEnv(env), lot.user_id, null, "creator.credits_taken", { lot: lotId, credits: n, why });
  return n;
}

async function triggerReady(env: StudioEnv): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'trigger' AND name = ?").bind(PROGRAM_TRIGGER).first().catch(() => null));
}

/** Grants past their 90 days: what is left of each goes. Only with the trigger in place (see the header). */
export async function expireProgramCredits(env: StudioEnv, nowMs = Date.now()): Promise<number> {
  if (!(await triggerReady(env))) return 0;
  const users = (await env.DB.prepare("SELECT DISTINCT user_id FROM creator_credits WHERE expired_at IS NULL AND expires_at <= ? LIMIT 50").bind(iso(nowMs)).all<{ user_id: string }>()).results;
  let gone = 0;
  for (const { user_id } of users) {
    await settleLots(env, user_id);
    const due = (await env.DB.prepare("SELECT id, left_amount FROM creator_credits WHERE user_id = ? AND expired_at IS NULL AND expires_at <= ?").bind(user_id, iso(nowMs)).all<{ id: string; left_amount: number }>()).results;
    for (const l of due) {
      if (l.left_amount > 0) await env.DB.prepare("UPDATE users SET credits = MAX(0, credits - ?) WHERE id = ?").bind(l.left_amount, user_id).run();
      await env.DB.prepare("UPDATE creator_credits SET taken = taken + left_amount, left_amount = 0, expired_at = ? WHERE id = ?").bind(iso(nowMs), l.id).run();
      if (l.left_amount > 0) { gone += l.left_amount; await audit(asEnv(env), user_id, null, "creator.credits_expired", { lot: l.id, credits: l.left_amount }); }
    }
  }
  return gone;
}

// ── the applicant's and creator's side ────────────────────────────────────────────────────────────────────────────

const str = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const whole = (v: unknown, lo: number, hi: number): number | null => {
  const n = Math.floor(Number(String(v ?? "").replace(/[\s,.'’]/g, "")));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

/** Another program seat held by the same person: the same inbox or the same sign-up address. */
async function sharedSeat(env: StudioEnv, userId: string): Promise<string | null> {
  const r = await env.DB.prepare(`SELECT c.user_id FROM creators c JOIN users o ON o.id = c.user_id JOIN users me ON me.id = ?1
      WHERE c.user_id != ?1 AND c.status != 'refused'
        AND ((me.email_canon IS NOT NULL AND o.email_canon = me.email_canon) OR (me.ip_hash IS NOT NULL AND o.ip_hash = me.ip_hash)) LIMIT 1`)
    .bind(userId).first<{ user_id: string }>().catch(() => null);
  return r?.user_id ?? null;
}
/** Program accounts that signed in from one of this account's addresses (a flag for the owner, never a refusal alone). */
async function sharedPlaces(env: StudioEnv, userId: string): Promise<string[]> {
  const rows = (await env.DB.prepare(`SELECT DISTINCT b.user_id FROM studio_ips a JOIN studio_ips b ON b.ip_hash = a.ip_hash AND b.user_id != a.user_id
      JOIN creators c ON c.user_id = b.user_id WHERE a.user_id = ? AND a.ip_hash IS NOT NULL LIMIT 5`).bind(userId).all<{ user_id: string }>().catch(() => ({ results: [] as { user_id: string }[] }))).results;
  return rows.map((r) => r.user_id);
}
/** The country the account's latest card or wallet payment came from (Stripe's billing country). */
async function payCountry(env: StudioEnv, userId: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT country FROM payments WHERE user_id = ? AND status = 'paid' AND amount_cent > 0 AND country IS NOT NULL ORDER BY at DESC LIMIT 1").bind(userId).first<{ country: string }>().catch(() => null);
  return r?.country ? r.country.toUpperCase() : null;
}

export async function applyAsCreator(env: StudioEnv, userId: string, b: Record<string, unknown>, nowMs = Date.now()): Promise<Record<string, unknown>> {
  const plan = await paidPlanOf(env, userId);
  if (!plan && !isAdmin(env, userId)) throw new StudioError("Kleo Creators starts with a plan. Pick Lite or higher, then apply.", 402, "creator_plan");
  const old = await creatorOf(env, userId);
  if (old && old.status !== "refused") throw new StudioError("You've already applied.", 409, "creator_exists");
  if (old && Date.parse(old.decided_at ?? old.applied_at) > nowMs - 30 * DAY_MS) throw new StudioError("You can apply again 30 days after the last answer.", 429, "creator_wait");
  if (b.accept !== true) throw new StudioError("Read and accept the Kleo Creator Agreement first.", 400, "creator_terms");
  if (!isPlatform(b.platform)) throw new StudioError("Pick the network of your account.", 400, "creator_platform");
  const platform = b.platform;
  const handle = cleanHandle(platform, b.handle);
  if (!handle) throw new StudioError(`Type your ${PLATFORMS[platform].name} username, like @yourname.`, 400, "creator_handle");
  const followers = whole(b.followers, 0, 1_000_000_000), bestViews = whole(b.bestViews ?? 0, 0, 10_000_000_000), aiPosts = whole(b.aiPosts, 0, 100_000), changes = whole(b.usernameChanges ?? 0, 0, 1000);
  const since = str(b.accountSince, 7);
  if (followers === null || bestViews === null || aiPosts === null || changes === null || !/^(19|20)\d\d-(0[1-9]|1[0-2])$/.test(since)) {
    throw new StudioError("Fill in every number about your account.", 400, "creator_numbers");
  }
  const country = str(b.country, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new StudioError("Pick your country.", 400, "creator_country");
  let bestUrl = "";
  const best = postAddress(platform, b.bestUrl);
  if (best) bestUrl = best.url; else throw new StudioError(`Paste the link of your best AI post on ${PLATFORMS[platform].name}.`, 400, "creator_best");
  const name = str(b.name, 80), about = str(b.about, 600);
  if (name.length < 2) throw new StudioError("Type your name.", 400, "creator_name");

  const taken = await env.DB.prepare("SELECT user_id FROM creators WHERE platform = ? AND handle_key = ?").bind(platform, handle.toLowerCase()).first<{ user_id: string }>();
  if (taken && taken.user_id !== userId) throw new StudioError("That account is already in Kleo Creators.", 409, "creator_handle_taken");

  // Refused at once: the thresholds (said to the person), another seat of the same person or a payment from another
  // country (not said: that would teach a scammer which check to dodge).
  const public_ = entryProblems({ followers, bestViews, accountSince: since, aiPosts, usernameChanges: changes }, nowMs);
  const flags: string[] = [];
  const seat = await sharedSeat(env, userId);
  if (seat) flags.push(`seat:${seat}`);
  const paidFrom = await payCountry(env, userId);
  if (paidFrom && paidFrom !== country) flags.push(`country:${paidFrom}`);
  for (const other of await sharedPlaces(env, userId)) flags.push(`place:${other}`);
  const hard = public_.length > 0 || flags.some((f) => f.startsWith("seat:") || f.startsWith("country:"));
  const status = hard ? "refused" : "applied";
  const refuse = public_.length ? public_.join(" ") : hard ? "auto: " + flags.filter((f) => !f.startsWith("place:")).join(", ") : null;
  const code = `KLEO-${rid("k", 6).slice(2).toUpperCase()}`;
  await env.DB.prepare(`INSERT INTO creators (user_id, status, level, platform, handle, handle_key, profile_url, name, country, followers, best_views, account_since,
      ai_posts, username_changes, best_url, about, flags, bio_code, terms_version, terms_at, applied_at, decided_at, decided_by, refuse_reason, updated_at)
      VALUES (?1, ?2, 'creator', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?19, ?20, ?21, ?22, ?19)
      ON CONFLICT (user_id) DO UPDATE SET status = excluded.status, level = 'creator', platform = excluded.platform, handle = excluded.handle,
        handle_key = excluded.handle_key, profile_url = excluded.profile_url, name = excluded.name, country = excluded.country,
        followers = excluded.followers, best_views = excluded.best_views, account_since = excluded.account_since, ai_posts = excluded.ai_posts,
        username_changes = excluded.username_changes, best_url = excluded.best_url, about = excluded.about, flags = excluded.flags,
        bio_code = excluded.bio_code, bio_seen_at = NULL, terms_version = excluded.terms_version, terms_at = excluded.terms_at,
        applied_at = excluded.applied_at, decided_at = excluded.decided_at, decided_by = excluded.decided_by, refuse_reason = excluded.refuse_reason,
        updated_at = excluded.updated_at`)
    .bind(userId, status, platform, handle, handle.toLowerCase(), PLATFORMS[platform].profile(handle), name, country, followers, bestViews, since,
      aiPosts, changes, bestUrl, about || null, flags.length ? flags.join(" ") : null, code, TERMS_VERSION, iso(nowMs),
      hard ? iso(nowMs) : null, hard ? "auto" : null, refuse).run();
  await audit(asEnv(env), userId, null, hard ? "creator.refused_auto" : "creator.applied", { platform, handle, followers, flags, refuse, terms: TERMS_VERSION });
  return creatorStatus(env, userId, nowMs);
}

/** A post the creator made: its link, once, on the creator's own network; at most MAX_PENDING_POSTS waiting. */
export async function addPost(env: StudioEnv, userId: string, b: Record<string, unknown>, nowMs = Date.now()): Promise<Record<string, unknown>> {
  const c = await creatorOf(env, userId);
  if (!c || (c.status !== "active" && c.status !== "paused")) throw new StudioError("Only Kleo Creators can send posts.", 403, "creator_not");
  const a = postAddress(c.platform, b.url);
  if (!a) throw new StudioError(`Paste the link of a post on ${PLATFORMS[c.platform].name}.`, 400, "creator_post_url");
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM creator_posts WHERE user_id = ? AND status = 'pending'").bind(userId).first<{ n: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING_POSTS) throw new StudioError("Wait until Kleo has checked your posts before sending more.", 429, "creator_post_many");
  let gen: string | null = null;
  if (typeof b.generationId === "string" && b.generationId) {
    const g = await env.DB.prepare("SELECT id FROM studio_generations WHERE id = ? AND user_id = ? AND status = 'done'").bind(b.generationId, userId).first<{ id: string }>();
    if (!g) throw new StudioError("Pick one of your own finished creations.", 400, "creator_post_gen");
    gen = g.id;
  }
  const id = rid("cp", 12);
  const r = await env.DB.prepare("INSERT OR IGNORE INTO creator_posts (id, user_id, url, url_key, generation_id, month, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, userId, a.url, a.key, gen, monthOf(nowMs), iso(nowMs)).run();
  if (!r.meta?.changes) throw new StudioError("That post was already sent.", 409, "creator_post_dupe");
  await audit(asEnv(env), userId, null, "creator.post", { post: id, url: a.url, generation: gen });
  return creatorStatus(env, userId, nowMs);
}

export async function removePost(env: StudioEnv, userId: string, postId: string): Promise<void> {
  const r = await env.DB.prepare("DELETE FROM creator_posts WHERE id = ? AND user_id = ? AND status = 'pending'").bind(postId, userId).run();
  if (!r.meta?.changes) throw new StudioError("Only a post Kleo hasn't checked yet can be removed.", 400, "creator_post_locked");
}

export async function setPayout(env: StudioEnv, userId: string, b: Record<string, unknown>): Promise<void> {
  const c = await creatorOf(env, userId);
  if (!c || !["active", "paused"].includes(c.status)) throw new StudioError("Only Kleo Creators can choose this.", 403, "creator_not");
  const pref = b.pref === "cash" ? "cash" : "credits";
  const email = str(b.email, 200).toLowerCase();
  if (pref === "cash" && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) throw new StudioError("Type the PayPal or Wise e-mail where the money goes.", 400, "creator_payout_email");
  await env.DB.prepare(`UPDATE creators SET payout_pref = ?, payout_email = COALESCE(?, payout_email), updated_at = ${NOW} WHERE user_id = ?`).bind(pref, pref === "cash" ? email : null, userId).run();
  await audit(asEnv(env), userId, null, "creator.payout_pref", { pref });
}

export async function leaveProgram(env: StudioEnv, userId: string): Promise<void> {
  const c = await creatorOf(env, userId);
  if (!c) throw new StudioError("You're not in Kleo Creators.", 404, "creator_not");
  if (c.status === "applied") {
    await env.DB.prepare("DELETE FROM creators WHERE user_id = ? AND status = 'applied'").bind(userId).run();
  } else if (c.status === "active" || c.status === "paused") {
    await env.DB.prepare(`UPDATE creators SET status = 'ended', ended_at = ${NOW}, end_reason = 'left', comp_until = NULL, updated_at = ${NOW} WHERE user_id = ?`).bind(userId).run();
  } else return;
  await audit(asEnv(env), userId, null, "creator.left", { was: c.status });
}

/** Counts that both sides show: posts this month, people through the link, commission by state. */
async function creatorFigures(env: StudioEnv, c: CreatorRow, nowMs: number) {
  const month = monthOf(nowMs);
  const posts = await env.DB.prepare("SELECT status, COUNT(*) AS n, COALESCE(SUM(bonus), 0) AS bonus FROM creator_posts WHERE user_id = ? AND month = ? GROUP BY status").bind(c.user_id, month).all<{ status: string; n: number; bonus: number }>();
  const byStatus = Object.fromEntries(posts.results.map((p) => [p.status, p]));
  const counted = (byStatus.eligible?.n ?? 0) + (byStatus.pending?.n ?? 0);
  const people = c.link_code ? await env.DB.prepare(`SELECT COUNT(*) AS signups,
      COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM payments p WHERE p.user_id = a.user_id AND p.status = 'paid' AND p.amount_cent > 0) THEN a.user_id END) AS paying
      FROM user_attribution a JOIN users u ON u.id = a.user_id WHERE a.link_code = ? AND u.created_at >= ?`).bind(c.link_code, c.approved_at ?? c.applied_at).first<{ signups: number; paying: number }>() : null;
  const money = (await env.DB.prepare("SELECT status, COALESCE(SUM(commission_cent), 0) AS cents, COALESCE(SUM(credits), 0) AS credits, COUNT(*) AS n FROM creator_commissions WHERE creator_id = ? GROUP BY status").bind(c.user_id).all<{ status: string; cents: number; credits: number; n: number }>()).results;
  const m = Object.fromEntries(money.map((r) => [r.status, r]));
  const program = await env.DB.prepare(`SELECT u.program_credits AS left_, (SELECT MIN(expires_at) FROM creator_credits l WHERE l.user_id = u.id AND l.expired_at IS NULL AND l.left_amount > 0) AS next
      FROM users u WHERE u.id = ?`).bind(c.user_id).first<{ left_: number; next: string | null }>();
  return {
    month, posts: { needed: LEVELS[c.level].posts, counted, eligible: byStatus.eligible?.n ?? 0, pending: byStatus.pending?.n ?? 0, rejected: byStatus.rejected?.n ?? 0, bonus: byStatus.eligible?.bonus ?? 0, bonusCap: BONUS_CAP_MONTH },
    people: { signups: people?.signups ?? 0, paying: people?.paying ?? 0 },
    commission: {
      heldCents: m.held?.cents ?? 0, readyCents: m.ready?.cents ?? 0, paidCents: m.paid_out?.cents ?? 0, creditedCents: m.credited?.cents ?? 0,
      credits: m.credited?.credits ?? 0, minCashCents: MIN_CASH_CENT,
    },
    programCredits: { left: Math.max(0, program?.left_ ?? 0), nextExpiry: program?.next ?? null },
  };
}

/** What the /creators page reads: the rules, and this account's application or place in the program. */
export async function creatorStatus(env: StudioEnv, userId: string, nowMs = Date.now()): Promise<Record<string, unknown>> {
  const c = await creatorOf(env, userId);
  const plan = await paidPlanOf(env, userId);
  const out: Record<string, unknown> = { plan: plan ? plan.plan : null, terms: { version: TERMS_VERSION, url: AGREEMENT_URL }, rules: publicRules() };
  if (!c) return { ...out, state: "none" };
  const base = { state: c.status, platform: c.platform, handle: c.handle, profileUrl: c.profile_url, appliedAt: c.applied_at };
  if (c.status === "refused") {
    // The thresholds are said; an automatic refusal for a shared seat or another country is not (see applyAsCreator).
    const said = c.refuse_reason && !c.refuse_reason.startsWith("auto:") && c.decided_by === "auto" ? c.refuse_reason : null;
    return { ...out, ...base, decidedAt: c.decided_at, why: said, againAt: iso(Date.parse(c.decided_at ?? c.applied_at) + 30 * DAY_MS) };
  }
  if (c.status === "applied") return { ...out, ...base, bioCode: c.bio_code, bioSeen: !!c.bio_seen_at };
  const posts = (await env.DB.prepare("SELECT id, url, generation_id, month, status, views, bonus, reason, created_at, checked_at FROM creator_posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 40")
    .bind(userId).all()).results;
  const base_ = linkBase(env);
  return {
    ...out, ...base, level: c.level, levelName: LEVELS[c.level].name, levelSince: c.level_since, approvedAt: c.approved_at,
    misses: c.misses, compUntil: c.comp_until, payout: { pref: c.payout_pref, email: c.payout_email },
    link: c.link_code ? `${base_}/r/${c.link_code}` : null, endedAt: c.ended_at, endReason: c.end_reason === "left" ? "You left the program." : c.end_reason ? "Your place in the program ended." : null,
    figures: await creatorFigures(env, c, nowMs), posts,
    rate: LEVELS[c.level].rateBp / 100,
  };
}

/** The numbers the page explains, from the same constants the server applies. */
export function publicRules(): Record<string, unknown> {
  return {
    levels: LEVEL_KEYS.map((k) => ({ key: k, name: LEVELS[k].name, posts: LEVELS[k].posts, rate: LEVELS[k].rateBp / 100, boost: LEVELS[k].boost, monthly: LEVELS[k].monthly, comp: LEVELS[k].comp })),
    bonuses: VIEW_BONUSES.map(([views, credits]) => ({ views, credits })), bonusCap: BONUS_CAP_MONTH, programDays: PROGRAM_DAYS,
    holdDays: HOLD_DAYS, minCash: MIN_CASH_CENT / 100, creditMultiplier: CREDIT_MULTIPLIER, months: COMMISSION_MONTHS, entry: ENTRY,
    platforms: (Object.keys(PLATFORMS) as Platform[]).map((k) => ({ key: k, name: PLATFORMS[k].name })),
  };
}

/** The creators in the program, for the public list ("the list of real Kleo creators is on kleooai.com/creators"). */
export async function publicCreators(env: StudioEnv): Promise<Record<string, unknown>> {
  const rows = (await env.DB.prepare("SELECT platform, handle, profile_url, level FROM creators WHERE status IN ('active', 'paused') ORDER BY CASE level WHEN 'pro' THEN 0 WHEN 'partner' THEN 1 ELSE 2 END, approved_at LIMIT 300")
    .all<{ platform: Platform; handle: string; profile_url: string; level: Level }>().catch(() => ({ results: [] as { platform: Platform; handle: string; profile_url: string; level: Level }[] }))).results;
  return { creators: rows.map((r) => ({ platform: r.platform, network: PLATFORMS[r.platform]?.name ?? r.platform, handle: r.handle, url: r.profile_url, level: LEVELS[r.level]?.name ?? "Creator" })) };
}

// ── the owner's side (the admin console's Creators page; admin.ts routes here) ────────────────────────────────────

const ADMIN_LIST_COLS = `c.*, u.credits, u.program_credits, u.plan, u.plan_until, u.created_at AS account_at,
  COALESCE((SELECT l.email FROM studio_logins l WHERE l.user_id = u.id AND l.email IS NOT NULL ORDER BY l.created_at LIMIT 1), CASE WHEN u.email LIKE '%.invalid' THEN NULL ELSE u.email END) AS email,
  (SELECT COALESCE(SUM(p.amount_cent), 0) FROM payments p WHERE p.user_id = u.id AND p.status = 'paid' AND p.amount_cent > 0) AS paid_cents`;

export async function adminCreators(env: StudioEnv, nowMs = Date.now()): Promise<Record<string, unknown>> {
  const all = async <T = Record<string, any>>(sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).all<T>()).results;
  const day7 = iso(nowMs - 7 * DAY_MS);
  const [applied, members, closed, posts, due, counts] = await Promise.all([
    all(`SELECT ${ADMIN_LIST_COLS} FROM creators c JOIN users u ON u.id = c.user_id WHERE c.status = 'applied' ORDER BY c.applied_at LIMIT 100`),
    all(`SELECT ${ADMIN_LIST_COLS},
        (SELECT COUNT(*) FROM creator_posts p WHERE p.user_id = c.user_id AND p.month = ?1 AND p.status IN ('eligible', 'pending')) AS posts_month,
        (SELECT COUNT(*) FROM user_attribution a WHERE a.link_code = c.link_code) AS signups
      FROM creators c JOIN users u ON u.id = c.user_id WHERE c.status IN ('active', 'paused') ORDER BY CASE c.level WHEN 'pro' THEN 0 WHEN 'partner' THEN 1 ELSE 2 END, c.approved_at LIMIT 300`, monthOf(nowMs)),
    all(`SELECT ${ADMIN_LIST_COLS} FROM creators c JOIN users u ON u.id = c.user_id WHERE c.status IN ('refused', 'ended', 'banned') ORDER BY COALESCE(c.ended_at, c.decided_at, c.applied_at) DESC LIMIT 40`),
    all(`SELECT p.*, c.handle, c.platform, c.level, c.status AS creator_status FROM creator_posts p JOIN creators c ON c.user_id = p.user_id
      WHERE p.status = 'pending' ORDER BY p.created_at LIMIT 200`),
    all(`SELECT c.user_id, c.handle, c.platform, c.payout_email, COALESCE(SUM(k.commission_cent), 0) AS cents, COUNT(*) AS n FROM creator_commissions k JOIN creators c ON c.user_id = k.creator_id
      WHERE k.status = 'ready' GROUP BY c.user_id ORDER BY cents DESC`),
    env.DB.prepare(`SELECT
        (SELECT COALESCE(SUM(commission_cent), 0) FROM creator_commissions WHERE status = 'held') AS held,
        (SELECT COALESCE(SUM(commission_cent), 0) FROM creator_commissions WHERE status = 'ready') AS ready,
        (SELECT COALESCE(SUM(cents), 0) FROM creator_payouts) AS paid,
        (SELECT COALESCE(SUM(amount_cent), 0) FROM creator_commissions WHERE status != 'void') AS brought,
        (SELECT COALESCE(SUM(amount), 0) FROM creator_credits WHERE granted_at >= ?1) AS granted_30d,
        (SELECT COALESCE(SUM(program_credits), 0) FROM users WHERE program_credits > 0) AS outstanding`).bind(iso(nowMs - 30 * DAY_MS)).first<Record<string, number>>(),
  ]);
  const flagged = (r: Record<string, any>) => ({ ...r, flags: r.flags ? String(r.flags).split(" ") : [], plan_active: !!r.plan && r.plan !== "trial" && !!r.plan_until && Date.parse(r.plan_until) > nowMs });
  return {
    month: monthOf(nowMs), judgeDay: JUDGE_DAY, rules: publicRules(),
    counts: { ...counts, applied: applied.length, creators: members.filter((m) => m.level === "creator").length, partners: members.filter((m) => m.level === "partner").length, pros: members.filter((m) => m.level === "pro").length },
    applied: applied.map(flagged), members: members.map(flagged), closed: closed.map(flagged),
    posts: posts.map((p) => ({ ...p, day7: iso(Date.parse(String(p.created_at)) + 7 * DAY_MS), ready: String(p.created_at) <= day7, suggested: null })),
    due,
  };
}

export async function adminCreator(env: StudioEnv, id: string): Promise<Record<string, unknown>> {
  const c = await env.DB.prepare(`SELECT ${ADMIN_LIST_COLS} FROM creators c JOIN users u ON u.id = c.user_id WHERE c.user_id = ?`).bind(id).first<Record<string, any>>();
  if (!c) throw new StudioError("No creator with that account.", 404, "not_found");
  const all = async (sql: string) => (await env.DB.prepare(sql).bind(id).all()).results;
  const [posts, commissions, payouts, lots] = await Promise.all([
    all("SELECT * FROM creator_posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 100"),
    all("SELECT * FROM creator_commissions WHERE creator_id = ? ORDER BY paid_at DESC LIMIT 100"),
    all("SELECT * FROM creator_payouts WHERE creator_id = ? ORDER BY at DESC LIMIT 50"),
    all("SELECT * FROM creator_credits WHERE user_id = ? ORDER BY granted_at DESC LIMIT 100"),
  ]);
  const base = linkBase(env);
  return {
    creator: { ...c, flags: c.flags ? String(c.flags).split(" ") : [], link: c.link_code ? `${base}/r/${c.link_code}` : null },
    figures: await creatorFigures(env, c as unknown as CreatorRow, Date.now()), posts, commissions, payouts, lots, rules: publicRules(),
  };
}

/** A short link for a new creator (attribution.ts short_links): "c-<handle>", made unique. */
async function linkFor(env: StudioEnv, c: CreatorRow, adminId: string): Promise<string> {
  if (c.link_code) return c.link_code;
  const slug = c.handle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 26) || "creator";
  let code = `c-${slug}`;
  for (let i = 2; await env.DB.prepare("SELECT 1 AS one FROM short_links WHERE code = ?").bind(code).first(); i++) code = `c-${slug.slice(0, 24)}-${i}`;
  if (!CODE_RE.test(code)) code = `c-${rid("k", 8).slice(2)}`;
  const channel = c.platform === "youtube" ? "youtube" : c.platform;
  await env.DB.prepare("INSERT OR IGNORE INTO short_links (code, channel, label, target, created_by) VALUES (?, ?, ?, '/', ?)").bind(code, channel, `Creator @${c.handle}`, adminId).run();
  return code;
}

/** A level's credits for this month, granted once (ref = the month): Partner tops up to 50, Pro partner 110 and the plan. */
async function levelMonth(env: StudioEnv, c: CreatorRow, month: string, nowMs: number): Promise<number> {
  if (c.status !== "active") return 0;
  if (c.level === "pro") {
    const until = iso(monthStart(nextMonth(month)) + (JUDGE_DAY - 1) * DAY_MS + 12 * 3600_000);
    await env.DB.prepare("UPDATE creators SET comp_until = ? WHERE user_id = ?").bind(until, c.user_id).run();
    return grantProgram(env, c.user_id, "comp", month, LEVELS.pro.monthly, `Pro partner plan, ${month}`, nowMs);
  }
  if (c.level === "partner") {
    const plan = await paidPlanOf(env, c.user_id);
    if (!plan) return 0;
    return grantProgram(env, c.user_id, "level", month, LEVELS.partner.monthly - plan.credits, `Partner credits, ${month}`, nowMs);
  }
  return 0;
}

export async function adminCreatorAction(env: StudioEnv, adminId: string, id: string, action: string, b: Record<string, unknown>, reason: string, nowMs = Date.now()): Promise<Record<string, unknown>> {
  const c = await creatorOf(env, id);
  if (!c) throw new StudioError("No creator with that account.", 404, "not_found");
  const log = (event: string, detail: Record<string, unknown> = {}) => audit(asEnv(env), id, null, event, { admin: adminId, reason, ...detail });
  const set = (sql: string, ...args: unknown[]) => env.DB.prepare(`UPDATE creators SET ${sql}, updated_at = ${NOW} WHERE user_id = ?`).bind(...args, id).run();

  if (action === "bio") {
    await set(b.on === false ? "bio_seen_at = NULL" : `bio_seen_at = ${NOW}`);
    await log("admin.creator_bio", { on: b.on !== false });
  } else if (action === "approve") {
    if (c.status !== "applied") throw new StudioError("Only a waiting application can be approved.", 400, "creator_state");
    if (!c.bio_seen_at) throw new StudioError("Check the code in the account's bio first.", 400, "creator_bio");
    const level: Level = b.level === "partner" ? "partner" : "creator";
    const code = await linkFor(env, c, adminId);
    await set(`status = 'active', level = ?, link_code = ?, decided_at = ${NOW}, decided_by = ?, approved_at = ${NOW}, level_since = ${NOW}, invited = ?, misses = 0`,
      level, code, adminId, level === "partner" ? 1 : 0);
    await log("admin.creator_approved", { level, link: code });
    await levelMonth(env, (await creatorOf(env, id))!, monthOf(nowMs), nowMs);
  } else if (action === "refuse") {
    if (c.status !== "applied") throw new StudioError("Only a waiting application can be refused.", 400, "creator_state");
    await set(`status = 'refused', decided_at = ${NOW}, decided_by = ?, refuse_reason = ?`, adminId, reason);
    await log("admin.creator_refused");
  } else if (action === "level") {
    if (c.status !== "active" && c.status !== "paused") throw new StudioError("Only a creator in the program has a level.", 400, "creator_state");
    if (!isLevel(b.level)) throw new StudioError("Pick a level.", 400, "creator_level");
    if (b.level === c.level) return adminCreator(env, id);
    await set(`level = ?, level_since = ${NOW}, misses = 0${b.level !== "pro" ? ", comp_until = NULL" : ""}`, b.level);
    await log("admin.creator_level", { from: c.level, to: b.level });
    await levelMonth(env, (await creatorOf(env, id))!, monthOf(nowMs), nowMs);
  } else if (action === "end" || action === "ban") {
    if (!["active", "paused", "applied"].includes(c.status)) throw new StudioError("This creator is already out of the program.", 400, "creator_state");
    await set(`status = ?, ended_at = ${NOW}, end_reason = ?, comp_until = NULL`, action === "ban" ? "banned" : "ended", reason);
    if (action === "ban") {
      // Section 6.3 of the agreement: every program credit left and every unpaid commission go.
      const lots = (await env.DB.prepare("SELECT id FROM creator_credits WHERE user_id = ? AND expired_at IS NULL AND left_amount > 0").bind(id).all<{ id: string }>()).results;
      let taken = 0;
      for (const l of lots) taken += await takeBackLot(env, l.id, "banned");
      await env.DB.prepare(`UPDATE creator_commissions SET status = 'void', reason = 'banned', settled_at = ${NOW} WHERE creator_id = ? AND status IN ('held', 'ready')`).bind(id).run();
      await log("admin.creator_banned", { taken });
    } else await log("admin.creator_ended");
  } else if (action === "reopen") {
    if (!["refused", "ended"].includes(c.status)) throw new StudioError("Only a refused application or an ended place can be opened again.", 400, "creator_state");
    await set(c.status === "refused" ? "status = 'applied', decided_at = NULL, decided_by = NULL, refuse_reason = NULL" : "status = 'active', ended_at = NULL, end_reason = NULL, misses = 0");
    await log("admin.creator_reopened", { was: c.status });
  } else if (action === "note") {
    await set("notes = ?", str(b.note, 1000) || null);
    await log("admin.creator_note");
  } else if (action === "credits") {
    const n = whole(b.credits, 1, 1000);
    if (!n) throw new StudioError("Type between 1 and 1,000 credits.", 400, "creator_credits");
    await grantProgram(env, id, "manual", rid("m", 8), n, `Added by the owner: ${reason}`, nowMs);
    await log("admin.creator_credits", { credits: n });
  } else if (action === "payout") {
    const ready = await env.DB.prepare("SELECT COALESCE(SUM(commission_cent), 0) AS cents, COUNT(*) AS n FROM creator_commissions WHERE creator_id = ? AND status = 'ready'").bind(id).first<{ cents: number; n: number }>();
    if (!ready?.cents) throw new StudioError("Nothing is ready to pay.", 400, "creator_payout_none");
    const method = b.method === "wise" ? "wise" : "paypal";
    const ref = str(b.ref, 120);
    if (ref.length < 3) throw new StudioError("Paste the PayPal or Wise reference of the payment.", 400, "creator_payout_ref");
    const pid = rid("po", 10);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO creator_payouts (id, creator_id, cents, method, ref, by_admin) VALUES (?, ?, ?, ?, ?, ?)").bind(pid, id, ready.cents, method, ref, adminId),
      env.DB.prepare(`UPDATE creator_commissions SET status = 'paid_out', payout_id = ?, settled_at = ${NOW} WHERE creator_id = ? AND status = 'ready'`).bind(pid, id),
    ]);
    await log("admin.creator_payout", { payout: pid, cents: ready.cents, method, ref, payments: ready.n });
  } else {
    throw new StudioError("Not found.", 404, "not_found");
  }
  return adminCreator(env, id);
}

/** A post read at day 7: approved with its views (the bonus follows the table and the monthly cap) or turned down. */
export async function adminPostAction(env: StudioEnv, adminId: string, postId: string, b: Record<string, unknown>, nowMs = Date.now()): Promise<Record<string, unknown>> {
  const p = await env.DB.prepare("SELECT * FROM creator_posts WHERE id = ?").bind(postId).first<{ id: string; user_id: string; month: string; status: string; url: string }>();
  if (!p) throw new StudioError("No such post.", 404, "not_found");
  if (p.status !== "pending") throw new StudioError("This post was already checked.", 400, "creator_post_done");
  const c = await creatorOf(env, p.user_id);
  if (b.action === "reject") {
    const why = str(b.reason, 300);
    if (why.length < 3) throw new StudioError("Say why, in a few words: the creator reads it.", 400, "reason");
    await env.DB.prepare(`UPDATE creator_posts SET status = 'rejected', reason = ?, checked_at = ${NOW}, checked_by = ? WHERE id = ?`).bind(why, adminId, postId).run();
    await audit(asEnv(env), p.user_id, null, "admin.creator_post_rejected", { admin: adminId, post: postId, reason: why });
    return { ok: true, status: "rejected" };
  }
  const views = whole(b.views, 0, 10_000_000_000);
  if (views === null) throw new StudioError("Type the views the post has.", 400, "creator_views");
  const used = (await env.DB.prepare("SELECT COALESCE(SUM(bonus), 0) AS n FROM creator_posts WHERE user_id = ? AND month = ? AND status = 'eligible'").bind(p.user_id, p.month).first<{ n: number }>())?.n ?? 0;
  // Bonuses only while the creator holds a place and a plan (or the Pro partner's plan from the program).
  const paying = !!c && c.status === "active" && (c.level === "pro" || !!(await paidPlanOf(env, p.user_id)));
  const bonus = paying ? Math.max(0, Math.min(bonusFor(views), BONUS_CAP_MONTH - used)) : 0;
  await env.DB.prepare(`UPDATE creator_posts SET status = 'eligible', views = ?, bonus = ?, checked_at = ${NOW}, checked_by = ? WHERE id = ?`).bind(views, bonus, adminId, postId).run();
  if (bonus) await grantProgram(env, p.user_id, "bonus", postId, bonus, `${views.toLocaleString("en-GB")} views at day 7`, nowMs);
  await audit(asEnv(env), p.user_id, null, "admin.creator_post_ok", { admin: adminId, post: postId, views, bonus });
  return { ok: true, status: "eligible", bonus };
}

// ── commissions ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The buyer shares an inbox, the sign-up address, a sign-in place or the payment e-mail with the creator. */
async function sharesWithCreator(env: StudioEnv, buyerId: string, creatorId: string, payEmail: string | null): Promise<boolean> {
  const r = await env.DB.prepare(`SELECT 1 AS one FROM users b JOIN users c ON c.id = ?2 WHERE b.id = ?1 AND (
      (b.email_canon IS NOT NULL AND b.email_canon = c.email_canon) OR (b.ip_hash IS NOT NULL AND b.ip_hash = c.ip_hash)
      OR EXISTS (SELECT 1 FROM studio_ips x JOIN studio_ips y ON y.ip_hash = x.ip_hash WHERE x.user_id = ?1 AND y.user_id = ?2 AND x.ip_hash IS NOT NULL)
      OR (?3 IS NOT NULL AND EXISTS (SELECT 1 FROM payments q WHERE q.user_id = ?2 AND lower(q.email) = lower(?3)))
      OR (?3 IS NOT NULL AND EXISTS (SELECT 1 FROM studio_logins l WHERE l.user_id = ?2 AND lower(l.email) = lower(?3))))`)
    .bind(buyerId, creatorId, payEmail).first().catch(() => null);
  return !!r;
}

export async function syncCommissions(env: StudioEnv, nowMs = Date.now()): Promise<{ made: number; voided: number; ready: number }> {
  const fresh = (await env.DB.prepare(`SELECT p.session_id, p.user_id AS buyer_id, p.amount_cent, p.at, p.email, c.user_id AS creator_id, c.level, c.payout_pref, c.status AS cstatus
      FROM payments p JOIN user_attribution a ON a.user_id = p.user_id JOIN creators c ON c.link_code = a.link_code JOIN users b ON b.id = p.user_id
      WHERE p.status = 'paid' AND p.amount_cent > 0 AND p.currency = 'eur' AND c.approved_at IS NOT NULL AND p.user_id != c.user_id
        AND p.at >= c.approved_at AND b.created_at >= c.approved_at AND julianday(p.at) <= julianday(b.created_at) + ${COMMISSION_MONTHS * 30.5}
        AND NOT EXISTS (SELECT 1 FROM creator_commissions k WHERE k.session_id = p.session_id) ORDER BY p.at LIMIT 100`)
    .all<{ session_id: string; buyer_id: string; amount_cent: number; at: string; email: string | null; creator_id: string; level: Level; payout_pref: string; cstatus: string }>()).results;
  let made = 0, voided = 0, ready = 0;
  for (const p of fresh) {
    const level = isLevel(p.level) ? p.level : "creator";
    const net = netOf(p.amount_cent);
    const cents = Math.round((net * LEVELS[level].rateBp) / 10_000);
    const hold = iso(Date.parse(p.at) + HOLD_DAYS * DAY_MS);
    const shared = await sharesWithCreator(env, p.buyer_id, p.creator_id, p.email);
    const out = p.cstatus === "banned" ? "banned" : shared ? "shared" : null;
    const mode = p.payout_pref === "cash" ? "cash" : "credits";
    const credits = mode === "credits" && !out ? Math.round((cents * CREDIT_MULTIPLIER) / CREDIT_CENT) : 0;
    const status = out ? "void" : mode === "credits" ? "credited" : "held";
    const r = await env.DB.prepare(`INSERT OR IGNORE INTO creator_commissions (session_id, creator_id, buyer_id, paid_at, amount_cent, net_cent, rate_bp, commission_cent, mode, status, hold_until, credits, reason, settled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(p.session_id, p.creator_id, p.buyer_id, p.at, p.amount_cent, net, LEVELS[level].rateBp, cents, mode, status, hold, credits, out, status === "held" ? null : iso(nowMs)).run();
    if (!r.meta?.changes) continue;
    made++;
    if (out) { voided++; await audit(asEnv(env), p.creator_id, null, "creator.commission_void", { session: p.session_id, buyer: p.buyer_id, why: out }); continue; }
    if (credits) await grantProgram(env, p.creator_id, "commission", p.session_id, credits, `Commission on a ${(p.amount_cent / 100).toFixed(2)} EUR payment`, nowMs);
    await audit(asEnv(env), p.creator_id, null, "creator.commission", { session: p.session_id, buyer: p.buyer_id, cents, mode, credits });
  }
  // A refund or a dispute takes back what that payment earned: unpaid cash is cancelled, credits still unspent go.
  const gone = (await env.DB.prepare(`SELECT k.session_id, k.creator_id, k.status, p.status AS pstatus FROM creator_commissions k JOIN payments p ON p.session_id = k.session_id
      WHERE k.status IN ('held', 'ready', 'credited') AND p.status IN ('refunded', 'disputed') LIMIT 100`).all<{ session_id: string; creator_id: string; status: string; pstatus: string }>()).results;
  for (const g of gone) {
    let taken = 0;
    if (g.status === "credited") {
      const lot = await env.DB.prepare("SELECT id FROM creator_credits WHERE user_id = ? AND kind = 'commission' AND ref = ?").bind(g.creator_id, g.session_id).first<{ id: string }>();
      if (lot) taken = await takeBackLot(env, lot.id, g.pstatus);
    }
    await env.DB.prepare(`UPDATE creator_commissions SET status = 'void', reason = ?, settled_at = ? WHERE session_id = ?`).bind(g.pstatus, iso(nowMs), g.session_id).run();
    voided++;
    await audit(asEnv(env), g.creator_id, null, "creator.commission_reversed", { session: g.session_id, why: g.pstatus, taken });
  }
  // Cash held 60 days with the payment still standing is ready for the owner to pay.
  const r = await env.DB.prepare(`UPDATE creator_commissions SET status = 'ready' WHERE status = 'held' AND hold_until <= ?
      AND EXISTS (SELECT 1 FROM payments p WHERE p.session_id = creator_commissions.session_id AND p.status = 'paid')`).bind(iso(nowMs)).run();
  ready = r.meta?.changes ?? 0;
  return { made, voided, ready };
}

// ── the month ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function meta(env: StudioEnv, key: string): Promise<string | null> {
  return (await env.DB.prepare("SELECT value FROM studio_meta WHERE key = ?").bind(key).first<{ value: string }>().catch(() => null))?.value ?? null;
}
async function setMeta(env: StudioEnv, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO studio_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

/** Last month judged: the +50% for enough posts, one level down for a full month without them, out after two. */
export async function judgeMonth(env: StudioEnv, month: string, nowMs = Date.now()): Promise<{ boosted: number; down: number; ended: number }> {
  const start = iso(monthStart(month));
  const rows = (await env.DB.prepare("SELECT * FROM creators WHERE status IN ('active', 'paused') AND approved_at IS NOT NULL AND approved_at < ?").bind(iso(monthStart(nextMonth(month)))).all<CreatorRow>()).results;
  let boosted = 0, down = 0, ended = 0;
  for (const c of rows) {
    const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM creator_posts WHERE user_id = ? AND month = ? AND status IN ('eligible', 'pending')").bind(c.user_id, month).first<{ n: number }>())?.n ?? 0;
    const level = LEVELS[c.level] ?? LEVELS.creator;
    const fullMonth = String(c.approved_at) <= start;
    if (n >= level.posts) {
      if (c.misses) await env.DB.prepare(`UPDATE creators SET misses = 0, updated_at = ${NOW} WHERE user_id = ?`).bind(c.user_id).run();
      if (c.status === "active" && level.boost > 0) {
        const plan = await paidPlanOf(env, c.user_id);
        const base = c.level === "partner" ? LEVELS.partner.monthly : plan?.credits ?? 0;
        if (plan && base > 0 && (await grantProgram(env, c.user_id, "boost", month, Math.ceil(base * level.boost), `+${Math.round(level.boost * 100)}% for ${n} posts in ${month}`, nowMs))) boosted++;
      }
      continue;
    }
    if (!fullMonth) continue;
    const misses = c.misses + 1;
    if (misses >= 2) {
      await env.DB.prepare(`UPDATE creators SET status = 'ended', ended_at = ?, end_reason = 'two months without the posts', comp_until = NULL, misses = ?, updated_at = ${NOW} WHERE user_id = ?`).bind(iso(nowMs), misses, c.user_id).run();
      await audit(asEnv(env), c.user_id, null, "creator.ended_auto", { month, posts: n, needed: level.posts });
      ended++;
      continue;
    }
    const lower: Level = c.level === "pro" ? "partner" : "creator";
    await env.DB.prepare(`UPDATE creators SET misses = ?, level = ?, level_since = CASE WHEN level != ? THEN ? ELSE level_since END, comp_until = NULL, updated_at = ${NOW} WHERE user_id = ?`)
      .bind(misses, lower, lower, iso(nowMs), c.user_id).run();
    await audit(asEnv(env), c.user_id, null, "creator.missed_month", { month, posts: n, needed: level.posts, from: c.level, to: lower });
    down++;
  }
  return { boosted, down, ended };
}

/**
 * The cron's part (src/studio/index.ts scheduled, once an hour): commissions, expiry, pauses, and the month's grants
 * (on the 1st) and judgement (on the 8th), each once, remembered in studio_meta.
 */
export async function creatorsTick(env: StudioEnv, nowMs = Date.now()): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { commissions: await syncCommissions(env, nowMs), expired: await expireProgramCredits(env, nowMs) };
  // No paid plan: the place is paused (no bonuses, no +50%) until one runs again. The Pro partner's plan is the program's.
  const live = (await env.DB.prepare("SELECT * FROM creators WHERE status IN ('active', 'paused') AND level != 'pro'").all<CreatorRow>()).results;
  for (const c of live) {
    const has = !!(await paidPlanOf(env, c.user_id)) || isAdmin(env, c.user_id);
    if (has && c.status === "paused") { await env.DB.prepare(`UPDATE creators SET status = 'active', updated_at = ${NOW} WHERE user_id = ?`).bind(c.user_id).run(); await audit(asEnv(env), c.user_id, null, "creator.resumed", {}); }
    if (!has && c.status === "active") { await env.DB.prepare(`UPDATE creators SET status = 'paused', updated_at = ${NOW} WHERE user_id = ?`).bind(c.user_id).run(); await audit(asEnv(env), c.user_id, null, "creator.paused", { why: "no plan" }); }
  }
  const month = monthOf(nowMs);
  if ((await meta(env, "creators_granted")) !== month) {
    await setMeta(env, "creators_granted", month);
    let n = 0;
    for (const c of (await env.DB.prepare("SELECT * FROM creators WHERE status = 'active' AND level IN ('partner', 'pro')").all<CreatorRow>()).results) if (await levelMonth(env, c, month, nowMs)) n++;
    out.granted = n;
  }
  const last = prevMonth(month);
  if (new Date(nowMs).getUTCDate() >= JUDGE_DAY && (await meta(env, "creators_judged")) !== last) {
    await setMeta(env, "creators_judged", last);
    out.judged = await judgeMonth(env, last, nowMs);
  }
  return out;
}
